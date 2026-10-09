# 数据与存储

## 定位

平台全部落盘事实的地图：配置、评测产物、事件日志各落在哪、怎么写、坏了怎么读。核心纪律：**写盘必须原子、读盘必须容忍、损坏必须说人话**。

## 页面形态与交互

存储位置一览：

| 数据 | 位置 |
|---|---|
| 平台配置 | `AIEVAL_CONFIG_DIR` > `~/.aieval` |
| 评测落盘根 | `settings.workspaceRoot`（默认 `~/.aieval-runs`） |
| 一轮评测 | `{workspaceRoot}/{runId}/`：`run.json`（行快照）+ `rows/{rowId}/`（`events.jsonl` + `messages.jsonl` + `workspace/` + `.agenthome/` / `.judgehome/`） |
| 用例镜像缓存 | 用例级 `cases/{caseId}/cache/`（文件系统级目录复制，不是每行克隆） |

## 数据与契约

- **`run.json`**（行快照）：`EvalRow` 含状态、分数（`ScoreResult` 12 格，记账格全 `.default(...)`——`safeParse` 读盘的硬理由）、diff、计量。旧 `run.json`（带 `dimensions`）`safeParse` 失败 ⇒ `listRuns` **跳过并落汇总 WARN**（不炸整页）。快照与事件同源：`setRowStatus` 改状态 + 落盘 + 追加 `status` 事件**成对**。
- **`events.jsonl`**（行级事件，执行的唯一真相源）：追加写、`seq` 单调递增、按 `seq` 去重续订（`Last-Event-ID`）。**读侧容忍坏行**：写一半的 JSON、空行只跳过该行并 WARN，其余按原序全量读出（可用性优先于完备性）。只有候选新尝试的 `resetEvents` 清空。
- **`messages.jsonl`**（内容通道）：按 `mergeKey` / `subagentId` 覆盖累积；四格计量**不在这份文件里**（走 `usage` 事件与 `EvalRow`）；一行都不产出时不建文件。
- **写盘必须原子**：写临时文件（创建即 `0600`）→ `renameSync` 覆盖。**不要先删目标再 rename**——中间崩溃会让配置彻底消失，而 `loadConfig()` 会静默回落默认值。
- **rename 的 `EPERM` 有两种成因、处置相反**：目标是只读文件（只能先删）与杀软瞬时占用（重试即可）。判据 `statSync(file).mode & 0o200`，别无脑先删。
- **读盘必须容忍 UTF-8 BOM**（PowerShell 5.1 的 `Set-Content` / `ConvertTo-Json` 默认带 BOM，`JSON.parse` 遇到就抛）；自己落盘不要产 BOM。
- **配置损坏时抛含路径的中文原因**，别让 `SyntaxError` 冒充「请求体不是合法 JSON」。
- 测试隔离：`setConfigDirForTesting(dir)` 指向临时目录，**不得触碰真实 `~/.aieval`**。

## 状态机与时序

- 评测的写盘点：事件追加 `events.jsonl`（每事件一条，`at` 是本项目写入时间）+ 快照写 `run.json`（每次状态变更）。`usage` 回写判据：`tokensBasis === 'reported'` 才写快照（`'estimated'` 只走事件流）。
- 服务重启：`recoverInterruptedRuns` 把仍处 `running` / `preparing` / `judging` 的行标 `interrupted`。
- 历史产物删除、不做读侧兼容（旧 v1 七型 `events.jsonl` 整轮目录不提供读入口）；契约新增**可选**格例外——读侧把「键缺席」与显式 `null` 当同一件事。

## 已知边界与取舍

| 边界 | 处置 |
|---|---|
| `events.jsonl` 的追加读是 O(n²) 重放（每次追加整文件回读定 `seq`） | 已登记的取舍：单行 > 5 MB 或 > 2 万条时复测一次 |
| `~/.aieval-runs` 在受限沙箱里 dev server 写不动（一律 `EPERM`、接口全 500） | 排障先想沙箱 / 权限，再想代码 |
| diff 上限 `diffBudgetBytes` 默认 256KB，超限按文件裁剪并显式标「已截断」 | 被截断的两档（我们截 / 厂商截）都不得写「完整」 |

## 相关链接

- 知识文章：[《事件流》](/protocols/event-stream)（`events.jsonl` 的协议侧）、[《行执行与日志》](/features/row-execution)（八步时序的落盘点）、[《设置》](/features/settings)（workspaceRoot 的配置面）、[《评分》](/features/judging)（ScoreResult 记账格）
- 仓库内参考：AGENTS.md「持久化」节（原子写 / BOM / EPERM 口径的真源，互链不复制）
