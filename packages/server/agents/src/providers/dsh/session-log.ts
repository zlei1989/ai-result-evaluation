/**
 * 厂商会话日志的**只读**播种读数：这条会话到目前为止跑过几次模型往返（`step/start` 条数）。
 *
 * 为什么需要它：往返号（`roundTrip`）按**进程内**的会话表发号，而厂商的 `turn` 是**跨段持久**的
 * ——换个进程续接同一条会话时，我们从头开始发号 ⇒ 两段的 `mergeKey` 逐个撞车（消息侧靠行快照里的
 * `segment` 兜住，事件侧时间轴的桶数会多于权威轮次）。按日志条数播种即可让号连续、零交集。
 *
 * 三条实测过的口径（都写在 `docs/protocols/dsh.md` 的边界表里）：
 *   · 路径：`<configHome>/sessions/<projectKey>/<encodeSegment(sessionId)>/session.v4.jsonl.zstd`。
 *     两个路径片段的规则**逐字来自厂商**（`dsh-session-persistence-jsonl` 的 `projectKey()` 与
 *     `encodeSegment()`），不是「折一下分隔符」那种近似——见 `dshProjectKeyOf` 的真机读数；
 *   · 日志是**多帧 zstd**（每批 append 一帧）：`zstdDecompressSync(整份)` 只解第一帧，
 *     故切帧规则与它为什么不能只看魔数见 `decodeFrames`；
 *   · **任何一步失败都返回 `null`**（文件不在 / 解不开 / 没有 step/start）⇒ 调用方按「不播种」处置，
 *     退回「从 1 起」。依赖厂商的日志布局是刻意的取舍，但**不允许**因此引入新的失败面。
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as zlib from 'node:zlib';

/**
 * `zstdDecompressSync` 是 Node 22.15+ 才有的入口，而本仓的类型面没有它 ⇒ 走一次**运行时探测**：
 * 拿不到就返回 `null`（调用方按「不播种」处置）。这条探测同时把「运行时太老」这一档也兜住了——
 * 播种只是让号更准，不值得为它多一个启动期依赖。
 */
const zstdDecompressSync: ((buffer: Buffer) => Buffer) | undefined = (
  zlib as unknown as { zstdDecompressSync?: (buffer: Buffer) => Buffer }
).zstdDecompressSync;

/** zstd 帧魔数（每个 append 批一帧，首尾相接） */
const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd] as const;

/** 厂商会话日志的相对路径（`configHome` 之下） */
export const DSH_SESSION_LOG_RELATIVE_DIR = 'sessions';
/** 会话日志文件名（厂商的当前格式版本） */
export const DSH_SESSION_LOG_FILE = 'session.v4.jsonl.zstd';

/**
 * 会话 cwd → 厂商的 `projectKey`。**逐字照厂商实现**
 * （`dsh-session-persistence-jsonl` 的 `projectKey()`）：
 *   · 分隔符（`/` `\` `:`）**连续的一段折成一个 `-`**（不是每个都折）；
 *   · `[A-Za-z0-9._-]` 之外的一切——含空格、汉字、`~` 自己——走 `~XXXX`（UTF-16 码元四位十六进制大写）；
 *   · 掐掉前导的 `-`，全空回落 `root`；
 *   · 可读部分截到 **251**；
 *   · 外层包 `--…--`。
 *
 * 为什么四条规则一条都不能省：厂商的目录名是**磁盘上的字面量**，少一条就在那类路径上定位失败。
 * 真机读数（cwd 里放 `工作 区 项目`）：
 *   磁盘 `--…-dsh-probe-key-VL0bsB-~5DE5~4F5C~0020~533A~0020~9879~76EE--`
 *   只折分隔符的旧写法 `--…-dsh-probe-key-VL0bsB-工作 区 项目--` ⇒ 不相等；
 * 超长路径（可读部分 > 251）同样只在截断那一档上对得上。
 *
 * ⚠️ **按 UTF-16 码元迭代，不是按码点**：厂商用 `charCodeAt(i)` 逐码元取，而 `for…of` 会把
 * 代理对（emoji 一类）合成一个字符、`charCodeAt(0)` 只拿到高代理 ⇒ 转义值与厂商不同。
 *
 * 失败面：空 cwd 抛错（厂商的 `projectKey('')` 也抛 `cannot encode an empty project path`）；
 * 调用方 `countSessionSteps` 把它与「文件不在」一起归成 `null`（不播种）。
 */
