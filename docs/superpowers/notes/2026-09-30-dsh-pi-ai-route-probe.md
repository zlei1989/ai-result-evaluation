# DSH pi-ai 双协议路由探测报告（2026-09-30）

上位文档：`docs/superpowers/plans/2026-09-30-dsh-dual-protocol.md`（Task 0）
脚本：`packages/server/agents/probe/v3/`（`dumps/` 已 gitignore，本报告只引用其结论）

**结论一句话**：DSH 侧的 pi-ai 路由**两条 wire 都真机跑通**（含计量），overlay 注入机制成立，
四档档位在两条 wire 上都有确定的落点与真机接受度。**「统一到 llm-pi-ai」没有阻塞项**，
三个需要处置的事实是 D9（版本偏斜，性能面）、D6c（`web_search` 必然失败，非本计划引入）
与**冷启动握手预算**（§9.1：SDK 默认 10s 不够，Task 9 走真适配器时双双失败，已修）。

## 0. 环境前提（与 p3 时期不同，如实登记）

| 项 | 事实 |
|---|---|
| 内部网关 `likecode-llm-proxy.jd.com` | 09:55 可达（v2 探测 200）→ 22:20 一度不可达（内网/VPN 断，TCP 443 超时）→ **22:40 恢复**（`GET /v1/models` 200，47 条模型） |
| 内部网关**推理** | ⚠️ `POST /v1/{responses,chat/completions,messages}` 用 `proxygateway/config.json` 里的 `apiKeys.likecode` 全部 **401「登录态丢失，请重启再试」** ⇒ 该 key 只够列模型，不够推理。**本报告不依赖它** |
| 本地中继 `127.0.0.1:15721` | ECONNREFUSED（p3 时期唯一可用的那条已下线） |
| **DeepSeek 官方 API** | ✅ 可达且**三条 wire 全通**（16 token 最小推理）：`/v1/responses` 200、`/anthropic/v1/messages` 200、`/chat/completions` 200 |
| 产品自己的供应商记录 | `~/.aieval/config.json`：`deepseek`（**openai**，`https://api.deepseek.com/`，模型 `deepseek-flash` / `deepseek-v4-pro`，窗口 1048576 / 输出 393216）+ `deepseek-anthropic`（**anthropic**，`https://api.deepseek.com/anthropic`，同两模型） |

⇒ **两条 wire 各有真机靶子，且用的就是产品自己那两条供应商记录**（探测读配置，不自己编一份——避免「跑通了另一件事」）。
两条 baseUrl 形态恰好覆盖 D8 的两个方向：openai 那条**没有 `/v1`**（必须补），anthropic 那条也没有 `/v1`（strip 是恒等）。

## 1. overlay 注入机制（`dsh-overlay-dump.mjs`，0 次模型调用）

真实 dsh 二进制 + `--profile sdk --patch <overlay> --dump-config`：

| 判据 | 有 overlay | 无 overlay |
|---|---|---|
| 合成树里出现路由键 `aieval-route` | **3 处** | 0 |
| 出现 `anthropic-messages`（我们声明的 wire） | **1 处** | 0 |
| `tool-ask-user` 出现次数 | **2** | 0 |
| patch 告警（warn/ignored/skipped/failed） | **0** | 0 |

⇒ **D3 + D3b 成立**：`- id: llm-pi-ai` 的 id 定向覆盖真的把路由装进合成树；
`- insert:` **从 `--patch` overlay**（而不是 profile patch 文件）也能把 `ask_user_question` 挂上（0 → 2，与 p6 那次观测同口径）。

## 2. 请求形状（`forensics.mjs`：故意 404 的本地回声服务器，执行级证据）

Task 0 Step 1 的那几条事实此前只有「pi-ai → 厂商 SDK → 端点常量」三段代码链的推论；现在**抓到了真实请求**：

