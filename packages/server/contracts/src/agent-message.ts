/**
 * 智能体消息契约：统一消息信封、内容块、工具族、子任务行、
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
 * 为什么不与 `AgentEvent` 合成一个形状：事件是**候选级**的（状态、日志、计量、失败、结束，
 * 供 SSE 与日志抽屉消费，按 `seq` 去重与续订），消息是**内容级**的（说话者、块、归属、往返序号，
 * 供对话视图与工具族统计消费）。两者的消费方、去重键与生命周期都不同，塞进一个联合只会让
 * 两边都出现用不到的可选格。
 */
import { z } from 'zod';
import { UsageTokensSchema } from './agent-event';
import {
  AskUserChannelSchema,
  AskUserOutcomeSchema,
  type AskUserChannel,
  type AskUserOutcome,
} from './ask-user-vocab';
import { InjectionBoundarySchema, type InjectionBoundary } from './inject-vocab';

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

/**
 * 一条消息是**谁带进来的**：`'case-prompt'` = 题面那一档（这一轮的输入本来就是它），
 * `'human'` = 人在这一轮**已经开始之后**插进来的那句。
 *
 * 为什么账本必须有这一格：两者在形状上完全同形（都是 `role: 'user'` 的文本），
 * 复盘时唯一能分开它们的就是这一格——而「这一轮被人插过话」正是「还能不能与别的轮次比」的线索。
 * 带默认值（默认 = 题面那一档）⇒ 旧账本照读；只有真的由人插进来的那一条才写 `'human'`。
 */
export const MessageOriginSchema = z.enum(['case-prompt', 'human']);
export type MessageOrigin = z.infer<typeof MessageOriginSchema>;

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

/**
 * 清单的一步（`TaskStep`）。
 * `id` / `owner` / `blockedBy` 是**只有 claude 有**的三维（它的 `Task*` 是工作项注册表），
 * 另两家恒 `null`——「缺就是缺」，不编一个空依赖表出来。
 */
export const TaskStepSchema = z.object({
  /** 稳定 id；`null` = 这一家给不出（**不自己发号**：编出来的 id 会让依赖看起来解析成功了） */
  id: z.string().nullable(),
  subject: z.string(),
  /** 四态。`unknown` 是**独立的一档**（既不是「待办」也不是「完成」），不能并进任何一边 */
  status: z.enum(['pending', 'inProgress', 'completed', 'unknown']),
  /** `null` = 这一家没有「指派」这个概念（整格不显示）；`''` = 有概念但当前无人认领 */
  owner: z.string().nullable(),
  /** 依赖的 id 列表；拿不到为 `null` */
  blockedBy: z.array(z.string()).nullable(),
});

/** `task` 族的调用载荷：**本次调用之后的整张清单**（跨轮差分是消费方的事，这里只给当前值） */
export const TaskPlanPayloadSchema = z.object({
  kind: z.literal('plan'),
  steps: z.array(TaskStepSchema),
  /** 厂商给的一句话说明（codex 的 `explanation`：为什么改计划）；没有为 `null` */
  note: z.string().nullable(),
});

/** 一个提问选项。`recommended` 由适配器从厂商写法归一（三家用「放首位」或 `recommended` 表达） */
export const AskUserOptionSchema = z.object({
  label: z.string(),
  description: z.string().nullable(),
  recommended: z.boolean(),
});

/**
 * 一个问题（三家并集）。
 *
 * `header` 是 `string` 而**不是** `nullable`：它是厂商给的**展示标签**，而回填答案的配对键
 * （`AskUserAnswer.header`）本身就是字符串——两处对「没有标题」用两种表示，配对逻辑就得在
 * 两个值域之间来回转换，转错一次的症状是「答案配到了另一个问题上」，比少画一个 Tag 严重得多。
 * **代价如实登记**：「厂商没给标题」与「厂商给了空标题」在这一格上不可分（两者都落 `''`）。
 */
export const AskUserQuestionSchema = z.object({
  header: z.string(),
  /** = 三家的 `question`（v2 spec 的命名） */
  prompt: z.string(),
  options: z.array(AskUserOptionSchema),
  /** = claude `multiSelect` / dsh `multi_select`（默认 `false`） */
  multiSelect: z.boolean(),
  /** = codex `isOther`：允不允许自由输入（界面据此追加「其它（自由输入）」一行） */
  allowOther: z.boolean(),
  /** = codex `isSecret`：默认遮罩（**显示口径，不是安全边界**） */
  secret: z.boolean(),
});

/** `ask-user` 族的调用载荷：**问出去的那几个问题**（答案在 `tool-result` 那一半） */
export const AskUserPayloadSchema = z.object({
  kind: z.literal('ask-user'),
  questions: z.array(AskUserQuestionSchema),
});

/**
 * **一份答案**：与 `AskUserQuestionSchema` 配对的另一半（问题在 `tool-call` 那一半，
 * 答案在 `tool-result` 那一半）。
 *
 * 四条口径：
 *   · `header` 是**唯一的配对键**，与问题侧同一个字段、同一个值域；`selected` 装的是
 *     **选项标签**，不是 id 也不是下标——标签是问题与答案两边都逐字持有的那一份，
 *     而 id 与下标会在下游重新编号时错位，症状是「答案配到了另一个问题上」；
 *   · `selected` 与 `custom` 的关系**按单选 / 多选分档**（同一份答案形状表达两件事）：
 *     **多选 = 并存**——自由输入是**补充项**，勾选的标签与那句话都在（消费方两半都要读，
 *     少读一半就丢信息）；**单选 = 覆盖**——用户自己写的那句话就是全部答案，`selected` 取
 *     **空数组**（留着被覆盖的选项会让答卷自相矛盾）；
 *   · **不得假设 `selected` 与 `custom` 互斥**：多选两格同时有值是常态，而单选也可能出现
 *     `selected` 非空且 `custom` 非空的历史记录（契约从第一天起就允许这一形状，回放要照读；
 *     界面的产出方今天在单选上会禁用选项并交了空数组，但那是产出方的口径，不是消费方的判据）；
 *   · `custom` 的 `null` = 没写自己的话，`''` = 写了但内容为空——两种事实不许互相顶替。
 */
