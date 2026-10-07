/**
 * MetricLine：计量摘要。**本文件是「null 不是 0」这条口径的主守卫**（spec §5.6.3）。
 * 两个方向都要钉住：
 *   · `null`（没采到 / 采集不到）→ 显示「未采集」或「不支持计量」，**不得出现 0**；
 *   · 真实的 `0`（例如 0 轮）→ 照常显示 0，不得被当成「没采到」吃掉。
 * 只钉一个方向的守卫是没用的：把 null 渲染成 0 与把 0 渲染成「未采集」都会让使用者读错。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MetricLine, formatCacheHitRate, formatDuration } from './metric-line';
import { installResizeObserverStub } from '../testing/resize-observer';

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

/**
 * `formatCount` / `formatTokens` / `formatUsageTriple` 的用例在 `usage-metrics.test.ts`（node 环境）：
 * 实现已经搬到那个纯模块（里程碑与台账行也要用，而它们没有 React 依赖），本文件只消费渲染结果。
 */

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
    render(<MetricLine tokens={null} turns={null} durationMs={null} score={null} running live={{ startedAtMs: null, tokens: null, subagentTokens: null, subagentTurns: null, turns: null, candidateEnded: false, candidateEndedAtMs: null }} />);

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
        live={{ startedAtMs: null, tokens: { input: 1000, cached: 3000, output: 500 }, subagentTokens: null, subagentTurns: null, turns: 7, candidateEnded: false, candidateEndedAtMs: null }}
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
          live={{ startedAtMs: Date.parse(START_AT), tokens: null, subagentTokens: null, subagentTurns: null, turns: null, candidateEnded: false, candidateEndedAtMs: null }}
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
          live={{ startedAtMs: Date.parse(START_AT), tokens: { input: 999, cached: 0, output: 999 }, subagentTokens: null, subagentTurns: null, turns: 99, candidateEnded: false, candidateEndedAtMs: null }}
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
          subagentTokens: null,
          subagentTurns: null,
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
            subagentTokens: null,
            subagentTurns: null,
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
          subagentTokens: null,
          subagentTurns: null,
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
          subagentTokens: null,
          subagentTurns: null,
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

/**
 * **子智能体那一份：Tooltip 拆两行**（spec 2026-10-04 §2.5）。
 *
 * 为什么这组用例靠 hover 断言：Tooltip 的文案（`title`）**不挂在元素上**，只有浮层打开时才渲染进
 * body 的 portal——本仓既有判据就是这么断言的（`eval-row-card.test.tsx` 里那组 Tooltip 用例同形）。
 * 而浮层要在 jsdom 里打得开，得先补上两个缺口（`ResizeObserver` + `matchMedia`，见下面那个
 * `beforeEach`）：不打桩时 antd 的浮层对齐在 effect 里抛 `ReferenceError: ResizeObserver is not
 * defined`，浮层**永远不出现**（实测：不装桩时 `fireEvent.mouseEnter` 之后 10s 也查不到文案）。
 *
 * 三条口径（每条都有靶子）：
 *   ① 有分量且**逐格不大于**合计 ⇒ 两行，主会话那一行是**相减**出来的（不是第二份真值）；
 *   ② 缺这一格 / `null` / `{0,0,0}` / 与合计对不上 ⇒ **只有一行**，且与改动前**逐字相同**；
 *   ③ 跑动期取叠加层那一对（合计与分量必须同源同刻——拿快照那对去配叠加层的合计会拆出错的差）。
 */
