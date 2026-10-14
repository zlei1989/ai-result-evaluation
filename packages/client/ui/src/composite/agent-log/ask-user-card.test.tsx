/**
 * AskUserCard：时间轴上唯一「会等人」的东西。
 *
 * 十一条守卫：
 * · **外壳是 `Card`**：卡面标题只写「问题 N 个」+ 收场态，**问题类型一个字都不进卡面**；
 * · **一问一格折叠面板、默认全部收起**（等待中也不例外），面板标题 = 问题类型 + 题目 + 「可多选」；
 * · **一问一格键**（`questionPanelKey`）：展开一问答面板不影响另一问；
 * · **原文入口在卡面 footer**（收场且有原文才有）；
 * · `pending + running` 走秒表且**不出现任何收场文案**（把「还在等」说成「已经收场」是最容易犯的错）；
 * · `pending + !running` 是**静态灰字**「结果未采集」，**不能一直转圈**；
 * · 七态各自的文案与色档，**`unavailable` 是中性不是红色错误**；
 * · 答案按 **`label`** 回填：夹具里 `selected` 的顺序与选项顺序**不同**——
 * 按下标匹配会把「已选」标到错的那两项上，而界面上看起来「有答案」；
 * · `selected` 里 `options` 没有的标签**原样显示**，不静默丢弃；
 * · `custom` 多选是**补充**、单选是**覆盖**，且「其它（自由输入）」那格只在有内容时出现；
 * · `secret` 默认遮罩，展开才显示。
 *
 * 内容都在**面板体**里，故除「结构」那一组外，用例默认用 `renderCard(..., { open: 'all' })`
 * 把每问都展开——折叠是默认态，展开才是例外（那一条本身由「结构」组钉住）。
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installResizeObserverStub } from '../../testing/resize-observer';
import { AskUserCard, questionPanelKey } from './ask-user-card';
import type { AskUserInteraction, AskUserOption, AskUserPending, AskUserQuestion, AskUserSettled } from './types';
import { ASK_USER_OUTCOME_LABELS } from './types';

const AT = '2026-10-02T00:00:00.000Z';
const NOW = '2026-10-02T00:02:03.000Z';
/** 卡片 id：数据层给的是块 id（`messageId#块下标`），用例给一个同类形状的字面量 */
const CARD_ID = 'm1#7';

