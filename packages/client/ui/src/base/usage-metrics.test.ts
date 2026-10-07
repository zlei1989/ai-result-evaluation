// @vitest-environment node
/**
 * 用量文案（2026-10-07）：千分位、token 单位、三元组的排列。
 * 派生指标（2026-10-XX）：命中率、生成速率、时间来源标注。
 *
 * 这些函数存在的唯一理由是**跨三家、跨四张面只有一份实现**（见 `usage-metrics.ts` 的文件头）。
 * 因此这里钉的不是「某一家算得对」，而是三条**通用性质**：
 *   ① 采不到就是 `null` / 「未采集」，绝不返回 `0` / `NaN` / `Infinity`（`0 tok/s` 与「没采到」含义相反）；
 *   ② 真实的 0 照常给数（`output: 0` 的速率是 `0.0`、计数是 `0 tok`——那是真的没产出）；
 *   ③ 两种来源的时长都必须能被标出来（`'vendor'` 纯模型时间 vs `'events'` 含工具执行的墙钟），
 *      因为 tok/s 的分子相同、分母口径不同 ⇒ 不标就会被人放进同一张对比表。
 *
 * 跑在 **node** 环境（`@vitest-environment node`）是**刻意的**：这几个函数是纯的，
 * 里程碑（`build-model.ts`）与台账行（`log-format.ts`）也都没有 React 依赖——
 * 一旦有人把它们挪回 `metric-line.tsx`（`.tsx`、带 antd），这两条进口就都得把 React 拖进来。
 */
import type { UsageTiming } from '@aieval/contracts';
import { describe, expect, it } from 'vitest';
import {
  formatCount,
  formatGenerationRate,
  formatTokens,
  formatUsageTriple,
  generationWindowMs,
  timingSourceLabel,
} from './usage-metrics';

/** 造一份时间数据；缺省 = 三个数都没有（与「厂商一个都没报」同形） */
function timing(overrides: Partial<UsageTiming> = {}): UsageTiming {
  return { totalMs: null, apiMs: null, ttftMs: null, source: 'events', ...overrides };
}

describe('formatCount', () => {
  it('按千分位分组', () => {
    expect(formatCount(128_450)).toBe('128,450');
    expect(formatCount(0)).toBe('0');
  });
});

describe('formatTokens', () => {
  /**
   * 2026-10-07 用户口径：**数字后面加 `tok` 后缀**（`0,000 tok` 那种形态）。
   * 判据是「这个数是不是 token 计数」，故这里同时钉住**不是** token 的两类不走它：
   * 命中率与生成速率在各自的用例里（`缓存命中 98%` / `生成 3.6 tok/s`）——它们各有各的单位。
   */
  it('千分位 + ` tok` 后缀；真实的 0 也带单位（`0 tok` 不是「没采到」）', () => {
    expect(formatTokens(15_763)).toBe('15,763 tok');
    expect(formatTokens(0)).toBe('0 tok');
    expect(formatTokens(500_864)).toBe('500,864 tok');
  });
});

describe('formatUsageTriple', () => {
  /**
   * 四张面（事实条 / 里程碑 / 逐条页脚 / 子任务卡片）共用这一份文案：
   * 「输入 15,763 tok · 缓存 45,824 tok · 输出 2,164 tok」。
   * 标签与三项的次序是**读者建立映射的依据**（哪一对是哪个数），故逐字钉住。
   */
  it('三项各带单位、次序固定（输入 / 缓存 / 输出）', () => {
    expect(formatUsageTriple({ input: 15_763, cached: 45_824, output: 2_164 }))
      .toBe('输入 15,763 tok · 缓存 45,824 tok · 输出 2,164 tok');
  });

  it('三项全 0 时三个 `0 tok` 照写（真实的 0 与「没采到」在这一层分开：`null` 由调用方拦）', () => {
    expect(formatUsageTriple({ input: 0, cached: 0, output: 0 })).toBe('输入 0 tok · 缓存 0 tok · 输出 0 tok');
  });
});

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
