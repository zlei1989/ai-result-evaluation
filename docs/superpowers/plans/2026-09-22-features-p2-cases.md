# 功能阶段 p2 实施计划：用例管理

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把「用例域」从占位页做成可用功能：用例 CRUD（含删除时清理用例级缓存仓库）、仓库与 commit 校验、commit 候选下拉、AI 生成评分提示词，并把 `/cases` 页做成「列表 + 右栏（详情 / 创建 / 编辑）」，最后删掉脚手架的 `/demo` 示例页。

**Architecture:** 严格按分层落位，一层只做一件事——`api/cases.ts` 承载用例的业务规则（校验、归一化、缓存清理），`api/judge.ts` 只做「拼提示词 → 一次非流式文本调用 → 解析严格 JSON」，两者都不碰框架；`client/cases.ts` 只做 SWR 数据获取（key 就是路由 URL）；`ui` 的两个面板是**纯展示**（数据与回调全走 props，自己不发请求、不 import client）；`apps/web-next` 的路由只做「zod 校验 → 调 api → 错误映射」，页面只做「URL ↔ 右栏状态」的翻译。生成提示词与评分调用共用 `evaluator` 的 `callTextApi` / `resolveJudgeRoute`（单一真源），生成提示词里的输出契约文本用 `contracts` 的 `JUDGE_OUTPUT_CONTRACT`（生成侧与解析侧共用同一份字段名）。

**Tech Stack:** pnpm workspaces · Next.js 16（App Router，Route Handlers）· TypeScript 5（strict + `noUncheckedIndexedAccess` + `verbatimModuleSyntax`）· antd 6.6.5 · SWR 2 · zod 3 · vitest 4（node / jsdom 双配置）· ESLint 9 flat config

**Spec:** `docs/superpowers/specs/2026-09-22-features-design.md` §4（4.1 页面形态 / 4.2 表单字段 / 4.3 AI 生成评分提示词 / 4.4 删除用例）、§5.7 的生成侧契约、§8（cases 路由与 hooks）、§10（仓库 / commit / 评分解析相关行）、§12

**Interfaces source:** `docs/superpowers/notes/2026-09-22-features-plan-interfaces.md`（§2 契约出口 / §3 core·evaluator 出口 / §5 evaluator 出口 / §6 api 出口 / §7 client hooks / §8 ui 组件 / §9 路由清单 / §11 R7）

## Global Constraints

- 包名 `@aieval/*`；依赖方向由 `eslint.shared.ts` 的 `withBoundary()` 硬约束，**含动态 `import()` 与 `require()`，且禁跨包相对引用**：`api → evaluator / core / contracts`、`ui → contracts`、`client → contracts`、`web-next → api / core / ui / client / contracts`。
- `ui` **不调接口、不 import `@aieval/client`**（纯展示、props 驱动）；`api` **禁 import 任何框架**；`client` 不 import `apps`。
- 源码一律 ESM（禁 `require`）；`verbatimModuleSyntax` 开着，**类型必须 `import type`**（或 `import { type X }`）。
- 时间字段一律 **ISO 8601 带时区字符串**（`new Date().toISOString()`）；实体 id 一律 **UUID v4**（`randomUUID()`），由服务端在创建时生成。
- 写盘原子（临时文件 + `renameSync`）、读盘容忍 UTF-8 BOM；配置目录 `AIEVAL_CONFIG_DIR` > `~/.aieval`，测试用 `setConfigDirForTesting()`，**测试不得触碰真实 `~/.aieval` / `~/.runs`**。
- **测试不得打真实网络**：上游 HTTP 一律打假 `fetch`（`vi.stubGlobal('fetch', …)`）；仓库类测试用**临时 git 仓库**（`mkdtempSync` + `git init`），不碰本仓库。
- `apps/web-next` **不能写 `.tsx` 测试**（该应用 `jsx: preserve`，Vite 的 import-analysis 直接报错）；`.tsx` 测试只写在 `ui` / `client` 包。
- 注释 JSDoc 中文，先说「做什么」再说「怎么做」；文件头写职责 + 注意事项；日志走 `createLogger(scope)`，上下文走 `console` 第二参数（不 `JSON.stringify`）。
- **样式一律走 antd**（主题 token / 紧凑密度 / 语义 `styles`）：不手写字号、不手调行内边距、不裸写 `div` 布局（用 `Flex` / `Space` / `Card` / `Descriptions`）。antd 6 的既有改名必须遵守：`Alert` 用 `title`（`message` 已弃用）、`Card` 用 `variant`（`bordered` 已弃用）、`Descriptions` 用 `items`（子节点写法已弃用）、`Input` 用 `suffix`（`addonAfter` / `addonBefore` 已弃用；官方替代 `Space.Compact` 会插一层包裹元素，而 antd 只给 `Form.Item` 的**直接孩子**注入 `value`/`onChange`，故 `Form.Item` 里的输入框一律走 `suffix`）。
- 每个任务结束时 `pnpm typecheck` 零错误；收尾任务跑 `pnpm lint` 与全量 `pnpm test`。
- **每条新增的回归守卫必须做变异验证**：把要拦的缺陷人为制造回去（改实现、不改测试），确认守卫**失败**，再还原并核对还原彻底（`git diff --quiet` 退出码 0 且 `git hash-object` 前后一致）。本计划带**显式变异步骤**的守卫共七条：Task 2 两条（删用例不得连删评测产物 / 候选列表不是白名单）、Task 5 三条（候选不是白名单 / 生成失败不清空 / 回显必须与当前路径一致）、Task 7 一条（R7 的路由形态）、Task 9 一条（导航里不得有 `/demo`）；其余断言是行为描述，不承担守卫职责。
- **提交用逐个显式 `git add <路径>`，禁 `git add -A`**；提交信息中文，形如 `feat(cases): …`。
- 文档不写「TBD / 稍后补 / 类似 Task N」；每个代码步骤给可直接粘贴的完整代码。
- 本计划**不新增任何跨计划可见的名字**：api / client / ui / 路由的出口名与签名逐字来自接口契约 §5–§9。

## 本计划对 spec 的实现层修正

逐条一句话，执行时按这里写的做（不是按 spec 的字面）：

1. **R7（引用接口契约 §11 R7）**：仓库校验与 commit 候选路由按**仓库路径**挂载——`cases/validate-repo`、`cases/commits`，取代 spec §8 里的 `cases/[caseId]/validate-repo`、`cases/[caseId]/commits`；理由是「创建用例时还没有 caseId」。Task 9 会同步修正 spec §8 的路由清单（本计划唯一允许改 spec 的地方）。
2. **R-p2-A（`affectedRuns` 的读路径）**：`deleteCase` 返回的 `affectedRuns` 与详情栏的引用数都要读运行快照，读的是契约 §5 的 `listRunsForCase(caseId)`；按 §0 的依赖表该函数属于 p4，而 p2 在 p4 之前执行——所以 **Task 1 先按契约 §5 的签名建立 `evaluator/src/run-store.ts`**（名字与签名逐字来自契约，不新增名字），p4 落地时只消费、不重写。若执行时该文件已存在（p4 先行），跳过创建、只跑它的测试确认签名一致。
3. **R-p2-B（删除前的引用数）**：契约 §9 的 p2 路由清单里**没有**「按用例查评测数」的接口，而 §9 的路由清单是本计划的硬边界（不得新增路由名）；因此「已被 N 个评测引用」的数字来自 **DELETE 的响应**（`{ affectedRuns }`），删前的 `Popconfirm` 给出语义说明（记录会保留、缓存会删），数字在删除成功的提示里回显。`CaseDetailPanel.referencedRuns` 类型定为 `number | null`，p2 传 `null`；p5 接上评测列表后可把真实计数喂进来，届时无需改组件。
4. **R-p2-C（`generateJudgePrompt` 的返回类型）**：接口契约 §6 把它写成同步返回 `{ prompt, dimensions }`，但它内部必须 `await callTextApi(...)`（契约 §5 明确是 `Promise<string>`）——**同步签名不可实现**。本计划按 `Promise<{ prompt: string; dimensions: DimensionKey[] }>` 实现（名字不变、只把返回值包进 Promise，不是改窄）。这是本计划**唯一**偏离接口契约字面的地方，动手前先与契约持有者对齐（不要各自改一半）。
5. **R-p2-D（用例保存时的校验口径）**：spec §4.2 只说「填了 commit 必须 `git cat-file -e` 通过」。本计划把它落实到**保存前**（`createCase` / `updateCase`）并**只校验本次改动到的字段**：换了仓库没给新 commit 时，把旧 commit 拿到新仓库里再确认一次（不通过就 `INVALID_REF`）；commitHash 一律落 `assertCommit` 解析出的**完整 40 位 hash**（短哈希会随仓库增长产生歧义，而 §4.1 的列表要能 Tooltip 显全量）。
6. **R-p2-E（T1–T3 评审修复轮：`saveRun` 的回退口径 + 三条守卫的区分力）**：Task 1/2/3 落地后的评审提出一处 Important 与若干守卫缺口，已按下面的口径改掉（计划里对应的代码块**已同步改写**，重跑时照抄即可）：
   - **`saveRun` 的 rename 回退（Important）**：原实现「rename 一失败就 `rmSync` 目标」，并在 JSDoc 里声称「口径同 config-store」——而 config-store 恰恰相反：**只有目标确实只读**（`(mode & 0o200) === 0`）才先删，理由是「瞬时 EPERM 不是只读的证据，而删除会制造一个『文件不存在』的窗口」。快照是这一轮评测的**唯一落盘真相**，删除与重命名之间 `getRun` / SSE 读到的是 `NOT_FOUND`。现改为：先按 `isReadOnly(file)` 判定 → 只读才删 → 重试 rename → **两次都失败**才抛中文 `ServiceError('INTERNAL', '运行快照写入失败（路径）：…')`，且**不删原文件**（新内容留在 `run.json.tmp` 供排查）。配套加了 3 条用例（瞬时失败先重试且 `rmSync` 一次都不许调 / 只读才走「先删再重命名」/ 两次都失败抛中文 INTERNAL 且旧快照完好），三条都做了变异验证（把旧实现照抄回去 → 前两条红）。
   - **`listCases` 倒序守卫的空转**：原夹具「先建 first → 建 second → 改 first」，而插入序恰好等于 updatedAt 倒序，于是**把整条 `sort` 删掉也全绿**（变异验证实测存活）。现改为**改后建的那条**并断言顺序翻转为 `[second, first]`；删 sort 与方向写反现在都能杀死。
   - **`createCase` 的成功日志**：原来打在 `assertStorable` / `saveCases` **之前**，被拒绝的保存也会留下「创建用例」的 INFO。现移到落盘之后（与 `updateCase` 同口径），并加了一条带正向对照的 `console.log` 探针用例。
   - **`judge.test.ts` 的只读守卫与替身口径（测试侧）**：①「不改配置文件」原来只比较 `config.json` 字节，看不见 `saveConfig(loadConfig())` 这种**原样重写**（往返逐字节等价）——现在加 `node:fs.writeFileSync` 探针断言「一次都没写过」；②`vi.mock` 工厂原来写 `vi.fn(actual.callTextApi)`，**留着真实实现当兜底**，任何忘记 `mockResolvedValue` 的用例都会带着用户配置的密钥真发请求（实测打过一次 `api.deepseek.com`）——现在改成裸 `vi.fn()`；③新增「模型自造的维度名与重复项被丢弃」一条，补上 `readDimensions` 过滤/去重此前无断言覆盖的缺口。**Task 3 的测试块以仓库里的 `judge.test.ts` 为准**（含 fetch 绊线、`writeFileSync` 探针、裸 `vi.fn()` 工厂），计划上文那段是弱化版，重跑时不要照抄。
   - **夹具成本（待办，本阶段不改）**：`cases.test.ts` 的「候选不是白名单」用例要 25 次提交（每次 `add` + `commit` + `rev-parse`），本机实测 75 次 git 进程 = 18.3 s，是 api 包单文件 50–65 s 的主因。若日后要提速，可改用 `git commit --allow-empty` 的空提交夹具（省掉每次的 `add`，并把 `hashes` 一次 `git log --reverse --format=%H` 取回），约从 75 次降到 27 次进程；**注意空提交不改变「25 次提交」这个语义**，`listCommits` 的 20 条截断与「最早那条不在候选里」的断言都不受影响。

## Review Focus

以下五类输入/条件 spec 没有明说，但坏了会直接伤到使用者；每条都落到「拥有该代码的任务」的测试步骤里：

1. **手工输入的 commit hash 不在最近 20 条候选里**（刚 clone 的仓库、或要钉一个更早的提交）——期望照常保存；候选下拉只是便利，不是白名单。落到 Task 5 的 `手工输入的 commit hash 不在候选里也能提交` 与 Task 2 的 `createCase 接受不在候选列表里的真实 commit`（两条都带变异验证）。
2. **用例引用的仓库临时不可用**（网络盘掉线、目录被移走、U 盘拔了）——期望改标题 / 改提示词这种与仓库无关的编辑**不被 `NOT_A_GIT_REPO` 拦住**。落到 Task 2 的 `只改标题时不做仓库校验`。
3. **生成评分提示词失败**（网络断 / 限额 / 返回不是 JSON）——期望用户已经写好或已经生成好的评分提示词**一个字符都不变**，一次失败的点击不能清掉几十分钟的输入。落到 Task 5 的 `生成失败不清空已有提示词`（带变异验证）。
4. **用例级缓存仓库不存在或删不掉**（首次评测前压根没有这个目录；Windows 上文件被占用）——期望删除用例这个动作**照样成功**，只在日志里留一条 WARN。落到 Task 2 的 `缓存目录不存在时删除照样成功` 与 `缓存删除失败不阻断删除`。
5. **commit 候选为空或加载失败**（新仓库只有 1 个提交、`git log` 出错）——期望表单仍可手工填 hash 并提交，下拉为空不是阻塞。落到 Task 5 的 `候选为空时仍能提交`。

## 文件结构总览

```
ai-result-evaluation/
├── packages/server/
│   ├── evaluator/src/
│   │   ├── run-store.ts(+.test.ts)            # Task 1：运行快照读写（契约 §5，p2 前置）
│   │   └── index.ts                           # Task 1：追加 export
│   └── api/src/
│       ├── cases.ts(+.test.ts)                # Task 2：用例服务层
│       ├── judge.ts(+.test.ts)                # Task 3：生成评分提示词
│       └── index.ts                           # Task 2/3：追加 export
├── packages/client/
│   ├── client/src/
│   │   ├── cases.ts(+.test.tsx)               # Task 4：用例 hooks
│   │   └── index.ts                           # Task 4：追加 export
│   └── ui/src/
│       ├── composite/case-form-panel.tsx(+.test.tsx)     # Task 5
│       ├── composite/case-detail-panel.tsx(+.test.tsx)   # Task 6
│       └── index.ts                                      # Task 5/6：追加 export，Task 9：删 DemoListPage
└── apps/web-next/
    ├── app/
    │   ├── api/cases/route.ts                            # Task 7：GET / POST
    │   ├── api/cases/[caseId]/route.ts                   # Task 7：GET / PUT / DELETE
    │   ├── api/cases/validate-repo/route.ts              # Task 7（R7：按仓库路径）
    │   ├── api/cases/commits/route.ts                    # Task 7（R7：按仓库路径）
    │   ├── api/cases/generate-judge-prompt/route.ts      # Task 7：POST
    │   ├── cases/page.tsx                                # Task 8：重写（列表 + 右栏三态）
    │   └── demo/page.tsx                                 # Task 9：删除
    └── src/
        ├── repo-name.ts(+.test.ts)                       # Task 8：路径 → 仓库名（列表列）
        ├── judge-gate.ts(+.test.ts)                      # Task 8：`isJudgeConfigured`（R30 + 用例级覆盖 + R32 半配置判不可用）
        ├── case-panel-state.ts(+.test.ts)                # Task 8：右栏状态机（区分「取数失败但手上有数据」与「真的不存在」）
        ├── route-cases.test.ts                           # Task 7：路由端到端 + R7 结构守卫
        ├── nav.test.ts                                   # Task 9：导航项守卫（不含 /demo）
        ├── nav.ts                                        # Task 9：核对（当前已无 demo 项）
        └── testing/demo-fixtures.ts                      # Task 9：删除
docs/superpowers/
├── specs/2026-09-22-features-design.md                   # Task 9：只改 §8 的两行路由
└── notes/2026-09-22-features-p2-smoke.md                 # Task 8：用例页冒烟记录
```

---

## Task 1: `evaluator` 运行快照读路径（p2 的前置）

**为什么在本计划里**：`deleteCase` 要回答「这次删除影响了多少个评测」，它读的是运行快照。契约 §5 把读写快照的函数（`listRuns` / `listRunsForCase` / `getRun` / `saveRun`）定在 `evaluator`，但 §0 的依赖表把 evaluator 的实现排在 p4——p2 先落地这个文件的**读路径 + saveRun**，p4 只消费、不重写（见「本计划对 spec 的实现层修正」R-p2-A）。**若该文件已存在**（p4 先行），跳过 Step 1–3，只跑 Step 4 确认签名一致。

**Files:**
- Create: `packages/server/evaluator/src/run-store.ts`
- Create: `packages/server/evaluator/src/run-store.test.ts`
- Modify: `packages/server/evaluator/src/index.ts`（当前内容只有一行 `export {};`）

**Interfaces:**
- Consumes: `@aieval/contracts` 的 `EvalRunSchema` / `type EvalRun` / `ServiceError`；`@aieval/core` 的 `createLogger` / `loadConfig` / `resolveRootForRead` / `runDir` / `runSnapshotFile`（契约 §3.3）
- Produces（契约 §5，逐字）：
  - `listRuns(): EvalRun[]`
  - `listRunsForCase(caseId: string): EvalRun[]`
  - `getRun(runId: string): EvalRun`
  - `saveRun(run: EvalRun): void`

- [ ] **Step 1: 写失败测试 `run-store.test.ts`**

```ts
// @vitest-environment node
/**
 * 运行快照读写：落盘、按用例筛选、坏文件跳过、缺文件抛 NOT_FOUND。
 * 配置目录与工作区根目录一律指向 mkdtempSync 出来的临时目录——绝不碰真实的 ~/.aieval 与 ~/.runs。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SETTINGS_DEFAULTS, ServiceError, type EvalRun } from '@aieval/contracts';
import { loadConfig, saveConfig, setConfigDirForTesting } from '@aieval/core';
import { getRun, listRuns, listRunsForCase, saveRun } from './run-store';

let dir: string;
let ws: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aieval-run-store-'));
  ws = join(dir, 'runs');
  mkdirSync(ws, { recursive: true });
  setConfigDirForTesting(dir);
  saveConfig({ ...loadConfig(), settings: { ...SETTINGS_DEFAULTS, workspaceRoot: ws } });
});

afterEach(() => {
  // 先复位再删目录：万一删目录抛错，覆盖值会漏给下一个用例
  setConfigDirForTesting(null);
  rmSync(dir, { recursive: true, force: true });
});

/**
 * 最小合法快照：rows 允许为空数组，其余字段必须给全——
 * 少任何一个 EvalRunSchema 都会拒绝，测试就变成在测自己的夹具而不是被测代码。
 */
function makeRun(overrides: Partial<EvalRun> & Pick<EvalRun, 'id' | 'caseId'>): EvalRun {
  return {
    caseTitle: '示例用例',
    repoPath: 'D:\\projects\\gateway',
    commitHash: null,
    status: 'idle',
    executionMode: 'parallel',
    rows: [],
    workspaceBase: ws,
    createdAt: '2026-09-22T10:00:00.000Z',
    startedAt: null,
    finishedAt: null,
    ...overrides,
  };
}

describe('run-store', () => {
  it('saveRun 后 getRun 原样读回（含中文与非 ASCII 字段）', () => {
    const run = makeRun({ id: 'run-1', caseId: 'case-1', caseTitle: '中文标题 · 用例「甲」' });

    saveRun(run);

    expect(getRun('run-1')).toEqual(run);
  });

  it('重复 saveRun 同一 runId 时后写的覆盖前写的（整体覆盖，不做增量合并）', () => {
    saveRun(makeRun({ id: 'run-1', caseId: 'case-1', status: 'idle' }));

    saveRun(makeRun({ id: 'run-1', caseId: 'case-1', status: 'done' }));

    expect(getRun('run-1').status).toBe('done');
  });

  it('listRuns 只认 run.json，不把工作区里的 cases 缓存目录当成一次评测', () => {
    saveRun(makeRun({ id: 'run-1', caseId: 'case-1' }));
    // 用例级缓存仓库就住在同一个根目录下：{workspaceRoot}/cases/{caseId}/cache，它没有 run.json
    mkdirSync(join(ws, 'cases', 'case-1', 'cache'), { recursive: true });

    expect(listRuns().map((run) => run.id)).toEqual(['run-1']);
  });

  it('listRunsForCase 按用例 id 精确筛选（标题相同也不会串）', () => {
    saveRun(makeRun({ id: 'run-1', caseId: 'case-1' }));
    saveRun(makeRun({ id: 'run-2', caseId: 'case-2' }));

    expect(listRunsForCase('case-1').map((run) => run.id)).toEqual(['run-1']);
  });

  // 一个坏文件不能让整个评测列表打不开：列表路径必须跳过并记 WARN，而不是抛穿。
  it('损坏的 run.json 被跳过（不影响其它快照）', () => {
    saveRun(makeRun({ id: 'run-1', caseId: 'case-1' }));
    mkdirSync(join(ws, 'run-broken'), { recursive: true });
    writeFileSync(join(ws, 'run-broken', 'run.json'), '{ 这不是 JSON', 'utf8');

    expect(listRuns().map((run) => run.id)).toEqual(['run-1']);
  });

  it('字段不全的快照同样被跳过（旧版本写下的文件不该让列表崩）', () => {
    saveRun(makeRun({ id: 'run-1', caseId: 'case-1' }));
    mkdirSync(join(ws, 'run-old'), { recursive: true });
    writeFileSync(join(ws, 'run-old', 'run.json'), JSON.stringify({ id: 'run-old' }), 'utf8');

    expect(listRuns().map((run) => run.id)).toEqual(['run-1']);
  });

  it('根目录不存在时 listRuns 返回空数组（从没跑过评测是正常状态，不是错误）', () => {
    rmSync(ws, { recursive: true, force: true });

    expect(listRuns()).toEqual([]);
  });

  it('getRun 对不存在的 runId 抛 NOT_FOUND（而不是返回 undefined）', () => {
    let caught: unknown;
    try {
      getRun('missing-run');
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ServiceError);
    expect((caught as ServiceError).code).toBe('NOT_FOUND');
  });

  it('getRun 对损坏的快照抛 INTERNAL，且 message 里带文件路径（便于直接去磁盘核对）', () => {
    mkdirSync(join(ws, 'run-bad'), { recursive: true });
    const file = join(ws, 'run-bad', 'run.json');
    writeFileSync(file, '{ 坏', 'utf8');

    let caught: unknown;
    try {
      getRun('run-bad');
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ServiceError);
    expect((caught as ServiceError).code).toBe('INTERNAL');
    expect((caught as ServiceError).message).toContain('run-bad');
  });

  it('带 UTF-8 BOM 的快照能正常读（外部工具写过的文件）', () => {
    saveRun(makeRun({ id: 'run-bom', caseId: 'case-1' }));
    const file = join(ws, 'run-bom', 'run.json');
    // 在文件开头插一个 U+FEFF：模拟 PowerShell 5.1 的 Set-Content / ConvertTo-Json 写出的文件
    writeFileSync(file, `\uFEFF${readFileSync(file, 'utf8')}`, 'utf8');

    expect(getRun('run-bom').id).toBe('run-bom');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @aieval/evaluator test -- run-store.test.ts`
Expected: FAIL —— `Failed to resolve import "./run-store"`（文件还不存在）。

- [ ] **Step 3: 写实现 `run-store.ts`**

