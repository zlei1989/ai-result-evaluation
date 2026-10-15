/**
 * cc 的消息投影。
 * 规则：
 *  1. 唯一允许丢弃的是**重复消息**：同一 `uuid` 只投影一次（SDK 重放 / 续传会给重复）；
 *  2. 其余任何消息（含未识别的 type）都必须落成**保留原始负载**的日志事件，不得静默丢弃；
 *     工具 / 推理块那一条（`[{type:'tool_use',…}]`）**额外带一句人话摘要**
 *     （`log.summary`，用户口径：卡片底部的活动行要显示具体的消息，不能是 JSON）——
 *     原始负载仍然逐字在 `text` 里，抽屉的证据一个字没少；
 *     **例外有三类**：`stream_event` 与 `system/thinking_tokens` 逐 token 各一条，落进这条兜底就是
 *     「抽屉刷成 JSON 流水 + 单行产物涨到 MB 级」（真机 11,629 条，见那一支的注释）；
 *     **历史重放帧**（`isReplay`，续接时 CLI 把已发生过的用户消息再投一遍）则是「这份内容本行已有」。
 *     三类都**显式丢弃**（不是默默丢弃）：登记点是这条规则 + 知识库《消息规范》的「非渲染增量」表
 *     ——「不许静默丢弃」依然成立，只是处置写的是「丢」；
 *  3. 计量只在 `result` 消息上取：`usage.input_tokens` /
 *     `usage.cache_read_input_tokens` / `usage.output_tokens` **三项齐了才有值**；缺一项就是
 *     「没采到」→ null 并落一条 WARN，绝不填 0（0 会让人得出「这家很省」的错误结论）；
 *     时间（2026-10-XX）同样只在 `result` 上取：`duration_ms` / `duration_api_ms` / `ttft_ms`
 *     是**厂商自报** ⇒ `source: 'vendor'`（口径见 `resultTiming`）；思考 token 取
 *     `usage.output_tokens_details.thinking_tokens`（缺就 `null`，**不填 0**）；
 *  4. 最终答复优先取 `structured_output`（结构化输出），缺失（字段不存在、为 `null` 或为空串）才
 *     回落到 `result` 文本——理由（结构化那一轮可能没有尾随 assistant、`result` 因此为空）与两个
 *     来源不一致时的 WARN 处置见 `projectResult`。
 *
 * **轮次 = 一次模型 API 往返**（用户口径）：一条 `assistant` 消息就是模型对一次请求的
 * 答复，故按它的 `message.id` 去重计数（流式响应会按内容块重复到达、共享同一个 id，去重后
 * 「一条 API 往返只算一次」）。这正是 SDK 自己的口径——它的 `maxTurns` 文档逐字写着
 * 「Maximum number of agentic turns (**API round-trips**)」，收尾消息上的 `num_turns` 同义
 * （`result_index` 的注释：*Distinct from num_turns, which counts model round-trips within one turn*）。
 * 为什么不用 `num_turns` 当唯一口径：它只在收尾那一条消息上，跑动期界面只能干等（实测那一轮
 * 60 次往返、整轮只发得出一条 `usage`，界面停在「轮次 1」）；我们的计数每条 assistant 消息都在涨。
 * `num_turns` 降级为**兜底**：一条 `message.id` 都没看到时用它；**两者不一致就落一条 WARN**（多报与少报的文案各说各的下一步：多报那一档还可能是我们按 `message.id` 去重少算）。
 * 注意：`parent_tool_use_id` 非空的 assistant 消息来自 Task 子智能体，不在主循环的往返计数里
 * （与 `result.usage` 排除侧链的口径一致）。
 */
import { classifySkillOrigin, normalizeMcpServers, type UsageTokens, type VendorSkill } from '@aieval/contracts';
import {
  clipSummary,
  subagentDispatchSummary,
  subagentSettledSummary,
  toolCallSummary,
  toolDeniedSummary,
  toolErrorSummary,
} from '../../activity';
import { logDraft, safeStringify, unknownEventDraft, vendorSystemDraft, type AgentEventDraft } from '../../emit';
import { classifyAgentMessage, type AgentFailure, type FailureContext } from '../../errors';
import { asRecord, readNumber, readString } from '../../json';
import type { TimingSpan, TurnProjection, TurnState } from '../../turn';
import type { AgentErrorCode } from '../../types';
import { isDispatchShaped, lookupClaudeTaskName, rememberClaudeTaskName } from './message';
import type { ClaudeContextUsage } from './sdk';

/** 子智能体消息的标记字段：非空即「主循环之外」，不参与轮次计数 */
const SIDE_CHAIN_FIELD = 'parent_tool_use_id';

/**
 * 这条帧的侧链归属：**空串按「不属于任何侧链」处置**（返回 `null`）。
 *
 * 为什么空串也要认成主会话：`message.ts` 那三处（快照 / 增量 / 工具结果）用的逐字是同一条口径
 * （`parentCallId === null || parentCallId === '' ? null : parentCallId`）。两处不一致的后果很具体：
 * 事件侧把它当侧链 ⇒ 那一帧**不进 `turnKeys`**（轮次永不推进），而消息侧仍按主会话取号
 * ⇒ 此后每一条同类消息都拿到**同一个轮次号**、挤进同一个载体、按 `i:<index>` 互相覆盖。
 * 厂商今天不发空串（真机帧里要么缺席、要么是 tool_use id），故这一格是**防御**而不是现网缺陷。
 */
function sideChainCallIdOf(message: Record<string, unknown> | null): string | null {
  const value = readString(message, SIDE_CHAIN_FIELD);
  return value === null || value === '' ? null : value;
}

/** SDK 原生的子任务生命周期消息。**默认就发**，不需要任何 SDK 选项 */
const TASK_STARTED = 'task_started';
const TASK_NOTIFICATION = 'task_notification';
/** `system` 下承载「厂商系统层事实」的那一个 subtype（真机 2.1.281 实测） */
const INIT_SUBTYPE = 'init';
/**
 * `system` 下那个**工具调用被当场拒**的 subtype（`SDKPermissionDeniedMessage`）。
 * 它在**评分档是常态**：那一段没有批准面（`dontAsk` + `permissionPrompts: 'none'`），
 * 厂商据此把该拒的当场拒掉并发这一帧。
 */
const PERMISSION_DENIED_SUBTYPE = 'permission_denied';
/**
 * `system` 下那条**上游重试**的 subtype（`SDKAPIRetryMessage`）。
 *
 * 真机形状逐字：`{subtype:'api_retry', attempt:1, max_retries:10, retry_delay_ms:529, error_status:500,
 * error:'server_error'}`。它承载的正是「这一行现在为什么不动」——上游连续 500 时真机跑出过
 * **10 次重试、墙钟约 3 分钟**的一串帧，而在此之前它们只落原始 JSON：活动行一个字都不说，
 * 界面看起来像卡死。厂商在这几格里已经说清了「第几次、等多久、什么错」⇒ 给一句摘要，
 * 原始负载照旧整条落盘（排障要的是那份原文）。
 */
const API_RETRY_SUBTYPE = 'api_retry';
/**
 * `system` 下那条**会话状态**的 subtype（`SDKStatusMessage`，值域 `'compacting' | 'requesting' | null`）。
 *
 * 三档的实际含义（真机读数 + SDK 类型面逐字）：
 *   · `status: 'requesting'`：**每轮模型请求前一条**，是心跳、零信息量（实测 25 轮的运行里 25 条）
 *     ⇒ 维持原样只落原始负载（它还是「这一轮什么时候开始」的时间戳证据，量级也小）；
 *   · `status: 'compacting'`：自动压缩**开始**；
 *   · `status: null` + `compact_result: 'success' | 'failed'`（+ `compact_error`）：压缩**结束**。
 * 后两档是长过程里唯一的行级出口——压缩失败（真机：`too_few_groups`，压不动）此前只躺在原始 JSON 里，
 * 界面既不知道它在压缩、也不知道它压失败了。
 */
const STATUS_SUBTYPE = 'status';
/**
 * `system` 下那个**逐 token 的思考进度** subtype。
 *
 * SDK 的类型注释逐字说明它的身份：*Live thinking-token estimate, digested from
 * `thinking_delta.estimated_tokens` during the redacted-thinking phase … **Approximate progress for
 * spinners/pills, not the authoritative billed `output_tokens`***。即：它既不是内容、也不是计量，
 * 而是**给 spinner 用的近似进度**——每个思考 token 发一条，与 `stream_event` 同属「流式/进度帧」这一类。
 */
const THINKING_TOKENS_SUBTYPE = 'thinking_tokens';

