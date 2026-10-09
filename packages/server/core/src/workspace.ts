/**
 * 工作区引擎：目录结构 + 行工作区准备（spec §5.5 第 1/2 步、§6.3）。
 * 目录布局是**硬约定**（契约 §10），每一层都有消费者：
 *   {workspaceRoot}/cases/{caseId}/cache/   用例级缓存仓库（首次评测克隆一次，之后复制）
 *   {workspaceRoot}/{runId}/run.json        运行快照
 *   {workspaceRoot}/{runId}/rows/{rowId}/workspace   该行工作副本（分支 test/{rowId}）
 *   {workspaceRoot}/{runId}/rows/{rowId}/.agenthome  该行独立配置目录（CLAUDE_CONFIG_DIR 等）
 *   {workspaceRoot}/{runId}/rows/{rowId}/.judgehome  该行**评分智能体**的独立配置目录（智能体评分通路）
 *   {workspaceRoot}/{runId}/rows/{rowId}/events.jsonl 该行事件日志（唯一真相源）
 * 三个必须成立的口径：
 *   1. 事件日志与 `run.json` **不在** workspace 里：agent 可以在 workspace 内随意建删文件，
 *      把证据放进去等于把证据交给被测对象；
 *   2. 重跑同一行必须**先清掉上一轮的工作副本与两个独立配置目录**（workspace + .agenthome + .judgehome）：
 *      留下上一轮的工作区，第二个候选就是在第一个候选的改动之上继续写，分数无意义（spec §3 F6）；
 *   3. 但**绝不能连 `events.jsonl` 一起清**（§11 R27）：清空日志的唯一所有者是 `resetEvents`
 *      （契约 §3.4），而 p4 的顺序是「先 `resetEvents` → 发 `preparing`（seq 1，这一步就建出了行目录）
 *      → 再 `prepareRowWorkspace`」。这里整目录删掉，刚写下的 `preparing` 就没了，
 *      下一次追加又从 seq 1 开始；p5 的 `useRowStream` 按 seq 去重，于是清空后的第一条状态事件
 *      被静默吞掉——正是 R24 存在的理由，而且每一轮都会发生。
 */
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ServiceError } from '@aieval/contracts';
import { createLogger } from './logger';
import { removeTreeWithRetry } from './remove-tree';
import { checkoutRow, copyWorkspace, ensureCaseCache } from './git';

const log = createLogger('workspace');

/** 用例级缓存仓库目录 */
export function caseCacheDir(workspaceRoot: string, caseId: string): string {
  return join(workspaceRoot, 'cases', caseId, 'cache');
}

/** 一轮评测的产物目录（`run.json` 与 `rows/` 都在它下面） */
export function runDir(workspaceRoot: string, runId: string): string {
  return join(workspaceRoot, runId);
}

/** 单个候选行的产物目录（工作区、独立配置目录与事件日志都在它下面） */
export function rowDir(workspaceRoot: string, runId: string, rowId: string): string {
  return join(runDir(workspaceRoot, runId), 'rows', rowId);
}

/** 该行的工作副本目录（agent 的 cwd） */
export function rowWorkspaceDir(workspaceRoot: string, runId: string, rowId: string): string {
  return join(rowDir(workspaceRoot, runId, rowId), 'workspace');
}

/**
 * 该行的智能体独立配置目录（spec §3 F8）。
 * 必须**每行一个**：并行时多个 agent 会抢同一份 `~/.claude` / `~/.codex` 的会话文件，
 * 而且 `~/.claude/settings.json` 的 `env` 块会盖掉我们注入的模型路由。
 */
export function rowAgentHomeDir(workspaceRoot: string, runId: string, rowId: string): string {
  return join(rowDir(workspaceRoot, runId, rowId), '.agenthome');
}

/**
 * 该行的**评分智能体**独立配置目录。
 * 为什么不能复用 `.agenthome`：评分智能体可能与被测智能体不是同一家，而 `.agenthome` 是
 * `CLAUDE_CONFIG_DIR` / `DSH_HOME` / `CODEX_HOME` 的落点——两家的配置文件格式不同，共用一个目录
 * 会互相破坏，而且破坏是**静默的**（CLI 会安静地忽略读不懂的配置，表现成「模型路由没生效」）。
 */
export function rowJudgeHomeDir(workspaceRoot: string, runId: string, rowId: string): string {
  return join(rowDir(workspaceRoot, runId, rowId), '.judgehome');
}

