// @vitest-environment node
/**
 * SSE 帧产出：回放历史 → 接进程内事件总线 → 终态关流。
 * 帧格式是本文件最硬的断言对象：`id` 缺了浏览器就无法按 Last-Event-ID 续订；
 * `data` 里出现裸换行会把一帧劈成两帧，所以断言的是逐行的精确文本。
 *
 * `subscribeRowEvents` 由本文件自己实现（vi.mock 的工厂里维护一张监听表），
 * 于是「总线推一条事件 → 流里出现一帧」这条链路可以在不启动任何编排的情况下被验证。
 */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ServiceError, type AgentEvent, type EvalRun } from '@aieval/contracts';
import { appendEvent, setCasesRootForTesting, setConfigDirForTesting } from '@aieval/core';
import { getRun as getRunSnapshot } from '@aieval/evaluator';
import { streamRowEvents } from './run-stream';
import { updateSettings } from './settings';
import { makeCase, makeRow, makeRun, seedConfig } from './testing/run-fixtures';
import { removeTreeWithRetry } from './testing/cleanup';

/** 本文件挂上去的总线监听（key = `${runId}/${rowId}`） */
const listeners = new Map<string, Array<(event: AgentEvent) => void>>();
/**
 * **评分那条事件流**的监听表：与候选那张**刻意分开**——共用一个 Map 的话，
 * 「评分事件不投给执行日志的订阅者」这条不变量在这个替身里会假绿。
 */
const judgeListeners = new Map<string, Array<(event: AgentEvent) => void>>();

vi.mock('@aieval/evaluator', () => ({
  listRuns: vi.fn(),
  getRun: vi.fn(),
  saveRun: vi.fn(),
  startRun: vi.fn(),
  abortRun: vi.fn(),
  abortRow: vi.fn(),
  subscribeRowEvents: vi.fn((runId: string, rowId: string, listener: (event: AgentEvent) => void) => {
    const key = `${runId}/${rowId}`;
    const bucket = listeners.get(key) ?? [];
    bucket.push(listener);
    listeners.set(key, bucket);
    return () => {
      const current = listeners.get(key) ?? [];
      listeners.set(key, current.filter((item) => item !== listener));
    };
  }),
  subscribeJudgeEvents: vi.fn((runId: string, rowId: string, listener: (event: AgentEvent) => void) => {
    const key = `${runId}/${rowId}`;
    const bucket = judgeListeners.get(key) ?? [];
    bucket.push(listener);
    judgeListeners.set(key, bucket);
    return () => {
      const current = judgeListeners.get(key) ?? [];
      judgeListeners.set(key, current.filter((item) => item !== listener));
    };
  }),
}));

let dir: string;
let workspaceRoot: string;
let store: Map<string, EvalRun>;

/** 往该行的事件日志里追加一条事件（写真实文件，走 core 的 seq 分配） */
function append(runId: string, rowId: string, event: Parameters<typeof appendEvent>[1]): AgentEvent {
  const rowDir = join(workspaceRoot, runId, 'rows', rowId);
  mkdirSync(rowDir, { recursive: true });
  return appendEvent(join(rowDir, 'events.jsonl'), event);
}

/** 读到流结束（适用于「回放里已有终态」的用例；不会挂住） */
async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  return await new Response(stream).text();
}

/**
 * 抓同步抛出的 `ServiceError`：用例要断言**错误码与逐字文案**，`toThrowError` 拿不到对象。
 * 不抛或抛的不是 `ServiceError` 都算失败（原样重抛，报告里能看到真正抛了什么）。
 */
function captureThrow(action: () => unknown): ServiceError {
  try {
    action();
  } catch (error) {
    if (error instanceof ServiceError) return error;
    throw error;
  }
  throw new Error('预期同步抛错，但调用正常返回了');
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aieval-stream-'));
  setConfigDirForTesting(dir);
  // 用例目录也要指到临时目录：用例是一文件一落（core 的 `case-store`），config 目录的 override 管不到它
  setCasesRootForTesting(join(dir, 'cases'));
  workspaceRoot = join(dir, 'ws');
  updateSettings({ workspaceRoot });
  seedConfig({ cases: [makeCase()] });
  listeners.clear();

  store = new Map();
  vi.mocked(getRunSnapshot).mockImplementation((runId: string) => {
    const run = store.get(runId);
    if (run === undefined) throw new ServiceError('NOT_FOUND', `评测不存在：${runId}`);
    return run;
  });
});

afterEach(() => {
  vi.useRealTimers();
  setConfigDirForTesting(null);
  setCasesRootForTesting(null);
  removeTreeWithRetry(dir);
});

