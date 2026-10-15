// @vitest-environment node
/**
 * pi 接入一致性套件（判据源见 `../conformance/kit.ts`）。
 *
 * 与三家同形：**run 级测试台**——每个场景真跑一次 `piProvider.run`，产物收齐后把同步取值器交给套件。
 * 差别只在厂商那一端怎么假：pi 的注入面判据落在**出站请求**上（技能段、MCP 工具名都只在请求里），
 * 所以这里用**可编排的假网关**（`../../testing/pi-conformance-fixture.ts`）而不是假 SDK——
 * 真包自己发出来的那份请求体，是夹具手搓不出来的那一半。
 *
 * 三条容易踩空的地方：
 *   1. **`message_start` 必须带 `usage`**：pi 直接读它的 `input_tokens`，缺了整轮以厂商原文的
 *      `Cannot read properties of undefined` 收场。帧构造器已默认带上（见假件）。
 *   2. **增量帧不产行级事件**：`streamingDelta: yes` ⇒ 凡产物里有 `chunk === 'delta'` 的场景，
 *      `expectedEventCounts` 都得给。条数是**实测**的，不是估的——把它删掉，套件当场红。
 *   3. **有两个场景名在本家结构上造不出来**（`tool-plan` / `usage-missing`），
 *      理由逐条写在文件末——那两条不写，写了就是假产物。
 *
 * ⚠️ **子任务场景要改 `PI_CODING_AGENT_DIR`**：子智能体的会话目录走 SDK 的 `getAgentDir()`
 * （只认这个环境变量与 `~/.pi/agent`），而装载器的 `agentDir` 那一格**管不到它**。
 * 不改的代价是**每次跑测试都往开发者的真实 `~/.pi` 写一批子会话转写**——那是运行期的既成事实
 * （生产路径不许写 `process.env`，见 `providers/pi/subagents.ts`），但测试不该把它带进家目录。
 * 于是这里在场景开跑**之前**把变量指到临时目录，跑完还原。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { matchMcpToolName } from '@aieval/contracts';
import { afterAll, describe, expect, it } from 'vitest';
import { removeTreeWithRetry } from '../../testing/cleanup';
import {
  anthropicRedactedThinking,
  anthropicStreamError,
  anthropicToolUse,
  anthropicText,
  anthropicThinking,
  piMcpProbeServers,
  observePiCancelAt,
  observePiLifecycle,
  observePiRepairDisposal,
  runPiConformanceRow,
  writeSkillSource,
  type PiConformanceRun,
} from '../../testing/pi-conformance-fixture';
import {
  describeProviderConformance,
  type ConformanceProduct,
  type ConformanceScenarioName,
} from '../conformance/kit';
import { askUserProductDigest, askUserProductDigestExcludingTool } from '../conformance/ask-user';
import type { AskUserReply, AskUserRequest } from '../../types';
import { piProvider } from './index';
import { piRequestToolNames } from './observer';
import { PI_ASK_USER_TOOL } from './ask-user';
import { PI_STRUCTURED_OUTPUT_TOOL } from './structured-output';

/** 技能源目录的临时根：物化是「读源、写目标」，源在 run 之后就没用了，跑完即删 */
const skillRoots: string[] = [];

/** 一次提问的调用 id：**就是剧本里那次工具调用的 id**（答案按它回填进消息账本） */
const ASK_USER_CALL_ID = 'toolu_ask';

/** 带回调那一次收下的入参（`calls` 那一格判的正是「恰好一次」） */
const ASK_USER_REQUESTS: AskUserRequest[] = [];

/**
 * 这一次提问的答复（回调返回的那一份 = 编排层将来扮演的那一半）。
 *
 * ⚠️ 这里的 `answers` 用**契约形状**（`{header, selected, custom}`），与工具**入参**里那一问的
 * wire 形状（`question` 而不是 `prompt`）是两个域：答复那一侧从头到尾就是契约形状。
 *
 * 取**多选 + 自由输入并存**那一档（`selected` 与 `custom` 同时有值）：这一家把两半拼进同一段渲染
 * 文本，故这一条同时钉住「两半都没被丢掉」与「自由输入真的进得了模型看到的那段文本」。
 */
const ASK_CUSTOM_ANSWER = '方向二更合适';

const ASK_REPLY: AskUserReply = {
  outcome: 'answered',
  answers: [{ header: '选路径', selected: ['选项 A'], custom: ASK_CUSTOM_ANSWER }],
};

/**
 * 子智能体会话的落点（见文件头第 4 条）：设成临时目录，跑完删掉并还原变量。
 * 用 `PI_CODING_AGENT_DIR` 而不是别的路径，是因为它是 SDK **唯一**认的那一格。
 */
const subagentAgentDir = mkdtempSync(join(tmpdir(), 'pi-conformance-subagent-home-'));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = subagentAgentDir;

afterAll(() => {
  for (const root of skillRoots) removeTreeWithRetry(root);
  removeTreeWithRetry(subagentAgentDir);
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
});

/** 造一份技能源（`input.skills` 要的是「名字 + 源目录」，落进本行的是它的副本） */
function skillSource(name: string, body: string): { name: string; sourceDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'pi-conformance-skill-'));
  skillRoots.push(root);
  return writeSkillSource(root, name, body);
}

