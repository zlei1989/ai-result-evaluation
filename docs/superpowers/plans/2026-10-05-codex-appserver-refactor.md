# codex 适配器改用 app-server：实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans。步骤用 `- [ ]` 跟踪。

**Goal:** 删除 `@openai/codex-sdk` 与 rollout 读盘两条通道，codex 适配器全部改由 `codex app-server`（JSON-RPC/stdio）驱动与取数；能力面与 dsh 逐格对齐或显式登记。

**Architecture:** `appserver/` 提供四层——`binary`（可执行文件解析，已完成）、`client`（JSON-RPC 帧与配对，已完成）、`protocol`（窄声明与读取器，已完成）、`session`（线程生命周期 + 通知流 + 取数）。`index.ts` 只做「协议事件 → 契约草稿」的映射；`sdk.ts`、`transcript.ts` 及其测试删除。

**Tech Stack:** TypeScript 5（strict / noUncheckedIndexedAccess / verbatimModuleSyntax）· Node 24+ · vitest 4 · 零新增依赖。

**Spec:** `docs/superpowers/specs/2026-10-07-codex-dsh-parity.md`（能力对齐判据与差异矩阵）；协议面以 `packages/server/agents/src/providers/codex/appserver/protocol.ts` 的声明与其测试为准。

## 口径（无差别的可执行定义）

1. 同一格里两家都给得出值 ⇒ **逐字段同形同口径**；给不出 ⇒ `null` + `messageCapability` 带 `source`/`reason`。
2. **不得把更强的一家降级**。codex 保留：`cancelMidTurn`、`structuredOutput`、子任务父链/昵称/深度、`parentCallId`、`reasoningOutput`、`total`。
3. 结构性给不了的（见文末）写进 `notes`，不用近似值顶替。

## 文件结构

```
providers/codex/
  appserver/
    binary.ts      完成：解析 SDK 自带的 codex 可执行文件
    client.ts      完成：spawn / initialize / 请求配对 / 通知归类
    protocol.ts    完成：窄声明 + 读取器（readItem/readThread/readNotification…）
    session.ts     新增：一次运行的会话（thread/start、turn/start、通知流、取消）
    reader.ts      新增：运行后取数（thread/list{ancestorThreadId}、thread/read、thread/items/list）
  index.ts         重写：协议事件 → 契约草稿；能力声明与 dsh 对齐
  events.ts        重写：app-server 通知 → 事件草稿
  message.ts       重写：app-server 条目 → 消息草稿
  sdk.ts           删除
  transcript.ts    删除
```

---

### Task 1: 会话驱动 `session.ts`

**Files:** Create `appserver/session.ts`、`appserver/session.test.ts`

**Interfaces:**
- `startCodexSession(input: { binary; env; cwd; model; effort?; sandbox; approvalPolicy; config?; outputSchema? }): Promise<CodexSession>`
- `CodexSession`：`threadId` · `turnId` · `notifications(): readonly AppServerNotificationPayload[]` · `waitForTurn(): Promise<CodexTurnResult>` · `interrupt(): Promise<void>` · `close(): void`
- `CodexTurnResult = { status: 'completed' | 'failed'; error: string | null; usageEvents: Array<{ threadId; usage }> }`

- [ ] 用假 client（注入）写失败测试：握手顺序（initialize → thread/start → turn/start）、`effort`/`outputSchema` 透传、`turn/completed` 结算、`error` 通知进结果、`interrupt` 发 `turn/interrupt`、`close` 后不再发帧。
- [ ] 实现；跑测试至绿。
- [ ] 变异验证：去掉 `initialize` 的 `experimentalApi` ⇒ 必红；把 `turn/interrupt` 写成 `thread/interrupt` ⇒ 必红。
- [ ] 提交。

### Task 2: 运行后取数 `reader.ts`

**Files:** Create `appserver/reader.ts`、`appserver/reader.test.ts`

**Interfaces:**
- `listDescendantThreads(client, mainThreadId): Promise<AppServerThreadRef[]>`（`thread/list{ancestorThreadId}` 一次取全，深度由 `parentThreadId` 链推出；**不再有深度 8/广度 32 上限**）
- `readThreadItems(client, threadId): Promise<AppServerItemEntry[]>`（`thread/read{includeTurns:true}`；`itemsView !== 'full'` 时用 `thread/items/list` 分页补全）
- `AppServerThreadRef = { threadId; parentThreadId; depth; nickname; role; status; usage: AppServerThreadUsage | null }`

