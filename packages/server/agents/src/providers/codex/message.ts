/**
 * codex 的**消息归一**（spec v3 §3.1 / §3.2 / §3.3 / §4.2）：把会话文件折成统一的 `AgentMessage`
 * 与 `SubagentRecord`。事件投影仍在 `events.ts` / `transcript.ts`（行级审计与摘要），本文件只管内容级视图。
 *
 * **为什么这一家只从会话文件出消息**（与另两家的差别，写清楚以免被当成遗漏）：
 *   · 事件流的 `item` 缺三样东西——**工具真名**（只有 `command_execution` 这种派生条目名）、
 *     **结构化入参**（只有 `command` 文本）、以及工具结果与调用之间的 `call_id`；
 *   · 而同一个条目在会话文件里是**完整记录**（`CommandExecution` 带 `command[]` / `stdout` /
 *     `stderr` / `exit_code` / `status`，`function_call` 带真名与 `arguments`，`function_call_output`
 *     按 `call_id` 配对）；
 *   · 两边都出会让**每一条消息出现两次**（身份键不同：事件流用 `item_N`、会话文件用 `call_id`），
 *     而「同一件事两条记录」正是本契约要消灭的东西。
 *   ⇒ 一次投递，取自会话文件的权威记录。代价如实登记：**运行期看不到 codex 的消息**
 *     （会话文件要等流跑完才完整），运行期只有事件流给出的派发事件与状态。
 *
 * 取值路径逐条（真机逐字核过，见 `probe/dumps/v4/**\/rollout-*.jsonl`）：
 *   · `item.type === 'AgentMessage'` → `content[].text`（正文）→ `text` 块。
 *   · `item.type === 'Reasoning'` → `summary_text[]` 是**厂商摘要**（`textKind: 'summary'`），
 *     `raw_content[]` 是完整推理正文（`textKind: 'full'`）。真机的 wire 层 `summary` 常为空数组，
 *     故**优先取 `raw_content`**，摘要只在正文缺席时兜底——两者都不许用 `output` 之类的统计量顶替。
 *   · `item.type === 'CommandExecution'` → 一次 `run-shell`：工具调用块的真名取 `response_item/
 *     function_call.name`（同一 `call_id` 配对），入参是那份 `arguments`（JSON 字符串 ⇒ 解析成对象）；
 *     结果块给 `aggregated_output` 文本与结构化 `{exitCode, status}`。
 *     ⚠️ `aggregated_output` 是 **stdout 与 stderr 合流**（拆不开）⇒ 归一结果里不编 `stderr`。
 *   · `item.type === 'CollabAgentToolCall'` → `spawn-agent` 族的工具调用（`tool` 是协作动作名），
 *     并据 `agents_states`（**以子线程 id 为键的对象**）产出/刷新子任务行。
 *   · `item.type === 'UserMessage'` **不产出消息**：那是喂进去的输入，不是模型产出。
 *   · `roundTrip`：按模型产出条目（`Reasoning` / `AgentMessage`）的 `item.id` 去重计数。
 *     **这是近似值、系统性偏高**（工具执行也各占一个条目）——许可范围内唯一的可能口径。
 *   · `vendorTurn` / `step`：**这家没有**（恒 `null`）。
 *   · `parentSubagentId`：子线程会话文件的 `session_meta.parent_thread_id`（主线程那份为 `null`）。
 *   · 子任务状态：`agents_states[<子线程 id>].status`（事件流与会话文件同形）；**取不到就记
 *     `unknown` + `statusMissing`**，不猜终态。答复取同格的 `message`，或子会话文件里最后一条
 *     `AgentMessage`。
 *   · 子任务级用量：子会话的 `token_count.info.total_token_usage`（含 `reasoning_output_tokens`）。
 */
import type { AgentMessage, SubagentRecord, UsageTokens } from '@aieval/contracts';
import { asRecord, readNumber, readString } from '../../json';
import {
  textBlockDraft,
  thinkingBlockDraft,
  toolCallBlockDraft,
  truncate,
  usageTokens,
  type MessageDraft,
} from '../../message';
import { normalizedInput } from './transcript';
import {
  findTranscript,
  readTranscript,
  type CodexTranscript,
  type CodexTranscriptCompletedItem,
  type CodexTranscriptReader,
} from './transcript';

/** 归一产物：主线程与全部子线程的消息 + 子任务行 */
export interface CodexMessageProjection {
  messages: MessageDraft[];
  subagents: SubagentRecord[];
}

/** 模型产出条目（`roundTrip` 的计数键）：只有这两类算一次模型往返 */
const MODEL_ITEM_TYPES = new Set(['Reasoning', 'AgentMessage']);

