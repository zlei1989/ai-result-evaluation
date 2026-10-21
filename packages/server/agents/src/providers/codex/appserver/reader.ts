/**
 * 运行后取数：线程树与线程内容。
 *
 * 两条口径：
 * 1. **树由协议给**：`thread/list{ancestorThreadId}` 一次返回任意深度的后代（spawn-edge 树），
 *    深度与昵称取厂商声明（`source.subagent.thread_spawn`），不由链长推算。
 * 2. **内容按需回退**：`thread/turns/list` 的 `itemsView` 为 `full` 时直接用 turn 里的条目；
 *    任一 turn 不是 `full`（`summary` / `notLoaded`）就改走 `thread/items/list` 分页——
 *    摘要不是全量，不能当全量用。
 * 3. **不走已弃用的全量水合**：`thread/read` 只取元数据（不带 `includeTurns`），轮次改由
 *    `thread/turns/list` 分页取——paginated 线程上带 `includeTurns` 会被厂商投 `deprecationNotice`。
 *
 * 用量不在这里取：协议没有「按线程读用量」的请求，`thread/read` 也不返回用量，
 * 它只从运行期的 `thread/tokenUsage/updated` 通知来（见 `session.ts`）。
 */
import { asRecord, readString } from '../../../json';
import type { AppServerClient } from './client';
import {
  readItemEntry,
  readSkillsList,
  readThread,
  readTurn,
  type AppServerItemEntry,
  type AppServerSkillEntry,
  type AppServerThread,
  type AppServerThreadStatus,
  type AppServerTurn,
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
 * 读一个线程的**全部轮次**（`thread/turns/list` 分页，直到 `nextCursor` 为空）。
 *
 * **`sortDirection` 必须显式给 `'asc'`**：厂商的生成物写着 *"Optional turn pagination direction;
 * defaults to descending."*，不给就是**最新一轮在前**，而下游（`terminalStatusOf` / `outcomeOf` /
 * `lastAgentText`）一律按 `turns.at(-1)` 读「最后一轮」⇒ 多轮子线程会把**第一轮**当成它的终态与结论
 * （真机读数：同一条线程两轮，不传 `sortDirection` 回 `["turn#2","turn#1"]`、`at(-1)` 拿到
 * `TURN_ANSWER_0`；传 `asc` 回 `["turn#1","turn#2"]`）。这一格依赖厂商默认值就会静默读错一轮。
 */
async function listThreadTurns(client: AppServerClient, threadId: string): Promise<AppServerTurn[]> {
  const turns: AppServerTurn[] = [];
  let cursor: string | null = null;
  do {
    const response = await client.request<unknown>('thread/turns/list', {
      threadId,
      limit: PAGE_LIMIT,
      sortDirection: 'asc',
      /**
       * **显式要 `full`**：厂商默认是 `summary`（`items` 只剩摘要，实测 10 条条目只回 2 条），
       * 而下面那条「全是 `full` 就直接用、不必再跑 `thread/items/list` 分页」的快路径
       * 就永远不可达 —— 每条线程白付一次分页请求。
       *
       * 等价性与代价都量过（真机、10 条条目其中一条 60 KB 命令输出）：两种取法拿到的条目
       * **逐条相等**（`onlyA` / `onlyC` 皆空），而 `full` 少一次 RPC、字节还略少约 2.6%。
       */
      itemsView: 'full',
      ...(cursor === null ? {} : { cursor }),
    });
    const record = asRecord(response);
    for (const one of Array.isArray(record?.data) ? record.data : []) {
      const turn = readTurn(one);
      if (turn !== null) turns.push(turn);
    }
    cursor = readString(record, 'nextCursor');
  } while (cursor !== null);
  return turns;
}

/**
 * 读一个线程的元数据与全部条目。
 *
 * **元数据与轮次分两步取**：`thread/read{threadId}`（**不带** `includeTurns`）+ `thread/turns/list`。
 * 为什么不合成一步：paginated 线程上的「全量历史水合」已被厂商弃用——带 `includeTurns` 时真机会投
 * `deprecationNotice`（原文：*"Full-history hydration is deprecated for paginated threads; omit
 * `includeTurns` or set it to `false`, then page with `thread/turns/list` and `thread/items/list`."*），
 * 而真机读数证明这条替代路径给出的**元数据字段逐格等价**（`thread/turns/list` 的每一项带
 * `status` / `startedAt` / `completedAt` / `durationMs` / `itemsView` / `items`）。
 *
 * ⚠️ **等价只对元数据成立，不对 `items` 成立**：`itemsView` 这一格厂商默认 `summary`
 * （生成物原文 *"How much item detail to include for each returned turn; defaults to summary."*），
 * 本仓**不传**这一格 ⇒ 拿到的 `items` 恒是摘要。故 `complete` 那条快路径今天**不可达**，
 * 每一条线程都会多走一次 `thread/items/list` 分页。取全量条目仍以 `thread/items/list` 为准
 * （厂商文档化的全量来源），这条回退**不是**兜底而是常走的路。
 */
export async function readThreadContent(
  client: AppServerClient,
  threadId: string,
): Promise<AppServerThreadContent | null> {
  const response = await client.request<unknown>('thread/read', { threadId });
  const thread = readThread(asRecord(response)?.thread);
  if (thread === null) return null;

  const turns = await listThreadTurns(client, threadId);
  const withTurns: AppServerThread = { ...thread, turns };
  const complete = turns.length > 0 && turns.every((turn) => turn.itemsView === 'full');
  if (complete) {
    const items: AppServerItemEntry[] = [];
    for (const turn of turns) {
      for (const item of turn.items) items.push({ turnId: turn.id, item });
    }
    return { thread: withTurns, items };
  }
  return { thread: withTurns, items: await listThreadItems(client, threadId) };
}

/**
 * 读一次技能清单（`skills/list`）——**厂商的结构化清单**，运行级「本次运行的技能」那一格最硬的证据。
 *
 * 参数只给 `cwds`：真机三种参数形状（`{}` / `{cwds:[]}` / `{cwds:[cwd]}`）都能通，而带上 cwd 才会
 * 把**项目级** skill 根（`<cwd>/.{agents,codex}/skills/`）一并列出来——那正是「被测仓库自带的
 * skill」唯一能被观测到的通道（不带 cwd 的话它们在清单里根本不出现，界面上那句安全提示就永远不会出现）。
 *
 * 返回 `null` = **采不到**（响应形状不认识）：与 `[]`（厂商回了、确实一条都没有）不是一回事。
 * 抛错由调用方处置（那一条路上失败**不许**改本次运行的结论）。
 */
export async function listSkills(client: AppServerClient, cwd: string): Promise<AppServerSkillEntry[] | null> {
  const response = await client.request<unknown>('skills/list', { cwds: [cwd] });
  return readSkillsList(response);
}
