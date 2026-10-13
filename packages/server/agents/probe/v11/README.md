> 本目录由多张探针票共用：**AU-08（dsh 应答面）见下**，**AU-06（cc 提问通道与应答面）见文末**，
> **AU-07（codex 提问的管道 stdin 门禁）见最末一节**。
> 各票只写自己的脚本与判据，读数落在同目录 `REPORT.md` 的对应一节（AU-06 那一节已有实跑读数），
> 并由人回填到各自票的 `## Comments`。

# v11 / AU-08 人工步骤：装一个最小应答者插件、跑一次问答

静态结论（应答者注册签名、两档输出形状、完整时序、无人应答的收场）已经写在同目录
[`REPORT.md`](./REPORT.md) 的第 2–5 节，**不需要真机就能用**。
本文件只讲**真机那一步**怎么走、每一步的判据是什么、原文回填到哪一格。

预期耗时：免费检查约 10 秒；真机四臂约 3–8 分钟（取决于模型延迟与 C 臂那个 8 秒等待）。

## 0. 前置条件

| 项 | 怎么确认 | 缺了会怎样 |
|---|---|---|
| 依赖已装 | `ls node_modules/.pnpm/@deepseek-ai+dsh@*` 有输出 | `dsh-answerer-config-dump.mjs` 会报「找不到 dsh CLI 入口」 |
| dsh 凭据 | 宿主 `~/.dsh/.credentials.yaml` 里有 `DEEPSEEK_API_KEY` | 真机四臂全部以 401 / `turn/end(kind:'error')` 收场 |
| 模型 id | 默认 `deepseek-flash`（v2 外壳的缺省） | 需要换模型时改 `probe/v2/lib/dsh.mjs` 的 `runDshProbe` 缺省值或加 `model` 选项 |

**不需要网关 key**。dsh 走它自己的 `deepseek-official` 路由，凭据就是上面那份 credentials 文件；
本批探针全程不碰 `AIEVAL_PROBE_GATEWAY_API_KEY`。

## 1. 先跑免费的那一步（必做）

```bash
node packages/server/agents/probe/v11/dsh-answerer-config-dump.mjs
```

它用 dsh CLI 的 `--dump-config` 把四臂的行**组装一遍**（不连网关、不挂插件、不调模型），断言：

1. `dsh-base` 的 `user-questions` 服务行在场；
2. 每臂要的行都在（id 逐字），`timed` 臂的 `config.mode` / `config.timeout` 逐字；
3. 应答者那一行的 `name` 被解析成 `file:///…` **且该文件真实存在**；
4. 打印相对名的解析结果（`ℹ 相对名 ./aieval-ask-answerer.mjs 被这一层解析为：…`）。

**判据：退出码 0 且末行是 `✅ 全部行形状检查通过（ 4 臂）`。**
非 0 就先别跑真机——真机每臂都要花钱，而 YAML 形状错在组装期就能看出来。

## 2. 再跑真机四臂

```bash
# 全部四臂
node packages/server/agents/probe/v11/dsh-answerer-roundtrip.mjs

# 只想止血取证（B/C 两臂最便宜、最直接）
node packages/server/agents/probe/v11/dsh-answerer-roundtrip.mjs --arms=B,C

# D 臂那条文件通道想留更大的观察窗口
node packages/server/agents/probe/v11/dsh-answerer-roundtrip.mjs --arms=D --serve-delay=3000
```

四臂各自要拿的东西：

| 臂 | 组装形状 | 期望 | 判据（终端里那三行「判读」） |
|---|---|---|---|
| A | legacy + 应答者（canned） | 工具结果 `{"answers":[{"id":"probe_confirm","selected":["PROBE-<nonce>-B"]}]}` | `⏳ 形状像 answers 支` 且 `isError=false` |
| B | legacy + 无应答者 | 工具结果**报错** | `⏳ 形状像报错支` 且 `isError=true` |
| C | timed(timeout=8) + 无应答者 | `{"pending":true,"callId":"…","message":"…"}` | `⏳ 形状像 pending 支` |
| D | timed(timeout=60) + 应答者（file） | 同 A，且终端里出现「D 臂父进程：已按观察到的请求作答」 | `⏳ 形状像 answers 支` 且 sidecar 里有 `phase: "request"` 与 `phase: "answer"` |

`<nonce>` 是每批随机生成的 6 位十六进制，打印在开头（`提示词 nonce = …`）——**它出现在工具结果里
就证明答案是从应答者流回来的**，而不是模型自己编的。

## 3. 每臂结束时要看的三处原文

脚本已经把这三处打到终端，同时也落进 `probe/dumps/v11/dsh-answerer-roundtrip.json`：

