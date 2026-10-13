// @vitest-environment node
/**
 * **全仓不得留下冲突标记**。
 *
 * 为什么需要它：一次合并把 `<<<<<<< HEAD` / `>>>>>>> ` / `=======` 三类标记**提交进了集成分支**，
 * 而它落在 JSDoc 里 ⇒ `pnpm typecheck` 与 `pnpm lint` **都看不见**（两者都不解析注释内容），
 * 于是文档里并排留着两份**互相矛盾**的判据描述，没人会红。这类"能编译、能过 lint、但内容自相矛盾"
 * 的腐烂比编译错误更坏：后来的人会照着其中一份去理解行为。
 *
 * 判据取**行首**的两种标记（`<<<<<<< ` 与 `>>>>>>> `）：这两串在任何合法内容里都不会出现在行首
 * ——`=======` 刻意**不判**，因为 Markdown 的 setext 标题下划线就是它（判了会误伤 `.md`）。
 * 两种标记只要出现一种就够判：一次冲突必然同时留下两侧。
 *
 * 扫描面是**本仓自己的源码与文档**（`packages/`、`apps/`、`docs/`、`scripts/` 与根级 ts/md），
 * 跳过 `node_modules` / `.git` / `.worktrees` / `.next` / 各类缓存与产物目录、以及取值目录 `.scratch/`
 * （后者 gitignore，不随 clone 走，里面的标记不影响任何人）。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..', '..', '..');

/** 要扫的顶层条目（本仓自己拥有的源码与文档） */
const SCAN_ROOTS = ['packages', 'apps', 'docs', 'scripts', 'AGENTS.md', 'GLOSSARY.md', 'README.md', 'eslint.shared.ts', 'eslint.config.ts', 'vitest.config.ts', 'tsconfig.typecheck.json'];

/** 不进的目录：依赖、版本库、工作位、构建产物、缓存、取值目录 */
const SKIP_DIRS = new Set(['node_modules', '.git', '.worktrees', '.next', '.pnpm-store', '.turbo', 'dist', 'coverage', 'dumps', '.scratch', '.research', '.playwright-mcp', '.vscode']);

/** 只看这些扩展名：二进制与图片不必读进来 */
const TEXT_EXT = /\.(ts|tsx|mts|mjs|js|jsx|cjs|json|md|css|yml|yaml|py|ps1|sh|txt)$/;

const MARKER = /^(<{7} |>{7} )/;

/** 递归收集要扫的文件（绝对路径） */
function collect(target: string, into: string[]): void {
  let stat;
  try {
    stat = statSync(target);
  } catch {
    return; // 顶层条目可能不存在（不同 worktree 的组成不同），静默跳过
  }
  if (stat.isFile()) {
    if (TEXT_EXT.test(target)) into.push(target);
    return;
  }
  for (const entry of readdirSync(target)) {
    if (SKIP_DIRS.has(entry)) continue;
    collect(join(target, entry), into);
  }
}

describe('全仓不得留下冲突标记', () => {
  it('没有一行以 `<<<<<<< ` 或 `>>>>>>> ` 开头', () => {
    const files: string[] = [];
    for (const entry of SCAN_ROOTS) collect(join(root, entry), files);
    // 扫到的文件数为 0 说明扫描面本身坏了（路径写错），那时这条守卫是假绿
    expect(files.length, '一个文件都没扫到 ⇒ 扫描面配置错了，这条守卫是假绿').toBeGreaterThan(200);

    const offenders: string[] = [];
    for (const file of files) {
      let content: string;
      try {
        content = readFileSync(file, 'utf8');
      } catch {
        continue; // 读不动就跳过：它不会是被提交进 git 的那一份
      }
      if (!content.includes('<<<<<<<') && !content.includes('>>>>>>>')) continue;
      const hit = content.split('\n').findIndex((line) => MARKER.test(line));
      if (hit >= 0) offenders.push(`${file.slice(root.length + 1)}:${hit + 1}`);
    }

    expect(offenders, '合并冲突的标记被提交进来了——它能在注释里躲过 tsc 与 eslint，必须手工收口').toEqual([]);
  });
});
