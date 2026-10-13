// @vitest-environment node
/**
 * dsh 接入一致性套件（判据源见 `../conformance/kit.ts`）。
 *
 * 与 claude 那份同形：走 **run 级测试台**（注入假 SDK 跑真实运行路径），模块加载期把各场景跑一次
 * 建好产物，再把同步取值器交给套件（理由见 `cc/conformance.test.ts` 的文件头）。
 *
 * 两条「看不见的匹配键」，错了会让判据红在完全误导性的位置：
 *   1. **`params.sessionId` 必须用 `DSH_SESSION_PLACEHOLDER`**（假件的会话号）。自造一个会让
 *      **整类会话事件被静默丢弃**：消息 0 条、`turns` 为 `null`、`finalText` 为 `null`，
 *      而工具那两组判据照样过（它们不看消息）⇒ 红在「思考块不存在」，看着像能力声明写错。
 *   2. **子任务事件是顶层 `method`**（`subagent.started` / `subagent.finished`），
 *      **不是** `session.event` 里的 `event.type`——`dshSubagentRecord` 读的是
 *      `readString(notification,'method')`（`message.ts:313-316`），身份取 `params.subagentId`
 *      （三级兜底 `subagentId` → `agentId` → `childSessionId`）。
 *
 * 本夹具**造正文/思考增量**（stream-tap 起）：`streamingDelta` 记 `'yes'`（source
 * `'hook'`）——增量经旁路文件进适配器（夹具的 `tapLines` 落到同一文件、同一时序），
 * 套件第 7 组「能力声明与产物互钉」据此要求 `plain-reply` 场景真出 delta 消息。
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  AgentEvent,
  AgentMessage,
  AskUserQuestion,
  McpServers,
  SubagentRecord,
} from '@aieval/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setAgentRuntimeForTesting } from '../../runtime';
import {
  collectEvents,
  createFakeDshSdk,
  createRecorder,
  createRunInput,
  DSH_SESSION_PLACEHOLDER,
  settleWithFakeTimers,
} from '../../testing/agent-fixtures';
import { removeTreeWithRetry } from '../../testing/cleanup';
import { dshToolResultTextOf, runDshRealPath, type DshRealPathRun } from '../../testing/dsh-real-path-fixture';
import {
  askUserProductDigest,
  askUserProductDigestExcludingTool,
} from '../conformance/ask-user';
import { describeProviderConformance, type ConformanceProduct, type LifecycleEvidence } from '../conformance/kit';
import type { AskUserReply } from '../../types';
import { dshProvider, DSH_ROUTE_PATCH_RELATIVE_PATH } from './index';
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

/**
 * 一条 `assistant/message`。`usage` 是**子任务级用量的唯一来源**（`subagent.started` /
 * `finished` 都不带用量，适配器按 `sessionId` 把这一格累加到子任务名下）——子会话那条消息上
 * 给不给它，决定收尾那条快照是「带新事实的补全」还是「什么都不带的重发」。
 */
