'use client';

/**
 * 存储目录卡：工作区根目录 + 用例目录两格「校验并保存」、用例变更自动提交开关、用例同步状态与两个人工动作。
 * 纯展示：输入框是本地状态，点按钮把值交给 `onValidate*`（调用方去发 PUT /api/settings）；
 * 状态区与按钮的显隐全部由 props 决定（组件**不调接口、不认识 message**，失败提示是页面的事）。
 *
 * 四个刻意的取舍：
 *   1. 按钮叫「校验并保存」而不是「校验」：它确实会写盘（服务端校验通过就落盘），
 *      名字必须说清这一点，否则用户以为只是「试试看」而不敢点，或者点了之后不知道已经生效；
 *   2. 校验失败时**保留用户输入**：把输入框弹回旧值会让人以为是自己填错了格式，
 *      而真正的原因（建目录失败 / 不可写）就写在结果区里 —— 两者必须同时可见；
 *   3. 按钮显式给 `aria-label`：antd 的加载图标自带 `role="img" aria-label="loading"`，会被并进
 *      按钮的可访问名（屏读器念成「loading 校验并保存」，按名字定位按钮也失配），
 *      所以 `loading` 期间也把名字钉成与可见文案逐字一致；
 *   4. 用例目录那一格的 `extra` 必须同时说三句话（一文件一用例 / 默认值 / **不会迁移**已有文件）：
 *      「改目录不迁移」是本功能最容易被误解的一点，漏了它用户会以为换了目录就搬了家。
 */
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Alert, Button, Card, Flex, Form, Input, Skeleton, Switch, Typography } from 'antd';
import type { CaseSyncAction, CaseSyncStatus, SettingsView } from '@aieval/contracts';
import { formatDateTime, shortHash } from '../base/format';

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
  /** 同步状态快照；undefined = 还没读到（读失败由页面给 Alert，这里配合 `syncError` 只画骨架屏） */
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
  // 文案与 `aria-label` 用同一个值：两者分叉时，loading 期间按名字定位按钮会失配（见文件头取舍 3）
  const pullLabel = pullCount !== null && pullCount > 0 ? `拉取（远端领先 ${pullCount} 个提交）` : '拉取';

  return (
    <Card size="small" title="存储目录" data-testid="workspace-settings-card">
      <Form layout="vertical" size="small" component={false}>
        <Form.Item
          label="工作区根目录"
          extra="评测的行工作副本、事件日志与用例缓存都落在这个目录下；默认 ~/.aieval-runs"
          style={{ marginBottom: 8 }}
        >
          <Flex gap={8}>
            <Input
              aria-label="工作区根目录"
              value={root}
              placeholder="~/.aieval-runs"
              disabled={saving}
              onChange={(event) => setRoot(event.target.value)}
            />
            <Button
              type="primary"
              loading={saving}
              // 加载图标自带 `role="img" aria-label="loading"`：不给显式名字的话，
              // saving 期间按钮的可访问名会变成「loading 校验并保存」，屏读器与按名字定位都失配
              aria-label="校验并保存"
              // 空值不必走一趟服务端：服务端也会拒（「工作区根目录不能为空」），但那是一次多余的往返
              disabled={saving || root.trim() === ''}
              onClick={() => onValidate(root)}
            >
              校验并保存
            </Button>
          </Flex>
        </Form.Item>

        {lastValidated !== null && lastValidated.ok && (
          <Alert type="success" showIcon title={`工作区可用：${lastValidated.root}`} />
        )}
        {lastValidated !== null && !lastValidated.ok && (
          <Alert type="error" showIcon title="工作区不可用，设置未改动" description={lastValidated.message} />
        )}

        <Typography.Text type="secondary">
          改动根目录不会迁移已有产物：旧评测仍留在原目录，历史评测里显示的是它当时的实际路径。
        </Typography.Text>

        <Form.Item
          label="用例目录"
          extra="一个用例一个文件，存在 <用例目录>/<用例 id>.json；默认 ~/.aieval-cases。改目录不会迁移已有用例文件：旧文件留在原目录，用例列表只认新目录。"
          style={{ marginBottom: 8, marginTop: 12 }}
        >
          <Flex gap={8}>
            <Input
              aria-label="用例目录"
              value={casesRoot}
              placeholder="~/.aieval-cases"
              disabled={saving}
              onChange={(event) => setCasesRoot(event.target.value)}
            />
            <Button
              type="primary"
              loading={saving}
              // 与上面同一理由：loading 期间也要有稳定、与可见文案一致的可访问名
              aria-label="校验并保存"
              disabled={saving || casesRoot.trim() === ''}
              onClick={() => onValidateCasesRoot(casesRoot)}
            >
              校验并保存
            </Button>
          </Flex>
        </Form.Item>

        {lastValidatedCases !== null && lastValidatedCases.ok && (
          <Alert type="success" showIcon title={`用例目录可用：${lastValidatedCases.root}`} />
        )}
        {lastValidatedCases !== null && !lastValidatedCases.ok && (
          <Alert type="error" showIcon title="用例目录不可用，设置未改动" description={lastValidatedCases.message} />
        )}

        {/* 开关与原因同一行：置灰而不说原因，用户只会以为这一格坏了 */}
        <Flex align="center" gap={8} wrap>
          {/* `aria-label` 与文案同名：`Switch` 没有可访问名时屏读器只会念「开关」 */}
          <Switch
            size="small"
            aria-label="用例变更时自动提交"
            checked={settings.casesAutoCommit}
            disabled={autoCommitDisabled}
            onChange={onToggleAutoCommit}
          />
          <Typography.Text>用例变更时自动提交</Typography.Text>
          {autoCommitDisabled && (
            <Typography.Text type="secondary">
              {blockedReason ?? '用例目录当前不是 git 仓库，无法自动提交'}
            </Typography.Text>
          )}
        </Flex>

        <SyncStatusArea status={syncStatus} error={syncError} />

        {(canCommit || canPull) && (
          <Flex gap={8} style={{ marginTop: 8 }}>
            {canCommit && (
              <Button
                type="primary"
                size="small"
                loading={syncing}
                aria-label="提交"
                disabled={actionDisabled}
                onClick={() => onSyncAction('commit')}
              >
                提交
              </Button>
            )}
            {canPull && (
              <Button
                size="small"
                loading={syncing}
                aria-label={pullLabel}
                disabled={actionDisabled}
                onClick={() => onSyncAction('pull')}
              >
                {pullLabel}
              </Button>
            )}
          </Flex>
        )}
      </Form>
    </Card>
  );
}

