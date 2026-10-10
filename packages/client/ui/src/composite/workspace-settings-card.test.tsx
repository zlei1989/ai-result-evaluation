/**
 * WorkspaceSettingsCard：初值、把输入框里的值交给回调、失败时保留输入并显示服务端原因，
 * 以及用例同步那一块的全部显隐口径（开关置灰、状态行、两个动作按钮的出现与禁用）。
 *
 * 为什么这些行为必须逐条钉在**卡片**上：本仓的应用层（apps/web-next）不能写 `.tsx` 测试，
 * 页面只做接线，全部判定都在卡片里——漏掉任何一条「什么时候出现 / 什么时候禁用」，
 * 用户看到的就是一颗点了没反应（或压根不该在）的按钮，而页面那一侧一个字都不会报错。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { SETTINGS_DEFAULTS, type CaseSyncStatus, type Settings } from '@aieval/contracts';
import { WorkspaceSettingsCard, type WorkspaceSettingsCardProps } from './workspace-settings-card';
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
const CASES_ROOT = 'D:/aieval-cases';

/**
 * 同步快照的**默认值**：是一个健康的 git 仓库，但**没有**任何待提交 / 领先 / 落后。
 * 各用例只覆盖自己关心的那一格——默认值不健康的夹具会让「按钮该不该出现」这类断言永远为假。
 */
const syncStatus = (patch: Partial<CaseSyncStatus> = {}): CaseSyncStatus => ({
  isRepo: true,
  hasRemote: true,
  blockedReason: null,
  running: false,
  lastAttemptAt: null,
  lastSuccessAt: null,
  lastCommit: null,
  lastError: null,
  pendingCount: 0,
  ignoredCount: 0,
  remoteAhead: 0,
  localAhead: 0,
  ...patch,
});

/** 一次渲染出带全套 props 的卡片（用例只覆盖自己关心的那几格） */
function renderCard(overrides: Partial<WorkspaceSettingsCardProps> = {}): ReturnType<typeof render> {
  return render(
    <WorkspaceSettingsCard
      settings={settings({ workspaceRoot: ROOT, casesRoot: CASES_ROOT })}
      onValidate={noop}
      saving={false}
      lastValidated={null}
      onValidateCasesRoot={noop}
      lastValidatedCases={null}
      onToggleAutoCommit={noop}
      syncStatus={syncStatus()}
      syncError={undefined}
      syncing={false}
      onSyncAction={noop}
      {...overrides}
    />,
  );
}

/**
 * 两格按钮的可访问名**逐字相同**（都叫「校验并保存」）——`getByRole` 会同时命中两个而抛错。
 * 故按输入框所在的 Form.Item 定位：这条查询的写法本身就是「两格各管各的」的守卫，
 * 哪天有人把其中一个按钮挪到别处（例如把用例目录那一格接回工作区的回调），这里会先红。
 */
function validateButton(inputLabel: string): HTMLElement {
  const input = screen.getByLabelText(inputLabel);
  const item = input.closest('.ant-form-item');
  if (item === null) throw new Error(`「${inputLabel}」不在任何 Form.Item 里`);
  return within(item as HTMLElement).getByRole('button', { name: '校验并保存' });
}

/** 开关那一行：置灰原因与开关同排，用它可以避开状态区里同文案的警告 Alert */
function autoCommitRow(): HTMLElement {
  const row = screen.getByRole('switch', { name: '用例变更时自动提交' }).closest('div');
  if (row === null) throw new Error('自动提交开关不在任何容器里');
  return row;
}

