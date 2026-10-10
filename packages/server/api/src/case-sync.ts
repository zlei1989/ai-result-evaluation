/**
 * 用例同步服务：把 `<casesRoot>` 里的用例变更**逐文件提交**、推到远端；冲突交给智能体裁定。
 *
 * 为什么住在 api 层：它要起智能体（`@aieval/agents`）与解析评分路由（`@aieval/evaluator`），
 * 而 core 只依赖 contracts（起不了智能体）、evaluator 又不能反向依赖 api。git 原语在 core 的
 * `case-git.ts`，这里只做编排、队列与状态。
 *
 * 七条口径：
 *   1. **不阻塞保存**：用例落盘的 HTTP 响应立刻返回，同步在后台跑（`enqueueCaseSync`）；
 *      人工点「提交 / 拉取」是**动作**，那条路径把结果等回来（按钮的 loading 与结果都要真实）。
 *   2. **串行 + 合并**：同一时刻只有一轮同步在跑；跑动期间的多次变更合并成**一轮**收尾同步。
 *      两个同步同时 commit/push 只会自己跟自己冲突。
 *   3. **逐文件提交**：N 个变更文件产出 N 个提交，一个提交只含一个用例文件（core 的 `commitFile`）。
 *      **提交动作由本模块执行，智能体只写提交信息**——这是与「让智能体自己 commit」的刻意分歧：
 *      逐文件是**不变量**，而模型自主提交只是「大概率照做」（它还可能顺手 `git add -A`、
 *      把无关文件卷进历史，甚至改写历史）。智能体该做的两件事都还在：每次变更都起它（用户口径），
 *      它总结的内容也**确实进了提交记录**。
 *   4. **冲突交给智能体裁定**：`fetch` 发现分叉才起智能体（它在 cwd 里做 merge、解决冲突），
 *      回来之后本模块独立校验「工作区干净、没有半途的合并状态」，不成立就中止并报错。
 *   5. **绝不 force push**（core 的 `pushRemote` 里根本没有 force 变体），失败保留本地提交、
 *      把原因写进状态，下一次变更自然再试。
 *   6. **只提交用例文件**：`<casesRoot>` 下的其他变更（README、笔记）永不进提交，计数要让用户看见。
 *   7. **状态只活在内存**：不做持久化队列、不做启动补偿（用户口径：改用设置页的「提交」按钮手动补）。
 *      磁盘上的 git 事实才是真源，重启后这份快照归零不影响正确性。
 *
 * 缺智能体配置时**整块同步不跑**（用户口径 Q19(i)）：状态里写明「未配置评分配置，用例变更未提交」，
 * 而不是悄悄用回退文案把文件提交掉——那样用户会以为同步链路是通的。
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  ServiceError,
  type AgentKind,
  type CaseSyncAction,
  type CaseSyncStatus,
} from '@aieval/contracts';
import {
  abortPendingGitOperation,
  aheadBehind,
  commitFile,
  createLogger,
  currentBranch,
  fastForwardToUpstream,
  fetchRemote,
  getCasesRoot,
  getConfigDir,
  headCommit,
  isRepoRoot,
  pathStatusCode,
  pushRemote,
  readCase,
  readWorktreeState,
  remoteNames,
  upstreamRef,
} from '@aieval/core';
import { getProvider } from '@aieval/agents';
import { requireJudgeAgent, resolveJudgeEffort, resolveJudgeRoute } from '@aieval/evaluator';
import { getSettings } from './settings';

const log = createLogger('case-sync');

/**
 * 自动同步的防抖窗口：连续保存（改标题 → 改题面 → 换评分表）合并成一轮。
 * 1 秒是「人手操作的间隔」与「不该让变更迟迟不进 git」之间的折中。
 */
const DEBOUNCE_MS = 1_000;

