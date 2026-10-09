# codex `/v1/chat/completions` 与子智能体用量 · v6 真机探针结论

用户口径（2026-10-07）：**codex 不再用 responses，改用 chat 协议**；先测「app-server 方式下
`/v1/chat/completions` 能否拿到思考内容，以及子智能体用量」，可以就改。

- 真机：`codex-cli 0.156.1`（适配器实际 spawn 的那份，`node_modules/.pnpm/@openai+codex@0.156.1-win32-x64/.../bin/codex.exe`）
- A 组上游：**本地 relay**（只记录「收到了哪个路径的请求」，回 404；不打真上游、不花模型调用）
- B 组上游：`https://api.deepseek.com/v1`（`wire_api: responses` + `env_key: OPENAI_API_KEY`），模型 `deepseek-reasoner`
- 采集：`app-server` stdio JSON-RPC，**逐行原文**落盘（`probe/dumps/v6/*.jsonl`）
- 探针：`probe/v6/codex-chat-wire-appserver.mjs`（`only=wire` / `only=live`）

## ① 逐题一句话结论

1. **`wire_api: "chat"` 在 app-server 路径上不可用**：不是「请求打错端点」，而是 `thread/start` 的
   **配置校验阶段**就被拒（`-32600`，原文见 ②），relay **一个请求都收不到**。别名
   （`chat_completions` / `openai-chat` / `completions`）报 `unknown variant …, expected \`responses\``。
2. **根因不是配置写法，是 codex 客户端已经删掉了 chat 实现**：0.156.1 二进制里 `chat/completions`
   **零命中**；`0.160.1`（npm `latest`）源码的 `WireApi` **只剩 `Responses` 一个变体**，`"chat"` 直接
   映射到「已移除」错误；连内置的 `ollama` / `lmstudio` 两个 OSS provider 也改成 `WireApi::Responses`
   ⇒ **升级版本也换不来 chat wire**。
3. **用户想靠 chat 换来的两样东西，responses 上真机已经拿到**：思考正文（`reasoning.content[]`，
   本轮 161 字，`summary[]` 空）与**子智能体用量**（`thread/tokenUsage/updated` 对主线程与子线程
   **各报一份**，子线程 total 24888）。⇒ 改 wire 既不可行、也无收益。
4. **子线程的 `turn/completed` 先于主线程到达**（两轮实测一致）：把「任何线程的 `turn/completed`」
   当本轮闸门，会在主线程仍 `inProgress` 时提前收尾（第一轮探针就这么错的，见 ③ 的对照）。
5. **子智能体工具是 `collabAgentToolCall`**（`spawnAgent` / `wait` / `closeAgent`），条目里带
   `receiverThreadIds` 与 `agentsStates`——`wait` 的 `agentsStates[<childId>].message` **直接是子智能体的
   结论原文**（本轮值：`输出：\n\n```\nCHILD-TOOL-RAN\n``` `）。

## ② A 组：`wire_api` 取值矩阵（app-server 路径，relay 判据）

`thread/start` 的线程级 `config`（**与生产适配器同一个入口**）里逐值替换 `model_providers.aieval.wire_api`，
`base_url` 指向本地 relay：

| `wire_api` | `thread/start` | relay 收到的请求 | 判定 |
|---|---|---|---|
| `chat` | ❌ `-32600 failed to load configuration` | 无 | 配置层被拒 |
| `chat_completions` | ❌ `unknown variant` | 无 | 配置层被拒 |
| `openai-chat` | ❌ `unknown variant` | 无 | 配置层被拒 |
| `completions` | ❌ `unknown variant` | 无 | 配置层被拒 |
| `responses`（对照） | ✅ 通过 | `POST /v1/responses` ×2 | **判据有效**：协议确实打到 Responses 端点 |

**错误原文（逐字）**：