export function projectCodexMessages(input: {
  codexHome: string;
  mainThreadId: string | null;
  childThreadIds: readonly string[];
  /** 读取函数；缺省 = 真的读盘。测试喂合成 transcript 时只换这一格（与事件侧同一个注入口） */
  read?: CodexTranscriptReader['read'];
}): CodexMessageProjection {
  const read = input.read ?? readTranscript;
  const messages: MessageDraft[] = [];
  const subagents: SubagentRecord[] = [];
  if (input.mainThreadId === null) return { messages, subagents };
  const main = readByThreadId(input.codexHome, input.mainThreadId, read);
  if (main === null) return { messages, subagents };
  messages.push(...mainThreadMessages(main));
  for (const threadId of input.childThreadIds) {
    const record = childRecord(input.codexHome, threadId, read);
    if (record !== null) subagents.push(record);
  }
  return { messages, subagents };
}

/**
 * 主线程的消息：按**行序**遍历已完成条目（顺序即发生顺序），
 * 往返序号与块序号都在这一遍里推进（两者都是「第几个」的相对量，不需要消息 id 参与）。
 */
function mainThreadMessages(transcript: CodexTranscript): MessageDraft[] {
  const drafts: MessageDraft[] = [];
  /**
   * 块序号：`载体 → 下一个序号`。**每个载体一个计数器**（键是固定的 `'block'`，因为一次只处理
   * 一条转录，载体随 `subagentId` 分文件处理）——按块类型各配一个计数器会让思考块与正文块撞号。
   */
  const blockIndices = new Map<string, number>();
  let roundTrip = 0;
  for (const item of transcript.completedItems) {
    if (item.itemType !== null && MODEL_ITEM_TYPES.has(item.itemType)) roundTrip += 1;
    drafts.push(...itemMessages(item, { roundTrip: Math.max(roundTrip, 1), subagentId: null, transcript, blockIndices }));
  }
  return drafts;
}

/**
 * 一条已完成条目 → 0..n 条消息草稿。
 * `CommandExecution` 产出**两条**（调用 + 结果）：它们在同一份记录里，而契约把它们分成两种块、
 * 两条消息（`role` 一条 `tool`、`parentCallId` 一条 `null`），合并键因此天然不同、不会互相覆盖。
 */
function itemMessages(
  item: CodexTranscriptCompletedItem,
  context: {
    roundTrip: number;
    subagentId: string | null;
    transcript: CodexTranscript;
    blockIndices: Map<string, number>;
  },
): MessageDraft[] {
  const payload = item.item;
  const type = item.itemType;
  if (payload === null || type === null) return [];
  const envelope = {
    vendorId: item.itemId,
    source: 'session-file' as const,
    roundTrip: context.roundTrip,
    // 这家没有厂商轮号与步骤号：`turnId` 是厂商轮的**稳定标识**（字符串），不是序号 ⇒ 不冒充数字
    vendorTurn: null,
    step: null,
    parentCallId: null,
    subagentId: context.subagentId,
    raw: payload,
  };
  /**
   * 块序号：**每个载体一个计数器**（不分块类型）。
   *
   * 为什么不能按块类型各配一个计数器：那样「思考块 0」与「正文块 0」会撞进同一个槽位
   * （块标识就是块序号），后到的正文会把思考块覆盖掉——真机上一条消息里同时有推理与正文是常态。
   */
  const nextIndex = (): number => {
    const index = context.blockIndices.get('block') ?? 0;
    context.blockIndices.set('block', index + 1);
    return index;
  };
  if (type === 'AgentMessage') {
    const text = itemText(payload);
    if (text === '') return [];
    return [
      {
        ...envelope,
        role: 'assistant',
        chunk: 'snapshot',
        blocks: [textBlockDraft(text, 'snapshot', { kind: 'index', index: nextIndex() })],
      },
    ];
  }
  if (type === 'Reasoning') {
    const { text, kind } = reasoningOf(payload);
    return [
      {
        ...envelope,
        role: 'assistant',
        chunk: 'snapshot',
        blocks: [thinkingBlockDraft(text, kind, 'snapshot', null, { kind: 'index', index: nextIndex() })],
      },
    ];
  }
  if (type === 'CommandExecution') {
    const callId = item.itemId;
    if (callId === null || callId === '') return [];
    return [
      shellCallMessage(envelope, payload, callId, context.transcript),
      shellResultMessage(envelope, payload, callId),
    ];
  }
  if (type === 'CollabAgentToolCall') {
    const callId = item.itemId;
    if (callId === null || callId === '') return [];
    return [
      {
        ...envelope,
        // 工具调用投在 `assistant` 上（与 claude 的 `tool_use` 块同一条消息同形）；**结果**才投在
        // `tool` 上——那是同一个载体的两块，合并后与另两家逐字段同形
        role: 'assistant',
        chunk: 'snapshot',
        blocks: [toolCallBlockDraft(callId, readString(payload, 'tool') ?? 'collab_tool_call', collabInput(payload), undefined)],
      },
    ];
  }
  // 其余条目类型（`UserMessage`、将来新增的）：**不产出消息**。`UserMessage` 是喂进去的输入，
  // 把输入当产出会让对话视图把「我们说的话」混进「模型说的话」。
  return [];
}

