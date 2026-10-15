// @vitest-environment node
/**
 * 聚合流的帧产出：**逐行游标**回放 → 接 run 级总线 → 两 rowChannel 的消息实时扇出。
 *
 * 与行级流（`run-stream.test.ts`）的三处刻意不同，也是本文件的靶子：
 *   1. **游标是一张表**（`rowId → seq`），不是单一 seq：表里有的行从各自 seq 之后回放，
 *      **跨行不做全局排序**（每行的折叠各算各的）；不在表里的行不回放历史、只推实时帧；
 *   2. **事件帧带 `id:`、消息帧不带**：`id` 是浏览器 `Last-Event-ID` 的唯一来源，
 *      而消息的 `messageId` 跨运行重号、`delta` 覆盖使历史可变 ⇒ 按 seq 续订对可变历史没有意义；
 *   3. **不因终态关流**：一条连接承载一轮下所有行，某一行跑完不能把别行的实时通道一起关掉。
 *
 * run 级总线由本文件自己实现（`vi.mock` 的工厂里维护两张监听表，候选与评分分开），
 * 于是「总线推一条 → 流里出现一帧」这条链路可以在不启动编排的情况下被验证。
 */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ServiceError, type AgentEvent, type AgentMessage, type EvalRun, type RowRecord } from '@aieval/contracts';
import { appendEvent, resetEvents, setCasesRootForTesting, setConfigDirForTesting } from '@aieval/core';
import { getRun as getRunSnapshot } from '@aieval/evaluator';
import { streamRunAggregate } from './run-aggregate-stream';
import { updateSettings } from './settings';
import { makeCase, makeRow, makeRun, seedConfig } from './testing/run-fixtures';
import { removeTreeWithRetry } from './testing/cleanup';

/** run 级事件订阅者（键 = `runId` 候选 / `runId:judge` 评分） */
type RunEventListener = (rowId: string, event: AgentEvent) => void;
/** run 级记录订阅者（同样的两把键） */
type RunRecordListener = (rowId: string, record: RowRecord) => void;

const bus = vi.hoisted(() => {
  /** 两张表**刻意分开**：共用一个 Map 时「评分事件不进聚合流」这条不变量会假绿 */
  const events = new Map<string, Array<(rowId: string, event: unknown) => void>>();
  const records = new Map<string, Array<(rowId: string, record: unknown) => void>>();
  const subscribe = <L>(table: Map<string, L[]>, key: string, listener: L): (() => void) => {
    const bucket = table.get(key) ?? [];
    bucket.push(listener);
    table.set(key, bucket);
    return () => {
      table.set(
        key,
        (table.get(key) ?? []).filter((item) => item !== listener),
      );
    };
  };
  return { events, records, subscribe };
});

vi.mock('@aieval/evaluator', () => ({
  listRuns: vi.fn(),
  getRun: vi.fn(),
  saveRun: vi.fn(),
  startRun: vi.fn(),
  abortRun: vi.fn(),
  abortRow: vi.fn(),
  subscribeRunEvents: vi.fn((runId: string, listener: RunEventListener) => bus.subscribe(bus.events, runId, listener)),
  subscribeRunJudgeEvents: vi.fn((runId: string, listener: RunEventListener) =>
    bus.subscribe(bus.events, `${runId}:judge`, listener),
  ),
  subscribeRunRecords: vi.fn((runId: string, listener: RunRecordListener) => bus.subscribe(bus.records, runId, listener)),
  subscribeRunJudgeRecords: vi.fn((runId: string, listener: RunRecordListener) =>
    bus.subscribe(bus.records, `${runId}:judge`, listener),
  ),
}));

let dir: string;
let workspaceRoot: string;
let store: Map<string, EvalRun>;

/** 往该行的事件日志里追加一条事件（写真实文件，走 core 的 seq 分配） */
function append(runId: string, rowId: string, event: Parameters<typeof appendEvent>[1]): AgentEvent {
  const rowDir = join(workspaceRoot, runId, 'rows', rowId);
  mkdirSync(rowDir, { recursive: true });
  return appendEvent(join(rowDir, 'events.jsonl'), event);
}

/** 打开即有首字节的那条注释帧：每一条用例都要先摘掉它 */
const READY = ': ready\n\n';

/**
 * 读若干块再取消：聚合流**不会自己结束**（不因终态关流），`Response.text()` 会一直等下去。
 * api 每帧一次 `enqueue`，所以一块就是一帧——用例因此可以逐帧断言精确文本。
 */