// `EllipsisText` 走 antd 的省略测量，它 `new ResizeObserver`（jsdom 没有）⇒ 与 ellipsis-text.test 同一口径
beforeEach(() => {
  installResizeObserverStub();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function option(label: string, overrides: Partial<AskUserOption> = {}): AskUserOption {
  return { label, description: null, recommended: false, ...overrides };
}

function question(overrides: Partial<AskUserQuestion> = {}): AskUserQuestion {
  return {
    header: '选路径',
    prompt: '这次改哪条路径？',
    options: [option('选项 A'), option('选项 B'), option('选项 C')],
    multiSelect: false,
    allowOther: false,
    secret: false,
    ...overrides,
  };
}

function pending(overrides: Partial<AskUserPending> = {}): AskUserPending {
  return { state: 'pending', questions: [question()], at: AT, running: true, ...overrides };
}

function settled(overrides: Partial<AskUserSettled> = {}): AskUserSettled {
  return {
    state: 'settled',
    questions: [question()],
    outcome: 'answered',
    answers: null,
    at: AT,
    result: null,
    ...overrides,
  };
}

/** 选项那一行的容器（label 的父节点）：用来断言「已选」标挂在哪一项上 */
const rowOf = (label: string): HTMLElement | null => screen.getByText(label).parentElement;

interface RenderCardOptions {
  /** 展开哪几问：默认**全展开**（内容是渲染出来的才算数）；`[]` = 按默认态全部收起 */
  open?: 'all' | readonly number[];
  rawOpen?: boolean;
  onQuestionOpenChange?(key: string, open: boolean): void;
  onRequestDiagnostics?(): void;
}

/**
 * 渲染卡片。`openQuestions` 是**受控**的那一格（`questionPanelKey` 给的键集合），
 * 用例不自己拼键、也不直接传下标——两处各拼一次必然漂。
 */
function renderCard(interaction: AskUserInteraction, options: RenderCardOptions = {}) {
  const open = options.open ?? 'all';
  const indexes = open === 'all' ? interaction.questions.map((_, index) => index) : open;
  const openQuestions = new Set(indexes.map((index) => questionPanelKey(CARD_ID, index)));
  return render(
    <AskUserCard
      cardId={CARD_ID}
      interaction={interaction}
      openQuestions={openQuestions}
      onQuestionOpenChange={options.onQuestionOpenChange ?? vi.fn()}
      rawOpen={options.rawOpen ?? false}
      onRawOpenChange={vi.fn()}
      onRequestDiagnostics={options.onRequestDiagnostics}
    />,
  );
}

/**
 * 卡片结构（用户口径：外壳 `Card` + 卡面只写问题数与收场态 + 一问一格面板默认收起 + 原文在 footer）。
 *
 * 与「内容」分开成一组：那几条讲的是**摆在哪**，而摆错位置时内容断言全绿——
 * 例如问题类型留在卡面上（两问的卡片只显示第一问的名字），或面板默认展开（收起态的信息层次立刻不成立）。
 */
describe('AskUserCard：卡片结构', () => {
  const twoQuestions = () => [
    question({ header: '动物选择', prompt: '你最喜欢哪种动物？' }),
    question({ header: '植物选择', prompt: '你喜欢哪些植物？' }),
  ];

  it('卡面标题 =「问题 N 个」+ 收场态，**问题类型不进卡面**', () => {
    renderCard(settled({ questions: twoQuestions() }), { open: [] });

    const title = screen.getByTestId('ask-user-card-title');
    expect(title).toHaveTextContent('问题 2 个');
    expect(title).toHaveTextContent('已答复');
    // 卡面是**整张卡片**的事实，不是某一问的：一个问题类型写在这里，另一问会看起来不存在
    expect(title).not.toHaveTextContent('动物选择');
    expect(title).not.toHaveTextContent('植物选择');
  });

  it('每个问题各占一格面板，标题 = 问题类型 + 题目，**默认全部收起**（选项要展开才看得见）', () => {
    renderCard(settled({ questions: twoQuestions() }), { open: [] });

    expect(screen.getByText('动物选择')).toBeInTheDocument();
    expect(screen.getByText('你最喜欢哪种动物？')).toBeInTheDocument();
    expect(screen.getByText('植物选择')).toBeInTheDocument();
    expect(screen.getByText('你喜欢哪些植物？')).toBeInTheDocument();
    // 收起 = 面板体不渲染（`destroyOnHidden`）：选项一个都不在
    expect(screen.queryByText('选项 A')).toBeNull();
  });

  it('`header` 为空的问题不画一个空 Tag（标题只剩题目）', () => {
    const { container } = renderCard(
      pending({ questions: [question({ header: '', prompt: '粘贴发布用的 token' })] }),
      { open: [] },
    );

    expect(screen.getByText('粘贴发布用的 token')).toBeInTheDocument();
    expect(container.querySelector('.ant-collapse-header .ant-tag')).toBeNull();
  });

  it('**一问一格键**：展开哪一问只看那一问的键，点了报出去的也是它', () => {
    const onQuestionOpenChange = vi.fn();
    const questions = twoQuestions();
    renderCard(settled({ questions }), { open: [1], onQuestionOpenChange });

    // 第二问开着、第一问还收着
    expect(screen.getByText('选项 A')).toBeInTheDocument();
    expect(screen.getAllByText('选项 A')).toHaveLength(1);

    // 点第一问的标题：报出去的键是 `questionPanelKey(卡片 id, 0)`——不是下标、也不是 `header`
    fireEvent.click(screen.getByText('动物选择'));
    expect(onQuestionOpenChange).toHaveBeenCalledWith(questionPanelKey(CARD_ID, 0), true);
    // 第二问的键一个都没被报（点一问答面板不会顺手带上另一问）
    expect(onQuestionOpenChange).not.toHaveBeenCalledWith(questionPanelKey(CARD_ID, 1), expect.anything());
  });

  it('题目标题那一格可收缩（`minWidth: 0`）：长题目不会把卡片顶宽成横向滚动条', () => {
    const { container } = renderCard(pending({ questions: [question({ prompt: '一个很长的题目'.repeat(20) })] }), {
      open: [],
    });

    expect(container.querySelector<HTMLElement>('.ant-collapse-title')?.style.minWidth).toBe('0');
  });

  it('footer 放原文入口：收场且有原文时「原始结果」+「重新读取」都在卡面 footer 里', () => {
    const result = { ok: true, raw: '{"questions":[]}', truncation: { kind: 'none' } as const };
    renderCard(settled({ result }), { onRequestDiagnostics: vi.fn() });

    const open = screen.getByTestId('raw-output-open');
    // 位置就是 footer（antd 的 `actions` 那一行）：不是面板体里、也不是卡面标题里
    expect(open.closest('.ant-card-actions')).not.toBeNull();
    expect(screen.getByText('重新读取')).toBeInTheDocument();
  });

  it('没采到原文时整个 footer 不画（不留一条空边）', () => {
    const { container } = renderCard(pending());

    expect(screen.queryByText('原始结果')).toBeNull();
    expect(container.querySelector('.ant-card-actions')).toBeNull();
  });

  it('footer 的按钮组带左内边距：与卡面标题、正文的左缘对齐', () => {
    const result = { ok: true, raw: '{"questions":[]}', truncation: { kind: 'none' } as const };
    const { container } = renderCard(settled({ result }), {});

    const bar = container.querySelector<HTMLElement>('.ant-card-actions .ant-flex');
    expect(bar, 'footer 的按钮组不在').not.toBeNull();
    // jsdom 没有布局引擎，量不到「差几像素」——真机那一条读数在冒烟里（三处左缘都是 Card.left + 13）。
    // 判据落在**这一格有没有带左内边距**：antd 的 `.ant-card-actions` 与它的 `li` 左右 padding 都是 0，
    // 不补这一格按钮组就贴到卡片边框上，而卡面标题与正文都在 `paddingSM` 处。
    expect((bar as HTMLElement).style.getPropertyValue('padding-inline-start')).toBe('12px');
  });
});

describe('AskUserCard：还没收场', () => {
  it('pending + running：走秒表，且不出现任何收场文案', () => {
    vi.useFakeTimers({ now: new Date(NOW) });
    try {
      renderCard(pending(), { open: [] });

      expect(screen.getByText('等待答复中… 2m03s')).toBeInTheDocument();
      expect(document.querySelector('.ant-badge-status-processing')).not.toBeNull();
      // 无人值守：这一句必须写出来（它解释「为什么可能一直等」）
      expect(screen.getByText('无人值守的运行里，这一步会一直等到轮次被取消')).toBeInTheDocument();

      // 收场文案一条都不能出现
      for (const meta of Object.values(ASK_USER_OUTCOME_LABELS)) {
        expect(screen.queryByText(meta.label)).toBeNull();
      }

      act(() => vi.advanceTimersByTime(60_000));
      expect(screen.getByText('等待答复中… 3m03s')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('pending + !running：静态灰字「结果未采集」，不带 processing 徽标、也不说「会一直等」', () => {
    const { container } = renderCard(pending({ running: false }), { open: [] });

    expect(screen.getByText('结果未采集')).toBeInTheDocument();
    expect(container.querySelector('.ant-badge-status-processing')).toBeNull();
    expect(screen.queryByText(/等待答复中/)).toBeNull();
    // 轮次已经结束，「会一直等到轮次被取消」当场就是假的
    expect(screen.queryByText('无人值守的运行里，这一步会一直等到轮次被取消')).toBeNull();
  });
});

describe('AskUserCard：七种收场', () => {
  it('每一态各出自己的中文，unavailable 是中性色而不是红色错误', () => {
    for (const outcome of Object.keys(ASK_USER_OUTCOME_LABELS) as Array<keyof typeof ASK_USER_OUTCOME_LABELS>) {
      const { unmount } = renderCard(settled({ outcome }), { open: [] });

      const tag = screen.getByText(ASK_USER_OUTCOME_LABELS[outcome].label).closest('.ant-tag');
      expect(tag).not.toBeNull();
      if (outcome === 'unavailable' || outcome === 'skipped' || outcome === 'canceled') {
        expect(tag?.className).not.toContain('error');
      }
      if (outcome === 'rejected') {
        expect(tag?.className).toContain('error');
      }
      unmount();
    }
  });

  it('收场说明如实写在标题下', () => {
    renderCard(settled({ outcome: 'unavailable' }), { open: [] });

    expect(screen.getByText('无人可应答')).toBeInTheDocument();
    // 说明必须是这一态**今天**的成因（调用方没开应答面、该家没接、通道坏了、标题撞车），
    // 不能退回「本仓没有应答面」这种一句话定死成因的旧说法
    expect(screen.getByText(/这一问没有答案：调用方没开应答面/)).toBeInTheDocument();
    expect(screen.queryByText(/本仓没有开应答面/)).not.toBeInTheDocument();
  });

  it('收场了但没有答案可回填时说「答案未采集」', () => {
    renderCard(settled({ outcome: 'timeout', answers: null }));

    expect(screen.getByText('答案未采集')).toBeInTheDocument();
  });
});

describe('AskUserCard：答案回填', () => {
  it('按 label 匹配：选项顺序与 selected 顺序不同也不会错位', () => {
    renderCard(settled({ answers: [{ header: '选路径', selected: ['选项 C', '选项 A'], custom: null }] }));

    expect(rowOf('选项 A')).toHaveTextContent('已选');
    expect(rowOf('选项 C')).toHaveTextContent('已选');
    // 按下标匹配会把「已选」标到 A、B 上——B 是那条路留下的指纹
    expect(rowOf('选项 B')).not.toHaveTextContent('已选');
    expect(screen.getAllByText('已选')).toHaveLength(2);
  });

  it('selected 里出现选项中没有的标签时原样显示，不静默丢弃', () => {
    renderCard(settled({ answers: [{ header: '选路径', selected: ['选项 Z'], custom: null }] }));

    expect(screen.getByText('选项里没有的：')).toBeInTheDocument();
    expect(screen.getByText('选项 Z')).toBeInTheDocument();
  });

  it('多选时 custom 是补充：标签与自由输入都显示', () => {
    renderCard(
      settled({
        questions: [question({ multiSelect: true })],
        answers: [{ header: '选路径', selected: ['选项 B'], custom: '还有一条自定路径' }],
      }),
    );

    expect(rowOf('选项 B')).toHaveTextContent('已选');
    expect(screen.getByText('补充：还有一条自定路径')).toBeInTheDocument();
  });

  it('单选时 custom 是覆盖：只显示自由输入，选项上不再标「已选」', () => {
    renderCard(
      settled({ answers: [{ header: '选路径', selected: ['选项 A'], custom: '都不对，走第三条路' }] }),
    );

    expect(screen.getByText('自由输入（覆盖选项）：都不对，走第三条路')).toBeInTheDocument();
    expect(rowOf('选项 A')).not.toHaveTextContent('已选');
    expect(screen.queryByText('已选')).toBeNull();
  });

  it('配不上问题的答案照样列出来', () => {
    renderCard(settled({ answers: [{ header: '没问过的问题', selected: ['选项 A'], custom: null }] }));

    expect(screen.getByText('另有 1 份答案没能回填到问题上：')).toBeInTheDocument();
    expect(screen.getByText('没问过的问题')).toBeInTheDocument();
  });

  /**
   * **逐题配对**：契约里答案与题目之间**唯一**的键是 `header`（`AskUserAnswer.header`），
   * 而答案到达的顺序**不由题目顺序保证**（codex 那一家的答复帧按题目 `id` 索引，折进契约后
   * 顺序可能整个倒过来）。判据因此用「答案倒着给」——按下标配对会把两份答案互换，
   * 而界面上看起来「两题都答了」，是最难发现的一类错。
   *
   * 断言落在**文档顺序**上：每题自己的答案必须出现在**本题题干之后、下一题题干之前**。
   */
  it('答案到达顺序与题目顺序不同也各归各题（按 header 配对，不按下标）', () => {
    renderCard(
      settled({
        questions: [
          question({ header: '动物单选', prompt: '你最喜欢哪种动物？', options: [] }),
          question({ header: '植物多选', prompt: '你感兴趣哪些植物？', options: [] }),
        ],
        // 倒着给：植物的答案在前
        answers: [
          { header: '植物多选', selected: [], custom: '月季、杜鹃' },
          { header: '动物单选', selected: [], custom: '兔' },
        ],
      }),
    );

    const follows = (first: HTMLElement, second: HTMLElement): boolean =>
      (first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    const animalPrompt = screen.getByText('你最喜欢哪种动物？');
    const plantPrompt = screen.getByText('你感兴趣哪些植物？');
    const animalAnswer = screen.getByText('自由输入（覆盖选项）：兔');
    const plantAnswer = screen.getByText('自由输入（覆盖选项）：月季、杜鹃');

    expect(follows(animalPrompt, animalAnswer)).toBe(true);
    expect(follows(animalAnswer, plantPrompt)).toBe(true);
    expect(follows(plantPrompt, plantAnswer)).toBe(true);
  });
});

describe('AskUserCard：问题与选项', () => {
  it('recommended 只加一个 Tag，顺序一个字不动', () => {
    renderCard(
      pending({
        questions: [question({ options: [option('选项 A'), option('选项 B', { recommended: true }), option('选项 C')] })],
      }),
    );

    expect(screen.getByText('推荐')).toBeInTheDocument();
    expect(screen.getAllByText(/^选项 [ABC]$/).map((node) => node.textContent)).toEqual([
      '选项 A',
      '选项 B',
      '选项 C',
    ]);
  });

  it('「可多选」画在面板标题里（收起态下这是唯一能看出作答形态的地方）', () => {
    renderCard(settled({ questions: [question({ multiSelect: true })] }), { open: [] });

    // 收起态：面板体不渲染，但这一枚 Tag 还在
    expect(screen.getByText('可多选')).toBeInTheDocument();
    expect(screen.queryByText('选项 A')).toBeNull();
  });
});

/**
 * 「其它（自由输入）」那一格卡片是**自由输入内容**的容器：没有内容就没有它。
 *
 * 判据是 `custom` 有没有实话（契约里 `null` = 没写、`''` = 写了但内容为空，两者都是「没有内容」）。
 * 空着的一格不是无害的装饰：它顶着「其它（自由输入）」的标题，读的人会去里面找东西，
 * 找到的却是一片空白。
 * 不画卡片**不等于**丢内容——同一段作答区里的其它半（「选项里没有的」标签）照旧直接铺在问题下。
 *
 * 这一组**必须全展开**：面板收起时卡片体根本不渲染，「没有那格卡片」会平凡成立（假绿）。
 */
describe('AskUserCard：自由输入那一格', () => {
  const withOther = (answers: AskUserSettled['answers']) =>
    settled({ questions: [question({ allowOther: true })], answers });

  it('还没收场 ⇒ 不画那格空卡片', () => {
    renderCard(pending({ questions: [question({ allowOther: true })] }));

    expect(screen.queryByText('其它（自由输入）')).toBeNull();
  });

  it('答了但没写自己的话（`custom: null`）⇒ 同样不画，选项上的「已选」照旧', () => {
    renderCard(withOther([{ header: '选路径', selected: ['选项 A'], custom: null }]));

    expect(screen.queryByText('其它（自由输入）')).toBeNull();
    expect(rowOf('选项 A')).toHaveTextContent('已选');
  });

  it('`custom: \'\'`（写了但内容为空）与没写同档 ⇒ 也不画', () => {
    renderCard(withOther([{ header: '选路径', selected: ['选项 A'], custom: '' }]));

    expect(screen.queryByText('其它（自由输入）')).toBeNull();
  });

  it('写了自由输入 ⇒ 卡片在，且那句话就在卡片体里', () => {
    renderCard(withOther([{ header: '选路径', selected: ['选项 A'], custom: '走第三条路' }]));

    const card = screen.getByText('其它（自由输入）').closest('.ant-card');
    expect(card).not.toBeNull();
    expect(card).toHaveTextContent('自由输入（覆盖选项）：走第三条路');
  });

  it('没有自由输入内容时，作答区里的其它半**照旧显示**（不画卡片 ≠ 丢内容）', () => {
    renderCard(withOther([{ header: '选路径', selected: ['选项 Z'], custom: null }]));

    expect(screen.queryByText('其它（自由输入）')).toBeNull();
    expect(screen.getByText('选项里没有的：')).toBeInTheDocument();
    expect(screen.getByText('选项 Z')).toBeInTheDocument();
  });

  it('问题**不允许**自由输入时，即使答案里带着 `custom` 也不画那格卡片（标题不能替问题表态）', () => {
    renderCard(
      settled({
        questions: [question({ allowOther: false })],
        answers: [{ header: '选路径', selected: ['选项 A'], custom: '历史记录里的自由输入' }],
      }),
    );

    expect(screen.queryByText('其它（自由输入）')).toBeNull();
    // 那句话本身照旧显示：它是答案的一部分
    expect(screen.getByText('自由输入（覆盖选项）：历史记录里的自由输入')).toBeInTheDocument();
  });
});

describe('AskUserCard：只读与原文', () => {
  it('不提供任何「回答」按钮（应答面在弹层，卡片是复盘视图）', () => {
    const { container } = renderCard(pending());

    expect(container.querySelectorAll('button')).toHaveLength(0);
  });

  it('secret 的答案默认遮罩，展开才显示；选项上也不留「已选」的痕迹', () => {
    renderCard(
      settled({
        // 多选：遮罩里两行都要能看到（「选了哪些」与自由输入）
        questions: [question({ secret: true, multiSelect: true })],
        answers: [{ header: '选路径', selected: ['选项 A'], custom: '机密内容' }],
      }),
    );

    expect(screen.getByText('••••')).toBeInTheDocument();
    expect(screen.queryByText('已选：选项 A')).toBeNull();
    expect(screen.queryByText(/机密内容/)).toBeNull();
    expect(rowOf('选项 A')).not.toHaveTextContent('已选');

    fireEvent.click(screen.getByText('••••'));

    expect(screen.getByText('已选：选项 A')).toBeInTheDocument();
    expect(screen.getByText('补充：机密内容')).toBeInTheDocument();
  });

  it('底部「原始结果」只在收场且有原文时出现', () => {
    const result = { ok: true, raw: '{"questions":[]}', truncation: { kind: 'none' } as const };
    const { unmount } = renderCard(pending());
    expect(screen.queryByText('原始结果')).toBeNull();
    unmount();

    renderCard(settled({ result }));
    expect(screen.getByText('原始结果')).toBeInTheDocument();
  });
});
