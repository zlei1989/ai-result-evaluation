// @vitest-environment node
/**
 * dsh 接入一致性套件（判据源见 `../conformance/kit.ts`）。
 *
 * 与 claude 那份同形：走 **run 级测试台**（注入假 SDK 跑真实运行路径），模块加载期把各场景跑一次
 * 建好产物，再把同步取值器交给套件（理由见 `claude-code/conformance.test.ts` 的文件头）。
 *
 * 两条「看不见的匹配键」，错了会让判据红在完全误导性的位置（2026-10-07 各踩过一次）：
 *   1. **`params.sessionId` 必须用 `DSH_SESSION_PLACEHOLDER`**（假件的会话号）。自造一个会让
 *      **整类会话事件被静默丢弃**：消息 0 条、`turns` 为 `null`、`finalText` 为 `null`，
 *      而工具那两组判据照样过（它们不看消息）⇒ 红在「思考块不存在」，看着像能力声明写错。
 *   2. **子任务事件是顶层 `method`**（`subagent.started` / `subagent.finished`），
 *      **不是** `session.event` 里的 `event.type`——`dshSubagentRecord` 读的是
 *      `readString(notification,'method')`（`message.ts:313-316`），身份取 `params.subagentId`
 *      （三级兜底 `subagentId` → `agentId` → `childSessionId`）。
 *
 * 本夹具**造正文/思考增量**（2026-10-09 stream-tap 起）：`streamingDelta` 记 `'yes'`（source
 * `'hook'`）——增量经旁路文件进适配器（夹具的 `tapLines` 落到同一文件、同一时序），
 * 套件第 7 组「能力声明与产物互钉」据此要求 `plain-reply` 场景真出 delta 消息。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentEvent, AgentMessage, SubagentRecord } from '@aieval/contracts';
import { afterEach } from 'vitest';
import { setAgentRuntimeForTesting } from '../../runtime';
import {
  collectEvents,
  createFakeDshSdk,
  createRecorder,
  createRunInput,
  DSH_SESSION_PLACEHOLDER,
} from '../../testing/agent-fixtures';
import { removeTreeWithRetry } from '../../testing/cleanup';
import { describeProviderConformance, type ConformanceProduct } from '../conformance/kit';
import { dshProvider } from './index';
import { DSH_PACKAGE_NAME } from './sdk';

afterEach(() => {
  setAgentRuntimeForTesting(null);
});

/** 会话号必须与假件一致，否则整类会话事件被静默丢弃（见文件头） */
const MAIN = DSH_SESSION_PLACEHOLDER;
const TASK_ID = 'child-session-1';
const TASK_CALL = 'call_dsh_subagent';

const stepStart = (sessionId: string, turn: number, step: number): unknown => ({
  method: 'session.event',
  params: { sessionId, event: { type: 'step/start', time: 1, data: { turn, step } } },
});

const assistant = (sessionId: string, id: string, turn: number, step: number, content: readonly unknown[]): unknown => ({
  method: 'session.event',
  params: {
    sessionId,
    event: { type: 'assistant/message', time: 1, data: { turn, step, message: { id, role: 'assistant', content } } },
  },
});

const sessionEvent = (type: string, data: Record<string, unknown>): unknown => ({
  method: 'session.event',
  params: { sessionId: MAIN, event: { type, time: 1, data } },
});

/**
 * 造一条 stream-tap 旁路行（`{ sid, frame }`，frame 是 `AssistantStreamFrame` 的 chunk 形状；
 * sid 用占位 id，夹具在 `run()` 落笔时改写成真实会话 id——与通知的 `tagSession` 同一理由）。
 */
const tapChunk = (
  chunk: Record<string, unknown>,
  sid: string = MAIN,
  attemptId = 'att-1',
  turn = 1,
  step = 1,
): unknown => ({
  sid,
  frame: { type: 'chunk', attemptId, revision: 1, index: 0, time: 1, turn, step, chunk },
});