describe('WorkspaceSettingsCard', () => {
  it('输入框初值是当前根目录与当前用例目录', () => {
    renderCard();

    expect(screen.getByLabelText('工作区根目录')).toHaveValue(ROOT);
    expect(screen.getByLabelText('用例目录')).toHaveValue(CASES_ROOT);
    // 明确告诉用户：它同时会写盘（按钮名与这句提示必须一致）
    expect(validateButton('工作区根目录')).toBeInTheDocument();
    expect(validateButton('用例目录')).toBeInTheDocument();
  });

  it('点「校验并保存」把输入框里的新值交给 onValidate（不是旧值）', () => {
    const onValidate = vi.fn();
    renderCard({ onValidate });

    fireEvent.change(screen.getByLabelText('工作区根目录'), { target: { value: 'E:/runs' } });
    fireEvent.click(validateButton('工作区根目录'));

    expect(onValidate).toHaveBeenCalledWith('E:/runs');
  });

  // 两格各有各的回调：接错线（用例目录走 onValidate）时页面会把 casesRoot 写进 workspaceRoot，
  // 而两边的「校验并保存」看起来一模一样，光靠肉眼冒烟分不出来
  it('用例目录那一格走 onValidateCasesRoot，不去动工作区那一格', () => {
    const onValidate = vi.fn();
    const onValidateCasesRoot = vi.fn();
    renderCard({ onValidate, onValidateCasesRoot });

    fireEvent.change(screen.getByLabelText('用例目录'), { target: { value: 'E:/cases' } });
    fireEvent.click(validateButton('用例目录'));

    expect(onValidateCasesRoot).toHaveBeenCalledWith('E:/cases');
    expect(onValidate).not.toHaveBeenCalled();
  });

  it('根目录为空或纯空白时按钮禁用（不让空值走一趟服务端）', () => {
    renderCard();

    fireEvent.change(screen.getByLabelText('工作区根目录'), { target: { value: '   ' } });
    fireEvent.change(screen.getByLabelText('用例目录'), { target: { value: '   ' } });

    expect(validateButton('工作区根目录')).toBeDisabled();
    expect(validateButton('用例目录')).toBeDisabled();
  });

  // 三句话缺一不可：一文件一用例（形状）、默认值、以及**改目录不迁移**——
  // 最后一句最容易被漏，而漏了它用户会以为换了目录就搬了家
  it('用例目录的说明写清「一文件一用例 / 默认值 / 改目录不迁移」', () => {
    renderCard();

    // 两格都有 extra：必须取用例目录那一格的（`document.querySelector` 拿到的是第一格工作区的）
    const extra = screen.getByLabelText('用例目录').closest('.ant-form-item')?.querySelector('.ant-form-item-extra');
    expect(extra?.textContent).toContain('<用例 id>.json');
    expect(extra?.textContent).toContain('~/.aieval-cases');
    expect(extra?.textContent).toContain('不会迁移已有用例文件');
  });

  it('校验成功显示可用路径', () => {
    renderCard({ lastValidated: { root: ROOT, ok: true } });

    expect(screen.getByText(`工作区可用：${ROOT}`)).toBeInTheDocument();
  });

  // 把输入框弹回旧值会让人以为是自己填错了格式，而真正的原因（建目录失败 / 不可写）
  // 恰恰写在结果区里 —— 两者必须同时可见。
  it('校验失败显示服务端中文原因，并**保留**用户输入', () => {
    const { rerender } = renderCard();
    fireEvent.change(screen.getByLabelText('工作区根目录'), { target: { value: 'Z:/nope' } });

    rerender(
      <WorkspaceSettingsCard
        settings={settings({ workspaceRoot: ROOT, casesRoot: CASES_ROOT })}
        onValidate={noop}
        saving={false}
        lastValidated={{ root: 'Z:/nope', ok: false, message: '工作区根目录不可写：Z:/nope（EACCES）' }}
        onValidateCasesRoot={noop}
        lastValidatedCases={null}
        onToggleAutoCommit={noop}
        syncStatus={syncStatus()}
        syncError={undefined}
        syncing={false}
        onSyncAction={noop}
      />,
    );

    expect(screen.getByText('工作区不可用，设置未改动')).toBeInTheDocument();
    expect(screen.getByText('工作区根目录不可写：Z:/nope（EACCES）')).toBeInTheDocument();
    expect(screen.getByLabelText('工作区根目录')).toHaveValue('Z:/nope');
  });

  // 用例目录那一格是同一套写法、同样是「失败也要留住输入」：它比工作区更容易被写成受控回弹
  it('用例目录校验失败同样保留用户输入', () => {
    const { rerender } = renderCard();
    fireEvent.change(screen.getByLabelText('用例目录'), { target: { value: 'Z:/cases' } });

    rerender(
      <WorkspaceSettingsCard
        settings={settings({ workspaceRoot: ROOT, casesRoot: CASES_ROOT })}
        onValidate={noop}
        saving={false}
        lastValidated={null}
        onValidateCasesRoot={noop}
        lastValidatedCases={{ root: 'Z:/cases', ok: false, message: '用例根目录不可写：Z:/cases（EACCES）' }}
        onToggleAutoCommit={noop}
        syncStatus={syncStatus()}
        syncError={undefined}
        syncing={false}
        onSyncAction={noop}
      />,
    );

    expect(screen.getByText('用例目录不可用，设置未改动')).toBeInTheDocument();
    expect(screen.getByText('用例根目录不可写：Z:/cases（EACCES）')).toBeInTheDocument();
    expect(screen.getByLabelText('用例目录')).toHaveValue('Z:/cases');
  });

  it('saving 时两个输入框与两个按钮都不可用', () => {
    renderCard({ saving: true });

    expect(screen.getByLabelText('工作区根目录')).toBeDisabled();
    expect(screen.getByLabelText('用例目录')).toBeDisabled();
    expect(validateButton('工作区根目录')).toBeDisabled();
    expect(validateButton('用例目录')).toBeDisabled();
  });

  it('自动提交开关的值来自 settings.casesAutoCommit，切换时把新值交给回调', () => {
    const onToggleAutoCommit = vi.fn();
    renderCard({ settings: settings({ workspaceRoot: ROOT, casesRoot: CASES_ROOT, casesAutoCommit: false }), onToggleAutoCommit });

    const toggle = screen.getByRole('switch', { name: '用例变更时自动提交' });
    expect(toggle).not.toBeChecked();

    fireEvent.click(toggle);

    // antd 的 Switch.onChange 是 `(checked, event)`：只取第一参断言，
    // 用 `toHaveBeenCalledWith(true)` 会因为多带一个 event 参数而红
    expect(onToggleAutoCommit.mock.calls[0]?.[0]).toBe(true);
  });

  // 不是 git 仓库时「自动提交」这件事压根不可能发生：开关必须置灰，**并且**把原因写在旁边——
  // 只置灰不说原因，用户只会以为这一格坏了
  it('用例目录不是 git 仓库时开关置灰，并写明原因', () => {
    const reason = 'D:/tmp/plain 不是 git 仓库：用例变更不会提交（在该目录 git init 并配置远端后即可启用）';
    renderCard({ syncStatus: syncStatus({ isRepo: false, blockedReason: reason }) });

    expect(screen.getByRole('switch', { name: '用例变更时自动提交' })).toBeDisabled();
    expect(within(autoCommitRow()).getByText(reason)).toBeInTheDocument();
    // 状态区用一条警告说清整块功能为什么不可用
    expect(screen.getByText('用例目录还不是 git 仓库：用例变更不会提交')).toBeInTheDocument();
  });

  it('状态未到时画骨架屏；读失败（syncError 有值）时不画骨架屏（错误由页面说出来）', () => {
    const loading = renderCard({ syncStatus: undefined, syncError: undefined });
    expect(loading.container.querySelector('.ant-skeleton')).not.toBeNull();
    loading.unmount();

    const failed = renderCard({ syncStatus: undefined, syncError: new Error('设置加载失败') });
    expect(failed.container.querySelector('.ant-skeleton')).toBeNull();
  });

  // 没有待提交、也没有未推送的提交时，「提交」是一颗点了什么都不做的按钮
  it('没有待提交变更时不出现「提交」按钮', () => {
    renderCard({ syncStatus: syncStatus({ pendingCount: 0, localAhead: 0 }) });

    expect(screen.queryByRole('button', { name: '提交' })).not.toBeInTheDocument();
  });

  // `remoteAhead === 0` 是「确知远端没有新提交」：此刻给「拉取」是把一次必然的空操作摆上界面
  it('remoteAhead 为 0 时不出现「拉取」按钮', () => {
    renderCard({ syncStatus: syncStatus({ remoteAhead: 0 }) });

    expect(screen.queryByRole('button', { name: '拉取' })).not.toBeInTheDocument();
  });

  // null = 本次没探到（离线 / 没有上游），不是「没有」：仍要给按钮，点了才会看到原因
  it('remoteAhead 为 null 时仍出现「拉取」按钮', () => {
    renderCard({ syncStatus: syncStatus({ remoteAhead: null }) });

    expect(screen.getByRole('button', { name: '拉取' })).toBeInTheDocument();
    expect(screen.getByText('远端是否有新提交未知（探测失败或没有上游）')).toBeInTheDocument();
  });

  it('待提交与远端领先时按钮出现，文案带数量，点击把动作交给回调', () => {
    const onSyncAction = vi.fn();
    renderCard({ syncStatus: syncStatus({ pendingCount: 2, localAhead: 1, remoteAhead: 3 }), onSyncAction });

    expect(screen.getByText('有 2 个用例文件待提交')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '提交' }));
    fireEvent.click(screen.getByRole('button', { name: '拉取（远端领先 3 个提交）' }));

    expect(onSyncAction).toHaveBeenNthCalledWith(1, 'commit');
    expect(onSyncAction).toHaveBeenNthCalledWith(2, 'pull');
  });

  // 有阻塞原因（例如未配置评分智能体）时两个动作都跑不起来：按钮该在（用户要知道有这么个动作）
  // 但必须禁用，否则点下去只有一次失败
  it('blockedReason 非空时两个动作按钮都禁用', () => {
    renderCard({
      syncStatus: syncStatus({ blockedReason: '未配置默认评分模型', pendingCount: 2, localAhead: 1, remoteAhead: 3 }),
    });

    expect(screen.getByRole('button', { name: '提交' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '拉取（远端领先 3 个提交）' })).toBeDisabled();
  });

  it('syncing 时两个动作按钮都进 loading 且禁用', () => {
    renderCard({ syncStatus: syncStatus({ pendingCount: 1, remoteAhead: 2 }), syncing: true });

    // loading 期间的可访问名与可见文案逐字一致（不给 aria-label 时会被加载图标污染成「loading 提交」）
    expect(screen.getByRole('button', { name: '提交' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '拉取（远端领先 2 个提交）' })).toBeDisabled();
  });

  // 状态行是**只读事实**：能说清的都要说出来，别让用户从「按钮不见了」去反推
  it('状态区逐条展示正在同步 / 上次失败 / 上次成功 / 被忽略 / 没有远端', () => {
    // 用**本地时间**造 ISO：formatDateTime 按本地时区渲染，写死一个 UTC 字面量会让断言随机器时区红
    const lastSuccessAt = new Date(2026, 9, 8, 10, 30).toISOString();
    renderCard({
      syncStatus: syncStatus({
        running: true,
        lastError: '推送失败：远端拒绝',
        lastSuccessAt,
        lastCommit: 'abcdef1234567890',
        ignoredCount: 3,
        hasRemote: false,
        remoteAhead: null,
      }),
    });

    expect(screen.getByText('正在同步用例变更…')).toBeInTheDocument();
    expect(screen.getByText('上次同步失败：推送失败：远端拒绝')).toBeInTheDocument();
    expect(screen.getByText('上次同步成功：2026-10-08 10:30（abcdef1）')).toBeInTheDocument();
    expect(screen.getByText('另有 3 个无关变更被忽略，不会进提交')).toBeInTheDocument();
    expect(screen.getByText('未配置远端：变更只提交到本地')).toBeInTheDocument();
  });
});
