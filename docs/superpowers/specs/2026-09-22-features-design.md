# AI 生成代码评测工具 —— 功能设计

日期：2026-09-22
状态：待评审
前置：`docs/superpowers/specs/2026-09-22-scaffold-design.md`（脚手架设计）
性质：本文档**自包含**，覆盖三个功能域（用例 / 评测 / 设置）的完整行为、数据模型、执行时序与错误处理。技术栈、分包结构、界面原语的实现契约见脚手架设计文档，本文不重复。

---

## 1. 要解决的问题

比较不同模型与智能体写代码的能力，目前只能靠零散的对话记录和主观印象，缺少可复现、可横向对比的依据。

本工具固定「同一道题 + 同一起点」，让每个候选（模型 × 智能体）在隔离的工作区里各自独立完成一遍，再用同一把尺子打分，最后并排比较。

成功标准：

1. 固定用例（仓库 + commit + 考题提示词）后，任意候选的产出可被完整复现与追溯。
2. 一轮评测里多个候选的结果可直接横向比较：分数、token、轮次、耗时、代码改动四者可对照。
3. 一次评测从创建到出分，除「配置供应商」外无需人工干预。
4. 候选跑失败时，失败原因在界面上可读、可定位（日志 + 错误信息），且不影响其他候选。

非目标（本期明确不做）：分布式执行、多用户与权限、云端仓库与凭据管理、自动合并或改进被测代码、历史评测的趋势统计。

---

## 2. 本阶段范围

在脚手架（monorepo、分包、界面原语、主题、列表 + 右栏形态）之上实现三个功能域：

| 域 | 内容 |
|---|---|
| **用例管理** | 用例 CRUD、仓库与 commit 校验、AI 生成评分提示词 |
| **评测管理** | 创建评测（候选行 × 执行模式）、执行编排、实时进度、产物查看（日志 / diff / 评分） |
| **设置** | 模型供应商（含协议类型与模型清单）、评分配置、工作区目录、界面主题 |

脚手架阶段的 `/demo` 示例页在真实用例页落地后**删除**。

---

## 3. 功能域关键决策与理由

工程与界面层面的决策见脚手架设计文档。以下是**功能语义**层面的决策：

| # | 决策 | 理由 | 被否决的替代 |
|---|---|---|---|
| F1 | 供应商分 `openai` / `anthropic` 两种协议类型 | Anthropic **没有 `/models` 接口**，模型名硬编码；而 Claude Code 只认 Anthropic 协议。协议类型是「模型能否驱动某智能体」的唯一判据 | 全放开、运行时再报错（用户在等待十分钟后才发现配错） |
| F2 | 模型下拉框**按协议类型过滤**：选中的智能体决定哪些供应商的模型可选 | 不可行的组合在创建阶段就消失，而不是等到运行时炸 | 不过滤（体验差，且错误信息难以理解） |
| F3 | 评分走**纯文本 API**，不入仓库、不跑 agent | 成本低、快、完全可复现；评分阶段的随机性被消除 | 评分也用 agent 会话（更贵更慢且引入随机性）；混合升级路径（两条路都要实现） |
| F4 | 得分 = 固定 5 维度（各 1–5 分，等权）+ 总分 + 每维理由 + 总评 | 多候选可比、可追溯差在哪 | 单一总分 + 自由评语（无法追溯）；用例内自定义维度（本期表单过重） |
| F5 | 评分者 = 全局默认（设置页）+ 用例可选覆盖 | 多数时候固定一个强模型当尺子；特殊用例可单独换 | 每用例必填（重复配置，横向比较时因尺子不同而失真）；只允许全局（换尺子会断掉历史可比性） |
| F6 | 每候选行**独立工作区**，串行模式下也如此 | 串行若共用一个目录，第二个 agent 是在第一个 agent 的改动之上继续写，分数无意义、整轮作废 | 共享一份克隆、各建分支（`git checkout` 是全局状态，并发时会互相破坏工作树） |
| F7 | 用例级**本地缓存仓库**，每行从缓存复制 | 把「每次评测都克隆」变成「首次克隆、之后复制」，让开一轮评测从等待变成秒开 | 每行独立 `git clone`（网络开销重复 N 次） |
| F8 | 每候选行注入**独立配置目录**（`CLAUDE_CONFIG_DIR` / `CODEX_HOME` / `DSH_HOME`） | 并行时多个 agent 会抢同一份 `~/.claude`、`~/.codex` 配置与会话文件；且 `~/.claude/settings.json` 的 `env` 块会**盖掉**我们注入的模型路由 | 共享默认配置目录（模型路由随机失效） |
| F9 | 执行模式（并行/串行）落库，**运行中不可改** | 中途切换会让 `skipped` 语义混乱；且「这一轮用什么模式跑的」本身是复现条件 | 运行中可改 |
| F10 | 服务重启时运行中的行标记 `interrupted`，**不自动续跑** | agent 子进程已随服务消失，续跑需要独立进程托管，成本远超收益 | 断点续跑；乐观假设（状态错乱） |
| F11 | 全量产物：执行日志流 + diff 浏览器 + 评分详情 | 既是「为什么得这个分」的证据，也是排障手段 | 只存分数与元数据（debug 靠猜） |
| F12 | 每行**独立超时**（默认 30 分钟）+ **失败隔离** | 并行不限并发会抢 CPU 与配额，最先触发的通常是限流；没有独立超时与失败隔离，一行卡死会拖垮整轮 | 全局超时（一行卡住全轮停摆）；无超时（跑飞了只能手工终止） |
| F13 | 持久化用**磁盘文件**（JSON + JSONL 事件日志），不引入数据库 | 数据量小、查询简单（按 id 取 + 列列表）；JSON 文件人可读、可手工检查 | 内存态（重启即丢，跑了半小时的评测白费）；SQLite/Prisma（查询能力用不上，多一层迁移成本） |
| F14 | 事件日志是执行的**唯一真相源**，SSE 由它扇出 | 刷新页面 = 重读日志 + 按序号续订，天然不丢事件、可回放；不需要额外的进度存储 | 单独维护一份进度状态（两份真相必然漂移） |