/** 建该行的评分智能体配置目录并返回路径（只有启用智能体评分的轮次才会调它） */
export function ensureRowJudgeHome(workspaceRoot: string, runId: string, rowId: string): string {
  const dir = rowJudgeHomeDir(workspaceRoot, runId, rowId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** 该行的事件日志（JSONL，唯一真相源） */
export function rowEventsFile(workspaceRoot: string, runId: string, rowId: string): string {
  return join(rowDir(workspaceRoot, runId, rowId), 'events.jsonl');
}

/**
 * 该行的**消息日志**（JSONL，spec v3 §2 的 `AgentMessage` 逐条追加）。
 *
 * 为什么与 `events.jsonl` 分开：两者是**两个维度**——事件是行级的（状态、日志、计量、失败、结束，
 * 按 `seq` 去重与续订），消息是内容级的（说话者、内容块、工具族、子智能体归属，按 `mergeKey`
 * 覆盖累积）。合成一个文件会让「按 seq 续订」与「按 mergeKey 覆盖」两套游标挤在同一条流里。
 * 与事件日志同一处置：每次开跑前 `resetRecords` 清空（它记的是**当前这次尝试**的消息）。
 */
export function rowMessagesFile(workspaceRoot: string, runId: string, rowId: string): string {
  return join(rowDir(workspaceRoot, runId, rowId), 'messages.jsonl');
}

/**
 * 该行的**尝试账本**（JSONL，追加、永不清空；2026-09-27）。
 *
 * 为什么必须与 `events.jsonl` 分开：事件日志的语义是「**当前这次尝试**的事件」（`runRowAttempt`
 * 每次开跑前 `resetEvents` 清空它，见文件头口径 3 与 `resetEvents` 的注释）。而自动重试每重试一次
 * 就清一次，于是「一共试了几次、每次为什么失败」这些记录会被后一次尝试**连文件一起删掉**——
 * 实测：目标页那一行最终 `attempts = 6`，而事件日志里**一条重试记录都没有**（用户在界面上看到
 * 「已重试 5 次」却在日志抽屉里找不到任何一次的证据）。
 * 账本是**累计**的（同 `EvalRow.attempts` 的口径：那回答「走过几次」，不是「当前这一次」），
 * 所以它**绝不参与任何 reset**——真要与事件日志一起清，就回到原来那个「看得见计数、看不见原因」的状态。
 * 放在行目录而不是轮目录：它记的是「这一行的第 N 次尝试」，与 `events.jsonl` / `workspace` 同级最自然。
 */
export function rowAttemptsFile(workspaceRoot: string, runId: string, rowId: string): string {
  return join(rowDir(workspaceRoot, runId, rowId), 'attempts.jsonl');
}

/** 运行快照文件（每次状态变更整体原子覆盖） */
export function runSnapshotFile(workspaceRoot: string, runId: string): string {
  return join(runDir(workspaceRoot, runId), 'run.json');
}

/**
 * 清掉该行**属于本模块的**三份产物：`workspace/`（上一轮 agent 的工作副本）、`.agenthome/`
 * （上一轮被测智能体的会话与配置）与 `.judgehome/`（上一轮**评分**智能体的会话与配置）。
 * 为什么 `.judgehome` 也要清：留着它，下一轮的评审者会带着上一轮的会话与配置跑——
 * 配置可能指向另一家 CLI（评分智能体换了），而 CLI 对读不懂的配置是**静默忽略**的。
 * 为什么不整目录删（§11 R27）：行目录里还住着 `events.jsonl`——唯一真相源，且它的清空归
 * `resetEvents` 独占。整目录删会把「重跑」这个动作变成对事件日志的隐式清空（见文件头口径 3）。
 * 三个名字逐个列出而不是删一个白名单之外的全清：将来行目录里再落新东西时，
 * 这条口径是「不被顺手删掉」，而不是「默认删掉」。
 *
 * 2026-10-07 补的第四条：**每一次删除都走有界重试**（`removeTreeWithRetry`）。成因是实测出来的
 * ——厂商 CLI 会 spawn 一串继承句柄的孙进程（codex 的插件同步 `git` 链），它们持着 `.agenthome` /
 * `.judgehome`，而 Windows 上的句柄释放比「进程退出」晚；一次 `rmSync` 不成就把整行折成 INTERNAL，
 * 会让一行在锁消失之前**每次重跑都失败**（真机：同一条报错在 7 次尝试里逐字重复）。
 */
function clearRowArtifacts(dir: string): void {
  removeOrThrow(join(dir, 'workspace'));
  removeOrThrow(join(dir, '.agenthome'));
  removeOrThrow(join(dir, '.judgehome'));
}

/** 删一棵子树（带重试）；仍删不掉就把**原始错误**抛出去，由调用方折成中文原因 */
function removeOrThrow(target: string): void {
  const outcome = removeTreeWithRetry(target);
  if (outcome.removed) return;
  throw outcome.lastError instanceof Error ? outcome.lastError : new Error(String(outcome.lastError));
}

/**
 * 建行工作区：确保用例缓存 → 清掉上一轮的行产物（重跑同一行时）→ 复制缓存 → checkout 基线
 * → 建分支 → 建 `.agenthome`。
 * 为什么先确保缓存再清行产物：清完行产物、克隆却失败的话，这一行会停在一个「工作区不存在」
 * 的中间态；反过来先备好缓存，失败时旧工作区仍在原处，重跑是幂等的。
 * 为什么复制之后失败要回滚行产物（§11 R25）：见下面 catch 块里的理由——半成品比「什么都没有」更危险。
 * 返回值里的 `baselineCommit` 是 `checkoutRow` 解析出的 40 位具体 hash（§11 R2）——
 * p4 要把它写进 `EvalRow.baselineCommit`，p5 的 diff 路由要拿它去算 `collectDiff`。
 * `commitHash` 同时传给 `ensureCaseCache`：`null`（= 默认分支 HEAD）要求缓存先刷新到来源当前的 tip，
 * 否则「默认分支 HEAD」会退化成「上次克隆时的 HEAD」（§11 R28）。
 */
export function prepareRowWorkspace(input: {
  workspaceRoot: string;
  caseId: string;
  repoPath: string;
  runId: string;
  rowId: string;
  commitHash: string | null;
  branch: string;
}): { workspacePath: string; agentHome: string; baselineCommit: string } {
  const cache = caseCacheDir(input.workspaceRoot, input.caseId);
  ensureCaseCache(input.repoPath, cache, input.commitHash);

  const dir = rowDir(input.workspaceRoot, input.runId, input.rowId);
  if (existsSync(dir)) {
    // 只清 workspace 与两个配置目录：events.jsonl 归 resetEvents（§11 R27），见 clearRowArtifacts
    log.info('清理上一轮的行产物（workspace、.agenthome、.judgehome）', { dir });
    // 删除失败（Windows 上上一轮 agent 进程还没退干净、句柄没释放 → EPERM/EBUSY）必须折成中文原因：
    // 裸抛 errno 英文原文会一路冒到界面（spec §10 禁止），与 git.ts 的 executeOrFail 同一口径；
    // 原文放 message 里供排查，调用方拿到的是可处置的 INTERNAL。
    try {
      clearRowArtifacts(dir);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      // 文案里点出**常见成因**：这一条报错过去只说「清理失败 + errno 原文」，于是「上一轮的厂商进程
      // 还没退干净」这个真因得靠人肉猜（真机排障链：EPERM → 谁占着？→ 进程表里找 git/codex）。
      // 判据是目录里还有活进程的句柄，而最常见的就是厂商 CLI 的下级进程 ⇒ 提示先看进程。
      throw new ServiceError(
        'INTERNAL',
        `清理上一轮的行产物失败：${dir}（${detail}）。该目录仍被另一个进程占用：`
          + '常见成因是上一轮的厂商子进程（codex/claude/dsh 及其下级进程）尚未退出，稍后重试即可；'
          + '若持续失败，先结束残留的厂商进程再重跑这一行。',
        { cause: error },
      );
    }
  }

  const workspacePath = rowWorkspaceDir(input.workspaceRoot, input.runId, input.rowId);
  const agentHome = rowAgentHomeDir(input.workspaceRoot, input.runId, input.rowId);
  try {
    copyWorkspace(cache, workspacePath);
    const { baselineCommit } = checkoutRow(workspacePath, input.commitHash, input.branch);
    mkdirSync(agentHome, { recursive: true });

    log.info('行工作区已就绪', { workspacePath, agentHome, branch: input.branch, baselineCommit });
    return { workspacePath, agentHome, baselineCommit };
  } catch (error) {
    // 失败**回滚本模块的产物**（§11 R25）：复制是在 checkout 之前做的，checkout 抛错（commit 不存在、
    // 分支建不起来）时磁盘上已经留下一个带 `.git` 的目录——它看起来「建好了」，实则 HEAD 还停在
    // 复制过来的那个位置。留着它，任何「目录已存在就跳过准备」的判断都会拿它去跑 agent，
    // 产出的 diff 相对错误的基线（spec §3 F6 那类静默错分）。清掉后重跑与首次调用同路。
    // events.jsonl 同样不动：回滚不该顺手把「这一行准备失败」这条证据删掉（§11 R27）。
    // 回滚本身失败**绝不能顶替原始错误**：调用方要处置的是「commit 不存在」这类可修复的原因
    // （改完用例记录重跑正是这里最需要的动作），把它换成一个 EPERM/EBUSY 会把 code 与文案都指错方向。
    // 故清理单独包一层：清理失败只 WARN，原始 error 原样 rethrow。
    try {
      clearRowArtifacts(dir);
    } catch (cleanupError) {
      log.warn('回滚行产物失败，已忽略（原始错误原样抛出）', { dir, cleanupError });
    }
    throw error;
  }
}
