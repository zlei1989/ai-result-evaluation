/**
 * 用例仓库的 git 原语：仓库根判定、工作区状态分类、**逐文件提交**、远端对齐与推送。
 *
 * 与 `git.ts` 的分工：那个文件服务「评测用仓库」（校验来源、克隆缓存、算 diff、检出行分支），
 * 这个文件服务「用例仓库」（把 `<casesRoot>` 里的一堆 `<id>.json` 提交并推到远端）。
 * 两者的共同点是**只用真实 git 进程**、失败一律折成带中文原因 + 英文原文的 `ServiceError`（git.ts 文件头口径 1/3）。
 *
 * 五条硬口径：
 *   1. **只在「仓库根本身就是用例目录」时才认**（`isRepoRoot`）：只判 `--is-inside-work-tree` 会把
 *      用户家目录下的任意大仓库当作用例仓库，于是「提交用例变更」会顺手把别的文件写进历史。
 *   2. **逐文件提交**：`commitFile` 一次只 stage 一个路径（`git add -A -- <path>`），
 *      且每次都先确认这个路径真的还有变更——否则「用文档消息逐文件提交」会产出 N 个空提交。
 *   3. **绝不 force push**：本文件不出现 `--force` / `-f` / `+<ref>` 任何一种写法（守卫测试盯着它）。
 *      理由不只是习惯：远端那一份是别人也在用的历史，强推会把他们的提交删掉，而这里没有任何
 *      「我们更权威」的依据。
 *   4. **合并/变基失败要能整体回退**：`abortPendingGitOperation` 把半途的 merge / rebase 收干净，
 *      否则下一次同步会撞在「你有一个未完成的合并」上，而且用户看不出该怎么修。
 *   5. **远端交互必须有墙钟上限与环境隔离**（禁交互提示、ssh BatchMode）：后台跑的命令没人能回答
 *      「请输入密码」，卡住的症状是一条永远不结束的同步。
 */
import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, join, sep } from 'node:path';
import { ServiceError, isCaseIdShapeValid } from '@aieval/contracts';
import { execute, gitMessage } from './git-exec';
import { createLogger } from './logger';
import { REMOTE_TRANSFER_TIMEOUT_MS } from './mirror';

const log = createLogger('case-git');

/** 用例文件后缀（与 case-store 同名常量各持一份：一处是存储、一处是 git 分类，合并会把两层绑死） */
const CASE_FILE_SUFFIX = '.json';

/** 远端交互的环境隔离 + 上限（与 mirror.ts 的 remoteOptions 同口径，但那里没导出，故这里重写一份） */
function remoteOptions(): { env: Record<string, string>; timeoutMs: number } {
  const env: Record<string, string> = { GIT_TERMINAL_PROMPT: '0' };
  if (process.env.GIT_SSH_COMMAND === undefined) env.GIT_SSH_COMMAND = 'ssh -o BatchMode=yes';
  return { env, timeoutMs: REMOTE_TRANSFER_TIMEOUT_MS };
}

/** 执行一条 git 命令；失败折成「中文原因 + 英文原文」的 INTERNAL */
function run(dir: string, args: string[], what: string, options: { env?: Record<string, string>; timeoutMs?: number } = {}): string {
  try {
    return execute(dir, args, options);
  } catch (error) {
    const detail = gitMessage(error);
    throw new ServiceError('INTERNAL', `${what}：${dir}（${detail}）`, { context: { dir, args, gitMessage: detail } });
  }
}

/**
 * 执行一条 git 命令并容忍失败（返回 null）。
 * 用途只有两类：**判据型**命令（`rev-parse @{u}` 在没有上游时非零退出，那是答案不是错误）
 * 与**清理型**命令（`merge --abort` 失败说明本来就没在合并）。业务命令一律走 `run`。
 */
function tryRun(dir: string, args: string[], options: { env?: Record<string, string>; timeoutMs?: number } = {}): string | null {
  try {
    return execute(dir, args, options);
  } catch {
    return null;
  }
}

