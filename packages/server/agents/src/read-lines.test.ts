// @vitest-environment node
/**
 * 共用的**同步分块逐行读**（`read-lines.ts`）的守卫。
 *
 * 这一层是共用模块：claude 的子智能体用量与 codex 的转录读盘都用它。三条守卫：
 *   · **跨块的多字节 UTF-8 必须逐字节还原**：块界切在字符中间时，
 *     拿字符串去拼会在当场把那几个字节解成 U+FFFD，而三个 ASCII 字段上**看不出任何异常**
 *     ——那正是注释能长期自欺的原因。切分点只落在**换行字节**（ASCII）上就不会有这个问题；
 *   · **提前收工**（`onLine` 返回 `true`）不再往下读，且 fd 照常关掉；
 *   · **`offset` 续读**（给 codex 的增量读用）：从上次的 `nextOffset` 接着读，
 *     拼接结果与整份读**逐行相同**；`incompleteTail: 'skip'` 时末尾那半截内容**不交**、
 *     且 `nextOffset` 指向它的第一个字节。
 *
 * ⚠️ **判据是「不许整份进内存」**：`readFileSync` 一次都不许调；每次 `readSync` 的长度 ≤ 块长
 * 且小于整份大小。只钉「不调 `readFileSync`」的话，「一块读到底」照样绿。
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readLines } from './read-lines';

/** 只计数这四个（其余导出原样透出，且四个被计数的**委派**给真实现，免得把夹具写入一起打断） */
const fsSpies = vi.hoisted(() => ({
  readFileSync: vi.fn(),
  openSync: vi.fn(),
  readSync: vi.fn(),
  closeSync: vi.fn(),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  fsSpies.readFileSync.mockImplementation(actual.readFileSync);
  fsSpies.openSync.mockImplementation(actual.openSync);
  fsSpies.readSync.mockImplementation(actual.readSync);
  fsSpies.closeSync.mockImplementation(actual.closeSync);
  return {
    ...actual,
    readFileSync: fsSpies.readFileSync,
    openSync: fsSpies.openSync,
    readSync: fsSpies.readSync,
    closeSync: fsSpies.closeSync,
  };
});

beforeEach(() => {
  fsSpies.readFileSync.mockClear();
  fsSpies.openSync.mockClear();
  fsSpies.readSync.mockClear();
  fsSpies.closeSync.mockClear();
});

/** 钩子：`openSync` / `closeSync` 必须**成对**（提前收工那条分支跳出读循环时 fd 还开着，靠 `finally` 关） */
afterEach(() => {
  expect(fsSpies.openSync).toHaveBeenCalledTimes(fsSpies.closeSync.mock.calls.length);
});

/** 一份含中文与 emoji 的转录（**纯文本行**：这一层考的是逐行还原，不是解析规则） */
const LINES = [
  '第一行：中文与 emoji 🌟🎉 混排（这一行足够长，保证块界一定落在某个字符中间）',
  '',
  '{"type":"assistant","message":{"id":"m-1","usage":{"input_tokens":10,"cache_read_input_tokens":0,"output_tokens":1}}}',
  '最后一行也是中文：汉字尾',
];

function writeFixture(name: string, text: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'aieval-read-lines-'));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  writeFileSync(file, text, 'utf8');
  return file;
}

/** 读一份文件、收下每一行（`options` 透传） */
function collectLines(file: string, options: Parameters<typeof readLines>[2] = {}): { lines: string[]; nextOffset: number } {
  const lines: string[] = [];
  const result = readLines(
    file,
    (line) => {
      lines.push(line);
      return false;
    },
    options,
  );
  return { lines, nextOffset: result.nextOffset };
}