/**
 * 单次智能体运行的硬上限。`AgentRunInput` 没有 `timeoutMs`（唯一取消手段是 `signal`，
 * 见 agents 的 types.ts），故这里用定时器 + `AbortController` 在**调用方**收口——
 * 不去改 `run` 的签名（扩 `run` 前要先澄清，而这条不需要扩）。
 * 10 分钟足够一次提交信息生成与一次冲突裁定；超时按失败处理（本地变更保留，下次再试）。
 */
const SYNC_AGENT_TIMEOUT_MS = 10 * 60_000;

/** 状态接口探测远端时的 fetch 上限：页面挂载不能等一次十分钟的网络往返 */
const STATUS_FETCH_TIMEOUT_MS = 15_000;

/**
 * 状态接口探测远端结果的缓存时长（30 秒）。
 * 为什么需要它：`GET /api/cases/sync-status` 要回答「远端有没有新提交」，唯一诚实的答案是
 * `git fetch` 之后再看——每次页面挂载都打一次远端既慢又吵，故这个窗口内的重复探测复用上一次结果。
 */
const STATUS_FETCH_TTL_MS = 30_000;

/** 提交信息长度上限：git 的一行提交信息控制在几十字符最易读，模型偶尔会写一整段 */
const COMMIT_MESSAGE_MAX = 100;

/** 推送退避重试次数与步长（瞬时不可达是最常见的那类失败） */
const PUSH_ATTEMPTS = 3;
const PUSH_RETRY_STEP_MS = 200;

/** 触发来源：自动（用例变更）/ 人工提交 / 人工拉取。人工动作的语义更严（见 `performSync`）。 */
type RunReason = 'auto' | 'commit' | 'pull';

/** 同步用的智能体：路由来自「评分配置」（用户口径 Q19：不新增配置面） */
interface SyncAgent {
  kind: AgentKind;
  route: ReturnType<typeof resolveJudgeRoute>;
  effort: string | undefined;
}

/** 智能体解析结果：失败带上**可直接展示的原因**，两条调用路径（写信息 / 裁定合并）各处置一次 */
type SyncAgentResolution = { ok: true; agent: SyncAgent } | { ok: false; reason: string };

/** 进程内的同步状态与队列（唯一真源，测试用 `resetCaseSyncForTesting` 清空） */
interface SyncRuntime {
  /** 状态接口读的「是否正在跑」 */
  running: boolean;
  /** 排空循环是否活着（调度判据：同一时刻只有一轮） */
  draining: boolean;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastCommit: string | null;
  lastError: string | null;
  /** 排队中的下一轮（`null` = 没有待跑）；人工动作会**覆盖**自动触发 */
  pendingReason: RunReason | null;
  timer: NodeJS.Timeout | null;
  /** 等「最后一轮跑完」的调用方（人工动作的 Promise） */
  waiters: { resolve: () => void; reject: (error: unknown) => void }[];
}

function idleRuntime(): SyncRuntime {
  return {
    running: false,
    draining: false,
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastCommit: null,
    lastError: null,
    pendingReason: null,
    timer: null,
    waiters: [],
  };
}

let runtime: SyncRuntime = idleRuntime();

/** 远端探测缓存（见 `STATUS_FETCH_TTL_MS`） */
let fetchCache: { root: string; at: number } | null = null;

/** 清空内存状态与定时器（测试用：模块级可变状态必须能在用例之间归零） */
export function resetCaseSyncForTesting(): void {
  if (runtime.timer !== null) clearTimeout(runtime.timer);
  runtime = idleRuntime();
  fetchCache = null;
}

/**
 * 用例变更之后排队一次同步（**不等它**）。
 * 已经在跑的时候只置一个「收尾再跑一轮」的标记：这就是「后来的排队，但要合并」——
 * 合并发生在**这一轮**，而不是把变更插进正在跑的那一轮（它已经在读文件清单了）。
 * 关掉自动提交时调用方不会走到这里（见 `api/cases.ts` 的 `scheduleSync`）。
 */
export function enqueueCaseSync(reason: string): void {
  queue('auto', reason);
}

