/**
 * dsh 会话通知的**判别常量**（真机逐字核过，见 `probe/dumps/v3/` 与 `probe/dumps/v11/`）。
 *
 * 为什么单独一个模块：`events.ts`（运行级事件投影）与 `message.ts`（内容级消息归一）都要按这些
 * 字符串分流，两处各写一份必然漂移——而漂移的症状是「某一类通知在事件里出现、在消息里消失」
 * （或反过来），排查时看不出是哪一层丢的。
 *
 * 通知共四种 method：`session.event`（具体事件，判别字段是 `params.event.type`）、
 * `session.status`（会话级状态）、`subagent.started`、`subagent.finished`。后两种是**顶层通知**，
 * 不套在 `session.event` 里。
 *
 * ⚠️ 它**同时是 dsh 用量字段名与读法的唯一真源**：`events.ts`（运行级累计）与
 * `message.ts`（消息级那一次调用）都按同一份字段名读——两处各写一份必然漂移，而漂移的症状是
 * 「事件里的用量对、消息上的用量不对」（或反过来），界面上看着都正常。
 */
import type { UsageTokens } from '@aieval/contracts';
import { asRecord, readNumber, readString } from '../../json';

/** 承载会话事件的通知方法名；其余方法（`session.status` 等）不产生事件。 */
export const DSH_SESSION_EVENT_METHOD = 'session.event';
/** 携带用量与会话消息的通知方法名（实测：用量挂在它的 `data.usage` 上，正文在 `data.message` 上）。 */
export const DSH_ASSISTANT_MESSAGE_TYPE = 'assistant/message';
/**
 * **一次没有落成 `assistant/message` 的模型尝试**（真机：坏 key、传输断、以及被重试掉的每一次）。
 *
 * 厂商的 `agent-loop` 对一次尝试**只写两者之一**（`dsh-agent-loop` 的
 * `finish.kind === 'error' | 'aborted'` 走 `assistant/attempt`，正常收尾与「abort 但已有内容」走
 * `assistant/message`）⇒ 两边的用量相加**不会双计**，而漏读这一格就是**静默少算**：
 * 重试掉的失败尝试带着**真实用量**（真机读数 `{inputTokens:374, outputTokens:102,
 * cacheReadTokens:5888}`），厂商自己的 token meter 把它算进本轮合计，我们不算 ⇒
 * 一次带重试的运行里 total 少 24%、且一条 WARN 都没有。
 *
 * 用量不在 `data.usage` 上，在 `data.stream[]` 的最后一条 `usage` chunk 里
 * （与厂商 `turn-usage.js` 的 `streamUsage` 同源同序）。
 */
export const DSH_ASSISTANT_ATTEMPT_TYPE = 'assistant/attempt';
/**
 * 一次**被重试掉**的尝试（真机载荷：`{retry, maxRetries, delayMs, failure:{message, code}, turn, step}`）。
 *
 * 它不是噪声：界面上「这一步为什么慢」的唯一解释就在这里，而它过去整条落进未识别兜底
 * （一条原始 JSON）。配对的那条 `llm/retry-started`（重试开工标记）在
 * `DSH_QUIET_EVENT_TYPES` 里——信息全在这一条上。
 */
export const DSH_LLM_RETRY_TYPE = 'llm/retry';

/**
 * 一次**工具作业**（真机：每次 `bash` / `pwsh` 调用两条）——`job/registered` 开工、`job/settled` 收场。
 *
 * 收场那条是**退出码唯一的出口**：`data.detail = "exit code: N"`（真机逐字），
 * 而 `data.toolCall.callId` 与该次工具结果的 `message.toolCallId` **同值** ⇒ 结果块据此判失败
 * （见 `message.ts` 的 `dshToolResultDraft`）。真机顺序：`job/registered → job/settled → tool/result`。
 *
 * ⚠️ 这一格**不进 quiet 名单**：它没有自己的投影分支，两条都照旧走未识别兜底（原始 JSON 可见），
 * 上面那个退出码只是**顺带**被登记下来——要改这条处置前先读 `DSH_QUIET_EVENT_TYPES` 的口径。
 */
