/**
 * ScoreDetailView：总分 + 逐项达成 / 未达成 + 理由 + 总评 + 评分者 + 原始返回。
 * 六条守卫：
 *   1. **总分原样显示 `score.totalScore`，前端不重算**（它是服务端按权重加总出来的权威值）；
 *   2. **未达成的项要能被看出来**（它们才是使用者要看的重点，不能与达成项长得一样）——
 *      数据属性 / 文案一条，**语义色**另一条（只钉前者的话，把颜色改掉没有任何东西会红）；
 *   3. **判定按引用键与评分表对齐**：缺一项说明数据不一致，此时**不静默跳过**；
 *   4. 满分来自 `maxScore`（不是常量 100）；
 *   5. 评分者那一行**两条通路**与**输出约束两种取值**都逐字钉住（谁打的这一分 + 我们提交了什么）；
 *   6. 逐项明细是一张 antd **表格、紧凑尺寸**（`size="small"`，用户 2026-10-03 口径），
 *      且**一组一张表**——分组是评分表自己的结构；
 *   7. **原始返回的入口与正文分居两处**（用户 2026-10-04 口径）：入口按钮在主抽屉的 `footer` 上
 *      （由页面渲染，故**本视图里没有那个按钮**），正文是这一层的二级抽屉、开合**受控**
 *      （`rawOpen` / `onRawOpenChange`）；正文走 `JsonText`——是 JSON 就缩进格式化 + 高亮，
 *      不是就逐字原样，**围栏行始终逐字**。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ConfigProvider } from 'antd';
import type { ReactNode } from 'react';
import { AGENT_LABELS, type Rubric, type ScoreResult } from '@aieval/contracts';
import { formatDateTime } from '../base/format';
import { installResizeObserverStub } from '../testing/resize-observer';
import { ScoreDetailView } from './score-detail-view';

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
    structuredOutput: false,
    ...overrides,
  };
}

/**
 * 渲染这一格：二级抽屉的开合是**受控**的（口径 7，入口按钮在页面那一层），故每个用例都要给出
 * 这一对 props。默认关着——「关着时正文不在 DOM」本身就是一条判据。
 */
function view(scoreResult: ScoreResult, rubric: Rubric = RUBRIC, rawOpen = false): ReactNode {
  return <ScoreDetailView score={scoreResult} rubric={rubric} rawOpen={rawOpen} onRawOpenChange={vi.fn()} />;
}

