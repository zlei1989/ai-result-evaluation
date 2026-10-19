/**
 * 评分对比图：给「出了分的候选」各画一根横柱，柱长 = 该候选的总分（排名页抽屉里那张）。
 *
 * 本文件钉住三条界面语义：
 *   ① **一根柱都没有时不画图**：显示「未采集」，连 `<svg>` 都不出现——画一根 0 高度的柱
 *      等于替使用者断言「这些候选都得了 0 分」，而事实是**没有读数**（与表里「未采集」同一口径）；
 *   ② **柱长是真值**：柱末标签就是契约里的 `score.totalScore`（92 / 74 这种原数），
 *      不是归一化百分比、也不是占位；
 *   ③ **一根柱 = 一个出分的候选**：未出分的候选不进图（进图只能画成 0，见 ①）。
 *
 * jsdom 没有布局引擎：像素长度量不出来（SVG 坐标由 recharts 自己算，`getBoundingClientRect` 恒 0），
 * 能断言的是「有几个矩形、有哪些文字」这类结构事实。
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { EvalRun } from '@aieval/contracts';
import { ScoreChart, scoreChartData } from './score-chart';

type Row = EvalRun['rows'][number];

function score(totalScore: number, maxScore = 100): Row['score'] {
  return {
    judgments: [],
    totalScore,
    maxScore,
    verdict: '可用',
    raw: '{}',
    judgeProviderId: 'p-1',
    judgeModelId: 'judge-model',
    judgedAt: '2026-10-12T08:10:00.000Z',
    judgeAgentKind: null,
    judgeEffort: null,
    structuredOutput: false,
    judgeTokens: null,
    judgeDurationMs: null,
  };
}

function makeRow(id: string, overrides: Partial<Row> = {}): Row {
  return {
    id,
    agentKind: 'dsh',
    providerId: 'p-1',
    providerName: '本地',
    baseUrl: 'http://127.0.0.1:4000',
    modelId: 'GLM-5.3',
    status: 'judged',
    branch: `test/${id}`,
    workspacePath: `/runs/run-1/rows/${id}/workspace`,
    baselineCommit: '30b86eedca90b70d15b9eb9e75b454a2574762d4',
    tokens: { input: 18756, cached: 19840, output: 808 },
    turns: 4,
    durationMs: 24071,
    diff: { filesChanged: 1, insertions: 1, deletions: 0, truncated: false },
    score: score(100),
    error: null,
    attempts: 1,
    sessionId: null,
    followUps: 0,
    followUpRounds: 0,
    ...overrides,
  };
}

describe('评分对比图：空数据不画假柱', () => {
  it('一个候选都没出分 ⇒ 显示「未采集」，一个 svg 都不画', () => {
    const { container } = render(
      <ScoreChart rows={[makeRow('a', { score: null, status: 'failed' }), makeRow('b', { score: null, status: 'pending' })]} />,
    );
    expect(screen.getByTestId('rank-score-chart-empty').textContent).toContain('未采集');
    // 图整块不渲染：没有 svg 就没有柱，也就不存在「0 高度柱」
    expect(container.querySelector('svg')).toBeNull();
    expect(container.querySelectorAll('.recharts-rectangle')).toHaveLength(0);
  });

  it('空 rows 也是同一句话（没有候选 = 没有读数，不是「都是 0 分」）', () => {
    const { container } = render(<ScoreChart rows={[]} />);
    expect(screen.getByTestId('rank-score-chart-empty').textContent).toContain('未采集');
    expect(container.querySelector('svg')).toBeNull();
  });
});

describe('评分对比图：柱长就是契约里的分数', () => {
  it('两个出分候选 ⇒ 两根柱，柱末标签是 92 / 74（真值，不是占位）', () => {
    const { container } = render(
      <ScoreChart
        rows={[
          makeRow('a', { score: score(92) }),
          makeRow('b', { agentKind: 'codex', modelId: 'gpt-5', score: score(74) }),
        ]}
      />,
    );
    expect(container.querySelectorAll('.recharts-rectangle')).toHaveLength(2);
    const labels = Array.from(container.querySelectorAll('.recharts-label-list text')).map((node) => node.textContent);
    expect(labels).toContain('92');
    expect(labels).toContain('74');
  });

  it('未出分的候选不进图：三行里两行有分 ⇒ 两根柱，未出分那行连类目标签都不出现', () => {
    const { container } = render(
      <ScoreChart
        rows={[
          makeRow('a', { score: score(92) }),
          // 未出分那一行给一个**独有的**模型名：图里一旦出现它，就说明「没读数」被画进了对比
          makeRow('b', { agentKind: 'codex', modelId: 'gpt-5', score: null, status: 'running' }),
          makeRow('c', { score: score(74) }),
        ]}
      />,
    );
    expect(container.querySelectorAll('.recharts-rectangle')).toHaveLength(2);
    // 未出分那一行既不能有柱，也不能有一个「0」的读数标签：画 0 就是在说「它得了 0 分」
    const labels = Array.from(container.querySelectorAll('.recharts-label-list text')).map((node) => node.textContent);
    expect(labels).toEqual(['92', '74']);
    expect(container.textContent, '未出分那行被画进了对比（类目里有它，却永远没有柱）').not.toContain('Codex gpt-5');
  });
});

describe('评分对比图的数据', () => {
  it('逐行给出「智能体 + 模型」与总分：同一模型换厂商也分得清', () => {
    const data = scoreChartData([
      makeRow('a', { score: score(92) }),
      makeRow('b', { agentKind: 'codex', modelId: 'GLM-5.3', score: score(74) }),
      makeRow('c', { score: null, status: 'failed' }),
    ]);
    expect(data.map((datum) => [datum.name, datum.score])).toEqual([
      ['DeepSeek Harness GLM-5.3', 92],
      ['Codex GLM-5.3', 74],
    ]);
  });

  it('刻度上限取各行自报的满分，而不是写死 100', () => {
    const data = scoreChartData([makeRow('a', { score: score(30, 60) }), makeRow('b', { score: score(45, 90) })]);
    expect(data.map((datum) => datum.maxScore)).toEqual([60, 90]);
    expect(Math.max(...data.map((datum) => datum.maxScore))).toBe(90);
  });
});
