/**
 * ScoreDetailView：总分 + 逐项达成 / 未达成 + 理由 + 总评 + 评分者 + 原始返回。
 * 五条守卫：
 *   1. **总分原样显示 `score.totalScore`，前端不重算**（它是服务端按权重加总出来的权威值）；
 *   2. **未达成的项要能被看出来**（它们才是使用者要看的重点，不能与达成项长得一样）——
 *      数据属性 / 文案一条，**语义色**另一条（只钉前者的话，把颜色改掉没有任何东西会红）；
 *   3. **判定按引用键与评分表对齐**：缺一项说明数据不一致，此时**不静默跳过**；
 *   4. 满分来自 `maxScore`（不是常量 100）；
 *   5. 评分者那一行**两条通路**与**输出约束两种取值**都逐字钉住（谁打的这一分 + 我们提交了什么）。
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ConfigProvider } from 'antd';
import { AGENT_LABELS, type Rubric, type ScoreResult } from '@aieval/contracts';
import { formatDateTime } from '../base/format';
import { ScoreDetailView } from './score-detail-view';

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

describe('ScoreDetailView', () => {
  it('总分、满分、逐项目标与理由、总评、评分者都在', () => {
    render(<ScoreDetailView score={score()} rubric={RUBRIC} />);
    expect(screen.getByText('18')).toBeInTheDocument();
    expect(screen.getByText(/满分 32 分/)).toBeInTheDocument();
    expect(screen.getByText('追加 agent 字段')).toBeInTheDocument();
    expect(screen.getByText('字段进了契约')).toBeInTheDocument();
    expect(screen.getByText('生产代码到位，测试缺失')).toBeInTheDocument();
    expect(screen.getByText(/deepseek-chat/)).toBeInTheDocument();
  });

  it('总分原样显示权威值，**不在前端重算**（18 分就是 18，不是按权重现场算出来的别的数）', () => {
    // 若有人在这里「按评分表重算」，会得到 18（这一份恰好相同）——所以刻意再给一个不同的权威值
    render(<ScoreDetailView score={score({ totalScore: 7 })} rubric={RUBRIC} />);
    expect(screen.getByText('7')).toBeInTheDocument();
    expect(screen.queryByText('18')).toBeNull();
  });

  it('未达成的项与达成的项长得不一样（它是使用者要看的重点）', () => {
    render(<ScoreDetailView score={score()} rubric={RUBRIC} />);
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
        <ScoreDetailView score={score()} rubric={RUBRIC} />
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
    render(<ScoreDetailView score={score({ judgments: [{ id: 'A1', achieved: true, reason: '好' }] })} rubric={RUBRIC} />);
    expect(screen.getByText(/缺少判定/)).toBeInTheDocument();
  });

  it('原始返回原样可见（解析失败时它是唯一线索）', () => {
    render(<ScoreDetailView score={score({ raw: '这不是 JSON，模型回了一段散文' })} rubric={RUBRIC} />);
    expect(screen.getByTestId('score-raw')).toHaveTextContent('这不是 JSON，模型回了一段散文');
  });

  /**
   * **围栏本身也是排障线索**：真实的评分返回常是一段 ```json 围栏（提示词就是这么要求的），
   * 而围栏标记与载荷一起「原样可见」才是这一格的判据——**这一条是本组里唯一有判别力的那一半**：
   * 散文喂给 markdown 渲染器也会原样通过，只有围栏会**被它吃掉**（```json 变成 `<pre><code>`，
   * 反引号消失、内容被当代码块处理）。换句话说，这条守的就是「raw 不许走 markdown 渲染」。
   */
  it('围栏 JSON 的围栏标记与载荷都原样可见（raw 不许被当 markdown 渲染）', () => {
    render(<ScoreDetailView score={score({ raw: '```json\n{"totalScore":90,"judgments":[]}\n```' })} rubric={RUBRIC} />);

    const raw = screen.getByTestId('score-raw').textContent ?? '';
    // 围栏标记：markdown 渲染器会把它变成 <pre><code>（反引号一个不剩）
    expect(raw).toContain('```json');
    expect(raw).toContain('```');
    // 载荷片段：与围栏标记一起断言，才是「整段原文都在」而不是「某个词恰好还在」
    expect(raw).toContain('"totalScore":90');
    expect(raw).toContain('"judgments":[]');
  });

  it('满分来自 maxScore（不是常量 100）', () => {
    render(<ScoreDetailView score={score({ totalScore: 300, maxScore: 300 })} rubric={RUBRIC} />);
    expect(screen.getByText(/满分 300 分/)).toBeInTheDocument();
  });

  /**
   * 评分者那一行分**两条通路**（spec §10 展示表）。这里是**智能体通路**：光有模型名回答不了
   * 「这一分是文本请求打的还是智能体会话打的」，而两条通路的分数不可比
   * （README「分数怎么来的」的既有口径）⇒ 智能体名与模型名必须同时在这一行里。
   * 整行逐字钉住：分隔符与顺序都不许动（老截图 / 老排障笔记里的文案仍然对得上）。
   */
  it('智能体评分时这一行写「评分智能体：X · 模型：Y」并接输出约束与时间', () => {
    render(<ScoreDetailView score={score({ judgeAgentKind: 'dsh' })} rubric={RUBRIC} />);

    expect(
      screen.getByText(
        `评分智能体：${AGENT_LABELS.dsh} · 模型：deepseek-chat · 输出约束：提示词约束 · 评分时间：${formatDateTime('2026-09-29T08:10:00.000Z')}`,
      ),
    ).toBeInTheDocument();
  });

  it('structuredOutput=true ⇒ 显示「输出约束：schema 约束」', () => {
    render(<ScoreDetailView score={score({ structuredOutput: true })} rubric={RUBRIC} />);

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
    render(<ScoreDetailView score={score({ structuredOutput: false })} rubric={RUBRIC} />);

    const scorerLine = screen.getByText(
      `评分模型：deepseek-chat · 输出约束：提示词约束 · 评分时间：${formatDateTime('2026-09-29T08:10:00.000Z')}`,
    );
    expect(scorerLine).toBeInTheDocument();
    expect(scorerLine.querySelector('.ant-alert, .ant-typography-danger, .ant-typography-warning')).toBeNull();
    expect(scorerLine.className).not.toMatch(/danger|warning/);
  });
});