| 事实 | `anthropic-messages` | `openai-responses` |
|---|---|---|
| 实际路径 | `POST /v1/messages?beta=true` | `POST /v1/responses` |
| overlay 里写的 baseURL | `http://127.0.0.1:PORT`（未归一化输入即无 `/v1`） | `http://127.0.0.1:PORT/**v1**`（`ensureV1Suffix` 补上了） |
| 鉴权头 | `x-api-key: <key>` + `anthropic-version: 2023-06-01` | `authorization: Bearer <key>` |
| **不给 effort**（= `off`） | `thinking: {type:'disabled'}` | `reasoning: {effort:'none'}` |
| `effort=high` | `thinking: {type:'enabled', budget_tokens:1024, display:'summarized'}`，并额外带 `anthropic-beta: interleaved-thinking-2025-05-14` | `reasoning: {effort:'high', summary:'auto'}` |
| 404 的重试 | 走 harness 的 `llm/retry`（实测 `llm/retry` ×5、`llm/retry-started` ×5）⇒ **D6d 成立**：重试归 harness 层，pi-ai 自己不重试 |

两条**订正**（推翻上游注释与我们的旧读法）：

1. **D8 的归一化方向确认为「必须由我们做」**：pi-ai 把 baseURL 原样交给厂商 SDK，
   证据是 openai 那条**同一份 overlay**里写的是 `…/v1`、服务器收到的就是 `/v1/responses`；
   anthropic 那条写 `http://127.0.0.1:PORT`（无 `/v1`）、收到的是 `/v1/messages?beta=true`。
   ⇒ `stripV1Suffix` / `ensureV1Suffix` 的分叉是**唯一正确解**。
2. **`off` 的落点是「显式关闭」而不是「什么都不发」**（`catalog.ts:694-697` 的注释与实际不符）：
   实测 `off` ⇒ anthropic 发 `thinking:{type:'disabled'}`、responses 发 `reasoning:{effort:'none'}`。
   「请求体里完全不出现该字段」只在**整个不写 `off` 键**时才成立——本计划采用 `off: null`（显式关闭）那一支。

## 3. 两条 wire 的真机端到端（`dsh-pi-ai-both.mjs`）

用**产品自己的供应商记录**跑真实 `DeepSeekHarness`（`provider: 'aieval-route'`、`patches: [overlay]`、
凭据走自定义环境变量 `AIEVAL_ROUTE_API_KEY`）：

| 协议 | 供应商 | overlay 的路由 | `finalResponse` | `turn/end` | usage | 判定 |
|---|---|---|---|---|---|---|
| anthropic | `deepseek-anthropic`（`https://api.deepseek.com/anthropic`） | `api: anthropic-messages` | `"好"` | `completed` | ✅ | **✅ 跑通** |
| openai | `deepseek`（`https://api.deepseek.com/` → 归一化 `…/v1`） | `api: openai-responses` | `"好"` | `completed` | ✅ | **✅ 跑通** |

两次的通知分布与 p3 那次（`llm-deepseek` 原生路由）**同形**：`turn/start → step/start → assistant/message → step/end → turn/end`，
`session.status` 两条（running → idle）⇒ 事件投影层**不需要因为换 wire 而改**。

## 4. 档位接受度（`probe-effort.mjs`）

| 面 | 结论 |
|---|---|
| responses：`reasoning.effort` 取 `none/minimal/low/medium/high/xhigh/max` | **七种全部 HTTP 200** ⇒ 本网关不做枚举校验，`max` 无需降级 |
| messages：`thinking:{type:'disabled'}` | 200 |
| messages：`thinking:{type:'enabled',budget_tokens:1024}` | 200，**且真的回了 thinking 块** |
| messages：完全不发 `thinking` 字段 | 200 |

⇒ **D5 的默认映射表可直接采用**：`off: null`、`low: low`、`high: high`、`max: max`。
（首轮 responses 探测里 `effort != none` 时 `status: "incomplete"` 是 `max_output_tokens: 32` 被推理吃掉所致，
不是拒绝——同一次探测里 `none` 是 `completed`。）
⚠️ 计数：anthropic 侧 `budget_tokens` 由档位名推（`minimal 1024 / low 2048 / medium 8192 / high 16384`，`xhigh`/`max` 夹到 `high`），
且会被 `model.maxTokens` 夹住——本次取证里 `maxTokens: 1024` 把 `high` 的预算压到了 1024，**生产上是产品的 393216，不会出现这个压缩**。

## 5. 隐式 LLM 消费者（代码考古，逐条 `文件:行号`）

