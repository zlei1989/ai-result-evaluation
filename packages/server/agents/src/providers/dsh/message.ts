/**
 * dsh 的**消息归一**（spec v3 §3.1 / §3.2 / §3.3 / §4.3）：把会话通知折成统一的 `AgentMessage`
 * 与 `SubagentRecord`。事件投影仍在 `events.ts`（行级审计与摘要），本文件只管内容级视图。
 *
 * 取值路径逐条（真机逐字核过，见 `probe/dumps/v4/dsh-*.jsonl`）：
 *   · 正文与思考：`session.event` → `params.event.type === 'assistant/message'` →
 *     `data.message.content[]` 的 `{type:'text'|'reasoning'}`。⚠️ `reasoning` 块**也带 `text` 字段**
 *     ⇒ 一律先按 `type` 过滤，绝不按 `text` 取值（否则推理正文会混进最终答复）。
 *   · 信封：`data.message.id` → `vendorId`；`data.turn` → `vendorTurn`（**用户轮号**）；
 *     `data.step` → `step`。
 *   · `roundTrip`：按 `step/start` 边界计数（一次模型 API 往返 = 一个 step）。dsh 是三家唯一
 *     同时给出厂商轮号与步骤号的家，故这两个信封格只有它非 `null`。
 *   · 工具调用：`tool/call` → `data.{callId, name, arguments}`，`arguments` 是 **JSON 字符串**，
 *     这里解析成对象（解析不了就原样保留字符串：宁可不结构化，也不丢事实）。
 *   · 工具结果：`tool/result` → `data.message.{toolCallId, content[], isError}`；**结构化结果在
 *     `data.meta` 里**（`content[]` 只是给模型看的那份文本）——有 `meta` 就不要退回去解析文本。
 *   · 思考 token：`reasoningTokens` 在本仓这条路由上永远不写（`llm-pi-ai` 的 `mapUsage()` 有意不投影）
 *     ⇒ 那一格恒 `null`（能力位记 `not-projected-by-vendor`），**不许**拿 `outputTokens` 去凑。
 *   · 时间：只能用会话事件的 `time`（毫秒）算跨度，来源标 `'events'`；`apiMs` / `ttftMs` 恒 `null`。
 *
 * 子任务（§4.3 步骤 4）：
 *   · 身份取 `agentId`（与 `childSessionId` 同值，真机核过）；收场之前 `subagent.started` 只给
 *     `childSessionId` ⇒ 那时用它认人，收场时两者同值、记录被完整快照覆盖。
 *   · 名称与类型在另一条会话事件 `subagent/catalog`（`childId` / `mode` / `label`）；
 *     `provider` 只在 `subagent.finished` 上。
 *   · 终态**两格合读**：`status`（只有 `ok` / `error`）与 `stopReason`（五档）。`status` 单独读
 *     两个方向都会骗人——取消是 `error` + `aborted`（字面像失败），截断是 `ok` + `max-tokens`
 *     （字面像成功）。映射表只覆盖实测档位，未观测档记 `unknown` + `statusMissing: 'unverified'`。
 *   · `outcome` 只取 `lastAssistantMessage` 里 `type === 'text'` 的块（取消时可能只有 `reasoning`）。
 *   · 子任务级用量不在子任务通知里 ⇒ 按 `params.sessionId` 把子会话的 `assistant/message.data.usage`
 *     分组求和（那是子会话自己的往返用量），`source` 记 `'wire'`。
 */
import type { SubagentRecord, UsageTokens } from '@aieval/contracts';
import { asRecord, readNumber, readString } from '../../json';
import {
  textBlockDraft,
  thinkingBlockDraft,
  toolCallBlockDraft,
  toolResultBlockDraft,
  type MessageBlockDraft,
  type MessageDraft,
} from '../../message';
import {
  DSH_SUBAGENT_CATALOG_TYPE,
  DSH_SUBAGENT_FINISHED_METHOD,
  DSH_SUBAGENT_STARTED_METHOD,
} from './protocol';

/** `subagent/catalog` 记住的名称与运行方式（键是 `childId`，与 `agentId` 同值） */
const catalog = new Map<string, { label: string | null; mode: string | null }>();

/** 子会话用量：`sessionId → 该会话累计用量`（子任务通知不带用量，只能这样分组求和） */
const sessionUsage = new Map<string, UsageTokens>();

