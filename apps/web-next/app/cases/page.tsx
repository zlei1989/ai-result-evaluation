'use client';

/**
 * 用例页占位（功能阶段实现列表 + 右栏详情/表单）。
 * 现在保留顶栏与页面骨架，让导航在脚手架阶段就能验收。
 */
import { AppTopNav, EmptyState, PageShell } from '@aieval/ui';
import { useRouter } from 'next/navigation';
import { NAV_ITEMS } from '@/src/nav';

export default function Page(): React.ReactNode {
  const router = useRouter();
  return (
    <>
      <AppTopNav items={[...NAV_ITEMS]} active="cases" onNavigate={(href) => router.push(href)} />
      <PageShell padding={16}>
        <EmptyState title="用例管理" description="脚手架阶段占位页，功能阶段实现创建与列表" />
      </PageShell>
    </>
  );
}