| 调用点 | 路由来源 | 退役 `DEEPSEEK_*` 后 |
|---|---|---|
| 主会话 | `initialize({provider,model})` | 不受影响 |
| 子智能体（`subagent` / `subagent_fork` / workflow 默认） | **继承父会话路由**：`tool-subagent/src/index.ts:479` → `subagent/src/child-agent.ts:69-86`（优先 `session.requestHeader()?.config`，否则 `parent.options`） → `subagent-in-process-driver/src/index.ts:99-143` | 不受影响 |
| `agent-default-model` | sdk profile 里**无消费者**（读取点只在 headless / session-controller(web) / webhook / tool-cordis；`sdk/server/src/server.ts:137-171,281-290` 都不读它） | 不受影响 |
| 会话标题 | `bundle/sdk-app/cordis.patch.yml:9-10` `disabled: true`；即便启用也跟随会话路由（`session-title-llm/src/index.ts:180-192`） | 不受影响 |
| `compaction-basic` 摘要 | `compaction-basic/src/summarizer.ts:127-142` 的 `configured ?? latest ?? agentTarget` = 会话路由 | 不受影响 |
| goal / goal-round-driver / ralph / schedule / commands | 无独立路由（ralph `disabled: true`、schedule 未挂载、commands 明说不下发模型） | 不受影响 |
| `tool-result-pruner` / `image-offload` | 不发模型请求 | 不受影响 |
| **`web_search`** | `base/cordis.patch.yml:472-481`：`searchProvider: deepseek-official` + `apiKeyEnv: DEEPSEEK_API_KEY`，**不复用 `DEEPSEEK_BASE_URL`** | **一定失败**（错误码 `WEB_PROVIDER_CREDENTIAL_MISSING`）。⚠️ 今天也一样失败——适配器把**网关密钥**塞进 `DEEPSEEK_API_KEY` 去打 DeepSeek 搜索接口；差别只是错误码 ⇒ **非本计划引入的回归** |
| workflow 脚本里模型自写 `agent(p,{provider:'deepseek-official'})` | `workflow-ptc/src/host.ts:200-211` 直传、不 preflight | **可能失败**（取决于模型是否这么写） |
| `dsh-deepseek-llm-api-extensions` | 只被 `llm-deepseek` 消费（`llm-deepseek/src/host.ts:36`） | **静默失效**：`dsh_session_log`（会话日志上传）与 `dsh_plugin_packages`（插件清单）两个顶层请求字段从此不再附加（D6b） |
| `llm-retry` | 全局单执行器、**策略按路由**（`llm/src/index.ts:445-450`；pi-ai 经 `providerRetryPolicy` 交策略，SDK 层写死 `maxRetries: 0`） | 不受影响，且**不会双重重试**（D6d，已由 §2 的 `llm/retry` ×5 实测佐证） |

另外两条让评审少问一轮的：
- **退役后 dsh 仍能正常启动**：`llm-deepseek` 的 `apply()` 只做配置解析，凭据在**请求期**才解析 ⇒「无凭据」只影响真正打到那条路由的请求；
- **`subagent` 工具参数里写 provider/model 不会成为风险**：sdk profile 下 `modelSelectionSettings` 默认 false，会当场抛 `child model selection is disabled for this tool instance`（失败得很早）。

## 6. 路由键与设置命名空间

- 实跑的 `pi-ai@0.85.1` catalog 共 **39 个键**（`amazon-bedrock … zai-coding-cn`），`aieval-route` **不在其中** ⇒ 走手声明路径（`createProvider`）。
- **settings 命名空间 = 插件条目 id `llm-pi-ai`**（`llm-pi-ai/src/index.ts:96,151`），与 route key 是两码事；我们的 overlay 正是按行 id 覆盖，两者对得上。
- SDK `initialize({provider})` 与 `llm.listProviders()` 的 `id` **精确比较**（`sdk/server/src/server.ts:152,296-298`），并与 `resolveCallConfig({provider,model})` 二次校验 ⇒ patch 里的 route key / model id 与交给 harness 的值**必须同源同算**（D7）。

## 7. D9：版本偏斜（**已量到数字**，2026-09-30 收口）

