'use client';

/**
 * 工具条动作的**预设**（L2）：本仓的业务口径只住在这个文件里。
 *
 * 为什么是数据而不是组件：`ToolbarAction[]` 交出去之后，「换一套动作」是传一个数组，
 * 而「工具条长什么样」（`Flex` + `Button` / `Switch` / `InputNumber` 的摆法）只有一处；
 * 监控台场景可以把同一批动作渲染到侧栏上，动作本身的定义不用重写。
 *
 * 两处**有意相反**的显隐规则（不要统一成「没数据就不渲染」）：
 *   · 「原始输出 N 条」：`diagnostics` 未给、或 `lines` 为空 ⇒ **不渲染**（没有原文就没有入口）；
 *   · 「环境信息」：`environment` 未给 ⇒ **照常渲染**，抽屉里如实显示「未提供」
 * （「没有这个功能」与「这次没采到」要分得开）。
 */
import { createElement, useMemo, type ReactNode } from 'react';
import { BugFilled, DownloadOutlined, MessageFilled } from '@ant-design/icons';
import type { FollowUpVerdict } from '@aieval/contracts';
import type { AgentLogDiagnostics, AgentEnvironment, Loadable } from './types';
import type { AgentLogViewState } from './use-agent-log-view';

/**
 * 一个工具条动作。**默认那八个是「一套预设」，不是「工具条只会这八个」**——
 * 通用消费方增删动作不必改组件。
 */
export interface ToolbarAction {
  /** 稳定键：React key 与测试定位都用它，**不用数组下标** */
  key: string;
  /** 可访问名（按钮文案；纯图标按钮上它是 `aria-label`） */
  label: string;
  /**
   * 纯图标按钮的 Tooltip 文案。不给就用 `label`。
   *
   * 单独一格的用途是「可访问名不变、悬停说明随状态变」：追问按钮的 `label` 恒为「追问」，
   * 而禁用时要给出服务端那一句拒绝原因（长句不该进 `aria-label`）。
   */
  tooltip?: string;
  /** 给了就渲成纯图标按钮（图标必须 `aria-hidden`，见预设里的那几处） */
  icon?: ReactNode;
  /**
   * 纯图标按钮的边框形态：`text` 无边框（默认，贴着开关 / 数值框放），
   * `outlined` 有边框（与同排的普通按钮同一族）。只在给了 `icon` 时生效。
   */
  iconVariant?: 'text' | 'outlined';
  /** 纯图标按钮的形状：`circle` 渲成圆形（透明底），不给就是方的 */
  shape?: 'circle';
  onSelect?(): void;
  /** 渲不渲染。两个反例见文件头（原始输出 / 环境信息） */
  visible?: boolean;
  /**
   * 已渲染好的控件：给了就**原样渲染它**，不看 `icon` / `toggle` / `number` / `onSelect`。
   * 用于「控件本体住在持有状态的那一层」：入口与受控抽屉由同一个件持有（「原始输出」），
   * 动作数据只负责它在簇里的位置与显隐。
   */
  entry?: ReactNode;
  /** 受控开关类动作（跟随最新 / 只看工具 / 只看错误）：给了就渲染成开关 */
  toggle?: { checked: boolean; onChange(next: boolean): void };
  /** 数值输入类动作（跳转）：给了就越界 clamp 并如实回显 */
  number?: { value: number; min: number; max: number; onSubmit(next: number): void };
  disabled?: boolean;
  /**
   * 画在**图标按钮那一簇**：标了它的动作合成一个渲染区，组内间距 `marginXXS`（4px）；
   * 没标的仍按工具条的 `marginSM`（12px）排。追问 / 环境信息 / 原始输出 / 下载台账
   * 这四颗适合贴成一簇读，开关与数值框不该跟着收紧——故这是「与谁贴在一起」的声明，不是外观开关。
   */
  iconGroup?: boolean;
}

/**
 * 预设的输入。**这正是不许硬编码的理由**：它要拿到「当前数据长什么样」与「当前视图态」，
 * 才能算出每个动作的 `visible` / `checked` / 回显值。
 */
