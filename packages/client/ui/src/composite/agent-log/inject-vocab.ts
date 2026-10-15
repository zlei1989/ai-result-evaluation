/**
 * 人工消息输入区与排队区的**词表与派生判定**（纯函数：无 DOM、无请求、无 React）。
 *
 * 为什么单独一格：这些判定有多个消费方（输入区的可用性、排队区每一行的按钮、回填时那句提示），
 * 而它们各自都要说一句**由声明决定**的人话。判定与文案散在渲染件里，同一件事就会有两份说法，
 * 而漂移在这类地方是**静默的**——界面照旧画得出来，只是说了另一句话。
 *
 * **一处也不判厂商**：所有「哪家能做到哪一档」都从 `TurnInjectionCapability` 读（分层守卫的 (e) 条
 * 扫这一格）。缺省 `null` 读作「**不知道**」，不是「不支持」——把「接口还没给」说成「这家不行」，
 * 正是本仓最防的那种假话。
 *
 * 四态的分工（`inject-vocab.ts` 的契约头注是同一份口径）：`queued` / `delivered` / `consumed`
 * 各按状态渲染，「删除」是**双态动作**（还在我们表里 ⇒ 摘掉；已交给厂商 ⇒ 撤回）；
 * `gone` **跳过不渲染**（它留在表里只为幂等），但它带的 `outcome` / `reason` 是「为什么没了」的
 * 唯一读侧，故这一格在词表里仍然完整存在。
 */
import type {
  Capability,
  InjectAttachment,
  InjectMessage,
  InjectMessageState,
  InjectionBoundary,
  MissingReason,
  RetractAbility,
  TurnInjectionCapability,
} from '@aieval/contracts';
import { CAPABILITY_TO_MISSING_REASON, MISSING_REASON_LABELS } from './types';

/** 两档投递边界的中文（「立即发送」= `round`、「排队」= `idle`） */
export const INJECTION_BOUNDARY_LABELS: Record<InjectionBoundary, string> = {
  round: '立即发送',
  idle: '排队',
};

/** 四态的界面呈现：一句短标签 + 一句说清「它现在在哪、还能不能要回来」的话 */
export interface InjectStatePresentation {
  label: string;
  /** antd `Tag` 的颜色档（`default` = 不给颜色） */
  color: 'blue' | 'cyan' | 'default';
  /**
   * 悬停时那句人话。**每一态都不许把它说成别的态**——尤其 `queued`：
   * 适配器只有「取件」一格、没有「有新消息」的信号 ⇒ 两次通知之间到达的那句话要等到下一格才被
   * 取走，而 `idle` 档更要等这一整轮没活可干了。所以「排队中」不等于「马上就到」。
   */
  note: string;
}

export const INJECT_STATE_PRESENTATION: Record<InjectMessageState, InjectStatePresentation> = {
  queued: {
    label: '排队中',
    color: 'blue',
    note: '还在我们这边排队：智能体下一次可投递的通知边界才取件，而「排队」那一档要等本轮没活可干了才投 —— 发出去不等于立刻到，中间可能隔着一次工具往返。',
  },
  delivered: {
    label: '已交给厂商',
    color: 'cyan',
    note: '已经交给这一家的消息队列，但模型还没读到它 —— 这一刻还撤得回来（成不成看这一家这一档）。',
  },
  consumed: {
    label: '已被模型读到',
    color: 'default',
    note: '厂商已经把它交给模型了 —— 撤不回来，只能如实告诉你。',
  },
  gone: {
    label: '已从队列消失',
    color: 'default',
    note: '这一条已经撤回、或者行收场时被丢弃 —— 它留在表里只为幂等，不再是一个还在等的人话。',
  },
};

/**
 * 队列区真正要画的那几条：**`gone` 跳过**。
 *
 * 跳过而不是画一个灰行：`gone` 是终态，把它画成「还在等」的人话就是界面说谎；
 * 而它为什么消失（`timed-out` / `discarded` / `retracted`）已经由行级事件与账本说过一次，
 * 队列区再画一遍只会多一个会过期的地方。
 */
export function visibleInjectMessages(messages: readonly InjectMessage[]): readonly InjectMessage[] {
  return messages.filter((message) => message.state !== 'gone');
}

