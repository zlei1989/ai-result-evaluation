// @vitest-environment node
/**
 * 运行骨架：判定优先级、**轮次的发射门槛**、释放顺序、dispose 幂等、永不抛。
 * 用**合成 hooks**（不经过任何厂商消息形状）测骨架：每条断言恰好对应一条规则；厂商特有的注入与
 * 投影由各 provider 的用例覆盖。
 *
 * 三条口径（用户：「执行不限时间、评分不限轮次和时间」+「轮次按模型 API 往返算」+ 看门狗）：
 *   · **总时长仍不限**——「一直有输出（轮次持续推进）的适配器跑一小时也不会被叫停」是它的守卫；
 *   · 骨架判的是**静止**（没有输出 / 单轮往返不收尾），到点落 `timed-out`（见「看门狗」那一组）；
 *   · `usage` 事件的发射门槛是**轮次**（tokens 可空），不是「tokens 与 turns 同时在」。
 */
import type { AgentEvent, AgentMessage, SubagentRecord } from '@aieval/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logDraft } from './emit';
import { AgentLoadError } from './errors';
import { toolCallBlockDraft, toolResultBlockDraft, type MessageDraft } from './message';
import { RELEASE_GRACE_MS } from './release';
import {
  collectEvents,
  createFakeStream,
  createRecorder,
  createRunInput,
  createTimedStream,
  settleWithFakeTimers,
  type FakeStreamHandle,
  type FakeVendorRecorder,
} from './testing/agent-fixtures';
import type { AgentKind } from './types';
import {
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_TURN_WALL_CLOCK_MS,
  disposeLiveSessions,
  runTurn,
  STRUCTURED_OUTPUT_REPAIR_ROUNDS,
  type TurnFinalize,
  type TurnHooks,
  type TurnProjection,
  type TurnStart,
} from './turn';

interface Harness {
  hooks: TurnHooks;
  recorder: FakeVendorRecorder;
  stats: { startCount: number; disposeCount: number; finalizeCount: number };
  /** 放开 `startHang` 的闸门（见 `options.startHang`）：用例断言完「卡住时不会落定」之后必须调用它收尾 */
  releaseStart: () => void;
}

