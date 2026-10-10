/**
 * git CLI 原语：仓库校验、commit 判定、用例级缓存克隆、文件系统级目录复制、行分支。
 * 三个必须成立的口径：
 *   1. **只用真实 git 进程**，不做任何 mock 封装：mock 掉的正是最容易错的地方
 *      （`cat-file -e` 的 `^{commit}` 语法、`rev-parse --show-toplevel` 的返回形态、
 *      复制目录是否带上 `.git`）；
 *   2. 所有 git 调用都带两个 `-c`，且必须放在子命令之前，两条都是**为了不被跑它的那台机器左右**：
 *      · `core.quotepath=false`：默认值会把非 ASCII 路径写成 `"\346\226\207\344\273\266.txt"`，
 *        中文文件名的改动在 diff 里就变成了乱码；
 *      · `core.autocrlf=false`：Git for Windows 的系统级 gitconfig 就带 `core.autocrlf=true`
 *        （本机实测 `D:/…/Git/etc/gitconfig`），用户全局配置只要没覆盖它，克隆/检出的工作树
 *        就会把 LF 改写成 CRLF——工具的工作区必须与仓库里存的**字节**一致，否则 agent 改的是
 *        另一份内容、按内容比对的评分跟着错。命令行 `-c` 优先级最高，能同时盖住系统级与全局配置；
 *   3. 失败一律折成带中文原因的 `ServiceError`：**中文原因在前，git 的英文 `fatal:` 原文作为可排查的
 *      补充跟在后面**（`executeOrFail` 与 `resolveRepoInfo` 都这么做），同一份原文另放 `context.gitMessage`。
 *      为什么不把原文从 message 里摘掉：本模块的失败里有一类「无法归因」的（`index.lock` 被 agent 占着、
 *      git 自己坏了、来源仓库被删），它们与原文件头这条口径下的「commit 不存在」在中文文案上长得一模一样，
 *      而处置完全不同；这类失败要保留上游文本供排查。本文件早先写的「原文绝不出现在用户文案里」
 *      与实现、spec 都不符，已按实际行为改正（行为未变，只改注释）。
 * 执行入口本身的理由（`execFileSync` 而不是 `execSync` 的注入面、stdin 为何必须断开、maxBuffer 为何调大）
 * 见 git-exec.ts；两个 `-c` 的理由就是上面第 2 条，本文件不再另存一份。
 */
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { ServiceError, type CommitCandidate, type RepoInfo } from '@aieval/contracts';
import { execute, gitMessage } from './git-exec';
import { createLogger } from './logger';

const log = createLogger('git');

/** 行分支的命名空间（`test/{rowId}`）：解析默认分支时要整个排除 */
const ROW_BRANCH_PREFIX = 'test/';

/**
 * `execute` 的失败包装：中文原因当用户文案，git 的英文 `fatal:` 原文只进 `context`。
 * 为什么每次读取都要过它：`collectDiff` 的六次调用都可能失败（基线不存在、仓库中途被删、
 * `index.lock` 被 agent 占着），裸抛 `execFileSync` 的错误会让英文原文一路冒到界面——
 * 本文件头的第 3 条口径明确禁止，而且界面拿到 `fatal:` 也无从处置。
 */
function executeOrFail(dir: string, args: string[], what: string): string {
  try {
    return execute(dir, args);
  } catch (error) {
    const detail = gitMessage(error);
    throw new ServiceError('INTERNAL', `${what}失败：${dir}（${detail}）`, {
      context: { dir, args, gitMessage: detail },
    });
  }
}

/** 路径是不是「存在且是目录」 */
function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** 是不是 git 工作树内（`git rev-parse --is-inside-work-tree`）；抛错一律折成 false */
export function isGitRepo(dir: string): boolean {
  if (!isDirectory(dir)) return false;
  try {
    return execute(dir, ['rev-parse', '--is-inside-work-tree']).trim() === 'true';
  } catch {
    return false;
  }
}

/**
 * 校验目录并回显仓库名 + 当前分支；失败抛 NOT_A_GIT_REPO（含路径与 git 原文）。
 * 分三层给出不同的中文原因，因为处置完全不同：
 *   ① 路径不存在 → 「不存在」（不要去执行 git，否则 ENOENT 会被误报成「不是仓库」）；
 *   ② 路径不是目录 / 不在工作树内 → 「不是 git 仓库」（裸仓库也归这里：它没有工作树，checkout 不了）；
 *   ③ 在仓库里但取不到分支（detached HEAD 之外的异常）→ 「无法确定当前分支」。
 * 仓库名取 `rev-parse --show-toplevel` 的**目录名**而不是传入路径的最后一段：
 * 用户完全可能填仓库里的子目录（`D:/repo/packages`），那时仓库名仍应是 `repo`。
 */
