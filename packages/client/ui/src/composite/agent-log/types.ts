/**
 * `agent-log` 的**渲染模型**：界面需要什么形状，数据层就喂什么形状。
 * 与 `@aieval/contracts` 的 `AgentMessage` / `SubagentRecord` 是**两份形状**，不是两套真值：
 * 契约描述「采到了什么」，这里描述「界面画什么」（`RenderBlock` 已配对、已分组，
 * 折叠与虚拟化所需的稳定键已经就位，原始载荷的截断与字节数由数据层算好）。
 *
 * 本文件以类型与文案表为主，另有三个**纯函数**（`capabilityReasonOf` / `truncationNote` / `toCapabilityMap`）——它们只是派生文案与映射，不持状态、不取数。组件从它取名字，不从这里取状态。
 *
 * 三条贯穿全文件的纪律（违反任一条，界面就会把「没有」说成「没采到」）：
 *   1. **`null` 只表示未采集**，永远不等于 0 / 空串 / 空数组；
 *   2. **不做推断**：`running`、`assembly`、`truncation` 都由数据层给，
 *      界面不得用「有没有结果」「是不是最后一块」推出来（推断一次，被中断的块就会永远转圈）；
 *   3. **不判厂商**：本目录不出现 `agentKind` 分支，族名与组名一律按收到的值渲染。
 */
import type { AgentMessage, Capability, MessageCapability, MessageSource, MissingReason, SubagentRecord, ThinkingTextKind, ToolFamily } from '@aieval/contracts';

/**
 * **环境信息模型从 contracts 转出**（2026-10-03 落点修正）。
 *
 * 它原来是本文件里的一份定义，而设计 §4.3 写的就是「进 `@aieval/contracts`」——
 * 那些名字里没有一个界面词汇（没有色档、折叠键、渲染块），全是「这次运行被下发了什么」的事实；
 * 留在 ui 里的后果是**服务端永远造不出这个对象**，而它是排障第一个要看的东西。
 * 这里 `export type` 转出，本目录与消费方的 import 路径一个都不用改。
 */
export type {
  AgentEnvironment,
  AgentEnvironmentSummary,
  EnvGroup,
  EnvItem,
  EnvSource,
} from '@aieval/contracts';

/**
 * 运行状态。界面只要「一个色档 + 一句文案」，不复用评测编排的十态词汇
 * （`preparing` / `judging` 这些段只有本仓的评分通路才有）。
 * `tone` 是**界面词汇**（决定徽标色与要不要挂动效），`label` 是**数据层给的文案**。
 */
export interface AgentRunStatus {
  tone: 'pending' | 'running' | 'ok' | 'failed' | 'canceled';
  label: string;
}

/** 计量三项。整格为 `null` = 这一家根本不报（**不写 0**） */
export interface AgentTokens {
  /** 非缓存输入 */
  input: number;
  cached: number;
  output: number;
}

/**
 * 领域事实里的一**段**内容（2026-10-07 用户口径：改动那一格按 git 惯例给 `+N` / `−N` 上色，
 * 模型名 / 智能体 / 档位做成一枚 `Tag`）。
 *
 * 为什么必须由数据层给成段、而不是界面自己拆：**UI 不解析领域事实**（它不知道「改动」「智能体」
 * 是什么）。所以「哪一段是新增、哪一段是删除、哪一段是标识符」只能由数据层声明，渲染层只按声明画。
 */
export interface DomainFactSegment {
  text: string;
  /** `insertion` / `deletion` 按 git 惯例上色（新增绿 / 删除红）；不给 = 跟随所在文字的颜色 */
  tone?: 'insertion' | 'deletion';
  /** 这一段的身份标识（模型名这类）：画成一枚 `Tag`，从同格的叙述文字里跳出来 */
  tag?: boolean;
  /**
   * `tag` 段的**色档**（不给 = `blue`）。与 `AgentRunStatus.tone` / `DomainFact.tone` 同一条口径：
   * 数据层给的是**档位**（界面词汇），渲染层把它翻成 antd 的具体预设色。
   * 2026-10-07 的三格：智能体 `blue` / 模型 `geekblue` / 思考强度 `purple`——同一个档位在本仓的
   * 两处（事实条那一行与评分详情顶部）长得一样。
   */
  tagTone?: 'blue' | 'geekblue' | 'purple';
}

