// @vitest-environment node
/**
 * 分层纪律的**可执行形式**（§9.0）。它是静态扫描而不是渲染断言：用 `fs` 读本目录的源文件、
 * 按层查 import 说明符与几个关键词。理由——层塌掉之后既有的行为守卫**可能全绿**
 * （L0 偷偷 import 了 L2 的折叠态，组件还是画得出来），只有专门的一条守卫能拦住。
 *
 * 六条各有一个靶子（都能被单独变异掉）：
 *   (a) L0 不 import L1/L2；(b) L1 不 import L2；
 *   (c) **虚拟化的三个入口**（`virtual` / `itemHeight` / `from 'antd/listy'`）只出现在 `virtual-turn-list.tsx`；
 *   (d) L0/L1 不出现 `useState`（开合态一律受控，§9.0 纪律 2）；
 *   (e) L0/L1 不出现 `EvalRow`，**也不按厂商分支**；
 *   (f) `BlockRenderContext` 里没有 `streaming` 这一格（`assembly` 是动效的唯一判据）。
 *
 * **为什么 (e) 的判据写得比「不许出现 `agentKind` 字样」窄**（这条是刻意收窄，不是放宽）：
 * 守卫的靶子是「**UI 判厂商**」——按厂商分支、或把厂商字面量写进组件。而
 * `AgentEnvironmentSummary.agentKind` 是数据层给的**展示字段**，设计 §6.8 的摘要七项里
 * 明确要求把它画出来；字面禁止 `agentKind` 会把一个必须显示的字段挡在门外，那正是
 * 「守卫比它守的东西更宽」的误伤（本仓对误伤的态度是明确的：误伤会让守卫显得碍事从而被绕过，
 * 比不放行更危险）。故下面只拦**分支/查表/厂商字面量**三种形态，
 * 「把字段当字符串渲染」必须放行——最后一条用例专门钉这个区分力。
 *
 * 不扫的方向：`types.ts`（类型层）、`build-model.ts`（模型装配）、`fixtures.ts`（夹具）与全部
 * `*.test.*` 不在三层清单里——它们不渲染，任何层都可以 import 它们。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const dir = import.meta.dirname;

/** L2 场景预设：**唯一可以持有虚拟滚动与视图态的一层** */
const L2_FILES = [
  'agent-log-drawer.tsx',
  'agent-log-layout.tsx',
  'virtual-turn-list.tsx',
  'agent-log-toolbar-preset.ts',
  'use-agent-log-view.ts',
] as const;

/** L1 受控组合件：吃「一轮」或一份派生数据，吐界面；不虚拟化、不持态 */
const L1_FILES = ['agent-message-timeline.tsx', 'log-node-breadcrumb.tsx', 'agent-log-facts-bar.tsx'] as const;

/** L0 纯渲染件：吃「一个块 / 一个节点 / 一份声明」，一律受控 */
const L0_FILES = [
  'text-block-view.tsx',
  'thinking-block-view.tsx',
  'tool-group-panel.tsx',
  'tool-item-detail.tsx',
  'attachment-block-view.tsx',
  'unrecognized-block-view.tsx',
  'subagent-bar.tsx',
  'row-summary-line.tsx',
  'task-panel-card.tsx',
  'ask-user-card.tsx',
  'agent-run-state-tag.tsx',
  'capability-notes.tsx',
  'raw-output-panel.tsx',
  'agent-environment-drawer.tsx',
  'block-renderer-registry.tsx',
  'render-blocks.ts',
] as const;

/** 文件 → 层（找不到的文件视为「不在三层清单里」，不参与扫描） */
const LAYER_OF = new Map<string, 'L0' | 'L1' | 'L2'>([
  ...L0_FILES.map((file) => [file, 'L0'] as const),
  ...L1_FILES.map((file) => [file, 'L1'] as const),
  ...L2_FILES.map((file) => [file, 'L2'] as const),
]);

/**
 * **不在三层清单里、但参与「不判厂商」扫描**的文件（2026-10-04 新增）。
 *
 * `build-model.ts` 是**模型装配**件：它不渲染，所以依赖方向 / `useState` / 虚拟化那四条
 * （(a)–(d)）与它无关；但它**决定哪些块会被画成卡片**——「UI 判厂商」这件事在它身上
 * 与在渲染件身上一样致命，而它此前正是**唯一**在做厂商形状嗅探的地方
 * （读 `input.todos` / `input.questions`，实测：同一个厂商分支写进本文件时 (e) 全绿）。
 *
 * 收口之后那些嗅探已经下沉到 agents 的 `tool-payload.ts`，本条把这个文件纳入 (e) 的扫描面，
 * 让「把嗅探搬回来」这种回归当场变红。
 */
