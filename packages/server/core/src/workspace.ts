/**
 * 工作区引擎：目录结构 + 候选工作区准备。
 * 目录布局是**硬约定**，每一层都有消费者：
 *   {workspaceRoot}/cases/{caseId}/cache/   用例级缓存仓库（首次评测克隆一次，之后复制）
 *   {workspaceRoot}/{runId}/run.json        运行快照
 *   {workspaceRoot}/{runId}/candidates/{candidateId}/workspace   该候选工作副本（分支 test/{candidateId}）
 *   {workspaceRoot}/{runId}/candidates/{candidateId}/.agenthome  该候选独立配置目录（CLAUDE_CONFIG_DIR 等）
 *   {workspaceRoot}/{runId}/candidates/{candidateId}/.judgehome  该候选**评分智能体**的独立配置目录（智能体评分通路）
 *   {workspaceRoot}/{runId}/candidates/{candidateId}/events.jsonl 该候选事件日志（唯一真相源）
 *   {workspaceRoot}/{runId}/candidates/{candidateId}/attachments/{messageId}/  人随人工消息上传的附件
 * 三个必须成立的口径：
 *   1. 事件日志与 `run.json` **不在** workspace 里：agent 可以在 workspace 内随意建删文件，
 *      把证据放进去等于把证据交给被测对象；附件同理在 workspace **之外**——它不参与 `git diff`
 *      与评分面，也与仓库来源（local / remote / 无来源）无关；
 *   2. 重跑同一行必须**先清掉上一轮的工作副本、两个独立配置目录与附件根**
 *      （workspace + .agenthome + .judgehome + attachments）：
 *      留下上一轮的工作区，第二个候选就是在第一个候选的改动之上继续写，分数无意义；
 *      留下上一轮的附件，模型会读到这一轮根本没人上传过的材料；
 *   3. 但**绝不能连 `events.jsonl` 一起清**：清空日志的唯一所有者是 `resetEvents`
 *      ，而编排层的顺序是「先 `resetEvents` → 发 `preparing`（seq 1，这一步就建出了候选目录）
 *      → 再 `prepareCandidateWorkspace`」。这里整目录删掉，刚写下的 `preparing` 就没了，
 *      下一次追加又从 seq 1 开始；界面的 `useCandidateStream` 按 seq 去重，于是清空后的第一条状态事件
 *      被静默吞掉——正是这条保证存在的理由，而且每一轮都会发生。
 */
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ServiceError } from '@aieval/contracts';
import { assertInjectMessageId } from './attachment-store';
import { assertCaseId } from './case-store';
import { createLogger } from './logger';
import { removeTreeWithRetry } from './remove-tree';
import { checkoutCandidate, copyWorkspace, ensureCaseCache, initEmptySourceRepository } from './git';

const log = createLogger('workspace');

/**
 * 用例级缓存仓库目录。
 * **拼路径前先过 id 形状校验**：这个函数的历史调用方里有直接把路由参数传进来的
 * （`api/cases.ts` 删除用例后清缓存），而 `join` 不拦 `..`——一个越界的 id 会让紧接着的
 * `rmSync(recursive)` 删到工作区之外。判据与用例文件名同源（`assertCaseId`）。
 */
export function caseCacheDir(workspaceRoot: string, caseId: string): string {
  return join(workspaceRoot, 'cases', assertCaseId(caseId), 'cache');
}

/** 一轮评测的产物目录（`run.json` 与 `candidates/` 都在它下面） */
export function runDir(workspaceRoot: string, runId: string): string {
  return join(workspaceRoot, runId);
}

/** 单个候选的产物目录（工作区、独立配置目录与事件日志都在它下面） */
export function candidateDir(workspaceRoot: string, runId: string, candidateId: string): string {
  const dir = join(runDir(workspaceRoot, runId), 'candidates', candidateId);
  if (existsSync(dir)) return dir;
  // 旧评测的候选目录在 `rows/` 下：历史产物留在原地，读日志、看 diff 与重跑都沿用旧目录。
  // 只在这一轮的该候选确实没有新目录时才回退，新候选因此不会被写进旧布局。
  const legacy = join(runDir(workspaceRoot, runId), 'rows', candidateId);
  return existsSync(legacy) ? legacy : dir;
}

