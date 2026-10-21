/**
 * 抽屉流 hub：**一行一个 channel 一条连接**，聚合流之外的三个抽屉 hook 都从这里取帧。
 *
 * 本文件的断言对象是这条共享层自己的四件事：
 *   1. **共享**：同一 `runId:candidateId:channel` 的多个 sink 只开一条 `EventSource`；不同 channel 各一条；
 *   2. **生命周期**：引用计数归零即关连接（抽屉关掉不留长连接）；
 *   3. **解帧**：帧按 contracts 的信封契约（`RunStreamFrameSchema`）校验后才交给 sink，
 *      坏帧只跳过它自己（`onInvalidFrame`），绝不打断整条流；
 *   4. **连接故障与服务端帧的分流**：`error` 这个名字在 `EventSource` 上有两个来源
 *      （连接失败 vs 服务端发的具名 `error` 帧），按帧的形状分开处置——判据同 `row-stream.ts`。
 *
 * 帧一律用具名事件投递（`FakeEventSource.emitNamed` / `feed`）：api 发的是 `event: <type>` 的
 * 具名事件，而规范规定 `onmessage` **只收无名事件**——用 `emit()` 喂 `onmessage` 等于假装
 * 浏览器会把具名事件交给它，替身比真实链路弱，守卫整体失去区分力。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AGENT_EVENT_TYPES, type AgentMessage, type DrawerChannel, type RunStreamFrame } from '@aieval/contracts';
import {
  drawerStreamKey,
  drawerStreamOpenCount,
  drawerStreamUrl,
  resetDrawerStreamHubForTesting,
  subscribeDrawerStream,
  type DrawerSink,
} from './drawer-stream-hub';
import { FakeEventSource, installEventSourceStub } from './testing/event-source';
import { makeEvent } from './testing/run-fixtures';

/** 一个 sink 的观测面：收到的帧、连接事件、坏帧与故障文案 */
interface Harness {
  frames: RunStreamFrame[];
  opens: number;
  invalid: number;
  errors: string[];
  sink: DrawerSink;
}

function makeHarness(): Harness {
  const harness: Harness = { frames: [], opens: 0, invalid: 0, errors: [], sink: {} as DrawerSink };
  harness.sink = {
    onFrame: (frame) => harness.frames.push(frame),
    onOpen: () => {
      harness.opens += 1;
    },
    onError: (message) => harness.errors.push(message),
    onInvalidFrame: () => {
      harness.invalid += 1;
    },
  };
  return harness;
}

