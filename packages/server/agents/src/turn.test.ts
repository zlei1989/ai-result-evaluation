// @vitest-environment node
/**
 * 运行骨架：判定优先级、**轮次的发射门槛**、释放顺序、dispose 幂等、永不抛。
 * 用**合成 hooks**（不经过任何厂商消息形状）测骨架：每条断言恰好对应一条规则；厂商特有的注入与
 * 投影由各 provider 的用例覆盖。
 *
 * 2026-09-28 的口径修正（用户：「执行不限时间、评分不限轮次和时间」+「轮次按模型 API 往返算」）：
 *   · 骨架里**没有超时**了 —— 原来「内层超时 → timed-out」那一组用例改成「挂住的适配器不会被
 *     任何时间流逝叫停，只有 `signal` 能停它」，这是新口径的守卫；
 *   · `usage` 事件的发射门槛从「tokens 与 turns 同时在」改成**看轮次**（tokens 可空）。
 */
import type { AgentEvent, AgentMessage, SubagentRecord } from '@aieval/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentLoadError } from './errors';
import { RELEASE_GRACE_MS } from './release';
import {
  collectEvents,
  createFakeStream,
  createRecorder,
  createRunInput,
  settleWithFakeTimers,
  type FakeVendorRecorder,
} from './testing/agent-fixtures';
import type { MessageDraft } from './message';
import { runTurn, type TurnFinalize, type TurnHooks, type TurnProjection } from './turn';

interface Harness {
  hooks: TurnHooks;
  recorder: FakeVendorRecorder;
  stats: { startCount: number; disposeCount: number; finalizeCount: number };
}

/** 造一套合成 hooks：事件流可挂住、interrupt 可合作也可忽略、start 可直接抛 */
function createHarness(
  options: {
    events?: readonly unknown[];
    /** 'stop'（默认，合作）| 'ignore'（忽略停止信号：dsh 与非合作 CLI 的真实形状） */
    interrupt?: 'stop' | 'ignore';
    hang?: boolean;
    streamError?: unknown;
    startError?: unknown;
    /** 固定投影，或**按事件**给投影（后者用来造「流内失败」：见下面那两条退出错误取舍的用例） */
    projection?: TurnProjection | ((raw: unknown) => TurnProjection);
    /** dispose 自身的耗时（假定时器下用）：把释放窗口铺开，用来测「释放期间被终止」（评审 F4） */
    disposeDelayMs?: number;
    /** 收尾投影（`TurnStart.finalize`）：调用次数记在 `stats.finalizeCount` 上 */
    finalize?: () => TurnFinalize;
  } = {},
): Harness {
  const recorder = createRecorder();
  const stats = { startCount: 0, disposeCount: 0, finalizeCount: 0 };
  const hooks: TurnHooks = {
    kind: 'claude-code',
    start: async (context) => {
      stats.startCount += 1;
      if (options.startError !== undefined) throw options.startError;
      const stream = createFakeStream(options.events ?? [], recorder, {
        hang: options.hang === true,
        throwAfterEvents: options.streamError,
      });
      // 厂商 SDK 的硬中止入口（真实适配器把 controller 交给 SDK，这里用 abort 事件代表它）
      context.controller.signal.addEventListener('abort', () => stream.stop(), { once: true });
      return {
        stream: stream.iterable,
        ...(options.finalize === undefined
          ? {}
          : {
            finalize: () => {
              stats.finalizeCount += 1;
              recorder.order.push('finalize');
              return options.finalize!();
            },
          }),
        interrupt: () => {
          recorder.order.push('interrupt');
          if (options.interrupt !== 'ignore') stream.stop();
        },
        dispose: async () => {
          if (options.disposeDelayMs !== undefined) {
            await new Promise<void>((resolve) => {
              setTimeout(resolve, options.disposeDelayMs);
            });
          }
          stats.disposeCount += 1;
          recorder.order.push('dispose');
          stream.stop();
        },
        project: (raw) =>
          typeof options.projection === 'function'
            ? options.projection(raw)
            : (options.projection ?? { drafts: [], tokens: null, turns: null, failure: null }),
      };
    },
  };
  return { hooks, recorder, stats };
}

/** 收集 logger 的 error 级输出：事件回调抛错后必须仍然可见（评审 F1 的第二半） */
function captureLoggerErrors(): string[] {
  const messages: string[] = [];
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    messages.push(args.map((arg) => String(arg)).join(' '));
  });
  return messages;
}

