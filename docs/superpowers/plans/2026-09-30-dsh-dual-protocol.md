# DSH 双协议（OpenAI Responses / Anthropic Messages）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 DSH 智能体同时接受 `openai` 与 `anthropic` 两种协议的供应商：候选池里两类模型都能选、创建与评分两处校验都放行、运行时真的按对应 wire 发请求。落地方式是**统一走 `llm-pi-ai`**（`anthropic → anthropic-messages`、`openai → openai-responses`），退役 `llm-deepseek` 这条注入通道（`DEEPSEEK_BASE_URL` / `DEEPSEEK_API_KEY` / `settings.yaml`）。

**Architecture:** 两条正交的改动，可以分别验收：

1. **agents 适配器（方言层）**：适配器把「路由事实」（协议 / 地址 / 密钥 / 模型名 / 窗口 / 上限）翻译成一份 **per-run 的 profile overlay patch**，通过 SDK 客户端的 `patches` 选项（`--patch`，叠在 bundle → profile → home 之上的最高层）交给 dsh；同时用 `provider` 指定该次运行走哪条路由。原 `settings.yaml` 与两个 `DEEPSEEK_*` 环境变量一并退场。
2. **跨端元数据（判据层）**：`AgentProviderMetadata.protocolType`（单值）→ `protocolTypes`（集合），四处判定（api 创建校验 / api 候选池过滤 / 评分智能体校验 / 编排层复检）改读同一个 `acceptsProtocol()`，投影与界面跟着改成数组。

**Tech Stack:** TypeScript 5（strict + noUncheckedIndexedAccess + verbatimModuleSyntax）、zod 3、vitest 4（node / jsdom 双配置）、antd 6 + React 19、SWR 2、Next.js App Router、pnpm workspace；厂商侧 `@deepseek-ai/dsh-sdk-client@0.1.7-rc.1`（内含 `@deepseek-ai/dsh@0.1.7-rc.1` 与 `@deepseek-ai/dsh-llm-pi-ai@0.1.7-rc.1`）。

**Spec:** `docs/superpowers/specs/2026-09-22-features-design.md` §5.1 / §5.6.2 / §11 **R37**（R37 当时逐字登记了残留不确定性：「未验证 dsh 是否也支持 chat-completions —— 若将来发现它同时支持多条 wire，`protocolType` 这个单值字段需要重新设计」）。本计划把那条裁决落地，并在 Task 10 回写 spec。

## 决策（本计划自带；Task 10 并入 spec）