/**
 * 一个「到点就中止」的信号，给取消**场景**用（生命周期观测那条走的是假件的 `firstRequest`，
 * 翻得更准）。定时器随之解除引用（`unref`）——它只是夹具的输入，不该拖着进程不退出。
 *
 * 定时器落在装配完成之后（这一个文件在跑它之前已经跑过好几条场景，装配是热的），量到的是在途取消；
 * 真在冷机器上翻早了，那一轮会挂满释放兜底窗口才落定——产物形状不变（照样 `canceled`、`finalText`
 * 照样是 `null`），只是慢，判据不会因此翻面。
 */
function abortAfterMs(ms: number): AbortSignal {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms).unref();
  return controller.signal;
}

/**
 * 跑一行并把产物收齐（场景表在模块加载期逐条跑；`describeProviderConformance` 只吃同步取值器）。
 *
 * 所有场景共用一份提示词：它进的是**请求侧**，我们不判模型看懂了什么——每条的差别全在网关回的剧本上。
 */
async function run(options: Omit<Parameters<typeof runPiConformanceRow>[0], 'prompt'>): Promise<PiConformanceRun> {
  return runPiConformanceRow({ ...options, prompt: '按剧本收尾。' });
}

/**
 * 喂了增量帧的场景各自的事件条数（**实测**，不是估的）。
 *
 * 这一格是「增量不产事件」这条口径的**全部**判据：把 `events.ts` 的排除分支删回去，条数会当场
 * 变大。单独提出来是因为下面那条守卫要拿它与产物再对一次——声明漏了一格时，套件只在有人喂了
 * 增量帧的那一刻才红，而守卫在**任何**新增了增量帧的场景上都会红。
 */
const EXPECTED_EVENT_COUNTS = {
  'plain-reply': 15,
  // 与 `tool-shell` 同形（父会话两次往返 + 一次工具调用），多出来的那条是子智能体收场时
  // 扩展往父会话追加的那条记录（`entry_appended`）——子会话自己的事件**不进**父会话的事件流
  subagent: 27,
  'thinking-full': 15,
  'thinking-encrypted': 15,
  'tool-shell': 26,
  'tool-edit': 26,
  'usage-pair': 15,
  'env-vendor-system': 15,
  // 两轮往返 + 一次工具调用（与 `tool-shell` 同形）：结构化输出走工具通道，不是一段正文
  'structured-output': 26,
  'mcp-injection': 15,
  'skill-injection': 15,
  // 两轮往返 + 一次工具调用（与 `tool-shell` 同形）：这一问真的走了一件工具
  'ask-user': 26,
} as const;

/**
 * 评分通路要的那份 schema（形状与 `contracts` 的评分 schema 同族：根对象 + 必填标量 + 封闭对象）。
 * 单独提出来是因为它有两个消费点：场景喂给适配器的入参，以及请求侧判据比对的那一份——
 * 两处各写一遍的话，「出站的是不是原样」这条判据会退化成自己与自己比。
 */
const STRUCTURED_SCHEMA = {
  type: 'object',
  properties: { verdict: { type: 'string' } },
  required: ['verdict'],
  additionalProperties: false,
} as const;