beforeEach(() => {
  captureLoggerErrors();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('runTurn', () => {
  it('正常完成：ok + completed，轮次与计量都带进结果与 usage 事件', async () => {
    const events: AgentEvent[] = [];
    const harness = createHarness({
      events: [{ kind: 'message' }],
      projection: { drafts: [], tokens: { input: 10, cached: 2, output: 5 }, turns: 3, failure: null },
    });
    const result = await runTurn(createRunInput({ onEvent: collectEvents(events) }), harness.hooks);
    expect(result).toMatchObject({
      ok: true,
      exitReason: 'completed',
      tokens: { input: 10, cached: 2, output: 5 },
      turns: 3,
    });
    expect(events.filter((event) => event.type === 'usage')).toHaveLength(1);
    // 正常出口也要释放（§5.6.5：所有出口一个都不能漏）
    expect(harness.stats.disposeCount).toBe(1);
  });

  /**
   * 轮次的发射门槛（2026-09-28 用户口径修正）。三条一起钉：
   *   ① 只带轮次（tokens: null）也要发 —— 实测缺口：claude-code 的 token 采不到时整轮一条都不发，
   *      界面停在「轮次 1」；
   *   ② 轮次相同、计量也相同 ⇒ **不重复发**（同一条消息的重复快照不该刷日志）；
   *   ③ 只有 tokens、还没有轮次 ⇒ **不发**（turns 必填），但结果里照样带上 tokens（采到的计量不丢）。
   */
  it('usage 的门槛是轮次：只带轮次也发、同值不重发、只有 tokens 时不发但结果仍带上', async () => {
    const events: AgentEvent[] = [];
    const harness = createHarness({
      events: [{ kind: 'round-1' }, { kind: 'round-2' }, { kind: 'same-again' }, { kind: 'tokens-only' }],
      projection: (raw) => {
        const kind = (raw as { kind: string }).kind;
        if (kind === 'round-1') return { drafts: [], tokens: { input: 100, cached: 0, output: 5 }, turns: 1, failure: null };
        if (kind === 'round-2') return { drafts: [], tokens: null, turns: 2, failure: null };
        // 与 round-2 逐字段相同：不该再发一条
        if (kind === 'same-again') return { drafts: [], tokens: null, turns: 2, failure: null };
        return { drafts: [], tokens: { input: 300, cached: 7, output: 9 }, turns: null, failure: null };
      },
    });
    const result = await runTurn(createRunInput({ onEvent: collectEvents(events) }), harness.hooks);

    const usages = events.filter((event) => event.type === 'usage');
    expect(usages.map((event) => (event.type === 'usage' ? [event.turns, event.tokens] : null))).toEqual([
      [1, { input: 100, cached: 0, output: 5 }],
      // 第二条只报轮次：计量沿用上一次的累计值（覆盖语义，不能把界面上的 tok 抹成「采集中」）
      [2, { input: 100, cached: 0, output: 5 }],
    ]);
    // tokens-only 那一条不发事件，但结果里是最新的计量（最后一条采到的权威值）
    expect(result.tokens).toEqual({ input: 300, cached: 7, output: 9 });
    expect(result.turns).toBe(2);
  });

  /**
   * 归属格（2026-10-05）：骨架**只搬运**——投影没给就是 `null`（不结转上一条，也不拿 `turns` 顶替）。
   * 第二条判据是去重：同一条读数**换了归属**也要再发一条，否则界面上的落点会停在旧的那个轮次。
   */
  it('usage 事件带上投影交出的归属；归属变了要重发（骨架不做加法、不结转）', async () => {
    const events: AgentEvent[] = [];
    const projections: TurnProjection[] = [
      { drafts: [], tokens: null, turns: 1, failure: null, turn: { subagentId: null, round: 1 } },
      // ② 载荷三格与上一条**逐字段相同**，只有归属不同 ⇒ 必须再发一条
      { drafts: [], tokens: null, turns: 1, failure: null, turn: { subagentId: 'child-1', round: 1 } },
      // ③ 本条不给归属 ⇒ 事件那一格是 null（**不是**沿用上一条的子会话）
      { drafts: [], tokens: null, turns: 2, failure: null },
    ];
    let index = 0;
    const { hooks } = createHarness({
      events: ['a', 'b', 'c'],
      projection: () => projections[index++] ?? { drafts: [], tokens: null, turns: null, failure: null },
    });
    await runTurn(createRunInput({ onEvent: collectEvents(events) }), hooks);
    const usages = events.filter((event): event is Extract<AgentEvent, { type: 'usage' }> => event.type === 'usage');
    expect(usages.map((event) => event.turn)).toEqual([
      { subagentId: null, round: 1 },
      { subagentId: 'child-1', round: 1 },
      null,
    ]);
  });

  // `tokensEstimated` 是 claude-code 的跑动期估算：它只进事件，**绝不进结果**——
  // 否则崩溃 / 被杀的行会带着一份估算被写成「采到了计量」，而快照是唯一落盘真相。
  it('估算计量只进事件、不进结果（tokensEstimated）', async () => {
    const events: AgentEvent[] = [];
    const harness = createHarness({
      events: [{ kind: 'estimate' }],
      projection: {
        drafts: [],
        tokens: { input: 40, cached: 3, output: 2 },
        tokensEstimated: true,
        turns: 5,
        failure: null,
      },
    });
    const result = await runTurn(createRunInput({ onEvent: collectEvents(events) }), harness.hooks);

    const usage = events.find((event) => event.type === 'usage');
    expect(usage?.type === 'usage' ? usage.tokens : null).toEqual({ input: 40, cached: 3, output: 2 });
    expect(usage?.type === 'usage' ? usage.turns : null).toBe(5);
    expect(result.tokens).toBeNull();
    expect(result.turns).toBe(5);
  });

  /**
   * **权威值一到，跑动期的估算必须让位**（2026-09-28 复查新增）：两者都是「到目前的累计」，
   * 而估算的来源（`message.usage`）被 SDK 明写为 not final ⇒ 留着它，收尾那条 `usage` 事件就还会
   * 显示一个偏小的假数。判据看**权威值到达之后的每一条**：不许再回落到估算。
   */
  it('权威计量到达后估算作废（其后的 usage 事件不许再显示估算值）', async () => {
    const events: AgentEvent[] = [];
    const harness = createHarness({
      events: [{ kind: 'estimate' }, { kind: 'authoritative' }, { kind: 'turn-again' }],
      projection: (raw) => {
        const kind = (raw as { kind: string }).kind;
        if (kind === 'estimate') {
          return {
            drafts: [],
            tokens: { input: 40, cached: 3, output: 2 },
            tokensEstimated: true,
            turns: 1,
            failure: null,
          };
        }
        if (kind === 'authoritative') {
          return { drafts: [], tokens: { input: 900, cached: 700, output: 60 }, turns: 2, failure: null };
        }
        // 收尾之后又来一条只带轮次的投影：它沿用「到目前为止」的计量 —— 必须是权威值
        return { drafts: [], tokens: null, turns: 3, failure: null };
      },
    });
    const result = await runTurn(createRunInput({ onEvent: collectEvents(events) }), harness.hooks);

    const usages = events.filter((event) => event.type === 'usage');
    expect(usages.map((event) => (event.type === 'usage' ? event.tokens : null))).toEqual([
      { input: 40, cached: 3, output: 2 },
      { input: 900, cached: 700, output: 60 },
      { input: 900, cached: 700, output: 60 },
    ]);
    // 估算从来只进事件：结果里是世界给的权威值
    expect(result.tokens).toEqual({ input: 900, cached: 700, output: 60 });
  });

  /**
   * **执行不限时间**（用户口径，2026-09-28）：适配器挂住时，再多的时间流逝也不会让它自己结束
   * ——没有内层超时、也没有外层兜底。唯一能停下它的是 `signal`（用户点「终止」）。
   * 这是删掉 `AgentRunInput.timeoutMs` 之后**必须**有的守卫：少了它，「有人把超时加回来」
   * 这件事没有任何用例会红。
   */
  it('挂住的适配器不会因为时间流逝被叫停（执行不限时间），只有 signal 能停它', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const harness = createHarness({ interrupt: 'ignore', hang: true });
    const promise = runTurn(createRunInput({ signal: controller.signal }), harness.hooks);
    let settled = false;
    void promise.then(() => {
      settled = true;
    });

    // 推进 1 小时：仍然没有任何结论，也没有释放动作（原来这里到点就会 timed-out）
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(settled).toBe(false);
    expect(harness.stats.disposeCount).toBe(0);
    expect(harness.recorder.order).toEqual([]);

    // 用户点「终止」：interrupt 无人响应 ⇒ 第二段在 5 秒后用 dispose 硬回收
    controller.abort();
    const result = await settleWithFakeTimers(promise, { stepMs: 1_000, steps: 10 });
    expect(result.exitReason).toBe('canceled');
    expect(result.error?.code).toBe('AGENT_CANCELED');
    expect(harness.recorder.order).toEqual(['interrupt', 'dispose', 'turn-end']);
    expect(harness.stats.disposeCount).toBe(1);
  });

  it('适配器忽略 interrupt：5 秒后落 WARN 并强制释放，运行仍在有限时间内结束（Review Focus #3）', async () => {
    // 常量值本身也要钉住：本用例走的是假定时器 + 默认 graceMs，
    // 若有人把 RELEASE_GRACE_MS 从 5_000 改成别的值，这一格必须红——所以除行为断言外，
    // 再直接断言常量值（`RELEASE_GRACE_MS === 5_000`，见本用例中段）。只验 `graceMs` 覆盖参数
    // 是**测不到常量本身**的：那一路根本不读常量。
    expect(RELEASE_GRACE_MS).toBe(5_000);
    vi.useFakeTimers();
    const controller = new AbortController();
    const events: AgentEvent[] = [];
    const harness = createHarness({ interrupt: 'ignore', hang: true });
    const promise = runTurn(createRunInput({ signal: controller.signal, onEvent: collectEvents(events) }), harness.hooks);
    await vi.advanceTimersByTimeAsync(100);
    controller.abort();
    const result = await settleWithFakeTimers(promise, { stepMs: 1_000, steps: 10 });
    expect(result.exitReason).toBe('canceled');
    expect(harness.stats.disposeCount).toBe(1);
    // 非合作适配器的真实形状：interrupt 无人响应 → 第二段强制 dispose → 流这才结束
    expect(harness.recorder.order).toEqual(['interrupt', 'dispose', 'turn-end']);
    // 只数**释放路径**那条 WARN：2026-09-28 起「用户终止」的结论摘要本身也带 `[WARN]` 前缀
    //（`assembleResult` 的 canceled 分支），所以不能再按「所有 [WARN]」计数——那样数出两条
    // 会让这条守卫失去区分力（它要钉的是「grace 只响了一次」）。
    const warns = events.filter(
      (event) => event.type === 'log' && event.text.includes('[WARN]') && event.text.includes('秒内未结束在途 turn'),
    );
    expect(warns).toHaveLength(1);
    expect(warns[0]?.type === 'log' ? warns[0].text : '').toContain(`${RELEASE_GRACE_MS / 1000} 秒`);
  });

  it('signal 中止 ⇒ canceled（判定优先级里不再有「自身超时」这一档）', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const harness = createHarness({ interrupt: 'ignore', hang: true });
    const promise = runTurn(createRunInput({ signal: controller.signal }), harness.hooks);
    await vi.advanceTimersByTimeAsync(400);
    controller.abort(); // 用户终止
    const result = await settleWithFakeTimers(promise, { stepMs: 1_000, steps: 10 });
    expect(result.exitReason).toBe('canceled');
    expect(result.error?.code).toBe('AGENT_CANCELED');
  });

  it('重复中止也只 dispose 一次（幂等）', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const harness = createHarness({ interrupt: 'ignore', hang: true });
    const promise = runTurn(createRunInput({ signal: controller.signal }), harness.hooks);
    await vi.advanceTimersByTimeAsync(200);
    controller.abort();
    controller.abort();
    await settleWithFakeTimers(promise, { stepMs: 1_000, steps: 10 });
    expect(harness.stats.disposeCount).toBe(1);
    expect(harness.recorder.order.filter((entry) => entry === 'dispose')).toHaveLength(1);
  });

  it('启动前已中止：不建任何运行时（start 一次都不调用），结果为 canceled', async () => {
    const controller = new AbortController();
    controller.abort();
    const harness = createHarness();
    const result = await runTurn(createRunInput({ signal: controller.signal }), harness.hooks);
    expect(result.exitReason).toBe('canceled');
    expect(result.error?.code).toBe('AGENT_CANCELED');
    expect(harness.stats.startCount).toBe(0);
    expect(harness.recorder.order).toEqual([]);
  });

  it('加载失败折进结果（AGENT_LOAD_FAILED）且 run 不抛', async () => {
    const harness = createHarness({
      startError: new AgentLoadError('@openai/codex-sdk', new Error('Cannot find module')),
    });
    const result = await runTurn(createRunInput(), harness.hooks);
    expect(result).toMatchObject({ ok: false, exitReason: 'error' });
    expect(result.error?.code).toBe('AGENT_LOAD_FAILED');
    expect(result.error?.message).toContain('@openai/codex-sdk');
    expect(result.error?.message).toContain('pnpm add');
    // start 阶段就失败：没有任何在途 turn 与客户端，因此没有释放顺序可言（也不会产生孤儿）
    expect(harness.stats.startCount).toBe(1);
    expect(harness.recorder.order).toEqual([]);
  });

  it('事件流抛错：exitReason error + AGENT_FAILED，错误事件落到 onEvent，run 不抛', async () => {
    const events: AgentEvent[] = [];
    const harness = createHarness({ events: [], streamError: new Error('spawn codex ENOENT') });
    const result = await runTurn(createRunInput({ onEvent: collectEvents(events) }), harness.hooks);
    expect(result).toMatchObject({ ok: false, exitReason: 'error' });
    expect(result.error?.code).toBe('AGENT_FAILED');
    expect(result.error?.message).toContain('ENOENT');
    expect(events.some((event) => event.type === 'error')).toBe(true);
    expect(harness.stats.disposeCount).toBe(1);
  });

  /**
   * 退出错误 vs 流内失败的取舍（2026-09-27，目标页 codex 实测）。
   *
   * 背景：`@openai/codex-sdk` 把**stderr 全文**拼进退出错误，而 codex CLI **每次运行**都会打
   * `Reading prompt from stdin...` ⇒ codex 的每一行失败都会被写成
   * 「`Codex Exec exited with code 1: Reading prompt from stdin...`」，那句话里没有一个字是原因。
   * 真正的原因通常在事件流里（`{"type":"error",…}`），由 `project` 收成 `failure`。
   * 两条判据各钉一遍：**只剩样板 ⇒ 不覆盖**；**带实质内容 ⇒ 覆盖**。
   */
  it('退出错误只剩 CLI 样板（Reading prompt from stdin）⇒ 保留流内原因，并把退出码写成补充', async () => {
    const events: AgentEvent[] = [];
    const harness = createHarness({
      events: [{ kind: 'upstream-5xx' }],
      streamError: new Error('Codex Exec exited with code 1: Reading prompt from stdin...'),
      projection: (raw) => {
        if ((raw as { kind?: string }).kind !== 'upstream-5xx') {
          return { drafts: [], tokens: null, turns: null, failure: null };
        }
        return {
          drafts: [],
          tokens: null,
          turns: null,
          failure: { code: 'AGENT_FAILED', message: 'Reconnecting... 5/5 (We\'re currently experiencing high demand.)' },
        };
      },
    });

    const result = await runTurn(createRunInput({ onEvent: collectEvents(events) }), harness.hooks);

    expect(result.exitReason).toBe('error');
    // 原因必须还是流内那条——原来它会被退出错误整个顶掉，用户只看到「Reading prompt from stdin...」
    expect(result.error?.message).toContain('high demand');
    expect(result.error?.message).not.toContain('Reading prompt from stdin');
    // 但「CLI 以退出码 1 收场」是本次运行的真实结局，不能抹掉
    expect(result.error?.message).toContain('退出码 1');
  });

  it('退出错误自带可识别的 HTTP 状态（Codex Exec exited with code 1: 401 Unauthorized）⇒ 覆盖流内抱怨', async () => {
    const harness = createHarness({
      events: [{ kind: 'transient' }],
      streamError: new Error('Codex Exec exited with code 1: 401 Unauthorized'),
      projection: () => ({
        drafts: [],
        tokens: null,
        turns: null,
        // 流内只是一句没有状态的抱怨：它比 401 更不具体，不该留住
        failure: { code: 'AGENT_FAILED', message: 'Reconnecting... 5/5 (We\'re currently experiencing high demand.)' },
      }),
    });

    const result = await runTurn(createRunInput({ onEvent: () => {} }), harness.hooks);

    expect(result.error?.code).toBe('AUTH_FAILED');
    expect(result.error?.message).toContain('密钥无效');
    expect(result.error?.message).not.toContain('high demand');
  });

  it('流内没有失败时，退出错误照旧是唯一归因（不能因为新判据把这条路径弄丢）', async () => {
    const harness = createHarness({
      events: [],
      streamError: new Error('Codex Exec exited with code 1: 上游返回 500 服务维护中'),
    });

    const result = await runTurn(createRunInput({ onEvent: () => {} }), harness.hooks);

    expect(result.exitReason).toBe('error');
    expect(result.error?.message).toContain('服务维护中');
  });

  it('退出错误里的 5xx 不夺走流内原因（5xx 是瞬时面、归因码相同 ⇒ 留信息更多的那条）', async () => {
    const harness = createHarness({
      events: [{ kind: 'transient' }],
      streamError: new Error('Codex Exec exited with code 1: unexpected status 500 Service Unavailable'),
      projection: () => ({
        drafts: [],
        tokens: null,
        turns: null,
        failure: { code: 'AGENT_FAILED', message: 'Reconnecting... 5/5 (We\'re currently experiencing high demand.)' },
      }),
    });

    const result = await runTurn(createRunInput({ onEvent: () => {} }), harness.hooks);

    // 流内那句才是「关于这次失败的信息」；「unexpected status 500」只说了一个瞬时面，两者码相同
    expect(result.error?.message).toContain('high demand');
    expect(result.error?.message).not.toContain('Service Unavailable');
    // 但「CLI 以退出码 1 收场」这个事实照旧保留
    expect(result.error?.message).toContain('退出码 1');
  });

  it('退出错误里的 4xx 是确定性归因 ⇒ 覆盖流内的瞬时抱怨', async () => {
    const harness = createHarness({
      events: [{ kind: 'transient' }],
      streamError: new Error('Codex Exec exited with code 1: unexpected status 429 Too Many Requests'),
      projection: () => ({
        drafts: [],
        tokens: null,
        turns: null,
        failure: { code: 'AGENT_FAILED', message: 'Reconnecting... 5/5 (We\'re currently experiencing high demand.)' },
      }),
    });

    const result = await runTurn(createRunInput({ onEvent: () => {} }), harness.hooks);

    expect(result.error?.code).toBe('RATE_LIMITED');
    expect(result.error?.message).not.toContain('high demand');
  });

  it('CLI 的 stderr 会落进该行事件流（只有它能区分「网关 5xx」与「Responses 契约不满足」）', async () => {
    const events: AgentEvent[] = [];
    const harness = createHarness({
      events: [],
      streamError: new Error('Codex Exec exited with code 1: 上游网关返回 502 Bad Gateway'),
    });

    await runTurn(createRunInput({ onEvent: collectEvents(events) }), harness.hooks);

    const logged = events
      .filter((event) => event.type === 'log')
      .map((event) => (event.type === 'log' ? event.text : ''))
      .join('\n');
    expect(logged).toContain('CLI 退出详情');
    expect(logged).toContain('502 Bad Gateway');
    // 样板行不进抽屉（它零信息量）
    expect(logged).not.toContain('Reading prompt from stdin');
  });

  it('事件回调抛错不外抛：结论照常返回、释放照走完，失败落 logger.error（评审 F1）', async () => {
    // 消费方抛错是**真实形状**：p4 的 publishRowEvent → appendEvent 按契约 R26 在写侧 schema 不过时抛
    // ServiceError，磁盘写失败同样抛；而 p4 的编排层不给每一行套 try/catch（正因 run() 承诺不抛）。
    // 这里让 onEvent 对**每条**事件都抛：若发射口没有受保护，首条事件就会把异常冒进循环的 catch，
    // 被归因成 AGENT_FAILED（把「日志写盘失败」误报成「适配器运行失败」）。
    const loggerErrors = captureLoggerErrors();
    const harness = createHarness({
      events: [{ kind: 'message' }],
      projection: { drafts: [], tokens: { input: 10, cached: 2, output: 5 }, turns: 3, failure: null },
    });
    const result = await runTurn(
      createRunInput({
        onEvent: () => {
          throw new Error('日志写盘失败');
        },
      }),
      harness.hooks,
    );
    expect(result).toMatchObject({
      ok: true,
      exitReason: 'completed',
      tokens: { input: 10, cached: 2, output: 5 },
      turns: 3,
    });
    // 释放照走完：结论不能因为消费方抛错而丢掉回收（§5.6.5：所有出口一个都不能漏）
    expect(harness.stats.disposeCount).toBe(1);
    // 必须仍然可见：release.ts 的对应修复刻意吞掉 onGraceExceeded 的异常，这层不记就彻底静默了
    expect(loggerErrors.some((line) => line.includes('事件回调失败'))).toBe(true);
  });

  it('运行正常完成后、释放窗口内被终止：结论仍是 completed，不被翻转成 canceled（评审 F4）', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    // 流正常结束（无事件、不挂住）⇒ 结论已定；dispose 自己慢 1 秒 ⇒ 铺开一个「已跑完但还在释放」的窗口
    const harness = createHarness({ disposeDelayMs: 1_000 });
    const promise = runTurn(createRunInput({ signal: controller.signal }), harness.hooks);
    await vi.advanceTimersByTimeAsync(500);
    // 此刻：流已结束、结论已是 completed，释放还在等 dispose；用户此时点「终止」
    controller.abort();
    const result = await settleWithFakeTimers(promise, { stepMs: 500, steps: 10 });
    expect(result.exitReason).toBe('completed');
    expect(result.error).toBeUndefined();
  });

  // 以下三条是复评 NEW-2 要求的「只在某一条出口抛」：上一条（对每条事件都抛）实测只踩到循环内 usage
  // 一处——投影的 drafts 是空数组，而该轮走 completed，因此 drafts 与三个「最后出口」一次都没执行。
  // 致命的是：`assembleResult` 的 `emit` 实参若被换成**同类型未保护闭包**，vitest / tsc / eslint 三闸全绿
  // （复评的存活变异体 (e)）⇒ 必须由用例逐个把调用点钉住。

  it('只有循环内 drafts 出口抛错：不抛、结果 completed、释放照走完、失败落 logger.error（复评 NEW-2）', async () => {
    const loggerErrors = captureLoggerErrors();
    const harness = createHarness({
      events: [{ kind: 'message' }],
      projection: {
        drafts: [{ type: 'log', stream: 'stdout', text: '进度' }],
        tokens: null,
        turns: null,
        failure: null,
      },
    });
    const result = await runTurn(
      createRunInput({
        onEvent: (event) => {
          if (event.type === 'log') throw new Error('日志写盘失败（drafts 出口）');
        },
      }),
      harness.hooks,
    );
    expect(result).toMatchObject({ ok: true, exitReason: 'completed' });
    expect(harness.stats.disposeCount).toBe(1);
    expect(loggerErrors.some((line) => line.includes('事件回调失败'))).toBe(true);
  });

  it('completed 结论本身不发任何事件（所以它只能靠 error 出口那条用例来钉）；onEvent 抛错不影响结论（复评 NEW-2）', async () => {
    const loggerErrors = captureLoggerErrors();
    const harness = createHarness();
    const result = await runTurn(
      createRunInput({
        onEvent: () => {
          throw new Error('日志写盘失败（无出口被踩到）');
        },
      }),
      harness.hooks,
    );
    expect(result).toMatchObject({ ok: true, exitReason: 'completed' });
    expect(harness.stats.disposeCount).toBe(1);
    // 实测事实（我第一版写错了这条断言，跑出来才发现）：`assembleResult` 的 completed 分支
    // **一条事件都不发**，因此这一轮没有任何发射口被踩到，logger.error 不该被调用。
    // 换句话说：把 `assembleResult` 的 emit 实参换成未保护闭包的变异体，**只能**由下面那条
    // 「error 事件出口」用例拦住（那里才真的会发一条安全事件）——这条断言把这件事钉下来。
    expect(loggerErrors.some((line) => line.includes('事件回调失败'))).toBe(false);
  });

  it('只有 error 事件出口抛错：不抛、结果仍 error + AGENT_FAILED、失败落 logger.error（复评 NEW-2）', async () => {
    const loggerErrors = captureLoggerErrors();
    const harness = createHarness({ events: [], streamError: new Error('spawn codex ENOENT') });
    const result = await runTurn(
      createRunInput({
        onEvent: (event) => {
          if (event.type === 'error') throw new Error('日志写盘失败（error 出口）');
        },
      }),
      harness.hooks,
    );
    expect(result).toMatchObject({ ok: false, exitReason: 'error' });
    expect(result.error?.code).toBe('AGENT_FAILED');
    expect(harness.stats.disposeCount).toBe(1);
    expect(loggerErrors.some((line) => line.includes('事件回调失败'))).toBe(true);
  });

  // 最终答复出口（spec §8）：骨架只负责把 state.finalText 带进结果，不负责解释它。
  // 「未采到 = null」这一格必须与「采到空串」分得开——所以下面两条分别钉住「带出」与「不发明值」。
  it('finalText 在成功与失败两种结论下都被带出', async () => {
    // 造一个在流里写 state.finalText 的假适配器：骨架只负责把它带进结果，不负责解释它
    const hooks: TurnHooks = {
      kind: 'codex',
      start: async () => ({
        stream: (async function* () {
          yield { type: 'x' };
        })(),
        interrupt: () => {},
        dispose: async () => {},
        project: (_raw, state) => {
          state.finalText = '最终答复';
          return { drafts: [], tokens: null, turns: null, failure: null };
        },
      }),
    };
    const ok = await runTurn(createRunInput(), hooks);
    expect(ok.finalText).toBe('最终答复');

    // 失败结论同样要带出（`AgentRunResult.finalText` 的 JSDoc 明写「失败与终止也带它」）。
    // 只钉成功那一格是不够的：`assembleResult` 有四个返回点，谁把 `...base` 换成逐字段书写、
    // 漏掉失败那一条，症状就是「超时/报错的行查不到它到底说了什么」——正好是最需要它的时候。
    const failing: TurnHooks = {
      kind: 'codex',
      start: async () => ({
        stream: (async function* () {
          yield { type: 'x' };
        })(),
        interrupt: () => {},
        dispose: async () => {},
        project: (_raw, state) => {
          state.finalText = '失败前说了这些';
          return { drafts: [], tokens: null, turns: null, failure: { code: 'AGENT_FAILED', message: '上游报错' } };
        },
      }),
    };
    const failed = await runTurn(createRunInput(), failing);
    expect(failed.exitReason).toBe('error');
    expect(failed.finalText).toBe('失败前说了这些');
  });

  it('没采到答复时 finalText 是 null（不猜、不填空串）', async () => {
    const hooks: TurnHooks = {
      kind: 'codex',
      start: async () => ({
        stream: (async function* () {})(),
        interrupt: () => {},
        dispose: async () => {},
        project: () => ({ drafts: [], tokens: null, turns: null, failure: null }),
      }),
    };
    const result = await runTurn(createRunInput(), hooks);
    expect(result.finalText).toBeNull();
  });
});

