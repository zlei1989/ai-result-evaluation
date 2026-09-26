/**
 * 三家厂商原生记录 → 我们契约形状的**归一器**（spec v3 §2）。
 *
 * 取值路径逐条（真机逐字核过，`probe/dumps/v4/codex-deepseek-events.jsonl`
 * 与 `probe/dumps/v4/codex-subagent-transcript.jsonl`）：
 *   · 正文：`item.type === 'agent_message'` → `item.text`（事件流与会话文件同形）。
 *   · 思考：**事件流那条是厂商定义上的摘要通道**（`item.type === 'reasoning'`，`text` 为推理摘要），
 *     完整正文只在**会话文件**里 ⇒ 这一家按 spec §3.5 声明「会话文件那条通道才是 `'yes'`」，
 *     本文件只做事件流那一格（`textKind: 'summary'`），会话文件那条通道在 `transcript.ts` 的
 *     消息投影里（见 `providers/codex/message.ts`）。
 *   · 工具调用：事件流只有派生条目名与命令文本（`command_execution`），**真名与结构化入参在
 *     会话文件**（`function_call.name` / `arguments`）⇒ 这一格的能力位记 `not-projected-by-vendor`，
 *     本文件按能拿到的填（`name` 用条目名、`input` 用命令文本），完整那份由会话文件通道给出。
 *   · 工具结果：`command_execution.aggregated_output` / `exit_code` / `status`；
 *     `mcp_tool_call.result.content[]` / `error.message` / `status`；`file_change.changes[]` / `status`。
 *     事件流的 `aggregated_output` 是 stdout 与 stderr **合流**（拆不开）⇒ 归一结果里不编 `stderr`；
 *     运行中省略 `exit_code` ⇒ 记 `null`（不填 0）。
 *   · `role`：**派生**（事件流没有 role 概念）——`agent_message` / `reasoning` → `assistant`；
 *     `command_execution` / `file_change` / `mcp_tool_call` / `web_search` / `collab_tool_call` → `tool`；
 *     其余条目**不产出消息**（`error` 是非致命告警、`todo_list` 只是进度清单）。
 *   · `subagentId`：**恒 `null`**——子智能体不产出事件流消息，归属只能靠子线程 id（会话文件那条通道）。
 *   · `parentCallId`：**恒 `null`**（子智能体不产出消息，这一格没有载体）。
 *   · `roundTrip`：按**模型产出条目**（`reasoning` / `agent_message`）的 `item.id` 去重计数。
 *     这是近似值、**系统性偏高**（工具执行各占一个条目，但它们不是模型往返）。
 */
import { asRecord, readNumber, readString } from '../../json';
import {
  textBlockDraft,
  thinkingBlockDraft,
  toolCallBlockDraft,
  toolResultBlockDraft,
  truncate,
  type MessageDraft,
} from '../../message';
import type { TurnState } from '../../turn';

/** 事件流 item 类型（SDK 声明的联合 8 种 + 不在联合内的 `collab_tool_call`） */
const ITEM_AGENT_MESSAGE = 'agent_message';
const ITEM_REASONING = 'reasoning';
const ITEM_COMMAND = 'command_execution';
const ITEM_FILE_CHANGE = 'file_change';
const ITEM_MCP = 'mcp_tool_call';
const ITEM_WEB_SEARCH = 'web_search';
const ITEM_COLLAB = 'collab_tool_call';

/**
 * 归一一条事件流事件：返回 0..n 条消息草稿（`command_execution` / `mcp_tool_call` 这类
 * 「调用 + 结果」的条目产出两条：与另两家同形，消费方按 `role` 分流渲染）。
 * `state` 用来推进轮次（与事件投影**共用**同一个计数位：`state.turns` 是本行「已观察到的往返数」）。
 */
