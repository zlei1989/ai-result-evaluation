// @vitest-environment node
/**
 * codex 的两档注入接线：在途走 `turn/steer`、线程空闲后走 `thread/queue/*`。
 *
 * 用假端口 + 假 wire（不 spawn、不碰网络）：本模块的判据全是**我们发了什么请求、什么时候发、
 * 登记了什么撤回闭包**——厂商侧的行为（steer 落在哪、队列几时投出）在这一层看不见，
 * 由各家自己的真机读数与声明里的 `unverified` 如实承载。
 *
 * 三条口径写在这里，因为它们决定了下面每条断言为什么长这样：
 *   1. **`markDelivered` 只在厂商受理之后调**：受理之前那一条仍在我们的表里（`queued`），
 *      「人点了发送」与「模型真收到了」是两份不同的账；
 *   2. **失败不改账**：steer 被拒（最常见的一支是「没有在途轮」）时不登记、不抛，
 *      那一条留在表里等 `'idle'` 档再取一次；
 *   3. **撤回按身份**：`'idle'` 档交回的是厂商的 `queuedSubmission.id`，`'round'` 档没有撤回面。
 */
import { describe, expect, it } from 'vitest';
import type { InjectionBoundary, InjectionPort, RetractOutcome, UserMessage } from '../../types';
import { createCodexInjection } from './turn-injection';

/** 假端口：一张表 + 取件规则（`'round'` 只取「立即发送」那些、`'idle'` 取全部且 round 在前） */
function createFakePort(messages: UserMessage[], boundaries: Record<string, InjectionBoundary> = {}) {
  const table = [...messages];
  const drained: Array<{ boundary: InjectionBoundary; ids: string[] }> = [];
  const delivered = new Map<string, (id: string) => Promise<RetractOutcome>>();
  const available = true;
  const port: InjectionPort = {
    available,
    drain: (boundary) => {
      const take = (message: UserMessage): boolean => boundary === 'idle' || boundaries[message.id] === 'round';
      const picked = table.filter(take);
      for (const one of picked) table.splice(table.indexOf(one), 1);
      drained.push({ boundary, ids: picked.map((one) => one.id) });
      return picked;
    },
    markDelivered: (ids, retract) => {
      for (const id of ids) delivered.set(id, retract);
    },
    retract: async (id) => {
      const handler = delivered.get(id);
      return handler === undefined ? 'unknown' : handler(id);
    },
  };
  return { port, drained, delivered, remaining: () => table.map((one) => one.id) };
}

/** 记录每一次 wire 调用（顺序即事实） */
function createRecorder(
  options: {
    steerError?: string;
    deleted?: boolean;
    listed?: string[];
    listError?: string;
    queueError?: string;
    startError?: string;
    startedTurnId?: string;
  } = {},
) {
  const steers: Array<{ text: string; messageId: string; expectedTurnId: string }> = [];
  const added: Array<{ text: string; messageId: string }> = [];
  const deleted: string[] = [];
  const started: Array<string | null> = [];
  let listed = options.listed ?? [];
  const calls: string[] = [];
  return {
    steers,
    added,
    deleted,
    started,
    calls,
    setListed: (ids: string[]) => {
      listed = ids;
    },
    steer: async (input: { text: string; messageId: string; expectedTurnId: string }): Promise<void> => {
      calls.push(`steer:${input.messageId}`);
      steers.push(input);
      if (options.steerError !== undefined) throw new Error(options.steerError);
    },
    queueAdd: async (input: { text: string; messageId: string }): Promise<string> => {
      calls.push(`queueAdd:${input.messageId}`);
      added.push(input);
      if (options.queueError !== undefined) throw new Error(options.queueError);
      return `qs-${input.messageId}`;
    },
    queueDelete: async (id: string): Promise<boolean> => {
      calls.push(`queueDelete:${id}`);
      deleted.push(id);
      return options.deleted ?? true;
    },
    queueList: async (): Promise<string[]> => {
      calls.push('queueList');
      if (options.listError !== undefined) throw new Error(options.listError);
      return listed;
    },
    queueStart: async (id: string | null): Promise<string> => {
      calls.push(`queueStart:${id ?? 'fifo'}`);
      started.push(id);
      if (options.startError !== undefined) throw new Error(options.startError);
      return options.startedTurnId ?? 'turn-2';
    },
  };
}

/** 在途轮次 id 的取值口（可改：模拟「收场之后没有在途轮」） */
function turnIdHolder(initial: string | null = 'turn-1') {
  const state = { current: initial };
  return { state, get: () => state.current };
}

