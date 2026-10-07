/**
 * 评测产物的按需读取：代码改动（现场算）与执行日志（读 events.jsonl）。
 * 两条口径：
 *   1. **不预先落库**（spec §7.2）：一轮评测的 diff 正文可达数 MB，只在有人打开抽屉时才算；
 *      `EvalRow.diff` 只存计数摘要；
 *   2. 一切都以**该轮自己的 `workspaceBase`** 为根（spec §6.3）：用户改过工作区根目录之后，
 *      历史评测的产物仍留在旧根目录下——按当前设置去找会「产物明明在、抽屉却是空的」。
 *
 * 另有一条本文件刻意**不做**的事（§11 R36）：`runId` 的形状校验（空串 / 以 `.` 开头 / 含 `/`、`\`、`..`）
 * 已经在 `evaluator/run-store.ts` 的 `getRun` / `saveRun` 入口做掉了，这里只经 `getRunView` 直通——
 * 再写第二份的代价是两份判据漂移，而把形状不对的 id 当成 `NOT_FOUND` 会让「id 脏」与「这一轮不存在」
 * 在排障时无法区分。
 */
import { existsSync } from 'node:fs';
import {
  ServiceError,
  type AgentEvent,
  type AgentMessage,
  type EvalRow,
  type EvalRun,
  type RowDiffFile,
  type RowDiffIndex,
  type SubagentRecord,
} from '@aieval/contracts';
import {
  collectDiff,
  createLogger,
  extractDiffFile,
  foldMessages,
  foldSubagents,
  readEvents,
  readEventsAfter,
  readRowRecords,
  rowEventsFile,
  rowMessagesFile,
  truncateDiff,
} from '@aieval/core';
import { getRunView } from './runs';
import { getSettings } from './settings';

const log = createLogger('runs');

/** 在快照里找一行；找不到抛 NOT_FOUND（轮 id 与行 id 都可能来自脏 URL） */
function findRow(run: EvalRun, rowId: string): EvalRow {
  const row = run.rows.find((item) => item.id === rowId);
  if (row === undefined) {
    throw new ServiceError('NOT_FOUND', `该评测里没有这一行（${rowId}）`);
  }
  return row;
}

/** 索引每页默认条数（spec §4 ①：DOM 里始终只有几十行） */
const DIFF_PAGE_DEFAULT = 30;
/** 索引每页上限：手改 URL 也不能把全量拉回来 */
const DIFF_PAGE_MAX = 200;
/** 缓存存活时间。语义是「打开抽屉这半分钟内的快照」，与 useRowDiffIndex 的 revalidateOnFocus:false 同口径 */
const DIFF_CACHE_TTL_MS = 30_000;
/**
 * 缓存**条数**上限。每条的 `collected.text` 可达数 MB（预算上限 256 KB，但那是**裁剪后**的，
 * 缓存里存的是裁剪**前**的原文），若不封顶，一台长期运行的机器上「看过的行」会一直堆在内存里。
 * 超限时按时间戳淘汰最旧的若干条（见 `evictRowDiffCache`）。
 */
const DIFF_CACHE_MAX_ENTRIES = 32;

interface CollectedDiff {
  text: string;
  files: { path: string; insertions: number; deletions: number }[];
  filesChanged: number;
  insertions: number;
  deletions: number;
}

interface CacheEntry {
  collected: CollectedDiff;
  /** truncateDiff 的结果：正文与 droppedFiles 同源，必须一起缓存，否则两次调用可能给出不同的丢弃集 */
  clipped: { text: string; truncated: boolean; droppedFiles: string[] };
  at: number;
}

/**
 * 进程内 diff 缓存，键 = `${runId}/${rowId}`。
 *
 * 为什么必须有：单文件正文接口是**按文件**拉的，几十个文件进视口就是几十次请求，
 * 每次都现场跑一遍 `collectDiff`（一次多次 git 进程，本仓实测进程创建 ≈ 0.5s/次）会慢到不可用。
 * 为什么用 TTL 而不是按 baselineCommit 键控：行在跑的时候工作区内容一直在变，
 * 键控会让同一次评测里翻同一个文件拿到不同结果；TTL 的语义是「打开抽屉这半分钟内的快照」。
 * 只在内存、进程重启即失效，与落盘配置无关。
 */
const diffCache = new Map<string, CacheEntry>();

/** 测试专用：清空缓存，避免用例之间串台 */
export function resetRowDiffCache(): void {
  diffCache.clear();
}

/**
 * 超限时淘汰最旧的条目。为什么按时间戳而不是 LRU：这里没有「命中计数」的语义需求，
 * 「最旧」的近似就是「最不可能再被看的那一行」，而实现只有一行排序。
 */
