// @vitest-environment jsdom
/**
 * **聚合流的端到端守卫**：真实的 `EventSource` 语义 + 真实 HTTP 服务器，断言
 * 「信封 + 逐行游标 + 实时」这条链路成立。
 *
 * 为什么必须有它：api 侧断言帧文本、client 侧用替身断言分发，两侧可以**同时全绿而真实链路全死**——
 *   · 聚合流的帧是**无名事件**（判别靠信封顶层的 `type`）：一旦有人给它加上 `event:` 行，
 *     浏览器会把整帧投给具名监听器，而 hub 只绑 `onmessage` ⇒ 一帧都到不了（单测里替身照旧投递）；
 *   · 游标是**逐行表**（`?after=w-1:3`）：拼错一个分隔符浏览器不报错，只是静默不回放历史；
 *   · 两条消费路（实时指标 / 活动行）共用**一条**连接：多开一条同样不报错，只是连接数悄悄涨回去。
 * 本文件把三条一起钉住：真 SSE 解析 + 真 HTTP + 两个真 hook（点开详情页时的真实组合）。
 *
 * 服务器不结束响应（浏览器会在流结束时按 `retry` 自动重连，「不重不漏」那类断言会失去意义）；
 * 一条用例专门把连接掐断，验证重连后帧照旧到达——客户端没有自己写重连，靠的就是浏览器语义。
 */
import { createServer, type Server } from 'node:http';
import { createElement, type ReactNode } from 'react';
import { SWRConfig } from 'swr';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { AgentEvent, AgentMessage } from '@aieval/contracts';
import { useRunActivity } from './run-activity';
import { useRunLiveMetrics } from './candidate-live';
import { resetRunStreamHubForTesting } from './run-stream-hub';
import { realEventSourcePath, type RealEventSource, type RealEventSourceCtor } from './testing/real-event-source';

/** 一候选的事件历史：准备中 → 跑起来（带 at）→ 一条用量（末号 = 3，正是指标那一路的游标） */
const START_AT = '2026-09-22T08:01:30.000Z';
const HISTORY: AgentEvent[] = [
  { seq: 1, at: '2026-09-22T08:01:00.000Z', type: 'status', status: 'preparing' },
  { seq: 2, at: START_AT, type: 'status', status: 'running' },
  { seq: 3, at: '2026-09-22T08:02:00.000Z', type: 'usage', tokens: { input: 100, cached: 10, output: 20 }, turns: 1 },
];

/** 按 api 的 `toEventFrame` 逐字成帧：**无名事件**（没有 `event:` 行）+ `id:` */
function eventFrame(candidateId: string, event: AgentEvent): string {
  return `id: ${event.seq}\ndata: ${JSON.stringify({ ...event, candidateId, candidateChannel: 'candidate' })}\n\n`;
}

/** 按 api 的 `toMessageFrame` 逐字成帧：**没有** `id:` 行 */
function messageFrame(candidateId: string, candidateChannel: 'candidate' | 'judge', message: AgentMessage): string {
  return `data: ${JSON.stringify({ type: 'message', candidateId, candidateChannel, message })}\n\n`;
}

function makeMessage(text: string): AgentMessage {
  return {
    messageId: 'm-1',
    vendorId: null,
    role: 'assistant',
    source: 'wire',
    origin: 'case-prompt',
    roundTrip: 1,
    turn: null,
    step: null,
    parentCallId: null,
    subagentId: null,
    chunk: 'delta',
    assembly: 'open',
    mergeKey: 'main|1|assistant|-',
    blocks: [{ type: 'text', text }],
    raw: null,
  };
}

/** 一次真实请求的记录：`/stream` 那一条的 `after` 就是浏览器实际发出去的游标表 */
interface Hit {
  url: string;
  after: string | null;
}

interface Harness {
  hits: Hit[];
  /** 这一刻**还开着**的聚合流连接数（服务端视角）：详情页的连接数判据就是它 */
  openStreams: () => number;
  /** 服务器推一条候选事件（模拟编排层 `publishCandidateEvent` 经聚合流出去） */
  publishEvent: (candidateId: string, event: AgentEvent) => void;
  /** 服务器推一条消息（模拟 `publishCandidateMessage`） */
  publishMessage: (candidateId: string, candidateChannel: 'candidate' | 'judge', message: AgentMessage) => void;
  /** 服务端断开这条连接（中间层掐断）；浏览器会自己重连，客户端不写重连 */
  drop: () => void;
  close: () => Promise<void>;
}