pi-ai 的解析链是 `dsh-sdk-client@0.1.7-rc.1 → dsh@0.1.7-rc.1 → dsh-base@0.1.7 → dsh-llm-pi-ai@0.1.7-rc.1 → @earendil-works/pi-ai ^0.85.1`（`^0.85.1` 对 0.x 只允许 `<0.86`），
实跑版本 **0.85.1**；而 DSH 仓库里修 O(n²) 的 `patches/@earendil-works__pi-ai@0.87.1.patch` 打在 **0.87.1** 上 ⇒ **对下游无效**。
0.85.1 的 `dist/api/anthropic-messages.js:503` 仍在每个 `input_json_delta` 上
`block.arguments = parseStreamingJson(block.partialJson)`（`openai-responses-shared.js` 同形）。

**量法**（`probe/v3/pi-ai-tool-arg-scaling.mjs`）：直接加载**安装态那一份** `dist/utils/json-parse.js`
（本机有两个同版本实例，两个目标文件的 sha256 **逐字节相同** ⇒ 选哪个都不影响结论），
按 0.85.1 的累积—重解析循环跑一个 `write` 风格的工具参数（`{"file_path":…,"content":"AAA…"}`），
每 100 字符一段（≈ 一次 `input_json_delta` 的常见长度）：

| 参数总量 | delta 数 | 逐段重解析累计耗时 | 对照：整份只解析一次 |
|---|---|---|---|
| 8 KB | 80 | **13.7 ms** | 0.008 ms |
| 32 KB | 320 | **136 ms** | 0.018 ms |
| 128 KB | 1280 | **2186 ms** | 0.07 ms |
| 512 KB | 5120 | **37749 ms** | 0.772 ms |

总量 ×4 ⇒ 逐段耗时 ×9.9 / ×16.1 / ×17.3 —— **O(n²) 得到实测确认**（线性的实现应当只 ×4）。

**裁决：可接受，本轮不补 `patchedDependencies`。** 理由逐条：

1. **代价是一次性 CPU 税，不是挂起**：它落在 dsh 子进程（Node 事件循环）里，本仓编排层不被阻塞；
   用户口径是「执行不限时间」（§5.6.5）。**单次 delta 的阻塞上界**是「把当前累积串解析一遍」，
   按上面的数据推：128 KB 的最后一个 delta ≈ 3 ms、512 KB ≈ 15 ms——单次都不足以让界面卡住。
   真正的量是**累计占比**（这一步是推算，不是实测）：一次生成几万字符的工具参数通常要几十秒，
   128 KB 档累计 2.2 s ≈ 多花个位数百分比，512 KB 档累计 38 s ≈ 多花三成。
2. **上一版估算的数字偏乐观一格**（原文：「几十 KB 在毫秒量级」）：实测 32 KB 是 136 ms、128 KB 已到 2.2 s。
   「**MB 级才会有可感停顿**」这个**结论**方向仍然成立（512 KB 是 38 s 累计、单次 15 ms），
   但「毫秒量级」只对 ≤8 KB 成立。这一格按实测订正。
3. **本产品的真实参数分布没有证据说会到 MB 级**：评测用例让候选改的多是源码小改动
   （本轮 §9 的靶子是「回答一个字」；p6 冒烟的用例是「把 README 标题改成中文」）。
4. **补丁本身有行为风险，必须先有一步真机验证**：DSH 那份 0.87.1 补丁做的是**删掉**逐 delta 的
   `block.arguments = parseStreamingJson(...)`（在 6 条 wire 上各删一处）⇒ 流传中的 `partial.arguments`
   在 delta 阶段不再更新，只靠 `toolcall_end` / `block stop` 收口。dsh 侧的消费者是否依赖「delta 阶段就能读到
   arguments」**没有验证过**——贸然打补丁可能换来一类更难查的静默行为变化。

**处置预案（不预先执行，触发条件写明）**：若真实评测里出现「大文件写入时明显停顿」，
按下面三步做，且**不要**只升版本（`^0.85.1` 对 0.x 只允许 `<0.86`，升版本会与 dsh 的 peer 校验打架）：

1. 复制一份 0.85.1 的安装态目录、按 DSH 那份补丁同形地删掉各 wire 的逐 delta 重解析，
   用真实 `diff -u` 生成 `patches/@earendil-works__pi-ai@0.85.1.patch`（**别手写 hunk 头**，
   手写的 context 与实际字节差一格就会让 `pnpm install` 直接失败）；
