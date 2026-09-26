// @vitest-environment node
/**
 * 日志抽屉的「读失败 / 读取中 / 有日志」判定（纯函数）。
 *
 * 这个文件守的是一条会被误读的边界：api 的读失败原因**带文件路径**（`读取执行日志失败（…events.jsonl）：…`），
 * 而 `LogView` 的空态文案是「还没有日志 · 这一行还没开始执行」。两者一起出现时，
 * 使用者会把一个真实的故障读成「还没开始跑」——去等一个永远不会开始的执行。
 * 所以有错且无事件时必须整段替换抽屉内容，且这条判定必须能被直接测到。
 */
import { describe, expect, it } from 'vitest';
import { ServiceError, type AgentEvent } from '@aieval/contracts';
import { resolveLogDrawer } from './log-drawer-state';

/** 一条真实形状的 log 事件（只有 seq/at/type 之外还带 stream/text，够用即可） */
function event(seq: number): AgentEvent {
  return { seq, at: '2026-09-22T08:00:00.000Z', type: 'log', stream: 'stdout', text: `第 ${seq} 行` };
}

const readFailure = new ServiceError(
  'INTERNAL',
  '读取执行日志失败（D:\\ws\\run-1\\rows\\row-1\\events.jsonl）：Unexpected token < in JSON at position 0',
);

describe('resolveLogDrawer', () => {
  it('读失败且没有事件 → failed，文案就是 api 的中文原因（含文件路径）', () => {
    const state = resolveLogDrawer({ events: [], logError: readFailure, isLoading: false });

    expect(state.kind).toBe('failed');
    // 路径必须在文案里：只说「读取失败」的话，使用者没有任何下一步可做
    expect(state.kind === 'failed' ? state.message : '').toContain('events.jsonl');
    expect(state.kind === 'failed' ? state.message : '').toContain('读取执行日志失败');
  });

  it('读失败但手上还有事件 → 照旧渲染日志，另给一条非破坏性提示（不把真数据藏起来）', () => {
    const state = resolveLogDrawer({ events: [event(1), event(2)], logError: readFailure, isLoading: false });

    expect(state.kind).toBe('log');
    expect(state.kind === 'log' ? state.events.map((item) => item.seq) : []).toEqual([1, 2]);
    expect(state.kind === 'log' ? state.warning : undefined).toContain('events.jsonl');
  });

  it('首次拉取中（没数据、没错误）→ loading，与「读失败」区分开', () => {
    expect(resolveLogDrawer({ events: [], logError: null, isLoading: true })).toEqual({ kind: 'loading' });
  });

  it('读失败优先于「读取中」：已经在手上的失败不会被一个转圈盖掉', () => {
    // SWR 重验期间 isLoading 仍可能为 true（手上还有上一次的错误）。把错误判定排在 loading 之后，
    // 表现是「抽屉一直转圈」——而真相是上一次已经失败了，转圈会让人一直等下去
    expect(resolveLogDrawer({ events: [], logError: readFailure, isLoading: true }).kind).toBe('failed');
  });

  it('拉完了但一条事件都没有 → log（空数组交给 LogView 说「还没有日志」，那是真的没开始跑）', () => {
    expect(resolveLogDrawer({ events: [], logError: null, isLoading: false })).toEqual({ kind: 'log', events: [] });
  });

  it('非 ServiceError 的失败兜底成一句中文，不透英文内部错误', () => {
    const state = resolveLogDrawer({ events: [], logError: new TypeError('Failed to fetch'), isLoading: false });

    expect(state.kind === 'failed' ? state.message : '').toBe('操作失败，请稍后重试');
  });

  it('**实时通道故障且没有事件 → failed，带上原因**（M2：断流不能只说「还没有日志」）', () => {
    // 场景：`/stream` 建立了但一帧都收不到（C1 的零交付 / 中间层掐断），或环境没有 EventSource。
    // 过去页面只喂 `logError`（这里为 null）⇒ 抽屉回到 `log` 态、渲染 LogView 的空态
    // 「还没有日志 · 这一行还没开始执行」+ 徽标「未连接」——**没有原因、没有出路提示**。
    const state = resolveLogDrawer({
      events: [],
      logError: null,
      streamError: new Error('实时日志连接中断：浏览器会自动重连，已收到的日志不受影响'),
      isLoading: false,
    });

    expect(state.kind).toBe('failed');
    const message = state.kind === 'failed' ? state.message : '';
    expect(message).toContain('实时通道不可用');
    // 原因本身要在（使用者据此判断是网络还是环境不支持）；措辞不能借用「读取失败」
    expect(message).toContain('自动重连');
    expect(message).not.toContain('读取执行日志失败');
  });

  it('实时通道故障但手上还有事件 → 照旧渲染日志，另给一条实时通道提示（不把真数据藏起来）', () => {
    const state = resolveLogDrawer({
      events: [event(1), event(2)],
      logError: null,
      streamError: new Error('当前环境不支持 EventSource：只能查看已落盘的日志，无法实时追加'),
      isLoading: false,
    });

    expect(state.kind).toBe('log');
    expect(state.kind === 'log' ? state.events.map((item) => item.seq) : []).toEqual([1, 2]);
    // 提示位是 liveError 而不是 warning：后者说的是「读文件失败」，两者必须能分开
    expect(state.kind === 'log' ? state.liveError : undefined).toContain('实时通道已断');
    expect(state.kind === 'log' ? state.warning : undefined).toBeUndefined();
  });

  it('两种故障同时存在时不吞任何一条：读失败进 warning、实时通道进 liveError', () => {
    const state = resolveLogDrawer({
      events: [event(1)],
      logError: readFailure,
      streamError: new Error('实时日志连接中断：浏览器会自动重连，已收到的日志不受影响'),
      isLoading: false,
    });

    expect(state.kind === 'log' ? state.warning : undefined).toContain('events.jsonl');
    expect(state.kind === 'log' ? state.liveError : undefined).toContain('实时通道已断');
  });

  it('streamError 为 null/undefined 都不算故障（hook 的初值就是 null）', () => {
    expect(resolveLogDrawer({ events: [], logError: null, streamError: null, isLoading: true })).toEqual({
      kind: 'loading',
    });
    expect(resolveLogDrawer({ events: [], logError: null, streamError: undefined, isLoading: false })).toEqual({
      kind: 'log',
      events: [],
    });
  });
});
