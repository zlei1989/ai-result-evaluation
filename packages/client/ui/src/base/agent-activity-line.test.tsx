/**
 * `AgentActivityLine`：候选卡片底部的「智能体活动行」（用户口径，2026-09-29）。
 *
 * 这一行是**跑动期的动效 + 智能体最近一条输出**。四条口径必须有区分力：
 *   ① 终态不渲染——它是「正在……中」的指示，跑完还挂着等于在骗人；
 *   ② 还没有输出时回落成状态文案——一行空白会被读成「界面坏了」；
 *   ③ 单行截断——一条工具块 JSON 有几百字符，换行会把卡片撑高、把按钮挤出视口；
 *   ④ 类名是真的带上了——高光扫过全挂在那个类上，类名丢了只是「文字静止」，
 *      浏览器不报错、这里不红的话就没人会发现（CSS 那一侧的守卫在 `apps/web-next`）。
 * 前三条与展示有关，第四条是**跨包字符串契约**的一半。
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { EvalRowStatus } from '@aieval/contracts';
import { ACTIVITY_SWEEP_CLASS, ACTIVITY_TYPING_CLASS, AgentActivityLine, activityText, lastSegmentOf, staticActivityText, typingOf, type AgentActivity } from './agent-activity-line';
import { STREAM_CURSOR_CLASS } from './stream-cursor';

describe('activityText（这一行显示什么）', () => {
  it('三个运行态各有回落文案（还没有输出时不显示空白）', () => {
    expect(activityText('preparing', null)).toBe('正在准备…');
    expect(activityText('running', null)).toBe('正在思考…');
    expect(activityText('judging', null)).toBe('正在评分…');
  });

  it('有输出时显示输出本身，回落文案只在没输出时出现', () => {
    expect(activityText('running', '正在改 lib/http.js')).toBe('正在改 lib/http.js');
    expect(activityText('judging', '评分模型返回了 87 分')).toBe('评分模型返回了 87 分');
  });

  it('空串按「还没有输出」处理（上游挡过一次，这里不假设调用方一定干净）', () => {
    expect(activityText('running', '')).toBe('正在思考…');
  });

  it('非运行态一律返回 null——即使手里还攥着上一轮的残留文本', () => {
    const notRunning: EvalRowStatus[] = [
      'pending',
      'judged',
      'failed',
      'timed-out',
      'canceled',
      'skipped',
      'interrupted',
    ];
    for (const status of notRunning) {
      expect(activityText(status, '上一轮的残留文本'), status).toBeNull();
    }
  });
});

describe('AgentActivityLine', () => {
  it('运行中渲染一行文本，并带上高光扫过的类名（DSH 的 turnStatus 同款）', () => {
    render(<AgentActivityLine status="running" latestText="正在改 lib/http.js" />);

    const line = screen.getByTestId('agent-activity-line');
    expect(line).toHaveTextContent('正在改 lib/http.js');
    // 类名没带上 = 文字是静止的（`@keyframes` 挂在它上面），而页面不会有任何报错
    expect(line.className).toContain(ACTIVITY_SWEEP_CLASS);
  });

  it('还没有输出时显示回落文案，不是空白行', () => {
    render(<AgentActivityLine status="preparing" latestText={null} />);

    expect(screen.getByTestId('agent-activity-line')).toHaveTextContent('正在准备…');
  });

  it('单行截断：不换行、溢出省略（几百字符的 JSON 不许把卡片撑高）', () => {
    render(<AgentActivityLine status="running" latestText={'x'.repeat(500)} />);

    expect(screen.getByTestId('agent-activity-line')).toHaveStyle({
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
    });
  });

  it('终态不渲染任何东西（连空容器都不留）', () => {
    const { container } = render(<AgentActivityLine status="judged" latestText="上一轮的残留文本" />);

    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByTestId('agent-activity-line')).toBeNull();
  });
});

/**
 * 打字态（2026-10-10）：实时正文在流时逐字显示**最后一个非空段**，换行即清空重打。
 *
 * 判据分工（每条都有独立靶子）：
 *   · `lastSegmentOf` —— 取哪一段、段号怎么算（段号是 React `key`，它决定「重挂/不重挂」）；
 *   · `typingOf` —— 什么状态才走打字态（工具摘要与 `log.summary` 不走：它们没有「还在写」这个事实）；
 *   · 组件 —— 类名与光标真的带上了（跨包字符串契约的另一半），且不传 `activity` 时行为与改造前相同。
 */
