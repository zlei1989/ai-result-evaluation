/**
 * 智能体消息契约（agent message spec v3 §2）：统一消息信封、内容块、工具族、子任务行、
 * 计量结构与能力声明。三家适配器**全部**归一成这里的形状，消费方（面板、导出、排障抽屉）
 * 因此永远只认一份形状，不必、也不许再问「这一条是哪个家发的」。
 *
 * 三条全局口径（违反其中任一条，下游就会把「没有」与「没采到」混为一谈）：
 *   1. `null` 只表示**未采集**，永远不等于 0：缺数据一律 `null`，禁止用 0 / 空串 / 空数组冒充；
 *   2. **不合成无法验证的值**：可以不采（`null`），不可以猜。文本类字段尤其如此——上游没给正文时，
 *      不得拿摘要、token 数或统计量顶替；
 *   3. **每个值都带来源**：同一字段在不同家可能来自事件流、会话文件或 hook，来源随值一起给出，
 *      否则消费方无法判断实时性与可比性。
 *
 * 为什么不与 `AgentEvent` 合成一个形状：事件是**行级**的（状态、日志、计量、失败、结束，
 * 供 SSE 与日志抽屉消费，按 `seq` 去重与续订），消息是**内容级**的（说话者、块、归属、往返序号，
 * 供对话视图与工具族统计消费）。两者的消费方、去重键与生命周期都不同，塞进一个联合只会让
 * 两边都出现用不到的可选格。
 */
import { z } from 'zod';
import { UsageTokensSchema } from './agent-event';

/** 数据来源：决定实时性与可信度，消费方必须读 */
export const MessageSourceSchema = z.enum(['wire', 'hook', 'session-file', 'aggregate']);
export type MessageSource = z.infer<typeof MessageSourceSchema>;

/** 块形态：`'delta'` 是增量片段，`'snapshot'` 是该块的当前完整内容 */
export const ChunkKindSchema = z.enum(['delta', 'snapshot']);
export type ChunkKind = z.infer<typeof ChunkKindSchema>;

/**
 * 工具族：十个族名，**由工具名决定，不由家决定**。
 * 归不进任何一族的工具，`family` 记 `null`，消费方对 `null` 走通用渲染（保留 `name` 原名）。
 */
export const TOOL_FAMILIES = [
  'read-file',
  'write-file',
  'edit-file',
  'search-content',
  'list-files',
  'run-shell',
  'web-search',
  'spawn-agent',
  'task',
  'ask-user',
] as const;
export const ToolFamilySchema = z.enum(TOOL_FAMILIES);
export type ToolFamily = z.infer<typeof ToolFamilySchema>;

/** 说话者：codex 的 `role` 由条目类型派生（事件流没有 role 概念） */
export const MessageRoleSchema = z.enum(['assistant', 'user', 'tool', 'system']);
export type MessageRole = z.infer<typeof MessageRoleSchema>;

/** 思考文本属于哪一档：完整推理 / 厂商摘要 / 有思考但无文本。**它不是能力位** */
export const ThinkingTextKindSchema = z.enum(['full', 'summary', 'none']);
export type ThinkingTextKind = z.infer<typeof ThinkingTextKindSchema>;

export const TextBlockSchema = z.object({ type: z.literal('text'), text: z.string() });

/**
 * 思考块。`text` 与 `textKind` 是**两个独立的事实**：
 *   · 有思考但拿不到文本 ⇒ `text: null` + `textKind: 'none'`（codex 的事件流那一格就是这样，
 *     它的 `reasoning` item 按厂商定义只给摘要，正文只在会话文件里）；
 *   · 拿到的是厂商摘要 ⇒ `text` 有值 + `textKind: 'summary'`。
 * `signature` 是签名 / 校验串，**只进审计视图**，正文与导出都不显示（codex 与 dsh 恒 `null`）。
 */
export const ThinkingBlockSchema = z.object({
  type: z.literal('thinking'),
  text: z.string().nullable(),
  textKind: ThinkingTextKindSchema,
  signature: z.string().nullable(),
});

/** 工具调用块：`input` 是**厂商原文**（codex 与 dsh 的 `arguments` 是 JSON 字符串，落这里前解析成对象） */
export const ToolCallBlockSchema = z.object({
  type: z.literal('tool-call'),
  callId: z.string(),
  /** 归一后的族名；无法归类时 `null` */
  family: ToolFamilySchema.nullable(),
  /** 厂商原始工具名（codex 可能是派生条目名，真名在会话文件里） */
  name: z.string(),
  input: z.unknown(),
});

