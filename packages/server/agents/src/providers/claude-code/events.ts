/**
 * claude-code 的消息投影（§5.6.3）。
 * 规则：
 *  1. 唯一允许丢弃的是**重复消息**：同一 `uuid` 只投影一次（SDK 重放 / 续传会给重复）；
 *  2. 其余任何消息（含未识别的 type）都必须落成**保留原始负载**的日志事件，不得静默丢弃；
 *     工具 / 推理块那一条（`[{type:'tool_use',…}]`）在 2026-09-29 起**额外带一句人话摘要**
 *     （`log.summary`，用户口径：卡片底部的活动行要显示具体的消息，不能是 JSON）——
 *     原始负载仍然逐字在 `text` 里，抽屉的证据一个字没少；
 *  3. 计量只在 `result` 消息上取（§5.6.3 表）：`usage.input_tokens` /
 *     `usage.cache_read_input_tokens` / `usage.output_tokens` **三项齐了才有值**；缺一项就是
 *     「没采到」→ null 并落一条 WARN，绝不填 0（0 会让人得出「这家很省」的错误结论）；
 *     时间（2026-10-XX）同样只在 `result` 上取：`duration_ms` / `duration_api_ms` / `ttft_ms`
 *     是**厂商自报** ⇒ `source: 'vendor'`（口径见 `resultTiming`）；思考 token 取
 *     `usage.output_tokens_details.thinking_tokens`（缺就 `null`，**不填 0**）；
 *  4. 最终答复优先取 `structured_output`（结构化输出），缺失（字段不存在、为 `null` 或为空串）才
 *     回落到 `result` 文本——理由（结构化那一轮可能没有尾随 assistant、`result` 因此为空）与两个
 *     来源不一致时的 WARN 处置见 `projectResult`。
 *
 * **轮次 = 一次模型 API 往返**（用户口径，2026-09-28）：一条 `assistant` 消息就是模型对一次请求的
 * 答复，故按它的 `message.id` 去重计数（流式响应会按内容块重复到达、共享同一个 id，去重后
 * 「一条 API 往返只算一次」）。这正是 SDK 自己的口径——它的 `maxTurns` 文档逐字写着
 * 「Maximum number of agentic turns (**API round-trips**)」，收尾消息上的 `num_turns` 同义
 * （`result_index` 的注释：*Distinct from num_turns, which counts model round-trips within one turn*）。
 * 为什么不用 `num_turns` 当唯一口径：它只在收尾那一条消息上，跑动期界面只能干等（实测那一轮
 * 60 次往返、整轮只发得出一条 `usage`，界面停在「轮次 1」）；我们的计数每条 assistant 消息都在涨。
 * `num_turns` 降级为**兜底**：一条 `message.id` 都没看到时用它，两者不一致时落一条 WARN（不静默）。
 * 注意：`parent_tool_use_id` 非空的 assistant 消息来自 Task 子智能体，不在主循环的往返计数里
 * （与 `result.usage` 排除侧链的口径一致）。
 */
import type { UsageTokens } from '@aieval/contracts';
import { logDraft, safeStringify, unknownEventDraft, type AgentEventDraft } from '../../emit';
import { classifyAgentMessage, type FailureContext } from '../../errors';
import { asRecord, readNumber, readString } from '../../json';
import type { TimingSpan, TurnProjection, TurnState } from '../../turn';

/** 子智能体消息的标记字段：非空即「主循环之外」，不参与轮次计数 */
const SIDE_CHAIN_FIELD = 'parent_tool_use_id';

/** SDK 原生的子任务生命周期消息（spec §6.4）。真机实测：**默认就发**，不需要任何 SDK 选项 */
const TASK_STARTED = 'task_started';
const TASK_NOTIFICATION = 'task_notification';

