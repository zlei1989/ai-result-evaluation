'use client';

/**
 * 候选卡片底部的**活动行**：跑动期显示智能体最近一条输出；有实时正文在流时，**逐字打字**
 * 显示最后一个非空段。文字本身不动的那一档，一条高光带周期性扫过。
 *
 * 动效参考 DSH 的 `dsh-turn-status-shimmer`（`ChatView.module.css`：1.8s linear infinite、
 * `background-size: 250%`、`background-clip: text` 的渐变位移）——那是它「正在思考」那一行的观感，
 * 也是本仓「执行中」需要的观感。**动画本身不在这里**：ui 包一个 CSS 文件都没有，
 * 而全局样式只有 `apps/web-next/app/globals.css` 一处（它已经确立了「提供变量/类名供 ui 消费」的口径）。
 * 于是这里只负责带上类名，由 `apps/web-next` 的守卫读那份 CSS 钉住两边一致：
 * 类名对不上时**浏览器不会报错**，表现只是「文字静止」——那正是需要一条守卫的原因。
 *
 * 六条设计口径：
 *   1. **只有运行态才出现**（`activityText` 对终态返回 `null`）：它的语义是「正在……中」，
 *      跑完还挂着一句「正在思考」比不显示更糟；
 *   2. **还没有输出时给回落文案**：空白行会被读成「界面坏了」，而此刻的真实情况是「还没开始说话」；
 *   3. **单行截断、不挂 Tooltip**：一条工具块 JSON 有几百字符，换行会把卡片撑高、把按钮挤出视口；
 *      而一个每秒都在变的浮层是噪声——全量内容本来就在「执行日志」里，那里才是读日志的地方；
 *   4. **颜色取 `theme` 之外的两个既有主题变量**（`--app-muted` / `--app-fg`，见 globals.css）：
 *      把 antd token 再复制一份进 CSS 就是第二份真源，主题一改必漂移。字号与行内边距一律不写
 *      （交紧凑密度与 `Typography` 的默认值，AGENTS.md 的硬口径）；
 *   5. **实时正文优先、历史摘要兜底**：有 `activity.text` 就走打字态
 *      （最后一个非空段 + 闪烁光标），否则看工具块的摘要，最后才回落到 `log.summary`。
 *      这条分层是有意的——实时那条流**不回放历史**，刷新页面后它拿不到任何东西，
 *      而 `log.summary` 那一路有历史，两者叠起来才是「实时优先、历史兜底」；
 *   6. **换行即清空重打**：只有一行可显示，模型换行意味着上一段说完了 ⇒ 取**最后一个非空段**，
 *      并用段号当 React `key`——同一段内持续追加不重挂（打字），换段才重挂（入场动画重放）。
 */
import { Typography } from 'antd';
import type { CSSProperties, ReactNode } from 'react';
import type { EvalRowStatus } from '@aieval/contracts';
import { STREAM_CURSOR_CLASS } from './stream-cursor';

/**
 * 高光扫过用的类名。导出而不是就地写字面量：`apps/web-next/src/global-styles.test.ts` 要拿它去 CSS 里核对，
 * 两处各写一份字符串必然漂移，而漂移的症状是静默的（动画消失、无任何报错）。
 */
export const ACTIVITY_SWEEP_CLASS = 'aieval-activity-sweep';

/**
 * 打字态类名。换行重打的入场动画挂在它下面（样式在 `globals.css`），
 * 与 `ACTIVITY_SWEEP_CLASS` 同一处置：跨包一致性由同一条守卫钉住。
 */
export const ACTIVITY_TYPING_CLASS = 'aieval-activity-typing';

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
 * 实时活动（与 `@aieval/client` 的 `RowActivity` **逐字段一致**）。
 * ui 不能 import client（分层表），故在此重复声明——两处必须同步改，判据是字段名与可空性逐字相同。
 */
export interface AgentActivity {
  /** 正文的**累积**文本；null = 这一刻没有正文在流 */
  text: string | null;
  /** 还在写 ⇒ 挂闪烁光标（判据只有消息级 `assembly`） */
  streaming: boolean;
  /** 工具块的一句话摘要；null = 这一刻没有工具活动 */
  toolSummary: string | null;
}