describe('lastSegmentOf（换行取最后一段）', () => {
  it('多段取最后一段，段号是它在切分结果里的下标', () => {
    expect(lastSegmentOf('第一段\n第二段\n第三段')).toEqual({ segment: '第三段', segmentIndex: 2 });
  });

  it('尾随换行（模型刚敲下回车、新内容还没来）取**上一段**，不是空串', () => {
    // 取到空串的表现是：那一行突然变成空白，比停在上一条更糟
    expect(lastSegmentOf('已经写完的一段\n')).toEqual({ segment: '已经写完的一段', segmentIndex: 0 });
  });

  it('段内首尾空白被裁掉（缩进与空行不进这一行）', () => {
    expect(lastSegmentOf('  带缩进的一段  ')).toEqual({ segment: '带缩进的一段', segmentIndex: 0 });
  });

  it('段号只随**换行**变：同一段内追加文字，段号不动（不该重挂元素）', () => {
    const before = lastSegmentOf('正在写');
    const after = lastSegmentOf('正在写下去');
    expect(after.segmentIndex).toBe(before.segmentIndex);
    expect(after.segment).toBe('正在写下去');
  });
});

describe('typingOf / staticActivityText（这一拍走打字还是走静态档）', () => {
  const streaming: AgentActivity = { text: '正在改 lib/http.js', streaming: true, toolSummary: null };

  it('运行态 + 有正文 ⇒ 打字态，并透传「还在写」这一格', () => {
    expect(typingOf('running', streaming)).toEqual({ segment: '正在改 lib/http.js', segmentIndex: 0, streaming: true });
  });

  it('运行态 + 只有空白正文 ⇒ 不走打字态（显示成空白比停在上一条更糟）', () => {
    expect(typingOf('running', { text: '\n\n', streaming: true, toolSummary: null })).toBeNull();
  });

  it('终态 ⇒ 不走打字态，即使手里还攥着正文', () => {
    expect(typingOf('judged', streaming)).toBeNull();
    expect(staticActivityText('judged', '上一轮的残留文本', streaming)).toBeNull();
  });

  it('没有 activity（老调用方 / 环境没有 EventSource）⇒ 与改造前逐字相同', () => {
    expect(typingOf('running', undefined)).toBeNull();
    expect(staticActivityText('running', '正在思考…', undefined)).toBe('正在思考…');
  });

  it('静态档：工具摘要优先于 log 摘要，两者都没有才回落文案', () => {
    const tool: AgentActivity = { text: null, streaming: false, toolSummary: '调用工具 Read：a.ts' };
    expect(staticActivityText('running', '旧的一句', tool)).toBe('调用工具 Read：a.ts');
    expect(staticActivityText('running', '旧的一句', null)).toBe('旧的一句');
    expect(staticActivityText('running', null, { text: null, streaming: false, toolSummary: '' })).toBe('正在思考…');
  });
});

describe('AgentActivityLine 的打字态', () => {
  it('渲染最后一个非空段，带打字类名；还在写时挂闪烁光标', () => {
    render(
      <AgentActivityLine
        status="running"
        latestText="log 摘要（不该被显示）"
        activity={{ text: '第一段\n正在写第二段', streaming: true, toolSummary: null }}
      />,
    );

    const line = screen.getByTestId('agent-activity-line');
    expect(line).toHaveTextContent('正在写第二段');
    expect(line).not.toHaveTextContent('第一段');
    expect(line).not.toHaveTextContent('log 摘要（不该被显示）');
    expect(line.className).toContain(ACTIVITY_TYPING_CLASS);
    expect(line.className).toContain(STREAM_CURSOR_CLASS);
    // **不打**高光类：打字态与「文字不动」那一档是两种观感，叠在一起会互相干扰
    expect(line.className).not.toContain(ACTIVITY_SWEEP_CLASS);
  });

  it('收尾（快照到了）⇒ 保留文字但撤掉光标：逐字灯不再亮，但内容还在', () => {
    render(
      <AgentActivityLine status="running" latestText={null} activity={{ text: '写完了这一段', streaming: false, toolSummary: null }} />,
    );

    const line = screen.getByTestId('agent-activity-line');
    expect(line).toHaveTextContent('写完了这一段');
    expect(line.className).toContain(ACTIVITY_TYPING_CLASS);
    expect(line.className).not.toContain(STREAM_CURSOR_CLASS);
  });

  it('只有工具摘要时走静态档（高光那一路），不带光标——它没有「还在写」这个事实', () => {
    render(
      <AgentActivityLine
        status="judging"
        latestText={null}
        activity={{ text: null, streaming: false, toolSummary: '调用工具 Read：a.ts' }}
      />,
    );

    const line = screen.getByTestId('agent-activity-line');
    expect(line).toHaveTextContent('调用工具 Read：a.ts');
    expect(line.className).toContain(ACTIVITY_SWEEP_CLASS);
    expect(line.className).not.toContain(STREAM_CURSOR_CLASS);
  });
});
