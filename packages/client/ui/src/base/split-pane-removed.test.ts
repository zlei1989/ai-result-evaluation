// @vitest-environment node
/**
 * `SplitPane` 已删除的静态守卫。
 *
 * 它曾是 antd `Splitter` 的薄适配，没有任何生产消费者：留着它只会让
 * 「antd 清零」多一个必须保留的例外，也会诱使下一张票再拿它拼两栏。
 * 删除的判据不能只看文件在不在（有人把实现挪到别的文件名下同样算复活），
 * 故三件事一起钉：文件不在、包根不再转出、全仓没有消费者的标识符。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const BASE_DIR = import.meta.dirname;
/** `packages/client/ui`：上面两级是 `base` 与 `src` */
const PACKAGE_ROOT = join(BASE_DIR, '..', '..');
const REPO_ROOT = join(PACKAGE_ROOT, '..', '..', '..');

const SKIP_DIRS = new Set(['node_modules', '.next', 'dist', 'coverage', '.scratch']);

/** 递归收集源码（含测试：用例文件同样不该再引用它） */
function collectSources(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectSources(path));
    } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
      files.push(path);
    }
  }
  return files;
}

describe('SplitPane 已删除', () => {
  it('实现文件与用例文件都不在', () => {
    expect(existsSync(join(BASE_DIR, 'split-pane.tsx')), 'SplitPane 实现又回来了').toBe(false);
    expect(existsSync(join(BASE_DIR, 'split-pane.test.tsx')), 'SplitPane 用例又回来了').toBe(false);
  });

  it('包根不再转出 SplitPane / SplitPaneProps', () => {
    expect(readFileSync(join(PACKAGE_ROOT, 'src/index.ts'), 'utf8')).not.toMatch(
      /SplitPane|split-pane/,
    );
  });

  it('全仓没有任何消费者引用 SplitPane / split-pane', () => {
    const hits = collectSources(join(REPO_ROOT, 'packages'))
      .concat(collectSources(join(REPO_ROOT, 'apps')))
      .filter((file) => file !== join(BASE_DIR, 'split-pane-removed.test.ts'))
      .filter((file) => /SplitPane|split-pane/.test(readFileSync(file, 'utf8')));
    expect(hits, '还有其他文件引用 SplitPane：它不是死代码了，删之前先确认').toEqual([]);
  });
});
