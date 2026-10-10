/**
 * codex app-server 协议：本项目消费的字段声明 + 读取器。
 *
 * 两点约定：
 * 1. **只声明消费得到的字段**，其余忽略——上游加字段不该让这里失效；未识别的 item 类型与通知方法
 *    归入 `other`，不抛错。
 * 2. **读不到就是 `null`**：读取器不做默认值填充，不用空串或 0 冒充「没采到」。
 *
 * 形状对照 `codex app-server generate-ts --experimental`（本机 0.156.1）。
 */
import { asRecord, readNumber, readString } from '../../../json';

/** 一次模型往返的用量（app-server 用 camelCase；与 rollout 的 token_count 同源同值） */
export interface AppServerTokenUsage {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

/** 线程用量：累计 + 最近一轮 + 上下文窗口 */
export interface AppServerThreadUsage {
  total: AppServerTokenUsage;
  last: AppServerTokenUsage;
  modelContextWindow: number | null;
}

/** 线程状态 */
export type AppServerThreadStatus =
  | { type: 'notLoaded' }
  | { type: 'idle' }
  | { type: 'systemError' }
  | { type: 'active'; activeFlags: string[] };

/** 子智能体的派发元信息（线程身份与父链的唯一权威来源） */
export interface AppServerSubAgentSpawn {
  parentThreadId: string;
  depth: number;
  agentPath: string | null;
  agentNickname: string | null;
  agentRole: string | null;
}

/** 线程来源：主线程多为字符串（`exec` / `cli` / `vscode`），子智能体为 `{ subAgent: … }` */
export type AppServerSourceKind =
  | 'cli'
  | 'vscode'
  | 'exec'
  | 'appServer'
  | 'subAgent'
  | 'subAgentReview'
  | 'subAgentCompact'
  | 'subAgentThreadSpawn'
  | 'subAgentOther'
  | 'unknown';

/** 文件改动的一项 */
export interface AppServerFileChange {
  path: string;
  kind: string | null;
}

/** 归一化后的条目：`kind` 是我们自己的判别式，字段已摊平 */
export type AppServerItem =
  | { kind: 'userMessage'; id: string; text: string }
  | { kind: 'agentMessage'; id: string; text: string; phase: string | null }
  | { kind: 'reasoning'; id: string; summary: string[]; content: string[] }
  | {
    kind: 'commandExecution';
    id: string;
    command: string;
    cwd: string | null;
    status: string;
    output: string | null;
    exitCode: number | null;
    durationMs: number | null;
  }
  | { kind: 'fileChange'; id: string; status: string; changes: AppServerFileChange[] }
  | {
    kind: 'mcpToolCall';
    id: string;
    server: string;
    tool: string;
    status: string;
    durationMs: number | null;
    /** 调用参数（原样保留：形状由 MCP server 的 schema 决定，不在这里猜） */
    arguments: unknown;
    /** 调用结果；未完成时为 `null` */
    result: unknown;
    /** 调用错误；成功时为 `null` */
    error: unknown;
  }
  | {
    kind: 'dynamicToolCall';
    id: string;
    namespace: string | null;
    tool: string;
    status: string;
    success: boolean | null;
    durationMs: number | null;
    arguments: unknown;
    contentItems: unknown;
  }
  | { kind: 'toolOutput'; id: string; name: string; namespace: string | null; output: unknown }
  | {
    kind: 'collabToolCall';
    id: string;
    tool: string;
    status: string;
    senderThreadId: string | null;
    receiverThreadIds: string[];
    prompt: string | null;
    agentsStates: Array<{ threadId: string; status: string; message: string | null }>;
  }
  | { kind: 'subAgentActivity'; id: string; activity: string; agentThreadId: string; agentPath: string }
  | { kind: 'plan'; id: string; text: string }
  | { kind: 'webSearch'; id: string; query: string }
  | { kind: 'other'; id: string | null; type: string };

/** 一轮 */
export interface AppServerTurn {
  id: string;
  items: AppServerItem[];
  itemsView: 'notLoaded' | 'summary' | 'full';
  status: string;
  error: string | null;
  startedAt: number | null;
  completedAt: number | null;
  durationMs: number | null;
}

/** 线程 */
export interface AppServerThread {
  id: string;
  parentThreadId: string | null;
  agentNickname: string | null;
  agentRole: string | null;
  status: AppServerThreadStatus;
  sourceKind: AppServerSourceKind;
  subAgentSpawn: AppServerSubAgentSpawn | null;
  cwd: string | null;
  cliVersion: string | null;
  model: string | null;
  preview: string | null;
  turns: AppServerTurn[];
}

/** 条目列表的一项：条目自带所属轮次 */
export interface AppServerItemEntry {
  turnId: string;
  item: AppServerItem;
}

/** 通知的归一化载荷（只覆盖本项目消费的方法；其余归 `other`） */
export type AppServerNotificationPayload =
  | { kind: 'threadStarted'; thread: AppServerThread }
  | { kind: 'threadStatusChanged'; threadId: string; status: AppServerThreadStatus }
  | { kind: 'turnStarted'; threadId: string; turnId: string }
  | { kind: 'turnCompleted'; threadId: string; turn: AppServerTurn }
  | { kind: 'itemStarted'; threadId: string; turnId: string; item: AppServerItem }
  | { kind: 'itemCompleted'; threadId: string; turnId: string; item: AppServerItem; completedAtMs: number | null }
  | { kind: 'agentMessageDelta'; threadId: string; turnId: string; itemId: string; delta: string }
  | { kind: 'reasoningTextDelta'; threadId: string; turnId: string; itemId: string; delta: string }
  | { kind: 'reasoningSummaryDelta'; threadId: string; turnId: string; itemId: string; delta: string }
  | { kind: 'planDelta'; threadId: string; turnId: string; itemId: string; delta: string }
  | { kind: 'commandOutputDelta'; threadId: string; turnId: string; itemId: string; delta: string }
  | { kind: 'tokenUsage'; threadId: string; usage: AppServerThreadUsage }
  | { kind: 'turnPlanUpdated'; threadId: string; turnId: string; steps: Array<{ step: string; status: string }> }
  /**
   * 一台 MCP server 的**启动状态**（codex 判据来源）。
   *
   * 厂商逐字形状：
   * `{threadId, name, status: 'starting'|'ready'|'failed', error, failureReason}`。
   * `error` 只在 `failed` 时有值，原文形如
   * `MCP client for \`probe\` failed to start: MCP startup failed: No such file or directory (os error 2)`
   * ——它是行失败文案后半句的唯一来源，故原样留下来、**不加工**。
   *
   * `failureReason` 真机恒 `null`（那一列是另一套枚举），**刻意不读**：没有样本的字段读进来就是猜。
   */
  | { kind: 'mcpStartupStatus'; threadId: string | null; name: string; status: string; error: string | null }
  | { kind: 'error'; threadId: string | null; message: string }
  | { kind: 'other'; method: string };

/** 读字符串数组；非数组或含非字符串项时返回 `null`（不静默丢弃元素） */
function readStringArray(source: Record<string, unknown> | null, key: string): string[] | null {
  const value = source?.[key];
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const one of value) {
    if (typeof one !== 'string') return null;
    out.push(one);
  }
  return out;
}