/** 「这一档现在投得进去吗」的答复：不可用时必须给一句**能照着做决定**的话 */
export interface InjectAvailability {
  available: boolean;
  /** 不可用时那句人话；可用时为 `null` */
  note: string | null;
}

/**
 * 缺失原因 → 那一句中文。**与 `types.ts` 的 `capabilityReasonOf` 同源**（同两张表、同一条回退）：
 * `reason` 缺席（契约的 `superRefine` 拦着，理论上到不了）时退回**等级自己的文案**，
 * 绝不留半句话。
 */
function missingReasonLabel(state: Exclude<Capability, 'yes'>, reason: MissingReason | null): string {
  return reason === null ? MISSING_REASON_LABELS[CAPABILITY_TO_MISSING_REASON[state]] : MISSING_REASON_LABELS[reason];
}

/** 声明里某一档那一格；声明缺席 ⇒ `null`（读作「不知道」，不是「没有」） */
function deliveryCell(declaration: TurnInjectionCapability | null, boundary: InjectionBoundary) {
  return declaration === null ? null : declaration.delivery[boundary];
}

/**
 * 这一档能不能把人的话投进去。
 *
 * **四句不同的「不能」必须分开说**（`no` / `not-projected-by-vendor` / `off-by-adapter` /
 * `unverified`），声明缺席是第五件事（「我们读不到那份声明」）：合成一句会把读者引向错的动作。
 * 前三句说的是「这条路走不通」——`no` 是「别指望了」（换配置没用），`not-projected-by-vendor`
 * 是「厂商有数据但没送到我们读得到的通道」，`off-by-adapter` 是「等接线」。
 *
 * `unverified` 因此**单独一句模板**：「没验证过」的真意是**我们不敢保证**（通道与接线可能都在，
 * 只是没人端到端跑过），套进「投不进去：」会被读成「已经确认不行」，与词表把它与 `no` 分开的
 * 用意正相反。可用性一律 `false`——声明 `yes` 才做活，界面不许替厂商担保。
 */
export function deliveryAvailability(
  declaration: TurnInjectionCapability | null,
  boundary: InjectionBoundary,
): InjectAvailability {
  const label = INJECTION_BOUNDARY_LABELS[boundary];
  const cell = deliveryCell(declaration, boundary);
  if (cell === null) {
    return {
      available: false,
      note: `「${label}」这一档投不进去：读不到这一家的能力声明（声明缺席读作「不知道」，不读作「支持」）。`,
    };
  }
  if (cell.state === 'yes') return { available: true, note: null };
  if (cell.state === 'unverified') {
    return {
      available: false,
      note: `「${label}」这一档还不能用：${missingReasonLabel(cell.state, cell.reason)}。`,
    };
  }
  return {
    available: false,
    note: `「${label}」这一档投不进去：${missingReasonLabel(cell.state, cell.reason)}。`,
  };
}

/** 一个排队行上的动作按钮：能不能点 + 悬停那句人话（**两种情形都要有话说**） */
export interface InjectRowAction {
  enabled: boolean;
  tooltip: string;
}

/** 撤回能力的四档 → 那一句人话；声明缺席给第五句（不读作四档里的任何一档） */
function retractTooltip(
  ability: RetractAbility | null,
  reason: string | null,
  deliveryBoundary: InjectionBoundary,
): { enabled: boolean; tooltip: string } {
  const prefix = `撤回这一条「${INJECTION_BOUNDARY_LABELS[deliveryBoundary]}」档的消息：`;
  if (ability === null) {
    return {
      enabled: false,
      tooltip: '撤不了：读不到这一家的能力声明（声明缺席读作「不知道」，不读作「能撤」）。',
    };
  }
  const detail = reason ?? '';
  switch (ability) {
    case 'by-id':
      return { enabled: true, tooltip: `${prefix}${detail}` };
    case 'unverified':
      // 允许试一次：撤不成时端口会如实回 `unsupported` / `unknown`，那一条原样留在队列里，
      // 界面据此说清原因 —— 试一次的代价只是多一条提示，比「明明没验过却说撤不了」诚实
      return { enabled: true, tooltip: `没验证过按条撤回（${detail}）：试一次，撤不成会如实说原因，那一条会留在队列里。` };
    case 'flush-only':
      return {
        enabled: false,
        tooltip: `这一家只支持清空整条队列，不提供按条撤回：${detail}`,
      };
    case 'none':
      return { enabled: false, tooltip: `这一家撤不回已经交给厂商的消息：${detail}` };
  }
}

