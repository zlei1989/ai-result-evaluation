// @vitest-environment node
/**
 * codex **在途死亡**的真路径守卫（真 `codex app-server` + 上游挂着 + 从探针侧杀掉子进程）。
 *
 * 要拦的缺陷：进程死在在途时，通知流里**一条终态都没有**（没有 `turn/completed`），
 * 而失败事实只落在会话的终态结算上 ⇒ 只按流内载荷投影时，这个候选会按
 * `ok:true / exitReason:'completed'` 落盘（真机复现：两臂都 `ok:true`，`finalText` / `tokens` /
 * `turns` 全空，只在日志里留一条「子线程树不是全量」的 WARN）。
 *
 * 对照臂（不杀）证明这条臂能看见差异：同一套装配、同一份剧本，只是不杀 ⇒ 成功。
 *
 * 驱动器：`testing/codex-death-fixture.ts`。
 */
import { afterAll, describe, expect, it } from 'vitest';
import {
  cleanupCodexDeathScenario,
  runCodexDeathScenario,
  type CodexDeathScenario,
} from '../../testing/codex-death-fixture';

describe('真机：app-server 在途死亡时这个候选的结算', () => {
  let scenario: CodexDeathScenario | undefined;
  afterAll(() => {
    if (scenario !== undefined) cleanupCodexDeathScenario(scenario);
  });

  it('在途死亡 ⇒ 按失败结算并点名进程退出（对照臂：同装配不杀 ⇒ 成功）', async () => {
    scenario = await runCodexDeathScenario();
    const { control, killed } = scenario;

    // 对照臂：不杀 ⇒ 正常成功（证明这条臂有区分力，不是「怎么都判失败」）
    expect(control.killed).toBe(false);
    expect(control.upstreamRequests, '对照臂必须真的走到过模型请求').toBeGreaterThan(0);
    expect(control.result.ok, '对照臂应当成功').toBe(true);

    // 被测臂：在途死亡必须折成失败，且原因要点名进程退出（不是被归成别的什么）
    expect(killed.killed).toBe(true);
    expect(killed.upstreamRequests, '被测臂必须在 turn/start 受理之后才杀（那一刻这一轮在途）').toBeGreaterThan(0);
    expect(killed.result.ok, '在途死亡：不许按成功落盘').toBe(false);
    expect(killed.result.exitReason).toBe('error');
    expect(killed.result.error?.message ?? '', '失败原因必须点名进程退出').toContain('进程已退出');
  }, 300_000);
});