/** 该候选的工作副本目录（agent 的 cwd） */
export function candidateWorkspaceDir(workspaceRoot: string, runId: string, candidateId: string): string {
  return join(candidateDir(workspaceRoot, runId, candidateId), 'workspace');
}

/**
 * 该候选的智能体独立配置目录。
 * 必须**每个候选一个**：并行时多个 agent 会抢同一份 `~/.claude` / `~/.codex` 的会话文件，
 * 而且 `~/.claude/settings.json` 的 `env` 块会盖掉我们注入的模型路由。
 */
export function candidateAgentHomeDir(workspaceRoot: string, runId: string, candidateId: string): string {
  return join(candidateDir(workspaceRoot, runId, candidateId), '.agenthome');
}

/**
 * 该候选的**评分智能体**独立配置目录。
 * 为什么不能复用 `.agenthome`：评分智能体可能与被测智能体不是同一家，而 `.agenthome` 是
 * `CLAUDE_CONFIG_DIR` / `DSH_HOME` / `CODEX_HOME` 的落点——两家的配置文件格式不同，共用一个目录
 * 会互相破坏，而且破坏是**静默的**（CLI 会安静地忽略读不懂的配置，表现成「模型路由没生效」）。
 */
export function candidateJudgeHomeDir(workspaceRoot: string, runId: string, candidateId: string): string {
  return join(candidateDir(workspaceRoot, runId, candidateId), '.judgehome');
}

