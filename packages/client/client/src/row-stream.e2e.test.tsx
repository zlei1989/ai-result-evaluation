// @vitest-environment jsdom
/**
 * **端到端守卫（契约 §11 R38 ③）**：真实的 `EventSource` 语义 + 真实 HTTP 服务器，
 * 断言「订阅之后发布的事件会到达消费方」。
 *
 * 为什么必须有这一条（p5 阶段评审 C1 的教训）：单侧的帧格式断言（api 侧 4 条）与单侧的替身用例
 * （client 侧 12 条 + 24 个变异体）可以**同时全绿而真实链路全死**——api 发的是具名事件
 * （`event: <type>`），client 只绑 `onmessage`，而 `onmessage` 只收无名事件 ⇒ 浏览器里八种事件
 * 全部没有接收者。两侧各自的 brief 都没写错，错在**接缝**。本文件把两侧接起来：
 *   · 服务器按 api 的 `toFrame` **逐字**发帧（`id:` + `event:` + `data:` + 空行，含 `: ready` 注释帧）；
 *   · 客户端用**真实的 `EventSource` 实现**（SSE 规范实现，具名事件派发、`Last-Event-ID` 重连都有），
 *     不是本仓那个替身；
 *   · 断言 `useRowStream` 真的把具名事件交付进了 `events`。
 *
 * 实现说明（两点，都是实测踩出来的）：
 *   1. 真实的 `EventSource` 实现从**仓库已安装的** `eventsource` 包解析（它是某条依赖链的传递依赖，
 *      `pnpm-lock.yaml` 里有、不能直接裸 import）——用 `createRequire` 定位它的**实际路径**再动态
 *      import，并在路径里核对版本号：升级/消失时会以「找不到」红，而不是静默跳过（若将来 Node 自带
 *      `EventSource`，把这里换成全局实现即可，断言不用动）。传递依赖在 pnpm 下的真实落点是
 *      **隐藏提升目录**（谁都没把它声明成直接依赖 ⇒ 不会链进本包），解析要试两处，
 *      见 `realEventSourcePath` 的 JSDoc。
 *   2. 服务器**绝不结束响应**：真实 `EventSource` 在流结束时会按 `retry` 自动重连，
 *      测试若让它乱重连，「不重不漏」这条断言就失去意义。
 */
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { createElement, type ReactNode } from 'react';
import { SWRConfig } from 'swr';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { AgentEvent } from '@aieval/contracts';
import { useRowStream } from './row-stream';

/** 真实 `EventSource` 实现的最小形状（只用本文件需要的部分） */
interface RealEventSource {
  close: () => void;
}
type RealEventSourceCtor = new (url: string, options?: { fetch?: unknown }) => RealEventSource;

/**
 * `eventsource` 包在本仓的实际入口（传递依赖，路径里带版本号）。
 *
 * 三条实测口径（2026-09-30 在 node 与 jsdom 两个环境下各跑过一次）：
 *   1. **一句 `require.resolve('eventsource')` 解析不到**：它是 `@modelcontextprotocol/sdk` 的传递依赖，
 *      而那个 sdk 是 `@anthropic-ai/claude-agent-sdk` 的 **peer**（由 pnpm 的 `auto-install-peers` 装上），
 *      **没有任何包把它声明成直接依赖** ⇒ pnpm 的严格链接不会把它链进本包，本包自己解析必然
 *      `MODULE_NOT_FOUND`；它真实落在 pnpm 的**隐藏提升目录** `node_modules/.pnpm/node_modules/` 里
 *      （`.pnpm` 内部的包解析得到，工作区源码解析不到）。故从本文件所在目录**逐级向上**找，每一级试两处：
 *      `<该级>/node_modules`（将来把它声明成依赖时的落点，`packages/client/client/node_modules` 也在这条线上）
 *      与 `<该级>/node_modules/.pnpm`（隐藏提升）。将来真声明成 devDependency，命中的就是前者，本函数不用改。
 *   2. **路径基准必须用 `import.meta.dirname`，不能用 `new URL(相对路径, import.meta.url)`**：
 *      jsdom 环境下全局 `URL` 是 jsdom 的实现，它构造出的 URL 对象过不了 Node 的 `fileURLToPath`
 *      （实测抛 `The URL must be of scheme file`，而同一时刻 `import.meta.url` 明明是 `file:///` 开头）。
 *      `import.meta.dirname` 在两个环境下实测都是**真实绝对路径**（本仓 `apps/web-next/src/*.test.ts` 多处同法）。
 *   3. 找不到就**抛错**，绝不静默跳过——守卫消失比守卫变红更坏（见文件头第 1 条）。
 */