/**
 * 人工动作：提交 / 拉取。返回的是**跑完之后**的状态快照（按钮的 loading 与结果都要真实）。
 * 语义差别见 `performSync`：拉取要求用例文件已经没有未提交变更。
 */
export function runCaseSync(action: CaseSyncAction): Promise<CaseSyncStatus> {
  return new Promise<CaseSyncStatus>((resolve, reject) => {
    runtime.waiters.push({
      resolve: () => {
        try {
          resolve(getCaseSyncStatus());
        } catch (error) {
          reject(error);
        }
      },
      reject: (error) => reject(error),
    });
    // 先入等待队列再排队：两者之间没有 await，故「队列空了却还有人在等」不可能出现
    queue(action, `人工${action === 'commit' ? '提交' : '拉取'}`);
  });
}

/** 排队 + 启动排空循环（唯一入队口，`pendingReason` 的合并规则也只在这里） */
function queue(reason: RunReason, why: string): void {
  // 人工动作压过自动触发：拉取比「顺手提交一次」更严，不能让 auto 把它顶掉
  runtime.pendingReason = reason === 'auto' ? runtime.pendingReason ?? 'auto' : reason;
  if (runtime.timer !== null) {
    clearTimeout(runtime.timer);
    runtime.timer = null;
  }
  if (runtime.draining) return;
  // 自动触发要防抖（连续保存合并成一轮）；人工动作立即跑，点一次就该立刻有反应
  if (reason === 'auto') {
    runtime.timer = setTimeout(() => {
      runtime.timer = null;
      startDraining(why);
    }, DEBOUNCE_MS);
    return;
  }
  startDraining(why);
}

/** 启动排空循环；`draining` 是「同一时刻只有一轮同步」的唯一判据 */
function startDraining(why: string): void {
  if (runtime.draining) return;
  runtime.draining = true;
  log.debug('开始同步用例仓库', { why });
  void drain()
    .catch((error: unknown) => {
      // 排空循环自己不抛（每轮失败都记进状态）；这一层是纵深防御，防未处理的 rejection 打崩进程
      log.error('用例同步循环异常退出', { error });
    })
    .finally(() => {
      runtime.draining = false;
    });
}

/**
 * 排空队列：跑一轮 → 还有排队就再跑一轮（合并）→ 直到没有待跑，再一次性答复所有等待者。
 * 等待者只在**最后一轮**结束后被答复：人工点「拉取」时若正好有一轮 auto 在跑，
 * 它等到的必须是包含自己那次拉取的结果，而不是别人那一轮的结果。
 */
async function drain(): Promise<void> {
  let failure: unknown = null;
  for (;;) {
    const reason = runtime.pendingReason;
    if (reason === null) break;
    runtime.pendingReason = null;
    failure = await runOnce(reason);
  }
  const waiters = runtime.waiters;
  runtime.waiters = [];
  for (const waiter of waiters) {
    if (failure === null) waiter.resolve();
    else waiter.reject(failure);
  }
}

/** 跑一轮同步：计时、记状态、把失败折成可展示的中文原因（**不抛**，由状态承载） */
async function runOnce(reason: RunReason): Promise<unknown> {
  runtime.running = true;
  runtime.lastAttemptAt = new Date().toISOString();
  try {
    const root = getCasesRoot();
    const skipped = await performSync(root, reason);
    if (!skipped) {
      runtime.lastSuccessAt = new Date().toISOString();
      runtime.lastCommit = headCommit(root);
      log.info('用例同步完成', { reason, commit: runtime.lastCommit });
    }
    runtime.lastError = null;
    return null;
  } catch (error) {
    runtime.lastError = messageOf(error);
    log.error('用例同步失败', { reason, casesRoot: getCasesRoot(), error });
    return error;
  } finally {
    runtime.running = false;
  }
}