/**
 * `system/init` → **厂商系统层事实**。
 *
 * 这一格过去只以原始 JSON 落成一条 `log`，于是「这一次被下发了哪些工具、什么权限档」
 * 只能由**消费端**去 `JSON.parse` 那条日志并逐字认 `slash_commands` / `permissionMode`——
 * 那是把厂商适配搬进了浏览器（见 `build-environment.ts` 的旧实现）。
 * 归一放在这里之后，厂商改字段名或加第四家都只动本文件。
 *
 * 三条取值口径（**逐格都可能拿不到**，拿不到就是 `null`）：
 *   · **`strings` 而不是空数组**：字段不在、或不是数组 ⇒ `null`（「没投送」）；
 *     字段是数组但为空 ⇒ `[]`（「投送了，确实是空的」）——两者在界面上是两句不同的话；
 *   · 数组里**只留字符串**：厂商可能塞进非字符串项，混进 `string[]` 会让下游渲染出 `undefined`；
 *   · `permissionMode` / `output_style` 只认非空字符串（空串按「没给」处置）。
 *
 * **`mcp_servers` 是唯一一格对象数组**：真机投的是 `[{name, status, source}]`（名 / 连接状态 / 来源），
 * 拿 `strings` 去滤它会把四台全丢掉、折成 `[]`——而 `[]` 在本仓的定义是「投送了，确实是空的」，
 * 等于在事件流里写下一句假话（四台 MCP 就只剩原始 JSON 那条 log 里有）。这一格走契约里**共用**的
 * `normalizeMcpServers`：对象逐格取、老形态（字符串）也读得动、非数组记 `null`——
 * 归一只有一处实现，消费方（环境抽屉 / 日志行）拿到的是同一个形状。
 *
 * `cwd` / `session_id` / `model` / `claude_code_version` **刻意不收**：前三个与运行快照里的
 * 权威值重复（收进来就有第二份真值），版本号今天没有消费者——要用时再加，别先囤着。
 */
export function vendorSystemDraftOf(
  message: Record<string, unknown> | null,
  skills?: VendorSkill[],
): AgentEventDraft {
  const strings = (key: string): string[] | null => {
    const value = message?.[key];
    if (!Array.isArray(value)) return null;
    return value.filter((entry): entry is string => typeof entry === 'string');
  };
  const nonEmpty = (key: string): string | null => {
    const value = readString(message, key);
    return value === null || value === '' ? null : value;
  };
  return vendorSystemDraft({
    tools: strings('tools'),
    slashCommands: strings('slash_commands'),
    agents: strings('agents'),
    mcpServers: normalizeMcpServers(message?.['mcp_servers']),
    // 通道自报：claude 的判据来源是 `system/init` 里那一台的 `status`（外加工具表）。
    // 推导靠它把「表里没有这一台」读成「不判失败」——与 dsh 的工具表通道**读法相反**。
    mcpChannel: 'vendor-status',
    permissionMode: nonEmpty('permissionMode'),
    outputStyle: nonEmpty('output_style'),
    skills,
  });
}

/**
 * 上下文用量里的技能面 → `vendor-system.skills` 那一格。
 *
 * 三条口径：
 *   · **采不到就不给这一格**（`usage` 为 `null`、或厂商省了 `skills` 整格）：`undefined` =
 *     「我们没读到」，调用方据此**不带** `skills` 那个键——写 `null` 会被读侧读成
 *     「厂商投送了、清单是空的」，那是替厂商说一句我们并不知道的话。`[]`（投送了、确实一条都没有）
 *     与非空数组各自成立；
 *   · `source` 是**厂商原值照抄**（真机 `userSettings`），空串按「没给」记 `null`——把空串留在
 *     契约里会让界面显示一个空来源，而事实是厂商没报这一格；
 *   · `origin` 是**我们**按落点与原值归一出来的分档，判据只有 `classifySkillOrigin` 一份
 *     （本层恰好同时知道行配置目录与工作目录，故由这里判，界面不再重推）。
 *
 * claude 的 `getContextUsage().skills.skillFrontmatter` **不带落点**（只有名字、来源、token 数）
 * ⇒ `path` 恒 `null`，来源只能靠原值那一档。
 */
export function skillsDraftOf(
  usage: ClaudeContextUsage | null,
  layout: { configHome: string; cwd: string },
): VendorSkill[] | undefined {
  if (usage === null || usage.skills === null) return undefined;
  return usage.skills.skillFrontmatter.map((row) => {
    const source = row.source === '' ? null : row.source;
    return {
      name: row.name,
      source,
      path: null,
      origin: classifySkillOrigin({ source, path: null, configHome: layout.configHome, cwd: layout.cwd }),
    };
  });
}

/**
 * `system/init` 自带的技能名单 → `vendor-system.skills` 那一格的**回落来源**。
 *
 * 为什么要它：`getContextUsage()` 那条探针**只在「这一行配了技能」时才跑**（编排层按「空集不给键」
 * 的口径不下发 `skills`）⇒ 没配技能的行上，收尾那条事件本来一个 `skills` 格都不带，而下游把
 * 「没有这一格」读成**厂商没投送**——可厂商在 `system/init` 里明明投了（真机 19 条，含本次注入的
 * 那一条）。这一格是**免费的**：init 帧本来就在手上。
 *
 * 两条来源的分工：探针给的 `skillFrontmatter` **带来源** ⇒ 探针优先；本函数只在它没采到时接管。
 * 只有名字就没有来源 ⇒ `source` / `path` 都记 `null`、`origin` 走 `classifySkillOrigin` 在无来源
 * 信息时的那一档（`'unverified'`）——**不猜**「这条是厂商自带还是我们装的」。
 *
 * 形状口径：`skills` 不是数组 ⇒ `undefined`（不认识 ⇒ 不带这一格，与「采不到」同形）；
 * 是数组（含空数组）就照映射——`[]` 的语义是「厂商投送了、一条都没有」，与「没有这一格」是两句话。
 */
export function skillsFromInitFrame(
  initRecord: Record<string, unknown> | null,
  layout: { configHome: string; cwd: string },
): VendorSkill[] | undefined {
  const raw = initRecord?.['skills'];
  if (!Array.isArray(raw)) return undefined;
  return raw
    .filter((one): one is string => typeof one === 'string' && one !== '')
    .map((name) => ({
      name,
      source: null,
      path: null,
      origin: classifySkillOrigin({ source: null, path: null, configHome: layout.configHome, cwd: layout.cwd }),
    }));
}