const assistant = (
  sessionId: string,
  id: string,
  turn: number,
  step: number,
  content: readonly unknown[],
  usage?: Record<string, unknown>,
): unknown => ({
  method: 'session.event',
  params: {
    sessionId,
    event: {
      type: 'assistant/message',
      time: 1,
      data: { turn, step, message: { id, role: 'assistant', content }, ...(usage === undefined ? {} : { usage }) },
    },
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
 * 五个场景覆盖 dsh 能力声明里全部为 `yes` 的格：
 * `plain-reply` → 最终答复 + streamingDelta、`thinking-full` → thinkingText、
 * `tool-shell` → toolInput + toolResult、`subagent` → subagent；
 * `structured-output` 是评分通路：本次要了 schema，而这家**没有原生通道**——约束由适配器在
 * **首轮提示词**里补上（填充层），答复因此仍必须是可解析 JSON（探针与首轮提示词的守卫都在下面）。
 */
interface Scenario {
  events: readonly unknown[];
  tapLines?: readonly unknown[];
  /** 本次运行交给适配器的 JSON Schema；给它的场景才挂结构化输出探针 */
  outputSchema?: unknown;
  /** 探针里与答复逐字段比对的期望对象（键序不同不算不符） */
  expected?: unknown;
  /** 本次运行要下发的 MCP 服务器（canonical 形状）。**请求侧判据靠它**——不给就没有「发出去什么」可判 */
  mcpServers?: McpServers;
  /**
   * 本次运行是否**真的装一份技能**（物化到行配置目录）。
   * 技能面的两条事实缺一不可：落盘的那份与厂商报回的那份。
   */
  withSkills?: boolean;
}

/** 行配置目录下真的落了哪些技能副本（落点 `<configHome>/skills/<名称>/`；这家的 `DSH_HOME` 就是它） */
function readInstalledSkills(configHome: string): string[] {
  try {
    return readdirSync(join(configHome, 'skills'));
  } catch {
    return [];
  }
}

/**
 * 请求侧：per-launch overlay 里那几行 MCP 插件声明（`serverName:` 一行一台，由 `toDshMcpPluginLines` 写进去）。
 * 这一家**没有 SDK 参数那条通道**——注入口是 overlay 文件，所以请求侧事实只能从落点读。
 */
function overlayMcpServers(configHome: string): string[] {
  try {
    const text = readFileSync(join(configHome, DSH_ROUTE_PATCH_RELATIVE_PATH), 'utf8');
    return text.split('\n').filter((line) => line.includes('serverName:'));
  } catch {
    return [];
  }
}

/** 结构化输出场景的期望对象与其 JSON Schema（形状照评分通路的可移植子集） */
const JUDGE_OUTPUT = { judgments: [{ id: 'a', achieved: true }], verdict: '还行' };
const JUDGE_JSON = JSON.stringify(JUDGE_OUTPUT);
const JUDGE_SCHEMA = {
  type: 'object',
  properties: {
    judgments: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'string' }, achieved: { type: 'boolean' } },
        required: ['id', 'achieved'],
        additionalProperties: false,
      },
    },
    verdict: { type: 'string' },
  },
  required: ['judgments', 'verdict'],
  additionalProperties: false,
};

