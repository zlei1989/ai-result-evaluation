// @vitest-environment node
/**
 * codex 适配器层的注入接线：`AgentRunInput.inject` / `resume` 落成哪些 wire 方法，以及
 * `threadId` 有没有随结果交回去（第二期追问要拿它当键）。
 *
 * 用假 app-server（`appserver-fixtures.ts`）：判据是**请求侧的帧序与入参**——真机上那些方法
 * 各自的行为（steer 的落点、耐久队列几时投出）由探针与声明里的 `unverified` 承载，不在这一层。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { removeTreeWithRetry } from '../../testing/cleanup';
import { createRunInput } from '../../testing/agent-fixtures';
import type { AgentRunResult, InjectionBoundary, InjectionPort, RetractOutcome, UserMessage } from '../../types';
import { createFakeAppServer, itemCompleted, type FakeAppServer } from './appserver-fixtures';
import { codexProvider, CODEX_IDLE_CONTINUATION } from './index';

const MAIN = 'thread-main';
const TURN = 'turn-1';

/** 取数面的最小应答（收尾读线程树时会问这三个方法） */
const MINIMAL_RESPOND = {
  'thread/list': () => ({ data: [], nextCursor: null }),
  'thread/read': () => ({ thread: { id: MAIN, turns: [] } }),
  'thread/items/list': () => ({ data: [], nextCursor: null }),
};

/** 一条主线程答复条目：流里推进一格（在途注入的取件挂在通知边界上） */
const MAIN_REPLY = itemCompleted({ type: 'agentMessage', id: 'm1', text: '答复' }, { threadId: MAIN, turnId: TURN });

/**
 * 假端口：一张表 + 取件规则 + 已登记撤回闭包。
 *
 * `onDelivered` 让用例在「刚登记完撤回闭包」那一刻发起一次撤回——那是编排层真实会做的事
 * （用户点了删除），放在这里是因为撤回必须在**客户端还开着**的时候发出去；而这一轮运行的生命周期
 * 由适配器掌握，用例插不进别的时点。
 *
 * `refill` 让用例模拟「人一直在发」：`'idle'` 边界空手而归时补一条进来。续跑上限那条判据
 * 必须有它——端口里没货时「没续跑」与「到上限了」两种原因在结果上不可分。
 */
function createFakePort(
  messages: readonly UserMessage[],
  boundaries: Record<string, InjectionBoundary> = {},
  hooks: {
    onDelivered?: (id: string, port: InjectionPort) => void;
    refill?: () => UserMessage | null;
  } = {},
): { port: InjectionPort; delivered: Map<string, (id: string) => Promise<RetractOutcome>>; remaining: () => string[] } {
  const table = [...messages];
  const delivered = new Map<string, (id: string) => Promise<RetractOutcome>>();
  const port: InjectionPort = {
    available: true,
    drain: (boundary) => {
      let picked = table.filter((one) => boundary === 'idle' || boundaries[one.id] === 'round');
      if (picked.length === 0 && boundary === 'idle' && hooks.refill !== undefined) {
        const next = hooks.refill();
        if (next !== null) {
          table.push(next);
          picked = [next];
        }
      }
      for (const one of picked) table.splice(table.indexOf(one), 1);
      return picked;
    },
    markDelivered: (ids, retract) => {
      for (const id of ids) {
        delivered.set(id, retract);
        hooks.onDelivered?.(id, port);
      }
    },
    retract: async (id) => (await delivered.get(id)?.(id)) ?? 'unknown',
  };
  return { port, delivered, remaining: () => table.map((one) => one.id) };
}

/** `turn/steer` 的应答：厂商受理即成功（前置条件与投递点不在这一层判） */
const STEER_RESPOND = { 'turn/steer': () => ({}) };

/**
 * 队列面四个方法的应答（`thread/queue/*` 的入参形状由真机生成物钉住，这里只回形状）。
 *
 * `thread/queue/start` 必须一起给：`'idle'` 档的交付判据是「**起轮成功**才算交付」，
 * 少了它那一步就失败 ⇒ 适配器按「没交付」回滚（症状是用例红在「撤不回」而不是红在真问题上，
 * 指错方向）。
 */
const QUEUE_RESPOND = {
  'thread/queue/add': () => ({ queuedSubmission: { id: 'qs-m-idle' } }),
  'thread/queue/start': () => ({ turn: { id: 'turn-2', items: [], status: 'inProgress' } }),
  'thread/queue/delete': () => ({ deleted: true }),
  'thread/queue/list': () => ({ data: [], nextCursor: null }),
};