| # | 决策 | 理由 / 代价 |
|---|---|---|
| **D1** | 两条协议**统一走 `llm-pi-ai`**，不再用 `llm-deepseek` | 用户口径 2026-09-30。收益：只有一条注入路径、一个档位真源。代价：`dsh-deepseek-llm-api-extensions` 那套 DeepSeek 专有扩展不再作用于该行，须在 Task 0 核对它是否有本仓依赖的行为 |
| **D2** | `openai` **只**映射 `openai-responses`（不映射 `openai-completions`） | 用户口径 2026-09-30「只需要支持 responses」。因此 **不引入第三种 `ProtocolType`**：`ProtocolTypeSchema` 保持 `['openai','anthropic']`，`contracts-alignment.test.ts:56` 那条断言一个字符都不用改。⚠️ 代价见 D2b |
| **D2b** | **已知边界（必须登记）**：`evaluator/src/text-api.ts` 的 openai 分支仍打 `POST {base}/chat/completions`（`text-api.ts:118-124`） | 若本机唯一的 OpenAI 协议网关只讲 Responses，则**非智能体评分通路**（`callTextApi`）无法用 openai 供应商。本计划**不**改 text-api（它服务的是评分器，不是 DSH 适配器）；Task 10 把它写成 spec 的已知边界 + 一条待裁决项 |
| **D3** | 注入通道 = **per-run overlay patch**（`DeepSeekHarnessOptions.patches: [绝对路径]`），路由键 `aieval-route` | `--patch` 是最高层（bundle → profile → home → CLI），且 dsh 自己不会写它；`settings.yaml` 是**旧版本迁移 shim**（安装态 `dsh-settings/lib/index.js:343-362`：启动即改名 `.imported` 再逐段 `update()`），不把新能力压在它上面 |
| **D3b** | `ask_user_question` 的 `insert` 也搬进同一份 overlay | 原落点 `profiles/sdk/cordis.patch.yml` 是 **dsh 自己的持久化层**（`dsh-settings` 的 legacy import 会经 config-editor 写它），而适配器目前**整份重写**它。搬走后两边各写各的，互不覆盖 |
| **D4** | `AgentProviderMetadata.protocolType: ProtocolType` → **整体替换**为 `protocolTypes: readonly ProtocolType[]` | 加一个并存的 `protocolTypes` 会留下两份真源（四个消费点各写一次「先数组后单值」的分支）。配套 `acceptsProtocol(metadata, protocolType)` 作为唯一判据 |
| **D5** | overlay 里 `models[].reasoningEfforts` 声明 **`off/low/high/max` 四个键**，与注册表 `reasoningEfforts` 逐字一致；**值（wire 拼写）进一张显式映射表** | dsh 侧对不支持的档位是**硬报错**（`UNSUPPORTED_REASONING_EFFORT`）；界面能选而运行时炸，正是本仓最忌讳的「选完到运行时才失败」。⚠️ responses wire 的 OpenAI 枚举**没有 `max`**（只有 `none/minimal/low/medium/high/xhigh`），而 pi-ai **不做枚举校验**（原样透传字符串）⇒ 必须由 Task 0 探明网关接受度，必要时降级拼写。**降级不改变界面四档**：档位域是智能体的能力，不是网关的词汇表 |
| **D6** | 隐式 LLM 消费者**已核实全部继承会话路由** ⇒ 不需要动 `agent-default-model`（它在 sdk profile 里根本没有消费者） | 证据：`tool-subagent/src/index.ts:479` → `model-selection.ts:105` → `child-agent.ts:99-120`，优先读 `parent.session.requestHeader()?.config`（真正派发的路由），否则 `parent.options`（= `sdk/server/src/server.ts:284-289` 的 initialize provider/model）；`agent-default-model` 的读取点只在 headless / web / webhook / tool-cordis 四处，`sdk/server` 的 initialize 与 createSession 都不读它；`session-title-llm` 在 sdk 被 `disabled: true`（`bundle/sdk-app/cordis.patch.yml:9-10`），即便启用也跟随会话路由；`compaction-basic` 的摘要走 `configured ?? latest ?? agentTarget`（`summarizer.ts:128-137`）= 会话路由；goal / ralph / schedule / commands 都没有独立路由 |
| **D6a** | 退役 `DEEPSEEK_*` 时必须**显式删除**这两个键（`injected: { DEEPSEEK_API_KEY: undefined, DEEPSEEK_BASE_URL: undefined }`），不能只是「不再注入」 | `buildSubprocessEnv`（`route.ts:94-106`）以**宿主环境为底**展开，而它的删除语义正是「值为 undefined 就 delete」。不显式删，宿主里若存在 `DEEPSEEK_API_KEY`（开发机很常见）就会被继承，于是：① 那条「无凭据」的 `deepseek-official` 路由**静默可用**（安装态 0.1.7 的 llm-deepseek **账号 token 优先于 API key**，`lib/index.js:1896-1897`）⇒ 悄悄跑到 api.deepseek.com 并计费；② `web_search` 拿宿主的密钥去打 DeepSeek 搜索接口。两条都是「看起来没配、其实在花钱」 |
| **D6b** | **已知损失（登记，不在本计划修）**：改走 pi-ai 后 `dsh-deepseek-llm-api-extensions` 的两个顶层请求字段**静默失效** —— `dsh_session_log`（会话日志上传）与 `dsh_plugin_packages`（插件清单） | 该扩展只在 `llm-deepseek` 适配器里被消费（`llm-deepseek/src/host.ts:36`），注册者是 `session-log-deepseek` / `plugin-package-inventory-deepseek`。它们是 DeepSeek 平台侧字段，第三方网关本来也无意义；但「静默」二字要写进 spec，免得将来有人以为还在上报 |
| **D6c** | `web_search` 的失败**不是本计划引入的回归**，但要在 Task 0 记一笔并给一条裁决项 | base 里 `web: { searchProvider: deepseek-official }` + `web-search-deepseek: { apiKeyEnv: DEEPSEEK_API_KEY }`（`base/cordis.patch.yml:472-481`），且**不复用** `DEEPSEEK_BASE_URL`。今天适配器把**网关密钥**塞进 `DEEPSEEK_API_KEY`，搜索拿它去 DeepSeek 搜索接口本就会失败；退役后只是错误码从「鉴权失败」变成「缺凭据」。`web_fetch` 走匿名 http provider，不受影响。裁决项：要不要在 overlay 里把 `tool-web` 的搜索关掉（先核对它的 Config 开关名），默认**不动** |
| **D6d** | 路由级重试**不需要额外接线**：pi-ai 路由自带的 `retryPolicy` 会被 `adapter.providerRetryPolicy` 交给同一个全局 `llm-retry` 执行，且 pi-ai SDK 侧写死 `maxRetries: 0`（`llm-pi-ai/src/adapter.ts:129-130`）⇒ 不会双重重试 | 不配就是默认 normal / 5 次。写进注释，免得有人以为要另接一层重试 |
| **D7** | 失败语义：patch 里写的 `provider` / `model` / `reasoningEfforts` 与交给 harness 的三个值**同源同算**，并由守卫钉住 | dsh 的 `initialize` 会 `resolveCallConfig({provider, model, reasoningEffort})`，三处任一漂移都会在握手阶段报错；同源计算让「漂移」在编译期/用例里就不可表达 |
| **D8** | baseURL **按 wire 分叉归一化**：`anthropic → stripV1Suffix()`、`openai → ensureV1Suffix()`（两个函数本仓已有，在 `agents/src/route.ts:14-24`） | pi-ai **不做任何归一化**（模型请求收到配置原样的 baseURL，只有 discovery 的列表 URL 归一化）。今天 `keepBaseUrl()` 之所以对，是因为 `llm-deepseek` 自己「没 `/v1` 就补、有就保留」再追加 `/messages`；换成 pi-ai 后这层保护没了。等价性：`stripV1Suffix` + pi-ai 追加 `/v1/messages` ≡ 今天的 `keepBaseUrl` + llm-deepseek 补 `/v1` + 追加 `/messages`（两条分支逐一验算过）；而 responses 侧必须 `ensureV1Suffix`，否则裸 host 会打到 `{root}/responses`。**这是本计划唯一会改变现有 anthropic 行 URL 的地方**，Task 4 要有逐分支的守卫 |
| **D9** | **版本偏斜（必须登记）**：SDK spawn 的那份 dsh 实跑 **`@earendil-works/pi-ai@0.85.1`**，而 DSH 仓库的 `patches/@earendil-works__pi-ai@0.87.1.patch`（删掉 `input_json_delta` 的逐 delta 重解析）**打不到它** | 解析链：`dsh-sdk-client@0.1.7-rc.1 → dsh@0.1.7-rc.1 → dsh-base@0.1.7 → dsh-llm-pi-ai@0.1.7-rc.1 → pi-ai ^0.85.1`（`^0.85.1` 对 0.x 只允许 `<0.86`）。影响：工具参数流式分块时，0.85.1 仍在每个 delta 上 `parseStreamingJson(accumulated)` ⇒ **O(n²)**；DSH 的 `write`/`edit` 工具参数正是大块文本。处置：Task 0 用一次**大参数工具调用**量一下是否可接受；不可接受就给 0.85.1 补一条 `pnpm-workspace.yaml` 的 `patchedDependencies`（与 0.87.1 那条同形）。**不要**只升级版本——那会与 dsh 的 peer 校验打架 |

## Global Constraints

- **工作树里有别的会话的在途改动**：开工前与每次提交前跑 `git status --porcelain`。只碰本计划列出的文件；`git add` **逐个显式给路径，禁止 `git add -A`**（AGENT.md 硬约束）。当前已知的他人改动：`.gitignore`、两份 2026-09-30 spec、`packages/server/agents/cx-tools-probe.mts`、`packages/server/agents/probe/v2/`——**一律不要动**。
- **每个任务开工前先重读目标文件**：本计划的行号是 2026-09-30 的快照；`Interfaces` 段给的是**签名**不是行号，以文件现状为准，签名不一致就停下报告，不要猜。
- **检查顺序**：`pnpm typecheck` → `pnpm lint` → `pnpm test`（三个聚合命令，不要退回 `pnpm -r`）。单包用 `pnpm --filter @aieval/<包名> test -- <关键字>`；内循环用 `pnpm test:changed`。
- **每条新守卫都要做变异验证**：把它要拦的缺陷人为造回去，确认守卫**变红**，再还原并核对文件哈希未变（`git hash-object`）。没有见过失败的守卫不算守卫。
- **`protocolTypes` 这类集合型元数据的守卫要有区分力**：变异体「把 dsh 写成单元素数组」必须红在**候选池/创建校验的正向用例**上，而不是只红在元数据深比对那一条——只红在深比对等于没测到「放宽」这件事。
- **注释与日志**：中文 JSDoc，先说「做什么」再说「为什么」；日志走 `createLogger(scope)`，上下文作为 `console` 第二参数透传，**不 `JSON.stringify`**。
- **写 UI 前用 context7 查 antd 用法**；不手写字号、不手调行内边距（AGENT.md「已知坑」）。
- **`.tsx` 测试只能写在库包**（`packages/client/*`），`apps/web-next` 内不能写（Vite 报 `jsx: preserve`）。
- 纯函数测试文件顶部标 `// @vitest-environment node`。
- **测试不得触碰真实 `~/.dsh`**：探测脚本一律用临时 `DSH_HOME`（`probe/v2/lib/dsh.mjs` 已是这个口径）。
- **未知就是未知**：窗口 / 输出上限 / 档位取不到值时**不写那个键**，不兜底、不猜。

