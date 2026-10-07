/**
 * `AgentLogFactsBar`（L1）的守卫。六条，全都围绕「`null` 不等于 0」：
 *   1. 用量未采集时**不显示 0**；错误格只在真有错误时出现；
 *   2. 耗时：未结束本地走秒表（数字在涨）、终态用 `endedAt − startedAt` 的结算值；
 *   3. 思考 token **只在与用量并列的那一格**显示，且**不与用量相加**（`basis !== 'additive'`
 *      时那一格也不附任何说明，2026-10-07 口径）；
 *   4. `facts.domain` 按数据层给的顺序照画，空数组时这一行不出现；**每段怎么画全看数据层的声明**
 *      （2026-10-07）：`segments` 走 git stat 上色、`hintSegments` 的 `tag` 段画成蓝 Tag；
 *   5. `status.label` 照数据给的渲染，**只有 `running` 才带动效**；
 *   6. 「等待答复」徽标只在真的在等时出现（另加「结束原因按语义染色」一条）。
 */
import { act, render, screen } from '@testing-library/react';
import { ConfigProvider } from 'antd';
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
    exitReason: null,
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

  it('facts.domain 按数据层给的顺序照画；空数组时这一行不出现', () => {
    const domain = [
      {
        id: 'diff',
        label: '改动',
        value: '3 个文件 +12 −3',
        segments: [
          { text: '3 个文件 ' },
          { text: '+12', tone: 'insertion' as const },
          { text: ' −3', tone: 'deletion' as const },
        ],
      },
      {
        id: 'score',
        label: '评分',
        value: '8/10',
        tone: 'success' as const,
        hint: '评分模型：deepseek-chat',
        hintSegments: [{ text: '评分模型：' }, { text: 'deepseek-chat', tag: true as const }],
      },
    ];
    const { rerender } = render(<AgentLogFactsBar facts={facts({ domain })} waitingSince={null} />);

    const row = screen.getByTestId('agent-log-facts-domain');
    expect(screen.getByText('改动')).toBeInTheDocument();
    expect(screen.getByText('+12')).toBeInTheDocument();
    expect(screen.getByText('−3')).toBeInTheDocument();
    expect(screen.getByText('评分')).toBeInTheDocument();
    expect(screen.getByText('8/10')).toBeInTheDocument();
    const text = row.textContent ?? '';
    expect(text.indexOf('改动')).toBeLessThan(text.indexOf('评分'));

    rerender(<AgentLogFactsBar facts={facts({ domain: [] })} waitingSince={null} />);
    expect(screen.queryByTestId('agent-log-facts-domain')).toBeNull();
  });

  /**
   * 改动那一格的画法（2026-10-07 用户口径）：**按 git stat 重排**——文件数次要色 + `+N` 绿 + `−N` 红，
   * 且**外面不再套 Tag**（套一枚徽标等于把这行数字框成一整块，正是要去掉的那个观感）。
   *
   * 颜色判据用**自定义 token**（同 `json-text.test.tsx`）：写死字面量——哪怕是当前默认值——都会红；
   * 归一化那一步不能省，jsdom 会把 `#234567` 序列化成 `rgb(35, 69, 103)`。
   */
  it('改动那一格按 git stat 上色（+N 绿 / −N 红，都取自 antd token），且整格没有 Tag', () => {
    const custom = { colorSuccess: '#234567', colorError: '#345678' };
    const domain = [
      {
        id: 'diff',
        label: '改动',
        value: '3 个文件 +12 −3',
        segments: [
          { text: '3 个文件 ' },
          { text: '+12', tone: 'insertion' as const },
          { text: ' −3', tone: 'deletion' as const },
        ],
      },
    ];
    render(
      <ConfigProvider theme={{ token: custom }}>
        <AgentLogFactsBar facts={facts({ domain })} waitingSince={null} />
      </ConfigProvider>,
    );
    const probe = (color: string): string => {
      const element = document.createElement('span');
      element.style.color = color;
      return element.style.color;
    };

    expect(screen.getByText('+12').style.color).toBe(probe(custom.colorSuccess));
    expect(screen.getByText('−3').style.color).toBe(probe(custom.colorError));
    // 「3 个文件」是次要色：整段外面是 antd 的 secondary `Text`（不是自己调一个灰）
    expect(screen.getByText('+12').parentElement?.className).toContain('ant-typography-secondary');
    expect(screen.getByTestId('agent-log-facts-domain').querySelectorAll('.ant-tag')).toHaveLength(0);
  });

  /**
   * 提示里的模型名（2026-10-07 用户口径：**用 blue 的 Tag 染色**）：`hintSegments` 里 `tag: true`
   * 的那一段画成 Tag，其余文字仍是次要色；而值那一格该是色档 Tag 就还是色档 Tag（两枚 Tag 各归各位）。
   */
  it('提示里的模型名画成蓝 Tag，值那一格的色档 Tag 不受影响', () => {
    const domain = [
      {
        id: 'score',
        label: '评分',
        value: '8/10',
        tone: 'success' as const,
        hint: '评分模型：deepseek-chat',
        hintSegments: [{ text: '评分模型：' }, { text: 'deepseek-chat', tag: true as const }],
      },
    ];
    const { container } = render(<AgentLogFactsBar facts={facts({ domain })} waitingSince={null} />);

    expect(screen.getByText('deepseek-chat').closest('.ant-tag')).toHaveClass('ant-tag-blue');
    expect(screen.getByText('8/10').closest('.ant-tag')).toHaveClass('ant-tag-success');
    expect(container.querySelectorAll('[data-testid="agent-log-facts-domain"] .ant-tag')).toHaveLength(2);
  });

  /**
   * 结束原因的 Tag 色档（2026-10-07 用户口径）。这些词是**我们编排层**结算时写下的账，
   * 其中六个与行状态同一个处境 ⇒ 颜色直接取 `ROW_STATUS_COLORS`（`completed` = 「已评分」那一档）；
   * 没见过的词退回 `default`——不替未知编一个颜色。
   */
  it('结束原因按语义染色；没见过的词退回默认色', () => {
    const exitTag = (): HTMLElement => screen.getByTestId('agent-log-facts-exit').querySelector('.ant-tag') as HTMLElement;
    const { rerender } = render(<AgentLogFactsBar facts={facts({ exitReason: 'completed' })} waitingSince={null} />);
    expect(exitTag()).toHaveClass('ant-tag-success');

    rerender(<AgentLogFactsBar facts={facts({ exitReason: 'error' })} waitingSince={null} />);
    expect(exitTag()).toHaveClass('ant-tag-error');

    rerender(<AgentLogFactsBar facts={facts({ exitReason: 'canceled' })} waitingSince={null} />);
    expect(exitTag()).toHaveClass('ant-tag-orange');

    rerender(<AgentLogFactsBar facts={facts({ exitReason: '这不是一个我们写过的词' })} waitingSince={null} />);
    expect(exitTag()).toHaveClass('ant-tag-default');
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

  it('轮次与结束原因：total 为 null 时只说当前值，结束原因为 null 时整格不出现', () => {
    const { rerender } = render(
      <AgentLogFactsBar facts={facts({ turns: { current: 3, total: null }, exitReason: 'completed' })} waitingSince={null} />,
    );
    expect(screen.getByTestId('agent-log-facts-turns')).toHaveTextContent('轮次 3 轮');
    expect(screen.getByTestId('agent-log-facts-exit')).toHaveTextContent('结束原因 completed');

    rerender(<AgentLogFactsBar facts={facts({ exitReason: null })} waitingSince={null} />);
    expect(screen.queryByTestId('agent-log-facts-exit')).toBeNull();
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
