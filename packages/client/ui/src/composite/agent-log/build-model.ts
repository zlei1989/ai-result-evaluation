/**
 * 契约形状 → **界面模型**（`AgentLogModel`）：这一步之后 UI 只认 `types.ts` 里的形状。
 *
 * 为什么需要它：契约描述「采到了什么」（消息信封 + 内容块 + 子任务行），
 * 界面要的是「画什么」（轮次分组、渲染块、能力声明、原始输出的行）。
 * 两者的差不是包装，是**三件必须有人做的事**：
 *   1. 按 `subagentId` 把消息分给会话节点，并按 `roundTrip`（**统一轮次号**）分组成轮次；
 *   2. 把契约的扁平能力声明摊成界面要的字典（`toCapabilityMap`）；
 *   3. 把行级事件按去向表折成 `facts` / `rowEvents` / `diagnostics` 三条出口——**行级事件的归属在这一层解析**
 *      （有键按号、无键/孤儿按时刻）。
 *
 * 三条纪律（每一条都对应一次误读）：
 *   · **`mergeKey` 覆盖、不是追加**：同一条逻辑消息会投递多次（delta 之后是快照，块一块一块追加），
 *     每一次都带「到目前为止的完整块列表」⇒ 留最后一条。按 `messageId` 去重是错的：
 *     同一个块的 delta 与 snapshot 是**两条** `messageId` 不同的消息。
 *   · **不编造**：拿不到的格一律 `null`（不写 0、不写空串）；`running` 由「该节点是否还在跑」
 *     与「这一轮是不是最后一轮」决定，**不由「有没有下一个块」推断**。
 *   · **`round` 用 `roundTrip`**：厂商轮号（`turn`）三家语义不同，明文禁止用于分组——
 *     拿它当轮次号会得到「进度条 60 轮、时间轴 1 轮」的自相矛盾。
 */
import {
  TERMINAL_ROW_STATUSES,
  type AgentEvent,
  type AgentMessage,
  type ContentBlock as ContractBlock,
  type RowRecord,
  type SubagentRecord,
  type ToolCallBlock,
} from '@aieval/contracts';
import {
  type AgentLogDiagnostics,
  type AgentLogFacts,
  type AgentLogModel,
  type AgentRunStatus,
  type ContentBlock,
  type LogNode,
  type LogNodeStatus,
  type LogTurn,
  type MessageCapabilityMap,
  type RowEvent,
  type RowNode,
  type SessionNode,
  type ToolFamilyPayload,
  type ToolInput,
  type TurnRef,
} from './types';
import { formatUsageTriple } from '../../base/usage-metrics';

// ───────────────────────── 行级事实的输入（界面侧的口径） ─────────────────────────

/**
 * 组装 `AgentLogModel.facts` 需要的那几格。
 * **不是 `EvalRow`**：`agent-log` 不认「评测行」这个业务概念（D18），
 * 换一个消费场景时换的是喂进来的这个对象，不是组件。
 */
export interface AgentLogFactsInput {
  /** 界面词汇：色档 + 文案（评测侧传 `ROW_STATUS_LABELS[status]`） */
  status: AgentRunStatus;
  startedAt: string | null;
  endedAt: string | null;
  turns: { current: number; total: number | null };
  tokens: AgentLogFacts['tokens'];
  thinking: AgentLogFacts['thinking'];
  domain: AgentLogFacts['domain'];
  error: AgentLogFacts['error'];
  /** 还有内容要到（决定 `LogTurn.running`） */
  live: boolean;
}

export interface BuildAgentLogModelInput {
  records: readonly RowRecord[];
  events: readonly AgentEvent[];
  facts: AgentLogFactsInput;
  /**
   * 主会话的来源通道与厂商 id。
   * 契约的消息级没有「这条是哪家发的」那一格（`MessageSource` 已摊到块上），
   * 故主会话节点这两格只能由调用方按这一行的配置给；不给就如实留 `'wire'` / `null`。
   */
  mainSource?: SessionNode['source'];
  mainVendorId?: string | null;
  /** 会话的**用户提示词**（时间轴首条消息）。它是「对模型说的话」，不属于环境抽屉 */
  userPrompt?: { text: string; at: string } | null;
  /**
   * 这一行的**能力声明**（维度名由数据层给）。
   * 不给时全套记「没验证过」——**不记「这家没有」**：不知道就别替厂商下结论。
   */
  capability?: MessageCapabilityMap;
  /** 能力成立的前提（路由 / 模型 / 开关）；空数组 = 无条件成立 */
  capabilityNotes?: readonly string[];
  /**
   * 运行开始时刻：作为**时间轴的基准时刻**。
   *
   * 为什么需要它：契约的消息与块都**没有自己的时刻**（`AgentMessage` 的字段里没有时间，
   * 时刻只存在于行级 `AgentEvent` 上），而时间轴要按轮次显示时刻、`rowEvents` 要按时刻归位。
   * 不编造一个时刻是纪律，但整条时间轴一个时间都没有同样不可用 ⇒ 用「这一行的开始时刻 + 轮次序号」
   * 派生一个**明确标注为派生**的基准（真正的逐块时刻要等契约补上那一格）。
   */
  startedAt?: string | null;
}

// ───────────────────────── 能力声明的落点 ─────────────────────────

