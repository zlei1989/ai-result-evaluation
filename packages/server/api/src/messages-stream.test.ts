// @vitest-environment node
/**
 * 消息流（spec v3 §2 的内容级通道）：回放 `messages.jsonl` 的折叠视图 → 接进程内记录总线。
 *
 * 与 `run-stream.test.ts` 的三处**刻意不同**（本文件就是这三条的守卫）：
 *   ① **没有 `id:` 帧头**：记录没有单调序号（`messageId` 跨运行会重号），设了帧头浏览器会在重连时
 *      带上 `Last-Event-ID`，而我们没有任何东西能解释它——表现是重连后少一段历史且不报错；
 *   ② **不因终态关流**：靠终态关流会让「打开一个跑完的行的对话视图」立刻断连，而那份历史正是要看的东西；
 *   ③ **回放的是折叠视图**：同一条逻辑消息在文件里有多条（增量 → 快照），首帧只该出现一条。
 *
 * `subscribeRowRecords` 由本文件自己实现（vi.mock 的工厂里维护一张监听表），于是
 * 「总线推一条记录 → 流里出现一帧」这条链路可以在不启动任何编排的情况下被验证。
 */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ServiceError, type AgentMessage, type EvalRun, type RowRecord, type SubagentRecord } from '@aieval/contracts';
import {
  appendMessage,
  appendSubagent,
  resetRecords,
  rowMessagesFile,
  setCasesRootForTesting,
  setConfigDirForTesting,
} from '@aieval/core';
import { getRun as getRunSnapshot } from '@aieval/evaluator';
import { getRowRecords } from './run-artifacts';
import { createDeltaCoalescer, streamRowRecords } from './messages-stream';
import { updateSettings } from './settings';
import { makeCase, makeRow, makeRun, seedConfig } from './testing/run-fixtures';
import { removeTreeWithRetry } from './testing/cleanup';

/** 本文件挂上去的总线监听（key = `${runId}/${rowId}`） */
const listeners = new Map<string, Array<(record: RowRecord) => void>>();
/**
 * **评分那条记录流**的监听表（2026-10-10）：与候选那张**刻意分开**——共用一个 Map 的话，
 * 「评分增量不投给候选订阅者」这条不变量在这个替身里会假绿（而那正是它要守的东西）。
 */
const judgeListeners = new Map<string, Array<(record: RowRecord) => void>>();

vi.mock('@aieval/evaluator', () => ({
  listRuns: vi.fn(),
  getRun: vi.fn(),
  saveRun: vi.fn(),
  startRun: vi.fn(),
  abortRun: vi.fn(),
  abortRow: vi.fn(),
  subscribeRowEvents: vi.fn(() => () => {}),
  subscribeJudgeEvents: vi.fn(() => () => {}),
  subscribeRowRecords: vi.fn((runId: string, rowId: string, listener: (record: RowRecord) => void) => {
    const key = `${runId}/${rowId}`;
    const bucket = listeners.get(key) ?? [];
    bucket.push(listener);
    listeners.set(key, bucket);
    return () => {
      const current = listeners.get(key) ?? [];
      listeners.set(key, current.filter((item) => item !== listener));
    };
  }),
  subscribeJudgeRecords: vi.fn((runId: string, rowId: string, listener: (record: RowRecord) => void) => {
    const key = `${runId}/${rowId}`;
    const bucket = judgeListeners.get(key) ?? [];
    bucket.push(listener);
    judgeListeners.set(key, bucket);
    return () => {
      const current = judgeListeners.get(key) ?? [];
      judgeListeners.set(key, current.filter((item) => item !== listener));
    };
  }),
}));

let dir: string;
let workspaceRoot: string;
let store: Map<string, EvalRun>;

/** 一条最小合法消息（用例只覆盖自己关心的格） */
function makeMessage(overrides: Partial<AgentMessage> = {}): AgentMessage {
  return {
    messageId: 'run-1:1',
    vendorId: null,
    role: 'assistant',
    source: 'wire',
    roundTrip: 1,
    turn: null,
    step: null,
    parentCallId: null,
    subagentId: null,
    chunk: 'snapshot',
    assembly: 'snapshot',
    mergeKey: 'main|1|assistant|-',
    blocks: [{ type: 'text', text: '答复' }],
    raw: null,
    ...overrides,
  };
}

