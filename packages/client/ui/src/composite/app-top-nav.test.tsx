/** 顶栏：导航项、高亮、跳转回调、显式高度。纯 props 驱动（ui 不调接口、不依赖路由库）。 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SettingsIcon } from 'lucide-react';
import { AppTopNav, type AppTopNavProps } from './app-top-nav';

const ITEMS = [
  { key: 'cases', label: '用例', href: '/cases' },
  { key: 'runs', label: '评测', href: '/runs' },
  { key: 'settings', label: '设置', href: '/settings' },
] as const;

function setup(overrides: Partial<AppTopNavProps> = {}): ReturnType<typeof render> {
  return render(<AppTopNav items={[...ITEMS]} active="runs" onNavigate={vi.fn()} {...overrides} />);
}

describe('AppTopNav', () => {
  it('渲染全部导航项', () => {
    setup();
    for (const item of ITEMS) expect(screen.getByText(item.label)).toBeInTheDocument();
  });

  it('导航项的顺序与传入顺序一致（顺序是数据，不在组件里重排）', () => {
    setup();
    const labels = screen.getAllByRole('link').map((link) => link.textContent);
    expect(labels).toEqual(['用例', '评测', '设置']);
  });

  it('点击导航项回调该项的 href', () => {
    const onNavigate = vi.fn();
    setup({ onNavigate });
    screen.getByText('用例').click();
    expect(onNavigate).toHaveBeenCalledWith('/cases');
  });

  it('当前项通过 aria-current 标出（可访问性 + 可断言）', () => {
    setup({ active: 'runs' });
    const current = screen.getByText('评测').closest('[aria-current]');
    expect(current?.getAttribute('aria-current')).toBe('page');
  });

  it('给了 onSearch 才渲染可见的搜索入口（⌘K 之外的第二条路）', () => {
    setup();
    expect(screen.queryByRole('button', { name: /搜索/ })).toBeNull();

    const onSearch = vi.fn();
    setup({ onSearch });
    screen.getByRole('button', { name: /搜索/ }).click();
    expect(onSearch).toHaveBeenCalledTimes(1);
  });

  it('不再渲染产品名与主题切换（主题的唯一入口在设置页，顶栏只留导航）', () => {
    // 这条守的是「入口唯一」：三档主题切换只在设置页有一份，顶栏不放第二份——两份读同一状态、
    // 成为第二处真源。若有人把它加回来，这条会失败并提醒他把入口收敛到设置页。
    setup();
    expect(screen.queryByText('AI 代码评测')).toBeNull();
    expect(screen.queryByText('跟随系统')).toBeNull();
    expect(screen.queryByText('明亮')).toBeNull();
    expect(screen.queryByText('暗色')).toBeNull();
  });

  /**
   * 图标守卫：导航项带图标时要渲染出来，且**不能污染可访问名**。
   * 为什么值得钉：图标库会给 svg 挂 `role="img" aria-label`（`@ant-design/icons` 就是这样），
   * 图标一旦没被 `aria-hidden` 藏起来，导航链接的可访问名会变成「setting 用例」——
   * 屏读器多念一个英文单词，按名字定位导航项也会失配，而界面「看起来完全正常」。
   */
  it('带 icon 的导航项渲染图标且 aria-hidden（可访问名仍只有文案）', () => {
    render(
      <AppTopNav
        items={[{ key: 'cases', label: '用例', href: '/cases', icon: SettingsIcon }]}
        active="cases"
        onNavigate={vi.fn()}
      />,
    );

    const link = screen.getByRole('link', { name: '用例' });
    const icon = link.querySelector('svg');
    expect(icon).not.toBeNull();
    expect(icon).toHaveAttribute('aria-hidden', 'true');
  });

  it('顶栏有显式高度、flexShrink:0 与吸顶（否则会被压缩或随页面滚走）', () => {
    // 布局在 jsdom 里测不出来，唯一可断言的就是「我们显式写了这几格」：
    // 顶栏与 PageShell（flex-1）同处 body 的纵向 flex；页面内容撑出文档滚动时，
    // 没有 sticky 的顶栏会跟着滚出视口，全站导航随之消失。
    const { container } = setup();
    const header = container.querySelector<HTMLElement>('header');
    expect(header).not.toBeNull();
    expect(header?.style.height).toBe('56px');
    expect(header?.style.flexShrink).toBe('0');
    expect(header?.style.position).toBe('sticky');
    expect(header?.style.top).toBe('0px');
    // 顶栏是导航容器：桌面与窄窗都只有这一条
    expect(container.querySelectorAll('header')).toHaveLength(1);
  });

  it('导航容器带可访问名（屏读器能把这一组链接当成主导航）', () => {
    setup();
    expect(screen.getByRole('navigation', { name: '主导航' })).toBeInTheDocument();
  });
});