/** 测试隔离：清空两张模块级关联表（生产上每个 run 的 id 都是新 UUID，不会串） */
export function resetDshMessageStateForTesting(): void {
  catalog.clear();
  sessionUsage.clear();
  childSessions.clear();
  parentSessions.clear();
}

/**
 * 供测试隔离用：清空关联表。
 * 别名保留给既有用例（它们从 `./events` import 这个名字）——**只留一个实现**，
 * 两张表一起清，避免「清了名字表、忘了用量表」那种跨用例串味。
 */
export const resetSubagentCatalogForTesting = resetDshMessageStateForTesting;

/** 查一条 catalog（名称与 mode 的唯一来源；查不到就是没到，不是「没有名字」） */
export function lookupDshSubagentCatalog(childId: string): { label: string | null; mode: string | null } | null {
  return catalog.get(childId) ?? null;
}

/** 记一条 `subagent/catalog`（名称与 mode 只在这一条里到达） */
export function rememberDshSubagentCatalog(data: Record<string, unknown> | null): void {
  const childId = readString(data, 'childId');
  if (childId === null || childId === '') return;
  catalog.set(childId, { label: readString(data, 'label'), mode: readString(data, 'mode') });
}

/** 当前通知所属的会话 id（子会话的事件与主会话在同一条流里，靠这一格区分） */
export function dshSessionIdOf(notification: Record<string, unknown> | null): string | null {
  return readString(asRecord(notification?.params), 'sessionId');
}

/**
 * 归一 `assistant/message`：每个内容块一条**快照**块草稿。
 * 块序号按「本次输出的内容顺序」分配（`data.message.content[]` 就是完整内容），
 * 所以这里用顺序分配器——它与 `stream[]` 里的 `chunk.index` 是**两个空间**，
 * 混用会让第二次输出的第 0 块盖掉第一次输出的第 0 块。
 */
export function dshAssistantMessageDraft(
  notification: Record<string, unknown> | null,
  sessionId: string | null,
  roundTrip: number,
): MessageDraft | null {
  const params = asRecord(notification?.params);
  const data = asRecord(asRecord(params?.event)?.data);
  const message = asRecord(data?.message);
  const content = message?.content;
  if (!Array.isArray(content)) return null;
  const blocks: MessageBlockDraft[] = [];
  for (const rawBlock of content) {
    const block = asRecord(rawBlock);
    const type = readString(block, 'type');
    if (type === 'text') {
      const text = readString(block, 'text');
      if (text !== null && text !== '') blocks.push(textBlockDraft(text, 'snapshot', { kind: 'index', index: blocks.length }));
      continue;
    }
    if (type === 'reasoning') {
      const text = readString(block, 'text');
      blocks.push(
        thinkingBlockDraft(
          text === '' ? null : text,
          // 本路由把完整推理正文整块投送（`reasoning-chunks` 也带全文）⇒ 档位是 `'full'`；
          // 整块都没文本时是「有思考但无文本」，不是「没有思考」
          text === null || text === '' ? 'none' : 'full',
          'snapshot',
          null,
          { kind: 'index', index: blocks.length },
        ),
      );
      continue;
    }
    if (type === 'tool-call') {
      const callId = readString(block, 'callId');
      if (callId === null) continue;
      const name = readString(block, 'name') ?? '';
      blocks.push(toolCallBlockDraft(callId, name, parseArguments(block?.arguments)));
    }
  }
  if (blocks.length === 0) return null;
  return {
    vendorId: readString(message, 'id'),
    role: 'assistant',
    source: 'wire',
    roundTrip,
    vendorTurn: readNumber(data, 'turn'),
    step: readNumber(data, 'step'),
    parentCallId: null,
    // 子会话的事件带的是子会话自己的 id ⇒ 那一份 sessionId 就是子智能体身份（主会话为 null）
    subagentId: sessionIdProfileSubagent(sessionId),
    chunk: 'snapshot',
    blocks,
    raw: notification,
  };
}

/**
 * 归一 `tool/call`：一条工具调用消息。
 * `arguments` 是 JSON 字符串（真机逐字 `{"job_id": "pwsh-16", …}`）⇒ 解析成对象再落 `input`；
 * 解析不了（截断 / 纯文本）时**原样保留字符串**——不丢事实，也不编一个空对象。
 */
