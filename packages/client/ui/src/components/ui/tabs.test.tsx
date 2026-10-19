/**
 * 页签的**惰性挂载**语义（设置屏四页签依赖它）。
 *
 * 设置屏的四个页签里有三张会发请求、会渲染大表的卡片；未激活的页签若也挂载，
 * 每次进设置页都会把所有页签的组件树渲一遍（首屏变慢、隐藏面板里的请求也照发）。
 * 原 antd `Tabs` 默认不渲染未激活面板，新栈必须保持同一条语义。
 *
 * 判据是**DOM 里有没有那段内容**，不是 CSS 隐藏：`hidden` / `display:none` 仍算挂载
 * （子树里的 effect 与请求照旧跑），只有「不在 document 里」才是惰性。
 */
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './tabs';

describe('Tabs 的惰性挂载', () => {
  it('未激活页签的内容不在 DOM 里（不是 hidden，是整块没渲染）', () => {
    render(
      <Tabs value="basic">
        <TabsList>
          <TabsTrigger value="basic">基础</TabsTrigger>
          <TabsTrigger value="judge">评分</TabsTrigger>
        </TabsList>
        <TabsContent value="basic">供应商表格</TabsContent>
        <TabsContent value="judge">评分配置</TabsContent>
      </Tabs>,
    );

    expect(screen.getByText('供应商表格')).toBeInTheDocument();
    // 未激活的那一块：连节点都不该存在（`queryByText` 对 hidden 元素仍会命中，故这条判据足够硬）
    expect(screen.queryByText('评分配置')).toBeNull();
  });

  it('切到另一页后，上一页的内容随之从 DOM 卸载', async () => {
    function Host(): React.ReactNode {
      return (
        <Tabs defaultValue="basic">
          <TabsList>
            <TabsTrigger value="basic">基础</TabsTrigger>
            <TabsTrigger value="judge">评分</TabsTrigger>
          </TabsList>
          <TabsContent value="basic">供应商表格</TabsContent>
          <TabsContent value="judge">评分配置</TabsContent>
        </Tabs>
      );
    }
    render(<Host />);

    fireEvent.click(screen.getByRole('tab', { name: '评分' }));

    expect(await screen.findByText('评分配置')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('供应商表格')).toBeNull());
  });
});
