/**
 * **回到某一轮**的契约：厂商能力声明、作废标记、以及读侧过滤的纯函数。
 *
 * 两条贯穿全文件的口径：
 *   1. **能力只有一个来源**：界面与编排层都读同一份 `CheckpointCapability`（由各适配器在注册表
 *      元数据里声明）。界面**不判厂商**——「这家做不到」与「厂商有、我们没接」是两句话，
 *      靠 `reason` 分开，不靠 `agentKind` 分支。
 *   2. **账本只追加、旧记录不改写**：回到第 N 轮时**追加**一条作废标记（`CheckpointVoid`），
 *      旧消息一条都不删、不改；读侧按标记把作废段滤掉。旧数据里没有这一格（`checkpointVoids`
 *      整格缺席）⇒ 一无所作废，与今天的行为逐字相同。
 *
 * 「作废」的边界由**段号 + 轮次**同时给出：追问/续段会在同一个账本里造出多个段，而厂商轮次
 * 每段都从 1 重新数 ⇒ 只按轮次号定边界会把别段的同号轮次一起作废。标记因此带两格：
 *   · `segment` / `turn`：回到的那一点（保留，含）；
 *   · `throughSegment`：落标记那一刻**已存在**的最大段号。作废范围是「本段该轮之后 + 到
 *     `throughSegment` 为止的全部后续段」——定上界是为了让**此后**新追加的段（段号更大）不被
 *     同一条标记误伤。
 */
import { z } from 'zod';
import { InjectAttachmentSchema } from './inject-message';

/** 回到某一轮的两条落点形态 */
export const CheckpointModeSchema = z.enum([
  /** 在**同一条会话**上截断到某一轮（CC：`resumeSessionAt` + `resumeDropsTurn`） */
  'resume-at',
  /** 从某一条分叉出一条新线（Codex：`thread/fork`；Pi：`fork(entryId)` / `navigateTree`） */
  'fork',
]);
export type CheckpointMode = z.infer<typeof CheckpointModeSchema>;

/**
 * **回到某一轮**的厂商能力声明（四家各给一份，注册表元数据里唯一一处）。
 *
 * 四格的配对关系由 `superRefine` 拦在解析层（不靠调用方自觉）：
 *   · `supported === true` ⇒ `mode` 必填、`reason` 必为 `null`；
 *   · `supported === false` ⇒ `mode` 必为 `null`、`reason` 必填（四句「为什么」之一）。
 *
 * `filesRewind` 说的是「**工作区文件**会不会跟着回到那一刻」——它与「会话上下文能不能回退」
 * 是两件事，只有 CC 明确有（`rewindFiles()` + `enableFileCheckpointing`）。缺省为 `false`
 * 是载重的：文案不许承诺「撤销」，也不许把「只回退上下文」说成「连同文件一起」。
 */
export const CheckpointCapabilitySchema = z
  .object({
    supported: z.boolean(),
    /** 分会话的方式；`supported === false` 时为 `null` */
    mode: CheckpointModeSchema.nullable(),
    /** 工作区文件能不能跟着回退（只有 CC 为 `true`） */
    filesRewind: z.boolean(),
    /** 不支持的**原因**（与消息能力同一套四句词表）；支持时为 `null` */
    reason: z.enum(['not-supported', 'not-exposed', 'not-observed', 'unverified']).nullable(),
    /** 这一格成立的**前提**（通道 / 开关）；空数组 = 无条件成立 */
    notes: z.array(z.string()),
  })
  .superRefine((value, ctx) => {
    if (value.supported && value.mode === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['mode'], message: 'supported 为 true ⇒ 必须给出分会话的方式' });
    }
    if (value.supported && value.reason !== null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['reason'], message: 'supported 为 true ⇒ reason 必须为 null' });
    }
    if (!value.supported && value.mode !== null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['mode'], message: 'supported 为 false ⇒ mode 必须为 null' });
    }
    if (!value.supported && value.reason === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['reason'], message: 'supported 为 false ⇒ 必须给出原因' });
    }
    if (!value.supported && value.filesRewind) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['filesRewind'], message: '不支持回到某一轮时，文件回退也无从谈起' });
    }
  });
export type CheckpointCapability = z.infer<typeof CheckpointCapabilitySchema>;

/**
 * **一次作废标记**（追加进行快照的 `checkpointVoids` 数组里）：回到 `(segment, turn)` 之后，
 * 该段更晚的轮次与 `throughSegment` 以内的后续段**只在读侧跳过**，账本原文一个字都不动。
 *
 * `tokens` / `turns` 是**作废那一截自己的量**（落标记时从消息账本算出来）：行快照里的总量保持
 * 原样（历史真相），读侧用它们把「作废段不计入用量与轮次」这条口径落下来。
 */
/** 作废标记的形状住在叶子模块里（见 `checkpoint-void.ts` 的文件头）：本文件既要用它的类型，也要转出它 */
import { CheckpointVoidSchema, type CheckpointVoid } from './checkpoint-void';

export { CheckpointVoidSchema, type CheckpointVoid };