export function projectClaudeMessage(raw: unknown, state: TurnState, context: FailureContext): TurnProjection {
  const message = asRecord(raw);
  const uuid = readString(message, 'uuid');
  // 重复消息：唯一允许丢弃的一类
  if (uuid !== null) {
    if (state.seen.has(uuid)) return emptyProjection();
    state.seen.add(uuid);
  }
  /**
   * **历史重放帧**（`SDKUserMessageReplay.isReplay`）：续接（`resume`）时 CLI 会把这条会话
   * **已经发生过**的用户侧消息重新投一遍。
   *
   * 为什么不能按新内容收下：重放帧带的是**自己的** `uuid`（与原帧不同）⇒ 上面那张去重表挡不住
   * 它；而追问这一段是**追加到同一行**上的（工作区与产物都不重置，见编排层 `followUpRow` 的
   * 「计量是这一行的累计产出」），那些内容早就在本行的 `events.jsonl` / `messages.jsonl` 里
   * ⇒ 收下就是把上一轮的工具结果连同证据再写一遍（消息侧还会把任务台账的 patch 再放一遍）。
   *
   * 这是本文件**第三类**显式登记的丢弃（前两类是 `stream_event` 与 `system/thinking_tokens`，
   * 见文件头规则 2）：「不许静默丢弃」对它依然成立——处置写的是「丢」，依据是「这份内容本行已有」。
   */
  if (message?.isReplay === true) return emptyProjection();
  const type = readString(message, 'type') ?? 'unknown';
  if (type === 'result') return projectResult(message, state, context);
  if (type === 'assistant') {
    const drafts = assistantDrafts(message, raw);
    // 轮次先记（与 token 估算无关：采不到用量也照样是一次模型往返）
    const turns = countModelRoundTrip(message, state);
    /**
     * 这一帧自带的**上游错误**与**被截断**两格（厂商在合成的 API-error 消息上写它们）：
     * 落一条点名日志，终局错误另折成 `failure`（判据见 `assistantFailure`）。
     */
    const failure = assistantFailure(message, drafts);
    // 跑动期的用量估算：**只进事件**（`tokensEstimated`），绝不进结果（见 estimateTokens）
    return {
      drafts,
      tokens: estimateTokens(message, state),
      tokensEstimated: true,
      turns,
      /**
        * 归属：读数只由主循环触发 ⇒ 会话恒为主会话，轮次就是刚数出来的那个。
       * 没有轮次时（侧链被 `countModelRoundTrip` 在 `parent_tool_use_id` 上挡住、或消息缺
       * `message.id`）给**显式 `null`**：没有号就不假装有，与下面 `projectResult` 的三个出口**逐字同形**
        *（投影层跟着草稿层的硬口径走——`AgentEventDraft` 那一格恒在，
       * 没有归属就是 `null`，读的人不必再问「缺省与 `null` 在这里有没有别」）。
       */
      turn: turns === null ? null : { subagentId: null, round: turns },
      failure,
    };
  }
  // 子智能体生命周期：`system` 下只有这两个 subtype 有语义（其余仍走下面的兜底）
  if (type === 'system') {
    const subagent = subagentDraft(message);
    if (subagent !== null) return { drafts: [subagent], tokens: null, turns: null, failure: null };
    /**
     * **工具调用被当场拒**（`system/permission_denied`）：给一条带人话摘要的日志。
     *
     * 为什么这一帧必须有摘要、不能只落原始 JSON：它是**评分档的常态**——那一段走的是
     * `dontAsk` + `permissionPrompts: 'none'`（本进程没有批准面），厂商 JSDoc 逐字说明
     * 「dontAsk 模式、headless auto-deny、deny rule 都走这条」。而它是「模型想写盘但被拒」的
     * **唯一行级出口**（`decision_reason` 与 `message` 是那句给模型看的原因）⇒ 原来只落一坨 JSON 时，
     * 活动行一个字都不说，排障只能逐笔翻原始负载。
     *
     * **原始负载照发**（与 `init` 那一支同形）：摘要之外仍要留证，消费者按 `tool_name` / `agent_id`
     * 自行配对。刻意**不**折成 failure：被拒一次不是这一行失败了——模型会看到工具结果并换一条路。
     *
     * ⚠️ **只发一条**（不是「摘要一条 + 原始负载一条」）：那两条的 `text` 逐字相同
     * （`unknownEventDraft(raw)` 就是 `logDraft('stdout', safeStringify(raw))`）⇒ 落两条等于
     * 同一坨 JSON 在「原始输出」抽屉里出现两遍、日志条数翻倍，而**一个事实都没有多**。
     * 这里带上摘要的那一条本身就含完整原文，两条信息一格不丢。
     */
    if (readString(message, 'subtype') === PERMISSION_DENIED_SUBTYPE) {
      return {
        drafts: [logDraft('stdout', safeStringify(raw), permissionDeniedSummary(message))],
        tokens: null,
        turns: null,
        failure: null,
      };
    }
    // 厂商系统层事实：`init` 那一行的六格归一成一条独立事件（**原始负载那条 log 照发**）
    if (readString(message, 'subtype') === INIT_SUBTYPE) {
      return { drafts: [vendorSystemDraftOf(message), unknownEventDraft(raw)], tokens: null, turns: null, failure: null };
    }
    /**
     * **上游重试**（`api_retry`）：给活动行一句「第几次、等多久、什么错」，原始负载照发。
     *
     * 为什么它值得独占一支：这一帧是**长退避期间唯一的行级出口**（真机 500 臂：10 次重试、
     * 墙钟约 3 分钟，期间没有任何 assistant / result）。不给摘要就等于让界面在那三分钟里
     * 一个字都不说——读者分不清「在重试」与「卡死了」。
     */
    if (readString(message, 'subtype') === API_RETRY_SUBTYPE) {
      return {
        drafts: [logDraft('stdout', safeStringify(raw), retrySummary(message))],
        tokens: null,
        turns: null,
        failure: null,
      };
    }
    /**
     * **会话状态**：只有压缩那两档给摘要（`requesting` 是每轮一条的心跳，照旧只落原始负载）。
     * 判据与三档的含义见 `STATUS_SUBTYPE` 的注记——压缩是长过程，而它此前在活动行上完全不可见。
     */
    if (readString(message, 'subtype') === STATUS_SUBTYPE) {
      const summary = compactStatusSummary(message);
      return {
        drafts: [summary === undefined ? unknownEventDraft(raw) : logDraft('stdout', safeStringify(raw), summary)],
        tokens: null,
        turns: null,
        failure: null,
      };
    }
  }
  /**
   * `user` 消息里承载的是**工具结果**（`tool_result` 块）：只有报错才给一句人话摘要
   * （统一口径）——那是「这一行出事了」，而它没有别的行级出口；成功返回不播，
   * 它的落点是结果块与抽屉的原始输出面板（口径与判据见 `src/activity.ts`）。
   */
  if (type === 'user') {
    const failure = toolFailureOf(message);
    if (failure !== null) {
      return { drafts: [logDraft('stdout', safeStringify(raw), failure)], tokens: null, turns: null, failure: null };
    }
  }
  /**
   * **流式 / 进度帧不进原始日志**（用户口径；两类，都必须显式登记，不许静默丢弃）：
   *
   *   ① `stream_event`（内容增量）：每条只带一小段 delta，落进下面的未识别兜底会把「原始输出」
   *      面板刷成 JSON 流水，真要看的 stderr / init 反而被冲掉。它的落点只有对话视图：消息侧
   *      （`message.ts` 的 `streamEvent`）把 delta 折成 `chunk: 'delta'` 的消息、编排层**只广播不落盘**
   *      ⇒ SSE 实时驱动执行日志的打字机效果。事件侧零产出（`uuid` 去重照常在上面做——重复帧仍丢）。
   *   ② `system` + `subtype: 'thinking_tokens'`（**思考进度帧**，见 `THINKING_TOKENS_SUBTYPE` 的 SDK 原文）：
   *      它是给 spinner 用的近似进度，每个思考 token 一条。**量级**（run `7f05c765`
   *      的 claude 行）：这一种帧 **11,629 条**，占该行 12,509 条 `log` 的 **93%**；评分智能体那条路
   *      （走同一个适配器）再叠 **670 条**。后果两条都很硬：
   *      「原始输出」面板被刷成 JSON 流水且卡死、`events.jsonl` 的单行产物涨到 MB 级。
   *      而它承载的信息与收尾的权威值（`result.usage.output_tokens_details.thinking_tokens`）重复且更差
   *      （SDK 自己写明 "approximate … not the authoritative billed output_tokens"）⇒ 丢掉不损失事实。
   */
  if (type === 'stream_event') {
    return emptyProjection();
  }
  if (type === 'system' && readString(message, 'subtype') === THINKING_TOKENS_SUBTYPE) {
    return emptyProjection();
  }
  // system / user / 未来新增的类型：一律保留原始负载
  return { drafts: [unknownEventDraft(raw)], tokens: null, turns: null, failure: null };
}

/**
 * **终局的上游错误档**（`SDKAssistantMessageError` 里重试多少次都是同一个结果的那些）→ 归因码 + 中文原因。
 *
 * 为什么必须分档、不能一律判失败：`api_retry` 帧用的是**同一个**错误枚举
 * （`sdk.d.ts` 的 `SDKAPIRetryMessage.error`）⇒ `overloaded` / `rate_limit` / `server_error`
 * 这些是「失败了一次、马上自己退避重试」，重试成功后这一行是好的；而 `max_output_tokens` 另有
 * 自愈通道（`resumed_from_incomplete_thinking`：下一轮接着上一轮的思考块跑完）。
 * 骨架那一侧的 `failure` 是**最后写入者赢且不会被清除**（`turn.ts` 的消费循环）⇒ 把可重试档
 * 写进去，就等于让一次自己恢复了的运行永远判失败。
 *
 * 表里这几条反过来：重试不会让它们变好，而 CLI **不一定**会为它们写 `result.is_error`
 * （进程被杀、流被掐断时根本到不了那一帧）⇒ 这一格是它们唯一的行级出口。
 *
 * ⚠️ **为什么不走 `classifyAgentMessage`**：那一份归因表的入口是 **HTTP 状态**
 * （`errors.ts` 的 `statusOf`：读 `status` / `statusCode`，或从文案里抓 `401` 这样的数字），
 * 而厂商在这一格**只给枚举名、不给状态**。把 `authentication_failed` 硬凑成 `401` 才能命中那张表，
 * 等于**编造一个上游从未发过的状态**（「不编造」那条硬口径），且会在文案里写出「HTTP 401」这种假事实。
 * 故这里自带一张**枚举名 → 归因码**的表：它与 `errors.ts` 那张是**两个不同的定义域**
 * （枚举名 vs 状态码），不是同一份映射抄两遍。
 */
const CLAUDE_TERMINAL_ERRORS: Readonly<Record<string, { code: AgentErrorCode; reason: string }>> = {
  authentication_failed: { code: 'AUTH_FAILED', reason: '密钥无效或无权访问：请核对该供应商的密钥后重试' },
  oauth_org_not_allowed: { code: 'AUTH_FAILED', reason: '该组织不允许这次调用：请换一个被授权的账号或供应商' },
  account_on_hold: { code: 'AUTH_FAILED', reason: '上游账号被暂停：请先处理账号状态' },
  verification_required: { code: 'AUTH_FAILED', reason: '上游账号需要先完成验证' },
  cloud_credential_error: { code: 'AUTH_FAILED', reason: '云厂商凭据无效（Bedrock / Vertex 档）' },
  billing_error: { code: 'AGENT_FAILED', reason: '上游账务问题（余额 / 套餐）：请先处理账单' },
  invalid_request: { code: 'AGENT_FAILED', reason: '请求被上游判为非法：多为参数或模型配置不被该网关支持' },
  model_not_found: { code: 'AGENT_FAILED', reason: '模型名在上游不存在：请核对供应商清单里的模型名' },
};

/**
 * 一条 `assistant` 帧自带的 `error` / `aborted` 两格 → 点名日志 +（终局档才有的）失败归因。
 *
 * 三条口径：
 *   · **两格都落日志**：`error` 是上游这一次的失败原文（厂商合成的 API-error 消息就靠它说话），
 *     `aborted` 是「这条被 interrupt/abort 截断，内容可能断在词中间」——不落的话，一次认证失败
 *     在事件流里看起来与一条普通答复**逐字相同**（「失败被记成成功」就是这么来的）；
 *   · **只有终局档折成 `failure`**（表见 `CLAUDE_TERMINAL_ERRORS`）：可重试档只留 WARN，
 *     理由是骨架的 `failure` 不可撤回，而那几档厂商自己会重试（与 `api_retry` 当心跳的既有处置同源）；
 *   · **文案只说技术事实**，并带上**厂商原值**（排障时搜的就是它）；「去哪儿改」由编排层按归因码补
 *     （`errors.ts` 文件头的分工）。
 *
 * ⚠️ `aborted` **不判失败**：被终止的行由骨架的 `canceled` 通路给结论（判定优先级在 `turn.ts`），
 * 这里抢着判会把一次用户主动终止说成 `AGENT_FAILED`。
 */