/**
 * 一条**领域事实**（改动 / 评分这类）。形状因场景而异，故由数据层给成「一行文字 + 一个色档」，
 * UI 只摆版、不解析（多值由数据层拼成一行）。
 */
export interface DomainFact {
  id: string;
  /** 格名由数据层给——组件的文案表里没有「评分」「改动」这些业务概念 */
  label: string;
  value: string;
  /**
   * 值的**逐段渲染**：给了就按段画（各段 `text` 拼起来必须逐字等于 `value`，由数据层用同一份分段
   * 拼出来），不给就画 `value` 的纯文本。
   *
   * **给了 `segments` 就不再套色档 `Tag`**：改动那一格按 git stat 排版（文件数次要色 + 新增绿 +
   * 删除红），外面再套一枚徽标会把这行数字框成一个整体，正是用户要去掉的那个观感。
   */
  segments?: readonly DomainFactSegment[];
  tone?: 'default' | 'success' | 'warning' | 'error';
  /** 补充说明（改动那一格放「按预算裁剪过」）。**完整结构由各自的详情抽屉读自己的 props**，不走这里 */
  hint?: string;
  /** 提示的逐段渲染，约定同 `segments`（各段拼起来等于 `hint`） */
  hintSegments?: readonly DomainFactSegment[];
}

/** 行级事实。会随时间自己变的量（耗时）**不在模型里**——界面用 `useNow` 本地走秒表算 */
export interface AgentLogFacts {
  status: AgentRunStatus;
  /** 开始时刻；`null` = 还没开始 */
  startedAt: string | null;
  /** 结束时刻；`null` = 还在跑 */
  endedAt: string | null;
  /** 已观察到的轮次；`total` 为 `null` = 还没跑完（**不是**「一共就这么多」） */
  turns: { current: number; total: number | null };
  tokens: AgentTokens | null;
  /**
   * 思考 token 的结算值与它的**可加性**。`basis !== 'additive'` 时**不提供任何相加口径**：
   * `subset-of-output` 相加即双计，`unknown` 连跨家比较都不允许。
   */
  thinking: { tokens: number; basis: 'subset-of-output' | 'additive' | 'unknown' } | null;
  domain: readonly DomainFact[];
  /** 失败归因。`code` 可为 `null`：不是每种失败都有错误码 */
  error: { code: string | null; message: string } | null;
}

/**
 * 「还没到 / 读失败 / 有了」三态。用判别联合而不是 `{ data?, isLoading, error }` 三兄弟：
 * 后者允许 `isLoading && error && data` 这种自相矛盾的组合存在，而每个消费者都得自己猜优先级。
 */
export type Loadable<T> =
  | { status: 'loading' }
  | { status: 'error'; error: unknown }
  | { status: 'ready'; data: T };

/**
 * 节点的运行状态。**七档**——`stopped` / `canceled` / `unsettled` 三档各有各的语义，不可并。
 *
 * ⚠️ **`unsettled` 目前赋不出来**：两条装配路径各只走五档，并集六档、恰好缺这一档
 * （`build-model.ts` 的 `nodeStatusOf` 直映契约 `SubagentStatus` 五态；
 * `statusForFacts` 从 `facts.status.tone` 反推）。它要的判据是「收场事件没到 + 整行已终态」，
 * 那一格还没写——面板与文案都已就位，只差装配层这一步。
 */
export type LogNodeStatus = 'running' | 'completed' | 'failed' | 'stopped' | 'canceled' | 'unsettled' | 'unknown';

/** 截断**三态**：`none` = 确认完整、`truncated` = 确认被截断、`unknown` = 没采到标记（界面写「可能不完整」） */
export type TruncationState = { kind: 'none' } | { kind: 'truncated'; reason: string | null } | { kind: 'unknown' };

/** 一个能力维度的完整声明：等级 + 出处 + 为什么，三者同源、绑成一个不可分的对象 */
export interface CapabilityDecl {
  level: Capability;
  /** 这一格的值从哪条通道取到；`level === 'yes'` 时非空，其余四态为 `null` */
  source: MessageSource | null;
  /** 为什么取不到；`level !== 'yes'` 时非空，`'yes'` 时为 `null` */
  reason: MissingReason | null;
}

