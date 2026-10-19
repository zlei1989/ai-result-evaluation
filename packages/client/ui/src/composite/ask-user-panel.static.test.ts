// @vitest-environment node
/**
 * `AskUserPanel` / `AskUserHost` 的**静态扫描**守卫：jsdom 没有布局引擎，
 * 「底部弹入、最多占多高」测不出来，而这几格写错了是**静默**的（弹层照样出来，只是位置或高度不对）。
 *
 * 三条判据都从源码逐字读：
 *   1. 应答面与宿主都不许再出现 antd 说明符：换栈之后回引一次，antd 的样式、主题与
 *      浮层逻辑就重新挂到这条路径上，而界面看起来仍然正常；
 *   2. 弹层是**底部** Sheet：`side="bottom"`，高度上限只在面板上写一处（`min(60vh,560px)`），
 *      正文自己可滚——底部弹层没有上限时，长问句会把页脚按钮顶出视口；
 *   3. 主题与密度仍归 `[data-density]` 作用域：本件不包 `ConfigProvider`、不显式写字号。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';

const dir = import.meta.dirname;
const panelPath = join(dir, 'ask-user-panel.tsx');
const hostPath = join(dir, '../../../../../apps/web-next/app/ask-user-host.tsx');

/**
 * 去掉注释后的源码。**判据只许扫代码**：文件头注释里会正大光明地写「不 import antd」
 * 这类说明，扫全文会把负向断言直接判红。守卫误伤比漏放行更危险——它会教人把守卫删掉。
 */
const source = readFileSync(panelPath, 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');
const host = readFileSync(hostPath, 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

/** antd 与它的 scope 包：静态 import、副作用 import、动态 import、require 都算 */
const ANTD_SPECIFIER =
  /(?:from\s*|import\s*\(\s*|require\s*\(\s*|import\s+)['"](?:antd|@ant-design\/[^'"]+)['"]/;

it('应答面与宿主都不 import antd（这条路径已经全部落在新栈上）', () => {
  expect(source, 'ask-user-panel.tsx 又引了 antd').not.toMatch(ANTD_SPECIFIER);
  expect(host, 'ask-user-host.tsx 又引了 antd').not.toMatch(ANTD_SPECIFIER);
});

it('底部 Sheet：方向是 bottom，高度上限只有一处字面量，正文可滚', () => {
  expect(source).toContain('<SheetContent');
  expect(source).toContain('side="bottom"');
  // 标题与页脚之间的正文自己滚；缺了它，长问句会把页脚按钮顶到视口外面
  expect(source).toContain('overflow-y-auto');
  // 高度上限只许出现一次：60vh 是「最多占六成视口」的那一档，写第二遍必然漂移
  expect(source.match(/\d+vh/g) ?? []).toEqual(['60vh']);
  expect(source).toContain('max-h-[min(60vh,560px)]');
  // 关闭是中文可访问名：面板上的叉是「关掉」而不是「回答」，名字要能被读出来
  expect(source).toContain('aria-label="关闭"');
});

it('主题与密度归作用域，本件不自己决定字号', () => {
  expect(source, '本件不该自己包 ConfigProvider（密度归作用域）').not.toContain('ConfigProvider');
  expect(source, '字号走密度档，不显式写 fontSize').not.toContain('fontSize');
});