- [ ] 用真实报文 fixture（见 `docs/superpowers/notes/…` 的录制来源）写失败测试：`ancestorThreadId` 一次返回主线程与全部后代；`sourceKind !== 'subAgent'` 的会话**不进**结果；`itemsView:'summary'` 时走 `items/list`；分页拼接；`usage` 缺失记 `null`。
- [ ] 实现；跑至绿。
- [ ] 变异验证：`ancestorThreadId` 换成 `parentThreadId` ⇒ 必红；`itemsView` 判断反向 ⇒ 必红。
- [ ] 提交。

### Task 3: 事件与消息映射重写

**Files:** 重写 `events.ts`、`message.ts`；测试同步重写。

映射判据（逐条要有测试）：

| 协议来源 | 契约落点 |
|---|---|
| `item/agentMessage/delta` | `textBlockDraft(text,'delta')`，`streamingDelta` 改 `yes`/`wire` |
| `item/completed(reasoning).content[]` | `thinking{textKind:'full'}`；`content` 为空 ⇒ `text:null` + `'none'`（**不回落到 summary**） |
| `reasoning.summary[]` | `thinking{textKind:'summary'}` |
| `commandExecution` | `toolCallBlockDraft` + 结果块（命令/输出/退出码/耗时） |
| `fileChange` | `toolCallBlockDraft('apply_patch', …)` + `structured={changes,status}` |
| `mcpToolCall` | `name='<server>.<tool>'`、`family:null`、`isError=error!=null` |
| `plan` / `turn/plan/updated` | `family:'task'` + `payload:{kind:'plan',steps,note}` |
| `collabAgentToolCall` / `subAgentActivity` | 子任务行（身份/派发调用配对/终态三档） |
| `turn/completed` | 用量 + 时长（`timing{source:'events'}`，`apiMs`/`ttftMs` 恒 `null`） |
| `thread/tokenUsage/updated` | 按线程用量累计（`input − cached`） |

- [ ] 先按上表逐行写失败测试（含「密文 ⇒ null 不回落」「终态三档」「轮次同一把尺」）。
- [ ] 实现；跑至绿。
- [ ] 变异验证：把密文回落改成 summary ⇒ 必红；把 `subagentTurns` 与 `turns` 改用不同尺 ⇒ 必红。
- [ ] 提交。

### Task 4: `index.ts` 重写与能力声明对齐

- [ ] 删除 `sdk.ts`、`transcript.ts` 与 `sdk.test.ts`、`transcript.test.ts`、`transcript-cache.test.ts`；清掉全部引用（`grep -r "sdk.ts\|transcript"` 为空）。
- [ ] `index.ts` 改为 `startCodexSession` + `reader`；运行期内容由通知驱动，收尾用 `reader` 补齐子线程。
- [ ] `messageCapability` 五格逐格与 dsh 对齐；改掉 `codex/index.ts` 那格已知漂移（note 说「只在结束投递一次」而实际每 500ms 投）。
- [ ] 门禁：`pnpm typecheck`、`pnpm lint`、`pnpm vitest run packages/server/agents`、`pnpm vitest run apps/web-next`。
- [ ] 提交。

### Task 7: 清掉共享层里 `codex exec` 专属的失败归因

`src/turn.ts` 与 `src/turn.test.ts` 仍带 `exec` 时代的逻辑，换 app-server 后成为死代码：

| 位置 | 处理 |
|---|---|
| `turn.ts:852` `SDK_EXIT_PREFIX = /^Codex Exec exited with (?:code \d+\|signal \S+):\s*/` | 删（该前缀只会由 `exec` 子命令产生） |
| `turn.ts:853` `CLI_STDERR_BOILERPLATE = [/^Reading prompt from stdin\.{0,3}$/]` | 删（同上；app-server 不打印该提示） |
| `turn.test.ts:380-501` 六条用例 | 按 app-server 的错误面重写：**保留**通用规则「流内原因优先、退出码作补充」，删掉 `exec` 前缀/样板相关的断言 |
| 通用规则本体（流内 error 覆盖退出错误、退出码作补充） | **保留**——app-server 客户端把 stderr 尾巴附在终止错误里，仍然需要这条取舍 |