export function projectClaudeMessage(raw: unknown, state: TurnState, context: FailureContext): TurnProjection {
  const message = asRecord(raw);
  const uuid = readString(message, 'uuid');
  // 重复消息：唯一允许丢弃的一类
  if (uuid !== null) {
    if (state.seen.has(uuid)) return emptyProjection();
    state.seen.add(uuid);
  }
  const type = readString(message, 'type') ?? 'unknown';
  if (type === 'result') return projectResult(message, state, context);
  if (type === 'assistant') {
    const drafts = assistantDrafts(message, raw);
    // 轮次先记（与 token 估算无关：采不到用量也照样是一次模型往返）
    const turns = countModelRoundTrip(message, state);
    // 跑动期的用量估算：**只进事件**（`tokensEstimated`），绝不进结果（见 estimateTokens）
    return { drafts, tokens: estimateTokens(message, state), tokensEstimated: true, turns, failure: null };
  }
  // 子智能体生命周期：`system` 下只有这两个 subtype 有语义（其余仍走下面的兜底）
  if (type === 'system') {
    const subagent = subagentDraft(message);
    if (subagent !== null) return { drafts: [subagent], tokens: null, turns: null, failure: null };
  }
  // system / user / 未来新增的类型：一律保留原始负载（§5.6.3）
  return { drafts: [unknownEventDraft(raw)], tokens: null, turns: null, failure: null };
}

/**
 * 子智能体生命周期 → 一条**可解析**的日志（spec §6 / §6.4）。
 *
 * 为什么以日志承载而不是新事件类型：v1 的 `AgentEvent` 是 7 型封闭联合，**没有** subagent 事件；
 * §6 的 `subagent-start`/`subagent-end` 是 v2 契约（尚未实现）。
 * 在 v1 上把它们落成一条 `log`，载荷是 JSON——消费方按 `kind: 'subagent'` 过滤即可。
 * 这与 `unknownEventDraft` 的区别是**关键的**：那时这些消息只是一坨没人认识的原始 JSON
 * （`system` 过去一律走兜底分支），派生与收场在界面上完全不可见。
 *
 * 载荷字段逐字对应 spec §6.4.3 的落点表。**真机实测（2.1.281）**：这些消息**默认就发**，
 * 不需要 `forwardSubagentText`（那一项只影响子智能体的文本/思考，见 §6.4.2）。
 *
 * 缺 `task_id` 时**照发事件、身份写 `null`**（不编一个 id、也不把整条丢掉）：
 * 丢掉会把「派了一个子任务」这件事实一起丢掉，而编一个 id 会让下游配对**静默错位**。
 * 取第三条——发事件、身份为 null，让下游**显式**看到"这一条没有身份可用"（§4「缺就是缺」）。
 * 真机两次运行 `task_id` 都非空 ⇒ 这条防御路径大概率不可达，它保的是平台/版本差异。
 */