---

## 4. 功能模块一：用例管理

### 4.1 页面形态

`/cases` 页 = 列表 + 右侧栏（用脚手架提供的 `ListDetailLayout`）。

**列表**：`Table` 列 = 标题 / 仓库名 / commit 短哈希（7 位，`EllipsisText` + `Tooltip` 显全量）/ 更新时间。右上「创建用例」。空态用 `EmptyState` 引导到「创建用例」。

**右栏三种内容**（同一个栏位换内容，不叠加、不弹层；由 `?panel=detail|new|edit&id=...` 决定）：

| 右栏内容 | 触发 |
|---|---|
| 用例详情（只读）+「编辑」「删除」 | 点列表行 |
| 创建表单 | 点「创建用例」 |
| 编辑表单（同创建，预填） | 详情栏点「编辑」 |

### 4.2 表单字段

| 字段 | 控件 | 校验与行为 |
|---|---|---|
| 标题 | `Input` | 必填 |
| 考题提示词 | `Input.TextArea`（等宽字体） | 必填 |
| 评分提示词 | `Input.TextArea` + 「AI 生成」按钮 | 生成后仍可手改；保存时必填 |
| 代码仓库 | `Input`（本地绝对路径）+ 「校验」按钮 | 服务端 `git rev-parse --is-inside-work-tree`；通过后回显仓库名与当前分支。**只支持本地目录**，不做远端 URL 与凭据管理 |
| commit hash | `Input` + 候选下拉 | 留空 = 默认分支 `HEAD`；填了必须 `git cat-file -e <hash>^{commit}` 通过 |
| 默认评分模型 | `Select`（按供应商分组，**两种协议的模型都可选**） | 可留空 = 用设置页的全局默认 |

**commit 候选下拉**：`Input` 旁边给一个下拉，列出最近 20 条提交（`git log --format='%h %s' -n 20`），选中即填入短哈希。纯便利功能——**手工输入任意合法 hash 必须仍然可行**（不能只允许从候选里选）。

### 4.3「AI 生成评分提示词」

| 项 | 约定 |
|---|---|
| 调用对象 | 全局评分模型（或本用例已选的评分模型）。**非流式** |
| 输入 | 考题提示词 + 仓库名 + 固定 5 维度的定义 |
| 输出 | 严格 JSON `{ "prompt": string, "dimensions": [...] }` |
| 回填 | `prompt` → 评分提示词文本框；`dimensions` → 表单下方**只读预览**本用例将采用的维度 |
| 失败处理 | **不清空已有内容**，以 `message.error` 呈现原因（网络 / 限额 / JSON 不合法） |

**生成的提示词必须自带输出契约**：明确要求评分模型只输出一个 JSON，字段为 5 个维度各 1–5 分 + 每维理由 + 总分 + 一句话总评，不得输出 JSON 以外的任何文字。这是为了与评分解析代码的契约对齐——否则会出现「模型回了一段散文、解析失败」。

**未配置评分模型时**：按钮禁用，`Tooltip` 说明「请先到设置里配置默认评分模型」。

### 4.4 删除用例

`Popconfirm` 确认。若该用例已被评测引用：

- 提示将同时影响 N 个评测（列出数量，不阻塞删除）；
- 已完成的评测记录**保留**（评测里冗余存仓库路径与 commit，不依赖用例仍存在，见 §7.2）；
- 用例级本地缓存仓库（`{workspaceRoot}/cases/{caseId}/cache`）一并删除。

---

## 5. 功能模块二：评测管理

### 5.1 创建评测（右栏表单）

| 字段 | 控件 | 行为 |
|---|---|---|
| 用例 | `Select` | 选项显示「标题 · 仓库名 · commit 短哈希」；必填 |
| 执行模式 | `Radio.Group`：并行 / 串行 | 必填，默认**并行** |
| 候选行 | `Form.List` 动态增减 | 每行两个 `Select`：智能体（Claude Code / Codex / DeepSeek Harness）+ 模型 |

**模型的候选池按协议类型过滤**（F2）：

- 选 `Claude Code` → 只列 `anthropic` 协议供应商的模型。
- 选 `Codex` / `DSH` → 只列 `openai` 协议供应商的模型。
- 自动拉取（`source: 'fetched'`）与手工维护（`source: 'manual'`）的模型用 `Tag` 区分来源。
- 过滤后无可选项时，该行立即内联 `Alert` 说明原因与出路（如「Claude Code 需要 Anthropic 兼容协议的供应商，请先到设置里添加」），而不是让人选完到运行时才失败。