const NON_RENDER_SCANNED_FILES = ['build-model.ts'] as const;

/** (e) 的扫描面：三层里的文件 + 上面那几个不在层里但要扫的文件 */
const VENDOR_SCANNED_FILES: readonly string[] = [...L0_FILES, ...L1_FILES, ...NON_RENDER_SCANNED_FILES];

/** 每层的「上面那几层」：往上看就是违规 */
const UPPER_LAYERS: Record<'L0' | 'L1' | 'L2', readonly ('L0' | 'L1' | 'L2')[]> = {
  L0: ['L1', 'L2'],
  L1: ['L2'],
  L2: [],
};

function sourceOf(file: string): string {
  return readFileSync(join(dir, file), 'utf8');
}

/** 源码里所有**相对** import 的目标文件名（`./x` / `./x.tsx` → `x.tsx`） */
function relativeImportTargets(source: string): string[] {
  const targets: string[] = [];
  const pattern = /from\s+'(\.[^']+)'/g;
  for (const matched of source.matchAll(pattern)) {
    const specifier = matched[1];
    if (specifier === undefined) continue;
    const base = specifier.replace(/^\.\//, '');
    // 说明符通常不带扩展名（本仓直出 TS 源码），两种写法都要认
    targets.push(base.includes('.') ? base : `${base}.ts`, base.includes('.') ? base : `${base}.tsx`);
  }
  return targets;
}

/**
 * 去注释之后再匹配（2026-10-04）。
 *
 * 为什么必须去：本目录的注释里**成篇在讲这三家**（「codex 的正文只在会话文件里」
 * 「这不是评测行那个业务概念」），而判据里的关键词正是这些词。不去注释的话，
 * 一句解释性的中文就会把守卫判红——实测两次：`raw-output-panel.tsx` 的文档注释里提到
 * `useState`（规则 d）、`build-model.ts` 的注释里提到「不是评测行」（规则 e 的 `EvalRow`）。
 * 误伤比漏放更危险（守卫一旦显得碍事就会被绕过），所以这里只对**可执行源码**判。
 *
 * **已知局限（如实登记，与 `agents/src/static-assertions.test.ts` 同一条）**：正则不区分
 * 字符串字面量里的 `//`，含 `://` 的行会被从那里截断 ⇒ **同一行注释后面的代码看不见**。
 * 方向是漏报而不是误报，且本仓没有那种形态（判据都是单行正则，跨行写法本身也不在射程内）。
 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

/** 去掉注释之后的行（`hitsIn` 的输入） */
function codeLinesOf(file: string): { line: number; text: string }[] {
  return stripComments(sourceOf(file))
    .split('\n')
    .map((text, index) => ({ line: index + 1, text }));
}

/** 在给定文件的可执行源码里找命中某个模式的行；空数组 = 干净 */
function codeHitsIn(files: readonly string[], pattern: RegExp): string[] {
  const hits: string[] = [];
  for (const file of files) {
    for (const { line, text } of codeLinesOf(file)) {
      if (pattern.test(text)) hits.push(`${file}:${line}: ${text.trim()}`);
    }
  }
  return hits;
}

/**
 * (e) 的判据：**按厂商分支**、**拿厂商名查表**、**硬编码厂商字面量**。
 * 三种形态各一条正则，任何一条都能被单独变异掉。
 */
