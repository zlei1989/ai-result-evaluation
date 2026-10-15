// @vitest-environment node
/**
 * 「在等人工消息」那一格：**窗口什么时候开、什么时候合，以及合上之后看门狗必须重新排**。
 *
 * 这一格的接线分两半，两半各自有靶子：
 *   · **包装层**（`inject.ts` 的 `withInjectionWait`）：判据是适配器在 `'idle'` 边界空手而归
 *     （契约里 `'idle'` 的定义就是「这一整轮没活可干了」），取到东西就离开窗口。纯逻辑，不用定时器；
 *   · **骨架**（`turn.ts` 的第三格豁免）：窗口开着时两级静止计时都挂起、窗口合上时 `leave`
 *     **必须做满三件事**（推墙钟 / 重起空闲表 / 重排看门狗）。少做任何一件，症状分别是
 *     「答完之后旧期限早已过期，当场被判静止」与「挂起之后看门狗再也不排，此后真挂死没人发现」。
 *
 * 四家产品侧全 `false`（打开要有证据），故这一组用 `setInjectionWaitSuspendsForTesting` 临时把
 * 一格打开——它只活在测试期，非测试环境调用直接抛错。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '@aieval/contracts';
import { DEFAULT_INJECT_WAIT_BUDGET_MS, withInjectionWait, type InjectionWaitSink } from './inject';
import { runTurn, setInjectionWaitSuspendsForTesting, type TurnHooks, type TurnProjection } from './turn';
import {
  collectEvents,
  createFakeStream,
  createRecorder,
  createRunInput,
  settleWithFakeTimers,
} from './testing/agent-fixtures';
import type { AgentKind, InjectionPort, UserMessage } from './types';

/** 一个假端口：按调用序号决定 `drain` 交什么（`[]` = 空手而归，`[message]` = 有活干） */
function fakePort(drains: readonly UserMessage[][]): { port: InjectionPort; calls: { boundary: string; at: number }[] } {
  const calls: { boundary: string; at: number }[] = [];
  let index = 0;
  return {
    calls,
    port: {
      available: true,
      drain: (boundary) => {
        calls.push({ boundary, at: Date.now() });
        const out = drains[Math.min(index, drains.length - 1)] ?? [];
        index += 1;
        return [...out];
      },
      markDelivered: () => {},
      retract: async () => 'unsupported',
    },
  };
}

/** 记下进出次数的假 sink */
function spySink(): { sink: InjectionWaitSink; log: string[] } {
  const log: string[] = [];
  return {
    log,
    sink: {
      enter: () => log.push('enter'),
      leave: () => log.push('leave'),
    },
  };
}

const MESSAGE: UserMessage = { id: 'm-1', text: '顺便把 changelog 补上' };

describe('包装层：什么时候算「在等」', () => {
  it('`idle` 边界空手而归 ⇒ 进入；再取到东西 ⇒ 离开（进出成对、不重复进入）', () => {
    const { sink, log } = spySink();
    const { port } = fakePort([[], [], [MESSAGE], []]);
    const wrapped = withInjectionWait(port, sink);

    expect(wrapped.port.drain('idle')).toEqual([]); // 空手而归 ⇒ enter
    expect(wrapped.port.drain('idle')).toEqual([]); // 仍在等：不重复 enter（重复会把「等了多久」算错）
    expect(wrapped.port.drain('idle')).toEqual([MESSAGE]); // 有活干 ⇒ leave
    expect(wrapped.port.drain('idle')).toEqual([]); // 又空手而归 ⇒ enter
    wrapped.close(); // run 收尾 ⇒ 离开
    wrapped.close(); // 幂等
    expect(log).toEqual(['enter', 'leave', 'enter', 'leave']);
  });

  it('`round` 边界不参与判据（它空手而归只说明这一次往返窗口没东西可投）', () => {
    const { sink, log } = spySink();
    const { port } = fakePort([[]]);
    const wrapped = withInjectionWait(port, sink);
    wrapped.port.drain('round');
    expect(log).toEqual([]);
  });

  it('`markDelivered` 也算一次离开：这一批投完了，窗口由下一次取件重新决定', () => {
    const { sink, log } = spySink();
    const { port } = fakePort([[]]);
    const wrapped = withInjectionWait(port, sink);
    wrapped.port.drain('idle');
    wrapped.port.markDelivered(['m-1'], async () => 'unsupported');
    expect(log).toEqual(['enter', 'leave']);
  });

  it('没有 sink（骨架之外单独用端口）时四格逐字透传，不抛', () => {
    const { port } = fakePort([[MESSAGE]]);
    const wrapped = withInjectionWait(port, undefined);
    expect(wrapped.port.available).toBe(true);
    expect(wrapped.port.drain('idle')).toEqual([MESSAGE]);
    expect(() => wrapped.port.markDelivered(['m-1'], async () => 'unsupported')).not.toThrow();
  });
});

