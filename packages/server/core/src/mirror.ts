/**
 * 远端仓库镜像层：把 git 地址物化成工作区根下的**裸镜像**，并把基线解析成具体 hash。
 * 三条口径（spec §5）：
 *   1. 镜像是**缓存**，不是产物：跨用例复用、不随删用例消失、不自动清理；
 *   2. 存在性与更新**分成两个函数**（ensureMirror 不联网、fetchMirror 才联网）——
 *      候选列表要快、校验与评测准备要新鲜，把 fetch 混进 ensure 会让准备路径连着抓两次；
 *   3. 建镜像一律「克隆到 `.tmp-<pid>` → 原子 rename」（RG6）：跨请求并发下不允许出现
 *      被使用的半成品，也不允许一个失败留下让下次 clone 以「目标非空」失败的残留。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ServiceError, normalizeRemoteUrl } from '@aieval/contracts';
import { createLogger } from './logger';
import { execute, gitMessage, isTimeoutKill } from './git-exec';

const log = createLogger('mirror');

/** 探活（ls-remote）的墙钟上限：它只是「能不能连上」的快路径，不该让人等 */
export const REMOTE_PROBE_TIMEOUT_MS = 15_000;
/** 克隆 / 抓取的墙钟上限：大仓库首次克隆的真实代价，超时后给可处置的错误而不是冻住服务 */
export const REMOTE_TRANSFER_TIMEOUT_MS = 600_000;

/**
 * 超时只认**正数**：Node 把 `timeout: 0` 当作**不设超时**（不是「立即超时」），
 * 而 `timeoutMs ?? 默认值` 会让调用方随手传的 0 静默取消整道墙钟保证——那正是 RG3 要的那道。
 * 传非正值在这里回落默认值，是这个缺陷唯一能被拦住的点（git-exec 刻意不做钳制）。
 */
function positiveOr(value: number | undefined, fallback: number): number {
  return value !== undefined && value > 0 ? value : fallback;
}

/**
 * 墙钟时长的说法：不足一分钟按秒说，满一分钟才按分钟说。
 * 探活的默认上限是 15s，只按分钟说会渲染成「超过 0 分钟」——一句没有信息量的话，
 * 而用户正要用它判断「等了多久 / 要不要重试」；抓取的默认上限是 600_000ms，
 * 按分钟说正好是 spec §4.5 的逐字文案「超过 10 分钟」。
 */
function timeoutDurationText(ms: number): string {
  return ms < 60_000 ? `超过 ${Math.round(ms / 1000)} 秒` : `超过 ${Math.round(ms / 60_000)} 分钟`;
}

/**
 * 远端调用的环境与超时：禁交互式提示（RG3，stdin 已在 git-exec 里断开）。
 * SSH 也走非交互（RG4）：`BatchMode=yes` 只在进程环境**没有** `GIT_SSH_COMMAND` 时追加——
 * 用户自己配了 ssh 命令（跳板机、指定 key）就得原样用他的，known_hosts 口径也不替他做决定。
 */
function remoteOptions(timeoutMs?: number): { env: Record<string, string>; timeoutMs: number } {
  const env: Record<string, string> = { GIT_TERMINAL_PROMPT: '0' };
  if (process.env.GIT_SSH_COMMAND === undefined) env.GIT_SSH_COMMAND = 'ssh -o BatchMode=yes';
  return { env, timeoutMs: positiveOr(timeoutMs, REMOTE_TRANSFER_TIMEOUT_MS) };
}

/** 工作区根下的镜像父目录（与 cases / {runId} 平级，RG12：不进任何行工作区） */
export function remotesDir(workspaceRoot: string): string {
  return join(workspaceRoot, 'remotes');
}

/**
 * 镜像目录：`{remotesDir}/{slug}-{sha1(归一后 URL).slice(0,8)}`。
 * 身份判据是 hash 段，slug 只为人眼可读（排查时能一眼看出这是哪个仓库）。
 */
export function mirrorDir(workspaceRoot: string, url: string): string {
  const normalized = normalizeRemoteUrl(url);
  const key = createHash('sha1').update(normalized).digest('hex').slice(0, 8);
  return join(remotesDir(workspaceRoot), `${slugOf(normalized)}-${key}`);
}