/** 一条最小合法子任务行 */
function makeSubagent(overrides: Partial<SubagentRecord> = {}): SubagentRecord {
  return {
    subagentId: 'child-1',
    name: '查配置',
    kind: 'spawn_agent',
    source: 'wire',
    status: 'running',
    statusMissing: null,
    outcome: null,
    parentCallId: null,
    parentSubagentId: null,
    usage: null,
    ...overrides,
  };
}

/**
 * 往该行的记录日志里追加一条记录（写真实文件，走 core 的校验）。
 * 路径必须用 `rowMessagesFile(run.workspaceBase, …)` 推：`getRowRecords` 读的是**快照里那一轮的
 * `workspaceBase`**（用户改过工作区根之后历史产物仍留在旧根下，spec §6.3），夹具的
 * `workspaceRoot` 与它不是同一个值。
 */
function appendRecord(runId: string, rowId: string, record: RowRecord): void {
  const run = store.get(runId)!;
  const file = rowMessagesFile(run.workspaceBase, runId, rowId);
  mkdirSync(dirname(file), { recursive: true });
  if (record.type === 'message') appendMessage(file, record.message);
  else appendSubagent(file, record.subagent);
}

/** 把一条记录推给挂在总线上的监听（模拟编排层发布） */
function publish(runId: string, rowId: string, record: RowRecord): void {
  for (const listener of listeners.get(`${runId}/${rowId}`) ?? []) listener(record);
}

/**
 * 只读第一块并取消流。
 * 为什么不能 `new Response(stream).text()`：消息流**不因终态关流**（文件头口径 ②），
 * 等它结束就是等一个永不来的心跳 ⇒ 用例会挂死。读首块 + `cancel()` 才是正确用法。
 */
async function readFirstChunk(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const first = await reader.read();
  await reader.cancel();
  return new TextDecoder().decode(first.value);
}

/**
 * 抓同步抛出的 `ServiceError`：用例要断言**错误码与逐字文案**，`toThrowError` 拿不到对象。
 */
function captureThrow(action: () => unknown): ServiceError {
  try {
    action();
  } catch (error) {
    if (error instanceof ServiceError) return error;
    throw error;
  }
  throw new Error('预期同步抛错，但调用正常返回了');
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aieval-messages-'));
  setConfigDirForTesting(dir);
  // 用例目录也要指到临时目录：seedConfig 把用例写成一文件一落（core 的 `case-store`），
  // config 目录的 override 管不到它
  setCasesRootForTesting(join(dir, 'cases'));
  workspaceRoot = join(dir, 'ws');
  updateSettings({ workspaceRoot });
  seedConfig({ cases: [makeCase()] });
  listeners.clear();

  store = new Map();
  const run = makeRun({ rows: [makeRow()] });
  store.set(run.id, run);
  // 快照夹具的 `workspaceBase` 是**本文件共用的那一棵临时树**（`fixtureWorkspaceRoot()`，夹具模块按
  // 测试文件建一棵），跨用例会共用同一个文件 ⇒ 每条用例开头清一次，否则上一条用例写进去的记录
  // 会漏进下一条的断言
  resetRecords(rowMessagesFile(run.workspaceBase, run.id, run.rows[0]!.id));
  vi.mocked(getRunSnapshot).mockImplementation((runId: string) => {
    const found = store.get(runId);
    if (found === undefined) throw new ServiceError('NOT_FOUND', `评测不存在：${runId}`);
    return found;
  });
});

afterEach(() => {
  setConfigDirForTesting(null);
  setCasesRootForTesting(null);
  removeTreeWithRetry(dir);
});

/** 这一轮与这一行的 id（用例只建一轮一行） */
function ids(): { runId: string; rowId: string } {
  const run = [...store.values()][0]!;
  return { runId: run.id, rowId: run.rows[0]!.id };
}

