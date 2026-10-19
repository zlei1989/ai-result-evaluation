// @vitest-environment node
/**
 * 页面骨架的静态守卫：三个主页面必须走 `PageHeader`，不许再手写 `<h1>`。
 *
 * 背景：页标题曾经是每页各写一份 `<h1 className="text-title">`，14px 与正文同号——
 * 「主次不分」不是某一次写错，而是**每页都可以自由发挥**这件事本身。把出口收成一个原语之后，
 * 这条守卫守的是「别再长回第二份」：手写 h1 不会报错，只会让那一页重新掉回正文层级。
 *
 * 判据只扫 `apps/web-next/app/{runs,cases,settings}/page.tsx` 三个主页面：
 * 抽屉/面板内部的小标题可以是 h2/h3，不在本守卫的范围内。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const APP = join(import.meta.dirname, '..', 'app');

/** 主页面：路径即口径，新增一级页面时在这里登记 */
const PAGES = ['runs/page.tsx', 'cases/page.tsx', 'settings/page.tsx'] as const;

describe('主页面骨架', () => {
  it.each(PAGES)('%s 用 PageHeader 且不再手写 h1', (page) => {
    const source = readFileSync(join(APP, page), 'utf8');
    expect(source, `${page} 没有用 PageHeader：页标题会重新掉回正文层级`).toMatch(/<PageHeader[\s>]/);
    expect(source, `${page} 里还有手写的 <h1：标题层级必须由 PageHeader 一处决定`).not.toMatch(/<h1[\s>]/);
    // 手写字号同理：页标题不再跟密度档，写 text-title 就是把 24px 压回 14px 的入口
    expect(source, `${page} 的标题不许挂密度字号（text-title）`).not.toMatch(/text-title/);
  });
});