const SCENARIOS = {
  /** 纯正文答复：`streamingDelta` 与 `finalText` 两条判据的基准场景 */
  'plain-reply': await run({ script: [anthropicText('没问题，工具已就绪。')] }),
  /** 思考正文全文（`textKind: 'full'`）：思考块与正文块各一段，两块都带增量帧 */
  'thinking-full': await run({ script: [anthropicThinking('先看配置，再看入口。', '看完了。')] }),
  /** 工具面两条通道：一个真被执行的工具调用 + 收尾答复（一次工具调用算两轮往返） */
  'tool-shell': await run({
    // 工具入参按 pi 内置 `bash` 的形状给：缺 `command` 会以工具错误收场，判据就变成空转了
    script: [anthropicToolUse('bash', { command: 'echo hi' }, 'toolu_shell'), anthropicText('命令跑完了。')],
  }),
  /**
   * MCP 注入：把一台**真**的 stdio 服务器交给装配面（换行分隔的 JSON-RPC，工具名 `echo`）。
   * 这一格的判据是两份事实互钉：请求侧看工具表里有没有 `mcp__probe__echo`，厂商侧看
   * `vendor-system` 的工具表（这一家没有「每台一张状态表」那种东西，工具面就是最硬的证据）。
   */
  'mcp-injection': await run({
    script: [anthropicText('MCP 接上了。')],
    mcpServers: piMcpProbeServers(),
  }),
  /** 技能注入：物化到本行的技能副本应出现在请求的系统段里（逐条 `<name>` 比对） */
  'skill-injection': await run({
    script: [anthropicText('技能已就位。')],
    skills: [skillSource('alpha', '示例技能正文。')],
  }),
  /** 工具面的第二条通道：写盘的入参形状与 `bash` 不同，tools 那一组要两条各自站得住 */
  'tool-edit': await run({
    script: [anthropicToolUse('write', { path: 'note.txt', content: 'hi' }, 'toolu_edit'), anthropicText('写完了。')],
  }),
  /** 密文思考（`textKind: 'none'`）：正文拿不到是契约里的合法形态，与 `full` 是两句不同的话 */
  'thinking-encrypted': await run({ script: [anthropicRedactedThinking('看完了。')] }),
  /** 用量齐全的一轮：两处都报，适配器按次累加（`reasoning` 是 `output` 的子集，不双计） */
  'usage-pair': await run({
    script: [anthropicText('计量齐了。', { start: { input_tokens: 12, output_tokens: 1 }, end: { output_tokens: 4 } })],
  }),
  /** 厂商系统事实：这一家的工具表与技能面都落在同一条 `vendor-system` 事件上 */
  'env-vendor-system': await run({ script: [anthropicText('环境事实见 vendor-system。')] }),
  /**
   * 评分通路：本次要了 schema，**走原生通道**——模型按剧本调用被 strict 约束的
   * `submit_result` 工具（参数就是那份 schema 的形状），适配器把参数投影回最终答复。
   *
   * 剧本因此是**两轮**：工具调用一轮、收尾正文一轮（与 `tool-shell` 同形）。
   * 只有一轮的话那是「模型没调工具」的姿态，测的是降级路径而不是原生通道。
   */
  'structured-output': await run({
    script: [
      anthropicToolUse(PI_STRUCTURED_OUTPUT_TOOL, { verdict: '还行' }, 'toolu_structured'),
      anthropicText('已提交。'),
    ],
    outputSchema: STRUCTURED_SCHEMA,
  }),
  /** 中途取消：厂商已开流就不再有下文，`abort()` 终结在途轮次 */
  cancel: await run({
    script: [anthropicText('半截')],
    hang: 'mid-stream',
    signal: abortAfterMs(200),
  }),
  /** 失败：厂商在流里报错（`prompt()` 永不抛，失败只体现在 `stopReason` / `errorMessage`） */
  failure: await run({ script: [[anthropicStreamError('conformance probe')]] }),
  /**
   * 子任务：模型先调 `Agent` 派一个子智能体，子智能体自己跑一轮模型往返，父会话再收尾。
   *
   * 三段剧本按**出站请求的顺序**取（见假件的剧本口径），与真实时序逐段对应：
   *   ① 父会话 → `Agent` 工具调用；
   *   ② **子会话** → 正文（子智能体继承父会话的模型与 runtime ⇒ 它打的是同一台假网关）；
   *   ③ 父会话 → 收尾正文。
   *
   * 这一格的产物里必须真有一条子任务行（`subagent` 声明 `yes` ⇒ 接入守卫按能力格反查这一格），
   * 而它的身份 / 状态 / 用量走的是扩展事件总线——**不是**从工具结果那句排版文本里解析出来的
   * （判据见本文件末那条专测）。
   */
  subagent: await run({
    script: [
      anthropicToolUse('Agent', {
        prompt: '只回一句话：子任务完成。',
        /**
         * 模型给这一行起的名字与 `description`（厂商侧的任务描述）**刻意不同**：两条通路各自
         * 取得到的那一份不同名，才判得出「收尾有没有拿描述把名字盖掉」——两者同值时那条判据是空转。
         */
        name: 'pong-agent',
        description: 'conformance subagent',
        subagent_type: 'general-purpose',
        // ⚠️ **必须显式 `false`**：这一格缺省是 `true`（派发即分离、工具立刻返回 ID），
        // 那样出站请求的次序就变成「父 → 父收尾 → 子」，剧本对不上，而子智能体还会活过本行
        // （已知的第三方缺陷：完成回调打在旧 ctx 上抛未处理拒绝）
        run_in_background: false,
      }, 'toolu_subagent'),
      anthropicText('子任务完成。'),
      anthropicText('派发完了。'),
    ],
  }),
  /**
   * 提问应答：模型调**我们注册的那件宿主工具**，答复经端口回到工具结果里。
   * 两臂（带回调 / 不传回调）都由本场景与 `ASK_USER_CONTROL` 跑，见上面那两段注释。
   */
  'ask-user': await run({
    script: askUserScript(),
    onAskUser: async (request) => {
      ASK_USER_REQUESTS.push(request);
      return ASK_REPLY;
    },
  }),
} satisfies Partial<Record<ConformanceScenarioName, PiConformanceRun>>;

/**
 * 提问应答场景：模型按剧本调**我们注册的那件宿主工具**，答复经提问端口回到工具结果里。
 *
 * 与另三家刻意不同的一处：这一家的 `answerFrame` **不是夹具装的**，就是那个工具 `execute` 的返回值
 * ——`content` 是模型读的那段文本、`details` 是界面看的结构化那一份（读法见 `askUserProduct`）。
 * 夹具扮演适配器那一格只能证「端口问得对」，而这一条连「模型真的调得到它」一起证了。
 *
 * ⚠️ 「那一问自己的等待预算」在这一家没有厂商侧来源（SDK 的工具面里没有任何超时），
 * 故请求里的 `vendorBudgetMs` 如实给 `null`——端口的缺省预算兜底。
 */

/** 一次工具调用的剧本：两轮往返（工具一轮、收尾正文一轮），只有一轮测不到这条通道 */
function askUserScript(): string[][] {
  return [
    anthropicToolUse(PI_ASK_USER_TOOL, {
      questions: [{
        header: '选路径',
        question: '用哪条路径？',
        options: [
          { label: '选项 A', description: '先做小的', recommended: true },
          { label: '选项 B', description: null, recommended: false },
        ],
        multiSelect: false,
        allowOther: true,
        secret: false,
      }],
    }, ASK_USER_CALL_ID),
    anthropicText('按选项 A 继续。'),
  ];
}

/**
 * 对照臂（不传回调）那一次运行：同一条夹具、同一份载荷，只去掉那一格回调。
 *
 * 工具表从**出站请求**读（`requestTools`）——「我们没注册」与「注册了但没声明出去」在产物里长得一样，
 * 只有请求侧分得开。这一臂里那一问会落成一条「工具不存在」的错误结果：那是 `host-tool` 档**自带**的
 * 差异，判据按通道分档处置（见 `../conformance/ask-user.ts` 的模块头）。
 */
