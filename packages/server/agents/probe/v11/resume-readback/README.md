# 跨家「暗号回读」驱动器

同一套判据对四家（cc / codex / pi / dsh）跑「第二轮真的带回了第一轮的上下文」这件事。
四家的引擎仍是 `probe/v11/` 下既有的单家探针（本目录**只加不改**，按它们的 `--role=` 单跑接口调用）；
本目录负责编排（随机暗号、隔离目录、一档一个真进程）、判据归一与横向矩阵。

## 判据口径

每家有**正反两面**，每面**两条并行判据**：

| | 投影（机制）——厂商侧的可查事实 | 答复（端到端）——模型答出暗号 |
|---|---|---|
| **正面（resume）** | 被接续那条会话的厂商侧投影里**含**上一轮的暗号 | 答出 |
| **反面（不 resume）** | 那一轮**新建**的会话投影里**不含**暗号、身份与写半边不同 | 答不出 |

判定的四条规矩：

1. **两条都成立才算「支持」**：投影判机制、答复判端到端。
2. **单次答不出不算「不支持」**：投影成立而答复落空 ⇒ 记 `model-flaked`，脚本会**自动重问一次**
   （新进程、同 resume），两次答复都进读数。
3. **阴性对照不成立时正面结论作废**：对照侧任何一格出现暗号 ⇒ `leaked`
   （那说明暗号能从别处泄漏，「答对了」证明不了转录起了作用）。
4. **跑不起来 ≠ 探测失败**：载体进程没跑成 ⇒ 该家记 `inconclusive` 并列出原因，**绝不**降级成 `unsupported`。

判定档：`supported` / `model-flaked` / `unsupported` / `leaked` / `inconclusive` / `not-runnable`。

## 各家的引擎与投影来源

| 家 | 引擎（既有探针） | 续接形状与要落的键 | 投影读的是哪份事实 |
|---|---|---|---|
| **cc** | `cc-session-resume.mjs` | `query({ resume: <session_id> })` | `$CLAUDE_CONFIG_DIR/projects/<cwd>/<session_id>.jsonl` 转录里含暗号 |
| **codex** | `codex-session-resume.mjs` | `thread/resume{threadId}` | 三条通道：`thread/read{includeTurns:true}`、resume 响应里的 turns、`$CODEX_HOME/sessions/**/rollout-*.jsonl` |
| **pi** | `pi-session-resume.mjs` | `SessionManager.open(<会话文件>)` | 厂商自己的 `manager.buildSessionContext()`（`prompt()` **之前**读，不花额度）+ 会话文件 |
| **dsh（本仓 pin）** | `dsh-session-resume.mjs` | 本仓 pin `0.2.1-alpha.3` 的 wire 上**有** `session/resume` ⇒ 正面可跑 | 盘上会话日志 `$DSH_HOME/sessions/<projectKey>/<id>/session.v4.jsonl.zstd`（按 zstd 魔数切帧逐帧解） |
| **dsh（仓外新版）** | `dsh-session-resume-alpha3.mjs` | `session/resume{sessionId}`（官方 wire，自 `0.2.1-alpha.3` 起） | 同一条会话日志**变大**（新回合追加进同一会话）+ 里面含暗号 |

围栏（`fences`）是各家的「不许静默新建空会话」那一类断言，逐家不同：
cc = 换 `CLAUDE_CONFIG_DIR` / 不存在的 session_id；codex = 换空 `$CODEX_HOME` / idle 时 `turn/steer`；
pi = 同 cwd 只换行目录；dsh = 从未存在的 id / 换空 `$DSH_HOME`。
标了 `kind: 'reading'` 的条目是**读数**而不是围栏（例如 cc 换 cwd 仍能 resume）。

## 用法

```bash
set -a; eval "$(grep -E '^export AIEVAL_PROBE' ~/.zshrc)"; set +a
# 四家全跑
node packages/server/agents/probe/v11/resume-readback/driver.mjs
# 只跑某几家 / 指到仓外装的新版 dsh 客户端
node …/driver.mjs --families=cc,pi --sdk-dir=/tmp/<仓外装的那份> --timeout-ms=300000
# 单家排障（与驱动器同一函数，读数同形）
node …/cc-arm.mjs   # codex-arm.mjs / pi-arm.mjs / dsh-arm.mjs 同形
```

凭据**只从环境变量读**：`AIEVAL_PROBE_GATEWAY_API_KEY` / `AIEVAL_PROBE_GATEWAY_BASE_URL`
（dsh 的模型侧凭据走 `~/.dsh/.credentials.yaml`，由引擎自己读）。源码里不出现明文 key，落盘前 redact。

退出码：`0` = 被选中的家都跑起来了；`2` = 有家没跑起来（那些格作废，**不许**当「不支持」读）。
某一格**跑不起来**（例如本仓 pin 下 dsh 的正面）**不改**退出码：它在 `notRun` 里逐字写明原因，
由围栏里的反断言承载。

## 读数落点

`probe/dumps/v11/`（整个 `dumps/` 已 gitignore）：

- `resume-readback-matrix.json`——驱动器的汇总（矩阵 + 四家的整份读数 + `complete` / `failures` / `notRun`）；
- `resume-readback-<family>.json`——单家读数（**只在该家载体都跑起来时**才落盘）；
- 各家引擎自己写的读数（`cc-session-resume-*` / `codex-session-resume-*` / `pi-session-resume-*` /
  `dsh-session-resume-*`）——原文级证据，本目录的读数引用它们。

`complete === true` 只表示**没有进程级的跑不起来**，不表示每家都「支持」：某一家可达与否由各自的
`verdict.gate` 表达。

## 已知边界

- **dsh 的版本门**：`session/resume` 自 `@deepseek-ai/dsh-sdk-jsonrpc-server@0.2.1-alpha.3` 起是官方 wire
  方法，**本仓 pin 的正是那一版** ⇒ 默认解析下 dsh 的正面那一格跑得起来（同一 `sessionId` 在新进程里接上
  + 阴性对照必须答不出）。要跑**别的版本**时用 `--sdk-dir=` 指到仓外装的那一份（那条路不动本仓
  `package.json` / `pnpm-lock.yaml`）；装到 `0.2.0-rc.2` 及更早时正面跑不起来，只能反断言。
- **cc 的隔离键**：spec 口径写的是 `CLAUDE_CONFIG_DIR` × cwd，但真机上换 cwd 仍能按 `session_id` 接上
  ⇒ 按行隔离实际只能靠**每行一个 `CLAUDE_CONFIG_DIR`**。驱动器的 `cc-arm.mjs` 把这一格记成**读数**
  而不是围栏（`kind: 'reading'`）。
- **dsh 的通知流**：`session/resume` 之后订阅到的通知流**不回放历史**（只有本轮事件）⇒ 恢复判据只能取
  「暗号回读 + 盘上转录」，拿通知流当证据会得到假红。