/**
 * 目录**本身**是不是一个 git 仓库的根（不是「在某个仓库里」）。
 * 两边都走 `realpath` 比：macOS 上 `/var/folders/...` 与 `/private/var/folders/...` 是同一个目录，
 * 而 git 回的 `--show-toplevel` 用的是物理路径——不比 realpath 会把临时目录里的仓库整个判成「不是仓库」 */
export function isRepoRoot(dir: string): boolean {
  if (!existsSync(dir)) return false;
  const topLevel = tryRun(dir, ['rev-parse', '--show-toplevel']);
  if (topLevel === null) return false;
  return physical(dir) === physical(topLevel.trim());
}

/** 仓库配置的远端名（按 git 的返回顺序；空数组 = 没配远端，只能本地提交） */
export function remoteNames(dir: string): string[] {
  const output = tryRun(dir, ['remote']);
  if (output === null) return [];
  return output.split('\n').map((line) => line.trim()).filter((line) => line !== '');
}

/** 当前分支名（detached HEAD 时 git 回 `HEAD`）；不是仓库时抛中文原因 */
export function currentBranch(dir: string): string {
  return run(dir, ['rev-parse', '--abbrev-ref', 'HEAD'], '读取当前分支失败').trim();
}

/** HEAD 的完整 hash；仓库还没有任何提交时返回 null（`rev-parse HEAD` 非零退出） */
export function headCommit(dir: string): string | null {
  const output = tryRun(dir, ['rev-parse', 'HEAD']);
  return output === null ? null : output.trim();
}

/**
 * 工作区状态分类：**用例文件**的变更清单 + 被忽略的无关变更数。
 *
 * 只调**一条** git 命令（`status --porcelain -z`）是有意的：本机的计价单位是进程创建（≈0.5s/次），
 * 而状态接口每次读都在关键路径上。`-z` 是既有的口径（`git.ts` 的 collectDiff 同源）：
 * `quotepath=true` 会把非 ASCII 路径写成八进制转义，中文文件名直接认不出来。
 *
 * 用例文件的判据是「根目录下的 `<合法 id>.json`」：带目录的、名字不合 id 形状的、非 `.json` 的
 * 都算**无关变更**（它们永不进提交，但计数要让用户看得见）。
 * 重命名/拷贝（`R`/`C`）在 `-z` 下会多带一个原始路径字段，这里直接跳过它：
 * 用例文件都在根目录、重命名用例极罕见，两种字段顺序下最坏只是把一条变更归错类（分类计数），
 * 不会导致漏提交——`commitFile` 是按路径现查状态的。
 */
export function readWorktreeState(dir: string): { caseFiles: string[]; ignoredCount: number } {
  const output = run(dir, ['status', '--porcelain', '-z'], '读取用例仓库状态失败');
  const fields = output.split('\u0000');
  const caseFiles: string[] = [];
  let ignoredCount = 0;

  for (let index = 0; index < fields.length; index += 1) {
    const entry = fields[index] ?? '';
    if (entry === '') continue;
    const status = entry.slice(0, 2);
    const path = entry.slice(3);
    // 重命名 / 拷贝的下一个字段是另一个路径：吃掉它，避免把它当成一条独立变更
    if (status.startsWith('R') || status.startsWith('C')) index += 1;
    if (isCaseFilePath(path)) caseFiles.push(path);
    else ignoredCount += 1;
  }
  return { caseFiles, ignoredCount };
}

/**
 * 这个路径是不是一个用例文件（根目录 + `<合法 id>.json`）。
 * `sep` 与 `/` 都判：git 在 Windows 上回的是正斜杠，而路径分类要两个平台都对。
 */
function isCaseFilePath(path: string): boolean {
  if (path.includes('/') || path.includes(sep)) return false;
  if (!path.endsWith(CASE_FILE_SUFFIX)) return false;
  return isCaseIdShapeValid(path.slice(0, -CASE_FILE_SUFFIX.length));
}

/** 这个路径当前有没有未提交的变更（包括未跟踪与已删除） */
export function isPathDirty(dir: string, path: string): boolean {
  return pathStatusCode(dir, path) !== null;
}

