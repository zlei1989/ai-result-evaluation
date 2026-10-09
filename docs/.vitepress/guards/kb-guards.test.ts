// @vitest-environment node
/**
 * 知识库内容守卫：只读磁盘、断言不变量，不起服务、不加载产品代码。
 * 风格仿 package-dependency-boundaries.test.ts——真源唯一（页面/文章/活文档/FAQ 清单全部
 * 来自 pages.mjs，本文件不抄第二份清单）、解析失败响亮报错，不静默通过。
 *
 * 六条守卫对应票 02 + 票 05 的验收面：
 * 1. 自含守卫——知识文章正文不得出现指向冻结档案（docs/superpowers/，ADR 0001）的链接；
 * 2. 骨架守卫——每篇文章六节齐全（④允许域内变体；目录层 index.md 豁免）；
 * 3. 标题守卫——无编号前缀、无内部代号、长度 ≤10 字（中文 1 字、英文 1 词）；
 * 4. llms.txt 同步守卫——清单与已发布页面集合一致，漏收一篇是静默漏测；
 * 5. 单一真源守卫——五份活文档在 docs 树内只此一份，没有第二份副本；
 * 6. 故障索引同步守卫——《故障索引》目录层条目与三份 FAQ 的二级标题集合逐字一致——
 *    FAQ「发现即追加」后忘了同步索引，这条守卫红（票 05）。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ARTICLE_DIRS, FAQ_DOCS, FAQ_INDEX, LIVING_DOCS, collectMarkdown, faqEntries, linkOf } from '../pages.mjs';

/** docs/ 根（本文件在 docs/.vitepress/guards/ 下） */
const docsRoot = fileURLToPath(new URL('../..', import.meta.url));

/** 递归收集目录下全部 Markdown（路径相对 docsRoot）；skipNames 跳过站点内部目录 */
function walkMd(dir: string, skipNames: string[], acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (skipNames.includes(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      walkMd(full, skipNames, acc);
      continue;
    }
    if (name.endsWith('.md')) acc.push(join(dir, name).slice(sepLen(docsRoot)));
  }
  return acc.sort();
}

/** 剥掉 docsRoot 前缀：URL 转 path 不带尾分隔符，手拼会多切/少切一位，统一在这里处理 */
function sepLen(root: string): number {
  return root.endsWith('/') ? root.length : root.length + 1;
}

/** 读文档必须真的存在：ENOENT 冒出来是守卫自身的路径 bug，不能静默吞成 undefined */
function mustRead(rel: string): string {
  return readFileSync(join(docsRoot, rel), 'utf8');
}

/** 知识文章 = ARTICLE_DIRS 目录下的 Markdown；目录不存在的先跳过（票未落地） */
const articleFiles = ARTICLE_DIRS.flatMap((dir) => {
  const full = join(docsRoot, dir);
  return existsSync(full) ? walkMd(full, []) : [];
});

if (articleFiles.length === 0) {
  throw new Error('知识文章集合为空：ARTICLE_DIRS 下一个 .md 都没收到，守卫没有对象（先落地文章）');
}

/** 目录层页（功能总览 / 故障索引）：参与自含与标题守卫，豁免骨架守卫 */
const isIndexPage = (rel: string) => rel.endsWith('index.md');

/**
 * 活文档豁免骨架守卫：五份活文档是「发现即追加」的台账（FAQ 四格条目、PowerShell 规则），
 * 结构由自己的纪律约束（AGENTS.md FAQ 节），不是六节骨架的知识文章。自含守卫照常管
 * （活文档也不许反链档案）；标题守卫豁免——FAQ 现象标题必须照抄报错原文，长度不限。
 */
const livingSet = new Set(LIVING_DOCS);
const isLivingDoc = (rel: string) => livingSet.has(rel);