describe('readLines：同步分块 + 跨块多字节 + 续读', () => {
  /** 「交出去的行」= 以换行收尾的那些（含中间空行）+ `'deliver'` 模式下末尾那段非空未收尾内容 */
  function expectedLines(text: string): string[] {
    const parts = text.split('\n');
    // 以换行结尾时 `split` 的最后一段是「最后一个换行之后」的位置，不是一行
    if (text.endsWith('\n')) parts.pop();
    return parts;
  }

  it('块长 7（另加 16/17/18/19/20/23/31/64）切中文 + emoji：每一行与原文逐字节相同', () => {
    const cases = [
      { name: 'a.jsonl', text: `${LINES.join('\n')}\n` },
      { name: 'b.jsonl', text: LINES.join('\n') },
    ];
    for (const { name, text } of cases) {
      const file = writeFixture(name, text);
      const expected = expectedLines(text);
      // 期望值先自证含多字节字符：全是 ASCII 时这条守卫考不出任何东西
      expect(expected.join('')).toContain('中文');
      for (const chunkBytes of [7, 16, 17, 18, 19, 20, 23, 31, 64]) {
        expect(collectLines(file, { chunkBytes }).lines, `${name} / chunkBytes=${chunkBytes}`).toEqual(expected);
      }
      // 「逐字节」再正面钉一次：重建结果按同样的行结构拼回去，与盘上那份逐字节相同
      // （块界切坏字符时这里带上 U+FFFD，`.equals` 为 false）
      const rebuilt = collectLines(file, { chunkBytes: 7 }).lines;
      const rebuiltText = rebuilt.join('\n') + (text.endsWith('\n') ? '\n' : '');
      expect(Buffer.from(rebuiltText, 'utf8').equals(readFileSync(file))).toBe(true);
      expect(rebuiltText).not.toContain('\uFFFD');
    }
  });

  it('走的是同步分块：不调用 `readFileSync`、每次只读一块（钉住「不许整份进内存」）', () => {
    const text = Array.from({ length: 900 }, (_unused, index) => `第 ${index} 行：${'x'.repeat(160)}`).join('\n');
    const file = writeFixture('big.jsonl', text);
    const bytes = Buffer.byteLength(text, 'utf8');
    const read = collectLines(file, {});

    expect(read.lines).toHaveLength(900);
    // ①-a 整份读这条腿：改回 `readFileSync` ⇒ 这里红
    expect(fsSpies.readFileSync).not.toHaveBeenCalled();
    expect(fsSpies.openSync).toHaveBeenCalledTimes(1);
    // ①-b 一块读到底这条腿：每次 `readSync` 的**长度参数**都必须 ≤ 64 KB、且小于整份大小
    // （`readSync(fd, buffer, offset, length, position)` 的 length 是第 4 个参数，索引 3）
    const chunks = fsSpies.readSync.mock.calls.map((call) => call[3] as number);
    expect(chunks.length).toBeGreaterThanOrEqual(3); // ≥3 块 + EOF 那一次
    expect(Math.max(...chunks)).toBeLessThanOrEqual(64 * 1024);
    expect(Math.max(...chunks)).toBeLessThan(bytes);
  });

  it('提前收工（`onLine` 返回 `true`）不再往下读、且 fd 照常关掉', () => {
    const file = writeFixture('stop.jsonl', `${LINES.join('\n')}\n`);
    const got: string[] = [];
    readLines(
      file,
      (line) => {
        got.push(line);
        return true;
      },
      { chunkBytes: 7 },
    );
    // 第一行之后立刻收工：不必读到 EOF（那是「整份作废」那条路省 IO 的地方）
    expect(got).toHaveLength(1);
    expect(got[0]).toBe(LINES[0]);
    expect(fsSpies.openSync).toHaveBeenCalledTimes(1);
    expect(fsSpies.closeSync).toHaveBeenCalledTimes(1);
  });

  /**
   * **`offset` 续读**（给 codex 的增量读用）：从上次的 `nextOffset` 接着读，
   * 拼接结果必须与**整份读**逐行相同——这是「不重读、只读新增那段」能成立的前提。
   */
  it('从 `nextOffset` 续读 ⇒ 与整份读逐行相同（增量读的前提）', () => {
    const head = `${LINES.slice(0, 2).join('\n')}\n`;
    const file = writeFixture('grow.jsonl', head);
    const first = collectLines(file, { chunkBytes: 7 });
    // 第一段读完：`nextOffset` 就是文件末尾（结尾带换行）
    expect(first.nextOffset).toBe(Buffer.byteLength(head, 'utf8'));
    expect(first.lines).toEqual(expectedLines(head));

    // 「CLI 又写了后面两行」
    const tail = `${LINES.slice(2).join('\n')}\n`;
    writeFileSync(file, head + tail, 'utf8');
    const second = collectLines(file, { chunkBytes: 7, offset: first.nextOffset });

    // 续读只交出**新增**那两行（不是整份）
    expect(second.lines).toEqual(expectedLines(tail));
    // 两段拼起来与整份读逐行相同
    expect([...first.lines, ...second.lines]).toEqual(collectLines(file, { chunkBytes: 5 }).lines);
  });

  it('incompleteTail 为 skip 时：末尾那半截内容不交，nextOffset 指向它的第一个字节', () => {
    const complete = `${LINES.slice(0, 2).join('\n')}\n`;
    // 未收尾的一行（缺最后两个闭括号）——CLI 写了一半的形态
    const partial = '{"type":"assistant","message":{"id":"m-2"';
    const finished = partial + '}}';
    const file = writeFixture('partial.jsonl', complete + partial);

    const full = collectLines(file, { chunkBytes: 7 });
    // 整份读（默认 `'deliver'`）：半截那行**照交**（调用方自己判 —— claude 的语义就是这样）
    expect(full.lines.at(-1)).toBe(partial);

    const skipped = collectLines(file, { chunkBytes: 7, incompleteTail: 'skip' });
    // 增量读：半截那行不交（它可能是写了一半的行），偏移停在它的第一个字节
    expect(skipped.lines).not.toContain(partial);
    expect(skipped.nextOffset).toBe(Buffer.byteLength(complete, 'utf8'));

    // 「CLI 把那一行写完了」⇒ 从那个偏移续读，补齐后的那一行正常交出
    writeFileSync(file, `${complete}${finished}\n`, 'utf8');
    const resumed = collectLines(file, { chunkBytes: 7, offset: skipped.nextOffset, incompleteTail: 'skip' });
    expect(resumed.lines).toEqual([finished]);
  });
});