/**
 * 就绪判据是**内容**（`HEAD` 是文件且 `objects` 是目录），不是「目录存在」（RG5）。
 * 与 ensureCaseCache（git.ts）同一条口径：目录在 ≠ 内容全，只看目录存在就会把一份残骸
 * 当成可用镜像交给下游复制，失败点被推到 checkout。
 * 这条判据拦得住「空壳目录」，但**拦不住半截克隆**：本机实测 SIGKILL 掉一次 `clone --mirror`，
 * 留下的目录同样有 HEAD 与 objects（内容只到 `objects/pack/tmp_pack_*` 这一步，objects 甚至可能是空的）
 * ——把半成品挡在镜像目录之外是 RG6 的活：克隆只写 tmp 路径，克隆成功才 rename 进镜像目录。
 */
export function isMirrorReady(dir: string): boolean {
  try {
    return statSync(join(dir, 'HEAD')).isFile() && statSync(join(dir, 'objects')).isDirectory();
  } catch {
    return false;
  }
}

/** 镜像记录的落点：镜像仓库根下（它是裸仓库，多一个文件不影响任何 git 操作） */
function mirrorRecordFile(mirrorDir: string): string {
  return join(mirrorDir, 'aieval-mirror.json');
}

/**
 * 读镜像记录。**不参与就绪判据**（判据见 isMirrorReady）：缺失 / 不可解析一律按「没有记录」处理，
 * 由调用方决定要不要重建——记录坏掉不该让一份完好的镜像不可用。
 */
export function readMirrorRecord(mirrorDir: string): { url: string; fetchedAt: string } | null {
  const file = mirrorRecordFile(mirrorDir);
  if (!existsSync(file)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { url, fetchedAt } = parsed as { url?: unknown; fetchedAt?: unknown };
    if (typeof url !== 'string' || url === '' || typeof fetchedAt !== 'string') return null;
    return { url, fetchedAt };
  } catch (error) {
    log.warn('镜像记录不可解析，按「没有记录」处理', { file, error });
    return null;
  }
}

/** 写镜像记录；失败只 WARN——记录写不进去的后果只是「回显少一行更新于」，不该让本次操作失败 */
function writeMirrorRecord(mirrorDir: string, record: { url: string; fetchedAt: string }): void {
  try {
    writeFileSync(mirrorRecordFile(mirrorDir), `${JSON.stringify(record)}\n`, 'utf8');
  } catch (error) {
    log.warn('写入镜像记录失败（回显里会少一行更新时间）', { mirrorDir, error });
  }
}

/**
 * git 失败与文件系统失败的统一出口：中文原因在前、原文在后（spec §4.5）。
 * `errno` 那类失败（Windows 上尤其常见 EPERM / EBUSY / ENOTEMPTY）原文就是 Node 的 message，
 * 它必须跟在中文原因后面进 message 与 context——只有它能把「盘只读」与「目录被别的进程捏着」分开。
 */
function fsReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 建「远端操作的工作目录」= `{workspaceRoot}/remotes`（镜像父目录，也是探活的 cwd）。
 *
 * 为什么失败要折成 NOT_WRITABLE 而不是裸抛 errno：这里建不出目录只有一种成因——**工作区根不可写**
 * （只读盘 / 权限 / 路径被同名文件占住），处置是去设置页换一个根目录，而裸 errno 会被路由层折成
 * 一句「服务端内部错误」（见 apps/web-next/src/server-context.ts），用户拿不到任何可处置的信息。
 * spec §10 最后一行给的就是这条口径（工作区根那一类走 NOT_WRITABLE）。
 */
export function ensureRemotesDir(dir: string): void {
  try {
    mkdirSync(dir, { recursive: true });
  } catch (error) {
    throw new ServiceError('NOT_WRITABLE', `无法创建远端镜像的父目录：${dir}（${fsReason(error)}）`, { cause: error });
  }
}

/**
 * 确保镜像存在：就绪即复用（**不联网**），否则清残留 → 克隆到 tmp → 原子 rename。
 * git 调用的失败经 classifyRemoteFailure 折成带中文原因的 ServiceError；两处前置的文件系统调用
 * （建 remotes 目录、克隆前清残留）也各有各的中文原因（见各自的注释与 spec §10 最后一行）——
 * **裸 errno 一个都不许漏给路由层**，它会被折成一句没有信息量的「服务端内部错误」。
 * 两处**收尾清理**是例外，只 WARN 不抛：克隆失败后那次（下面）、以及 promoteMirror 里那次
 * （改名已经成功时，一句清理 errno 不该把成功说成失败）。
 */
