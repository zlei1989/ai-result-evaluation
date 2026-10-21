/**
 * ScoreDetailView：总分 / 目标 + 总评 + 逐项达成 / 未达成 + 理由 + 评分运行信息
 * + 评分原始输出（评审会话的 `log` 原文）。
 * 九条守卫：
 *   1. **总分原样显示 `score.totalScore`，前端不重算**（它是服务端按权重加总出来的权威值）；
 *   2. **未达成的项要能被看出来**（它们才是使用者要看的重点，不能与达成项长得一样）——
 *      数据属性 / 文案一条，**语义色**另一条（只钉前者的话，把颜色改掉没有任何东西会红）；
 *   3. **判定按引用键与评分表对齐**：缺一项说明数据不一致，此时**不静默跳过**；
 *   4. 满分来自 `maxScore`（不是常量 100），落在「总分」那格 `Statistic` 的 suffix（`/N`）；
 *      与之并排的「目标」那格 `Statistic` 是项数（`Row` / `Col` 两列）；
 *   5. 评分时间与用量 / 耗时同一行（`formatDateTime`）；底部不设记账行（`structuredOutput` 不上界面）；
 *   6. 逐项明细是**折叠面板套 antd 表格**：一组一个面板、面板里一张表（`size="small"`），
 *      且**默认全部展开**——收起是使用者的动作，不是初始状态；
 *   7. **一张表一个列几何**：每张表都 `tableLayout="fixed"`，五列宽度逐列相同
 *      （四列百分比、目标列不给宽度吃剩余）——不钉住的话，每张表按自己的内容算宽度，
 *      同一列在上下两组里落在不同的横坐标上；
 *   8. **抽屉顶部那一段说的是「这一分是谁打的、花了多少」**（两行、无标题）：
 *      评分智能体 / 评分模型 / 思考强度 + 评分的用量 / 耗时，
 *      **五格全部来自 `score`**（`judgeAgentKind` / `judgeModelId` / `judgeEffort` / `judgeTokens` /
 *      `judgeDurationMs`）。⚠️ 这一段说的是**评分自己**的花销，不是被评那一行（那五格在 `EvalCandidate` 上）
 *      ——候选的智能体 / 模型 / 用量 / 耗时**不进这个抽屉**
 *      （候选卡片与执行日志里都有）。故本文件不再需要行夹具，
 *      而「页面有没有把 row 又接回来」由 `apps/web-next/src/runs-page-wiring.test.ts` 反向钉住；
 *   9. **评分原始输出**（入口在页面 footer、正文在本层二级抽屉、
 *      开合受控）：`judgeOutput` 不给 ⇒ 连抽屉都不渲染（文本 API 评分 / 评分未开始，判据在页面）；
 *      给了 ⇒ 三态各有画面（加载骨架 / 错误 + 重试 / 逐行原文），行渲染与执行日志的
 *      「原始输出」面板**共用一份**（`diagnosticsBody`）——判据钉在 `raw-output-line` 上，
 *      两处长得不一样时这条会红。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { ConfigProvider } from 'antd';
import type { ReactNode } from 'react';
import { AGENT_LABELS, type Rubric, type ScoreResult } from '@aieval/contracts';
import { formatDateTime } from '../base/format';
import { installResizeObserverStub } from '../testing/resize-observer';
import { ScoreDetailView, type ScoreJudgeOutputProps } from './score-detail-view';
import type { AgentLogDiagnostics } from './agent-log/types';

// jsdom 既没有 ResizeObserver 也没有 matchMedia，而 antd 的 Table 两者都要
// （见 src/testing/resize-observer.ts）：不打桩，挂载即抛。
beforeEach(() => {
  installResizeObserverStub();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * 语义色那条守卫用的**自定义** `colorError`：刻意不等于默认值（`#ff4d4f`），
 * 这样「颜色跟着 antd token 走」才是一条真断言——写死默认色值同样会红。
 */
const CUSTOM_COLOR_ERROR = '#123456';

const RUBRIC: Rubric = {
  groups: [
    {
      name: '一、生产代码',
      items: [
        { id: 'A1', goal: '追加 agent 字段', weight: 18 },
        { id: 'D1', goal: '补透传用例', weight: 14 },
      ],
    },
  ],
};

