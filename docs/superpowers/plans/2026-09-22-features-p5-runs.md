# 功能阶段 p5 实施计划：评测域（创建、详情、SSE、产物抽屉）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把评测域从「契约与编排已就绪」接到「使用者能创建一轮评测、看着它跑、点开三个产物抽屉」：`api` 侧的创建/校验/候选池投影/启动/终止/产物按需读取/SSE 帧产出，`client` 侧的 hooks 与逐行事件订阅，`ui` 侧的候选卡片与创建表单，以及 `apps/web-next` 的 8 条 `runs/**` 路由、评测页与落地页。

**Architecture:** 沿用脚手架的分层：`web-next` 的路由只做「zod 校验 → 调 api → `handleApiError` 映射」，页面只做「hooks → props → 组件」；`api` 的评测服务持有**全部业务规则**（校验、快照、候选池投影、按需算 diff、SSE 帧格式），不 import 任何框架类型；`client` 的 hooks 只管缓存键与轮询/续订策略；`ui` 的组件纯展示、零接口调用。SSE 是**唯一的实时通道**（spec §8）：帧由 `api` 的 `streamRowEvents` 产出，路由层只负责响应头与 `Last-Event-ID` 的解析。列表的实时性走 SWR 轮询（有在跑的行时 3 秒），逐行的实时性走该行自己的 SSE——**只有该行的日志抽屉打开时才订阅**。

**Tech Stack:** TypeScript 5（strict + `noUncheckedIndexedAccess` + `verbatimModuleSyntax`）· zod 3 · SWR 2 · antd 6 + React 19 · Next.js 16 App Router（Route Handlers + Server/Client Components）· vitest 4（node / jsdom 双配置）

**Spec:** `docs/superpowers/specs/2026-09-22-features-design.md` §3（F2/F9/F11/F12/F14）· §5.1 · §5.3 · §5.4 · §5.5 第 6/7 步 · §5.6.2 · §5.6.3 · §7.2 · §7.4 · §8 · §12

**Interfaces source:** `docs/superpowers/notes/2026-09-22-features-plan-interfaces.md`（§1 通用口径 / §2 契约出口 / §5 evaluator 出口 / §6 api 出口 / §7 client hooks / §8 ui 组件清单 / §9 路由与页面清单 / §11 实现层修正）

## Global Constraints

- 包名 `@aieval/*`；依赖方向由 `eslint.shared.ts` 的 `withBoundary()` 硬约束（含动态 `import()` 与 `require()`，且禁跨包相对引用）。`api` 只依赖 `evaluator / core / contracts` + **本计划新增的 `agents`（只读注册表元数据）**；`ui` 不调接口、不 import `@aieval/client`；`client` 不 import `apps`。
- 源码一律 ESM（禁 `require`）；`verbatimModuleSyntax` 开着，类型必须 `import type`。
- **`api` 禁框架**：`api/src/**` 不得 import `next` / `react` / `react-dom`，SSE 只用 Web 标准类型（`ReadableStream` / `Uint8Array` / `TextEncoder`）。`Response` 由路由层组装。
- 时间字段一律 ISO 8601 带时区字符串（`new Date().toISOString()`）；实体 id 一律 UUID v4（`randomUUID()`）。
- 注释 JSDoc 中文：文件头写职责 + 注意事项，关键分支写「为什么」。日志走 `createLogger(scope)`，上下文作 `console` 第二参数（不 `JSON.stringify`）。
- **`null` 绝不显示成 0**（spec §5.6.3）：`EvalRow.tokens / turns / durationMs` 为 `null` 时界面显示「未采集」（该智能体采不到用量时显示「不支持计量」），真实的 `0` 照常显示 `0`。
- **列表轮询**：`/api/runs` 与单轮详情只在「还有活在跑」时 `refreshInterval: 3000`，跑完必须关闭（spec §8 末段）。
- **逐行 SSE 只在该行的日志抽屉打开时订阅**（spec §8 末段）。
- 守卫类任务必须做**变异验证**：制造缺陷 → 跑用例看到期望的失败输出 → 还原 → 核对文件哈希。本计划至少覆盖三条：① `null` 计量不得显示成 0；② SSE 重连后按 `seq` 去重；③ 候选池按协议过滤。
- 样式一律走 antd（主题 token / 紧凑密度 / 语义 `styles`）；**不手写字号**（交紧凑密度）、**不手调行内边距**、避免裸写 `div`。等宽字体走 `token.fontFamilyCode`，间距走 `Flex` 的 `gap`。
- 测试隔离：配置目录一律 `setConfigDirForTesting(mkdtempSync(...))`（**绝不触碰真实 `~/.aieval`**）；不打真实网络；**不起真实 agent 进程**——`api` 与 `apps/web-next` 的测试统一 `vi.mock('@aieval/evaluator')`（理由见 Task 1 Step 2 里那份用例的文件头）。
- `apps/web-next` **不能写 `.tsx` 测试**（该应用 `jsx: preserve`，Vite 的 import-analysis 会直接报 `make sure to not set jsx to preserve`）；该应用内的测试一律是 `src/**/*.test.ts`，页面里可测的逻辑必须抽成 `.ts` 纯函数。
- 组件测试的 jsdom 环境：`matchMedia` 与 `ResizeObserver` **jsdom 都没有**——前者由用例自己注入，后者的桩在 `packages/client/ui/src/testing/resize-observer.ts`（刻意不放进共享 setup）。**挂载 `Select` / `Modal` / `Drawer` 的用例必须自己装 `ResizeObserver` 桩**（antd 的浮层定位走 `@rc-component/resize-observer`）。`EventSource` 同样不在 jsdom 里，桩在 `packages/client/client/src/testing/event-source.ts`（本计划新增，同样不放进共享 setup）。
- 每个任务结束时 `pnpm typecheck` 零错误；命令只用本仓真实存在的脚本：`pnpm --filter @aieval/api test`、`pnpm --filter @aieval/client test`、`pnpm --filter @aieval/ui test`、`pnpm --filter @aieval/web-next test`、`pnpm typecheck`、`pnpm lint`。
- **提交用逐个显式 `git add <路径>`，禁 `git add -A`**；提交信息中文，形如 `feat(api): …`。
- 文档不写「TBD / 稍后补 / 类似 Task N」；代码步骤给出可直接粘贴的完整代码块。

## 本计划对 spec 的实现层修正

计划编写期逐条核对了契约 §6/§7/§8/§9 与 spec §5.1/§5.3/§5.6/§8，按下面执行（每条都已在对应任务里落到代码与用例）：

1. **`api/src/runs.ts` 按职责拆成三个文件**：`runs.ts`（创建/读取/动作/候选池）、`run-artifacts.ts`（`getRowDiff` / `getRowLog`）、`run-stream.ts`（`streamRowEvents`）。契约 §6 钉死的**出口清单一个不少**，`api/src/index.ts` 汇总导出；拆开是为了让「跑评测」与「读产物」各自能独立验收（`AGENT.md`：每个小功能一个文件）。
2. **契约 §6 钉了 `listModelOptions(agentKind)`，却没有任何 HTTP 出口与 client hook**（§9 的 8 条 `runs` 路由里没有它，§7 的 hooks 清单里也没有对应的取数入口）。而 spec §5.1 F2 要求「表单的模型候选池按协议过滤」，A3 又要求协议对应关系的唯一来源是注册表元数据——**这条数据必须能到浏览器**。故本计划补一条只做透传的路由 `GET /api/runs/model-options` 与一个 hook `useRunModelOptions()`，命名与契约里的 `listModelOptions` 对齐；对外只增加这一条路由、这一个 hook，已有的名字与签名一个不改。
3. **`capability.usage` 与 `capability.cancelMidTurn` 也要到界面**：spec §5.6.2 要求 `cancelMidTurn === false` 时「终止」按钮文案必须不同（DSH 是「关闭运行时」），spec §5.6.3 要求采不到用量时显示「不支持计量」而不是「未采集」/0。这两项与候选池同源（都是注册表元数据），所以第 2 条的路由**顺带**返回这三个 kind 的 `protocolType / usage / cancelMidTurn`，`ui` 侧用三个**可选**透传 prop 承载：`MetricLine.usageUnsupported?`、`EvalRowCard.capability?`、`RunDetailPanel.capabilityOf?`。契约 §8 的表列的是「关键 props」，这里只增不减、缺省即「按支持处理」。
4. **POST 创建返回 201**：契约未定状态码；`client` 的 `http.ts` 只看 `res.ok`，与 `PUT /api/settings` 的 200 不冲突。
5. **「查看改动」在 `row.diff === null` 时禁用**（spec 未说）：`EvalRow.diff` 是 p4 在该行产出后写的计数摘要，没有产出时点开只会拿到一个 `CONFLICT`。
6. **列表顺序在 api 层定死**：`listRunsView()` 按 `createdAt` 倒序（最新在前）。spec 未规定顺序，但「最新在前」是列表语义的一部分，放在 api 层保证两个消费方不漂移。
7. **串行进度的分子是「终态行数」**（含 `failed` / `timed-out` / `canceled` / `skipped` / `interrupted`）：spec 只给了「3/6 已完成」的文案，没定义「完成」；不把失败算进去会让进度条永远到不了 100%。
8. **吸底栏清零 `Layout.Footer` 的默认内边距**：它的默认值（`24px 50px`）是页面级的，放进右栏会把卡片顶出视口；间距改由 `Flex` 的 `gap` 承担（不另写字号与控件高度）。
9. **落地页现状即目标态**：`apps/web-next/app/page.tsx` 已是 `redirect('/runs')`（脚手架阶段产物），本计划只核验、不改动（Task 11 Step 7）。
10. **`ui` 的点分文案不点名协议**：spec §5.1 给的示例文案是「Claude Code 需要 Anthropic 兼容协议的供应商」。表单要说清「哪个协议」就必须把注册表元数据透进 `ui`，而契约 §8 的 `RunCreatePanel` props 里没有承载它的位置；故文案写成「{智能体中文名} 没有可选的模型：请到设置里添加**协议匹配**的供应商，并为它维护模型清单」——同一份出路提示，且不把「哪家配哪种协议」这张表抄进 `ui`（A3）。
11. **跨计划假设（p2 未定形状）**：`useCases()` 在契约 §7 里只有名字没有返回形状，本计划按 p1 的 `useProviders()` 同形假定为 `{ cases: TestCase[] | undefined; error: unknown; isLoading: boolean; refresh: () => void }`。p2 落地时若形状不同，只需改 Task 11 页面里的一行解构。

## Review Focus

以下五类输入/条件 spec 没有明说，但坏了会直接伤到使用者。每条都在对应任务的测试里钉住：

1. **某一行的事件日志文件不存在、或读到坏数据**——期望日志抽屉显示可读的空态（未开始的行）或**含文件路径的中文原因**，而不是把 `SyntaxError` 抛成 500「服务端内部错误」。落在 Task 2（`getRowLog` 的两条用例）。
2. **改过工作区根目录之后再看历史评测**——期望「查看改动 / 查看日志」读的是**该轮快照里的 `workspaceBase`**，而不是当前设置里的根目录（否则历史评测的抽屉会全空，而磁盘上产物明明还在）。落在 Task 2（`getRowDiff` / `getRowLog` 各一条用例：把设置改到别处后仍能从旧根目录读到）。
3. **URL 里是脏的 `?panel=` / `?id=`**（`?panel=foo`、`?id=`、`?panel=detail` 无 id、id 指向已删除的评测）——期望回落到「不显示右栏」或一句「评测不存在或已被删除」，既不白屏也不半开半合的右栏。落在 Task 11（`parseRunsPanel` 的表驱动用例 + 冒烟第 15 项）。
4. **候选只有一行 / 多行同分 / 零行**——期望排名徽标并列同名次且不抖动、串行进度不出现 `NaN%` 或 `0/0` 崩版。落在 Task 8（`RunDetailPanel` 的排名与进度用例）。
5. **浏览器没有 `EventSource`，或连接被中间层掐断**——期望日志抽屉**仍然显示已拉到的历史**，`connected` 徽标如实反映「未连接」并给出原因，而不是整页报错。落在 Task 5（降级与 `onerror` 两条用例）。

---

## 文件结构总览

```
packages/server/api/src/
├── runs.ts(.test.ts)                       # 创建/校验/列表/详情/启动/终止/候选池投影（Task 1）
├── run-artifacts.ts(.test.ts)              # getRowDiff（按需现算）/ getRowLog（Task 2）
├── run-stream.ts(.test.ts)                 # streamRowEvents：SSE 帧产出（Task 3）
├── testing/run-fixtures.ts                 # 本域测试夹具（供应商/用例/行/轮）
└── index.ts                                # 追加导出（Task 1/2/3 各追加一段）

packages/client/client/src/
├── runs.ts(.test.tsx)                      # 列表/详情/四个动作/useRowDiff/useRowLog/useRunModelOptions（Task 4）
├── row-stream.ts(.test.tsx)                # useRowStream：/log 补历史 + SSE 去重续订（Task 5）
├── testing/run-fixtures.ts                 # 客户端测试夹具（EvalRun / AgentEvent）
├── testing/event-source.ts                 # EventSource 替身 + 安装助手（Task 5）
└── index.ts                                # 追加导出（Task 4/5）

packages/client/ui/src/
├── base/mono-text.tsx(.test.tsx)           # 等宽文本块（限高/可滚动/尾部自动滚）（Task 6）
├── base/score-bars.tsx(.test.tsx)          # 5 维度评分条（Task 6）
├── base/row-status-tag.tsx(.test.tsx)      # 行状态 → 彩色 Tag（Task 6）
├── base/metric-line.tsx(.test.tsx)         # token/轮次/耗时/得分摘要（Task 6）
├── composite/run-create-panel.tsx(.test.tsx)   # 创建评测表单（Task 7）
├── composite/eval-row-card.tsx(.test.tsx)      # 单候选卡片（Task 8）
├── composite/run-detail-panel.tsx(.test.tsx)   # 顶部信息行 + 进度 + 卡片列表 + 吸底栏（Task 8）
├── composite/score-detail-view.tsx(.test.tsx)  # 评分详情（Task 9）
├── composite/diff-view.tsx(.test.tsx)          # 代码改动（Task 9）
├── composite/log-view.tsx(.test.tsx)           # 执行日志 + log-format.ts(.test.ts)（Task 9）
└── index.ts                                # 追加导出（Task 6/7/8/9）

apps/web-next/
├── app/api/runs/
│   ├── route.ts                            # GET 列表 / POST 创建（Task 10）
│   ├── model-options/route.ts              # GET 候选池 + 三个 kind 的能力元数据（Task 10，见修正 2）
│   ├── [runId]/route.ts                    # GET（Task 10）
│   ├── [runId]/start/route.ts              # POST（Task 10）
│   ├── [runId]/abort/route.ts              # POST（Task 10）
│   └── [runId]/rows/[rowId]/
│       ├── abort/route.ts                  # POST（Task 10）
│       ├── diff/route.ts                   # GET 按需现算（Task 10）
│       ├── log/route.ts                    # GET ?afterSeq=（Task 10）
│       └── stream/route.ts                 # GET SSE（Task 10）
├── src/route-runs.test.ts                  # 列表/创建/详情/动作/候选池 路由测试（Task 10）
├── src/route-run-artifacts.test.ts         # diff/log/stream 路由测试（Task 10）
├── src/runs-view.ts(.test.ts)              # URL 状态解析 + 错误文案（Task 11）
└── app/runs/page.tsx                       # 评测页（Task 11）
```

`apps/web-next/app/page.tsx` 已在脚手架阶段实现为 `redirect('/runs')`，本计划不改动它（见修正 9）。

---

## Task 1: `api` —— 评测创建、列表/详情读取与候选池投影

**Files:**
- Create: `packages/server/api/src/testing/run-fixtures.ts`
- Create: `packages/server/api/src/runs.ts`
- Create: `packages/server/api/src/runs.test.ts`
- Modify: `packages/server/api/src/index.ts`（追加导出）
- Modify: `packages/server/api/package.json`（`dependencies` 追加 `@aieval/agents`）

**Interfaces:**
- Consumes: p0 `@aieval/contracts` 的 `RunCreate` / `EvalRun` / `EvalRow` / `AGENT_KINDS` / `isRunnableRow` / `AGENT_LABELS` / `PROTOCOL_LABELS` / `ServiceError`；p0 `@aieval/core` 的 `loadConfig` / `saveConfig` / `setConfigDirForTesting` / `rowWorkspaceDir` / `createLogger`；p1 `./providers` 的 `listProviders()`；p2 `./cases` 的 `getCase(caseId)`；p3 `@aieval/agents` 的 `getProvider(kind)`；p4 `@aieval/evaluator` 的 `listRuns()` / `getRun(runId)` / `saveRun(run)` / `startRun(runId)` / `abortRun(runId)` / `abortRow(runId, rowId)`
- Produces: `listRunsView(): EvalRun[]`、`getRunView(runId: string): EvalRun`、`createRun(input: RunCreate): EvalRun`、`startRun(runId: string): EvalRun`、`abortRun(runId: string): EvalRun`、`abortRow(runId: string, rowId: string): EvalRun`、`listModelOptions(agentKind: AgentKind): AgentModelOption[]`、`listAgentModelOptions(): AgentOptionGroup[]`、`type AgentModelOption`、`type AgentOptionGroup`

- [ ] **Step 1: 写测试夹具 `packages/server/api/src/testing/run-fixtures.ts`**

```ts
/**
 * 评测域的测试夹具（api 包内共享，被 runs / run-artifacts / run-stream 三份用例复用）。
 * 只做两件事：把「供应商 / 用例」写进临时配置目录，造出「一轮评测」的形状。
 * **不 mock 任何业务函数**——那由各用例自己决定（本文件的实现全都是真值构造）。
 * 注意：本文件不是 *.test.ts，vitest 不会把它当用例收集。
 */
import { loadConfig, saveConfig, type AppConfig } from '@aieval/core';
import type { EvalRow, EvalRun, Provider, TestCase } from '@aieval/contracts';

/** 造一个 openai 协议的供应商：默认带一条自动拉取的模型，可用 overrides 覆盖任意字段 */
export function makeProvider(overrides: Partial<Provider> = {}): Provider {
  return {
    id: 'p-openai',
    name: 'OpenAI 网关',
    protocolType: 'openai',
    baseUrl: 'https://gw.example.com/v1',
    apiKey: 'sk-test-openai',
    models: [{ id: 'gpt-5', source: 'fetched' }],
    createdAt: '2026-09-22T00:00:00.000Z',
    updatedAt: '2026-09-22T00:00:00.000Z',
    ...overrides,
  };
}

/** 造一个 anthropic 协议的供应商：Claude Code 唯一能用的那种 */
export function makeAnthropicProvider(overrides: Partial<Provider> = {}): Provider {
  return makeProvider({
    id: 'p-anthropic',
    name: 'Anthropic 网关',
    protocolType: 'anthropic',
    baseUrl: 'https://gw.example.com/anthropic',
    apiKey: 'sk-test-anthropic',
    models: [{ id: 'claude-opus-4-6', source: 'manual' }],
    ...overrides,
  });
}

/** 造一个用例：默认不指定 commit（等价于默认分支 HEAD） */
export function makeCase(overrides: Partial<TestCase> = {}): TestCase {
  return {
    id: 'c-1',
    title: '为多协议入站补齐 Anthropic 到 Chat 的转换',
    repoPath: 'D:\\projects\\gateway',
    commitHash: null,
    taskPrompt: '补齐转换并加回归用例',
    judgePrompt: '按 5 维打分',
    judgeProviderId: null,
    judgeModelId: null,
    createdAt: '2026-09-22T00:00:00.000Z',
    updatedAt: '2026-09-22T00:00:00.000Z',
    ...overrides,
  };
}

/** 把供应商与用例写进当前（临时）配置目录；其余字段保持 loadConfig 的现状 */
export function seedConfig(input: { providers?: Provider[]; cases?: TestCase[] } = {}): AppConfig {
  const config = loadConfig();
  const next: AppConfig = { ...config, providers: input.providers ?? [], cases: input.cases ?? [] };
  saveConfig(next);
  return next;
}

/** 造一行评测：默认是「还没开始跑」的形状 */
export function makeRow(overrides: Partial<EvalRow> = {}): EvalRow {
  return {
    id: 'r-1',
    agentKind: 'claude-code',
    providerId: 'p-anthropic',
    providerName: 'Anthropic 网关',
    baseUrl: 'https://gw.example.com/anthropic',
    modelId: 'claude-opus-4-6',
    status: 'pending',
    branch: 'test/r-1',
    workspacePath: 'D:\\runs\\run-1\\rows\\r-1\\workspace',
    baselineCommit: '30b86eedca90b70d15b9eb9e75b454a2574762d4',
    tokens: null,
    turns: null,
    durationMs: null,
    diff: null,
    score: null,
    error: null,
    ...overrides,
  };
}

/** 造一轮评测快照：默认单行、idle */
export function makeRun(overrides: Partial<EvalRun> = {}): EvalRun {
  return {
    id: 'run-1',
    caseId: 'c-1',
    caseTitle: '为多协议入站补齐 Anthropic 到 Chat 的转换',
    repoPath: 'D:\\projects\\gateway',
    commitHash: null,
    status: 'idle',
    executionMode: 'parallel',
    rows: [makeRow()],
    workspaceBase: 'D:\\runs',
    createdAt: '2026-09-22T08:00:00.000Z',
    startedAt: null,
    finishedAt: null,
    ...overrides,
  };
}
```

- [ ] **Step 2: 写失败测试 `packages/server/api/src/runs.test.ts`**

```ts
// @vitest-environment node
/**
 * 评测服务：创建（校验 → 快照 → 落库 idle）、列表顺序、启动/终止的业务闸门、候选池协议投影。
 *
 * **为什么在 api 层 mock 掉 `@aieval/evaluator`（而不是注入假 provider）**：
 * 被测对象是 api 自己的业务规则（校验顺序、快照字段、落库状态、候选池投影），它与编排层的
 * 契约就是 evaluator 导出的那几个函数；在这一层替换掉它们，能同时做到三件事——
 *   1. **不起真实 agent 进程**：`startRun` / `abortRun` 落到假的实现上，编排状态机（以及它
 *      会 spawn 的子进程）在 api 用例里根本不会被进入；
 *   2. 断言「api 有没有把该做的事交给编排层」（调用次数与入参），这比 sdk 层的行为更能定位问题；
 *   3. 快照的读写在假实现里是一个内存 Map，用例可以精确控制「磁盘上有什么」。
 *
 * `@aieval/agents` **保持真实**：注册表是静态注册 + 纯元数据（§5.6.1 A6：厂商 SDK 是函数作用域
 * 懒加载），import 它不会拉起任何厂商包，而候选池的协议判据正需要这份真实元数据。
 *
 * `@aieval/core` 保持真实（只把三个函数包一层 spy，语义不变），因为「落盘」「按路径读事件」
 * 这些行为本身就是被测内容的一部分。
 *
 * 配置目录一律指向 mkdtemp 出来的临时目录，**绝不触碰真实 ~/.aieval**。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PROTOCOL_LABELS,
  ServiceError,
  type EvalRun,
} from '@aieval/contracts';
import { setConfigDirForTesting } from '@aieval/core';
import {
  abortRow as abortRowInOrchestrator,
  abortRun as abortRunInOrchestrator,
  getRun as getRunSnapshot,
  listRuns as listRunsFromDisk,
  saveRun,
  startRun as startRunInOrchestrator,
} from '@aieval/evaluator';
import {
  abortRow,
  abortRun,
  createRun,
  getRunView,
  listAgentModelOptions,
  listModelOptions,
  listRunsView,
  startRun,
} from './runs';
import { updateSettings } from './settings';
import {
  makeAnthropicProvider,
  makeCase,
  makeProvider,
  makeRow,
  makeRun,
  seedConfig,
} from './testing/run-fixtures';

vi.mock('@aieval/evaluator', () => ({
  listRuns: vi.fn(),
  getRun: vi.fn(),
  saveRun: vi.fn(),
  startRun: vi.fn(),
  abortRun: vi.fn(),
  abortRow: vi.fn(),
}));

let dir: string;
/** 假的「磁盘」：saveRun 写进来、getRun/listRuns 从这里读 */
let store: Map<string, EvalRun>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aieval-runs-'));
  setConfigDirForTesting(dir);
  store = new Map();
  vi.mocked(saveRun).mockImplementation((run: EvalRun) => {
    store.set(run.id, run);
  });
  vi.mocked(getRunSnapshot).mockImplementation((runId: string) => {
    const run = store.get(runId);
    if (run === undefined) throw new ServiceError('NOT_FOUND', `评测不存在：${runId}`);
    return run;
  });
  vi.mocked(listRunsFromDisk).mockImplementation(() => [...store.values()]);
  vi.mocked(startRunInOrchestrator).mockImplementation((runId: string) => {
    const run = store.get(runId);
    if (run === undefined) throw new ServiceError('NOT_FOUND', `评测不存在：${runId}`);
    return { ...run, status: 'running' };
  });
  vi.mocked(abortRunInOrchestrator).mockImplementation((runId: string) => {
    const run = store.get(runId);
    if (run === undefined) throw new ServiceError('NOT_FOUND', `评测不存在：${runId}`);
    return { ...run, status: 'partial' };
  });
  vi.mocked(abortRowInOrchestrator).mockImplementation((runId: string) => {
    const run = store.get(runId);
    if (run === undefined) throw new ServiceError('NOT_FOUND', `评测不存在：${runId}`);
    return { ...run, status: 'partial' };
  });
  // 工作区根目录指到临时目录：创建出来的行路径不会落到真实 ~/.runs
  updateSettings({ workspaceRoot: join(dir, 'ws') });
  seedConfig({ providers: [makeProvider(), makeAnthropicProvider()], cases: [makeCase()] });
});

afterEach(() => {
  setConfigDirForTesting(null);
  rmSync(dir, { recursive: true, force: true });
});

describe('createRun', () => {
  it('落库 idle、不自动开跑，并按行快照供应商名与 baseUrl', () => {
    const run = createRun({
      caseId: 'c-1',
      executionMode: 'serial',
      rows: [
        { agentKind: 'claude-code', providerId: 'p-anthropic', modelId: 'claude-opus-4-6' },
        { agentKind: 'codex', providerId: 'p-openai', modelId: 'gpt-5' },
      ],
    });

    expect(run.status).toBe('idle');
    expect(run.executionMode).toBe('serial');
    expect(run.startedAt).toBeNull();
    expect(run.finishedAt).toBeNull();
    expect(run.rows).toHaveLength(2);
    // 创建**不得**把「开始」一起做了：编排层的启动函数一次都不能被调用
    expect(vi.mocked(startRunInOrchestrator)).not.toHaveBeenCalled();

    const [first, second] = run.rows;
    expect(first?.status).toBe('pending');
    expect(first?.providerId).toBe('p-anthropic');
    expect(first?.providerName).toBe('Anthropic 网关');
    expect(first?.baseUrl).toBe('https://gw.example.com/anthropic');
    expect(first?.modelId).toBe('claude-opus-4-6');
    expect(second?.providerName).toBe('OpenAI 网关');
    // 分支名用行 id（同一用例下多候选共用分支名会互相踩，spec §5.5）
    expect(first?.branch).toBe(`test/${first?.id ?? ''}`);
    expect(first?.workspacePath.startsWith(join(dir, 'ws'))).toBe(true);
    expect(first?.tokens).toBeNull();
    expect(first?.score).toBeNull();
    // 快照写进了假的磁盘（saveRun 被调用过）
    expect(vi.mocked(saveRun)).toHaveBeenCalledTimes(1);
  });

  it('冗余快照用例标题/仓库路径/commit：用例被删也说得清当时测的是什么', () => {
    seedConfig({ providers: [makeAnthropicProvider()], cases: [makeCase({ commitHash: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678' })] });

    const run = createRun({
      caseId: 'c-1',
      executionMode: 'parallel',
      rows: [{ agentKind: 'claude-code', providerId: 'p-anthropic', modelId: 'claude-opus-4-6' }],
    });

    expect(run.caseTitle).toBe('为多协议入站补齐 Anthropic 到 Chat 的转换');
    expect(run.repoPath).toBe('D:\\projects\\gateway');
    expect(run.commitHash).toBe('a1b2c3d4e5f60718293a4b5c6d7e8f9012345678');
    expect(run.workspaceBase).toBe(join(dir, 'ws'));
  });

  it('用例不存在时抛 NOT_FOUND，且不落库', () => {
    let caught: unknown;
    try {
      createRun({
        caseId: 'c-missing',
        executionMode: 'parallel',
        rows: [{ agentKind: 'claude-code', providerId: 'p-anthropic', modelId: 'claude-opus-4-6' }],
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ServiceError);
    expect((caught as ServiceError).code).toBe('NOT_FOUND');
    expect((caught as ServiceError).message).toContain('c-missing');
    expect(vi.mocked(saveRun)).not.toHaveBeenCalled();
  });

  it('供应商不存在时抛 NOT_FOUND（名字与 id 都要能读出来）', () => {
    let caught: unknown;
    try {
      createRun({
        caseId: 'c-1',
        executionMode: 'parallel',
        rows: [{ agentKind: 'claude-code', providerId: 'p-gone', modelId: 'claude-opus-4-6' }],
      });
    } catch (error) {
      caught = error;
    }
    expect((caught as ServiceError).code).toBe('NOT_FOUND');
    expect((caught as ServiceError).message).toContain('p-gone');
  });

  it('模型不在该供应商的清单里时抛 NOT_FOUND，且文案点名供应商', () => {
    let caught: unknown;
    try {
      createRun({
        caseId: 'c-1',
        executionMode: 'parallel',
        rows: [{ agentKind: 'claude-code', providerId: 'p-anthropic', modelId: 'claude-3-5-sonnet' }],
      });
    } catch (error) {
      caught = error;
    }
    expect((caught as ServiceError).code).toBe('NOT_FOUND');
    expect((caught as ServiceError).message).toContain('Anthropic 网关');
    expect((caught as ServiceError).message).toContain('claude-3-5-sonnet');
  });

  it('协议不匹配时抛 CONFLICT：Claude Code 不能被 openai 协议的供应商驱动', () => {
    let caught: unknown;
    try {
      createRun({
        caseId: 'c-1',
        executionMode: 'parallel',
        rows: [{ agentKind: 'claude-code', providerId: 'p-openai', modelId: 'gpt-5' }],
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ServiceError);
    expect((caught as ServiceError).code).toBe('CONFLICT');
    // 文案用的是 contracts 里的协议中文标签（两处各写一份中文必然漂移）
    expect((caught as ServiceError).message).toContain(PROTOCOL_LABELS.anthropic);
    expect((caught as ServiceError).message).toContain(PROTOCOL_LABELS.openai);
    expect(vi.mocked(saveRun)).not.toHaveBeenCalled();
  });
});

describe('listRunsView', () => {
  it('按 createdAt 倒序（最新在前）', () => {
    store.set('old', makeRun({ id: 'old', createdAt: '2026-09-22T08:00:00.000Z' }));
    store.set('new', makeRun({ id: 'new', createdAt: '2026-09-22T09:30:00.000Z' }));
    store.set('mid', makeRun({ id: 'mid', createdAt: '2026-09-22T09:00:00.000Z' }));

    expect(listRunsView().map((run) => run.id)).toEqual(['new', 'mid', 'old']);
  });
});

describe('getRunView', () => {
  it('直通编排层的快照读取（api 不重复造 NOT_FOUND 的判定）', () => {
    const run = makeRun({ id: 'run-9' });
    store.set('run-9', run);

    expect(getRunView('run-9')).toEqual(run);
    expect(vi.mocked(getRunSnapshot)).toHaveBeenCalledWith('run-9');
  });
});

describe('startRun', () => {
  it('有可执行行时交给编排层并返回它的结果', () => {
    store.set('run-1', makeRun({ rows: [makeRow({ status: 'failed' })] }));

    const run = startRun('run-1');

    expect(vi.mocked(startRunInOrchestrator)).toHaveBeenCalledWith('run-1');
    expect(run.status).toBe('running');
  });

  it('没有可执行行时抛 CONFLICT，且不惊动编排层', () => {
    store.set('run-1', makeRun({ rows: [makeRow({ id: 'r-1', status: 'judged' })] }));

    expect(() => startRun('run-1')).toThrowError(/没有可执行的候选行/);
    // 静默什么都不做是最难排查的一种反馈：界面刚点过「开始」，必须有明确失败
    expect(vi.mocked(startRunInOrchestrator)).not.toHaveBeenCalled();
  });

  it('评测不存在时抛 NOT_FOUND，且不惊动编排层', () => {
    expect(() => startRun('nope')).toThrowError(ServiceError);
    expect(vi.mocked(startRunInOrchestrator)).not.toHaveBeenCalled();
  });
});

describe('abortRun / abortRow', () => {
  it('终止整轮：直通编排层', () => {
    store.set('run-1', makeRun());

    expect(abortRun('run-1').status).toBe('partial');
    expect(vi.mocked(abortRunInOrchestrator)).toHaveBeenCalledWith('run-1');
  });

  it('终止整轮时评测不存在 → NOT_FOUND，且不惊动编排层', () => {
    expect(() => abortRun('nope')).toThrowError(ServiceError);
    expect(vi.mocked(abortRunInOrchestrator)).not.toHaveBeenCalled();
  });

  it('终止单行：行存在则直通编排层', () => {
    store.set('run-1', makeRun({ rows: [makeRow({ id: 'r-1', status: 'running' })] }));

    abortRow('run-1', 'r-1');

    expect(vi.mocked(abortRowInOrchestrator)).toHaveBeenCalledWith('run-1', 'r-1');
  });

  it('终止单行：行 id 不存在 → NOT_FOUND（脏 URL 不能真的去杀别人）', () => {
    store.set('run-1', makeRun({ rows: [makeRow({ id: 'r-1', status: 'running' })] }));

    expect(() => abortRow('run-1', 'r-other')).toThrowError(/没有这一行/);
    expect(vi.mocked(abortRowInOrchestrator)).not.toHaveBeenCalled();
  });
});

describe('listModelOptions', () => {
  it('Claude Code 只看到 anthropic 协议的模型', () => {
    expect(listModelOptions('claude-code')).toEqual([
      { providerId: 'p-anthropic', providerName: 'Anthropic 网关', modelId: 'claude-opus-4-6', source: 'manual' },
    ]);
  });

  it('Codex 只看到 openai 协议的模型，DSH 只看到 anthropic 协议的模型（Task 11 实测，契约 R37）', () => {
    const openai = [{ providerId: 'p-openai', providerName: 'OpenAI 网关', modelId: 'gpt-5', source: 'fetched' }];
    // dsh 讲的是 Anthropic Messages（实测 POST {root}/v1/messages + x-api-key）⇒ 与 Claude Code 同池，
    // 不再与 Codex 共用 openai 那一池（保持旧口径会让表单给 DSH 列出不兼容的 OpenAI 网关）
    const anthropic = [
      { providerId: 'p-anthropic', providerName: 'Anthropic 网关', modelId: 'claude-opus-4-6', source: 'manual' },
    ];
    expect(listModelOptions('codex')).toEqual(openai);
    expect(listModelOptions('dsh')).toEqual(anthropic);
  });

  it('没有任何匹配协议的供应商时返回空数组（不是全部模型）', () => {
    seedConfig({ providers: [makeProvider()], cases: [makeCase()] });

    expect(listModelOptions('claude-code')).toEqual([]);
  });
});

describe('listAgentModelOptions', () => {
  it('按 AGENT_KINDS 的顺序给出三个 kind 的元数据与候选池', () => {
    const groups = listAgentModelOptions();

    expect(groups.map((group) => group.agentKind)).toEqual(['claude-code', 'codex', 'dsh']);
    expect(groups[0]?.protocolType).toBe('anthropic');
    expect(groups[1]?.protocolType).toBe('openai');
    // dsh 按 Task 11 的实测归 anthropic 组（契约 R37）
    expect(groups[2]?.protocolType).toBe('anthropic');
    expect(groups[0]?.options.map((option) => option.modelId)).toEqual(['claude-opus-4-6']);
    expect(groups[1]?.options.map((option) => option.modelId)).toEqual(['gpt-5']);
    expect(groups[2]?.options.map((option) => option.modelId)).toEqual(['claude-opus-4-6']);
  });

  it('把 cancelMidTurn 元数据透出来（DSH 为 false，界面文案要跟着变）', () => {
    const groups = listAgentModelOptions();
    const dsh = groups.find((group) => group.agentKind === 'dsh');

    expect(dsh?.cancelMidTurn).toBe(false);
    expect(groups.find((group) => group.agentKind === 'claude-code')?.cancelMidTurn).toBe(true);
    // dsh 的 usage 以 p3 的真实探测结果为准（spec §5.6.3），这里只断言它是一个布尔
    expect(typeof dsh?.usage).toBe('boolean');
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `pnpm --filter @aieval/api test`
Expected: FAIL —— 收集阶段就失败，报 `Failed to resolve import "./runs" from "src/runs.test.ts". Does the file exist?`（实现文件还没写）。

- [ ] **Step 4: 给 `api` 加 `@aieval/agents` 依赖并安装**

`packages/server/api/package.json` 的 `dependencies` 改成（只多一行）：

```json
  "dependencies": {
    "@aieval/agents": "workspace:*",
    "@aieval/contracts": "workspace:*",
    "@aieval/core": "workspace:*",
    "@aieval/evaluator": "workspace:*"
  },
