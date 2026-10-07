# Codex 子智能体取数改造（B2：运行仍走 SDK，取数改走 app-server）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 codex 家的**子智能体线程发现与取数**从「扫 `$CODEX_HOME/sessions` + 递归读派发者文件」改成「读官方 `codex app-server` 协议」，文件读取降级为兜底。

**Architecture:** 新增 `providers/codex/appserver/`（二进制解析 / JSON-RPC 客户端 / 线程与条目投影），对外只暴露一个 `CodexThreadSource` 接缝（`discover` + `readThread`）；现有 rollout 文件读取包装成同一接缝的第二个实现。`index.ts` 按「app-server 优先、文件兜底」注入。**运行通道不变**（仍 `@openai/codex-sdk` 的 `exec --experimental-json`）。

**Tech Stack:** TypeScript 5（strict + noUncheckedIndexedAccess + verbatimModuleSyntax）· Node 24/26（`child_process.spawn`、`import.meta.resolve`）· vitest 4（node 环境）· 零新增 npm 依赖。

**Spec:** `docs/superpowers/notes/2026-10-05-codex-subagent-messages-alternatives.md`（§1.2 协议面、§1.7 覆盖矩阵与本计划依据的实测结论）

## Global Constraints

- **不新增运行时依赖**：codex 可执行文件走 SDK 自带的解析链（`import.meta.resolve('@openai/codex-sdk')` → `createRequire(该 URL).resolve('@openai/codex/package.json')` → `createRequire(该路径).resolve('@openai/codex-win32-x64/package.json')` → `dirname()` + `vendor/<triple>/bin/codex.exe`）。**不要**依赖 `packages/server/agents/probe/v4/lib/env.mjs` 里那份过期路径。
- **`src/**` 内禁止目录扫描 API**（`static-assertions.test.ts` 的 A3 不变量，连注释里写该 API 名都会判违规）：新模块**只走协议**，不得 `readdir`/`opendir`。
- **不 import 厂商类型**：窄结构自声明（`sdk.ts` / `transcript.ts` 既有口径）；app-server 的报文形状在本包内自己声明。
- **接口与实现分文件**，JSDoc 中文注释，先说做什么再说怎么做；同文件内注释密度一致。
- **守卫必须做变异验证**：每条新守卫都要把它要拦的缺陷人为造回去、确认其**失败**，再还原并核对文件哈希未变。
- 门禁顺序：`pnpm typecheck` → `pnpm lint` → `pnpm vitest run packages/server/agents`。
- 提交时逐个显式 `git add <路径>`，**禁止 `git add -A`**；`git status` 里不属于本计划的改动保持原样。
- **口径变更必须显式登记**：本改造会让「shell 起的 `codex exec` 会话」（`session_meta.source === 'exec'`、无父线程）**不再自动计入子智能体**（app-server 的 spawn-edge 树里没有它们）。兜底路径负责继续发现它们，行为差异必须写进测试与文档（见 Task 4 Step 5）。

---

### Task 1: codex 可执行文件解析

**Files:**
- Create: `packages/server/agents/src/providers/codex/appserver/binary.ts`
- Test: `packages/server/agents/src/providers/codex/appserver/binary.test.ts`

**Interfaces:**
- Produces: `resolveCodexBinary(): string`（绝对路径；找不到时抛 `AgentLoadError`，包名沿用 `@openai/codex-sdk`）
- Produces: `platformTargetTriple(platform?: string, arch?: string): string | null`（纯函数，可单测）
- Produces: `vendorBinaryPath(vendorRoot: string, triple: string, platform?: string): string`

- [ ] **Step 1: 写失败测试**（`binary.test.ts`，`// @vitest-environment node`）