export const AskUserAnswerSchema = z.object({
  header: z.string(),
  selected: z.array(z.string()),
  custom: z.string().nullable(),
});

/**
 * 收场方式与提问通道两份词表的**定义**在 `ask-user-vocab.ts`（消息账本与候选级事件共用，见那里的头注），
 * 这里只把它们摆在既有的导出面上：本文件的消费方（答案形状、交互面声明）与包根出口因此一个字都不用改。
 */
export { AskUserChannelSchema, AskUserOutcomeSchema };
export type { AskUserChannel, AskUserOutcome };
/**
 * `ask-user` 族的**结果载荷**：这一问最后怎么收场、拿到的是什么答案——「答案在 `tool-result` 那一半」
 * 的那一份（问题在 `tool-call` 那一半，见 `AskUserPayloadSchema`）。
 *
 * 三条口径：
 *   · **不重复问题**：配对靠 `tool-result.callId` ↔ `tool-call.callId`，读侧从调用那一半拿问题
 *     （卡片要一起显示「问的什么」与「答的什么」），两边各存一份只会漂；
 *   · **两格成对**：`outcome === 'answered'` 一定有答案数组（空数组 = 答了但一个选项都没选），
 *     其余六态 `answers` 恒 `null`（「收场了但没有答案」与「答了空」是两件事）；
 *   · **它是 `structured` 那一格的形状，不是 `text` 的**：`text` 是给人看的措辞（各家渲染不同），
 *     而这一份是逐字回填答案的数据面——只读卡片的回填只认它。
 */
export const AskUserResultSchema = z.object({
  outcome: AskUserOutcomeSchema,
  answers: z.array(AskUserAnswerSchema).nullable(),
});
export type AskUserResult = z.infer<typeof AskUserResultSchema>;

/**
 * **族载荷**：只挂 `tool-call` 块，且只给「本次调用之后的归一结果」。
 *
 * 为什么要归一：`input` 是**厂商原文**，形状由厂商定（`todos` 还是 `plan`、`multiSelect`
 * 还是 `multi_select`）。消费方要渲染一张清单卡片就得逐字认这些字段名——那是把厂商适配
 * 搬进了界面层，而本仓的边界是「厂商差异全部吸收在 agents 包内」（`tool-payload.ts` 是落点）。
 *
 * 三条口径：
 *   · `payload: null` **不是错误**：族不在本期两族里、或厂商形状认不出，都落它 ⇒ 消费方走
 *     通用工具行（**调用不会消失**，只是没有专门卡片）；
 *   · `kind` 与 `family` **必须对得上**（`plan` ↔ `task`、`ask-user` ↔ `ask-user`）。
 *     这条不变量由适配器保证并有守卫，不写进 schema：加了 `superRefine` 的 schema 不能再做
 *     判别联合的成员（zod 要求成员是 `ZodObject`），而 `ContentBlockSchema` 正是按 `type` 判别的；
 *   · 空表（`steps: []` / `questions: []`）与 `null` 是**两件事**：前者是「厂商给了空表」。
 */
export const ToolCallPayloadSchema = z.discriminatedUnion('kind', [
  TaskPlanPayloadSchema,
  AskUserPayloadSchema,
]);
export type ToolCallPayload = z.infer<typeof ToolCallPayloadSchema>;
export type TaskStep = z.infer<typeof TaskStepSchema>;
export type AskUserQuestion = z.infer<typeof AskUserQuestionSchema>;
export type AskUserAnswer = z.infer<typeof AskUserAnswerSchema>;