**提交校验**：至少一行；每行两个 `Select` 均已选；执行模式已选。

**创建后即落库**（状态 `idle`），不自动开跑——「开始」是评测详情页的显式动作。

### 5.2 执行模式

| 模式 | 行为 |
|---|---|
| **并行** | 所有候选行同时开跑，不设并发上限 |
| **串行** | 一行跑完（含评分）才起下一行 |

**串行不是「共用一个工作目录」**：每候选行依然有独立工作区（F6）。串行省的是 CPU 与供应商配额，不省工作区。靠用例级本地缓存（F7），每行复制是秒级的。

**并行模式的风险与对应**：不限并发会同时抢 CPU 与供应商配额，最先触发的通常是限流而不是机器瓶颈。因此每行必须有**独立超时**（`settings.rowTimeoutMs`，默认 30 分钟）与**失败隔离**（F12）。

**执行模式随评测落库，运行中不可改**（F9）。

### 5.3 列表 + 详情

**列表**列：用例标题 / 状态 / 候选数 / 执行模式 / 创建时间。

**详情（右栏）**：

- **顶部信息行**：用例标题 · 仓库路径 · commit（短哈希 + `Tooltip` 全量）· 工作基目录。
- **串行模式下的进度**：`3/6 已完成`。
- **候选卡片列表**，每行一张 `Card`：

```
┌────────────────────────────────────────────┐
│ Claude Code · claude-opus-4-6      [已评分] │
│ 分支 test/ab12cd34                          │
│ tok 128,450   轮次 17   耗时 6m23s   得分 87│
│ ────────────────────────────────────────── │
│ [查看日志] [查看改动] [评分详情]     [终止] │
└────────────────────────────────────────────┘
```

- 运行中实时刷新 token 累计、轮次、耗时（SSE 推送，不轮询）。
- 出分后按总分排序，前三名带排名徽标。
- 三个查看按钮各开一个 `Drawer`：
  - **执行日志**：流式追加、可自动滚底、可下载。
  - **代码改动**：三样合并（见 §5.5 第 6 步），含文件树与统一 diff 视图。
  - **评分详情**：5 维度评分条 + 每维理由 + 总评 + 原始返回。
- 串行模式下等待中的卡片显示「串行排队中：前一行结束后自动开始」。
- diff 被截断时（见 §5.5 第 7 步）卡片上标注「diff 已截断」。

**吸底操作栏** `Layout.Footer`：

| 按钮 | 语义 | 禁用条件 |
|---|---|---|
| **开始** | 执行所有**未完成**的行（`pending` + `failed` + `timed-out` + `canceled` + `interrupted` + `skipped`） | 存在运行中的行；或没有可执行的行 |
| **终止** | 杀掉所有在跑的 agent 子进程 | 无运行中的行 |

- 「开始」触发 `Modal.confirm`，列出本次将执行的候选清单（避免误点跑掉几十分钟）。
- 「终止」用 `Popconfirm`——它杀进程，不可撤销。
- **候选卡片内另有「终止」**（仅对运行中的该行可见）：全开并发下，某一行明显跑歪却要等它超时才腾资源，体验很差。

### 5.4 每候选行状态机

```
pending → preparing → running → (agent 完成) → judging → judged
                 ↘ failed / timed-out / canceled
串行被终止时未轮到的行 → skipped
服务重启时仍在运行的行 → interrupted（不自动续跑）
```

状态语义必须可区分，不能合并：

| 状态 | 含义 |
|---|---|
| `canceled` | 用户按了终止，当时**正在跑**的行 |
| `skipped` | 串行模式下用户终止时**还没轮到**的行 |
| `timed-out` | 超过 `rowTimeoutMs` 被强制终止 |
| `failed` | agent 进程非零退出 / 启动失败 / 评分调用失败 |
| `interrupted` | 服务重启时该行仍在运行 |

### 5.5 一轮评测的内部时序

```
1. 建工作区      {workspaceRoot}/{runId}/rows/{rowId}/workspace/
2. 取基线        从 {workspaceRoot}/cases/{caseId}/cache 复制 → checkout {commit}
                → git checkout -b test/{rowId}
3. 注入隔离配置  CLAUDE_CONFIG_DIR / CODEX_HOME / DSH_HOME → {rowDir}/.agenthome/
                Claude 侧另加 settingSources: []（否则 ~/.claude/settings.json 的 env 盖掉模型路由）
4. 跑智能体      适配器统一接口；工作目录 = workspace；交考题提示词
5. 收集计量      token（输入/缓存/输出）、轮次、耗时、退出状态
6. 算 diff       git diff {commit}..HEAD + git diff HEAD + git status
7. 评分          评分提示词 + diff 正文 + 维度定义 → 评分模型（文本 API，非流式）→ 解析 JSON
8. 落盘          事件追加到 events.jsonl + 快照写入 run.json
```