describe('ScoreDetailView', () => {
  it('总分、满分、逐项目标与理由、总评、评分者都在', () => {
    render(view(score()));
    expect(screen.getByText('18')).toBeInTheDocument();
    expect(screen.getByText(/满分 32 分/)).toBeInTheDocument();
    expect(screen.getByText('追加 agent 字段')).toBeInTheDocument();
    expect(screen.getByText('字段进了契约')).toBeInTheDocument();
    expect(screen.getByText('生产代码到位，测试缺失')).toBeInTheDocument();
    expect(screen.getByText(/deepseek-chat/)).toBeInTheDocument();
  });

  /**
   * 逐项明细的**形态**守卫（用户 2026-10-03 口径：`Table size="small"`）。
   *
   * 为什么值得一条：换成表格是**观感与可读性**的改动，没有任何行为断言会因此变红
   * （旧版是手写的 Flex 行，同样能把每个字段渲染出来）。三条判据各拦一种退化：
   * ① 行真的是 `<tr>`——退回手写行时红，而**上一组守卫的 `data-testid` 口径不必改**
   *   （这也是这次改版刻意保留的契约：标记仍挂在行上，不是挪进某个单元格）；
   * ② **一组一张表**——两组各一张，摊成一张大表时红；
   * ③ 紧凑尺寸（`size="small"` 在 antd 里落到 `.ant-table-small`；antd 6 的枚举是
   *   `large | medium | small`）——把尺寸去掉时红。
   */
  it('逐项明细走 antd 表格、紧凑尺寸，且一组一张表', () => {
    const twoGroups: Rubric = {
      groups: [
        { name: '一、生产代码', items: [{ id: 'A1', goal: '追加 agent 字段', weight: 18 }] },
        { name: '二、测试', items: [{ id: 'D1', goal: '补透传用例', weight: 14 }] },
      ],
    };
    const { container } = render(view(score(), twoGroups));

    expect(screen.getByTestId('score-judgment-A1').tagName).toBe('TR');
    expect(container.querySelectorAll('table')).toHaveLength(2);
    expect(container.querySelectorAll('.ant-table-small')).toHaveLength(2);
  });

  it('总分原样显示权威值，**不在前端重算**（18 分就是 18，不是按权重现场算出来的别的数）', () => {
    // 若有人在这里「按评分表重算」，会得到 18（这一份恰好相同）——所以刻意再给一个不同的权威值
    render(view(score({ totalScore: 7 })));
    expect(screen.getByText('7')).toBeInTheDocument();
    expect(screen.queryByText('18')).toBeNull();
  });

  it('未达成的项与达成的项长得不一样（它是使用者要看的重点）', () => {
    render(view(score()));
    const achievedRow = screen.getByTestId('score-judgment-A1');
    const missedRow = screen.getByTestId('score-judgment-D1');
    expect(achievedRow).toHaveAttribute('data-achieved', 'yes');
    expect(missedRow).toHaveAttribute('data-achieved', 'no');
    expect(achievedRow.textContent).toContain('达成');
    expect(missedRow.textContent).toContain('未达成');
  });

  /**
   * 未达成那一行的**语义色**是另一半：只钉 `data-achieved` 与文案的话，把这一行改成与达成项同色
   * （或干脆去掉颜色）不会有任何东西红，而「一眼扫出哪几项没做到」正是这一行的用处。
   *
   * 判据是**渲染出来的行内 style**（探针实测：颜色落在这一格的 `style.color` 上，达成项那一格是空串）。
   * 这一份刻意把主题的 `colorError` 换成 `CUSTOM_COLOR_ERROR`（≠ 默认值）：于是「颜色来自 antd 的
   * token」这句话才被断言兑现——**写死任何字面量都会红**，包括写死当前默认的 `#ff4d4f`
   *（只拿默认 token 当基准时，写死默认值照样通过，那是一条比它看起来更弱的断言）。
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

    const achievedRow = screen.getByTestId('score-judgment-A1');
    const missedRow = screen.getByTestId('score-judgment-D1');
    expect(missedRow.style.color).not.toBe('');
    expect(missedRow.style.color).toBe(probe.style.color);
    expect(achievedRow.style.color).toBe('');
  });

  /**
   * 判定与评分表按**引用键**对齐。找不到说明数据不一致——那种「看起来正常」的表格比报错危险得多，
   * 故本组件只在**渲染期**跳过（不抛），但把缺席的项显式画出来。
   */
  it('评分表里有、判定里没有的项被显式标出（不静默跳过）', () => {
    render(view(score({ judgments: [{ id: 'A1', achieved: true, reason: '好' }] })));
    expect(screen.getByText(/缺少判定/)).toBeInTheDocument();
  });

  /**
   * 原始返回的**入口与正文分居两处**（用户 2026-10-04 口径）：入口按钮在主抽屉的 `footer` 上
   * （页面渲染），正文是这一层的二级抽屉、开合**受控**。三条判据各拦一种退化：
   *   ① 关着时正文不在 DOM（`destroyOnHidden`——这正是「原文不占正文高度」的判据）；
   *   ② 调用方把 `rawOpen` 置真之后正文才进 DOM（受控：本件不许自作主张）；
   *   ③ **本视图里没有那个入口按钮**——把它加回正文就等于「标题 + 按钮」那一行又回来了，
   *      而那正是这次要拆掉的东西（占正文高度、还随正文一起滚走）。
   */
  it('原始返回的正文在受控的二级抽屉里，且视图正文里没有入口按钮', () => {
    const prose = '这不是 JSON，模型回了一段散文';
    const { unmount } = render(view(score({ raw: prose })));

    // 关着时正文一个节点都不在 DOM 里（`destroyOnHidden`）
    expect(screen.queryByTestId('score-raw')).toBeNull();
    // 入口按钮不属于本视图（它在页面的 footer 上，判据见 apps/web-next 的接线守卫）
    expect(screen.queryByTestId('score-raw-open')).toBeNull();
    // 正文里那一行「模型原始返回」标题已拆掉：关着时这个字符串在页面上一个都不该有
    expect(screen.queryByText('模型原始返回')).toBeNull();
    unmount();

    // 用 `render` + 受控 props 而不是裸 `.click()`：入口已经不在这一层了
    render(view(score({ raw: prose }), RUBRIC, true));
    expect(screen.getByTestId('score-raw')).toHaveTextContent(prose);
    // 打开后这句话只剩**一处**——二级抽屉自己的标题（原来它还有正文里那一份）
    expect(screen.getAllByText('模型原始返回')).toHaveLength(1);
  });

  /**
   * **围栏本身也是排障线索**：真实的评分返回常是一段 ```json 围栏（提示词就是这么要求的），
   * 而围栏标记逐字可见才是这一格的判据——**这一条是本组里唯一有判别力的那一半**：
   * 散文喂给 markdown 渲染器也会原样通过，只有围栏会**被它吃掉**（```json 变成 `<pre><code>`，
   * 反引号消失、内容被当代码块处理）。换句话说，这条守的就是「raw 不许走 markdown 渲染」。
   *
   * 口径变更（2026-10-04，用户口径：JSON 要高亮格式化）只动了**围栏里面**：载荷从
   * `"totalScore":90` 变成 `"totalScore": 90`（缩进 + 冒号后的空格），并带上高亮 token。
   * **围栏标记仍然逐字**，故「不许被当 markdown 渲染」这条由首尾两行继续钉住。
   */
  it('围栏 JSON：围栏行逐字保留，载荷已格式化并带高亮', () => {
    render(view(score({ raw: '```json\n{"totalScore":90,"judgments":[]}\n```' }), RUBRIC, true));

    const raw = screen.getByTestId('score-raw');
    const text = raw.textContent ?? '';
    const lines = text.split('\n');
    // 围栏标记：markdown 渲染器会把它变成 <pre><code>（反引号一个不剩）
    expect(lines[0]).toBe('```json');
    expect(lines[lines.length - 1]).toBe('```');
    // 载荷：整段原文都在（键与值都在），只是被格式化了
    expect(text).toContain('  "totalScore": 90');
    expect(text).toContain('"judgments": []');
    // 反向判据：退回「逐字原文」时这一条必红（原文里冒号后没有空格）
    expect(text).not.toContain('"totalScore":90');
    // 高亮真的落在节点上（两个键）
    expect(raw.querySelectorAll('[data-json-token="key"]')).toHaveLength(2);
  });

  it('满分来自 maxScore（不是常量 100）', () => {
    render(view(score({ totalScore: 300, maxScore: 300 })));
    expect(screen.getByText(/满分 300 分/)).toBeInTheDocument();
  });

  /**
   * 评分者那一行分**两条通路**（spec §10 展示表）。这里是**智能体通路**：光有模型名回答不了
   * 「这一分是文本请求打的还是智能体会话打的」，而两条通路的分数不可比
   * （README「分数怎么来的」的既有口径）⇒ 智能体名与模型名必须同时在这一行里。
   * 整行逐字钉住：分隔符与顺序都不许动（老截图 / 老排障笔记里的文案仍然对得上）。
   */
  it('智能体评分时这一行写「评分智能体：X · 模型：Y」并接输出约束与时间', () => {
    render(view(score({ judgeAgentKind: 'dsh' })));

    expect(
      screen.getByText(
        `评分智能体：${AGENT_LABELS.dsh} · 模型：deepseek-chat · 输出约束：提示词约束 · 评分时间：${formatDateTime('2026-09-29T08:10:00.000Z')}`,
      ),
    ).toBeInTheDocument();
  });

  it('structuredOutput=true ⇒ 显示「输出约束：schema 约束」', () => {
    render(view(score({ structuredOutput: true })));

    expect(screen.getByText(/输出约束：schema 约束/)).toBeInTheDocument();
  });

  /**
   * `structuredOutput=false` 只是事实、不是错误（这一分只靠提示词契约拿到）：文案照写「提示词约束」，
   * 而且**不给任何告警样式**——否则界面会把一条正常记录说成异常。
   * 整行还顺带把**文本通路**那一段（「评分模型：…」）逐字锁住：这一份的 `judgeAgentKind` 是 `null`。
   *
   * 告警样式那两条判据的范围**只到「评分者那一行」这一格**（`getByText` 命中的就是承载这一行的 span）：
   * 扫整棵渲染子树时，视图里日后出现的**合法**告警（别处真有一条错误提示）会让这条守卫红在一件与它
   * 无关的事上——那种红会教人「把这条守卫删掉」，比没有守卫更坏。两条判据都保留：`querySelector`
   * 管这一行**内部**新增的告警元素，`className` 管这一行**自己**被加上告警类（元素查不到自身的 class，
   * 故两条不是重复）。已知边界：整行若被外层包进 `<Alert>`，告警类落在祖先上，这两条都看不见。
   */
  it('structuredOutput=false ⇒ 「输出约束：提示词约束」，且这一行不带任何告警样式', () => {
    render(view(score({ structuredOutput: false })));

    const scorerLine = screen.getByText(
      `评分模型：deepseek-chat · 输出约束：提示词约束 · 评分时间：${formatDateTime('2026-09-29T08:10:00.000Z')}`,
    );
    expect(scorerLine).toBeInTheDocument();
    expect(scorerLine.querySelector('.ant-alert, .ant-typography-danger, .ant-typography-warning')).toBeNull();
    expect(scorerLine.className).not.toMatch(/danger|warning/);
  });
});
