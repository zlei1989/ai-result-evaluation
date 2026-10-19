// @vitest-environment node
/**
 * 命名尺寸与密度间距的**冲突守卫**。
 *
 * 缺口长什么样：`@theme inline` 里曾用 `--spacing-xs / sm / md` 命名密度间距，而 Tailwind 的
 * `max-w-<name>` 会优先吃同名间距键。于是 `max-w-sm` 编译成 `max-width: var(--density-space-sm)`
 * （紧凑档 8px）：命令面板、确认框、toast、tooltip、空态全部塌成一条竖缝——宽度只剩 padding，
 * 内容一字一行。构建期不报错、单测全绿，只有真机上看得见。
 *
 * 两条判据：
 *   1. **密度间距键不许占用尺寸命名空间**（`xs` / `sm` / `md` / `lg` / …），这条是根因；
 *   2. 源码里每个 `max-w-<命名尺寸>` 都要有对应的 `--container-<同名>`，且值不能引回密度间距。
 * 扫源码文本而不是渲染：这条要拦的正是「以后再加一处 `max-w-lg` 却没人补 token」。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = join(import.meta.dirname, '..', '..', '..');
const CSS_PATH = join(repoRoot, 'apps', 'web-next', 'app', 'globals.css');
const SCAN_ROOTS = [join(repoRoot, 'packages', 'client', 'ui', 'src'), join(repoRoot, 'apps', 'web-next', 'app')];
const SKIP_DIRS = new Set(['node_modules', '.next', 'dist', 'coverage']);

/** 会落到 Tailwind 命名尺寸上的键（`max-w-full` / `max-w-none` / `max-w-[…]` 不受影响，故不列） */
const NAMED_SIZE_KEYS = ['2xs', 'xs', 'sm', 'md', 'lg', 'xl', '2xl', '3xl', '4xl', '5xl', '6xl', '7xl'] as const;

function collect(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      files.push(...collect(path));
    } else if (entry.name.endsWith('.tsx') || entry.name.endsWith('.ts')) {
      files.push(path);
    }
  }
  return files;
}

/** 去掉注释：说明文字里写 `max-w-sm` 不该被当成真实用法 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

const css = readFileSync(CSS_PATH, 'utf8');

/** `globals.css` 里声明的 `--container-*`（键 → 原始值） */
const declaredContainers = new Map<string, string>();
for (const match of css.matchAll(/--container-([a-z0-9]+)\s*:\s*([^;]+);/g)) {
  declaredContainers.set(match[1] as string, (match[2] as string).trim());
}

/** 源码里真实用到的 `max-w-<命名尺寸>`（含 `sm:` / `data-[…]:` 前缀写法） */
const used = new Map<string, string[]>();
for (const path of SCAN_ROOTS.flatMap(collect)) {
  const text = stripComments(readFileSync(path, 'utf8'));
  for (const key of NAMED_SIZE_KEYS) {
    // 前缀后紧跟 `max-w-<key>`；`max-w-[…]` 与 `max-w-full` 不会命中
    const pattern = new RegExp(`(?:^|[\\s:"'\`])max-w-${key}(?![a-z0-9-])`, 'g');
    if (pattern.test(text)) {
      const rel = path.slice(repoRoot.length + 1);
      used.set(key, [...(used.get(key) ?? []), rel]);
    }
  }
}

describe('max-w-<命名尺寸> 必须解析到 --container-*，不能落到密度间距', () => {
  it('密度间距键不许占用尺寸命名空间（根因）', () => {
    const spacingKeys = [...css.matchAll(/--spacing-([a-z0-9]+)\s*:/g)].map((match) => match[1] as string);
    const offenders = spacingKeys.filter((key) => (NAMED_SIZE_KEYS as readonly string[]).includes(key));
    expect(
      offenders,
      '密度间距不能叫 xs / sm / md 一类尺寸词：max-w-* 会优先吃它，浮层与空态会塌成竖缝',
    ).toEqual([]);
  });

  it('源码里用到的每个命名尺寸都在 globals.css 里有对应 --container-<key>', () => {
    // 这条断言先确认扫描本身没失效（源码里确实有 max-w-sm / max-w-xs 的用法）
    expect(used.size, '扫描没有命中任何 max-w-<命名尺寸>，守卫已失效').toBeGreaterThan(0);
    const missing = [...used.entries()].filter(([key]) => !declaredContainers.has(key));
    expect(
      missing.map(([key, files]) => `--container-${key}（用于 ${[...new Set(files)].join(', ')}）`),
      '缺少容器尺寸 token：这些 max-w-* 会退回 --spacing-* / --density-space-*，浮层与空态会塌成竖缝',
    ).toEqual([]);
  });

  it('--container-* 是字面量或独立变量，不能回头引用密度间距', () => {
    const tainted = [...declaredContainers.entries()]
      .filter(([, value]) => /var\(--(spacing|density)/.test(value))
      .map(([key, value]) => `--container-${key}: ${value}`);
    expect(tainted, '容器尺寸引用了密度间距 ⇒ max-w-* 再次被密度档劫持').toEqual([]);
  });
});