export interface AgentLogToolbarPresetInput {
  /** 原始输出（决定「原始输出 N 条」渲不渲染） */
  diagnostics?: Loadable<AgentLogDiagnostics>;
  /**
   * 环境信息。**本预设不读它**：问号按钮的 `visible` 恒为真，数据有没有由抽屉自己说
   * （「未提供」而不是不渲染）。留着这一格是因为调用方手上就是这份数据，
   * 换个消费方要按它调文案时不必改接口。
   */
  environment?: Loadable<AgentEnvironment>;
  /** 轮次总数（「跳转」的 `min` / `max`） */
  turnCount: number;
  /** 当前轮次（「跳转」的回显值；越界时 clamp 后**如实回显**） */
  currentTurn: number;
  /** 视图态（跟随最新 / 过滤两个开关的受控值） */
  viewState: AgentLogViewState;
  onDownload?(): void;
  /** 「跳转」提交（回车 / 失焦），入参已 clamp 到 `[1, max]` */
  onJumpToTurn(turn: number): void;
  /** 「？环境信息」被点：打开环境抽屉（**同时**向数据层上报由调用方接线） */
  onOpenEnvironment(): void;
  /**
   * 「追问」入口被点：打开这个候选的追问输入区。
   *
   * 不给就**不渲染那颗按钮**（同「下载台账」：一个点了没反应的按钮比没有按钮更糟）；
   * 它与候选卡片上那颗「追问」是同一个动作的第二个入口——追问要看上下文写那句话，
   * 人在日志抽屉里时不该被赶回卡片上去点。
   */
  onFollowUp?(): void;
  /**
   * 追问可用性（服务端读侧那一份，与卡片按钮同源）：`ok` 可点、`ok: false` 用它那句原因当
   * Tooltip、**缺席 = 读不到判据**（照旧禁用，并说清要刷新）。
   * 判据不在这里算：七档拒绝里有一半的事实在盘上与厂商声明上，浏览器一格都看不到。
   */
  followUpVerdict?: FollowUpVerdict;
}

/** 原始输出的行数：只在 `ready` 时才是一个真读数（`loading` / `error` 都不是 0 条） */
function diagnosticsLineCount(diagnostics: Loadable<AgentLogDiagnostics> | undefined): number {
  return diagnostics !== undefined && diagnostics.status === 'ready' ? diagnostics.data.lines.length : 0;
}

