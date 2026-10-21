/**
 * `AgentLogDomainFacts`（L1）的守卫：领域事实那一行——**智能体 · 模型 · 思考强度 · 改动 · 评分**。
 *
 * 六条：
 *   1. **顺序就是数据层给的顺序**（界面不重排）：本仓的口径是「谁在跑」三格在前、「改了多少 /
 *      得了多少分」两格在后；
 *   2. **空数组时整行不出现**：通用消费方没有领域事实时不留一段空 gap；
 *   3. **值整段一枚色档 Tag**（评分那一格）：`tone` → antd 预设色；
 *   4. **`tag` 段按 `tagTone` 上色**（智能体 `blue` / 模型 `geekblue` /
 *      思考强度 `purple`），不给时回落 `blue`；
 *   5. **`insertion` / `deletion` 各是一枚绿 / 红 Tag**（git 惯例的 `+N` / `−N`）；段间距由
 *      段容器的 `Flex gap`（4px）给，段内文字不带排版空格、Tag 不留自带外边距；
 *   6. **`hint` / `hintSegments` 照画**（组件能力，产品侧当前不给提示）：tag 段是 Tag、其余文字次要色。
 *
 * 这个候选**自占一行**（与事实条那一行分开），守卫落在
 * `agent-log-layout.test.tsx`（两个候选的父子关系），不在这里。
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { DomainFact } from './types';
import { AgentLogDomainFacts } from './agent-log-domain-facts';

/** 本仓的五格（顺序即产品顺序）：智能体 · 模型 · 思考强度 · 改动 · 评分 */
const DOMAIN: readonly DomainFact[] = [
  {
    id: 'agent',
    label: '智能体',
    value: 'Claude Code',
    segments: [{ text: 'Claude Code', tag: true, tagTone: 'blue' }],
  },
  {
    id: 'model',
    label: '模型',
    value: 'claude-opus-4-6',
    segments: [{ text: 'claude-opus-4-6', tag: true, tagTone: 'geekblue' }],
  },
  {
    id: 'effort',
    label: '思考强度',
    value: 'max',
    segments: [{ text: 'max', tag: true, tagTone: 'purple' }],
  },
  {
    id: 'diff',
    label: '改动',
    value: '3 个文件 +12 −3',
    segments: [
      { text: '3', tag: true, tagTone: 'default' },
      { text: '个文件' },
      { text: '+12', tag: true, tagTone: 'success' },
      { text: '−3', tag: true, tagTone: 'error' },
    ],
  },
  { id: 'score', label: '评分', value: '8/10', tone: 'success' },
];

