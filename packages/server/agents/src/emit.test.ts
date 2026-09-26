// @vitest-environment node
/**
 * 事件发射：补 seq（run 内自增，从 1）与 at（ISO 8601）；未识别负载必须**逐字段保留**。
 * 第二条是本计划的关键守卫之一：静默丢弃厂商事件等于丢掉「为什么得这个分」的证据。
 */
import type { AgentEvent } from '@aieval/contracts';
import { describe, expect, it } from 'vitest';
import { createEventEmitter, logDraft, safeStringify, unknownEventDraft } from './emit';

describe('createEventEmitter', () => {
  it('seq 从 1 开始、单调递增；at 是 ISO 8601 带时区', () => {
    const seen: AgentEvent[] = [];
    const emitter = createEventEmitter((event) => {
      seen.push(event);
    });
    emitter.emit(logDraft('stdout', 'a'));
    emitter.emit(logDraft('stderr', 'b'));
    expect(seen.map((event) => event.seq)).toEqual([1, 2]);
    expect(seen[0]?.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(seen[1]?.type).toBe('log');
  });

  it('usage 草稿带上 tokens 与 turns（形状与 §7.4 一致）', () => {
    const seen: AgentEvent[] = [];
    const emitter = createEventEmitter((event) => {
      seen.push(event);
    });
    // `timing: null` = 这一次没采到时间（2026-10-XX 新增的那一格）：**这一格必填**，
    // 于是「未采集」只有一种写法，读侧不必再区分「键不存在」与「键是 null」。
    emitter.emit({ type: 'usage', tokens: { input: 10, cached: 2, output: 5 }, timing: null, turns: 1 });
    expect(seen[0]).toMatchObject({
      seq: 1,
      type: 'usage',
      tokens: { input: 10, cached: 2, output: 5 },
      timing: null,
      turns: 1,
    });
  });

  /**
   * 采到时间时**原样带出去**（这一格的全部意义就是这个）：`source` 必须逐字保留——
   * 它是消费方唯一能看出「这个时长能不能与另一家的比」的依据（厂商自报 vs 我们按事件时间戳算）。
   */
  it('usage 草稿带上 timing 时三格与 source 逐字保留', () => {
    const seen: AgentEvent[] = [];
    const emitter = createEventEmitter((event) => {
      seen.push(event);
    });
    emitter.emit({
      type: 'usage',
      tokens: null,
      timing: { totalMs: 166_712, apiMs: 158_753, ttftMs: 7_558, source: 'vendor' },
      turns: 3,
    });
    expect(seen[0]).toMatchObject({
      type: 'usage',
      tokens: null,
      timing: { totalMs: 166_712, apiMs: 158_753, ttftMs: 7_558, source: 'vendor' },
      turns: 3,
    });
  });
});

describe('unknownEventDraft', () => {
  it('未识别负载被投影成保留原始负载的日志事件（逐字段保留，Review Focus #5）', () => {
    const payload = { type: 'mystery', nested: { a: [1, 2, 3] }, count: 7 };
    const draft = unknownEventDraft(payload);
    expect(draft).toMatchObject({ type: 'log', stream: 'stdout' });
    const text = draft.type === 'log' ? draft.text : '';
    expect(JSON.parse(text)).toEqual(payload);
  });
});

describe('safeStringify', () => {
  it('循环引用与 BigInt 都不抛（日志器不该有能力打断业务流程）', () => {
    const circular: Record<string, unknown> = { name: 'c' };
    circular.self = circular;
    expect(() => safeStringify(circular)).not.toThrow();
    expect(safeStringify(circular)).toContain('self');
    expect(() => safeStringify({ big: 1n })).not.toThrow();
    expect(safeStringify(undefined)).toBe('undefined');
  });
});
