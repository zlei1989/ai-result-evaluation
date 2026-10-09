// @vitest-environment node
/**
 * 分层纪律的**可执行形式**（§9.0）。它是静态扫描而不是渲染断言：用 `fs` 读本目录的源文件、
 * 按层查 import 说明符与几个关键词。理由——层塌掉之后既有的行为守卫**可能全绿**
 * （L0 偷偷 import 了 L2 的折叠态，组件还是画得出来），只有专门的一条守卫能拦住。
 *
 * 六条各有一个靶子（都能被单独变异掉）：
 *   (a) L0 不 import L1/L2；(b) L1 不 import L2；
 *   (c) **虚拟化的三个入口**（`virtual` / `itemHeight` / `Listy` 这一枚标识符）只出现在
 *       `base/virtual-list.tsx`（2026-10-04 从 `virtual-turn-list.tsx` 搬过去）；
 *   (d) L0/L1 不出现 `useState`（开合态一律受控，§9.0 纪律 2）；
 *   (e) L0/L1 不出现 `EvalRow`，**也不按厂商分支**；
 *   (f) `BlockRenderContext` 里没有 `streaming` 这一格（`assembly` 是动效的唯一判据）。
 *
 * **为什么 (e) 的判据写得比「不许出现 `agentKind` 字样」窄**（这条是刻意收窄，不是放宽）：
 * 守卫的靶子是「**UI 判厂商**」——按厂商分支、或把厂商字面量写进组件。而
 * `AgentEnvironmentSummary.agentLabel` 是数据层给的**展示字段**，设计 §6.8 的摘要七项里
 * 明确要求把它画出来；字面禁止「画一个智能体字段」会把一个必须显示的字段挡在门外，那正是
 * 「守卫比它守的东西更宽」的误伤（本仓对误伤的态度是明确的：误伤会让守卫显得碍事从而被绕过，
 * 比不放行更危险）。故下面只拦**分支/查表/厂商字面量**三种形态，
 * 「把字段当字符串渲染」必须放行——最后一条用例专门钉这个区分力。
 * ⚠️ 2026-10-08 起「厂商 → 文案」的映射必须在下沉层做：在 L0 里写 `AGENT_LABELS[kind]`
 * 会被 `AGENT_LABELS[` 那条判据抓住（实测），摘要那一格因此改成数据层算好的 `agentLabel`。
 *
 * 不扫的方向：`types.ts`（类型层）、`fixtures.ts`（夹具）与全部 `*.test.*` 不在三层清单里——
 * 它们不渲染，任何层都可以 import 它们。
 * ⚠️ **`build-model.ts` 是个例外**：它不在层清单里，但**参与 (e) 的「不判厂商」扫描**
 * （装配层同样不许按厂商分支，见 `VENDOR_SCANNED_FILES`）。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
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
const L1_FILES = [
  'agent-message-timeline.tsx',
  'log-node-breadcrumb.tsx',
  'agent-log-facts-bar.tsx',
  'agent-log-domain-facts.tsx',
] as const;

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

/**
 * 源码里所有**相对或包内**引用的目标文件名。
 *
 * 四条口径（后三条是 2026-10-08 补的，每条此前都是能绕过去的缺口）：
 *   1. 说明符通常不带扩展名（本仓直出 TS 源码），故两种写法都推；
 *   2. **`../` 也要归一化**：早先只 `replace(/^\.\//, '')`，`../agent-log/agent-log-layout`
 *      会原样留下（因为 `base.includes('.')` 被开头的 `..` 判真 ⇒ 连扩展名都不补），
 *      于是 `LAYER_OF.get()` 恒 `undefined`（查表按**文件名**，不认路径）⇒ **零命中**。
 *      lint 兜不住：`import-x/no-relative-packages` 只管**跨包**相对引用。
 *   3. **动态 `import()` 与 `export … from` 也算**：早先只认 `from '…'`，
 *      `lazy(() => import('./agent-log-layout'))` 在扫描输入里根本不存在。
 *      magic comment 也要跳过（`import(/* webpackChunkName: 'x' *​/ './x')` 是常见写法）。
 *   4. **包内桶是同一个口子**（2026-10-08 补）：`src/index.ts` 把 L1/L2 全转出去了，
 *      而它自己**不在任何层**里 ⇒ 只要用**不指向具体文件**的写法就能拿到上层：
 *      `import { AgentLogDrawer } from '@aieval/ui'`（`package.json` 有 `exports` ⇒
 *      自引用可解析）或 `from '../../../index'`。两种写法早先都零命中。
 *      故这里把「包自引用」与「路径末段是 `index`」一律归到 `index.ts`——它不在 `LAYER_OF`
 *      里也不会变成静默漏扫，而是被下面那条**单独的断言**点名。
 *
 * 两条边界（lint 兜得住，故不在这里重复实现）：双引号说明符被 `@stylistic/quotes` 拦、
 * `require()` 被 `esmOnlyRequire` 拦。
 */