async function readChunks(stream: ReadableStream<Uint8Array>, count: number): Promise<string[]> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  try {
    for (let index = 0; index < count; index += 1) {
      const { value, done } = await reader.read();
      if (done === true) break;
      chunks.push(decoder.decode(value));
    }
  } finally {
    await reader.cancel();
  }
  return chunks;
}

/** 摘掉 ready 帧之后按顺序读 `count` 帧 */
async function readFrames(stream: ReadableStream<Uint8Array>, count: number): Promise<string[]> {
  const chunks = await readChunks(stream, count + 1);
  expect(chunks[0]).toBe(READY);
  return chunks.slice(1);
}

/** 造一条内容消息（用例只覆盖自己关心的格，其余按契约的「没有」填） */
function makeMessage(messageId: string): AgentMessage {
  return {
    messageId,
    vendorId: null,
    role: 'assistant',
    source: 'wire',
    origin: 'case-prompt',
    roundTrip: 1,
    turn: null,
    step: null,
    parentCallId: null,
    subagentId: null,
    chunk: 'delta',
    assembly: 'open',
    mergeKey: 'main|1|assistant|-',
    blocks: [{ type: 'text', text: '正在写' }],
    raw: null,
  };
}

/** 抓同步抛出的 `ServiceError`：用例要断言错误码与逐字文案，`toThrowError` 拿不到对象 */
function captureThrow(action: () => unknown): ServiceError {
  try {
    action();
  } catch (error) {
    if (error instanceof ServiceError) return error;
    throw error;
  }
  throw new Error('预期同步抛错，但调用正常返回了');
}

/** 候选事件帧的逐字文本（`id:` + `data:`，无名事件） */
function eventFrame(rowId: string, event: AgentEvent, rowChannel: 'candidate' | 'judge' = 'candidate'): string {
  return `id: ${event.seq}\ndata: ${JSON.stringify({ ...event, rowId, rowChannel })}\n\n`;
}

/** 消息帧的逐字文本（**没有** `id:` 行） */
function messageFrame(rowId: string, rowChannel: 'candidate' | 'judge', record: RowRecord): string {
  return `data: ${JSON.stringify({ ...record, rowId, rowChannel })}\n\n`;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aieval-aggregate-'));
  setConfigDirForTesting(dir);
  setCasesRootForTesting(join(dir, 'cases'));
  workspaceRoot = join(dir, 'ws');
  updateSettings({ workspaceRoot });
  seedConfig({ cases: [makeCase()] });
  bus.events.clear();
  bus.records.clear();

  store = new Map();
  vi.mocked(getRunSnapshot).mockImplementation((runId: string) => {
    const run = store.get(runId);
    if (run === undefined) throw new ServiceError('NOT_FOUND', `评测不存在：${runId}`);
    return run;
  });
});

afterEach(() => {
  vi.useRealTimers();
  setConfigDirForTesting(null);
  setCasesRootForTesting(null);
  removeTreeWithRetry(dir);
});

describe('streamRunAggregate：逐行游标', () => {
  it('两行各给不同游标，各自只回放 seq 大于自己游标的部分', async () => {
    store.set(
      'run-1',
      makeRun({ id: 'run-1', workspaceBase: workspaceRoot, rows: [makeRow({ id: 'w-1' }), makeRow({ id: 'w-2' })] }),
    );
    append('run-1', 'w-1', { type: 'log', stream: 'stdout', text: 'w1-旧' });
    const w1Kept = append('run-1', 'w-1', { type: 'log', stream: 'stdout', text: 'w1-新' });
    append('run-1', 'w-2', { type: 'log', stream: 'stdout', text: 'w2-更旧' });
    append('run-1', 'w-2', { type: 'log', stream: 'stdout', text: 'w2-旧' });
    const w2Kept = append('run-1', 'w-2', { type: 'log', stream: 'stdout', text: 'w2-新' });

    const frames = await readFrames(
      streamRunAggregate(
        'run-1',
        new Map([
          ['w-1', 1],
          ['w-2', 2],
        ]),
      ),
      2,
    );

    expect(frames).toEqual([eventFrame('w-1', w1Kept), eventFrame('w-2', w2Kept)]);
  });

  it('不在游标表里的行不回放历史，但后续实时帧照推', async () => {
    store.set(
      'run-1',
      makeRun({ id: 'run-1', workspaceBase: workspaceRoot, rows: [makeRow({ id: 'w-1' }), makeRow({ id: 'w-2' })] }),
    );
    const replayed = append('run-1', 'w-1', { type: 'log', stream: 'stdout', text: '表里那行的历史' });
    // 盘上有历史、但这一行不在游标表里（刚开详情页，客户端还没读到它的快照位置）
    append('run-1', 'w-2', { type: 'log', stream: 'stdout', text: '不该被回放的历史' });

    const stream = streamRunAggregate('run-1', new Map([['w-1', 0]]));
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    try {
      expect(decoder.decode((await reader.read()).value)).toBe(READY);
      expect(decoder.decode((await reader.read()).value)).toBe(eventFrame('w-1', replayed));

      const live = append('run-1', 'w-2', { type: 'log', stream: 'stdout', text: '实时帧' });
      for (const listener of bus.events.get('run-1') ?? []) listener('w-2', live);

      // 队列是先进先出：w-2 的历史若被回放过，它一定排在实时帧之前 ⇒ 这一条读到的就是实时帧
      expect(decoder.decode((await reader.read()).value)).toBe(eventFrame('w-2', live));
    } finally {
      await reader.cancel();
    }
  });

  it('游标超过该行水位（重跑删过日志）时按从头回放', async () => {
    store.set('run-1', makeRun({ id: 'run-1', workspaceBase: workspaceRoot, rows: [makeRow({ id: 'w-1' })] }));
    append('run-1', 'w-1', { type: 'log', stream: 'stdout', text: '上一代一' });
    append('run-1', 'w-1', { type: 'log', stream: 'stdout', text: '上一代二' });
    const previous = append('run-1', 'w-1', { type: 'status', status: 'judged' });

    resetEvents(join(workspaceRoot, 'run-1', 'rows', 'w-1', 'events.jsonl'));
    const fresh = append('run-1', 'w-1', { type: 'status', status: 'running' });

    const frames = await readFrames(streamRunAggregate('run-1', new Map([['w-1', previous.seq]])), 1);

    expect(frames).toEqual([eventFrame('w-1', fresh)]);
  });
});