export const DSH_JOB_SETTLED_TYPE = 'job/settled';

/**
 * 会话起手的**权限预设**（真机 `data = { preset: 'danger-full-access' | 'workspace-write' | 'read-only' }`，
 * seq 0，**每会话一条**；追问 / 续接段不重投）。
 *
 * 它是本次运行 `vendor-system` 的 `permissionMode` 唯一来源：契约那一格在另三家是厂商自己的档位字符串
 * （claude 的 `bypassPermissions` / `dontAsk`），而 dsh 这一家就是这里的 preset 字符串。
 * 少读这一格的表现是环境抽屉上「权限档」**恒为空**，连评分阶段被限成 `read-only` 也看不出来
 * （`sandbox/mode` 与 `approval/policy` 是同一份事实的另两格，本仓契约没有对应字段）。
 *
 * 归零草稿：它只喂 `runState`，事件本身由随后的 `vendor-system`（工具表 / 技能目录那两条）带出去。
 */
export const DSH_PERMISSION_PRESET_TYPE = 'permission/preset';
/** 轮次结束的事件类型（实测：失败与收尾从这里取）。 */
export const DSH_TURN_END_TYPE = 'turn/end';
/**
 * **一次模型调用**的落点（实测：`turn/start` 之后、`assistant/message` 之前）——轮次在这里 +1。
 *
 * ⚠️ 它数的是**厂商的 step**，不是「HTTP 往返次数」：一次尝试失败被重试时，
 * `llm/retry-started` 把**同一个 step** 重新打开（厂商 `turn-usage.js` 的同名分支），
 * 于是 4 次真实往返可以只有 3 个 step。本仓的轮次口径与厂商一致。
 */
export const DSH_STEP_START_TYPE = 'step/start';
/**
 * 轮次开始（真机 `data = { turn: N }`）。
 *
 * **零草稿**：它是纯播报（轮次的落点是卡片上那一格），且**没有可用的时间信息**——
 * `timing` 的起点落在下一条会记时间的识别事件上（`request/header` 或 `assistant/message`）。
 * 它在 `DSH_QUIET_EVENT_TYPES` 里，所以**不要再为它写投影分支**：写在名单里的类型
 * 在投影开头就返回了，那种分支永远不可达。
 */
export const DSH_TURN_START_TYPE = 'turn/start';
/** 工具调用事件类型（实测：`data.{name, arguments}`，`arguments` 是 JSON 字符串） */
export const DSH_TOOL_CALL_TYPE = 'tool/call';
/** 工具结果事件类型（实测：`data.message.{content[], isError}`，结构化结果在同级 `data.meta` 里） */
export const DSH_TOOL_RESULT_TYPE = 'tool/result';
/**
 * **每次模型往返都会投**的那一条请求头：`data.header.tools` 就是那一轮模型看到的工具面。
 *
 * 它是 dsh 侧 MCP 的**唯一判据**：这一家起不来时工具**静默**从表里消失
 * （四臂实测）——会话照常跑完、`turn/end` 照常 `completed`、
 * SDK 不抛错、`failOnStartupError` 真假在观察面上没有差异 ⇒ 除了「表里有没有它的工具」，
 * 我们这一侧没有任何别的信号。工具名的形状与另两家一致：`mcp__<serverName>__<tool>`。
 */
export const DSH_REQUEST_HEADER_TYPE = 'request/header';
/**
 * **注入的 user-role 消息**（真机：`data.content[0].text` 是正文，`data.source.kind` 说明它是什么）。
 *
 * 它是 skills 那一格的载体：这一家把「本次会话有哪些 skill」合成一条 user 消息塞进提示词
 * （真机全轮**恰好一条**）。⚠️ 它必须**显式分流**——未识别的 `session.event` 会走
 * `unknown(raw)` 兜底，落成一条几十 KB 的原始 JSON 日志，把「原始输出」面板刷满。
 */
export const DSH_USER_MESSAGE_TYPE = 'user/message';
/**
 * 上一条消息里「技能目录」那一类的 `data.source.kind`（真机逐字）
 */
