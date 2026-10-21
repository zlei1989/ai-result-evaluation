/**
 * 排名表：列 = 候选、行 = 各项事实、左首列锁住 + 其余列横向滚动（抽屉本身在页面那一层，不在本文件）。
 *
 * 本文件钉住的界面语义：
 *   · 名次落在第一行（标签留空，金色 Tag 自己说明这个候选是什么；与候选卡片徽标同形），且**用的是同一份判据**
 *     （总分降序 → 耗时升序 → token 输入+输出升序；三项全同并列、允许跳号）；
 *   · 未出分的候选照进表：列头不写名次、首行格写候选状态、评分与总分格留空；
 *   · 判定与评分项按引用键对齐，评分表里有而判定里没有的那一格显式写「缺少判定」；
 *   · 列随候选数增长，`scroll.x` 是**数值**（给 `true` / `'max-content'` 会让首列固定失效）；
 *   · 判据说明那一句由具名片段拼装（散写就没有东西守着它与 `compareRows` 一致）。
 *
 * jsdom 没有布局引擎：横向滚动的**效果**量不出来（与 `provider-table.test.tsx` 同一处境），
 * 能断言的只有结构事实（列数、`scroll.x` 是数值、首列宽度显式给出）与文案。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import type { EvalRun } from '@aieval/contracts';
import { installResizeObserverStub } from '../testing/resize-observer';
import {
  RANK_CRITERIA_PARTS,
  RANK_CRITERIA_TEXT,
  RANK_LABEL_WIDTH,
  RANK_CANDIDATE_WIDTH,
  RankTable,
  rankMarker,
  rankTableMinWidth,
} from './rank-table';

// jsdom 既没有 ResizeObserver 也没有 matchMedia，而 antd 的 Table 两者都要
// （见 src/testing/resize-observer.ts）：不打桩，挂载即抛 `window.matchMedia is not a function`。
beforeEach(() => {
  installResizeObserverStub();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

type Candidate = EvalRun['candidates'][number];

/**
 * 表格每一列的**实测列宽**（读 `colgroup` 的内联样式，剥掉分号）。
 * jsdom 没有布局引擎：「首列真的钉住了吗」量不出来，能断言的只有「宽度按两个常量逐列给出」
 * ——而宽度不给，rc-table 的吸边偏移就算不出来（`provider-table.test.tsx` 同一处境）。
 */
function columnWidths(): number[] {
  // 两张表（吸顶表头一张、表体一张）**各带一份 colgroup**，两份逐列同宽 ⇒ 只读第一张，不重复计数
  return Array.from(document.querySelector('table')?.querySelectorAll('colgroup col') ?? []).map((col) =>
    // 内联样式是 `width: 120px`（不是裸数字），故按正则抠出数值
    Number.parseInt(/width:\s*(\d+)px/.exec(col.getAttribute('style') ?? '')?.[1] ?? '', 10),
  );
}

