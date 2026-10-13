/**
 * 新增智能体 SDK 的一致性套件。
 *
 * 为什么需要它：加一家 SDK 时各写一套 provider 测试的结果是**每家的判据都不一样**，
 * 于是「新那家漏了某条契约」不会被任何用例拦住。这里把**与厂商无关**的判据集中成一份，
 * 任何 provider 只要交出一个 `ConformanceFixture` 就必须全部通过。
 *
 * 分工（刻意如此）：
 *  · **形状**交给 `@aieval/contracts` 的 zod schema——schema 已是契约的机器可读形态，
 *    这里不重复写形状断言（两份必然漂移）；
 *  · **语义不变量**在这里：schema 表达不了的那些（合并键公式、能力声明与产物互钉、
 *    子任务桥、用量配对、缺失记账）。
 *
 * 结构：每条判据是一个**导出的纯函数**（不通过就抛），`describeProviderConformance` 只负责
 * 把它们注册成用例。这样套件自己也能被测——不然它只是一堆「看起来会拦」的断言。
 */
import {
  AgentEventSchema,
  AgentMessageSchema,
  InteractionCapabilitySchema,
  MessageCapabilitySchema,
  MessageSourceSchema,
  SubagentRecordSchema,
  matchMcpToolName,
  type AgentMessage,
  type InjectionCapability,
  type InteractionCapability,
  type MessageCapability,
  type MissingReason,
  type SubagentRecord,
  type UsageTokens,
} from '@aieval/contracts';
import { describe, it } from 'vitest';
import { carrierKeyOf } from '../../message';
import { checkAskUserLedger, checkAskUserProbe, type AskUserProbe } from './ask-user';
import { checkStructuredOutput, type StructuredOutputProbe } from './structured-output';
import { checkTransportDelivery, type TransportTranscript } from './transport';

/** 场景名：套件按能力声明挑它需要的那几个，缺了就是缺陷（见「能力互钉」） */
export type ConformanceScenarioName =
  | 'plain-reply'
  | 'thinking-full'
  | 'thinking-encrypted'
  | 'tool-shell'
  | 'tool-edit'
  | 'tool-plan'
  | 'subagent'
  | 'usage-pair'
  | 'usage-missing'
  | 'env-vendor-system'
  | 'structured-output'
  | 'cancel'
  | 'failure'
  /** 注入面：本次运行真的把 MCP server 下发给了厂商，且厂商侧收到了（服务表或工具表两台通道之一） */
  | 'mcp-injection'
  /** 注入面：本次运行真的物化了 skill 副本，且厂商侧报回了清单 */
  | 'skill-injection'
  /** 交互面：本次运行真的问了一次用户（回调被调用一次、答复能装进该家的应答帧、不传回调时产物逐字不变） */
  | 'ask-user';

/** 一次运行的归一产物：**这就是被测对象** */
export interface ConformanceProduct {
  messages: AgentMessage[];
  subagents: SubagentRecord[];
  /** 行级事件；形状由 `checkEventShapes` 逐个过契约 schema，这里只查类型与 `log` 的 `stream` */
  events: Array<Record<string, unknown>>;
  usage: {
    tokens: UsageTokens | null;
    turns: number | null;
    subagentTokens: UsageTokens | null;
    subagentTurns: number | null;
  };
  /** 行结果（最终答复与结论） */
  result: ConformanceRunResult;
  /**
   * **注入面探针**：能观测请求侧的 fixture 才给（判据见 `checkInjectionNailing`）。
   * 为什么不给就是缺陷：只判厂商侧事实会放过「适配器压根没把我们给的输入交给厂商」——
   * 那种情况下 MCP 一台都装不上，而套件全绿。
   */
  injectionProbe?: InjectionProbe;
  /**
   * 结构化输出（评分者通路）的探针：**能真观测到「schema 有没有发给厂商」的 fixture 才给**。
   *
   * 探针要同时交出两份事实：本次运行**上报**的通道事实（`nativeChannel`）与夹具在**请求侧**
   * 观测到的事实（`hasOutputSchema`）——判据是「上报走了原生通道 ⇒ 请求里必须真有那份 schema」。
   *
   * 为什么是可选而不是必填：消息级的 fixture（把协议载荷喂进归一函数那种）**看不到请求**，
   * 硬要它填这一格就只能自述「我带了 schema」——那是无区分力的假判据。给不出就不给，
   * 这一组对该家即为空转；真机那一侧由 `providers/live-smoke.test.ts` 的第 ⑥ 格守。
   */
  structuredOutput?: StructuredOutputProbe;
  /**
   * C 类（协议时序）笔迹：**能录到「谁先谁后」的 fixture 才给**（判据见 `./transport.ts`）。
   *
   * 为什么不写成 fixture 自述（「我缓冲了通知」）：自述谁都能填，是无区分力的假判据；
   * 能判的只有事件发生的先后这一事实。消息级的 fixture（直接喂载荷）通常录不到订阅与响应，
   * 给不出就不给——这一组对该家即为空转。
   */
  transport?: TransportTranscript;
  /**
   * **提问应答探针**：这一家的夹具在运行期真的问了一次用户，并把四格事实记下来
   * （判据见 `./ask-user.ts`）。
   *
   * 与上面三处探针同一条口径：事实必须由**运行**产生，不能由夹具自述。它证的是端口那一半
   * （回调恰好一次、入参形状、答复进得了该家的应答帧、不传回调时产物逐字不变）；适配器那一半
   * （厂商的提问请求真的到了手里、答复真的回到厂商）由各家的接线票接上，接上之后这一格的形状不变。
   */
  askUser?: AskUserProbe;
}

/**
 * **行结果**：一次运行交回给调用方的那两格（`AgentRunResult` 里与归一产物同源的部分）。
 *
 * 为什么单列一个判据组：评分通路只读 `finalText`——它是「智能体评分」这条产品
 * 通路的**唯一入口**。而在这条判据之前，「哪条消息算最终答复」只有各家自己的用例在管：
 * codex 在 app-server 重构里整体漏写了这一格，`providers/codex/*` 全绿、真机上评分智能体却
 * 永远拿不到答复（见 `docs/faq/codex.md` 的 `JUDGE_PARSE_FAILED` 条目）。
 * 一句话：**这是跨家契约，不是各家的实现细节**——所以它必须由套件统一钉，而不是各写一份。
 */
export interface ConformanceRunResult {
  /** 本次运行是否成功收尾。失败也算一次运行，故必填；失败时 `finalText` 允许为 `null` */
  ok: boolean;
  /**
   * 最终答复：**最后一次观察到的、主会话的、已收尾的非空答复正文**；没采到就是 `null`。
   * 三条口径：
   *   · 只取**主会话**（子线程的结论不算这一行的答复）；
   *   · 只认**已收尾**的答复（流式增量的半截正文不是答复）；
   *   · 没采到记 `null`，**绝不填空串**——调用方对两者给的是两句不同的归因。
   */
  finalText: string | null;
}