export const DSH_SKILL_CATALOG_KIND = 'skill-catalog';

/**
 * `session.status`（`running` / `idle`）的通知方法名。
 *
 * 它是**已识别且有意不投影**的一格：与轮次语义无关、骨架不需要它，而它在真机每个本次运行必然出现两条。
 * 显式分流的意义在于**别落进未识别的原始 JSON 兜底**——那两条与内容、失败都无关，
 * 落成日志只会让「未识别的厂商载荷」汇总里多两条噪声，把真正未知的类型埋掉。
 */
export const DSH_SESSION_STATUS_METHOD = 'session.status';

/**
 * 已识别但**不产任何草稿**的会话事件类型（真机逐条核过，与 `request/header` 那条通道同一次运行）：
 * `turn/start`、`sandbox/mode`、`approval/policy`、`agent/inbox/spliced`、
 * `request/context`、`step/end`、`system/message`（整份系统提示词，实测 3.2 KB/会话）、
 * `llm/retry-started`（重试的开工标记，信息全在配对的 `llm/retry` 上）。
 *
 * ⚠️ **名单里的类型在投影开头就返回了**，所以不要再为它们写投影分支（那种分支永远不可达）。
 * 三个「零草稿但有自己的分支」的类型**不在**这份名单里，各自在 `events.ts` 里显式分流：
 * `permission/preset`（只登记权限档；**每会话一条**，追问 / 续接段不重投）、
 * `subagent/descriptor`（信封身份由过滤器登记；真机不在通知流里，真正承重的是 `subagent.started` / `finished`）、
 * `session/title`（落一条人话日志）。
 *
 * 为什么登记成「零草稿」而不是继续走 `unknown` 兜底：兜底的语义是「我们不认识的载荷」，
 * 而这些都是**认识且判定无用**的（既不带轮次、也不带用量或失败）。混在一起有两个代价：
 * 原始输出面板被几十条 JSON 占据，以及「未识别的厂商载荷」这一栏失去诊断价值。
 *
 * ⚠️ **`user/message` 刻意不在这一批里**：它可能带技能目录（`source.kind === 'skill-catalog'`），
 * 认不出的那些照旧落原始 JSON——「分流不是静默丢掉不认识的消息」。
 */
export const DSH_QUIET_EVENT_TYPES: ReadonlySet<string> = new Set([
  'turn/start',
  'sandbox/mode',
  'approval/policy',
  'agent/inbox/spliced',
  'request/context',
  'step/end',
  'system/message',
  'llm/retry-started',
]);

/**
 * `session/title`（真机：厂商给会话起的标题，`data.title`）。
 * 与上面那批的区别是它**有信息量**（一条人话）⇒ 落一条日志，而不是零草稿、也不进未知兜底。
 */
export const DSH_SESSION_TITLE_TYPE = 'session/title';

/**
 * 一条通知里可能出现的**子会话身份**（登记多一个不存在的 id 无害、漏登记有害）。
 *
 * 三个来源：
 *   · **`params.childSessionId`**——真机上 `subagent.started` / `subagent.finished` 的**唯一**
 *     身份格（前者只有 `{parentSessionId, childSessionId}`，后者另有 `provider` / `agentId` /
 *     `status` / `stopReason`）。SDK 的 `recordSessionRelationship` 读的也正是这一对；
 *   · `params.agentId`（`subagent.finished` 上与 `childSessionId` 同值的另一格）；
 *   · **信封 `params.sessionId`，仅限 `subagent/descriptor`**——子会话自己落的那条身份事件。
 *     ⚠️ 这一格必须**按事件类型收窄**，不能对任意 `session.event` 生效：本会话自己的每条事件
 *     信封里都是本会话 id，无条件兜会让它被登记成自己的子会话（后果是主会话那一笔被算进
 *     「子智能体那一份」）。
 *
 * `params.subagentId` 一并容忍（**厂商在本仓 pin 的版本上从不发这一格**，它是更早版本 / 其它
 * 载体的形状）：多认一个键的成本是一次 `typeof`，而漏认的代价是子会话的话与用量一起消失。
 *
 * ⚠️ **唯一一份**：白名单登记（`noteChildSession`）与收场登记（`noteFinishedChildSession`）
 * 各写一遍的话，形状一变就会出现「白名单认得出、收场认不出」——症状正是 `null` 静默降级成
 * `{0,0,0}`（把「没采到」说成「确实没有」）。故这里也一并提供「读一条通知的会话归属」。
 *
 * ⚠️ 调用方**必须排除自己的会话 id**（信封那一格对 `session.event` 一律存在，
 * 不过滤会把本会话登记成自己的子会话）。
 */