function message(id: string, text = `第 ${id} 条`): UserMessage {
  return { id, text };
}

describe('codex 注入接线 —— 开关与零回归', () => {
  it('端口缺席 ⇒ 返回空实现：一个请求都不发', async () => {
    const wire = createRecorder();
    const wiring = createCodexInjection({
      port: null,
      activeTurnId: turnIdHolder().get,
      ...wire,
    });
    wiring.onNotification();
    await wiring.onTurnSettled();
    await wiring.settle();
    expect(wire.calls).toEqual([]);
  });

  it('`available === false` ⇒ 一格都不挂（取件都不取）', async () => {
    const fake = createFakePort([message('m1')]);
    const wire = createRecorder();
    const wiring = createCodexInjection({
      port: { ...fake.port, available: false },
      activeTurnId: turnIdHolder().get,
      ...wire,
    });
    wiring.onNotification();
    await wiring.onTurnSettled();
    await wiring.settle();
    expect(wire.calls).toEqual([]);
    expect(fake.drained).toEqual([]);
    expect(fake.remaining()).toEqual(['m1']);
  });
});

describe('codex 注入接线 —— `\'round\'` 档（turn/steer）', () => {
  it('有在途轮 ⇒ 只取要求 round 的，带本轮 id steer，受理之后才登记', async () => {
    const fake = createFakePort([message('m1'), message('m2')], { m1: 'round', m2: 'idle' });
    const wire = createRecorder();
    const turn = turnIdHolder('turn-1');
    const wiring = createCodexInjection({ port: fake.port, activeTurnId: turn.get, ...wire });
    wiring.onNotification();
    await wiring.settle();
    expect(fake.drained).toEqual([{ boundary: 'round', ids: ['m1'] }]);
    expect(wire.steers).toEqual([{ text: '第 m1 条', messageId: 'm1', expectedTurnId: 'turn-1' }]);
    expect([...fake.delivered.keys()]).toEqual(['m1']);
    // 要求 idle 的那一条还在表里（它要等到线程空闲那一档）
    expect(fake.remaining()).toEqual(['m2']);
  });

  /**
   * **没有在途轮就不 steer**。
   *
   * ⚠️ 这一条钉的是**「本轮已收场」那个状态**（`activeTurnId` 为 `null`），不是「resume 之后」：
   * 续接走的是 `thread/resume` **再发一次 `turn/start`** ⇒ 续接轮同样有在途轮、`'round'` 照样可用
   * （`injection.test.ts` 里有一条正面钉住它）。拿 resume 的名义写这条用例会让读者以为
   * 「续接只能走 idle」，而产品接线里那是不可达的状态。
   */
  it('**没有在途轮就不 steer**：本轮已收场之后那些人话只能等 `\'idle\'` 档', async () => {
    const fake = createFakePort([message('m1')], { m1: 'round' });
    const wire = createRecorder();
    const wiring = createCodexInjection({ port: fake.port, activeTurnId: turnIdHolder(null).get, ...wire });
    wiring.onNotification();
    await wiring.settle();
    expect(wire.calls).toEqual([]);
    // 取件都没发生：那一条仍在端口的表里（收场时被 `'idle'` 档取走）
    expect(fake.drained).toEqual([]);
    expect(fake.remaining()).toEqual(['m1']);
    await wiring.onTurnSettled();
    // 收场投递是「登记 → 起轮」两步：起轮成功才算交付（见 `'idle'` 档那一组）
    expect(wire.calls).toEqual(['queueAdd:m1', 'queueStart:fifo']);
  });

  it('厂商拒了（没有在途轮）⇒ 不登记，改由 `\'idle\'` 档兜住（不丢件、不假装投递成功）', async () => {
    const fake = createFakePort([message('m1')], { m1: 'round' });
    const wire = createRecorder({ steerError: 'app-server 返回错误（-32600）：no active turn to steer' });
    const wiring = createCodexInjection({ port: fake.port, activeTurnId: turnIdHolder('turn-1').get, ...wire });
    wiring.onNotification();
    await wiring.settle();
    expect(wire.steers).toHaveLength(1);
    // 被拒那一刻**一个字都没登记**：厂商没受理就不算交给它了
    expect(fake.delivered.size).toBe(0);
    // 取件已经把它从端口的表里拿走了 ⇒ 接线自己在手上一路带到收场，再交给耐久队列
    await wiring.onTurnSettled();
    expect(wire.calls).toEqual(['steer:m1', 'queueAdd:m1', 'queueStart:fifo']);
    await expect(fake.port.retract('m1')).resolves.toBe('retracted');
  });

  it('`\'round\'` 档的撤回闭包回 `unsupported`（turn/steer 没有撤回面）', async () => {
    const fake = createFakePort([message('m1')], { m1: 'round' });
    const wire = createRecorder();
    const wiring = createCodexInjection({ port: fake.port, activeTurnId: turnIdHolder('turn-1').get, ...wire });
    wiring.onNotification();
    await wiring.settle();
    await expect(fake.port.retract('m1')).resolves.toBe('unsupported');
  });
});