export function dshProjectKeyOf(cwd: string): string {
  if (cwd === '') throw new Error('会话工作目录为空，推不出厂商的 projectKey');
  let readable = '';
  /** 上一个码元是不是分隔符：连续分隔符只折出一个 `-` */
  let separatorRun = false;
  for (let index = 0; index < cwd.length; index += 1) {
    const code = cwd.charCodeAt(index);
    const ch = String.fromCharCode(code);
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-';
      separatorRun = true;
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch;
      separatorRun = false;
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, '0')}`;
      separatorRun = false;
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`;
}

/**
 * 会话 id → 厂商的**目录名片段**（`encodeSegment()`，同一份包的同一处）。
 *
 * 规则：`.` / `..` 两个特例走 `~002E` / `~002E~002E`，其余按码元——`[A-Za-z0-9._-]` 原样、
 * 其它（含 `~`）走 `~XXXX`。真机读数（自定义 id `probe~会话~id`）：磁盘上是
 * `probe~007E~4F1A~8BDD~007Eid`。
 *
 * 今天不可达：适配器铸的 id 与厂商 SDK 铸的都是 `session-<32 位十六进制>`，全在安全集里；
 * 续接传入的 id 也必须是厂商已落盘的那一个（否则 resume 报 `not found`）。
 * 留着它是为了让这一格与厂商的路径规则**同构**——id 形状一旦漂移，这里不再静默定位失败。
 */
export function dshSessionSegmentOf(sessionId: string): string {
  if (sessionId === '') throw new Error('会话 id 为空，推不出厂商的目录名');
  if (sessionId === '.') return '~002E';
  if (sessionId === '..') return '~002E~002E';
  let out = '';
  for (let index = 0; index < sessionId.length; index += 1) {
    const code = sessionId.charCodeAt(index);
    const ch = String.fromCharCode(code);
    // 代理对的两半都不落在安全集里 ⇒ 各自转义（与厂商的逐码元实现同形）
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch;
    else out += `~${code.toString(16).toUpperCase().padStart(4, '0')}`;
  }
  return out;
}

/** 这个偏移是不是一个 zstd 帧的起点（四字节魔数） */
function isFrameStart(buffer: Buffer, at: number): boolean {
  return at + 3 < buffer.length
    && buffer[at] === ZSTD_MAGIC[0] && buffer[at + 1] === ZSTD_MAGIC[1]
    && buffer[at + 2] === ZSTD_MAGIC[2] && buffer[at + 3] === ZSTD_MAGIC[3];
}

