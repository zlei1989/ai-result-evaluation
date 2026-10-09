// @vitest-environment node
/**
 * 进程树回收的行为契约（2026-10-07）。
 *
 * 为什么这一层必须有自己的守卫：它是**跨轮次 EPERM** 的唯一防线——
 * `child.kill()` 在 Windows 上只杀直接子进程，而厂商 CLI 会 spawn 一串继承句柄的孙进程
 * （真机：codex 的插件同步 `git` 链），它们持着本行的 `.agenthome` / `.judgehome`。
 * 守卫要钉住的正是那三件事：**按 pid 杀整棵树**、**等退出**、**等不到也不抛**。
 *
 * 这里一律用假子进程 + 注入的杀树动作：真机形态（真 `taskkill /T /F` 与真孙进程）
 * 由 `probe/v7/codex-plugins-sync.mjs` 覆盖，单测不 spawn 进程。
 */
import { describe, expect, it } from 'vitest';
import { hasExited, terminateProcessTree, type ProcessTreeChild } from './process-tree';

/** 假子进程：可控制 pid / 退出码，并记录 kill 与 exit 订阅 */
class FakeProcess implements ProcessTreeChild {
  killed = false;
  readonly exitListeners: Array<(code: number | null, signal: string | null) => void> = [];
  constructor(
    public pid: number | undefined = 4321,
    public exitCode: number | null = null,
    public signalCode: string | null = null,
  ) {}
  /**
   * 「spawn 失败、拿不到 pid」那种子进程。
   * 为什么要一个工厂而不是 `new FakeProcess(undefined)`：默认参数会把 `undefined` 吃掉，
   * 拿到的还是 4321——那条用例会因此**假绿**（守卫在真实缺陷上不红，比没有守卫更糟）。
   */
  static withoutPid(): FakeProcess {
    const one = new FakeProcess(1);
    one.pid = undefined;
    return one;
  }
  kill(): boolean {
    this.killed = true;
    return true;
  }
  on(_event: 'exit', listener: (code: number | null, signal: string | null) => void): void {
    this.exitListeners.push(listener);
  }
  /** 模拟子进程退出 */
  exit(code: number | null = 0): void {
    this.exitCode = code;
    for (const listener of this.exitListeners) listener(code, null);
  }
}

describe('terminateProcessTree —— 整棵回收', () => {
  it('Windows：命令是 `taskkill /PID <pid> /T /F`（`/T` 就是「整棵树」，少了它等于没修）', async () => {
    const { defaultKillTree } = await import('./process-tree');
    const runs: Array<{ file: string; args: readonly string[] }> = [];
    const killTree = defaultKillTree('win32', (file, args) => {
      runs.push({ file, args });
      return Promise.resolve();
    });
    await killTree(777);
    expect(runs).toEqual([{ file: 'taskkill', args: ['/PID', '777', '/T', '/F'] }]);
  });

  it('产品路径把「按 pid 杀整棵树」当默认动作（注入点只改实现，不改调用约定）', async () => {
    const child = new FakeProcess(777);
    const pids: number[] = [];
    await terminateProcessTree(child, {
      killTree: (pid) => {
        pids.push(pid);
        return Promise.resolve();
      },
      graceMs: 50,
    });
    expect(pids).toEqual([777]);
    child.exit(0);
  });

  it('杀树之后等 `exit`：等到了才回 exited:true（发信号 ≠ 已退出）', async () => {
    const child = new FakeProcess(101);
    const pending = terminateProcessTree(child, { killTree: () => Promise.resolve(), graceMs: 5_000 });
    await Promise.resolve();
    child.exit(0);
    const outcome = await pending;
    expect(outcome).toMatchObject({ via: 'tree', exited: true });
    expect(outcome.error).toBeNull();
  });

  it('宽限期内等不到 `exit` ⇒ 如实回 exited:false（不悬挂、不抛）', async () => {
    const child = new FakeProcess(102);
    const outcome = await terminateProcessTree(child, { killTree: () => Promise.resolve(), graceMs: 30 });
    expect(outcome.exited).toBe(false);
    expect(outcome.via).toBe('tree');
  });

  it('拿不到 pid（spawn 失败）⇒ 退回直接 kill，并如实记 via:direct', async () => {
    const child = FakeProcess.withoutPid();
    let treeCalled = false;
    const outcome = await terminateProcessTree(child, {
      killTree: () => {
        treeCalled = true;
        return Promise.resolve();
      },
      graceMs: 30,
    });
    expect(treeCalled).toBe(false);
    expect(child.killed).toBe(true);
    expect(outcome.via).toBe('direct');
  });

  it('杀树动作抛错 ⇒ 退回直接 kill，原因进 error（不冒给释放路径）', async () => {
    const child = new FakeProcess(103);
    const outcome = await terminateProcessTree(child, {
      killTree: () => Promise.reject(new Error('taskkill 不在 PATH 上')),
      graceMs: 30,
    });
    expect(child.killed).toBe(true);
    expect(outcome.via).toBe('direct');
    expect(outcome.error).toContain('taskkill 不在 PATH 上');
  });

  it('已经退出的子进程直接短路：不杀、不等、立即回 exited:true', async () => {
    const child = new FakeProcess(104, 0);
    let treeCalled = false;
    const outcome = await terminateProcessTree(child, {
      killTree: () => {
        treeCalled = true;
        return Promise.resolve();
      },
      graceMs: 5_000,
    });
    expect(treeCalled).toBe(false);
    expect(child.killed).toBe(false);
    expect(outcome).toMatchObject({ exited: true, waitedMs: 0 });
  });
});

describe('defaultKillTree —— 两条平台的杀树命令', () => {
  it('POSIX：先杀进程组（-pid），组不存在才退回直接 kill', async () => {
    const { defaultKillTree } = await import('./process-tree');
    const killTree = defaultKillTree('linux');
    const signals: Array<{ pid: number; signal: string }> = [];
    const original = process.kill;
    // 只替换 process.kill 这一个出口：这条用例要断言的就是「先 -pid、再 pid」这个顺序
    (process as { kill: unknown }).kill = ((pid: number, signal: string) => {
      signals.push({ pid, signal });
      if (pid < 0) throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
      return true;
    }) as unknown as typeof process.kill;
    try {
      await killTree(2048);
    } finally {
      (process as { kill: unknown }).kill = original;
    }
    expect(signals).toEqual([
      { pid: -2048, signal: 'SIGKILL' },
      { pid: 2048, signal: 'SIGKILL' },
    ]);
  });

  it('hasExited：退出码或信号任一有值就算已退出；两格都缺（无观测手段）不算', () => {
    expect(hasExited({ exitCode: 0, signalCode: null })).toBe(true);
    expect(hasExited({ exitCode: null, signalCode: 'SIGKILL' })).toBe(true);
    expect(hasExited({ exitCode: null, signalCode: null })).toBe(false);
    expect(hasExited({})).toBe(false);
  });
});
