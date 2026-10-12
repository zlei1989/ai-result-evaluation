// @vitest-environment node
/**
 * **业务无关性守卫**：`@aieval/agents` 不知道评测领域，只认「一次运行 / 消息 / 事件 / 工具 / 权限 / 用量」
 * 这类通用概念（口径见 `README.md` 的对应小节与 `docs/architecture/layering.md`）。
 *
 * 为什么需要一条机械判据：这条边界以前只活在注释里——适配层悄悄替产品说话（「请检查用例的评分标准项」）、
 * 或在运行时字符串里写死设置页路由，谁都不会红；而代价是**这个包换一处复用就说不通**，
 * 且「加第四家 = 加一个目录 + 注册表一行」这句承诺会慢慢变成假话。
 *
 * 两条判据（都是「可观测事实」，不是风格偏好）：
 *   1. **运行时用户可见字符串**（字符串字面量与模板字面量）里不许出现评测领域词；
 *   2. **不许值导入** contracts 的业务域契约（评分 / 评分表 / 用例 / 设置 / 运行）；
 *      `import type` **允许**——类型在编译期就被抹掉，不构成运行时依赖（与 AGENTS.md 的
 *      「类型转出不算依赖边」同一条口径）。
 *
 * 三条边界（刻意如此）：
 *   · **注释不管**：注释是文档，扫描器管不住它，硬管只会逼出一堆白名单；
 *   · **测试文件不管**（`*.test.ts`）：夹具里出现业务形状（评分 JSON 的形状）是不可避免的；
 *   · 判据用 TypeScript 的 AST 而不是正则：正则分不清「字符串里的词」与「注释里的词」，
 *     而这条守卫的全部意义正在于**只**管前者。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * 运行时字符串里命中即违规的领域词。
 * 选词判据：**它只对评测业务成立**，换成任何别的调用方都说不通。
 * 刻意**不收**「用例」：本仓的注释与测试名里它到处指「测试用例」，收进来会把噪声当违规；
 * 真要在字符串里写「用例」的适配器文案，通常同时含有「评分」或「考题」（都在这张表里）。
 */
const BANNED_TERMS: readonly string[] = [
  '评分', // 评分 / 评分标准项 / 评分智能体
  '考题',
  '候选',
  '评审',
  '评测',
  'rubric',
  'scoring',
];

/**
 * 命中即违规的 contracts 导出**名字**（值导入时判）。
 * 为什么按名字而不是按模块路径：本包一律从 `@aieval/contracts` 桶导入，说明符里看不出那份契约属于哪个域。
 * 选词判据：这些名字只可能来自业务域文件（`score` / `rubric` / `testcase` / `settings` / `run`）。
 * 通用契约（`AGENT_KINDS` / `PROTOCOL_LABELS` / `EFFORT_OFF` / `McpServers` …）刻意不匹配。
 */
const BUSINESS_IMPORT_PATTERN = /(Rubric|Score|Judge|TestCase|SETTINGS_)/;

/** 包内全部**非测试**源码（相对 `src`，分隔符统一成正斜杠） */
function sourceFiles(): string[] {
  return readdirSync(import.meta.dirname, { recursive: true })
    .map((entry) => String(entry).replace(/\\/g, '/'))
    .filter((entry) => /\.(?:ts|mts|cts|js|mjs|cjs)$/.test(entry) && !entry.endsWith('.test.ts'));
}

/** 一条违规：文件名 + 位置 + 说明（红的时候要能直接指出改哪儿） */
interface Violation {
  file: string;
  detail: string;
}