function assistantFailure(
  message: Record<string, unknown> | null,
  drafts: AgentEventDraft[],
): AgentFailure | null {
  if (message?.aborted === true) {
    drafts.push(
      logDraft(
        'stderr',
        '[WARN] cc 这一条 assistant 消息被中断截断（厂商 `aborted`）：正文可能断在词中间，不据此判失败',
      ),
    );
  }
  const error = readString(message, 'error');
  if (error === null || error === '') return null;
  const terminal = CLAUDE_TERMINAL_ERRORS[error];
  drafts.push(
    logDraft(
      'stderr',
      terminal === undefined
        ? `[WARN] cc 的上游这一次报 ${error}（可重试档，厂商会自己退避重试）：不据此判失败，最终结论看收尾那条 result`
        : `[WARN] cc 的上游以 ${error} 收场（终局错误，重试不会改变结果）：本行按失败处置`,
    ),
  );
  // 可重试档只留痕：厂商重试成功后这一行是好的，而骨架的 failure 一旦写入就再也清不掉
  if (terminal === undefined) return null;
  return { code: terminal.code, message: `cc 的上游报告 ${error}——${terminal.reason}` };
}

/**
 * `system/permission_denied` → 活动行那一句（`工具被拒 <名>：<原因>`）。
 *
 * 原因取值**按信息量排序**取第一个非空：`decision_reason`（判定组件给的人话）→
 * `message`（回给模型的那句拒绝词）→ `decision_reason_type`（判别式，如 `mode` / `rule`）。
 * 三格都可能缺（厂商 JSDoc 把前两格标成可选）⇒ 都没有就只留前半句，**不编原因**。
 */
function permissionDeniedSummary(message: Record<string, unknown> | null): string {
  const reason =
    firstNonEmptyText(readString(message, 'decision_reason'))
    ?? firstNonEmptyText(readString(message, 'message'))
    ?? firstNonEmptyText(readString(message, 'decision_reason_type'));
  return toolDeniedSummary(readString(message, 'tool_name'), reason);
}

/** 非空文本才算「给了」：空串与缺席同处置（`null`），与全仓「`''` 不算采到」同一条口径 */
function firstNonEmptyText(value: string | null): string | null {
  return value === null || value.trim() === '' ? null : value;
}

/**
 * `system/api_retry` 的活动行摘要：`<上游什么错>，第 N/M 次重试，约 X s 后`。
 *
 * 三格各自可能缺席（真机两种外形都出现过：带 `error_status` 的 HTTP 错、只有 `error` 名的连接错）
 * ⇒ 缺哪格就不说哪格，不编默认值（与全仓「`null` 不是 0」同一条口径）。
 */
function retrySummary(message: Record<string, unknown> | null): string {
  const status = readNumber(message, 'error_status');
  const kind = firstNonEmptyText(readString(message, 'error'));
  const attempt = readNumber(message, 'attempt');
  const max = readNumber(message, 'max_retries');
  const delay = readNumber(message, 'retry_delay_ms');
  const head = status !== null ? `上游 ${status}` : kind === null ? '上游错误' : `上游 ${kind}`;
  const tries = attempt === null ? '' : `，第 ${attempt}${max === null ? '' : `/${max}`} 次重试`;
  const wait = delay === null ? '' : `，约 ${(delay / 1000).toFixed(1)} s 后`;
  return `${head}${tries}${wait}`;
}

/**
 * `system/status` 的活动行摘要：**只覆盖压缩那两档**，其余（`requesting` 心跳）返回 `undefined`
 * ⇒ 调用方照旧只落原始负载。
 *
 * 真机两档逐字：`{status:'compacting', compact_output_chars:0}` 与
 * `{status:null, compact_result:'failed', compact_error:'too_few_groups'}`。
 * 判据按 `compact_result` 优先于 `status`：结束那一帧的 `status` 是 `null`，只有结果格说得清成没成。
 */
function compactStatusSummary(message: Record<string, unknown> | null): string | undefined {
  const result = readString(message, 'compact_result');
  if (result === 'success') return '上下文压缩完成（会话历史已被摘要替换）';
  if (result === 'failed') {
    const reason = firstNonEmptyText(readString(message, 'compact_error'));
    return `上下文压缩失败${reason === null ? '' : `：${reason}`}（上下文没被压小，后续请求可能顶到窗口上限）`;
  }
  if (readString(message, 'status') === 'compacting') return '开始压缩上下文（会话历史即将被摘要替换）';
  return undefined;
}

/**
 * `user` 消息里的**工具报错**摘要；没有任何 `is_error` 的 `tool_result` 时返回 `null`
 * （此时调用方照旧只落原始负载）。
 *
 * 形状（真机）：`{ type:'user', message:{ role:'user', content:[{ type:'tool_result', tool_use_id, content, is_error }] } }`；
 * `content` 两种外形都出现过——**字符串**与**内容块数组**（`[{type:'text',text}]`）⇒ 两种都要读。
 * 多条报错拼成一句（`toolErrorSummary` 负责截断），不在这里挑一条。
 */
function toolFailureOf(message: Record<string, unknown> | null): string | null {
  const texts: string[] = [];
  for (const block of readContentBlocks(message)) {
    const record = asRecord(block);
    if (record?.type !== 'tool_result' || record.is_error !== true) continue;
    texts.push(toolResultText(record.content));
  }
  if (texts.length === 0) return null;
  return toolErrorSummary(
    texts
      .filter((text) => text !== '')
      .join(' '),
  );
}

/** `tool_result.content` 的正文：字符串原样，内容块数组取 text 块（别的块型不猜） */
function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((one) => {
      const text = asRecord(one)?.text;
      return typeof text === 'string' ? text : '';
    })
    .filter((text) => text !== '')
    .join('\n');
}

/**
 * **幻影 `task_*` 帧的 id 账**（非 Agent 的后台任务：`task_started` 的形状判据说它不像一次派发）。
 *
 * 与 `message.ts` 的 `phantomIds` 同一条口径、同一份判据（`isDispatchShaped`），只是落点不同：
 * 这一侧只用它决定「要不要给活动行播那句话」，那边决定「产不产子任务行」。
 * 模块级而不是 run 级：与 `taskNames` 同一条处置（一张只增不清的小表；`task_id` 是每 run 新铸的 id，
 * 跨 run 不会互相命中）。
 */
const phantomTaskIds = new Set<string>();

/**
 * 子智能体生命周期 → 一条**可解析**的日志。
 *
 * 为什么以日志承载而不是新事件类型：`AgentEvent` 今天仍是**八型封闭联合**，其中**没有** subagent 事件；
 * `subagent-start`/`subagent-end` 是 v2 契约（尚未实现）。
 * 在 v1 上把它们落成一条 `log`，载荷是 JSON——消费方按 `kind: 'subagent'` 过滤即可。
 * 这与 `unknownEventDraft` 的区别是**关键的**：那时这些消息只是一坨没人认识的原始 JSON
 * （`system` 过去一律走兜底分支），派生与收场在界面上完全不可见。
 *
 * 载荷字段逐字对应落点表。**实测（CLI 2.1.281）**：这些消息**默认就发**，
 * 不需要 `forwardSubagentText`（那一项只影响子智能体的文本/思考）。
 *
 * 缺 `task_id` 时**照发事件、身份写 `null`**（不编一个 id、也不把整条丢掉）：
 * 丢掉会把「派了一个子任务」这件事实一起丢掉，而编一个 id 会让下游配对**静默错位**。
 * 取第三条——发事件、身份为 null，让下游**显式**看到"这一条没有身份可用"（「缺就是缺」）。
 * 真机两次运行 `task_id` 都非空 ⇒ 这条防御路径大概率不可达，它保的是平台/版本差异。
 *
 * ⚠️ **「不像派发的 `task_*` 帧」在这一侧同样被挡住**（非 Agent 的后台任务），判据与消息侧**同源**
 * （`message.ts` 的 `isDispatchShaped`：`subagent_type` / `spawn_depth` / `prompt` 至少一格非 `null`）。
 * 为什么这一侧也要挡：活动行显示的就是这一条日志的 `summary`
 * ⇒ 不挡就会对着一条**后台 Bash 命令**播「已派发子任务：sleep 5 && echo ok」，
 * 而面板与 `messages.jsonl` 那边按同一条判据**一行都不产**（两个面互相打脸）。
 *
 * **「厂商标了 `ambient` / `skip_transcript`」不在这条判据里**：那一类同样拿不到活动行摘要
 * （见下面的 `quiet`），但**载荷照发**——厂商说的是「别当活动展示」，不是「这条不存在」，
 * 丢掉它会把一条 watcher 从审计流里整个抹掉。故这里只挡「三格形状全缺**且**没有任何显式标记」
 * 那一档（真机形态 = 后台 Bash 命令）。
 *
 * 收场帧按 id 追随派发帧的判决（`phantomTaskIds`），与消息侧「收场帧不承载形状证据」同一条处置
 * ——逐帧重判会把每个真派发的收场帧判成幻影。
 */