describe('streamRowEvents', () => {
  it('按 id/event/data + 空行 的帧格式回放历史，遇到终态事件后立即关流', async () => {
    store.set('run-1', makeRun({ id: 'run-1', workspaceBase: workspaceRoot, rows: [makeRow({ id: 'r-1' })] }));
    const first = append('run-1', 'r-1', { type: 'log', stream: 'stdout', text: '第一行' });
    const end = append('run-1', 'r-1', { type: 'end', exitReason: 'completed' });

    const text = await readAll(streamRowEvents('run-1', 'r-1', 0));

    const lines = text.split('\n');
    // 首块是 ready 注释帧（打开即有首字节）：两行，客户端按 SSE 规范忽略它
    expect(lines[0]).toBe(': ready');
    expect(lines[1]).toBe('');
    expect(lines[2]).toBe(`id: ${first.seq}`);
    expect(lines[3]).toBe('event: log');
    expect(lines[4]).toBe(`data: ${JSON.stringify(first)}`);
    expect(lines[5]).toBe('');
    expect(lines[6]).toBe(`id: ${end.seq}`);
    expect(lines[7]).toBe('event: end');
    expect(lines[8]).toBe(`data: ${JSON.stringify(end)}`);
    expect(lines[9]).toBe('');
    // 终态之后不再有心跳：流必须已经关闭（`Response.text()` 能返回就是证据）
    expect(lines[10]).toBe('');
    // 历史里已有终态 ⇒ 这一轮**不订阅**总线（订阅了就再也没人退订/关流，长驻服务里越积越多）
    expect(listeners.get('run-1/r-1')).toBeUndefined();
  });

  it('终态的 status 事件同样关流（不必等到 end）', async () => {
    store.set('run-1', makeRun({ id: 'run-1', workspaceBase: workspaceRoot, rows: [makeRow({ id: 'r-1' })] }));
    append('run-1', 'r-1', { type: 'status', status: 'canceled' });

    const text = await readAll(streamRowEvents('run-1', 'r-1', 0));

    expect(text).toContain('event: status');
    expect(text.endsWith('\n\n')).toBe(true);
  });

  it('afterSeq 只回放 seq 更大的部分', async () => {
    store.set('run-1', makeRun({ id: 'run-1', workspaceBase: workspaceRoot, rows: [makeRow({ id: 'r-1' })] }));
    append('run-1', 'r-1', { type: 'log', stream: 'stdout', text: '旧' });
    const second = append('run-1', 'r-1', { type: 'end', exitReason: 'completed' });

    const text = await readAll(streamRowEvents('run-1', 'r-1', 1));

    expect(text).not.toContain('"text":"旧"');
    expect(text).toContain(`id: ${second.seq}`);
  });

  it('未终止的行：历史回放完后挂上总线，新事件即时成帧', async () => {
    store.set('run-1', makeRun({ id: 'run-1', workspaceBase: workspaceRoot, rows: [makeRow({ id: 'r-1' })] }));
    append('run-1', 'r-1', { type: 'status', status: 'running' });

    const stream = streamRowEvents('run-1', 'r-1', 0);
    const reader = stream.getReader();
    const decoder = new TextDecoder();

    // 首块是 ready 注释帧（打开即有首字节），历史回放在它之后
    expect(decoder.decode((await reader.read()).value)).toBe(': ready\n\n');
    const replayed = await reader.read();
    expect(decoder.decode(replayed.value)).toContain('event: status');

    // 总线推一条：流里应出现对应帧（不再是轮询，而是推送）
    const pushed = append('run-1', 'r-1', { type: 'log', stream: 'stderr', text: '来自总线' });
    for (const listener of listeners.get('run-1/r-1') ?? []) listener(pushed);
    const next = await reader.read();
    expect(decoder.decode(next.value)).toBe(`id: ${pushed.seq}\nevent: log\ndata: ${JSON.stringify(pushed)}\n\n`);

    // 终态帧之后流关闭
    const end = append('run-1', 'r-1', { type: 'end', exitReason: 'completed' });
    for (const listener of listeners.get('run-1/r-1') ?? []) listener(end);
    const last = await reader.read();
    expect(decoder.decode(last.value)).toContain('event: end');
    expect((await reader.read()).done).toBe(true);
  });

  it('总线推来一条「已经发出过的 seq」时不再成帧（历史与实时按 seq 去重）', async () => {
    // 服务侧不主动制造重复帧：重号事件会让浏览器按 Last-Event-ID 续订时把新事件去重丢掉
    // 这里让总线把回放过的那一条原样再推一次。
    store.set('run-1', makeRun({ id: 'run-1', workspaceBase: workspaceRoot, rows: [makeRow({ id: 'r-1' })] }));
    const replayed = append('run-1', 'r-1', { type: 'status', status: 'running' });

    const stream = streamRowEvents('run-1', 'r-1', 0);
    const reader = stream.getReader();
    const decoder = new TextDecoder();

    expect(decoder.decode((await reader.read()).value)).toBe(': ready\n\n');
    expect(decoder.decode((await reader.read()).value)).toContain(`id: ${replayed.seq}`);

    for (const listener of listeners.get('run-1/r-1') ?? []) listener(replayed);
    const fresh = append('run-1', 'r-1', { type: 'log', stream: 'stdout', text: '新的' });
    for (const listener of listeners.get('run-1/r-1') ?? []) listener(fresh);

    // 下一帧必须是新事件：重复的 status 帧若被发出去，这里会拿到它
    const next = await reader.read();
    expect(decoder.decode(next.value)).toBe(`id: ${fresh.seq}\nevent: log\ndata: ${JSON.stringify(fresh)}\n\n`);

    await reader.cancel();
  });

  it('客户端取消时退订总线（否则事件会一直往没人读的流里塞）', async () => {
    store.set('run-1', makeRun({ id: 'run-1', workspaceBase: workspaceRoot, rows: [makeRow({ id: 'r-1' })] }));
    append('run-1', 'r-1', { type: 'status', status: 'running' });

    const stream = streamRowEvents('run-1', 'r-1', 0);
    const reader = stream.getReader();
    await reader.read();
    expect(listeners.get('run-1/r-1')).toHaveLength(1);

    await reader.cancel();

    expect(listeners.get('run-1/r-1')).toHaveLength(0);
  });

  it('无历史可回放时先发一条保活注释帧，取消后定时器清零', async () => {
    // 反向代理与浏览器都会掐掉长时间静默的连接：注释帧是 SSE 的标准保活手段
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    store.set('run-1', makeRun({ id: 'run-1', workspaceBase: workspaceRoot, rows: [makeRow({ id: 'r-1' })] }));
    append('run-1', 'r-1', { type: 'status', status: 'running' });

    const stream = streamRowEvents('run-1', 'r-1', 5);
    const reader = stream.getReader();
    const decoder = new TextDecoder();

    // 先摘掉 ready 帧（打开即有首字节）：保活是**之后**那一条
    expect(decoder.decode((await reader.read()).value)).toBe(': ready\n\n');

    vi.advanceTimersByTime(15_000);
    const beat = await reader.read();
    expect(decoder.decode(beat.value)).toBe(': keep-alive\n\n');

    await reader.cancel();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('打开即有首字节：不等 15s 心跳就发一条 ready 注释帧', async () => {
    // 为什么这条重要：SSE 的响应头要等第一次 `controller.enqueue` 才 flush ⇒ 空历史 + 无新事件时
    // 浏览器迟迟不触发 `onopen`，徽标停在「未连接」，代理也可能把空连接当空闲回收。
    // 用假定时器把时间钉住：**一次都不推进时钟**，首块必须已经拿到——没有 ready 帧时这里挂住。
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    store.set('run-1', makeRun({ id: 'run-1', workspaceBase: workspaceRoot, rows: [makeRow({ id: 'r-1' })] }));
    append('run-1', 'r-1', { type: 'status', status: 'running' });

    const stream = streamRowEvents('run-1', 'r-1', 5);
    const reader = stream.getReader();
    const decoder = new TextDecoder();

    const first = await reader.read();
    expect(decoder.decode(first.value)).toBe(': ready\n\n');

    await reader.cancel();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('轮或行不存在时**同步**抛错：这样路由能回 404 JSON，而不是开一个立刻结束的流', () => {
    store.set('run-1', makeRun({ id: 'run-1', workspaceBase: workspaceRoot, rows: [makeRow({ id: 'r-1' })] }));

    const missingRun = captureThrow(() => streamRowEvents('nope', 'r-1', 0));
    expect(missingRun.code).toBe('NOT_FOUND');

    // 「行不存在」的校验只有一份（run-artifacts 的 findRow）：这里连同错误码与**逐字文案**一起钉住，
    // 删掉那一份（或把它挪进流里变成异步）都会当场红
    const missingRow = captureThrow(() => streamRowEvents('run-1', 'r-x', 0));
    expect(missingRow.code).toBe('NOT_FOUND');
    expect(missingRow.message).toBe('该评测里没有这一行（r-x）');
  });
});
