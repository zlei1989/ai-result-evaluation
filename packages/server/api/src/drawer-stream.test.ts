// @vitest-environment node
/**
 * 抽屉流（单行单 channel 的完整流水）：该族的事件按 seq 回放 + 续订、该族的消息全量回放 + 续订，
 * 两条既有通道合成一条连接。
 *
 * 三处是本文件最硬的断言对象（合流之后才出现的新接缝）：
 *   ① **帧头分轨**：事件帧有 `id:` 行（`Last-Event-ID` 的唯一来源），消息帧一行都没有——
 *      `messageId` 跨运行重号、delta 覆盖让历史可变，按 seq 续订对一份会变的历史没有意义；
 *   ② **消息先回放、事件后回放**：终态一到就关流，事件排在前面会把消息回放整段吞掉
 *      （跑完的行的对话视图会立刻断连，而那份历史正是用户要看的东西）；
 *   ③ **两族互不串**：候选那条流不许收到评分那族的总线推送，反之亦然。
 *
 * 帧的载荷一律用**契约**（`RunStreamFrameSchema`）校验，不拿实现里的拼法再算一遍：
 * 「帧形状只有一份」这条口径的真源在 contracts，第二份拷贝在这里就等于没有守卫。
 *
 * 四个 `subscribe*` 由本文件自己实现（vi.mock 的工厂里维护四张监听表），于是
 * 「总线推一条 → 流里出现一帧」这条链路可以在不启动任何编排的情况下被验证。
 */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RunStreamFrameSchema,
  ServiceError,
  type AgentEvent,
  type AgentMessage,
  type EvalRun,
  type RowRecord,
  type SubagentRecord,
} from '@aieval/contracts';
import {
  appendEvent,
  appendMessage,
  appendSubagent,
  resetEvents,
  resetRecords,
  rowEventsFile,
  rowJudgeEventsFile,
  rowJudgeMessagesFile,
  rowMessagesFile,
  setCasesRootForTesting,
  setConfigDirForTesting,
} from '@aieval/core';
import { getRun as getRunSnapshot } from '@aieval/evaluator';
import { streamDrawer } from './drawer-stream';
import { updateSettings } from './settings';
import { makeCase, makeRow, makeRun, seedConfig } from './testing/run-fixtures';
import { removeTreeWithRetry } from './testing/cleanup';

/** 候选那族的两条总线（事件 / 记录）——与评分那两张**刻意分开**：共用一张 Map 的话，
 * 「评分推送不投给候选订阅者」这条不变量在替身里会假绿，而那正是它要守的东西 */
const listeners = new Map<string, Array<(event: AgentEvent) => void>>();
const recordListeners = new Map<string, Array<(record: RowRecord) => void>>();
/** 评分那族的两条总线 */
const judgeListeners = new Map<string, Array<(event: AgentEvent) => void>>();
const judgeRecordListeners = new Map<string, Array<(record: RowRecord) => void>>();

/**
 * 一张监听的登记表（`key` 一律是 `runId/rowId`，两条流各自一张）。
 * 退订到空就把键删掉：用例据此区分「从没订阅过」与「订阅过又退干净了」——两者都该是
 * 「这条总线此刻没有这个流的监听」，而留着空数组会让第一种断言写成第二种。
 */
function track<Item>(table: Map<string, Item[]>, runId: string, rowId: string, item: Item): () => void {
  const key = `${runId}/${rowId}`;
  const bucket = table.get(key) ?? [];
  bucket.push(item);
  table.set(key, bucket);
  return () => {
    const remaining = (table.get(key) ?? []).filter((entry) => entry !== item);
    if (remaining.length === 0) table.delete(key);
    else table.set(key, remaining);
  };
}