describe('streamRunAggregate：帧格式与归属', () => {
  it('事件帧带 `id: <seq>`，消息帧**没有** `id:` 行、也没有 `seq`', async () => {
    store.set('run-1', makeRun({ id: 'run-1', workspaceBase: workspaceRoot, rows: [makeRow({ id: 'w-1' })] }));
    const event = append('run-1', 'w-1', { type: 'status', status: 'running' });
    const record: RowRecord = { type: 'message', message: makeMessage('m-1') };

    const stream = streamRunAggregate('run-1', new Map([['w-1', 0]]));
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    try {
      expect(decoder.decode((await reader.read()).value)).toBe(READY);
      const eventText = decoder.decode((await reader.read()).value);
      expect(eventText).toBe(eventFrame('w-1', event));
      expect(eventText.startsWith(`id: ${event.seq}\n`)).toBe(true);

      for (const listener of bus.records.get('run-1') ?? []) listener('w-1', record);
      const messageText = decoder.decode((await reader.read()).value);

      expect(messageText).toBe(messageFrame('w-1', 'candidate', record));
      // 两条判据分开写：`id:` 是浏览器游标的唯一来源，`seq` 是服务端事件的发号——
      // 消息两样都不该有（messageId 跨运行重号、delta 覆盖使历史可变）
      expect(messageText).not.toContain('id:');
      const parsed = JSON.parse(messageText.slice('data: '.length).trim()) as Record<string, unknown>;
      expect(parsed).not.toHaveProperty('seq');
      expect(parsed).toMatchObject({ rowId: 'w-1', rowChannel: 'candidate', type: 'message' });
    } finally {
      await reader.cancel();
    }
  });

  it('两个 rowChannel 的消息都推、且各带自己的 rowChannel（候选与评分各一条）', async () => {
    store.set('run-1', makeRun({ id: 'run-1', workspaceBase: workspaceRoot, rows: [makeRow({ id: 'w-1' })] }));
    const candidate: RowRecord = { type: 'message', message: makeMessage('m-candidate') };
    const judge: RowRecord = { type: 'message', message: makeMessage('m-judge') };

    const stream = streamRunAggregate('run-1', new Map());
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    try {
      expect(decoder.decode((await reader.read()).value)).toBe(READY);

      for (const listener of bus.records.get('run-1') ?? []) listener('w-1', candidate);
      expect(decoder.decode((await reader.read()).value)).toBe(messageFrame('w-1', 'candidate', candidate));

      for (const listener of bus.records.get('run-1:judge') ?? []) listener('w-1', judge);
      expect(decoder.decode((await reader.read()).value)).toBe(messageFrame('w-1', 'judge', judge));
    } finally {
      await reader.cancel();
    }
  });

  it('实时候选事件帧带正确的 rowId 与 rowChannel；评分事件**不进**这条流', async () => {
    store.set('run-1', makeRun({ id: 'run-1', workspaceBase: workspaceRoot, rows: [makeRow({ id: 'w-1' })] }));
    const judgeEvent = append('run-1', 'w-1', { type: 'log', stream: 'stdout', text: '评审者的流水' });
    const candidateEvent = append('run-1', 'w-1', { type: 'log', stream: 'stdout', text: '候选的流水' });

    const stream = streamRunAggregate('run-1', new Map());
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    try {
      expect(decoder.decode((await reader.read()).value)).toBe(READY);

      // 评分那条总线推一条：聚合流没有订阅它（评分事件走抽屉流），这一帧必须到不了
      for (const listener of bus.events.get('run-1:judge') ?? []) listener('w-1', judgeEvent);
      for (const listener of bus.events.get('run-1') ?? []) listener('w-1', candidateEvent);

      expect(decoder.decode((await reader.read()).value)).toBe(eventFrame('w-1', candidateEvent));
    } finally {
      await reader.cancel();
    }
  });

  it('某一行进终态不关流：别行的实时帧照常到达（一条连接承载整轮）', async () => {
    store.set(
      'run-1',
      makeRun({ id: 'run-1', workspaceBase: workspaceRoot, rows: [makeRow({ id: 'w-1' }), makeRow({ id: 'w-2' })] }),
    );
    append('run-1', 'w-1', { type: 'status', status: 'running' });
    const end = append('run-1', 'w-1', { type: 'end', exitReason: 'completed' });

    const stream = streamRunAggregate('run-1', new Map([['w-1', 0]]));
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    try {
      expect(decoder.decode((await reader.read()).value)).toBe(READY);
      expect(decoder.decode((await reader.read()).value)).toContain('"status":"running"');
      expect(decoder.decode((await reader.read()).value)).toBe(eventFrame('w-1', end));

      const live = append('run-1', 'w-2', { type: 'log', stream: 'stdout', text: '别行还在跑' });
      for (const listener of bus.events.get('run-1') ?? []) listener('w-2', live);
      expect(decoder.decode((await reader.read()).value)).toBe(eventFrame('w-2', live));
    } finally {
      await reader.cancel();
    }
  });
});

