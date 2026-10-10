/**
 * **同步分块逐行读**（今天只有 claude 这一条读盘路径用它：`providers/claude-code/subagent-usage.ts`；
 * codex 自 app-server 改造后只走协议取数，不再读转录文件）。
 *
 * 为什么需要它（用户点名）：会话转录是 CLI **边跑边追加**的，
 * 长运行里可以到几十上百 MB，而 `readFileSync` + `split('\n')` 的峰值是「整份文本 + 行数组」
 * （约 2–3× 文件大小）——那正是「大文件导致内存溢出」那条路。
 *
 * 四条判据：
 *   · **一块一块读**（默认 64 KB）：峰值 = 一块 + 当前行；
 *   · **跨块的多字节字符逐字节还原**：只在**换行字节**（`0x0a`，ASCII，绝不出现在多字节 UTF-8
 *     序列内部）处切分，切出来的每一段都以换行收尾 ⇒ 交给 `toString('utf8')` 的永远是完整字符；
 *     未收尾的那一段以**字节**形式留给下一块（拿字符串去拼会在块界把字符解成 U+FFFD）；
 *   · **同步**：`turn.ts` 的 `project` / `finalize` 都是同步钩子，把异步引进来要改骨架签名、
 *     并波及三家（见 claude 的 `subagent-usage.ts` 文件头）；
 *   · **可续读**（`offset` 进、`nextOffset` 出）：给**增量读**用——从上次停下的位置继续，
 *     只把新增的字节解析一遍（原为 codex 的转录缓存，那一路已随 app-server 改造删除；接口保留给增量读）。
 */
import { closeSync, openSync, readSync } from 'node:fs';

/** 读盘缓冲：**一块 64 KB**（用例传很小的值来把「块界切在字符中间」变成必然） */
export const READ_CHUNK_BYTES = 64 * 1024;

/** 换行字节：切分点只能落在它上面（它绝不出现在多字节 UTF-8 序列内部） */
const NEWLINE = 0x0a;

export interface ReadLinesOptions {
  /** 每块字节数，默认 64 KB */
  chunkBytes?: number;
  /**
   * 从这一字节偏移开始读（默认 0）。⚠️ 必须是**上一行结束之后**的位置
   * （即上一次返回的 `nextOffset`）——落在行中间会让那一行被拦腰截断。
   */
  offset?: number;
  /**
   * 读到 EOF 时，那一段**没有换行符收尾**的内容怎么处理：
   *   · `'deliver'`（默认）：**交出去**——整份读的语义（文件末尾那一行哪怕没有换行也是内容，
   *     真机转录就以换行收尾，这一档是给夹具与「半截行」兜底的）；
   *   · `'skip'`：**不交**——**增量读**的语义：那一段可能是 CLI 写了一半的行，
   *     留给下一次读（`nextOffset` 指向它的第一个字节，下次从头拼）。
   */
  incompleteTail?: 'deliver' | 'skip';
}

export interface ReadLinesResult {
  /**
   * 已经**交出去的行**的字节终点（= 下一次续读的起点）。
   *   · 正常读完（`'deliver'`）⇒ 文件末尾；
   *   · `incompleteTail: 'skip'` 且末尾有半截内容 ⇒ 那半截内容的第一个字节；
   *   · `onLine` 提前返回 `true` ⇒ **这一批的起点**（调用方本来就要作废这一次读数，
   *     不推进偏移是保守的一侧：下次重读这一段）。
   */
  nextOffset: number;
}

/**
 * 把一份文件**逐行**读出来：每读到一条**完整**的行（不含换行符）就交给 `onLine`；
 * `onLine` 返回 `true` = 调用方不需要剩下的内容了（提前收工），本函数随即停止读盘并正常返回。
 * 出错（打不开 / 读不动）**不吞**：原样抛给调用方（由它决定怎么记账）。
 *
 * 「交出去的行」的判据是**以换行收尾**（含中间的空行），外加 `'deliver'` 模式下末尾那段
 * **非空且未收尾**的内容 ⇒ 同一个文件「整份读」与「分段续读拼起来」**逐行相同**。
 */