vi.mock('@aieval/evaluator', () => ({
  listRuns: vi.fn(),
  getRun: vi.fn(),
  saveRun: vi.fn(),
  startRun: vi.fn(),
  abortRun: vi.fn(),
  abortRow: vi.fn(),
  subscribeRowEvents: vi.fn((runId: string, rowId: string, listener: (event: AgentEvent) => void) =>
    track(listeners, runId, rowId, listener),
  ),
  subscribeJudgeEvents: vi.fn((runId: string, rowId: string, listener: (event: AgentEvent) => void) =>
    track(judgeListeners, runId, rowId, listener),
  ),
  subscribeRowRecords: vi.fn((runId: string, rowId: string, listener: (record: RowRecord) => void) =>
    track(recordListeners, runId, rowId, listener),
  ),
  subscribeJudgeRecords: vi.fn((runId: string, rowId: string, listener: (record: RowRecord) => void) =>
    track(judgeRecordListeners, runId, rowId, listener),
  ),
}));

/** 用例只建一轮一行（夹具的缺省 id） */
const RUN_ID = 'run-1';
const ROW_ID = 'r-1';

let dir: string;
let store: Map<string, EvalRun>;

/** 这一轮的快照（`getRun` 的替身从 store 取） */
function currentRun(): EvalRun {
  const run = store.get(RUN_ID);
  if (run === undefined) throw new Error('用例没有建评测');
  return run;
}

/** 该轮该行的产物文件（一律从快照的 `workspaceBase` 推：用户改过工作区根之后历史产物仍在旧根下） */
function fileOf(kind: 'events' | 'judge-events' | 'messages' | 'judge-messages'): string {
  const run = currentRun();
  switch (kind) {
    case 'events':
      return rowEventsFile(run.workspaceBase, run.id, ROW_ID);
    case 'judge-events':
      return rowJudgeEventsFile(run.workspaceBase, run.id, ROW_ID);
    case 'messages':
      return rowMessagesFile(run.workspaceBase, run.id, ROW_ID);
    case 'judge-messages':
      return rowJudgeMessagesFile(run.workspaceBase, run.id, ROW_ID);
  }
}

/** 往文件里追加一条事件（走 core 的 seq 分配） */
function appendRowEvent(file: string, event: Parameters<typeof appendEvent>[1]): AgentEvent {
  mkdirSync(dirname(file), { recursive: true });
  return appendEvent(file, event);
}

function appendCandidateEvent(event: Parameters<typeof appendEvent>[1]): AgentEvent {
  return appendRowEvent(fileOf('events'), event);
}

function appendJudgeEvent(event: Parameters<typeof appendEvent>[1]): AgentEvent {
  return appendRowEvent(fileOf('judge-events'), event);
}

/** 往记录文件里追加一条记录（走 core 的校验与落盘） */
function appendRowRecord(file: string, record: RowRecord): void {
  mkdirSync(dirname(file), { recursive: true });
  if (record.type === 'message') appendMessage(file, record.message);
  else appendSubagent(file, record.subagent);
}

function appendCandidateRecord(record: RowRecord): void {
  appendRowRecord(fileOf('messages'), record);
}

function appendJudgeRecord(record: RowRecord): void {
  appendRowRecord(fileOf('judge-messages'), record);
}

/** 把一条事件推给挂在候选事件总线上的监听（模拟编排层 `publishRowEvent`） */
function publishCandidateEvent(event: AgentEvent): void {
  for (const listener of listeners.get(`${RUN_ID}/${ROW_ID}`) ?? []) listener(event);
}

/** 把一条记录推给挂在候选记录总线上的监听 */
function publishCandidateRecord(record: RowRecord): void {
  for (const listener of recordListeners.get(`${RUN_ID}/${ROW_ID}`) ?? []) listener(record);
}

/** 把一条记录推给挂在评分记录总线上的监听（栅栏用例用它） */
function publishJudgeRecord(record: RowRecord): void {
  for (const listener of judgeRecordListeners.get(`${RUN_ID}/${ROW_ID}`) ?? []) listener(record);
}

/** 一条最小合法消息（用例只覆盖自己关心的格） */
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

