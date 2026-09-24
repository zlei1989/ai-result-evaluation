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
    // 只查 button 抓不住「无条件渲染动作容器」——空的 Flex 里本来就没有 button。
    // 结构断言：根容器的子元素只有标题这一个。
    expect(container.firstElementChild?.childElementCount).toBe(1);
  });
});