export interface ConformanceFixture {
  /** 这一家的 kind（报错文案里点名用） */
  kind: string;
  /** 本次运行的**消息层**能力声明 */
  capability: MessageCapability;
  /** 本家的**注入面**能力声明（MCP / skills）；判据见 `checkInjectionNailing` */
  injection: InjectionCapability;
  /**
   * 本家的**交互面**能力声明（今天只有提问那一格）；判据见 `checkInteractionNailing`。
   *
   * 为什么要在这里给一份：能力声明与产物互钉这条口径对交互面同样成立——声明「能问」的家必须拿得出
   * 一个能造出「问了一次」的场景，否则那句 `yes` 会腐烂成假话。给的是**这家 `metadata` 里那一份**，
   * 不是另写一份（两处独立写必然漂移）。
   */
  interaction: InteractionCapability;
  /** 注入面两格的**证明场景**（格 → 场景名）：声明 `yes` 的格靠它证明 */
  injectionProof: Partial<Record<'mcp' | 'skills', ConformanceScenarioName>>;
  /**
   * `mcp` 那格的**逐名绑定**：本次交给厂商的那几台服务器名（**字面量**，不是从夹具配置里现读的
   * 表达式）。声明后，厂商侧事实从「工具表里有**某个** `mcp__*`」收紧成「**每一台**都在表里」
   * （名字比对走 `@aieval/contracts` 的共享匹配器，厂商 sanitize 过的形态也认）。
   *
   * 为什么必须是**独立写下的字面量**：判据若与夹具配置同一个来源，给探针改个名两边一起变、
   * 套件照样绿——那正是「名字没绑上」的形态（与「拿探针与从同一个句柄现读的表达式自比」同一条
   * 理由）。两处独立写下，改一处就当场红。
   *
   * 不声明时退回「服务表非空或有 `mcp__*` 工具表」：厂商侧只投启动状态那几家（codex）没有工具面
   * 可绑，硬声明只会逼出一个假判据。
   */
  injectedMcpServers?: readonly string[];
  /**
   * 本夹具**结构上证明不了**的注入面格 → 它在哪一层被证明（**相对仓库根**的路径）。
   *
   * 为什么留这条路：消息级夹具（把协议载荷喂进归一函数那种）看不到 RPC 往返——codex 的技能清单
   * 来自 `skills/list` 的响应，在那一层造不出来；硬要它填个场景，填出来的只能是夹具自述。
   * 登记**不是免检**：接入守卫核对点名的文件真的存在，写一个不存在的路径比不写更糟。
   */
  injectionProofElsewhere?: Partial<Record<'mcp' | 'skills', string>>;
  /**
   * 这一家声明的「能不能中途取消」（`metadata.capability.cancelMidTurn`）。
   * 判据拿它与 `lifecycle()` 的**观测**对照：声明能、实际不能是这一层最该拦的假话。
   */
  cancelMidTurn: boolean;
  /** 生命周期观测（**异步**：要真跑两次运行、其中一次要中断）；判据见 `checkLifecycle` */
  lifecycle?: () => Promise<LifecycleEvidence>;
  /** 本夹具证明不了生命周期时 → 它在哪一层被证明（**相对仓库根**路径，接入守卫核对存在） */
  lifecycleElsewhere?: string;
  /** 场景 → 产物；可以只给一部分，套件按能力声明要求它必须有的那些 */
  scenarios: Partial<Record<ConformanceScenarioName, () => ConformanceProduct>>;
  /**
   * **真出站证据**：走真包（不是 `testing/*-fixture` 的假件）并从**真实请求体**取事实的用例文件
   * （**相对仓库根**的路径）。
   *
   * 为什么单列一格：上面每一组判据读的都是**产物**，而产物由夹具自己交——夹具在 SDK 边界上换假件时，
   * 「我们传了什么」看得见、「厂商拿它做了什么」看不见（白名单是成员匹配器，名字对不上就静默少一件
   * 工具；`strict` 那一格更是只在协议序列化之后才存在）。这类缺陷在假件层**结构上不可见**，
   * 只有真包 + 假网关那条路拦得住，故它的存在本身要成为判据。
   *
   * 判据由接入守卫核对（`./onboarding.test.ts`）：点名的文件必须存在、**不许**装假 SDK 模块、
   * 且断言里真读请求体捕获对象。写一个不存在的路径比不写更糟——那是把空转伪装成有判据。
   */
  realOutboundEvidence?: readonly string[];
  /**
   * 本家**结构上观测不到**真出站请求的那一格 → 为什么，以及真机那一侧由谁守。
   *
   * 与 `injectionProofElsewhere` 同一条口径：登记**不是免检**，接入守卫核对点名的文件存在。
   * 诚实登记优于硬凑一条读假件的用例——后者会让「这条通路通了」这件事永远没有人判。
   */
  realOutboundGaps?: Partial<Record<'mcp' | 'structured-output', string>>;
  /** 声明「这些行的 status 是**采到的**」，其余行的 `statusMissing` 必须非 `null` */
  observedStatusIds?: string[];
  /**
   * **宿主注册的提问工具名**（`askUserChannel === 'host-tool'` 的家必填）。
   *
   * 为什么要有这一格：那一档的对照运行里那件工具**按定义不存在**（「不问就不动」的落点就是不注册
   * 它），于是同一条剧本里的那一问必然落成一条「工具不存在」的错误结果——判据要能认出「哪一件工具
   * 是这一格」，才谈得上把那一格归一之后比对，以及判「对照臂的出站工具表里没有它」。
   * `vendor-tool` 档不给（厂商给的工具不是我们注册的，那一档也不许放宽）。
   */
  askUserHostTool?: string;
  /**
   * 场景期望的最终答复（缺省 = 不额外比对，只查下面那三条通则）。
   * 用途：把「这一家在这条路径上到底该给出什么」钉成字面量（例如「失败场景也不许交空串」）。
   */
  expectedFinalText?: Partial<Record<ConformanceScenarioName, string | null>>;
  /**
   * **喂了增量帧的场景**必须声明的事件条数（见 `checkDeltaChannelIsolation`）。
   * 这一格是「增量不产事件」这条口径的全部判据：没有它，把 `events.ts` 的分支删回去也不会红。
   */
  expectedEventCounts?: Partial<Record<ConformanceScenarioName, number>>;
}

/** 顺序固定的一对：能力格 → 它需要哪个场景来证明自己真的拿得到 */
const CAPABILITY_PROOF: ReadonlyArray<readonly [string, readonly ConformanceScenarioName[]]> = [
  ['thinkingText', ['thinking-full']],
  ['toolInput', ['tool-shell', 'tool-edit', 'tool-plan']],
  ['toolResult', ['tool-shell', 'tool-edit']],
  ['subagent', ['subagent']],
  ['streamingDelta', ['plain-reply']],
];

/**
 * 这份能力声明里声明 `yes` 的格，各自**需要哪一组场景**来证明（组内任一即可）。
 *
 * 为什么导出：套件运行时靠 `CAPABILITY_PROOF` 判「声明过的东西真的拿得到」，而接入守卫
 * （`./onboarding.test.ts`）要在**手上没有 fixture** 的时候判「新家交上来的 fixture 真的覆盖了
 * 它自己声明为 `yes` 的格」。两处引用的必须是同一张表——各写一份的话，接入期与运行期会各有
 * 各的「覆盖」定义，新家漏掉一整格时两边都以为对方在管。
 *
 * 空数组 = 这份声明没有 `yes` 格（全 `no` / `unverified` 也合法，只要按契约给出缺失原因）。
 */
export function capabilityProofGroups(capability: MessageCapability): Array<readonly ConformanceScenarioName[]> {
  const declaration = capability as unknown as Record<string, unknown>;
  const groups: Array<readonly ConformanceScenarioName[]> = [];
  for (const [cell, proofNames] of CAPABILITY_PROOF) {
    if (declaration[cell] === 'yes') groups.push(proofNames);
  }
  return groups;
}

/**
 * 交互面的同一张表（今天只有提问那一格）：能力格 → 它需要哪个场景来证明自己真的拿得到。
 *
 * 与 `CAPABILITY_PROOF` **分表**是刻意的：两组声明的取值域不同（这一组多两态：`not-projected-by-vendor`
 * / `no` 说的都是「厂商侧没有」），合成一张表会让「消息层能力」与「能不能问人」共用一套缺失原因。
 * 语义相同的那一条照旧：**声明 `yes` 就必须拿得出一个能造出该事实的场景**。
 */
const INTERACTION_PROOF: ReadonlyArray<readonly [string, readonly ConformanceScenarioName[]]> = [
  ['askUser', ['ask-user']],
];

/** 这份交互面声明里声明 `yes` 的格，各自**需要哪一组场景**来证明（组内任一即可）；口径同上一张表 */
export function interactionProofGroups(interaction: InteractionCapability): Array<readonly ConformanceScenarioName[]> {
  const declaration = interaction as unknown as Record<string, unknown>;
  const groups: Array<readonly ConformanceScenarioName[]> = [];
  for (const [cell, proofNames] of INTERACTION_PROOF) {
    if (declaration[cell] === 'yes') groups.push(proofNames);
  }
  return groups;
}

/** 能力五态 → 允许的缺失原因（对应关系） */
const REASON_BY_CAPABILITY: Record<string, readonly MissingReason[]> = {
  no: ['not-supported'],
  'not-projected-by-vendor': ['not-exposed'],
  'off-by-adapter': ['not-observed', 'unverified'],
  unverified: ['unverified'],
};

const SCENARIO_ENTRIES = (fixture: ConformanceFixture): Array<[ConformanceScenarioName, () => ConformanceProduct]> =>
  Object.entries(fixture.scenarios) as Array<[ConformanceScenarioName, () => ConformanceProduct]>;