1. `工具调用/结果` —— `arguments`、`result.isError`、`result.text`；
2. `应答者 sidecar` —— 插件自己写的四相（`plugin-loaded` / `request` / `answer` / `delegate`）。
   其中 `plugin-loaded` 那一行的 `url` 回答「相对名到底按哪个目录解析」；
   `request` 那一行是**请求到达应答者的原文**（含 `wait`、`hasSignal`、`agentId`、`sessionId`）；
3. `最终答复` —— 模型回抄的结果原文。

## 4. 回填

把上面三处原文填进 [`REPORT.md`](./REPORT.md) **第 8 节**那张表的对应格，并把「跑了吗」勾上。
三格必须逐字抄、不要转述：

- B 臂的**报错原文**（含是否有 `Error: ` 前缀）；
- C 臂的 `message` 全文（与第 5 节的 `pendingNotice` 对不对得上）与 `callId`；
- A / D 臂的 `selected` 里是不是 `PROBE-<nonce>-B`。

## 5. 跑不动时先看这里

| 症状 | 先怀疑 |
|---|---|
| `dsh-answerer-config-dump.mjs` 报找不到 dsh CLI | 依赖没装；或用 `--dsh-bin=<绝对路径>` 指定 `@deepseek-ai/dsh/lib/bin.js` |
| 四臂都「工具调用【没发生】」 | 模型没调工具（提示词里那句「只问一题」被忽略）⇒ 看 `/tmp/aieval-v11-*/` 下的会话日志与 dump 的原始通知流 |
| 应答者 sidecar 是空的（0 行） | 插件没被加载：看运行目录里有没有 `dsh: warning: 1 entry did not activate` + `failed to import`；对照第 1 步打印的解析结果 |
| A 臂 `isError=true` 且报 `NO_PROVIDER` | 插件加载了但没收到请求（scope 过滤）；报告第 2.1 节第 2 条给了两条放行写法 |
| C 臂 `isError=true` | 说明 `mode: timed` 没生效（配置写在了顶层而不是行的 `config` 下）——回去跑第 1 步 |

---

# v11 / AU-06：cc 的提问通道与应答面（人工步骤）

**默认臂已跑**（脚本式本机假上游，不需要网关 key）：读数与结论见 `REPORT.md` 的 AU-06 节；
只有 `--arm=live`（真网关）与真机档没跑。
产物一律落 `packages/server/agents/probe/dumps/v11/`（整个 `dumps/` 已 gitignore，不入库）。

---

## 06：cc 的提问通道与应答面

三个脚本各答一问，**互不依赖**，可以单独跑。

### 前置条件

- 仓库根跑过 `pnpm install --frozen-lockfile`（脚本要用 `@anthropic-ai/claude-agent-sdk` 与它自带的 CLI 二进制）。
- Node ≥ 20（脚本用内置 `fetch` 与顶层 `await`）。
- **不需要网关 key**：默认走「脚本式上游」——本机起一个假 `/v1/messages`，主动回一帧
  `AskUserQuestion` 的 `tool_use`。于是「模型愿不愿意问」不是自变量，被问的机制本身是确定性的，
  也顺带能逐字看到**模型拿到了什么工具结果**。
- 只有 `cc-ask-channel.mjs --arm=live` 要真凭据：`AIEVAL_PROBE_GATEWAY_API_KEY` +
  `AIEVAL_PROBE_GATEWAY_BASE_URL`（缺哪个就打印哪个并退出；源码里没有任何明文 key）。

### 命令（在仓库根逐条复制）

```bash
# ① 通道归属 + 挂起边界（5 臂 × 2 权限档；挂住的臂会各等到 --timeout-ms 上限，整轮约 4–6 分钟）
node packages/server/agents/probe/v11/cc-ask-channel.mjs

# 只跑一条臂 / 只跑一个权限档
node packages/server/agents/probe/v11/cc-ask-channel.mjs --arm=both --mode=bypass
node packages/server/agents/probe/v11/cc-ask-channel.mjs --arm=none --mode=default
node packages/server/agents/probe/v11/cc-ask-channel.mjs --arm=auq-timeout      # 厂商侧「空闲自动续跑」的边界（默认 never）

# ② 答案能不能随「允许并改写入参」递回去（7 臂，含对照臂与「晚点才答」臂）
node packages/server/agents/probe/v11/cc-ask-answer.mjs

# ③ 子智能体提问的身份字段 + 「没有批准面」那一档
node packages/server/agents/probe/v11/cc-ask-subagent.mjs

# ④ 可选：真网关真模型，只回答「模型看不看得见 / 会不会问」
AIEVAL_PROBE_GATEWAY_API_KEY=… AIEVAL_PROBE_GATEWAY_BASE_URL=… \
  node packages/server/agents/probe/v11/cc-ask-channel.mjs --arm=live --live-tools=listed
```