/** 标题宽度：中文每字计 1，连续 ASCII 字母数字串计 1（《Codex 接入》= 3） */
function titleWidth(title: string): number {
  const cjk = (title.match(/[\u4e00-\u9fff]/g) ?? []).length;
  const words = (title.match(/[A-Za-z0-9]+/g) ?? []).length;
  return cjk + words;
}

describe('自含守卫：知识文章不反链冻结档案', () => {
  it.each(articleFiles)('%s 正文不得出现冻结档案路径', (rel) => {
    const content = mustRead(rel);
    const offending = content
      .split('\n')
      .map((line, i) => ({ line: line.trim(), no: i + 1 }))
      // 两种形态都拦：带斜杠的档案路径（superpowers/）与目录指称（docs/superpowers）
      .filter(({ line }) => /superpowers(\/|$)/.test(line));
    expect(offending, `冻结档案是提炼原料，正文不得反链（ADR 0001）；违例行：\n${offending.map((o) => `L${o.no}: ${o.line}`).join('\n')}`).toEqual([]);
  });
});

describe('骨架守卫：六节齐全', () => {
  /** 固定四节；②与④允许域内变体（协议域的 wire 形态、功能域的页面形态等） */
  const FIXED = ['## 定位', '## 数据与契约', '## 已知边界与取舍', '## 相关链接'];
  const SECOND = ['## 形态与交互', '## 页面形态与交互'];
  const FOURTH = ['## wire 形态与事件', '## 状态机与时序', '## 机制与演化'];

  it.each(articleFiles.filter((rel) => !isIndexPage(rel) && !isLivingDoc(rel)))('%s 六节齐全', (rel) => {
    const content = mustRead(rel);
    const missing = [
      ...FIXED.filter((h) => !content.includes(h)),
      ...[SECOND.some((h) => content.includes(h)) ? '' : '②形态与交互（或域内变体）'],
      ...[FOURTH.some((h) => content.includes(h)) ? '' : '④状态机/时序（或域内变体）'],
    ].filter(Boolean);
    expect(missing, `${rel} 缺节：${missing.join('、')}`).toEqual([]);
  });
});

describe('标题守卫：简洁、专业化的通俗', () => {
  it.each(articleFiles.filter((rel) => !isLivingDoc(rel)))('%s 标题合规', (rel) => {
    const firstH1 = mustRead(rel)
      .split('\n')
      .find((line) => line.startsWith('# '));
    if (!firstH1) throw new Error(`${rel} 没有一级标题：守卫解析不到就报错，不静默`);
    const title = firstH1.slice(2).trim();
    // 编号前缀与日期：标题里出现数字即违规（无例外；「三家横向对比」这类表述不需要数字）
    expect(title, `${rel} 标题含数字/编号前缀：${title}`).not.toMatch(/\d/);
    // 内部代号：kebab-case 文件名式标题（codex-appserver-refactor 这类）禁用
    expect(title, `${rel} 标题含内部代号（kebab-case）：${title}`).not.toMatch(/[A-Za-z]+-[A-Za-z]+/);
    expect(titleWidth(title), `${rel} 标题超 10 字（中文 1 字、英文 1 词）：${title}`).toBeLessThanOrEqual(10);
  });
});

describe('llms.txt 同步守卫', () => {
  it('清单与已发布页面集合一致', () => {
    const llmsPath = join(docsRoot, 'public', 'llms.txt');
    if (!existsSync(llmsPath)) {
      throw new Error('docs/public/llms.txt 不存在——先跑 `node docs/.vitepress/build-llms.mjs` 或 `pnpm docs:build`');
    }
    const entryLines = readFileSync(llmsPath, 'utf8')
      .split('\n')
      .filter((line) => line.startsWith('- ['));
    if (entryLines.length === 0) {
      throw new Error('llms.txt 里一条条目都没解析到：格式漂移必须响亮报错，不能静默空过');
    }
    const listed = new Set(entryLines.map((line) => {
      const m = line.match(/\]\(([^)]+)\):/);
      if (!m) throw new Error(`llms.txt 有解析不了的行：${line}`);
      return m[1];
    }));
    const expected = collectMarkdown(docsRoot).map(linkOf);
    const missing = expected.filter((l) => !listed.has(l));
    const extra = [...listed].filter((l) => !expected.includes(l));
    expect(missing, `llms.txt 漏收页面（漏一篇是静默漏测）：${missing.join('、')}`).toEqual([]);
    expect(extra, `llms.txt 多出不存在/已排除的页面：${extra.join('、')}`).toEqual([]);
  });
});