/** 归一草稿的信封（除 `role` / `chunk` / `blocks` 外的那几格），三处消息共用一份形状 */
type Envelope = Omit<MessageDraft, 'role' | 'chunk' | 'blocks'>;

/**
 * 一次 shell 执行 → **调用消息**。
 * 工具真名取 `function_call.name`（会话文件里同一 `call_id` 配对），缺席时退回 `exec_command`
 * ——它是当前模型预设里这一族的真名（**不是**事件流那个派生条目名 `command_execution`）。
 */
function shellCallMessage(
  envelope: Envelope,
  payload: Record<string, unknown>,
  callId: string,
  transcript: CodexTranscript,
): MessageDraft {
  const call = functionCallFor(transcript, callId);
  return {
    ...envelope,
    role: 'assistant',
    chunk: 'snapshot',
    blocks: [
      {
        phase: 'snapshot',
        identity: { kind: 'call', callId },
        block: {
          type: 'tool-call',
          callId,
          family: 'run-shell',
          name: call?.name ?? 'exec_command',
          input: parseArguments(call?.arguments ?? null, commandShape(payload)),
        },
      },
    ],
  };
}

/**
 * 一次 shell 执行 → **结果消息**（与调用分成两条：与另两家同形，消费方按 `role` 分流渲染）。
 *
 * ⚠️ `aggregated_output` 是 stdout 与 stderr **合流**（拆不开）⇒ 归一结果里不编 `stderr`；
 * 运行中省略 `exit_code` 是常态 ⇒ 结构化格记 `null`（**不是** `{exitCode: null}`）。
 * 结构化里只放**退出码**、不放 `status`：成功与否由退出码表达（`0` / 非 `0`），
 * 而另两家的结果格也只有退出码——把 `status` 放进去会让同一次执行的归一结果逐家不同。
 */
function shellResultMessage(envelope: Envelope, payload: Record<string, unknown>, callId: string): MessageDraft {
  const output = readString(payload, 'aggregated_output') ?? readString(payload, 'formatted_output') ?? '';
  const { text, truncated } = truncate(output);
  const exitCode = readNumber(payload, 'exit_code');
  return {
    ...envelope,
    role: 'tool',
    chunk: 'snapshot',
    blocks: [
      {
        phase: 'snapshot',
        identity: { kind: 'call', callId },
        block: {
          type: 'tool-result',
          callId,
          structured: exitCode === null ? null : { exitCode },
          isError: exitCode !== null && exitCode !== 0,
          text,
          truncated,
        },
      },
    ],
  };
}

/**
 * 子线程 → 子任务行。
 *
 * 状态：本家**没有可靠的终态字段**（hook 载荷里没有 `status`；`agents_states` 只在事件流那一侧，
 * 而事件流在失败/中断时不完整）⇒ 判据只用**会话文件里的证据**：
 *   · 有 `AgentMessage` ⇒ 它确实产出了答复，记 `completed`；
 *   · 一条都没有 ⇒ `unknown` + `statusMissing: 'unverified'`（**没有验证过**这条路径的映射，
 *     不是「这家没有状态」）。
 * 名称取 `thread_spawn.agent_nickname`（hook 载荷里没有名称，这条是原生来源）。
 */
function childRecord(codexHome: string, threadId: string, read: CodexTranscriptReader['read']): SubagentRecord | null {
  const transcript = readByThreadId(codexHome, threadId, read);
  if (transcript === null) return null;
  const answered = transcript.completedItems.some((item) => item.itemType === 'AgentMessage');
  return {
    subagentId: threadId,
    name: transcript.sessionMeta?.threadSpawn?.agentNickname ?? null,
    // 类型：派发方式（`spawn_agent` / `wait` …）只在父消息的 `collab_tool_call` 里 ⇒ 这里给不出
    kind: null,
    source: 'session-file',
    status: answered ? 'completed' : 'unknown',
    statusMissing: answered ? null : 'unverified',
    outcome: lastAssistantText(transcript),
    // 嵌套父链：`session_meta.parent_thread_id`（主线程那份为 `null`）
    parentSubagentId: transcript.sessionMeta?.parentThreadId ?? null,
    usage: totalUsageOf(transcript),
  };
}