const ASK_USER_CONTROL = await run({ script: askUserScript() });

/**
 * 对照臂里那一问拿到的工具结果原文（这一档自带的差异，抄进探针供人核对）。
 *
 * 读的是**工具结果消息块**的 `text`：`tool_execution_end` 的 `result.content` 在厂商那一层是不透明的，
 * 读它要重复一遍投影逻辑；而消息块正是本仓消费的那一份。工具压根没执行时给 `null`——判据据此红。
 */
function missingToolErrorOf(product: ConformanceProduct): string | null {
  const block = product.messages
    .flatMap((message) => message.blocks)
    .find((item) => item.type === 'tool-result' && item.callId === ASK_USER_CALL_ID);
  return block?.type === 'tool-result' ? block.text : null;
}

/**
 * 提问应答的探针：四格事实**各自从真源读**（判据见 `../conformance/ask-user.ts`）。
 *
 *   · `calls` / `requests` / `replies`：端口那一侧，两臂共用一份取数（对照臂不调回调，故只有一份）；
 *   · `answerFrame`：这一家的应答形状 = **工具结果本身**，从带回调那次的产物里按调用 id 找回来；
 *   · `control`：对照臂的指纹两格（原始 / 归一到同一形态）、出站工具表、以及那一问拿到的错误原文。
 */
function askUserProduct(): ConformanceProduct {
  const withCallback = SCENARIOS['ask-user'].product;
  const resultBlock = withCallback.messages
    .flatMap((message) => message.blocks)
    .find((block) => block.type === 'tool-result' && block.callId === ASK_USER_CALL_ID);
  return {
    ...withCallback,
    askUser: {
      calls: ASK_USER_REQUESTS.length,
      requests: [...ASK_USER_REQUESTS],
      replies: [ASK_REPLY],
      answerFrame: resultBlock ?? null,
      control: {
        calls: 0,
        reply: { outcome: 'unavailable', answers: null },
        digestWithCallback: askUserProductDigest(withCallback),
        digestWithoutCallback: askUserProductDigest(ASK_USER_CONTROL.product),
        digestWithCallbackExcludingAskTool: askUserProductDigestExcludingTool(withCallback, PI_ASK_USER_TOOL),
        digestWithoutCallbackExcludingAskTool: askUserProductDigestExcludingTool(ASK_USER_CONTROL.product, PI_ASK_USER_TOOL),
        missingToolError: missingToolErrorOf(ASK_USER_CONTROL.product),
        requestTools: ASK_USER_CONTROL.requestTools,
      },
    },
  };
}

/** 场景名 → 产物（套件的取值器） */
const PRODUCTS: Partial<Record<ConformanceScenarioName, ConformanceProduct>> = {
  ...Object.fromEntries(Object.entries(SCENARIOS).map(([name, product]) => [name, product.product])),
  'ask-user': askUserProduct(),
};

/**
 * 这一家**交给厂商的服务器名**（字面量）：MCP 场景里那一台，套件的逐名绑定与下面那条用例读同一份。
 *
 * 写成字面量而不是从夹具的配置对象里现读，是为了让判据**名字绑得上**：夹具给探针改个名而这里
 * 没跟，当场红（两边同一个来源的话改一处两边一起变，谁都不会红）。
 */
const INJECTED_MCP_SERVERS = ['probe'] as const;