export function ensureMirror(input: { workspaceRoot: string; url: string; timeoutMs?: number }): {
  mirrorDir: string;
  created: boolean;
} {
  const dir = mirrorDir(input.workspaceRoot, input.url);
  const parent = remotesDir(input.workspaceRoot);
  // 生效的墙钟上限算一次、两处共用：传给 git，也传给分类层——
  // 否则注入的亚分钟上限会被文案说成默认的「10 分钟」（用户看到的时长与实际不符）
  const timeoutMs = positiveOr(input.timeoutMs, REMOTE_TRANSFER_TIMEOUT_MS);
  ensureRemotesDir(parent);
  if (isMirrorReady(dir)) return { mirrorDir: dir, created: false };

  // 残留（半成品目录 / 上一次中断的 tmp）先清掉：clone 的目标**必须不存在或为空**
  // （本机实测：目标是非空目录时 git 直接 `fatal: destination path … already exists and is not an empty directory`）。
  // tmp 用 pid 命名，故「上一次中断」只在 pid 复用时撞上，但撞上就是一次必然失败的克隆。
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (error) {
    // 残骸清不掉 = 这份镜像**重建不了**（Windows 上常见：半成品目录被别的进程捏着 → EPERM / EBUSY）。
    // spec §10 最后一行要的就是这句话：<中文原因>：<dir>（<errno 原文>）
    throw new ServiceError('INTERNAL', `远端镜像状态损坏且无法重建：${dir}（${fsReason(error)}）`, {
      context: { mirrorDir: dir, url: input.url },
      cause: error,
    });
  }
  const tmp = `${dir}.tmp-${process.pid}`;
  rmSync(tmp, { recursive: true, force: true });
  try {
    execute(parent, ['clone', '--mirror', '--quiet', input.url, tmp], remoteOptions(timeoutMs));
  } catch (error) {
    // 清理 tmp。清理失败**不能盖掉归因**：远端超时被杀时，Windows 上 git 进程可能还短暂活着
    // 并捏着 tmp 里的句柄（本机实测：被杀的 git 会挂一会儿，它的 cwd 就在 remotes 下），
    // 此时 rmSync 抛 EPERM——用户该看到的是「拉取超时」，不是一句 errno 原文。
    // 残留不致命：下一次 ensureMirror 开头还会再清一次 tmp。
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch (cleanupError) {
      log.warn('克隆失败后清理 tmp 未成功，残留留给下一次调用清理', { tmp, error: cleanupError });
    }
    throw classifyRemoteFailure(error, { url: input.url, what: '克隆远端镜像', timeoutMs });
  }

  const outcome = promoteMirror(tmp, dir);
  // 只有真的克隆出来的那一份才写记录：克隆本身就是一次从远端取回，此刻的「更新于」才是这次取回的时间。
  // 复用既有目录（rename 撞车）时**不写**——那份镜像的时间由建它的那次克隆负责，这里不能替它刷新。
  if (outcome === 'created') {
    writeMirrorRecord(dir, { url: normalizeRemoteUrl(input.url), fetchedAt: new Date().toISOString() });
  }
  log.info('远端镜像已建立', { url: input.url, mirrorDir: dir, outcome });
  return { mirrorDir: dir, created: outcome === 'created' };
}

/**
 * 改名重试预算。
 * 为什么要重试：`renameSync` 在 Windows 上会因**瞬时占用**失败——刚退出的 git 进程、
 * 杀软、索引器都可能短暂捏着 tmp 目录的句柄（EPERM/EBUSY）。实测：2026-09-28 全量并发下
 * `resolveRemoteRef` 那条用例就红在这里（`远端镜像改名失败：…\origin-xxxx`），而独占跑全绿。
 * 这与 `config-store.ts` 文件头登记的是同一类成因（「杀软/索引器瞬时占用——重试就过去了」），
 * 区别只在于这里是**目录**改名、要重试的是它自己。
 * 5 次 × 100ms：最坏多花 400ms，比重新克隆一次（~1s）便宜得多。
 */
const RENAME_ATTEMPTS = 5;
const RENAME_RETRY_DELAY_MS = 100;

/** 同步等待：本模块的改名发生在**同步**路径上（`prepareRowWorkspace` 全程同步），没有 await 可用 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * 把克隆好的 tmp 提升为目标目录。
 * **单独导出**只为让「rename 撞车」这条分支可测：它靠两个请求并发才可达，
 * 而在单进程同步 git 调用下测试无法稳定制造那个窗口。
 * 撞车时的处置是复用既有目录（不覆盖、不报错）：另一个请求建的是同一个 URL 的镜像，内容等价。
 *
 * `rename` 参数是给**瞬时占用**那条路留的注入点（默认就是 `fs.renameSync`）：
 * 真实机器上「前两次 EPERM、第三次成功」这个窗口不可稳定复现，而它正是本函数要处理的一种失败
 * （详见 `RENAME_ATTEMPTS` 的说明）。生产调用方一律不传它。
 */