describe('MetricLine：子智能体那一份拆两行（spec 2026-10-04 §2.5）', () => {
  beforeEach(() => {
    installResizeObserverStub();
  });

  /**
   * 桩必须**用完就撤**（本仓约一半调用点是这个成对写法，见 `run-detail-panel.test.tsx:31`）：
   * `vi.stubGlobal` 改的是**整个文件**的全局，撤不干净的话，本段之后**追加**的 describe 会白捡一个
   * `ResizeObserver`，于是 `resizable-columns.tsx` 那类「无 ResizeObserver 也要报一次初值」的兜底分支
   * 在测试里永远不可达（那正是 `resize-observer.ts` 文件头不肯把它放进共享 setup 的理由）。
   */
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('有子智能体时两行：主会话是相减算出来的，不是第二份真值', async () => {
    render(
      <MetricLine
        tokens={{ input: 100, cached: 20, output: 30 }}
        subagentTokens={{ input: 40, cached: 10, output: 5 }}
        turns={3}
        durationMs={1000}
        score={null}
      />,
    );

    fireEvent.mouseEnter(screen.getByText(/^tok /));
    // 60 = 100 − 40、10 = 20 − 10、25 = 30 − 5：两行都只由**这一对**算出来
    expect(await screen.findByText('主会话 输入 60 tok · 缓存 10 tok · 输出 25 tok')).toBeInTheDocument();
    expect(await screen.findByText('子智能体 输入 40 tok · 缓存 10 tok · 输出 5 tok')).toBeInTheDocument();
  });

  it('没有子智能体（{0,0,0}）时**只有一行**（不做主会话 / 子智能体拆分）', async () => {
    render(
      <MetricLine
        tokens={{ input: 100, cached: 20, output: 30 }}
        subagentTokens={{ input: 0, cached: 0, output: 0 }}
        turns={3}
        durationMs={1000}
        score={null}
      />,
    );

    fireEvent.mouseEnter(screen.getByText(/^tok /));
    expect(await screen.findByText('输入 100 tok · 缓存 20 tok · 输出 30 tok')).toBeInTheDocument();
    /**
     * 下面这条阴性断言的前提是**浮层真的开了**：浮层没渲染时 `queryByText` 同样是 null，
     * 那这条用例就退化成「什么都没验证」（`eval-row-card.test.tsx` 里那条「可重评的行不给
     * Tooltip」的用例栽过的同一个坑）。上面那句 `findByText` 已经证明浮层开了——这句话只可能
     * 出现在浮层里；`.ant-tooltip` 那一句是本仓既有的第二重保险。
     */
    expect(document.querySelector('.ant-tooltip')).not.toBeNull();
    expect(screen.queryByText(/主会话/)).toBeNull();
  });

  it('分量没采到（null）与缺这一格（老数据）都退回一行', async () => {
    const { unmount } = render(
      <MetricLine
        tokens={{ input: 100, cached: 20, output: 30 }}
        subagentTokens={null}
        turns={3}
        durationMs={1000}
        score={null}
      />,
    );

    fireEvent.mouseEnter(screen.getByText(/^tok /));
    expect(await screen.findByText('输入 100 tok · 缓存 20 tok · 输出 30 tok')).toBeInTheDocument();
    expect(screen.queryByText(/主会话/)).toBeNull();

    // 「缺这一格」是**另一档**（可选 prop 压根没传，老调用方就是这种形状）：同样只有一行。
    // 先卸载上一棵树：浮层是挂在 body 上的 portal，不卸载的话同一句文案会命中两个元素。
    unmount();
    render(<MetricLine tokens={{ input: 100, cached: 20, output: 30 }} turns={3} durationMs={1000} score={null} />);
    fireEvent.mouseEnter(screen.getByText(/^tok /));
    expect(await screen.findByText('输入 100 tok · 缓存 20 tok · 输出 30 tok')).toBeInTheDocument();
    expect(document.querySelector('.ant-tooltip')).not.toBeNull();
    expect(screen.queryByText(/主会话/)).toBeNull();
  });

  it('分量与合计对不上（主会话算出负数）时不画拆分——宁可少一行，也不显示 -12', async () => {
    render(
      <MetricLine
        tokens={{ input: 10, cached: 0, output: 1 }}
        subagentTokens={{ input: 40, cached: 0, output: 5 }}
        turns={1}
        durationMs={1000}
        score={null}
      />,
    );

    fireEvent.mouseEnter(screen.getByText(/^tok /));
    // 10 − 40 = −30：这一行绝不能出现
    expect(await screen.findByText('输入 10 tok · 缓存 0 tok · 输出 1 tok')).toBeInTheDocument();
    expect(document.querySelector('.ant-tooltip')).not.toBeNull();
    expect(screen.queryByText(/主会话/)).toBeNull();
  });

  it('跑动期用叠加层的那一对（合计与分量必须同源同刻）', async () => {
    render(
      <MetricLine
        // 快照那一对是**另一个时刻**的读数（还只是主会话的 {1,0,1}）：真拿它去配叠加层的合计，
        // 拆出来的主会话就是错的——这一条钉住「同源同刻」
        tokens={{ input: 1, cached: 0, output: 1 }}
        subagentTokens={{ input: 0, cached: 0, output: 0 }}
        turns={1}
        durationMs={null}
        score={null}
        running
        live={{
          startedAtMs: Date.now(),
          tokens: { input: 100, cached: 20, output: 30 },
          subagentTokens: { input: 40, cached: 10, output: 5 },
          subagentTurns: null,
          turns: 2,
          candidateEnded: false,
          candidateEndedAtMs: null,
        }}
      />,
    );

    fireEvent.mouseEnter(screen.getByText(/^tok /));
    expect(await screen.findByText('子智能体 输入 40 tok · 缓存 10 tok · 输出 5 tok')).toBeInTheDocument();
    // 主会话那一行同样只可能来自叠加层那一对（60 / 10 / 25，见本段第一条用例）
    expect(await screen.findByText('主会话 输入 60 tok · 缓存 10 tok · 输出 25 tok')).toBeInTheDocument();
  });
});