/** 工具调用块：`input` 是**厂商原文**（codex 与 dsh 的 `arguments` 是 JSON 字符串，落这里前解析成对象） */
export const ToolCallBlockSchema = z.object({
  type: z.literal('tool-call'),
  callId: z.string(),
  /** 归一后的族名；无法归类时 `null` */
  family: ToolFamilySchema.nullable(),
  /** 厂商原始工具名（codex 可能是派生条目名，真名在会话文件里） */
  name: z.string(),
  input: z.unknown(),
  /**
   * **参数解析失败时厂商给的原文**（`null` / 缺省 = 这一次调用没这个问题）。
   *
   * 为什么要有这一格：pi 的 `ToolCall.argumentsError`（厂商原文 *Set when the model's complete
   * arguments text was not a valid JSON object. `arguments` is then `{}`*）与「模型真的传了空对象」
   * 在 `input` 上**逐字同形**——两者都是 `{}`。不给它一个落点，界面上只能显示一个空对象，
   * 而事实是「参数不是合法 JSON（原文在这一格）」。真机读数见
   * 真机探针报告（不入库）的 P3。
   *
   * **可缺**（与 `payload` 同一条理由）：磁盘上已有的 `messages.jsonl` 没有这一格，写成必填会让
   * 老记录在回放 / SSE 续订时成片解析失败；读侧把「键不存在」与显式 `null` 当同一件事（`?? null`）。
   */
  inputError: z.string().nullable().optional(),
  /**
   * 归一后的族载荷；`null` = 本期没有为它收编卡片（见 `ToolCallPayloadSchema`）。
   *
   * **可缺**（与 `usage.timing` 同一条理由）：磁盘上已有的 `messages.jsonl`
   * 里没有这一格，写成必填会让所有老记录在回放 / SSE 续订时**成片解析失败**。
   * 读侧因此要把「键不存在」与「显式的 `null`」当同一件事（`?? null`）。
   *
   * **代价如实登记**：可缺 ⇒ 手搓一个 `tool-call` 块会**静默**少掉这一格（类型上不拦）。
   * 故本仓只允许经 `toolCallBlockDraft` 构造工具块，`providers/**` 里出现 `type: 'tool-call'`
   * 字面量由 `static-assertions.test.ts` 拦下。
   */
  payload: ToolCallPayloadSchema.nullable().optional(),
  /**
   * **一句话活动摘要**（`调用工具 Read：a.ts`、`更新计划：3 步`）。
   *
   * 为什么放进消息、而不是让界面自己从 `name` / `input` 算：那句话的词表（参数优先级、计划类特判、
   * 单行化与截断）在 `@aieval/agents` 的 `activity.ts`，而按分层表 `ui` / `client` **不许** import 它——
   * 界面自算就是第二份实现，漂移的症状是「同一件事在两处长成两句话」。它与 `log.summary`
   * 由**同一个函数**产出（真源仍只有一处），不是两份词表。
   *
   * **可缺**（与 `payload` 同一条理由）：磁盘上已有的 `messages.jsonl` 里没有这一格，写成必填会让
   * 老记录在回放 / SSE 续订时成片解析失败。读侧把「键不存在」当「没采到」（`?? null`），
   * 活动行据此回落到「调用工具 <名字>」。
   */
  summary: z.string().optional(),
});

/**
 * 截断**三态**。
 *
 * 为什么不是布尔：拿不到截断标记时只能记「没采到」，而**消费方不得据此断定输出完整**
 * （规范逐字）。裸布尔会让界面上「确认完整」与「不知道完不完」完全一样——
 * 那正是「用负信号断言正事实」。
 */
export const TruncationStateSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }),
  z.object({ kind: z.literal('truncated'), reason: z.string().nullable() }),
  z.object({ kind: z.literal('unknown') }),
]);
export type TruncationState = z.infer<typeof TruncationStateSchema>;

/**
 * 工具结果块。
 * `structured` 是**结构化结果**（厂商给了才填，没有则 `null`——不是 `{}`）；
 * `truncation` 由数据层判定：`none` = 确认没被截断、`truncated` = 确认被截断、
 * `unknown` = **没采到标记**（UI 写「输出可能不完整」，不写「完整」）。
 */
export const ToolResultBlockSchema = z.object({
  type: z.literal('tool-result'),
  callId: z.string(),
  structured: z.unknown().nullable(),
  isError: z.boolean(),
  text: z.string(),
  truncation: TruncationStateSchema,
});

/**
 * 附件的两档：图片与文件。单独一格是因为**两个地方都要用**——账本里的附件块（厂商回灌的或我们
 * 落账本的）与人工消息的附件清单（上传那一刻按 `File.type` 分档）。两处各写一遍
 * `z.enum(['image', 'file'])` 的话，将来加第三档（如音频）时必有一处漏改，
 * 而症状是「同一份附件在队列表里是 `file`、在账本里是 `image`」这种静默的分类漂移。
 */
export const AttachmentKindSchema = z.enum(['image', 'file']);
export type AttachmentKind = z.infer<typeof AttachmentKindSchema>;

/**
 * 附件块：`path` 与 `mimeType` 都拿不到时为 `null`（dsh 的内容块里各带一个 attachment 引用）。
 * 它指的是**认识的真实附件**（图片 / 文件），与「不认识的厂商载荷」语义正交——
 * 后者走 `UnrecognizedPayloadBlock`。两者同名会让下一个人把两条路当成一条，
 * 而后果是图片被画成一大段 base64、或一段原始载荷被画成附件。
 */
export const AttachmentBlockSchema = z.object({
  type: z.literal('attachment'),
  kind: AttachmentKindSchema,
  path: z.string().nullable(),
  mimeType: z.string().nullable(),
});

/**
 * 一条人工消息的**附件上限**（前后端从同一处读）。
 *
 * 为什么服务端也要拦：界面上的拦截只为体验，绕过界面直接 POST 一样进得来。
 * 为什么按大小与条数拦、**不设类型白名单**：文件不直接交给智能体，它自己去读——拦类型等于替它
 * 决定「哪些文件有用」，而它读不了的时候会自己说。
 * 超限的中文原因要**点名是哪一条限制**，否则用户不知道该删文件还是换小文件。
 */
export const ATTACHMENT_MAX_FILE_BYTES = 20 * 1024 * 1024;
export const ATTACHMENT_MAX_PER_MESSAGE = 10;

/**
 * **不认识的厂商载荷**：无法归一的原样保留（规范把它放在 `AttachmentBlock` 之外是合理的）。
 * 它是「原样保留」，不是「一行文字」——正文是该载荷的原文 `raw`，`reason` 说明为什么落到这里。
 * 一处必须守住的取舍：**不把 `raw` 推给「下载台账」**，台账是给人看的文本行，承载不了原样载荷。
 */
export const UnrecognizedPayloadBlockSchema = z.object({
  type: z.literal('unrecognized'),
  /** `unrecognized` = 类型本身不认识；`unmapped-shape` = 类型认识但形状对不上 */
  reason: z.enum(['unrecognized', 'unmapped-shape']),
  /** 厂商原始类型（如 `session/title`、`todo_list`），仅供参考 */
  vendorType: z.string().nullable(),
  raw: z.string().nullable(),
});

