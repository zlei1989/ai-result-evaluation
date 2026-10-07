// @vitest-environment node
/**
 * 块渲染注册表的**透传**守卫（静态扫描：本目录既有手法，见 `agent-log-layering.test.ts`）。
 *
 * 为什么需要它：`TaskPanelCard` / `AskUserCard` 底部的「原始结果」抽屉，开合来自
 * `BlockRenderContext` 的 `rawOpen` / `onRawOpenChange`（L1 按键算好、卡片只透传）。
 * 类型系统只能保证「**传了**」，保证不了「**没传错**」——把 `rawOpen={ctx.rawOpen}` 写成
 * `rawOpen={false}` 照样编译通过，而症状是**卡片底部的按钮点不开**：
 * 别的用例（卡片只验证透传、timeline 只验证键）全绿，没有任何一条会红。
 *
 * 判据取次数而不是「字符串在不在」：两个卡片各一处，少一处就是漏了一张卡片。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(join(import.meta.dirname, 'block-renderer-registry.tsx'), 'utf8');

describe('块渲染注册表：rawOpen 透传', () => {
  it('两张带原文抽屉的卡片都从 ctx 取开合（不许写死）', () => {
    expect(source.match(/rawOpen=\{ctx\.rawOpen\}/g) ?? [], '有一张卡片没接 rawOpen').toHaveLength(2);
    expect(
      source.match(/onRawOpenChange=\{ctx\.onRawOpenChange\}/g) ?? [],
      '有一张卡片没接 onRawOpenChange',
    ).toHaveLength(2);
    // 写死任一格都会让「原始结果」按钮点不开 / 关不上
    expect(source).not.toMatch(/rawOpen=\{(true|false)\}/);
  });
});
