/**
 * Next 服务启动钩子：两件事——把上一个进程留下的在途候选行标成 interrupted（F10，不自动续跑），
 * 以及在 SIGTERM / SIGINT 上装停机回收（把本进程在册的在途会话释放掉，见 `installShutdown`）。
 * 位置由 Next 规定：`instrumentation.ts` 放在应用根（或 src/），**不能**放进 app/。
 *
 * 为什么经 `@aieval/api` 转出而不是直连 `@aieval/evaluator` / `@aieval/agents`：依赖方向表里
 * web-next 只到 api / core / ui / client / contracts（AGENTS.md），那两个包既不在其中、也不在
 * apps/web-next/package.json 的依赖里（pnpm 的严格 node_modules 下直连解析失败）。
 *
 * 为什么用「排除 edge」而不是「只认 nodejs」：恢复必须**真的发生**。写成 `=== 'nodejs'` 时，
 * 一旦该环境变量在某次运行里没被设置，恢复会静默不执行——那是最难发现的一类故障
 * （界面永远显示上一轮「运行中」）。Next 只有 node 与 edge 两种运行时，排除 edge 即可。
 *
 * 为什么在 register 内部动态 import：文档明确建议把副作用集中在 register 里
 *（node_modules/next/dist/docs/01-app/02-guides/instrumentation.md 的「Importing files with side effects」）；
 * 且被排除的 edge 运行时因此完全不会把 fs 相关的模块图拉进边缘包。
 */
import type { Logger } from '@aieval/core';

/** 收停机信号的信号集合：两个都能被优雅处理；`SIGKILL` 接不到，那一格不可闭合 */
const SHUTDOWN_SIGNALS: readonly NodeJS.Signals[] = ['SIGTERM', 'SIGINT'];

/**
 * 停机预算：在途会话的释放走完（或超过这段时间）就按原信号退出。
 * 为什么必须有上限：释放本身可能无界（适配器连 `dispose` 都叫不醒的迭代器），而停机不能因此永远不落。
 * 10 秒 ≈ 释放第二段的 5 秒交卷窗口 + dispose 的余量。
 */
const SHUTDOWN_GRACE_MS = 10_000;

/** 只装一次：`register()` 在一个进程里只跑一次，重复装会让同一个信号上挂多条回收路径 */
let shutdownInstalled = false;

/**
 * 装停机回收：收到信号先释放本进程在册的在途会话，再按原信号退出。
 *
 * 三条口径：
 *   · **不接管宿主的退出语义**：释放完摘掉自己的处理器、重发同一信号，退出码与「谁杀的」交回缺省动作。
 *     不用 `process.exit()`——那会连带跳过宿主自己的清理（而且信号是宿主的，不是我们的）；
 *   · **释放失败不挡退出**：记 ERROR 后照常重发。停机路径上「退出」比「回收干净」更硬；
 *   · **先全部发起停止、再一起等**：逐个「停一个等一个」会让第 N 个会话白等前面每一个的交卷窗口
 *     （顺序由 `disposeLiveSessions()` 保证，这一层只负责给预算与退出）。
 *
 * 为什么装在这一层：在途会话由 `runTurn` 登记在 agents 包内，而**宿主进程**是唯一能看到全部会话的地方；
 * 下一次启动的 `recoverInterruptedRuns()` 只管状态（把在途行标 interrupted），回收不了任何子进程
 *（SDK 代 spawn 的工具子进程是 detach 的，宿主一死它们被 reparent 到 init 继续跑）。
 */
function installShutdown(
  signal: NodeJS.Signals,
  dispose: () => Promise<void>,
  log: Logger,
): void {
  const handler = (): void => {
    process.removeListener(signal, handler);
    void shutdown(signal, dispose, log);
  };
  process.once(signal, handler);
}

/** One shutdown: release (with budget) then re-raise the original signal; never throws -- nothing may block exit.
 *
 * 首行刻意写成 ASCII：Next 16 的代码帧渲染器在含中文的行上会切字符边界并 panic（见
 * `docs/architecture/toolchain.md` 的「已知边界与取舍」），而这一行正是它在启动时唯一会渲染的那一行。中文口径与上面那句同义：
 * 一次停机，先释放（带预算）再重发原信号；本函数不抛——停机路径上任何异常都不得挡住退出。
 */
async function shutdown(
  signal: NodeJS.Signals,
  dispose: () => Promise<void>,
  log: Logger,
): Promise<void> {
  log.warn('宿主收到停机信号：开始回收在途会话', { signal, graceMs: SHUTDOWN_GRACE_MS });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      dispose(),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, SHUTDOWN_GRACE_MS);
      }),
    ]);
  } catch (error) {
    log.error('停机回收失败（继续按原信号退出）', {
      signal,
      reason: error instanceof Error ? error.message : String(error),
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  log.info('停机回收结束：按原信号退出', { signal });
  process.kill(process.pid, signal);
}

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'edge') return;

  const [{ recoverInterruptedRuns, disposeLiveSessions }, { createLogger }] = await Promise.all([
    import('@aieval/api'),
    import('@aieval/core'),
  ]);
  const log = createLogger('instrumentation');

  try {
    const { recovered } = recoverInterruptedRuns();
    log.info('服务启动：已完成被中断候选行的恢复', { recovered });
  } catch (error) {
    // 启动钩子不能把服务拖垮：恢复失败只记 ERROR，宁可用「状态不对」也不让整个服务起不来
    log.error('服务启动恢复失败（服务继续启动）', {
      reason: error instanceof Error ? error.message : String(error),
    });
  }

  // 登记在同类 try/catch 之外：上面那一步失败（磁盘读不了）不该顺带把停机回收也丢掉——
  // 在途子进程与行状态是两件事，回收那一件与恢复成不成功无关
  if (!shutdownInstalled) {
    shutdownInstalled = true;
    for (const signal of SHUTDOWN_SIGNALS) installShutdown(signal, disposeLiveSessions, log);
  }
}