/** 建该候选的评分智能体配置目录并返回路径（只有启用智能体评分的轮次才会调它） */
export function ensureCandidateJudgeHome(workspaceRoot: string, runId: string, candidateId: string): string {
  const dir = candidateJudgeHomeDir(workspaceRoot, runId, candidateId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** 该候选的事件日志（JSONL，唯一真相源） */
export function candidateEventsFile(workspaceRoot: string, runId: string, candidateId: string): string {
  return join(candidateDir(workspaceRoot, runId, candidateId), 'events.jsonl');
}

/**
 * 该候选的**消息日志**（JSONL，`AgentMessage` 逐条追加）。
 *
 * 为什么与 `events.jsonl` 分开：两者是**两个维度**——事件是候选级的（状态、日志、计量、失败、结束，
 * 按 `seq` 去重与续订），消息是内容级的（说话者、内容块、工具族、子智能体归属，按 `mergeKey`
 * 覆盖累积）。合成一个文件会让「按 seq 续订」与「按 mergeKey 覆盖」两套游标挤在同一条流里。
 * 与事件日志同一处置：每次开跑前 `resetRecords` 清空（它记的是**当前这次尝试**的消息）。
 */
export function candidateMessagesFile(workspaceRoot: string, runId: string, candidateId: string): string {
  return join(candidateDir(workspaceRoot, runId, candidateId), 'messages.jsonl');
}

/**
 * 该候选**人工消息附件的根目录**（人随消息上传的文件都在这下面，一 `<messageId>` 一个子目录）。
 *
 * 为什么挂在候选目录而不是工作区里：附件是**人给的证据**，不是被测对象的产出——放进 workspace
 * 会污染 `git diff` 与评分面（模型改过的文件与它读过的文件混在一起，diff 里多出一堆没意义的新文件），
 * 而且 workspace 会被重跑重建、被 `git checkout` 打断。挂在这里还顺带解决一件事：
 * 它在 `runDir` 之内 ⇒ 随 `deleteRun` 的整目录删除一次清干净，不必再有一条清理路径。
 */
export function candidateAttachmentsDir(workspaceRoot: string, runId: string, candidateId: string): string {
  return join(candidateDir(workspaceRoot, runId, candidateId), 'attachments');
}

/**
 * 某一条人工消息的附件目录（`attachments/<messageId>/`）。
 * **拼路径前先过 id 形状校验**：这个名字来自客户端，而 `join` 不拦 `..`——一个越界的 id 会让
 * 紧接着的写入跑到候选目录之外（与 `caseCacheDir` 的处置同源）。
 */
export function candidateAttachmentDir(workspaceRoot: string, runId: string, candidateId: string, messageId: string): string {
  return join(candidateAttachmentsDir(workspaceRoot, runId, candidateId), assertInjectMessageId(messageId));
}

/**
 * 该候选**评分阶段的事件日志**（JSONL）。
 *
 * 为什么与 `events.jsonl` 分开：候选级事件日志回答的是「**这个候选**跑成什么样」（状态、计量、失败、结束），
 * 而评分阶段的原始输出是**另一个会话**的流水（评审者自己的工具调用、推理、报错）。混在一条流里，
 * 卡片与快照的读数会被评审者的用量挤占（口径 5 那套冻结逻辑正是为它写的），而「评审到底干了什么」
 * 也没有独立的落点——要看只能连同一候选的日志一起翻。
 *
 * `seq` 由写入器按**文件里已用的最大号**续（core 的 `appendEvent`），所以本文件自带一套从 1 起的号，
 * 与候选级 `seq` 不共享：两条流的续订游标因此互不影响（评分重新开始时不会把候选级游标带偏）。
 */
export function candidateJudgeEventsFile(workspaceRoot: string, runId: string, candidateId: string): string {
  return join(candidateDir(workspaceRoot, runId, candidateId), 'judge-events.jsonl');
}

/**
 * 该候选评分阶段的**消息日志**（`AgentMessage` 逐条追加）。
 * 与 `candidateMessagesFile` 同一处置（快照落盘、增量只广播），只是**另一个会话**：分开之后，
 * 执行日志里那条时间轴只讲候选做了什么，评审者的对话在它自己的文件里。
 */
export function candidateJudgeMessagesFile(workspaceRoot: string, runId: string, candidateId: string): string {
  return join(candidateDir(workspaceRoot, runId, candidateId), 'judge-messages.jsonl');
}

/**
 * 该候选的**尝试账本**（JSONL，追加、永不清空）。
 *
 * 为什么必须与 `events.jsonl` 分开：事件日志的语义是「**当前这次尝试**的事件」（`runCandidateAttempt`
 * 每次开跑前 `resetEvents` 清空它，见文件头口径 3 与 `resetEvents` 的注释）。而自动重试每重试一次
 * 就清一次，于是「一共试了几次、每次为什么失败」这些记录会被后一次尝试**连文件一起删掉**——
 * 实测：目标页那一行最终 `attempts = 6`，而事件日志里**一条重试记录都没有**（用户在界面上看到
 * 「已重试 5 次」却在日志抽屉里找不到任何一次的证据）。
 * 账本是**累计**的（同 `EvalCandidate.attempts` 的口径：那回答「走过几次」，不是「当前这一次」），
 * 所以它**绝不参与任何 reset**——真要与事件日志一起清，就回到原来那个「看得见计数、看不见原因」的状态。
 * 放在候选目录而不是轮目录：它记的是「这个候选的第 N 次尝试」，与 `events.jsonl` / `workspace` 同级最自然。
 */
export function candidateAttemptsFile(workspaceRoot: string, runId: string, candidateId: string): string {
  return join(candidateDir(workspaceRoot, runId, candidateId), 'attempts.jsonl');
}

/** 运行快照文件（每次状态变更整体原子覆盖） */
export function runSnapshotFile(workspaceRoot: string, runId: string): string {
  return join(runDir(workspaceRoot, runId), 'run.json');
}

/**
 * 清掉该候选**属于本模块的**四份产物：`workspace/`（上一轮 agent 的工作副本）、`.agenthome/`
 * （上一轮被测智能体的会话与配置）、`.judgehome/`（上一轮**评分**智能体的会话与配置）与
 * `attachments/`（上一轮人上传的附件）。
 * 为什么 `.judgehome` 也要清：留着它，下一轮的评审者会带着上一轮的会话与配置跑——
 * 配置可能指向另一家 CLI（评分智能体换了），而 CLI 对读不懂的配置是**静默忽略**的。
 * 为什么 `attachments/` 也要清：重跑是**另一次尝试**，上一轮人拖进来的材料与这一轮无关；
 * 留着它，模型会读到几份这一轮根本没人上传过的文件，而账本里那条消息**不在**（账本每次尝试清空）
 * ⇒ 现场看起来像「模型凭空读了一个文件」。注意**追问（复用工作区那条路）不走这里**：
 * 追问要的就是「附件还在」。
 * 为什么不整目录删：候选目录里还住着 `events.jsonl`——唯一真相源，且它的清空归
 * `resetEvents` 独占。整目录删会把「重跑」这个动作变成对事件日志的隐式清空（见文件头口径 3）。
 * 四个名字逐个列出而不是删一个白名单之外的全清：将来候选目录里再落新东西时，
 * 这条口径是「不被顺手删掉」，而不是「默认删掉」。
 *
 * 第四条：**每一次删除都走有界重试**（`removeTreeWithRetry`）。成因是实测出来的
 * ——厂商 CLI 会 spawn 一串继承句柄的孙进程（codex 的插件同步 `git` 链），它们持着 `.agenthome` /
 * `.judgehome`，而 Windows 上的句柄释放比「进程退出」晚；一次 `rmSync` 不成就把整行折成 INTERNAL，
 * 会让一行在锁消失之前**每次重跑都失败**（真机：同一条报错在 7 次尝试里逐字重复）。
 */
function clearCandidateArtifacts(dir: string): void {
  removeOrThrow(join(dir, 'workspace'));
  removeOrThrow(join(dir, '.agenthome'));
  removeOrThrow(join(dir, '.judgehome'));
  removeOrThrow(join(dir, 'attachments'));
}

/** 删一棵子树（带重试）；仍删不掉就把**原始错误**抛出去，由调用方折成中文原因 */
function removeOrThrow(target: string): void {
  const outcome = removeTreeWithRetry(target);
  if (outcome.removed) return;
  throw outcome.lastError instanceof Error ? outcome.lastError : new Error(String(outcome.lastError));
}

/**
 * 清上一轮的候选产物（workspace + 两个配置目录 + 附件根，**不含** events.jsonl，见文件头口径 3）；
 * 目录不存在则跳过。
 * 删除失败（Windows 上上一轮 agent 进程还没退干净、句柄没释放 → EPERM/EBUSY）必须折成中文原因：
 * 裸抛 errno 英文原文会一路冒到界面（禁止），与 git.ts 的 executeOrFail 同一口径；
 * 原文放 message 里供排查，调用方拿到的是可处置的 INTERNAL。文案里点出**常见成因**：
 * 判据是目录里还有活进程的句柄，而最常见的就是厂商 CLI 的下级进程 ⇒ 提示先看进程。
 */
function resetCandidateDir(dir: string): void {
  if (!existsSync(dir)) return;
  log.info('清理上一轮的候选产物（workspace、.agenthome、.judgehome、attachments）', { dir });
  try {
    clearCandidateArtifacts(dir);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ServiceError(
      'INTERNAL',
      `清理上一轮的候选产物失败：${dir}（${detail}）。该目录仍被另一个进程占用：`
        + '常见成因是上一轮的厂商子进程（codex/claude/dsh 及其下级进程）尚未退出，稍后重试即可；'
        + '若持续失败，先结束残留的厂商进程再重跑这个候选。',
      { cause: error },
    );
  }
}

/**
 * 准备失败的**回滚**：清掉本模块刚建的产物。失败只 WARN、绝不顶替原始错误——
 * 调用方要处置的是「commit 不存在」这类可修复的原因，把它换成 EPERM/EBUSY 会把 code 与文案都指错方向。
 */
function rollbackCandidateArtifacts(dir: string): void {
  try {
    clearCandidateArtifacts(dir);
  } catch (cleanupError) {
    log.warn('回滚候选产物失败，已忽略（原始错误原样抛出）', { dir, cleanupError });
  }
}

/**
 * 建候选工作区：确保用例缓存 → 清掉上一轮的候选产物（重跑同一行时）→ 复制缓存 → checkout 基线
 * → 建分支 → 建 `.agenthome`。
 * 为什么先确保缓存再清候选产物：清完候选产物、克隆却失败的话，这个候选会停在一个「工作区不存在」
 * 的中间态；反过来先备好缓存，失败时旧工作区仍在原处，重跑是幂等的。
 * 为什么复制之后失败要回滚候选产物：见下面 catch 块里的理由——半成品比「什么都没有」更危险。
 * 返回值里的 `baselineCommit` 是 `checkoutCandidate` 解析出的 40 位具体 hash——
 * 编排层要把它写进 `EvalCandidate.baselineCommit`，界面的 diff 路由要拿它去算 `collectDiff`。
 * `commitHash` 同时传给 `ensureCaseCache`：`null`（= 默认分支 HEAD）要求缓存先刷新到来源当前的 tip，
 * 否则「默认分支 HEAD」会退化成「上次克隆时的 HEAD」。
 */
export function prepareCandidateWorkspace(input: {
  workspaceRoot: string;
  caseId: string;
  repoPath: string;
  runId: string;
  candidateId: string;
  commitHash: string | null;
  branch: string;
}): { workspacePath: string; agentHome: string; baselineCommit: string } {
  const cache = caseCacheDir(input.workspaceRoot, input.caseId);
  ensureCaseCache(input.repoPath, cache, input.commitHash);

  const dir = candidateDir(input.workspaceRoot, input.runId, input.candidateId);
  resetCandidateDir(dir);

  const workspacePath = candidateWorkspaceDir(input.workspaceRoot, input.runId, input.candidateId);
  const agentHome = candidateAgentHomeDir(input.workspaceRoot, input.runId, input.candidateId);
  try {
    copyWorkspace(cache, workspacePath);
    const { baselineCommit } = checkoutCandidate(workspacePath, input.commitHash, input.branch);
    mkdirSync(agentHome, { recursive: true });

    log.info('候选工作区已就绪', { workspacePath, agentHome, branch: input.branch, baselineCommit });
    return { workspacePath, agentHome, baselineCommit };
  } catch (error) {
    // 失败**回滚本模块的产物**：复制是在 checkout 之前做的，checkout 抛错（commit 不存在、
    // 分支建不起来）时磁盘上已经留下一个带 `.git` 的目录——它看起来「建好了」，实则 HEAD 还停在
    // 复制过来的那个位置。留着它，任何「目录已存在就跳过准备」的判断都会拿它去跑 agent，
    // 产出的 diff 相对错误的基线（那类静默错分）。清掉后重跑与首次调用同路。
    // events.jsonl 同样不动：回滚不该顺手把「这个候选准备失败」这条证据删掉。
    rollbackCandidateArtifacts(dir);
    throw error;
  }
}

/**
 * 「无来源」用例的候选工作区准备：没有缓存可复制，改为**现场初始化空仓库**——
 * `initEmptySourceRepository`（mkdir + `git init -b main` + 空提交）之后照常走
 * `checkoutCandidate` 建 `test/{candidateId}` 候选分支，基线就是那次空提交。此后该候选与其它来源
 * 共用同一套 checkout / 基线 / diff 口径，只是工作树是空的。
 * 清上一轮候选产物与失败回滚同 `prepareCandidateWorkspace` 一份逻辑（`resetCandidateDir` / `rollbackCandidateArtifacts`）。
 */
export function prepareEmptyCandidateWorkspace(input: {
  workspaceRoot: string;
  runId: string;
  candidateId: string;
  branch: string;
}): { workspacePath: string; agentHome: string; baselineCommit: string } {
  const dir = candidateDir(input.workspaceRoot, input.runId, input.candidateId);
  resetCandidateDir(dir);

  const workspacePath = candidateWorkspaceDir(input.workspaceRoot, input.runId, input.candidateId);
  const agentHome = candidateAgentHomeDir(input.workspaceRoot, input.runId, input.candidateId);
  try {
    initEmptySourceRepository(workspacePath);
    const { baselineCommit } = checkoutCandidate(workspacePath, null, input.branch);
    mkdirSync(agentHome, { recursive: true });

    log.info('候选工作区已就绪（无来源：空仓库）', { workspacePath, agentHome, branch: input.branch, baselineCommit });
    return { workspacePath, agentHome, baselineCommit };
  } catch (error) {
    rollbackCandidateArtifacts(dir);
    throw error;
  }
}
