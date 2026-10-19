/**
 * 抽屉的几何口径：**主抽屉**（评测详情 / 排名 / 技能预览）与**二级抽屉**（环境信息 / 原始输出 /
 * 产物总览这类「从主抽屉里再推出来的一层」）各一档宽度。
 *
 * 三条口径：
 * · **档位是语义，数值是 CSS 变量**：`WIDE_DRAWER_SIZE` / `NESTED_DRAWER_SIZE` 是两档的
 *   变量引用，真值只写在应用全局样式（`--drawer-main-width` / `--drawer-nested-width`）里。
 *   组件里不出现 `max(61vw, …)` 这类表达式，也不写像素宽度——同一档位在两处各写一遍必然漂移，
 *   而漂移是**静默**的（抽屉照样弹出来，只是宽窄不一，jsdom 测不出布局、没有用例会红）。
 * · **主抽屉恒宽于二级抽屉**：61vw（下限 800px）对 60vw（上限 900px）。视口收窄到 1312px 以下
 *   主抽屉吃 800px 下限，而二级最大 60vw（< 800px）⇒ 仍然主更宽。这条关系由守卫按视口扫描钉住。
 * · **二级层的让位量由 Base UI 的嵌套计数驱动**：`MAIN_DRAWER_STYLE` 的 `marginRight` 读
 *   `--nested-dialogs`（每多一层二级对话框就加一），不写死某个像素距离——二级层宽度变了、
 *   视口变了，让位量仍然成立。
 *
 * 三处抽屉壳（评测详情 / 执行日志 / 技能预览）与二级层都走 Base UI `Sheet`：
 * 几何只从本文件取，组件里不出现宽度表达式。
 */

import type { CSSProperties } from 'react';

/** 主抽屉宽度的 CSS 变量名（值在应用全局样式里定义一次） */
export const MAIN_DRAWER_WIDTH_VAR = '--drawer-main-width';

/** 二级抽屉宽度的 CSS 变量名 */
export const NESTED_DRAWER_WIDTH_VAR = '--drawer-nested-width';

/**
 * 主抽屉的宽度：引用全局变量，下限 800px / 61vw 由 CSS 给。
 *
 * 内联 `width` 直接吃这个字符串，所有主抽屉因此共用同一档。
 */
export const WIDE_DRAWER_SIZE = `var(${MAIN_DRAWER_WIDTH_VAR})`;

/** 二级抽屉的宽度：引用全局变量（比主抽屉窄一档，推出来时仍看得见主抽屉） */
export const NESTED_DRAWER_SIZE = `var(${NESTED_DRAWER_WIDTH_VAR})`;

/**
 * 主抽屉的内联几何：宽度变量 + 窄屏兜底 + **嵌套让位量**。
 *
 * `--drawer-nested-shift: calc(var(--nested-dialogs, 0) * var(--drawer-nested-give-way))`：
 * 二级层每开一层，主抽屉整体左移一份让位量；`--nested-dialogs` 由 Base UI 写在弹层元素上，
 * 二级层一关就归零。公式放在自定义属性里，具体的 `margin-right` 由全局样式
 * `[data-drawer='main']` 消费——这样位移量随计数实时变化，也不需要组件里写像素。
 * 不用 `translate`：Base UI 自己的入场 / 离场动画走 `translate`，两处合并会互相覆盖。
 */
export const MAIN_DRAWER_STYLE = {
  width: WIDE_DRAWER_SIZE,
  maxWidth: '100vw',
  '--drawer-nested-shift': 'calc(var(--nested-dialogs, 0) * var(--drawer-nested-give-way))',
} as CSSProperties;

/** 二级抽屉的内联几何：宽度变量 + 窄屏兜底（正文内边距由内容自己给） */
export const NESTED_DRAWER_STYLE = {
  width: NESTED_DRAWER_SIZE,
  maxWidth: '100vw',
} as const;