function evictRowDiffCache(): void {
  if (diffCache.size <= DIFF_CACHE_MAX_ENTRIES) return;
  const oldestFirst = [...diffCache.entries()].sort((a, b) => a[1].at - b[1].at);
  for (const [key] of oldestFirst.slice(0, diffCache.size - DIFF_CACHE_MAX_ENTRIES)) {
    diffCache.delete(key);
  }
}

/**
 * 现场算 diff（带 30 秒缓存）。工作区不存在时抛 CONFLICT，且**不写缓存**。
 *
 * 工作区还不存在（该行没开始跑、或准备阶段就失败了）时抛 CONFLICT，而不是让 git 抛英文原文——
 * 「还没有产出」与「算 diff 出错」是两回事，文案必须能区分。
 *
 * 为什么用 `row.workspacePath` 而不是现算：它是创建这一轮时按**那一轮的根**算出来并落进快照的
 * （`createRun` 与编排层的 `prepareRowWorkspace` 用的是同一个 `core.rowWorkspaceDir`），
 * 拿它定位等于「读快照」，不受「后来改了设置里的 workspaceRoot」影响（Review Focus 2）。
 */
function collectRowDiff(runId: string, rowId: string): CacheEntry {
  const key = `${runId}/${rowId}`;
  const hit = diffCache.get(key);
  if (hit !== undefined && Date.now() - hit.at < DIFF_CACHE_TTL_MS) {
    // 命中要**续期**：否则一次超过 30 秒的抽屉会话会在中途重新跑一遍 collectDiff
    // （正是这个缓存要避免的那笔开销），而且翻页时「索引」与「单文件正文」可能来自两次不同的计算，
    // 出现「索引说 hasBody=true、取正文却 409」这种自相矛盾。
    hit.at = Date.now();
    return hit;
  }

  const run = getRunView(runId);
  const row = findRow(run, rowId);

  if (!existsSync(row.workspacePath)) {
    throw new ServiceError('CONFLICT', `这一行还没有工作区（${row.workspacePath}），没有可看的代码改动`);
  }

  let collected: CollectedDiff;
  try {
    collected = collectDiff(row.workspacePath, row.baselineCommit);
  } catch (error) {
    // 折成含路径的中文原因：git 的英文 stderr 直接透给使用者，无法定位是哪一行出的问题
    throw new ServiceError(
      'INTERNAL',
      `读取代码改动失败（${row.workspacePath}）：${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  const clipped = truncateDiff(collected.text, getSettings().diffBudgetBytes);
  const entry: CacheEntry = { collected, clipped, at: Date.now() };
  diffCache.set(key, entry);
  evictRowDiffCache();
  log.info('按需计算代码改动', {
    runId,
    rowId,
    filesChanged: collected.filesChanged,
    truncated: clipped.truncated,
  });
  return entry;
}

/**
 * 「### 未跟踪文件」段里的路径清单。
 * 段落正文只有路径（`git.ts:581-584` 钉死的格式），故按行读即可；
 * 占位符「（无）」与尾部裁剪标记不是文件名，必须排掉。
 */
function untrackedPaths(clippedText: string): Set<string> {
  const marker = '### 未跟踪文件';
  const at = clippedText.indexOf(marker);
  if (at < 0) return new Set();
  return new Set(
    clippedText
      .slice(at + marker.length)
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && line !== '（无）' && !line.startsWith('>') && !line.startsWith('- ')),
  );
}

/**
 * 文件索引（分页）。
 * `insertions` / `deletions` 取**全局**合计：头部的「共 N 个文件 · +X −Y」要的是全局值，
 * 按页累加会让数字在翻页时跳动。
 */
export function getRowDiffIndex(runId: string, rowId: string, offset = 0, limit = DIFF_PAGE_DEFAULT): RowDiffIndex {
  const { collected, clipped } = collectRowDiff(runId, rowId);

  // 非法入参按默认值处理而不是 400：这是只读的展示接口，宽容降级比报错有用
  const safeOffset = Number.isInteger(offset) && offset > 0 ? offset : 0;
  const safeLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, DIFF_PAGE_MAX) : DIFF_PAGE_DEFAULT;

  const dropped = new Set(clipped.droppedFiles);
  const untracked = untrackedPaths(clipped.text);

  return {
    files: collected.files.slice(safeOffset, safeOffset + safeLimit).map((file) => ({
      path: file.path,
      insertions: file.insertions,
      deletions: file.deletions,
      untracked: untracked.has(file.path),
      hasBody: !dropped.has(file.path),
    })),
    total: collected.filesChanged,
    offset: safeOffset,
    insertions: collected.insertions,
    deletions: collected.deletions,
    noBodyCount: dropped.size,
    truncated: clipped.truncated,
    droppedFiles: clipped.droppedFiles,
  };
}

/**
 * 单文件正文。
 *
 * 两条错误必须分开（spec §6.2）：「这个文件不在本次改动里」与
 * 「它在，但正文被预算丢了」在排障时是两回事——合成一条 NOT_FOUND 会让人以为文件没改过。
 */
export function getRowDiffFile(runId: string, rowId: string, path: string): RowDiffFile {
  const { collected, clipped } = collectRowDiff(runId, rowId);

  const meta = collected.files.find((file) => file.path === path);
  if (meta === undefined) {
    throw new ServiceError('NOT_FOUND', `本次改动里没有这个文件（${path}）`);
  }
  if (clipped.droppedFiles.includes(path)) {
    throw new ServiceError(
      'CONFLICT',
      `该文件超出体积上限，未包含在本轮评分输入中（${path}）：调大「设置 → 评分配置 → diff 体积上限」后重开抽屉`,
    );
  }

  const patch = extractDiffFile(clipped.text, path);
  if (patch === undefined) {
    // 索引里有、正文段里却没有：切分口径与归一逻辑漂移了。不静默返回空 diff
    throw new ServiceError('INTERNAL', `文件在索引里但取不到正文段（${path}）：diff 切分与路径归一可能漂移了`);
  }

  return {
    path,
    patch,
    insertions: meta.insertions,
    deletions: meta.deletions,
    // 二进制改动的段落里没有 hunk（`git` 给的是「Binary files ... differ」），无可渲染的文本
    binary: !/^@@ /m.test(patch),
  };
}

/**
 * 该行的**消息与子任务行**（spec v3 §2，折叠后的最终视图）。
 *
 * 与 `getRowLog` 同一处置、**不排序**：`readRowRecords` 逐行读的是一个只追加的文件，
 * 而 `foldMessages` / `foldSubagents` 按**首次出现顺序**输出——那正是「这条逻辑消息第一次被说到」
 * 的顺序，也正是消费方该渲染的顺序。在这里再排一次只会多一个会漂移的判据。
 *
 * 文件不存在时返回两个空数组（该行还没开始跑）：**不是错误**，界面上显示「还没有消息」。
 */
export function getRowRecords(runId: string, rowId: string): { messages: AgentMessage[]; subagents: SubagentRecord[] } {
  const run = getRunView(runId);
  const row = findRow(run, rowId);
  const file = rowMessagesFile(run.workspaceBase, run.id, row.id);

  try {
    const { messages, subagents } = readRowRecords(file);
    return { messages: foldMessages(messages), subagents: foldSubagents(subagents) };
  } catch (error) {
    // 坏行 / 权限 / 编码问题都可能在这里抛：一律折成含路径的中文原因（与 getRowLog 同一条理由）
    throw new ServiceError(
      'INTERNAL',
      `读取消息记录失败（${file}）：${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

/**
 * 执行日志：给了 `afterSeq` 就只取 `seq` 更大的部分（抽屉首帧与 SSE 续订共用同一个出口）。
 * 文件不存在时 `readEvents` 返回 `[]`（该行还没开始跑），这不是错误。
 *
 * 排序与 seq 的来源（派发稿的高危口径）：本函数**只读盘、不排序、也不另造 seq**。
 * `readEvents` / `readEventsAfter` 逐行读的是一个**只追加**的文件，而 seq 由 `core.appendEvent`
 * 按「文件里已用的最大 seq + 1」分配（§11 R24），因此文件顺序**恒等于** seq 升序——
 * 这正是 SSE 按 `Last-Event-ID` 续订与前端按 seq 去重的前提，在 api 层再排一次只会多一个会漂移的判据。
 */
export function getRowLog(runId: string, rowId: string, afterSeq?: number): AgentEvent[] {
  const run = getRunView(runId);
  const row = findRow(run, rowId);
  const file = rowEventsFile(run.workspaceBase, run.id, row.id);

  try {
    return afterSeq === undefined || afterSeq <= 0 ? readEvents(file) : readEventsAfter(file, afterSeq);
  } catch (error) {
    // 坏行 / 权限 / 编码问题都可能在这里抛：一律折成含路径的中文原因，
    // 否则路由层只会给出「服务端内部错误」，连是哪个文件坏了都看不出来
    throw new ServiceError(
      'INTERNAL',
      `读取执行日志失败（${file}）：${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}