/**
 * 一轮同步的全部动作。返回 true = 这轮**什么都没做**（没到该提交的时机），不算一次成功。
 *
 * 顺序有意如此：
 *   1. 不是 git 仓库 → 直接回来（这不是失败，用户还没把用例目录接进 git，状态接口会标明）；
 *   2. 智能体配置不全 → 抛中文 CONFLICT（口径见文件头）；
 *   3. 先逐文件提交（拉取时**要求**已经没有未提交的用例文件——拉取的语义是「跟远端对齐」，
 *      顺手替你提交会和「自动提交」开关打架）；
 *   4. 提交完才 fetch（没有本地提交要推、也没有远端要合的时候不联网）；
 *   5. 落后就先快进、分叉才请智能体裁定合并（绝不 force push）;
 *   6. 有本地领先提交才 push。
 */
async function performSync(root: string, reason: RunReason): Promise<boolean> {
  if (!isRepoRoot(root)) return true;

  const agent = resolveSyncAgent();
  if (!agent.ok) {
    throw new ServiceError('CONFLICT', `用例变更未提交：同步需要一个智能体，${agent.reason}`);
  }

  const before = headCommit(root);
  const { caseFiles } = readWorktreeState(root);
  if (reason === 'pull' && caseFiles.length > 0) {
    throw new ServiceError(
      'CONFLICT',
      `有 ${caseFiles.length} 个未提交的用例变更，请先点「提交」再拉取（拉取要在一个干净的工作区上进行）`,
      { context: { root, pending: caseFiles.length } },
    );
  }
  const committed = caseFiles.length === 0 ? 0 : await commitCaseFiles(root, caseFiles, agent.agent);
  const hasUnpushed = headCommit(root) !== before || committed > 0;

  if (remoteNames(root).length === 0) {
    // 没有远端：本地提交是有效的（历史里留下了痕迹），但没有任何可推的目标——如实记一条 WARN
    if (committed > 0) log.warn('用例仓库没有配置远端，变更只提交到本地', { root, committed });
    return committed === 0;
  }
  // 没有本地领先、也不是拉取：什么都不用做（远端有没有新提交由状态接口的探测回答）
  if (!hasUnpushed && reason !== 'pull') return committed === 0;

  fetchRemote(root);
  fetchCache = { root, at: Date.now() };
  const divergence = aheadBehind(root);
  if (divergence !== null && divergence.behind > 0) {
    if (divergence.ahead === 0) {
      recordAlignment(root, '快进');
      fastForwardToUpstream(root);
    } else {
      recordAlignment(root, '分叉，交给智能体裁定');
      await resolveDivergenceWithAgent(root, agent.agent);
    }
  }
  const afterMerge = aheadBehind(root);
  if (afterMerge !== null && afterMerge.ahead === 0 && committed === 0) return true;
  await pushWithRetry(root);
  return false;
}

/** 对齐远端的处置记录（INFO：这是「远端被别人推过」的唯一线索） */
function recordAlignment(root: string, action: string): void {
  log.info('远端有新提交，先对齐再推送', { root, action, branch: safeBranch(root) });
}

/** 当前分支名（日志用：不是仓库 / detached 时不该在这里抛） */
function safeBranch(root: string): string | null {
  try {
    return currentBranch(root);
  } catch {
    return null;
  }
}

/**
 * 逐文件提交：先请智能体为每个文件写一行提交信息，再由本模块**一个一个**提交。
 * 智能体失败 / 输出不可解析 / 漏了某个文件，都不影响结果——缺的那条用确定性文案补齐
 * （`新增用例「标题」` 这类），这也是「不丢变更」的底线。
 */