describe('等待预算的缺省值', () => {
  it('缺省十分钟（编排层比它早一秒收表，见 evaluator 的等待窗口）', () => {
    expect(DEFAULT_INJECT_WAIT_BUDGET_MS).toBe(600_000);
  });
});

/** 一套合成 hooks：`start` 里按假定时器在指定时刻取件，流挂住不结束（把看门狗留成唯一的终止发起者） */
function waitHarness(input: {
  kind: AgentKind;
  /** 相对开跑的毫秒数 → 那一刻做一次 `'idle'` 取件 */
  drainAtMs: readonly number[];
}): TurnHooks {
  const recorder = createRecorder();
  const projection: TurnProjection = { drafts: [], tokens: null, turns: null, failure: null };
  return {
    kind: input.kind,
    start: async (context) => {
      const stream = createFakeStream([], recorder, { hang: true });
      context.controller.signal.addEventListener('abort', () => stream.stop(), { once: true });
      for (const atMs of input.drainAtMs) {
        setTimeout(() => {
          context.inject.drain('idle');
        }, atMs);
      }
      return {
        stream: stream.iterable,
        interrupt: () => stream.stop(),
        dispose: async () => {},
        project: () => projection,
      };
    },
  };
}

/** 两级上限都调小：假定时器下小时级的墙钟是白等，而判据与真实取值无关 */
const SMALL_WATCHDOG = { idleTimeoutMs: 60_000, turnWallClockMs: 30_000 };

describe('骨架的第三格豁免：窗口开着时看门狗不排，合上后重新排', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setInjectionWaitSuspendsForTesting('dsh', true);
  });

  afterEach(() => {
    setInjectionWaitSuspendsForTesting('dsh', null);
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('挂起期间越过两级上限都不判静止；离开时推进墙钟 + 重起空闲表 + 重排判定', async () => {
    const events: AgentEvent[] = [];
    // 1 秒空手而归（进窗口）→ 200 秒取到一条（离开窗口）
    const { port } = fakePort([[], [MESSAGE]]);
    const harness = waitHarness({ kind: 'dsh', drainAtMs: [1_000, 200_000] });
    const promise = runTurn(
      createRunInput({ inject: port, watchdog: SMALL_WATCHDOG, onEvent: collectEvents(events) }),
      harness,
    );
    let settled = false;
    void promise.then(() => {
      settled = true;
    });

    // 两级上限（30 s / 60 s）都越过了，而窗口一直开着 ⇒ 一次都不许开火
    //（这一条同时钉住「豁免确实登记进了判据」：没登记的话 30 秒那一刻就收场了）
    await vi.advanceTimersByTimeAsync(120_000);
    expect(settled).toBe(false);

    // 200 秒那一刻离开窗口：墙钟按等了 199 秒顺延（30 s → 229 s）、空闲表重起到 260 s
    // ⇒ 不推墙钟、或不用 `noteActivity` 重起空闲表，两个陈旧期限都已过期 ⇒ **当场**开火
    await vi.advanceTimersByTimeAsync(81_000);
    expect(settled).toBe(false);

    // 重排判定的守卫：墙钟那一级（229 s）到点必须自己开火并收场（不再排 ⇒ 这一步挂住）
    const result = await settleWithFakeTimers(promise, { stepMs: 1_000, steps: 60 });
    expect(result.ok).toBe(false);
    expect(result.exitReason).toBe('timed-out');
    expect(events.some((event) => event.type === 'log' && event.text.includes('静止'))).toBe(true);
  });

  it('适配器从没说过「没活可干」⇒ 豁免一格都不动，照常按上限判静止', async () => {
    const events: AgentEvent[] = [];
    // 端口一直有件可取（从不空手而归）：`'idle'` 取件走的是另一条支，窗口永远不开
    const busy: InjectionPort = {
      available: true,
      drain: () => [MESSAGE],
      markDelivered: () => {},
      retract: async () => 'unsupported',
    };
    const harness = waitHarness({ kind: 'dsh', drainAtMs: [1_000, 2_000, 3_000] });
    const promise = runTurn(
      createRunInput({ inject: busy, watchdog: SMALL_WATCHDOG, onEvent: collectEvents(events) }),
      harness,
    );
    let settled = false;
    void promise.then(() => {
      settled = true;
    });

    // 墙钟那一级（30 s）先到 ⇒ 按上限收场
    const result = await settleWithFakeTimers(promise, { stepMs: 1_000, steps: 45 });
    expect(settled).toBe(true);
    expect(result.exitReason).toBe('timed-out');
  });
});