function subagentDraft(message: Record<string, unknown> | null): AgentEventDraft | null {
  const subtype = readString(message, 'subtype');
  if (subtype !== TASK_STARTED && subtype !== TASK_NOTIFICATION) return null;
  const subagentId = readString(message, 'task_id');
  const identity = subagentId === null || subagentId === '' ? null : subagentId;

  const isStart = subtype === TASK_STARTED;
  /**
   * **形状判决**：只在派发帧上判，收场帧按同一 id 追随。
   * 判据本身住在 `message.ts`（消息侧要按它决定产不产子任务行）⇒ 这里 import 那一个函数，
   * 不抄第二遍：两处判据漂移的表现正是「活动行播着一条面板上没有的子任务」。
   */
  const marked = message?.ambient === true || message?.skip_transcript === true;
  if (isStart && !marked && !isDispatchShaped(message)) {
    if (identity !== null) phantomTaskIds.add(identity);
    return null;
  }
  if (!isStart && identity !== null && phantomTaskIds.has(identity)) return null;

  /**
   * 名字：派发帧自带 `description`；**收场帧没有这一格**（真机键集见 `message.ts` 顶部的名字表），
   * 于是回落到同一 `task_id` 在派发时记下的那个名字——不回填就会产出「已派发子任务：X」紧跟
   * 一句无名的「子任务已完成」这种自相矛盾的一对（真机 run `e68351a5` 就是它）。
   */
  const name = readString(message, 'description') ?? (isStart || identity === null ? null : lookupClaudeTaskName(identity));
  // 派发帧是名字的唯一来源 ⇒ 顺手记进同一张表（消息侧也写同一格，值相同、幂等）
  if (isStart) rememberClaudeTaskName(identity, name);
  const payload: Record<string, unknown> = {
    kind: 'subagent',
    phase: isStart ? 'start' : 'end',
    /**
     * `'wire'` = SDK 原生消息。claude 侧**有更好的通道**：
     * 原生 `task_*` 带 `tool_use_id`（归属键）与 `spawn_depth`，而 hook 两者都没有。
     * ⇒ claude 走 wire，hook 只作后备。
     *
     * ⚠️ 从前这里写着「这与 codex 相反（那边只能走 hook）」——**已作废**：codex 早已迁到
     * `codex app-server`，取数走协议通知流（同样算 `wire`），三家今天都**没有** hook 通道。
     */
    source: 'wire',
    subagentId: identity,
    // 厂商原生 id，不是我们合成的
    vendorId: identity,
    /** **归属键**：与派生它的 `Agent` 工具调用 id、以及子智能体消息的 `parent_tool_use_id` 三者相同 */
    parentToolUseId: readString(message, 'tool_use_id'),
  };

  if (isStart) {
    payload.name = name;
    payload.subagentKind = readString(message, 'subagent_type');
    payload.spawnDepth = readNumber(message, 'spawn_depth');
    payload.isBackgrounded = message?.is_backgrounded === true;
    // 派它去干什么：`description` 是短标题，`prompt` 才是完整指令（派发面板要看的就是它）
    payload.prompt = readString(message, 'prompt');
  } else {
    /**
     * **真实终态**（`completed` / `failed` / `stopped`）⇒ claude 侧**用不到** `statusMissing`。
     * 这是三家在子任务上第一处真实的能力差异：codex 的 `SubagentStop` schema 里**没有**状态字段
     * （只有 schema 级证据），dsh 待验。
     */
    payload.status = readString(message, 'status');
    // 名字在收场帧上缺席 ⇒ 把回填到的那一份写进证据（否则日志里就只剩 `subagentId`，而按 id 反查名字
    // 要另一张表；这与 dsh 的收场载荷带 `name` 是同一条口径）
    payload.name = name;
    // 字段名用 `outcome` 而不是厂商的 `summary`：`SubagentEnd.outcome` 就是"结果摘要"，
    // 两处叫法不一致会让消费方多写一层映射（而本族的全部意义就是**不用**按厂商分支）
    payload.outcome = readString(message, 'summary');
    const usage = asRecord(message?.usage);
    if (usage !== null) {
      payload.usage = {
        totalTokens: readNumber(usage, 'total_tokens'),
        toolUses: readNumber(usage, 'tool_uses'),
        durationMs: readNumber(usage, 'duration_ms'),
      };
    }
  }

  const text = JSON.stringify(payload);
  /**
   * **活动行那一句**：厂商标了「这不是活动」（`ambient` / `skip_transcript`）时**不给摘要**。
   *
   * 厂商 JSDoc 逐字要求 *"hosts should exclude them from activity indicators"*，而活动行正是那个
   * indicator ⇒ 给了摘要就会把一条 live-update watcher 播成「已派发子任务」。
   * **原始负载照发**（`text` 一个字不少）：这一条仍是原始证据，收窄的只有「要不要占活动行」。
   */
  const quiet = message?.ambient === true || message?.skip_transcript === true;
  const summary = isStart
    ? subagentDispatchSummary(name)
    : subagentSettledSummary(name, readString(message, 'status'));
  return logDraft('stdout', text, quiet ? undefined : summary);
}

/**
 * 记一次模型往返并返回**到目前为止**的次数；这条消息不带可归并的 id 时返回 null（不猜）。
 * `state.turns` 是三家共用的累计位，这里按「去重后的 id 数」覆盖写（不是自增：同一条响应
 * 的多个内容块会重复到达，自增会把一条往返数成好多次）。
 */
function countModelRoundTrip(message: Record<string, unknown> | null, state: TurnState): number | null {
  // 子智能体（Task 工具）发起的调用不在主循环往返里：与 `result.usage` 排除侧链同口径
  if (sideChainCallIdOf(message) !== null) return null;
  const messageId = readString(asRecord(message?.message), 'id');
  // 缺 message.id 就没有归并键：重复快照会被重复计数，出的是偏大的假数 ⇒ 宁可不出数
  if (messageId === null) return null;
  state.turnKeys.add(messageId);
  state.turns = state.turnKeys.size;
  return state.turns;
}

/**
 * 这条消息有没有交出**可用的原生结构化产出**（cc 的 `structured_output`）。
 *
 * 单一判据、两个消费方：投影（决定 `state.finalText` 取哪一支）与适配器（`applied.structuredOutput`
 * 的上报，见 `index.ts` 的 project 包装）。两处各写一份必然漂移，而漂移的表现是
 * 「答复明明按结构化走的，结果里却记着没走」——那种账对不上的形态最难查。
 * 四态都收在这里：字段缺失 / 显式 `null` / 空串都算「没有」，只有非空才有（理由见 `projectResult`）。
 */
export function hasClaudeStructuredOutput(message: Record<string, unknown> | null): boolean {
  const structured = message?.structured_output;
  return structured !== undefined && structured !== null && structured !== '';
}

/**
 * `result` 消息：最终答复进日志与结果、计量与轮次取数值、is_error 归因成失败。
 * 轮次以**我们自己数出来的**为准（跑动期界面看的就是它，两边必须同源），`num_turns` 只在
 * 我们一次都没数到（没有 `message.id` 可归并）时兜底；两者不一致时落一条 WARN——
 * 「厂商报 60 次、我们数出 58 次」这种事绝不静默。
 */