/** 读对象数组（每项交给调用方解析，解析不出来就整项丢弃） */
function readObjectArray(source: Record<string, unknown> | null, key: string): Array<Record<string, unknown>> {
  const value = source?.[key];
  if (!Array.isArray(value)) return [];
  const out: Array<Record<string, unknown>> = [];
  for (const one of value) {
    const record = asRecord(one);
    if (record !== null) out.push(record);
  }
  return out;
}

/** 把 `{ type: 'reasoning_text' | 'text', text }` 形式的块拍平成字符串 */
function readTextParts(source: Record<string, unknown> | null, key: string): string[] {
  const out: string[] = [];
  for (const one of readObjectArray(source, key)) {
    const text = readString(one, 'text');
    if (text !== null && text.length > 0) out.push(text);
  }
  return out;
}

/** 用量（字段缺失时整块为 `null`：不拿 0 冒充） */
export function readTokenUsage(value: unknown): AppServerTokenUsage | null {
  const record = asRecord(value);
  if (record === null) return null;
  const fields = [
    'totalTokens',
    'inputTokens',
    'cachedInputTokens',
    'cacheWriteInputTokens',
    'outputTokens',
    'reasoningOutputTokens',
  ] as const;
  const numbers: number[] = [];
  for (const field of fields) {
    const one = readNumber(record, field);
    if (one === null) return null;
    numbers.push(one);
  }
  return {
    totalTokens: numbers[0] as number,
    inputTokens: numbers[1] as number,
    cachedInputTokens: numbers[2] as number,
    cacheWriteInputTokens: numbers[3] as number,
    outputTokens: numbers[4] as number,
    reasoningOutputTokens: numbers[5] as number,
  };
}