/** 一条最小合法消息（信封那一帧的载荷） */
function makeMessage(overrides: Partial<AgentMessage> = {}): AgentMessage {
  return {
    messageId: 'run-1:1',
    vendorId: null,
    role: 'assistant',
    source: 'wire',
    origin: 'case-prompt',
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

/** 一帧的 `data:` 载荷：事件帧 / 消息帧都带归属两格（与 api 的组帧同形） */
function frameData(payload: { type: string } & Record<string, unknown>, candidateChannel: DrawerChannel = 'candidate', candidateId = 'w-1'): string {
  return JSON.stringify({ ...payload, candidateId, candidateChannel });
}

beforeEach(() => {
  FakeEventSource.reset();
  installEventSourceStub();
  resetDrawerStreamHubForTesting();
});

afterEach(() => {
  resetDrawerStreamHubForTesting();
  vi.unstubAllGlobals();
});

describe('drawerStreamKey / drawerStreamUrl', () => {
  it('键 = runId:candidateId:candidateChannel；URL 带上 candidateId / candidateChannel / afterSeq', () => {
    expect(drawerStreamKey('run-1', 'w-1', 'judge')).toBe('run-1:w-1:judge');
    expect(drawerStreamUrl('run-1', 'w-1', 'candidate', 3)).toBe(
      '/api/runs/run-1/drawer/stream?candidateId=w-1&candidateChannel=candidate&afterSeq=3',
    );
  });
});

describe('subscribeDrawerStream：共享、生命周期、解帧', () => {
  it('同一 runId:candidateId:candidateChannel 的两个 sink 共用**一条** EventSource，且都收到同一帧', () => {
    const first = makeHarness();
    const second = makeHarness();
    subscribeDrawerStream('run-1', 'w-1', 'candidate', first.sink, 3);
    subscribeDrawerStream('run-1', 'w-1', 'candidate', second.sink, 0);

    expect(FakeEventSource.instances).toHaveLength(1);
    // 连接数只有一条（两个 sink 共用一个键）
    expect(drawerStreamOpenCount()).toBe(1);
    // 游标由**先到的那个**订阅者决定（后来者共用这条连接，多出来的回放由它自己去重）
    expect(FakeEventSource.instances[0]?.url).toBe('/api/runs/run-1/drawer/stream?candidateId=w-1&candidateChannel=candidate&afterSeq=3');

    const event = makeEvent({ seq: 4, text: '实时来的' });
    FakeEventSource.instances[0]?.feed(`id: 4\nevent: log\ndata: ${frameData(event)}\n\n`);

    expect(first.frames).toHaveLength(1);
    expect(second.frames).toHaveLength(1);
    expect(first.frames[0]).toMatchObject({ type: 'log', candidateId: 'w-1', candidateChannel: 'candidate', seq: 4, text: '实时来的' });
  });

  it('不同 channel 是两条连接（两个抽屉各自一条流）', () => {
    const candidate = makeHarness();
    const judge = makeHarness();
    subscribeDrawerStream('run-1', 'w-1', 'candidate', candidate.sink, 0);
    subscribeDrawerStream('run-1', 'w-1', 'judge', judge.sink, 0);

    expect(FakeEventSource.instances).toHaveLength(2);
    expect(FakeEventSource.instances.map((source) => source.url)).toEqual([
      '/api/runs/run-1/drawer/stream?candidateId=w-1&candidateChannel=candidate&afterSeq=0',
      '/api/runs/run-1/drawer/stream?candidateId=w-1&candidateChannel=judge&afterSeq=0',
    ]);
  });

  it('引用计数归零才关连接：退掉一个还剩一个时不关，退掉最后一个才关', () => {
    const first = makeHarness();
    const second = makeHarness();
    const offFirst = subscribeDrawerStream('run-1', 'w-1', 'candidate', first.sink, 0);
    const offSecond = subscribeDrawerStream('run-1', 'w-1', 'candidate', second.sink, 0);
    const source = FakeEventSource.instances[0];
    if (source === undefined) throw new Error('没有建连接');

    offFirst();
    expect(source.closeCount).toBe(0);

    offSecond();
    expect(source.closeCount).toBe(1);
    expect(drawerStreamOpenCount()).toBe(0);
    // 监听器也要摘干净：连接已关、监听器还挂着在真实浏览器里会保留整条闭包链
    expect(source.listenerCount()).toBe(0);
  });

  it('重复调用退订函数只算一次（effect 清理跑两遍不该把别人的引用计数减掉）', () => {
    const harness = makeHarness();
    const off = subscribeDrawerStream('run-1', 'w-1', 'candidate', harness.sink, 0);
    const source = FakeEventSource.instances[0];

    off();
    off();

    expect(source?.closeCount).toBe(1);
  });

  it('帧按信封契约校验后才交付；坏帧只跳过它自己，后续好帧照常到', () => {
    const harness = makeHarness();
    subscribeDrawerStream('run-1', 'w-1', 'candidate', harness.sink, 0);
    const source = FakeEventSource.instances[0];
    if (source === undefined) throw new Error('没有建连接');

    // 不是 JSON / 是 JSON 但不是信封里的任何一支（少了归属格）
    source.emitNamed('log', '这不是 JSON');
    source.emitNamed('log', JSON.stringify({ type: 'log', seq: 9, at: 'x', text: '缺归属两格' }));
    expect(harness.frames).toHaveLength(0);
    expect(harness.invalid).toBe(2);

    const good = makeEvent({ seq: 1, text: '好帧' });
    source.emitNamed('log', frameData(good));
    expect(harness.frames).toHaveLength(1);
    expect(harness.invalid).toBe(2);
  });

  it('消息帧与事件帧都按同一个信封解析（两族的 `type` 判别键各归各的）', () => {
    const harness = makeHarness();
    subscribeDrawerStream('run-1', 'w-1', 'candidate', harness.sink, 0);
    const source = FakeEventSource.instances[0];
    if (source === undefined) throw new Error('没有建连接');

    const message = makeMessage();
    // 消息帧没有 `id:` 行（`messageId` 跨运行重号、delta 覆盖让历史可变）
    source.feed(`event: message\ndata: ${frameData({ type: 'message', message })}\n\n`);

    expect(harness.frames).toHaveLength(1);
    expect(harness.frames[0]).toMatchObject({ type: 'message', candidateId: 'w-1', candidateChannel: 'candidate', message: { messageId: 'run-1:1' } });
  });

  it('具名事件按清单逐个订阅（`error` 除外），无名帧走 onmessage 兜底', () => {
    const harness = makeHarness();
    subscribeDrawerStream('run-1', 'w-1', 'candidate', harness.sink, 0);
    const source = FakeEventSource.instances[0];
    if (source === undefined) throw new Error('没有建连接');

    for (const type of AGENT_EVENT_TYPES) {
      expect(source.listenerCount(type), `'${type}' 的监听器数量不对`).toBe(type === 'error' ? 0 : 1);
    }
    // 记录那一侧：`subagent` 是普通具名事件，要有监听器；`message` 是 SSE 的**默认事件类型**
    // （由 `onmessage` 属性承载），再挂一条监听器会让每一帧投递两次
    expect(source.listenerCount('subagent')).toBe(1);
    expect(source.listenerCount('message')).toBe(0);

    // 无名帧的兜底：服务端哪天不发 `event:` 行了也照样能收
    const fallback = makeEvent({ seq: 2 });
    source.feed(`data: ${frameData(fallback)}\n\n`);
    expect(harness.frames.map((frame) => (frame.type === 'log' ? frame.seq : 0))).toEqual([2]);
  });

  it('服务端发的具名 `error` 帧照常交付，且不被当成连接故障', () => {
    const harness = makeHarness();
    subscribeDrawerStream('run-1', 'w-1', 'candidate', harness.sink, 0);
    const source = FakeEventSource.instances[0];
    if (source === undefined) throw new Error('没有建连接');

    const failure = makeEvent({ seq: 2, type: 'error', message: '适配器返回非零退出码 1' });
    source.emitNamed('error', frameData(failure));

    expect(harness.frames).toHaveLength(1);
    expect(harness.frames[0]).toMatchObject({ type: 'error', message: '适配器返回非零退出码 1' });
    expect(harness.errors).toHaveLength(0);
  });

  it('连接故障（没有 data 的 error 事件）交给 onError：文案由各条流自己给', () => {
    const harness = makeHarness();
    subscribeDrawerStream('run-1', 'w-1', 'candidate', harness.sink, 0);
    const source = FakeEventSource.instances[0];
    if (source === undefined) throw new Error('没有建连接');

    source.emitOpen();
    source.emitError();

    expect(harness.opens).toBe(1);
    expect(harness.errors).toHaveLength(1);
    expect(harness.errors[0]).toContain('自动重连');
    expect(harness.frames).toHaveLength(0);
  });

  it('reset 关掉全部连接（用例之间不串连接）', () => {
    const harness = makeHarness();
    subscribeDrawerStream('run-1', 'w-1', 'candidate', harness.sink, 0);
    subscribeDrawerStream('run-2', 'w-1', 'judge', harness.sink, 0);
    const [first, second] = FakeEventSource.instances;
    if (first === undefined || second === undefined) throw new Error('没有建两条连接');

    resetDrawerStreamHubForTesting();

    expect(first.closeCount).toBe(1);
    expect(second.closeCount).toBe(1);
  });
});