/** 纯函数版本：便于单测（hook 只是它的薄包装） */
export function agentLogToolbarPreset(input: AgentLogToolbarPresetInput): readonly ToolbarAction[] {
  const {
    diagnostics,
    turnCount,
    currentTurn,
    viewState,
    onDownload,
    onJumpToTurn,
    onOpenEnvironment,
    onFollowUp,
    followUpVerdict,
  } = input;
  const lines = diagnosticsLineCount(diagnostics);
  // 上限取 `max(turnCount, 1)`：`min` 恒为 1，`max` 小于 `min` 的输入框是自相矛盾的
  const maxTurn = Math.max(turnCount, 1);
  const shownTurn = Math.min(Math.max(currentTurn, 1), maxTurn);
  /**
   * 追问的三态与卡片按钮同一套措辞：`ok` 可点；`ok: false` 用服务端那句原因；
   * **判据缺席 ≠ 不可追问**——它说的是「还没读到」，处置是刷新而不是换一件事做。
   */
  const followUpHint = followUpVerdict === undefined
    ? '读不到这个候选的追问判据（服务端没给出）：请刷新后重试'
    : followUpVerdict.ok
      ? '追问'
      : followUpVerdict.reason;

  return [
    {
      key: 'follow-up',
      label: '追问',
      // 图标必须 aria-hidden：`@ant-design/icons` 给每个图标挂了 role/aria-label，
      // 不藏起来按钮的可访问名会变成「message 追问」
      icon: createElement(MessageFilled, { 'aria-hidden': true }),
      // 圆形、透明底：与「环境信息」「下载台账」同一族；四颗合成图标那一簇
      iconVariant: 'text',
      shape: 'circle',
      iconGroup: true,
      // 没有打开输入区的回调就不渲染入口：一颗点不动的按钮等于把「不能追问」说成「能」
      visible: onFollowUp !== undefined,
      disabled: followUpVerdict?.ok !== true,
      tooltip: followUpHint,
      onSelect: onFollowUp,
    },
    {
      key: 'jump',
      label: '跳转',
      visible: turnCount > 0,
      number: { value: shownTurn, min: 1, max: maxTurn, onSubmit: onJumpToTurn },
    },
    {
      key: 'follow',
      label: '跟随最新',
      toggle: { checked: viewState.follow, onChange: viewState.setFollow },
    },
    {
      key: 'only-tools',
      label: '只看工具',
      toggle: {
        checked: viewState.filters.onlyTools,
        // 过滤两格是**一个对象**：改一格要把另一格原样带上（AND 叠加，两个开关互不重置）
        onChange: (next) => viewState.setFilters({ ...viewState.filters, onlyTools: next }),
      },
    },
    {
      key: 'only-errors',
      label: '只看错误',
      toggle: {
        checked: viewState.filters.onlyErrors,
        onChange: (next) => viewState.setFilters({ ...viewState.filters, onlyErrors: next }),
      },
    },
    {
      key: 'environment',
      label: '环境信息',
      // 图标必须 aria-hidden：`@ant-design/icons` 给每个图标挂了 role/aria-label，
      // 不藏起来按钮的可访问名会变成「bug 环境信息」
      icon: createElement(BugFilled, { 'aria-hidden': true }),
      // 圆形、透明底：与「原始输出」「下载台账」同一族；三颗合成图标那一簇
      shape: 'circle',
      iconGroup: true,
      visible: true,
      onSelect: onOpenEnvironment,
    },
    {
      key: 'raw',
      label: `原始输出 ${lines} 条`,
      visible: lines > 0,
      // 这一格只决定原文入口在图标簇里的位置与显隐：控件本体（圆形图标按钮 + 受控二级抽屉）
      // 由布局注入 `entry`，它持有抽屉的开合态与「我需要原文了」的上报。
      iconGroup: true,
    },
    {
      key: 'download',
      label: '下载台账',
      // 图标必须 aria-hidden：`@ant-design/icons` 给图标挂了 role/aria-label，
      // 不藏起来按钮的可访问名会变成「download 下载台账」
      icon: createElement(DownloadOutlined, { 'aria-hidden': true }),
      // 圆形、透明底：它排在「原始输出」之后，与那一排图标同属次级动作
      iconVariant: 'text',
      shape: 'circle',
      iconGroup: true,
      // 没有下载回调就不渲染入口：一个点了没反应的按钮比没有按钮更糟
      visible: onDownload !== undefined,
      onSelect: onDownload,
    },
  ];
}

/** 预设的 hook 版：同一份输入不重算（动作数组会被 `Flex` 逐项渲染，重算等于每帧新建八个对象） */
export function useAgentLogToolbarPreset(input: AgentLogToolbarPresetInput): readonly ToolbarAction[] {
  const {
    diagnostics,
    environment,
    turnCount,
    currentTurn,
    viewState,
    onDownload,
    onJumpToTurn,
    onOpenEnvironment,
    onFollowUp,
    followUpVerdict,
  } = input;
  return useMemo(
    () =>
      agentLogToolbarPreset({
        diagnostics,
        environment,
        turnCount,
        currentTurn,
        viewState,
        onDownload,
        onJumpToTurn,
        onOpenEnvironment,
        onFollowUp,
        followUpVerdict,
      }),
    [
      diagnostics,
      environment,
      turnCount,
      currentTurn,
      viewState,
      onDownload,
      onJumpToTurn,
      onOpenEnvironment,
      onFollowUp,
      followUpVerdict,
    ],
  );
}
