// @vitest-environment jsdom
/**
 * **端到端守卫（③）**：真实的 `EventSource` 语义 + 真实 HTTP 服务器，
 * 断言「订阅之后发布的事件会到达消费方」。
 *
 * 为什么必须有这一条：单侧的帧格式断言与单侧的替身用例
 * （client 侧 12 条 + 24 个变异体）可以**同时全绿而真实链路全死**——api 发的是具名事件
 * （`event: <type>`），client 只绑 `onmessage`，而 `onmessage` 只收无名事件 ⇒ 浏览器里八种事件
 * 全部没有接收者。两侧各自的用例都没写错，错在**接缝**。本文件把两侧接起来：
 * · 服务器按 api 的 `toFrame` **逐字**发帧（`id:` + `event:` + `data:` + 空行，含 `: ready` 注释帧）；
 * · 客户端用**真实的 `EventSource` 实现**（SSE 规范实现，具名事件派发、`Last-Event-ID` 重连都有），
 * 不是本仓那个替身；
 * · 断言 `useCandidateStream` 真的把具名事件交付进了 `events`。
 *
 * 实现说明：
 * 1. 真实的 `EventSource` 实现由 `testing/real-event-source.ts` 定位（传递依赖的解析口径与版本核对
 * 都在那里，两个 e2e 守卫共用）；本文件只负责把它装成全局并把相对 URL 补成测试服务器的绝对地址。
 * 2. 服务器**绝不结束响应**：真实 `EventSource` 在流结束时会按 `retry` 自动重连，
 * 测试若让它乱重连，「不重不漏」这条断言就失去意义。
 */
import { createServer, type Server } from 'node:http';
import { createElement, type ReactNode } from 'react';
import { SWRConfig } from 'swr';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { AgentEvent } from '@aieval/contracts';
import { resetDrawerStreamHubForTesting } from './drawer-stream-hub';
import { useCandidateStream } from './candidate-stream';
import { realEventSourcePath, type RealEventSource, type RealEventSourceCtor } from './testing/real-event-source';

/** 一次真实 HTTP 请求的记录：`/stream` 收到 `Last-Event-ID` 时重连就真的带了它 */
interface Hit {
  url: string;
  lastEventId: string | null;
  afterSeq: string | null;
}

/** 按 api 的 `toFrame` 逐字成帧：事件帧 = `id:` + 具名 `event:` + 信封载荷（业务载荷 + 归属两格） */
function frame(event: AgentEvent): string {
  return `id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify({ ...event, candidateId: 'w-1', candidateChannel: 'candidate' })}\n\n`;
}

function logEvent(seq: number, text: string): AgentEvent {
  return { seq, at: '2026-09-22T08:00:00.000Z', type: 'log', stream: 'stdout', text };
}

/** 一条真实事件流：服务器 + 发布入口 + 请求记录 */
interface Harness {
  /** 本次服务里 `/stream` 收到过的请求（按顺序） */
  hits: Hit[];
  /** 服务器主动推一帧（模拟编排层 `publishCandidateEvent`） */
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
      // `/log` 的首帧历史：一条都没有（这个候选还没开始跑）
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
    // 与 api 一致：打开就先吐一个字节，再等发布
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
  // 抽屉 hub 是模块级单例：不复位的话上一条用例的 hook（本仓没开自动 cleanup）会把连接留给下一条，
  // 而它指向的是已经被 `harness.close()` 关掉的那台服务器
  resetDrawerStreamHubForTesting();
  const module = (await import(realEventSourcePath())) as { EventSource: RealEventSourceCtor };
  RealEventSource = module.EventSource;
  harness = await startStreamServer();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await harness.close();
});

describe('useCandidateStream × 真实 EventSource × 真实 HTTP（③）', () => {
  it('订阅之后发布的事件真的到达消费方（api 那侧的具名帧被浏览器语义交付）', async () => {
    const { result } = renderHook(() => useCandidateStream({ runId: 'run-1', candidateId: 'w-1', enabled: true, attemptKey: '1' }), {
      wrapper,
    });

    // 先等订阅真的建立（服务器收到了 `/stream`）
    await waitFor(() => expect(harness.hits).toHaveLength(1));
    // 端点形状也要对：单个候选单 channel 的抽屉流（缺 candidateChannel 会被真实路由 400，而这里只断言 URL）
    expect(harness.hits[0]?.url).toBe('/api/runs/run-1/drawer/stream?candidateId=w-1&candidateChannel=candidate&afterSeq=0');

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

  it('断线后浏览器带 `Last-Event-ID` 自动重连，且不重不漏', async () => {
    const { result } = renderHook(() => useCandidateStream({ runId: 'run-1', candidateId: 'w-1', enabled: true, attemptKey: '1' }), {
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
    // 重连是用头续订的（query 里还是首连那一刻的旧值 0）——服务端优先用头，见 `Last-Event-ID` 的续订口径
    expect(second?.afterSeq).toBe('0');

    // 重连之后发布的新事件照常到达，且没有重复
    await act(async () => {
      harness.publish(logEvent(2, '重连后'));
    });
    await waitFor(() => expect(result.current.events.map((event) => event.seq)).toEqual([1, 2]));
  });
});