function projectResult(
  message: Record<string, unknown> | null,
  state: TurnState,
  context: FailureContext,
): TurnProjection {
  const drafts: AgentEventDraft[] = [];
  const text = readString(message, 'result');
  if (text !== null && text !== '') {
    // 空串不写——`''` 既落不成日志，也不该被当成「采到了答复」（与文件头 N3 的处置同一条原则）。
    drafts.push(logDraft('stdout', text));
  }
  // 最终答复：**结构化输出优先**——`structured_output` 是 CLI 按 schema 校验过的产出，而结构化那一轮
  // 可能以 tool_result 载体收尾、没有尾随 assistant 消息（sdk.d.ts:2054-2065），`result` 因此可能为空。
  // 两个来源**同时存在且内容不同**时落一条 WARN（与 num_turns 不一致那条同一处置：
  // 同一件事有两个来源，我们不静默挑一个）；只有一个来源或两者一致时不发任何东西（不制造噪声）。
  // 本函数仍是纯函数：出口选择只改 state 与 drafts，不引 logger（投影必须可断言）。
  //
  // 出厂形状有**四态**，出口对四态都要对。`structured_output?: unknown` 什么都没承诺（`sdk.d.ts:5581`
  // 是裸的可选字段、无 JSDoc），下面三条是对「没验证过的输入假设」的两侧兜底——真机只需确认走哪一支：
  //   · **字段缺失** ⇒ 没有结构化产出（既有形状）；
  //   · **显式 `null`** ⇒ 同样是「没有结构化产出」。不能让它走序列化：`safeStringify(null)` 是字符串
  //     `'null'`，而它非空 ⇒ 会把**每一条非 schema 行**的答复静默换成 `'null'`，并因为 `'null' !== text`
  //     落一条假的「不一致」WARN（评分通路读的正是 `finalText`，这是方向最坏的静默错）；
  //   · **空串 `''`** ⇒ 同样是「没有**可用的**结构化产出」。这一格必须与下面 `result`
  //     那一支**同源**：本函数明确拒绝把 `''` 当成「采到了答复」（文件头 N3），那么空的 schema 产出同样
  //     不该顶掉一个非空的 `result`——少这一格，同一个函数里就有两套互相矛盾的「空串算不算答复」；
  //   · **已序列化的 JSON 字符串** ⇒ 原样当 JSON 文本用。若照对象那样再 `JSON.stringify` 一次就是二次
  //     编码（`'"{\"a\":1}"'`），下游 parse 出来是**字符串**而不是对象 ⇒ schema 约束下的每一行都失败在
  //     「顶层不是对象」。只有对象形态才走 `safeStringify`。
  const structured = message?.structured_output;
  if (hasClaudeStructuredOutput(message)) {
    const serialized = typeof structured === 'string' ? structured : safeStringify(structured);
    if (text !== null && text !== '' && text !== serialized) {
      drafts.push(
        logDraft(
          'stderr',
          '[WARN] cc 的 structured_output 与 result 文本不一致；本行的最终答复以 structured_output 为准'
            + '（结构化输出是 CLI 按 schema 校验过的产出）',
        ),
      );
    }
    state.finalText = serialized;
  } else if (text !== null && text !== '') {
    state.finalText = text; // 既有路径，一个字不改
  }
  const tokens = readTokens(message?.usage, drafts, readNumber(message, 'num_turns'), message?.is_error === true);
  /**
   * **这一轮的估算表到此为止**（`result` = 本轮的权威结算值已经到手）。
   *
   * 为什么必须清：`result` 在 streaming input 下是**每一轮一条**，而估算表
   * （`state.usageByMessageId`）原来整行只增不清 ⇒ 权威值到手之后，**下一条 assistant 消息**
   * 又会把全表和当成「到目前为止」交出去，骨架的 `liveTokens = estimatedTokens ?? tokens`
   * 于是从权威值**退回**估算（界面上 tok 往回跳，`tokensBasis` 也翻回 `estimated`）。
   * 清掉之后这张表的语义收窄成「**还没结算的那一轮**」，由 `index.ts` 的 `project` 把它加在
   * 已结算的累计上（那里才是本行唯一的累计点）。
   *
   * ⚠️ **只在真读到权威值时才清**（`tokens !== null`）：`result.usage` 缺项那一档虽然罕见，
   * 但无条件清会把「还没结算那一轮」的估算也丢掉、又没有任何权威值顶上来 ⇒ 下一条 usage 事件的
   * 读数**比上一条小**，与「本行到目前为止的累计、单调不减」这条口径直接冲突（见 `index.ts`）。
   * 读了零个字节就不算结算，那一轮的估算留着才对。
   */
  if (tokens !== null) state.usageByMessageId.clear();
  const timing = resultTiming(message);
  const reported = readNumber(message, 'num_turns');
  /**
   * 这条核对**只对第一条 `result` 做**：streaming input 下 `result` 是**每一轮一条**，而
   * `num_turns` 数的是「这一轮里的模型往返」（厂商 JSDoc 逐字：*"counts model round-trips within
   * one turn"*），`state.turns` 数的是**整条查询**的累计 ⇒ 从第 2 轮起两边是两种刻度，
   * 一比就假报（一轮一次，界面上看起来像「厂商和我们对不上账」）。
   *
   * 「这是第几条 `result`」由厂商自己给：`result_index`（JSDoc 逐字：*"how many results the run
   * numbered before this one, starting at 0"*）。
   *
   * ⚠️ **这一格缺席时整条核对不发**（不是「按 0 处置」）：老生产方没有这一格，而 in-process 那一面
   * 「does not number yet」⇒ 拿 0 当默认值等于把**每一条** `result` 都当成第一条，第 2 轮起
   * `num_turns`（本轮往返数）与 `state.turns`（整条查询累计）两种刻度一比就**假报**。
   * 更糟的是另一头：厂商把「写入失败的那一条也算一个号」⇒ 第一条的编号可能不是 0，
   * 而按 0 判会让这条核对**永远不跑**。两种失灵都来自同一个默认值，故这里只在厂商真给了 0 时才核对
   * ——没给就不谈（少一条日志，不是丢一个判据：那条 WARN 只是提示，读数以数出来的为准）。
   */
  const resultIndex = readNumber(message, 'result_index');
  /**
   * **两个方向都喊，但方向不同、说的下一步也不同**。读数仍以数出来的为准（两边同源）。
   *
   * **多报**这一档混着两种成因，**不能一概当成刻度差异**（真机读数各一例）：
   *   · 厂商把**同一次往返的多次投递**按多次计（真机三档四量并排：并行两工具 assistant 帧 3 /
   *     去重 id 2 / `message_start` 2 / `num_turns` 3；结构化输出 1 / 1 / 1 / 2）——这一种是刻度；
   *   · **我们按 `message.id` 去重少算**：两条**不同**的往返撞同一个 id 时只算一轮（网关/代理复用
   *     id 属真实可能，而本层的去重键没有兜底）⇒ 那时 `turns` 偏小、`num_turns` 是对的。
   * 两种在多报这一档里**从读数上分不开**（这正是它必须说话的原因），故文案点出后一种可能、
   * 让人去查上游是否复用 id。
   *
   * **少报**那一档在真机上一次都没出现过 ⇒ 只管读数口径。
   */
  if (resultIndex === 0 && reported !== null && state.turns > 0 && reported !== state.turns) {
    drafts.push(
      logDraft(
        'stderr',
        reported > state.turns
          ? `[WARN] cc 自报的 num_turns=${reported} 多于本轮按 assistant 消息数出的轮次=${state.turns}；` +
            '已知一种成因是厂商把同一次往返的多次投递按多次计（刻度差异），但**也可能是我们少算**' +
            '——本层按 `message.id` 去重，两条不同往返撞同一个 id 时只算一轮 ⇒ 请查上游是否复用 message.id'
          : `[WARN] cc 自报的 num_turns=${reported} 少于本轮按 assistant 消息数出的轮次=${state.turns}；` +
            '界面与本行快照以数出来的为准（一次模型 API 往返算一次）',
      ),
    );
  }
  /**
   * 归属：`result` 是**主循环**的收尾读数（侧链那一条在
   * `countModelRoundTrip` 就被挡住、根本数不出号）⇒ 会话恒为主会话，轮次就是数出来的这个数；
   * `turns` 为 `null`（一次号都没数到）时给 `null`——没有号就不假装有（与「计量绝不填 0」同一条口径）。
   *
   * ⚠️ 下面**三个返回点都要带这一格**（结构化输出重试用尽 / 正常收尾 / 别种 `is_error` 的失败收尾）：
   * 它们是同一份收尾读数的三个出口，而骨架的发射门槛只看轮次 ⇒ 漏掉任何一支，那一支发出的 `usage`
   * 就会退成「没有归属 ⇒ 按时刻归位」（正是本设计要消灭的错位）。范式同 dsh 的 `turn/end`：成功与失败
   * 两个分支都带。而 `TurnProjection.turn` 是**可选格**，漏填既不报类型错、也不会让既有用例变红。
   */
  const turns = state.turns > 0 ? state.turns : reported;
  // 结构化输出重试用尽：只有**要求了 schema 的运行**才会遇到的收场。CLI 的 subtype 是英文，
  // 直接冒到界面等于让使用者去猜；这里折成一句能直接展示的中文，并保留 subtype 供排障。
  // 文案**只说技术事实**：调用方是拿它评分还是干别的，本包不知道，也不该替它猜
  //（「去改什么」由编排层按归因码补，见 `orchestrator.ts` 的 `withProductHint`）。
  if (message?.is_error === true && readString(message, 'subtype') === 'error_max_structured_output_retries') {
    const friendly =
      'cc 的结构化输出重试用尽：模型在多次重试内没有给出符合本次 JSON Schema 的答复。'
      + '请检查本次的输出约束，或换一个模型再试';
    drafts.push({ type: 'error', message: friendly });
    // 「保留 subtype 供排障」的落点**只能**是这条 stderr 日志，不能是 `friendly`：界面直接展示的是
    // `failure.message`，把英文代号拼在它尾巴上，那句中文归因就白写了（这条路径上 `result` 通常是
    // 空串 ⇒ 没有 stdout 日志，subtype 若不落在这里就等于整条链路都查不到收场原因）。
    drafts.push(
      logDraft(
        'stderr',
        '[WARN] cc 本次以 subtype=error_max_structured_output_retries 收场（结构化输出重试用尽）',
      ),
    );
    return {
      drafts,
      tokens,
      timing,
      turns,
      // 归属：失败收尾也是一次真实读数，照样归到它自己那一轮
      turn: turns === null ? null : { subagentId: null, round: turns },
      failure: { code: 'AGENT_FAILED', message: friendly },
    };
  }
  if (message?.is_error !== true) {
    return {
      drafts,
      tokens,
      timing,
      turns,
      // 归属：同一条口径（见上面 `const turns` 的注记）
      turn: turns === null ? null : { subagentId: null, round: turns },
      failure: null,
    };
  }
  // 空串也算「没有答复」：`''` 既落不成日志（见上），也不该做成一条空文案的失败
  const subtypeName = readString(message, 'subtype') ?? 'unknown';
  /**
   * 失败原因的**第二来源**：`result.result` 为空时（`error_during_execution` 一类），厂商仍在
   * `terminal_reason` 上写了为什么——`prompt_too_long` / `image_error` / `malformed_tool_use_exhausted` /
   * `max_turns` / `budget_exhausted` / `api_error` 这些比 subtype 具体得多 ⇒ 拼进文案，
   * 别让使用者只看到一个内部代号。
   */
  const terminalReason = readString(message, 'terminal_reason');
  const failureText =
    text !== null && text !== ''
      ? text
      : `cc 返回失败结果（subtype: ${subtypeName}${terminalReason === null ? '' : `, terminal_reason: ${terminalReason}`}）`;
  drafts.push({ type: 'error', message: failureText });
  /**
   * `errors[]`（CLI 自己的诊断文本）**必须显式落一条日志**。
   *
   * 为什么：这一帧的 `type` 被识别 ⇒ **不走未识别兜底**，凡是没有被显式读出来的格**一个字节都不剩**
   * ——`errors` / `safety_stops` / `subagent_stats` 都在此列。
   *
   * ⚠️ **这个形状来自「被外部终止」，不是「上游 5xx」**（36 条真机臂的差分读数）：
   *   · `subtype: 'error_during_execution'` + `terminal_reason: 'aborted_streaming'` + `errors[]`
   *     （逐字 `[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null`）
   *     ＝ **我们 abort**（用户取消 3 臂 + 看门狗 1 臂，逐字同形）；此时 `result` 缺失、
   *     `errors` 是唯一说明「为什么这一轮没有答复」的文本；
   *   · 而 5xx 那一族（500 / 503 / 500+空体 / 200+空体 / 连接 reset）给的是
   *     `result/success` + `is_error: true` + `terminal_reason: 'api_error'` + **`api_error_status`**
   *     （HTTP 状态），正文通常已含状态（`API Error: 500 status code (no body)…`）。
   * ⇒ 两族都要能读：`terminal_reason` 与 `errors` 在本支落地，`api_error_status` 走的是
   * 上面那条 `result.result` 非空的普通失败文案（正文自带状态）。
   */
  const rawErrors = message?.['errors'];
  const vendorErrors = Array.isArray(rawErrors)
    ? rawErrors.filter((one): one is string => typeof one === 'string' && one !== '')
    : [];
  if (vendorErrors.length > 0) {
    drafts.push(logDraft('stderr', `[WARN] cc 自报的收尾错误：${vendorErrors.join(' / ')}`));
  }
  return {
    drafts,
    tokens,
    timing,
    turns,
    // 归属：第三个出口同样要带（失败是这一行的结论，但它读的是主循环的那一次往返）
    turn: turns === null ? null : { subagentId: null, round: turns },
    failure: classifyAgentMessage(failureText, context),
  };
}

