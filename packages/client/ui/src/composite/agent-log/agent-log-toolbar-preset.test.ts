/**
 * `agent-log-toolbar-preset` 的守卫（变异体 (p) 的另一半：`AgentLogLayout` 传了 `actions` 时用传入的）。
 *
 * 两条**有意相反**的显隐规则必须都在这里钉住：
 * · 「原始输出 N 条」：没有原文就没有入口（`diagnostics` 未给、或 `lines` 为空 ⇒ 不渲染）；
 * · 「环境信息」：`environment` 未给也照常渲染（抽屉里如实说「未提供」）。
 * 把它们统一成「没数据就不渲染」会让「没有这个功能」与「这次没采到」变成同一件事。
 */
import { describe, expect, it, vi } from 'vitest';
import { isValidElement } from 'react';
import type { AgentLogDiagnostics, Loadable } from './types';
import {
  agentLogToolbarPreset,
  type AgentLogToolbarPresetInput,
  type ToolbarAction,
} from './agent-log-toolbar-preset';
import type { AgentLogViewState } from './use-agent-log-view';

function viewState(overrides: Partial<AgentLogViewState> = {}): AgentLogViewState {
  return {
    activeNodeId: 'main',
    setActiveNodeId: vi.fn(),
    follow: true,
    setFollow: vi.fn(),
    filters: { onlyTools: false, onlyErrors: false },
    setFilters: vi.fn(),
    environmentOpen: false,
    setEnvironmentOpen: vi.fn(),
    openKeys: new Set<string>(),
    onOpenChange: vi.fn(),
    ...overrides,
  };
}

function diagnostics(lines: number): AgentLogDiagnostics {
  return {
    lines: Array.from({ length: lines }, (_, index) => ({
      at: '2026-10-02T10:44:31.000Z',
      source: 'stdout' as const,
      text: `第 ${index + 1} 行原文`,
      summary: null,
    })),
    truncatedReason: null,
  };
}

function presetInput(overrides: Partial<AgentLogToolbarPresetInput> = {}): AgentLogToolbarPresetInput {
  return {
    turnCount: 3,
    currentTurn: 3,
    viewState: viewState(),
    onJumpToTurn: vi.fn(),
    onOpenEnvironment: vi.fn(),
    ...overrides,
  };
}

/** 按键取动作：找不到就抛（`!` 断言会让「动作没了」这件事变成 undefined 上的另一处报错） */
function actionOf(actions: readonly ToolbarAction[], key: string): ToolbarAction {
  const found = actions.find((action) => action.key === key);
  if (found === undefined) throw new Error(`预设里没有这个动作：${key}`);
  return found;
}