async function commitCaseFiles(root: string, files: string[], agent: SyncAgent): Promise<number> {
  const messages = await requestCommitMessages(root, files, agent);
  let committed = 0;
  for (const file of files) {
    // 智能体没给出这一条（或输出了不在清单里的文件）时用回退文案，不让任何文件卡在未提交状态
    const message = messages.get(file) ?? fallbackCommitMessage(root, file);
    try {
      if (commitFile(root, file, message)) committed += 1;
    } catch (error) {
      // 单个文件提交失败（被 .gitignore 忽略、index.lock 被占）不能无声无息：
      // 抛出后由 `runOnce` 折成状态里的中文原因，用户能看到是哪个文件没进历史
      throw new ServiceError('INTERNAL', `用例文件提交失败：${file}（${messageOf(error)}）`, {
        cause: error,
        context: { file },
      });
    }
  }
  return committed;
}

/**
 * 请同步智能体为每个文件写一行提交信息。
 *
 * 它**只读不写**：跑在 `<casesRoot>` 里，用 `git status` / `git diff` 看清每个文件这次改了什么，
 * 再把结果作为 JSON 答复交回来（提交由本模块执行，理由见文件头口径 3）。
 * 用 `outputSchema` 是「我想要」而不是「必须有」：不支持结构化输出的适配器会降级，
 * 那时答复仍是 JSON 文本，故解析这一侧对 ```json 围栏与前后杂文都要能忍。
 *
 * 任何失败（适配器报错、超时、答复不可解析）都只影响**提交信息**，不影响提交本身：
 * 返回空表即走回退文案。
 */
async function requestCommitMessages(root: string, files: string[], agent: SyncAgent): Promise<Map<string, string>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SYNC_AGENT_TIMEOUT_MS);
  try {
    const result = await getProvider(agent.kind).run({
      cwd: root,
      configHome: syncAgentHome(),
      // 它要在仓库里跑 `git status` / `git diff` 看变更，故给可写档；提示词里明写「只读、不要改文件」
      permission: 'full',
      prompt: buildCommitMessagePrompt(files),
      route: agent.route,
      signal: controller.signal,
      ...(agent.effort === undefined ? {} : { effort: agent.effort }),
      outputSchema: COMMIT_MESSAGES_SCHEMA,
      onEvent: (event) => {
        log.debug('同步智能体事件', { type: event.type });
      },
    });
    if (!result.ok) {
      log.warn('同步智能体运行未成功，提交信息用回退文案', { exitReason: result.exitReason });
      return new Map();
    }
    return parseCommitMessages(result.finalText, files);
  } catch (error) {
    log.warn('同步智能体调用抛错，提交信息用回退文案', { reason: messageOf(error) });
    return new Map();
  } finally {
    clearTimeout(timer);
  }
}

/** 同步智能体的独立配置目录：**刻意放在用例目录之外**，否则它会作为未跟踪文件污染 git status */
function syncAgentHome(): string {
  const home = join(getConfigDir(), 'case-sync', '.agenthome');
  mkdirSync(home, { recursive: true });
  return home;
}

/** 提交信息生成的输出契约（形状跟着**答复**走，与提交动作无关） */
const COMMIT_MESSAGES_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['commits'],
  additionalProperties: false,
  properties: {
    commits: {
      type: 'array',
      items: {
        type: 'object',
        required: ['file', 'message'],
        additionalProperties: false,
        properties: {
          file: { type: 'string' },
          message: { type: 'string' },
        },
      },
    },
  },
};

/** 提交信息生成的提示词：只交代**看什么、回什么**，不复述仓库规则（那会挤掉真正的上下文） */
function buildCommitMessagePrompt(files: string[]): string {
  return [
    '你在一个 git 仓库里，仓库根下的每个 `<用例 id>.json` 是一个评测用例（标题、题面、评分标准项）。',
    '用 `git status` 与 `git diff` 看清下面这些文件**这一次**改了什么，然后为每个文件写一行提交信息。',
    '',
    '要写信息的文件：',
    ...files.map((file) => `- ${file}`),
    '',
    '写作要求：',
    '1. 一行、简洁、专业、面向人阅读，说清这个文件这次改了什么（例如「补充缓存失效的评分标准项」）；',
    '2. 不要任何前缀（不要 `feat:`、`[aieval]` 这类标记），不要正文、不要署名、不要换行；',
    '3. 每个文件恰好一条，`file` 必须与上面列出的路径逐字一致；',
    '4. **只读**：不要修改、新增、删除任何文件，也不要执行 git 的写命令（add / commit / push 都不要）；',
    '5. 最终答复只输出下面这个 JSON，不要别的内容：',
    '{"commits":[{"file":"<用例 id>.json","message":"<一行提交信息>"}]}',
  ].join('\n');
}