export function dshChildSessionIdentities(params: unknown): string[] {
  const record = asRecord(params);
  if (record === null) return [];
  const named = [record['subagentId'], record['childSessionId'], record['agentId']].filter(
    (candidate): candidate is string => typeof candidate === 'string' && candidate !== '',
  );
  if (named.length > 0) return named;
  const event = asRecord(record['event']);
  if (readString(event, 'type') !== DSH_SUBAGENT_DESCRIPTOR_TYPE) return [];
  const envelope = record['sessionId'];
  return typeof envelope === 'string' && envelope !== '' ? [envelope] : [];
}

/**
 * 子智能体**派生**通知的方法名（真机 `subagent.started` ①）。
 * ⚠️ 它是**顶层通知**（`{ method, params }`），**不是** `session.event` 包一层——
 * 这是它必须显式分流的原因（只认 `session.event` 一种外形会把它落进 `unknownEventDraft`）。
 */
export const DSH_SUBAGENT_STARTED_METHOD = 'subagent.started';
/** 子智能体**收场**通知的方法名（真机 ③：身份 / 终态 / 结果全在这一条） */
export const DSH_SUBAGENT_FINISHED_METHOD = 'subagent.finished';
/**
 * 子任务目录项（`session.event` 里的 `subagent/catalog`，真机 ②）。
 * **任务名（`label`）与 mode 只在这一条里** ⇒ 必须跨消息记住，否则 start/finish 都拿不到名字。
 */
export const DSH_SUBAGENT_CATALOG_TYPE = 'subagent/catalog';
/**
 * 子任务目录项（子会话里的事件，`data = {version, mode, provider, label, childId?}`）。
 *
 * 两条事实，改动本文件之前先读：
 *   · **它不产草稿**（投影拿不出完整的子任务记录——`label` 由 `subagent/catalog` 那条补，
 *     落进未识别的原始 JSON 只是噪声）；
 *   · **但它的信封 `params.sessionId` 是子会话白名单的来源之一**（与 `subagent.started` 并列）：
 *     子会话的事件与用量能进本次运行、能算进「子智能体那一份」，靠的就是 `index.ts` 的
 *     `dshChildSessionIdentities` 读信封那一格。少了它，子会话被放行判据挡掉
 *     ⇒ 子智能体的话与它的 tok 一起消失。
 */
export const DSH_SUBAGENT_DESCRIPTOR_TYPE = 'subagent/descriptor';
/**
 * 派生一个子会话的**工具名**（父会话 `tool/call` 里的 `name`，真机 `subagent`）。
 *
 * 为什么要认**两个**名字：厂商把同一个插件（`@deepseek-ai/dsh-tool-subagent`）按
 * `dsh-base/cordis.patch.yml` 挂两次——`{provider: 'spawn', toolName: 'subagent'}` 与
 * `{provider: 'fork', toolName: 'subagent_fork'}`——两者用的是同一份实现，都派子智能体、
 * 都投 `subagent.started` / `subagent/catalog`。只认 `subagent` 时，fork 那条路的派发行
 * **永远拿不到派发调用 id**（真机两臂对照：`subagent` 臂第一条之后 `parentCallId` 就有值，
 * `subagent_fork` 臂三条——含目录项到达后的补投那条——全是 `null`），界面上只能退回
 * 「任务名逐字相同」那条兜底判据。
 *
 * `workflow` **刻意不在**名单里：它派出的每个子智能体走自己的 `tool-workflow/agent-start`
 * （载荷带 `childId`），不走 `subagent.*` 这两条通知；而一次 `workflow` 调用对应**多个**
 * 子智能体，按 `description` 认领会零命中或多命中（本仓一律不认领）⇒ 加进来只有噪声。
 */
