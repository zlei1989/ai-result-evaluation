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
 * ⚠️ **三处例外，都是结构性的**：
 *   · **结构化输出探针不挂**（那一组对 codex 因此是空转）：消息级夹具看不到 `turn/start` 的**请求**，
 *     而探针的第一条判据正是「上报走了原生通道 ⇒ 请求里必须真有那份 schema」——在这里填
 *     `hasOutputSchema: true` 只能靠夹具自述。请求侧事实由 `index.test.ts` 的 `turn/start` 两态断言守，
 *     真机那一侧由 `providers/live-smoke.test.ts` 守。
 *   · **注入面的 MCP 那一格起真 run**（见 `runMcpInjectionScenario`）：请求侧事实（`thread/start` 的
 *     `config.mcp_servers`）只有假 app-server 在 RPC 期间记得下来，造 payload 到不了那一步。
 *     技能那一格仍够不着（清单来自 `skills/list` 的**响应**）⇒ 登记在 `injectionProofElsewhere`。
 *   · **提问那一格走真路径**（见 `runAskUserScenario`）：真二进制起 app-server、厂商自己在运行期
 *     下发 `item/tool/requestUserInput`、我们回帧、厂商自己把它折成工具结果交给下一轮请求。
 *     请求侧事实（那一条工具结果的正文）只有假上游在 RPC 期间记得下来。夹具扮演端口那一条证不到这些。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  AgentEvent,
  AgentMessage,
  AskUserQuestion,
  SubagentRecord,
  UsageTokens,
} from '@aieval/contracts';
import { describe, expect, it } from 'vitest';
import { createEventEmitter } from '../../emit';
import { createMessageAssembler } from '../../message';
import { collectEvents, createRunInput, createTurnState } from '../../testing/agent-fixtures';
import { removeTreeWithRetry } from '../../testing/cleanup';
import {
  codexToolResultTextOf,
  codexVendorNoticesOf,
  runCodexRealPath,
  type CodexRealPathRun,
} from '../../testing/codex-real-path-fixture';
import { askUserProductDigest, askUserProductDigestExcludingNotices } from '../conformance/ask-user';
import { describeProviderConformance, type ConformanceProduct, type LifecycleEvidence } from '../conformance/kit';
import { createFakeAppServer, type FakeAppServer } from './appserver-fixtures';
import type { AskUserReply } from '../../types';
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

/**
 * 提问应答场景：**真路径**——真 `codex app-server` + 本机假 `/v1/responses` 上游，只把上游模型
 * 脚本化（它主动回一帧提问工具的 `function_call`）。于是这一条证的是厂商那一侧真的跑起来了：
 * 厂商自己在运行期下发 `item/tool/requestUserInput` ⇒ 我们的应答帧 ⇒ 真工具结果。
 * 「夹具扮演端口」那一档证不到这些（这一组判什么、不判什么写在判据模块头）。
 *
 * 通道与形状都来自探针的实跑读数（`probe/v11/REPORT.md` 的 AU-07 一节，本文件与驱动器按它写）：
 * 请求方法 `item/tool/requestUserInput`，判据落在厂商自己那两处原文上——**收场通知**
 * `serverRequest/resolved` 与**出站请求体里那份工具结果**（模型最终看到的那一份）。
 *
 * ⚠️ **声明仍是 `off-by-adapter`**：这一条证的是「通道通了、答复进得了厂商的工具结果」，
 * 而产品里那两件事（线程级打开提问工具、服务端请求回帧）还没有接——它们不在这一格之内。
 */
const ASK_TOOL_NAME = 'request_user_input';
const ASK_CALL_ID = 'call_ask_codex_1';

/**
 * 这一问的契约形状：厂商参数 → 契约那几格是**逐字**映过来的（`question` → `prompt`、
 * `isOther` → `allowOther`、`isSecret` → `secret`）；厂商没有的两格如实落 `false`——
 * 「哪一项推荐」与「能不能多选」都不在这一家的线上，编个默认值会让族载荷与判据一起说谎。
 *
 * **两题**：厂商按题目 `id` 配答案、契约按 `header` 配，两个键在这一次提问里必须各归各题——
 * 一题时「按 id 配」与「按序号配」结果相同，判据看不出区别。
 */