/**
 * 工具结果块。
 * `structured` 是**结构化结果**（厂商给了才填，没有则 `null`——不是 `{}`）；
 * `truncated` 拿不到截断标记时只能记 `false`，消费方**不得**据此断定输出完整。
 */
export const ToolResultBlockSchema = z.object({
  type: z.literal('tool-result'),
  callId: z.string(),
  structured: z.unknown().nullable(),
  isError: z.boolean(),
  text: z.string(),
  truncated: z.boolean(),
});

/** 附件块：`path` 与 `mimeType` 都拿不到时为 `null`（dsh 的内容块里各带一个 attachment 引用） */
export const AttachmentBlockSchema = z.object({
  type: z.literal('attachment'),
  kind: z.enum(['image', 'file']),
  path: z.string().nullable(),
  mimeType: z.string().nullable(),
});

export const ContentBlockSchema = z.discriminatedUnion('type', [
  TextBlockSchema,
  ThinkingBlockSchema,
  ToolCallBlockSchema,
  ToolResultBlockSchema,
  AttachmentBlockSchema,
]);
export type ContentBlock = z.infer<typeof ContentBlockSchema>;
export type TextBlock = z.infer<typeof TextBlockSchema>;
export type ThinkingBlock = z.infer<typeof ThinkingBlockSchema>;
export type ToolCallBlock = z.infer<typeof ToolCallBlockSchema>;
export type ToolResultBlock = z.infer<typeof ToolResultBlockSchema>;
export type AttachmentBlock = z.infer<typeof AttachmentBlockSchema>;

/**
 * 统一消息信封。字段缺失语义（消费方义务同样写在这里，因为它们是契约的一半）：
 *
 * | 字段 | 为 `null` 的含义 | 消费方义务 |
 * |---|---|---|
 * | `vendorId` | 该家没有可用的消息级 id | 不得把它当去重键；用 `messageId` |
 * | `vendorTurn` | 该家没有厂商轮号 | 不得用 `roundTrip` 冒充（两者语义不同） |
 * | `step` | 该家没有「一轮内第几次调用」 | 不得按 `step` 分组做跨家对比 |
 * | `parentCallId` | 该家给不出派生关系 | 子任务归属改用 `subagentId` |
 * | `subagentId` | 这条来自主线程 | — |
 * | `assembly` | 恒为 `'snapshot'` 或 `'open'`（**不是可空格**） | `'open'` 时按「未收尾」呈现，不得当完整内容落盘 |
 */
export const AgentMessageSchema = z.object({
  /** 本项目生成的稳定消息 id（`<runId>:<seq>`），与厂商 id 解耦 */
  messageId: z.string(),
  /** 厂商侧消息 / 条目 id；厂商没有则为 `null` */
  vendorId: z.string().nullable(),
  role: MessageRoleSchema,
  source: MessageSourceSchema,
  /** 模型往返序号，从 1 递增；三家均为合成值，计数口径见 spec §3.1 */
  roundTrip: z.number().int().positive(),
  /** 厂商轮号（只有 dsh 有，且是**用户轮号**不是模型往返号）；无则为 `null` */
  vendorTurn: z.number().nullable(),
  /** 一轮内的第几次调用（只有 dsh 有）；无则为 `null` */
  step: z.number().nullable(),
  /** 派生这条消息的那次工具调用 id；无则为 `null` */
  parentCallId: z.string().nullable(),
  /** 子智能体身份；主线程消息为 `null` */
  subagentId: z.string().nullable(),
  /** 块形态 */
  chunk: ChunkKindSchema,
  /**
   * 这条消息里的块**收尾了没有**：`'snapshot'` = 每个块都已收到过快照（可当真相落盘与呈现），
   * `'open'` = 至少有一个块还停在增量累积值上（进程被中断，这一块没有等到它的快照）。
   *
   * 为什么需要这一格：块可以只有 delta（中断时快照永远不来），而「未收尾」必须能被渲染层区分出来。
   * **不得**用 `truncated` 表达这件事——那是 `tool-result` 块自己的字段（结果文本有没有被截断），
   * 文本块与消息都没有那一格。
   */
  assembly: z.enum(['snapshot', 'open']),
  /**
   * **覆盖合并键**（spec v3 §6.2 的「载体」）：`<subagentId ?? 'main'>|<roundTrip>|<role>|<parentCallId ?? '-'>`。
   *
   * 消费方按它覆盖式累积（后到的同名键**整条替换**），键内再按**块序号**（= `blocks` 数组下标，
   * 首次到达顺序，一经分配不再变化）或块的 `callId` 合并到块一级。三件事因此不必让每个消费方
   * 自己反推：① 哪些消息属于同一条逻辑消息；② 增量与快照怎么配对（合并键**不含 `messageId`**，
   * 同一个块的 delta 与 snapshot 是两条消息）；③ 覆盖的边界在哪。
   *
   * 为什么由适配器算好写进信封，而不是让消费方按字段现拼：拼法一旦有一处写错（例如漏掉
   * `parentCallId`），症状是「工具结果盖到正文块上」这种看着像内容错的**合并错**，而不是报错。
   */
  mergeKey: z.string(),
  /** 内容块，按到达顺序；数组下标就是块序号 */
  blocks: z.array(ContentBlockSchema),
  /** 该条消息的原始载荷（未归类字段原样保留，供排障） */
  raw: z.unknown(),
});
export type AgentMessage = z.infer<typeof AgentMessageSchema>;

