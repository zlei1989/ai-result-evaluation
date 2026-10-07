# 功能阶段 p0 实施计划：契约、git 与工作区引擎

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把功能阶段所有跨包契约一次建全（errors / provider / case / run / score / agent-event + 汇总出口），把 `core` 的 git CLI 原语、工作区目录结构与事件日志落盘做实，并在 `evaluator` 里落下 `callTextApi` / `resolveJudgeRoute` 两个自包含模块——p1–p5 六份计划只消费、不重写。

**Architecture:** contracts 是唯一真源（zod schema + `z.infer` 领域类型 + 错误码表），所有跨端名字在这里定稿；`core` 是零业务依赖的引擎层，只碰 git 进程与磁盘（Node 内置 + contracts），对外吐的是「建好的工作区 / 合并后的 diff 文本 / 追加有序事件」；`evaluator` 在 p0 只落两个不依赖编排状态机的模块（双协议非流式文本调用与评分路由解析），p4 再在它之上搭状态机。git 原语的正确性只能由真实 git CLI 证明——mock 掉的正是最容易错的地方。

**Tech Stack:** pnpm workspaces · TypeScript 5（strict + noUncheckedIndexedAccess + verbatimModuleSyntax）· zod 3 · vitest 4 · Node 内置（node:child_process 调 git CLI）

**Spec:** docs/superpowers/specs/2026-09-22-features-design.md §3 F13 / §5.5 / §6.3 / §7 / §9 / §10

**Interfaces source:** docs/superpowers/notes/2026-09-22-features-plan-interfaces.md（§2 contracts、§3 core、§5 evaluator）

## Global Constraints

- 包名 `@aieval/*`；依赖方向由 `eslint.shared.ts` 的 `withBoundary()` 硬约束（含动态 `import()` 与 `require()`，禁跨包相对引用）：`core` 只用 Node 内置 + `contracts`，`evaluator` 可用 `agents / core / contracts`，`contracts` 谁都不依赖。
- 源码一律 ESM（禁 `require()`）；`verbatimModuleSyntax` 开着，**类型必须 `import type`**，否则编译报错。
- 时间字段一律 ISO 8601 带时区字符串（`new Date().toISOString()`）；实体 id 一律 UUID v4（`node:crypto` 的 `randomUUID()`），由服务端在创建时生成。
- 写盘原子（临时文件 + `renameSync`），读盘容忍 UTF-8 BOM；配置目录 `AIEVAL_CONFIG_DIR` > `~/.aieval`，测试用 `setConfigDirForTesting()`，**绝不触碰真实 `~/.aieval`**。
- 注释 JSDoc 中文，先说「做什么」再说「怎么做」；文件头写职责 + 注意事项；日志走 `createLogger(scope)`，上下文作为 `console` 第二参数（**不 `JSON.stringify`**）。
- 契约里钉死的名字与签名**逐字照抄**，不得发明新名字、不得改窄签名；`contracts` 的 `index.ts` 必须汇总导出 §2 的每一个名字。
- **git 原语的测试必须用真实 git CLI，禁 mock**（spec §9）。测试用 `node:fs` + `node:os` 建临时目录与临时 git 仓库；`git commit` 一律带 `-c user.email=... -c user.name=...` 或先做局部 `git config`，否则 CI / 新机器上没有全局身份会直接 commit 失败。测试结束清临时目录。
- 每条新增的回归守卫必须做**变异验证**：把要拦的缺陷人为制造回去（改实现、不改测试）→ 贴出期望的失败输出 → 还原 → 核对文件哈希。没有见过失败的守卫不算守卫。
- 每个任务结束时 `pnpm typecheck` 零错误；收尾任务跑 `pnpm lint` 与全量 `pnpm test`。
- 纯函数测试文件顶部标 `// @vitest-environment node`；单包命令形如 `pnpm --filter @aieval/core test`。
- **提交用逐个显式 `git add <路径>`，禁 `git add -A`**（本仓可能同时有别的会话在工作）。提交信息中文，形如 `feat(core): …`。
- 默认取值（与 `SETTINGS_DEFAULTS` 一致，不得改）：`rowTimeoutMs = 1_800_000`、`diffBudgetBytes = 262_144`（256KB）、`workspaceRoot = '~/.runs'`。
- 分支名固定 `test/{rowId}`（行 id 是 UUID v4，文件系统与 git 引用名双安全）；仓库里不再有其它分支命名规则。

**任务编号与执行顺序**：Task 1 → 2 → 3 → **5** → **4** → 6 → 7 → 8 → 9 → 10 → 11 → 12 → 13 → 14 → 15。编号按「交付物」排（contracts 的五个 schema 文件各一个任务），而 `run.ts`（Task 4）要用到 `score.ts`（Task 5）的 `ScoreResultSchema`，所以这两步对调——**Task 4 的 Files 与 Interfaces 一节已显式标注这个前置**，其余任务严格按编号顺序执行即可（Task 10 依赖 Task 9 建好的 `execute`/`gitMessage`，Task 13 依赖 9–12，Task 15 收尾）。

## 本计划对 spec 的实现层修正

逐条对应接口契约 §11，本计划是它们的落地处：

- **R1（`AGENT_KINDS` 真源在 contracts）**：`AGENT_KINDS` / `AgentKind` / `AGENT_LABELS` 定义在 `contracts/src/run.ts`（Task 4），`agents` 包在 p3 只做再导出——contracts 不能 import agents，而 §5.6.2 又要求前端下拉与 `EvalRow.agentKind` 同源。
- **R2（`EvalRow.baselineCommit` 是 40 位具体 hash）**：Task 4 的 `EvalRowSchema` 增 `baselineCommit: z.string()`（**允许空串 = 尚未准备**：创建评测时基线还没解析，prepare 阶段由 p4 写入具体 hash）；Task 4 的 `checkoutRow()` 在 `commitHash: null` 时把工作区的 `HEAD` **解析成具体 hash 再返回**（`rev-parse HEAD`），而不是把 `null` 或短哈希透出去——它是 `collectDiff` 唯一的比较基线。
- **R3（三样 diff 的取法）**：Task 10 的 `collectDiff()` 依次取 `git status --porcelain -z`（未跟踪清单）、`git diff HEAD --numstat`（未提交计数）、`git add --intent-to-add --all`（只登记不暂存）、`git diff {baseline}..HEAD` + `git diff HEAD`（两份正文）、`git diff --numstat {baseline}..HEAD`（已提交计数）。`--intent-to-add` 让未跟踪文件的**正文**进入 `git diff HEAD`；不加它就只有文件名，评分模型看不见新文件内容。**被 gitignore 的文件不在此列**（见 §11 R3 的实测结论与 R19 的裁定：`git add` 根本没有 `--include-ignored` 这个选项，且把 `.env` / 构建产物送进评分提示词是密钥泄漏与噪声双重风险）。
- **R3 的取法细节（实测结论，本机 `git version 2.47.0.windows.2`）**：三样 diff 的**调用顺序不可调换**——未跟踪清单必须在 `git add --intent-to-add --all` **之前**读：实测 `-N` 之后 `git status --porcelain` 里 `?? b.txt` 会变成 ` A b.txt`，此时再解析 `??` 会得到空清单。同时 `git diff HEAD --numstat` 直接给每个文件的「插入 / 删除」两列（实测 `1	1	a.txt` / `1	0	b.txt`），`RowDiff.files` 与三个计数都由它派生，不必自己解析 `diff --git` 块。Task 10 的实现与用例严格按这份实测结论写。
- **R4（三个新错误码）**：Task 1 把 `NOT_A_GIT_REPO` / `INVALID_REF` / `JUDGE_PARSE_FAILED` 追加进 `ERROR_CODES`（顺序追加在 `INTERNAL` 之前），并补齐 `STATUS_BY_CODE`（400 / 400 / 500）——`httpStatusFor` 要求每个 `ErrorCode` 都有映射。`AgentErrorCode` 仍独立成组（§5.6.6），**不进** `ERROR_CODES`。
- **R8（`EvalRow.providerId` 是必需字段）**：Task 4 的 `EvalRowSchema` 里它是必填的 `z.string().min(1)`，与展示快照 `providerName` / `baseUrl` 并存——执行期要用它定位凭据（`resolveJudgeRoute` 与编排层都按 id 去 `config.providers` 里取 `apiKey`），而展示用的名字是可以被改的。`RunCreateSchema.rows[].providerId` 已是同一个名字，两端一致。
- **R9（`EvalRow.error.code` 是必需字段）**：Task 4 的 `EvalRowSchema` 里 `error` 的形状是 `{ code: string; message: string; stack?: string }`——`code` 来自 `AgentErrorCode`（§5.6.6）或 `ErrorCode`（如 `JUDGE_PARSE_FAILED`），界面靠它区分「超时 / 限流 / 密钥无效 / 评分解析失败」，只留 `message` 会让界面只能按文案猜。注意它仍是 `z.string()` 而不是枚举：这一格要同时容纳两组码，写死任一组都会漏。
- **R5（`callTextApi` + `resolveJudgeRoute` 归 p0）**：Task 14 在 `evaluator` 建立这两个模块。用例域（p2）的「AI 生成评分提示词」在编排（p4）之前就要用生成能力，而 `api` 本来就依赖 `evaluator`；两处各写一份「非流式文本 API + 双协议路由」必然漂移。

## Review Focus

以下五类输入/条件 spec 没有明说，但坏了会直接伤到使用者。每条都在对应任务的测试里钉住，前三条另有变异验证：

1. **diff 预算小于单文件、甚至小于段落头本身**——`diffBudgetBytes` 是用户可改的（设置页 `InputNumber`），设成 4096 时整个 diff 可能一个文件都装不下。期望：绝不产出「看起来像没改动」的空文本（至少留段落头 + 「已截断」标记 + 被丢弃文件清单），且 `truncated` 必须为 `true`。落在 **Task 10**（用例：预算极小；变异体 C：删掉截断标记）。
2. **agent 新写的未跟踪 / 被 gitignore 的文件**——只取 `commit..HEAD`、不做 `--intent-to-add`、或把未跟踪清单读在 `-N` 之后，都会让它们**内容不可见**（实测 `-N` 之后 `?? b.txt` 变成 ` A b.txt`，按 `??` 过滤会得到空清单），评分模型把「看不到的改动」当成「没改」，静默给出错误高分（spec §5.5 第 6 步）。期望：新文件正文逐字出现在合并后的 diff 文本里。落在 **Task 10**（三个专门用例 + 变异体 A / B 两条）。
3. **`events.jsonl` 里有写坏的行**（进程被杀在写一半、磁盘满、手工编辑）——期望日志抽屉仍能显示其余全部事件、顺序不乱，而不是整段历史消失或抛出解析异常。落在 **Task 12**（用例：坏行 + 空行 + 合法行混排，坏行跳过且 `warn`）。
4. **仓库路径给成裸仓库 / 指向文件 / 已删除的目录**——git 的原始报错是英文 `fatal: …`，直接透给用户等于没解释。期望：一律 `NOT_A_GIT_REPO` + 含路径的中文原因，且**当路径本身不存在时不去执行 git**（避免把 `ENOENT` 误报成「不是 git 仓库」）。落在 **Task 4**（三个用例）。
5. **测试污染真实 `~/.aieval`（用户已有配置）**——本计划要跑真 git 进程，一旦某个模块顺手 `loadConfig()` 落在真实家目录，跑一次测试就会覆盖用户的供应商与明文密钥。期望：每个用临时目录的 `core` 测试都在 `beforeEach` 调 `setConfigDirForTesting(tmp)` 并断言 `getConfigDir()` 指向它。落在 **Task 10 / Task 11**（每个测试文件的 `beforeEach` + Task 15 的收尾核验步骤）。

---

## 文件结构总览

```
packages/server/contracts/src/
├── errors.ts             # 改：追加 NOT_A_GIT_REPO / INVALID_REF / JUDGE_PARSE_FAILED
├── errors.test.ts        # 改：错误码集合与状态映射的回归守卫
├── provider.ts           # 新：ProtocolType / Provider / ProviderView / maskApiKey + 三个入参 schema
├── provider.test.ts      # 新
├── case.ts               # 新：TestCase / CaseCreate / CasePatch / RepoInfo / CommitCandidate + 校验入参
├── case.test.ts          # 新
├── run.ts                # 新：AGENT_KINDS / EvalRowStatus / EvalRow（含 R2 基线、R8 providerId、R9 error.code）/ EvalRun / RunCreate / RowDiff + 两个判定
├── run.test.ts           # 新
├── score.ts              # 新：5 维定义 / ScoreResult / composeTotalScore / JUDGE_OUTPUT_CONTRACT（必须在 run.ts 之前落地）
├── score.test.ts         # 新
├── agent-event.ts        # 新：AgentEvent 判别联合（§7.4 七个成员）+ AGENT_EVENT_TYPES
├── agent-event.test.ts   # 新
├── index.ts              # 改：汇总导出上述全部名字
└── index.test.ts         # 新：从包根导入全部契约，证明出口没漏（typecheck 是另一半守卫）

packages/server/core/src/
├── config-store.ts       # 改：删四个本地类型声明，改用 contracts 的 Provider / TestCase / ProtocolType
├── config-store.test.ts  # 改：加一条「AppConfig 与契约同形」的往返用例
├── git.ts                # 新：git CLI 原语（校验 / commit 判定 / 缓存克隆 / 复制 / 建分支 / 三样 diff / 裁剪）
├── git.repo.test.ts      # 新：真实 git CLI，仓库校验 + commit 判定 + 克隆缓存 + 复制 + 建分支
├── git.diff.test.ts      # 新：真实 git CLI，三样 diff 合并的四种组合（含「未提交」「未跟踪正文」「-N 之前读清单」三条专门用例）+ 裁剪
├── workspace.ts          # 新：工作区目录结构 + prepareRowWorkspace
├── workspace.test.ts     # 新：真实 git CLI + 真实目录复制
├── event-log.ts          # 新：events.jsonl 追加 / 读取 / 续订 / 清空
├── event-log.test.ts     # 新
└── index.ts              # 改：补齐 git / workspace / event-log 出口

packages/server/evaluator/src/
├── text-api.ts           # 新：callTextApi（openai / anthropic 双协议非流式）
├── text-api.test.ts      # 新：stub global fetch，断言 URL / 头 / 解析 / 错误映射
├── judge-route.ts        # 新：resolveJudgeRoute（用例覆盖 > 全局默认）
├── judge-route.test.ts   # 新
└── index.ts              # 改：导出两个模块
```

`packages/server/evaluator/package.json` 与各包 `vitest.config.ts` / `eslint.config.ts` **不需要改**：`@aieval/evaluator` 的依赖里已经有 `@aieval/core` 与 `@aieval/contracts`，测试要用的 `globalThis.fetch` 是 Node 18+ 内置，`vitest.node.ts` 的 `include: ['src/**/*.test.ts']` 已覆盖本计划新增的全部测试文件。

---

## Task 1: contracts —— 追加三个错误码（R4）

**Files:**
- Modify: `packages/server/contracts/src/errors.ts`（`ERROR_CODES` 数组第 13–14 行之间插入三行；`STATUS_BY_CODE` 第 33–41 行之间插入三条）
- Modify: `packages/server/contracts/src/errors.test.ts`（第 6–12 行的 `ERROR_CODES` 用例；第 32–41 行的 `httpStatusFor` 用例）

**Interfaces:**
- Consumes: 无（本计划第一个任务）
- Produces: `ERROR_CODES` 追加 `'NOT_A_GIT_REPO' | 'INVALID_REF' | 'JUDGE_PARSE_FAILED'`（`type ErrorCode` 随之变宽）；`httpStatusFor('NOT_A_GIT_REPO') === 400`、`httpStatusFor('INVALID_REF') === 400`、`httpStatusFor('JUDGE_PARSE_FAILED') === 500`

- [ ] **Step 1: 改失败测试 `errors.test.ts`**

把 `describe('ERROR_CODES')` 那条用例替换为下面两条，并把 `describe('httpStatusFor')` 的第一条用例换掉：

```ts
describe('ERROR_CODES', () => {
  it('包含脚手架阶段与功能阶段的全部错误码（顺序：4xx 在前、5xx 在后）', () => {
    expect([...ERROR_CODES]).toEqual([
      'NOT_FOUND',
      'INVALID_QUERY',
      'NOT_WRITABLE',
      'NOT_A_GIT_REPO',
      'INVALID_REF',
      'CONFLICT',
      'AUTH_FAILED',
      'RATE_LIMITED',
      'JUDGE_PARSE_FAILED',
      'INTERNAL',
    ]);
  });

  it('AgentErrorCode 不进 ERROR_CODES（§5.6.6：它没有对应的 HTTP 状态）', () => {
    // 这两个名字是 agents 包的领域归因，与接口层的 AUTH_FAILED / RATE_LIMITED 只是重名。
    // 一旦有人把它们并进 ERROR_CODES，STATUS_BY_CODE 就要为它们编造状态码。
    expect(ERROR_CODES).not.toContain('AGENT_FAILED');
    expect(ERROR_CODES).not.toContain('AGENT_LOAD_FAILED');
    expect(ERROR_CODES).not.toContain('AGENT_TIMED_OUT');
    expect(ERROR_CODES).not.toContain('AGENT_CANCELED');
  });
});
```

`httpStatusFor` 的第一条用例：

```ts
  it('每个错误码都映射到期望状态码', () => {
    expect(httpStatusFor('NOT_FOUND')).toBe(404);
    expect(httpStatusFor('INVALID_QUERY')).toBe(400);
    expect(httpStatusFor('NOT_WRITABLE')).toBe(400);
    expect(httpStatusFor('NOT_A_GIT_REPO')).toBe(400);
    expect(httpStatusFor('INVALID_REF')).toBe(400);
    expect(httpStatusFor('CONFLICT')).toBe(409);
    expect(httpStatusFor('AUTH_FAILED')).toBe(401);
    expect(httpStatusFor('RATE_LIMITED')).toBe(429);
    expect(httpStatusFor('JUDGE_PARSE_FAILED')).toBe(500);
    expect(httpStatusFor('INTERNAL')).toBe(500);
  });
```

第二条用例（「对每个错误码都有映射」）**保持原样不动**——它是「新增错误码时忘了补 `STATUS_BY_CODE`」的既有守卫，`STATUS_BY_CODE` 是 `Record<ErrorCode, number>`，漏一条会先被 `tsc` 拦下，这条断言是运行时的第二道。

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @aieval/contracts test`
Expected: FAIL —— `errors.test.ts` 有两处失败：① `toEqual` 的数组少了三项，报 `- Expected + Received` 且 `Received` 里没有 `NOT_A_GIT_REPO`；② `httpStatusFor('NOT_A_GIT_REPO')` 返回 `undefined`（`expected undefined to be 400`）。

- [ ] **Step 3: 最小实现（改 `errors.ts`）**

`ERROR_CODES` 改成（注释列对齐现有风格，语义取自 spec §10）：

```ts
export const ERROR_CODES = [
  'NOT_FOUND',          // 404  实体不存在
  'INVALID_QUERY',      // 400  请求参数 / 请求体不合法（context 带 zod issues）
  'NOT_WRITABLE',       // 400  目录不可写
  'NOT_A_GIT_REPO',     // 400  仓库路径非法 / 不是 git 仓库（§10；context 带 path 与 git 原文）
  'INVALID_REF',        // 400  commit hash 不存在（§10；context 带 path 与 hash）
  'CONFLICT',           // 409  状态冲突
  'AUTH_FAILED',        // 401  上游凭据无效（context 带 host）
  'RATE_LIMITED',       // 429  上游限流
  'JUDGE_PARSE_FAILED', // 500  评分模型返回不可解析 / 维度缺失（§5.7、§10；context 带 raw 原文）
  'INTERNAL',           // 500  其它内部错误
] as const;
```

`STATUS_BY_CODE` 改成：

```ts
/** code → HTTP 状态码（Record<ErrorCode, number>：漏一条 tsc 直接报错） */
const STATUS_BY_CODE: Record<ErrorCode, number> = {
  NOT_FOUND: 404,
  INVALID_QUERY: 400,
  NOT_WRITABLE: 400,
  NOT_A_GIT_REPO: 400,
  INVALID_REF: 400,
  CONFLICT: 409,
  AUTH_FAILED: 401,
  RATE_LIMITED: 429,
  JUDGE_PARSE_FAILED: 500,
  INTERNAL: 500,
};
```

三个新码的排列位置不是随意的：`ERROR_CODES` 的既有口径是「4xx 在前、5xx 在后」，前两个是 400、第三个是 500，故插在 `INTERNAL` 之前、`RATE_LIMITED` 之后。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @aieval/contracts test`
Expected: PASS（`errors.test.ts` 全绿：3 个 `describe` / 7 个 `it`）。

Run: `pnpm typecheck`
Expected: 通过（`STATUS_BY_CODE` 与 `ERROR_CODES` 同步变宽）。

- [ ] **Step 5: 提交**

```bash
git add packages/server/contracts/src/errors.ts packages/server/contracts/src/errors.test.ts
git commit -m "feat(contracts): 追加三个功能阶段错误码（NOT_A_GIT_REPO / INVALID_REF / JUDGE_PARSE_FAILED）"
```

---

## Task 2: contracts —— `provider.ts`

**Files:**
- Create: `packages/server/contracts/src/provider.ts`
- Create: `packages/server/contracts/src/provider.test.ts`

**Interfaces:**
- Consumes: 无
- Produces（逐字来自契约 §2.2）：
  - `ProtocolTypeSchema: z.ZodEnum<['openai', 'anthropic']>`、`type ProtocolType`
  - `PROTOCOL_LABELS: Record<ProtocolType, string>`
  - `ProviderModelSchema`、`type ProviderModel`
  - `ProviderSchema`、`type Provider`
  - `ProviderViewSchema`、`type ProviderView`
  - `maskApiKey(apiKey: string): string`
  - `ProviderCreateSchema`、`type ProviderCreate`、`ProviderPatchSchema`、`type ProviderPatch`
  - `ProviderModelInputSchema`、`type ProviderModelInput`

- [ ] **Step 1: 写失败测试 `provider.test.ts`**

```ts
// @vitest-environment node
/**
 * 供应商契约：协议枚举、掩码函数、入参 schema 的默认值与部分性。
 * 注意：这里最有价值的一条是「ProviderView 里绝不能出现明文 apiKey」——它是下行出口的唯一守卫。
 */
import { describe, expect, it } from 'vitest';
import {
  PROTOCOL_LABELS,
  ProviderCreateSchema,
  ProviderModelInputSchema,
  ProviderPatchSchema,
  ProviderSchema,
  ProviderViewSchema,
  ProtocolTypeSchema,
  maskApiKey,
} from './provider';

/** 一条合法的落盘记录，作为各用例的基准 */
const provider = {
  id: 'p-1',
  name: 'DeepSeek 官方',
  protocolType: 'openai' as const,
  baseUrl: 'https://api.deepseek.com/v1',
  apiKey: 'sk-abcdefghijklmn',
  models: [{ id: 'deepseek-chat', source: 'fetched' as const }],
  createdAt: '2026-09-22T10:30:00.000Z',
  updatedAt: '2026-09-22T10:30:00.000Z',
};

describe('ProtocolTypeSchema', () => {
  it('只认 openai / anthropic 两种协议（F1 的唯一判据）', () => {
    expect(ProtocolTypeSchema.safeParse('openai').success).toBe(true);
    expect(ProtocolTypeSchema.safeParse('anthropic').success).toBe(true);
    expect(ProtocolTypeSchema.safeParse('gemini').success).toBe(false);
    expect(ProtocolTypeSchema.safeParse('OpenAI').success).toBe(false);
  });
});

describe('PROTOCOL_LABELS', () => {
  it('两种协议都有中文标签，且不含空文案', () => {
    expect(PROTOCOL_LABELS.openai).toBe('OpenAI 兼容');
    expect(PROTOCOL_LABELS.anthropic).toBe('Anthropic 兼容');
    for (const protocol of ProtocolTypeSchema.options) {
      expect(PROTOCOL_LABELS[protocol].length).toBeGreaterThan(0);
    }
  });
});

describe('maskApiKey', () => {
  it('保留前 3 后 4', () => {
    expect(maskApiKey('sk-abcdefghijklmn')).toBe('sk-**********klmn');
  });

  it('长度 <8 时全掩码（前 3 后 4 会重叠，等于把密钥原样吐出来）', () => {
    expect(maskApiKey('sk-abc')).toBe('******');
    expect(maskApiKey('')).toBe('');
    expect(maskApiKey('1234567')).toBe('*******');
  });

  it('掩码结果里绝不出现原文（8 位边界值：前 3 后 4 恰好覆盖前 7 位）', () => {
    const key = 'abcdefgh';
    const masked = maskApiKey(key);
    expect(masked).toBe('abc*efgh');
    expect(masked).not.toBe(key);
  });
});

describe('ProviderViewSchema', () => {
  it('解析后没有 apiKey 字段，只有 apiKeyMasked（下行出口的唯一守卫）', () => {
    const view = ProviderViewSchema.parse({ ...provider, apiKeyMasked: maskApiKey(provider.apiKey) });
    expect('apiKey' in view).toBe(false);
    expect(view.apiKeyMasked).toBe('sk-**********klmn');
    // keyof 层面的第二道：即便将来有人误用 strip 行为的对象，字段名也不该出现
    expect(Object.keys(view)).not.toContain('apiKey');
  });

  it('缺 apiKeyMasked 时校验失败（不允许「忘了掩码」的响应悄悄通过）', () => {
    expect(ProviderViewSchema.safeParse(provider).success).toBe(false);
  });
});

describe('Provider schema', () => {
  it('ProviderSchema 接受完整落盘记录，且拒绝空的 name / apiKey', () => {
    expect(ProviderSchema.safeParse(provider).success).toBe(true);
    expect(ProviderSchema.safeParse({ ...provider, name: '' }).success).toBe(false);
    expect(ProviderSchema.safeParse({ ...provider, apiKey: '' }).success).toBe(false);
    expect(ProviderSchema.safeParse({ ...provider, models: [{ id: 'm', source: 'guess' }] }).success).toBe(false);
  });

  it('ProviderModelInputSchema 就是 ProviderModelSchema（增删单条模型共用一份口径）', () => {
    expect(ProviderModelInputSchema.safeParse({ id: 'gpt-4o', source: 'manual' }).success).toBe(true);
    expect(ProviderModelInputSchema.safeParse({ id: '', source: 'manual' }).success).toBe(false);
  });
});

describe('ProviderCreateSchema / ProviderPatchSchema', () => {
  it('创建时 models 缺省为 []（新建供应商必然还没有模型清单）', () => {
    const parsed = ProviderCreateSchema.parse({
      name: '网关',
      protocolType: 'anthropic',
      baseUrl: 'https://gw.example.com/anthropic',
      apiKey: 'sk-x',
    });
    expect(parsed.models).toEqual([]);
  });

  it('补丁允许空对象与只给一个字段（不允许把 name 清空）', () => {
    expect(ProviderPatchSchema.safeParse({}).success).toBe(true);
    expect(ProviderPatchSchema.safeParse({ name: '新名字' }).success).toBe(true);
    expect(ProviderPatchSchema.safeParse({ name: '' }).success).toBe(false);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @aieval/contracts test`
Expected: FAIL —— `Failed to resolve import "./provider" from "src/provider.test.ts"`。

- [ ] **Step 3: 写实现 `provider.ts`**

> **注记（2026-09-26，Anthropic 拉取口径修订）—— 下面这份 `provider.ts` 里 `ProtocolTypeSchema` 的那行注释已过期，勿照抄。**
> 现行代码的注释是「协议类型只决定**文本调用怎么接线**（`/chat/completions` vs `/v1/messages`），**不决定能不能拉模型清单**」，
> 拉取按地址形态兜底（`GET {地址}/models`，**仅 404** 时依次回退 `{地址}/v1/models`、站点根 `/models`、站点根 `/v1/models`），见 spec §3 F1 / §6.1 的 2026-09-26 修订与 2026-09-30 再修订。
> 上面的行文是 Task 1 当时的形态，**保留原文不改**。

```ts
/**
 * 供应商契约：协议类型、落盘形态、下行形态与增删改入参。
 * 三个必须成立的口径：
 *   1. 协议类型是「模型能否驱动某智能体」的唯一判据（spec §3 F1），故它是枚举而不是自由字符串；
 *   2. 落盘形态含**明文** apiKey（服务端要原 token 才能代调供应商 API），因此它只在服务端内部流转；
 *   3. 下行形态（ProviderView）用 omit 掉 apiKey 而不是「记得别传」——字段的存在与否由类型保证。
 */
import { z } from 'zod';

/** 协议类型：openai 兼容 / anthropic 兼容。Anthropic 没有 /models 接口，模型名只能手工维护 */
export const ProtocolTypeSchema = z.enum(['openai', 'anthropic']);
export type ProtocolType = z.infer<typeof ProtocolTypeSchema>;

/** 协议类型的中文标签：设置页与候选池提示共用，避免两处各写一份 */
export const PROTOCOL_LABELS: Record<ProtocolType, string> = {
  openai: 'OpenAI 兼容',
  anthropic: 'Anthropic 兼容',
};

/** 模型清单条目：source 区分自动拉取与手工维护（拉取是合并，不能冲掉手工项，见 spec §6.1） */
export const ProviderModelSchema = z.object({
  id: z.string().min(1),
  source: z.enum(['fetched', 'manual']),
});
export type ProviderModel = z.infer<typeof ProviderModelSchema>;

/** 落盘形态：含明文 apiKey，只在服务端内部流转 */
export const ProviderSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  protocolType: ProtocolTypeSchema,
  baseUrl: z.string().min(1),
  apiKey: z.string().min(1),
  models: z.array(ProviderModelSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Provider = z.infer<typeof ProviderSchema>;

/** 下行形态：apiKey 已掩码（spec §6.1「落盘后列表只显示掩码」） */
export const ProviderViewSchema = ProviderSchema.omit({ apiKey: true }).extend({ apiKeyMasked: z.string() });
export type ProviderView = z.infer<typeof ProviderViewSchema>;

/**
 * 密钥掩码：保留前 3 后 4，中间用 `*` 填满。
 * 长度 < 8 时全掩码——前 3 与后 4 会重叠，逐字保留等于把密钥原样吐回界面。
 * 空串返回空串：不制造 `****` 这种「看起来配了一个密钥」的假象。
 */
export function maskApiKey(apiKey: string): string {
  if (apiKey === '') return '';
  if (apiKey.length < 8) return '*'.repeat(apiKey.length);
  return `${apiKey.slice(0, 3)}${'*'.repeat(apiKey.length - 7)}${apiKey.slice(-4)}`;
}

/** 新增供应商入参：models 缺省为空数组（新供应商必然还没有模型清单） */
export const ProviderCreateSchema = z.object({
  name: z.string().min(1),
  protocolType: ProtocolTypeSchema,
  baseUrl: z.string().min(1),
  apiKey: z.string().min(1),
  models: z.array(ProviderModelSchema).default([]),
});
export type ProviderCreate = z.infer<typeof ProviderCreateSchema>;

/** 部分更新：所有字段可选；空对象合法（无改动） */
export const ProviderPatchSchema = ProviderCreateSchema.partial();
export type ProviderPatch = z.infer<typeof ProviderPatchSchema>;

/** 单条模型的增删入参（spec §8 的 models 路由）：与落盘条目同形，避免两套字段名 */
export const ProviderModelInputSchema = ProviderModelSchema;
export type ProviderModelInput = z.infer<typeof ProviderModelInputSchema>;
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @aieval/contracts test`
Expected: PASS（`provider.test.ts` 共 6 个 `describe` / 11 个 `it` 全绿）。

Run: `pnpm typecheck`
Expected: 通过。

- [ ] **Step 5: 提交**

```bash
git add packages/server/contracts/src/provider.ts packages/server/contracts/src/provider.test.ts
git commit -m "feat(contracts): 供应商契约（协议枚举 + 密钥掩码 + 落盘/下行双形态）"
```

---

## Task 3: contracts —— `case.ts`

**Files:**
- Create: `packages/server/contracts/src/case.ts`
- Create: `packages/server/contracts/src/case.test.ts`