/** 一条完整消息记录（非增量 ⇒ 出口不合并，即时成帧） */
function snapshotRecord(text: string, mergeKey = 'main|1|assistant|-'): RowRecord {
  return { type: 'message', message: makeMessage({ mergeKey, blocks: [{ type: 'text', text }] }) };
}

/** 一条增量记录（`chunk: 'delta'` + `assembly: 'open'`，与适配器交出来的形状同构） */
function deltaRecord(text: string, mergeKey = 'main|1|assistant|-'): RowRecord {
  return { type: 'message', message: makeMessage({ messageId: 'run-1:d', chunk: 'delta', assembly: 'open', mergeKey, blocks: [{ type: 'text', text }] }) };
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

/** 读一块（回放全在 `start()` 里同步发生，每次 `enqueue` 是一块，故块数可数） */
async function readChunk(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const chunk = await reader.read();
  if (chunk.done === true) throw new Error('流提前结束');
  return new TextDecoder().decode(chunk.value);
}

/** 帧里的载荷：去掉 `data: ` 前缀后按信封契约解析（帧形状的真源只有一份，就在 contracts） */
function payloadOf(frame: string): unknown {
  const line = frame.split('\n').find((candidate) => candidate.startsWith('data: '));
  if (line === undefined) throw new Error(`帧里没有 data: 行：${frame}`);
  return RunStreamFrameSchema.parse(JSON.parse(line.slice('data: '.length)));
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

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aieval-drawer-'));
  setConfigDirForTesting(dir);
  // 用例目录也要指到临时目录：seedConfig 把用例写成一文件一落（core 的 `case-store`）
  setCasesRootForTesting(join(dir, 'cases'));
  updateSettings({ workspaceRoot: join(dir, 'ws') });
  seedConfig({ cases: [makeCase()] });

  listeners.clear();
  recordListeners.clear();
  judgeListeners.clear();
  judgeRecordListeners.clear();

  store = new Map();
  store.set(RUN_ID, makeRun({ rows: [makeRow()] }));
  vi.mocked(getRunSnapshot).mockImplementation((runId: string) => {
    const found = store.get(runId);
    if (found === undefined) throw new ServiceError('NOT_FOUND', `评测不存在：${runId}`);
    return found;
  });

  // 夹具的 `workspaceBase` 是**本文件共用的那一棵临时树**（夹具模块按测试文件建一棵），
  // 跨用例会共用同一个文件 ⇒ 每条用例开头清一次，否则上一条用例写进去的产物会漏进下一条的断言
  resetEvents(fileOf('events'));
  resetEvents(fileOf('judge-events'));
  resetRecords(fileOf('messages'));
  resetRecords(fileOf('judge-messages'));
});

afterEach(() => {
  vi.useRealTimers();
  setConfigDirForTesting(null);
  setCasesRootForTesting(null);
  removeTreeWithRetry(dir);
});

