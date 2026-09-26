/**
 * MetricLine：计量摘要。**本文件是「null 不是 0」这条口径的主守卫**（spec §5.6.3）。
 * 两个方向都要钉住：
 *   · `null`（没采到 / 采集不到）→ 显示「未采集」或「不支持计量」，**不得出现 0**；
 *   · 真实的 `0`（例如 0 轮）→ 照常显示 0，不得被当成「没采到」吃掉。
 * 只钉一个方向的守卫是没用的：把 null 渲染成 0 与把 0 渲染成「未采集」都会让使用者读错。
 */
import { describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { MetricLine, formatCacheHitRate, formatCount, formatDuration } from './metric-line';

/** 最小可用的 ScoreResult：只用到 totalScore（逐项判定与满分是必填，故各给一个空表 / 上界） */
const score = {
  judgments: [],
  totalScore: 87,
  maxScore: 100,
  verdict: '整体可用',
  raw: '{}',
  judgeProviderId: 'p-1',
  judgeModelId: 'claude-opus-4-6',
  judgedAt: '2026-09-22T08:10:00.000Z',
  judgeAgentKind: null,
  // 契约里这是必填输出字段：false ⇔ 这一分只靠提示词契约拿到（本夹具不涉及 schema 通路）
  structuredOutput: false,
};

describe('MetricLine', () => {
  it('计量为 null 时显示「未采集」，绝不显示成 0', () => {
    render(<MetricLine tokens={null} turns={null} durationMs={null} score={null} />);

    expect(screen.getByText('tok 未采集')).toBeInTheDocument();
    expect(screen.getByText('轮次 未采集')).toBeInTheDocument();
    expect(screen.getByText('耗时 未采集')).toBeInTheDocument();
    expect(screen.getByText('得分 未评分')).toBeInTheDocument();
    // 这一行是变异验证的靶子：把 null 当 0 渲染的实现会在这里失败
    expect(screen.queryByText('tok 0')).toBeNull();
    expect(screen.queryByText('轮次 0')).toBeNull();
  });

  it('该智能体不支持计量时文案是「不支持计量」，与「未采集」区分开', () => {
    render(<MetricLine tokens={null} turns={5} durationMs={1000} score={null} usageUnsupported />);

    expect(screen.getByText('tok 不支持计量')).toBeInTheDocument();
    expect(screen.queryByText('tok 未采集')).toBeNull();
  });

  it('真实的 0 照常显示成 0（0 轮不是「没采到」）', () => {
    render(<MetricLine tokens={{ input: 0, cached: 0, output: 0 }} turns={0} durationMs={0} score={score} />);

    expect(screen.getByText('tok 0')).toBeInTheDocument();
    expect(screen.getByText('轮次 0')).toBeInTheDocument();
    expect(screen.getByText('耗时 0s')).toBeInTheDocument();
    expect(screen.getByText('得分 87')).toBeInTheDocument();
  });

  it('token 只累加输入与输出（缓存读是输入的一部分，加进去会重复计数）', () => {
    render(<MetricLine tokens={{ input: 1000, cached: 200, output: 500 }} turns={3} durationMs={1000} score={null} />);

    // 1,000 + 500 = 1,500：+200 的缓存读不得被算进来
    expect(screen.getByText('tok 1,500')).toBeInTheDocument();
  });

  it('tok 之后显示「缓存命中」：缓存读 / 总输入，四舍五入成整数百分比', () => {
    // dsh 的真实刻度（p3 探测）：输入 218（未命中）+ 缓存读 8,832 ⇒ 8,832 / 9,050 = 97.59% → 98%
    render(<MetricLine tokens={{ input: 218, cached: 8832, output: 2 }} turns={1} durationMs={1000} score={null} />);

    expect(screen.getByText('缓存命中 98%')).toBeInTheDocument();
    // 命中率是**附加**的一项，tok 的口径不变（仍只加输入 + 输出）
    expect(screen.getByText('tok 220')).toBeInTheDocument();
  });

  it('计量为 null 时缓存命中显示「未采集」，绝不显示成 0%', () => {
    render(<MetricLine tokens={null} turns={null} durationMs={null} score={null} />);

    expect(screen.getByText('缓存命中 未采集')).toBeInTheDocument();
    // 这一行是变异验证的靶子：把「没采到」当 0% 渲染的实现会在这里失败
    expect(screen.queryByText('缓存命中 0%')).toBeNull();
  });

  it('该智能体不支持计量时缓存命中文案是「不支持计量」，与「未采集」区分开', () => {
    render(<MetricLine tokens={null} turns={5} durationMs={1000} score={null} usageUnsupported />);

    expect(screen.getByText('缓存命中 不支持计量')).toBeInTheDocument();
    expect(screen.queryByText('缓存命中 未采集')).toBeNull();
  });

  it('总输入为 0 时缓存命中是 0%（真实的 0，不是「没采到」）', () => {
    // 本条不涉及得分，`score` 传 null：不复用上面那个 `score` 夹具（它与本用例无关）
    render(<MetricLine tokens={{ input: 0, cached: 0, output: 0 }} turns={0} durationMs={0} score={null} />);

    expect(screen.getByText('缓存命中 0%')).toBeInTheDocument();
    expect(screen.queryByText('缓存命中 未采集')).toBeNull();
  });
});

describe('formatCacheHitRate', () => {
  it.each([
    // 全命中 / 全未命中：两端都必须是干净的 0% / 100%
    [{ input: 0, cached: 500 }, '100%'],
    [{ input: 500, cached: 0 }, '0%'],
    // 四舍五入（不是截断）：33.33% → 33%，66.67% → 67%
    [{ input: 2, cached: 1 }, '33%'],
    [{ input: 1, cached: 2 }, '67%'],
    // 边界：99.5% 进位到 100%
    [{ input: 1, cached: 199 }, '100%'],
    // 分母为 0（没有输入）：不给 NaN
    [{ input: 0, cached: 0 }, '0%'],
    // 脏值（负 / 非有限）：按 0% 处理，界面不出现 NaN
    [{ input: -5, cached: 10 }, '0%'],
    [{ input: Number.NaN, cached: 10 }, '0%'],
    /**
     * **归一之后命中率在数学上不可能超过 100%**：分母 `input + cached` 里本来就含分子
     * `cached` ⇒ `cached > total` 无法成立（这条用例把那个事实钉成断言，防止有人「顺手」
     * 把分母改成只除 `input`——真那样改动的话，这一格会算出 400%）。
     */
    [{ input: 1, cached: 4 }, '80%'],
  ])('%o → %s', (tokens, expected) => {
    expect(formatCacheHitRate(tokens)).toBe(expected);
  });
});

describe('formatDuration', () => {
  it.each([
    [0, '0s'],
    [-5, '0s'],
    [Number.NaN, '0s'],
    [45_000, '45s'],
    [383_000, '6m23s'],
    [3_600_000, '1h00m'],
    [3_930_000, '1h05m'],
  ])('%i ms → %s', (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected);
  });
});