判据：`grep -rn "Codex Exec exited\|Reading prompt from stdin" packages/server/agents/src` 为空。

**语义点（已决定，照此实现）**：`turn.ts:870` 的 `exitErrorAddsDetail` 判据③是「退出错误的 stderr 剥掉样板后仍有实质内容 ⇒ 覆盖流内原因」，它依赖 `stripCliBoilerplate`。
**决定：保留通用规则，只删 exec 专属的两条正则**（`SDK_EXIT_PREFIX` 的 `Codex Exec exited with …` 与 `CLI_STDERR_BOILERPLATE` 的 `Reading prompt from stdin…`），`stripCliBoilerplate` 在无样板可剥时**原样返回**（不要改成只在 stream error 缺失时才生效）。
理由：判据①②（确定性错误码 / 4xx）已覆盖真正的「退出更具体」场合，③是**三家共用的兜底**；改成条件生效会静默改变 claude/dsh 的失败归因，超出本任务范围。删掉样板后 app-server 的终止错误（`进程已退出（code=1） stderr: …`）必然满足③而覆盖流内原因——但那只在流内本来就没有更具体归因时发生。
同时更新 `turn.ts:605` 的注释与 `turn.test.ts:380-501` 那组钉旧行为的用例；判据：`grep -rn "Codex Exec exited\|Reading prompt from stdin" packages/server/agents/src` 为空。

### Task 5: 文档与注释收口

- [x] 删除 B2 计划与调研笔记（其有效事实已并入 `specs/2026-10-07-codex-dsh-parity.md`）。
- [ ] 修正 `packages/server/agents/README.md` 的 codex 段落（现描述的是 SDK+读盘）。精确锚点：

| 行 | 现状 | 改成 |
|---|---|---|
| 36 | 「对应 CLI 必须在 `PATH` 上可用（`claude` / `codex`）」 | codex 改为解析**自带可执行文件**，不依赖 PATH |
| 212 | codex 消息能力行：思考正文「会话文件」、`streamingDelta: no` | 思考正文 `wire`；`streamingDelta: yes/wire`；子智能体消息通知驱动 |
| 215-217 | 「消息只在运行结束时从会话文件投递一次……运行期只有派发事件」 | 改为通知驱动 + 收尾用 `reader` 补齐（旧文案与实现自 2026-10-03 起已不一致） |
| 234 | 厂商包 `@openai/codex-sdk` | `@openai/codex`（Task 6） |
| 250 | 停止与释放：`streamAbort.abort()` | `session.interrupt()`（发 `turn/interrupt`）+ `session.close()` |
| 279 | 轮次口径段：称权威计数只在 `rollout-*.jsonl` | 改为：轮次按线程分别数**模型答复条目 id**（同一把尺），取数走 app-server，不再读盘 |

  另需复核（不一定改）：能力表 `codex` 行（`liveUsage`/`structuredOutput`/`cancelMidTurn` **只增不减**）、`4.3` 权限表（`sandbox` 仍由 `ThreadStartParams.sandbox` 承载）。
- [ ] 全量检查新增/改写文件的注释：只留契约与判据，不写过程、不写「我们发现/实测过」。
- [ ] `pnpm lint` + 提交。

### Task 6: 拆掉 `@openai/codex-sdk` 依赖

目标：不把 SDK 当「可执行文件的定位器」留着——那是迁就现状。改为直接依赖 CLI 包 `@openai/codex`（`app-server` 子命令的提供者）。

改动面（`git grep -n "@openai/codex-sdk"` 的完整结果，排除 `probe/` 与 `docs/`）：