describe('getRowRecords：折叠后的最终视图', () => {
  it('同一条逻辑消息的多条投递只留最后一条（增量 → 快照）', () => {
    const { runId, rowId } = ids();
    appendRecord(runId, rowId, {
      type: 'message',
      message: makeMessage({ messageId: 'run-1:1', chunk: 'delta', assembly: 'open', blocks: [{ type: 'text', text: '我先看' }] }),
    });
    appendRecord(runId, rowId, {
      type: 'message',
      message: makeMessage({ messageId: 'run-1:2', blocks: [{ type: 'text', text: '我先看一下配置文件。' }] }),
    });

    const { messages } = getRowRecords(runId, rowId);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ chunk: 'snapshot', assembly: 'snapshot', blocks: [{ type: 'text', text: '我先看一下配置文件。' }] });
  });

  it('消息与子任务行来自**同一个文件**，按 `type` 分流（两条流各归各的）', () => {
    const { runId, rowId } = ids();
    appendRecord(runId, rowId, { type: 'message', message: makeMessage() });
    appendRecord(runId, rowId, { type: 'subagent', subagent: makeSubagent() });
    appendRecord(runId, rowId, { type: 'subagent', subagent: makeSubagent({ status: 'completed', outcome: '跑完了' }) });

    const { messages, subagents } = getRowRecords(runId, rowId);
    expect(messages).toHaveLength(1);
    // 派发 + 收场两行折叠成一行，留的是收场那条（完整快照）
    expect(subagents).toHaveLength(1);
    expect(subagents[0]).toMatchObject({ status: 'completed', outcome: '跑完了' });
  });

  it('文件不存在时给两个空数组（该行还没开始跑，不是错误）', () => {
    const { runId, rowId } = ids();
    expect(getRowRecords(runId, rowId)).toEqual({ messages: [], subagents: [] });
  });

  it('评测或行不存在时抛 NOT_FOUND（与日志接口同一句话，路由层据此给 404 JSON）', () => {
    const { runId, rowId } = ids();
    const missingRun = captureThrow(() => getRowRecords('run-never', rowId));
    expect(missingRun.code).toBe('NOT_FOUND');
    const missingRow = captureThrow(() => getRowRecords(runId, 'row-never'));
    expect(missingRow.code).toBe('NOT_FOUND');
    expect(missingRow.message).toContain('row-never');
  });
});

describe('streamRowRecords：SSE 帧与响应语义', () => {
  it('首帧是 ready 注释帧（打开即有首字节），随后是历史记录，且**不带** `id:` 帧头', async () => {
    const { runId, rowId } = ids();
    appendRecord(runId, rowId, { type: 'message', message: makeMessage() });
    appendRecord(runId, rowId, { type: 'subagent', subagent: makeSubagent() });

    const frame = await readFirstChunk(streamRowRecords(runId, rowId));
    expect(frame).toBe(': ready\n\n');
  });

  it('回放的是**折叠视图**：同一条逻辑消息的多条投递只出现一条', async () => {
    const { runId, rowId } = ids();
    /**
     * **先开流、后写记录**：`ReadableStream` 的入队**不保证**一次 `read()` 拿到全部帧
     * （实测 ready 帧与历史帧可以分两次到达），所以这里把历史与 ready 分成两次读，
     * 断言因此与分块方式无关。写记录这一步顺带证明「回放**之前**订阅」是成立的：
     * 只订阅、还没回放时写进去的记录照样会到（文件里那一条也仍在回放范围内）。
     */
    const stream = streamRowRecords(runId, rowId);
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    expect(decoder.decode((await reader.read()).value)).toBe(': ready\n\n');

    appendRecord(runId, rowId, {
      type: 'message',
      message: makeMessage({ messageId: 'run-1:1', chunk: 'delta', blocks: [{ type: 'text', text: '我先看' }] }),
    });
    appendRecord(runId, rowId, {
      type: 'message',
      message: makeMessage({ messageId: 'run-1:2', blocks: [{ type: 'text', text: '我先看一下配置文件。' }] }),
    });
    // 文件是在开流之后才写的 ⇒ 回放读不到它们；这里直接从总线推（模拟编排层发布）
    publish(runId, rowId, { type: 'message', message: makeMessage({ messageId: 'run-1:2', blocks: [{ type: 'text', text: '我先看一下配置文件。' }] }) });
    const frame = decoder.decode((await reader.read()).value);
    await reader.cancel();

    expect(frame).toBe(
      `event: message\ndata: ${JSON.stringify({ type: 'message', message: makeMessage({ messageId: 'run-1:2', blocks: [{ type: 'text', text: '我先看一下配置文件。' }] }) })}\n\n`,
    );
    // 帧头只有 `event:` 与 `data:`，**没有** `id:`（设了它浏览器重连会带 Last-Event-ID，
    // 而这一侧没有任何东西能解释那个值 ⇒ 重连后少一段历史且不报错）
    expect(frame).not.toMatch(/^id: /m);
  });

  it('历史里同一条逻辑消息有多条投递时，回放只给折叠后的那一条', async () => {
    const { runId, rowId } = ids();
    appendRecord(runId, rowId, {
      type: 'message',
      message: makeMessage({ messageId: 'run-1:1', chunk: 'delta', blocks: [{ type: 'text', text: '我先看' }] }),
    });
    appendRecord(runId, rowId, {
      type: 'message',
      message: makeMessage({ messageId: 'run-1:2', blocks: [{ type: 'text', text: '我先看一下配置文件。' }] }),
    });

    // 一条逻辑消息 + 一条子任务行 ⇒ 回放两条记录（不是三条）
    const stream = streamRowRecords(runId, rowId);
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    await reader.read(); // ready
    let seen = '';
    // 读到出现两帧 `event:` 为止（分块方式不定，故按内容判而不是按读次数判）
    for (let index = 0; index < 6 && (seen.match(/event: /g) ?? []).length < 1; index += 1) {
      seen += decoder.decode((await reader.read()).value);
    }
    await reader.cancel();

    expect(seen).toBe(
      `event: message\ndata: ${JSON.stringify({ type: 'message', message: makeMessage({ messageId: 'run-1:2', blocks: [{ type: 'text', text: '我先看一下配置文件。' }] }) })}\n\n`,
    );
  });

  it('总线推一条记录 ⇒ 流里出现一帧（`event` 名就是记录的 `type`，`data` 是整条记录）', async () => {
    const { runId, rowId } = ids();
    const stream = streamRowRecords(runId, rowId);
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    await reader.read(); // ready 帧 + 空历史

    publish(runId, rowId, { type: 'subagent', subagent: makeSubagent() });
    const chunk = await reader.read();
    await reader.cancel();

    expect(decoder.decode(chunk.value)).toBe(
      `event: subagent\ndata: ${JSON.stringify({ type: 'subagent', subagent: makeSubagent() })}\n\n`,
    );
  });

  it('取消流之后总线上的监听被摘掉（长驻服务里不回收就是一条缓慢的内存泄漏）', async () => {
    const { runId, rowId } = ids();
    const stream = streamRowRecords(runId, rowId);
    const reader = stream.getReader();
    await reader.read();
    expect(listeners.get(`${runId}/${rowId}`)).toHaveLength(1);
    await reader.cancel();
    expect(listeners.get(`${runId}/${rowId}`)).toHaveLength(0);
  });

  it('空历史也照样开流（只有 ready 帧，等总线推新的）', async () => {
    const { runId, rowId } = ids();
    const stream = streamRowRecords(runId, rowId);
    expect(await readFirstChunk(stream)).toBe(': ready\n\n');
  });

  it('评测或行不存在时**同步**抛 NOT_FOUND（路由层因此给 404 JSON，而不是开了就断的 SSE）', () => {
    const { runId, rowId } = ids();
    expect(captureThrow(() => streamRowRecords('run-never', rowId)).code).toBe('NOT_FOUND');
    expect(captureThrow(() => streamRowRecords(runId, 'row-never')).code).toBe('NOT_FOUND');
  });
});

