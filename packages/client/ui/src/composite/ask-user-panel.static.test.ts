// @vitest-environment node
/**
 * `AskUserPanel` 的**静态扫描**守卫：jsdom 没有布局引擎，「抽屉往哪个方向弹、多高」
 * 测不出来，而这几格写错了是**静默**的（抽屉照样弹出来，只是位置或高度不对）。
 *
 * 三条判据都从源码逐字读：
 *   1. 方向是 `bottom`，高度只许来自 `BOTTOM_PANEL_SIZE`——宽度那一档是 `max(61vw, 800px)`，
 *      当高度用会直接顶穿视口；
 *   2. 每个按钮都关掉自动插空格：两个汉字的按钮渲染成「下一 步」之后，可访问名不再等于可见文案；
 *   3. 语义槽样式走共享常量、遮罩走 `mask`（`maskClosable` 已废弃），且本件不自己决定主题密度。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';

const dir = import.meta.dirname;

/**
 * 去掉注释后的源码。**判据只许扫代码**：文件头注释里正大光明地写着被废弃的属性名与高度口径
 * （那是讲给读的人听的），扫全文会把两条负向断言直接判红。守卫误伤比漏放行更危险——
 * 它会教人把守卫删掉。
 */
const source = readFileSync(join(dir, 'ask-user-panel.tsx'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');
const geometry = readFileSync(join(dir, '../base/drawer-geometry.ts'), 'utf8');

it('底部弹入：方向是 bottom，高度只有一处字面量（`BOTTOM_PANEL_SIZE`）', () => {
  expect(source).toContain('placement="bottom"');
  expect(source).toContain('size={BOTTOM_PANEL_SIZE}');
  // 高度不许在组件里写第二遍——写错了没有用例会红，只会静默掉回默认 378px
  expect(source, '组件里又写了一份高度字面量').not.toMatch(/\d+vh/);
  // 已废弃的两个出入口：`size` 之外再给 width / height，谁生效取决于 antd 内部顺序
  expect(source, '又用回了已废弃的 width / height 出入口').not.toMatch(/\b(width|height)=/);
  expect(geometry).toMatch(/export const BOTTOM_PANEL_SIZE = 'min\(60vh, 560px\)';/);
});

it('两个汉字的按钮都关掉自动插空格（否则可访问名不再等于可见文案）', () => {
  const buttons = source.split('<Button').slice(1);
  expect(buttons.length).toBeGreaterThan(0);
  for (const button of buttons) {
    // 每个 `<Button` 到它自己的 `>` 之间必须带这一格（antd 默认会在两个汉字之间插一个空格）
    expect(button.slice(0, button.indexOf('>'))).toContain('autoInsertSpace={false}');
  }
});

it('语义槽样式与遮罩走共享常量与现有 API，本件不自己决定主题密度', () => {
  expect(source).toContain('styles={DRAWER_SEMANTIC_STYLES}');
  expect(source).toContain('mask={{ enabled: true, closable: true }}');
  expect(source, '又用回了已废弃的 maskClosable').not.toContain('maskClosable');
  // 关掉即卸载 + 关到底才重置草稿（`Drawer` 没有 `afterClose`）
  expect(source).toContain('destroyOnHidden');
  expect(source).toContain('afterOpenChange');
  expect(source, '`Drawer` 没有 afterClose，写成它编译期就红').not.toContain('afterClose');
  // 紧凑密度只在 `PageShell` 子树里生效，本件包一层就会与宿主那一层叠成两层
  expect(source, '本件不该自己包 ConfigProvider（密度归宿主）').not.toContain('ConfigProvider');
  expect(source, '绝不显式写 fontSize（compactAlgorithm 会反向推导成更小的字）').not.toContain('fontSize');
});