const disposers: Array<() => void> = [];
const homes: string[] = [];

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  for (const home of homes.splice(0)) removeTreeWithRetry(home);
});

/** 把注册表的取数面换成假 app-server（每家一次运行都从 `runtimeHooks` 拿它） */
function useFakeServer(server: FakeAppServer): void {
  const original = codexProvider.runtimeHooks;
  codexProvider.runtimeHooks = { resolveBinary: () => 'C:/fake/codex.exe', createClient: () => server.client };
  disposers.push(() => {
    codexProvider.runtimeHooks = original;
  });
}

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'codex-injection-'));
  homes.push(home);
  return home;
}

/** 让适配器走完「建会话 → 起轮次」（订阅与在途取件都挂在这之后的第一条通知上） */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * 等到某个条件成立（上限按「宁可超时也不假红」定）。
 * 用在「闸门拦下 ⇒ 适配器异步发 `thread/queue/start`」那一拍上：那一刻之前投第二轮的终态
 * 会让流提前结算，判据就测不到该测的那件事。
 */
async function until(ready: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error('等到超时：条件始终没成立');
    await tick();
  }
}

const methodsOf = (server: FakeAppServer): string[] => server.stats.requests.map((one) => one.method);
const paramsOf = (server: FakeAppServer, method: string): Record<string, unknown> | undefined =>
  server.stats.requests.find((one) => one.method === method)?.params as Record<string, unknown> | undefined;

/** 跑一次运行并让它正常收场（终态通知由用例在合适的时机投递） */
/**
 * 起一次运行并立刻把它的 promise 交回调用方。
 *
 * ⚠️ **刻意不是 `async`**：`async` 函数里 `return running` 会**采纳**那个 promise（外层要等它落定），
 * 而本轮运行要等用例投递终态通知才落定 ⇒ 那会死锁在「先 await 启动、再投终态」这条写法上。
 */
function startRun(server: FakeAppServer, overrides: Parameters<typeof createRunInput>[0] = {}): Promise<AgentRunResult> {
  useFakeServer(server);
  return codexProvider.run(createRunInput({ configHome: tempHome(), ...overrides }));
}

describe('codex 注入接线 —— `\'round\'` 档落在 turn/steer', () => {
  it('在途那一轮里取到人话 ⇒ 用**本轮**的 turn id steer，客户身份是我们铸的那个', async () => {
    const server = createFakeAppServer({ respond: { ...MINIMAL_RESPOND, ...STEER_RESPOND }, notifications: [MAIN_REPLY] });
    const fake = createFakePort([{ id: 'm-round', text: '顺便把 changelog 补上' }], { 'm-round': 'round' });
    const running = startRun(server, { inject: fake.port });
    await tick();
    expect(paramsOf(server, 'turn/steer')).toEqual({
      threadId: MAIN,
      expectedTurnId: TURN,
      clientUserMessageId: 'm-round',
      input: [{ type: 'text', text: '顺便把 changelog 补上', text_elements: [] }],
    });
    // 受理之后才算交给厂商：撤回闭包这时候才登记得上，且这一档的答案是 unsupported
    expect([...fake.delivered.keys()]).toEqual(['m-round']);
    await expect(fake.port.retract('m-round')).resolves.toBe('unsupported');
    server.emit('turn/completed', { threadId: MAIN, turn: { id: TURN, items: [], status: 'completed' } });
    await running;
  });
});

