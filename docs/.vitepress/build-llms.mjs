/**
 * llms.txt 生成器：`docs:build` 的收尾步骤。
 *
 * 产出 `docs/public/llms.txt`（VitePress 把 public/ 复制到站点根，HTTP 侧即 /llms.txt；
 * 仓内 AI 直接 grep 同一文件）。页面集合、排除名单、文章目录全部取自 pages.mjs——
 * 那是三方共用的唯一真源；两边若漂移，同步守卫（guards/kb-guards.test.ts）会红。
 *
 * 格式：每页一行 `- [标题](/路径): 一句话描述`，行按路径排序，产物确定性可 diff。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectMarkdown, linkOf, titleAndDescOf } from './pages.mjs';

const docsRoot = fileURLToPath(new URL('..', import.meta.url));
const outPath = join(docsRoot, 'public', 'llms.txt');

const pages = collectMarkdown(docsRoot);
if (pages.length === 0) {
  throw new Error('页面集合为空：docs/ 下没收到任何 Markdown，拒绝生成空 llms.txt');
}

const body = [
  '# ai-result-evaluation 知识库',
  '',
  '> AI 生成代码评测平台的知识库：协议规范、功能说明、架构设计、FAQ 与规约守卫',
  '',
  ...pages.map((rel) => {
    const { title, desc } = titleAndDescOf(docsRoot, rel);
    return `- [${title}](${linkOf(rel)}): ${desc}`;
  }),
  '',
].join('\n');

mkdirSync(join(docsRoot, 'public'), { recursive: true });
writeFileSync(outPath, body, 'utf8');
console.log(`llms.txt: ${pages.length} 页 → ${outPath}`);
