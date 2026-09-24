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

  it('无 description 时不渲染副文本', () => {
    const { container } = render(<EmptyState title="还没有数据" />);
    expect(screen.queryByText('先创建一条')).toBeNull();
    // 文案查询抓不住「无条件渲染副文本」——渲染出来的是一段空文本，查那句文案当然是 null。
    // 结构断言：无描述、无动作时，根容器的子元素只有 Empty 图与标题两个。
    expect(container.firstElementChild?.childElementCount).toBe(2);
  });
});