export function resolveRepoInfo(repoPath: string): RepoInfo {
  if (!existsSync(repoPath)) {
    throw new ServiceError('NOT_A_GIT_REPO', `仓库路径不存在：${repoPath}`, { context: { repoPath } });
  }

  /**
   * **一条命令取三样**（早先是 3 条：`isGitRepo` 的 `--is-inside-work-tree`、`--show-toplevel`、
   * `--abbrev-ref HEAD`，失败路径上还要第 4 条去捞 git 原文）。`rev-parse` 会把请求的每一项
   * 各打一行，顺序与参数一致（实测 git 2.47.0.windows.2）。
   * 为什么值得合：本机的计价单位是进程创建（≈0.5s/次），而 api 的每次 `createCase` /
   * `updateCase` / `validateRepo` 都要过这里（`api/cases.ts` 有 3 个调用点）——
   * 一条命令省两次进程创建，用例服务那十几条真实 git 的用例全都在关键路径上。
   */
  let inside = '';
  let topLevel = '';
  let branch = '';
  try {
    const output = execute(repoPath, ['rev-parse', '--is-inside-work-tree', '--show-toplevel', '--abbrev-ref', 'HEAD']);
    [inside = '', topLevel = '', branch = ''] = output.split('\n').map((line) => line.trim());
  } catch (error) {
    const detail = gitMessage(error);
    // 裸仓库：`--is-inside-work-tree` 会说 false，而 `--show-toplevel` 直接以
    // `fatal: this operation must be run in a work tree` 非零退出。两者都归「不是 git 仓库」，
    // 但文案要保留原来那句「该目录不在 git 工作树内」（界面与守卫都按它读）。
    const workTreeDetail = /must be run in a work tree/i.test(detail) ? '该目录不在 git 工作树内' : detail;
    throw new ServiceError('NOT_A_GIT_REPO', `不是 git 仓库：${repoPath}（${workTreeDetail}）`, {
      context: { repoPath, gitMessage: detail },
    });
  }
  if (inside !== 'true') {
    throw new ServiceError('NOT_A_GIT_REPO', `不是 git 仓库：${repoPath}（该目录不在 git 工作树内）`, {
      context: { repoPath },
    });
  }
  if (branch === '') {
    throw new ServiceError('NOT_A_GIT_REPO', `无法确定当前分支：${repoPath}`, { context: { repoPath } });
  }

  // 盘根（`D:\`）作仓库根时 basename 会给出空串，此时退回完整路径，避免界面显示一个空仓库名
  const repoName = basename(topLevel) || topLevel;
  log.debug('仓库校验通过', { repoPath, repoName, branch });
  // RepoInfo 契约新增的四个字段对本地来源是常量取值：远端那套（镜像路径 / 就绪 / 更新时间 / tip）
  // 一律为 null / false，按 kind 决定回显哪一套
  return { repoPath, repoName, branch, kind: 'local', mirrorPath: null, mirrorReady: false, mirrorFetchedAt: null, tip: null };
}

/**
 * 判定 commit 存在（`git rev-parse --verify <hash>^{commit}`），返回完整 40 位 hash；失败抛 INVALID_REF。
 * `^{commit}` 不能省：没有它，一个 blob / tree 的 hash 也会被判定为「存在」（实测报
 * `expected commit type, but the object dereferences to blob type` 并非零退出）。
 * 返回全量 hash 而不是原样回显输入——短哈希与 `HEAD~1` 这类写法都要归一成可比较的形态。
 *
 * **一条命令而不是两条**：早先是 `cat-file -e` 判存在 + `rev-parse` 取全量 hash（2 个进程），
 * 而 `--verify` 一条就能同时给出两者（实测：短 hash 归一成 40 位、blob 与非 commit 对象非零退出、
 * 不存在的 hash 非零退出），在「每次 git 进程创建 ≈ 0.5s」的机器上每行准备省一次。
 * **不加 `--quiet`**：它会连 stderr 一起吃掉，`context.gitMessage` 就空了——那是区分
 * 「hash 不存在」与「仓库坏了 / index.lock 被占」的唯一线索。
 * 失败原因合成一条中文文案（早先 `cat-file` 与 `rev-parse` 各有一条，而调用方无法分辨两者，
 * 两条文案只会让同一种失败看起来像两种）。
 */
export function assertCommit(repoPath: string, hash: string): string {
  if (hash.trim() === '') {
    throw new ServiceError('INVALID_REF', `commit 不能为空（留空请用 null 表示「默认分支 HEAD」）：${repoPath}`, {
      context: { repoPath, hash },
    });
  }
  try {
    return execute(repoPath, ['rev-parse', '--verify', `${hash}^{commit}`]).trim();
  } catch (error) {
    throw new ServiceError('INVALID_REF', `commit 不存在：${hash}（仓库：${repoPath}）`, {
      context: { repoPath, hash, gitMessage: gitMessage(error) },
    });
  }
}

/** 最近 n 条提交（`git log --format=%h%x09%s -n <limit>`），默认 20；`ref` 只给远端候选那条路用 */
export function listCommits(repoPath: string, limit = 20, ref: string | null = null): CommitCandidate[] {
  let output: string;
  try {
    // ref 只在远端候选那条路上给（镜像里的具体 ref）；不给时与既有行为逐字相同（读 HEAD）
    const args = ['log', '--format=%h%x09%s', '-n', String(limit), ...(ref === null ? [] : [ref])];
    output = execute(repoPath, args);
  } catch (error) {
    // 还没有任何提交（or `HEAD` 不可解析）时 `git log` 以 128 退出：这不是错误，
    // 用例表单在首次提交前也要能打开，故返回空数组；其它失败照抛。
    const message = gitMessage(error);
    if (message.includes('does not have any commits') || message.includes('unknown revision')) {
      log.debug('仓库还没有提交，commit 候选为空', { repoPath });
      return [];
    }
    throw new ServiceError('NOT_A_GIT_REPO', `读取提交历史失败：${repoPath}（${message}）`, {
      context: { repoPath, gitMessage: message },
    });
  }

  return output
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line !== '')
    .map((line) => {
      // 只按**第一个**制表符切分：提交信息里可以有制表符，hash 里不可能有
      const tabIndex = line.indexOf('\t');
      if (tabIndex < 0) return { hash: line, subject: '' };
      return { hash: line.slice(0, tabIndex), subject: line.slice(tabIndex + 1) };
    });
}