/**
 * **模型看过的一张图片**：厂商只给路径，不给内容。
 *
 * 为什么不复用 `attachment`：附件的语义是「随这条消息带过来的东西」（资料），而这一格是
 * **模型主动看了一眼本机的一张图**（一次动作）——两者在界面上要画成两件事，合成一格会让
 * 「这一轮带了什么」与「它看了什么」互相顶替。
 *
 * `path` 是厂商原文（codex 给绝对路径）。**能否预览不由契约定**：那取决于这一刻的宿主能否
 * 读到那张图（工作区范围、文件是否还在），属于读侧的事实。
 */
export const ImageViewBlockSchema = z.object({
  type: z.literal('image-view'),
  path: z.string(),
});

export const ContentBlockSchema = z.discriminatedUnion('type', [
  TextBlockSchema,
  ThinkingBlockSchema,
  ToolCallBlockSchema,
  ToolResultBlockSchema,
  AttachmentBlockSchema,
  ImageViewBlockSchema,
  UnrecognizedPayloadBlockSchema,
]);
export type ContentBlock = z.infer<typeof ContentBlockSchema>;
export type TextBlock = z.infer<typeof TextBlockSchema>;
export type ThinkingBlock = z.infer<typeof ThinkingBlockSchema>;
export type ToolCallBlock = z.infer<typeof ToolCallBlockSchema>;
export type ToolResultBlock = z.infer<typeof ToolResultBlockSchema>;
export type AttachmentBlock = z.infer<typeof AttachmentBlockSchema>;
export type ImageViewBlock = z.infer<typeof ImageViewBlockSchema>;
export type UnrecognizedPayloadBlock = z.infer<typeof UnrecognizedPayloadBlockSchema>;

/**
 * 统一消息信封。字段缺失语义（消费方义务同样写在这里，因为它们是契约的一半）：
 *
 * | 字段 | 为 `null` 的含义 | 消费方义务 |
 * |---|---|---|
 * | `vendorId` | 该家没有可用的消息级 id | 不得把它当去重键；用 `messageId` |
 * | `turn` | 该家没有厂商轮号 | 不得用 `roundTrip` 冒充（两者语义不同） |
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
  /**
   * 这一条由谁带进来（见 `MessageOriginSchema`）。**带默认值**：旧账本没有这一格，
   * 写成必填会让回放 / SSE 续订成片解析失败；缺省即「题面那一档」，与旧数据的事实一致。
   */
  origin: MessageOriginSchema.default('case-prompt'),
  /**
   * **这个候选被分成几段执行，这一条属于第几段**：缺省（= 0）= 第一次跑那一段，`n ≥ 1` = 第 n 次追问那一段。
   *
   * 为什么账本必须有这一格：一次追问是**又开一次 `run()`**，厂商那一侧的轮次从 1 重新数 ⇒ 两段的
   * `roundTrip` 撞号、`mergeKey` 逐字相同（`main|1|assistant|-`）。按 `mergeKey` 覆盖累积的读侧于是
   * 让后一段把前一段的同号消息**整条吃掉**（症状：追问之后首段的思考与工具调用凭空消失、
   * 追问那句落在首段的轮次里）。带上段号，折叠键与轮次分组键才有区分两段的能力。
   *
   * 三条口径：
   *   · **只有追问那一侧写它**，第一次跑那一段与旧账本一样**整格缺席** ⇒ 旧数据照读、旧行为逐字不变
   *     （写 `0` 与缺席同义，故不为了「显式」把 0 落到每一条上）；
   *   · 段号与候选快照的 `followUpRounds` 同源（都是「第几次追问」），故界面上那一行段标题与卡片计数对得上；
   *   · 它是**归属**不是序号——同段内所有消息（含适配器投的、人工插的、提问结算的）共用一个值。
   */
  segment: z.number().int().min(0).optional(),
  /** 模型往返序号，从 1 递增；三家均为合成值 */
  roundTrip: z.number().int().positive(),
  /**
   * 厂商轮号（只有 dsh 有，且是**用户轮号**不是模型往返号）；无则为 `null`。
   *
   * ⚠️ 别与用量事件里那一格 `turn` 混：那是**归属**（`{subagentId, round}`，`UsageTurn`），
   * 回答「这次读数属于哪个会话的第几次模型往返」；本格是厂商自己的**用户轮号**。
   */
  turn: z.number().nullable(),
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
   * **覆盖合并键**（「载体」）：`<subagentId ?? 'main'>|<roundTrip>|<role>|<parentCallId ?? '-'>`。
   *
   * ⚠️ **它只在同一段内唯一**：追问那一段的轮次从 1 重新数 ⇒ 两段的键会逐字相同。消费方按
   * **`(segment, mergeKey)`** 覆盖累积（见 `segment` 那一格），键内再按**块序号**（= `blocks` 数组下标，
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
  /**
   * 这条消息所属的**那一次模型调用**的用量（本仓只有 dsh 交）。
   *
   * 不是累计、**不进任何合计** —— 与 `roundTrip` / `step` 各自独立：那两格回答「这是第几次往返」，
   * 这一格回答「这一次往返花了多少」。三条口径：
   *   · **整格可选**：磁盘上已有大量没有这一格的 `messages.jsonl`，写成必填会让回放 / SSE 续订成片失败；
   *   · **键缺席与显式 `null` 同义**（都是「这条消息没有消息级用量」）——这一格不像
   *     `subagentTokens` 那样有三态语义；
   *   · **不填 0**：三项缺一时整格是 `null`（`{0,0,0}` 会被读成「确实没花」）。
   */
  usage: UsageTokensSchema.nullable().optional(),
  /** 该条消息的原始载荷（未归类字段原样保留，供排障） */
  raw: z.unknown(),
});
export type AgentMessage = z.infer<typeof AgentMessageSchema>;

