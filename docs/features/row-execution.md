# 行执行与日志

## 定位

一行候选从发起到落终态的全部执行事实，以及人在哪里看到这些事实。行执行 = 状态机 + 八步内部时序 + `events.jsonl` 唯一真相源；观测面 = 执行日志抽屉（轮次时间轴 + 折叠面板 + 子任务面包屑）+ 行卡片实时计量 + 逐消息用量页脚 + 轮次 Tooltip。

## 页面形态与交互

- **执行日志抽屉三区**：固定区（事实条 + 领域事实 + 面包屑 / 工具条 + 原文行，四行）→ 滚动区时间轴（**虚拟列表是唯一滚动容器**）→ 浮动件「回到最新（N 轮未读）」。抽屉标题恒「执行日志」，`WIDE_DRAWER_SIZE = max(50vw, 800px)`。
- **每轮按「思考 → 工具调用 → 正文」呈现**：思考 / 工具默认折叠；连续工具调用合并一个面板（组头 `工具调用 × N`）；`task`（计划清单）与 `ask-user`（问答）两族从工具组提出单独成卡、原地出现、切断合并链。
- **面包屑只看该节点自己的消息**；每段下拉 = 该层级兄弟列表、当前项 disabled；用户提示词是主会话时间轴首条（真机暂不出现——界面侧就位、接线缺一步）。
- **流式滚动「跟随最新」**：默认开，用户一上翻自动关，角落浮出「回到最新」；与工具条开关同一份 state。
- **四类东西出口分立**：`log` 原文 → 「原始输出 N 条」独立二级抽屉（逐字原文、默认收起；`log` 事件不进时间轴）；无法归一载荷 → `unrecognized` 块；真实附件 → `attachment` 块；完整台账 → 仅「下载台账」（与时间轴是两条内容，不要求逐字一致）。
- **环境抽屉**是 `agent-log` 内部件（关闭联动是结构保证）：四组（用户层 / 厂商系统层 / 运行配置 / 实测统计）；缺失项给 `MissingReason` 原因文案；「已调度的工具」与「用过的工具及次数」分列。
- **`ask-user` 卡片**：七种收场（`answered` / `auto-resolved` / `skipped` / `timeout` / `unavailable` / `rejected` / `canceled`）+「还没收场」独立一支；本仓 `approvalPolicy: 'never'` ⇒ `unavailable` 是中性已知边界；卡片是只读复盘视图，不做应答面。
- **单行执行**：一个按钮按行态分叉「开始执行 / 重新执行」，确认框必须点名范围（首跑：「只跑这一个候选：本轮其他行（含已经执行过的行）都不会重跑。」）；**只动这一行**——其他行的状态 / 分数 / 计量 / diff / attempts / 事件日志逐字不变、串行队列不推进。重新评分：`Popconfirm`「只重跑评分步骤，候选 agent 不会再跑；现有的分数会被新的评分结果替换。」

## 数据与契约

- **行状态机**（完整枚举）：

  ```text
  pending → preparing → running → (agent 完成) → judging → judged
                    ↘ failed / timed-out / canceled
  串行被终止时未轮到的行 → skipped
  服务重启时仍在运行的行 → interrupted（不自动续跑）
  ```

  | 状态 | 含义 |
  ||---|---|
  | `canceled` | 用户按了终止，当时**正在跑**的行 |
  | `skipped` | 串行模式下用户终止时**还没轮到**的行 |
  | `timed-out` | **今天没有生产者**（时限已全删、三家也不自报）；留着是为将来与历史行 |
  | `failed` | agent 非零退出 / 启动失败 / 评分调用失败 / **评分智能体改了工作区** |
  | `interrupted` | 服务重启时仍在运行（`recoverInterruptedRuns` 把 `running`/`preparing`/`judging` 全标它） |

  `preparing` 阶段失败（复制失败、commit 不存在、远端不可达、工作区不可写）仍落 `failed` 并保留错误详情，不静默跳过。可重评终态 = `judged` / `failed` / `timed-out` / `canceled`。