/**
 * 四个场景覆盖 dsh 能力声明里全部为 `yes` 的格：
 * `plain-reply` → 最终答复 + streamingDelta、`thinking-full` → thinkingText、
 * `tool-shell` → toolInput + toolResult、`subagent` → subagent。
 */
const SCENARIOS: Readonly<Record<string, { events: readonly unknown[]; tapLines?: readonly unknown[] }>> = {
  // tap 时序与真机同构：block-start 占位 → 两条 text-delta → 快照（assistant/message）覆盖收尾
  'plain-reply': {
    events: [stepStart(MAIN, 1, 1), assistant(MAIN, 'm1', 1, 1, [{ type: 'text', text: '没问题，工具已就绪。' }])],
    tapLines: [
      tapChunk({ type: 'block-start', index: 0, blockType: 'text' }),
      tapChunk({ type: 'text-delta', index: 0, text: '没问题，' }),
      tapChunk({ type: 'text-delta', index: 0, text: '工具已就绪。' }),
    ],
  },
  // `reasoning` 块**也带 `text` 字段** ⇒ 必须按 `type` 过滤，否则推理正文会混进最终答复；
  // 思考增量走 `reasoning-delta`（kind: reasoning），档位随通道是 `'full'`
  'thinking-full': {
    events: [
      stepStart(MAIN, 1, 1),
      assistant(MAIN, 'm1', 1, 1, [{ type: 'reasoning', text: '先看配置，再看入口。' }]),
      stepStart(MAIN, 1, 2),
      assistant(MAIN, 'm2', 1, 2, [{ type: 'text', text: '看完了。' }]),
    ],
    tapLines: [
      tapChunk({ type: 'block-start', index: 0, blockType: 'reasoning' }),
      tapChunk({ type: 'reasoning-delta', index: 0, text: '先看配置，' }),
      tapChunk({ type: 'reasoning-delta', index: 0, text: '再看入口。' }),
      tapChunk({ type: 'block-start', index: 0, blockType: 'text' }, MAIN, 'att-2', 1, 2),
      tapChunk({ type: 'text-delta', index: 0, text: '看完' }, MAIN, 'att-2', 1, 2),
      tapChunk({ type: 'text-delta', index: 0, text: '了。' }, MAIN, 'att-2', 1, 2),
    ],
  },
  'tool-shell': {
    events: [
      stepStart(MAIN, 1, 1),
      sessionEvent('tool/call', { callId: 'call_read', name: 'read', arguments: '{"path":"notes.txt"}' }),
      sessionEvent('tool/result', {
        message: { toolCallId: 'call_read', content: [{ type: 'text', text: '3 lines' }], isError: false },
        meta: { lines: 3 },
      }),
      stepStart(MAIN, 1, 2),
      assistant(MAIN, 'm2', 1, 2, [{ type: 'text', text: '读完了。' }]),
    ],
  },
  // 派发工具调用的 `callId` 必须与子任务记录的 `parentCallId` 同值——子任务桥（§2.8）靠它连起两套 id
  subagent: {
    events: [
      stepStart(MAIN, 1, 1),
      sessionEvent('tool/call', { callId: TASK_CALL, name: 'subagent', arguments: '{"task":"count lines"}' }),
      // 顶层 method（不是 session.event）：身份在 params.subagentId
      { method: 'subagent.started', params: { childSessionId: TASK_ID, subagentId: TASK_ID } },
      // 子会话自己的往返：params.sessionId 用子任务身份（与 subagentId 同值）
      stepStart(TASK_ID, 1, 1),
      assistant(TASK_ID, 'c1', 1, 1, [{ type: 'text', text: '3 lines' }]),
      // 终态两格合读：ok + completed ⇒ completed（映射表见 message.ts:305-311）
      {
        method: 'subagent.finished',
        params: { childSessionId: TASK_ID, subagentId: TASK_ID, status: 'ok', stopReason: 'completed' },
      },
      stepStart(MAIN, 1, 2),
      assistant(MAIN, 'm2', 1, 2, [{ type: 'text', text: '数完了。' }]),
    ],
    // 子会话增量：sid 直接写子任务身份（非占位）——门闸必须等 subagent.started 投影之后才放行，
    // 放早了 `sessionIdProfileSubagent` 不认它 ⇒ 会挤进主会话载体（守卫见 index.test.ts）
    tapLines: [tapChunk({ type: 'text-delta', index: 0, text: '3 ' }, TASK_ID), tapChunk({ type: 'text-delta', index: 0, text: 'lines' }, TASK_ID)],
  },
};