export const DSH_SUBAGENT_TOOL_NAMES: ReadonlySet<string> = new Set(['subagent', 'subagent_fork']);
/**
 * **流式增量伪事件**（stream-tap 机制——本仓自造、不经厂商通知通道）。
 *
 * 厂商的逐字流（`agent/assistant-stream` 进程内事件）不投送到 stdio 通知流（任何版本都不投，
 * 见 `docs/faq/deepseek-harness.md`），适配器把一个插件写进每个本次运行的 profile 目录、由它把
 * `StreamChunk` 旁路到 `<configHome>/aieval-stream-tap.jsonl`；适配器 tail 该文件后包成这种
 * `session.event` 形状的**伪通知**喂给投影——与真通知同一条 `project` 路径，读侧零分叉。
 *
 * 命名与处置两条硬口径：
 *  · 类型名用 **delta**（与契约词汇 `chunk: 'delta'` 同源），不用厂商存储层的 `chunk`/`text-chunks`
 *    字眼——那两个词在本仓另有所指（信封字段 / packed row），混用排障时对不上号；
 *  · `events.ts` 里**必须显式分流**：这一支只产 `chunk: 'delta'` 的内容消息、**零事件草稿**——
 *    绝不能落进「未识别厂商负载一律落 `log`」的兜底（否则一条增量一行 log，原始输出面板
 *    会被几百条 JSON 刷满，真要看的 stderr 反而没了）。
 */
export const DSH_STREAM_DELTA_TYPE = 'aieval/delta';

/**
 * **通知流中断伪事件**（同样是本仓自造）：适配器观察到自己的通知订阅**中途失败**
 * （SDK 的 `NotificationSubscriptionImpl.fail()`——过滤器抛错、或传输读循环死掉）时补投的一条
 * `session.event`，投影成一条 stderr 的 `log`。
 *
 * 为什么必须有它：那种失败在 SDK 里是**静默**的（兄弟订阅与传输不受影响），把它当成「流正常结束」
 * ⇒ 症状是**执行日志整段空白、行照旧判成功、任何日志里都没有线索**
 * （run `7f05c765` 的 dsh 行：厂商会话日志 201 条事件、我们只收到前 13 条）。
 * 与 `DSH_STREAM_DELTA_TYPE` 同一处置纪律：**显式分流**，且这一支**只产一条 log**，
 * 绝不许落进「未识别负载」的兜底（那会把一条诊断淹没在几百条 JSON 里）。
 */
export const DSH_STREAM_FAILURE_TYPE = 'aieval/stream-failure';

/**
 * 用量三元组的字段名，**逐字来自真实探测**（`assistant/message → data.usage`，产物见
 * `probe/dumps/v3/dsh-adapter-*-events.jsonl`）：`{"inputTokens":218,"outputTokens":2,"cacheReadTokens":8832,…}`。
 *
 * ⚠️ 字段名表住在这里：`message.ts`（消息归一）也要按同一份字段名读，
 * 而 `events.ts` 已经 import `message.ts` ⇒ 留在那边就是**循环依赖**。
 * `events.ts` 继续 re-export 这个名字，既有 import 路径不动。
 */
export const DSH_USAGE_FIELDS = {
  input: 'inputTokens',
  cached: 'cacheReadTokens',
  output: 'outputTokens',
  /**
   * 缓存写（`TokenUsage.cacheWriteTokens`）：**不进本仓三元组**（契约只有
   * 非缓存输入 / 缓存读 / 输出），故不落进 `UsageTokens`；读它只为参与
   * `totalTokens` 的恒等式校验（厂商那两格同样是「大于 0 才写」）。
   */
  cacheWrite: 'cacheWriteTokens',
  /** 思考 token（`TokenUsage.reasoningTokens`，类型上可选）：**采不到就是 null，不填 0** */
  reasoning: 'reasoningTokens',
  /** 厂商自报的总量（`TokenUsage.totalTokens`）：**这一条自己的合计**，参与恒等式（见 `DshUsageReading`） */
  total: 'totalTokens',
} as const;