```
app-server 错误（-32600）：failed to load configuration: `wire_api = "chat"` is no longer supported.
How to fix: set `wire_api = "responses"` in your provider config.
More info: https://github.com/openai/codex/discussions/7782
in `model_providers.aieval.wire_api`
```
```
app-server 错误（-32600）：failed to load configuration: unknown variant `chat_completions`, expected `responses`
in `model_providers.aieval.wire_api`
```

**为什么要有 relay 这一层**：只报「被拒」还不够——万一 CLI **静默忽略**这个键，结论就反了。
relay 让「接受」这一支也必须留下痕迹（请求路径），两种失败形态（报错 / 静默忽略）因此可区分。
对照组打到 `POST /v1/responses` 证明这条判据本身是通的。

**客户端侧的两条独立证据**（同一结论，来源不同）：

- `strings` 层面的 `0.156.1`：`chat/completions`、`v1/chat`、`use_chat_completions` **全部零命中**；
  wire 相关可读串只有 `` `wire_api = "chat"` is no longer supported. `` 与 `How to fix: set `wire_api = "responses"`…`；
  Ollama 的内置描述已写成 `Local Ollama server (Responses API, default port 11434)`。
- 源码层面的 `rust-v0.160.1`（`codex-rs/model-provider-info/src/lib.rs`）：
  ```rust
  pub enum WireApi { #[default] Responses }          // 只有这一个变体
  "chat" => Err(serde::de::Error::custom(CHAT_WIRE_API_REMOVED_ERROR)),
  _ => Err(serde::de::Error::unknown_variant(&value, &["responses"])),
  ```

## ③ B 组：真机 responses 下「思考内容 + 子智能体用量」

提示词要求派一个**前台**子智能体、并在子任务里真跑一次 shell（`echo CHILD-TOOL-RAN`）；
主线程闸门 = **主线程自己的** `turn/completed`。

| 读数 | 主线程 | 子线程（nickname `Linnaeus`） |
|---|---|---|
| threadId | `01a115e6-fa09-7bd3-b8a4-af6238df5e55` | `01a115e7-007d-7fa1-a709-13e1bb2001b8` |
| `turn/completed` | ✅ completed（**后**到） | ✅ completed（**先**到） |
| `thread/tokenUsage/updated` | ✅ total 44972 / input 44774 / cached 44288 / output 198 / **reasoning 35** | ✅ total 24888 / input 24830 / cached 24448 / output 58 / reasoning 0 |
| 思考条目 | 1 条，`content[0]` **161 字**（明文英文思维链），`summary[]` **空** | 0 条（该轮 `reasoningOutputTokens = 0`，没有可推的内容） |
| `item/reasoning/textDelta` | 35 条，且**条数恰好等于 `reasoningOutputTokens`(35)** | 0 条 |
| 最终答复 | `done`（4 字） | `输出：\n\n```\nCHILD-TOOL-RAN\n``` `（27 字） |
| `thread/read` | `itemsView: full`，条目 `userMessage, reasoning, collabAgentToolCall ×2, agentMessage` | `itemsView: full`，条目 `userMessage, commandExecution, agentMessage` |

**线程树由协议给**：`thread/list{ancestorThreadId: <主线程>}` 返回 1 条后代，`parentThreadId` 指向主线程，
`agentNickname = Linnaeus`，`status.type = idle`。⇒ 「子智能体用量」不需要扫盘、也不需要 chat wire。

**子智能体工具的原始条目**（`item/completed` 的 `params.item`，逐字节选）：

```json
{"type":"collabAgentToolCall","id":"call_00_ZdiJSXzwYCEBCXN9CoFt2621","tool":"wait","status":"completed",
 "senderThreadId":"01a115e6-fa09-…","receiverThreadIds":["01a115e7-007d-…"],
 "agentsStates":{"01a115e7-007d-…":{"status":"completed","message":"输出：\n\n```\nCHILD-TOOL-RAN\n```"}}}
```
子线程自己执行命令的那条同源证据：`threadId = 01a115e7-007d-…` 的 `commandExecution`，命令是
`"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" -Command 'echo CHILD-TOOL-RAN'`，`status: completed`。