| 文件 | 改法 |
|---|---|
| `packages/server/agents/package.json` | `@openai/codex-sdk` → `@openai/codex`（版本区间与当前 CLI 一致） |
| `apps/web-next/package.json` | 同上（区间必须与 agents 逐字相同，由 `runtime-deps.test.ts` 守着） |
| `apps/web-next/next.config.ts` | `serverExternalPackages` 列表 |
| `apps/web-next/src/runtime-deps.test.ts` | `EXTERNAL_SDKS` 列表与说明文字 |
| `packages/server/agents/src/providers/codex/appserver/binary.ts` | 解析链简化：直接 `createRequire(import.meta.url).resolve('@openai/codex/package.json')` → 平台包 → `vendor/<triple>/bin/codex(.exe)`；文件头注释同步 |
| `packages/server/agents/src/vendor-shims.d.ts` | 删掉 `declare module '@openai/codex-sdk'`（改造后无人静态引用） |
| `packages/server/agents/src/static-assertions.test.ts` | 厂商包清单里的名字 |
| `packages/server/agents/src/permission.ts` | 注释里 `SandboxMode` 的出处改为 CLI 包 |
| `packages/server/agents/src/{turn.ts,turn.test.ts,errors.test.ts}` | 注释与用例里的包名（stderr 拼接那条口径改由 app-server 的错误面描述） |
| `packages/server/agents/src/testing/agent-fixtures.ts` | 假 SDK 夹具（`sdk.ts` 删除后一并删） |
| `scripts/apply-agent-message-spec-verification.mjs` | 一次性校验脚本，`git grep` 全仓**无任何引用** ⇒ 一并删 |

**已核（读包元数据即可判定，无需实测）**：`@openai/codex` 的 `package.json` **没有 `exports` 字段**（`type: module`，`bin: codex=bin/codex.js`）⇒ 加为直接依赖后可直接
`createRequire(import.meta.url).resolve('@openai/codex/package.json')` → `createRequire(该路径).resolve('@openai/codex-<平台>/package.json')` → `vendor/<triple>/bin/codex(.exe)`，
**不必再走 `import.meta.resolve` 那条 ESM 链**（少一处 Next/webpack 打包风险，`binary.ts` 也随之变短）。

- [x] 已核：`@openai/codex` 无 `exports` 字段 ⇒ 子路径（`package.json`）对 CJS 解析器开放。
- [ ] `runtime-deps.test.ts` 的断言要按**运行期真实需要**改写：运行期解析的是 **`@openai/codex/package.json`**（`binary.ts` 用定位 vendor 二进制），不是裸说明符；旧包那种「ESM-only ⇒ 两条解析器都试」的写法是为 `@openai/codex-sdk` 的性质写的，换包后应改成子路径 + CJS 解析器（claude / dsh 两家的口径不变）。
- [ ] 改 package.json → `pnpm install` → 改 `binary.ts` 与各处引用 → `pnpm typecheck`、`pnpm lint`、`pnpm vitest run packages/server/agents apps/web-next`。
- [ ] 变异验证：把 `binary.ts` 的三元组判定改错 ⇒ 真机守卫必红。
- [ ] 提交（含 `pnpm-lock.yaml`）。

---

## 当前工作区状态（交接依据）

- **已提交**：`appserver/{binary,client,protocol,session,reader}.ts` 及其 5 个测试文件（56+ tests、变异验证通过）；`session.ts` 的 `settled` 闸门与其守卫。
- **工作区未提交**：`providers/codex/{events,events.test,index,index.test,message,message.test,run-state,appserver-fixtures}.ts`（由执行代理重写，1426+/1702−）。
- **暂存区已 `git rm`**：`sdk.ts` / `sdk.test.ts` / `transcript.ts` / `transcript.test.ts` / `transcript-cache.test.ts` / `message-events.ts`。
  ⚠️ **删除必须与新代码同一次提交**：`HEAD` 里的 `index.ts` 仍是旧装配面，单独提交删除会让该快照无法编译。