/** assistant 消息：文本块进日志、工具与推理块原样落盘（落盘但不必解析） */
function assistantDrafts(message: Record<string, unknown> | null, raw: unknown): AgentEventDraft[] {
  const drafts: AgentEventDraft[] = [];
  const blocks = readContentBlocks(message);
  // 空串文本块不算「有文本」：`textOfBlock` 对 `{ type: 'text', text: '' }` 返回 `''`（不是
  // null），于是 `texts.length > 0` 成立、`join('\n')` 是空串 ⇒ 抽屉里多一条**空日志**（契约的
  // `log.text` 是 `z.string()`，允许空串，落盘不会被拒）。与 `projectResult` 的 N3 修复同一条原则：
  // `''` 既落不成日志，就不该落。
  const texts = blocks.map(textOfBlock).filter((text): text is string => text !== null && text !== '');
  if (texts.length > 0) drafts.push(logDraft('stdout', texts.join('\n')));
  const others = blocks.filter((block) => textOfBlock(block) === null);
  if (others.length > 0) {
    // 工具 / 推理块：序列化后的原始负载照旧落盘（证据），另带一句人话摘要——
    // 卡片底部的活动行显示的是摘要，而 `[{"type":"tool_use",…}]` 那种几百字符的 JSON 不是消息
    // （用户口径）。只有推理块时不给摘要（没有「在调用什么」可说）。
    drafts.push(logDraft('stdout', safeStringify(others), summarizeToolUse(others)));
  }
  // 没有任何可读内容块（纯 metadata 消息，或只有空文本块）：也要保留原始负载，不能产生空投影
  if (drafts.length === 0) drafts.push(unknownEventDraft(raw));
  return drafts;
}

/** 取 assistant 消息的内容块数组；形状不对时给空数组（后续会把原始负载整段落盘） */
function readContentBlocks(message: Record<string, unknown> | null): unknown[] {
  const payload = asRecord(message?.message);
  const content = payload?.content;
  return Array.isArray(content) ? content : [];
}

/** 文本块 → 文本；非文本块返回 null（工具调用 / 推理块） */
function textOfBlock(block: unknown): string | null {
  const record = asRecord(block);
  if (record === null) return null;
  return record.type === 'text' && typeof record.text === 'string' ? record.text : null;
}

/**
 * 工具块的人话摘要：`调用工具 <名>：<参数摘要>`（多个块用 `；` 串成一句，整句仍截断）。
 *
 * **带参数**：只取 `name` 会产出 `调用工具 Bash`，而同一行原始负载里 `input.command` 明明写着
 * `ls -la "D:/w"`——那句摘要比它替换掉的人话（模型的答复文本）信息量更低，活动行反而变差。
 * 参数摘要的取法与另两家共用 `src/activity.ts`，只有一份实现。
 *
 * 没有 `tool_use` 块时返回 `undefined`——「这一条没有工具名可说」与「名字是空串」是两件事：
 * 前者不给摘要（活动行于是保留上一句），后者不可能（空名字的块会被过滤掉）。
 */
function summarizeToolUse(blocks: unknown[]): string | undefined {
  const parts: string[] = [];
  for (const block of blocks) {
    const record = asRecord(block);
    if (record?.type !== 'tool_use') continue;
    const name = readString(record, 'name');
    if (name === null || name === '') continue;
    const summary = toolCallSummary(name, record.input);
    if (!parts.includes(summary)) parts.push(summary);
  }
  if (parts.length === 0) return undefined;
  return clipSummary(parts.join('；'));
}

/** 空的用量三元组之外，本文件内部统一用这个别名 */
type TokenTrio = UsageTokens;

/**
 * 跑动期的用量估算（用户口径；由投影返回、骨架发事件）。
 *
 * 为什么需要它：`result` 消息要等这一行跑完才到，而界面要在跑动期就看到 tok 在动。
 * assistant 消息从第一条起就带 `message.usage`，把它按 `message.id` 归并累加即可。
 *
 * 四条取舍（每条都有对应的守卫用例）：
 *   ① **只进事件、不进结果**：返回值由投影以 `tokensEstimated: true` 交回骨架 ⇒ 它只进
 *      `usage` 事件、绝不进 `AgentRunResult`、更不会落进快照。崩溃 / 被杀的行必须仍然是
 *      「未采集」——把估算写成采集结果，比不显示更糟（与「null ≠ 0」同一条口径）；
 *   ② **按 message.id 归并**：流式响应按内容块逐条发消息、共享一个 id，各自的 usage 都**不是最终值**
 *      （`sdk.d.ts`：the turn's total usage arrives on the result message）。同 id 后到覆盖先到，
 *      于是「一条 API 轮次只算一次」，output 随流增长；
 *   ③ **只累加主循环**：`result` 的 usage 明写排除 Task 子智能体 / sidechain / 辅助调用，
 *      把子智能体（`parent_tool_use_id` 非空）算进来，估算就会**高于**终值；
 *   ④ **缺 message.id 就不出数**：没有归并键时重复快照会被重复累加，出的是偏大的假数——
 *      「宁可不出数」与「未采集就 null」同源。
 *
 * 「值没变就不重复发事件」原来在这里做（`isSameUsage`），现已上移到骨架的统一去重
 * （`turn.ts` 的 `sameUsage`）：三家的「什么时候值得发一条」必须是同一条规则。
 */
function estimateTokens(message: Record<string, unknown> | null, state: TurnState): TokenTrio | null {
  // 子智能体的消息（主循环之外）：它的用量不在 result 的合计口径里
  if (sideChainCallIdOf(message) !== null) return null;
  const payload = asRecord(message?.message);
  const messageId = readString(payload, 'id');
  if (messageId === null) return null;
  // 这里刻意**不**落 WARN：流式中间快照缺项是常态（结算值那条路径上的 WARN 才是要人看的）
  const tokens = readUsageTrio(payload?.usage);
  if (tokens === null) return null;
  /**
   * **全 0 的快照 = 「这一条还没填好」，不是「采到了 0」**。
   *
   * 实测形状（本机 `likecode` 网关 + `jd/GLM-5.3`）：流式 assistant 消息带的
   * `usage` 三项**全是 0**（SDK 明写 `message.usage` is not final），真正的用量只在收尾的
   * `result` 上（那一轮 17 次往返的结算值是 `输入 65,063 / 缓存 407,808 / 输出 5,940`）。
   * 不过滤的话，界面会在整轮里显示「tok 0」（与「采集中」含义相反，正是本仓最忌讳的那种
   * 假数），而它一次都不该出现——`result` 一到就会覆盖成真值。
   * 估算与结算对全 0 取**同一条口径**（见 `readTokens`），差别只在结算那条要不要落 WARN。
   */
  if (tokens.input === 0 && tokens.cached === 0 && tokens.output === 0) return null;
  state.usageByMessageId.set(messageId, tokens);
  return sumUsage(state.usageByMessageId);
}

/**
 * 归并表求和；空表返回 null（一条都没采到时不发明一个 0）。
 *
 * 两个可选格（2026-10-XX）在这里**整格补 `null`**：`sumUsage` 服务的是**跑动期估算**
 * （流式中间快照），而 `output_tokens_details` 不在那些快照里（结算值那条路径 `readUsageTrio`
 * 才读它）。补 `null` 而不是让它们缺席，是为了让**同一个契约形状**在这两条路径上一致——
 * 消费方不必判「这一份是估算还是结算」才知道有没有那两格（缺就是 `null`，两处一样）。
 */
