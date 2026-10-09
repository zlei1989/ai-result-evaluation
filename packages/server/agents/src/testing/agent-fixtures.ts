/**
 * 测试用的假厂商件：单测「不碰真实 API、不碰真实 CLI」的全部物质基础。
 * 内容：
 *  1. FakeVendorRecorder：记录注入给厂商的对象、调用顺序与关闭次数；
 *  2. createFakeStream：可控的假事件流（可挂住、可被 stop() 提前结束；结束时记 'turn-end'）；
 *  3. createRunInput / collectEvents：AgentRunInput 工厂与事件收集器；
 *  4. settleWithFakeTimers：假定时器下推进时间直到 promise 落定。
 * 注意：本模块只被 *.test.ts import——里面的 vi 与假对象绝不进 `index.ts`。
 */
import type { AgentEvent } from '@aieval/contracts';
import { vi } from 'vitest';
import type { TurnState } from '../turn';
import type { AgentRunInput } from '../types';

export interface FakeVendorRecorder {
  /** 调用顺序：'interrupt' / 'turn-end' / 'dispose'（释放顺序断言的全部可观测量） */
  order: string[];
  /** 厂商拿到的子进程环境（凭据隔离与注入落点的断言对象） */
  env: Record<string, string> | null;
  /** 厂商拿到的客户端 / 查询选项原文 */
  options: Record<string, unknown> | null;
  /** 送进去的提示词 */
  prompt: string | null;
  /** 运行时关闭次数（dispose 幂等的断言对象） */
  closeCount: number;
  /** dsh 夹具：挂住的 `run()` 的释放函数（由 `close()` 触发，模拟「关掉 runtime ⇒ run 结束」） */
  hangRelease: (() => void) | null;
  /**
   * claude 夹具（`interruptRejects` 那一格）的观测量：`interrupt()` 返回的那份被拒 promise
   * **有没有被适配器挂上 handler**（= `then` 被调了几次）。`null` = 那一格没被用过。
   * 为什么是函数而不是布尔值：`interrupt()` 要到释放阶段才被调用，用例是在 run 落定之后才读它，
   * 直接存布尔会在「还没调用」与「调用过但没人挂 handler」之间混淆。
   */
  interruptThenCalls: (() => number) | null;
}

export function createRecorder(): FakeVendorRecorder {
  return {
    order: [],
    env: null,
    options: null,
    prompt: null,
    closeCount: 0,
    hangRelease: null,
    interruptThenCalls: null,
  };
}

export interface FakeStreamOptions {
  /** 吐完事件后挂住，直到 stop()：用来测超时、终止与「适配器忽略停止信号」 */
  hang?: boolean;
  /** 吐完事件后抛出（模拟传输中断 / 进程非零退出） */
  throwAfterEvents?: unknown;
}

export interface FakeStreamHandle {
  iterable: AsyncIterable<unknown>;
  stop: () => void;
}