export function codexEventToMessage(raw: unknown, state: TurnState): MessageDraft[] {
  const event = asRecord(raw);
  if (readString(event, 'type') !== 'item.completed') return [];
  const item = asRecord(event?.item);
  if (item === null) return [];
  const itemType = readString(item, 'type');
  const itemId = readString(item, 'id');
  if (itemType === null) return [];
  // 模型产出条目才推进轮次（一次模型往返 = 一条产出条目；工具条目不算）
  if (itemType === ITEM_AGENT_MESSAGE || itemType === ITEM_REASONING) {
    if (itemId !== null) state.turnKeys.add(itemId);
    if (state.turnKeys.size > 0) state.turns = state.turnKeys.size;
  }
  const roundTrip = state.turns > 0 ? state.turns : 1;
  /**
   * 块序号：**每条条目各占一个新号**（同一个载体内按到达顺序推进）。
   * 为什么由这一层分配而不是让每个块都用 0：块标识就是块序号，全用 0 会让同一载体的
   * 「推理」与「正文」撞进同一个槽位、后到的覆盖先到的（真机一条消息里两者同时存在是常态）。
   */
  const blockIndices = blockIndicesFor(state);
  const nextIndex = (): number => {
    const index = blockIndices.get(BLOCK_INDEX_KEY) ?? 0;
    blockIndices.set(BLOCK_INDEX_KEY, index + 1);
    return index;
  };
  const envelope = {
    vendorId: itemId,
    source: 'wire' as const,
    roundTrip,
    // 这家没有厂商轮号与步骤号：`turn_id` 是标识不是序号 ⇒ 不冒充数字
    vendorTurn: null,
    step: null,
    // 子智能体不产出事件流消息 ⇒ 这两格没有载体（归属见会话文件那条通道）
    parentCallId: null,
    subagentId: null,
    raw: item,
  };
  if (itemType === ITEM_AGENT_MESSAGE) {
    const text = readString(item, 'text');
    if (text === null || text === '') return [];
    return [
      {
        ...envelope,
        role: 'assistant',
        chunk: 'snapshot',
        blocks: [textBlockDraft(text, 'snapshot', { kind: 'index', index: nextIndex() })],
      },
    ];
  }
  if (itemType === ITEM_REASONING) {
    const text = readString(item, 'text');
    return [
      {
        ...envelope,
        role: 'assistant',
        chunk: 'snapshot',
        // 事件流这条通道按厂商定义只有**摘要**（正文只在会话文件里）⇒ `textKind: 'summary'`；
        // 连摘要都没有时是「有思考但拿不到文本」⇒ `text: null` + `'none'`
        blocks: [
          thinkingBlockDraft(
            text === '' ? null : text,
            text === null || text === '' ? 'none' : 'summary',
            'snapshot',
            null,
            { kind: 'index', index: nextIndex() },
          ),
        ],
      },
    ];
  }
  if (itemType === ITEM_COMMAND) return commandMessages(envelope, item, itemId);
  if (itemType === ITEM_MCP) return mcpMessages(envelope, item, itemId);
  if (itemType === ITEM_FILE_CHANGE) return fileChangeMessages(envelope, item, itemId);
  if (itemType === ITEM_WEB_SEARCH) return webSearchMessages(envelope, item, itemId);
  if (itemType === ITEM_COLLAB) return collabMessages(envelope, item, itemId);
  // `error` 是非致命告警、`todo_list` 是进度清单：两者都**不产出消息**
  // （前者另有事件出口、后者另有 `task` 族的出口）
  return [];
}

/**
 * `command_execution` → **两条**消息：工具调用与工具结果。
 * ⚠️ 事件流这一格只有派生条目名与命令文本；工具真名（`exec_command`）与结构化入参在会话文件里
 * （spec §3.5 的 `not-projected-by-vendor`）⇒ 这里按能拿到的填，完整那份由会话文件通道给出。
 */
function commandMessages(
  envelope: Omit<MessageDraft, 'role' | 'chunk' | 'blocks'>,
  item: Record<string, unknown>,
  itemId: string | null,
): MessageDraft[] {
  if (itemId === null) return [];
  const command = readString(item, 'command');
  const output = readString(item, 'aggregated_output') ?? '';
  const { text, truncated } = truncate(output);
  const exitCode = readNumber(item, 'exit_code');
  return [
    {
      ...envelope,
      role: 'assistant',
      chunk: 'snapshot',
      blocks: [toolCallBlockDraft(itemId, ITEM_COMMAND, command === null ? null : { command })],
    },
    {
      ...envelope,
      role: 'tool',
      chunk: 'snapshot',
      blocks: [
        toolResultBlockDraft(itemId, text, {
          // 运行中省略 `exit_code` 是常态 ⇒ 结构化格记 `null`（**不是** `{exitCode: null}`）；
          // 只有退出码能进结构化格（另两家的结果格也只有它），`status` 是执行状态不是结果
          structured: exitCode === null ? null : { exitCode },
          isError: exitCode !== null && exitCode !== 0,
          truncated,
        }),
      ],
    },
  ];
}

