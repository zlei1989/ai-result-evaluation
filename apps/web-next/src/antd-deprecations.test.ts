// @vitest-environment node
/**
 * **antd 6 的废弃 props 不许再用**（本仓的界面全走 antd，废弃面只在控制台说一句）。
 *
 * 为什么需要这一条：废弃 props **运行期仍然生效**（antd 内部是 `title ?? message` 这类回落），
 * 所以行为用例、`pnpm lint`、`pnpm typecheck` 全绿，唯一的信号是浏览器控制台里那句
 * `Warning: [antd: Alert] \`message\` is deprecated. Please use \`title\` instead.`——
 * 而它只在开发构建里出现，谁也不会天天盯着控制台。真机症状就是这么来的：
 * `app/runs/page.tsx` 报了一句指向 `<RunDetailPanel>` 的告警，而**真正那一处**
 * 在 `ui` 包的 `run-detail-panel.tsx` 里（组件的调用栈把位置指向了父组件）。
 *
 * 判据：按**组件名**配一小张废弃 props 表，逐文件扫 JSX 开标签体（配平 `{}` 后取到 `>`），
 * 命中即红。表只收「antd 6 迁移文档里点名废弃、且本仓可能写出来」的那几条；
 * 新增一条的成本是一行，判错的风险是**误报**，故不搞正则泛扫（`message` / `onClose`
 * 这类名字在别的组件上是完全合法的）。
 *
 * 依赖方向：本文件只读源码文本，不 import 任何包（与 `package-dependency-boundaries.test.ts` 同一条理由）。
 */
import { globSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** 仓库根：本文件在 `apps/web-next/src/` 下 */
const repoRoot = join(import.meta.dirname, '..', '..', '..');

/**
 * 组件 → 已废弃的 props（`旧名 → 新名` 只为报错信息里能直接说怎么改）。
 *
 * 取值来源：antd 的 v6 迁移文档（`docs/react/migration-v6`）与组件源码里的
 * `devUseWarning` 表。**只收本仓用得上的组件**：把整张迁移表抄进来会让这条守卫里出现一堆
 * 与界面无关的条目，而它与代码一起腐烂。
 */
const DEPRECATED: Record<string, Record<string, string>> = {
  Alert: {
    message: 'title',
    closeText: 'closable.closeIcon',
    closeIcon: 'closable.closeIcon',
    onClose: 'closable.onClose',
    afterClose: 'closable.afterClose',
  },
};

/** 扫描面：两个界面包 + web-next 的 app 目录（产品代码；测试与夹具不在面上） */
const SCANNED_GLOBS = [
  'packages/client/ui/**/*.tsx',
  'packages/client/client/**/*.tsx',
  'apps/web-next/app/**/*.tsx',
] as const;

/**
 * 一个文件里所有 `<Component …>` 的开标签体（`{` / `}` 配平后才认 `>`，
 * 否则 `onClose={() => x}` 里的 `>` 会把标签体截断在半路——那正是本扫描最容易漏的地方）。
 */
function openTagBodies(source: string, component: string): { body: string; line: number }[] {
  const found: { body: string; line: number }[] = [];
  const opener = new RegExp(`<${component}(?![\\w.])`, 'g');
  for (const match of source.matchAll(opener)) {
    const start = (match.index ?? 0) + match[0].length;
    let depth = 0;
    for (let cursor = start; cursor < source.length; cursor += 1) {
      const char = source[cursor];
      if (char === '{') depth += 1;
      else if (char === '}') depth -= 1;
      else if (char === '>' && depth === 0) {
        found.push({ body: source.slice(start, cursor), line: source.slice(0, start).split('\n').length });
        break;
      }
    }
  }
  return found;
}

describe('antd 6 的废弃 props', () => {
  it('产品代码里一条都不用（用组件源码里的新名）', () => {
    const files = SCANNED_GLOBS.flatMap((pattern) => globSync(pattern, { cwd: repoRoot }));
    // 扫描面为空 = 守卫静默失效（换目录、改扩展名都会这样）：零命中必须先确认扫到了东西
    expect(files.length, '一个 .tsx 都没扫到：扫描面的 glob 写错了').toBeGreaterThan(50);

    const violations: string[] = [];
    for (const file of files) {
      const source = readFileSync(join(repoRoot, file), 'utf8');
      for (const [component, props] of Object.entries(DEPRECATED)) {
        for (const { body, line } of openTagBodies(source, component)) {
          for (const [deprecated, replacement] of Object.entries(props)) {
            // 具名属性（不吃 `foo.message=`、也不吃字符串里的同名字样）
            if (new RegExp(`(?<![\\w.$])${deprecated}\\s*=`).test(body)) {
              violations.push(`${file}:${line} <${component} ${deprecated}=…> ⇒ 请用 ${replacement}`);
            }
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