### 开关

| 开关 | 取值 | 说明 |
|---|---|---|
| `--arm=` | `channel`：`all`（缺省）/ `both` / `none` / `null` / `hold` / `auq-timeout` / `shadow-ab` / `live`；`answer`：`all`（缺省）/ `plain` / `answers` / `multi-csv` / `notes` / `response` / `invalid` / `late`；`subagent`：`all`（缺省）/ `subagent` / `no-surface` | 跑哪些臂 |
| `--mode=` | `both`（缺省）/ `bypass` / `default` | 权限档（`bypass` = 本仓适配器今天那一档） |
| `--timeout-ms=` | 缺省 45000（channel/answer）、60000（subagent） | 单臂墙钟上限；**挂住的臂就是靠它收场**，这个数字本身就是「挂住的边界」读数 |
| `--late-ms=` | 缺省 3000 | `answer --arm=late` 挂多久再答（模拟人晚点才点「完成」） |
| `--auq-timeout-ms=` | 缺省 100000 | `channel --arm=auq-timeout` 的预算（要盖过厂商的 60s） |
| `--live-tools=` | `listed`（缺省）/ `none` | live 臂是否把 `AskUserQuestion` 显式列进 SDK 的 `tools` |
| `--model=` | 缺省 `claude-sonnet-4-5` | 只是 CLI 的模型名（脚本式上游把它原样回给客户端），与网关无关 |
| `--no-tee` | — | 关掉「原始控制帧」捕获（见下）的逃生口 |

### 原始控制帧（`--tee`，缺省开）

回调只能证明「我被调用了」，证明不了「厂商发的是哪种控制请求」；而 `supportedDialogKinds`
未声明的 dialog kind **根本不下发**，所以「dialog 回调没被调用」单独看是不可证伪的。
为此脚本把 SDK 拉起的 CLI 包一层透明转发（`lib/cc-ask-tee.mjs`，经 SDK 的
`pathToClaudeCodeExecutable`），把 stdin/stdout 各落一份 NDJSON：

```
probe/dumps/v11/<label>.frames-in.ndjson   宿主 → CLI（我们发出去的权限应答）
probe/dumps/v11/<label>.frames-out.ndjson  CLI → 宿主（`control_request` 在这一侧）
```

每轮开跑前有一次**预检**（单独跑一次 `--version`）：预检失败就**大声**退回不带帧的模式并把原因写进产物
（否则「包装挂了」会被读成「厂商没有下发请求」——那是假绿）。要换 CLI 版本对照时用
`AIEVAL_PROBE_CLAUDE_BIN=/path/to/claude` 钉死。

### 产物

```
probe/dumps/v11/<label>.jsonl                SDK 消息流原文（一行一条）
probe/dumps/v11/cc-ask-*-summary.json        结构化读数（回调、控制帧、工具结果、判据命中）
probe/dumps/v11/<label>.frames-{in,out}.ndjson  原始控制帧（--tee 时才有）
```

### 判据（看到什么算哪种结论）

三条问题各自的判据写在对应脚本的末尾输出里，也在同目录 `REPORT.md` 的「判据」一节逐条列出。
一句话版：

1. **通道**：`callbacksFired.canUseTool > 0` 或控制帧里出现 `subtype: "can_use_tool"` ⇒ 权限通道；
   `onUserDialog > 0` 或 `subtype: "request_user_dialog"` ⇒ 对话框通道；两者都没有 ⇒ 看工具结果与工具表。
2. **答案**：工具结果里**逐字**出现我们递回去的答案串 ⇒ 递得回去；出现别的收场（例如
   `The user did not answer the questions.`）⇒ 递不回去，把原文抄进票里。
3. **子智能体 / 没有批准面**：回调选项里的 `agentID`（或控制帧的 `agent_id`）非空 ⇒ 本仓能判
   「子智能体不能向用户提问」；`permissionPrompts: "none"` 下回调 0 次 + 模型拿到一条明确拒绝原文
   ⇒ 这一档如实落「无人应答」。

---

# v11 / AU-07：codex 提问的管道 stdin 门禁（人工步骤）

**运行是人工步骤**：本票交付脚本 + 判据，读数由人跑出来并回填到
[`REPORT.md`](./REPORT.md) 的 `## AU-07` 一节与 07 号票的 `## Comments`。

## 前置条件