export function promoteMirror(
  tmpDir: string,
  targetDir: string,
  rename: typeof renameSync = renameSync,
): 'created' | 'reused-existing' {
  let outcome: 'created' | 'reused-existing' | null = null;
  let cause: unknown = null;
  for (let attempt = 1; attempt <= RENAME_ATTEMPTS; attempt += 1) {
    try {
      rename(tmpDir, targetDir);
      outcome = 'created';
      break;
    } catch (error) {
      cause = error;
      // 目标已就绪 = 另一个请求刚建好同一个 URL 的镜像：复用，不覆盖
      if (isMirrorReady(targetDir)) {
        outcome = 'reused-existing';
        break;
      }
      // 还没到上限就等一下再试：区分「瞬时占用」与「目标是个换不掉的目录」只能靠重试的结果
      if (attempt < RENAME_ATTEMPTS) sleepSync(RENAME_RETRY_DELAY_MS);
    }
  }
  // 三种结局下 tmp 都没用了（内容已搬走 / 白克隆一份 / 这次失败要抛），清理只写一处。
  // 清理失败只 WARN：改名已经成功（或已确认可复用）时，一句 errno 不该把成功说成失败；
  // 残留由下一次 ensureMirror 开头那次清理回收（与克隆失败后那次同一处置）。
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch (cleanupError) {
    log.warn('提升镜像后清理 tmp 未成功，残留留给下一次调用清理', { tmp: tmpDir, error: cleanupError });
  }
  if (outcome === null) {
    throw new ServiceError('INTERNAL', `远端镜像改名失败：${tmpDir} → ${targetDir}`, { cause });
  }
  return outcome;
}

/**
 * 更新镜像：`git fetch --prune`（`--mirror` 克隆的 config 里 `remote.origin.mirror=true`，
 * 普通 fetch 即镜像语义的全 refs 同步），随后把镜像 HEAD 对齐到远端当前的默认分支（见 alignDefaultBranch）。
 * 失败**不吞**：调用方必须知道自己读的是不是最新的。
 *
 * `defaultBranch` 是调用方**已经知道**的远端默认分支名（探活的结果）：给了就用它对齐，
 * 省掉一次 `ls-remote`（`validateRepo` 的探活结果是这个值唯一的权威来源）；不给就自己问一次远端。
 */
export function fetchMirror(
  mirrorDir: string,
  url: string,
  options: { timeoutMs?: number; defaultBranch?: string } = {},
): { fetchedAt: string } {
  const timeoutMs = positiveOr(options.timeoutMs, REMOTE_TRANSFER_TIMEOUT_MS);
  try {
    execute(mirrorDir, ['fetch', '--prune', 'origin'], remoteOptions(timeoutMs));
  } catch (error) {
    throw classifyRemoteFailure(error, { url, what: '更新远端镜像', timeoutMs });
  }
  // 抓取之后立刻对齐：`defaultBranchName`（不联网的那条读路径）与「跟随默认分支」的每一轮评测
  // 读的都是镜像 HEAD，而 fetch 不刷新它——这一步是那条语义的承重点，不是可选的收尾
  alignDefaultBranch(mirrorDir, url, options.defaultBranch, timeoutMs);
  const fetchedAt = new Date().toISOString();
  writeMirrorRecord(mirrorDir, { url: normalizeRemoteUrl(url), fetchedAt });
  log.info('远端镜像已更新', { url, mirrorDir, fetchedAt });
  return { fetchedAt };
}

/**
 * 探活（不克隆）：`git ls-remote --symref <url> HEAD` → 默认分支名 + tip。
 * `cwd` 由调用方显式给（api 传 `{workspaceRoot}/remotes`）：刻意不回落 `process.cwd()`，
 * 那会把「服务进程恰好在一个仓库目录里」变成隐式输入。
 */