export function dshToolCallDraft(
  notification: Record<string, unknown> | null,
  sessionId: string | null,
  roundTrip: number,
): MessageDraft | null {
  const params = asRecord(notification?.params);
  const data = asRecord(asRecord(params?.event)?.data);
  const callId = readString(data, 'callId');
  if (callId === null || callId === '') return null;
  return {
    vendorId: callId,
    role: 'assistant',
    source: 'wire',
    roundTrip,
    vendorTurn: readNumber(data, 'turn'),
    step: readNumber(data, 'step'),
    parentCallId: null,
    subagentId: sessionIdProfileSubagent(sessionId),
    chunk: 'snapshot',
    blocks: [toolCallBlockDraft(callId, readString(data, 'name') ?? '', parseArguments(data?.arguments))],
    raw: notification,
  };
}

/**
 * 归一 `tool/result`：一条工具结果消息。
 * 结构化结果取 `data.meta`（真机：`read` 给 `{lines[], totalLines}`、`glob` 给 `{shape:'paths',…}`、
 * `grep` 给 `{shape:'matches',…}`、`write` 给 `{operation, diffs[]}`、`edit` 给 `{diffs[…]}`）；
 * `pwsh` **没有 `meta`** ⇒ `structured` 是 `null`（它的退出码只在文本尾部的 `[exit code: N]` 里，
 * 而那是**文本**不是结构化字段 ⇒ 保持 `null`、不填 0）。
 */
export function dshToolResultDraft(
  notification: Record<string, unknown> | null,
  sessionId: string | null,
  roundTrip: number,
): MessageDraft | null {
  const params = asRecord(notification?.params);
  const data = asRecord(asRecord(params?.event)?.data);
  const message = asRecord(data?.message);
  const callId = readString(message, 'toolCallId');
  if (callId === null || callId === '') return null;
  const text = contentText(message?.content);
  return {
    vendorId: readString(message, 'id'),
    role: 'tool',
    source: 'wire',
    roundTrip,
    vendorTurn: readNumber(data, 'turn'),
    step: readNumber(data, 'step'),
    // dsh 没有「调用级」归属（子任务归属只有会话 id 层级）⇒ 这一格恒 `null`
    parentCallId: null,
    subagentId: sessionIdProfileSubagent(sessionId),
    chunk: 'snapshot',
    blocks: [
      toolResultBlockDraft(callId, text, {
        structured: data?.meta ?? null,
        isError: message?.isError === true,
      }),
    ],
    raw: notification,
  };
}

/**
 * 主子会话判定：真机里 `subagent.started` 的 `childSessionId` 与会话事件的 `params.sessionId`
 * 同空间，但**通知流自己不带主会话 id** ⇒ 判据只能是「这张表里登记过的 id 才是子会话」。
 *
 * `parentSessionIds` 是**否决表**：`subagent.*` 通知的 `parentSessionId` 明确说了「谁是父会话」，
 * 于是同一个 id 即使曾被当成子会话登记过（同一进程里跑过多次运行的残留），也不会把主会话的消息
 * 错认成子智能体的。判据是**登记事实**，不是猜测。
 */
const childSessions = new Set<string>();
const parentSessions = new Set<string>();

function sessionIdProfileSubagent(sessionId: string | null): string | null {
  if (sessionId === null || parentSessions.has(sessionId)) return null;
  return childSessions.has(sessionId) ? sessionId : null;
}

/** 取 `content[]` 里 `type === 'text'` 的非空块，按顺序用换行拼接（绝不按 `text` 字段取值） */
function contentText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      const record = asRecord(block);
      return record?.type === 'text' && typeof record.text === 'string' ? record.text : '';
    })
    .filter((entry) => entry !== '')
    .join('\n');
}