```ts
import { describe, expect, it } from 'vitest';
import { platformTargetTriple, vendorBinaryPath, resolveCodexBinary } from './binary';

describe('platformTargetTriple', () => {
  it('按 process.platform/arch 给出 SDK 认的三元组', () => {
    expect(platformTargetTriple('win32', 'x64')).toBe('x86_64-pc-windows-msvc');
    expect(platformTargetTriple('linux', 'arm64')).toBe('aarch64-unknown-linux-musl');
    expect(platformTargetTriple('darwin', 'x64')).toBe('x86_64-apple-darwin');
  });
  it('不认识的组合返回 null（而不是猜一个）', () => {
    expect(platformTargetTriple('sunos', 'sparc')).toBeNull();
  });
});

describe('vendorBinaryPath', () => {
  it('win32 用 codex.exe，其余用 codex', () => {
    expect(vendorBinaryPath('/v', 'x86_64-pc-windows-msvc', 'win32')).toBe('/v/x86_64-pc-windows-msvc/bin/codex.exe');
    expect(vendorBinaryPath('/v', 'x86_64-apple-darwin', 'darwin')).toBe('/v/x86_64-apple-darwin/bin/codex');
  });
});

describe('resolveCodexBinary', () => {
  it('本机解析到真实存在的文件（真机守卫：解析链断了这条就红）', () => {
    const bin = resolveCodexBinary();
    expect(bin.length).toBeGreaterThan(0);
    expect(existsSync(bin)).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/server/agents/src/providers/codex/appserver/binary.test.ts`
Expected: FAIL（`Failed to resolve import "./binary"`）

- [ ] **Step 3: 实现**

要点：`createRequire(sdkUrl).resolve('@openai/codex/package.json')` → `createRequire(该路径).resolve('<平台包>/package.json')` → `dirname()` 得 `vendorRoot` → 拼 `vendor/<triple>/bin/codex(.exe)`；用 `existsSync` 判存在；失败抛 `AgentLoadError('@openai/codex-sdk', new Error('…找不到 codex 可执行文件…'))`（沿用本包既有错误类型，文案点名解析链的每一步）。

- [ ] **Step 4: 跑测试确认通过** → `pnpm vitest run …/appserver/binary.test.ts`（PASS）

- [ ] **Step 5: 变异验证**：把 `vendorBinaryPath` 的 `win32 ? '.exe' : ''` 改成恒 `''` ⇒ `resolveCodexBinary` 的真机守卫必须红；还原并核对哈希。

- [ ] **Step 6: 提交** `git add packages/server/agents/src/providers/codex/appserver/binary.ts packages/server/agents/src/providers/codex/appserver/binary.test.ts`（message：`feat(codex): 解析 SDK 自带的 codex 可执行文件`）

---

### Task 2: app-server JSON-RPC 客户端

**Files:**
- Create: `packages/server/agents/src/providers/codex/appserver/client.ts`
- Test: `packages/server/agents/src/providers/codex/appserver/client.test.ts`

**Interfaces:**
- Produces: `createAppServerClient(options: { binary: string; env: NodeJS.ProcessEnv; spawnFn?: SpawnFn }): AppServerClient`
- Produces: `AppServerClient`：`initialize(): Promise<void>` · `request<T>(method: string, params: unknown): Promise<T>` · `notifications(): readonly AppServerNotification[]` · `close(): void`
- 通知形状：`{ method: string; params: unknown }`（**自己声明**，不引厂商类型）

- [ ] **Step 1: 写失败测试**（注入假 `spawnFn`：返回带 `stdin/stdout/stderr` 的假子进程，脚本化应答）

测试用例（逐条独立）：
1. `initialize` 发 `clientInfo` + `capabilities.experimentalApi === true`（**这一格必须有守卫**：缺了它 `parentThreadId` 会被拒）
2. `request` 按 `id` 配对响应，忽略乱序到达的其它 id
3. 无 `id` 的报文进 `notifications()`，且**不影响**任何待收响应
4. 服务端发来的**请求**（带 `id` 且不在待收表里）单独归类，且客户端**不应答**（本计划不实现审批）
5. 子进程退出 ⇒ 所有待收请求以明确错误 reject（不得悬挂）
6. `close()` 后 `request` 立即 reject（不写 stdin）

- [ ] **Step 2: 跑测试确认失败** → `pnpm vitest run …/appserver/client.test.ts`（FAIL）

