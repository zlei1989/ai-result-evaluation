'use client';

/**
 * 工作区卡：根目录 Input + 「校验并保存」+ 最近一次校验结果。
 * 纯展示：输入框是本地状态，点按钮把值交给 onValidate（调用方去发 PUT /api/settings）。
 *
 * 三个刻意的取舍：
 *   1. 按钮叫「校验并保存」而不是「校验」：它确实会写盘（服务端校验通过就落盘，§6.3），
 *      名字必须说清这一点，否则用户以为只是「试试看」而不敢点，或者点了之后不知道已经生效；
 *   2. 校验失败时**保留用户输入**：把输入框弹回旧值会让人以为是自己填错了格式，
 *      而真正的原因（建目录失败 / 不可写）就写在结果区里 —— 两者必须同时可见；
 *   3. 按钮显式给 `aria-label`：antd 的加载图标自带 `role="img" aria-label="loading"`，会被并进
 *      按钮的可访问名（屏读器念成「loading 校验并保存」，按名字定位按钮也失配），
 *      所以 `loading` 期间也把名字钉成与可见文案逐字一致。
 */
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Alert, Button, Card, Flex, Form, Input, Typography } from 'antd';
import type { Settings } from '@aieval/contracts';

export interface WorkspaceSettingsCardProps {
  settings: Settings;
  onValidate: (root: string) => void;
  saving: boolean;
  /** 最近一次校验结果：null = 还没校验过；ok=false 时 message 是服务端的中文原因 */
  lastValidated: { root: string; ok: boolean; message?: string } | null;
}

export function WorkspaceSettingsCard({
  settings,
  onValidate,
  saving,
  lastValidated,
}: WorkspaceSettingsCardProps): ReactNode {
  const [root, setRoot] = useState(settings.workspaceRoot);

  // 只依赖那个字符串：设置从服务端回来（或别处改了根目录）时同步输入框，
  // 而校验失败后 settings.workspaceRoot 没变、effect 不重跑，用户刚敲的路径因此不会被顶掉。
  useEffect(() => {
    setRoot(settings.workspaceRoot);
  }, [settings.workspaceRoot]);

  return (
    <Card size="small" title="工作区" data-testid="workspace-settings-card">
      <Form layout="vertical" size="small" component={false}>
        <Form.Item
          label="工作区根目录"
          extra="评测的行工作副本、事件日志与用例缓存都落在这个目录下；默认 ~/.runs"
          style={{ marginBottom: 8 }}
        >
          <Flex gap={8}>
            <Input
              aria-label="工作区根目录"
              value={root}
              placeholder="~/.runs"
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
      </Form>
    </Card>
  );
}