**Interfaces:**
- Consumes: 无
- Produces（逐字来自契约 §2.3）：
  - `TestCaseSchema`、`type TestCase`
  - `CaseCreateSchema`、`type CaseCreate`、`CasePatchSchema`、`type CasePatch`
  - `RepoInfoSchema`、`type RepoInfo`
  - `CommitCandidateSchema`、`type CommitCandidate`
  - `RepoPathInputSchema`
  - `GenerateJudgePromptSchema`、`type GenerateJudgePromptInput`

- [ ] **Step 1: 写失败测试 `case.test.ts`**

```ts
// @vitest-environment node
/**
 * 用例契约：默认值（commitHash / 评分模型可为 null）、部分更新、仓库与 commit 的两个校验入参。
 * 注意：`commitHash: null` 不是「缺失」而是「用默认分支 HEAD」，故它必须是 nullable 而不是 optional。
 */
import { describe, expect, it } from 'vitest';
import {
  CaseCreateSchema,
  CasePatchSchema,
  CommitCandidateSchema,
  GenerateJudgePromptSchema,
  RepoInfoSchema,
  RepoPathInputSchema,
  TestCaseSchema,
} from './case';

const testCase = {
  id: 'c-1',
  title: '实现一个 LRU 缓存',
  repoPath: 'D:/repos/demo',
  commitHash: null,
  taskPrompt: '在这个仓库里实现一个 LRU 缓存',
  judgePrompt: '请按 5 个维度打分',
  judgeProviderId: null,
  judgeModelId: null,
  createdAt: '2026-09-22T10:30:00.000Z',
  updatedAt: '2026-09-22T10:30:00.000Z',
};

describe('TestCaseSchema', () => {
  it('接受完整记录，且要求必填文本非空', () => {
    expect(TestCaseSchema.safeParse(testCase).success).toBe(true);
    expect(TestCaseSchema.safeParse({ ...testCase, title: '' }).success).toBe(false);
    expect(TestCaseSchema.safeParse({ ...testCase, repoPath: '' }).success).toBe(false);
    expect(TestCaseSchema.safeParse({ ...testCase, taskPrompt: '' }).success).toBe(false);
    expect(TestCaseSchema.safeParse({ ...testCase, judgePrompt: '' }).success).toBe(false);
  });

  it('commitHash 必须是 null 或非空字符串（空串不是「用 HEAD」的写法）', () => {
    expect(TestCaseSchema.safeParse({ ...testCase, commitHash: 'abc1234' }).success).toBe(true);
    expect(TestCaseSchema.safeParse({ ...testCase, commitHash: '' }).success).toBe(false);
  });
});

describe('CaseCreateSchema', () => {
  it('四个可空字段缺省为 null（留空 = 用默认分支 HEAD / 全局默认评分模型）', () => {
    const parsed = CaseCreateSchema.parse({
      title: 't',
      repoPath: 'D:/r',
      taskPrompt: 'p',
      judgePrompt: 'j',
    });
    expect(parsed.commitHash).toBeNull();
    expect(parsed.judgeProviderId).toBeNull();
    expect(parsed.judgeModelId).toBeNull();
  });

  it('拒绝把可空字段写成 undefined 之外的空串', () => {
    expect(
      CaseCreateSchema.safeParse({
        title: 't', repoPath: 'D:/r', taskPrompt: 'p', judgePrompt: 'j', commitHash: '',
      }).success,
    ).toBe(false);
  });
});

describe('CasePatchSchema', () => {
  it('允许空补丁与单字段补丁（改标题不该被迫重填仓库路径）', () => {
    expect(CasePatchSchema.safeParse({}).success).toBe(true);
    expect(CasePatchSchema.parse({ title: '新标题' })).toEqual({ title: '新标题' });
  });
});

describe('RepoInfoSchema / CommitCandidateSchema', () => {
  it('回显仓库名与当前分支（spec §4.2「通过后回显仓库名与当前分支」）', () => {
    const info = RepoInfoSchema.parse({ repoPath: 'D:/repos/demo', repoName: 'demo', branch: 'main' });
    expect(info.repoName).toBe('demo');
    expect(info.branch).toBe('main');
    expect(RepoInfoSchema.safeParse({ repoPath: 'D:/repos/demo', repoName: 'demo' }).success).toBe(false);
  });

  it('commit 候选是 hash + subject 两个字段', () => {
    expect(CommitCandidateSchema.safeParse({ hash: 'abc1234', subject: '初始提交' }).success).toBe(true);
    expect(CommitCandidateSchema.safeParse({ hash: 'abc1234' }).success).toBe(false);
  });
});

describe('校验入参', () => {
  it('仓库校验只按仓库路径，不按 caseId（§11 R7：新建时还没有 caseId）', () => {
    expect(RepoPathInputSchema.safeParse({ repoPath: 'D:/repos/demo' }).success).toBe(true);
    expect(RepoPathInputSchema.safeParse({ repoPath: '' }).success).toBe(false);
    expect(RepoPathInputSchema.safeParse({ caseId: 'c-1' }).success).toBe(false);
  });

  it('生成评分提示词在仓库路径之上叠加考题与可空的评分模型', () => {
    const parsed = GenerateJudgePromptSchema.parse({ repoPath: 'D:/r', taskPrompt: '写个 LRU' });
    expect(parsed.judgeProviderId).toBeNull();
    expect(parsed.judgeModelId).toBeNull();
    expect(GenerateJudgePromptSchema.safeParse({ repoPath: 'D:/r' }).success).toBe(false);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @aieval/contracts test`
Expected: FAIL —— `Failed to resolve import "./case" from "src/case.test.ts"`。

- [ ] **Step 3: 写实现 `case.ts`**

```ts
/**
 * 用例契约：用例实体、增删改入参、仓库与 commit 的校验入参。
 * 三个必须成立的口径：
 *   1. `commitHash: null` 的语义是「用默认分支 HEAD」，所以是 nullable 而不是 optional——
 *      空串不合法，避免「留空」在落盘时变成两种不同的值；
 *   2. 仓库校验与 commit 候选按**仓库路径**入参（§11 R7）：创建用例时还没有 caseId，
 *      而这两件事的输入本来就是仓库路径；
 *   3. 用例上的评分模型可留空 = 用设置页的全局默认（spec §3 F5）。
 */
import { z } from 'zod';

export const TestCaseSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  repoPath: z.string().min(1),
  /** null = 默认分支 HEAD；填了必须能通过 `git cat-file -e <hash>^{commit}` */
  commitHash: z.string().min(1).nullable(),
  taskPrompt: z.string().min(1),
  judgePrompt: z.string().min(1),
  /** null = 用设置页的全局默认评分模型 */
  judgeProviderId: z.string().min(1).nullable(),
  judgeModelId: z.string().min(1).nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type TestCase = z.infer<typeof TestCaseSchema>;

/** 新建用例入参：三个可空字段缺省为 null，表单不填就是「用默认」 */
export const CaseCreateSchema = z.object({
  title: z.string().min(1),
  repoPath: z.string().min(1),
  commitHash: z.string().min(1).nullable().default(null),
  taskPrompt: z.string().min(1),
  judgePrompt: z.string().min(1),
  judgeProviderId: z.string().min(1).nullable().default(null),
  judgeModelId: z.string().min(1).nullable().default(null),
});
export type CaseCreate = z.infer<typeof CaseCreateSchema>;

/** 部分更新：只给要改的字段（改标题不该被迫重填仓库路径） */
export const CasePatchSchema = CaseCreateSchema.partial();
export type CasePatch = z.infer<typeof CasePatchSchema>;

/** 仓库校验结果（spec §4.2「通过后回显仓库名与当前分支」） */
export const RepoInfoSchema = z.object({
  repoPath: z.string(),
  repoName: z.string(),
  branch: z.string(),
});
export type RepoInfo = z.infer<typeof RepoInfoSchema>;

/** commit 候选（spec §4.2 最近 20 条）：纯便利功能，手工输入任意合法 hash 仍然可行 */
export const CommitCandidateSchema = z.object({
  hash: z.string(),
  subject: z.string(),
});
export type CommitCandidate = z.infer<typeof CommitCandidateSchema>;

/** 校验入参：**按仓库路径**而不是按 caseId（见 §11 R7） */
export const RepoPathInputSchema = z.object({ repoPath: z.string().min(1) });

/** 生成评分提示词入参：仓库名要进提示词，考题提示词是题面上下文 */
export const GenerateJudgePromptSchema = RepoPathInputSchema.extend({
  taskPrompt: z.string().min(1),
  judgeProviderId: z.string().min(1).nullable().default(null),
  judgeModelId: z.string().min(1).nullable().default(null),
});
export type GenerateJudgePromptInput = z.infer<typeof GenerateJudgePromptSchema>;
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @aieval/contracts test`
Expected: PASS（`case.test.ts` 共 6 个 `describe` / 9 个 `it` 全绿）。

Run: `pnpm typecheck`
Expected: 通过。

- [ ] **Step 5: 提交**

```bash
git add packages/server/contracts/src/case.ts packages/server/contracts/src/case.test.ts
git commit -m "feat(contracts): 用例契约（实体 + 增删改入参 + 仓库/commit 校验入参）"
```

---

## Task 4: contracts —— `run.ts`（含 R1 的 `AGENT_KINDS`、R2 的 `baselineCommit`、R8/R9 的两个字段）

**Files:**
- Create: `packages/server/contracts/src/run.ts`
- Create: `packages/server/contracts/src/run.test.ts`
- 前置：**Task 5 的 `score.ts` 必须先落地** —— `EvalRowSchema.score` 用 `ScoreResultSchema.nullable()`，故实际执行顺序为 Task 1 → 2 → 3 → **5** → 4 → 6 → 7。

**Interfaces:**
- Consumes: Task 5 的 `ScoreResultSchema`
- Produces（逐字来自契约 §2.4）：
  - `AGENT_KINDS`、`AgentKindSchema`、`type AgentKind`、`AGENT_LABELS`
  - `ExecutionModeSchema`、`type ExecutionMode`
  - `EvalRowStatusSchema`、`type EvalRowStatus`、`TERMINAL_ROW_STATUSES`、`ROW_STATUS_LABELS`
  - `EvalRowSchema`、`type EvalRow`
  - `EvalRunSchema`、`type EvalRun`
  - `RunCreateSchema`、`type RunCreate`
  - `RowDiffSchema`、`type RowDiff`
  - `isRunnableRow(status: EvalRowStatus): boolean`、`isRunningRow(status: EvalRowStatus): boolean`

- [ ] **Step 1: 写失败测试 `run.test.ts`**

```ts
// @vitest-environment node
/**
 * 评测契约：智能体真源、行状态机、EvalRow / EvalRun 形状、创建入参、diff 响应、两个可执行性判定。
 * 注意：本文件最有价值的六条守卫分别是
 *   ① AGENT_KINDS 与 §5.6.2 的表同序同值（R1）；
 *   ② TERMINAL_ROW_STATUSES / ROW_STATUS_LABELS 覆盖全部状态（新增状态时忘同步会当场红）；
 *   ③ isRunnableRow 的集合划分（judged 不可重跑，preparing/running/judging 不是「可执行」而是「在跑」）；
 *   ④ EvalRow.baselineCommit 必填但允许空串（R2：没有它 diff 没有可比基线；空串 = 尚未准备）；
 *   ⑤ EvalRow.providerId 必填（R8：展示快照会被改名，凭据只能按 id 定位）；
 *   ⑥ EvalRow.error.code 必填（R9：界面要靠它区分超时 / 限流 / 密钥无效 / 评分解析失败）。
 */
import { describe, expect, it } from 'vitest';
import {
  AGENT_KINDS,
  AGENT_LABELS,
  AgentKindSchema,
  EvalRowSchema,
  EvalRowStatusSchema,
  EvalRunSchema,
  ExecutionModeSchema,
  ROW_STATUS_LABELS,
  RowDiffSchema,
  RunCreateSchema,
  TERMINAL_ROW_STATUSES,
  isRunnableRow,
  isRunningRow,
  type EvalRowStatus,
} from './run';
import { DIMENSIONS } from './score';

describe('AGENT_KINDS', () => {
  it('三家智能体与 spec §5.6.2 的表同序同值（R1：真源在 contracts）', () => {
    expect([...AGENT_KINDS]).toEqual(['claude-code', 'codex', 'dsh']);
    expect(AgentKindSchema.options).toEqual([...AGENT_KINDS]);
  });

  it('每家都有中文标签', () => {
    expect(AGENT_LABELS['claude-code']).toBe('Claude Code');
    expect(AGENT_LABELS.codex).toBe('Codex');
    expect(AGENT_LABELS.dsh).toBe('DeepSeek Harness');
  });
});

describe('ExecutionModeSchema', () => {
  it('只有并行与串行两种', () => {
    expect(ExecutionModeSchema.options).toEqual(['parallel', 'serial']);
    expect(ExecutionModeSchema.safeParse('both').success).toBe(false);
  });
});

describe('EvalRowStatus', () => {
  it('十个状态与 spec §5.4 的状态机逐字一致（拼错 timed-out 会让终态判定失效）', () => {
    expect(EvalRowStatusSchema.options).toEqual([
      'pending', 'preparing', 'running', 'judging', 'judged',
      'failed', 'timed-out', 'canceled', 'skipped', 'interrupted',
    ]);
  });

  it('终态集合覆盖全部非运行态，且不含三个运行态', () => {
    for (const status of EvalRowStatusSchema.options) {
      const isRunning = status === 'preparing' || status === 'running' || status === 'judging';
      const isPending = status === 'pending';
      expect(TERMINAL_ROW_STATUSES.includes(status)).toBe(!isRunning && !isPending);
    }
  });

  it('每个状态都有中文文案（新增状态时忘补文案会当场红）', () => {
    for (const status of EvalRowStatusSchema.options) {
      expect(ROW_STATUS_LABELS[status].length).toBeGreaterThan(0);
    }
    expect(ROW_STATUS_LABELS.judged).toBe('已评分');
    expect(ROW_STATUS_LABELS['timed-out']).toBe('已超时');
  });
});

describe('isRunnableRow / isRunningRow', () => {
  it('可执行的六种状态：pending / failed / timed-out / canceled / interrupted / skipped', () => {
    const runnable: EvalRowStatus[] = ['pending', 'failed', 'timed-out', 'canceled', 'interrupted', 'skipped'];
    for (const status of EvalRowStatusSchema.options) {
      expect(isRunnableRow(status)).toBe(runnable.includes(status));
    }
  });

  it('judged 不可重跑（跑完的行不能被「开始」重跑一遍）', () => {
    expect(isRunnableRow('judged')).toBe(false);
  });

  it('三种运行态属「在跑」而不是「可执行」——界面靠它禁用开始按钮', () => {
    const running: EvalRowStatus[] = ['preparing', 'running', 'judging'];
    for (const status of EvalRowStatusSchema.options) {
      expect(isRunningRow(status)).toBe(running.includes(status));
    }
    expect(isRunningRow('pending')).toBe(false);
    expect(isRunnableRow('running')).toBe(false);
  });
});

describe('RowDiffSchema', () => {
  it('同时给出正文、截断标志、文件清单与丢弃清单（§5.3 第三个抽屉 + §8 diff 路由）', () => {
    const diff = {
      text: '### 已提交改动（abc..HEAD）\n（无）\n',
      truncated: true,
      files: [{ path: 'a.ts', insertions: 3, deletions: 1 }],
      filesChanged: 1,
      insertions: 3,
      deletions: 1,
      droppedFiles: ['b.ts'],
    };
    expect(RowDiffSchema.safeParse(diff).success).toBe(true);
    expect(RowDiffSchema.safeParse({ ...diff, droppedFiles: undefined }).success).toBe(false);
  });
});

describe('EvalRowSchema / EvalRunSchema / RunCreateSchema', () => {
  const row = {
    id: 'row-1',
    agentKind: 'claude-code' as const,
    providerId: 'p-1',
    providerName: '网关',
    baseUrl: 'https://gw.example.com/anthropic',
    modelId: 'claude-opus-4-6',
    status: 'pending' as const,
    branch: 'test/row-1',
    workspacePath: 'D:/runs/run-1/rows/row-1/workspace',
    baselineCommit: 'a'.repeat(40),
    tokens: null,
    turns: null,
    durationMs: null,
    diff: null,
    score: null,
    error: null,
  };

  it('EvalRow 的 baselineCommit 是必填字段，但允许空串表示「尚未准备」（R2）', () => {
    expect(EvalRowSchema.safeParse(row).success).toBe(true);
    const { baselineCommit: _omitted, ...withoutBaseline } = row;
    expect(EvalRowSchema.safeParse(withoutBaseline).success).toBe(false);
    // 空串必须合法：创建评测时基线还没解析（要等 prepare 阶段 rev-parse HEAD），
    // 而 p5 的 createRun 落库时只能填 ''；只有 prepare 之后它才必然是非空 40 位 hash。
    // 若这里恢复成 .min(1)，真实链路上「创建评测」会直接抛 ZodError（p5 的测试 mock 了 evaluator，
    // 所以只有 p6 的冒烟第 3 项才会暴露）。
    expect(EvalRowSchema.safeParse({ ...row, baselineCommit: '' }).success).toBe(true);
  });

  it('EvalRow 要求 providerId（R8）：展示快照 providerName 可以被改名，凭据只能靠 id 定位', () => {
    const { providerId: _dropped, ...withoutProviderId } = row;
    expect(EvalRowSchema.safeParse(withoutProviderId).success).toBe(false);
    expect(EvalRowSchema.safeParse({ ...row, providerId: '' }).success).toBe(false);
  });

  it('EvalRow.error 必须带 code（R9），且 code 是自由字符串而不是枚举', () => {
    // 这一格要同时容纳 AgentErrorCode（§5.6.6）与接口层 ErrorCode（如 JUDGE_PARSE_FAILED），
    // 写死任一组都会漏——所以是 z.string() 但**必填**
    expect(EvalRowSchema.safeParse({ ...row, error: { message: 'CLI 未安装' } }).success).toBe(false);
    expect(EvalRowSchema.safeParse({ ...row, error: { code: 'AGENT_FAILED', message: 'CLI 未安装' } }).success).toBe(true);
    expect(EvalRowSchema.safeParse({ ...row, error: { code: 'JUDGE_PARSE_FAILED', message: '维度缺失' } }).success).toBe(true);
    expect(
      EvalRowSchema.safeParse({ ...row, error: { code: 'AGENT_FAILED', message: 'CLI 未安装', stack: 'at …' } }).success,
    ).toBe(true);
  });

  it('EvalRow 拒绝错误的 agentKind', () => {
    expect(EvalRowSchema.safeParse({ ...row, agentKind: 'cursor' }).success).toBe(false);
  });

  it('EvalRun 冗余快照字段必填（删掉用例后仍要说得清当时测的是什么）', () => {
    const run = {
      id: 'run-1',
      caseId: 'c-1',
      caseTitle: 'LRU 缓存',
      repoPath: 'D:/repos/demo',
      commitHash: null,
      status: 'idle' as const,
      executionMode: 'parallel' as const,
      rows: [row],
      workspaceBase: 'D:/runs',
      createdAt: '2026-09-22T10:30:00.000Z',
      startedAt: null,
      finishedAt: null,
    };
    expect(EvalRunSchema.safeParse(run).success).toBe(true);
    expect(EvalRunSchema.safeParse({ ...run, caseTitle: undefined }).success).toBe(false);
    expect(EvalRunSchema.safeParse({ ...run, status: 'paused' }).success).toBe(false);
  });

  it('RunCreate 至少一行候选，每行三个字段都必填', () => {
    const input = {
      caseId: 'c-1',
      executionMode: 'serial',
      rows: [{ agentKind: 'codex', providerId: 'p-1', modelId: 'gpt-5' }],
    };
    expect(RunCreateSchema.safeParse(input).success).toBe(true);
    expect(RunCreateSchema.safeParse({ ...input, rows: [] }).success).toBe(false);
    expect(RunCreateSchema.safeParse({ ...input, rows: [{ agentKind: 'codex', providerId: 'p-1' }] }).success).toBe(false);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @aieval/contracts test`
Expected: FAIL —— `Failed to resolve import "./run" from "src/run.test.ts"`。

- [ ] **Step 3: 写实现 `run.ts`**

```ts
/**
 * 评测契约：智能体真源、行状态机、评测与候选行形状、创建入参、diff 响应。
 * 四个必须成立的口径：
 *   1. `AGENT_KINDS` 是三家智能体 id 的**唯一真源**（§11 R1）——agents 包再导出它，
 *      前端下拉与 `EvalRow.agentKind` 都从这里派生；contracts 反向不依赖 agents；
 *   2. `EvalRow.baselineCommit` 在 prepare 之后是 40 位**具体** hash（§11 R2）——`commitHash: null` 时
 *      diff 没有可比基线，准备阶段必须把 `HEAD` 解析成具体 hash 再写入；
 *   3. `TERMINAL_ROW_STATUSES` 供 SSE 判断「收到它即可关连接」（§8），
 *      `isRunnableRow` 供「开始」按钮判断哪些行会被执行（§5.3），两者语义不同不可互相替代；
 *   4. 两张标签表都是 `Record<枚举, string>`——新增枚举成员时 tsc 直接报错，
 *      不会出现「界面上一格空白」。
 */
import { z } from 'zod';
import { ScoreResultSchema } from './score';

/** 三家智能体 id 的**唯一真源**（见 §11 R1）：agents 包再导出它，contracts 反向不依赖 agents */
export const AGENT_KINDS = ['claude-code', 'codex', 'dsh'] as const;
export const AgentKindSchema = z.enum(AGENT_KINDS);
export type AgentKind = (typeof AGENT_KINDS)[number];

/** 智能体中文标签（设置页与候选池共用） */
export const AGENT_LABELS: Record<AgentKind, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  dsh: 'DeepSeek Harness',
};

/** 执行模式：并行不设并发上限，串行一行跑完（含评分）才起下一行（spec §5.2） */
export const ExecutionModeSchema = z.enum(['parallel', 'serial']);
export type ExecutionMode = z.infer<typeof ExecutionModeSchema>;

export const EvalRowStatusSchema = z.enum([
  'pending', 'preparing', 'running', 'judging', 'judged',
  'failed', 'timed-out', 'canceled', 'skipped', 'interrupted',
]);
export type EvalRowStatus = z.infer<typeof EvalRowStatusSchema>;

/**
 * 终态集合：SSE 收到它即可关连接（§8）。
 * 顺序不参与界面排序，只用于判定——`pending` 与三个运行态都不在内。
 */
export const TERMINAL_ROW_STATUSES: readonly EvalRowStatus[] = [
  'judged', 'failed', 'timed-out', 'canceled', 'skipped', 'interrupted',
];

/** 行状态的中文文案（「串行排队中」不在此列，那是界面按 mode + 位置派生的文案） */
export const ROW_STATUS_LABELS: Record<EvalRowStatus, string> = {
  pending: '待开始',
  preparing: '准备中',
  running: '执行中',
  judging: '评分中',
  judged: '已评分',
  failed: '失败',
  'timed-out': '已超时',
  canceled: '已终止',
  skipped: '未执行（串行队列）',
  interrupted: '被重启打断',
};

export const EvalRowSchema = z.object({
  id: z.string().min(1),
  agentKind: AgentKindSchema,
  /** 执行期定位凭据用（R8）：按 id 去 config.providers 取 apiKey；供应商改名后这里仍指向同一条 */
  providerId: z.string().min(1),
  /** 冗余快照：供应商被改名或删除后仍能追溯这一行用的什么模型（§7.2） */
  providerName: z.string(),
  baseUrl: z.string(),
  modelId: z.string(),
  status: EvalRowStatusSchema,
  /** test/{rowId}：用行 id 而非轮 id，否则同用例下多候选会互相踩（§5.5） */
  branch: z.string(),
  workspacePath: z.string(),
  /** 40 位具体 hash（§11 R2）；**空串 = 尚未准备**：创建时为 ''，prepare 阶段解析 HEAD 后由 p4 写入 */
  baselineCommit: z.string(),
  /** null = 该次运行未采到计量；**绝不填 0**（§5.6.3） */
  tokens: z.object({ input: z.number(), cached: z.number(), output: z.number() }).nullable(),
  turns: z.number().nullable(),
  durationMs: z.number().nullable(),
  /** 只存计数摘要，diff 正文按需现算（§7.2） */
  diff: z
    .object({
      filesChanged: z.number(),
      insertions: z.number(),
      deletions: z.number(),
      truncated: z.boolean(),
    })
    .nullable(),
  score: ScoreResultSchema.nullable(),
  /**
   * 失败归因（R9）：`code` 必填——界面靠它区分「超时 / 限流 / 密钥无效 / 评分解析失败」，
   * 只留 message 的话界面只能按文案猜。它是 `z.string()` 而不是枚举：这一格要同时容纳
   * agents 包的 `AgentErrorCode`（§5.6.6）与接口层的 `ErrorCode`（如 `JUDGE_PARSE_FAILED`）。
   */
  error: z.object({ code: z.string(), message: z.string(), stack: z.string().optional() }).nullable(),
});
export type EvalRow = z.infer<typeof EvalRowSchema>;

export const EvalRunSchema = z.object({
  id: z.string().min(1),
  caseId: z.string().min(1),
  /** 冗余快照：用例被删除后仍能追溯这一轮测的是什么（§7.2） */
  caseTitle: z.string(),
  repoPath: z.string(),
  commitHash: z.string().nullable(),
  status: z.enum(['idle', 'running', 'partial', 'done']),
  executionMode: ExecutionModeSchema,
  rows: z.array(EvalRowSchema),
  workspaceBase: z.string(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
});
export type EvalRun = z.infer<typeof EvalRunSchema>;

/** 创建评测：每候选行给智能体 + 供应商 + 模型；供应商名与 baseUrl 由服务端快照进行 */
export const RunCreateSchema = z.object({
  caseId: z.string().min(1),
  executionMode: ExecutionModeSchema,
  rows: z
    .array(
      z.object({
        agentKind: AgentKindSchema,
        providerId: z.string().min(1),
        modelId: z.string().min(1),
      }),
    )
    .min(1),
});
export type RunCreate = z.infer<typeof RunCreateSchema>;

/** 「代码改动」抽屉的按需响应（§5.3 第三个抽屉 + §8 的 diff 路由） */
export const RowDiffSchema = z.object({
  text: z.string(),
  truncated: z.boolean(),
  files: z.array(z.object({ path: z.string(), insertions: z.number(), deletions: z.number() })),
  filesChanged: z.number(),
  insertions: z.number(),
  deletions: z.number(),
  droppedFiles: z.array(z.string()),
});
export type RowDiff = z.infer<typeof RowDiffSchema>;

/**
 * 「开始」按钮的可执行行判定（§5.3）：终态里除了 judged 都可重跑。
 * judged 排除在外是刻意的——已经出分的行不该被一次误点重跑掉几十分钟。
 */
export function isRunnableRow(status: EvalRowStatus): boolean {
  return (
    status === 'pending' ||
    status === 'failed' ||
    status === 'timed-out' ||
    status === 'canceled' ||
    status === 'interrupted' ||
    status === 'skipped'
  );
}

/** 该行此刻是否在跑（含准备与评分两段）：界面靠它禁用「开始」与启用「终止」 */
export function isRunningRow(status: EvalRowStatus): boolean {
  return status === 'preparing' || status === 'running' || status === 'judging';
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @aieval/contracts test`
Expected: PASS（`run.test.ts` 共 7 个 `describe` / 13 个 `it` 全绿）。

Run: `pnpm typecheck`
Expected: 通过。

- [ ] **Step 5: 提交**

```bash
git add packages/server/contracts/src/run.ts packages/server/contracts/src/run.test.ts
git commit -m "feat(contracts): 评测契约（智能体真源 + 行状态机 + 基线 commit + diff 响应）"
```

---

## Task 5: contracts —— `score.ts`

**Files:**
- Create: `packages/server/contracts/src/score.ts`
- Create: `packages/server/contracts/src/score.test.ts`

**Interfaces:**
- Consumes: 无
- Produces（逐字来自契约 §2.5）：
  - `DimensionKeySchema`、`type DimensionKey`
  - `DIMENSIONS: readonly { key: DimensionKey; label: string }[]`、`DIMENSION_COUNT`
  - `DimensionScoreSchema`、`type DimensionScore`
  - `ScoreResultSchema`、`type ScoreResult`
  - `composeTotalScore(scores: readonly number[]): number`
  - `JUDGE_OUTPUT_CONTRACT: string`

- [ ] **Step 1: 写失败测试 `score.test.ts`**

```ts
// @vitest-environment node
/**
 * 评分契约：固定 5 维定义、单维/整体 schema、总分合成、输出契约文本。
 * 注意：总分合成的口径是 `round(sum(score) / (5 * n) * 100)`（spec §5.7）——
 * 分母里的 5 是**维度数**而不是传入数组的长度，故 5 维全 1 分 = 20 分，全 5 分 = 100 分。
 */
import { describe, expect, it } from 'vitest';
import {
  DIMENSIONS,
  DIMENSION_COUNT,
  DimensionKeySchema,
  DimensionScoreSchema,
  JUDGE_OUTPUT_CONTRACT,
  ScoreResultSchema,
  composeTotalScore,
} from './score';

describe('DIMENSIONS', () => {
  it('固定 5 维、顺序即界面展示顺序、中文标签取自 spec §7.3 表', () => {
    expect(DIMENSIONS.map((d) => d.key)).toEqual([
      'correctness', 'requirement', 'quality', 'robustness', 'maintainability',
    ]);
    expect(DIMENSIONS.map((d) => d.label)).toEqual([
      '功能正确性', '需求完成度', '代码质量', '健壮性与边界', '可维护性（改动范围合理）',
    ]);
    expect(DIMENSIONS).toHaveLength(DIMENSION_COUNT);
  });

  it('维度键与枚举完全一致（新增维度时忘补标签会当场红）', () => {
    expect(DIMENSIONS.map((d) => d.key).sort()).toEqual([...DimensionKeySchema.options].sort());
  });
});

describe('DimensionScoreSchema', () => {
  it('分数是 1–5 的整数，且必须带理由', () => {
    expect(DimensionScoreSchema.safeParse({ key: 'quality', label: '代码质量', score: 3, reason: '还行' }).success).toBe(true);
    expect(DimensionScoreSchema.safeParse({ key: 'quality', label: '代码质量', score: 0, reason: 'x' }).success).toBe(false);
    expect(DimensionScoreSchema.safeParse({ key: 'quality', label: '代码质量', score: 6, reason: 'x' }).success).toBe(false);
    expect(DimensionScoreSchema.safeParse({ key: 'quality', label: '代码质量', score: 3.5, reason: 'x' }).success).toBe(false);
    expect(DimensionScoreSchema.safeParse({ key: 'quality', label: '代码质量', score: 3 }).success).toBe(false);
  });
});

describe('composeTotalScore', () => {
  it('5 维全 5 分 = 100，全 1 分 = 20', () => {
    expect(composeTotalScore([5, 5, 5, 5, 5])).toBe(100);
    expect(composeTotalScore([1, 1, 1, 1, 1])).toBe(20);
  });

  it('四舍五入到整数（不保留小数，界面与卡片显示的是同一个数）', () => {
    // sum=18 → 18/25*100 = 72；sum=17 → 68；sum=16 → 64
    expect(composeTotalScore([4, 4, 4, 3, 3])).toBe(72);
    // sum=14 → 14/25*100 = 56
    expect(composeTotalScore([3, 3, 3, 3, 2])).toBe(56);
  });

  it('分母是 5 而不是数组长度：少给几个分数不会把总分抬高', () => {
    // 若实现写成 `/(scores.length)`，这两个断言都会失败
    expect(composeTotalScore([5])).toBe(20);
    expect(composeTotalScore([5, 5])).toBe(40);
  });

  it('空数组返回 0（不产出 NaN——NaN 会一路写成 JSON 里的 null 让卡片空掉）', () => {
    expect(composeTotalScore([])).toBe(0);
  });
});

describe('JUDGE_OUTPUT_CONTRACT', () => {
  it('含五个维度的键名与 1–5 分的约束（生成侧与解析侧共用同一份字段名）', () => {
    for (const dimension of DIMENSIONS) {
      expect(JUDGE_OUTPUT_CONTRACT).toContain(dimension.key);
    }
    expect(JUDGE_OUTPUT_CONTRACT).toContain('1-5');
    expect(JUDGE_OUTPUT_CONTRACT).toContain('JSON');
  });

  it('明确要求「不要输出 JSON 以外的任何文字」（不写这句，模型回一段散文就会解析失败）', () => {
    expect(JUDGE_OUTPUT_CONTRACT).toContain('不要输出');
    expect(JUDGE_OUTPUT_CONTRACT).toContain('totalScore');
    expect(JUDGE_OUTPUT_CONTRACT).toContain('verdict');
  });
});

describe('ScoreResultSchema', () => {
  it('接受完整评分结果，并拒绝越界总分', () => {
    const result = {
      dimensions: DIMENSIONS.map((d) => ({ key: d.key, label: d.label, score: 4, reason: '不错' })),
      totalScore: 80,
      verdict: '整体完成度高',
      raw: '{"dimensions":[]}',
      judgeProviderId: 'p-1',
      judgeModelId: 'deepseek-chat',
      judgedAt: '2026-09-22T10:30:00.000Z',
    };
    expect(ScoreResultSchema.safeParse(result).success).toBe(true);
    expect(ScoreResultSchema.safeParse({ ...result, totalScore: 101 }).success).toBe(false);
    expect(ScoreResultSchema.safeParse({ ...result, totalScore: -1 }).success).toBe(false);
    // raw 必须保留（排障用：判断是提示词问题还是模型问题，spec §5.7）
    expect(ScoreResultSchema.safeParse({ ...result, raw: undefined }).success).toBe(false);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @aieval/contracts test`