**第 1 步的缓存准备**：用例级缓存 `{workspaceRoot}/cases/{caseId}/cache` 不存在时，先完整克隆一次（`git clone <repoPath> <cache>`，本地路径克隆很快）。这一步只在首轮评测时发生，之后所有候选行都从它复制。

**第 2 步为什么是复制而不是每行克隆**：`git clone <本地路径>` 仍是完整对象复制，每次都要重新打包传输。对每行改用**文件系统级目录复制**（缓存已是完整仓库，复制出的目录直接 `checkout {commit}` 即可），把每行准备时间从「克隆耗时」降到「磁盘复制耗时」。这是让「开一轮评测」秒开的关键。

**第 6 步必须同时取三样，缺一就会漏改动**：`git diff {commit}..HEAD` 只见已提交的改动；**agent 完全可能改了代码而不提交**，只取它会给出一个空 diff 却照样打分。所以还要 `git diff HEAD`（已改未提交）与 `git status --porcelain`（未跟踪的新文件），三者合并才是候选的完整产出。

**第 7 步的 diff 需要体积上限**：`settings.diffBudgetBytes`（默认 256KB）。超出时按文件裁剪并在送给评分模型的内容里**显式标明「已截断」及被截断的文件清单**——否则评分模型会把「看不到的改动」当成「没改」，静默给出错误的高分。同时该行卡片上标注「diff 已截断」，让人知道这一次的分是在不完整输入下得出的。

**分支名 `test/{rowId}` 用行 id 而非轮 id**：同一用例下多候选如果共用一个分支名，会互相踩（`git checkout -b` 因分支已存在而失败，或被迫复用别人改过的分支）。

**所有实体 id（`runId` / `rowId` / `caseId` / `providerId`）都是 UUID v4**，由服务端在创建时生成；`rowId` 同时是分支名的组成部分，因此必须是文件系统与 git 引用名双安全的（UUID 满足）。

**候选行若在 `preparing` 阶段失败**（复制失败、分支已存在、commit 不存在），仍要落 `failed` 并保留错误详情，不能静默跳过。

### 5.6 智能体适配器

`agents` 包对外只暴露一个接口，三家实现差异全部吸收在适配器内：

```ts
interface AgentRunInput {
  agentKind: 'claude-code' | 'codex' | 'dsh'
  cwd: string                        // 工作目录（该行工作区）
  configHome: string                 // 独立配置目录
  prompt: string                     // 考题提示词
  route: { protocolType: ProtocolType; baseUrl: string; apiKey: string; modelId: string }
  timeoutMs: number
  signal: AbortSignal                // 终止用
  onEvent: (e: AgentEvent) => void   // 日志增量 / 用量 / 轮次 / 状态
}

interface AgentRunResult {
  ok: boolean
  exitReason: 'completed' | 'timeout' | 'canceled' | 'error'
  tokens: { input: number; cached: number; output: number } | null
  turns: number | null
  durationMs: number
  error?: { message: string; stack?: string }
}
```

三家适配器的落地要点：

| 智能体 | 入口 | 模型注入 | 计量来源 | 终止 |
|---|---|---|---|---|
| Claude Code | `@anthropic-ai/claude-agent-sdk` 的 `query()` | `options.model` + `env` 注入 `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` | `result` 消息的 usage | `AbortController` + `q.close()` |
| Codex | `@openai/codex-sdk` 的 `Codex` / `startThread` | `baseUrl` + `apiKey` + `thread.model` | `turn.usage`（输入/缓存/输出） | `AbortSignal` |
| DeepSeek Harness | `@deepseek-ai/dsh-sdk-client` 的 `DeepSeekHarness` | `provider` + `model` + `reasoningEffort` | 订阅事件流 | **关运行时**（wire 无 mid-turn cancel） |

**两个必须遵守的坑**：

1. Claude SDK 的 `env` 选项**整体替换**子进程环境（不与 `process.env` 合并），必须展开 `process.env` 补 `PATH`，否则子进程找不到 `node` 而 `spawn ENOENT`。
2. DSH 侧没有中途取消，终止只能关掉运行时进程——这是「终止」按钮在该行上的实现方式，不是缺陷。

**适配器必须可注入**：编排层依赖接口而非具体实现；测试与示例用 `fake` 适配器（脚手架阶段已建）。

### 5.7 评分器

```ts
interface JudgeInput {
  judgePrompt: string                // 用例的评分提示词
  diffText: string                   // 已按 diffBudgetBytes 裁剪并标注截断
  taskPrompt: string                 // 考题提示词（给评分模型提供题面上下文）
  dimensions: DimensionDefinition[]  // 固定 5 维
  route: { protocolType: ProtocolType; baseUrl: string; apiKey: string; modelId: string }
}
```

**解析必须防御三类最常见的翻车点**，且都有确定性单测：

1. 模型返回不合法 JSON；
2. JSON 被 markdown 围栏包裹（先剥离 ` ```json ` 与 ` ``` ` 再解析）；
3. 分数超出 1–5 范围或维度缺失（分数越界夹紧到区间；**维度缺失则该行 `failed` + `JUDGE_PARSE_FAILED`**，不允许「按缺的维度算平均」——那会静默给出偏高的分）。

解析失败时保留 `raw` 原文（截断到合理长度），日志抽屉可见，方便判断是提示词问题还是模型问题。