```ts
/**
 * 运行快照落盘：`{workspaceRoot}/{runId}/run.json` 的读写。
 * 本文件按接口契约 §5 的签名实现（用例域要数「引用该用例的评测数」，编排域要写快照）。
 *
 * 三个口径：
 *   1. **写盘原子**（临时文件 + rename）：快照是评测的唯一落盘真相，写到一半崩溃会让整轮评测不可读；
 *      不先删目标再 rename——两步之间崩溃会让快照彻底消失。**唯一的例外是目标只读**：这种目标上裸 rename
 *      必失败，只能先删再重试；而那个删除真的会制造一个「快照不存在」的窗口（getRun / SSE 会读到 NOT_FOUND），
 *      所以绝不在其它成因下走它（成因判定见 saveRun 的 catch，口径照 config-store；见 R-p2-E）；
 *   2. **列表读容忍坏文件**：单个损坏的 run.json 只跳过并记 WARN。让一个坏文件把整个评测列表打不开，
 *      是把「一轮评测的本地故障」放大成「全站不可用」；
 *   3. **按用例筛选用用例 id 精确匹配**，不用标题——标题会重名、会被改，拿它筛必然出错。
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { EvalRunSchema, ServiceError, type EvalRun } from '@aieval/contracts';
import { createLogger, loadConfig, resolveRootForRead, runDir, runSnapshotFile } from '@aieval/core';

const log = createLogger('run-store');

/**
 * 当前工作区根目录：**每次现取**而不是模块加载时缓存一次——
 * 设置页刚改完根目录，列表就该指向新根；缓存会让「改了设置但列表还是空的」变成幽灵问题。
 * `resolveRootForRead` 负责把配置里保留的可读写法 `~/.runs` 展开成绝对路径。
 */
function workspaceRoot(): string {
  return resolveRootForRead(loadConfig().settings.workspaceRoot);
}

/** 读单个快照：不存在或读不出都返回 null（列表路径不允许抛） */
function readSnapshot(file: string): EvalRun | null {
  if (!existsSync(file)) return null;
  try {
    // BOM 容忍与 config-store 同口径：外部工具写过的 JSON 可能带 U+FEFF，JSON.parse 遇到它直接抛
    const parsed = EvalRunSchema.safeParse(JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')));
    if (!parsed.success) {
      log.warn('运行快照字段不合法，已跳过', { file, issueCount: parsed.error.issues.length });
      return null;
    }
    return parsed.data;
  } catch (error) {
    log.warn('运行快照读不出，已跳过', { file, reason: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

/** 全部运行快照；根目录不存在时返回空数组（从没跑过评测是正常状态，不是错误） */
export function listRuns(): EvalRun[] {
  const root = workspaceRoot();
  if (!existsSync(root)) return [];
  const runs: EvalRun[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    // 只认目录：同一个根目录下还住着 cases/（用例级缓存仓库）与各种临时文件
    if (!entry.isDirectory()) continue;
    const run = readSnapshot(runSnapshotFile(root, entry.name));
    if (run !== null) runs.push(run);
  }
  return runs;
}

/** 某个用例的全部运行快照（删用例前要数它，用例详情将来要显示它） */
export function listRunsForCase(caseId: string): EvalRun[] {
  return listRuns().filter((run) => run.caseId === caseId);
}

/**
 * `runId` 的形状校验（p2 阶段评审 F5）：它会被拼进 `{workspaceRoot}/{runId}/run.json`，
 * 而 p5 的 `GET /api/runs/{runId}` 会把**用户可控的 URL 段**喂进来。
 * 今天不可达（p2 的调用方都用 `randomUUID()`），但 `join` 遇到 `..` / 绝对路径会逃出工作区根目录，
 * 而契约 §5 的签名本身不做任何形状约束 —— 这是一处「将来必然被踩」的接缝，所以在入口就拦掉。
 */
function assertRunId(runId: string): void {
  if (runId === '' || runId.startsWith('.') || /[\\/]/.test(runId) || runId.includes('..')) {
    throw new ServiceError('INVALID_QUERY', `评测 id 形状不合法：${runId}`, { context: { runId } });
  }
}

/** 取单个快照：不存在抛 NOT_FOUND，损坏抛 INTERNAL（两者都带路径，便于直接去磁盘上核对） */
export function getRun(runId: string): EvalRun {
  assertRunId(runId);
  const file = runSnapshotFile(workspaceRoot(), runId);
  if (!existsSync(file)) {
    throw new ServiceError('NOT_FOUND', `评测不存在：${runId}`, { context: { runId } });
  }
  const run = readSnapshot(file);
  if (run === null) {
    // 具体原因已经由 readSnapshot 记进 WARN 日志；对外只给可展示的中文原因 + 路径
    throw new ServiceError('INTERNAL', `评测快照读不出（文件可能损坏）：${file}`, { context: { file } });
  }
  return run;
}

/**
 * 目标文件是否只读。用于区分 rename 覆盖失败的两种成因（口径同 config-store）。
 * Windows 无 POSIX 权限位，libuv 用写位表达文件系统的只读属性（只读文件报 0444），
 * 故判断 `(mode & 0o200) === 0` 在两个平台都成立。
 * 文件不存在时返回 false：目标不存在就无需删除，rename 会直接创建它。
 */
function isReadOnly(file: string): boolean {
  const stat = statSync(file, { throwIfNoEntry: false });
  return stat !== undefined && (stat.mode & 0o200) === 0;
}

/**
 * 原子写快照：建运行目录 → 写临时文件 → rename 覆盖。
 * 每次都整体覆盖（调用方传的是完整快照）——不做增量合并，避免出现「两份真相」。
 */
export function saveRun(run: EvalRun): void {
  assertRunId(run.id);
  const root = workspaceRoot();
  mkdirSync(runDir(root, run.id), { recursive: true });
  const file = runSnapshotFile(root, run.id);
  const tmp = `${file}.tmp`;
  // 快照里含错误堆栈与本机路径：创建时就给 0600（先建后 chmod 之间有一个短暂的可读窗口）
  writeFileSync(tmp, `${JSON.stringify(run, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    renameSync(tmp, file);
  } catch (error) {
    // rename 覆盖失败有两种成因，症状同为 EPERM、处置却相反（口径照 config-store，别只抄「同口径」四个字）：
    //   ① 目标只读——替换只读文件在 Windows 上必失败，只能先删目标再重命名；
    //   ② 杀软 / 索引器瞬时占用——纯粹的瞬时失败，重试 rename 就过去了。
    // 把 ② 当成 ① 处理（无条件先删目标）会**白白**制造「快照不存在」的窗口：删除与重命名之间的
    // getRun / SSE 读到的是 NOT_FOUND，而这一刻正是「这一轮写不进磁盘」的故障现场——排障的人会先怀疑
    // 数据丢了，而不是磁盘被占。故只有目标确实只读时才删。
    const readOnly = isReadOnly(file);
    log.warn('rename 覆盖运行快照失败，按目标是否只读决定是否先删除', {
      file,
      readOnly,
      reason: error instanceof Error ? error.message : String(error),
    });
    if (readOnly) rmSync(file, { force: true });
    try {
      renameSync(tmp, file);
    } catch (retryError) {
      // 重试仍失败：把裸 errno 折成可展示的中文原因 + 路径（调用方要处置的是「这一轮写不进磁盘」）。
      // 目标文件保持原样（上面没删它），新内容留在 `run.json.tmp` 里供排查——宁可报错，不静默丢数据。
      throw new ServiceError(
        'INTERNAL',
        `运行快照写入失败（${file}）：${retryError instanceof Error ? retryError.message : String(retryError)}`,
        { cause: retryError, context: { file, tmp } },
      );
    }
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @aieval/evaluator test -- run-store.test.ts`
Expected: PASS（13 个用例：原 10 条 + 修复轮补的 3 条 rename 守卫，见 R-p2-E；计划原写「9 个用例」是笔误）。

Run: `pnpm typecheck`
Expected: 零错误。

- [ ] **Step 5: 更新 `packages/server/evaluator/src/index.ts`**

当前该文件只有一行 `export {};`，替换为（保留分组风格：本阶段只有 run-store，p4 会往这里追加编排与评分）：

```ts
/** evaluator 公共出口：运行快照读写（p4 会在此追加编排、评分与事件总线）。 */
export { getRun, listRuns, listRunsForCase, saveRun } from './run-store';
```

Run: `pnpm --filter @aieval/evaluator test`
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add packages/server/evaluator/src/run-store.ts packages/server/evaluator/src/run-store.test.ts packages/server/evaluator/src/index.ts
git commit -m "feat(evaluator): 运行快照读写（listRuns / listRunsForCase / getRun / saveRun）"
```

---

## Task 2: `api` 用例服务层

**Files:**
- Create: `packages/server/api/src/cases.ts`
- Create: `packages/server/api/src/cases.test.ts`
- Modify: `packages/server/api/src/index.ts`

**Interfaces:**
- Consumes（契约 §3 / §5 / §6）：`@aieval/core` 的 `resolveRepoInfo` / `assertCommit` / `listCommits` / `caseCacheDir` / `loadConfig` / `saveConfig` / `getConfigDir` / `createLogger`；`@aieval/evaluator` 的 `listRunsForCase`（Task 1）；本包 `./settings` 的 `getSettings`（已有）
- Produces（契约 §6，逐字）：
  - `listCases(): TestCase[]`
  - `getCase(caseId: string): TestCase`
  - `createCase(input: CaseCreate): TestCase`
  - `updateCase(caseId: string, patch: CasePatch): TestCase`
  - `deleteCase(caseId: string): { affectedRuns: number }`
  - `validateRepo(repoPath: string): RepoInfo`
  - `listCommitCandidates(repoPath: string): CommitCandidate[]`

- [ ] **Step 1: 写失败测试 `cases.test.ts`**

```ts
// @vitest-environment node
/**
 * 用例服务：CRUD、仓库 / commit 校验、删除时清理缓存仓库，以及「删了用例之后评测记录还读得到」。
 *
 * 仓库一律是 mkdtempSync 出来的**真实临时 git 仓库**（git 原语不许 mock——mock 掉的正是最容易错的地方），
 * 配置目录一律指向临时目录，绝不碰真实的 ~/.aieval 与真实仓库。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SETTINGS_DEFAULTS, ServiceError, type EvalRun } from '@aieval/contracts';
import { getConfigDir, loadConfig, saveConfig, setConfigDirForTesting } from '@aieval/core';
import { getRun, saveRun } from '@aieval/evaluator';
import {
  createCase,
  deleteCase,
  getCase,
  listCases,
  listCommitCandidates,
  updateCase,
  validateRepo,
} from './cases';

// 「缓存删不掉」这条守卫要把 rmSync 打挂一次（真实的 EPERM 在 CI 上造不出来）。
// 只替换 rmSync，其余导出原样透传，config-store / run-store 照常走真实文件系统。
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, rmSync: vi.fn(actual.rmSync) };
});

let dir: string;
let ws: string;
let repo: string;

/** 跑一条 git 命令：身份用 -c 显式给，避免依赖宿主机的 user.name / user.email 配置 */
function git(args: string[], cwd: string): string {
  return execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args], {
    cwd,
    encoding: 'utf8',
  });
}

/**
 * 造一个真实仓库：返回各次提交的完整 hash（索引 0 是最早的）。
 * `name` 必须由调用方给：同一个用例里要造第二个仓库时，固定目录名会让两个仓库互相覆盖。
 */
function makeRepo(name: string, commitCount: number): { dir: string; hashes: string[] } {
  const repoDir = join(dir, name);
  mkdirSync(repoDir, { recursive: true });
  git(['init', '-q'], repoDir);
  const hashes: string[] = [];
  for (let index = 1; index <= commitCount; index += 1) {
    writeFileSync(join(repoDir, `file-${index}.txt`), `第 ${index} 次提交\n`, 'utf8');
    git(['add', '.'], repoDir);
    git(['commit', '-q', '-m', `第 ${index} 次提交`], repoDir);
    hashes.push(git(['rev-parse', 'HEAD'], repoDir).trim());
  }
  return { dir: repoDir, hashes };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aieval-cases-'));
  ws = join(dir, 'runs');
  mkdirSync(ws, { recursive: true });
  setConfigDirForTesting(dir);
  saveConfig({ ...loadConfig(), settings: { ...SETTINGS_DEFAULTS, workspaceRoot: ws } });
  repo = makeRepo('repo', 1).dir;
});

afterEach(() => {
  setConfigDirForTesting(null);
  rmSync(dir, { recursive: true, force: true });
});

/** 建用例的最小入参（各个用例只覆盖自己关心的字段） */
function caseInput(overrides: Partial<Parameters<typeof createCase>[0]> = {}): Parameters<typeof createCase>[0] {
  return {
    title: '为网关补齐转换回归',
    repoPath: repo,
    commitHash: null,
    taskPrompt: '为 anthropic-to-chat 补一条回归用例',
    judgePrompt: '按五维评分，重点看是否真的补了用例',
    judgeProviderId: null,
    judgeModelId: null,
    ...overrides,
  };
}

/** 造一个引用某用例的运行快照（走真实的 saveRun，而不是手写 run.json） */
function makeRun(runId: string, caseId: string, caseTitle: string, repoPath: string, commitHash: string | null): EvalRun {
  return {
    id: runId,
    caseId,
    caseTitle,
    repoPath,
    commitHash,
    status: 'done',
    executionMode: 'parallel',
    rows: [],
    workspaceBase: ws,
    createdAt: '2026-09-22T10:00:00.000Z',
    startedAt: '2026-09-22T10:00:01.000Z',
    finishedAt: '2026-09-22T10:05:00.000Z',
  };
}

describe('createCase / listCases / getCase', () => {
  it('创建后落盘：时间戳是 ISO、id 是 UUID 形态、commitHash 为 null 表示默认 HEAD', () => {
    const created = createCase(caseInput());

    expect(created.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(created.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
    expect(created.commitHash).toBeNull();
    // 落盘是它唯一的价值：重新读配置必须能拿到（响应体是内存对象，证明不了持久化）
    expect(loadConfig().cases.map((item) => item.id)).toEqual([created.id]);
    expect(getCase(created.id)).toEqual(created);
  });

  it('commitHash 传空串时归一成 null（表单清空输入框拿到的是空串）', () => {
    const created = createCase(caseInput({ commitHash: '' }));

    expect(created.commitHash).toBeNull();
  });

  it('短哈希被解析成完整 40 位 hash 落盘（否则列表的 Tooltip 显不出全量）', () => {
    const fullHash = git(['rev-parse', 'HEAD'], repo).trim();

    const created = createCase(caseInput({ commitHash: fullHash.slice(0, 7) }));

    expect(created.commitHash).toBe(fullHash);
    expect(created.commitHash).toHaveLength(40);
  });

  it('仓库不是 git 仓库时抛 NOT_A_GIT_REPO，且不落盘', () => {
    const notRepo = join(dir, 'plain-dir');
    mkdirSync(notRepo, { recursive: true });

    let caught: unknown;
    try {
      createCase(caseInput({ repoPath: notRepo }));
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ServiceError);
    expect((caught as ServiceError).code).toBe('NOT_A_GIT_REPO');
    expect(loadConfig().cases).toEqual([]);
  });

  it('commit hash 不存在时抛 INVALID_REF，且不落盘', () => {
    let caught: unknown;
    try {
      createCase(caseInput({ commitHash: 'f'.repeat(40) }));
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ServiceError);
    expect((caught as ServiceError).code).toBe('INVALID_REF');
    expect(loadConfig().cases).toEqual([]);
  });

  // Review Focus 1 的服务端一侧：候选下拉只是便利，**不是白名单**。
  // 造 25 次提交，取最早那次（它必然不在「最近 20 条」里）——它必须能存进去。
  it('createCase 接受不在最近 20 条候选里的真实 commit（候选不是白名单）', () => {
    const { dir: manyRepo, hashes } = makeRepo('many-repo', 25);
    const oldest = hashes[0]!;

    const created = createCase(caseInput({ repoPath: manyRepo, commitHash: oldest }));

    expect(created.commitHash).toBe(oldest);
    // 顺带确认它确实不在候选里（否则这条用例等于没测到白名单这个风险）
    expect(listCommitCandidates(manyRepo).map((commit) => commit.hash)).not.toContain(oldest);
  });

  it('标题全空白时按契约拒绝落盘（trim 之后不满足 min(1)）', () => {
    let caught: unknown;
    try {
      createCase(caseInput({ title: '   ' }));
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeDefined();
    expect(loadConfig().cases).toEqual([]);
  });

  // 时间的分辨率是毫秒：两次操作之间必须隔开一格，否则 updatedAt 相同、排序落到 id 兜底上，测试会随机飘。
  // 改的必须是**后建**的那条：配置文件里的插入序是 [first, second]，而更新时间倒序是 [second, first]——
  // 两个顺序在这里必须不同，否则「整条 sort 删掉」也能让本用例通过（变异验证实测：改 first 时它是空转的，见 R-p2-E）。
  it('listCases 按更新时间倒序（最近动过的用例在最上面）', async () => {
    const first = createCase(caseInput({ title: '先建的' }));
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = createCase(caseInput({ title: '后建的' }));
    await new Promise((resolve) => setTimeout(resolve, 5));

    updateCase(second.id, { title: '后建的（刚改过）' });

    expect(listCases().map((item) => item.id)).toEqual([second.id, first.id]);
  });

  // 成功日志只能在**真正落盘之后**打：被拒绝的保存留下「创建用例」的 INFO，等于在日志里把失败读成成功。
  it('保存被拒绝时不留「创建用例」成功日志（日志只在写盘成功后打）', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      // 正向对照：同一探针下，真正落盘的创建必须留下这条 INFO（否则下面的 not.toContain 是空转）
      createCase(caseInput({ title: '正常用例' }));
      expect(logSpy.mock.calls.flat().join(' ')).toContain('创建用例');

      logSpy.mockClear();
      expect(() => createCase(caseInput({ title: '   ' }))).toThrow();
      expect(logSpy.mock.calls.flat().join(' ')).not.toContain('创建用例');
    } finally {
      logSpy.mockRestore();
    }
  });

  it('getCase 对不存在的 id 抛 NOT_FOUND', () => {
    let caught: unknown;
    try {
      getCase('missing');
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ServiceError);
    expect((caught as ServiceError).code).toBe('NOT_FOUND');
  });
});

describe('updateCase', () => {
  it('只改传入的字段，其余保持原值，并刷新 updatedAt', async () => {
    const created = createCase(caseInput());
    // 时间戳分辨率是毫秒：等一格再改，否则 updatedAt 与 createdAt 相同会让「刷新了没有」无从判断
    await new Promise((resolve) => setTimeout(resolve, 5));

    const next = updateCase(created.id, { title: '改了标题' });

    expect(next.title).toBe('改了标题');
    expect(next.taskPrompt).toBe(created.taskPrompt);
    expect(next.judgePrompt).toBe(created.judgePrompt);
    expect(next.updatedAt >= created.updatedAt).toBe(true);
  });

  // Review Focus 2：仓库临时不可用（网络盘掉线、目录被移走）时，改标题不该被 NOT_A_GIT_REPO 拦住。
  it('只改标题时不做仓库校验（仓库已被移走也照样保存）', () => {
    const created = createCase(caseInput());
    rmSync(repo, { recursive: true, force: true });

    const next = updateCase(created.id, { title: '仓库掉线时改标题' });

    expect(next.title).toBe('仓库掉线时改标题');
    expect(loadConfig().cases[0]?.title).toBe('仓库掉线时改标题');
  });

  it('改动 repoPath 时校验新路径（不是 git 仓库则拒绝且不落盘）', () => {
    const created = createCase(caseInput());
    const notRepo = join(dir, 'plain-dir');
    mkdirSync(notRepo, { recursive: true });

    expect(() => updateCase(created.id, { repoPath: notRepo })).toThrow(ServiceError);
    expect(loadConfig().cases[0]?.repoPath).toBe(repo);
  });

  it('换仓库且未显式给 commit 时，把旧 commit 拿到新仓库里再确认一次（不存在则 INVALID_REF）', () => {
    // 另一个独立仓库：它的对象库里没有旧仓库的提交，所以旧 commit 在它里面必然不存在
    const { dir: otherRepo } = makeRepo('other-repo', 1);
    const created = createCase(caseInput({ commitHash: git(['rev-parse', 'HEAD'], repo).trim() }));

    let caught: unknown;
    try {
      updateCase(created.id, { repoPath: otherRepo });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ServiceError);
    expect((caught as ServiceError).code).toBe('INVALID_REF');
    expect(loadConfig().cases[0]?.repoPath).toBe(repo);
  });

  it('可以显式把 commitHash 改回 null（= 回到默认分支 HEAD）', () => {
    const created = createCase(caseInput({ commitHash: git(['rev-parse', 'HEAD'], repo).trim() }));

    const next = updateCase(created.id, { commitHash: null });

    expect(next.commitHash).toBeNull();
  });

  it('updateCase 对不存在的 id 抛 NOT_FOUND', () => {
    expect(() => updateCase('missing', { title: 'x' })).toThrow(ServiceError);
  });
});

describe('deleteCase', () => {
  it('删除后列表里没有它，返回受影响评测数（数的是引用它的快照）', () => {
    const created = createCase(caseInput());
    const other = createCase(caseInput({ title: '另一个用例' }));
    saveRun(makeRun('run-1', created.id, created.title, created.repoPath, null));
    saveRun(makeRun('run-2', created.id, created.title, created.repoPath, null));
    saveRun(makeRun('run-3', other.id, other.title, other.repoPath, null));

    const result = deleteCase(created.id);

    expect(result.affectedRuns).toBe(2);
    expect(listCases().map((item) => item.id)).toEqual([other.id]);
  });

  // 真实场景里缓存目录常常压根不存在（第一次评测还没跑）。它绝不能让「删用例」失败。
  it('缓存目录不存在时删除照样成功', () => {
    const created = createCase(caseInput());

    expect(deleteCase(created.id)).toEqual({ affectedRuns: 0 });
  });

  it('一并删除用例级缓存仓库 {workspaceRoot}/cases/{caseId}/cache', () => {
    const created = createCase(caseInput());
    const cacheDir = join(ws, 'cases', created.id, 'cache');
    mkdirSync(join(cacheDir, '.git'), { recursive: true });
    writeFileSync(join(cacheDir, 'README.md'), '缓存仓库内容', 'utf8');
    expect(existsSync(cacheDir)).toBe(true);

    deleteCase(created.id);

    expect(existsSync(cacheDir)).toBe(false);
  });

  // Review Focus 4：缓存删不掉（Windows 上文件被占用、目录被别的进程锁住）不阻断删除本身。
  // 制造失败的方式是**把 rmSync 打挂一次**，而不是造一个「删不掉的目录」：
  // 后者在 CI 上不可靠（Node 的 rmSync 对文件路径会直接 unlink、对空目录总能删掉），
  // 断言会变成「删成功了也叫失败被容忍」的空转。
  it('缓存删除失败不阻断删除（用例照样从配置里消失，只记一条 WARN）', () => {
    const created = createCase(caseInput());
    vi.mocked(rmSync).mockImplementationOnce(() => {
      throw new Error('EPERM: operation not permitted, rmdir');
    });

    const result = deleteCase(created.id);

    expect(result.affectedRuns).toBe(0);
    expect(loadConfig().cases).toEqual([]);
  });

  // 守的是 spec §4.4 的核心承诺：评测记录靠 EvalRun 的冗余快照继续可读。
  // 变异体见下方 Step 5——把「顺手删掉相关运行目录」这种看似合理的实现制造回去，本用例必须失败。
  it('删除用例后，引用它的评测记录仍可读，且 caseTitle / repoPath / commitHash 快照仍在', () => {
    const created = createCase(caseInput({ commitHash: git(['rev-parse', 'HEAD'], repo).trim() }));
    saveRun(makeRun('run-1', created.id, created.title, created.repoPath, created.commitHash));

    deleteCase(created.id);

    const run = getRun('run-1');
    expect(run.caseId).toBe(created.id);
    expect(run.caseTitle).toBe(created.title);
    expect(run.repoPath).toBe(created.repoPath);
    expect(run.commitHash).toBe(created.commitHash);
    expect(run.status).toBe('done');
  });

  it('deleteCase 对不存在的 id 抛 NOT_FOUND', () => {
    expect(() => deleteCase('missing')).toThrow(ServiceError);
  });
});

describe('validateRepo / listCommitCandidates', () => {
  it('validateRepo 回显仓库名与当前分支', () => {
    const info = validateRepo(repo);

    expect(info.repoPath).toBe(repo);
    expect(info.repoName).toBe('repo');
    expect(info.branch.length).toBeGreaterThan(0);
  });

  it('validateRepo 对非 git 目录抛 NOT_A_GIT_REPO（含原因）', () => {
    const notRepo = join(dir, 'plain-dir');
    mkdirSync(notRepo, { recursive: true });

    let caught: unknown;
    try {
      validateRepo(notRepo);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ServiceError);
    expect((caught as ServiceError).code).toBe('NOT_A_GIT_REPO');
  });

  it('listCommitCandidates 返回短哈希 + 提交说明（默认最近 20 条）', () => {
    const commits = listCommitCandidates(repo);

    expect(commits).toHaveLength(1);
    expect(commits[0]?.hash).toHaveLength(7);
    expect(commits[0]?.subject).toBe('第 1 次提交');
  });

  it('路径两侧带空白时先 trim（从资源管理器复制路径常带尾部空格）', () => {
    expect(validateRepo(` ${repo} `).repoName).toBe('repo');
  });
});

// 保存失败时对外必须是可直接展示的中文原因，而不是裸 errno。
// 这条用「把配置目录换成一个被文件占住的路径」来制造真实的写盘失败。
it('配置写盘失败时折成带配置目录的 INTERNAL 中文错误', () => {
  const occupied = join(dir, 'occupied-config');
  writeFileSync(occupied, 'x', 'utf8');
  setConfigDirForTesting(occupied);

  let caught: unknown;
  try {
    createCase(caseInput());
  } catch (error) {
    caught = error;
  }

  expect(caught).toBeInstanceOf(ServiceError);
  expect((caught as ServiceError).code).toBe('INTERNAL');
  expect((caught as ServiceError).message).toContain('用例保存失败');
  expect((caught as ServiceError).message).toContain(getConfigDir());
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @aieval/api test -- cases.test.ts`
Expected: FAIL —— `Failed to resolve import "./cases"`。

- [ ] **Step 3: 写实现 `cases.ts`**

```ts
/**
 * 用例服务：CRUD + 仓库 / commit 校验 + 删除时一并清掉用例级缓存仓库。
 *
 * 三条口径：
 *   1. **只校验本次改动到的字段**：仓库临时不可用（网络盘掉线、目录被移走）时，
 *      改标题 / 改提示词不该被 NOT_A_GIT_REPO 拦住——与设置域「只改主题不校验工作区根目录」同一口径；
 *   2. **commitHash 一律落解析后的完整 40 位 hash**：短哈希会随仓库增长变得有歧义，而 §4.1 的列表
 *      要能 Tooltip 显全量；null / 空串（表单清空输入框拿到的是空串）都表示「默认分支 HEAD」；
 *   3. **删除时缓存仓库删不掉不阻断删除**：缓存只是磁盘垃圾（首次评测前压根不存在、Windows 上可能被占用），
 *      让它把「删用例」这个用户动作弄失败，是把内部细节泄漏成用户故障。
 */
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import {
  ServiceError,
  TestCaseSchema,
  type CaseCreate,
  type CasePatch,
  type CommitCandidate,
  type RepoInfo,
  type TestCase,
} from '@aieval/contracts';
import {
  assertCommit,
  caseCacheDir,
  createLogger,
  getConfigDir,
  listCommits,
  loadConfig,
  resolveRepoInfo,
  saveConfig,
  type AppConfig,
} from '@aieval/core';
import { listRunsForCase } from '@aieval/evaluator';
import { getSettings } from './settings';

const log = createLogger('cases');

/**
 * 列表：最近改动的用例在最前。
 * 同一毫秒创建的两条按 id 兜底排序——否则顺序依赖 Array.sort 的实现细节，测试会随机飘。
 */
export function listCases(): TestCase[] {
  return [...loadConfig().cases].sort((a, b) => {
    if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** 取单个用例；不存在抛 NOT_FOUND（路由层映射成 404） */
export function getCase(caseId: string): TestCase {
  const found = loadConfig().cases.find((item) => item.id === caseId);
  if (found === undefined) {
    throw new ServiceError('NOT_FOUND', `用例不存在：${caseId}`, { context: { caseId } });
  }
  return found;
}

/** 新建用例：先校验仓库与 commit（§10 要求这两个场景在写入前被拦下），再落盘 */
export function createCase(input: CaseCreate): TestCase {
  const repoPath = input.repoPath.trim();
  const repoInfo = resolveRepoInfo(repoPath);
  const now = new Date().toISOString();
  const created: TestCase = {
    id: randomUUID(),
    title: input.title.trim(),
    repoPath,
    commitHash: resolveCommitInput(repoPath, input.commitHash),
    taskPrompt: input.taskPrompt,
    judgePrompt: input.judgePrompt,
    // null 是契约里的合法取值（= 跟随全局默认），所以这里用 ?? 补 undefined 而不是判 falsy
    judgeProviderId: input.judgeProviderId ?? null,
    judgeModelId: input.judgeModelId ?? null,
    createdAt: now,
    updatedAt: now,
  };
  // R32②：新建时**一律**校验——还没有「与仓库无关的编辑」这回事，半配置没有存在的理由。
  // 契约 R32③ 明确**不**给 TestCaseSchema 加这条 refine：历史半配置用例必须仍然可见，
  // 否则它会在列表里凭空消失。
  assertJudgePair(created.judgeProviderId, created.judgeModelId, { caseId: created.id });
  const config = loadConfig();
  const stored = assertStorable(created);
  config.cases = [...config.cases, stored];
  saveCases(config);
  // 成功日志必须在**落盘之后**打（`updateCase` 同口径）：校验不过或写盘失败时留下一条「创建用例」的 INFO，
  // 会让排障的人把一次被拒绝的保存读成成功——日志是这一刻唯一的旁证（见 R-p2-E）。
  log.info('创建用例', { caseId: stored.id, repoName: repoInfo.repoName, branch: repoInfo.branch });
  return stored;
}

/**
 * 评分模型的用例级覆盖是**全有或全无**（契约 §11 R32②）：两列必须同时有值或同时为 null。
 *
 * 为什么写侧也要拦（而不是只靠判定侧的诚实提示）：服务端 `resolveJudgeRoute` 对半配置是直接抛 CONFLICT、
 * 不回落全局默认，所以半配置是一条**必然失败**的配置；而它一旦落盘就会持续存在——编辑表单把这两列原样交回，
 * 界面上只能提示、清不掉。理由同「坏值必须在写入口拦下」的 `assertStorable`。
 * 读路径（`TestCaseSchema`）**刻意不加**这条 refine（R32③）：历史半配置用例必须仍然可见、仍然可编辑标题。
 */
function assertJudgePair(
  judgeProviderId: string | null,
  judgeModelId: string | null,
  context: Record<string, unknown>,
): void {
  if ((judgeProviderId === null) !== (judgeModelId === null)) {
    throw new ServiceError(
      'INVALID_QUERY',
      '评分模型必须同时指定供应商与模型（只填一个等于半个配置）；不指定就都留空以跟随默认评分模型',
      { context: { ...context, judgeProviderId, judgeModelId } },
    );
  }
}

/**
 * 更新用例：只校验本次改动到的字段（见文件头口径 1）。
 * 两个容易写错的点：
 *   - `null` 是合法取值（清空评分模型 = 跟随全局默认），所以判的是 `undefined` 而不是 falsy；
 *   - 只换仓库、没给新 commit 时，旧 commit 必须拿到**新仓库**里再确认一次：留着它只会让这一轮评测
 *     在准备阶段失败（§5.5 第 2 步），宁可在保存时以 INVALID_REF 拦下。
 */
export function updateCase(caseId: string, patch: CasePatch): TestCase {
  const config = loadConfig();
  const current = config.cases.find((item) => item.id === caseId);
  if (current === undefined) {
    throw new ServiceError('NOT_FOUND', `用例不存在：${caseId}`, { context: { caseId } });
  }

  // 「本次没改」= 值没变，**不是** `!== undefined`：UI 的表单提交永远是**全量字段**
  // （`repoPath` 是注册过的必填 Form.Item，编辑时被 initialValues 预填），所以按 `undefined` 判定
  // 等于**每次保存**都跑一遍仓库与 commit 校验——仓库临时不可用（网络盘掉线/目录被移走）时，
  // 用户连标题、提示词都改不动，只能先把仓库恢复出来（p2 阶段评审的 High F1）。
  const repoChanged = patch.repoPath !== undefined && patch.repoPath.trim() !== current.repoPath;
  const repoPath = repoChanged ? patch.repoPath!.trim() : current.repoPath;
  if (repoChanged) resolveRepoInfo(repoPath);

  // commit 同理：值没变就不重校验；但**仓库变了**时哪怕 commit 值没变也要拿到新仓库里再确认一次
  const commitTouched = patch.commitHash !== undefined && patch.commitHash !== current.commitHash;
  const commitHash = patch.commitHash !== undefined
    ? commitTouched || repoChanged
      ? resolveCommitInput(repoPath, patch.commitHash)
      : current.commitHash
    : repoChanged && current.commitHash !== null
      ? resolveCommitInput(repoPath, current.commitHash)
      : current.commitHash;

  // R32②：**只在 patch 触及评分字段时**校验**合并后**的两列。
  // 不无条件校验是为了不阻塞「修好一条历史半配置用例的标题」这类无关编辑；而只要这次写到了评分字段，
  // 合并后的结果就必须成对——半配置对服务端 resolveJudgeRoute 是一次必然的 CONFLICT，写进去只会一直留着。
  // 「触及」必须按**值**判，不能按「字段出现没有」判：UI 的补丁**永远全量**
  // （`case-form-panel.tsx` 的 handleFinish 无条件回交这两个评分字段），按出现判定等于判据恒真，
  // 于是一条历史半配置用例只要在界面上保存（哪怕只改标题）就会被这条校验拦下（HTTP 400）——
  // 与文件头口径 1 的承诺相反。这个形状在 p2 的 High F1 上出现过一次，收口复审的 N1 又出现一次。
  const judgeTouched =
    (patch.judgeProviderId !== undefined && patch.judgeProviderId !== current.judgeProviderId) ||
    (patch.judgeModelId !== undefined && patch.judgeModelId !== current.judgeModelId);
  const nextProviderId = patch.judgeProviderId === undefined ? current.judgeProviderId : patch.judgeProviderId;
  const nextModelId = patch.judgeModelId === undefined ? current.judgeModelId : patch.judgeModelId;
  if (judgeTouched) {
    assertJudgePair(nextProviderId, nextModelId, { caseId });
  }

  const next: TestCase = {
    ...current,
    ...(patch.title === undefined ? {} : { title: patch.title.trim() }),
    repoPath,
    commitHash,
    ...(patch.taskPrompt === undefined ? {} : { taskPrompt: patch.taskPrompt }),
    ...(patch.judgePrompt === undefined ? {} : { judgePrompt: patch.judgePrompt }),
    judgeProviderId: nextProviderId,
    judgeModelId: nextModelId,
    updatedAt: new Date().toISOString(),
  };
  const stored = assertStorable(next);
  config.cases = config.cases.map((item) => (item.id === caseId ? stored : item));
  saveCases(config);
  log.info('用例已更新', { caseId });
  return stored;
}

/**
 * 删除用例：返回受影响的评测数，并清掉用例级缓存仓库。
 * **评测记录本身不删**——它带着 caseTitle / repoPath / commitHash 的冗余快照，删了用例照样可读（§4.4）。
 */
export function deleteCase(caseId: string): { affectedRuns: number } {
  const config = loadConfig();
  const target = config.cases.find((item) => item.id === caseId);
  if (target === undefined) {
    throw new ServiceError('NOT_FOUND', `用例不存在：${caseId}`, { context: { caseId } });
  }

  // 引用数在删除前数：返回值要能回答「这次删除影响了多少评测」
  const affectedRuns = listRunsForCase(caseId).length;

  config.cases = config.cases.filter((item) => item.id !== caseId);
  saveCases(config);
  log.info('用例已删除', { caseId, affectedRuns });

  removeCaseCache(caseId);
  return { affectedRuns };
}

/** 仓库校验直通 core（trim 后交给 git：从资源管理器复制的路径常带尾部空白） */
export function validateRepo(repoPath: string): RepoInfo {
  return resolveRepoInfo(repoPath.trim());
}

/** commit 候选直通 core（默认最近 20 条，见契约 §3.2） */
export function listCommitCandidates(repoPath: string): CommitCandidate[] {
  return listCommits(repoPath.trim());
}

/**
 * 删掉用例级缓存仓库（§4.4）。**尽力而为**：失败只记 WARN。
 * 缓存目录常常压根不存在（首次评测前），也可能因为 Windows 上文件被占用而删不掉——
 * 两种情形都不该让「删除用例」这个用户动作失败。
 */
function removeCaseCache(caseId: string): void {
  const cacheDir = caseCacheDir(getSettings().workspaceRoot, caseId);
  try {
    rmSync(cacheDir, { recursive: true, force: true });
  } catch (error) {
    log.warn('用例级缓存仓库删除失败（用例已删除，缓存残留）', {
      cacheDir,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * commit 输入归一化：null / undefined / 空串都表示「默认分支 HEAD」；
 * 其余一律交给 core.assertCommit 判定（不存在 → INVALID_REF），并把短哈希解析成完整 40 位。
 * **不在这里比对候选列表**：候选只是便利（§4.2），拿它当白名单会把「钉一个更早的提交」变成不可能。
 */
function resolveCommitInput(repoPath: string, commitHash: string | null | undefined): string | null {
  if (commitHash === null || commitHash === undefined) return null;
  const trimmed = commitHash.trim();
  if (trimmed === '') return null;
  return assertCommit(repoPath, trimmed);
}

/**
 * 落盘前按契约自检：配置文件是所有人共享的真相，写进去的每个用例都必须满足 TestCaseSchema。
 * 不做这层的话，坏值（例如全空白标题被 trim 成空串）要等到下一次读取或列表渲染时才炸，
 * 那时已经离出错点很远了。
 */
function assertStorable(testCase: TestCase): TestCase {
  return TestCaseSchema.parse(testCase);
}

/** 保存配置：把 saveConfig 的原始 errno（EPERM / ENOSPC / 只读盘）折成可直接展示的中文原因 */
function saveCases(config: AppConfig): void {
  try {
    saveConfig(config);
  } catch (error) {
    throw error instanceof ServiceError
      ? error
      : new ServiceError('INTERNAL', `用例保存失败（${getConfigDir()}）：${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @aieval/api test -- cases.test.ts`
Expected: PASS。

- [ ] **Step 5: 变异验证（两条守卫）**

在 Task 2 的提交之后做（第 7 步提交完再回到这里），这样还原只需要 `git checkout --`：

```pwsh
$file = 'packages/server/api/src/cases.ts'
$before = git hash-object $file
```

**变异体 ①（删用例时顺手删掉评测产物）**：在 `deleteCase` 的 `removeCaseCache(caseId);` **之前**插入这段错误实现（模拟「删用例时把它的评测产物一起清掉」这个看似合理的写法）：

```ts
  // 变异体（故意写错）：删用例时连带删掉引用它的运行目录
  for (const run of listRunsForCase(caseId)) {
    rmSync(runDir(getSettings().workspaceRoot, run.id), { recursive: true, force: true });
  }
```

（同时把 `runDir` 加进 `@aieval/core` 的 import 列表，否则 tsc/eslint 会先报未定义——变异体本身要能跑起来才谈得上验证。）

Run: `pnpm --filter @aieval/api test -- cases.test.ts`
Expected: **FAIL**，失败在 `删除用例后，引用它的评测记录仍可读，且 caseTitle / repoPath / commitHash 快照仍在`，错误是 `ServiceError: 评测不存在：run-1`（`getRun` 找不到快照）。若它仍然通过，说明这条守卫没有区分力，必须改断言。

先还原，再做第二个变异体：

```pwsh
git checkout -- packages/server/api/src/cases.ts
git diff --quiet -- packages/server/api/src/cases.ts; if ($LASTEXITCODE -ne 0) { throw '还原不彻底' }
```

**变异体 ②（把候选列表当白名单）**：把 `resolveCommitInput` 改成必须命中最近 20 条候选：

```ts
function resolveCommitInput(repoPath: string, commitHash: string | null | undefined): string | null {
  if (commitHash === null || commitHash === undefined) return null;
  const trimmed = commitHash.trim();
  if (trimmed === '') return null;
  // 变异体（故意写错）：必须在最近候选列表里
  if (!listCommits(repoPath).some((commit) => commit.hash === trimmed)) {
    throw new ServiceError('INVALID_REF', `提交不在最近候选列表里：${trimmed}`);
  }
  return assertCommit(repoPath, trimmed);
}
```

Run: `pnpm --filter @aieval/api test -- cases.test.ts`
Expected: **FAIL**，其中必有 `createCase 接受不在最近 20 条候选里的真实 commit（候选不是白名单）`（抛 `INVALID_REF: 提交不在最近候选列表里`）。
说明：`listCommits` 给的是 7 位短哈希，所以凡是传完整 40 位 hash 的用例（例如「删除用例后快照仍可读」）也会一起失败——这正说明这条白名单规则有多容易误伤，别把「多失败了几条」当成测试写错了。

还原并核对：

```pwsh
git checkout -- packages/server/api/src/cases.ts
git diff --quiet -- packages/server/api/src/cases.ts; if ($LASTEXITCODE -ne 0) { throw '还原不彻底' }
$after = git hash-object $file
if ($before -ne $after) { throw "哈希不一致：$before -> $after" }
git status --short
```

Expected: 无输出（工作树干净），且哈希一致。

- [ ] **Step 6: 更新 `packages/server/api/src/index.ts`**

```ts
/** api 公共出口：业务服务层，框架层只从这里 import。 */
export { getSettings, updateSettings } from './settings';
export {
  createCase,
  deleteCase,
  getCase,
  listCases,
  listCommitCandidates,
  updateCase,
  validateRepo,
} from './cases';
```

- [ ] **Step 7: 跑全量类型检查与提交**

Run: `pnpm typecheck`
Expected: 零错误。

```bash
git add packages/server/api/src/cases.ts packages/server/api/src/cases.test.ts packages/server/api/src/index.ts
git commit -m "feat(api): 用例服务层（CRUD / 仓库与 commit 校验 / 删除时清理用例级缓存）"
```

---

## Task 3: `api` 评分提示词生成服务

**Files:**
- Create: `packages/server/api/src/judge.ts`
- Create: `packages/server/api/src/judge.test.ts`
- Modify: `packages/server/api/src/index.ts`

**Interfaces:**
- Consumes（契约 §3 / §5 / §6）：
  - `@aieval/contracts` 的 `DIMENSIONS` / `DIMENSION_COUNT` / `JUDGE_OUTPUT_CONTRACT` / `DimensionKeySchema` / `type DimensionKey` / `type GenerateJudgePromptInput` / `ServiceError`
  - `@aieval/core` 的 `resolveRepoInfo`
  - `@aieval/evaluator` 的 `callTextApi(route, { system?, prompt })` 与 `resolveJudgeRoute({ judgeProviderId, judgeModelId })`
- Produces（契约 §6，逐字；返回类型见「本计划对 spec 的实现层修正」R-p2-C）：
  - `generateJudgePrompt(input: GenerateJudgePromptInput): Promise<{ prompt: string; dimensions: DimensionKey[] }>`
  - `resolveJudgeRoute`（从 `@aieval/evaluator` 转出）

- [ ] **Step 1: 写失败测试 `judge.test.ts`**

```ts
// @vitest-environment node
/**
 * 生成评分提示词：提示词内容、严格 JSON 解析、维度齐全校验，以及「生成是只读操作」。
 *
 * 上游文本调用被整模块替身（只替换 callTextApi，其余导出原样透传）：
 * 这样既能断言「送给模型的提示词里真的带了输出契约与 5 维定义」，
 * 又完全不依赖 p0 那份 HTTP 响应解析的细节（那部分由 Task 7 的路由测试用假 fetch 端到端覆盖）。
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync as readFileRaw, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DIMENSION_COUNT,
  JUDGE_OUTPUT_CONTRACT,
  ServiceError,
  type Provider,
} from '@aieval/contracts';
import { getConfigDir, loadConfig, saveConfig, setConfigDirForTesting } from '@aieval/core';
import { callTextApi, resolveJudgeRoute } from '@aieval/evaluator';
import { generateJudgePrompt, resolveJudgeRoute as resolveJudgeRouteFromApi } from './judge';

vi.mock('@aieval/evaluator', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aieval/evaluator')>();
  return { ...actual, callTextApi: vi.fn(actual.callTextApi) };
});

let dir: string;
let repo: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aieval-judge-'));
  setConfigDirForTesting(dir);
  repo = join(dir, 'gateway');
  mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: repo });
  writeFileSync(join(repo, 'README.md'), '# gateway\n', 'utf8');
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e.com', 'add', '.'], { cwd: repo });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e.com', 'commit', '-q', '-m', 'init'], { cwd: repo });
  vi.mocked(callTextApi).mockReset();
});

afterEach(() => {
  setConfigDirForTesting(null);
  rmSync(dir, { recursive: true, force: true });
});

const PROVIDER: Provider = {
  id: 'provider-1',
  name: 'DeepSeek 官方',
  protocolType: 'openai',
  baseUrl: 'https://api.deepseek.com/v1',
  apiKey: 'sk-test',
  models: [{ id: 'deepseek-chat', source: 'manual' }],
  createdAt: '2026-09-22T10:00:00.000Z',
  updatedAt: '2026-09-22T10:00:00.000Z',
};

/** 在配置里放一个供应商，并把全局默认评分模型指向它 */
function configureGlobalJudge(): void {
  saveConfig({
    ...loadConfig(),
    providers: [PROVIDER],
    // 保留已有设置（含工作区根目录）：测试只该改它关心的字段
    settings: { ...loadConfig().settings, defaultJudge: { providerId: PROVIDER.id, modelId: 'deepseek-chat' } },
  });
}

/** 生成用例的入参（默认走全局评分模型） */
function generateInput(overrides: Partial<Parameters<typeof generateJudgePrompt>[0]> = {}): Parameters<typeof generateJudgePrompt>[0] {
  return {
    repoPath: repo,
    taskPrompt: '为 anthropic-to-chat 补一条回归用例',
    judgeProviderId: null,
    judgeModelId: null,
    ...overrides,
  };
}

/** 让替身返回一段文本（模拟评分模型的回复） */
function modelReplies(text: string): void {
  vi.mocked(callTextApi).mockResolvedValue(text);
}

describe('generateJudgePrompt', () => {
  it('把考题提示词、仓库名、5 维定义与输出契约一起送给模型', async () => {
    configureGlobalJudge();
    modelReplies(JSON.stringify({ prompt: '评分提示词正文', dimensions: ['correctness', 'requirement', 'quality', 'robustness', 'maintainability'] }));

    await generateJudgePrompt(generateInput());

    expect(callTextApi).toHaveBeenCalledTimes(1);
    const [, request] = vi.mocked(callTextApi).mock.calls[0]!;
    // 输出契约必须是 contracts 的那一份（生成侧与解析侧共用同一份字段名，抄一份必然漂移）
    expect(request.prompt).toContain(JUDGE_OUTPUT_CONTRACT);
    expect(request.prompt).toContain('为 anthropic-to-chat 补一条回归用例');
    // 仓库名来自对仓库路径的真实校验（不是路径末段的字符串切分）
    expect(request.prompt).toContain('gateway');
    // 5 维的 key 与中文标签都要出现，否则模型无从写「每维理由」
    for (const keyword of ['correctness', '功能正确性', 'maintainability', '可维护性']) {
      expect(request.prompt).toContain(keyword);
    }
    expect(DIMENSION_COUNT).toBe(5);
  });

  it('解析出 prompt 与 dimensions', async () => {
    configureGlobalJudge();
    modelReplies(JSON.stringify({ prompt: ' 评分提示词正文 ', dimensions: ['correctness', 'requirement', 'quality', 'robustness', 'maintainability'] }));

    const result = await generateJudgePrompt(generateInput());

    expect(result.prompt).toBe(' 评分提示词正文 ');
    expect(result.dimensions).toEqual(['correctness', 'requirement', 'quality', 'robustness', 'maintainability']);
  });

  it('模型用 markdown 围栏包住 JSON 时也能解析（先剥围栏再 JSON.parse）', async () => {
    configureGlobalJudge();
    modelReplies('```json\n{"prompt":"正文","dimensions":["correctness","requirement","quality","robustness","maintainability"]}\n```');

    const result = await generateJudgePrompt(generateInput());

    expect(result.prompt).toBe('正文');
  });

  it('返回不是 JSON 时抛 JUDGE_PARSE_FAILED，并在 context 里保留原文片段', async () => {
    configureGlobalJudge();
    modelReplies('这段代码改得不错，我给 4 分。');

    let caught: unknown;
    try {
      await generateJudgePrompt(generateInput());
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ServiceError);
    expect((caught as ServiceError).code).toBe('JUDGE_PARSE_FAILED');
    expect((caught as ServiceError).message).toContain('不是合法 JSON');
    expect(JSON.stringify((caught as ServiceError).context)).toContain('这段代码改得不错');
  });

  it('维度缺少任何一维时抛 JUDGE_PARSE_FAILED，并在 message 里点名缺了哪几维', async () => {
    configureGlobalJudge();
    modelReplies(JSON.stringify({ prompt: '正文', dimensions: ['correctness', 'quality'] }));

    let caught: unknown;
    try {
      await generateJudgePrompt(generateInput());
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ServiceError);
    expect((caught as ServiceError).code).toBe('JUDGE_PARSE_FAILED');
    expect((caught as ServiceError).message).toContain('requirement');
    expect((caught as ServiceError).message).toContain('robustness');
  });

  it('prompt 为空串时抛 JUDGE_PARSE_FAILED（空提示词比报错更糟：它会静默覆盖输入框）', async () => {
    configureGlobalJudge();
    modelReplies(JSON.stringify({ prompt: '', dimensions: ['correctness', 'requirement', 'quality', 'robustness', 'maintainability'] }));

    await expect(generateJudgePrompt(generateInput())).rejects.toBeInstanceOf(ServiceError);
  });

  it('未配置评分模型时把「指向设置页」的 CONFLICT 透出来（来自 resolveJudgeRoute）', async () => {
    // 没有 providers、没有 defaultJudge
    let caught: unknown;
    try {
      await generateJudgePrompt(generateInput());
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ServiceError);
    expect((caught as ServiceError).code).toBe('CONFLICT');
    expect((caught as ServiceError).message).toContain('设置');
    // 没配就不该产生任何上游调用
    expect(callTextApi).not.toHaveBeenCalled();
  });

  it('用例级的评分模型覆盖全局默认（走用例自己选的那个）', async () => {
    configureGlobalJudge();
    saveConfig({
      ...loadConfig(),
      providers: [...loadConfig().providers, { ...PROVIDER, id: 'provider-2', models: [{ id: 'judge-pro', source: 'manual' }] }],
    });
    modelReplies(JSON.stringify({ prompt: '正文', dimensions: ['correctness', 'requirement', 'quality', 'robustness', 'maintainability'] }));

    await generateJudgePrompt(generateInput({ judgeProviderId: 'provider-2', judgeModelId: 'judge-pro' }));

    const [route] = vi.mocked(callTextApi).mock.calls[0]!;
    expect(route.modelId).toBe('judge-pro');
    expect(route.baseUrl).toBe(PROVIDER.baseUrl);
  });

  it('仓库路径无效时抛 NOT_A_GIT_REPO（而不是先花掉一次模型调用）', async () => {
    configureGlobalJudge();
    const notRepo = join(dir, 'plain-dir');
    mkdirSync(notRepo, { recursive: true });

    let caught: unknown;
    try {
      await generateJudgePrompt(generateInput({ repoPath: notRepo }));
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ServiceError);
    expect((caught as ServiceError).code).toBe('NOT_A_GIT_REPO');
    expect(callTextApi).not.toHaveBeenCalled();
  });

  // 「生成是只读操作」：生成成功与失败都不许改配置文件。
  // 少了这条，一个「生成成功后顺手把 prompt 写回用例」的实现会静默覆盖用户还没保存的编辑。
  it('生成成功不改配置文件（配置目录里的内容前后逐字节一致）', async () => {
    configureGlobalJudge();
    const configFile = join(getConfigDir(), 'config.json');
    const before = readFileRaw(configFile, 'utf8');
    modelReplies(JSON.stringify({ prompt: '正文', dimensions: ['correctness', 'requirement', 'quality', 'robustness', 'maintainability'] }));

    await generateJudgePrompt(generateInput());

    expect(readFileRaw(configFile, 'utf8')).toBe(before);
  });

  it('生成失败同样不改配置文件', async () => {
    configureGlobalJudge();
    const configFile = join(getConfigDir(), 'config.json');
    const before = readFileRaw(configFile, 'utf8');
    modelReplies('不是 JSON');

    await expect(generateJudgePrompt(generateInput())).rejects.toBeInstanceOf(ServiceError);

    expect(readFileRaw(configFile, 'utf8')).toBe(before);
  });
});

describe('resolveJudgeRoute 的转出', () => {
  it('api 导出的 resolveJudgeRoute 与 evaluator 是同一个函数（转出而不是重新实现）', () => {
    expect(resolveJudgeRouteFromApi).toBe(resolveJudgeRoute);
  });
});
```

> 注意：`import { readFileSync as readFileRaw }` 只是为了把「读配置文件原文」与业务代码区分开，避免与其它 import 撞名。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @aieval/api test -- judge.test.ts`
Expected: FAIL —— `Failed to resolve import "./judge"`。

- [ ] **Step 3: 写实现 `judge.ts`**

```ts
/**
 * 评分提示词生成（spec §4.3 的生成侧）：拼一次文本调用 → 解析严格 JSON → 校验维度齐全。
 *
 * 三条必须守住的口径：
 *   1. **只读**：本模块不写任何落盘内容。生成失败时调用方手里已有的评分提示词必须原样保留
 *      （§4.3「不清空已有内容」）——失败只抛可展示的中文错误，绝不顺手改配置或清空状态；
 *   2. **输出契约用 contracts 的 `JUDGE_OUTPUT_CONTRACT`**（单一真源，评分解析侧共用同一份字段名）。
 *      在这里再抄一份字段清单，两边必然漂移，最后表现成「模型回了散文、解析失败」；
 *   3. **维度必须齐全**：模型只回 3 个维度时立刻报错，而不是回一个「少了二维的预览」——
 *      预览是用户判断这份提示词能不能用的唯一依据，缺维度的预览会骗人。
 */
import {
  DIMENSION_COUNT,
  DIMENSIONS,
  DimensionKeySchema,
  JUDGE_OUTPUT_CONTRACT,
  ServiceError,
  type DimensionKey,
  type GenerateJudgePromptInput,
} from '@aieval/contracts';
import { resolveRepoInfo } from '@aieval/core';
import { callTextApi, resolveJudgeRoute } from '@aieval/evaluator';

/** 转出评分模型路由解析：HTTP 层要用它做「未配置评分模型」的即时报错（契约 §6） */
export { resolveJudgeRoute } from '@aieval/evaluator';

/** 原文片段保留长度：够定位问题，又不会把几百 KB 的回复塞进错误响应 */
const RAW_EXCERPT_LENGTH = 500;

/** 生成结果：prompt 回填到文本框，dimensions 用于表单下方的只读预览 */
export interface GenerateJudgePromptResult {
  prompt: string;
  dimensions: DimensionKey[];
}

/**
 * 生成评分提示词（非流式）。
 * 顺序有意如此：**先校验仓库、再解析评分路由、最后才调用模型**——
 * 前面两步失败时一次模型调用都不该花掉（限额是真的钱）。
 */
export async function generateJudgePrompt(input: GenerateJudgePromptInput): Promise<GenerateJudgePromptResult> {
  // 仓库名校验：§4.3 要求把「仓库名」作为输入之一，取的是 git 实际回显的仓库名，
  // 顺带把「路径早就不可用」这种输入挡在模型调用之前
  const repoInfo = resolveRepoInfo(input.repoPath.trim());

  // 未配置评分模型时这里抛 CONFLICT，message 指向设置页（契约 §5 的 resolveJudgeRoute 口径）
  const route = resolveJudgeRoute({
    judgeProviderId: input.judgeProviderId ?? null,
    judgeModelId: input.judgeModelId ?? null,
  });

  const raw = await callTextApi(route, {
    system: buildSystemPrompt(),
    prompt: buildUserPrompt({ taskPrompt: input.taskPrompt, repoName: repoInfo.repoName }),
  });

  return parseGenerated(raw);
}

/** 系统提示词：只约束「怎么回」，业务约束全在用户提示词与输出契约里 */
function buildSystemPrompt(): string {
  return [
    '你是一名资深代码评审专家，负责为「AI 生成代码评测」撰写评分提示词。',
    '评分模型只会看到候选的代码改动（diff），看不到任何对话过程，也看不到原始仓库。',
    '你的回复必须是一个 JSON 对象，不要输出解释、不要使用 markdown 代码围栏。',
  ].join('\n');
}

/** 用户提示词：考题提示词 + 仓库名 + 固定 5 维定义 + 输出契约（逐段拼，便于测试逐项断言） */
function buildUserPrompt(context: { taskPrompt: string; repoName: string }): string {
  const dimensionLines = DIMENSIONS.map((dimension) => `- ${dimension.key}（${dimension.label}）`).join('\n');
  return [
    `【仓库】${context.repoName}`,
    `【考题提示词】\n${context.taskPrompt}`,
    `【评分维度】固定 ${DIMENSION_COUNT} 维、等权，顺序不可改：\n${dimensionLines}`,
    `【输出契约】\n${JUDGE_OUTPUT_CONTRACT}`,
    [
      '【你的任务】',
      '写一段可直接交给评分模型的评分提示词，放进 JSON 的 prompt 字段；',
      '并把实际采用的维度 key 列表放进 dimensions 字段（必须覆盖上面全部维度、顺序一致）。',
      'prompt 里要写清：评分模型只依据 diff 判断，看不到 diff 的改动不要臆测。',
    ].join('\n'),
  ].join('\n\n');
}

/**
 * 解析模型回复：剥围栏 → JSON.parse → 形状校验 → 维度齐全校验。
 * 全部失败路径都折成 JUDGE_PARSE_FAILED（HTTP 500），message 必须是能直接给用户看的中文。
 */
function parseGenerated(raw: string): GenerateJudgePromptResult {
  const jsonText = stripCodeFence(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new ServiceError('JUDGE_PARSE_FAILED', `评分模型返回的不是合法 JSON，请重试或换一个模型：${excerpt(raw)}`, {
      context: { raw: excerpt(raw) },
    });
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new ServiceError('JUDGE_PARSE_FAILED', '评分模型返回的 JSON 不是对象，请重试或换一个模型', {
      context: { raw: excerpt(raw) },
    });
  }
  const record = parsed as Record<string, unknown>;

  const prompt = typeof record.prompt === 'string' ? record.prompt : '';
  if (prompt.trim() === '') {
    // 空提示词比报错更糟：面板会把它回填进文本框，等于静默清掉用户已有的内容
    throw new ServiceError('JUDGE_PARSE_FAILED', '评分模型返回的提示词为空，请重试或换一个模型', {
      context: { raw: excerpt(raw) },
    });
  }

  const dimensions = readDimensions(record.dimensions);
  const missing = DIMENSIONS.map((dimension) => dimension.key).filter((key) => !dimensions.includes(key));
  if (missing.length > 0) {
    throw new ServiceError(
      'JUDGE_PARSE_FAILED',
      `评分模型漏掉了维度：${missing.join('、')}；请重试或换一个模型`,
      { context: { raw: excerpt(raw), missing } },
    );
  }

  return { prompt, dimensions };
}

/** 读维度数组：认不出的 key 直接丢弃（模型可能自造维度名），顺序按模型给的来 */
function readDimensions(value: unknown): DimensionKey[] {
  if (!Array.isArray(value)) return [];
  const keys: DimensionKey[] = [];
  for (const item of value) {
    const parsed = DimensionKeySchema.safeParse(item);
    if (parsed.success && !keys.includes(parsed.data)) keys.push(parsed.data);
  }
  return keys;
}

/**
 * 剥掉 markdown 代码围栏：模型即使被要求「只输出 JSON」也常常包一层 ```json。
 * 只处理开头/结尾的围栏，不动正文——正文里的括号属于 prompt 内容，改了就是篡改。
 */
function stripCodeFence(raw: string): string {
  const trimmed = raw.trim();
  const fenceMatch = /^```[a-zA-Z]*\s*\n([\s\S]*?)\n?```$/.exec(trimmed);
  return fenceMatch?.[1] ?? trimmed;
}

/** 原文片段：截断到合理长度（排障够用，又不会把整个回复塞进错误上下文） */
function excerpt(raw: string): string {
  return raw.length <= RAW_EXCERPT_LENGTH ? raw : `${raw.slice(0, RAW_EXCERPT_LENGTH)}…（已截断）`;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @aieval/api test -- judge.test.ts`
Expected: PASS。

> 若 `JUDGE_OUTPUT_CONTRACT` / `DIMENSIONS` / `DIMENSION_COUNT` 在 contracts 里还没有（p0 未完成），本任务应当**先停下来**：它们是 p0 的交付物，本计划不重复定义（见「契约冲突」回报）。

- [ ] **Step 5: 更新 `packages/server/api/src/index.ts`（追加第二段）**

```ts
export { generateJudgePrompt, resolveJudgeRoute, type GenerateJudgePromptResult } from './judge';
```

- [ ] **Step 6: 跑全量类型检查与提交**

Run: `pnpm typecheck`
Expected: 零错误。

```bash
git add packages/server/api/src/judge.ts packages/server/api/src/judge.test.ts packages/server/api/src/index.ts
git commit -m "feat(api): AI 生成评分提示词（严格 JSON 解析 + 维度齐全校验，只读不落盘）"
```

---

## Task 4: `client` 用例 hooks

**Files:**
- Create: `packages/client/client/src/cases.ts`
- Create: `packages/client/client/src/cases.test.tsx`
- Modify: `packages/client/client/src/index.ts`

**Interfaces:**
- Consumes：`./http` 的 `getJson` / `postJson` / `putJson` / `delJson`（已有）；`@aieval/contracts` 的类型
- Produces（契约 §7，逐字名字；返回形状按 §7 的通用约定「mutation 成功后回写 + 列表类显式刷新」确定）：
  - `useCases(): { cases: TestCase[] | undefined; error: unknown; isLoading: boolean; refresh: () => void }`
  - `useTestCase(id: string | null): { testCase: TestCase | undefined; error: unknown; isLoading: boolean }`
  - `useCreateCase(): { create: (input: CaseCreate) => Promise<TestCase>; isCreating: boolean }`
  - `useUpdateCase(): { update: (id: string, patch: CasePatch) => Promise<TestCase>; isUpdating: boolean }`
  - `useDeleteCase(): { remove: (id: string) => Promise<{ affectedRuns: number }>; isDeleting: boolean }`
  - `useValidateRepo(): { validate: (repoPath: string) => Promise<RepoInfo>; isValidating: boolean }`
  - `useCommitCandidates(repoPath: string | null): { commits: CommitCandidate[] | undefined; isLoading: boolean }`
  - `useGenerateJudgePrompt(): { generate: (input: GenerateJudgePromptInput) => Promise<{ prompt: string; dimensions: DimensionKey[] }>; isGenerating: boolean }`

- [ ] **Step 1: 写失败测试 `cases.test.tsx`**

```tsx
/**
 * 用例 hooks：路由 URL 就是 SWR 的 cache key、mutation 后列表被刷新、详情缓存被回写、
 * 以及「校验仓库 / commit 候选 / 生成提示词按**仓库路径**走，URL 里不出现 caseId」（接口契约 §11 R7）。
 *
 * 每个用例挂一份全新的 SWR 缓存：默认 cache 是模块级单例，用例之间沿用会让第二个用例
 * 直接命中上一个用例的数据与在飞去重项，一次请求都不发，断言随之失真。
 */
import { createElement, type ReactNode } from 'react';
import { SWRConfig } from 'swr';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { ServiceError, type RepoInfo, type TestCase } from '@aieval/contracts';
import {
  useCases,
  useCommitCandidates,
  useCreateCase,
  useDeleteCase,
  useGenerateJudgePrompt,
  useTestCase,
  useUpdateCase,
  useValidateRepo,
} from './cases';

const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(SWRConfig, { value: { provider: () => new Map() } }, children);

afterEach(() => {
  vi.unstubAllGlobals();
});

/** 一个最小的用例对象：字段按契约给全 */
function makeCase(overrides: Partial<TestCase> = {}): TestCase {
  return {
    id: 'case-1',
    title: '为网关补齐转换回归',
    repoPath: 'D:\\projects\\gateway',
    commitHash: null,
    taskPrompt: '补一条回归用例',
    judgePrompt: '按五维评分',
    judgeProviderId: null,
    judgeModelId: null,
    createdAt: '2026-09-22T10:00:00.000Z',
    updatedAt: '2026-09-22T10:00:00.000Z',
    ...overrides,
  };
}

/** 记下每次请求的 (url, method)，并按 url 返回预设响应 */
function stubFetch(routes: Record<string, unknown>): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${url}`;
    if (!(key in routes)) return new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: '没有这个路由' } }), { status: 404 });
    return new Response(JSON.stringify(routes[key]), { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('useCases / useTestCase', () => {
  it('列表的 cache key 就是 /api/cases', async () => {
    const fetchMock = stubFetch({ 'GET /api/cases': [makeCase()] });

    const { result } = renderHook(() => useCases(), { wrapper });

    await waitFor(() => expect(result.current.cases).toBeDefined());
    expect(result.current.cases).toHaveLength(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/cases');
  });

  it('id 为 null 时不发详情请求（打开「新建」栏不该去打一个不存在的详情）', async () => {
    const fetchMock = stubFetch({});

    const { result } = renderHook(() => useTestCase(null), { wrapper });

    expect(result.current.testCase).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('id 给定时按 /api/cases/{id} 取详情', async () => {
    const fetchMock = stubFetch({ 'GET /api/cases/case-1': makeCase() });

    const { result } = renderHook(() => useTestCase('case-1'), { wrapper });

    await waitFor(() => expect(result.current.testCase).toBeDefined());
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/cases/case-1');
  });
});

describe('useCreateCase / useUpdateCase / useDeleteCase', () => {
  it('create 发 POST /api/cases，并在之后刷新列表', async () => {
    const created = makeCase({ id: 'case-new' });
    const fetchMock = stubFetch({ 'GET /api/cases': [], 'POST /api/cases': created });

    const { result } = renderHook(() => ({ list: useCases(), create: useCreateCase() }), { wrapper });
    await waitFor(() => expect(result.current.list.cases).toBeDefined());
    const getCountBefore = fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === undefined).length;

    await result.current.create.create({ title: 'x', repoPath: 'D:\\r', commitHash: null, taskPrompt: 't', judgePrompt: 'j', judgeProviderId: null, judgeModelId: null });

    const calls = fetchMock.mock.calls.map(([url, init]) => `${(init as RequestInit | undefined)?.method ?? 'GET'} ${url}`);
    expect(calls).toContain('POST /api/cases');
    // 新建的用例不在旧数组里：不重新拉一次列表，用户要等下次进页面才看得到它
    await waitFor(() => {
      const getCountAfter = fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === undefined).length;
      expect(getCountAfter).toBeGreaterThan(getCountBefore);
    });
  });

  it('update 发 PUT /api/cases/{id}，并把响应回写到详情缓存（详情栏不刷新就能看到新值）', async () => {
    const updated = makeCase({ title: '改过的标题' });
    stubFetch({ 'GET /api/cases/case-1': makeCase(), 'PUT /api/cases/case-1': updated });

    const { result } = renderHook(() => ({ detail: useTestCase('case-1'), update: useUpdateCase() }), { wrapper });
    await waitFor(() => expect(result.current.detail.testCase?.title).toBe('为网关补齐转换回归'));

    await result.current.update.update('case-1', { title: '改过的标题' });

    await waitFor(() => expect(result.current.detail.testCase?.title).toBe('改过的标题'));
  });

  it('remove 发 DELETE /api/cases/{id} 并返回受影响评测数', async () => {
    const fetchMock = stubFetch({ 'GET /api/cases/case-1': makeCase(), 'DELETE /api/cases/case-1': { affectedRuns: 2 } });

    const { result } = renderHook(() => useDeleteCase(), { wrapper });

    await expect(result.current.remove('case-1')).resolves.toEqual({ affectedRuns: 2 });
    expect(fetchMock.mock.calls.map(([url, init]) => `${(init as RequestInit | undefined)?.method ?? 'GET'} ${url}`)).toContain('DELETE /api/cases/case-1');
  });
});

describe('仓库相关的三个动作（R7：按仓库路径，不带 caseId）', () => {
  it('validate 发 POST /api/cases/validate-repo，且不发任何 GET（该路由只有 POST）', async () => {
    const info: RepoInfo = { repoPath: 'D:\\projects\\gateway', repoName: 'gateway', branch: 'main' };
    const fetchMock = stubFetch({ 'POST /api/cases/validate-repo': info });

    const { result } = renderHook(() => useValidateRepo(), { wrapper });

    await expect(result.current.validate('D:\\projects\\gateway')).resolves.toEqual(info);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/cases/validate-repo');
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).body).toBe(JSON.stringify({ repoPath: 'D:\\projects\\gateway' }));
    expect(fetchMock.mock.calls.every(([, init]) => (init as RequestInit | undefined)?.method === 'POST')).toBe(true);
  });

  it('repoPath 为 null 时不取候选提交', () => {
    const fetchMock = stubFetch({});

    const { result } = renderHook(() => useCommitCandidates(null), { wrapper });

    expect(result.current.commits).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('repoPath 给定时 POST /api/cases/commits', async () => {
    const fetchMock = stubFetch({ 'POST /api/cases/commits': [{ hash: 'abc1234', subject: '初始提交' }] });

    const { result } = renderHook(() => useCommitCandidates('D:\\projects\\gateway'), { wrapper });

    await waitFor(() => expect(result.current.commits).toHaveLength(1));
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/cases/commits');
  });

  it('generate 发 POST /api/cases/generate-judge-prompt 并返回提示词与维度', async () => {
    const fetchMock = stubFetch({
      'POST /api/cases/generate-judge-prompt': {
        prompt: '评分提示词',
        dimensions: ['correctness', 'requirement', 'quality', 'robustness', 'maintainability'],
      },
    });

    const { result } = renderHook(() => useGenerateJudgePrompt(), { wrapper });

    const generated = await result.current.generate({
      repoPath: 'D:\\projects\\gateway',
      taskPrompt: '补回归',
      judgeProviderId: null,
      judgeModelId: null,
    });

    expect(generated.prompt).toBe('评分提示词');
    expect(generated.dimensions).toHaveLength(5);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/cases/generate-judge-prompt');
  });

  it('服务端错误折叠成 ServiceError（错误码与中文原因都要保留，页面才能直接 message.error）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ error: { code: 'NOT_A_GIT_REPO', message: '不是 git 仓库：D:\\tmp' } }), { status: 400 }),
      ),
    );

    const { result } = renderHook(() => useValidateRepo(), { wrapper });

    let caught: unknown;
    try {
      await result.current.validate('D:\\tmp');
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ServiceError);
    expect((caught as ServiceError).code).toBe('NOT_A_GIT_REPO');
    expect((caught as ServiceError).message).toContain('不是 git 仓库');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @aieval/client test -- cases.test.tsx`
Expected: FAIL —— `Failed to resolve import "./cases"`。

- [ ] **Step 3: 写实现 `cases.ts`**

```ts
/**
 * 用例数据层：列表 / 详情 / 增删改 + 仓库校验 + commit 候选 + AI 生成评分提示词。
 *
 * 两条约定：
 *   1. **cache key 就是路由 URL**（列表用 `/api/cases`，详情用 `/api/cases/{id}`），
 *      这样「URL 写错」在测试里立刻表现为请求打到了不存在的路由，而不是安静地拿旧数据；
 *   2. mutation 的响应形状与列表 key **不同形**（列表是数组、mutation 返回单条），所以一律
 *      `populateCache: false` + `revalidate: true`：不回写（会把数组换成对象），改为重新拉一次列表。
 *      详情缓存单独用全局 mutate 回写，否则「保存后详情栏还显示旧值」。
 *
 * 三个「动作型」接口（校验仓库 / commit 候选 / 生成提示词）都**按仓库路径**走，URL 里不出现 caseId
 * （接口契约 §11 R7）：新建用例时还没有 caseId，而这三件事的输入本来就是路径。
 */
import useSWR, { useSWRConfig } from 'swr';
import useSWRMutation from 'swr/mutation';
import type {
  CaseCreate,
  CasePatch,
  CommitCandidate,
  DimensionKey,
  GenerateJudgePromptInput,
  RepoInfo,
  TestCase,
} from '@aieval/contracts';
import { delJson, getJson, postJson, putJson } from './http';

const LIST_KEY = '/api/cases';
const VALIDATE_REPO_KEY = '/api/cases/validate-repo';
const COMMITS_KEY = '/api/cases/commits';
const GENERATE_JUDGE_PROMPT_KEY = '/api/cases/generate-judge-prompt';

/** 用例列表；refresh 供「外部改了数据」后手动刷新（例如删除后想立刻对齐另一台标签页） */
export function useCases(): {
  cases: TestCase[] | undefined;
  error: unknown;
  isLoading: boolean;
  refresh: () => void;
} {
  const { data, error, isLoading, mutate } = useSWR<TestCase[]>(LIST_KEY, getJson);
  return { cases: data, error, isLoading, refresh: () => void mutate() };
}

/**
 * 用例详情。`id` 为 null 时**不发请求**（SWR 的 null key 语义）——
 * 右栏打开「新建」表单时没有 id，传 null 比传空串安全（空串会打出 `/api/cases/`）。
 */
export function useTestCase(id: string | null): {
  testCase: TestCase | undefined;
  error: unknown;
  isLoading: boolean;
} {
  const { data, error, isLoading } = useSWR<TestCase>(id === null ? null : `${LIST_KEY}/${id}`, getJson);
  return { testCase: data, error, isLoading };
}

/** 新建用例：成功后刷新列表（返回创建好的用例，页面用它跳到详情栏） */
export function useCreateCase(): { create: (input: CaseCreate) => Promise<TestCase>; isCreating: boolean } {
  const { trigger, isMutating } = useSWRMutation(
    LIST_KEY,
    (key: string, { arg }: { arg: CaseCreate }) => postJson<TestCase>(key, arg),
    { populateCache: false, revalidate: true },
  );
  return { create: trigger, isCreating: isMutating };
}

/** 更新用例：刷新列表 + 回写详情缓存（两处都要，缺一处就会出现「列表新、详情旧」） */
export function useUpdateCase(): { update: (id: string, patch: CasePatch) => Promise<TestCase>; isUpdating: boolean } {
  const { mutate } = useSWRConfig();
  const { trigger, isMutating } = useSWRMutation(
    LIST_KEY,
    (_key: string, { arg }: { arg: { id: string; patch: CasePatch } }) =>
      putJson<TestCase>(`${LIST_KEY}/${arg.id}`, arg.patch),
    { populateCache: false, revalidate: true },
  );
  const update = async (id: string, patch: CasePatch): Promise<TestCase> => {
    const updated = await trigger({ id, patch });
    // revalidate:false —— 响应就是最新值，再拉一次只会多一次请求，还可能被慢响应覆盖成旧值
    await mutate(`${LIST_KEY}/${id}`, updated, { revalidate: false });
    return updated;
  };
  return { update, isUpdating: isMutating };
}

/** 删除用例：返回受影响评测数（页面用它提示「N 个评测记录仍可查看」）；同时清掉详情缓存 */
export function useDeleteCase(): { remove: (id: string) => Promise<{ affectedRuns: number }>; isDeleting: boolean } {
  const { mutate } = useSWRConfig();
  const { trigger, isMutating } = useSWRMutation(
    LIST_KEY,
    (_key: string, { arg }: { arg: { id: string } }) => delJson<{ affectedRuns: number }>(`${LIST_KEY}/${arg.id}`),
    { populateCache: false, revalidate: true },
  );
  const remove = async (id: string): Promise<{ affectedRuns: number }> => {
    const result = await trigger({ id });
    // 删掉的详情缓存必须清掉：留着它，改回同一个 URL 时会先渲染一条已经不存在的用例
    await mutate(`${LIST_KEY}/${id}`, undefined, { revalidate: false });
    return result;
  };
  return { remove, isDeleting: isMutating };
}

/**
 * 校验仓库路径。**不挂缓存**：校验是「动作」不是「数据」——
 * 缓存住的结果会在仓库被移动 / U 盘拔掉之后继续骗人。
 * 也因此必须 `revalidate: false`：该路由只有 POST，SWR 的默认 revalidate 会对它发 GET（405）。
 */
export function useValidateRepo(): { validate: (repoPath: string) => Promise<RepoInfo>; isValidating: boolean } {
  const { trigger, isMutating } = useSWRMutation(
    VALIDATE_REPO_KEY,
    (key: string, { arg }: { arg: { repoPath: string } }) => postJson<RepoInfo>(key, arg),
    { populateCache: false, revalidate: false },
  );
  return { validate: (repoPath: string) => trigger({ repoPath }), isValidating: isMutating };
}

/**
 * commit 候选：按仓库路径现取（POST 当读用——路径可能很长，放 URL query 里既难看又有长度上限）。
 * key 用数组把「路由 URL + 仓库路径」拼起来，切换仓库时自然换成另一条缓存。
 */
export function useCommitCandidates(repoPath: string | null): {
  commits: CommitCandidate[] | undefined;
  isLoading: boolean;
} {
  const { data, isLoading } = useSWR<CommitCandidate[]>(
    repoPath === null || repoPath === '' ? null : [COMMITS_KEY, repoPath],
    ([url, path]: [string, string]) => postJson<CommitCandidate[]>(url, { repoPath: path }),
  );
  return { commits: data, isLoading };
}

/** 生成评分提示词（非流式）。同样不挂缓存：它是一次会花钱的模型调用，不是可复用的数据 */
export function useGenerateJudgePrompt(): {
  generate: (input: GenerateJudgePromptInput) => Promise<{ prompt: string; dimensions: DimensionKey[] }>;
  isGenerating: boolean;
} {
  const { trigger, isMutating } = useSWRMutation(
    GENERATE_JUDGE_PROMPT_KEY,
    (key: string, { arg }: { arg: GenerateJudgePromptInput }) =>
      postJson<{ prompt: string; dimensions: DimensionKey[] }>(key, arg),
    { populateCache: false, revalidate: false },
  );
  return { generate: trigger, isGenerating: isMutating };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @aieval/client test -- cases.test.tsx`
Expected: PASS。

- [ ] **Step 5: 更新 `packages/client/client/src/index.ts`**

```ts
/** client 公共出口：数据获取 hooks 与 HTTP 原语。类型全部来自 contracts。 */
export { delJson, getJson, postJson, putJson } from './http';
export { useSettings } from './settings';
export {
  useCases,
  useCommitCandidates,
  useCreateCase,
  useDeleteCase,
  useGenerateJudgePrompt,
  useTestCase,
  useUpdateCase,
  useValidateRepo,
} from './cases';
```

- [ ] **Step 6: 跑全量类型检查与提交**

Run: `pnpm typecheck`
Expected: 零错误。

```bash
git add packages/client/client/src/cases.ts packages/client/client/src/cases.test.tsx packages/client/client/src/index.ts
git commit -m "feat(client): 用例 hooks（CRUD / 仓库校验 / commit 候选 / 生成评分提示词）"
```

---

## Task 5: `ui` `CaseFormPanel`（新建 / 编辑表单）

**Files:**
- Create: `packages/client/ui/src/composite/case-form-panel.tsx`
- Create: `packages/client/ui/src/composite/case-form-panel.test.tsx`
- Modify: `packages/client/ui/src/index.ts`

**Interfaces:**
- Consumes（契约 §2 / §8）：`@aieval/contracts` 的 `DIMENSIONS` / `PROTOCOL_LABELS` / `type CaseCreate` / `type CommitCandidate` / `type DimensionKey` / `type GenerateJudgePromptInput` / `type ProviderView` / `type RepoInfo` / `type TestCase`
- Produces（契约 §8 的关键 props 名逐字，签名在下面给出；页面是本组件的唯一消费者）：

```ts
export interface CaseFormPanelProps {
  mode: 'new' | 'edit';
  initial?: TestCase | null;
  providers: ProviderView[];
  judgeConfigured: boolean;
  saving: boolean;
  generating: boolean;
  validating: boolean;
  commits: CommitCandidate[];
  repoInfo: RepoInfo | null;
  dimensions: DimensionKey[];
  onSubmit: (values: CaseCreate) => void;
  onCancel: () => void;
  onValidateRepo: (repoPath: string) => Promise<RepoInfo>;
  onGenerate: (input: GenerateJudgePromptInput) => Promise<{ prompt: string; dimensions: DimensionKey[] }>;
  onLoadCommits: () => void;
}
```

- [ ] **Step 1: 写失败测试 `case-form-panel.test.tsx`**

```tsx
/**
 * CaseFormPanel：表单字段、提交归一化、生成回填、仓库校验回显，以及三条守卫。
 *
 * 三条守卫（都有变异验证，见 Step 5）：
 *   1. 手工输入的 commit hash 不在候选列表里也能提交（候选只是便利，§4.2）；
 *   2. 生成失败不清空已有的评分提示词（§4.3）；
 *   3. 仓库信息只在「当前输入框的值 == 校验通过的那次值」时回显（否则会让人以为新路径也校验过了）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { CaseCreate, ProviderView, RepoInfo, TestCase } from '@aieval/contracts';
import { CaseFormPanel, type CaseFormPanelProps } from './case-form-panel';
import { installResizeObserverStub } from '../testing/resize-observer';

// jsdom 不提供 ResizeObserver，antd 的下拉/虚拟列表内部会直接 new 全局构造器：不打桩，展开下拉即抛。
beforeEach(() => {
  installResizeObserverStub();
});

const HASH_IN_LIST = 'aaa1111';
const HASH_NOT_IN_LIST = 'b'.repeat(40);
const FULL_HASH = 'a1b2c3d4'.repeat(5);

const REPO_INFO: RepoInfo = { repoPath: 'D:\\projects\\gateway', repoName: 'gateway', branch: 'main' };

const PROVIDERS: ProviderView[] = [
  {
    id: 'provider-1',
    name: 'DeepSeek 官方',
    protocolType: 'openai',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKeyMasked: 'sk-***abcd',
    models: [{ id: 'deepseek-chat', source: 'fetched' }],
    createdAt: '2026-09-22T10:00:00.000Z',
    updatedAt: '2026-09-22T10:00:00.000Z',
  },
  {
    id: 'provider-2',
    name: 'Anthropic 兼容网关',
    protocolType: 'anthropic',
    baseUrl: 'https://gateway.example/anthropic',
    apiKeyMasked: 'sk-***wxyz',
    models: [{ id: 'claude-opus-4-6', source: 'manual' }],
    createdAt: '2026-09-22T10:00:00.000Z',
    updatedAt: '2026-09-22T10:00:00.000Z',
  },
];

const INITIAL: TestCase = {
  id: 'case-1',
  title: '为网关补齐转换回归',
  repoPath: 'D:\\projects\\gateway',
  commitHash: FULL_HASH,
  taskPrompt: '为 anthropic-to-chat 补一条回归用例',
  judgePrompt: '已有的评分提示词',
  judgeProviderId: 'provider-1',
  judgeModelId: 'deepseek-chat',
  createdAt: '2026-09-22T10:00:00.000Z',
  updatedAt: '2026-09-22T10:00:00.000Z',
};

/** props 基线：setup 与 rerender 共用一份，避免两处默认值漂移 */
function defaultProps(): CaseFormPanelProps {
  return {
    mode: 'new',
    initial: null,
    providers: PROVIDERS,
    judgeConfigured: true,
    saving: false,
    generating: false,
    validating: false,
    commits: [{ hash: HASH_IN_LIST, subject: '初始提交' }],
    repoInfo: null,
    dimensions: ['correctness', 'requirement', 'quality', 'robustness', 'maintainability'],
    onSubmit: vi.fn(),
    onCancel: vi.fn(),
    onValidateRepo: vi.fn(async () => REPO_INFO),
    onGenerate: vi.fn(async () => ({
      prompt: '生成出来的评分提示词',
      dimensions: ['correctness', 'requirement', 'quality', 'robustness', 'maintainability'],
    })),
    onLoadCommits: vi.fn(),
  };
}

/** 渲染面板：只覆盖本用例关心的 props，其余取基线 */
function setup(overrides: Partial<CaseFormPanelProps> = {}): ReturnType<typeof render> {
  return render(<CaseFormPanel {...defaultProps()} {...overrides} />);
}

/**
 * commit 输入框：**按 label 关联取内层 input**，不按 data-testid 取。
 * 原因：antd 的 Select 系组件（AutoComplete 也属于它）会把额外 props 放到外层容器而不是内层 input，
 * 对着容器 fireEvent.change 不会改变表单值——这条弯路不值得再走一遍。
 */
function commitInput(): HTMLElement {
  return screen.getByLabelText('commit hash');
}

/** 填满四个必填字段（标题 / 考题提示词 / 评分提示词 / 仓库路径） */
function fillRequired(): void {
  fireEvent.change(screen.getByTestId('case-title'), { target: { value: '新用例' } });
  fireEvent.change(screen.getByTestId('case-task-prompt'), { target: { value: '补一条回归' } });
  fireEvent.change(screen.getByTestId('case-judge-prompt'), { target: { value: '按五维评分' } });
  fireEvent.change(screen.getByTestId('case-repo-path'), { target: { value: 'D:\\projects\\gateway' } });
}

describe('CaseFormPanel 提交', () => {
  it('新建模式：提交时把四个字段与空 commitHash 归一化后交给 onSubmit', async () => {
    const onSubmit = vi.fn<(values: CaseCreate) => void>();
    setup({ onSubmit });
    fillRequired();

    fireEvent.click(screen.getByTestId('case-submit'));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]?.[0]).toEqual({
      title: '新用例',
      repoPath: 'D:\\projects\\gateway',
      // 输入框留空 == 默认分支 HEAD == 契约里的 null（空串会被 TestCaseSchema 的 min(1) 拒绝）
      commitHash: null,
      taskPrompt: '补一条回归',
      judgePrompt: '按五维评分',
      judgeProviderId: null,
      judgeModelId: null,
    });
  });

  it('必填没填时不提交，并给出中文提示（不是 antd 默认的英文）', async () => {
    const onSubmit = vi.fn();
    setup({ onSubmit });

    fireEvent.click(screen.getByTestId('case-submit'));

    expect(await screen.findByText('请填写标题')).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('编辑模式：预填已有用例的值，提交时按原值交回', async () => {
    const onSubmit = vi.fn<(values: CaseCreate) => void>();
    setup({ mode: 'edit', initial: INITIAL, onSubmit });

    expect(screen.getByTestId('case-title')).toHaveValue(INITIAL.title);
    expect(screen.getByTestId('case-judge-prompt')).toHaveValue(INITIAL.judgePrompt);

    fireEvent.click(screen.getByTestId('case-submit'));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]?.[0]?.judgeProviderId).toBe('provider-1');
    expect(onSubmit.mock.calls[0]?.[0]?.commitHash).toBe(INITIAL.commitHash);
  });

  it('点「取消」调 onCancel', () => {
    const onCancel = vi.fn();
    setup({ onCancel });

    fireEvent.click(screen.getByTestId('case-cancel'));

    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  // Review Focus 1（守卫，变异验证见 Step 5）：候选只是便利，手工输入的合法 hash 必须能提交。
  it('手工输入的 commit hash 不在候选列表里也能提交', async () => {
    const onSubmit = vi.fn<(values: CaseCreate) => void>();
    setup({ onSubmit });
    fillRequired();
    fireEvent.change(commitInput(), { target: { value: HASH_NOT_IN_LIST } });

    fireEvent.click(screen.getByTestId('case-submit'));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]?.[0]?.commitHash).toBe(HASH_NOT_IN_LIST);
  });

  // Review Focus 5：候选为空时必须仍能手工填 hash 提交（新仓库只有 1 个提交、git log 出错都会这样）。
  it('候选为空时仍能提交（下拉只说明「暂无候选」，不阻塞）', async () => {
    const onSubmit = vi.fn<(values: CaseCreate) => void>();
    setup({ commits: [], onSubmit });
    fillRequired();
    fireEvent.change(commitInput(), { target: { value: HASH_NOT_IN_LIST } });
    fireEvent.mouseDown(commitInput());

    expect(await screen.findByText('暂无候选提交，可手工输入完整 hash')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('case-submit'));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]?.[0]?.commitHash).toBe(HASH_NOT_IN_LIST);
  });

  // 断言落在**提交值**上而不是输入框的显示文本：显示成什么由 rc-select 决定，
  // 而契约要的是「选中的候选 = 这个 hash」。若这条失败（提交值里混进了提交说明），
  // 把选项的 label 改成只有 hash——说明文字挪到 extra 提示或别的展示位上。
  it('选中候选提交后，提交里带的是那个 hash', async () => {
    const onSubmit = vi.fn<(values: CaseCreate) => void>();
    setup({ onSubmit });
    fillRequired();

    fireEvent.mouseDown(commitInput());
    fireEvent.click(await screen.findByText('aaa1111 初始提交'));
    fireEvent.click(screen.getByTestId('case-submit'));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]?.[0]?.commitHash).toBe(HASH_IN_LIST);
  });
});

describe('CaseFormPanel 的 AI 生成', () => {
  it('生成成功才把 prompt 写回评分提示词输入框', async () => {
    const onGenerate = vi.fn(async () => ({ prompt: '生成出来的评分提示词', dimensions: [] }));
    setup({ mode: 'edit', initial: INITIAL, onGenerate });

    fireEvent.click(screen.getByTestId('case-generate-judge'));

    await waitFor(() => expect(screen.getByTestId('case-judge-prompt')).toHaveValue('生成出来的评分提示词'));
    expect(onGenerate).toHaveBeenCalledTimes(1);
  });

  // Review Focus 3（守卫，变异验证见 Step 5）：一次失败的点击不能清掉用户已有的提示词。
  it('生成失败不清空已有的评分提示词', async () => {
    const onGenerate = vi.fn(async () => {
      throw new Error('评分模型返回的不是合法 JSON');
    });
    setup({ mode: 'edit', initial: INITIAL, onGenerate });

    fireEvent.click(screen.getByTestId('case-generate-judge'));

    await waitFor(() => expect(onGenerate).toHaveBeenCalledTimes(1));
    // 等一拍，确保「先清空再请求」这种实现也有机会把输入框清掉，断言才有区分力
    await waitFor(() => expect(screen.getByTestId('case-judge-prompt')).toHaveValue(INITIAL.judgePrompt));
  });

  it('未配置评分模型时按钮禁用，悬停给出「去设置页」的指引', async () => {
    const onGenerate = vi.fn();
    setup({ judgeConfigured: false, onGenerate });

    expect(screen.getByTestId('case-generate-judge')).toBeDisabled();

    // antd 的禁用按钮不触发鼠标事件，Tooltip 挂在**外层 span** 上——所以这里对 span 触发 mouseOver
    fireEvent.mouseOver(screen.getByTestId('case-generate-wrapper'));

    expect(await screen.findByText('请先到设置里配置默认评分模型')).toBeInTheDocument();
  });

  it('未配置评分模型时点击按钮不会触发生成', () => {
    const onGenerate = vi.fn();
    setup({ judgeConfigured: false, onGenerate });

    fireEvent.click(screen.getByTestId('case-generate-judge'));

    expect(onGenerate).not.toHaveBeenCalled();
  });
});

describe('CaseFormPanel 的仓库校验与维度预览', () => {
  it('点「校验」把路径交给 onValidateRepo，并在回显区显示仓库名与分支', async () => {
    const onValidateRepo = vi.fn(async () => REPO_INFO);
    const view = setup({ onValidateRepo, repoInfo: null });
    fillRequired();

    fireEvent.click(screen.getByTestId('case-validate-repo'));
    await waitFor(() => expect(onValidateRepo).toHaveBeenCalledWith('D:\\projects\\gateway'));

    // 页面在校验成功后把 repoInfo 传回来（这里用 rerender 模拟那次状态更新）
    view.rerender(<CaseFormPanel {...defaultProps()} onValidateRepo={onValidateRepo} repoInfo={REPO_INFO} />);

    expect(await screen.findByTestId('case-repo-info')).toHaveTextContent('gateway');
    expect(screen.getByTestId('case-repo-info')).toHaveTextContent('main');
  });

  it('改了仓库路径之后不再显示上一次的校验回显（否则会以为新路径也校验过了）', async () => {
    const onValidateRepo = vi.fn(async () => REPO_INFO);
    setup({ onValidateRepo, repoInfo: REPO_INFO });
    fillRequired();

    fireEvent.click(screen.getByTestId('case-validate-repo'));
    await waitFor(() => expect(screen.getByTestId('case-repo-info')).toBeInTheDocument());

    fireEvent.change(screen.getByTestId('case-repo-path'), { target: { value: 'D:\\projects\\other' } });

    await waitFor(() => expect(screen.queryByTestId('case-repo-info')).toBeNull());
  });

  it('校验失败（onValidateRepo 抛错）时不留「已校验」的假状态', async () => {
    const onValidateRepo = vi.fn(async () => {
      throw new Error('不是 git 仓库');
    });
    setup({ onValidateRepo, repoInfo: REPO_INFO });
    fillRequired();

    fireEvent.click(screen.getByTestId('case-validate-repo'));

    await waitFor(() => expect(onValidateRepo).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('case-repo-info')).toBeNull();
  });

  it('「加载候选」按钮调 onLoadCommits', () => {
    const onLoadCommits = vi.fn();
    setup({ onLoadCommits });

    fireEvent.click(screen.getByTestId('case-load-commits'));

    expect(onLoadCommits).toHaveBeenCalledTimes(1);
  });

  it('维度只读预览列出 5 维的中文标签', () => {
    setup();

    for (const label of ['功能正确性', '需求完成度', '代码质量', '健壮性与边界', '可维护性（改动范围合理）']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });

  it('提示词输入框用 antd 的等宽字体 token（不是写死的字体名）', () => {
    setup();

    const textarea = screen.getByTestId('case-judge-prompt');
    // 默认 token 是 'SFMono-Regular', Consolas, … monospace：断言落在「等宽」这个语义上，
    // 而不是某一个具体字体名（换 token 不该让测试红）
    expect(/mono/i.test(textarea.style.fontFamily)).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @aieval/ui test -- case-form-panel.test.tsx`
Expected: FAIL —— `Failed to resolve import "./case-form-panel"`。

- [ ] **Step 3: 写实现 `case-form-panel.tsx`**

```tsx
'use client';

/**
 * 用例表单面板（右栏内容）：新建与编辑共用一个组件，`mode` 区分。
 *
 * 纯展示：不调接口、不 import client 包；数据与回调全部来自 props。
 * **错误提示由页面负责**（页面在回调里 catch 后 `message.error`）——面板只负责「失败时什么都不做」，
 * 这也正是「生成失败不清空已有提示词」这条规则的落点。
 *
 * 四个必须守住的行为：
 *   1. **只有生成成功才写回评分提示词**（§4.3）。反面写法是「先清空再请求」：一次网络抖动就会
 *      清掉用户手写几十分钟的内容，而用户看到的只是一句报错；
 *   2. **commit 候选只是便利**：用 AutoComplete 而不是只读下拉，手工输入任意合法 hash 必须能提交（§4.2）；
 *   3. **未配置评分模型时禁用「AI 生成」并用 Tooltip 说明去向**（§4.3）。antd 的禁用按钮不触发鼠标事件，
 *      Tooltip 必须挂在**外层 span** 上，否则禁用态下浮层永远不出现；
 *   4. **等宽字体取 antd token**（`theme.useToken().fontFamilyCode`），不写死字体名——
 *      主题换字体时这里跟着走；正文是代码，等宽是语义要求而不是装饰。
 *
 * 初值只在挂载时读一次（antd 的 `initialValues` 语义）：**切换用例必须换 key 重挂载**，
 * 页面里的 `key={panel === 'edit' ? \`case-edit-${id}\` : 'case-new'}` 就是为它准备的。
 */
import {
  DIMENSIONS,
  PROTOCOL_LABELS,
  type CaseCreate,
  type CommitCandidate,
  type DimensionKey,
  type GenerateJudgePromptInput,
  type ProviderView,
  type RepoInfo,
  type TestCase,
} from '@aieval/contracts';
import { Alert, AutoComplete, Button, Card, Flex, Form, Input, Select, Tooltip, Typography, theme } from 'antd';
import { useState, type ReactNode } from 'react';

/** 评分模型下拉的复合值分隔符：模型名里可能出现 `:`，故用 `::` 并在**第一处**切分 */
const MODEL_VALUE_SEPARATOR = '::';

/** 表单内部值：与 CaseCreate 同形，但 commitHash 允许空串（输入框清空拿到的是空串，提交时归一成 null） */
interface CaseFormValues {
  title: string;
  taskPrompt: string;
  judgePrompt: string;
  repoPath: string;
  commitHash?: string;
  judgeProviderId: string | null;
  judgeModelId: string | null;
}

export interface CaseFormPanelProps {
  mode: 'new' | 'edit';
  /** 编辑模式的初值；**只在挂载时读一次**，切换用例要换 key 重挂载 */
  initial?: TestCase | null;
  /** 可选评分模型：两种协议都列（评分走文本 API，与智能体协议无关，§4.2 / §6.2） */
  providers: ProviderView[];
  /** 是否已配置评分模型；false 时「AI 生成」禁用并提示去设置页 */
  judgeConfigured: boolean;
  saving: boolean;
  generating: boolean;
  validating: boolean;
  commits: CommitCandidate[];
  repoInfo: RepoInfo | null;
  /** 本用例将采用的维度 key（生成成功后的返回值）；空数组按固定 5 维渲染 */
  dimensions: DimensionKey[];
  onSubmit: (values: CaseCreate) => void;
  onCancel: () => void;
  onValidateRepo: (repoPath: string) => Promise<RepoInfo>;
  onGenerate: (input: GenerateJudgePromptInput) => Promise<{ prompt: string; dimensions: DimensionKey[] }>;
  onLoadCommits: () => void;
}

export function CaseFormPanel({
  mode,
  initial = null,
  providers,
  judgeConfigured,
  saving,
  generating,
  validating,
  commits,
  repoInfo,
  dimensions,
  onSubmit,
  onCancel,
  onValidateRepo,
  onGenerate,
  onLoadCommits,
}: CaseFormPanelProps): ReactNode {
  const [form] = Form.useForm<CaseFormValues>();
  const { token } = theme.useToken();
  // 等宽：取 token 而不是写死字体名（见文件头要点 4）
  const monoStyle = { fontFamily: token.fontFamilyCode };

  /**
   * 上一次校验成功的路径。仓库信息只在「当前输入框的值 == 它」时才回显——
   * 用户改了路径却还看到上一个仓库的名字与分支，会以为新路径也已经校验过。
   */
  const [validatedPath, setValidatedPath] = useState<string | null>(null);
  const repoPathValue = (Form.useWatch('repoPath', form) as string | undefined) ?? '';
  const showRepoInfo = repoInfo !== null && validatedPath !== null && validatedPath === repoPathValue.trim();

  const judgeProviderId = Form.useWatch('judgeProviderId', form) as string | null | undefined;
  const judgeModelId = Form.useWatch('judgeModelId', form) as string | null | undefined;
  const selectedJudgeValue = judgeProviderId !== null && judgeProviderId !== undefined && judgeModelId !== null && judgeModelId !== undefined
    ? `${judgeProviderId}${MODEL_VALUE_SEPARATOR}${judgeModelId}`
    : undefined;

  /** 评分模型候选：按供应商分组；没有模型的供应商整组不显示（空的组标题只会制造噪音） */
  const judgeOptions = providers
    .filter((provider) => provider.models.length > 0)
    .map((provider) => ({
      label: `${provider.name}（${PROTOCOL_LABELS[provider.protocolType]}）`,
      options: provider.models.map((model) => ({
        value: `${provider.id}${MODEL_VALUE_SEPARATOR}${model.id}`,
        label: model.source === 'manual' ? `${model.id}（手工维护）` : model.id,
      })),
    }));

  /** 维度预览：空数组按固定 5 维渲染（预览区留白会让人以为这个用例没有维度） */
  const previewDimensions = dimensions.length === 0 ? DIMENSIONS : DIMENSIONS.filter((dimension) => dimensions.includes(dimension.key));

  /** 下拉选中 → 写回两个隐藏字段；清空两个字段一起置 null（只清一个会留下半配置状态） */
  const handleJudgeChange = (value: string | undefined): void => {
    if (value === undefined) {
      form.setFieldsValue({ judgeProviderId: null, judgeModelId: null });
      return;
    }
    const separatorIndex = value.indexOf(MODEL_VALUE_SEPARATOR);
    form.setFieldsValue({
      judgeProviderId: value.slice(0, separatorIndex),
      judgeModelId: value.slice(separatorIndex + MODEL_VALUE_SEPARATOR.length),
    });
  };

  /** 校验仓库：先过本字段的必填校验，再交给页面（空路径直接调接口只会拿到一句「查询参数不合法」） */
  const handleValidate = async (): Promise<void> => {
    const values = await form.validateFields(['repoPath']).catch(() => null);
    if (values === null) return;
    try {
      const info = await onValidateRepo((values.repoPath ?? '').trim());
      setValidatedPath(info.repoPath.trim());
    } catch {
      // 失败原因由页面统一 message.error 呈现；这里只负责不留下「已校验」的假状态
      setValidatedPath(null);
    }
  };

  /** 生成评分提示词：**成功才写回**（见文件头要点 1） */
  const handleGenerate = async (): Promise<void> => {
    const values = await form
      .validateFields(['taskPrompt', 'repoPath', 'judgeProviderId', 'judgeModelId'])
      .catch(() => null);
    if (values === null) return;
    try {
      const generated = await onGenerate({
        repoPath: (values.repoPath ?? '').trim(),
        taskPrompt: values.taskPrompt ?? '',
        judgeProviderId: values.judgeProviderId ?? null,
        judgeModelId: values.judgeModelId ?? null,
      });
      form.setFieldValue('judgePrompt', generated.prompt);
    } catch {
      // 刻意什么都不做：不清空、不回填——用户已有的评分提示词必须原样保留
    }
  };

  /** 提交：把表单值归一成契约形状（空串 → null，两侧空白 trim） */
  const handleFinish = (values: CaseFormValues): void => {
    const commitHash = (values.commitHash ?? '').trim();
    onSubmit({
      title: values.title.trim(),
      repoPath: values.repoPath.trim(),
      commitHash: commitHash === '' ? null : commitHash,
      taskPrompt: values.taskPrompt,
      judgePrompt: values.judgePrompt,
      judgeProviderId: values.judgeProviderId ?? null,
      judgeModelId: values.judgeModelId ?? null,
    });
  };

  const initialValues: Partial<CaseFormValues> = initial === null
    ? {}
    : {
        title: initial.title,
        taskPrompt: initial.taskPrompt,
        judgePrompt: initial.judgePrompt,
        repoPath: initial.repoPath,
        commitHash: initial.commitHash ?? '',
        judgeProviderId: initial.judgeProviderId,
        judgeModelId: initial.judgeModelId,
      };

  const generateButton = (
    <Button size="small" loading={generating} disabled={!judgeConfigured} data-testid="case-generate-judge" onClick={() => void handleGenerate()}>
      AI 生成
    </Button>
  );

  return (
    <Card
      size="small"
      title={mode === 'new' ? '创建用例' : '编辑用例'}
      extra={
        <Button size="small" data-testid="case-cancel" onClick={onCancel}>
          取消
        </Button>
      }
    >
      <Form form={form} layout="vertical" size="small" initialValues={initialValues} onFinish={handleFinish}>
        <Form.Item name="title" label="标题" rules={[{ required: true, message: '请填写标题' }]}>
          <Input data-testid="case-title" placeholder="例如：为网关补齐转换回归" />
        </Form.Item>

        <Form.Item
          name="taskPrompt"
          label="考题提示词"
          rules={[{ required: true, message: '请填写考题提示词' }]}
          extra="交给智能体的题面；它决定了这一轮比的是什么"
        >
          <Input.TextArea data-testid="case-task-prompt" rows={4} style={monoStyle} />
        </Form.Item>

        <Form.Item
          label="评分提示词"
          required
          extra="可以点「AI 生成」起草，之后仍可手工修改；生成失败不会动你已经写好的内容"
        >
          <Flex vertical gap={4}>
            <Form.Item name="judgePrompt" noStyle rules={[{ required: true, message: '请填写评分提示词' }]}>
              <Input.TextArea data-testid="case-judge-prompt" rows={6} style={monoStyle} />
            </Form.Item>
            <Flex justify="end">
              {judgeConfigured ? (
                generateButton
              ) : (
                // 禁用按钮不触发鼠标事件：Tooltip 必须挂在 span 上（见文件头要点 3）
                <Tooltip title="请先到设置里配置默认评分模型">
                  <span data-testid="case-generate-wrapper">{generateButton}</span>
                </Tooltip>
              )}
            </Flex>
          </Flex>
        </Form.Item>

        <Form.Item
          name="repoPath"
          label="代码仓库"
          // 两条规则各管一段（与标题同口径）：`required` 只判空串，纯空格能过；
          // 少了 `whitespace` 的话，`trim()` 后变成空串 ⇒ 服务端 ZodError ⇒ toast 只显示
          // 「查询参数不合法」（query 文案，但这是请求体），表单上没有任何字段级红字，用户不知道改哪里。
          rules={[
            { required: true, message: '请填写代码仓库的本地绝对路径' },
            { whitespace: true, message: '请填写代码仓库的本地绝对路径' },
          ]}
          extra="只支持本地目录：不做远端 URL 与凭据管理"
        >
          <Input
            data-testid="case-repo-path"
            placeholder="D:\\projects\\gateway"
            // antd 6 已弃用 `addonAfter` / `addonBefore`（每次挂载一条 **error 级**告警，
            // 且只在开发/测试环境出现）；官方替代 `Space.Compact` 会在 Form.Item 与 Input
            // 之间插一层，而 antd 只给 Form.Item 的**直接孩子**注入 value/onChange，
            // 包一层等于该字段永远收不到输入。故用 `suffix` 把按钮留在输入框右端。
            suffix={
              <Button size="small" type="text" autoInsertSpace={false} loading={validating} data-testid="case-validate-repo" onClick={() => void handleValidate()}>
                校验
              </Button>
            }
          />
        </Form.Item>

        {/* 这里冗余判一次 null：靠别名布尔量收窄虽然 TS 4.4+ 支持，但明写一次更稳，
            也省得后人「看着多余」把它删掉再踩一次收窄失败 */}
        {showRepoInfo && repoInfo !== null && (
          <Form.Item label=" " colon={false}>
            <Alert
              data-testid="case-repo-info"
              type="success"
              showIcon
              title={`仓库：${repoInfo.repoName} · 当前分支：${repoInfo.branch}`}
            />
          </Form.Item>
        )}

        {/* AutoComplete 直接做 Form.Item 的孩子（**不套一层 Flex**）：antd 只会给直接孩子注入 value/onChange
            与 label 的 htmlFor 所指的 id，套一层容器会让绑定丢在内层控件上——测试里的 getByLabelText 也会失效。
            这里刻意**不给 data-testid**：antd 的 Select 系组件把额外 props 放到外层容器，对着容器触发 change
            改不到表单值；测试用 label 关联取内层 input（见测试里的 commitInput）。 */}
        <Form.Item
          name="commitHash"
          label="commit hash"
          extra={
            <Flex justify="space-between" align="center" gap={8}>
              <Typography.Text type="secondary">留空 = 默认分支 HEAD；候选只是便利，可手工输入任意合法 hash</Typography.Text>
              <Button size="small" type="text" data-testid="case-load-commits" onClick={onLoadCommits}>
                重新加载候选
              </Button>
            </Flex>
          }
        >
          <AutoComplete
            placeholder="留空 = 默认分支 HEAD"
            options={commits.map((commit) => ({ value: commit.hash, label: `${commit.hash} ${commit.subject}` }))}
            // 候选只有 20 条：按输入前缀过滤即可，不过滤的话输入短哈希时下拉会把无关项排满
            filterOption={(input, option) => String(option?.value ?? '').toLowerCase().startsWith(input.toLowerCase())}
            notFoundContent="暂无候选提交，可手工输入完整 hash"
          />
        </Form.Item>

        <Form.Item label="默认评分模型" extra="留空 = 用设置页里的全局默认评分模型">
          <Select
            allowClear
            placeholder="跟随全局默认"
            value={selectedJudgeValue}
            onChange={handleJudgeChange}
            options={judgeOptions}
          />
        </Form.Item>

        {/* 两个隐藏字段：上面的下拉写的就是它们。用 registered Form.Item 而不是纯 setFieldsValue，
            这样 validateFields / getFieldsValue 能一致地拿到值（未注册的字段只有 store 知道，校验会跳过） */}
        <Form.Item name="judgeProviderId" hidden>
          <Input />
        </Form.Item>
        <Form.Item name="judgeModelId" hidden>
          <Input />
        </Form.Item>

        <Card size="small" title="评分维度（只读预览）" data-testid="case-dimensions">
          <Flex vertical gap={2}>
            {previewDimensions.map((dimension) => (
              <Flex key={dimension.key} gap={8} align="center">
                <Typography.Text code>{dimension.key}</Typography.Text>
                <Typography.Text>{dimension.label}</Typography.Text>
              </Flex>
            ))}
          </Flex>
          <Typography.Text type="secondary">
            本期固定 5 维、等权；总分 = round(各维之和 / (5 × 维度数) × 100)
          </Typography.Text>
        </Card>

        <Flex justify="end" gap={8} style={{ marginTop: 12 }}>
          <Button size="small" onClick={onCancel}>
            取消
          </Button>
          <Button size="small" type="primary" htmlType="submit" loading={saving} data-testid="case-submit">
            {mode === 'new' ? '创建' : '保存'}
          </Button>
        </Flex>
      </Form>
    </Card>
  );
}
```

> 两个实现细节值得留意（写代码时别省）：
> 1. **`Form.Item label=" " colon={false}` 是给回显区占位的**：antd 的垂直表单里没有 label 的孩子会与其它控件的左边缘错开，空 label 把它对齐回同一列。若你的 antd 版本对空字符串 label 有警告，改用 `<Form.Item label={<span />}>`。
> 2. **按钮放进 `Input` 的 `suffix`**而不是并排两个控件，也**不是** `addonAfter`：仓库路径可能很长，右边的「校验」按钮跟着输入框走比固定宽度更省横向空间（右栏最窄只有 320px）；而 `addonAfter` / `addonBefore` 在 antd 6 已弃用（挂载即打 error 级告警，仅开发/测试可见）。官方替代 `Space.Compact` 不可用：它会插一层包裹元素，而 antd 只给 `Form.Item` 的**直接孩子**注入 `value`/`onChange`，包一层等于该字段永远收不到输入。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @aieval/ui test -- case-form-panel.test.tsx`
Expected: PASS。

- [ ] **Step 5: 变异验证（三条守卫各一次）**

在 Task 5 提交之后做（第 7 步提交完再回到这里），还原一律用 `git checkout --`，并核对哈希：

```pwsh
$file = 'packages/client/ui/src/composite/case-form-panel.tsx'
$before = git hash-object $file
```

**变异体 ①（候选当白名单）**：在 `commitHash` 的 `Form.Item` 上加一条「必须命中候选列表」的规则（`extra` 与 `AutoComplete` 子元素保持原样，只加 `rules`）：

```tsx
        <Form.Item
          name="commitHash"
          label="commit hash"
          // 变异体（故意写错）：加一条「必须命中候选列表」的规则
          rules={[
            {
              validator: (_rule, value: string | undefined) =>
                value === undefined || value === '' || commits.some((commit) => commit.hash === value)
                  ? Promise.resolve()
                  : Promise.reject(new Error('请从候选提交里选择')),
            },
          ]}
          extra={
            <Flex justify="space-between" align="center" gap={8}>
              <Typography.Text type="secondary">留空 = 默认分支 HEAD；候选只是便利，可手工输入任意合法 hash</Typography.Text>
              <Button size="small" type="text" data-testid="case-load-commits" onClick={onLoadCommits}>
                重新加载候选
              </Button>
            </Flex>
          }
        >
          <AutoComplete
            placeholder="留空 = 默认分支 HEAD"
            options={commits.map((commit) => ({ value: commit.hash, label: `${commit.hash} ${commit.subject}` }))}
            filterOption={(input, option) => String(option?.value ?? '').toLowerCase().startsWith(input.toLowerCase())}
            notFoundContent="暂无候选提交，可手工输入完整 hash"
          />
        </Form.Item>
```

Run: `pnpm --filter @aieval/ui test -- case-form-panel.test.tsx`
Expected: **FAIL**，失败在 `手工输入的 commit hash 不在候选列表里也能提交`（`onSubmit` 未被调用 / 出现「请从候选提交里选择」）与 `候选为空时仍能提交`。

**变异体 ②（先清空再请求）**：把 `handleGenerate` 里 `try` 之前插入一行清空：

```tsx
    // 变异体（故意写错）：请求之前先清空
    form.setFieldValue('judgePrompt', '');
    try {
```

Run: `pnpm --filter @aieval/ui test -- case-form-panel.test.tsx`
Expected: **FAIL**，失败在 `生成失败不清空已有的评分提示词`（输入框变成空串，不等于 `INITIAL.judgePrompt`）。

**变异体 ③（回显不看路径是否一致）**：把 `showRepoInfo` 的第三个条件删掉：

```tsx
  const showRepoInfo = repoInfo !== null && validatedPath !== null;
```

Run: `pnpm --filter @aieval/ui test -- case-form-panel.test.tsx`
Expected: **FAIL**，失败在 `改了仓库路径之后不再显示上一次的校验回显`。

还原并核对：

```pwsh
git checkout -- packages/client/ui/src/composite/case-form-panel.tsx
git diff --quiet -- packages/client/ui/src/composite/case-form-panel.tsx; if ($LASTEXITCODE -ne 0) { throw '还原不彻底' }
$after = git hash-object $file
if ($before -ne $after) { throw "哈希不一致：$before -> $after" }
git status --short
```

Expected: 无输出，且哈希一致。

- [ ] **Step 6: 导出组件**

在 `packages/client/ui/src/index.ts` 追加（放在 `DemoListPage` 那一行之前）：

```ts
export { CaseFormPanel, type CaseFormPanelProps } from './composite/case-form-panel';
```

- [ ] **Step 7: 跑全量类型检查与提交**

Run: `pnpm --filter @aieval/ui test`
Expected: PASS（含既有用例）。

Run: `pnpm typecheck`
Expected: 零错误。

```bash
git add packages/client/ui/src/composite/case-form-panel.tsx packages/client/ui/src/composite/case-form-panel.test.tsx packages/client/ui/src/index.ts
git commit -m "feat(ui): CaseFormPanel（表单 + AI 生成 + 仓库校验 + commit 候选 + 维度只读预览）"
```

---

## Task 6: `ui` `CaseDetailPanel`（只读详情）

**Files:**
- Create: `packages/client/ui/src/composite/case-detail-panel.tsx`
- Create: `packages/client/ui/src/composite/case-detail-panel.test.tsx`
- Modify: `packages/client/ui/src/index.ts`

**Interfaces:**
- Consumes（契约 §2 / §8）：`@aieval/contracts` 的 `DIMENSIONS` / `type TestCase`；本包 `./base/format` 的 `formatDateTime`
- Produces（契约 §8 的关键 props 名逐字）：

```ts
export interface CaseDetailPanelProps {
  testCase: TestCase;
  /** 引用该用例的评测数；null = 调用方尚不知道这个数（不是 0） */
  referencedRuns: number | null;
  onEdit: () => void;
  onDelete: () => void;
  /** 删除请求在途：给确认按钮上 loading，避免重复点 */
  deleting?: boolean;
}
```

- [ ] **Step 1: 写失败测试 `case-detail-panel.test.tsx`**

```tsx
/**
 * CaseDetailPanel：字段回显、删除确认的文案与回调。
 * 重点是删除提示的两件事：**评测记录会保留**（这是用户敢按下去的依据，§4.4），
 * 以及引用数「未知」与「0」必须长得不一样（把 null 显示成 0 会让人以为删了没影响）。
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { TestCase } from '@aieval/contracts';
import { CaseDetailPanel, type CaseDetailPanelProps } from './case-detail-panel';

const CASE: TestCase = {
  id: 'case-1',
  title: '为网关补齐转换回归',
  repoPath: 'D:\\projects\\gateway',
  commitHash: 'abc1234def567890abc1234def567890abc12345',
  taskPrompt: '为 anthropic-to-chat 补一条回归用例',
  judgePrompt: '按五维评分，重点看是否真的补了用例',
  judgeProviderId: null,
  judgeModelId: null,
  createdAt: '2026-09-22T10:00:00.000Z',
  updatedAt: '2026-09-22T12:30:00.000Z',
};

function setup(overrides: Partial<CaseDetailPanelProps> = {}): ReturnType<typeof render> {
  return render(
    <CaseDetailPanel testCase={CASE} referencedRuns={null} onEdit={vi.fn()} onDelete={vi.fn()} {...overrides} />,
  );
}

describe('CaseDetailPanel', () => {
  it('回显标题、仓库路径、完整 commit 与两段提示词', () => {
    setup();

    expect(screen.getByText(CASE.title)).toBeInTheDocument();
    expect(screen.getByText(CASE.repoPath)).toBeInTheDocument();
    expect(screen.getByText(CASE.commitHash)).toBeInTheDocument();
    expect(screen.getByText(CASE.taskPrompt)).toBeInTheDocument();
    expect(screen.getByText(CASE.judgePrompt)).toBeInTheDocument();
    expect(screen.getByText('2026-09-22 12:30')).toBeInTheDocument();
  });

  it('commitHash 为 null 时显示「默认分支 HEAD」而不是空白', () => {
    setup({ testCase: { ...CASE, commitHash: null } });

    expect(screen.getByText('默认分支 HEAD')).toBeInTheDocument();
  });

  it('未选用例级评分模型时显示「跟随全局默认」', () => {
    setup();

    expect(screen.getByText('跟随全局默认')).toBeInTheDocument();
  });

  it('引用数未知时只给语义说明（不编造一个 0）', () => {
    setup({ referencedRuns: null });

    expect(screen.getByText(/已完成的评测记录会保留/)).toBeInTheDocument();
    expect(screen.queryByText(/已被 \d+ 个评测引用/)).toBeNull();
  });

  it('引用数已知时把数字写进删除提示', () => {
    setup({ referencedRuns: 3 });

    expect(screen.getByText(/已被 3 个评测引用/)).toBeInTheDocument();
    expect(screen.getByText(/评测记录会保留/)).toBeInTheDocument();
  });

  it('点「编辑」调 onEdit', () => {
    const onEdit = vi.fn();
    setup({ onEdit });

    fireEvent.click(screen.getByTestId('case-detail-edit'));

    expect(onEdit).toHaveBeenCalledTimes(1);
  });

  it('删除要走确认：确认后才调 onDelete', async () => {
    const onDelete = vi.fn();
    setup({ onDelete });

    fireEvent.click(screen.getByTestId('case-detail-delete'));
    // 只是打开确认框：此刻绝不能已经删了
    expect(onDelete).not.toHaveBeenCalled();

    fireEvent.click(await screen.findByText('确认删除'));

    expect(onDelete).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @aieval/ui test -- case-detail-panel.test.tsx`
Expected: FAIL —— `Failed to resolve import "./case-detail-panel"`。

- [ ] **Step 3: 写实现 `case-detail-panel.tsx`**

```tsx
'use client';

/**
 * 用例只读详情（右栏内容）：字段回显 + 「编辑」「删除」。
 *
 * 纯展示：不调接口；删除的确认由 Popconfirm 负责「问一句」，真正的删除动作由调用方执行。
 * 三条口径：
 *   1. commit 与仓库路径都给**全量**值（`Typography.Text code`），短哈希只在列表里用——
 *      详情栏是用户核对「这一轮测的到底是哪个提交」的地方，这里再省略就等于没地方能看全；
 *   2. 删除提示必须说清「已完成的评测记录会保留」：评测里冗余存了标题 / 仓库 / commit（§7.2），
 *      这句话是用户敢按下去的依据（§4.4）；
 *   3. `referencedRuns` 为 `null` 时**不显示数字**——把「不知道」显示成 0，会让用户以为删除没有影响。
 */
import { DIMENSIONS, type TestCase } from '@aieval/contracts';
import { Button, Card, Descriptions, Flex, Popconfirm, Typography } from 'antd';
import type { ReactNode } from 'react';
import { formatDateTime } from '../base/format';

export interface CaseDetailPanelProps {
  testCase: TestCase;
  /** 引用该用例的评测数；null = 调用方尚不知道这个数（不是 0） */
  referencedRuns: number | null;
  onEdit: () => void;
  onDelete: () => void;
  /** 删除请求在途：给确认按钮上 loading，避免重复点 */
  deleting?: boolean;
}

export function CaseDetailPanel({ testCase, referencedRuns, onEdit, onDelete, deleting = false }: CaseDetailPanelProps): ReactNode {
  // 用例级评分模型：两个字段要么都有要么都没有（服务端按契约写入），只用 providerId 判空即可
  const judgeModel = testCase.judgeProviderId === null || testCase.judgeModelId === null
    ? '跟随全局默认'
    : `${testCase.judgeProviderId} / ${testCase.judgeModelId}`;

  const deleteHint = referencedRuns === null
    ? '已完成的评测记录会保留（用例标题 / 仓库路径 / commit 已作为快照存在评测里）；用例级缓存仓库会一并删除。'
    : `已被 ${referencedRuns} 个评测引用；评测记录会保留（用例标题 / 仓库路径 / commit 已作为快照存在评测里），用例级缓存仓库会一并删除。`;

  return (
    <Flex vertical gap={8}>
      <Card
        size="small"
        title={testCase.title}
        extra={
          <Flex gap={8}>
            <Button size="small" data-testid="case-detail-edit" onClick={onEdit}>
              编辑
            </Button>
            <Popconfirm
              title="删除这个用例？"
              description={deleteHint}
              okText="确认删除"
              cancelText="取消"
              okButtonProps={{ danger: true, loading: deleting }}
              onConfirm={onDelete}
            >
              <Button size="small" danger data-testid="case-detail-delete">
                删除
              </Button>
            </Popconfirm>
          </Flex>
        }
      >
        {/* antd 6 的 Descriptions 推荐 items（子节点写法已弃用） */}
        <Descriptions
          size="small"
          column={1}
          items={[
            {
              key: 'repoPath',
              label: '代码仓库',
              // 全量路径 + 可选中复制：右栏可能只有 320px，靠换行而不是省略
              children: <Typography.Text code>{testCase.repoPath}</Typography.Text>,
            },
            {
              key: 'commitHash',
              label: 'commit',
              children:
                testCase.commitHash === null ? (
                  <Typography.Text type="secondary">默认分支 HEAD</Typography.Text>
                ) : (
                  <Typography.Text code>{testCase.commitHash}</Typography.Text>
                ),
            },
            { key: 'judgeModel', label: '评分模型', children: judgeModel },
            { key: 'createdAt', label: '创建时间', children: formatDateTime(testCase.createdAt) },
            { key: 'updatedAt', label: '更新时间', children: formatDateTime(testCase.updatedAt) },
            {
              key: 'dimensions',
              label: '评分维度',
              // 本期固定 5 维：这里列出中文标签，让「分数怎么来的」在详情里也能看到
              children: DIMENSIONS.map((dimension) => dimension.label).join(' · '),
            },
          ]}
        />
      </Card>

      <Card size="small" title="考题提示词">
        <Typography.Paragraph style={{ whiteSpace: 'pre-wrap', marginBottom: 0 }}>{testCase.taskPrompt}</Typography.Paragraph>
      </Card>

      <Card size="small" title="评分提示词">
        <Typography.Paragraph style={{ whiteSpace: 'pre-wrap', marginBottom: 0 }}>{testCase.judgePrompt}</Typography.Paragraph>
      </Card>
    </Flex>
  );
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @aieval/ui test -- case-detail-panel.test.tsx`
Expected: PASS。

- [ ] **Step 5: 导出组件**

在 `packages/client/ui/src/index.ts` 追加：

```ts
export { CaseDetailPanel, type CaseDetailPanelProps } from './composite/case-detail-panel';
```

- [ ] **Step 6: 跑全量类型检查与提交**

Run: `pnpm --filter @aieval/ui test`
Expected: PASS。

Run: `pnpm typecheck`
Expected: 零错误。

```bash
git add packages/client/ui/src/composite/case-detail-panel.tsx packages/client/ui/src/composite/case-detail-panel.test.tsx packages/client/ui/src/index.ts
git commit -m "feat(ui): CaseDetailPanel（只读详情 + 编辑/删除，删除提示说明评测记录保留）"
```

---

## Task 7: `web-next` 用例路由

**Files:**
- Create: `apps/web-next/app/api/cases/route.ts`
- Create: `apps/web-next/app/api/cases/[caseId]/route.ts`
- Create: `apps/web-next/app/api/cases/validate-repo/route.ts`
- Create: `apps/web-next/app/api/cases/commits/route.ts`
- Create: `apps/web-next/app/api/cases/generate-judge-prompt/route.ts`
- Create: `apps/web-next/src/route-cases.test.ts`

**Interfaces:**
- Consumes：`@aieval/api` 的 `listCases` / `createCase` / `getCase` / `updateCase` / `deleteCase` / `validateRepo` / `listCommitCandidates` / `generateJudgePrompt`（Task 2、Task 3）；`@aieval/contracts` 的 `CaseCreateSchema` / `CasePatchSchema` / `RepoPathInputSchema` / `GenerateJudgePromptSchema`；`@/src/server-context` 的 `readJsonBody` / `handleApiError`
- Produces（契约 §9 的路由清单，逐字；R7 的形态）：
  - `GET|POST /api/cases`
  - `GET|PUT|DELETE /api/cases/[caseId]`
  - `POST /api/cases/validate-repo`（body `{ repoPath }`）
  - `POST /api/cases/commits`（body `{ repoPath }`）
  - `POST /api/cases/generate-judge-prompt`

- [ ] **Step 1: 写路由（5 个文件）**

`apps/web-next/app/api/cases/route.ts`：

```ts
/**
 * 用例集合接口：GET 列表 / POST 新建。
 * 本文件只做「zod 校验 → 调 api → 错误映射」，不含业务逻辑。
 */
import { createCase, listCases } from '@aieval/api';
import { CaseCreateSchema } from '@aieval/contracts';
import { handleApiError, readJsonBody } from '@/src/server-context';

export async function GET(): Promise<Response> {
  try {
    return Response.json(listCases());
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(req: Request): Promise<Response> {
  try {
    const input = CaseCreateSchema.parse(await readJsonBody(req));
    // 201：确实创建了新资源；客户端只判 res.ok，状态码用语义正确的那个
    return Response.json(createCase(input), { status: 201 });
  } catch (error) {
    return handleApiError(error);
  }
}
```

`apps/web-next/app/api/cases/[caseId]/route.ts`：

```ts
/**
 * 单个用例接口：GET / PUT / DELETE。
 * Next 16 的动态路由上下文里 `params` 是 **Promise**，必须 await——
 * 直接读 `context.params.caseId` 拿到的是 undefined（类型上也不允许）。
 */
import { deleteCase, getCase, updateCase } from '@aieval/api';
import { CasePatchSchema } from '@aieval/contracts';
import { handleApiError, readJsonBody } from '@/src/server-context';

/** 动态段上下文：显式声明而不是用生成的 RouteContext 全局类型，避免依赖 .next/types 的生成时机 */
interface CaseRouteContext {
  params: Promise<{ caseId: string }>;
}

export async function GET(_req: Request, context: CaseRouteContext): Promise<Response> {
  try {
    const { caseId } = await context.params;
    return Response.json(getCase(caseId));
  } catch (error) {
    return handleApiError(error);
  }
}

export async function PUT(req: Request, context: CaseRouteContext): Promise<Response> {
  try {
    const { caseId } = await context.params;
    const patch = CasePatchSchema.parse(await readJsonBody(req));
    return Response.json(updateCase(caseId, patch));
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(_req: Request, context: CaseRouteContext): Promise<Response> {
  try {
    const { caseId } = await context.params;
    // 响应体带 affectedRuns：页面用它提示「N 个评测记录仍可查看」（§4.4）
    return Response.json(deleteCase(caseId));
  } catch (error) {
    return handleApiError(error);
  }
}
```

`apps/web-next/app/api/cases/validate-repo/route.ts`：

```ts
/**
 * 仓库校验：POST { repoPath } → { repoPath, repoName, branch }。
 * 路径形态是**按仓库路径**而不是按 caseId（接口契约 §11 R7）：新建用例时还没有 caseId，
 * 而这件事的输入本来就是路径。
 */
import { validateRepo } from '@aieval/api';
import { RepoPathInputSchema } from '@aieval/contracts';
import { handleApiError, readJsonBody } from '@/src/server-context';

export async function POST(req: Request): Promise<Response> {
  try {
    const { repoPath } = RepoPathInputSchema.parse(await readJsonBody(req));
    return Response.json(validateRepo(repoPath));
  } catch (error) {
    return handleApiError(error);
  }
}
```

`apps/web-next/app/api/cases/commits/route.ts`：

```ts
/**
 * commit 候选：POST { repoPath } → 最近 20 条提交（短哈希 + 提交说明）。
 * 同样按仓库路径（R7）。用 POST 当读用：路径可能很长，塞进 URL query 既难看又有长度上限。
 */
import { listCommitCandidates } from '@aieval/api';
import { RepoPathInputSchema } from '@aieval/contracts';
import { handleApiError, readJsonBody } from '@/src/server-context';

export async function POST(req: Request): Promise<Response> {
  try {
    const { repoPath } = RepoPathInputSchema.parse(await readJsonBody(req));
    return Response.json(listCommitCandidates(repoPath));
  } catch (error) {
    return handleApiError(error);
  }
}
```

`apps/web-next/app/api/cases/generate-judge-prompt/route.ts`：

```ts
/**
 * AI 生成评分提示词：POST { repoPath, taskPrompt, judgeProviderId, judgeModelId }。
 * 非流式（spec §4.3）；未配置评分模型时由 api 层抛 CONFLICT，映射成 409 并在 message 里指向设置页。
 */
import { generateJudgePrompt } from '@aieval/api';
import { GenerateJudgePromptSchema } from '@aieval/contracts';
import { handleApiError, readJsonBody } from '@/src/server-context';

export async function POST(req: Request): Promise<Response> {
  try {
    const input = GenerateJudgePromptSchema.parse(await readJsonBody(req));
    return Response.json(await generateJudgePrompt(input));
  } catch (error) {
    return handleApiError(error);
  }
}
```

- [ ] **Step 2: 写失败测试 `route-cases.test.ts`**

```ts
// @vitest-environment node
/**
 * 用例域路由端到端：/api/cases 全套 + R7 的「按仓库路径」结构守卫。
 *
 * 这份用例管三件事：
 *   1. 「zod 校验 → 调 api → 错误映射」这条链真的接通了（用坏值走真实请求：只有 contracts 导出的
 *      那一份 zod 实例才会映射成 400 + issues，复制出来的第二份会落到 500）；
 *   2. R7 的路由形态钉在**文件系统**上：仓库校验与 commit 候选挂在 cases/validate-repo 与
 *      cases/commits，且**不存在**按 caseId 的旧形态；
 *   3. 生成评分提示词整条链路（含 p0 的 callTextApi）用**假 fetch** 跑通——测试绝不打真实网络。
 *
 * 配置目录、仓库、工作区一律是 mkdtempSync 出来的临时目录：绝不碰真实的 ~/.aieval 与真实仓库。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SETTINGS_DEFAULTS, type Provider } from '@aieval/contracts';
import { loadConfig, saveConfig, setConfigDirForTesting } from '@aieval/core';
import { GET as listCases, POST as createCase } from '@/app/api/cases/route';
import { DELETE as deleteCase, GET as getCase, PUT as updateCase } from '@/app/api/cases/[caseId]/route';
import { POST as listCommits } from '@/app/api/cases/commits/route';
import { POST as generateJudgePrompt } from '@/app/api/cases/generate-judge-prompt/route';
import { POST as validateRepo } from '@/app/api/cases/validate-repo/route';

let dir: string;
let repo: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aieval-route-cases-'));
  setConfigDirForTesting(dir);
  saveConfig({
    ...loadConfig(),
    settings: { ...SETTINGS_DEFAULTS, workspaceRoot: join(dir, 'runs') },
  });
  repo = join(dir, 'gateway');
  mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: repo });
  writeFileSync(join(repo, 'README.md'), '# gateway\n', 'utf8');
  const identity = ['-c', 'user.name=t', '-c', 'user.email=t@e.com'];
  execFileSync('git', [...identity, 'add', '.'], { cwd: repo });
  execFileSync('git', [...identity, 'commit', '-q', '-m', '初始提交'], { cwd: repo });
});

afterEach(() => {
  vi.unstubAllGlobals();
  setConfigDirForTesting(null);
  rmSync(dir, { recursive: true, force: true });
});

/** 造一个请求：与 Next 交给路由的入参同形（原生 Request） */
function jsonRequest(url: string, method: string, body: string): Request {
  return new Request(`http://localhost${url}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body,
  });
}

/** 动态段上下文：Next 16 的 params 是 Promise */
function context(caseId: string): { params: Promise<{ caseId: string }> } {
  return { params: Promise.resolve({ caseId }) };
}

const VALID_BODY = JSON.stringify({
  title: '为网关补齐转换回归',
  repoPath: '', // 每个用例自己填真实路径
  commitHash: null,
  taskPrompt: '补一条回归用例',
  judgePrompt: '按五维评分',
});

/** 建一个用例并返回它的 id（大部分用例都需要一个已存在的对象） */
async function seedCase(): Promise<string> {
  const body = JSON.stringify({ ...JSON.parse(VALID_BODY), repoPath: repo });
  const res = await createCase(jsonRequest('/api/cases', 'POST', body));
  expect(res.status).toBe(201);
  return (await res.json()).id as string;
}

describe('/api/cases', () => {
  it('POST 建用例返回 201，GET 列表能拿到它', async () => {
    const id = await seedCase();

    const res = await listCases();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.map((item: { id: string }) => item.id)).toEqual([id]);
  });

  it('请求体不是合法 JSON → 400 + 「请求体不是合法 JSON」（不是 500）', async () => {
    const res = await createCase(jsonRequest('/api/cases', 'POST', '{坏 JSON'));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('INVALID_QUERY');
    expect(body.error.message).toBe('请求体不是合法 JSON');
  });

  it('缺 title → 400，且 context 是真 zod 的 issues（path 指向 title）', async () => {
    const res = await createCase(jsonRequest('/api/cases', 'POST', JSON.stringify({ repoPath: repo })));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('INVALID_QUERY');
    expect(body.error.context[0].path).toEqual(['title']);
  });

  it('仓库不是 git 仓库 → 400 NOT_A_GIT_REPO（含具体路径）', async () => {
    const plain = join(dir, 'plain-dir');
    mkdirSync(plain, { recursive: true });

    const res = await createCase(jsonRequest('/api/cases', 'POST', JSON.stringify({ ...JSON.parse(VALID_BODY), repoPath: plain })));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('NOT_A_GIT_REPO');
    expect(body.error.message).toContain(plain);
  });
});

describe('/api/cases/[caseId]', () => {
  it('GET 取详情；未知 id → 404 NOT_FOUND', async () => {
    const id = await seedCase();

    const found = await getCase(new Request('http://localhost/api/cases/x'), context(id));
    expect(found.status).toBe(200);
    expect((await found.json()).id).toBe(id);

    const missing = await getCase(new Request('http://localhost/api/cases/x'), context('missing'));
    expect(missing.status).toBe(404);
    expect((await missing.json()).error.code).toBe('NOT_FOUND');
  });

  it('PUT 应用补丁', async () => {
    const id = await seedCase();

    const res = await updateCase(jsonRequest(`/api/cases/${id}`, 'PUT', '{"title":"改过的标题"}'), context(id));

    expect(res.status).toBe(200);
    expect((await res.json()).title).toBe('改过的标题');
  });

  it('DELETE 返回 { affectedRuns }', async () => {
    const id = await seedCase();

    const res = await deleteCase(new Request(`http://localhost/api/cases/${id}`, { method: 'DELETE' }), context(id));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ affectedRuns: 0 });
  });
});

