/**
 * 把一个「长杆测试文件」按 describe 拆成「共享 harness + N 个测试文件」。
 *
 * 为什么需要它：vitest 按**文件**并行、文件内**顺序**执行，所以墙钟由最长的那个文件决定
 * （实测：`orchestrator.test.ts` 一个文件占过全量 2437s 里的 2426s）。同一套配方已在
 * `orchestrator` / `cases` / `mirror` / `cases-remote` 上跑过四轮，逐数核对用例总数不变。
 *
 * 用法： node scripts/split-test-file.mjs <plan.json> [--dry]
 *
 * plan.json（**describe 用下标而不是标题**：标题里有中文，走命令行容易被编码往返写坏）：
 * {
 *   "src": "packages/server/core/src/git.repo.test.ts",
 *   "harness": "packages/server/core/src/testing/git-repo-harness.ts",   // 注意 .ts 后缀
 *   "harnessRel": "./testing/git-repo-harness",
 *   "hooksName": "registerGitRepoHooks",
 *   "headerNote": "……（会写进每个新文件的文件头）",
 *   "groups": [["git-repo-basic.test.ts", [0, 1, 2]], ["git-repo-cache.test.ts", [3, 4]]]
 * }
 *
 * 三条硬约束（都是 vitest 的机制，不是风格偏好）：
 *   1. `vi.mock(...)` 必须留在**每个测试文件自身**里（前置提升只作用于本文件）⇒ 脚本把原文件的
 *      mock 块原样复制进每个新文件的前导块；
 *   2. 公共钩子（beforeAll/beforeEach/afterEach/afterAll）包成 `registerXxxHooks()`，
 *      由各文件在自己的 suite 上显式注册；
 *   3. 每个文件只 import 它真正用到的符号——脚本按标识符扫描生成 import 列表
 *      （`unused-imports` 规则生效，多写一个就红）。跑完请再执行一次
 *      `pnpm eslint <新文件...>`，把 harness 里「只被再导出、自己不用」的名字摘掉。
 *
 * 两个已知坑（实测踩过）：
 *   · **顶层孤例**：不在任何 describe 里的 `it(...)` 会被留在 harness 里跑不到——脚本会**拒绝**
 *     这种情况（见下方检查），请手工把它搬进某个 describe 再拆；
 *   · harness 搬进子目录后相对路径要上跳一级（`./cases` → `../cases`），脚本会提示但不代改。
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const plan = JSON.parse(readFileSync(process.argv[2], 'utf8').replace(/^\uFEFF/, ''));
const dry = process.argv.includes('--dry');
const { src, harness, harnessRel, hooksName, headerNote, groups } = plan;

const raw = readFileSync(src, 'utf8');
const lines = raw.split(/\r?\n/);

const blocks = [];
for (let i = 0; i < lines.length; i += 1) {
  if (!/^describe\(/.test(lines[i])) continue;
  let end = -1;
  for (let j = i + 1; j < lines.length; j += 1) if (lines[j] === '});') { end = j; break; }
  if (end < 0) throw new Error(`describe 没闭合：第 ${i + 1} 行`);
  blocks.push({ start: i, end });
}

const isCommentish = (line) => line.trim() === '' || /^\s*(\/\/|\/\*|\*|\*\/)/.test(line);
const gaps = [];
let cursor = 0;
for (const block of blocks) { gaps.push({ start: cursor, end: block.start - 1 }); cursor = block.end + 1; }
gaps.push({ start: cursor, end: lines.length - 1 });

const attached = new Map();
const harnessLines = [];
gaps.forEach((gap, gapIndex) => {
  let stop = gap.end;
  if (gapIndex < blocks.length) {
    let runStart = gap.end;
    while (runStart >= gap.start && isCommentish(lines[runStart])) runStart -= 1;
    const runLines = lines.slice(runStart + 1, gap.end + 1);
    const lastNonBlank = [...runLines].reverse().find((line) => line.trim() !== '');
    if (lastNonBlank !== undefined && /^\s*(\/\/|\/\*|\*)/.test(lastNonBlank)) {
      attached.set(gapIndex, runLines);
      stop = runStart;
    }
  }
  for (let i = gap.start; i <= stop; i += 1) harnessLines.push(lines[i]);
});

// 顶层孤例（不在 describe 里的 it/describe 之外的用例）会让拆分静默漏测
for (let i = 0; i < harnessLines.length; i += 1) {
  if (/^it\(/.test(harnessLines[i])) {
    throw new Error(`第 ${i + 1} 行附近有一条**不在 describe 里**的用例；先把它包进某个 describe 再拆`);
  }
}

const mockBlocks = [];
const withoutMocks = [];
for (let i = 0; i < harnessLines.length; i += 1) {
  if (/^vi\.mock\(/.test(harnessLines[i])) {
    const start = i;
    while (i < harnessLines.length && harnessLines[i] !== '});') i += 1;
    mockBlocks.push(harnessLines.slice(start, i + 1).join('\n'));
    continue;
  }
  withoutMocks.push(harnessLines[i]);
}

const hooks = [];
const withoutHooks = [];
for (let i = 0; i < withoutMocks.length; i += 1) {
  if (/^(beforeAll|beforeEach|afterEach|afterAll)\(/.test(withoutMocks[i])) {
    const start = i;
    while (i < withoutMocks.length && withoutMocks[i] !== '});') i += 1;
    hooks.push(withoutMocks.slice(start, i + 1).join('\n'));
    continue;
  }
  withoutHooks.push(withoutMocks[i]);
}

const exported = new Map();
const harnessOut = withoutHooks.map((line) => {
  const decl = /^(const|let|function|async function|class) (\w+)/.exec(line);
  if (decl) { exported.set(decl[2], 'value'); return `export ${line}`; }
  const typeDecl = /^(interface|type) (\w+)/.exec(line);
  if (typeDecl) { exported.set(typeDecl[2], 'type'); return `export ${line}`; }
  return line;
});

const importStmts = [];
for (let i = 0; i < lines.length; i += 1) {
  if (!/^import /.test(lines[i])) continue;
  let text = lines[i];
  let j = i;
  while (!/;\s*$/.test(text) && j + 1 < lines.length) { j += 1; text += `\n${lines[j]}`; }
  const spec = /from '([^']+)';/.exec(text)?.[1];
  if (spec === undefined || spec === 'vitest') { i = j; continue; }
  const typeOnly = /^import type \{/.test(text);
  const brace = /\{([\s\S]*)\}/.exec(text)?.[1] ?? '';
  const names = brace.split(',').map((p) => p.trim()).filter((p) => p !== '').map((p) => ({
    name: p.replace(/^type\s+/, ''),
    kind: typeOnly || /^type\s+/.test(p) ? 'type' : 'value',
  }));
  for (const { name, kind } of names) exported.set(name, kind);
  if (names.length > 0) importStmts.push({ spec, names });
  i = j;
}
const reexports = importStmts.map(({ spec, names }) => {
  const values = names.filter((n) => n.kind === 'value').map((n) => n.name);
  const types = names.filter((n) => n.kind === 'type').map((n) => n.name);
  const parts = [];
  if (values.length > 0) parts.push(`export { ${values.join(', ')} } from '${spec}';`);
  if (types.length > 0) parts.push(`export type { ${types.join(', ')} } from '${spec}';`);
  return parts.join('\n');
}).filter((t) => t !== '');

const indent = (chunk) => chunk.split('\n').map((line) => (line === '' ? line : `  ${line}`)).join('\n');
const harnessText = [
  harnessOut.join('\n'),
  '/**',
  ` * 注册本文件集的公共钩子（${hooks.length} 个）。`,
  ' * 为什么做成函数：harness 被多个测试文件共享，钩子必须注册在**调用它的那个文件**的 suite 上。',
  ' */',
  `export function ${hooksName}(): void {`,
  ...hooks.map((h) => indent(h)),
  '}',
  ...reexports,
].join('\n').replace(/\n{3,}/g, '\n\n');