/**
 * 合并键公式：`<subagentId ?? 'main'>|<roundTrip>|<role>|<parentCallId ?? '-'>`。
 * 真源是 `message.ts` 的 `carrierKeyOf`（账本里 `mergeKey` 那一格就是它的产出），
 * 这一格只是给跨家一致性套件一个读得通的名字——公式本身在这里不重写。
 */
export function mergeKeyOf(message: Pick<AgentMessage, 'subagentId' | 'roundTrip' | 'role' | 'parentCallId'>): string {
  return carrierKeyOf(message);
}

/**
 * 能力声明自身合规。zod 的 `superRefine` 已在 schema 层拦「yes 无 source / 非 yes 无 reason」
 * 以及交互面那两条（`yes` 必须拿真路径证明、`synthetic-fixture` 必须给出原因）。
 */
export function checkCapabilityDeclaration(fixture: ConformanceFixture): void {
  const parsed = MessageCapabilitySchema.safeParse(fixture.capability);
  if (!parsed.success) {
    throw new Error(`${fixture.kind} 的能力声明不合规：${JSON.stringify(parsed.error.issues)}`);
  }
}

/** 消息与子任务行过契约 schema（行级事件的形状另有 `checkEventShapes`） */
export function checkContracts(fixture: ConformanceFixture): void {
  for (const [name, build] of SCENARIO_ENTRIES(fixture)) {
    for (const message of build().messages) {
      const parsed = AgentMessageSchema.safeParse(message);
      if (!parsed.success) throw new Error(`${fixture.kind}/${name} 的消息不合规：${JSON.stringify(parsed.error.issues)}`);
    }
    for (const record of build().subagents) {
      const parsed = SubagentRecordSchema.safeParse(record);
      if (!parsed.success) throw new Error(`${fixture.kind}/${name} 的子任务行不合规：${JSON.stringify(parsed.error.issues)}`);
    }
  }
}

/** 合并键必须等于公式：信封里那一格是算好的，消费方不再自己拼 */
export function checkMergeKeys(fixture: ConformanceFixture): void {
  for (const [name, build] of SCENARIO_ENTRIES(fixture)) {
    for (const message of build().messages) {
      const expected = mergeKeyOf(message);
      if (message.mergeKey !== expected) {
        throw new Error(`${fixture.kind}/${name} 的合并键应为 ${expected}，实际 ${message.mergeKey}`);
      }
    }
  }
}

/** 子任务桥：`parentCallId` 指向真实工具调用，`parentSubagentId` 指向真实子任务或 null；状态与「是否采到」分开记 */
export function checkSubagentBridge(fixture: ConformanceFixture): void {
  for (const [name, build] of SCENARIO_ENTRIES(fixture)) {
    const product = build();
    const callIds = new Set(
      product.messages.flatMap((message) =>
        message.blocks.filter((block) => block.type === 'tool-call').map((block) => block.callId),
      ),
    );
    const subagentIds = new Set(product.subagents.map((record) => record.subagentId));
    for (const record of product.subagents) {
      if (record.parentCallId !== null && !callIds.has(record.parentCallId)) {
        throw new Error(`${fixture.kind}/${name}：子任务 ${record.subagentId} 的 parentCallId 没有对应的工具调用块`);
      }
      if (record.parentSubagentId !== null && !subagentIds.has(record.parentSubagentId)) {
        throw new Error(`${fixture.kind}/${name}：子任务 ${record.subagentId} 的 parentSubagentId 不是本轮的任一子任务`);
      }
      if (record.statusMissing !== null && record.status !== 'unknown') {
        throw new Error(`${fixture.kind}/${name}：子任务 ${record.subagentId} 未采到状态，status 必须是 unknown`);
      }
    }
    for (const id of fixture.observedStatusIds ?? []) {
      const record = product.subagents.find((one) => one.subagentId === id);
      if (record !== undefined && record.statusMissing !== null) {
        throw new Error(`${fixture.kind}/${name}：${id} 的状态声明为采到，却又给了 statusMissing`);
      }
    }
  }
}

/**
 * **子任务投递的折叠**：按 `subagentId` 让后到的投递整条覆盖先到的，顺序按首次出现。
 *
 * 为什么它必须住在套件里：契约明文允许同一身份多次投递（派发一条、收场一条，**后者是完整快照**），
 * 于是「产物里看到两条同身份记录」本身不是缺陷；真正要判的是**折叠之后**的形状。消费方
 * （`message-log.ts` 的 `foldSubagents`、界面 `build-model.ts` 的会话树）都是这么折的——
 * 折叠器与判据分家时，两边会各自定义一遍「同一条子任务」，而判据那一份必然先腐烂。
 *
 * 与 `foldMessages` 同一条纪律：覆盖**不是追加**（投递的那一条已是完整快照），
 * 顺序按首次出现（后续覆盖不该把这条在时间轴上的位置往后挪）。
 */
export function foldSubagentDeliveries(records: readonly SubagentRecord[]): SubagentRecord[] {
  const order: string[] = [];
  const latest = new Map<string, SubagentRecord>();
  for (const record of records) {
    if (!latest.has(record.subagentId)) order.push(record.subagentId);
    latest.set(record.subagentId, record);
  }
  return order.map((id) => latest.get(id)!);
}

/** 产物里**同一身份**的多次投递（顺序即到达顺序）；只投递过一次的给单元素数组 */
function deliveriesOf(product: ConformanceProduct, subagentId: string): SubagentRecord[] {
  return product.subagents.filter((record) => record.subagentId === subagentId);
}

/**
 * 「后到的快照不许丢事实」要比的那几格：子任务在**运行期真的会变**的那些事实。
 *
 * 不含 `status` / `statusMissing`：终态**就是**对 `running` 的覆盖，把它们算进来等于禁止收尾。
 * `subagentId` 是身份（同一个身份才有这条判据，它逐字相同）。
 */
const PRESERVED_SUBAGENT_FIELDS = ['name', 'kind', 'outcome', 'usage', 'parentCallId', 'parentSubagentId'] as const;

/** 两条投递带来的**事实**是否逐格相同（身份那一格不参与：同一个身份才走这条判据） */
function sameFacts(left: SubagentRecord, right: SubagentRecord): boolean {
  return PRESERVED_SUBAGENT_FIELDS.every(
    (field) => JSON.stringify(left[field] ?? null) === JSON.stringify(right[field] ?? null),
  );
}

/**
 * 一条消息归哪个子任务：消息那一侧**可能挂的是「派生它的那次调用 id」**（`parentCallId`），
 * 而记录那一侧挂的是子任务身份——两套 id 谁都不等于谁（见 `SubagentRecord.parentCallId` 的说明）。
 * 这一层是纯搬运：拿记录自己带的 `parentCallId` 当别名，别名与真名冲突时**真名优先**
 * （记录的身份是权威，别名只是消息那一侧的书写方式）。
 */
function attributedNodeOf(product: ConformanceProduct, message: AgentMessage): string {
  if (message.subagentId === null) return 'main';
  const direct = product.subagents.some((record) => record.subagentId === message.subagentId);
  if (direct) return message.subagentId;
  const owner = product.subagents.find((record) => record.parentCallId === message.subagentId);
  return owner?.subagentId ?? message.subagentId;
}

/** 折叠后的视图：`subagentId → 该会话自己的消息`（主会话键为 `main`，与消费方同一套 id） */
function messagesByNode(product: ConformanceProduct): Map<string, AgentMessage[]> {
  const byNode = new Map<string, AgentMessage[]>();
  for (const message of product.messages) {
    const key = attributedNodeOf(product, message);
    const bucket = byNode.get(key);
    if (bucket === undefined) byNode.set(key, [message]);
    else bucket.push(message);
  }
  return byNode;
}

/**
 * **K1 子任务归属**：声明 `subagent: yes` 的家，其产物里子任务消息必须带 `subagentId`，
 * 且**每个子任务节点折叠后的轮次非空**。
 *
 * 为什么这条是套件级而不是各家自己的用例：界面按 `subagentId` 把消息分给会话节点、再按
 * `roundTrip` 分组成轮次（`build-model.ts` 的第一条职责）。适配器少挂一次归属键的后果不是报错，
 * 而是**子任务点进去只有一条终局行、没有逐条对话**——消息明明躺在产物里，界面一条都认不到。
 * 只判「有没有 `subagent` 行」的家在这里全绿，而用户看到的是空盒子。
 *
 * 两条判据分得开，缺一条都留一个洞：
 *   · **带 `subagentId`**：主会话的消息那一格是 `null`，子任务的消息必须以**该子任务的 id**
 *     或**派生它的调用 id**（别名，见 `attributedNodeOf`）落在别的节点上——一条都没有时，
 *     折叠出来的轮次必然是空的；
 *   · **轮次非空**：逐条对话真的落进了那个节点（不是「有归属键但全指错地方」）。
 */