describe('R7：仓库校验与 commit 候选按仓库路径', () => {
  it('POST cases/validate-repo 回显仓库名与分支', async () => {
    const res = await validateRepo(jsonRequest('/api/cases/validate-repo', 'POST', JSON.stringify({ repoPath: repo })));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.repoName).toBe('gateway');
    expect(body.repoPath).toBe(repo);
    expect(typeof body.branch).toBe('string');
  });

  it('POST cases/validate-repo 对非仓库 → 400 NOT_A_GIT_REPO', async () => {
    const plain = join(dir, 'plain-dir');
    mkdirSync(plain, { recursive: true });

    const res = await validateRepo(jsonRequest('/api/cases/validate-repo', 'POST', JSON.stringify({ repoPath: plain })));

    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('NOT_A_GIT_REPO');
  });

  it('POST cases/commits 返回候选提交', async () => {
    const res = await listCommits(jsonRequest('/api/cases/commits', 'POST', JSON.stringify({ repoPath: repo })));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].subject).toBe('初始提交');
  });

  it('repoPath 缺失 → 400（zod 校验在路由层，不落到 git）', async () => {
    const res = await listCommits(jsonRequest('/api/cases/commits', 'POST', '{}'));

    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('INVALID_QUERY');
  });

  // R7 的结构守卫：钉的是**文件系统**，因为「路由挂在哪个路径」在单元测试里唯一可观察的面就是文件位置。
  // 变异验证见 Step 5。
  it('路由文件挂在 cases/validate-repo 与 cases/commits，不存在按 caseId 的旧形态', () => {
    const casesApiDir = join(import.meta.dirname, '..', 'app', 'api', 'cases');

    expect(existsSync(join(casesApiDir, 'validate-repo', 'route.ts'))).toBe(true);
    expect(existsSync(join(casesApiDir, 'commits', 'route.ts'))).toBe(true);
    expect(existsSync(join(casesApiDir, 'generate-judge-prompt', 'route.ts'))).toBe(true);
    // 旧形态：创建用例时还没有 caseId，「按 caseId 校验仓库」根本没法在新建流程里调用（契约 §11 R7）
    expect(existsSync(join(casesApiDir, '[caseId]', 'validate-repo'))).toBe(false);
    expect(existsSync(join(casesApiDir, '[caseId]', 'commits'))).toBe(false);
  });
});