function subagentDraft(message: Record<string, unknown> | null): AgentEventDraft | null {
  const subtype = readString(message, 'subtype');
  if (subtype !== TASK_STARTED && subtype !== TASK_NOTIFICATION) return null;
  const subagentId = readString(message, 'task_id');
  const identity = subagentId === null || subagentId === '' ? null : subagentId;

  const isStart = subtype === TASK_STARTED;
  const name = readString(message, 'description');
  const payload: Record<string, unknown> = {
    kind: 'subagent',
    phase: isStart ? 'start' : 'end',
    /**
     * `'wire'` = SDK 原生消息（spec §6.1）。claude 侧**有更好的通道**：
     * 原生 `task_*` 带 `tool_use_id`（归属键）与 `spawn_depth`，而 hook 两者都没有。
     * ⇒ claude 走 wire，hook 只作后备——这与 codex 相反（那边**只能**走 hook，§7.5.4）。
     */
    source: 'wire',
    subagentId: identity,
    // 厂商原生 id，不是我们合成的（§6.4.3 更正了先前"claude 只能合成 id"的说法）
    vendorId: identity,
    /** **归属键**：与派生它的 `Agent` 工具调用 id、以及子智能体消息的 `parent_tool_use_id` 三者相同（真机实测） */
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
     * （只有 schema 级证据，见 §6.3），dsh 待验。
     */
    payload.status = readString(message, 'status');
    // 字段名用 `outcome` 而不是厂商的 `summary`：spec §6 的 `SubagentEnd.outcome` 就是"结果摘要"，
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
  return logDraft('stdout', text, subagentSummary(isStart, name, readString(message, 'status')));
}

/** 活动行的一句话：`已派发子任务：<任务名>` / `子任务已完成：<任务名>` */
function subagentSummary(isStart: boolean, name: string | null, status: string | null): string {
  const who = name === null || name === '' ? '子任务' : name;
  if (isStart) return `已派发子任务：${who}`;
  const state = status === null || status === '' ? '结束' : SUBAGENT_STATUS_LABELS[status] ?? status;
  return `子任务${state}：${who}`;
}

/** 终态的中文说法；表里没有的状态原样透出（不假装认识） */
const SUBAGENT_STATUS_LABELS: Record<string, string> = {
  completed: '已完成',
  failed: '失败',
  stopped: '已停止',
};

/**
 * 记一次模型往返并返回**到目前为止**的次数；这条消息不带可归并的 id 时返回 null（不猜）。
 * `state.turns` 是三家共用的累计位，这里按「去重后的 id 数」覆盖写（不是自增：同一条响应
 * 的多个内容块会重复到达，自增会把一条往返数成好多次）。
 */
function countModelRoundTrip(message: Record<string, unknown> | null, state: TurnState): number | null {
  // 子智能体（Task 工具）发起的调用不在主循环往返里：与 `result.usage` 排除侧链同口径
  if (readString(message, SIDE_CHAIN_FIELD) !== null) return null;
  const messageId = readString(asRecord(message?.message), 'id');
  // 缺 message.id 就没有归并键：重复快照会被重复计数，出的是偏大的假数 ⇒ 宁可不出数
  if (messageId === null) return null;
  state.turnKeys.add(messageId);
  state.turns = state.turnKeys.size;
  return state.turns;
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
  //   · **空串 `''`** ⇒ 同样是「没有**可用的**结构化产出」（修复轮 2 / R24）。这一格必须与下面 `result`
  //     那一支**同源**：本函数明确拒绝把 `''` 当成「采到了答复」（文件头 N3），那么空的 schema 产出同样
  //     不该顶掉一个非空的 `result`——少这一格，同一个函数里就有两套互相矛盾的「空串算不算答复」；
  //   · **已序列化的 JSON 字符串** ⇒ 原样当 JSON 文本用。若照对象那样再 `JSON.stringify` 一次就是二次
  //     编码（`'"{\"a\":1}"'`），下游 parse 出来是**字符串**而不是对象 ⇒ schema 约束下的每一行都失败在
  //     「顶层不是对象」。只有对象形态才走 `safeStringify`。
  const structured = message?.structured_output;
  if (structured !== undefined && structured !== null && structured !== '') {
    const serialized = typeof structured === 'string' ? structured : safeStringify(structured);
    if (text !== null && text !== '' && text !== serialized) {
      drafts.push(
        logDraft(
          'stderr',
          '[WARN] claude-code 的 structured_output 与 result 文本不一致；本行的最终答复以 structured_output 为准'
            + '（结构化输出是 CLI 按 schema 校验过的产出）',
        ),
      );
    }
    state.finalText = serialized;
  } else if (text !== null && text !== '') {
    state.finalText = text; // 既有路径，一个字不改
  }
  const tokens = readTokens(message?.usage, drafts);
  const timing = resultTiming(message);
  const reported = readNumber(message, 'num_turns');
  if (reported !== null && state.turns > 0 && reported !== state.turns) {
    drafts.push(
      logDraft(
        'stderr',
        `[WARN] claude-code 自报的 num_turns=${reported} 与本轮按 assistant 消息数出的轮次=${state.turns} 不一致；` +
          '界面与本行快照以数出来的为准（一次模型 API 往返算一次）',
      ),
    );
  }
  const turns = state.turns > 0 ? state.turns : reported;
  // 结构化输出重试用尽：这是**评分通路**才会遇到的收场（候选阶段不传 schema）。CLI 的 subtype 是英文，
  // 直接冒到界面等于让使用者去猜；这里折成一句能直接展示的中文，并保留 subtype 供排障。
  if (message?.is_error === true && readString(message, 'subtype') === 'error_max_structured_output_retries') {
    const friendly =
      'claude-code 的结构化输出重试用尽：模型在多次重试内没有给出符合评分 schema 的 JSON。'
      + '请检查用例的评分标准项，或把评分智能体换成另一家';
    drafts.push({ type: 'error', message: friendly });
    // 「保留 subtype 供排障」的落点**只能**是这条 stderr 日志，不能是 `friendly`：界面直接展示的是
    // `failure.message`，把英文代号拼在它尾巴上，那句中文归因就白写了（这条路径上 `result` 通常是
    // 空串 ⇒ 没有 stdout 日志，subtype 若不落在这里就等于整条链路都查不到收场原因）。
    drafts.push(
      logDraft(
        'stderr',
        '[WARN] claude-code 本次以 subtype=error_max_structured_output_retries 收场（结构化输出重试用尽）',
      ),
    );
    return { drafts, tokens, timing, turns, failure: { code: 'AGENT_FAILED', message: friendly } };
  }
  if (message?.is_error !== true) {
    return { drafts, tokens, timing, turns, failure: null };
  }
  // 空串也算「没有答复」：`''` 既落不成日志（见上），也不该做成一条空文案的失败（评审 N3）
  const failureText =
    text !== null && text !== ''
      ? text
      : `claude-code 返回失败结果（subtype: ${readString(message, 'subtype') ?? 'unknown'}）`;
  drafts.push({ type: 'error', message: failureText });
  return { drafts, tokens, timing, turns, failure: classifyAgentMessage(failureText, context) };
}

/** assistant 消息：文本块进日志、工具与推理块原样落盘（落盘但不必解析，§5.6.3） */
function assistantDrafts(message: Record<string, unknown> | null, raw: unknown): AgentEventDraft[] {
  const drafts: AgentEventDraft[] = [];
  const blocks = readContentBlocks(message);
  // 空串文本块不算「有文本」（评审 L4）：`textOfBlock` 对 `{ type: 'text', text: '' }` 返回 `''`（不是
  // null），于是 `texts.length > 0` 成立、`join('\n')` 是空串 ⇒ 抽屉里多一条**空日志**（契约的
  // `log.text` 是 `z.string()`，允许空串，落盘不会被拒）。与 `projectResult` 的 N3 修复同一条原则：
  // `''` 既落不成日志，就不该落。
  const texts = blocks.map(textOfBlock).filter((text): text is string => text !== null && text !== '');
  if (texts.length > 0) drafts.push(logDraft('stdout', texts.join('\n')));
  const others = blocks.filter((block) => textOfBlock(block) === null);
  if (others.length > 0) {
    // 工具 / 推理块：序列化后的原始负载照旧落盘（§5.6.3 的证据），另带一句人话摘要——
    // 卡片底部的活动行显示的是摘要，而 `[{"type":"tool_use",…}]` 那种几百字符的 JSON 不是消息
    // （用户口径 2026-09-29）。只有推理块时不给摘要（没有「在调用什么」可说）。
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
 * 工具块的人话摘要：`调用工具 Read、Grep`（同名工具只列一次）。
 * 没有 `tool_use` 块时返回 `undefined`——「这一条没有工具名可说」与「名字是空串」是两件事：
 * 前者不给摘要（活动行于是保留上一句），后者不可能（空名字的块会被过滤掉）。
 */
function summarizeToolUse(blocks: unknown[]): string | undefined {
  const names = blocks
    .map((block) => {
      const record = asRecord(block);
      return record?.type === 'tool_use' ? readString(record, 'name') : null;
    })
    .filter((name): name is string => name !== null && name !== '');
  if (names.length === 0) return undefined;
  return `调用工具 ${[...new Set(names)].join('、')}`;
}

/** 空的用量三元组之外，本文件内部统一用这个别名 */
type TokenTrio = UsageTokens;

/**
 * 跑动期的用量估算（用户口径，2026-09-26；2026-09-28 起改由投影返回、骨架发事件）。
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
  if (readString(message, SIDE_CHAIN_FIELD) !== null) return null;
  const payload = asRecord(message?.message);
  const messageId = readString(payload, 'id');
  if (messageId === null) return null;
  // 这里刻意**不**落 WARN：流式中间快照缺项是常态（结算值那条路径上的 WARN 才是要人看的）
  const tokens = readUsageTrio(payload?.usage);
  if (tokens === null) return null;
  /**
   * **全 0 的快照 = 「这一条还没填好」，不是「采到了 0」**（2026-09-28 真机实测补的）。
   *
   * 实测形状（本机 `likecode` 网关 + `jd/GLM-5.3`）：流式 assistant 消息带的
   * `usage` 三项**全是 0**（SDK 明写 `message.usage` is not final），真正的用量只在收尾的
   * `result` 上（那一轮 17 次往返的结算值是 `输入 65,063 / 缓存 407,808 / 输出 5,940`）。
   * 不过滤的话，界面会在整轮里显示「tok 0」（与「采集中」含义相反，正是本仓最忌讳的那种
   * 假数），而它一次都不该出现——`result` 一到就会覆盖成真值。
   * 只影响**估算**：结算值那条路径（`readTokens`）不经过这里，真出现 0 也照样如实落盘。
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
 *     是同一条硬口径（§5.6.3）；
 *   · **`input` 保持原样、不做减法**：Anthropic 的 `input_tokens` 天生就**不含**缓存读
 *     （三格分列：`input_tokens` / `cache_read_input_tokens` / `cache_creation_input_tokens`），
 *     与 codex 那边「cached 是 input 的明细」正好相反。本仓契约定的是「`input` = 非缓存输入」，
 *     所以这一家**什么都不用改**——这就是归一化的意义：改的是那家口径不同的，不是三家一起改；
 *   · **`cache_creation_input_tokens` 仍然不计入 `cached`**：缓存**写**不是缓存**读**，
 *     它是这一轮新落进缓存的部分（下一轮才可能被读到）。把它算进命中率的分子会得出
 *     「第一轮就命中 100%」这种假象（spec §5.6.3 的表里也只有「输入 / 缓存读 / 输出」三格）。
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
 * 不计入——spec §5.6.3 的表写的是「输入 / 缓存读 / 输出」。
 * 形状异常（`usage` 根本不是对象、整段缺失、缺字段）**合流到同一条 WARN**（评审 N2）：
 * `readNumber(null, …)` 天然返回 null，故不需要那条提前 return —— 有它的话，
 * `usage: 5` / `usage: 'x'` 这类形状会**静默**变成「没计量」，只剩逐笔翻原始日志才能发现。
 */
function readTokens(usage: unknown, drafts: AgentEventDraft[]): TokenTrio | null {
  const tokens = readUsageTrio(usage);
  if (tokens === null) {
    drafts.push(
      logDraft('stderr', `[WARN] 用量负载不完整，本次运行按「未采集计量」处理（不填 0）：${safeStringify(usage)}`),
    );
  }
  return tokens;
}

/** 空投影：本条消息不产出任何事件（纯重复事件，唯一允许丢弃的一类） */
function emptyProjection(): TurnProjection {
  return { drafts: [], tokens: null, turns: null, failure: null };
}