/**
 * 解析智能体答复里的提交信息表。
 * 宽容三件事（都是实测会遇到的形状）：```json 围栏、JSON 前后的解释性文字、以及多出来的字段。
 * 只保留**本次要提交的文件**：模型凭空多报的路径绝不能进提交（那会让「只提交用例文件」失守）。
 */
function parseCommitMessages(finalText: string | null, files: string[]): Map<string, string> {
  const result = new Map<string, string>();
  if (finalText === null || finalText.trim() === '') return result;

  const start = finalText.indexOf('{');
  const end = finalText.lastIndexOf('}');
  if (start < 0 || end <= start) {
    log.warn('同步智能体的答复里找不到 JSON，提交信息用回退文案');
    return result;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(finalText.slice(start, end + 1));
  } catch (error) {
    log.warn('同步智能体的答复不是合法 JSON，提交信息用回退文案', { reason: messageOf(error) });
    return result;
  }

  const commits = (parsed as { commits?: unknown }).commits;
  if (!Array.isArray(commits)) return result;
  const allowed = new Set(files);
  for (const item of commits) {
    const record = item as { file?: unknown; message?: unknown };
    if (typeof record.file !== 'string' || typeof record.message !== 'string') continue;
    if (!allowed.has(record.file)) continue;
    const message = record.message.replace(/\s+/g, ' ').trim().slice(0, COMMIT_MESSAGE_MAX);
    if (message === '') continue;
    result.set(record.file, message);
  }
  return result;
}

/**
 * 回退文案：由 git 状态与用例标题**确定性**生成，不看模型脸色。
 * 状态码取自 `git status --porcelain` 的前两列：含 `A`/`?` = 新增、含 `D` = 删除、其余 = 更新。
 * 标题从工作区文件里读（已删除的文件读不到，退回用例 id）。
 */
function fallbackCommitMessage(root: string, file: string): string {
  const code = safeStatusCode(root, file);
  const action = code === null ? '更新' : code.includes('D') ? '删除' : code.includes('A') || code.includes('?') ? '新增' : '更新';
  const title = readTitleForMessage(file);
  return title === null ? `${action}用例 ${file.replace(/\.json$/, '')}` : `${action}用例「${title}」`;
}

/** 状态码读不出来时按「更新」处理（最保守的那一种说法） */
function safeStatusCode(root: string, file: string): string | null {
  try {
    return pathStatusCode(root, file);
  } catch {
    return null;
  }
}

/** 用例标题（文件读不出来时——例如已删除——返回 null，回退文案改用用例 id） */
function readTitleForMessage(file: string): string | null {
  try {
    // 走存储层读**工作区里的当前内容**：默认路径就是 casesRoot，正是这次要提交的那一份
    const title = readCase(file.replace(/\.json$/, ''))?.title;
    return typeof title === 'string' && title.trim() !== '' ? title.trim().slice(0, 40) : null;
  } catch {
    return null;
  }
}

/**
 * 智能体裁定分叉：它在 cwd 里 fetch 之后合并（或变基），把冲突解决干净。
 * 回来之后本模块**必须**独立校验：工作区里没有未提交的用例文件、也不再落后于远端——
 * 「模型说它解决了」不是证据，`git status` 才是。校验不过就中止这次合并并把原因抛出去（本地提交保留）。
 */