/**
 * 读一次模型调用的用量。
 *
 * **两格可缺、两格必在，判据是厂商自己的写入口径**（`@deepseek-ai/dsh-llm-pi-ai` 的
 * `mapUsage`：`...usage.cacheRead > 0 ? { cacheReadTokens } : {}`，`cacheWriteTokens` 同款条件）：
 *   · `inputTokens` / `outputTokens`：**无条件写** ⇒ 读不到说明形状不对，整条按未采到处置
 *     （调用方落 WARN 并跳过这一条，与本仓「没采到不填 0」同一条口径）；
 *   · `cacheReadTokens`：**大于 0 才写** ⇒ 字段缺席**就是 0**（冷缓存的首条请求正是这个形状），
 *     按 0 计而不是把同一条里的 input / output 一起作废——那是真实的漏算，
 *     真机上单条能差 65% 的非缓存输入；
 *   · `reasoningTokens` / `totalTokens`：可选证据格，读不到就是 `null`（不编）。
 *
 * 附注：`cacheWriteTokens` 不进本仓三元组（契约只有 非缓存输入 / 缓存读 / 输出），
 * 但 `totalTokens` 的恒等式包含它 ⇒ 这一格也读出来给调用方做校验用。
 *
 * **纯函数**：不落日志、不改状态——落 WARN 是调用方（`events.ts` 的 `readTokens`）的事，
 * 因为消息归一那一层没有 drafts 收集器（这是我们把它抽出来的直接原因）。
 */
/**
 * 从 `request/header` 的 `data` 里读**工具名清单**；读不到给 `null`。
 *
 * 两条口径：
 *   · **只取名字**（真机同一条里每把工具还带几百字的英文 `description`）：描述对判据毫无用处，
 *     进事件流只会把它撑大（一条 header 几十 KB × 每个 step 一条）；
 *   · **形状不对就是 `null`**（没有 `header` / `tools` 不是数组 / 项不是对象）：`[]` 在本仓的定义是
 *     「投送了、确实是空的」，拿一个读不动的形状去发它等于说一句假话 —— 而这句话会让推导
 *     把一台明明起来了的 MCP 判成「没起来」。
 */
export function readHeaderTools(data: unknown): string[] | null {
  const tools = asRecord(asRecord(data)?.header)?.['tools'];
  if (!Array.isArray(tools)) return null;
  const names: string[] = [];
  for (const tool of tools) {
    const name = asRecord(tool)?.['name'];
    // 一项坏不牵连整表：认得出的照留（与契约的 `normalizeMcpServers` 同一条处置）
    if (typeof name === 'string' && name !== '') names.push(name);
  }
  return names;
}

/**
 * 读一次模型调用的用量；读得动的形状返回三元组 + 两格可选证据，读不动返回 `null`。
 *
 * **`identityHolds`**：厂商自报总量是否等于这一条自己的分量之和。厂商源码里
 * `totalTokens` 是 **pi-ai 每条 assistant 消息自己的**合计（`mapUsage` 直传
 * `usage.totalTokens`，而那一格来自该次响应的 usage）⇒ 恒等式本应成立。
 * 不成立时不抛错也不猜：把 `total` 置 `null`（宁可说不出总量，不给一个自己都解释不了的数），
 * 由调用方落一条 WARN。缓存写那一格（本仓三元组里没有）也参与这条恒等式。
 */
export interface DshUsageReading {
  tokens: UsageTokens;
  /**
   * **在场却读不动的可选格**（`cacheReadTokens` / `cacheWriteTokens` / `reasoningTokens` /
   * `totalTokens`）：键在、值不是数字（`"5"` / `NaN` / `Infinity` / `null`）。
   *
   * 为什么要单独交出来：这些格「缺席 ⇒ 0」是厂商写入口径（见下面那段说明），但**在场而读不动**
   * 与「确实是 0」是两件事——静默当 0 会让缓存命中率少算且零痕迹（R6-B 的 F3），而必填两格同款
   * 坏法会 WARN + 整条跳过，两侧不对称。调用点据此落 WARN。
   */
  unreadableOptional: string[];
  /**
   * 厂商自报总量是否与分量之和一致（分量含缓存写）。
   * `total === null`（厂商没给这一格）时给 `true`——「没给」不需要校验。
   */
  identityHolds: boolean;
}

