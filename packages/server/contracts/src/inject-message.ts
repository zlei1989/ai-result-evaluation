/**
 * 人工消息的**传输形状**：快照里的一条、随它一起发出去的附件清单、以及发送 / 改期 / 撤回 / 上传
 * 四个动作的请求与响应。
 *
 * 与 `inject-vocab.ts` 的分工：那边是**词表**（边界两档、四态、收场五值），只关心「有哪些取值」；
 * 这边是**一条消息长什么样、四个动作各收什么、各回什么**。词表单独一格是为了断掉
 * `agent-event` 与 `agent-message` 的循环引用（理由写在那个文件头），不是因为它们可以合并。
 *
 * 四条口径：
 *
 *   1. **一条的形状与队列表逐格同形**（服务端那张表的真相源形状）：这里加一格、那里不加，
 *      快照就会把一个字段静默丢掉。故本模块是**唯一一份**定义，`@aieval/evaluator` 的
 *      `InjectQueueEntry` 直接引用它，而不是各写一份接口。
 *   2. **`messageId` 由客户端生成，同时是幂等键与拼路径的那一段**：形状因此收紧到
 *      「首字符是字母或数字 + 只允许字母数字点下划线连字符 + 最长 128」，空串、`..`、带分隔符的
 *      一律从入口拒掉（与用例 id 的处置同源：它同时是身份判据与安全边界）。
 *   3. **三个写动作都带 `runId` + `rowId`**：队列表按这一对定位一行，而它们不是 URL 层级里的
 *      资源标识（真相源在服务端的表里）——放进请求体，客户端就不必为了发一条消息去拼 URL、
 *      服务端也不必在两种来源之间做二次合并。
 *   4. **不用 `.default()`**：这一面的格没有「老客户端」要兼容（客户端与服务端同一次发布），
 *      而默认值会把「少传了一格」静默变成一个看起来合法的值——尤其 `requires` 一旦默认成
 *      `'idle'`，「立即发送」会悄悄退化成「排队」而两边都不报错。
 *
 * 附件清单里**没有字节数**：`path` + `mimeType` 是登记那一刻的事实，大小由服务端在拼提示词、
 * 真正要交给模型那一刻按路径现读（登记时读到的数既可能过期，也可能因为文件还没落盘而算不出来）。
 */
import { z } from 'zod';
import { ATTACHMENT_MAX_PER_MESSAGE, AttachmentKindSchema } from './agent-message';
import { InjectMessageOutcomeSchema, InjectMessageStateSchema, InjectionBoundarySchema } from './inject-vocab';

/**
 * 一条人工消息 id 的**形状**（身份判据 + 安全边界）。
 *
 * 为什么这么紧：它由浏览器生成，而服务端要拿它当幂等键、当账本与行级事件共用的钥匙，
 * 还要拿它拼附件目录名（`rowDir/attachments/<messageId>/`）。首字符限定字母或数字一条就同时挡掉
 * 了 `..`、`.hidden` 与空串；分隔符不在字符集里，路径穿越因此在这一格就断了
 * （`join` 不拦 `..`，靠调用方逐个 `assert*` 是本仓既有处置——用例 id 同一道光）。
 */
export const INJECT_MESSAGE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const InjectMessageIdSchema = z
  .string()
  .regex(INJECT_MESSAGE_ID_PATTERN, '消息 id 只允许字母、数字、点、下划线、连字符（首字符须为字母或数字），最长 128');
export type InjectMessageId = z.infer<typeof InjectMessageIdSchema>;

/**
 * 随着一条人工消息发出去的**一份附件**（结构化清单的一项，不是文件内容）。
 *
 * 与账本里的 `AttachmentBlock` 差一格 `type` 判别位：那边是内容块（判别联合的一员），
 * 这边是清单项（数组里的位置已经说明了它是什么）。`path` 是落盘的**绝对路径**
 * ——提示词里给模型的就是它，模型据此去读文件。
 */
export const InjectAttachmentSchema = z.object({
  kind: AttachmentKindSchema,
  path: z.string().nullable(),
  mimeType: z.string().nullable(),
});
export type InjectAttachment = z.infer<typeof InjectAttachmentSchema>;

