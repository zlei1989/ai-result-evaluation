// @vitest-environment node
/**
 * 远端镜像层：目录 key、克隆到 tmp + 原子 rename、幂等与半成品重建、增量更新与镜像记录、
 * 远端探活（ls-remote）与失败分类。
 * 夹具是**真 git 仓库**（file:// 指向一个裸克隆），不打网络——远端链路的每条路径都要能在离线跑。
 * 例外都是**本地 TCP**、仍不出机器：「沉默远端」（只 accept、不回话）用来钉「克隆被墙钟杀掉」，
 * `unusedPort()` 造的 `http://127.0.0.1:<port>` 用来钉「未监听端口 / 探活超时」。 */
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import type { AddressInfo, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';
import { ServiceError } from '@aieval/contracts';
import { removeTreeWithRetry } from './cleanup';


export const created: string[] = [];

export function makeTmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}

/** 跑一条 git 命令（身份显式给，避免依赖宿主机配置） */
export function git(dir: string, args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.name=test', '-c', 'user.email=test@example.com', '-c', 'core.autocrlf=false', '-c', 'commit.gpgsign=false', ...args],
    { cwd: dir, encoding: 'utf8' },
  );
}

/**
 * 「远端」夹具的**模板缓存**：同一组分支只真建一次，其余每次 `cpSync` 一份。
 *
 * 为什么要缓存：`buildOriginRepo` 要付 5 + 5×分支数 个 git 进程（init / add / commit / rev-parse
 * 各一次，外加 `clone --bare`），本机每次 ≈1.5–2.5s、满载更贵；mirror-* 与 orchestrator 的
 * 远端用例加起来有二十几条各建一次 ⇒ 光夹具就 40s 上下（正是这些文件墙钟 40–80s 的主因）。
 * 复制出来的仓库与模板**逐字节同内容**（连同 hash）：`work` 自己没有远端（`renameOriginDefaultBranch`
 * 是按路径 push 的），`origin.git` 是裸仓库、配置里不含绝对路径——两者都能安全复制到新路径下。
 */
const originTemplates = new Map<string, { root: string; hashes: Record<string, string> }>();

/** 造一个「远端」：工作仓库 → 裸克隆 → file:// URL（分支含 main 与调用方给的那些） */
export function makeOriginRepo(root: string, branches: string[] = []): { bareDir: string; url: string; hashes: Record<string, string> } {
  const key = branches.join('|');
  let template = originTemplates.get(key);
  if (template === undefined) {
    const dir = mkdtempSync(join(tmpdir(), 'aieval-origin-template-'));
    template = { root: dir, hashes: buildOriginRepo(dir, branches) };
    originTemplates.set(key, template);
  }
  cpSync(template.root, root, { recursive: true });
  const bareDir = join(root, 'origin.git');
  return { bareDir, url: `file:///${bareDir.replace(/\\/g, '/')}`, hashes: template.hashes };
}

/** 真建一份「远端」到 root（只在某个分支组合第一次用到时执行一次，之后走 `makeOriginRepo` 的复制） */
function buildOriginRepo(root: string, branches: string[]): Record<string, string> {
  const work = join(root, 'work');
  mkdirSync(work, { recursive: true });
  git(work, ['init', '-q', '-b', 'main']);
  writeFileSync(join(work, 'a.txt'), 'a\n', 'utf8');
  git(work, ['add', '.']);
  git(work, ['commit', '-q', '-m', 'first']);
  const hashes: Record<string, string> = { main: git(work, ['rev-parse', 'HEAD']).trim() };
  for (const branch of branches) {
    git(work, ['checkout', '-q', '-B', branch]);
    writeFileSync(join(work, `${branch.replace(/\//g, '-')}.txt`), `${branch}\n`, 'utf8');
    git(work, ['add', '.']);
    git(work, ['commit', '-q', '-m', `${branch} 的提交`]);
    hashes[branch] = git(work, ['rev-parse', 'HEAD']).trim();
  }
  git(work, ['checkout', '-q', 'main']);
  const bareDir = join(root, 'origin.git');
  git(root, ['clone', '-q', '--bare', work, bareDir]);
  return hashes;
}