describe('formatCount', () => {
  it('按千分位分组', () => {
    expect(formatCount(128_450)).toBe('128,450');
    expect(formatCount(0)).toBe('0');
  });
});

/**
 * 跑动期的实时展示（用户口径，2026-09-26）。
 *
 * 三条口径：
 *   ① 行还在跑、适配器又还没上报时，文案是**「采集中」**而不是「未采集」——「未采集」是终态的结论
 *      （这一行结束了也没采到），两者混在一起会让人以为采集坏了；
 *   ② 实时值（来自事件流的叠加层）在**跑动期**填进这几格；真实值/实时值都仍然遵守 `null ≠ 0`；
 *   ③ 耗时在跑动期用**行自己的开始时刻**本地走秒表；行一进终态，叠加层整体失效、显示快照里的权威值
 *      （否则结算值会被一个还在涨的秒表顶掉）。
 */
describe('MetricLine：运行中的实时展示', () => {
  const START_AT = '2026-09-22T08:00:00.000Z';

  it('运行中还没上报：文案是「采集中」而不是「未采集」，且绝不显示 0', () => {
    render(<MetricLine tokens={null} turns={null} durationMs={null} score={null} running live={{ startedAtMs: null, tokens: null, turns: null, candidateEnded: false, candidateEndedAtMs: null }} />);

    expect(screen.getByText('tok 采集中')).toBeInTheDocument();
    expect(screen.getByText('缓存命中 采集中')).toBeInTheDocument();
    expect(screen.getByText('轮次 采集中')).toBeInTheDocument();
    expect(screen.getByText('耗时 采集中')).toBeInTheDocument();
    // 得分这一格与采集无关：评分在 agent 跑完之后才发生，始终是「未评分」
    expect(screen.getByText('得分 未评分')).toBeInTheDocument();
    expect(screen.queryByText('tok 未采集')).toBeNull();
    expect(screen.queryByText('tok 0')).toBeNull();
    expect(screen.queryByText('轮次 0')).toBeNull();
  });

  it('运行中收到实时计量：tok / 缓存命中 / 轮次都跟着实时值（不用等行结束）', () => {
    render(
      <MetricLine
        tokens={null}
        turns={null}
        durationMs={null}
        score={null}
        running
        live={{ startedAtMs: null, tokens: { input: 1000, cached: 3000, output: 500 }, turns: 7, candidateEnded: false, candidateEndedAtMs: null }}
      />,
    );

    expect(screen.getByText('tok 1,500')).toBeInTheDocument();
    expect(screen.getByText('缓存命中 75%')).toBeInTheDocument();
    expect(screen.getByText('轮次 7')).toBeInTheDocument();
  });

  it('运行中的耗时按行自己的开始时刻每秒递增', () => {
    vi.useFakeTimers({ now: new Date(START_AT) });
    try {
      render(
        <MetricLine
          tokens={null}
          turns={null}
          durationMs={null}
          score={null}
          running
          live={{ startedAtMs: Date.parse(START_AT), tokens: null, turns: null, candidateEnded: false, candidateEndedAtMs: null }}
        />,
      );

      expect(screen.getByText('耗时 0s')).toBeInTheDocument();
      act(() => vi.advanceTimersByTime(5_000));
      expect(screen.getByText('耗时 5s')).toBeInTheDocument();
      act(() => vi.advanceTimersByTime(60_000));
      expect(screen.getByText('耗时 1m05s')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('行一进终态，实时叠加层整体失效：显示快照里的权威值（耗时不能继续涨）', () => {
    vi.useFakeTimers({ now: new Date(START_AT) });
    try {
      render(
        <MetricLine
          tokens={{ input: 10, cached: 0, output: 20 }}
          turns={1}
          durationMs={4_000}
          score={null}
          // 还在传实时值，但这一行已经不是运行态了
          live={{ startedAtMs: Date.parse(START_AT), tokens: { input: 999, cached: 0, output: 999 }, turns: 99, candidateEnded: false, candidateEndedAtMs: null }}
        />,
      );

      expect(screen.getByText('tok 30')).toBeInTheDocument();
      expect(screen.getByText('轮次 1')).toBeInTheDocument();
      expect(screen.getByText('耗时 4s')).toBeInTheDocument();
      act(() => vi.advanceTimersByTime(30_000));
      // 秒表必须停了：终态的耗时是结算值，不会随时间长大
      expect(screen.getByText('耗时 4s')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('不支持计量的智能体在运行中也说「不支持计量」（不被「采集中」盖掉）', () => {
    render(<MetricLine tokens={null} turns={null} durationMs={null} score={null} running usageUnsupported />);

    expect(screen.getByText('tok 不支持计量')).toBeInTheDocument();
    expect(screen.getByText('缓存命中 不支持计量')).toBeInTheDocument();
    expect(screen.queryByText('tok 采集中')).toBeNull();
  });
});

/**
 * **评分阶段的计量冻结**（用户口径，2026-09-29：「只展示执行的 tok 和 轮次，评分不应该覆盖此信息」）。
 *
 * 评分智能体跑在候选同一个工作区里，事件也进同一行同一条流（`judgeRowByAgent` 转发适配器事件），
 * 所以 `status: judging` 之后推来的 `usage` 报的是**评审者**的用量（轮次从 1 重新数）。
 * 真机实测（run `bea0564d` 的 codex 行）：候选 `490,906 tok / 28 轮 / 58s`，评分期间卡片上却是
 * `tok 13,715 / 缓存命中 45% / 轮次 2 / 耗时 2m28s`——全是评审者的数与整行墙钟。
 *
 * 叠加层带 `candidateEnded` 时这几格冻结：tok / 缓存命中 / 轮次用候选最后一次上报，
 * 秒表停在候选结束那一刻（与快照 `durationMs` 同口径：只算候选那一段），没采到时说「未采集」
 * 而不是「采集中」。三条口径各自的靶子：① 冻结值照常显示；② 秒表停住；③ 措辞不是「采集中」。
 */
describe('MetricLine：评分阶段的计量冻结', () => {
  const START_AT = '2026-09-22T08:02:30.710Z';
  /** 候选跑了 1 分钟整（08:02:30 → 08:03:30） */
  const JUDGE_AT = '2026-09-22T08:03:30.710Z';
  /** 候选收尾那一条上报（实测值） */
  const CANDIDATE_TOKENS = { input: 483_723, cached: 455_552, output: 7_183 };

  it('冻结后显示**候选**的 tok / 缓存命中 / 轮次，耗时停在候选结束那一刻', () => {
    render(
      <MetricLine
        // 快照这几格是空的（评分不回写它们）：显示的值只可能来自冻结的叠加层
        tokens={null}
        turns={null}
        durationMs={null}
        score={null}
        running
        live={{
          startedAtMs: Date.parse(START_AT),
          tokens: CANDIDATE_TOKENS,
          turns: 28,
          candidateEnded: true,
          candidateEndedAtMs: Date.parse(JUDGE_AT),
        }}
      />,
    );

    // 490,906 = 483,723 + 7,183（缓存读不进 tok）；49% = 455,552 / 939,275（四舍五入）
    expect(screen.getByText('tok 490,906')).toBeInTheDocument();
    expect(screen.getByText('缓存命中 49%')).toBeInTheDocument();
    expect(screen.getByText('轮次 28')).toBeInTheDocument();
    expect(screen.getByText('耗时 1m00s')).toBeInTheDocument();
    expect(screen.getByText('得分 未评分')).toBeInTheDocument();
  });

  it('冻结后秒表停住：评分阶段还要跑几分钟，但「耗时」比的是候选那一段', () => {
    vi.useFakeTimers({ now: new Date(JUDGE_AT) });
    try {
      render(
        <MetricLine
          tokens={null}
          turns={null}
          durationMs={null}
          score={null}
          running
          live={{
            startedAtMs: Date.parse(START_AT),
            tokens: CANDIDATE_TOKENS,
            turns: 28,
            candidateEnded: true,
            candidateEndedAtMs: Date.parse(JUDGE_AT),
          }}
        />,
      );

      expect(screen.getByText('耗时 1m00s')).toBeInTheDocument();
      act(() => vi.advanceTimersByTime(240_000));
      expect(screen.getByText('耗时 1m00s')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('冻结后没采到用量时是「未采集」而不是「采集中」（这几格此后不会再有人报数）', () => {
    render(
      <MetricLine
        tokens={null}
        turns={null}
        durationMs={null}
        score={null}
        running
        live={{
          // 连开始时刻都没有（这一行没走到过 running）：秒表无从走起，也不该拿 0 冒充
          startedAtMs: null,
          tokens: null,
          turns: null,
          candidateEnded: true,
          candidateEndedAtMs: Date.parse(JUDGE_AT),
        }}
      />,
    );

    expect(screen.getByText('tok 未采集')).toBeInTheDocument();
    expect(screen.getByText('缓存命中 未采集')).toBeInTheDocument();
    expect(screen.getByText('轮次 未采集')).toBeInTheDocument();
    expect(screen.getByText('耗时 未采集')).toBeInTheDocument();
    // 「采集中」只属于候选阶段：评分阶段说它是空承诺
    expect(screen.queryByText('tok 采集中')).toBeNull();
    expect(screen.queryByText('耗时 采集中')).toBeNull();
  });

  it('结束时刻解析不出来（叠加层给 null）时，这几格退回快照里的权威值', () => {
    render(
      <MetricLine
        tokens={{ input: 10, cached: 0, output: 20 }}
        turns={1}
        durationMs={4_000}
        score={null}
        running
        live={{
          startedAtMs: Date.parse(START_AT),
          tokens: null,
          turns: null,
          candidateEnded: true,
          candidateEndedAtMs: null,
        }}
      />,
    );

    expect(screen.getByText('tok 30')).toBeInTheDocument();
    expect(screen.getByText('轮次 1')).toBeInTheDocument();
    expect(screen.getByText('耗时 4s')).toBeInTheDocument();
  });
});
