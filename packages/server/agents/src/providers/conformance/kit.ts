/**
 * 新增智能体 SDK 的一致性套件（判据源：spec v3）。
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
  AgentEnvironmentSchema,
  AgentMessageSchema,
  MessageCapabilitySchema,
  SubagentRecordSchema,
  type AgentMessage,
  type MessageCapability,
  type MessageSource,
  type MissingReason,
  type SubagentRecord,
  type UsageTokens,
} from '@aieval/contracts';
import { describe, it } from 'vitest';
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
  | 'failure';

/** 一次运行的归一产物：**这就是被测对象** */
export interface ConformanceProduct {
  messages: AgentMessage[];
  subagents: SubagentRecord[];
  /** §2.9：没有 `vendor-system` 通道的那家给 `null`（不要造空壳） */
  environment: unknown;
  /** §2.3 行级事件；形状由契约的事件 schema 管，这里只查「三类 + log 带 stream」 */
  events: Array<Record<string, unknown>>;
  usage: {
    tokens: UsageTokens | null;
    turns: number | null;
    subagentTokens: UsageTokens | null;
    subagentTurns: number | null;
  };
  /** §2.10 行结果（最终答复与结论） */
  result: ConformanceRunResult;
  /**
   * §2.11 结构化输出（评分者通路）的探针：**能真观测到「schema 有没有发给厂商」的 fixture 才给**。
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
}

/**
 * §2.10 **行结果**：一次运行交回给调用方的那两格（`AgentRunResult` 里与归一产物同源的部分）。
 *
 * 为什么单列一个判据组（2026-10-07）：评分通路只读 `finalText`——它是「智能体评分」这条产品
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
  /** §2.7 本次运行的能力声明 */
  capability: MessageCapability;
  /** 场景 → 产物；可以只给一部分，套件按能力声明要求它必须有的那些 */
  scenarios: Partial<Record<ConformanceScenarioName, () => ConformanceProduct>>;
  /** §2.8 声明「这些行的 status 是**采到的**」，其余行的 `statusMissing` 必须非 `null` */
  observedStatusIds?: string[];
  /**
   * §2.10 某一场景期望的最终答复（缺省 = 不额外比对，只查下面那三条通则）。
   * 用途：把「这一家在这条路径上到底该给出什么」钉成字面量（例如「失败场景也不许交空串」）。
   */
  expectedFinalText?: Partial<Record<ConformanceScenarioName, string | null>>;
}

/** 顺序固定的一对：能力格 → 它需要哪个场景来证明自己真的拿得到 */
const CAPABILITY_PROOF: ReadonlyArray<readonly [string, readonly ConformanceScenarioName[]]> = [
  ['thinkingText', ['thinking-full']],
  ['toolInput', ['tool-shell', 'tool-edit', 'tool-plan']],
  ['toolResult', ['tool-shell', 'tool-edit']],
  ['subagent', ['subagent']],
  ['streamingDelta', ['plain-reply']],
];

/** 能力五态 → 允许的缺失原因（§2.7 的对应关系） */
const REASON_BY_CAPABILITY: Record<string, readonly MissingReason[]> = {
  no: ['not-supported'],
  'not-projected-by-vendor': ['not-exposed'],
  'off-by-adapter': ['not-observed', 'unverified'],
  unverified: ['unverified'],
};

const SCENARIO_ENTRIES = (fixture: ConformanceFixture): Array<[ConformanceScenarioName, () => ConformanceProduct]> =>
  Object.entries(fixture.scenarios) as Array<[ConformanceScenarioName, () => ConformanceProduct]>;

/** §6.2 的合并键公式：`<subagentId ?? 'main'>|<roundTrip>|<role>|<parentCallId ?? '-'>` */
export function mergeKeyOf(message: Pick<AgentMessage, 'subagentId' | 'roundTrip' | 'role' | 'parentCallId'>): string {
  return [message.subagentId ?? 'main', String(message.roundTrip), message.role, message.parentCallId ?? '-'].join('|');
}