const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const plans = groups.map(([outName, indexes]) => {
  const body = indexes.map((index) => {
    const block = blocks[index];
    if (block === undefined) throw new Error(`describe 下标越界：${index}`);
    return [...(attached.get(index) ?? []), ...lines.slice(block.start, block.end + 1)].join('\n');
  }).join('\n\n');
  const scannable = stripComments(body);
  const used = [...exported.entries()].filter(([name]) => new RegExp(`\\b${name}\\b`).test(scannable));
  const firstLine = lines[blocks[indexes[0]].start];
  const firstTitle = /^describe\('([^']+)'/.exec(firstLine)?.[1] ?? outName;
  return { outName, body, used, firstTitle };
});

if (dry) {
  console.log(`harness ${harnessText.split('\n').length} 行 / mock 块 ${mockBlocks.length} / 钩子 ${hooks.length}`);
  for (const p of plans) console.log(`  ${p.outName}: ${p.body.split('\n').length} 行, import ${p.used.length} 个`);
  process.exit(0);
}

mkdirSync(dirname(harness), { recursive: true });
const vitestNames = ['describe', 'expect', 'it', 'beforeEach', 'afterEach', 'vi'];
for (const p of plans) {
  const values = p.used.filter(([, k]) => k === 'value').map(([n]) => n);
  const types = p.used.filter(([, k]) => k === 'type').map(([n]) => n);
  const bindings = [...values, ...types.map((n) => `type ${n}`), hooksName];
  const vitest = ['vi', ...vitestNames.filter((n) => n !== 'vi' && new RegExp(`\\b${n}\\b`).test(stripComments(p.body)))];
  writeFileSync(join(dirname(src), p.outName), [
    '// @vitest-environment node',
    '/**',
    ` * ${p.firstTitle}`,
    ' *',
    ` * ${headerNote}`,
    ' */',
    `import { ${vitest.join(', ')} } from 'vitest';`,
    `import {\n  ${bindings.join(',\n  ')},\n} from '${harnessRel}';`,
    '',
    mockBlocks.join('\n\n'),
    '',
    `${hooksName}();`,
    '',
    p.body,
    '',
  ].join('\n'), 'utf8');
}
writeFileSync(harness, harnessText, 'utf8');
rmSync(src);
console.log(`已写出 ${plans.length} 个测试文件 + ${harness}；原文件已删除`);
console.log('下一步：pnpm typecheck → pnpm eslint <新文件...>（摘掉 harness 未使用的 import）→ 跑这些文件核对用例数');