**第一轮（判据有缺陷）的对照读数**——同一现象复现两次，且这次暴露了 ①-4：

| | 第一轮 | 第二轮（修正判据后） |
|---|---|---|
| 闸门 | 任何线程的 `turn/completed` | **主线程**的 `turn/completed` |
| 结果 | 11s「结束」，主线程 `turn/completed` **没等到**、`thread/read` 里主线程 turn 仍是 `inProgress`、`completedAt: null` | 6.7s 正常收尾，主线程 turn `completed`、最终答复 `done` |
| 用量 | 主 45119 / 子 24903（子线程已结束、主线程还在跑） | 主 44972 / 子 24888（两份都是终值） |

## ④ 未验证 / 边界（如实说，不猜）

- **「子线程的思考内容会不会推给父连接」本轮无样本**：两轮里子线程那一轮都是 `reasoningOutputTokens = 0`
  （没有任何 reasoning 条目可推）⇒ 通知流里只有主线程的思考条目，**不能**据此说「子线程思考不推送」。
- **`0.160.1` 只做了源码与二进制字符串层面的核验**（下载了 `@openai/codex@0.160.1-win32-x64` 的 tarball），
  **没有**装它跑真机；「升级也换不来 chat wire」这条结论的依据是 `WireApi` 枚举本身（源码级）。
- **relay 不实现协议翻译**：本轮只回答「CLI 会不会打 chat/completions」，**没有**验证
  「responses ↔ chat 的本地翻译层」这条路（若某个上游只讲 chat，需要另做一层代理，代价与风险未评估）。
- A 组的 `responses` 对照 case 里 relay 收到 **2 次** `POST /v1/responses`（CLI 的内部重试/预检），
  与「wire 取值」无关，登记以免下次误读。

## ⑤ 落盘文件清单

| 路径 | 内容 |
|---|---|
| `probe/v6/codex-chat-wire-appserver.mjs` | 主探针（A 组 + B 组，逐行原文落盘 + 判定） |
| `probe/v6/run.ps1` | 运行外壳（从 `~/.dsh/.credentials.yaml` 注入密钥，不打印、不落盘；**UTF-8 with BOM**，见文件头） |
| `probe/dumps/v6/codex-chat-wire-appserver.json` | 汇总（A 组逐值判定 + B 组全部读数） |
| `probe/dumps/v6/codex-chat-wire-appserver-wire-<值>.jsonl` | 每个 wire 取值的原始帧（含被拒 case：只有请求/错误，没有通知） |
| `probe/dumps/v6/codex-chat-wire-appserver-live-responses-subagent.jsonl` | B 组原始帧（第二轮 97 行，含通知、响应与 `thread/read`） |

密钥只经环境变量流转；落盘前按**精确密钥串**替换（`redact`）。

⚠️ **覆盖写提醒**：B 组两轮用同一个文件名（`writeFileSync` 覆盖），所以**第一轮的原始帧已不在**——
上表 ③ 里第一轮的那三格读数（11s / 主 45119 / 子 24903）取自当时的运行汇总输出，**不可复现**，
要重放请按「修正前的判据」自行造回（把闸门换回 `server.turnCompleted()`）。A 组每个取值一份文件，不互相覆盖。

## ⑥ 结论一段话

**「codex 改用 `/v1/chat/completions`」这条路在本机不可行，且不是配置问题**：app-server 的线程级
config 校验直接拒 `chat`（`wire_api = "chat"` is no longer supported），CLI 二进制里已无 chat 客户端
（`chat/completions` 零命中），npm `latest`（0.160.1）的 `WireApi` 只剩 `Responses` 一个变体。
而改 wire 想换来的两样**在 responses 上真机都已拿到**：思考正文（`reasoning.content[]` 明文，
与 v5 报告同源）与**子智能体用量**（`thread/tokenUsage/updated` 按线程各报一份，子线程那份经
`thread/list{ancestorThreadId}` 认领）。⇒ 适配器保持 `wire_api: 'responses'`；要动的是别的地方，
不是 wire。
