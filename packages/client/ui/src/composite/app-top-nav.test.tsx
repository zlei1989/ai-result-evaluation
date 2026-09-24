/** 顶栏：导航高亮、跳转回调、显式高度。纯 props 驱动（ui 不调接口、不依赖路由库）。 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AppTopNav, type AppTopNavProps } from './app-top-nav';
import { installResizeObserverStub } from '../testing/resize-observer';

// jsdom 不提供 ResizeObserver，而横向 Menu 的溢出折叠（@rc-component/overflow）会经由
// @rc-component/resize-observer 直接 new 全局构造器：不打桩，挂载即抛 ReferenceError ——
// 环境缺口，不是被测代码的问题（同 Task 11 的既定口径：需要的用例自己装桩，不进共享 setup）。
beforeEach(() => {
  installResizeObserverStub();
});

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

  it('不再渲染产品名与主题切换（主题的唯一入口在设置页，顶栏只留导航）', () => {
    // 这条守的是「入口唯一」：顶栏曾经也放一份三档主题切换，与设置页那份读同一状态、
    // 成为第二处真源。若有人把它加回来，这条会失败并提醒他把入口收敛到设置页。
    setup();
    expect(screen.queryByText('AI 代码评测')).toBeNull();
    expect(screen.queryByText('跟随系统')).toBeNull();
    expect(screen.queryByText('明亮')).toBeNull();
    expect(screen.queryByText('暗色')).toBeNull();
  });

  it('顶栏有显式高度（根作用域里 --ant-layout-header-height 是空值，antd 的 height 解析不出值）', () => {
    // 这条不变量守的是真实缺陷：顶栏渲染在**根** ConfigProvider 作用域（它是 PageShell 的兄弟节点，
    // 紧凑作用域由 PageShell 自己创建），浏览器实测根作用域里 --ant-layout-header-height 为**空字符串**，
    // 于是 antd 的 `.ant-layout-header { height: var(--ant-layout-header-height) }` 在计算值阶段失效、
    // height 退回 auto：顶栏塌成内容高度 **24.67px**、padding-block 0（子元素上下零余量）。
    // 布局在 jsdom 里测不出来，唯一可断言的就是「我们显式写了内联高度」。
    const { container } = setup();
    const header = container.querySelector<HTMLElement>('header.ant-layout-header');
    expect(header).not.toBeNull();
    expect(header?.style.height).not.toBe('');
    // 顺带钉死当前取值（实测渲染高 40px）：改高度必须显式改这条断言
    expect(header?.style.height).toBe('40px');
    // 只有 height 还不够：顶栏与 PageShell（height:100%）同处 .ant-app 这个纵向 flex，
    // PageShell 的 100% 把总高顶到「视口 + 顶栏」后，浏览器会把顶栏一起压缩——实测仅写 height:40
    // （flexShrink 取默认 1）时顶栏是 37.84px（另一次测量 38.27px：被压掉多少随视口高与滚动条
    // 的有无浮动，别当固定常数），补上 flexShrink:0 才是确定的 40px（页面照样不溢出）。
    expect(header?.style.flexShrink).toBe('0');
  });
});