const SCENARIOS: Readonly<Record<string, Scenario>> = {
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
  // 派发工具调用的 `callId` 必须与子任务记录的 `parentCallId` 同值——子任务桥靠它连起两套 id
  subagent: {
    events: [
      stepStart(MAIN, 1, 1),
      sessionEvent('tool/call', { callId: TASK_CALL, name: 'subagent', arguments: '{"task":"count lines"}' }),
      // 顶层 method（不是 session.event）：身份在 params.subagentId
      { method: 'subagent.started', params: { childSessionId: TASK_ID, subagentId: TASK_ID } },
      // 子会话自己的往返：params.sessionId 用子任务身份（与 subagentId 同值）
      stepStart(TASK_ID, 1, 1),
      // 子会话自己的那次往返带用量：收尾那条完整快照因此真的有新事实可补
      assistant(TASK_ID, 'c1', 1, 1, [{ type: 'text', text: '3 lines' }], {
        inputTokens: 12,
        cacheReadTokens: 4,
        outputTokens: 3,
      }),
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
  /**
   * 评分通路：要了 schema、这家没有原生通道 ⇒ 适配器把约束追加进**首轮提示词**（填充层），
   * 模型一次就交出可解析 JSON（因此不触发修正轮，`recorder.prompt` 就是首轮提示词）。
   */
  'structured-output': {
    outputSchema: JUDGE_SCHEMA,
    expected: JUDGE_OUTPUT,
    events: [stepStart(MAIN, 1, 1), assistant(MAIN, 'm1', 1, 1, [{ type: 'text', text: JUDGE_JSON }])],
  },
  /**
   * 注入面两景，两条载荷都是这家**独有**的形态：
   *   · MCP 走 `request/header` 的**工具表**——这家没有「每台一张状态表」那种东西，
   *     起不来时工具静默消失，所以工具表就是唯一判据；
   *   · 技能面走 `user/message` 的 `skill-catalog` 块（厂商把清单合成一条 user 消息塞进提示词）。
   *     它必须走显式分流：未识别的 `session.event` 会落成一条几十 KB 的原始 JSON 日志。
   */
  'mcp-injection': {
    mcpServers: { probe: { transport: 'stdio', enabled: true, command: 'node', args: ['echo.mjs'] } },
    events: [
      stepStart(MAIN, 1, 1),
      sessionEvent('request/header', { header: { tools: [{ name: 'Bash' }, { name: 'mcp__probe__echo' }] } }),
      assistant(MAIN, 'm1', 1, 1, [{ type: 'text', text: 'MCP 接上了。' }]),
    ],
  },
  'skill-injection': {
    withSkills: true,
    events: [
      stepStart(MAIN, 1, 1),
      sessionEvent('user/message', {
        source: { kind: 'skill-catalog' },
        content: [{ type: 'text', text: '<available_skills>\n- `alpha`: 示例技能\n</available_skills>' }],
      }),
      assistant(MAIN, 'm1', 1, 1, [{ type: 'text', text: '技能已就位。' }]),
    ],
  },
};

/** 跑一个场景：注入假 SDK → 跑一次真实运行路径 → 收三个回调的产物 */
async function runScenario(scenario: Scenario): Promise<{ product: ConformanceProduct; prompt: string | null }> {
  const configHome = mkdtempSync(join(tmpdir(), 'dsh-conformance-'));
  /** 技能源目录另起一个临时根（与行配置目录分开，物化是「读源、写目标」两处） */
  const skillRoot = scenario.withSkills === true ? mkdtempSync(join(tmpdir(), 'dsh-conformance-skill-')) : null;
  let skills: { name: string; sourceDir: string }[] | undefined;
  if (skillRoot !== null) {
    const sourceDir = join(skillRoot, 'alpha');
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, 'SKILL.md'), '---\nname: alpha\ndescription: 示例\n---\n\n正文\n', 'utf8');
    skills = [{ name: 'alpha', sourceDir }];
  }
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
        ...(skills === undefined ? {} : { skills }),
        ...(scenario.mcpServers === undefined ? {} : { mcpServers: scenario.mcpServers }),
        ...(scenario.outputSchema === undefined ? {} : { outputSchema: scenario.outputSchema }),
        onMessage: (message) => messages.push(message),
        onSubagent: (record) => subagents.push(record),
        onEvent: collectEvents(agentEvents),
      }),
    );
    const product: ConformanceProduct = {
      messages,
      subagents,
      /**
       * 行级事件**如实收**：`onEvent` 本来就在收（`agentEvents`），不往外给的话、
       * 产物里恒填 `events: []` ⇒ 套件的增量隔离判据在这家**永远不可能红**。
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
      /**
       * 注入面探针（**请求侧**）：这一家的注入口是 overlay 文件，所以事实从落点读——
       * MCP 看插件行、技能看物化出来的副本目录。两者都不是夹具自述，
       * 缺了它「适配器没把入参写进 overlay」这一整类缺陷不会被任何判据发现。
       */
      injectionProbe: {
        mcpSent: overlayMcpServers(configHome),
        skillsInstalled: readInstalledSkills(configHome),
      },
      ...(scenario.outputSchema === undefined
        ? {}
        : {
          /**
           * 结构化输出探针：这家**没有原生 schema 通道**（约束只在提示词里），故两份布尔都是 `false`
           * ——`nativeChannel` 取本次运行上报的通道事实（`applied.structuredOutput` 恒 false），
           * `hasOutputSchema` 也必须是 false：「把 schema 写进提示词」不是「把 schema 发给厂商」。
           * 真正的下限由判据 2 兜住：答复仍必须可解析（`expected` 再判内容相符）。
           */
          structuredOutput: {
            nativeChannel: outcome.applied.structuredOutput,
            hasOutputSchema: false,
            finalText: outcome.finalText,
            ...(scenario.expected === undefined ? {} : { expected: scenario.expected }),
          },
        }),
    };
    return { product, prompt: recorder.prompt };
  } finally {
    removeTreeWithRetry(configHome);
    if (skillRoot !== null) removeTreeWithRetry(skillRoot);
  }
}