describe('/api/cases/generate-judge-prompt', () => {
  const PROVIDER: Provider = {
    id: 'provider-1',
    name: 'DeepSeek 官方',
    protocolType: 'openai',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: 'sk-test',
    models: [{ id: 'deepseek-chat', source: 'manual' }],
    createdAt: '2026-09-22T10:00:00.000Z',
    updatedAt: '2026-09-22T10:00:00.000Z',
  };

  /**
   * 配置一个全局默认评分模型。
   * 假响应按 OpenAI Chat Completions 的形状给（`choices[0].message.content`）——
   * 若 p0 的 callTextApi 取的是别的字段，要改的是**这里的假响应**，不是被测行为。
   */
  function configureJudge(): void {
    saveConfig({
      ...loadConfig(),
      providers: [PROVIDER],
      // 保留已有设置（含工作区根目录）：测试只该改它关心的字段
      settings: { ...loadConfig().settings, defaultJudge: { providerId: PROVIDER.id, modelId: 'deepseek-chat' } },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    prompt: '评分提示词正文',
                    dimensions: ['correctness', 'requirement', 'quality', 'robustness', 'maintainability'],
                  }),
                },
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );
  }

  it('返回 { prompt, dimensions }（走真实的 callTextApi + 假 fetch）', async () => {
    configureJudge();

    const res = await generateJudgePrompt(
      jsonRequest('/api/cases/generate-judge-prompt', 'POST', JSON.stringify({ repoPath: repo, taskPrompt: '补一条回归' })),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.prompt).toBe('评分提示词正文');
    expect(body.dimensions).toHaveLength(5);
    // 上游调用只打假 fetch，永远没有真实网络；顺带钉住地址来自配置里的 baseUrl
    const [url] = vi.mocked(fetch).mock.calls[0]!;
    expect(String(url)).toContain('api.deepseek.com');
  });

  it('未配置评分模型 → 409 CONFLICT，message 指向设置页，且不打上游', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const res = await generateJudgePrompt(
      jsonRequest('/api/cases/generate-judge-prompt', 'POST', JSON.stringify({ repoPath: repo, taskPrompt: '补一条回归' })),
    );

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('CONFLICT');
    expect(body.error.message).toContain('设置');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('模型返回的不是 JSON → 500 JUDGE_PARSE_FAILED，并在 context 里保留原文', async () => {
    configureJudge();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: '这段代码写得不错。' } }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );

    const res = await generateJudgePrompt(
      jsonRequest('/api/cases/generate-judge-prompt', 'POST', JSON.stringify({ repoPath: repo, taskPrompt: '补一条回归' })),
    );

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe('JUDGE_PARSE_FAILED');
    expect(JSON.stringify(body.error.context)).toContain('这段代码写得不错');
  });
});
```

- [ ] **Step 3: 跑测试确认通过**

Run: `pnpm --filter @aieval/web-next test -- route-cases.test.ts`
Expected: PASS。

Run: `pnpm typecheck`
Expected: 零错误（若报 `@/app/api/cases/[caseId]/route` 解析不到，检查 `apps/web-next/vitest.config.ts` 的 `resolve.alias` 是否仍是基于 `import.meta.dirname` 推导——本用例正是它的第二个守卫）。

- [ ] **Step 4: 提交**

```bash
git add apps/web-next/app/api/cases/route.ts apps/web-next/app/api/cases/[caseId]/route.ts apps/web-next/app/api/cases/validate-repo/route.ts apps/web-next/app/api/cases/commits/route.ts apps/web-next/app/api/cases/generate-judge-prompt/route.ts apps/web-next/src/route-cases.test.ts
git commit -m "feat(web-next): 用例域路由（CRUD + 按仓库路径的校验/候选 + 生成评分提示词）"
```

- [ ] **Step 5: 变异验证——R7 结构守卫**

```pwsh
$old = 'apps/web-next/app/api/cases/[caseId]/validate-repo'
New-Item -ItemType Directory -Force -Path $old | Out-Null
Copy-Item 'apps/web-next/app/api/cases/validate-repo/route.ts' (Join-Path $old 'route.ts')
```

Run: `pnpm --filter @aieval/web-next test -- route-cases.test.ts`
Expected: **FAIL**，失败在 `路由文件挂在 cases/validate-repo 与 cases/commits，不存在按 caseId 的旧形态`（`expected true to be false`）。

还原并核对：

```pwsh
Remove-Item -Recurse -Force 'apps/web-next/app/api/cases/[caseId]/validate-repo'
Test-Path 'apps/web-next/app/api/cases/[caseId]/validate-repo'
git status --short
```

Expected: `False`，且 `git status --short` 无输出（没有留下任何未跟踪文件）。

---

## Task 8: 用例页（列表 + 右栏三态）

**Files:**
- Create: `apps/web-next/src/repo-name.ts`
- Create: `apps/web-next/src/repo-name.test.ts`
- Create: `apps/web-next/src/judge-gate.ts`（`isJudgeConfigured`：R30 的「对着 providers 解析」+ 用例级覆盖 + R32 的半配置判不可用）
- Create: `apps/web-next/src/judge-gate.test.ts`
- Create: `apps/web-next/src/case-panel-state.ts`（右栏状态机：`none` / `no-selection` / `loading` / `not-found` / `stale` / `edit` / `detail`）
- Create: `apps/web-next/src/case-panel-state.test.ts`
- Modify: `apps/web-next/app/cases/page.tsx`（整体替换：当前是占位页）
- Create: `docs/superpowers/notes/2026-09-22-features-p2-smoke.md`（冒烟记录，内容由 Step 4 的清单结果填写）

> 三个 `.ts` 助手（外加 `repo-name.ts`）是**本页唯一有自动化测试面的部分**：`apps/web-next` 保留 `jsx: preserve`、不能写 `.tsx` 测试，页面本身没有测试夹具。所以页面里每一处**分支决策**（判定、状态机、路径解析）都要抽到这些纯函数里，页面只做「URL ↔ 状态」的翻译。这是 p1 阶段评审的建议，也是 p2 两轮修复波的实际落点。

**Interfaces:**
- Consumes：`@aieval/client` 的全部用例 hooks（Task 4）+ `useProviders` / `useSettings`（p1）；`@aieval/ui` 的 `CaseFormPanel` / `CaseDetailPanel`（Task 5、Task 6）/ `ListDetailLayout` / `Toolbar` / `EllipsisText` / `EmptyState` / `formatDateTime` / `shortHash`；`@/src/nav` 的 `NAV_ITEMS` / `NavKey`
- Produces：`repoNameOf(repoPath: string): string`（应用内工具，非跨计划契约）；`/cases` 页的 URL 契约 `?panel=detail|new|edit&id=<caseId>`

- [ ] **Step 1: 写失败测试 `repo-name.test.ts`**

```ts
// @vitest-environment node
/**
 * 路径 → 仓库名：列表的「仓库名」列。
 * 契约里的 TestCase 只有 repoPath（没有 repoName），列表按路径末段显示；
 * 这条工具必须同时认 Windows 反斜杠与 POSIX 斜杠——本机跑在 Windows 上，但路径可能来自 WSL 挂载或网络盘。
 */
