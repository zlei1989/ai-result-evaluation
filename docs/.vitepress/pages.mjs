/**
 * 知识库页面清单的唯一真源：站点配置（srcExclude）、llms.txt 生成器（build-llms.mjs）
 * 与内容守卫（guards/kb-guards.test.ts）三方共用的纯 JS 数据与函数模块。
 *
 * 为什么用 .mjs：本文件要被 node 直接 import（生成器在 `docs:build` 里跑），不能是 TS；
 * 而 VitePress 的 config.mts 与 vitest 的守卫测试都能 import .mjs，三方遂共用同一份。
 * 谁想改页面集合的口径（排除名单、文章目录、活文档名单），只改这里——改完三方同时生效，
 * 漂移会在同步守卫上红。
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * 不生成站点页面的目录（glob 形态「前缀/**」）：
 * - `superpowers/**` 冻结档案：提炼知识文章的临时原料，不编入站点（ADR 0001）；
 * - `.vitepress/**` 站点配置与守卫测试；`adr/**`、`agents/**` 决策与 tracker 配置文件；
 * - `public/**` 是静态资源目录（llms.txt 等），VitePress 不当页面扫，llms 清单同样不收。
 */
export const SRC_EXCLUDES = ['superpowers/**', '.vitepress/**', 'adr/**', 'agents/**', 'public/**'];

/**
 * 知识文章目录：骨架 / 标题 / 自含守卫的作用域（目录内 index.md 是目录层页，骨架守卫豁免，
 * 自含与标题守卫照常——目录层也是知识页）。
 */
export const ARTICLE_DIRS = ['protocols', 'features', 'architecture', 'guard', 'faq'];

/** 活文档（原文编入、持续追加）：单一真源守卫确保仓内没有第二份副本。收敛到域目录后的相对路径 */
export const LIVING_DOCS = [
  'faq/codex.md',
  'faq/claude-code.md',
  'faq/deepseek-harness.md',
  'guard/powershell.md',
  'guard/playwright-mcp.md',
];

/**
 * 三份厂商 FAQ——《故障索引》目录层（FAQ_INDEX）的数据源：
 * 文件名、厂商标签、站内链接（锚点链接的前缀）。按 AGENTS.md「发现即追加」的规矩，
 * FAQ 会持续长条目；守卫按二级标题解析条目，索引不同步即红。
 * 新增第四家厂商 FAQ 时同步此清单（docs/faq/ 多出的文件若不在名单里，守卫会红）。
 */
export const FAQ_DOCS = [
  { file: 'faq/codex.md', vendor: 'Codex', link: '/faq/codex' },
  { file: 'faq/claude-code.md', vendor: 'Claude Code', link: '/faq/claude-code' },
  { file: 'faq/deepseek-harness.md', vendor: 'DeepSeek Harness', link: '/faq/deepseek-harness' },
];

/** 《故障索引》目录层页：收录三份 FAQ 的全部现象条目，只做标题 + 锚点链接（方案层单一真源在 FAQ 原文） */
export const FAQ_INDEX = 'faq/index.md';

/** 把「前缀/**」glob 编译成相对路径匹配函数；未预期形态直接抛错，不静默放过 */
export function excludeMatcher(glob) {
  const prefix = glob.replace(/\/\*\*$/, '');
  if (prefix === glob) throw new Error(`未预期的排除 glob 形态：${glob}（只支持「前缀/**」）`);
  return (rel) => rel === prefix || rel.startsWith(`${prefix}/`);
}

/** 递归收集 docs/ 下全部 Markdown（相对路径，`/` 分隔）；SRC_EXCLUDES 在此生效 */
export function collectMarkdown(docsRoot, acc = []) {
  const matchers = SRC_EXCLUDES.map(excludeMatcher);
  /** 内层递归：docsRoot 固定作 relative 的根，walk 只换被扫目录——两者不能共用一个参数 */
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!name.endsWith('.md')) continue;
      const rel = relative(docsRoot, full);
      if (matchers.some((m) => m(rel))) continue;
      acc.push(rel);
    }
  };
  walk(docsRoot);
  return acc.sort();
}

/** 页面文件 → 站点链接：根 index 是 /，目录 index 归约为目录路径，其余剥 .md（cleanUrls） */
export function linkOf(rel) {
  if (rel === 'index.md') return '/';
  const noExt = rel.replace(/\.md$/, '');
  if (noExt.endsWith('/index')) return `/${noExt.slice(0, -'/index'.length)}/`;
  return `/${noExt}`;
}