/**
 * 生命周期观测：正常收尾与中途取消各跑一次**真 run**，数假 SDK 的关闭次数。
 *
 * 取消那一格要**假定时器**：这一家没有 wire-level cancel，取消只能走释放的第二段
 * （`RELEASE_GRACE_MS` = 5 秒的兜底等待），真实计时器下这条用例要跑满 5 秒。
 * 观测到的 `canceledMidTurn` 因此恒 `false`——与它自己的声明一致（那一格对声明 `false` 的家
 * 没有区分力，它拦的是「声明 true 却做不到」）。
 */
async function observeLifecycle(): Promise<LifecycleEvidence> {
  const configHome = mkdtempSync(join(tmpdir(), 'dsh-lifecycle-'));
  try {
    // ① 正常收尾：释放恰好一次
    const runRecorder = createRecorder();
    setAgentRuntimeForTesting({
      sdkModule: {
        [DSH_PACKAGE_NAME]: createFakeDshSdk({
          recorder: runRecorder,
          events: [stepStart(MAIN, 1, 1), assistant(MAIN, 'm1', 1, 1, [{ type: 'text', text: '收尾。' }])],
        }),
      },
    });
    await dshProvider.run(createRunInput({ configHome }));
    const disposeAfterRun = runRecorder.closeCount;

    // ② 中途取消：interrupt 不被响应 ⇒ 等兜底那一段，释放仍然恰好一次
    vi.useFakeTimers();
    const cancelRecorder = createRecorder();
    const controller = new AbortController();
    setAgentRuntimeForTesting({
      sdkModule: { [DSH_PACKAGE_NAME]: createFakeDshSdk({ recorder: cancelRecorder, events: [], hang: true }) },
    });
    const running = dshProvider.run(createRunInput({ configHome, signal: controller.signal }));
    await vi.advanceTimersByTimeAsync(100);
    controller.abort();
    await settleWithFakeTimers(running, { stepMs: 1_000, steps: 10 });
    return {
      disposeAfterRun,
      disposeAfterCancel: cancelRecorder.closeCount,
      canceledMidTurn: false,
    };
  } finally {
    vi.useRealTimers();
    setAgentRuntimeForTesting(null);
    removeTreeWithRetry(configHome);
  }
}

/**
 * 提问应答场景：**真路径**——真 dsh 运行时 + 本机假 `/v1/messages` 上游 + 我们的应答者插件，
 * 只把上游模型脚本化（它主动回一帧提问工具的 `tool_use`）。于是这一条证的是厂商那一侧真的跑起来了：
 * 那一问真的进了厂商进程内的提问服务、真的沿 `user-questions/request` 派发到我们的应答者插件、
 * 答复真的变成厂商的工具结果。「夹具扮演端口」那一档证不到这些（这一组判什么、不判什么写在判据模块头）。
 *
 * 两臂只差**应答面那一格**：有回调那一臂由适配器挂上应答者（插件本体 + overlay 那一行），
 * 没有那一臂连插件文件都不落盘 ⇒ 那一问落到厂商自己那一档上（没挂应答面时等待档是定时档，
 * 到点交回它设计好的「待答」结果）。于是两臂的产物差一截——那一截由驱动器**实测 + 逐件点名**
 * 登记（`control.askResultTools`）。
 */
const ASK_TOOL_NAME = 'ask_user_question';
const ASK_CALL_ID = 'call_ask_dsh_1';

const ASK_QUESTIONS: AskUserQuestion[] = [
  {
    header: '选路径',
    prompt: '用哪条路径？',
    /**
     * `recommended` 与 `secret` 的 `false` 是**厂商侧的事实**：这一家的提问工具 schema 里没有
     * 「哪一项推荐」（它用「排首位 + label 带 (Recommended)」表达）、也没有「是不是密钥」。
     * `allowOther: true` 读的是**答复**形状：厂商的答复项恒带可选 `custom`
     * （源码逐字 `...answer.custom !== undefined ? { custom: answer.custom } : {}`，
     * README 同义：「supplements a multi-select answer or replaces a single-select choice」）。
     */
    options: [
      { label: '选项 A', description: '快一点', recommended: false },
      { label: '选项 B', description: '慢一点但稳', recommended: false },
    ],
    multiSelect: false,
    allowOther: true,
    secret: false,
  },
];