describe('codex 注入接线 —— `\'idle\'` 档（thread/queue/*）', () => {
  it('收场那一刻取全部（round 在前），登记进耐久队列**并起轮**——起轮成功才算交付', async () => {
    const fake = createFakePort([message('m1'), message('m2')], { m1: 'round', m2: 'idle' });
    const wire = createRecorder({ startedTurnId: 'turn-2' });
    const wiring = createCodexInjection({ port: fake.port, activeTurnId: turnIdHolder(null).get, ...wire });
    const settled = await wiring.onTurnSettled();
    expect(fake.drained).toEqual([{ boundary: 'idle', ids: ['m1', 'm2'] }]);
    expect(wire.added).toEqual([
      { text: '第 m1 条', messageId: 'm1' },
      { text: '第 m2 条', messageId: 'm2' },
    ]);
    /**
     * 三步顺序是这一档的核心事实：**先登记、再起轮、最后才登记交付**。
     * 厂商的自动撒挂在一轮收场那一刻，而我们的 add 晚于它 ⇒ 不起轮等于没投。
     */
    expect(wire.calls).toEqual(['queueAdd:m1', 'queueAdd:m2', 'queueStart:fifo']);
    expect(fake.delivered.size).toBe(2);
    expect(fake.remaining()).toEqual([]);
    // 新轮号交回给调用方：它据此让通知流继续消费这一轮（而不是就此收场）
    expect(settled).toEqual({ continuedTurnId: 'turn-2' });
  });

  it('起轮失败且**条目还留在队列里** ⇒ 不登记交付，并把它从队列撤回（不假装投递成功）', async () => {
    const fake = createFakePort([message('m1')]);
    // 判据是「条目还在不在可见队列里」：还在 ⇒ 真没投成（线程忙 / 投递失败），按过去的处置走
    const wire = createRecorder({ startError: 'thread already has an active or pending turn', listed: ['qs-m1'] });
    const wiring = createCodexInjection({ port: fake.port, activeTurnId: turnIdHolder(null).get, ...wire });
    const settled = await wiring.onTurnSettled();
    expect(fake.delivered.size).toBe(0);
    expect(wire.calls).toEqual(['queueAdd:m1', 'queueStart:fifo', 'queueList', 'queueDelete:qs-m1']);
    // 回 `null` = 没起成 ⇒ 调用方收场，那一批留在端口里由编排层的预算如实收落 gone
    expect(settled).toEqual({ continuedTurnId: null });
  });

  /**
   * **真机形状**（`arms/arm-queue-race.mjs` ×3 + `probes/inject-idle-live.test.ts`）：
   * 条目录在一个**空闲**线程上时，厂商在 `thread/queue/add` 那一刻就自己把它撒成了一轮
   * ⇒ 紧接着的 `thread/queue/start` 必然拿到 `queue is empty`。此时它**真的在跑**，
   * 按「起轮失败」处置会当场收场并 `dispose` 杀进程（那一轮连同人话一起没）。
   * 判据是「条目已不在可见队列里」（正对照：忙线程上入队的条目会带同一个 id 留在表里）。
   */
  it('起轮失败但**条目已被厂商消费** ⇒ 登记交付，并要求流继续消费厂商自己起的那一轮', async () => {
    const fake = createFakePort([message('m1')]);
    const wire = createRecorder({ startError: 'app-server 返回错误（-32600）：queue is empty', listed: [] });
    const wiring = createCodexInjection({ port: fake.port, activeTurnId: turnIdHolder(null).get, ...wire });
    const settled = await wiring.onTurnSettled();
    expect(fake.delivered.size).toBe(1);
    // 交付了就不该再撤回（撤回闭包照旧按厂商的 queuedSubmission.id 建）
    expect(wire.deleted).toEqual([]);
    /**
     * `vendorDispatched` 是这一档的**唯一出口**：turn id 只能等 `turn/started` 进流时补，
     * 所以这里没有 `continuedTurnId`，但调用方**不许**收场。
     */
    expect(settled).toEqual({ continuedTurnId: null, vendorDispatched: true });
  });

  it('读队列读不回来 ⇒ 保守按「没交付」处置（宁可少认一次交付，也不假报成功）', async () => {
    const fake = createFakePort([message('m1')]);
    const wire = createRecorder({ startError: 'queue is empty', listError: '客户端已关闭' });
    const wiring = createCodexInjection({ port: fake.port, activeTurnId: turnIdHolder(null).get, ...wire });
    const settled = await wiring.onTurnSettled();
    expect(fake.delivered.size).toBe(0);
    expect(settled).toEqual({ continuedTurnId: null });
  });

  it('登记就失败（RPC 报错）⇒ 连起轮都不发；不抛（收场照旧）', async () => {
    const fake = createFakePort([message('m1')]);
    const wire = createRecorder({ queueError: 'thread/queue/add 超时' });
    const wiring = createCodexInjection({ port: fake.port, activeTurnId: turnIdHolder(null).get, ...wire });
    await expect(wiring.onTurnSettled()).resolves.toEqual({ continuedTurnId: null });
    expect(fake.delivered.size).toBe(0);
    expect(wire.started).toEqual([]);
  });

  it('端口里一条都没有 ⇒ 一个 wire 请求都不发（空手收场）', async () => {
    const fake = createFakePort([]);
    const wire = createRecorder();
    const wiring = createCodexInjection({ port: fake.port, activeTurnId: turnIdHolder(null).get, ...wire });
    await expect(wiring.onTurnSettled()).resolves.toEqual({ continuedTurnId: null });
    expect(wire.calls).toEqual([]);
  });
});