/** `arguments` 是 JSON 字符串 ⇒ 解析成对象；解析不了就原样返回（不丢事实、不编空对象） */
function parseArguments(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw ?? null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/**
 * 归一 `subagent.started` / `subagent.finished`：一行一子任务。
 *
 * 状态**两格合读**的映射表（`status` × `stopReason`）：
 *
 * | `status` | `stopReason` | 归一 | 依据 |
 * |---|---|---|---|
 * | `ok` | `completed` | `completed` | 真机成功路径 |
 * | `ok` | `max-tokens` | `failed` | 真机：字面"成功"实为被输出上限截断 = 没做完 |
 * | `error` | `aborted` | `stopped` | 真机：字面"失败"实为主动取消 |
 * | `error` | `error` | `failed` | 真机档位（与 `status` 同向） |
 * | 其余组合 | — | `unknown` + `statusMissing: 'unverified'` | 未观测档（含 `refusal`）：**不猜** |
 */
export function dshSubagentRecord(notification: Record<string, unknown> | null): SubagentRecord | null {
  const method = readString(notification, 'method');
  const isStart = method === DSH_SUBAGENT_STARTED_METHOD;
  if (!isStart && method !== DSH_SUBAGENT_FINISHED_METHOD) return null;
  const params = asRecord(notification?.params);
  const childSessionId = readString(params, 'childSessionId');
  const parentSessionId = readString(params, 'parentSessionId');
  // 身份取 `agentId`（finish 才有；真机与 `childSessionId` 同值），start 时退回 `childSessionId`
  const agentId = readString(params, 'agentId');
  const identity = agentId === null || agentId === '' ? childSessionId : agentId;
  if (identity === null || identity === '') return null;
  if (childSessionId !== null && childSessionId !== '') childSessions.add(childSessionId);
  // 父会话进否决表：主会话的正文消息因此不会被当成子智能体的话（同一进程跑多次运行时的残留也在内）
  if (parentSessionId !== null && parentSessionId !== '') parentSessions.add(parentSessionId);

  const entry = catalog.get(identity);
  const base = {
    subagentId: identity,
    name: entry?.label ?? null,
    // 类型：`mode`（`one-shot` / `continuable`）来自 catalog，`provider` 只在 finished 上
    kind: entry?.mode ?? null,
    source: 'wire' as const,
    // 嵌套父链：真机通知不带父 id，只能按「父会话是不是主会话」判定；两层以上时给不出
    parentSubagentId: null,
  };
  if (isStart) {
    return { ...base, status: 'running', statusMissing: null, outcome: null, usage: null };
  }
  const { status, statusMissing } = mapDshSubagentStatus(readString(params, 'status'), readString(params, 'stopReason'));
  return {
    ...base,
    kind: readString(params, 'provider') ?? base.kind,
    status,
    statusMissing,
    // `outcome` 只取 `type === 'text'` 的块（取消时可能只有 `reasoning` ⇒ 保持 `null`，不拿推理顶替）
    outcome: subagentOutcome(params),
    usage: sessionUsage.get(identity) ?? null,
  };
}

function mapDshSubagentStatus(
  status: string | null,
  stopReason: string | null,
): { status: SubagentRecord['status']; statusMissing: SubagentRecord['statusMissing'] } {
  if (stopReason === 'completed') return { status: status === 'ok' ? 'completed' : 'failed', statusMissing: null };
  if (stopReason === 'max-tokens') return { status: 'failed', statusMissing: null };
  if (stopReason === 'aborted') return { status: 'stopped', statusMissing: null };
  if (stopReason === 'error') return { status: 'failed', statusMissing: null };
  // `refusal` 与任何未观测组合：给一个可渲染的值，同时**显式**说明没采到（不猜、也不留 null）
  return { status: 'unknown', statusMissing: 'unverified' };
}

function subagentOutcome(params: Record<string, unknown> | null): string | null {
  const blocks = params?.lastAssistantMessage;
  if (!Array.isArray(blocks)) return null;
  const text = contentText(blocks);
  return text === '' ? null : text;
}

/**
 * 记一条子会话的 `assistant/message` 用量（子任务通知不带用量 ⇒ 收场时按会话求和）。
 * 同一个会话的多条 `assistant/message` 各自是一次往返 ⇒ 逐条相加；可选格读不到就是 `null`。
 */
export function noteDshSessionUsage(sessionId: string | null, usage: unknown): void {
  if (sessionId === null || sessionId === '') return;
  const record = asRecord(usage);
  const input = readNumber(record, 'inputTokens');
  const cached = readNumber(record, 'cacheReadTokens');
  const output = readNumber(record, 'outputTokens');
  if (input === null || cached === null || output === null) return;
  const previous = sessionUsage.get(sessionId);
  const reasoning = readNumber(record, 'reasoningTokens');
  sessionUsage.set(sessionId, {
    input: (previous?.input ?? 0) + input,
    cached: (previous?.cached ?? 0) + cached,
    output: (previous?.output ?? 0) + output,
    reasoningOutput: reasoning ?? previous?.reasoningOutput ?? null,
    // 厂商自报总量是**累计快照** ⇒ 只覆盖、不相加
    total: readNumber(record, 'totalTokens') ?? previous?.total ?? null,
  });
}

/** `subagent/catalog` 的判别（名称与 mode 的唯一来源） */
export function isDshSubagentCatalog(type: string | null): boolean {
  return type === DSH_SUBAGENT_CATALOG_TYPE;
}