/** 线程用量 */
export function readThreadUsage(value: unknown): AppServerThreadUsage | null {
  const record = asRecord(value);
  if (record === null) return null;
  const total = readTokenUsage(record.total);
  const last = readTokenUsage(record.last);
  if (total === null || last === null) return null;
  return { total, last, modelContextWindow: readNumber(record, 'modelContextWindow') };
}

/** 线程状态 */
export function readThreadStatus(value: unknown): AppServerThreadStatus | null {
  const record = asRecord(value);
  const type = readString(record, 'type');
  if (type === 'notLoaded' || type === 'idle' || type === 'systemError') return { type };
  if (type === 'active') return { type, activeFlags: readStringArray(record, 'activeFlags') ?? [] };
  return null;
}

/** 来源分类：字符串直接归一；对象形态（`{ subAgent: … }`）归到子智能体一族 */
export function readSourceKind(value: unknown): AppServerSourceKind {
  if (typeof value === 'string') {
    const known: AppServerSourceKind[] = [
      'cli',
      'vscode',
      'exec',
      'appServer',
      'subAgent',
      'subAgentReview',
      'subAgentCompact',
      'subAgentThreadSpawn',
      'subAgentOther',
    ];
    return known.find((one) => one === value) ?? 'unknown';
  }
  const record = asRecord(value);
  if (record !== null && asRecord(record.subAgent) !== null) return 'subAgent';
  return 'unknown';
}

/** 子智能体派发元信息（`source.subagent.thread_spawn`；父线程 id 缺失即视为没有） */
export function readSubAgentSpawn(value: unknown): AppServerSubAgentSpawn | null {
  const source = asRecord(value);
  if (source === null) return null;
  const subAgent = asRecord(source.subAgent) ?? asRecord(source.subagent);
  const spawn = asRecord(subAgent?.thread_spawn);
  if (spawn === null) return null;
  const parentThreadId = readString(spawn, 'parent_thread_id');
  if (parentThreadId === null) return null;
  return {
    parentThreadId,
    depth: readNumber(spawn, 'depth') ?? 0,
    agentPath: readString(spawn, 'agent_path'),
    agentNickname: readString(spawn, 'agent_nickname'),
    agentRole: readString(spawn, 'agent_role'),
  };
}