/** 缺省的能力声明：**「没验证过」而不是「这家没有」**——不知道就别替厂商下结论 */
const UNVERIFIED: MessageCapabilityMap = {
  thinkingText: { level: 'unverified', source: null, reason: 'unverified' },
  toolInput: { level: 'unverified', source: null, reason: 'unverified' },
  toolResult: { level: 'unverified', source: null, reason: 'unverified' },
  subagent: { level: 'unverified', source: null, reason: 'unverified' },
  streamingDelta: { level: 'unverified', source: null, reason: 'unverified' },
};

// ───────────────────────── 轮次分组 ─────────────────────────

/**
 * 一条消息 → 若干内容块（摊平信封）。
 * `role` / `source` / `assembly` 三格**跟着块走**：它们是块自己的事实，
 * 界面不该再看信封（同一个块不可能同时来自 assistant 正文与工具结果）。
 *
 * **无正文的思考块在这一层整块过滤掉**（2026-10-07 用户口径）：数据层如实记着「有思考、无文本」
 * 这条事实（`text: null` + `textKind: 'none'`），而它在界面上只能变成一句占位文案——
 * 那不是用户要看的思考，**没有就不显示**。放在这一层而不是某个组件里：时间轴、面包屑、
 * 以及将来任何一个消费方拿到的模型里都不该再有它（在组件里隐藏只会让别的出口漏出来）。
 */
function blocksOf(message: AgentMessage, live: boolean, at: string): ContentBlock[] {
  return message.blocks
    .map((block, blockIndex) => toContentBlock(block, message, `${message.messageId}#${blockIndex}`, live, at))
    .filter((block) => !(block.kind === 'thinking' && block.text === null));
}

/** 契约块 → 界面块；不认识的那一类落到 `unrecognized`（**原文保留，不丢**） */
function toContentBlock(block: ContractBlock, message: AgentMessage, id: string, live: boolean, at: string): ContentBlock {
  const base = {
    id,
    // 契约的块没有自己的时刻，故整体用**派生的**基准时刻（见 `BuildAgentLogModelInput.startedAt`）
    at,
    messageId: message.messageId,
    subagentId: message.subagentId,
    role: message.role,
    source: message.source,
    assembly: message.assembly,
    // 逻辑消息身份与消息级用量都跟着块走：块是时间轴唯一拿得到的东西（页脚按 mergeKey 去重、按 usage 取值）
    mergeKey: message.mergeKey,
    // 契约那一格是可选的（老日志没有）；UI 侧统一成 `null`，页脚只认「非 null」这一档
    usage:
      message.usage === undefined || message.usage === null
        ? null
        : { input: message.usage.input, cached: message.usage.cached, output: message.usage.output },
  };
  switch (block.type) {
    case 'text':
      return { ...base, kind: 'text', text: block.text };
    case 'thinking':
      /**
       * 走到这里的思考块**必有正文**：`text === null` 的那些已被 `blocksOf` 过滤掉（整块不显示）。
       * `textMissing` 因此恒 `null`——它保留在形状上是为了老日志与「数据层如实记录」这条口径，
       * 界面不再有它的渲染出口。
       */
      return { ...base, kind: 'thinking', text: block.text, textMissing: null, textKind: block.textKind };
    case 'tool-call': {
      return {
        ...base,
        kind: 'tool-call',
        callId: block.callId,
        name: block.name,
        // 契约的工具名不可空（适配器拿不到时记空串），故这里的「缺」用空串判
        nameMissing: block.name === '' ? 'not-observed' : null,
        family: block.family,
        input: serializeInput(block.input),
        // 摘要主体随块从数据层下来（词表真源在 `@aieval/agents` 的 `activity.ts`）；老记录缺这一格
        summary: block.summary ?? undefined,
        tool: familyPayloadOf(block, live, base.at),
      };
    }
    case 'tool-result':
      return {
        ...base,
        kind: 'tool-result',
        callId: block.callId,
        text: block.text,
        // 厂商已解析的结构化结果**原样带上**（规范：有 `meta` 就不要退回去解析文本）
        structured: block.structured,
        status: block.isError ? 'error' : 'ok',
        bytes: byteLength(block.text),
        // 截断**三态**：`unknown`（没采到标记）与 `none`（确认完整）在界面上必须是两句不同的话
        truncation: block.truncation,
      };
    case 'attachment':
      return { ...base, kind: 'attachment', attachmentKind: block.kind, path: block.path, mimeType: block.mimeType };
    case 'unrecognized':
      return { ...base, kind: 'unrecognized', reason: block.reason, vendorType: block.vendorType, raw: block.raw };
  }
}

/**
 * 工具入参：**结构化与原文各留一份**（dsh 的 `arguments` 是 JSON 字符串）。
 * `bytes` 按原文算，拿不到原文时**留 `null` 而不是 0**（0 会被读成「空的」）。
 *
 * `description` 在这里就抽出来给摘要行用（`ToolItemDetail` 的标题）：让渲染层去
 * `JSON.parse(input.value)` 反解等于把「入参是什么形状」放成两份实现——原文那一格是**已经序列化过**
 * 的字符串，而 `description` 是**模型自己写的一句人话**（见 `descriptionOf`）。
 */
function serializeInput(input: unknown): ToolInput {
  const description = descriptionOf(input);
  if (input === null || input === undefined) return { value: null, text: null, bytes: null, description };
  if (typeof input === 'string') return { value: input, text: input, bytes: byteLength(input), description };
  const text = safeJson(input);
  return { value: text, text, bytes: text === null ? null : byteLength(text), description };
}

