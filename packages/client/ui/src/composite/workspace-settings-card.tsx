'use client';

/**
 * 存储目录卡：工作区根目录 + 用例目录两格「校验并保存」、用例变更自动提交开关、用例同步状态与两个人工动作。
 * 纯展示：输入框是本地状态，点按钮把值交给 `onValidate*`（调用方去发 PUT /api/settings）；
 * 状态区与按钮的显隐全部由 props 决定（组件**不调接口、不认识提示通道**，失败提示是页面的事）。
 *
 * 四个刻意的取舍：
 *   1. 按钮叫「校验并保存」而不是「校验」：它确实会写盘（服务端校验通过就落盘），
 *      名字必须说清这一点，否则用户以为只是「试试看」而不敢点，或者点了之后不知道已经生效；
 *   2. 校验失败时**保留用户输入**：把输入框弹回旧值会让人以为是自己填错了格式，
 *      而真正的原因（建目录失败 / 不可写）就写在结果区里 —— 两者必须同时可见；
 *   3. 两个按钮的可访问名逐字相同（都叫「校验并保存」）：它们各自住在自己的 `Field` 里，
 *      按 Field 定位才能分清是哪一格（用例也是这么断言的）；
 *   4. 用例目录那一格的说明必须同时说三句话（一文件一用例 / 默认值 / **不会迁移**已有文件）：
 *      「改目录不迁移」是本功能最容易被误解的一点，漏了它用户会以为换了目录就搬了家。
 */
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { CaseSyncAction, CaseSyncStatus, SettingsView } from '@aieval/contracts';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Field, FieldDescription, FieldLabel } from '../components/ui/field';
import { Input } from '../components/ui/input';
import { Skeleton } from '../components/ui/skeleton';
import { Switch } from '../components/ui/switch';
import { formatDateTime, shortHash } from '../base/format';
import { SettingsAlert } from './settings-alert';

export interface WorkspaceSettingsCardProps {
  settings: SettingsView;
  onValidate: (root: string) => void;
  saving: boolean;
  /** 最近一次工作区校验结果：null = 还没校验过；ok=false 时 message 是服务端的中文原因 */
  lastValidated: { root: string; ok: boolean; message?: string } | null;
  /** 用例目录那一格的「校验并保存」（与工作区同一套写法：本地 state + 校验失败保留输入） */
  onValidateCasesRoot: (root: string) => void;
  /** 最近一次用例目录校验结果：形状与 `lastValidated` 逐字相同 */
  lastValidatedCases: { root: string; ok: boolean; message?: string } | null;
  onToggleAutoCommit: (value: boolean) => void;
  /** 同步状态快照；undefined = 还没读到（读失败由页面给告警，这里配合 `syncError` 只画骨架屏） */
  syncStatus: CaseSyncStatus | undefined;
  /** 状态读失败的原因；`syncStatus === undefined` 时区分「还在读」与「读失败」的另一半 */
  syncError: unknown;
  /** 同步动作在跑（按钮 loading；服务端自己的 `running` 也一并体现在状态区） */
  syncing: boolean;
  onSyncAction: (action: CaseSyncAction) => void;
}