const ASK_QUESTIONS: AskUserQuestion[] = [
  {
    header: '选路径',
    prompt: '用哪条路径？',
    options: [
      { label: '选项 A', description: '快一点', recommended: false },
      { label: '选项 B', description: '慢一点但稳', recommended: false },
    ],
    multiSelect: false,
    allowOther: true,
    secret: false,
  },
  {
    header: '选范围',
    prompt: '改动范围到哪？',
    options: [
      { label: '只改入口', description: '不动别处', recommended: false },
      { label: '连测试一起', description: '顺手补测试', recommended: false },
    ],
    multiSelect: false,
    allowOther: true,
    secret: false,
  },
];

/** 那一帧提问工具调用的**厂商方言入参**（脚本式上游回的 `function_call` 用它，字段名逐字是厂商 schema） */
const ASK_FRAME_ARGS = {
  questions: [
    {
      id: 'q1',
      header: ASK_QUESTIONS[0]?.header,
      question: ASK_QUESTIONS[0]?.prompt,
      options: ASK_QUESTIONS[0]?.options.map((option) => ({
        label: option.label,
        description: option.description,
      })),
      isOther: true,
      isSecret: false,
    },
    {
      id: 'q2',
      header: ASK_QUESTIONS[1]?.header,
      question: ASK_QUESTIONS[1]?.prompt,
      options: ASK_QUESTIONS[1]?.options.map((option) => ({
        label: option.label,
        description: option.description,
      })),
      isOther: true,
      isSecret: false,
    },
  ],
};

/**
 * 答复里那句自由输入（弹层上写下、要一路进到厂商工具结果里的那句话）。
 * 这一家把标签与自由输入收进**同一个字符串数组**（`answers`），所以它证的是「两半都不丢」；
 * 「覆盖 / 并存分得开」那一档在这一家是**结构边界**（见 `ask-user.ts` 的说明），不在这里假装判得出来。
 */
const ASK_CUSTOM_ANSWER = '都不对，走第三条路';

/**
 * 那一次提问的答复：两题**按与题面相反的次序**给（`选范围` 在前、`选路径` 在后）。
 * 按序号配对的家会把两份答案互换——这一条就是那个缺陷的判据（契约的配对键是 `header`）。
 */
const ASK_REPLY: AskUserReply = {
  outcome: 'answered',
  answers: [
    { header: '选范围', selected: ['连测试一起'], custom: null },
    { header: '选路径', selected: [], custom: ASK_CUSTOM_ANSWER },
  ],
};

const ASK_FINAL_TEXT = '问完了。';