describe('单一真源守卫：活文档无第二份副本', () => {
  it('五份活文档各在预期位置恰一份', () => {
    // 跳过 .vitepress（守卫测试自身逐字引用活文档路径——那是「引用」不是「副本」）与 public（生成物）
    const allMd = walkMd(docsRoot, ['.vitepress', 'public']);
    const relSet = new Set(allMd);
    // 存在性：活文档被移走/改名/删除即红（收敛到域目录后，位置本身就是真源的一部分）
    const missing = LIVING_DOCS.filter((p) => !relSet.has(p));
    expect(missing, `活文档不在预期位置（被移动/删除？预期见 pages.mjs 的 LIVING_DOCS）：${missing.join('、')}`).toEqual([]);
    // 副本：同名文件出现在**知识文章目录**（faq/guard 之外活文档不该有第二个同名文件；
    // ARTICLE_DIRS 里允许撞名——如 protocols/codex.md 是合法知识文章，与 faq/codex.md 同名不同物）
    const livingNames = new Set(LIVING_DOCS.map((p) => p.split('/').pop() as string));
    const articleDirs = new Set(ARTICLE_DIRS);
    const offenders = allMd.filter((rel) => {
      const base = rel.split('/').pop() as string;
      if (!livingNames.has(base)) return false;
      const top = rel.split('/')[0] as string;
      return !articleDirs.has(top);
    });
    expect(offenders, `活文档域名出现在预期域之外（单一真源被破坏）：\n${offenders.join('\n')}`).toEqual([]);
  });

  it('仓内其余位置也不得出现活文档副本（spec：单一真源是全仓口径）', () => {
    /**
     * 扫描范围：docs 树之外的全仓 Markdown（packages/apps 的 README 与文档）。
     * 检测方式：按文件名分组（LIVING_DOCS 五个名字），docs 树里已由上一条守卫
     * 保证「各恰一份」，故这里任何同名文件都是副本。
     */
    const repoRoot = join(docsRoot, '..');
    const offenders: string[] = [];
    // 点开头目录跳过 + 容忍条目消失（TOCTOU）：与断链守卫的 scan 同一口径，理由见那边的注释
    const scan = (dir: string, skip: string[]) => {
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch {
        return;
      }
      for (const name of names) {
        if (skip.includes(name) || name.startsWith('.')) continue;
        const full = join(dir, name);
        let st;
        try {
          st = statSync(full);
        } catch {
          continue;
        }
        if (st.isDirectory()) {
          scan(full, skip);
          continue;
        }
        if (LIVING_DOCS.includes(name)) offenders.push(full);
      }
    };
    scan(join(repoRoot, 'packages'), ['node_modules']);
    scan(join(repoRoot, 'apps'), ['node_modules', '.next']);
    expect(offenders, `packages/apps 下出现活文档副本（单一真源被破坏）：\n${offenders.join('\n')}`).toEqual([]);
  });
});

