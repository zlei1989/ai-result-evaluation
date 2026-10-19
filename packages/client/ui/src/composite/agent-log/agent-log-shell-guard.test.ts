// @vitest-environment node
/**
 * 执行日志**外壳**的静态守卫：外壳里不许再出现 antd，抽屉宽度只许走 CSS 变量。
 *
 * 为什么扫描面是一张**点名的清单**而不是整个 `agent-log/` 目录：本目录里还有块渲染器
 * （工具卡片、正文块、子任务条……）与环境抽屉，它们的换栈不在本壳的范围内；整目录扫描会把
 * 「别处还没换」误报成「这处换错了」。清单里的文件就是外壳的六个渲染/接线件。
 *
 * 两条判据分开放：`from 'antd'` / `from '@ant-design/*'` 抓的是依赖，而抽屉宽度那一格抓的是
 * 「把几何写回组件」——宽度值必须来自 CSS 变量，组件里不许再出现 `max(61vw, …)` 这类字面量。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const dir = import.meta.dirname;

/** 外壳的扫描面：抽屉、布局、滚动区、轮次容器、工具条动作、两个 L0 展示件 */
const SHELL_FILES = [
  'agent-log-drawer.tsx',
  'agent-log-layout.tsx',
  'log-scroller.tsx',
  'virtual-turn-list.tsx',
  'agent-log-toolbar-preset.ts',
  'segment-divider.tsx',
  'row-summary-line.tsx',
] as const;

/** 去掉注释之后再匹配：注释里解释「为什么不 import antd」不算违规 */
function codeOf(file: string): string {
  return readFileSync(join(dir, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ');
}

describe('agent-log 外壳的依赖纪律', () => {
  it('外壳不 import antd：六个文件都不出现 antd / @ant-design 说明符', () => {
    const hits: string[] = [];
    for (const file of SHELL_FILES) {
      for (const [index, line] of codeOf(file).split('\n').entries()) {
        if (/from\s+'(?:antd|@ant-design\/[^']+)'/.test(line)) {
          hits.push(`${file}:${index + 1}: ${line.trim()}`);
        }
      }
    }
    expect(hits, '外壳里还有 antd 引用；块渲染器的 antd 不在本条扫描面上').toEqual([]);
  });

  it('抽屉宽度走共享几何：组件里没有宽度表达式字面量', () => {
    const source = codeOf('agent-log-drawer.tsx');
    // 宽度只能引用共享常量（数值本身写在应用全局样式的 CSS 变量里，只定义一次）
    expect(source).toContain('style={MAIN_DRAWER_STYLE}');
    // 反例：`max(61vw, 800px)` 这类几何表达式，或把像素值直接塞进 width，一旦写回组件
    // 就是第二个真源（`max-w-[100vw]` 是窄屏兜底，不是宽度来源，不算）
    expect(source).not.toMatch(/(?:max|min)\(\d+vw/);
    expect(source).not.toMatch(/\bwidth:\s*'?\d+(?:\.\d+)?(?:px|rem)/);
  });
});