/** 紧凑流记录的判别字段（`{type:'chunk', chunk:{…}}`） */
const DSH_USAGE_CHUNK_RECORD_TYPE = 'chunk';
/** 用量 chunk 的类型名（厂商 `StreamChunk` 的 `usage` 档） */
const DSH_USAGE_CHUNK_TYPE = 'usage';

/**
 * 从 `assistant/attempt` 的 `data.stream[]` 里读**这条尝试自己**的用量；没有给 `null`。
 *
 * 载荷形状（真机逐字）：`stream[]` 是紧凑记录，用量那一格是
 * `{ type: 'chunk', time, chunk: { type: 'usage', usage: {...} } }`（同一条 stream 里还有
 * `text-chunks` / `tool-call-chunks` 等别的记录形态）。**取值规则照抄厂商**
 * （`@deepseek-ai/dsh-llm` 的 `lastAssistantStreamChunk(stream, 'usage')`：从尾部往前找第一条
 * `type === 'chunk' && chunk.type === 'usage'`）——顺序敏感，所以不能自己发明「合并所有 usage chunk」。
 *
 * 读不动（形状不对 / 没有 usage 记录）给 `null`：调用方按「这一条没带用量」处置，
 * 而不是把一次尝试的用量当成 0 记进去。
 */
export function readAttemptUsage(data: unknown): unknown {
  const stream = asRecord(data)?.['stream'];
  if (!Array.isArray(stream)) return null;
  for (let index = stream.length - 1; index >= 0; index -= 1) {
    const record = asRecord(stream[index]);
    if (record?.['type'] !== DSH_USAGE_CHUNK_RECORD_TYPE) continue;
    const chunk = asRecord(record['chunk']);
    if (chunk?.['type'] !== DSH_USAGE_CHUNK_TYPE) continue;
    return chunk['usage'] ?? null;
  }
  return null;
}

export function readUsageTokens(usage: unknown): DshUsageReading | null {
  const record = asRecord(usage);
  const input = readNumber(record, DSH_USAGE_FIELDS.input);
  const output = readNumber(record, DSH_USAGE_FIELDS.output);
  if (input === null || output === null) return null;
  /**
   * **负数一律当「读不动」**（与缺项同档：整条不采、由调用点落 WARN）。
   * 为什么：token 计数没有负值，而负数一旦被照收，卡片与运行快照会显示负 token、累计还能倒退
   * （受控读数：`{input:-5, output:-3}` ⇒ `tokens={input:-5,output:-3}`、累计变成 -5）；
   * 更难看的是同一份读数在**子会话分量**那一侧被 `Math.max(0, …)` 夹掉 ⇒ 合计说「-5」、分量说
   * 「没报」（交 null + 点名 WARN），两句话互相拆台。
   */
  if (input < 0 || output < 0) return null;
  // 缓存读 / 缓存写 `> 0` 才写（见上面的口径说明）⇒ 缺席就是 0；负数同样按「读不动」处置
  const cachedRaw = readNumber(record, DSH_USAGE_FIELDS.cached);
  const cacheWriteRaw = readNumber(record, DSH_USAGE_FIELDS.cacheWrite);
  if ((cachedRaw !== null && cachedRaw < 0) || (cacheWriteRaw !== null && cacheWriteRaw < 0)) return null;
  const cached = cachedRaw ?? 0;
  const cacheWrite = cacheWriteRaw ?? 0;
  const total = readNumber(record, DSH_USAGE_FIELDS.total);
  if (total !== null && total < 0) return null;
  /** 键在、值读不动的可选格（见 `DshUsageReading.unreadableOptional`）：交出去让调用点落 WARN */
  const unreadableOptional: string[] = [];
  if (record !== null) {
    for (const key of [DSH_USAGE_FIELDS.cached, DSH_USAGE_FIELDS.cacheWrite, DSH_USAGE_FIELDS.reasoning, DSH_USAGE_FIELDS.total]) {
      if (Object.hasOwn(record, key) && readNumber(record, key) === null) unreadableOptional.push(key);
    }
  }
  return {
    tokens: {
      input,
      cached,
      output,
      reasoningOutput: readNumber(record, DSH_USAGE_FIELDS.reasoning),
      total,
    },
    identityHolds: total === null || total === input + cached + cacheWrite + output,
    unreadableOptional,
  };
}