/** 能力声明：**维度名由数据层给**，界面按收到的顺序渲染，不硬编码任何维度名 */
export type MessageCapabilityMap = Readonly<Record<string, CapabilityDecl>>;

/** 六类块共有的归属字段 + 来源三格（契约把它放在消息信封上，定型时摊到块上） */
export interface ContentBlockBase {
  /** 稳定键：折叠态 / React key 都挂在它上面，**不用数组下标**（下标会随流式追加漂移） */
  id: string;
  at: string;
  messageId: string;
  /** 非空表示这条来自子任务（时间轴靠它过滤防串台） */
  subagentId: string | null;
  /** 说话者。`assistant` 是默认主角；`user` / `system` 要标出来，否则三种话逐字同形 */
  role: 'assistant' | 'user' | 'tool' | 'system';
  /** 这条数据从哪条通道来；非 `wire` 时界面标「补录 / 汇总」 */
  source: MessageSource;
  /** 块形态。`open` = 还没收到过快照（进程被中断的块停在这里），**动效的唯一判据** */
  assembly: 'snapshot' | 'open';
  /**
   * 这条块所属的**逻辑消息**身份（= 契约的 `mergeKey`）。
   * 时间轴按它把「同一条消息的多个块」归成一条，**不得**改用 `messageId`：
   * 那是**每次投递**新分配的（同一条逻辑消息的 delta 与 snapshot 是两个不同 id）。
   */
  mergeKey: string;
  /** 这条消息自己那一次调用的用量；`null` = 没有这一格（页脚不渲染） */
  usage: AgentTokens | null;
}

/** 正文：**只有它走 markdown**（思考、命令、结果都不是 markdown，解析只会得到字面标记） */
export interface TextBlock extends ContentBlockBase {
  kind: 'text';
  text: string;
}

/**
 * 思考：文本可空（契约允许「有思考、无文本」那一档），但**界面不渲染无正文的思考块**——
 * `build-model` 会在模型层把 `text === null` 的整块过滤掉（没有就不显示，不给占位文案）。
 * `textMissing` 因此只是形状上的兼容格（恒 `null`）：老日志带着它，界面不再有渲染出口。
 */
export interface ThinkingBlock extends ContentBlockBase {
  kind: 'thinking';
  text: string | null;
  textMissing: MissingReason | null;
  /** 文本的完备性：claude 完整推理 / codex 只有摘要 / dsh 完整原文。界面据它标「摘要」而不是假称全文 */
  textKind: ThinkingTextKind;
}

/** 工具调用：与 `tool-result` 按 `callId` 配对 */
export interface ToolCallBlock extends ContentBlockBase {
  kind: 'tool-call';
  callId: string | null;
  /** 工具名**原样透传**（改名会让厂商认不出自己的调用）；拿不到时是空串 + `nameMissing` */
  name: string;
  nameMissing: MissingReason | null;
  /** 归一后的族名；`null` = 适配器不认识这个工具 */
  family: ToolFamily | null;
  input: { value: string | null; text: string | null; bytes: number | null };
  /** 族载荷。`null` = 本期没有为它收编专门卡片（UI 走通用工具行） */
  tool: ToolFamilyPayload | null;
}

/**
 * 工具结果：`status` / `bytes` / `truncation` 都由数据层判定（UI 不判断大小）。
 *
 * `structured` 是**厂商已解析的结构化结果**（`boolean` 只表示「有没有」）。
 * 为什么保留这一格而不是丢掉：规范明写「**有 `meta` 就不要退回去解析文本**」，
 * 而 dsh 的 `read` / `write` / `edit` / `grep` / `glob` 的结果正文只是一段人读的摘要
 * （`<path>…</path>` 那种），**行数、命中数、改动对象这些已解析过的事实只在 `structured` 里**。
 * 丢掉它，界面上就只剩摘要可读——那是「有数据但看不见」的另一种形状。
 * 呈现口径（§12.6 的既有取舍）：**等宽原文，不做族专属渲染**，并如实标注它是结构化结果。
 */
export interface ToolResultBlock extends ContentBlockBase {
  kind: 'tool-result';
  callId: string | null;
  text: string;
  structured: unknown;
  status: 'ok' | 'error' | 'unknown';
  bytes: number;
  truncation: TruncationState;
}