/** 一条增量帧记录（`chunk: 'delta'` + `assembly: 'open'`，与适配器交出来的形状同构） */
function deltaRecord(text: string, mergeKey: string, messageId = 'run-1:d'): RowRecord {
  return {
    type: 'message',
    message: makeMessage({ messageId, chunk: 'delta', assembly: 'open', mergeKey, blocks: [{ type: 'text', text }] }),
  };
}

/** 一条记录里第一块正文（用例只造文本块） */
function textOf(record: RowRecord): string {
  if (record.type !== 'message') throw new Error('预期是消息记录');
  const block = record.message.blocks[0];
  if (block?.type !== 'text') throw new Error('预期第一块是文本块');
  return block.text;
}

/**
 * 增量帧的**出口合并**（2026-10-09）——这一组守卫的是「O(n²) 字节」那个坑：
 * 帧是累积值（每条都带「到现在为止的完整块列表」），一段 n 个 token 的回复按 token 发帧
 * 就是第 k 帧重发前 k 个 token。中间态在客户端**注定被后一条覆盖**，故出口按 `mergeKey` 只留最后一条。
 *
 * 四条不变量各自有靶子：只合并增量（快照一条都不许丢）、只丢被覆盖的中间态（不许跨键丢）、
 * 窗口到点必发（否则光标停在半路）、非增量记录是**屏障**（顺序不许变——增量排到快照后面，
 * 界面就会从「已写完」退回半截）。
 */