export function readLines(
  file: string,
  onLine: (line: string) => boolean | void,
  options: ReadLinesOptions = {},
): ReadLinesResult {
  const chunkBytes = options.chunkBytes ?? READ_CHUNK_BYTES;
  const start = options.offset ?? 0;
  const tailMode = options.incompleteTail ?? 'deliver';
  // `openSync` 刻意在 `try` **之外**：它抛的时候还没有 fd 要关（`finally` 里只关真开出来的那个）
  const fd = openSync(file, 'r');
  try {
    const buffer = Buffer.allocUnsafe(chunkBytes);
    /** 上一块末尾那段**没凑成完整行**的字节（不含换行符）——跨块拼行靠它，且它始终是字节不是字符串 */
    let pending: Buffer = Buffer.alloc(0);
    /** 已经交出去的行的字节终点（下一次续读的起点） */
    let consumed = start;
    /** 下一次 `readSync` 的位置：显式给，免得依赖 fd 自身的读写位置（`offset` 那一档要用它） */
    let position = start;
    for (;;) {
      const bytes = readSync(fd, buffer, 0, chunkBytes, position);
      if (bytes === 0) break;
      position += bytes;
      // 用**实际读到的字节数**切：`buffer` 是复用的，下一块会盖掉这一块的尾巴
      const chunk = pending.length === 0 ? buffer.subarray(0, bytes) : Buffer.concat([pending, buffer.subarray(0, bytes)]);
      const lastNewline = chunk.lastIndexOf(NEWLINE);
      if (lastNewline < 0) {
        // 这一块里一条完整的行都没有（超长行 / 块长很小）：整块留给下一轮
        pending = Buffer.from(chunk);
        continue;
      }
      const batchStart = consumed;
      const complete = chunk.subarray(0, lastNewline + 1);
      pending = Buffer.from(chunk.subarray(lastNewline + 1));
      consumed = batchStart + complete.length;
      // `complete` 以换行收尾 ⇒ 它解码后 split 出来的**最后一段**必然是空串（那是「最后一个换行之后」
      // 的位置，不是一行内容）；其余各段（含中间的空行）**照原样交出去**——调用方自己判空行
      const lines = complete.toString('utf8').split('\n');
      lines.pop();
      for (const line of lines) {
        if (onLine(line) === true) return { nextOffset: batchStart };
      }
    }
    if (tailMode === 'deliver' && pending.length > 0) {
      // 末尾那段**没有换行收尾**的内容：`'deliver'` 交出去（整份读的语义）。
      // ⚠️ 为空时**不交**：文件以换行结尾时并没有「最后一行」可言——多交一个空串会让
      // 「分段续读拼起来」比「整份读」多出空行（段边界各多一个），而两者本该逐行相同。
      onLine(pending.toString('utf8'));
      consumed += pending.length;
    }
    return { nextOffset: consumed };
  } finally {
    // 提前收工（作废）与抛错时 fd 都还开着：显式关掉，别让它挂到 GC 才放
    closeSync(fd);
  }
}

/**
 * 末尾那段**没有换行收尾**的内容（起点 + 文本）；没有这样一段时 `{ start: size, text: '' }`。
 *
 * 用途（**接口保留、当前无调用方**——原用途是 codex 的转录缓存，那一路已随 app-server 改造删除）：
 * 内层读者刚把**整份**文件解析完，要记下「从哪继续读」。
 * 越过一段没写完的行，那一行写完后**永远不会再被解析**（静默丢一条记录）⇒ 这个起点必须精确。
 *
 * 实现：从末尾按块往前找最后一个换行字节——`0x0a` 是 ASCII，**绝不出现在多字节 UTF-8 序列内部**
 * ⇒ 它一定是行边界。真机转录以换行收尾 ⇒ 通常第一块（≤ 64 KB）就命中。
 */
export function incompleteTail(file: string, size: number, chunkBytes: number = READ_CHUNK_BYTES): { start: number; text: string } {
  if (size <= 0) return { start: 0, text: '' };
  const fd = openSync(file, 'r');
  try {
    const length = Math.min(chunkBytes, size);
    const buffer = Buffer.allocUnsafe(length);
    let end = size;
    /** 已经扫过（但没找到换行）的字节区间 `[end, size)` —— 找到换行后要连它一起交出去 */
    while (end > 0) {
      const span = Math.min(length, end);
      const start = end - span;
      const bytes = readSync(fd, buffer, 0, span, start);
      const index = buffer.subarray(0, bytes).lastIndexOf(NEWLINE);
      if (index >= 0) {
        const tailStart = start + index + 1;
        return { start: tailStart, text: readRangeSync(fd, tailStart, size) };
      }
      end = start;
    }
    // 整份文件里一个换行都没有 ⇒ 全部都是「未收尾的那一段」
    return { start: 0, text: readRangeSync(fd, 0, size) };
  } finally {
    closeSync(fd);
  }
}

/** 读 `[start, end)` 这一段（调用方保证范围小：只用来判「末尾那一段是不是一条完整记录」） */
function readRangeSync(fd: number, start: number, end: number): string {
  if (end <= start) return '';
  const buffer = Buffer.allocUnsafe(end - start);
  const bytes = readSync(fd, buffer, 0, buffer.length, start);
  return buffer.subarray(0, bytes).toString('utf8');
}