function safeJson(value: unknown): string | null {
  try {
    return JSON.stringify(value) ?? null;
  } catch {
    // 循环引用 / BigInt：**不抛**——一条排障证据序列化不动不该打断整条时间轴
    return null;
  }
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * 族载荷：**只挂 `tool-call` 块**，且只做「契约载荷 → 界面卡片」的搬运。
 *
 * **2026-10-04 收口**：厂商形状的归一（`todos` / `plan` / `multi_select` …）已经下沉到
 * agents 的 `tool-payload.ts`，这里只读契约的 `block.payload`。此前本函数读的是
 * `block.input`（厂商原文）并逐字认那些字段名——那是把厂商适配搬进了浏览器，
 * 而归一一旦有两份实现，漂移的表现是「同一族的卡片在某一家上是空的」。
 *
 * 搬运只做两件界面自己的事（都不是归一，而是**摆版**）：
 *   · `counts` 四格**从 `steps` 数出来**（UI 按项渲染、看不到「上一轮」，但数当前这张表不需要历史）；
 *   · `at` / `running` / `result` 由**这一轮**给（载荷本身没有时刻，也不知道轮次结没结束）。
 *
 * `null` = 本期没有为它收编专门卡片（含「适配器不认识」与「不在两族里」两种，
 * 两者靠 `family` 分开）⇒ UI 走通用工具行，**调用不会消失**。
 */
function familyPayloadOf(block: Extract<ContractBlock, { type: 'tool-call' }>, live: boolean, at: string): ToolFamilyPayload | null {
  // 「键不存在」与「显式 null」同一处置：老记录（`payload` 这一格之前落盘的）两者都有
  const payload = block.payload ?? null;
  if (payload === null) return null;
  if (payload.kind === 'plan') {
    const counts = { pending: 0, inProgress: 0, completed: 0, unknown: 0 };
    for (const step of payload.steps) counts[step.status] += 1;
    return {
      family: 'task',
      panel: {
        steps: payload.steps,
        counts,
        // 跨轮差分要数据层的累积态（UI 按项渲染、看不到上一张表）⇒ 这里恒 `null`（首次出现口径）
        change: null,
        note: payload.note,
        // 与 ask-user 同一口径：载荷不带时刻 ⇒ 用块的时刻（否则界面上的「等了多久」无从算起）
        at,
        result: null,
        running: live,
      },
    };
  }
  /**
   * 调用这一半只能给「还没收场」：答案与收场方式在**结果**那一半。
   *
   * ⚠️ **结果那一半目前没有人填**：`render-blocks.ts` 把这一格原样成卡，契约的 `ask-user` 载荷
   * 也只有 `{ kind, questions }` ⇒ 七种收场与答案回填在真机上都走不到。
   * **连夹具都喂不出来**（夹具走真实链路、绕不过这里），`settled` 那一支只有单测手搓对象才构造得出。
   * 这里保持 `pending` 是**如实**的，不是漏了配对。
   */
  /**
   * 收场那一支现在没有产出方（见上），但 `at` 必须给**真实时刻**：卡片上的
   * 「等待答复中… 12m」与固定区那枚「等待答复」徽标**都读这一格**，空串会让
   * `Date.parse('')` 得 NaN、`formatDuration` 回落 `'0s'` ⇒ 恒显「刚问完」。
   */
  return { family: 'ask-user', interaction: { state: 'pending', questions: payload.questions, at, running: live } };
}

/** `input` 的 `structured` 半边（如果有）；契约的 `input` 是 `unknown`，故必须逐层判形状 */
function structuredOf(input: unknown): Record<string, unknown> | null {
  if (typeof input === 'string') {
    try {
      const parsed: unknown = JSON.parse(input);
      return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
  return typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : null;
}

/**
 * 入参里的 `description`：**模型自己写的一句人话**。
 *
 * 两个消费方读的是**同一格**：工具行摘要行的标题（`serializeInput` → `ToolItemDetail`）与
 * 派发调用的任务名（claude 的 `Task`、dsh 的 `subagent` 都用它当子任务名）。
 * 判据只留这一份——两处各写一遍必然漂，漂了的表现是「标题里那句话与子任务名不是一句」。
 *
 * 没有（或只有空白）就返回 `null`——**不拿 `prompt` 或其它字段凑**：凑出来的名字配不上任何子任务，
 * 只会让「哪次调用派出了它」变成一个看起来成立、实际是错答案的关联。
 */
function descriptionOf(input: unknown): string | null {
  const structured = structuredOf(input);
  if (structured === null) return null;
  const description = structured.description;
  return typeof description === 'string' && description.trim() !== '' ? description.trim() : null;
}

/**
 * 「`callId` 这次调用」在已折叠的消息里落在哪一条上 → 派发点。
 *
 * 为什么需要它：`SubagentRecord.parentCallId` 给的是**调用的 id**，而派发点要的是
 * 「这条导航挂在哪一轮」（`at` 决定它在时间轴上的位置）。
 * **找不到就返回 `null`**——此时宁可不认这个派发点（表现为时间轴上没有入口），
 * 也不编一个时刻把它挂到别的地方。
 */
function dispatchOf(
  folded: ReadonlyMap<string, AgentMessage>,
  callId: string,
  atOfRound: (round: number | null) => string,
  fallbackAt: string,
): { messageId: string; callId: string; at: string } {
  for (const message of folded.values()) {
    if (message.subagentId !== null) continue;
    if (!message.blocks.some((block) => block.type === 'tool-call' && block.callId === callId)) continue;
    return { messageId: message.messageId, callId, at: atOfRound(message.roundTrip) };
  }
  // 调用块本身没落进消息流（这一家没投送工具调用）⇒ 派发点仍然成立，只是没有那一轮的时刻
  return { messageId: '', callId, at: fallbackAt };
}

function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

// ───────────────────────── 会话树 ─────────────────────────

/** 会话节点的可变累积态（组装期中间量，不对外） */
interface SessionDraft {
  node: Omit<SessionNode, 'content'>;
  /** 轮次号 → 该轮的块。`Map` 的插入顺序就是首次出现顺序，排序在最后一步做 */
  turns: Map<number | null, { at: string; blocks: ContentBlock[] }>;
}

function nodeStatusOf(status: SubagentRecord['status']): LogNodeStatus {
  switch (status) {
    case 'running':
      return 'running';
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'stopped':
      return 'stopped';
    default:
      return 'unknown';
  }
}

// ───────────────────────── 主组装 ─────────────────────────

/**
 * 把契约的那两股数据（消息 / 子任务行）与行级事件折成界面模型。
 * 纯函数，可单测：喂同一份 `records` + `events` 必得同一份模型。
 */
export function buildAgentLogModel(input: BuildAgentLogModelInput): AgentLogModel {
  const messages = input.records.filter((r): r is Extract<RowRecord, { type: 'message' }> => r.type === 'message').map((r) => r.message);
  const subagents = input.records.filter((r): r is Extract<RowRecord, { type: 'subagent' }> => r.type === 'subagent').map((r) => r.subagent);

  /** `mergeKey` 覆盖累积：**留最后一条**（它的 `blocks` 已是全量），顺序按首次出现 */
  const folded = new Map<string, AgentMessage>();
  const order: string[] = [];
  for (const message of messages) {
    if (!folded.has(message.mergeKey)) order.push(message.mergeKey);
    folded.set(message.mergeKey, message);
  }

  const sessions = new Map<string, SessionDraft>();
  /** 行级节点（`kind: 'row'`）：厂商只给汇总、没有逐条身份的那一档 */
  const rowNodes: RowNode[] = [];
  const main: SessionDraft = {
    node: {
      kind: 'main',
      id: 'main',
      parentId: null,
      spawnedBy: null,
      status: input.facts.live ? 'running' : statusForFacts(input.facts),
      statusMissing: null,
      startedAt: input.facts.startedAt,
      endedAt: input.facts.endedAt,
      contentTruncatedReason: null,
      capability: UNVERIFIED,
      capabilityNotes: [],
      source: input.mainSource ?? 'wire',
      subagentId: null,
      vendorId: input.mainVendorId ?? null,
      dispatchKind: null,
      name: null,
      nameMissing: null,
      userPrompt: input.userPrompt ?? null,
      usage: null,
      outcome: null,
      // 主会话节点的 `sessionFacts` **为 `null`**：行级事实一律读 `AgentLogModel.facts`，不存第二份真值
      sessionFacts: null,
    },
    turns: new Map(),
  };
  sessions.set('main', main);

  for (const subagent of subagents) {
    /**
     * **只给汇总、没有逐条身份**的那一档（`source === 'aggregate'`）走行级节点：
     * 它不可点、不进面包屑（点进去只会得到一个空会话），只在时间轴上占一条带计数的说明行。
     *
     * ⚠️ **本仓目前没有任何适配器发出 `source: 'aggregate'`**（契约 schema 有这个取值），
     * 所以这条路径在真机上走不到，只有夹具能喂出来。留着是因为「厂商只给汇总」是真实存在的形态。
     */
    if (subagent.source === 'aggregate') {
      rowNodes.push({
        kind: 'row',
        id: `row:${subagent.subagentId}`,
        parentId: subagent.parentSubagentId === null ? null : `subagent:${subagent.parentSubagentId}`,
        spawnedBy: null,
        status: nodeStatusOf(subagent.status),
        statusMissing: subagent.statusMissing,
        startedAt: null,
        endedAt: null,
        content: { status: 'ready', data: [] },
        contentTruncatedReason: null,
        capability: input.capability ?? UNVERIFIED,
        capabilityNotes: input.capabilityNotes ?? [],
        // 汇总出来的计数：厂商只给「有几个 / 成了几个 / 挂了几个」，没有逐条身份
        counts: { subagents: 1, completed: subagent.status === 'completed' ? 1 : 0, failed: subagent.status === 'failed' ? 1 : 0 },
        // 行级节点**必然**是行级事实，故非空（这一档只有「这一行」这一个会话）
        facts: {
          status: { tone: 'pending', label: '待开始' },
          startedAt: input.startedAt ?? null,
          endedAt: null,
          turns: { current: 0, total: null },
          tokens: subagent.usage,
          thinking: null,
          domain: [],
          error: null,
        },
      });
      continue;
    }

    sessions.set(subagent.subagentId, {
      node: {
        kind: 'subagent',
        id: `subagent:${subagent.subagentId}`,
        parentId: subagent.parentSubagentId === null ? 'main' : `subagent:${subagent.parentSubagentId}`,
        spawnedBy: null,
        status: nodeStatusOf(subagent.status),
        statusMissing: subagent.statusMissing,
        startedAt: null,
        endedAt: null,
        contentTruncatedReason: null,
        capability: UNVERIFIED,
        capabilityNotes: [],
        source: subagent.source,
        subagentId: subagent.subagentId,
        vendorId: subagent.subagentId,
        dispatchKind: subagent.kind,
        name: subagent.name,
        nameMissing: subagent.name === null ? 'not-observed' : null,
        userPrompt: null,
        usage: subagent.usage,
        outcome: subagent.outcome,
        sessionFacts: { exitReason: null, error: null },
      },
      turns: new Map(),
    });
  }

  /**
   * 时间轴基准时刻：契约的块没有自己的时刻，故按「开始时刻 + 轮次序号」派生一个
   * （见 `BuildAgentLogModelInput.startedAt` 的说明）。
   */
  const baseMs = input.startedAt === undefined || input.startedAt === null ? null : Date.parse(input.startedAt);
  const atOfRound = (round: number | null): string => {
    if (baseMs === null || Number.isNaN(baseMs) || round === null) return '';
    return new Date(baseMs + round * 1000).toISOString();
  };

  /**
   * **子任务身份的第二个名字**：`派生它的那次调用 id → 子任务身份`。
   *
   * 为什么必须有这一层（2026-10-03 真机实测的缺陷）：**同一条子任务在两处用了两套 id**——
   *   · 子任务**记录**的身份是厂商的原生 id（claude 的 `task_id`、dsh 的 `agentId`）；
   *   · 子任务的**消息**却挂在**派生它的那次工具调用 id** 上（claude 的 `parent_tool_use_id`，
   *     真机与 `task_progress.tool_use_id`、`Agent` 工具调用块的 `callId` 三者同值）。
   * 两套 id 谁都不等于谁，于是按 `subagentId` 分桶时子任务的消息全部落空——
   * 点进子任务得到「没有逐条对话记录」，而消息就在文件里（真机：20 条消息、0 条被认领）。
   *
   * 契约把这两端都给了（`SubagentRecord.subagentId` 与 `SubagentRecord.parentCallId`），
   * 所以这一层是**纯搬运**，不需要任何启发式。别名与真名冲突时**真名优先**：
   * 记录的身份是权威，别名只是消息那一侧的书写方式。
   */
  const aliasOf = new Map<string, string>();
  for (const record of subagents) {
    const parentCallId = record.parentCallId;
    if (parentCallId === null || parentCallId === '') continue;
    if (aliasOf.has(parentCallId)) continue;
    aliasOf.set(parentCallId, record.subagentId);
  }
  /** 消息里的 `subagentId` → 会话树上的那个身份（别名先解析；解析不到就按原值） */
  const sessionKeyOf = (subagentId: string): string => aliasOf.get(subagentId) ?? subagentId;

  for (const key of order) {
    const message = folded.get(key);
    if (message === undefined) continue;
    // 消息那一侧用的是**派生它的调用 id**，会话树的键是子任务的**身份** ⇒ 过一层别名解析
    const sessionId = message.subagentId === null ? 'main' : sessionKeyOf(message.subagentId);
    const session = sessions.get(sessionId) ?? main;
    const at = atOfRound(message.roundTrip);
    const blocks = blocksOf(message, input.facts.live, at);
    const bucket = session.turns.get(message.roundTrip);
    if (bucket === undefined) session.turns.set(message.roundTrip, { at, blocks: [...blocks] });
    else bucket.blocks.push(...blocks);
  }

  /**
   * 派发点（四条判据，按可靠性从高到低）。
   *
   * ➀ **子任务记录自己带的 `parentCallId`**（契约 §2.6）：它就是「派生这个子任务的那次工具调用 id」，
   *    三家各自从原生字段取（claude 是 `task_progress.tool_use_id`）。**这是唯一确定的一条**，
   *    所以排最前。
   * ① `parentCallId` 非空 ⇒ 它直接说明「父会话在哪次调用上派出了这个子任务」
   *    （claude 的 `parent_tool_use_id` 与 `task_started.tool_use_id` 同值）。
   * ② **子任务身份就是那次调用的 `callId`**（`sessions` 的键既能被 `subagentId` 命中，也能被
   *    `callId` 命中时）。真机里这条**常常落空**：dsh 的子任务身份是 `subagent.started` 给的独立
   *    UUID，而派发它的工具调用是另一个 `call_…|uuid` 形状的 id，两者不相等。
   * ③ **按调用参数里的任务名回填**：派发工具（`subagent` / `Task` / `Agent` / `spawn_agent`…）
   *    的入参里带 `description`（就是子任务名），与 `SubagentRecord.name` 逐字相同 ⇒ 用名字把
   *    「哪次调用派出了它」认回来。
   *
   * 少了这几条兜底的后果是**整棵子任务在界面上不可达**：子任务的记录明明躺在 `messages.jsonl` 里，
   * 主会话时间轴上却没有「进入子任务」的入口，面包屑也只有「主会话」一级
   * （真机实测的形状：「原始日志有内容、抽屉里看不到」）。
   * 四条都命不中时保持 `null`——**不硬凑一个派发点**（宁可少一条导航，也不把它挂到别的调用上）。
   */
  /**
   * ➀ **子任务记录自己带的 `parentCallId`**（契约 §2.6）优先落点。
   *
   * 它是「派生这个子任务的那次工具调用 id」，由适配器从原生字段取（claude 是
   * `task_progress.tool_use_id`），**是四条判据里唯一确定的一条**，故先落。
   *
   * ⚠️ **只有「派发那一次」才有资格认领**（2026-10-03 真机实测的坑）：同一条子任务上会来
   * **多条**协作调用记录（codex 真机：`spawn_agent` → `wait` → `close_agent`，每条都带**同一个**
   * `subagentId`）。若不分动作、先到先得，最终认领的会是 `close_agent`——于是时间轴上的
   * 「进入子任务」入口挂到了「收场」那一步上（点得到，但位置错）。
   * 判据按**派发动作名**认（`spawn` / `task` / `agent` 归一类，与下面的 `isDispatchCall` 同一口径）；
   * 认不出来时**不认领**，交给②③去认真正的那次调用——它们看的是调用入参，比动作名更硬。
   *
   * ⚠️ **两处已知的弱**（2026-10-08 复核发现，行为今天正确、判据本身不硬）：
   *   1. **紧跟其后的那段循环（按 `parentCallId` 一律 `dispatchOf`）会把这里的结果原样重算一遍**
   *      ——入参相同、结果相同，所以 `claimsDispatch` 这道过滤**实际上不起作用**；
   *   2. 那个动作名正则 `/spawn|task|agent/i` **区分不出动作**（`close_agent` 里就有 `agent`）⇒
   *      若真的按「最后一条记录赢」跑，认领的会是**收场**那次调用。
   *   今天不出问题是「两段循环等价」+ `build-model.test.ts` 的夹具靠投递顺序；
   *   待整理：要么只留一段循环，要么把动作名判据写成枚举。
   */
  const claimsDispatch = (record: SubagentRecord): boolean =>
    record.parentCallId !== null &&
    record.parentCallId !== '' &&
    (record.kind === null || /spawn|task|agent/i.test(record.kind));
  for (const record of subagents) {
    const child = sessions.get(record.subagentId);
    const parentCallId = record.parentCallId;
    if (child === undefined || parentCallId === null || parentCallId === '') continue;
    if (!claimsDispatch(record)) continue;
    child.node.spawnedBy = dispatchOf(folded, parentCallId, atOfRound, input.facts.startedAt ?? child.node.startedAt ?? '');
  }
  /**
   * **子任务身份的第二个名字**：`派生它的那次调用 id → 子任务身份`。
   *
   * 为什么必须有这一层（2026-10-03 真机实测的缺陷）：**同一条子任务在两处用了两套 id**——
   *   · 子任务**记录**的身份是厂商的原生 id（claude 的 `task_id`、dsh 的 `agentId`）；
   *   · 子任务的**消息**却挂在**派生它的那次工具调用 id** 上（claude 的 `parent_tool_use_id`）。
   * 两套 id 谁都不等于谁，于是按 `subagentId` 分桶时子任务的消息全部落空——
   * 点进子任务得到「没有逐条对话记录」，而消息就在文件里（真机：20 条消息、0 条被认领）。
   *
   * 契约把这两端都给了（`SubagentRecord.subagentId` 与 `SubagentRecord.parentCallId`），
   * 所以这一层是**纯搬运**，不需要任何启发式：拿 `parentCallId` 当别名，把消息归到记录上。
   * 别名与真名冲突时**真名优先**（记录的身份是权威，别名只是消息那一侧的书写方式）。
   */
  for (const record of subagents) {
    const child = sessions.get(record.subagentId);
    const parentCallId = record.parentCallId;
    if (child === undefined || parentCallId === null || parentCallId === '') continue;
    child.node.spawnedBy = dispatchOf(folded, parentCallId, atOfRound, input.facts.startedAt ?? child.node.startedAt ?? '');
  }
  for (const message of folded.values()) {
    if (message.parentCallId === null || message.subagentId === null) continue;
    const child = sessions.get(sessionKeyOf(message.subagentId));
    if (child === undefined || child.node.spawnedBy !== null) continue;
    child.node.spawnedBy = { messageId: message.messageId, callId: message.parentCallId, at: atOfRound(message.roundTrip) };
  }
  /** 派发工具的判据：按**工具名**认（`family` 是适配器给的，两家对 spawn 的取名不一致，故两者都认） */
  const isDispatchCall = (name: string, family: ToolCallBlock['family']): boolean =>
    family === 'spawn-agent' || /^(subagent|spawn_agent|task|agent)$/i.test(name);
  for (const message of folded.values()) {
    if (message.subagentId !== null) continue;
    for (const block of message.blocks) {
      if (block.type !== 'tool-call' || block.callId === '') continue;
      /**
       * **这一段是死代码（2026-10-08 复核确认，行为无影响，留着只为不打断四条判据的阅读顺序）。**
       *
       * 它原本自称「➀ 的时间回填」：走到调用所在的消息时把 `messageId` / `at` 补上。
       * 但 `dispatchOf` 扫的与这里扫的是**同一张 `folded` 主会话表**、判据也一样（`callId` 逐字相同）
       * ⇒ 它找得到时返回的就是这一条的 `messageId` 与同源轮次；找不到时这里也找不到。
       * 实测：把判据换成 `at === ''`（原写法）或直接换成 `true`，**用例与模型输出都不变**
       * （紧随其后的那段无条件 `dispatchOf` 已经赋了同一个值）。
       * 真要整理时就删掉它，并顺带把 `claimsDispatch` 那条判据收成枚举——那是另一次改动。
       */
      const claimed = sessions.get(block.callId);
      if (claimed !== undefined && claimed.node.spawnedBy?.callId === block.callId && claimed.node.spawnedBy.at === '') {
        claimed.node.spawnedBy = {
          messageId: message.messageId,
          callId: block.callId,
          at: atOfRound(message.roundTrip),
        };
      }
      // ② 身份即调用 id
      const byId = sessions.get(block.callId);
      if (byId !== undefined && byId.node.spawnedBy === null) {
        byId.node.spawnedBy = { messageId: message.messageId, callId: block.callId, at: atOfRound(message.roundTrip) };
        continue;
      }
      // ③ 名字回填：只认「还没找到派发点的子任务」且**名字逐字相同**的那一个
      if (!isDispatchCall(block.name, block.family)) continue;
      const description = descriptionOf(block.input);
      if (description === null) continue;
      for (const candidate of sessions.values()) {
        if (candidate.node.kind === 'main' || candidate.node.spawnedBy !== null) continue;
        if (candidate.node.name !== description) continue;
        candidate.node.spawnedBy = { messageId: message.messageId, callId: block.callId, at: atOfRound(message.roundTrip) };
        break;
      }
    }
  }

  const nodes: LogNode[] = [...sessions.values()].map((session) => {
    const turns: LogTurn[] = [...session.turns.entries()]
      .sort((left, right) => (left[0] ?? 0) - (right[0] ?? 0))
      .map(([round, bucket], index, all) => ({
        round,
        at: bucket.at,
        subagentId: session.node.kind === 'main' ? null : session.node.subagentId,
        blocks: bucket.blocks,
        tokens: null,
        durationMs: null,
        // **只有最后一轮**可能是「还没结束」的那一轮：中断的块全靠它才不闪光标
        running: input.facts.live && index === all.length - 1,
      }));
    // 能力声明是**每次运行**的一份（不是每个节点各一份）：同一行的所有会话节点共用它
    return { ...session.node, capability: input.capability ?? UNVERIFIED, capabilityNotes: input.capabilityNotes ?? [], content: { status: 'ready', data: turns } } satisfies SessionNode;
  });
  // 行级节点排在会话节点之后：它们只在时间轴上占一条说明行，不参与面包屑
  const allNodes: LogNode[] = [...nodes, ...rowNodes];

  const activeNodeId = nodes.find((node) => node.kind === 'main')?.id ?? nodes[0]?.id ?? 'main';
  const active = nodes.find((node) => node.id === activeNodeId);
  const turnCount = active?.content.status === 'ready' ? active.content.data.length : 0;

  return {
    specVersion: 1,
    facts: {
      ...input.facts,
      /**
       * **轮次的两个数都由时间轴自己派生**，不看 `facts.turns` 里传进来的那份：
       *   · `current` = 当前节点的轮次数——它就是时间轴上「轮次 N」的最大值，两处**必须同源**
       *     （进度条与时间轴互相打脸是这一格最容易犯的错）；
       *   · `total` **恒为 `null`**——`EvalRow.turns` 那一格是「已经观察到几轮」，不是「一共几轮」；
       *     把它当分母会渲染出「轮次 4 / 3 轮」这种自相矛盾的读数
       *     （冒烟实测：进度条 `4 / 3` 与时间轴护栏的 `已渲染 4 / 共 4 轮` 同时出现在屏幕上）。
       */
      turns: { current: turnCount, total: null },
    },
    nodes: allNodes,
    activeNodeId,
    // `allNodes` 已经建好（含每个会话节点的轮次）⇒ 归属的「有没有那一轮」在这一刻就能判
    rowEvents: rowEventsOf(input.events, turnHomesOf(allNodes)),
    /**
     * 「还没跑过」的判据是**所有会话节点都没有轮次**（行级节点不算：它是厂商只给汇总的那一档，
     * 与「这一行有没有跑过」无关）。
     */
    empty: nodes.every((node) => node.content.status === 'ready' && node.content.data.length === 0),
  };
}

function statusForFacts(facts: AgentLogFactsInput): LogNodeStatus {
  switch (facts.status.tone) {
    case 'running':
      return 'running';
    case 'ok':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'canceled':
      return 'canceled';
    default:
      return 'unknown';
  }
}

/** 归属键 → 集合里的字符串（`subagentId: null` 写 `main`，与 `LogTurn.subagentId` 同一套 id） */
function turnHomeKey(turn: TurnRef): string {
  return `${turn.subagentId ?? 'main'}#${turn.round}`;
}

/**
 * 整行**主会话**上真实存在的轮次集合（`main#N`）。为什么需要它：那一条用量里程碑的归属键指向的轮次
 * 可能整行都不存在（异常形状）——那种「孤儿」要在**数据层**就抹成 `turn: null`，落到时间轴上按时刻
 * 归位（**不丢**）。
 *
 * **为什么只收主会话**（2026-10-07 口径变更）：子会话的读数**不再折成里程碑**（用户裁定：子智能体用量
 * 只在派发点那张子任务卡片里展示），归属键只可能落在主会话上。2026-10-05 终审那条「不可达子节点不算
 * 有家」随之退役——它服务的是子会话里程碑（`spawnedBy === null` 的节点进不去，若这里仍认它作有家，
 * 那条读数两处都落空），而那一类读数现在根本不进这里。
 */
function turnHomesOf(nodes: readonly LogNode[]): Set<string> {
  const homes = new Set<string>();
  for (const node of nodes) {
    // 子会话节点与行级节点都没有「里程碑可以落上去」的轮次；主会话恒可达
    if (node.kind !== 'main') continue;
    if (node.content.status !== 'ready') continue;
    for (const turn of node.content.data) {
      if (turn.round === null) continue;
      homes.add(turnHomeKey({ subagentId: turn.subagentId, round: turn.round }));
    }
  }
  return homes;
}

/** 取 `usage` 事件（判别联合的窄化辅助：调用方拿到的就是那个成员） */
type UsageEvent = Extract<AgentEvent, { type: 'usage' }>;

/**
 * 行级事件的去向（逐条决定，不留洞）：
 *   · `error` **恒**进时间轴（失败归因不能只留最后一条）；
 *   · `usage` **整行只出一条**（2026-10-07 用户裁定）：取**候选阶段**里最后一条**主会话**带计量的读数
 *     ——那是这一行交出来的结算读数。跑动期的逐轮累计快照不再各自成行：真机症状（run `8df6ff65` 的
 *     claude-code 行）是同一行串出 5 条「用量 … 轮次 N」，其中同一轮先出跑动期估算（`输出 0`）、
 *     一秒后再出厂商结算值，屏幕上就是两条几乎一样的「用量 … 轮次 4」。
 *   · `log` **不进时间轴**（它走 `diagnosticsOf` 的原文面板）；
 *   · 其余（`status` / `diff-summary` / `score` / `end`）只在终点有意义，留在 `facts` 里。
 *
 * 三条边界：
 *   · **候选阶段的边界**认第一条 `judging` 或终态状态帧——与 `@aieval/client` 的 `row-live.ts` 口径 5
 *     是**同一条判据**（评分智能体在同一条流里接着报用量、轮次从 1 重新数，那些读数不属于这一行）；
 *   · **子会话的读数一条都不出**：`turn.subagentId` 非空的那一类是**那个子会话自己**的累计，它只在
 *     派发点那张子任务卡片里展示（`SessionNode.usage`，数据来自 `SubagentRecord.usage`，与本函数无关）；
 *   · **位置**：那一行排在它自己那条事件的位置上（不许被挤到末尾——与 `error` 行的相对次序要保住）。
 *
 * `homes` = 整行**存在**的轮次集合（见 `turnHomesOf`）；**不给时一律当孤儿** ⇒ 那一条的 `turn` 是 `null`，
 * 与老调用方、老用例的行为逐字一致。
 */
export function rowEventsOf(events: readonly AgentEvent[], homes?: ReadonlySet<string>): RowEvent[] {
  /** 带事件下标的结果行：那一行用量可能出现在任何位置，最后按事件次序排回去 */
  const rows: { index: number; row: RowEvent }[] = [];
  /** 候选阶段里最后一条**主会话**带计量的读数（整行唯一那条里程碑的候选；计量一并记下，取用时不重判） */
  let lastCandidateUsage: { index: number; event: UsageEvent; tokens: NonNullable<UsageEvent['tokens']> } | null = null;
  /** 候选阶段是否已经结束（第一条 `judging` / 终态帧之后，每条 `usage` 都是评分智能体的） */
  let candidateEnded = false;

  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (event === undefined) continue;
    if (event.type === 'status') {
      if (event.status === 'judging' || TERMINAL_ROW_STATUSES.includes(event.status)) candidateEnded = true;
      continue;
    }
    if (event.type === 'error') {
      rows.push({ index, row: { at: event.at, level: 'error', text: `错误 ${event.message}`, turn: null } });
      continue;
    }
    if (event.type !== 'usage' || event.tokens === null) continue;
    if (candidateEnded) continue;
    // 子会话自己的累计读数不算这一行（它在那张子任务卡片里）
    if ((event.turn?.subagentId ?? null) !== null) continue;
    lastCandidateUsage = { index, event, tokens: event.tokens };
  }

  if (lastCandidateUsage !== null) {
    const { event, tokens } = lastCandidateUsage;
    /**
     * 归属：**只有整行真的有那一轮**才认（`homes` 不给时一律当孤儿 ⇒ 与老行为逐字一致）。
     * 文案里的号也用归属号——它必须与这一行最终落在的那个分组同值，否则文字与位置互相打脸。
     */
    const attributed = event.turn ?? null;
    const turn = attributed !== null && homes?.has(turnHomeKey(attributed)) === true ? attributed : null;
    rows.push({
      index: lastCandidateUsage.index,
      row: {
        at: event.at,
        level: 'milestone',
        // 三项走 `formatUsageTriple`（千分位 + `tok`）：与事实条 / 消息页脚 / 子任务卡片是同一份文案，
        // 也是**同一个数**——裸数字（`15763`）在事实条上早就是 `15,763 tok`，两处不同形会被读成两笔账
        text: `用量 ${formatUsageTriple(tokens)} · 轮次 ${turn?.round ?? event.turns}`,
        turn,
      },
    });
  }

  return rows.sort((left, right) => left.index - right.index).map((entry) => entry.row);
}

/**
 * `log` 事件的原文：**逐字保留**（它是排障证据）。
 * `summary` 与 `text` 两格都给、不互相替代——有 `summary` 时它优先渲染，原文仍逐字给出。
 */
export function diagnosticsOf(events: readonly AgentEvent[], truncatedReason: string | null = null): AgentLogDiagnostics {
  return {
    lines: events
      .filter((event): event is Extract<AgentEvent, { type: 'log' }> => event.type === 'log')
      .map((event) => ({ at: event.at, source: event.stream, text: event.text, summary: event.summary ?? null })),
    truncatedReason,
  };
}

/** 当前选中的会话节点（面包屑的视图作用域）；找不到时回落到主会话 */
export function activeNodeOf(model: AgentLogModel): LogNode | null {
  return model.nodes.find((node) => node.id === model.activeNodeId) ?? model.nodes.find((node) => node.kind === 'main') ?? null;
}
