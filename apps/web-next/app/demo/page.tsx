'use client';

/**
 * 脚手架示例页：用内存假数据把「列表 + 可拖拽右边栏」跑通。
 * **这是过渡产物**——功能阶段实现真实用例页后，本页与 src/testing/demo-fixtures.ts 一并删除。
 * 页面顶部的 Alert 就是写给后来者的，避免误以为它是真功能。
 */
import { AppTopNav, DemoListPage, PageShell, type DemoRecordView } from '@aieval/ui';
import { Alert, message } from 'antd';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { DEMO_RECORDS, DEMO_STATUS_META } from '@/src/testing/demo-fixtures';
import { NAV_ITEMS } from '@/src/nav';

export default function Page(): React.ReactNode {
  const router = useRouter();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  /** 假数据 → 展示模型：把状态枚举翻成中文标签与颜色，ui 包不感知业务枚举 */
  const records: DemoRecordView[] = useMemo(
    () =>
      DEMO_RECORDS.map((record) => ({
        id: record.id,
        title: record.title,
        path: record.path,
        hash: record.hash,
        status: record.status,
        statusLabel: DEMO_STATUS_META[record.status].label,
        statusColor: DEMO_STATUS_META[record.status].color,
        size: record.size,
        updatedAt: record.updatedAt,
        note: record.note,
      })),
    [],
  );

  return (
    <>
      <AppTopNav items={[...NAV_ITEMS]} active="cases" onNavigate={(href) => router.push(href)} />
      <PageShell gap={8} padding={16}>
        <Alert
          type="info"
          showIcon
          closable
          // antd 6 把 Alert.message 换成了 Alert.title（message 已标记 @deprecated，
          // 继续用会在每次加载时往 console 打一条 error——自检口径要求干净加载 0 条 error）
          title="这是脚手架示例页，使用内存假数据；功能实现后本页删除。"
        />
        <div style={{ flex: 1, minHeight: 0 }}>
          <DemoListPage
            records={records}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onCreate={() => void message.info('示例页不持久化数据')}
            onClear={() => setSelectedId(null)}
          />
        </div>
      </PageShell>
    </>
  );
}