**总分合成**：`round(sum(score) / (5 * n) * 100)`，5 维满分 100。

---

## 6. 功能模块三：设置

`/settings` 页 = `Tabs` 四页。脚手架阶段只实现了「界面主题」一项，本阶段补齐其余三项。

### 6.1 模型供应商

`Table`（列：名称 / 协议类型 / API 地址 / 密钥掩码 / 模型数 / 操作）+ 「添加供应商」`Modal`：

| 字段 | 说明 |
|---|---|
| 名称 | 如「DeepSeek 官方」 |
| 协议类型 | `Radio`：OpenAI 兼容 / Anthropic 兼容 —— 决定它的模型能喂给哪些智能体 |
| API 地址 | baseURL，如 `https://api.deepseek.com/v1`（openai）或 `https://api.deepseek.com/anthropic`（anthropic） |
| API 密钥 | `Input.Password`；落盘后列表只显示掩码 |
| 模型清单 | 「拉取模型」→ `GET {baseUrl}/models`；**Anthropic 协议下该按钮禁用并提示「该协议无 /models 接口，请手工维护」**。可手工增删 |

**拉模型的两个实现要点**：

1. 请求照 `Authorization: Bearer <key>` 发；响应解析 `data[].id`。**不同供应商返回的字段名不完全一致**，解析时同时容忍 `data` 为字符串数组的形式。
2. **拉取结果是合并而非覆盖**：手工添加的模型必须保留（`source: 'manual'` 的条目不被 `fetched` 结果冲掉），否则用户手工补的模型每次拉取都会丢。

**密钥的安全取舍**（必须写进代码注释）：服务端需要原 token 才能代调供应商 API，无法只存哈希；缓解措施是配置文件写盘后 `chmod 0600`（属主独占）+ 对外出口一律掩码。Windows 无 POSIX 权限位，`chmod` 仅能近似切换只读位，属主独占实际由 NTFS ACL 与用户目录隔离承担——尽力而为、失败不报错、不阻断保存。

### 6.2 评分配置

- **默认评分模型**：按供应商分组的 `Select`；候选池**覆盖两种协议**（评分走文本 API，不依赖智能体，故两边都可用）。未配置时用例页的「AI 生成评分提示词」与评测的评分步骤都不可用，界面需明确提示去向。
- **输出契约预览**（只读）：展示 5 维度与等权合成规则，让人知道分数怎么来的。
- **行超时**（`rowTimeoutMs`）：`InputNumber`，默认 30 分钟。
- **diff 上限**（`diffBudgetBytes`）：`InputNumber`，默认 256KB。

后两项放在这一页而不是单独的「高级」页：它们都直接决定「一次评分拿到什么输入、一轮能跑多久」，与评分语义是一件事。

### 6.3 工作区

| 字段 | 说明 |
|---|---|
| 工作区根目录 | `Input` + 「校验」按钮；默认 `~/.runs`；服务端校验「可写 + 可创建子目录」后保存 |

目录结构：

```
{workspaceRoot}/
├── cases/{caseId}/cache/            # 用例级本地缓存仓库（首次评测时克隆一次）
└── {runId}/rows/{rowId}/
    ├── workspace/                   # 该候选行的工作副本（独立分支 test/{rowId}）
    ├── .agenthome/                  # 该候选行的智能体独立配置目录
    └── events.jsonl                 # 该行的执行事件日志
```

**校验必须真建目录再删**（只检查父目录是否存在不够——磁盘满、无权限、路径过长都会在真正写入时才失败）：

1. `~` 展开为 `os.homedir()`；
2. 尝试 `mkdirSync(root, { recursive: true })`；
3. 在 root 下建一个随机名子目录再删除，确认「可创建子目录」；
4. 任一步失败 → `NOT_WRITABLE` + 具体原因（含失败路径）。

**改动根目录时不动已有数据**：已完成的评测产物留在旧根目录下，不自动迁移；界面对历史评测显示其 `workspaceBase` 实际路径，避免「改了设置后找不到旧产物」。

### 6.4 界面主题

三档 `Segmented`：跟随系统（默认）/ 明亮 / 暗色。落地口径（三个消费点必须同步）见脚手架设计文档。

---

## 7. 数据模型与持久化

### 7.1 存储位置

```
~/.aieval/config.json          # 应用设置（主题、工作区根目录、默认评分模型、行超时、diff 预算）
~/.aieval/providers.json       # 供应商（含 API 密钥，仅本机）
~/.aieval/cases.json           # 用例
{workspaceRoot}/...            # 工作区与运行产物（见 §6.3）
```

配置目录由环境变量覆盖以便测试：`AIEVAL_CONFIG_DIR` > `~/.aieval`。原子写、UTF-8 BOM 容忍、权限收紧、缺失字段归一化等口径由脚手架的 `config-store` 统一承载。

### 7.2 契约（`packages/server/contracts`，zod schema）