- [ ] **Step 3: 实现**（行分隔 JSON 帧；`\n` 分帧；`stdin.write(JSON.stringify(msg) + '\n')`；stderr 收进环形缓冲供报错时附上；进程退出清理待收表）

- [ ] **Step 4: 跑测试确认通过**

- [ ] **Step 5: 变异验证**：把 `experimentalApi` 改成 `false` ⇒ 用例 1 必红；还原并核对哈希。

- [ ] **Step 6: 提交**

---

### Task 3: 线程树与条目 → `CodexTranscript`

**Files:**
- Create: `packages/server/agents/src/providers/codex/appserver/threads.ts`
- Create: `packages/server/agents/src/providers/codex/appserver/fixtures.ts`（从真机探针录制的**真实**报文，见下方"录制来源"）
- Test: `packages/server/agents/src/providers/codex/appserver/threads.test.ts`

**录制来源（本机已实测，2026-10-05）**：`D:\.tmp\aieval\runs\8e13e7a3-…\rows\77a9dcf7-…\.agenthome` 那一行——主线程 `01a107a6-fe9a-7232-a0b7-25868a524ea7`，深度 1 子线程 `01a107a7-250e-7911-bcc3-028fe07f66bb`（`agentNickname: "Harvey"`、`source: subAgent`），另有**两个不属于 spawn 树**的 `source: exec` 会话。

**Interfaces:**
- Consumes: `AppServerClient`（Task 2）
- Produces: `listManagedThreads(client, mainThreadId): CodexThreadRef[]`（`thread/list { ancestorThreadId }`，递归展开 `parentThreadId` 得 depth）
- Produces: `readThreadAsTranscript(client, threadId): CodexTranscript | null`（`thread/read {includeTurns:true}` + `thread/items/list` 分页合并；遇 `itemsView === 'notLoaded'` 时退回 `items/list`）
- Produces: `AppServerThreadRef = { threadId: string; parentThreadId: string | null; depth: number; nickname: string | null; role: string | null }`
- 产出物**必须满足既有 `CodexTranscript` 形状**（`transcript.ts` 已导出），以便零改动复用 `projectTranscriptDrafts` / `projectChildThreadUsage`

映射要点（每条都要有对应断言）：
| app-server item | → `CodexTranscript` 记录 |
|---|---|
| `reasoning{content: string[]}` | `payload.type='reasoning'`、`content:[{type:'reasoning_text',text}]`（**明文直取**；已实测与 rollout 逐字相同） |
| `agentMessage{text}` | `payload.type='message'`、`role:'assistant'` |
| `commandExecution` | `payload.type='function_call'` + 紧随的 `function_call_output`（`name` 取 `functionCallOutput.name`，缺则回落 `exec_command`） |
| `collabAgentToolCall` | `payload.type='collab_tool_call'`（`sender_thread_id`/`receiver_thread_ids`/`agents_states`） |
| `subAgentActivity` | 同上族（`kind`/`agent_thread_id`/`agent_path`） |
| `ThreadTokenUsage.last` | `payload.type='token_count'`（`info.last_token_usage` + `model_context_window`） |
| 每项的 `turnId` | 该记录的 `turn_id`（**这是轮次判据的输入**，不得丢） |

- [ ] **Step 1: 写失败测试**（用 fixtures 喂假 client）
  必含：① `listManagedThreads` 只回 spawn 树内线程、`depth` 正确、昵称带出；② 两个 `exec` 会话**不在**结果里（明确断言，钉住口径）；③ `readThreadAsTranscript` 的 `reasoning` 内容与非空长度断言；④ 每记录的 `turn_id` 非空；⑤ `items/list` 分页（`nextCursor` 两页拼接）；⑥ `thread/read` 返回 `itemsView:'summary'` 时**退回** `items/list`（不得把摘要当全量）。
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现**
- [ ] **Step 4: 跑测试确认通过**
- [ ] **Step 5: 变异验证**：把 `ancestorThreadId` 换成 `parentThreadId`（丢掉孙级）⇒ ① 必红；把 `reasoning.content` 改成读 `summary` ⇒ ③ 必红。
- [ ] **Step 6: 提交**

