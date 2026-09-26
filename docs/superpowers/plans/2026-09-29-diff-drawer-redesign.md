# 「变更详情」抽屉重设计 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把「代码改动」抽屉改造成「变更详情」：逐文件的「文件名 + diff 正文」列表，滚动时文件标题吸顶，正文用 `react-diff-viewer-continued` 渲染，万级文件变更下不卡死。

**Architecture:** 服务端把 `RowDiff.text` 按 `diff --git` 切成逐文件段落（复用既有的 `splitDiffFiles`），并拆成两个接口：**索引**（分页、不含正文）与**单文件正文**（按需拉取）。前端用 `IntersectionObserver` 在文件进入视口时才请求正文，滚动容器就是 `.ant-drawer-body` 本身，文件标题相对它 `position: sticky`。这样「滚动触发加载」与「标题吸顶」是同一个机制，且任何一次响应都不携带全部文件。

**Tech Stack:** TypeScript / zod（契约）、vitest + @testing-library/react（测试）、Next 16 App Router（路由）、antd 6（Drawer / Skeleton / Input）、SWR（按需取数）、React 19、`react-diff-viewer-continued@4.4.0`（diff 渲染）。

**Spec:** `docs/superpowers/specs/2026-09-29-diff-drawer-redesign-design.md`

## Global Constraints

- **依赖口径**：diff 组件用 **`react-diff-viewer-continued@4.4.0`**（已装进 `@aieval/ui` 的 dependencies）。**不得**引入 `react-diff-viewer`（peer 只到 React 16）。
- **预算口径**：`truncateDiff` 按**整文件**丢弃，`settings.diffBudgetBytes` 默认 **262144 字节**。单文件正文**不做**二次截断（spec §4 ③）。
- **切分口径**：按 `diff --git` **行首**切分，**必须复用** `packages/server/core/src/git.ts` 的 `splitDiffFiles`；路径键**必须**经 `rewriteRenamePath` 归一（spec §6.1）。
- **截断文案**：必须含「评分模型看不到」五个字（spec §5.5 第 7 步的硬要求，`diff-view.test.tsx` 有逐字用例）。
- **抽屉几何**：三个抽屉宽度 `max(50vw, 800px)` + `maxWidth: '100vw'`；`styles.body.padding = 0`，内边距由各抽屉内容自己给（spec §7.2.1）。
- **高度口径**：滚动容器**就是** `.ant-drawer-body`；内容用 `minHeight: '100%'`，**不用** `height`。
- **主色/间距走 antd token**：`theme.useToken()`，不手写颜色常量（本仓既有约定）。
- **ui 包不调接口**：`@aieval/ui` 只收 props，数据由 `apps/web-next` 注入（`packages/client/ui/src/index.ts` 头注释）。
- 每个任务结束都要 `pnpm --filter <包> test` 绿了再提交。

## Review Focus

以下五类是 spec 没有逐条写、但使用者一定会碰到、且写错了不会有测试自然报警的输入。每条都已在对应任务里配了用例。

1. **重命名文件**（`packages/{old => new}/x.ts`）：索引里的路径是 `numstat` 归一后的，正文段的路径是 `diff --git` 原样的，两者不相等 ⇒ 正文永远取不到。必须两边都过 `rewriteRenamePath`。
2. **hunk 之间相隔很远**（改动在文件第 498 行）：不做行号对齐补空行，两处相隔 200 行的改动会被渲染成相邻行，读者得到错误的相邻关系。Task 6 的用例钉住「行数相等且第二处落在正确下标」。
3. **纯新增/纯删除文件**（`@@ -0,0 +1,N @@` / `@@ -1,N +0,0 @@`）：`oldNo` 会从 0 开始算，朴素实现会写到数组下标 `-1`。Task 6 的 origin 归一化顺带解决。
4. **同一文件在两段里都出现**（既提交过又未提交）：正文取错段会让用户看到「历史改动」而不是「当前状态」。取**未提交**段。
5. **被预算丢弃的文件**（`hasBody === false`）：界面若照常给加载入口，用户点开只会拿到一个 409。索引里必须预先标出来，界面不给入口。

---

### Task 1: `core` —— 按路径取单文件 diff 段落

**Files:**
- Modify: `packages/server/core/src/git.ts`（导出 `rewriteRenamePath`，新增 `extractDiffFile`）
- Modify: `packages/server/core/src/index.ts:11-21`（把 `extractDiffFile` 加进 `./git` 的转出列表）
- Test: `packages/server/core/src/git-diff-extract.test.ts`（新建）

**Interfaces:**
- Consumes: 既有的 `splitDiffFiles(text)`（`git.ts:776`，私有）、`rewriteRenamePath(rawPath)`（`git.ts:712`，私有）
- Produces: `extractDiffFile(text: string, path: string): string | undefined` —— 返回该路径那一段 `diff --git` 原文（含结尾换行）；路径不存在返回 `undefined`

**背景（实施者必读）：** `splitDiffFiles` 从 `diff --git a/X b/Y` 里取出的路径是**原样**的，
而 `RowDiff.files[].path` 来自 `--numstat` 并经 `rewriteRenamePath` 归一过。
重命名时两者不相等（`packages/{old => new}/x.ts` 会被归一成 `packages/new/x.ts`），
故 `extractDiffFile` 必须对切出的路径**也**过一遍 `rewriteRenamePath` 再比对。

- [ ] **Step 1: 把 `rewriteRenamePath` 改成导出**

`git.ts:712` 那一行由 `function rewriteRenamePath(` 改为 `export function rewriteRenamePath(`，
并在它的 JSDoc 上补一句「导出是为了让 `extractDiffFile` 复用同一份归一逻辑，两份必然漂移」。

- [ ] **Step 2: 写失败的测试**

创建 `packages/server/core/src/git-diff-extract.test.ts`：

```ts
// @vitest-environment node
/**
 * extractDiffFile：按路径取单文件 diff 正文。
 *
 * 两个来源的路径键必须能对上，这是本文件存在的理由：
 * 索引里的 path 来自 `--numstat`（经 rewriteRenamePath 归一），
 * 正文段的 path 来自 `diff --git` 头（原样）——重命名时两者不相等，
 * 不过同一份归一函数就会出现「索引里有的文件，正文永远取不到」。
 */
import { describe, expect, it } from 'vitest';
import { extractDiffFile } from './git';

/** 一段含两个文件的 diff（第二段在「未提交」段里） */
const TEXT = [
  '### 已提交改动（base..HEAD）',
  'diff --git a/a.ts b/a.ts',
  '--- a/a.ts',
  '+++ b/a.ts',
  '@@ -1,1 +1,1 @@',
  '-old',
  '+new',
  '### 未提交改动（工作区 vs HEAD）',
  'diff --git a/b.ts b/b.ts',
  '--- a/b.ts',
  '+++ b/b.ts',
  '@@ -1,1 +1,1 @@',
  '-x',
  '+y',
  '### 未跟踪文件',
  '（无）',
  '',
].join('\n');

describe('extractDiffFile', () => {
  it('按路径取出那一段原文，且不含别的文件', () => {
    const patch = extractDiffFile(TEXT, 'a.ts');

    expect(patch).toContain('diff --git a/a.ts b/a.ts');
    expect(patch).toContain('+new');
    expect(patch).not.toContain('b.ts');
  });

  it('取不到时返回 undefined，而不是空串（空串会让界面显示一个空 diff）', () => {
    expect(extractDiffFile(TEXT, 'nope.ts')).toBeUndefined();
  });

  it('同一文件在「已提交」与「未提交」两段都出现时，取未提交段（当前状态）', () => {
    const both = [
      '### 已提交改动（base..HEAD）',
      'diff --git a/x.ts b/x.ts',
      '@@ -1,1 +1,1 @@',
      '-committed',
      '+committed-new',
      '### 未提交改动（工作区 vs HEAD）',
      'diff --git a/x.ts b/x.ts',
      '@@ -1,1 +1,1 @@',
      '-working',
      '+working-new',
      '',
    ].join('\n');

    const patch = extractDiffFile(both, 'x.ts');

    // 未提交段反映工作区**当前**状态，是用户打开抽屉想看的那个
    expect(patch).toContain('+working-new');
    expect(patch).not.toContain('+committed-new');
  });

  it('花括号重命名：索引里的归一路径能找到原文（两个路径键必须对上）', () => {
    // numstat 给的是归一后的 `packages/new/x.ts`，而 diff 头里是 `packages/{old => new}/x.ts`
    const renamed = [
      '### 未提交改动（工作区 vs HEAD）',
      'diff --git a/packages/{old => new}/x.ts b/packages/{old => new}/x.ts',
      'rename from packages/old/x.ts',
      'rename to packages/new/x.ts',
      '@@ -1,1 +1,1 @@',
      '-a',
      '+b',
      '',
    ].join('\n');

    expect(extractDiffFile(renamed, 'packages/new/x.ts')).toContain('+b');
  });

  it('无花括号重命名（old => new）也能对上', () => {
    const renamed = [
      'diff --git a/old.ts b/new.ts',
      'rename from old.ts',
      'rename to new.ts',
      '@@ -1,1 +1,1 @@',
      '-a',
      '+b',
      '',
    ].join('\n');

    expect(extractDiffFile(renamed, 'new.ts')).toContain('+b');
  });

  it('路径含空格照样能取到', () => {
    const spaced = [
      'diff --git a/my dir/my file.ts b/my dir/my file.ts',
      '--- a/my dir/my file.ts',
      '+++ b/my dir/my file.ts',
      '@@ -1,1 +1,1 @@',
      '-a',
      '+b',
      '',
    ].join('\n');

    expect(extractDiffFile(spaced, 'my dir/my file.ts')).toContain('+b');
  });
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `pnpm --filter @aieval/core test -- git-diff-extract`
Expected: FAIL —— `extractDiffFile is not a function`（模块里还没有这个导出）

- [ ] **Step 4: 实现 `extractDiffFile`**

在 `packages/server/core/src/git.ts` 的 `splitDiffFiles` 之后追加：

```ts
/**
 * 按路径取某一段 diff 原文；路径不存在返回 `undefined`。
 *
 * 路径键必须**两边都归一**：`splitDiffFiles` 从 `diff --git a/X b/Y` 里取的是**原样**路径，
 * 而调用方（索引）手里的路径来自 `--numstat`、已经过 `rewriteRenamePath`。
 * 重命名时 `packages/{old => new}/x.ts` 与 `packages/new/x.ts` 是两个不同的字符串，
 * 只归一一边就会表现为「索引里明明有这个文件，正文永远取不到」——且只在重命名时出现。
 * `rewriteRenamePath` 对已归一的路径是幂等的，故对普通路径无副作用。
 *
 * 同名文件在「已提交」与「未提交」两段都出现时取**未提交**段：
 * 未跟踪文件的正文只在未提交段里（`git add -N` 之后 `git diff HEAD` 才带它），
 * 且未提交段反映工作区**当前**状态，正是使用者打开抽屉要看的。
 */
