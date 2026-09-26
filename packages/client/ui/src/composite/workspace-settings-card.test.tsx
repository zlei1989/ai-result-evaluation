/**
 * WorkspaceSettingsCard：初值、把输入框里的值交给回调、失败时保留输入并显示服务端原因。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { SETTINGS_DEFAULTS, type Settings } from '@aieval/contracts';
import { WorkspaceSettingsCard } from './workspace-settings-card';
import { installResizeObserverStub } from '../testing/resize-observer';

// jsdom 不提供 matchMedia，而 antd 6.6.5 的 Form.Item 无条件渲染一个 Grid.Row
// （form/FormItem/ItemHolder.js:94），Row 又无条件调 useBreakpoint → window.matchMedia：
// 不打桩，挂载即抛 TypeError: window.matchMedia is not a function。
// 与 provider-form-modal.test.tsx 同一口径（installResizeObserverStub 顺带装 matchMedia）。
beforeEach(() => {
  installResizeObserverStub();
});

const noop = (): void => {};
const settings = (patch: Partial<Settings> = {}): Settings => ({ ...SETTINGS_DEFAULTS, ...patch });
const ROOT = 'D:/aieval-runs';

describe('WorkspaceSettingsCard', () => {
  it('输入框初值是当前根目录', () => {
    render(
      <WorkspaceSettingsCard settings={settings({ workspaceRoot: ROOT })} onValidate={noop} saving={false} lastValidated={null} />,
    );

    expect(screen.getByLabelText('工作区根目录')).toHaveValue(ROOT);
    // 明确告诉用户：它同时会写盘（按钮名与这句提示必须一致）
    expect(screen.getByRole('button', { name: '校验并保存' })).toBeInTheDocument();
  });

  it('点「校验并保存」把输入框里的新值交给 onValidate（不是旧值）', () => {
    const onValidate = vi.fn();
    render(
      <WorkspaceSettingsCard settings={settings({ workspaceRoot: ROOT })} onValidate={onValidate} saving={false} lastValidated={null} />,
    );

    fireEvent.change(screen.getByLabelText('工作区根目录'), { target: { value: 'E:/runs' } });
    fireEvent.click(screen.getByRole('button', { name: '校验并保存' }));

    expect(onValidate).toHaveBeenCalledWith('E:/runs');
  });

  it('根目录为空或纯空白时按钮禁用（不让空值走一趟服务端）', () => {
    render(
      <WorkspaceSettingsCard settings={settings({ workspaceRoot: ROOT })} onValidate={noop} saving={false} lastValidated={null} />,
    );

    fireEvent.change(screen.getByLabelText('工作区根目录'), { target: { value: '   ' } });

    expect(screen.getByRole('button', { name: '校验并保存' })).toBeDisabled();
  });

  it('校验成功显示可用路径', () => {
    render(
      <WorkspaceSettingsCard
        settings={settings({ workspaceRoot: ROOT })}
        onValidate={noop}
        saving={false}
        lastValidated={{ root: ROOT, ok: true }}
      />,
    );

    expect(screen.getByText(`工作区可用：${ROOT}`)).toBeInTheDocument();
  });

  // 把输入框弹回旧值会让人以为是自己填错了格式，而真正的原因（建目录失败 / 不可写）
  // 恰恰写在结果区里 —— 两者必须同时可见。
  it('校验失败显示服务端中文原因，并**保留**用户输入', () => {
    const { rerender } = render(
      <WorkspaceSettingsCard settings={settings({ workspaceRoot: ROOT })} onValidate={noop} saving={false} lastValidated={null} />,
    );
    fireEvent.change(screen.getByLabelText('工作区根目录'), { target: { value: 'Z:/nope' } });

    rerender(
      <WorkspaceSettingsCard
        settings={settings({ workspaceRoot: ROOT })}
        onValidate={noop}
        saving={false}
        lastValidated={{ root: 'Z:/nope', ok: false, message: '工作区根目录不可写：Z:/nope（EACCES）' }}
      />,
    );

    expect(screen.getByText('工作区不可用，设置未改动')).toBeInTheDocument();
    expect(screen.getByText('工作区根目录不可写：Z:/nope（EACCES）')).toBeInTheDocument();
    expect(screen.getByLabelText('工作区根目录')).toHaveValue('Z:/nope');
  });

  it('saving 时输入框与按钮都不可用', () => {
    render(
      <WorkspaceSettingsCard settings={settings({ workspaceRoot: ROOT })} onValidate={noop} saving lastValidated={null} />,
    );

    expect(screen.getByLabelText('工作区根目录')).toBeDisabled();
    expect(screen.getByRole('button', { name: '校验并保存' })).toBeDisabled();
  });
});
