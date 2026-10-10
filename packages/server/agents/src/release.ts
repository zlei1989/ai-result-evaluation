/**
 * 释放：`interrupt()` → 终结在途 turn → `dispose()`。
 * 顺序不可颠倒：直接 dispose 会与在途 turn 争抢同一批资源（dsh 的子进程、codex 的临时目录）。
 * 超时分两段：第一段等 5 秒（RELEASE_GRACE_MS），超限先给出可见信号再强制 dispose——非合作的
 * 适配器必须可见，不能静默（否则界面上一行永远停在 running，没人知道是适配器不响应）。
 * 注意：守卫（createDisposer）绑定**被关闭的对象**，不是运行时级一次性闭锁（A7）：
 * 「中断 → 下一轮新建客户端 → 释放」这条路径下，闭锁会让新客户端再也没人关，留下孤儿子进程。
 */

/** 第一段等待上限：发出 interrupt 后等 5 秒 */
export const RELEASE_GRACE_MS = 5_000;

export interface TurnLifecycle {
  /** 发停止信号（不等待）；允许适配器忽略（dsh 不支持中途取消），也允许它抛——抛了不挡释放 */
  interrupt: () => void;
  /** 在途 turn 的终结 Promise：适配器自己的 finally 清理完成时 resolve（约定不 reject） */
  settled: Promise<void>;
  /** 回收子进程 / 删临时目录；**必须幂等**（超时与用户终止可能先后触发） */
  dispose: () => Promise<void>;
}

export interface ReleaseReport {
  /** dispose 抛出的错误（null = 正常）：由调用方决定怎么落日志，这里既不吞也不冒 */
  disposeError: unknown | null;
}

/**
 * 按固定顺序释放一次运行。
 * graceMs 只给测试用（毫秒级验证第二段兜底），生产路径一律用 RELEASE_GRACE_MS。
 */
export async function releaseTurn(
  lifecycle: TurnLifecycle,
  onGraceExceeded: () => void,
  graceMs: number = RELEASE_GRACE_MS,
): Promise<ReleaseReport> {
  try {
    lifecycle.interrupt();
  } catch {
    // 停止信号自身失败不得挡住释放：该走的第二段还是要走
  }
  const settled = await waitForSettled(lifecycle.settled, graceMs);
  if (!settled) {
    try {
      onGraceExceeded();
    } catch {
      // 可见信号自身失败不得挡住释放：与 interrupt 的 try/catch 同一条理由。
      // 这个回调不是「只是打个日志」——turn.ts 传进来的实现会走 onEvent → 编排层的 appendEvent，
      // 而写侧 schema 不过就抛 ServiceError；裸调用一旦抛错，下面的 dispose 永不执行，
      // 子进程与临时目录就没人回收了（要防的孤儿）。
    }
  }
  try {
    await lifecycle.dispose();
    return { disposeError: null };
  } catch (error) {
    return { disposeError: error };
  }
}

/**
 * 关闭守卫：把「恰好关一次」绑到**被关闭的对象**上（A7）。
 * 重复调用返回同一个 Promise，于是「超时」与「用户终止」先后触发也只关一次（幂等）。
 */
export function createDisposer(close: () => Promise<void> | void): () => Promise<void> {
  let closed: Promise<void> | undefined;
  return () => {
    closed ??= (async () => {
      await close();
    })();
    return closed;
  };
}

/** 等 settled 或超时；settled 约定不 reject，这里仍然兜住 reject，避免异常从释放路径冒出去 */
async function waitForSettled(settled: Promise<void>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      settled.then(
        () => true,
        () => true,
      ),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
