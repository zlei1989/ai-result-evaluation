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
import { QuestionCircleOutlined } from '@ant-design/icons';
import type { AgentLogDiagnostics, AgentEnvironment, Loadable } from './types';
import type { AgentLogViewState } from './use-agent-log-view';

/**
 * 一个工具条动作。**默认那七个是「一套预设」，不是「工具条只会这七个」**——
 * 通用消费方增删动作不必改组件。
 */
export interface ToolbarAction {
  /** 稳定键：React key 与测试定位都用它，**不用数组下标** */
  key: string;
  /** 可访问名（按钮文案） */
  label: string;
  icon?: ReactNode;
  onSelect?(): void;
  /** 渲不渲染。两个反例见文件头（原始输出 / 环境信息） */
  visible?: boolean;
  /** 受控开关类动作（跟随最新 / 只看工具调用 / 只看错误）：给了就渲染成开关 */
  toggle?: { checked: boolean; onChange(next: boolean): void };
  /** 数值输入类动作（跳到轮次）：给了就越界 clamp 并如实回显 */
  number?: { value: number; min: number; max: number; onSubmit(next: number): void };
  disabled?: boolean;
  /**
   * 渲在**哪一行**：默认工具条（面包屑那一行）。
   * `'raw'` ⇒ 固定区的**原文行**，紧挨着「原始输出 N 条」（「下载台账」
   * 答的是「这一行的原文在哪儿」，与轮次级动作不是一类）。**渲法两种写法完全一样**，
   * 差别只在 `AgentLogLayout` 把它归到哪一行——故这是数据，不是组件分支。
   */
  placement?: 'toolbar' | 'raw';
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
  /** 轮次总数（「跳到轮次」的 `min` / `max`） */
  turnCount: number;
  /** 当前轮次（「跳到轮次」的回显值；越界时 clamp 后**如实回显**） */
  currentTurn: number;
  /** 视图态（跟随最新 / 过滤两个开关的受控值） */
  viewState: AgentLogViewState;
  onDownload?(): void;
  /** 「跳到轮次」提交（回车 / 失焦），入参已 clamp 到 `[1, max]` */
  onJumpToTurn(turn: number): void;
  /** 「？环境信息」被点：打开环境抽屉（**同时**向数据层上报由调用方接线） */
  onOpenEnvironment(): void;
}

/** 原始输出的行数：只在 `ready` 时才是一个真读数（`loading` / `error` 都不是 0 条） */
function diagnosticsLineCount(diagnostics: Loadable<AgentLogDiagnostics> | undefined): number {
  return diagnostics !== undefined && diagnostics.status === 'ready' ? diagnostics.data.lines.length : 0;
}

/** 纯函数版本：便于单测（hook 只是它的薄包装） */
export function agentLogToolbarPreset(input: AgentLogToolbarPresetInput): readonly ToolbarAction[] {
  const { diagnostics, turnCount, currentTurn, viewState, onDownload, onJumpToTurn, onOpenEnvironment } = input;
  const lines = diagnosticsLineCount(diagnostics);
  // 上限取 `max(turnCount, 1)`：`min` 恒为 1，`max` 小于 `min` 的输入框是自相矛盾的
  const maxTurn = Math.max(turnCount, 1);
  const shownTurn = Math.min(Math.max(currentTurn, 1), maxTurn);

  return [
    {
      key: 'download',
      label: '下载台账',
      // 没有下载回调就不渲染入口：一个点了没反应的按钮比没有按钮更糟
      visible: onDownload !== undefined,
      onSelect: onDownload,
      // 「下载台账」渲在**原文行**（挨着「原始输出 N 条」），不在轮次级工具条里：见 `placement` 的注释。
      // 它与原文入口**互不依赖**：台账是落盘的事件原文，这一行没产出原文时照样能下载
      placement: 'raw',
    },
    {
      key: 'follow',
      label: '跟随最新',
      toggle: { checked: viewState.follow, onChange: viewState.setFollow },
    },
    {
      key: 'jump',
      label: '跳到轮次',
      visible: turnCount > 0,
      number: { value: shownTurn, min: 1, max: maxTurn, onSubmit: onJumpToTurn },
    },
    {
      key: 'only-tools',
      label: '只看工具调用',
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
      key: 'raw',
      label: `原始输出 ${lines} 条`,
      visible: lines > 0,
      // 它只承载标签与显隐：正文是固定区的 `RawOutputPanel`（默认收起），
      // 工具条再放一个按钮就是同一件事的第二个入口
    },
    {
      key: 'environment',
      label: '环境信息',
      // 图标必须 aria-hidden：`@ant-design/icons` 给每个图标挂了 role/aria-label，
      // 不藏起来按钮的可访问名会变成「question-circle 环境信息」
      icon: createElement(QuestionCircleOutlined, { 'aria-hidden': true }),
      visible: true,
      onSelect: onOpenEnvironment,
    },
  ];
}

/** 预设的 hook 版：同一份输入不重算（动作数组会被 `Flex` 逐项渲染，重算等于每帧新建七个对象） */
export function useAgentLogToolbarPreset(input: AgentLogToolbarPresetInput): readonly ToolbarAction[] {
  const { diagnostics, environment, turnCount, currentTurn, viewState, onDownload, onJumpToTurn, onOpenEnvironment } = input;
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
      }),
    [diagnostics, environment, turnCount, currentTurn, viewState, onDownload, onJumpToTurn, onOpenEnvironment],
  );
}
