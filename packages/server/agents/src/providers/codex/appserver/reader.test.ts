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

describe('readThreadContent —— 线程内容', () => {
  it('turns 全为 full 时直接取 turn 里的条目，并带上所属轮次', async () => {
    const client = new FakeClient({
      'thread/read': [
        {
          thread: {
            id: CHILD,
            parentThreadId: MAIN,
            turns: [
              {
                id: 'turn-1',
                itemsView: 'full',
                status: 'completed',
                durationMs: 900,
                items: [
                  { type: 'reasoning', id: 'r1', summary: [], content: ['先看仓库结构。'] },
                  { type: 'agentMessage', id: 'm1', text: 'PASS' },
                ],
              },
            ],
          },
        },
      ],
    });
    const content = await readThreadContent(client, CHILD);
    expect(client.calls.map((one) => one.method)).toEqual(['thread/read']);
    expect(content?.thread.turns[0]).toMatchObject({ id: 'turn-1', status: 'completed', durationMs: 900 });
    expect(content?.items).toEqual([
      { turnId: 'turn-1', item: { kind: 'reasoning', id: 'r1', summary: [], content: ['先看仓库结构。'] } },
      { turnId: 'turn-1', item: { kind: 'agentMessage', id: 'm1', text: 'PASS', phase: null } },
    ]);
  });

  it('任一 turn 不是 full ⇒ 改走 thread/items/list 并拼接分页', async () => {
    const client = new FakeClient({
      'thread/read': [
        { thread: { id: CHILD, turns: [{ id: 'turn-1', itemsView: 'summary', items: [{ type: 'agentMessage', id: 'x', text: '摘要' }] }] } },
      ],
      'thread/items/list': [
        { data: [{ turnId: 'turn-1', item: { type: 'agentMessage', id: 'm1', text: '第一页' } }], nextCursor: 'cursor-2' },
        { data: [{ turnId: 'turn-1', item: { type: 'commandExecution', id: 'c1', command: 'ls', status: 'completed' } }], nextCursor: null },
      ],
    });
    const content = await readThreadContent(client, CHILD);
    expect(client.calls.map((one) => one.method)).toEqual(['thread/read', 'thread/items/list', 'thread/items/list']);
    expect(client.calls[2]?.params).toMatchObject({ threadId: CHILD, cursor: 'cursor-2' });
    expect(content?.items.map((one) => one.item.kind)).toEqual(['agentMessage', 'commandExecution']);
  });

  it('线程不存在（应答里没有 thread）⇒ null', async () => {
    const client = new FakeClient({ 'thread/read': [{}] });
    await expect(readThreadContent(client, CHILD)).resolves.toBeNull();
  });
});