/**
 * **子智能体那一份轮次：Tooltip 拆两行**（spec 2026-10-04 §2.5 追加段，与 token 那一格逐条同构）。
 *
 * 判据三条（缺一条就会画出一句假话）：这一格**在**（不是缺格 / `null`）、`> 0`、且 `≤ turns`。
 * 主会话那一行由 `turns − subagentTurns` **相减**得出（不是第二份真值）；合计那一个数仍在卡片正文里
 * ——「轮次 9」照旧由正文渲染，这次拆分不改它的口径，也不改它的文案。
 * `≤ turns` 是**纵深防御**：它是 §2.4 的不变量，界面再查一遍，免得一份老 `run.json` 或一次将来的
 * 缺陷以「那两行自己都不自洽」（主会话算出负数）的形式出现在用户面前——那种画面看起来完全正常。
 *
 * 阴性断言（「只有一行」）为什么可信：`title` 为 `undefined` 时 antd **不渲染浮层**；但「悬浮完立刻
 * 查 `.ant-tooltip`」这种写法**没有分辨力**（浮层有 0.1s 的出场延迟，同步断言在任何实现下都为真，
 * 本文件的变异验证实测过），所以这几条一律走 `expectNoTooltip`——**等满一个延迟窗口**再判，
 * 而本段第一条用例已经证明同一个环境里悬浮是打得出浮层的（`ResizeObserver` 桩装好了）。
 */