export function checkSubagentAttribution(fixture: ConformanceFixture): void {
  if ((fixture.capability as unknown as Record<string, unknown>)['subagent'] !== 'yes') return;
  for (const [name, build] of SCENARIO_ENTRIES(fixture)) {
    const product = build();
    if (product.subagents.length === 0) continue;
    const attributed = product.messages.filter((message) => message.subagentId !== null);
    if (attributed.length === 0) {
      throw new Error(
        `${fixture.kind}/${name}：产物里有 ${product.subagents.length} 条子任务行，但没有一条消息带 subagentId`
        + '——子任务节点折叠后的轮次必然是空的（点进去「没有逐条对话记录」，而消息就在产物里）',
      );
    }
    const byNode = messagesByNode(product);
    for (const subagentId of foldSubagentDeliveries(product.subagents).map((record) => record.subagentId)) {
      const own = byNode.get(subagentId) ?? [];
      if (own.length === 0) {
        throw new Error(
          `${fixture.kind}/${name}：子任务 ${subagentId} 没有一条归属它自己的消息`
          + `（产物有 ${attributed.length} 条带 subagentId 的消息，但一条都不落在它这个节点上）`
          + '——子任务折叠后的轮次为空，界面只能给出终局行',
        );
      }
    }
  }
}

/**
 * **K2 同一身份只出一条**：折叠之后每个 `subagentId` **恰好一行**，且**每一次投递都带来新事实**。
 *
 * **判据是「折叠去重」，不是「禁止重复投递」**——这一条的措辞与实现两侧都容易写反，理由在契约里：
 * `AgentRunInput.onSubagent` 明文「一行一子任务，**同一身份会多次投递**（派发时一条、收场时一条），
 * 后者是前者的完整快照 ⇒ 消费方按 `subagentId` 覆盖即可」（`types.ts` 与
 * `docs/protocols/provider-run.md` 逐字同此），`message-log.ts` 的 `foldSubagents` 就是那个覆盖。
 * 而**带新事实的补全必须照发**：后台档下第一次拿到终态与用量的那一刻只能再投一条完整快照，
 * 挡掉它，子任务的状态与用量就永远停在派发时那份半截快照上。
 *
 * 于是三件事分开判：
 *   1. **折叠成一行**：`foldSubagentDeliveries` 的输出里身份**首次出现的顺序**不得漂移——
 *      界面按这个顺序摆卡片，后到的覆盖不该把卡片挪位；
 *   2. **后到的是完整快照**（覆盖不许丢事实）：同一条子任务在这条投递**之前**已经出现过的
 *      非空取值，折叠结果里必须还在。适配器若把「收尾」投成一份比派发更瘦的快照，消费方按
 *      `subagentId` 一覆盖，磁盘上那条就**退回半截**（名字掉了、状态退回 running），而形状全合法；
 *   3. **没有「什么都不带」的投递**：一条投递若与它折叠后停下来的那一行**逐格相同**，它带的新事实
 *      是零——这种重发既不在折叠上留下痕迹，也不在任何形状判据里露头，唯一的表现是磁盘上多一行、
 *      派发面板与导出里多出一张卡片。判据按**内容**比而不是「发过没有」，故它不挡第 2 条要的补全。
 */
export function checkSubagentSingleRow(fixture: ConformanceFixture): void {
  for (const [name, build] of SCENARIO_ENTRIES(fixture)) {
    const product = build();
    const folded = foldSubagentDeliveries(product.subagents);
    const firstSeen = [...new Set(product.subagents.map((record) => record.subagentId))];
    const foldedIds = folded.map((record) => record.subagentId);
    if (foldedIds.join('|') !== firstSeen.join('|')) {
      throw new Error(
        `${fixture.kind}/${name}：折叠后的子任务顺序是 ${foldedIds.join('、')}，`
        + `首次出现顺序是 ${firstSeen.join('、')}——后到的覆盖不该把这条在时间轴上的位置挪走`,
      );
    }
    for (const record of folded) {
      const deliveries = deliveriesOf(product, record.subagentId);
      for (const [index, delivery] of deliveries.entries()) {
        for (const field of PRESERVED_SUBAGENT_FIELDS) {
          const before = deliveries.slice(0, index).map((one) => one[field]).find((value) => value !== null);
          if (before != null && delivery[field] === null) {
            throw new Error(
              `${fixture.kind}/${name}：子任务 ${record.subagentId} 的第 ${index + 1} 条投递把 ${field} 投成了 null`
              + `（先前已采到 ${JSON.stringify(before)}）——后到的快照必须更全，覆盖不许丢事实`,
            );
          }
        }
        const prior = deliveries.slice(0, index).at(-1);
        if (prior !== undefined && sameFacts(delivery, prior)) {
          throw new Error(
            `${fixture.kind}/${name}：子任务 ${record.subagentId} 的第 ${index + 1} 条投递与上一条逐格相同`
            + '——同一身份的重复投递只允许在**带新事实**时发生（补全终态 / 用量）；'
            + '什么都不带的重发会在磁盘上多出一行，派发面板与导出里多出一张卡片',
          );
        }
      }
    }
  }
}

/**
 * **K3 名字稳定**：同一条子任务的 `name` 在**派发**与**收尾**两条投递上必须一致
 * （覆盖只许**填空**，不许改名——厂商侧的 `description` 不许盖掉派发时那个名字）。
 *
 * 为什么这一格要专门判：`name` 的消费方是派发面板与时间轴上的子任务入口，用户按它认人；
 * 收尾那一条若用自己的 `description` 覆盖掉名字，界面上的入口会在子任务跑完的**那一刻改名**
 * ——同一条子任务前后是两个名字，用户以为多出来一个。而形态本身（两个字符串）过得了所有形状判据。
 *
 * 判据取产物**实际投递的那几条**，不是 `foldSubagentDeliveries` 之后的终态：终态只留最后一条，
 * 覆盖这件事在折叠之后就看不到了（那正是这条判据存在的理由）。两条方向：
 *   · 首条非空（名字在派发时就采到了）⇒ 后续每一条都必须与它逐字相同，且不许退回 `null`
 *     （退回 = 界面在收尾那一刻把名字换成 id 前 8 位）；
 *   · 首条为空（派发时还没采到）⇒ 后续**可以**补一个非空名字（那是补全，不是改名），
 *     但补上的名字此后不得再变。
 */
export function checkSubagentNameStability(fixture: ConformanceFixture): void {
  for (const [name, build] of SCENARIO_ENTRIES(fixture)) {
    const product = build();
    for (const subagentId of foldSubagentDeliveries(product.subagents).map((record) => record.subagentId)) {
      const deliveries = deliveriesOf(product, subagentId);
      const first = deliveries[0]!.name;
      if (first === null) {
        const filled = deliveries.map((record) => record.name).filter((one): one is string => one !== null);
        if (new Set(filled).size > 1) {
          throw new Error(
            `${fixture.kind}/${name}：子任务 ${subagentId} 的名字在补全过程中出现了多个取值`
            + `（${filled.join('、')}）——派发时没采到不是改名的理由`,
          );
        }
        continue;
      }
      const drifted = deliveries.filter((record) => record.name !== first);
      if (drifted.length === 0) continue;
      const shown = drifted.map((record) => JSON.stringify(record.name)).join('、');
      throw new Error(
        `${fixture.kind}/${name}：子任务 ${subagentId} 的名字被后来的投递改动（派发时是 ${JSON.stringify(first)}，`
        + `之后变成 ${shown}）——收尾不许用厂商描述覆盖派发时的名字`,
      );
    }
  }
}

/** 归一后的用量三元组之和：本仓可比的那把尺（厂商自报的 `total` 口径各家不同，不参与比较） */
function tokenSum(tokens: UsageTokens): number {
  return tokens.input + tokens.cached + tokens.output;
}