```

Run: `pnpm install`
Expected: 结束码 0；`packages/server/api/node_modules/@aieval/agents` 出现（不跑 install 的话运行时解析不到这个包，vitest 会报 `Failed to resolve import "@aieval/agents"`）。

> 为什么必须显式声明：pnpm 只为**声明过的**依赖建链接，不会去仓库根目录兜底找 `@aieval/agents`。`AGENT.md` 的依赖方向表里 `api` 一栏没有 agents，但那张表约束的是「api 不许知道框架/SDK」，而候选池的协议判据（A3）要求读注册表元数据；eslint 的 `FORBIDDEN.api` 也不含 `@aieval/*`，故加这一条不会触发边界报错。

- [ ] **Step 4b: 把这条新依赖边落进文档（否则它是隐性依赖）**

`eslint` 不会拦它（`FORBIDDEN.api` 只禁框架），所以**唯一的守卫是文档**：改 `AGENT.md` 依赖方向表的 `api` 一行，从

```text
api      → evaluator / core / contracts
```

改成

```text
api      → evaluator / agents / core / contracts   # agents：候选池按智能体读注册表元数据（协议类型）
```

（契约 §11 R11 记录了这条裁决。`packages/server/api/src/runs.ts` 只 import `listAgentProviders` 一个函数，不要把注册表再包装一层。）

Run: `pnpm lint`
Expected: 退出码 0，`api` 包零边界报错。

- [ ] **Step 5: 写实现 `packages/server/api/src/runs.ts`**

```ts
/**
 * 评测服务：创建（含候选池投影）、列表/详情读取、启动与终止。
 * 三条口径：
 *   1. 创建只**落库**，不自动开跑（spec §5.1）——「开始」是评测详情页的显式动作；
 *   2. 供应商名与 baseUrl 在创建时**快照**进行里（spec §7.2）：供应商改名或删除后，
 *      历史评测仍能说清这一行当时用的是什么；
 *   3. 候选池的协议判据来自 agents 注册表元数据（spec §5.6.2 A3）——本文件里**没有**
 *      「哪家智能体配哪种协议」的映射表，那张表只有注册表一份。
 */
import { randomUUID } from 'node:crypto';
import {
  AGENT_KINDS,
  PROTOCOL_LABELS,
  ServiceError,
  isRunnableRow,
  type AgentKind,
  type EvalRow,
  type EvalRun,
  type ProtocolType,
  type RunCreate,
} from '@aieval/contracts';
import { createLogger, rowWorkspaceDir } from '@aieval/core';
import { getProvider } from '@aieval/agents';
import {
  abortRow as abortRowInOrchestrator,
  abortRun as abortRunInOrchestrator,
  getRun as getRunSnapshot,
  listRuns as listRunsFromDisk,
  saveRun,
  startRun as startRunInOrchestrator,
} from '@aieval/evaluator';
import { getCase } from './cases';
import { listProviders } from './providers';
import { getSettings } from './settings';

const log = createLogger('runs');

/** 候选池里的一个模型：字段与 spec §5.1 的下拉选项一一对应 */
export interface AgentModelOption {
  providerId: string;
  providerName: string;
  /** 供应商侧的模型 id（选它就是选「这个供应商的这个模型」） */
  modelId: string;
  /** 自动拉取 vs 手工维护：界面用 Tag 区分来源（spec §5.1） */
  source: 'fetched' | 'manual';
}

/**
 * 一种智能体的创建期元数据 + 候选池。
 * 这是本计划新增的传输形状（契约 §6 只钉了单 kind 的 `listModelOptions`）：界面除了候选池，
 * 还需要 `usage` / `cancelMidTurn` 才能把「不支持计量」与「关闭运行时」这两处文案做对
 * （spec §5.6.2 / §5.6.3），而它们的唯一来源同样是注册表元数据。
 */
export interface AgentOptionGroup {
  agentKind: AgentKind;
  protocolType: ProtocolType;
  /** false ⇒ 该适配器采不到 token，界面显示「不支持计量」而不是「未采集」/0 */
  usage: boolean;
  /** false ⇒ 「终止」按钮文案退化为「关闭运行时」 */
  cancelMidTurn: boolean;
  options: AgentModelOption[];
}

/**
 * 评测列表：最新创建的排在最前。
 * 排序放在服务层而不是页面里——「最新在前」是列表语义的一部分，两个消费方各排一次必然漂移。
 * 用 `[...listRuns()]` 复制再排：原地 sort 会把「读接口不改写入参」这条隐性约定变成陷阱。
 */