/** 归一化一个条目；`type` 未知时归 `other`（不丢，便于日志里看见上游新增了什么） */
export function readItem(value: unknown): AppServerItem | null {
  const record = asRecord(value);
  if (record === null) return null;
  const type = readString(record, 'type');
  const id = readString(record, 'id') ?? '';
  if (type === null) return null;

  if (type === 'userMessage') return { kind: 'userMessage', id, text: readTextParts(record, 'content').join('') };
  if (type === 'agentMessage') {
    return { kind: 'agentMessage', id, text: readString(record, 'text') ?? '', phase: readString(record, 'phase') };
  }
  if (type === 'reasoning') {
    return {
      kind: 'reasoning',
      id,
      summary: readStringArray(record, 'summary') ?? [],
      content: readStringArray(record, 'content') ?? [],
    };
  }
  if (type === 'commandExecution') {
    return {
      kind: 'commandExecution',
      id,
      command: readString(record, 'command') ?? '',
      cwd: readString(record, 'cwd'),
      status: readString(record, 'status') ?? 'unknown',
      output: readString(record, 'aggregatedOutput'),
      exitCode: readNumber(record, 'exitCode'),
      durationMs: readNumber(record, 'durationMs'),
    };
  }
  if (type === 'fileChange') {
    return {
      kind: 'fileChange',
      id,
      status: readString(record, 'status') ?? 'unknown',
      changes: readObjectArray(record, 'changes').map((one) => ({
        path: readString(one, 'path') ?? '',
        kind: readString(one, 'kind'),
      })),
    };
  }
  if (type === 'mcpToolCall') {
    return {
      kind: 'mcpToolCall',
      id,
      server: readString(record, 'server') ?? '',
      tool: readString(record, 'tool') ?? '',
      status: readString(record, 'status') ?? 'unknown',
      durationMs: readNumber(record, 'durationMs'),
      arguments: record.arguments ?? null,
      result: record.result ?? null,
      error: record.error ?? null,
    };
  }
  if (type === 'dynamicToolCall') {
    return {
      kind: 'dynamicToolCall',
      id,
      namespace: readString(record, 'namespace'),
      tool: readString(record, 'tool') ?? '',
      status: readString(record, 'status') ?? 'unknown',
      success: typeof record.success === 'boolean' ? record.success : null,
      durationMs: readNumber(record, 'durationMs'),
      arguments: record.arguments ?? null,
      contentItems: record.contentItems ?? null,
    };
  }
  if (type === 'functionCallOutput') {
    return {
      kind: 'toolOutput',
      id,
      name: readString(record, 'name') ?? '',
      namespace: readString(record, 'namespace'),
      output: record.output ?? null,
    };
  }
  if (type === 'collabAgentToolCall') {
    const agentsStates: Array<{ threadId: string; status: string; message: string | null }> = [];
    const states = asRecord(record.agentsStates);
    if (states !== null) {
      for (const [threadId, raw] of Object.entries(states)) {
        const state = asRecord(raw);
        agentsStates.push({
          threadId,
          status: readString(state, 'status') ?? 'unknown',
          message: readString(state, 'message'),
        });
      }
    }
    return {
      kind: 'collabToolCall',
      id,
      tool: readString(record, 'tool') ?? '',
      status: readString(record, 'status') ?? 'unknown',
      senderThreadId: readString(record, 'senderThreadId'),
      receiverThreadIds: readStringArray(record, 'receiverThreadIds') ?? [],
      prompt: readString(record, 'prompt'),
      agentsStates,
    };
  }
  if (type === 'subAgentActivity') {
    return {
      kind: 'subAgentActivity',
      id,
      activity: readString(record, 'kind') ?? 'unknown',
      agentThreadId: readString(record, 'agentThreadId') ?? '',
      agentPath: readString(record, 'agentPath') ?? '',
    };
  }
  if (type === 'plan') return { kind: 'plan', id, text: readString(record, 'text') ?? '' };
  if (type === 'webSearch') return { kind: 'webSearch', id, query: readString(record, 'query') ?? '' };
  return { kind: 'other', id: id.length > 0 ? id : null, type };
}

/** 归一化一轮；`items` 里解析不出来的条目直接丢弃（不造空壳） */
export function readTurn(value: unknown): AppServerTurn | null {
  const record = asRecord(value);
  if (record === null) return null;
  const id = readString(record, 'id');
  if (id === null) return null;
  const items: AppServerItem[] = [];
  for (const one of readObjectArray(record, 'items')) {
    const item = readItem(one);
    if (item !== null) items.push(item);
  }
  const itemsView = readString(record, 'itemsView');
  const error = asRecord(record.error);
  return {
    id,
    items,
    itemsView: itemsView === 'notLoaded' || itemsView === 'summary' || itemsView === 'full' ? itemsView : 'full',
    status: readString(record, 'status') ?? 'unknown',
    error: readString(error, 'message'),
    startedAt: readNumber(record, 'startedAt'),
    completedAt: readNumber(record, 'completedAt'),
    durationMs: readNumber(record, 'durationMs'),
  };
}