import { describe, expect, it } from 'vitest';
import { repoNameOf } from './repo-name';

describe('repoNameOf', () => {
  it('Windows 反斜杠路径取末段', () => {
    expect(repoNameOf('D:\\projects\\gateway')).toBe('gateway');
  });

  it('POSIX 路径取末段', () => {
    expect(repoNameOf('/home/me/gateway')).toBe('gateway');
  });

  it('混用分隔符也取末段', () => {
    expect(repoNameOf('D:/projects\\gateway')).toBe('gateway');
  });

  it('结尾带分隔符时不返回空串', () => {
    expect(repoNameOf('D:\\projects\\gateway\\')).toBe('gateway');
    expect(repoNameOf('/home/me/gateway/')).toBe('gateway');
  });

  it('没有分隔符时原样返回（相对路径 / 裸目录名）', () => {
    expect(repoNameOf('gateway')).toBe('gateway');
  });

  it('空串返回空串（不抛错：列表里不该因为一条坏数据整页崩掉）', () => {
    expect(repoNameOf('')).toBe('');
  });

  it('只有根目录时返回根本身（不返回空串）', () => {
    expect(repoNameOf('C:\\')).toBe('C:');
  });
});
```

- [ ] **Step 2: 跑测试确认失败，然后写实现**

Run: `pnpm --filter @aieval/web-next test -- repo-name.test.ts`
Expected: FAIL —— `Failed to resolve import "./repo-name"`。

`apps/web-next/src/repo-name.ts`：

```ts
/**
 * 路径 → 仓库名（用例列表的「仓库名」列）。
 *
 * 为什么需要它：契约里的 `TestCase` 只有 `repoPath`，没有 `repoName`（仓库名是校验时 git 回显的
 * 瞬时信息，不落盘）。列表里显示一整条深路径既挤掉别的列又读不出重点，取末段最可读，全路径放 Tooltip。
 * 两个平台的斜杠都要认：本项目跑在 Windows 上，但路径可能来自 WSL 挂载或网络盘。
 */
