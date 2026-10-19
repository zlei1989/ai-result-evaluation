/**
 * PageShell：四条结构性不变量 + 密度作用域落到 DOM（三半判据里的「乙」）。
 *
 * jsdom 没有 CSS 级联，量不到渲染后的字号；密度在这里只断言两件**它能看见**的事：
 * ① 根节点把 `density` 落到 `data-density` 属性上（CSS 变量按最近祖先继承，属性不在 = 豁免整页失效）；
 * ② 根节点带 `text-body` / `leading-body`，让继承链上的文字真的读到作用域变量。
 *
 * 结构性不变量从「读内联 style」改成「读类名」：新写法只有一份类名，没有
 * 「内联 style 与 antd 的 CSS 类谁赢」这个问题。
 */
import { describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { PageShell } from './page-shell';

function renderShell(ui: React.ReactNode): HTMLElement {
  const { container } = render(ui);
  return container.firstElementChild as HTMLElement;
}

describe('PageShell', () => {
  it('根节点是纵向 Flex 且吃掉顶栏之外的高度（命名工具类，不是任意值）', () => {
    const root = renderShell(
      <PageShell>
        <span>内容</span>
      </PageShell>,
    );
    // `flex-1` 而不是 `h-full`：外壳是 body 的纵向 flex，顶栏 56px 是兄弟节点；
    // 写 `h-full` 会把总高顶成「视口 + 40」，每页多一条滚动条、底栏被推到视口外。
    for (const cls of ['flex', 'flex-col', 'flex-1', 'w-full', 'min-w-0', 'min-h-0']) {
      expect(root.classList.contains(cls), `缺少结构类 ${cls}`).toBe(true);
    }
    expect(root.classList.contains('h-full'), 'h-full 会与顶栏叠加成 56px 溢出').toBe(false);
  });

  it('不设 alignItems（否则子元素不横向拉伸、父级被顶宽）', () => {
    const root = renderShell(
      <PageShell>
        <span>内容</span>
      </PageShell>,
    );
    expect(root.classList.contains('items-start')).toBe(false);
    expect(root.classList.contains('items-center')).toBe(false);
  });

  it('默认不落 padding / gap（不凭空新增间距）', () => {
    const root = renderShell(
      <PageShell>
        <span>内容</span>
      </PageShell>,
    );
    expect(root.classList.contains('p-page')).toBe(false);
    expect(root.classList.contains('gap-page')).toBe(false);
  });

  it('显式传入 padding / gap 时落密度间距类', () => {
    const root = renderShell(
      <PageShell padding={16} gap={16}>
        <span>内容</span>
      </PageShell>,
    );
    expect(root.classList.contains('p-page')).toBe(true);
    expect(root.classList.contains('gap-page')).toBe(true);
  });

  it('scroll=inner 时自身滚动，且三种模式都带 min-h-0（高度链是共用的）', () => {
    for (const scroll of ['page', 'inner', 'none'] as const) {
      const root = renderShell(
        <PageShell scroll={scroll}>
          <span>内容</span>
        </PageShell>,
      );
      expect(root.classList.contains('overflow-auto')).toBe(scroll === 'inner');
      expect(root.classList.contains('min-h-0'), '高度链断了：整页会被顶出顶栏那一截').toBe(true);
      cleanup(); // 同一用例内多次 render：先清掉上一个容器，否则查询会撞到多份节点
    }
  });

  it('密度落到 DOM：默认是 compact（data-density 是变量作用域的唯一入口）', () => {
    const root = renderShell(
      <PageShell>
        <span>内容</span>
      </PageShell>,
    );
    expect(root.dataset.density).toBe('compact');
    expect(root.classList.contains('text-body')).toBe(true);
    expect(root.classList.contains('leading-body')).toBe(true);
  });

  it('设置页豁免：density="default" 也落到属性上（两档都有规则，嵌套再入才正确）', () => {
    const root = renderShell(
      <PageShell density="default">
        <span>内容</span>
      </PageShell>,
    );
    expect(root.dataset.density).toBe('default');
  });

  it('嵌套时内层赢：default 子树里的 compact 壳重新紧凑', () => {
    render(
      <PageShell density="default">
        <PageShell density="compact">
          <span>内层内容</span>
        </PageShell>
      </PageShell>,
    );
    const inner = screen.getByText('内层内容').parentElement as HTMLElement;
    expect(inner.dataset.density).toBe('compact');
  });
});