/** 消息在作废判断里要的那两格（`segment` 缺省 = 0；`roundTrip` 是厂商轮次号） */
export interface CheckpointRecordRef {
  segment?: number | undefined;
  roundTrip: number;
}

/**
 * 这一条消息/轮次是否落在某次作废的范围内。
 *
 * 三条判定恰好覆盖三种记录：
 *   · 更早的段（`segment < mark.segment`）**不**作废——那是回到点之前的上下文；
 *   · 回退点所在段只作废 `roundTrip > turn` 的轮次（含等于 `turn` 的那一轮）；
 *   · 回退点之后、`throughSegment` 以内的段**整段**作废。
 * 段号大于 `throughSegment` 的是标记之后新追加的段，**不**作废。
 */
export function voidedBy(mark: CheckpointVoid, record: CheckpointRecordRef): boolean {
  const segment = record.segment ?? 0;
  if (segment > mark.throughSegment) return false;
  if (segment < mark.segment) return false;
  if (segment === mark.segment) return record.roundTrip > mark.turn;
  return true;
}

/** 任一条标记覆盖即作废（多次回到某一轮的标记可以叠加） */
export function voidedByAny(marks: readonly CheckpointVoid[], record: CheckpointRecordRef): boolean {
  return marks.some((mark) => voidedBy(mark, record));
}

/**
 * 读侧默认视图：滤掉落在作废段里的消息，**保持原有顺序**。
 * 「要看作废段」是显式开关（`includeVoided`）——默认不给，历史里就不出现那一段。
 */
export function visibleMessages<T extends CheckpointRecordRef>(
  messages: readonly T[],
  marks: readonly CheckpointVoid[],
  options: { includeVoided?: boolean } = {},
): T[] {
  if (options.includeVoided === true || marks.length === 0) return [...messages];
  return messages.filter((message) => !voidedByAny(marks, message));
}

/**
 * 行快照的用量/轮次扣掉全部作废段之后的读数。
 *
 * `tokens` 为 `null`（这一行本来就没采到计量）时**照样是 `null`**，不因为扣减而变成一个数；
 * 扣到负数时夹到 0（标记与快照之间的历史差异不该在界面上显示负数）。
 * 轮次同理，但它是整数计数、没有 `null` 的「没采到」语义之外的两档（`turns` 本就可空，
 * 空则原样返回）。
 */
export function withoutVoidedTotals(
  row: { tokens: { input: number; cached: number; output: number } | null; turns: number | null },
  marks: readonly CheckpointVoid[],
): { tokens: { input: number; cached: number; output: number } | null; turns: number | null } {
  if (marks.length === 0) return { tokens: row.tokens, turns: row.turns };
  const tokens =
    row.tokens === null
      ? null
      : {
        input: Math.max(0, row.tokens.input - sumVoided(marks, (mark) => mark.tokens?.input)),
        cached: Math.max(0, row.tokens.cached - sumVoided(marks, (mark) => mark.tokens?.cached)),
        output: Math.max(0, row.tokens.output - sumVoided(marks, (mark) => mark.tokens?.output)),
      };
  const turns = row.turns === null ? null : Math.max(0, row.turns - marks.reduce((sum, mark) => sum + mark.turns, 0));
  return { tokens, turns };
}

/** 逐项求和（`null` / 缺省按 0 计：没采到不等于「扣 0 条」之外的另一个数） */
function sumVoided(marks: readonly CheckpointVoid[], pick: (mark: CheckpointVoid) => number | undefined): number {
  return marks.reduce((sum, mark) => sum + (pick(mark) ?? 0), 0);
}

/**
 * **回到某一轮**的请求体（`POST /api/checkpoint`）：回到哪一点 + 从这一点要做什么。
 *
 * 与追问的请求体同源（`FollowUpRequestSchema`：同一份附件 schema、同一条条数上限、
 * 同样带 `runId` / `rowId` / `text` / `messageId`），另加三格定位：
 *   · `segment` / `turn`：我们的轮次坐标（界面从轮末 Marker 上直接给）；
 *   · `keepAt` / `dropFrom`：厂商账本里的条目 id（消息账本里那两条消息的 `vendorId`）——
 *     分叉点必须由**账本**给出，不能拿轮次号去猜条目。
 * 「一句话都没有、附件也没有」与追问那条同一条判据，由 api 层拦（要看两个字段）。
 */
export const CheckpointRequestSchema = z.object({
  runId: z.string().min(1),
  rowId: z.string().min(1),
  segment: z.number().int().min(0),
  turn: z.number().int().min(1),
  /** 被保留那一轮最后一条厂商条目 id */
  keepAt: z.string().min(1),
  /** 被丢掉那一轮第一条 prompt 的厂商条目 id；`null` = 不声明 */
  dropFrom: z.string().min(1).nullable(),
  text: z.string(),
  attachments: z.array(InjectAttachmentSchema).optional(),
  messageId: z.string().min(1).optional(),
});
export type CheckpointRequest = z.infer<typeof CheckpointRequestSchema>;
