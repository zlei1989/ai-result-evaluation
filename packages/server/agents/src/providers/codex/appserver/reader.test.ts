// @vitest-environment node
/**
 * `reader.ts` 的行为契约：请求形状、分页拼接、`itemsView` 回退、厂商字段的取值来源。
 *
 * 用假 client（不 spawn 真进程）：真机报文形状由 `protocol.test.ts` 的样例钉住。
 */
import { describe, expect, it } from 'vitest';
import type { AppServerClient, AppServerNotification } from './client';
import { listDescendantThreads, readThreadContent } from './reader';

interface Call {
  method: string;
  params: Record<string, unknown>;
}

class FakeClient implements AppServerClient {
  readonly calls: Call[] = [];
  constructor(private readonly answers: Record<string, unknown[]>) {}

  initialize(): Promise<void> {
    return Promise.resolve();
  }

  request<T>(method: string, params?: unknown): Promise<T> {
    this.calls.push({ method, params: (params ?? {}) as Record<string, unknown> });
    const queue = this.answers[method];
    const next = queue?.shift();
    if (next === undefined) return Promise.reject(new Error(`未准备的应答：${method}`));
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve(next as T);
  }

  notifications(): readonly AppServerNotification[] {
    return [];
  }
  subscribe(): () => void {
    return () => undefined;
  }
  onTerminal(): () => void {
    return () => undefined;
  }
  serverRequests(): readonly [] {
    return [];
  }
  unparsedFrames(): number {
    return 0;
  }
  close(): Promise<void> {
    /* 无副作用；回收整棵进程树是 client.ts 的职责，这一层读不到进程 */
    return Promise.resolve();
  }
}

const MAIN = '01a107a6-fe9a-7232-a0b7-25868a524ea7';
const CHILD = '01a107a7-250e-7911-bcc3-028fe07f66bb';
const GRANDCHILD = '01a107a8-951e-7530-8947-cc99dffdfab3';

/** 子线程元数据：深度与昵称由厂商声明（`source.subagent.thread_spawn`），不是链长推出来的 */
function childThread(id: string, parent: string, depth: number, nickname: string): unknown {
  return {
    id,
    parentThreadId: parent,
    agentNickname: nickname,
    agentRole: 'explorer',
    status: { type: 'notLoaded' },
    source: { subAgent: { thread_spawn: { parent_thread_id: parent, depth, agent_nickname: nickname } } },
  };
}

describe('listDescendantThreads —— 一次取全后代', () => {
  it('按 ancestorThreadId 请求，并跟随 nextCursor 翻页', async () => {
    const client = new FakeClient({
      'thread/list': [
        { data: [childThread(CHILD, MAIN, 1, 'Harvey')], nextCursor: 'cursor-2' },
        { data: [childThread(GRANDCHILD, CHILD, 2, 'Poincare')], nextCursor: null },
      ],
    });
    const threads = await listDescendantThreads(client, MAIN);
    expect(client.calls.map((one) => one.method)).toEqual(['thread/list', 'thread/list']);
    expect(client.calls[0]?.params).toMatchObject({ ancestorThreadId: MAIN });
    expect(client.calls[1]?.params).toMatchObject({ cursor: 'cursor-2' });
    expect(threads.map((one) => one.threadId)).toEqual([CHILD, GRANDCHILD]);
  });

  it('深度与昵称取厂商声明，父链缺失时为 null', async () => {
    const client = new FakeClient({
      'thread/list': [{ data: [childThread(CHILD, MAIN, 1, 'Harvey'), { id: GRANDCHILD }], nextCursor: null }],
    });
    const threads = await listDescendantThreads(client, MAIN);
    expect(threads[0]).toMatchObject({ threadId: CHILD, parentThreadId: MAIN, depth: 1, nickname: 'Harvey', role: 'explorer' });
    expect(threads[1]).toMatchObject({ threadId: GRANDCHILD, parentThreadId: null, depth: null, nickname: null, role: null });
  });

  it('空页返回空数组（不是「没采到」）', async () => {
    const client = new FakeClient({ 'thread/list': [{ data: [], nextCursor: null }] });
    await expect(listDescendantThreads(client, MAIN)).resolves.toEqual([]);
  });
});

const FULL_TURN = {
  id: 'turn-1',
  itemsView: 'full',
  status: 'completed',
  durationMs: 900,
  items: [
    { type: 'reasoning', id: 'r1', summary: [], content: ['先看仓库结构。'] },
    { type: 'agentMessage', id: 'm1', text: 'PASS' },
  ],
};