/**
 * 这个路径的 XY 状态码（`??` = 未跟踪、` M` = 已改、`D ` = 已删……）；路径干净时返回 null。
 * 回退提交信息要按它区分「新增 / 更新 / 删除」，故不能只回一个 bool。
 */
export function pathStatusCode(dir: string, path: string): string | null {
  const output = run(dir, ['status', '--porcelain', '--', path], `读取文件状态失败：${path}`);
  const line = output.split('\n')[0] ?? '';
  return line.trim() === '' ? null : line.slice(0, 2);
}

/**
 * 提交**一个**文件；这个文件没有变更时**什么都不做**并返回 false。
 * 两件事必须按序发生：先 `add -A -- <path>`（单路径的 `-A`，不是全局 `git add -A`——那是本仓
 * 明令禁止的写法），再 `commit`。中间不做 pathspec 提交，因为这里恰好只 stage 了一个路径。
 * 返回 false 的两种成因（已经提交过 / 加了但没变化，例如被 `.gitignore` 忽略）都不算失败：
 * 调用方要的是「这个文件最终进了历史」，不是「这条命令跑成功」。
 * 注意 `add` 对被 `.gitignore` 忽略的文件会非零退出，那是**硬错误**（这个文件永远提交不了），
 * 必须冒出去让用户看见——故它不在这里被吞掉。
 */
export function commitFile(dir: string, path: string, message: string): boolean {
  if (!isPathDirty(dir, path)) return false;
  run(dir, ['add', '-A', '--', path], `暂存用例文件失败：${path}`);
  if (!isPathDirty(dir, path)) {
    // add 之后仍然「干净」：被忽略，或内容与索引一致
    return false;
  }
  run(dir, ['commit', '-m', message], `提交用例文件失败：${path}`);
  log.info('用例文件已提交', { path, message });
  return true;
}

/**
 * 列出 `from..HEAD` 之间的提交及每个提交碰过的文件（`from` 为 null = 仓库还没有基线，列全部）。
 * 用途是**校验「逐文件提交」这条不变量**：一个提交碰了多个文件、或有文件压根没进提交，
 * 都要能被判出来并回退重做——而不是相信「让模型自己按格式提交」。
 * 解析方式：`--format=%H --name-only` 会把 hash 单独打一行、随后的文件各一行。
 */
export function listCommitsSince(dir: string, from: string | null): { hash: string; files: string[] }[] {
  const args = ['log', '--format=%H', '--name-only', ...(from === null ? [] : [`${from}..HEAD`])];
  const output = run(dir, args, '读取新增提交失败');
  const commits: { hash: string; files: string[] }[] = [];
  let current: { hash: string; files: string[] } | null = null;
  for (const rawLine of output.split('\n')) {
    const line = rawLine.trim();
    if (line === '') continue;
    // 40 位十六进制 = 一个提交 hash；用例文件名必然以 `.json` 结尾，不会撞上这条判据
    if (/^[0-9a-f]{40}$/.test(line)) {
      current = { hash: line, files: [] };
      commits.push(current);
      continue;
    }
    current?.files.push(line);
  }
  return commits;
}

/** 把索引与 HEAD 一起回退到某个提交，**工作区内容不动**（`--soft`）：修「逐文件提交」不变量时用它重做提交 */
export function resetSoft(dir: string, commit: string): void {
  run(dir, ['reset', '--soft', commit], '回退提交（保留工作区）失败');
}