/** 能力取值五态 */
export const CapabilitySchema = z.enum([
  'yes', // 有值，且来自厂商原生字段
  'no', // 这家结构上就没有这个能力
  'unverified', // 没验证过，不要当有也不要当没有
  'off-by-adapter', // 厂商有，但当前实现没接
  'not-projected-by-vendor', // 厂商侧有数据，但不投送到我们拿得到的通道
]);
export type Capability = z.infer<typeof CapabilitySchema>;

/** 缺失原因：与能力五态一一对应（`no → not-supported`、`not-projected-by-vendor → not-exposed`、`off-by-adapter → not-observed`/`unverified`） */
export const MissingReasonSchema = z.enum(['not-supported', 'not-exposed', 'not-observed', 'unverified']);
export type MissingReason = z.infer<typeof MissingReasonSchema>;

/** 子任务状态：采不到就 `'unknown'`，**不得用 `null` 表示未采集**（未采集的原因写在 `statusMissing`） */
export const SubagentStatusSchema = z.enum(['running', 'completed', 'failed', 'stopped', 'unknown']);
export type SubagentStatus = z.infer<typeof SubagentStatusSchema>;

/**
 * 子任务行：子任务**不走 `AgentMessage`**，而是一行一子任务的记录。
 * 两条硬规则：
 *   1. **状态与「状态是否采到」分开记**：`status` 永远给一个可渲染的值（采不到就 `'unknown'`），
 *      `statusMissing` 说明为什么采不到；
 *   2. **`outcome` 只放文本**：厂商给的是结构化对象时取其中的文本块；拿不到文本就 `null`，
 *      不得用推理内容、工具输出或状态文案顶替。
 */
export const SubagentRecordSchema = z.object({
  /** 子智能体 / 子线程身份；与厂商 id 同值（消费方在名称缺失时显示它前 8 位） */
  subagentId: z.string(),
  /** 展示名；采不到为 `null` */
  name: z.string().nullable(),
  /** 派发方式（如 `spawn_agent` / `subagent` / `Task`），采不到为 `null` */
  kind: z.string().nullable(),
  source: MessageSourceSchema,
  status: SubagentStatusSchema,
  /** `null` = 状态已采集到；非 `null` = 未采集到的原因 */
  statusMissing: MissingReasonSchema.nullable(),
  /** 结果摘要（子智能体的最终答复）；取消场景可能为 `null` */
  outcome: z.string().nullable(),
  /** 嵌套父链；顶层子任务为 `null` */
  parentSubagentId: z.string().nullable(),
  /** 该子任务自己的用量；采不到为 `null` */
  usage: UsageTokensSchema.nullable(),
});
export type SubagentRecord = z.infer<typeof SubagentRecordSchema>;

/**
 * 消息日志（`messages.jsonl`）里的一行：**内容流与派发视图共用一条流**。
 *
 * 为什么把子任务行与消息放进同一个文件、而不各开一份：两者是同一次运行的**两条并行内容流**
 * （说话者与内容块 / 子任务身份与终态），消费方（对话视图与派发面板）按 `type` 分流即可。
 * 各开一份的代价是「一次运行要落两处、读两处，还得保证两处一致」——而它们本来就来自同一条
 * 适配器回调，分开只会多一个对不上的机会。
 */
export const RowRecordSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('message'), message: AgentMessageSchema }),
  z.object({ type: z.literal('subagent'), subagent: SubagentRecordSchema }),
]);
export type RowRecord = z.infer<typeof RowRecordSchema>;

