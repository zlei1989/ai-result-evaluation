// @vitest-environment node
/**
 * 评测页的 URL 状态解析与「标题」列拼法（纯函数）。
 * URL 是右栏状态的唯一真源（刷新与分享都能回到同一屏），所以「脏 URL 怎么办」必须在这里定死：
 * 未知 `panel`、空 `id`、`panel=detail` / `edit` 但没有 id —— 一律回落到「不显示右栏」，
 * 绝不抛错、也绝不半开半合地渲染一条空右栏（那正是 ListDetailLayout 文件头警告的形态）。
 * 标题列的拼法同理：页面不能写 `.tsx` 测试，显示口径只能钉在这个纯函数上。
 */
import { describe, expect, it } from 'vitest';
import { ServiceError, type EvalRun } from '@aieval/contracts';
import { describeError, parseRunsPanel, runListTitle, runScoreDistribution, runScoreSummary, runsPanelHref } from './runs-view';

describe('parseRunsPanel', () => {
  it.each([
    ['?panel=detail&id=run-1', { panel: 'detail', id: 'run-1' }],
    ['?panel=new', { panel: 'new', id: null }],
    // 创建表单不需要 id：带上也忽略
    ['?panel=new&id=run-1', { panel: 'new', id: null }],
    ['?panel=edit&id=run-1', { panel: 'edit', id: 'run-1' }],
    // 编辑没有 id 等于没打开右栏（与 detail 同一条回落：半开的右栏是 ListDetailLayout 警告的形态）
    ['?panel=edit', { panel: null, id: null }],
    ['?panel=edit&id=', { panel: null, id: null }],
    // 只有 id：当成详情（老链接/手敲 URL 的常见形态）
    ['?id=run-1', { panel: 'detail', id: 'run-1' }],
    // 空串 id 等于没给
    ['?panel=detail&id=', { panel: null, id: null }],
    ['?panel=detail', { panel: null, id: null }],
    // 未知 panel：有 id 当详情，没有就当没打开右栏
    ['?panel=foo&id=run-1', { panel: 'detail', id: 'run-1' }],
    ['?panel=foo', { panel: null, id: null }],
    ['', { panel: null, id: null }],
  ])('%s → %o', (search, expected) => {
    expect(parseRunsPanel(search)).toEqual(expected);
  });

  it('接受 URLSearchParams（页面里就是这么传的）', () => {
    expect(parseRunsPanel(new URLSearchParams('panel=detail&id=run-9'))).toEqual({ panel: 'detail', id: 'run-9' });
  });
});

describe('runsPanelHref', () => {
  it('四种状态各有稳定的 URL', () => {
    expect(runsPanelHref(null, null)).toBe('/runs');
    expect(runsPanelHref('new', null)).toBe('/runs?panel=new');
    expect(runsPanelHref('detail', 'run-1')).toBe('/runs?panel=detail&id=run-1');
    // detail 但没 id ⇒ 回落到「不显示右栏」，不留一个半开的 URL
    expect(runsPanelHref('detail', null)).toBe('/runs');
    expect(runsPanelHref('edit', 'run-1')).toBe('/runs?panel=edit&id=run-1');
    // 与 detail 同一条回落：编辑也必须有一个明确的轮次
    expect(runsPanelHref('edit', null)).toBe('/runs');
  });

  it('id 会被转义（不假设 id 永远只有 UUID 字符）', () => {
    expect(runsPanelHref('detail', 'a b&c')).toBe('/runs?panel=detail&id=a%20b%26c');
  });
});