/** 两臂的运行结果（判据要两臂，故各跑一次；剧本同一条，只差回调那一格） */
async function runAskUserScenario(): Promise<{
  product: ConformanceProduct;
  withCallback: CodexRealPathRun;
  controlRun: CodexRealPathRun;
}> {
  const frame = { callId: ASK_CALL_ID, toolName: ASK_TOOL_NAME, args: ASK_FRAME_ARGS };
  const withCallback = await runCodexRealPath({ frame, finalText: ASK_FINAL_TEXT, onAskUser: async () => ASK_REPLY });
  const control = await runCodexRealPath({ frame, finalText: ASK_FINAL_TEXT, onAskUser: undefined });
  /**
   * 厂商自己投的那几条通知（本仓对未识别通知的落点是抄原文，于是它们的进出都进产物）。
   * 两臂对比必须点名它们，否则指纹会红在一些与提问无关的地方——档的语义与判据见
   * `AskUserProbe.control.askSwitchNotices`。
   *
   * 这一家**全部记成 `volatile`**：厂商用的是**同一条 `warning` 通道**——它既投「Under-development
   * features enabled: …」（那一条确实由提问开关带来），也投「Model metadata … not found」这类
   * 与开关无关的过路消息，后者两臂都可能出现。按 `switch-only` 记会把这条判据挂在厂商的投递节奏上
   * （假红）；「开关这一臂确实多投了那条」由下面那条用例按**正文**单独钉住。
   */
  const noticesOf = (run: CodexRealPathRun): Set<string> => new Set(codexVendorNoticesOf(run));
  const withNotices = noticesOf(withCallback);
  const withoutNotices = noticesOf(control);
  const noticeArms = Object.fromEntries(
    [...new Set([...withNotices, ...withoutNotices])].map((method) => [
      method,
      { withCallback: withNotices.has(method), withoutCallback: withoutNotices.has(method) },
    ]),
  );
  const askSwitchNotices = Object.fromEntries(
    Object.keys(noticeArms).map((method) => [method, 'volatile' as const]),
  );
  return {
    withCallback,
    controlRun: control,
    product: {
      ...withCallback.product,
      /**
       * 产品化之后的坦白：厂商侧那几条通知两臂不同，故两臂的**原始**指纹也不同；登记之后判据
       * 换成的四条（见判据模块）比「逐字相同」更硬，不是放宽。
       */
      askUser: {
        calls: withCallback.askCalls,
        requests: withCallback.requests,
        replies: [ASK_REPLY],
        answerFrame: withCallback.answerFrames[0] ?? null,
        control: {
          calls: control.askCalls,
          /**
           * 对照臂没有应答面 ⇒ 骨架的提问端口**立即**给「无人应答」（不挂起、不打日志）。
           * 真路径下没有夹具去调端口，故这一格按那条契约事实填；它由 `ask-user.test.ts` 的
           * 「没传回调 ⇒ 立即无人应答」那条用例在包内钉住。
           */
          reply: { outcome: 'unavailable', answers: null },
          digestWithCallback: askUserProductDigest(withCallback.product),
          digestWithoutCallback: askUserProductDigest(control.product),
          askSwitchNotices,
          noticeArms,
          /**
           * 归一那一格**同时**抹两处：点名的那几条厂商通知（见 `askSwitchNotices`），以及**提问那一半**
           * 在账本里的那一条调用——挂上应答面才会问人，对照臂压根没有那一问，故它是这一档自带的差异
           * （两处都由 `askUserProductDigestExcludingNotices` 一个函数算）。除这两处之外每一个字节
           * 照旧参与比对。
           */
          digestWithCallbackExcludingAskTool: askUserProductDigestExcludingNotices(
            withCallback.product,
            Object.keys(askSwitchNotices),
            [ASK_TOOL_NAME],
          ),
          digestWithoutCallbackExcludingAskTool: askUserProductDigestExcludingNotices(
            control.product,
            Object.keys(askSwitchNotices),
            [ASK_TOOL_NAME],
          ),
        },
      },
    },
  };
}