/**
 * 用例级本地缓存仓库：不存在才 `git clone <repoPath> <cacheDir>`。
 * 判据是「缓存目录里有没有 `.git`」而不是「目录在不在」：克隆中途失败会留下一个没有 `.git`
 * 的空目录，只看目录存在的话，之后每一轮评测都会拿这个空目录去复制，失败点会被推到 checkout。
 *
 * 缓存**不是**一份可以永久沿用的冻结快照，它是「某一个来源仓库」的克隆，故三件事必须成立：
 *   ① 记录来源（`{cacheDir}/.git/aieval-origin.json`）：来源路径变了（用例改填了另一个仓库）
 *      就重克隆——沿用旧缓存会把**另一个仓库**的内容当成被测对象，而且完全静默；
 *   ② `commitHash === null`（语义是「默认分支 HEAD」）必须在用之前把缓存
 *      刷新到来源当前的 HEAD：本地路径 `git fetch` 很便宜，而「缓存只建一次」若顺带把 tip 冻结在
 *      克隆那一刻，「默认分支 HEAD」就成了「上次克隆时的 HEAD」——来源新增的提交不会被评测；
 *   ③ 请求了具体 `commitHash` 而缓存里没有（来源在缓存建立之后才有的提交）先 `git fetch` 一次再判，
 *      仍没有才报 INVALID_REF，且 message 点名**来源仓库路径**：用例域校验这个 hash 用的是来源仓库，
 *      错误信息里出现行工作区路径会把用户指向完全无关的地方。
 * 来源记录放 `.git` 里面而不是工作树根：工作树根的文件会被 `copyWorkspace` 复制进行工作区，
 * 再被 `git status` 当成「agent 新建的文件」计入三样 diff 与界面的文件树（污染评分输入）。
 */
export function ensureCaseCache(repoPath: string, cacheDir: string, commitHash: string | null = null): void {
  // 来源路径归一成真实路径：同一个仓库用不同写法（尾部分隔符 / 8.3 短名 / 大小写）传进来时不该被当成换了来源
  const source = resolveRepoPathKey(repoPath);
  if (!existsSync(join(cacheDir, '.git'))) {
    cloneCaseCache(source, cacheDir);
    return;
  }

  const recorded = readCacheOrigin(cacheDir);
  if (recorded === null) {
    // 没有来源记录：本改动之前建的旧缓存，或克隆中途失败留下的半成品（`.git` 已建出来但内容不全）。
    // 两者都无法证明缓存来自哪个仓库，重建是唯一安全的处置（代价只是多克隆一次）。
    log.info('用例缓存没有来源记录，重新克隆', { cacheDir, repoPath: source });
    cloneCaseCache(source, cacheDir);
    return;
  }
  if (recorded.repoPath !== source) {
    log.info('用例缓存来源已变，重新克隆', { cacheDir, was: recorded.repoPath, now: source });
    cloneCaseCache(source, cacheDir);
    return;
  }

  if (commitHash === null) {
    refreshCacheToSourceHead(source, cacheDir);
    // 刷新后重记一次 tip 与时间：这份记录同时是排查「这一轮到底评测了哪个提交」的入口
    writeCacheOrigin(source, cacheDir);
    return;
  }
  if (hasCommitObject(cacheDir, commitHash)) {
    log.debug('用例缓存已存在且含请求的 commit', { cacheDir, commitHash });
    return;
  }

  // 只抓一次：本地路径抓取很便宜，而它正是「来源在缓存建立之后新增的提交」能补齐的原因
  let fetchDetail = '';
  try {
    execute(cacheDir, ['fetch', '--quiet', 'origin']);
  } catch (error) {
    // 抓取失败**不在这里抛**：真正的结论是「找不到这个 commit」，抓取失败只是它的一种成因。
    // 让 NOT_A_GIT_REPO 之类的 code 盖掉 INVALID_REF 的归因会把用户指向错误的处置方向；
    // 原文进 message 与 context，供人区分「来源被删」与「hash 真的不存在」。
    fetchDetail = gitMessage(error);
  }
  if (hasCommitObject(cacheDir, commitHash)) {
    log.info('用例缓存抓取后拿到了请求的 commit', { cacheDir, commitHash });
    return;
  }
  throw new ServiceError(
    'INVALID_REF',
    `commit 不存在：${commitHash}（来源仓库：${source}；已在用例缓存中执行 git fetch` +
      `${fetchDetail === '' ? '' : `，但抓取失败（${fetchDetail}）`}，仍找不到该 commit）`,
    { context: { repoPath: source, cacheDir, commitHash, gitMessage: fetchDetail } },
  );
}

/** 来源记录的落点：缓存仓库的 `.git` 内（见 `ensureCaseCache` 的 JSDoc：工作树根会被复制进行工作区） */
function cacheOriginFile(cacheDir: string): string {
  return join(cacheDir, '.git', 'aieval-origin.json');
}

/** 来源记录：来源仓库路径（唯一参与判定的字段）+ 记录时的 tip 与时间（仅供排查） */
interface CacheOriginRecord {
  repoPath: string;
  tip: string;
  recordedAt: string;
}

/** 来源路径的归一形态；拿不到真实路径（不存在 / 没权限）时退回原字符串，让后续的 clone / fetch 去报错 */
function resolveRepoPathKey(repoPath: string): string {
  try {
    return realpathSync(repoPath);
  } catch {
    return repoPath;
  }
}

/** 读来源记录；文件不存在 / 内容不可解析 / 缺 `repoPath` 一律当「没有记录」，由调用方重建缓存 */
function readCacheOrigin(cacheDir: string): CacheOriginRecord | null {
  const file = cacheOriginFile(cacheDir);
  if (!existsSync(file)) return null;
  try {
    // 容忍 BOM（与 event-log 同口径）：外部工具编辑过的 JSON 首行会带 U+FEFF，JSON.parse 直接抛
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { repoPath, tip, recordedAt } = parsed as Partial<CacheOriginRecord>;
    if (typeof repoPath !== 'string' || repoPath === '') return null;
    return {
      repoPath,
      tip: typeof tip === 'string' ? tip : '',
      recordedAt: typeof recordedAt === 'string' ? recordedAt : '',
    };
  } catch (error) {
    log.warn('用例缓存的来源记录不可解析，按「没有来源记录」处理', { file, error });
    return null;
  }
}

/** 写来源记录；失败只 WARN——记录写不进去的后果是「下一次调用重建缓存」，不该让本轮评测失败 */
function writeCacheOrigin(repoPath: string, cacheDir: string): void {
  try {
    const record: CacheOriginRecord = { repoPath, tip: headCommit(cacheDir), recordedAt: new Date().toISOString() };
    writeFileSync(cacheOriginFile(cacheDir), `${JSON.stringify(record)}\n`, 'utf8');
  } catch (error) {
    log.warn('写入用例缓存的来源记录失败（下一次调用会重建缓存）', { cacheDir, error });
  }
}