/** `<available_skills>` 块的登记行：`- \`<name>\`: <description>`（真机逐字） */
const SKILL_CATALOG_LINE = /^-\s+`([^`]+)`\s*:/;
/** 块围栏（厂商原文；两行之间的登记行才是清单本体） */
const SKILL_CATALOG_OPEN = '<available_skills>';
const SKILL_CATALOG_CLOSE = '</available_skills>';

/**
 * 从 `user/message` 的 `data` 里读**技能目录里的名字**；读不到给 `null`。
 *
 * 形状（真机）：`data.source.kind === 'skill-catalog'` 的那些消息，正文是
 * ```
 * <system-reminder>
 * A skill is a reusable set of task-specific instructions. The following skills are available in this session:
 *
 * <available_skills>
 * - `agents-skill`: probe skill agents-skill
 * ...
 * </available_skills>
 * ```
 * 正文可能落在 `data.content[]`（user-role 消息的本体）——`.text` 块的原文按 `readContentText` 的
 * 口径拼起来再切块；`data.message.content[]`（另一条既有载体的形状）也读，两处都读不到就是 `null`。
 *
 * ⚠️ **判据是 `<available_skills>` 块本身，不是「正文里出现过这个词」**：真机控制臂（一个 skill
 * 都没有）用 grep 那个词会得到 5 条噪声——厂商自己的提示词与工具描述里就有它。
 * 两条口径：
 *   · 块在、行读得出 ⇒ 名字数组（`[]` = 「投送了、确实一条都没有」）；
 *   · 块不在 / 正文读不出 ⇒ `null`（采不到）——与上一条是两句不同的话。
 */
export function readSkillCatalog(data: unknown): string[] | null {
  const record = asRecord(data);
  if (record === null) return null;
  const text = contentText(record['content']) || contentText(asRecord(record['message'])?.['content']);
  if (text === '') return null;
  const open = text.indexOf(SKILL_CATALOG_OPEN);
  const close = text.indexOf(SKILL_CATALOG_CLOSE, open + SKILL_CATALOG_OPEN.length);
  if (open < 0 || close < 0) return null;
  const names: string[] = [];
  const body = text.slice(open + SKILL_CATALOG_OPEN.length, close);
  for (const line of body.split('\n')) {
    const matched = SKILL_CATALOG_LINE.exec(line.trim());
    // 一项坏不牵连整块（与 `readHeaderTools` 同一条处置）
    if (matched !== null && matched[1] !== undefined && matched[1] !== '') names.push(matched[1]);
  }
  /**
   * ⚠️ **块在、行一条都读不出 ⇒ `null`（采不到），不是 `[]`**（R6-B 的 F4，受控六档复现）：
   * `[]` 的口径是「厂商投送了、确实一条都没有」；而 `* name: desc`、中文冒号、无冒号那些**只是我们
   * 没解析出来**——交 `[]` 会让界面与收尾那条 WARN（「整轮都没观测到厂商的技能目录」）一起说假话。
   * 判据：围栏之间**一行非空内容都没有** ⇒ 真的是空的（`[]`）；有行却一本次运行都没认出来 ⇒ `null`。
   */
  if (names.length === 0 && body.trim() !== '') return null;
  return names;
}

/** `content[]` 里的文本块按顺序拼成一个字符串；形状不对给空串 */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      const record = asRecord(block);
      return record?.['type'] === 'text' && typeof record['text'] === 'string' ? record['text'] : '';
    })
    .filter((text) => text !== '')
    .join('\n');
}
