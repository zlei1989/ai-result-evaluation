/**
 * `NestedDrawer`（二级抽屉）的守卫。两种手法：
 *
 * **渲染断言**（jsdom 能看见的那一半）：
 *   1. 没开过 / 开过再关：正文都不在 DOM 里（关闭即卸载）；
 *   2. `open === true` 时标题与正文都在，且标题可覆盖；
 *   3. 关闭按钮与遮罩关闭都只回调一次（**开合归调用方**，本件不许自己关自己）。
 *
 * **静态扫描**（jsdom 看不见的那一半：宽度、让位）：
 *   jsdom 没有布局引擎，「抽屉多宽 / 主抽屉让位多少」测不出来；而这两格写错了是**静默**的。
 *   宽度只许来自 `NESTED_DRAWER_STYLE`（值在应用全局样式的 CSS 变量里）；让位归主抽屉，
 *   二级层自己写 `push` / 位移都是空转——Base UI 的嵌套计数写在父弹层上。
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { NestedDrawer } from './nested-drawer';

const dir = import.meta.dirname;
const raw = readFileSync(join(dir, 'nested-drawer.tsx'), 'utf8');
const geometry = readFileSync(join(dir, 'drawer-geometry.ts'), 'utf8');

/**
 * 去掉注释后的源码。
 *
 * **判据只许扫代码**：本件的文件头注释里正大光明地写着宽度值与被废弃的那个属性名
 * （那是讲给读的人听的口径），扫全文的话，注释会把两条负向断言直接判红——
 * 本条第一次跑就是这么假红的。守卫误伤比漏放行更危险（会教人把守卫删掉），故这里先剥注释。
 */
const source = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const BODY = '二级抽屉的正文';

describe('NestedDrawer（行为）', () => {
  /**
   * **`destroyOnHidden` 的判据必须是「开过再关」**：抽屉从没开过时，antd 本来就不挂载正文
   * （`forceRender` 默认 false），把 `destroyOnHidden` 删掉也照样绿 —— 判据只覆盖「没开过」时，
   * 它量不到「卸载」这件事。
   */
  it('没开过 → 正文不在 DOM；开过再关 → 正文从 DOM 里消失（是真卸载，不是视觉隐藏）', () => {
    const { rerender } = render(
      <NestedDrawer open={false} onClose={vi.fn()} title="原始输出 50 条">
        {BODY}
      </NestedDrawer>,
    );
    expect(screen.queryByText(BODY)).toBeNull();
    expect(screen.queryByText('原始输出 50 条')).toBeNull();

    rerender(
      <NestedDrawer open onClose={vi.fn()} title="原始输出 50 条">
        {BODY}
      </NestedDrawer>,
    );
    expect(screen.getByText(BODY)).toBeInTheDocument();

    rerender(
      <NestedDrawer open={false} onClose={vi.fn()} title="原始输出 50 条">
        {BODY}
      </NestedDrawer>,
    );
    expect(screen.queryByText(BODY)).toBeNull();
    expect(screen.queryByText('原始输出 50 条')).toBeNull();
  });

  it('open === true 时标题与正文都在（标题可覆盖）', () => {
    render(
      <NestedDrawer open onClose={vi.fn()} title="模型原始返回">
        {BODY}
      </NestedDrawer>,
    );

    expect(screen.getByText('模型原始返回')).toBeInTheDocument();
    expect(screen.getByText(BODY)).toBeInTheDocument();
  });

  it('关闭按钮只回调一次（开合归调用方，本件不自己关自己）', () => {
    const onClose = vi.fn();
    render(
      <NestedDrawer open onClose={onClose} title="原始结果">
        {BODY}
      </NestedDrawer>,
    );

    fireEvent.click(screen.getByRole('button', { name: /close|关闭/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
    // 受控：调用方没把 `open` 置假，正文就还在（本件不许自作主张）
    expect(screen.getByText(BODY)).toBeInTheDocument();
  });
});

describe('NestedDrawer（几何，静态）', () => {
  it('宽度只有一处数值：几何常量指向全局 CSS 变量（本件只引用 `NESTED_DRAWER_STYLE`）', () => {
    // 档位名还在几何常量里，数值只有应用全局样式那一份
    expect(geometry).toMatch(/export const NESTED_DRAWER_SIZE = `var\(\$\{NESTED_DRAWER_WIDTH_VAR\}\)`;/);
    expect(geometry).toContain('export const NESTED_DRAWER_WIDTH_VAR = \'--drawer-nested-width\';');
    expect(source, '二级抽屉自己写了一份宽度').not.toContain('60vw');
    expect(source, '二级抽屉没有走共享几何').toContain('style={NESTED_DRAWER_STYLE}');
  });

  it('语义槽不再由本件拼：面板 `p-0`，正文容器负责高度链与滚动', () => {
    expect(source).toContain('p-0');
    expect(source).toContain('min-h-0 flex-1 overflow-auto');
  });

  it('本件不声明让位（写了是空转）：推动量归主抽屉那一侧的嵌套计数', () => {
    // Base UI 把 `--nested-dialogs` 与 `data-nested-dialog-open` 写在父弹层上；
    // 二级层自己写位移既不生效，也会让下一个人以为推动是它干的。
    expect(source, '二级抽屉又写了位移——那一格不会生效，只会让人以为推动是它干的').not.toMatch(
      /nested-dialogs|marginRight|translate/,
    );
    // 关闭手势统一走 `onOpenChange`（Base UI 的遮罩 / Esc / 关闭键都汇到这里）
    expect(source).toContain('onOpenChange');
    expect(source, '又用回了 antd 的 width 出入口').not.toMatch(/\bwidth=/);
  });
});