/**
 * 消息账本的**折叠键**：段号 + 载体键（`<segment ?? 0>:<mergeKey>`）。
 *
 * 为什么是一格独立函数而不是各处现拼：账本的折叠有**三处**——服务端落盘前（`@aieval/core` 的
 * `foldMessages`）、浏览器手里的这一份（`@aieval/client` 的 `foldCandidateRecords`：打开抽屉先拉一次
 * `/messages`、随后按同一把键叠加 SSE 增量）、界面装配（`@aieval/ui` 的 `buildAgentLogModel`）。
 * 三处分居三个包、都够不着对方的实现，判据一旦漂开，症状是「一处认段、一处不认」——
 * 看起来像内容丢失，而不是合并错（真机：关掉再打开执行日志，首段的消息整段不见了）。
 */
export function messageFoldKey(message: Pick<AgentMessage, 'segment' | 'mergeKey'>): string {
  return `${message.segment ?? 0}:${message.mergeKey}`;
}

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

/**
 * **注入面的一格**：我们下发给厂商进程的东西（MCP server / skill 副本），这一家认不认。
 *
 * 与 `MessageCapabilitySchema` 的每一格同一条口径：非 `yes` **必须**给出 `MissingReason`，
 * `yes` 时 `reason` 为 `null`。把「这家结构上没有」与「我们有数据但没接」说成同一句话，
 * 会把使用者引到错的方向去排查。
 *
 * 为什么没有 `source` 那一格：`MessageSource` 回答的是「这条**消息**从哪条通道来」，
 * 而注入面问的是「我们发出去的东西厂商收不收得到」——三家的落点各不相同
 * （cc 走 SDK 参数、codex 走线程配置、dsh 走 overlay），没有一张跨家闭集放得下它。
 */
export const InjectionStateSchema = z
  .object({
    state: CapabilitySchema,
    /** 为什么收不到；`state` 为 `yes` 时必须为 `null` */
    reason: MissingReasonSchema.nullable(),
  })
  .superRefine((value, ctx) => {
    if (value.state === 'yes' && value.reason !== null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['reason'], message: 'state 为 yes ⇒ reason 必须为 null' });
    }
    if (value.state !== 'yes' && value.reason === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['reason'], message: `state 为 ${value.state} ⇒ 必须给出缺失原因` });
    }
  });
export type InjectionState = z.infer<typeof InjectionStateSchema>;

/**
 * **注入面能力声明**：MCP 与 skills 两条「我们下发、厂商接收」的通路，这一家各自收不收得到。
 *
 * 为什么与 `MessageCapability` 并列而不是并进它：那一组说的是**内容层**能拿到什么
 * （思考正文、工具入参、工具结果、子任务、流式增量），这一组说的是**下发层**我们给出去的东西
 * 认不认。两者的变化原因、消费方与判据通道都不同，合成一组会让「思考正文拿不到」与
 * 「MCP 装不上」挤进同一格。
 *
 * 为什么必须有这一格：这两条通路今天**不在任何能力位里**——某家不支持 MCP 时没有任何地方
 * 说得出这件事，只能靠每-run 的运行事实（`vendor-system` 事件）事后看，而「没声明」与
 * 「声明了不支持」在消费侧是两件事（前者是漏接，后者是已知边界）。
 */
export const InjectionCapabilitySchema = z.object({
  mcp: InjectionStateSchema,
  skills: InjectionStateSchema,
  /** 这一族能力成立的**前提**（路由 / 模型 / 开关）；空数组 = 无条件成立（与 `MessageCapability.notes` 同义） */
  notes: z.array(z.string()),
});
export type InjectionCapability = z.infer<typeof InjectionCapabilitySchema>;

/**
 * **提问通道**：模型看到的那个提问工具是**谁提供的**（词表本体与两条取值的说明在 `ask-user-vocab.ts`，
 * 这里只摆在既有的导出面上：交互面声明与包根出口因此一个字都不用改）。
 *
 * 为什么必须与 `askUser` 分开说：三档「能被问」的消费侧后果完全不同——答案递回去的机制不同、
 * 厂商有没有自己的等待预算不同、「没人答时能不能用厂商原生语义收场」也不同。
 * 把它并进 `askUser` 的取值里，等于让一个三态字段同时回答两个问题。
 */

/**
 * **`yes` 是靠什么证出来的**：这一格的一致性场景里，厂商那一侧**真的跑起来了吗**。
 *   · `'real-path'`——厂商真跑（真 CLI / 真 SDK / 真运行时 + 厂商自己的通道），只把**上游模型**
 *     脚本化。于是「厂商的那条通道真的到了我们手里」与「我们的动作真的回到了厂商」两条都有原文，
 *     而它们正是这件事的全部意义；
 *   · `'synthetic-fixture'`——夹具自己扮演厂商那一端（造出「厂商问了一次」、再把答复装成厂商形状）。
 *     它证得了端口那一半，证不了上面那两条。**临时档**：只允许留在「今天确实驱动不了」的家里，
 *     且必须给出原因。
 *
 * 两处消费方共用这一套词表：交互面的 `askUserProofDriver`（那一问能不能被问）与人工消息面的
 * `TurnInjectionCell.proofDriver`（这一格做不做得到）。同一个问题（这句 `yes` 是真路径证出来的、
 * 还是夹具代跑的）在两处问的是同一件事，各写一份必然漂。
 */