/** 那一帧提问工具调用的**厂商方言入参**（脚本式上游回的 `tool_use` 用它，字段名逐字是厂商 schema） */
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
    },
  ],
};

/** 弹层上写下、要一路进到厂商工具结果里的那句话（判据逐字比它） */
const ASK_CUSTOM_ANSWER = '都不对，走第三条路';

/**
 * 这一问的答复取**多选并存**那一档（`selected` 与 `custom` 同时有值，契约口径：多选时自由输入
 * 是补充项）。它一次钉住三件事——两个字段都不被丢掉、厂商那一侧确实把它们都念给了模型、
 * 以及厂商的答复项装得下这两半（一个 `selected[]` 加一个自定义格，不必另造形状）。
 * 只给选项的答复证不到后两件（`selected` 本来就到得了），故这一格刻意取并存档。
 */
const ASK_REPLY: AskUserReply = {
  outcome: 'answered',
  answers: [{ header: '选路径', selected: ['选项 A'], custom: ASK_CUSTOM_ANSWER }],
};

const ASK_FINAL_TEXT = '问完了。';

/** 产品事件里那份**厂商工具表**（`vendor-system` 的 `tools` 数组）：请求侧事实在产物里的落点 */
function vendorToolsOf(product: ConformanceProduct): string[] {
  for (const event of product.events) {
    if (event['type'] !== 'vendor-system') continue;
    const tools = event['tools'];
    if (Array.isArray(tools)) return tools.map((name) => String(name));
  }
  return [];
}

/** 两臂的运行结果（判据要两臂，故各跑一次；剧本同一条，只差应答面那一格） */
async function runAskUserScenario(): Promise<{
  product: ConformanceProduct;
  withCallback: DshRealPathRun;
  control: DshRealPathRun;
}> {
  const frame = { callId: ASK_CALL_ID, toolName: ASK_TOOL_NAME, args: ASK_FRAME_ARGS };
  const withCallback = await runDshRealPath({ frame, finalText: ASK_FINAL_TEXT, onAskUser: async () => ASK_REPLY });
  const control = await runDshRealPath({ frame, finalText: ASK_FINAL_TEXT, onAskUser: undefined });
  const withTools = vendorToolsOf(withCallback.product);
  const withoutTools = vendorToolsOf(control.product);
  return {
    withCallback,
    control,
    product: {
      ...withCallback.product,
      askUser: {
        calls: withCallback.askCalls,
        requests: withCallback.requests,
        replies: [ASK_REPLY],
        answerFrame: withCallback.answerBatches[0] ?? null,
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
          digestWithCallbackExcludingAskTool: askUserProductDigestExcludingTool(withCallback.product, ASK_TOOL_NAME),
          digestWithoutCallbackExcludingAskTool: askUserProductDigestExcludingTool(control.product, ASK_TOOL_NAME),
          /**
           * 这一家的提问工具**两臂都在厂商工具表里**（工具由我们自己挂进 overlay，与应答面无关）
           * ⇒ 差异落在**那一次调用的结果**上，登记在 `askResultTools` 而不是 `askSurfaceTools`。
           */
          outboundToolsWithCallback: withTools,
          outboundToolsWithoutCallback: withoutTools,
          askResultTools: [ASK_TOOL_NAME],
        },
      },
    },
  };
}

const products: Record<string, ConformanceProduct> = {};
/** 每次运行交给 `run()` 的提示词（假 SDK 逐次覆盖 ⇒ 单轮场景里它就是首轮提示词） */
const prompts: Record<string, string | null> = {};
for (const [name, scenario] of Object.entries(SCENARIOS)) {
  const run = await runScenario(scenario);
  products[name] = run.product;
  prompts[name] = run.prompt;
}
const askUser = await runAskUserScenario();
products['ask-user'] = askUser.product;
/** 真路径那一次运行本身（请求侧与工具结果那两条判据读它，产物里读不到） */
const askUserRun = askUser.withCallback;
setAgentRuntimeForTesting(null);