/**
 * 能力声明：每家每次运行都带一份，说明「这次到底能拿到什么」。
 * 两条**必须成立**的对应关系（`superRefine` 拦在解析层，不靠调用方自觉）：
 *   · `'yes'` ⇒ 必须同时给出 `source`（这一格的值从哪条通道取到）；其余四态的 `source` 为 `null`；
 *   · 非 `'yes'` ⇒ 必须配一条 `reason`；`'yes'` 的 `reason` 为 `null`。
 *
 * 每一格的 `source` / `reason` 是**这一格**的，不是整份声明的：codex 的思考正文来自会话文件、
 * 而它的事件流那一格按厂商定义只有摘要（`not-projected-by-vendor`）——两件事必须能同时表达。
 */
export const MessageCapabilitySchema = z
  .object({
    thinkingText: CapabilitySchema,
    thinkingTextKind: ThinkingTextKindSchema,
    toolInput: CapabilitySchema,
    toolResult: CapabilitySchema,
    subagent: CapabilitySchema,
    streamingDelta: CapabilitySchema,
    /** 思考文本这一格的取数通道；`'yes'` 时必填，其余情况为 `null` */
    thinkingTextSource: MessageSourceSchema.nullable(),
    /** 思考文本为什么取不到；非 `'yes'` 时必填 */
    thinkingTextReason: MissingReasonSchema.nullable(),
    /** 工具入参这一格的取数通道；`'yes'` 时必填，其余情况为 `null` */
    toolInputSource: MessageSourceSchema.nullable(),
    /** 工具入参为什么取不到；非 `'yes'` 时必填 */
    toolInputReason: MissingReasonSchema.nullable(),
    /** 工具结果这一格的取数通道；`'yes'` 时必填，其余情况为 `null` */
    toolResultSource: MessageSourceSchema.nullable(),
    /** 工具结果为什么取不到；非 `'yes'` 时必填 */
    toolResultReason: MissingReasonSchema.nullable(),
    /** 子任务这一格的取数通道；`'yes'` 时必填，其余情况为 `null` */
    subagentSource: MessageSourceSchema.nullable(),
    /** 子任务为什么取不到；非 `'yes'` 时必填 */
    subagentReason: MissingReasonSchema.nullable(),
    /** 流式增量这一格的取数通道；`'yes'` 时必填，其余情况为 `null` */
    streamingDeltaSource: MessageSourceSchema.nullable(),
    /** 流式增量为什么取不到；非 `'yes'` 时必填 */
    streamingDeltaReason: MissingReasonSchema.nullable(),
    /**
     * **这一族能力成立的前提**（路由 / 模型 / 开关）。空数组 = 无条件成立。
     * 为什么必须有这一格：同一份能力位在不同路由下取值不同（codex 的多智能体在自建网关路由上
     * 会被判 `unsupported call`，在另一条路由上整条派发链跑得通），把某一条路由上的取值写成
     * 这家的固有属性，会让消费方在另一条路由上读到一句假话。
     */
    notes: z.array(z.string()),
  })
  .superRefine((value, ctx) => {
    // 逐格校验：「这一格是不是 yes」与「它的 source / reason 对不对得上」必须一致，
    // 否则会出现「声明说采得到、实际没有取数通道」这种自相矛盾的能力位
    const cells = [
      ['thinkingText', value.thinkingText, value.thinkingTextSource, value.thinkingTextReason],
      ['toolInput', value.toolInput, value.toolInputSource, value.toolInputReason],
      ['toolResult', value.toolResult, value.toolResultSource, value.toolResultReason],
      ['subagent', value.subagent, value.subagentSource, value.subagentReason],
      ['streamingDelta', value.streamingDelta, value.streamingDeltaSource, value.streamingDeltaReason],
    ] as const;
    for (const [field, capability, source, reason] of cells) {
      if (capability === 'yes' && source === null) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: `${field} 为 yes ⇒ 必须给出取数通道` });
      }
      if (capability !== 'yes' && reason === null) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: `${field} 为 ${capability} ⇒ 必须给出缺失原因` });
      }
    }
    if (value.thinkingText !== 'yes' && value.thinkingTextKind !== 'none') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['thinkingTextKind'],
        message: 'thinkingText 非 yes ⇒ thinkingTextKind 按 none 填',
      });
    }
  });
export type MessageCapability = z.infer<typeof MessageCapabilitySchema>;