describe('streamDrawer：帧形态与两族的接缝', () => {
  it('事件帧有 `id:` 行、消息帧一行都没有（两族的帧头分轨）', async () => {
    const event = appendCandidateEvent({ type: 'log', stream: 'stdout', text: '第一行' });
    appendCandidateRecord(snapshotRecord('对话历史'));

    const reader = streamDrawer(RUN_ID, ROW_ID, 'candidate', 0).getReader();
    // 顺序：ready → 消息回放 → 事件回放（文件头口径 ②）
    expect(await readChunk(reader)).toBe(': ready\n\n');
    const messageFrame = await readChunk(reader);
    const eventFrame = await readChunk(reader);
    await reader.cancel();

    // 消息帧只有 event/data 两行：`id:` 行是浏览器 `Last-Event-ID` 的唯一来源，
    // 而这一侧没有任何东西能解释那个值（messageId 跨运行重号、delta 覆盖让历史可变）
    expect(messageFrame).not.toMatch(/^id: /m);
    expect(messageFrame.split('\n')[0]).toBe('event: message');
    expect(payloadOf(messageFrame)).toMatchObject({
      type: 'message',
      rowId: ROW_ID,
      rowChannel: 'candidate',
      message: { messageId: 'run-1:1' },
    });

    expect(eventFrame).toMatch(new RegExp(`^id: ${event.seq}$`, 'm'));
    expect(eventFrame.split('\n')[1]).toBe('event: log');
    expect(payloadOf(eventFrame)).toMatchObject({
      type: 'log',
      rowId: ROW_ID,
      rowChannel: 'candidate',
      seq: event.seq,
      text: '第一行',
    });
  });

  it('channel 决定读哪一族：judge 那条流只给评分两族的文件内容，候选的既不在也不串', async () => {
    appendCandidateEvent({ type: 'log', stream: 'stdout', text: '候选事件' });
    appendCandidateRecord(snapshotRecord('候选消息', 'candidate|-'));
    const judgeEvent = appendJudgeEvent({ type: 'log', stream: 'stderr', text: '评分事件' });
    appendJudgeRecord(snapshotRecord('评分消息', 'judge|-'));

    const reader = streamDrawer(RUN_ID, ROW_ID, 'judge', 0).getReader();
    expect(await readChunk(reader)).toBe(': ready\n\n');
    const messageFrame = await readChunk(reader);
    const eventFrame = await readChunk(reader);
    await reader.cancel();

    expect(messageFrame).not.toMatch(/^id: /m);
    expect(payloadOf(messageFrame)).toMatchObject({
      type: 'message',
      rowId: ROW_ID,
      rowChannel: 'judge',
      message: { mergeKey: 'judge|-' },
    });
    expect(eventFrame).toMatch(new RegExp(`^id: ${judgeEvent.seq}$`, 'm'));
    expect(payloadOf(eventFrame)).toMatchObject({ type: 'log', rowId: ROW_ID, rowChannel: 'judge', text: '评分事件' });
    expect(messageFrame + eventFrame).not.toContain('候选');
  });

  it('两族总线互不串：往候选总线推，judge 那条流一帧都收不到', async () => {
    const reader = streamDrawer(RUN_ID, ROW_ID, 'judge', 0).getReader();
    expect(await readChunk(reader)).toBe(': ready\n\n');

    // judge 流挂的是评分那两条总线（候选那两条一格都不该挂）
    expect(judgeListeners.get(`${RUN_ID}/${ROW_ID}`)).toHaveLength(1);
    expect(judgeRecordListeners.get(`${RUN_ID}/${ROW_ID}`)).toHaveLength(1);
    expect(listeners.get(`${RUN_ID}/${ROW_ID}`)).toBeUndefined();
    expect(recordListeners.get(`${RUN_ID}/${ROW_ID}`)).toBeUndefined();

    // 候选那两条总线上的推送（事件走 `appendCandidateEvent` 的返回值：`at`/`seq` 由 core 补全）
    publishCandidateEvent(appendCandidateEvent({ type: 'log', stream: 'stdout', text: '候选的推送' }));
    publishCandidateRecord(snapshotRecord('候选推送的消息'));
    // 栅栏：评分那族的推送一到就断言——同一 tick 内先推的候选两条若被误投，必然排在它前面
    publishJudgeRecord(snapshotRecord('评分栅栏', 'judge|-'));

    const first = await readChunk(reader);
    await reader.cancel();

    expect(first).toContain('评分栅栏');
    expect(first).not.toContain('候选');
  });

  it('子任务行也是消息那一侧的一帧（`event` 名取记录的 `type`）', async () => {
    appendCandidateRecord({ type: 'subagent', subagent: makeSubagent() });

    const reader = streamDrawer(RUN_ID, ROW_ID, 'candidate', 0).getReader();
    expect(await readChunk(reader)).toBe(': ready\n\n');
    const frame = await readChunk(reader);
    await reader.cancel();

    expect(frame.split('\n')[0]).toBe('event: subagent');
    expect(frame).not.toMatch(/^id: /m);
    expect(payloadOf(frame)).toMatchObject({ type: 'subagent', rowId: ROW_ID, rowChannel: 'candidate', subagent: { subagentId: 'child-1' } });
  });
});

