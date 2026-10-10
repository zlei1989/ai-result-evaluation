/**
 * `NestedDrawer`（二级抽屉）的守卫。六条，两种手法：
 *
 * **渲染断言**（jsdom 能看见的那一半）：
 *   1. `open === false` 时正文一个节点都不在 DOM 里（`destroyOnHidden`）——这是「原文不占
 *      主抽屉高度」的机制保证，不是视觉效果；
 *   2. `open === true` 时标题与正文都在，且标题可覆盖（入口按钮与抽屉标题用同一句话）；
 *   3. 关闭按钮与遮罩关闭都只回调一次（**开合归调用方**，本件不许自己关自己）。
 *
 * **静态扫描**（jsdom 看不见的那一半：宽度、推开距离、语义槽）：
 *   jsdom 没有布局引擎，「抽屉多宽」测不出来；而这几格写错了是**静默**的（抽屉照样弹出来，
 *   只是宽窄不对）。故按源码逐字钉：宽度只许来自 `NESTED_DRAWER_SIZE`，值钉在几何常量那一份里。
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
  it('宽度只有一处字面量：`NESTED_DRAWER_SIZE`（值钉在几何常量里）', () => {
    expect(geometry).toMatch(/export const NESTED_DRAWER_SIZE = 'min\(60vw, 900px\)';/);
    expect(source, '二级抽屉自己写了一份宽度').not.toContain('60vw');
    expect(source, '二级抽屉没有走共享常量').toContain('size={NESTED_DRAWER_SIZE}');
  });

  it('语义槽样式与主抽屉共用同一份（窄屏兜底 + 内容区自管内边距）', () => {
    expect(source).toContain('styles={DRAWER_SEMANTIC_STYLES}');
  });

  it('本件不写 push（写了是空转）：推动量归被推开的主抽屉', () => {
    // rc-drawer：`pushDistance = push?.distance ?? parentPushDistance ?? 180`，而子抽屉 open 时
    // 调的是 `parentContext.push()` —— 位移量取的是**父级自己**那一份。实测：子级写 360、
    // 主抽屉不写 ⇒ 只挪默认的 180。故这里必须**没有** push，主抽屉那一侧由 `MAIN_DRAWER_PUSH` 声明
    expect(source, '二级抽屉又写了 push——那一格不会生效，只会让人以为推动是它干的').not.toContain('push=');
    // 遮罩关闭走 `mask.closable`（`maskClosable` 已废弃）
    expect(source).toContain('mask={{ enabled: true, closable: true }}');
    expect(source, '又用回了已废弃的 maskClosable').not.toContain('maskClosable');
    expect(source, '又用回了已废弃的 width 出入口').not.toMatch(/\bwidth=/);
  });
});