describe('readThreadContent —— 线程内容', () => {
  /**
   * **两步取数**：元数据走 `thread/read`（**不带** `includeTurns`），轮次走 `thread/turns/list`。
   *
   * 为什么不合成一步：paginated 线程上带 `includeTurns` 是厂商已弃用的「全量历史水合」，
   * 真机会回一条 `deprecationNotice`（原文见 `reader.ts` 的 JSDoc）。本用例同时钉住
   * 「不许再出现 includeTurns」——那正是弃用信号指向我们的那一处。
   */
  it('元数据走 `thread/read`（不带 includeTurns）、轮次走 `thread/turns/list`；全 full 时直接取条目', async () => {
    const client = new FakeClient({
      'thread/read': [{ thread: { id: CHILD, parentThreadId: MAIN } }],
      'thread/turns/list': [{ data: [FULL_TURN], nextCursor: null }],
    });
    const content = await readThreadContent(client, CHILD);
    expect(client.calls.map((one) => one.method)).toEqual(['thread/read', 'thread/turns/list']);
    expect(client.calls[0]?.params).not.toHaveProperty('includeTurns');
    expect(content?.thread.turns[0]).toMatchObject({ id: 'turn-1', status: 'completed', durationMs: 900 });
    expect(content?.items).toEqual([
      { turnId: 'turn-1', item: { kind: 'reasoning', id: 'r1', summary: [], content: ['先看仓库结构。'] } },
      { turnId: 'turn-1', item: { kind: 'agentMessage', id: 'm1', text: 'PASS', phase: null } },
    ]);
  });

  it('轮次分页：`thread/turns/list` 翻到 nextCursor 为空为止', async () => {
    const client = new FakeClient({
      'thread/read': [{ thread: { id: CHILD } }],
      'thread/turns/list': [
        { data: [{ ...FULL_TURN, id: 'turn-1' }], nextCursor: 'turns-2' },
        { data: [{ ...FULL_TURN, id: 'turn-2' }], nextCursor: null },
      ],
    });
    const content = await readThreadContent(client, CHILD);
    expect(client.calls.map((one) => one.method)).toEqual(['thread/read', 'thread/turns/list', 'thread/turns/list']);
    expect(client.calls[2]?.params).toMatchObject({ threadId: CHILD, cursor: 'turns-2' });
    expect(content?.thread.turns.map((one) => one.id)).toEqual(['turn-1', 'turn-2']);
  });

  it('任一 turn 不是 full ⇒ 改走 thread/items/list 并拼接分页', async () => {
    const client = new FakeClient({
      'thread/read': [{ thread: { id: CHILD } }],
      'thread/turns/list': [
        { data: [{ id: 'turn-1', itemsView: 'summary', status: 'completed', items: [{ type: 'agentMessage', id: 'x', text: '摘要' }] }], nextCursor: null },
      ],
      'thread/items/list': [
        { data: [{ turnId: 'turn-1', item: { type: 'agentMessage', id: 'm1', text: '第一页' } }], nextCursor: 'cursor-2' },
        { data: [{ turnId: 'turn-1', item: { type: 'commandExecution', id: 'c1', command: 'ls', status: 'completed' } }], nextCursor: null },
      ],
    });
    const content = await readThreadContent(client, CHILD);
    expect(client.calls.map((one) => one.method)).toEqual(['thread/read', 'thread/turns/list', 'thread/items/list', 'thread/items/list']);
    expect(client.calls[3]?.params).toMatchObject({ threadId: CHILD, cursor: 'cursor-2' });
    expect(content?.items.map((one) => one.item.kind)).toEqual(['agentMessage', 'commandExecution']);
  });

  /**
   * **不认识的 `itemsView` 按「没载全」处置**（fail-safe），不是按 `full`。
   *
   * 要拦的缺陷：归一化把未知取值倒向 `full`。那是 fail-open——上游新增一档（或改默认）时
   * 这里的回退判据 `turns.every(t => t.itemsView === 'full')` 直接为真、分页补齐不触发，
   * **摘要被当全量用**，而「摘要不是全量」正是这一层的口径。倒向 `notLoaded` 最坏只多跑一次分页。
   */
  it('`itemsView` 是没见过的取值 ⇒ 照样走分页补齐（不把它当 full）', async () => {
    const client = new FakeClient({
      'thread/read': [{ thread: { id: CHILD } }],
      'thread/turns/list': [
        { data: [{ id: 'turn-1', itemsView: '某个新档', items: [{ type: 'agentMessage', id: 'x', text: '只有一半' }] }], nextCursor: null },
      ],
      'thread/items/list': [
        { data: [{ turnId: 'turn-1', item: { type: 'agentMessage', id: 'm1', text: '全量那一份' } }], nextCursor: null },
      ],
    });
    const content = await readThreadContent(client, CHILD);
    expect(client.calls.map((one) => one.method)).toEqual(['thread/read', 'thread/turns/list', 'thread/items/list']);
    expect(content?.items.map((one) => one.item.kind)).toEqual(['agentMessage']);
  });

  it('一条轮次都没有 ⇒ 条目走分页（空轮次不是「全 full」）', async () => {
    const client = new FakeClient({
      'thread/read': [{ thread: { id: CHILD } }],
      'thread/turns/list': [{ data: [], nextCursor: null }],
      'thread/items/list': [{ data: [], nextCursor: null }],
    });
    const content = await readThreadContent(client, CHILD);
    expect(client.calls.map((one) => one.method)).toEqual(['thread/read', 'thread/turns/list', 'thread/items/list']);
    expect(content?.items).toEqual([]);
  });

  it('线程不存在（应答里没有 thread）⇒ null（不去读轮次）', async () => {
    const client = new FakeClient({ 'thread/read': [{}] });
    await expect(readThreadContent(client, CHILD)).resolves.toBeNull();
    expect(client.calls.map((one) => one.method)).toEqual(['thread/read']);
  });
});