/**
 * 状态区：快照 → 几行**只读**事实。抽成内部组件只为让上面那块可读，
 * 判定全在这里（页面没有测试面，判定留在页面里就等于没有守卫）。
 *
 * 三态分工：`syncStatus === undefined && syncError === undefined` = 还在读 → Skeleton；
 * 读失败（error 有值）→ 这里什么都不画，页面会给出错误 Alert（组件不认识 message，也不该猜原因）；
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
    return error === undefined ? <Skeleton active paragraph={{ rows: 2 }} /> : null;
  }
  if (!status.isRepo) {
    return (
      <Alert
        type="warning"
        showIcon
        title="用例目录还不是 git 仓库：用例变更不会提交"
        description={status.blockedReason}
      />
    );
  }
  return (
    <Flex vertical gap={4} style={{ marginTop: 8 }}>
      {status.running && <Alert type="info" showIcon title="正在同步用例变更…" />}
      {status.lastError !== null && (
        <Alert type="error" showIcon title={`上次同步失败：${status.lastError}`} />
      )}
      {status.lastSuccessAt !== null && (
        <Typography.Text type="secondary">
          {`上次同步成功：${formatDateTime(status.lastSuccessAt)}${status.lastCommit === null ? '' : `（${shortHash(status.lastCommit)}）`}`}
        </Typography.Text>
      )}
      {status.pendingCount > 0 && (
        <Typography.Text>{`有 ${status.pendingCount} 个用例文件待提交`}</Typography.Text>
      )}
      {status.ignoredCount > 0 && (
        <Typography.Text type="secondary">
          {`另有 ${status.ignoredCount} 个无关变更被忽略，不会进提交`}
        </Typography.Text>
      )}
      {!status.hasRemote && <Typography.Text type="secondary">未配置远端：变更只提交到本地</Typography.Text>}
      {status.remoteAhead === null && (
        <Typography.Text type="secondary">远端是否有新提交未知（探测失败或没有上游）</Typography.Text>
      )}
    </Flex>
  );
}