/**
 * 取夹具里某个分支的 hash。`hashes` 的索引类型在 noUncheckedIndexedAccess 下带 undefined，
 * 而调用点要的是确定的 string：缺键说明夹具自己写错了，早抛比把 undefined 交给被测函数更清楚。
 */
export function hashOf(origin: { hashes: Record<string, string> }, branch: string): string {
  const hash = origin.hashes[branch];
  if (hash === undefined) throw new Error(`夹具里没有分支 ${branch} 的 hash`);
  return hash;
}

/**
 * 在「远端」上做一次 GitHub 式的默认分支改名：新分支上多一个提交 → 远端 HEAD 指过去 → 旧分支删掉。
 * 一切都在**远端侧**（`makeOriginRepo` 建好的工作仓库 + 裸仓库）完成，镜像那边一个字都不动——
 * 被测的正是镜像能不能自己跟上（`fetch --prune` 只剪 ref，不刷新镜像的 HEAD，本机 git 2.47 实测）。
 * 返回新默认分支的 tip hash（用它与镜像解析出的基线对账）。
 */
export function renameOriginDefaultBranch(root: string, bareDir: string, to: string): string {
  const work = join(root, 'work');
  git(work, ['checkout', '-q', '-B', to]);
  writeFileSync(join(work, `${to}.txt`), `${to}\n`, 'utf8');
  git(work, ['add', '.']);
  git(work, ['commit', '-q', '-m', `${to} 的提交`]);
  const tip = git(work, ['rev-parse', 'HEAD']).trim();
  // 工作仓库是 `clone --bare` 的**来源**、自己没有 origin 远端，所以按路径推
  git(work, ['push', '-q', bareDir, `HEAD:refs/heads/${to}`]);
  git(bareDir, ['symbolic-ref', 'HEAD', `refs/heads/${to}`]);
  git(bareDir, ['branch', '-D', 'main']);
  return tip;
}

/** 拿一个确定没人监听的端口：先绑定再关掉 */
export async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/**
 * 造一个「肯接连接、一句话不说」的 git:// 远端：克隆时 git 的 init_db 先建好目标目录，
 * 传输层随后连上并**永远等不到** ref 广告——墙钟必然落在「目录已建、传输未完成」之后。
 * 这是「克隆被杀后不留 tmp 残留」需要的确定性形状：对不存在的路径克隆是秒失败，
 * 杀得太早，磁盘上根本没有残骸可清（那样的断言永远不会红）。
 * `connectionCount()` 是防「空过」的那一半：只有真连上了，才谈得上「init_db 已经建过目录」。
 *
 * 注：不能改用 `uploadpack.packObjectsHook` 卡住服务端——git 明确忽略**仓库级**配置里的这个键
 * （防「从不可信仓库取包时被设钩子」），本机实测钩子一次都没被调用、克隆 0.7s 就正常完成了。
 */