describe('streamDrawer：续订游标', () => {
  it('afterSeq 只回放 seq 更大的事件；消息不受游标影响、仍全量回放', async () => {
    appendCandidateEvent({ type: 'log', stream: 'stdout', text: '旧一' });
    appendCandidateEvent({ type: 'log', stream: 'stdout', text: '旧二' });
    const fresh = appendCandidateEvent({ type: 'log', stream: 'stdout', text: '新' });
    appendCandidateRecord({ type: 'message', message: makeMessage({ messageId: 'run-1:a', blocks: [{ type: 'text', text: '消息一' }] }) });
    appendCandidateRecord({ type: 'message', message: makeMessage({ messageId: 'run-1:b', mergeKey: 'main|2|assistant|-', blocks: [{ type: 'text', text: '消息二' }] }) });

    const reader = streamDrawer(RUN_ID, ROW_ID, 'candidate', 2).getReader();
    let text = await readChunk(reader); // ready
    for (let index = 0; index < 3; index += 1) text += await readChunk(reader); // 两条消息 + 一条事件
    await reader.cancel();

    expect(text).not.toContain('旧一');
    expect(text).not.toContain('旧二');
    expect(text).toContain(`id: ${fresh.seq}`);
    expect(text).toContain('"text":"新"');
    // 游标只对事件那一侧有意义：消息照旧全量（客户端按 messageId 去重 / mergeKey 覆盖）
    expect(text).toContain('消息一');
    expect(text).toContain('消息二');
  });

  it('续订游标来自上一代（超过水位）时从头回放：重跑删过日志，旧游标在新一代里没有对应的号', async () => {
    appendCandidateEvent({ type: 'log', stream: 'stdout', text: '上一代' });
    const previous = appendCandidateEvent({ type: 'status', status: 'judged' });
    resetEvents(fileOf('events'));
    const fresh = appendCandidateEvent({ type: 'status', status: 'running' });

    const reader = streamDrawer(RUN_ID, ROW_ID, 'candidate', previous.seq).getReader();
    expect(await readChunk(reader)).toBe(': ready\n\n');
    const frame = await readChunk(reader);
    await reader.cancel();

    expect(frame).toMatch(new RegExp(`^id: ${fresh.seq}$`, 'm'));
    expect(payloadOf(frame)).toMatchObject({ type: 'status', status: 'running', seq: fresh.seq });
  });

  it('连接活着时日志被重置：新一代的 seq 回到 1 照样成帧（判据是游标超过水位，不是「看到 1」）', async () => {
    // 抽屉一直开着的那种形状：连接活着、心跳照发，谁也不会去重连 ⇒ 这道闸门若不放行换代，
    // 新一代的 1..k 会被上一代的游标整段吃掉，界面上只是「执行日志一条都不动」
    appendCandidateEvent({ type: 'log', stream: 'stdout', text: '上一代' });
    const previous = appendCandidateEvent({ type: 'log', stream: 'stdout', text: '上一代末尾' });

    const reader = streamDrawer(RUN_ID, ROW_ID, 'candidate', previous.seq).getReader();
    expect(await readChunk(reader)).toBe(': ready\n\n');

    resetEvents(fileOf('events'));
    const fresh = appendCandidateEvent({ type: 'status', status: 'running' });
    publishCandidateEvent(fresh);

    const frame = await readChunk(reader);
    await reader.cancel();

    expect(frame).toMatch(new RegExp(`^id: ${fresh.seq}$`, 'm'));
    expect(payloadOf(frame)).toMatchObject({ type: 'status', status: 'running', seq: fresh.seq });
  });

  it('两条 channel 的 seq 各算各的：拿候选的水位去续评分那条流会被当成上一代，于是从头回放', async () => {
    appendJudgeEvent({ type: 'log', stream: 'stderr', text: '评分一' });
    const second = appendJudgeEvent({ type: 'log', stream: 'stderr', text: '评分二' });
    for (let index = 0; index < 5; index += 1) appendCandidateEvent({ type: 'log', stream: 'stdout', text: `候选${index}` });

    // 候选那条流的号已经到 5，评分那条只到 2 ⇒ 5 是「被删掉的那一代」的游标
    const reader = streamDrawer(RUN_ID, ROW_ID, 'judge', 5).getReader();
    expect(await readChunk(reader)).toBe(': ready\n\n');
    const text = (await readChunk(reader)) + (await readChunk(reader));
    await reader.cancel();

    expect(text).toContain('评分一');
    expect(text).toContain(`id: ${second.seq}`);
  });
});