function sumUsage(byMessageId: Map<string, TokenTrio>): TokenTrio | null {
  if (byMessageId.size === 0) return null;
  let input = 0;
  let cached = 0;
  let output = 0;
  let reasoningOutput = 0;
  let sawReasoning = false;
  for (const item of byMessageId.values()) {
    input += item.input;
    cached += item.cached;
    output += item.output;
    if (item.reasoningOutput != null) {
      reasoningOutput += item.reasoningOutput;
      sawReasoning = true;
    }
  }
  return {
    input,
    cached,
    output,
    // 一格都没采到就是 `null`（**不是 0**）：与「缺项即 null」同一条硬口径
    reasoningOutput: sawReasoning ? reasoningOutput : null,
    total: null,
  };
}

/**
 * 只读用量三元组、**不落任何草稿**（三项齐了才认）。
 * 结算值那条路径（`readTokens`）在它之上补一条 WARN：两处的「三项齐全才算采到」必须是同一条规则，
 * 抄两份必然漂移，而漂移的症状是「估算有数、结算值没有」这种最难解释的组合。
 */
function readUsageTrio(usage: unknown): TokenTrio | null {
  const record = asRecord(usage);
  const input = readNumber(record, 'input_tokens');
  const cached = readNumber(record, 'cache_read_input_tokens');
  const output = readNumber(record, 'output_tokens');
  if (input === null || cached === null || output === null) return null;
  return {
    input,
    cached,
    output,
    // 思考 token 的字段名见 `readThinkingTokens`（claude 的 `thinking_tokens` 路径与另两家不同）
    reasoningOutput: readThinkingTokens(record),
    // claude **没有**「厂商自报总量」这一格（Anthropic 的 usage 里就是分列的几项）
    // ⇒ 恒 `null`。**不许**用 `input + cached + output` 凑一个出来：那是我们算的，不是厂商报的，
    // 而契约里这一格的语义是「厂商原文」（见 `UsageTokensSchema` 的注释）。
    total: null,
  };
}

/**
 * 思考 token：`usage.output_tokens_details.thinking_tokens`（2026-10-XX 新增）。
 *
 * 三条取舍：
 *   · **缺就 `null`，绝不填 0**：字段缺席 / 形状不对时返回 null。填 0 会让消费方算出
 *     「这家不做推理」，而事实是「这家不上报这个数」——与 `input/cached/output` 缺项即整格 null
 *     是同一条硬口径；
 *   · **`input` 保持原样、不做减法**：Anthropic 的 `input_tokens` 天生就**不含**缓存读
 *     （三格分列：`input_tokens` / `cache_read_input_tokens` / `cache_creation_input_tokens`），
 *     与 codex 那边「cached 是 input 的明细」正好相反。本仓契约定的是「`input` = 非缓存输入」，
 *     所以这一家**什么都不用改**——这就是归一化的意义：改的是那家口径不同的，不是三家一起改；
 *   · **`cache_creation_input_tokens` 仍然不计入 `cached`**：缓存**写**不是缓存**读**，
 *     它是这一轮新落进缓存的部分（下一轮才可能被读到）。把它算进命中率的分子会得出
 *     「第一轮就命中 100%」这种假象（表里也只有「输入 / 缓存读 / 输出」三格）。
 */
function readThinkingTokens(record: Record<string, unknown> | null): number | null {
  const details = asRecord(record?.output_tokens_details);
  return readNumber(details, 'thinking_tokens');
}

/**
 * `result` 上的三个厂商时间字段 → 一份**厂商自报**的时间数据（2026-10-XX 新增）。
 *
 * `totalMs` ← `duration_ms`、`apiMs` ← `duration_api_ms`、`ttftMs` ← `ttft_ms`（**只有这一家有**，
 * 真机四个样本三个都在：`ttft_ms` 7558/252204/192833/4798、`duration_ms` 166712/275629/272405/38665、
 * `duration_api_ms` 158753/268580/258210/30177）。
 *
 * 为什么 `source: 'vendor'`：这三个数是 CLI 自己报的，**不含**我们进程这一侧的排队与冷启动，
 * 也不含工具执行 ⇒ 它与另两家那种「按事件时间戳首末相减」的墙钟不是一回事（口径差异写在契约的
 * `timing` 注释里，那是 tok/s 能不能横向比的关键）。
 * 为什么不在这里算 tok/s：比率是展示口径、原料才是契约（见契约 `UsageTokensSchema` 的公式段）。
 *
 * 为什么 `firstMs = 0` / `lastMs = durationMs`：厂商自报的只有**时长**、没有绝对时刻，而骨架只做
 * `lastMs - firstMs` ⇒ 令起点为 0 就得到 `duration_ms` 本身（`0` 在这里是**相对基准**、
 * 不是「时刻 0」的哨兵；本函数返回 `undefined` 的那一支才是「没采到」）。
 *
 * 三格**各自独立**：`duration_api_ms` / `ttft_ms` 缺了照样带上（另两格仍有值），
 * 只有 `duration_ms` 也读不到时才返回 `undefined`（= 这一条消息不带时间）——
 * 而不是返回一个各格为 `null` 的空壳：那样骨架会以为「采到了时间、只是不知道是多少」，
 * 进而把一个自称来自厂商的空 `timing` 发出去。总时长是这一格的**支点**（消费方的两个公式都要它）。
 */
function resultTiming(message: Record<string, unknown> | null): TimingSpan | undefined {
  const durationMs = readNumber(message, 'duration_ms');
  if (durationMs === null) return undefined;
  return {
    firstMs: 0,
    lastMs: durationMs,
    apiMs: readNumber(message, 'duration_api_ms'),
    ttftMs: readNumber(message, 'ttft_ms'),
    source: 'vendor',
  };
}

/**
 * 取用量三元组：三项齐了才认。
 * cached 的语义是**缓存读**（`cache_read_input_tokens`）：缓存写（`cache_creation_input_tokens`）
 * 不计入——表里写的是「输入 / 缓存读 / 输出」。
 * 形状异常（`usage` 根本不是对象、整段缺失、缺字段）**合流到同一条 WARN**：
 * `readNumber(null, …)` 天然返回 null，故不需要那条提前 return —— 有它的话，
 * `usage: 5` / `usage: 'x'` 这类形状会**静默**变成「没计量」，只剩逐笔翻原始日志才能发现。
 */
function readTokens(usage: unknown, drafts: AgentEventDraft[], numTurns: number | null, isError: boolean): TokenTrio | null {
  const tokens = readUsageTrio(usage);
  if (tokens === null) {
    drafts.push(
      logDraft('stderr', `[WARN] 用量负载不完整，本次运行按「未采集计量」处理（不填 0）：${safeStringify(usage)}`),
    );
    return null;
  }
  /**
   * **全 0 的结算值 = 「厂商没给真数」，不是「采到了 0」**。
   *
   * 厂商 JSDoc 逐字：*Crash/startup-error results may carry zeroed values*——真机形状是
   * 上游 400 之后那条 `result/success` + `is_error: true`：`usage` 三项**齐全但全 0**。
   * 按结构判据它「齐了」，按值判据它什么都没说 ⇒ 与估算路径（`estimateTokens` 里那条
   * 「全 0 的快照 = 这一条还没填好」）取同一条口径：判成**没采到**，
   * 于是计量两格照旧 `null`、`metered` 不置真——仓内那条「计量绝不填 0」的硬口径在这里落地。
   *
   * ⚠️ **零值有两种，只有一种是异常**（真机：一次 `ok: true` 的嵌套派发运行里，三条 `result`
   * 中间那条就是全 0 ——它的 `num_turns` 是 **0**，即「这一次收尾本来就没有模型往返」，
   * 零是**事实**；而崩溃 / 启动错误那一档是「明明跑过却把用量写成零」）。判据落在 `num_turns`：
   * `0` ⇒ 静默判 null；缺席或非 0 ⇒ 喊 WARN（不知道就暴露，不静默）。
   * 两档**都**判 null（都不该填 0 进计量），差别只在要不要人来看一眼。
   *
   * 为什么文案与上面那条分开：那条说「负载不完整」（形状问题），这条说「值全零」（厂商占位），
   * 排障时是两种完全不同的下一步。
   */
  if (tokens.input === 0 && tokens.cached === 0 && tokens.output === 0) {
    /**
     * 静默的**只有**「成功收尾 + `num_turns: 0`」那一档（真机嵌套派发的收场帧就是它：`success` /
     * `is_error: false` / 全 0）。失败帧即便 `num_turns` 是 0 也要说话——崩溃与启动错误恰好是最可能
     * `num_turns: 0` 的一档，把它们一起静默掉就把这条 WARN 的靶子打掉了。
     */
    if (numTurns !== 0 || isError) {
      drafts.push(
        logDraft(
          'stderr',
          `[WARN] 厂商把本次用量报成全 0，按「未采集计量」处理（真机观测到的这一族来自上游失败与限额收场，厂商文档另点名崩溃与启动错误）：${safeStringify(usage)}`,
        ),
      );
    }
    return null;
  }
  return tokens;
}

/** 空投影：本条消息不产出任何事件（纯重复事件，唯一允许丢弃的一类） */
function emptyProjection(): TurnProjection {
  return { drafts: [], tokens: null, turns: null, failure: null };
}