/** 把 AST 里所有**字符串载荷**收出来：字符串字面量、无插值模板，以及模板的 head/middle/tail 三段 */
function stringLiteralsOf(source: ts.SourceFile): string[] {
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node)) {
      out.push(node.text);
    } else if (ts.isTemplateExpression(node)) {
      out.push(node.head.text, ...node.templateSpans.map((span) => span.literal.text));
    } else if (ts.isNoSubstitutionTemplateLiteral(node)) {
      out.push(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

/** 扫一段源码：字符串里的领域词 + contracts 的业务域值导入 */
function violationsOf(file: string, text: string): Violation[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const out: Violation[] = [];
  for (const literal of stringLiteralsOf(source)) {
    for (const term of BANNED_TERMS) {
      if (literal.includes(term)) {
        out.push({ file, detail: `运行时字符串里出现领域词「${term}」：${JSON.stringify(literal.slice(0, 60))}` });
      }
    }
  }
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (statement.moduleSpecifier.text !== '@aieval/contracts') continue;
    // `import type { … }` 在编译期被抹掉，不构成运行时依赖 ⇒ 放行
    if (statement.importClause?.isTypeOnly === true) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings === undefined || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      if (element.isTypeOnly) continue;
      const name = element.propertyName?.text ?? element.name.text;
      if (BUSINESS_IMPORT_PATTERN.test(name)) {
        out.push({ file, detail: `值导入了业务域契约「${name}」（要它的类型请用 import type）` });
      }
    }
  }
  return out;
}

describe('业务无关性：运行时字符串不许出现领域词', () => {
  it('字符串字面量里命中领域词 ⇒ 违规；只出现在注释里 ⇒ 不算', () => {
    // 正例（违规）：字面量、无插值模板、模板片段三条路都要拦得住
    expect(violationsOf('a.ts', 'const x = \'请检查用例的评分标准项\';')).toHaveLength(1);
    expect(violationsOf('a.ts', 'const x = `本次评测得 3 分`;')).toHaveLength(1);
    expect(violationsOf('a.ts', 'const x = `前缀${y}这道考题`;')).toHaveLength(1);
    expect(violationsOf('a.ts', 'const x = \'rubric missing\';')).toHaveLength(1);
    // 反例（不算违规）：注释里的同一个词、与业务无关的字符串
    expect(violationsOf('a.ts', '// 这里是评分通路的注释\nconst x = \'ok\';')).toHaveLength(0);
    expect(violationsOf('a.ts', '/* 评分 */ const x = \'ok\';')).toHaveLength(0);
    expect(violationsOf('a.ts', 'const x = \'上游限流：稍后重试\';')).toHaveLength(0);
  });

  it('包内非测试源码一条都不许命中（命中就改文案，不要往词表里加白名单）', () => {
    const violations = sourceFiles().flatMap((file) =>
      violationsOf(file, readFileSync(join(import.meta.dirname, file), 'utf8')),
    );
    expect(violations.map((one) => `${one.file}：${one.detail}`)).toEqual([]);
  });
});

describe('业务无关性：不许值导入业务域契约', () => {
  it('值导入评分契约 ⇒ 违规；import type 同名的类型 ⇒ 放行', () => {
    expect(
      violationsOf('a.ts', 'import { ScoreResultSchema } from \'@aieval/contracts\';'),
    ).toHaveLength(1);
    expect(violationsOf('a.ts', 'import { renderRubricForJudge } from \'@aieval/contracts\';')).toHaveLength(1);
    expect(violationsOf('a.ts', 'import type { ScoreResult } from \'@aieval/contracts\';')).toHaveLength(0);
    expect(
      violationsOf('a.ts', 'import { type ScoreResult, AGENT_KINDS } from \'@aieval/contracts\';'),
    ).toHaveLength(0);
    // 通用契约照旧随便导（这条守卫只拦业务域那一批）
    expect(violationsOf('a.ts', 'import { AGENT_KINDS, EFFORT_OFF, PROTOCOL_LABELS } from \'@aieval/contracts\';'))
      .toHaveLength(0);
    // 别的包不受这条守卫管
    expect(violationsOf('a.ts', 'import { ScoreResultSchema } from \'@aieval/evaluator\';')).toHaveLength(0);
  });

  it('包内非测试源码只导入通用契约', () => {
    const violations = sourceFiles().flatMap((file) =>
      violationsOf(file, readFileSync(join(import.meta.dirname, file), 'utf8')),
    );
    expect(violations).toEqual([]);
  });
});
