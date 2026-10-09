/**
 * ScoreDetailView：评分运行信息 + 总分 + 逐项达成 / 未达成 + 理由 + 总评 + 记账 + 原始返回。
 * 八条守卫：
 *   1. **总分原样显示 `score.totalScore`，前端不重算**（它是服务端按权重加总出来的权威值）；
 *   2. **未达成的项要能被看出来**（它们才是使用者要看的重点，不能与达成项长得一样）——
 *      数据属性 / 文案一条，**语义色**另一条（只钉前者的话，把颜色改掉没有任何东西会红）；
 *   3. **判定按引用键与评分表对齐**：缺一项说明数据不一致，此时**不静默跳过**；
 *   4. 满分来自 `maxScore`（不是常量 100）；
 *   5. 底部记账那一行（输出约束 / 评分时间）两种取值逐字钉住；
 *   6. 逐项明细是一张 antd **表格、紧凑尺寸**（`size="small"`，用户 2026-10-03 口径），
 *      且**一组一张表**——分组是评分表自己的结构；
 *   7. **原始返回的入口与正文分居两处**（用户 2026-10-04 口径）：入口按钮在主抽屉的 `footer` 上
 *      （由页面渲染，故**本视图里没有那个按钮**），正文是这一层的二级抽屉、开合**受控**
 *      （`rawOpen` / `onRawOpenChange`）；正文走 `JsonText`——是 JSON 就缩进格式化 + 高亮，
 *      不是就逐字原样，**围栏行始终逐字**；
 *   8. **抽屉顶部那一段说的是「这一分是谁打的、花了多少」**（用户 2026-10-08 口径，形态沿用
 *      2026-10-07 晚的两行、无标题）：评分智能体 / 评分模型 / 思考强度 + 评分的用量 / 耗时，
 *      **五格全部来自 `score`**（`judgeAgentKind` / `judgeModelId` / `judgeEffort` / `judgeTokens` /
 *      `judgeDurationMs`）。⚠️ 2026-10-07 那一版说的是**被评那一行**（数据在 `EvalRow` 上），
 *      2026-10-08 整段换成评分的花销——候选的智能体 / 模型 / 用量 / 耗时**不再进这个抽屉**
 *      （行卡片与执行日志里都有）。故本文件不再需要行夹具，
 *      而「页面有没有把 row 又接回来」由 `apps/web-next/src/runs-page-wiring.test.ts` 反向钉住。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
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
    // 评分者那一行的强度**未指定**（`judgeEffort` 缺键 ⇒ 契约的 `.default(null)`）：这一格刻意与
    // 「候选 / 尺子」两条通路都脱钩——候选行的强度另有夹具（`rowFixture` 的 `effort: 'max'`），
    // 而评分者的两档（`max` / `off`）各有专门用例，不靠这一份默认值覆盖。
    judgeEffort: null,
    structuredOutput: false,
    /**
     * 评分**自己**的花销（2026-10-08）。与 `judgeEffort` 同一格口径：默认值要让「有用量」那几条
     * 判据读得出来（千分位 / 单位 / 时长格式），而「没采到」那一支由用例显式覆盖成 `null`。
     */
    judgeTokens: { input: 1_200, cached: 800, output: 300 },
    judgeDurationMs: 29_000,
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
   *
   * ② 的判据是 `.ant-table-wrapper` 而**不是**裸 `table`（2026-10-07 改）：抽屉顶部新加的
   * `Descriptions` **自己也是一个 `<table>`**（antd 的实现如此），数裸标签会把那一张也数进来
   * ——判据必须点名「评分表那几张表」，否则以后每加一个 Descriptions 都要来改这个数。
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
    expect(container.querySelectorAll('.ant-table-wrapper')).toHaveLength(2);
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
   * 记账那一行只留**两格**（2026-10-08 用户口径）：身份与强度已经搬到顶部那一段（本文件末尾那组），
   * 这一行再说一遍就是同一个事实两处各排一套。
   *
   * 两条通路（智能体 / 文本 API）在这一行的文案**逐字相同**——通路之分由顶部「评分智能体」那一格承担
   * （文本通路写「文本 API」）。反向判据是这一条真正的判别力所在：`· 模型：` 与 `评分智能体：` 这两种
   * 旧形态一旦被加回来，抽屉里就又有两处在说同一件事。
   */
  it('记账那一行只写输出约束与评分时间（身份与强度不再重复）', () => {
    const { unmount } = render(view(score({ judgeAgentKind: 'dsh', judgeEffort: 'max' })));
    expect(
      screen.getByText(`输出约束：提示词约束 · 评分时间：${formatDateTime('2026-09-29T08:10:00.000Z')}`),
    ).toBeInTheDocument();
    expect(screen.queryByText(/· 模型：/)).toBeNull();
    expect(screen.queryByText(/评分智能体：/)).toBeNull();
    unmount();

    // 文本通路（`judgeAgentKind === null`）同一句话：这一行不再按通路分叉
    render(view(score()));
    expect(
      screen.getByText(`输出约束：提示词约束 · 评分时间：${formatDateTime('2026-09-29T08:10:00.000Z')}`),
    ).toBeInTheDocument();
  });

  it('structuredOutput=true ⇒ 显示「输出约束：schema 约束」', () => {
    render(view(score({ structuredOutput: true })));

    expect(screen.getByText(/输出约束：schema 约束/)).toBeInTheDocument();
  });

  /**
   * `structuredOutput=false` 只是事实、不是错误（这一分只靠提示词契约拿到）：文案照写「提示词约束」，
   * 而且**不给任何告警样式**——否则界面会把一条正常记录说成异常。
   *
   * 告警样式那两条判据的范围**只到这一格**（`getByText` 命中的就是承载这一行的 span）：
   * 扫整棵渲染子树时，视图里日后出现的**合法**告警（别处真有一条错误提示）会让这条守卫红在一件与它
   * 无关的事上——那种红会教人「把这条守卫删掉」，比没有守卫更坏。两条判据都保留：`querySelector`
   * 管这一行**内部**新增的告警元素，`className` 管这一行**自己**被加上告警类（元素查不到自身的 class，
   * 故两条不是重复）。已知边界：整行若被外层包进 `<Alert>`，告警类落在祖先上，这两条都看不见。
   */
  it('structuredOutput=false ⇒ 「输出约束：提示词约束」，且这一行不带任何告警样式', () => {
    render(view(score({ structuredOutput: false })));

    const accountingLine = screen.getByText(
      `输出约束：提示词约束 · 评分时间：${formatDateTime('2026-09-29T08:10:00.000Z')}`,
    );
    expect(accountingLine).toBeInTheDocument();
    expect(accountingLine.querySelector('.ant-alert, .ant-typography-danger, .ant-typography-warning')).toBeNull();
    expect(accountingLine.className).not.toMatch(/danger|warning/);
  });
});