/** 取正文第一个一级标题与第一句描述（llms.txt 的一行摘要；缺标题回退文件名） */
export function titleAndDescOf(docsRoot, rel) {
  const lines = readFileSync(join(docsRoot, rel), 'utf8').split('\n');
  let title = '';
  let desc = '';
  for (const line of lines) {
    if (title === '' && line.startsWith('# ')) title = line.slice(2).trim();
    else if (desc === '' && line.trim() !== '' && !line.startsWith('#')) desc = line.trim();
    if (title !== '' && desc !== '') break;
  }
  if (title === '') title = rel.replace(/\.md$/, '');
  // 描述截到首个句号；仍超长（80 字）再硬截——llms.txt 每页一行，一句话为限
  const firstSentence = desc.split('。')[0] ?? desc;
  const capped = firstSentence.length > 80 ? `${firstSentence.slice(0, 80)}…` : firstSentence;
  return { title, desc: firstSentence.endsWith('。') ? firstSentence : `${capped}。` };
}

/**
 * 收集一份 FAQ 的全部现象条目：文档里的每个 `## ` 二级标题就是一条（AGENTS.md FAQ 格式第 1 格）。
 * 返回原文标题与《故障索引》要用的锚点链接。
 *
 * 两个响亮报错口径（票 05：解析失败不静默通过）：
 * - 解析不到任何条目即抛错——FAQ 若不再以二级标题组织条目，目录层会静默清空；
 * - fenced code block 内的 `## ` 行不算条目——VitePress 不给 fence 内文本生成 heading
 *   锚点，若当条目收进索引，产出的是指向不存在锚点的死链，而 docs:build 的死链检查
 *   只验页面不验 fragment，拦不住这种错。判定与 markdown-it 的 fence 规则对齐（行首
 *   ≤3 空格的 ``` 或 ~~~ 开/闭 fence；本仓 FAQ 全用无缩进 ```）。
 */
export function faqEntries(docsRoot, faq) {
  const lines = readFileSync(join(docsRoot, faq.file), 'utf8').split('\n');
  const headings = [];
  let inFence = false;
  for (const line of lines) {
    if (/^ {0,3}(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (!inFence && line.startsWith('## ')) headings.push(line.slice(3).trim());
  }
  if (headings.length === 0) {
    throw new Error(`${faq.file} 解析不到任何「## 」现象条目：FAQ 条目以二级标题组织，没有条目意味着索引层会静默清空，先修文档或更新 FAQ_DOCS`);
  }
  return headings.map((title) => ({ title, anchor: `${faq.link}#${vitepressSlug(inlineTextOf(title))}` }));
}

/** 行内文本剥回纯文本：先脱行内代码的壳（内容原样保留），再剥强调/链接/转义（对应 getTokensText 只收 text + code_inline） */
function inlineTextOf(raw) {
  let out = '';
  let last = 0;
  const spans = [...raw.matchAll(/(`+)([\s\S]*?)\1/g)];
  for (const m of spans) {
    out += plainTextOf(raw.slice(last, m.index)) + m[2];
    last = m.index + m[0].length;
  }
  return (out + plainTextOf(raw.slice(last))).trim();
}

/** 非代码段的行内标记剥壳：反斜杠转义、粗体/斜体、链接文字（现象标题可能出现这些写法） */
function plainTextOf(text) {
  return text
    .replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
}

/**
 * 复算 VitePress（v1.6.4 markdown-it-anchor）的 heading id 锚点。锚点链接只验「页面存在」
 * 不验 fragment，写错了 docs:build 不拦（本仓 ignoreDeadLinks: false 也只覆盖页面级），
 * 所以《故障索引》的每条锚点必须与构建产物逐字一致——本函数是这条判据的机制层实现，
 * 18/18 个既有 FAQ 锚点已对照构建产物实证一致。别自行简化特殊字符折叠逻辑。
 */
function vitepressSlug(str) {
  return str
    .normalize('NFKD')
    .replace(/[\u0300-\u036F]/g, '')
    .replace(/[\u0000-\u001f]/g, '')
    .replace(/[\s~`!@#$%^&*()\-_+=[\]{}|\\;:"'“”‘’<>,.?/]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/^(\d)/, '_$1')
    .toLowerCase();
}
