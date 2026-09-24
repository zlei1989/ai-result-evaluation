/**
 * PageShell：四条结构性不变量。
 * 最关键的一条是**不设 alignItems**——纵向 Flex 的交叉轴是水平方向，
 * align-items: flex-start 会让子元素不横向拉伸（表现为「没有横向沾满」）并把父级顶宽。
 * 后半段是密度守卫：ConfigProvider 不产生 DOM 节点，「紧凑」与「豁免」两条分支的 DOM
 * 完全相同，所以密度只能靠子组件里的 theme.useToken() 探针观察。
 */
import { describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { theme } from 'antd';
import { PageShell } from './page-shell';
import { DensityProvider } from './density-context';

function renderShell(ui: React.ReactNode, mode: 'light' | 'dark' = 'dark'): HTMLElement {
  const { container } = render(<DensityProvider mode={mode}>{ui}</DensityProvider>);
  return container.firstElementChild as HTMLElement;
}

/**
 * 实效 token 探针：读 ConfigProvider 真正下发的那份 token。
 * 为什么必须要它：ConfigProvider 不产生 DOM 节点，「包了紧凑主题」与「豁免、没包」
 * 两条分支的 DOM **完全相同**（见下一个用例的注释），结构断言区分不了密度。
 */
function TokenProbe(): React.ReactNode {
  const { token } = theme.useToken();
  return <span data-testid="token-probe" data-font-size={String(token.fontSize)} data-color-bg-base={String(token.colorBgBase)} />;
}

function renderProbe(mode: 'light' | 'dark' = 'dark', density: 'compact' | 'default' = 'compact'): DOMStringMap {
  render(
    <DensityProvider mode={mode}>
      <PageShell density={density}>
        <TokenProbe />
      </PageShell>
    </DensityProvider>,
  );
  return (screen.getByTestId('token-probe') as HTMLElement).dataset;
}

describe('PageShell', () => {
  it('根节点是纵向 Flex 且横向沾满', () => {
    renderShell(
      <PageShell>
        <span>内容</span>
      </PageShell>,
    );
    const root = screen.getByText('内容').parentElement as HTMLElement;
    expect(root.style.display).toBe('flex');
    expect(root.style.flexDirection).toBe('column');
    expect(root.style.width).toBe('100%');
    expect(root.style.minWidth).toBe('0px');
    expect(root.style.height).toBe('100%');
  });

  it('不设 alignItems（否则子元素不横向拉伸）', () => {
    renderShell(
      <PageShell>
        <span>内容</span>
      </PageShell>,
    );
    const root = screen.getByText('内容').parentElement as HTMLElement;
    expect(root.style.alignItems).toBe('');
  });

  it('默认不落 padding / gap（不凭空新增间距）', () => {
    renderShell(
      <PageShell>
        <span>内容</span>
      </PageShell>,
    );
    const root = screen.getByText('内容').parentElement as HTMLElement;
    expect(root.style.padding).toBe('');
    expect(root.style.gap).toBe('');
  });

  it('显式传入 padding / gap 时才落 style', () => {
    renderShell(
      <PageShell padding={16} gap={8}>
        <span>内容</span>
      </PageShell>,
    );
    const root = screen.getByText('内容').parentElement as HTMLElement;
    expect(root.style.padding).toBe('16px');
    expect(root.style.gap).toBe('8px');
  });

  it('scroll=inner 时自身滚动且带 minHeight:0', () => {
    renderShell(
      <PageShell scroll="inner">
        <span>内容</span>
      </PageShell>,
    );
    const root = screen.getByText('内容').parentElement as HTMLElement;
    expect(root.style.overflow).toBe('auto');
    expect(root.style.minHeight).toBe('0px');
  });

  it('scroll 三种模式下都带 minHeight:0（高度链是共用的，不只 inner 分支）', () => {
    // 守的是真实缺陷：默认 scroll="page" 的 /demo 在「右栏打开 + 窗口够矮」时，页面根保持
    // min-height:auto、收缩不到 flex 分配的高度，整页被顶出顶栏那一截——浏览器实测
    // documentElement.scrollHeight 545 > clientHeight 520（溢出 25px）、PageShell 高卡在 520（本应 495.33）；
    // 运行时把它的 min-height 压成 0 后溢出即归零（右栏内部滚动不受影响）。
    // 布局本身在 jsdom 里测不出来，唯一可断言的就是「这条不变量无条件落在内联 style 上」。
    for (const scroll of ['page', 'inner', 'none'] as const) {
      const root = renderShell(
        <PageShell scroll={scroll}>
          <span>内容</span>
        </PageShell>,
      );
      expect(root.style.minHeight).toBe('0px');
      // 只有 inner 接管滚动：其余模式不得凭空多出 overflow（否则页面会出现双滚动条）
      expect(root.style.overflow).toBe(scroll === 'inner' ? 'auto' : '');
      cleanup(); // 同一用例内多次 render：先清掉上一个容器，否则 screen 查询会撞到多份节点
    }
  });

  it('density=default 时按 antd 默认密度渲染（仍保持结构不变量）', () => {
    renderShell(
      <PageShell density="default">
        <span>内容</span>
      </PageShell>,
    );
    const root = screen.getByText('内容').parentElement as HTMLElement;
    expect(root.style.display).toBe('flex');
    expect(root.style.height).toBe('100%');
  });

  it('density=compact（默认）时实效字号是紧凑值 12', () => {
    expect(renderProbe('dark', 'compact').fontSize).toBe('12');
  });

  it('density=default 时豁免紧凑主题，实效字号回落 antd 默认 14', () => {
    // 上面那条 density=default 用例只能断言结构：豁免分支（直接 return content）与
    // 包了 ConfigProvider 的分支**渲染出完全相同的 DOM**，ConfigProvider 不加节点，
    // 所以「豁免有没有生效」只有读 token 才看得见。
    expect(renderProbe('dark', 'default').fontSize).toBe('14');
  });

  it('紧凑底色按 DensityProvider 的 mode 选择（light 与 dark 不同）', () => {
    const dark = renderProbe('dark').colorBgBase;
    cleanup(); // 同一用例内第二次 render：先清掉上一个容器，否则 getByTestId 会撞到两个节点
    const light = renderProbe('light').colorBgBase;
    expect(light).not.toBe(dark);
    // 顺手钉死方向：只有 equality 的话，「两份主题写反」这种变异体仍会通过
    expect(dark).toBe('#000');
    expect(light).toBe('#fff');
  });
});
