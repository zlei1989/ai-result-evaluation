/**
 * 运行后取数：线程树与线程内容。
 *
 * 两条口径：
 * 1. **树由协议给**：`thread/list{ancestorThreadId}` 一次返回任意深度的后代（spawn-edge 树），
 *    深度与昵称取厂商声明（`source.subagent.thread_spawn`），不由链长推算。
 * 2. **内容按需回退**：`thread/read` 的 `itemsView` 为 `full` 时直接用 turn 里的条目；
 *    任一 turn 不是 `full`（`summary` / `notLoaded`）就改走 `thread/items/list` 分页——
 *    摘要不是全量，不能当全量用。
 *
 * 用量不在这里取：协议没有「按线程读用量」的请求，`thread/read` 也不返回用量，
 * 它只从运行期的 `thread/tokenUsage/updated` 通知来（见 `session.ts`）。
 */
import { asRecord, readString } from '../../../json';
import type { AppServerClient } from './client';
import {
  readItemEntry,
  readThread,
  type AppServerItemEntry,
  type AppServerThread,
  type AppServerThreadStatus,
} from './protocol';

/** 一页取多少条（线程列表与条目列表共用） */
const PAGE_LIMIT = 100;

/** 线程树里的一个后代线程 */
export interface AppServerThreadRef {
  threadId: string;
  parentThreadId: string | null;
  /** 厂商声明的派发深度；没有派发信息时为 `null`（不按链长推） */
  depth: number | null;
  nickname: string | null;
  role: string | null;
  status: AppServerThreadStatus;
}

/** 一个线程的元数据 + 全部条目 */
export interface AppServerThreadContent {
  thread: AppServerThread;
  items: AppServerItemEntry[];
}

function toThreadRef(thread: AppServerThread): AppServerThreadRef {
  const spawn = thread.subAgentSpawn;
  return {
    threadId: thread.id,
    parentThreadId: thread.parentThreadId,
    depth: spawn?.depth ?? null,
    nickname: thread.agentNickname ?? spawn?.agentNickname ?? null,
    role: thread.agentRole ?? spawn?.agentRole ?? null,
    status: thread.status,
  };
}

/** 读一个线程的全部条目（`thread/items/list` 分页，直到 `nextCursor` 为空） */
async function listThreadItems(client: AppServerClient, threadId: string): Promise<AppServerItemEntry[]> {
  const items: AppServerItemEntry[] = [];
  let cursor: string | null = null;
  do {
    const response = await client.request<unknown>('thread/items/list', {
      threadId,
      limit: PAGE_LIMIT,
      ...(cursor === null ? {} : { cursor }),
    });
    const record = asRecord(response);
    for (const one of Array.isArray(record?.data) ? record.data : []) {
      const entry = readItemEntry(one);
      if (entry !== null) items.push(entry);
    }
    cursor = readString(record, 'nextCursor');
  } while (cursor !== null);
  return items;
}

/** 列出主线程下全部后代线程（含任意深度）；`ancestorThreadId` 已排除主线程自身 */
export async function listDescendantThreads(
  client: AppServerClient,
  mainThreadId: string,
): Promise<AppServerThreadRef[]> {
  const threads: AppServerThreadRef[] = [];
  let cursor: string | null = null;
  do {
    const response = await client.request<unknown>('thread/list', {
      ancestorThreadId: mainThreadId,
      limit: PAGE_LIMIT,
      ...(cursor === null ? {} : { cursor }),
    });
    const record = asRecord(response);
    for (const one of Array.isArray(record?.data) ? record.data : []) {
      const thread = readThread(one);
      if (thread !== null) threads.push(toThreadRef(thread));
    }
    cursor = readString(record, 'nextCursor');
  } while (cursor !== null);
  return threads;
}

/**
 * 读一个线程的元数据与全部条目。
 *
 * `thread/read{includeTurns:true}` 拿轮次元数据（状态/时长）与（当 `itemsView` 全为 `full` 时）条目；
 * 任一 turn 的条目不全就只信元数据，条目改走分页接口。
 */
export async function readThreadContent(
  client: AppServerClient,
  threadId: string,
): Promise<AppServerThreadContent | null> {
  const response = await client.request<unknown>('thread/read', { threadId, includeTurns: true });
  const thread = readThread(asRecord(response)?.thread);
  if (thread === null) return null;

  const complete = thread.turns.every((turn) => turn.itemsView === 'full');
  if (complete && thread.turns.length > 0) {
    const items: AppServerItemEntry[] = [];
    for (const turn of thread.turns) {
      for (const item of turn.items) items.push({ turnId: turn.id, item });
    }
    return { thread, items };
  }
  return { thread, items: await listThreadItems(client, threadId) };
}