async function startAggregateServer(): Promise<Harness> {
  const hits: Hit[] = [];
  const clients = new Set<import('node:http').ServerResponse>();
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname.endsWith('/log')) {
      // 指标那一路的首帧快照：它折出 foldLiveMetrics 的结果，同时拼出 `?after=` 的表
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(HISTORY));
      return;
    }
    if (!url.pathname.endsWith('/stream')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('[]');
      return;
    }
    hits.push({ url: `${url.pathname}${url.search}`, after: url.searchParams.get('after') });
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    // 与 api 一致：打开就先吐一个字节，再等发布
    res.write(': ready\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  const origin = `http://127.0.0.1:${port}`;

  // hook 发的都是相对 URL（jsdom 的 origin 是 localhost:3000），这里补成测试服务器的绝对地址：
  // `fetch` 走原生实现（真实 HTTP），`EventSource` 交给 SSE 规范的真实实现
  const realFetch = globalThis.fetch;
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
    realFetch(new URL(String(input), origin), init),
  );
  class ServerBoundEventSource extends RealEventSource {
    constructor(url: string | URL, options?: { fetch?: unknown }) {
      super(new URL(String(url), origin).toString(), options);
    }
  }
  vi.stubGlobal('EventSource', ServerBoundEventSource);

  const write = (frame: string): void => {
    for (const res of clients) res.write(frame);
  };

  return {
    hits,
    openStreams: () => clients.size,
    publishEvent: (candidateId, event) => write(eventFrame(candidateId, event)),
    publishMessage: (candidateId, candidateChannel, message) => write(messageFrame(candidateId, candidateChannel, message)),
    drop: () => {
      for (const res of clients) res.destroy();
      clients.clear();
    },
    close: async () => {
      for (const res of clients) res.destroy();
      clients.clear();
      // 被换掉的那条连接在客户端可能还留着半开的 socket：不强制清掉，`server.close()` 会一直等到它超时，
      // 用例的墙钟白白多几秒（而这条流本来就是永不结束的长连接）
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(SWRConfig, { value: { provider: () => new Map() } }, children);

/** 详情页的形状：活动行 + 实时指标两路都挂同一个 run 上 */
function mountDetail() {
  return renderHook(
    () => ({
      live: useRunLiveMetrics({ runId: 'run-1', candidateIds: ['w-1'] }),
      activity: useRunActivity({ runId: 'run-1', candidates: [{ id: 'w-1', status: 'running' }] }),
    }),
    { wrapper },
  );
}

let harness: Awaited<ReturnType<typeof startAggregateServer>>;
/** SSE 规范的真实实现（从仓库已安装的 `eventsource` 包解析）；由 `beforeEach` 装载 */
let RealEventSource: RealEventSourceCtor;

beforeEach(async () => {
  const module = (await import(realEventSourcePath())) as { EventSource: RealEventSourceCtor };
  RealEventSource = module.EventSource;
  resetRunStreamHubForTesting();
  harness = await startAggregateServer();
});

afterEach(async () => {
  resetRunStreamHubForTesting();
  vi.unstubAllGlobals();
  await harness.close();
});

describe('聚合流 × 真实 EventSource × 真实 HTTP', () => {
  it('两路 hook 用一条连接：晚到的那一路带合并后的逐行游标重连一次，之后实时帧同步到达', async () => {
    const { result } = mountDetail();

    // 晚到的那一路（实时指标）先读 `/log` 快照，才带着 `?after=w-1:3` 重连；活动行那一路先开出来
    await waitFor(() => expect(harness.hits.at(-1)?.after).toBe('w-1:3'), { timeout: 10_000 });
    expect(harness.hits.map((hit) => hit.url)).toEqual([
      '/api/runs/run-1/stream',
      '/api/runs/run-1/stream?after=w-1:3',
    ]);

    // 快照里的值已经在界面上了
    await waitFor(() => expect(result.current.live['w-1']?.turns).toBe(1));
    expect(result.current.live['w-1']?.startedAtMs).toBe(Date.parse(START_AT));

    // 实时：事件帧（无名事件 + id）与消息帧（无名事件）都由真实 EventSource 交付、按 candidateId 分流到两路
    const usage: AgentEvent = {
      seq: 4,
      at: '2026-09-22T08:03:00.000Z',
      type: 'usage',
      tokens: { input: 300, cached: 40, output: 90 },
      turns: 3,
    };
    await act(async () => {
      harness.publishEvent('w-1', usage);
      harness.publishMessage('w-1', 'candidate', makeMessage('正在改 lib/http.js'));
    });

    await waitFor(() => expect(result.current.live['w-1']?.turns).toBe(3));
    expect(result.current.live['w-1']?.tokens).toEqual({ input: 300, cached: 40, output: 90 });
    await waitFor(() => expect(result.current.activity['w-1']?.text).toBe('正在改 lib/http.js'));
    expect(result.current.activity['w-1']?.streaming).toBe(true);

    // 稳定态：服务端手里**只有一条**开着的聚合流（先开的那条已被重连换掉），
    // 也没有第二次重连——这就是「详情页的实时数据只有一条连接」的实测判据
    expect(harness.hits).toHaveLength(2);
    await waitFor(() => expect(harness.openStreams()).toBe(1));
  });

  it('连接被掐断后由浏览器自动重连，实时帧照旧到达（客户端不写自己的重连）', async () => {
    const { result } = mountDetail();
    await waitFor(() => expect(harness.hits.at(-1)?.after).toBe('w-1:3'), { timeout: 10_000 });
    const before = harness.hits.length;

    harness.drop();
    await waitFor(() => expect(harness.hits.length).toBeGreaterThan(before), { timeout: 10_000 });

    await act(async () => {
      harness.publishEvent('w-1', {
        seq: 5,
        at: '2026-09-22T08:04:00.000Z',
        type: 'usage',
        tokens: { input: 1, cached: 0, output: 1 },
        turns: 7,
      });
    });

    await waitFor(() => expect(result.current.live['w-1']?.turns).toBe(7));
  });
});
