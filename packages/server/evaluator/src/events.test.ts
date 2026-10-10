// @vitest-environment node
/**
 * 事件总线：一次 publish 必须同时完成「落盘」与「扇出」，订阅是 live-only，
 * 坏订阅者不能打断正在跑的 agent 事件流。
 *
 * 两条最容易被写错的语义各有一条**能失败**的守卫，且都用「空白文件上看不出差别」的场景来钉：
 *   1. `seq` / `at` 以**落盘写入器**为准：文件里先有别人的事件时，自己从 1 计数会发出重号；
 *      推进入参而不是写入器的返回值，订阅者手里就没有 `seq` 与 `at`；
 *   2. 订阅**只推订阅之后的事件**：把历史也回放一遍，订阅者会收到订阅前的旧事件。
 * 两条守卫都在变异验证里见过红。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '@aieval/contracts';
import { appendEvent, readEvents, rowEventsFile } from '@aieval/core';
import { publishRowEvent, subscribeRowEvents } from './events';
import { saveRun } from './run-store';
import { createTempHome, makeRowFixture, makeRunFixture, type TempHome } from './testing/fixtures';

let home: TempHome;

beforeEach(() => {
  home = createTempHome();
});

afterEach(() => {
  home.cleanup();
  vi.restoreAllMocks();
});

/** 落盘一轮带单行的评测，返回三个 id 与事件文件路径 */
function seedRow(): { runId: string; rowId: string; file: string } {
  const row = makeRowFixture();
  const run = makeRunFixture({ workspaceRoot: home.workspaceRoot, rows: [row] });
  saveRun(run);
  return { runId: run.id, rowId: row.id, file: rowEventsFile(home.workspaceRoot, run.id, row.id) };
}