/**
 * 「删除」这一颗按钮（**双态动作**，按这一条的状态分派）：
 *   · `queued`——还在我们的表里，摘掉即可；
 *   · `delivered`——已交给厂商，走这一家这一档的撤回面（能不能撤由声明决定）；
 *   · `consumed`——已经被模型读到，任何时候都禁用（不看声明）；
 *   · `gone`——不该被画出来（调用方先跳过），这一格只作为兜底。
 */
export function deleteActionOf(
  message: InjectMessage,
  declaration: TurnInjectionCapability | null,
): InjectRowAction {
  switch (message.state) {
    case 'queued':
      return { enabled: true, tooltip: '从队列里摘掉：它还没交给厂商，撤回来之后内容会回填到输入框。' };
    case 'delivered': {
      const retract = declaration === null ? null : declaration.retract[message.requires];
      return retractTooltip(retract?.state ?? null, retract?.reason ?? null, message.requires);
    }
    case 'consumed':
      return {
        enabled: false,
        tooltip: message.reason === null ? '已经交给智能体了，撤不回来。' : `已经交给智能体了，撤不回来：${message.reason}`,
      };
    case 'gone':
      return { enabled: false, tooltip: '这一条已经从队列里消失了。' };
  }
}

/**
 * 「立即发送」（改期）这一颗按钮：**只对还在排队、且要求「排队」的那一条可用**。
 *
 * 交出去之后边界已经用掉了（改不了）；本来就要求立即发送的那一条再点一次是空转。
 * 这一家的「立即发送」档投不进去时也禁用——放它过去只会让那一条卡在投不出去的要求上，
 * 最后由等待预算收场（那是**更坏**的结局）。
 */
export function promoteActionOf(
  message: InjectMessage,
  declaration: TurnInjectionCapability | null,
): InjectRowAction {
  if (message.state === 'consumed') return { enabled: false, tooltip: '已经交给智能体了：边界用掉了，改不了。' };
  if (message.state === 'delivered') return { enabled: false, tooltip: '已经交给厂商了：边界用掉了，改不了。' };
  if (message.state === 'gone') return { enabled: false, tooltip: '这一条已经从队列里消失了。' };
  if (message.requires === 'round') {
    return { enabled: false, tooltip: '这一条本来就要求立即发送。' };
  }
  const availability = deliveryAvailability(declaration, 'round');
  return availability.available
    ? { enabled: true, tooltip: '改成立即发送：等当前这一步结束就投，不再等整轮收场。' }
    : { enabled: false, tooltip: availability.note ?? '这一家的「立即发送」档投不进去。' };
}

/**
 * 撤回成功、内容回填输入框时那句**一次性提示**。
 *
 * 判据是 `deliveredAt` 而不是 `state`：撤回成功后条目已经是 `gone`，但它**确实到过厂商手里**
 * （可能已经被模型看到）——重发会变成两条，这句话不说，用户就以为删干净了。
 * 从没投出去过的那一条（`deliveredAt === null`）没有任何风险，**不给提示**（多说一句会让真的
 * 需要读它的那一句变得不显眼）。
 */
export function refillNoticeOf(message: InjectMessage): string | null {
  if (message.deliveredAt === null) return null;
  return '这一条已经交给过智能体（可能已被看到），内容已回填到输入框；重发会变成两条。';
}

/**
 * 草稿里的一份附件（**界面这一侧**的形状）。
 *
 * 与契约的 `InjectAttachment` 差三格，都是「这一刻在界面上怎么样」而不是「盘上是什么」：
 *   · `uid`——X 的清单按它认条目（同一份文件重复选两次是两条）；
 *   · `name`——显示名（用户在系统选择器里看到的那个名字）；
 *   · `status`——`uploading`（正在落盘）/ `done`（已有路径）/ `error`（没落成）。
 *
 * `path`：落盘成功才有（落完才允许发送——登记那一刻正文与附件清单就是完整事实）。
 * 从队列里回填回来的附件**天然带路径**（它们本来就在盘上），故直接是 `done`。
 */
