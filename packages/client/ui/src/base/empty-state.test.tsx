/** EmptyState：说明文案与引导动作。 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { EmptyState } from './empty-state';

describe('EmptyState', () => {
  it('渲染标题与描述', () => {
    render(<EmptyState title="还没有数据" description="先创建一条" />);
    expect(screen.getByText('还没有数据')).toBeInTheDocument();
    expect(screen.getByText('先创建一条')).toBeInTheDocument();
  });

  it('基座是新栈的 Empty（占位图与空态排版都来自它）', () => {
    const { container } = render(<EmptyState title="还没有数据" />);
    expect(container.querySelector('[data-slot="empty"]')).not.toBeNull();
    expect(container.querySelector('[data-slot="empty-title"]')).not.toBeNull();
  });

  it('有 action 时渲染按钮并回调', async () => {
    const onClick = vi.fn();
    render(<EmptyState title="还没有数据" action={{ label: '创建', onClick }} />);
    screen.getByRole('button', { name: /创\s*建/ }).click();
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('无 action 时不渲染按钮', () => {
    render(<EmptyState title="还没有数据" />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  /**
   * 创建 / 添加类空态的形态守卫（全站新增按钮：前导加号 + 虚线边框）。
   *
   * 为什么值得钉：虚线是**两半**拼出来的——`outline` 变体给描边、`border-dashed` 给虚线，
   * 少了后一半时按钮照常渲染、只是边框变实线，没有任何报错：
   * 「看起来还行、其实已经不是约定的样子」。
   */
  it('action.variant="dashed" 真的渲染成虚线描边', () => {
    render(
      <EmptyState
        title="还没有用例"
        action={{ label: '创建用例', variant: 'dashed', onClick: vi.fn() }}
      />,
    );
    const button = screen.getByRole('button', { name: '创建用例' });
    expect(button.className).toContain('border-dashed');
    expect(button.className).toContain('bg-background');
    // 反面也断言一次：漏掉 variant 时是实心主按钮（`bg-primary`）——那正是本守卫要拦的降级
    expect(button.className).not.toContain('bg-primary');
  });

  it('不给 variant 时维持实心主按钮（不是所有引导动作都是「新增」）', () => {
    render(<EmptyState title="还没有数据" action={{ label: '回到列表', onClick: vi.fn() }} />);
    const button = screen.getByRole('button', { name: '回到列表' });
    expect(button.className).toContain('bg-primary');
    expect(button.className).not.toContain('border-dashed');
  });

  it('多个动作按顺序横排（第一个是主按钮）', () => {
    render(
      <EmptyState
        title="还没有 MCP 服务"
        action={[
          { label: '添加第一台', onClick: vi.fn() },
          { label: '粘贴 JSON', variant: 'dashed', onClick: vi.fn() },
        ]}
      />,
    );
    const buttons = screen.getAllByRole('button');
    expect(buttons.map((button) => button.textContent)).toEqual(['添加第一台', '粘贴 JSON']);
    expect(buttons[0]?.className).toContain('bg-primary');
  });

  it('无 description 时不渲染副文本', () => {
    render(<EmptyState title="还没有数据" />);
    expect(screen.queryByText('先创建一条')).toBeNull();
    // 文案查询抓不住「无条件渲染副文本」——渲染出来的是一段空文本，查那句文案当然是 null。
    expect(screen.queryByText('', { selector: '[data-slot="empty-description"]' })).toBeNull();
  });

  it('带 icon 的动作把图标放进按钮里（可访问名只来自文案）', () => {
    render(
      <EmptyState
        title="还没有数据"
        action={{ label: '创建用例', icon: <span aria-hidden data-testid="plus-icon" />, onClick: vi.fn() }}
      />,
    );
    const button = screen.getByRole('button', { name: '创建用例' });
    expect(button.querySelector('[data-testid="plus-icon"]')).not.toBeNull();
  });
});