/** 能力声明自身合规（§2.7）。zod 的 `superRefine` 已在 schema 层拦「yes 无 source / 非 yes 无 reason」 */
export function checkCapabilityDeclaration(fixture: ConformanceFixture): void {
  const parsed = MessageCapabilitySchema.safeParse(fixture.capability);
  if (!parsed.success) {
    throw new Error(`${fixture.kind} 的能力声明不合规：${JSON.stringify(parsed.error.issues)}`);
  }
}

/** 消息与子任务行过契约 schema（§2.1/§2.2/§2.8），环境过 §2.9 schema 或显式 null */
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
    const environment = build().environment;
    if (environment === null) continue;
    const parsed = AgentEnvironmentSchema.safeParse(environment);
    if (!parsed.success) throw new Error(`${fixture.kind}/${name} 的环境信息不合规：${JSON.stringify(parsed.error.issues)}`);
  }
}

/** 合并键必须等于公式（§6.2）：信封里那一格是算好的，消费方不再自己拼 */
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

/** §2.8 的桥：`parentCallId` 指向真实工具调用，`parentSubagentId` 指向真实子任务或 null；状态与「是否采到」分开记 */
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

/** §2.4–2.6：分量与合计同一把尺（「缺一格就整格 null」由 schema 保证：三个必填格是 `number`，整格才可空） */
export function checkUsagePairing(fixture: ConformanceFixture): void {
  for (const [name, build] of SCENARIO_ENTRIES(fixture)) {
    const { usage } = build();
    /*
     * 配对的方向是**单向**的：分量的「轮次」是**从合计推出来的**（claude 的 `index.ts`：
     * `subagentTurns = turns === null ? null : read.turns`）——合计不知道时分量必然为 `null`；
     * 反过来不成立（分量 token 可以独立采到，合计轮次却可能采不到）。
     * 2026-10-07 接 claude 时这条抓出过我的判据写反了方向，故在此写明理由。
     */
    if (usage.subagentTurns !== null && usage.turns === null) {
      throw new Error(`${fixture.kind}/${name}：给了 subagentTurns 却把合计 turns 记成 null（分量不可能比合计更清楚）`);
    }
    if (usage.turns !== null && usage.subagentTurns !== null && usage.subagentTurns > usage.turns) {
      throw new Error(`${fixture.kind}/${name}：subagentTurns 大于 turns（分量与合计不同尺）`);
    }
  }
}