export function listRunsView(): EvalRun[] {
  return [...listRunsFromDisk()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** 单轮评测快照；不存在时由编排层抛 NOT_FOUND（api 不重复造这个判定） */
export function getRunView(runId: string): EvalRun {
  return getRunSnapshot(runId);
}

/**
 * 创建一轮评测：校验 → 快照 → 落库 idle。
 * 校验顺序固定为「用例 → 供应商 → 模型 → 协议」，因为它们是递进的：先肯定「测什么」存在，
 * 再逐行确认「谁来跑、跑哪个模型」可行，最后才用注册表元数据判协议兼容。
 * 顺序反了会把「供应商不存在」报成「模型不存在」，让用户往错误的方向排查。
 */
export function createRun(input: RunCreate): EvalRun {
  const testCase = getCase(input.caseId);
  const providers = listProviders();
  const settings = getSettings();
  const runId = randomUUID();
  const now = new Date().toISOString();

  const rows: EvalRow[] = input.rows.map((row) => {
    const provider = providers.find((item) => item.id === row.providerId);
    if (provider === undefined) {
      throw new ServiceError('NOT_FOUND', `供应商不存在或已被删除（${row.providerId}），请重新选择模型`);
    }
    if (!provider.models.some((model) => model.id === row.modelId)) {
      throw new ServiceError(
        'NOT_FOUND',
        `供应商「${provider.name}」的模型清单里没有 ${row.modelId}，请重新选择，或到设置里为它补上这个模型`,
      );
    }
    const { displayName, metadata } = getProvider(row.agentKind);
    if (metadata.protocolType !== provider.protocolType) {
      throw new ServiceError(
        'CONFLICT',
        `${displayName} 只接受${PROTOCOL_LABELS[metadata.protocolType]}协议的供应商，而「${provider.name}」是${PROTOCOL_LABELS[provider.protocolType]}协议`,
      );
    }

    const rowId = randomUUID();
    return {
      id: rowId,
      agentKind: row.agentKind,
      providerId: provider.id,
      providerName: provider.name,
      baseUrl: provider.baseUrl,
      modelId: row.modelId,
      status: 'pending',
      branch: `test/${rowId}`,
      // 工作区路径在创建时就能算出来：编排层建目录时用的是同一个 core 函数，不会漂移。
      // 落进去省掉「还没准备」这一种额外的空值状态（按需读产物时要按它定位）。
      workspacePath: rowWorkspaceDir(settings.workspaceRoot, runId, rowId),
      // 基线在准备阶段才解析成 40 位 hash（§11 R2），创建时还没有
      baselineCommit: '',
      tokens: null,
      turns: null,
      durationMs: null,
      diff: null,
      score: null,
      error: null,
    };
  });

  const run: EvalRun = {
    id: runId,
    caseId: testCase.id,
    caseTitle: testCase.title,
    repoPath: testCase.repoPath,
    commitHash: testCase.commitHash,
    status: 'idle',
    executionMode: input.executionMode,
    rows,
    workspaceBase: settings.workspaceRoot,
    createdAt: now,
    startedAt: null,
    finishedAt: null,
  };

  saveRun(run);
  log.info('创建评测', { runId, caseId: testCase.id, executionMode: input.executionMode, rows: rows.length });
  return run;
}

/**
 * 启动：只跑未完成的行（spec §5.3 的「开始」语义）。
 * 「没有可执行的行」在 api 层就拦掉并抛 CONFLICT：编排层的 startRun 只承诺「已有运行中的行则抛
 * CONFLICT」，全是 judged 时它会安静地什么都不做——而界面刚点过「开始」，静默无反应是最难排查的反馈。
 */
export function startRun(runId: string): EvalRun {
  const before = getRunSnapshot(runId);
  const runnable = before.rows.filter((row) => isRunnableRow(row.status));
  if (runnable.length === 0) {
    throw new ServiceError('CONFLICT', '这一轮没有可执行的候选行：全部行都已评分，或正在运行中');
  }

  const run = startRunInOrchestrator(runId);
  log.info('启动评测', { runId, runnable: runnable.length });
  return run;
}

/** 终止整轮：在跑的行 → canceled、串行未轮到的 → skipped（两者的划分由编排层负责） */
export function abortRun(runId: string): EvalRun {
  // 先做存在性检查：编排层的 abortRun 对未知 id 的行为没有契约保证，而界面必须拿到 404
  getRunSnapshot(runId);

  const run = abortRunInOrchestrator(runId);
  log.info('终止评测', { runId });
  return run;
}

/** 终止单行：全开并发下某一行明显跑歪时不必等它超时（spec §5.3） */
export function abortRow(runId: string, rowId: string): EvalRun {
  const before = getRunSnapshot(runId);
  if (!before.rows.some((row) => row.id === rowId)) {
    throw new ServiceError('NOT_FOUND', `该评测里没有这一行（${rowId}）`);
  }

  const run = abortRowInOrchestrator(runId, rowId);
  log.info('终止候选行', { runId, rowId });
  return run;
}

/**
 * 候选池投影：某种智能体可用的全部模型（spec §5.1 F2）。
 * 过滤判据是注册表元数据的 `protocolType` —— **不硬编码**「Codex 用 openai」这类对应关系
 * （A3）：将来加第四家智能体时，这里一行都不用改。
 */
export function listModelOptions(agentKind: AgentKind): AgentModelOption[] {
  const { metadata } = getProvider(agentKind);
  return listProviders()
    .filter((provider) => provider.protocolType === metadata.protocolType)
    .flatMap((provider) =>
      provider.models.map((model) => ({
        providerId: provider.id,
        providerName: provider.name,
        modelId: model.id,
        source: model.source,
      })),
    );
}

/** 三种智能体的元数据 + 候选池，一次取全：创建表单与候选卡片共用同一份真源 */
export function listAgentModelOptions(): AgentOptionGroup[] {
  return AGENT_KINDS.map((agentKind) => {
    const { metadata } = getProvider(agentKind);
    return {
      agentKind,
      protocolType: metadata.protocolType,
      usage: metadata.capability.usage,
      cancelMidTurn: metadata.capability.cancelMidTurn,
      options: listModelOptions(agentKind),
    };
  });
}
```

- [ ] **Step 6: 追加 `packages/server/api/src/index.ts` 的导出**

```ts
/** api 公共出口：业务服务层，框架层只从这里 import。 */
export { getSettings, updateSettings } from './settings';
export {
  abortRow,
  abortRun,
  createRun,
  getRunView,
  listAgentModelOptions,
  listModelOptions,
  listRunsView,
  startRun,
  type AgentModelOption,
  type AgentOptionGroup,
} from './runs';
```

- [ ] **Step 7: 跑测试确认通过**

Run: `pnpm --filter @aieval/api test`
Expected: PASS（20 条用例：createRun 6 / listRunsView 1 / getRunView 1 / startRun 3 / abortRun+abortRow 4 / listModelOptions 3 / listAgentModelOptions 2）。

Run: `pnpm typecheck`
Expected: 零错误。

- [ ] **Step 8: 变异验证 —— 候选池必须按协议过滤（守卫三）**

先记下哈希：

```powershell
(Get-FileHash packages/server/api/src/runs.ts -Algorithm SHA256).Hash
```

制造变异体：把 `listModelOptions` 里的 `.filter((provider) => provider.protocolType === metadata.protocolType)` 整行删掉（变成返回全部供应商的全部模型）。

Run: `pnpm --filter @aieval/api test`
Expected: FAIL —— 至少 4 条失败：
- `Claude Code 只看到 anthropic 协议的模型`：实际数组多了 `p-openai / gpt-5`；
- `Codex 只看到 openai 协议的模型，DSH 只看到 anthropic 协议的模型`：codex 多了 `p-anthropic / claude-opus-4-6`、dsh 多了 `p-openai / gpt-5`；
- `没有任何匹配协议的供应商时返回空数组（不是全部模型）`：期望 `[]`、实际 1 条；
- `按 AGENT_KINDS 的顺序给出三个 kind 的元数据与候选池`：`groups[0].options` 长度从 1 变 2。

还原那行 `filter`，再核对哈希：

```powershell
(Get-FileHash packages/server/api/src/runs.ts -Algorithm SHA256).Hash
```

Expected: 与变异前**逐字相同**。然后重跑 `pnpm --filter @aieval/api test` 确认回到全绿。

- [ ] **Step 9: 提交**

```bash
git add packages/server/api/src/runs.ts packages/server/api/src/runs.test.ts packages/server/api/src/testing/run-fixtures.ts packages/server/api/src/index.ts packages/server/api/package.json pnpm-lock.yaml
git commit -m "feat(api): 评测创建/校验/候选池协议投影（含变异验证）"
```

---

## Task 2: `api` —— 代码改动（按需现算）与执行日志读取

**Files:**
- Create: `packages/server/api/src/run-artifacts.ts`
- Create: `packages/server/api/src/run-artifacts.test.ts`
- Modify: `packages/server/api/src/index.ts`（追加导出）

**Interfaces:**
- Consumes: Task 1 的 `getRunView(runId)`；p0 `@aieval/contracts` 的 `RowDiff` / `AgentEvent` / `ServiceError`；p0 `@aieval/core` 的 `collectDiff(dir, baselineCommit)` / `truncateDiff(text, budgetBytes)` / `rowEventsFile(workspaceRoot, runId, rowId)` / `readEvents(file)` / `readEventsAfter(file, afterSeq)` / `createLogger`；api 自己的 `getSettings()`（p1）
- Produces: `getRowDiff(runId: string, rowId: string): RowDiff`、`getRowLog(runId: string, rowId: string, afterSeq?: number): AgentEvent[]`

- [ ] **Step 1: 写失败测试 `packages/server/api/src/run-artifacts.test.ts`**

```ts
// @vitest-environment node
/**
 * 产物的按需读取：代码改动（现场算）与执行日志（读 events.jsonl）。
 *
 * `@aieval/evaluator` 被整块 mock 掉（理由见 runs.test.ts 的文件头：不起真实 agent 进程）；
 * 本文件把自己的快照塞进假 store，从而精确控制「行指向哪个工作区、基线是什么」。
 *
 * `@aieval/core` 只把 `collectDiff` / `truncateDiff` / `readEvents` 包一层可观测的 spy
 * （其余导出原样透传）：这三处是「调用契约」的观测点——例如「裁剪用的是设置里的预算」这条
 * 只能靠 truncateDiff 的第二参断言，用真实实现反而看不出预算从哪来。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ServiceError, type EvalRun } from '@aieval/contracts';
import { appendEvent, setConfigDirForTesting } from '@aieval/core';
import { getRun as getRunSnapshot } from '@aieval/evaluator';
import { getRowDiff, getRowLog } from './run-artifacts';
import { updateSettings } from './settings';
import { makeAnthropicProvider, makeCase, makeRow, makeRun, seedConfig } from './testing/run-fixtures';

vi.mock('@aieval/evaluator', () => ({
  listRuns: vi.fn(),
  getRun: vi.fn(),
  saveRun: vi.fn(),
  startRun: vi.fn(),
  abortRun: vi.fn(),
  abortRow: vi.fn(),
}));

vi.mock('@aieval/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aieval/core')>();
  return {
    ...actual,
    collectDiff: vi.fn(actual.collectDiff),
    truncateDiff: vi.fn(actual.truncateDiff),
    readEvents: vi.fn(actual.readEvents),
  };
});

// 这里 import 的是被 mock 之后的那一份（vi.mock 会被提升到所有 import 之前）
import { collectDiff, readEvents, truncateDiff } from '@aieval/core';

let dir: string;
let workspaceRoot: string;
/** 假的「磁盘」：getRun 从这里读 */
let store: Map<string, EvalRun>;

/** 把一轮评测放进假 store，并按需建出该行的工作区目录 */
function seedRun(run: EvalRun, options: { createWorkspace?: boolean } = {}): void {
  store.set(run.id, run);
  if (options.createWorkspace === true) {
    for (const row of run.rows) mkdirSync(row.workspacePath, { recursive: true });
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aieval-artifacts-'));
  setConfigDirForTesting(dir);
  workspaceRoot = join(dir, 'ws');
  updateSettings({ workspaceRoot });
  seedConfig({ providers: [makeAnthropicProvider()], cases: [makeCase()] });

  store = new Map();
  vi.mocked(getRunSnapshot).mockImplementation((runId: string) => {
    const run = store.get(runId);
    if (run === undefined) throw new ServiceError('NOT_FOUND', `评测不存在：${runId}`);
    return run;
  });
  vi.mocked(collectDiff).mockClear();
  vi.mocked(truncateDiff).mockClear();
  vi.mocked(readEvents).mockClear();
});

afterEach(() => {
  setConfigDirForTesting(null);
  rmSync(dir, { recursive: true, force: true });
});

describe('getRowDiff', () => {
  it('工作区还不存在时抛 CONFLICT，且不去跑 git', () => {
    seedRun(makeRun({ rows: [makeRow({ workspacePath: join(workspaceRoot, 'run-1', 'rows', 'r-1', 'workspace') })] }));

    let caught: unknown;
    try {
      getRowDiff('run-1', 'r-1');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ServiceError);
    expect((caught as ServiceError).code).toBe('CONFLICT');
    expect((caught as ServiceError).message).toContain('还没有工作区');
    expect(vi.mocked(collectDiff)).not.toHaveBeenCalled();
  });

  it('用该行自己的工作区与 baselineCommit 现场算，并把三样计数组装成 RowDiff', () => {
    const row = makeRow({ id: 'r-1', baselineCommit: 'baseline-40' });
    seedRun(makeRun({ rows: [row] }), { createWorkspace: true });
    vi.mocked(collectDiff).mockReturnValue({
      text: '### 已提交改动（baseline-40..HEAD）\ndiff --git a/a.ts b/a.ts\n+one',
      files: [{ path: 'a.ts', insertions: 1, deletions: 0 }],
      filesChanged: 1,
      insertions: 1,
      deletions: 0,
    });
    vi.mocked(truncateDiff).mockReturnValue({ text: 'TRIMMED', truncated: true, droppedFiles: ['b.ts'] });

    const diff = getRowDiff('run-1', 'r-1');

    expect(vi.mocked(collectDiff)).toHaveBeenCalledWith(row.workspacePath, 'baseline-40');
    expect(diff).toEqual({
      text: 'TRIMMED',
      truncated: true,
      files: [{ path: 'a.ts', insertions: 1, deletions: 0 }],
      filesChanged: 1,
      insertions: 1,
      deletions: 0,
      droppedFiles: ['b.ts'],
    });
  });

  it('裁剪预算取自设置里的 diffBudgetBytes，而不是硬编码的 256KB', () => {
    seedRun(makeRun({ rows: [makeRow({ id: 'r-1' })] }), { createWorkspace: true });
    updateSettings({ diffBudgetBytes: 12_345 });

    getRowDiff('run-1', 'r-1');

    expect(vi.mocked(truncateDiff)).toHaveBeenCalledWith(expect.any(String), 12_345);
  });

  it('按该轮快照里的 workspaceBase 找产物，而不是当前设置里的根目录', () => {
    // Review Focus 2：用户改过工作区根目录后，历史评测的产物仍在旧根目录下
    const oldRoot = join(dir, 'old-ws');
    const row = makeRow({ id: 'r-1', workspacePath: join(oldRoot, 'run-1', 'rows', 'r-1', 'workspace') });
    seedRun(makeRun({ id: 'run-1', workspaceBase: oldRoot, rows: [row] }));
    mkdirSync(row.workspacePath, { recursive: true });
    updateSettings({ workspaceRoot: join(dir, 'new-ws') });

    getRowDiff('run-1', 'r-1');

    expect(vi.mocked(collectDiff)).toHaveBeenCalledWith(row.workspacePath, row.baselineCommit);
  });

  it('git 抛错时折成含路径的中文原因（不透英文 stderr）', () => {
    seedRun(makeRun({ rows: [makeRow({ id: 'r-1' })] }), { createWorkspace: true });
    vi.mocked(collectDiff).mockImplementation(() => {
      throw new Error("fatal: not a git repository (or any of the parent directories): .git");
    });

    let caught: unknown;
    try {
      getRowDiff('run-1', 'r-1');
    } catch (error) {
      caught = error;
    }
    expect((caught as ServiceError).code).toBe('INTERNAL');
    expect((caught as ServiceError).message).toContain('读取代码改动失败');
    expect((caught as ServiceError).message).toContain('not a git repository');
  });

  it('行 id 不存在时抛 NOT_FOUND', () => {
    seedRun(makeRun({ rows: [makeRow({ id: 'r-1' })] }), { createWorkspace: true });

    expect(() => getRowDiff('run-1', 'r-x')).toThrowError(/没有这一行/);
  });
});

describe('getRowLog', () => {
  it('不给 afterSeq 时读全量；给了就只读 seq 更大的部分', () => {
    const run = makeRun({ id: 'run-1', workspaceBase: workspaceRoot, rows: [makeRow({ id: 'r-1' })] });
    seedRun(run);
    const file = join(workspaceRoot, 'run-1', 'rows', 'r-1', 'events.jsonl');
    mkdirSync(join(workspaceRoot, 'run-1', 'rows', 'r-1'), { recursive: true });
    appendEvent(file, { type: 'log', stream: 'stdout', text: '一行' });
    appendEvent(file, { type: 'log', stream: 'stdout', text: '二行' });
    appendEvent(file, { type: 'log', stream: 'stdout', text: '三行' });

    expect(getRowLog('run-1', 'r-1').map((event) => event.seq)).toEqual([1, 2, 3]);
    expect(getRowLog('run-1', 'r-1', 2).map((event) => event.seq)).toEqual([3]);
    // afterSeq=0 等价于「从头」（抽屉首帧）
    expect(getRowLog('run-1', 'r-1', 0).map((event) => event.seq)).toEqual([1, 2, 3]);
  });

  it('事件文件还不存在时返回空数组，而不是报错', () => {
    seedRun(makeRun({ id: 'run-1', workspaceBase: workspaceRoot, rows: [makeRow({ id: 'r-1' })] }));

    expect(getRowLog('run-1', 'r-1')).toEqual([]);
  });

  it('读日志失败时折成含文件路径的中文原因（不把 SyntaxError 抛成 500）', () => {
    seedRun(makeRun({ id: 'run-1', workspaceBase: workspaceRoot, rows: [makeRow({ id: 'r-1' })] }));
    // 造一个真的坏文件：末行是半截 JSON（进程被杀在写一半时的真实形态）
    const rowDir = join(workspaceRoot, 'run-1', 'rows', 'r-1');
    mkdirSync(rowDir, { recursive: true });
    writeFileSync(join(rowDir, 'events.jsonl'), '{"seq":1,"at":"2026-09-22T08:00:00.000Z","type":"log","stream":"stdout","text":"half', 'utf8');
    vi.mocked(readEvents).mockImplementation(() => {
      throw new SyntaxError('Unexpected end of JSON input');
    });

    let caught: unknown;
    try {
      getRowLog('run-1', 'r-1');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ServiceError);
    expect((caught as ServiceError).code).toBe('INTERNAL');
    expect((caught as ServiceError).message).toContain('读取执行日志失败');
    expect((caught as ServiceError).message).toContain('events.jsonl');
  });

  it('按该轮快照里的 workspaceBase 读日志，而不是当前设置里的根目录', () => {
    const oldRoot = join(dir, 'old-ws');
    const run = makeRun({ id: 'run-1', workspaceBase: oldRoot, rows: [makeRow({ id: 'r-1' })] });
    seedRun(run);
    const rowDir = join(oldRoot, 'run-1', 'rows', 'r-1');
    mkdirSync(rowDir, { recursive: true });
    appendEvent(join(rowDir, 'events.jsonl'), { type: 'log', stream: 'stdout', text: '旧根目录里的事件' });
    updateSettings({ workspaceRoot: join(dir, 'new-ws') });

    expect(getRowLog('run-1', 'r-1').map((event) => event.text)).toEqual(['旧根目录里的事件']);
  });

  it('行 id 不存在时抛 NOT_FOUND', () => {
    seedRun(makeRun({ id: 'run-1', workspaceBase: workspaceRoot, rows: [makeRow({ id: 'r-1' })] }));

    expect(() => getRowLog('run-1', 'r-x')).toThrowError(/没有这一行/);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @aieval/api test`
Expected: FAIL —— 收集阶段失败：`Failed to resolve import "./run-artifacts" from "src/run-artifacts.test.ts". Does the file exist?`

- [ ] **Step 3: 写实现 `packages/server/api/src/run-artifacts.ts`**

```ts
/**
 * 评测产物的按需读取：代码改动（现场算）与执行日志（读 events.jsonl）。
 * 两条口径：
 *   1. **不预先落库**（spec §7.2）：一轮评测的 diff 正文可达数 MB，只在有人打开抽屉时才算；
 *      `EvalRow.diff` 只存计数摘要；
 *   2. 一切都以**该轮自己的 `workspaceBase`** 为根（spec §6.3）：用户改过工作区根目录之后，
 *      历史评测的产物仍留在旧根目录下——按当前设置去找会「产物明明在、抽屉却是空的」。
 */
import { existsSync } from 'node:fs';
import { ServiceError, type AgentEvent, type EvalRow, type EvalRun, type RowDiff } from '@aieval/contracts';
import {
  collectDiff,
  createLogger,
  readEvents,
  readEventsAfter,
  rowEventsFile,
  truncateDiff,
} from '@aieval/core';
import { getRunView } from './runs';
import { getSettings } from './settings';

const log = createLogger('runs');

/** 在快照里找一行；找不到抛 NOT_FOUND（轮 id 与行 id 都可能来自脏 URL） */
function findRow(run: EvalRun, rowId: string): EvalRow {
  const row = run.rows.find((item) => item.id === rowId);
  if (row === undefined) {
    throw new ServiceError('NOT_FOUND', `该评测里没有这一行（${rowId}）`);
  }
  return row;
}

/**
 * 代码改动：现场跑 git 现算 + 按设置的 `diffBudgetBytes` 裁剪。
 * 工作区还不存在（该行没开始跑、或准备阶段就失败了）时抛 CONFLICT，而不是让 git 抛英文原文——
 * 「还没有产出」与「算 diff 出错」是两回事，文案必须能区分。
 */
export function getRowDiff(runId: string, rowId: string): RowDiff {
  const run = getRunView(runId);
  const row = findRow(run, rowId);

  if (!existsSync(row.workspacePath)) {
    throw new ServiceError('CONFLICT', `这一行还没有工作区（${row.workspacePath}），没有可看的代码改动`);
  }

  let collected: ReturnType<typeof collectDiff>;
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
  log.info('按需计算代码改动', {
    runId,
    rowId,
    filesChanged: collected.filesChanged,
    truncated: clipped.truncated,
  });

  return {
    text: clipped.text,
    truncated: clipped.truncated,
    files: collected.files,
    filesChanged: collected.filesChanged,
    insertions: collected.insertions,
    deletions: collected.deletions,
    droppedFiles: clipped.droppedFiles,
  };
}

/**
 * 执行日志：给了 `afterSeq` 就只取 `seq` 更大的部分（抽屉首帧与 SSE 续订共用同一个出口）。
 * 文件不存在时 `readEvents` 返回 `[]`（该行还没开始跑），这不是错误。
 */
export function getRowLog(runId: string, rowId: string, afterSeq?: number): AgentEvent[] {
  const run = getRunView(runId);
  const row = findRow(run, rowId);
  const file = rowEventsFile(run.workspaceBase, run.id, row.id);

  try {
    return afterSeq === undefined || afterSeq <= 0 ? readEvents(file) : readEventsAfter(file, afterSeq);
  } catch (error) {
    // 坏行 / 权限 / 编码问题都可能在这里抛：一律折成含路径的中文原因，
    // 否则路由层只会给出「服务端内部错误」，连是哪个文件坏了都看不出来
    throw new ServiceError(
      'INTERNAL',
      `读取执行日志失败（${file}）：${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}
```

- [ ] **Step 4: 追加 `packages/server/api/src/index.ts` 的导出**

在上一任务写的导出块后面追加：

```ts
export { getRowDiff, getRowLog } from './run-artifacts';
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm --filter @aieval/api test`
Expected: PASS（Task 1 的 20 条 + 本任务的 11 条：getRowDiff 6 / getRowLog 5）。

Run: `pnpm typecheck`
Expected: 零错误。

- [ ] **Step 6: 提交**

```bash
git add packages/server/api/src/run-artifacts.ts packages/server/api/src/run-artifacts.test.ts packages/server/api/src/index.ts
git commit -m "feat(api): 代码改动按需现算与执行日志读取（按该轮 workspaceBase）"
```

---

## Task 3: `api` —— SSE 帧产出（`streamRowEvents`）

**Files:**
- Create: `packages/server/api/src/run-stream.ts`
- Create: `packages/server/api/src/run-stream.test.ts`
- Modify: `packages/server/api/src/index.ts`（追加导出）

**Interfaces:**
- Consumes: Task 1 的 `getRunView(runId)`；Task 2 的 `getRowLog(runId, rowId, afterSeq)`；p0 `@aieval/contracts` 的 `TERMINAL_ROW_STATUSES` / `AgentEvent` / `ServiceError`；p4 `@aieval/evaluator` 的 `subscribeRowEvents(runId, rowId, listener): () => void`
- Produces: `streamRowEvents(runId: string, rowId: string, afterSeq: number): ReadableStream<Uint8Array>`

- [ ] **Step 1: 写失败测试 `packages/server/api/src/run-stream.test.ts`**

```ts
// @vitest-environment node
/**
 * SSE 帧产出：回放历史 → 接进程内事件总线 → 终态关流。
 * 帧格式是本文件最硬的断言对象：`id` 缺了浏览器就无法按 Last-Event-ID 续订（spec §7.4）；
 * `data` 里出现裸换行会把一帧劈成两帧，所以断言的是逐行的精确文本。
 *
 * `subscribeRowEvents` 由本文件自己实现（vi.mock 的工厂里维护一张监听表），
 * 于是「总线推一条事件 → 流里出现一帧」这条链路可以在不启动任何编排的情况下被验证。
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ServiceError, type AgentEvent, type EvalRun } from '@aieval/contracts';
import { appendEvent, setConfigDirForTesting } from '@aieval/core';
import { getRun as getRunSnapshot } from '@aieval/evaluator';
import { streamRowEvents } from './run-stream';
import { updateSettings } from './settings';
import { makeCase, makeRow, makeRun, seedConfig } from './testing/run-fixtures';

/** 本文件挂上去的总线监听（key = `${runId}/${rowId}`） */
const listeners = new Map<string, Array<(event: AgentEvent) => void>>();

vi.mock('@aieval/evaluator', () => ({
  listRuns: vi.fn(),
  getRun: vi.fn(),
  saveRun: vi.fn(),
  startRun: vi.fn(),
  abortRun: vi.fn(),
  abortRow: vi.fn(),
  subscribeRowEvents: vi.fn((runId: string, rowId: string, listener: (event: AgentEvent) => void) => {
    const key = `${runId}/${rowId}`;
    const bucket = listeners.get(key) ?? [];
    bucket.push(listener);
    listeners.set(key, bucket);
    return () => {
      const current = listeners.get(key) ?? [];
      listeners.set(key, current.filter((item) => item !== listener));
    };
  }),
}));

let dir: string;
let workspaceRoot: string;
let store: Map<string, EvalRun>;

/** 往该行的事件日志里追加一条事件（写真实文件，走 core 的 seq 分配） */
function append(runId: string, rowId: string, event: Parameters<typeof appendEvent>[1]): AgentEvent {
  const rowDir = join(workspaceRoot, runId, 'rows', rowId);
  mkdirSync(rowDir, { recursive: true });
  return appendEvent(join(rowDir, 'events.jsonl'), event);
}

/** 读到流结束（适用于「回放里已有终态」的用例；不会挂住） */
async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  return await new Response(stream).text();
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aieval-stream-'));
  setConfigDirForTesting(dir);
  workspaceRoot = join(dir, 'ws');
  updateSettings({ workspaceRoot });
  seedConfig({ cases: [makeCase()] });
  listeners.clear();

  store = new Map();
  vi.mocked(getRunSnapshot).mockImplementation((runId: string) => {
    const run = store.get(runId);
    if (run === undefined) throw new ServiceError('NOT_FOUND', `评测不存在：${runId}`);
    return run;
  });
});

afterEach(() => {
  vi.useRealTimers();
  setConfigDirForTesting(null);
  rmSync(dir, { recursive: true, force: true });
});

describe('streamRowEvents', () => {
  it('按 id/event/data + 空行 的帧格式回放历史，遇到终态事件后立即关流', async () => {
    store.set('run-1', makeRun({ id: 'run-1', workspaceBase: workspaceRoot, rows: [makeRow({ id: 'r-1' })] }));
    const first = append('run-1', 'r-1', { type: 'log', stream: 'stdout', text: '第一行' });
    const end = append('run-1', 'r-1', { type: 'end', exitReason: 'completed' });

    const text = await readAll(streamRowEvents('run-1', 'r-1', 0));

    const lines = text.split('\n');
    expect(lines[0]).toBe(`id: ${first.seq}`);
    expect(lines[1]).toBe('event: log');
    expect(lines[2]).toBe(`data: ${JSON.stringify(first)}`);
    expect(lines[3]).toBe('');
    expect(lines[4]).toBe(`id: ${end.seq}`);
    expect(lines[5]).toBe('event: end');
    expect(lines[6]).toBe(`data: ${JSON.stringify(end)}`);
    expect(lines[7]).toBe('');
    // 终态之后不再有心跳：流必须已经关闭（`Response.text()` 能返回就是证据）
    expect(lines[8]).toBe('');
  });

  it('终态的 status 事件同样关流（不必等到 end）', async () => {
    store.set('run-1', makeRun({ id: 'run-1', workspaceBase: workspaceRoot, rows: [makeRow({ id: 'r-1' })] }));
    append('run-1', 'r-1', { type: 'status', status: 'canceled' });

    const text = await readAll(streamRowEvents('run-1', 'r-1', 0));

    expect(text).toContain('event: status');
    expect(text.endsWith('\n\n')).toBe(true);
  });

  it('afterSeq 只回放 seq 更大的部分', async () => {
    store.set('run-1', makeRun({ id: 'run-1', workspaceBase: workspaceRoot, rows: [makeRow({ id: 'r-1' })] }));
    append('run-1', 'r-1', { type: 'log', stream: 'stdout', text: '旧' });
    const second = append('run-1', 'r-1', { type: 'end', exitReason: 'completed' });

    const text = await readAll(streamRowEvents('run-1', 'r-1', 1));

    expect(text).not.toContain('"text":"旧"');
    expect(text).toContain(`id: ${second.seq}`);
  });

  it('未终止的行：历史回放完后挂上总线，新事件即时成帧', async () => {
    store.set('run-1', makeRun({ id: 'run-1', workspaceBase: workspaceRoot, rows: [makeRow({ id: 'r-1' })] }));
    append('run-1', 'r-1', { type: 'status', status: 'running' });

    const stream = streamRowEvents('run-1', 'r-1', 0);
    const reader = stream.getReader();
    const decoder = new TextDecoder();

    const replayed = await reader.read();
    expect(decoder.decode(replayed.value)).toContain('event: status');

    // 总线推一条：流里应出现对应帧（不再是轮询，而是推送）
    const pushed = append('run-1', 'r-1', { type: 'log', stream: 'stderr', text: '来自总线' });
    for (const listener of listeners.get('run-1/r-1') ?? []) listener(pushed);
    const next = await reader.read();
    expect(decoder.decode(next.value)).toBe(`id: ${pushed.seq}\nevent: log\ndata: ${JSON.stringify(pushed)}\n\n`);

    // 终态帧之后流关闭
    const end = append('run-1', 'r-1', { type: 'end', exitReason: 'completed' });
    for (const listener of listeners.get('run-1/r-1') ?? []) listener(end);
    const last = await reader.read();
    expect(decoder.decode(last.value)).toContain('event: end');
    expect((await reader.read()).done).toBe(true);
  });

  it('客户端取消时退订总线（否则事件会一直往没人读的流里塞）', async () => {
    store.set('run-1', makeRun({ id: 'run-1', workspaceBase: workspaceRoot, rows: [makeRow({ id: 'r-1' })] }));
    append('run-1', 'r-1', { type: 'status', status: 'running' });

    const stream = streamRowEvents('run-1', 'r-1', 0);
    const reader = stream.getReader();
    await reader.read();
    expect(listeners.get('run-1/r-1')).toHaveLength(1);

    await reader.cancel();

    expect(listeners.get('run-1/r-1')).toHaveLength(0);
  });

  it('无历史可回放时先发一条保活注释帧，取消后定时器清零', async () => {
    // 反向代理与浏览器都会掐掉长时间静默的连接：注释帧是 SSE 的标准保活手段
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    store.set('run-1', makeRun({ id: 'run-1', workspaceBase: workspaceRoot, rows: [makeRow({ id: 'r-1' })] }));
    append('run-1', 'r-1', { type: 'status', status: 'running' });

    const stream = streamRowEvents('run-1', 'r-1', 5);
    const reader = stream.getReader();
    const decoder = new TextDecoder();

    vi.advanceTimersByTime(15_000);
    const beat = await reader.read();
    expect(decoder.decode(beat.value)).toBe(': keep-alive\n\n');

    await reader.cancel();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('轮或行不存在时**同步**抛错：这样路由能回 404 JSON，而不是开一个立刻结束的流', () => {
    store.set('run-1', makeRun({ id: 'run-1', workspaceBase: workspaceRoot, rows: [makeRow({ id: 'r-1' })] }));

    expect(() => streamRowEvents('nope', 'r-1', 0)).toThrowError(ServiceError);
    expect(() => streamRowEvents('run-1', 'r-x', 0)).toThrowError(/没有这一行/);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @aieval/api test`
Expected: FAIL —— `Failed to resolve import "./run-stream" from "src/run-stream.test.ts". Does the file exist?`

- [ ] **Step 3: 写实现 `packages/server/api/src/run-stream.ts`**

```ts
/**
 * 行级 SSE 产出：把 events.jsonl 的历史回放 + 进程内事件总线扇出成 SSE 帧。
 * 三条口径：
 *   1. **只用 Web 标准类型**（`ReadableStream` / `Uint8Array` / `TextEncoder`）——api 禁框架，
 *      这里连 `Response` 都不组装，响应头由路由层负责；
 *   2. 帧格式写死为 `id: <seq>` + `event: <type>` + `data: <JSON>` + 空行：`id` 是浏览器
 *      `Last-Event-ID` 的唯一来源，缺了它断线重连只能从头再来（spec §7.4）；
 *   3. 回放里出现终态就**立即关流**（spec §8.3）：已经跑完的行不该让浏览器挂着一条永不结束的连接。
 */
import { ServiceError, TERMINAL_ROW_STATUSES, type AgentEvent } from '@aieval/contracts';
import { createLogger } from '@aieval/core';
import { subscribeRowEvents } from '@aieval/evaluator';
import { getRowLog } from './run-artifacts';
import { getRunView } from './runs';

const log = createLogger('runs');

/** 保活间隔：反向代理与浏览器都会掐掉长时间静默的连接 */
const HEARTBEAT_MS = 15_000;

/** 一条事件是不是「这一行已经结束」：`end` 事件与终态 `status` 事件都算 */
function isTerminalEvent(event: AgentEvent): boolean {
  if (event.type === 'end') return true;
  return event.type === 'status' && TERMINAL_ROW_STATUSES.includes(event.status);
}

/**
 * 一帧的序列化。
 * `data` 里不能出现裸换行（否则一帧会被劈成两帧），而 `JSON.stringify` 已把换行转义成 `\n`，
 * 所以单行 data 是安全的。
 */
function toFrame(event: AgentEvent): string {
  return `id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

/**
 * 订阅一行的 SSE 流：先回放 `seq > afterSeq` 的历史，再接进程内事件总线。
 * 校验放在开流之前（同步抛错）：这样「评测/行不存在」拿到的是 404 JSON，
 * 而不是一个开了就立刻结束的 SSE 流——后者在浏览器里表现为「莫名其妙没有日志」。
 */
export function streamRowEvents(runId: string, rowId: string, afterSeq: number): ReadableStream<Uint8Array> {
  const run = getRunView(runId);
  if (!run.rows.some((row) => row.id === rowId)) {
    throw new ServiceError('NOT_FOUND', `该评测里没有这一行（${rowId}）`);
  }
  const history = getRowLog(runId, rowId, afterSeq);
  const encoder = new TextEncoder();

  // 这几个状态放流外：`cancel` 与 `start` 都要能碰到同一份，否则客户端断开时定时器与订阅会漏
  let closed = false;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let unsubscribe: (() => void) | null = null;

  /** 释放资源（幂等）：关流与取消都要走它 */
  const teardown = (): void => {
    if (heartbeat !== null) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
    unsubscribe?.();
    unsubscribe = null;
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const close = (): void => {
        if (closed) return;
        closed = true;
        teardown();
        controller.close();
      };

      const push = (event: AgentEvent): void => {
        if (closed) return;
        controller.enqueue(encoder.encode(toFrame(event)));
        if (isTerminalEvent(event)) close();
      };

      for (const event of history) {
        push(event);
        if (closed) break;
      }
      // 历史里已经有终态：不订阅、不起心跳（否则浏览器会一直挂着这条连接）
      if (closed) return;

      unsubscribe = subscribeRowEvents(runId, rowId, push);
      heartbeat = setInterval(() => {
        if (closed) return;
        // 注释帧（以 `:` 开头）按 SSE 规范被客户端忽略，只用来占住连接
        controller.enqueue(encoder.encode(': keep-alive\n\n'));
      }, HEARTBEAT_MS);
      log.debug('SSE 开始推送', { runId, rowId, afterSeq, replayed: history.length });
    },
    cancel() {
      // 客户端断开（关闭抽屉 / 切行）：必须退订并清定时器。
      // 这里不能调 controller.close()——流已经被取消了，再关会抛。
      closed = true;
      teardown();
      log.debug('SSE 被客户端取消', { runId, rowId });
    },
  });
}
```

- [ ] **Step 4: 追加 `packages/server/api/src/index.ts` 的导出**

```ts
export { streamRowEvents } from './run-stream';
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm --filter @aieval/api test`
Expected: PASS（Task 1/2/3 全部用例）。

Run: `pnpm typecheck`
Expected: 零错误。

- [ ] **Step 6: 提交**

```bash
git add packages/server/api/src/run-stream.ts packages/server/api/src/run-stream.test.ts packages/server/api/src/index.ts
git commit -m "feat(api): 行级 SSE 帧产出（id/event/data 格式 + 终态关流 + 保活帧）"
```

---

## Task 4: `client` —— 评测数据层（列表 / 详情 / 四个动作 / 产物读取 / 候选池）

**Files:**
- Create: `packages/client/client/src/testing/run-fixtures.ts`
- Create: `packages/client/client/src/runs.ts`
- Create: `packages/client/client/src/runs.test.tsx`
- Modify: `packages/client/client/src/index.ts`（追加导出）

**Interfaces:**
- Consumes: 契约 §7 的键约定（`/api/runs`、`/api/runs/{id}`）+ Task 10 的路由；p0 `@aieval/contracts` 的 `EvalRun` / `RowDiff` / `RunCreate` / `isRunningRow` / `AgentKind` / `ProtocolType` / `ProviderModel`；本包既有的 `getJson` / `postJson`
- Produces: `RUNS_KEY`、`runKey(runId)`、`runRowUrl(runId, rowId, artifact)`、`useRuns()`、`useRun(id)`、`useCreateRun()`、`useStartRun()`、`useAbortRun()`、`useAbortRow()`、`useRowDiff(runId, rowId, enabled)`、`useRowLog(runId, rowId, enabled)`、`useRunModelOptions()`、`type AgentModelOption`、`type AgentOptionGroup`

- [ ] **Step 1: 写测试夹具 `packages/client/client/src/testing/run-fixtures.ts`**

```ts
/**
 * client 包的评测域测试夹具：一轮评测与几条事件。
 * 只造数据，不做断言；runs.test.tsx 与 row-stream.test.tsx 共用。
 * 注意：本文件不是 *.test.tsx，vitest 不会把它当用例收集。
 */
import type { AgentEvent, EvalRun, EvalRow } from '@aieval/contracts';

/** 造一行评测：默认是「跑完了、有分」的形状，可用 overrides 覆盖 */
export function makeRow(overrides: Partial<EvalRow> = {}): EvalRow {
  return {
    id: 'w-1',
    agentKind: 'claude-code',
    providerId: 'p-anthropic',
    providerName: 'Anthropic 网关',
    baseUrl: 'https://gw.example.com/anthropic',
    modelId: 'claude-opus-4-6',
    status: 'judged',
    branch: 'test/w-1',
    workspacePath: 'D:\\runs\\run-1\\rows\\w-1\\workspace',
    baselineCommit: '30b86eedca90b70d15b9eb9e75b454a2574762d4',
    tokens: { input: 128_450, cached: 12_800, output: 4_200 },
    turns: 17,
    durationMs: 383_000,
    diff: { filesChanged: 3, insertions: 25, deletions: 7, truncated: false },
    score: null,
    error: null,
    ...overrides,
  };
}

/** 造一轮评测：默认单行、已完成 */
export function makeRun(overrides: Partial<EvalRun> = {}): EvalRun {
  return {
    id: 'run-1',
    caseId: 'c-1',
    caseTitle: '为多协议入站补齐 Anthropic 到 Chat 的转换',
    repoPath: 'D:\\projects\\gateway',
    commitHash: null,
    status: 'done',
    executionMode: 'parallel',
    rows: [makeRow()],
    workspaceBase: 'D:\\runs',
    createdAt: '2026-09-22T08:00:00.000Z',
    startedAt: '2026-09-22T08:01:00.000Z',
    finishedAt: '2026-09-22T08:10:00.000Z',
    ...overrides,
  };
}

/** 造一条事件：seq 必填，其余按类型给默认值 */
export function makeEvent(overrides: Partial<AgentEvent> & { seq: number }): AgentEvent {
  const base = { at: '2026-09-22T08:00:00.000Z', type: 'log' as const, stream: 'stdout' as const, text: `第 ${overrides.seq} 行` };
  return { ...base, ...overrides } as AgentEvent;
}
```

- [ ] **Step 2: 写失败测试 `packages/client/client/src/runs.test.tsx`**

```tsx
/**
 * 评测数据层：键、轮询开关、四个动作的请求与回写、产物按需读取的条件键。
 * 重点在两条容易被写错、写错了界面表现又很隐蔽的约定：
 *   1. **轮询只在有 running 时开**（spec §8 末段）——用假定时器推 3 秒看请求次数，
 *      既验证「该轮询时轮询」，也验证「跑完必须停」；
 *   2. mutation 成功后要写进缓存且**不得**被随后的 GET 覆盖（沿用 useSettings 的回写约定）。
 *
 * 假定时器显式列出 `toFake`：只替换 setTimeout/setInterval/Date，不碰 queueMicrotask 与
 * nextTick——SWR 的请求链是 Promise 驱动的，把微任务也冻结掉会让用例假死。
 */
import { createElement, type ReactNode } from 'react';
import { SWRConfig } from 'swr';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useRun, useRuns, useCreateRun, useStartRun, useAbortRow, useRowDiff, useRowLog, useRunModelOptions } from './runs';
import { makeRow, makeRun } from './testing/run-fixtures';

const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(SWRConfig, { value: { provider: () => new Map() } }, children);

/** 挂载请求可能是微任务、也可能是 0ms 定时器；推进 0ms 把它冲出来，免得它被算成一次轮询 */
async function flushMount(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('useRuns', () => {
  it('挂载后拉到列表，键是 /api/runs', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify([makeRun()]), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useRuns(), { wrapper });
    await flushMount();

    expect(result.current.runs).toHaveLength(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/runs');
  });

  it('有 running 的行时 3 秒轮询一次，跑完立即停', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify([makeRun({ status: 'running', rows: [makeRow({ status: 'running' })] })]), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useRuns(), { wrapper });
    await flushMount();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // 下一次拉回来的是「已完成」：轮询必须关掉，否则开着的页面会永远打接口
    fetchMock.mockImplementation(async () => new Response(JSON.stringify([makeRun()]), { status: 200 }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    const afterFinish = fetchMock.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(9000);
    });
    expect(fetchMock.mock.calls.length).toBe(afterFinish);
    expect(result.current.runs?.[0]?.status).toBe('done');
  });

  it('一轮都没在跑时完全不轮询', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify([makeRun()]), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    renderHook(() => useRuns(), { wrapper });
    await flushMount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(9000);
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('useRun', () => {
  it('id 为 null 时不发请求（右栏未打开）', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(makeRun()), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    renderHook(() => useRun(null), { wrapper });
    await flushMount();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('id 给了就拉 /api/runs/{id}', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(makeRun({ id: 'run-9' })), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useRun('run-9'), { wrapper });
    await flushMount();

    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/runs/run-9');
    expect(result.current.run?.id).toBe('run-9');
  });
});

describe('四个动作', () => {
  it('create 发 POST /api/runs，把响应写进详情缓存并显式刷新列表', async () => {
    const created = makeRun({ id: 'run-new' });
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return new Response(JSON.stringify(created), { status: 201 });
      if (String(url) === '/api/runs/run-new') return new Response(JSON.stringify(created), { status: 200 });
      return new Response(JSON.stringify([created]), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    // 两个消费者都要先挂上：列表 hook 让 `/api/runs` 有 fetcher（否则下面的「刷新列表」无从观察），
    // 详情 hook 让「写进详情缓存」这条路径有消费者，并且能数清详情端点被拉了几次
    const list = renderHook(() => useRuns(), { wrapper });
    const detail = renderHook(() => useRun('run-new'), { wrapper });
    await flushMount();
    const countGets = (url: string): number => fetchMock.mock.calls.filter(([called]) => String(called) === url).length;
    expect(countGets('/api/runs')).toBe(1);
    expect(countGets('/api/runs/run-new')).toBe(1);
    expect(list.result.current.runs).toBeUndefined(); // 还没刷新，先记住这个起点

    const { result } = renderHook(() => useCreateRun(), { wrapper });
    const input = {
      caseId: 'c-1',
      executionMode: 'parallel' as const,
      rows: [{ agentKind: 'claude-code' as const, providerId: 'p-1', modelId: 'm-1' }],
    };
    await act(async () => {
      await result.current.create(input);
    });

    const post = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'POST');
    expect(post?.[0]).toBe('/api/runs');
    expect(JSON.parse(String((post?.[1] as RequestInit).body))).toEqual(input);
    // revalidate:false ⇒ 详情端点不多发 GET，但缓存里已经是新建的那一份
    expect(countGets('/api/runs/run-new')).toBe(1);
    expect(detail.result.current.run?.id).toBe('run-new');
    // 列表被显式刷新一次（契约 §7 的回写约定）
    await flushMount();
    expect(countGets('/api/runs')).toBe(2);
    expect(list.result.current.runs).toHaveLength(1);
  });

  it('start / abortRow 发到正确的端点', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(makeRun()), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const start = renderHook(() => useStartRun(), { wrapper });
    await act(async () => {
      await start.result.current.start('run-1');
    });
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe('/api/runs/run-1/start');

    const abortRow = renderHook(() => useAbortRow(), { wrapper });
    await act(async () => {
      await abortRow.result.current.abortRow('run-1', 'w-1');
    });
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe('/api/runs/run-1/rows/w-1/abort');
  });
});

describe('产物读取', () => {
  it('useRowDiff 在 enabled=false 时一个请求都不发', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    renderHook(() => useRowDiff('run-1', 'w-1', false), { wrapper });
    await flushMount();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('useRowDiff / useRowLog 的键就是真实端点', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify([]), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    renderHook(() => useRowDiff('run-1', 'w-1', true), { wrapper });
    await flushMount();
    renderHook(() => useRowLog('run-1', 'w-1', true), { wrapper });
    await flushMount();

    const urls = fetchMock.mock.calls.map(([url]) => url);
    expect(urls).toContain('/api/runs/run-1/rows/w-1/diff');
    expect(urls).toContain('/api/runs/run-1/rows/w-1/log');
  });
});

describe('useRunModelOptions', () => {
  it('按 agentKind 给出候选池与能力元数据，未知 kind 退回乐观默认值', async () => {
    const groups = [
      { agentKind: 'claude-code', protocolType: 'anthropic', usage: true, cancelMidTurn: true, options: [{ providerId: 'p-1', providerName: 'A', modelId: 'claude-opus-4-6', source: 'manual' }] },
      { agentKind: 'dsh', protocolType: 'anthropic', usage: false, cancelMidTurn: false, options: [] },
    ];
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(groups), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useRunModelOptions(), { wrapper });
    await flushMount();

    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/runs/model-options');
    expect(result.current.optionsFor('claude-code').map((option) => option.modelId)).toEqual(['claude-opus-4-6']);
    expect(result.current.capabilityOf('dsh')).toEqual({ usage: false, cancelMidTurn: false });
    // 数据还没到 / kind 未知时按「都支持」处理：多给一个终止按钮，比无端禁用安全
    expect(result.current.capabilityOf('codex')).toEqual({ usage: true, cancelMidTurn: true });
    expect(result.current.optionsFor('codex')).toEqual([]);
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `pnpm --filter @aieval/client test`
Expected: FAIL —— `Failed to resolve import "./runs" from "src/runs.test.tsx". Does the file exist?`

- [ ] **Step 4: 写实现 `packages/client/client/src/runs.ts`**

```ts
/**
 * 评测数据层：列表 / 详情 / 创建 / 启动 / 终止 / 产物读取 / 候选池。
 * 三条约定：
 *   1. **加键在这里，不在页面里**：`/api/runs` 与 `/api/runs/{id}` 被四个 hook 与
 *      `row-stream.ts` 共用（终态后要 mutate 的就是这两个键），字面量散落必然漂移；
 *   2. 轮询只在「还有活在跑」时开（spec §8 末段）。`refreshInterval` 传的是**数字**而不是
 *      函数：SWR 的轮询效果在挂载时先求值一次，函数形式拿到的永远是「还没有数据」的那一刻
 *      （恒为 0），之后再也不会重新调度——把 running 的评测接上去会一次都不轮询；
 *   3. mutation 成功后写缓存 + `revalidate:false`，再显式刷新列表（契约 §7 的回写约定）。
 *      这里没用 `useSWRMutation`：启动/终止的响应要同时写进**详情**与**列表**两个键，
 *      而它只绑定一个键，用了还得再手写一次 mutate——不如从一开始就用 `useSWRConfig().mutate`。
 */
import { useCallback, useMemo, useState } from 'react';
import useSWR, { useSWRConfig } from 'swr';
import {
  isRunningRow,
  type AgentKind,
  type EvalRun,
  type ProtocolType,
  type ProviderModel,
  type RowDiff,
  type RunCreate,
  type AgentEvent,
} from '@aieval/contracts';
import { getJson, postJson } from './http';

/** 列表键：与 useRuns / useCreateRun / useStartRun 的显式刷新共用 */
export const RUNS_KEY = '/api/runs';

/** 单轮详情键 */
export function runKey(runId: string): string {
  return `${RUNS_KEY}/${runId}`;
}

/** 一行的产物端点（diff / log / stream 同前缀）——SSE 与两处按需读取共用，免得字面量三份 */
export function runRowUrl(runId: string, rowId: string, artifact: 'diff' | 'log' | 'stream'): string {
  return `${runKey(runId)}/rows/${rowId}/${artifact}`;
}

/** 候选池与能力元数据的端点（见计划「修正 2/3」） */
export const AGENT_OPTIONS_KEY = '/api/runs/model-options';

/** 有在跑的行时的轮询间隔（spec §8 末段） */
const RUN_POLL_MS = 3000;

/** 一轮「还有活在跑」：轮级 status 与行级状态都要看——编排层翻转轮状态有一拍延迟 */
function isLiveRun(run: EvalRun): boolean {
  return run.status === 'running' || run.rows.some((row) => isRunningRow(row.status));
}

/** 候选池里的一个模型：与 api 的 `AgentModelOption` 逐字段一致（client 不能 import api，故此处重复声明） */
export interface AgentModelOption {
  providerId: string;
  providerName: string;
  modelId: string;
  source: ProviderModel['source'];
}

/**
 * 一种智能体的能力元数据 + 候选池：与 api 的 `AgentOptionGroup` 逐字段一致。
 * client 不能 import api，所以这份形状在两侧各声明一次；**字段集合由路由测试钉死**
 * （见 Task 10：断言响应对象的键集合），哪一侧偷偷加字段都会当场失败。
 */
export interface AgentOptionGroup {
  agentKind: AgentKind;
  protocolType: ProtocolType;
  usage: boolean;
  cancelMidTurn: boolean;
  options: AgentModelOption[];
}

export function useRuns(): { runs: EvalRun[] | undefined; error: unknown; isLoading: boolean; refresh: () => void } {
  const { data, error, isLoading, mutate } = useSWR<EvalRun[]>(RUNS_KEY, getJson, {
    refreshInterval: data !== undefined && data.some(isLiveRun) ? RUN_POLL_MS : 0,
  });
  return { runs: data, error, isLoading, refresh: () => void mutate() };
}

export function useRun(id: string | null): {
  run: EvalRun | undefined;
  error: unknown;
  isLoading: boolean;
  refresh: () => void;
} {
  const { data, error, isLoading, mutate } = useSWR<EvalRun>(id === null ? null : runKey(id), getJson, {
    // SSE 覆盖逐行的计量跳动；轮级状态与排名的收敛仍靠一次快照刷新，
    // 3 秒兜底让「万一 SSE 断掉」也不会永久停在「执行中」
    refreshInterval: data !== undefined && isLiveRun(data) ? RUN_POLL_MS : 0,
  });
  return { run: data, error, isLoading, refresh: () => void mutate() };
}

export function useCreateRun(): { create: (input: RunCreate) => Promise<EvalRun>; isCreating: boolean } {
  const { mutate } = useSWRConfig();
  const [isCreating, setCreating] = useState(false);

  const create = useCallback(
    async (input: RunCreate): Promise<EvalRun> => {
      setCreating(true);
      try {
        const run = await postJson<EvalRun>(RUNS_KEY, input);
        // 新建的轮直接进详情缓存（revalidate:false，避免紧接的 GET 用旧值覆盖），再刷新列表让它出现在最前
        await mutate(runKey(run.id), run, { revalidate: false });
        await mutate(RUNS_KEY);
        return run;
      } finally {
        setCreating(false);
      }
    },
    [mutate],
  );

  return { create, isCreating };
}

export function useStartRun(): { start: (runId: string) => Promise<EvalRun>; isStarting: boolean } {
  const { mutate } = useSWRConfig();
  const [isStarting, setStarting] = useState(false);

  const start = useCallback(
    async (runId: string): Promise<EvalRun> => {
      setStarting(true);
      try {
        const run = await postJson<EvalRun>(`${runKey(runId)}/start`, {});
        await mutate(runKey(runId), run, { revalidate: false });
        await mutate(RUNS_KEY);
        return run;
      } finally {
        setStarting(false);
      }
    },
    [mutate],
  );

  return { start, isStarting };
}

export function useAbortRun(): { abort: (runId: string) => Promise<EvalRun>; isAborting: boolean } {
  const { mutate } = useSWRConfig();
  const [isAborting, setAborting] = useState(false);

  const abort = useCallback(
    async (runId: string): Promise<EvalRun> => {
      setAborting(true);
      try {
        const run = await postJson<EvalRun>(`${runKey(runId)}/abort`, {});
        await mutate(runKey(runId), run, { revalidate: false });
        await mutate(RUNS_KEY);
        return run;
      } finally {
        setAborting(false);
      }
    },
    [mutate],
  );

  return { abort, isAborting };
}

export function useAbortRow(): {
  abortRow: (runId: string, rowId: string) => Promise<EvalRun>;
  isAborting: boolean;
} {
  const { mutate } = useSWRConfig();
  const [isAborting, setAborting] = useState(false);

  const abortRow = useCallback(
    async (runId: string, rowId: string): Promise<EvalRun> => {
      setAborting(true);
      try {
        const run = await postJson<EvalRun>(`${runKey(runId)}/rows/${rowId}/abort`, {});
        await mutate(runKey(runId), run, { revalidate: false });
        await mutate(RUNS_KEY);
        return run;
      } finally {
        setAborting(false);
      }
    },
    [mutate],
  );

  return { abortRow, isAborting };
}

/** 代码改动：**按需**（只在抽屉打开时拉）——服务端每次都要现场跑 git 算 diff（spec §7.2） */
export function useRowDiff(
  runId: string,
  rowId: string,
  enabled: boolean,
): { diff: RowDiff | undefined; error: unknown; isLoading: boolean } {
  const { data, error, isLoading } = useSWR<RowDiff>(
    enabled && runId !== '' && rowId !== '' ? runRowUrl(runId, rowId, 'diff') : null,
    getJson,
  );
  return { diff: data, error, isLoading };
}

/** 执行日志全量：抽屉首帧与「下载」共用（下载要的是完整落盘内容，不依赖长连接是否活着） */
export function useRowLog(
  runId: string,
  rowId: string,
  enabled: boolean,
): { events: AgentEvent[] | undefined; error: unknown; isLoading: boolean } {
  const { data, error, isLoading } = useSWR<AgentEvent[]>(
    enabled && runId !== '' && rowId !== '' ? runRowUrl(runId, rowId, 'log') : null,
    getJson,
  );
  return { events: data, error, isLoading };
}

/** 空池的稳定引用：每次返回新数组会让表单的 Select options 每帧重建 */
const EMPTY_OPTIONS: AgentModelOption[] = [];

/** 未知 kind 的能力默认值：按「都支持」处理（多给一个终止按钮，比无端禁用安全） */
const OPTIMISTIC_CAPABILITY = { usage: true, cancelMidTurn: true } as const;

/**
 * 候选池 + 能力元数据（见计划「修正 2/3」）。一次取全三个 kind：
 * 创建表单要按行的智能体过滤模型池，候选卡片要 `usage` / `cancelMidTurn`，
 * 两者同源，分两次请求只会让「同一个 kind 的两份元数据」有机会不一致。
 */
export function useRunModelOptions(): {
  optionsFor: (agentKind: AgentKind) => AgentModelOption[];
  capabilityOf: (agentKind: AgentKind) => { usage: boolean; cancelMidTurn: boolean };
  isLoading: boolean;
  error: unknown;
} {
  const { data, error, isLoading } = useSWR<AgentOptionGroup[]>(AGENT_OPTIONS_KEY, getJson);
  const byKind = useMemo(
    () => new Map((data ?? []).map((group) => [group.agentKind, group])),
    [data],
  );

  const optionsFor = useCallback(
    (agentKind: AgentKind): AgentModelOption[] => byKind.get(agentKind)?.options ?? EMPTY_OPTIONS,
    [byKind],
  );
  const capabilityOf = useCallback(
    (agentKind: AgentKind): { usage: boolean; cancelMidTurn: boolean } => {
      const group = byKind.get(agentKind);
      return group === undefined
        ? OPTIMISTIC_CAPABILITY
        : { usage: group.usage, cancelMidTurn: group.cancelMidTurn };
    },
    [byKind],
  );

  return { optionsFor, capabilityOf, isLoading, error };
}
```

- [ ] **Step 5: 追加 `packages/client/client/src/index.ts` 的导出**

```ts
/** client 公共出口：数据获取 hooks 与 HTTP 原语。类型全部来自 contracts。 */
export { delJson, getJson, postJson, putJson } from './http';
export { useSettings } from './settings';
export {
  AGENT_OPTIONS_KEY,
  RUNS_KEY,
  runKey,
  runRowUrl,
  useAbortRow,
  useAbortRun,
  useCreateRun,
  useRowDiff,
  useRowLog,
  useRun,
  useRunModelOptions,
  useRuns,
  useStartRun,
  type AgentModelOption,
  type AgentOptionGroup,
} from './runs';
```

- [ ] **Step 6: 跑测试确认通过**

Run: `pnpm --filter @aieval/client test`
Expected: PASS（10 条用例）。

Run: `pnpm typecheck`
Expected: 零错误。

- [ ] **Step 7: 提交**

```bash
git add packages/client/client/src/runs.ts packages/client/client/src/runs.test.tsx packages/client/client/src/testing/run-fixtures.ts packages/client/client/src/index.ts
git commit -m "feat(client): 评测数据层（列表轮询开关/四个动作/产物按需读取/候选池）"
```

---

## Task 5: `client` —— `useRowStream`（历史补全 + 按 `seq` 去重的 SSE 续订）

**Files:**
- Create: `packages/client/client/src/testing/event-source.ts`
- Create: `packages/client/client/src/row-stream.ts`
- Create: `packages/client/client/src/row-stream.test.tsx`
- Modify: `packages/client/client/src/index.ts`（追加导出）

**Interfaces:**
- Consumes: Task 4 的 `RUNS_KEY` / `runKey` / `runRowUrl`；p0 `@aieval/contracts` 的 `AgentEvent` / `AgentEventSchema` / `TERMINAL_ROW_STATUSES`；本包既有的 `getJson`
- Produces: `useRowStream(input: { runId: string; rowId: string; enabled: boolean }): { events: AgentEvent[]; lastSeq: number; connected: boolean; error: unknown }`、`FakeEventSource`、`installEventSourceStub()`

- [ ] **Step 1: 写 `EventSource` 替身 `packages/client/client/src/testing/event-source.ts`**

```ts
/**
 * 测试用的 `EventSource` 替身 + 安装助手。
 *
 * 为什么需要它：jsdom **没有实现 `EventSource`**（已核对 jsdom 25 的
 * `lib/jsdom/living/interfaces.js`：有 `WebSocket`、没有 `EventSource`），
 * 而这里要测的正是「首帧拉 /log → 接 /stream → 去重 → 终态关连接」这条链路。
 *
 * 为什么不放进共享 `src/testing/setup.ts`：`useRowStream` 有一条「环境不支持 EventSource 时
 * 退化为只读历史」的兜底分支，全局注入替身会让那条分支在测试里**永远不可达**
 * （与 `resize-observer.ts` 刻意不共享是同一个理由）。需要的用例自己调用本助手。
 *
 * 替身只忠实于本仓用到的部分：构造 / `onopen` / `onmessage` / `onerror` / `close`。
 * 它**不实现** `addEventListener` / `removeEventListener`——被测 hook 用的是 `on*` 属性赋值，
 * 这条约束写在 hook 的文件头里（换实现时两边一起改）。
 */
import { vi } from 'vitest';

/** 可观测的 `EventSource` 替身：记录 URL、`close()` 次数，并允许用例手动投递帧 */
export class FakeEventSource {
  /** 本文件内创建过的全部实例（按创建顺序）——断言「重连/换行时旧连接被关掉」靠它 */
  static readonly instances: FakeEventSource[] = [];

  /** 清空实例记录：放在 `beforeEach` 里，让每个用例只看自己创建的实例 */
  static reset(): void {
    FakeEventSource.instances.length = 0;
  }

  readonly url: string;
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  /** `close()` 调用次数：终态关流与卸载清理都要能被看见 */
  closeCount = 0;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  close(): void {
    this.closeCount += 1;
    this.readyState = 2;
  }

  /** 用例驱动：模拟服务端推来一帧（参数就是 SSE 的 data 行内容，即一条 AgentEvent 的 JSON） */
  emit(data: string): void {
    this.onmessage?.({ data } as MessageEvent<string>);
  }

  /** 用例驱动：连接建立 / 断开 */
  emitOpen(): void {
    this.readyState = 1;
    this.onopen?.(new Event('open'));
  }

  emitError(): void {
    this.onerror?.(new Event('error'));
  }
}

/** 把替身装成全局 `EventSource`（`afterEach` 里用 `vi.unstubAllGlobals()` 解除） */
export function installEventSourceStub(): void {
  vi.stubGlobal('EventSource', FakeEventSource);
}
```

- [ ] **Step 2: 写失败测试 `packages/client/client/src/row-stream.test.tsx`**

```tsx
/**
 * useRowStream：抽屉一打开就要有完整历史，然后按 seq 增量续订，终端态关连接并刷一次快照。
 *
 * 四个用例是本组件的全部风险面：
 *   1. 顺序必须是「先 /log 再 /stream」，且 /stream 的 afterSeq 等于 /log 的最大 seq；
 *   2. **同一 seq 出现两次只能留一条**（重连、代理重放、/log 与 SSE 在边界上重叠都会造成重复）；
 *   3. 终态后关连接 + mutate 一次快照（否则「跑完了界面还显示执行中」）；
 *   4. 环境没有 EventSource 时不能抛：历史照旧显示，连接状态如实为「未连接」。
 */
import { createElement, type ReactNode } from 'react';
import { SWRConfig } from 'swr';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useRowStream } from './row-stream';
import { useRun, useRuns } from './runs';
import { FakeEventSource, installEventSourceStub } from './testing/event-source';
import { makeEvent, makeRun } from './testing/run-fixtures';

const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(SWRConfig, { value: { provider: () => new Map() } }, children);

/** /log 的假响应；快照端点返回一轮真实形状的评测（其余请求 404） */
function stubFetch(history: unknown[]): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (url: string) => {
    const target = String(url);
    if (target.endsWith('/log')) return new Response(JSON.stringify(history), { status: 200 });
    if (target === '/api/runs') return new Response(JSON.stringify([makeRun({ status: 'running' })]), { status: 200 });
    if (target === '/api/runs/run-1') return new Response(JSON.stringify(makeRun({ status: 'running' })), { status: 200 });
    return new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: '不存在' } }), { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => {
  FakeEventSource.reset();
  installEventSourceStub();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useRowStream', () => {
  it('先拉 /log 补历史，再按最后一条的 seq 接 /stream', async () => {
    stubFetch([makeEvent({ seq: 1 }), makeEvent({ seq: 2 }), makeEvent({ seq: 3 })]);

    const { result } = renderHook(() => useRowStream({ runId: 'run-1', rowId: 'w-1', enabled: true }), { wrapper });

    await waitFor(() => expect(result.current.events).toHaveLength(3));
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0]?.url).toBe('/api/runs/run-1/rows/w-1/stream?afterSeq=3');
    expect(result.current.lastSeq).toBe(3);

    await act(async () => {
      FakeEventSource.instances[0]?.emitOpen();
    });
    expect(result.current.connected).toBe(true);
  });

  it('按 seq 去重：同一序号来两次只留一条（重连与边界重叠都会重复投递）', async () => {
    stubFetch([makeEvent({ seq: 1 }), makeEvent({ seq: 2 }), makeEvent({ seq: 3 })]);

    const { result } = renderHook(() => useRowStream({ runId: 'run-1', rowId: 'w-1', enabled: true }), { wrapper });
    await waitFor(() => expect(result.current.events).toHaveLength(3));

    const source = FakeEventSource.instances[0];
    await act(async () => {
      // 重连后服务端把边界那条又推了一遍
      source?.emit(JSON.stringify(makeEvent({ seq: 3 })));
      // 再推一条新的
      source?.emit(JSON.stringify(makeEvent({ seq: 4 })));
    });

    expect(result.current.events.map((event) => event.seq)).toEqual([1, 2, 3, 4]);
    expect(result.current.lastSeq).toBe(4);
  });

  it('乱序到达也按 seq 归位（日志视图是顺序追加的，不能倒着长）', async () => {
    stubFetch([makeEvent({ seq: 1 })]);

    const { result } = renderHook(() => useRowStream({ runId: 'run-1', rowId: 'w-1', enabled: true }), { wrapper });
    await waitFor(() => expect(result.current.events).toHaveLength(1));

    await act(async () => {
      FakeEventSource.instances[0]?.emit(JSON.stringify(makeEvent({ seq: 3 })));
      FakeEventSource.instances[0]?.emit(JSON.stringify(makeEvent({ seq: 2 })));
    });

    expect(result.current.events.map((event) => event.seq)).toEqual([1, 2, 3]);
  });

  it('终态事件后关连接，并刷一次快照与列表', async () => {
    const fetchMock = stubFetch([makeEvent({ seq: 1 })]);

    // 终态刷新的是**别人的**两个键（详情与列表）：先把这两个消费者挂上，
    // 它们的键才有 fetcher——否则全局 mutate 找不到 fetcher，请求根本不会发出（真实页面里它们一定在）
    renderHook(() => useRuns(), { wrapper });
    renderHook(() => useRun('run-1'), { wrapper });
    renderHook(() => useRowStream({ runId: 'run-1', rowId: 'w-1', enabled: true }), { wrapper });
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const before = fetchMock.mock.calls.length;

    await act(async () => {
      FakeEventSource.instances[0]?.emit(JSON.stringify(makeEvent({ seq: 2, type: 'end', exitReason: 'completed' })));
    });

    expect(FakeEventSource.instances[0]?.closeCount).toBe(1);
    await waitFor(() => {
      const urls = fetchMock.mock.calls.slice(before).map(([url]) => String(url));
      // 卡片上的分数/耗时/diff 摘要都在快照里，不刷就永远停在「执行中」
      expect(urls).toContain('/api/runs/run-1');
      expect(urls).toContain('/api/runs');
    });
  });

  it('无法解析的帧被跳过，不影响后续帧', async () => {
    stubFetch([makeEvent({ seq: 1 })]);

    const { result } = renderHook(() => useRowStream({ runId: 'run-1', rowId: 'w-1', enabled: true }), { wrapper });
    await waitFor(() => expect(result.current.events).toHaveLength(1));

    await act(async () => {
      FakeEventSource.instances[0]?.emit('这不是 JSON');
      FakeEventSource.instances[0]?.emit(JSON.stringify({ seq: 9, at: 'x', type: '不存在的类型' }));
      FakeEventSource.instances[0]?.emit(JSON.stringify(makeEvent({ seq: 2 })));
    });

    expect(result.current.events.map((event) => event.seq)).toEqual([1, 2]);
    expect(result.current.error).not.toBeNull();
  });

  it('连接出错时把 connected 置回 false 并给出原因', async () => {
    stubFetch([makeEvent({ seq: 1 })]);

    const { result } = renderHook(() => useRowStream({ runId: 'run-1', rowId: 'w-1', enabled: true }), { wrapper });
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));

    await act(async () => {
      FakeEventSource.instances[0]?.emitOpen();
    });
    expect(result.current.connected).toBe(true);

    await act(async () => {
      FakeEventSource.instances[0]?.emitError();
    });
    expect(result.current.connected).toBe(false);
    expect(result.current.error).not.toBeNull();
  });

  it('环境没有 EventSource 时退化为只读历史，不抛错', async () => {
    // 显式 stub 成 undefined：不依赖「当前环境恰好没有」（Node 24 起自带 EventSource，
    // 是否透传到 jsdom 环境取决于版本）——兜底分支必须在任何环境下都可达
    vi.stubGlobal('EventSource', undefined);
    stubFetch([makeEvent({ seq: 1 }), makeEvent({ seq: 2 })]);

    const { result } = renderHook(() => useRowStream({ runId: 'run-1', rowId: 'w-1', enabled: true }), { wrapper });

    await waitFor(() => expect(result.current.events).toHaveLength(2));
    expect(result.current.connected).toBe(false);
    expect(result.current.error).not.toBeNull();
  });

  it('enabled=false 时既不发请求也不建连接', async () => {
    const fetchMock = stubFetch([makeEvent({ seq: 1 })]);

    renderHook(() => useRowStream({ runId: 'run-1', rowId: 'w-1', enabled: false }), { wrapper });
    await act(async () => {
      await Promise.resolve();
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it('换到另一行时关掉旧连接并从零开始', async () => {
    stubFetch([makeEvent({ seq: 1 })]);

    const { result, rerender } = renderHook(
      ({ rowId }: { rowId: string }) => useRowStream({ runId: 'run-1', rowId, enabled: true }),
      { wrapper, initialProps: { rowId: 'w-1' } },
    );
    await waitFor(() => expect(result.current.events).toHaveLength(1));

    rerender({ rowId: 'w-2' });

    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(2));
    expect(FakeEventSource.instances[0]?.closeCount).toBe(1);
    expect(FakeEventSource.instances[1]?.url).toContain('/rows/w-2/stream');
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `pnpm --filter @aieval/client test`
Expected: FAIL —— `Failed to resolve import "./row-stream" from "src/row-stream.test.tsx". Does the file exist?`

- [ ] **Step 4: 写实现 `packages/client/client/src/row-stream.ts`**

```ts
/**
 * 一行的实时事件流：`/log` 补历史 + `/stream` 按 seq 续订。
 * 四条口径（spec §8 的 SSE 订阅行为要求）：
 *   1. **首帧先拉 `/log`**：抽屉一打开就要有完整历史，不必等 SSE 从 seq 0 重放一遍；
 *   2. 用 `afterSeq=lastSeq` 接 `/stream`：服务端只推新的；断线重连由浏览器自带，
 *      它会带上 `Last-Event-ID`，服务端优先用它（见路由 Task 10）；
 *   3. **按 seq 去重**：重连、代理重放、以及「/log 与 SSE 在边界上重叠」都会造成重复投递，
 *      不去重日志里就会出现两遍同一行；
 *   4. 行进入终态就关连接并 **mutate 一次快照**（spec §8.3）：卡片上的分数/耗时/diff 摘要
 *      都来自快照，不刷新就只能等下一次轮询，界面会「明明跑完了还显示执行中」。
 *
 * 实现约定：连接用 `onopen` / `onmessage` / `onerror` 属性赋值（不是 addEventListener）——
 * 测试用的 `EventSource` 替身只实现这三个属性（见 testing/event-source.ts），
 * 换实现时两边要一起改。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useSWRConfig } from 'swr';
import { AgentEventSchema, TERMINAL_ROW_STATUSES, type AgentEvent } from '@aieval/contracts';
import { getJson } from './http';
import { RUNS_KEY, runKey, runRowUrl } from './runs';

/** 一条事件是不是「这一行已经结束」：`end` 事件与终态 `status` 事件都算（与 api 侧同一口径） */
function isTerminalEvent(event: AgentEvent): boolean {
  if (event.type === 'end') return true;
  return event.type === 'status' && TERMINAL_ROW_STATUSES.includes(event.status);
}

/** 帧解析：坏帧返回 null（调用方跳过它），绝不让一个畸形帧把整条流打断 */
function parseFrame(data: string): AgentEvent | null {
  let raw: unknown;
  try {
    raw = JSON.parse(data);
  } catch {
    return null;
  }
  const parsed = AgentEventSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export function useRowStream(input: { runId: string; rowId: string; enabled: boolean }): {
  events: AgentEvent[];
  lastSeq: number;
  connected: boolean;
  error: unknown;
} {
  const { runId, rowId, enabled } = input;
  const { mutate } = useSWRConfig();
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<unknown>(null);
  // 已见过的 seq 与「是否还在监听」都放 ref：SSE 回调不是渲染函数，
  // 读 state 会读到闭包里的旧值（去重会因此失效）
  const seenRef = useRef<Set<number>>(new Set());

  useEffect(() => {
    if (!enabled || runId === '' || rowId === '') return;

    let cancelled = false;
    let source: EventSource | null = null;
    // 换到另一行时必须丢掉上一行的事件与去重记录，否则新行的 seq 会被当成重复而全部丢弃
    seenRef.current = new Set();
    setEvents([]);
    setConnected(false);
    setError(null);

    /** 合并一批事件：按 seq 去重 + 保持升序 */
    const merge = (incoming: AgentEvent[]): void => {
      if (cancelled) return;
      const fresh = incoming.filter((event) => !seenRef.current.has(event.seq));
      if (fresh.length === 0) return;
      for (const event of fresh) seenRef.current.add(event.seq);
      setEvents((prev) => [...prev, ...fresh].sort((a, b) => a.seq - b.seq));
    };

    /** 终态之后刷一次快照与列表：卡片上的分数、耗时、diff 摘要都在快照里 */
    const refreshSnapshot = async (): Promise<void> => {
      await mutate(runKey(runId));
      await mutate(RUNS_KEY);
    };

    const stop = (): void => {
      if (source === null) return;
      source.close();
      source = null;
      setConnected(false);
    };

    const connect = (afterSeq: number): void => {
      // 环境没有 EventSource（老浏览器 / 测试）时不能抛：历史仍然可用，只是不再实时
      if (typeof EventSource === 'undefined') {
        setError(new Error('当前环境不支持 EventSource：只能查看已落盘的日志，无法实时追加'));
        return;
      }
      const next = new EventSource(`${runRowUrl(runId, rowId, 'stream')}?afterSeq=${afterSeq}`);
      source = next;
      next.onopen = () => {
        setConnected(true);
        setError(null);
      };
      next.onerror = () => {
        // 浏览器会自动重连（带 Last-Event-ID），这里如实反映状态即可
        setConnected(false);
        setError(new Error('实时日志连接中断：浏览器会自动重连，已收到的日志不受影响'));
      };
      next.onmessage = (event: MessageEvent) => {
        if (cancelled) return;
        const parsed = parseFrame(String(event.data));
        if (parsed === null) {
          setError(new Error('收到无法解析的事件帧，已跳过'));
          return;
        }
        merge([parsed]);
        if (isTerminalEvent(parsed)) {
          stop();
          void refreshSnapshot();
        }
      };
    };

    void (async () => {
      try {
        const history = await getJson<AgentEvent[]>(runRowUrl(runId, rowId, 'log'));
        if (cancelled) return;
        merge(history);
        connect(history.reduce((max, event) => Math.max(max, event.seq), 0));
      } catch (cause) {
        // /log 都拿不到（例如行 id 不存在）就不必接 SSE 了：接上也只会立刻收到错误
        if (!cancelled) {
          setError(cause);
          setConnected(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      stop();
    };
  }, [enabled, runId, rowId, mutate]);

  const lastSeq = useMemo(() => events.reduce((max, event) => Math.max(max, event.seq), 0), [events]);

  return { events, lastSeq, connected, error };
}
```

- [ ] **Step 5: 追加 `packages/client/client/src/index.ts` 的导出**

在上一任务的导出块后面追加：

```ts
export { useRowStream } from './row-stream';
```

- [ ] **Step 6: 跑测试确认通过**

Run: `pnpm --filter @aieval/client test`
Expected: PASS（Task 4 的 10 条 + 本任务的 9 条）。

Run: `pnpm typecheck`
Expected: 零错误。

- [ ] **Step 7: 变异验证 —— SSE 重连后必须按 `seq` 去重（守卫二）**

先记下哈希：

```powershell
(Get-FileHash packages/client/client/src/row-stream.ts -Algorithm SHA256).Hash
```

制造变异体：把 `merge` 里的去重整段去掉——`const fresh = incoming;`（不再按 `seenRef` 过滤）。

Run: `pnpm --filter @aieval/client test`
Expected: FAIL —— 至少 2 条失败：
- `按 seq 去重：同一序号来两次只留一条`：`expected [1, 2, 3, 3, 4] to deeply equal [1, 2, 3, 4]`；
- `乱序到达也按 seq 归位`：`expected [1, 3, 3, 2] to deeply equal [1, 2, 3]`（sort 后是 `[1, 2, 3, 3]`）。

还原 `const fresh = incoming.filter((event) => !seenRef.current.has(event.seq));`，再核对哈希：

```powershell
(Get-FileHash packages/client/client/src/row-stream.ts -Algorithm SHA256).Hash
```

Expected: 与变异前逐字相同。重跑 `pnpm --filter @aieval/client test` 确认回到全绿。

- [ ] **Step 8: 提交**

```bash
git add packages/client/client/src/row-stream.ts packages/client/client/src/row-stream.test.tsx packages/client/client/src/testing/event-source.ts packages/client/client/src/index.ts
git commit -m "feat(client): useRowStream（/log 补历史 + seq 去重续订 + 终态关连接刷新快照）"
```

---

## Task 6: `ui` —— base 四件套（`MonoText` / `ScoreBars` / `RowStatusTag` / `MetricLine`）

**Files:**
- Create: `packages/client/ui/src/base/mono-text.tsx`（+ `.test.tsx`）
- Create: `packages/client/ui/src/base/score-bars.tsx`（+ `.test.tsx`）
- Create: `packages/client/ui/src/base/row-status-tag.tsx`（+ `.test.tsx`）
- Create: `packages/client/ui/src/base/metric-line.tsx`（+ `.test.tsx`）
- Modify: `packages/client/ui/src/index.ts`（追加导出）

**Interfaces:**
- Consumes: p0 `@aieval/contracts` 的 `EvalRowStatus` / `ROW_STATUS_LABELS` / `DimensionScore` / `ScoreResult`；脚手架既有的 `theme.useToken()` 口径与 `format.ts` 的排版风格
- Produces: `MonoText({ text, maxHeight?, autoScroll?, dataTestId? })`、`ScoreBars({ dimensions, compact? })`、`RowStatusTag({ status })`、`ROW_STATUS_COLORS`、`MetricLine({ tokens, turns, durationMs, score, usageUnsupported? })`、`formatCount(value)`、`formatDuration(ms)`

- [ ] **Step 1: 写失败测试 `packages/client/ui/src/base/metric-line.test.tsx`**

```tsx
/**
 * MetricLine：计量摘要。**本文件是「null 不是 0」这条口径的主守卫**（spec §5.6.3）。
 * 两个方向都要钉住：
 *   · `null`（没采到 / 采集不到）→ 显示「未采集」或「不支持计量」，**不得出现 0**；
 *   · 真实的 `0`（例如 0 轮）→ 照常显示 0，不得被当成「没采到」吃掉。
 * 只钉一个方向的守卫是没用的：把 null 渲染成 0 与把 0 渲染成「未采集」都会让使用者读错。
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MetricLine, formatCount, formatDuration } from './metric-line';

/** 最小可用的 ScoreResult：只用到 totalScore */
const score = {
  dimensions: [],
  totalScore: 87,
  verdict: '整体可用',
  raw: '{}',
  judgeProviderId: 'p-1',
  judgeModelId: 'claude-opus-4-6',
  judgedAt: '2026-09-22T08:10:00.000Z',
};

describe('MetricLine', () => {
  it('计量为 null 时显示「未采集」，绝不显示成 0', () => {
    render(<MetricLine tokens={null} turns={null} durationMs={null} score={null} />);

    expect(screen.getByText('tok 未采集')).toBeInTheDocument();
    expect(screen.getByText('轮次 未采集')).toBeInTheDocument();
    expect(screen.getByText('耗时 未采集')).toBeInTheDocument();
    expect(screen.getByText('得分 未评分')).toBeInTheDocument();
    // 这一行是变异验证的靶子：把 null 当 0 渲染的实现会在这里失败
    expect(screen.queryByText('tok 0')).toBeNull();
    expect(screen.queryByText('轮次 0')).toBeNull();
  });

  it('该智能体不支持计量时文案是「不支持计量」，与「未采集」区分开', () => {
    render(<MetricLine tokens={null} turns={5} durationMs={1000} score={null} usageUnsupported />);

    expect(screen.getByText('tok 不支持计量')).toBeInTheDocument();
    expect(screen.queryByText('tok 未采集')).toBeNull();
  });

  it('真实的 0 照常显示成 0（0 轮不是「没采到」）', () => {
    render(<MetricLine tokens={{ input: 0, cached: 0, output: 0 }} turns={0} durationMs={0} score={score} />);

    expect(screen.getByText('tok 0')).toBeInTheDocument();
    expect(screen.getByText('轮次 0')).toBeInTheDocument();
    expect(screen.getByText('耗时 0s')).toBeInTheDocument();
    expect(screen.getByText('得分 87')).toBeInTheDocument();
  });

  it('token 只累加输入与输出（缓存读是输入的一部分，加进去会重复计数）', () => {
    render(<MetricLine tokens={{ input: 1000, cached: 200, output: 500 }} turns={3} durationMs={1000} score={null} />);

    // 1,000 + 500 = 1,500：+200 的缓存读不得被算进来
    expect(screen.getByText('tok 1,500')).toBeInTheDocument();
  });
});

describe('formatDuration', () => {
  it.each([
    [0, '0s'],
    [-5, '0s'],
    [Number.NaN, '0s'],
    [45_000, '45s'],
    [383_000, '6m23s'],
    [3_600_000, '1h00m'],
    [3_930_000, '1h05m'],
  ])('%i ms → %s', (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected);
  });
});

describe('formatCount', () => {
  it('按千分位分组', () => {
    expect(formatCount(128_450)).toBe('128,450');
    expect(formatCount(0)).toBe('0');
  });
});
```

> `tooltip` 的断言写法说明：antd 的 Tooltip 在 jsdom 里不会渲染出浮层（要靠 hover + motion），所以这里把断言收敛到「宿主文本正确」这一条；明细内容由 `MetricLine` 的 Tooltip 承载，属浏览器里的常规交互（冒烟第 8 项读详情时顺手 hover 一下 `tok` 文本即可复核，不单独列项）。

- [ ] **Step 2: 写失败测试 `packages/client/ui/src/base/row-status-tag.test.tsx`**

```tsx
/**
 * RowStatusTag：10 个行状态 → Tag 文案与颜色。
 * 守的是 spec §5.4 那句「状态语义必须可区分，不能合并」：把两个状态映成同一个颜色，
 * 使用者就只能逐字读才能分清，扫一眼列表看不出差别——所以颜色表要**两两不同**。
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { EvalRowStatusSchema, ROW_STATUS_LABELS } from '@aieval/contracts';
import { ROW_STATUS_COLORS, RowStatusTag } from './row-status-tag';

describe('RowStatusTag', () => {
  it('每个状态都渲染 contracts 里的中文文案', () => {
    for (const status of EvalRowStatusSchema.options) {
      const view = render(<RowStatusTag status={status} />);
      expect(screen.getByText(ROW_STATUS_LABELS[status])).toBeInTheDocument();
      view.unmount();
    }
  });

  it('10 个状态的颜色两两不同（不许把状态合并成同色）', () => {
    const statuses = EvalRowStatusSchema.options;
    expect(Object.keys(ROW_STATUS_COLORS).sort()).toEqual([...statuses].sort());
    expect(new Set(Object.values(ROW_STATUS_COLORS)).size).toBe(statuses.length);
  });
});
```

- [ ] **Step 3: 写失败测试 `packages/client/ui/src/base/score-bars.test.tsx`**

```tsx
/**
 * ScoreBars：5 维度评分条。
 * compact 只留条与分数、不显示理由——卡片里塞五段理由会把卡片撑成半屏，扫不出重点。
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ScoreBars } from './score-bars';

const dimensions = [
  { key: 'correctness' as const, label: '功能正确性', score: 5, reason: '转换覆盖了三种方言' },
  { key: 'requirement' as const, label: '需求完成度', score: 4, reason: '少了一条边界用例' },
  { key: 'quality' as const, label: '代码质量', score: 4, reason: '命名清晰' },
  { key: 'robustness' as const, label: '健壮性与边界', score: 3, reason: '未处理空响应' },
  { key: 'maintainability' as const, label: '可维护性（改动范围合理）', score: 5, reason: '只动了目标文件' },
];

describe('ScoreBars', () => {
  it('5 个维度都渲染出标签、分数与理由', () => {
    render(<ScoreBars dimensions={dimensions} />);

    for (const dimension of dimensions) {
      expect(screen.getByText(dimension.label)).toBeInTheDocument();
      expect(screen.getByText(dimension.reason)).toBeInTheDocument();
    }
    expect(screen.getByText('5/5')).toBeInTheDocument();
    expect(screen.getAllByText('4/5')).toHaveLength(2);
    expect(screen.getByText('3/5')).toBeInTheDocument();
  });

  it('compact 时不渲染理由（只留条与分数）', () => {
    render(<ScoreBars dimensions={dimensions} compact />);

    expect(screen.getByText('功能正确性')).toBeInTheDocument();
    expect(screen.queryByText('转换覆盖了三种方言')).toBeNull();
  });

  it('空数组不崩（维度缺失的行不会走到这里，但组件不该假设一定有 5 条）', () => {
    const { container } = render(<ScoreBars dimensions={[]} />);
    expect(container.firstChild).not.toBeNull();
  });
});
```

- [ ] **Step 4: 写失败测试 `packages/client/ui/src/base/mono-text.test.tsx`**

```tsx
/**
 * MonoText：等宽文本块 + 尾部自动滚动。
 * **注意 jsdom 没有布局引擎**：`scrollHeight` 恒为 0，直接断言 `scrollTop` 会把
 * 「压根不滚动」的实现也判成通过（`0 === 0`）。所以用例把元素的 `scrollHeight`
 * 用 defineProperty 顶成 720，让「滚到底」这件事在数值上可见；
 * 反向用例先把 `scrollTop` 设成 123，看它会不会被**错误地**重置。
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MonoText } from './mono-text';

describe('MonoText', () => {
  it('文本变化时把宿主滚到底（autoScroll 打开）', () => {
    const { rerender } = render(<MonoText text="第一行" autoScroll dataTestId="log-text" />);
    const host = screen.getByTestId('log-text');
    Object.defineProperty(host, 'scrollHeight', { value: 720, configurable: true });

    rerender(<MonoText text={'第一行\n第二行'} autoScroll dataTestId="log-text" />);

    expect(host.scrollTop).toBe(720);
  });

  it('autoScroll 关闭时不碰滚动位置（用户往上翻的动作不能被按回去）', () => {
    const { rerender } = render(<MonoText text="第一行" dataTestId="log-text" />);
    const host = screen.getByTestId('log-text');
    Object.defineProperty(host, 'scrollHeight', { value: 720, configurable: true });
    host.scrollTop = 123;

    rerender(<MonoText text={'第一行\n第二行'} dataTestId="log-text" />);

    expect(host.scrollTop).toBe(123);
  });

  it('maxHeight 落到宿主的限高上，且文本保留换行', () => {
    render(<MonoText text={'a\nb'} maxHeight={240} dataTestId="log-text" />);

    const host = screen.getByTestId('log-text');
    expect(host.style.maxHeight).toBe('240px');
    expect(host.style.whiteSpace).toBe('pre-wrap');
    expect(host.style.overflow).toBe('auto');
  });
});
```

> 上面第二条用例的 `scrollHeight` 必须**在 `rerender` 之前**定义：`autoScroll` 的效果依赖 `text`，重渲染才会触发那次「滚到底」。

- [ ] **Step 5: 跑测试确认失败**

Run: `pnpm --filter @aieval/ui test`
Expected: FAIL —— 四份用例都在收集阶段报 `Failed to resolve import "./metric-line"`（及 `./row-status-tag` / `./score-bars` / `./mono-text`）。

- [ ] **Step 6: 写实现 `packages/client/ui/src/base/mono-text.tsx`**

```tsx
'use client';

/**
 * 等宽文本块：执行日志、diff 正文、模型原始返回共用。
 * 两个注意点：
 *   1. 自动滚底只在**文本变化时**执行一次（不是每次渲染）——每次渲染都滚会把用户往上翻的动作按回去；
 *   2. 滚动用 `host.scrollTop = host.scrollHeight`，不用 `scrollTo`：后者在 jsdom 里不可达，
 *      而这条分支正是要能被测到的那条（见 mono-text.test.tsx 的说明）。
 * 等宽字体取自 antd 的 `token.fontFamilyCode`，不手写字体名（与全站「样式走 antd」一致）。
 */
import { Flex, theme, Typography } from 'antd';
import { useEffect, useRef, type ReactNode } from 'react';

export interface MonoTextProps {
  text: string;
  /** 限高（px）；不传则由父容器决定 */
  maxHeight?: number;
  /** 尾部自动滚动（日志抽屉默认打开，由调用方的开关控制） */
  autoScroll?: boolean;
  /** 宿主的 data-testid：滚动与几何断言都靠它定位 */
  dataTestId?: string;
}

export function MonoText({ text, maxHeight, autoScroll = false, dataTestId }: MonoTextProps): ReactNode {
  const { token } = theme.useToken();
  const hostRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!autoScroll || host === null) return;
    host.scrollTop = host.scrollHeight;
  }, [autoScroll, text]);

  return (
    <Flex
      ref={hostRef}
      vertical
      data-testid={dataTestId}
      style={{
        fontFamily: token.fontFamilyCode,
        whiteSpace: 'pre-wrap',
        overflow: 'auto',
        ...(maxHeight === undefined ? {} : { maxHeight }),
      }}
    >
      <Typography.Text style={{ whiteSpace: 'pre-wrap' }}>{text}</Typography.Text>
    </Flex>
  );
}
```

- [ ] **Step 7: 写实现 `packages/client/ui/src/base/score-bars.tsx`**

```tsx
'use client';

/**
 * 5 维度评分条：标签 + 条 + 分数（+ 理由）。
 * compact 用于候选卡片（只留条与分数）；评分详情里给完整形态（带每维理由）。
 * 维度标签与顺序都来自 contracts 的 `DIMENSIONS`（由 p4 落进 ScoreResult.dimensions），
 * 本组件不重新排序、也不补齐缺失维度——没拿到的维度不显示，比伪造一个 0 分诚实。
 */
import { Flex, Progress, Typography } from 'antd';
import type { ReactNode } from 'react';
import type { DimensionScore } from '@aieval/contracts';

export interface ScoreBarsProps {
  dimensions: DimensionScore[];
  /** 紧凑形态：不显示理由 */
  compact?: boolean;
}

/** 每维 1–5 分 → Progress 的百分比（5 分 = 100%） */
function toPercent(score: number): number {
  return Math.round((score / 5) * 100);
}

export function ScoreBars({ dimensions, compact = false }: ScoreBarsProps): ReactNode {
  return (
    <Flex vertical gap={4}>
      {dimensions.map((dimension) => (
        <Flex key={dimension.key} vertical gap={2}>
          <Flex align="center" gap={8}>
            <Typography.Text style={{ minWidth: 96 }}>{dimension.label}</Typography.Text>
            <Progress percent={toPercent(dimension.score)} size="small" showInfo={false} style={{ flex: 1 }} />
            <Typography.Text strong>{dimension.score}/5</Typography.Text>
          </Flex>
          {!compact && <Typography.Text type="secondary">{dimension.reason}</Typography.Text>}
        </Flex>
      ))}
    </Flex>
  );
}
```

- [ ] **Step 8: 写实现 `packages/client/ui/src/base/row-status-tag.tsx`**

```tsx
'use client';

/**
 * 行状态 → 彩色 Tag + 中文文案。
 * 分工：**文案**在 contracts 的 `ROW_STATUS_LABELS`（契约的一部分），**颜色**在这里（界面的事）。
 * 「10 个颜色两两不同」是刻意的（spec §5.4：状态语义必须可区分）——两个状态同色时，
 * 使用者只能逐字读才能分清，扫一眼列表看不出差别。
 */
import { Tag } from 'antd';
import type { ReactNode } from 'react';
import { ROW_STATUS_LABELS, type EvalRowStatus } from '@aieval/contracts';

/** 状态 → Tag 配色（10 个值两两不同，见文件头；跑批色系与终态色系刻意分开） */
export const ROW_STATUS_COLORS: Record<EvalRowStatus, string> = {
  pending: 'default',
  preparing: 'cyan',
  running: 'processing',
  judging: 'geekblue',
  judged: 'success',
  failed: 'error',
  'timed-out': 'volcano',
  canceled: 'orange',
  skipped: 'gold',
  interrupted: 'magenta',
};

export interface RowStatusTagProps {
  status: EvalRowStatus;
}

export function RowStatusTag({ status }: RowStatusTagProps): ReactNode {
  return <Tag color={ROW_STATUS_COLORS[status]}>{ROW_STATUS_LABELS[status]}</Tag>;
}
```

- [ ] **Step 9: 写实现 `packages/client/ui/src/base/metric-line.tsx`**

```tsx
'use client';

/**
 * 一行计量摘要：token / 轮次 / 耗时 / 得分。
 * **`null` 与 `0` 必须长得不一样**（spec §5.6.3）：`null` = 没采到（显示「未采集」；
 * 该智能体根本不上报用量时显示「不支持计量」），`0` = 真的是 0（例如 0 轮）。
 * 把 `null` 渲染成 0 会让人得出「这家很省」的错误结论，比不显示更糟；
 * 反过来把真实的 0 吃掉同样会让人以为采集坏了。
 * token 只累加「输入 + 输出」：缓存读是输入的一部分，三项相加会重复计数。
 */
import { Flex, Tooltip, Typography } from 'antd';
import type { ReactNode } from 'react';
import type { ScoreResult } from '@aieval/contracts';

export interface MetricLineProps {
  tokens: { input: number; cached: number; output: number } | null;
  turns: number | null;
  durationMs: number | null;
  score: ScoreResult | null;
  /** 该智能体采不到用量（注册表 `metadata.capability.usage === false`）——文案与「未采集」不同 */
  usageUnsupported?: boolean;
}

/** 千分位：横排数字用逗号分组，扫一眼就能估量级 */
export function formatCount(value: number): string {
  return value.toLocaleString('en-US');
}

/** 毫秒 → `45s` / `6m23s` / `1h05m`；负数与非有限数按 `0s` 处理（脏值不该让界面出现 NaN） */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0s';
  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h${String(minutes).padStart(2, '0')}m`;
  if (minutes > 0) return `${minutes}m${String(seconds).padStart(2, '0')}s`;
  return `${seconds}s`;
}

export function MetricLine({
  tokens,
  turns,
  durationMs,
  score,
  usageUnsupported = false,
}: MetricLineProps): ReactNode {
  // 没采到用量时给一句明确的中文：绝不给 0
  const tokenText = tokens === null ? (usageUnsupported ? '不支持计量' : '未采集') : formatCount(tokens.input + tokens.output);
  const tokenDetail =
    tokens === null
      ? undefined
      : `输入 ${formatCount(tokens.input)} · 缓存 ${formatCount(tokens.cached)} · 输出 ${formatCount(tokens.output)}`;

  return (
    <Flex gap={16} wrap>
      <Tooltip title={tokenDetail}>
        <Typography.Text type="secondary">tok {tokenText}</Typography.Text>
      </Tooltip>
      <Typography.Text type="secondary">轮次 {turns === null ? '未采集' : formatCount(turns)}</Typography.Text>
      <Typography.Text type="secondary">耗时 {durationMs === null ? '未采集' : formatDuration(durationMs)}</Typography.Text>
      <Typography.Text type="secondary">得分 {score === null ? '未评分' : formatCount(score.totalScore)}</Typography.Text>
    </Flex>
  );
}
```

- [ ] **Step 10: 追加 `packages/client/ui/src/index.ts` 的导出**

```ts
export { MonoText, type MonoTextProps } from './base/mono-text';
export { ScoreBars, type ScoreBarsProps } from './base/score-bars';
export { ROW_STATUS_COLORS, RowStatusTag, type RowStatusTagProps } from './base/row-status-tag';
export { MetricLine, formatCount, formatDuration, type MetricLineProps } from './base/metric-line';
```

- [ ] **Step 11: 跑测试确认通过**

Run: `pnpm --filter @aieval/ui test`
Expected: PASS（四份用例全部通过；本包既有用例不受影响）。

Run: `pnpm typecheck`
Expected: 零错误。

- [ ] **Step 12: 变异验证 —— `null` 计量不得显示成 0（守卫一）**

先记下哈希：

```powershell
(Get-FileHash packages/client/ui/src/base/metric-line.tsx -Algorithm SHA256).Hash
```

制造变异体：把 `tokenText` 那一行的 `tokens === null` 分支去掉，改成恒算数值——

```tsx
const tokenText = formatCount((tokens?.input ?? 0) + (tokens?.output ?? 0));
```

Run: `pnpm --filter @aieval/ui test`
Expected: FAIL —— `metric-line.test.tsx` 的 `计量为 null 时显示「未采集」，绝不显示成 0` 失败：
`Unable to find an element with the text: tok 未采集`（页面上渲染的是 `tok 0`）。
另外 `该智能体不支持计量时文案是「不支持计量」，与「未采集」区分开` 也会失败。

还原原实现，再核对哈希：

```powershell
(Get-FileHash packages/client/ui/src/base/metric-line.tsx -Algorithm SHA256).Hash
```

Expected: 与变异前逐字相同。重跑 `pnpm --filter @aieval/ui test` 确认回到全绿。

- [ ] **Step 13: 提交**

```bash
git add packages/client/ui/src/base/mono-text.tsx packages/client/ui/src/base/mono-text.test.tsx packages/client/ui/src/base/score-bars.tsx packages/client/ui/src/base/score-bars.test.tsx packages/client/ui/src/base/row-status-tag.tsx packages/client/ui/src/base/row-status-tag.test.tsx packages/client/ui/src/base/metric-line.tsx packages/client/ui/src/base/metric-line.test.tsx packages/client/ui/src/index.ts
git commit -m "feat(ui): base 四件套（MonoText/ScoreBars/RowStatusTag/MetricLine，含 null≠0 变异验证）"
```

---

## Task 7: `ui` —— `RunCreatePanel`（创建评测表单）

**Files:**
- Create: `packages/client/ui/src/composite/run-create-panel.tsx`
- Create: `packages/client/ui/src/composite/run-create-panel.test.tsx`
- Modify: `packages/client/ui/src/index.ts`（追加导出）

**Interfaces:**
- Consumes: Task 6 的 `MetricLine`（本组件不用，但同批导出）、脚手架既有的 `format.ts` 的 `shortHash`；p0 `@aieval/contracts` 的 `AGENT_KINDS` / `AGENT_LABELS` / `TestCase` / `RunCreate` / `AgentKind`
- Produces: `RunCreatePanel({ cases, modelOptionsFor, saving, onSubmit, onCancel })`、`type RunModelOption`、`type RunCreatePanelProps`

- [ ] **Step 1: 写失败测试 `packages/client/ui/src/composite/run-create-panel.test.tsx`**

```tsx
/**
 * RunCreatePanel：用例 + 执行模式 + 候选行（Form.List）。
 * 三件事必须成立：
 *   1. 模型候选池跟着**本行的智能体**变（spec §5.1 F2）；
 *   2. 池子为空时当场内联 Alert 指出路，而不是让人选完到运行时才失败；
 *   3. 提交校验（至少一行、每行两个 Select 都选了）真的拦得住，且拦下来的请求**一个都不发**。
 *
 * jsdom 环境注意：本文件要打开 Select 的下拉（浮层定位走 @rc-component/resize-observer），
 * 而 jsdom 没有 ResizeObserver —— 必须自己装桩（桩刻意不放进共享 setup，理由见该文件）。
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { TestCase } from '@aieval/contracts';
import { installResizeObserverStub } from '../testing/resize-observer';
import { RunCreatePanel, type RunModelOption } from './run-create-panel';

beforeEach(() => {
  installResizeObserverStub();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const cases: TestCase[] = [
  {
    id: 'c-1',
    title: '多协议入站转换',
    repoPath: 'D:\\projects\\gateway',
    commitHash: '71e628091bf7134a6e677a58cc1e0f29b9302e6f',
    taskPrompt: '补齐转换',
    judgePrompt: '按 5 维打分',
    judgeProviderId: null,
    judgeModelId: null,
    createdAt: '2026-09-22T00:00:00.000Z',
    updatedAt: '2026-09-22T00:00:00.000Z',
  },
  {
    id: 'c-2',
    title: '工具名长度校验',
    repoPath: '/home/me/tool-id',
    commitHash: null,
    taskPrompt: '加校验',
    judgePrompt: '按 5 维打分',
    judgeProviderId: null,
    judgeModelId: null,
    createdAt: '2026-09-22T00:00:00.000Z',
    updatedAt: '2026-09-22T00:00:00.000Z',
  },
];

const anthropicOptions: RunModelOption[] = [
  { providerId: 'p-anthropic', providerName: 'Anthropic 网关', modelId: 'claude-opus-4-6', source: 'manual' },
];
const openaiOptions: RunModelOption[] = [
  { providerId: 'p-openai', providerName: 'OpenAI 网关', modelId: 'gpt-5', source: 'fetched' },
];

/**
 * 默认的池子：**与注册表元数据一致** —— `codex` 走 openai，`claude-code` 与 **`dsh`** 走 anthropic
 * （Task 11 实测 dsh 讲 Anthropic Messages，契约 R37；旧写法把 dsh 归进 openai 组，是错的）
 */
function poolFor(agentKind: string): RunModelOption[] {
  return agentKind === 'codex' ? openaiOptions : anthropicOptions;
}

function renderPanel(overrides: Partial<Parameters<typeof RunCreatePanel>[0]> = {}): ReturnType<typeof render> {
  return render(
    <RunCreatePanel
      cases={cases}
      modelOptionsFor={poolFor}
      saving={false}
      onSubmit={vi.fn()}
      onCancel={vi.fn()}
      {...overrides}
    />,
  );
}

/** 打开某一个下拉并按文本选中一项 */
function pickOption(labelText: string, optionText: string | RegExp): void {
  const trigger = screen.getAllByLabelText(labelText)[0];
  fireEvent.mouseDown(trigger as HTMLElement);
  fireEvent.click(screen.getByRole('option', { name: optionText }));
}

describe('RunCreatePanel', () => {
  it('用例选项显示「标题 · 仓库名 · commit 短哈希」，无 commit 时显示默认分支', () => {
    renderPanel();
    const caseSelect = screen.getAllByLabelText('用例')[0] as HTMLElement;
    fireEvent.mouseDown(caseSelect);

    expect(screen.getByRole('option', { name: '多协议入站转换 · gateway · 71e6280' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: '工具名长度校验 · tool-id · 默认分支 HEAD' })).toBeInTheDocument();
  });

  it('默认执行模式是并行，提交出去的 payload 与选择一致', async () => {
    const onSubmit = vi.fn();
    renderPanel({ onSubmit });

    pickOption('用例', '多协议入站转换 · gateway · 71e6280');
    pickOption('模型', /claude-opus-4-6/);
    fireEvent.click(screen.getByRole('button', { name: '创建评测' }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]?.[0]).toEqual({
      caseId: 'c-1',
      executionMode: 'parallel',
      rows: [{ agentKind: 'claude-code', providerId: 'p-anthropic', modelId: 'claude-opus-4-6' }],
    });
  });

  it('模型下拉只列本行智能体协议下的模型，并标出来源', () => {
    renderPanel();
    pickOption('智能体', 'Codex');

    const openaiTrigger = screen.getAllByLabelText('模型')[0] as HTMLElement;
    fireEvent.mouseDown(openaiTrigger);
    expect(screen.getByRole('option', { name: /gpt-5/ })).toBeInTheDocument();
    expect(screen.getByText('自动拉取')).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /claude-opus-4-6/ })).toBeNull();
  });

  it('候选池为空时当场内联 Alert 指出路，且提交被拦住', async () => {
    const onSubmit = vi.fn();
    renderPanel({ modelOptionsFor: () => [], onSubmit });

    expect(screen.getByText(/Claude Code 没有可选的模型/)).toBeInTheDocument();
    expect(screen.getByText(/协议匹配的供应商/)).toBeInTheDocument();

    pickOption('用例', '多协议入站转换 · gateway · 71e6280');
    fireEvent.click(screen.getByRole('button', { name: '创建评测' }));

    await waitFor(() => expect(screen.getByText('请选择模型')).toBeInTheDocument());
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('删掉唯一一行后提交：提示「至少需要一个候选行」，且不发请求', async () => {
    const onSubmit = vi.fn();
    renderPanel({ onSubmit });

    fireEvent.click(screen.getByRole('button', { name: '删除' }));
    pickOption('用例', '多协议入站转换 · gateway · 71e6280');
    fireEvent.click(screen.getByRole('button', { name: '创建评测' }));

    await waitFor(() => expect(screen.getByText('至少需要一个候选行')).toBeInTheDocument());
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('切换智能体后该行已选的模型被清空（否则会提交出协议不匹配的组合）', async () => {
    const onSubmit = vi.fn();
    renderPanel({ onSubmit });

    pickOption('用例', '多协议入站转换 · gateway · 71e6280');
    pickOption('模型', /claude-opus-4-6/);
    // 换成 openai 协议的智能体：上一行选的 anthropic 模型必须作废
    pickOption('智能体', 'Codex');
    fireEvent.click(screen.getByRole('button', { name: '创建评测' }));

    await waitFor(() => expect(screen.getByText('请选择模型')).toBeInTheDocument());
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('点取消时把 onCancel 交回去', () => {
    const onCancel = vi.fn();
    renderPanel({ onCancel });

    fireEvent.click(screen.getByRole('button', { name: '取消' }));

    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @aieval/ui test`
Expected: FAIL —— `Failed to resolve import "./run-create-panel" from "src/composite/run-create-panel.test.tsx". Does the file exist?`

- [ ] **Step 3: 写实现 `packages/client/ui/src/composite/run-create-panel.tsx`**

```tsx
'use client';

/**
 * 创建评测表单：用例 + 执行模式 + 候选行（`Form.List`）。
 * 三条口径：
 *   1. 模型候选池按**行内的智能体**过滤（spec §5.1 F2）——池子由 `modelOptionsFor` 注入，
 *      本组件里没有「哪家智能体配哪种协议」这张表（那是 agents 注册表的事，A3）；
 *   2. 池子为空时**当场**给内联 Alert 与出路，而不是等人点了创建才在服务端炸；
 *   3. 模型的 Select 值编码成 `providerId::modelId`：两个不同供应商可能有同名模型，
 *      只存 modelId 会让提交的 providerId 无解。分隔符用 `::`——UUID 不含冒号，
 *      模型名里常见的是单个 `:` 与 `/`；解析时按**第一个** `::` 切，模型名里即使含 `::` 也能还原。
 */
import { Alert, Button, Flex, Form, Radio, Select, Tag, Typography } from 'antd';
import type { ReactNode } from 'react';
import {
  AGENT_KINDS,
  AGENT_LABELS,
  type AgentKind,
  type RunCreate,
  type TestCase,
} from '@aieval/contracts';
import { shortHash } from '../base/format';

/** 候选池里的一个模型：与 api 的 `listModelOptions` 元素逐字段一致 */
export interface RunModelOption {
  providerId: string;
  providerName: string;
  modelId: string;
  source: 'fetched' | 'manual';
}

export interface RunCreatePanelProps {
  cases: TestCase[];
  /** 按智能体取候选池；返回空数组即「该智能体没有可用的模型」 */
  modelOptionsFor: (agentKind: AgentKind) => RunModelOption[];
  saving: boolean;
  onSubmit: (input: RunCreate) => void;
  onCancel: () => void;
}

/** 表单内部的行值：模型用编码值承载 (providerId, modelId) */
interface RowFormValue {
  agentKind?: AgentKind;
  modelKey?: string;
}

interface FormValues {
  caseId?: string;
  executionMode?: 'parallel' | 'serial';
  rows?: RowFormValue[];
}

/** (供应商, 模型) → Select 的值 */
function encodeModelKey(providerId: string, modelId: string): string {
  return `${providerId}::${modelId}`;
}

/** Select 的值 → (供应商, 模型)；按第一个 `::` 切，切片缺一段就返回 null（脏值不猜） */
function decodeModelKey(key: string): { providerId: string; modelId: string } | null {
  const pivot = key.indexOf('::');
  if (pivot <= 0) return null;
  return { providerId: key.slice(0, pivot), modelId: key.slice(pivot + 2) };
}

/** 仓库路径 → 仓库名：末段，兼容 Windows 反斜杠与结尾斜杠 */
function repoNameOf(repoPath: string): string {
  const trimmed = repoPath.replace(/[\\/]+$/, '');
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] ?? trimmed;
}

/** 「至少一行」（spec §5.1 的提交校验）：antd 的自定义校验器以抛错表示不通过 */
async function requireAtLeastOneRow(_rule: unknown, value: unknown): Promise<void> {
  if (Array.isArray(value) && value.length > 0) return;
  throw new Error('至少需要一个候选行');
}

export function RunCreatePanel({
  cases,
  modelOptionsFor,
  saving,
  onSubmit,
  onCancel,
}: RunCreatePanelProps): ReactNode {
  const [form] = Form.useForm<FormValues>();

  const caseOptions = cases.map((item) => ({
    value: item.id,
    // 「标题 · 仓库名 · commit 短哈希」（spec §5.1）
    label: `${item.title} · ${repoNameOf(item.repoPath)} · ${
      item.commitHash === null ? '默认分支 HEAD' : shortHash(item.commitHash)
    }`,
  }));

  const handleFinish = (values: FormValues): void => {
    const rows: RunCreate['rows'] = [];
    for (const row of values.rows ?? []) {
      const decoded = row.modelKey === undefined ? null : decodeModelKey(row.modelKey);
      // 表单规则已保证三者都有值；这里再挡一次是让「类型上可能缺失」不变成静默的坏数据
      if (row.agentKind === undefined || decoded === null) continue;
      rows.push({ agentKind: row.agentKind, providerId: decoded.providerId, modelId: decoded.modelId });
    }
    if (values.caseId === undefined || rows.length === 0) return;
    onSubmit({ caseId: values.caseId, executionMode: values.executionMode ?? 'parallel', rows });
  };

  return (
    <Form<FormValues>
      form={form}
      layout="vertical"
      size="small"
      initialValues={{ executionMode: 'parallel' }}
      onFinish={handleFinish}
    >
      <Form.Item name="caseId" label="用例" rules={[{ required: true, message: '请选择用例' }]}>
        <Select options={caseOptions} placeholder="选择要评测的用例" />
      </Form.Item>

      <Form.Item name="executionMode" label="执行模式" rules={[{ required: true, message: '请选择执行模式' }]}>
        <Radio.Group
          options={[
            { value: 'parallel', label: '并行' },
            { value: 'serial', label: '串行' },
          ]}
        />
      </Form.Item>

      <Form.List name="rows" initialValue={[{ agentKind: 'claude-code' }]} rules={[{ validator: requireAtLeastOneRow }]}>
        {(fields, { add, remove }, { errors }) => (
          <Flex vertical gap={8}>
            {fields.map((field) => (
              <Flex key={field.key} vertical gap={4}>
                <Flex gap={8} align="flex-start">
                  <Form.Item
                    name={[field.name, 'agentKind']}
                    label="智能体"
                    rules={[{ required: true, message: '请选择智能体' }]}
                  >
                    <Select
                      options={AGENT_KINDS.map((kind) => ({ value: kind, label: AGENT_LABELS[kind] }))}
                      // 换智能体必须作废本行已选的模型：否则会提交出协议不匹配的组合
                      onChange={() => {
                        form.setFieldValue(['rows', field.name, 'modelKey'], undefined);
                      }}
                    />
                  </Form.Item>

                  {/* 模型池依赖本行的 agentKind，用 shouldUpdate 订阅这一格的变化（Hook 不能写在 map 回调里） */}
                  <Form.Item
                    noStyle
                    shouldUpdate={(prev: FormValues, next: FormValues) =>
                      prev.rows?.[field.name]?.agentKind !== next.rows?.[field.name]?.agentKind
                    }
                  >
                    {({ getFieldValue }) => {
                      const agentKind = getFieldValue(['rows', field.name, 'agentKind']) as AgentKind | undefined;
                      const pool = agentKind === undefined ? [] : modelOptionsFor(agentKind);
                      return (
                        <Flex vertical gap={4} style={{ flex: 1, minWidth: 0 }}>
                          <Form.Item
                            name={[field.name, 'modelKey']}
                            label="模型"
                            rules={[{ required: true, message: '请选择模型' }]}
                          >
                            <Select
                              placeholder={pool.length === 0 ? '没有可选的模型' : '选择模型'}
                              options={pool.map((option) => ({
                                value: encodeModelKey(option.providerId, option.modelId),
                                // 来源用 Tag 区分（spec §5.1）；Select 默认不开启搜索，ReactNode 标签安全
                                label: (
                                  <Flex align="center" gap={4}>
                                    <span>{option.modelId}</span>
                                    <Tag>{option.source === 'manual' ? '手工维护' : '自动拉取'}</Tag>
                                  </Flex>
                                ),
                              }))}
                            />
                          </Form.Item>
                          {agentKind !== undefined && pool.length === 0 && (
                            <Alert
                              type="warning"
                              showIcon
                              title={`${AGENT_LABELS[agentKind]} 没有可选的模型：请到设置里添加协议匹配的供应商，并为它维护模型清单`}
                            />
                          )}
                        </Flex>
                      );
                    }}
                  </Form.Item>

                  <Button size="small" onClick={() => remove(field.name)}>
                    删除
                  </Button>
                </Flex>
              </Flex>
            ))}

            <Form.ErrorList errors={errors} />
            <Button size="small" onClick={() => add({ agentKind: 'claude-code' })}>
              添加候选
            </Button>
          </Flex>
        )}
      </Form.List>

      <Flex gap={8} style={{ marginTop: 16 }} justify="flex-end">
        <Button size="small" onClick={onCancel}>
          取消
        </Button>
        <Button size="small" type="primary" htmlType="submit" loading={saving}>
          创建评测
        </Button>
      </Flex>
    </Form>
  );
}
```

> `style={{ marginTop: 16 }}` 是为了让按钮行与最后一段表单拉开距离：antd 的 `Form.Item` 自带下边距，而按钮行不是 `Form.Item`，不补这一段会和「添加候选」贴在一起。

- [ ] **Step 4: 追加 `packages/client/ui/src/index.ts` 的导出**

```ts
export {
  RunCreatePanel,
  type RunCreatePanelProps,
  type RunModelOption,
} from './composite/run-create-panel';
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm --filter @aieval/ui test`
Expected: PASS（Task 6 的用例 + 本任务的 7 条）。

Run: `pnpm typecheck`
Expected: 零错误。

- [ ] **Step 6: 提交**

```bash
git add packages/client/ui/src/composite/run-create-panel.tsx packages/client/ui/src/composite/run-create-panel.test.tsx packages/client/ui/src/index.ts
git commit -m "feat(ui): 创建评测表单（协议过滤候选池 + 空池内联 Alert + 至少一行校验）"
```

---

## Task 8: `ui` —— `EvalRowCard` 与 `RunDetailPanel`（卡片 + 吸底栏）

**Files:**
- Create: `packages/client/ui/src/composite/eval-row-card.tsx`（+ `.test.tsx`）
- Create: `packages/client/ui/src/composite/run-detail-panel.tsx`（+ `.test.tsx`）
- Modify: `packages/client/ui/src/index.ts`（追加导出）

**Interfaces:**
- Consumes: Task 6 的 `MetricLine` / `RowStatusTag`；脚手架既有的 `EllipsisText` / `format.ts` 的 `shortHash` / `formatDateTime`；p0 `@aieval/contracts` 的 `EvalRun` / `EvalRow` / `AGENT_LABELS` / `TERMINAL_ROW_STATUSES` / `isRunnableRow` / `isRunningRow` / `AgentKind`
- Produces: `EvalRowCard({ row, rank?, queued?, capability?, onAbort, onOpenLog, onOpenDiff, onOpenScore })`、`type AgentCapabilityView`、`RunDetailPanel({ run, starting, aborting, capabilityOf?, onStart, onAbortRun, onAbortRow, onOpenLog, onOpenDiff, onOpenScore })`

> **执行顺序**：本任务有两个组件，各走一遍「写用例 → 跑一次看它失败 → 写实现」的循环
> （卡片：Step 1–3；详情面板：Step 4–5），最后 Step 6–8 一起导出、整体跑绿、提交。
> 两个组件必须同批落地：详情面板的用例要渲染真实卡片，卡片先有实现才谈得上「面板的列表排对了」。

- [ ] **Step 1: 写失败测试 `packages/client/ui/src/composite/eval-row-card.test.tsx`**

```tsx
/**
 * EvalRowCard：候选卡片。版面口径来自 spec §5.3 的 ASCII 稿；
 * 四件容易被漏掉、漏掉就会误判的事各一条用例：
 *   1. 串行排队中的行要说清「为什么会等」（不是没反应）；
 *   2. diff 被截断要标出来（这一次的分是在不完整输入下得出的）；
 *   3. `cancelMidTurn === false` 的智能体，按钮文案是「关闭运行时」而不是「终止」；
 *   4. 错误要带码与原因，不能只留一个红 Tag。
 * 另外「没有产出时不给看改动」与「运行中才给终止」也在这里钉住。
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { EvalRowCard } from './eval-row-card';

const row = {
  id: 'w-1',
  agentKind: 'claude-code' as const,
  providerId: 'p-anthropic',
  providerName: 'Anthropic 网关',
  baseUrl: 'https://gw.example.com/anthropic',
  modelId: 'claude-opus-4-6',
  status: 'judged' as const,
  branch: 'test/w-1',
  workspacePath: 'D:\\runs\\run-1\\rows\\w-1\\workspace',
  baselineCommit: '30b86eedca90b70d15b9eb9e75b454a2574762d4',
  tokens: { input: 128_450, cached: 12_800, output: 4_200 },
  turns: 17,
  durationMs: 383_000,
  diff: { filesChanged: 3, insertions: 25, deletions: 7, truncated: false },
  score: null,
  error: null,
};

const handlers = {
  onAbort: vi.fn(),
  onOpenLog: vi.fn(),
  onOpenDiff: vi.fn(),
  onOpenScore: vi.fn(),
};

describe('EvalRowCard', () => {
  it('标题行是「智能体 · 模型」+ 状态 Tag，并给出分支与计量', () => {
    render(<EvalRowCard row={row} {...handlers} />);

    expect(screen.getByText('Claude Code')).toBeInTheDocument();
    expect(screen.getByText('claude-opus-4-6')).toBeInTheDocument();
    expect(screen.getByText('Anthropic 网关')).toBeInTheDocument();
    expect(screen.getByText('test/w-1')).toBeInTheDocument();
    expect(screen.getByText('tok 132,650')).toBeInTheDocument();
  });

  it('排名徽标只在传了 rank 时出现', () => {
    const { unmount } = render(<EvalRowCard row={row} rank={1} {...handlers} />);
    expect(screen.getByText('第 1 名')).toBeInTheDocument();
    unmount();

    render(<EvalRowCard row={row} {...handlers} />);
    expect(screen.queryByText(/第 \d+ 名/)).toBeNull();
  });

  it('串行排队中给出「为什么在等」', () => {
    render(<EvalRowCard row={{ ...row, status: 'pending' }} queued {...handlers} />);

    expect(screen.getByText('串行排队中：前一行结束后自动开始')).toBeInTheDocument();
  });

  it('diff 被截断时在卡片上标出来', () => {
    render(<EvalRowCard row={{ ...row, diff: { filesChanged: 3, insertions: 25, deletions: 7, truncated: true } }} {...handlers} />);

    expect(screen.getByText('diff 已截断')).toBeInTheDocument();
  });

  it('不支持的计量显示「不支持计量」而不是 0', () => {
    render(<EvalRowCard row={{ ...row, tokens: null, turns: null, durationMs: null }} capability={{ usage: false, cancelMidTurn: true }} {...handlers} />);

    expect(screen.getByText('tok 不支持计量')).toBeInTheDocument();
    expect(screen.queryByText('tok 0')).toBeNull();
  });

  it('cancelMidTurn 为 false 的智能体，按钮文案是「关闭运行时」', () => {
    const { unmount } = render(
      <EvalRowCard row={{ ...row, status: 'running' }} capability={{ usage: true, cancelMidTurn: false }} {...handlers} />,
    );
    expect(screen.getByRole('button', { name: '关闭运行时' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '终止' })).toBeNull();
    unmount();

    render(<EvalRowCard row={{ ...row, status: 'running' }} {...handlers} />);
    expect(screen.getByRole('button', { name: '终止' })).toBeInTheDocument();
  });

  it('单行的终止按钮只在运行中可见', () => {
    const { unmount } = render(<EvalRowCard row={row} {...handlers} />);
    expect(screen.queryByRole('button', { name: '终止' })).toBeNull();
    unmount();

    const onAbort = vi.fn();
    render(<EvalRowCard row={{ ...row, status: 'judging' }} {...handlers} onAbort={onAbort} />);
    fireEvent.click(screen.getByRole('button', { name: '终止' }));
    expect(onAbort).toHaveBeenCalledTimes(1);
  });

  it('没有产出改动时「查看改动」禁用；有错误时把码与原因一起显示', () => {
    render(
      <EvalRowCard
        row={{ ...row, diff: null, status: 'failed', error: { code: 'AGENT_FAILED', message: 'CLI 未安装：spawn claude ENOENT' } }}
        {...handlers}
      />,
    );

    expect(screen.getByRole('button', { name: '查看改动' })).toBeDisabled();
    expect(screen.getByText(/AGENT_FAILED/)).toBeInTheDocument();
    expect(screen.getByText(/spawn claude ENOENT/)).toBeInTheDocument();
  });

  it('三个查看按钮把点击交回给调用方', () => {
    const onOpenLog = vi.fn();
    const onOpenDiff = vi.fn();
    const onOpenScore = vi.fn();
    render(
      <EvalRowCard
        row={{ ...row, score: { dimensions: [], totalScore: 87, verdict: '可用', raw: '{}', judgeProviderId: 'p-1', judgeModelId: 'm', judgedAt: '2026-09-22T08:10:00.000Z' } }}
        onAbort={vi.fn()}
        onOpenLog={onOpenLog}
        onOpenDiff={onOpenDiff}
        onOpenScore={onOpenScore}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '查看日志' }));
    fireEvent.click(screen.getByRole('button', { name: '查看改动' }));
    fireEvent.click(screen.getByRole('button', { name: '评分详情' }));

    expect(onOpenLog).toHaveBeenCalledTimes(1);
    expect(onOpenDiff).toHaveBeenCalledTimes(1);
    expect(onOpenScore).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @aieval/ui test`
Expected: FAIL —— 收集阶段报 `Failed to resolve import "./eval-row-card" from "src/composite/eval-row-card.test.tsx". Does the file exist?`

- [ ] **Step 3: 写实现 `packages/client/ui/src/composite/eval-row-card.tsx`**

```tsx
'use client';

/**
 * 单候选卡片：标题行（智能体 · 模型 · 供应商） + 分支 + 计量 + 状态 + 按钮组。
 * 版面上的分隔靠 `Card` 自己的标题栏与 `Flex` 的 `gap` 承担，**不额外插 `Divider`**：
 * 它的默认外边距是页面级的，塞进卡片里就得手调，与「间距走 antd 默认」相悖。
 * 四件必须显式表达的事（缺一件使用者就会误判）：
 *   1. `queued` → 「串行排队中：前一行结束后自动开始」；
 *   2. `row.diff.truncated` → 「diff 已截断」（这一次的分是在不完整输入下得出的）；
 *   3. `capability.cancelMidTurn === false` → 按钮文案退化为「关闭运行时」（spec §5.6.2）；
 *   4. `row.error` → 错误码 + 可读原因，不能只留一个红 Tag。
 */
import { Alert, Button, Card, Flex, Tag, Tooltip, Typography } from 'antd';
import type { ReactNode } from 'react';
import { AGENT_LABELS, isRunningRow, type EvalRow } from '@aieval/contracts';
import { MetricLine } from '../base/metric-line';
import { RowStatusTag } from '../base/row-status-tag';

/** 该行智能体的能力元数据（来自注册表，见计划「修正 3」） */
export interface AgentCapabilityView {
  usage: boolean;
  cancelMidTurn: boolean;
}

export interface EvalRowCardProps {
  row: EvalRow;
  /** 排名徽标：只有 1..3 名才传（并列同名次由调用方算好） */
  rank?: number;
  /** 串行模式下等待中的行 */
  queued?: boolean;
  /** 不传按「都支持」处理 */
  capability?: AgentCapabilityView;
  onAbort: () => void;
  onOpenLog: () => void;
  onOpenDiff: () => void;
  onOpenScore: () => void;
}

/** 缺省能力：按「都支持」处理——多给一个终止按钮，比无端禁用安全 */
const DEFAULT_CAPABILITY: AgentCapabilityView = { usage: true, cancelMidTurn: true };

export function EvalRowCard({
  row,
  rank,
  queued = false,
  capability = DEFAULT_CAPABILITY,
  onAbort,
  onOpenLog,
  onOpenDiff,
  onOpenScore,
}: EvalRowCardProps): ReactNode {
  const running = isRunningRow(row.status);
  const hasDiff = row.diff !== null;

  return (
    <Card
      size="small"
      title={
        <Flex align="center" gap={8} wrap>
          {rank === undefined ? null : <Tag color="gold">第 {rank} 名</Tag>}
          <Typography.Text strong>{AGENT_LABELS[row.agentKind]}</Typography.Text>
          <Typography.Text type="secondary">·</Typography.Text>
          <Typography.Text code>{row.modelId}</Typography.Text>
          <Tooltip title={`供应商：${row.providerName}（${row.baseUrl}）`}>
            <Tag>{row.providerName}</Tag>
          </Tooltip>
        </Flex>
      }
      extra={
        <Flex align="center" gap={4}>
          {row.diff?.truncated === true ? <Tag color="warning">diff 已截断</Tag> : null}
          <RowStatusTag status={row.status} />
        </Flex>
      }
    >
      <Flex vertical gap={8}>
        <Typography.Text type="secondary">
          分支 <Typography.Text code>{row.branch}</Typography.Text>
        </Typography.Text>
        <MetricLine
          tokens={row.tokens}
          turns={row.turns}
          durationMs={row.durationMs}
          score={row.score}
          usageUnsupported={!capability.usage}
        />
        {queued && <Alert type="info" showIcon title="串行排队中：前一行结束后自动开始" />}
        {row.error !== null && <Alert type="error" showIcon title={`${row.error.code}：${row.error.message}`} />}
        <Flex justify="space-between" gap={8} wrap>
          <Flex gap={8} wrap>
            <Button size="small" onClick={onOpenLog}>
              查看日志
            </Button>
            <Tooltip title={hasDiff ? undefined : '这一行还没有产出改动'}>
              <Button size="small" disabled={!hasDiff} onClick={onOpenDiff}>
                查看改动
              </Button>
            </Tooltip>
            <Button size="small" disabled={row.score === null} onClick={onOpenScore}>
              评分详情
            </Button>
          </Flex>
          {running && (
            <Button size="small" danger onClick={onAbort}>
              {capability.cancelMidTurn ? '终止' : '关闭运行时'}
            </Button>
          )}
        </Flex>
      </Flex>
    </Card>
  );
}
```

- [ ] **Step 4: 写失败测试 `packages/client/ui/src/composite/run-detail-panel.test.tsx`**

```tsx
/**
 * RunDetailPanel：顶部信息行 + 串行进度 + 候选卡片列表 + 吸底操作栏。
 * 本文件钉住 spec §5.3 的界面语义：
 *   · 顶部信息行的四项（用例标题 / 仓库路径 / commit 短哈希+Tooltip 全量 / 工作基目录）；
 *   · 串行才有进度文案「3/6 已完成」，且零行时不能出现 NaN；
 *   · 出分后按总分排序、前三名带徽标、**同分同名次**；
 *   · 「开始」先 `Modal.confirm` 列出将执行的候选清单（误点一次要烧掉几十分钟）；
 *   · 「终止」走 `Popconfirm`。
 * jsdom 环境注意：Modal / Select 的浮层走 rc-resize-observer，必须自己装 ResizeObserver 桩。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { EvalRun } from '@aieval/contracts';
import { installResizeObserverStub } from '../testing/resize-observer';
import { RunDetailPanel } from './run-detail-panel';

beforeEach(() => {
  installResizeObserverStub();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const score = (totalScore: number) => ({
  dimensions: [],
  totalScore,
  verdict: '可用',
  raw: '{}',
  judgeProviderId: 'p-1',
  judgeModelId: 'claude-opus-4-6',
  judgedAt: '2026-09-22T08:10:00.000Z',
});

function makeRow(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    agentKind: 'claude-code' as const,
    providerId: 'p-anthropic',
    providerName: 'Anthropic 网关',
    baseUrl: 'https://gw.example.com/anthropic',
    modelId: `claude-opus-4-6-${id}`,
    status: 'judged' as const,
    branch: `test/${id}`,
    workspacePath: `D:\\runs\\run-1\\rows\\${id}\\workspace`,
    baselineCommit: '30b86eedca90b70d15b9eb9e75b454a2574762d4',
    tokens: null,
    turns: null,
    durationMs: null,
    diff: { filesChanged: 1, insertions: 1, deletions: 0, truncated: false },
    score: score(60),
    error: null,
    ...overrides,
  };
}

function makeRun(overrides: Partial<EvalRun> = {}): EvalRun {
  return {
    id: 'run-1',
    caseId: 'c-1',
    caseTitle: '多协议入站转换',
    repoPath: 'D:\\projects\\gateway',
    commitHash: '71e628091bf7134a6e677a58cc1e0f29b9302e6f',
    status: 'running',
    executionMode: 'parallel',
    rows: [makeRow('w-1')],
    workspaceBase: 'D:\\runs',
    createdAt: '2026-09-22T08:00:00.000Z',
    startedAt: '2026-09-22T08:01:00.000Z',
    finishedAt: null,
    ...overrides,
  };
}

const handlers = {
  onStart: vi.fn(),
  onAbortRun: vi.fn(),
  onAbortRow: vi.fn(),
  onOpenLog: vi.fn(),
  onOpenDiff: vi.fn(),
  onOpenScore: vi.fn(),
};

function renderPanel(run: EvalRun, overrides: Record<string, unknown> = {}): ReturnType<typeof render> {
  return render(<RunDetailPanel run={run} starting={false} aborting={false} {...handlers} {...overrides} />);
}

describe('RunDetailPanel 顶部信息行', () => {
  it('四项信息都在：用例标题 / 仓库路径 / commit 短哈希 / 工作基目录', () => {
    renderPanel(makeRun());

    expect(screen.getByText('多协议入站转换')).toBeInTheDocument();
    expect(screen.getByText('D:\\projects\\gateway')).toBeInTheDocument();
    expect(screen.getByText('71e6280')).toBeInTheDocument();
    expect(screen.getByText('D:\\runs')).toBeInTheDocument();
  });

  it('用例没指定 commit 时显示「默认分支 HEAD」', () => {
    renderPanel(makeRun({ commitHash: null }));

    expect(screen.getByText('默认分支 HEAD')).toBeInTheDocument();
  });
});

describe('RunDetailPanel 进度', () => {
  it('串行模式下给出「N/M 已完成」，分子含失败与终止的行', () => {
    renderPanel(
      makeRun({
        executionMode: 'serial',
        rows: [
          makeRow('w-1', { status: 'judged' }),
          makeRow('w-2', { status: 'failed', score: null }),
          makeRow('w-3', { status: 'canceled', score: null }),
          makeRow('w-4', { status: 'running', score: null }),
          makeRow('w-5', { status: 'pending', score: null }),
          makeRow('w-6', { status: 'pending', score: null }),
        ],
      }),
    );

    // 失败/终止也是「跑完了」：不计进去进度永远到不了 100%
    expect(screen.getByText('3/6 已完成')).toBeInTheDocument();
  });

  it('并行模式不显示串行进度', () => {
    renderPanel(makeRun({ executionMode: 'parallel' }));

    expect(screen.queryByText(/已完成/)).toBeNull();
  });

  it('零候选行时不出现 NaN', () => {
    renderPanel(makeRun({ executionMode: 'serial', rows: [] }));

    expect(screen.getByText('0/0 已完成')).toBeInTheDocument();
    expect(screen.queryByText(/NaN/)).toBeNull();
  });
});

describe('RunDetailPanel 卡片列表', () => {
  it('出分的行按总分降序在前，前三名带徽标', () => {
    renderPanel(
      makeRun({
        rows: [
          makeRow('w-1', { score: score(70), modelId: 'model-70' }),
          makeRow('w-2', { score: score(92), modelId: 'model-92' }),
          makeRow('w-3', { score: score(85), modelId: 'model-85' }),
          makeRow('w-4', { score: score(60), modelId: 'model-60' }),
        ],
      }),
    );

    expect(screen.getByText('第 1 名')).toBeInTheDocument();
    expect(screen.getByText('第 2 名')).toBeInTheDocument();
    expect(screen.getByText('第 3 名')).toBeInTheDocument();
    // 第 4 名没有徽标
    expect(screen.queryByText('第 4 名')).toBeNull();
    // 第 1 名挂在最高分那张卡上
    const first = screen.getByText('第 1 名').closest('.ant-card');
    expect(first).toHaveTextContent('model-92');
  });

  it('同分同名次（并列不硬拆成 1、2 名），未出分的行排在后面', () => {
    renderPanel(
      makeRun({
        rows: [
          makeRow('w-1', { score: score(87), modelId: 'model-a' }),
          makeRow('w-2', { score: score(87), modelId: 'model-b' }),
          makeRow('w-3', { score: score(60), modelId: 'model-c' }),
          makeRow('w-4', { score: null, status: 'running', modelId: 'model-running' }),
        ],
      }),
    );

    expect(screen.getAllByText('第 1 名')).toHaveLength(2);
    // 两行 87 之后，60 分是第 3 名（并列占掉 1、1，下一档从 3 起）
    expect(screen.getByText('第 3 名')).toBeInTheDocument();
    expect(screen.getByText('第 3 名').closest('.ant-card')).toHaveTextContent('model-c');
  });

  it('串行模式下等待中的行被标成排队（并行模式不标）', () => {
    const { unmount } = renderPanel(makeRun({ executionMode: 'serial', rows: [makeRow('w-1', { status: 'pending', score: null })] }));
    expect(screen.getByText('串行排队中：前一行结束后自动开始')).toBeInTheDocument();
    unmount();

    renderPanel(makeRun({ executionMode: 'parallel', rows: [makeRow('w-1', { status: 'pending', score: null })] }));
    expect(screen.queryByText('串行排队中：前一行结束后自动开始')).toBeNull();
  });

  it('把每行智能体的能力元数据透给卡片（DSH 的终止文案不同）', () => {
    renderPanel(
      makeRun({ rows: [makeRow('w-1', { agentKind: 'dsh', status: 'running', score: null })] }),
      { capabilityOf: () => ({ usage: false, cancelMidTurn: false }) },
    );

    expect(screen.getByRole('button', { name: '关闭运行时' })).toBeInTheDocument();
    expect(screen.getByText('tok 不支持计量')).toBeInTheDocument();
  });
});

describe('RunDetailPanel 吸底操作栏', () => {
  it('有运行中的行时「开始」禁用、「终止」可用', () => {
    renderPanel(makeRun({ rows: [makeRow('w-1', { status: 'running', score: null })] }));

    expect(screen.getByRole('button', { name: '开始' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '终止' })).toBeEnabled();
  });

  it('全部已评分时「开始」禁用（没有可执行的行）', () => {
    renderPanel(makeRun({ rows: [makeRow('w-1', { status: 'judged' })] }));

    expect(screen.getByRole('button', { name: '开始' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '终止' })).toBeDisabled();
  });

  it('「开始」先弹确认框列出将执行的候选，确认后才回调', async () => {
    const onStart = vi.fn();
    renderPanel(makeRun({ rows: [makeRow('w-1', { status: 'failed', score: null }), makeRow('w-2', { status: 'pending', score: null })] }), { onStart });

    fireEvent.click(screen.getByRole('button', { name: '开始' }));

    // 清单必须列出「将执行什么」——误点一次要烧掉几十分钟的额度
    expect(await screen.findByText('开始执行这一轮评测？')).toBeInTheDocument();
    expect(screen.getByText('本次将执行 2 个候选：')).toBeInTheDocument();
    expect(onStart).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '开 始' }));
    await waitFor(() => expect(onStart).toHaveBeenCalledTimes(1));
  });

  it('确认框里点取消不会开跑', async () => {
    const onStart = vi.fn();
    renderPanel(makeRun({ rows: [makeRow('w-1', { status: 'pending', score: null })] }), { onStart });

    fireEvent.click(screen.getByRole('button', { name: '开始' }));
    fireEvent.click(await screen.findByRole('button', { name: '取 消' }));

    expect(onStart).not.toHaveBeenCalled();
  });

  it('「终止」走 Popconfirm，确认后才回调', async () => {
    const onAbortRun = vi.fn();
    renderPanel(makeRun({ rows: [makeRow('w-1', { status: 'running', score: null })] }), { onAbortRun });

    fireEvent.click(screen.getByRole('button', { name: '终止' }));

    expect(await screen.findByText('终止这一轮评测？')).toBeInTheDocument();
    expect(onAbortRun).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '确 定' }));
    await waitFor(() => expect(onAbortRun).toHaveBeenCalledTimes(1));
  });
});
```

写完这份用例先跑一次，确认它因为实现还不存在而失败：

Run: `pnpm --filter @aieval/ui test`
Expected: FAIL —— `Failed to resolve import "./run-detail-panel" from "src/composite/run-detail-panel.test.tsx". Does the file exist?`

- [ ] **Step 5: 写实现 `packages/client/ui/src/composite/run-detail-panel.tsx`**

```tsx
'use client';

/**
 * 评测详情面板：顶部信息行 + 串行进度 + 候选卡片列表 + 吸底操作栏。
 * 四条口径：
 *   1. 「开始」必须先 `Modal.confirm` 列出本次将执行的候选清单（spec §5.3）——
 *      误点一次要烧掉几十分钟的额度与时间，确认框是这里唯一的安全带；
 *   2. 「终止」用 `Popconfirm`（它杀进程、不可撤销）；单行的终止在卡片上，同一套语义；
 *   3. 排序与排名：**出分的行按总分降序在前**（其余保持创建顺序），
 *      名次 = 1 + 分数**严格高于**它的行数（同分同名次，不把并列硬拆成 1、2 名），只有 1..3 名带徽标；
 *   4. 吸底栏用 `Layout.Footer` 但把它的默认内边距清零——那是页面级的 24/50，
 *      放进右栏会把卡片顶出视口；间距交给 `Flex` 的 `gap`（见计划「修正 8」）。
 */
import { Badge, Button, Flex, Layout, Modal, Popconfirm, Progress, Tooltip, Typography, theme } from 'antd';
import type { ReactNode } from 'react';
import {
  AGENT_LABELS,
  TERMINAL_ROW_STATUSES,
  isRunnableRow,
  isRunningRow,
  type AgentKind,
  type EvalRow,
  type EvalRun,
} from '@aieval/contracts';
import { EllipsisText } from '../base/ellipsis-text';
import { shortHash } from '../base/format';
import { EvalRowCard, type AgentCapabilityView } from './eval-row-card';

export interface RunDetailPanelProps {
  run: EvalRun;
  starting: boolean;
  aborting: boolean;
  /** 每行智能体的能力元数据（usage / cancelMidTurn）；不传按「都支持」处理 */
  capabilityOf?: (agentKind: AgentKind) => AgentCapabilityView;
  onStart: () => void;
  onAbortRun: () => void;
  onAbortRow: (rowId: string) => void;
  onOpenLog: (rowId: string) => void;
  onOpenDiff: (rowId: string) => void;
  onOpenScore: (rowId: string) => void;
}

/** 名次 = 1 + 分数严格高于它的行数（并列同名次）；没有分的行不给名次 */
function rankOf(rows: EvalRow[], row: EvalRow): number | undefined {
  const score = row.score;
  if (score === null) return undefined;
  let better = 0;
  for (const other of rows) {
    const otherScore = other.score;
    if (otherScore !== null && otherScore.totalScore > score.totalScore) better += 1;
  }
  return better + 1;
}

/** 展示顺序：有分的按总分降序在前，其余保持原始顺序（原始顺序 = 创建顺序，稳定可预期） */
function orderForDisplay(rows: EvalRow[]): EvalRow[] {
  const scored = rows
    .filter((row) => row.score !== null)
    .sort((a, b) => (b.score?.totalScore ?? 0) - (a.score?.totalScore ?? 0));
  const rest = rows.filter((row) => row.score === null);
  return [...scored, ...rest];
}

const OPTIMISTIC_CAPABILITY: AgentCapabilityView = { usage: true, cancelMidTurn: true };

export function RunDetailPanel({
  run,
  starting,
  aborting,
  capabilityOf,
  onStart,
  onAbortRun,
  onAbortRow,
  onOpenLog,
  onOpenDiff,
  onOpenScore,
}: RunDetailPanelProps): ReactNode {
  const { token } = theme.useToken();
  const [modal, contextHolder] = Modal.useModal();

  const runnable = run.rows.filter((row) => isRunnableRow(row.status));
  const hasRunning = run.rows.some((row) => isRunningRow(row.status));
  const done = run.rows.filter((row) => TERMINAL_ROW_STATUSES.includes(row.status)).length;
  const total = run.rows.length;
  const serial = run.executionMode === 'serial';

  const startDisabled = starting || hasRunning || runnable.length === 0;
  const startDisabledReason = hasRunning
    ? '有候选行正在运行：等它结束，或先终止'
    : runnable.length === 0
      ? '没有可执行的行（全部已评分）'
      : undefined;

  /** 「开始」的确认框：把将执行的清单摆出来，避免误点跑掉几十分钟 */
  const confirmStart = (): void => {
    modal.confirm({
      title: '开始执行这一轮评测？',
      width: 520,
      content: (
        <Flex vertical gap={4}>
          <Typography.Text>
            执行模式：{serial ? '串行（一行跑完含评分，才起下一行）' : '并行（全部同时开跑）'}
          </Typography.Text>
          <Typography.Text>本次将执行 {runnable.length} 个候选：</Typography.Text>
          {runnable.map((row) => (
            <Typography.Text key={row.id} type="secondary">
              · {AGENT_LABELS[row.agentKind]} · {row.modelId}
            </Typography.Text>
          ))}
        </Flex>
      ),
      okText: '开始',
      cancelText: '取消',
      onOk: onStart,
    });
  };

  return (
    <Flex vertical gap={8} style={{ height: '100%', minHeight: 0 }}>
      {/* 顶部信息行：用例标题 · 仓库路径 · commit（短哈希 + Tooltip 全量）· 工作基目录 */}
      <Flex align="center" gap={8} wrap>
        <Typography.Text strong>{run.caseTitle}</Typography.Text>
        <Typography.Text type="secondary">·</Typography.Text>
        <EllipsisText text={run.repoPath} width={260} monospace />
        <Typography.Text type="secondary">·</Typography.Text>
        {run.commitHash === null ? (
          <Typography.Text type="secondary">默认分支 HEAD</Typography.Text>
        ) : (
          <Tooltip title={run.commitHash}>
            <Typography.Text code>{shortHash(run.commitHash)}</Typography.Text>
          </Tooltip>
        )}
        <Typography.Text type="secondary">·</Typography.Text>
        <Tooltip title={`工作基目录：${run.workspaceBase}`}>
          <Typography.Text type="secondary">
            <EllipsisText text={run.workspaceBase} width={180} monospace />
          </Typography.Text>
        </Tooltip>
      </Flex>

      {serial && (
        <Flex align="center" gap={8}>
          <Progress
            percent={total === 0 ? 0 : Math.round((done / total) * 100)}
            size="small"
            showInfo={false}
            style={{ flex: 1 }}
          />
          <Typography.Text type="secondary">
            {done}/{total} 已完成
          </Typography.Text>
        </Flex>
      )}

      <Flex vertical gap={8} style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        {orderForDisplay(run.rows).map((row) => (
          <EvalRowCard
            key={row.id}
            row={row}
            rank={rankOf(run.rows, row)}
            queued={serial && row.status === 'pending'}
            capability={capabilityOf === undefined ? OPTIMISTIC_CAPABILITY : capabilityOf(row.agentKind)}
            onAbort={() => onAbortRow(row.id)}
            onOpenLog={() => onOpenLog(row.id)}
            onOpenDiff={() => onOpenDiff(row.id)}
            onOpenScore={() => onOpenScore(row.id)}
          />
        ))}
      </Flex>

      <Layout.Footer
        style={{
          position: 'sticky',
          bottom: 0,
          padding: 0,
          background: token.colorBgContainer,
          borderTop: `1px solid ${token.colorBorderSecondary}`,
        }}
      >
        <Flex justify="space-between" align="center" gap={8} wrap>
          <Flex align="center" gap={8}>
            <Badge status={hasRunning ? 'processing' : 'default'} />
            {/* 执行模式只读展示：**本面板不提供切换入口**（spec §3 F9：执行模式随评测落库、运行中不可改） */}
            <Typography.Text type="secondary">
              {serial ? '串行' : '并行'} · 共 {total} 行
            </Typography.Text>
          </Flex>
          <Flex gap={8}>
            <Tooltip title={startDisabledReason}>
              <Button type="primary" size="small" loading={starting} disabled={startDisabled} onClick={confirmStart}>
                开始
              </Button>
            </Tooltip>
            <Popconfirm
              title="终止这一轮评测？"
              description="正在跑的 agent 子进程会被杀掉，且不可撤销。"
              okText="确定"
              cancelText="取消"
              disabled={aborting || !hasRunning}
              onConfirm={onAbortRun}
            >
              <Button danger size="small" loading={aborting} disabled={aborting || !hasRunning}>
                终止
              </Button>
            </Popconfirm>
          </Flex>
        </Flex>
      </Layout.Footer>
      {contextHolder}
    </Flex>
  );
}
```

- [ ] **Step 6: 追加 `packages/client/ui/src/index.ts` 的导出**

```ts
export { EvalRowCard, type AgentCapabilityView, type EvalRowCardProps } from './composite/eval-row-card';
export { RunDetailPanel, type RunDetailPanelProps } from './composite/run-detail-panel';
```

- [ ] **Step 7: 运行确认通过**

Run: `pnpm --filter @aieval/ui test`
Expected: PASS。

Run: `pnpm typecheck`
Expected: 零错误。

> 若「开始」确认框的确定按钮按 `name: '开 始'` 找不到：antd 会在两个汉字的按钮文案里插一个空格（`ant-btn` 的两字间距是它的既定行为），`Popconfirm` 的按钮同理是 `'确 定'`。实测不到时用 `screen.getAllByRole('button')` 打印全部按钮名再从里面挑（不要改成 CSS 类选择器，那会绕开无障碍名这条真正在测的东西）。

- [ ] **Step 8: 提交**

```bash
git add packages/client/ui/src/composite/eval-row-card.tsx packages/client/ui/src/composite/eval-row-card.test.tsx packages/client/ui/src/composite/run-detail-panel.tsx packages/client/ui/src/composite/run-detail-panel.test.tsx packages/client/ui/src/index.ts
git commit -m "feat(ui): 候选卡片与评测详情面板（排名/串行进度/吸底操作栏 + 确认框）"
```

---

## Task 9: `ui` —— 三个产物视图（`ScoreDetailView` / `DiffView` / `LogView`）

**Files:**
- Create: `packages/client/ui/src/composite/score-detail-view.tsx`（+ `.test.tsx`）
- Create: `packages/client/ui/src/composite/diff-view.tsx`（+ `.test.tsx`）
- Create: `packages/client/ui/src/composite/log-format.ts`（+ `.test.ts`）
- Create: `packages/client/ui/src/composite/log-view.tsx`（+ `.test.tsx`）
- Modify: `packages/client/ui/src/index.ts`（追加导出）

**Interfaces:**
- Consumes: Task 6 的 `MonoText` / `ScoreBars`、脚手架既有的 `EllipsisText` / `EmptyState` / `format.ts` 的 `formatDateTime`；p0 `@aieval/contracts` 的 `ScoreResult` / `RowDiff` / `AgentEvent` / `ROW_STATUS_LABELS`
- Produces: `ScoreDetailView({ score })`、`DiffView({ diff })`、`LogView({ events, connected, onDownload })`、`formatEventLine(event)`、`formatEventLog(events)`

- [ ] **Step 1: 写失败测试 `packages/client/ui/src/composite/log-format.test.ts`**

```ts
/**
 * 事件 → 日志行（纯函数）。
 * 7 种事件类型都要有一行可读文本：**任何一种被静默丢掉，排障时就少一条证据**
 * （spec §5.6.3：未识别的事件必须投影成保留原始负载的日志事件，不得静默丢弃）。
 */
import { describe, expect, it } from 'vitest';
import { formatEventLine, formatEventLog } from './log-format';

const at = '2026-09-22T08:03:04.000Z';

describe('formatEventLine', () => {
  it('log：带流别与正文', () => {
    expect(formatEventLine({ seq: 1, at, type: 'log', stream: 'stderr', text: '警告：未找到配置' })).toBe(
      '[08:03:04] stderr 警告：未找到配置',
    );
  });

  it('status：用 contracts 的中文文案', () => {
    expect(formatEventLine({ seq: 2, at, type: 'status', status: 'judging' })).toBe('[08:03:04] 状态 评分中');
  });

  it('usage：三项用量与轮次', () => {
    expect(
      formatEventLine({ seq: 3, at, type: 'usage', tokens: { input: 1000, cached: 200, output: 500 }, turns: 3 }),
    ).toBe('[08:03:04] 用量 输入 1000 · 缓存 200 · 输出 500 · 轮次 3');
  });

  it('diff-summary：计数 + 截断标记', () => {
    expect(
      formatEventLine({ seq: 4, at, type: 'diff-summary', filesChanged: 3, insertions: 25, deletions: 7, truncated: false }),
    ).toBe('[08:03:04] 改动 3 个文件 +25 −7');
    expect(
      formatEventLine({ seq: 5, at, type: 'diff-summary', filesChanged: 3, insertions: 25, deletions: 7, truncated: true }),
    ).toBe('[08:03:04] 改动 3 个文件 +25 −7（已截断）');
  });

  it('score / error / end 各一行', () => {
    const score = {
      dimensions: [],
      totalScore: 87,
      verdict: '可用',
      raw: '{}',
      judgeProviderId: 'p-1',
      judgeModelId: 'claude-opus-4-6',
      judgedAt: at,
    };
    expect(formatEventLine({ seq: 6, at, type: 'score', score })).toBe('[08:03:04] 评分 总分 87 · claude-opus-4-6');
    expect(formatEventLine({ seq: 7, at, type: 'error', message: 'spawn claude ENOENT' })).toBe(
      '[08:03:04] 错误 spawn claude ENOENT',
    );
    expect(formatEventLine({ seq: 8, at, type: 'end', exitReason: 'timed-out' })).toBe('[08:03:04] 结束 timed-out');
  });

  it('时间戳非法时原样保留，不显示 Invalid Date', () => {
    expect(formatEventLine({ seq: 9, at: '不是时间', type: 'end', exitReason: 'error' })).toBe('[不是时间] 结束 error');
  });
});

describe('formatEventLog', () => {
  it('按行拼接，空数组得到空串', () => {
    expect(formatEventLog([])).toBe('');
    expect(formatEventLog([{ seq: 1, at, type: 'end', exitReason: 'completed' }])).toBe('[08:03:04] 结束 completed');
  });
});
```

- [ ] **Step 2: 写失败测试 `packages/client/ui/src/composite/diff-view.test.tsx`**

```tsx
/**
 * DiffView：文件清单 + 统一 diff 正文 + 截断提示。
 * 截断提示是硬要求（spec §5.5 第 7 步）：评分模型看不到的改动必须让人知道，
 * 否则使用者会把「这一次的分」当成完整输入下的结论。
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DiffView } from './diff-view';

const diff = {
  text: '### 已提交改动（30b86ee..HEAD）\ndiff --git a/lib/a.ts b/lib/a.ts\n+const a = 1;',
  truncated: false,
  files: [
    { path: 'lib/a.ts', insertions: 1, deletions: 0 },
    { path: 'lib/b.ts', insertions: 0, deletions: 3 },
  ],
  filesChanged: 2,
  insertions: 1,
  deletions: 3,
  droppedFiles: [],
};

describe('DiffView', () => {
  it('列出文件与计数，并渲染 diff 正文', () => {
    render(<DiffView diff={diff} />);

    expect(screen.getByText('lib/a.ts')).toBeInTheDocument();
    expect(screen.getByText('lib/b.ts')).toBeInTheDocument();
    expect(screen.getByText('共 2 个文件 · +1 −3')).toBeInTheDocument();
    expect(screen.getByTestId('diff-view-text')).toHaveTextContent('diff --git a/lib/a.ts b/lib/a.ts');
  });

  it('被截断时给出「评分模型看不到」的提示与文件清单', () => {
    render(<DiffView diff={{ ...diff, truncated: true, droppedFiles: ['lib/c.ts', 'lib/d.ts'] }} />);

    expect(screen.getByText(/diff 已按体积上限截断：2 个文件未包含，评分模型看不到它们/)).toBeInTheDocument();
    expect(screen.getByText('被丢弃的文件：lib/c.ts、lib/d.ts')).toBeInTheDocument();
  });

  it('没有改动时给空态而不是一张空表格', () => {
    render(<DiffView diff={{ ...diff, text: '', files: [], filesChanged: 0, insertions: 0, deletions: 0 }} />);

    expect(screen.getByText('没有代码改动')).toBeInTheDocument();
  });
});
```

- [ ] **Step 3: 写失败测试 `packages/client/ui/src/composite/score-detail-view.test.tsx`**

```tsx
/**
 * ScoreDetailView：5 维评分条 + 每维理由 + 总评 + 原始返回。
 * 原始返回必须可见（spec §5.7）：解析失败时它是判断「提示词问题还是模型问题」的唯一线索。
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ScoreDetailView } from './score-detail-view';

const score = {
  dimensions: [
    { key: 'correctness' as const, label: '功能正确性', score: 5, reason: '覆盖三种方言' },
    { key: 'requirement' as const, label: '需求完成度', score: 4, reason: '少一条边界用例' },
  ],
  totalScore: 90,
  verdict: '整体可用，边界待补',
  raw: '```json\n{"totalScore":90}\n```',
  judgeProviderId: 'p-1',
  judgeModelId: 'claude-opus-4-6',
  judgedAt: '2026-09-22T08:10:00.000Z',
};

describe('ScoreDetailView', () => {
  it('总分、每维理由、总评、评分者与原始返回都在', () => {
    render(<ScoreDetailView score={score} />);

    expect(screen.getByText('90')).toBeInTheDocument();
    expect(screen.getByText('功能正确性')).toBeInTheDocument();
    expect(screen.getByText('覆盖三种方言')).toBeInTheDocument();
    expect(screen.getByText('整体可用，边界待补')).toBeInTheDocument();
    expect(screen.getByText(/claude-opus-4-6/)).toBeInTheDocument();
    expect(screen.getByTestId('score-raw')).toHaveTextContent('{"totalScore":90}');
  });
});
```

- [ ] **Step 4: 写失败测试 `packages/client/ui/src/composite/log-view.test.tsx`**

```tsx
/**
 * LogView：流式日志 + 自动滚底开关 + 下载 + 连接状态。
 * 三条守卫：
 *   · 关闭自动滚底后 MonoText 不再滚（用户往上翻的动作不能被按回去）；
 *   · 连接状态如实反映（`connected` 徽标不是装饰）；
 *   · 没有事件时给空态而不是一个空文本框——「还没有日志」与「日志是空的」对使用者是两件事。
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { LogView } from './log-view';

const events = [
  { seq: 1, at: '2026-09-22T08:00:00.000Z', type: 'status' as const, status: 'running' as const },
  { seq: 2, at: '2026-09-22T08:00:01.000Z', type: 'log' as const, stream: 'stdout' as const, text: '开始改文件' },
];

describe('LogView', () => {
  it('把事件渲染成日志行，并显示连接状态', () => {
    render(<LogView events={events} connected onDownload={vi.fn()} />);

    const text = screen.getByTestId('log-view-text');
    expect(text).toHaveTextContent('状态 执行中');
    expect(text).toHaveTextContent('开始改文件');
    expect(screen.getByText('实时连接中')).toBeInTheDocument();
  });

  it('未连接时如实显示', () => {
    render(<LogView events={events} connected={false} onDownload={vi.fn()} />);

    expect(screen.getByText('未连接')).toBeInTheDocument();
  });

  it('关掉自动滚底后不再滚到底', () => {
    render(<LogView events={events} connected onDownload={vi.fn()} />);
    const host = screen.getByTestId('log-view-text');
    Object.defineProperty(host, 'scrollHeight', { value: 720, configurable: true });

    fireEvent.click(screen.getByRole('switch', { name: '自动滚底' }));
    host.scrollTop = 123;
    fireEvent.click(screen.getByRole('switch', { name: '自动滚底' }));

    expect(host.scrollTop).toBe(123);
  });

  it('点下载把回调交回去', () => {
    const onDownload = vi.fn();
    render(<LogView events={events} connected onDownload={onDownload} />);

    fireEvent.click(screen.getByRole('button', { name: '下载' }));

    expect(onDownload).toHaveBeenCalledTimes(1);
  });

  it('没有事件时给空态文案', () => {
    render(<LogView events={[]} connected={false} onDownload={vi.fn()} />);

    expect(screen.getByText('还没有日志')).toBeInTheDocument();
    expect(screen.queryByTestId('log-view-text')).toBeNull();
  });
});
```

- [ ] **Step 5: 跑测试确认失败**

Run: `pnpm --filter @aieval/ui test`
Expected: FAIL —— 四份用例都在收集阶段报 `Failed to resolve import`（`./log-format` / `./diff-view` / `./score-detail-view` / `./log-view`）。

- [ ] **Step 6: 写实现 `packages/client/ui/src/composite/log-format.ts`**

```ts
/**
 * 事件 → 日志行（纯函数，无 React 依赖，可单独测）。
 * 7 种事件类型各有一行可读文本：**任何一种被静默丢掉，排障时就少一条证据**
 * （spec §5.6.3 要求未识别的事件也要保留原始负载，不得丢弃）。
 * 时间戳非法时原样返回：显示 `Invalid Date` 比显示原始串更糟（与 format.ts 同一口径）。
 */
import { ROW_STATUS_LABELS, type AgentEvent } from '@aieval/contracts';

/** ISO 时间 → 本地 `HH:mm:ss`；非法输入原样返回 */
function formatClock(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** 一条事件 → 一行日志文本（`[时间] 内容`） */
export function formatEventLine(event: AgentEvent): string {
  const time = formatClock(event.at);
  switch (event.type) {
    case 'log':
      return `[${time}] ${event.stream} ${event.text}`;
    case 'status':
      return `[${time}] 状态 ${ROW_STATUS_LABELS[event.status]}`;
    case 'usage':
      return `[${time}] 用量 输入 ${event.tokens.input} · 缓存 ${event.tokens.cached} · 输出 ${event.tokens.output} · 轮次 ${event.turns}`;
    case 'diff-summary':
      return `[${time}] 改动 ${event.filesChanged} 个文件 +${event.insertions} −${event.deletions}${
        event.truncated ? '（已截断）' : ''
      }`;
    case 'score':
      return `[${time}] 评分 总分 ${event.score.totalScore} · ${event.score.judgeModelId}`;
    case 'error':
      return `[${time}] 错误 ${event.message}`;
    case 'end':
      return `[${time}] 结束 ${event.exitReason}`;
  }
}

/** 全部事件 → 多行文本（日志抽屉的正文与下载内容共用同一个出口） */
export function formatEventLog(events: AgentEvent[]): string {
  return events.map(formatEventLine).join('\n');
}
```

- [ ] **Step 7: 写实现 `packages/client/ui/src/composite/score-detail-view.tsx`**

```tsx
'use client';

/**
 * 评分详情：总分 + 5 维评分条 + 每维理由 + 总评 + 评分者 + 模型原始返回。
 * 原始返回必须可见（spec §5.7）：解析失败时它是判断「提示词问题还是模型问题」的唯一线索；
 * 用 MonoText 呈现，长内容自己滚。
 */
import { Flex, Typography } from 'antd';
import type { ReactNode } from 'react';
import type { ScoreResult } from '@aieval/contracts';
import { MonoText } from '../base/mono-text';
import { ScoreBars } from '../base/score-bars';
import { formatDateTime } from '../base/format';

export interface ScoreDetailViewProps {
  score: ScoreResult;
}

export function ScoreDetailView({ score }: ScoreDetailViewProps): ReactNode {
  return (
    <Flex vertical gap={16}>
      <Flex align="baseline" gap={8} wrap>
        <Typography.Title level={4}>{score.totalScore}</Typography.Title>
        <Typography.Text type="secondary">总分（5 维等权，满分 100）</Typography.Text>
      </Flex>

      <ScoreBars dimensions={score.dimensions} />

      <Flex vertical gap={4}>
        <Typography.Text strong>总评</Typography.Text>
        <Typography.Paragraph style={{ marginBottom: 0 }}>{score.verdict}</Typography.Paragraph>
      </Flex>

      <Typography.Text type="secondary">
        评分模型：{score.judgeModelId} · 评分时间：{formatDateTime(score.judgedAt)}
      </Typography.Text>

      <Flex vertical gap={4}>
        <Typography.Text strong>模型原始返回</Typography.Text>
        <MonoText text={score.raw} maxHeight={240} dataTestId="score-raw" />
      </Flex>
    </Flex>
  );
}
```

- [ ] **Step 8: 写实现 `packages/client/ui/src/composite/diff-view.tsx`**

```tsx
'use client';

/**
 * 代码改动：文件清单 + 统一 diff 正文 + 截断提示。
 * 截断提示是硬要求（spec §5.5 第 7 步）：评分模型看不到的改动必须让人知道，
 * 否则使用者会把「这一次的分」当成完整输入下的结论。
 * diff 正文用 MonoText（等宽 + 限高 + 自滚），不铺满整个抽屉高度——上面还有文件清单。
 */
import { Alert, Flex, Table, Typography } from 'antd';
import type { TableColumnsType } from 'antd';
import type { ReactNode } from 'react';
import type { RowDiff } from '@aieval/contracts';
import { EllipsisText } from '../base/ellipsis-text';
import { EmptyState } from '../base/empty-state';
import { MonoText } from '../base/mono-text';

export interface DiffViewProps {
  diff: RowDiff;
}

type DiffFile = RowDiff['files'][number];

export function DiffView({ diff }: DiffViewProps): ReactNode {
  const columns: TableColumnsType<DiffFile> = [
    {
      title: '文件',
      dataIndex: 'path',
      render: (path: string) => <EllipsisText text={path} monospace />,
    },
    { title: '新增', dataIndex: 'insertions', width: 72, align: 'right' },
    { title: '删除', dataIndex: 'deletions', width: 72, align: 'right' },
  ];

  return (
    <Flex vertical gap={12}>
      {diff.truncated && (
        <Alert
          type="warning"
          showIcon
          title={`diff 已按体积上限截断：${diff.droppedFiles.length} 个文件未包含，评分模型看不到它们`}
        />
      )}
      {diff.droppedFiles.length > 0 && (
        <Typography.Text type="secondary">被丢弃的文件：{diff.droppedFiles.join('、')}</Typography.Text>
      )}
      <Typography.Text type="secondary">
        共 {diff.filesChanged} 个文件 · +{diff.insertions} −{diff.deletions}
      </Typography.Text>

      {diff.files.length === 0 ? (
        <EmptyState title="没有代码改动" description="这一行没有产生任何文件变更" />
      ) : (
        <Table<DiffFile> size="small" rowKey="path" columns={columns} dataSource={diff.files} pagination={false} />
      )}

      <MonoText text={diff.text} maxHeight={420} dataTestId="diff-view-text" />
    </Flex>
  );
}
```

- [ ] **Step 9: 写实现 `packages/client/ui/src/composite/log-view.tsx`**

```tsx
'use client';

/**
 * 执行日志：流式追加的事件 + 自动滚底开关 + 下载 + 连接状态。
 * 三条口径：
 *   1. 自动滚底是**可关的**：用户往上翻看历史时，新事件不该把视图拽回底部；
 *   2. `connected` 如实反映连接状态（未连接时写「未连接」，不假装在实时）；
 *   3. 没有事件时给空态：任务还没开始跑时，空文本框会被误读成「日志是空的」。
 */
import { Badge, Button, Flex, Switch, Typography } from 'antd';
import { useMemo, useState, type ReactNode } from 'react';
import type { AgentEvent } from '@aieval/contracts';
import { EmptyState } from '../base/empty-state';
import { MonoText } from '../base/mono-text';
import { formatEventLog } from './log-format';

export interface LogViewProps {
  events: AgentEvent[];
  connected: boolean;
  onDownload: () => void;
}

export function LogView({ events, connected, onDownload }: LogViewProps): ReactNode {
  const [autoScroll, setAutoScroll] = useState(true);
  // 事件数组每次刷新都是新引用，join 的成本远小于「每渲染一次拼一遍」
  const text = useMemo(() => formatEventLog(events), [events]);

  return (
    <Flex vertical gap={8}>
      <Flex align="center" justify="space-between" gap={8} wrap>
        <Badge status={connected ? 'processing' : 'default'} text={connected ? '实时连接中' : '未连接'} />
        <Flex align="center" gap={8}>
          <Switch size="small" checked={autoScroll} onChange={setAutoScroll} aria-label="自动滚底" />
          <Typography.Text type="secondary">自动滚底</Typography.Text>
          <Button size="small" onClick={onDownload}>
            下载
          </Button>
        </Flex>
      </Flex>

      {events.length === 0 ? (
        <EmptyState title="还没有日志" description="这一行还没开始执行，或执行尚未产生输出" />
      ) : (
        <MonoText text={text} maxHeight={520} autoScroll={autoScroll} dataTestId="log-view-text" />
      )}
    </Flex>
  );
}
```

- [ ] **Step 10: 追加 `packages/client/ui/src/index.ts` 的导出**

```ts
export { ScoreDetailView, type ScoreDetailViewProps } from './composite/score-detail-view';
export { DiffView, type DiffViewProps } from './composite/diff-view';
export { LogView, type LogViewProps } from './composite/log-view';
export { formatEventLine, formatEventLog } from './composite/log-format';
```

- [ ] **Step 11: 跑测试确认通过**

Run: `pnpm --filter @aieval/ui test`
Expected: PASS。

Run: `pnpm typecheck`
Expected: 零错误。

- [ ] **Step 12: 提交**

```bash
git add packages/client/ui/src/composite/log-format.ts packages/client/ui/src/composite/log-format.test.ts packages/client/ui/src/composite/log-view.tsx packages/client/ui/src/composite/log-view.test.tsx packages/client/ui/src/composite/diff-view.tsx packages/client/ui/src/composite/diff-view.test.tsx packages/client/ui/src/composite/score-detail-view.tsx packages/client/ui/src/composite/score-detail-view.test.tsx packages/client/ui/src/index.ts
git commit -m "feat(ui): 三个产物视图（执行日志/代码改动/评分详情）与事件行格式化"
```

---

## Task 10: `web-next` —— 8 条 `runs/**` 路由 + 候选池路由 + 路由测试

**Files:**
- Create: `apps/web-next/app/api/runs/route.ts`
- Create: `apps/web-next/app/api/runs/model-options/route.ts`
- Create: `apps/web-next/app/api/runs/[runId]/route.ts`
- Create: `apps/web-next/app/api/runs/[runId]/start/route.ts`
- Create: `apps/web-next/app/api/runs/[runId]/abort/route.ts`
- Create: `apps/web-next/app/api/runs/[runId]/rows/[rowId]/abort/route.ts`
- Create: `apps/web-next/app/api/runs/[runId]/rows/[rowId]/diff/route.ts`
- Create: `apps/web-next/app/api/runs/[runId]/rows/[rowId]/log/route.ts`
- Create: `apps/web-next/app/api/runs/[runId]/rows/[rowId]/stream/route.ts`
- Create: `apps/web-next/src/route-runs.test.ts`
- Create: `apps/web-next/src/route-run-artifacts.test.ts`

**Interfaces:**
- Consumes: Task 1/2/3 的 api 导出；p0 `@aieval/contracts` 的 `RunCreateSchema`；脚手架既有的 `@/src/server-context` 的 `handleApiError` / `readJsonBody`
- Produces: 9 个 Route Handler（`GET/POST`）

> **执行顺序**：本任务先落地两份路由测试（此刻 9 个路由文件都还不存在），跑一次看到「收集阶段就失败」，
> 再按 Step 4–11 逐个落地路由文件。

- [ ] **Step 1: 写失败测试 `apps/web-next/src/route-runs.test.ts`**

```ts
// @vitest-environment node
/**
 * 评测路由端到端：列表 / 创建（含三类校验） / 详情 / 启动 / 终止 / 单行终止 / 候选池。
 *
 * **`@aieval/evaluator` 被整块 mock 掉**：这些用例要验的是「zod → api → 错误映射」这条链路，
 * 而编排层的启动会真的 spawn agent 子进程（评测执行用假的 evaluator：在 api 边界替换掉它，
 * 既不起进程，也能精确控制「磁盘上有什么快照」）。`@aieval/agents` / `@aieval/core` / `@aieval/api`
 * 都是真实的——候选池的协议过滤正需要真实的注册表元数据。
 *
 * 配置目录与工作区根目录都在 mkdtemp 出来的临时目录里：**绝不触碰真实 ~/.aieval / ~/.runs**。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ServiceError, type EvalRun } from '@aieval/contracts';
import { loadConfig, saveConfig, setConfigDirForTesting, type AppConfig } from '@aieval/core';
import { getRun as getRunSnapshot, saveRun } from '@aieval/evaluator';
import { GET as getRuns, POST as postRun } from '@/app/api/runs/route';
import { GET as getModelOptions } from '@/app/api/runs/model-options/route';
import { GET as getRun } from '@/app/api/runs/[runId]/route';
import { POST as postStart } from '@/app/api/runs/[runId]/start/route';
import { POST as postAbortRun } from '@/app/api/runs/[runId]/abort/route';
import { POST as postAbortRow } from '@/app/api/runs/[runId]/rows/[rowId]/abort/route';

vi.mock('@aieval/evaluator', () => ({
  listRuns: vi.fn(),
  getRun: vi.fn(),
  saveRun: vi.fn(),
  startRun: vi.fn(),
  abortRun: vi.fn(),
  abortRow: vi.fn(),
  subscribeRowEvents: vi.fn(() => () => {}),
}));

let dir: string;
let store: Map<string, EvalRun>;

const openaiProvider = {
  id: 'p-openai',
  name: 'OpenAI 网关',
  protocolType: 'openai' as const,
  baseUrl: 'https://gw.example.com/v1',
  apiKey: 'sk-openai',
  models: [{ id: 'gpt-5', source: 'fetched' as const }],
  createdAt: '2026-09-22T00:00:00.000Z',
  updatedAt: '2026-09-22T00:00:00.000Z',
};

const anthropicProvider = {
  ...openaiProvider,
  id: 'p-anthropic',
  name: 'Anthropic 网关',
  protocolType: 'anthropic' as const,
  baseUrl: 'https://gw.example.com/anthropic',
  apiKey: 'sk-anthropic',
  models: [{ id: 'claude-opus-4-6', source: 'manual' as const }],
};

const testCase = {
  id: 'c-1',
  title: '多协议入站转换',
  repoPath: 'D:\\projects\\gateway',
  commitHash: null,
  taskPrompt: '补齐转换',
  judgePrompt: '按 5 维打分',
  judgeProviderId: null,
  judgeModelId: null,
  createdAt: '2026-09-22T00:00:00.000Z',
  updatedAt: '2026-09-22T00:00:00.000Z',
};

function jsonRequest(body: unknown): Request {
  return new Request('http://localhost/api/runs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** 直通调用路由的 POST（Next 把 params 包成 Promise，这里按同形传） */
function post(handler: (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>, params: Record<string, string>): Promise<Response> {
  return handler(new Request('http://localhost/api/runs'), { params: Promise.resolve(params) });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aieval-route-runs-'));
  setConfigDirForTesting(dir);
  const config = loadConfig();
  const seeded: AppConfig = {
    ...config,
    settings: { ...config.settings, workspaceRoot: join(dir, 'ws') },
    providers: [openaiProvider, anthropicProvider],
    cases: [testCase],
  };
  saveConfig(seeded);

  store = new Map();
  vi.mocked(saveRun).mockImplementation((run: EvalRun) => {
    store.set(run.id, run);
  });
  vi.mocked(getRunSnapshot).mockImplementation((runId: string) => {
    const run = store.get(runId);
    if (run === undefined) throw new ServiceError('NOT_FOUND', `评测不存在：${runId}`);
    return run;
  });
});

afterEach(() => {
  setConfigDirForTesting(null);
  rmSync(dir, { recursive: true, force: true });
});

/** 建一轮真实的评测（走 POST 路由），返回它的快照 */
async function createRealRun(): Promise<EvalRun> {
  const res = await postRun(
    jsonRequest({
      caseId: 'c-1',
      executionMode: 'parallel',
      rows: [
        { agentKind: 'claude-code', providerId: 'p-anthropic', modelId: 'claude-opus-4-6' },
        { agentKind: 'codex', providerId: 'p-openai', modelId: 'gpt-5' },
      ],
    }),
  );
  expect(res.status).toBe(201);
  return (await res.json()) as EvalRun;
}

describe('GET /api/runs', () => {
  it('返回按创建时间倒序的列表', async () => {
    store.set('old', { ...(await createRealRun()), id: 'old', createdAt: '2026-09-22T08:00:00.000Z' });
    store.set('new', { ...(await createRealRun()), id: 'new', createdAt: '2026-09-22T09:00:00.000Z' });

    const res = await getRuns();
    const body = (await res.json()) as EvalRun[];

    expect(res.status).toBe(200);
    expect(body.map((run) => run.id)).toEqual(['new', 'old']);
  });
});

describe('POST /api/runs', () => {
  it('合法请求返回 201 与落库后的快照（供应商名与 baseUrl 已快照）', async () => {
    const run = await createRealRun();

    expect(run.status).toBe('idle');
    expect(run.rows[0]?.providerName).toBe('Anthropic 网关');
    expect(run.rows[0]?.baseUrl).toBe('https://gw.example.com/anthropic');
    // 落的是磁盘（假的 store），不是内存里的临时对象
    expect(store.get(run.id)?.rows).toHaveLength(2);
  });

  it('请求体缺字段时 400，且 context 是真 zod 的 issues', async () => {
    const res = await postRun(jsonRequest({ caseId: 'c-1' }));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('INVALID_QUERY');
    expect(body.error.context.map((issue: { path: string[] }) => issue.path[0])).toContain('executionMode');
  });

  it('一行都没有时 400（RunCreateSchema 的 min(1)）', async () => {
    const res = await postRun(jsonRequest({ caseId: 'c-1', executionMode: 'parallel', rows: [] }));

    expect(res.status).toBe(400);
  });

  it('供应商不存在 → 404 中文原因', async () => {
    const res = await postRun(
      jsonRequest({
        caseId: 'c-1',
        executionMode: 'parallel',
        rows: [{ agentKind: 'claude-code', providerId: 'p-gone', modelId: 'claude-opus-4-6' }],
      }),
    );

    expect(res.status).toBe(404);
    expect((await res.json()).error.message).toContain('p-gone');
  });

  it('协议不匹配 → 409（Claude Code 不能被 openai 供应商驱动）', async () => {
    const res = await postRun(
      jsonRequest({
        caseId: 'c-1',
        executionMode: 'parallel',
        rows: [{ agentKind: 'claude-code', providerId: 'p-openai', modelId: 'gpt-5' }],
      }),
    );

    expect(res.status).toBe(409);
    expect((await res.json()).error.message).toContain('OpenAI 兼容');
  });
});

describe('GET /api/runs/[runId]', () => {
  it('存在返回 200，不存在返回 404', async () => {
    const run = await createRealRun();

    const ok = await getRun(new Request('http://localhost/api/runs/x'), { params: Promise.resolve({ runId: run.id }) });
    expect(ok.status).toBe(200);

    const missing = await getRun(new Request('http://localhost/api/runs/x'), { params: Promise.resolve({ runId: 'nope' }) });
    expect(missing.status).toBe(404);
  });
});

describe('POST /api/runs/[runId]/start', () => {
  it('有可执行行时交给编排层', async () => {
    const run = await createRealRun();
    vi.mocked((await import('@aieval/evaluator')).startRun).mockReturnValue({ ...run, status: 'running' });

    const res = await post(postStart, { runId: run.id });

    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe('running');
  });

  it('全部已评分 → 409，且不调用编排层', async () => {
    const run = await createRealRun();
    store.set(run.id, { ...run, rows: run.rows.map((row) => ({ ...row, status: 'judged' as const })) });
    const orchestrator = await import('@aieval/evaluator');
    vi.mocked(orchestrator.startRun).mockClear();

    const res = await post(postStart, { runId: run.id });

    expect(res.status).toBe(409);
    expect(orchestrator.startRun).not.toHaveBeenCalled();
  });
});

describe('POST /api/runs/[runId]/abort 与单行 abort', () => {
  it('整轮终止走编排层；未知轮 → 404', async () => {
    const run = await createRealRun();
    vi.mocked((await import('@aieval/evaluator')).abortRun).mockReturnValue({ ...run, status: 'partial' });

    expect((await post(postAbortRun, { runId: run.id })).status).toBe(200);
    expect((await post(postAbortRun, { runId: 'nope' })).status).toBe(404);
  });

  it('单行终止：行不存在 → 404（脏 URL 不能真的去杀别人）', async () => {
    const run = await createRealRun();
    vi.mocked((await import('@aieval/evaluator')).abortRow).mockReturnValue({ ...run, status: 'partial' });

    expect((await post(postAbortRow, { runId: run.id, rowId: run.rows[0]?.id ?? '' })).status).toBe(200);
    expect((await post(postAbortRow, { runId: run.id, rowId: 'r-x' })).status).toBe(404);
  });
});

describe('GET /api/runs/model-options', () => {
  it('按协议过滤候选池，并带上三种智能体的能力元数据', async () => {
    const res = await getModelOptions();
    const groups = (await res.json()) as Array<Record<string, unknown>>;

    expect(res.status).toBe(200);
    expect(groups.map((group) => group.agentKind)).toEqual(['claude-code', 'codex', 'dsh']);
    // 键集合钉死：两侧（api / client）各声明过一次这个形状，谁偷偷加字段都会在这里失败
    expect(Object.keys(groups[0] ?? {}).sort()).toEqual(['agentKind', 'cancelMidTurn', 'options', 'protocolType', 'usage']);

    const claude = groups.find((group) => group.agentKind === 'claude-code') as { options: Array<{ modelId: string }> };
    const codex = groups.find((group) => group.agentKind === 'codex') as { options: Array<{ modelId: string }> };
    expect(claude.options.map((option) => option.modelId)).toEqual(['claude-opus-4-6']);
    expect(codex.options.map((option) => option.modelId)).toEqual(['gpt-5']);
    // DSH 的 cancelMidTurn 是 false（界面文案要跟着变）
    expect((groups.find((group) => group.agentKind === 'dsh') as { cancelMidTurn: boolean }).cancelMidTurn).toBe(false);
  });
});
```

- [ ] **Step 2: 写失败测试 `apps/web-next/src/route-run-artifacts.test.ts`**

```ts
// @vitest-environment node
/**
 * 产物路由：代码改动（现场跑 git 现算）、执行日志（?afterSeq=）、SSE 帧与响应头。
 *
 * 本文件**故意让 `@aieval/core` 保持真实、并真的建一个 git 仓库**：diff 路由的价值就在于
 * 「真的能算出改动」，把它 mock 掉等于把最容易错的地方（工作目录、基线、三样合并）从测试里删掉。
 * 仓库建在 mkdtemp 出来的临时目录里，**不碰真实仓库、不碰真实 ~/.aieval**。
 * `@aieval/evaluator` 仍然被整块 mock（不起真实 agent 进程），快照由 POST 路由真实创建。
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ServiceError, type AgentEvent, type EvalRun } from '@aieval/contracts';
import { appendEvent, loadConfig, rowEventsFile, saveConfig, setConfigDirForTesting, type AppConfig } from '@aieval/core';
import { getRun as getRunSnapshot, saveRun } from '@aieval/evaluator';
import { POST as postRun } from '@/app/api/runs/route';
import { GET as getDiff } from '@/app/api/runs/[runId]/rows/[rowId]/diff/route';
import { GET as getLog } from '@/app/api/runs/[runId]/rows/[rowId]/log/route';
import { GET as getStream } from '@/app/api/runs/[runId]/rows/[rowId]/stream/route';

vi.mock('@aieval/evaluator', () => ({
  listRuns: vi.fn(),
  getRun: vi.fn(),
  saveRun: vi.fn(),
  startRun: vi.fn(),
  abortRun: vi.fn(),
  abortRow: vi.fn(),
  subscribeRowEvents: vi.fn(() => () => {}),
}));

let dir: string;
let workspaceRoot: string;
let store: Map<string, EvalRun>;

/** 在临时目录里建一个真仓库：一次提交 + 未提交的改动 + 一个未跟踪文件（三样都覆盖） */
function initRepo(repoDir: string): { baseline: string } {
  mkdirSync(repoDir, { recursive: true });
  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: repoDir, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } });
  git('init');
  writeFileSync(join(repoDir, 'a.ts'), 'const a = 1;\n', 'utf8');
  git('add', '.');
  git('-c', 'user.email=t@example.com', '-c', 'user.name=tester', 'commit', '-m', 'init');
  const baseline = git('rev-parse', 'HEAD').trim();
  // 已改未提交
  writeFileSync(join(repoDir, 'a.ts'), 'const a = 1;\nconst b = 2;\n', 'utf8');
  // 未跟踪的新文件
  writeFileSync(join(repoDir, 'c.ts'), 'export const c = 3;\n', 'utf8');
  return { baseline };
}

function jsonRequest(body: unknown): Request {
  return new Request('http://localhost/api/runs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aieval-route-artifacts-'));
  setConfigDirForTesting(dir);
  workspaceRoot = join(dir, 'ws');
  const config = loadConfig();
  const seeded: AppConfig = {
    ...config,
    settings: { ...config.settings, workspaceRoot },
    providers: [
      {
        id: 'p-anthropic',
        name: 'Anthropic 网关',
        protocolType: 'anthropic',
        baseUrl: 'https://gw.example.com/anthropic',
        apiKey: 'sk-anthropic',
        models: [{ id: 'claude-opus-4-6', source: 'manual' }],
        createdAt: '2026-09-22T00:00:00.000Z',
        updatedAt: '2026-09-22T00:00:00.000Z',
      },
    ],
    cases: [
      {
        id: 'c-1',
        title: '多协议入站转换',
        repoPath: 'D:\\projects\\gateway',
        commitHash: null,
        taskPrompt: '补齐转换',
        judgePrompt: '按 5 维打分',
        judgeProviderId: null,
        judgeModelId: null,
        createdAt: '2026-09-22T00:00:00.000Z',
        updatedAt: '2026-09-22T00:00:00.000Z',
      },
    ],
  };
  saveConfig(seeded);

  store = new Map();
  vi.mocked(saveRun).mockImplementation((run: EvalRun) => {
    store.set(run.id, run);
  });
  vi.mocked(getRunSnapshot).mockImplementation((runId: string) => {
    const run = store.get(runId);
    if (run === undefined) throw new ServiceError('NOT_FOUND', `评测不存在：${runId}`);
    return run;
  });
});

afterEach(() => {
  setConfigDirForTesting(null);
  rmSync(dir, { recursive: true, force: true });
});

/** 走真实路由建一轮评测，返回快照 */
async function createRun(): Promise<EvalRun> {
  const res = await postRun(
    jsonRequest({
      caseId: 'c-1',
      executionMode: 'serial',
      rows: [{ agentKind: 'claude-code', providerId: 'p-anthropic', modelId: 'claude-opus-4-6' }],
    }),
  );
  expect(res.status).toBe(201);
  return (await res.json()) as EvalRun;
}

function rowContext(params: Record<string, string>): { params: Promise<Record<string, string>> } {
  return { params: Promise.resolve(params) };
}

describe('GET .../rows/[rowId]/diff', () => {
  it('现场算 diff：三样合并（已改未提交 + 未跟踪新文件）都进正文', async () => {
    const run = await createRun();
    const row = run.rows[0];
    if (row === undefined) throw new Error('创建评测没有产生候选行');
    // 准备阶段会建工作区并把基线解析成 40 位 hash（§11 R2）；这里按真实形态补上这两步：
    // 工作区就建在创建时算出的 workspacePath 上，基线取自仓库的首次提交
    const { baseline } = initRepo(row.workspacePath);
    store.set(run.id, { ...run, rows: [{ ...row, baselineCommit: baseline }] });

    const res = await getDiff(new Request('http://localhost/api/diff'), rowContext({ runId: run.id, rowId: row.id }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.filesChanged).toBeGreaterThanOrEqual(1);
    expect(body.insertions).toBeGreaterThanOrEqual(1);
    // 未提交的改动与未跟踪的新文件都必须在正文里（只取 commit..HEAD 会漏掉它们）
    expect(body.text).toContain('const b = 2;');
    expect(body.text).toContain('c.ts');
    expect(body.truncated).toBe(false);
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

describe('GET .../rows/[rowId]/log', () => {
  it('返回全量；?afterSeq= 只返回增量', async () => {
    const run = await createRun();
    const row = run.rows[0];
    if (row === undefined) throw new Error('创建评测没有产生候选行');
    const file = rowEventsFile(workspaceRoot, run.id, row.id);
    mkdirSync(dirname(file), { recursive: true });
    appendEvent(file, { type: 'log', stream: 'stdout', text: '一' });
    appendEvent(file, { type: 'log', stream: 'stdout', text: '二' });
    appendEvent(file, { type: 'log', stream: 'stdout', text: '三' });

    const all = await getLog(new Request('http://localhost/api/log'), rowContext({ runId: run.id, rowId: row.id }));
    expect(((await all.json()) as AgentEvent[]).map((event) => event.seq)).toEqual([1, 2, 3]);

    const inc = await getLog(new Request('http://localhost/api/log?afterSeq=2'), rowContext({ runId: run.id, rowId: row.id }));
    expect(((await inc.json()) as AgentEvent[]).map((event) => event.seq)).toEqual([3]);
  });

  it('?afterSeq=abc → 400（不静默当成 0 给全量）', async () => {
    const run = await createRun();
    const row = run.rows[0];
    if (row === undefined) throw new Error('创建评测没有产生候选行');

    const res = await getLog(new Request('http://localhost/api/log?afterSeq=abc'), rowContext({ runId: run.id, rowId: row.id }));

    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('INVALID_QUERY');
  });
});

describe('GET .../rows/[rowId]/stream', () => {
  it('响应头是 SSE 的四个必需项，帧格式为 id/event/data + 空行', async () => {
    const run = await createRun();
    const row = run.rows[0];
    if (row === undefined) throw new Error('创建评测没有产生候选行');
    const file = rowEventsFile(workspaceRoot, run.id, row.id);
    mkdirSync(dirname(file), { recursive: true });
    const first = appendEvent(file, { type: 'log', stream: 'stdout', text: '第一行' });
    const end = appendEvent(file, { type: 'end', exitReason: 'completed' });

    const res = await getStream(new Request('http://localhost/api/stream'), rowContext({ runId: run.id, rowId: row.id }));

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(res.headers.get('cache-control')).toBe('no-cache');
    expect(res.headers.get('connection')).toBe('keep-alive');
    expect(res.headers.get('x-accel-buffering')).toBe('no');

    // 回放里带终态 ⇒ 流会自己结束（否则这里会挂住）
    const text = await res.text();
    expect(text).toBe(
      `id: ${first.seq}\nevent: log\ndata: ${JSON.stringify(first)}\n\n` +
        `id: ${end.seq}\nevent: end\ndata: ${JSON.stringify(end)}\n\n`,
    );
  });

  it('Last-Event-ID 优先于 ?afterSeq=（重连只发头，query 里是首连那一刻的旧值）', async () => {
    const run = await createRun();
    const row = run.rows[0];
    if (row === undefined) throw new Error('创建评测没有产生候选行');
    const file = rowEventsFile(workspaceRoot, run.id, row.id);
    mkdirSync(dirname(file), { recursive: true });
    appendEvent(file, { type: 'log', stream: 'stdout', text: '一' });
    appendEvent(file, { type: 'log', stream: 'stdout', text: '二' });
    const end = appendEvent(file, { type: 'end', exitReason: 'completed' });

    const res = await getStream(
      new Request('http://localhost/api/stream?afterSeq=0', { headers: { 'last-event-id': '2' } }),
      rowContext({ runId: run.id, rowId: row.id }),
    );

    const text = await res.text();
    expect(text.startsWith(`id: ${end.seq}\n`)).toBe(true);
    expect(text).not.toContain('"text":"一"');
  });

  it('轮/行不存在时回 404 JSON（不是开了就结束的 SSE 流）', async () => {
    const run = await createRun();
    const res = await getStream(new Request('http://localhost/api/stream'), rowContext({ runId: run.id, rowId: 'w-x' }));

    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect((await res.json()).error.message).toContain('没有这一行');
  });
});
```

- [ ] **Step 3: 运行确认失败**

Run: `pnpm --filter @aieval/web-next test`
Expected: FAIL —— 收集阶段报 `Failed to resolve import "@/app/api/runs/route"`。

- [ ] **Step 4: 写 `apps/web-next/app/api/runs/route.ts`**

```ts
/**
 * 评测列表与创建：GET 列表 / POST 新建。
 * 只做「zod 校验 → 调 api → 错误映射」，业务规则在 @aieval/api 的 runs.ts。
 */
import { createRun, listRunsView } from '@aieval/api';
import { RunCreateSchema } from '@aieval/contracts';
import { handleApiError, readJsonBody } from '@/src/server-context';

export async function GET(): Promise<Response> {
  try {
    return Response.json(listRunsView());
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(req: Request): Promise<Response> {
  try {
    const input = RunCreateSchema.parse(await readJsonBody(req));
    // 201：确实创建了一个新资源。客户端只看 res.ok，与 PUT /api/settings 的 200 不冲突
    return Response.json(createRun(input), { status: 201 });
  } catch (error) {
    return handleApiError(error);
  }
}
```

- [ ] **Step 5: 写 `apps/web-next/app/api/runs/model-options/route.ts`**

```ts
/**
 * 创建评测表单的候选池 + 三种智能体的能力元数据（见计划「修正 2/3」）。
 * 为什么需要独立一条路由：候选池的协议过滤判据是 agents 注册表元数据（spec §5.6.2 A3），
 * 而契约 §9 的路由表里没有承载它的位置；把「哪家智能体配哪种协议」抄到前端是最坏的替代。
 * 本路由只做投影透传，不含业务规则（投影本身在 api 的 listModelOptions / listAgentModelOptions）。
 */
import { listAgentModelOptions } from '@aieval/api';
import { handleApiError } from '@/src/server-context';

export async function GET(): Promise<Response> {
  try {
    return Response.json(listAgentModelOptions());
  } catch (error) {
    return handleApiError(error);
  }
}
```

- [ ] **Step 6: 写 `apps/web-next/app/api/runs/[runId]/route.ts`**

```ts
/** 单轮评测快照：GET。只做「调 api → 错误映射」。 */
import { getRunView } from '@aieval/api';
import { handleApiError } from '@/src/server-context';

export async function GET(_req: Request, { params }: { params: Promise<{ runId: string }> }): Promise<Response> {
  try {
    const { runId } = await params;
    return Response.json(getRunView(runId));
  } catch (error) {
    return handleApiError(error);
  }
}
```

- [ ] **Step 7: 写 `apps/web-next/app/api/runs/[runId]/start/route.ts` 与 `.../abort/route.ts`**

```ts
// start/route.ts
/** 开始执行这一轮里未完成的行：POST。 */
import { startRun } from '@aieval/api';
import { handleApiError } from '@/src/server-context';

export async function POST(_req: Request, { params }: { params: Promise<{ runId: string }> }): Promise<Response> {
  try {
    const { runId } = await params;
    return Response.json(startRun(runId));
  } catch (error) {
    return handleApiError(error);
  }
}
```

```ts
// abort/route.ts
/** 终止整轮：POST。在跑的行 → canceled，串行未轮到的 → skipped（划分在编排层）。 */
import { abortRun } from '@aieval/api';
import { handleApiError } from '@/src/server-context';

export async function POST(_req: Request, { params }: { params: Promise<{ runId: string }> }): Promise<Response> {
  try {
    const { runId } = await params;
    return Response.json(abortRun(runId));
  } catch (error) {
    return handleApiError(error);
  }
}
```

- [ ] **Step 8: 写 `apps/web-next/app/api/runs/[runId]/rows/[rowId]/abort/route.ts`**

```ts
/** 终止单行：POST。全开并发下某一行跑歪时不必等它超时。 */
import { abortRow } from '@aieval/api';
import { handleApiError } from '@/src/server-context';

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ runId: string; rowId: string }> },
): Promise<Response> {
  try {
    const { runId, rowId } = await params;
    return Response.json(abortRow(runId, rowId));
  } catch (error) {
    return handleApiError(error);
  }
}
```

- [ ] **Step 9: 写 `apps/web-next/app/api/runs/[runId]/rows/[rowId]/diff/route.ts`**

```ts
/** 代码改动：GET，**每次现算**（spec §7.2：diff 正文不预先落库）。 */
import { getRowDiff } from '@aieval/api';
import { handleApiError } from '@/src/server-context';

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ runId: string; rowId: string }> },
): Promise<Response> {
  try {
    const { runId, rowId } = await params;
    return Response.json(getRowDiff(runId, rowId));
  } catch (error) {
    return handleApiError(error);
  }
}
```

- [ ] **Step 10: 写 `apps/web-next/app/api/runs/[runId]/rows/[rowId]/log/route.ts`**

```ts
/**
 * 执行日志一次性拉取：GET ?afterSeq=N（抽屉首帧与下载共用）。
 * `?afterSeq=abc` 必须是 400：静默当成 0 会让「只取增量」的调用方拿到全量，
 * 而它多半会以为自己在续订。
 */
import { getRowLog } from '@aieval/api';
import { z } from 'zod';
import { handleApiError } from '@/src/server-context';

/** 查询参数：afterSeq 可省；给了必须是 >= 0 的整数 */
const LogQuerySchema = z.object({ afterSeq: z.coerce.number().int().min(0).optional() });

export async function GET(
  req: Request,
  { params }: { params: Promise<{ runId: string; rowId: string }> },
): Promise<Response> {
  try {
    const { runId, rowId } = await params;
    const { afterSeq } = LogQuerySchema.parse(Object.fromEntries(new URL(req.url).searchParams));
    return Response.json(getRowLog(runId, rowId, afterSeq));
  } catch (error) {
    return handleApiError(error);
  }
}
```

- [ ] **Step 11: 写 `apps/web-next/app/api/runs/[runId]/rows/[rowId]/stream/route.ts`**

```ts
/**
 * 行级 SSE：唯一的实时通道（spec §8）。
 * 三处必须写死的口径：
 *   1. 响应头 `text/event-stream` + `cache-control: no-cache` + `connection: keep-alive`
 *      + `X-Accel-Buffering: no`（最后一条是给反向代理的：它默认会把 SSE 缓冲起来，
 *      表现是「事件全对，但要等连接结束才一起到」）；
 *   2. `afterSeq` 的来源优先级：`Last-Event-ID` 头 > `?afterSeq=`。浏览器自动重连时**只发头、
 *      不发 query**，而 query 里带的是首连那一刻的 seq——优先用头才能不重不漏；头的值非法就忽略；
 *   3. `runtime = 'nodejs'`：事件总线是**进程内**的（§11 R6），换到别的 runtime 会连不上编排层。
 */
import { streamRowEvents } from '@aieval/api';
import { handleApiError } from '@/src/server-context';

/** SSE 是长连接，不能被当成静态资源处理 */
export const dynamic = 'force-dynamic';
/** 进程内事件总线：必须与编排层同进程 */
export const runtime = 'nodejs';

/** 续订起点：优先 `Last-Event-ID`（浏览器重连只发这个头），非法值忽略并回落到 query */
function resolveAfterSeq(req: Request): number {
  const header = req.headers.get('last-event-id');
  if (header !== null) {
    const parsed = Number.parseInt(header, 10);
    if (Number.isInteger(parsed) && parsed >= 0) return parsed;
  }
  const raw = new URL(req.url).searchParams.get('afterSeq');
  if (raw === null) return 0;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ runId: string; rowId: string }> },
): Promise<Response> {
  try {
    const { runId, rowId } = await params;
    // 校验在开流之前完成：轮/行不存在时返回 404 JSON，而不是一个开了就结束的 SSE 流
    const stream = streamRowEvents(runId, rowId, resolveAfterSeq(req));
    return new Response(stream, {
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    });
  } catch (error) {
    return handleApiError(error);
  }
}
```

- [ ] **Step 12: 运行确认通过**

Run: `pnpm --filter @aieval/web-next test`
Expected: PASS（两份用例）。

若 diff 用例失败并提示 git 相关错误：先单独跑一次
`git -C <临时目录> status` 确认环境里 git 可用（core 的 git 原语本来就依赖真实 git CLI，spec §9 要求它禁 mock）。**不要**为了让用例变绿而把 `collectDiff` mock 掉——那等于删掉这条路由最需要守的东西。

Run: `pnpm typecheck`
Expected: 零错误。

- [ ] **Step 13: 提交**

```bash
git add apps/web-next/app/api/runs/route.ts apps/web-next/app/api/runs/model-options/route.ts "apps/web-next/app/api/runs/[runId]/route.ts" "apps/web-next/app/api/runs/[runId]/start/route.ts" "apps/web-next/app/api/runs/[runId]/abort/route.ts" "apps/web-next/app/api/runs/[runId]/rows/[rowId]/abort/route.ts" "apps/web-next/app/api/runs/[runId]/rows/[rowId]/diff/route.ts" "apps/web-next/app/api/runs/[runId]/rows/[rowId]/log/route.ts" "apps/web-next/app/api/runs/[runId]/rows/[rowId]/stream/route.ts" apps/web-next/src/route-runs.test.ts apps/web-next/src/route-run-artifacts.test.ts
git commit -m "feat(web-next): runs 路由（含 SSE 头与 Last-Event-ID）+ 候选池路由 + 路由测试"
```

---

## Task 11: `web-next` —— 评测页（列表 + 右栏 + 三个抽屉）与落地页核验

**Files:**
- Create: `apps/web-next/src/runs-view.ts`（+ `.test.ts`）
- Modify: `apps/web-next/app/runs/page.tsx`（整文件重写，替换占位页）
- 核验（不改动）：`apps/web-next/app/page.tsx`
- Create: `docs/superpowers/notes/2026-09-22-features-p5-smoke.md`（冒烟记录）

**Interfaces:**
- Consumes: Task 4/5 的全部 client hooks；Task 7/8/9 的全部 ui 组件；脚手架既有的 `AppTopNav` / `PageShell` / `ListDetailLayout` / `Toolbar` / `EllipsisText` / `EmptyState` / `format.ts`；p2 的 `useCases()`
- Produces: 评测页默认导出；`parseRunsPanel(search)`、`runsPanelHref(panel, id)`、`describeError(error)`、`type RunsPanelKind`、`type DrawerKind`

- [ ] **Step 1: 写失败测试 `apps/web-next/src/runs-view.test.ts`**

```ts
// @vitest-environment node
/**
 * 评测页的 URL 状态解析（纯函数）。
 * URL 是右栏状态的唯一真源（刷新与分享都能回到同一屏），所以「脏 URL 怎么办」必须在这里定死：
 * 未知 `panel`、空 `id`、`panel=detail` 但没有 id —— 一律回落到「不显示右栏」，
 * 绝不抛错、也绝不半开半合地渲染一条空右栏（那正是 ListDetailLayout 文件头警告的形态）。
 */
import { describe, expect, it } from 'vitest';
import { ServiceError } from '@aieval/contracts';
import { describeError, parseRunsPanel, runsPanelHref } from './runs-view';

describe('parseRunsPanel', () => {
  it.each([
    ['?panel=detail&id=run-1', { panel: 'detail', id: 'run-1' }],
    ['?panel=new', { panel: 'new', id: null }],
    // 创建表单不需要 id：带上也忽略
    ['?panel=new&id=run-1', { panel: 'new', id: null }],
    // 只有 id：当成详情（老链接/手敲 URL 的常见形态）
    ['?id=run-1', { panel: 'detail', id: 'run-1' }],
    // 空串 id 等于没给
    ['?panel=detail&id=', { panel: null, id: null }],
    ['?panel=detail', { panel: null, id: null }],
    // 未知 panel：有 id 当详情，没有就当没打开右栏
    ['?panel=foo&id=run-1', { panel: 'detail', id: 'run-1' }],
    ['?panel=foo', { panel: null, id: null }],
    ['', { panel: null, id: null }],
  ])('%s → %o', (search, expected) => {
    expect(parseRunsPanel(search)).toEqual(expected);
  });

  it('接受 URLSearchParams（页面里就是这么传的）', () => {
    expect(parseRunsPanel(new URLSearchParams('panel=detail&id=run-9'))).toEqual({ panel: 'detail', id: 'run-9' });
  });
});

describe('runsPanelHref', () => {
  it('三种状态各有稳定的 URL', () => {
    expect(runsPanelHref(null, null)).toBe('/runs');
    expect(runsPanelHref('new', null)).toBe('/runs?panel=new');
    expect(runsPanelHref('detail', 'run-1')).toBe('/runs?panel=detail&id=run-1');
    // detail 但没 id ⇒ 回落到「不显示右栏」，不留一个半开的 URL
    expect(runsPanelHref('detail', null)).toBe('/runs');
  });

  it('id 会被转义（不假设 id 永远只有 UUID 字符）', () => {
    expect(runsPanelHref('detail', 'a b&c')).toBe('/runs?panel=detail&id=a%20b%26c');
  });
});

describe('describeError', () => {
  it('ServiceError 用它的中文 message（契约要求 message 可直接展示）', () => {
    expect(describeError(new ServiceError('CONFLICT', '这一轮没有可执行的候选行：全部行都已评分'))).toBe(
      '这一轮没有可执行的候选行：全部行都已评分',
    );
  });

  it('其它抛出物兜底成一句中文，不透英文内部错误', () => {
    expect(describeError(new TypeError('Failed to fetch'))).toBe('操作失败，请稍后重试');
    expect(describeError('字符串')).toBe('操作失败，请稍后重试');
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @aieval/web-next test`
Expected: FAIL —— 收集阶段报 `Failed to resolve import "./runs-view" from "src/runs-view.test.ts". Does the file exist?`

- [ ] **Step 3: 写实现 `apps/web-next/src/runs-view.ts`**

```ts
/**
 * 评测页的 URL 状态解析与错误文案（纯函数，node 环境可测）。
 * 为什么单独成文件：`apps/web-next` 的 `jsx` 是 `preserve`，该应用里**不能写 .tsx 测试**，
 * 页面里可测的逻辑只能抽成 `.ts`；把「脏 URL 怎么落」抽出来，这条规则才有守卫。
 */
import { ServiceError } from '@aieval/contracts';

/** 右栏的两种内容（spec §5.3：同一个栏位换内容，不叠加、不弹层） */
export type RunsPanelKind = 'detail' | 'new';

/** 三个产物抽屉 */
export type DrawerKind = 'log' | 'diff' | 'score';

export interface RunsPanelState {
  /** null = 不显示右栏（列表占满） */
  panel: RunsPanelKind | null;
  id: string | null;
}

/**
 * 解析 `?panel=detail|new&id=…`。
 * 规则：`new` 忽略 id；`detail` 必须带非空 id，否则回落到「不显示右栏」；
 * 未知 `panel` 值按「有 id 就是详情」处理（旧链接/手敲 URL 不至于白屏）。
 */
export function parseRunsPanel(search: string | URLSearchParams): RunsPanelState {
  const params = typeof search === 'string' ? new URLSearchParams(search) : search;
  const rawId = params.get('id');
  const id = rawId === null || rawId === '' ? null : rawId;
  const rawPanel = params.get('panel');

  if (rawPanel === 'new') return { panel: 'new', id: null };
  if (rawPanel === 'detail' && id === null) return { panel: null, id: null };
  if (id === null) return { panel: null, id: null };
  return { panel: 'detail', id };
}

/** 面板 → URL；panel 为 null 时回到不带查询串的 `/runs`（「无右栏」这一态也可分享） */
export function runsPanelHref(panel: RunsPanelKind | null, id: string | null): string {
  if (panel === null) return '/runs';
  if (panel === 'new') return '/runs?panel=new';
  return id === null ? '/runs' : `/runs?panel=detail&id=${encodeURIComponent(id)}`;
}

/** 任意抛出物 → 可直接展示的中文文案（ServiceError 的 message 已是中文，其余不透内部细节） */
export function describeError(error: unknown): string {
  return error instanceof ServiceError ? error.message : '操作失败，请稍后重试';
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm --filter @aieval/web-next test`
Expected: PASS（Task 10 两份 + 本任务一份）。

- [ ] **Step 5: 重写 `apps/web-next/app/runs/page.tsx`**

```tsx
'use client';

/**
 * 评测页：左侧列表 + 右侧栏（详情 / 创建表单），形态与用例页同口径（spec §4.1/§5.3）。
 * 四条口径：
 *   1. `useSearchParams` 会把用到它的子树退化为客户端渲染，故给它一个 `Suspense` 边界
 *      （Next 16 文档 useSearchParams 的 Prerendering 一节）；
 *   2. **逐行 SSE 只在该行的日志抽屉打开时订阅**（spec §8 末段）：否则 10 个候选 × 多个评测
 *      会开出几十条长连接；
 *   3. 三个抽屉的数据各自按需取：日志 = `useRowStream`（实时）+ `useRowLog`（下载要全量）、
 *      改动 = `useRowDiff`（服务端每次现算）、评分详情 = 快照里的 `score`（不额外请求）；
 *   4. 页面的可测逻辑（URL 解析、错误文案）都在 `@/src/runs-view`，本文件只做拼装。
 */
import { Suspense, useState, type ReactNode } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Alert, App, Button, Drawer, Flex, Table, Tag, Typography } from 'antd';
import type { TableColumnsType } from 'antd';
import type { EvalRun, RunCreate } from '@aieval/contracts';
import {
  useAbortRow,
  useAbortRun,
  useCases,
  useCreateRun,
  useRowDiff,
  useRowLog,
  useRowStream,
  useRun,
  useRunModelOptions,
  useRuns,
  useStartRun,
} from '@aieval/client';
import {
  AppTopNav,
  DiffView,
  EllipsisText,
  EmptyState,
  ListDetailLayout,
  LogView,
  PageShell,
  RunCreatePanel,
  RunDetailPanel,
  ScoreDetailView,
  Toolbar,
  formatDateTime,
  formatEventLog,
} from '@aieval/ui';
import { NAV_ITEMS } from '@/src/nav';
import { describeError, parseRunsPanel, runsPanelHref, type DrawerKind } from '@/src/runs-view';

/** 轮级状态 → 中文与颜色（行级状态在 ui 的 RowStatusTag 里；轮级只有 4 个值） */
const RUN_STATUS_META: Record<EvalRun['status'], { label: string; color: string }> = {
  idle: { label: '未开始', color: 'default' },
  running: { label: '执行中', color: 'processing' },
  partial: { label: '部分完成', color: 'warning' },
  done: { label: '已完成', color: 'success' },
};

export default function Page(): ReactNode {
  // useSearchParams 需要 Suspense 边界：没有它，整页都会掉出预渲染
  return (
    <Suspense fallback={null}>
      <RunsPage />
    </Suspense>
  );
}

function RunsPage(): ReactNode {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { message } = App.useApp();
  const panel = parseRunsPanel(searchParams);
  const [drawer, setDrawer] = useState<{ kind: DrawerKind; rowId: string } | null>(null);

  const { runs, isLoading, error: listError } = useRuns();
  const selectedId = panel.panel === 'detail' ? panel.id : null;
  const { run, error: runError } = useRun(selectedId);
  const { cases } = useCases();
  const { optionsFor, capabilityOf } = useRunModelOptions();
  const { create, isCreating } = useCreateRun();
  const { start, isStarting } = useStartRun();
  const { abort, isAborting } = useAbortRun();
  const { abortRow } = useAbortRow();

  const runId = run?.id ?? '';
  const logRowId = drawer?.kind === 'log' ? drawer.rowId : null;
  const diffRowId = drawer?.kind === 'diff' ? drawer.rowId : null;
  // 只在该行的日志抽屉打开时才订阅它的事件流（spec §8 末段）
  const stream = useRowStream({ runId, rowId: logRowId ?? '', enabled: logRowId !== null });
  const log = useRowLog(runId, logRowId ?? '', logRowId !== null);
  const diff = useRowDiff(runId, diffRowId ?? '', diffRowId !== null);
  const scoreRow = drawer?.kind === 'score' ? (run?.rows.find((row) => row.id === drawer.rowId) ?? null) : null;

  /** 每次操作都收口到 `describeError`：ServiceError 的中文 message 直接展示，其余给兜底文案 */
  const guard = async (action: () => Promise<unknown>): Promise<void> => {
    try {
      await action();
    } catch (cause) {
      message.error(describeError(cause));
    }
  };

  const handleCreate = async (input: RunCreate): Promise<void> => {
    try {
      const created = await create(input);
      // 创建完直接进详情：使用者下一步一定是点「开始」
      router.replace(runsPanelHref('detail', created.id));
    } catch (cause) {
      message.error(describeError(cause));
    }
  };

  const closePanel = (): void => {
    setDrawer(null);
    router.replace(runsPanelHref(null, null));
  };

  /** 下载用 `/log` 的全量（而不是连接里收到的那份）：连接可能中途断过，落盘的那份才是完整的 */
  const handleDownloadLog = (): void => {
    const text = formatEventLog(log.events ?? stream.events);
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `row-${logRowId ?? 'log'}.log`;
    link.click();
    // 立即 revoke 会让部分浏览器拿不到内容，下一拍再释放
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  const columns: TableColumnsType<EvalRun> = [
    {
      title: '用例标题',
      dataIndex: 'caseTitle',
      render: (title: string) => <EllipsisText text={title} width={280} />,
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 96,
      render: (status: EvalRun['status']) => <Tag color={RUN_STATUS_META[status].color}>{RUN_STATUS_META[status].label}</Tag>,
    },
    {
      title: '候选数',
      dataIndex: 'rows',
      width: 80,
      align: 'right',
      render: (_rows: EvalRun['rows'], record) => record.rows.length,
    },
    {
      title: '执行模式',
      dataIndex: 'executionMode',
      width: 96,
      render: (mode: EvalRun['executionMode']) => (mode === 'serial' ? '串行' : '并行'),
    },
    {
      title: '创建时间',
      dataIndex: 'createdAt',
      width: 150,
      render: (createdAt: string) => formatDateTime(createdAt),
    },
  ];

  const list = (
    <Flex vertical style={{ height: '100%', minHeight: 0 }}>
      <Toolbar
        title="评测记录"
        extra={
          <Button size="small" type="primary" onClick={() => router.replace(runsPanelHref('new', null))}>
            创建评测
          </Button>
        }
      />
      {listError !== null && listError !== undefined && (
        <Alert type="error" showIcon title={`评测列表加载失败：${describeError(listError)}`} />
      )}
      {runs !== undefined && runs.length === 0 ? (
        <EmptyState
          title="还没有评测"
          description="先创建一个用例，再用它开一轮评测"
          action={{ label: '创建评测', onClick: () => router.replace(runsPanelHref('new', null)) }}
        />
      ) : (
        <Table<EvalRun>
          size="small"
          rowKey="id"
          loading={isLoading}
          columns={columns}
          dataSource={runs ?? []}
          pagination={false}
          scroll={{ y: 'calc(100vh - 240px)' }}
          onRow={(record) => ({
            onClick: () => router.replace(runsPanelHref('detail', record.id)),
            style:
              record.id === selectedId
                ? { background: 'var(--app-selected)', cursor: 'pointer' }
                : { cursor: 'pointer' },
          })}
        />
      )}
    </Flex>
  );

  const detail =
    panel.panel === 'new' ? (
      <RunCreatePanel
        cases={cases ?? []}
        modelOptionsFor={optionsFor}
        saving={isCreating}
        onSubmit={(input) => void handleCreate(input)}
        onCancel={closePanel}
      />
    ) : selectedId === null ? null : runError !== null && runError !== undefined && run === undefined ? (
      <EmptyState
        title="评测不存在或已被删除"
        description="它可能被手工清理过；回到列表重新选择一轮"
        action={{ label: '回到列表', onClick: closePanel }}
      />
    ) : run === undefined ? (
      <EmptyState title="正在加载评测…" />
    ) : (
      <RunDetailPanel
        run={run}
        starting={isStarting}
        aborting={isAborting}
        capabilityOf={capabilityOf}
        onStart={() => void guard(() => start(run.id))}
        onAbortRun={() => void guard(() => abort(run.id))}
        onAbortRow={(rowId) => void guard(() => abortRow(run.id, rowId))}
        onOpenLog={(rowId) => setDrawer({ kind: 'log', rowId })}
        onOpenDiff={(rowId) => setDrawer({ kind: 'diff', rowId })}
        onOpenScore={(rowId) => setDrawer({ kind: 'score', rowId })}
      />
    );

  return (
    <>
      <AppTopNav items={[...NAV_ITEMS]} active="runs" onNavigate={(href) => router.push(href)} />
      <PageShell padding={16}>
        <ListDetailLayout
          list={list}
          detail={detail}
          detailOpen={panel.panel !== null}
          widthStorageKey="runs-detail-width"
        />
      </PageShell>

      <Drawer
        title="执行日志"
        placement="right"
        size="large"
        open={drawer?.kind === 'log'}
        onClose={() => setDrawer(null)}
        destroyOnHidden
      >
        <LogView events={stream.events} connected={stream.connected} onDownload={handleDownloadLog} />
      </Drawer>

      <Drawer
        title="代码改动"
        placement="right"
        size="large"
        open={drawer?.kind === 'diff'}
        onClose={() => setDrawer(null)}
        destroyOnHidden
      >
        {diff.diff === undefined ? (
          <Typography.Text type="secondary">
            {diff.error === null || diff.error === undefined ? '正在计算改动…' : `读取失败：${describeError(diff.error)}`}
          </Typography.Text>
        ) : (
          <DiffView diff={diff.diff} />
        )}
      </Drawer>

      <Drawer
        title="评分详情"
        placement="right"
        size="large"
        open={drawer?.kind === 'score'}
        onClose={() => setDrawer(null)}
        destroyOnHidden
      >
        {scoreRow === null || scoreRow.score === null ? (
          <EmptyState title="这一行还没有评分" description="评分在 agent 跑完之后进行；失败的行不会有分" />
        ) : (
          <ScoreDetailView score={scoreRow.score} />
        )}
      </Drawer>
    </>
  );
}
```

- [ ] **Step 6: 跑类型检查与 lint**

Run: `pnpm typecheck`
Expected: 零错误。

Run: `pnpm lint`
Expected: 零错误。**特别确认** `apps/web-next/app/runs/page.tsx` 没有触发分层边界报错（它是框架层，可以 import `@aieval/*`）。

- [ ] **Step 7: 核验落地页（spec §12 的默认落地页）**

Read: `apps/web-next/app/page.tsx`
Expected: 内容与下面一致（**脚手架阶段已实现，本任务不改动**）：

```tsx
import { redirect } from 'next/navigation';

/** 默认落地页：核心动作是「创建评测 → 跑 → 看分」，故直接进评测列表。 */
export default function Page(): never {
  redirect('/runs');
}
```

若内容不同（例如被人改成了别的页面），按上面这份改回去——spec §12 明确「默认落地页 `/runs`」，冒烟第 1 项会核验它。

- [ ] **Step 8: 冒烟（真实服务 + CLI 互证）**

先备一个隔离的配置目录与工作区根目录，**不动使用者真实的 `~/.aieval`**：

```powershell
$smoke = Join-Path $env:TEMP ("aieval-p5-smoke-" + [guid]::NewGuid().ToString('N'))
$ws = Join-Path $smoke 'ws'
New-Item -ItemType Directory -Path $ws -Force | Out-Null
$config = @{
  settings = @{ theme = 'auto'; workspaceRoot = $ws; defaultJudge = $null; rowTimeoutMs = 1800000; diffBudgetBytes = 262144 }
  providers = @(
    @{ id = 'p-ant'; name = 'Anthropic 网关'; protocolType = 'anthropic'; baseUrl = 'https://gw.example.com/anthropic'; apiKey = 'sk-ant-smoke'; models = @(@{ id = 'claude-opus-4-6'; source = 'manual' }); createdAt = '2026-09-22T00:00:00.000Z'; updatedAt = '2026-09-22T00:00:00.000Z' },
    @{ id = 'p-oai'; name = 'OpenAI 网关'; protocolType = 'openai'; baseUrl = 'https://gw.example.com/v1'; apiKey = 'sk-oai-smoke'; models = @(@{ id = 'gpt-5'; source = 'fetched' }); createdAt = '2026-09-22T00:00:00.000Z'; updatedAt = '2026-09-22T00:00:00.000Z' }
  )
  cases = @(
    @{ id = 'c-smoke'; title = '多协议入站转换'; repoPath = 'D:\projects\gateway'; commitHash = $null; taskPrompt = '补齐转换'; judgePrompt = '按 5 维打分'; judgeProviderId = $null; judgeModelId = $null; createdAt = '2026-09-22T00:00:00.000Z'; updatedAt = '2026-09-22T00:00:00.000Z' }
  )
}
# 用 node 写盘：PowerShell 的 ConvertTo-Json 在 5.1 下会带 BOM，而我们要的是干净 JSON
$config | ConvertTo-Json -Depth 8 | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{require('fs').writeFileSync(process.argv[1],s,'utf8')})" (Join-Path $smoke 'config.json')
Write-Output "smoke=$smoke ws=$ws"
```

Run（另起一个后台作业，带上隔离的配置目录）：

```powershell
$env:AIEVAL_CONFIG_DIR = '<上一步输出的 smoke 路径>'
pnpm dev
```

逐项验证并记录证据（浏览器操作 + CLI 互证）：

| # | 操作 | 期望 | 证据 |
|---|---|---|---|
| 1 | 浏览器打开 `http://localhost:3083/` | 落到 `/runs`，顶栏「评测」高亮 | URL + 顶栏高亮截图 |
| 2 | 打开 `/runs`（无评测） | 空态 + 「创建评测」引导按钮 | 文案截图 |
| 3 | 点「创建评测」 | 右栏出现创建表单，URL 变成 `/runs?panel=new` | URL + 表单字段（用例/执行模式/智能体/模型）截图 |
| 4 | 默认行选「Claude Code」 | 模型下拉只有 anthropic 供应商的模型（`claude-opus-4-6`），来源标「手工维护」 | 下拉展开截图 |
| 5 | 把该行换成「Codex」 | 模型下拉变成 `gpt-5`（来源「自动拉取」），上一行选的 anthropic 模型被清空 | 下拉截图 |
| 6 | 删掉唯一候选行后点「创建评测」 | 出现「至少需要一个候选行」，且没有 POST 请求 | `browser_network_requests` 过滤 `/api/runs` 无 POST |
| 7 | 选回一行并提交 | 右栏切到详情；列表最上面出现该轮（状态「未开始」） | 截图 + `Get-ChildItem -Recurse $ws -Filter run.json` 看到落盘 |
| 8 | 读详情顶部信息行与吸底栏 | 用例标题 · 仓库路径 · `默认分支 HEAD` · 工作基目录 四项齐全；吸底栏固定在右栏可视区底部 | `browser_evaluate` 读 footer 的 `getBoundingClientRect()` 与右栏宿主的高度，确认 `footer.bottom <= 视口高` 且滚到底后 `bottom` 不变 |
| 9 | 点「开始」 | 弹确认框，列出「本次将执行 1 个候选：· Claude Code · claude-opus-4-6」 | 弹窗截图 + 文案 |
| 10 | 点「取消」；改 `run.json` 把该行置为 `running` 并给它一个 diff 摘要，再刷新 | 卡片状态变「执行中」、卡片上出现「diff 已截断」 | CLI：`node -e "const fs=require('fs');const p='<run.json>';const r=JSON.parse(fs.readFileSync(p,'utf8'));r.status='running';r.rows[0].status='running';r.rows[0].diff={filesChanged:2,insertions:5,deletions:1,truncated:true};fs.writeFileSync(p,JSON.stringify(r,null,2),'utf8')"` + 卡片截图 |
| 11 | 打开「代码改动」抽屉 | 显示文件清单与统一 diff；CLI 在**该轮 `workspaceBase`** 下 `git diff` 的结果与页面一致 | 先用 CLI 建工作区真仓库：`git -C "$ws/<runId>/rows/<rowId>/workspace" init` → 提交一次 → 改一个文件 → 把 `baselineCommit` 写进 run.json；再对比页面与 `git -C … diff HEAD` |
| 12 | 打开「执行日志」抽屉，再用 CLI 逐条追加事件 | 抽屉先显示历史（含 `/log` 请求），随后**实时**出现新行（走 `/stream`）；关闭抽屉后 `/stream` 请求结束 | CLI：`Add-Content -Path "$ws/<runId>/rows/<rowId>/events.jsonl" -Value '{"seq":1,"at":"2026-09-22T08:00:00.000Z","type":"status","status":"running"}' -Encoding utf8`；证据：`browser_network_requests` 过滤 `/stream`，以及追加前后抽屉文本 |
| 13 | 追加一条 `end` 事件 | 抽屉保留全量日志；随后出现一次 `GET /api/runs/<runId>`（终态后 mutate 快照） | `browser_network_requests` 过滤 `/api/runs/` |
| 14 | 点「下载」 | 落下一个 `.log` 文件，内容与抽屉一致 | 文件内容前几行 |
| 15 | 访问 `http://localhost:3083/runs?panel=detail&id=不存在的id` | 右栏显示「评测不存在或已被删除」，不白屏 | 截图 |
| 16 | 点单行的「终止」 | 弹 `Popconfirm`；确认后发出 POST `/api/runs/<runId>/rows/<rowId>/abort` | `browser_network_requests` + `run.json` 的实际变化（**状态语义**由 p6 的真实编排冒烟覆盖，本项只验界面链路与请求） |

第 10–13 项是**本阶段最关键的实时性证据**：它们证明 SSE 通道真的通、终态真的会关连接并刷新快照——这三件事在真实编排（p6 的 9 项冒烟）里才会跑真 agent，这里的成本为零。

把每一项的结果（通过 / 不通过 + 证据）写进 `docs/superpowers/notes/2026-09-22-features-p5-smoke.md`：范围清单、操作路径、证据（浏览器状态 + CLI 输出互证）、未覆盖项与后续计划。**只写实际观察到的输出**，不要写「应该没问题」。

停止后台 dev 作业。

- [ ] **Step 9: 提交**

```bash
git add apps/web-next/app/runs/page.tsx apps/web-next/src/runs-view.ts apps/web-next/src/runs-view.test.ts docs/superpowers/notes/2026-09-22-features-p5-smoke.md
git commit -m "feat(web-next): 评测页（列表 + 右栏详情/创建 + 三个产物抽屉 + 逐行 SSE 按需订阅）"
```

---

## 完成后的交接

p5 完成后，评测域的界面链路已经全通：创建（协议过滤的候选池）→ 列表/详情（排名、串行进度、吸底操作栏）→ 三个产物抽屉 → 行级 SSE 实时追加。

交给 p6（冒烟与关账）的三件事：

1. **真实编排的 9 项冒烟**（spec §9）需要真实网关与真实 CLI，p5 的冒烟刻意全部用手工写入的事件与手工建的仓库完成——两者互补，不重复；
2. **`recoverInterruptedRuns()` 的挂载点唯一在 `apps/web-next/instrumentation.ts`**（由 p4 建立，契约 §5 明确 p5 不得再挂第二处）。p5 没有创建过 `instrumentation.ts`，如果执行期发现它存在，不要动它；
3. **`/cases` 页与 p5 的形态完全同构**（`ListDetailLayout` + `?panel=`）：p2 落地用例页时可以直接抄 `apps/web-next/src/runs-view.ts` 的解析结构与 `app/runs/page.tsx` 的 `guard` / `closePanel` 两个收口点。

