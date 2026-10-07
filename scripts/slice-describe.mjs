/**
 * 把一个 describe **内部的若干条用例**切到新文件（`split-test-file.mjs` 只能按 describe 整体切，
 * 而剩下的长杆多数只有一个 describe）。
 *
 * 做法（与整体切分同一口径：前导块逐字复制、之后用 `strip-unused-imports.mjs` 摘冗余 import）：
 *   · 新文件 = 原文件的前导块（文件头 / imports / `vi.mock` / `registerXxxHooks()` 调用）
 *              + **describe 自身的头部**（`describe('…', { timeout: … }, () => {`，标题逐字保留）
 *              + describe 级前导（`it` 之前的 describe 内声明与 `beforeEach`，**复制**而不是搬走）
 *              + 被切走的那几条 `it`（连同紧邻其上的注释）
 *              + `});`
 *   · 原文件 = 去掉那几条 `it`，其余一字不动。
 *
 * 为什么 describe 级前导要复制而不是搬走：它可能被两边的用例都用到（夹具、局部 helper、
 * describe 内的 beforeEach），搬走会把留在原文件里的用例弄红。
 *
 * 用法： node scripts/slice-describe.mjs <plan.json>
 * plan: [{ "src": "…/mirror-ref.test.ts", "newFile": "…/mirror-ref-2.test.ts",
 *          "describe": 0, "tests": [0,1,2,3,4] }]
 */
import { readFileSync, writeFileSync } from 'node:fs';

const plan = JSON.parse(readFileSync(process.argv[2], 'utf8').replace(/^\uFEFF/, ''));

for (const { src, newFile, describe: describeIndex, tests } of plan) {
  const lines = readFileSync(src, 'utf8').split('\n');

  const starts = [];
  lines.forEach((line, i) => { if (/^describe\(/.test(line)) starts.push(i); });
  const start = starts[describeIndex];
  if (start === undefined) throw new Error(`${src} 没有第 ${describeIndex} 个 describe`);
  const nextStart = starts[describeIndex + 1] ?? lines.length;
  let end = start;
  while (end < nextStart && lines[end] !== '});') end += 1;
  if (end >= nextStart) throw new Error(`describe 没闭合：${src} 第 ${start + 1} 行`);

  // describe 内部：describe 级前导 + 各条 it 块（含其上紧邻的注释）
  const body = lines.slice(start + 1, end);
  const itStarts = [];
  body.forEach((line, i) => { if (/^  it\(/.test(line)) itStarts.push(i); });
  if (itStarts.length === 0) throw new Error(`describe 里没有用例：${src}`);
  const preambleEnd = itStarts[0];

  /**
   * 块的边界**不靠匹配 `  });`**：用例体里完全可能出现同样缩进的 `});`（嵌套的块、内联回调），
   * 按行尾匹配会把用例截断——实测在 `orchestrator-judge-route.test.ts` 上就切坏过一个文件。
   * 改用「相邻两个 `it(` 之间的一段」这种**分区**口径：每条用例 = 从自己的起始注释到
   * 下一条用例起始注释之前（最后一条到 describe 结尾），尾部空行归上一条、注释归下一条。
   */
  const froms = itStarts.map((itStart) => {
    let commentStart = itStart;
    while (commentStart > preambleEnd && /^\s*(\/\/|\/\*|\*)/.test(body[commentStart - 1])) commentStart -= 1;
    return commentStart;
  });
  const blocks = itStarts.map((itStart, index) => {
    const from = froms[index];
    const rawTo = index + 1 < froms.length ? froms[index + 1] - 1 : body.length - 1;
    let to = rawTo;
    while (to > itStart && body[to].trim() === '') to -= 1;
    return { from, to, itStart };
  });

  const moved = tests.map((index) => {
    const block = blocks[index];
    if (block === undefined) throw new Error(`用例下标越界：${index}`);
    return block;
  }).sort((a, b) => a.from - b.from);

  const describeHeader = lines[start];
  const describePreamble = body.slice(0, preambleEnd);
  const newBody = [
    describeHeader,
    ...describePreamble,
    ...moved.map((block) => body.slice(block.from, block.to + 1).join('\n')),
    '});',
  ];
  const movedLineRanges = moved.map((block) => [block.from, block.to]);
  const keptBody = body.filter((_, i) => !movedLineRanges.some(([from, to]) => i >= from && i <= to));

  /**
   * 新文件的前导块只能取到**第一个 describe 之前**（文件头 / imports / `vi.mock` / 注册钩子）。
   * 取成「被切的那个 describe 之前」会把排在它前面的其它 describe 整块复制过去——
   * 那些用例会在两个文件里各跑一遍（实测在 `orchestrator-judge-route.test.ts` 上多出 2 条重复用例）。
   */
  const fileHead = lines.slice(0, starts[0]).join('\n').trimEnd();
  // 新文件的文件头：把原文件头里的标题换成本次切出来的这一块（其余逐字保留）
  const newFileHead = fileHead.replace(
    /^(\/\/ @vitest-environment node\n\/\*\*\n \* )(.+?)(\n)/,
    `$1$2（切分后的第二块）$3`,
  );

  writeFileSync(newFile, `${newFileHead}\n\n${newBody.join('\n')}\n`, 'utf8');
  writeFileSync(src, [...lines.slice(0, start + 1), ...keptBody, ...lines.slice(end)].join('\n'), 'utf8');
  console.log(`${src}：把 describe[${describeIndex}] 的 ${moved.length} 条用例切到 ${newFile}（describe 级前导已复制）`);
}
console.log('下一步：pnpm typecheck → node scripts/strip-unused-imports.mjs <两个文件> → 跑它们核对用例数');
