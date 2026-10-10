/**
 * dsh 的**消息归一**：把会话通知折成统一的 `AgentMessage`
 * 与 `SubagentRecord`。事件投影仍在 `events.ts`（行级审计与摘要），本文件只管内容级视图。
 *
 * 取值路径逐条（真机逐字核过，见 `probe/dumps/v4/dsh-*.jsonl`）：
 *   · 正文与思考：`session.event` → `params.event.type === 'assistant/message'` →
 *     `data.message.content[]` 的 `{type:'text'|'reasoning'}`。⚠️ `reasoning` 块**也带 `text` 字段**
 *     ⇒ 一律先按 `type` 过滤，绝不按 `text` 取值（否则推理正文会混进最终答复）。
 *   · 信封：`data.message.id` → `vendorId`；`data.turn` → `turn`（**用户轮号**）；
 *     `data.step` → `step`。
 *   · `roundTrip`：**取厂商给的每会话 `step` 号**——一次模型 API 往返
 *     = 一个 step，而 `data.step` 是**每个会话各自从 1 数**的（真机：主会话 1,2,3；子会话 1,2,3）
 *     ⇒ 主会话的号不再被别的会话推高。下面那个 `dshTurnAttribution` 是**唯一实现**（消息的
 *     `roundTrip` 与 `usage.turn.round` 必须是同一个数）。dsh 是三家唯一同时给出厂商轮号与
 *     步骤号的家，故这两个信封格只有它非 `null`。
 *   · 工具调用：`tool/call` → `data.{callId, name, arguments}`，`arguments` 是 **JSON 字符串**，
 *     这里解析成对象（解析不了就原样保留字符串：宁可不结构化，也不丢事实）。
 *   · 工具结果：`tool/result` → `data.message.{toolCallId, content[], isError}`；**结构化结果在
 *     `data.meta` 里**（`content[]` 只是给模型看的那份文本）——有 `meta` 就不要退回去解析文本。
 *   · 思考 token：`reasoningTokens` 在本仓这条路由上永远不写（`llm-pi-ai` 的 `mapUsage()` 有意不投影）
 *     ⇒ 那一格恒 `null`（能力位记 `not-projected-by-vendor`），**不许**拿 `outputTokens` 去凑。
 *   · 时间：只能用会话事件的 `time`（毫秒）算跨度，来源标 `'events'`；`apiMs` / `ttftMs` 恒 `null`。
 *
 * 子任务：
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
import type { SubagentRecord, UsageTokens, UsageTurn } from '@aieval/contracts';
import { asRecord, readNumber, readString } from '../../json';
import {
  textBlockDraft,
  thinkingBlockDraft,
  toolCallBlockDraft,
  toolResultBlockDraft,
  type MessageBlockDraft,
  type MessageDraft,
} from '../../message';
import { sumUsageTokens } from '../../usage';
import {
  DSH_SUBAGENT_CATALOG_TYPE,
  DSH_SUBAGENT_FINISHED_METHOD,
  DSH_SUBAGENT_STARTED_METHOD,
  readUsageTokens,
} from './protocol';

/** `subagent/catalog` 记住的名称与运行方式（键是 `childId`，与 `agentId` 同值） */
const catalog = new Map<string, { label: string | null; mode: string | null }>();

/** 子会话用量：`sessionId → 该会话累计用量`（子任务通知不带用量，只能这样分组求和） */
const sessionUsage = new Map<string, UsageTokens>();

/**
 * 子会话轮次：`sessionId → 该会话已观察到的 `step/start` 次数`。
 *
 * 为什么需要第二张表：本行的 `turns` 是**全树**口径（`events.ts` 的 `step/start` 那一支不按会话
 * 分叉，是既成口径），而「轮次」那一格现在要拆出**子智能体那一份** ⇒ 只能按会话另记一遍。
 * 与 `sessionUsage` 同住这里而不是写进 `events.ts` 的 `TurnState`：它是**模块级的按会话关联表**
 * （同一个进程里并行跑着好几行），与 `sessionUsage` 是同一类东西、同一处清理；塞进 `TurnState`
 * 会让「别家的会话」也进这一行的表。
 */