export function extractDiffFile(text: string, path: string): string | undefined {
  const { pieces } = splitDiffFiles(text);
  const wanted = rewriteRenamePath(path);
  // 倒序找：越靠后的段越「新」（未提交段在已提交段之后），先命中的就是要的那一段
  for (let i = pieces.length - 1; i >= 0; i -= 1) {
    const piece = pieces[i];
    if (piece !== undefined && rewriteRenamePath(piece.path) === wanted) return piece.text;
  }
  return undefined;
}
```

- [ ] **Step 5: 加进 core 的公共出口**

`packages/server/core/src/index.ts` 里 `./git` 那段转出加一个名字（按字母序插在 `ensureCaseCache` 与 `isGitRepo` 之间）：

```ts
export {
  assertCommit,
  checkoutRow,
  collectDiff,
  copyWorkspace,
  ensureCaseCache,
  extractDiffFile,
  isGitRepo,
  listCommits,
  resolveRepoInfo,
  truncateDiff,
} from './git';
```

- [ ] **Step 6: 运行测试确认通过**

Run: `pnpm --filter @aieval/core test -- git-diff-extract`
Expected: PASS —— 6 条用例全绿

- [ ] **Step 7: 跑整包测试与类型检查**

Run: `pnpm --filter @aieval/core test` 和 `pnpm --filter @aieval/core typecheck`
Expected: 全绿（导出改名不影响既有用例）

- [ ] **Step 8: 提交**

```bash
git add packages/server/core/src/git.ts packages/server/core/src/index.ts packages/server/core/src/git-diff-extract.test.ts
git commit -m "feat(core): 按路径取单文件 diff 段落（路径键两边归一并优先未提交段）"
```

---

### Task 2: `contracts` —— 把 `RowDiff` 拆成索引与单文件两个形状

**Files:**
- Modify: `packages/server/contracts/src/run.ts:225-235`（`RowDiffSchema` 段整段替换）
- Modify: `packages/server/contracts/src/index.ts:71,87`（转出的名字）
- Modify: `packages/server/contracts/src/index.test.ts:45,82,105,178`（清单与类型引用）
- Test: `packages/server/contracts/src/run.test.ts:143-156`（`describe('RowDiffSchema')` 整段替换）

**Interfaces:**
- Consumes: 无（纯契约）
- Produces:
  - `RowDiffIndexSchema` / `type RowDiffIndex` = `{ files: {path,insertions,deletions,untracked,hasBody}[]; total: number; offset: number; insertions: number; deletions: number; noBodyCount: number; truncated: boolean; droppedFiles: string[] }`
  - `RowDiffFileSchema` / `type RowDiffFile` = `{ path: string; patch: string; insertions: number; deletions: number; binary: boolean }`
  - **`RowDiffSchema` / `RowDiff` 被删除**（不是并存）

**注意：** 本任务会让 `@aieval/ui` 与 `@aieval/client` 的 typecheck 临时变红（它们还引用着 `RowDiff`），
Task 6 / Task 5 会修好。**本任务只跑到 `--filter @aieval/contracts` 绿**，不要试图一次修全仓。

- [ ] **Step 1: 写失败的测试**

把 `packages/server/contracts/src/run.test.ts` 里 `describe('RowDiffSchema', ...)` 整段（143-156 行附近）替换为：

```ts
describe('RowDiffIndexSchema / RowDiffFileSchema', () => {
  const index = {
    files: [{ path: 'a.ts', insertions: 1, deletions: 0, untracked: false, hasBody: true }],
    total: 1,
    offset: 0,
    insertions: 1,
    deletions: 0,
    noBodyCount: 0,
    truncated: false,
    droppedFiles: [],
  };

  it('索引里没有 diff 正文（正文只走单文件接口）', () => {
    expect(RowDiffIndexSchema.safeParse(index).success).toBe(true);
    // 索引响应绝不带 text 字段——带了就等于把「一次下发全部正文」又请回来了
    expect(RowDiffIndexSchema.safeParse({ ...index, text: 'x' }).success).toBe(true);
    expect(Object.keys(RowDiffIndexSchema.shape)).not.toContain('text');
  });

  it('每个文件条目必须显式给出 hasBody 与 untracked（少一个就是漏标）', () => {
    const [file] = index.files;
    expect(RowDiffIndexSchema.safeParse({ ...index, files: [{ ...file, hasBody: undefined }] }).success).toBe(false);
    expect(RowDiffIndexSchema.safeParse({ ...index, files: [{ ...file, untracked: undefined }] }).success).toBe(false);
  });

  it('droppedFiles 是必填的（被预算丢掉的文件必须逐个列出来）', () => {
    expect(RowDiffIndexSchema.safeParse({ ...index, droppedFiles: undefined }).success).toBe(false);
  });

  it('单文件正文：没有 truncated 字段（整文件丢弃的模型下它恒为 false）', () => {
    expect(RowDiffFileSchema.safeParse({ path: 'a.ts', patch: '+x', insertions: 1, deletions: 0, binary: false }).success).toBe(true);
    expect(Object.keys(RowDiffFileSchema.shape)).not.toContain('truncated');
  });
});
```

同时把文件顶部的 import 清单换成 `RowDiffIndexSchema, RowDiffFileSchema`（去掉 `RowDiffSchema`）。

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @aieval/contracts test -- run.test`
Expected: FAIL —— 导入 `RowDiffIndexSchema` 报错（`run.ts` 里还没有这两个导出）

- [ ] **Step 3: 替换契约**

`packages/server/contracts/src/run.ts` 的 225-235 行整段替换为：

```ts
/**
 * 「变更详情」抽屉首帧：文件索引，**不含任何 diff 正文**。
 *
 * 为什么拆成两个形状（spec §4）：正文有 256 KB 硬预算，但 `files` 没有上限——
 * 一次改一万个文件，旧形状会把一万条条目与正文一起塞进一个响应，那才是会卡死的那一步。
 * 索引负责「有哪些文件、大概改了多少」，正文按需另外取。
 *
 * `insertions` / `deletions` 是**全部文件**的合计（不是本页）：头部的
 * 「共 N 个文件 · +X −Y」要的是全局值，按页累加会让数字在翻页时跳动。
 */
export const RowDiffIndexSchema = z.object({
  files: z.array(
    z.object({
      path: z.string(),
      insertions: z.number(),
      deletions: z.number(),
      /** 该文件出现在「### 未跟踪文件」段里（`??` 新文件） */
      untracked: z.boolean(),
      /** 该文件是否有正文可取。false = 被 diffBudgetBytes 丢弃，界面不给加载入口 */
      hasBody: z.boolean(),
    }),
  ),
  /** 文件总数（不受分页影响） */
  total: z.number(),
  /** 本页起始下标 */
  offset: z.number(),
  insertions: z.number(),
  deletions: z.number(),
  /** 全部文件里有多少个没有正文（被预算丢弃） */
  noBodyCount: z.number(),
  truncated: z.boolean(),
  /** 被预算丢弃的文件名——语义逐字保留：评分模型看不到它们 */
  droppedFiles: z.array(z.string()),
});
export type RowDiffIndex = z.infer<typeof RowDiffIndexSchema>;

/**
 * 单个文件的改动正文。
 *
 * **没有 `truncated` 字段**：`truncateDiff` 按**整文件**丢弃，永远不会把一个文件的正文切一半，
 * 故「这个文件的正文被截断了」这个状态不可能出现；留一个恒为 false 的字段只会诱使下一个人
 * 写一条永远进不去的分支。被丢弃的文件根本走不到这个接口（api 层对它抛 CONFLICT）。
 */
export const RowDiffFileSchema = z.object({
  path: z.string(),
  /** 统一 diff 原文（该文件那一段） */
  patch: z.string(),
  insertions: z.number(),
  deletions: z.number(),
  /** 二进制/无文本改动：true 时界面不渲染 diff 视图 */
  binary: z.boolean(),
});
export type RowDiffFile = z.infer<typeof RowDiffFileSchema>;
```

- [ ] **Step 4: 更新 `index.ts` 转出**

`packages/server/contracts/src/index.ts`：把 71 行的 `RowDiffSchema,` 换成 `RowDiffIndexSchema,` 与 `RowDiffFileSchema,`（保持字母序），
把 87 行的 `type RowDiff,` 换成 `type RowDiffIndex,` 与 `type RowDiffFile,`。

- [ ] **Step 5: 更新 `index.test.ts` 的清单守卫**

`packages/server/contracts/src/index.test.ts`：
- 45 行 `RowDiffSchema,` → `RowDiffIndexSchema,` + `RowDiffFileSchema,`
- 82 行 `type RowDiff,` → `type RowDiffIndex,` + `type RowDiffFile,`
- 105 行 与 178 行里出现的 `RowDiffSchema` / `RowDiff` 同步改名（178 行 `const rowDiff: RowDiff | null = null;` → `const rowDiffIndex: RowDiffIndex | null = null;`，并同样处理它周围的用法）

- [ ] **Step 6: 运行测试确认通过**

Run: `pnpm --filter @aieval/contracts test`
Expected: PASS 全绿

- [ ] **Step 7: 提交**

```bash
git add packages/server/contracts/src/run.ts packages/server/contracts/src/index.ts packages/server/contracts/src/index.test.ts packages/server/contracts/src/run.test.ts
git commit -m "feat(contracts): RowDiff 拆成索引与单文件两个形状（索引不带正文）"
```

---

### Task 3: `api` —— 索引分页、单文件正文与 30 秒缓存

**Files:**
- Modify: `packages/server/api/src/run-artifacts.ts`（`getRowDiff` 替换为两个函数 + 缓存）
- Modify: `packages/server/api/src/index.ts:50`
- Test: `packages/server/api/src/run-artifacts.test.ts`（`describe('getRowDiff')` 整段替换）

**Interfaces:**
- Consumes: `extractDiffFile`（Task 1）、`RowDiffIndex` / `RowDiffFile`（Task 2）、既有的 `collectDiff` / `truncateDiff` / `getRunView` / `getSettings`
- Produces:
  - `getRowDiffIndex(runId: string, rowId: string, offset?: number, limit?: number): RowDiffIndex`
  - `getRowDiffFile(runId: string, rowId: string, path: string): RowDiffFile`
  - `resetRowDiffCache(): void`（**测试专用**，让用例之间不串）
  - 常量 `DIFF_PAGE_DEFAULT = 30`、`DIFF_PAGE_MAX = 200`

**两条错误必须分开（spec §6.2）：**
- 路径不在本次改动里 ⇒ `NOT_FOUND`
- 路径在，但被预算丢了 ⇒ `CONFLICT`，文案说明「超出体积上限，未包含在本轮评分输入中」

- [ ] **Step 1: 写失败的测试**

把 `packages/server/api/src/run-artifacts.test.ts` 的 `describe('getRowDiff', ...)` 整段替换为下面内容，
并把 import 行（22 行）改成 `import { getRowDiffFile, getRowDiffIndex, getRowLog, resetRowDiffCache } from './run-artifacts';`：