export function repoNameOf(repoPath: string): string {
  // 先去尾部所有分隔符：'D:\projects\gateway\' 的末段不该是空串
  const trimmed = repoPath.replace(/[\\/]+$/, '');
  if (trimmed === '') return repoPath;
  const separatorIndex = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'));
  return separatorIndex === -1 ? trimmed : trimmed.slice(separatorIndex + 1);
}
```

Run: `pnpm --filter @aieval/web-next test -- repo-name.test.ts`
Expected: PASS。

- [ ] **Step 3: 重写 `apps/web-next/app/cases/page.tsx`**

```tsx
'use client';

/**
 * 用例页：左栏列表 + 右栏（详情 / 创建表单 / 编辑表单）。
 *
 * 右栏三种内容**共用一个栏位**，由 `?panel=detail|new|edit&id=…` 决定（spec §4.1：不叠加、不弹层）。
 * 把状态放进 URL 换来两件事：刷新后还在这一屏、链接可以直接发给别人；代价是右栏的
 * 「这一次编辑」的临时状态（已校验的仓库、生成出的维度）必须在切换面板时复位——留在那里会把
 * 上一个用例的校验结果显示给下一个用例，让人以为新用例也校验过了。
 *
 * 为什么整块内容包在 `<Suspense>` 里：`useSearchParams` 会让最近的 Suspense 边界退化成客户端渲染，
 * Next 16 的生产构建在缺少边界时直接以「Missing Suspense boundary with useSearchParams」失败
 * （见 apps/web-next/node_modules/next/dist/docs/01-app/03-api-reference/04-functions/use-search-params.md）。
 *
 * 右栏的**分支决策全部抽在 `@/src/case-panel-state` 里**（`resolveCasePanel` 返回判别联合），页面只按
 * `panelView.kind` 渲染 —— 这不是洁癖：本应用不能写 `.tsx` 测试，页面自己没有任何测试面，
 * 决策留在页面里就等于没有守卫。其中最容易写错的一条是**「详情刷新失败」不等于「用例不存在」**：
 * 只要手上还有上一次成功读到的用例，就必须走 `stale`（渲染旧数据 + 一条警告），
 * 否则取数一失败就把用户已经敲进表单的内容整片吞掉。
 * `stale` 与就绪两个分支里，面板的位置**不同**（多了一条 Alert），真正让 React 复用同一个
 * `CaseFormPanel` 实例、从而保住输入的是 `renderCase` 里那个稳定的 `key={'case-edit-' + id}`
 * ——**那个 key 是承重的，不许删**（p2 阶段评审 F6：注释曾把「位置不变」误写成承重结构）。
 */
