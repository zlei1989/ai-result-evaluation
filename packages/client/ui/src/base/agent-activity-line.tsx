'use client';

/**
 * 候选卡片底部的**活动行**：跑动期显示智能体最近一条输出，文字本身不动、一条高光带周期性扫过。
 *
 * 动效参考 DSH 的 `dsh-turn-status-shimmer`（`ChatView.module.css`：1.8s linear infinite、
 * `background-size: 250%`、`background-clip: text` 的渐变位移）——那是它「正在思考」那一行的观感，
 * 也是本仓「执行中」需要的观感。**动画本身不在这里**：ui 包一个 CSS 文件都没有，
 * 而全局样式只有 `apps/web-next/app/globals.css` 一处（它已经确立了「提供变量/类名供 ui 消费」的口径）。
 * 于是这里只负责带上类名 `ACTIVITY_SWEEP_CLASS`，由 `apps/web-next` 的守卫读那份 CSS 钉住两边一致：
 * 类名对不上时**浏览器不会报错**，表现只是「文字静止」——那正是需要一条守卫的原因。
 *
 * 四条设计口径：
 *   1. **只有运行态才出现**（`activityText` 对终态返回 `null`）：它的语义是「正在……中」，
 *      跑完还挂着一句「正在思考」比不显示更糟；
 *   2. **还没有输出时给回落文案**：空白行会被读成「界面坏了」，而此刻的真实情况是「还没开始说话」；
 *   3. **单行截断、不挂 Tooltip**：一条工具块 JSON 有几百字符，换行会把卡片撑高、把按钮挤出视口；
 *      而一个每秒都在变的浮层是噪声——全量内容本来就在「执行日志」里（**子任务的内容在它的面包屑里**），
 *      那里才是读日志的地方；
 *   4. **颜色取 `theme` 之外的两个既有主题变量**（`--app-muted` / `--app-fg`，见 globals.css）：
 *      把 antd token 再复制一份进 CSS 就是第二份真源，主题一改必漂移。字号与行内边距一律不写
 *      （交紧凑密度与 `Typography` 的默认值，AGENTS.md 的硬口径）。
 */
import { Typography } from 'antd';
import type { CSSProperties, ReactNode } from 'react';
import type { EvalRowStatus } from '@aieval/contracts';

/**
 * 高光扫过用的类名。
 * 导出而不是就地写字面量：`apps/web-next/src/global-styles.test.ts` 要拿它去 CSS 里核对，
 * 两处各写一份字符串必然漂移，而漂移的症状是静默的（动画消失、无任何报错）。
 */
export const ACTIVITY_SWEEP_CLASS = 'aieval-activity-sweep';

/**
 * 单行截断的结构性样式。
 * 手写这三条而**不用** `Typography.Text` 的 `ellipsis`：那个变体会在首次省略时量出并固定宽度
 * （antd 文档原文：「it will fix width on the first ellipsis」），而这一行的文字每隔一拍就换一次，
 * 量出来的宽度只对旧文本成立；纯 CSS 省略没有这个问题，也不必给 jsdom 补 `ResizeObserver` 桩。
 * 只写结构性属性（显示方式与溢出），不碰字号与间距。
 */
const TRUNCATE_STYLE: CSSProperties = {
  display: 'block',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};

/**
 * 三个运行态的回落文案。
 * **不是** `ROW_STATUS_LABELS` 的副本而是另写一句：那边是「执行中」，套进「正在……中」是病句；
 * 这里要的是「正在思考」这种**活动**的说法（用户口径原文：正在思考 / 加载中 / 生成中）。
 */
const ACTIVITY_FALLBACK: Record<'preparing' | 'running' | 'judging', string> = {
  preparing: '正在准备…',
  running: '正在思考…',
  judging: '正在评分…',
};

/**
 * 这一行显示什么：运行态给**给人看的那句话**，还没有消息时给回落文案；非运行态返回 `null`。
 * 用 `switch` 而不是 `isRunningRow(status)` + 一次类型断言：前者让「新增状态时这里漏了一格」
 * 变成调用方可见的编译期问题，后者要靠 `as` 把类型按下去——而漏掉新状态正是这样发生的。
 * 空串同样按「还没有消息」处理：上游 `activityOf` 已经挡过一次，这里不假设调用方一定干净。
 */
export function activityText(status: EvalRowStatus, latestText: string | null): string | null {
  switch (status) {
    case 'preparing':
    case 'running':
    case 'judging':
      return latestText === null || latestText === '' ? ACTIVITY_FALLBACK[status] : latestText;
    default:
      // 终态（含 pending）：这一行随行结束收起，不留下任何残留
      return null;
  }
}

export interface AgentActivityLineProps {
  /** 这一行此刻的状态（决定显不显示、以及没消息时说什么） */
  status: EvalRowStatus;
  /**
   * **给人看的一句话**（`log.summary` 优先，判定在 `@aieval/client` 的 `activityOf`）；
   * null = 还没有可说的事（显示回落文案）。
   * 传进来的**必须是消息**：厂商信封那种 JSON 早在数据层就被挡在门外了
   *（用户口径 2026-09-29：这一行动效里不能出现 `{"method":"session.event",…}`）——
   * 所以这里不做任何 JSON 判断，`activityText` 只负责「运行态怎么显示、终态怎么收起」。
   */
  latestText: string | null;
}

export function AgentActivityLine({ status, latestText }: AgentActivityLineProps): ReactNode {
  const text = activityText(status, latestText);
  if (text === null) return null;
  return (
    <Typography.Text className={ACTIVITY_SWEEP_CLASS} style={TRUNCATE_STYLE} data-testid="agent-activity-line">
      {text}
    </Typography.Text>
  );
}