const VENDOR_BRANCH_PATTERNS: readonly { name: string; pattern: RegExp }[] = [
  { name: 'agentKind ===', pattern: /agentKind\s*===/ },
  { name: 'agentKind !==', pattern: /agentKind\s*!==/ },
  { name: 'switch (…agentKind)', pattern: /switch\s*\(\s*\w*agentKind/ },
  { name: 'agentKind 索引查表', pattern: /agentKind\]/ },
  { name: '厂商字面量', pattern: /['"](dsh|codex|claude-code)['"]/ },
  { name: '数据层的厂商文案表', pattern: /AGENT_LABELS\s*\[/ },
];

describe('agent-log 的分层纪律', () => {
  it('清单里的文件都在（改名 / 搬家要让守卫自己先说话，而不是静默漏扫）', () => {
    const missing = [...LAYER_OF.keys()].filter((file) => !existsSync(join(dir, file)));
    expect(missing).toEqual([]);
  });

  it('(a)(b) 依赖只准向下：L0 不 import L1/L2，L1 不 import L2', () => {
    const violations: string[] = [];
    for (const [file, layer] of LAYER_OF) {
      const upper = UPPER_LAYERS[layer];
      if (upper.length === 0) continue;
      for (const target of relativeImportTargets(sourceOf(file))) {
        const targetLayer = LAYER_OF.get(target);
        if (targetLayer !== undefined && upper.includes(targetLayer)) {
          violations.push(`${file}(${layer}) → ${target}(${targetLayer})`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  /**
   * (c) 虚拟化的三个入口**全仓只有一处**。
   *
   * 2026-10-04 起这一处从 `virtual-turn-list.tsx` 搬到 `base/virtual-list.tsx`：原文行
   * （原始输出的逐行台账，`lines` 没有上限）也要虚拟化，两处各接一遍 `Listy` 就是两份高度测量、
   * 两份退化兜底。搬家的**判据变了、靶子没变**：`agent-log` 里任何文件都不许再出现这三个入口
   * （它们是「绕过原语自己造一个」的信号），而新家自己必须在扫面上
   * ——否则这条守卫会退化成「谁都不许有」，实现躲在扫面外照样绿。
   */
  it('(c) 虚拟化的三个入口只出现在 base/virtual-list.tsx', () => {
    // `virtual` 这个 prop：注释里的 `virtual-turn-list` / `@rc-component/virtual-list` 不算（后面跟的是 `-`）
    expect(codeHitsIn([...LAYER_OF.keys()], /(?<![\w-])virtual(?=[\s/>{])/)).toEqual([]);
    expect(codeHitsIn([...LAYER_OF.keys()], /\bitemHeight\b/)).toEqual([]);
    expect(codeHitsIn([...LAYER_OF.keys()], /from\s+'antd\/listy'/)).toEqual([]);

    // 新家：唯一的实现必须在（`<Listy` + `virtual` 两个入口都在它里面）
    const primitive = readFileSync(join(dir, '..', '..', 'base', 'virtual-list.tsx'), 'utf8');
    expect(primitive, '虚拟列表原语里没有 <Listy>').toContain('<Listy');
    expect(primitive, '虚拟列表原语没有开 virtual').toMatch(/(?:^|\s)virtual(?=[\s/>{])/);
    // 两处内容都用它（漏一处就是「那里又变回全量渲染」）
    for (const file of ['virtual-turn-list.tsx', 'raw-output-panel.tsx']) {
      expect(readFileSync(join(dir, file), 'utf8'), `${file} 没有走共用原语`).toContain('<VirtualList');
    }
  });

  it('(d) L0/L1 不出现 useState：所有开合 / 选中一律受控', () => {
    expect(codeHitsIn([...L0_FILES, ...L1_FILES], /\buseState\b/)).toEqual([]);
  });

  it('(e) L0/L1 不出现 EvalRow，也不按厂商分支', () => {
    /**
     * 扫描面是 `VENDOR_SCANNED_FILES`（三层 + `build-model.ts`），**不是** `LAYER_OF.keys()`：
     * 后者会漏掉那个决定「哪些块被画成卡片」的装配件，而它恰恰是历史上唯一在嗅探厂商形状的地方。
     */
    expect(codeHitsIn(VENDOR_SCANNED_FILES, /\bEvalRow\b/)).toEqual([]);
    for (const { name, pattern } of VENDOR_BRANCH_PATTERNS) {
      expect({ 判据: name, 命中: codeHitsIn(VENDOR_SCANNED_FILES, pattern) }).toEqual({ 判据: name, 命中: [] });
    }
  });

  it('(e 放行) 把 agentKind 当字符串画出来不算判厂商（收窄之后守卫仍有区分力）', () => {
    // 现状：环境抽屉的摘要第一格就是 `summary.agentKind`（设计 §6.8 要求显示「智能体」）
    const drawer = sourceOf('agent-environment-drawer.tsx');
    expect(drawer).toContain('summary.agentKind');

    // 三种**必须放行**的写法：当值渲染、当值传参、类型位置
    const allowed = ['summary.agentKind', 'summary.agentKind,', 'agentKind: string', 'const agentKind = summary.agentKind;'];
    for (const sample of allowed) {
      for (const { pattern } of VENDOR_BRANCH_PATTERNS) {
        expect({ 样本: sample, 命中: pattern.test(sample) }).toEqual({ 样本: sample, 命中: false });
      }
    }
  });

  it('(f) BlockRenderContext 里没有 streaming 这一格（assembly 是唯一判据）', () => {
    const source = sourceOf('block-renderer-registry.tsx');
    const body = /export interface BlockRenderContext \{([\s\S]*?)\n\}/.exec(source)?.[1];
    // 抠不到就抛：守卫不许静默失效（与 global-styles.test.ts 同口径）
    if (body === undefined) throw new Error('block-renderer-registry.tsx 里找不到 BlockRenderContext 的接口体');
    expect(/\bstreaming\b/.test(body)).toBe(false);
  });
});