- **八类事件**（全行级、每行带单调 `seq`）：`status` / `log`（带 `summary?`）/ `vendor-system` / `usage` / `diff-summary` / `score` / `error` / `end`。`setRowStatus` 落点唯一：改状态 + 落盘快照 + 追加 `status` 事件**成对**；`EvalRow.error.stage`（`'agent' | 'judge'`）只是叙述性记录，无判据读它。
- **`usage.tokensBasis`**：`'reported'` 才回写 `run.json`；`'estimated'` 只走事件流；缺省按 `'estimated'` 安全侧；`turns` 与两格子智能体分量恒回写。**用量里程碑（整行只出一条）**：取候选阶段（第一条 `judging` 或终态帧为界）里最后一条**主会话**带计量的 `usage`；子会话读数一条不进；孤儿抹成 `turn: null` 按时刻归位不丢。
- **子智能体三格**：`{0,0,0}` / `0` = 确实没有（「本次未观察到」），`null` = 没采到（**全量或 null** + 点名 WARN）；恒有 `subagentTokens ≤ tokens`（逐格）、`subagentTurns ≤ turns`。
- **三处用量形制**：顶部事实条 = **整行累计**（正体 secondary）；轮末里程碑 = 整行一条 Tag 色块；消息页脚 = **本条消息自己那次调用**（italic，`data-usage-footer`，`usage === null` 整行不渲染、同一逻辑消息多个块只出一行）。
- **判据函数族**：`canRunRow`（不在跑）、`canRetryRow`（不在跑 + `baselineCommit !== ''` + `diff !== null`，与前者单调）、`canRescoreRow`、`hasLiveRows`、`isSameRowTarget`。

## 状态机与时序

**八步内部时序**：

1. 建工作区 `{workspaceRoot}/{runId}/rows/{rowId}/workspace/`；
2. 取基线：远端 `ensureMirror` → `resolveRemoteRef`（本轮唯一一次 fetch）；本地从用例 cache **文件系统级目录复制**（不是每行克隆）→ `git checkout -B test/{rowId} <40 位 hash>`（一条命令同时切基线并重建行分支，重跑不因分支已存在而失败）；
3. 注入隔离配置：`CLAUDE_CONFIG_DIR` / `CODEX_HOME` / `DSH_HOME` → `{rowDir}/.agenthome/`；claude 另加 `settingSources` + `settings.env` 钉路由；
4. 跑智能体：`getProvider(kind).run`，工作目录 = workspace，`permission: 'full'`（评分智能体 `'read-only'`，独立 `.judgehome`）；
5. 收集计量（token 三元组含子分量、轮次、耗时、退出状态）；
6. 算 diff：`git diff {commit}..HEAD` + `git diff HEAD` + `git status --porcelain`（`--intent-to-add` 登记未跟踪）**三样缺一漏改动**；被 gitignore 的文件不进产出；`diffBudgetBytes` 默认 256KB，超限按文件裁剪并显式标「已截断」；
7. 评分（两条通路共用 `parseJudgeResponse` + `finalizeScore` + `judgeStageAttempt` 骨架）；
8. 落盘：事件追加 `events.jsonl` + 快照写 `run.json`。

- **缓存策略**：用例级 cache 不存在 / 来源缺失 / 来源已变才完整克隆一次；**重跑同一行先确保缓存、再清上一轮行产物**（清完而克隆失败会留下无工作区中间态；此顺序失败时旧产物仍在，重跑幂等）。分支名用 `test/{rowId}`（行 id 不用轮 id，多候选共用会互踩）。
- **`retryRow` 放行三级**：该行在跑 ⇒ 409「请先终止它，再执行」→ `rowAborts`/`retryTasks` 在途 ⇒ 409「上一次的运行还没收尾，请稍候再试」→ `!canRunRow` ⇒ `retryRefusal` 竞态兜底。**已知缺口**：`POST …/retry` 准备阶段是同步重活（镜像 fetch + 复制 + checkout），实测可超 5 分钟才返回；编排层已用 `await yieldToEventLoop()` 移出调用栈，但仍整段占住事件循环；强杀 / HMR 重启会留在途锁（只能杀残留进程恢复）。
- **`rescoreRow` 四硬口径**：追加事件不 `resetEvents`、不递增 `attempts`；入口区可整体回退；终态复检——用户先终止则状态保持 `canceled` 分数只进事件日志；`diff` 一字不动。
- **实时状态**：评测页信号驱动重验（`GET /api/runs/events` SSE；`PUT /api/runs/{id}` 落盘即 `event: run-updated`，毫秒级）；有活在跑时至多 60 秒一次慢兜底。