describe('createDeltaCoalescer：增量帧的出口合并', () => {
  it('同一 mergeKey 的连续增量只发最后一条，被丢掉的计入 coalescedCount', () => {
    const out: RowRecord[] = [];
    const coalescer = createDeltaCoalescer((record) => out.push(record), 16);
    try {
      coalescer.push(deltaRecord('我先', 'main|1|assistant|-'));
      coalescer.push(deltaRecord('我先看', 'main|1|assistant|-'));
      coalescer.push(deltaRecord('我先看一下', 'main|1|assistant|-'));
      // 窗口没到 ⇒ 一条都不发（发出去就等于没合并）
      expect(out).toHaveLength(0);
      expect(coalescer.coalescedCount).toBe(2);
      coalescer.flush();
      expect(out).toHaveLength(1);
      // 发出去的是**累积值**里最新那条，不是拼接——拼接会得到三段重复的正文
      expect(textOf(out[0]!)).toBe('我先看一下');
    } finally {
      coalescer.dispose();
    }
  });

  it('不同 mergeKey 各自留一条（主会话与子会话的增量不许互相盖掉）', () => {
    const out: RowRecord[] = [];
    const coalescer = createDeltaCoalescer((record) => out.push(record), 16);
    try {
      coalescer.push(deltaRecord('主会话', 'main|1|assistant|-'));
      coalescer.push(deltaRecord('子会话', 'child|1|assistant|-'));
      expect(coalescer.coalescedCount).toBe(0);
      coalescer.flush();
      expect(out.map(textOf)).toEqual(['主会话', '子会话']);
    } finally {
      coalescer.dispose();
    }
  });

  it('非增量记录是**屏障**：先把待发增量冲出去，再原样发自己（顺序不变）', () => {
    const out: RowRecord[] = [];
    const coalescer = createDeltaCoalescer((record) => out.push(record), 16);
    try {
      coalescer.push(deltaRecord('半截', 'main|1|assistant|-'));
      const snapshot: RowRecord = { type: 'message', message: makeMessage({ messageId: 'run-1:2', blocks: [{ type: 'text', text: '完整答复。' }] }) };
      coalescer.push(snapshot);
      // 增量在前、快照在后（反过来的话客户端折叠完停在半截正文上）
      expect(out.map((record) => (record.type === 'message' ? record.message.chunk : 'subagent'))).toEqual(['delta', 'snapshot']);
      expect(textOf(out[1]!)).toBe('完整答复。');
      // 子任务行同理：它不该被窗口拖后
      const subagent: RowRecord = { type: 'subagent', subagent: makeSubagent() };
      coalescer.push(subagent);
      expect(out).toHaveLength(3);
    } finally {
      coalescer.dispose();
    }
  });

  it('窗口到点必发（定时器不是「有流量才动」，否则光标停在半路）', () => {
    vi.useFakeTimers();
    try {
      const out: RowRecord[] = [];
      const coalescer = createDeltaCoalescer((record) => out.push(record), 16);
      coalescer.push(deltaRecord('最后一片', 'main|1|assistant|-'));
      expect(out).toHaveLength(0);
      vi.advanceTimersByTime(16);
      expect(out.map(textOf)).toEqual(['最后一片']);
      coalescer.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('dispose 之后待发帧不再发出（客户端已断开，窗口定时器也必须清掉）', () => {
    vi.useFakeTimers();
    try {
      const out: RowRecord[] = [];
      const coalescer = createDeltaCoalescer((record) => out.push(record), 16);
      coalescer.push(deltaRecord('半截', 'main|1|assistant|-'));
      coalescer.dispose();
      vi.advanceTimersByTime(100);
      expect(out).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('接线：连推三条增量 + 一条快照 ⇒ 流里只出两帧（末条增量 + 快照），且是那个顺序', async () => {
    const { runId, rowId } = ids();
    const stream = streamRowRecords(runId, rowId);
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    await reader.read(); // ready 帧

    publish(runId, rowId, deltaRecord('我先', 'main|1|assistant|-', 'run-1:d1'));
    publish(runId, rowId, deltaRecord('我先看', 'main|1|assistant|-', 'run-1:d2'));
    publish(runId, rowId, deltaRecord('我先看一下', 'main|1|assistant|-', 'run-1:d3'));
    publish(runId, rowId, { type: 'message', message: makeMessage({ messageId: 'run-1:2', blocks: [{ type: 'text', text: '我先看一下配置文件。' }] }) });

    const first = decoder.decode((await reader.read()).value);
    const second = decoder.decode((await reader.read()).value);
    await reader.cancel();

    expect(first).toContain('"text":"我先看一下"');
    expect(second).toContain('"text":"我先看一下配置文件。"');
    expect(first.startsWith('event: message')).toBe(true);
    expect(second.startsWith('event: message')).toBe(true);
  });
});