/**
 * 收尾投影（`TurnStart.finalize`）的**调用时机**：三种结束方式都要收尾，且都在释放之前。
 *
 * 为什么这一组必须存在：codex 的消息**只**从收尾这条通道出（事件流缺工具真名、结构化入参与
 * `call_id` 配对键），而它读的 `sessions/rollout-*.jsonl` **是 CLI 边跑边追加的**——
 * 失败 / 被终止的会话文件里同样有内容（真机实测：一条被中断的 codex 行留下 688 KB 会话文件）。
 * 原来只在「跑完且没失败」时收尾，代价是**失败的那一行抽屉里永远空着**（显示「还没有日志 ·
 * 这一行还没开始执行」，而这一行明明跑过），而那正是排障时最需要看的一行。
 *
 * 三条边界同时钉住：**读得到就补上**、**不改结论**、**读盘在 dispose 之前**。
 */
describe('runTurn：收尾投影的调用时机', () => {
  /**
   * 一条可辨识的收尾**草稿**（`finalize` 交的是 `MessageDraft`，不是装配后的消息）。
   * 断言看的是**块的正文**——那才是「内容有没有到」的判据（`messageId` 由骨架的合并器发号）。
   */
  function finalizedDraft(text: string): MessageDraft {
    return {
      vendorId: null,
      role: 'assistant',
      source: 'session-file',
      roundTrip: 1,
      vendorTurn: null,
      step: null,
      parentCallId: null,
      subagentId: null,
      chunk: 'snapshot',
      // 消息级用量：这一条收尾草稿不关心它（这一层只钉「收尾投影有没有被调用」）
      usage: null,
      blocks: [
        {
          phase: 'snapshot',
          identity: { kind: 'index', index: 0 },
          block: { type: 'text', text },
        },
      ],
      raw: null,
    };
  }

  /** 「内容到底有没有交出来」的判据：装配后消息里各内容块的正文（`AgentMessage.blocks` 直接是内容块数组） */
  function textsOf(messages: readonly AgentMessage[]): string[] {
    return messages.flatMap((message) =>
      message.blocks.flatMap((block) => (block.type === 'text' ? [block.text] : [])),
    );
  }

  it('正常跑完：收尾被调用一次，消息与子任务行都交了出来', async () => {
    const subagent: SubagentRecord = {
      subagentId: 'child-1',
      name: '子任务',
      kind: null,
      source: 'session-file',
      status: 'completed',
      statusMissing: null,
      outcome: null,
      parentCallId: null,
      parentSubagentId: null,
      usage: null,
    };
    const messages: AgentMessage[] = [];
    const subagents: SubagentRecord[] = [];
    const harness = createHarness({
      events: [{ kind: 'message' }],
      finalize: () => ({ drafts: [], messages: [finalizedDraft('我从会话文件里读出来的答复')], subagents: [subagent] }),
    });
    const input = createRunInput({
      onEvent: collectEvents([]),
      onMessage: (message) => messages.push(message),
      onSubagent: (record) => subagents.push(record),
    });

    const result = await runTurn(input, harness.hooks);

    expect(result.exitReason).toBe('completed');
    expect(harness.stats.finalizeCount).toBe(1);
    expect(textsOf(messages)).toEqual(['我从会话文件里读出来的答复']);
    expect(subagents.map((record) => record.subagentId)).toEqual(['child-1']);
  });

  it('**流内失败**（`turn.failed` 落进 failure）时照样收尾：内容补上，结论与归因一个字都不变', async () => {
    const messages: AgentMessage[] = [];
    const harness = createHarness({
      events: [{ kind: 'message' }],
      projection: {
        drafts: [],
        tokens: null,
        turns: null,
        failure: { code: 'AGENT_FAILED', message: '上游 401' },
      },
      finalize: () => ({ drafts: [], messages: [finalizedDraft('我从会话文件里读出来的答复')] }),
    });

    const result = await runTurn(
      createRunInput({ onEvent: collectEvents([]), onMessage: (message) => messages.push(message) }),
      harness.hooks,
    );

    // 结论没有被收尾改写
    expect(result).toMatchObject({ ok: false, exitReason: 'error' });
    expect(result.error?.code).toBe('AGENT_FAILED');
    expect(result.error?.message).toContain('上游 401');
    // 而内容补上了
    expect(harness.stats.finalizeCount).toBe(1);
    expect(textsOf(messages)).toEqual(['我从会话文件里读出来的答复']);
  });

  it('迭代抛错（`streamError`）时照样收尾，且**在 dispose 之前**（否则真机上永远读不到会话文件）', async () => {
    const messages: AgentMessage[] = [];
    const harness = createHarness({
      events: [{ kind: 'message' }],
      streamError: new Error('CLI 退出了'),
      finalize: () => ({ drafts: [], messages: [finalizedDraft('我从会话文件里读出来的答复')] }),
    });

    const result = await runTurn(
      createRunInput({ onEvent: collectEvents([]), onMessage: (message) => messages.push(message) }),
      harness.hooks,
    );

    expect(result.exitReason).toBe('error');
    expect(harness.stats.finalizeCount).toBe(1);
    expect(messages).toHaveLength(1);
    // 顺序：收尾读盘必须排在 dispose（删临时目录 / 关文件句柄）之前
    const order = harness.recorder.order;
    expect(order).toContain('finalize');
    expect(order.indexOf('finalize')).toBeLessThan(order.indexOf('dispose'));
  });

  it('收尾自身抛错**不改结论**（补充信息失败不是运行失败）', async () => {
    const harness = createHarness({
      events: [{ kind: 'message' }],
      finalize: () => {
        throw new Error('读盘炸了');
      },
    });

    const result = await runTurn(createRunInput({ onEvent: collectEvents([]) }), harness.hooks);

    expect(result).toMatchObject({ ok: true, exitReason: 'completed' });
    expect(harness.stats.finalizeCount).toBe(1);
  });
});