describe('runListTitle', () => {
  it.each([
    // 无备注：与今天的标题列逐字相同，不留尾随分隔符
    [{ caseTitle: '06 鹈鹕骑车', note: '' }, '06 鹈鹕骑车'],
    [{ caseTitle: '06 鹈鹕骑车', note: '   ' }, '06 鹈鹕骑车'],
    // 有备注：用例标题在前，备注在后，分隔符是「 · 」
    [{ caseTitle: '06 鹈鹕骑车', note: '对比模型不同版本间的差异' }, '06 鹈鹕骑车 · 对比模型不同版本间的差异'],
    // 备注首尾空白在显示层再 trim 一次（旧数据不保证经过写侧归一）
    [{ caseTitle: '06 鹈鹕骑车', note: '  对比差异  ' }, '06 鹈鹕骑车 · 对比差异'],
    // 手改过的 run.json：用例标题为空时不显示成「 · 备注」
    [{ caseTitle: '', note: '对比差异' }, '对比差异'],
    [{ caseTitle: '   ', note: '对比差异' }, '对比差异'],
    // 两格都空 ⇒ 空串（排序比较器按空值当最小值处置）
    [{ caseTitle: '', note: '' }, ''],
  ])('%o → %j', (run, expected) => {
    expect(runListTitle(run)).toBe(expected);
  });
});

describe('describeError', () => {
  it('ServiceError 用它的中文 message（契约要求 message 可直接展示）', () => {
    expect(describeError(new ServiceError('CONFLICT', '这一轮没有可执行的候选行：全部行都已评分'))).toBe(
      '这一轮没有可执行的候选行：全部行都已评分',
    );
  });

  it('其它抛出物兜底成一句中文，不透英文内部错误', () => {
    expect(describeError(new TypeError('Failed to fetch'))).toBe('操作失败，请稍后重试');
    expect(describeError('字符串')).toBe('操作失败，请稍后重试');
  });
});

/**
 * 列表「结论」两格的判据。
 *
 * 这一页最危险的信息失真就是「最高分盖住失败」：3 个候选里 1 个超时、2 个满分时，
 * `best` 仍是 100。故这两条用例钉的是「分布与未出分数必须同时读得出来」，
 * 以及「还在跑的行不能被当成失败」。
 */
describe('runScoreSummary / runScoreDistribution', () => {
  const row = (status: string, totalScore: number | null, maxScore = 100) =>
    ({
      status,
      score: totalScore === null ? null : { totalScore, maxScore },
    }) as unknown as EvalRun['rows'][number];

  it('最高分与它的满分成对给出，并数出已收场但没出分的候选', () => {
    const run = { rows: [row('judged', 100), row('timed-out', null), row('judged', 80)] } as unknown as Pick<EvalRun, 'rows'>;

    expect(runScoreSummary(run)).toEqual({ best: 100, max: 100, scored: 2, total: 3, unscored: 1 });
  });

  it('一个候选都没出分时返回 null（显示「—」，不拿 0 分冒充）', () => {
    const run = { rows: [row('timed-out', null), row('failed', null)] } as unknown as Pick<EvalRun, 'rows'>;

    expect(runScoreSummary(run)).toBeNull();
  });

  it('分布按分降序，只列已出分的（未出分/在跑由第一行的 x/y 表达）', () => {
    const run = {
      rows: [row('judged', 80), row('running', null), row('timed-out', null), row('judged', 100)],
    } as unknown as Pick<EvalRun, 'rows'>;

    expect(runScoreDistribution(run)).toBe('100 · 80');
  });

  it('超过 4 个出分候选时折成 +N，避免撑破 168px 的列', () => {
    const run = {
      rows: [row('judged', 100), row('judged', 98), row('judged', 90), row('judged', 88), row('judged', 21)],
    } as unknown as Pick<EvalRun, 'rows'>;

    expect(runScoreDistribution(run)).toBe('100 · 98 · 90 · 88 · +1');
  });

  it('只有还没收场的行时返回 null（此时没有结论，别把「…」画成失败）', () => {
    const run = { rows: [row('pending', null), row('running', null)] } as unknown as Pick<EvalRun, 'rows'>;

    expect(runScoreDistribution(run)).toBeNull();
  });
});