const sessionTurns = new Map<string, number>();

/** 测试隔离：清空三张模块级关联表（生产上每个 run 的 id 都是新 UUID，不会串） */
export function resetDshMessageStateForTesting(): void {
  catalog.clear();
  sessionUsage.clear();
  sessionTurns.clear();
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
    turn: readNumber(data, 'turn'),
    step: readNumber(data, 'step'),
    parentCallId: null,
    // 子会话的事件带的是子会话自己的 id ⇒ 那一份 sessionId 就是子智能体身份（主会话为 null）
    subagentId: sessionIdProfileSubagent(sessionId),
    chunk: 'snapshot',
    /**
     * 这条消息**自己那一次调用**的用量：wire 上每条 `assistant/message` 的
     * `data.usage` 就是它。**不参与行级累计**（那是 `events.ts` 的 `state.usage*` 与 `cumulativeTokens`
     * 的事），也不是「到这一步为止」的快照。子会话消息走同一个函数 ⇒ 同样带上。
     */
    usage: readUsageTokens(data?.usage),
    blocks,
    raw: notification,
  };
}

/**
 * 归一 stream-tap 的增量伪事件（`aieval/delta`，机制见 `stream-tap.ts`）：一条 `chunk: 'delta'`
 * 的消息草稿。块序号用**预换算的 content 位次**（tap 读取器按该次尝试的块首见顺序发号），
 * 与 `dshAssistantMessageDraft` 给快照块的 `blocks.length` 是**同一个空间** ⇒ 同一条逻辑消息的
 * 增量与快照落进同一个槽位，快照到达即覆盖收尾（「只实现 snapshot 也能正确渲染」不破）。
 *
 * 与快照侧的三处刻意差异：
 *  · `source: 'hook'`——数据来自挂进厂商进程的插件（stream-tap），不是 stdio 通知线；
 *    快照仍然 `'wire'`。同一条逻辑消息折叠后留最后一条 ⇒ 终态是 `'wire'`；
 *  · `usage: null`——增量帧不带用量（流里的 usage 快照与 `assistant/message.data.usage`
 *    同源，等快照那一次带值即可，合并器「带值覆盖、缺省保留」）；
 *  · 思考增量的档位随通道：`reasoning-delta` 给的是**完整推理正文** ⇒ `'full'`。
 */