describe('MetricLine：子智能体的轮次那一份拆两行（spec 2026-10-04 §2.5）', () => {
  beforeEach(() => {
    installResizeObserverStub();
  });

  /** 桩用完就撤：撤不干净的话，本段之后追加的 describe 会白捡一个 `ResizeObserver`（见上一段的登记） */
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /**
   * 悬浮之后**给浮层一个出场的机会**，再判「确实没有浮层」。
   *
   * 为什么不能悬浮完就立刻判 `null`：antd 的 `Tooltip` 有 `mouseEnterDelay`（默认 0.1s），**同步**那句
   * `querySelector('.ant-tooltip')` 在任何实现下都为真。实测（本文件的变异验证）：把「`> 0`」那一条
   * 判据删掉，浮层真的画出了「主会话 9 轮 / 子智能体 0 轮」，而同步断言仍然是绿的——**没有分辨力**
   * 的断言等于没写（本仓 `ellipsis-text.test.tsx` 也登记过「`.ant-tooltip` 单独不构成守卫」）。
   * 等满一个延迟窗口再判，缺陷才抓得住。
   */
  const expectNoTooltip = async (): Promise<void> => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    expect(document.querySelector('.ant-tooltip')).toBeNull();
  };

  it('有子智能体轮次时两行：主会话是 turns − subagentTurns 算出来的', async () => {
    render(<MetricLine tokens={null} turns={9} subagentTurns={3} durationMs={1000} score={null} />);

    // 正文那一格一个字不改：合计仍是 9（拆分不改它的口径）
    expect(screen.getByText('轮次 9')).toBeInTheDocument();

    fireEvent.mouseEnter(screen.getByText(/^轮次 /));
    // 6 = 9 − 3：两行都只由**这一对**算出来
    expect(await screen.findByText('主会话 6 轮')).toBeInTheDocument();
    expect(await screen.findByText('子智能体 3 轮')).toBeInTheDocument();
  });

  it('没有子智能体（0）时只有一行，逐字与改动前相同', async () => {
    render(<MetricLine tokens={null} turns={9} subagentTurns={0} durationMs={1000} score={null} />);

    fireEvent.mouseEnter(screen.getByText(/^轮次 /));
    await expectNoTooltip();

    expect(screen.getByText('轮次 9')).toBeInTheDocument();
    // 0 与「没采到」在这一格上渲染相同（spec §2.5 的规矩，不是漏做）：都不是「有分量」的证明
    expect(screen.queryByText(/主会话/)).toBeNull();
  });

  it('没采到（null）与缺这一格（老调用方）都只有一行', async () => {
    const { unmount } = render(<MetricLine tokens={null} turns={9} subagentTurns={null} durationMs={1000} score={null} />);

    fireEvent.mouseEnter(screen.getByText(/^轮次 /));
    await expectNoTooltip();
    expect(screen.queryByText(/子智能体/)).toBeNull();

    // 「缺这一格」是**另一档**（可选的 prop 压根没传，老调用方就是这种形状）：同样只有一行。
    // 先卸载上一棵树：不卸载的话同一句文案会命中两个元素（浮层挂在 body 上）。
    unmount();
    render(<MetricLine tokens={null} turns={9} durationMs={1000} score={null} />);
    fireEvent.mouseEnter(screen.getByText(/^轮次 /));
    await expectNoTooltip();
    expect(screen.queryByText(/子智能体/)).toBeNull();
  });

  it('分量比合计大（主会话算出负数）时不画拆分——宁可少一行，也不显示 -3 轮', async () => {
    render(<MetricLine tokens={null} turns={1} subagentTurns={4} durationMs={1000} score={null} />);

    fireEvent.mouseEnter(screen.getByText(/^轮次 /));
    await expectNoTooltip();

    // 1 − 4 = −3：这一行绝不能出现
    expect(screen.getByText('轮次 1')).toBeInTheDocument();
    expect(screen.queryByText(/主会话/)).toBeNull();
  });

  it('跑动期用叠加层的那一对（合计与分量必须同源同刻）', async () => {
    render(
      <MetricLine
        // 快照那一对是**另一个时刻**的读数（还只是主会话的 1 轮）：真拿它去配叠加层的合计，
        // 拆出来的主会话就是错的——这一条钉住「同源同刻」
        tokens={null}
        turns={1}
        subagentTurns={0}
        durationMs={null}
        score={null}
        running
        live={{
          startedAtMs: Date.now(),
          tokens: null,
          subagentTokens: null,
          subagentTurns: 5,
          turns: 8,
          candidateEnded: false,
          candidateEndedAtMs: null,
        }}
      />,
    );

    fireEvent.mouseEnter(screen.getByText(/^轮次 /));
    expect(await screen.findByText('子智能体 5 轮')).toBeInTheDocument();
    // 3 = 8 − 5：主会话那一行同样只可能来自叠加层那一对
    expect(await screen.findByText('主会话 3 轮')).toBeInTheDocument();
  });
});
