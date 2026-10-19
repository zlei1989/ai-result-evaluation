// @vitest-environment node
/**
 * 子任务 / 思考 / 任务 / 分隔这一批的**换栈纪律**（静态扫描，读本目录的源文件）。
 *
 * 两条靶子：
 *  (1) **这六支不再 import antd**。它们已经换成 vendored 的 `Trace` / `Badge` / `Button` / `Marker`，
 *      而「顺手再加一个 antd 组件」不会有任何运行时症状——页面上只是多一套字号与间距。
 *      扫描面是**点名清单**而不是整个目录（整个目录里还有问答卡片等未换的件，
 *      整目录扫描会把「别处还没换」误报成「这处换错了」）。
 *  (2) **状态不许写死 `running`**：`TraceLine.status` 必须从块自己的 `assembly`（思考、任务）
 *      或节点状态（子任务）派生。写死一处就是第二个「流式中」真源——收到快照后 shimmer 停不下来，
 *      而所有行为用例都可能照样绿（它们渲染的常常是 `assembly === 'open'` 的那一档）。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const dir = import.meta.dirname;

/** 本批换栈的六支：子任务条、思考块、任务清单、段分隔、运行状态、正文块 */
const MIGRATED_FILES = [
  'subagent-bar.tsx',
  'thinking-block-view.tsx',
  'task-panel-card.tsx',
  'segment-divider.tsx',
  'agent-run-state-tag.tsx',
  'text-block-view.tsx',
] as const;

/** 去掉注释之后再判：注释里解释「为什么不用 antd」是说明文字，不是依赖 */
function codeOf(file: string): string {
  return readFileSync(join(dir, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ');
}

describe('子任务 / 思考 / 任务 / 分隔的换栈纪律', () => {
  it('六支都不 import antd / @ant-design', () => {
    const hits: string[] = [];
    for (const file of MIGRATED_FILES) {
      for (const [index, line] of codeOf(file).split('\n').entries()) {
        if (/from\s+'(?:antd|@ant-design\/[^']+)'/.test(line)) hits.push(`${file}:${index + 1}: ${line.trim()}`);
      }
    }
    expect(hits, '这一批又引回了 antd；它们已经换成 vendored 的 Trace / Badge / Button / Marker').toEqual([]);
  });

  it('`TraceLine.status` 从块的状态派生，不写死 running', () => {
    // 思考块 / 任务清单：判据都是块自己的 `assembly` 与 `panel.running`
    expect(codeOf('thinking-block-view.tsx'), '思考块的 status 没有从 assembly 推').toContain(
      'block.assembly === \'open\'',
    );
    expect(codeOf('task-panel-card.tsx'), '任务清单的 status 没有从 panel.running 推').toContain(
      'panel.running ? \'running\'',
    );
    for (const file of MIGRATED_FILES) {
      expect(codeOf(file), `${file} 把 status 写死成 running ⇒ 收到快照后 shimmer 停不下来`).not.toMatch(
        /<TraceLine[^>]*\sstatus="running"/,
      );
    }
  });

  it('子任务条的根是 Trace（不是 Card），开合受控', () => {
    const source = codeOf('subagent-bar.tsx');
    expect(source, '子任务条退回 Card ⇒ 高度又变回一整张卡').not.toContain('<Card');
    expect(source).toContain('<Trace');
    // 开合由调用方给：不出现 `defaultOpen`（那是组件自己持态的另一种写法）
    expect(source, '子任务条自己持开合态 ⇒ 与 useAgentLogView 的两份状态会打架').not.toContain('defaultOpen');
  });
});
