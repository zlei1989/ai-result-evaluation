/**
 * `AgentLogFactsBar`（L1）的守卫。六条，全都围绕「`null` 不等于 0」：
 *   1. 用量未采集时**不显示 0**；错误格只在真有错误时出现；
 *   2. 耗时：未结束本地走秒表（数字在涨）、终态用 `endedAt − startedAt` 的结算值；
 *   3. 思考 token **只在与用量并列的那一格**显示，且**不与用量相加**（`basis !== 'additive'`
 *      时那一格也不附任何说明，2026-10-07 口径）；
 *   4. **领域事实不在这里**（用户 2026-10-07 口径）：`facts.domain`（智能体 · 模型 · 思考强度 ·
 *      改动 · 评分）自占一行，由 `agent-log-domain-facts.test.tsx` 守；本件只画「这一行跑了什么」；
 *   5. `status.label` 照数据给的渲染，**只有 `running` 才带动效**；
 *   6. 「等待答复」徽标只在真的在等时出现；
 *   7. **没有「结束原因」这一格**（用户 2026-10-07 口径）：它连着 `agent-log-facts-exit` 一起从
 *      事实条与 `AgentLogFacts` 里删掉了，重建那一格时守卫红。
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
   * 用量那一格的文案走 `formatUsageTriple`（千分位 + `tok`，用户 2026-10-07 口径）。
   * 为什么值得钉：这一格此前只被「未采集」那条用例碰过，三元组的**形状**没人守——
   * 把它改回裸数字（`输入 218 · 缓存 8832 · 输出 1420`）时肉眼看不出，只有字面量断言能拦住。
   */
  it('用量三元组带千分位与 `tok` 单位（与里程碑 / 页脚 / 子任务卡片同一出口）', () => {
    render(<AgentLogFactsBar facts={facts()} waitingSince={null} />);

    expect(screen.getByTestId('agent-log-facts-tokens')).toHaveTextContent('输入 218 tok · 缓存 8,832 tok · 输出 1,420 tok');
  });

  /**
   * **第一行的格序**（用户 2026-10-07 口径）：状态 → 用量（输入 · 缓存 · 输出）→ 耗时 → **轮次**。
   * 轮次原先排在用量前面，把「这一次用了多少」那一串读断；它是「跑了几轮」这个过程读数，故排末尾。
   *
   * 判据取**行文本里的位置**（`indexOf`），不数 DOM 下标：格子的元素类型会变（`Flex` / `Text`），
   * 而读者看到的是那一行字的先后。
   */
  it('格序：用量 → 耗时 → 轮次（轮次排在末尾）', () => {
    render(<AgentLogFactsBar facts={facts()} waitingSince={null} />);

    const text = screen.getByTestId('agent-log-facts-bar').textContent ?? '';
    const input = text.indexOf('输入');
    const duration = text.indexOf('耗时');
    const turns = text.indexOf('轮次');

    expect(input, '用量那一格不在行里').toBeGreaterThanOrEqual(0);
    expect(duration, '耗时不在用量之后').toBeGreaterThan(input);
    expect(turns, '轮次没有排在末尾（它不再是用量前面那一格）').toBeGreaterThan(duration);
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
    // `subset-of-output` 那一格**不再附说明**（2026-10-07 用户口径：文案从简）；
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
   * 两条口径合一条（用户 2026-10-07）：
   *   · 轮次 `total` 为 `null` 时只说当前值——不编一个自己会走动的分母；
   *   · **「结束原因」这一格不再存在**：删掉字段与那一格之后，页面上不该再有它的痕迹。
   */
  it('轮次：total 为 null 时只说当前值；「结束原因」这一格不再出现', () => {
    render(<AgentLogFactsBar facts={facts({ turns: { current: 3, total: null } })} waitingSince={null} />);

    expect(screen.getByTestId('agent-log-facts-turns')).toHaveTextContent('轮次 3 轮');
    expect(screen.queryByTestId('agent-log-facts-exit')).toBeNull();
    expect(screen.queryByText(/结束原因/)).toBeNull();
  });

  it('内容被截断时如实显示那句话；null 时什么都不显示', () => {
    const { rerender } = render(
      <AgentLogFactsBar facts={facts()} waitingSince={null} contentTruncatedReason="只保留了最近 500 轮" />,
    );
    expect(screen.getByTestId('agent-log-facts-truncated')).toHaveTextContent('只保留了最近 500 轮');

    rerender(<AgentLogFactsBar facts={facts()} waitingSince={null} contentTruncatedReason={null} />);
    expect(screen.queryByTestId('agent-log-facts-truncated')).toBeNull();
  });
});