/** 跑一个场景：注入假 SDK → 跑一次真实运行路径 → 收三个回调的产物 */
async function runScenario(scenario: { events: readonly unknown[]; tapLines?: readonly unknown[] }): Promise<ConformanceProduct> {
  const configHome = mkdtempSync(join(tmpdir(), 'dsh-conformance-'));
  const recorder = createRecorder();
  setAgentRuntimeForTesting({
    sdkModule: { [DSH_PACKAGE_NAME]: createFakeDshSdk({ recorder, events: scenario.events, tapLines: scenario.tapLines }) },
  });
  const messages: AgentMessage[] = [];
  const subagents: SubagentRecord[] = [];
  const agentEvents: AgentEvent[] = [];
  try {
    const outcome = await dshProvider.run(
      createRunInput({
        configHome,
        onMessage: (message) => messages.push(message),
        onSubagent: (record) => subagents.push(record),
        onEvent: collectEvents(agentEvents),
      }),
    );
    return {
      messages,
      subagents,
      environment: null,
      /**
       * 行级事件**如实收**（2026-10-09）：`onEvent` 本来就在收（`agentEvents`），原先只是不往外给、
       * 产物里恒填 `events: []` ⇒ 套件的 §2.12（增量通道隔离）在这家**永远不可能红**。
       * dsh 的增量是**自造伪通知**走的消息支，最需要这条判据：分流一旦写错（伪通知落进 `log` 兜底），
       * 一次运行几百条就会把「原始输出」面板刷满。
       */
      events: agentEvents,
      usage: {
        // 计量那一格留空：`assistant/message.data.usage` 的字段名未实测核对，
        // 按「没采到记 null」处理，**不拿猜出来的数**填（计量配对判据因此在这一家部分空转）
        tokens: null,
        turns: outcome.turns ?? null,
        subagentTokens: outcome.subagentTokens ?? null,
        subagentTurns: outcome.subagentTurns ?? null,
      },
      result: { ok: outcome.ok, finalText: outcome.finalText },
    };
  } finally {
    removeTreeWithRetry(configHome);
  }
}

const products: Record<string, ConformanceProduct> = {};
for (const [name, scenario] of Object.entries(SCENARIOS)) {
  products[name] = await runScenario(scenario);
}
setAgentRuntimeForTesting(null);

describeProviderConformance({
  kind: dshProvider.kind,
  capability: dshProvider.metadata.messageCapability,
  scenarios: {
    'plain-reply': () => products['plain-reply']!,
    'thinking-full': () => products['thinking-full']!,
    'tool-shell': () => products['tool-shell']!,
    subagent: () => products['subagent']!,
  },
  /**
   * 喂了增量帧的场景必须钉住事件条数（套件 §2.12）：三条各自**实测**得来。
   * `subagent` 比另两个场景大得多，因为它含子会话自己的往返与 `subagent.started` / `finished`
   * 两条投影——把 `events.ts` 的增量排除分支删回去，这三个数会当场变大（守卫因此有区分力）。
   */
  expectedEventCounts: { 'plain-reply': 6, 'thinking-full': 9, subagent: 14 },
});