Expected: FAIL —— `Failed to resolve import "./score" from "src/score.test.ts"`。

- [ ] **Step 3: 写实现 `score.ts`**

```ts
/**
 * 评分契约：固定 5 维定义、单维与整体 schema、总分合成口径、送模型的输出契约文本。
 * 三个必须成立的口径：
 *   1. 维度本期固定 5 维且等权（spec §3 F4）；`DIMENSIONS` 的顺序就是界面展示顺序，
 *      也是提示词里的书写顺序——三处用同一份常量，不允许各自写一遍；
 *   2. 总分 = `round(sum(score) / (5 * n) * 100)`（spec §5.7），n = 维度数；本期固定 5 维，
 *      故分母是常量 `DIMENSION_COUNT * MAX_SCORE_PER_DIMENSION`，两个常量单列出来、不写魔数；
 *   3. `JUDGE_OUTPUT_CONTRACT` 是生成侧（用例页「AI 生成」）与解析侧（p4 的 `parseJudgeResponse`）
 *      共用的**单一真源**：字段名写两份必然漂移，而漂移的表现是「模型回得挺好、解析就是失败」。
 */
import { z } from 'zod';

export const DimensionKeySchema = z.enum(['correctness', 'requirement', 'quality', 'robustness', 'maintainability']);
export type DimensionKey = z.infer<typeof DimensionKeySchema>;

/** 固定 5 维（spec §7.3），顺序即界面展示顺序与提示词书写顺序 */
export const DIMENSIONS: readonly { key: DimensionKey; label: string }[] = [
  { key: 'correctness', label: '功能正确性' },
  { key: 'requirement', label: '需求完成度' },
  { key: 'quality', label: '代码质量' },
  { key: 'robustness', label: '健壮性与边界' },
  { key: 'maintainability', label: '可维护性（改动范围合理）' },
];

/** 维度数：总分公式的分母语义常量（不写魔数 5，避免与 DIMENSIONS 长度脱钩） */
export const DIMENSION_COUNT = 5;

export const DimensionScoreSchema = z.object({
  key: DimensionKeySchema,
  label: z.string(),
  score: z.number().int().min(1).max(5),
  reason: z.string(),
});
export type DimensionScore = z.infer<typeof DimensionScoreSchema>;

export const ScoreResultSchema = z.object({
  dimensions: z.array(DimensionScoreSchema),
  /** 5 维等权均值映射到 0–100 */
  totalScore: z.number().int().min(0).max(100),
  /** 一句话总评 */
  verdict: z.string(),
  /** 模型原始返回，排障用（判断是提示词问题还是模型问题） */
  raw: z.string(),
  judgeProviderId: z.string(),
  judgeModelId: z.string(),
  judgedAt: z.string(),
});
export type ScoreResult = z.infer<typeof ScoreResultSchema>;

/** 单维满分（1–5 分制的上界）；与 `DIMENSION_COUNT` 一起决定总分的分母 25 */
const MAX_SCORE_PER_DIMENSION = 5;

/**
 * 总分合成（spec §5.7）：`round(sum(score) / (5 * n) * 100)`，其中 n = **维度数（本期固定 5）**。
 * 故分母是**常量** `DIMENSION_COUNT * MAX_SCORE_PER_DIMENSION = 25`，**不是** `scores.length`：
 * 后者在「模型少给了一个维度」时会把分母改小、总分被抬高——正是 §5.7 禁止的「按缺的维度算平均」。
 * 传不满 5 维时按 25 计，分数只会更低（保守方向）；而缺维本身由 p4 的解析器判 failed。
 * 空数组返回 0 而不是 NaN：NaN 经 JSON 序列化会变成 null，界面上是一个空白分数，
 * 比一个明确的 0 更难排查。
 */
export function composeTotalScore(scores: readonly number[]): number {
  if (scores.length === 0) return 0;
  const sum = scores.reduce((acc, score) => acc + score, 0);
  return Math.round((sum / (DIMENSION_COUNT * MAX_SCORE_PER_DIMENSION)) * 100);
}

/**
 * 生成的提示词必须自带的输出契约文本（spec §4.3）：单一真源，生成侧与解析侧共用同一份字段名。
 * 写死「只输出 JSON、不要输出 JSON 以外的任何文字」是必需的——否则模型回一段散文，
 * 解析侧就翻车（§5.7 的三类翻车点之一）。
 */
export const JUDGE_OUTPUT_CONTRACT = [
  '输出要求（务必严格遵守）：',
  '1. 只输出一个 JSON 对象，不要输出 JSON 以外的任何文字，不要使用 markdown 代码围栏；',
  '2. 字段结构固定为：',
  '   {',
  '     "dimensions": [',
  '       { "key": "correctness",     "label": "功能正确性",         "score": 1-5 的整数, "reason": "中文理由" },',
  '       { "key": "requirement",     "label": "需求完成度",         "score": 1-5 的整数, "reason": "中文理由" },',
  '       { "key": "quality",         "label": "代码质量",           "score": 1-5 的整数, "reason": "中文理由" },',
  '       { "key": "robustness",      "label": "健壮性与边界",       "score": 1-5 的整数, "reason": "中文理由" },',
  '       { "key": "maintainability", "label": "可维护性（改动范围合理）", "score": 1-5 的整数, "reason": "中文理由" }',
  '     ],',
  '     "totalScore": 0-100 的整数,',
  '     "verdict": "一句话中文总评"',
  '   }',
  '3. 五个维度必须全部给出，一个都不能少；score 越界会被判为无效输出。',
].join('\n');
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @aieval/contracts test`
Expected: PASS（`score.test.ts` 共 5 个 `describe` / 11 个 `it` 全绿）。

Run: `pnpm typecheck`
Expected: 通过。

- [ ] **Step 5: 提交**

```bash
git add packages/server/contracts/src/score.ts packages/server/contracts/src/score.test.ts
git commit -m "feat(contracts): 评分契约（固定 5 维 + 总分合成 + 输出契约真源）"
```

---

## Task 6: contracts —— `agent-event.ts`

**Files:**
- Create: `packages/server/contracts/src/agent-event.ts`
- Create: `packages/server/contracts/src/agent-event.test.ts`
- 前置：Task 5 的 `score.ts`（`score` 成员引用 `ScoreResultSchema`）、Task 4 的 `run.ts`（`status` 成员引用 `EvalRowStatusSchema`）

**Interfaces:**
- Consumes: `ScoreResultSchema`（Task 5）、`EvalRowStatusSchema`（Task 4）
- Produces（逐字来自契约 §2.6）：
  - `AgentEventSchema: z.ZodDiscriminatedUnion<'type', [...]>`（七个成员，逐字段对应 spec §7.4）
  - `type AgentEvent`
  - `AGENT_EVENT_TYPES: readonly AgentEvent['type'][]`

- [ ] **Step 1: 写失败测试 `agent-event.test.ts`**

```ts
// @vitest-environment node
/**
 * 事件契约：七个成员的判别联合、类型清单、以及两条最容易漏的字段约束。
 * 注意：`seq` 从 1 开始单调递增（由 core 的事件日志写入器分配），`at` 是 ISO 8601 字符串——
 * 这两条决定了 SSE 的 `Last-Event-ID` 续订能不能工作。
 */
import { describe, expect, it } from 'vitest';
import { AGENT_EVENT_TYPES, AgentEventSchema } from './agent-event';
import { DIMENSIONS } from './score';

const base = { seq: 1, at: '2026-09-22T10:30:00.000Z' };

describe('AgentEventSchema', () => {
  it('接受 spec §7.4 的七个成员', () => {
    const events = [
      { ...base, type: 'status', status: 'running' },
      { ...base, type: 'log', stream: 'stdout', text: '开始执行' },
      { ...base, type: 'usage', tokens: { input: 10, cached: 2, output: 3 }, turns: 1 },
      { ...base, type: 'diff-summary', filesChanged: 2, insertions: 12, deletions: 3, truncated: false },
      {
        ...base,
        type: 'score',
        score: {
          dimensions: DIMENSIONS.map((d) => ({ key: d.key, label: d.label, score: 4, reason: '好' })),
          totalScore: 80,
          verdict: '完成度高',
          raw: '{}',
          judgeProviderId: 'p-1',
          judgeModelId: 'deepseek-chat',
          judgedAt: '2026-09-22T10:30:00.000Z',
        },
      },
      { ...base, type: 'error', message: 'CLI 未安装' },
      { ...base, type: 'end', exitReason: 'completed' },
    ];
    for (const event of events) {
      expect(AgentEventSchema.safeParse(event).success).toBe(true);
    }
  });

  it('拒绝未识别的 type（日志格式必须由本项目定义，不随厂商漂移）', () => {
    expect(AgentEventSchema.safeParse({ ...base, type: 'tool-call', name: 'read' }).success).toBe(false);
  });

  it('拒绝缺字段的成员：log 缺 stream、usage 缺 turns、end 缺 exitReason', () => {
    expect(AgentEventSchema.safeParse({ ...base, type: 'log', text: 'x' }).success).toBe(false);
    expect(AgentEventSchema.safeParse({ ...base, type: 'usage', tokens: { input: 1, cached: 0, output: 0 } }).success).toBe(false);
    expect(AgentEventSchema.safeParse({ ...base, type: 'end' }).success).toBe(false);
  });

  it('usage 的计量是三个数字（缺失计量时适配器根本不该发这条事件，而不是发 0）', () => {
    expect(
      AgentEventSchema.safeParse({ ...base, type: 'usage', tokens: { input: 1, cached: 0, output: 2 }, turns: 3 }).success,
    ).toBe(true);
    expect(
      AgentEventSchema.safeParse({ ...base, type: 'usage', tokens: { input: '1', cached: 0, output: 2 }, turns: 3 }).success,
    ).toBe(false);
  });

  it('status 成员只接受 EvalRowStatus 的取值（事件状态与行状态必须同一套词）', () => {
    expect(AgentEventSchema.safeParse({ ...base, type: 'status', status: 'timed-out' }).success).toBe(true);
    expect(AgentEventSchema.safeParse({ ...base, type: 'status', status: 'timeout' }).success).toBe(false);
  });

  it('error 允许省略 stack', () => {
    expect(AgentEventSchema.safeParse({ ...base, type: 'error', message: 'x', stack: 'at ...' }).success).toBe(true);
    expect(AgentEventSchema.safeParse({ ...base, type: 'error', message: 'x' }).success).toBe(true);
    expect(AgentEventSchema.safeParse({ ...base, type: 'error' }).success).toBe(false);
  });
});

describe('AGENT_EVENT_TYPES', () => {
  it('七个类型、顺序即 spec §7.4 的书写顺序', () => {
    expect([...AGENT_EVENT_TYPES]).toEqual([
      'status', 'log', 'usage', 'diff-summary', 'score', 'error', 'end',
    ]);
  });

  it('与联合成员一一对应（新增成员时忘补清单会当场红）', () => {
    const members = AgentEventSchema.options.map((option) => option.shape.type.value);
    expect([...AGENT_EVENT_TYPES].sort()).toEqual([...members].sort());
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @aieval/contracts test`
Expected: FAIL —— `Failed to resolve import "./agent-event" from "src/agent-event.test.ts"`。

- [ ] **Step 3: 写实现 `agent-event.ts`**

```ts
/**
 * 每候选行事件日志的一条（spec §7.4）。
 * 三个必须成立的口径：
 *   1. 形状由**本项目**定义（§5.6.1 A8）：不复用任何厂商 SDK 的消息形状，
 *      否则日志格式会随厂商版本漂移，还会把「本项目根本不消费的内容类型」当兼容包袱带上；
 *   2. `seq` 单调递增且从 1 开始，由 core 的事件日志写入器分配（`appendEvent`）——
 *      前端按它去重与续订（`Last-Event-ID` 语义）；
 *   3. 判别联合用 `discriminatedUnion` 而不是 `z.union`：前者在解析失败时给出的
 *      报错会带上「哪个 type 的哪个字段不对」，排查坏日志时这是唯一有用的信息。
 */
import { z } from 'zod';
import { EvalRowStatusSchema } from './run';
import { ScoreResultSchema } from './score';

/** 事件公共字段：序号（从 1 开始）与 ISO 8601 时间戳 */
const baseFields = { seq: z.number().int().positive(), at: z.string() };

export const AgentEventSchema = z.discriminatedUnion('type', [
  /** 行状态变更：与 EvalRow.status 同一套词，1:1 映射 */
  z.object({ ...baseFields, type: z.literal('status'), status: EvalRowStatusSchema }),
  /** 一行日志：stdout / stderr 分流；适配器未识别的事件也要投影成一条 log 而不是丢弃（§5.6.3） */
  z.object({ ...baseFields, type: z.literal('log'), stream: z.enum(['stdout', 'stderr']), text: z.string() }),
  /** 计量快照：采到才发这条事件；采不到就不发，而不是发三个 0（§5.6.3） */
  z.object({
    ...baseFields,
    type: z.literal('usage'),
    tokens: z.object({ input: z.number(), cached: z.number(), output: z.number() }),
    turns: z.number(),
  }),
  /** diff 计数摘要：正文不落库，打开抽屉时按需现算（§7.2） */
  z.object({
    ...baseFields,
    type: z.literal('diff-summary'),
    filesChanged: z.number(),
    insertions: z.number(),
    deletions: z.number(),
    truncated: z.boolean(),
  }),
  /** 评分结果：整份 ScoreResult 随事件落盘，抽屉直接读它 */
  z.object({ ...baseFields, type: z.literal('score'), score: ScoreResultSchema }),
  /** 失败归因：message 是给用户看的中文，stack 可省 */
  z.object({ ...baseFields, type: z.literal('error'), message: z.string(), stack: z.string().optional() }),
  /** 运行结束：exitReason 是 AgentExitReason 的字符串形式（不引入 agents 依赖） */
  z.object({ ...baseFields, type: z.literal('end'), exitReason: z.string() }),
]);
export type AgentEvent = z.infer<typeof AgentEventSchema>;

/** 七个事件类型：SSE 过滤与界面分组用；与上面联合的成员一一对应 */
export const AGENT_EVENT_TYPES: readonly AgentEvent['type'][] = [
  'status', 'log', 'usage', 'diff-summary', 'score', 'error', 'end',
];
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @aieval/contracts test`
Expected: PASS（`agent-event.test.ts` 共 2 个 `describe` / 8 个 `it` 全绿）。

Run: `pnpm typecheck`
Expected: 通过。

- [ ] **Step 5: 提交**

```bash
git add packages/server/contracts/src/agent-event.ts packages/server/contracts/src/agent-event.test.ts
git commit -m "feat(contracts): 事件契约（七成员判别联合 + 完成事件不丢原始负载）"
```

---

## Task 7: contracts —— `index.ts` 汇总出口

**Files:**
- Modify: `packages/server/contracts/src/index.ts`（整份替换，当前 12 行）
- Create: `packages/server/contracts/src/index.test.ts`

**Interfaces:**
- Consumes: Task 1–6 的全部出口
- Produces: 包根 `@aieval/contracts` 上的**全部**契约名字（§2 的每一个），p1–p5 只从这里 import

- [ ] **Step 1: 写失败测试 `index.test.ts`**

```ts
// @vitest-environment node
/**
 * 契约出口汇总：从**包根**导入全部名字，证明 `index.ts` 没漏。
 * 注意：`import type` 那一组由 `pnpm typecheck` 守卫（TS 会报「模块没有导出成员」），
 * 本文件负责运行时值的那一组——两条合起来才是完整的「出口没漏」证据。
 */
import { describe, expect, it } from 'vitest';
import {
  AGENT_EVENT_TYPES,
  AGENT_KINDS,
  AGENT_LABELS,
  AgentEventSchema,
  AgentKindSchema,
  CaseCreateSchema,
  CasePatchSchema,
  CommitCandidateSchema,
  DIMENSION_COUNT,
  DIMENSIONS,
  DimensionKeySchema,
  DimensionScoreSchema,
  ERROR_CODES,
  EvalRowSchema,
  EvalRowStatusSchema,
  EvalRunSchema,
  ExecutionModeSchema,
  GenerateJudgePromptSchema,
  JUDGE_OUTPUT_CONTRACT,
  PROTOCOL_LABELS,
  ProviderCreateSchema,
  ProviderModelInputSchema,
  ProviderModelSchema,
  ProviderPatchSchema,
  ProviderSchema,
  ProviderViewSchema,
  ProtocolTypeSchema,
  ROW_STATUS_LABELS,
  RepoInfoSchema,
  RepoPathInputSchema,
  RowDiffSchema,
  RunCreateSchema,
  SETTINGS_DEFAULTS,
  ScoreResultSchema,
  ServiceError,
  SettingsPatchSchema,
  SettingsSchema,
  TERMINAL_ROW_STATUSES,
  TestCaseSchema,
  ThemeModeSchema,
  composeTotalScore,
  httpStatusFor,
  isRunnableRow,
  isRunningRow,
  maskApiKey,
  type AgentKind,
  type AgentEvent,
  type DimensionKey,
  type EvalRow,
  type EvalRun,
  type EvalRowStatus,
  type ExecutionMode,
  type GenerateJudgePromptInput,
  type ProtocolType,
  type Provider,
  type ProviderCreate,
  type ProviderModel,
  type ProviderModelInput,
  type ProviderPatch,
  type ProviderView,
  type RepoInfo,
  type RowDiff,
  type RunCreate,
  type ScoreResult,
  type TestCase,
  type CommitCandidate,
  type DimensionScore,
  type Settings,
  type SettingsPatch,
  type ThemeMode,
  type ErrorCode,
} from './index';

describe('contracts 公共出口', () => {
  it('导出全部 schema 对象', () => {
    for (const schema of [
      ProtocolTypeSchema, ProviderModelSchema, ProviderSchema, ProviderViewSchema,
      ProviderCreateSchema, ProviderPatchSchema, ProviderModelInputSchema,
      TestCaseSchema, CaseCreateSchema, CasePatchSchema, RepoInfoSchema, CommitCandidateSchema,
      RepoPathInputSchema, GenerateJudgePromptSchema,
      AgentKindSchema, ExecutionModeSchema, EvalRowStatusSchema, EvalRowSchema, EvalRunSchema,
      RunCreateSchema, RowDiffSchema,
      DimensionKeySchema, DimensionScoreSchema, ScoreResultSchema,
      AgentEventSchema,
      SettingsSchema, SettingsPatchSchema, ThemeModeSchema,
    ]) {
      expect(typeof schema.safeParse).toBe('function');
    }
  });

  it('导出全部常量', () => {
    expect([...AGENT_KINDS]).toEqual(['claude-code', 'codex', 'dsh']);
    expect([...AGENT_EVENT_TYPES]).toHaveLength(7);
    expect(DIMENSION_COUNT).toBe(5);
    expect(DIMENSIONS).toHaveLength(5);
    expect(AGENT_LABELS.dsh).toBe('DeepSeek Harness');
    expect(PROTOCOL_LABELS.openai).toBe('OpenAI 兼容');
    expect(ROW_STATUS_LABELS['timed-out']).toBe('已超时');
    expect(TERMINAL_ROW_STATUSES).toContain('judged');
    expect(SETTINGS_DEFAULTS.diffBudgetBytes).toBe(262_144);
    expect(JUDGE_OUTPUT_CONTRACT).toContain('totalScore');
    expect(ERROR_CODES).toContain('NOT_A_GIT_REPO');
  });

  it('导出全部函数，且函数在包根上可用（不只是名字存在）', () => {
    expect(maskApiKey('sk-abcdefghijklmn')).toBe('sk-**********klmn');
    expect(composeTotalScore([5, 5, 5, 5, 5])).toBe(100);
    expect(isRunnableRow('failed')).toBe(true);
    expect(isRunningRow('running')).toBe(true);
    expect(httpStatusFor('JUDGE_PARSE_FAILED')).toBe(500);
    expect(new ServiceError('CONFLICT', '冲突').code).toBe('CONFLICT');
  });

  it('类型出口存在（编译期守卫：这里只做一次赋值，真正的检查是 typecheck）', () => {
    const protocol: ProtocolType = 'openai';
    const agent: AgentKind = 'codex';
    const mode: ExecutionMode = 'parallel';
    const status: EvalRowStatus = 'judged';
    const dimension: DimensionKey = 'quality';
    const theme: ThemeMode = 'auto';
    const code: ErrorCode = 'INVALID_REF';
    const settings: Settings = SETTINGS_DEFAULTS;
    const patch: SettingsPatch = { theme };
    const provider: Provider | null = null;
    const view: ProviderView | null = null;
    const model: ProviderModel | null = null;
    const modelInput: ProviderModelInput | null = null;
    const providerCreate: ProviderCreate | null = null;
    const providerPatch: ProviderPatch | null = null;
    const testCase: TestCase | null = null;
    const candidate: CommitCandidate | null = null;
    const repoInfo: RepoInfo | null = null;
    const generateInput: GenerateJudgePromptInput | null = null;
    const row: EvalRow | null = null;
    const run: EvalRun | null = null;
    const runCreate: RunCreate | null = null;
    const rowDiff: RowDiff | null = null;
    const score: ScoreResult | null = null;
    const dimensionScore: DimensionScore | null = null;
    const event: AgentEvent | null = null;

    expect([
      protocol, agent, mode, status, dimension, theme, code, settings, patch,
      provider, view, model, modelInput, providerCreate, providerPatch,
      testCase, candidate, repoInfo, generateInput, row, run, runCreate, rowDiff,
      score, dimensionScore, event,
    ]).toHaveLength(26);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @aieval/contracts test`
Expected: FAIL —— `index.test.ts` 收集阶段就报 `does not provide an export named 'ProtocolTypeSchema'`（现有 `index.ts` 只导出 errors 与 settings）。

- [ ] **Step 3: 最小实现（改 `index.ts`，整份替换）**

```ts
/** contracts 公共出口：跨端共享的契约与错误模型。框架层只从这里 import。 */
export { ERROR_CODES, ServiceError, httpStatusFor, type ErrorCode } from './errors';
export {
  DefaultJudgeSchema,
  SETTINGS_DEFAULTS,
  SettingsPatchSchema,
  SettingsSchema,
  ThemeModeSchema,
  type Settings,
  type SettingsPatch,
  type ThemeMode,
} from './settings';
export {
  PROTOCOL_LABELS,
  ProviderCreateSchema,
  ProviderModelInputSchema,
  ProviderModelSchema,
  ProviderPatchSchema,
  ProviderSchema,
  ProviderViewSchema,
  ProtocolTypeSchema,
  maskApiKey,
  type ProtocolType,
  type Provider,
  type ProviderCreate,
  type ProviderModel,
  type ProviderModelInput,
  type ProviderPatch,
  type ProviderView,
} from './provider';
export {
  CaseCreateSchema,
  CasePatchSchema,
  CommitCandidateSchema,
  GenerateJudgePromptSchema,
  RepoInfoSchema,
  RepoPathInputSchema,
  TestCaseSchema,
  type CaseCreate,
  type CasePatch,
  type CommitCandidate,
  type GenerateJudgePromptInput,
  type RepoInfo,
  type TestCase,
} from './case';
export {
  AGENT_KINDS,
  AGENT_LABELS,
  AgentKindSchema,
  EvalRowSchema,
  EvalRowStatusSchema,
  EvalRunSchema,
  ExecutionModeSchema,
  ROW_STATUS_LABELS,
  RowDiffSchema,
  RunCreateSchema,
  TERMINAL_ROW_STATUSES,
  isRunnableRow,
  isRunningRow,
  type AgentKind,
  type EvalRow,
  type EvalRowStatus,
  type EvalRun,
  type ExecutionMode,
  type RowDiff,
  type RunCreate,
} from './run';
export {
  DIMENSIONS,
  DIMENSION_COUNT,
  DimensionKeySchema,
  DimensionScoreSchema,
  JUDGE_OUTPUT_CONTRACT,
  ScoreResultSchema,
  composeTotalScore,
  type DimensionKey,
  type DimensionScore,
  type ScoreResult,
} from './score';
export { AGENT_EVENT_TYPES, AgentEventSchema, type AgentEvent } from './agent-event';
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @aieval/contracts test`
Expected: PASS（`index.test.ts` 4 个 `it` + 前面各文件的全部用例）。

Run: `pnpm typecheck`
Expected: 通过（这一步同时验证了 `import type` 的那一整组——TS 对不存在的导出成员直接报错）。

- [ ] **Step 5: 提交**

```bash
git add packages/server/contracts/src/index.ts packages/server/contracts/src/index.test.ts
git commit -m "feat(contracts): 汇总导出功能阶段全部契约（p1–p5 只从包根消费）"
```

---

## Task 8: core —— `config-store` 去重复类型（契约 §3.1）

**Files:**
- Modify: `packages/server/core/src/config-store.ts`（删第 18–50 行的四个本地声明；改第 13 行的 import；`AppConfig` 定义改到 `Provider` / `TestCase`）
- Modify: `packages/server/core/src/config-store.test.ts`（追加一条往返用例）
- Modify: `packages/server/core/src/index.ts`（第 3–13 行的出口：删掉 `type ProviderModelRecord` / `type ProviderRecord` / `type ProtocolType` / `type TestCaseRecord` 四个再导出）

**Interfaces:**
- Consumes: `@aieval/contracts` 的 `type Provider`、`type TestCase`、`type ProtocolType`
- Produces: `interface AppConfig { settings: Settings; providers: Provider[]; cases: TestCase[] }`；`loadConfig()` / `saveConfig()` / `getConfigDir()` / `setConfigDirForTesting()` 签名不变

- [ ] **Step 1: 改失败测试（追加到 `config-store.test.ts` 的 `describe('saveConfig')` 之后）**

```ts
describe('AppConfig 与契约同形（去重复类型后的回归守卫）', () => {
  it('写出的 Provider / TestCase 记录能被 contracts 的 schema 直接解析', () => {
    const config = loadConfig();
    config.providers.push({
      id: 'p-1',
      name: 'DeepSeek 官方',
      protocolType: 'openai',
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: 'sk-abcdefghijklmn',
      models: [{ id: 'deepseek-chat', source: 'fetched' }],
      createdAt: '2026-09-22T10:30:00.000Z',
      updatedAt: '2026-09-22T10:30:00.000Z',
    });
    config.cases.push({
      id: 'c-1',
      title: 'LRU 缓存',
      repoPath: 'D:/repos/demo',
      commitHash: null,
      taskPrompt: '实现一个 LRU 缓存',
      judgePrompt: '按 5 维打分',
      judgeProviderId: null,
      judgeModelId: null,
      createdAt: '2026-09-22T10:30:00.000Z',
      updatedAt: '2026-09-22T10:30:00.000Z',
    });
    saveConfig(config);

    const roundTripped = loadConfig();
    // 用契约 schema 解析落盘再读回的对象：core 的本地类型一旦与契约漂移（少字段、多字段、
    // 枚举取值不同），这里会直接失败——这正是「去重复声明」要守的那条线。
    const provider = ProviderSchema.safeParse(roundTripped.providers[0]);
    const testCase = TestCaseSchema.safeParse(roundTripped.cases[0]);
    expect(provider.success).toBe(true);
    expect(testCase.success).toBe(true);
    expect(roundTripped.providers[0]?.protocolType).toBe('openai');
    expect(roundTripped.cases[0]?.commitHash).toBeNull();
  });
});
```

文件顶部 import 改为：

```ts
import { ProviderSchema, ServiceError, SETTINGS_DEFAULTS, TestCaseSchema } from '@aieval/contracts';
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @aieval/core test`
Expected: FAIL —— 收集阶段报 `does not provide an export named 'ProviderSchema'`（`ProviderSchema` 存在于 contracts，但这条用例的对象字面量里 `protocolType: 'openai'` 会被推断成 `string`，在 `config.providers.push(...)` 处 `tsc` 也会报 `Type 'string' is not assignable to type 'ProtocolType'` 之外的类型错误；先看到的是 vitest 的导入失败）。

- [ ] **Step 3: 最小实现（改 `config-store.ts`）**

把第 13 行的 import 改为：

```ts
import { ServiceError, SETTINGS_DEFAULTS, type Provider, type Settings, type TestCase } from '@aieval/contracts';
```

**删掉**第 18–50 行（`export type ProtocolType`、`ProviderModelRecord`、`ProviderRecord`、`TestCaseRecord` 四个本地声明），把 `AppConfig` 换成：

```ts
/**
 * 应用配置的落盘形态：settings + providers + cases 三段。
 * providers / cases 直接复用 contracts 的领域类型——core 曾经自己声明过四个同形类型
 * （ProviderRecord / ProviderModelRecord / TestCaseRecord / ProtocolType），那是两处会漂移的
 * 重复定义：契约加一个字段而 core 忘了跟，落盘文件就少一列，而 `loadConfig` 的类型却不会报错。
 */
export interface AppConfig {
  settings: Settings;
  providers: Provider[];
  cases: TestCase[];
}
```

`loadConfig` / `saveConfig` / `defaults` 的函数体**一行都不改**（`parsed.providers ?? []` 的推断结果与 `Provider[]` 兼容）。

- [ ] **Step 4: 改 `core/src/index.ts` 的出口**

`config-store` 那一段改成（删掉四个类型再导出；`Provider` / `TestCase` / `ProtocolType` 由消费方直接从 `@aieval/contracts` 取，core 不再转发）：