describe('streamDrawer：终态与生命周期', () => {
  it('回放里出现终态 ⇒ 关流；消息全量仍在它**之前**交付', async () => {
    const end = appendCandidateEvent({ type: 'end', exitReason: 'completed' });
    appendCandidateRecord(snapshotRecord('跑完之后的对话历史'));

    // 回放里带终态 ⇒ 流自己结束（否则 `text()` 这里会挂住）
    const text = await new Response(streamDrawer(RUN_ID, ROW_ID, 'candidate', 0)).text();

    expect(text).toContain(`id: ${end.seq}\nevent: end`);
    expect(text).toContain('跑完之后的对话历史');
    // 消息在终态帧**之前**：排在后面就会被关流吞掉，而那是用户打开一个跑完的行时要看的东西
    expect(text.indexOf('跑完之后的对话历史')).toBeLessThan(text.indexOf('event: end'));
    // 历史里已有终态 ⇒ 一条总线都不订阅（订阅了就再也没人退订，长驻服务里越积越多）
    expect(listeners.get(`${RUN_ID}/${ROW_ID}`)).toBeUndefined();
    expect(recordListeners.get(`${RUN_ID}/${ROW_ID}`)).toBeUndefined();
  });

  it('终态的 status 事件同样关流（不必等到 end）', async () => {
    appendCandidateEvent({ type: 'status', status: 'canceled' });

    const text = await new Response(streamDrawer(RUN_ID, ROW_ID, 'candidate', 0)).text();

    expect(text).toContain('event: status');
    expect(text.endsWith('\n\n')).toBe(true);
  });

  it('实时到达终态 ⇒ 关流并退订两条总线；消息不参与终态判定', async () => {
    const reader = streamDrawer(RUN_ID, ROW_ID, 'candidate', 0).getReader();
    expect(await readChunk(reader)).toBe(': ready\n\n');

    // 只有消息时不关流（消息一侧**不参与**终态判定）
    publishCandidateRecord(snapshotRecord('实时消息'));
    expect(await readChunk(reader)).toContain('实时消息');

    const end = appendCandidateEvent({ type: 'end', exitReason: 'completed' });
    publishCandidateEvent(end);
    const frame = await readChunk(reader);

    expect(frame).toMatch(new RegExp(`^id: ${end.seq}$`, 'm'));
    expect(payloadOf(frame)).toMatchObject({ type: 'end', rowId: ROW_ID, rowChannel: 'candidate' });
    expect((await reader.read()).done).toBe(true);
    expect(listeners.get(`${RUN_ID}/${ROW_ID}`)).toBeUndefined();
    expect(recordListeners.get(`${RUN_ID}/${ROW_ID}`)).toBeUndefined();
  });

  it('终态关流前先把出口窗口里待发的增量冲出去（否则一段正文停在半截）', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const reader = streamDrawer(RUN_ID, ROW_ID, 'candidate', 0).getReader();
    expect(await readChunk(reader)).toBe(': ready\n\n');

    // 增量进窗口时一条都还没发（16ms 窗口还没到）；终态紧接着来 —— 关流前必须冲出去
    publishCandidateRecord(deltaRecord('半截正文'));
    const end = appendCandidateEvent({ type: 'end', exitReason: 'completed' });
    publishCandidateEvent(end);

    const flushed = await readChunk(reader);
    const last = await readChunk(reader);
    expect(flushed).toContain('半截正文');
    expect(last).toContain(`id: ${end.seq}`);
    expect((await reader.read()).done).toBe(true);
  });

  it('没有终态时流一直活着：消息照发、心跳续着（消息侧不触发关流）', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const reader = streamDrawer(RUN_ID, ROW_ID, 'candidate', 0).getReader();
    expect(await readChunk(reader)).toBe(': ready\n\n');

    publishCandidateRecord(snapshotRecord('实时消息'));
    expect(await readChunk(reader)).toContain('实时消息');

    // 15s 后心跳照发 ⇒ 这条流还活着（消息既不关流，也不改变心跳）
    vi.advanceTimersByTime(15_000);
    expect(await readChunk(reader)).toBe(': keep-alive\n\n');

    await reader.cancel();
    expect(vi.getTimerCount()).toBe(0);
    expect(listeners.get(`${RUN_ID}/${ROW_ID}`)).toBeUndefined();
    expect(recordListeners.get(`${RUN_ID}/${ROW_ID}`)).toBeUndefined();
  });

  it('客户端取消时退订两条总线（否则记录会一直往没人读的流里塞）', async () => {
    const reader = streamDrawer(RUN_ID, ROW_ID, 'candidate', 0).getReader();
    await reader.read();
    expect(listeners.get(`${RUN_ID}/${ROW_ID}`)).toHaveLength(1);
    expect(recordListeners.get(`${RUN_ID}/${ROW_ID}`)).toHaveLength(1);

    await reader.cancel();

    expect(listeners.get(`${RUN_ID}/${ROW_ID}`)).toBeUndefined();
    expect(recordListeners.get(`${RUN_ID}/${ROW_ID}`)).toBeUndefined();
  });

  it('轮或行不存在时**同步**抛 NOT_FOUND：路由据此给 404 JSON，而不是开一个立刻结束的流', () => {
    for (const channel of ['candidate', 'judge'] as const) {
      expect(captureThrow(() => streamDrawer('nope', ROW_ID, channel, 0)).code).toBe('NOT_FOUND');
      // 「行不存在」的校验只有一份（run-artifacts 的 findRow）：连同错误码与**逐字文案**一起钉住
      const missingRow = captureThrow(() => streamDrawer(RUN_ID, 'r-x', channel, 0));
      expect(missingRow.code).toBe('NOT_FOUND');
      expect(missingRow.message).toBe('该评测里没有这一行（r-x）');
    }
  });
});

describe('streamDrawer：增量帧的出口合并', () => {
  it('同一 mergeKey 的连续增量只出一条（末条累积值），快照紧随其后', async () => {
    const reader = streamDrawer(RUN_ID, ROW_ID, 'candidate', 0).getReader();
    expect(await readChunk(reader)).toBe(': ready\n\n');

    publishCandidateRecord(deltaRecord('我先'));
    publishCandidateRecord(deltaRecord('我先看'));
    publishCandidateRecord(deltaRecord('我先看一下'));
    publishCandidateRecord(snapshotRecord('我先看一下配置文件。'));

    const first = await readChunk(reader);
    const second = await readChunk(reader);
    await reader.cancel();

    // 三条增量只出一条（非增量记录一到就先把待发增量冲出去，顺序不变）
    expect((first + second).match(/event: message/g)).toHaveLength(2);
    expect(first).toContain('"text":"我先看一下"');
    expect(second).toContain('"text":"我先看一下配置文件。"');
  });
});
