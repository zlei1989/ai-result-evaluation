// @vitest-environment node
/**
 * codex **idle 档人工消息投递**的真路径守卫（真 `codex app-server` + 脚本式上游）。
 *
 * 这一格过去的判据是「我们起了轮才算交付」，而真机事实相反：条目录在**空闲**线程上时，
 * 厂商在 `thread/queue/add` 那一刻就自己把它撒成了新一轮（上游 README：*"dispatches the oldest
 * pending row … once the thread is idle"*）⇒ 我们紧接着的 `thread/queue/start` 拿到
 * `queue is empty`，按「起轮失败」处置会当场收场、`dispose` 把那一轮连同人话一起杀掉
 * （真机复现：`turn/started` 2 条、`turn/completed` 1 条、哨兵 0 次进请求体）。
 *
 * 四条判据逐条对应上面那条链：登记交付 / 哨兵进**出站请求体** / 那一轮跑完 / 结论取那一轮。
 * 阴性对照（不挂注入面）保证「哨兵在里面」是投递造成的，不是提示词或工作区泄漏。
 *
 * 驱动器：`testing/codex-injection-fixture.ts`（声明里的 `delivery.idle` 指向它）。
 */
import { afterAll, describe, expect, it } from 'vitest';
import {
  cleanupCodexInjectionScenario,
  CODEX_INJECTION_SECOND_ANSWER,
  runCodexInjectionScenario,
  type CodexInjectionScenario,
} from '../../testing/codex-injection-fixture';

describe('真机：idle 档人工消息的投递（真 app-server + 脚本式上游）', () => {
  let scenario: CodexInjectionScenario | undefined;
  afterAll(() => {
    if (scenario !== undefined) cleanupCodexInjectionScenario(scenario);
  });

  it('厂商自己投递起的那一轮：登记交付、那句话进请求体、那一轮跑完、答复成为 finalText', async () => {
    scenario = await runCodexInjectionScenario();
    const { delivery, control } = scenario;

    // ① 账本那一格：厂商真的把它投出去了 ⇒ 必须登记交付（而不是按「起轮失败」撤回）
    expect(delivery.deliveredIds, '交付必须被登记（markDelivered 收到那条 id）').toEqual(['codex-injection-msg-1']);
    // ② 那句话真的到了模型面前：判据是**厂商出站请求体**（不经过我们的任何投影）
    expect(delivery.sentinelInOutbound, '哨兵必须出现在厂商的 /v1/responses 请求体里').toBeGreaterThan(0);
    // ③ 那一轮不许被我们杀掉（收场即 dispose 杀进程）：started 与 completed 同数
    expect(delivery.turnStarted, '至少有首轮 + 厂商投递起的那一轮').toBeGreaterThanOrEqual(2);
    expect(delivery.turnCompleted, '厂商投递起的那一轮必须跑完').toBe(delivery.turnStarted);
    // ④ 结论取续跑那一轮（首轮答复不许顶替它）
    expect(delivery.finalText ?? '', '最终答复应当来自厂商投递起的那一轮').toContain(CODEX_INJECTION_SECOND_ANSWER);
    expect(delivery.requests, '投递路径是 add → start → list（判「条目已被消费」读一次队列）').toEqual(
      expect.arrayContaining(['thread/queue/add', 'thread/queue/start', 'thread/queue/list']),
    );

    /**
     * 工具表那一格（F20）：真正的开关是**顶层** `web_search:'disabled'`——`tools.web_search=false`
     * 给不给，出站请求体的工具表逐字相同（真机五臂读数）。判据取**厂商出站请求体**，
     * 那是唯一看得见「模型到底拿到了哪些工具」的地方。
     */
    expect(delivery.outboundToolTypes, '内置 hosted web_search 必须不在工具表里').not.toEqual(
      expect.arrayContaining([expect.stringContaining('web_search')]),
    );
    expect(delivery.outboundToolTypes, 'update_plan 由 tools.update_plan.enabled 打开').toEqual(
      expect.arrayContaining([expect.stringContaining('update_plan')]),
    );

    // 阴性对照：同一套装配、同一份提示词，只是不挂注入面 ⇒ 哨兵一次都不许出现
    expect(control.sentinelInOutbound, '不挂注入面时哨兵不该出现在任何出站请求体里').toBe(0);
    expect(control.deliveredIds, '不挂注入面时不该有交付登记').toEqual([]);
    expect(control.finalText ?? '', '对照臂的答复只能是首轮那一句').toContain('CODEX_INJECTION_FIRST_ANSWER');
  }, 300_000);
});
