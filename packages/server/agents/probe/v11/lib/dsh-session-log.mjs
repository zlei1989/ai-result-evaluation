/**
 * 读 dsh 的会话日志（`$DSH_HOME/sessions/**\/session.v4.jsonl.zstd`）。
 *
 * 为什么需要这一支：dsh 的持久物是**拼接的 zstd 帧**——每批 append 一帧，首尾相接。
 * Node 的 `zlib.zstdDecompressSync(buffer)` 只解**第一帧**就返回（不报错、不抛异常），
 * 于是一份真实日志只会解出那条 session header，看起来像"这个会话什么都没记"。
 * 判据：同一份 11 KB 的真实日志，`zstdDecompressSync(整份)` 得 1 行 / 213 字节；
 * 按魔数切帧逐帧解得 19 行 / 32378 字节。**这是本模块存在的唯一理由。**
 *
 * 另一格同样值得知道：路径不是 `<id>.jsonl` 而是**每会话一个目录**
 * `<root>/<projectKey>/<encodeSegment(id)>/session.v4.jsonl.zstd`（外加一个 0 字节的
 * `session.lock` 写者租约）。`projectKey` / `encodeSegment` 的转义规则见
 * `dsh-session-persistence-jsonl/lib/index.js:853`（`encodeSegment`）与 `:875`（`projectKey`）——
 * 分隔符折叠成 `-`、不安全码元走 `~XXXX`、外层包 `--…--`、可读部分截到 251。
 * 本模块按同一规则自己算路径，**只读不算权威**：拿不准时以磁盘上真实存在的目录为准。
 *
 * ⚠️ 只读：本模块不写、不删、不取写者租约。真要"接着跑"，正确入口是
 * `dsh --profile headless --session-id <id>`（见 `docs/faq/deepseek-harness.md`），
 * 不是把这份日志重放成一条新消息。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

/** dsh 当前物理格式版本；文件名里的 `v4` 来自它（`dsh-session` 的 `SESSION_FORMAT_VERSION`）。 */
const SESSION_FORMAT_VERSION = 4;

/** zstd 帧魔数（小端字节序写法，即文件里出现的 `28 b5 2f fd`）。 */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/**
 * 一条路径片段的安全转义：`[A-Za-z0-9._-]` 原样，其余（含 `~`）走 `~XXXX`。
 *
 * @param raw - 要转义的片段，空串会抛（与厂商实现同口径）。
 * @returns 可安全当目录名的片段。
 */
function encodeSegment(raw) {
  if (raw.length === 0) throw new Error('cannot encode an empty path segment');
  if (raw === '.') return '~002E';
  if (raw === '..') return '~002E~002E';
  let out = '';
  for (const ch of raw) {
    out += /^[A-Za-z0-9._-]$/.test(ch) && ch !== '~' ? ch : `~${ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`;
  }
  return out;
}

/**
 * cwd → 项目目录名：分隔符（`/` `\` `:`）折叠成一个 `-`、不安全的码元走 `~XXXX`，
 * 外层包 `--…--`，可读部分截到 251。**有损**（折叠与截断都不可逆），
 * 所以它只用来**猜**路径——真源是磁盘上的目录本身。
 *
 * @param cwd - 会话记录的绝对工作目录。
 * @returns 项目目录名。
 */
function projectKey(cwd) {
  if (cwd.length === 0) throw new Error('cannot encode an empty project path');
  let readable = '';
  let separatorRun = false;
  for (const ch of cwd) {
    const code = ch.charCodeAt(0);
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
 * 算一份会话日志的路径（按厂商的目录/文件命名规则，见文件头）。
 *
 * @param input.home - `DSH_HOME`（持久化根是它下面的 `sessions/`）。
 * @param input.cwd - 会话 header 里记的 cwd；不给就用 `_no-cwd` 那一档。
 * @param input.sessionId - 会话 id（原文，转义在本函数内做）。
 * @returns 日志文件的绝对路径。
 */
export function sessionLogPath({ home, cwd, sessionId }) {
  const project = cwd === undefined ? '_no-cwd' : projectKey(cwd);
  return join(home, 'sessions', project, encodeSegment(sessionId), `session.v${SESSION_FORMAT_VERSION}.jsonl.zstd`);
}

/**
 * 把一份会话日志解出来。
 *
 * @param path - `session.v*.jsonl.zstd` 的路径。
 * @returns `frames`（zstd 帧数）、`bytes`（解压后字节数）、`text`（解压后原文）、
 *   `records`（逐行 JSON 解析结果）。`records[0]` 是 session header（无 `seq`），
 *   其余是事件（`{type, seq, time, data, surfaceOp?}`）。
 */
export function readSessionLog(path) {
  const raw = readFileSync(path);
  const starts = [];
  for (let i = 0; i + ZSTD_MAGIC.length <= raw.length; i += 1) {
    if (raw.compare(ZSTD_MAGIC, 0, ZSTD_MAGIC.length, i, i + ZSTD_MAGIC.length) === 0) starts.push(i);
  }
  if (starts.length === 0) throw new Error(`${path} 里没有 zstd 帧魔数：不是一份 dsh 会话日志`);
  const parts = [];
  for (let k = 0; k < starts.length; k += 1) {
    const end = k + 1 < starts.length ? starts[k + 1] : raw.length;
    parts.push(zstdDecompressSync(raw.subarray(starts[k], end)).toString('utf8'));
  }
  const text = parts.join('');
  const records = text
    .split('\n')
    .filter((one) => one.trim() !== '')
    .map((one) => JSON.parse(one));
  return { frames: starts.length, bytes: text.length, text, records };
}

/** CLI：`node lib/dsh-session-log.mjs <日志路径>` —— 打帧数/字节/行数与事件类型直方图。 */
if (process.argv[1] !== undefined && process.argv[1].endsWith('dsh-session-log.mjs')) {
  const target = process.argv[2];
  if (target === undefined) {
    process.stderr.write('用法：node lib/dsh-session-log.mjs <session.v*.jsonl.zstd>\n');
    process.exitCode = 2;
  } else {
    const { frames, bytes, records } = readSessionLog(target);
    process.stdout.write(`帧数 ${frames}｜解压 ${bytes} 字节｜记录 ${records.length} 条\n`);
    process.stdout.write(`header：${JSON.stringify(records[0])}\n`);
    const histogram = new Map();
    for (const record of records.slice(1)) histogram.set(record.type, (histogram.get(record.type) ?? 0) + 1);
    for (const [type, count] of [...histogram].sort((a, b) => b[1] - a[1])) {
      process.stdout.write(`  ${String(count).padStart(5)}  ${type}\n`);
    }
  }
}