function score(overrides: Partial<ScoreResult> = {}): ScoreResult {
  return {
    judgments: [
      { id: 'A1', achieved: true, reason: '字段进了契约' },
      { id: 'D1', achieved: false, reason: '没补用例' },
    ],
    totalScore: 18,
    maxScore: 32,
    verdict: '生产代码到位，测试缺失',
    raw: '{"judgments":[]}',
    judgeProviderId: 'p-1',
    judgeModelId: 'deepseek-chat',
    judgedAt: '2026-09-29T08:10:00.000Z',
    judgeAgentKind: null,
    // 评分者那一候选的强度**未指定**（`judgeEffort` 缺键 ⇒ 契约的 `.default(null)`）：这一格刻意与
    // 「候选 / 尺子」两条通路都脱钩——候选的强度另有夹具（`candidateFixture` 的 `effort: 'max'`），
    // 而评分者的两档（`max` / `off`）各有专门用例，不靠这一份默认值覆盖。
    judgeEffort: null,
    structuredOutput: false,
    /**
     * 评分**自己**的花销。与 `judgeEffort` 同一格口径：默认值要让「有用量」那几条
     * 判据读得出来（千分位 / 单位 / 时长格式），而「没采到」那一支由用例显式覆盖成 `null`。
     */
    judgeTokens: { input: 1_200, cached: 800, output: 300 },
    judgeDurationMs: 29_000,
    ...overrides,
  };
}

/** 渲染这一格：评分原始输出那一组默认不给（那是「这个候选没有入口」的形状，判据在页面那一层） */
function view(scoreResult: ScoreResult, rubric: Rubric = RUBRIC): ReactNode {
  return <ScoreDetailView score={scoreResult} rubric={rubric} />;
}

