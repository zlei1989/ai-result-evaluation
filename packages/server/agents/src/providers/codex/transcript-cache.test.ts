// @vitest-environment node
/**
 * codex 的**转录缓存 + 增量读**（2026-10-06；用户口径：「不要重复读取文件，采用增量方式避免
 * 大文件导致内存溢出」）。
 *
 * 为什么单独开一个文件：判据是「**读盘次数与读的字节数**」，只能靠数 `openSync` / `readSync` 才看得见
 * ——缓存接没接上、增量有没有真的从旧偏移开始，行为层面**逐字相同**（解析结果一模一样），
 * 界面上一个字都看不出来。`transcript.test.ts` 用的是真 fs 且不做整面 mock（那边要跑几十条读盘用例）。
 *
 * 四条判据（各自对应一条会被静默吞掉的缺陷）：
 *   · **D1 同一版本第二次读零 IO**：文件没长就直接交回上一次的解析结果（改回「每次都整份读」⇒ 红）；
 *   · **D2 只读新增那段**：文件长了就从**旧的文件末尾**接着读（改回从 0 读 ⇒ 红）；
 *   · **D3 增量结果 == 整份结果**：逐字段相同（合并规则写漏一档 ⇒ 红）；
 *   · **D4 变短 / 换过 ⇒ 整份重读**：绝不拿错位的偏移去读（少这一支 ⇒ 红）。
 * 另有一条落在 `transcript.test.ts`：**D6 一个读周期里每个线程文件只读一次**（内容面与用量面
 * 共用同一份递归发现）。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCachedTranscriptReader, createCodexTranscriptCache, readTranscript, type CodexTranscript } from './transcript';

/**
 * 只替换 `openSync` / `readSync` / `closeSync`（计数 + 委派给真实现）：其余导出原样透出
 * （`mkdirSync` / `writeFileSync` / `statSync` / `appendFileSync` 等照常是真实现——夹具与被测模块都要用）。
 * 判据写成「**被测模块**有没有读盘」，所以每次读之前 `mockClear()`（见 `beforeEach`）。
 */
const fsSpies = vi.hoisted(() => ({ openSync: vi.fn(), readSync: vi.fn(), closeSync: vi.fn() }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  fsSpies.openSync.mockImplementation(actual.openSync);
  fsSpies.readSync.mockImplementation(actual.readSync);
  fsSpies.closeSync.mockImplementation(actual.closeSync);
  return { ...actual, openSync: fsSpies.openSync, readSync: fsSpies.readSync, closeSync: fsSpies.closeSync };
});

let scratch = '';
beforeEach(() => {
  fsSpies.openSync.mockClear();
  fsSpies.readSync.mockClear();
  fsSpies.closeSync.mockClear();
});
afterEach(() => {
  if (scratch !== '') rmSync(scratch, { recursive: true, force: true });
  scratch = '';
});

/** 一行 `item_completed`（`AgentMessage` ⇒ 进 `completedItems`，也进消息面） */
function itemLine(id: string, text: string, turnId = 't1'): string {
  return JSON.stringify({
    timestamp: '2026-09-30T21:24:41.500Z',
    type: 'event_msg',
    turn_id: turnId,
    payload: {
      type: 'item_completed',
      thread_id: 'main',
      turn_id: turnId,
      item: { type: 'AgentMessage', id, content: [{ type: 'Text', text }] },
      started_at_ms: 1,
      completed_at_ms: 2,
    },
  });
}

/** 一行 `token_count`（用量面的读数来源） */
function tokenLine(input: number, cached: number, output: number, turnId = 't1'): string {
  return JSON.stringify({
    timestamp: '2026-09-30T21:24:44.000Z',
    type: 'event_msg',
    turn_id: turnId,
    payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output } } },
  });
}

/** 一对 `function_call` / `function_call_output`（考「按序配对」在增量之后仍然成立） */
function callLines(callId: string): string[] {
  return [
    JSON.stringify({
      timestamp: '2026-09-30T21:24:45.000Z',
      type: 'response_item',
      turn_id: 't1',
      payload: { type: 'function_call', name: 'exec_command', arguments: '{"cmd":"ls"}', call_id: callId },
    }),
    JSON.stringify({
      timestamp: '2026-09-30T21:24:46.000Z',
      type: 'response_item',
      turn_id: 't1',
      payload: { type: 'function_call_output', call_id: callId, output: `out-${callId}` },
    }),
  ];
}

/** 落一份转录（行之间以换行连接、**以换行收尾**——真机形状） */
function writeRollout(name: string, lines: readonly string[]): string {
  if (scratch === '') scratch = mkdtempSync(join(tmpdir(), 'aieval-codex-cache-'));
  const file = join(scratch, 'sessions', '2026', '09', '30', name);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
  return file;
}

/** 一份转录的**可比较快照**（逐字段；对象身份不算——缓存路径会原地增长同一个对象） */
function snapshot(transcript: CodexTranscript): Record<string, unknown> {
  return {
    sessionMeta: transcript.sessionMeta,
    reasoning: transcript.reasoning,
    messages: transcript.messages,
    functionCalls: transcript.functionCalls,
    functionCallOutputs: transcript.functionCallOutputs,
    completedItems: transcript.completedItems,
    tokenCounters: transcript.tokenCounters,
    turnIds: transcript.turnIds,
    timing: transcript.timing,
    stats: transcript.stats,
  };
}