```ts
export {
  getConfigDir,
  loadConfig,
  saveConfig,
  setConfigDirForTesting,
  type AppConfig,
} from './config-store';
```

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm --filter @aieval/core test`
Expected: PASS（`config-store.test.ts` 原有 12 条 + 新增 1 条全绿）。

Run: `pnpm typecheck`
Expected: 通过。若报「模块 @aieval/core 没有导出成员 ProviderRecord」，说明仓库里还有别处 import 了它——按提示逐个改成从 `@aieval/contracts` 取（本仓当前只有 `core/src/index.ts` 引用了这四个名字）。

- [ ] **Step 6: 提交**

```bash
git add packages/server/core/src/config-store.ts packages/server/core/src/config-store.test.ts packages/server/core/src/index.ts
git commit -m "refactor(core): 配置落盘改用 contracts 的 Provider/TestCase 类型（删四处重复声明）"
```

---

## Task 9: core —— `git.ts` 的仓库校验、commit 判定、缓存克隆、复制与建分支

**Files:**
- Create: `packages/server/core/src/git.ts`（本任务建立文件与执行外壳 + 五个函数；Task 10 往同一文件追加 diff 相关函数）
- Create: `packages/server/core/src/git.repo.test.ts`

**Interfaces:**
- Consumes: `@aieval/contracts` 的 `ServiceError`、`CommitCandidate`、`RepoInfo`；`./logger` 的 `createLogger`
- Produces（逐字来自契约 §3.2）：
  - `isGitRepo(dir: string): boolean`
  - `resolveRepoInfo(repoPath: string): RepoInfo`
  - `assertCommit(repoPath: string, hash: string): string`
  - `listCommits(repoPath: string, limit?: number): CommitCandidate[]`
  - `ensureCaseCache(repoPath: string, cacheDir: string): void`
  - `copyWorkspace(srcDir: string, destDir: string): void`
  - `checkoutRow(dir: string, commitHash: string | null, branch: string): { baselineCommit: string }`

- [ ] **Step 1: 写失败测试 `git.repo.test.ts`**

```ts
// @vitest-environment node
/**
 * git 原语（仓库侧）：真实 git CLI，禁 mock（spec §9）。
 * 为什么禁 mock：mock 掉的正是最容易错的地方——`cat-file -e` 的 `^{commit}` 语法、
 * `rev-parse --show-toplevel` 的返回形态、克隆后 `.git` 是否真的存在、复制是否带上 `.git`。
 * 三个环境上的注意点：
 *   1. `git commit` 一律带 `-c user.email=... -c user.name=...`（写在 init 里），
 *      否则 CI / 新机器上没有全局身份会直接 commit 失败；
 *   2. 所有仓库都建在 `os.tmpdir()` 下的临时目录里，结束即删；
 *   3. 每个用例前 `setConfigDirForTesting(tmp)` 并断言指向它——本模块不该读配置，
 *      这条断言是「将来有人顺手 loadConfig() 时会红」的护栏（Review Focus 5）。
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ServiceError } from '@aieval/contracts';
import { setConfigDirForTesting } from './config-store';
import { assertCommit, checkoutRow, copyWorkspace, ensureCaseCache, isGitRepo, listCommits, resolveRepoInfo } from './git';

const created: string[] = [];

/** 建一个隔离的临时目录（每个仓库一个，互不嵌套） */
function makeTmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}

/**
 * 在临时目录里跑一条 git 命令并返回 stdout。
 * `-c user.email / user.name` 是**必需**的：本仓的测试机与 CI 上不一定配了全局身份，
 * 缺它时 `git commit` 直接以 `Author identity unknown` 失败。
 */
function git(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=test@aieval.local', '-c', 'user.name=aieval-test', ...args], {
    cwd: dir,
    encoding: 'utf8',
  });
}

/** 建一个已 `git init` 的临时仓库，返回其路径（不预先提交，方便用例自己控制） */
function makeRepo(prefix: string): string {
  const dir = makeTmp(prefix);
  git(dir, 'init', '-q');
  return dir;
}

/** 建仓库并提交一个 `a.txt`，返回 { dir, commit } */
function makeRepoWithCommit(prefix: string): { dir: string; commit: string } {
  const dir = makeRepo(prefix);
  writeFileSync(join(dir, 'a.txt'), 'hello\n', 'utf8');
  git(dir, 'add', 'a.txt');
  git(dir, 'commit', '-q', '-m', '初始提交');
  return { dir, commit: git(dir, 'rev-parse', 'HEAD').trim() };
}

let configDir: string;

beforeEach(() => {
  // 本模块不读配置，但这条断言保证任何「顺手读一下配置」的实现改动都会在真实家目录之外发生
  configDir = makeTmp('aieval-git-cfg-');
  setConfigDirForTesting(configDir);
});

