/**
 * `AgentLogFactsBar`（L1）的守卫。八条，前三条围绕「`null` 不等于 0」，末条钉版面分组：
 *   1. 用量未采集时**不显示 0**；错误格只在真有错误时出现；
 *   2. 耗时：未结束本地走秒表（数字在涨）、终态用 `endedAt − startedAt` 的结算值；
 *   3. 思考 token **只在与用量并列的那一格**显示，且**不与用量相加**（`basis !== 'additive'`
 *      时那一格也不附任何说明）；
 *   4. **领域事实不在这里**：`facts.domain`（智能体 · 模型 · 思考强度 ·
 *      改动 · 评分）自占一行，由 `agent-log-domain-facts.test.tsx` 守；本件只画「这个候选跑了什么」；
 *   5. `status.label` 照数据给的渲染，**只有 `running` 才带动效**；
 *   6. 「等待答复」徽标只在真的在等时出现；
 *   7. **没有「结束原因」这一格**：它连着 `agent-log-facts-exit` 一起不在事实条与
 *      `AgentLogFacts` 里，重建那一格时守卫红。
 *   8. **用量 / 耗时 / 步数三类之间各有一根竖分隔线**，线两侧各 8px；耗时缺席时只剩一根线。
 */
import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentLogFacts } from './types';
import { AgentLogFactsBar, durationMsOf } from './agent-log-facts-bar';

const START = '2026-10-02T10:00:00.000Z';
const END = '2026-10-02T10:03:00.000Z';

