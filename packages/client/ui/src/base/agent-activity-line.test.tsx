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
import { ACTIVITY_SWEEP_CLASS, AgentActivityLine, activityText } from './agent-activity-line';

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