const mcpInjectionProduct = await runMcpInjectionScenario();
const askUser = await runAskUserScenario();
const askUserProduct = askUser.product;
/** 真路径那一次运行本身（请求侧与工具结果那两条判据读它，产物里读不到） */
const askUserRun = askUser.withCallback;
/** 对照臂那一次运行（两臂的差异类判据读它） */
const askUserControlRun = askUser.controlRun;

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
    'ask-user': () => askUserProduct,
  },
  injection: codexProvider.metadata.injection,
  interaction: codexProvider.metadata.interaction,
  /**
   * **人工消息面（第五组）的证明安排**（判据见 `../conformance/kit.ts` 的 `checkTurnInjectionNailing`
   * 与 `./onboarding.test.ts` 的驱动器真伪核对）。
   *
   * 投递两档的证据是**假 wire 夹具**（`providers/codex/turn-injection.test.ts`：假端口 + 假 wire，
   * 不 spawn 厂商）：真机读数只证到 wire 上存在这些方法，我们这条投递路径没被验过。
   * 续接是真路径（`testing/codex-resume-fixture.ts`：真二进制 → 真 app-server + 脚本式上游）。
   */
  turnInjection: {
    capability: codexProvider.metadata.turnInjection!,
    proofs: {
      'delivery.round': {
        driver: 'synthetic-fixture',
        observed: false,
        evidence: 'packages/server/agents/src/providers/codex/turn-injection.test.ts',
      },
      /**
       * `'idle'` 档走**真路径**：真 `codex app-server` 下厂商自己把条目撒成新一轮，
       * 哨兵文本进的是**厂商出站请求体**、那一轮跑完、它的答复成为本行 `finalText`
       * （驱动器 `testing/codex-injection-fixture.ts`，用例 `turn-injection-delivery.test.ts`；
       * 阴性对照是不挂注入面的同一套剧本）。
       */
      'delivery.idle': {
        driver: 'real-path',
        observed: true,
        evidence: 'packages/server/agents/src/testing/codex-injection-fixture.ts',
      },
      resume: {
        driver: 'real-path',
        observed: true,
        evidence: 'packages/server/agents/src/testing/codex-resume-fixture.ts',
      },
    },
  },
  /**
   * **真出站证据**：结构化输出那一格由 `structured-output-live.test.ts` 守（真二进制 + 本机假网关，
   * 读**出站请求体**的 `text.format`，含「不给 schema 就没有这个键」的阴性对照，进 CI）。
   */
  realOutboundEvidence: ['packages/server/agents/src/providers/codex/structured-output-live.test.ts'],
  /**
   * **工具面那一格的缺口如实登记**：`live-mcp.test.ts` 的本地转发器确实读得到请求体的工具表，
   * 但整份文件 `skipIf(!ENABLED)`（默认跳过、默认不进 CI）⇒ 它不算 CI 判据。
   * 结构化输出不再登记缺口（见上一条）。
   */
  realOutboundGaps: {
    mcp: 'packages/server/agents/src/providers/codex/live-mcp.test.ts',
  },
  injectionProof: { mcp: 'mcp-injection' },
  injectionProofElsewhere: { skills: 'packages/server/agents/src/providers/codex/skills.test.ts' },
  cancelMidTurn: codexProvider.metadata.capability.cancelMidTurn,
  lifecycle: observeLifecycle,
});

/**
 * **真路径守卫**：这一问是**厂商自己**下发的、答复真的按厂商形状写回去了、并且逐字进了模型看到的那份
 * 工具结果吗。没有这几条，把 `answerFrame` 或驱动器换回夹具扮演端口只会让套件那一组变成空转——
 * 谁都不会红。
 */