/**
 * 抽屉**顶部的两行**（用户 2026-10-08 口径：这一段说的是**这一分**，不是被评那一行）。
 *
 * 五格全部取自 `score`：评分智能体（`judgeAgentKind`，文本通路写「文本 API」）/ 评分模型
 * （`judgeModelId`）/ 思考强度（`judgeEffort`）/ 评分用量（`judgeTokens`）/ 评分耗时
 * （`judgeDurationMs`）。形态沿用 2026-10-07 晚的**两行、无标题**（此前那版是标题 + 五行
 * `Descriptions`）：第一行「这一分是谁打的」（三个值走 `Tag`、一色一格：`blue` / `geekblue` /
 * `purple`），第二行「花了多少」（用量 / 耗时），分组**显式**、不靠自然折行。
 *
 * 为什么值得一组守卫：
 *   · **2026-10-07 那一版读的是候选行**（`EvalRow` 的五格），读者会拿执行的花销去理解评分
 *     ——两件事差了整整一个阶段。本组用例就是那次口径翻转（2026-10-08）的钉子：`score` 里没有的
 *     值一个都不许出现，候选那一套（`claude-opus-4-6` / 128,450 tok / 383s）也不再是夹具；
 *   · **「没采到」与 `0` 必须分得开**：`0` 是一个读数（真的没花），「没采到」不是
 *     （这一家适配器 / 网关压根不报）。界面上长得一样时，读者会拿一个假的 0 去横向比较；
 *   · 「两条通路」之分（智能体会话 vs 纯文本 API）也靠这一格：它们的分数**不可比**，
 *     故文本通路必须写明「文本 API」而不是留空或写厂商名。
 */