export function probeRemote(url: string, options: { cwd: string; timeoutMs?: number }): { defaultBranch: string; tip: string } {
  // cwd 是**我们的**工作目录，不是远端的一部分：缺了就建出来。
  // 不建的话 git 直接以 ENOENT 失败，会被下面的分类器折成「无法读取远端仓库」——一个本地前置条件
  // 冒充成远端失败，把用户指向错误的排查方向（查网络，而实际是工作区目录还没建）。
  // 建不出来是**工作区根不可写**（不是远端的事），故走 ensureRemotesDir 的 NOT_WRITABLE，不折成远端失败
  ensureRemotesDir(options.cwd);
  const timeoutMs = positiveOr(options.timeoutMs, REMOTE_PROBE_TIMEOUT_MS);
  let output: string;
  try {
    output = execute(options.cwd, ['ls-remote', '--symref', url, 'HEAD'], remoteOptions(timeoutMs));
  } catch (error) {
    // kind: 'probe' → 超时文案说「探活」而不是「拉取」（探活不是拉取，处置也不同）
    throw classifyRemoteFailure(error, { url, what: '读取远端仓库', kind: 'probe', timeoutMs });
  }

  const lines = output.split('\n').map((line) => line.trim()).filter((line) => line !== '');
  const symrefLine = lines.find((line) => line.startsWith('ref:'));
  const headLine = lines.find((line) => !line.startsWith('ref:') && line.endsWith('HEAD'));
  const tip = (headLine ?? '').split('\t')[0] ?? '';
  if (tip === '') {
    // context 与其余远端失败对齐（RG11 的原文落点也在这里）：排查时不至于只剩一句中文
    throw new ServiceError('NOT_A_GIT_REPO', `远端仓库还没有任何提交：${url}`, {
      context: { url, what: '读取远端仓库' },
    });
  }
  const defaultBranch = (symrefLine ?? '').split('\t')[0]?.replace('ref: refs/heads/', '') ?? '';
  return { defaultBranch, tip };
}

/** 镜像 HEAD 现在指向哪个分支（**本地**读，不联网）；不是符号引用（detached）或读不出来时回空串 */
function mirrorHeadBranch(mirrorDir: string): string {
  try {
    return execute(mirrorDir, ['symbolic-ref', '--short', 'HEAD']).trim();
  } catch {
    return '';
  }
}

/**
 * 远端当前的默认分支名。探活失败只 WARN 并回空串：默认分支的对齐是抓取的**附带**动作，
 * 不能因为这一次 `ls-remote` 失败（远端恰好抖了一下）把一次已经成功的抓取说成失败——
 * 那会把「镜像的内容已经是最新的」变成用户的一次失败上报。
 */
function probeDefaultBranch(mirrorDir: string, url: string, timeoutMs: number): string {
  try {
    return probeRemote(url, { cwd: mirrorDir, timeoutMs }).defaultBranch;
  } catch (error) {
    log.warn('读不到远端默认分支，镜像 HEAD 保持现状（本次不修复）', { mirrorDir, url, error });
    return '';
  }
}

/**
 * 把镜像 HEAD 对齐到**远端当前的默认分支**（自愈）。
 *
 * 为什么非修不可：本机 git 2.47 实测 `git fetch --prune origin` **不会**刷新镜像的 HEAD 符号引用
 * （被删的 ref 它倒是会剪掉），而 `--mirror` 克隆那一刻的 HEAD 就是镜像记下的默认分支名。于是远端
 * 把默认分支改名（main → trunk）并删掉旧分支之后，镜像 HEAD 停在一个**已经不存在的**分支上：
 * `defaultBranchName` 读出旧名字、tip 解析不出来，校验 / 候选 / 每一轮 `repoBranch: null` 的评测
 * 都以「无法解析远端默认分支：main」失败——而这份镜像本身是完好的，产品里也没有任何出路
 * （用户只能手工去删镜像目录，而没有任何文案告诉他这件事）。旧分支若还活着则更隐蔽：
 * 不报错，只是**静默**一直跟着旧默认分支。
 *
 * 名字的来源按优先级：
 *   ① `known`——调用方**已经知道**的那个（`validateRepo` 的探活结果），用它就不必再问一次远端；
 *   ② `probeDefaultBranch`——自己发一次 `ls-remote --symref`（fetchMirror 本来就是联网的那条路）。
 * 名字拿不到（远端不发 symref）时**不猜**：HEAD 保持现状，与修复前同形。
 *
 * 修复动作是**本地**的 `symbolic-ref`：只改镜像自己的 HEAD 指向，一个字都不上网。
 * 它失败说明这份镜像真的坏到修不了（写不进去 = 状态损坏且无法重建），按 spec §10 最后一行
 * 抛 INTERNAL，不带裸 errno 漏给路由层。
 */