## 已知边界与取舍

| 边界 | 处置 |
|---|---|
| `AskUserInteraction` 的 `settled` 支**没有产出方**——七种收场、答案回填在真机一条走不到，夹具也喂不出 | **本设计最大一处「界面先行」**；缺契约那一格与装配层配对 |
| `unsettled` 任何地方赋不出来 ⇒ **被强杀的子任务会永远显示「运行中」** | 要补装配层判据：收场事件没到 + 整行已终态 ⇒ `unsettled` |
| 真机密度与基线不一致：`/runs` 页抽屉在紧凑 `ConfigProvider` 之外（fontSize 14 / Tag 高 22），基线是紧凑数（Tag 21.4 等） | 二选一未裁决；此前别拿基线数对真机截图 |
| codex「有子线程没报用量」档代码与口径表偏差：`subagentTurns: null` 与 `turns: <全树>` 同时落盘 | 要么收判据、要么改表承认「合计全树、分量未知」 |
| `TaskPanel.change` 恒 `null`（差分要数据层累积态）⇒「+1 完成」永不出现；`LogTurn.durationMs` 恒 `null` ⇒「本轮 3.2s」从不渲染 | 要修先做数据层累积态 |
| 语义状态色全部低于 WCAG AA 4.5（Tag warning 1.83 / success 2.21 / error 2.99 / processing 3.66） | 处置：色 + 字双通道、动效不得作唯一信号 |
| 旧口径勿照抄：「跨三家可比」（现是「同口径可比」+ `source` 标注）、「系统性偏高」（已退役）、「创新高水位」（整行一条取代）、`antd/listy` 子路径（**必须根导入**，antd 6.6.5 无子路径）、固定区 52（是单行事实条时代数，现为紧凑 ≈110 / 默认 ≈130） | 全部以现时口径为准 |
| 虚拟滚动用 antd 6 `Listy`：必须显式传 `virtual`、`height`、`rowKey`（稳定键）；**不传 `itemHeight`**（`ListyProps` 把它 `Omit` 掉）；`height` 量不到时不虚拟化全量渲染、不抛 | jsdom 单测因此能数全部轮次 |
| codex 收尾节流两道闸门：条目数变了 + 距上次读盘 ≥ 500ms；交出按 `mergeKey` 判三条 | 真机两分多钟 `messages.jsonl` 5.69 MB / 722 条 / 61 个 mergeKey，同一条逻辑消息最多被写 31 次（对照全量重发 34.5 MB） |
| 收集死锁教训：`vi.mock` 与静态 import 并存造成静态边 ⇒ vitest 收集期挂死（零 CPU）；修复后判读口径「失败条数 === EPERM 条数」把清理期 flake 与真红分开 | 全量跑 213 文件全部自行退出；`Test timed out` 计数全为 0 是「机器慢」不成立的硬依据 |

## 相关链接

- 活文档：[Codex FAQ](/faq/codex)——「清理上一轮的行产物失败（EPERM）」条（进程树回收的完整证据链）
- 仓库内参考：AGENTS.md——「删除与 PowerShell 安全」「测试」（`vi.mock` 逐文件重复）、「边界与工具链的已知坑」
- 知识文章：[《消息规范》](/protocols/message-spec)、[《事件流》](/protocols/event-stream)（协议侧契约）、《进程生命周期》（spawn 与整棵回收）、《评分》（评分通路的下游）、《评测详情与候选行》（抽屉族的兄弟篇）、《冒烟测试方法论》（几何断言不靠眼睛）
