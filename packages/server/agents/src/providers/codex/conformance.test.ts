// @vitest-environment node
/**
 * codex 接入一致性套件（判据源见 `../conformance/kit.ts`）。
 *
 * 这里**只做接线**：把协议层的载荷（`AppServerNotificationPayload`）喂给本家的归一函数，
 * 收集成 `ConformanceProduct`；判据一律在套件里，不在本文件重复写。
 *
 * 为什么用「造载荷」而不是「起假 app-server」：套件验的是**归一产物**（消息 / 子任务 / 计量），
 * 传输与进程那一层由 `index.test.ts` 与真机冒烟管——两层不混。
 */
import type { AgentMessage, SubagentRecord, UsageTokens } from '@aieval/contracts';
import { createMessageAssembler } from '../../message';
import { createTurnState } from '../../testing/agent-fixtures';
import { describeProviderConformance, type ConformanceProduct } from '../conformance/kit';
import { projectCodexEvent } from './events';
import { codexProvider } from './index';
import { projectCodexMessages } from './message';
import type { AppServerItem, AppServerNotificationPayload } from './appserver/protocol';
import { createCodexRunState, roundTripsOf } from './run-state';

const MAIN = 'thread-main';
const CHILD = 'thread-child';
const CONTEXT = { mainThreadId: MAIN };
const COMPLETED_AT_MS = 1_700_000_000_000;

function completed(
  item: AppServerItem,
  where: { threadId?: string; turnId?: string } = {},
): AppServerNotificationPayload {
  return {
    kind: 'itemCompleted',
    threadId: where.threadId ?? MAIN,
    turnId: where.turnId ?? 'turn-1',
    item,
    completedAtMs: COMPLETED_AT_MS,
  };
}

function delta(itemId: string, text: string): AppServerNotificationPayload {
  return { kind: 'agentMessageDelta', threadId: MAIN, turnId: 'turn-1', itemId, delta: text };
}

function tokenUsage(usage: { inputTokens: number; cachedInputTokens: number; outputTokens: number }): AppServerNotificationPayload {
  const tokens = {
    ...usage,
    cacheWriteInputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: usage.inputTokens + usage.outputTokens,
  };
  return { kind: 'tokenUsage', threadId: MAIN, usage: { total: tokens, last: tokens, modelContextWindow: null } };
}

/** 把一串载荷走一遍本家的归一，收集成套件要的产物 */
function product(payloads: readonly AppServerNotificationPayload[], options: { ok?: boolean } = {}): ConformanceProduct {
  const runState = createCodexRunState();
  const assembler = createMessageAssembler({ runId: 'run-codex-conformance' });
  /**
   * 行结果那一格（`finalText`）只在**事件投影**里写（`events.ts`），不在消息归一里
   * ⇒ 产物要同时走两条路，否则套件的「最终答复」判据拿不到被测对象（这正是它要拦的形状）。
   */
  const turnState = createTurnState();
  const messages: AgentMessage[] = [];
  const subagents: SubagentRecord[] = [];
  /**
   * 行级事件**如实收**：事件投影本来就在跑（`finalText` 由它写），把返回值丢掉、
   * 产物里恒填 `events: []` ⇒ 套件的增量隔离判据在这家**永远不可能红**。
   * 收进来之后「增量的落点是内容块、不是事件」这条口径才有条数判据。
   */
  const events: Array<Record<string, unknown>> = [];
  for (const payload of payloads) {
    const projected = projectCodexMessages(payload, runState, CONTEXT);
    for (const draft of projected.drafts) assembler.ingest(draft, (message) => messages.push(message));
    subagents.push(...projected.subagents);
    const event = projectCodexEvent(payload, turnState, runState, { kind: 'codex', baseUrl: 'https://gw.example.com/v1', mainThreadId: MAIN });
    events.push(...(event.projection.drafts as unknown as Array<Record<string, unknown>>));
  }
  // 用量走本家的累计快照（`usageByThread`），轮次走本家的计数（主线程 + 子线程各数各的）
  const snapshot = runState.usageByThread.get(MAIN);
  const tokens: UsageTokens | null =
    snapshot === undefined
      ? null
      : {
        input: snapshot.total.inputTokens - snapshot.total.cachedInputTokens,
        cached: snapshot.total.cachedInputTokens,
        output: snapshot.total.outputTokens,
        reasoningOutput: null,
        total: null,
      };
  const turns = roundTripsOf(runState, MAIN);
  return {
    messages,
    subagents,
    // codex 的 `vendor-system` 通道：app-server 不投送系统提示词，故这一组整组 not-exposed
    environment: null,
    events,
    usage: { tokens, turns: turns === 0 ? null : turns, subagentTokens: null, subagentTurns: null },
    result: { ok: options.ok ?? true, finalText: turnState.finalText },
  };
}

/** 子智能体场景：派发（协作工具调用）+ 子线程答复 */
const SUBAGENT_PAYLOADS: readonly AppServerNotificationPayload[] = [
  completed({
    kind: 'collabToolCall',
    id: 'call_spawn',
    tool: 'spawn_agent',
    status: 'completed',
    senderThreadId: MAIN,
    receiverThreadIds: [CHILD],
    prompt: 'review the page',
    agentsStates: [{ threadId: CHILD, status: 'completed', message: '看完了' }],
  }),
  completed({ kind: 'agentMessage', id: 'child-m1', text: '子线程答复', phase: null }, { threadId: CHILD, turnId: 'turn-c1' }),
];

describeProviderConformance({
  kind: codexProvider.kind,
  capability: codexProvider.metadata.messageCapability,
  observedStatusIds: [CHILD],
  /**
   * 期望值：钉住「哪条消息算最终答复」——`plain-reply` 取主线程答复；`subagent` 场景
   * **只有子线程说过话**，故主线程答复必须是 `null`（子线程的结论不许顶上来）；失败场景照样带答复。
   */
  expectedFinalText: {
    'plain-reply': '正在检查仓库。',
    subagent: null,
  },
  expectedEventCounts: { 'plain-reply': 1 },
  scenarios: {
    'plain-reply': () =>
      product([delta('m1', '正在'), completed({ kind: 'agentMessage', id: 'm1', text: '正在检查仓库。', phase: null })]),
    'thinking-full': () =>
      product([completed({ kind: 'reasoning', id: 'r1', summary: [], content: ['先读配置，再看入口。'] })]),
    'thinking-encrypted': () => product([completed({ kind: 'reasoning', id: 'r1', summary: [], content: [] })]),
    'tool-shell': () =>
      product([
        completed({
          kind: 'commandExecution',
          id: 'call_shell',
          command: 'npm run build',
          cwd: 'D:/repo',
          status: 'completed',
          output: 'built',
          exitCode: 0,
          durationMs: 1234,
        }),
      ]),
    subagent: () => product(SUBAGENT_PAYLOADS),
    'usage-pair': () =>
      product([
        tokenUsage({ inputTokens: 1000, cachedInputTokens: 900, outputTokens: 50 }),
        completed({ kind: 'agentMessage', id: 'm1', text: '答复', phase: null }),
      ]),
    failure: () =>
      product(
        [
          completed({ kind: 'agentMessage', id: 'm1', text: '答复', phase: null }),
          { kind: 'error', threadId: MAIN, message: 'unexpected status 500' },
        ],
        // 失败也算一次运行：`ok:false` 时 `finalText` 仍带它（排障要回答「它到底说了什么」）
        { ok: false },
      ),
  },
});
