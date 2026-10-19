/** Toolbar：标题与动作区。 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Toolbar } from './toolbar';

describe('Toolbar', () => {
  it('渲染标题', () => {
    render(<Toolbar title="用例" />);
    expect(screen.getByText('用例')).toBeInTheDocument();
  });

  it('渲染右侧动作区', () => {
    render(<Toolbar title="用例" extra={<button type="button">创建用例</button>} />);
    expect(screen.getByRole('button', { name: '创建用例' })).toBeInTheDocument();
  });

  it('无 extra 时不渲染动作容器', () => {
    const { container } = render(<Toolbar title="用例" />);
    expect(container.querySelectorAll('button').length).toBe(0);
    // 只查 button 抓不住「无条件渲染动作容器」——空的容器里本来就没有 button。
    // 结构断言：根容器的子元素只有标题这一个。
    expect(container.firstElementChild?.childElementCount).toBe(1);
  });

  /**
   * 无标题时必须整体靠右。为什么值得钉：`justify-between` 若仍写死，
   * 只有动作区一个子元素时它会被推到**左**端——界面上就是「创建按钮莫名跑到左边」，
   * 既不报错、也没有别的用例会红。
   */
  it('不给 title 时只渲染动作区，且整体靠右', () => {
    const { container } = render(<Toolbar extra={<button type="button">创建用例</button>} />);
    const root = container.firstElementChild as HTMLElement;
    // 结构：只剩动作区一个子元素，没有残留的空标题节点
    expect(root.childElementCount).toBe(1);
    expect(screen.getByRole('button', { name: '创建用例' })).toBeInTheDocument();
    // 对齐靠命名类：`justify-*` 是 flex 容器的类，不是可继承的内联样式
    expect(root.className).toContain('justify-end');
    expect(root.className).not.toContain('justify-between');
  });

  it('有 title 时两端对齐（标题在左、动作在右）', () => {
    const { container } = render(<Toolbar title="用例" extra={<button type="button">创建</button>} />);
    expect((container.firstElementChild as HTMLElement).className).toContain('justify-between');
  });
});
