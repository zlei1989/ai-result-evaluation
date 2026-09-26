/**
 * codex 的事件投影（§5.6.3）。
 * 规则：
 *  1. `turn.completed` → 取 `usage.input_tokens` / `usage.cached_input_tokens` /
 *     `usage.output_tokens`（三项齐了才认，缺项 → null + WARN，绝不填 0）；
 *     **`input` 要减去 cached**（2026-10-XX）：codex 的 `input_tokens` **含**缓存读
 *     （`cached_input_tokens` 是它的明细，真机 `{input_tokens:8152, cached_input_tokens:6656}`），
 *     而本仓契约的 `input` 是**非缓存输入**（claude / dsh 的原文天生就不含 cache）
 *     ⇒ 不减会让命中率公式 `cached/(input+cached)` 的分母偏大、命中率被系统性低估。
 *     详细理由写在 `readTokens` 的 JSDoc 里（含 `max(0, …)` 那一步防御）。
 *     ⚠️ 这一条路上**没有时间**：`exec --json` 的事件流一个时间字段都没有（实测）
 *     ⇒ 这条投影**不带 `timing`**，本行的时长只能由 `finalize` 读会话文件时补上
 *     （见 `transcript.ts` 的 `transcriptTiming`，`source: 'events'`）；
 *  2. `item.updated` / `item.completed` 携带**同一 item 的累积文本**：只投影新增部分，完全重复
 *     （没有新增）则丢弃——这是「唯一允许丢弃的事件是重复事件」在 codex 上的具体形状；
 *  3. `turn.failed` / `error` → 失败，并按文案归因（401 → AUTH_FAILED 等）；
 *  4. 其余（thread.started / turn.started / item.started / 未来新增类型）一律落保留原始负载的日志事件。
 *
 * **轮次 = 一次模型 API 往返**（用户口径，2026-09-28），而 codex 这里是**近似值**，理由与误差照实登记：
 *   · codex 的 `exec --json` 顶层只有 `thread.started` / `turn.started` / `turn.completed` / `item.*`
 *     （见 `codex-rs/exec/src/exec_events.rs` 的 `ThreadEvent`），**没有逐次模型请求事件**；
 *   · 它自己的 `turn.completed` 是**整段任务**一条（实测：真实 10 次模型调用只落 1 条
 *     `turn.completed`），照它数永远是 1 —— 那正是要修的那个「三家轮次不一致」；
 *   · 逐次请求的权威计数只存在于 codex 自己的会话记录里：`$CODEX_HOME` 下 `sessions` 目录里的
 *     `rollout-*.jsonl`，其中每次模型调用落一条 `event_msg.token_count`（实测 10 条 = 10 次调用）。
 *     ⚠️ **2026-10-XX 起这个文件被读了**（`transcript.ts`，在运行**结束之后**读一次）——但它**只**用来
 *     补推理正文、子智能体的消息与用量明细（`reasoning_output_tokens` / `total_tokens`），
 *     **轮次仍然按上面的近似口径数**（用户 2026-09-28 的取舍：不依赖另一个进程内部文件的格式）。
 *     会话文件里的 `turn_id` 是更准的候选，但它属于另一个口径，混进来会让「轮次」这个数一会儿按
 *     事件流算、一会儿按文件算——那正是本文件花整段注释避免的事。
 * 故这里按**模型产出条目**近似：`item.type ∈ {reasoning, agent_message}`，按 `item.id` 去重
 * （`item.started`/`updated`/`completed` 共享同一个 id），每见一个新 id 算一次往返。
 * 误差方向实测（`ae798e52` 的 codex 行）：**偏高**——真实 10 次调用产出了 15 条这类条目
 * （一次调用常同时产出推理摘要与答复条目）；反过来，模型不产出推理摘要、只发工具调用的那一段
 * 会**偏低**。界面与快照都用这个数，README 与这里都写明它是近似。
 */
import type { UsageTokens } from '@aieval/contracts';
import { logDraft, safeStringify, unknownEventDraft, type AgentEventDraft } from '../../emit';
import { classifyAgentMessage, type FailureContext } from '../../errors';
import { asRecord, readNumber, readString } from '../../json';
import type { TurnProjection, TurnState } from '../../turn';
import { normalizedInput } from './transcript';

/** 算作「一次模型往返」的条目类型：模型产出的推理摘要与答复（工具调用条目一次可能有多个） */
const MODEL_OUTPUT_ITEM_TYPES: readonly string[] = ['reasoning', 'agent_message'];

