/**
 * Next 服务启动钩子：把上一个进程留下的在途候选行标成 interrupted（F10，不自动续跑）。
 * 位置由 Next 规定：`instrumentation.ts` 放在应用根（或 src/），**不能**放进 app/。
 *
 * 为什么经 `@aieval/api` 转出而不是直连 `@aieval/evaluator`：依赖方向表里 web-next 只到
 * api / core / ui / client / contracts（AGENT.md），evaluator 既不在其中、也不在
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
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'edge') return;

  const [{ recoverInterruptedRuns }, { createLogger }] = await Promise.all([
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
}