/** 上游跟踪分支（`origin/main` 这种全名）；没有上游返回 null */
export function upstreamRef(dir: string): string | null {
  const output = tryRun(dir, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  const name = output === null ? '' : output.trim();
  return name === '' ? null : name;
}

/**
 * 拉取远端更新（含 `--prune`：远端删掉的分支要在这里消失，否则永远落后一个不存在的上游）。
 * `timeoutMs` 只给状态探测那一类「用户在等」的调用收短上限（默认走远端传输的十分钟）。
 */
export function fetchRemote(dir: string, options: { timeoutMs?: number } = {}): void {
  const remote = upstreamRef(dir)?.split('/')[0] ?? remoteNames(dir)[0] ?? 'origin';
  run(dir, ['fetch', '--prune', remote], `拉取远端更新失败（${remote}）`, {
    ...remoteOptions(),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
}

/**
 * 相对上游的领先 / 落后提交数；**没有上游返回 null**（不是 0）。
 * 两个数都是「提交数」，故用 `rev-list --count` 而不是 `--left-right`：后者回的是提交列表，
 * 大仓库上会把几十兆的哈希读进内存，而调用方只关心「差几个」。
 */
export function aheadBehind(dir: string): { ahead: number; behind: number } | null {
  const upstream = upstreamRef(dir);
  if (upstream === null) return null;
  const ahead = run(dir, ['rev-list', '--count', `${upstream}..HEAD`], '统计未推送提交失败').trim();
  const behind = run(dir, ['rev-list', '--count', `HEAD..${upstream}`], '统计远端领先提交失败').trim();
  return { ahead: Number.parseInt(ahead, 10) || 0, behind: Number.parseInt(behind, 10) || 0 };
}

/** 快进到上游（本地没有领先提交时用它，不产生合并提交） */
export function fastForwardToUpstream(dir: string): void {
  const upstream = upstreamRef(dir);
  if (upstream === null) throw new ServiceError('CONFLICT', `用例仓库没有上游分支（${dir}），无法快进`);
  run(dir, ['merge', '--ff-only', upstream], '快进到远端失败');
}

/** 合并上游（会冲突时由调用方交给智能体处置；这里只是那条兜底路径本身） */
export function mergeUpstream(dir: string): void {
  const upstream = upstreamRef(dir);
  if (upstream === null) throw new ServiceError('CONFLICT', `用例仓库没有上游分支（${dir}），无法合并`);
  run(dir, ['merge', '--no-edit', upstream], '合并远端失败');
}

/**
 * 收干净半途的 merge / rebase。
 * 判据用 git 自己（`MERGE_HEAD` 存在、rebase 目录存在）而不是「上一次命令成没成功」：
 * 智能体可能在它自己的会话里起了合并又没做完，这里必须能独立判出来。
 */
export function abortPendingGitOperation(dir: string): void {
  if (tryRun(dir, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']) !== null) {
    tryRun(dir, ['merge', '--abort']);
    log.warn('已中止未完成的合并', { dir });
    return;
  }
  if (gitStatePathExists(dir, 'rebase-merge') || gitStatePathExists(dir, 'rebase-apply')) {
    tryRun(dir, ['rebase', '--abort']);
    log.warn('已中止未完成的变基', { dir });
  }
}

/** `.git` 下的某个状态路径是否存在（`--git-path` 会把相对路径回在仓库目录下，故要按 dir 解析） */
function gitStatePathExists(dir: string, name: string): boolean {
  const raw = tryRun(dir, ['rev-parse', '--git-path', name])?.trim();
  if (raw === undefined || raw === '') return false;
  return existsSync(isAbsolute(raw) ? raw : join(dir, raw));
}

/**
 * 推送到远端。有上游就 `push`，没有就 `push -u origin <当前分支>`（首次推送建立跟踪关系）。
 * **没有任何 force 变体**：见文件头口径 3。
 */
export function pushRemote(dir: string): void {
  if (upstreamRef(dir) !== null) {
    run(dir, ['push'], '推送用例变更失败', remoteOptions());
    return;
  }
  const remote = remoteNames(dir)[0];
  if (remote === undefined) throw new ServiceError('CONFLICT', `用例仓库没有配置远端（${dir}），只能提交到本地`);
  run(dir, ['push', '-u', remote, currentBranch(dir)], `推送用例变更失败（首次推送 ${remote}）`, remoteOptions());
}

/** 物理路径（realpath 失败时退回原串：路径刚被删掉也要能比较，别在判定函数里抛错） */
function physical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}