/**
 * **一条人工消息**（快照里的一项，也是四个动作里 `messageId` 的所指）。
 *
 * 三个时刻各自回答一件不同的事，缺一个都会让界面去猜：
 *   · `createdAt`——人点发送那一刻（排队从这时起算）；
 *   · `deliveredAt`——**真的交给厂商**那一刻（没交出去就是 `null`；账本记的是这个时刻）；
 *   · `settledAt`——落终态那一刻（只有 `gone` / `consumed` 有），撤回结果与丢弃原因都在它的旁边。
 *
 * 三格都是**服务端写入时刻的 ISO 8601 带时区串**（与提问应答面的 `askedAt` 同口径）：
 * 它们要落进快照、要给人读、还要与轮上行上别的时刻并排显示。
 *
 * `outcome` 与 `reason` 成对：`reason` 是**可直接展示**的中文原因（「等太久了，这一条没能交给
 * 智能体」这类），界面不必自己按 `outcome` 反查文案——同一件事两处写文案必然漂。
 */
export const InjectMessageSchema = z.object({
  messageId: InjectMessageIdSchema,
  /** 人写的那句话（**不含**附件清单：清单在取件那一刻拼进交给厂商的正文） */
  text: z.string(),
  attachments: z.array(InjectAttachmentSchema),
  /** 要求的投递边界：「立即发送」= `'round'`、「排队」= `'idle'` */
  requires: InjectionBoundarySchema,
  state: InjectMessageStateSchema,
  /** 三个时刻一律 ISO 8601 带时区字符串（与 `PendingAskUser.askedAt` 同口径，不用 epoch） */
  createdAt: z.string(),
  deliveredAt: z.string().nullable(),
  settledAt: z.string().nullable(),
  outcome: InjectMessageOutcomeSchema.nullable(),
  reason: z.string().nullable(),
});
export type InjectMessage = z.infer<typeof InjectMessageSchema>;

/** 快照（一行的队列）：**含终态**——`gone` 那一条带的 `outcome` / `reason` 正是「它为什么消失」 */
export const InjectMessageListSchema = z.array(InjectMessageSchema);
export type InjectMessageList = z.infer<typeof InjectMessageListSchema>;

/**
 * 定位一条消息的三格（撤回与改期共用）。
 * `messageId` 的形状与登记时同一份 schema：三个动作都能拿它去表里找同一条。
 */
export const InjectMessageRefSchema = z.object({
  runId: z.string().min(1),
  rowId: z.string().min(1),
  messageId: InjectMessageIdSchema,
});
export type InjectMessageRef = z.infer<typeof InjectMessageRefSchema>;

/** 快照路由的查询参数（`GET /api/inject-messages?runId=…&rowId=…`） */
export const InjectMessageQuerySchema = z.object({
  runId: z.string().min(1),
  rowId: z.string().min(1),
});
export type InjectMessageQuery = z.infer<typeof InjectMessageQuerySchema>;

/**
 * 发送一条人工消息的请求体。
 *
 * 两条硬约束写在入口而不是留给下游：
 *   · **附件条数**（`ATTACHMENT_MAX_PER_MESSAGE`）：超限的中文原因点名是哪一条限制——用户要据此
 *     决定「删几个」还是「换个更小的」；
 *   · **不许是空的**：一句话都没有、附件也没有的消息交给模型只会得到一句「你发了什么」。
 *     「只有附件没有正文」是合法的（那份清单本身就是内容）。
 */
export const InjectMessageSendRequestSchema = InjectMessageRefSchema.extend({
  text: z.string(),
  attachments: z.array(InjectAttachmentSchema).max(ATTACHMENT_MAX_PER_MESSAGE, `单条消息最多 ${ATTACHMENT_MAX_PER_MESSAGE} 个附件`),
  requires: InjectionBoundarySchema,
}).refine((value) => value.text.trim() !== '' || value.attachments.length > 0, {
  message: '一条人工消息至少要有一句话或一个附件',
});
export type InjectMessageSendRequest = z.infer<typeof InjectMessageSendRequestSchema>;

/**
 * 发送的响应体：`created` 区分「这次真的进了表」与「同一个 `messageId` 又提交了一次」。
 *
 * **两种都回 200 + 同一条**（幂等，重复提交不新增、不重投）。客户端拿到 `created: false`
 * 就该知道「这一条已经在了」，而不是再往队列里画一条——界面上多画一条的代价是用户以为
 * 自己发了两遍、去手动删掉一条，而删掉的是模型真会收到的那一条。
 */
export const InjectMessageSendAcceptedSchema = z.object({
  created: z.boolean(),
  message: InjectMessageSchema,
});
export type InjectMessageSendAccepted = z.infer<typeof InjectMessageSendAcceptedSchema>;