/** **附件本体**：厂商给的真实图片 / 文件（不是「不认识的载荷」——那是 `unrecognized`） */
export interface AttachmentBlock extends ContentBlockBase {
  kind: 'attachment';
  attachmentKind: 'image' | 'file';
  /** 厂商给的路径；`null` = 内联附件（不显示空白，也不编造路径） */
  path: string | null;
  mimeType: string | null;
}

/** 兜底：**我们不认识的厂商载荷**。正文是原文 `raw`，`reason` 说明为什么落到这里 */
export interface UnrecognizedPayloadBlock extends ContentBlockBase {
  kind: 'unrecognized';
  reason: 'unrecognized' | 'unmapped-shape';
  vendorType: string | null;
  raw: string | null;
}

export type ContentBlock =
  | TextBlock
  | ThinkingBlock
  | ToolCallBlock
  | ToolResultBlock
  | AttachmentBlock
  | UnrecognizedPayloadBlock;

/** 卡片底部的「原始结果」：卡片可以只画归一后的形状，但原文必须可查 */
export interface ToolCardResult {
  ok: boolean;
  raw: string | null;
  truncation: TruncationState;
}

/** `task` 族清单的一步。字段与规范同名同义 */
export interface TaskStep {
  /** 稳定 id；`null` = 这一家给不出（**不自己发号**：编出来的 id 会让依赖看起来解析成功了） */
  id: string | null;
  subject: string;
  status: 'pending' | 'inProgress' | 'completed' | 'unknown';
  /** `null` = 这一家没有「指派」这个概念（**整格不显示**）；`''` = 有概念但当前无人认领 */
  owner: string | null;
  /** 依赖的 id 列表；拿不到为 `null` */
  blockedBy: readonly string[] | null;
}

/** `task` 族的卡片载荷：**本次调用之后的整张清单**（差异是适配器收敛出来的，UI 不自己算） */
export interface TaskPanel {
  steps: readonly TaskStep[];
  /** 计数是派生值，由数据层给；`unknown` 必须是第四格，否则含未知项的「3/5 完成」分母必错 */
  counts: { pending: number; inProgress: number; completed: number; unknown: number };
  /** 与**上一张**清单的差分；`null` = 该节点首次出现清单（没有可比的上一张） */
  change: { completed: number; added: number; removed: number } | null;
  note: string | null;
  at: string;
  result: ToolCardResult | null;
  /** 有调用、结果还没到、**且所在轮次尚未结束** */
  running: boolean;
}

/** 一个提问的选项 */
export interface AskUserOption {
  label: string;
  description: string | null;
  recommended: boolean;
}

/** 一个问题 */
export interface AskUserQuestion {
  /** 短标题（建议 8 字符内）。**不截断**：截断会改事实 */
  header: string;
  prompt: string;
  options: readonly AskUserOption[];
  multiSelect: boolean;
  /** 允不允许自由输入；追加一行「其它（自由输入）」 */
  allowOther: boolean;
  /** 默认遮罩（`••••` + 「显示」按钮）。**遮罩是显示口径，不是安全边界** */
  secret: boolean;
}

/** 一份答案。`selected` 装的是**选项标签**（不是 id、不是下标） */
export interface AskUserAnswer {
  header: string;
  selected: readonly string[];
  /** 自由输入。多选时是**补充**（标签与自由输入都显示），单选时是**覆盖**（只显示自由输入） */
  custom: string | null;
}

/** 收场方式（七态） */
export type AskUserOutcome =
  | 'answered'
  | 'auto-resolved'
  | 'skipped'
  | 'timeout'
  | 'unavailable'
  | 'rejected'
  | 'canceled';

/** **还没收场**：答案一定还没到（不是「空数组」——「没人回答」与「答了但一个都没选」是两件事） */
export interface AskUserPending {
  state: 'pending';
  questions: readonly AskUserQuestion[];
  at: string;
  /** **还在等**（`true`）还是**等不到了**（`false`）。后者不能一直转圈 */
  running: boolean;
}