function alignDefaultBranch(mirrorDir: string, url: string, known: string | undefined, timeoutMs: number): void {
  // `??` 而不是 `||`：调用方给空串时的语义是「我问过了，远端没说」——那就别再付一次往返
  const wanted = (known ?? probeDefaultBranch(mirrorDir, url, timeoutMs)).trim();
  if (wanted === '' || mirrorHeadBranch(mirrorDir) === wanted) return;
  try {
    execute(mirrorDir, ['symbolic-ref', 'HEAD', `refs/heads/${wanted}`]);
  } catch (error) {
    throw new ServiceError('INTERNAL', `远端镜像状态损坏且无法重建：${mirrorDir}（${gitMessage(error)}）`, {
      context: { mirrorDir, url, branch: wanted },
      cause: error,
    });
  }
  log.info('镜像 HEAD 已对齐到远端默认分支', { mirrorDir, url, branch: wanted });
}

/**
 * 远端失败的分类（spec §4.5，错误码归 §10）。三件事按序判：
 *   ① 超时（靠信号判定，不靠关键词——远端自己报的 timeout 原文长得很像）；
 *   ② 关键词表：认证 / DNS / 不可达 / 主机指纹 / 不存在；
 *   ③ 其余归成 NOT_A_GIT_REPO 并把原文带上（中文原因在前，git 原文在后，RG11）。
 * 原文一律另放 `context.gitMessage`；`cause` 挂原始失败（不是给用户看的，是给日志与排查的）。
 * `kind` 决定超时文案的动词（探活 / 拉取，缺省拉取）与回落上限（15s / 600s）。
 */
export function classifyRemoteFailure(
  error: unknown,
  ctx: { url: string; what: string; host?: string; timeoutMs?: number; kind?: 'probe' | 'transfer' },
): ServiceError {
  const detail = gitMessage(error);
  const host = ctx.host ?? hostOfUrl(ctx.url);
  const context = { ...ctx, gitMessage: detail };

  if (isTimeoutKill(error)) {
    // 墙钟杀掉时 gitMessage 只有 Node 的英文（`spawnSync git ETIMEDOUT`、stderr 为空），
    // 所以中文原因必须在这里自己写出来（spec §4.5），不能把那段英文当原因丢给用户。
    // 动词与时长都按调用方的口径说：探活（默认 15s）既不是「拉取」，也不该说成「超过 0 分钟」。
    const kind = ctx.kind ?? 'transfer';
    const timeoutMs = positiveOr(ctx.timeoutMs, kind === 'probe' ? REMOTE_PROBE_TIMEOUT_MS : REMOTE_TRANSFER_TIMEOUT_MS);
    const verb = kind === 'probe' ? '探活' : '拉取';
    return new ServiceError('REPO_UNREACHABLE', `远端仓库${verb}超时（${timeoutDurationText(timeoutMs)}）：${ctx.url}（已终止 git 进程）`, {
      context,
      cause: error,
    });
  }
  if (AUTH_PATTERNS.some((pattern) => detail.includes(pattern))) {
    return new ServiceError(
      'AUTH_FAILED',
      `远端仓库认证失败：${host}（请确认本机 SSH key 已加入 ssh-agent，或 HTTPS 凭据助手可用）`,
      { context: { ...context, host }, cause: error },
    );
  }
  if (detail.includes('Could not resolve host')) {
    return new ServiceError('REPO_UNREACHABLE', `无法解析远端主机：${host}（${detail}）`, {
      context: { ...context, host },
      cause: error,
    });
  }
  if (UNREACHABLE_PATTERNS.some((pattern) => detail.includes(pattern))) {
    return new ServiceError('REPO_UNREACHABLE', `无法连接远端仓库：${host}（${detail}）`, {
      context: { ...context, host },
      cause: error,
    });
  }
  if (detail.includes('Host key verification failed')) {
    return new ServiceError(
      'REPO_UNREACHABLE',
      `SSH 主机指纹未信任：${host}（Host key verification failed；请先在本机手工 git clone 一次以确认指纹）`,
      { context: { ...context, host }, cause: error },
    );
  }
  // 「不是仓库」比「不存在 / 无权限」更具体，spec §4.5 给的是两句不同的话，先判这一条
  if (detail.includes('does not appear to be a git repository')) {
    return new ServiceError('NOT_A_GIT_REPO', `不是 git 仓库：${ctx.url}（${detail}）`, { context, cause: error });
  }
  if (NOT_FOUND_PATTERNS.some((pattern) => detail.includes(pattern))) {
    return new ServiceError(
      'NOT_A_GIT_REPO',
      `远端仓库不存在或无权访问：${ctx.url}（${detail}；私有仓库在凭据不可用时也会这样报）`,
      { context, cause: error },
    );
  }
  return new ServiceError('NOT_A_GIT_REPO', `无法读取远端仓库：${ctx.url}（${detail}）`, { context, cause: error });
}