export const ProofDriverSchema = z.enum(['real-path', 'synthetic-fixture']);
export type ProofDriver = z.infer<typeof ProofDriverSchema>;

/**
 * **`yes` 是靠什么证出来的**（提问应答面那一格的名字，词表与硬规则见 `ProofDriverSchema`）。
 *
 * 为什么与 `askUserChannel` 分开说：那一格回答「模型看到的那个提问工具是谁提供的」，
 * 这一格回答「这句 `yes` 是怎么证出来的」。两者的取值来源、变化原因与消费方都不同——
 * 合成一格等于让一个字段同时回答两个问题，而夹具扮演端口能让判据全绿却证不到通道。
 */
export const AskUserProofDriverSchema = ProofDriverSchema;
export type AskUserProofDriver = ProofDriver;

/**
 * **交互面能力声明**：这一家能不能被模型问、提问工具是谁提供的、不能时为什么。
 *
 * 为什么与「候选级」「内容级」「下发级」三组并列而不是并进任何一组：那三组回答「跑这个候选能做什么」
 * 「拿得到哪些块」「我们下发的东西认不认」，这一组回答「模型问出来的时候有没有人能答」——
 * 变化原因（厂商通道的有无与投送）、消费方（应答面与弹层）与判据通道都不同。
 *
 * 三种「没有」必须分开说（取值域与 `capability` 同一套五态词表）：
 *   · `'no'`——这家**结构上**没有提问工具；
 *   · `'off-by-adapter'`——厂商有那条通道，**我们没接**；
 *   · `'not-projected-by-vendor'`——厂商侧有提问服务，但不投送到我们拿得到的通道。
 * 混成一句「暂不支持」，排查时就会把「写代码能解决」与「厂商不给」当成同一件事。
 *
 * 两条字段间的对应关系由 `superRefine` 拦在解析层（不靠调用方自觉），与 `InjectionStateSchema`
 * 同源：`yes` ⇒ 必须给出通道、且原因为 `null`；非 `yes` ⇒ 必须给出原因、且通道为 `null`。
 *
 * `askUserProofDriver` 与 `askUserProofDriverReason` 是**同一条口径的第二组**（原因只挂在需要解释的
 * 那一档上：`synthetic-fixture` 必须说清为什么今天驱动不了真路径），外加一条跨字段的硬规则：
 * **声明 `yes` 就不许用 `synthetic-fixture`**——那句 `yes` 得拿真路径来证，否则它会腐烂成假话。
 */
export const InteractionCapabilitySchema = z
  .object({
    askUser: CapabilitySchema,
    /** 提问工具是谁提供的；`askUser` 为 `yes` 时必填，其余四态必须为 `null` */
    askUserChannel: AskUserChannelSchema.nullable(),
    /** 为什么问不了；非 `yes` 时必填 */
    askUserReason: MissingReasonSchema.nullable(),
    /** `yes` 是靠什么证出来的（见 `AskUserProofDriverSchema`）；**必填**，答不出这一格就不该声明 `yes` */
    askUserProofDriver: AskUserProofDriverSchema,
    /** `synthetic-fixture` 必须给出原因（非空）；`real-path` 必须为 `null` */
    askUserProofDriverReason: z.string().nullable(),
    /** 这一族能力成立的**前提**（工具开关 / 权限档 / 路由）；空数组 = 无条件成立 */
    notes: z.array(z.string()),
  })
  .superRefine((value, ctx) => {
    if (value.askUser === 'yes' && value.askUserChannel === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['askUserChannel'], message: 'askUser 为 yes ⇒ 必须给出提问通道' });
    }
    if (value.askUser !== 'yes' && value.askUserChannel !== null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['askUserChannel'], message: `askUser 为 ${value.askUser} ⇒ askUserChannel 必须为 null` });
    }
    if (value.askUser === 'yes' && value.askUserProofDriver !== 'real-path') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['askUserProofDriver'],
        message: 'askUser 为 yes ⇒ askUserProofDriver 必须是 real-path：声明得出「能被问」就得拿真路径证明，'
          + '夹具扮演厂商那一端证不到「请求真的到了我们手里、答复真的回到了厂商」',
      });
    }
    if (value.askUser === 'yes' && value.askUserProofDriver === 'real-path' && value.askUserReason !== null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['askUserReason'], message: 'askUser 为 yes ⇒ askUserReason 必须为 null' });
    }
    if (value.askUser !== 'yes' && value.askUserReason === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['askUserReason'], message: `askUser 为 ${value.askUser} ⇒ 必须给出缺失原因` });
    }
    if (value.askUserProofDriver === 'synthetic-fixture') {
      if (value.askUserProofDriverReason === null || value.askUserProofDriverReason.trim() === '') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['askUserProofDriverReason'],
          message: 'askUserProofDriver 为 synthetic-fixture ⇒ 必须给出原因：这一档是临时档，'
            + '「今天为什么驱动不了真路径」要能被读到，否则它会静默地长期留下来',
        });
      }
    } else if (value.askUserProofDriverReason !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['askUserProofDriverReason'],
        message: 'askUserProofDriver 为 real-path ⇒ askUserProofDriverReason 必须为 null',
      });
    }
  });
export type InteractionCapability = z.infer<typeof InteractionCapabilitySchema>;

/**
 * 注入边界的**定义**在 `inject-vocab.ts`（消息账本、候选级事件与队列快照共用那份词表，见那里的头注），
 * 这里只把它摆在既有的导出面上：本文件的消费方（端口、声明组）与包根出口因此一个字都不用改。
 */
export { InjectionBoundarySchema };
export type { InjectionBoundary };