/**
 * 分量与合计同一把尺（「缺一格就整格 null」由 schema 保证：三个必填格是 `number`，整格才可空）。
 *
 * 两条方向都要判，且都是**分量不可能比合计更大**：
 *   · **轮次**：分量的轮次是从合计推出来的（claude 的 `index.ts`：
 *     `subagentTurns = turns === null ? null : read.turns`）——合计不知道时分量必然为 `null`；
 *     反过来不成立（分量 token 可以独立采到，合计轮次却可能采不到）。接 claude 时这条抓出过
 *     判据写反了方向，故在此写明理由。
 *   · **用量**：契约里两格都是**合计口径**（子会话的那一份已经并进 `tokens`），而界面按
 *     「主会话 = 合计 − 分量」推导——分量超过合计时那个减法是负数，没有任何一层会拦。
 *     四家的实现都是「主子 + 子分量」，故这条也是「同一把尺」的判据。
 *
 * **用量那一格刻意不判「合计缺席时分量必须也缺席」**（与轮次那条不对称，是有意的）：
 * 轮次的分量是**从合计推出来的**，而用量的分量是**独立收的**——「这一行有没有派子任务」这件事
 * 不依赖厂商报不报用量，故「零个分量 + 合计未采到」是合法形态（dsh 的用量通道不投送时正是它）。
 * 判据只在两格都在时比大小：那时界面才会真去做那个减法。
 */
export function checkUsagePairing(fixture: ConformanceFixture): void {
  for (const [name, build] of SCENARIO_ENTRIES(fixture)) {
    const { usage } = build();
    if (usage.subagentTurns !== null && usage.turns === null) {
      throw new Error(`${fixture.kind}/${name}：给了 subagentTurns 却把合计 turns 记成 null（分量不可能比合计更清楚）`);
    }
    if (usage.turns !== null && usage.subagentTurns !== null && usage.subagentTurns > usage.turns) {
      throw new Error(`${fixture.kind}/${name}：subagentTurns 大于 turns（分量与合计不同尺）`);
    }
    if (
      usage.tokens !== null
      && usage.subagentTokens !== null
      && tokenSum(usage.subagentTokens) > tokenSum(usage.tokens)
    ) {
      throw new Error(
        `${fixture.kind}/${name}：subagentTokens（${tokenSum(usage.subagentTokens)}）大于合计 tokens`
        + `（${tokenSum(usage.tokens)}）——两格都是合计口径，界面按「主会话 = 合计 − 分量」推导，`
        + '分量更大时界面会算出负的主会话用量',
      );
    }
  }
}

/** 声明 `yes` 就必须造得出该块；声明非 `yes` 必须给出与该态对应的原因 */
export function checkCapabilityNailing(fixture: ConformanceFixture): void {
  const declaration = fixture.capability as unknown as Record<string, unknown>;
  for (const [cell, proofNames] of CAPABILITY_PROOF) {
    const state = declaration[cell];
    if (state === 'yes') {
      const usable = proofNames.filter((scenarioName) => fixture.scenarios[scenarioName] !== undefined);
      if (usable.length === 0) {
        throw new Error(`${fixture.kind}：${cell} 声明 yes，但没有任何能证明它的场景（缺 ${proofNames.join(' / ')}）`);
      }
      const prove = CELL_PROOF[cell]!;
      for (const scenarioName of usable) {
        const problem = prove(fixture.scenarios[scenarioName]!());
        if (problem !== null) {
          throw new Error(`${fixture.kind}：声明 ${cell}=yes，但 ${scenarioName} 场景里${problem}`);
        }
      }
      continue;
    }
    const allowed = REASON_BY_CAPABILITY[String(state)];
    if (allowed === undefined) throw new Error(`${fixture.kind}：${cell} 的取值 ${String(state)} 不是契约五态之一`);
    const reason = declaration[`${cell}Reason`];
    if (!allowed.includes(reason as MissingReason)) {
      throw new Error(`${fixture.kind}：${cell}=${String(state)} 的原因必须是 ${allowed.join('/')} 之一，实际是 ${String(reason)}`);
    }
  }
}

/**
 * 每个能力格的**证明**：在这份产物上判「声明 `yes` 的东西真的拿得到」。
 * 返回一句人话（拿不到）或 `null`（拿得到），kind / 场景名由调用方拼上。
 *
 * 为什么按**格**分派而不是按场景名分派：一格声明 `yes` 时，能证明它的场景常常不止一个
 * （`toolInput` 就有 tool-shell / tool-edit / tool-plan 三个候选）。按场景分派会把「这一格要什么」
 * 与「这个场景里该有什么」绑死——`toolResult` 就这样被绑在 `tool-shell` 上，于是它的证明只查了
 * tool-call 的入参：**产物里一个工具结果块都没有也照样绿**。按格分派后，每格只认自己的形态。
 */
const CELL_PROOF: Readonly<Record<string, (product: ConformanceProduct) => string | null>> = {
  /**
   * 要的是**正文**：`text: null` 的密文思考证明不了这一格——「有思考拿不到文本」是契约里的合法形态
   * （`textKind: 'none'`），但它与「拿得到思考正文」是两件事。
   */
  thinkingText: (product) => {
    const thinking = product.messages.flatMap((message) => message.blocks).filter((block) => block.type === 'thinking');
    if (thinking.length === 0) return '没有任何 thinking 块';
    if (!thinking.some((block) => block.text !== null && block.text !== '')) {
      return '有 thinking 块但都没有正文（密文思考证明不了 thinkingText=yes）';
    }
    return null;
  },
  toolInput: (product) =>
    product.messages.flatMap((message) => message.blocks).some((block) => block.type === 'tool-call' && block.input !== null)
      ? null
      : '没有带入参的 tool-call 块',
  toolResult: (product) =>
    product.messages.flatMap((message) => message.blocks).some((block) => block.type === 'tool-result')
      ? null
      : '没有 tool-result 块',
  subagent: (product) => (product.subagents.length > 0 ? null : '没有产出子任务行'),
  streamingDelta: (product) =>
    product.messages.some((message) => message.chunk === 'delta') ? null : '没有任何 delta 消息',
};

/**
 * **注入面探针**：请求侧的事实——「我们发出去什么」。
 *
 * 为什么必须单列：厂商侧事实（`vendor-system` 事件）只证明「厂商报了什么」，**不证明**
 * 「我们把 `input.mcpServers` / `input.skills` 真的交给了厂商」。适配器整段忽略入参时，
 * 夹具喂进去的厂商载荷照样产出那条事实——判据全绿，而 MCP 一台都没装到。
 *
 * 请求侧事实由**假件在 run 期间记录**（cc 的 SDK recorder 里的 `mcpServers`、dsh 的 overlay
 * 落点、落盘的技能目录），这是夹具手搓不出来的那一半。与 `structuredOutput` 的
 * `hasOutputSchema` 同一条设计：**两份事实互钉**，只判一份等于没判。
 */
export interface InjectionProbe {
  /** 本次运行真的交给厂商的 MCP 配置；`null` / 空对象 = 一台都没发出去 */
  mcpSent?: unknown;
  /**
   * 本次交给厂商的那几台服务器**名字**（逐字）：注入面**逐名绑定**要用的那一半事实。
   *
   * 与 `mcpSent` 分工：`mcpSent` 回答「适配器有没有把入参交给厂商」（形状各家不同），
   * 这一格回答「交给厂商的是**哪几台**」（统一形状，判据据此逐台对厂商工具表）。
   * 不记这一格的家照旧只判「有没有 MCP 事实」。
   */
  mcpServerNames?: readonly string[];
  /** 本次运行真的落盘的技能副本名（对账对象是 `AgentRunInput.skills` 给的那几个） */
  skillsInstalled?: readonly string[];
}

/** 请求侧事实「在不在」：数组看长度、对象看键数（`null` / `undefined` / 空 = 没发出去） */
function hasRequestFact(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (value !== null && typeof value === 'object') return Object.keys(value).length > 0;
  return false;
}

/**
 * 行级事件**逐个过契约 schema**（`AgentEventSchema`）。
 *
 * 为什么需要它：`events` 在产物里是 `Record<string, unknown>[]`，类型系统管不到，而形状本该由契约管。
 * 少了这一条，适配器发一条形状残缺的事件不会有任何判据发现——少了 `status` 的 status 事件、
 * 少了 `mcpServers` 的 `vendor-system`，界面只是少画一格，链路全绿。
 * `vendor-system` 尤其要紧：**MCP 与技能面的厂商事实都在它身上**，注入对不对齐全看它。
 */
