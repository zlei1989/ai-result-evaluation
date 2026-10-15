/**
 * 聚合流 hub：**一层业务**——游标并集 + 按 run 共享一条连接（连接管理复用 `sse-keyed-hub.ts`）。
 *
 * 五组判据，每组一个靶子：
 *   ① 同名的 run 只开**一条**连接，URL 由各 sink 的游标**并集**决定；
 *   ② 开连接晚一拍：同一拍注册的两个 sink 一起进 URL（早开一步就会漏掉后注册那个 sink 需要的历史）；
 *   ③ 晚到且「需要历史的行」不在当前游标表里的 sink 触发**带合并游标的重连**（关旧开新）；
 *   ④ 不需要历史的 sink（活动行那一路）随便什么时候注册都不重连；
 *   ⑤ 行集合变小不重连：某一行跑完被移出订阅集合，只是那个 sink 不再关心它的帧，连接不动。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunStreamFrame } from '@aieval/contracts';
import { FakeEventSource, installEventSourceStub } from './testing/event-source';
import {
  isAgentEventFrame,
  isRowRecordFrame,
  resetRunStreamHubForTesting,
  runStreamOpenCount,
  subscribeRunStream,
  type RunStreamSink,
} from './run-stream-hub';

/** 让「晚一拍」的那次开连接跑完（宏任务边界一定在所有微任务之后） */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function logFrame(rowId: string, seq: number, text: string): string {
  return JSON.stringify({ type: 'log', seq, at: '2026-09-22T08:00:00.000Z', stream: 'stdout', text, rowId, rowChannel: 'candidate' });
}

/** 一条消息帧（**没有** `id:` 行，与 api 的 `toMessageFrame` 同形） */
function messageFrame(rowId: string, rowChannel: 'candidate' | 'judge', text: string): string {
  return JSON.stringify({
    type: 'message',
    rowId,
    rowChannel,
    message: {
      messageId: 'm-1',
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
      blocks: [{ type: 'text', text }],
      raw: null,
    },
  });
}

/** 收集所有帧的 sink（用例自己按 match 收窄） */
function sink(seen: RunStreamFrame[], cursors?: ReadonlyMap<string, number>): RunStreamSink {
  return { match: () => true, onFrame: (frame) => seen.push(frame), ...(cursors === undefined ? {} : { cursors }) };
}

const cursors = (entries: [string, number][]): Map<string, number> => new Map(entries);

beforeEach(() => {
  FakeEventSource.reset();
  resetRunStreamHubForTesting();
  installEventSourceStub();
});

afterEach(() => {
  resetRunStreamHubForTesting();
  vi.unstubAllGlobals();
});

describe('帧族谓词（两条 hook 靠它把自己那一族挑出来）', () => {
  it('事件帧与记录帧互补；没有归属格的信号帧**两族都不算**', () => {
    const event = JSON.parse(logFrame('w-1', 1, '一条日志')) as RunStreamFrame;
    const message = JSON.parse(messageFrame('w-1', 'candidate', '一句正文')) as RunStreamFrame;
    expect(isAgentEventFrame(event)).toBe(true);
    expect(isRowRecordFrame(event)).toBe(false);
    expect(isAgentEventFrame(message)).toBe(false);
    expect(isRowRecordFrame(message)).toBe(true);

    // 聚合流将来会推信号帧（`ask-user-changed` 等）：它们没有 `rowId` / `rowChannel`，
    // 只按 `type` 判别会被当成事件帧交给折叠层（那边读 `rowId` 读到 undefined）
    const signal = { type: 'ask-user-changed' } as RunStreamFrame;
    expect(isAgentEventFrame(signal)).toBe(false);
    expect(isRowRecordFrame(signal)).toBe(false);
  });
});

