// @vitest-environment node
/**
 * run 级信号总线：`saveRun` 落盘成功后的一句「这一轮的快照变了」。
 *
 * 与行级事件总线（events.test.ts）不同，这条总线的风险面全在**接缝**上：
 *   1. **发射点唯一**：信号必须挂在 `saveRun`（快照唯一写收口）落盘成功之后——
 *      挂早了会推「还没写进去的快照」（客户端去读会读到旧值），挂到各个调用方
 *      （mutateRow / setRunStatus / api 的创建与更新）会漏一两个写入点；
 *   2. **live-only**：信号是瞬时提示，不落盘、不回放——把历史也推一遍，
 *      刷新页面的客户端会为早已终态的轮次白发一轮 GET；
 *   3. **HMR 不裂脑**：订阅表挂 globalThis（与 events.ts 同一条 2026-09-28 实测教训）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EvalRun } from '@aieval/contracts';
import { publishRunChanged, subscribeRunChanges } from './run-signals';
import { saveRun } from './run-store';
import { createTempHome, makeRunFixture, type TempHome } from './testing/fixtures';

let home: TempHome;

beforeEach(() => {
  home = createTempHome();
});

afterEach(() => {
  home.cleanup();
  vi.restoreAllMocks();
});

describe('run 信号总线', () => {
  it('订阅之后发布的信号能到达，负载只有 runId', () => {
    const seen: string[] = [];
    subscribeRunChanges((runId) => seen.push(runId));

    publishRunChanged('run-1');
    publishRunChanged('run-2');

    expect(seen).toEqual(['run-1', 'run-2']);
  });

  it('live-only：订阅之前的信号不回放（历史由 REST 快照兜着，信号只管「从现在起」）', () => {
    publishRunChanged('run-early');
    const seen: string[] = [];
    subscribeRunChanges((runId) => seen.push(runId));

    publishRunChanged('run-late');

    expect(seen).toEqual(['run-late']);
  });

  it('退订之后不再投递', () => {
    const seen: string[] = [];
    const unsubscribe = subscribeRunChanges((runId) => seen.push(runId));
    unsubscribe();

    publishRunChanged('run-1');

    expect(seen).toEqual([]);
  });

  it('坏订阅者不打断其余订阅者（一个监听器抛错不能让信号链断掉）', () => {
    const seen: string[] = [];
    // 抛错的订阅者用完即退订：总线是 globalThis 级的，留着它会让后续用例的每条 publish 都多打一次 ERROR
    const unsubscribeBroken = subscribeRunChanges(() => {
      throw new Error('这个订阅者坏了');
    });
    subscribeRunChanges((runId) => seen.push(runId));

    expect(() => publishRunChanged('run-1')).not.toThrow();
    expect(seen).toEqual(['run-1']);
    unsubscribeBroken();
  });

  it('saveRun 落盘成功后恰好发一条信号，负载是这一轮的 id（发射点唯一收口）', () => {
    const seen: string[] = [];
    subscribeRunChanges((runId) => seen.push(runId));

    const first = makeRunFixture({ workspaceRoot: home.workspaceRoot });
    const second = makeRunFixture({ workspaceRoot: home.workspaceRoot });
    saveRun(first);
    saveRun(second);

    expect(seen).toEqual([first.id, second.id]);
  });

  it('saveRun 被拒绝时不发信号：真相源没变，不该让任何人去读', () => {
    const seen: string[] = [];
    subscribeRunChanges((runId) => seen.push(runId));
    const run = makeRunFixture({ workspaceRoot: home.workspaceRoot });

    // 状态不合契约 ⇒ 写侧自检拒绝（run-store 的 EvalRunSchema 校验），磁盘没有变化。
    // 双重转型是刻意的：这里要造的正是「类型系统不许直写」的脏快照
    expect(() => saveRun({ ...run, status: '不是合法状态' } as unknown as EvalRun)).toThrow();

    expect(seen).toEqual([]);
  });

  /**
   * 与 events.test.ts 的同款守卫同一条理由：dev 的 HMR 会重新实例化模块，
   * 总线若放模块作用域，「还在跑的旧编排层」发出的信号就到不了「新实例接线的 SSE」。
   */
  it('模块重新实例化后订阅表不分裂：新实例发布的能到达旧实例的订阅者（dev HMR 的形状）', async () => {
    const seen: string[] = [];
    subscribeRunChanges((runId) => seen.push(runId));

    vi.resetModules();
    // resetModules 连 core 的「配置目录」记忆一起重置了：不在新实例上指回去，
    // 下面的 saveRun 会去摸真实 ~/.aieval（与本条守卫无关的红）。
    const freshCore = await import('@aieval/core');
    freshCore.setConfigDirForTesting(home.configDir);
    const reloaded = await import('./run-signals');

    reloaded.publishRunChanged('run-after-hmr');

    expect(seen).toEqual(['run-after-hmr']);
  });
});