describe('ScoreDetailView', () => {
  it('总分、满分、逐项目标与理由、总评、评分者都在', () => {
    render(view(score()));
    const summary = within(screen.getByTestId('score-total'));
    // 两格指标：总分（带上限 suffix）与「目标」（本轮评分项数）
    expect(summary.getByText('总分')).toBeInTheDocument();
    expect(summary.getByText('18')).toBeInTheDocument();
    expect(summary.getByText('/32')).toBeInTheDocument();
    expect(summary.getByText('目标')).toBeInTheDocument();
    expect(summary.getByText('2')).toBeInTheDocument();
    expect(screen.getByText('追加 agent 字段')).toBeInTheDocument();
    expect(screen.getByText('字段进了契约')).toBeInTheDocument();
    expect(screen.getByText('生产代码到位，测试缺失')).toBeInTheDocument();
    expect(screen.getByText(/deepseek-chat/)).toBeInTheDocument();
  });

  /**
   * 形态守卫：总分与目标两格是 antd `Statistic`，并排落在 `Row` / `Col` 里，
   * 且 title / value / suffix 三个语义槽各就各位（换成手写的标题 + 次要文字时行为断言照样全绿
   * ——数字、上限、项数都还在，只有观感退化，故判据落在 antd 的语义类名上，
   * 与「逐项明细是 `.ant-table-small`」同一条口径）。
   */
  it('总分与目标是并排的两格 antd Statistic（title / value / suffix 各就各位）', () => {
    const { container } = render(view(score()));
    const summary = container.querySelector('[data-testid="score-total"]');
    // 栅格：一行两个等宽列（`span={12}`）——退回竖排的 Flex 时这条红
    expect(summary?.classList.contains('ant-row')).toBe(true);
    expect(summary?.querySelectorAll(':scope > .ant-col.ant-col-12')).toHaveLength(2);

    const stats = summary?.querySelectorAll('.ant-statistic') ?? [];
    expect(stats).toHaveLength(2);
    expect(stats[0]?.querySelector('.ant-statistic-title')?.textContent).toBe('总分');
    expect(stats[0]?.querySelector('.ant-statistic-content-value')?.textContent).toBe('18');
    // 上限只写 `/N`：不带单位、也不带空格（与「分」脱钩，单位由这一格的 title 交代）
    expect(stats[0]?.querySelector('.ant-statistic-content-suffix')?.textContent).toBe('/32');
    expect(stats[1]?.querySelector('.ant-statistic-title')?.textContent).toBe('目标');
    expect(stats[1]?.querySelector('.ant-statistic-content-value')?.textContent).toBe('2');
  });

  /**
   * 顺序守卫：**先结论、后明细**——总评紧跟在两格指标下面，逐项明细在它之后。
   * 为什么值得一条：把总评挪回明细之后时「文字还在页面上」，任何文案断言都不红，
   * 但结论会沉到滚动区底部；而这一格正是「一眼知道结果」的地方。
   */
  it('总评紧跟两格指标、逐项明细在总评之后', () => {
    render(view(score()));
    const summary = screen.getByTestId('score-total');
    const verdict = screen.getByText('生产代码到位，测试缺失');
    const groups = screen.getByTestId('score-rubric-groups');
    // `compareDocumentPosition` 的位掩码里含 FOLLOWING 就是「参数那个节点在后」
    expect(summary.compareDocumentPosition(verdict) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(verdict.compareDocumentPosition(groups) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  /**
   * 形态守卫：总评也是一格 antd `Statistic`（title「总评」/ value 是那句评语），
   * 且 `content` 走正文档字号——指标值那 24px 会把一整段评语撑成标题，而「文字都在页面上」
   * 让任何文案断言都不会因此变红，故判据落在语义节点与 `content` 的字号上（14px 是默认 token 值）。
   */
  it('总评是一格 antd Statistic，且用正文档字号', () => {
    render(view(score()));
    const stat = screen.getByText('总评').closest('.ant-statistic');
    expect(stat).not.toBeNull();
    expect(stat?.querySelector('.ant-statistic-content-value')?.textContent).toBe('生产代码到位，测试缺失');
    expect(stat?.querySelector<HTMLElement>('.ant-statistic-content')?.style.fontSize).toBe('14px');
  });

  /**
   * 逐项明细的**形态**守卫（折叠面板套 `Table size="small"`）。
   *
   * 为什么值得一条：换成表格是**观感与可读性**的改动，没有任何行为断言会因此变红
   * （旧版是手写的 Flex 行，同样能把每个字段渲染出来）。四条判据各拦一种退化：
   * ① 行真的是 `<tr>`——退回手写行时红，而**上一组守卫的 `data-testid` 口径不必改**
   *   （这也是这次改版刻意保留的契约：标记仍挂在候选上，不是挪进某个单元格）；
   * ② **一组一个折叠面板、面板里一张表**——两组两个面板、两张表；摊成一张大表时红；
   * ③ 两个面板**默认都展开**（`.ant-collapse-item-active` + 两张表都在 DOM 里）：
   *   把 `defaultActiveKey` 去掉（或只给第一组）时，未展开的那张表根本不在 DOM 里；
   * ④ 紧凑尺寸（`size="small"` 在 antd 里落到 `.ant-table-small`；antd 6 的枚举是
   *   `large | medium | small`）——把尺寸去掉时红。
   *
   * ② 的判据是 `.ant-table-wrapper` 而**不是**裸 `table`：正文里以后若再出现
   * `Descriptions`（antd 自己用 `<table>` 实现），数裸标签会把那一张也数进来
   * ——判据必须点名「评分表那几张表」，否则每加一个 Descriptions 都要来改这个数。
   */
  it('逐项明细是折叠面板套表格、紧凑尺寸，一组一个面板且默认全部展开', () => {
    const twoGroups: Rubric = {
      groups: [
        { name: '一、生产代码', items: [{ id: 'A1', goal: '追加 agent 字段', weight: 18 }] },
        { name: '二、测试', items: [{ id: 'D1', goal: '补透传用例', weight: 14 }] },
      ],
    };
    const { container } = render(view(score(), twoGroups));

    expect(screen.getByTestId('score-judgment-A1').tagName).toBe('TR');
    expect(container.querySelectorAll('.ant-table-wrapper')).toHaveLength(2);
    expect(container.querySelectorAll('.ant-table-small')).toHaveLength(2);

    const panels = [...container.querySelectorAll('[data-testid="score-rubric-groups"] .ant-collapse-item')];
    expect(panels).toHaveLength(2);
    // 每个面板里恰好一张表（面板包着表，不是两组各自独立地排在页面上）
    for (const panel of panels) expect(panel.querySelectorAll('.ant-table-wrapper')).toHaveLength(1);
    // 默认全部展开；两张表的候选都真的渲染出来（收起的面板不会渲染 children）
    expect(container.querySelectorAll('.ant-collapse-item-active')).toHaveLength(2);
    expect(screen.getByTestId('score-judgment-D1')).toBeInTheDocument();
  });

  /**
   * **列几何守卫**：两组各是一张独立的 `<table>`，而浏览器在 `table-layout: auto` 下按每张表
   * 自己的内容算列宽 ⇒ 同一列在上下两组里落在不同的横坐标上（截图里就是「列位置没对齐」）。
   * 判据分三层：
   * ① 每张表都 `table-layout: fixed`；
   * ② 五列宽度定义逐列**完全一致**（表与表之间）；
   * ③ 目标列**没有宽度**（吃其余列剩下的宽度，内容长了在列内折行）。
   * 把 `tableLayout` 删掉、把某列的百分比换回像素、或给目标列补一个宽度时，这一条都会红。
   */
  it('每张表共用同一套列几何（fixed 布局、目标列自适应剩余宽度）', () => {
    const twoGroups: Rubric = {
      groups: [
        { name: '一、生产代码', items: [{ id: 'A1', goal: '追加 agent 字段', weight: 18 }] },
        { name: '二、测试', items: [{ id: 'D1', goal: '补透传用例', weight: 14 }] },
      ],
    };
    const { container } = render(view(score(), twoGroups));

    const tables = [...container.querySelectorAll<HTMLTableElement>('.ant-table-content > table')];
    expect(tables).toHaveLength(2);

    // 列宽由 rc-table 写进 `<colgroup><col style="width: …">`：没给宽度的列读到空串
    const geometries = tables.map((table) => {
      expect(table).toHaveStyle({ tableLayout: 'fixed' });
      return [...table.querySelectorAll<HTMLElement>('colgroup > col')].map((col) => col.style.width);
    });
    // 引用键 / 目标 / 权重 / 判定 / 理由（顺序与 COLUMNS 一致）；目标是唯一没有宽度的列
    expect(geometries[0]).toEqual(['12%', '', '10%', '12%', '28%']);
    expect(geometries[1]).toEqual(geometries[0]);
  });

  it('总分原样显示权威值，**不在前端重算**（18 分就是 18，不是按权重现场算出来的别的数）', () => {
    // 若有人在这里「按评分表重算」，会得到 18（这一份恰好相同）——所以刻意再给一个不同的权威值
    render(view(score({ totalScore: 7 })));
    expect(screen.getByText('7')).toBeInTheDocument();
    expect(screen.queryByText('18')).toBeNull();
  });

  it('未达成的项与达成的项长得不一样（它是使用者要看的重点）', () => {
    render(view(score()));
    const achievedCandidate = screen.getByTestId('score-judgment-A1');
    const missedCandidate = screen.getByTestId('score-judgment-D1');
    expect(achievedCandidate).toHaveAttribute('data-achieved', 'yes');
    expect(missedCandidate).toHaveAttribute('data-achieved', 'no');
    expect(achievedCandidate.textContent).toContain('达成');
    expect(missedCandidate.textContent).toContain('未达成');
  });

  /**
   * 未达成那一候选的**语义色**是另一半：只钉 `data-achieved` 与文案的话，把这个候选改成与达成项同色
   * （或干脆去掉颜色）不会有任何东西红，而「一眼扫出哪几项没做到」正是这个候选的用处。
   *
   * 判据是**渲染出来的候选内 style**（探针实测：颜色落在这一格的 `style.color` 上，达成项那一格是空串）。
   * 这一份刻意把主题的 `colorError` 换成 `CUSTOM_COLOR_ERROR`（≠ 默认值）：于是「颜色来自 antd 的
   * token」这句话才被断言兑现——**写死任何字面量都会红**，包括写死当前默认的 `#ff4d4f`
   * （只拿默认 token 当基准时，写死默认值照样通过，那是一条比它看起来更弱的断言）。
   * 归一化那一步不能省：jsdom 把 `#123456` 序列化成 `rgb(18, 52, 86)`，直接比原值会假红。
   */
  it('未达成的项带 antd 的语义色、达成的项不带（换成自定义 token 后颜色仍跟着走）', () => {
    render(
      <ConfigProvider theme={{ token: { colorError: CUSTOM_COLOR_ERROR } }}>
        {view(score())}
      </ConfigProvider>,
    );
    // 同一个自定义值在 jsdom 里走一遍同样的序列化，作为比较基准（不写死序列化后的形式）
    const probe = document.createElement('span');
    probe.style.color = CUSTOM_COLOR_ERROR;

    const achievedCandidate = screen.getByTestId('score-judgment-A1');
    const missedCandidate = screen.getByTestId('score-judgment-D1');
    expect(missedCandidate.style.color).not.toBe('');
    expect(missedCandidate.style.color).toBe(probe.style.color);
    expect(achievedCandidate.style.color).toBe('');
  });

  /**
   * 判定与评分表按**引用键**对齐。找不到说明数据不一致——那种「看起来正常」的表格比报错危险得多，
   * 故本组件只在**渲染期**跳过（不抛），但把缺席的项显式画出来。
   */
  it('评分表里有、判定里没有的项被显式标出（不静默跳过）', () => {
    render(view(score({ judgments: [{ id: 'A1', achieved: true, reason: '好' }] })));
    expect(screen.getByText(/缺少判定/)).toBeInTheDocument();
  });

  it('满分来自 maxScore（不是常量 100）', () => {
    render(view(score({ totalScore: 300, maxScore: 300 })));
    const summary = within(screen.getByTestId('score-total'));
    expect(summary.getByText('/300')).toBeInTheDocument();
  });

  /**
   * 评分时间与用量 / 耗时**同一行**：三者回答的都是「这一分花了多少、什么时候落下来的」。
   * 底部没有记账行——`structuredOutput` 只留在契约里，不上界面。
   * 反向判据才是这一条的判别力：`输出约束` / `评分时间` 这两个标签一旦出现就红。
   */
  it('评分时间在用量那一个候选里，底部不设记账行', () => {
    render(view(score({ structuredOutput: true })));

    const usage = within(screen.getByTestId('score-judge-usage'));
    expect(usage.getByText(`时间 ${formatDateTime('2026-09-29T08:10:00.000Z')}`)).toBeInTheDocument();
    expect(screen.queryByText(/输出约束/)).toBeNull();
    expect(screen.queryByText(/评分时间/)).toBeNull();
  });
});

/**
 * 抽屉**底部的两行**（这一段说的是**这一分**，不是被评那一行）。
 *
 * 五格全部取自 `score`：评分智能体（`judgeAgentKind`，文本通路写「文本 API」）/ 评分模型
 * （`judgeModelId`）/ 思考强度（`judgeEffort`）/ 评分用量（`judgeTokens`）/ 评分耗时
 * （`judgeDurationMs`）。形态是**两行、无标题**（标题 + 五候选的形态已不在
 * `Descriptions`）：第一行「这一分是谁打的」（三个值走 `Tag`、一色一格：`blue` / `geekblue` /
 * `purple`），第二行「花了多少」（用量 / 耗时），分组**显式**、不靠自然折行。
 *
 * 为什么值得一组守卫：
 *   · **读候选那五格就会让人拿执行的花销去理解评分**——两件事差了整整一个阶段。
 *     本组用例就是这条口径的钉子：`score` 里没有的
 *     值一个都不许出现，候选那一套（`claude-opus-4-6` / 128,450 tok / 383s）也不再是夹具；
 *   · **「没采到」与 `0` 必须分得开**：`0` 是一个读数（真的没花），「没采到」不是
 *     （这一家适配器 / 网关压根不报）。界面上长得一样时，读者会拿一个假的 0 去横向比较；
 *   · 「两条通路」之分（智能体会话 vs 纯文本 API）也靠这一格：它们的分数**不可比**，
 *     故文本通路必须写明「文本 API」而不是留空或写厂商名。
 */
describe('评分运行信息（抽屉底部那两行）', () => {
  /**
   * **位置在正文最底部**：读者先看分数、总评与逐项证据，最后才回看元信息。
   * 判据用 DOM 顺序而不是样式：搬回顶部时 `compareDocumentPosition` 直接给出相反的结论。
   */
  it('评分运行信息排在评分表之后（正文最底部）', () => {
    const { container } = render(view(score()));

    const groups = screen.getByTestId('score-rubric-groups');
    const info = screen.getByTestId('score-run-info');
    expect(container.contains(info)).toBe(true);
    // FOLLOWING 位为真 ⇒ info 在 groups 之后（Node 常量在 jsdom 里可用）
    expect(groups.compareDocumentPosition(info) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
  });

  /**
   * **分组是显式的**：第一行只放「这个候选是谁在跑」（智能体 / 模型 /
   * 思考强度），第二行放「跑了多少」（用量 / 耗时）。
   *
   * 为什么要钉：两层都带 `wrap`，自然折候选会把**用量**那一格挤进第一行、把「耗时」甩到第二行单独挂着
   * ——量化信息散成两处，而屏上看不出这有什么不对（正是「看起来正常」的那类退化）。
   * 判据落在两个候选的**数据属性**上（不是 class）：合并成一层 Flex 时这两格都找不到，用例直接红。
   */
  it('分组显式：第一行「谁打的」，第二行「花了多少」（不靠自然折行）', () => {
    render(view(score({ judgeAgentKind: 'cc', judgeModelId: 'claude-opus-4-6', judgeEffort: 'max' })));

    const meta = within(screen.getByTestId('score-judge-meta'));
    expect(meta.getByText('评分智能体')).toBeInTheDocument();
    expect(meta.getByText(AGENT_LABELS['cc'])).toBeInTheDocument();
    expect(meta.getByText('评分模型')).toBeInTheDocument();
    expect(meta.getByText('claude-opus-4-6')).toBeInTheDocument();
    expect(meta.getByText('思考强度')).toBeInTheDocument();
    // 「颜色不随取值变」的另一半在这里（下面那条钉的是文本通路与 `off`）：`max` 也是同一个紫
    expect(meta.getByText('max')).toHaveClass('ant-tag-purple');
    expect(meta.queryByText('耗时')).toBeNull();
    // 用量与耗时都在第二行，一个也不许留在第一行
    expect(meta.queryByText(/tok/)).toBeNull();

    const usage = within(screen.getByTestId('score-judge-usage'));
    expect(usage.getByText('输入 1,200 tok · 缓存 800 tok · 输出 300 tok')).toBeInTheDocument();
    expect(usage.getByText('耗时 29s')).toBeInTheDocument();
    expect(usage.getByText(`时间 ${formatDateTime('2026-09-29T08:10:00.000Z')}`)).toBeInTheDocument();
    expect(usage.queryByText('评分模型')).toBeNull();
  });

  /**
   * 第一行那三个值走 antd **`Tag`、一色一格**：评分智能体 `blue` /
   * 评分模型 `geekblue` / 思考强度 `purple`（与候选卡片上那个档位 Tag 同色——同一个档位在本仓长得一样）。
   * 标签（「评分智能体」等）留在 Tag 外面：一个 Tag 里塞两种语义会让人读不出哪个是标签、哪个是值。
   *
   * 为什么判据落在 **class**上：`Tag` 的预设色本来就只体现为这个 class（只有自定义 hex 才走候选内
   * style），而这里要守的恰恰是「哪一格是哪个预设色」。**「颜色不随取值变」那一半也在这条里**：
   * 关闭档与「未指定」同为紫、文本通路与三家智能体同为蓝——值不同、class 相同；档位之间没有排名口径
   *，驱动者之间也没有强弱口径，换个颜色就是把一个没证实的结论画进界面。
   */
  it('三个值走 Tag、一色一格（blue / geekblue / purple），且颜色不随取值变', () => {
    const { unmount } = render(view(score({ judgeAgentKind: 'dsh', judgeEffort: 'off' })));

    const meta = within(screen.getByTestId('score-judge-meta'));
    expect(meta.getByText(AGENT_LABELS.dsh)).toHaveClass('ant-tag-blue');
    expect(meta.getByText('deepseek-chat')).toHaveClass('ant-tag-geekblue');
    expect(meta.getByText('off')).toHaveClass('ant-tag-purple');
    unmount();

    // 文本通路：同一个蓝（底色说的是「这是哪一个槽位」，不是取值的好坏）
    render(view(score()));
    expect(within(screen.getByTestId('score-judge-meta')).getByText('文本 API')).toHaveClass('ant-tag-blue');
  });

  /**
   * **两条通路在界面上必须分得开**（展示表）：`judgeAgentKind === null` 是纯文本 API 评分
   * ——它**没有智能体驱动它**（`judge-route.ts` 的原话）。那一格写「文本 API」；写厂商名是假话，
   * 留空则让两条通路在界面上再也分不出来（而它们的分数**不可比**，README「分数怎么来的」）。
   *
   * 反向判据：三个智能体的名字一个都不许出现——旧版那句「评分智能体：X · 模型：Y」在文本通路上
   * 根本不存在，现在它变成了一格**恒有**的槽位，故「文本通路会不会顺手写一家智能体」必须被钉住。
   */
  it('文本通路那一格写「文本 API」，不假装有智能体', () => {
    render(view(score()));

    const meta = within(screen.getByTestId('score-judge-meta'));
    expect(meta.getByText('文本 API')).toBeInTheDocument();
    expect(meta.getByText('deepseek-chat')).toBeInTheDocument();
    for (const label of Object.values(AGENT_LABELS)) expect(meta.queryByText(label)).toBeNull();
  });

  /**
   * 五格都在，且**「没采到」不写成 0**（这两格是后来加的落盘字段，老记录读回是 `null`）。
   *
   * 反向判据（两条 `queryByText`）才是这一条的判别力所在：只断言「有『用量未采集』四个字」的话，
   * 回落到 `formatUsageTriple(score.judgeTokens ?? { input: 0, … })` 照样能通过正向那半
   * （那正是「0 与没采到分不开」的写法）。
   */
  it('五格都在，且「没采到」写「用量未采集」/「未采集」而不是 0', () => {
    render(view(score({ judgeTokens: null, judgeDurationMs: null, judgeEffort: null })));

    const info = within(screen.getByTestId('score-run-info'));
    expect(info.getByText('评分智能体')).toBeInTheDocument();
    expect(info.getByText('文本 API')).toBeInTheDocument();
    expect(info.getByText('评分模型')).toBeInTheDocument();
    expect(info.getByText('deepseek-chat')).toBeInTheDocument();
    // 未指定档位（`judgeEffort` 缺键 ⇒ 契约的 `.default(null)`，老记录都是这一支）⇒「未指定」，不是空白。
    // 标签与值是两个元素（值在 Tag 里、标签留在外面）：断言因此也分成两条
    expect(info.getByText('思考强度')).toBeInTheDocument();
    expect(info.getByText('未指定')).toBeInTheDocument();
    expect(info.getByText('用量未采集')).toBeInTheDocument();
    expect(info.getByText('耗时 未采集')).toBeInTheDocument();

    // 反向判据：这两句是「没采到被写成了 0」的样子
    expect(screen.queryByText(/输入 0 tok/)).toBeNull();
    expect(screen.queryByText('耗时 0s')).toBeNull();
  });

  /**
   * 有用量时走**既有出口**：`formatUsageTriple`（千分位 + `tok`）与 `formatDuration`
   * ——与事实条 / 里程碑 / 逐条页脚 / 子任务卡片是同一份文案（各写一份模板就必然漂移）。
   * 只在**这一格**里断言整串：别处那几张面各有自己的守卫。
   */
  it('有用量时走 formatUsageTriple（千分位 + tok），耗时走 formatDuration', () => {
    render(
      view(score({ judgeTokens: { input: 15_763, cached: 45_824, output: 2_164 }, judgeDurationMs: 192_000 })),
    );

    const info = within(screen.getByTestId('score-run-info'));
    expect(info.getByText('输入 15,763 tok · 缓存 45,824 tok · 输出 2,164 tok')).toBeInTheDocument();
    expect(info.getByText('耗时 3m12s')).toBeInTheDocument();
  });

  /**
   * 另一半：**真实的 0 照常显示成 0**（`0 tok` / `0s` 是读数，不是「没采到」）。
   * 判据是「`null` 才拦」——写成 `!score.judgeTokens` 或 `judgeTokens.input === 0` 这类真值判断时这一条红。
   * 与上一条合起来才把「0 与没采到分得开」这句话钉成两个方向。
   */
  it('真的 0 照常显示成 0（拦住 `!judgeTokens` 那类真值判断）', () => {
    render(view(score({ judgeTokens: { input: 0, cached: 0, output: 0 }, judgeDurationMs: 0 })));

    const info = within(screen.getByTestId('score-run-info'));
    expect(info.getByText('输入 0 tok · 缓存 0 tok · 输出 0 tok')).toBeInTheDocument();
    expect(info.getByText('耗时 0s')).toBeInTheDocument();
    expect(info.queryByText('用量未采集')).toBeNull();
    expect(info.queryByText('耗时 未采集')).toBeNull();
  });

  /**
   * 显式关闭档**逐字写 `off`**，不并进「未指定」：`off` 说的是
   * 「我关掉思考」，「未指定」说的是「我没选」。两者并成一句之后，「这一分为什么没有思考」
   * 在界面上就再也读不出来了（`off` 与 `未指定` 在数据上也是两回事：前者是显式键，后者是缺键）。
   */
  it('显式关闭档逐字写 `off`，不写「未指定」', () => {
    render(view(score({ judgeEffort: 'off' })));

    const info = within(screen.getByTestId('score-run-info'));
    expect(info.getByText('思考强度')).toBeInTheDocument();
    expect(info.getByText('off')).toBeInTheDocument();
    expect(info.queryByText('未指定')).toBeNull();
  });

  /**
   * **候选那一套数据一格都不许出现**：下面这些哨兵值就是候选那一套
   * （`cc` / `claude-opus-4-6` / 128,450 tok / 6m23s）。
   * 组件已经不吃候选（`ScoreDetailViewProps` 里没有 `row`），把那一格接回来、或让某处回落到它时，
   * 这一条立刻红。页面那一侧的对应守卫是 `apps/web-next/src/runs-page-wiring.test.ts` 的反向断言。
   */
  it('候选那一套值一个都不出现（这一段说的是评分，不是执行）', () => {
    render(view(score({ judgeTokens: { input: 15_763, cached: 45_824, output: 2_164 }, judgeDurationMs: 192_000 })));

    expect(screen.queryByText('候选运行信息')).toBeNull();
    expect(screen.queryByText(AGENT_LABELS['cc'])).toBeNull();
    expect(screen.queryByText('claude-opus-4-6')).toBeNull();
    expect(screen.queryByText(/128,450/)).toBeNull();
    expect(screen.queryByText(/6m23s/)).toBeNull();
  });
});

/**
 * 评分原始输出（口径 9）：评审会话的 `log` 事件逐字原文。入口按钮在页面 footer 上
 * （判据与接线守卫都在 `apps/web-next/src/runs-page-wiring.test.ts`），这里只守正文：
 * 受控开合、三态画面、行渲染与执行日志的原文面板同形、judging 提示与空态的分野。
 */
describe('评分原始输出（judgeOutput 那一组）', () => {
  const JUDGE_LINES: AgentLogDiagnostics = {
    lines: [
      { at: '2026-10-02T08:00:01.000Z', source: 'stdout', text: '评审者读了 diff', summary: '调用工具 Read' },
      { at: '2026-10-02T08:00:02.000Z', source: 'stderr', text: '一条警告', summary: null },
    ],
    truncatedReason: null,
  };

  /** judgeOutput 那一组 props 的缺省形状：正文三态、开合、提示都由用例覆盖 */
  function judgeOutput(overrides: Partial<ScoreJudgeOutputProps> = {}): ScoreJudgeOutputProps {
    return {
      state: { status: 'ready', data: JUDGE_LINES },
      errorText: null,
      judging: false,
      liveError: null,
      onRetry: vi.fn(),
      open: true,
      onOpenChange: vi.fn(),
      ...overrides,
    };
  }

  /** 渲染整件（judgeOutput 默认不给：那是「这个候选没有入口」的形状） */
  function judgeView(props?: ScoreJudgeOutputProps): ReactNode {
    return (
      <ScoreDetailView
        score={score({ judgeAgentKind: 'dsh' })}
        rubric={RUBRIC}
        {...(props === undefined ? {} : { judgeOutput: props })}
      />
    );
  }

  it('judgeOutput 不给 ⇒ 连抽屉都不渲染（这个候选没有这个入口，判据在页面那一层）', () => {
    render(judgeView());
    expect(screen.queryByTestId('score-judge-output-body')).toBeNull();
    // 入口按钮不属于本视图（在页面 footer 上）
    expect(screen.queryByTestId('score-judge-output-open')).toBeNull();
  });

  it('受控：关着时正文不在 DOM；打开后标题「原始输出 N 条」与入口同文、行渲染与执行日志同形', () => {
    const { unmount } = render(judgeView(judgeOutput({ open: false })));
    // destroyOnHidden：关着时正文一个节点都不在 DOM 里
    expect(screen.queryByTestId('score-judge-output-body')).toBeNull();
    unmount();

    render(judgeView(judgeOutput({ open: true })));

    // 标题带条数、只出现一处（入口按钮在页面那一层，不在本视图）
    expect(screen.getAllByText('原始输出 2 条')).toHaveLength(1);
    // 行渲染与执行日志的「原始输出」面板共用一份（diagnosticsBody）：同一批 testid、同一形态
    expect(screen.getAllByTestId('raw-output-line')).toHaveLength(2);
    // summary 优先、原文照给（与 raw-output-panel 同口径）
    expect(screen.getByText('调用工具 Read')).toBeInTheDocument();
    expect(screen.getByText(/^\[\d{2}:\d{2}:\d{2}\] stdout 评审者读了 diff$/)).toBeInTheDocument();
    expect(screen.getByText(/^\[\d{2}:\d{2}:\d{2}\] stderr 一条警告$/)).toBeInTheDocument();
  });

  it('0 条原文也是入口（空态写在正文里，不靠藏按钮）：终态与 judging 的空态各说各的', () => {
    const { unmount } = render(
      judgeView(judgeOutput({ state: { status: 'ready', data: { lines: [], truncatedReason: null } } })),
    );
    // 标题如实写 0 条（「原始输出 0 条」是一个读数，不是「没有入口」）
    expect(screen.getAllByText('原始输出 0 条')).toHaveLength(1);
    expect(screen.getByText('这个候选评分没有留下原始输出记录')).toBeInTheDocument();
    unmount();

    // judging 期间的 0 条是「评分刚开始」——judging ⇔ 无分，说「没有留下」是把进行中说成了终态
    render(judgeView(judgeOutput({ state: { status: 'ready', data: { lines: [], truncatedReason: null } }, judging: true })));
    expect(screen.getByText('评分刚开始，还没有原始输出记录')).toBeInTheDocument();
    expect(screen.getByText('正在评分，以下为当前尝试的输出')).toBeInTheDocument();
  });

  it('读取失败 ⇒ Alert + 已折好的中文原因 + 重试按钮（点了回调一次）', () => {
    const onRetry = vi.fn();
    render(judgeView(judgeOutput({ state: { status: 'error', error: new Error('x') }, errorText: '读取评分日志失败（磁盘）', onRetry })));

    expect(screen.getByText('评分原始输出读取失败')).toBeInTheDocument();
    expect(screen.getByText('读取评分日志失败（磁盘）')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('读取中 ⇒ 骨架屏（不是一个空抽屉）', () => {
    render(judgeView(judgeOutput({ state: { status: 'loading' } })));
    expect(document.querySelectorAll('.ant-skeleton').length).toBeGreaterThan(0);
  });

  it('实时连接故障 ⇒ 一行警示，且已收内容不受影响', () => {
    render(judgeView(judgeOutput({ liveError: '实时连接中断：浏览器会自动重连，已收到的输出不受影响' })));
    expect(screen.getByTestId('score-judge-live-error')).toHaveTextContent('实时连接中断');
    expect(screen.getAllByTestId('raw-output-line')).toHaveLength(2);
  });
});