```ts
type ProtocolType = 'openai' | 'anthropic'

type Provider = {
  id: string
  name: string
  protocolType: ProtocolType
  baseUrl: string
  apiKey: string                                    // 写盘明文，下行只给掩码
  models: { id: string; source: 'fetched' | 'manual' }[]
  createdAt: string
  updatedAt: string
}

type TestCase = {
  id: string
  title: string
  repoPath: string
  commitHash: string | null                         // null = 默认分支 HEAD
  taskPrompt: string
  judgePrompt: string
  judgeProviderId: string | null                    // null = 用全局默认
  judgeModelId: string | null
  createdAt: string
  updatedAt: string
}

type ExecutionMode = 'parallel' | 'serial'

type EvalRun = {
  id: string
  caseId: string
  /** 冗余快照：用例被删除后仍能追溯这一轮测的是什么（见 §4.4） */
  caseTitle: string
  repoPath: string
  commitHash: string | null
  status: 'idle' | 'running' | 'partial' | 'done'
  executionMode: ExecutionMode
  rows: EvalRow[]
  workspaceBase: string
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
}

type EvalRowStatus =
  | 'pending' | 'preparing' | 'running' | 'judging' | 'judged'
  | 'failed' | 'timed-out' | 'canceled' | 'skipped' | 'interrupted'

type EvalRow = {
  id: string
  agentKind: 'claude-code' | 'codex' | 'dsh'
  /** 冗余快照：供应商被改名或删除后仍能追溯这一行用的什么模型 */
  providerName: string
  baseUrl: string
  modelId: string
  status: EvalRowStatus
  branch: string                                    // test/{rowId}
  workspacePath: string
  tokens: { input: number; cached: number; output: number } | null
  turns: number | null
  durationMs: number | null
  diff: { filesChanged: number; insertions: number; deletions: number; truncated: boolean } | null
  score: ScoreResult | null
  error: { message: string; stack?: string } | null
}
```

**两处刻意的冗余快照**：`EvalRun` 存 `caseTitle` / `repoPath` / `commitHash`，`EvalRow` 存 `providerName` / `baseUrl`。理由：评测记录的价值在于「可追溯」，如果它只存外键，那么删掉一个用例或改掉一个供应商的名字，历史评测就再也说不清当时测的是什么。冗余的是**展示与追溯所需的只读快照**，不是可变配置。

`EvalRow.diff` 只存**计数摘要**（供卡片显示），不存 diff 正文——正文在打开「代码改动」抽屉时由 `api` 按需现场计算（见 §8 路由表）。理由：一轮评测的 diff 正文可达数 MB，预先落库既慢又占空间，而它只在有人看的时候才需要。

所有时间字段（`createdAt` / `updatedAt` / `startedAt` / `finishedAt` / `judgedAt` / 事件的 `at`）统一为 **ISO 8601 带时区的字符串**（如 `2026-09-22T10:30:00.000Z`），不用 epoch 数字——落盘文件需要人可读，也避免时区歧义。

```ts
type DimensionKey = 'correctness' | 'requirement' | 'quality' | 'robustness' | 'maintainability'

type ScoreResult = {
  dimensions: { key: DimensionKey; label: string; score: 1 | 2 | 3 | 4 | 5; reason: string }[]
  totalScore: number                                // 5 维等权均值映射到 0–100
  verdict: string
  raw: string                                       // 模型原始返回，排障用
  judgeProviderId: string
  judgeModelId: string
  judgedAt: string
}

type Settings = {
  theme: 'auto' | 'light' | 'dark'
  workspaceRoot: string                             // 默认 ~/.runs（见 §6.3）
  defaultJudge: { providerId: string; modelId: string } | null
  rowTimeoutMs: number                              // 默认 1_800_000（30 分钟）
  diffBudgetBytes: number                           // 默认 262_144（256KB），送评分模型的 diff 上限
}
```

### 7.3 默认评分维度（固定，本期不可自定义）

| key | 中文标签 |
|---|---|
| `correctness` | 功能正确性 |
| `requirement` | 需求完成度 |
| `quality` | 代码质量 |
| `robustness` | 健壮性与边界 |
| `maintainability` | 可维护性（改动范围合理） |

每维 1–5 分整数，**等权**。总分 = `round(sum(score) / (5 * n) * 100)`，即 5 维满分 100。

### 7.4 事件日志是执行的唯一真相源

每候选行的 `events.jsonl` 每行一个带单调序号的事件：

```ts
type AgentEvent =
  | { seq: number; at: string; type: 'status'; status: EvalRowStatus }
  | { seq: number; at: string; type: 'log'; stream: 'stdout' | 'stderr'; text: string }
  | { seq: number; at: string; type: 'usage'; tokens: { input: number; cached: number; output: number }; turns: number }
  | { seq: number; at: string; type: 'diff-summary'; filesChanged: number; insertions: number; deletions: number; truncated: boolean }
  | { seq: number; at: string; type: 'score'; score: ScoreResult }
  | { seq: number; at: string; type: 'error'; message: string; stack?: string }
  | { seq: number; at: string; type: 'end'; exitReason: string }
```

- 正在跑的进程往这个流里追加，`api` 扇出成 SSE；前端订阅。
- 刷新页面 = 重读日志 + 按 `seq` 续订（`Last-Event-ID` 语义），因此**不丢事件、可回放**。
- 服务重启时，把仍处 `running` / `preparing` / `judging` 的行标记 `interrupted`（F10）。

---

## 8. 路由与前端接入