/** **已收场**：`outcome` 与 `answers` 成对出现，不再各自可空 */
export interface AskUserSettled {
  state: 'settled';
  questions: readonly AskUserQuestion[];
  outcome: AskUserOutcome;
  /** `null` = 收场了但没有答案可回填（如 `unavailable` / `timeout`） */
  answers: readonly AskUserAnswer[] | null;
  at: string;
  result: ToolCardResult | null;
}

/**
 * 一次提问的两种收场形态。做成判别联合之后，
 * 「`answers` 非空 + 没有 `outcome` + `running === false`」这个自相矛盾的组合**在类型上写不出来**。
 */
export type AskUserInteraction = AskUserPending | AskUserSettled;

/** 工具族载荷。本期只收编两族——它们的形态与「一行工具摘要」差得最远，且都必须跳出工具组单独成卡 */
export type ToolFamilyPayload =
  | { family: 'task'; panel: TaskPanel }
  | { family: 'ask-user'; interaction: AskUserInteraction };

/**
 * 行级事件的**归属键**：这一条属于哪个会话的哪一轮（`subagentId: null` = 主会话）。
 * 形状与契约 `usage.turn` 一致，但界面用**自己的名字**（"UI 永远看不到传输层"那条边界的同一条处置）。
 */
export interface TurnRef {
  subagentId: string | null;
  round: number;
}

/**
 * 时间轴上必须可见的行级事件（谁进这张表由数据层的去向表决定）。
 *
 * ⚠️ **`level: 'warning'` 这一档目前没有产出方**：`build-model.ts` 的 `rowEventsOf` 只写
 * `'error'` 与 `'milestone'` 两种；适配器把 codex 的 item 级 `error` 折成 `warning` 那一步还没落地。
 * 类型与渲染出口先留着（那种告警确实存在，只是现在落在「原始输出」的 `log` 原文里）。
 */
export interface RowEvent {
  at: string;
  /** 三档：`milestone` / `error` / **`warning`**（消息层的非致命告警**不得**当成运行失败） */
  level: 'milestone' | 'error' | 'warning';
  text: string;
  /**
   * 归属键（2026-10-05）：有时间轴的落点由它决定——**有键按「身份 + 号」精确归位，无键按时刻**
   * （见 `rowEventsOfTurn`）。`null` = 没有归属信息（`error` / `warning`，以及算不出归属的里程碑）。
   */
  turn: TurnRef | null;
}

/** 一个轮次。**只做轻量分组，不建渲染块**——几百轮时先全建 `RenderBlock`，虚拟滚动就只省了 DOM */
export interface LogTurn {
  /** 统一轮次号 =「模型一次 API 往返」；`null` = 不属于任何轮次的内容（集中成顶部的「未归属」段） */
  round: number | null;
  at: string;
  subagentId: string | null;
  /** **已成形的内容块**（增量累积与快照覆盖都在数据层做完了） */
  blocks: readonly ContentBlock[];
  tokens: AgentTokens | null;
  /** 该轮的**已结算**时长（毫秒）；`null` = 拿不到 */
  durationMs: number | null;
  /** 该轮是否尚未结束。`ToolItem.running` 与块级动效在轮次级的兜底判据，**不由 UI 推断** */
  running: boolean;
}

/** 两张节点形态共有的格 */
export interface LogNodeBase {
  id: string;
  parentId: string | null;
  /** 派发点：这个子任务是在父会话时间轴的哪个位置被派出去的（主会话为 `null`） */
  spawnedBy: { messageId: string; callId: string | null; at: string } | null;
  /** 状态永远给一个**可渲染的值**（采不到就是 `'unknown'`） */
  status: LogNodeStatus;
  /** **为什么采不到**。与 `status` 分开记，界面要同时显示两句 */
  statusMissing: MissingReason | null;
  startedAt: string | null;
  endedAt: string | null;
  /** 该节点的内容。**按值给，不是取数回调** */
  content: Loadable<readonly LogTurn[]>;
  /** 内容被上限截断时给一句人话；`null` = 完整 */
  contentTruncatedReason: string | null;
  /** 能力声明：UI 用它把「这家不支持」「厂商没投送」「我们没接」「没验证过」显示成**四句**不同的话 */
  capability: MessageCapabilityMap;
  /** 能力成立的前提（路由 / 模型 / 开关）；空数组 = 无条件成立 */
  capabilityNotes: readonly string[];
}