describe('agentLogToolbarPreset', () => {
  it('七个动作、键唯一且稳定（React key 与测试定位都用它）', () => {
    const actions = agentLogToolbarPreset(presetInput());

    expect(actions.map((action) => action.key)).toEqual([
      'download',
      'follow',
      'jump',
      'only-tools',
      'only-errors',
      'raw',
      'environment',
    ]);
    expect(new Set(actions.map((action) => action.key)).size).toBe(actions.length);
  });

  it('「原始输出」：lines 为空 or diagnostics 未给 ⇒ 不渲染；有原文才出现并带条数', () => {
    const empty = agentLogToolbarPreset(
      presetInput({ diagnostics: { status: 'ready', data: diagnostics(0) } satisfies Loadable<AgentLogDiagnostics> }),
    );
    expect(actionOf(empty, 'raw').visible).toBe(false);

    const missing = agentLogToolbarPreset(presetInput({ diagnostics: undefined }));
    expect(actionOf(missing, 'raw').visible).toBe(false);

    const ready = agentLogToolbarPreset(
      presetInput({ diagnostics: { status: 'ready', data: diagnostics(2) } satisfies Loadable<AgentLogDiagnostics> }),
    );
    expect(actionOf(ready, 'raw').visible).toBe(true);
    expect(actionOf(ready, 'raw').label).toBe('原始输出 2 条');
  });

  it('「环境信息」：environment 未给也照常渲染（与「原始输出」相反是有意的）', () => {
    const actions = agentLogToolbarPreset(presetInput({ environment: undefined }));
    const action = actionOf(actions, 'environment');

    expect(action.visible).toBe(true);
    expect(action.label).toBe('环境信息');
    // 图标是 React 元素（`.ts` 文件不能写 JSX，用 createElement）
    expect(isValidElement(action.icon)).toBe(true);
    expect((action.icon as { props: Record<string, unknown> }).props['aria-hidden']).toBe(true);
  });

  it('「环境信息」被点就是打开环境抽屉', () => {
    const onOpenEnvironment = vi.fn();
    const actions = agentLogToolbarPreset(presetInput({ onOpenEnvironment }));

    actionOf(actions, 'environment').onSelect?.();

    expect(onOpenEnvironment).toHaveBeenCalledTimes(1);
  });

  it('「下载台账」：没有下载回调就不渲染入口', () => {
    expect(actionOf(agentLogToolbarPreset(presetInput()), 'download').visible).toBe(false);

    const onDownload = vi.fn();
    const actions = agentLogToolbarPreset(presetInput({ onDownload }));
    expect(actionOf(actions, 'download').visible).toBe(true);
    actionOf(actions, 'download').onSelect?.();
    expect(onDownload).toHaveBeenCalledTimes(1);
  });

  /**
   * 「下载台账」**渲在原文行**（它挨着「原始输出 N 条」）。
   * 两种写法的渲法完全一样，差别只在落哪一行 ⇒ 这一格是 `placement`，不是组件分支；
   * 落错了的症状是「按钮跑到面包屑那一行去了」，而**没有任何行为断言会红**（按钮照样能点）。
   */
  it('「下载台账」标了 placement: raw（其余动作留在工具条那一行）', () => {
    const actions = agentLogToolbarPreset(presetInput({ onDownload: vi.fn() }));

    expect(actionOf(actions, 'download').placement).toBe('raw');
    // 其余动作都不带 placement（默认 'toolbar'）：写死一片 'toolbar' 只会让「默认值」有两个写法
    const others = actions.filter((action) => action.key !== 'download');
    expect(others.map((action) => action.placement)).toEqual(others.map(() => undefined));
  });

  it('「跳到轮次」：min/max 来自 turnCount，越界 clamp 后如实回显', () => {
    const actions = agentLogToolbarPreset(presetInput({ turnCount: 83, currentTurn: 999 }));
    const number = actionOf(actions, 'jump').number;

    expect(number?.min).toBe(1);
    expect(number?.max).toBe(83);
    expect(number?.value).toBe(83);

    const low = agentLogToolbarPreset(presetInput({ turnCount: 83, currentTurn: 0 }));
    expect(actionOf(low, 'jump').number?.value).toBe(1);

    // 一轮都没有时不渲染跳轮器（`min > max` 的输入框是自相矛盾的）
    const none = agentLogToolbarPreset(presetInput({ turnCount: 0 }));
    expect(actionOf(none, 'jump').visible).toBe(false);
  });

  it('「跳到轮次」提交时把轮次交回去', () => {
    const onJumpToTurn = vi.fn();
    const actions = agentLogToolbarPreset(presetInput({ onJumpToTurn }));

    actionOf(actions, 'jump').number?.onSubmit(2);

    expect(onJumpToTurn).toHaveBeenCalledWith(2);
  });

  it('「跟随最新」的 toggle.checked 与 viewState.follow 同值（只有一份 state）', () => {
    const following = agentLogToolbarPreset(presetInput({ viewState: viewState({ follow: true }) }));
    expect(actionOf(following, 'follow').toggle?.checked).toBe(true);

    const setFollow = vi.fn();
    const paused = agentLogToolbarPreset(presetInput({ viewState: viewState({ follow: false, setFollow }) }));
    expect(actionOf(paused, 'follow').toggle?.checked).toBe(false);
    actionOf(paused, 'follow').toggle?.onChange(true);
    expect(setFollow).toHaveBeenCalledWith(true);
  });

  it('两个过滤开关各改自己那一格，且不动另一格（AND 叠加）', () => {
    const setFilters = vi.fn();
    const actions = agentLogToolbarPreset(
      presetInput({ viewState: viewState({ filters: { onlyTools: false, onlyErrors: true }, setFilters }) }),
    );

    expect(actionOf(actions, 'only-tools').toggle?.checked).toBe(false);
    expect(actionOf(actions, 'only-errors').toggle?.checked).toBe(true);

    actionOf(actions, 'only-tools').toggle?.onChange(true);
    expect(setFilters).toHaveBeenCalledWith({ onlyTools: true, onlyErrors: true });
  });
});