本阶段新增的 Route Handlers（每个只做「zod 校验 → 调 api → 错误映射」）：

```
api/
├── providers/route.ts
├── providers/[providerId]/route.ts
├── providers/[providerId]/models/route.ts
├── providers/[providerId]/models/fetch/route.ts
├── cases/route.ts
├── cases/[caseId]/route.ts
├── cases/[caseId]/validate-repo/route.ts
├── cases/[caseId]/commits/route.ts
├── cases/generate-judge-prompt/route.ts
├── runs/route.ts
├── runs/[runId]/route.ts
├── runs/[runId]/start/route.ts
├── runs/[runId]/abort/route.ts
├── runs/[runId]/rows/[rowId]/abort/route.ts
├── runs/[runId]/rows/[rowId]/diff/route.ts     # 按需算，不预先落库
├── runs/[runId]/rows/[rowId]/stream/route.ts   # SSE：状态/日志/用量/评分/错误
└── runs/[runId]/rows/[rowId]/log/route.ts      # 一次性拉全量日志（抽屉首帧 + 下载）
```

`stream` 是唯一的实时通道，承载 §7.4 定义的全部事件类型，不另开第二个 SSE 端点。

| 页面 | 数据来源（`client` 包的 hooks） |
|---|---|
| `/cases` | `useCases()` / `useTestCase(id)` / `useCreateCase()` / `useUpdateCase()` / `useDeleteCase()` / `useValidateRepo()` / `useCommitCandidates()` / `useGenerateJudgePrompt()` |
| `/runs` | `useRuns()` / `useRun(id)` / `useCreateRun()` / `useStartRun()` / `useAbortRun()` / `useAbortRow()` / `useRowDiff()` / `useRowLog()` |
| `/runs`（实时） | `useRowStream(rowId)`：SSE 订阅，按 `seq` 续订 |
| `/settings` | `useSettings()` / `useProviders()` / `useProviderModels()` / `useFetchModels()` / `useValidateWorkspaceRoot()` |

**SSE 订阅 hook 的行为要求**：

1. 首帧先拉 `/log` 补全历史（抽屉打开时才有必要），再按 `Last-Event-ID` 接 `/stream`；
2. 断线自动重连（浏览器 `EventSource` 自带，但要处理重连后的事件重复——按 `seq` 去重）；
3. 行进入终态（`judged` / `failed` / `timed-out` / `canceled` / `skipped` / `interrupted`）后关闭连接并 `mutate` 一次快照，确保列表状态与日志一致。

**列表页的实时性**：`/runs` 列表用 SWR 的 `refreshInterval`（有评测在跑时 3 秒一次，否则关闭）。逐行 SSE 只在该行详情可见时才订阅——否则 10 个候选 × 多个评测会开出几十条长连接。

---

## 9. 测试

| 对象 | 测试 |
|---|---|
| `core` 的 git 原语 | **真实 git CLI**，禁 mock（mock 掉的正是最容易错的地方）：校验仓库、`cat-file -e` 判定 commit、克隆缓存、文件系统级复制、建分支、三样 diff 合并 |
| 三样 diff 合并 | 用例覆盖：只有已提交改动 / 只有未提交改动 / 只有未跟踪新文件 / 三者都有 / 全空。**「只取 `commit..HEAD` 会漏掉未提交改动」必须有回归用例** |
| 适配器 | 用假实现（脚手架已建）：产生确定的日志流、用量、退出码；三家的模型注入参数（`env` 是否补了 `PATH`、`baseUrl`/`model` 是否落到正确字段）用断言锁定 |
| 评分解析 | 三类翻车点各一个用例：非法 JSON、markdown 围栏包裹、分数越界或维度缺失。**维度缺失必须 `failed` 而非按缺项算平均** |
| diff 裁剪 | 超 `diffBudgetBytes` 时按文件裁剪，且输出里含「已截断」标记与被截断文件清单 |
| 编排时序 | 串行下断言「同一时刻只有一个 adapter 在跑」；并行下断言「全部同时启动」；终止时断言 `canceled` 与 `skipped` 的划分正确 |
| 工作区隔离 | 串行模式下断言每行工作目录互不相同（**防回归到「共用目录」这个致命错误**） |
| 服务重启恢复 | 启动时把 `running`/`preparing`/`judging` 的行标 `interrupted`，且不误伤终态行 |
| 拉模型合并 | `fetched` 结果不冲掉 `manual` 条目 |
| 工作区校验 | 只读目录 / 不存在的盘符 / 路径过长 → `NOT_WRITABLE` + 具体原因 |
| 用例删除 | 已完成的评测记录保留，`caseTitle`/`repoPath`/`commitHash` 快照仍可读 |

**冒烟**（真实起服务 :3083，浏览器逐项操作 + CLI 复核 git 事实）：