describe('codex 注入接线 —— `\'idle\'` 档落在 thread/queue/*', () => {
  it('本轮收场那一刻把剩下的登记进厂商的耐久队列，且按身份撤得回来', async () => {
    const server = createFakeAppServer({ respond: { ...MINIMAL_RESPOND, ...QUEUE_RESPOND }, notifications: [MAIN_REPLY] });
    const retracted: RetractOutcome[] = [];
    const fake = createFakePort([{ id: 'm-idle', text: '等这轮跑完再说' }], { 'm-idle': 'idle' }, {
      // 编排层真会做的事：用户点了删除 ⇒ 拿端口登记的那个闭包去撤（它按厂商的提交 id 认人）。
      // 放在这里是因为撤回必须在**客户端还开着**时发出去，而这一轮的生命周期由适配器掌握。
      onDelivered: (id, port) => {
        void port.retract(id).then((outcome) => retracted.push(outcome));
      },
    });
    const running = startRun(server, { inject: fake.port });
    await tick();
    // 在途那一档不动它（它不是 `'round'`）：一条 steer 都不该发
    expect(methodsOf(server)).not.toContain('turn/steer');
    server.emit('turn/completed', { threadId: MAIN, turn: { id: TURN, items: [], status: 'completed' } });
    /**
     * **第一轮收场不再等于这个候选收场**：闸门把它拦下，适配器把那一批人话交给厂商、
     * 厂商起了新一轮（`thread/queue/start` 回 `turn-2`）⇒ 流要继续消费第二轮，
     * 直到**第二轮**的终态才结算。少投这一帧，这个候选就永远挂在那里（闸门那一格最难踩的地方）。
     */
    await until(() => methodsOf(server).includes('thread/queue/start'));
    expect(server.stats.closeCount).toBe(0);
    server.emit('turn/completed', { threadId: MAIN, turn: { id: 'turn-2', items: [], status: 'completed' } });
    await running;
    expect(paramsOf(server, 'thread/queue/add')).toEqual({
      threadId: MAIN,
      clientUserMessageId: 'm-idle',
      input: [{ type: 'text', text: '等这轮跑完再说', text_elements: [] }],
    });
    // 起轮是 FIFO 那一条：参数里**不带** `queuedSubmissionId`（不给就是起队首）
    expect(paramsOf(server, 'thread/queue/start')).toEqual({ threadId: MAIN });
    expect(paramsOf(server, 'thread/queue/delete')).toEqual({ threadId: MAIN, queuedSubmissionId: 'qs-m-idle' });
    expect(retracted).toEqual(['retracted']);
    expect([...fake.delivered.keys()]).toEqual(['m-idle']);
  });

  /**
   * **真机形状**（`testing/codex-injection-fixture.ts` 那一组真路径读数）：`thread/queue/add` 落在
   * 一个**空闲**线程上时，厂商在 add 那一刻就自己把条目撒成了新一轮 ⇒ 我们紧接着的
   * `thread/queue/start` 回 `queue is empty`，而 `thread/queue/list` 里已经没有它了。
   *
   * 两条判据缺一不可：① 这**不是失败**（登记交付、不撤回）；② 流必须继续消费厂商起的那一轮
   * （否则 `dispose` 会把那一轮连同人话一起杀掉）。在途轮号只能从 `turn/started` 补——
   * 中止请求（`turn/interrupt`）要的正是它。
   */
  it('起轮回 `queue is empty` 但条目已被消费 ⇒ 登记交付，且中止带的是厂商起的那一轮', async () => {
    const server = createFakeAppServer({
      respond: {
        ...MINIMAL_RESPOND,
        'thread/queue/add': () => ({ queuedSubmission: { id: 'qs-m-idle' } }),
        // 条目已被厂商消费 ⇒ 起轮必然空手（真机原文：`queue is empty`）
        'thread/queue/start': () => {
          throw new Error('app-server 返回错误（-32600）：queue is empty');
        },
        // 队列里已经没有它了（与「还在表里」相对：那才是真没投成）
        'thread/queue/list': () => ({ data: [], nextCursor: null }),
      },
      notifications: [MAIN_REPLY],
    });
    const fake = createFakePort([{ id: 'm-idle', text: '厂商自己会投' }], { 'm-idle': 'idle' });
    const controller = new AbortController();
    const running = startRun(server, { inject: fake.port, signal: controller.signal });
    await tick();
    server.emit('turn/completed', { threadId: MAIN, turn: { id: TURN, items: [], status: 'completed' } });
    await until(() => methodsOf(server).includes('thread/queue/list'));
    // ① 交付登记了、也没有去撤回（撤回只该发生在真没投成那一档）
    expect([...fake.delivered.keys()]).toEqual(['m-idle']);
    expect(methodsOf(server)).not.toContain('thread/queue/delete');
    // 厂商随后把那一轮跑起来（真机顺序：queue/changed → active → turn/started）
    server.emit('turn/started', { threadId: MAIN, turn: { id: 'turn-2', items: [], status: 'inProgress' } });
    // 让那一帧进流（在途轮号由流那一侧维护）再中止
    await tick();
    await tick();
    controller.abort();
    await running;
    // ② 中止带的是**厂商起的那一轮**的 id（用建会话时捕获的首轮 id 会被厂商拒：no active turn to interrupt）
    expect(paramsOf(server, 'turn/interrupt')).toEqual({ threadId: MAIN, turnId: 'turn-2' });
  });

  it('收场投递在流结束**之前**完成（否则 dispose 一关客户端，那一条就再也交不出去）', async () => {
    const server = createFakeAppServer({ respond: { ...MINIMAL_RESPOND, ...QUEUE_RESPOND }, notifications: [MAIN_REPLY] });
    const fake = createFakePort([{ id: 'm-idle', text: '排队的一条' }], { 'm-idle': 'idle' });
    const running = startRun(server, { inject: fake.port });
    await tick();
    server.emit('turn/completed', { threadId: MAIN, turn: { id: TURN, items: [], status: 'completed' } });
    await until(() => methodsOf(server).includes('thread/queue/start'));
    // 起轮那一刻客户端**还开着**：关早了这条消息就再也交不出去（dispose 会回收整棵进程树）
    expect(server.stats.closeCount).toBe(0);
    server.emit('turn/completed', { threadId: MAIN, turn: { id: 'turn-2', items: [], status: 'completed' } });
    await running;
    // 关闭发生在投递之后：请求台账里 queue/* 在最后，且客户端确实被关过（回收那条路照走）
    expect(methodsOf(server).indexOf('thread/queue/add')).toBeGreaterThan(methodsOf(server).indexOf('turn/start'));
    expect(server.stats.closeCount).toBe(1);
  });

  /**
   * **上限**：人一直发就能一直续跑的话，这个候选永远不收场，而编排层的等待预算只在适配器
   * 返回之后才开窗口 ⇒ 靠它兜不住这里。上限到点就当没有更多话，正常收场。
   */
  it('续跑有上限：`thread/queue/start` 最多发 `CODEX_IDLE_CONTINUATION.rounds` 次', async () => {
    const product = CODEX_IDLE_CONTINUATION.rounds;
    CODEX_IDLE_CONTINUATION.rounds = 1;
    try {
      const server = createFakeAppServer({ respond: { ...MINIMAL_RESPOND, ...QUEUE_RESPOND }, notifications: [MAIN_REPLY] });
      /** 端口每次都交出新的一条（模拟「人一直在发」） */
      let fed = 0;
      const fake = createFakePort([], {}, {
        refill: () => ({ id: `m-${String((fed += 1))}`, text: `第 ${String(fed)} 条` }),
      });
      const running = startRun(server, { inject: fake.port });
      await tick();
      server.emit('turn/completed', { threadId: MAIN, turn: { id: TURN, items: [], status: 'completed' } });
      await until(() => methodsOf(server).includes('thread/queue/start'));
      // 第二轮：闸门此刻已到上限 ⇒ 这一轮收场即结算（不再起第三轮）
      server.emit('turn/completed', { threadId: MAIN, turn: { id: 'turn-2', items: [], status: 'completed' } });
      await running;
      expect(methodsOf(server).filter((one) => one === 'thread/queue/start')).toHaveLength(1);
      expect(server.stats.closeCount).toBe(1);
    } finally {
      CODEX_IDLE_CONTINUATION.rounds = product;
    }
  });
});

