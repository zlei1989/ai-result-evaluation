// @vitest-environment node
/**
 * dsh 人工消息面的**真路径**判据：真运行时 + 脚本式上游 + **产品的**插件与桥。
 *
 * 判据为什么必须落在这里（而不是假 SDK 那一档）：`'round'` 档的 `agent.steer` 与撤回的
 * `inbox.remove` 都在 runtime 进程内，假件把 SDK 换掉之后只剩下「我们写了什么文件」可看——
 * 而「插件到底有没有拿到那条 `Agent`、那句话有没有真的进模型的上下文」两件事，只有两条
 * **厂商侧事实**说得出来：插件自报的加载事实、以及**入站请求体**（模型看到的那一份）。
 *
 * 三条判据刻意互相咬住（缺一条就分不出「没接」与「接坏了」）：
 *   ① 插件加载了、且这一版 profile 下 `ctx.agents` 拿得到（`hasAgents`）；
 *   ② `'round'` 档的哨兵**早于** `'idle'` 档的哨兵进入模型上下文（前者在下一步、后者在下一轮）；
 *   ③ 撤回那一条**一次都没出现过**，且端口拿到的是 `retracted`（不是 `unknown` / `already-consumed`）。
 */
import { describe, expect, it } from 'vitest';
import { runDshRealPathInjection } from '../../testing/dsh-real-path-fixture';

/** 三个哨兵词：随机化的字面量（写死一个常见词会被「模型猜中」污染判据） */
const ROUND = 'aieval-inject-round-8f3a71';
const IDLE = 'aieval-inject-idle-2c91d4';
const RETRACTED = 'aieval-inject-retracted-77b0e5';

/** 上游压住第一条带工具表的请求这么久——这是「一轮在途」的窗口（驱动器在它里面投三条） */
const HOLD_MS = 3_000;

const run = await runDshRealPathInjection({
  sentinels: { round: ROUND, idle: IDLE, retracted: RETRACTED },
  holdMs: HOLD_MS,
});

describe('人工消息面真路径（dsh）', () => {
  it('插件真的被厂商加载，且动手那一刻拿得到 agent 服务', () => {
    expect(run.pluginLoaded, '插件一个候选都没加载：sidecar 里没有 plugin-loaded 收据').not.toBeNull();
    // 相对名按 `<dshHome>` 根解析（与适配器的另外两支插件同一条基准）
    expect(run.pluginLoaded?.url.endsWith('/aieval-inject.mjs')).toBe(true);
    /**
     * 判据取**动手那一刻**的读数（`steered` / `removed` 收据里的 `hasAgents`），不是加载那一刻的：
     * agent 服务由另一行插件 provide，加载顺序不保证它在插件加载时已经就位。
     */
    expect(run.actionReceipts.length).toBeGreaterThanOrEqual(2);
    expect(
      run.actionReceipts.every((row) => row['hasAgents'] === true),
      `进程内投递/撤回时拿不到 agent 服务 ⇒ 这一档不成立（收据：${JSON.stringify(run.actionReceipts)}）`,
    ).toBe(true);
  });

  /**
   * **反向断言**：插件真的加载了 ⇒ 收尾那条「没等到加载收据」的点名 WARN 一条都不许有。
   *
   * 这一条与上面 `pluginLoaded` 那条判据同源、但落在**另一侧**：收据是给读日志的人看的，
   * WARN 是给「功能静默失效」这件事留的痕。少了这条反向断言，把 WARN 的条件写反
   * （例如恒真）也能让正向那一条过。
   */
  it('插件加载正常 ⇒ 收尾不落「没等到加载收据」的点名 WARN', () => {
    const warns = run.product.events.filter(
      (event) =>
        event.type === 'log'
        && event.stream === 'stderr'
        && typeof event.text === 'string'
        && event.text.startsWith('[WARN] 人工消息面配了插件'),
    );
    expect(warns).toHaveLength(0);
  });

  it('\'round\' 档经 agent.steer 进下一步、\'idle\' 档经 wire 进下一轮：前者严格更早', () => {
    const roundHits = run.sentinelInRequests(ROUND);
    const idleHits = run.sentinelInRequests(IDLE);
    const firstRound = roundHits.findIndex((messages) => messages.length > 0);
    const firstIdle = idleHits.findIndex((messages) => messages.length > 0);
    expect(firstRound, '\'round\' 档的哨兵一次都没进模型的上下文（steer 没投出去）').toBeGreaterThanOrEqual(0);
    expect(firstIdle, '\'idle\' 档的哨兵一次都没进模型的上下文（wire 入队没投出去）').toBeGreaterThanOrEqual(0);
    expect(
      firstRound,
      `'round' 档应当在下一次 step 边界就被投出去（'idle' 档要等下一轮）——实际第 ${String(firstRound)} 条请求 vs 第 ${String(firstIdle)} 条`,
    ).toBeLessThan(firstIdle);
  });

  it('撤回走进程内 inbox.remove：那一条一次都没进模型上下文，端口拿到 retracted', () => {
    const retractedHits = run.sentinelInRequests(RETRACTED);
    expect(
      retractedHits.every((messages) => messages.length === 0),
      '撤回的那条哨兵出现在了入站请求体里 ⇒ 撤回没生效（或撤晚了）',
    ).toBe(true);
    expect(run.retractOutcome).toBe('retracted');
  });
});
