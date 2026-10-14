// @vitest-environment node
/**
 * X 壳的尺寸纪律：壳里不出现**手写**的字号 / 行高 / 内边距，一律走 antd 的 token。
 *
 * 为什么靶子设在壳、而不是把 X 组件加进 `composite/agent-log/agent-log-size-sweep.test.ts` 那张
 * 「开标签必须带 `size="small"`」的表：X 组件没有 `size` 能力（`SenderProps` 连 `size` 都没有，
 * 官方 FAQ 的 `<Sender size="small" />` 是文档错误），写上去就是一个在本仓查不到东西的靶子。
 * 紧凑密度在本仓由 antd 的紧凑算法与 seed token 统一推导，壳里任何一处手写尺寸都会把那一格
 * 从推导链上摘下来（紧凑算法会覆盖并反向推导，实效字号掉到 10px）。故这一路只判一件事：
 * **壳的可执行源码里没有手写的尺寸声明**。
 *
 * **已知边界：量出来的那一半不在这里。** jsdom 没有 CSS 级联，量不到渲染后的字号与行高
 * （与 `MonoText` 的等宽字体同一条边界）⇒「紧凑密度下 X 壳的实际行高不超标」只在**真机冒烟**里量。
 *
 * 扫描面**自我定义**：`base/` 里引了 X 的渲染件就是一个壳，新增壳不必回来登记——
 * 这也正是「`base/` 独占 X 导入」那条 lint 纪律（`eslint.shared.ts` 的
 * `FORBIDDEN_DIR_EXEMPTIONS`）给的保证：X 的导入只可能出现在这一层。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** 本目录（X 壳都住这一层） */
const dir = import.meta.dirname;

/**
 * 去注释之后再匹配。
 *
 * 为什么必须去：壳的文件头就是成篇在讲 X 的（「`@ant-design/x` 的导入只允许出现在 `base/`」），
 * 而「这个文件是不是壳」的判据正是「源码里有没有 X 的说明符」。不去注释的话，一句说明里的
 * 引号就会把非壳文件拉进扫描面，而壳自己的说明里写「不许手写 `padding`」也会被判成手写尺寸。
 * 误伤比漏放更危险（守卫一旦显得碍事就会被绕过），故只对**可执行源码**判。
 *
 * **已知局限（如实登记，与 `composite/agent-log/agent-log-layering.test.ts` 同一条）**：正则不区分
 * 字符串字面量里的 `//`，含 `://` 的行会被从那里截断 ⇒ **同一行注释后面的代码看不见**。
 * 方向是漏报而不是误报，且本仓没有那种形态。
 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

/** 源码里的一行可执行文本（行号从 1 起） */
function codeLinesOf(file: string): { line: number; text: string }[] {
  return stripComments(readFileSync(join(dir, file), 'utf8'))
    .split('\n')
    .map((text, index) => ({ line: index + 1, text }));
}

/** X 壳：`base/` 里引了 X 的渲染件（`*.test.*` 是测试，不是壳） */
const X_SHELLS = readdirSync(dir)
  .filter((name) => name.endsWith('.tsx') && !name.endsWith('.test.tsx'))
  .filter((name) =>
    codeLinesOf(name).some(({ text }) => /['"]@ant-design\/x(?:-markdown)?(?:\/[^'"]*)?['"]/.test(text)),
  )
  .sort();

/**
 * 手写的尺寸声明：**键 + 字面量数值**（`padding: 8` / `paddingInline: '8px'` / `fontSize: 14`）。
 * 对象键与 CSS 文本两种写法都算，PascalCase（`fontSize` / `paddingInlineStart`）与
 * kebab-case（`font-size` / `padding-block`）都认，带引号的键也认。
 *
 * **判据刻意停在「值是不是字面量」上，不拦「键 + token 表达式」**（`paddingInline: token.padding`）：
 * 后者正是这条纪律要的写法——把尺寸交回 antd 的推导链，键名本身无害。只认「键 + 冒号」的老判据
 * 会把它一起拦下，于是壳里想复刻某块 X 默认样式的间距时**只能手写数值**，与这条纪律的目的正好相反。
 * `fontSizeToken` 这种标识符与自由文本里的同名词仍不在此列（`\b` 与冒号共同界定）。
 */
const HANDWRITTEN_SIZE =
  /\b(?:fontSize|lineHeight|padding[A-Za-z]*)\b\s*:\s*['"`]?[\d.]+(?:px|em|rem|%|vh|vw)?['"`]?|["']?(?:font-size|line-height|padding(?:-[a-z]+)*)["']?\s*:\s*['"`]?[\d.]+(?:px|em|rem|%|vh|vw)?['"`]?/;

/** 扫描面上每一处手写尺寸：`文件:行号: 原文`（空数组 = 干净） */
function handwrittenSizes(): string[] {
  const hits: string[] = [];
  for (const file of X_SHELLS) {
    for (const { line, text } of codeLinesOf(file)) {
      if (HANDWRITTEN_SIZE.test(text)) hits.push(`${file}:${line}: ${text.trim()}`);
    }
  }
  return hits;
}

describe('X 壳的尺寸纪律：不手写字号 / 行高 / 内边距', () => {
  it('扫描面非空：手上的壳都被认得出来', () => {
    // 没有这一条时，判壳的那条正则写错（少个连字符、只认 `from` 不认 `import(`）会让下面那条
    // **全绿地空转**。改名或改导入写法时这条会红，那就是回来看判据的时候。
    expect(X_SHELLS).toContain('x-markdown.tsx');
    expect(X_SHELLS).toContain('x-think.tsx');
  });

  it('壳里没有手写的尺寸声明（字号 / 行高 / 内边距走 antd token）', () => {
    expect(handwrittenSizes()).toEqual([]);
  });
});