async function resolveDivergenceWithAgent(root: string, agent: SyncAgent): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SYNC_AGENT_TIMEOUT_MS);
  try {
    const result = await getProvider(agent.kind).run({
      cwd: root,
      configHome: syncAgentHome(),
      permission: 'full',
      prompt: buildMergePrompt(),
      route: agent.route,
      signal: controller.signal,
      ...(agent.effort === undefined ? {} : { effort: agent.effort }),
      onEvent: (event) => {
        log.debug('合并智能体事件', { type: event.type });
      },
    });
    if (!result.ok) {
      abortPendingGitOperation(root);
      throw new ServiceError('CONFLICT', `用例仓库与远端分叉，合并智能体运行未成功（${result.exitReason}），未推送`);
    }
  } catch (error) {
    // 智能体抛错 / 超时 / 运行未成功：把半途的合并收干净，本地提交保留，下一次变更会再试
    abortPendingGitOperation(root);
    throw error;
  } finally {
    clearTimeout(timer);
  }

  // 独立校验：工作区里不该再有用例文件未提交，也不该再落后于远端
  const left = readWorktreeState(root).caseFiles;
  if (left.length > 0) {
    abortPendingGitOperation(root);
    throw new ServiceError('CONFLICT', `合并智能体结束后仍有 ${left.length} 个用例文件未提交，已中止本次合并`);
  }
  const divergence = aheadBehind(root);
  if (divergence !== null && divergence.behind > 0) {
    abortPendingGitOperation(root);
    throw new ServiceError('CONFLICT', '合并智能体结束后仍未对齐远端，已中止本次合并');
  }
  log.info('分叉已由智能体裁定合并', { root, branch: safeBranch(root) });
}

/** 合并提示词：交代边界（不许 force push、不许改历史），其余交给它 */
function buildMergePrompt(): string {
  return [
    '你在一台机器的用例仓库里（工作目录），本地与远端已经分叉：远端有别人的新提交。',
    '',
    '任务：把远端更新合进来并解决冲突，让本地最终包含双方的改动。',
    '1. 先 `git fetch`，再用 `git merge @{u}`（或 `git rebase @{u}`）对齐；',
    '2. 冲突时按内容判断：用例文件是同一份 JSON 的两侧修改，尽量把双方改动都保留下来；',
    '3. **绝不允许** force push、`rebase -i`、`filter-branch` 之类改写历史的做法；',
    '4. 结束时工作区必须是干净的（没有未完成的合并、没有未提交的改动）；',
    '5. 不要 push，也不要修改任何文件内容（冲突文件除外）；',
    '6. 完事后直接结束，不要输出解释。',
  ].join('\n');
}

/**
 * 推送：退避重试 3 次。
 * 为什么要重试：push 失败有一类纯瞬时成因（远端瞬时不可达、HTTP/2 连接被掐），
 * 而那正是「等下一次变更」要等很久的场景；重试不改变语义（本地提交一直在）。
 * 仍然失败就把原文写进状态：用户能看到是「没有权限」还是「远端拒绝」。
 */