const SELF_PACKAGE = '@aieval/ui';
function relativeImportTargets(source: string): string[] {
  const targets: string[] = [];
  const specifiers: string[] = [];
  for (const matched of source.matchAll(/from\s+'([^']+)'/g)) specifiers.push(matched[1] ?? '');
  // `import(...)`：允许中间夹 magic comment
  for (const matched of source.matchAll(/\bimport\s*\(\s*(?:\/\*[\s\S]*?\*\/\s*)?'([^']+)'/g)) {
    specifiers.push(matched[1] ?? '');
  }
  // 副作用 import（`import './x';`）：没有 `from`
  for (const matched of source.matchAll(/(?<![.\w])import\s+'([^']+)'/g)) specifiers.push(matched[1] ?? '');
  for (const raw of specifiers) {
    // 包自引用：一律记到包根桶上
    if (raw === SELF_PACKAGE || raw.startsWith(`${SELF_PACKAGE}/`)) {
      targets.push('index.ts');
      continue;
    }
    if (!raw.startsWith('.')) continue;
    // 只取路径最后一段：本仓的相对引用都在同目录或上层，查表按文件名
    const base = raw.split('/').filter((part) => part !== '' && part !== '.' && part !== '..').pop();
    if (base === undefined) continue;
    const bare = base.replace(/\.tsx?$/, '').replace(/\.js$/, '');
    targets.push(`${bare}.ts`, `${bare}.tsx`);
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
  /**
   * **双向的清单守卫**（2026-10-08 补齐反向那一半）。
   *
   * 正向（早先就有）：清单里的文件都得在——改名/搬家时守卫自己先说话。
   * 反向（新加）：**目录里每个渲染件都得进清单**。少了这半边，新建一个
   * `foo-card.tsx` 只要不写进 `L0_FILES`，它就**不在任何扫描面上**——
   * (a)–(f) 六条一起对它失明，而用例全绿。这是「漏扫」而不是「误伤」，
   * 正是本仓最防的那种假绿。
   *
   * 允许例外的只有两类，都点名列出：不在三层清单里但**明确参与 (e) 扫描**的装配件、
   * 以及根本不渲染的类型/夹具文件。
   */
  it('清单双向对齐：清单里的文件都在，渲染件也都在清单里', () => {
    const missing = [...LAYER_OF.keys()].filter((file) => !existsSync(join(dir, file)));
    expect(missing).toEqual([]);

    /** 不渲染、故不进三层清单的文件（每一个都要在这里点名，别用通配把新文件放进来） */
    const NOT_LAYERED = new Set<string>([
      'types.ts',
      'fixtures.ts',
      ...NON_RENDER_SCANNED_FILES,
    ]);
    const renderFiles = readdirSync(dir)
      .filter((name) => (name.endsWith('.ts') || name.endsWith('.tsx')) && !name.endsWith('.test.ts') && !name.endsWith('.test.tsx'));
    const unlisted = renderFiles.filter((file) => !LAYER_OF.has(file) && !NOT_LAYERED.has(file));
    expect(unlisted, '这些文件不在任何扫描面上（(a)–(f) 对它们失明），要么分层、要么点名登记').toEqual([]);
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
   * **包内桶是 (a)(b) 的另一个口子**（2026-10-08 补）。
   *
   * `src/index.ts` 把 L1/L2 全转出去了，而它自己不在任何层里 ⇒ `LAYER_OF.get('index.ts')`
   * 是 `undefined`，上面那条查表式断言对它**天然失明**。于是两种写法都能白拿上层：
   *   · `import { AgentLogDrawer } from '@aieval/ui'`（`package.json` 有 `exports`，自引用可解析，
   *     而 eslint 的 ui 禁用名单里**没有**它——只禁了 client / api / web-next / next）；
   *   · `from '../../../index'`（相对包根桶）。
   * 判据单独一条、不混进上面那条：**三层里的文件一律不许引包根桶**。
   * `types.ts` / `fixtures.ts` / `build-model.ts` 这些不在层里的文件不在此列（它们本就可以引）。
   */
  it('(a)(b) 补：三层里的文件不许走包内桶（`@aieval/ui` / `../../../index`）拿上层', () => {
    const violations: string[] = [];
    for (const file of LAYER_OF.keys()) {
      if (relativeImportTargets(sourceOf(file)).includes('index.ts')) violations.push(file);
    }
    expect(violations, '这些文件引了包根桶——它能拿到 L1/L2，等于绕过依赖方向').toEqual([]);
  });

  /**
   * (c) 虚拟化的三个入口**全仓只有一处**。
   *
   * 2026-10-04 起这一处从 `virtual-turn-list.tsx` 搬到 `base/virtual-list.tsx`：原文行
   * （原始输出的逐行台账，`lines` 没有上限）也要虚拟化，两处各接一遍 `Listy` 就是两份高度测量、
   * 两份退化兜底。搬家的**判据变了、靶子没变**：`agent-log` 里任何文件都不许再出现这三个入口
   * （它们是「绕过原语自己造一个」的信号），而新家自己必须在扫面上
   * ——否则这条守卫会退化成「谁都不许有」，实现躲在扫面外照样绿。
   *
   * ⚠️ 第三个入口的**靶子曾经是死的**（2026-10-08 修）：原来扫的是 `from 'antd/listy'`，
   * 而 antd 6.6.5 **没有这个子路径**（`node_modules/antd/listy` 不存在），真正的写法是
   * 从包根具名导入 `Listy` ⇒ 那条断言任何代码都命中不了。
   * 改成「具名导入」之后**还是能被绕过**（同一天第二次修）：`import * as antd from 'antd'`
   * 再 `<antd.Listy virtual={…} height={…}>`、或 `React.createElement(Listy, …)`、
   * `require('antd')`、`antd/es/listy` 全都不长成「具名导入」的样子。
   * 故现在扫的是**标识符本身**：去掉注释之后出现 `Listy` 这个词就算命中——
   * 不管它以哪种方式被引进来。代价是必须显式放行**唯一一处合法的非虚拟化用法**。
   *
   * 放行 `ask-user-card.tsx`：它的选项列表用 `Listy` 但**不虚拟化**
   * （问答的选项就几条，不需要窗口化），**它并不在造第二个虚拟列表原语**。
   * 放行的是「这一处」，不是「这一类」——别的文件再出现 `Listy` 仍然会红。
   */
  it('(c) 虚拟化的三个入口只出现在 base/virtual-list.tsx', () => {
    /**
     * `virtual` 这个 prop。三个边界都要认（2026-10-08 补）：
     *   · 注释里的 `virtual-turn-list` / `@rc-component/virtual-list` 不算（后面跟的是 `-`）；
     *   · **紧跟 `=` / `:` / `,`** 也要算（`<Listy virtual={true}>`、`{ virtual: true }`
     *     是 JSX/对象字面量的常见写法；早先只认后跟空白/`/`/`>`/`{` 的形态 ⇒ 看不见）；
     *   · **行尾**的 `virtual` 也要算（`<Listy virtual` 换行写属性；实测变异时绿的）。
     */
    const VIRTUAL_PROP = /(?<![\w-])virtual(?=[\s/>{=:,]|$)/;
    expect(codeHitsIn([...LAYER_OF.keys()], VIRTUAL_PROP)).toEqual([]);
    expect(codeHitsIn([...LAYER_OF.keys()], /\bitemHeight\b/)).toEqual([]);
    // `Listy` 这个标识符本身（去掉注释之后判）：任何引入形态都算
    const LISTY_TOKEN = /\bListy\b/;
    expect(codeHitsIn(
      [...LAYER_OF.keys()].filter((file) => file !== 'ask-user-card.tsx'),
      LISTY_TOKEN,
    )).toEqual([]);

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

  /**
   * (e 放行) **把数据层给的字符串原样画出来**不算判厂商（收窄之后守卫仍有区分力）。
   *
   * 2026-10-08：抽屉摘要的「智能体」那一格从 `summary.agentKind` 改成 `summary.agentLabel`
   * ——厂商名 → 文案的映射下沉到了数据层（`client/build-environment.ts` 的 `summaryOf`）。
   * 原因正是这条守卫：在 L0 里写 `AGENT_LABELS[summary.agentKind]` 会被上面 `AGENT_LABELS[`
   * 那条判据当场抓住（实测），而它抓得对——那等于把一张「谁是哪家」的文案表搬进渲染件。
   * 判据仍是「样本里有没有分支 / 查表 / 厂商字面量」，与字段叫什么无关。
   */
  it('(e 放行) 把数据层给的 agentLabel 当字符串画出来不算判厂商（收窄之后守卫仍有区分力）', () => {
    // 现状：环境抽屉的摘要第一格就是 `summary.agentLabel`（设计 §6.8 要求显示「智能体」）
    const drawer = sourceOf('agent-environment-drawer.tsx');
    expect(drawer).toContain('summary.agentLabel');

    // 四种**必须放行**的写法：当值渲染、当值传参、类型位置、取进常量
    const allowed = ['summary.agentLabel', 'summary.agentLabel,', 'agentLabel: string', 'const agentLabel = summary.agentLabel;'];
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