```ts
describe('getRowDiffIndex / getRowDiffFile', () => {
  const TEXT = [
    '### 已提交改动（baseline-40..HEAD）',
    'diff --git a/a.ts b/a.ts',
    '--- a/a.ts',
    '+++ b/a.ts',
    '@@ -1,1 +1,1 @@',
    '-old',
    '+new',
    '### 未提交改动（工作区 vs HEAD）',
    '（无）',
    '### 未跟踪文件',
    'c.ts',
    '',
  ].join('\n');

  beforeEach(() => {
    // 缓存是模块级 Map，用例之间必须清干净，否则「第一次算、第二次命中」会串台
    resetRowDiffCache();
  });

  function seedWithDiff(files: { path: string; insertions: number; deletions: number }[]): void {
    seedRun(makeRun({ rows: [makeRow({ id: 'r-1', baselineCommit: 'baseline-40' })] }), { createWorkspace: true });
    vi.mocked(collectDiff).mockReturnValue({
      text: TEXT,
      files,
      filesChanged: files.length,
      insertions: files.reduce((sum, f) => sum + f.insertions, 0),
      deletions: files.reduce((sum, f) => sum + f.deletions, 0),
    });
    vi.mocked(truncateDiff).mockImplementation((text: string) => ({ text, truncated: false, droppedFiles: [] }));
  }

  it('工作区还不存在时抛 CONFLICT，且不去跑 git', () => {
    seedRun(makeRun({ rows: [makeRow({ workspacePath: join(workspaceRoot, 'run-1', 'rows', 'r-1', 'workspace') })] }));

    let caught: unknown;
    try {
      getRowDiffIndex('run-1', 'r-1');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ServiceError);
    expect((caught as ServiceError).code).toBe('CONFLICT');
    expect((caught as ServiceError).message).toContain('还没有工作区');
    expect(vi.mocked(collectDiff)).not.toHaveBeenCalled();
  });

  it('索引：分页切片，但 total 与增删合计是全局值（不随翻页跳动）', () => {
    seedWithDiff([
      { path: 'a.ts', insertions: 1, deletions: 0 },
      { path: 'c.ts', insertions: 5, deletions: 2 },
    ]);

    const page = getRowDiffIndex('run-1', 'r-1', 0, 1);

    expect(page.total).toBe(2);
    expect(page.offset).toBe(0);
    expect(page.files.map((f) => f.path)).toEqual(['a.ts']);
    // 全局合计：两个文件加起来，而不是本页那一个
    expect(page.insertions).toBe(6);
    expect(page.deletions).toBe(2);
  });

  it('索引：第二页给出剩下那些，offset 如实回报', () => {
    seedWithDiff([
      { path: 'a.ts', insertions: 1, deletions: 0 },
      { path: 'c.ts', insertions: 5, deletions: 2 },
    ]);

    const page = getRowDiffIndex('run-1', 'r-1', 1, 1);

    expect(page.offset).toBe(1);
    expect(page.files.map((f) => f.path)).toEqual(['c.ts']);
  });

  it('索引：limit 封顶 200（手改 URL 不能把全量拉回来）', () => {
    const many = Array.from({ length: 250 }, (_, i) => ({ path: `f${i}.ts`, insertions: 1, deletions: 0 }));
    seedWithDiff(many);

    expect(getRowDiffIndex('run-1', 'r-1', 0, 9999).files).toHaveLength(200);
  });

  it('索引：offset/limit 非法时按默认值处理，不抛错（只读展示接口宽容降级）', () => {
    seedWithDiff([{ path: 'a.ts', insertions: 1, deletions: 0 }]);

    expect(getRowDiffIndex('run-1', 'r-1', -5, -1).files).toHaveLength(1);
    expect(getRowDiffIndex('run-1', 'r-1', 1.5, 2.5).offset).toBe(0);
  });

  it('索引：未跟踪文件带 untracked 标记，普通文件不带', () => {
    seedWithDiff([
      { path: 'a.ts', insertions: 1, deletions: 0 },
      { path: 'c.ts', insertions: 5, deletions: 2 },
    ]);

    const page = getRowDiffIndex('run-1', 'r-1');

    expect(page.files.find((f) => f.path === 'c.ts')?.untracked).toBe(true);
    expect(page.files.find((f) => f.path === 'a.ts')?.untracked).toBe(false);
  });

  it('索引：被预算丢弃的文件 hasBody=false，并计入 noBodyCount 与 droppedFiles', () => {
    seedRun(makeRun({ rows: [makeRow({ id: 'r-1', baselineCommit: 'baseline-40' })] }), { createWorkspace: true });
    vi.mocked(collectDiff).mockReturnValue({
      text: TEXT,
      files: [
        { path: 'a.ts', insertions: 1, deletions: 0 },
        { path: 'c.ts', insertions: 5, deletions: 2 },
      ],
      filesChanged: 2,
      insertions: 6,
      deletions: 2,
    });
    // 模拟预算只装得下第一个文件
    vi.mocked(truncateDiff).mockReturnValue({ text: TEXT, truncated: true, droppedFiles: ['c.ts'] });

    const page = getRowDiffIndex('run-1', 'r-1');

    expect(page.truncated).toBe(true);
    expect(page.droppedFiles).toEqual(['c.ts']);
    expect(page.noBodyCount).toBe(1);
    expect(page.files.find((f) => f.path === 'a.ts')?.hasBody).toBe(true);
    expect(page.files.find((f) => f.path === 'c.ts')?.hasBody).toBe(false);
  });

  it('单文件正文：取到那一段，并带上该文件的计数', () => {
    seedWithDiff([
      { path: 'a.ts', insertions: 1, deletions: 0 },
      { path: 'c.ts', insertions: 5, deletions: 2 },
    ]);

    const file = getRowDiffFile('run-1', 'r-1', 'a.ts');

    expect(file.path).toBe('a.ts');
    expect(file.patch).toContain('+new');
    expect(file.insertions).toBe(1);
    expect(file.deletions).toBe(0);
    expect(file.binary).toBe(false);
  });

  it('单文件正文：路径不在本次改动里 → NOT_FOUND（与「被丢弃」是两回事）', () => {
    seedWithDiff([{ path: 'a.ts', insertions: 1, deletions: 0 }]);

    let caught: unknown;
    try {
      getRowDiffFile('run-1', 'r-1', 'nope.ts');
    } catch (error) {
      caught = error;
    }
    expect((caught as ServiceError).code).toBe('NOT_FOUND');
  });

  it('单文件正文：文件在、但正文被预算丢了 → CONFLICT 且说清原因', () => {
    seedRun(makeRun({ rows: [makeRow({ id: 'r-1', baselineCommit: 'baseline-40' })] }), { createWorkspace: true });
    vi.mocked(collectDiff).mockReturnValue({
      text: '### 未提交改动（工作区 vs HEAD）\n（无）\n',
      files: [{ path: 'a.ts', insertions: 1, deletions: 0 }],
      filesChanged: 1,
      insertions: 1,
      deletions: 0,
    });
    vi.mocked(truncateDiff).mockReturnValue({ text: '', truncated: true, droppedFiles: ['a.ts'] });

    let caught: unknown;
    try {
      getRowDiffFile('run-1', 'r-1', 'a.ts');
    } catch (error) {
      caught = error;
    }
    expect((caught as ServiceError).code).toBe('CONFLICT');
    expect((caught as ServiceError).message).toContain('未包含在本轮评分输入中');
  });

  it('单文件正文：没有 @@ 的段落算二进制（界面不渲染 diff 视图）', () => {
    seedRun(makeRun({ rows: [makeRow({ id: 'r-1', baselineCommit: 'baseline-40' })] }), { createWorkspace: true });
    vi.mocked(collectDiff).mockReturnValue({
      text: '### 未提交改动（工作区 vs HEAD）\ndiff --git a/img.png b/img.png\nBinary files a/img.png and b/img.png differ\n',
      files: [{ path: 'img.png', insertions: 0, deletions: 0 }],
      filesChanged: 1,
      insertions: 0,
      deletions: 0,
    });
    vi.mocked(truncateDiff).mockImplementation((text: string) => ({ text, truncated: false, droppedFiles: [] }));

    expect(getRowDiffFile('run-1', 'r-1', 'img.png').binary).toBe(true);
  });

  it('裁剪预算取自设置里的 diffBudgetBytes，而不是硬编码的 256KB', () => {
    seedRun(makeRun({ rows: [makeRow({ id: 'r-1', baselineCommit: 'baseline-40' })] }), { createWorkspace: true });
    updateSettings({ diffBudgetBytes: 12_345 });

    getRowDiffIndex('run-1', 'r-1');

    expect(vi.mocked(truncateDiff)).toHaveBeenCalledWith(expect.any(String), 12_345);
  });

  it('30 秒缓存：一次抽屉会话里多次请求只跑一次 git', () => {
    seedWithDiff([{ path: 'a.ts', insertions: 1, deletions: 0 }]);

    getRowDiffIndex('run-1', 'r-1');
    getRowDiffFile('run-1', 'r-1', 'a.ts');
    getRowDiffIndex('run-1', 'r-1', 0, 30);

    expect(vi.mocked(collectDiff)).toHaveBeenCalledTimes(1);
  });

  it('按该轮快照里的 workspaceBase 找产物，而不是当前设置里的根目录', () => {
    const oldRoot = join(dir, 'old-ws');
    const row = makeRow({ id: 'r-1', workspacePath: join(oldRoot, 'run-1', 'rows', 'r-1', 'workspace') });
    seedRun(makeRun({ id: 'run-1', workspaceBase: oldRoot, rows: [row] }));
    mkdirSync(row.workspacePath, { recursive: true });
    updateSettings({ workspaceRoot: join(dir, 'new-ws') });
    vi.mocked(collectDiff).mockReturnValue({ text: '', files: [], filesChanged: 0, insertions: 0, deletions: 0 });
    vi.mocked(truncateDiff).mockImplementation((text: string) => ({ text, truncated: false, droppedFiles: [] }));

    getRowDiffIndex('run-1', 'r-1');

    expect(vi.mocked(collectDiff)).toHaveBeenCalledWith(row.workspacePath, row.baselineCommit);
  });

  it('git 抛错时折成含路径的中文原因（不透英文 stderr）', () => {
    seedRun(makeRun({ rows: [makeRow({ id: 'r-1' })] }), { createWorkspace: true });
    vi.mocked(collectDiff).mockImplementation(() => {
      throw new Error('fatal: not a git repository (or any of the parent directories): .git');
    });

    let caught: unknown;
    try {
      getRowDiffIndex('run-1', 'r-1');
    } catch (error) {
      caught = error;
    }
    expect((caught as ServiceError).code).toBe('INTERNAL');
    expect((caught as ServiceError).message).toContain('读取代码改动失败');
    expect((caught as ServiceError).message).toContain('not a git repository');
  });

  it('行 id 不存在时抛 NOT_FOUND', () => {
    seedRun(makeRun({ rows: [makeRow({ id: 'r-1' })] }), { createWorkspace: true });

    expect(() => getRowDiffIndex('run-1', 'r-x')).toThrowError(/没有这一行/);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @aieval/api test -- run-artifacts`
Expected: FAIL —— `getRowDiffIndex is not a function`

- [ ] **Step 3: 实现**

`packages/server/api/src/run-artifacts.ts`：把 `getRowDiff` 整段替换为下面的内容，
import 行加上 `extractDiffFile`（从 `@aieval/core`）与 `RowDiffFile`、`RowDiffIndex`（从 `@aieval/contracts`）：

```ts
/** 索引每页默认条数（spec §4 ①：DOM 里始终只有几十行） */
const DIFF_PAGE_DEFAULT = 30;
/** 索引每页上限：手改 URL 也不能把全量拉回来 */
const DIFF_PAGE_MAX = 200;
/** 缓存存活时间。语义是「打开抽屉这半分钟内的快照」，与 useRowDiff 的 revalidateOnFocus:false 同口径 */
const DIFF_CACHE_TTL_MS = 30_000;

interface CollectedDiff {
  text: string;
  files: { path: string; insertions: number; deletions: number }[];
  filesChanged: number;
  insertions: number;
  deletions: number;
}

interface CacheEntry {
  collected: CollectedDiff;
  /** truncateDiff 的结果：正文与 droppedFiles 同源，必须一起缓存，否则两次调用可能给出不同的丢弃集 */
  clipped: { text: string; truncated: boolean; droppedFiles: string[] };
  at: number;
}

/**
 * 进程内 diff 缓存，键 = `${runId}/${rowId}`。
 *
 * 为什么必须有：单文件正文接口是**按文件**拉的，几十个文件进视口就是几十次请求，
 * 每次都现场跑一遍 `collectDiff`（一次多次 git 进程，本仓实测进程创建 ≈ 0.5s/次）会慢到不可用。
 * 为什么用 TTL 而不是按 baselineCommit 键控：行在跑的时候工作区内容一直在变，
 * 键控会让同一次评测里翻同一个文件拿到不同结果；TTL 的语义是「打开抽屉这半分钟内的快照」。
 * 只在内存、进程重启即失效，与落盘配置无关。
 */
const diffCache = new Map<string, CacheEntry>();

/** 测试专用：清空缓存，避免用例之间串台 */
export function resetRowDiffCache(): void {
  diffCache.clear();
}

/** 现场算 diff（带 30 秒缓存）。工作区不存在时抛 CONFLICT，且**不写缓存**。 */
function collectRowDiff(runId: string, rowId: string): CacheEntry {
  const key = `${runId}/${rowId}`;
  const hit = diffCache.get(key);
  if (hit !== undefined && Date.now() - hit.at < DIFF_CACHE_TTL_MS) return hit;

  const run = getRunView(runId);
  const row = findRow(run, rowId);

  if (!existsSync(row.workspacePath)) {
    throw new ServiceError('CONFLICT', `这一行还没有工作区（${row.workspacePath}），没有可看的代码改动`);
  }

  let collected: CollectedDiff;
  try {
    collected = collectDiff(row.workspacePath, row.baselineCommit);
  } catch (error) {
    // 折成含路径的中文原因：git 的英文 stderr 直接透给使用者，无法定位是哪一行出的问题
    throw new ServiceError(
      'INTERNAL',
      `读取代码改动失败（${row.workspacePath}）：${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  const clipped = truncateDiff(collected.text, getSettings().diffBudgetBytes);
  const entry: CacheEntry = { collected, clipped, at: Date.now() };
  diffCache.set(key, entry);
  log.info('按需计算代码改动', {
    runId,
    rowId,
    filesChanged: collected.filesChanged,
    truncated: clipped.truncated,
  });
  return entry;
}

/**
 * 「### 未跟踪文件」段里的路径清单。
 * 段落正文只有路径（`git.ts:581-584` 钉死的格式），故按行读即可；
 * 占位符「（无）」与尾部裁剪标记不是文件名，必须排掉。
 */
function untrackedPaths(clippedText: string): Set<string> {
  const marker = '### 未跟踪文件';
  const at = clippedText.indexOf(marker);
  if (at < 0) return new Set();
  return new Set(
    clippedText
      .slice(at + marker.length)
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && line !== '（无）' && !line.startsWith('>') && !line.startsWith('- ')),
  );
}

/**
 * 文件索引（分页）。
 * `insertions` / `deletions` 取**全局**合计：头部的「共 N 个文件 · +X −Y」要的是全局值，
 * 按页累加会让数字在翻页时跳动。
 */
export function getRowDiffIndex(runId: string, rowId: string, offset = 0, limit = DIFF_PAGE_DEFAULT): RowDiffIndex {
  const { collected, clipped } = collectRowDiff(runId, rowId);

  // 非法入参按默认值处理而不是 400：这是只读的展示接口，宽容降级比报错有用
  const safeOffset = Number.isInteger(offset) && offset > 0 ? offset : 0;
  const safeLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, DIFF_PAGE_MAX) : DIFF_PAGE_DEFAULT;

  const dropped = new Set(clipped.droppedFiles);
  const untracked = untrackedPaths(clipped.text);

  return {
    files: collected.files.slice(safeOffset, safeOffset + safeLimit).map((file) => ({
      path: file.path,
      insertions: file.insertions,
      deletions: file.deletions,
      untracked: untracked.has(file.path),
      hasBody: !dropped.has(file.path),
    })),
    total: collected.filesChanged,
    offset: safeOffset,
    insertions: collected.insertions,
    deletions: collected.deletions,
    noBodyCount: dropped.size,
    truncated: clipped.truncated,
    droppedFiles: clipped.droppedFiles,
  };
}

