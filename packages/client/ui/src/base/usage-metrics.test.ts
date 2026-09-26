// @vitest-environment node
/**
 * 派生指标（2026-10-XX）：命中率、生成速率、时间来源标注。
 *
 * 这些函数存在的唯一理由是**跨三家只有一份公式**（见 `usage-metrics.ts` 的文件头）。
 * 因此这里钉的不是「某一家算得对」，而是三条**通用性质**：
 *   ① 采不到就是 `null` / 「未采集」，绝不返回 `0` / `NaN` / `Infinity`（`0 tok/s` 与「没采到」含义相反）；
 *   ② 真实的 0 照常给数（`output: 0` 的速率是 `0.0`——那是真的没产出）；
 *   ③ 两种来源的时长都必须能被标出来（`'vendor'` 纯模型时间 vs `'events'` 含工具执行的墙钟），
 *      因为 tok/s 的分子相同、分母口径不同 ⇒ 不标就会被人放进同一张对比表。
 */
import type { UsageTiming } from '@aieval/contracts';
import { describe, expect, it } from 'vitest';
import { formatGenerationRate, generationWindowMs, timingSourceLabel } from './usage-metrics';

/** 造一份时间数据；缺省 = 三个数都没有（与「厂商一个都没报」同形） */
function timing(overrides: Partial<UsageTiming> = {}): UsageTiming {
  return { totalMs: null, apiMs: null, ttftMs: null, source: 'events', ...overrides };
}

describe('generationWindowMs', () => {
  it('三个时间都有时用 apiMs − ttftMs（首字之前那段不算生成）', () => {
    expect(generationWindowMs(timing({ totalMs: 166_712, apiMs: 60_000, ttftMs: 5_000, source: 'vendor' }))).toBe(55_000);
  });

  it('缺 apiMs / ttftMs 时退化成 totalMs（另两家只有这一个数）', () => {
    expect(generationWindowMs(timing({ totalMs: 30_000 }))).toBe(30_000);
    // 只有 ttft 没有 api：**不**拿 ttft 当分母（那是首字延迟，不是生成时长）⇒ 退回 totalMs
    expect(generationWindowMs(timing({ totalMs: 30_000, ttftMs: 5_000 }))).toBe(30_000);
  });

  it('差值 ≤ 0（脏数据 / 极短轮次）时不产出一个负分母，退回 totalMs；两个都不行就是 null', () => {
    expect(generationWindowMs(timing({ totalMs: 30_000, apiMs: 5_000, ttftMs: 5_000 }))).toBe(30_000);
    expect(generationWindowMs(timing({ totalMs: 30_000, apiMs: 4_000, ttftMs: 5_000 }))).toBe(30_000);
    // 分母为 0 会把速率算成 Infinity ⇒ 这里是 null（「算不出来」），由调用方说「未采集」
    expect(generationWindowMs(timing({ totalMs: 0 }))).toBeNull();
    expect(generationWindowMs(timing())).toBeNull();
  });
});

describe('formatGenerationRate', () => {
  it('保留一位小数；分母用「纯生成」那段（apiMs − ttftMs）', () => {
    // 200 / 55 = 3.636… → 3.6
    expect(formatGenerationRate({ output: 200 }, timing({ apiMs: 60_000, ttftMs: 5_000, totalMs: 166_712, source: 'vendor' })))
      .toBe('3.6');
  });

  it('采不到时间 / 没有用量 / 分母为 0 一律 null（界面据此说「未采集」）', () => {
    expect(formatGenerationRate({ output: 200 }, null)).toBeNull();
    expect(formatGenerationRate({ output: 200 }, undefined)).toBeNull();
    expect(formatGenerationRate({ output: 200 }, timing())).toBeNull();
    expect(formatGenerationRate(null, timing({ totalMs: 1_000 }))).toBeNull();
    expect(formatGenerationRate({ output: 200 }, timing({ totalMs: 0 }))).toBeNull();
  });

  it('真实的 0 产出给 0.0（不是「未采集」）——与 null ≠ 0 同一条口径', () => {
    expect(formatGenerationRate({ output: 0 }, timing({ totalMs: 1_000 }))).toBe('0.0');
  });

  it('脏值（负 output / 非有限数）不给 NaN，按「采不到」处理', () => {
    expect(formatGenerationRate({ output: -1 }, timing({ totalMs: 1_000 }))).toBeNull();
    expect(formatGenerationRate({ output: Number.NaN }, timing({ totalMs: 1_000 }))).toBeNull();
    expect(formatGenerationRate({ output: 10 }, timing({ totalMs: Number.NaN }))).toBeNull();
  });
});

describe('timingSourceLabel', () => {
  it('两种来源的文字必须分得开（一个纯模型时间、一个含工具执行的墙钟）', () => {
    expect(timingSourceLabel('vendor')).toContain('厂商自报');
    expect(timingSourceLabel('vendor')).toContain('不含工具执行');
    expect(timingSourceLabel('events')).toContain('事件时间戳');
    expect(timingSourceLabel('events')).toContain('含工具执行');
    expect(timingSourceLabel('vendor')).not.toBe(timingSourceLabel('events'));
  });
});