export function checkEventShapes(fixture: ConformanceFixture): void {
  for (const [name, build] of SCENARIO_ENTRIES(fixture)) {
    for (const event of build().events) {
      const parsed = AgentEventSchema.safeParse(event);
      if (!parsed.success) {
        throw new Error(`${fixture.kind}/${name} 的行级事件不合契约：${JSON.stringify(parsed.error.issues)}`);
      }
    }
  }
}

/** 产物里**主会话已收尾**的答复正文（按到达顺序）。判据与实现同一口径：子线程与半截增量都不算答复 */
function settledMainReplies(product: ConformanceProduct): string[] {
  const replies: string[] = [];
  for (const message of product.messages) {
    if (message.subagentId !== null || message.role !== 'assistant' || message.chunk !== 'snapshot') continue;
    for (const block of message.blocks) {
      if (block.type === 'text' && block.text !== '') replies.push(block.text);
    }
  }
  return replies;
}

/**
 * `finalText` 的三条通则（跨家同一把尺）。
 *
 * 判据刻意**不看厂商**，只看「产物里有什么」与「结果里报了什么」是否自洽：
 *   1. 空串一律红——「没采到」必须记 `null`（调用方对两者给的是两句不同的归因）；
 *   2. 收尾成功、且产物里有主会话答复 ⇒ `finalText` 必须拿得出（**这条正是漏写那一格的拦网**：
 *      codex 当年就是全绿通过，而真机上这一格恒 `null`）；
 *   3. `finalText` 非 `null` 时，它必须是产物里某一条主会话答复正文——写别处的正文（子线程的、
 *      半截增量的、凭空拼的）都算违约。
 * 另加一条可选的字面量比对（`expectedFinalText`），给需要钉死某一场景的家用。
 */
export function checkFinalAnswer(fixture: ConformanceFixture): void {
  for (const [name, build] of SCENARIO_ENTRIES(fixture)) {
    const product = build();
    const { finalText, ok } = product.result;
    if (finalText === '') {
      throw new Error(`${fixture.kind}/${name}：最终答复是空串——没采到必须记 null，两者是不同的归因`);
    }
    const replies = settledMainReplies(product);
    if (ok && replies.length > 0 && finalText === null) {
      throw new Error(
        `${fixture.kind}/${name}：产物里有主会话答复 ${JSON.stringify(replies.at(-1))}，但 finalText 是 null`
        + '（这一格漏写＝需要最终答复的调用方永远拿不到答复）',
      );
    }
    if (finalText !== null && !replies.includes(finalText)) {
      throw new Error(`${fixture.kind}/${name}：finalText ${JSON.stringify(finalText)} 不是产物里任何一条主会话答复正文`);
    }
    const expected = fixture.expectedFinalText?.[name];
    if (expected !== undefined && finalText !== expected) {
      throw new Error(`${fixture.kind}/${name}：finalText 应为 ${JSON.stringify(expected)}，实际 ${JSON.stringify(finalText)}`);
    }
  }
}

/**
 * 契约里的事件类型闭集。`AgentEventSchema` 是判别联合：`.options` 是各分支，
 * 每个分支的 `.shape.type.value` 就是那个 `z.literal`。
 */
const CONTRACT_EVENT_TYPES: readonly string[] = AgentEventSchema.options.map((option) => option.shape.type.value);

/**
 * 事件类型与消息来源都必须落在**契约的闭集**内；`log` 必须带 `stream`。
 *
 * 两个闭集都从 schema **派生**，不在这里手抄一份：手抄的那份必然与契约漂移，而漂移的表现是
 * **误红**——适配器确实会发 `vendor-system`（`emit.ts` 把厂商系统事实转成这条事件），而一份抄成
 * 「只有 usage / log / error」的清单会把它判成契约外的类型，红在一条完全合法的产物上。
 */
export function checkLineEventsAndSources(fixture: ConformanceFixture): void {
  for (const [name, build] of SCENARIO_ENTRIES(fixture)) {
    const product = build();
    for (const event of product.events) {
      if (!CONTRACT_EVENT_TYPES.includes(String(event.type))) {
        throw new Error(`${fixture.kind}/${name}：出现了契约外的行级事件 ${JSON.stringify(event.type)}`);
      }
      if (event.type === 'log' && !['stdout', 'stderr'].includes(String(event.stream))) {
        throw new Error(`${fixture.kind}/${name}：log 事件缺少 stream`);
      }
    }
    for (const message of product.messages) {
      if (!MessageSourceSchema.options.includes(message.source)) {
        throw new Error(`${fixture.kind}/${name}：消息来源 ${message.source} 不在契约闭集内`);
      }
    }
  }
}

/**
 * 结构化输出（评分者通路）：逐场景跑探针。判据本体在 `./structured-output.ts`
 * （独立成模块的理由见该文件头；本函数只负责挂上场景名，让红的时候能点名）。
 */
export function checkStructuredOutputGroup(fixture: ConformanceFixture): void {
  for (const [name, build] of SCENARIO_ENTRIES(fixture)) {
    const probe = build().structuredOutput;
    if (probe === undefined) continue;
    try {
      checkStructuredOutput(probe);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`${fixture.kind}/${name}：${reason}`);
    }
  }
}

/**
 * C 类（协议时序）：逐场景跑传输笔迹判据。判据本体在 `./transport.ts`；本函数负责点名到场景。
 */
export function checkTransportDeliveryGroup(fixture: ConformanceFixture): void {
  for (const [name, build] of SCENARIO_ENTRIES(fixture)) {
    const transcript = build().transport;
    if (transcript === undefined) continue;
    try {
      checkTransportDelivery(transcript);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`${fixture.kind}/${name}：${reason}`);
    }
  }
}

/**
 * **增量通道隔离**：喂了增量帧的场景必须声明**事件条数**，且实际条数必须等于它。
 *
 * 为什么这条需要专门的守卫：增量帧只该走内容通道，而**漏进事件通道是一条真实的
 * 回归路径**——claude 的 `stream_event` 就掉进过「未识别厂商负载落 `log` 保留原始负载」的兜底，
 * 一次运行几百上千条 ⇒ 「原始输出」面板被刷成 JSON 流水（用户口径：浏览器卡死，且真要看的
 * stderr / init 全被冲掉）。三条 `events.ts` 的分支都补上了，但**当时没有任何跨家守卫**：
 * 把分支删回去，三家各自的用例里只有 claude 会红。
 *
 * 判据为什么是「事件条数」而不是「事件里有没有 delta 字样」：产物里的事件已经是契约形状，
 * 认不出哪一条来自增量；而**条数**有区分力——增量一旦混进事件通道，条数就是 baseline + 帧数。
 * 代价是这格数要人工维护，故只对**真有增量帧的场景**强制（`hasDelta` 判据取自产物本身，
 * 不靠 fixture 自述，否则「我说我这个场景没有增量」就是一句无区分力的自述）。
 */
export function checkDeltaChannelIsolation(fixture: ConformanceFixture): void {
  for (const [name, build] of SCENARIO_ENTRIES(fixture)) {
    const product = build();
    // 判据取自**产物**（不是 fixture 自述）：这个场景确实产出了增量帧
    if (!product.messages.some((message) => message.chunk === 'delta')) continue;
    const expected = fixture.expectedEventCounts?.[name];
    if (expected === undefined) {
      throw new Error(
        `${fixture.kind}/${name}：场景里有增量帧，却没声明 expectedEventCounts —— 「增量不产事件」这条口径当场失去判据`
        + '（把增量掉回 log 兜底的回归谁都不会红）',
      );
    }
    if (product.events.length !== expected) {
      throw new Error(
        `${fixture.kind}/${name}：事件条数 ${product.events.length} ≠ 声明的 ${expected}`
        + '——多出来的极可能就是增量帧混进了事件通道（原始输出面板会被刷成 JSON 流水）',
      );
    }
  }
}

/** 产物里的 `vendor-system` 事实（三家的 MCP 与技能面都落在这条事件上；消费方取最后一条读，这里看全部） */
function vendorSystemEvents(product: ConformanceProduct): Array<Record<string, unknown>> {
  return product.events.filter((event) => event.type === 'vendor-system');
}