/** 造一套合成 hooks：事件流可挂住、interrupt 可合作也可忽略、start 可直接抛 */
function createHarness(
  options: {
    events?: readonly unknown[];
    /** 该次运行挂在哪一家名下：看门狗的「工具在途可合法静默」按家生效，故必须能换 kind */
    kind?: AgentKind;
    /** 自定义假流（覆盖默认的固定事件流）：时间轴形状的用例自己造流（见 `createTimedStream`） */
    stream?: (recorder: FakeVendorRecorder) => FakeStreamHandle;
    /** 'stop'（默认，合作）| 'ignore'（忽略停止信号：dsh 与非合作 CLI 的真实形状） */
    interrupt?: 'stop' | 'ignore';
    hang?: boolean;
    /**
     * `hooks.start()` **永不返回**（装配段卡住）：用来钉「看门狗只能点名、没有句柄可释放，
     * 这个候选不会落定」这条能力边界（真机读数见本仓真机探针（不入库）
     * 的 D 臂）。
     */
    startHang?: boolean;
    streamError?: unknown;
    startError?: unknown;
    /** 固定投影，或**按事件**给投影（后者用来造「流内失败」：见下面那两条退出错误取舍的用例） */
    projection?: TurnProjection | ((raw: unknown) => TurnProjection);
    /** dispose 自身的耗时（假定时器下用）：把释放窗口铺开，用来测「释放期间被终止」 */
    disposeDelayMs?: number;
    /** 收尾投影（`TurnStart.finalize`）：调用次数记在 `stats.finalizeCount` 上 */
    finalize?: () => TurnFinalize;
  } = {},
): Harness {
  const recorder = createRecorder();
  const stats = { startCount: 0, disposeCount: 0, finalizeCount: 0 };
  /**
   * `startHang` 的闸门：不是「永不返回」，而是「调用方说放才放」——用例断言完「卡住时不会落定」
   * 之后必须把闸门放开并等它落定，否则会留下一个永不落定的 run 污染同文件后续用例
   * （停机回收那一组会被它带红）。
   */
  let releaseStartGate: (() => void) | null = null;
  const startGate = new Promise<void>((resolve) => {
    releaseStartGate = resolve;
  });
  const hooks: TurnHooks = {
    kind: options.kind ?? 'cc',
    start: async (context) => {
      stats.startCount += 1;
      if (options.startError !== undefined) throw options.startError;
      if (options.startHang === true) await startGate;
      const stream = options.stream === undefined
        ? createFakeStream(options.events ?? [], recorder, {
          hang: options.hang === true,
          throwAfterEvents: options.streamError,
        })
        : options.stream(recorder);
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
  return { hooks, recorder, stats, releaseStart: () => releaseStartGate?.() };
}

/** 收集 logger 的 error 级输出：事件回调抛错后必须仍然可见 */
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
    // 正常出口也要释放（所有出口一个都不能漏）
    expect(harness.stats.disposeCount).toBe(1);
  });

  /**
   * 轮次的发射门槛（用户口径）。三条一起钉：
   *   ① 只带轮次（tokens: null）也要发 —— 实测缺口：cc 的 token 采不到时整轮一条都不发，
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
   * 归属格：骨架**只搬运**——投影没给就是 `null`（不结转上一条，也不拿 `turns` 顶替）。
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

  // `tokensEstimated` 是 cc 的跑动期估算：它只进事件，**绝不进结果**——
  // 否则崩溃 / 被杀的候选会带着一份估算被写成「采到了计量」，而快照是唯一落盘真相。
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
   * A2：`tokens` 那一格是**厂商上报的权威值**还是**我们的跑动期估算**，必须能从事件本身分辨
   * （`tokensBasis`）——消费方（编排层的跑动期回写段）据此决定要不要写快照，于是它不再需要在跑之前
   * 反查注册表的 `capability.liveUsage`（那是 A1/A2 要消掉的能力消费点）。
   *
   * 为什么判据挂在**事件**上而不是结果上：`tokensEstimated` 只影响「这一条要不要给结果」，
   * 而事件是**覆盖语义**的累计快照，一条估算事件与一条权威事件在界面上长得一模一样——
   * 不标出来源，消费方只能靠猜。
   */
  it('估算计量的事件带 tokensBasis=estimated，权威值带 reported', async () => {
    const events: AgentEvent[] = [];
    const harness = createHarness({
      events: [{ kind: 'estimate' }, { kind: 'authoritative' }],
      projection: (raw) => {
        const kind = (raw as { kind: string }).kind;
        if (kind === 'estimate') {
          return {
            drafts: [],
            tokens: { input: 1, cached: 0, output: 2 },
            tokensEstimated: true,
            turns: 1,
            failure: null,
          };
        }
        return { drafts: [], tokens: { input: 3, cached: 0, output: 4 }, turns: 2, failure: null };
      },
    });
    await runTurn(createRunInput({ onEvent: collectEvents(events) }), harness.hooks);

    const usages = events.filter((event) => event.type === 'usage');
    expect(usages.map((event) => (event.type === 'usage' ? event.tokensBasis : null))).toEqual([
      'estimated',
      'reported',
    ]);
  });

  /**
   * 去重判据必须**含 `tokensBasis`**（A2）：两个数值恰好相同时，估算→权威仍是一次真实变化
   * ——少了它，那一条权威事件会被当成「重复快照」吃掉，编排层的快照于是永远等不到这个权威值
   * （只有终态那一次写入才补上）。与 `timing` / `turn` 进判据是同一条理由：**影响消费方行为的格子
   * 不能只比数值**。
   */
  it('估算与权威值数值恰好相同时，tokensBasis 变了仍要再发一条', async () => {
    const events: AgentEvent[] = [];
    const tokens = { input: 7, cached: 0, output: 7 };
    const harness = createHarness({
      events: [{ kind: 'estimate' }, { kind: 'authoritative' }],
      projection: (raw) =>
        (raw as { kind: string }).kind === 'estimate'
          ? { drafts: [], tokens, tokensEstimated: true, turns: 1, failure: null }
          : { drafts: [], tokens, turns: 1, failure: null },
    });
    await runTurn(createRunInput({ onEvent: collectEvents(events) }), harness.hooks);

    const usages = events.filter((event) => event.type === 'usage');
    expect(usages.map((event) => (event.type === 'usage' ? event.tokensBasis : null))).toEqual([
      'estimated',
      'reported',
    ]);
  });

  /**
   * **权威值一到，跑动期的估算必须让位**：两者都是「到目前的累计」，
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

  it('适配器忽略 interrupt：5 秒后落 WARN 并强制释放，运行仍在有限时间内结束', async () => {
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
    // 只数**释放路径**那条 WARN：「用户终止」的结论摘要本身也带 `[WARN]` 前缀
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
      startError: new AgentLoadError('@openai/codex', new Error('Cannot find module')),
    });
    const result = await runTurn(createRunInput(), harness.hooks);
    expect(result).toMatchObject({ ok: false, exitReason: 'error' });
    expect(result.error?.code).toBe('AGENT_LOAD_FAILED');
    expect(result.error?.message).toContain('@openai/codex');
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
   * 退出错误 vs 流内失败的取舍（骨架级规则，与厂商无关）。
   *
   * 两个来源：流内错误由 `project` 从事件流里收（`{"type":"error",…}` / `turn.failed`）成 `failure`；
   * 退出错误是适配器**自己 spawn 的进程**终止时抛出的 cause。判据在 `exitErrorAddsDetail`——
   * ①确定性错误码 ②4xx ③剥掉已知样板后还有实质内容，取其一才覆盖；否则保留流内原因，
   * 并把「CLI 以退出码 N 收场」写成**补充**。
   *
   * 判据③的反面（剥完样板什么都没有）现在只有一种可达输入：**正文就是一句状态行**。
   */
  it('退出错误只剩一句状态行（5xx）⇒ 保留流内原因，退出码只作补充', async () => {
    const events: AgentEvent[] = [];
    const harness = createHarness({
      events: [{ kind: 'upstream-5xx' }],
      // 剥掉已知样板后什么都不剩 = 没有实质内容（判据③不成立）
      streamError: new Error('unexpected status 500 Service Unavailable'),
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
    // 原因必须还是流内那条：那句状态行只说了一个瞬时面，两者归因码又都是 AGENT_FAILED（可重试）
    expect(result.error?.message).toContain('high demand');
    expect(result.error?.message).not.toContain('Service Unavailable');
    /**
     * 但「CLI 以退出码 N 收场」是本次运行的真实结局，作为**补充**接在原因之后，不能抹掉。
     * 这里不钉退出的**数字**：码写在退出错误的正文里，而走到这一支的前提正是「正文没有实质内容」
     * ⇒ 这段里没有码可读（`exitCodeOf` 只认宿主给出的 `exited with code N` 形态）。本用例的判据是
     * 「流内原因是正文、退出是补充」，不是那个数字。
     */
    expect(result.error?.message).toMatch(/（随后 codex CLI 以退出码 .+ 收场）$/);
  });

  it('退出错误自带确定性归因（正文里的 401）⇒ 覆盖流内抱怨', async () => {
    const harness = createHarness({
      events: [{ kind: 'transient' }],
      streamError: new Error('codex app-server 进程已退出（code=1） stderr: 401 Unauthorized'),
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
      streamError: new Error('codex app-server 进程已退出（code=1） stderr: 上游返回 500 服务维护中'),
    });

    const result = await runTurn(createRunInput({ onEvent: () => {} }), harness.hooks);

    expect(result.exitReason).toBe('error');
    expect(result.error?.message).toContain('服务维护中');
  });

  it('退出错误带实质内容（app-server 的终止错误 + stderr 尾巴）⇒ 判据③成立，覆盖流内抱怨', async () => {
    const harness = createHarness({
      events: [{ kind: 'transient' }],
      // 现在真实可能出现的形态：进程终止那句 + stderr 尾巴（见 `appserver/client.ts`）
      streamError: new Error('codex app-server 进程已退出（code=1） stderr: 上游网关返回 502 Bad Gateway'),
      projection: () => ({
        drafts: [],
        tokens: null,
        turns: null,
        failure: { code: 'AGENT_FAILED', message: 'Reconnecting... 5/5 (We\'re currently experiencing high demand.)' },
      }),
    });

    const result = await runTurn(createRunInput({ onEvent: () => {} }), harness.hooks);

    // 剥掉已知样板后正文还在 ⇒ 它比流内那句没有状态的抱怨更具体（两者归因码都是 AGENT_FAILED）
    expect(result.error?.message).toContain('502 Bad Gateway');
    expect(result.error?.message).not.toContain('high demand');
  });

  it('退出错误里的 4xx 是确定性归因 ⇒ 覆盖流内的瞬时抱怨', async () => {
    const harness = createHarness({
      events: [{ kind: 'transient' }],
      streamError: new Error('codex app-server 进程已退出（code=1） stderr: unexpected status 429 Too Many Requests'),
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

  it('CLI 的 stderr 会落进该候选事件流（只有它能区分「网关 5xx」与「Responses 契约不满足」）', async () => {
    const events: AgentEvent[] = [];
    const harness = createHarness({
      events: [],
      streamError: new Error('codex app-server 进程已退出（code=1） stderr: 上游网关返回 502 Bad Gateway'),
    });

    await runTurn(createRunInput({ onEvent: collectEvents(events) }), harness.hooks);

    const logged = events
      .filter((event) => event.type === 'log')
      .map((event) => (event.type === 'log' ? event.text : ''))
      .join('\n');
    // 前缀只说「哪一侧的哪一种可能」，不断言来源：这条 cause 也可能是适配器自己抛的错
    // （真机：`.npmrc` 的 EACCES、厂商包导出面不匹配、技能物化失败三条都不是 CLI 的错）
    expect(logged).toContain('失败详情（CLI 退出 / 适配器自身错误都在这一档）');
    expect(logged).toContain('502 Bad Gateway');
  });

  it('事件回调抛错不外抛：结论照常返回、释放照走完，失败落 logger.error', async () => {
    // 消费方抛错是**真实形状**：编排层的 publishCandidateEvent → appendEvent 在写侧 schema 不过时抛
    // ServiceError，磁盘写失败同样抛；而编排层不给每个候选套 try/catch（正因 run() 承诺不抛）。
    // 这里让 onEvent 对**每条**事件都抛：若发射口没有受保护，首条事件就会把异常冒进循环的 catch，
    // 被归因成 AGENT_FAILED（把「日志写盘失败」误报成「适配器运行的失败」）。
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
    // 释放照走完：结论不能因为消费方抛错而丢掉回收（所有出口一个都不能漏）
    expect(harness.stats.disposeCount).toBe(1);
    // 必须仍然可见：release.ts 的对应修复刻意吞掉 onGraceExceeded 的异常，这层不记就彻底静默了
    expect(loggerErrors.some((line) => line.includes('事件回调失败'))).toBe(true);
  });

  it('运行正常完成后、释放窗口内被终止：结论仍是 completed，不被翻转成 canceled', async () => {
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

  // 以下三条是「只在某一条出口抛」：上一条（对每条事件都抛）只踩到循环内 usage
  // 一处——投影的 drafts 是空数组，而该轮走 completed，因此 drafts 与三个「最后出口」一次都没执行。
  // 致命的是：`assembleResult` 的 `emit` 实参若被换成**同类型未保护闭包**，vitest / tsc / eslint 三闸全绿
  // ⇒ 必须由用例逐个把调用点钉住。

  it('只有循环内 drafts 出口抛错：不抛、结果 completed、释放照走完、失败落 logger.error', async () => {
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

  it('completed 结论本身不发任何事件（所以它只能靠 error 出口那条用例来钉）；onEvent 抛错不影响结论', async () => {
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

  it('只有 error 事件出口抛错：不抛、结果仍 error + AGENT_FAILED、失败落 logger.error', async () => {
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

  // 最终答复出口：骨架只负责把 state.finalText 带进结果，不负责解释它。
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
 * 看门狗（`AgentRunInput.watchdog`，默认常亮）：骨架判的是**这个候选还在动吗**，不是工作时长。
 *
 * 四条口径（缺一条就会误杀或漏杀）：
 *   ①「有输出」＝这一条投影交出了任何产品事件（候选级事件 / 消息 / 子任务行 / 计量）；
 *   ② 墙钟按**一次模型往返**计（观察到轮次推进就重新起表）——套在整候选上等于把「执行不限时间」的总上限加回来；
 *   ③ 工具在途挂起静止计时**只对能合法静默的家生效**（dsh 与 pi：工具全程可能一声不吭）；
 *   ④ 等待审批在途也挂起——**识别机制按家不同、今天采不到 ⇒ 如实登记为「未豁免」**（见下面那条用例）。
 *
 * 时间全部走假定时器：两级上限是分钟级，真等就是白等。两侧都要钉——「到点之前一动不动」防早开火，
 * 「到点之后收场」防永远不开火；只钉一侧的守卫分不出这两者。
 */
describe('看门狗：静止判超时', () => {
  /** 一条「工具调用 / 工具结果」消息草稿：骨架判「在途工具」看的就是这两个块（按 `callId` 配平） */
  function toolMessage(callId: string, phase: 'call' | 'result'): MessageDraft {
    return {
      vendorId: null,
      role: 'assistant',
      source: 'wire',
      roundTrip: 1,
      turn: null,
      step: null,
      parentCallId: null,
      subagentId: null,
      chunk: 'snapshot',
      usage: null,
      blocks: [
        phase === 'call'
          ? toolCallBlockDraft(callId, 'bash', { command: 'pnpm install' }, 'cc')
          : toolResultBlockDraft(callId, 'ok', { isError: false }),
      ],
      raw: null,
    };
  }

  /** 工具调用 / 结果的投影：两条都带候选级事件（「有输出」成立），差别只在消息块上 */
  function toolProjection(callId: string, phase: 'call' | 'result'): TurnProjection {
    return {
      drafts: [logDraft('stdout', `${phase} ${callId}`)],
      tokens: null,
      turns: null,
      failure: null,
      messages: [toolMessage(callId, phase)],
    };
  }

  /** 事件流里的日志正文（摘要断言用）；非 log 事件取空串 */
  function logText(events: readonly AgentEvent[]): string {
    return events.map((event) => (event.type === 'log' ? event.text : '')).join('\n');
  }

  /**
   * **装配段卡住时看门狗只能点名，不能收场**（能力边界）：`hooks.start()` 没返回 ⇒ 骨架手里
   * `handle === undefined`、没有句柄可释放 ⇒ 释放路径走不进去、行也不会落定。判据是**两件事一起**：
   * 告警文本点名「卡在装配段」+ 窗口内 `settled === false` 且 `disposeCount === 0`。
   *
   * 变异体：把 `tripWatchdog` 里那段 `handle === undefined` 的点名删掉 ⇒ 头一条断言当场红。
   */
  it('装配段卡住 ⇒ 看门狗点名「卡在装配段」，且这个候选不落定（没有句柄可释放）', async () => {
    vi.useFakeTimers();
    const events: AgentEvent[] = [];
    const harness = createHarness({ startHang: true });
    const promise = runTurn(
      createRunInput({ watchdog: { idleTimeoutMs: 400 }, onEvent: collectEvents(events) }),
      harness.hooks,
    );
    let settled = false;
    void promise.then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(1_000);
    const text = logText(events);
    expect(text, '告警要点名卡在装配段').toContain('卡在装配段');
    expect(text, '并说清没有句柄可释放').toContain('没有句柄可释放');
    expect(text, '亚秒预算印毫秒原文，不说成「静止 0 秒」').toContain('400 毫秒');
    expect(settled, '这一档本来就不会落定（能力边界）').toBe(false);
    expect(harness.stats.disposeCount, '没有句柄 ⇒ 释放路径进不去').toBe(0);

    // 放闸收尾：这一档不能留在「永不落定」上，否则同文件后续用例会被它污染
    harness.releaseStart();
    const result = await settleWithFakeTimers(promise, { stepMs: 100, steps: 20 });
    expect(result.exitReason, '看门狗已经开过火 ⇒ 放闸后按 timed-out 收场').toBe('timed-out');
    vi.useRealTimers();
  });

  it('没有输出到空闲上限 ⇒ timed-out（释放三段式照走，结论不是 completed）', async () => {
    expect(DEFAULT_IDLE_TIMEOUT_MS).toBe(180_000);
    vi.useFakeTimers();
    const events: AgentEvent[] = [];
    const harness = createHarness({ hang: true });
    const promise = runTurn(createRunInput({ onEvent: collectEvents(events) }), harness.hooks);
    let settled = false;
    void promise.then(() => {
      settled = true;
    });

    // 上限之内一动不动：什么都不能发生（早开火会把「模型想得久」判成静止）
    await vi.advanceTimersByTimeAsync(DEFAULT_IDLE_TIMEOUT_MS - 1_000);
    expect(settled).toBe(false);
    expect(harness.stats.disposeCount).toBe(0);

    const result = await settleWithFakeTimers(promise, { stepMs: 1_000, steps: 20 });
    expect(result.ok).toBe(false);
    expect(result.exitReason).toBe('timed-out');
    expect(result.error?.code).toBe('AGENT_TIMED_OUT');
    // 看门狗只是**另一个终止发起者**：走的仍是 interrupt → 终结在途 → dispose
    expect(harness.recorder.order).toEqual(['interrupt', 'turn-end', 'dispose']);
    expect(harness.stats.disposeCount).toBe(1);
    expect(logText(events)).toContain('静止');
  });

  it('有输出就不算静止：每 60 秒一条事件，跑满 5 分钟也不判超时', async () => {
    vi.useFakeTimers();
    const harness = createHarness({
      // 只带候选级日志、不带轮次：这一条证的只能是「有输出 ⇒ 重置空闲计时」
      stream: (recorder) => createTimedStream(
        [0, 60_000, 120_000, 180_000, 240_000].map((atMs) => ({ atMs, event: atMs })),
        recorder,
      ),
      projection: (raw) => ({
        drafts: [logDraft('stdout', `进度 ${String(raw)}`)],
        tokens: null,
        turns: null,
        failure: null,
      }),
    });
    const promise = runTurn(createRunInput({}), harness.hooks);
    let settled = false;
    void promise.then(() => {
      settled = true;
    });

    // 5 分钟 > 空闲上限，而最后一条输出在 240 秒：计时只按「最后一次输出」算
    await vi.advanceTimersByTimeAsync(240_000 + 1_000);
    await settleWithFakeTimers(promise, { stepMs: 1_000, steps: 10 });
    expect(settled).toBe(true);
    expect((await promise).exitReason).toBe('completed');
  });

  /**
   * 口径①的**完整面**：「有输出」＝这一条投影交出了任何产品事件，四种载体（候选级事件 / 消息 /
   * 子任务行 / 计量）**各自**都算数。少认一种的表现不是报错，而是那一类通道被误杀——例如只发消息、
   * 不发任何候选级事件的适配器会在空闲上限被判静止超时，而它其实一直在干活。
   *
   * 判据取**时间差**：输出落在 100 s（把空闲期限推到 280 s），推进到 200 s（已越过开跑后的 180 s）
   * 仍不许收场；不认这一类载体的话，看门狗在 180 s 就开火了。反面同样要钉：四条都空的投影
   *（纯重复事件，唯一允许丢弃的一类）**不算**输出，180 s 到点照常判静止。
   */
  it('「有输出」的四种载体各自都算数；四条都空则照常判静止', async () => {
    const subagent: SubagentRecord = {
      subagentId: 'child-1',
      name: null,
      kind: null,
      source: 'wire',
      status: 'running',
      statusMissing: null,
      outcome: null,
      parentCallId: null,
      parentSubagentId: null,
      usage: null,
    };
    const message: MessageDraft = {
      vendorId: null,
      role: 'assistant',
      source: 'wire',
      roundTrip: 1,
      turn: null,
      step: null,
      parentCallId: null,
      subagentId: null,
      chunk: 'snapshot',
      usage: null,
      blocks: [],
      raw: null,
    };
    const cases: { name: string; projection: TurnProjection; trips: boolean }[] = [
      {
        name: '候选级事件',
        trips: false,
        projection: { drafts: [logDraft('stdout', '还在跑')], tokens: null, turns: null, failure: null },
      },
      {
        name: '消息',
        trips: false,
        projection: { drafts: [], tokens: null, turns: null, failure: null, messages: [message] },
      },
      {
        name: '子任务行',
        trips: false,
        projection: { drafts: [], tokens: null, turns: null, failure: null, subagents: [subagent] },
      },
      {
        name: '计量（轮次）',
        trips: false,
        projection: { drafts: [], tokens: null, turns: 1, failure: null },
      },
      {
        name: '纯重复（四条都空）',
        trips: true,
        projection: { drafts: [], tokens: null, turns: null, failure: null },
      },
    ];

    for (const item of cases) {
      vi.useFakeTimers();
      let stream: FakeStreamHandle | undefined;
      const harness = createHarness({
        stream: (recorder) => {
          stream = createTimedStream([{ atMs: 100_000, event: 'tick' }], recorder, { hang: true });
          return stream;
        },
        projection: () => item.projection,
      });
      const promise = runTurn(createRunInput({}), harness.hooks);
      let settled = false;
      void promise.then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(200_000);

      if (item.trips) {
        expect(settled, `${item.name} 不算输出 ⇒ 到点就该判静止`).toBe(true);
        expect((await promise).exitReason).toBe('timed-out');
      } else {
        expect(settled, `${item.name} 算输出 ⇒ 越过空闲上限也不许收场`).toBe(false);
        stream?.stop();
        await settleWithFakeTimers(promise, { stepMs: 1_000, steps: 5 });
        expect((await promise).exitReason).toBe('completed');
      }
      vi.useRealTimers();
    }
  });

  it('墙钟按一次模型往返计：轮次持续推进 ⇒ 跑一小时也不判静止（总时长仍不限）', async () => {
    expect(DEFAULT_TURN_WALL_CLOCK_MS).toBe(600_000);
    vi.useFakeTimers();
    let round = 0;
    const harness = createHarness({
      // 每 2 分钟收尾一次模型往返（轮次 +1），共 30 次 ⇒ 一小时的活
      stream: (recorder) => createTimedStream(
        Array.from({ length: 30 }, (_, index) => ({ atMs: (index + 1) * 120_000, event: index + 1 })),
        recorder,
      ),
      projection: () => {
        round += 1;
        return {
          drafts: [logDraft('stdout', `第 ${round} 次往返`)],
          tokens: null,
          turns: round,
          failure: null,
        };
      },
    });
    const promise = runTurn(createRunInput({}), harness.hooks);
    let settled = false;
    void promise.then(() => {
      settled = true;
    });

    // 59 分钟：远超单轮上限，但每一次往返都在上限之内收尾 ⇒ 不许判静止
    await vi.advanceTimersByTimeAsync(59 * 60 * 1000);
    expect(settled).toBe(false);
    expect(harness.stats.disposeCount).toBe(0);

    await settleWithFakeTimers(promise, { stepMs: 60_000, steps: 5 });
    expect((await promise).exitReason).toBe('completed');
  });

  /**
   * **厂商起一轮 ⇒ 重新起表**（`TurnProjection.roundTripStarted`）。
   *
   * 要拦的缺陷：跨轮的运行（人话在收场后被续跑成一幕新的 turn）里，重置点只有「区间起点」
   * 与「`turns` 递进」两处，而两轮之间有一段既没有新区间、也没有轮次递进的空档 ⇒ 上一轮耗掉的
   * 墙钟一直算进新的一轮里，上一轮接近预算时新起的那一轮会被自己的看门狗掐掉。
   *
   * 装配：每 60 秒一帧（**小于 180s 的空闲上限** ⇒ 空闲那一级不会先开火），第 9 帧（540 秒处）
   * 声明「起了一轮」。单轮墙钟是 600 秒 ⇒ 没有这一格的话它在 600 秒处就判静止收场；
   * 有了它，新的表从 540 秒起算，1080 秒之前都不该收场。
   */
  it('厂商新起一轮（`roundTripStarted`）就重新起表：跨轮的运行不把上一轮的墙钟算进下一轮', async () => {
    vi.useFakeTimers();
    let frame = 0;
    const harness = createHarness({
      stream: (recorder) => createTimedStream(
        // 18 帧 ⇒ 流在 1080 秒处结束，**早于**新的那一轮期限（540 + 600 = 1140 秒）⇒ 正常收场
        Array.from({ length: 18 }, (_, index) => ({ atMs: (index + 1) * 60_000, event: index + 1 })),
        recorder,
      ),
      projection: () => {
        frame += 1;
        // 只有第 9 帧（540 秒）声明「起了一轮」；其余帧既不带轮次、也不带这一格
        return {
          drafts: [logDraft('stdout', `第 ${frame} 帧`)],
          tokens: null,
          turns: null,
          failure: null,
          ...(frame === 9 ? { roundTripStarted: true } : {}),
        };
      },
    });
    const promise = runTurn(createRunInput({}), harness.hooks);
    let settled = false;
    void promise.then(() => {
      settled = true;
    });

    // 1020 秒处：没有那一格的话，原来的表早在 600 秒就判了静止
    await vi.advanceTimersByTimeAsync(17 * 60_000);
    expect(settled).toBe(false);
    expect(harness.stats.disposeCount).toBe(0);

    await settleWithFakeTimers(promise, { stepMs: 60_000, steps: 5 });
    expect((await promise).exitReason).toBe('completed');
  });

  it('一直有输出但一次往返都不收尾（drip）⇒ 单轮墙钟到点判 timed-out', async () => {
    vi.useFakeTimers();
    const events: AgentEvent[] = [];
    const harness = createHarness({
      stream: (recorder) => createTimedStream(
        Array.from({ length: 20 }, (_, index) => ({ atMs: (index + 1) * 60_000, event: index })),
        recorder,
        { hang: true },
      ),
      // 每条都有输出（空闲计时被反复重置），而轮次一直是 null：永远没有一次往返收尾
      projection: () => ({
        drafts: [logDraft('stdout', 'delta')],
        tokens: null,
        turns: null,
        failure: null,
      }),
    });
    const promise = runTurn(createRunInput({ onEvent: collectEvents(events) }), harness.hooks);

    const result = await settleWithFakeTimers(promise, { stepMs: 60_000, steps: 12 });
    expect(result.exitReason).toBe('timed-out');
    expect(result.error?.code).toBe('AGENT_TIMED_OUT');
    // 摘要要说清是哪一级开火（排障时「静止」与「往返不收尾」是两件事）
    expect(logText(events)).toContain('单次模型调用');
  });

  /**
   * 两条豁免的家各跑一遍：判据要的是「同一形状在两家都不判静止」，而不是「dsh 恰好有一行登记」。
   * pi 那一格与 dsh 同因：`tool_execution_update` 只在工具有输出时才发、bash 工具没有默认超时，
   * 静默长命令是合法的（见 `turn.ts` 那张表的注释）。
   */
  it.each(['dsh', 'pi'] as const)('工具在途允许合法静默的家（%s）：整段无输出的工具不判静止', async (kind) => {
    vi.useFakeTimers();
    const harness = createHarness({
      kind,
      stream: (recorder) => createTimedStream(
        [
          { atMs: 0, event: 'call' },
          // 400 秒的整段静默：远超空闲上限，而工具还在跑（这一家的静默长命令是合法的）
          { atMs: 400_000, event: 'result' },
        ],
        recorder,
      ),
      projection: (raw) => (raw === 'call' ? toolProjection('call-1', 'call') : toolProjection('call-1', 'result')),
    });
    const promise = runTurn(createRunInput({}), harness.hooks);
    let settled = false;
    void promise.then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(399_000);
    expect(settled).toBe(false);
    expect(harness.stats.disposeCount).toBe(0);

    await settleWithFakeTimers(promise, { stepMs: 10_000, steps: 5 });
    expect((await promise).exitReason).toBe('completed');
  });

  it('不能合法静默的家（cc）没有这条豁免：同样的工具在途形状照空闲上限判静止', async () => {
    vi.useFakeTimers();
    const harness = createHarness({
      stream: (recorder) => createTimedStream([{ atMs: 0, event: 'call' }], recorder, { hang: true }),
      projection: () => toolProjection('call-1', 'call'),
    });
    const promise = runTurn(createRunInput({}), harness.hooks);

    // cc 的工具在途有 30 秒心跳/硬夹：豁免它只会把真挂死的工具藏起来
    const result = await settleWithFakeTimers(promise, { stepMs: 60_000, steps: 5 });
    expect(result.exitReason).toBe('timed-out');
    expect(harness.stats.disposeCount).toBe(1);
  });

  it('在途工具按同一 callId 配平：别的 callId 的结果块不清它（否则挂死被当合法静默）', async () => {
    vi.useFakeTimers();
    let stream: FakeStreamHandle | undefined;
    const harness = createHarness({
      kind: 'dsh',
      stream: (recorder) => {
        stream = createTimedStream(
          [
            { atMs: 0, event: 'call' },
            { atMs: 100_000, event: 'other-result' },
          ],
          recorder,
          { hang: true },
        );
        return stream;
      },
      projection: (raw) => (raw === 'call' ? toolProjection('call-1', 'call') : toolProjection('call-2', 'result')),
    });
    const promise = runTurn(createRunInput({}), harness.hooks);
    let settled = false;
    void promise.then(() => {
      settled = true;
    });

    // 别的调用收尾之后又静默 200 秒：call-1 仍在途 ⇒ 计时仍挂起（配平判错的话 180 秒就到点）
    await vi.advanceTimersByTimeAsync(100_000 + 200_000);
    expect(settled).toBe(false);
    expect(harness.stats.disposeCount).toBe(0);

    stream?.stop();
    expect((await promise).exitReason).toBe('completed');
  });

  it('「等待审批」今天未豁免：dsh 停在无人应答的批准上按静止收场（识别机制未落地）', async () => {
    // 已文档化的正确行为是：read-only 档停在无人应答的批准上、直到用户点「终止」。而识别「在等审批」
    // 的事件按家不同，dsh 的通知流里没有这一类（只有装配期一次性的档位事实）⇒ 如实登记为**未豁免**：
    // 这一格的现时行为就是被看门狗判成 timed-out。哪天补上识别机制，这条用例与文档要一起改
    //（它就是这份登记的判据，不是「期望如此」）。
    vi.useFakeTimers();
    const harness = createHarness({ kind: 'dsh', hang: true });
    const promise = runTurn(createRunInput({}), harness.hooks);

    const result = await settleWithFakeTimers(promise, { stepMs: 60_000, steps: 4 });
    expect(result.exitReason).toBe('timed-out');
    expect(result.error?.code).toBe('AGENT_TIMED_OUT');
  });

  it('阈值可传入：显式给小值就按小值判（缺省值只是缺省）', async () => {
    vi.useFakeTimers();
    const harness = createHarness({ hang: true });
    const promise = runTurn(
      createRunInput({ watchdog: { idleTimeoutMs: 5_000, turnWallClockMs: 9_000 } }),
      harness.hooks,
    );
    let settled = false;
    void promise.then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(4_000);
    expect(settled).toBe(false);
    const result = await settleWithFakeTimers(promise, { stepMs: 1_000, steps: 10 });
    expect(result.exitReason).toBe('timed-out');
  });

  it('显式给 0 关掉一级（逃生门）：空闲关了之后只剩单轮墙钟管它', async () => {
    vi.useFakeTimers();
    const events: AgentEvent[] = [];
    const harness = createHarness({ hang: true });
    const promise = runTurn(
      createRunInput({ watchdog: { idleTimeoutMs: 0 }, onEvent: collectEvents(events) }),
      harness.hooks,
    );
    let settled = false;
    void promise.then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(300_000);
    expect(settled).toBe(false);

    const result = await settleWithFakeTimers(promise, { stepMs: 60_000, steps: 8 });
    expect(result.exitReason).toBe('timed-out');
    expect(logText(events)).toContain('单次模型调用');
  });
});

/**
 * 停机回收：宿主收信号时要把**本进程在册的在途会话**逐个释放（`disposeLiveSessions()`）。
 * 为什么必须有：SDK 代 spawn 的工具子进程是 detach 的，宿主一死就成孤儿、还捏着那一候选的工作区与
 * 配置目录；而死掉的进程谁也回收不了（`SIGKILL` 不可捕获，那一格不可闭合）。
 */
describe('停机回收：在册会话', () => {
  it('在途运行会进在册表：disposeLiveSessions() 停它，并等释放三段式走完', async () => {
    const harness = createHarness({ hang: true });
    const promise = runTurn(createRunInput({}), harness.hooks);

    await disposeLiveSessions();

    // 合作的适配器：interrupt 一响，在途区间就收尾，之后才是 dispose
    expect(harness.recorder.order).toEqual(['interrupt', 'turn-end', 'dispose']);
    expect(harness.stats.disposeCount).toBe(1);
    // 宿主停机是「外部要求停止」⇒ 收场是 canceled：截断的行不许报成 completed
    expect((await promise).exitReason).toBe('canceled');
  });

  it('已收尾的运行会注销：再调 disposeLiveSessions() 不会二次释放', async () => {
    const harness = createHarness({ events: [] });
    const result = await runTurn(createRunInput({}), harness.hooks);
    expect(result.exitReason).toBe('completed');

    await disposeLiveSessions();

    expect(harness.stats.disposeCount).toBe(1);
    expect(harness.recorder.order.filter((entry) => entry === 'dispose')).toHaveLength(1);
  });

  it('没有在途运行时立即返回', async () => {
    await expect(disposeLiveSessions()).resolves.toBeUndefined();
  });
});

/**
 * 收尾投影（`TurnStart.finalize`）的**调用时机**：三种结束方式都要收尾，且都在释放之前。
 *
 * 为什么这一组必须存在：codex 的消息**只**从收尾这条通道出（事件流缺工具真名、结构化入参与
 * `call_id` 配对键），而它读的 `sessions/rollout-*.jsonl` **是 CLI 边跑边追加的**——
 * 失败 / 被终止的会话文件里同样有内容（一条被中断的 codex 行可能留下 688 KB 会话文件）。
 * 原来只在「跑完且没失败」时收尾，代价是**失败的那一行抽屉里永远空着**（显示「还没有日志 ·
 * 这个候选还没开始执行」，而这个候选明明跑过），而那正是排障时最需要看的一行。
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
      turn: null,
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

  /**
   * 靶子（cc 真机形态）：**厂商不保证为每个块投递完整快照**——有些轮次只投 `tool_use` 的完整消息，
   * 正文只以流式增量到达。那个正文槽永远等不到自己的快照 ⇒ 载体的 `assembly` 停在 `'open'`，
   * 界面据此显示「正在思考」，而整行早已结束。会话收尾时必须把它按累积值封口。
   */
  it('会话收尾把没等到快照的槽收口：只以增量到达的正文，交出来那条是 `snapshot`', async () => {
    const messages: AgentMessage[] = [];
    const deltaDraft: MessageDraft = {
      vendorId: 'msg_A',
      role: 'assistant',
      source: 'wire',
      roundTrip: 1,
      turn: null,
      step: null,
      parentCallId: null,
      subagentId: null,
      chunk: 'delta',
      usage: null,
      // 一个**没有快照**的正文块：只有增量来过
      blocks: [{ phase: 'delta', identity: { kind: 'index', index: 0 }, block: { type: 'text', text: '只以增量到达的半句' } }],
      raw: null,
    };
    const harness = createHarness({
      events: [{ kind: 'message' }],
      projection: { drafts: [], tokens: null, turns: null, failure: null, messages: [deltaDraft] },
    });

    const result = await runTurn(
      createRunInput({ onEvent: collectEvents([]), onMessage: (message) => messages.push(message) }),
      harness.hooks,
    );

    expect(result.exitReason).toBe('completed');
    // 增量那条自己带着 `open`（那一段还没收尾）；收口之后必须再交一条 `snapshot`——
    // 少了它，界面就永远停在这一轮的「正在思考」上
    expect(messages.map((message) => message.assembly)).toEqual(['open', 'snapshot']);
    expect(textsOf(messages).at(-1)).toBe('只以增量到达的半句');
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

  it('收尾自身抛错**不改结论**（补充信息失败不是运行的失败）', async () => {
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

describe('subagentTokens：骨架只搬运，不做加法', () => {
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
 * `subagentTurns`（与 `subagentTokens` 逐条同一条骨架规则）。
 *
 * 三条必须分开钉住，因为它们在实现上是**三个**分支：
 *   · 投影带这一格 ⇒ 照原样搬运（骨架**不做加法**：合计由各家自己算好，骨架再加一次就是双计）；
 *   · 显式 `null` = 「明确没采到」⇒ **覆盖成 null**（读失败时旧的偏大分量必须能清掉，
 *     否则它与已退回主会话口径的 `turns` 一起破坏 `subagentTurns ≤ turns`）；
 *   · **缺省**（键不存在）= 「本条不带这一格」⇒ 保持原值。
 * 第四格是收尾（`finalize`）：它是 codex 子线程轮次唯一的落地路径，两处折叠必须同语义。
 */
describe('subagentTurns：骨架只搬运，不做加法', () => {
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

  it('启动前已被终止 ⇒ 一个候选都没跑，分量与合计同为 null（不填 0）', async () => {
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

/** 一个什么都不产出的 start：本组用例只测 runTurn 的处置，不测任何厂商投影 */
function emptyStart(): TurnStart {
  return {
    stream: (async function* () {})(),
    interrupt: () => {},
    dispose: async () => undefined,
    // `project` 是必填格（骨架在消费循环里调它），但本函数的流**一条都不产出** ⇒ 它一次都不会被调用
    project: () => ({ drafts: [], tokens: null, turns: null, failure: null }),
  };
}

describe('outputSchema：一律交给 start，applied 由适配器上报', () => {
  it('要了 schema ⇒ 原样交给 start（骨架不摘键、也不判任何能力）', async () => {
    const schema = { type: 'object' };
    const seen: unknown[] = [];
    const result = await runTurn(createRunInput({ outputSchema: schema }), {
      kind: 'dsh',
      start: async (context) => {
        seen.push(context.input.outputSchema);
        return emptyStart();
      },
    });
    expect(seen).toEqual([schema]);
    // 没上报就是 false（「没走原生通道」与「没上报」同义）
    expect(result.applied).toEqual({ structuredOutput: false });
  });

  it('没要求 schema ⇒ applied 也是 false', async () => {
    const result = await runTurn(createRunInput({}), {
      kind: 'codex',
      start: async () => emptyStart(),
    });
    expect(result.applied).toEqual({ structuredOutput: false });
  });

  it('适配器上报 true ⇒ 结果记 true（骨架只搬运，不自己算）', async () => {
    const result = await runTurn(createRunInput({ outputSchema: { type: 'object' } }), {
      kind: 'codex',
      start: async () => ({
        ...emptyStart(),
        finalize: () => ({ drafts: [], applied: { structuredOutput: true } }),
      }),
    });
    expect(result.applied).toEqual({ structuredOutput: true });
  });
});

describe('结构化输出的修正轮', () => {
  /**
   * 造一份「答了这么一段」的流：流里出一条事件、投影把答复写进 `state.finalText`
   * （真实各家是在投影里识别收尾消息，这里只造那个事实）。
   */
  function replyingStart(text: string, onContinue?: (prompt: string) => TurnStart): TurnStart {
    return {
      stream: (async function* () {
        yield { reply: text };
      })(),
      interrupt: () => {},
      dispose: async () => undefined,
      project: (_raw, state) => {
        state.finalText = text;
        return { drafts: [], tokens: null, turns: null, failure: null };
      },
      ...(onContinue === undefined ? {} : { continue: async (prompt: string) => onContinue(prompt) }),
    };
  }

  /** 造一份「一条消息都没回」的流：`state.finalText` 保持 null */
  function silentStart(onContinue?: (prompt: string) => TurnStart): TurnStart {
    return {
      stream: (async function* () {})(),
      interrupt: () => {},
      dispose: async () => undefined,
      project: () => ({ drafts: [], tokens: null, turns: null, failure: null }),
      ...(onContinue === undefined ? {} : { continue: async (prompt: string) => onContinue(prompt) }),
    };
  }
  const SCHEMA = {
    type: 'object',
    required: ['ok'],
    additionalProperties: false,
    properties: { ok: { type: 'boolean' } },
  };

  it('答复不合格 + 有 continue ⇒ 在同一会话里追问，问题清单与 schema 都进提示词', async () => {
    const prompts: string[] = [];
    const result = await runTurn(createRunInput({ outputSchema: SCHEMA }), {
      kind: 'dsh',
      start: async () => replyingStart('{"ok":"yes"}', (prompt) => {
        prompts.push(prompt);
        return replyingStart('{"ok":true}');
      }),
    });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('$.ok：期望 boolean，实际 string');
    expect(prompts[0]).toContain('"required"');
    expect(prompts[0]).toContain('不要重新读取工作区');
    expect(result.ok).toBe(true);
    expect(result.exitReason).toBe('completed');
    // 最终答复取**最后一轮**（修正后的那一份）
    expect(result.finalText).toBe('{"ok":true}');
  });

  it('追问一轮就合格 ⇒ 只追问一次（不把上限当配额烧完）', async () => {
    let asks = 0;
    await runTurn(createRunInput({ outputSchema: SCHEMA }), {
      kind: 'dsh',
      start: async () => replyingStart('{"ok":1}', () => {
        asks += 1;
        return replyingStart('{"ok":false}');
      }),
    });
    expect(asks).toBe(1);
  });

  it('连续不合格 ⇒ 追问到上限为止，且**不改写结论**（ok 仍为 true、原文是最后一轮）', async () => {
    let asks = 0;
    // 每一轮都还能再追问（假的「永远答不对」的模型）：上限必须由骨架自己收住
    const alwaysWrong = (text: string): TurnStart => replyingStart(text, () => {
      asks += 1;
      return alwaysWrong(`还是不对 ${asks}`);
    });
    const result = await runTurn(createRunInput({ outputSchema: SCHEMA }), {
      kind: 'dsh',
      start: async () => alwaysWrong('不是 JSON'),
    });
    expect(asks).toBe(STRUCTURED_OUTPUT_REPAIR_ROUNDS);
    expect(result.ok).toBe(true);
    expect(result.finalText).toBe(`还是不对 ${STRUCTURED_OUTPUT_REPAIR_ROUNDS}`);
  });

  it('没有 continue（另两家不实现）⇒ 不追问，答复原样交回（由调用方的解析面处置）', async () => {
    const result = await runTurn(createRunInput({ outputSchema: SCHEMA }), {
      kind: 'codex',
      start: async () => replyingStart('{"ok":"yes"}'),
    });
    expect(result.ok).toBe(true);
    expect(result.finalText).toBe('{"ok":"yes"}');
  });

  it('首轮就以失败收场 ⇒ 一次都不追问（那是「没问到」，不是「答错了」）', async () => {
    let asks = 0;
    const result = await runTurn(createRunInput({ outputSchema: SCHEMA }), {
      kind: 'dsh',
      start: async () => ({
        ...replyingStart('{"ok":"yes"}', () => {
          asks += 1;
          return replyingStart('{"ok":true}');
        }),
        stream: (async function* () {
          yield { fail: true };
        })(),
        project: (_raw, state) => {
          state.finalText = '{"ok":"yes"}';
          return { drafts: [], tokens: null, turns: null, failure: { code: 'AGENT_FAILED', message: '坏了' } };
        },
      }),
    });
    expect(asks).toBe(0);
    expect(result.ok).toBe(false);
  });

  it('一条消息都没回（finalText 为 null）⇒ 不追问：没有可回灌的原文，追问等于凭空重问', async () => {
    let asks = 0;
    await runTurn(createRunInput({ outputSchema: SCHEMA }), {
      kind: 'dsh',
      start: async () => silentStart(() => {
        asks += 1;
        return replyingStart('{"ok":true}');
      }),
    });
    expect(asks).toBe(0);
  });

  it('回了空串 ⇒ 仍按不合格追问（空串是「采到了一段空白」，与 null 是两件事）', async () => {
    let asks = 0;
    await runTurn(createRunInput({ outputSchema: SCHEMA }), {
      kind: 'dsh',
      start: async () => replyingStart('', () => {
        asks += 1;
        return replyingStart('{"ok":true}');
      }),
    });
    expect(asks).toBe(1);
  });

  it('已经要求停止 ⇒ 不追问（不再产生任何模型往返）', async () => {
    const controller = new AbortController();
    let asks = 0;
    const result = await runTurn(createRunInput({ outputSchema: SCHEMA, signal: controller.signal }), {
      kind: 'dsh',
      start: async (context) => {
        const started = replyingStart('{"ok":"yes"}', () => {
          asks += 1;
          return replyingStart('{"ok":true}');
        });
        return {
          ...started,
          project: (raw, state) => {
            controller.abort();
            return started.project(raw, state);
          },
        };
      },
    });
    expect(asks).toBe(0);
    expect(result.exitReason).toBe('canceled');
  });

  it('schema 编不出来 ⇒ 退化成「只判可解析」，不追问（少判形状，不误伤）', async () => {
    let asks = 0;
    const result = await runTurn(createRunInput({ outputSchema: { type: 'quaternion' } }), {
      kind: 'dsh',
      start: async () => replyingStart('{"任意":"值"}', () => {
        asks += 1;
        return replyingStart('{}');
      }),
    });
    expect(asks).toBe(0);
    expect(result.ok).toBe(true);
  });
});
