// @vitest-environment node
/**
 * 抽屉体系的依赖纪律（静态）：
 *
 *   1. **几何与两套壳不 import antd**——抽屉的壳是 Base UI `Sheet`，宽度只走 CSS 变量；
 *      antd 只允许留在「内容视图」里（环境信息那几个展示件），不许再回到抽屉壳上。
 *   2. **环境信息不再是 antd `Drawer`**：它的壳是 `NestedDrawer`，二级层的让位
 *      由 Base UI 的 `--nested-dialogs` 计数驱动（见 `base/drawer-geometry.ts` 与全局样式）。
 *
 * 扫描面是一张**点名的清单**：`agent-log/` 里的块渲染器、环境信息的正文展示件不在本体系内
 * （它们由别的票换栈），整目录扫描会把「别处还没换」误报成「这处换错了」。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const uiRoot = join(import.meta.dirname, '..');

/** 抽屉体系：几何常量 + 主抽屉壳 + 二级抽屉壳 */
const SHELL_FILES = [
  'base/drawer-geometry.ts',
  'base/nested-drawer.tsx',
  'composite/run-detail-drawer.tsx',
  'composite/agent-log/agent-log-drawer.tsx',
] as const;

const ENVIRONMENT_DRAWER = 'composite/agent-log/agent-environment-drawer.tsx';

/** 去掉注释后再匹配：注释里解释「为什么不 import antd」不算违规 */
function codeOf(relativePath: string): string {
  return readFileSync(join(uiRoot, relativePath), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ');
}

describe('抽屉体系不依赖 antd', () => {
  it('几何、主抽屉壳、二级抽屉壳里没有任何 antd / @ant-design 说明符', () => {
    const hits: string[] = [];
    for (const file of SHELL_FILES) {
      for (const [index, line] of codeOf(file).split('\n').entries()) {
        if (/from\s+'(?:antd|@ant-design\/[^']+)'/.test(line)) {
          hits.push(`${file}:${index + 1}: ${line.trim()}`);
        }
      }
    }
    expect(hits, '抽屉壳里又出现了 antd：壳必须是 Base UI Sheet，宽度走 CSS 变量').toEqual([]);
  });

  it('环境信息整件不碰 antd：壳是 `NestedDrawer`', () => {
    const source = codeOf(ENVIRONMENT_DRAWER);
    expect(source, '环境信息又把 antd 请回来了').not.toMatch(/from\s+'antd'/);
    expect(source, '环境信息的壳不是 NestedDrawer').toContain('<NestedDrawer');
  });
});
