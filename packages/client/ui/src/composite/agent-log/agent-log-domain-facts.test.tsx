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
 *   5. **`insertion` / `deletion` 走 git 惯例的绿 / 红**，且整格**不再套 Tag**（套一枚徽标等于把
 *      这行数字框成一整块，正是要去掉的那个观感）——颜色判据取语义类；
 *   6. **`hint` / `hintSegments` 照画**（组件能力，产品侧当前不给提示）：tag 段是 Tag、其余文字次要色。
 *
 * 这一行**自占一行**（与事实条那一行分开），守卫落在
 * `agent-log-layout.test.tsx`（两行的父子关系），不在这里。
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
      { text: '3 个文件 ' },
      { text: '+12', tone: 'insertion' },
      { text: ' −3', tone: 'deletion' },
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
   * 判据落在 **`data-tone`** 上：色档是语义，具体颜色由主题决定。
   * 第三格同时钉**回落**：不给 `tagTone` 的 `tag` 段仍是蓝的（老数据 / 别的消费方不必改）。
   */
  it('tag 段按 tagTone 上色（blue / geekblue / purple），不给时回落 blue', () => {
    render(<AgentLogDomainFacts domain={DOMAIN} />);

    expect(screen.getByText('Claude Code')).toHaveAttribute('data-tone', 'blue');
    expect(screen.getByText('claude-opus-4-6')).toHaveAttribute('data-tone', 'geekblue');
    expect(screen.getByText('max')).toHaveAttribute('data-tone', 'purple');

    const { container } = render(
      <AgentLogDomainFacts domain={[{ id: 'x', label: '标识', value: 'v', segments: [{ text: 'v', tag: true }] }]} />,
    );
    const tag = container.querySelector('[data-testid="agent-log-domain-facts"] [data-slot="badge"]');
    expect(tag?.textContent).toBe('v');
    expect(tag).toHaveAttribute('data-tone', 'blue');
  });

  /**
   * 值整段一枚色档徽标：`tone` → 语义色（评分那一格是 `success` ⇒ 绿）。
   * 这条同时钉住「值没有 `segments` 时才套徽标」——两枚各归各位。
   */
  it('值整段一枚色档徽标：tone → 语义色', () => {
    render(<AgentLogDomainFacts domain={DOMAIN} />);

    const score = screen.getByText('8/10');
    expect(score.closest('[data-slot="badge"]')).toHaveAttribute('data-tone', 'success');
  });

  /**
   * 改动那一格：**按 git stat 重排**——文件数次要色 + `+N` 绿 + `−N` 红，
   * 且**整格没有徽标**。
   *
   * 颜色判据钉在语义类上（`text-success` / `text-destructive`）：写死色值在换主题时不会跟着走。
   */
  it('改动那一格按 git stat 上色（+N 绿 / −N 红，语义类），且整格没有徽标', () => {
    const domain: readonly DomainFact[] = [
      {
        id: 'diff',
        label: '改动',
        value: '3 个文件 +12 −3',
        segments: [
          { text: '3 个文件 ' },
          { text: '+12', tone: 'insertion' },
          { text: ' −3', tone: 'deletion' },
        ],
      },
    ];
    render(<AgentLogDomainFacts domain={domain} />);

    expect(screen.getByText('+12').classList.contains('text-success')).toBe(true);
    expect(screen.getByText('−3').classList.contains('text-destructive')).toBe(true);
    // 「3 个文件」是次要色：整段外面是命名类（不是自己调一个灰）
    expect(screen.getByText('+12').parentElement?.className).toContain('text-muted-foreground');
    expect(screen.getByTestId('agent-log-domain-facts').querySelectorAll('[data-slot="badge"]')).toHaveLength(0);
  });

  /**
   * `hint` / `hintSegments` 的渲染能力（**产品侧当前不给提示**：评分格的「评分模型：…」不显示，
   * 见 `apps/web-next/src/log-drawer-state.ts`）。这条钉的是通用件的能力：
   * 数据层给了 `hintSegments` 就按段画，其中 `tag` 段是徽标；值那一格的色档徽标不受影响。
   */
  it('hint / hintSegments 照画：tag 段是徽标，值那一格的色档徽标不受影响', () => {
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

    expect(screen.getByText('deepseek-chat').closest('[data-slot="badge"]')).toHaveAttribute('data-tone', 'blue');
    expect(screen.getByText('8/10').closest('[data-slot="badge"]')).toHaveAttribute('data-tone', 'success');
    expect(container.querySelectorAll('[data-testid="agent-log-domain-facts"] [data-slot="badge"]')).toHaveLength(2);
  });
});