/**
 * 多帧 zstd 的**逐帧解码**。
 *
 * 为什么必须自己切帧：日志是「每批 append 一帧、首尾相接」拼起来的，而整份交给
 * `zstdDecompressSync` 只会解**第一帧**（实测：10.8 KB / 6 帧的日志只解出 196 字节的 session
 * header，既不抛错也不提示还有别的帧）。
 *
 * 切帧的判据**不能只看魔数**，也不能靠 `try/catch`：
 *   · 压缩数据内部出现 `28 B5 2F FD` 是可能的（字节巧合，概率随体积线性上升）；
 *   · **`zstdDecompressSync` 对被截断的帧不抛错**——实测切掉一帧最后 5 字节得到 0 字节、
 *     切在第二帧起点之后 10 字节处得到第一帧的完整内容。也就是说「按魔数硬切 + 跳过抛错的」
 *     既不报错、也发现不了丢内容，而丢的可能是带 `step/start` 的那一段（⇒ 播种值偏小）。
 *
 * 所以边界用**内容形态**判定：厂商每批 append 的都是完整的 JSONL 行，故一帧解出来的文本
 * 必然以换行收尾（或本身就是最后一帧、已到文件尾）。依次取「下一个魔数位置」当候选边界，
 * 解出**不以换行收尾**就说明切在了帧内部（那个魔数是伪的），把再下一个候选并进来重解。
 *
 * 残留缺口（如实登记）：伪魔数**恰好落在行边界**上时判据看不出来，那一帧的后半部分会被丢掉。
 * 它比「按魔数硬切」低若干个数量级（既要有字节巧合、又要落在行边界），真机上未观测到；
 * 要彻底关掉它得让 zstd 解码器交出「这一帧消耗了多少输入字节」，而 Node 的同步入口不给。
 */
function decodeFrames(buffer: Buffer): string {
  if (zstdDecompressSync === undefined) return '';
  if (!isFrameStart(buffer, 0)) return '';
  const offsets: number[] = [];
  for (let index = 0; index + 3 < buffer.length; index += 1) {
    if (isFrameStart(buffer, index)) offsets.push(index);
  }
  const tryFrom = (from: number, to: number): string | null => {
    try {
      return zstdDecompressSync(buffer.subarray(from, to)).toString('utf8');
    } catch {
      // 完全不是帧起点（或字节不够）：这一档给 null 让调用方换下一个候选
      return null;
    }
  };
  let text = '';
  let cursor = 0;
  while (cursor < offsets.length) {
    const from = offsets[cursor]!;
    let decoded: string | null = null;
    let next = cursor + 1;
    for (let end = cursor + 1; end <= offsets.length; end += 1) {
      const to = end < offsets.length ? offsets[end]! : buffer.length;
      const attempt = tryFrom(from, to);
      if (attempt === null) continue;
      // 到文件尾那一档无条件采纳：尾帧可能正被厂商写着，半截帧解出空串与「没有这一帧」同效
      if (to === buffer.length || attempt.endsWith('\n')) {
        decoded = attempt;
        next = end;
        break;
      }
    }
    if (decoded === null) break;
    text += decoded;
    cursor = next;
  }
  return text;
}

/**
 * 这条会话跑过几次模型往返（`step/start` 条数）；定位不到 / 读不动 ⇒ `null`。
 *
 * `cwd` 用**本行的**工作目录（追问 / 续接时与建会话那次相同——它是会话属性，厂商也不会改），
 * 但**必须先 `resolve()`**：厂商的落盘路径用的是规范化之后的 cwd——SDK 在构造时
 * `this.cwd = resolve(options.cwd ?? …)`，jsonrpc-server 的 `initialize` 又 `resolve(params.cwd)`
 * 一次。真机读数：把带尾随斜杠的 cwd 交给 harness，`getWorkingDirectory()` 回的是去掉斜杠的那一份，
 * 磁盘目录名也按去掉斜杠的算。少了这一步，只要 cwd 带了尾斜杠 / 未规范化，这里就恒 `null`。
 */
export function countSessionSteps(input: { configHome: string; cwd: string; sessionId: string }): number | null {
  try {
    const file = join(
      input.configHome,
      DSH_SESSION_LOG_RELATIVE_DIR,
      dshProjectKeyOf(resolve(input.cwd)),
      dshSessionSegmentOf(input.sessionId),
      DSH_SESSION_LOG_FILE,
    );
    const text = decodeFrames(readFileSync(file));
    if (text === '') return null;
    let count = 0;
    for (const line of text.split('\n')) {
      if (!line.includes('"step/start"')) continue;
      try {
        if ((JSON.parse(line) as { type?: unknown }).type === 'step/start') count += 1;
      } catch {
        // 坏行跳过
      }
    }
    return count;
  } catch {
    return null;
  }
}
