// @vitest-environment node
/**
 * 释放序列（§5.6.5）：interrupt → 终结在途 turn → dispose，顺序不可颠倒；
 * 第一段 5 秒超限落可见信号后强制 dispose；守卫按对象绑定且幂等。
 * 顺序断言用 graceMs 直接压到毫秒级——否则这条用例只能靠真等 5 秒来验证。
 */
import { describe, expect, it, vi } from 'vitest';
import { createDisposer, releaseTurn, type TurnLifecycle } from './release';

interface Harness {
  lifecycle: TurnLifecycle;
  order: string[];
  settle: () => void;
  graceExceeded: () => void;
}

function createLifecycle(options: { cooperative?: boolean; disposeThrows?: boolean; interruptThrows?: boolean } = {}): Harness {
  const order: string[] = [];
  let settle: () => void = () => {};
  const settled = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const graceExceeded = vi.fn();
  return {
    order,
    settle: () => {
      order.push('turn-end');
      settle();
    },
    graceExceeded,
    lifecycle: {
      interrupt: () => {
        order.push('interrupt');
        if (options.interruptThrows === true) throw new Error('停止信号自身失败');
        if (options.cooperative !== false) {
          order.push('turn-end');
          settle();
        }
      },
      settled,
      dispose: async () => {
        order.push('dispose');
        if (options.disposeThrows === true) throw new Error('回收失败');
      },
    },
  };
}

describe('releaseTurn', () => {
  it('合作型适配器：interrupt → turn 终结 → dispose（顺序不可颠倒）', async () => {
    const harness = createLifecycle({ cooperative: true });
    const report = await releaseTurn(harness.lifecycle, harness.graceExceeded, 50);
    expect(harness.order).toEqual(['interrupt', 'turn-end', 'dispose']);
    expect(harness.graceExceeded).not.toHaveBeenCalled();
    expect(report.disposeError).toBeNull();
  });

  it('忽略 interrupt 的适配器：第一段超限 → 落可见信号 → 仍强制 dispose（有限时间内完成）', async () => {
    const harness = createLifecycle({ cooperative: false });
    const startedAt = Date.now();
    const report = await releaseTurn(harness.lifecycle, harness.graceExceeded, 20);
    expect(harness.graceExceeded).toHaveBeenCalledTimes(1);
    expect(harness.order).toEqual(['interrupt', 'dispose']);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(report.disposeError).toBeNull();
  });

  it('interrupt 自己抛错也不挡释放（第二段照走）', async () => {
    const harness = createLifecycle({ cooperative: false, interruptThrows: true });
    const report = await releaseTurn(harness.lifecycle, harness.graceExceeded, 20);
    expect(harness.order).toEqual(['interrupt', 'dispose']);
    expect(report.disposeError).toBeNull();
  });

  it('onGraceExceeded 自己抛错也不挡释放（可见信号落盘失败不得变成孤儿进程，评审 F1）', async () => {
    /**
     * 为什么这条是承重的：T6 的 `turn.ts` 传进来的回调会走 `emitter.emit` → `onEvent` → p4 的
     * `appendEvent`，而契约 R26 规定写侧 schema 不过就抛 `ServiceError('INTERNAL')`；`logger.warn` 也可能抛。
     * 裸调用一旦抛错，`dispose()` 永不执行、`releaseTurn` reject —— 子进程/临时目录再也没人回收，
     * 正是 §5.6.5 要防的孤儿。保护级别必须与 `interrupt()` 的 try/catch 对称。
     */
    const harness = createLifecycle({ cooperative: false });
    const throwing = (): void => {
      harness.order.push('grace-warn');
      throw new Error('WARN 落盘失败（例如 appendEvent 因 schema 校验抛错）');
    };
    const report = await releaseTurn(harness.lifecycle, throwing, 20);
    expect(harness.order).toEqual(['interrupt', 'grace-warn', 'dispose']);
    expect(report.disposeError).toBeNull();
  });

  it('dispose 抛错不冒给调用方，只记进报告（让调用方决定怎么落日志）', async () => {
    const harness = createLifecycle({ cooperative: true, disposeThrows: true });
    const report = await releaseTurn(harness.lifecycle, harness.graceExceeded, 50);
    expect(report.disposeError).toBeInstanceOf(Error);
  });
});

describe('createDisposer', () => {
  it('同一个对象恰好关一次，重复调用返回同一个 Promise', async () => {
    const close = vi.fn(async () => {});
    const dispose = createDisposer(close);
    const first = dispose();
    const second = dispose();
    expect(first).toBe(second);
    await Promise.all([first, second]);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('守卫绑定对象而不是全局闭锁：「中断 → 新建客户端 → 释放」不会漏关新客户端（A7）', async () => {
    const closed: string[] = [];
    const first = createDisposer(() => {
      closed.push('client-1');
    });
    const second = createDisposer(() => {
      closed.push('client-2');
    });
    await first();
    await second();
    expect(closed).toEqual(['client-1', 'client-2']);
  });
});