afterEach(() => {
  setConfigDirForTesting(null);
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('isGitRepo', () => {
  it('仓库内为 true、普通目录为 false、不存在的路径为 false（抛错一律折成 false）', () => {
    const repo = makeRepoWithCommit('aieval-git-');
    expect(isGitRepo(repo.dir)).toBe(true);
    expect(isGitRepo(makeTmp('aieval-git-plain-'))).toBe(false);
    expect(isGitRepo(join(tmpdir(), 'aieval-does-not-exist-9f3a'))).toBe(false);
  });

  it('仓库的子目录也算在仓库内（`--is-inside-work-tree` 的语义）', () => {
    const { dir } = makeRepoWithCommit('aieval-git-');
    const sub = join(dir, 'src');
    mkdirSync(sub);
    expect(isGitRepo(sub)).toBe(true);
  });

  it('裸仓库不算工作树（本工具的每行工作区必须能 checkout）', () => {
    const bare = makeTmp('aieval-bare-');
    git(bare, 'init', '-q', '--bare');
    expect(isGitRepo(bare)).toBe(false);
  });
});

describe('resolveRepoInfo', () => {
  it('回显仓库名与当前分支', () => {
    const { dir } = makeRepoWithCommit('aieval-git-');
    const info = resolveRepoInfo(dir);
    expect(info.repoName).toBe(basename(dir));
    expect(info.repoPath).toBe(dir);
    // 分支名取的就是 git 自己报的那个：不断言 master / main——
    // 默认分支名受 `init.defaultBranch` 影响，写死会让测试在不同机器上红
    expect(info.branch).toBe(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD').trim());
    expect(info.branch.length).toBeGreaterThan(0);
  });

  it('仓库名取的是仓库根目录名，而不是传入路径的最后一段（传子目录也得到同一个仓库名）', () => {
    const { dir } = makeRepoWithCommit('aieval-git-');
    const sub = join(dir, 'packages');
    mkdirSync(sub);
    expect(resolveRepoInfo(sub).repoName).toBe(basename(dir));
  });

  it('路径不存在时报 NOT_A_GIT_REPO 且不代表 git 去猜（含路径与中文原因）', () => {
    const missing = join(tmpdir(), 'aieval-missing-7c1e');
    let caught: unknown;
    try {
      resolveRepoInfo(missing);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ServiceError);
    expect((caught as ServiceError).code).toBe('NOT_A_GIT_REPO');
    expect((caught as Error).message).toContain(missing);
    expect((caught as Error).message).toContain('不存在');
  });

  it('普通目录报 NOT_A_GIT_REPO 并带上 git 的原文（排查要靠它区分「不是仓库」与「git 坏了」）', () => {
    const plain = makeTmp('aieval-git-plain-');
    let caught: unknown;
    try {
      resolveRepoInfo(plain);
    } catch (error) {
      caught = error;
    }
    expect((caught as ServiceError).code).toBe('NOT_A_GIT_REPO');
    expect((caught as Error).message).toContain(plain);
    expect((caught as Error).message).toContain('不是 git 仓库');
  });
});

describe('assertCommit', () => {
  it('返回完整 40 位 hash（短 hash 也能被解析成全量）', () => {
    const { dir, commit } = makeRepoWithCommit('aieval-git-');
    expect(assertCommit(dir, commit)).toBe(commit);
    expect(assertCommit(dir, commit.slice(0, 7))).toBe(commit);
    expect(assertCommit(dir, commit)).toHaveLength(40);
  });

  it('不存在的 hash 报 INVALID_REF，且 message 同时含 hash 与仓库路径', () => {
    const { dir } = makeRepoWithCommit('aieval-git-');
    let caught: unknown;
    try {
      assertCommit(dir, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef');
    } catch (error) {
      caught = error;
    }
    expect((caught as ServiceError).code).toBe('INVALID_REF');
    expect((caught as Error).message).toContain('deadbeef');
    expect((caught as Error).message).toContain(dir);
  });

  it('空 hash 报 INVALID_REF（空串不是「用 HEAD」，那是 null 的语义）', () => {
    const { dir } = makeRepoWithCommit('aieval-git-');
    let caught: unknown;
    try {
      assertCommit(dir, '');
    } catch (error) {
      caught = error;
    }
    expect((caught as ServiceError).code).toBe('INVALID_REF');
  });
});

describe('listCommits', () => {
  it('默认 20 条、按时间倒序、hash 是短哈希且 subject 逐字来自提交信息', () => {
    const dir = makeRepo('aieval-git-log-');
    for (let index = 1; index <= 3; index += 1) {
      writeFileSync(join(dir, `f${index}.txt`), `${index}\n`, 'utf8');
      git(dir, 'add', '.');
      git(dir, 'commit', '-q', '-m', `第 ${index} 次提交`);
    }
    const commits = listCommits(dir);
    expect(commits).toHaveLength(3);
    expect(commits[0]?.subject).toBe('第 3 次提交');
    expect(commits[0]?.hash).toHaveLength(7);
    expect(commits[2]?.subject).toBe('第 1 次提交');
  });

  it('limit 生效（spec §4.2 的最近 20 条）', () => {
    const dir = makeRepo('aieval-git-log-');
    for (let index = 1; index <= 3; index += 1) {
      writeFileSync(join(dir, `f${index}.txt`), `${index}\n`, 'utf8');
      git(dir, 'add', '.');
      git(dir, 'commit', '-q', '-m', `第 ${index} 次提交`);
    }
    expect(listCommits(dir, 2).map((c) => c.subject)).toEqual(['第 3 次提交', '第 2 次提交']);
  });

  it('空仓库返回空数组而不是抛错（首次提交前也能打开用例表单）', () => {
    const dir = makeRepo('aieval-git-empty-');
    expect(listCommits(dir)).toEqual([]);
  });
});

describe('ensureCaseCache', () => {
  it('首次调用真的克隆出带 .git 的完整仓库，且工作树文件在', () => {
    const { dir } = makeRepoWithCommit('aieval-git-src-');
    const cache = join(makeTmp('aieval-ws-'), 'cases', 'c-1', 'cache');
    ensureCaseCache(dir, cache);
    expect(existsSync(join(cache, '.git'))).toBe(true);
    expect(readFileSync(join(cache, 'a.txt'), 'utf8')).toBe('hello\n');
  });

  it('第二次调用不重克隆：缓存里已有的本地改动不被冲掉（「不存在才克隆」的回归守卫）', () => {
    const { dir } = makeRepoWithCommit('aieval-git-src-');
    const cache = join(makeTmp('aieval-ws-'), 'cases', 'c-1', 'cache');
    ensureCaseCache(dir, cache);
    writeFileSync(join(cache, 'local-marker.txt'), 'keep me\n', 'utf8');
    ensureCaseCache(dir, cache);
    expect(existsSync(join(cache, 'local-marker.txt'))).toBe(true);
  });

  it('目标父目录不存在时自动创建', () => {
    const { dir } = makeRepoWithCommit('aieval-git-src-');
    const cache = join(makeTmp('aieval-ws-'), 'deep', 'nested', 'cache');
    ensureCaseCache(dir, cache);
    expect(existsSync(join(cache, '.git'))).toBe(true);
  });
});

describe('copyWorkspace', () => {
  it('文件系统级复制带上了 .git（否则复制出来的目录没法 checkout）', () => {
    const { dir, commit } = makeRepoWithCommit('aieval-git-src-');
    const dest = join(makeTmp('aieval-ws-'), 'rows', 'row-1', 'workspace');
    copyWorkspace(dir, dest);
    expect(existsSync(join(dest, '.git'))).toBe(true);
    expect(git(dest, 'rev-parse', 'HEAD').trim()).toBe(commit);
  });

  it('复制出的目录是独立仓库：在副本里提交不影响源仓库', () => {
    const { dir } = makeRepoWithCommit('aieval-git-src-');
    const dest = join(makeTmp('aieval-ws-'), 'workspace');
    copyWorkspace(dir, dest);
    writeFileSync(join(dest, 'b.txt'), 'b\n', 'utf8');
    git(dest, 'add', 'b.txt');
    git(dest, 'commit', '-q', '-m', '副本里的提交');
    expect(git(dir, 'status', '--porcelain').trim()).toBe('');
  });

  it('目标父目录不存在时自动创建', () => {
    const { dir } = makeRepoWithCommit('aieval-git-src-');
    const dest = join(makeTmp('aieval-ws-'), 'a', 'b', 'workspace');
    copyWorkspace(dir, dest);
    expect(existsSync(join(dest, 'a.txt'))).toBe(true);
  });
});

describe('checkoutRow', () => {
  it('建出 test/{rowId} 分支并切换过去，baselineCommit 是 40 位具体 hash（R2）', () => {
    const { dir } = makeRepoWithCommit('aieval-git-src-');
    const workspace = join(makeTmp('aieval-ws-'), 'workspace');
    copyWorkspace(dir, workspace);

    const { baselineCommit } = checkoutRow(workspace, null, 'test/row-1');
    expect(baselineCommit).toHaveLength(40);
    expect(baselineCommit).toBe(git(workspace, 'rev-parse', 'HEAD').trim());
    expect(git(workspace, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('test/row-1');
  });

  it('给定 commit 时落到那个 commit 上（而不是默认分支 HEAD）', () => {
    const dir = makeRepo('aieval-git-two-');
    writeFileSync(join(dir, 'first.txt'), '1\n', 'utf8');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', '第一次');
    const firstCommit = git(dir, 'rev-parse', 'HEAD').trim();
    writeFileSync(join(dir, 'second.txt'), '2\n', 'utf8');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', '第二次');

    const workspace = join(makeTmp('aieval-ws-'), 'workspace');
    copyWorkspace(dir, workspace);

    const { baselineCommit } = checkoutRow(workspace, firstCommit, 'test/row-2');
    expect(baselineCommit).toBe(firstCommit);
    expect(existsSync(join(workspace, 'second.txt'))).toBe(false);
  });

  it('分支已存在时重置而不是报错（重跑同一行，spec §10「仍冲突则先删旧分支再建」）', () => {
    const { dir } = makeRepoWithCommit('aieval-git-src-');
    const workspace = join(makeTmp('aieval-ws-'), 'workspace');
    copyWorkspace(dir, workspace);

    checkoutRow(workspace, null, 'test/row-3');
    writeFileSync(join(workspace, 'dirty.txt'), 'x\n', 'utf8');
    git(workspace, 'add', '.');
    git(workspace, 'commit', '-q', '-m', '第一轮 agent 的提交');

    // 第二次：分支已存在且已前移；`-B` 必须把它拉回基线，而不是抛「分支已存在」
    const { baselineCommit, ...rest } = checkoutRow(workspace, null, 'test/row-3');
    expect(rest).toEqual({});
    expect(baselineCommit).toBe(git(dir, 'rev-parse', 'HEAD').trim());
    expect(existsSync(join(workspace, 'dirty.txt'))).toBe(false);
    expect(git(workspace, 'branch', '--list', 'test/row-3').trim().split('\n')).toHaveLength(1);
  });

  it('commit 不存在时报 INVALID_REF，且不留下半成品分支', () => {
    const { dir } = makeRepoWithCommit('aieval-git-src-');
    const workspace = join(makeTmp('aieval-ws-'), 'workspace');
    copyWorkspace(dir, workspace);
    let caught: unknown;
    try {
      checkoutRow(workspace, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', 'test/row-4');
    } catch (error) {
      caught = error;
    }
    expect((caught as ServiceError).code).toBe('INVALID_REF');
    expect(git(workspace, 'branch', '--list', 'test/row-4').trim()).toBe('');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @aieval/core test`
Expected: FAIL —— `Failed to resolve import "./git" from "src/git.repo.test.ts"`。

- [ ] **Step 3: 写实现 `git.ts`（本任务建立文件与下面这些函数）**

```ts
/**
 * git CLI 原语：仓库校验、commit 判定、用例级缓存克隆、文件系统级目录复制、行分支。
 * 三个必须成立的口径：
 *   1. **只用真实 git 进程**，不做任何 mock 封装（spec §9）：mock 掉的正是最容易错的地方
 *      （`cat-file -e` 的 `^{commit}` 语法、`rev-parse --show-toplevel` 的返回形态、
 *      复制目录是否带上 `.git`）；
 *   2. 所有 git 调用都带 `-c core.quotepath=false`：默认值会把非 ASCII 路径写成
 *      `"\346\226\207\344\273\266.txt"`，中文文件名的改动在 diff 里就变成了乱码；
 *   3. 失败一律折成带中文原因的 `ServiceError`，绝不把 git 的英文 `fatal:` 原文当用户文案
 *      （原文放 `context.gitMessage` 供排查）。
 *
 * 注意：`execFileSync` 而不是 `execSync`——参数里有仓库路径与用户输入的 commit hash，
 * 走 shell 会引入注入面与引号转义问题。
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { basename, join, sep } from 'node:path';
import { ServiceError, type CommitCandidate, type RepoInfo } from '@aieval/contracts';
import { createLogger } from './logger';

const log = createLogger('git');

/**
 * 执行一条 git 命令并返回 stdout。
 * `-c core.quotepath=false` 必须放在子命令之前；`encoding: 'utf8'` 让中文提交信息与路径不乱码。
 */
function execute(dir: string, args: string[]): string {
  return execFileSync('git', ['-c', 'core.quotepath=false', ...args], {
    cwd: dir,
    encoding: 'utf8',
    // 大仓库的 diff / status 可能超过默认 1MB 的 maxBuffer，直接调大避免静默截断
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** 取 execFileSync 抛出的错误里的 stderr 原文（git 的人类可读报错都在这里） */
function gitMessage(error: unknown): string {
  const stderr = (error as { stderr?: unknown }).stderr;
  if (typeof stderr === 'string' && stderr.trim() !== '') return stderr.trim();
  return error instanceof Error ? error.message : String(error);
}

/** 路径是不是「存在且是目录」 */
function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** 是不是 git 工作树内（`git rev-parse --is-inside-work-tree`）；抛错一律折成 false */
export function isGitRepo(dir: string): boolean {
  if (!isDirectory(dir)) return false;
  try {
    return execute(dir, ['rev-parse', '--is-inside-work-tree']).trim() === 'true';
  } catch {
    return false;
  }
}

/**
 * 校验目录并回显仓库名 + 当前分支；失败抛 NOT_A_GIT_REPO（含路径与 git 原文）。
 * 分三层给出不同的中文原因，因为处置完全不同：
 *   ① 路径不存在 → 「不存在」（不要去执行 git，否则 ENOENT 会被误报成「不是仓库」）；
 *   ② 路径不是目录 / 不在工作树内 → 「不是 git 仓库」（裸仓库也归这里：它没有工作树，checkout 不了）；
 *   ③ 在仓库里但取不到分支（detached HEAD 之外的异常）→ 「无法确定当前分支」。
 * 仓库名取 `rev-parse --show-toplevel` 的**目录名**而不是传入路径的最后一段：
 * 用户完全可能填仓库里的子目录（`D:/repo/packages`），那时仓库名仍应是 `repo`。
 */
export function resolveRepoInfo(repoPath: string): RepoInfo {
  if (!existsSync(repoPath)) {
    throw new ServiceError('NOT_A_GIT_REPO', `仓库路径不存在：${repoPath}`, { context: { repoPath } });
  }
  if (!isGitRepo(repoPath)) {
    let detail = '该目录不在 git 工作树内';
    try {
      execute(repoPath, ['rev-parse', '--is-inside-work-tree']);
    } catch (error) {
      detail = gitMessage(error);
    }
    throw new ServiceError('NOT_A_GIT_REPO', `不是 git 仓库：${repoPath}（${detail}）`, {
      context: { repoPath },
    });
  }

  const topLevel = execute(repoPath, ['rev-parse', '--show-toplevel']).trim();
  let branch: string;
  try {
    branch = execute(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  } catch (error) {
    throw new ServiceError('NOT_A_GIT_REPO', `无法确定当前分支：${repoPath}（${gitMessage(error)}）`, {
      context: { repoPath },
    });
  }

  // 盘根（`D:\`）作仓库根时 basename 会给出空串，此时退回完整路径，避免界面显示一个空仓库名
  const repoName = basename(topLevel) || topLevel;
  log.debug('仓库校验通过', { repoPath, repoName, branch });
  return { repoPath, repoName, branch };
}

/**
 * 判定 commit 存在（`git cat-file -e <hash>^{commit}`），返回完整 40 位 hash；失败抛 INVALID_REF。
 * `^{commit}` 不能省：没有它，一个 blob / tree 的 hash 也会被判定为「存在」。
 * 返回全量 hash 而不是原样回显输入——短哈希与 `HEAD~1` 这类写法都要归一成可比较的形态。
 */
export function assertCommit(repoPath: string, hash: string): string {
  if (hash.trim() === '') {
    throw new ServiceError('INVALID_REF', `commit 不能为空（留空请用 null 表示「默认分支 HEAD」）：${repoPath}`, {
      context: { repoPath, hash },
    });
  }
  try {
    execute(repoPath, ['cat-file', '-e', `${hash}^{commit}`]);
  } catch (error) {
    throw new ServiceError('INVALID_REF', `commit 不存在：${hash}（仓库：${repoPath}）`, {
      context: { repoPath, hash, gitMessage: gitMessage(error) },
    });
  }
  try {
    return execute(repoPath, ['rev-parse', `${hash}^{commit}`]).trim();
  } catch (error) {
    throw new ServiceError('INVALID_REF', `无法解析 commit：${hash}（仓库：${repoPath}）`, {
      context: { repoPath, hash, gitMessage: gitMessage(error) },
    });
  }
}

/** 最近 n 条提交（`git log --format=%h%x09%s -n <limit>`），默认 20（spec §4.2） */
export function listCommits(repoPath: string, limit = 20): CommitCandidate[] {
  let output: string;
  try {
    output = execute(repoPath, ['log', `--format=%h%x09%s`, '-n', String(limit)]);
  } catch (error) {
    // 还没有任何提交（or `HEAD` 不可解析）时 `git log` 以 128 退出：这不是错误，
    // 用例表单在首次提交前也要能打开，故返回空数组；其它失败照抛。
    const message = gitMessage(error);
    if (message.includes('does not have any commits') || message.includes('unknown revision')) {
      log.debug('仓库还没有提交，commit 候选为空', { repoPath });
      return [];
    }
    throw new ServiceError('NOT_A_GIT_REPO', `读取提交历史失败：${repoPath}（${message}）`, {
      context: { repoPath, gitMessage: message },
    });
  }

  return output
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line !== '')
    .map((line) => {
      // 只按**第一个**制表符切分：提交信息里可以有制表符，hash 里不可能有
      const tabIndex = line.indexOf('\t');
      if (tabIndex < 0) return { hash: line, subject: '' };
      return { hash: line.slice(0, tabIndex), subject: line.slice(tabIndex + 1) };
    });
}

/**
 * 用例级本地缓存仓库（spec §5.5 第 1 步）：不存在才 `git clone <repoPath> <cacheDir>`。
 * 判据是「缓存目录里有没有 `.git`」而不是「目录在不在」：克隆中途失败会留下一个没有 `.git`
 * 的空目录，只看目录存在的话，之后每一轮评测都会拿这个空目录去复制，失败点会被推到 checkout。
 */
export function ensureCaseCache(repoPath: string, cacheDir: string): void {
  if (existsSync(join(cacheDir, '.git'))) {
    log.debug('用例缓存已存在，跳过克隆', { cacheDir });
    return;
  }
  const parent = join(cacheDir, '..');
  mkdirSync(parent, { recursive: true });
  // 残留的半成品目录会让 clone 以「目标目录非空」失败，先清掉
  rmSync(cacheDir, { recursive: true, force: true });
  try {
    execute(parent, ['clone', '--quiet', repoPath, cacheDir]);
  } catch (error) {
    throw new ServiceError('NOT_A_GIT_REPO', `克隆用例缓存失败：${repoPath} → ${cacheDir}（${gitMessage(error)}）`, {
      context: { repoPath, cacheDir, gitMessage: gitMessage(error) },
    });
  }
  log.info('用例缓存已克隆', { repoPath, cacheDir });
}

/**
 * 文件系统级目录复制（spec §5.5 第 2 步）：缓存 → 行工作区；目标父目录不存在则创建。
 * 为什么不是每行 `git clone`：本地路径克隆仍是完整对象复制与打包传输，
 * 而缓存已是完整仓库，复制出的目录直接 `checkout` 即可——每行准备时间从「克隆耗时」
 * 降到「磁盘复制耗时」，这是「开一轮评测」秒开的关键（spec §5.5 第 2 步的说明）。
 * `cpSync` 会连同 `.git` 一起复制，这正是我们要的（复制出来的必须是个能 checkout 的仓库）。
 */
export function copyWorkspace(srcDir: string, destDir: string): void {
  if (!existsSync(join(srcDir, '.git'))) {
    throw new ServiceError('NOT_A_GIT_REPO', `工作区缓存的副本不是 git 仓库：${srcDir}`, { context: { srcDir } });
  }
  mkdirSync(join(destDir, '..'), { recursive: true });
  try {
    cpSync(srcDir, destDir, { recursive: true });
  } catch (error) {
    throw new ServiceError(
      'INTERNAL',
      `复制工作区失败：${srcDir} → ${destDir}（${error instanceof Error ? error.message : String(error)}）`,
      { cause: error },
    );
  }
  log.debug('工作区已复制', { srcDir, destDir });
}

/**
 * 在工作副本里取基线并建行分支（spec §5.5 第 2 步）：checkout <commit> → checkout -b <branch>。
 * 用 `checkout -B` 一条命令同时办成两件事：把分支重置到基线并切过去。
 * 为什么是 `-B` 而不是 `-b`：重跑同一行时 `test/{rowId}` 已存在，`-b` 会直接以
 * 「分支已存在」失败；`-B` 等价于 spec §10 要求的「先删旧分支再建」，且是原子的。
 * `baselineCommit` 返回的是**解析后的 40 位具体 hash**：`commitHash: null`（用默认分支 HEAD）时
 * 必须把 HEAD 解析成具体值，否则后面没有可比基线（§11 R2）。
 * 先 `assertCommit` 再切换：否则失败会留下一个「切了一半」的工作区，错误码也分不清是
 * 「commit 不存在」还是「checkout 失败」。
 */
export function checkoutRow(
  dir: string,
  commitHash: string | null,
  branch: string,
): { baselineCommit: string } {
  const target = commitHash === null ? assertCommit(dir, 'HEAD') : assertCommit(dir, commitHash);
  try {
    execute(dir, ['checkout', '--quiet', '-B', branch, target]);
  } catch (error) {
    throw new ServiceError('INTERNAL', `建立行分支失败：${branch}（${gitMessage(error)}）`, {
      context: { dir, branch, target },
    });
  }
  log.info('行分支已建立', { dir, branch, baselineCommit: target });
  return { baselineCommit: target };
}
```

`import { readFileSync, sep }` 在本任务里还用不到——它们属于 Task 10 的 diff 读取与路径归一；**本步骤先不引入这两个名字**，import 行写成：

```ts
import { cpSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
```

（`rmSync` 只在 `ensureCaseCache` 里用一次，确实需要；Task 10 再加 `readFileSync` 与 `sep`。）

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @aieval/core test`
Expected: PASS（`git.repo.test.ts` 共 7 个 `describe` / 16 个 `it` 全绿；`git.repo.test.ts` 里对 `master`/`main` 的默认分支名不做断言——git 的默认分支名受 `init.defaultBranch` 影响，断言它会让测试在不同机器上红）。

Run: `pnpm typecheck`
Expected: 通过。

- [ ] **Step 5: 提交**

```bash
git add packages/server/core/src/git.ts packages/server/core/src/git.repo.test.ts
git commit -m "feat(core): git 原语（仓库校验 + commit 判定 + 缓存克隆 + 目录复制 + 行分支）"
```

---

## Task 10: core —— `collectDiff` 三样合并（R3）与 `truncateDiff` 裁剪

**Files:**
- Modify: `packages/server/core/src/git.ts`（补 import 的 `readFileSync` 与 `sep`，文件末尾追加本任务的四个函数与两个内部解析器）
- Create: `packages/server/core/src/git.diff.test.ts`

**Interfaces:**
- Consumes: Task 9 的 `execute` / `gitMessage` / `assertCommit`（同文件内部）
- Produces（逐字来自契约 §3.2）：
  - `collectDiff(dir: string, baselineCommit: string): { text: string; files: { path: string; insertions: number; deletions: number }[]; filesChanged: number; insertions: number; deletions: number }`
  - `truncateDiff(text: string, budgetBytes: number): { text: string; truncated: boolean; droppedFiles: string[] }`

- [ ] **Step 1: 写失败测试 `git.diff.test.ts`**

```ts
// @vitest-environment node
/**
 * 三样 diff 合并与裁剪：真实 git CLI，禁 mock（spec §9）。
 * 本文件是整个 p0 最关键的回归网，覆盖 spec §9 要求的五种组合与三条专门用例：
 *   · 只有已提交改动 / 只有未提交改动 / 只有未跟踪新文件 / 三者都有 / 全空；
 *   · 「只取 commit..HEAD 会漏掉未提交改动」的专门用例；
 *   · 「未跟踪文件的**正文**必须出现在 diff 文本里」的专门用例（R3 的核心）；
 *   · 「未跟踪清单必须在 `git add --intent-to-add` **之前**读」的专门用例（实测校准）。
 * 注意：每个用例都自建临时仓库；临时仓库的 `git commit` 一律带身份（见 git()）。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setConfigDirForTesting } from './config-store';
import { collectDiff, truncateDiff } from './git';

const created: string[] = [];

function makeTmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=test@aieval.local', '-c', 'user.name=aieval-test', ...args], {
    cwd: dir,
    encoding: 'utf8',
  });
}

/** 建一个已有 `a.txt` 提交的临时仓库，返回 { dir, base }（base 是 40 位 hash） */
function makeRepo(prefix: string): { dir: string; base: string } {
  const dir = makeTmp(prefix);
  git(dir, 'init', '-q');
  writeFileSync(join(dir, 'a.txt'), 'hello\n', 'utf8');
  git(dir, 'add', 'a.txt');
  git(dir, 'commit', '-q', '-m', '初始提交');
  return { dir, base: git(dir, 'rev-parse', 'HEAD').trim() };
}

/** 从合并文本里截出某一段的正文（段标题之间的内容） */
function section(text: string, title: string): string {
  const start = text.indexOf(title);
  if (start < 0) return '';
  const from = start + title.length;
  const nextHeader = text.indexOf('\n### ', from);
  return nextHeader < 0 ? text.slice(from) : text.slice(from, nextHeader);
}

const COMMITTED = '### 已提交改动';
const UNCOMMITTED = '### 未提交改动';
const UNTRACKED = '### 未跟踪文件';

let configDir: string;

beforeEach(() => {
  // Review Focus 5：本模块不读配置，但这条指针保证任何「顺手 loadConfig()」都在临时目录外发生
  configDir = makeTmp('aieval-diff-cfg-');
  setConfigDirForTesting(configDir);
});

afterEach(() => {
  setConfigDirForTesting(null);
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('collectDiff —— 三样合并的四种组合', () => {
  it('全空：三段都在、都写「（无）」、计数全 0', () => {
    const { dir, base } = makeRepo('aieval-diff-empty-');
    const result = collectDiff(dir, base);
    expect(result.text).toContain(COMMITTED);
    expect(result.text).toContain(UNCOMMITTED);
    expect(result.text).toContain(UNTRACKED);
    expect(section(result.text, COMMITTED)).toContain('（无）');
    expect(result.filesChanged).toBe(0);
    expect(result.insertions).toBe(0);
    expect(result.deletions).toBe(0);
    expect(result.files).toEqual([]);
  });

  it('只有已提交改动：出现在第一段，第二段为空', () => {
    const { dir, base } = makeRepo('aieval-diff-commit-');
    writeFileSync(join(dir, 'a.txt'), 'hello\nworld\n', 'utf8');
    git(dir, 'add', 'a.txt');
    git(dir, 'commit', '-q', '-m', 'agent 提交了改动');

    const result = collectDiff(dir, base);
    expect(section(result.text, COMMITTED)).toContain('+world');
    expect(section(result.text, UNCOMMITTED)).toContain('（无）');
    expect(result.insertions).toBe(1);
    expect(result.filesChanged).toBe(1);
    expect(result.files[0]?.path).toBe('a.txt');
  });

  it('只有未提交改动：出现在第二段，第一段为空（**专门用例**：只取 commit..HEAD 会给出空 diff 却照样打分）', () => {
    const { dir, base } = makeRepo('aieval-diff-dirty-');
    writeFileSync(join(dir, 'a.txt'), 'hello\nuncommitted\n', 'utf8');

    const result = collectDiff(dir, base);
    // ① 第一段必须是空的——这正是「只取 commit..HEAD」的实现会看到的世界
    expect(section(result.text, COMMITTED)).toContain('（无）');
    expect(section(result.text, COMMITTED)).not.toContain('+uncommitted');
    // ② 未提交的改动必须出现在第二段（这条就是回归守卫本体）
    expect(section(result.text, UNCOMMITTED)).toContain('+uncommitted');
    // ③ 未跟踪段此时应为空：改动的是**已跟踪**文件，不该被算成「未跟踪」
    expect(section(result.text, UNTRACKED)).toContain('（无）');
    expect(result.filesChanged).toBe(1);
    expect(result.insertions).toBe(1);
    expect(result.files[0]?.path).toBe('a.txt');
  });

  it('只有未跟踪新文件：**正文**必须出现在 diff 文本里（**专门用例**，R3 的核心）', () => {
    const { dir, base } = makeRepo('aieval-diff-untracked-');
    writeFileSync(join(dir, 'new.ts'), 'export const answer = 42;\n', 'utf8');

    const result = collectDiff(dir, base);
    // 未跟踪清单里要有它：不做 `git add --intent-to-add` 的实现，文本里连文件名都没有
    expect(section(result.text, UNTRACKED)).toContain('new.ts');
    // 核心断言：正文逐字在文本里。不登记的实现只能给出文件名，
    // 评分模型看不见新文件写了什么，会把「看不到的改动」当成「没改」（spec §5.5 第 6 步）。
    expect(result.text).toContain('+export const answer = 42;');
    expect(result.filesChanged).toBe(1);
    expect(result.insertions).toBe(1);
    expect(result.files[0]?.path).toBe('new.ts');
  });

  it('未跟踪清单是在 `-N` **之前**读的（实测：登记后 `??` 会变成 ` A`，读晚了清单为空）', () => {
    const { dir, base } = makeRepo('aieval-diff-order-');
    writeFileSync(join(dir, 'late.ts'), 'export const late = 1;\n', 'utf8');

    const result = collectDiff(dir, base);
    // 未跟踪段必须列出文件名——把 `status --porcelain` 挪到 `-N` 之后，这条会失败
    expect(section(result.text, UNTRACKED)).toContain('late.ts');
    // 且登记确实发生了：文件的**正文**出现在未提交段里（`-N` 之后 `git diff HEAD` 才带它）
    expect(section(result.text, UNCOMMITTED)).toContain('+export const late = 1;');
    expect(result.filesChanged).toBe(1);
  });
```

> **注记（2026-09-25，Task 15 跟进轮 R1）—— 上面这条用例的标题与注释已过期，勿照抄。**
> 出货文本 `git.diff.test.ts` 里该用例的标题与注释已被改写为「未跟踪的新文件必须被**列出**、且**正文**出现在未提交段（读序已不可分辨）」（**断言逐字未动**，`git diff` 里 `expect(` 行数为 0）；那句「把 `status --porcelain` 挪到 `-N` 之后，这条会失败」在 `parseUntracked` 接受 ` A ` 之后已不成立。理由与处置见下方 Task 10 Step 5 变异体 B 的注记与文末 `## 执行记录` §15.7。

```ts
  it('被 gitignore 的新文件：**不得**进入 diff（正文尤其不能进——那是密钥泄漏路径）', () => {
    const { dir, base } = makeRepo('aieval-diff-ignored-');
    writeFileSync(join(dir, '.gitignore'), 'secret.log\n', 'utf8');
    git(dir, 'add', '.gitignore');
    git(dir, 'commit', '-q', '-m', '加入 gitignore');

    writeFileSync(join(dir, 'secret.log'), 'API_KEY=sk-live-should-never-reach-the-judge\n', 'utf8');
    const result = collectDiff(dir, base);
    // spec §5.5 第 6 步的第三个来源是「未跟踪的新文件」= `git status --porcelain` 的 `??`，
    // 而 `??` **不含**被 gitignore 的文件。忽略是有意的信号：构建产物、`node_modules`、
    // `.env` 都不该被当成候选的产出，更不该把 `.env` 的正文送进评分提示词。
    expect(result.text).not.toContain('sk-live-should-never-reach-the-judge');
    expect(result.files.some((file) => file.path === 'secret.log')).toBe(false);

    // 顺带守 baseline 参数的语义：传入的是调用方给的基线，而不是内部偷偷用 HEAD 覆盖
    // （基线选在 `.gitignore` 提交之前，那份改动就该出现在「已提交改动」段里）
    expect(section(collectDiff(dir, base).text, COMMITTED)).toContain('.gitignore');
  });

  it('三者都有：三段各自非空、计数是三者之和', () => {
    const { dir, base } = makeRepo('aieval-diff-all-');
    // ① 已提交：
    writeFileSync(join(dir, 'committed.ts'), 'export const committed = 1;\n', 'utf8');
    git(dir, 'add', 'committed.ts');
    git(dir, 'commit', '-q', '-m', '已提交的改动');
    // ② 未提交：
    writeFileSync(join(dir, 'a.txt'), 'hello\ndirty\n', 'utf8');
    // ③ 未跟踪：
    writeFileSync(join(dir, 'untracked.ts'), 'export const untracked = 2;\n', 'utf8');

    const result = collectDiff(dir, base);
    expect(section(result.text, COMMITTED)).toContain('+export const committed = 1;');
    expect(section(result.text, UNCOMMITTED)).toContain('+dirty');
    expect(section(result.text, UNTRACKED)).toContain('untracked.ts');
    expect(result.text).toContain('+export const untracked = 2;');
    expect(result.filesChanged).toBe(3);
    expect(result.files.map((file) => file.path).sort()).toEqual(['a.txt', 'committed.ts', 'untracked.ts']);
    expect(result.insertions).toBe(3);
    expect(result.deletions).toBe(0);
  });

  it('删除一个文件也算改动（计数是 0 增 1 删，不能因为 insertions 为 0 就漏掉它）', () => {
    const { dir, base } = makeRepo('aieval-diff-delete-');
    git(dir, 'rm', '-q', 'a.txt');
    const result = collectDiff(dir, base);
    expect(result.filesChanged).toBe(1);
    expect(result.files[0]?.deletions).toBe(1);
    expect(result.files[0]?.insertions).toBe(0);
  });

  it('中文文件名不被打成八进制转义（`core.quotepath=false` 的回归守卫）', () => {
    const { dir, base } = makeRepo('aieval-diff-cjk-');
    writeFileSync(join(dir, '中文文件.txt'), '内容\n', 'utf8');
    const result = collectDiff(dir, base);
    expect(result.text).toContain('中文文件.txt');
    expect(result.files.map((file) => file.path)).toContain('中文文件.txt');
  });
});

describe('truncateDiff', () => {
  /** 造一段含 n 个文件的 diff 文本，每个文件正文 bodySize 字节 */
  function makeDiffText(fileCount: number, bodySize: number): string {
    const parts: string[] = ['### 已提交改动（base..HEAD）\n'];
    for (let index = 1; index <= fileCount; index += 1) {
      parts.push(
        `diff --git a/file${index}.ts b/file${index}.ts\n` +
          `index 1111111..2222222 100644\n` +
          `--- a/file${index}.ts\n` +
          `+++ b/file${index}.ts\n` +
          `@@ -1 +1 @@\n` +
          `+${'x'.repeat(bodySize)}\n`,
      );
    }
    return parts.join('');
  }

  it('预算充足时原样返回，truncated 为 false 且不丢文件', () => {
    const text = makeDiffText(2, 10);
    const result = truncateDiff(text, 64 * 1024);
    expect(result.truncated).toBe(false);
    expect(result.droppedFiles).toEqual([]);
    expect(result.text).toBe(text);
  });

  it('超预算时按文件裁剪：保留前面的文件、丢掉后面的，并列出被丢文件名（spec §9）', () => {
    const text = makeDiffText(4, 400);
    // 预算只够段落头 + 一个文件：先量一个文件的真实大小，再给一个「刚够一个」的预算
    const oneFile = truncateDiff(makeDiffText(1, 400), 64 * 1024).text.length;
    const result = truncateDiff(text, oneFile + 10);

    expect(result.truncated).toBe(true);
    expect(result.droppedFiles.length).toBeGreaterThan(0);
    expect(result.text).toContain('已截断');
    // 被丢的文件名必须逐个出现在正文里（否则界面/评分模型不知道漏了什么）
    for (const dropped of result.droppedFiles) {
      expect(result.text).toContain(dropped);
    }
    // 保留的文件正文仍在
    expect(result.text).toContain('diff --git a/file1.ts b/file1.ts');
    // 最后一个文件被丢掉了（按文件顺序从后往前丢）
    expect(result.droppedFiles).toContain('file4.ts');
  });

  it('预算小于单个文件时也绝不产出「看起来没改动」的空文本（Review Focus 1）', () => {
    const text = makeDiffText(1, 4096);
    const result = truncateDiff(text, 64);
    expect(result.truncated).toBe(true);
    expect(result.text).toContain('已截断');
    expect(result.droppedFiles).toEqual(['file1.ts']);
    // 段落头必须留着：只留一句「已截断」而丢掉段标题，读者不知道这是哪一段
    expect(result.text).toContain('### 已提交改动');
  });

  it('没有 `diff --git` 的文本（空 diff / 只有段落头）原样返回', () => {
    const text = '### 已提交改动（base..HEAD）\n（无）\n### 未提交改动（工作区 vs HEAD）\n（无）\n### 未跟踪文件\n（无）\n';
    const result = truncateDiff(text, 8);
    expect(result.truncated).toBe(false);
    expect(result.droppedFiles).toEqual([]);
    expect(result.text).toBe(text);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @aieval/core test`
Expected: FAIL —— `Failed to resolve import "./git"` 里没有 `collectDiff` / `truncateDiff`：报 `does not provide an export named 'collectDiff'`。

- [ ] **Step 3: 最小实现（往 `git.ts` 追加）**

先把 import 行补全为：

```ts
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { basename, join, sep } from 'node:path';
```

然后在文件末尾追加：

```ts
/** 三样 diff 的段落标题（供评分模型与 diff 抽屉共用；改文案要同步改测试与 p5 的展示） */
const SECTION_COMMITTED = '### 已提交改动';
const SECTION_UNCOMMITTED = '### 未提交改动';
const SECTION_UNTRACKED = '### 未跟踪文件';
/** 段落为空时的占位：显式写「（无）」，避免「这一段落不存在」与「这一段落为空」被混为一谈 */
const EMPTY_SECTION = '（无）';
/** 裁剪标记（spec §5.5 第 7 步要求显式标明，否则评分模型会把「看不到的改动」当成「没改」） */
const TRUNCATED_MARK = '\n\n> **diff 已截断**：以下文件因超出体积上限未包含在本次评分输入中';

/**
 * 三样 diff 合并 + 计数（spec §5.5 第 6 步，口径见 §11 R3）。
 * **调用顺序不可调换**，下面是实测过的正确次序（git 2.47）：
 *   ① `git status --porcelain -z` 读未跟踪清单：必须在 `-N` **之前**读——实测 `-N` 之后
 *      同一份输出里 `?? b.txt` 会变成 ` A b.txt`，此时再按 `??` 过滤会得到空清单。
 *   ② `git diff HEAD --numstat`：已改未提交的「文件 → 增删行数」，同样在 `-N` 之前读，
 *      这样它的计数只含 agent 真的改过的文件。
 *   ③ `git add --intent-to-add --all`：只**登记**不暂存，让未跟踪文件的
 *      正文进入 `git diff HEAD`。不加它，新文件只有文件名——评分模型看不见内容，
 *      会把「看不到的改动」当成「没改」，静默给出错误的高分。
 *      **被 gitignore 的文件不进 diff**（R19）：`git add` 没有 `--include-ignored` 这个选项
 *      （实测 `git version 2.47.0.windows.2` 报 `error: unknown option`），而且忽略本身就是
 *      「这不是产出」的信号——把 `.env` 的正文送进评分提示词是密钥泄漏，把 `node_modules`
 *      送进去是噪声淹没真改动。spec §5.5 第 6 步的第三个来源也只说 `??` 未跟踪文件。
 *   ④ `git diff {baseline}..HEAD` + `git diff HEAD`：已提交与已改未提交的两份正文。
 *   ⑤ 已提交部分的计数用 `git diff --numstat {baseline}..HEAD`（不受 `-N` 影响，随时可读）。
 * 计数一律取 `--numstat` 的原始两列，不自己解析 `diff --git` 块：重命名与二进制文件的行数
 * 口径只有 git 自己算得对（二进制文件的两列是 `-`，按 0 计入并在文件清单里如实显示）。
 */
export function collectDiff(
  dir: string,
  baselineCommit: string,
): {
  text: string;
  files: { path: string; insertions: number; deletions: number }[];
  filesChanged: number;
  insertions: number;
  deletions: number;
} {
  // ①② 必须在 ③ 之前：见上面 JSDoc 的顺序说明
  const untracked = parseUntracked(execute(dir, ['status', '--porcelain', '-z']));
  const uncommittedFiles = parseNumstat(execute(dir, ['diff', '--numstat', 'HEAD']));

  execute(dir, ['add', '--intent-to-add', '--all']);

  // ④ 正文
  const committed = execute(dir, ['diff', '--no-color', `${baselineCommit}..HEAD`]).trimEnd();
  const uncommitted = execute(dir, ['diff', '--no-color', 'HEAD']).trimEnd();

  // ⑤ 已提交部分的计数
  const committedFiles = parseNumstat(execute(dir, ['diff', '--numstat', `${baselineCommit}..HEAD`]));

  const body = untracked.length === 0 ? '' : `${untracked.join('\n')}\n\n${uncommitted}`;
  const text = [
    `${SECTION_COMMITTED}（${baselineCommit}..HEAD）`,
    committed === '' ? EMPTY_SECTION : committed,
    '',
    `${SECTION_UNCOMMITTED}（工作区 vs HEAD）`,
    uncommitted === '' ? EMPTY_SECTION : uncommitted,
    '',
    SECTION_UNTRACKED,
    untracked.length === 0 ? EMPTY_SECTION : body,
    '',
  ].join('\n');

  const files = [...committedFiles, ...uncommittedFiles];
  const filesChanged = files.length;
  const insertions = files.reduce((sum, file) => sum + file.insertions, 0);
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0);

  log.debug('diff 已合并', {
    dir,
    baselineCommit,
    filesChanged,
    insertions,
    deletions,
    untracked: untracked.length,
  });
  return { text, files, filesChanged, insertions, deletions };
}

/**
 * `git status --porcelain -z` → 未跟踪文件清单。
 * 记录格式是「两个状态字符 + 空格 + 路径」，记录间用 NUL 分隔，故不能用 `split('\n')`：
 * 路径里可以有换行。只取 `??`（未跟踪），且**必须在 `git add --intent-to-add` 之前调用**：
 * 登记之后这些条目会变成 ` A`，`??` 过滤会得到空清单（实测）。
 */
function parseUntracked(output: string): string[] {
  return output
    .split('\0')
    .filter((record) => record !== '')
    .filter((record) => record.startsWith('?? '))
    .map((record) => record.slice(3));
}

/**
 * `git diff --numstat` → 「路径 + 增删行数」清单（供 `RowDiff.files` 与三个计数）。
 * 每行形如 `<插入>\t<删除>\t<路径>`（实测 `1\t1\ta.txt`）。
 * 三种需要处理的形态：
 *   ① 二进制文件的两列是 `-`（实测），按 0 计；
 *   ② 重命名会把路径写成 `old => new` 或 `{old => new}` 的花括号形式，只取 `=>` 之后的
 *      那一段作为新路径——文件树列的是「改完之后叫什么」；
 *   ③ 路径里可能有 `\t`（git 只在路径含特殊字符时才加引号，本仓用 `core.quotepath=false`，
 *      故按**前两个**制表符切分，剩下整段都是路径。
 */
function parseNumstat(output: string): { path: string; insertions: number; deletions: number }[] {
  return output
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const [added = '', removed = '', ...rest] = line.split('\t');
      const rawPath = rest.join('\t');
      const arrow = rawPath.lastIndexOf('=>');
      const path = (arrow < 0 ? rawPath : rawPath.slice(arrow + 2)).replace(/[{}]/g, '').trim();
      return {
        path,
        insertions: added === '-' ? 0 : Number(added),
        deletions: removed === '-' ? 0 : Number(removed),
      };
    });
}
```

接着追加 `truncateDiff` 与其两个内部工具：

```ts
/**
 * 按体积裁剪（spec §5.5 第 7 步 / §9）：按文件切分，保留到预算为止，
 * 输出含「已截断」标记与被丢弃文件清单。
 * 三个必须成立的行为：
 *   ① 被丢弃的文件名要逐个列在正文里——否则界面与评分模型都不知道漏了什么；
 *   ② 即便预算连一个文件都装不下，也**必须**保留段落头与「已截断」标记：
 *      产出一段「看起来没改动」的空文本是最坏的失败（评分模型会给出错误的高分）；
 *   ③ 预算是**字节**（`settings.diffBudgetBytes` 默认 262144），故用 `Buffer.byteLength`
 *      而不是 `string.length`——中文与 emoji 的字符数与字节数差 3 倍，用字符数会超预算。
 */
export function truncateDiff(
  text: string,
  budgetBytes: number,
): { text: string; truncated: boolean; droppedFiles: string[] } {
  const { header, pieces } = splitDiffFiles(text);
  if (pieces.length === 0) return { text, truncated: false, droppedFiles: [] };

  const used = Buffer.byteLength(header, 'utf8');
  if (used > budgetBytes) {
    const droppedFiles = pieces.map((piece) => piece.path);
    return { text: `${header}${truncationNotice(droppedFiles)}`, truncated: true, droppedFiles };
  }

  const kept: DiffPiece[] = [];
  const dropped: DiffPiece[] = [];
  let total = used;
  for (const piece of pieces) {
    const size = Buffer.byteLength(piece.text, 'utf8');
    if (total + size <= budgetBytes) {
      kept.push(piece);
      total += size;
      continue;
    }
    dropped.push(piece);
  }

  if (dropped.length === 0) return { text, truncated: false, droppedFiles: [] };
  const droppedFiles = dropped.map((piece) => piece.path);
  return {
    text: `${header}${kept.map((piece) => piece.text).join('')}${truncationNotice(droppedFiles)}`,
    truncated: true,
    droppedFiles,
  };
}

/** 一个文件段 */
interface DiffPiece {
  path: string;
  text: string;
}

/**
 * 按 `diff --git` 边界把文本切成「段落头 + 文件段」。
 * 切分点必须是行首的 `diff --git`：正文里出现同名字符串（比如一个恰好含这行的测试夹具）
 * 不该被当成新的文件段。
 */
function splitDiffFiles(text: string): { header: string; pieces: DiffPiece[] } {
  const chunks = text.split(/(?=^diff --git )/m);
  const header = chunks[0] ?? '';
  const pieces = chunks.slice(1).map((chunk) => {
    const headerMatch = /^diff --git a\/(.+?) b\/(.+)$/m.exec(chunk);
    return { path: headerMatch?.[2] ?? '', text: chunk };
  });
  return { header, pieces };
}

/** 截断标记 + 被丢弃文件清单（正文里可见，不只是返回值里的一个数组） */
function truncationNotice(droppedFiles: string[]): string {
  return `${TRUNCATED_MARK}\n${droppedFiles.map((file) => `- ${file}`).join('\n')}\n`;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @aieval/core test`
Expected: PASS（`git.diff.test.ts` 共 2 个 `describe` / 12 个 `it` 全绿，`git.repo.test.ts` 不受影响）。

Run: `pnpm typecheck`
Expected: 通过。

- [ ] **Step 5: 变异验证（四条，逐条做，做一条还原一条）**

先记下基线哈希：

Run: `git hash-object packages/server/core/src/git.ts`

**变异体 A —— 去掉 `--intent-to-add`（对应 R3 / Review Focus 2）**：把 `execute(dir, ['add', '--intent-to-add', '--all']);` 整行删掉。

Run: `pnpm --filter @aieval/core test -- src/git.diff.test.ts`
Expected: FAIL，且失败信息里能直接看到「正文不见了」：

```
FAIL src/git.diff.test.ts > collectDiff —— 三样合并的四种组合 > 只有未跟踪新文件：**正文**必须出现在 diff 文本里（**专门用例**，R3 的核心）
AssertionError: expected '### 已提交改动（…）\n（无）\n…' to contain '+export const answer = 42;'
```

还原（`git checkout -- packages/server/core/src/git.ts` 不行——本任务还没提交，用编辑器把那一行贴回去），确认 `git hash-object` 与基线一致。

**变异体 B —— 把未跟踪清单挪到 `-N` 之后读（对应实测结论 / 契约 §11 R3）**：把开头的

```ts
const untracked = parseUntracked(execute(dir, ['status', '--porcelain', '-z']));
```

整行**剪切**到 `execute(dir, ['add', '--intent-to-add', '--all']);` 之后。

Run: `pnpm --filter @aieval/core test -- src/git.diff.test.ts`
Expected: FAIL（清单变成空的，因为 `?? late.ts` 已变成 ` A late.ts`）：

```
FAIL src/git.diff.test.ts > collectDiff —— 三样合并的四种组合 > 未跟踪清单是在 `-N` **之前**读的（实测：登记后 `??` 会变成 ` A`，读晚了清单为空）
AssertionError: expected '\n\n（无）' to contain 'late.ts'
```

还原并核对哈希。

> **注记（2026-09-25，Task 15 跟进轮 R2）—— 变异体 B 在出货文本上已失去区分力；上面的描述与 `Expected` 保留原文，仅在 Task 10 当时的文本上成立。**
> Task 10 的 review 修复轮按 Minor #7 把 `parseUntracked` 放宽成同时接受 `?? ` 与 ` A `（`git.ts:443`，JSDoc 纠正前是 `:439`）。这条放宽是**必需**的：
> `collectDiff` 自己会跑 `-N`，同一工作区的**第二次**调用看到的就是 ` A`，只认 `?? ` 会让新文件从「未跟踪」漂移成「已改」。
> 放宽之后，登记**前**读得 `?? late.ts`、登记**后**读得 ` A late.ts`，两者都被接受 ⇒ 两种读序得到**同一份路径清单**，
> **没有任何断言能区分它们**。出货 blob（`git.ts` `c67444a5…`，以及 §15.8 注释-only 改动后的 `39e7ab87…`）上实测：按本条制造的变异体**存活**（`src/git.diff.test.ts` 20/20 绿、退出码 0）。
> 结论与处置：
> 1. **读序保持出货实现不变**（`git status --porcelain` 先于 `-N`）——这是 spec §5.5 第三个来源的字面读法，也让 `parseUntracked` 的主用例仍是 `?? `；
> 2. 但它的地位从「被测试钉住的守卫」改为**冗余保险**：真正保住结果的是那次放宽本身；
> 3. 若将来有人把 `parseUntracked` 收窄回只认 `?? `，读序会**重新**变成承重的——本注记就是给那个人的提示；
> 4. 配套改动：`git.diff.test.ts` 里那条用例的**标题与注释**已按 R1 改写为「未跟踪的新文件必须被列出、且正文出现在未提交段（读序已不可分辨）」，**断言逐字未动**（`git diff` 里 `expect(` 行数为 0）；`collectDiff` 自己的 JSDoc 也已按 §15.8 改述（**仅注释**），出货 blob 随之变为 `39e7ab87…`。
>
> 完整证据（五条变异体在出货 blob 上的重跑与重绑：A 杀、B 存活、C 杀、D 杀、M11 杀）见本文档末尾 `## 执行记录` §15.7 与 §15.8。

**变异体 C —— 丢掉「已截断」标记（对应 Review Focus 1）**：把 `truncationNotice` 的返回值改成 `''`（即 `return '';`）。

Run: `pnpm --filter @aieval/core test -- src/git.diff.test.ts`
Expected: FAIL：

```
FAIL src/git.diff.test.ts > truncateDiff > 超预算时按文件裁剪：…（spec §9）
AssertionError: expected '…' to contain '已截断'
```

还原并核对哈希。

**变异体 D —— 把 `parseNumstat` 的插入列读成固定 0**：把 `insertions: added === '-' ? 0 : Number(added),` 改成 `insertions: 0,`。

Run: `pnpm --filter @aieval/core test -- src/git.diff.test.ts`
Expected: FAIL：

```
FAIL src/git.diff.test.ts > collectDiff —— 三样合并的四种组合 > 只有已提交改动：出现在第一段，第二段为空
AssertionError: expected 0 to be 1
```

还原并核对哈希。

四条都做完后：

Run: `pnpm --filter @aieval/core test`
Expected: PASS（回到全绿）。把四次 FAIL 的原始输出与还原后的 `git hash-object` 结果贴进报告。

- [ ] **Step 6: 提交**

```bash
git add packages/server/core/src/git.ts packages/server/core/src/git.diff.test.ts
git commit -m "feat(core): 三样 diff 合并与按文件裁剪（未跟踪文件正文可见 + 截断标记）"
```

---

## Task 11: core —— `workspace.ts` 目录结构与 `prepareRowWorkspace`

**Files:**
- Create: `packages/server/core/src/workspace.ts`
- Create: `packages/server/core/src/workspace.test.ts`

**Interfaces:**
- Consumes: Task 9/10 的 `ensureCaseCache`、`copyWorkspace`、`checkoutRow`
- Produces（逐字来自契约 §3.3）：
  - `caseCacheDir(workspaceRoot: string, caseId: string): string`
  - `runDir(workspaceRoot: string, runId: string): string`
  - `rowDir(workspaceRoot: string, runId: string, rowId: string): string`
  - `rowWorkspaceDir(workspaceRoot: string, runId: string, rowId: string): string`
  - `rowAgentHomeDir(workspaceRoot: string, runId: string, rowId: string): string`
  - `rowEventsFile(workspaceRoot: string, runId: string, rowId: string): string`
  - `runSnapshotFile(workspaceRoot: string, runId: string): string`
  - `prepareRowWorkspace(input: { workspaceRoot: string; caseId: string; repoPath: string; runId: string; rowId: string; commitHash: string | null; branch: string }): { workspacePath: string; agentHome: string; baselineCommit: string }`

- [ ] **Step 1: 写失败测试 `workspace.test.ts`**

```ts
// @vitest-environment node
/**
 * 工作区目录结构与行工作区准备：真实 git CLI + 真实目录复制。
 * 三条最关键的守卫：
 *   ① 目录布局逐字等于 spec §6.3（缓存 / workspace / .agenthome / events.jsonl 四者的位置）；
 *   ② 重跑同一行必须**清掉旧工作区**——否则第二个候选是在第一个候选的改动之上继续写，
 *      分数无意义、整轮作废（spec §3 F6 否决的正是这件事）；
 *   ③ `commitHash: null` 时 `baselineCommit` 必须是 40 位具体 hash（R2）。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getConfigDir, setConfigDirForTesting } from './config-store';
import {
  caseCacheDir,
  prepareRowWorkspace,
  rowAgentHomeDir,
  rowDir,
  rowEventsFile,
  rowWorkspaceDir,
  runDir,
  runSnapshotFile,
} from './workspace';

const created: string[] = [];

function makeTmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=test@aieval.local', '-c', 'user.name=aieval-test', ...args], {
    cwd: dir,
    encoding: 'utf8',
  });
}

function makeRepo(): { dir: string; commit: string } {
  const dir = makeTmp('aieval-ws-src-');
  git(dir, 'init', '-q');
  writeFileSync(join(dir, 'a.txt'), 'hello\n', 'utf8');
  git(dir, 'add', 'a.txt');
  git(dir, 'commit', '-q', '-m', '初始提交');
  return { dir, commit: git(dir, 'rev-parse', 'HEAD').trim() };
}

let root: string;
let configDir: string;

beforeEach(() => {
  root = makeTmp('aieval-runs-');
  configDir = makeTmp('aieval-ws-cfg-');
  setConfigDirForTesting(configDir);
});

afterEach(() => {
  setConfigDirForTesting(null);
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('目录结构（spec §6.3 / 契约 §10）', () => {
  it('七个路径函数逐字给出约定位置', () => {
    expect(caseCacheDir(root, 'c-1')).toBe(join(root, 'cases', 'c-1', 'cache'));
    expect(runDir(root, 'run-1')).toBe(join(root, 'run-1'));
    expect(rowDir(root, 'run-1', 'row-1')).toBe(join(root, 'run-1', 'rows', 'row-1'));
    expect(rowWorkspaceDir(root, 'run-1', 'row-1')).toBe(join(root, 'run-1', 'rows', 'row-1', 'workspace'));
    expect(rowAgentHomeDir(root, 'run-1', 'row-1')).toBe(join(root, 'run-1', 'rows', 'row-1', '.agenthome'));
    expect(rowEventsFile(root, 'run-1', 'row-1')).toBe(join(root, 'run-1', 'rows', 'row-1', 'events.jsonl'));
    expect(runSnapshotFile(root, 'run-1')).toBe(join(root, 'run-1', 'run.json'));
  });

  it('事件日志与 run.json 落在行目录/运行目录内，不与 workspace 混在一起', () => {
    // workspace 内部是 agent 的工作副本，agent 可以随意在里面建文件；
    // 事件日志若也放进去，一次 `rm -rf` 就会把证据一起删掉
    expect(rowEventsFile(root, 'run-1', 'row-1').startsWith(rowWorkspaceDir(root, 'run-1', 'row-1'))).toBe(false);
    expect(runSnapshotFile(root, 'run-1').startsWith(runDir(root, 'run-1'))).toBe(true);
  });
});

describe('prepareRowWorkspace', () => {
  it('首次调用：克隆缓存 → 复制出工作区 → 建分支 → 建 .agenthome，并返回三个路径与基线', () => {
    const { dir, commit } = makeRepo();
    const result = prepareRowWorkspace({
      workspaceRoot: root,
      caseId: 'c-1',
      repoPath: dir,
      runId: 'run-1',
      rowId: 'row-1',
      commitHash: null,
      branch: 'test/row-1',
    });

    expect(result.workspacePath).toBe(rowWorkspaceDir(root, 'run-1', 'row-1'));
    expect(result.agentHome).toBe(rowAgentHomeDir(root, 'run-1', 'row-1'));
    expect(existsSync(join(result.workspacePath, '.git'))).toBe(true);
    expect(existsSync(join(root, 'cases', 'c-1', 'cache', '.git'))).toBe(true);
    expect(existsSync(result.agentHome)).toBe(true);
    // R2：null → 具体 40 位 hash
    expect(result.baselineCommit).toBe(commit);
    expect(result.baselineCommit).toHaveLength(40);
    expect(git(result.workspacePath, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('test/row-1');
  });

  it('给定 commitHash 时基线是那个 commit，工作区里没有它之后的文件', () => {
    const { dir } = makeRepo();
    const first = git(dir, 'rev-parse', 'HEAD').trim();
    writeFileSync(join(dir, 'later.txt'), 'later\n', 'utf8');
    git(dir, 'add', 'later.txt');
    git(dir, 'commit', '-q', '-m', '之后的提交');

    const result = prepareRowWorkspace({
      workspaceRoot: root,
      caseId: 'c-2',
      repoPath: dir,
      runId: 'run-2',
      rowId: 'row-2',
      commitHash: first,
      branch: 'test/row-2',
    });
    expect(result.baselineCommit).toBe(first);
    expect(existsSync(join(result.workspacePath, 'later.txt'))).toBe(false);
  });

  it('重跑同一行：清掉旧工作区（上一轮 agent 的改动绝不残留）', () => {
    const { dir } = makeRepo();
    const input = {
      workspaceRoot: root,
      caseId: 'c-3',
      repoPath: dir,
      runId: 'run-3',
      rowId: 'row-3',
      commitHash: null,
      branch: 'test/row-3',
    };
    const first = prepareRowWorkspace(input);
    // 模拟第一轮 agent 的产出：改了受跟踪文件 + 建了新文件 + 在自己家里写了配置
    writeFileSync(join(first.workspacePath, 'a.txt'), 'hello\n第一轮的改动\n', 'utf8');
    writeFileSync(join(first.workspacePath, 'agent-new.txt'), '第一轮的新文件\n', 'utf8');
    writeFileSync(join(first.agentHome, 'settings.json'), '{"model":"第一轮"}', 'utf8');

    const second = prepareRowWorkspace(input);
    expect(readFileSync(join(second.workspacePath, 'a.txt'), 'utf8')).toBe('hello\n');
    expect(existsSync(join(second.workspacePath, 'agent-new.txt'))).toBe(false);
    expect(existsSync(join(second.agentHome, 'settings.json'))).toBe(false);
    // 分支被重置到基线（不是复用上一轮那个已经前移的分支）
    expect(second.baselineCommit).toBe(first.baselineCommit);
    expect(git(second.workspacePath, 'rev-parse', 'HEAD').trim()).toBe(second.baselineCommit);
  });

  it('两行的目录互不相同（串行模式下也各自独立，spec §3 F6 的防回归）', () => {
    const { dir } = makeRepo();
    const base = { workspaceRoot: root, caseId: 'c-4', repoPath: dir, commitHash: null };
    const a = prepareRowWorkspace({ ...base, runId: 'run-4', rowId: 'row-a', branch: 'test/row-a' });
    const b = prepareRowWorkspace({ ...base, runId: 'run-4', rowId: 'row-b', branch: 'test/row-b' });
    expect(a.workspacePath).not.toBe(b.workspacePath);
    expect(a.agentHome).not.toBe(b.agentHome);
    // 在 A 里写文件，B 必须看不见
    writeFileSync(join(a.workspacePath, 'only-a.txt'), 'a\n', 'utf8');
    expect(existsSync(join(b.workspacePath, 'only-a.txt'))).toBe(false);
  });

  it('commit 不存在时抛 INVALID_REF，且不会留下一个「看起来建好了」的工作区', () => {
    const { dir } = makeRepo();
    let caught: unknown;
    try {
      prepareRowWorkspace({
        workspaceRoot: root,
        caseId: 'c-5',
        repoPath: dir,
        runId: 'run-5',
        rowId: 'row-5',
        commitHash: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
        branch: 'test/row-5',
      });
    } catch (error) {
      caught = error;
    }
    expect((caught as { code?: unknown }).code).toBe('INVALID_REF');
    expect(existsSync(join(rowWorkspaceDir(root, 'run-5', 'row-5'), '.git'))).toBe(false);
  });

  it('配置目录指针生效（本模块不读配置，这条是 Review Focus 5 的护栏）', () => {
    expect(getConfigDir()).toBe(configDir);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @aieval/core test`
Expected: FAIL —— `Failed to resolve import "./workspace" from "src/workspace.test.ts"`。

- [ ] **Step 3: 写实现 `workspace.ts`**

```ts
/**
 * 工作区引擎：目录结构 + 行工作区准备（spec §5.5 第 1/2 步、§6.3）。
 * 目录布局是**硬约定**（契约 §10），每一层都有消费者：
 *   {workspaceRoot}/cases/{caseId}/cache/   用例级缓存仓库（首次评测克隆一次，之后复制）
 *   {workspaceRoot}/{runId}/run.json        运行快照
 *   {workspaceRoot}/{runId}/rows/{rowId}/workspace   该行工作副本（分支 test/{rowId}）
 *   {workspaceRoot}/{runId}/rows/{rowId}/.agenthome  该行独立配置目录（CLAUDE_CONFIG_DIR 等）
 *   {workspaceRoot}/{runId}/rows/{rowId}/events.jsonl 该行事件日志（唯一真相源）
 * 两个必须成立的口径：
 *   1. 事件日志与 `run.json` **不在** workspace 里：agent 可以在 workspace 内随意建删文件，
 *      把证据放进去等于把证据交给被测对象；
 *   2. 重跑同一行必须**先清掉上一轮的工作产物**（`workspace/` + `.agenthome/`）：
 *      留下上一轮的工作区，第二个候选就是在第一个候选的改动之上继续写，分数无意义（spec §3 F6）。
 *      **`events.jsonl` 不在此列**——p0 评审的 Critical 修正（契约 §11 R27）把清理范围收窄到
 *      「prepare 自己产出的东西」：p4 会在 prepare **之前**就往这行写 `preparing`（seq 1），
 *      整目录清掉会让后续事件从 seq 1 重新发号，而 p5 的 SSE 按 seq 去重会**静默吞掉**第一帧。
 *      重跑时清空日志是 `resetEvents`（契约 §3.4）的职责，不是这里的。
 */
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger } from './logger';
import { checkoutRow, copyWorkspace, ensureCaseCache } from './git';

const log = createLogger('workspace');

/** 用例级缓存仓库目录 */
export function caseCacheDir(workspaceRoot: string, caseId: string): string {
  return join(workspaceRoot, 'cases', caseId, 'cache');
}

/** 一轮评测的产物目录（`run.json` 与 `rows/` 都在它下面） */
export function runDir(workspaceRoot: string, runId: string): string {
  return join(workspaceRoot, runId);
}

/** 单个候选行的产物目录（工作区、独立配置目录与事件日志都在它下面） */
export function rowDir(workspaceRoot: string, runId: string, rowId: string): string {
  return join(runDir(workspaceRoot, runId), 'rows', rowId);
}

/** 该行的工作副本目录（agent 的 cwd） */
export function rowWorkspaceDir(workspaceRoot: string, runId: string, rowId: string): string {
  return join(rowDir(workspaceRoot, runId, rowId), 'workspace');
}

/**
 * 该行的智能体独立配置目录（spec §3 F8）。
 * 必须**每行一个**：并行时多个 agent 会抢同一份 `~/.claude` / `~/.codex` 的会话文件，
 * 而且 `~/.claude/settings.json` 的 `env` 块会盖掉我们注入的模型路由。
 */
export function rowAgentHomeDir(workspaceRoot: string, runId: string, rowId: string): string {
  return join(rowDir(workspaceRoot, runId, rowId), '.agenthome');
}

/** 该行的事件日志（JSONL，唯一真相源） */
export function rowEventsFile(workspaceRoot: string, runId: string, rowId: string): string {
  return join(rowDir(workspaceRoot, runId, rowId), 'events.jsonl');
}

/** 运行快照文件（每次状态变更整体原子覆盖） */
export function runSnapshotFile(workspaceRoot: string, runId: string): string {
  return join(runDir(workspaceRoot, runId), 'run.json');
}

/**
 * 建行工作区：确保用例缓存 → 清掉同名旧目录（重跑同一行时）→ 复制缓存 → checkout 基线
 * → 建分支 → 建 `.agenthome`。
 * 为什么先确保缓存再清行目录：清完行目录、克隆却失败的话，这一行会停在一个「工作区不存在」
 * 的中间态；反过来先备好缓存，失败时旧工作区仍在原处，重跑是幂等的。
 * 返回值里的 `baselineCommit` 是 `checkoutRow` 解析出的 40 位具体 hash（§11 R2）——
 * p4 要把它写进 `EvalRow.baselineCommit`，p5 的 diff 路由要拿它去算 `collectDiff`。
 */
export function prepareRowWorkspace(input: {
  workspaceRoot: string;
  caseId: string;
  repoPath: string;
  runId: string;
  rowId: string;
  commitHash: string | null;
  branch: string;
}): { workspacePath: string; agentHome: string; baselineCommit: string } {
  const cache = caseCacheDir(input.workspaceRoot, input.caseId);
  ensureCaseCache(input.repoPath, cache);

  const dir = rowDir(input.workspaceRoot, input.runId, input.rowId);
  if (existsSync(dir)) {
    // 只清 prepare 自己产出的东西：workspace（上一轮 agent 的改动）与 .agenthome（上一轮的会话与配置）。
    // **events.jsonl 不清**——p0 评审的 Critical 修正（契约 §11 R27）：p4 在 prepare 之前就会往这行
    // 写 `preparing`（seq 1），整目录清掉会让后续事件从 seq 1 重新发号，p5 的 SSE 按 seq 去重会静默吞帧；
    // 清空日志是 resetEvents（契约 §3.4）的职责。注意 `ensureCaseCache` 现在带第三个参数（R28）。
    log.info('清理上一轮的行产物', { dir });
    rmSync(rowWorkspaceDir(input.workspaceRoot, input.runId, input.rowId), { recursive: true, force: true });
    rmSync(rowAgentHomeDir(input.workspaceRoot, input.runId, input.rowId), { recursive: true, force: true });
  }

  const workspacePath = rowWorkspaceDir(input.workspaceRoot, input.runId, input.rowId);
  const agentHome = rowAgentHomeDir(input.workspaceRoot, input.runId, input.rowId);
  copyWorkspace(cache, workspacePath);
  const { baselineCommit } = checkoutRow(workspacePath, input.commitHash, input.branch);
  mkdirSync(agentHome, { recursive: true });

  log.info('行工作区已就绪', { workspacePath, agentHome, branch: input.branch, baselineCommit });
  return { workspacePath, agentHome, baselineCommit };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @aieval/core test`
Expected: PASS（`workspace.test.ts` 共 2 个 `describe` / 8 个 `it` 全绿）。

Run: `pnpm typecheck`
Expected: 通过。

- [ ] **Step 5: 变异验证（一条）**

记下基线：`git hash-object packages/server/core/src/workspace.ts`

**变异体 —— 不清旧行目录（对应 Review Focus / spec §3 F6）**：把 `if (existsSync(dir)) { … rmSync … }` 整段删掉。

Run: `pnpm --filter @aieval/core test -- src/workspace.test.ts`
Expected: FAIL，且失败点正是「残留」：

```
FAIL src/workspace.test.ts > prepareRowWorkspace > 重跑同一行：清掉旧工作区（上一轮 agent 的改动绝不残留）
AssertionError: expected 'hello\n第一轮的改动\n' to be 'hello\n'
```

还原后核对 `git hash-object` 与基线一致。

- [ ] **Step 6: 提交**

```bash
git add packages/server/core/src/workspace.ts packages/server/core/src/workspace.test.ts
git commit -m "feat(core): 工作区目录结构与行工作区准备（重跑清理 + 基线解析）"
```

---

## Task 12: core —— `event-log.ts`

**Files:**
- Create: `packages/server/core/src/event-log.ts`
- Create: `packages/server/core/src/event-log.test.ts`

**Interfaces:**
- Consumes: `@aieval/contracts` 的 `AgentEvent`、`AgentEventSchema`
- Produces（逐字来自契约 §3.4）：
  - `appendEvent(file: string, event: PendingAgentEvent): AgentEvent`（`PendingAgentEvent` = 分配式 Omit，见实现块）
  - `readEvents(file: string): AgentEvent[]`
  - `readEventsAfter(file: string, afterSeq: number): AgentEvent[]`
  - `resetEvents(file: string): void`

- [ ] **Step 1: 写失败测试 `event-log.test.ts`**

```ts
// @vitest-environment node
/**
 * 事件日志：追加（seq 自动分配）、全量读、按 seq 续订、清空，以及损坏行的容忍。
 * 三条关键守卫：
 *   ① seq 从 1 开始且严格递增——SSE 的 `Last-Event-ID` 续订全靠它，重复或跳号都会丢事件；
 *   ② 坏行（写一半被杀、手工编辑、空行）只跳过该行并 WARN，其余事件必须全部读出来；
 *   ③ `at` 缺省时由写入器补 ISO 8601 时间戳（不要求调用方自己拼）。
 */
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendEvent, readEvents, readEventsAfter, resetEvents } from './event-log';

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aieval-events-'));
  file = join(dir, 'events.jsonl');
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe('appendEvent', () => {
  it('seq 从 1 开始、逐条 +1，并在缺省时补 ISO 8601 的 at', () => {
    const first = appendEvent(file, { type: 'log', stream: 'stdout', text: '第一行' });
    const second = appendEvent(file, { type: 'log', stream: 'stderr', text: '第二行' });
    expect(first.seq).toBe(1);
    expect(second.seq).toBe(2);
    expect(first.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(first.type).toBe('log');
  });

  it('调用方给了 at 就用调用方的（适配器可能知道自己事件的时间）', () => {
    const event = appendEvent(file, { type: 'status', status: 'running', at: '2026-09-22T10:30:00.000Z' });
    expect(event.at).toBe('2026-09-22T10:30:00.000Z');
  });

  it('文件是 JSONL：每行一个 JSON，且目标文件不存在时自动建目录', () => {
    const nested = join(dir, 'a', 'b', 'events.jsonl');
    appendEvent(nested, { type: 'status', status: 'preparing' });
    appendEvent(nested, { type: 'status', status: 'running' });
    const lines = readFileSync(nested, 'utf8').trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({ seq: 1, type: 'status', status: 'preparing' });
    expect(JSON.parse(lines[1] ?? '{}')).toMatchObject({ seq: 2, type: 'status', status: 'running' });
  });

  it('seq 接着文件里已有的最大 seq 走（进程重启后继续追加不重号）', () => {
    appendEvent(file, { type: 'status', status: 'pending' });
    writeFileSync(file, `${readFileSync(file, 'utf8')}${JSON.stringify({ seq: 99, at: 'x', type: 'end', exitReason: 'completed' })}\n`, 'utf8');
    expect(appendEvent(file, { type: 'status', status: 'judged' }).seq).toBe(100);
  });

  it('usage 与 score 这类负载对象原样落盘（不丢字段）', () => {
    appendEvent(file, { type: 'usage', tokens: { input: 10, cached: 2, output: 3 }, turns: 4 });
    const [event] = readEvents(file);
    expect(event).toMatchObject({ type: 'usage', tokens: { input: 10, cached: 2, output: 3 }, turns: 4 });
  });
});

describe('readEvents', () => {
  it('文件不存在返回空数组（抽屉首帧在还没跑过的行上也要能开）', () => {
    expect(readEvents(join(dir, 'nope.jsonl'))).toEqual([]);
  });

  it('跳过空行、坏 JSON 行与不符合 schema 的行，其余全部读出并 WARN（Review Focus 3）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    appendEvent(file, { type: 'status', status: 'running' });
    // ① 写了一半的 JSON（进程被杀在写盘中途）
    appendFileSync(file, '{"seq":2,"at":"2026-09-22T10:30:00.000Z","type":"lo\n', 'utf8');
    // ② 空行
    appendFileSync(file, '\n', 'utf8');
    // ③ 合法 JSON 但不符合事件 schema（缺 text）
    appendFileSync(file, `${JSON.stringify({ seq: 3, at: 'x', type: 'log', stream: 'stdout' })}\n`, 'utf8');
    appendEvent(file, { type: 'end', exitReason: 'completed' });

    const events = readEvents(file);
    expect(events.map((event) => event.type)).toEqual(['status', 'end']);
    expect(events.map((event) => event.seq)).toEqual([1, 4]);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('容忍文件开头的 UTF-8 BOM（外部工具编辑过日志文件）', () => {
    appendEvent(file, { type: 'status', status: 'running' });
    writeFileSync(file, `\uFEFF${readFileSync(file, 'utf8')}`, 'utf8');
    expect(readEvents(file)).toHaveLength(1);
  });

  it('返回的顺序就是落盘顺序（seq 升序，不重排）', () => {
    for (const status of ['pending', 'preparing', 'running'] as const) {
      appendEvent(file, { type: 'status', status });
    }
    expect(readEvents(file).map((event) => event.seq)).toEqual([1, 2, 3]);
  });
});

describe('readEventsAfter', () => {
  it('只返回 seq > afterSeq 的部分（SSE 的 Last-Event-ID 续订语义）', () => {
    for (const status of ['pending', 'preparing', 'running', 'judging'] as const) {
      appendEvent(file, { type: 'status', status });
    }
    expect(readEventsAfter(file, 2).map((event) => event.seq)).toEqual([3, 4]);
  });

  it('afterSeq 为 0 时返回全部（首次连接）', () => {
    appendEvent(file, { type: 'status', status: 'pending' });
    expect(readEventsAfter(file, 0)).toHaveLength(1);
  });

  it('afterSeq 超过最大 seq 时返回空数组（不是抛错，也不是全量重发）', () => {
    appendEvent(file, { type: 'status', status: 'pending' });
    expect(readEventsAfter(file, 999)).toEqual([]);
  });
});

describe('resetEvents', () => {
  it('清空后再追加从 seq 1 重新开始（重跑同一行前调用）', () => {
    appendEvent(file, { type: 'status', status: 'pending' });
    appendEvent(file, { type: 'status', status: 'running' });
    resetEvents(file);
    expect(readEvents(file)).toEqual([]);
    expect(appendEvent(file, { type: 'status', status: 'preparing' }).seq).toBe(1);
  });

  it('文件本来就不存在时不抛错', () => {
    expect(() => resetEvents(join(dir, 'absent.jsonl'))).not.toThrow();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @aieval/core test`
Expected: FAIL —— `Failed to resolve import "./event-log" from "src/event-log.test.ts"`。

- [ ] **Step 3: 写实现 `event-log.ts`**

```ts
/**
 * 每候选行的事件日志（`events.jsonl`）：追加 / 全量读 / 按 seq 续订 / 清空。
 * 四个必须成立的口径：
 *   1. `seq` 由**本模块**分配（文件里已有的最大 seq + 1，从 1 开始）：单调递增是 SSE
 *      `Last-Event-ID` 续订与前端去重的唯一依据，交给调用方自己发号必然重号；
 *   2. 追加用 `appendFileSync`（O_APPEND 语义）：Node 是单线程事件循环，本模块同步写盘，
 *      同一进程里的并发调用天然串行；事件日志不做跨进程写（§11 R6）；
 *   3. 坏行只跳过该行并 WARN，绝不让整段历史消失——JSONL 的意义就是「一行坏了不牵连别人」；
 *      schema 校验也放在读取侧（`AgentEventSchema.safeParse`），让手工编辑出来的脏数据可见；
 *   4. 文件不存在一律当空日志（读返回 `[]`，清空是 no-op）：评测还没跑过的行也要能打开抽屉。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { AgentEventSchema, type AgentEvent } from '@aieval/contracts';
import { createLogger } from './logger';

const log = createLogger('event-log');

/**
 * 待写入的事件：`AgentEvent` 是**判别联合**，直接用 `Omit<AgentEvent, 'seq' | 'at'>` 不会分配到各成员——
 * `keyof (A | B)` 只留公共键，类型被压成 `{ type: 'status' | 'log' | … } & { at?: string }`，
 * 于是 `appendEvent(file, { type: 'log', stream: 'stdout', text })` 这种字面量会因**多余属性**（TS2353）
 * 编译失败——而它正是 p4 唯一的调用形态，`pnpm typecheck` 会直接红。
 * 分配式 Omit 让每个联合成员各自被 Omit，成员自己的字段（stream / text / tokens / exitReason …）得以保留。
 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export type PendingAgentEvent = DistributiveOmit<AgentEvent, 'seq' | 'at'> & { at?: string };

/**
 * 追加一条事件并写入 events.jsonl（seq 由本模块按文件已有最大 seq + 1 分配），返回写入的完整事件。
 * `at` 缺省时补 `new Date().toISOString()`（ISO 8601 带时区，与全仓口径一致）。
 * 每次追加都要读一遍已有文件来定 seq：这是 O(n)/条的，但换来的是「进程重启后继续追加不重号」这个必要性质——
 * 内存里缓存计数器会让重启后的第一条重号。
 * 已记录的性能注记（p4 提出，本阶段不改）：一行的事件数到几千时，累计写入会退化成 O(n²)。
 * 真到那一步的修法是「按文件缓存 max seq + 比对文件字节数，长度不符才回读」——既保住不重号，
 * 又不牺牲正确性；本阶段先保正确，因为一轮评测的事件量还在几百量级。
 */
export function appendEvent(
  file: string,
  event: PendingAgentEvent,
): AgentEvent {
  const existing = readEvents(file);
  const maxSeq = existing.reduce((max, item) => Math.max(max, item.seq), 0);
  const full = { ...event, seq: maxSeq + 1, at: event.at ?? new Date().toISOString() } as AgentEvent;

  mkdirSync(join(file, '..'), { recursive: true });
  appendFileSync(file, `${JSON.stringify(full)}\n`, 'utf8');
  return full;
}

/** 读全量（抽屉首帧 + 下载）；文件不存在返回 [] */
export function readEvents(file: string): AgentEvent[] {
  return parseLines(file, 0);
}

/** 只读 seq > afterSeq 的部分（SSE 按 Last-Event-ID 续订） */
export function readEventsAfter(file: string, afterSeq: number): AgentEvent[] {
  return parseLines(file, afterSeq);
}

/** 清空该行的事件日志（重跑同一行前调用，避免新旧事件混在一个文件里） */
export function resetEvents(file: string): void {
  if (!existsSync(file)) return;
  // 删文件而不是写空串：下一次 appendEvent 会重新建，seq 自然从 1 开始
  rmSync(file, { force: true });
  log.info('事件日志已清空', { file });
}

/**
 * 逐行解析并校验，跳过 afterSeq 之前的、空行的、坏 JSON 的与不符合 schema 的行。
 * 坏行只 WARN 不抛：日志抽屉的可用性优先于数据完备性——一行写坏不该让整段历史打不开。
 */
function parseLines(file: string, afterSeq: number): AgentEvent[] {
  if (!existsSync(file)) return [];
  // 容忍 UTF-8 BOM：外部工具（PowerShell 5.1）编辑过的文件首行会带 U+FEFF，JSON.parse 直接抛
  const text = readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  const events: AgentEvent[] = [];

  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      log.warn('事件日志有一行不是合法 JSON，已跳过', { file, line: line.slice(0, 200) });
      continue;
    }
    const result = AgentEventSchema.safeParse(parsed);
    if (!result.success) {
      log.warn('事件日志有一行不符合事件契约，已跳过', { file, line: line.slice(0, 200) });
      continue;
    }
    if (result.data.seq > afterSeq) events.push(result.data);
  }

  return events;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @aieval/core test`
Expected: PASS（`event-log.test.ts` 共 4 个 `describe` / 12 个 `it` 全绿）。

Run: `pnpm typecheck`
Expected: 通过。若 `as AgentEvent` 报「转换可能不安全」，改成先建未带 seq 的对象再展开赋值即可（`const full: AgentEvent = { ...event, seq, at } as AgentEvent;` 的写法在 `verbatimModuleSyntax` 下是允许的，报错时按 TS 提示收窄）。

- [ ] **Step 5: 提交**

```bash
git add packages/server/core/src/event-log.ts packages/server/core/src/event-log.test.ts
git commit -m "feat(core): 事件日志落盘（seq 自动分配 + 坏行容忍 + 按 seq 续订）"
```

---

## Task 13: core —— `index.ts` 补齐出口

**Files:**
- Modify: `packages/server/core/src/index.ts`（整份替换，当前 14 行）

**Interfaces:**
- Consumes: Task 9–12 的全部出口
- Produces: 包根 `@aieval/core` 上的全部名字（契约 §3 的每一个），p1–p5 只从这里 import

- [ ] **Step 1: 写失败测试**

本任务的守卫就是 `pnpm typecheck` 与 p1–p5 的消费点（它们从包根 import）。为了让「漏出口」在 p0 阶段当场可见，在 `workspace.test.ts` 末尾追加一条从**包根**导入的用例：

```ts
describe('core 公共出口（`@aieval/core` 包根）', () => {
  it('git / workspace / event-log 的名字都能从包根拿到', async () => {
    const core = await import('./index');
    for (const name of [
      'isGitRepo', 'resolveRepoInfo', 'assertCommit', 'listCommits',
      'ensureCaseCache', 'copyWorkspace', 'checkoutRow', 'collectDiff', 'truncateDiff',
      'caseCacheDir', 'runDir', 'rowDir', 'rowWorkspaceDir', 'rowAgentHomeDir',
      'rowEventsFile', 'runSnapshotFile', 'prepareRowWorkspace',
      'appendEvent', 'readEvents', 'readEventsAfter', 'resetEvents',
      'createLogger', 'getConfigDir', 'loadConfig', 'saveConfig', 'setConfigDirForTesting',
      'defaultWorkspaceRoot', 'expandHome', 'resolveRootForRead', 'validateWorkspaceRoot',
    ]) {
      expect(typeof (core as Record<string, unknown>)[name]).toBe('function');
    }
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @aieval/core test -- src/workspace.test.ts`
Expected: FAIL —— `expected 'undefined' to be 'function'`（第一条就是 `isGitRepo`）。

- [ ] **Step 3: 最小实现（改 `index.ts`，整份替换）**

```ts
/** core 公共出口：零依赖基础能力（日志、配置落盘、路径工具、git 原语、工作区、事件日志）。 */
export { createLogger, type Logger } from './logger';
export {
  getConfigDir,
  loadConfig,
  saveConfig,
  setConfigDirForTesting,
  type AppConfig,
} from './config-store';
export { defaultWorkspaceRoot, expandHome, resolveRootForRead, validateWorkspaceRoot } from './paths';
export {
  assertCommit,
  checkoutRow,
  collectDiff,
  copyWorkspace,
  ensureCaseCache,
  isGitRepo,
  listCommits,
  resolveRepoInfo,
  truncateDiff,
} from './git';
export {
  caseCacheDir,
  prepareRowWorkspace,
  rowAgentHomeDir,
  rowDir,
  rowEventsFile,
  rowWorkspaceDir,
  runDir,
  runSnapshotFile,
} from './workspace';
export { appendEvent, readEvents, readEventsAfter, resetEvents, type PendingAgentEvent } from './event-log';
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @aieval/core test`
Expected: PASS（core 全部用例）。

Run: `pnpm typecheck`
Expected: 通过。

- [ ] **Step 5: 提交**

```bash
git add packages/server/core/src/index.ts packages/server/core/src/workspace.test.ts
git commit -m "feat(core): 汇总导出 git / workspace / event-log 全部原语"
```

---

## Task 14: evaluator —— `text-api.ts` 与 `judge-route.ts`（R5）

**Files:**
- Create: `packages/server/evaluator/src/text-api.ts`
- Create: `packages/server/evaluator/src/text-api.test.ts`
- Create: `packages/server/evaluator/src/judge-route.ts`
- Create: `packages/server/evaluator/src/judge-route.test.ts`
- Modify: `packages/server/evaluator/src/index.ts`（整份替换，当前 1 行 `export {};`）

**Interfaces:**
- Consumes: `@aieval/contracts` 的 `ProtocolType`、`ServiceError`、`Settings`；`@aieval/core` 的 `loadConfig`
- Produces（逐字来自契约 §5）：
  - `interface TextRoute { protocolType: ProtocolType; baseUrl: string; apiKey: string; modelId: string }`
  - `callTextApi(route: TextRoute, input: { system?: string; prompt: string }): Promise<string>`
  - `resolveJudgeRoute(input: { judgeProviderId: string | null; judgeModelId: string | null }): TextRoute`

- [ ] **Step 1: 写失败测试 `text-api.test.ts`**

```ts
// @vitest-environment node
/**
 * 文本 API 外壳：双协议（openai / anthropic）的非流式调用。
 * 注意：用 `vi.stubGlobal('fetch', …)` 桩掉 fetch（Node 18+ 有全局 fetch，不需要 polyfill）；
 * `afterEach` 必须 `vi.unstubAllGlobals()`，否则桩会泄漏给同文件后续用例。
 * 本文件要钉住的是**接线**（URL、请求头、请求体的形状、响应字段的取值路径），
 * 而不是 HTTP 客户端的行为——p4 的评分器与 p2 的「AI 生成」都依赖这份接线完全一致。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ServiceError, type ProtocolType } from '@aieval/contracts';
import { callTextApi, type TextRoute } from './text-api';

/** 造一个 fetch 响应（只需要 ok / status / json / text 四个成员） */
function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

/** 桩掉 fetch，返回一个能读到 (url, init) 的 spy */
function stubFetch(response: Response): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => response);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const route = (protocolType: ProtocolType): TextRoute => ({
  protocolType,
  baseUrl: protocolType === 'openai' ? 'https://api.deepseek.com/v1' : 'https://api.deepseek.com/anthropic',
  apiKey: 'sk-test-key',
  modelId: 'deepseek-chat',
});

/** 取第 n 次调用的 (url, init) */
function callArgs(fetchMock: ReturnType<typeof vi.fn>, index = 0): { url: string; init: RequestInit } {
  const call = fetchMock.mock.calls[index] as unknown as [string, RequestInit];
  return { url: call[0], init: call[1] };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('callTextApi —— OpenAI 兼容协议', () => {
  it('打 {baseUrl}/chat/completions，带 Bearer 与 model，取 choices[0].message.content', async () => {
    const fetchMock = stubFetch(jsonResponse({ choices: [{ message: { content: '生成结果' } }] }));
    const text = await callTextApi(route('openai'), { prompt: '写个 LRU' });

    const { url, init } = callArgs(fetchMock);
    expect(url).toBe('https://api.deepseek.com/v1/chat/completions');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer sk-test-key');
    expect(headers['content-type']).toBe('application/json');
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.model).toBe('deepseek-chat');
    expect(body.stream).toBe(false);
    expect(body.messages).toEqual([{ role: 'user', content: '写个 LRU' }]);
    expect(text).toBe('生成结果');
  });

  it('给了 system 时放在 messages 的第一条', async () => {
    const fetchMock = stubFetch(jsonResponse({ choices: [{ message: { content: 'ok' } }] }));
    await callTextApi(route('openai'), { system: '你是评分员', prompt: '打分' });
    const body = JSON.parse(String(callArgs(fetchMock).init.body)) as { messages: unknown[] };
    expect(body.messages).toEqual([
      { role: 'system', content: '你是评分员' },
      { role: 'user', content: '打分' },
    ]);
  });

  it('baseUrl 带尾斜杠时不产生双斜杠（用户手填的地址形态很多）', async () => {
    const fetchMock = stubFetch(jsonResponse({ choices: [{ message: { content: 'ok' } }] }));
    await callTextApi({ ...route('openai'), baseUrl: 'https://api.deepseek.com/v1/' }, { prompt: 'x' });
    expect(callArgs(fetchMock).url).toBe('https://api.deepseek.com/v1/chat/completions');
  });
});

describe('callTextApi —— Anthropic 兼容协议', () => {
  it('打 {baseUrl}/v1/messages，带 x-api-key 与 anthropic-version，拼接 text 块', async () => {
    const fetchMock = stubFetch(
      jsonResponse({ content: [{ type: 'text', text: '前半段' }, { type: 'text', text: '后半段' }] }),
    );
    const text = await callTextApi(route('anthropic'), { prompt: '写个 LRU' });

    const { url, init } = callArgs(fetchMock);
    expect(url).toBe('https://api.deepseek.com/anthropic/v1/messages');
    const headers = init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('sk-test-key');
    expect(headers['anthropic-version']).toBe('2023-06-01');
    expect(headers.Authorization).toBeUndefined();       // Anthropic 不认 Bearer
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.model).toBe('deepseek-chat');
    expect(body.max_tokens).toBeGreaterThan(0);
    expect(body.messages).toEqual([{ role: 'user', content: '写个 LRU' }]);
    expect(text).toBe('前半段后半段');
  });

  it('system 走顶层 system 字段而不是 messages（Anthropic 的接口形态）', async () => {
    const fetchMock = stubFetch(jsonResponse({ content: [{ type: 'text', text: 'ok' }] }));
    await callTextApi(route('anthropic'), { system: '你是评分员', prompt: '打分' });
    const body = JSON.parse(String(callArgs(fetchMock).init.body)) as Record<string, unknown>;
    expect(body.system).toBe('你是评分员');
    expect(body.messages).toEqual([{ role: 'user', content: '打分' }]);
  });

  it('baseUrl 末尾的 /v1 不会被叠成 /v1/v1/messages（Anthropic 侧用户常填错这一处）', async () => {
    const fetchMock = stubFetch(jsonResponse({ content: [{ type: 'text', text: 'ok' }] }));
    await callTextApi({ ...route('anthropic'), baseUrl: 'https://api.deepseek.com/anthropic/v1' }, { prompt: 'x' });
    expect(callArgs(fetchMock).url).toBe('https://api.deepseek.com/anthropic/v1/messages');
  });
});

describe('callTextApi —— 错误映射', () => {
  it('401 抛 AUTH_FAILED，message 与 context 都带 host（spec §10：错误信息指向设置页）', async () => {
    stubFetch(jsonResponse({ error: { message: 'invalid key' } }, 401));
    let caught: unknown;
    try {
      await callTextApi(route('openai'), { prompt: 'x' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ServiceError);
    expect((caught as ServiceError).code).toBe('AUTH_FAILED');
    expect((caught as Error).message).toContain('api.deepseek.com');
    expect((caught as ServiceError).context).toMatchObject({ host: 'api.deepseek.com' });
  });

  it('429 抛 RATE_LIMITED 并在 message 里建议改用串行（spec §10）', async () => {
    stubFetch(jsonResponse({ error: { message: 'rate limited' } }, 429));
    let caught: unknown;
    try {
      await callTextApi(route('anthropic'), { prompt: 'x' });
    } catch (error) {
      caught = error;
    }
    expect((caught as ServiceError).code).toBe('RATE_LIMITED');
    expect((caught as Error).message).toContain('串行');
  });

  it('其它非 2xx 抛 INTERNAL，message 含状态码与响应片段', async () => {
    stubFetch(jsonResponse({ error: { message: 'boom' } }, 500));
    let caught: unknown;
    try {
      await callTextApi(route('openai'), { prompt: 'x' });
    } catch (error) {
      caught = error;
    }
    expect((caught as ServiceError).code).toBe('INTERNAL');
    expect((caught as Error).message).toContain('500');
    expect((caught as Error).message).toContain('boom');
  });

  it('响应缺 choices[0].message.content 时抛 INTERNAL（不返回空串——空串会被当成一次成功的评分）', async () => {
    stubFetch(jsonResponse({ choices: [] }));
    await expect(callTextApi(route('openai'), { prompt: 'x' })).rejects.toThrow(/未返回文本内容/);
  });

  it('网络层抛错时折成 ServiceError 而不是把 fetch 的 TypeError 冒出去', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('fetch failed');
    }));
    let caught: unknown;
    try {
      await callTextApi(route('openai'), { prompt: 'x' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ServiceError);
    expect((caught as Error).message).toContain('api.deepseek.com');
  });
});
```

- [ ] **Step 2: 写失败测试 `judge-route.test.ts`**

```ts
// @vitest-environment node
/**
 * 评分路由解析：用例覆盖 > 全局默认；两边都没有则 CONFLICT + 指向设置页的中文原因。
 * 为什么解析放在 evaluator 而不是 api 层：evaluator 在评分阶段（p4）也要自己解析一次，
 * 而 evaluator 不能依赖 api（依赖方向单向）。
 * 注意：本文件用 setConfigDirForTesting + saveConfig 造出真实的配置文件，不 mock loadConfig——
 * 「用例覆盖 > 全局默认」这条优先级只有在真的走一遍读盘时才会被验证到。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ServiceError, SETTINGS_DEFAULTS, type Provider } from '@aieval/contracts';
import { loadConfig, saveConfig, setConfigDirForTesting } from '@aieval/core';
import { resolveJudgeRoute } from './judge-route';

let dir: string;

/** 造一个供应商记录（apiKey 是明文，本模块必须把它原样带进路由） */
function provider(id: string, models: string[]): Provider {
  return {
    id,
    name: `供应商 ${id}`,
    protocolType: 'openai',
    baseUrl: `https://${id}.example.com/v1`,
    apiKey: `sk-${id}-secret`,
    models: models.map((modelId) => ({ id: modelId, source: 'manual' as const })),
    createdAt: '2026-09-22T10:30:00.000Z',
    updatedAt: '2026-09-22T10:30:00.000Z',
  };
}

/** 写入一份含默认评分模型的配置 */
function seed(defaultJudge: { providerId: string; modelId: string } | null, providers: Provider[]): void {
  const config = loadConfig();
  config.settings = { ...SETTINGS_DEFAULTS, defaultJudge };
  config.providers = providers;
  saveConfig(config);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aieval-judge-'));
  setConfigDirForTesting(dir);
});

afterEach(() => {
  setConfigDirForTesting(null);
  rmSync(dir, { recursive: true, force: true });
});

describe('resolveJudgeRoute', () => {
  it('两边都没给时用全局默认（并带上明文 apiKey 与 baseUrl）', () => {
    seed({ providerId: 'p1', modelId: 'm1' }, [provider('p1', ['m1', 'm2'])]);
    expect(resolveJudgeRoute({ judgeProviderId: null, judgeModelId: null })).toEqual({
      protocolType: 'openai',
      baseUrl: 'https://p1.example.com/v1',
      apiKey: 'sk-p1-secret',
      modelId: 'm1',
    });
  });

  it('用例覆盖优先于全局默认（spec §3 F5）', () => {
    seed({ providerId: 'p1', modelId: 'm1' }, [provider('p1', ['m1']), provider('p2', ['m9'])]);
    const route = resolveJudgeRoute({ judgeProviderId: 'p2', judgeModelId: 'm9' });
    expect(route.baseUrl).toBe('https://p2.example.com/v1');
    expect(route.modelId).toBe('m9');
    expect(route.apiKey).toBe('sk-p2-secret');
  });

  it('两边都没配时抛 CONFLICT，message 指向设置页（未配置评分模型时按钮禁用 + Tooltip 的去向）', () => {
    seed(null, [provider('p1', ['m1'])]);
    let caught: unknown;
    try {
      resolveJudgeRoute({ judgeProviderId: null, judgeModelId: null });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ServiceError);
    expect((caught as ServiceError).code).toBe('CONFLICT');
    expect((caught as Error).message).toContain('评分模型');
    expect((caught as Error).message).toContain('设置');
  });

  it('只给一个 id 时抛 CONFLICT（两个 id 必须成对出现）', () => {
    seed(null, [provider('p1', ['m1'])]);
    for (const input of [{ judgeProviderId: 'p1', judgeModelId: null }, { judgeProviderId: null, judgeModelId: 'm1' }]) {
      let caught: unknown;
      try {
        resolveJudgeRoute(input);
      } catch (error) {
        caught = error;
      }
      expect((caught as ServiceError).code).toBe('CONFLICT');
      expect((caught as Error).message).toContain('成对');
    }
  });

  it('全局默认指向一个已被删除的供应商时抛 CONFLICT 并点名（不静默回落到别的供应商）', () => {
    seed({ providerId: 'gone', modelId: 'm1' }, [provider('p1', ['m1'])]);
    let caught: unknown;
    try {
      resolveJudgeRoute({ judgeProviderId: null, judgeModelId: null });
    } catch (error) {
      caught = error;
    }
    expect((caught as ServiceError).code).toBe('CONFLICT');
    expect((caught as Error).message).toContain('gone');
  });

  it('模型不在该供应商的清单里时抛 CONFLICT（配错了要在调用前就报，不是等模型 404）', () => {
    seed(null, [provider('p1', ['m1'])]);
    let caught: unknown;
    try {
      resolveJudgeRoute({ judgeProviderId: 'p1', judgeModelId: 'not-listed' });
    } catch (error) {
      caught = error;
    }
    expect((caught as ServiceError).code).toBe('CONFLICT');
    expect((caught as Error).message).toContain('not-listed');
    expect((caught as Error).message).toContain('p1');
  });
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `pnpm --filter @aieval/evaluator test`
Expected: FAIL —— `Failed to resolve import "./text-api"` 与 `Failed to resolve import "./judge-route"`。

- [ ] **Step 4: 写实现 `text-api.ts`**

```ts
/**
 * 非流式文本 API 外壳：一次调用拿一段文本，供「AI 生成评分提示词」（p2）与评分调用（p4）共用。
 * 为什么要共用一个外壳（§11 R5）：两处都是「非流式文本 API + 双协议路由」，
 * 写两份必然漂移——而漂移的表现是「生成能跑、评分 401」这类只在某一条路径上出现的故障。
 * 三个必须成立的口径：
 *   1. 双协议的接线不同，必须各自正确：OpenAI 打 `/chat/completions` 用 `Authorization: Bearer`、
 *      取 `choices[0].message.content`；Anthropic 打 `/v1/messages` 用 `x-api-key` + `anthropic-version`、
 *      system 走顶层字段、取 `content[]` 里的 text 块并拼接；
 *   2. baseUrl 的拼法要容忍用户手填的各种形态（尾斜杠、Anthropic 侧多写一个 `/v1`），
 *      见 `endpoint()`；
 *   3. 失败一律折成带中文原因的 `ServiceError`：401 → `AUTH_FAILED`（带 host，指向设置页）、
 *      429 → `RATE_LIMITED`（建议改用串行）、其余 → `INTERNAL`。绝不放任 `TypeError: fetch failed`
 *      冒到路由层——那对用户等于没有解释。
 */
import { ServiceError, type ProtocolType } from '@aieval/contracts';

/** 一次文本调用的路由：三种协议的必填项完全一致（模型 id 与凭据都在这里） */
export interface TextRoute {
  protocolType: ProtocolType;
  baseUrl: string;
  apiKey: string;
  modelId: string;
}

/** Anthropic 必须带版本头，缺它上游直接 400 */
const ANTHROPIC_VERSION = '2023-06-01';
/** 非流式调用的输出上限：评分结果是几十行的 JSON，4096 足够且能防住跑飞的模型 */
const MAX_TOKENS = 4096;

/**
 * 拼请求地址。
 * openai：`{base}/chat/completions`——用户在设置页填的就是含 `/v1` 的 baseURL（spec §6.1 的例子），
 *   所以这里**不再补** `/v1`，只去掉末尾多余的斜杠。
 * anthropic：`{base}/v1/messages`——但用户很可能把 baseURL 填成已经带 `/v1` 的形式，
 *   这时再拼一次会得到 `/v1/v1/messages`（上游 404）。故先把结尾的 `/v1` 剥掉再拼。
 */
function endpoint(route: TextRoute): string {
  const base = route.baseUrl.replace(/\/+$/, '');
  if (route.protocolType === 'anthropic') {
    return `${base.replace(/\/v1$/, '')}/v1/messages`;
  }
  return `${base}/chat/completions`;
}

/** 从 URL 里取 host（错误文案与 context 都要它：用户要据此判断是哪个供应商的问题） */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * 调用文本 API 并返回模型输出的纯文本。
 * 非流式（`stream: false`）是刻意的：评分与提示词生成都要完整结果，流式只会让解析更复杂。
 */
export async function callTextApi(
  route: TextRoute,
  input: { system?: string; prompt: string },
): Promise<string> {
  const url = endpoint(route);
  const host = hostOf(url);
  const headers: Record<string, string> =
    route.protocolType === 'anthropic'
      ? {
          'content-type': 'application/json',
          'x-api-key': route.apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
        }
      : {
          'content-type': 'application/json',
          Authorization: `Bearer ${route.apiKey}`,
        };

  const body =
    route.protocolType === 'anthropic'
      ? {
          model: route.modelId,
          max_tokens: MAX_TOKENS,
          stream: false,
          // Anthropic 的 system 是**顶层字段**，放进 messages 会被当成普通用户消息
          ...(input.system === undefined ? {} : { system: input.system }),
          messages: [{ role: 'user', content: input.prompt }],
        }
      : {
          model: route.modelId,
          stream: false,
          messages: [
            ...(input.system === undefined ? [] : [{ role: 'system', content: input.system }]),
            { role: 'user', content: input.prompt },
          ],
        };

  let response: Response;
  try {
    response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  } catch (error) {
    throw new ServiceError('INTERNAL', `调用文本 API 失败（${host}）：${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
      context: { host, url },
    });
  }

  const raw = await response.text();
  if (!response.ok) throw httpError(response.status, host, url, raw);

  return route.protocolType === 'anthropic' ? parseAnthropic(raw, host) : parseOpenAI(raw, host);
}

/** 非 2xx → 可展示的中文原因（状态码分类见 spec §10 的错误表） */
function httpError(status: number, host: string, url: string, raw: string): ServiceError {
  const snippet = raw.slice(0, 300);
  if (status === 401 || status === 403) {
    return new ServiceError('AUTH_FAILED', `供应商密钥无效或无权访问（${host}）：请到设置页检查该供应商的 API 密钥`, {
      context: { host, url, status, body: snippet },
    });
  }
  if (status === 429) {
    return new ServiceError('RATE_LIMITED', `上游限流（${host}）：请降低并发，把评测改成串行后重试`, {
      context: { host, url, status, body: snippet },
    });
  }
  return new ServiceError('INTERNAL', `文本 API 返回 HTTP ${status}（${host}）：${snippet}`, {
    context: { host, url, status, body: snippet },
  });
}

/** 解析 OpenAI 兼容响应：`choices[0].message.content` */
function parseOpenAI(raw: string, host: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ServiceError('INTERNAL', `文本 API 返回的不是合法 JSON（${host}）：${raw.slice(0, 300)}`, {
      context: { host, body: raw.slice(0, 300) },
    });
  }
  const content = (parsed as { choices?: { message?: { content?: unknown } }[] }).choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    throw new ServiceError('INTERNAL', `文本 API 未返回文本内容（${host}）：${raw.slice(0, 300)}`, {
      context: { host, body: raw.slice(0, 300) },
    });
  }
  return content;
}

/** 解析 Anthropic 响应：拼接 `content[]` 里所有 `type: 'text'` 块 */
function parseAnthropic(raw: string, host: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ServiceError('INTERNAL', `文本 API 返回的不是合法 JSON（${host}）：${raw.slice(0, 300)}`, {
      context: { host, body: raw.slice(0, 300) },
    });
  }
  const blocks = (parsed as { content?: { type?: string; text?: unknown }[] }).content;
  const text = (blocks ?? [])
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('');
  if (text === '') {
    throw new ServiceError('INTERNAL', `文本 API 未返回文本内容（${host}）：${raw.slice(0, 300)}`, {
      context: { host, body: raw.slice(0, 300) },
    });
  }
  return text;
}
```

- [ ] **Step 5: 写实现 `judge-route.ts`**

```ts
/**
 * 评分模型路由解析：用例覆盖 > 全局默认；都没有则抛 CONFLICT + 指向设置页的中文原因。
 * 为什么放在 evaluator 而不是 api 层：evaluator 在 p4 的评分阶段也要自己解析一次，
 * 而 evaluator 不能依赖 api（依赖方向单向）。api 层只做转出（契约 §6 的 `judge.ts`）。
 * 四种失败都要给出**具体到 id** 的原因，而不是笼统的「未配置」：
 *   ① 两边都没有；② 只给了一个 id（两个 id 必须成对）；③ 指向的供应商已被删除；
 *   ④ 模型不在该供应商的清单里。②③④ 的共同点是「配置看起来有、实际用不了」——
 *   笼统报「未配置」会让用户去设置页反复确认一个明明填了的字段。
 */
import { ServiceError, type ProtocolType } from '@aieval/contracts';
import { createLogger, loadConfig } from '@aieval/core';
import type { TextRoute } from './text-api';

const log = createLogger('judge-route');

/** 评分模型未配置时的统一去向文案（设置页的评分配置分区） */
const GO_SETTINGS = '请先到「设置 → 评分配置」里选择默认评分模型';

/**
 * 解析评分路由：用例上填了就用用例的，否则用设置页的全局默认。
 * 供应商记录里的 `apiKey` 是明文（服务端要原 token 才能代调），这里原样带进路由；
 * 路由只在服务端内部流转，绝不出现在任何下行响应里（下行一律用 `ProviderView` 的掩码字段）。
 */
export function resolveJudgeRoute(input: {
  judgeProviderId: string | null;
  judgeModelId: string | null;
}): TextRoute {
  const config = loadConfig();
  const fromCase = input.judgeProviderId !== null && input.judgeModelId !== null;
  const halfConfigured =
    (input.judgeProviderId === null) !== (input.judgeModelId === null);

  if (halfConfigured) {
    throw new ServiceError(
      'CONFLICT',
      `评分模型的供应商与模型必须成对出现（当前：供应商 ${String(input.judgeProviderId)}、模型 ${String(input.judgeModelId)}）`,
      { context: { ...input } },
    );
  }

  // 用例覆盖 > 全局默认（spec §3 F5）；用例上没填时全局默认也必须存在
  const providerId = fromCase ? input.judgeProviderId : config.settings.defaultJudge?.providerId ?? null;
  const modelId = fromCase ? input.judgeModelId : config.settings.defaultJudge?.modelId ?? null;

  if (providerId === null || modelId === null) {
    throw new ServiceError('CONFLICT', `未配置评分模型：${GO_SETTINGS}`, { context: { ...input } });
  }

  const provider = config.providers.find((item) => item.id === providerId);
  if (provider === undefined) {
    throw new ServiceError('CONFLICT', `评分模型指向的供应商不存在（${providerId}）：可能已被删除，${GO_SETTINGS}`, {
      context: { providerId, modelId },
    });
  }
  if (!provider.models.some((model) => model.id === modelId)) {
    throw new ServiceError(
      'CONFLICT',
      `供应商「${provider.name}」（${providerId}）的模型清单里没有 ${modelId}：请在设置页拉取或手工添加该模型`,
      { context: { providerId, modelId } },
    );
  }

  const protocolType: ProtocolType = provider.protocolType;
  log.debug('评分路由已解析', { providerId, modelId, protocolType, source: fromCase ? 'case' : 'default' });
  return { protocolType, baseUrl: provider.baseUrl, apiKey: provider.apiKey, modelId };
}
```

- [ ] **Step 6: 改 `src/index.ts`（整份替换）**

```ts
/**
 * evaluator 公共出口。
 * p0 只有两个自包含模块（文本 API 外壳与评分路由解析），它们不依赖编排状态机，
 * 因此在用例域（p2 的「AI 生成评分提示词」）之前就能被消费；p4 在其上搭编排、评分与事件总线。
 */
export { callTextApi, type TextRoute } from './text-api';
export { resolveJudgeRoute } from './judge-route';
```

- [ ] **Step 7: 运行测试确认通过**

Run: `pnpm --filter @aieval/evaluator test`
Expected: PASS（`text-api.test.ts` 9 个 `it` + `judge-route.test.ts` 6 个 `it` 全绿）。

Run: `pnpm typecheck`
Expected: 通过。

- [ ] **Step 8: 提交**

```bash
git add packages/server/evaluator/src/text-api.ts packages/server/evaluator/src/text-api.test.ts packages/server/evaluator/src/judge-route.ts packages/server/evaluator/src/judge-route.test.ts packages/server/evaluator/src/index.ts
git commit -m "feat(evaluator): 文本 API 外壳与评分路由解析（双协议非流式，R5）"
```

---

## Task 15: 收尾——全量验证与提交

**Files:**
- Modify: `packages/server/core/src/workspace.test.ts`（Step 4 在文件末尾追加一个 `describe`）
- Modify: `docs/superpowers/plans/2026-09-22-features-p0-contracts-core.md`（Step 6 追加 `## 执行记录`）
- 其余无新增；只跑命令与记录证据

> 预检修正（2026-09-25）：本节原先写「无新增；只跑命令」，但 Step 4 会往 `workspace.test.ts` 追加用例、Step 6 会改本计划文件，
> 而本节没有提交步骤——两处改动会留在工作区里不进任何提交（任务标题里的「与提交」也就落空了）。故补齐 Files 与 Step 7。

**Interfaces:**
- Consumes: Task 1–14 的全部产出
- Produces: 一个可被 p1 直接消费的 p0 基线（`pnpm test` 全绿、`pnpm lint` 零错误、无测试产物污染仓库）

- [ ] **Step 1: 全量类型检查**

Run: `pnpm typecheck`
Expected: 8 个包全部通过（含 `apps/web-next`，它 import 了 contracts / core；本次改动只加出口，不应破坏它）。

- [ ] **Step 2: 全量 lint**

Run: `pnpm lint`
Expected: 零错误。常见两类需要修：
- `unused-imports/no-unused-imports`：Task 9/10 里 `git.ts` 的 import 是按任务分两步补的，最后确认没有多余名字；
- `@stylistic/indent`：本计划的长对象字面量按 2 空格缩进书写，与仓库一致。

- [ ] **Step 3: 全量测试**

Run: `pnpm test`
Expected: 全部包通过。core 的 git 测试会真实执行 git 子进程，Windows 上比纯函数测试慢几秒属正常，不要为提速把它们改成 mock（spec §9 明令禁 mock）。

- [ ] **Step 4: 确认四个新契约的 schema 真能解析本计划产出的形状（R8/R9 的落实核验）**

Task 4 的 `EvalRowSchema` 现在要求 `providerId` 与 `error.code`。p1–p5 会照着 spec §7.2 的 TS 块构造行对象，而 spec 那一块**没有**这两个字段——所以这里必须留一份「契约即真源」的可执行证据，而不是只靠计划里的说明。在 `packages/server/core/src/workspace.test.ts` 末尾追加：

```ts
describe('EvalRow 契约与本计划产出的形状对齐（R8 / R9 的落实核验）', () => {
  it('一个按契约构造的行对象能通过 EvalRowSchema（字段名与必填项以 contracts 为准，不是 spec §7.2 的 TS 块）', async () => {
    const { EvalRowSchema } = await import('@aieval/contracts');
    const row = {
      id: 'row-1',
      agentKind: 'claude-code',
      // R8：执行期定位凭据用 id，展示快照 providerName 可以被改名
      providerId: 'p-1',
      providerName: '网关',
      baseUrl: 'https://gw.example.com/anthropic',
      modelId: 'claude-opus-4-6',
      status: 'judged',
      branch: 'test/row-1',
      workspacePath: rowWorkspaceDir(root, 'run-1', 'row-1'),
      // R2：40 位具体 hash（prepareRowWorkspace 的返回值就长这样）
      baselineCommit: 'a'.repeat(40),
      tokens: { input: 1, cached: 0, output: 2 },
      turns: 1,
      durationMs: 1000,
      diff: { filesChanged: 1, insertions: 1, deletions: 0, truncated: false },
      score: null,
      // R9：code 必填，且要能同时装下 AgentErrorCode 与接口层 ErrorCode
      error: { code: 'JUDGE_PARSE_FAILED', message: '维度缺失' },
    };
    expect(EvalRowSchema.safeParse(row).success).toBe(true);
    expect(EvalRowSchema.safeParse({ ...row, baselineCommit: 'abc1234' }).success).toBe(true); // 只要求是字符串；空串 = 尚未准备也是合法的（R2）
    expect(EvalRowSchema.safeParse({ ...row, providerId: undefined }).success).toBe(false);
    expect(EvalRowSchema.safeParse({ ...row, error: { message: '维度缺失' } }).success).toBe(false);
  });
});
```

Run: `pnpm --filter @aieval/core test -- src/workspace.test.ts`
Expected: PASS。

- [ ] **Step 5: 确认测试没有污染真实家目录与仓库（Review Focus 5）**

Run: `git status --short`
Expected: 只看到本计划新增/修改的源码与计划文件；**没有** `aieval-*` 临时目录、没有 `~/.aieval` 相关文件的痕迹。

Run: `git log --oneline -1 --stat -- packages/server/core/src/git.ts`
Expected: 文件已在 Task 10 提交（顺带确认没有把测试临时目录误加进来）。

Run（PowerShell）：`Test-Path (Join-Path $HOME '.aieval')`
Expected: `False`（本计划全程不写真实配置目录）。若为 `True`，说明本机此前就存在该目录（用户自己的配置），此时改为核对它的 `LastWriteTime` 早于本次测试开始时间——**绝不能删用户目录**。

- [ ] **Step 6: 把证据写进计划（可选但推荐）**

在本文档末尾追加一节 `## 执行记录`，逐任务记录：完成的提交哈希、五条变异验证（Task 10 四条 + Task 11 一条）的失败输出与还原后的 `git hash-object`、`pnpm test` 的汇总行。变异验证没贴输出的守卫，在 p1 开始前要补做。

- [ ] **Step 7: 提交本任务的两处改动**

```bash
git add packages/server/core/src/workspace.test.ts
git add docs/superpowers/plans/2026-09-22-features-p0-contracts-core.md
git commit -m "test(core): EvalRow 契约对齐核验 + p0 执行记录"
```

Run: `git status --short`
Expected: 干净（除工作区里**不属于本计划**的未跟踪文件——本仓可能同时有别的会话在工作，那种文件保持原样、不要 `git add`）。

---

## 契约冲突

无。本计划逐条实现了接口契约 §2（contracts 扩全）、§3（core 的 git / workspace / event-log）、§5 中属于 p0 的两个模块，钉死的名字与签名一律照抄，未改名、未收窄签名；R8（`EvalRow.providerId`）与 R9（`EvalRow.error.code`）也已按契约定义落进 Task 4 的 `EvalRowSchema` 与对应用例。以下三处是**实现层**的顺序调整，均已在正文写明理由（不属于契约冲突）：

1. `prepareRowWorkspace` 内部先 `ensureCaseCache` 再清行目录（契约 §3.3 的括号描述是「清掉同名旧目录 → 复制缓存 → …」）：清完再克隆若失败会留下一个没有工作区的中间态，顺序反过来则失败时旧工作区仍在原处、重跑幂等。
2. Task 4（`run.ts`）依赖 Task 5（`score.ts`）的 `ScoreResultSchema`，故执行顺序为 Task 1 → 2 → 3 → 5 → 4 → 6 → 7；Task 4 的 Files 一节已显式标注这个前置。
3. `collectDiff` 内部的 git 调用顺序以**实测**为准（契约 §11 R3 的实测结论）：`status --porcelain` 与 `diff --numstat HEAD` 都在 `add --intent-to-add` **之前**读（登记后 `??` 会变成 ` A`，读晚了未跟踪清单为空），`add -N` 之后才取两份 diff 正文。契约 §3.2 给出的四段文本格式逐字保留。

## 需要 p1–p5 与 spec 同步的两处

以下两条不是本计划的契约冲突（契约 §2.4 已写明，本计划照做），但**上位 spec 的文字与它不一致**，执行者要在动 p1 之前先让消费方知道，否则会照着 spec 写出编译不过或语义不全的行对象：

1. **spec §7.2 的 `EvalRow` TS 块少了 `providerId` 与 `error.code`**（契约 §11 R8 / R9 已补齐）。p4 写行、p5 展示行时以 `contracts` 的 `EvalRowSchema` 为准；Task 15 Step 4 留了一条可执行的核验用例。
2. **三样 diff 的取法以本计划的实测结论为准**（契约 §11 R3）：未跟踪清单必须在 `git add --intent-to-add` 之前读，`files` 与计数取 `git diff --numstat`。Task 10 的实现里用 `--numstat` 取代了「自己解析 `diff --git` 块」，这不改变任何对外签名与字段名，但**建议在 p1 开工前把这条实测结论补进接口契约 §3.2**，让 p5 的 diff 路由不必自己再推导一遍。

---

## 执行记录

> 由 Task 15（收尾——全量验证与提交）在 `feat/features` 分支上补齐。本节只写**实际跑出来的输出**，不写预期值。
> 逐任务的详细报告在 `.superpowers/sdd/2026-09-22-features-p0-contracts-core/`（该目录被 `.superpowers/sdd/.gitignore` 的 `*` 忽略、**不入库**）；
> 本节把「提交哈希 / 五条变异验证 / 套件汇总行」收进计划本身，其余细节按文件名指过去。

### 15.1 全量验证（Step 1–3）

追加核验用例**之前**的原始基线：

| 命令 | 实际输出 | 退出码 |
| --- | --- | --- |
| `pnpm typecheck` | 无诊断输出（`tsc -p tsconfig.typecheck.json`，8 个包一并检查，含 `apps/web-next`） | 0 |
| `pnpm lint` | 无 error / warning 输出（`eslint .`） | 0 |
| `pnpm test` | `Test Files  35 passed (35)` / `Tests  345 passed (345)` / `Duration 73.30s` | 0 |

写完本节、提交前又跑了一遍（= 本任务提交的那份工作区内容）：

| 命令 | 实际输出 | 退出码 |
| --- | --- | --- |
| `pnpm typecheck` | 无诊断输出 | 0 |
| `pnpm lint` | 无 error / warning 输出 | 0 |
| `pnpm test` | `Test Files  35 passed (35)` / `Tests  346 passed (346)` / `Duration 88.86s` | 0 |

按包（Task 15 期间实测，core 的数字含本次追加的那条）：

```
pnpm --filter @aieval/contracts test   →  Test Files  8 passed (8)    Tests  79 passed (79)     exit 0
pnpm --filter @aieval/core test        →  Test Files  7 passed (7)    Tests 110 passed (110)    exit 0
pnpm --filter @aieval/evaluator test   →  Test Files  2 passed (2)    Tests  24 passed (24)     exit 0
```

**根级脚本口径**：`pnpm test` / `pnpm typecheck` / `pnpm lint` 已被另一会话的 `perf(toolchain)` 改成**单进程聚合**（根 `vitest.config.ts` 用 `projects` 收 8 个包、根 `tsconfig.typecheck.json` 是一个 tsc、`eslint .` 一次跑完），与本节写作时假设的「逐包 `pnpm -r`」不同；上表就是聚合跑法的实际输出。三个包级套件另跑了一遍，结论一致。

### 15.2 Step 4 的交叉核验用例（R8 / R9 的落实核验）

`packages/server/core/src/workspace.test.ts` 末尾追加 `describe('EvalRow 契约与本计划产出的形状对齐（R8 / R9 的落实核验）')`，用例正文逐字取自 Task 15 Step 4（另加一段中文 JSDoc 说明为何要留这条证据）：

```
$ pnpm --filter @aieval/core test -- src/workspace.test.ts
 ✓ src/workspace.test.ts (11 tests) 16324ms
 Test Files  1 passed (1)
      Tests  11 passed (11)
```

「契约即真源」在代码里的落点（逐行核对）：

- `packages/server/contracts/src/run.ts:64` `providerId: z.string().min(1)` → 必填（R8）；
- `packages/server/contracts/src/run.ts:94` `error: z.object({ code: z.string(), … }).nullable()` → `code` 必填（R9）；
- `packages/server/contracts/src/run.ts:74` `baselineCommit: z.string()` → 只要求是字符串（R2：空串 = 尚未准备也合法）。

两条反向断言（`providerId: undefined`、`error` 缺 `code`）实测均为 `false`——这条用例有区分力，不是恒真断言。

### 15.3 逐任务提交（Task 1–14；只列本计划自己的提交）

| Task | 提交 | 说明 |
| --- | --- | --- |
| 1 | `ccfcf49` | 三个功能阶段错误码 |
| 2 | `b6e63d6` | `provider.ts` |
| 3 | `0077723` | `case.ts` |
| 4 | `1547bca` | `run.ts`（含 R8 / R9 的两个字段） |
| 5 | `6e4c24e` | `score.ts` |
| 6 | `9df8679` | `agent-event.ts` |
| 7 | `7e6ed91` | `index.ts` 汇总出口 |
| 7（review 轮 1） | `ce77966` | 出口守卫补 `CaseCreate` / `CasePatch` |
| 8 | `b160ae2` | core `config-store` 去重复类型 |
| 9 | `26dc45f` | `git.ts` 仓库原语 |
| 10 | `84b8ffc` | `collectDiff` / `truncateDiff` |
| 10（review 修复轮） | `ea5ca1a` | 段落口径 / 计数 / 机器级 git 配置隔离 |
| 11 | `3d63a76` | `workspace.ts` |
| 12 | `0cbfe7b` | `event-log.ts` |
| 11+12（review 修复轮） | `cebbcb3` | git 环境隔离 + 发号守卫 + 清理失败包 `ServiceError` |
| 13 | `c49c361` | core 包根汇总出口 |
| 14 | `25ea394` | evaluator 文本 API 外壳 |

分支上另有**不属于** p0 实现的提交（`docs(contract)` / `docs(plans)` 的契约与计划修订、`perf(toolchain)` 的工具链聚合、`docs(agent)`），未列入上表，Task 15 也未改动它们。

### 15.4 五条变异验证（Task 10 四条 + Task 11 一条）

**证据出处**：五条的原始失败输出与还原后的 `git hash-object` 都在**被 git 忽略的报告文件**里，本计划正文中原本没有：

- 变异体 A–D（Task 10）：`.superpowers/sdd/2026-09-22-features-p0-contracts-core/task-9-10-report.md` **§2.4**；同一文件的 §7.1–§7.11 是 Task 10 review 修复轮在**新文本**上重跑的另外十条（**不含** A–D）。
- 变异体 M11（Task 11）：`.superpowers/sdd/2026-09-22-features-p0-contracts-core/task-11-12-report.md` **§11.4**（表内 M11 行，另有 M12 互补）。

以下是对上述报告原文的**摘录**；Task 15 **没有**重新制造变异体、也没有改动任何实现文件（`git status` 可证）：

**变异体 A —— 去掉 `git add --intent-to-add --all`（对应 R3 / Review Focus 2）**

```
 ❯ src/git.diff.test.ts (13 tests | 4 failed)
 FAIL  src/git.diff.test.ts > collectDiff —— 三样合并的四种组合 > 只有未跟踪新文件：**正文**必须出现在 diff 文本里（**专门用例**，R3 的核心）
AssertionError: expected '### 已提交改动（50d29bd2170604f02fc2f37c502…' to contain '+export const answer = 42;'
 ❯ src/git.diff.test.ts:124:25
```

还原后 `git hash-object packages/server/core/src/git.ts` = `26495032d98c2279aa7af956b75e751596cb01f8`（= 变异前）。

**变异体 B —— 未跟踪清单挪到 `-N` 之后读（对应实测结论 / 契约 §11 R3）**

```
 ❯ src/git.diff.test.ts (13 tests | 3 failed)
 FAIL  … > 只有未跟踪新文件：**正文**必须出现在 diff 文本里（**专门用例**，R3 的核心）
AssertionError: expected '\n（无）\n' to contain 'new.ts'          ❯ src/git.diff.test.ts:121:45
 FAIL  … > 未跟踪清单是在 `-N` **之前**读的（实测：登记后 `??` 会变成 ` A`，读晚了清单为空）
AssertionError: expected '\n（无）\n' to contain 'late.ts'
 FAIL  … > 三者都有：三段各自非空、计数是三者之和
AssertionError: expected '\n（无）\n' to contain 'untracked.ts'
```

还原后哈希 = `26495032d98c2279aa7af956b75e751596cb01f8`。

**变异体 C —— 丢掉「已截断」标记（Review Focus 1）**

```
 ❯ src/git.diff.test.ts (13 tests | 2 failed)
 FAIL  src/git.diff.test.ts > truncateDiff > 超预算时按文件裁剪：保留前面的文件、丢掉后面的，并列出被丢文件名（spec §9）
AssertionError: expected '### 已提交改动（base..HEAD）\ndiff --git a/f…' to contain '已截断'
 ❯ src/git.diff.test.ts:234:25
```

还原后哈希 = `26495032d98c2279aa7af956b75e751596cb01f8`。

**变异体 D —— `parseNumstat` 插入列固定 0**

```
 ❯ src/git.diff.test.ts (13 tests | 4 failed)
 FAIL  … > 只有已提交改动：出现在第一段，第二段为空          AssertionError: expected +0 to be 1
 FAIL  … > 只有未提交改动：出现在第二段，第一段为空（**专门用例**…） AssertionError: expected +0 to be 1
 FAIL  … > 只有未跟踪新文件：**正文**必须出现在 diff 文本里（**专门用例**…） AssertionError: expected +0 to be 1
 FAIL  … > 三者都有：三段各自非空、计数是三者之和            AssertionError: expected +0 to be 3
```

还原后哈希 = `26495032d98c2279aa7af956b75e751596cb01f8`。

**变异体 M11 —— 不清旧行目录（Task 11，对应 spec §3 F6）**

```
 FAIL  src/workspace.test.ts > prepareRowWorkspace > 重跑同一行：清掉旧工作区（上一轮 agent 的改动绝不残留）
 ServiceError: 复制工作区失败：…（EIO, Access is denied. '…\workspace\.git\objects\2e'）
```

与计划预测的失败点不同：本机是 Windows，`cpSync` 覆盖上一轮**只读**的 git 对象先以 `EIO` 失败，因此到不了「残留内容」那条断言——用例仍然变红、变异体仍被杀死；「残留」方向由同轮的 M12 补齐（只清 `workspace` 不清整行目录 → `重跑同一行…` · `AssertionError: expected true to be false`，`.agenthome/settings.json` 残留）。
还原后哈希 = `03ea5d8b…`（= 提交 `3d63a76` 的 blob）。

**基线口径（已由跟进轮在出货文本上闭合，见 §15.7）**：

1. A–D 最初是在 `26495032…` 上做的，`git.ts` 之后被 review 修复轮 `ea5ca1a` 改成 `c67444a5585180f7c832e27aebb244d9e317c64c`。**§15.7 已在 `c67444a5…` 上逐条重跑**：A 仍然**杀死**（5 failed）；**B 存活**（20 passed——Minor #7 对 `parseUntracked` 的放宽让「读序」不再可分辨，见 §15.7 的发现；已按 R1/R2 改述与加注、读序降级为**冗余保险**）；C、D 经 R3 补跑后**均杀死**（2 failed / 5 failed）。随后 §15.8 又按裁决把 `collectDiff` 的 JSDoc **只改注释**地纠正为「刻意选择 + 冗余保险」，`git.ts` 出货 blob 变为 `39e7ab87bbfc622546a52542b120ac08196b8388`，并做了重绑：**A 在新 blob 上重跑仍杀死**（5 failed），B/C/D 按**靶点同一性**继续成立（字面未变、行号整体 +4），M11 因 `workspace.ts` 未动而仍直接绑定。
2. M11 最初在 `03ea5d8b…` 上做，`workspace.ts` 之后被 `cebbcb3` 改成 `f5b7a922c5f09365df51bdcb8ca8953374a6be19`（= 当前 blob；改动是给清目录失败包中文 `ServiceError`，见 `workspace.ts:84-95`）。**§15.7 已在 `f5b7a922…`（shipped blob）上重跑：仍然杀死**（1 failed，失败点正是「重跑同一行：清掉旧工作区」用例）。

**本次实测的收口核对**（`git hash-object <path>` 与 `git rev-parse HEAD:<path>` 逐字符相等）：

```
packages/server/core/src/git.ts        c67444a5585180f7c832e27aebb244d9e317c64c
packages/server/core/src/workspace.ts  f5b7a922c5f09365df51bdcb8ca8953374a6be19
```

（这是 §15.7 当时的核对结果。`git.ts` 随后经 §15.8 的注释-only 改动变为 `39e7ab87bbfc622546a52542b120ac08196b8388`；`workspace.ts` 至今仍是上面这个值。）

**已知未闭合项**（照抄各任务报告的如实结论，p1 开工前需 controller 决策）：

- Task 10：`truncateDiff` 的**字节**口径无用例覆盖（夹具全 ASCII，`byteLength === length`，字符口径会静默超预算）；`assertCommit` 的空串分支在错误码层面不可分辨。
- Task 11：M9「先清行目录再备缓存」**存活**（8 个 `it` 没有一条走「clone 失败且行目录已存在」的路径）；`workspace.test.ts:175` 的 `expect(second.baselineCommit).toBe(second.baselineCommit)` 是恒真断言（无测试价值，建议后续删掉）。
- Task 12：B1 / F1 两个变异体存活（均被另一道等价机制挡住，属「双保险」而非缺守卫）；`resetEvents` 的 `rmSync` 失败分支与 `workspace.ts` 清目录失败分支在套件内**不可能有变异体**（没有确定性输入能让 `rmSync` 抛错）。
- Task 10（§15.7 跟进轮新增；**已按 controller 裁决 R1/R2 处置，不再是缺口**）：「未跟踪清单必须在 `-N` 之前读」这条守卫的变异体 B 在 shipped blob 上**存活**（20 passed）——Minor #7 把 `parseUntracked` 放宽成同时接受 `?? ` 与 ` A `（这本身是必需的，否则同一工作区的第二次调用分类会漂移）之后，两种读序在可观测行为上已无区别。处置：`git.diff.test.ts` 的用例已按 R1 改述为它**真正**守的东西（未跟踪文件必须被列出 + 正文可见，断言逐字未动），Task 10 Step 5 与用例代码块均按 R2 加注；读序**保持出货实现**但降级为**冗余保险**（`parseUntracked` 一旦收窄回只认 `?? `，读序就重新承重）。原先的残留项——`git.ts` 的 JSDoc 仍写「调用顺序不可调换」——已由 §15.8 的**注释-only** 改动关闭（出货 blob `c67444a5…` → `39e7ab87…`，A 在新 blob 上重跑仍杀死，B/C/D 按靶点同一性、M11 因 `workspace.ts` 未动而仍直接绑定）。

### 15.5 污染检查（Step 5）

```
$ git status --short
 M packages/server/core/src/workspace.test.ts
?? docs/superpowers/plans/2026-09-22-features-p1-contracts.md      ← 另一会话的未跟踪文件，保持原样、未 add

$ git log --oneline -1 --stat -- packages/server/core/src/git.ts
ea5ca1a fix(core): 修正三样 diff 的段落口径与计数，并隔离机器级 git 配置
 packages/server/core/src/git.ts | 103 +++++++++++++++++++++++++++++++++-------
 1 file changed, 85 insertions(+), 18 deletions(-)

$ Test-Path (Join-Path $HOME '.aieval')
True
```

- `~/.aieval` **存在**（计划预期 `False`）——按 Step 5 的预案改核时间戳：目录 `CreationTime` = 2026/9/24 17:31:23、`LastWriteTime` = 2026/9/24 17:39:36；内容为 `config.json`（219 字节，顶层键 `settings` / `providers` / `cases`）。本次全量测试开始于 2026/9/25 03:15:48，该文件时间戳**早于本次测试约 9.5 小时**，且四次全量/包级跑完之后仍是 `2026/9/24 17:39:36`（未变）——属本机既有的用户配置，**未删除、未修改**。
- 仓库工作树里没有任何 `aieval-*` 临时目录（`git status` 与 `Get-ChildItem -Directory -Filter 'aieval-*'` 均为空）；测试临时目录都建在 `%TEMP%`，本次跑完后 `%TEMP%` 里**新增**的 `aieval-*` 目录已被各套件的 `afterEach` 清干净（跑的过程中能看到、跑完消失）。
- `%TEMP%` 里仍留有**更早任务**的残留（时间戳 2026/9/24 22:49 – 2026/9/25 02:29，均早于本任务）：`aieval-parity`、`aieval-parity2`、`aieval-ws-yyLDaT`、`aieval-hostile-gitconfig`、`aieval-gitconfig-autocrlf`、`aieval-gitconfig-gpgsign`，以及若干 `aieval-*-msg.txt` / `aieval-*.ts` 探针文件。它们在仓库之外、不入库、不影响判据；本任务未清理（可能是早前任务的证据，交 controller 处置）。

### 15.6 本任务的两处改动与提交

- `packages/server/core/src/workspace.test.ts`：追加 `EvalRow 契约与本计划产出的形状对齐（R8 / R9 的落实核验）`（用例正文逐字取自 Step 4）。
- `docs/superpowers/plans/2026-09-22-features-p0-contracts-core.md`：追加本节。
- 提交：`test(core): EvalRow 契约对齐核验 + p0 执行记录`（显式 `git add` 上面两个路径；提交后 `git status --short` 只剩另一会话的未跟踪 p1 计划）。

### 15.7 跟进轮：五条变异验证在 **shipped blob** 上重跑

> **触发原因**：§15.4 的五条转录都产生在**中间版本**上（`git.ts` `26495032…`、`workspace.ts` `03ea5d8b…`），而两次 review 修复轮改的恰好就是这些代码路径。
> 「守卫见过失败」是 p0 阶段最强的结论，必须成立在**出货文本**上。本轮由 controller 裁决后补做。
>
> **协议**（逐条照做）：`git rev-parse HEAD` 确认仍是 `264d800`、工作树干净（只剩另一会话的未跟踪 p1 计划）→ 记 `git hash-object` →
> **一次只打一个实现侧变异体**（测试一个字不动）→ 只跑覆盖它的**单个**测试文件 → 立刻从 `HEAD` 还原（`git checkout -- <path>`）→
> 复核 `git hash-object` 回到变异前、`git diff --stat packages/server/core/src` 为空。
> 「变异 → 测试 → 还原 → 核对哈希」在**同一条命令**里完成，把被变异的工作区暴露窗口压到最短（本仓同时有另一会话在工作）；
> 变异体用**精确字面量替换**施加（先断言目标字面量在该文件里恰好出现一次，否则直接报错退出），不做整文件重写。

| 变异体 | 出货文本上的靶点（`HEAD`） | 变异体 blob | shipped blob 上的实测结果 | 还原后 `git hash-object` |
| --- | --- | --- | --- | --- |
| A（删掉 `-N` 登记） | `git.ts:350` `executeOrFail(dir, ['add', '--intent-to-add', '--all'], '登记未跟踪文件');` | `705b3db4…` | **杀死**：`20 tests | 5 failed`，退出码 1 | `c67444a5…` = 变异前 |
| B（未跟踪清单挪到 `-N` 之后） | `git.ts:348` `const untracked = parseUntracked(executeOrFail(dir, ['status', '--porcelain', '-z'], …));` | `51abb1b1…` | **存活**：`Test Files 1 passed (1)` / `Tests 20 passed (20)`，退出码 0 —— 见下方「B 存活」 | `c67444a5…` = 变异前 |
| C（丢掉「已截断」标记） | `git.ts:536` `truncationNotice` 里的 `return \`${TRUNCATED_MARK}…\`;` | `f2d70481…` | **杀死**：`20 tests | 2 failed`，退出码 1 | `c67444a5…` = 变异前 |
| D（`parseNumstat` 插入列固定 0） | `git.ts:464` `insertions: added === '-' ? 0 : Number(added),` | `36bbc704…` | **杀死**：`20 tests | 5 failed`，退出码 1 | `c67444a5…` = 变异前 |
| M11（不清旧行目录） | `workspace.ts:84-97` 整段 `if (existsSync(dir)) { … }`（含 `rmSync` 与失败包装） | `1d2e7aad…` | **杀死**：`11 tests | 1 failed`，退出码 1 | `f5b7a922…` = 变异前 |

**变异体 A 的失败输出**（在 `c67444a5…` 上实测；`pnpm --filter @aieval/core test -- src/git.diff.test.ts`）：

```
 ❯ src/git.diff.test.ts (20 tests | 5 failed) 50161ms
⎯⎯⎯⎯⎯ Failed Tests 5 ⎯⎯⎯⎯⎯
 FAIL  src/git.diff.test.ts > collectDiff —— 三样合并的四种组合 > 只有未跟踪新文件：**正文**必须出现在 diff 文本里（**专门用例**，R3 的核心）
AssertionError: expected '### 已提交改动（05dc81950e38d3935f6913d4a7d…' to contain '+export const answer = 42;'
 FAIL  src/git.diff.test.ts > collectDiff —— 三样合并的四种组合 > 未跟踪清单是在 `-N` **之前**读的（实测：登记后 `??` 会变成 ` A`，读晚了清单为空）
AssertionError: expected '（工作区 vs HEAD）\n（无）\n' to contain '+export const late = 1;'
 FAIL  src/git.diff.test.ts > collectDiff —— 三样合并的四种组合 > 三者都有：三段各自非空、计数是三者之和
AssertionError: expected '### 已提交改动（1d7811718e6aed07a5607a7dd24…' to contain '+export const untracked = 2;'
 FAIL  src/git.diff.test.ts > collectDiff —— 三样合并的四种组合 > 中文文件名不被打成八进制转义（`core.quotepath=false` 的回归守卫）
AssertionError: expected [] to include '中文文件.txt'
 FAIL  src/git.diff.test.ts > collectDiff —— 三样合并的四种组合 > 未跟踪段的正文只是路径清单，不重复贴未提交的 diff 正文（契约 §3.2 钉死的格式）
AssertionError: expected '（工作区 vs HEAD）\ndiff --git a/a.txt b/a…' to contain '+export const answer = 42;'
 Test Files  1 failed (1)
      Tests  5 failed | 15 passed (20)
```

**变异体 C 的失败输出**（在 `c67444a5…` 上实测；`pnpm --filter @aieval/core test -- src/git.diff.test.ts`）：

```
 ❯ src/git.diff.test.ts (20 tests | 2 failed) 46340ms
⎯⎯⎯⎯⎯ Failed Tests 2 ⎯⎯⎯⎯
 FAIL  src/git.diff.test.ts > truncateDiff > 超预算时按文件裁剪：保留前面的文件、丢掉后面的，并列出被丢文件名（spec §9）
AssertionError: expected '### 已提交改动（base..HEAD）\ndiff --git a/f…' to contain '已截断'
 FAIL  src/git.diff.test.ts > truncateDiff > 预算小于单个文件时也绝不产出「看起来没改动」的空文本（Review Focus 1）
AssertionError: expected '### 已提交改动（base..HEAD）\n' to contain '已截断'
 Test Files  1 failed (1)
      Tests  2 failed | 18 passed (20)
```

与 §15.4 的旧转录是同一条守卫（旧文本上也是 2 failed：`超预算时按文件裁剪` + 「预算小于单个文件」那条）。

**变异体 D 的失败输出**（在 `c67444a5…` 上实测；同一条命令）：

```
 ❯ src/git.diff.test.ts (20 tests | 5 failed) 44706ms
⎯⎯⎯⎯⎯ Failed Tests 5 ⎯⎯⎯⎯
 FAIL  src/git.diff.test.ts > collectDiff —— 三样合并的四种组合 > 只有已提交改动：出现在第一段，第二段为空
AssertionError: expected +0 to be 1 // Object.is equality
 FAIL  src/git.diff.test.ts > collectDiff —— 三样合并的四种组合 > 只有未提交改动：出现在第二段，第一段为空（**专门用例**：只取 commit..HEAD 会给出空 diff 却照样打分）
AssertionError: expected +0 to be 1 // Object.is equality
 FAIL  src/git.diff.test.ts > collectDiff —— 三样合并的四种组合 > 只有未跟踪新文件：**正文**必须出现在 diff 文本里（**专门用例**，R3 的核心）
AssertionError: expected +0 to be 1 // Object.is equality
 FAIL  src/git.diff.test.ts > collectDiff —— 三样合并的四种组合 > 三者都有：三段各自非空、计数是三者之和
AssertionError: expected +0 to be 3 // Object.is equality
 FAIL  src/git.diff.test.ts > collectDiff —— 三样合并的四种组合 > 同一路径既已提交又未提交：只算一行，行数是两段之和（R22）
AssertionError: expected [ { path: 'a.txt', …(2) } ] to deeply equal [ { path: 'a.txt', …(2) } ]
 Test Files  1 failed (1)
      Tests  5 failed | 15 passed (20)
```

比 §15.4 的旧转录（4 failed）**多红一条**：修复轮新增的 R22 用例（`同一路径既已提交又未提交`）也在变异体下变红——出货文本上的区分力比当时更强。

**变异体 M11 的失败输出**（在 `f5b7a922…` 上实测；`pnpm --filter @aieval/core test -- src/workspace.test.ts`）：

```
 ❯ src/workspace.test.ts (11 tests | 1 failed) 14303ms
⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯
 FAIL  src/workspace.test.ts > prepareRowWorkspace > 重跑同一行：清掉旧工作区（上一轮 agent 的改动绝不残留）
ServiceError: 复制工作区失败：…\cases\c-3\cache → …\run-3\rows\row-3\workspace（EIO, Access is denied. '\\?\C:\…'）
    225|     throw new ServiceError(
 Test Files  1 failed (1)
      Tests  1 failed | 10 passed (11)
```

与 §15.4 的旧转录同因（本机 Windows：`cpSync` 覆盖上一轮**只读**的 git 对象先以 `EIO` 失败，因此到不了「残留内容」那条断言；用例仍然变红、变异体仍被杀死；「残留」方向由 M12 补齐）。
**至此 A 与 M11 的转录都绑定在出货 blob 上**（`git.ts` `c67444a5…` / `workspace.ts` `f5b7a922…`，均等于 `HEAD:` 对应 blob），不再是中间版本上的证据。
（`git.ts` 随后经 §15.8 的**注释-only** 改动变为 `39e7ab87…`：A 在新 blob 上重跑仍杀死、B/C/D 按靶点同一性继续成立、M11 的 blob 未变——绑定状态总表见 §15.8。）

#### 发现：变异体 B 存活 —— review 修复轮让「读序」守卫失去区分力

- **现象**：把 `git.ts:348` 的 `const untracked = parseUntracked(…'status','--porcelain','-z'…)` 整行剪切到 `:350` 的 `-N` **之后**（变异体 blob `51abb1b1…`），`src/git.diff.test.ts` **20/20 全绿、退出码 0**。同一协议下 A（5 failed）与 M11（1 failed）都被杀死，说明不是夹具、命令或还原步骤的问题。
- **根因（不是实现缺陷）**：Task 10 的 review 修复轮按 Minor #7 把 `parseUntracked` 从「只认 `?? `」放宽成「`?? ` 与 ` A ` 都认」（`git.ts:439`：`record.startsWith('?? ') || record.startsWith(' A ')`）。这条放宽**本身是对的、也是必需的**——`collectDiff` 自己会跑 `-N`，同一工作区的**第二次**调用看到的就是 ` A`，只认 `?? ` 会让新文件从「未跟踪」漂移成「已改」（这正是那轮修的缺陷）。副作用：登记**前**读得到 `?? x`、登记**后**读到 ` A x`，两者都被接受 ⇒ 得到的**路径清单完全相同**，「必须在 `-N` 之前读」在可观测行为上**不再有区别**。
- **过期的是注释与计划措辞，不是实现**：`git.diff.test.ts:158` 的注释仍写「把 `status --porcelain` 挪到 `-N` 之后，这条会失败」——在出货文本上**不成立**。该用例（`未跟踪清单是在 -N **之前**读的`）现在守的是「未跟踪段必须列出文件名 + 新文件正文出现在未提交段 + `filesChanged` 正确」，仍然有价值，但**不再守顺序**；Task 10 Step 5 的变异体 B 与它的 `Expected: FAIL` 同样不再成立。
- **处置（controller 裁决 R1 / R2，本轮已执行）**：
  1. **R1（只动测试的标题与注释，断言逐字未动）**：`git.diff.test.ts` 里该用例已改名为「未跟踪的新文件必须被**列出**、且**正文**出现在未提交段（读序已不可分辨，见注释）」，注释写成它**真正**守的东西，并写明为什么撤下读序主张（`parseUntracked` 接受 ` A ` 之后两种读序同清单、无断言可分辨）；复核方式：`git diff -U0` 里 `expect(` 行数 = **0**。
  2. **R2（计划只加注、不改写历史）**：Task 10 Step 5 的变异体 B 下方已加注记（保留原描述与 `Expected`），Task 10 的用例代码块旁也加了一行「勿照抄」的注记，两处都指向本节。
- **读序的最终口径（controller 裁决，记录为决定而非缺口）**：读序**保持出货实现不变**——`git status --porcelain` 先于 `git add --intent-to-add`，这是 spec §5.5 第三个来源的字面读法，也让 `parseUntracked` 的主用例仍是 `?? `；但它的地位从「被测试钉住的守卫」改为**冗余保险**：真正保住结果的是「`parseUntracked` 同时接受 `?? ` 与 ` A `」这次放宽本身，而在该放宽存在的前提下**没有任何断言能区分两种读序**。若将来有人把 `parseUntracked` 收窄回只认 `?? `，读序会**重新**变成承重的——Task 10 Step 5 与本节的注记就是给那个人的提示。
- **C / D：已按 R3 补跑**（B 的存活由 `parseUntracked` 的放宽解释，与 `truncateDiff` 的截断标记、numstat 插入列无关，故不受停表规则约束）：C **杀死**（2 failed）、D **杀死**（5 failed），转录见上，还原后哈希均回到 `c67444a5…`。
- **残留项（已由 §15.8 关闭）**：`git.ts:318-320` 的 `collectDiff` JSDoc 当时仍写「**调用顺序不可调换**，① … 必须在 `-N` **之前**读——…此时再按 `??` 过滤得到空清单」。controller 裁决当轮修掉（出货实现的 JSDoc 里留着已被自己实测证伪的规则，比测试注释里的同样问题更严重）；§15.8 记录了注释-only 的机械证明与重绑结果。

#### 本节的两次 follow-up 提交

| 轮次 | 改动 | 提交信息 |
| --- | --- | --- |
| 跟进轮 1（§15.7 主体） | 只有本计划文件（新增本节） | `docs(plans): p0 执行记录补五条变异验证在出货 blob 上的重跑（B 存活为发现）` |
| 跟进轮 2（R1 / R2 / R3） | `packages/server/core/src/git.diff.test.ts`（**仅标题与注释**：R1）+ 本计划文件（Task 10 两处注记 + 本节补 C/D 与读序口径） | `test(core): 未跟踪用例改述真实守卫 + 计划注记（读序降级为冗余保险，C/D 变异补跑）` |
| 跟进轮 3（§15.8） | `packages/server/core/src/git.ts`（**仅注释**：JSDoc 改述读序）+ 本计划文件（新增 §15.8 与各处重绑说明） | `docs(core): collectDiff JSDoc 改述读序（刻意选择 + 冗余保险）+ 执行记录重绑` |

两个被变异的实现文件在每个变异体（A / B / C / D / M11）跑完后都经 `git hash-object` 复核回到出货值（`c67444a5…` / `f5b7a922…`），`git status --porcelain -- packages/server/core/src/git.ts packages/server/core/src/workspace.ts` 每次为空；
`workspace.test.ts` 全程未再改动（仍为 `264d800` 的 `98e0c6b…`）；C / D 在 R1 改写测试标题之后跑的，因此上面两条转录里的用例名与出货测试文件逐字一致。

> **行号口径**：本节（§15.7）里出现的 `git.ts` 行号（348 / 350 / 439 / 464 / 536）都是 **`c67444a5…`（JSDoc 纠正之前）** 的行号；§15.8 的注释-only 改动把 ② 以下的代码整体下移 4 行，新行号见 §15.8。

### 15.8 第三轮（controller 裁决）：`git.ts` 的 JSDoc 改述为陈述事实 + 廉价重绑

> **触发**：§15.7 末条的残留项——`collectDiff` 的 JSDoc 仍断言「**调用顺序不可调换**…必须在 `-N` **之前**读」，而 §15.7 的变异重跑已经证明这条顺序在出货文本上**不承重**。controller 裁决：出货实现的 JSDoc 里留着已被自己实测证伪的规则，比测试注释里的同样问题更严重（p4 与阶段 reviewer 的读者第一眼就看它），当轮修掉，不必等 p1。

**1. 改了什么（只改注释）**

JSDoc 的 ① 改为陈述事实：`git status --porcelain -z` 先读是**刻意选择**——spec §5.5 第 6 步的第三个来源就是 `??` 清单，先读也让 `parseUntracked` 的主用例保持为 `?? `；但**顺序本身不承重**——`parseUntracked` 同时接受 `?? ` 与 ` A `，把该行挪到 `-N` 之后没有任何可观测差异（变异验证实测 `git.diff.test.ts` 20/20 仍绿）；真正保住结果的是那次「接受 ` A `」的放宽本身，**若日后把它收窄回只认 `?? `，读序就重新变成承重的**；并指向本节。②（`-N` 登记）、③（numstat 读序，仍然**必须**在 `-N` 之后）、④⑤ 与「计数一律取 `--numstat` 原始两列」段落**逐字未动**。

**2. 证明是注释-only（机械核对）**

```
$ git diff -U0 -- packages/server/core/src/git.ts
改动行合计 = 10（−3 / +7）
非注释行   = 0        # 除 `^[+-]\s*(\*|/\*\*)` 外没有任何 +/- 行
git.ts 全文 TAB 字符数 = 0        # 正文里的 `1\t0\t…` 仍是字面 backslash-t，没有被写成真 TAB
行数：538 → 542（JSDoc +4 行 ⇒ ② 以下的代码整体下移 4 行）
```

**3. 重新绑定**（controller 指定：一条代表性变异体重跑 + 其余按靶点同一性）

- **A 重跑（新 blob `39e7ab87bbfc622546a52542b120ac08196b8388`）**：变异体 blob `2ee4d4bc…`，**仍然杀死**——`20 tests | 5 failed`、退出码 1：

```
 ❯ src/git.diff.test.ts (20 tests | 5 failed) 39493ms
⎯⎯⎯⎯⎯ Failed Tests 5 ⎯⎯⎯⎯⎯
 FAIL  src/git.diff.test.ts > collectDiff —— 三样合并的四种组合 > 只有未跟踪新文件：**正文**必须出现在 diff 文本里（**专门用例**，R3 的核心）
AssertionError: expected '### 已提交改动（c7e21ceb697179c99122a285e7c…' to contain '+export const answer = 42;'
 FAIL  src/git.diff.test.ts > collectDiff —— 三样合并的四种组合 > 未跟踪的新文件必须被**列出**、且**正文**出现在未提交段（读序已不可分辨，见注释）
AssertionError: expected '（工作区 vs HEAD）\n（无）\n' to contain '+export const late = 1;'
 FAIL  src/git.diff.test.ts > collectDiff —— 三样合并的四种组合 > 三者都有：三段各自非空、计数是三者之和
AssertionError: expected '### 已提交改动（b45ce66dd209343fafcae90fc34…' to contain '+export const untracked = 2;'
 FAIL  src/git.diff.test.ts > collectDiff —— 三样合并的四种组合 > 中文文件名不被打成八进制转义（`core.quotepath=false` 的回归守卫）
AssertionError: expected [] to include '中文文件.txt'
 FAIL  src/git.diff.test.ts > collectDiff —— 三样合并的四种组合 > 未跟踪段的正文只是路径清单，不重复贴未提交的 diff 正文（契约 §3.2 钉死的格式）
AssertionError: expected '（工作区 vs HEAD）\ndiff --git a/a.txt b/a…' to contain '+export const answer = 42;'
 Test Files  1 failed (1)
      Tests  5 failed | 15 passed (20)
```

  失败点与旧转录一致，且第二条显示的正是 **R1 改名后**的用例名——顺带证明改名后的用例仍是有区分力的守卫。
  *还原口径（如实说明）*：跑这条变异体时新 JSDoc **尚未提交**，`git checkout --` 会还原到 HEAD 的旧注释（实测 post 一度为 `c67444a5…`）；于是按备份把新注释写回，写回后 `git hash-object` = `39e7ab87…` = **变异前**，字节级相同——这正是「转录绑定在该 blob 上」的证明。提交之后又跑了一次干净循环（pre = post = `39e7ab87…`），记录在 Task 15 报告 §7.7。
- **B / C / D 按靶点同一性重绑**（注释编辑不可能改变语句）：`Select-String` 在新 blob 上逐条命中**同一字面形式**——
  `git.ts:354` `executeOrFail(dir, ['add', '--intent-to-add', '--all'], '登记未跟踪文件');`（A 的靶点）、
  `git.ts:352` `const untracked = parseUntracked(executeOrFail(dir, ['status', '--porcelain', '-z'], '读取未跟踪清单'));`（B）、
  `git.ts:468` `insertions: added === '-' ? 0 : Number(added),`（D）、
  `git.ts:540` `` return `${TRUNCATED_MARK}\n${droppedFiles.map((file) => `- ${file}`).join('\n')}\n`; ``（C），
  以及 B 的存活结论所依赖的放宽本体 `git.ts:443` `record.startsWith('?? ') || record.startsWith(' A ')`。
  行号相对 `c67444a5…` **整体 +4**（352 / 354 / 443 / 468 / 540 ↔ 旧 348 / 350 / 439 / 464 / 536），字面内容逐字不变 ⇒ 这四条转录（含 B 的存活结论）由**靶点同一性**继续成立。
- **M11 无需重绑**：`workspace.ts` 本轮**一个字节都没动**（`f5b7a922c5f09365df51bdcb8ca8953374a6be19` = `HEAD:` blob），它的转录仍**直接绑定**在出货 blob 上。

**4. 绑定状态总表**

| 变异体 | 转录产生的 blob | 现在的绑定方式 |
| --- | --- | --- |
| A | `39e7ab87…`（**本轮重跑**） | 直接绑定（干净循环 pre = post = `39e7ab87…`；见 Task 15 报告 §7.7） |
| B | `c67444a5…` | 靶点同一性（`:352` 字面未变；存活结论依赖的 `:443` 放宽也未变） |
| C | `c67444a5…` | 靶点同一性（`:540` 字面未变） |
| D | `c67444a5…` | 靶点同一性（`:468` 字面未变） |
| M11 | `f5b7a922…` | 直接绑定（`workspace.ts` 未动，blob 相同） |

**5. 出货 blob 变更**：`packages/server/core/src/git.ts` 由 `c67444a5585180f7c832e27aebb244d9e317c64c` → `39e7ab87bbfc622546a52542b120ac08196b8388`（**只有注释不同**）。
提交：`docs(core): collectDiff JSDoc 改述读序（刻意选择 + 冗余保险）+ 执行记录重绑`（显式路径：`packages/server/core/src/git.ts` + 本计划文件）。**未 amend**（提交前 `HEAD` = `ecbbbc2`，是我自己的上一提交）。至此 §15.7 末条的「残留项」**已关闭**。