describe('run-stream-hub：一条连接 + 游标并集', () => {
  it('两个 sink（一个带游标、一个不带）共用一条连接，URL 带游标并集', async () => {
    const metricsFrames: RunStreamFrame[] = [];
    const activityFrames: RunStreamFrame[] = [];
    const offMetrics = subscribeRunStream({ runId: 'run-1', sink: sink(metricsFrames, cursors([['w-1', 3]])) });
    const offActivity = subscribeRunStream({ runId: 'run-1', sink: sink(activityFrames) });
    await settle();

    expect(FakeEventSource.instances).toHaveLength(1);
    const source = FakeEventSource.instances[0];
    expect(source?.url).toBe('/api/runs/run-1/stream?after=w-1:3');

    source?.emit(logFrame('w-1', 4, '两路都收'));
    expect(metricsFrames).toHaveLength(1);
    expect(activityFrames).toHaveLength(1);

    offMetrics();
    offActivity();
  });

  it('`match` 不匹配的帧一帧都不喂给它（同一键上的两族帧靠它分流）', async () => {
    const onlyLogs: RunStreamFrame[] = [];
    const off = subscribeRunStream({
      runId: 'run-1',
      sink: { match: (frame) => frame.type === 'log', onFrame: (frame) => onlyLogs.push(frame) },
    });
    await settle();
    const source = FakeEventSource.instances[0];

    source?.emit(messageFrame('w-1', 'candidate', '一句正文'));
    source?.emit(logFrame('w-1', 1, '一条日志'));

    expect(onlyLogs).toHaveLength(1);
    expect(onlyLogs[0]).toMatchObject({ type: 'log', text: '一条日志' });
    off();
  });

  it('坏帧只丢自己：非 JSON / 归属格缺失的帧丢掉，后面的好帧照常到达', async () => {
    const seen: RunStreamFrame[] = [];
    const off = subscribeRunStream({ runId: 'run-1', sink: sink(seen) });
    await settle();
    const source = FakeEventSource.instances[0];

    source?.feed('data: 这不是 JSON\n\n');
    // 判别键认识、但没有归属格（旧行级流那种裸 AgentEvent）：不是合法信封
    source?.feed('data: {"type":"log","seq":1,"at":"2026-09-22T08:00:00.000Z","stream":"stdout","text":"x"}\n\n');
    source?.feed(`data: ${logFrame('w-1', 2, '好帧')}\n\n`);

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ type: 'log', text: '好帧', rowId: 'w-1', rowChannel: 'candidate' });
    off();
  });

  it('一个 sink 抛错不影响同一条连接上的另一个 sink', async () => {
    const seen: RunStreamFrame[] = [];
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const offBad = subscribeRunStream({
      runId: 'run-1',
      sink: {
        match: () => true,
        onFrame: () => {
          throw new Error('这个订阅者坏了');
        },
      },
    });
    const offGood = subscribeRunStream({ runId: 'run-1', sink: sink(seen) });
    await settle();

    FakeEventSource.instances[0]?.emit(logFrame('w-1', 1, '同一帧'));

    expect(seen).toHaveLength(1);
    expect(errors).toHaveBeenCalled();
    errors.mockRestore();
    offBad();
    offGood();
  });

  it('环境没有 EventSource 时不抛（指标退回快照值、活动行回落到 log 摘要）', async () => {
    vi.stubGlobal('EventSource', undefined);
    const seen: RunStreamFrame[] = [];
    const off = subscribeRunStream({ runId: 'run-1', sink: sink(seen) });
    await settle();
    expect(FakeEventSource.instances).toHaveLength(0);
    expect(runStreamOpenCount()).toBe(0);
    expect(() => off()).not.toThrow();
  });

  it('同一拍注册的两个带游标 sink：只开一条连接，表里两行都在', async () => {
    const first: RunStreamFrame[] = [];
    const second: RunStreamFrame[] = [];
    const offFirst = subscribeRunStream({ runId: 'run-1', sink: sink(first, cursors([['w-1', 3]])) });
    const offSecond = subscribeRunStream({ runId: 'run-1', sink: sink(second, cursors([['w-2', 5]])) });
    await settle();

    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0]?.url).toBe('/api/runs/run-1/stream?after=w-1:3,w-2:5');

    offFirst();
    offSecond();
  });

  it('同一行的两个 sink 游标不同时取**较小**者：宁重不漏（取大的会跳过小游标还没折过的帧）', async () => {
    const offA = subscribeRunStream({ runId: 'run-1', sink: sink([], cursors([['w-1', 5]])) });
    const offB = subscribeRunStream({ runId: 'run-1', sink: sink([], cursors([['w-1', 3]])) });
    await settle();

    expect(FakeEventSource.instances.map((source) => source.url)).toEqual(['/api/runs/run-1/stream?after=w-1:3']);

    offA();
    offB();
  });

  it('退订到零时连接关闭；再订阅是一条新连接', async () => {
    const off = subscribeRunStream({ runId: 'run-1', sink: sink([]) });
    await settle();
    const source = FakeEventSource.instances[0];

    off();
    expect(source?.closeCount).toBe(1);
    expect(runStreamOpenCount()).toBe(0);

    const offAgain = subscribeRunStream({ runId: 'run-1', sink: sink([]) });
    await settle();
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(runStreamOpenCount()).toBe(1);
    offAgain();
  });
});