describeProviderConformance({
  kind: piProvider.kind,
  capability: piProvider.metadata.messageCapability,
  injection: piProvider.metadata.injection,
  interaction: piProvider.metadata.interaction,
  /**
   * **人工消息面（第五组）的证明安排**（判据见 `../conformance/kit.ts` 的 `checkTurnInjectionNailing`
   * 与 `./onboarding.test.ts` 的驱动器真伪核对）。
   *
   * 投递两档的证据是**假 SDK 夹具**（`providers/pi/injection.test.ts`）：适配器一格端口都没挂，
   * 厂商侧的投递没被真机验过。续接是真路径（`testing/pi-session-fixture.ts`：真包装配 + 真会话管理器
   * + 真 JSONL 落盘，假网关只扮演上游模型）。
   */
  turnInjection: {
    capability: piProvider.metadata.turnInjection!,
    proofs: {
      'delivery.round': {
        driver: 'synthetic-fixture',
        observed: false,
        evidence: 'packages/server/agents/src/providers/pi/index.test.ts',
      },
      'delivery.idle': {
        driver: 'synthetic-fixture',
        observed: false,
        evidence: 'packages/server/agents/src/providers/pi/index.test.ts',
      },
      resume: {
        driver: 'real-path',
        observed: true,
        evidence: 'packages/server/agents/src/testing/pi-session-fixture.ts',
      },
    },
  },
  /**
   * **宿主注册的那件提问工具名**：`host-tool` 档的对照臂判据靠它认出「哪一件工具是这一格」。
   * 写成字面量而不是从适配器常量现读——两边同一个来源的话，改一处两边一起变、判据照样绿；
   * 与适配器那份对不上的表现是本文件里那条挂载守卫当场红。
   */
  askUserHostTool: 'ask_user_question',
  // 两格注入面都声明 `yes`：各自靠一条真场景证明（请求侧 + 厂商侧两份事实互钉）
  injectionProof: { mcp: 'mcp-injection', skills: 'skill-injection' },
  /**
   * **逐名绑定**：MCP 那一格的厂商侧判据不再是「工具表里有**某个** `mcp__*`」，而是
   * 「**我们交给厂商的每一台**都在表里」。
   *
   * 这里**故意独立写一遍**（不从夹具那份配置的键现读）：两边同一个来源的话，给探针服务器改个名
   * 两边一起变、套件照样绿——判据就白设了。改一处而另一处没跟 ⇒ 当场红。
   */
  injectedMcpServers: INJECTED_MCP_SERVERS,
  /**
   * **真出站证据**：这两份都走真包（厂商那一端只换成假网关，没有任何 SDK 假件），
   * 断言直接读网关收到的**请求体**。假件层看不见的那一类缺陷（白名单是成员匹配器、
   * `strict` 只在协议序列化之后才存在）只有这一条路拦得住。
   */
  realOutboundEvidence: [
    'packages/server/agents/src/providers/pi/allowlist.test.ts',
    'packages/server/agents/src/providers/pi/index.test.ts',
  ],
  cancelMidTurn: piProvider.metadata.capability.cancelMidTurn,
  /**
   * 生命周期：真包跑两次（一次正常收尾、一次在途取消），观测由假件数出来——
   * 释放与取消是**行为**，产物里没有它们的形状（见 `observePiLifecycle`）。
   */
  lifecycle: observePiLifecycle,
  /**
   * 场景 → 产物。键名**必须字面列出**：接入守卫（`../conformance/onboarding.test.ts`）静态读这一段源码，
   * 用循环/映射拼出来的名字它看不见。
   */
  scenarios: {
    'plain-reply': () => PRODUCTS['plain-reply']!,
    'thinking-full': () => PRODUCTS['thinking-full']!,
    'thinking-encrypted': () => PRODUCTS['thinking-encrypted']!,
    'tool-shell': () => PRODUCTS['tool-shell']!,
    'tool-edit': () => PRODUCTS['tool-edit']!,
    'usage-pair': () => PRODUCTS['usage-pair']!,
    'env-vendor-system': () => PRODUCTS['env-vendor-system']!,
    'structured-output': () => PRODUCTS['structured-output']!,
    cancel: () => PRODUCTS['cancel']!,
    failure: () => PRODUCTS['failure']!,
    'mcp-injection': () => PRODUCTS['mcp-injection']!,
    'skill-injection': () => PRODUCTS['skill-injection']!,
    'ask-user': () => PRODUCTS['ask-user']!,
    subagent: () => PRODUCTS['subagent']!,
  },
  /**
   * 这一格是「这些**具体身份**的状态是采到的」。子智能体的身份由扩展在运行期生成（随机 id），
   * 夹具写不出字面量 ⇒ 留空；「状态确实采到了」由本文件那条子任务专测钉（它读产物里的真实 id）。
   */
  observedStatusIds: [],
  expectedEventCounts: EXPECTED_EVENT_COUNTS,
  /**
   * 逐场景钉死答复。**失败与终止三格刻意钉 `null`**：那是「没采到」这一句归因，
   * 与「交了个空串」是两件事（空串会被「最终答复口径」当场拦下）。
   */
  expectedFinalText: {
    'plain-reply': '没问题，工具已就绪。',
    'thinking-full': '看完了。',
    'thinking-encrypted': '看完了。',
    'tool-shell': '命令跑完了。',
    'tool-edit': '写完了。',
    'usage-pair': '计量齐了。',
    'env-vendor-system': '环境事实见 vendor-system。',
    // 结构化输出：答复是**工具参数的投影**（缩进两格的人读形态），不是模型另外写的正文
    'structured-output': '{\n  "verdict": "还行"\n}',
    'mcp-injection': 'MCP 接上了。',
    'skill-injection': '技能已就位。',
    subagent: '派发完了。',
    cancel: null,
    failure: null,
  },
});

/**
 * 两个**结构上没有**的场景名，写在这里免得下一个人以为是漏了：
 *   · `tool-plan`：本家的工具集是 `read` / `bash` / `edit` / `write`（只读档是 `read` / `grep` /
 *     `find` / `ls`），**没有计划类工具** ⇒ 造一条叫 `tool-plan` 的场景只能拿别的工具冒充，
 *     那比不写更坏。`toolInput` 那一组已有 `tool-shell` 与 `tool-edit` 两条真证明；
 *   · `usage-missing`：厂商**恒**给一份用量对象（这一家的 SDK 在厂商没报时合成零值，成功路径与
 *     失败路径都一样）⇒ 造不出「厂商没报用量」的一行，写了就是假产物。
 */
