/**
 * 厂商子进程的**整棵回收**（进程树语义），以及「真的退出了吗」的确认（2026-10-07）。
 *
 * 为什么必须有这一层：`child.kill()` 在 Windows 上只对**直接子进程**做 TerminateProcess，
 * 孙进程原地存活。而厂商 CLI 会在自己内部 spawn 一串网络子进程——codex 0.156.1 每次
 * `thread/start` 都去同步 `https://github.com/openai/plugins.git`（`core-plugins/src/startup_sync.rs`），
 * 链路是 `codex.exe → git.exe → git.exe → git remote-https → git-remote-https.exe`。
 * 这些孙进程**继承了父进程的句柄**（它们的命令行里连 `CODEX_HOME` 都不出现），于是父进程一死，
 * 它们继续持着该行的厂商配置目录（`.agenthome` / `.judgehome`）。
 *
 * 后果是**跨轮次**的：下一轮的行产物清理要删那个目录，Windows 拒绝（目录树里有活进程的句柄/工作目录）
 * ⇒ `rmSync` 抛 `EPERM`。真机探针（`probe/v7/codex-plugins-sync.mjs`）四格对照：
 *   · 只杀直接子进程 → 4~5 个孙进程存活 → `rmSync` 在 50ms/250ms/2s/**10s** 四个时点全部 EPERM；
 *   · 杀整棵树（`taskkill /T /F`）→ 后代清零 → `rmSync` **立刻成功**。
 *
 * 两条口径：
 *  1. **谁 spawn 谁负责整棵回收**（`AgentProvider` 的 `dispose` 义务）。第三方 SDK 代 spawn 的家
 *     拿不到 pid（claude-agent-sdk / dsh-sdk-client 的公开面都不暴露），只能走 SDK 自己的硬停止通道
 *     ——这一点登记在《厂商进程生命周期规范》里，不许假装做到了。
 *  2. **`dispose()` 要等确认**，不能只发信号就返回：`kill()` 返回 ≠ 进程已退出，更 ≠ 句柄已释放。
 *     等不到也不抛（结论优先于可见性），由调用方把 `exited: false` 落成 WARN。
 */
import { execFile } from 'node:child_process';

/**
 * 被回收的子进程的窄结构：只声明本模块用到的三个成员。
 * 真实 `ChildProcess` 结构上满足它（`pid` 在 spawn 成功后存在）。
 */
export interface ProcessTreeChild {
  /** 进程号；spawn 失败 / 已回收时为 undefined（那时只能退回直接 `kill()`） */
  readonly pid?: number | undefined;
  /** 退出码（`null` = 还没退）；用来短路「已经死透了」的回收，不必白等一个宽限期 */
  readonly exitCode?: number | null | undefined;
  /** 终止信号（`null` = 不是被信号杀的）；与 `exitCode` 一起判「已退出」 */
  readonly signalCode?: string | null | undefined;
  kill(signal?: string): unknown;
  on(event: 'exit', listener: (code: number | null, signal: string | null) => void): unknown;
}

/** 一次回收的结论（供调用方记日志；不抛异常——释放路径上可见性次于结论） */
export interface TerminateOutcome {
  /** 走的哪条路：`tree` = 整棵杀；`direct` = 只杀了直接子进程（拿不到 pid 或杀树失败） */
  via: 'tree' | 'direct';
  /** 是否**观察到**进程退出（false = 到点仍未退出） */
  exited: boolean;
  /** 从开始回收到观察到退出（或超时）的墙钟毫秒 */
  waitedMs: number;
  /** 杀树动作自身报的错（null = 没报错）。不影响 `exited` 的语义 */
  error: string | null;
}

export interface TerminateOptions {
  /**
   * 杀树动作（注入点，测试用）。缺省按平台选：
   * Windows 走 `taskkill /PID <pid> /T /F`；POSIX 走进程组 SIGKILL（要求 spawn 时 `detached`）。
   */
  killTree?: (pid: number) => Promise<void>;
  /** 等退出的上限（毫秒）。默认 5s：与 `releaseTurn` 的第一段同一个数量级 */
  graceMs?: number;
  /** 平台（注入点，测试里能同时覆盖两条分支而不改 `process.platform`） */
  platform?: NodeJS.Platform;
}

/** 默认等待上限 */
export const TERMINATE_GRACE_MS = 5_000;

/**
 * 整棵回收一个子进程，并等它真的退出。
 *
 * 顺序是承重的：**先杀树、再等退出**。反过来（先 `kill()` 父进程再找孙进程）会丢掉树的结构——
 * Windows 上孙进程的 `ParentProcessId` 会指向一个已死的父进程，`taskkill /T` 再也走不到它们。
 */
