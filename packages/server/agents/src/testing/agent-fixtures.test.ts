// @vitest-environment node
/**
 * 夹具自己的回归网（评审 M2）。
 * 为什么单开一个文件测夹具：夹具是「单测不碰真实 API / 真实 CLI」的全部物质基础，而夹具**悄悄变弱**
 * 时依赖它的用例不会红，只会变成假绿（复评 I1 的教训：旧 codex 夹具给了一个真实 SDK 没有的带外
 * `stop()` 特权）。`createFakeDshNotifications` 里「挂起前再查一次」的守卫
 * （`agent-fixtures.ts` 的 `if (terminated !== null) throw terminated;`）此前**从未失败过**：删掉它整包
 * 143 例仍全绿。但它守的是**保真**而不是收敛——真实 `NotificationSubscriptionImpl.next()`
 * （`node_modules/@deepseek-ai/dsh-sdk-client/lib/index.js:256-259`）在 `close()` 之后**立即 reject**
 * （队列丢弃 + 挂起的等待者被 fail）⇒ 「close 早于迭代」这一格在真实件上会立刻拒绝；夹具若删掉这条
 * 前置检查就会在这一格**挂死**，比真实件更弱。所以本文件的立场是：**不删守卫，把夹具的语义钉成常驻证据**。
 * 本文件只驱动夹具本身，不经过任何适配器；所有断言都在毫秒级真实定时器上完成（不碰网络与真实 CLI）。
 */
import { describe, expect, it } from 'vitest';
import { createFakeCodexSdk, createFakeDshSdk, createFakeStream, createRecorder } from './agent-fixtures';

/** 夹具里「挂住」的形状只存在于 promise 上；把「挂死」变成一次可读的失败，而不是让用例超时 */
async function withTimeout<T>(promise: Promise<T>, ms = 200): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`夹具在这一格挂住了（本应立即落定，等待超过 ${ms}ms）`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** 真实定时器下的短暂等待：给「本该排队」的 promise 一次立即落定的机会 */
async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** 记录一个 promise 有没有落定（不消费它的结果，避免制造未处理的 rejection） */
function trackSettlement(promise: Promise<unknown>): () => boolean {
  let settled = false;
  void promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  return () => settled;
}

interface FakeDshHarness {
  readonly client: {
    subscribe: (filter?: (notification: { method: string; params: Record<string, unknown> }) => boolean) => FakeDshSubscription;
    subscribeSessionTree: (sessionId: string) => FakeDshSubscription;
    close: () => Promise<void>;
  };
  start: () => Promise<void>;
  run: (prompt: string, options?: { sessionId?: string }) => Promise<unknown>;
  close: () => Promise<void>;
}

interface FakeDshSubscription extends AsyncIterable<unknown> {
  next: () => Promise<unknown>;
  tryNext: () => unknown;
  close: () => void;
}

interface FakeDshSdkModule {
  DeepSeekHarness: new (options: Record<string, unknown>) => FakeDshHarness;
}

interface FakeCodexSdkModule {
  Codex: new (options: Record<string, unknown>) => {
    startThread: (options: Record<string, unknown>) => {
      runStreamed: (
        prompt: string,
        runOptions: { signal: AbortSignal },
      ) => Promise<{ events: AsyncIterable<unknown> & { return: (value?: unknown) => Promise<unknown> } }>;
    };
  };
}

/**
 * 造一个「订阅已建立」的夹具状态（Task 12 按真实入口重写后，通知不再来自 `createRuntime`，
 * 而是来自 `client.subscribe()` 的返回值）。三个用例共用，避免三份重复的引导代码。
 */
function openSubscription(sdk: FakeDshSdkModule, options: Record<string, unknown> = {}): {
  harness: FakeDshHarness;
  subscription: FakeDshSubscription;
} {
  const harness = new sdk.DeepSeekHarness(options);
  const subscription = harness.client.subscribe();
  return { harness, subscription };
}

