/**
 * 抽屉几何守卫（spec §7.2.1）。
 *
 * 为什么值得单独钉：这条口径没有任何运行时症状——宽度写错、padding 忘了置 0，
 * 页面照样工作，只是观感不对，且不会让任何别的用例变红。
 *
 * 两条断言策略：
 *   · **常量内容**（宽度 / maxWidth / padding）逐字钉住——它没有运行时症状，字面量守卫最稳；
 *   · **三个抽屉都真的用了它**（`styles={DRAWER_STYLES}` 三处）——只钉常量内容是不够的：
 *     有人给某一个抽屉换回内联 styles 时，常量还在、那个抽屉已经不照它渲染了。
 *     这正是「口径落在**一个**常量上」这句话要防的漂移。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// 用本文件的位置推导应用根目录，**不用 `process.cwd()`**：从仓库根跑 `pnpm test`（根 vitest.config.ts
// 一次收集 8 个包）时 CWD 是仓库根，`process.cwd()/app/runs/page.tsx` 不存在，套件在收集期就
// 以 ENOENT 整份死掉——症状是「永远红的门禁」，而不是某条断言失败（既有缺陷，本步修掉）。
const source = readFileSync(join(import.meta.dirname, '..', 'app', 'runs', 'page.tsx'), 'utf8');

describe('抽屉几何', () => {
  it('宽度是 max(50vw, 800px)', () => {
    expect(source).toContain('max(50vw, 800px)');
  });

  it('显式压住 100vw（窄屏下 800px 下限不许把抽屉撑出屏幕）', () => {
    expect(source).toContain('100vw');
  });

  it('内容区 padding 置 0（内边距改由内容自己给）', () => {
    expect(source).toContain('padding: 0');
  });

  it('三个抽屉都用了同一个 DRAWER_STYLES（不是各抄一份字面量）', () => {
    expect(source.match(/styles=\{DRAWER_STYLES\}/g) ?? []).toHaveLength(3);
  });

  it('不再使用 size="large"（固定预设会与 width 打架）', () => {
    expect(source).not.toContain('size="large"');
  });

  it('抽屉标题是「变更详情」', () => {
    // 标题文案没有别的守卫，而它是本次重命名的一半
    expect(source).toMatch(/title="变更详情"/);
    expect(source).not.toContain('代码改动');
  });
});