describe('codex 注入接线 —— 撤回（按厂商的 queuedSubmission.id）', () => {
  async function wiringWith(address: string, options: Parameters<typeof createRecorder>[0]) {
    const fake = createFakePort([message(address)]);
    const wire = createRecorder(options);
    const wiring = createCodexInjection({ port: fake.port, activeTurnId: turnIdHolder(null).get, ...wire });
    await wiring.onTurnSettled();
    return { fake, wire, wiring };
  }

  it('delete 回 `{deleted:true}` ⇒ `retracted`', async () => {
    const { fake, wire } = await wiringWith('m1', { deleted: true });
    await expect(fake.port.retract('m1')).resolves.toBe('retracted');
    expect(wire.deleted).toEqual(['qs-m1']);
  });

  it('delete 回 `{deleted:false}` 且队列里已没有它 ⇒ `already-consumed`（厂商赢了竞态）', async () => {
    const { fake, wire } = await wiringWith('m1', { deleted: false, listed: [] });
    await expect(fake.port.retract('m1')).resolves.toBe('already-consumed');
    // 读侧只在这一刻读一次：`{deleted:false}` 自己分不开「已消费 / 已删过 / id 不对」
    expect(wire.calls).toEqual(['queueAdd:m1', 'queueStart:fifo', 'queueDelete:qs-m1', 'queueList']);
  });

  it('delete 回 `{deleted:false}` 但它**还在**队列里 ⇒ `unknown`（撤不到，也说不出为什么）', async () => {
    const { fake } = await wiringWith('m1', { deleted: false, listed: ['qs-m1'] });
    await expect(fake.port.retract('m1')).resolves.toBe('unknown');
  });

  it('撤回路径抛错 ⇒ `unknown`（端口那一格不抛，结果如实返回）', async () => {
    const fake = createFakePort([message('m1')]);
    const wiring = createCodexInjection({
      port: fake.port,
      activeTurnId: turnIdHolder(null).get,
      steer: async () => undefined,
      queueAdd: async () => 'qs-1',
      queueDelete: async () => {
        throw new Error('客户端已关闭');
      },
      queueList: async () => [],
      queueStart: async () => 'turn-2',
    });
    await wiring.onTurnSettled();
    await expect(fake.port.retract('m1')).resolves.toBe('unknown');
  });

  it('没登记过的身份 ⇒ `unknown`（不是 `unsupported`：这一档有撤回面，只是这条不在表里）', async () => {
    const { fake } = await wiringWith('m1', { deleted: true });
    await expect(fake.port.retract('m-other')).resolves.toBe('unknown');
  });
});