describe('subagentTokens（2026-10-04）：骨架只搬运，不做加法', () => {
  it('投影带这一格 ⇒ 下一条 usage 事件与结果都带上原样值（骨架不加到 tokens 上）', async () => {
    const events: AgentEvent[] = [];
    const result = await runTurn(createRunInput({ onEvent: collectEvents(events) }), {
      kind: 'codex',
      start: async () => ({
        stream: (async function* () {
          yield { kind: 'one' };
        })(),
        interrupt: () => {},
        dispose: async () => {},
        project: () => ({
          drafts: [],
          tokens: { input: 100, cached: 20, output: 30 },
          subagentTokens: { input: 40, cached: 10, output: 5 },
          turns: 2,
          failure: null,
        }),
      }),
    });
    const usage = events.find((event) => event.type === 'usage');
    expect(usage?.type === 'usage' ? usage.subagentTokens : null).toEqual({ input: 40, cached: 10, output: 5 });
    expect(usage?.type === 'usage' ? usage.tokens : null).toEqual({ input: 100, cached: 20, output: 30 });
    expect(result.subagentTokens).toEqual({ input: 40, cached: 10, output: 5 });
    expect(result.tokens).toEqual({ input: 100, cached: 20, output: 30 });
  });

  it('收尾（finalize）交回的计量折进结果——这是 codex 子线程用量唯一的落地路径', async () => {
    const result = await runTurn(createRunInput(), {
      kind: 'codex',
      start: async () => ({
        stream: (async function* () {
          yield { kind: 'one' };
        })(),
        interrupt: () => {},
        dispose: async () => {},
        project: () => ({ drafts: [], tokens: { input: 10, cached: 0, output: 1 }, turns: 1, failure: null }),
        finalize: () => ({
          drafts: [],
          tokens: { input: 15, cached: 0, output: 4 },
          subagentTokens: { input: 5, cached: 0, output: 3 },
          turns: 3,
        }),
      }),
    });
    expect(result.tokens).toEqual({ input: 15, cached: 0, output: 4 });
    expect(result.subagentTokens).toEqual({ input: 5, cached: 0, output: 3 });
    expect(result.turns).toBe(3);
  });

  it('收尾交回 null：tokens/turns 保持不变，但 subagentTokens 被清成 null（两者的 null 语义刻意不同）', async () => {
    const result = await runTurn(createRunInput(), {
      kind: 'codex',
      start: async () => ({
        stream: (async function* () {
          yield { kind: 'one' };
        })(),
        interrupt: () => {},
        dispose: async () => {},
        project: () => ({
          drafts: [],
          tokens: { input: 10, cached: 0, output: 1 },
          subagentTokens: { input: 2, cached: 0, output: 1 },
          turns: 1,
          failure: null,
        }),
        finalize: () => ({ drafts: [], tokens: null, subagentTokens: null, turns: null }),
      }),
    });
    // `tokens` 的 null = 「本条不带」⇒ 保持
    expect(result.tokens).toEqual({ input: 10, cached: 0, output: 1 });
    // `subagentTokens` 的 null = 「明确没采到」⇒ 清空（读失败时必须能清，否则旧分量会大于退回主会话口径的合计）
    expect(result.subagentTokens).toBeNull();
  });

  it('收尾**不带**这一格（缺省）时保持原值——与显式 null 是两件事', async () => {
    const result = await runTurn(createRunInput(), {
      kind: 'codex',
      start: async () => ({
        stream: (async function* () {
          yield { kind: 'one' };
        })(),
        interrupt: () => {},
        dispose: async () => {},
        project: () => ({
          drafts: [],
          tokens: { input: 10, cached: 0, output: 1 },
          subagentTokens: { input: 2, cached: 0, output: 1 },
          turns: 1,
          failure: null,
        }),
        finalize: () => ({ drafts: [] }),
      }),
    });
    expect(result.subagentTokens).toEqual({ input: 2, cached: 0, output: 1 });
  });

  it('只变了子智能体那一份也要发事件（去重判据必须包含它）', async () => {
    const events: AgentEvent[] = [];
    const tokens = { input: 100, cached: 0, output: 10 };
    await runTurn(createRunInput({ onEvent: collectEvents(events) }), {
      kind: 'codex',
      start: async () => ({
        stream: (async function* () {
          yield { kind: 'a' };
          yield { kind: 'b' };
        })(),
        interrupt: () => {},
        dispose: async () => {},
        project: (raw) => ({
          drafts: [],
          tokens,
          subagentTokens: (raw as { kind: string }).kind === 'a' ? { input: 0, cached: 0, output: 0 } : { input: 7, cached: 0, output: 1 },
          turns: 1,
          failure: null,
        }),
      }),
    });
    const usages = events.filter((event) => event.type === 'usage');
    expect(usages).toHaveLength(2);
    expect(usages[1]?.type === 'usage' ? usages[1].subagentTokens : null).toEqual({ input: 7, cached: 0, output: 1 });
  });
});