export function dshStreamDeltaDraft(
  notification: Record<string, unknown> | null,
  sessionId: string | null,
  roundTrip: number,
): MessageDraft | null {
  const params = asRecord(notification?.params);
  const data = asRecord(asRecord(params?.event)?.data);
  const delta = asRecord(data?.delta);
  if (delta === null) return null;
  const text = readString(delta, 'text') ?? '';
  if (text === '') return null;
  const position = readNumber(delta, 'position');
  if (position === null) return null;
  const identity = { kind: 'index' as const, index: position };
  return {
    vendorId: null,
    role: 'assistant',
    source: 'hook',
    roundTrip,
    turn: readNumber(data, 'turn'),
    step: readNumber(data, 'step'),
    parentCallId: null,
    subagentId: sessionIdProfileSubagent(sessionId),
    chunk: 'delta',
    usage: null,
    blocks:
      readString(delta, 'kind') === 'reasoning'
        ? [thinkingBlockDraft(text, 'full', 'delta', null, identity)]
        : [textBlockDraft(text, 'delta', identity)],
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
    turn: readNumber(data, 'turn'),
    step: readNumber(data, 'step'),
    parentCallId: null,
    subagentId: sessionIdProfileSubagent(sessionId),
    chunk: 'snapshot',
    // 工具调用消息：消息级用量只可能挂在模型产出（`assistant/message`）上 ⇒ 这一格恒 null
    usage: null,
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
    turn: readNumber(data, 'turn'),
    step: readNumber(data, 'step'),
    // dsh 没有「调用级」归属（子任务归属只有会话 id 层级）⇒ 这一格恒 `null`
    parentCallId: null,
    subagentId: sessionIdProfileSubagent(sessionId),
    chunk: 'snapshot',
    // 工具结果消息：消息级用量恒没有（它不来自任何一次模型调用）
    usage: null,
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
 * 主子会话判定：**子会话 id 就是子任务身份**。
 *
 * 探测（逐条核过）：`subagent.started` 的 `params.subagentId` 与随后
 * 子会话事件里的 `params.sessionId` **同值**（都是那个裸 UUID），而主会话是另一种形状
 * （`session-<32 位 hex>`）。所以归属判据是「这张表里登记过的 id 才是子会话」，
 * 登记来源见 `dshSubagentRecord`。
 *
 * `parentSessionIds` 是**否决表**：`subagent.*` 通知的 `parentSessionId` 明确说了「谁是父会话」，
 * 于是同一个 id 即使曾被当成子会话登记过（同一进程里跑过多次运行的残留），也不会把主会话的消息
 * 错认成子智能体的。判据是**登记事实**，不是猜测。
 *
 * ⚠️ 这两张表是**模块级**的（跨 run 累积），而 `Note`：真机上每一条子任务的身份都是新 UUID
 * ⇒ 跨 run 串味不可达；测试隔离走 `resetDshMessageStateForTesting`。登记**不清理**是刻意的：
 * 清理需要知道「这一轮什么时候结束」，而清理错了的代价（子会话消息丢掉）比留着的代价大。
 */
const childSessions = new Set<string>();
const parentSessions = new Set<string>();

function sessionIdProfileSubagent(sessionId: string | null): string | null {
  if (sessionId === null || parentSessions.has(sessionId)) return null;
  return childSessions.has(sessionId) ? sessionId : null;
}

/** 第一个非空字符串；都没有返回 null（**不编**） */
function firstNonEmpty(...values: (string | null)[]): string | null {
  for (const value of values) {
    if (value !== null && value !== '') return value;
  }
  return null;
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
  /**
   * 身份取值**三级兜底**：
   *   · `subagent.started` / `subagent.finished` 的本机形状给的是 **`subagentId`**
   *     （与随后子会话事件里的 `params.sessionId` 同值）；
   *   · 规范描述的另一种形状给 `agentId`（与 `childSessionId` 同值）；
   *   · 再兜 `childSessionId`。
   * 三个名字指的是**同一个东西**（子会话身份），而哪一格有值随版本/通道而变 ⇒ 全认。
   */
  const agentId = readString(params, 'agentId');
  const identity = firstNonEmpty(
    readString(params, 'subagentId'),
    agentId,
    childSessionId,
  );
  if (identity === null || identity === '') return null;
  /**
   * **把身份登记成子会话**（归属判据的唯一来源）：子会话的 `assistant/message` / `tool/*`
   * 带的 `params.sessionId` 就是这个身份 ⇒ 登记之后它们才会被归到这条子任务上，
   * 而不是被当成主会话的话（或被丢掉）。
   *
   * 三个候选名都登记：真机给 `subagentId`，规范描述的形状给 `agentId` / `childSessionId`，
   * 而**登记多一个不存在的 id 是无害的**（没有任何事件会带它），漏登记才有害。
   */
  for (const candidate of [identity, agentId, childSessionId]) {
    if (candidate !== null && candidate !== '') childSessions.add(candidate);
  }
  // 父会话进否决表：主会话的正文消息因此不会被当成子智能体的话（同一进程跑多次运行时的残留也在内）
  if (parentSessionId !== null && parentSessionId !== '') parentSessions.add(parentSessionId);

  const entry = catalog.get(identity);
  const base = {
    subagentId: identity,
    name: entry?.label ?? null,
    // 类型：`mode`（`one-shot` / `continuable`）来自 catalog，`provider` 只在 finished 上
    kind: entry?.mode ?? null,
    source: 'wire' as const,
    /**
     * 派生它的那次工具调用 id（`parentCallId`）。
     *
     * 真机的 `subagent.started` / `subagent.finished` 载荷**没有 `childSessionId`、也没有 `agentId`**
     * （只有 `subagentId` / `vendorId` / `parentSessionId`），而 `subagent` 工具调用的 `callId`
     * 是 `call_…|<uuid>` 那种复合形状，与这里的身份不是同一个值 ⇒ **给不出就是 `null`，不猜**。
     * 界面因此按「派发工具入参里的任务名 == 子任务名」认派发点（逐字相同才认）。
     */
    parentCallId: null,
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

/**
 * 记一条会话的 `step/start`（= 该会话又跑了一次模型往返）。
 *
 * 调用点只有一处：`events.ts` 里 `state.turns += 1` 那一行**旁边**。为什么必须同处：
 * `turns` 是合计、这一格是分量，两者若在**不同的分支**上计数，迟早出现分量 > 合计那种破
 * 「`subagentTurns ≤ turns`」的形状——而它在界面上只表现为「那一行不画第二行」，不报错。
 */
export function noteDshSessionTurn(sessionId: string | null): void {
  if (sessionId === null || sessionId === '') return;
  sessionTurns.set(sessionId, (sessionTurns.get(sessionId) ?? 0) + 1);
}

/** 该会话到目前为止见过的 step 数（= 它自己的最后一个 step；一次都没见过就是 `null`） */
export function dshSessionRoundOf(sessionId: string | null): number | null {
  if (sessionId === null || sessionId === '') return null;
  return sessionTurns.get(sessionId) ?? null;
}

/**
 * 这一条读数属于**哪个会话的第几次模型往返**。
 *
 * 为什么是**唯一实现**：消息的 `roundTrip` 与 `usage.turn.round` 必须是同一个数——两处各算一遍，
 * 漂移的表现就是「用量那一行落在与它同号的轮次之外」，而那正是本次要修的毛病。
 *
 * 取数顺序：厂商的 `data.step`（真机每条 step 事件都带，每会话各自 1..N）→ 该会话已观察到的 step 数
 * （`turn/end` 这类不带 step 的出口走这一支）→ `null`（**不拿本行累计号顶替**：那会把读数挂到别的
 * 会话同号的轮次上）。
 */
export function dshTurnAttribution(sessionId: string | null, data: Record<string, unknown> | null): UsageTurn | null {
  const round = readNumber(data, 'step') ?? dshSessionRoundOf(sessionId);
  if (round === null) return null;
  return { subagentId: sessionIdProfileSubagent(sessionId), round };
}

/** `subagent/catalog` 的判别（名称与 mode 的唯一来源） */
export function isDshSubagentCatalog(type: string | null): boolean {
  return type === DSH_SUBAGENT_CATALOG_TYPE;
}

/**
 * 本行「**已收场却没报用量**」的子会话 id（白名单 ∩ 已收场 − 有用量）：**事实缺失**那一档。
 *
 * 为什么单独抽出来而不是写在 `dshSubagentUsage` 里：这个判据有**两个**读者——
 * `dshSubagentUsage` 用它决定「整格交 `null`」，收尾那条**点名 WARN** 用它说清「是谁没报」
 * （第三档要求 `null` 必须伴随一条点名的 WARN，codex / claude 都有）。
 * 两处各写一遍必然漂移，而漂移的症状正是本仓最不接受的那一类：结果里是 `null`、日志里却点不出人
 * （或反过来，WARN 点了名而那一格其实有数）。
 */
export function dshSilentChildSessions(input: {
  childSessions: ReadonlySet<string>;
  finishedSessions: ReadonlySet<string>;
}): string[] {
  const silent: string[] = [];
  for (const sessionId of input.childSessions) {
    if (!input.finishedSessions.has(sessionId)) continue;
    if (sessionUsage.get(sessionId) !== undefined) continue;
    silent.push(sessionId);
  }
  return silent;
}

/**
 * 本行的**子智能体那一份**用量。
 *
 * 为什么按**本行的**子会话白名单（参数 `input.childSessions`）求和、而不是「主会话之外的全部」：
 * `sessionUsage` 是**模块级**的（同一个 Node 进程里并行跑着好几行），主会话之外还有**别的行**的会话
 * ⇒ 只有本行的白名单能把这一行圈出来。
 *
 * ⚠️ 别与本文件顶部那个**模块级**的 `childSessions` 混淆：那是**子会话身份表**（供
 * `sessionIdProfileSubagent` 判归属，跨 run 累积、刻意不清），不是本行的白名单——
 * 同名不同物，这里读的**只有参数**那一份。
 *
 * 三档（「全量或 null」）：
 *   · 没有子会话 ⇒ `{0,0,0}`（确实没有，不是 null）；
 *   · 子会话**已收场**却一条用量都没有 ⇒ `null`（事实缺失，宁可不出数；**谁没报**见
 *     `dshSilentChildSessions`——收尾那条点名 WARN 与这里是**同一个判据**）；
 *   · 仍在跑的子会话 ⇒ 按「到目前为止」计入（还没有用量就先当 0，它还会报）。
 */
export function dshSubagentUsage(input: {
  childSessions: ReadonlySet<string>;
  finishedSessions: ReadonlySet<string>;
}): UsageTokens | null {
  if (input.childSessions.size === 0) return sumUsageTokens([]);
  // 第二档：整格交 null。判据只有一份（`dshSilentChildSessions`），收尾那条 WARN 与它同源
  if (dshSilentChildSessions(input).length > 0) return null;
  const parts: UsageTokens[] = [];
  for (const sessionId of input.childSessions) {
    const usage = sessionUsage.get(sessionId);
    if (usage !== undefined) parts.push(usage);
  }
  return sumUsageTokens(parts);
}

/**
 * 本行的**子智能体那一份**轮次。
 *
 * 为什么不是「拿 `turns` 减主会话的轮次」：主会话的轮次没有任何一处单独记过（`turns` 是全树累加），
 * 而按会话记一笔是**同一个计数点**上的顺手动作 ⇒ 两格由同一条 `step/start` 驱动，
 * `subagentTurns ≤ turns` 是构造上的。
 *
 * 三档与 `dshSubagentUsage` **逐字相同**（同一份白名单、**同一个**事实缺失谓词）：
 *   · 没有子会话 ⇒ `0`（确实没有，不是 `null`）；
 *   · 子会话已收场却一条 `step` 都没有 ⇒ `null`（判据 `dshSilentChildSessions`——与用量**共用**，
 *     绝不另写一个谓词：两处各写一遍必然漂移，漂移的症状是「结果是 null、日志里却点不出人」）；
 *   · 仍在跑的子会话 ⇒ 按「到目前为止」计入（还没数到就先当 0，它还会跑）。
 *
 * ⚠️ **判据取「有没有报到用量」而不是「有没有 `step/start`」**：后者看起来更贴题，但它是**第二个
 * 谓词**，会与用量的档位分歧（一个子会话报了用量却没有 `step` 那条边界上，两格会一格有数一格
 * `null`，而 WARN 只说得清其中一格）。「已收场却什么都没报」在真机上是同一个事实，用同一个谓词
 * 表达它才是对的。
 */
export function dshSubagentTurns(input: {
  childSessions: ReadonlySet<string>;
  finishedSessions: ReadonlySet<string>;
}): number | null {
  if (input.childSessions.size === 0) return 0;
  if (dshSilentChildSessions(input).length > 0) return null;
  let turns = 0;
  for (const sessionId of input.childSessions) turns += sessionTurns.get(sessionId) ?? 0;
  return turns;
}
