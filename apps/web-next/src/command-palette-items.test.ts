// @vitest-environment node
/**
 * 命令面板的条目来源。
 *
 * 最要紧的一条是**导航项同源**：面板的「导航」分组必须由顶栏那份 `NAV_ITEMS` 派生，
 * 不许在面板侧再写一份清单。行为断言守住「此刻三项一致」，静态断言守住「结构上只有一处来源」——
 * 只做前者时，有人把列表照抄一份且内容暂时相同也照样绿。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { caseCommandGroup, navCommandGroup, runCommandGroup } from './command-palette-items';
import { NAV_ITEMS } from './nav';

const SOURCE = readFileSync(join(import.meta.dirname, 'command-palette-items.ts'), 'utf8');

/** 去掉注释：JSDoc 里提到 NAV_ITEMS / href 是说明文字，不是第二份清单 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('navCommandGroup', () => {
  it('与 NAV_ITEMS 逐项一致：顺序、文案、href 全部照搬（面板不是第二份导航清单）', () => {
    const group = navCommandGroup();

    expect(group.heading).toBe('导航');
    expect(group.items).toHaveLength(NAV_ITEMS.length);
    expect(group.items.map((item) => ({ label: item.label, href: item.href }))).toEqual(
      NAV_ITEMS.map((item) => ({ label: item.label, href: item.href })),
    );
    // id 在面板内唯一（用例 / 评测是 UUID，不会与 `nav-` 前缀相撞）
    expect(new Set(group.items.map((item) => item.id)).size).toBe(group.items.length);
  });

  it('静态：本模块只许从 NAV_ITEMS 派生导航项，不许重列那三个 href', () => {
    const source = stripComments(SOURCE);

    // 来源必须是那份真源本身
    expect(source).toMatch(/from '\.\/nav'/);
    expect(source).toMatch(/NAV_ITEMS\.map\(/);
    // 重列 href 就等于第二份清单：任一条被写死（哪怕当前内容相同）这条就红
    for (const href of ['/runs', '/cases', '/settings']) {
      expect(source).not.toContain(`'${href}'`);
    }
  });
});

describe('caseCommandGroup', () => {
  it('标题即用例标题，链接按用例页的右栏 URL 契约（panel=detail&id=）', () => {
    const group = caseCommandGroup([
      { id: 'c1', title: '登录页改造', repoPath: '/repo/web', repoBranch: 'feat/x' },
    ]);

    expect(group.heading).toBe('用例');
    expect(group.items[0]).toEqual({
      id: 'case-c1',
      label: '登录页改造',
      href: '/cases?panel=detail&id=c1',
      hint: '/repo/web @ feat/x',
    });
  });

  it('本地来源没有分支：hint 只有仓库路径', () => {
    const group = caseCommandGroup([{ id: 'c2', title: '本地用例', repoPath: '/repo/web', repoBranch: null }]);
    expect(group.items[0]?.hint).toBe('/repo/web');
  });
});

describe('runCommandGroup', () => {
  it('标题与链接复用评测页的口径（用例标题 · 备注 + panel=detail&id=）', () => {
    const group = runCommandGroup([{ id: 'r1', caseTitle: '登录页改造', note: '对比模型' }]);

    expect(group.heading).toBe('评测');
    expect(group.items[0]).toEqual({
      id: 'run-r1',
      label: '登录页改造 · 对比模型',
      href: '/runs?panel=detail&id=r1',
      hint: '登录页改造',
    });
  });

  it('没有备注时标题就是用例标题，也不给次要说明（否则面板里一行两遍同样的字）', () => {
    const group = runCommandGroup([{ id: 'r2', caseTitle: '登录页改造', note: '  ' }]);
    expect(group.items[0]?.label).toBe('登录页改造');
    expect(group.items[0]?.hint).toBeUndefined();
  });
});