describe('注入面探针挂载（pi）', () => {
  /**
   * 探针是本家唯一能回答「我们发出去什么」的那一半事实。没有这两条，把探针从场景里删掉只会让
   * 套件那一组变成空转——谁都不会红。
   */
  it('技能那一格：请求里逐条列出装入的技能，探针与厂商清单两侧都对得上', () => {
    const run = SCENARIOS['skill-injection'];
    expect(run.requests.length, '技能场景一次模型往返都没发出去，请求侧事实无从谈起').toBe(1);
    expect(run.requestSkills.map((skill) => skill.name)).toEqual(['alpha']);
    // 落点必须是**本行**物化出来的那一份（绝对路径 + 本仓的技能落点），不能是宿主技能目录
    expect(run.requestSkills[0]?.location).toMatch(/\/skills\/alpha\/SKILL\.md$/);
    expect(run.product.injectionProbe?.skillsInstalled).toEqual(['alpha']);
    const vendorSkills = run.product.events
      .filter((event) => event.type === 'vendor-system')
      .flatMap((event) => (event as { skills?: Array<{ name: string }> }).skills ?? []);
    expect(vendorSkills.map((skill) => skill.name), '厂商侧的技能清单也该有这一条').toContain('alpha');
  });

  it('MCP 那一格：探针如实反映真实出站请求里的 mcp__ 工具名', () => {
    const run = SCENARIOS['mcp-injection'];
    expect(run.requests.length, 'MCP 场景一次模型往返都没发出去').toBe(1);
    /**
     * 判据用**字面量**：夹具那一台服务器叫 `probe`、它自报的工具叫 `echo`（两处都在假件里），
     * 于是出站工具名只能是 `mcp__probe__echo`。它同时钉住三件事——注入真的生效、名字就是我们配的
     * 那台、以及探针交的确实是请求里那一份。
     *
     * ⚠️ **不许把判据写成「探针 == 从请求里现读的工具名」**：探针本身就是从同一个句柄现读的，
     * 那种写法是同一个表达式与自己做比较，对「注入整段没生效」一个字都不会说（恒真）。
     * 服务器改名时这一条也会红——那时要一并复核夹具与这条字面量，而不是让它静默换个名字。
     */
    expect(run.requestTools, '出站请求里没有我们那一台的工具：MCP 注入没生效或名字对不上').toContain('mcp__probe__echo');
    expect(
      run.product.injectionProbe?.mcpSent,
      '探针没交出 mcp__ 工具名：注入面只剩厂商侧那一份事实，互钉随之失去意义',
    ).toEqual(expect.arrayContaining(['mcp__probe__echo']));
    /**
     * **逐名绑定**：交给厂商的每一台都要在请求侧与厂商侧各有一份工具证据（套件那条判据的同一个
     * 匹配器，两种名字形态都认）。少了这一条，「工具表里有一个 `mcp__*`」就能冒充「我们那一台装上了」。
     */
    expect(run.product.injectionProbe?.mcpServerNames).toEqual([...INJECTED_MCP_SERVERS]);
    const vendorTools = run.product.events
      .filter((event) => event.type === 'vendor-system')
      .flatMap((event) => (event as { tools?: string[] }).tools ?? []);
    for (const name of INJECTED_MCP_SERVERS) {
      expect(matchMcpToolName(name, run.requestTools), `出站请求里没有「${name}」的工具`).not.toBeNull();
      expect(matchMcpToolName(name, vendorTools), `厂商侧工具表里没有「${name}」的工具`).not.toBeNull();
    }
  });
});

describe('增量帧的事件条数（pi）', () => {
  it('凡产物里有增量帧的场景都声明了条数，且与实测一致', () => {
    for (const [name, product] of Object.entries(PRODUCTS)) {
      const hasDelta = product!.messages.some((message) => message.chunk === 'delta');
      const declared = (EXPECTED_EVENT_COUNTS as Record<string, number | undefined>)[name];
      if (!hasDelta) continue;
      expect(declared, `${name} 产出了增量帧却没声明事件条数——增量不产事件这条口径失去判据`).toBeDefined();
      expect(product!.events.length, `${name} 的事件条数与声明不符`).toBe(declared);
    }
  });
});

describe('结构化输出探针挂载（pi）', () => {
  it('要了 schema 的场景挂了探针，两份事实都是「走了原生通道」', () => {
    const run = SCENARIOS['structured-output'];
    const probe = run.product.structuredOutput;
    expect(probe, '要了 schema 却没挂探针：套件那一组变成空转').toBeDefined();
    expect(probe?.nativeChannel, '工具参数就是这一轮的答复 ⇒ 上报走了原生通道').toBe(true);
    expect(probe?.hasOutputSchema, '上报走了原生通道，请求里却没有那份 schema').toBe(true);
    // 最终答复是**工具参数投影出来的那一份**（缩进两格），不是模型另外写的正文
    expect(JSON.parse(probe?.finalText ?? '')).toEqual({ verdict: '还行' });
  });

  /**
   * **判据的请求侧那一半**：上报走了原生通道 ⇒ 出站请求里真有那份 schema，而且是**原样**的。
   *
   * 两格各自对应一类缺陷：
   *   · `strict` 不是 `true` ⇒ 工具声明出去了但厂商侧没有任何强制（形状只是提示词级），
   *     而上报却写着「走了原生通道」——声明与事实不符；
   *   · `parameters` 与调用方给的那份不等 ⇒ 中途被改写 / 被预先算成 strict 形态
   *     （`makeStrictJsonSchema` 非幂等，预归一化会让第二轮请求零出站），
   *     而两种「值看起来差不多」的写法只有逐字段比对才分得开。
   */
  it('出站请求里那一件工具：strict 为真、parameters 就是调用方原 schema', () => {
    const run = SCENARIOS['structured-output'];
    const declaration = run.strictTool;
    expect(declaration, '要了 schema 却没在请求里找到那一件工具——声明与上报不符').not.toBeNull();
    expect(declaration?.strict, '工具声明没有开厂商侧强制').toBe(true);
    expect(declaration?.parameters).toEqual(STRUCTURED_SCHEMA);
    // 工具声明在**每一个**出站请求上（这一件是装配期就定好的，不是某一轮的临时插件）
    expect(run.requests.length, '结构化输出那一轮至少要有一次出站请求').toBeGreaterThan(0);
    for (const request of run.requests) {
      expect(piRequestToolNames(request.body)).toContain(PI_STRUCTURED_OUTPUT_TOOL);
    }
  });
});