/**
 * 镜像的默认分支名：`--mirror` 克隆时镜像的 HEAD 就是远端的 HEAD，所以这是**镜像里已有的事实**，
 * 不联网（签名里没有 url 就是这个约束的表达：拿不到来源地址就没法上网）。
 * 它的新鲜度由 `fetchMirror` 负责：每次抓取之后 `alignDefaultBranch` 都会把 HEAD 对齐到远端的当前
 * 默认分支（fetch 自己不刷新 HEAD，本机 git 2.47 实测），所以这里读到的名字「和最近一次镜像更新一样新」。
 * 读法是 `symbolic-ref --short HEAD`，失败再退 `rev-parse --abbrev-ref HEAD`：
 * detached 的 HEAD（hash 直接写在 HEAD 里）前者报 `ref HEAD is not a symbolic ref`，
 * 后者只会回字面量 `HEAD`——那不是分支名，当分支名用会让下游去解析 `refs/heads/HEAD`。
 * 两条都拿不到就抛 NOT_A_GIT_REPO：中文原因在前，git 原文在后并另放 context（RG11）。
 */
export function defaultBranchName(mirrorDir: string): string {
  let detail = '';
  try {
    const name = execute(mirrorDir, ['symbolic-ref', '--short', 'HEAD']).trim();
    if (name !== '') return name;
  } catch (error) {
    // 退回 --abbrev-ref 的理由：裸仓库上 symbolic-ref 的行为在个别 git 版本里不一致。
    // 这里留住原文——第二条也失败时，它是用户唯一能拿到的证据
    detail = gitMessage(error);
  }
  try {
    const name = execute(mirrorDir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
    if (name !== '' && name !== 'HEAD') return name;
  } catch (error) {
    detail = gitMessage(error);
  }
  throw new ServiceError('NOT_A_GIT_REPO', `无法确定远端默认分支：${mirrorDir}${detail === '' ? '' : `（${detail}）`}`, {
    context: { mirrorDir, gitMessage: detail },
  });
}

/**
 * 把「来源 + 分支 + commit」解析成 40 位具体 hash（spec §6.7 的规则表）。
 * 抓取时机是**按需**的（不是无脑先 fetch），三条路各有各的理由：
 *   · 钉死的 commit 已在镜像里 → 不联网：起点已经确定，这一轮不该因为远端临时不可达而失败
 *     （与 ensureCaseCache「缓存里有就不 fetch」同一条口径）；
 *   · 钉死的 commit 不在镜像里 → 只抓一次再判，仍没有才 INVALID_REF；
 *   · 分支 / 默认分支 → 「跟随」语义要求新鲜度，先 fetch（RG10：绝不静默沿用旧镜像）。
 * `fetch: false` 是候选列表那条路的「不联网」语义，它只作用于分支 / 默认分支：那条路的调用方传的
 * commitHash 恒为 null；钉死的 commit 不受它影响——要判出「镜像里确实没有」就必须先抓一次。
 * 默认分支的**名字**从镜像 HEAD 读（defaultBranchName，不联网），tip 再从镜像解析出来；名字的新鲜度
 * 由上面那次 fetch 保证（fetchMirror 抓完就把 HEAD 对齐到远端当前的默认分支，fetch 自己不刷新 HEAD）。
 */
export function resolveRemoteRef(
  mirrorDir: string,
  url: string,
  input: { branch: string | null; commitHash: string | null; fetch?: boolean; timeoutMs?: number },
): string {
  // timeoutMs 原样转发：正数钳制（`timeout: 0` = Node 的「不设超时」）在 fetchMirror 里做，
  // 它是本模块所有远端传输的唯一出口，在这里再钳一次就是第二份会漂移的默认值。
  const commit = input.commitHash?.trim() ?? '';
  if (commit !== '') {
    const direct = revisionInMirror(mirrorDir, commit);
    if (direct !== null) return direct;
    fetchMirror(mirrorDir, url, { timeoutMs: input.timeoutMs });
    const afterFetch = revisionInMirror(mirrorDir, commit);
    if (afterFetch !== null) return afterFetch;
    throw new ServiceError(
      'INVALID_REF',
      `commit 不存在：${commit}（远端：${url}，已在镜像中执行 git fetch，仍找不到该 commit）`,
      { context: { mirrorDir, url, commit } },
    );
  }

  if (input.fetch !== false) fetchMirror(mirrorDir, url, { timeoutMs: input.timeoutMs });

  const branch = input.branch?.trim() ?? '';
  if (branch !== '') {
    try {
      return execute(mirrorDir, ['rev-parse', `refs/heads/${branch}^{commit}`]).trim();
    } catch (error) {
      // `refs/heads/` 前缀是必需的：裸名会按 git 的 ref 解析顺序命中同名 tag 等别的命名空间，
      // 把「远端没这个分支」判成「有」（spec §4.5 的 INVALID_REF 只认分支）
      throw new ServiceError('INVALID_REF', `分支不存在：${branch}（远端：${url}）`, {
        context: { mirrorDir, url, branch, gitMessage: gitMessage(error) },
      });
    }
  }

  const name = defaultBranchName(mirrorDir);
  try {
    return execute(mirrorDir, ['rev-parse', `refs/heads/${name}^{commit}`]).trim();
  } catch (error) {
    throw new ServiceError('NOT_A_GIT_REPO', `无法解析远端默认分支：${name}（远端：${url}）`, {
      context: { mirrorDir, url, name, gitMessage: gitMessage(error) },
    });
  }
}

/** 认证类原文（顺序无关，命中即认证失败） */
const AUTH_PATTERNS = [
  'Permission denied (publickey',
  'Authentication failed',
  'could not read Username',
  'HTTP Basic: Access denied',
  'terminal prompts disabled',
];
/**
 * 网络类原文。后两条是 curl 8 的措辞：本机 git 2.47 实测「连接被拒」报的是
 * `Failed to connect to 127.0.0.1 port N after N ms: Could not connect to server`，
 * **整句里没有 `Connection refused`**——只按 spec §4.5 的旧措辞匹配会让它掉进「无法归因」。
 */
const UNREACHABLE_PATTERNS = [
  'Connection timed out',
  'Connection refused',
  'Network is unreachable',
  'Operation timed out',
  'Could not connect to server',
  'Timeout was reached',
];
/** 远端不存在 / 无权访问（`does not appear to be a git repository` 由上面那条更具体的分支接走） */
const NOT_FOUND_PATTERNS = ['not found', 'Repository not found'];

/** 从来源串里取主机名（分类文案要用；scp 形态取冒号前那段） */
function hostOfUrl(url: string): string {
  if (url.startsWith('file://')) return 'localhost';
  try {
    return new URL(url).hostname;
  } catch {
    const scp = /^([A-Za-z0-9._-]+@)?([A-Za-z0-9._-]{2,}):/.exec(url);
    return scp?.[2] ?? url;
  }
}

/**
 * 把镜像里的任意可解析写法归一成 40 位 hash；**不在镜像里时返回 null**。
 *
 * 一条命令办完早先两件事（`cat-file -e` 判存在 + `rev-parse` 取全量）——与 `git.ts` 的
 * `assertCommit` 同一手法：`--verify` 一条就能同时给出「存在与否」与「40 位全量 hash」
 * （实测：短 hash 归一成全量、blob 与非 commit 对象非零退出、不存在的 hash 非零退出）。
 * 为什么值得合：本机每次进程创建 ≈0.5s，而远端来源的**每条行准备**都要过这里两次
 * （先判一次、fetch 之后再审一次），mirror-* 那批用例是 core 包墙钟的大头。
 */
function revisionInMirror(mirrorDir: string, commit: string): string | null {
  try {
    return execute(mirrorDir, ['rev-parse', '--verify', `${commit}^{commit}`]).trim();
  } catch {
    return null;
  }
}

/** URL 末段去 `.git` 作 slug（非 `[A-Za-z0-9._-]` 归一成 `-`，小写，截 40 字符；空则 `repo`） */
function slugOf(url: string): string {
  const path = url.startsWith('file://') ? url.slice('file://'.length) : url;
  const trimmed = path.replace(/[\\/]+$/, '');
  const index = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'), trimmed.lastIndexOf(':'));
  const segment = (index === -1 ? trimmed : trimmed.slice(index + 1)).replace(/\.git$/, '');
  const slug = segment.toLowerCase().replace(/[^a-z0-9._-]/g, '-').slice(0, 40);
  return slug === '' ? 'repo' : slug;
}