describe('streamRunAggregate：开流前后的资源口径', () => {
  it('轮或游标里的行不存在时**同步**抛错（路由据此回 404 JSON）', () => {
    store.set('run-1', makeRun({ id: 'run-1', workspaceBase: workspaceRoot, rows: [makeRow({ id: 'w-1' })] }));

    // 游标表为空时也要校验轮存在：否则脏 URL 拿到的是一条「开了即静默」的连接
    expect(captureThrow(() => streamRunAggregate('nope', new Map())).code).toBe('NOT_FOUND');

    const missingRow = captureThrow(() => streamRunAggregate('run-1', new Map([['r-x', 0]])));
    expect(missingRow.code).toBe('NOT_FOUND');
    expect(missingRow.message).toBe('该评测里没有这一行（r-x）');
  });

  it('打开即有首字节：不等 15s 心跳就发一条 ready 注释帧', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    store.set('run-1', makeRun({ id: 'run-1', workspaceBase: workspaceRoot, rows: [makeRow({ id: 'w-1' })] }));

    const reader = streamRunAggregate('run-1', new Map()).getReader();
    const decoder = new TextDecoder();
    // 一次都不推进时钟：首块必须已经拿到（没有 ready 帧时这里挂住）
    expect(decoder.decode((await reader.read()).value)).toBe(READY);

    await reader.cancel();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('空历史时 15s 发一条 keep-alive 注释帧；取消后定时器清零并退订三条总线', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    store.set('run-1', makeRun({ id: 'run-1', workspaceBase: workspaceRoot, rows: [makeRow({ id: 'w-1' })] }));

    const reader = streamRunAggregate('run-1', new Map()).getReader();
    const decoder = new TextDecoder();
    expect(decoder.decode((await reader.read()).value)).toBe(READY);
    expect(bus.events.get('run-1')).toHaveLength(1);
    expect(bus.records.get('run-1')).toHaveLength(1);
    expect(bus.records.get('run-1:judge')).toHaveLength(1);

    vi.advanceTimersByTime(15_000);
    expect(decoder.decode((await reader.read()).value)).toBe(': keep-alive\n\n');

    await reader.cancel();
    expect(vi.getTimerCount()).toBe(0);
    // 退订干净：否则长驻服务里每开一次详情页就多一份永久订阅（事件一直往没人读的流里塞）
    expect(bus.events.get('run-1')).toHaveLength(0);
    expect(bus.records.get('run-1')).toHaveLength(0);
    expect(bus.records.get('run-1:judge')).toHaveLength(0);
  });
});