describe('publishRowEvent', () => {
  it('落盘：seq 从 1 起单调递增，订阅者拿到的是「已落盘的那一条」', () => {
    const { runId, rowId, file } = seedRow();
    const seen: AgentEvent[] = [];
    subscribeRowEvents(runId, rowId, (event) => seen.push(event));

    // 调用方不给 seq：它由 core 的写入器分配（唯一真相源只能有一个分配者）
    publishRowEvent(runId, rowId, { type: 'status', status: 'running' });
    publishRowEvent(runId, rowId, { type: 'log', stream: 'stdout', text: '你好' });

    const events = readEvents(file);
    expect(events.map((event) => event.seq)).toEqual([1, 2]);
    expect(events[0]?.type).toBe('status');
    expect(seen.map((event) => event.seq)).toEqual([1, 2]);
    expect(seen.map((event) => event.type)).toEqual(['status', 'log']);
    // at 由写入器补：没有它，日志抽屉里所有事件的时间都会是空的
    expect(seen[0]?.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // 「已落盘的那一条」不是修辞：订阅者手里的对象必须与磁盘上那一行**逐字相同**
    // （推调用方的入参会让这里缺 seq / at —— 那正是「推了但没落盘」的分叉）
    expect(seen).toEqual(events);
  });

  it('seq 以落盘写入器为准：文件里已有事件时接着往后发号，而不是自己从 1 计数', () => {
    const { runId, rowId, file } = seedRow();
    // 造「订阅之前文件里就有事件」：上一轮运行留下的日志，或别的写入者直接调 appendEvent。
    // 为什么必须这么造：空白文件上「用写入器的返回值」与「自己从 1 计数」结果都是 1，看不出差别；
    // 而写入器是按**文件里已用的最大 seq** 发号的，所以下一条只能是 3。
    appendEvent(file, { type: 'log', stream: 'stdout', text: '订阅之前就有的第一条' });
    appendEvent(file, { type: 'log', stream: 'stdout', text: '订阅之前就有的第二条' });

    const seen: AgentEvent[] = [];
    subscribeRowEvents(runId, rowId, (event) => seen.push(event));
    publishRowEvent(runId, rowId, { type: 'log', stream: 'stdout', text: '本次' });
    // 调用方硬塞一个 seq 也不算数（放宽的是**入参形状**，不是发号权）：
    // 完整 AgentEvent 是合法入参，但它带的 seq 必须被写入器的返回值覆盖，否则磁盘上会出现重号。
    publishRowEvent(runId, rowId, {
      type: 'log',
      stream: 'stdout',
      text: '硬塞 seq 的调用方',
      seq: 99,
      at: new Date().toISOString(),
    });

    const events = readEvents(file);
    expect(events.map((event) => event.seq)).toEqual([1, 2, 3, 4]);
    expect(seen.map((event) => event.seq)).toEqual([3, 4]);
    // 逐字等于磁盘上那两条：自己发号会从 1 开始（与磁盘重号），推入参会丢掉 seq 与 at
    expect(seen).toEqual([events[2], events[3]]);
  });

  it('行目录不存在时自己建，事件照样落盘（「准备中」这条事件先于工作区复制）', () => {
    const { runId, rowId, file } = seedRow();
    publishRowEvent(runId, rowId, { type: 'log', stream: 'stderr', text: '还没建目录' });
    expect(readEvents(file)).toHaveLength(1);
  });

  it('订阅者抛错不影响落盘，也不影响其它订阅者', () => {
    const { runId, rowId, file } = seedRow();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const good: AgentEvent[] = [];
    subscribeRowEvents(runId, rowId, () => {
      throw new Error('坏订阅者');
    });
    subscribeRowEvents(runId, rowId, (event) => good.push(event));

    expect(() => publishRowEvent(runId, rowId, { type: 'log', stream: 'stdout', text: 'x' })).not.toThrow();

    expect(readEvents(file)).toHaveLength(1);
    expect(good).toHaveLength(1);
    expect(errorSpy).toHaveBeenCalled();
  });
});

describe('subscribeRowEvents', () => {
  it('只收订阅之后的事件（历史由读文件承担，不在这里回放）', () => {
    const { runId, rowId } = seedRow();
    // 订阅之前就发布两条：它们已经在磁盘上了，消费方该做的是「先订阅、再读文件、按 seq 去重」，
    // 而不是指望订阅时把历史推一遍（那会让「先订阅再读文件」的消费方拿到重复事件）。
    publishRowEvent(runId, rowId, { type: 'log', stream: 'stdout', text: '订阅之前的第 1 条' });
    publishRowEvent(runId, rowId, { type: 'log', stream: 'stdout', text: '订阅之前的第 2 条' });

    const seen: AgentEvent[] = [];
    subscribeRowEvents(runId, rowId, (event) => seen.push(event));
    publishRowEvent(runId, rowId, { type: 'log', stream: 'stdout', text: '订阅之后' });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.type === 'log' && seen[0].text).toBe('订阅之后');
    expect(seen[0]?.seq).toBe(3);
  });

  it('取消订阅后不再收到；重复取消不抛', () => {
    const { runId, rowId } = seedRow();
    const seen: AgentEvent[] = [];
    const unsubscribe = subscribeRowEvents(runId, rowId, (event) => seen.push(event));
    publishRowEvent(runId, rowId, { type: 'log', stream: 'stdout', text: '第一条' });
    unsubscribe();
    unsubscribe();
    publishRowEvent(runId, rowId, { type: 'log', stream: 'stdout', text: '第二条' });

    expect(seen).toHaveLength(1);
  });

  it('订阅者在回调里取消自己，不会漏掉本次扇出的其它订阅者', () => {
    const { runId, rowId } = seedRow();
    const seen: string[] = [];
    const first = subscribeRowEvents(runId, rowId, () => {
      first();
      seen.push('first');
    });
    subscribeRowEvents(runId, rowId, () => seen.push('second'));

    publishRowEvent(runId, rowId, { type: 'log', stream: 'stdout', text: 'x' });
    expect(seen).toEqual(['first', 'second']);
  });

  it('同一行只推给该行的订阅者，别行的事件不会串台', () => {
    const rowA = makeRowFixture();
    const rowB = makeRowFixture();
    const run = makeRunFixture({ workspaceRoot: home.workspaceRoot, rows: [rowA, rowB] });
    saveRun(run);
    const seen: AgentEvent[] = [];
    subscribeRowEvents(run.id, rowA.id, (event) => seen.push(event));

    publishRowEvent(run.id, rowB.id, { type: 'log', stream: 'stdout', text: 'B 的日志' });
    expect(seen).toHaveLength(0);
  });

  /**
   * **模块被重新实例化（dev 的 HMR）之后，总线仍是同一张表**。
   *
   * 为什么必须有：`vi.resetModules()` 之后的第二次 `import` 正是 HMR 的形状——编排层还在旧实例里
   * 跑（它 settle 的那一刻才 publish），而接线/SSE 走的是新实例。总线若放模块作用域，两边各拿一份
   * Map ⇒ 连接是 OPEN 的却一个事件都收不到（实测：按当前 seq 续订的连接 0 帧，而 `afterSeq=0`
   * 的连接靠回放拿到 12743 帧），界面上的「轮次」从此不动。挂在 `globalThis` 上就要求「新实例
   * 发出的那一条必须落到旧实例的订阅者手里」——正是下面这条断言。
   */
  it('模块重新实例化后订阅表不分裂：新实例发布的能到达旧实例的订阅者（dev HMR 的形状）', async () => {
    const { runId, rowId } = seedRow();
    const seen: AgentEvent[] = [];
    subscribeRowEvents(runId, rowId, (event) => seen.push(event));

    vi.resetModules();
    // `resetModules` 会把**所有**模块重新实例化（包括 core 的「配置目录」记忆）⇒ 在**新实例**上把临时
    // 配置目录重新指回去，否则新实例读到的是真实 `~/.aieval`，这一条会因为「找不到这一轮」而红
    //（与它要守的东西无关）。注意必须 import 新实例再调，调旧实例的函数只会写旧实例的变量。
    const freshCore = await import('@aieval/core');
    freshCore.setConfigDirForTesting(home.configDir);
    const reloaded = await import('./events');
    reloaded.publishRowEvent(runId, rowId, { type: 'log', stream: 'stdout', text: 'HMR 之后的一条' });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.type === 'log' && seen[0].text).toBe('HMR 之后的一条');
  });
});