/**
 * 单文件正文。
 *
 * 两条错误必须分开（spec §6.2）：「这个文件不在本次改动里」与
 * 「它在，但正文被预算丢了」在排障时是两回事——合成一条 NOT_FOUND 会让人以为文件没改过。
 */
export function getRowDiffFile(runId: string, rowId: string, path: string): RowDiffFile {
  const { collected, clipped } = collectRowDiff(runId, rowId);

  const meta = collected.files.find((file) => file.path === path);
  if (meta === undefined) {
    throw new ServiceError('NOT_FOUND', `本次改动里没有这个文件（${path}）`);
  }
  if (clipped.droppedFiles.includes(path)) {
    throw new ServiceError(
      'CONFLICT',
      `该文件超出体积上限，未包含在本轮评分输入中（${path}）：调大「设置 → 评分配置 → diff 体积上限」后重开抽屉`,
    );
  }

  const patch = extractDiffFile(clipped.text, path);
  if (patch === undefined) {
    // 索引里有、正文段里却没有：切分口径与归一逻辑漂移了。不静默返回空 diff
    throw new ServiceError('INTERNAL', `文件在索引里但取不到正文段（${path}）：diff 切分与路径归一可能漂移了`);
  }

  return {
    path,
    patch,
    insertions: meta.insertions,
    deletions: meta.deletions,
    // 二进制改动的段落里没有 hunk（`git` 给的是「Binary files ... differ」），无可渲染的文本
    binary: !/^@@ /m.test(patch),
  };
}
```

- [ ] **Step 4: 更新 api 的转出**

`packages/server/api/src/index.ts:50`：

```ts
export { getRowDiffFile, getRowDiffIndex, getRowLog, resetRowDiffCache } from './run-artifacts';
```

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm --filter @aieval/api test -- run-artifacts`
Expected: PASS 全绿（16 条）

- [ ] **Step 6: 提交**

```bash
git add packages/server/api/src/run-artifacts.ts packages/server/api/src/index.ts packages/server/api/src/run-artifacts.test.ts
git commit -m "feat(api): 变更详情索引分页与单文件正文（含 30 秒缓存）"
```

---

### Task 4: 路由 —— `?offset` / `?limit` / `?file=`

**Files:**
- Modify: `apps/web-next/app/api/runs/[runId]/rows/[rowId]/diff/route.ts`
- Test: `apps/web-next/src/route-run-artifacts.test.ts`（`describe('GET .../rows/[rowId]/diff')` 整段替换）

**Interfaces:**
- Consumes: `getRowDiffIndex` / `getRowDiffFile`（Task 3）
- Produces: `GET` 两种形态 —— `?offset=&limit=` → `RowDiffIndex`；`?file=<path>` → `RowDiffFile`

- [ ] **Step 1: 写失败的测试**

把 `apps/web-next/src/route-run-artifacts.test.ts` 的 `describe('GET .../rows/[rowId]/diff', ...)` 整段替换为：

```ts
describe('GET .../rows/[rowId]/diff', () => {
  /** 建一轮 + 真仓库，返回 run 与 row（三样改动都覆盖：已提交 / 未提交 / 未跟踪） */
  async function seedRepo(): Promise<{ runId: string; rowId: string }> {
    const run = await createRun();
    const row = run.rows[0];
    if (row === undefined) throw new Error('创建评测没有产生候选行');
    const { baseline } = initRepo(row.workspacePath);
    store.set(run.id, { ...run, rows: [{ ...row, baselineCommit: baseline }] });
    return { runId: run.id, rowId: row.id };
  }

  it('索引：不带正文，只给文件清单与三个计数', async () => {
    const { runId, rowId } = await seedRepo();

    const res = await getDiff(new Request('http://localhost/api/diff'), rowContext({ runId, rowId }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.total).toBeGreaterThanOrEqual(1);
    expect(body.insertions).toBeGreaterThanOrEqual(1);
    // 索引响应里**没有**正文——带了就等于把「一次下发全部」请回来
    expect(body).not.toHaveProperty('text');
    expect(body.files.map((f: { path: string }) => f.path)).toContain('a.ts');
  });

  it('索引：未跟踪的新文件带 untracked 标记', async () => {
    const { runId, rowId } = await seedRepo();

    const res = await getDiff(new Request('http://localhost/api/diff'), rowContext({ runId, rowId }));
    const body = await res.json();

    const untracked = body.files.find((f: { path: string }) => f.path === 'c.ts');
    expect(untracked?.untracked).toBe(true);
  });

  it('索引：?limit= 分页，且 limit 封顶后不报错', async () => {
    const { runId, rowId } = await seedRepo();

    const res = await getDiff(new Request('http://localhost/api/diff?offset=0&limit=1'), rowContext({ runId, rowId }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.files.length).toBeLessThanOrEqual(1);
    expect(body.offset).toBe(0);

    const huge = await getDiff(new Request('http://localhost/api/diff?limit=99999'), rowContext({ runId, rowId }));
    expect(huge.status).toBe(200);
  });

  it('索引：非法 offset/limit 宽容降级（不是 400）', async () => {
    const { runId, rowId } = await seedRepo();

    const res = await getDiff(new Request('http://localhost/api/diff?offset=abc&limit=-3'), rowContext({ runId, rowId }));

    expect(res.status).toBe(200);
    expect((await res.json()).offset).toBe(0);
  });

  it('单文件正文：?file= 取到那一段，含未提交的改动与未跟踪新文件的正文', async () => {
    const { runId, rowId } = await seedRepo();

    const res = await getDiff(new Request('http://localhost/api/diff?file=a.ts'), rowContext({ runId, rowId }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.path).toBe('a.ts');
    // 未提交的改动必须在正文里（只取 commit..HEAD 会漏掉它）
    expect(body.patch).toContain('const b = 2;');
    expect(body.binary).toBe(false);

    const untrackedFile = await getDiff(new Request('http://localhost/api/diff?file=c.ts'), rowContext({ runId, rowId }));
    expect((await untrackedFile.json()).patch).toContain('const c = 3;');
  });

  it('单文件正文：路径含空格时按 URL 编码解码后仍能取到', async () => {
    const run = await createRun();
    const row = run.rows[0];
    if (row === undefined) throw new Error('创建评测没有产生候选行');
    const { baseline } = initRepo(row.workspacePath);
    writeFileSync(join(row.workspacePath, 'my file.ts'), 'export const s = 1;\n', 'utf8');
    store.set(run.id, { ...run, rows: [{ ...row, baselineCommit: baseline }] });

    const res = await getDiff(
      new Request(`http://localhost/api/diff?file=${encodeURIComponent('my file.ts')}`),
      rowContext({ runId: run.id, rowId: row.id }),
    );

    expect(res.status).toBe(200);
    expect((await res.json()).patch).toContain('export const s = 1;');
  });

  it('单文件正文：路径不在改动里 → 404', async () => {
    const { runId, rowId } = await seedRepo();

    const res = await getDiff(new Request('http://localhost/api/diff?file=nope.ts'), rowContext({ runId, rowId }));

    expect(res.status).toBe(404);
  });

  it('工作区还没建起来 → 409 中文原因，而不是英文 git 报错', async () => {
    const run = await createRun();
    const row = run.rows[0];
    if (row === undefined) throw new Error('创建评测没有产生候选行');

    const res = await getDiff(new Request('http://localhost/api/diff'), rowContext({ runId: run.id, rowId: row.id }));

    expect(res.status).toBe(409);
    expect((await res.json()).error.message).toContain('还没有工作区');
  });

  it('轮不存在 → 404', async () => {
    const res = await getDiff(new Request('http://localhost/api/diff'), rowContext({ runId: 'nope', rowId: 'w-1' }));

    expect(res.status).toBe(404);
  });
});
```

同时把 `writeFileSync` 加进文件顶部的 `node:fs` import（现在是 `mkdirSync, mkdtempSync, rmSync, writeFileSync`，已含则不动）。

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @aieval/web-next test -- route-run-artifacts`
Expected: FAIL —— 索引响应里还有 `text` 字段 / `?file=` 被忽略

- [ ] **Step 3: 实现路由**

`apps/web-next/app/api/runs/[runId]/rows/[rowId]/diff/route.ts` 整个文件替换为：

```ts
/**
 * 变更详情：GET 两种形态（spec §6.3）。
 *   · `?offset=&limit=`（默认 0 / 30）→ 文件索引，**不含正文**
 *   · `?file=<path>`                 → 该文件的 diff 正文
 *
 * `offset` / `limit` 非法时按默认值处理而**不是** 400：这是只读的展示接口，
 * 宽容降级比报错有用（与 `/log?afterSeq=` 的选择刻意相反——那个参数决定「从哪续」，
 * 猜错了会静默漏日志，故它必须报错）。
 *
 * `file` 只用来在内存里比对 diff 段落中的路径字符串，**不参与任何 path.join**，
 * 故不构成路径穿越面；仍然 decodeURIComponent，否则含空格/中文的路径取不到。
 */
import { getRowDiffFile, getRowDiffIndex } from '@aieval/api';
import { handleApiError } from '@/src/server-context';

export async function GET(
  req: Request,
  { params }: { params: Promise<{ runId: string; rowId: string }> },
): Promise<Response> {
  try {
    const { runId, rowId } = await params;
    const url = new URL(req.url);
    const file = url.searchParams.get('file');

    if (file !== null && file !== '') {
      return Response.json(getRowDiffFile(runId, rowId, decodeURIComponent(file)));
    }

    const offset = Number(url.searchParams.get('offset') ?? '0');
    const limit = Number(url.searchParams.get('limit') ?? '30');
    return Response.json(getRowDiffIndex(runId, rowId, offset, limit));
  } catch (error) {
    return handleApiError(error);
  }
}
```

- [ ] **Step 4: 加一条「路由必须真的转发查询参数」的守卫**

在同一个 `describe` 末尾追加（防止有人日后把 `?file=` 分支删了却没红）：

```ts
  it('回归守卫：?file= 与 ?offset= 走的是两条不同的分支', async () => {
    const { runId, rowId } = await seedRepo();

    const indexRes = await getDiff(new Request('http://localhost/api/diff'), rowContext({ runId, rowId }));
    const fileRes = await getDiff(new Request('http://localhost/api/diff?file=a.ts'), rowContext({ runId, rowId }));

    // 索引有 files/total，单文件有 patch —— 两个形状不能互相冒充
    expect(Object.keys(await indexRes.json())).toContain('total');
    expect(Object.keys(await fileRes.json())).toContain('patch');
  });
```

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm --filter @aieval/web-next test -- route-run-artifacts`
Expected: PASS 全绿（11 条：原 diff 段 10 条 + 上一步新增的守卫 1 条）

- [ ] **Step 6: 提交**

```bash
git add apps/web-next/app/api/runs/[runId]/rows/[rowId]/diff/route.ts apps/web-next/src/route-run-artifacts.test.ts
git commit -m "feat(web-next): diff 路由支持索引分页与单文件正文"
```

---

### Task 5: `client` —— 索引与单文件两个按需 hook

**Files:**
- Modify: `packages/client/client/src/runs.ts`（`runRowUrl` 加查询参数、`useRowDiff` 替换为两个 hook）
- Modify: `packages/client/client/src/index.ts:33`
- Test: `packages/client/client/src/runs.test.tsx:334,352,395`（改断言）

**Interfaces:**
- Consumes: `RowDiffIndex` / `RowDiffFile`（Task 2）、路由（Task 4）
- Produces:
  - `runRowUrl(runId, rowId, artifact, query?: string): string`
  - `useRowDiffIndex(runId: string, rowId: string, enabled: boolean): { index: RowDiffIndex | undefined; error: unknown; isLoading: boolean }`
  - `useRowDiffFile(runId: string, rowId: string, path: string | undefined): { file: RowDiffFile | undefined; error: unknown; isLoading: boolean }`

- [ ] **Step 1: 写失败的测试**

把 `packages/client/client/src/runs.test.tsx` 里三处 `useRowDiff` 相关断言改成：

```tsx
  it('useRowDiffIndex 在 enabled=false 时一个请求都不发', async () => {
    renderHook(() => useRowDiffIndex('run-1', 'w-1', false), { wrapper });

    expect(fetcher).not.toHaveBeenCalled();
  });

  it('useRowDiffIndex / useRowDiffFile 的键就是真实端点（后者带 file 查询参数）', async () => {
    renderHook(() => useRowDiffIndex('run-1', 'w-1', true), { wrapper });
    renderHook(() => useRowDiffFile('run-1', 'w-1', 'src/a b.ts'), { wrapper });

    expect(calledUrls()).toContain('/api/runs/run-1/rows/w-1/diff?offset=0&limit=30');
    // 含空格的路径必须编码，否则服务端解出来是截断的
    expect(calledUrls()).toContain('/api/runs/run-1/rows/w-1/diff?file=src%2Fa%20b.ts');
  });

  it('useRowDiffFile 的 path 为 undefined 时一个请求都不发（「滚动到才加载」的开关）', async () => {
    renderHook(() => useRowDiffFile('run-1', 'w-1', undefined), { wrapper });

    expect(fetcher).not.toHaveBeenCalled();
  });

  it('useRowDiffIndex 不随窗口重获焦点重算（服务端那次 GET 是一次真 git 计算）', async () => {
    renderHook(() => useRowDiffIndex('run-1', 'w-1', true), { wrapper: focusWrapper });

    expect(fetcher).toHaveBeenCalledTimes(1);
  });