- **待修（两处，均已探明机制）**：
- **待查（当前唯一红点，5 条）**：`providers/codex` 全目录 146 条中 **5 条失败**，全在 `index.test.ts > 收尾：子线程内容、终态与用量`。两条错误签名指向两个层面，**先分类再动手**：
  - `Error: thread/list 失败`（`index.test.ts:497` → `appserver-fixtures.ts:134` → `reader.ts:84` → `index.ts:267`）——测试侧 `respond` 未登记取数方法（夹具对未登记方法**响亮失败**，是防假绿设计）。
  - `Error: codex app-server 客户端已关闭`（`appserver-fixtures.ts:116` → `reader.ts:109/:84` → `index.ts:276/:267`）——**收尾取数跑在 `session.close()` 之后**；若属生产时序问题，真实运行同样会发生，必须修顺序（`session.ts` 的 `settled` 闸门可用于「等流停下再读」）。
  红线：**不许为让测试变绿而放宽断言**（如把 `expected [] to deeply equal [子线程答复]` 改成包含式或删用例）。
  **判定的关键**：`index.ts:262-287` 的 `startFinalizeReader` 等 `session.settled` 后才做两次 RPC（`:267` 枚举、`:276` 逐线程读），而注释（`:260`）写明「`finalize` 不等待」⇒ 取数与 `dispose`（`session.close()`）之间存在竞态：取数先完成则有子线程内容，`close` 先到则走 `catch` 记 `threads: null`。
  **本计划采取的方向**：`readback` **必须在 `finalize` 之前落定**（即取数要被等待、`dispose` 排在它之后）——子智能体轨迹是本仓的评测面之一，「有没有」不该由竞态决定。若判为此类，改 `index.ts` 的收尾顺序（不改取数语义与声明面）。
- **已修（主会话，未提交，须与新代码同批）**：`src/registry.test.ts` —— 假体从「按包名注入假 SDK 模块」改为 `codexProvider.runtimeHooks`（`resolveBinary` + `createClient` 指向 `app-server-fixtures.ts` 的 `createFakeAppServer`），取数面三个方法已登记；**终态必须用 `fake.emit` 手动投递**（夹具的 `notifications` 在提交时即投，而订阅在两个请求返回之后才建立 ⇒ 用它会让本轮永不结算，实测 40s 超时）。`pnpm.cmd vitest run …/registry.test.ts` = **14 passed**。
- **待修（唯一编译阻塞点）**：`src/providers/message-conformance.test.ts` —— `:19` 旧 `codexEventToMessage`，约 12 处调用点喂旧 `exec` 条目形状；改喂 app-server 条目/通知（`projectCodexMessages` + `createMessageAssembler`，样板照抄 `providers/codex/message.test.ts`），**只换输入通道、不放宽跨家一致性判据**；新旧形状对应：`agent_message`→`agentMessage` 条目、`reasoning`→`reasoning`（`content[]` 全文 / `summary[]` 摘要，密文不回落的判据不变）、`command_execution`→`commandExecution`、`todo_list`→`plan`、`error`→`error` 通知。
- **已验证**：`appserver/` 五模块 61 tests 全绿（`binary` 4 / `client` 11 / `protocol` 28 / `session` 12 / `reader` 6）。
- **已查明（原「待查」项）**：`providers/codex` 全目录测试「十几分钟没跑完」**不是慢，是挂住**——凡依赖终态通知的用例各挂 `Error: Test timed out in 40000ms`。根因：夹具在 `turn/start` 请求处理**内部同步**推 `options.notifications`（`appserver-fixtures.ts:103-107` 的 `push`），而 `push` 只投给**当时已注册**的 listener（`:82-87`）；适配器在 `await request('turn/start')` **之后**才 `subscribe`（`appserver/session.ts:93` vs `:123`）⇒ 终态通知被丢、本轮永不结算。
  **修法（进行中）**：夹具改为「尚无订阅者时推入的通知**缓冲**，首个订阅者注册时按序补投」——真实世界里终态通知必然在响应之后到达，现夹具比真实更苛刻，缓冲后反而更保真。`registry.test.ts` 里已有一处按「先起 run、让出一次事件循环、再 `emit` 终态」写的对照实现。
- **待主会话收口**：Task 5（README 六处锚点，已改 5 处）、Task 6（依赖拆除 + `pnpm install`）、Task 7（`turn.ts` 清 exec 专属失败归因）。
- **两个现成脚本**（都在 `%TEMP%`，不进仓库）：
  - `codex-acceptance.ps1` —— 只读验收：旧通道 grep、六删确认、目录清单、包级与 web-next 测试、`typecheck`、`lint`。
  - `codex-finalize.ps1` —— **最后一次自洽提交**：先跑「codex 家 + 注册表 + 跨家一致性」三组测试与 `typecheck`，**任一非 0 即中止不提交**；绿了才按 **16 条显式路径**（新代码 7 + 新增 3 + 删除 6）逐个 `git add` 后提交。**不用 `git add -A`**（工作树里还有别的会话的 `README.md` 改动）。