describe('断链守卫：冻结档案退役门禁（票 21）', () => {
  it('全仓（除档案自身与票据）对 docs/superpowers 的引用计数为 0', () => {
    /** 仓库根：docs/ 的上一级 */
    const repoRoot = join(docsRoot, '..');
    /**
     * 扫描范围：源码与配置（packages/ apps/ scripts/ + docs/ + 根配置/说明文件）。
     * 排除：docs/superpowers/（档案自身）、docs/.vitepress（守卫与构建缓存）、docs/public
     * （生成物）、docs/adr（ADR 文本允许提档案史）、docs/agents（tracker 配置）、
     * node_modules、.next；.scratch 不在 docs 下且票据允许留取材索引（P2 后随关账回写
     * 纪律自然退役，本守卫不扫它）。
     */
    const targets: Array<{ dir: string; skip: string[] }> = [
      { dir: join(repoRoot, 'packages'), skip: ['node_modules'] },
      { dir: join(repoRoot, 'apps'), skip: ['node_modules', '.next'] },
      { dir: join(repoRoot, 'scripts'), skip: [] },
      { dir: docsRoot, skip: ['superpowers', '.vitepress', 'public', 'adr', 'agents'] },
    ];
    /**
     * 根级显式清单（非递归目录之外的散文件）：仓库说明与全部工具链配置——配置文件
     * 里的档案路径引用同样是死链，没有理由豁免；新增根级配置时往这里补一行。
     */
    const rootFiles = [
      'AGENTS.md', 'README.md', 'GLOSSARY.md', 'eslint.shared.ts', 'eslint.config.ts',
      'package.json', 'vitest.config.ts', 'vitest.node.ts', 'vitest.jsdom.ts',
      'pnpm-workspace.yaml', '.gitignore', 'tsconfig.base.json', 'tsconfig.typecheck.json',
    ];
    const offenders: string[] = [];
    /**
     * 目录扫描的两条健壮性规则（活文档副本守卫与断链守卫共用）：
     * 1. 点开头目录一律跳过——它们全是工具产物（.git / .next / .chrome-profile / .pnpm-store），
     *    仓库的真实文档不以点开头；冒烟浏览器 profile 里有几十万个瞬时文件，扫它纯噪声；
     * 2. 条目消失要容忍（TOCTOU）：readdir 与 stat 之间任何文件都可能被并行进程删掉
     *    （实测撞过 .chrome-profile/RunningChromeVersion），守卫红必须是「发现违规」
     *    而不是「撞上竞态」——ENOENT 只跳过该条目。
     */
    const scan = (dir: string, skip: string[]) => {
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch {
        return;
      }
      for (const name of names) {
        if (skip.includes(name) || name.startsWith('.')) continue;
        const full = join(dir, name);
        let st;
        try {
          st = statSync(full);
        } catch {
          continue;
        }
        if (st.isDirectory()) {
          scan(full, skip);
          continue;
        }
        if (!/\.(ts|tsx|mts|mjs|md|json|yaml|yml|ps1)$/.test(name)) continue;
        if (readFileSync(full, 'utf8').includes('docs/superpowers')) offenders.push(full);
      }
    };
    for (const t of targets) scan(t.dir, t.skip);
    for (const name of rootFiles) {
      const f = join(repoRoot, name);
      if (existsSync(f) && readFileSync(f, 'utf8').includes('docs/superpowers')) offenders.push(f);
    }
    expect(offenders, `仍有文件引用冻结档案（ADR 0001：档案已退役，引用即死链）：\n${offenders.join('\n')}`).toEqual([]);
  });

  it('档案目录不得重建（ADR 0001：形态已终结，「此后不再新增」是机械判据）', () => {
    // 目录存在即红——不论内容；重建者需要先改 ADR，而不是悄悄把档案放回来
    expect(
      existsSync(join(docsRoot, 'superpowers')),
      'docs/superpowers 已重建：ADR 0001 终结了过程档案形态，不再新增——需要过程记录时按「关账回写」进知识文章',
    ).toBe(false);
  });
});