/**
 * MCP 那一格的事实判据：**两台通道合读**。
 *
 * 为什么是「或」而不是只看服务表：三家的判据通道本来就不同——cc 报 `mcp_servers[].status`、
 * codex 报 `mcpServer/startupStatus`，而 **dsh 没有「每台一张状态表」这种东西**，它只有
 * `request/header` 的工具表（那条事件的 `mcpServers` 恒 `null`）。只认服务表会把 dsh 判成
 * 「没注入」——那是判据错，不是它错。
 */
function hasMcpFact(product: ConformanceProduct): boolean {
  return vendorSystemEvents(product).some((event) => {
    const servers = event['mcpServers'];
    if (Array.isArray(servers) && servers.length > 0) return true;
    const tools = event['tools'];
    return Array.isArray(tools) && tools.some((tool) => typeof tool === 'string' && tool.startsWith('mcp__'));
  });
}

/** 技能那一格的事实判据：厂商侧报回了**非空**清单（`vendor-system.skills` 缺席 = 没采到，不是「空清单」） */
function hasSkillFact(product: ConformanceProduct): boolean {
  return vendorSystemEvents(product).some((event) => Array.isArray(event['skills']) && event['skills'].length > 0);
}

/**
 * 注入面探针里的**服务器名**那一半（今天的形状：pi 的假件把交给厂商的 `mcpServers` 的键记下来）。
 *
 * 为什么单列而不是从 `mcpSent` 里认：`mcpSent` 各家形状不同（配置对象 / 工具名数组），
 * 而「我们交给厂商的是哪几台」这一问必须有一个**统一答案**，才谈得上逐名绑定。
 */
function mcpServerNamesOf(product: ConformanceProduct): readonly string[] {
  const names = product.injectionProbe?.mcpServerNames;
  return Array.isArray(names) ? names : [];
}

/** 厂商侧工具表（所有 `vendor-system` 事件的 `tools` 汇总；没有工具面时为空数组） */
function vendorToolNames(product: ConformanceProduct): readonly string[] {
  return vendorSystemEvents(product).flatMap((event) => {
    const tools = event['tools'];
    return Array.isArray(tools) ? tools.filter((tool): tool is string => typeof tool === 'string') : [];
  });
}

/**
 * MCP 那一格的**厂商侧事实**：按「我们交给厂商的那几台」逐名绑定。
 *
 * 与 `hasMcpFact` 的差别就是这条收紧：后者只问「工具表里有没有**某个** `mcp__*`」——
 * 夹具把探针服务器改个名、我们注入的一台都没生效，只要表里还有别的 MCP 工具就照样绿。
 * 这里的判据是「**每一台**都在表里」，名字形态差异（厂商把 `-` 写成 `_`）由共享匹配器吸收。
 *
 * 返回 `null` = 这一格通过；否则返回一句点名到台的原因。
 */
function mcpFactProblem(product: ConformanceProduct, declared: readonly string[] | undefined): string | null {
  const sent = mcpServerNamesOf(product);
  if (declared !== undefined) {
    const missingInProbe = declared.filter((name) => !sent.includes(name));
    const extraInProbe = sent.filter((name) => !declared.includes(name));
    if (missingInProbe.length > 0 || extraInProbe.length > 0) {
      return `声明的注入名单与请求侧探针不符（声明 ${declared.join('、') || '（空）'}，`
        + `探针 ${sent.join('、') || '（空）'}）——夹具改了名而判据没跟，这一格就白判了`;
    }
  }
  if (sent.length === 0) {
    return hasMcpFact(product) ? null : '没有任何 MCP 事实（`vendor-system` 的服务表与 `mcp__` 工具表都没有）';
  }
  const tools = vendorToolNames(product);
  const missing = sent.filter((name) => matchMcpToolName(name, tools) === null);
  if (missing.length === 0) return null;
  return `厂商工具表里没有这几台的工具：${missing.join('、')}`
    + `（请求侧探针交出的是 ${sent.join('、')}；工具表的判据是 \`mcp__<name>__\` 前缀，两种形态都认）`;
}

const INJECTION_FACT: Readonly<Record<'skills', (product: ConformanceProduct) => string | null>> = {
  skills: (product) =>
    hasSkillFact(product) ? null : '厂商侧技能清单为空（`vendor-system.skills` 没有非空清单）',
};

/**
 * 注入面：声明 `yes` 的通路必须给出**两份互钉的事实**——请求侧（我们发出去什么）与厂商侧
 * （厂商报回来什么），或者如实登记「这一格的证明在别处」（`injectionProofElsewhere`，
 * 由接入守卫核对文件存在）。
 *
 * 为什么两份都要：只判厂商侧会放过「适配器压根没把 `input.mcpServers` / `input.skills` 交给
 * 厂商」——夹具喂的厂商载荷照样产出那条事实，套件全绿而 MCP 一台都没装到。只判请求侧则会放过
 * 「发出去了但厂商没认」。**互钉才说明这条通路真的通了。**
 *
 * 与消息面同一形状（声明与产物互钉），差别在**证明看哪里**：消息面看内容块（`CELL_PROOF`），
 * 注入面看请求侧探针 + `vendor-system` 事件。
 *
 * 反向也判：声明非 `yes` 却给了证明场景 = 「声明不支持、却造得出事实」，同样自相矛盾。
 *
 * **已知边界**：探针本身仍写在夹具里，一个刻意造假的接入者能把两边一起写对。这一层拦的是
 * 「顺着写但漏了一环」（适配器忽略入参、请求侧没接），不是「成心骗」——后者只有真机冒烟拦得住。
 */
export function checkInjectionNailing(fixture: ConformanceFixture): void {
  for (const cell of ['mcp', 'skills'] as const) {
    const declared = fixture.injection[cell];
    const scenarioName = fixture.injectionProof[cell];
    const elsewhere = fixture.injectionProofElsewhere?.[cell];
    if (declared.state !== 'yes') {
      if (scenarioName !== undefined) {
        throw new Error(
          `${fixture.kind}：${cell} 声明 ${declared.state}，却给了证明场景 ${scenarioName}——声明与产物自相矛盾`,
        );
      }
      continue;
    }
    if (scenarioName === undefined) {
      if (elsewhere === undefined) {
        throw new Error(
          `${fixture.kind}：${cell} 声明 yes，却既没有证明场景、也没有登记它在哪一层被证明（空转不许静默）`,
        );
      }
      continue;
    }
    const build = fixture.scenarios[scenarioName];
    if (build === undefined) {
      throw new Error(`${fixture.kind}：${cell} 的证明场景 ${scenarioName} 没有产物`);
    }
    const product = build();
    // ① 请求侧：我们真的发出去了吗（这一半夹具手搓不出来——它由假件在 run 期间记录）
    const sent = cell === 'mcp' ? product.injectionProbe?.mcpSent : product.injectionProbe?.skillsInstalled;
    if (!hasRequestFact(sent)) {
      throw new Error(
        `${fixture.kind}：声明 ${cell}=yes，但 ${scenarioName} 场景没有**请求侧**事实`
        + '——适配器可能压根没把我们给的输入交给厂商（只判厂商侧会放过这一整类缺陷）',
      );
    }
    // ② 厂商侧：厂商真的收到了吗（`mcp` 那一格按声明的名字逐台绑，见 `mcpFactProblem`）
    const problem = cell === 'mcp' ? mcpFactProblem(product, fixture.injectedMcpServers) : INJECTION_FACT.skills(product);
    if (problem !== null) {
      throw new Error(`${fixture.kind}：声明 ${cell}=yes，但 ${scenarioName} 场景里${problem}`);
    }
  }
}