## 未闭合的验证缺口（如实登记，勿当已验证）

`binary.ts` 的第二跳解析基准（`createRequire(codexPackageJson).resolve('<平台包>/package.json')`）**没有能拦住回归的守卫**：

- 变异（把基准改成 `createRequire(import.meta.url)`，退回第一跳的基准）⇒ `binary.test.ts` **仍绿**。
- 机制：**vitest 进程里裸说明符解析被运行器接管**，比生产 Node 宽松；同一写法在真 Node 下解不到平台包（用正斜杠绝对路径 / `file://` URL / 原生反斜杠三种基准在真 Node 里全部 `MODULE_NOT_FOUND`）。
- 现状处置：在 `binary.test.ts` 用例内**登记覆盖边界**，不用假夹具掩盖。真实路径的正确性由**真机守卫**（解析结果必须是 `<平台包>/vendor/<triple>/bin/codex(.exe)` 的路径形状）与主会话在真实安装树上的端到端脚本共同承担。
- 要闭合它只有两条路：在真 Node 子进程里验（多一次进程创建，本仓按「进程创建计价」），或加一条形状式源码断言（引入第二个真相源）。**两条都未做**，这是已知缺口。

## 提交门禁必须三件套：`typecheck` + `lint` + 相关测试

**本次教训**：`66062d7` 只跑了 `typecheck` 与测试就提交，结果 `providers/codex/message.ts` 带进 2 个未使用导入（`TaskStep` / `usageTokens`），lint 退出码 1，后来靠 `4362292` 补修。`typecheck` 与 vitest **都查不出未使用导入**——只有 `lint` 查得出。

⇒ 今后任何收口提交前一律跑齐：
```
& pnpm.cmd typecheck
& pnpm.cmd eslint <改动路径>          # 或 pnpm.cmd lint（全量）
& pnpm.cmd vitest run <相关路径>
```
`%TEMP%\codex-finalize.ps1` 的门禁只有前两者的第一项与第三项，**缺 lint**；该脚本若要复用需先补上。

另两条同样踩过的坑：
- **代理编辑期间不要跑门禁**：实测在代理写 `binary.ts` 的中途跑，`binary.test.ts` 的真机解析用例假红；代理停手后再跑即 4/4 通过。跑门禁前先确认无新起的 node 进程。
- **改含中文的源码不要用 PowerShell 的 `Get-Content -Raw` / `Set-Content`**：会把 UTF-8 改坏（表现为乱码与 `[PARSE_ERROR] Unterminated string`）。变异验证一律用编辑器改。

## 待提交的两批（文件面不重叠，分两次提交）

**A 批 —— 取消路径：被终止的那一轮不等收尾取数**（`asRawStream(…, input.signal)`；判据 `signal.aborted` 与 `cancelMidTask`/`cancelMidTurn` 同源；理由：取消时取数本就拿不到实测，而客户端要到释放阶段才关、`settled` 才落定 ⇒ 等下去会把一次取消拖满 5s 释放宽限期）
```
packages/server/agents/src/providers/codex/index.ts
packages/server/agents/src/providers/codex/index.test.ts
```

**B 批 —— Task 6 依赖拆除**（`@openai/codex-sdk` → `@openai/codex`）
```
packages/server/agents/package.json
packages/server/agents/README.md
packages/server/agents/src/providers/codex/appserver/binary.ts
packages/server/agents/src/providers/codex/appserver/binary.test.ts
packages/server/agents/src/static-assertions.test.ts
packages/server/agents/src/testing/agent-fixtures.ts
packages/server/agents/src/vendor-shims.d.ts
apps/web-next/package.json
apps/web-next/next.config.ts
apps/web-next/src/runtime-deps.test.ts
pnpm-lock.yaml
```

两批都**不含** `AGENTS.md`（本会话外被改，按本仓约定保持原样、不进我的提交）。提交一律逐个显式 `git add <路径>`。