export interface PendingInjectAttachment {
  uid: string;
  name: string;
  status: 'uploading' | 'done' | 'error';
  /** 落盘后的绝对路径；没落成时 `null` */
  path: string | null;
  mimeType: string | null;
}

/** 附件路径的显示名：取路径最后一段（回填回来的附件只有路径，没有原始文件名） */
export function attachmentNameOf(path: string): string {
  const segment = path.split('/').filter((part) => part !== '').pop();
  return segment === undefined || segment === '' ? '附件' : segment;
}

/** 契约里的附件清单 → 草稿里的一份（回填用：文件已经在盘上，故直接是 `done`） */
export function pendingFromAttachment(attachment: InjectAttachment, uid: string): PendingInjectAttachment {
  return {
    uid,
    name: attachment.path === null ? '附件' : attachmentNameOf(attachment.path),
    status: 'done',
    path: attachment.path,
    mimeType: attachment.mimeType,
  };
}

/**
 * 「删除」回填时草稿正文怎么变：**补到现有草稿前面、用一个换行隔开**（用户原话）。
 *
 * 草稿是空的时候不要多一个前导换行（那会在输入框顶上留一行空行，用户得先删掉它）。
 */
export function refillDraftText(draft: string, text: string): string {
  if (draft.trim() === '') return text;
  return `${text}\n${draft}`;
}

/**
 * 「删除」回填时附件怎么变：**文本与附件一起回填**（只回文本会静默丢文件——用户以为内容都回来了，
 * 而那份文件再也发不出去）。回填进来的条目按 `uid` 去重：同一条消息撤两次不该出现两份。
 */
export function refillDraftAttachments(
  pending: readonly PendingInjectAttachment[],
  message: InjectMessage,
): PendingInjectAttachment[] {
  const existing = new Set(pending.map((item) => item.uid));
  const restored = message.attachments
    .map((attachment, index) => pendingFromAttachment(attachment, `refill-${message.messageId}-${String(index)}`))
    .filter((item) => !existing.has(item.uid));
  return [...restored, ...pending];
}

/**
 * 铸一条人工消息的 id（同时是登记的幂等键与附件目录名）。
 *
 * 形状由契约的 `INJECT_MESSAGE_ID_PATTERN` 钉死：UUID 的首字符是十六进制数字，故天然合规，
 * 也不必再拼前缀。**不在这里生成时间戳型的 id**：时间戳不是身份，重复点发送时它挡不住第二次登记。
 */
export function newInjectMessageId(): string {
  return globalThis.crypto.randomUUID();
}

/**
 * 输入区下面那行常驻提示：**发出去不等于立刻到**。
 *
 * 为什么常驻而不是只在悬停里说：在途取件的节拍是适配器的**通知边界**（端口只有「取件」一格、
 * 没有「有新消息」的信号），而「排队」那一档还要等这一整轮没活可干了——两次通知之间到达的那句话
 * 要等到下一格才被取走。用户看不到这句话就会以为「按了发送 = 智能体马上看到」。
 */
export const INJECT_QUEUE_HINT =
  '发出去先排队：智能体在下一次可投递的通知边界取件，而「排队」那一条要等本轮收完才投递 —— 发出去不等于立刻到。';

/**
 * X 的文件清单 → 这一轮**新选进来**的那几份原始文件。
 *
 * 三处必须这样写：
 *   · 只认 `originFileObj`（antd 的 `file2Obj` 把原始 `File` 挂在这一格上）：刚点选那一份的
 *     `file` 字段是 antd 为「不真上传」造的一个克隆，它上面**没有**原始文件；
 *   · 按 `uid` 排重：触发态那个 `Attachments` 的清单是累积的（它的 `items` 不归我们控制），
 *     不去重就会把同一份文件重复上传，附件目录里出现两份；
 *   · 取不到 `File` 的条目**跳过**（而不是抛）：它可能是拖拽失败留下的空壳。
 */
export function pickedFiles(
  items: readonly { uid: string; originFileObj?: unknown }[],
  seen: ReadonlySet<string>,
): { uid: string; file: File }[] {
  const picked: { uid: string; file: File }[] = [];
  for (const item of items) {
    if (seen.has(item.uid)) continue;
    if (!(item.originFileObj instanceof File)) continue;
    picked.push({ uid: item.uid, file: item.originFileObj });
  }
  return picked;
}