export function projectCodexEvent(
  raw: unknown,
  state: TurnState,
  seenTexts: Map<string, string>,
  context: FailureContext,
): TurnProjection {
  const event = asRecord(raw);
  const type = readString(event, 'type') ?? 'unknown';

  if (type === 'turn.completed') {
    // 轮次**不在这里数**：这一条是整段任务一条（见文件头）。这里只交计量，轮次带上已经数到的值。
    const drafts: AgentEventDraft[] = [];
    const tokens = readTokens(event?.usage, drafts);
    return { drafts, tokens, turns: observedTurns(state), failure: null };
  }

  if (type === 'item.updated' || type === 'item.completed') {
    const item = asRecord(event?.item);
    const id = readString(item, 'id');
    const turns = countModelOutputItem(item, id, state);
    const text = readString(item, 'text');
    if (id === null || text === null) {
      // 没有可读文本的 item（命令执行、文件改动、MCP 调用）：保留原始负载，不解析语义
      return { drafts: [unknownEventDraft(raw)], tokens: null, turns, failure: null };
    }
    const previous = seenTexts.get(id) ?? '';
    seenTexts.set(id, text);
    // 最终答复：只认 agent 消息这一种 item——这是**防御性**过滤，不是实测结论。
    // 实测（`docs/superpowers/notes/2026-09-22-features-p3-agent-probe.md` 的 codex 一节）只看到
    // `item.completed` + `item.type === 'error'` + `item.message`（**`item.text` 缺席**）与顶层的
    // `{"type":"error","message":…}`；那条会话一次模型调用都没成功，`item.type === 'agent_message'`
    // 的形状**至今没有被探测确认**（spec §14 第 2 条：探测前不许把它当成已验证事实）。
    // 所以这里按「只有明确标了 agent_message 的 item 才算答复」的保守口径过滤：模型真回话时
    // 若不叫这个名字，结果是 `finalText === null` → 该行明确失败，而不是静默出个空分。
    // 注意这是**累积**文本，每见一次覆盖一次 ⇒ 最后一次即最终。
    if (readString(item, 'type') === 'agent_message') state.finalText = text;
    // 累积文本：startsWith 说明是「上次 + 新增」；否则视为整体替换（中间被改写），整段重发
    const delta = text.startsWith(previous) ? text.slice(previous.length) : text;
    if (delta === '') return { drafts: [], tokens: null, turns, failure: null }; // 纯重复更新：唯一允许丢弃的一类
    return { drafts: [logDraft('stdout', delta)], tokens: null, turns, failure: null };
  }

  if (type === 'turn.failed' || type === 'error') {
    const message =
      readString(asRecord(event?.error), 'message') ?? readString(event, 'message') ?? safeStringify(raw);
    return {
      drafts: [{ type: 'error', message }],
      tokens: null,
      turns: null,
      failure: classifyAgentMessage(message, context),
    };
  }

  return { drafts: [unknownEventDraft(raw)], tokens: null, turns: null, failure: null };
}

/**
 * 记一次「模型产出条目」并返回到目前为止的近似轮次；不带 id 或不是模型产出条目时返回 null。
 * 返回 null 而不是 `state.turns`：本条消息**没有给出新的轮次信息**，发一条内容相同的 usage
 * 只是噪声（老口径下这也正是「纯重复事件」的处置）。
 */
function countModelOutputItem(
  item: Record<string, unknown> | null,
  id: string | null,
  state: TurnState,
): number | null {
  const itemType = readString(item, 'type');
  if (id === null || itemType === null || !MODEL_OUTPUT_ITEM_TYPES.includes(itemType)) return null;
  const before = state.turnKeys.size;
  state.turnKeys.add(id);
  if (state.turnKeys.size === before) return null; // 同一条目的后续快照：不是新的往返
  state.turns = state.turnKeys.size;
  return state.turns;
}

/** 到目前为止的轮次；一次都没观察到时给 null（绝不发明一个 0） */
function observedTurns(state: TurnState): number | null {
  return state.turns > 0 ? state.turns : null;
}

/**
 * 三项齐了才认；缺项时落一条 WARN 并保留原始负载——「没采到」与「0」必须能区分（§5.6.3）。
 * 形状异常（`usage` 根本不是对象、整段缺失、缺字段）**合流到同一条 WARN**（评审 N2）：
 * `readNumber(null, …)` 天然返回 null，故不需要那条提前 return —— 有它的话，
 * `usage: 5` 这类形状会**静默**变成「没计量」。
 *
 * ## `input` 归一：`input_tokens − cached_input_tokens`
 *
 * codex 的 `input_tokens` **含**缓存读（`cached_input_tokens` 是它的明细），真机三处都验过：
 * Responses wire 抓包 `{input_tokens:35, input_tokens_details:{cached_tokens:0}, …}`、
 * **exec 事件流** `turn.completed.usage` 的 `{input_tokens:8152, cached_input_tokens:6656}`（6656 < 8152 ⇒ 子集）、
 * 以及 **rollout 会话文件** `token_count` 的 `{input_tokens:9340, cached_input_tokens:8320}`。
 * ⚠️ 2026-10-01 审计更正：8152/6656 那组早前被标成"来自 rollout"，实际只在 exec 事件流里；此处已按产物改正。
 * 而契约的 `input` 是**非缓存输入**（claude 的 `input_tokens` 与 dsh 的 `inputTokens` 原文就是
 * 不含 cache 的）⇒ **不减就是三家口径里的那一处真实分歧**：命中率公式 `cached/(input+cached)`
 * 在 codex 上分母偏大、命中率被系统性低估，而三家看起来「都算对了」。
 * 减法用 `normalizedInput`（与 `transcript.ts` 共用同一份实现：两处各写一遍必然漂移，
 * 而漂移的症状是「跑动期的数与会话文件的数对不上」——最难解释的一类）。
 *
 * `reasoning_output_tokens` / `total_tokens` **在这一条路上一般不存在**（会话文件的
 * `token_count` 才有），所以这里按可选格读：读得到就带上，读不到就是 `null`（**不填 0**）。
 */
function readTokens(usage: unknown, drafts: AgentEventDraft[]): UsageTokens | null {
  const record = asRecord(usage);
  const input = readNumber(record, 'input_tokens');
  // cached 的语义是**缓存读**：codex 的字段名是 cached_input_tokens（以探测 dump 为准）
  const cached = readNumber(record, 'cached_input_tokens');
  const output = readNumber(record, 'output_tokens');
  if (input === null || cached === null || output === null) {
    drafts.push(
      logDraft('stderr', `[WARN] 用量负载不完整，本次运行按「未采集计量」处理（不填 0）：${safeStringify(usage)}`),
    );
    return null;
  }
  return {
    input: normalizedInput(input, cached),
    cached,
    output,
    reasoningOutput: readNumber(record, 'reasoning_output_tokens'),
    total: readNumber(record, 'total_tokens'),
  };
}
