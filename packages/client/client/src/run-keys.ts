/**
 * run 域的 SWR 键（与 REST 端点同形）。
 *
 * 为什么从 `runs.ts` 拆出来：`run-events.ts`（信号流）也要用这两个键去重验缓存，
 * 而它不能反过来 import `runs.ts`——那边要 import `useRunEvents`，两边互相引就是
 * 本仓第一条包内模块环（evaluator 的静态守卫里登记过 vite 环的教训，client 不开这个头）。
 * 键的**真源**只能有一份，于是落到这个谁都不依赖的叶子模块里；
 * `runs.ts` 把它们 re-export 出去，页面与三条行级流的既有 import 一律不动。
 */

/** 列表键：与 useRuns / useCreateRun / useStartRun 的显式刷新共用 */
export const RUNS_KEY = '/api/runs';

/** 单轮详情键 */
export function runKey(runId: string): string {
  return `${RUNS_KEY}/${runId}`;
}