function score(totalScore: number, judged: { id: string; achieved: boolean; reason?: string }[]): Candidate['score'] {
  return {
    judgments: judged.map((item) => ({ id: item.id, achieved: item.achieved, reason: item.reason ?? '理由' })),
    totalScore,
    maxScore: 100,
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

function makeCandidate(id: string, overrides: Partial<Candidate> = {}): Candidate {
  return {
    id,
    agentKind: 'dsh',
    providerId: 'p-1',
    providerName: '本地',
    baseUrl: 'http://127.0.0.1:4000',
    modelId: 'GLM-5.3',
    status: 'judged',
    branch: `test/${id}`,
    workspacePath: `/runs/run-1/candidates/${id}/workspace`,
    baselineCommit: '30b86eedca90b70d15b9eb9e75b454a2574762d4',
    tokens: { input: 18756, cached: 19840, output: 808 },
    turns: 4,
    durationMs: 24071,
    diff: { filesChanged: 1, insertions: 1, deletions: 0, truncated: false },
    score: score(100, [{ id: 'T1', achieved: true }, { id: 'T2', achieved: true }]),
    error: null,
    attempts: 1,
    sessionId: null,
    followUps: 0,
    followUpRounds: 0,
    ...overrides,
  };
}

function makeRun(candidates: Candidate[]): EvalRun {
  return {
    id: 'run-1',
    caseId: 'c-1',
    caseTitle: '02 使用 Skill',
    note: '',
    repoPath: 'none://',
    commitHash: '',
    repoBranch: null,
    rubric: {
      groups: [
        { name: '一、任务完成度', items: [{ id: 'T1', goal: '步骤中使用 skill', weight: 50 }] },
        { name: '二、结果', items: [{ id: '', goal: '结果含暗号', weight: 50 }] },
      ],
    },
    includeSteps: false,
    status: 'done',
    executionMode: 'parallel',
    useAgentJudge: false,
    askUser: false,
    candidates,
    injectMessages: false,
    workspaceBase: '/runs',
    createdAt: '2026-10-12T08:00:00.000Z',
    startedAt: '2026-10-12T08:00:01.000Z',
    finishedAt: '2026-10-12T08:05:00.000Z',
  };
}

describe('RankTable 名次', () => {
  it('「候选未作答」只在**真的没答**时挂出来 —— 键缺席（未记录）不画', () => {
    /**
     * 两个方向都要钉：`true` ⇒ 必须出现（否则横向对比会把空答复排得和正常一样）；
     * **键缺席 ⇒ 必须不出现** —— 旧数据没有这一格，画成任一结论都是编事实。
     * 后一半同时保证既有用例断言的 `textContent` 不被多出来的 Tag 污染。
     */
    const { unmount } = render(
      <RankTable
        run={makeRun([
          makeCandidate('blank', { score: score(60, [{ id: 'T1', achieved: true }]), emptyAnswer: true }),
          makeCandidate('ok', { score: score(100, [{ id: 'T1', achieved: true }]) }),
        ])}
      />,
    );
    expect(screen.getAllByText('候选未作答')).toHaveLength(1);
    unmount();

    render(
      <RankTable
        run={makeRun([
          makeCandidate('a', { score: score(60, [{ id: 'T1', achieved: true }]) }),
          makeCandidate('b', { score: score(100, [{ id: 'T1', achieved: true }]) }),
        ])}
      />,
    );
    expect(screen.queryByText('候选未作答')).toBeNull();
  });

  it('名次落在第一行（标签留空、金色 Tag），列序即名次序；列头不写名次', () => {
    render(
      <RankTable
        run={makeRun([
          makeCandidate('slow', { score: score(60, [{ id: 'T1', achieved: true }, { id: 'T2', achieved: false }]) }),
          makeCandidate('best', { score: score(100, [{ id: 'T1', achieved: true }, { id: 'T2', achieved: true }]) }),
        ])}
      />,
    );

    // **没有列头**：名次只能有一个落点（第一行），列头本来就是空的（留一行空白只占高度）
    expect(screen.queryAllByRole('columnheader')).toHaveLength(0);

    const rankRow = screen.getByTestId('rank-table-row-rank');
    // `data-rank` 是**列序**的事实：满分那列第 1 名、60 分那列第 2 名
    expect(rankRow.getAttribute('data-rank')).toBe(rankMarker([1, 2]));
    // 两格都是金色的名次 Tag（与卡片徽标同色同字），且**左格名次更高**——列序即名次序
    const cells = within(rankRow).getAllByRole('cell').slice(1);
    expect(cells.map((cell) => cell.textContent)).toEqual(['第 1 名', '第 2 名']);
    expect(cells[0]?.querySelector('.ant-tag-gold')).not.toBeNull();
    // 名次是按**整轮行集**算的：满分那行（best）在前、60 分那行（slow）在后
    expect(cells[0]?.getAttribute('data-testid')).toBe('rank-cell-rank-best');
    expect(cells[1]?.getAttribute('data-testid')).toBe('rank-cell-rank-slow');
  });

  it('三项全同 ⇒ 并列同名次（允许跳号）；未出分的列不参与排名（`data-rank` 那一格是空）', () => {
    const tied = { tokens: { input: 100, cached: 0, output: 10 }, durationMs: 1000 };
    render(
      <RankTable
        run={makeRun([
          makeCandidate('a', { ...tied, score: score(100, [{ id: 'T1', achieved: true }, { id: 'T2', achieved: true }]) }),
          makeCandidate('b', { ...tied, score: score(100, [{ id: 'T1', achieved: true }, { id: 'T2', achieved: true }]) }),
          makeCandidate('c', {
            tokens: { input: 900, cached: 0, output: 90 },
            score: score(60, [{ id: 'T1', achieved: true }, { id: 'T2', achieved: false }]),
          }),
        ])}
      />,
    );

    // 并列的两列都是第 1 名，第三列是第 3 名（**跳号**是判据的直接结果，不是缺陷）
    expect(screen.getByTestId('rank-table-row-rank').getAttribute('data-rank')).toBe(rankMarker([1, 1, 3]));
  });

  it('未出分的候选排在有分的右侧、不给名次（首行格写候选状态），评分与总分格留空', () => {
    render(
      <RankTable
        run={makeRun([
          makeCandidate('failed-row', {
            status: 'failed',
            tokens: null,
            durationMs: null,
            score: null,
            error: { code: 'AGENT_FAILED', message: '崩了' },
          }),
          makeCandidate('ok'),
        ])}
      />,
    );

    // 名次只覆盖有分的那一列（未出分那一格是空串，故拼出来是 `1,`）
    // 未出分那一列是空串 `1,`：名次标记里「空」就是「没有名次」
    expect(screen.getByTestId('rank-table-row-rank').getAttribute('data-rank')).toBe(rankMarker([1, undefined]));

    const rankRow = screen.getByTestId('rank-table-row-rank');
    // 有分的列在左、未出分的列在右；未出分那一格写的是**候选状态**（「这行为什么没分」的第一句话）
    expect(within(rankRow).getAllByText(/^第 \d 名$/)).toHaveLength(1);
    expect(within(rankRow).getByText('失败')).toBeInTheDocument();

    // 评分与总分那两行：失败那一列整个留空（不留「0 分」这类会被读成读数的东西）
    // 有分的列在左、未出分的列在右（列序 = `orderForDisplay` 的顺序）
    expect(within(rankRow).getAllByRole('cell')[1]?.getAttribute('data-testid')).toBe('rank-cell-rank-ok');
    expect(within(rankRow).getAllByRole('cell')[2]?.getAttribute('data-testid')).toBe('rank-cell-rank-failed-row');

    const totalCandidate = screen.getByTestId('rank-table-row-total');
    const totalCells = within(totalCandidate).getAllByRole('cell');
    expect(totalCells).toHaveLength(3);
    // 单元格只写这一列拿到的分（满分在左锁列的标签里，不在每一列重复）
    expect(totalCells[1]?.textContent).toBe('100');
    expect(totalCells[2]?.textContent).toBe(''); // 未出分那一列整个留空
  });
});

describe('RankTable 行与格', () => {
  it('四段行齐备：身份 / 执行 / 每组一行组名 + 各目标（带权重）/ 总分', () => {
    render(<RankTable run={makeRun([makeCandidate('only')])} />);

    // 身份四行：**第一候选的标签留空**（名次 Tag 自己说明这个候选是什么），其余三行各有一个标签
    for (const label of ['智能体', '模型', '思考强度']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    expect(within(screen.getByTestId('rank-table-row-rank')).getAllByRole('cell')[0]?.textContent).toBe('');
    // 执行四行（耗时 + token 三格，与判据同源的两个数逐格摆开）
    for (const label of ['耗时', '输入', '缓存读', '输出']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    // 组名分隔行写组名、目标行带权重（权重是 Tag，见下一条用例）
    expect(screen.getByText('一、任务完成度')).toBeInTheDocument();
    expect(screen.getByText('二、结果')).toBeInTheDocument();
    expect(screen.getByText('步骤中使用 skill')).toBeInTheDocument();
    expect(screen.getByText('结果含暗号')).toBeInTheDocument();
    // 总分那一候选的**标签**只写满分（取自这一分自己的 `score.maxScore`，不是常量 100）：
    // 位置已经说明它是总分那一行，措辞越短越好扫
    expect(screen.getByText('满分 100')).toBeInTheDocument();
    // 单元格只有得分本身，没有 `100 / 100` 这种重复了两遍满分的写法
    expect(screen.getByTestId('rank-table-row-total').textContent).not.toContain('/');
  });

  it('目标候选的权重是 Tag（与目标原文分开成两类事实），其余候选的标签是纯文本', () => {
    render(<RankTable run={makeRun([makeCandidate('only')])} />);

    const itemLabel = (key: string): HTMLElement =>
      within(screen.getByTestId(`rank-table-row-${key}`)).getAllByRole('cell')[0] as HTMLElement;

    // 目标原文与权重各在一个节点里（不再是 `目标 · 50 分` 那样一串纯文本）
    expect(within(itemLabel('item-T1')).getByText('步骤中使用 skill')).toBeInTheDocument();
    expect(within(itemLabel('item-T1')).getByText('50 分')).toBeInTheDocument();
    // 权重那个节点是 antd 的 Tag（可跳读的记号，不是句子的一部分）
    expect(within(itemLabel('item-T1')).getByText('50 分').className).toContain('ant-tag');
    // 另一项没有写 id（引用键是位置号 `#2`），同样走这条
    expect(within(itemLabel('item-#2')).getByText('50 分').className).toContain('ant-tag');

    // 其余候选的标签**不带** Tag：名次、组名、总分都还是纯文本
    for (const key of ['rank', 'group-0', 'total']) {
      expect(itemLabel(key).querySelector('.ant-tag'), `${key} 那一候选的标签不该有 Tag`).toBeNull();
    }
  });

  it('组名只写在左锁列里、不横跨候选列（横跨时它会跟着横向滚动滑走）', () => {
    render(<RankTable run={makeRun([makeCandidate('only')])} />);

    const groupCells = within(screen.getByTestId('rank-table-row-group-0')).getAllByRole('cell');
    // 标签列 + 候选列各占一格，没有任何 `colSpan` 铺满
    expect(groupCells).toHaveLength(2);
    expect(groupCells[0]?.getAttribute('colspan')).toBeNull();
    expect(groupCells[0]?.textContent).toBe('一、任务完成度');
    // 候选列那一格留白（组名不重复到每一列上）
    expect(groupCells[1]?.textContent).toBe('');
    // 组名那一格是**锁列**（横向滚到底也在视野内）
    expect(groupCells[0]?.className).toContain('ant-table-cell-fix-start');
  });

  it('整张表没有自定义行底色（分段靠位置与字重：组名加粗、总分是粗体）', () => {
    render(<RankTable run={makeRun([makeCandidate('only')])} />);

    // 每个候选的每一格都不带内联底色：自加一层会与表格自身的斑马纹 / hover 打架，
    // 且亮暗两套主题下都要重调（用户口径：三个候选都不上色）
    for (const key of ['rank', 'agent', 'duration', 'group-0', 'item-T1', 'total']) {
      const cells = within(screen.getByTestId(`rank-table-row-${key}`)).getAllByRole('cell');
      for (const cell of cells) {
        expect(cell.style.background, `${key} 那一行仍有底色`).toBe('');
      }
    }
  });

  it('执行那一段：耗时走 formatDuration、悬浮给精确毫秒；token 三格走千分位 + tok', () => {
    render(<RankTable run={makeRun([makeCandidate('only')])} />);

    expect(screen.getByText('24s')).toBeInTheDocument();
    expect(screen.getByText('18,756 tok')).toBeInTheDocument();
    expect(screen.getByText('19,840 tok')).toBeInTheDocument();
    expect(screen.getByText('808 tok')).toBeInTheDocument();
  });

  it('出分但没采到耗时 / 用量时写「未采集」，绝不写 0（0 是一个读数，不是「没采到」）', () => {
    render(<RankTable run={makeRun([makeCandidate('only', { tokens: null, durationMs: null })])} />);

    expect(screen.queryByText('0 tok')).toBeNull();
    // 耗时 1 处 + token 3 处
    expect(screen.getAllByText('未采集')).toHaveLength(4);
  });

  it('未出分的列在执行段整段留白（候选状态已经说明原因，五个「未采集」只是噪音）', () => {
    render(
      <RankTable
        run={makeRun([
          makeCandidate('ok'),
          makeCandidate('failed-row', {
            status: 'failed',
            tokens: null,
            durationMs: null,
            score: null,
            error: { code: 'AGENT_FAILED', message: '崩了' },
          }),
        ])}
      />,
    );

    // 有分那一列照常显示读数；未出分那一列在四个候选里都是空的
    expect(screen.getAllByText('24s')).toHaveLength(1);
    for (const key of ['duration', 'tokens-input', 'tokens-cached', 'tokens-output']) {
      const cells = within(screen.getByTestId(`rank-table-row-${key}`)).getAllByRole('cell');
      expect(cells[2]?.textContent).toBe(''); // 未出分那一列（排在右侧）
      expect(cells[1]?.textContent).not.toBe('');
    }
    // 「未采集」一处都不该出现：这一轮里没有任何**有分**的行缺这两格
    expect(screen.queryByText('未采集')).toBeNull();
  });

  it('达成 / 未达成与评分详情逐字同形；评分表里有而判定里没有的项显式写「缺少判定」', () => {
    render(
      <RankTable
        run={makeRun([
          makeCandidate('a', {
            score: score(50, [{ id: 'T1', achieved: false, reason: '没调用 skill' }]),
          }),
        ])}
      />,
    );

    expect(screen.getByText('未达成')).toBeInTheDocument();
    // `T1` 未达成、`#2` 整个缺判定 ⇒ 既不是达成也不是未达成，而是第三种事实
    expect(screen.getByText('缺少判定')).toBeInTheDocument();
  });

  it('思考强度缺省写「未指定」（不是「默认」，也不是留空）', () => {
    render(<RankTable run={makeRun([makeCandidate('only', { effort: undefined })])} />);
    expect(screen.getByText('未指定')).toBeInTheDocument();
  });
});

describe('RankTable 表格结构与说明', () => {
  it('scroll.x 是**数值**且随候选数增长（给 true / max-content 会让首列固定失效）', () => {
    // 函数本身是判据的落点：宽度 = 标签列 + 每个候选一列
    expect(rankTableMinWidth(1)).toBe(RANK_LABEL_WIDTH + RANK_CANDIDATE_WIDTH);
    expect(rankTableMinWidth(3)).toBe(RANK_LABEL_WIDTH + 3 * RANK_CANDIDATE_WIDTH);

    const { unmount } = render(<RankTable run={makeRun([makeCandidate('a')])} />);
    // colgroup 的宽度逐列来自那两个常量（吸边偏移按实测列宽算 ⇒ 宽度不显式给出，固定列会失效）
    expect(columnWidths()).toEqual([RANK_LABEL_WIDTH, RANK_CANDIDATE_WIDTH]);
    unmount();

    render(<RankTable run={makeRun([makeCandidate('a'), makeCandidate('b'), makeCandidate('c')])} />);
    expect(columnWidths()).toEqual([RANK_LABEL_WIDTH, RANK_CANDIDATE_WIDTH, RANK_CANDIDATE_WIDTH, RANK_CANDIDATE_WIDTH]);
  });

  it('首列锁左、其余列不锁；第一列宽度显式给出（吸边偏移按实测列宽算）', () => {
    render(<RankTable run={makeRun([makeCandidate('a'), makeCandidate('b')])} />);

    expect(columnWidths()).toEqual([RANK_LABEL_WIDTH, RANK_CANDIDATE_WIDTH, RANK_CANDIDATE_WIDTH]);
    // 吸边类只出现在首列（`-start`）：其余两列都不许 fix。
    // 表头已隐藏（`showHeader={false}`）⇒ 判据落在**表体的 td** 上。
    // （jsdom 读不到 `position: sticky`，类名是「这一列到底钉没钉」唯一可断言的东西，与 provider-table 同一手法）
    const firstRowCells = Array.from(screen.getByTestId('rank-table-row-rank').querySelectorAll('td'));
    expect(firstRowCells).toHaveLength(3);
    expect(firstRowCells[0]?.className).toContain('ant-table-cell-fix-start');
    expect(firstRowCells[1]?.className).not.toContain('ant-table-cell-fix');
    expect(firstRowCells[2]?.className).not.toContain('ant-table-cell-fix');
  });

  it('判据说明逐字渲染在**表下方**，且内容来自具名片段（改文案只有一处落点）', () => {
    render(<RankTable run={makeRun([makeCandidate('only')])} />);

    const criteria = screen.getByTestId('rank-criteria');
    expect(criteria).toHaveTextContent(RANK_CRITERIA_TEXT);
    // 位置：在表格**之后**（用户口径：说明挪到表下方）
    const table = screen.getByTestId('rank-table');
    expect(table.compareDocumentPosition(criteria) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // 说明必须**逐段**出现在界面上：漏掉某一段（如并列那条）时这一格立刻红
    for (const part of RANK_CRITERIA_PARTS) {
      expect(screen.getByTestId('rank-criteria')).toHaveTextContent(part);
    }
    // 三级判据的名词得在说明里（改 `compareRows` 判据时，这句话就是必须一起改的那一处；
    // 判据本身的行为由 `run-detail-panel.test.tsx` 那一组钉住，这里只管说明没写漏）
    expect(RANK_CRITERIA_TEXT).toContain('总分');
    expect(RANK_CRITERIA_TEXT).toContain('耗时');
    expect(RANK_CRITERIA_TEXT).toContain('tok');
  });

  it('有行在跑才出现实时提示，且 N 是候选数（不是「有 / 没有」）', () => {
    const { unmount } = render(<RankTable run={makeRun([makeCandidate('only')])} />);
    expect(screen.queryByTestId('rank-live-note')).toBeNull();
    unmount();

    render(<RankTable run={makeRun([makeCandidate('only')])} runningCount={2} />);
    const note = screen.getByTestId('rank-live-note');
    expect(note).toHaveTextContent('有 2 行正在执行，名次可能变化');
    // 实时提示也挂在表格下方（与判据说明同一条口径）
    expect(screen.getByTestId('rank-table').compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
