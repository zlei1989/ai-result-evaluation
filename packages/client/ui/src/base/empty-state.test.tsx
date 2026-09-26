/** EmptyState：说明文案与引导动作。 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PlusOutlined } from '@ant-design/icons';
import { EmptyState } from './empty-state';

describe('EmptyState', () => {
  it('渲染标题与描述', () => {
    render(<EmptyState title="还没有数据" description="先创建一条" />);
    expect(screen.getByText('还没有数据')).toBeInTheDocument();
    expect(screen.getByText('先创建一条')).toBeInTheDocument();
  });

  it('有 action 时渲染按钮并回调', async () => {
    const onClick = vi.fn();
    render(<EmptyState title="还没有数据" action={{ label: '创建', onClick }} />);
    // 名字写成 /创\s*建/ 而不是 '创建'：antd 的 Button 对**两个汉字**的标签会自动插一个空格
    // （渲染成 <span>创 建</span>，见 antd button 的 autoInsertSpace），可访问名因此是「创 建」。
    // 用宽松匹配，两侧行为（插空格 / 不插）都能命中。
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
   * 为什么值得钉：`variant` 在 antd 6 里**单独给不生效**——`Button.js` 只在 `color` 与 `variant`
   * 同时存在时才用它们，否则静默回落到 `['default','outlined']`。实测漏掉 `color` 时按钮照常渲染、
   * 只是边框从虚线变实线（类名 `ant-btn-variant-outlined`），没有任何报错或告警：
   * 「看起来还行、其实已经不是约定的样子」。下面按类名断言，正是为了拦住这种静默降级。
   */
  it('action.variant="dashed" 真的渲染成虚线（不被 antd 静默降级成实线）', () => {
    render(
      <EmptyState
        title="还没有用例"
        action={{ label: '创建用例', variant: 'dashed', icon: <PlusOutlined aria-hidden />, onClick: vi.fn() }}
      />,
    );
    // 按**可访问名**取按钮：图标带 `aria-hidden` 是全站约定的传法（本用例照传），
    // 少写它时 antd 图标的 `role="img" aria-label="plus"` 会把名字变成「plus 创建用例」，
    // 这句查询会直接失配。真实调用方（供应商表、用例表单）的图标由各自组件的用例钉住。
    const button = screen.getByRole('button', { name: '创建用例' });
    expect(button.className).toContain('ant-btn-variant-dashed');
    // 反面也断言一次：漏掉配对的 `color` 时 antd 会渲染成实线 outlined —— 那正是本守卫要拦的降级
    expect(button.className).not.toContain('ant-btn-variant-outlined');
  });

  it('不给 variant 时维持实心主按钮（不是所有引导动作都是「新增」）', () => {
    // 文案取四个字（评测页「回到列表」那种非新增的出路）：两个汉字的标签会被 antd 插空格成「重 试」，
    // 按名字查询就得写成 /重\s*试/，与本条要钉的东西无关（口径见同文件上面那条注释）
    render(<EmptyState title="还没有数据" action={{ label: '回到列表', onClick: vi.fn() }} />);
    expect(screen.getByRole('button', { name: '回到列表' }).className).toContain('ant-btn-variant-solid');
  });

  it('无 description 时不渲染副文本', () => {
    const { container } = render(<EmptyState title="还没有数据" />);
    expect(screen.queryByText('先创建一条')).toBeNull();
    // 文案查询抓不住「无条件渲染副文本」——渲染出来的是一段空文本，查那句文案当然是 null。
    // 结构断言：无描述、无动作时，根容器的子元素只有 Empty 图与标题两个。
    expect(container.firstElementChild?.childElementCount).toBe(2);
  });
});
