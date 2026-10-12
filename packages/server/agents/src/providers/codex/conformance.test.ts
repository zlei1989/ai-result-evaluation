// @vitest-environment node
/**
 * codex 接入一致性套件（判据源见 `../conformance/kit.ts`）。
 *
 * 主体**只做接线**：把协议层的载荷（`AppServerNotificationPayload`）喂给本家的归一函数，
 * 收集成 `ConformanceProduct`；判据一律在套件里，不在本文件重复写。
 *
 * 为什么主体用「造载荷」而不是「起假 app-server」：套件验的是**归一产物**（消息 / 子任务 / 计量），
 * 传输与进程那一层由 `index.test.ts` 与真机冒烟管——两层不混。
 *
 * ⚠️ **两处例外，都是结构性的**：
 *   · **结构化输出探针不挂**（那一组对 codex 因此是空转）：消息级夹具看不到 `turn/start` 的**请求**，
 *     而探针的第一条判据正是「上报走了原生通道 ⇒ 请求里必须真有那份 schema」——在这里填
 *     `hasOutputSchema: true` 只能靠夹具自述。请求侧事实由 `index.test.ts` 的 `turn/start` 两态断言守，
 *     真机那一侧由 `providers/live-smoke.test.ts` 守。
 *   · **注入面的 MCP 那一格起真 run**（见 `runMcpInjectionScenario`）：请求侧事实（`thread/start` 的
 *     `config.mcp_servers`）只有假 app-server 在 RPC 期间记得下来，造 payload 到不了那一步。
 *     技能那一格仍够不着（清单来自 `skills/list` 的**响应**）⇒ 登记在 `injectionProofElsewhere`。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentEvent, AgentMessage, SubagentRecord, UsageTokens } from '@aieval/contracts';
import { createEventEmitter } from '../../emit';
import { createMessageAssembler } from '../../message';
import { collectEvents, createRunInput, createTurnState } from '../../testing/agent-fixtures';
import { removeTreeWithRetry } from '../../testing/cleanup';
import { describeProviderConformance, type ConformanceProduct, type LifecycleEvidence } from '../conformance/kit';
import { createFakeAppServer, type FakeAppServer } from './appserver-fixtures';
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
   * 行级事件**如实收**，且必须走**真实发射路径**（`createEventEmitter`）：投影出来的只是 draft，
   * `seq` 与 `at` 是发射时补的——直接收 draft 会造出一批形状残缺的事件，
   * 而事件形状正是契约管的东西（套件的 `checkEventShapes` 逐个校验）。
   * 收进来之后「增量的落点是内容块、不是事件」这条口径才有条数判据。
   */
  const events: AgentEvent[] = [];
  const emitter = createEventEmitter(collectEvents(events));
  for (const payload of payloads) {
    const projected = projectCodexMessages(payload, runState, CONTEXT);
    for (const draft of projected.drafts) assembler.ingest(draft, (message) => messages.push(message));
    subagents.push(...projected.subagents);
    const event = projectCodexEvent(payload, turnState, runState, { kind: 'codex', baseUrl: 'https://gw.example.com/v1', mainThreadId: MAIN });
    for (const draft of event.projection.drafts) emitter.emit(draft);
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

/** 一条 MCP 启动状态通知：`ready` 是这一家的「装上了」档（订阅早于 `thread/start`，故能进流） */
const MCP_READY = {
  method: 'mcpServer/startupStatus/updated',
  params: { threadId: MAIN, name: 'probe', status: 'ready', error: null, failureReason: null },
};

/** 请求侧：假 app-server 记下的 `thread/start` 参数里那份 MCP 配置（夹具手搓不出来的那一半） */
function mcpSentOf(server: FakeAppServer): unknown {
  const start = server.stats.requests.find((one) => one.method === 'thread/start');
  const config = (start?.params as Record<string, unknown> | undefined)?.['config'];
  return (config as Record<string, unknown> | undefined)?.['mcp_servers'] ?? null;
}

/**
 * 注入面的 MCP 场景：**起真 run**（不是造 payload）——见文件头那条例外。
 * 判据要的两份事实在这里同时拿得到：请求侧读假 app-server 的 RPC 台账，
 * 厂商侧读它投回来的 `mcpServer/startupStatus/updated`。
 */
async function runMcpInjectionScenario(): Promise<ConformanceProduct> {
  const configHome = mkdtempSync(join(tmpdir(), 'codex-conformance-'));
  const server = createFakeAppServer({
    emitOnRequest: { 'thread/start': [MCP_READY] },
    respond: MINIMAL_RESPOND,
  });
  const originalHooks = codexProvider.runtimeHooks;
  codexProvider.runtimeHooks = { resolveBinary: () => 'C:/fake/codex.exe', createClient: () => server.client };
  const messages: AgentMessage[] = [];
  const subagents: SubagentRecord[] = [];
  const events: AgentEvent[] = [];
  try {
    const running = codexProvider.run(
      createRunInput({
        configHome,
        mcpServers: { probe: { transport: 'stdio', enabled: true, command: 'node', args: ['echo.mjs'] } },
        onMessage: (message) => messages.push(message),
        onSubagent: (record) => subagents.push(record),
        onEvent: collectEvents(events),
      }),
    );
    // 订阅是在 `thread/start` / `turn/start` 返回**之后**建立的 ⇒ 终态必须之后手动投递
    await new Promise((resolve) => setTimeout(resolve, 0));
    server.emit('turn/completed', { threadId: server.threadId, turn: { id: server.turnId, items: [], status: 'completed' } });
    const outcome = await running;
    return {
      messages,
      subagents,
      events,
      usage: { tokens: null, turns: outcome.turns, subagentTokens: null, subagentTurns: null },
      result: { ok: outcome.ok, finalText: outcome.finalText },
      injectionProbe: { mcpSent: mcpSentOf(server) },
    };
  } finally {
    codexProvider.runtimeHooks = originalHooks;
    removeTreeWithRetry(configHome);
  }
}

/** 取数面的最小应答（收尾取数会问这三个方法；两个真 run 的场景共用） */
const MINIMAL_RESPOND = {
  'thread/list': () => ({ data: [], nextCursor: null }),
  'thread/read': () => ({ thread: { id: MAIN, turns: [] } }),
  'thread/items/list': () => ({ data: [], nextCursor: null }),
};

/**
 * 生命周期观测：正常收尾与中途取消各跑一次**真 run**，数假 app-server 的关闭次数。
 *
 * 取消那一格判「有没有终结在途轮次」的证据是 `turn/interrupt` 这条请求——
 * 正是它在真机上让在途轮次停下来（结论是 `canceled` 而不是失败）。
 */
async function observeLifecycle(): Promise<LifecycleEvidence> {
  const configHome = mkdtempSync(join(tmpdir(), 'codex-lifecycle-'));
  const originalHooks = codexProvider.runtimeHooks;
  const hooks = (server: FakeAppServer) => ({
    resolveBinary: () => 'C:/fake/codex.exe',
    createClient: () => server.client,
  });
  try {
    // ① 正常收尾：释放恰好一次
    const runServer = createFakeAppServer({ respond: MINIMAL_RESPOND });
    codexProvider.runtimeHooks = hooks(runServer);
    const run = codexProvider.run(createRunInput({ configHome }));
    // 订阅是在 `thread/start` / `turn/start` 返回**之后**建立的 ⇒ 终态必须之后手动投递
    await new Promise((resolve) => setTimeout(resolve, 0));
    runServer.emit('turn/completed', {
      threadId: runServer.threadId,
      turn: { id: runServer.turnId, items: [], status: 'completed' },
    });
    await run;
    const disposeAfterRun = runServer.stats.closeCount;

    // ② 中途取消：挂住不产终态，abort 之后立刻收场
    const cancelServer = createFakeAppServer({ hangUntilTerminal: true, respond: MINIMAL_RESPOND });
    codexProvider.runtimeHooks = hooks(cancelServer);
    const controller = new AbortController();
    const running = codexProvider.run(createRunInput({ configHome, signal: controller.signal }));
    await Promise.resolve();
    controller.abort();
    await running;
    return {
      disposeAfterRun,
      disposeAfterCancel: cancelServer.stats.closeCount,
      canceledMidTurn: cancelServer.stats.requests.some((one) => one.method === 'turn/interrupt'),
    };
  } finally {
    codexProvider.runtimeHooks = originalHooks;
    removeTreeWithRetry(configHome);
  }
}

const mcpInjectionProduct = await runMcpInjectionScenario();

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
    /** 注入面的 MCP 那一格：**起真 run**（见文件头与 `runMcpInjectionScenario`），产物在模块加载期建好 */
    'mcp-injection': () => mcpInjectionProduct,
  },
  injection: codexProvider.metadata.injection,
  injectionProof: { mcp: 'mcp-injection' },
  injectionProofElsewhere: { skills: 'packages/server/agents/src/providers/codex/skills.test.ts' },
  cancelMidTurn: codexProvider.metadata.capability.cancelMidTurn,
  lifecycle: observeLifecycle,
});