1. 建两个供应商（一个 openai 协议、一个 anthropic 协议），拉模型；
2. 建用例：填标题、考题提示词、点「AI 生成」产出评分提示词、校验本地仓库、填 commit；
3. 建评测：选该用例、选**并行**、加 2 行（一行 Claude Code + anthropic 模型，一行 Codex + openai 模型）；
4. 点开始，观察两行同时进入 `running`，token / 轮次 / 耗时实时跳动；
5. 用 CLI 复核：两个候选行的工作目录里 `git branch` 确实有 `test/{rowId}`，`git diff` 结果与页面「查看改动」一致；
6. 出分后核对：卡片总分与「评分详情」里 5 维分一致，总分等于 `round(sum/(5*5)*100)`；
7. 再建一个**串行**评测（3 行），中途点终止 → 断言当前行 `canceled`、未轮到的行 `skipped`；
8. 点开始 → 断言只跑未完成的行，已 `judged` 的行不重跑；
9. 故意把评分模型配成一个不存在的模型 → 断言该行 `failed` 且错误信息可读，其余行不受影响。

**成本护栏**：开发期用最小 diff 的仓库（几个文件的示例项目）与最短提示词做端到端验证；真实模型调用集中在第 3–9 项冒烟，不复跑。

---

## 10. 错误处理

| 场景 | 处理 |
|---|---|
| 仓库路径非法 / 不是 git 仓库 | 表单校验期拦截，`NOT_A_GIT_REPO` + 具体原因 |
| commit hash 不存在 | 表单校验期拦截，`INVALID_REF` |
| 供应商 `/models` 拉取失败 | 保留已手工维护的清单；`message.error` 呈现原因；不阻断保存 |
| 供应商密钥无效 | `AUTH_FAILED`（context 带 host）；该行 `failed`，错误信息指向设置页 |
| 供应商限流 | `RATE_LIMITED`；该行 `failed`，错误信息建议改用串行 |
| 评分模型返回不合法 JSON | 该行 `failed` + `JUDGE_PARSE_FAILED`，保留 `raw` 原文，日志抽屉可见 |
| 评分维度缺失 / 分数越界 | 分数越界夹紧；维度缺失 → `failed` + `JUDGE_PARSE_FAILED` |
| agent 进程超时 | 该行 `timed-out`，强制终止子进程，其余行不受影响 |
| agent 进程启动失败 | 该行 `failed` + `AGENT_FAILED`（如 CLI 未安装、`spawn ENOENT`） |
| 工作区根目录不可写 | 设置页校验期拦截，`NOT_WRITABLE` |
| 分支已存在（`test/{rowId}` 冲突） | 用 UUID 行 id 已避免；仍冲突则先删旧分支再建，并记 WARN |
| 用例被删除但评测仍在 | 允许；评测靠冗余快照继续可读（§7.2） |
| 服务重启打断评测 | 运行中的行 → `interrupted`，界面提示「可点开始重跑这些行」 |
| 配置文件损坏 / 带 BOM | 由 `config-store` 处理（BOM 剥离；真损坏抛含路径的中文原因） |

---

## 11. 实施顺序

依赖脚手架完成（见脚手架设计文档的完成标准）。

1. **`contracts` 扩全**：Provider / TestCase / EvalRun / EvalRow / ScoreResult / AgentEvent 的 zod schema 与本阶段新增错误码。
2. **`core` 扩展**：git 原语（校验仓库、`cat-file -e`、克隆缓存、文件系统级复制、建分支、三样 diff 合并）、工作区目录管理。
3. **设置域**：供应商 CRUD + `/models` 拉取（合并而非覆盖）、评分配置、工作区校验。**这一域先做**——用例的「AI 生成评分提示词」与评测的评分都依赖它。
4. **用例域**：CRUD、仓库与 commit 校验、commit 候选下拉、AI 生成评分提示词。删除 `/demo` 示例页，用例页接上真实数据。
5. **`agents`**：三家适配器实现 + 模型注入参数断言（假实现已在脚手架建好）。
6. **`evaluator`**：编排状态机（并行/串行）、事件日志扇出、评分器与解析、超时与终止、服务重启恢复。
7. **评测域**：创建、列表 + 右栏详情、SSE 实时刷新、吸底操作栏、三个产物抽屉。
8. **冒烟与文档**：按 §9 的 9 项冒烟清单走完并留证，写使用手册。

---

## 12. 澄清结论（本次设计已确定的全部开放问题）

无遗留待定项。

| 问题 | 结论 |
|---|---|
| 评分回路 | 纯文本 API，diff + 提示词 → JSON 分数 |
| 得分形态 | 固定 5 维度各 1–5 分（等权）+ 总分 + 每维理由 + 总评 |
| 评分者 | 全局默认（设置页）+ 用例可选覆盖 |
| 维度 | 本期固定 5 维，维度的自定义留待后续 |
| 并发 | 并行/串行**二选一**，创建评测时配置，默认并行；并行不设并发上限 |
| 执行模式可否运行中修改 | 不可修改 |
| 串行未轮到的行 | 新增 `skipped` 状态 |
| 仓库来源 | 本地目录路径，不做远端 URL 与凭据管理 |
| 产物 | 全量：执行日志流 + diff 浏览器 + 评分详情 |
| 单行终止 | 要 |
| 用例级缓存仓库 + 每行复制 | 认可 |
| 默认落地页 | `/runs` |
| 用例创建/编辑形态 | 可拖拽宽度的右边栏（不是抽屉、不是整页） |
| 工作区根目录 | 默认 `~/.runs`，设置页可配 |
| 应用数 | 单个 Next.js 应用，无第二个下游应用 |