/**
 * 撤回的三种**成功**结局（都在 200 里回）：
 *   · `removed`——它还在我们的表里，没投出去，直接摘掉；
 *   · `retracted`——已经交给厂商，厂商确认撤回了；
 *   · `already-retracted`——重复撤回（或撤一条已经被等待预算丢弃的）：它早就不在任何队列里了，
 *     回 404 会让客户端以为「这个 id 从来不存在」并去刷新快照，而事实相反。
 *
 * 撤不动的三种（`not-found` / `consumed` / 厂商说不支持或说不清）不是这个形状：它们是错误响应，
 * 客户端据状态码分支（见路由层）。
 */
export const INJECT_RETRACT_OUTCOMES = ['removed', 'retracted', 'already-retracted'] as const;
export const InjectMessageRetractOutcomeSchema = z.enum(INJECT_RETRACT_OUTCOMES);
export type InjectMessageRetractOutcome = z.infer<typeof InjectMessageRetractOutcomeSchema>;

/** 撤回的响应体：结局 + 那一条（终态的那一份，界面据此把它移出队列并显示原因） */
export const InjectMessageRetractAcceptedSchema = z.object({
  outcome: InjectMessageRetractOutcomeSchema,
  message: InjectMessageSchema,
});
export type InjectMessageRetractAccepted = z.infer<typeof InjectMessageRetractAcceptedSchema>;

/**
 * 改期（「立即发送」）的两种结局（都在 200 里回）：`promoted` = 这次改成功了；
 * `already-round` = 它本来就要求立即发送（重复点同一颗按钮的幂等答复）。
 *
 * 交出去之后改不了：边界已经用掉了，那一条回 409（见路由层）。
 */
export const INJECT_PROMOTE_OUTCOMES = ['promoted', 'already-round'] as const;
export const InjectMessagePromoteOutcomeSchema = z.enum(INJECT_PROMOTE_OUTCOMES);
export type InjectMessagePromoteOutcome = z.infer<typeof InjectMessagePromoteOutcomeSchema>;

/** 改期的响应体：结局 + 改完（或本来如此）的那一条 */
export const InjectMessagePromoteAcceptedSchema = z.object({
  outcome: InjectMessagePromoteOutcomeSchema,
  message: InjectMessageSchema,
});
export type InjectMessagePromoteAccepted = z.infer<typeof InjectMessagePromoteAcceptedSchema>;

/**
 * 附件上传的表单字段（`multipart/form-data`）。
 *
 * 文件本体不走 zod（它是二进制流，schema 只用来描述文本格）：路由先解析表单、校验这三格，
 * 再把文件名 / 类型 / 字节交给 api 层。
 */
export const InjectAttachmentUploadRequestSchema = InjectMessageRefSchema;
export type InjectAttachmentUploadRequest = z.infer<typeof InjectAttachmentUploadRequestSchema>;

/** 附件上传的响应体：落盘之后那一刻的事实；大小由取件那一刻现读，故这里没有它 */
export const InjectAttachmentAcceptedSchema = InjectAttachmentSchema;
export type InjectAttachmentAccepted = InjectAttachment;

/**
 * 一次**追问**的请求体（第二期：对已经跑过的行补一句话，接着同一段会话再跑一段）。
 * 它没有队列表那一格 `requires`——续接之后的追问天然落在**排队**那一档（`'idle'`）。
 *
 * 与 `InjectMessageSendRequest` 的「一句话 + 附件清单」同源（同一份 `InjectAttachmentSchema`、
 * 同一条条数上限、同样带 `runId` + `rowId`）：两条路发出去的是同一种东西（人写的一句话），
 * 各写一份必然漂移，而漂移的表现是「同一份清单在一条路上合法、在另一条上被拒」。
 * `messageId` 在这里**可选**：它同时是附件落点目录名与账本钥匙，缺席时编排层现铸一个
 * （与发送那条不同——那条的 `messageId` 是幂等键，必须由客户端给）。
 *
 * `text` 允许空串（只带附件也是一条合法的追问）：「一句话都没有、附件也没有」由 api 层拦——
 * 那条判据要同时看两个字段，写进 schema 会变成两条各自为政的规则。
 */
export const FollowUpRequestSchema = z.object({
  runId: z.string().min(1),
  rowId: z.string().min(1),
  text: z.string(),
  attachments: z
    .array(InjectAttachmentSchema)
    .max(ATTACHMENT_MAX_PER_MESSAGE, `单条消息最多 ${ATTACHMENT_MAX_PER_MESSAGE} 个附件`)
    .optional(),
  messageId: z.string().min(1).optional(),
});
export type FollowUpRequest = z.infer<typeof FollowUpRequestSchema>;