/** **会话节点**：主会话与子任务**共用同一份形状** ⇒「子任务与主会话逐字同形」是类型保证而不是约定 */
export interface SessionNode extends LogNodeBase {
  kind: 'main' | 'subagent';
  source: MessageSource;
  /** 子智能体身份；主会话为 `null`。任务名兜底取它前 8 位 */
  subagentId: string | null;
  vendorId: string | null;
  /** 派发方式（`spawn_agent` / `Task` …）；与 `kind` 不是一回事 */
  dispatchKind: string | null;
  name: string | null;
  nameMissing: MissingReason | null;
  /** 该节点的首条消息（用户提示词）。主会话是对它说话的那个人给的；子任务是父派给它的指令 */
  userPrompt: { text: string; at: string } | null;
  /** 子任务自己的往返用量；主会话为 `null`（主会话的整行用量在 `AgentLogModel.facts.tokens`） */
  usage: AgentTokens | null;
  /** 子智能体的最终答复；拿不到为 `null`（**不得拿推理或状态文案顶替**） */
  outcome: string | null;
  /** 会话级事实。**主会话为 `null`**（它的行级事实在 `AgentLogModel.facts`） */
  sessionFacts: SessionFacts | null;
}

/** 会话级事实：只有子任务节点才可能有的那几格 */
export interface SessionFacts {
  exitReason: string | null;
  error: { code: string | null; message: string } | null;
}

/** **行级节点**：厂商只给汇总、没有逐个身份的那一档。**它不进面包屑、不可点** */
export interface RowNode extends LogNodeBase {
  kind: 'row';
  counts: { subagents: number; completed: number; failed: number } | null;
  /** 行级事实（这一档**必然**是行级，故非空） */
  facts: AgentLogFacts;
}

export type LogNode = SessionNode | RowNode;

/** 会话树索引：`buildRenderBlocks` 的规则 3（派发点）用它定位 */
export type LogNodeIndex = ReadonlyMap<string, LogNode>;

/** 抽屉渲染的输入模型（UI 的全部输入） */
export interface AgentLogModel {
  /** 契约版本：UI 据此判断来的是不是它认识的那一版 */
  specVersion: 1;
  /** 这一行的事实（只读，不含任何会自己走的数） */
  facts: AgentLogFacts;
  /** 会话树**扁平**存储：主会话 + 所有后代子任务 */
  nodes: readonly LogNode[];
  /** 当前视图（面包屑选中的节点） */
  activeNodeId: string;
  rowEvents: readonly RowEvent[];
  /** 全无内容（还没跑过）：决定显示空态，而不是空时间轴 */
  empty: boolean;
}

/** 一行的**原始输出**（`log` 事件的原文）。它是**原文，不是事件**：没有 `seq`、没有事件类型 */
export interface AgentLogDiagnostics {
  /** 逐字原文行。UI 不截断、不解析、不合并 */
  lines: readonly {
    at: string;
    source: 'stdout' | 'stderr';
    text: string;
    /** **给人看的一句话**；没有就是 `null`。有值时优先渲染，`text` 原文仍逐字给出 */
    summary: string | null;
  }[];
  /** 因上限只保留了最近 N 行时给一句人话；`null` = 完整 */
  truncatedReason: string | null;
}

/**
 * 数据来源：把「什么时候要哪一份数据」从组件里搬出去。
 * 组件只负责**在需要时喊一声**，取不取、缓存多久、怎么合并全由实现方决定——
 * UI 仍然不做取数，它只是把「我需要了」这件事上报。
 */
export interface AgentLogSource {
  /** 「环境信息现在需要了」（用户点了「？环境信息」）。**组件不 await 它**，状态一律由 `environment` 表达 */
  requestEnvironment?(): void;
  /** 同上，对应「原始输出」面板展开 */
  requestDiagnostics?(): void;
  /** 节点内容读取失败时的重取。**给 `nodeId`**：数据层可能只缓存了部分节点 */
  retryNode?(nodeId: string): void;
}

/**
 * 缺失原因的四句中文。**四句必须互不相同**——把「这家没有」说成「我们没接」，
 * 就是「假装采到了」的反面：假装没这个地方。
 */