---

### Task 4: 接缝 `CodexThreadSource` 与「app-server 优先、文件兜底」

**Files:**
- Modify: `packages/server/agents/src/providers/codex/transcript.ts`（抽出接缝，把现有文件实现包装成 `createRolloutThreadSource`）
- Modify: `packages/server/agents/src/providers/codex/index.ts:280-361`（注入 primary/fallback）
- Test: `packages/server/agents/src/providers/codex/transcript.test.ts`、`.../index.test.ts`（补分支）

**Interfaces:**
- Produces: `interface CodexThreadSource { discover(input: { mainThreadId: string; seedChildIds: readonly string[] }): { threads: AppServerThreadRef[]; notes: readonly string[] }; readThread(threadId: string): CodexTranscript | null }`
- 现有 `projectTranscriptDrafts` / `projectChildThreadUsage` 的入参由 `{ codexHome, mainThreadId, childThreadIds, read }` 改为 `{ source: CodexThreadSource; mainThreadId: string; childThreadIds: readonly string[] }`
- `chooseThreadSource(...)`：先试 app-server；**发现数为 0 或抛错**时回落文件源，并记一条 `notes`（日志要能区分"协议没给"与"确实没有子智能体"）

- [ ] **Step 1-4: TDD 写改动**（现有 137 条 transcript 用例全部保持绿：它们是文件源的行为契约，**不得改写断言来迁就新接缝**）
- [ ] **Step 5: 一致性用例（本计划的核心守卫）**：同一份真机 fixture 下，**app-server 源与文件源给出的 `reasoning` 文本序列逐字相同**、线程树（id/parent/depth）相同 ⇒ 两条路互为对照；任何一条漂移都要红。
- [ ] **Step 6: 口径差异显式登记**：新增用例断言「文件源会把 `source: exec` 会话算作子智能体、app-server 源不会」，并在 `index.ts` 的注释与 §1.7 笔记里写明：**兜底路径是这些会话的唯一来源**，删掉文件源会让它们从计量里消失（R7 修复会被回退）。
- [ ] **Step 7: 门禁** `pnpm typecheck` → `pnpm lint` → `pnpm vitest run packages/server/agents`
- [ ] **Step 8: 提交**

---

### Task 5: 守卫与文档收口

**Files:**
- Modify: `packages/server/agents/src/static-assertions.test.ts`（新增：`appserver/` 内**不得**出现目录扫描 API；不得静态 `import` 厂商包——沿用既有 A 系列口径）
- Modify: `packages/server/agents/README.md`、`docs/superpowers/notes/2026-10-05-codex-subagent-messages-alternatives.md`（把"未验证项"更新为已验证/已实现，并登记 `skipGitRepoCheck` 不需要）
- Test: 上述文件

- [ ] **Step 1: 写失败守卫**（先造一个变体：在 `appserver/threads.ts` 顶部加一行静态 `import '@openai/codex-sdk'` ⇒ 断言必须红）
- [ ] **Step 2: 确认红 → 还原 → 确认绿**
- [ ] **Step 3: 更新文档**（含 §4.1 未验证清单的结项：`skipGitRepoCheck` 已实测不需要；`thread/read` 对子线程返回全量已实测；用量粒度与实时推送仍未验证）
- [ ] **Step 4: 全量门禁 + 提交**

---

## 本计划明确**不做**的事（留给后续计划）

1. **B1**：把运行通道也换成 app-server（`thread/start` + `turn/start`）。
2. 流式增量（`AgentMessageDelta` / `ReasoningTextDelta`）接入消息流。
3. 审批与用户输入（`*RequestApproval`、`agentMessage.questions`）——当前非交互，仍留 `unavailable`。
4. `thread/tokenUsage/updated` 的**运行期**实时用量（本计划只用它做收尾；运行期仍走文件源，因为"每个模型往返一次"的粒度尚未实测）。
5. 删除 rollout 文件源——**本计划刻意不删**。
