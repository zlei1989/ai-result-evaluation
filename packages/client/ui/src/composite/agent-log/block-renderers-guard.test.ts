// @vitest-environment node
/**
 * 工具块渲染器的**换栈纪律**（静态扫描，读本目录的源文件）。
 *
 * 两条靶子：
 *  (1) **这四支不再 import antd**。它们已经换成 vendored 的 `Trace` / `CodeBlock` / `Button` / `Badge`，
 *      而「顺手再加一个 antd 组件」不会有任何运行时症状——页面上只是多一套字号与间距。
 *      扫描面是**点名清单**而不是整个目录：子任务 / 思考 / 任务卡片归另一张票，整目录扫描会把
 *      「别处还没换」误报成「这处换错了」。
 *  (2) **`TraceLine.status` 不许写死 `running`**：它必须从 `block.assembly` 与结果状态派生
 *      （`traceStatusOf`）。写死一处就是第二个「流式中」真源——收到快照后 shimmer 停不下来，
 *      而所有行为用例都可能照样绿（它们渲染的是 `assembly === 'open'` 的那一档）。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const dir = import.meta.dirname;

/** 本次换栈的四支：工具行、工具组、原始输出、失败帧列表 */
const MIGRATED_FILES = [
  'tool-item-detail.tsx',
  'tool-group-panel.tsx',
  'raw-output-panel.tsx',
  'stack-trace-view.tsx',
  'test-results-view.tsx',
] as const;

/** 去掉注释之后再判：注释里解释「为什么不用 antd」是说明文字，不是依赖 */
function codeOf(file: string): string {
  return readFileSync(join(dir, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ');
}

describe('工具块渲染器的换栈纪律', () => {
  it('四支都不 import antd / @ant-design', () => {
    const hits: string[] = [];
    for (const file of MIGRATED_FILES) {
      for (const [index, line] of codeOf(file).split('\n').entries()) {
        if (/from\s+'(?:antd|@ant-design\/[^']+)'/.test(line)) hits.push(`${file}:${index + 1}: ${line.trim()}`);
      }
    }
    expect(hits, '工具块渲染器又引回了 antd；它们已经换成 vendored 的 Trace / CodeBlock').toEqual([]);
  });

  it('`TraceLine.status` 从 `block.assembly` 派生，不写死 running', () => {
    // 工具行：交给 `traceStatusOf`（assembly + 结果状态）一处推
    expect(codeOf('tool-item-detail.tsx'), '工具行没有从 traceStatusOf 取状态').toContain('traceStatusOf(entry)');
    // 工具组：组头没有自己的块，状态从**各条目**的 assembly 汇总（任一条还在收 ⇒ running）
    expect(codeOf('tool-group-panel.tsx'), '组头没有按各条目的 assembly 推状态').toContain('assembly === \'open\'');
    for (const file of ['tool-item-detail.tsx', 'tool-group-panel.tsx'] as const) {
      expect(codeOf(file), `${file} 把 status 写死成 running ⇒ 收到快照后 shimmer 停不下来`).not.toMatch(
        /<TraceLine[^>]*\sstatus="running"/,
      );
    }
  });
});