/** 子线程最后一条 `AgentMessage` 的正文（`outcome` 只放文本，拿不到就是 `null`） */
function lastAssistantText(transcript: CodexTranscript): string | null {
  for (let index = transcript.completedItems.length - 1; index >= 0; index -= 1) {
    const item = transcript.completedItems[index];
    if (item === undefined || item.itemType !== 'AgentMessage' || item.item === null) continue;
    const text = itemText(item.item);
    if (text !== '') return text;
  }
  return null;
}

/** 子任务级用量：`token_count.info.total_token_usage`（**必须减 cached**，与主线程同一口径） */
function totalUsageOf(transcript: CodexTranscript): UsageTokens | null {
  const counter = transcript.tokenCounters.at(-1);
  const usage = counter?.totalUsage;
  if (usage === undefined || usage === null) return null;
  if (usage.input === null || usage.cachedInput === null || usage.output === null) return null;
  return usageTokens({
    input: normalizedInput(usage.input, usage.cachedInput),
    cached: usage.cachedInput,
    output: usage.output,
    reasoningOutput: usage.reasoningOutput,
    total: usage.total,
  });
}

/** `AgentMessage.content[]` 的正文（`{type:'Text', text}`；非文本块不进正文） */
function itemText(item: Record<string, unknown>): string {
  const content = item.content;
  if (typeof item.text === 'string') return item.text;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => readString(asRecord(block), 'text') ?? '')
    .filter((text) => text !== '')
    .join('\n');
}

/**
 * `Reasoning` 的正文与档位：**优先 `raw_content`**（完整推理正文，`textKind: 'full'`），
 * 摘要 `summary_text` 只在正文缺席时兜底（那时档位是 `'summary'`）。两者都没有 ⇒
 * `text: null` + `'none'`（「有思考但拿不到文本」，**不是**「没有思考」）。
 */
function reasoningOf(item: Record<string, unknown>): { text: string | null; kind: 'full' | 'summary' | 'none' } {
  const raw = joinStrings(item.raw_content);
  if (raw !== '') return { text: raw, kind: 'full' };
  const summary = joinStrings(item.summary_text);
  if (summary !== '') return { text: summary, kind: 'summary' };
  return { text: null, kind: 'none' };
}

function joinStrings(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value
    .map((entry) => (typeof entry === 'string' ? entry : ''))
    .filter((entry) => entry !== '')
    .join('\n');
}

/** `function_call` 按 `call_id` 找真名与 `arguments`（会话文件里两者同键） */
function functionCallFor(transcript: CodexTranscript, callId: string): { name: string | null; arguments: string | null } | null {
  for (const call of transcript.functionCalls) {
    if (call.callId === callId) return { name: call.name, arguments: call.arguments };
  }
  return null;
}

/**
 * `CommandExecution.command` 是**数组**（真机 `["powershell.exe","-Command","…"]`）⇒
 * `arguments` 缺席时用它拼出可读的入参对象。单字符串形态也认（另一个 CLI 版本的形状）。
 */
function commandShape(payload: Record<string, unknown>): unknown {
  const command = payload.command;
  if (Array.isArray(command)) return { command: command.filter((part): part is string => typeof part === 'string') };
  return command ?? null;
}

/** `arguments` 是 JSON 字符串 ⇒ 解析成对象；解析不了就退回命令形状（不丢事实、不编空对象） */
function parseArguments(raw: string | null, fallback: unknown): unknown {
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** `CollabAgentToolCall` 的入参：`tool` + 收件线程 + 派发原文（`prompt` 可能缺席） */
function collabInput(payload: Record<string, unknown>): unknown {
  const input: Record<string, unknown> = {};
  for (const key of ['tool', 'prompt', 'sender_thread_id', 'receiver_thread_ids']) {
    if (payload[key] !== undefined) input[key] = payload[key];
  }
  return input;
}

/** 线程 id → 会话文件 → 解析结果；任一步失败都返回 `null`（不抛，调用方据 `null` 少一条消息） */
function readByThreadId(
  codexHome: string,
  threadId: string,
  read: CodexTranscriptReader['read'],
): CodexTranscript | null {
  const file = findTranscript(codexHome, threadId);
  return file === null ? null : read(file);
}

/** 归一消息的类型别名（供 providers 的实现签名使用） */
export type CodexMessage = AgentMessage;