describe('故障索引同步守卫：目录层与三份 FAQ 的现象标题集合一致', () => {
  /**
   * 解析《故障索引》的条目区：`### <厂商>` 分组，其下 ` - [标题](锚点)` 每行一条。
   * 标题可含成对 `]`（报错原文照抄），故按最后一个 `](` 切分，不用正则整体匹配。
   */
  function parseIndexEntries(content: string): Map<string, { title: string; anchor: string }[]> {
    const sections = new Map<string, { title: string; anchor: string }[]>();
    let vendor = '';
    for (const raw of content.split('\n')) {
      const line = raw.trimEnd();
      // 遇到二级标题（维护口径 / 相关链接等）条目区即结束：后面 `- [xxx](链接)` 形态的行
      // 不是现象条目，归进当前分组会误报（首个变异即撞上——守卫自己的解析口径也要过验证）
      if (line.startsWith('## ')) {
        vendor = '';
        continue;
      }
      if (line.startsWith('### ')) {
        vendor = line.slice(4).trim();
        if (sections.has(vendor)) throw new Error(`《故障索引》里厂商分组重复：${vendor}`);
        sections.set(vendor, []);
        continue;
      }
      if (vendor && line.startsWith('- [')) {
        const open = line.lastIndexOf('](');
        if (open === -1 || !line.endsWith(')')) {
          throw new Error(`《故障索引》条目解析不了（要「- [标题](锚点)」形态）：${line}`);
        }
        (sections.get(vendor) as { title: string; anchor: string }[]).push({
          title: line.slice(3, open),
          anchor: line.slice(open + 2, -1),
        });
      }
    }
    return sections;
  }

  it('docs/faq/ 的厂商 FAQ 全部登记在 FAQ_DOCS（多出一家没登记，索引会静默缺一组）', () => {
    const faqDir = join(docsRoot, 'faq');
    // faq 目录下的厂商 FAQ：排除 index.md（目录层《故障索引》本身）
    const faqFilesOnDisk = readdirSync(faqDir).filter((n) => n.endsWith('.md') && n !== 'index.md').sort();
    const registered = FAQ_DOCS.map((f) => f.file.split('/').pop() as string).sort();
    expect(faqFilesOnDisk, 'docs/faq/ 的厂商 FAQ 与 FAQ_DOCS 清单不一致：新增厂商 FAQ 必须同步登记（pages.mjs）').toEqual(registered);
  });

  it('每家厂商的条目与 FAQ 二级标题集合逐字一致（少一条/多一条/改写一条都红）', () => {
    if (!existsSync(join(docsRoot, FAQ_INDEX))) {
      throw new Error(`《故障索引》目录层（${FAQ_INDEX}）不存在：票 05 未落地`);
    }
    const sections = parseIndexEntries(mustRead(FAQ_INDEX));
    const missingVendors = FAQ_DOCS.map((f) => f.vendor).filter((v) => !sections.has(v));
    if (missingVendors.length > 0) {
      throw new Error(`《故障索引》缺厂商分组：${missingVendors.join('、')}`);
    }
    const extraVendors = [...sections.keys()].filter((v) => !FAQ_DOCS.some((f) => f.vendor === v));
    expect(extraVendors, `《故障索引》出现 FAQ_DOCS 之外的分组（厂商清单漂移或分组名改写）：${extraVendors.join('、')}`).toEqual([]);
    for (const faq of FAQ_DOCS) {
      const expected = faqEntries(docsRoot, faq);
      const actual = sections.get(faq.vendor);
      if (!actual) throw new Error(`《故障索引》的 ${faq.vendor} 分组缺失`);
      if (actual.length === 0) {
        throw new Error(`《故障索引》的 ${faq.vendor} 分组一条条目都没解析到：索引静默清空，先修页面或更新解析`);
      }
      expect(
        actual,
        `${faq.vendor} 分组与 ${faq.file} 的现象标题集合不一致——FAQ「发现即追加」后必须同步《故障索引》（AGENTS.md 关账回写纪律）`,
      ).toEqual(expected);
    }
  });
});