describe('生命周期：取消（pi）', () => {
  /**
   * 两条相位都要看：厂商**连响应头都没来**（在等首个字节）与**已经开流**（正文还没吐完）。
   * 两处都必须毫秒级终结在途轮次、且恰好释放一次——这就是能力格声明 `cancelMidTurn: true` 的内容。
   *
   * 翻转信号的时机是「厂商收到请求」（见假件的 `firstRequest`），不是一个墙钟延时：延时在冷启动下
   * 会翻在装配还没跑完的时候，那时停止信号拦不住这一轮，量到的就是 5 秒兜底而不是取消。
   * 那条时序边界（早于起手的停止信号 ⇒ 照常发一轮、等满兜底）是**能力边界**，写在假件的注释里。
   */
  it('在途取消毫秒级终结轮次，两条相位都恰好释放一次', async () => {
    for (const hang of ['mid-stream', 'no-headers'] as const) {
      const canceled = await observePiCancelAt(hang);
      expect(canceled.canceledMidTurn, `${hang}：取消没有终结在途轮次`).toBe(true);
      expect(canceled.disposes, `${hang}：取消之后必须恰好释放一次`).toBe(1);
      expect(canceled.exitReason, `${hang}：取消的结论是「被终止」，不是失败`).toBe('canceled');
    }
  }, 60_000);
});

describe('失败姿态（pi）', () => {
  it('厂商在流里报错 ⇒ 结论为假、答复交 null 而不是空串、错误可见', () => {
    const run = SCENARIOS.failure;
    expect(run.outcome.ok).toBe(false);
    expect(run.outcome.finalText, '失败场景也不许交空串').toBeNull();
    expect(run.product.events.some((event) => event.type === 'error'), '失败没有任何可见归因').toBe(true);
  });
});

/**
 * **应答帧挂载守卫**：这一问的答复真的装进了这家应答形状的那一帧吗。
 * 没有这条，把 `answerFrame` 那一格删掉只会让套件那一组变成空转——谁都不会红。
 */
describe('应答帧挂载（pi）', () => {
  it('宿主工具的返回值带着答复（content 是模型看的、details 是界面看的）', () => {
    const probe = PRODUCTS['ask-user']?.askUser;
    expect(probe).toBeDefined();
    expect(probe?.requests[0]?.toolName).toBe('ask_user_question');
    // 这一家没有厂商侧等待预算（SDK 的工具面里没有超时）⇒ 只能是 null，端口用缺省预算兜底
    expect(probe?.requests[0]?.vendorBudgetMs).toBeNull();
    expect(probe?.calls).toBe(1);
    /**
     * 答复**逐字**进了那件工具的结果：`content` 是模型读的那段文本、`details` 是界面看的结构化那一份。
     * 两半都要在文本里——只查选项那一半时，自由输入被丢掉也不会有任何用例红。
     */
    expect(probe?.answerFrame).toMatchObject({
      text: expect.stringContaining('选项 A'),
      structured: { outcome: 'answered', answers: ASK_REPLY.answers },
      isError: false,
    });
    const rendered = (probe?.answerFrame as { text?: string } | undefined)?.text ?? '';
    expect(rendered).toContain(ASK_CUSTOM_ANSWER);
    expect(probe?.control.calls).toBe(0);
  });
});