describe('AgentLogDomainFacts', () => {
  it('按数据层给的顺序逐格照画（智能体 → 模型 → 思考强度 → 改动 → 评分）', () => {
    render(<AgentLogDomainFacts domain={DOMAIN} />);

    const row = screen.getByTestId('agent-log-domain-facts');
    // 五格的标签都照画（UI 不翻译格名）
    for (const label of ['智能体', '模型', '思考强度', '改动', '评分']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    // 顺序：按标签**在行文本里的位置**数，不按查询顺序（查询顺序恒是代码顺序）
    const text = row.textContent ?? '';
    const positions = ['智能体', '模型', '思考强度', '改动', '评分'].map((label) => text.indexOf(label));
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
    expect(positions.every((position) => position >= 0)).toBe(true);
  });

  it('空数组时整行不出现', () => {
    const { container } = render(<AgentLogDomainFacts domain={[]} />);

    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByTestId('agent-log-domain-facts')).toBeNull();
  });

  /**
   * `tag` 段的色档：智能体 `blue` / 模型 `geekblue` / 思考强度 `purple`。
   * 判据落在 **class** 上：`Tag` 的预设色本来就只体现为 class（只有自定义 hex 才走候选内 style）。
   * 第三格同时钉**回落**：不给 `tagTone` 的 `tag` 段仍是蓝的（老数据 / 别的消费方不必改）。
   */
  it('tag 段按 tagTone 上色（blue / geekblue / purple），不给时回落 blue', () => {
    render(<AgentLogDomainFacts domain={DOMAIN} />);

    expect(screen.getByText('Claude Code')).toHaveClass('ant-tag-blue');
    expect(screen.getByText('claude-opus-4-6')).toHaveClass('ant-tag-geekblue');
    expect(screen.getByText('max')).toHaveClass('ant-tag-purple');

    const { container } = render(
      <AgentLogDomainFacts domain={[{ id: 'x', label: '标识', value: 'v', segments: [{ text: 'v', tag: true }] }]} />,
    );
    const tag = container.querySelector('[data-testid="agent-log-domain-facts"] .ant-tag');
    expect(tag?.textContent).toBe('v');
    expect(tag).toHaveClass('ant-tag-blue');
  });

  /**
   * 值整段一枚色档 Tag：`tone` → antd 预设色（评分那一格是 `success` ⇒ 绿）。
   * 这条同时钉住「值没有 `segments` 时才套 Tag」——两枚 Tag 各归各位。
   */
  it('值整段一枚色档 Tag：tone → antd 预设色', () => {
    render(<AgentLogDomainFacts domain={DOMAIN} />);

    const score = screen.getByText('8/10');
    expect(score.closest('.ant-tag')).toHaveClass('ant-tag-success');
  });

  /**
   * 改动那一格：**三段各一枚 Tag**——文件数中性档、`+N` 绿档、`−N` 红档。
   * 段间**不写空格**：间距由段容器的 `Flex gap`（`marginXXS` = 4px）给，Tag 自带外边距归零。
   *
   * 判据落在 **class** 上（`Tag` 的色档只体现为 class），另用 `gap` 与 `marginInlineEnd` 钉「间距」那一条；
   * 单位「个文件」仍是 antd 的 secondary `Text`（不跟着上色，也不带排版空格）。
   */
  it('改动那一格三段各一枚 Tag（中性 / 绿 / 红），段间距由 Flex gap 给', () => {
    const domain: readonly DomainFact[] = [
      {
        id: 'diff',
        label: '改动',
        value: '3 个文件 +12 −3',
        segments: [
          { text: '3', tag: true, tagTone: 'default' },
          { text: '个文件' },
          { text: '+12', tag: true, tagTone: 'success' },
          { text: '−3', tag: true, tagTone: 'error' },
        ],
      },
    ];
    render(<AgentLogDomainFacts domain={domain} />);

    const group = screen.getByTestId('agent-log-domain-fact-segments');
    const tags = [...group.querySelectorAll('.ant-tag')];
    expect(tags.map((tag) => tag.textContent)).toEqual(['3', '+12', '−3']);
    expect(tags[0]).toHaveClass('ant-tag-default');
    expect(tags[1]).toHaveClass('ant-tag-success');
    expect(tags[2]).toHaveClass('ant-tag-error');

    // 间距由 flex gap 给（4px = marginXXS），Tag 自带的外边距归零——两者相加会松成另一档
    expect((group as HTMLElement).style.gap).toBe('4px');
    for (const tag of tags) expect(Number.parseFloat((tag as HTMLElement).style.marginInlineEnd)).toBe(0);
    // 四段各是一个 flex 项（没有只为排版存在的空白段）
    expect(group.children).toHaveLength(4);
    // 单位仍是次要色文本，且不带首尾空格（间距不靠空格）
    const unit = screen.getByText('个文件');
    expect(unit).toHaveClass('ant-typography-secondary');
    expect(unit.textContent).toBe('个文件');
  });

  /**
   * `hint` / `hintSegments` 的渲染能力（**产品侧当前不给提示**：评分格的「评分模型：…」不显示，
   * 见 `apps/web-next/src/log-drawer-state.ts`）。这条钉的是通用件的能力：
   * 数据层给了 `hintSegments` 就按段画，其中 `tag` 段是 Tag；值那一格的色档 Tag 不受影响。
   */
  it('hint / hintSegments 照画：tag 段是 Tag，值那一格的色档 Tag 不受影响', () => {
    const domain: readonly DomainFact[] = [
      {
        id: 'score',
        label: '评分',
        value: '8/10',
        tone: 'success',
        hint: '评分模型：deepseek-chat',
        hintSegments: [{ text: '评分模型：' }, { text: 'deepseek-chat', tag: true }],
      },
    ];
    const { container } = render(<AgentLogDomainFacts domain={domain} />);

    expect(screen.getByText('deepseek-chat').closest('.ant-tag')).toHaveClass('ant-tag-blue');
    expect(screen.getByText('8/10').closest('.ant-tag')).toHaveClass('ant-tag-success');
    expect(container.querySelectorAll('[data-testid="agent-log-domain-facts"] .ant-tag')).toHaveLength(2);
  });
});
