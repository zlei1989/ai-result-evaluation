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
  runPiConformanceRow,
  writeSkillSource,
  type PiConformanceRun,
} from '../../testing/pi-conformance-fixture';
import {
  describeProviderConformance,
  type ConformanceProduct,
  type ConformanceScenarioName,
} from '../conformance/kit';
import { piProvider } from './index';
import { piRequestToolNames } from './observer';
import { PI_STRUCTURED_OUTPUT_TOOL } from './structured-output';

/** 技能源目录的临时根：物化是「读源、写目标」，源在 run 之后就没用了，跑完即删 */
const skillRoots: string[] = [];

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
} satisfies Partial<Record<ConformanceScenarioName, PiConformanceRun>>;

/** 场景名 → 产物（套件的取值器） */
const PRODUCTS: Partial<Record<ConformanceScenarioName, ConformanceProduct>> = Object.fromEntries(
  Object.entries(SCENARIOS).map(([name, product]) => [name, product.product]),
);

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
