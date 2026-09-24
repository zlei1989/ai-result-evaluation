'use client';

/**
 * 设置页（脚手架阶段只做「界面主题」一项）。
 * 供应商 / 评分配置 / 工作区三项由功能阶段补齐——这里刻意留出 Tabs 结构，
 * 免得功能阶段再改一遍页面骨架。
 */
import { useSettings } from '@aieval/client';
import type { ThemeMode } from '@aieval/contracts';
import { AppTopNav, PageShell } from '@aieval/ui';
import { Card, Form, Segmented, Skeleton, Tabs, Tooltip, Typography, message } from 'antd';
import { useRouter } from 'next/navigation';
import { NAV_ITEMS, type NavKey } from '@/src/nav';

export default function Page(): React.ReactNode {
  const router = useRouter();
  const { settings, update } = useSettings();

  /** 保存失败统一以服务端中文 message 提示，避免未捕获 rejection */
  const onError = (error: unknown): void => {
    void message.error(error instanceof Error ? error.message : String(error));
  };
  const activeNav: NavKey = 'settings';

  return (
    <>
      <AppTopNav items={[...NAV_ITEMS]} active={activeNav} onNavigate={(href) => router.push(href)} />
      <PageShell density="default" gap={16} padding={16}>
        <Tabs
          items={[
            {
              key: 'theme',
              label: '界面主题',
              children: (
                <Card title="界面主题" size="small" data-testid="theme-card">
                  {settings ? (
                    <Form layout="vertical" size="small" component={false}>
                      <Form.Item label="主题偏好" style={{ marginBottom: 0 }}>
                        <Tooltip title="跟随系统会随操作系统的明暗偏好自动切换（无需刷新）；明亮 / 暗色为显式指定">
                          <Segmented
                            data-testid="theme-segmented"
                            size="small"
                            value={settings.theme}
                            options={[
                              { label: '跟随系统', value: 'auto' },
                              { label: '明亮', value: 'light' },
                              { label: '暗色', value: 'dark' },
                            ]}
                            onChange={(value) => void update({ theme: value as ThemeMode }).catch(onError)}
                          />
                        </Tooltip>
                      </Form.Item>
                    </Form>
                  ) : (
                    <Skeleton active />
                  )}
                </Card>
              ),
            },
            {
              key: 'providers',
              label: '模型供应商',
              children: <Typography.Text type="secondary">功能阶段实现</Typography.Text>,
            },
            {
              key: 'judge',
              label: '评分配置',
              children: <Typography.Text type="secondary">功能阶段实现</Typography.Text>,
            },
            {
              key: 'workspace',
              label: '工作区',
              children: <Typography.Text type="secondary">功能阶段实现</Typography.Text>,
            },
          ]}
        />
      </PageShell>
    </>
  );
}