/**
 * **撤回结果**：编排层发起撤回后，适配器如实交回的一件事。
 *
 * 形状是四值而不是布尔：`unsupported`（这一家这一档根本没有撤回面）与 `unknown`（撤不到、也说不出
 * 为什么）在只回布尔时**分不开**，而界面要说的话完全不同；`already-consumed` 是竞态里厂商赢的那一支
 * （消息已经交给模型了）——它不是失败，是**如实**，界面据此把那一条移出队列并说明撤不回来。
 */
export const RETRACT_OUTCOMES = ['retracted', 'already-consumed', 'unsupported', 'unknown'] as const;
export const RetractOutcomeSchema = z.enum(RETRACT_OUTCOMES);
export type RetractOutcome = z.infer<typeof RetractOutcomeSchema>;

/**
 * **投递通道**：这一格的消息从哪条路进厂商。要这一格是因为**代价不同**——同一条消息走 wire 上现成的
 * 方法、走进程内 SDK、与为了它常驻一支插件 + side channel，是三件成本完全不同的事。
 */
export const TurnInjectionChannelSchema = z.enum(['wire', 'in-process-plugin', 'in-process-sdk']);
export type TurnInjectionChannel = z.infer<typeof TurnInjectionChannelSchema>;

/**
 * **能力格**：`turnInjection` 里的一格——某一个边界上这一家收不收得到人话，
 * 或者**能不能续接到一条已有会话**（投递两档与续接共用这一个形状，字段逐格同义）。
 *
 * 五态词表与 `InjectionStateSchema` 逐字同源（`yes` / `no` / `unverified` / `off-by-adapter` /
 * `not-projected-by-vendor`），落在这里的是那一套 + 三格这个矩阵独有的代价事实：
 *   · `channel`——厂商侧那条通道（续接那一格是「从哪条路接回去」）；`yes` 必须给出
 *     （能做到就得说清怎么做，否则界面只能编一个代价）；
 *   · `gate`——版本门（`{version}` 或 `null`）。结构化一格而不是塞进 `notes`：某些方法自某个版本起
 *     才存在、或某个参数**必填**，那是接这一格的前置条件，不是一句备注；
 *   · `experimental`——「wire 上有」≠「官方承诺稳定」；
 *   · `proofDriver`——**这一格的证据是哪一档驱动器**（词表与硬规则见 `ProofDriverSchema`）。
 *     它与 `state` 是两个问题：「做不做得到」与「这句结论是怎么证出来的」。缺了它，「声明 `yes`
 *     必须配真路径驱动器」只能靠约定，而约定会在下一个人手里腐烂成假话。
 */
export const TurnInjectionCellSchema = z
  .object({
    state: CapabilitySchema,
    /** 为什么做不到；`state` 为 `yes` 时必须为 `null` */
    reason: MissingReasonSchema.nullable(),
    /** 厂商侧那条通道；`yes` 时必须给出 */
    channel: TurnInjectionChannelSchema.nullable(),
    /** 版本门；`null` = 没有版本门 */
    gate: z.object({ version: z.string().min(1) }).nullable(),
    experimental: z.boolean(),
    /**
     * 这一格的证据是哪一档驱动器；**必填**——答不出这一格就不该声明 `yes`。
     * 非 `yes` 的格同样要填（真路径上**观察到做不到**也是一种证据，与「没验过」必须分得开）。
     */
    proofDriver: ProofDriverSchema,
    /** `synthetic-fixture` 必须给出原因（非空）；`real-path` 必须为 `null` */
    proofDriverReason: z.string().nullable(),
  })
  .superRefine((value, ctx) => {
    if (value.state === 'yes' && value.reason !== null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['reason'], message: 'state 为 yes ⇒ reason 必须为 null' });
    }
    if (value.state !== 'yes' && value.reason === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['reason'], message: `state 为 ${value.state} ⇒ 必须给出缺失原因` });
    }
    if (value.state === 'yes' && value.channel === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['channel'], message: 'state 为 yes ⇒ 必须给出通道' });
    }
    if (value.state === 'yes' && value.proofDriver !== 'real-path') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['proofDriver'],
        message: 'state 为 yes ⇒ proofDriver 必须是 real-path：声明得出「这一格做得到」就得拿真路径证明，'
          + '夹具扮演厂商那一端证不到「厂商真的收下了、模型真的看到了」',
      });
    }
    if (value.proofDriver === 'synthetic-fixture') {
      if (value.proofDriverReason === null || value.proofDriverReason.trim() === '') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['proofDriverReason'],
          message: 'proofDriver 为 synthetic-fixture ⇒ 必须给出原因：这一档是临时档，'
            + '「今天为什么驱动不了真路径」要能被读到，否则它会静默地长期留下来',
        });
      }
    } else if (value.proofDriverReason !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['proofDriverReason'],
        message: 'proofDriver 为 real-path ⇒ proofDriverReason 必须为 null',
      });
    }
  });
export type TurnInjectionCell = z.infer<typeof TurnInjectionCellSchema>;

/**
 * **撤回能力四档**（与投递**分开**声明：「能收但不能撤」是合法的一家）：
 * `by-id`（按身份可撤）/ `flush-only`（只能整条队列全清）/ `none` / `unverified`。
 *
 * 为什么必须有 `flush-only` 这一档：只有「整条清空」的家如果被写成一格「支持撤回」，
 * 界面就会写出「撤回这一条」的文案——而那一档要重排其余条目，清与重排之间的窗口会让同一条消息
 * **第二次**进模型。四档是**如实**的表达方式。
 */