export async function silentRemote(): Promise<{ url: string; connectionCount: () => number; close: () => Promise<void> }> {
  let connections = 0;
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    connections += 1;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    // 被墙钟杀掉的一方会让连接以 RST 收场：没有这个处理，socket 的 error 事件会掀掉整个进程
    socket.on('error', () => {});
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    url: `git://127.0.0.1:${port}/x.git`,
    connectionCount: () => connections,
    close: async () => {
      // 先掐掉已有连接：被杀的那一端不一定把 FIN/RST 送到，只 server.close() 会一直等下去
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/**
 * 等服务器收到连接（最多 `budgetMs`）。
 * 必要性：`ensureMirror` 是**同步**调用，它跑的时候事件循环被占着，服务器回调只能等它返回后才派发；
 * 而回调是不是「下一个宏任务」就轮到自己，取决于 worker 里的排队情况（实测要等到几十毫秒之后）。
 */
export async function waitForConnection(remote: { connectionCount: () => number }, budgetMs = 5000): Promise<number> {
  const deadline = Date.now() + budgetMs;
  while (remote.connectionCount() === 0 && Date.now() < deadline) {
    await new Promise<void>((resolve) => {
      setTimeout(() => resolve(), 25);
    });
  }
  return remote.connectionCount();
}

/** 造一个「git 失败」形状的错误：分类只读 stderr（git 的人类可读报错都在这里） */
export function gitFailure(stderr: string): Error {
  return Object.assign(new Error('Command failed: git'), { stderr });
}

/**
 * 本机（Windows）的进程创建税：仓库的另两个真远端夹具文件记着实测 113–117s、最坏 230s 的**首次**克隆停顿
 * （`cases.test.ts` / `orchestrator.test.ts` 各有一份同样的常量与说明），而 vitest 的默认预算是 20s。
 * 本文件每条用例都自带真 git 夹具，但按仓库口径**只给最重的那条**声明预算：默认分支自愈那条比其余用例
 * 多一次远端改名（push + symbolic-ref + 删旧分支）与两次基线解析，实测在本机被 20s 截断过。
 * `vitest.config.ts` 的 `testTimeout` 一字不动，其余用例的预算也保持默认。
 */
export const REMOTE_FIXTURE_TIMEOUT_MS = 300_000;

/** 探活的默认墙钟只有 15s，而本机的进程创建偶发被拖到 100s 级（`vitest.node.ts` 记过这条）。
 * 凡是靠「git 快速成功 / 快速失败」得出结论的探活用例都显式给足窗口：停顿被 15s 截断时
 * 拿到的是 `REPO_UNREACHABLE`，会让分类用例红得没有归因价值（那不是分类错，是机器慢）。
 * 「超时被杀」那条映射另有专门用例（`timeoutMs: 1`），不受这里影响。
 */
export const FAST_FAILURE_PROBE_TIMEOUT_MS = 120_000;

/** 抓出抛出的错误本体（要同时断言实例、code 与 context 时用；无抛错返回 null） */
export function caughtOf(fn: () => unknown): unknown {
  try {
    fn();
    return null;
  } catch (error) {
    return error;
  }
}

/** 把 ServiceError 抓出来断言 code（比 toThrowError 更能钉住归因） */
export function codeOf(fn: () => unknown): string {
  try {
    fn();
    return '（没有抛错）';
  } catch (error) {
    return error instanceof ServiceError ? error.code : `非 ServiceError：${String(error)}`;
  }
}

export function messageOf(fn: () => unknown): string {
  try {
    fn();
    return '（没有抛错）';
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * 清掉本次用例建的临时根，**清理竞态绝不让套件变红**。
 *
 * ⚠️ 不能写 `rmSync(dir, { recursive: true, force: true, maxRetries: 40, retryDelay: 250 })`：
 * 那对 `maxRetries` 的文档口径在这里**不成立**——本机实测（起一个把目标目录当 cwd 的长命 node
 * 子进程，再删那个目录）`rmSync(..., { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })`
 * **1ms 就抛 EPERM**，一次都没重试；异步 `fs.rm` 同场景 631ms 内自愈（白名单只在异步那条路上）。
 * 于是「给足重试窗口」这句注释是**假的**：被墙钟 `TerminateProcess` 掉的 git（Windows 上还会
 * 短暂捏着自己的 cwd）只要慢一拍，`afterEach` 就抛 EPERM，**整个文件连同它的断言一起判红**，
 * 而失败与代码无关。实测频率：连续三次全量门禁里出现 2 次（另一次绿），逐条隔离复跑全绿。
 *
 * 所以重试由我们自己写——**今天只有一份实现**：`./cleanup` 的 `removeTreeWithRetry`
 * （10 × 200ms ≈ 2s，依据是实测的锁释放时间 205ms；超限只 WARN 不抛）。
 */
export function registerMirrorHooks(): void {
  afterEach(() => {
    for (const dir of created.splice(0)) removeTreeWithRetry(dir);
  });
}
export { execFileSync } from 'node:child_process';
export { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
export { createServer } from 'node:net';
export type { AddressInfo, Socket } from 'node:net';
export { tmpdir } from 'node:os';
export { join } from 'node:path';
export { ServiceError } from '@aieval/contracts';
export { classifyRemoteFailure, defaultBranchName, ensureMirror, fetchMirror, isMirrorReady, mirrorDir, probeRemote, promoteMirror, readMirrorRecord, remotesDir, resolveRemoteRef } from '../mirror';