describe('子任务正文（pi）', () => {
  /**
   * **真链路守卫**：真 SDK + 真扩展，子会话正文经 wire 通道进消息流——真扩展在 reload 里
   * claim `pi-subagents:manager` 注册表，适配器快照本行的条目、`subagents:started` 后订阅
   * **真子会话**的事件流（`subagent-wire.ts`）。`events.test.ts` 那一组钉的是投影逻辑
   * （读口是假的），这一条钉的是**两端真源对得上**——注册表挂载、`getRecord` 的 record
   * 形状、子会话 `subscribe` 的 this 绑定任何一侧漂移，这里当场红，症状是「子任务正文
   * 整行退回 session-file 来源」（wire 静默降级）或「子任务节点没有逐条对话记录」。
   * 转写文件（兜底通道）的路径公式由 `transcript.test.ts` 钉住；本场景 wire 生效时不读它。
   */
  it('subagent 场景的产物里有子任务自己的消息：带身份、wire 来源、自己的轮次、它自己说的正文', () => {
    const run = SCENARIOS.subagent;
    const rows = run.product.subagents;
    expect(rows.length, '子任务行一条都没投出来——先看派发那一刻那条通路').toBeGreaterThan(0);
    const agentId = rows[0]?.subagentId ?? '';
    const own = run.product.messages.filter((message) => message.subagentId === agentId);
    expect(
      own.length,
      '子任务自己的消息一条都没读到——wire 链路断了（注册表快照、订阅或排空任何一格），'
        + `子任务行有 ${rows.length} 条、身份 ${agentId}`,
    ).toBeGreaterThan(0);
    for (const message of own) {
      expect(message.source, '子任务正文必须标流式来源 wire（wire 不可用才退 session-file 补录）').toBe('wire');
      expect(message.roundTrip, '轮次必须是该子会话自己的往返序（从 1 起）').toBeGreaterThanOrEqual(1);
    }
    // 正文必须真是**它自己说的**那一段（剧本第 ② 段是子会话的答复），不是父会话内容的错挂
    const texts = own.flatMap((message) =>
      message.blocks.filter((block) => block.type === 'text').map((block) => (block as { text: string }).text));
    expect(texts.join('\n'), '子任务正文里找不到子会话的答复——读到的不是它自己说的').toContain('子任务完成');
  });

  /**
   * **子任务的逐字增量**（真链路）：子会话与主会话同构，`message_update` 的 `text_delta`
   * 经 wire 通道一路到消息流 ⇒ 子任务节点边产边长字，而不是整条憋到收尾才出现。
   *
   * 三条判据缺一不可，第三条是这条守卫的**要害**：
   *   · 真有 `chunk === 'delta'` 的子任务消息（通道通了）；
   *   · 增量与收尾快照落在**同一个载体**上（轮次归属对了，合并器才能把片段拼成完整块）；
   *   · **收尾快照带用量**——这一格才分得出「权威快照真到了」与「合并器收口凑的那条」。
   *     用量只在子会话的 `message_end` 上（增量一律 `usage: null`）⇒ 去重若退回「按载体」，
   *     先到的 delta 会占死键、权威快照被整条丢掉，而合并器的 `sealOpen` 仍会按累积值
   *     补发一条 `chunk: 'snapshot'`——**chunk 与 mergeKey 都长得一样，只有用量是空的**。
   *     只看 chunk 的守卫会在那一档静默放过（实测过：变异后本条的前两格全绿）。
   */
  it('子任务正文带逐字增量，且带用量的权威收尾快照没有被增量挡掉', () => {
    const run = SCENARIOS.subagent;
    const agentId = run.product.subagents[0]?.subagentId ?? '';
    const own = run.product.messages.filter((message) => message.subagentId === agentId);
    const deltas = own.filter((message) => message.chunk === 'delta');
    const snapshots = own.filter((message) => message.chunk === 'snapshot');
    expect(deltas.length, '子任务一条逐字增量都没有——wire 的 message_update 那一支没进缓冲').toBeGreaterThan(0);
    expect(snapshots.length, '子任务没有收尾快照').toBeGreaterThan(0);
    // 增量与快照落在**同一个载体**上：合并器靠它把逐字片段拼成完整块
    const deltaKeys = new Set(deltas.map((message) => message.mergeKey));
    expect(
      snapshots.some((message) => deltaKeys.has(message.mergeKey)),
      '增量与收尾快照不在同一个载体上——轮次归属算错了（增量该归「还没收尾的那一轮」）',
    ).toBe(true);
    /**
     * 权威那一条必须在：带用量的快照只可能来自子会话的 `message_end`。
     * 全是 `usage: null` 的快照 ⇒ 权威快照被去重吃掉了，账本里只剩合并器收口凑的那条。
     */
    expect(
      snapshots.some((message) => message.usage !== null),
      '子任务的收尾快照全都不带用量——权威快照被增量挡掉了（去重判据退回「按载体」），'
        + '账本里这条是合并器 sealOpen 按增量累积值补发的',
    ).toBe(true);
  });
});

/**
 * **修正轮的两条硬事实**（真包 + 假网关，产物与请求两侧同时取证）。
 *
 * 为什么单列一组而不是并进共享套件：pi 是四家里**唯一实现 `continue` 的 in-process 家**
 * （cc / codex 没有这一格、dsh 的每个区间共用同一份释放），这两条缺口只有它会踩到。
 */
describe('修正轮的预算与释放（pi）', () => {
  /**
   * 首答不合格 ⇒ 修正轮必须**跑满预算**。骨灰度修正循环每一轮都读**当前**活动区间的 `continue`
   * （`turn.ts` 的 `askAgain = handle?.continue`），而追问区间若不给自己这一格，预算会从 2 轮静默
   * 缩到 1 轮、并落一条「该适配器不支持同会话修正」——与事实相反（本家实现了它）。
   *
   * 判据取出站请求条数：1（首轮）+ 2（两轮修正）= 3。网关对越界请求复用最后一段剧本，
   * 所以三轮都拿到同一段非 JSON 正文。
   */
  it('首答不合格 ⇒ 修正轮跑满 2 轮（1 + 2 = 3 次出站请求），且不落「不支持同会话修正」', async () => {
    const run = await runPiConformanceRow({
      prompt: '按剧本收尾。',
      script: [anthropicText('这不是 JSON。')],
      outputSchema: STRUCTURED_SCHEMA,
    });
    expect(run.requests, '修正预算被静默缩水（1 + 1 = 2 次）').toHaveLength(3);
    const stderr = run.product.events
      .flatMap((event) => (event.type === 'log' && event.stream === 'stderr' ? [event.text] : []))
      .join('\n');
    expect(stderr, '修正轮真的跑不起来时才该出现这条').not.toContain('不支持同会话修正');
  }, 120_000);

  /**
   * **走过一次修正轮之后，会话仍恰好释放一次**。
   *
   * 骨架的释放闭包读的是「当时的活动区间」（`handle?.dispose()`），而修正轮是一次新的区间
   * ⇒ 追问区间若不共用首轮的释放入口，`session.dispose()` / `waitForIdle()` /
   * `subagentWire.dispose()` / provider 注销**一次都不会执行**（且不会有任何报错）。
   */
  it('走过一次修正轮之后，会话仍恰好释放一次', async () => {
    expect(await observePiRepairDisposal(), '修正轮之后整条释放链被跳过').toBe(1);
  }, 120_000);
});