export const MISSING_REASON_LABELS: Record<MissingReason, string> = {
  'not-supported': '这家结构上不支持',
  'not-exposed': '厂商有数据、但没投送到我们能读的通道',
  'not-observed': '厂商有、我们还没接',
  unverified: '没验证过',
};

/**
 * 能力**等级**与缺失**原因**的固定对照（`yes` 没有缺失，故只有四格）。
 *
 * 为什么需要它：两者是**两套词汇**——`CapabilityDecl.level` 说「这一格是哪种状态」，
 * `MissingReason` 说「为什么没有」。界面上要拿等级换原因文案时，就地写一张 `switch`
 * 或直接拿等级去索引 `MISSING_REASON_LABELS` 都是错的（后者类型上就不成立）。
 * 有这一张表，「四句文案」与「四个等级」永远同源，不会一边改了另一边没改。
 */
export const CAPABILITY_TO_MISSING_REASON: Record<Exclude<Capability, 'yes'>, MissingReason> = {
  no: 'not-supported',
  'not-projected-by-vendor': 'not-exposed',
  'off-by-adapter': 'not-observed',
  unverified: 'unverified',
};

/**
 * 能力五态的中文。`yes` 不显示原因，故这里只写四句。
 * **与 `MISSING_REASON_LABELS` 同源**（经 `CAPABILITY_TO_MISSING_REASON` 取）：
 * 同一句「这家结构上不支持」在能力格与缺失格必须是同一句话，抄两遍就会漂。
 */
export const CAPABILITY_LEVEL_LABELS: Record<Exclude<Capability, 'yes'>, string> = {
  no: MISSING_REASON_LABELS[CAPABILITY_TO_MISSING_REASON.no],
  'not-projected-by-vendor': MISSING_REASON_LABELS[CAPABILITY_TO_MISSING_REASON['not-projected-by-vendor']],
  'off-by-adapter': MISSING_REASON_LABELS[CAPABILITY_TO_MISSING_REASON['off-by-adapter']],
  unverified: MISSING_REASON_LABELS[CAPABILITY_TO_MISSING_REASON.unverified],
};

/**
 * 一维能力声明 → 「为什么没有」的**那一句中文**；拿不到原因时给 `null`。
 *
 * 三条口径（2026-10-04 收敛：此前这段判定在 `agent-log-layout.tsx` 里抄了两遍，
 * 而它马上要有第三、第四个调用点——每抄一遍就多一次说错话的机会）：
 *   · `level === 'yes'` ⇒ `null`：「有」没有缺失原因可给（契约里那一格的 `reason` 就是 `null`）；
 *   · **没谈到那一维**（`undefined`）⇒ 也给 `null`：声明里没有这一格是「没验证到这一步」，
 *     不是「这一维没有」——编一句「没验证过」出来就等于替厂商下了结论；
 *   · 有等级没原因（契约的 `superRefine` 拦着，理论上到不了）⇒ 退回**等级自己的文案**，
 *     绝不留半句话（「结果未采集 · 」后面空着比不写更糟）。
 *
 * 四句原因**互不相同**，它们回答的是四件不同的事（谁该去修）：
 * 这家结构上不支持 / 厂商有数据但没投送 / 厂商有我们还没接 / 没验证过。
 */
export function capabilityReasonOf(declaration: CapabilityDecl | undefined): string | null {
  if (declaration === undefined || declaration.level === 'yes') return null;
  return declaration.reason === null
    ? CAPABILITY_LEVEL_LABELS[declaration.level]
    : MISSING_REASON_LABELS[declaration.reason];
}

/** 取数通道的中文（块角标与能力声明共用） */
export const MESSAGE_SOURCE_LABELS: Record<MessageSource, string | null> = {
  wire: null,
  hook: null,
  'session-file': '补录',
  aggregate: '汇总',
};

/** 节点状态七档的中文。**`unsettled` 与 `running` 必须是两句不同的话**（「等不到了」vs「还在等」） */
export const LOG_NODE_STATUS_LABELS: Record<LogNodeStatus, string> = {
  running: '运行中',
  completed: '已完成',
  failed: '失败',
  stopped: '已被厂商终止',
  canceled: '随轮次中断',
  unsettled: '未收场（等不到结果了）',
  unknown: '状态未知',
};