```

（这个文件里那个「数 fetcher 调用次数」的辅助函数与 `focusWrapper` 已存在，沿用它的既有写法；
若现有断言的形状与上面不同，**以本文件既有的辅助函数为准**改键与次数，不要新造一套。）

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @aieval/client test -- runs`
Expected: FAIL —— `useRowDiffIndex` 不存在

- [ ] **Step 3: 实现**

`packages/client/client/src/runs.ts`：把 `runRowUrl` 改为接受查询串，并把 `useRowDiff` 整段替换：

```ts
/**
 * 一行的产物端点（diff / log / stream 同前缀）——SSE 与两处按需读取共用，免得字面量三份。
 * `query` 由调用方给（含 `?`），本函数只负责拼，不解释语义。
 */
export function runRowUrl(runId: string, rowId: string, artifact: 'diff' | 'log' | 'stream', query = ''): string {
  return `${runKey(runId)}/rows/${rowId}/${artifact}${query}`;
}

/**
 * 变更详情的**文件索引**（抽屉首帧，不含 diff 正文）。
 *
 * `revalidateOnFocus: false` 与原来的 `useRowDiff` 同口径：这个 GET 在服务端是**一次真实的 git 计算**
 * （合并三样 diff + 裁剪，可达数 MB 的输出与秒级耗时），而 SWR 默认会在窗口重获焦点时重跑它——
 * 每切回一次页面就重算一次。抽屉里的 diff 是「打开时看一眼」的产出快照，
 * 需要更新的使用者重新打开一次抽屉即可（重新挂载本身会触发一次 revalidate）。
 */
export function useRowDiffIndex(
  runId: string,
  rowId: string,
  enabled: boolean,
): { index: RowDiffIndex | undefined; error: unknown; isLoading: boolean } {
  const { data, error, isLoading } = useSWR<RowDiffIndex>(
    enabled && runId !== '' && rowId !== '' ? runRowUrl(runId, rowId, 'diff', '?offset=0&limit=30') : null,
    getJson,
    { revalidateOnFocus: false },
  );
  return { index: data, error, isLoading };
}

/**
 * 单个文件的 diff 正文。
 *
 * **`path === undefined` 就是「还没滚动到这个文件」**，此时 SWR key 传 `null`、一个请求都不发——
 * 不需要另造一个 `enabled` 布尔（两个开关必然漂移成「传了 path 却是 disabled」这种矛盾态）。
 * 同一个文件重复请求由 SWR 自己的缓存兜住，不会重复打服务端。
 */
export function useRowDiffFile(
  runId: string,
  rowId: string,
  path: string | undefined,
): { file: RowDiffFile | undefined; error: unknown; isLoading: boolean } {
  const { data, error, isLoading } = useSWR<RowDiffFile>(
    path !== undefined && runId !== '' && rowId !== ''
      ? runRowUrl(runId, rowId, 'diff', `?file=${encodeURIComponent(path)}`)
      : null,
    getJson,
    { revalidateOnFocus: false },
  );
  return { file: data, error, isLoading };
}
```

类型 import：把 `type RowDiff` 换成 `type RowDiffFile, type RowDiffIndex`。

- [ ] **Step 4: 更新 client 的转出**

`packages/client/client/src/index.ts:33`：由 `useRowDiff,` 换成 `useRowDiffFile,` 与 `useRowDiffIndex,`。

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm --filter @aieval/client test` 和 `pnpm --filter @aieval/client typecheck`
Expected: PASS（typecheck 此时**仍会**因 `apps/web-next/app/runs/page.tsx` 引用旧名字而红——那是 Task 8 的事，本包自身必须干净）

- [ ] **Step 6: 提交**

```bash
git add packages/client/client/src/runs.ts packages/client/client/src/index.ts packages/client/client/src/runs.test.tsx
git commit -m "feat(client): 变更详情的索引与单文件按需 hook"
```

---

### Task 6: `ui` —— diff 段落还原成两侧正文

**Files:**
- Create: `packages/client/ui/src/composite/diff-patch.ts`
- Test: `packages/client/ui/src/composite/diff-patch.test.ts`

**Interfaces:**
- Consumes: 无（纯函数，输入是服务端给的 `patch` 字符串）
- Produces:
  - `reconstructSides(patch: string): { oldValue: string; newValue: string }`
  - `languageOf(path: string): string | undefined`

**为什么需要它（实施者必读）：** `react-diff-viewer-continued` 的 `oldValue` / `newValue` 收的是
**完整文件正文**，不是 diff 文本。把 diff 文本当 `newValue`、空串当 `oldValue` 传进去，
渲染出的是「把这份 diff 当新文件全文」——即把 `+` / `-` 前缀当作正文内容逐行对比，
得到一份**完全错误**的 diff。故必须从 hunk 还原两侧正文。

**关键口径（三条例，写错任何一条都会静默给出错误的对照关系）：**
1. **按 hunk 头给出的行号定位**，不能把 hunk 内容顺序拼接——否则相隔 200 行的两处改动会被渲染成相邻行。
2. **两侧同时平移到同一起点**（取所有 hunk 里 `oldStart` / `newStart` 的最小值作为 origin）：
   否则文件第 498 行的改动会渲染成 497 行空白打头，改动被埋掉。
   平移量对两侧**相同**，故不影响彼此对齐。
3. **较短的一侧用空串补齐到与较长一侧等长**，否则两个字符串行数不同，组件按序比较会错位。

- [ ] **Step 1: 写失败的测试**

创建 `packages/client/ui/src/composite/diff-patch.test.ts`：

```ts
/**
 * diff 段落 → 两侧正文。
 *
 * 本文件是整个重设计里最容易写错、且写错了**不会报错只会显示错**的一处：
 * 组件拿两个字符串按行号对位比较，行号对不上就会把不相邻的改动画成相邻。
 */
import { describe, expect, it } from 'vitest';
import { languageOf, reconstructSides } from './diff-patch';

/** 把还原结果切成行，方便按下标断言 */
function lines(patch: string): { old: string[]; next: string[] } {
  const { oldValue, newValue } = reconstructSides(patch);
  return { old: oldValue.split('\n'), next: newValue.split('\n') };
}

const TWO_HUNKS = [
  'diff --git a/f.ts b/f.ts',
  '--- a/f.ts',
  '+++ b/f.ts',
  '@@ -1,3 +1,3 @@',
  ' a',
  '-b',
  '+b2',
  ' c',
  '@@ -27,3 +27,3 @@',
  ' y',
  '-z',
  '+z2',
  ' w',
  '',
].join('\n');

describe('reconstructSides', () => {
  it('两侧行数相等（不相等会让组件按序比较时错位）', () => {
    const { old, next } = lines(TWO_HUNKS);

    expect(old).toHaveLength(next.length);
  });

  it('相隔很远的两个 hunk 落在各自真实的下标上，中间的未修改行保留为空行', () => {
    const { old, next } = lines(TWO_HUNKS);

    // 第一处：下标 1
    expect(old[1]).toBe('b');
    expect(next[1]).toBe('b2');
    // 第二处：hunk 头写的是第 27 行，origin=1 ⇒ 下标 26（**不是**下标 4）
    expect(old[26]).toBe('z');
    expect(next[26]).toBe('z2');
    // 中间是未修改行（diff 里不存在，只能用空行占位）
    expect(old[10]).toBe('');
    expect(next[10]).toBe('');
  });

  it('远离文件开头的改动不会带一大堆前导空行（origin 平移到第一处 hunk）', () => {
    const deep = [
      'diff --git a/big.ts b/big.ts',
      '--- a/big.ts',
      '+++ b/big.ts',
      '@@ -498,3 +498,3 @@',
      ' x',
      '-y',
      '+y2',
      ' z',
      '',
    ].join('\n');

    const { old, next } = lines(deep);

    // 只有 3 行，不是 497 行空白加 3 行
    expect(old).toHaveLength(3);
    expect(old[1]).toBe('y');
    expect(next[1]).toBe('y2');
  });

  it('正文里含 `diff --git` 字样的行不被当成新文件（按 hunk 内数据行处理）', () => {
    const evil = [
      'diff --git a/d.ts b/d.ts',
      '--- a/d.ts',
      '+++ b/d.ts',
      '@@ -1,2 +1,2 @@',
      ' context',
      '+diff --git a/evil b/evil',
      ' more',
      '',
    ].join('\n');

    const { next } = lines(evil);

    expect(next).toContain('diff --git a/evil b/evil');
  });

  it('"\\ No newline at end of file" 标记不进入正文', () => {
    const noEol = [
      'diff --git a/x.ts b/x.ts',
      '--- a/x.ts',
      '+++ b/x.ts',
      '@@ -1,1 +1,1 @@',
      '-old',
      '\\ No newline at end of file',
      '+new',
      '\\ No newline at end of file',
      '',
    ].join('\n');

    const { old, next } = lines(noEol);

    expect(old).toEqual(['old']);
    expect(next).toEqual(['new']);
  });

  it('纯新增文件（@@ -0,0 +1,N @@）：old 全空、new 是全部内容，两侧等长且没有越界写入', () => {
    const added = [
      'diff --git a/new.ts b/new.ts',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/new.ts',
      '@@ -0,0 +1,3 @@',
      '+a',
      '+b',
      '+c',
      '',
    ].join('\n');

    const { old, next } = lines(added);

    expect(old).toHaveLength(next.length);
    expect(old.every((line) => line === '')).toBe(true);
    expect(next).toContain('a');
    expect(next).toContain('c');
  });

  it('纯删除文件（@@ -1,N +0,0 @@）：new 全空、old 是全部内容', () => {
    const deleted = [
      'diff --git a/gone.ts b/gone.ts',
      'deleted file mode 100644',
      '--- a/gone.ts',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      '-a',
      '-b',
      '',
    ].join('\n');

    const { old, next } = lines(deleted);

    expect(old).toHaveLength(next.length);
    expect(next.every((line) => line === '')).toBe(true);
    expect(old).toContain('a');
  });

  it('纯插入（hunk 两侧行数不同）也能对齐', () => {
    const insert = [
      'diff --git a/m.ts b/m.ts',
      '--- a/m.ts',
      '+++ b/m.ts',
      '@@ -5,3 +5,4 @@',
      ' a',
      '+inserted',
      ' b',
      ' c',
      '',
    ].join('\n');

    const { old, next } = lines(insert);

    expect(old).toHaveLength(next.length);
    expect(next[1]).toBe('inserted');
    expect(old[1]).toBe('');
  });

  it('没有 hunk（二进制改动）返回两个空串，而不是抛错', () => {
    const binary = [
      'diff --git a/img.png b/img.png',
      'Binary files a/img.png and b/img.png differ',
      '',
    ].join('\n');

    expect(reconstructSides(binary)).toEqual({ oldValue: '', newValue: '' });
  });

  it('空 patch 返回两个空串', () => {
    expect(reconstructSides('')).toEqual({ oldValue: '', newValue: '' });
  });
});