/** 仓库当前的 HEAD（只用于诊断字段，读不到就给空串） */
function headCommit(dir: string): string {
  try {
    return execute(dir, ['rev-parse', 'HEAD']).trim();
  } catch {
    return '';
  }
}

/** 某个 commit 在不在这份仓库里（`^{commit}` 与 `assertCommit` 同一口径：blob / tree 不算） */
function hasCommitObject(dir: string, hash: string): boolean {
  try {
    execute(dir, ['cat-file', '-e', `${hash}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

/** 建缓存克隆：建父目录 → 清残留 → clone → 写来源记录（不存在 / 换源 / 无来源记录三条路都走它） */
function cloneCaseCache(repoPath: string, cacheDir: string): void {
  const parent = join(cacheDir, '..');
  mkdirSync(parent, { recursive: true });
  // 残留的半成品目录会让 clone 以「目标目录非空」失败，先清掉
  rmSync(cacheDir, { recursive: true, force: true });
  try {
    execute(parent, ['clone', '--quiet', repoPath, cacheDir]);
  } catch (error) {
    throw new ServiceError('NOT_A_GIT_REPO', `克隆用例缓存失败：${repoPath} → ${cacheDir}（${gitMessage(error)}）`, {
      context: { repoPath, cacheDir, gitMessage: gitMessage(error) },
    });
  }
  writeCacheOrigin(repoPath, cacheDir);
  log.info('用例缓存已克隆', { repoPath, cacheDir });
}

/**
 * 把已有缓存刷新到来源仓库当前的 HEAD（`commitHash: null` 的语义 = 默认分支 tip）：`git fetch` + `reset --hard`。
 * `reset --hard` 丢掉缓存工作树里的脏改动**是要的**：缓存是来源的只读快照，agent 的改动在行工作区里；
 * 缓存脏着会让「复制出的工作区 == 来源 tip」这个前提不成立，行里凭空出现没人改过的改动。
 * 来源不可达（路径被删 / 移走）时**抛错而不是沿用旧缓存**：此时「默认分支 HEAD」根本无法确定，
 * 沿用等于把一个用户已经看不到的快照当成当前代码来评分（那类静默错分）。
 */
function refreshCacheToSourceHead(repoPath: string, cacheDir: string): void {
  const target = sourceHeadCommit(repoPath);
  // 仓库在、但还没有任何提交（unborn HEAD）：没有可刷新的 tip，把报错留给 checkoutRow 去说
  if (target === null) return;
  try {
    execute(cacheDir, ['fetch', '--quiet', 'origin']);
  } catch (error) {
    const detail = gitMessage(error);
    throw new ServiceError('NOT_A_GIT_REPO', `无法从来源仓库抓取最新提交（缓存：${cacheDir}）：${repoPath}（${detail}）`, {
      context: { repoPath, cacheDir, gitMessage: detail },
    });
  }
  if (!hasCommitObject(cacheDir, target)) {
    // 来源 HEAD 指向的提交在抓取后仍不可达（detached HEAD 且已无分支指向它）：fetch 拿不到那个对象，
    // 重建缓存是唯一能保证「复制出的工作区 == 来源 HEAD」的手段
    log.info('来源 HEAD 不在抓取结果里，重建用例缓存', { repoPath, cacheDir, target });
    cloneCaseCache(repoPath, cacheDir);
    return;
  }
  try {
    execute(cacheDir, ['reset', '--quiet', '--hard', target]);
  } catch (error) {
    const detail = gitMessage(error);
    throw new ServiceError('INTERNAL', `刷新用例缓存失败（无法重置到来源 HEAD）：${cacheDir}（${detail}）`, {
      context: { repoPath, cacheDir, target, gitMessage: detail },
    });
  }
  log.info('用例缓存已刷新到来源的默认分支 tip', { repoPath, cacheDir, target });
}

/** 来源仓库当前的 HEAD：仓库不在 / 不是仓库 → NOT_A_GIT_REPO；仓库在但还没有提交（unborn HEAD）→ null */
function sourceHeadCommit(repoPath: string): string | null {
  try {
    const head = execute(repoPath, ['rev-parse', 'HEAD']).trim();
    return head === '' ? null : head;
  } catch (error) {
    if (isGitRepo(repoPath)) {
      log.debug('来源仓库还没有提交，用例缓存无需刷新', { repoPath });
      return null;
    }
    const detail = gitMessage(error);
    throw new ServiceError('NOT_A_GIT_REPO', `无法读取来源仓库的 HEAD：${repoPath}（${detail}）`, {
      context: { repoPath, gitMessage: detail },
    });
  }
}

/**
 * 文件系统级目录复制：缓存 → 行工作区；目标父目录不存在则创建。
 * 为什么不是每行 `git clone`：本地路径克隆仍是完整对象复制与打包传输，
 * 而缓存已是完整仓库，复制出的目录直接 `checkout` 即可——每行准备时间从「克隆耗时」
 * 降到「磁盘复制耗时」，这是「开一轮评测」秒开的关键。
 * `cpSync` 会连同 `.git` 一起复制，这正是我们要的（复制出来的必须是个能 checkout 的仓库）。
 */
export function copyWorkspace(srcDir: string, destDir: string): void {
  if (!existsSync(join(srcDir, '.git'))) {
    // INTERNAL 而不是 NOT_A_GIT_REPO：NOT_A_GIT_REPO 留给**用户填的仓库路径**，
    // 而这里坏掉的是我们自己建出来的缓存（`.git` 被手工删了 / 克隆中途失败）。给用户看「不是 git 仓库」
    // 会让他去改用例里的仓库路径——方向完全错，真正该做的是把这个缓存目录删掉重跑。
    throw new ServiceError('INTERNAL', `用例缓存不是 git 仓库（缓存状态损坏，删除该缓存目录后重跑即可）：${srcDir}`, {
      context: { srcDir },
    });
  }
  mkdirSync(join(destDir, '..'), { recursive: true });
  try {
    cpSync(srcDir, destDir, { recursive: true });
  } catch (error) {
    throw new ServiceError(
      'INTERNAL',
      `复制工作区失败：${srcDir} → ${destDir}（${error instanceof Error ? error.message : String(error)}）`,
      { cause: error },
    );
  }
  log.debug('工作区已复制', { srcDir, destDir });
}

/**
 * 解析「默认分支 HEAD」（`commitHash === null` 的语义），返回 40 位具体 hash。
 * 为什么不直接 `rev-parse HEAD`：重跑同一行时工作区的 HEAD 已经切在 `test/{rowId}` 上，
 * 而那是个**已经前移**的分支（上一轮 agent 的提交）——拿它当基线等于「以上一轮的产出为起点」，
 * 第二轮 diff 会变成空的，评分模型据此给出错误的高分（要防的正是这个）。
 * 两条路径：
 *   ① HEAD 不在行分支上（全新工作副本的常态：prepareRowWorkspace 每次清掉行目录再复制）
 *      → HEAD 就是默认分支的 tip，与 `rev-parse HEAD` 等价；
 *   ② HEAD 已在行分支上（同一个工作区被重跑）→ 从本地分支表里排除**行分支与整个 `test/*`
 *      命名空间**后取那一个。为什么要连整个命名空间一起排除：同一用例下多候选行各自
 *      建 `test/{rowId}`，重跑某一行时别的行分支还留在工作区里；只排自己那一个会把它们当成
 *      默认分支候选，于是「多候选」误报成不唯一，重跑直接失败。
 * ② 成立的前提（必须写在这里而不只是体现在代码里）：用例缓存来自
 * `git clone <本地路径>`，而本地路径克隆**只建一个本地分支**——来源仓库的默认分支；
 * 其余分支都被映射成 `refs/remotes/origin/*` 远程跟踪引用。于是工作区的本地分支集合
 * 在行分支建立前是 {默认分支}，建立后是 {默认分支, test/rowId}，排除行分支后必然唯一。
 * 一旦这个前提不成立（本地分支 0 个或 ≥2 个），说明工作区不是「我们克隆 + 复制」出来的，
 * 此时**报错而不是随手挑一个**：挑错会让 diff 悄悄变成空，那是最坏的失败模式
 * （静默给出错误高分），宁可让这一行明确失败。
 */
function resolveBaselineCommit(dir: string, rowBranch: string): string {
  let current = '';
  try {
    current = execute(dir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  } catch {
    // 还没有任何提交时 `HEAD` 不可解析：交给 assertCommit 去给出 INVALID_REF 的中文原因
    current = '';
  }
  if (current !== rowBranch) return assertCommit(dir, 'HEAD');

  const candidates = execute(dir, ['for-each-ref', '--format=%(refname:short)', 'refs/heads'])
    .split('\n')
    .map((line) => line.trim())
    .filter((name) => name !== '' && name !== rowBranch && !name.startsWith(ROW_BRANCH_PREFIX));
  const only = candidates.length === 1 ? candidates[0] : undefined;
  if (only === undefined) {
    throw new ServiceError(
      'INTERNAL',
      `无法确定默认分支：${dir}（HEAD 已在 ${rowBranch} 上，除它之外的本地分支有 ` +
        `${candidates.length} 个：${candidates.join('、') || '（一个都没有）'}）`,
      { context: { dir, branch: rowBranch, candidates } },
    );
  }
  return assertCommit(dir, only);
}

/**
 * 在工作副本里取基线并建行分支：checkout <commit> → checkout -b <branch>。
 * 用 `checkout -B` 一条命令同时办成两件事：把分支重置到基线并切过去。
 * 为什么是 `-B` 而不是 `-b`：重跑同一行时 `test/{rowId}` 已存在，`-b` 会直接以
 * 「分支已存在」失败；`-B` 等价于「先删旧分支再建」，且是原子的。
 * `baselineCommit` 返回的是**解析后的 40 位具体 hash**：`commitHash: null`（用默认分支 HEAD）时
 * 必须把默认分支解析成具体值，否则后面没有可比基线（见 resolveBaselineCommit）。
 * 先 `assertCommit` 再切换：否则失败会留下一个「切了一半」的工作区，错误码也分不清是
 * 「commit 不存在」还是「checkout 失败」。
 */
export function checkoutRow(
  dir: string,
  commitHash: string | null,
  branch: string,
): { baselineCommit: string } {
  const target = commitHash === null ? resolveBaselineCommit(dir, branch) : assertCommit(dir, commitHash);
  try {
    execute(dir, ['checkout', '--quiet', '-B', branch, target]);
  } catch (error) {
    throw new ServiceError('INTERNAL', `建立行分支失败：${branch}（${gitMessage(error)}）`, {
      context: { dir, branch, target },
    });
  }
  log.info('行分支已建立', { dir, branch, baselineCommit: target });
  return { baselineCommit: target };
}

/** 三样 diff 的段落标题（供评分模型与 diff 抽屉共用；改文案要同步改测试与界面的展示） */
const SECTION_COMMITTED = '### 已提交改动';
const SECTION_UNCOMMITTED = '### 未提交改动';
const SECTION_UNTRACKED = '### 未跟踪文件';
/** 段落为空时的占位：显式写「（无）」，避免「这一段落不存在」与「这一段落为空」被混为一谈 */
const EMPTY_SECTION = '（无）';
/** 裁剪标记（要求显式标明，否则评分模型会把「看不到的改动」当成「没改」） */
const TRUNCATED_MARK = '\n\n> **diff 已截断**：以下文件因超出体积上限未包含在本次评分输入中';

/**
 * 三样 diff 合并 + 计数。
 * `baselineCommit` 必须是具体 hash：空串（「尚未准备」）在函数第一行就抛 INTERNAL，
 * 绝不降级成 `HEAD..HEAD` 的空 diff（理由见那里的行内注释）。
 * 读取次序是**刻意选定**的（①→⑤，本机实测于 `git version 2.47.0.windows.2`），但**顺序本身不承重**：
 *   ① `git status --porcelain -z` 先读未跟踪清单：第三个来源就是 `??` 清单，
 *      先读也让 `parseUntracked` 的主用例保持为 `?? `（实测 `-N` 之后同一份输出里
 *      `?? brand-new.txt` 会变成 ` A brand-new.txt`）。**但这是冗余保险，不是硬约束**：
 *      `parseUntracked` 同时接受 `?? ` 与 ` A `，把本行挪到 ② 之后没有任何可观测差异——
 *      变异验证：整套 `git-diff-*.test.ts`（29 条）仍绿。真正保住结果的是「接受 ` A `」那次放宽；
 *      若日后把它收窄回只认 `?? `，本行的顺序就**重新**变成承重的。
 *   ② `git add --intent-to-add --all`：只**登记**不暂存（实测登记后 `tracked.txt` 仍是 ` M`），
 *      让未跟踪文件的正文进入 `git diff HEAD`。不加它，新文件只有文件名——评分模型看不见内容，
 *      会把「看不到的改动」当成「没改」，静默给出错误的高分。
 *      **被 gitignore 的文件不进 diff**：`git add` 没有 `--include-ignored` 这个选项
 *      （实测同一版本报 `error: unknown option 'include-ignored'` 并非零退出），而且忽略本身就是
 *      「这不是产出」的信号——把 `.env` 的正文送进评分是密钥泄漏，把 `node_modules`
 *      送进去是噪声淹没真改动。第三个来源也只说 `??` 未跟踪文件。
 *   ③ `git diff HEAD --numstat`：已改未提交的「文件 → 增删行数」。**必须在 ② 之后读**：
 *      实测登记前它只给出 `1\t0\ttracked.txt`（未跟踪的新文件根本不出现），登记后才多出
 *      `1\t0\tbrand-new.txt`。三个计数与 `files` 要把未跟踪文件算进去（
 *      三个来源缺一不可），故这一次读取不能提到 ② 之前。
 *   ④ `git diff {baseline}..HEAD` + `git diff HEAD`：已提交与已改未提交的两份正文。
 *   ⑤ 已提交部分的计数用 `git diff --numstat {baseline}..HEAD`（不受 `-N` 影响，随时可读）。
 * 计数一律取 `--numstat` 的原始两列，不自己解析 `diff --git` 块：重命名与二进制文件的行数
 * 口径只有 git 自己算得对（二进制文件的两列是 `-`，按 0 计入并在文件清单里如实显示）。
 */
export function collectDiff(
  dir: string,
  baselineCommit: string,
): {
    text: string;
    files: { path: string; insertions: number; deletions: number }[];
    filesChanged: number;
    insertions: number;
    deletions: number;
  } {
  // 空基线必须在这里拦住：`git diff ..HEAD` 会被 git 当成 `HEAD..HEAD`，退出码 0、输出为空，
  // 于是「准备阶段失败、baselineCommit 还空着」的行会拿到一份**看起来没改动**的 diff 并照常打分
  //（最坏的那类失败：静默给出错误的高分）。空串的语义是「尚未准备」，
  // 它不是合法基线，调用方也无法从返回值里看出基线是空的，故只能在这里抛。
  if (baselineCommit.trim() === '') {
    throw new ServiceError('INTERNAL', `基线 commit 为空（空串表示「尚未准备」，见 §11 R2）：${dir}`, {
      context: { dir, baselineCommit },
    });
  }

  // ① 必须在 ② 之前：见上面 JSDoc 的顺序说明
  const untracked = parseUntracked(executeOrFail(dir, ['status', '--porcelain', '-z'], '读取未跟踪清单'));

  executeOrFail(dir, ['add', '--intent-to-add', '--all'], '登记未跟踪文件');

  // ③+④ 与 ⑤ 各合并成**一次** `git diff`：`--numstat -p` 一次进程同时给出计数与正文
  // （实测：numstat 的每一行在前、补丁块从第一行行首的 `diff --git ` 开始；两条命令的输出
  // 逐字节相同，只是省掉一次进程创建——本机进程创建 ≈ 0.5s/次，一个用例调两次 collectDiff
  // 就少起 2 个进程）。切分口径见 splitNumstatPatch。
  // ③ 必须在 ② 之后：未跟踪文件的增删两列只有登记之后才出现在 numstat 里。
  const uncommittedRaw = executeOrFail(dir, ['diff', '--numstat', '--no-color', '-p', 'HEAD'], '读取未提交改动');

  const committedRaw = executeOrFail(
    dir,
    ['diff', '--numstat', '--no-color', '-p', `${baselineCommit}..HEAD`],
    '读取已提交改动',
  );

  const uncommittedFiles = parseNumstat(splitNumstatPatch(uncommittedRaw).counts);
  const committed = splitNumstatPatch(committedRaw).patch.trimEnd();
  const uncommitted = splitNumstatPatch(uncommittedRaw).patch.trimEnd();
  const committedFiles = parseNumstat(splitNumstatPatch(committedRaw).counts);

  // 未跟踪段的正文**只有路径清单**（钉死的格式）：界面直接渲染这段文本，
  // 早先这里还拼了一段 `uncommitted`，结果是同一份 diff 在文本里出现两次、受跟踪文件的
  // hunk 挂在「未跟踪文件」标题下面，还会让 truncateDiff 报「某文件被丢弃」而它的孪生正文
  // 仍在文本里。新文件的正文不会因此丢失：它本来就在未提交段里（`-N` 之后 `git diff HEAD` 带它）。
  const text = [
    `${SECTION_COMMITTED}（${baselineCommit}..HEAD）`,
    committed === '' ? EMPTY_SECTION : committed,
    '',
    `${SECTION_UNCOMMITTED}（工作区 vs HEAD）`,
    uncommitted === '' ? EMPTY_SECTION : uncommitted,
    '',
    SECTION_UNTRACKED,
    untracked.length === 0 ? EMPTY_SECTION : untracked.join('\n'),
    '',
  ].join('\n');

  const files = mergeFilesByPath([...committedFiles, ...uncommittedFiles]);
  const filesChanged = files.length;
  const insertions = files.reduce((sum, file) => sum + file.insertions, 0);
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0);

  log.debug('diff 已合并', {
    dir,
    baselineCommit,
    filesChanged,
    insertions,
    deletions,
    untracked: untracked.length,
  });
  return { text, files, filesChanged, insertions, deletions };
}

/**
 * 把 `git diff --numstat -p` 的**一次**输出切成「计数段」与「补丁段」。
 *
 * 实测（git 2.47.0.windows.2）：计数段在前（每行 `<插入>\t<删除>\t<路径>`），补丁段从
 * **第一行行首的** `diff --git ` 开始。切分点只看行首：补丁正文里也会出现 `diff --git`
 * 这样的字符串（改动的就是一份 diff 文本时），按子串切会把正文当成计数段——
 * 于是 `filesChanged` 凭空多出几个文件，而正文被从「已改未提交」段里切掉。
 *
 * 没有 `diff --git` 时整段都是计数段（补丁为空）：无改动的 diff 与只有二进制改动的 diff
 * 都会走这条（后者的计数行是 `-\t-\tpath`，正文里没有可读的 hunk）。
 */
function splitNumstatPatch(output: string): { counts: string; patch: string } {
  const firstPatchLine = /^diff --git /m.exec(output);
  if (firstPatchLine === null) return { counts: output, patch: '' };
  return { counts: output.slice(0, firstPatchLine.index), patch: output.slice(firstPatchLine.index) };
}

/**
 * 按路径合并同一文件的两段计数。
 * 为什么必须合并：一个文件完全可以既在 `baseline..HEAD` 里改过、又在工作区里再改一次，
 * 两段 numstat 于是各给一行；不合并的话 `filesChanged` 会把同一个文件数两次，
 * 界面的文件树也会出现两行同名条目。
 * 合并口径：键是**归一后的新路径**（见 parseNumstat），增删行数**相加**——展示的是
 * 「这条路径相对 baseline 一共变了多少」；`text` 里的两段 hunk 原样保留，不做任何合并
 * （那是评分模型的真相，diff 抽屉也要按段展示）。
 */
function mergeFilesByPath(
  files: { path: string; insertions: number; deletions: number }[],
): { path: string; insertions: number; deletions: number }[] {
  const merged = new Map<string, { path: string; insertions: number; deletions: number }>();
  for (const file of files) {
    const existing = merged.get(file.path);
    if (existing === undefined) {
      // 存副本：调用方拿到的是新对象，后续不会再被这里的累加改到
      merged.set(file.path, { ...file });
      continue;
    }
    existing.insertions += file.insertions;
    existing.deletions += file.deletions;
  }
  return [...merged.values()];
}

/**
 * `git status --porcelain -z` → 未跟踪（含「已登记未跟踪」）文件清单。
 * 记录格式是「两个状态字符 + 空格 + 路径」，记录间用 NUL 分隔，故不能用 `split('\n')`：
 * 路径里可以有换行。
 * 两种状态都算这一类：
 *   ① `?? ` 尚未登记的新文件；
 *   ② ` A ` 已被 `git add --intent-to-add` 登记的新文件（**实测**：登记之后 `??` 会变成 ` A`）。
 * 为什么必须收 ②：`collectDiff` 自己就会跑 `-N`，同一个工作区里的第二次调用看到的是 ` A`——
 * 只认 `??` 会让第二次调用的未跟踪段变成「（无）」，同一个文件从「新文件」漂移成「已改文件」
 * （正文不会丢，它仍在未提交段里，但分类必须稳定）。
 * 注意 ` A `（Y=「已加到工作区」= intent-to-add）与 `A `（X=「已暂存的新文件」）不是一回事：
 * 后者是调用方**已经 `git add`** 的文件，属于「已暂存改动」，不该被算成未跟踪。
 */
function parseUntracked(output: string): string[] {
  return output
    .split('\0')
    .filter((record) => record !== '')
    .filter((record) => record.startsWith('?? ') || record.startsWith(' A '))
    .map((record) => record.slice(3));
}

/**
 * `git diff --numstat` → 「路径 + 增删行数」清单（供 `RowDiff.files` 与三个计数）。
 * 每行形如 `<插入>\t<删除>\t<路径>`（实测 `1\t1\ta.txt`）。
 * 三种需要处理的形态：
 *   ① 二进制文件的两列是 `-`（实测），按 0 计；
 *   ② 重命名会把路径写成 `old => new`（两条路径没有公共前后缀时）或 `prefix/{old => new}/suffix`
 *      （有公共前后缀时，实测 `packages/{old => new}/x.ts`），只取「改完之后叫什么」那一段：
 *      无花括号的取 `=>` 之后，有花括号的**就地把 `{old => new}` 换成 `new`**，前后缀原样保留
 *      （见 rewriteRenamePath：切掉前缀会得到一个不存在的路径）；
 *   ③ 路径里可能有 `\t`（git 只在路径含特殊字符时才加引号，本仓用 `core.quotepath=false`，
 *      故按**前两个**制表符切分，剩下整段都是路径。
 */
function parseNumstat(output: string): { path: string; insertions: number; deletions: number }[] {
  return output
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const [added = '', removed = '', ...rest] = line.split('\t');
      return {
        path: rewriteRenamePath(rest.join('\t')),
        insertions: added === '-' ? 0 : Number(added),
        deletions: removed === '-' ? 0 : Number(removed),
      };
    });
}

/**
 * 把 `--numstat` 的路径列归一成「改动后的新路径」。
 * 花括号形态必须**就地**替换：早先的实现切掉最后一个 `=>` 之前的全部内容，把 `packages/` 前缀
 * 一起丢了，`packages/{old => new}/x.ts` 于是变成 `new/x.ts`——一个根本不存在的路径：
 * 界面的文件树会渲染出幽灵条目，而两个不同目录下的重命名（`a/{old => new}/x.ts` 与
 * `b/{old => new}/x.ts`）还会在按路径去重里撞成同一个键、行数被错误相加。
 * 无花括号形态（`old => new`）按最后一个 `=>` 之后取：git 只在两条路径没有公共前后缀时才这么写，
 * 新路径里不会再出现 `=>`（真的叫这个名字的路径会被 git 加引号，属于另一个议题）。
 *
 * 导出是为了让 `extractDiffFile` 复用同一份归一逻辑：正文段的路径也要过这一遍才能与
 * `--numstat` 的路径对上，两份各写一遍必然漂移。
 */
export function rewriteRenamePath(rawPath: string): string {
  const braced = /\{[^{}]*=>([^{}]*)\}/.exec(rawPath);
  if (braced !== null) {
    // 前缀（`packages/`）与后缀（`/x.ts`）原样保留，只把花括号段换成新名字（` new` 要 trim）
    return `${rawPath.slice(0, braced.index)}${(braced[1] ?? '').trim()}${rawPath.slice(braced.index + braced[0].length)}`.trim();
  }
  const arrow = rawPath.lastIndexOf('=>');
  return (arrow < 0 ? rawPath : rawPath.slice(arrow + 2)).trim();
}

/**
 * 按体积裁剪：按文件切分，保留到预算为止，
 * 输出含「已截断」标记与被丢弃文件清单。
 * 四个必须成立的行为：
 *   ① 被丢弃的文件名要逐个列在正文里——否则界面与评分模型都不知道漏了什么；
 *   ② 即便预算连一个文件都装不下，也**必须**保留段落头与「已截断」标记：
 *      产出一段「看起来没改动」的空文本是最坏的失败（评分模型会给出错误的高分）；
 *   ③ 预算是**字节**（`settings.diffBudgetBytes` 默认 262144），故用 `Buffer.byteLength`
 *      而不是 `string.length`——中文与 emoji 的字符数与字节数差 3 倍，用字符数会超预算；
 *   ④ 累加只算**文件段**，段落头不计入：它是固定的小常量（实测
 *      `### 已提交改动（base..HEAD）\n` = 22 字符 / 36 字节），任何预算下都照 ② 保留，
 *      把它算进预算会让「预算 = 段落头 + 一个文件」这类边界少装下一个文件
 *      （段落头里的中文比字符数多 14 字节，边界上正好差这么多）。
 */
export function truncateDiff(
  text: string,
  budgetBytes: number,
): { text: string; truncated: boolean; droppedFiles: string[] } {
  const { header, pieces } = splitDiffFiles(text);
  if (pieces.length === 0) return { text, truncated: false, droppedFiles: [] };

  const kept: DiffPiece[] = [];
  const dropped: DiffPiece[] = [];
  let used = 0;
  for (const piece of pieces) {
    const size = Buffer.byteLength(piece.text, 'utf8');
    if (used + size <= budgetBytes) {
      kept.push(piece);
      used += size;
      continue;
    }
    dropped.push(piece);
  }

  if (dropped.length === 0) return { text, truncated: false, droppedFiles: [] };
  const droppedFiles = dropped.map((piece) => piece.path);
  return {
    text: `${header}${kept.map((piece) => piece.text).join('')}${truncationNotice(droppedFiles)}`,
    truncated: true,
    droppedFiles,
  };
}

/** 一个文件段 */
interface DiffPiece {
  path: string;
  text: string;
}

/**
 * 按 `diff --git` 边界把文本切成「段落头 + 文件段」。
 * 切分点必须是行首的 `diff --git`：正文里出现同名字符串（比如一个恰好含这行的测试夹具）
 * 不该被当成新的文件段。
 */
function splitDiffFiles(text: string): { header: string; pieces: DiffPiece[] } {
  const chunks = text.split(/(?=^diff --git )/m);
  const header = chunks[0] ?? '';
  const pieces = chunks.slice(1).map((chunk) => {
    const headerMatch = /^diff --git a\/(.+?) b\/(.+)$/m.exec(chunk);
    return { path: headerMatch?.[2] ?? '', text: chunk };
  });
  return { header, pieces };
}

/**
 * 按路径取某一段 diff 原文；路径不存在返回 `undefined`。
 *
 * 路径键必须**两边都归一**：`splitDiffFiles` 从 `diff --git a/X b/Y` 里取的是**原样**路径，
 * 而调用方（索引）手里的路径来自 `--numstat`、已经过 `rewriteRenamePath`。
 * 重命名时 `packages/{old => new}/x.ts` 与 `packages/new/x.ts` 是两个不同的字符串，
 * 只归一一边就会表现为「索引里明明有这个文件，正文永远取不到」——且只在重命名时出现。
 * `rewriteRenamePath` 对已归一的路径是幂等的，故对普通路径无副作用。
 *
 * 同名文件在「已提交」与「未提交」两段都出现时取**未提交**段：
 * 未跟踪文件的正文只在未提交段里（`git add -N` 之后 `git diff HEAD` 才带它），
 * 且未提交段反映工作区**当前**状态，正是使用者打开抽屉要看的。
 */
export function extractDiffFile(text: string, path: string): string | undefined {
  const { pieces } = splitDiffFiles(text);
  const wanted = rewriteRenamePath(path);
  // 倒序找：越靠后的段越「新」（未提交段在已提交段之后），先命中的就是要的那一段
  for (let i = pieces.length - 1; i >= 0; i -= 1) {
    const piece = pieces[i];
    if (piece !== undefined && rewriteRenamePath(piece.path) === wanted) return piece.text;
  }
  return undefined;
}

/** 截断标记 + 被丢弃文件清单（正文里可见，不只是返回值里的一个数组） */
function truncationNotice(droppedFiles: string[]): string {
  return `${TRUNCATED_MARK}\n${droppedFiles.map((file) => `- ${file}`).join('\n')}\n`;
}