export const RETRACT_ABILITIES = ['by-id', 'flush-only', 'none', 'unverified'] as const;
export const RetractAbilitySchema = z.enum(RETRACT_ABILITIES);
export type RetractAbility = z.infer<typeof RetractAbilitySchema>;

/**
 * **撤回格**：某一个边界上，已经交给厂商的那一条还能不能要回来。
 *
 * `reason` 必填且**要把判据写进去**（按什么认人 / 是不是整条清）：界面要说得出「撤回可能撤掉哪一条」，
 * 而 `by-id` 在三家认的是三个不同的身份（我们自铸的 uuid / 我们自己发的 messageId / 厂商的提交 id）。
 */
export const TurnInjectionRetractSchema = z.object({
  state: RetractAbilitySchema,
  reason: z.string().min(1),
});
export type TurnInjectionRetract = z.infer<typeof TurnInjectionRetractSchema>;

/**
 * **注入面能力声明（第五组）**：人往运行中的一轮送话、以及**接着一条已有会话再跑一段**，
 * 这一家各能做什么。
 *
 * 独立成组、不复用 `injection`（那个名字已指「把 MCP / skills 配置下发给智能体」，两者不相干）。
 * 判据与既有各组同源——**消费方不同**：这一组界面（输入区可用性与 tooltip、追问入口）与编排层
 * （投递路径、要不要续接）两边都要读，形状也是**家 × 两档 × 两件事（投递 / 撤回）+ 续接一格**的矩阵。
 *
 * 四条口径：
 *   · 投递与撤回分开声明（`TurnInjectionRetractSchema`：能收但不能撤是合法的一家）；
 *   · `resume` 是**单格**、不按边界分两档——续接不是「哪一档」的问题，它是「从哪条会话接着跑」；
 *     续接之后的追问天然落在 `'idle'` 档，而 `'round'` 只活在「同一条命」里；
 *   · `notes` 记这一族能力成立的前提（路由 / 开关 / 版本），空数组 = 无条件成立；
 *   · **缺席按「不知道」处置，不编一份都支持的**：猜错会让界面说谎（说「能投」而实际投不进去），
 *     而说谎的形态是「按钮可点、消息静默消失」。
 *
 * 声明与产物**互钉**：把哪一格改成 `yes` 就要同时给出该格的真实场景（含驱动器的真伪核对），
 * 非 `yes` 的 `reason` 必须在词表白名单里。
 */
export const TurnInjectionCapabilitySchema = z.object({
  delivery: z.object({ round: TurnInjectionCellSchema, idle: TurnInjectionCellSchema }),
  retract: z.object({ round: TurnInjectionRetractSchema, idle: TurnInjectionRetractSchema }),
  /**
   * **续接**：这一家能不能接着一条已有会话再跑一段（`AgentRunInput.resume` 那一格的能力面）。
   *
   * 只有一格，因为「不支持续接的家收到 `resume` 必须抛错」这条约定需要一个**可查的能力位**
   * ——没有它，适配器只能自己猜，而猜错的表现是「用户以为在追问、智能体其实什么都不记得」。
   * `gate` 在这一格是主力：有的家是「版本到了才有那条 wire 方法」。
   */
  resume: TurnInjectionCellSchema,
  notes: z.array(z.string()),
});
export type TurnInjectionCapability = z.infer<typeof TurnInjectionCapabilitySchema>;

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
  /**
   * **派生这个子任务的那次工具调用 id**（`callId`）。与消息的 `parentCallId` 同源同义。
   *
   * 为什么必须单列一格、而不是「拿 `subagentId` 去时间轴上碰」：子任务身份（`task_id` /
   * 子线程 id / `agentId`）与派发它的工具调用 id 是**两套 id**，谁都不等于谁。
   * 少了这一格，界面就只能靠「工具名像不像派发工具 + 任务名逐字相同」这类启发式去猜派发点，
   * 而猜不中时的表现是**整棵子任务在界面上不可达**（claude 的
   * 子任务记录与消息都在文件里，主会话时间轴上却没有「进入子任务」的入口）。
   * claude 与 codex 都给得出：claude 用 `task_progress.tool_use_id`（与子消息上的
   * `parent_tool_use_id`、派发工具调用的 `id` 三者同值）；codex 用 `collab_tool_call` 的条目 id。
   * ⚠️ **dsh 给不出**（载荷里没有可对齐的调用 id）⇒ 这一格**恒 `null`**，界面因此退化为
   * 「派发工具入参里的任务名 == 子任务名」逐字相同才认派发点。**给不出时记 `null`，不猜。**
   */
  parentCallId: z.string().nullable(),
  /** 嵌套父链；顶层子任务为 `null` */
  parentSubagentId: z.string().nullable(),
  /** 该子任务自己的用量；采不到为 `null` */
  usage: UsageTokensSchema.nullable(),
});
export type SubagentRecord = z.infer<typeof SubagentRecordSchema>;

/**
 * 消息日志（`messages.jsonl`）里的一行：**内容流与派发视图共用一条流**。
 *
 * 为什么把子任务行与消息放进同一个文件、而不各开一份：两者是同一次运行的**两条并行的内容流**
 * （说话者与内容块 / 子任务身份与终态），消费方（对话视图与派发面板）按 `type` 分流即可。
 * 各开一份的代价是「一次运行要落两处、读两处，还得保证两处一致」——而它们本来就来自同一条
 * 适配器回调，分开只会多一个对不上的机会。
 */
export const CandidateRecordSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('message'), message: AgentMessageSchema }),
  z.object({ type: z.literal('subagent'), subagent: SubagentRecordSchema }),
]);
export type CandidateRecord = z.infer<typeof CandidateRecordSchema>;

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