2. `pnpm-workspace.yaml` 加 `patchedDependencies: { '@earendil-works/pi-ai@0.85.1': patches/… }` 后 `pnpm install`；
3. **补一次真机工具调用**（复用 §9 的 `dsh-adapter-dual-protocol.mts`，把提示词换成「用 write 工具写一个 100 KB 的文件」），
   确认 dsh 侧拿到的工具参数仍然完整、且没有依赖 delta 阶段的 `arguments`。

## 8. 未覆盖与残余不确定性

1. **`web_search` 的处置未定**（D6c 的裁决项）：默认「不动、只登记」；可选动作是先核对 `dsh-tool-web` 的 Config 里
   有没有关闭搜索的开关，再决定是否在 overlay 里关掉。
2. **内部网关 likecode 的推理面**：本轮 401「登录态丢失」，未能判定它是否提供 `/v1/responses`。
   该判定**不影响本计划**（产品的两条供应商记录都指向 DeepSeek），但若将来要用它，需要一把能推理的凭据。
3. **D9 的证据等级是「库级微基准」**（见 §7）：量的是安装态那一份 `parseStreamingJson` 的真实代价，
   **不是**一次真机大参数工具调用——网关的分片粒度（Δ）、dsh 的调度与真实生成的重叠行为都未覆盖。
   要做成「真机」得跑 §7 处置预案第 3 步。
4. **未跑真实评测任务**（带工具调用、多轮、大文件写入）：§9 的靶子是「走适配器的最小推理 + 事件形状」，
   仍不是一次完整评测（真实 `runRow` 八步 + 真实评分）。这一格如实登记为**未覆盖**。

## 9. 适配器路径的端到端（Task 9，`dsh-adapter-dual-protocol.mts`）

§3 那份探针**自己装配**（自己 `new DeepSeekHarness`、自己拼 overlay、自己设 `provider`/`patches`），
证明的是 **pi-ai 路由机制**成立。**本节的探针只交一个 `AgentRunInput`**，其余全部由
`dshProvider.run()` 自己做——overlay 生成与落盘、`provider` / `patches` / 环境变量、通知投影、计量归集。
**这是唯一能证明「两种协议真的都能从产品代码路径跑通」的一步**：适配器里任何一处接线写错
（patch 的 model id 漂移、档位缺键、baseURL 归一化方向反了、`patches` 给了相对路径）都会在这里现形，
而单测里的假 SDK 看不到这些。

工具链：`node probe/v3/dsh-adapter-dual-protocol.mts both`（用 `jiti` 直接 import 仓库内的 TS 源码——
Node 24 的类型剥离**不解析无扩展名相对导入**，实测在 `@aieval/core` 的 `./logger` 处 `ERR_MODULE_NOT_FOUND`）。

| 协议 | 供应商 | `ok` | `exitReason` | `tokens` | `turns` | `finalText` | 判定 |
|---|---|---|---|---|---|---|---|
| anthropic | `deepseek-anthropic` | `true` | `completed` | `{input:7051, cached:640, output:1}` | `1` | `"好"` | **✅ 跑通** |
| openai | `deepseek` | `true` | `completed` | `{input:256, cached:7424, output:1}` | `1` | `"好"` | **✅ 跑通** |

两条各 18 条事件（`log` + `usage`），耗时 6.7s / 3.9s。**退出码 0**。
⇒ **「双协议在适配器上都能跑」这句话现在有执行级证据**，不再只有夹具背书。

### 9.1 这一步发现的真机缺陷：冷启动握手预算（已修）

第一次跑**两条协议双双失败**：

```
AGENT_FAILED  initialize timed out after 10000ms waiting for dsh profile "sdk"
```

真因不是协议、不是凭据、不是 overlay 内容：**SDK 的 `initializeTimeoutMs` 默认 10s**
（`launch.d.ts` 的 `DEFAULT_INITIALIZE_TIMEOUT_MS = 10000`），而适配器**从不设这一格**。
本仓每一行都跑在**全新的 `configHome`** 上（§5.6.4 不变量 3）⇒ **每次运行都是冷启动**，
dsh 要解析整棵插件树才回 initialize。实测同一台机器：**空闲时握手落在 4–7s 内（侥幸过）**，
而**带负载时超过 10s**（两次连续超时，第一次失败那轮后台正跑着全量测试）。
Task 0 的裸 SDK 探针正是为此显式给了 60s（`probe/v3/lib/harness.mjs` 的注释逐字写着
「冷启动要解析整棵插件树；默认 10s 会偶发 initialize 超时」），**适配器漏了同一格**。

