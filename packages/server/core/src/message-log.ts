/**
 * 每候选行的**记录日志**（`messages.jsonl`）：追加 / 全量读 / 折叠成最终视图 / 清空。
 *
 * 里面装的是 **`RowRecord` 两种行**（spec v3 §2）：`message`（内容流：说话者、内容块、工具族）
 * 与 `subagent`（派发视图：子任务身份、终态、父链、用量）。两者共用一条流与一次订阅，
 * 消费方按 `type` 分流——各开一份的代价是「一次运行要落两处、读两处，还得保证两处一致」，
 * 而它们本来就来自同一条适配器回调。
 *
 * 与 `event-log.ts` 的分工（两者刻意不合并）：
 *   · 事件日志按 `seq` 去重与续订（行级：状态、日志、计量、失败、结束）；
 *   · 本模块按 `mergeKey` **覆盖累积**（内容级）。
 *
 * 四条口径：
 *   1. **`messageId` / `mergeKey` / `subagentId` 都由适配器分配**，本模块不重新发号：
 *      消费方按 `messageId` 去重、按 `mergeKey` 合并、按 `subagentId` 归组，缺一个就会出现
 *      「快照把旧块覆盖掉」或「同一条消息重复渲染」。
 *   2. 追加用 `appendFileSync`（O_APPEND 语义）：同一进程里的并发调用天然串行；不跨进程写。
 *   3. **一条记录一行**（不是「一条增量一行」）：适配器交出的每条消息都带该 `mergeKey` 到目前为止的
 *      完整块列表，所以文件本身就是一串可覆盖的快照——重放时按 `mergeKey` 取最后一条即得终态。
 *   4. 读侧容忍坏行（跳过后 WARN）、写侧拒绝坏数据（抛中文 `ServiceError`）：与事件日志同一条
 *      「唯一真相源不写坏数据」的理由——坏数据的表现不是报错，而是读取侧**静默丢弃**。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { RowRecordSchema, ServiceError, type AgentMessage, type RowRecord, type SubagentRecord } from '@aieval/contracts';
import { createLogger } from './logger';

const log = createLogger('message-log');

/** 追加一条记录，返回校验后的那一条（`messageId` / `mergeKey` / `subagentId` 原样保留） */
export function appendRecord(file: string, record: RowRecord): RowRecord {
  const parsed = RowRecordSchema.safeParse(record);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue === undefined || issue.path.length === 0 ? '（根对象）' : issue.path.join('.');
    throw new ServiceError(
      'INTERNAL',
      `消息写入被拒绝：字段「${path}」不符合消息契约（唯一真相源不写坏数据，否则读取侧会静默丢弃这条记录）`,
      { cause: parsed.error, context: { file, path, issue: issue?.message } },
    );
  }
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(parsed.data)}\n`, 'utf8');
  return parsed.data;
}

/** 追加一条内容消息（`appendRecord` 的窄包装：调用点只关心消息） */
export function appendMessage(file: string, message: AgentMessage): AgentMessage {
  const written = appendRecord(file, { type: 'message', message });
  return written.type === 'message' ? written.message : message;
}

/** 追加一条子任务行（同上） */
export function appendSubagent(file: string, subagent: SubagentRecord): SubagentRecord {
  const written = appendRecord(file, { type: 'subagent', subagent });
  return written.type === 'subagent' ? written.subagent : subagent;
}

/**
 * 读全量（对话视图首帧 + 导出）；文件不存在返回 `[]`。
 * 返回 `{ messages, subagents }` 两份：消费方极少同时要两者，分开省得每处再筛一遍。
 */
export function readRowRecords(file: string): { messages: AgentMessage[]; subagents: SubagentRecord[] } {
  const messages: AgentMessage[] = [];
  const subagents: SubagentRecord[] = [];
  for (const record of readRecords(file)) {
    if (record.type === 'message') messages.push(record.message);
    else subagents.push(record.subagent);
  }
  return { messages, subagents };
}

/** 读全量记录（保留原始顺序；需要最终视图用 `foldMessages` / `foldSubagents`） */
export function readRecords(file: string): RowRecord[] {
  if (!existsSync(file)) return [];
  // 容忍 UTF-8 BOM：外部工具（PowerShell 5.1）编辑过的文件首行会带 U+FEFF，JSON.parse 直接抛
  const text = readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  const records: RowRecord[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      log.warn('记录日志有一行不是合法 JSON，已跳过', { file, line: line.slice(0, 200) });
      continue;
    }
    const result = RowRecordSchema.safeParse(parsed);
    if (!result.success) {
      log.warn('记录日志有一行不符合消息契约，已跳过', { file, line: line.slice(0, 200) });
      continue;
    }
    records.push(result.data);
  }
  return records;
}

/**
 * 按 `mergeKey` 覆盖累积成**最终视图**：每个合并键保留最后一条（它的 `blocks` 已是全量），
 * 再按**首次出现顺序**返回。这就是消费方（对话视图 / 导出）要渲染的那一份。
 *
 * 为什么排序按首次出现而不是 `messageId` 的序号：`mergeKey` 的首次出现顺序就是这条逻辑消息
 * 「第一次被说到」的顺序，而后续覆盖（快照、块追加）不该把它的位置往后挪——否则界面上一条消息
 * 会在打字过程中不停跳到列表末尾。
 */
export function foldMessages(messages: readonly AgentMessage[]): AgentMessage[] {
  const order: string[] = [];
  const latest = new Map<string, AgentMessage>();
  for (const message of messages) {
    if (!latest.has(message.mergeKey)) order.push(message.mergeKey);
    latest.set(message.mergeKey, message);
  }
  return order.map((key) => latest.get(key)!);
}

/**
 * 子任务行按 `subagentId` 覆盖累积（同一子任务会多次投递：派发一条、收场一条，后者是完整快照），
 * 同样按首次出现顺序返回。
 */
export function foldSubagents(subagents: readonly SubagentRecord[]): SubagentRecord[] {
  const order: string[] = [];
  const latest = new Map<string, SubagentRecord>();
  for (const record of subagents) {
    if (!latest.has(record.subagentId)) order.push(record.subagentId);
    latest.set(record.subagentId, record);
  }
  return order.map((key) => latest.get(key)!);
}

/** 清空该行的记录日志（重跑同一行前调用，避免新旧消息混在一个文件里） */
export function resetRecords(file: string): void {
  if (!existsSync(file)) return;
  // 删文件而不是写空串：下一次 appendRecord 会重新建
  rmSync(file, { force: true });
  log.info('记录日志已清空', { file });
}