import {
  useCases,
  useCommitCandidates,
  useCreateCase,
  useDeleteCase,
  useGenerateJudgePrompt,
  useProviders,
  useSettings,
  useTestCase,
  useUpdateCase,
  useValidateRepo,
} from '@aieval/client';
import {
  DIMENSIONS,
  type CaseCreate,
  type DimensionKey,
  type GenerateJudgePromptInput,
  type RepoInfo,
  type TestCase,
} from '@aieval/contracts';
import {
  AppTopNav,
  CaseDetailPanel,
  CaseFormPanel,
  EllipsisText,
  EmptyState,
  ListDetailLayout,
  Toolbar,
  formatDateTime,
  shortHash,
} from '@aieval/ui';
import { Alert, Button, Card, Flex, Skeleton, Table, Tooltip, Typography, message } from 'antd';
import type { TableColumnsType } from 'antd';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useState } from 'react';
import { useSWRConfig } from 'swr';
import { NAV_ITEMS, type NavKey } from '@/src/nav';
import { resolveCasePanel } from '@/src/case-panel-state';
import { isJudgeConfigured } from '@/src/judge-gate';
import { repoNameOf } from '@/src/repo-name';

/** 右栏的三种内容 */
type PanelKind = 'detail' | 'new' | 'edit';