/** 归一化线程 */
export function readThread(value: unknown): AppServerThread | null {
  const record = asRecord(value);
  if (record === null) return null;
  const id = readString(record, 'id');
  if (id === null) return null;
  const turns: AppServerTurn[] = [];
  for (const one of readObjectArray(record, 'turns')) {
    const turn = readTurn(one);
    if (turn !== null) turns.push(turn);
  }
  return {
    id,
    parentThreadId: readString(record, 'parentThreadId'),
    agentNickname: readString(record, 'agentNickname'),
    agentRole: readString(record, 'agentRole'),
    status: readThreadStatus(record.status) ?? { type: 'notLoaded' },
    sourceKind: readSourceKind(record.source),
    subAgentSpawn: readSubAgentSpawn(record.source),
    cwd: readString(record, 'cwd'),
    cliVersion: readString(record, 'cliVersion'),
    model: readString(record, 'model'),
    preview: readString(record, 'preview'),
    turns,
  };
}

/** 归一化「条目 + 所属轮次」 */
export function readItemEntry(value: unknown): AppServerItemEntry | null {
  const record = asRecord(value);
  if (record === null) return null;
  const item = readItem(record.item);
  const turnId = readString(record, 'turnId');
  if (item === null || turnId === null) return null;
  return { turnId, item };
}

/** 归一化通知；未识别的方法归 `other` 并保留方法名 */
export function readNotification(method: string, params: unknown): AppServerNotificationPayload {
  const record = asRecord(params);
  const threadId = readString(record, 'threadId');
  const turnId = readString(record, 'turnId');
  const itemId = readString(record, 'itemId') ?? readString(record, 'item_id');
  if (method === 'thread/started') {
    const thread = readThread(record?.thread);
    if (thread !== null) return { kind: 'threadStarted', thread };
  }
  if (method === 'thread/status/changed' && threadId !== null) {
    const status = readThreadStatus(record?.status);
    if (status !== null) return { kind: 'threadStatusChanged', threadId, status };
  }
  if (method === 'turn/started' && threadId !== null) {
    const turn = readTurn(record?.turn);
    if (turn !== null) return { kind: 'turnStarted', threadId, turnId: turn.id };
  }
  if (method === 'turn/completed' && threadId !== null) {
    const turn = readTurn(record?.turn);
    if (turn !== null) return { kind: 'turnCompleted', threadId, turn };
  }
  if ((method === 'item/started' || method === 'item/completed') && threadId !== null && turnId !== null) {
    const item = readItem(record?.item);
    if (item !== null) {
      return method === 'item/started'
        ? { kind: 'itemStarted', threadId, turnId, item }
        : { kind: 'itemCompleted', threadId, turnId, item, completedAtMs: readNumber(record, 'completedAtMs') };
    }
  }
  const delta = readString(record, 'delta');
  if (delta !== null && threadId !== null && turnId !== null && itemId !== null) {
    if (method === 'item/agentMessage/delta') return { kind: 'agentMessageDelta', threadId, turnId, itemId, delta };
    if (method === 'item/reasoning/textDelta') return { kind: 'reasoningTextDelta', threadId, turnId, itemId, delta };
    if (method === 'item/reasoning/summaryTextDelta') {
      return { kind: 'reasoningSummaryDelta', threadId, turnId, itemId, delta };
    }
    if (method === 'item/plan/delta') return { kind: 'planDelta', threadId, turnId, itemId, delta };
    if (method === 'item/commandExecution/outputDelta') {
      return { kind: 'commandOutputDelta', threadId, turnId, itemId, delta };
    }
  }
  if (method === 'thread/tokenUsage/updated' && threadId !== null) {
    const usage = readThreadUsage(record?.tokenUsage);
    if (usage !== null) return { kind: 'tokenUsage', threadId, usage };
  }
  if (method === 'turn/plan/updated' && threadId !== null && turnId !== null) {
    const steps = readObjectArray(record, 'plan').map((one) => ({
      step: readString(one, 'step') ?? '',
      status: readString(one, 'status') ?? 'unknown',
    }));
    return { kind: 'turnPlanUpdated', threadId, turnId, steps };
  }
  if (method === 'mcpServer/startupStatus/updated') {
    const name = readString(record, 'name');
    const status = readString(record, 'status');
    if (name !== null && status !== null) {
      return { kind: 'mcpStartupStatus', threadId, name, status, error: readString(record, 'error') };
    }
  }
  if (method === 'error') {
    const error = asRecord(record?.error);
    return { kind: 'error', threadId, message: readString(error, 'message') ?? '未知错误' };
  }
  return { kind: 'other', method };
}