async function pushWithRetry(root: string): Promise<void> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= PUSH_ATTEMPTS; attempt += 1) {
    try {
      pushRemote(root);
      return;
    } catch (error) {
      lastError = error;
      log.warn('推送用例变更失败，准备重试', { attempt, root, reason: messageOf(error) });
      await delay(attempt * PUSH_RETRY_STEP_MS);
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new ServiceError('INTERNAL', `推送用例变更失败：${messageOf(lastError)}`);
}

/**
 * 状态快照：状态接口与两个动作接口共用。
 * **绝不抛**：设置页那一格要能渲染——仓库坏了、路径没了、离线了都只是「现在为什么同步不了」的原因，
 * 而不是一次 500。故这里每一段都单独兜住并把原因折进 `blockedReason`。
 *
 * `hasRemote === false` **不写进 blockedReason**：没有远端挡不住本地提交，它是另一格事实，
 * 由界面自己说（「变更只提交到本地」）。
 */
export function getCaseSyncStatus(): CaseSyncStatus {
  const base: CaseSyncStatus = {
    isRepo: false,
    hasRemote: false,
    blockedReason: null,
    running: runtime.running,
    lastAttemptAt: runtime.lastAttemptAt,
    lastSuccessAt: runtime.lastSuccessAt,
    lastCommit: runtime.lastCommit,
    lastError: runtime.lastError,
    pendingCount: 0,
    ignoredCount: 0,
    remoteAhead: null,
    localAhead: 0,
  };

  let root: string;
  try {
    root = getCasesRoot();
  } catch (error) {
    return { ...base, blockedReason: `读不出用例目录：${messageOf(error)}` };
  }
  if (!isRepoRoot(root)) {
    return { ...base, blockedReason: `${root} 不是 git 仓库：用例变更不会提交（在该目录 git init 并配置远端后即可启用）` };
  }

  const status: CaseSyncStatus = { ...base, isRepo: true };
  try {
    const { caseFiles, ignoredCount } = readWorktreeState(root);
    status.pendingCount = caseFiles.length;
    status.ignoredCount = ignoredCount;
  } catch (error) {
    return { ...status, blockedReason: `读不出用例仓库状态：${messageOf(error)}` };
  }

  status.hasRemote = remoteNames(root).length > 0;
  if (status.hasRemote) {
    const probe = probeRemoteState(root);
    status.remoteAhead = probe.remoteAhead;
    status.localAhead = probe.localAhead;
  }

  if (!resolveSyncAgent().ok) {
    status.blockedReason = '未配置「设置 → 评分配置」里的默认评分模型与默认评分智能体：同步需要一个智能体来写提交信息';
  }
  return status;
}

/**
 * 解析同步智能体：路由与智能体类型都取自设置页「评分配置」（`resolveJudgeRoute` + `requireJudgeAgent`），
 * 思考强度取 `defaultJudge.effort`——**整块同步不新增配置面**是用户口径 Q19(a)。
 * 两者任一缺失就把原因折成中文，由调用方决定是「跳过自动同步」还是「抛给用户看」。
 */
function resolveSyncAgent(): SyncAgentResolution {
  try {
    const route = resolveJudgeRoute();
    const kind = requireJudgeAgent({ defaultJudgeAgent: getSettings().defaultJudgeAgent, route });
    return { ok: true, agent: { kind, route, effort: resolveJudgeEffort() } };
  } catch (error) {
    return { ok: false, reason: messageOf(error) };
  }
}

/**
 * 探测远端状态：`remoteAhead`（远端领先数）/ `localAhead`（本地未推送数）。
 * `remoteAhead` 用 `null` 表示**没探到**而不是 0（界面据此仍显示「拉取」按钮，点了会看到原因）。
 */
function probeRemoteState(root: string): { remoteAhead: number | null; localAhead: number } {
  if (upstreamRef(root) === null) return { remoteAhead: null, localAhead: 0 };

  const fresh = fetchCache !== null && fetchCache.root === root && Date.now() - fetchCache.at < STATUS_FETCH_TTL_MS;
  if (!fresh) {
    try {
      fetchRemote(root, { timeoutMs: STATUS_FETCH_TIMEOUT_MS });
      fetchCache = { root, at: Date.now() };
    } catch (error) {
      // 探测失败不改缓存时间戳：下一次读状态会再试一次，而不是把这个失败也缓存 30 秒
      log.warn('探测远端失败（状态里的远端领先数未知）', { root, reason: messageOf(error) });
    }
  }
  try {
    const divergence = aheadBehind(root);
    return { remoteAhead: divergence?.behind ?? null, localAhead: divergence?.ahead ?? 0 };
  } catch (error) {
    log.warn('统计领先/落后提交失败', { root, reason: messageOf(error) });
    return { remoteAhead: null, localAhead: 0 };
  }
}

/** 取错误的人类可读原因（error 不一定是 Error） */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