/** `mcp_tool_call` → 调用 + 结果两条：`name` 用 `server.tool`，结果取 `result.content[]` 或 `error.message` */
function mcpMessages(
  envelope: Omit<MessageDraft, 'role' | 'chunk' | 'blocks'>,
  item: Record<string, unknown>,
  itemId: string | null,
): MessageDraft[] {
  if (itemId === null) return [];
  const server = readString(item, 'server');
  const tool = readString(item, 'tool');
  const name = server === null ? (tool ?? '') : `${server}.${tool ?? ''}`;
  const error = asRecord(item.error);
  const isError = error !== null;
  const text = contentText(asRecord(item.result)?.content) || (readString(error, 'message') ?? '');
  return [
    {
      ...envelope,
      role: 'assistant',
      chunk: 'snapshot',
      // MCP 工具不进那十族（它是任意工具）⇒ `family` 显式记 `null`，`name` 保留原名
      blocks: [toolCallBlockDraft(itemId, name, item.arguments ?? null, null)],
    },
    {
      ...envelope,
      role: 'tool',
      chunk: 'snapshot',
      // `result` 缺席时结构化格记 `null`（**不是** `{}`）
      blocks: [toolResultBlockDraft(itemId, text, { structured: item.result ?? null, isError })],
    },
  ];
}

/** `file_change` → 调用 + 结果两条：结果的结构化格放厂商给的 `changes[]`（不编 diff 统计） */
function fileChangeMessages(
  envelope: Omit<MessageDraft, 'role' | 'chunk' | 'blocks'>,
  item: Record<string, unknown>,
  itemId: string | null,
): MessageDraft[] {
  if (itemId === null) return [];
  const changes = Array.isArray(item.changes) ? item.changes : [];
  const status = readString(item, 'status');
  return [
    {
      ...envelope,
      role: 'assistant',
      chunk: 'snapshot',
      // 文件改动的工具真名在会话文件里（`apply_patch`）⇒ 事件流这一格用条目名，族判不出来就 `null`
      blocks: [toolCallBlockDraft(itemId, ITEM_FILE_CHANGE, { changes }, null)],
    },
    {
      ...envelope,
      role: 'tool',
      chunk: 'snapshot',
      blocks: [
        toolResultBlockDraft(itemId, '', {
          structured: changes.length === 0 && status === null ? null : { changes, status },
          isError: false,
        }),
      ],
    },
  ];
}

/** `web_search` → 调用 + 结果两条：`query` 即入参；结果条目只在条目自身里（结构化出口 ⇒ `null`） */
function webSearchMessages(
  envelope: Omit<MessageDraft, 'role' | 'chunk' | 'blocks'>,
  item: Record<string, unknown>,
  itemId: string | null,
): MessageDraft[] {
  if (itemId === null) return [];
  const query = readString(item, 'query');
  return [
    {
      ...envelope,
      role: 'assistant',
      chunk: 'snapshot',
      blocks: [toolCallBlockDraft(itemId, ITEM_WEB_SEARCH, query === null ? null : { query })],
    },
    { ...envelope, role: 'tool', chunk: 'snapshot', blocks: [toolResultBlockDraft(itemId, '', { structured: null, isError: false })] },
  ];
}

/**
 * `collab_tool_call` → `spawn-agent` 族的工具调用（多智能体条目，**不在** SDK 声明的 item 联合里）。
 * `wait` / `close_agent` 这类协作动作名判不出族 ⇒ `family` 记 `null`（按名字判、不按家判）。
 * 子智能体的**答复**不在这一条里（它在 `agents_states[<子线程 id>].message` 或子会话文件里）
 * ⇒ 这里不产出结果块，避免拿协作动作的回执冒充子智能体的答复。
 */
function collabMessages(
  envelope: Omit<MessageDraft, 'role' | 'chunk' | 'blocks'>,
  item: Record<string, unknown>,
  itemId: string | null,
): MessageDraft[] {
  if (itemId === null) return [];
  const tool = readString(item, 'tool') ?? ITEM_COLLAB;
  return [
    {
      ...envelope,
      role: 'assistant',
      chunk: 'snapshot',
      blocks: [toolCallBlockDraft(itemId, tool, { prompt: item.prompt ?? null })],
    },
  ];
}

/** `result.content[]` 的文本块拼接（MCP 结果的形状） */
function contentText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .map((entry) => readString(asRecord(entry), 'text') ?? '')
    .filter((text) => text !== '')
    .join('\n');
}

/** 块序号计数器的键（一条运行一个：codex 的事件流消息全都属于主线程，子智能体不产出事件流消息） */
const BLOCK_INDEX_KEY = 'block';

/**
 * 块序号计数器：借用 `TurnState.messageBlockCounters`（骨架提供的存放处）。
 * 每一条条目一个新号 ⇒ 同一载体内「推理」与「正文」不会撞进同一个槽位。
 */
function blockIndicesFor(state: TurnState): Map<string, number> {
  state.messageBlockCounters ??= new Map();
  return state.messageBlockCounters;
}