describeProviderConformance({
  kind: dshProvider.kind,
  capability: dshProvider.metadata.messageCapability,
  injection: dshProvider.metadata.injection,
  interaction: dshProvider.metadata.interaction,
  /**
   * **真出站证据：两格都缺**（如实登记）。假件换掉了 SDK 模块，看不见真正打给模型的那份请求；
   * 这家**没有原生 schema 通道**（约束只追加进首轮提示词）⇒ 结构化输出那一格在产品上就不存在，
   * 「原 schema 逐字段相等」在这家没有落点。
   */
  realOutboundEvidence: [],
  realOutboundGaps: {
    mcp: 'packages/server/agents/src/providers/dsh/live-mcp.test.ts',
    'structured-output': 'packages/server/agents/src/providers/dsh/conformance.test.ts',
  },
  injectionProof: { mcp: 'mcp-injection', skills: 'skill-injection' },
  cancelMidTurn: dshProvider.metadata.capability.cancelMidTurn,
  lifecycle: observeLifecycle,
  scenarios: {
    'plain-reply': () => products['plain-reply']!,
    'thinking-full': () => products['thinking-full']!,
    'tool-shell': () => products['tool-shell']!,
    subagent: () => products['subagent']!,
    'structured-output': () => products['structured-output']!,
    'mcp-injection': () => products['mcp-injection']!,
    'skill-injection': () => products['skill-injection']!,
    'ask-user': () => products['ask-user']!,
  },
  /**
   * 喂了增量帧的场景必须钉住事件条数（一致性套件）：三条各自**实测**得来。
   * `subagent` 比另两个场景大得多，因为它含子会话自己的往返与 `subagent.started` / `finished`
   * 两条投影——把 `events.ts` 的增量排除分支删回去，这三个数会当场变大（守卫因此有区分力）。
   */
  /**
   * 事件条数**实测**（不是估的）：把增量排除分支删回去，条数会当场变大。
   *
   * `subagent` 那一格的两条 `usage` 事件来自**子会话**：子会话的 `assistant/message` 带
   * `data.usage`（真机形状），`assistant/message` 那一支把三元组无条件累进本行 ⇒ 每一次往返
   * 一条 `usage`。夹具若不给那一格用量，这一格就少了那两条，判据会把「真出站的那一份」判成错。
   */
  /**
   * 真路径那一格的事件条数也钉住：驱动器把「同一份累计计量快照的重复投送」折成一条之后，
   * 这个数是确定的（见 `testing/dsh-real-path-fixture.ts` 的文件头）。
   */
  expectedEventCounts: { 'plain-reply': 6, 'thinking-full': 9, subagent: 12, 'ask-user': 22 },
});

/**
 * 探针挂载守卫：这一家也能观测请求（假 SDK 交回每次 `run(prompt, options)` 的提示词），
 * 所以那份探针必须真的挂上、且两份事实都对得上。**没有这条，把探针从场景里删掉只会让套件那一组
 * 变成空转——谁都不会红**。
 *
 * 填充层的「请求事实」是**首轮提示词里有没有那段输出约束**：它不能进探针的 `hasOutputSchema`
 * （那一格问的是「schema 有没有发给厂商」，dsh 恒 false），故在这里单独钉。
 */
describe('结构化输出探针挂载（dsh）', () => {
  it('要了 schema ⇒ 首轮提示词带上「## 输出约束」，探针如实上报「没有原生通道」且答复可解析', () => {
    const probe = products['structured-output']?.structuredOutput;
    expect(probe).toBeDefined();
    expect(prompts['structured-output'], '首轮提示词里没有输出约束：填充层没把 schema 交代给模型').toContain('## 输出约束');
    expect(probe?.nativeChannel, 'dsh 没有原生 schema 通道：applied.structuredOutput 只能是 false').toBe(false);
    expect(probe?.hasOutputSchema, '把 schema 写进提示词不是「把 schema 发给厂商」').toBe(false);
    expect(probe?.finalText).toBe(JUDGE_JSON);
  });
});