/** 工具族的中文。**族名不是工具名的替代品**：卡片按族分派，工具名一律原样透传 */
export const TOOL_FAMILY_LABELS: Record<ToolFamily, string> = {
  'read-file': '读文件',
  'write-file': '写文件',
  'edit-file': '改文件',
  'search-content': '搜内容',
  'list-files': '列文件',
  'run-shell': '跑命令',
  'web-search': '联网搜索',
  'spawn-agent': '派子任务',
  task: '计划清单',
  'ask-user': '向用户提问',
};

/** 问题清单四态的文案。`unknown` **不显示成成功** */
export const TASK_STEP_STATUS_LABELS: Record<TaskStep['status'], string> = {
  pending: '待办',
  inProgress: '进行中',
  completed: '已完成',
  unknown: '状态未知',
};

/** 七种收场的中文与样式档。`unavailable` **不是红色错误**（本仓已知边界，不是缺陷） */
export const ASK_USER_OUTCOME_LABELS: Record<
  AskUserOutcome,
  { label: string; tone: 'success' | 'warning' | 'default' | 'error'; note: string | null }
> = {
  answered: { label: '已答复', tone: 'success', note: null },
  'auto-resolved': { label: '自动决议', tone: 'warning', note: '厂商按自己的超时预算决定了答案' },
  skipped: { label: '被跳过', tone: 'default', note: '用户跳过了这个问题' },
  timeout: { label: '超时未答', tone: 'warning', note: '厂商的提问超时预算到了' },
  unavailable: {
    label: '无人可应答',
    tone: 'default',
    note: '本仓没有开应答面（approvalPolicy: never）——已知边界，不是缺陷',
  },
  rejected: { label: '被拒绝', tone: 'error', note: '子智能体不能向用户提问' },
  canceled: { label: '随轮次取消', tone: 'default', note: '轮次被中断，提问一起收场' },
};

/** 截断三态的一句话。**`unknown` 不写「完整」**——那正是「用负信号断言正事实」 */
export function truncationNote(state: TruncationState): string | null {
  switch (state.kind) {
    case 'none':
      return null;
    case 'truncated':
      return state.reason === null ? '输出已被截断' : `输出已被截断（${state.reason}）`;
    case 'unknown':
      return '输出可能不完整（没采到截断标记）';
  }
}

/**
 * 把契约的扁平方形的能力声明（`MessageCapability`）转成界面要的字典形状。
 * 契约把「等级 / 出处 / 原因」摊成同名前缀的三个格（`toolResult` / `toolResultSource` / `toolResultReason`），
 * 界面要的是绑在一起的三元组——本函数是这两份形状之间的**唯一**搬运点。
 */
export function toCapabilityMap(capability: MessageCapability): MessageCapabilityMap {
  return {
    thinkingText: {
      level: capability.thinkingText,
      source: capability.thinkingTextSource,
      reason: capability.thinkingTextReason,
    },
    toolInput: {
      level: capability.toolInput,
      source: capability.toolInputSource,
      reason: capability.toolInputReason,
    },
    toolResult: {
      level: capability.toolResult,
      source: capability.toolResultSource,
      reason: capability.toolResultReason,
    },
    subagent: {
      level: capability.subagent,
      source: capability.subagentSource,
      reason: capability.subagentReason,
    },
    streamingDelta: {
      level: capability.streamingDelta,
      source: capability.streamingDeltaSource,
      reason: capability.streamingDeltaReason,
    },
  };
}

/**
 * 一个能力维度在界面上的中文名。
 * **未知维度不显示成空白**：契约允许数据层加维度（加维度不必改契约），
 * 界面按收到的顺序渲染并把未知维度的名字原样显示。
 */
export const CAPABILITY_DIMENSION_LABELS: Readonly<Record<string, string>> = {
  thinkingText: '思考文本',
  toolInput: '工具入参',
  toolResult: '工具结果',
  subagent: '子任务',
  streamingDelta: '流式增量',
};

/** 把契约的一条消息折成界面块所需的**纯映射**结果：`AgentMessage` 的消费方只有这一处约定 */
export type AgentMessageRecord = AgentMessage;
/** 子任务行的契约形状（重新导出，免得本目录到处 import 契约包） */
export type SubagentRow = SubagentRecord;