describe('codex 转录缓存：同一版本零 IO + 只读新增那段（2026-10-06）', () => {
  it('D1 同一版本第二次读：零 IO、且交回同一个转录对象', () => {
    const file = writeRollout('rollout-a-main.jsonl', [itemLine('i-1', '第一条'), tokenLine(10, 0, 1)]);
    const cache = createCodexTranscriptCache();
    const read = createCachedTranscriptReader(cache);

    const first = read(file);
    expect(first?.completedItems).toHaveLength(1);
    // 冷路径要两次 open：内层读者整份解析一次 + `incompleteTail` 扫一次尾巴（判「从哪继续读」）
    const opensAfterColdRead = fsSpies.openSync.mock.calls.length;
    expect(opensAfterColdRead).toBeGreaterThan(0);

    // 同一个版本（size / mtimeMs 都没变）⇒ 直接复用，**一次 IO 都没有**
    const second = read(file);
    expect(second).toBe(first);
    expect(fsSpies.openSync).toHaveBeenCalledTimes(opensAfterColdRead);
  });

  it('D2 文件长了 ⇒ 只从**旧的文件末尾**接着读（不是从 0 重读）', () => {
    const head = [itemLine('i-1', '第一条'), tokenLine(10, 0, 1)];
    const file = writeRollout('rollout-b-main.jsonl', head);
    const cache = createCodexTranscriptCache();
    const read = createCachedTranscriptReader(cache);
    const first = read(file);
    const sizeBefore = Buffer.byteLength(`${head.join('\n')}\n`, 'utf8');

    // 「CLI 又写了两行」
    const added = [itemLine('i-2', '第二条'), tokenLine(30, 4, 2)];
    writeFileSync(file, `${[...head, ...added].join('\n')}\n`, 'utf8');
    fsSpies.openSync.mockClear();
    fsSpies.readSync.mockClear();
    const second = read(file);

    // 内容照旧正确
    expect(second?.completedItems).toHaveLength(2);
    expect(second?.tokenCounters).toHaveLength(2);
    // 判据：第一次 `readSync` 的 **position**（第 5 个参数）就是旧的文件末尾
    const positions = fsSpies.readSync.mock.calls.map((call) => call[4] as number);
    expect(positions[0]).toBe(sizeBefore);
    // 而且只读了一次数据（新增那一段 < 一块）+ 一次 EOF ⇒ 整份重读会是「从 0 起、多块」
    expect(fsSpies.readSync).toHaveBeenCalledTimes(2);
    // 同一个对象被**原地增长**（不是新解析一份）
    expect(second).toBe(first);
  });

  it('D3 增量读的结果与**整份读**逐字段相同（含调用配对 / 轮次 / 坏行计数）', () => {
    const head = [itemLine('i-1', '第一条'), ...callLines('call-1'), tokenLine(10, 0, 1)];
    const file = writeRollout('rollout-c-main.jsonl', head);
    const cache = createCodexTranscriptCache();
    const read = createCachedTranscriptReader(cache);
    read(file);
    // 再长两段（其中一段带一条坏行，坏行计数也要跟着累积）
    const grown = [...head, itemLine('i-2', '第二条', 't2'), '{"type":"assistant"', ...callLines('call-2'), tokenLine(40, 8, 3, 't2')];
    writeFileSync(file, `${grown.join('\n')}\n`, 'utf8');
    const incremental = read(file);

    const full = readTranscript(file);
    expect(incremental).not.toBeNull();
    expect(full).not.toBeNull();
    expect(snapshot(incremental as CodexTranscript)).toEqual(snapshot(full as CodexTranscript));
    // 前提钉：这一份夹具确实压到了那几条分支（否则「逐字段相同」是空转）
    expect(incremental?.stats.badLines).toBe(1);
    expect(incremental?.turnIds).toEqual(['t1', 't2']);
    expect(incremental?.functionCallOutputs.map((output) => output.output)).toEqual(['out-call-1', 'out-call-2']);
  });

  /**
   * **D4**：盘上那份**变短**了（被截断 / 换成了另一份）⇒ 丢掉缓存整份重读，绝不拿错位的偏移去读。
   * 判据用「内容里只剩新写的那一行」——合并进旧解析态时旧的行会留在结果里。
   */
  it('D4 文件变短（或被换过）⇒ 整份重读：旧内容不留痕', () => {
    const file = writeRollout('rollout-d-main.jsonl', [itemLine('old-1', '旧的'), itemLine('old-2', '也是旧的'), tokenLine(10, 0, 1)]);
    const cache = createCodexTranscriptCache();
    const read = createCachedTranscriptReader(cache);
    expect(read(file)?.completedItems).toHaveLength(2);

    // 换成一份更短的（模拟 CLI 换布局 / 文件被截断；真机只追加，这一支是防御）
    writeFileSync(file, `${[itemLine('new-1', '新的')].join('\n')}\n`, 'utf8');
    const after = read(file);

    expect(after?.completedItems).toHaveLength(1);
    expect(after?.completedItems[0]?.itemId).toBe('new-1');
    expect(after?.tokenCounters).toHaveLength(0);
  });

  it('文件不在 ⇒ 交给内层读者（不抛、返回 null 或内层给的合成内容）', () => {
    const cache = createCodexTranscriptCache();
    const inner = vi.fn(() => null);
    const read = createCachedTranscriptReader(cache, inner);
    expect(read(join(tmpdir(), 'aieval-not-exist.jsonl'))).toBeNull();
    expect(inner).toHaveBeenCalledTimes(1);
  });
});