describe('codex 注入接线 —— 零回归与开关', () => {
  it('不传端口 ⇒ 一条注入请求都没有', async () => {
    const server = createFakeAppServer({ respond: MINIMAL_RESPOND, notifications: [MAIN_REPLY] });
    const running = startRun(server);
    await tick();
    server.emit('turn/completed', { threadId: MAIN, turn: { id: TURN, items: [], status: 'completed' } });
    await running;
    expect(methodsOf(server).filter((one) => one.startsWith('turn/steer') || one.startsWith('thread/queue'))).toEqual([]);
  });

  it('端口 `available === false` ⇒ 同样一格都不挂（闸门没开）', async () => {
    const server = createFakeAppServer({ respond: MINIMAL_RESPOND, notifications: [MAIN_REPLY] });
    const fake = createFakePort([{ id: 'm1', text: '喂' }]);
    const running = startRun(server, { inject: { ...fake.port, available: false } });
    await tick();
    server.emit('turn/completed', { threadId: MAIN, turn: { id: TURN, items: [], status: 'completed' } });
    await running;
    expect(methodsOf(server).filter((one) => one.startsWith('turn/steer') || one.startsWith('thread/queue'))).toEqual([]);
    expect(fake.remaining()).toEqual(['m1']);
  });
});

describe('codex 续接（thread/resume）与 threadId 落盘', () => {
  it('不传 resume ⇒ 开新线程，结果里的 sessionId 就是那个 threadId', async () => {
    const server = createFakeAppServer({ respond: MINIMAL_RESPOND, notifications: [MAIN_REPLY] });
    const running = startRun(server);
    await tick();
    server.emit('turn/completed', { threadId: MAIN, turn: { id: TURN, items: [], status: 'completed' } });
    const outcome = await running;
    expect(methodsOf(server)).toContain('thread/start');
    expect(methodsOf(server)).not.toContain('thread/resume');
    // 落盘那个键：第二期追问拿它当 `resume.sessionId`
    expect(outcome.sessionId).toBe(MAIN);
  });

  it('传了 resume ⇒ 只走 thread/resume，sessionId 取自响应的 thread.id', async () => {
    const server = createFakeAppServer({
      respond: { ...MINIMAL_RESPOND, 'thread/resume': () => ({ thread: { id: 'thread-old' } }) },
      notifications: [itemCompleted({ type: 'agentMessage', id: 'm1', text: '答复' }, { threadId: 'thread-old', turnId: TURN })],
    });
    const running = startRun(server, { resume: { sessionId: 'thread-old' } });
    await tick();
    expect(paramsOf(server, 'thread/resume')).toMatchObject({ threadId: 'thread-old' });
    expect(methodsOf(server)).not.toContain('thread/start');
    server.emit('turn/completed', { threadId: 'thread-old', turn: { id: TURN, items: [], status: 'completed' } });
    const outcome = await running;
    expect(outcome.sessionId).toBe('thread-old');
  });

  it('resume 失败 ⇒ 这一轮如实失败，**绝不回落 thread/start**（静默开新会话是最坏的一种）', async () => {
    const server = createFakeAppServer({
      respond: {
        ...MINIMAL_RESPOND,
        'thread/resume': () => {
          throw new Error('app-server 返回错误（-32600）：no rollout found for thread id thread-gone');
        },
      },
    });
    const running = startRun(server, { resume: { sessionId: 'thread-gone' } });
    const outcome = await running;
    expect(outcome.ok).toBe(false);
    // 失败原因点名是哪一步：续接失败与「模型挂了」对排障是两个动作
    expect(outcome.error?.message).toContain('thread/resume');
    expect(methodsOf(server)).not.toContain('thread/start');
  });

  it('resume 接回来的不是「在途轮」⇒ 能 steer 的只有本进程 `turn/start` 起的那一轮', async () => {
    const server = createFakeAppServer({
      respond: { ...MINIMAL_RESPOND, ...STEER_RESPOND, 'thread/resume': () => ({ thread: { id: 'thread-old' } }) },
      // 终态在收场那一刻投递 ⇒ 流里先有一格别的通知，在途取件才有机会被问一次
      notifications: [itemCompleted({ type: 'agentMessage', id: 'm1', text: '答复' }, { threadId: 'thread-old', turnId: TURN })],
    });
    const fake = createFakePort([{ id: 'm-round', text: '接着上一轮插一句' }], { 'm-round': 'round' });
    const running = startRun(server, { resume: { sessionId: 'thread-old' }, inject: fake.port });
    await tick();
    /**
     * **续接接不回一个「在途轮」**：上一进程那一轮早已收场，拿它的 turn id 去 steer 会被厂商拒
     * （真机阴性 `-32600 no active turn to steer`）⇒ `'round'` 的有效范围只有本进程内
     * `turn/start` 已经起来、还没收场的那一轮。这里被 steer 的 id 正是**本轮新起**的那一个，
     * 线程则仍是续接回来的那一条：两格一起才说明「续接」与「插队」是两件事。
     */
    expect(paramsOf(server, 'turn/steer')).toEqual({
      threadId: 'thread-old',
      expectedTurnId: TURN,
      clientUserMessageId: 'm-round',
      input: [{ type: 'text', text: '接着上一轮插一句', text_elements: [] }],
    });
    server.emit('turn/completed', { threadId: 'thread-old', turn: { id: TURN, items: [], status: 'completed' } });
    await running;
  });
});
