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
  it('八个动作、键唯一且稳定（React key 与测试定位都用它）', () => {
    const actions = agentLogToolbarPreset(presetInput());

    expect(actions.map((action) => action.key)).toEqual([
      'follow-up',
      'jump',
      'follow',
      'only-tools',
      'only-errors',
      'environment',
      'raw',
      'download',
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
    expect(action.shape).toBe('circle');
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
   * 「原始输出」入口排在「环境信息」之后、「下载台账」之前。顺序用数组下标钉（渲染顺序就是这个数组的顺序）；
   * 落错位置时按钮照样能点，没有任何行为断言会变红，故这里只钉顺序。
   *
   * 这一簇的四颗都标 `iconGroup`（合进一个渲染区、组内 4px），其余动作不标（仍按工具条的 12px 排）：
   * 标错了没有任何行为断言会红，只会散成一排。`raw` 那一格没有 `icon` / `onSelect`——
   * 控件本体（入口 + 受控抽屉）由布局注入 `entry`，预设只决定它在簇里的位置与显隐。
   */
  it('「原始输出」排在「环境信息」之后、「下载台账」之前，四颗都在图标簇里', () => {
    const actions = agentLogToolbarPreset(
      presetInput({
        onDownload: vi.fn(),
        diagnostics: { status: 'ready', data: diagnostics(2) } satisfies Loadable<AgentLogDiagnostics>,
      }),
    );

    const keys = actions.map((action) => action.key);
    expect(keys.indexOf('raw')).toBe(keys.indexOf('environment') + 1);
    expect(keys.indexOf('download')).toBe(keys.indexOf('raw') + 1);

    // 「下载台账」仍是圆形透明底的图标按钮
    const download = actionOf(actions, 'download');
    expect(download.icon).toBeDefined();
    expect(download.iconVariant).toBe('text');
    expect(download.shape).toBe('circle');

    for (const key of ['follow-up', 'environment', 'raw', 'download']) {
      expect(actionOf(actions, key).iconGroup).toBe(true);
    }
    for (const action of actions) {
      if (['follow-up', 'environment', 'raw', 'download'].includes(action.key)) continue;
      expect(action.iconGroup).toBeUndefined();
    }
    // 原始输出那一格自己不是按钮：可点性/抽屉归布局注入的 `entry`
    expect(actionOf(actions, 'raw').icon).toBeUndefined();
    expect(actionOf(actions, 'raw').onSelect).toBeUndefined();
  });

  /**
   * 「追问」入口的三态：没有写动作就不渲染；判据读不到 / 不可行都禁用，
   * Tooltip 换成那一句实话，而 `label`（可访问名）恒为「追问」。
   */
  it('「追问」：给回调才出现，判据三态决定可点与 Tooltip', () => {
    expect(actionOf(agentLogToolbarPreset(presetInput()), 'follow-up').visible).toBe(false);

    const onFollowUp = vi.fn();
    const action = actionOf(
      agentLogToolbarPreset(presetInput({ onFollowUp, followUpVerdict: { ok: true } })),
      'follow-up',
    );
    expect(action.visible).toBe(true);
    expect(action.disabled).toBe(false);
    expect(action.label).toBe('追问');
    expect(action.tooltip).toBe('追问');
    expect(action.shape).toBe('circle');
    expect(action.iconVariant).toBe('text');
    expect(action.iconGroup).toBe(true);
    expect(isValidElement(action.icon)).toBe(true);
    expect((action.icon as { props: Record<string, unknown> }).props['aria-hidden']).toBe(true);
    action.onSelect?.();
    expect(onFollowUp).toHaveBeenCalledTimes(1);

    // 不可追问：禁用，Tooltip 用服务端那一句原因
    const reason = '这个候选没有可续接的会话（还没跑过，或是没有这一格的旧产物）';
    const refused = actionOf(
      agentLogToolbarPreset(presetInput({ onFollowUp, followUpVerdict: { ok: false, reason } })),
      'follow-up',
    );
    expect(refused.disabled).toBe(true);
    expect(refused.tooltip).toBe(reason);
    expect(refused.label).toBe('追问');

    // 判据还没读到：与「不可追问」分开说（处置是刷新，不是换一件事做）
    const unknown = actionOf(agentLogToolbarPreset(presetInput({ onFollowUp })), 'follow-up');
    expect(unknown.disabled).toBe(true);
    expect(unknown.tooltip).toContain('读不到这个候选的追问判据');
  });

  it('「跳转」：min/max 来自 turnCount，越界 clamp 后如实回显', () => {
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

  it('「跳转」提交时把轮次交回去', () => {
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
