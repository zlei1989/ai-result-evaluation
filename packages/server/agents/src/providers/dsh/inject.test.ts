// @vitest-environment node
/**
 * dsh 人工消息面的单元判据。三组：
 *   ① 插件源码的形状——按 `DSH_HOME` 定位两份流水、按身份投递 / 撤回、任何失败都回收据
 *      （绝不抛进 runtime 进程）、自报 `ctx.agents` 可不可用；
 *   ② 父进程那一半（`startDshInjection`）：两档各走各的路、登记撤回路径的时机、
 *      收据 → 端口的两条翻译（`markDelivered` / 撤回结果）；
 *   ③ 边界的如实处置：投递失败**不**假装 `markDelivered`、撤回超时回 `unknown`、
 *      `inbox.remove` 回 `false` 读作「已被消费」、停机后在飞的撤回当场收场。
 *
 * 厂商那一侧由本文件扮演（照真插件的形状读写同一对流水）——它正是这条接缝的另一半，
 * 判据因此落在**我们写出去的动作**与**我们读回来的收据**上，而不是模块内部。
 */
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { InjectionBoundary, RetractOutcome } from '@aieval/contracts';
import type { InjectionPort, UserMessage } from '../../types';
import { removeTreeWithRetry } from '../../testing/cleanup';
import {
  DSH_INJECT_PLUGIN_SOURCE,
  DSH_INJECT_QUEUE_RELATIVE_PATH,
  DSH_INJECT_RECEIPTS_RELATIVE_PATH,
  DSH_INJECT_RETRACT_BUDGET_MS,
  DSH_INJECT_STEER_TARGET,
  startDshInjection,
  type DshInjectionDriver,
} from './inject';