describe('夹具 createFakeDshSdk：关闭语义照真实订阅建模', () => {
  it('close() 早于迭代到达挂起点 ⇒ 第一次 next() 立刻拒绝，不是挂死（评审 M2 的那条守卫）', async () => {
    /**
     * 这一格是「保真」而不是「收敛」：真实订阅在 close 后队列已丢弃，`next()` 立即 reject
     * （`lib/index.js:256-259`：先取队列，队列空且 `state.failure` 已置上就 `Promise.reject`）。
     * 夹具里的对应物是「close 时置 failure、`next()` 之前先查它」——没有它，本用例会挂住
     * （withTimeout 报告可读失败）。删掉那一行时本用例必须红，这正是它从「空转守卫」变成
     * 「常驻证据」的地方。
     * 关闭动作走**运行时的** `close()`（真实适配器能碰到的唯一通道），不是订阅自己的 `close()`。
     */
    const recorder = createRecorder();
    const sdk = createFakeDshSdk({ recorder, events: [], hang: true }) as FakeDshSdkModule;
    const { harness, subscription } = openSubscription(sdk);
    await harness.close(); // 关闭发生在迭代**之前**：此刻还没有任何挂起的等待者
    expect(recorder.closeCount).toBe(1);
    // 真实语义：close 后队列已丢弃、`next()` 立即 reject ⇒ 「谁在消费就在那一刻结束」。
    // 夹具不替适配器假装有人在消费（复评 I1 那类「夹具特权」的教训），所以这里自己 `for await`。
    const drained = (async (): Promise<void> => {
      for await (const _notification of subscription) {
        // 不该交付任何东西
      }
    })();
    await expect(withTimeout(drained)).rejects.toThrow('notification subscription closed');
    // 「在途消费结束」这个可观测量在**真的有人消费**时才记
    expect(recorder.order).toEqual(['dispose', 'turn-end']);
  });

  it('close() 发生在挂起点上 ⇒ 挂起的等待者被 reject（真实 close 的另一半语义）', async () => {
    const recorder = createRecorder();
    const sdk = createFakeDshSdk({ recorder, events: [], hang: true }) as FakeDshSdkModule;
    const { harness, subscription } = openSubscription(sdk);
    const drained = (async (): Promise<void> => {
      for await (const _notification of subscription) {
        // 不该交付任何东西
      }
    })();
    await delay(5); // 让消费真的挂到 `next()` 上，再关
    await harness.close();
    await expect(withTimeout(drained)).rejects.toThrow('notification subscription closed');
    expect(recorder.order).toEqual(['dispose', 'turn-end']);
  });

  it('start() 抛错时不给运行时（夹具的 startError 这一格是「起不来」而不是「起来了再坏」）', async () => {
    const recorder = createRecorder();
    const sdk = createFakeDshSdk({ recorder, events: [], startError: new Error('握手失败') }) as FakeDshSdkModule;
    const harness = new sdk.DeepSeekHarness({});
    await expect(withTimeout(harness.start())).rejects.toThrow('握手失败');
    expect(recorder.closeCount).toBe(0); // 没有建出运行时 ⇒ 关闭计数不动
  });

  it('订阅按会话过滤：别人的会话不进本订阅（夹具的 `matches()` 是承重的）', async () => {
    /**
     * 适配器**不**用 `subscribeSessionTree(id)`——它必须在 `run()` 之前订阅，而那时会话 id 还没上线，
     * 所以它用通配 `subscribe(filter)` 认领一个会话、之后只放行同会话的通知。这条用例把那段逻辑
     * 逐字搬进夹具并把会话 id 固定成 `session-mine`（对端先认领，才能把「归属」与「顺序」分开）。
     * 把夹具的 `matches()` 那一层拆掉，第一次 `tryNext()` 会先拿到 `session-other` ⇒ 立刻红。
     */
    const recorder = createRecorder();
    const sdk = createFakeDshSdk({ recorder, events: [] }) as FakeDshSdkModule;
    const harness = new sdk.DeepSeekHarness({});
    const subscription = harness.client.subscribe((notification) => notification.params?.sessionId === 'session-mine');
    // 真实实现在 run() 里才产出通知，所以不用手动 push；两条 run 分别属于不同会话
    await harness.run('提示词', { sessionId: 'session-other' });
    await harness.run('提示词', { sessionId: 'session-mine' });
    // 队列里只该有 `session-mine` 的通知：`session-other` 的一条都没进来
    expect(subscription.tryNext()).toEqual({
      method: 'session.status',
      params: { sessionId: 'session-mine', status: 'running' },
    });
    expect(subscription.tryNext()).toEqual({
      method: 'session.status',
      params: { sessionId: 'session-mine', status: 'idle' },
    });
    expect(subscription.tryNext()).toBeUndefined();
  });
});

describe('夹具 createFakeCodexEvents：return() 只转发，不做带外动作', () => {
  it('生成器挂在 await 上时 return() 只是排队；迭代落到下一个挂起点才生效（复评 I1 的特权已不存在）', async () => {
    /**
     * 为什么必须钉在这里：真实 `Thread.runStreamedInternal` 返回的是**真 async generator**
     * （`dist/index.d.ts:186`），它的 `return()` 带排队语义。旧夹具的 `return()` 走的是带外
     * `stream.stop()`，等于给了适配器一个真实 SDK 没有的能力（复评 I1 的假绿来源）。
     * 这条用例的两个断言分别守住两件事：
     *  ① `return()` 不立即落定 ⇒ 排队语义（若 `return()` 改成不转发、直接 resolve，这里立刻红）；
     *  ② 落定要等到迭代真的走到挂起点 ⇒ 没有带外 `stop()`（若 `return()` 顺手 stop()，①也立刻红）。
     */
    const recorder = createRecorder();
    const controller = new AbortController();
    const sdk = createFakeCodexSdk({ recorder, events: [], hang: true }) as FakeCodexSdkModule;
    const thread = new sdk.Codex({}).startThread({});
    const { events } = await thread.runStreamed('把标题改掉', { signal: controller.signal });
    const iterator = events[Symbol.asyncIterator]();
    void iterator.next(); // 启动迭代并挂到 hang 的那次 await 上
    const returning = events.return();
    const settled = trackSettlement(returning);
    await delay(20);
    expect(settled()).toBe(false); // 排队中：return() 还没有生效
    expect(recorder.order).toEqual([]); // 迭代还挂在 await 上 ⇒ finally 也没跑
    controller.abort(); // = 真实 SDK 交给 spawn(signal) 的那一次中止：让迭代落到下一个挂起点
    await expect(withTimeout(returning)).resolves.toEqual({ done: true, value: undefined });
    // 中止先被记为 'interrupt'（夹具照真实 SDK 把信号接到 spawn 上），迭代随后在此刻结束
    expect(recorder.order).toEqual(['interrupt', 'turn-end']); // 'turn-end' = 在途 turn 终结
    expect(recorder.streamCloseCount).toBe(1); // return() 恰好转发一次，且只记数
  });
});

describe('夹具 createFakeStream：stop() 早于迭代同样不能挂死', () => {
  it('stop() 先于第一次 next() ⇒ 迭代立刻结束（F6 的同款前置检查）', async () => {
    const recorder = createRecorder();
    const stream = createFakeStream([], recorder, { hang: true });
    stream.stop();
    const iterator = stream.iterable[Symbol.asyncIterator]();
    await expect(withTimeout(iterator.next())).resolves.toEqual({ value: undefined, done: true });
    expect(recorder.order).toEqual(['turn-end']);
  });
});