export function WorkspaceSettingsCard({
  settings,
  onValidate,
  saving,
  lastValidated,
  onValidateCasesRoot,
  lastValidatedCases,
  onToggleAutoCommit,
  syncStatus,
  syncError,
  syncing,
  onSyncAction,
}: WorkspaceSettingsCardProps): ReactNode {
  const [root, setRoot] = useState(settings.workspaceRoot);
  const [casesRoot, setCasesRoot] = useState(settings.casesRoot);

  // 只依赖那个字符串：设置从服务端回来（或别处改了根目录）时同步输入框，
  // 而校验失败后 settings.workspaceRoot 没变、effect 不重跑，用户刚敲的路径因此不会被顶掉。
  useEffect(() => {
    setRoot(settings.workspaceRoot);
  }, [settings.workspaceRoot]);

  // 用例目录那一格同一套写法与同一条理由：校验失败时 settings.casesRoot 没变、effect 不重跑
  useEffect(() => {
    setCasesRoot(settings.casesRoot);
  }, [settings.casesRoot]);

  const blockedReason = syncStatus?.blockedReason ?? null;
  /** 非 git 仓库：自动提交开关置灰（提交这件事压根不可能发生，开着它是骗人） */
  const autoCommitDisabled = syncStatus?.isRepo === false;
  /** 两个人工动作都不可用的统一判据：有阻塞原因、或正在跑 */
  const actionDisabled = blockedReason !== null || syncing;
  const canCommit = syncStatus !== undefined && (syncStatus.pendingCount > 0 || syncStatus.localAhead > 0);
  // `remoteAhead !== 0` 而不是 `> 0`：null = 本次没探到（离线 / 没有上游），此时仍要给按钮——
  // 点了才会看到原因；把「没探到」当成「没有」会让用户以为远端确实没有新提交
  const canPull = syncStatus !== undefined && syncStatus.remoteAhead !== 0;
  const pullCount = syncStatus?.remoteAhead ?? null;
  // 文案与 `aria-label` 用同一个值：两者分叉时，loading 期间按名字定位按钮会失配
  const pullLabel = pullCount !== null && pullCount > 0 ? `拉取（远端领先 ${pullCount} 个提交）` : '拉取';

  return (
    <Card size="sm" data-testid="workspace-settings-card">
      <CardHeader>
        <CardTitle>存储目录</CardTitle>
      </CardHeader>
      <CardContent>
        {/* 这一张卡是**纯布局**：输入框各自是受控 state，改动由按钮 / onChange 即时交给调用方，
            没有表单字段（无 name、无校验）。`Field` 只承担「标签 + 控件 + 说明」的排布。 */}
        <div className="flex flex-col gap-2">
          <Field>
            <FieldLabel htmlFor="workspace-root">工作区根目录</FieldLabel>
            <div className="flex gap-2">
              <Input
                id="workspace-root"
                aria-label="工作区根目录"
                value={root}
                placeholder="~/.aieval-runs"
                disabled={saving}
                onChange={(event) => setRoot(event.target.value)}
              />
              <Button
                // 空值不必走一趟服务端：服务端也会拒，但那是一次多余的往返
                disabled={saving || root.trim() === ''}
                onClick={() => onValidate(root)}
              >
                校验并保存
              </Button>
            </div>
            <FieldDescription>评测的行工作副本、事件日志与用例缓存都落在这个目录下；默认 ~/.aieval-runs</FieldDescription>
          </Field>

          {lastValidated !== null && lastValidated.ok && (
            <SettingsAlert tone="success" title={`工作区可用：${lastValidated.root}`} />
          )}
          {lastValidated !== null && !lastValidated.ok && (
            <SettingsAlert
              tone="error"
              title="工作区不可用，设置未改动"
              description={lastValidated.message}
            />
          )}

          <p className="text-sm text-muted-foreground">
            改动根目录不会迁移已有产物：旧评测仍留在原目录，历史评测里显示的是它当时的实际路径。
          </p>

          <Field className="mt-1">
            <FieldLabel htmlFor="cases-root">用例目录</FieldLabel>
            <div className="flex gap-2">
              <Input
                id="cases-root"
                aria-label="用例目录"
                value={casesRoot}
                placeholder="~/.aieval-cases"
                disabled={saving}
                onChange={(event) => setCasesRoot(event.target.value)}
              />
              <Button
                disabled={saving || casesRoot.trim() === ''}
                onClick={() => onValidateCasesRoot(casesRoot)}
              >
                校验并保存
              </Button>
            </div>
            <FieldDescription>
              一个用例一个文件，存在 &lt;用例目录&gt;/&lt;用例 id&gt;.json；默认 ~/.aieval-cases。改目录不会迁移已有用例文件：旧文件留在原目录，用例列表只认新目录。
            </FieldDescription>
          </Field>

          {lastValidatedCases !== null && lastValidatedCases.ok && (
            <SettingsAlert tone="success" title={`用例目录可用：${lastValidatedCases.root}`} />
          )}
          {lastValidatedCases !== null && !lastValidatedCases.ok && (
            <SettingsAlert
              tone="error"
              title="用例目录不可用，设置未改动"
              description={lastValidatedCases.message}
            />
          )}

          {/* 开关与原因同一行：置灰而不说原因，用户只会以为这一格坏了 */}
          <div className="flex flex-wrap items-center gap-2">
            <Switch
              size="sm"
              aria-label="用例变更时自动提交"
              checked={settings.casesAutoCommit}
              disabled={autoCommitDisabled}
              onCheckedChange={onToggleAutoCommit}
            />
            <span className="text-sm">用例变更时自动提交</span>
            {autoCommitDisabled && (
              <span className="text-sm text-muted-foreground">
                {blockedReason ?? '用例目录当前不是 git 仓库，无法自动提交'}
              </span>
            )}
          </div>

          <SyncStatusArea status={syncStatus} error={syncError} />

          {(canCommit || canPull) && (
            <div className="mt-2 flex gap-2">
              {canCommit && (
                <Button size="sm" disabled={actionDisabled} onClick={() => onSyncAction('commit')}>
                  {syncing && <span className="size-3 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden />}
                  提交
                </Button>
              )}
              {canPull && (
                <Button
                  size="sm"
                  variant="outline"
                  aria-label={pullLabel}
                  disabled={actionDisabled}
                  onClick={() => onSyncAction('pull')}
                >
                  {syncing && <span className="size-3 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden />}
                  {pullLabel}
                </Button>
              )}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * 状态区：快照 → 几行**只读**事实。抽成内部组件只为让上面那块可读，
 * 判定全在这里（页面没有测试面，判定留在页面里就等于没有守卫）。
 *
 * 三态分工：`syncStatus === undefined && syncError === undefined` = 还在读 → Skeleton；
 * 读失败（error 有值）→ 这里什么都不画，页面会给出错误告警（组件不认识提示通道，也不该猜原因）；
 * 非 git 仓库 → 一条 warning 说清为什么整块功能不可用；其余按「正在跑 / 上次失败 / 上次成功 /
 * 待提交 / 被忽略 / 没有远端 / 远端未知」依次列出，**每一格都只在它有意义时出现**。
 */
function SyncStatusArea({
  status,
  error,
}: {
  status: CaseSyncStatus | undefined;
  error: unknown;
}): ReactNode {
  if (status === undefined) {
    return error === undefined ? <Skeleton className="h-10 w-full" /> : null;
  }
  if (!status.isRepo) {
    return (
      <SettingsAlert
        tone="warning"
        title="用例目录还不是 git 仓库：用例变更不会提交"
        description={status.blockedReason}
      />
    );
  }
  return (
    <div className="mt-2 flex flex-col gap-1">
      {status.running && <SettingsAlert tone="info" title="正在同步用例变更…" />}
      {status.lastError !== null && (
        <SettingsAlert tone="error" title={`上次同步失败：${status.lastError}`} />
      )}
      {status.lastSuccessAt !== null && (
        <p className="text-sm text-muted-foreground">
          {`上次同步成功：${formatDateTime(status.lastSuccessAt)}${status.lastCommit === null ? '' : `（${shortHash(status.lastCommit)}）`}`}
        </p>
      )}
      {status.pendingCount > 0 && <p className="text-sm">{`有 ${status.pendingCount} 个用例文件待提交`}</p>}
      {status.ignoredCount > 0 && (
        <p className="text-sm text-muted-foreground">
          {`另有 ${status.ignoredCount} 个无关变更被忽略，不会进提交`}
        </p>
      )}
      {!status.hasRemote && <p className="text-sm text-muted-foreground">未配置远端：变更只提交到本地</p>}
      {status.remoteAhead === null && (
        <p className="text-sm text-muted-foreground">远端是否有新提交未知（探测失败或没有上游）</p>
      )}
    </div>
  );
}