/** §2.7：声明 `yes` 就必须造得出该块；声明非 `yes` 必须给出与该态对应的原因 */
export function checkCapabilityNailing(fixture: ConformanceFixture): void {
  const declaration = fixture.capability as unknown as Record<string, unknown>;
  for (const [cell, proofNames] of CAPABILITY_PROOF) {
    const state = declaration[cell];
    if (state === 'yes') {
      const usable = proofNames.filter((scenarioName) => fixture.scenarios[scenarioName] !== undefined);
      if (usable.length === 0) {
        throw new Error(`${fixture.kind}：${cell} 声明 yes，但没有任何能证明它的场景（缺 ${proofNames.join(' / ')}）`);
      }
      for (const scenarioName of usable) {
        assertCapabilityProof(fixture.kind, scenarioName, fixture.scenarios[scenarioName]!());
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

/** 断言某一格声明 `yes` 时，产物里**确实**出现了对应的块 */
function assertCapabilityProof(kind: string, scenario: ConformanceScenarioName, product: ConformanceProduct): void {
  const blocks = product.messages.flatMap((message) => message.blocks);
  switch (scenario) {
    case 'thinking-full':
    case 'thinking-encrypted':
      if (!blocks.some((block) => block.type === 'thinking')) {
        throw new Error(`${kind}：声明 thinkingText=yes，但 ${scenario} 场景里没有任何 thinking 块`);
      }
      return;
    case 'tool-shell':
    case 'tool-edit':
    case 'tool-plan':
      if (!blocks.some((block) => block.type === 'tool-call' && block.input !== null)) {
        throw new Error(`${kind}：声明 toolInput=yes，但 ${scenario} 场景里的 tool-call 块没有入参`);
      }
      return;
    case 'subagent':
      if (product.subagents.length === 0) {
        throw new Error(`${kind}：声明 subagent=yes，但 subagent 场景没有产出子任务行`);
      }
      return;
    default:
      if (!product.messages.some((message) => message.chunk === 'delta')) {
        throw new Error(`${kind}：声明 streamingDelta=yes，但 ${scenario} 场景里没有任何 delta 消息`);
      }
  }
}

/** §2.9：`present:false` 的环境项**必须**带 `missing`；§2.7 同一口径 */
export function checkMissingReasons(fixture: ConformanceFixture): void {
  for (const [name, build] of SCENARIO_ENTRIES(fixture)) {
    const environment = build().environment as { groups?: Array<{ items?: Array<Record<string, unknown>> }> } | null;
    for (const group of environment?.groups ?? []) {
      for (const item of group.items ?? []) {
        if (item.present === false && item.missing === undefined) {
          throw new Error(`${fixture.kind}/${name}：环境项 ${String(item.id)} 标了 present:false 却没给 missing`);
        }
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
 * §2.10：`finalText` 的三条通则（跨家同一把尺）。
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
        + '（这一格漏写＝评分通路永远拿不到答复）',
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

/** §2.3：行级事件只有三类，`log` 必须带 `stream`；§2.1：消息来源在闭集内 */
export function checkLineEventsAndSources(fixture: ConformanceFixture): void {
  const allowedSources: MessageSource[] = ['wire', 'hook', 'session-file', 'aggregate'];
  for (const [name, build] of SCENARIO_ENTRIES(fixture)) {
    const product = build();
    for (const event of product.events) {
      if (!['usage', 'log', 'error'].includes(String(event.type))) {
        throw new Error(`${fixture.kind}/${name}：出现了契约外的行级事件 ${JSON.stringify(event.type)}`);
      }
      if (event.type === 'log' && !['stdout', 'stderr'].includes(String(event.stream))) {
        throw new Error(`${fixture.kind}/${name}：log 事件缺少 stream`);
      }
    }
    for (const message of product.messages) {
      if (!allowedSources.includes(message.source)) {
        throw new Error(`${fixture.kind}/${name}：消息来源 ${message.source} 不在契约闭集内`);
      }
    }
  }
}

/**
 * §2.11 结构化输出（评分者通路）：逐场景跑探针。判据本体在 `./structured-output.ts`
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

/** 把全部判据注册成一家的用例；红的时候组名直接指向被违反的那条契约 */
export function describeProviderConformance(fixture: ConformanceFixture): void {
  const cases: ReadonlyArray<readonly [string, () => void]> = [
    ['能力声明自身合规（§2.7）', () => checkCapabilityDeclaration(fixture)],
    ['消息 / 子任务 / 环境过契约 schema（§2.1/2.2/2.8/2.9）', () => checkContracts(fixture)],
    ['合并键等于 §6.2 公式', () => checkMergeKeys(fixture)],
    ['子任务桥与状态口径（§2.8）', () => checkSubagentBridge(fixture)],
    ['用量与轮次配对（§2.4–2.6）', () => checkUsagePairing(fixture)],
    ['能力声明与产物互钉（§2.7）', () => checkCapabilityNailing(fixture)],
    ['缺失必须带原因（§2.9）', () => checkMissingReasons(fixture)],
    ['最终答复口径（§2.10）', () => checkFinalAnswer(fixture)],
    ['结构化输出与产出可解析（§2.11）', () => checkStructuredOutputGroup(fixture)],
    ['传输时序（C 类：缓冲补投 / 终态不早于响应 / 不重复）', () => checkTransportDeliveryGroup(fixture)],
    ['行级事件三类与来源闭集（§2.3/§2.1）', () => checkLineEventsAndSources(fixture)],
  ];
  describe(`${fixture.kind} 一致性套件`, () => {
    for (const [title, run] of cases) it(title, run);
  });
}