export function createFakeStream(
  events: readonly unknown[],
  recorder: FakeVendorRecorder,
  options: FakeStreamOptions = {},
): FakeStreamHandle {
  let stopped = false;
  let release: (() => void) | null = null;
  const stop = (): void => {
    stopped = true;
    release?.();
  };
  const iterable: AsyncIterable<unknown> = {
    async *[Symbol.asyncIterator]() {
      try {
        for (const event of events) {
          if (stopped) return;
          yield event;
        }
        if (options.throwAfterEvents !== undefined) throw options.throwAfterEvents;
        if (options.hang === true) {
          // 挂住之前再查一次（评审 F6）：`stop()` 可能早于迭代开始就被调用（例如适配器在 start() 里
          // 就停），那时 `release` 还是 null，`stop()` 只置了 stopped ⇒ 不查这一下就永远醒不过来，
          // 用例会靠 5 秒兜底才收敛，或被 settleWithFakeTimers 报成「用例可能是真的挂住了」。
          if (stopped) return;
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
      } finally {
        // 流结束就是「在途 turn 终结」：释放顺序断言里的中间那一段
        recorder.order.push('turn-end');
      }
    },
  };
  return { iterable, stop };
}

/** AgentRunInput 的默认值工厂：各用例只覆盖自己关心的字段 */
export function createRunInput(overrides: Partial<AgentRunInput> = {}): AgentRunInput {
  return {
    cwd: 'D:/tmp/rows/row-1/workspace',
    configHome: 'D:/tmp/rows/row-1/.agenthome',
    // 默认 **执行阶段的全权限**：绝大多数的适配器用例关心的是注入落点与事件贯通，
    // 而它们此前跑在「能写」的档位上（`acceptEdits` / `workspace-write`）——默认值必须延续那件事，
    // 否则那些用例会**悄悄**改测另一档。权限档自己的用例显式覆盖这一格（见各 provider 的 index.test.ts）。
    permission: 'full',
    prompt: '把 README 的标题改成「示例项目」，然后结束。',
    route: {
      protocolType: 'anthropic',
      baseUrl: 'https://gw.example.com/anthropic',
      apiKey: 'sk-test-key',
      modelId: 'test-model',
    },
    signal: new AbortController().signal,
    onEvent: () => {},
    ...overrides,
  };
}

/** 把事件收集进数组的 onEvent */
export function collectEvents(sink: AgentEvent[]): (event: AgentEvent) => void {
  return (event) => {
    sink.push(event);
  };
}

/**
 * 一份干净的 `TurnState`：**消息层用例的构造器**（块序号分配器与轮次计数都在它上面）。
 * 为什么要有它：`state.seen` 是**去重表**，多条用例共用一个 state 会让第二条用例的消息被
 * 静默吞掉（那条路径看起来只是「没产出」，最难查）；每个场景一个 state 才是正确用法。
 */
export function createTurnState(overrides: Partial<TurnState> = {}): TurnState {
  return {
    seen: new Set(),
    turns: 0,
    usageInput: null,
    usageCached: null,
    usageOutput: null,
    usageReasoningOutput: null,
    usageTotal: null,
    timing: null,
    usageByMessageId: new Map(),
    turnKeys: new Set(),
    finalText: null,
    ...overrides,
  };
}

/**
 * 在假定时器下推进时间直到 promise 落定。
 * 为什么需要：假定时器会把 vitest 自己的超时也一起冻住，用例一旦真的挂住就永远不会失败；
 * 这里把「挂住」变成一次可读的断言失败。
 */
export async function settleWithFakeTimers<T>(
  promise: Promise<T>,
  options: { stepMs?: number; steps?: number } = {},
): Promise<T> {
  const stepMs = options.stepMs ?? 1_000;
  const steps = options.steps ?? 20;
  let done = false;
  void promise.then(
    () => {
      done = true;
    },
    () => {
      done = true;
    },
  );
  for (let index = 0; index < steps && !done; index += 1) {
    await vi.advanceTimersByTimeAsync(stepMs);
  }
  if (!done) throw new Error('假定时器推进后 promise 仍未落定：用例可能是真的挂住了');
  return promise;
}

export interface FakeClaudeSdkOptions {
  recorder: FakeVendorRecorder;
  /** 本次运行要吐出的消息（按顺序） */
  events: readonly unknown[];
  /** 'stop'（默认，合作）| 'ignore'（忽略停止信号，模拟非合作适配器） */
  interrupt?: 'stop' | 'ignore';
  /**
   * `interrupt()` 返回一个以该原因拒绝的 promise（真实 SDK 的形状：
   * `Query closed before response received`）。用来钉「适配器有没有挂 handler 吞掉它」——
   * 裸 `void query.interrupt?.()` 会把它变成 unhandledRejection（Node 默认 `throw` ⇒ 打崩进程）。
   *
   * **怎么让这件事可断言**（不依赖 vitest 对 unhandledRejection 的处置）：夹具自己在下一个微任务
   * 检查那份被拒 promise 有没有被挂上 handler，把结论写进 `recorder.interruptRejectionHandled`。
   * 为什么不能只靠「夹具返回 `Promise.reject()`」：那个 rejection 会不会被报成「未处理」，取决于
   * 测试运行器与 Node 的处置策略——判据会变成「换个 runner 就换个结论」的噪声，而不是行为断言。
   * 不设这一项时 `interrupt()` 返回 undefined（老用例的同步语义不变）。
   */
  interruptRejects?: string;
  /** 吐完消息后挂住，直到被停止（测超时与终止） */
  hang?: boolean;
  /** 吐完消息后抛出（模拟进程非零退出） */
  throwAfterEvents?: unknown;
}

/** 假的 `@anthropic-ai/claude-agent-sdk`：形状与 sdk.ts 的自声明窄结构一致 */
export function createFakeClaudeSdk(options: FakeClaudeSdkOptions): unknown {
  const { recorder } = options;
  return {
    query: (params: { prompt: string; options: Record<string, unknown> }): unknown => {
      recorder.prompt = params.prompt;
      recorder.options = params.options;
      recorder.env = params.options.env as Record<string, string>;
      const controller = params.options.abortController as AbortController;
      const stream = createFakeStream(options.events, recorder, {
        hang: options.hang === true,
        throwAfterEvents: options.throwAfterEvents,
      });
      // 真实适配器用 controller.abort() 做 dispose，故 abort 就是「硬回收已经发生」的可观测量
      controller.signal.addEventListener(
        'abort',
        () => {
          recorder.order.push('dispose');
          stream.stop();
        },
        { once: true },
      );
      return {
        [Symbol.asyncIterator]: () => stream.iterable[Symbol.asyncIterator](),
        interrupt: (): unknown => {
          recorder.order.push('interrupt');
          if (options.interrupt !== 'ignore') stream.stop();
          if (options.interruptRejects === undefined) return undefined;
          // 真实 SDK 的 `interrupt()` 返回 promise，且**会**在被关掉的查询上拒绝
          // （p6 实测原文：`Query closed before response received`）。
          //
          // 怎么让「有没有人挂 handler」变成**同步可断言**的事实（不依赖 unhandledRejection 的
          // 报法、也不依赖微任务时序——两种写法都试过，都会得出错误结论）：
          // 返回一个只记录「`then` 被调了几次」的 thenable。
          //   · `Promise.resolve(x).catch(…)` 里，`Promise.resolve` **同步**调 `x.then` 一次；
          //   · 裸 `void x` 一次都不调。
          // 于是 run 落定后读这个计数就是确定性的判据。刻意不做成真 Promise：真 Promise 的
          // 「有没有 handler」只能在微任务之后才看得出来，而那正是上面两条错路的来源。
          const probe = {
            thenCount: 0,
            then(onFulfilled?: unknown, onRejected?: unknown): Promise<never> {
              probe.thenCount += 1;
              // 真拒绝一次，保证 thenable 的语义与真 promise 一致（调用方拿到的仍是 rejection）
              return Promise.reject(new Error(options.interruptRejects)).then(
                onFulfilled as never,
                onRejected as never,
              );
            },
          };
          recorder.interruptThenCalls = () => probe.thenCount;
          return probe;
        },
      };
    },
  };
}

export interface FakeDshSdkOptions {
  recorder: FakeVendorRecorder;
  /** 本次运行要吐出的通知（按顺序；形状是真实的 `{ method, params }`） */
  events: readonly unknown[];
  /** 吐完通知后挂住（订阅仍有挂起的等待者），直到 `close()` */
  hang?: boolean;
  /** 吐完通知后抛出（模拟传输中断 / 运行时非零退出） */
  throwAfterEvents?: unknown;
  /** `new DeepSeekHarness(...)` 之前抛出（模拟运行时起不来） */
  createError?: unknown;
  /** `start()` 抛出（模拟握手失败） */
  startError?: unknown;
  /**
   * `new DeepSeekHarness(...)` 构造时回调——**装配时刻的快照点**。
   * 为什么需要它：dsh 在 boot 时读 profile 装配清单，所以「文件写没写」必须在**那一刻**判定。
   * 只断言「run() 结束后文件在」证明不了时序——把落盘挪到构造之后，用例照样绿
   * （实测到的守卫无区分力，见 `index.test.ts` 的 ask_user_question 挂载那一条）。
   */
  onConstruct?: () => void;
}

/**
 * dsh 的假通知订阅：**与真实 `NotificationSubscription` 同形**（Task 12 按实测入口重写）。
 * 为什么专门写一份、不复用 `createFakeStream`：真实订阅的终止通道就是 `close()` —— 已安装的
 * `@deepseek-ai/dsh-sdk-client@0.1.7-rc.1`（`lib/index.js:243-318`）里，
 * `NotificationSubscriptionImpl.close()` 会**丢弃队列并 reject 所有挂起的等待者**
 * （`fail(new TransportClosedError('notification subscription closed'))`），而它的
 * `[Symbol.asyncIterator]()` 是 `for (;;) yield await this.next()` 形状的 async generator。
 * ⇒ 「关闭运行时」在 dsh 上是**真实存在**的终止通道（`cancelMidTurn: false` 的代价就是只能走它），
 * 夹具必须照这一格建模；照 claude 夹具那样用带外 `stop()` 会凭空给出一个真实 SDK 没有的能力，
 * 守卫会变成假绿（复评 I1 的教训：夹具形状不真，绿色不算数）。
 * `'turn-end'` 记在迭代生成器的 finally：与另外两家同一个可观测量（在途消费结束）。
 * 另：`filter` 是真实存在的参数（`subscribe(filter?)`），夹具照收、照用——适配器靠它认领会话。
 */
function createFakeDshSubscription(
  options: FakeDshSdkOptions,
  recorder: FakeVendorRecorder,
  filter?: (notification: { method: string; params: Record<string, unknown> }) => boolean,
): {
    subscription: {
      next: () => Promise<unknown>;
      tryNext: () => unknown;
      close: () => void;
      [Symbol.asyncIterator]: () => AsyncGenerator<unknown>;
    };
    push: (notification: unknown) => void;
    finish: () => void;
    fail: (error: unknown) => void;
  } {
  const queue: unknown[] = [];
  let closed = false;
  let waiter: { resolve: (value: unknown) => void; reject: (error: unknown) => void } | null = null;
  let pending: unknown = undefined;
  const matches = (notification: unknown): boolean =>
    filter === undefined ? true : filter(notification as { method: string; params: Record<string, unknown> });

  const deliver = (notification: unknown): void => {
    if (closed || !matches(notification)) return;
    if (waiter !== null) {
      const current = waiter;
      waiter = null;
      current.resolve(notification);
      return;
    }
    queue.push(notification);
  };
  const failAll = (error: unknown): void => {
    if (waiter !== null) {
      const current = waiter;
      waiter = null;
      current.reject(error);
    }
  };
  const subscription = {
    next: (): Promise<unknown> => {
      if (queue.length > 0) return Promise.resolve(queue.shift());
      if (closed) return Promise.reject(pending ?? new Error('notification subscription closed'));
      return new Promise<unknown>((resolve, reject) => {
        waiter = { resolve, reject };
      });
    },
    tryNext: (): unknown => (queue.length > 0 ? queue.shift() : undefined),
    close: (): void => {
      closed = true;
      queue.length = 0; // 真实 close：丢弃队列
      pending = new Error('notification subscription closed');
      failAll(pending); // 真实 close：reject 挂起的等待者
    },
    [Symbol.asyncIterator]: async function* (): AsyncGenerator<unknown> {
      try {
        for (;;) {
          yield await subscription.next();
        }
      } finally {
        recorder.order.push('turn-end');
      }
    },
  };
  return {
    subscription,
    push: deliver,
    finish: () => {
      // 迭代结束（run 落定）：让挂起的 `next()` 以「流结束」收场
      if (waiter !== null) {
        const current = waiter;
        waiter = null;
        current.reject(new Error('run settled'));
      }
    },
    fail: failAll,
  };
}

/**
 * 夹具里代表「**本会话**」的**占位** id：用例的构造数据写它，`tagSession` 在投递前把它换成适配器
 * 真正 mint 的那个 id（真实 SDK 产出的通知一定带那个 id，见 `tagSession` 的 JSDoc）。
 * 为什么要有这个名字（2026-10-04）：子会话的事件带的是**它自己的** id（真机形状）⇒ 夹具必须能区分
 * 「这是占位、该改写」与「这是一个真实存在的另一个会话、改写会把多会话形状压平」。
 */
export const DSH_SESSION_PLACEHOLDER = 'session-fake';

/**
 * 假的 `@deepseek-ai/dsh-sdk-client`：**与真实入口同形**（Task 12 按实测重写）。
 * 真实形态（`lib/types/api.d.ts` + `lib/types/client.d.ts`）：
 *   `new DeepSeekHarness(options)` → `start()`（幂等握手）→ `client.subscribe(filter?)` /
 *   `client.subscribeSessionTree(id)` → `run(prompt, { sessionId })` → `RunResult` → `close()`
 * 「先订阅、再交提示词」这条**顺序**是夹具必须保真的地方：`run()` 只在被调用后才开始产通知，
 * 于是「适配器有没有先订阅」在夹具上是可观测的（订阅晚于 run 就收不到任何通知 ⇒ 用例会红）。
 * 注意：`close` **每次都计数**——真实 `HarnessClient.close()` 自身是幂等的，这里刻意不做幂等，
 * 让「适配器是否重复关闭」成为测试可见的观测量（`createDisposer` 恰好关一次的断言就靠它）。
 * 另：`'turn-end'`（在途消费结束）只在**有人真的在消费迭代器**时才会记——夹具不替适配器假装
 * 有人在消费（那正是复评 I1 那类「夹具特权」）。要在夹具用例里观察这一格，就自己 `for await` 那个订阅。
 */
export function createFakeDshSdk(options: FakeDshSdkOptions): unknown {
  const { recorder } = options;
  class FakeDeepSeekHarness {
    readonly client: {
      subscribe: (filter?: (notification: { method: string; params: Record<string, unknown> }) => boolean) => unknown;
      subscribeSessionTree: (sessionId: string) => unknown;
      close: () => Promise<void>;
    };

    readonly clientOptions: Record<string, unknown>;

    private started = false;

    private readonly subscriptions: Array<{
      subscription: { close: () => void };
      push: (n: unknown) => void;
    }> = [];

    constructor(clientOptions: Record<string, unknown>) {
      this.clientOptions = clientOptions;
      recorder.options = clientOptions;
      recorder.env = clientOptions.env as Record<string, string>;
      // 装配时刻的快照点：调用方在这里读盘，就能判定「启动前该写的写了没有」
      options.onConstruct?.();
      const accept = (
        filter: ((n: { method: string; params: Record<string, unknown> }) => boolean) | undefined,
        scope?: string,
      ) =>
        (notification: { method: string; params: Record<string, unknown> }): boolean =>
          (scope === undefined || notification.params?.sessionId === scope) &&
          (filter === undefined || filter(notification));
      this.client = {
        subscribe: (filter) => {
          const handle = createFakeDshSubscription(options, recorder, accept(filter));
          this.subscriptions.push(handle);
          return handle.subscription;
        },
        subscribeSessionTree: (sessionId) => {
          const handle = createFakeDshSubscription(options, recorder, accept(undefined, sessionId));
          this.subscriptions.push(handle);
          return handle.subscription;
        },
        close: async (): Promise<void> => {
          for (const handle of this.subscriptions) handle.subscription.close();
        },
      };
      // 通知从 `run()` 被调用起才产出：真实实现在 run 里 subscribeSessionTree + prompt
      this.emit = (notification: unknown): void => {
        for (const handle of this.subscriptions) handle.push(notification);
      };
    }

    private readonly emit: (notification: unknown) => void;

    async start(): Promise<void> {
      if (options.startError !== undefined) throw options.startError;
      this.started = true;
      recorder.order.push('start');
    }

    async run(prompt: string, runOptions?: { sessionId?: string }): Promise<unknown> {
      if (options.createError !== undefined) throw options.createError;
      recorder.prompt = prompt;
      const sessionId = runOptions?.sessionId ?? DSH_SESSION_PLACEHOLDER;
      // 提示词先入会话（真实实现：prompt 之后才有事件）——形状照 dump 的第一条
      this.emit({ method: 'session.status', params: { sessionId, status: 'running' } });
      if (options.throwAfterEvents !== undefined) {
        // 传输中断：通知照投，然后以拒绝收场
        for (const event of options.events) this.emit(this.tagSession(event, sessionId));
        throw options.throwAfterEvents;
      }
      if (options.hang === true) {
        // 挂住：run 永不落定、`idle` **永不发出**（模拟「提示词在途、会话还在跑」）。
        // 释放靠 `close()` 的语义——真实 `close()` 会关掉 runtime，run 随之结束；
        // 夹具用 `hangRelease` 表达这一步。若这里仍发出 idle，骨架会以为一次运行已经结束，
        // 「第二段兜底」的用例就永远踩不到那条路径（守卫变假绿）。
        await new Promise<void>((resolve) => {
          recorder.hangRelease = resolve;
        });
        return { sessionId, finalResponse: '', events: [], notifications: [] };
      }
      for (const event of options.events) this.emit(this.tagSession(event, sessionId));
      // `running → idle` 是实测的两条会话状态；run 在 idle 时落定
      this.emit({ method: 'session.status', params: { sessionId, status: 'idle' } });
      return { sessionId, finalResponse: '', events: [], notifications: [] };
    }

    /**
     * 把通知上的会话归属对齐到**本次 run 的会话**。
     * 为什么需要：适配器自己 mint 会话 id 并传给 `run()`，而真实 SDK 产出的通知一定带**那个** id
     * （实测：`session.status` 与 `session.event` 的 `params.sessionId` 就是 `RunResult.sessionId`）。
     * 夹具的构造数据里写的是占位 id，若不改写就会被适配器的会话过滤器挡掉——那不是适配器的缺陷，
     * 而是夹具在这一点上不保真。
     *
     * ⚠️ **只改写占位 id（`DSH_SESSION_PLACEHOLDER`）或没带 id 的那一些**（2026-10-04）：子会话的事件
     * 带的是**它自己的** `params.sessionId`（真机形状：主会话与子会话的通知在**同一条流**里，靠这一格
     * 区分，见 `providers/dsh/index.ts` 的放行规则）。原来无条件改写会把多会话形状压成一个会话——
     * 子会话的用量再也分不出来（`message.ts` 的 `sessionUsage` 正是按 `params.sessionId` 分组的），
     * 于是「子智能体那一份」的守卫会变成假绿。
     */
    private tagSession(notification: unknown, sessionId: string): unknown {
      const record = notification as { params?: Record<string, unknown> } | null;
      if (record === null || typeof record !== 'object' || record.params === undefined) return notification;
      const own = record.params.sessionId;
      if (typeof own === 'string' && own !== '' && own !== DSH_SESSION_PLACEHOLDER) return notification;
      return { ...record, params: { ...record.params, sessionId } };
    }

    async close(): Promise<void> {
      recorder.closeCount += 1;
      recorder.order.push('dispose');
      // 真实 close 的语序：先「关掉 runtime 让在途的 run 结束」，再让订阅以「运行时没了」收场。
      // 反过来会让 `run()` 在 `hangRelease` 之后还活着，用例就会在两个状态之间读到中间态。
      recorder.hangRelease?.();
      await this.client.close();
    }
  }
  return { DeepSeekHarness: FakeDeepSeekHarness };
}