const ACTIVE_NAV: NavKey = 'cases';

/** commit 候选的 SWR key 前缀（与 client 包里 useCommitCandidates 的 key 第一段一致） */
const COMMITS_KEY = '/api/cases/commits';

/** 固定 5 维的 key：生成之前预览区显示的就是它（本期维度不可自定义） */
const FIXED_DIMENSIONS: DimensionKey[] = DIMENSIONS.map((dimension) => dimension.key);

export default function Page(): React.ReactNode {
  return (
    <Suspense fallback={<CasesFallback />}>
      <CasesWorkspace />
    </Suspense>
  );
}

/** 预渲染期的兜底：只画壳与占位，**不读 search params**（读它正是需要 Suspense 的原因） */
function CasesFallback(): React.ReactNode {
  const router = useRouter();
  return (
    <>
      <AppTopNav items={[...NAV_ITEMS]} active={ACTIVE_NAV} onNavigate={(href) => router.push(href)} />
      <Card size="small" style={{ margin: 16 }}>
        <Skeleton active />
      </Card>
    </>
  );
}

/** URL → 右栏状态；非法值一律当「不显示右栏」，不抛错（链接可能被人手改） */
function readPanel(raw: string | null): PanelKind | null {
  return raw === 'detail' || raw === 'new' || raw === 'edit' ? raw : null;
}

/** 错误 → 可展示文案：ServiceError 的 message 已经是中文，其余情况兜底成 String(error) */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function CasesWorkspace(): React.ReactNode {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { mutate: mutateCache } = useSWRConfig();

  const panel = readPanel(searchParams.get('panel'));
  const id = searchParams.get('id');
  const caseIdForQuery = panel === 'detail' || panel === 'edit' ? id : null;

  const { cases, error: listError } = useCases();
  const { testCase, error: caseError } = useTestCase(caseIdForQuery);
  const { create, isCreating } = useCreateCase();
  const { update, isUpdating } = useUpdateCase();
  const { remove, isDeleting } = useDeleteCase();
  const { validate, isValidating } = useValidateRepo();
  const { generate, isGenerating } = useGenerateJudgePrompt();
  const { providers } = useProviders();
  const { settings } = useSettings();
  // 未配置评分模型时「AI 生成」必须禁用（§4.3）：判的是「有没有**可用**的评分模型」，
  // 而不是「有没有供应商」，也不只是「defaultJudge 非空」。判定本身抽在
  // `@/src/judge-gate`（有 `.test.ts`，是本页唯一能自动化的部分），口径见那里的文件头：
  //   · R30：必须对着 providers 把这一对 id **解析出来**（删供应商/删模型后 defaultJudge 会悬空，
  //     只判非空 ⇒ 按钮可用、点下去才在 resolveJudgeRoute 抛 CONFLICT）；
  //   · 用例级覆盖优先：这一次生成真正会走的那一对才是判定对象（用例覆盖 > 全局默认）；
  //   · R32：半配置（用例只填一个 id）判**不可用**、**不回落**全局——服务端对半配置直接抛 CONFLICT。
  // 只在编辑态传用例覆盖：新建时没有用例可覆盖，详情栏不用这个闸门。
  const judgeConfigured = isJudgeConfigured(settings, providers, panel === 'edit' ? testCase ?? null : null);

  /** 已校验通过的仓库路径：commit 候选按它取（R7：按仓库路径，不带 caseId） */
  const [validatedRepoPath, setValidatedRepoPath] = useState<string | null>(null);
  const [repoInfo, setRepoInfo] = useState<RepoInfo | null>(null);
  const [dimensions, setDimensions] = useState<DimensionKey[]>(FIXED_DIMENSIONS);
  const { commits } = useCommitCandidates(validatedRepoPath);

  /**
   * 切换右栏：状态只存在 URL 里，同时复位「属于这一次编辑」的临时状态（见文件头）。
   */
  const go = useCallback(
    (next: { panel: PanelKind | null; id?: string }): void => {
      setValidatedRepoPath(null);
      setRepoInfo(null);
      setDimensions(FIXED_DIMENSIONS);
      const params = new URLSearchParams();
      if (next.panel !== null) params.set('panel', next.panel);
      if (next.id !== undefined) params.set('id', next.id);
      const query = params.toString();
      router.push(query === '' ? '/cases' : `/cases?${query}`);
    },
    [router],
  );

  /** 校验仓库：成功才记下路径（commit 候选按它取）；失败原因在这里统一提示，并把错误抛回面板 */
  const handleValidateRepo = async (repoPath: string): Promise<RepoInfo> => {
    try {
      const info = await validate(repoPath);
      setRepoInfo(info);
      setValidatedRepoPath(repoPath);
      return info;
    } catch (error) {
      void message.error(errorMessage(error));
      // 失败的校验不得留下上一次的成功回显
      setRepoInfo(null);
      setValidatedRepoPath(null);
      throw error;
    }
  };

  /** 生成评分提示词：成功才更新维度预览；失败提示原因并把错误抛回面板（面板据此不写回输入框） */
  const handleGenerate = async (input: GenerateJudgePromptInput): Promise<{ prompt: string; dimensions: DimensionKey[] }> => {
    try {
      const generated = await generate(input);
      setDimensions(generated.dimensions);
      return generated;
    } catch (error) {
      void message.error(errorMessage(error));
      throw error;
    }
  };

  /** 重新加载候选提交：用户刚在仓库里提交了代码，想让新提交出现在候选里 */
  const reloadCommits = useCallback((): void => {
    if (validatedRepoPath === null) return;
    // 按键前缀过滤重取（而不是复刻 hook 内部的 key 形状）：候选列表是按仓库路径缓存的，
    // SWR 默认去重不会因为再点一次就重取，所以这里显式 revalidate
    void mutateCache((key) => Array.isArray(key) && key[0] === COMMITS_KEY, undefined, { revalidate: true });
  }, [mutateCache, validatedRepoPath]);

  const handleSubmit = (values: CaseCreate): void => {
    if (panel === 'edit' && id !== null) {
      void update(id, values)
        .then(() => {
          void message.success('用例已保存');
          go({ panel: 'detail', id });
        })
        .catch((error: unknown) => void message.error(errorMessage(error)));
      return;
    }
    void create(values)
      .then((created) => {
        void message.success('用例已创建');
        go({ panel: 'detail', id: created.id });
      })
      .catch((error: unknown) => void message.error(errorMessage(error)));
  };

  /**
   * 删除用例。受影响评测数来自 DELETE 的响应（契约里没有「按用例查评测数」的路由，
   * 见本计划的实现层修正 R-p2-B）——数字在这里回显，删除本身不阻塞。
   */
  const handleDelete = (): void => {
    if (id === null) return;
    void remove(id)
      .then((result) => {
        void message.success(
          result.affectedRuns === 0
            ? '用例已删除'
            : `用例已删除；${result.affectedRuns} 个评测记录的冗余快照仍可查看`,
        );
        go({ panel: null });
      })
      .catch((error: unknown) => void message.error(errorMessage(error)));
  };

  const columns: TableColumnsType<TestCase> = [
    {
      title: '标题',
      dataIndex: 'title',
      render: (title: string) => <EllipsisText text={title} width={300} />,
    },
    {
      title: '仓库名',
      dataIndex: 'repoPath',
      width: 200,
      render: (repoPath: string) => (
        // 列里只给末段，全路径在 Tooltip：深路径会把这列撑开、把标题挤没
        <Tooltip title={repoPath}>
          <Typography.Text>{repoNameOf(repoPath)}</Typography.Text>
        </Tooltip>
      ),
    },
    {
      title: 'commit',
      dataIndex: 'commitHash',
      width: 110,
      render: (commitHash: string | null) =>
        commitHash === null ? (
          <Typography.Text type="secondary">默认 HEAD</Typography.Text>
        ) : (
          // Tooltip 里必须是**全量** hash：短哈希再显示一遍等于没有 Tooltip（§4.1）
          <Tooltip title={commitHash}>
            <Typography.Text code>{shortHash(commitHash)}</Typography.Text>
          </Tooltip>
        ),
    },
    {
      title: '更新时间',
      dataIndex: 'updatedAt',
      width: 150,
      render: (updatedAt: string) => formatDateTime(updatedAt),
    },
  ];

  const listNode = (
    <Flex vertical style={{ height: '100%', minHeight: 0 }}>
      <Toolbar
        title="用例"
        extra={
          <Button type="primary" size="small" data-testid="cases-create" onClick={() => go({ panel: 'new' })}>
            创建用例
          </Button>
        }
      />
      {listError !== undefined && listError !== null && (
        <Alert type="error" showIcon title={`用例列表读不出来：${errorMessage(listError)}`} />
      )}
      {cases === undefined ? (
        <Card size="small">
          <Skeleton active />
        </Card>
      ) : cases.length === 0 ? (
        <EmptyState
          title="还没有用例"
          description="用例 = 仓库 + commit + 考题提示词，是评测的输入"
          action={{ label: '创建用例', onClick: () => go({ panel: 'new' }) }}
        />
      ) : (
        <Table<TestCase>
          size="small"
          rowKey="id"
          columns={columns}
          dataSource={cases}
          pagination={false}
          scroll={{ y: 'calc(100vh - 240px)' }}
          onRow={(record) => ({
            onClick: () => go({ panel: 'detail', id: record.id }),
            style:
              record.id === caseIdForQuery
                ? { background: 'var(--app-selected)', cursor: 'pointer' }
                : { cursor: 'pointer' },
          })}
        />
      )}
    </Flex>
  );

  const renderPanel = (): React.ReactNode => {
    if (panel === null) return null;

    const sharedFormProps = {
      providers: providers ?? [],
      judgeConfigured,
      saving: isCreating || isUpdating,
      generating: isGenerating,
      validating: isValidating,
      commits: commits ?? [],
      repoInfo,
      dimensions,
      onSubmit: handleSubmit,
      onCancel: () => go({ panel: null }),
      onValidateRepo: handleValidateRepo,
      onGenerate: handleGenerate,
      onLoadCommits: reloadCommits,
    };

    if (panel === 'new') {
      // key 固定为 'case-new'：新建面板每次都是全新的空表单
      return <CaseFormPanel key="case-new" mode="new" {...sharedFormProps} />;
    }
    if (id === null) {
      return <EmptyState title="没有选中用例" description="从左侧列表点一个用例，或点右上「创建用例」" />;
    }
    if (caseError !== undefined && caseError !== null) {
      // 手改 URL 里的 id、或用例已被别的标签页删掉：给出路，而不是空白右栏
      return (
        <EmptyState
          title="用例不存在"
          description="它可能已经被删除；也可以直接用右上「创建用例」新建一个"
          action={{ label: '创建用例', onClick: () => go({ panel: 'new' }) }}
        />
      );
    }
    if (testCase === undefined) {
      return (
        <Card size="small">
          <Skeleton active />
        </Card>
      );
    }
    if (panel === 'edit') {
      // key 带上 id：antd 的 initialValues 只在挂载时读一次，切换用例必须重挂载
      return <CaseFormPanel key={`case-edit-${testCase.id}`} mode="edit" initial={testCase} {...sharedFormProps} />;
    }
    return (
      <CaseDetailPanel
        testCase={testCase}
        // p2 阶段拿不到删前的引用数（契约里没有对应路由，见 R-p2-B）；数字在删除成功的提示里回显
        referencedRuns={null}
        onEdit={() => go({ panel: 'edit', id: testCase.id })}
        onDelete={handleDelete}
        deleting={isDeleting}
      />
    );
  };

  return (
    <>
      <AppTopNav items={[...NAV_ITEMS]} active={ACTIVE_NAV} onNavigate={(href) => router.push(href)} />
      <ListDetailLayout
        list={listNode}
        detail={renderPanel()}
        detailOpen={panel !== null}
        widthStorageKey="cases-detail-width"
      />
    </>
  );
}
```

Run: `pnpm typecheck`
Expected: 零错误。

Run: `pnpm lint`
Expected: 零错误（注意 `ui` 包不许 import `@aieval/client`——本文件在 `web-next`，可以）。

- [ ] **Step 4: 浏览器手动验收（本任务没有自动化页面测试可用）**

`apps/web-next` 不能写 `.tsx` 测试，所以页面靠真实浏览器验收。启动服务并在后台保持：

Run: `pnpm dev`（后台运行），浏览器打开 `http://localhost:3083/cases`。

| # | 操作 | 期望 | 证据 |
|---|---|---|---|
| 1 | 首次进入（没有用例） | 左栏空态引导「创建用例」；点它后**右栏出现表单**（不弹层、不叠加） | 截图 + URL 变成 `?panel=new` |
| 2 | 直接点「创建」（什么都不填） | 中文必填提示（「请填写标题」等），不提交 | 截图 |
| 3 | 填标题 / 考题提示词 / 评分提示词，仓库填本仓库路径，点「校验」 | 出现绿色回显「仓库：ai-result-evaluation · 当前分支：xxx」 | 截图 + `git -C D:\zhanglei1120\Github\ai-result-evaluation branch --show-current` 互证 |
| 4 | 点 commit 输入框 | 下拉出现最近提交；**此时手工输入一个不在候选里的合法 hash（`git rev-parse HEAD~1` 的结果）**，点「创建」 | 创建成功且详情栏显示的是该完整 hash（守卫 ① 的真机验证） | 截图 + 详情栏 hash 与 `git rev-parse` 输出互证 |
| 5 | 刷新页面（URL 仍带 `?panel=detail&id=…`） | 仍是该用例的详情栏（右栏宽度也保持） | 截图 |
| 6 | 详情栏点「编辑」 | 右栏**换成**表单（栏宽不变、列表不消失），字段已预填 | 截图 + 前后右栏 `getBoundingClientRect().width` 一致 |
| 7 | 在设置页清掉默认评分模型，回到用例编辑栏 | 「AI 生成」按钮禁用；鼠标悬停出现「请先到设置里配置默认评分模型」 | 截图 |
| 8 | 配好默认评分模型后点「AI 生成」 | 评分提示词被回填、维度预览更新；**失败时（把模型名改成不存在的）提示词内容不变** | 截图 + 两次点击前后文本框内容对比 |
| 9 | 详情栏点「删除」 | 出现确认框，文案含「已完成的评测记录会保留」；确认后列表少一条并提示已删除 | 截图 + `Test-Path {workspaceRoot}\cases\{caseId}` 为 False（CLI 复核缓存目录已删） |
| 10 | 手改 URL 为 `?panel=bogus&id=不存在的id` | 右栏关闭或显示「用例不存在」，列表照常可用、不白屏 | 截图 |

第 4、8、9 项必须留证：它们分别对应「候选不是白名单」「生成失败不清空」「删除只删该删的」三条最容易回归的行为。

把结果写进 `docs/superpowers/notes/2026-09-22-features-p2-smoke.md`（格式：范围清单逐项 ✅/❌、操作路径、证据、未覆盖项与理由；未覆盖项不要写成待办，要写清「为什么没覆盖、由谁覆盖」）。冒烟结束后停掉后台 dev 进程。

- [ ] **Step 5: 提交**

```bash
git add apps/web-next/src/repo-name.ts apps/web-next/src/repo-name.test.ts apps/web-next/app/cases/page.tsx docs/superpowers/notes/2026-09-22-features-p2-smoke.md
git commit -m "feat(web-next): 用例页重写（列表 + 右栏详情/创建/编辑三态，URL 驱动）"
```

---

## Task 9: 删示例页 + 导航守卫 + 修正 spec §8 + 收尾验证

**Files:**
- Delete: `apps/web-next/app/demo/page.tsx`
- Delete: `apps/web-next/src/testing/demo-fixtures.ts`
- Delete: `packages/client/ui/src/composite/demo-list-page.tsx`
- Modify: `packages/client/ui/src/index.ts`（删掉 `DemoListPage` 那一行）
- Create: `apps/web-next/src/nav.test.ts`
- Modify: `docs/superpowers/specs/2026-09-22-features-design.md`（**只改 §8 路由清单的两行**，见「本计划对 spec 的实现层修正」R7）

**Interfaces:**
- Consumes：Task 5–8 的产出（用例页落地后示例页才允许删，spec §2 末段）
- Produces：无新增出口（本任务是删除与文档修正）

- [ ] **Step 1: 写导航守卫测试 `nav.test.ts`**

```ts
// @vitest-environment node
/**
 * 导航项守卫：脚手架示例页 `/demo` 已随用例页落地而删除（spec §2 末段、接口契约 §9）。
 * 这条守的是「示例页被重新加回来」——那会让新用户点进一个用假数据的页面，
 * 而且它当年就是为了验证布局原语才存在的，现在布局原语已经有了真实消费者。
 */
import { describe, expect, it } from 'vitest';
import { NAV_ITEMS } from './nav';

describe('NAV_ITEMS', () => {
  it('只有用例 / 评测 / 设置三项', () => {
    expect(NAV_ITEMS.map((item) => item.key)).toEqual(['cases', 'runs', 'settings']);
  });

  it('不含 /demo（示例页已删除）', () => {
    expect(NAV_ITEMS.some((item) => item.href === '/demo')).toBe(false);
  });
});
```

Run: `pnpm --filter @aieval/web-next test -- nav.test.ts`
Expected: PASS（当前 `nav.ts` 里本来就没有 demo 项；这条测试是防止它被加回来）。

- [ ] **Step 2: 变异验证——导航守卫**

把 demo 项加回 `apps/web-next/src/nav.ts`：

```ts
export const NAV_ITEMS = [
  { key: 'cases', label: '用例', href: '/cases' },
  { key: 'runs', label: '评测', href: '/runs' },
  { key: 'settings', label: '设置', href: '/settings' },
  { key: 'demo', label: '示例', href: '/demo' },
] as const;
```

Run: `pnpm --filter @aieval/web-next test -- nav.test.ts`
Expected: **FAIL**，两条用例都失败（key 列表多出 `'demo'`；`/demo` 存在）。

还原并核对：

```pwsh
$file = 'apps/web-next/src/nav.ts'
git checkout -- $file
git diff --quiet -- $file; if ($LASTEXITCODE -ne 0) { throw '还原不彻底' }
git status --short
```

Expected: 无输出。

- [ ] **Step 3: 删除示例页三件套**

```bash
git rm apps/web-next/app/demo/page.tsx
git rm apps/web-next/src/testing/demo-fixtures.ts
git rm packages/client/ui/src/composite/demo-list-page.tsx
```

然后从 `packages/client/ui/src/index.ts` 删掉这一行（它是 `demo-list-page.tsx` 的唯一导出点）：

```ts
export { DemoListPage, type DemoListPageProps, type DemoRecordView } from './composite/demo-list-page';
```

确认没有残留引用：

Run: `pnpm --filter @aieval/ui test`
Expected: PASS（`page-shell` 系列用例只提到 `/demo` 的注释，不 import 示例页代码）。

- [ ] **Step 4: 修正 spec §8 的路由清单（R7）**

打开 `docs/superpowers/specs/2026-09-22-features-design.md`，把 §8 路由块里的这两行：

```
├── cases/[caseId]/validate-repo/route.ts
├── cases/[caseId]/commits/route.ts
```

替换为：

```
├── cases/validate-repo/route.ts
├── cases/commits/route.ts
```

**只改这两行**，不要动 §8 的其它内容，也不要动 spec 的其它章节（这是本计划唯一允许修改 spec 的地方，理由见接口契约 §11 R7：创建用例时还没有 caseId）。

核对：

Run: `Select-String -Path docs/superpowers/specs/2026-09-22-features-design.md -Pattern '\[caseId\]/(validate-repo|commits)'`
Expected: 无匹配（退出码 1，PowerShell 会把「无匹配」显示为没有任何输出行）。

Run: `Select-String -Path docs/superpowers/specs/2026-09-22-features-design.md -Pattern 'cases/validate-repo|cases/commits'`
Expected: 恰好两行，内容为 `├── cases/validate-repo/route.ts` 与 `├── cases/commits/route.ts`。

- [ ] **Step 5: 全量收尾验证**

Run: `pnpm typecheck`
Expected: 零错误。

Run: `pnpm lint`
Expected: 零错误。

Run: `pnpm test`
Expected: 全部通过（包含本计划新增的 `run-store` / `cases` / `judge` / client `cases` / `case-form-panel` / `case-detail-panel` / `route-cases` / `repo-name` / `nav` 九份测试文件）。

- [ ] **Step 6: 提交**

```bash
git add apps/web-next/src/nav.test.ts packages/client/ui/src/index.ts docs/superpowers/specs/2026-09-22-features-design.md
git commit -m "chore(cases): 删除脚手架示例页与假数据，修正 spec §8 的用例路由清单（R7）"
```

> `git rm` 已经把那三个文件的删除放进了暂存区，上面的 `git add` 只补本步骤改动/新增的三个路径；提交后跑一次 `git status --short` 应当为空。

---

## 完成后的交接

- **交付物**：用例域的完整纵向切片——`evaluator` 的运行快照读路径、`api` 的用例服务与生成服务、`client` 的用例 hooks、`ui` 的两个面板、5 个路由、重写后的 `/cases` 页；脚手架示例页与假数据已删除，spec §8 的路由清单已按 R7 修正。
- **给 p4（evaluator）的话**：`run-store.ts` 已按契约 §5 落地（读路径 + `saveRun`），编排只需要消费它；`text-api.ts` / `judge-route.ts` 由 p0 提供，本计划只消费。
- **给 p5（评测域）的话**：`CaseDetailPanel.referencedRuns` 目前恒传 `null`（p2 没有「按用例查评测数」的路由，见 R-p2-B）；等 `useRuns()` 可用后把它换成真实计数即可，组件不用改。`CaseFormPanel` 的 props 契约已固定，评测域若要复用得先看契约 §8。
- **给 p6（冒烟与手册）的话**：用例页的手动验收清单在 Task 8 Step 4，已把结果记进 `docs/superpowers/notes/2026-09-22-features-p2-smoke.md`；手册里「创建用例」一章可直接引用那条路径。
- **未覆盖项**：`/cases` 页本身没有自动化测试（`apps/web-next` 不能写 `.tsx` 测试），页面的行为靠路由测试 + 面板测试 + 浏览器冒烟三层兜住；`CaseFormPanel` 的 Tooltip 文案断言依赖 `fireEvent.mouseOver` 触发 antd 浮层，若某个 antd 小版本改了触发方式，改玩具而非改实现。
- **须回报给接口契约持有者的两件事**：① R-p2-C——`generateJudgePrompt` 的同步签名不可实现，本计划按 `Promise<…>` 实现；② R-p2-A——`evaluator/src/run-store.ts` 在 §0 的依赖表里归 p4，但 p2 的 `deleteCase` 必须先读到运行快照，本计划把它提前到 Task 1（签名逐字取自契约 §5，p4 只消费不重写）。两条都需要在契约文档里落一句说明，否则下一个人会以为 p2 偷偷改了名字或越界实现。