describe('run-stream-hub：晚到的 sink', () => {
  it('晚到且「需要历史的行」不在当前游标表里 ⇒ 关旧开新，新 URL 带合并后的表', async () => {
    const offEarly = subscribeRunStream({ runId: 'run-1', sink: sink([], cursors([['w-1', 3]])) });
    await settle();
    const first = FakeEventSource.instances[0];
    expect(first?.url).toBe('/api/runs/run-1/stream?after=w-1:3');

    // 快照读完才来注册的那一路（它的行不在当前表里）
    const offLate = subscribeRunStream({ runId: 'run-1', sink: sink([], cursors([['w-2', 5]])) });
    await settle();

    expect(first?.closeCount).toBe(1);
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(FakeEventSource.instances[1]?.url).toBe('/api/runs/run-1/stream?after=w-1:3,w-2:5');

    offEarly();
    offLate();
  });

  it('晚到 sink 的游标比当前表更早（更小）时同样重连：否则它缺的那几帧再也补不上', async () => {
    const offEarly = subscribeRunStream({ runId: 'run-1', sink: sink([], cursors([['w-1', 5]])) });
    await settle();

    const offLate = subscribeRunStream({ runId: 'run-1', sink: sink([], cursors([['w-1', 3]])) });
    await settle();

    expect(FakeEventSource.instances).toHaveLength(2);
    expect(FakeEventSource.instances[1]?.url).toBe('/api/runs/run-1/stream?after=w-1:3');

    offEarly();
    offLate();
  });

  it('不需要历史的 sink 晚到不重连（活动行那一路只有实时增量）', async () => {
    const offEarly = subscribeRunStream({ runId: 'run-1', sink: sink([], cursors([['w-1', 3]])) });
    await settle();
    const first = FakeEventSource.instances[0];

    const offLate = subscribeRunStream({ runId: 'run-1', sink: sink([]) });
    await settle();

    expect(FakeEventSource.instances).toHaveLength(1);
    expect(first?.closeCount).toBe(0);

    offEarly();
    offLate();
  });

  it('行集合变小不重连：某一行跑完被移出订阅集合，只是那个 sink 不再关心它的帧', async () => {
    const offFirst = subscribeRunStream({ runId: 'run-1', sink: sink([], cursors([['w-1', 3]])) });
    const offSecond = subscribeRunStream({ runId: 'run-1', sink: sink([], cursors([['w-2', 5]])) });
    await settle();
    const source = FakeEventSource.instances[0];
    expect(source?.url).toBe('/api/runs/run-1/stream?after=w-1:3,w-2:5');

    // 第二行跑完：那一路退订（帧照旧到达，只是没人要了）
    offSecond();
    await settle();

    expect(FakeEventSource.instances).toHaveLength(1);
    expect(source?.closeCount).toBe(0);

    // 连接仍在服役：第一路照常收帧
    const seen: RunStreamFrame[] = [];
    const offProbe = subscribeRunStream({
      runId: 'run-1',
      sink: { match: () => true, onFrame: (frame) => seen.push(frame) },
    });
    await settle();
    source?.emit(logFrame('w-1', 4, '仍然到达'));
    expect(seen).toHaveLength(1);

    offFirst();
    offProbe();
  });
});