/** 等到判据成立（上限按「宁可超时也不假红」：这一组都是临时目录上的动作，秒级足够） */
async function waitFor(what: string, check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    if (check()) return;
    if (Date.now() >= deadline) throw new Error(`等待超时：${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** 读一份 JSONL 流水的行（测试自己的读法，与产品侧的游标实现无关） */
function linesOf(file: string): Array<Record<string, unknown>> {
  try {
    return readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch {
    return [];
  }
}

/** 一次运行要的临时候选目录（两份流水都住在它下面，与适配器的相对落点同源） */
function tempHome(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-inject-'));
}

const homes: string[] = [];
const drivers: DshInjectionDriver[] = [];
afterEach(() => {
  for (const driver of drivers.splice(0)) driver.close();
  for (const home of homes.splice(0)) removeTreeWithRetry(home);
});

/** 一座**假端口**：条目由用例摆好，`markDelivered` / `retract` 的结果记下来供判据读 */
function fakePort(queue: UserMessage[], options: { round?: UserMessage[] } = {}): {
  port: InjectionPort;
  drained: InjectionBoundary[];
  delivered: Array<{ ids: string[] }>;
  retractCalls: string[];
} {
  const drained: InjectionBoundary[] = [];
  const delivered: Array<{ ids: string[] }> = [];
  const retractCalls: string[] = [];
  const retracts = new Map<string, (id: string) => Promise<RetractOutcome>>();
  /** 最近一次登记的撤回闭包：假端口按它服务任何一个 id（真编排层按 id 取对应的那一个） */
  let lastRetract: ((id: string) => Promise<RetractOutcome>) | null = null;
  const port: InjectionPort = {
    available: true,
    drain: (boundary) => {
      drained.push(boundary);
      // 契约：`'round'` 只取要求 `'round'` 的条目、`'idle'` 取全部（`'round'` 在前）
      const roundPool = [...(options.round ?? [])];
      const idlePool = boundary === 'round' ? [] : [...queue];
      (options.round ?? []).length = 0;
      if (boundary !== 'round') queue.length = 0;
      return boundary === 'round' ? roundPool : [...roundPool, ...idlePool];
    },
    markDelivered: (ids, retract) => {
      delivered.push({ ids });
      lastRetract = retract;
      for (const id of ids) retracts.set(id, retract);
    },
    retract: async (id) => {
      retractCalls.push(id);
      const one = retracts.get(id) ?? lastRetract;
      return one === null ? 'unsupported' : one(id);
    },
  };
  return { port, drained, delivered, retractCalls };
}

/**
 * 扮演**插件那一半**：轮询投递流水，按 `row.kind` 回一条收据。
 * `onRow` 可以改写成败（返回 `null` 表示「什么都不回」，用于超时那一条）。
 */
function startFakePlugin(
  home: string,
  onRow: (row: Record<string, unknown>) => Record<string, unknown> | null,
): { stop: () => void } {
  const queue = join(home, DSH_INJECT_QUEUE_RELATIVE_PATH);
  const receipts = join(home, DSH_INJECT_RECEIPTS_RELATIVE_PATH);
  let cursor = 0;
  let stopped = false;
  const timer = setInterval(() => {
    if (stopped) return;
    const candidates = linesOf(queue);
    for (; cursor < candidates.length; cursor += 1) {
      const row = candidates[cursor];
      if (row === undefined) continue;
      const receipt = onRow(row);
      if (receipt !== null) appendFileSync(receipts, `${JSON.stringify(receipt)}\n`, 'utf8');
    }
  }, 2);
  timer.unref();
  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}

/**
 * 插件加载时写的那一条（**真插件的形状**：`plugin-loaded` 行写的是加载那一刻的快照 `serviceAtLoad`，
 * 而 `hasAgents` 只出现在 `steered` 等投递行——真机 0 行 `plugin-loaded` 带 `hasAgents`）。
 *
 * ⚠️ 这个键名必须写实：写成 `hasAgents` 的话，生产侧若把加载行读成 `hasAgents`（那就是恒 false 的误报），
 * 这里的断言照样绿 ⇒ 守卫失去区分力。
 */
function pluginLoaded(home: string, serviceAtLoad = true): void {
  appendFileSync(
    join(home, DSH_INJECT_RECEIPTS_RELATIVE_PATH),
    `${JSON.stringify({ phase: 'plugin-loaded', at: Date.now(), url: `file://${home}/aieval-inject.mjs`, pid: process.pid, serviceAtLoad })}\n`,
    'utf8',
  );
}

function start(home: string, port: InjectionPort, prompt: (text: string) => Promise<string>): DshInjectionDriver {
  homes.push(home);
  const driver = startDshInjection({
    port,
    sessionId: 'session-inject-1',
    queuePath: join(home, DSH_INJECT_QUEUE_RELATIVE_PATH),
    receiptsPath: join(home, DSH_INJECT_RECEIPTS_RELATIVE_PATH),
    prompt,
    pollMs: 2,
    retractBudgetMs: 300,
  });
  drivers.push(driver);
  return driver;
}

describe('DSH_INJECT_PLUGIN_SOURCE（插件源码形状）', () => {
  it('两份流水按 DSH_HOME 定位，且投递走 agent.steer、撤回走 inbox.remove（按身份）', () => {
    expect(DSH_INJECT_PLUGIN_SOURCE).toContain('process.env.DSH_HOME');
    expect(DSH_INJECT_PLUGIN_SOURCE).toContain(DSH_INJECT_QUEUE_RELATIVE_PATH);
    expect(DSH_INJECT_PLUGIN_SOURCE).toContain(DSH_INJECT_RECEIPTS_RELATIVE_PATH);
    expect(DSH_INJECT_PLUGIN_SOURCE).toContain('agent.steer(');
    expect(DSH_INJECT_PLUGIN_SOURCE).toContain('agent.inbox.remove(');
    // 身份由父进程铸：投递用的 id 就是撤回时要的那个 id（同文本两条不会误伤）
    expect(DSH_INJECT_PLUGIN_SOURCE).toContain('messageOf(key,');
  });

  it('拿不到 Agent 或任何一步抛错都回收据而不是抛进 runtime 进程', () => {
    expect(DSH_INJECT_PLUGIN_SOURCE).toContain('reason: \'agent-not-found\'');
    expect(DSH_INJECT_PLUGIN_SOURCE).toContain('phase: \'failed\'');
    // 加载即自报 ctx.agents 可不可用：这是「这一版的服务面能不能拿到 Agent」的唯一判据
    expect(DSH_INJECT_PLUGIN_SOURCE).toContain('hasAgents');
    expect(DSH_INJECT_PLUGIN_SOURCE).toContain('phase: \'plugin-loaded\'');
  });
});

/**
 * 先把一条投出去（撤回路径是**投递之后**登记的：`markDelivered(ids, retract)`），
 * 并返回这一座桥——撤回那几条用例要读它自报的加载事实，也要看它在停机时怎么收场在飞的撤回。
 */
async function deliverOne(
  home: string,
  vendorId: string,
): Promise<{ port: InjectionPort; delivered: Array<{ ids: string[] }>; driver: DshInjectionDriver }> {
  const fake = fakePort([{ id: 'm-1', text: '先别动' }]);
  const driver = start(home, fake.port, async () => vendorId);
  await waitFor('投递登记', () => fake.delivered.length === 1);
  return { port: fake.port, delivered: fake.delivered, driver };
}

describe('人工消息面：两档各走各的路', () => {
  it('idle 档走 wire 的 prompt()，登记交**端口那一条的 id**（厂商 id 只用来撤回）', async () => {
    const home = tempHome();
    writeFileSync(join(home, DSH_INJECT_QUEUE_RELATIVE_PATH), '', 'utf8');
    writeFileSync(join(home, DSH_INJECT_RECEIPTS_RELATIVE_PATH), '', 'utf8');
    const { port, delivered } = fakePort([{ id: 'm-1', text: '先别动' }]);
    const prompts: string[] = [];
    const driver = start(home, port, async (text) => {
      prompts.push(text);
      return 'vendor-msg-1';
    });
    await waitFor('idle 档被投出去', () => delivered.length === 1);
    expect(prompts).toEqual(['先别动']);
    // 端口那一侧（账本 / 交付时刻 / 撤回句柄）只认我们自己的 id：交厂商 id 会三处静默失真
    expect(delivered[0]?.ids).toEqual(['m-1']);
    driver.close();
  });

  it('round 档写投递流水（steer）且不碰 wire，收据到了才登记', async () => {
    const home = tempHome();
    writeFileSync(join(home, DSH_INJECT_QUEUE_RELATIVE_PATH), '', 'utf8');
    writeFileSync(join(home, DSH_INJECT_RECEIPTS_RELATIVE_PATH), '', 'utf8');
    const round: UserMessage[] = [{ id: 'r-1', text: '顺便把 changelog 补上' }];
    const { port, delivered, drained } = fakePort([], { round });
    const plugin = startFakePlugin(home, (row) => ({
      phase: 'steered',
      key: row['key'],
      at: Date.now(),
      messageId: row['key'],
      target: DSH_INJECT_STEER_TARGET,
    }));
    const prompts: string[] = [];
    const driver = start(home, port, async (text) => {
      prompts.push(text);
      return 'never-used';
    });
    await waitFor('round 档被登记', () => delivered.length === 1);
    plugin.stop();
    driver.close();
    // 身份由我们铸：登记回来的 id 就是端口那一条的 id（撤回句柄当场就有）
    expect(delivered[0]?.ids).toEqual(['r-1']);
    // 这一档**不**走 wire
    expect(prompts).toEqual([]);
    expect(drained[0]).toBe('round');
    const candidates = linesOf(join(home, DSH_INJECT_QUEUE_RELATIVE_PATH));
    expect(candidates[0]).toMatchObject({ key: 'r-1', kind: 'steer', sessionId: 'session-inject-1', text: '顺便把 changelog 补上' });
  });
});

describe('人工消息面：撤回', () => {
  it('插件说「撤掉了」⇒ retracted；按身份写 remove 行', async () => {
    const home = tempHome();
    writeFileSync(join(home, DSH_INJECT_QUEUE_RELATIVE_PATH), '', 'utf8');
    writeFileSync(join(home, DSH_INJECT_RECEIPTS_RELATIVE_PATH), '', 'utf8');
    const fake = await deliverOne(home, 'vendor-a');
    const plugin = startFakePlugin(home, (row) =>
      row['kind'] === 'remove'
        ? { phase: 'removed', key: row['key'], at: Date.now(), messageId: row['messageId'], removed: true }
        : null);
    // 端口按**我们的 id** 发起撤回（编排层的表就是按它找句柄的）
    const outcome = await fake.port.retract('m-1');
    plugin.stop();
    expect(outcome).toBe('retracted');
    const removes = linesOf(join(home, DSH_INJECT_QUEUE_RELATIVE_PATH)).filter((row) => row['kind'] === 'remove');
    expect(removes).toHaveLength(1);
    // 落到插件那一候选的仍是**厂商那条消息的 id**（`inbox.remove` 只认它）
    expect(removes[0]).toMatchObject({ kind: 'remove', sessionId: 'session-inject-1', messageId: 'vendor-a' });
  });

  it('插件说「不在待处理队列里」⇒ already-consumed（竞态里厂商赢的那一支）', async () => {
    const home = tempHome();
    writeFileSync(join(home, DSH_INJECT_QUEUE_RELATIVE_PATH), '', 'utf8');
    writeFileSync(join(home, DSH_INJECT_RECEIPTS_RELATIVE_PATH), '', 'utf8');
    const fake = await deliverOne(home, 'vendor-b');
    const plugin = startFakePlugin(home, (row) =>
      row['kind'] === 'remove'
        ? { phase: 'removed', key: row['key'], at: Date.now(), messageId: row['messageId'], removed: false }
        : null);
    // 端口按我们的 id 发起（句柄就是按它登记的）
    const outcome = await fake.port.retract('m-1');
    plugin.stop();
    expect(outcome).toBe('already-consumed');
  });

  it('插件没有任何回音 ⇒ 到点如实回 unknown（不是 unsupported）', async () => {
    const home = tempHome();
    writeFileSync(join(home, DSH_INJECT_QUEUE_RELATIVE_PATH), '', 'utf8');
    writeFileSync(join(home, DSH_INJECT_RECEIPTS_RELATIVE_PATH), '', 'utf8');
    const fake = await deliverOne(home, 'vendor-c');
    const outcome = await fake.port.retract('m-1');
    expect(outcome).toBe('unknown');
    expect(DSH_INJECT_RETRACT_BUDGET_MS).toBeGreaterThan(300);
  });
});

describe('人工消息面：如实处置', () => {
  it('投递失败收据不假装 markDelivered（账本记的是「模型真收到了什么」）', async () => {
    const home = tempHome();
    writeFileSync(join(home, DSH_INJECT_QUEUE_RELATIVE_PATH), '', 'utf8');
    writeFileSync(join(home, DSH_INJECT_RECEIPTS_RELATIVE_PATH), '', 'utf8');
    const round: UserMessage[] = [{ id: 'r-lost', text: '投不出去的一条' }];
    const { port, delivered } = fakePort([], { round });
    const plugin = startFakePlugin(home, (row) => ({
      phase: 'failed',
      key: row['key'],
      at: Date.now(),
      reason: 'agent-not-found',
    }));
    const driver = start(home, port, async () => 'x');
    await waitFor('失败收据落盘', () => linesOf(join(home, DSH_INJECT_RECEIPTS_RELATIVE_PATH)).length > 0);
    // 再等几拍：失败之后**不许**有任何登记动作
    await new Promise((resolve) => setTimeout(resolve, 50));
    plugin.stop();
    driver.close();
    expect(delivered).toEqual([]);
  });

  /**
   * **撤回失败**与**投递失败**是两件事：`failed` 收据带上动作之后，
   *   · `action: 'remove'` ⇒ 在飞的撤回**当场**按 `'unknown'` 结算（不白等到 5 秒预算），
   *     文案说的是「可能已经进了模型上下文」——说「不会进上下文」是假话；
   *   · `action: 'steer'` ⇒ 照旧「这一条不会进模型的上下文」（不假装 `markDelivered`）。
   */
  it('撤回失败的收据 ⇒ 在飞的撤回当场收场（未知），不是等到预算到点', async () => {
    const home = tempHome();
    writeFileSync(join(home, DSH_INJECT_QUEUE_RELATIVE_PATH), '', 'utf8');
    writeFileSync(join(home, DSH_INJECT_RECEIPTS_RELATIVE_PATH), '', 'utf8');
    const fake = await deliverOne(home, 'vendor-r');
    const startedAt = Date.now();
    const pending = fake.port.retract('m-1');
    // 撤回那一候选是**投递流水**里的 `kind: 'remove'`，它的 `key` 才是收据要带回来的（不是条目 id）
    await waitFor('撤回行落盘', () => linesOf(join(home, DSH_INJECT_QUEUE_RELATIVE_PATH)).some((row) => row['kind'] === 'remove'));
    const retractKey = linesOf(join(home, DSH_INJECT_QUEUE_RELATIVE_PATH)).find((row) => row['kind'] === 'remove')?.['key'];
    expect(typeof retractKey).toBe('string');
    // 插件如实回「撤回失败」（真机上这一档的形状：agent 找不到 / `inbox.remove` 抛错）
    appendFileSync(
      join(home, DSH_INJECT_RECEIPTS_RELATIVE_PATH),
      `${JSON.stringify({ phase: 'failed', key: retractKey, at: Date.now(), action: 'remove', reason: 'agent-not-found' })}\n`,
      'utf8',
    );
    expect(await pending).toBe('unknown');
    // 当场 = 远早于 `retractBudgetMs`（这条驱动器的预算是 300ms，取一半当判据）
    expect(Date.now() - startedAt).toBeLessThan(150);
    fake.driver.close();
  });

  it('投递失败的收据不影响撤回，账本也不假装收到', async () => {
    const home = tempHome();
    writeFileSync(join(home, DSH_INJECT_QUEUE_RELATIVE_PATH), '', 'utf8');
    writeFileSync(join(home, DSH_INJECT_RECEIPTS_RELATIVE_PATH), '', 'utf8');
    const round: UserMessage[] = [{ id: 'r-lost-2', text: '投不出去的一条' }];
    const { port, delivered } = fakePort([], { round });
    const plugin = startFakePlugin(home, (row) => ({
      phase: 'failed',
      key: row['key'],
      at: Date.now(),
      action: 'steer',
      reason: 'agent-not-found',
    }));
    const driver = start(home, port, async () => 'x');
    await waitFor('失败收据落盘', () => linesOf(join(home, DSH_INJECT_RECEIPTS_RELATIVE_PATH)).length > 0);
    await new Promise((resolve) => setTimeout(resolve, 50));
    plugin.stop();
    driver.close();
    expect(delivered).toEqual([]);
  });

  it('插件自报加载事实（含 ctx.agents 可不可用），停机后在飞的撤回当场收场', async () => {
    const home = tempHome();
    writeFileSync(join(home, DSH_INJECT_QUEUE_RELATIVE_PATH), '', 'utf8');
    writeFileSync(join(home, DSH_INJECT_RECEIPTS_RELATIVE_PATH), '', 'utf8');
    const fake = await deliverOne(home, 'vendor-d');
    // ⚠️ 断在 `true` 这一档才有区分力：加载行写的是 `serviceAtLoad`，若生产侧只认 `hasAgents`
    // （恒 undefined ⇒ 恒 false），`true` 这一档会红，而 `false` 那一档照样绿——所以这里取 `true`。
    pluginLoaded(home, true);
    await waitFor('加载事实被读到', () => fake.driver.pluginLoaded() !== null);
    expect(fake.driver.pluginLoaded()).toMatchObject({ hasAgents: true });
    const pending = fake.port.retract('m-1');
    fake.driver.close();
    expect(await pending).toBe('unknown');
    // 幂等：再关一次不出错
    fake.driver.close();
  });
});