describe('提问真路径（codex）', () => {
  it('应答形状是厂商那条服务端请求的响应帧（答复逐字进了工具结果）', () => {
    const probe = askUserProduct.askUser;
    expect(probe).toBeDefined();
    expect(probe?.requests[0]?.toolName).toBe(ASK_TOOL_NAME);
    // 调用 id 就是厂商回给客户端的 `itemId`（两处同值，答案才配得上那次调用）
    expect(probe?.requests[0]?.callId).toBe(ASK_CALL_ID);
    // 厂商自己的等待预算今天没采到（`autoResolutionMs` 为 null）⇒ 如实 null，不猜一个数
    expect(probe?.requests[0]?.vendorBudgetMs).toBeNull();
    expect(probe?.calls).toBe(1);
    /**
     * **配对判据**：答案按 `header` 配到题、再按**该题自己的 id** 回帧。两份答案的次序与题面相反
     * （见 `ASK_REPLY`）⇒ 按序号配对的家在这里必然把 `选范围` 的答案挂到 `q1` 上。
     */
    expect(probe?.answerFrame).toEqual({
      answers: {
        q1: { answers: [ASK_CUSTOM_ANSWER] },
        q2: { answers: ['连测试一起'] },
      },
    });
    expect(probe?.control.calls).toBe(0);
  });

  it('厂商真的下发了提问请求，且答复逐字进了它交给模型的工具结果', () => {
    const run = askUserRun;
    expect(run.askRequests).toHaveLength(1);
    // 请求参数是厂商自己的形状：问题项按 `id` 配对、选项两格、根上两格等待语义
    const params = run.askRequests[0]?.params as Record<string, unknown>;
    expect(Object.keys(params).sort()).toEqual(
      ['autoResolutionMs', 'isBlocking', 'itemId', 'questions', 'threadId', 'turnId'].sort(),
    );
    expect((params['questions'] as Array<Record<string, unknown>>).map((one) => one['id'])).toEqual(['q1', 'q2']);
    /**
     * 那一条工具结果的正文（模型看到的最后一份，不经过本仓任何投影）：它是厂商把我们的应答帧折出来的，
     * 两题的答案各归各题就证明这条通道是闭合的。自由输入那一句与选项标签在这一家进的是**同一个字符串
     * 数组**（结构边界，见 `ask-user.ts` 的说明），故这里按两段**逐字**内容判，而不逐字比整串 JSON
     * （厂商那两格的键序不由本仓决定）。
     */
    const text = codexToolResultTextOf(run, ASK_CALL_ID) ?? '';
    expect(text).toContain(`"q1":{"answers":["${ASK_CUSTOM_ANSWER}"]}`);
    expect(text).toContain('"q2":{"answers":["连测试一起"]}');
    // 反向也要排掉：两题互换时 `q1` 那一格会拿到另一个答案（按序号配对的家正是这个症状）
    expect(text).not.toContain('"q1":{"answers":["连测试一起"]}');
  });

  it('不入应答面就不问：同一条剧本下对照臂一次都没调用，且把厂商自己那几条通知去掉之后两臂产物逐字相同', () => {
    const probe = askUserProduct.askUser;
    expect(probe?.control.calls).toBe(0);
    /**
     * 两臂的真产物**差一处**：提问那一半（`request_user_input` 那条调用）只在带回调那一臂里，
     * 因为对照臂连提问开关都没开、厂商压根不下发那条服务端请求。它在归一那一格里被归到同一形态
     * （见 `askUserProductDigestExcludingNotices` 的口径），故两臂指纹仍要逐字相同——判据在套件那一组
     * （`checkVendorSwitchNotices`）。
     *
     * 这里另外钉三条**驱动侧**事实，供人核对那一档不是空转：
     *   · 两臂的**原始**指纹确实不同；
     *   · 带回调那一臂的账本里真有提问那一半（对照臂没有）——套件那条账本判据读的就是它；
     *   · 归一之后两臂逐字相同。
     */
    /**
     * 提问那一半在账本里是**三个块**（同一次调用随消息快照多次投递），判据看的是**不同的调用 id**
     * ——用块条数判会把「同一条消息分几帧」读成「问了几遍」。
     */
    const askCallIds = (product: ConformanceProduct): string[] => [
      ...new Set(
        product.messages
          .flatMap((one) => one.blocks)
          .flatMap((block) => (block.type === 'tool-call' && block.family === 'ask-user' ? [block.callId] : [])),
      ),
    ];
    expect(askCallIds(askUserRun.product)).toEqual([ASK_CALL_ID]);
    expect(askCallIds(askUserControlRun.product)).toEqual([]);
    expect(probe?.control.digestWithoutCallback).not.toBe(probe?.control.digestWithCallback);
    expect(probe?.control.digestWithoutCallbackExcludingAskTool)
      .toBe(probe?.control.digestWithCallbackExcludingAskTool);
  });

  /**
   * 「开关真的到了厂商那一侧」的**直接证据**：厂商自己把「Under-development features enabled:
   * default_mode_request_user_input」这条原文投给开了开关的那一臂。两臂的产物指纹那一格记的是
   * `volatile`（同一条 `warning` 通道也投与开关无关的过路消息，按出现与否判会假红），
   * 故此地把那份**正文**单独钉住——它是「开关这一臂确实多投了那一条」的唯一客观读数。
   */
  it('开关那一臂：厂商自报「Under-development features enabled: default_mode_request_user_input」', () => {
    /**
     * 读法：读**厂商原文**（`vendorNotices`），不是产物——未识别通知的 `params` 在产品里被丢掉
     * （`protocol.ts` 的 `other` 只留方法名），拿走查过的那一份正文才是「开关真的到了厂商那一侧」的证据。
     */
    const textsOf = (run: CodexRealPathRun): string =>
      run.vendorNotices.map((notice) => JSON.stringify(notice.params ?? null)).join('\n');
    expect(textsOf(askUserRun)).toContain('Under-development features enabled: default_mode_request_user_input');
    expect(textsOf(askUserControlRun)).not.toContain('Under-development features enabled');
  });
});