/** 打字态要渲染的东西：哪一段、段号（React key）、要不要挂光标 */
export interface ActivityTyping {
  segment: string;
  segmentIndex: number;
  streaming: boolean;
}

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

/**
 * 静态档的文案：工具块摘要优先于 `log.summary`（同一次工具调用两者是同一句话，但**摘要来自消息、
 * 摘要来自日志**是两条路，消息那条在评分阶段也可能先到），最后才是日志摘要与回落文案。
 * 非运行态一律 `null`（这一行收起）。
 */
export function staticActivityText(
  status: EvalRowStatus,
  latestText: string | null,
  activity: AgentActivity | null | undefined,
): string | null {
  switch (status) {
    case 'preparing':
    case 'running':
    case 'judging': {
      const tool = activity?.toolSummary ?? '';
      if (tool !== '') return tool;
      return activityText(status, latestText);
    }
    default:
      return null;
  }
}

/**
 * 取文本的**最后一个非空段**（换行即换段），连同它的段号。
 *
 * 为什么取最后一段：活动行只有一行（`white-space: nowrap` + 省略号），而模型换行意味着
 * 「上一段写完了」——显示新的那一段，观感就是「清空重打」，比整行文字被替换一下更接近「正在写」。
 * 段号（而不是段内容）当 React key：同一段内持续追加（打字）不该重挂元素，
 * 换段时才重挂 ⇒ 入场动画重放一次。
 */
export function lastSegmentOf(text: string): { segment: string; segmentIndex: number } {
  const segments = text.split('\n');
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = (segments[index] ?? '').trim();
    if (segment !== '') return { segment, segmentIndex: index };
  }
  return { segment: '', segmentIndex: Math.max(segments.length - 1, 0) };
}

/**
 * 这一拍该不该走打字态：**运行态**且**有实时正文**。
 * 工具摘要与 `log.summary` 不走打字态——它们本来就是完整的一句话，逐字重打只是噪声
 * （而且它们没有「还在写」这个事实，挂上光标就是撒谎）。
 */
export function typingOf(status: EvalRowStatus, activity: AgentActivity | null | undefined): ActivityTyping | null {
  switch (status) {
    case 'preparing':
    case 'running':
    case 'judging': {
      const text = activity?.text ?? '';
      if (text === '') return null;
      const { segment, segmentIndex } = lastSegmentOf(text);
      // 整段都是空白（模型刚吐出几个换行）：没有可显示的字，宁可停在上一档
      if (segment === '') return null;
      return { segment, segmentIndex, streaming: activity?.streaming === true };
    }
    default:
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
   *（这一行动效里不能出现 `{"method":"session.event",…}`）——
   * 所以这里不做任何 JSON 判断，`activityText` 只负责「运行态怎么显示、终态怎么收起」。
   */
  latestText: string | null;
  /**
   * 实时消息流折出来的活动（`@aieval/client` 的 `useRunActivity`）。
   * 不传 / `null` = 没有这条流（老调用方、或环境没有 `EventSource`）⇒ 行为与改造前逐字相同。
   */
  activity?: AgentActivity | null | undefined;
}

export function AgentActivityLine({ status, latestText, activity }: AgentActivityLineProps): ReactNode {
  const typing = typingOf(status, activity);
  if (typing !== null) {
    return (
      <Typography.Text
        className={typing.streaming ? `${ACTIVITY_TYPING_CLASS} ${STREAM_CURSOR_CLASS}` : ACTIVITY_TYPING_CLASS}
        style={TRUNCATE_STYLE}
        data-testid="agent-activity-line"
        // 用例据此分辨「打字态」与「静态档」：两者的文案可能一样，行为却不同
        data-typing="true"
      >
        <span key={typing.segmentIndex}>{typing.segment}</span>
      </Typography.Text>
    );
  }
  const text = staticActivityText(status, latestText, activity);
  if (text === null) return null;
  return (
    <Typography.Text className={ACTIVITY_SWEEP_CLASS} style={TRUNCATE_STYLE} data-testid="agent-activity-line">
      {text}
    </Typography.Text>
  );
}