修法：`sdk.ts` 的窄结构补 `initializeTimeoutMs?: number`，`startDsh` 传
`DSH_INITIALIZE_TIMEOUT_MS = 60_000`（取值依据 = Task 0 那份有执行级证据的值），
并由 `index.test.ts` 的一条用例钉住（变异体：删掉那一行 ⇒ 用例以 `undefined` 变红）。

**这一类缺陷只有走真适配器的端到端能发现**：单测里的假 SDK 不握手，`pnpm typecheck` 不管默认值，
而它在生产上的表现是「新配的一行第一次跑就失败，重跑有时又好了」——最容易被归因成「网关抽风」。

## 10. 最终事实表（Task 10 收口）

| # | 事实 | 状态 | 证据 |
|---|---|---|---|
| 1 | `anthropic → anthropic-messages`、`openai → openai-responses`（**不**映射 chat-completions） | ✅ 真机 | §2 抓到的真实请求 + §3 / §9 端到端 |
| 2 | pi-ai **不归一化** baseURL ⇒ 归一化必须由适配器按 wire 分叉 | ✅ 真机 | §2（`openai` 那条写了 `/v1`、服务器收到 `/v1/responses`；`anthropic` 写裸 host、收到 `/v1/messages?beta=true`） |
| 3 | 四档 `off/low/high/max` 在该网关上**全部被接受**，`max` 无需降级 | ✅ 真机 | §4（七种 effort 全 200） |
| 4 | `off` 的落点是**显式关闭**（`thinking:{type:'disabled'}` / `reasoning:{effort:'none'}`），不是「不发字段」 | ✅ 真机 | §2 |
| 5 | per-run overlay（`- id: llm-pi-ai` 定向覆盖 + `- insert:` 挂 `tool-ask-user`）**机制成立** | ✅ 真机 | §1（合成树 3 处路由键、`tool-ask-user` 0→2、0 条 patch 告警） |
| 6 | 路由级重试不需要额外接线（pi-ai 自己不重试，harness 层重试） | ✅ 真机 | §2（`llm/retry` ×5） |
| 7 | `aieval-route` 不与 pi-ai catalog 的 39 个键撞车 | ✅ 静态 | §6 |
| 8 | 隐式 LLM 消费者**全部继承会话路由**（除 `web_search`） | ✅ 代码考古 | §5 |
| 9 | 退役 `DEEPSEEK_*` 后 dsh 仍能启动、且两条协议都跑通（凭据走 `AIEVAL_ROUTE_API_KEY`） | ✅ 真机（启动与跑通）+ ✅ 用例（环境里确实没有 `DEEPSEEK_*`） | §9 走的就是适配器（它用 `buildSubprocessEnv` 注入 `AIEVAL_ROUTE_API_KEY` 并**显式删除** `DEEPSEEK_API_KEY` / `DEEPSEEK_BASE_URL`）；「子进程环境里真的没有那两个键」由 `index.test.ts` 的宿主环境守卫钉住（D6a），**不是**本探针测的——探针不窥视子进程环境 |
| 10 | 冷启动握手需要比 SDK 默认（10s）更宽的预算 | ✅ 真机 | §9.1 |
| 11 | D9 版本偏斜（pi-ai 0.85.1 仍在每个 delta 重解析 JSON，O(n²)） | ✅ **已量到数字**：8 KB→13.7 ms、32 KB→136 ms、128 KB→2.19 s、512 KB→37.7 s（×4 总量 ⇒ ×10–17 耗时，确认 O(n²)）；裁决「可接受，不补补丁」，触发条件与三步预案见 §7 | §7（`probe/v3/pi-ai-tool-arg-scaling.mjs`，**库级微基准**；真机工具调用未做） |
| 12 | `web_search` 一定会失败（`deepseek-official` + `DEEPSEEK_API_KEY`） | ⚠️ 裁决项，未动 | §5、§8 第 1 条 |
| 13 | `text-api.ts` 的 openai 分支仍走 chat-completions（非智能体评分通路） | ⚠️ 已知边界，登记在契约 R37 收口 | 计划 D2b |