## 文档修正的界线：改「描述当前设计」的，留「记录当时事实」的

- **必须与实现一致（已全部改完）**：`packages/server/agents/README.md`（六处锚点：能力行、消息通道备注、停止与释放、轮次口径、二进制来源、厂商包名）、`docs/superpowers/specs/2026-10-07-codex-dsh-parity.md`、本计划。
- **保持原样（不要改写）**：`docs/superpowers/plans/2026-09-22-features-p0-*.md` 与 `2026-09-22-features-p3-agents.md`（当时的 P3 实施计划，描述 SDK 版设计）、`docs/superpowers/notes/**` 的历史 smoke 记录、`packages/server/agents/probe/**`。
  理由：它们记录的是**当时**的结论与推理链（含 `CODEX_PACKAGE_NAME = '@openai/codex-sdk'`、假 SDK 夹具、rollout 会话文件等）。改写成 app-server 版本，会让「当时为什么这么设计」看起来是用新通道得出的 ⇒ 那是**篡改历史**，不是修正记录。
- 自检命令：`git grep -n 'rollout|会话文件|codex-sdk' -- docs/superpowers/specs docs/superpowers/plans/2026-10-05-* packages/server/agents/README.md` 应无命中（历史文档不在此列）。

## 探针目录（`packages/server/agents/probe/**`）的处置：保留，不改写

`probe/**` 里仍有多处 `import('@openai/codex-sdk')`（`raw-events.mts`、`v2/codex-skills.mjs`、`v2/lib/codex.mjs`、`v4/codex-sdk-deepseek.mjs`、`v4/codex-wire-api-matrix.mjs`、`v4/lib/codex-exec.mjs`）。**它们不是阻塞点，也不该逐处改写**：

- **不在门禁内**：`packages/server/agents/tsconfig.json` 的 `include` 只有 `src`，而根 `tsconfig.typecheck.json` 是「逐包 include 的并集」⇒ `typecheck` 不查 `probe/`；eslint 的包级 glob 只匹配 ts/tsx，且显式忽略 `**/probe/dumps/**` ⇒ `lint` 不查这些 `.mjs`/`.mts`。
- **它们是历史调研记录**（研究对象是被卸载的那个 SDK）⇒ 已跑不起来，但记录的是「旧结论怎么被确立的」（wire_api 行为、skills 机制、argv 形状）。改成 app-server 通道等于**改写历史**，会让当时的结论看起来是用新通道得出的。
- ⇒ 要清理就**整目录归档或删除并说明**，不要逐个改写。那是独立决定，不在本次改造范围内。

## 结构性缺口（写进 `notes`，不用近似值顶替）

| 缺口 | 原因 |
|---|---|
| 消息级用量（`AgentMessage.usage`） | app-server 只到线程级（`ThreadTokenUsage{total,last}`）；对 `total` 差分无法证明归属 ⇒ 记 `null` |
| 审批/问用户 | 协议形态是 server→client 请求，与 dsh 的「模型侧工具」不同构；本仓不应答 ⇒ `unavailable` |
| 每次模型往返的序号 | 厂商给的是 `Turn.id`（标识非序号）⇒ 只能自编号，与 dsh「厂商给号」不同源 |
| `Turn` ≠ 一次往返 | codex 一条 `Turn` 内含多次往返 ⇒ `turns` 为近似，须与 `subagentTurns` 同一把尺 |
| 推理明文 | 取决于上游是否回密文，与传输层无关 |

## 待条件（阻塞中的验证）

`/v1/responses` 实跑鉴权失败（`401 Authentication Fails (governor)`；`~/.dsh/.credentials.yaml` 与 `~/.aieval` 两把凭据均被拒）。因此以下两条**只能由真实一轮**确认，当前按「可能不达」设计：
1. 子线程的 `item/*` 与 `thread/tokenUsage/updated` 是否推给连接（协议无 `thread/subscribe`）；
2. `thread/tokenUsage/updated` 的粒度是否细到每个模型往返。

⇒ 取数必须同时具备「通知驱动」与「`reader` 事后补齐」两条入口；两者都拿不到时记 `null` + 点名 WARN。