export async function terminateProcessTree(
  child: ProcessTreeChild,
  options: TerminateOptions = {},
): Promise<TerminateOutcome> {
  const startedAt = Date.now();
  const graceMs = options.graceMs ?? TERMINATE_GRACE_MS;
  const platform = options.platform ?? process.platform;
  const killTree = options.killTree ?? defaultKillTree(platform);

  // 已经死透了：没有可回收的东西，也就不该为一个不可能到来的 `exit` 白等一个宽限期
  if (hasExited(child)) return { via: 'direct', exited: true, waitedMs: 0, error: null };

  let error: string | null = null;
  let via: TerminateOutcome['via'] = 'direct';
  const pid = child.pid;
  if (typeof pid === 'number' && pid > 0) {
    try {
      await killTree(pid);
      via = 'tree';
    } catch (cause) {
      // 杀树失败（taskkill 不在、权限不足、进程已退出）：退回直接 kill，并把原因交出去
      error = cause instanceof Error ? cause.message : String(cause);
      killChildDirectly(child);
    }
  } else {
    killChildDirectly(child);
  }

  const exited = await waitForExit(child, graceMs);
  return { via, exited, waitedMs: Date.now() - startedAt, error };
}

/** 这个子进程是不是已经退出了（`exitCode` 与 `signalCode` 都为空才是「还活着」） */
export function hasExited(child: Pick<ProcessTreeChild, 'exitCode' | 'signalCode'>): boolean {
  // 两个字段都可能不存在（假子进程）：`undefined` = 这一格没有观测手段，不能当「已退出」
  const code = child.exitCode;
  const signal = child.signalCode;
  return (code !== null && code !== undefined) || (signal !== null && signal !== undefined);
}

/** 执行一个外部命令；失败时抛带命令原文的错误（注入点：测试里不真跑 `taskkill`） */
export type CommandRunner = (file: string, args: readonly string[]) => Promise<void>;

const runCommand: CommandRunner = (file, args) =>
  new Promise<void>((resolve, reject) => {
    execFile(file, [...args], { windowsHide: true }, (error) => {
      if (error === null) {
        resolve();
        return;
      }
      // 「进程不存在」（已被回收）也算成功语义：这里要的是「它没了」，不是「命令跑过了」
      if (/not found|找不到|没有找到/i.test(error.message)) {
        resolve();
        return;
      }
      reject(new Error(`${file} ${args.join(' ')} 失败：${error.message}`));
    });
  });

/**
 * 按平台构造默认的杀树动作。
 *
 * Windows 的 `taskkill /T` 顺着**进程树**（不是进程组）递归终止，这是系统自带的唯一可用手段；
 * 它的返回码不可当判据（128 = 进程不存在），所以这里只把「命令跑不起来」当错误。
 * POSIX 用进程组：`-pid` 要求该子进程自成一组（spawn 时 `detached: true`），拿不到就抛，
 * 由调用方退回直接 kill——**不许**兜底成 `-process.pid`（那会把自己的整个进程组杀掉）。
 */
export function defaultKillTree(
  platform: NodeJS.Platform = process.platform,
  run: CommandRunner = runCommand,
): (pid: number) => Promise<void> {
  if (platform === 'win32') {
    return (pid) => run('taskkill', ['/PID', String(pid), '/T', '/F']);
  }
  return async (pid) => {
    try {
      // 负 pid = 进程组；子进程必须是组长（spawn 时 detached:true），否则抛 ESRCH
      process.kill(-pid, 'SIGKILL');
    } catch {
      // 退回直接杀；这一次再失败就把错误交给调用方（它会把 via 记成 'direct'）
      process.kill(pid, 'SIGKILL');
    }
  };
}

/** 直接杀子进程；失败（已退出 / 无权限）不影响后续的等待与结论 */
function killChildDirectly(child: ProcessTreeChild): void {
  try {
    child.kill();
  } catch {
    // 已经死了：kill 抛错不影响「回收」这个结论
  }
}

/**
 * 等 `exit` 事件或超时。
 *
 * 为什么不能只等事件：`exit` 在极少数情况下不会来（进程卡在不可中断的内核态、或 kill 没生效），
 * 而这是一条释放路径——**无界等待会把整行拖死**。等不到就如实回 `false`，由调用方 WARN。
 */
function waitForExit(child: ProcessTreeChild, graceMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = (exited: boolean): void => {
      if (timer !== undefined) clearTimeout(timer);
      resolve(exited);
    };
    try {
      child.on('exit', () => {
        done(true);
      });
    } catch {
      // 假子进程 / 已销毁的句柄：当「等不到」处理，由超时兜底
    }
    timer = setTimeout(() => {
      done(false);
    }, graceMs);
  });
}