describe('评分运行信息（抽屉顶部那两行）', () => {
  /**
   * **分组是显式的**（用户 2026-10-07 晚口径）：第一行只放「这一行是谁在跑」（智能体 / 模型 /
   * 思考强度），第二行放「跑了多少」（用量 / 耗时）。
   *
   * 为什么要钉：两层都带 `wrap`，自然折行会把**用量**那一格挤进第一行、把「耗时」甩到第二行单独挂着
   * ——量化信息散成两处，而屏上看不出这有什么不对（正是「看起来正常」的那类退化）。
   * 判据落在两行的**数据属性**上（不是 class）：合并成一层 Flex 时这两格都找不到，用例直接红。
   */
  it('分组显式：第一行「谁打的」，第二行「花了多少」（不靠自然折行）', () => {
    render(view(score({ judgeAgentKind: 'claude-code', judgeModelId: 'claude-opus-4-6', judgeEffort: 'max' })));

    const meta = within(screen.getByTestId('score-judge-meta'));
    expect(meta.getByText('评分智能体')).toBeInTheDocument();
    expect(meta.getByText(AGENT_LABELS['claude-code'])).toBeInTheDocument();
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
    expect(usage.queryByText('评分模型')).toBeNull();
  });

  /**
   * 第一行那三个值走 antd **`Tag`、一色一格**（用户 2026-10-07 晚口径）：评分智能体 `blue` /
   * 评分模型 `geekblue` / 思考强度 `purple`（与行卡片上那个档位 Tag 同色——同一个档位在本仓长得一样）。
   * 标签（「评分智能体」等）留在 Tag 外面：一个 Tag 里塞两种语义会让人读不出哪个是标签、哪个是值。
   *
   * 为什么判据落在 **class** 上：`Tag` 的预设色本来就只体现为这个 class（只有自定义 hex 才走行内
   * style），而这里要守的恰恰是「哪一格是哪个预设色」。**「颜色不随取值变」那一半也在这条里**：
   * 关闭档与「未指定」同为紫、文本通路与三家智能体同为蓝——值不同、class 相同；档位之间没有排名口径
   * （spec D12），驱动者之间也没有强弱口径，换个颜色就是把一个没证实的结论画进界面。
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
   * **两条通路在界面上必须分得开**（spec §10 展示表）：`judgeAgentKind === null` 是纯文本 API 评分
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
   * 五格都在，且**「没采到」不写成 0**（2026-10-08：这两格是新增的落盘字段，老记录读回是 `null`）。
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
   * 显式关闭档**逐字写 `off`**，不并进「未指定」（用户口径 2026-10-06）：`off` 说的是
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
   * **候选那一套数据一格都不许出现**（2026-10-08 口径翻转的正面钉子）：下面这些哨兵值取自
   * 2026-10-07 那一版的候选行夹具（`claude-code` / `claude-opus-4-6` / 128,450 tok / 6m23s）。
   * 组件已经不吃候选行（`ScoreDetailViewProps` 里没有 `row`），把那一格接回来、或让某处回落到它时，
   * 这一条立刻红。页面那一侧的对应守卫是 `apps/web-next/src/runs-page-wiring.test.ts` 的反向断言。
   */
  it('候选那一套值一个都不出现（这一段说的是评分，不是执行）', () => {
    render(view(score({ judgeTokens: { input: 15_763, cached: 45_824, output: 2_164 }, judgeDurationMs: 192_000 })));

    expect(screen.queryByText('候选运行信息')).toBeNull();
    expect(screen.queryByText(AGENT_LABELS['claude-code'])).toBeNull();
    expect(screen.queryByText('claude-opus-4-6')).toBeNull();
    expect(screen.queryByText(/128,450/)).toBeNull();
    expect(screen.queryByText(/6m23s/)).toBeNull();
  });
});