/**
 * **交互面：声明与产物互钉**（今天只有「能不能问人」那一格）。
 *
 * 三条判据，各自的门槛刻意不同：
 *   1. **声明 `askUser = yes` ⇒ 必须有一个能造出「问了一次」的场景**（`INTERACTION_PROOF` 的组内任一）
 *      ——「声明过的东西必须真的拿得到」；
 *   2. **只要注册了这个场景，它的产物就必须过 `./ask-user.ts` 那一组判据**，**不看声明**：
 *      非 `yes` 说的是**适配器那一半还没接**（`off-by-adapter` / `not-projected-by-vendor` / `no`），
 *      而场景证的是**骨架那一半**（端口问得对、不传回调时一个字都不动）——两者可以同时成立，
 *      而且正是接线之前的状态。把第 2 条也挂在声明上，等于在接线之前谁都不判这一组，
 *      那四家交上来的场景就成了没人读的摆设。
 *   3. **问过人的那一次，提问那一半必须在账本里**（`checkAskUserLedger`，同样不看声明、不挑场景名）：
 *      卡片唯一的驱动是账本里那条 `ask-user` 工具调用，而厂商把提问放在通知流之外时
 *      （codex 的服务端请求），账本里那一半没有第二个来源——不物化就是「界面只剩一条没题目的答复行」，
 *      而**所有既有判据照旧全绿**。
 *
 * ⚠️ 与注入面刻意不同的一格：这里**不判**「声明非 `yes` 却给了场景」。反过来（非 yes 不许有场景）
 * 也一样不判——理由就是上面第 2 条。
 *
 * **对照运行那一格按通道分档**（`host-tool` 做不到指纹逐字相等，理由与替换后的两条判据写在
 * `./ask-user.ts` 的模块头）：`host-tool` 的家因此还要在 fixture 上交出那件工具的名字
 * （`askUserHostTool`），漏了它判据当场红——「拿不出名字」= 这一档的对照臂判据无从谈起。
 */
export function checkInteractionNailing(fixture: ConformanceFixture): void {
  /**
   * 声明自身先过一次契约 schema：两条**跨字段**的硬规则在那里（`askUser = yes` ⇒ 必须拿
   * `real-path` 证明、`synthetic-fixture` ⇒ 必须给出原因）。放在这一组里而不是单开一条用例：
   * 每一家都已经把 `metadata.interaction` 交给这一组，声明不合规就该在**这一家自己**的套件里当场红。
   */
  const parsed = InteractionCapabilitySchema.safeParse(fixture.interaction);
  if (!parsed.success) {
    throw new Error(`${fixture.kind} 的交互面声明不合规：${JSON.stringify(parsed.error.issues)}`);
  }
  /**
   * **账本那一半**：所有场景都过一遍，不看声明、也不看这个场景是不是 `ask-user` 那一格——
   * 判据挂在**运行事实**上（探针里端口真被问过），因此「哪一次运行问过人」就是它的覆盖面。
   */
  for (const [name, build] of SCENARIO_ENTRIES(fixture)) {
    checkAskUserLedger(`${fixture.kind}/${name}`, build());
  }
  for (const [cell, proofNames] of INTERACTION_PROOF) {
    const declaredYes = (fixture.interaction as unknown as Record<string, unknown>)[cell] === 'yes';
    const usable = SCENARIO_ENTRIES(fixture).filter(([name]) => proofNames.includes(name));
    if (declaredYes && usable.length === 0) {
      throw new Error(
        `${fixture.kind}：${cell} 声明 yes，却没有任何能证明它的场景（缺 ${proofNames.join(' / ')}）`
        + '——声明过的东西必须真的拿得到',
      );
    }
    const channel = fixture.interaction.askUserChannel;
    for (const [name, build] of usable) {
      const probe = build().askUser;
      if (probe === undefined) {
        throw new Error(`${fixture.kind}/${name}：这一格是 ${cell} 的证明场景，产物里却没有提问应答探针`);
      }
      checkAskUserProbe(
        `${fixture.kind}/${name}`,
        probe,
        channel,
        channel === 'host-tool' ? (fixture.askUserHostTool ?? null) : null,
      );
    }
  }
}

/**
 * **生命周期证据**：这一家在「跑完」与「被取消」两条出口上的行为。
 *
 * 为什么不走产物：释放与取消是**行为**，产物里没有它们的形状——它们只能在运行期观测
 * （数释放次数、看中断有没有真的终结在途轮次）。所以各家提供一个**异步观测函数**，
 * 套件在用例里 `await` 它。
 *
 * 为什么必须有这一格：这两条出口原先在契约层**一个字都没有**——某家泄漏子进程、或声明
 * 「能中途取消」而实际取消不动，任何判据都不会红。
 */
export interface LifecycleEvidence {
  /** 一次**正常运行**收尾后，厂商运行时被释放了几次（0 = 泄漏，>1 = 重复释放） */
  disposeAfterRun: number;
  /** 一次**取消**之后释放了几次（同一口径：两条出口都要恰好一次） */
  disposeAfterCancel: number;
  /**
   * 取消是否**真的终结了在途轮次**：`true` = 中断通道起了作用；
   * `false` = 只能走释放的第二段兜底（声明 `cancelMidTurn: false` 的家如实填 `false`）。
   */
  canceledMidTurn: boolean;
}

/**
 * 生命周期：释放恰好一次、且取消的观测与声明一致。
 *
 * 判据是**声明与观测对照**，不是「有没有调 dispose」：声明 `cancelMidTurn: true` 的家必须拿得出
 * 「取消真的终结了在途轮次」的证据——声明能、实际不能，是这一层最该拦的假话。
 * 证明不了的家在 `lifecycleElsewhere` 里登记它在哪一层被证明（接入守卫核对路径存在）。
 */
export async function checkLifecycle(fixture: ConformanceFixture): Promise<void> {
  if (fixture.lifecycle === undefined) {
    if (fixture.lifecycleElsewhere === undefined) {
      throw new Error(
        `${fixture.kind}：既没有生命周期观测、也没有登记它在哪一层被证明（释放与取消不许静默）`,
      );
    }
    return;
  }
  const evidence = await fixture.lifecycle();
  if (evidence.disposeAfterRun !== 1) {
    throw new Error(
      `${fixture.kind}：正常运行收尾后释放了 ${evidence.disposeAfterRun} 次——必须恰好一次（0 = 泄漏，>1 = 重复释放）`,
    );
  }
  if (evidence.disposeAfterCancel !== 1) {
    throw new Error(
      `${fixture.kind}：取消之后释放了 ${evidence.disposeAfterCancel} 次——同一口径，必须恰好一次`,
    );
  }
  if (evidence.canceledMidTurn !== fixture.cancelMidTurn) {
    throw new Error(
      `${fixture.kind}：声明 cancelMidTurn=${String(fixture.cancelMidTurn)}，`
      + `但观测到取消${evidence.canceledMidTurn ? '终结了' : '没有终结'}在途轮次——声明与观测不符`,
    );
  }
}

/** 把全部判据注册成一家的用例；红的时候组名直接指向被违反的那条契约 */
export function describeProviderConformance(fixture: ConformanceFixture): void {
  const cases: ReadonlyArray<readonly [string, () => void | Promise<void>]> = [
    ['能力声明自身合规', () => checkCapabilityDeclaration(fixture)],
    ['消息 / 子任务 / 环境过契约 schema', () => checkContracts(fixture)],
    ['合并键等于契约公式', () => checkMergeKeys(fixture)],
    ['子任务桥与状态口径', () => checkSubagentBridge(fixture)],
    ['子任务归属：带 subagentId 且折叠后轮次非空', () => checkSubagentAttribution(fixture)],
    ['子任务同一身份只出一条', () => checkSubagentSingleRow(fixture)],
    ['子任务名字在派发与收尾之间稳定', () => checkSubagentNameStability(fixture)],
    ['用量与轮次配对', () => checkUsagePairing(fixture)],
    ['能力声明与产物互钉', () => checkCapabilityNailing(fixture)],
    ['注入面（MCP / skills）声明与产物互钉', () => checkInjectionNailing(fixture)],
    ['交互面（提问）声明与产物互钉', () => checkInteractionNailing(fixture)],
    ['行级事件逐个过契约 schema', () => checkEventShapes(fixture)],
    ['最终答复口径', () => checkFinalAnswer(fixture)],
    ['结构化输出与产出可解析', () => checkStructuredOutputGroup(fixture)],
    ['传输时序（C 类：缓冲补投 / 终态不早于响应 / 不重复）', () => checkTransportDeliveryGroup(fixture)],
    ['行级事件三类与来源闭集', () => checkLineEventsAndSources(fixture)],
    ['增量通道隔离：喂了增量就必须钉住事件条数', () => checkDeltaChannelIsolation(fixture)],
    ['生命周期：释放恰好一次 + 取消与声明一致', () => checkLifecycle(fixture)],
  ];
  describe(`${fixture.kind} 一致性套件`, () => {
    for (const [title, run] of cases) it(title, run);
  });
}