## Review Focus

这七类最容易被打崩的输入/失败面，每条标了它落在哪个任务：

1. **overlay 写晚了**：dsh 在 boot 时读装配清单 ⇒ 文件必须在 `new DeepSeekHarness(...)` **之前**写好。把写入挪到 `start()` 之后，「run 结束后文件在」的用例照样全绿，而生产上路由不存在（Task 6 Step 3）。
2. **patch 里的 model id 与 `options.model` 漂移**：`initialize` 会 `resolveCallConfig`，报 `UNKNOWN_MODEL`。两者必须同源（Task 6 Step 1）。
3. **档位不是 patch 里的键**：报 `UNSUPPORTED_REASONING_EFFORT`。四档必须全声明（Task 5 Step 1）。
4. **退役 `DEEPSEEK_*` 后仍有隐式调用打到 `deepseek-official`**：无凭据 ⇒ 运行失败。先由 Task 0 核对（Task 0 Step 4、Task 6 Step 2）。
5. **YAML 转义**：模型名含 `"` / `\` / `:` 时写出的 patch 必须能原样读回（Task 5 Step 2）。
6. **协议放宽后池子里两类模型无法区分**：可解释性回归（Task 8）。
7. **窗口/上限的落点迁移**：「设了没生效」是新的排障黑洞（Task 5 Step 1、Task 7）。
8. **baseURL 归一化方向（D8）**：anthropic 行今天靠 `llm-deepseek` 自己「补 `/v1` 再追加 `/messages`」，而 pi-ai **不归一化** ⇒ 那层保护没了。方向写反就是 `/v1/v1/messages?beta=true`（其 URL 里还带 `?beta=true`，排障时容易误判成网关问题）。两个方向各要一条用例 + 各要一个变异体（M8b）。
9. **pi-ai 版本偏斜（D9）**：DSH 仓库里那份修 O(n²) 的 patch 打在 0.87.1 上，而 SDK spawn 的 dsh 实跑 **0.85.1** ⇒ 工具参数流式分块时仍在逐 delta 重解析。Task 0 要用一次**大参数工具调用**量它，不可接受就给 0.85.1 补 `patchedDependencies`。

---

### Task 0: 真机探测与事实核对（**先做，无代码产出的结论不进实现**）

**Files:**
- Create: `packages/server/agents/probe/v3/lib/pi-ai-route.mjs`（起真实 `DeepSeekHarness`，跑我们生成的 overlay）
- Create: `packages/server/agents/probe/v3/dsh-pi-ai-anthropic.mjs`、`packages/server/agents/probe/v3/dsh-pi-ai-responses.mjs`
- Create: `docs/superpowers/notes/2026-09-30-dsh-pi-ai-route-probe.md`（探测报告）
- Reference: `packages/server/agents/probe/v2/lib/dsh.mjs`（复用其外壳与「原始通知落盘」口径）

**Interfaces:**
- Consumes: 无
- Produces: 一份**结论表**，逐格给出「双协议接线所需的事实」，供 Task 4/5/6 直接引用；以及一份可复用的探测脚本

- [ ] **Step 1: pi-ai 路由的 wire 事实（**已完成，照抄进探测报告**）**

代码链已取证（`π-ai 0.85.1` 实跑版 → 厂商 SDK 端点常量）：

| 事实 | `anthropic-messages` | `openai-responses` |
|---|---|---|
| 请求 URL | `{baseURL}` **原样** + `/v1/messages?beta=true`（**不归一化**） | `{baseURL}` **原样** + `/responses`（**不插 `/v1`**） |
| baseURL 已带 `/v1` | ⇒ `/v1/v1/messages` ❌ | ⇒ `/v1/responses` ✅ |
| 鉴权 | `x-api-key` + `anthropic-version: 2023-06-01` | `Authorization: Bearer <key>` |
| 档位落到 | `thinking:{type:'enabled',budget_tokens:N}`；`off` ⇒ `thinking:{type:'disabled'}` | `reasoning:{effort:<wire>,summary:'auto'}`；`off` ⇒ `reasoning:{effort:'none'}` |
| `reasoningEfforts: {off: null, …}` | 生成 `thinkingLevelMap` **不含 `off` 键**（值 `null` = 不写入）⇒ 上面那两种「显式关闭」形状 | 同左 |
| 档位取值 | 预算由档位名推（minimal 1024 / low 2048 / medium 8192 / high 16384，`xhigh`/`max` 夹到 high） | 原样字符串透传（**pi-ai 不做枚举校验**；OpenAI SDK 类型面是 `'none'|'minimal'|'low'|'medium'|'high'|'xhigh'|null`，**没有 `max`**） |

⇒ 直接推出 **D8**（归一化方向按 wire 分叉）与 **D5 的档位映射表**，两者都从「待探测」升级为「按代码链确定、只需真机确认网关接受度」。

本步剩下的**只有网关接受度**（必须真机，不能拿类型面代替）：
1. 该网关对 `reasoning.effort: "max"` 接不接受（OpenAI 枚举里没有 `max`）。不接受就按表里给**降级拼写**（如 `max → "high"` 或 `"xhigh"`），并把降级写进 Task 4 的映射表——**界面仍显示四档**，因为注册表的档位域是智能体的能力，不是网关的词汇表。
2. `off` 时发 `effort: "none"` / `thinking:{type:'disabled'}` 会不会被该网关 400。若会，改用「**省略 `off` 键**」的写法（那时 `thinkingLevelMap.off = null` ⇒ **请求体里完全不出现该字段**，见 `catalog.ts:729-756` 的三分支）。
3. `anthropic-messages` 的模型请求路径在真机上是否确为 `{base}/v1/messages?beta=true`（代码链三段推论，仓里**没有**执行级证据）。

- [ ] **Step 2: 用一份最小 overlay 真机跑通（anthropic）**

写一份只含一条路由的 patch（`api: anthropic-messages`），指向**本机可达**的 Messages 网关，用真实 `DeepSeekHarness` 跑一句「回答一个字」。
Expected: `RunResult.finalResponse` 有内容、`turn/end(kind:'completed')`、`assistant/message` 带 usage。

- [ ] **Step 3: 用一份最小 overlay 真机跑通（openai-responses）**

同上，`api: openai-responses` + 一个**可达的** Responses 网关，模型 id 取自该网关 `/models`。
Expected: 同上。
⚠️ 若本机没有可达的 Responses 网关，**如实登记为环境缺口**（照 p3 探测报告的先例），并明确写出「哪一格结论只有类型面背书」——不要拿类型面当实测。

- [ ] **Step 4: 隐式 LLM 消费者（**已完成，结论照抄进探测报告**）**

已核实的结论（证据见 D6 行），本步只需落盘 + 闭合两个未确证项：

| 调用点 | 路由来源 | 退役 `DEEPSEEK_*` 后 |
|---|---|---|
| 主会话 | `initialize({provider,model})` | 不受影响 |
| 子智能体（`subagent` / `subagent_fork` / workflow 默认） | **继承**父会话路由（`requestHeader().config` → `parent.options`） | 不受影响 |
| `agent-default-model` | sdk profile 里**无消费者** | 不受影响 |
| 会话标题 | sdk 里 `disabled: true`；启用时也跟随会话路由 | 不受影响 |
| `compaction-basic` 摘要 | `configured ?? latest ?? agentTarget` = 会话路由 | 不受影响 |
| goal / goal-round-driver / ralph / schedule / commands | 无独立路由（ralph `disabled`、schedule 未挂载） | 不受影响 |
| `tool-result-pruner` / `image-offload` | 不发模型请求 | 不受影响 |
| **`web_search`** | `searchProvider: deepseek-official` + `apiKeyEnv: DEEPSEEK_API_KEY`，**不复用** `DEEPSEEK_BASE_URL` | **一定失败**（今天也失败，只是错误码不同，见 D6c） |
| workflow 脚本里模型自写 `agent(p,{provider:'deepseek-official'})` | 直传，不 preflight | **可能失败** |

两条附带的核实结论（写进报告，省掉评审再问一遍）：
- **退役后 dsh 仍能正常启动**：`llm-deepseek` 的 `apply()` 只做配置解析，凭据在**请求期**才解析（`llm-deepseek-api-key/src/index.ts:17-19,36-46`；安装态同形）⇒ 「无凭据」只影响真正打到那条路由的请求。
- **`web_search` 的账号 token 兜底对我们不生效**：`resolveAccountToken` 只在**当前会话路由是 `deepseek-account`** 时参与（`web-search-deepseek/src/index.ts:108-114`），我们用 pi-ai 路由 ⇒ 拿不到。
- **`subagent` 工具参数里写 provider/model 不会成为风险**：sdk profile 下 `modelSelectionSettings` 默认 false，会**当场抛** `child model selection is disabled for this tool instance`（`tool-subagent/src/index.ts:106-109,608-611`）——失败得很早，不会悄悄打到 `deepseek-official`。

两个未确证项，必须在本步闭合：
1. 本机宿主环境 / 凭据库里**有没有** DeepSeek 账号登录或 `DEEPSEEK_API_KEY`（决定 D6a 那条「静默可用并计费」是否可达）。判据：`Get-ChildItem env: DEEPSEEK*` + `~/.dsh/.credentials.yaml` 的键名清单（**只列键名，不打印值**）。
2. `dsh-tool-web` 的 Config 里有没有关闭搜索的开关（D6c 的裁决项要据此给方案）。

- [ ] **Step 5: 路由键不撞车（**已完成**）**

实跑的 `pi-ai@0.85.1` catalog 共 **39 个键**（`amazon-bedrock, ant-ling, anthropic, azure-openai-responses, baseten, cerebras, cloudflare-ai-gateway, cloudflare-workers-ai, deepseek, fireworks, github-copilot, google, google-vertex, groq, huggingface, kimi-coding, minimax, minimax-cn, mistral, moonshotai, moonshotai-cn, nvidia, openai, openai-codex, opencode, opencode-go, openrouter, qwen-token-plan, qwen-token-plan-cn, qwen-token-plan-individual, together, vercel-ai-gateway, xai, xiaomi, xiaomi-token-plan-ams, xiaomi-token-plan-cn, xiaomi-token-plan-sgp, zai, zai-coding-cn`），`aieval-route` **不在其中** ⇒ 走手声明路径。
（撞车不只是同名：命中 catalog 键时若**不写 `api`** 会 `reuseCatalogProvider` 继承对方的 endpoint/auth/models；我们**总是写 `api`**，所以即便将来撞车也仍走协议表——但清单仍要落盘，便于复核。）

- [ ] **Step 6: 提交**

```bash
git add packages/server/agents/probe/v3 docs/superpowers/notes/2026-09-30-dsh-pi-ai-route-probe.md
git commit -m "probe(dsh): pi-ai 双协议路由的真机事实与隐式消费者核对"
```

---

### Task 1: 元数据集合化（`protocolTypes` + 唯一判据）

**Files:**
- Modify: `packages/server/agents/src/types.ts:146-189`
- Modify: `packages/server/agents/src/registry.ts`（判据函数放这里：`types.ts` 是纯类型面，没有运行值）
- Modify: `packages/server/agents/src/index.ts:7`（公共出口是**手工白名单**，`acceptsProtocol` 必须显式加进去；文件头那句「只导出注册表与类型」的注释同步）
- Test: `packages/server/agents/src/registry.test.ts:22-51,79-85`
- Test: `packages/server/agents/src/contracts-alignment.test.ts`

**Interfaces:**
- Consumes: `ProtocolType`（`contracts`，本次不动）
- Produces: `AgentProviderMetadata.protocolTypes: readonly ProtocolType[]`；`acceptsProtocol(metadata: AgentProviderMetadata, protocolType: ProtocolType): boolean`（从 `@aieval/agents` 导出）

- [ ] **Step 1: 写失败的测试**

在 `registry.test.ts` 里：`EXPECTED_METADATA` 的每一家把 `protocolType` 换成 `protocolTypes`（**本任务三家都是单元素数组**，`dsh` 仍是 `['anthropic']`——放宽是 Task 7 的事，本任务只搬形状）；并把「取值落在 contracts 的协议类型里」那条改成：

```ts
it('每家的 protocolTypes 都是 contracts 枚举的子集、非空、无重复', () => {
  for (const provider of listAgentProviders()) {
    const types = provider.metadata.protocolTypes;
    expect(types.length, `${provider.kind} 的 protocolTypes 为空`).toBeGreaterThan(0);
    expect(new Set(types).size, `${provider.kind} 的 protocolTypes 有重复`).toBe(types.length);
    for (const type of types) expect(ProtocolTypeSchema.options, `${provider.kind} 的 ${type}`).toContain(type);
  }
});
```

再新增一条判据本身的用例（`acceptsProtocol` 是四个消费点共用的唯一判据）：

```ts
it('acceptsProtocol 只认集合里的协议', () => {
  const claude = getProvider('claude-code').metadata;
  expect(acceptsProtocol(claude, 'anthropic')).toBe(true);
  expect(acceptsProtocol(claude, 'openai')).toBe(false);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @aieval/agents test -- registry`
Expected: FAIL —— `metadata.protocolTypes` 是 `undefined`，`length` 读取抛 TypeError（或深比对红）。`acceptsProtocol` 尚未导出 ⇒ 收集阶段就报 `does not provide an export named`。

- [ ] **Step 3: 改类型与实现**

`types.ts` 的 `AgentProviderMetadata` 把那一格换成集合（注释要写「为什么是集合」：DSH 两条 wire 都能收，R37 的收口），并在 `registry.ts` 里加判据函数：

```ts
/** 该智能体能不能驱动这个协议的模型：**四个消费点唯一的判据**（A3 的唯一查询点） */
export function acceptsProtocol(metadata: AgentProviderMetadata, protocolType: ProtocolType): boolean {
  return metadata.protocolTypes.includes(protocolType);
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @aieval/agents test -- registry contracts-alignment`
Expected: PASS

- [ ] **Step 5: 变异验证（本任务两条）**

| # | 变异体 | 期望 |
|---|---|---|
| M1 | `acceptsProtocol` 恒真 | `acceptsProtocol 只认集合里的协议` 变红 |
| M2 | 把 `dsh` 的 `protocolTypes` 改成 `[]` | 「非空」那条变红 |

还原后核对 `git hash-object` 未变。

- [ ] **Step 6: 类型与全量检查**

Run: `pnpm typecheck && pnpm lint`
Expected: 两条都干净。
⚠️ 这一步会**故意**暴露出四个消费点的编译错误（Task 2/3 的活）——按计划顺序，本任务先只改 agents 包，跨包错误在 Task 2/3 修完；若希望每次提交都可编译，把 Task 1–3 合成**一次**提交（推荐，见 Task 3 Step 5）。

- [ ] **Step 7: 提交（与 Task 2/3 合并为一次提交）**

```bash
git add packages/server/agents/src/types.ts packages/server/agents/src/registry.ts \
        packages/server/agents/src/registry.test.ts packages/server/agents/src/contracts-alignment.test.ts
```

---

### Task 2: 四个判定点 + 投影改读同一判据

**Files:**
- Modify: `packages/server/api/src/runs.ts:148-153`（创建/编辑校验）、`:380-402`（候选池）、`:79-89,419-431`（`AgentOptionGroup`）
- Modify: `packages/server/evaluator/src/judge-route.ts:108-118`
- Modify: `packages/server/evaluator/src/orchestrator.ts:1002-1010`
- Test: `packages/server/api/src/runs.test.ts:601-661`、`packages/server/evaluator/src/judge-route.test.ts`

**Interfaces:**
- Consumes: `acceptsProtocol`（Task 1）、`PROTOCOL_LABELS`（已有）
- Produces: `AgentOptionGroup.protocolTypes: readonly ProtocolType[]`；四处拒绝文案共用同一个拼串（见 Step 2）

- [ ] **Step 1: 写失败的测试**

1. `runs.test.ts`：把 `「Codex 只看到 openai、DSH 只看到 anthropic」` 那条改成**按集合**表述，并**新增**一条正向用例（本任务先写、Task 7 才成立的部分用 `todo` 标注，避免假绿）：

```ts
it('候选池按「智能体接受的协议集合」过滤：单协议智能体仍互斥', () => {
  // claude-code / codex 的语义不变（这条是回归网，防「放宽」把单协议也一起放开）
  expect(listModelOptions('codex')).toEqual(openaiPool);
  expect(listModelOptions('claude-code')).toEqual(anthropicPool);
});
```

2. `listAgentModelOptions` 的三条断言（`:620-661`）改成 `protocolTypes`，并保留那条**接缝守卫**（「元数据逐字段等于注册表真值」）——它正是防「api 里抄了第二份真源」的那条，不能删。
3. `judge-route.test.ts`：把「默认评分智能体与评分模型协议不匹配」那组改成集合语义；新增一条「评分模型的协议在智能体集合里 ⇒ 放行」。

- [ ] **Step 2: 实现**

四处判定改为 `acceptsProtocol(metadata, provider.protocolType)`；**拒绝文案抽成一个共用函数**（今天三条文案已经漂了：api 那处写「协议的供应商」、evaluator 两处写「协议的模型」）：

```ts
/** 协议不匹配的统一文案：四个判定点共用，避免「两家说两种话」 */
export function protocolMismatchMessage(input: {
  agentLabel: string; accepted: readonly ProtocolType[]; providerName: string; providerProtocol: ProtocolType;
}): string
```

放哪里由实现者按依赖方向定：文案要同时被 `api` 与 `evaluator` 用，而两者都能 import `agents` ⇒ **放 `agents`**（`PROTOCOL_LABELS` 在 contracts，agents 已依赖它），并从 `agents/src/index.ts` 的白名单导出（与 `acceptsProtocol` 同一次改动）。

- [ ] **Step 3: 跑测试确认通过**

Run: `pnpm --filter @aieval/api test -- runs` 与 `pnpm --filter @aieval/evaluator test -- judge-route`
Expected: PASS

- [ ] **Step 4: 变异验证**

| # | 变异体 | 期望红在哪 |
|---|---|---|
| M3 | 候选池过滤整行删掉（返回全部） | 「单协议智能体仍互斥」 |
| M4 | `judge-route` 的校验改成恒真 | judge-route 的拒绝用例 |
| M5 | 四处里任意一处改回 `metadata.protocolType` | 该处用例（编译期即红，记录为编译期证据） |

- [ ] **Step 5: 提交**

与 Task 3 合并（见 Task 3 Step 5）。

---

### Task 3: 传输形状与界面

**Files:**
- Modify: `packages/client/client/src/runs.ts:111-122`
- Modify: `packages/client/ui/src/composite/judge-settings-card.tsx:36-46,79-89`
- Test: `packages/client/ui/src/composite/judge-settings-card.test.tsx:200-290`
- Modify: `apps/web-next/app/settings/page.tsx:310-321`
- Test: `apps/web-next/src/route-runs.test.ts:400-435`、`apps/web-next/src/settings-page-wiring.test.ts:37-52`

**Interfaces:**
- Consumes: `AgentOptionGroup.protocolTypes`（Task 2）
- Produces: `JudgeSettingsCardProps.agentProtocols?: { agentKind: AgentKind; protocolTypes: readonly ProtocolType[] }[]`

- [ ] **Step 1: 写失败的测试**

1. `judge-settings-card.test.tsx`：`protocols` 夹具改成数组；「协议不匹配的智能体被禁用」那条保留（用单协议智能体做靶子），**新增**一条「双协议智能体的选项**不**被禁用」。
2. `route-runs.test.ts`：响应键集合断言里的 `'protocolType'` → `'protocolTypes'`；`dsh?.protocolType` 那条改成 `protocolTypes`。
3. `settings-page-wiring.test.ts`：投影断言里的 `protocolType:` → `protocolTypes:`（这条守卫的用途是「漏传 ⇒ 过滤静默退化成一个都不过滤」，形状必须跟着变）。

- [ ] **Step 2: 实现**

`incompatible(kind)` 改成集合判定：

```ts
const protocolOf = (kind: AgentKind): readonly ProtocolType[] | undefined =>
  agentProtocols?.find((item) => item.agentKind === kind)?.protocolTypes;
const incompatible = (kind: AgentKind): boolean => {
  const accepted = protocolOf(kind);
  return judgeProtocol !== undefined && accepted !== undefined && !accepted.includes(judgeProtocol);
};
```

- [ ] **Step 3: 跑测试确认通过**

Run: `pnpm --filter @aieval/ui test -- judge-settings-card` 与 `pnpm --filter @aieval/web-next test -- route-runs settings-page-wiring`

- [ ] **Step 4: 变异验证**

| # | 变异体 | 期望红在哪 |
|---|---|---|
| M6 | `incompatible` 改成 `accepted[0] !== judgeProtocol`（把集合当单值用） | 「双协议智能体不被禁用」那条（这条正是新形状的区分力所在） |
| M7 | settings 页投影漏传 `protocolTypes` | `settings-page-wiring.test.ts` |

- [ ] **Step 5: 三包一起提交（保证每次提交都可编译）**

```bash
git add packages/server/agents/src packages/server/api/src/runs.ts packages/server/api/src/runs.test.ts \
        packages/server/evaluator/src/judge-route.ts packages/server/evaluator/src/judge-route.test.ts \
        packages/server/evaluator/src/orchestrator.ts packages/client/client/src/runs.ts \
        packages/client/ui/src/composite/judge-settings-card.tsx packages/client/ui/src/composite/judge-settings-card.test.tsx \
        apps/web-next/app/settings/page.tsx apps/web-next/src/route-runs.test.ts apps/web-next/src/settings-page-wiring.test.ts
git commit -m "feat(agents): 智能体协议元数据由单值改为集合（四处判定共用 acceptsProtocol）"
```

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: 三绿（此时 dsh 仍是单元素 `['anthropic']`，**行为零变化**——这是本阶段可验收的判据）。

---

### Task 4: overlay patch 生成器（纯函数）

**Files:**
- Modify: `packages/server/agents/src/providers/dsh/index.ts`（新增 `buildDshRoutePatch()`；旧的 `writeDshSettings` 本任务先留着，Task 6 退役）
- Test: `packages/server/agents/src/providers/dsh/index.test.ts`（新增 describe）

**Interfaces:**
- Consumes: `AgentRunInput.route`（`protocolType` / `baseUrl` / `modelId` / `contextWindow?` / `maxOutputTokens?`）
- Produces:
  ```ts
  export const DSH_ROUTE_KEY = 'aieval-route';
  export const DSH_ROUTE_PATCH_RELATIVE_PATH = 'aieval-route.patch.yml';
  /** 协议 → pi-ai wire（D2：openai 只走 responses） */
  export function wireForProtocol(protocolType: ProtocolType): 'anthropic-messages' | 'openai-responses';
  /** 生成一份 overlay patch 的 YAML 文本（纯函数，输入即全部事实） */
  export function buildDshRoutePatch(input: DshRoutePatchInput): string;
  ```

- [ ] **Step 1: 写失败的测试**

六条，逐格钉住：

```ts
it('anthropic ⇒ api: anthropic-messages；openai ⇒ api: openai-responses（D2）', ...);
// D8 的核心：pi-ai 不做归一化，所以归一化必须由我们在这一层做，且方向按 wire 分叉
it('baseURL 按 wire 归一化：anthropic 剥掉尾部 /v1、openai 补上 /v1（两个方向都要有带/不带 /v1 的用例）', ...);
it('模型 id / 窗口 / 上限逐字进 patch；未知的格子**不出现那个键**', ...);
it('四个档位全部声明（界面能选的档必须都在 patch 里，否则 UNSUPPORTED_REASONING_EFFORT）', ...);
it('档位值是映射表里的 wire 拼写（off 写成 null；max 的拼写按 Task 0 的结论）', ...);
it('模型名含 " \\ : 时 YAML 读回来逐字相等（照 settings.yaml 那条的往返判据）', ...);
```

第 2 条的四种输入（`route.test.ts:14-32` 已有两个 helper 的单测，这里钉的是**适配器的选择**）：

| 输入 baseURL | anthropic 期望 | openai 期望 |
|---|---|---|
| `https://gw/anthropic` | `https://gw/anthropic`（不变） | `https://gw/anthropic/v1` |
| `https://gw/anthropic/v1` | `https://gw/anthropic`（**剥掉**） | `https://gw/anthropic/v1`（不变） |
| `https://gw/anthropic/v1/` | `https://gw/anthropic` | `https://gw/anthropic/v1` |
| `https://gw` | `https://gw` | `https://gw/v1` |

最后一条（YAML 往返）的判据照抄现有 `settings.yaml` 那条的口径（`index.test.ts:440-462`）：既断言写出的标量是转义后的形态，也断言反转义后与原 id 相等。

⚠️ 第 3 条还要**反向**钉一次：patch 里声明的档位键集合必须**逐字等于**注册表 `metadata.reasoningEfforts`（否则出现「界面能选、patch 里没有」⇒ `UNSUPPORTED_REASONING_EFFORT`）。这条把 D7 的「同源同算」变成可执行断言。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @aieval/agents test -- providers/dsh`
Expected: FAIL（`buildDshRoutePatch` 未导出）

- [ ] **Step 3: 实现**

```yaml
# 由 ai-result-evaluation 写入：本次运行的路由、模型与档位（overlay，叠在 profile 之上）
- id: llm-pi-ai
  config:
    providers:
      aieval-route:
        api: <wireForProtocol(route.protocolType)>
        baseURL: "<baseUrlForWire(route.baseUrl, route.protocolType)>"   # D8：anthropic 剥 /v1、openai 补 /v1
        apiKeyEnv: AIEVAL_ROUTE_API_KEY
        models:
          - id: "<route.modelId>"
            <contextWindow / maxTokens 按需>
            reasoningEfforts:
              off: null
              low: <wire 拼写，Task 0 定>
              high: <…>
              max: <…>
```

- [ ] **Step 4: 跑测试确认通过 + 变异验证**

| # | 变异体 | 期望红在哪 |
|---|---|---|
| M8 | `wireForProtocol` 两个分支都返回 `anthropic-messages` | 第 1 条 |
| M8b | baseURL 两个方向都回落到 `keepBaseUrl`（= 今天的写法，最像正确实现的错误写法） | 第 2 条（**两个方向都要各红一次**：只验一个方向漏掉另一半） |
| M9 | 删掉 `reasoningEfforts` 里的 `max` | 第 4 条（档位键集合逐字相等） |
| M10 | 模型 id 不做 YAML 转义 | 第 6 条 |

---

### Task 5: 适配器接线（`provider` + `patches` + 环境变量）

**Files:**
- Modify: `packages/server/agents/src/providers/dsh/sdk.ts:83-108`（窄结构补两格）
- Modify: `packages/server/agents/src/providers/dsh/index.ts:207-296`（`startDsh`）
- Test: `packages/server/agents/src/providers/dsh/index.test.ts`（改注入那组用例）

**Interfaces:**
- Consumes: `buildDshRoutePatch`（Task 4）
- Produces: `DshHarnessOptions` 新增 `provider?: string`、`patches?: string[]`

- [ ] **Step 1: 写失败的测试**

改 `describe('dshProvider')` 的注入那条（`index.test.ts:60-87`），并新增：

```ts
it('路由与 patch：provider 指向我们声明的路由，patches 给的是**绝对路径**', ...);
it('凭据走 AIEVAL_ROUTE_API_KEY（DEEPSEEK_* 已退役）', ...);
```

判据用夹具的 `recorder.options`（`createFakeDshSdk` 已把构造选项记下来）：
- `recorder.options?.provider === DSH_ROUTE_KEY`
- `recorder.options?.patches` 是长度 1 的数组且 `isAbsolute(p)`（SDK 用 `resolve(callerCwd, path)` 解析相对路径，而 callerCwd 是宿主进程的 cwd ⇒ **必须给绝对路径**，否则文件落到别处）
- `recorder.env?.AIEVAL_ROUTE_API_KEY === 'sk-…'`，且 `recorder.env?.DEEPSEEK_API_KEY === undefined`、`DEEPSEEK_BASE_URL === undefined`

再加一条**宿主环境守卫**（D6a，这条才是真正有区分力的那条）：用例先往宿主环境塞两个假键再跑，断言子进程环境里**没有**它们：

```ts
it('宿主环境里的 DEEPSEEK_* 必须被显式删除，而不是「不再注入」（D6a）', async () => {
  process.env.DEEPSEEK_API_KEY = 'host-leak';
  process.env.DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
  try {
    // …run…
    expect(recorder.env?.DEEPSEEK_API_KEY).toBeUndefined();
    expect(recorder.env?.DEEPSEEK_BASE_URL).toBeUndefined();
  } finally { delete process.env.DEEPSEEK_API_KEY; delete process.env.DEEPSEEK_BASE_URL; }
});
```

⚠️ 只断言「没注入」是**假绿**：`buildSubprocessEnv` 以宿主环境为底（`route.ts:96-98`），不显式 `undefined` 就会继承。变异验证见 Step 4 的 M13。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @aieval/agents test -- providers/dsh`

- [ ] **Step 3: 实现 + 时序守卫**

写入必须在 `new sdk.DeepSeekHarness(...)` 之前（照现有 `writeDshProfilePatch` 的时序注释与守卫）。复用现有 `onConstruct` 快照手法：在构造那一刻读 overlay 文件，断言它在、且含路由键与模型 id。

- [ ] **Step 4: 变异验证**

| # | 变异体 | 期望红在哪 |
|---|---|---|
| M11 | 写入挪到 `await runtime.start()` 之后 | `onConstruct` 快照那一条（**不是**「run 结束后文件在」那条） |
| M12 | `patches` 改成相对路径 | 绝对路径断言 |
| M13 | 仍然注入 `DEEPSEEK_API_KEY`（`injected` 里给值） | 退役断言 |
| M13b | 只是「不再注入」而不写 `undefined`（最像正确实现的错误写法） | **宿主环境守卫那条**（其余用例全绿——这正是它存在的理由） |

---

### Task 6: 退役旧落点（`settings.yaml` / `DEEPSEEK_*` / profile patch 里的 insert）

**Files:**
- Modify: `packages/server/agents/src/providers/dsh/index.ts`（删 `writeDshSettings`；`writeDshProfilePatch` 的 insert 搬进 overlay）
- Test: `packages/server/agents/src/providers/dsh/index.test.ts:378-539`（窗口注入那 3 条 + ask_user 那组的落点判据）
- Modify: `packages/server/agents/probe/v2/lib/dsh.mjs`（可选：同步口径，避免探测脚本与适配器说法漂移）

**Interfaces:**
- Consumes: Task 5 的 overlay
- Produces: 落点只剩一份 overlay 文件（三个旧落点全部退场）
- 边界：`DEEPSEEK_*` 的**环境层退役守卫**在 Task 5（那里才是注入点）；本任务管的是**文件层**的三个旧落点

- [ ] **Step 1: 改测试**

- 「窗口注入」那 3 条：判据从 `settings.yaml` 的内容改成 overlay 的内容（窗口/上限在 `models[0]` 下）；「未知 ⇒ 文件不存在」改成「未知 ⇒ patch 里没有那个键」（overlay 每次运行都重写，语义从「清残留」变成「整份重建」——注释要写清这个语义变化）。
- 「ask_user_question 挂载」那组：落点从 `DSH_PROFILE_PATCH_RELATIVE_PATH` 改成 overlay；**保留 `onConstruct` 时序判据**。
- 新增一条「两个落点互不替代」的**反向**断言：适配器**不再**写 `profiles/sdk/cordis.patch.yml`（防有人把 insert 又搬回去，形成两份真源）。

- [ ] **Step 2: 实现并跑测试**

Run: `pnpm --filter @aieval/agents test -- providers/dsh`
Expected: PASS

- [ ] **Step 3: 变异验证**

| # | 变异体 | 期望红在哪 |
|---|---|---|
| M14 | 仍写 `settings.yaml` | 「不再写旧落点」那条 |
| M15 | insert 从 overlay 里删掉 | ask_user 那组（判据是 overlay 内容） |

---

### Task 7: DSH 声明两条协议 + 正向用例

**Files:**
- Modify: `packages/server/agents/src/providers/dsh/index.ts:297-325`（`protocolTypes: ['openai', 'anthropic']`）
- Modify: `packages/server/agents/src/registry.test.ts`（`EXPECTED_METADATA.dsh`）
- Test: `packages/server/api/src/runs.test.ts`（新增 `dsh + openai 供应商` 正向用例）
- Modify: `packages/server/evaluator/src/testing/fixtures.ts:521-535`（假 provider 元数据）

**Interfaces:**
- Consumes: Task 1 的集合形状
- Produces: DSH 的候选池 = 两类协议的并集

- [ ] **Step 1: 写失败的正向用例（先红）**

```ts
it('DSH 同时接受两种协议：openai 供应商的模型也进候选池（本次放宽的靶子）', () => {
  seedConfig({ providers: [openaiProvider, anthropicProvider] });
  expect(listModelOptions('dsh').map((o) => o.modelId)).toEqual(['gpt-5', 'claude-opus-4-6']);
});
it('DSH + openai 供应商：创建评测通过协议校验（不再 CONFLICT）', ...);
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @aieval/api test -- runs`
Expected: FAIL —— 候选池只有 anthropic 那一条 / 创建报 CONFLICT（**这就是放宽前的行为，必须亲眼看到**）

- [ ] **Step 3: 改元数据 + 夹具**

`dsh` 的 `protocolTypes: ['openai', 'anthropic']`；`registry.test.ts` 的期望值同步；`evaluator/src/testing/fixtures.ts` 的假 provider 同步（注释里那条「夹具写错 ⇒ 用例假绿」的教训照旧适用）。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @aieval/api test -- runs` 与 `pnpm --filter @aieval/agents test -- registry`、`pnpm --filter @aieval/evaluator test`

- [ ] **Step 5: 变异验证**

| # | 变异体 | 期望红在哪 |
|---|---|---|
| M16 | `dsh` 的 `protocolTypes` 改回 `['anthropic']` | **正向用例**那两条（而不是只红在元数据深比对） |

- [ ] **Step 6: 顺带简化夹具（可选，但建议）**

`evaluator` 里为「dsh 行必须配 anthropic 供应商」而刻意造的夹具（`orchestrator-timeout-isolation.test.ts:31,70`、`testing/fixtures.ts:90-101` 的注释）现在可以回归默认夹具；注释里指向 R37 的那几句要改成指向本计划。

---

### Task 8: 可解释性（池子里两类协议要分得开）

**Files:**
- Modify: `packages/client/ui/src/composite/run-create-panel.tsx`（模型下拉的选项标签）
- Test: 同目录 `run-create-panel.test.tsx`

**Interfaces:**
- Consumes: `AgentModelOption`（含 `providerName`；本任务**不**新增字段，用已有的 `providerName` 表达协议归属）
- Produces: 选项标签带上协议后缀

- [ ] **Step 1–4: 测试 → 实现 → 验证**

`run-create-panel` 的模型选项标签今天只有 `modelId`；放宽后同一个模型名可能出现在两个网关里。建议标签形如 `<modelId>（<providerName> · OpenAI 兼容）`。
⚠️ 先确认 `AgentModelOption` 里有没有 `protocolType`（`runs.ts:96-109` 的形状里**没有**）：若要显示协议，最省事的做法是**不改契约**、只用 `providerName`；要显示协议标签则需给 `AgentModelOption` 加一格——**那是契约变更**，需在 Step 1 先写一条路由测试钉住键集合，再决定取舍（默认方案：只加 `providerName`，不动契约）。

---

### Task 9: 真机端到端（走适配器，不是走裸 SDK）

**Files:**
- Create: `packages/server/agents/probe/v3/dsh-adapter-dual-protocol.mts`（复用 `setAgentRuntimeForTesting` 之外的真实路径：直接 `dshProvider.run(...)`）
- Modify: `docs/superpowers/notes/2026-09-30-dsh-pi-ai-route-probe.md`（追加「适配器路径」一节）

- [ ] **Step 1: anthropic 行跑通**

用真实供应商记录（anthropic 协议）跑一次 `dshProvider.run()`，断言 `ok: true` + `tokens` 非 null + `turns` ≥ 1。

- [ ] **Step 2: openai 行跑通**

同上（openai 协议 → responses wire）。**这是本计划唯一能证明「两种协议真的都能跑」的一步**；若环境缺口无法闭合，如实登记并说明哪一格只有夹具背书。

- [ ] **Step 3: 落盘证据**

按 AGENT.md 的冒烟四要素写进探测报告：范围清单 / 操作路径 / 证据（浏览器或 CLI 输出互证）/ 未覆盖项。

---

### Task 10: 文档收口

**Files:**
- Modify: `docs/superpowers/specs/2026-09-22-features-design.md`（§3 F2 表、§5.1 第 127-131 行、§5.6.2 的元数据表与实现、§11 **R37** 收口）
- Modify: `docs/superpowers/specs/2026-09-22-features-design.md` §5.5.1（评分智能体的协议集合判据）与 §5.1.1（`route.protocolType` 是单值、能力是集合）
- Modify: `AGENT.md`（依赖方向表里「候选池按智能体读注册表元数据（协议类型）」→「协议集合」；§目录与边界里 dsh 那一行的描述）
- Modify: `docs/superpowers/notes/2026-09-30-dsh-pi-ai-route-probe.md`（最终事实表）

- [ ] **Step 1: R37 收口**

R37 那一行要补：**实测证实** dsh 侧存在第二条 wire（pi-ai 路由），单值 `protocolType` 已按当时的预案改成集合；落地清单逐条指向本计划的 Task 1–7。

- [ ] **Step 2: D2b 的已知边界写进 spec**

「openai 协议的非智能体评分通路仍走 chat-completions」作为**待裁决项**登记（不要在实现里悄悄改 text-api）。

- [ ] **Step 3: 全量门禁**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: 三绿；记录用例总数（照 AGENT.md：改动收集方式后必须核对总数与逐包一致——本计划不动收集方式，但总数应只增不减）。

---

## 附：本计划**不做**的事（防止范围蔓延）

1. **不改 `text-api.ts`**：openai 侧的 chat-completions 通路保持原样（D2b 已登记为待裁决项）。
2. **不引入第三种 `ProtocolType`**（不改 `ProtocolTypeSchema`）：D2 明确只要 responses，加枚举值会牵动 `text-api`、供应商表单、拉模型三处。
3. **不改供应商的设置页形态**：`ProviderView.protocolType` 仍是单值——协议是**供应商的属性**，集合是**智能体的能力**，两者不要混。
4. **不动别人的在途改动**：`.gitignore`、两份 2026-09-30 spec、`cx-tools-probe.mts`、`probe/v2/`。