/**
 * **真路径守卫**：这一问是**厂商自己**派发出来的、答复真的按厂商的应答形状交回去了、并且逐字进了
 * 模型看到的那份工具结果吗。没有这几条，把 `answerFrame` 或驱动器换回夹具扮演端口只会让套件那一组
 * 变成空转——谁都不会红。
 */
describe('提问真路径（dsh）', () => {
  it('应答形状是厂商应答者那一支（答案按题目 id 配对）', () => {
    const probe = products['ask-user']?.askUser;
    expect(probe).toBeDefined();
    expect(probe?.requests[0]?.toolName).toBe(ASK_TOOL_NAME);
    // 调用 id 是厂商那一侧给的（`wait.callId`），答案按它配回那次调用
    expect(probe?.requests[0]?.callId).toBe(ASK_CALL_ID);
    // 进程内服务不带等待预算那一格 ⇒ 如实 null，不猜一个数
    expect(probe?.requests[0]?.vendorBudgetMs).toBeNull();
    /**
     * 问答面拿到的题面就是弹层画的那一份（同一份归一产物）：这一家的答复项恒带可选 `custom`
     * ⇒ `allowOther` 恒 true，弹层据此画出自由输入框（判据与另两处来源见 `tool-payload.ts`）。
     */
    expect(probe?.requests[0]?.questions[0]?.allowOther).toBe(true);
    expect(probe?.calls).toBe(1);
    // 多选并存：选项标签与自由输入各归各位（`custom` 为 null 时才不带那个键）
    expect(probe?.answerFrame).toEqual({ answers: [{ id: 'q1', selected: ['选项 A'], custom: ASK_CUSTOM_ANSWER }] });
    expect(probe?.control.calls).toBe(0);
  });

  it('应答者插件真的被厂商加载、那一问真的派发到了它手里', () => {
    const run = askUserRun;
    expect(run.pluginLoaded).not.toBeNull();
    // 相对名按 `<dshHome>` 根解析（与适配器的 stream-tap 同一条基准）
    expect(run.pluginLoaded?.url.endsWith('/aieval-ask-answerer.mjs')).toBe(true);
    expect(run.askRecords).toHaveLength(1);
    // 厂商的提问项形状：`id` / `question` / 选项两格；等待档这一行是本次装配自己的取值
    const question = run.askRecords[0]?.questions[0];
    expect(question?.id).toBe('q1');
    expect(question?.question).toBe(ASK_QUESTIONS[0]?.prompt);
    expect(question?.options?.map((option) => option.label)).toEqual(['选项 A', '选项 B']);
  });

  it('答复逐字进了厂商交给模型的工具结果（对照臂落厂商自己的「待答」档）', () => {
    // 两半都逐字出现在模型看到的工具结果里（厂商把结构化答复渲染成紧凑 JSON）
    expect(dshToolResultTextOf(askUserRun, ASK_CALL_ID))
      .toBe(`{"answers":[{"id":"q1","selected":["选项 A"],"custom":"${ASK_CUSTOM_ANSWER}"}]}`);
  });

  it('不入应答面就不问：对照臂一次都没调用，那一问落厂商自己那一档（定时档到点交回「待答」）', () => {
    const probe = products['ask-user']?.askUser;
    expect(probe?.control.calls).toBe(0);
    /**
     * 没有应答面时那一问的收场由**厂商那一档**决定：本行 overlay 的等待档随应答面派生
     * （没挂 ⇒ 定时档），到点交回的是厂商设计好的「待答」结果——不是夹具编的答案，也不是一次
     * 工具失败。它就是 `askResultTools` 登记的那一截差异。
     * 判据钉**哪一档**那两格（`pending` + `callId`）与厂商那句话的开头：
     * 整段 `pendingNotice` 是厂商的文案，逐字抄进本仓只会在它改字时制造一条与行为无关的红。
     */
    expect(askUser.control.askRecords).toHaveLength(0);
    const text = dshToolResultTextOf(askUser.control, ASK_CALL_ID) ?? '';
    expect(JSON.parse(text)).toMatchObject({ pending: true, callId: ASK_CALL_ID });
    expect(text).toContain('No answer batch arrived before the timeout');
  });
});