describe('languageOf', () => {
  it('认识的扩展名给语言名', () => {
    expect(languageOf('src/a.ts')).toBe('typescript');
    expect(languageOf('a.json')).toBe('json');
  });

  it('不认识的后缀返回 undefined（组件会优雅退化成不高亮）', () => {
    expect(languageOf('Makefile')).toBeUndefined();
    expect(languageOf('a.unknownext')).toBeUndefined();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @aieval/ui test -- diff-patch`
Expected: FAIL —— 模块不存在

- [ ] **Step 3: 实现**

创建 `packages/client/ui/src/composite/diff-patch.ts`：

```ts
/**
 * 把一段统一 diff（`@@` hunk）还原成「旧侧 / 新侧」两份正文。
 *
 * 为什么必须还原：`react-diff-viewer-continued` 的 `oldValue` / `newValue` 收的是**完整文件正文**，
 * 不是 diff 文本。把 diff 文本当 `newValue`、空串当 `oldValue` 传进去，它会渲染出
 * 「把这份 diff 当新文件全文」——`+foo` 会显示成新增了一行字面量 `+foo`，是一份完全错误的 diff。
 *
 * 三条不能动的口径：
 *   ① 按 hunk 头的行号**定位**，不做顺序拼接——否则相隔 200 行的两处改动会被画成相邻行；
 *   ② 两侧按**同一个 origin**（所有 hunk 里 oldStart / newStart 的最小值）平移：
 *      不平移的话，文件第 498 行的改动前面会多出 497 行空白；平移量相同故不影响彼此对齐；
 *   ③ 短的一侧补空串到与长的一侧等长，否则行数不同、组件按序比较会错位。
 */

/** hunk 头：`@@ -旧起点[,旧行数] +新起点[,新行数] @@` */
const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

export function reconstructSides(patch: string): { oldValue: string; newValue: string } {
  const lines = patch.split('\n');
  const hunks: { oldStart: number; newStart: number; body: string[] }[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const header = HUNK_HEADER.exec(lines[i] ?? '');
    if (header === null) continue;
    const body: string[] = [];
    let j = i + 1;
    for (; j < lines.length; j += 1) {
      const raw = lines[j] ?? '';
      // 下一个 hunk 或下一个文件都意味着本 hunk 结束
      if (HUNK_HEADER.test(raw) || raw.startsWith('diff --git ')) break;
      // `\ No newline at end of file` 是元信息，不是内容行
      if (raw.startsWith('\\')) continue;
      body.push(raw);
    }
    hunks.push({ oldStart: Number(header[1]), newStart: Number(header[3]), body });
    i = j - 1;
  }

  if (hunks.length === 0) return { oldValue: '', newValue: '' };

  const origin = Math.min(...hunks.map((hunk) => Math.min(hunk.oldStart, hunk.newStart)));
  const oldLines: string[] = [];
  const newLines: string[] = [];

  for (const hunk of hunks) {
    // 纯新增文件的 hunk 头是 `-0,0`，减完 origin 仍是 0；下标 0 是合法的，故这里不再减一
    let oldNo = hunk.oldStart - origin;
    let newNo = hunk.newStart - origin;
    for (const raw of hunk.body) {
      if (raw.startsWith('+')) {
        newLines[newNo] = raw.slice(1);
        newNo += 1;
        continue;
      }
      if (raw.startsWith('-')) {
        oldLines[oldNo] = raw.slice(1);
        oldNo += 1;
        continue;
      }
      // 上下文行以空格开头；空行（diff 里表示一个空内容行）原样保留
      const content = raw.startsWith(' ') ? raw.slice(1) : raw;
      oldLines[oldNo] = content;
      newLines[newNo] = content;
      oldNo += 1;
      newNo += 1;
    }
  }

  const length = Math.max(oldLines.length, newLines.length);
  const fill = (target: string[]): string[] => {
    for (let k = 0; k < length; k += 1) if (target[k] === undefined) target[k] = '';
    return target;
  };

  return { oldValue: fill(oldLines).join('\n'), newValue: fill(newLines).join('\n') };
}

/** 扩展名 → 组件认识的语言名；不认识就返回 undefined（组件会退化成不高亮） */
const LANGUAGE_BY_EXT: Record<string, string> = {
  ts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  jsx: 'jsx',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  md: 'markdown',
  css: 'css',
  scss: 'scss',
  html: 'markup',
  yml: 'yaml',
  yaml: 'yaml',
  py: 'python',
  go: 'go',
  rs: 'rust',
  java: 'java',
  sh: 'bash',
  sql: 'sql',
};

export function languageOf(path: string): string | undefined {
  const dot = path.lastIndexOf('.');
  if (dot < 0) return undefined;
  return LANGUAGE_BY_EXT[path.slice(dot + 1).toLowerCase()];
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @aieval/ui test -- diff-patch`
Expected: PASS 全绿（12 条）

- [ ] **Step 5: 提交**

```bash
git add packages/client/ui/src/composite/diff-patch.ts packages/client/ui/src/composite/diff-patch.test.ts
git commit -m "feat(ui): diff 段落还原成两侧正文（按 hunk 行号对齐 + origin 平移）"
```

---

### Task 7: `ui` —— `DiffView` 重写（逐文件 + 吸顶 + 惰性加载）

**Files:**
- Modify: `packages/client/ui/src/composite/diff-view.tsx`（整个文件重写）
- Modify: `packages/client/ui/src/composite/diff-view.test.tsx`（整个文件重写）
- Modify: `packages/client/ui/src/index.ts`（转出 `DiffView` / `DiffViewProps` / `DiffFileContent`）
- 注意：重写后 `MonoText` 与 `EllipsisText` 在本文件里**不再被用到**——它们的 import 要一并删掉，
  否则 `@aieval/ui` 的 lint（`import-x/no-unresolved` 之外的 `no-unused-vars` 一档）会红。
  `MonoText` 本身仍被 `log-view.tsx` 使用，**不要删组件**，只删本文件里的 import。

**Interfaces:**
- Consumes: `reconstructSides` / `languageOf`（Task 6）、`RowDiffIndex` / `RowDiffFile`（Task 2）
- Produces:
  - `DiffView`（默认导出之外具名导出），props：
    ```ts
    interface DiffViewProps {
      index: RowDiffIndex | undefined;
      /** 由调用方渲染单个文件的正文（ui 包不调接口，故收一个**渲染函数**而不是取数函数） */
      renderFileBody: (path: string) => ReactNode;
      onLoadMore?: () => void;
      dark: boolean;
    }
    ```
  - `DiffFileContent`，props：
    ```ts
    function DiffFileContent(props: {
      file: RowDiffFile | undefined;
      error: unknown;
      isLoading: boolean;
      dark: boolean;
    }): ReactNode
    ```

**为什么是 `renderFileBody` 而不是 `loadFile`（实施者必读，这一处是最容易设计错的）：**
一个文件一条 SWR 订阅，而 hook **不能**按参数循环调用——所以取数不能由 `DiffView` 内部发起，
也不能由页面在一个函数里按 `path` 调（那依然是在同一层循环调 hook）。
唯一站得住的形状是：**每个文件一个组件实例**，实例里各自调 `useRowDiffFile`。
但 `@aieval/ui` 不调接口（`packages/client/ui/src/index.ts` 头注释的既有约定），
所以这个实例必须由调用方提供 ⇒ `DiffView` 收一个 `renderFileBody(path)` 渲染函数，
`DiffFileContent` 作为受控纯展示件导出，调用方拿到 SWR 结果后直接交给它，不必自己再写一份四态判断。

**布局口径（spec §7.2 / §7.2.1，实施者不要自行发挥）：**
- 滚动容器是 `.ant-drawer-body`；本组件的内容用 `minHeight: '100%'`（**不是** `height`）。
- 文件标题 `position: sticky; top: 0`，底色用 `token.colorBgElevated`，否则正文会透过来。
- 文件正文**限高**（`maxHeight: '60vh'`）且自滚：一个巨大文件若不限高会挤走几十个视口外的兄弟节点，
  让 `IntersectionObserver` 的惰性加载失去意义。

- [ ] **Step 1: 写失败的测试**

把 `packages/client/ui/src/composite/diff-view.test.tsx` 整个文件替换为：

```tsx
/**
 * DiffView：逐文件列表 + 吸顶标题 + 惰性加载 + 骨架 + 截断提示。
 *
 * 截断提示是硬要求（spec §5.5 第 7 步）：评分模型看不到的改动必须让人知道，
 * 否则使用者会把「这一次的分」当成完整输入下的结论。
 *
 * 注意：`Skeleton` / `Input` 会读全局 `ResizeObserver` / `matchMedia`，jsdom 都没有，
 * 故本文件自己装桩（见 testing/resize-observer.ts）。`IntersectionObserver` jsdom 也没有，
 * 由本文件的桩手动触发回调来模拟「滚进了视口」。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { RowDiffFile, RowDiffIndex } from '@aieval/contracts';
import { DiffFileContent, DiffView } from './diff-view';
import { installResizeObserverStub } from '../testing/resize-observer';

/** 可控的 IntersectionObserver 桩：把回调收集起来，由用例决定何时「进入视口」 */
const observers: { callback: IntersectionObserverCallback; targets: Element[] }[] = [];

class FakeIntersectionObserver {
  private readonly record: { callback: IntersectionObserverCallback; targets: Element[] };

  constructor(callback: IntersectionObserverCallback) {
    this.record = { callback, targets: [] };
    observers.push(this.record);
  }

  observe(target: Element): void {
    this.record.targets.push(target);
  }

  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}

/** 让所有已注册的观察者都报告「目标进入视口」 */
function enterViewport(): void {
  for (const record of observers) {
    for (const target of record.targets) {
      record.callback([{ target, isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
    }
  }
}

beforeEach(() => {
  installResizeObserverStub();
  observers.length = 0;
  vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
});

const index: RowDiffIndex = {
  files: [
    { path: 'lib/a.ts', insertions: 1, deletions: 0, untracked: false, hasBody: true },
    { path: 'lib/b.ts', insertions: 0, deletions: 3, untracked: false, hasBody: true },
  ],
  total: 2,
  offset: 0,
  insertions: 1,
  deletions: 3,
  noBodyCount: 0,
  truncated: false,
  droppedFiles: [],
};

/** 一段真能在组件里渲染出内容的 patch */
const PATCH = [
  'diff --git a/lib/a.ts b/lib/a.ts',
  '--- a/lib/a.ts',
  '+++ b/lib/a.ts',
  '@@ -1,1 +1,2 @@',
  ' const a = 1;',
  '+const b = 2;',
  '',
].join('\n');

function loadedFile(): RowDiffFile {
  return { path: 'lib/a.ts', patch: PATCH, insertions: 1, deletions: 0, binary: false };
}

/** 把 `renderFileBody` 包成 spy 的辅助：返回 spy 与一份默认渲染 */
function bodySpy(file: RowDiffFile | undefined = undefined, isLoading = false): (path: string) => ReactNode {
  return vi.fn((path: string) => <DiffFileContent file={file} error={null} isLoading={isLoading} dark={false} />) as unknown as (
    path: string,
  ) => ReactNode;
}

describe('DiffView', () => {
  it('列出文件与全局计数（计数取自索引的全局值，不是本页合计）', () => {
    render(<DiffView index={index} renderFileBody={bodySpy()} dark={false} />);

    expect(screen.getByText('lib/a.ts')).toBeInTheDocument();
    expect(screen.getByText('lib/b.ts')).toBeInTheDocument();
    expect(screen.getByText('共 2 个文件 · +1 −3')).toBeInTheDocument();
  });

  it('正文**不**在首帧渲染：文件没进视口时一次都不调 renderFileBody（万级文件下这是不卡死的关键）', () => {
    const renderFileBody = bodySpy();

    render(<DiffView index={index} renderFileBody={renderFileBody} dark={false} />);

    expect(renderFileBody).not.toHaveBeenCalled();
  });

  it('文件进入视口后才渲染正文，加载中给骨架（空白会被误读成「这个文件没改动」）', () => {
    const renderFileBody = bodySpy(undefined, true);

    render(<DiffView index={index} renderFileBody={renderFileBody} dark={false} />);
    enterViewport();

    expect(renderFileBody).toHaveBeenCalledWith('lib/a.ts');
    expect(screen.getAllByTestId('diff-file-skeleton').length).toBeGreaterThan(0);
  });

  it('正文就绪后渲染出来', () => {
    render(<DiffView index={index} renderFileBody={bodySpy(loadedFile())} dark={false} />);
    enterViewport();

    expect(screen.getByText(/const b = 2;/)).toBeInTheDocument();
  });

  it('文件标题是 sticky 的（吸顶靠它；相对 .ant-drawer-body 这个滚动容器定位）', () => {
    render(<DiffView index={index} renderFileBody={bodySpy()} dark={false} />);

    const title = screen.getByTestId('diff-file-title-lib/a.ts');

    expect(title).toHaveStyle({ position: 'sticky', top: '0px' });
  });

  it('hasBody=false 的文件明说「未包含在本轮评分输入中」，且不给加载入口', () => {
    const dropped: RowDiffIndex = {
      ...index,
      files: [{ path: 'lib/big.ts', insertions: 9, deletions: 9, untracked: false, hasBody: false }],
      total: 1,
      noBodyCount: 1,
      truncated: true,
      droppedFiles: ['lib/big.ts'],
    };
    const renderFileBody = bodySpy();

    render(<DiffView index={dropped} renderFileBody={renderFileBody} dark={false} />);
    enterViewport();

    expect(screen.getByText(/未包含在本轮评分输入中/)).toBeInTheDocument();
    // 被丢弃的文件不该触发取数（服务端对它抛 409，请求了也只是白跑一趟）
    expect(renderFileBody).not.toHaveBeenCalled();
  });

  it('被截断时给出「评分模型看不到」的提示与被丢弃文件清单', () => {
    render(
      <DiffView
        index={{ ...index, truncated: true, droppedFiles: ['lib/c.ts', 'lib/d.ts'], noBodyCount: 2 }}
        renderFileBody={bodySpy()}
        dark={false}
      />,
    );

    expect(screen.getByText(/diff 已按体积上限截断：2 个文件未包含，评分模型看不到它们/)).toBeInTheDocument();
    expect(screen.getByText('被丢弃的文件：lib/c.ts、lib/d.ts')).toBeInTheDocument();
  });

  it('真实报错文案要说「评分模型看不到」——只说「已截断」会让人以为只是界面没显示全', () => {
    render(
      <DiffView
        index={{ ...index, truncated: true, droppedFiles: ['lib/c.ts'], noBodyCount: 1 }}
        renderFileBody={bodySpy()}
        dark={false}
      />,
    );

    expect(screen.getByText(/评分模型看不到它们/)).toBeInTheDocument();
  });

  it('没有改动时给空态而不是一张空列表', () => {
    render(
      <DiffView
        index={{ ...index, files: [], total: 0, insertions: 0, deletions: 0 }}
        renderFileBody={bodySpy()}
        dark={false}
      />,
    );

    expect(screen.getByText('没有代码改动')).toBeInTheDocument();
  });

  it('二进制文件不给 diff 视图，给一句说明（渲染出来会是一片空白）', () => {
    render(
      <DiffView
        index={{ ...index, files: [{ path: 'img.png', insertions: 0, deletions: 0, untracked: false, hasBody: true }], total: 1 }}
        renderFileBody={() => (
          <DiffFileContent
            file={{ path: 'img.png', patch: 'Binary files differ', insertions: 0, deletions: 0, binary: true }}
            error={null}
            isLoading={false}
            dark={false}
          />
        )}
        dark={false}
      />,
    );
    enterViewport();

    expect(screen.getByText(/二进制文件/)).toBeInTheDocument();
  });

  it('索引还没回来时给加载态，而不是空态（否则会先说「没有改动」再跳出内容）', () => {
    render(<DiffView index={undefined} renderFileBody={bodySpy()} dark={false} />);

    expect(screen.getByText('正在读取变更…')).toBeInTheDocument();
    expect(screen.queryByText('没有代码改动')).not.toBeInTheDocument();
  });

  it('按路径过滤只作用于已加载的那些文件，并如实说明范围', () => {
    render(<DiffView index={index} renderFileBody={bodySpy()} dark={false} />);

    fireEvent.change(screen.getByLabelText('按路径过滤'), { target: { value: 'b.ts' } });

    expect(screen.queryByText('lib/a.ts')).not.toBeInTheDocument();
    expect(screen.getByText('lib/b.ts')).toBeInTheDocument();
    // 说清「只过滤了已加载的 2 个」而不是让用户以为服务端搜了全部
    expect(screen.getByText(/仅在已加载的 2 个文件里过滤/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @aieval/ui test -- diff-view`
Expected: FAIL —— props 形状对不上（现有组件收的是 `diff: RowDiff`）

- [ ] **Step 3: 实现**

把 `packages/client/ui/src/composite/diff-view.tsx` 整个文件替换为：

```tsx
'use client';

/**
 * 变更详情：逐文件的「文件名 + diff 正文」列表，滚动时当前文件标题吸顶。
 *
 * 五条口径：
 *   1. **正文惰性渲染**：文件进入视口才调 `renderFileBody`。万级文件变更下这是不卡死的关键——
 *      万级文件的正文在服务端就已经被 256 KB 预算裁掉了，真正会卡的是「一次渲染一万个节点」；
 *   2. **取数不在这里**：本包不调接口（见 index.ts 头注释）。调用方传 `renderFileBody(path)` 进来，
 *      由它为每个文件挂一份自己的订阅——hook 不能按参数循环调用，故「每文件一个组件实例」
 *      是唯一站得住的形状；
 *   3. **吸顶相对 `.ant-drawer-body`**：抽屉内容区 padding 已置 0 且它自己 `overflow: auto`，
 *      故本组件**不再套第二层滚动容器**——滚动容器只有一个，标题才能正确吸顶（spec §7.2.1 ③）；
 *   4. **截断提示是硬要求**（spec §5.5 第 7 步）：文案必须说「评分模型看不到」，
 *      只说「已截断」会让使用者以为只是界面没显示全；
 *   5. 正文用 `react-diff-viewer-continued` 渲染，它要的是**两侧完整正文**而不是 diff 文本，
 *      故先经 `reconstructSides` 还原（理由见 diff-patch.ts 的文件头）。
 */
import { Alert, Empty, Flex, Input, Skeleton, Tag, Typography, theme } from 'antd';
import DiffViewer from 'react-diff-viewer-continued';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { RowDiffFile, RowDiffIndex } from '@aieval/contracts';
import { EmptyState } from '../base/empty-state';
import { languageOf, reconstructSides } from './diff-patch';

export interface DiffViewProps {
  index: RowDiffIndex | undefined;
  /** 由调用方渲染单个文件的正文（ui 包不调接口，故收一个渲染函数而不是取数函数） */
  renderFileBody: (path: string) => ReactNode;
  /** 继续加载下一页索引；undefined = 没有更多 */
  onLoadMore?: () => void;
  /** 实际生效的明暗，透传给 diff 组件的 useDarkTheme */
  dark: boolean;
}

/**
 * 单个文件正文的**受控纯展示件**：加载中 / 出错 / 二进制 / diff 视图四态。
 * 导出它是因为调用方拿到 SWR 结果后需要一个现成的渲染件——
 * 否则每个调用方都要再写一份这四态判断，四份判断必然漂移。
 */
export function DiffFileContent({
  file,
  error,
  isLoading,
  dark,
}: {
  file: RowDiffFile | undefined;
  error: unknown;
  isLoading: boolean;
  dark: boolean;
}): ReactNode {
  if (isLoading) return <Skeleton active paragraph={{ rows: 3 }} data-testid="diff-file-skeleton" />;
  if (error !== null && error !== undefined) {
    return <Alert type="error" showIcon title="这个文件的正文读取失败" description={String(error)} />;
  }
  if (file === undefined) return null;
  if (file.binary) return <Typography.Text type="secondary">二进制文件，没有可显示的文本改动</Typography.Text>;

  return <DiffContentViewer file={file} dark={dark} />;
}

/** 单个文件的 diff 视图。限高自滚：一个巨大文件不限制高度会挤走几十个兄弟节点，惰性加载就白做了 */
function DiffContentViewer({ file, dark }: { file: RowDiffFile; dark: boolean }): ReactNode {
  const { token } = theme.useToken();
  const sides = useMemo(() => reconstructSides(file.patch), [file.patch]);

  if (sides.oldValue === '' && sides.newValue === '') {
    return <Typography.Text type="secondary">这个文件没有可显示的文本改动</Typography.Text>;
  }

  return (
    <div style={{ maxHeight: '60vh', overflow: 'auto' }}>
      <DiffViewer
        oldValue={sides.oldValue}
        newValue={sides.newValue}
        splitView={false}
        useDarkTheme={dark}
        // 不折叠未修改行：两侧已按行号对齐补空行，折叠会把对齐关系藏起来
        showDiffOnly={false}
        // 每个文件一个 worker 在几十个文件同时进视口时是纯开销；jsdom 里也没有 worker
        disableWorker
        highlightLanguage={languageOf(file.path)}
        styles={{
          contentText: { fontFamily: token.fontFamilyCode, fontSize: token.fontSizeSM },
          lineNumber: { fontFamily: token.fontFamilyCode },
        }}
      />
    </div>
  );
}

/** 一个文件条目：标题吸顶 + 正文（进入视口才渲染） */
function DiffFileSection({
  path,
  insertions,
  deletions,
  untracked,
  hasBody,
  renderFileBody,
}: {
  path: string;
  insertions: number;
  deletions: number;
  untracked: boolean;
  hasBody: boolean;
  renderFileBody: DiffViewProps['renderFileBody'];
}): ReactNode {
  const { token } = theme.useToken();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const host = hostRef.current;
    if (host === null || visible || !hasBody) return;
    if (typeof IntersectionObserver === 'undefined') {
      // 没有观察者（老浏览器 / 某些测试环境）时退化成「立即渲染」，而不是永远不渲染
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setVisible(true);
        observer.disconnect();
      }
    });
    observer.observe(host);
    return () => observer.disconnect();
  }, [hasBody, visible]);

  return (
    <div ref={hostRef} data-testid={`diff-file-section-${path}`}>
      <Flex
        align="center"
        justify="space-between"
        gap={8}
        wrap
        data-testid={`diff-file-title-${path}`}
        style={{
          // 吸顶：相对 .ant-drawer-body 定位。底色必须给，否则正文会从标题下面透过来
          position: 'sticky',
          top: 0,
          zIndex: 1,
          padding: '8px 16px',
          background: token.colorBgElevated,
          borderBottom: `1px solid ${token.colorBorderSecondary}`,
        }}
      >
        <Flex align="center" gap={8} wrap>
          <Typography.Text code>{path}</Typography.Text>
          {untracked && <Tag color="green">未跟踪</Tag>}
        </Flex>
        <Typography.Text type="secondary">
          +{insertions} −{deletions}
        </Typography.Text>
      </Flex>

      <div style={{ padding: '8px 16px' }}>
        {!hasBody ? (
          <Typography.Text type="secondary">该文件超出体积上限，未包含在本轮评分输入中</Typography.Text>
        ) : visible ? (
          renderFileBody(path)
        ) : null}
      </div>
    </div>
  );
}

export function DiffView({ index, renderFileBody, onLoadMore, dark }: DiffViewProps): ReactNode {
  const [keyword, setKeyword] = useState('');
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (sentinel === null || onLoadMore === undefined) return;
    if (typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) onLoadMore();
    });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [onLoadMore]);

  const files = index?.files ?? [];
  const visible = useMemo(() => {
    const trimmed = keyword.trim().toLowerCase();
    if (trimmed === '') return files;
    return files.filter((file) => file.path.toLowerCase().includes(trimmed));
  }, [files, keyword]);

  if (index === undefined) {
    return <Typography.Text type="secondary">正在读取变更…</Typography.Text>;
  }

  return (
    // minHeight 而不是 height：内容短于视口时铺满，长于视口时自然撑开，两种都由 .ant-drawer-body 滚动
    <Flex vertical style={{ minHeight: '100%' }}>
      <Flex vertical gap={8} style={{ padding: '12px 16px' }}>
        {index.truncated && (
          <Alert
            type="warning"
            showIcon
            title={`diff 已按体积上限截断：${index.droppedFiles.length} 个文件未包含，评分模型看不到它们`}
          />
        )}
        {index.droppedFiles.length > 0 && (
          <Typography.Text type="secondary">被丢弃的文件：{index.droppedFiles.join('、')}</Typography.Text>
        )}
        <Flex align="center" justify="space-between" gap={8} wrap>
          <Typography.Text type="secondary">
            共 {index.total} 个文件 · +{index.insertions} −{index.deletions}
          </Typography.Text>
          <Input.Search
            allowClear
            size="small"
            placeholder="按路径过滤"
            style={{ maxWidth: 260 }}
            onChange={(event) => setKeyword(event.target.value)}
            aria-label="按路径过滤"
          />
        </Flex>
        {keyword.trim() !== '' && (
          // 只说「命中几个」会让人以为服务端搜过全部文件——实际只过滤了已加载的这一页
          <Typography.Text type="secondary">
            仅在已加载的 {files.length} 个文件里过滤（共 {index.total} 个）
          </Typography.Text>
        )}
      </Flex>

      {index.total === 0 ? (
        <div style={{ padding: '0 16px 16px' }}>
          <EmptyState title="没有代码改动" description="这一行没有产生任何文件变更" />
        </div>
      ) : visible.length === 0 ? (
        <div style={{ padding: '0 16px 16px' }}>
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="已加载的文件里没有匹配项" />
        </div>
      ) : (
        <div>
          {visible.map((file) => (
            <DiffFileSection
              key={file.path}
              path={file.path}
              insertions={file.insertions}
              deletions={file.deletions}
              untracked={file.untracked}
              hasBody={file.hasBody}
              renderFileBody={renderFileBody}
            />
          ))}
        </div>
      )}

      {onLoadMore !== undefined && files.length < index.total && <div ref={sentinelRef} style={{ height: 1 }} />}
    </Flex>
  );
}
```

**注意 `DiffFileSection` 不再收 `dark`**：`dark` 由调用方的 `renderFileBody` 闭包捕获后传给 `DiffFileContent`，
本组件不需要知道主题——少一条穿透两层的 prop 就少一处漂移。

- [ ] **Step 4: 更新 `@aieval/ui` 的公共出口**

`packages/client/ui/src/index.ts` 现在转出的还是旧的 `DiffView`。本任务新增了 `DiffFileContent`
与 `DiffViewProps`，**必须一起转出**，否则 `apps/web-next` 的 `import { DiffFileContent } from '@aieval/ui'`
会解析不到（ui 包只暴露 `./src/index.ts` 这一个入口，见它的 `package.json` 的 `exports`）。

把该文件里 `DiffView` 那一行改为：

```ts
export { DiffFileContent, DiffView, type DiffViewProps } from './composite/diff-view';
```

**`reconstructSides` / `languageOf` 不转出**：它们是 `DiffView` 的实现细节，
调用方（页面）只需要 `DiffFileContent`。多转出两个内部函数等于把实现锁进公共 API。
（对应地，这两个函数只在 `diff-view.tsx` 与各自的测试里被引用，故不需要进 `index.ts`。）

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm --filter @aieval/ui test -- diff-view`
Expected: PASS 全绿（12 条）

- [ ] **Step 6: 跑整包测试与类型检查**

Run: `pnpm --filter @aieval/ui test`、`pnpm --filter @aieval/ui typecheck`、`pnpm --filter @aieval/ui lint`
Expected: 全绿

- [ ] **Step 7: 提交**

```bash
git add packages/client/ui/src/composite/diff-view.tsx packages/client/ui/src/composite/diff-view.test.tsx packages/client/ui/src/index.ts
git commit -m "feat(ui): 变更详情逐文件列表（吸顶标题 + 惰性加载 + 骨架）"
```

---

### Task 8: 页面接线 —— 抽屉标题、几何与数据

**Files:**
- Modify: `apps/web-next/app/runs/page.tsx`（三个 Drawer + diff 数据接线）
- Modify: `packages/client/ui/src/composite/log-view.tsx`（最外层加 padding）
- Modify: `packages/client/ui/src/composite/score-detail-view.tsx`（最外层加 padding）
- Test: `apps/web-next/src/runs-view.test.ts`（若有抽屉几何断言则同步；无则新建一条最小守卫）

**Interfaces:**
- Consumes: `useRowDiffIndex` / `useRowDiffFile`（Task 5）、`DiffView`（Task 7）、`useResolvedTheme`（既有）
- Produces: 页面渲染——三个抽屉宽度 `max(50vw, 800px)`、内容区 `padding: 0`、标题「变更详情」

- [ ] **Step 1: 让日志与评分详情的正文不贴边**

`log-view.tsx` 最外层 `<Flex vertical gap={8}>` 改为：

```tsx
  // 抽屉内容区 padding 已置 0（spec §7.2.1 ②），内边距由内容自己给——否则日志正文会贴死抽屉边框
  return (
    <Flex vertical gap={8} style={{ padding: 16 }}>
```

`score-detail-view.tsx` 的最外层容器同样加 `style={{ padding: 16 }}`（保持它原有的 `Flex`/`Space` 结构不动，
只加这一个 style）。

- [ ] **Step 2: 写失败的测试**

在 `apps/web-next/src/` 下新建 `drawer-geometry.test.ts`（新建文件比改动无关用例更安全）：

```ts
/**
 * 抽屉几何守卫（spec §7.2.1）。
 *
 * 为什么值得单独钉：这条口径没有任何运行时症状——宽度写错、padding 忘了置 0，
 * 页面照样工作，只是观感不对，且不会让任何别的用例变红。
 * 这里断言的是**源码里的字面量**（页面是 'use client' 组件，渲染它要拉整套 SWR mock，
 * 而几何是一条常量口径，按字面量守卫足够且更稳）。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(join(process.cwd(), 'app', 'runs', 'page.tsx'), 'utf8');

describe('抽屉几何', () => {
  it('三个抽屉宽度都是 max(50vw, 800px)，并显式压住 100vw（窄屏不许撑出屏幕）', () => {
    const widths = source.match(/width: 'max\(50vw, 800px\)'/g) ?? [];
    expect(widths).toHaveLength(3);
    const caps = source.match(/maxWidth: '100vw'/g) ?? [];
    expect(caps).toHaveLength(3);
  });

  it('三个抽屉内容区 padding 都是 0（内边距改由内容自己给）', () => {
    expect(source.match(/padding: 0/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it('不再使用 size="large"（固定预设会与 width 打架）', () => {
    expect(source).not.toContain('size="large"');
  });

  it('抽屉标题是「变更详情」', () => {
    expect(source).toContain('title="变更详情"');
    expect(source).not.toContain('title="代码改动"');
  });
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `pnpm --filter @aieval/web-next test -- drawer-geometry`
Expected: FAIL —— 现在还是 `size="large"` 与 `title="代码改动"`

- [ ] **Step 4: 接线页面**

`apps/web-next/app/runs/page.tsx` 四处改动：

**(a) import 换名**：`useRowDiff` → `useRowDiffFile, useRowDiffIndex`；`useResolvedTheme` 加进 `@aieval/ui` 的 import。

**(b) diff 数据接线**（替换原来第 126 行那句 `const diff = useRowDiff(...)`）：

在 `page.tsx` 里定义「每文件一个实例」的小组件——**hook 不能按参数循环调用**，
所以 `useRowDiffFile` 必须落在这个组件里，而不是页面那一层：

```tsx
/**
 * 一个文件的正文。
 * 必须是**独立组件**：`useRowDiffFile` 是 hook，不能由页面按 path 循环调用；
 * 每个文件一个实例，SWR 的订阅与缓存才能按文件各自生效（这正是惰性加载要的形状）。
 */
function DiffFileBody({
  runId,
  rowId,
  path,
  dark,
}: {
  runId: string;
  rowId: string;
  path: string;
  dark: boolean;
}): ReactNode {
  const { file, error, isLoading } = useRowDiffFile(runId, rowId, path);
  return <DiffFileContent file={file} error={error} isLoading={isLoading} dark={dark} />;
}
```

页面里接上索引与渲染函数：

```tsx
  // 索引（首帧，一页 30 条）与单文件正文（滚到才拉）是两个请求：万级文件下这一点是「能不能打开」的分界
  const diffIndex = useRowDiffIndex(runId, diffRowId ?? '', diffRowId !== null);
  const theme = useResolvedTheme();
```

「变更详情」抽屉的内容：

```tsx
        {diffIndex.index === undefined ? (
          <Typography.Text type="secondary">
            {diffIndex.error === null || diffIndex.error === undefined
              ? '正在计算改动…'
              : `读取失败：${describeError(diffIndex.error)}`}
          </Typography.Text>
        ) : (
          <DiffView
            index={diffIndex.index}
            dark={theme.mode === 'dark'}
            renderFileBody={(path) => (
              <DiffFileBody runId={runId} rowId={diffRowId ?? ''} path={path} dark={theme.mode === 'dark'} />
            )}
          />
        )}
```

`import` 也要相应加上 `DiffFileContent`、`DiffView`（`@aieval/ui`）、`useResolvedTheme`（`@aieval/ui`）、
`useRowDiffFile` / `useRowDiffIndex`（`@aieval/client`），并去掉 `useRowDiff`。
`DiffFileBody` 的 props 类型里用到的 `ReactNode` 已在文件顶部 import 过（现有 import 已含）。

- [ ] **Step 5: 三个 Drawer 的几何与标题**

```tsx
      <Drawer
        title="执行日志"
        placement="right"
        open={drawer?.kind === 'log'}
        onClose={() => setDrawer(null)}
        destroyOnHidden
        styles={{ wrapper: { width: 'max(50vw, 800px)', maxWidth: '100vw' }, body: { padding: 0 } }}
      >
```

「变更详情」与「评分详情」两个 Drawer 同样加上这一行 `styles`，
并把「变更详情」那个的 `title` 改成 `变更详情`、内容换成 Step 4 那段 `<DiffView … />`。
**三个都要删掉 `size="large"`。**

- [ ] **Step 6: 运行测试确认通过**

Run: `pnpm --filter @aieval/web-next test -- drawer-geometry` 与 `pnpm --filter @aieval/web-next test`
Expected: PASS

- [ ] **Step 7: 全仓门禁**

Run: `pnpm -r typecheck`、`pnpm -r lint`、`pnpm -r test`
Expected: 全绿

- [ ] **Step 8: 提交**

```bash
git add apps/web-next/app/runs/page.tsx apps/web-next/src/drawer-geometry.test.ts packages/client/ui/src/composite/log-view.tsx packages/client/ui/src/composite/score-detail-view.tsx packages/client/ui/src/composite/diff-view.tsx
git commit -m "feat(web-next): 变更详情抽屉接线（50vw 宽 + padding 0 + 逐文件正文惰性加载）"
```

---

### Task 9: 文档与冒烟

**Files:**
- Modify: `README.md:169`（抽屉表格那一行的内容描述）
- Create: `docs/superpowers/notes/2026-09-29-diff-drawer-redesign-smoke.md`

- [ ] **Step 1: 更新 README 的抽屉说明**

把 169 行那条（标题已是「变更详情」）的内容描述改成实际形态：

```markdown
| 变更详情 | 代码改动：三样合并 = 已提交改动 + 未提交改动 + 未跟踪新文件。**逐文件**列出（文件名 + 该文件的 diff），滚动时文件名吸顶；正文在文件进入视口时才加载；超出 256 KB 上限被丢弃的文件会显式标注「未包含在本轮评分输入中」 |
```

- [ ] **Step 2: 起开发服务器并真机走一遍**

Run: `pnpm --filter @aieval/web-next dev`
然后在浏览器里（真实窗口，不是 jsdom）逐条核对并把结果写进冒烟记录：

1. 打开一行有改动的「变更详情」抽屉 → 标题是「变更详情」。
2. 抽屉宽度：把窗口拉到 1920 宽 → 抽屉约 960px；拉到 1200 宽 → 抽屉 800px（下限生效）；拉到 700 宽 → 抽屉不超出窗口。
3. 内容区没有内边距，但汇总条与文件正文的文字不贴边。
4. 慢慢向下滚动 → 当前文件标题吸附在顶部、且下一段标题推着它走（吸顶生效）。
5. 打开浏览器 Network → 首帧只有一条 `?offset=0&limit=30` 请求；继续滚动才出现 `?file=...` 请求。
6. 对比 CLI：`git -C <该行 workspacePath> diff <baselineCommit>` 的每个文件内容与抽屉里逐文件显示的**逐字一致**。
7. 窗口拉高/压矮 → 抽屉高度跟着变，且页面上只有一条滚动条。
8. 明暗主题各看一次：diff 配色随主题切换。
9. 若该行改动大到触发预算 → 出现「评分模型看不到它们」的告警，且被丢弃的文件明说「未包含在本轮评分输入中」。

- [ ] **Step 3: 写冒烟记录并提交**

`docs/superpowers/notes/2026-09-29-diff-drawer-redesign-smoke.md` 按本仓既有冒烟记录的格式
（表格：断言 / 期望 / 实测证据；每一条都要能追溯到原始输出，不要只写「通过」）。

```bash
git add README.md docs/superpowers/notes/2026-09-29-diff-drawer-redesign-smoke.md
git commit -m "docs: 变更详情抽屉重设计的冒烟记录"
```

---

## 完成定义

- `pnpm -r typecheck` / `pnpm -r lint` / `pnpm -r test` 三条门禁全绿。
- spec 的验收标准 1-11 逐条有对应实现与证据（1/2/3/4 见 Task 7 测试，5/6 见 Task 7，
  7 见 Task 9 冒烟，8/9/10 见 Task 8 的 `drawer-geometry.test.ts` 与 Task 9 冒烟，11 即三条门禁）。
- 旧名字 `RowDiff` / `RowDiffSchema` / `getRowDiff` / `useRowDiff` 在全仓**不再出现**
  （用 `grep -rn "RowDiff\b\|useRowDiff\b"` 复核，只剩 `RowDiffIndex` / `RowDiffFile` 等新名字）。