function facts(overrides: Partial<AgentLogFacts> = {}): AgentLogFacts {
  return {
    status: { tone: 'ok', label: '已评分' },
    startedAt: START,
    endedAt: END,
    turns: { current: 3, total: 3 },
    tokens: { input: 218, cached: 8832, output: 1420 },
    thinking: null,
    domain: [],
    error: null,
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('durationMsOf（耗时的唯一口径）', () => {
  it('还没开始 ⇒ null（那一格整格不显示）', () => {
    expect(durationMsOf(facts({ startedAt: null, endedAt: null }), 0)).toBeNull();
  });

  it('已结束 ⇒ 用 endedAt − startedAt 的结算值（不随 now 变）', () => {
    const settle = durationMsOf(facts(), 0);
    expect(settle).toBe(180_000);
    // now 再大也不影响结算值
    expect(durationMsOf(facts(), 999_999_999)).toBe(180_000);
  });

  it('未结束 ⇒ now − startedAt（本地走秒表）', () => {
    const now = Date.parse(START) + 12_000;
    expect(durationMsOf(facts({ endedAt: null }), now)).toBe(12_000);
  });

  it('时刻解析不出来 ⇒ null（不显示 NaN、也不假装成一个读数）', () => {
    expect(durationMsOf(facts({ startedAt: '不是时刻' }), 0)).toBeNull();
    expect(durationMsOf(facts({ endedAt: '不是时刻' }), 0)).toBeNull();
  });
});

describe('AgentLogFactsBar', () => {
  it('用量未采集时说「用量未采集」，不显示成 0', () => {
    render(<AgentLogFactsBar facts={facts({ tokens: null, thinking: null })} waitingSince={null} />);

    const cell = screen.getByTestId('agent-log-facts-tokens');
    expect(cell).toHaveTextContent('用量未采集');
    expect(cell.textContent).not.toContain('0');
  });

  /**
   * 用量那一格的文案走 `formatUsageTriple`（千分位 + `tok`）。
   * 为什么值得钉：三元组的**形状**只有字面量断言能拦住——写成裸数字
   * （`输入 218 · 缓存 8832 · 输出 1420`）时肉眼看不出。
   */
  it('用量三元组带千分位与 `tok` 单位（与里程碑 / 页脚 / 子任务卡片同一出口）', () => {
    render(<AgentLogFactsBar facts={facts()} waitingSince={null} />);

    expect(screen.getByTestId('agent-log-facts-tokens')).toHaveTextContent('输入 218 tok · 缓存 8,832 tok · 输出 1,420 tok');
  });

  /**
   * **第一候选的格序**：状态 → 用量（输入 · 缓存 · 输出）→ 耗时 → **步数**。
   * 步数排在末尾：它是「跑了几步」这个过程读数，插在用量之前会把「这一次用了多少」那一串读断。
   *
   * 判据取**行文本里的位置**（`indexOf`），不数 DOM 下标：格子的元素类型会变（`Flex` / `Text`），
   * 而读者看到的是那一行字的先后。
   */
  it('格序：用量 → 耗时 → 步（步数排在末尾）', () => {
    render(<AgentLogFactsBar facts={facts()} waitingSince={null} />);

    const text = screen.getByTestId('agent-log-facts-bar').textContent ?? '';
    const input = text.indexOf('输入');
    const duration = text.indexOf('耗时');
    const turns = text.indexOf('步数');

    expect(input, '用量那一格不在候选里').toBeGreaterThanOrEqual(0);
    expect(duration, '耗时不在用量之后').toBeGreaterThan(input);
    expect(turns, '步数没有排在末尾（它不再是用量前面那一格）').toBeGreaterThan(duration);
  });

  it('facts.domain 不再由本件渲染（它自占一行，见 agent-log-domain-facts.test.tsx）', () => {
    const { container } = render(<AgentLogFactsBar facts={facts()} waitingSince={null} />);

    expect(container.querySelector('[data-testid="agent-log-domain-facts"]')).toBeNull();
  });

  it('错误格：有错误时可见，没有时整格不出现', () => {
    const { rerender } = render(
      <AgentLogFactsBar
        facts={facts({ error: { code: 'AGENT_FAILED', message: '有一条工具调用返回了非零退出码' } })}
        waitingSince={null}
      />,
    );
    expect(screen.getByTestId('agent-log-facts-error')).toHaveTextContent('AGENT_FAILED');
    expect(screen.getByTestId('agent-log-facts-error')).toHaveTextContent('有一条工具调用返回了非零退出码');

    rerender(<AgentLogFactsBar facts={facts()} waitingSince={null} />);
    expect(screen.queryByTestId('agent-log-facts-error')).toBeNull();
  });

  it('未结束时耗时数字随 now 涨（fake timers）', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(START));

    render(<AgentLogFactsBar facts={facts({ endedAt: null })} waitingSince={null} />);
    expect(screen.getByTestId('agent-log-facts-duration')).toHaveTextContent('耗时 0s');

    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(screen.getByTestId('agent-log-facts-duration')).toHaveTextContent('耗时 5s');
  });

  it('终态用结算值：时钟再往后走也不变', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(END));

    render(<AgentLogFactsBar facts={facts()} waitingSince={null} />);
    expect(screen.getByTestId('agent-log-facts-duration')).toHaveTextContent('耗时 3m00s');

    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(screen.getByTestId('agent-log-facts-duration')).toHaveTextContent('耗时 3m00s');
  });

  it('思考 token 只在用量那一格里显示；非可加时不相加、也不写相加口径', () => {
    render(
      <AgentLogFactsBar
        facts={facts({ thinking: { tokens: 640, basis: 'subset-of-output' } })}
        waitingSince={null}
      />,
    );

    const cell = screen.getByTestId('agent-log-facts-tokens');
    expect(cell).toHaveTextContent('思考 640 tok');
    // `subset-of-output` 那一格**不附说明**（文案从简）；
    // 靶子是那句已删掉的旧文案：把它加回来这条用例就红
    expect(cell).not.toHaveTextContent('是输出的子集');
    // 1420 + 640 = 2060：非可加时**绝不**给出这个和
    expect(cell.textContent).not.toContain('2060');
  });

  it('可加性未知时写明「可加性未知」，可加时不写口径', () => {
    const { rerender } = render(
      <AgentLogFactsBar facts={facts({ thinking: { tokens: 12, basis: 'unknown' } })} waitingSince={null} />,
    );
    expect(screen.getByTestId('agent-log-facts-tokens')).toHaveTextContent('可加性未知');

    rerender(<AgentLogFactsBar facts={facts({ thinking: { tokens: 12, basis: 'additive' } })} waitingSince={null} />);
    expect(screen.getByTestId('agent-log-facts-tokens')).toHaveTextContent('思考 12 tok');
    expect(screen.getByTestId('agent-log-facts-tokens')).not.toHaveTextContent('可加性未知');
  });

  it('思考 token 为 null 时不显示这一格（不是 0）', () => {
    render(<AgentLogFactsBar facts={facts({ thinking: null })} waitingSince={null} />);

    expect(screen.queryByTestId('agent-log-facts-thinking')).toBeNull();
    expect(screen.getByTestId('agent-log-facts-tokens').textContent).not.toContain('思考');
  });

  it('status.label 照数据给的渲染；只有 tone === running 才带动效', () => {
    const { container, rerender } = render(
      <AgentLogFactsBar facts={facts({ status: { tone: 'running', label: '执行中' } })} waitingSince={null} />,
    );
    expect(screen.getByText('执行中')).toBeInTheDocument();
    expect(container.querySelector('.ant-badge-status-processing')).not.toBeNull();

    rerender(<AgentLogFactsBar facts={facts({ status: { tone: 'failed', label: '专有名词：炸了' } })} waitingSince={null} />);
    // 文案是数据层的词汇，组件不翻译、不改写
    expect(screen.getByText('专有名词：炸了')).toBeInTheDocument();
    expect(container.querySelector('.ant-badge-status-processing')).toBeNull();
  });

  it('「等待答复」徽标只在真的在等时出现', () => {
    const { rerender } = render(<AgentLogFactsBar facts={facts()} waitingSince={START} />);
    expect(screen.getByTestId('agent-log-facts-waiting')).toHaveTextContent('等待答复');

    rerender(<AgentLogFactsBar facts={facts()} waitingSince={null} />);
    expect(screen.queryByTestId('agent-log-facts-waiting')).toBeNull();
  });

  /**
   * 三类读数各自成组、用竖分隔线隔开（用户口径）：用量｜耗时｜步数。
   *
   * 判据两层：① 三格都在同一组里、顺序即口径；② 线两侧各 8px——
   * 组 `gap` 取 `marginXS`（8px）、分隔线自带外边距归零，外框 `gap` 仍是 `marginSM`（12px）。
   */
  it('用量 / 耗时 / 步数之间各有一根竖分隔线，线两侧各 8px', () => {
    render(<AgentLogFactsBar facts={facts()} waitingSince={null} />);

    const bar = screen.getByTestId('agent-log-facts-bar');
    const groups = screen.getByTestId('agent-log-facts-groups');
    const tokens = screen.getByTestId('agent-log-facts-tokens');
    const duration = screen.getByTestId('agent-log-facts-duration');
    const turns = screen.getByTestId('agent-log-facts-turns');

    // 三格同组、顺序是「用量 → 耗时 → 步数」
    for (const cell of [tokens, duration, turns]) expect(groups.contains(cell)).toBe(true);
    expect(tokens.compareDocumentPosition(duration) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(duration.compareDocumentPosition(turns) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // 两根竖线，各自落在相邻两格之间（先于后一格）
    const dividers = [...groups.querySelectorAll('.ant-divider')];
    expect(dividers).toHaveLength(2);
    for (const divider of dividers) expect(divider.getAttribute('role')).toBe('separator');
    expect(dividers[0]!.compareDocumentPosition(duration) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(dividers[0]!.compareDocumentPosition(tokens) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
    expect(dividers[1]!.compareDocumentPosition(turns) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(dividers[1]!.compareDocumentPosition(duration) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();

    // 呼吸：线两侧各 8px（marginXS）+ 分隔线本身不带外边距；外框仍是 12px（marginSM）
    expect((groups as HTMLElement).style.gap).toBe('8px');
    expect((bar as HTMLElement).style.gap).toBe('12px');
    for (const divider of dividers) expect(['0px', '0']).toContain((divider as HTMLElement).style.margin);
  });

  it('耗时缺席时只剩一根分隔线（用量｜步数），不留一根孤线', () => {
    render(<AgentLogFactsBar facts={facts({ startedAt: null, endedAt: null })} waitingSince={null} />);

    expect(screen.queryByTestId('agent-log-facts-duration')).toBeNull();
    expect(screen.getByTestId('agent-log-facts-groups').querySelectorAll('.ant-divider')).toHaveLength(1);
  });

  /**
   * 两条口径合一条：
   *   · 步数 `total` 为 `null` 时只说当前值——不编一个自己会走动的分母；
   *   · **「结束原因」这一格不存在**：字段与那一格都不在了，页面上不该再有它的痕迹。
   */
  it('步数：total 为 null 时只说当前值；「结束原因」这一格不再出现', () => {
    render(<AgentLogFactsBar facts={facts({ turns: { current: 3, total: null } })} waitingSince={null} />);

    expect(screen.getByTestId('agent-log-facts-turns')).toHaveTextContent('步数 3');
    expect(screen.queryByTestId('agent-log-facts-exit')).toBeNull();
    expect(screen.queryByText(/结束原因/)).toBeNull();
  });

  it('内容被截断时如实显示那句话；null 时什么都不显示', () => {
    const { rerender } = render(
      <AgentLogFactsBar facts={facts()} waitingSince={null} contentTruncatedReason="只保留了最近 500 条" />,
    );
    expect(screen.getByTestId('agent-log-facts-truncated')).toHaveTextContent('只保留了最近 500 条');

    rerender(<AgentLogFactsBar facts={facts()} waitingSince={null} contentTruncatedReason={null} />);
    expect(screen.queryByTestId('agent-log-facts-truncated')).toBeNull();
  });
});