function realEventSourcePath(): string {
  const require = createRequire(join(import.meta.dirname, 'noop.js'));
  let entry: string | null = null;
  for (let dir = import.meta.dirname, level = 0; level < 6 && entry === null; level += 1) {
    // `paths` 给的是「从哪个目录开始找 node_modules」⇒ 两处分别对应
    // `<base>/node_modules/eventsource` 与 `<base>/node_modules/.pnpm/node_modules/eventsource`
    for (const base of [dir, join(dir, 'node_modules', '.pnpm')]) {
      entry = tryResolve(() => require.resolve('eventsource', { paths: [base] }));
      if (entry !== null) break;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (entry === null) {
    throw new Error(
      '找不到 eventsource 的真实实现（本仓里它是传递依赖：@modelcontextprotocol/sdk ← ' +
        '@anthropic-ai/claude-agent-sdk 的 peer）。修法：把它声明成 @aieval/client 的 devDependency 后重装。' +
        '**不要为了让这条变绿而跳过守护**：R38 ③ 存在的理由正是「两侧单测可以同时全绿而真实链路全死」。',
    );
  }
  if (!/eventsource@3\./.test(entry)) {
    throw new Error(
      `期望 eventsource@3.x 的真实实现，实际解析到：${entry}。` +
        '依赖升级后请复核它的 SSE 语义（具名事件是否派发给 addEventListener）再改这条断言。',
    );
  }
  return entry;
}

/** 解析不到返回 `null`：失败面（要不要抛、抛什么）由调用方一处给，解析策略自己不带第二套判据 */
function tryResolve(resolve: () => string): string | null {
  try {
    return resolve();
  } catch {
    return null;
  }
}

/** 一次真实 HTTP 请求的记录：`/stream` 收到 `Last-Event-ID` 时重连就真的带了它 */
interface Hit {
  url: string;
  lastEventId: string | null;
  afterSeq: string | null;
}

/** 按 api 的 `toFrame` 逐字成帧 */
function frame(event: AgentEvent): string {
  return `id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

function logEvent(seq: number, text: string): AgentEvent {
  return { seq, at: '2026-09-22T08:00:00.000Z', type: 'log', stream: 'stdout', text };
}

/** 一条真实事件流：服务器 + 发布入口 + 请求记录 */
interface Harness {
  /** 本次服务里 `/stream` 收到过的请求（按顺序） */
  hits: Hit[];
  /** 服务器主动推一帧（模拟编排层 `publishRowEvent`） */
  publish: (event: AgentEvent) => void;
  /** 服务器主动断开这条连接（模拟中间层掐断）；浏览器会带 `Last-Event-ID` 自动重连 */
  drop: () => void;
  close: () => Promise<void>;
}

async function startStreamServer(): Promise<Harness> {
  const hits: Hit[] = [];
  const clients = new Set<{ res: import('node:http').ServerResponse; retry: number }>();
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (!url.pathname.endsWith('/stream')) {
      // `/log` 的首帧历史：一条都没有（这一行还没开始跑）
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('[]');
      return;
    }
    const hit: Hit = {
      url: `${url.pathname}${url.search}`,
      lastEventId: req.headers['last-event-id']?.toString() ?? null,
      afterSeq: url.searchParams.get('afterSeq'),
    };
    hits.push(hit);
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    // 与 api 一致：打开就先吐一个字节（F3-①），再等发布
    res.write(': ready\n\n');
    const client = { res, retry: 100 };
    clients.add(client);
    req.on('close', () => clients.delete(client));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  const origin = `http://127.0.0.1:${port}`;

  // hook 发的两个请求都是**相对 URL**（`/api/runs/…/log` 与 `/api/runs/…/stream`），
  // 而 jsdom 的 origin 是 `localhost:3000`（没有服务在听）。这里只做一件事：把相对路径补成
  // 这台测试服务器的绝对地址——`fetch` 用原生 fetch 转发（真实 HTTP），`EventSource` 交给
  // SSE 规范的真实实现（具名事件派发、`Last-Event-ID` 重连都由它承担）。
  const realFetch = globalThis.fetch;
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
    realFetch(new URL(String(input), origin), init),
  );
  class ServerBoundEventSource extends RealEventSource {
    readonly url: string;
    constructor(url: string | URL, options?: { fetch?: unknown }) {
      const absolute = new URL(String(url), origin).toString();
      super(absolute, options);
      this.url = absolute;
    }
  }
  vi.stubGlobal('EventSource', ServerBoundEventSource);

  return {
    hits,
    publish: (event: AgentEvent) => {
      for (const client of clients) client.res.write(frame(event));
    },
    drop: () => {
      for (const client of clients) client.res.destroy();
      clients.clear();
    },
    close: async () => {
      for (const client of clients) client.res.destroy();
      clients.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(SWRConfig, { value: { provider: () => new Map() } }, children);

let harness: Awaited<ReturnType<typeof startStreamServer>>;
/** SSE 规范的真实实现（从仓库已安装的 `eventsource` 包解析）；由 `beforeEach` 装载 */
let RealEventSource: RealEventSourceCtor;

beforeEach(async () => {
  const module = (await import(realEventSourcePath())) as { EventSource: RealEventSourceCtor };
  RealEventSource = module.EventSource;
  harness = await startStreamServer();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await harness.close();
});

describe('useRowStream × 真实 EventSource × 真实 HTTP（R38 ③）', () => {
  it('订阅之后发布的事件真的到达消费方（api 那侧的具名帧被浏览器语义交付）', async () => {
    const { result } = renderHook(() => useRowStream({ runId: 'run-1', rowId: 'w-1', enabled: true }), {
      wrapper,
    });

    // 先等订阅真的建立（服务器收到了 `/stream`）
    await waitFor(() => expect(harness.hits).toHaveLength(1));
    expect(harness.hits[0]?.afterSeq).toBe('0');

    // 编排层推两条：这正是 `POST /start` 之后会发生的事
    await act(async () => {
      harness.publish(logEvent(1, '第一条实时日志'));
    });
    await waitFor(() => expect(result.current.events.map((event) => event.seq)).toEqual([1]));

    await act(async () => {
      harness.publish(logEvent(2, '第二条实时日志'));
    });
    await waitFor(() => expect(result.current.events.map((event) => event.seq)).toEqual([1, 2]));
    expect(result.current.events.at(-1)).toMatchObject({ type: 'log', text: '第二条实时日志' });
  });

  it('断线后浏览器带 `Last-Event-ID` 自动重连，且不重不漏（C1 验收第 3 条）', async () => {
    const { result } = renderHook(() => useRowStream({ runId: 'run-1', rowId: 'w-1', enabled: true }), {
      wrapper,
    });
    await waitFor(() => expect(harness.hits).toHaveLength(1));

    await act(async () => {
      harness.publish(logEvent(1, '掐断前'));
    });
    await waitFor(() => expect(result.current.events.map((event) => event.seq)).toEqual([1]));

    // 服务器断开：浏览器按 `retry` 自动重连，并带上最后收到的 id
    harness.drop();
    await waitFor(() => expect(harness.hits.length).toBeGreaterThanOrEqual(2), { timeout: 5000 });

    const second = harness.hits[1];
    expect(second?.lastEventId).toBe('1');
    // 重连是用头续订的（query 里还是首连那一刻的旧值 0）——服务端优先用头，见 T3 的 `Last-Event-ID` 口径
    expect(second?.afterSeq).toBe('0');

    // 重连之后发布的新事件照常到达，且没有重复
    await act(async () => {
      harness.publish(logEvent(2, '重连后'));
    });
    await waitFor(() => expect(result.current.events.map((event) => event.seq)).toEqual([1, 2]));
  });
});