/**
 * `subagentTurns`（2026-10-04，与 `subagentTokens` 逐条同一条骨架规则）。
 *
 * 三条必须分开钉住，因为它们在实现上是**三个**分支（预检裁定 R2）：
 *   · 投影带这一格 ⇒ 照原样搬运（骨架**不做加法**：合计由各家自己算好，骨架再加一次就是双计）；
 *   · 显式 `null` = 「明确没采到」⇒ **覆盖成 null**（读失败时旧的偏大分量必须能清掉，
 *     否则它与已退回主会话口径的 `turns` 一起破坏 `subagentTurns ≤ turns`）；
 *   · **缺省**（键不存在）= 「本条不带这一格」⇒ 保持原值。
 * 第四格是收尾（`finalize`）：它是 codex 子线程轮次唯一的落地路径，两处折叠必须同语义。
 */
describe('subagentTurns（2026-10-04）：骨架只搬运，不做加法', () => {
  it('投影带这一格 ⇒ usage 事件与结果都带上原样值（骨架不加到 turns 上）', async () => {
    const events: AgentEvent[] = [];
    const result = await runTurn(createRunInput({ onEvent: collectEvents(events) }), {
      kind: 'dsh',
      start: async () => ({
        stream: (async function* () {
          yield { kind: 'one' };
        })(),
        interrupt: () => {},
        dispose: async () => {},
        project: () => ({
          drafts: [],
          tokens: { input: 100, cached: 20, output: 30 },
          subagentTurns: 3,
          turns: 9,
          failure: null,
        }),
      }),
    });
    const usage = events.find((event) => event.type === 'usage');
    expect(usage?.type === 'usage' ? usage.subagentTurns : null).toBe(3);
    // 合计**不动**：`turns` 就是 9（= 主 6 + 子 3），骨架不做 `turns + subagentTurns`
    expect(usage?.type === 'usage' ? usage.turns : null).toBe(9);
    expect(result.subagentTurns).toBe(3);
    expect(result.turns).toBe(9);
  });

  it('投影交回显式 null ⇒ 覆盖成 null（上一版的非零分量必须能清掉）', async () => {
    const events: AgentEvent[] = [];
    const result = await runTurn(createRunInput({ onEvent: collectEvents(events) }), {
      kind: 'dsh',
      start: async () => ({
        stream: (async function* () {
          yield { kind: 'a' };
          yield { kind: 'b' };
        })(),
        interrupt: () => {},
        dispose: async () => {},
        project: (raw) => ({
          drafts: [],
          tokens: null,
          // 第一条给出分量，第二条（子会话收场却没报到轮次）明确说「没采到」
          ...((raw as { kind: string }).kind === 'a' ? { subagentTurns: 4 } : { subagentTurns: null }),
          turns: 4,
          failure: null,
        }),
      }),
    });
    expect(result.subagentTurns).toBeNull();
    const last = events.filter((event) => event.type === 'usage').at(-1);
    expect(last?.type === 'usage' ? last.subagentTurns : 'missing').toBeNull();
  });

  it('投影**不带**这一格（缺省）⇒ 保持原值——与显式 null 是两件事', async () => {
    const result = await runTurn(createRunInput(), {
      kind: 'dsh',
      start: async () => ({
        stream: (async function* () {
          yield { kind: 'a' };
          yield { kind: 'b' };
        })(),
        interrupt: () => {},
        dispose: async () => {},
        project: (raw) => ({
          drafts: [],
          tokens: null,
          ...((raw as { kind: string }).kind === 'a' ? { subagentTurns: 4 } : {}),
          turns: 4,
          failure: null,
        }),
      }),
    });
    expect(result.subagentTurns).toBe(4);
  });

  it('收尾（finalize）交回的轮次折进结果；显式 null 清空、缺省保持', async () => {
    const carried = await runTurn(createRunInput(), {
      kind: 'codex',
      start: async () => ({
        stream: (async function* () {
          yield { kind: 'one' };
        })(),
        interrupt: () => {},
        dispose: async () => {},
        project: () => ({ drafts: [], tokens: null, subagentTurns: 2, turns: 5, failure: null }),
        finalize: () => ({ drafts: [], subagentTurns: 7, turns: 10 }),
      }),
    });
    expect(carried.subagentTurns).toBe(7);
    expect(carried.turns).toBe(10);

    const cleared = await runTurn(createRunInput(), {
      kind: 'codex',
      start: async () => ({
        stream: (async function* () {
          yield { kind: 'one' };
        })(),
        interrupt: () => {},
        dispose: async () => {},
        project: () => ({ drafts: [], tokens: null, subagentTurns: 2, turns: 5, failure: null }),
        // 收尾说「读不全了」⇒ 分量清掉（与 `tokens` 的 null = 「本条不带」刻意不同）
        finalize: () => ({ drafts: [], subagentTurns: null }),
      }),
    });
    expect(cleared.subagentTurns).toBeNull();
    // `turns` 缺省 ⇒ 保持投影那一版（5），两格各自处置
    expect(cleared.turns).toBe(5);

    const untouched = await runTurn(createRunInput(), {
      kind: 'codex',
      start: async () => ({
        stream: (async function* () {
          yield { kind: 'one' };
        })(),
        interrupt: () => {},
        dispose: async () => {},
        project: () => ({ drafts: [], tokens: null, subagentTurns: 2, turns: 5, failure: null }),
        finalize: () => ({ drafts: [] }),
      }),
    });
    expect(untouched.subagentTurns).toBe(2);
  });

  it('只变了子智能体的轮次也要发事件（去重判据必须包含它）', async () => {
    const events: AgentEvent[] = [];
    await runTurn(createRunInput({ onEvent: collectEvents(events) }), {
      kind: 'dsh',
      start: async () => ({
        stream: (async function* () {
          yield { kind: 'a' };
          yield { kind: 'b' };
        })(),
        interrupt: () => {},
        dispose: async () => {},
        project: (raw) => ({
          drafts: [],
          tokens: null,
          subagentTurns: (raw as { kind: string }).kind === 'a' ? 0 : 2,
          turns: 5,
          failure: null,
        }),
      }),
    });
    const usages = events.filter((event) => event.type === 'usage');
    expect(usages).toHaveLength(2);
    expect(usages[1]?.type === 'usage' ? usages[1].subagentTurns : null).toBe(2);
  });

  it('启动前已被终止 ⇒ 一行都没跑，分量与合计同为 null（不填 0）', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await runTurn(createRunInput({ signal: controller.signal }), {
      kind: 'dsh',
      start: async () => {
        throw new Error('不该被调用');
      },
    });
    expect(result.subagentTurns).toBeNull();
    expect(result.turns).toBeNull();
  });
});