| 项 | 怎么确认 | 缺了会怎样 |
|---|---|---|
| 依赖已装 | 仓库根跑过 `pnpm install --frozen-lockfile` | `resolveCodexBinary()` 报「找不到 @openai/codex 的平台包」 |
| 网关凭据 | 环境里有 `AIEVAL_PROBE_GATEWAY_API_KEY` 与 `AIEVAL_PROBE_BASE_URL`（也认同义的 `AIEVAL_PROBE_GATEWAY_BASE_URL`） | 启动即抛，**并打印缺的是哪一个**；源码里没有任何明文 key |
| 模型 id | `AIEVAL_PROBE_MODEL`（缺省 `GLM-5.3`） | 网关不认这个模型名时该臂以模型侧报错收场 |
| python3（**只 `pty` 臂要**） | `python3 -c "import pty, tty"` 退出码 0 | `pty` 臂**如实标跳过**并打印原因，不静默降级成又一条管道臂 |

## 跑一次

```bash
# 缺省四臂（off / tools-only / on / pty），约 4 次模型往返
AIEVAL_PROBE_GATEWAY_API_KEY=… AIEVAL_PROBE_BASE_URL=https://…/v1 \
  node packages/server/agents/probe/v11/codex-ask-user-stdin.mjs

# 只跑主臂（最省）
AIEVAL_PROBE_GATEWAY_API_KEY=… AIEVAL_PROBE_BASE_URL=https://…/v1 \
  node packages/server/agents/probe/v11/codex-ask-user-stdin.mjs --arms=on

# 补三条边界臂：不回帧（今天的现状）/ 客户端回「没有交互式终端」/ 子线程提问
node packages/server/agents/probe/v11/codex-ask-user-stdin.mjs --arms=noreply,refuse,subagent
```

主要开关（全部见脚本头部）：

| 开关 | 缺省 | 说明 |
|---|---|---|
| `--arms=` | `off,tools-only,on,pty` | 逗号分隔；可选再拼 `noreply` / `refuse` / `subagent` |
| `--answer=` | `empty` | `empty`（`{answers:{}}`）/ `blank`（每问一个空数组）/ `filled`（回选项标签） |
| `--turn-timeout-ms=` | 150000 | 单臂墙钟上限 |
| `--noanswer-grace-ms=` | 60000 | `noreply` 臂：请求到达后再等多久收手 |
| `--relay=false` | 开 | 直连网关（不抓请求体 ⇒ 判据 ③ 退化成「读条目流」） |

## 判据（看到什么算哪种结论）

| 判据 | 读数落在 | 结论 |
|---|---|---|
| ① 请求到不到 | `askRequestCount` | `> 0` ⇒ **管道 stdin 不拦**（本票主判据）；`= 0` 才需要看 ③ |
| ② 到了，抄原文 | `askRequests[].paramsRaw` | `isBlocking` / `autoResolutionMs` / `questions[]`（`id` `header` `question` `options[]` `isOther` `isSecret`）与选项的 `label` / `description`，逐字抄给 09 号票 |
| ③ 没到，分成两种 | `toolTable.everHasRequestUserInput` + `itemSummary[].error` | 请求体 `tools[]` 里**没有** `request_user_input` ⇒ 「工具没被提供给模型」；**有** 而条目流里出现带 error 的调用 ⇒ 「提供了但调用被拒」（把 error 原文抄回来） |
| ④ 回空答案之后 | `turnStatus` + `continued.resultFileExists` + `continued.finalText` | `completed` ∧ `result.txt` 在 ⇒ **继续按最佳判断干活**；`failed` ∧ 文件不在 ⇒ **判成被阻塞** |

`pty` 臂与 `on` 臂的差**只有一个自变量**：app-server 自己的 fd 0 是不是真终端。
两支读数一致 ⇒ 那一格不是自变量，厂商那句门禁作用在**客户端**（回帧那一侧）。

## 产物

```
probe/dumps/v11/arm-<臂>.jsonl            该臂的原始帧（逐行原文）
probe/dumps/v11/arm-<臂>.result.txt       该臂工作区 result.txt 的原样快照（判据 ④ 的物证）
probe/dumps/v11/codex-ask-user-stdin.json 汇总与逐臂判定
```

## 跑不动时先看这里

| 症状 | 先怀疑 |
|---|---|
| 启动即抛「缺网关凭据」 | 看它点名缺哪一个环境变量；本探针**只从环境变量读**，不读 `~/.aieval/config.json` |
| 所有臂 `turnStatus=null` 且 `askRequestCount=0` | 网关没通（`--relay` 那几行会打 `fetch failed`）；先 `--relay=false` 直连对照 |
| `pty` 臂被跳过 | 打印里给了原因：缺 python3，或 pty 分配被宿主策略拒（`openpty: Operation not permitted`，容器/受限沙箱下常见） |
| 工具表里**总是**有 `request_user_input` | 这是 0.156.1 的现状（见 `REPORT.md` 的 AU-07 静态证据 ⑥），不是探针漏了开关——开关之间到底差不差，看 `toolTable.instructionsChars` 与 `instructionsHasAskUser` 两格 |
