# 冒烟记录：轮次 = 一次模型 API 往返 + 执行与评分都不限时间 —— 2026-09-28（深夜）

> 上位口径：`README.md` 的「轮次」两行 + `packages/server/agents/README.md` §5.4（三家计数口径）
> + `packages/server/contracts/src/agent-event.ts`（`usage` 事件形状）+ `packages/server/evaluator/src/orchestrator.ts`（停止面）。
> **只记实测值**；没在真机上做到的写「未覆盖 + 原因」，不写「看起来正常」。

## 1. 用户口径（原话，含一次撤回）

1. 「3 个智能体的『轮次』展示有问题，不够实时，查询资料修正。**每次请求模型接口 role = user 或 assistant 都算一次**」
   —— 追问确认：**一次模型 API 往返 = 1 轮**（不是「CLI 自己的 turn」，那是整段任务一条）。
2. 初版要求「最大轮次默认 500，在评测表单可配置，执行模式下方追加『最大轮次』」→ 随后**撤回**：
   「最大轮次也删掉：执行段完全不限」。
3. 「执行不限时间，评分不限轮次和时间」→ 连带「删除掉『评分配置』里的『单行超时（分钟）』」。
4. 追加报告：「轮次还是不够实时，接口时 sse 吗？新问题：tok、缓存命中 都显示『采集中』。评测完成没有触发评分流程。」
   —— 三问的实测结论分别在 §4（实时）、§5.3（采集中）、§5.2（评分已触发，是被 HMR 掐断的假象）。

## 2. 落点：改了什么 / 明确没改什么（范围清单）

| 面 | 改动 | 落点 |
|---|---|---|
| 表单 | **不加**「最大轮次」；**删掉**「单行超时（分钟）」 | `packages/client/ui/src/composite/judge-settings-card.tsx` |
| 契约 | `usage.tokens` 可以是 `null`，`turns` 必填；`SettingsSchema` 去掉 `rowTimeoutMs` | `packages/server/contracts/src/{agent-event.ts,settings.ts}` |
| 读侧兼容 | 旧 `config.json` 里多出来的 `rowTimeoutMs` 在**读**的时候被丢掉（`normalizeSettings`），不会把脏键带进运行时 | `packages/server/core/src/config-store.ts` |
| 运行骨架 | 删掉 `AgentRunInput.timeoutMs` 与自超时分支；`usage` 的发射门槛改成**轮次**（不是 token） | `packages/server/agents/src/{turn.ts,types.ts,emit.ts}` |
| 三家计数 | claude-code：主循环 `assistant.message.id` 去重；dsh：`step/start`；codex：模型产出条目（**近似**，见 §7） | `packages/server/agents/src/providers/*/events.ts` |
| 内层上限 | 删掉硬编码 `maxTurns: 60` | `packages/server/agents/src/providers/claude-code/{index.ts,sdk.ts}` |
| 编排停止面 | 删掉候选兜底超时 / 硬截止 / 评分计时器；新增「行落终态即唤醒行任务」+ 5 秒交卷窗口 | `packages/server/evaluator/src/orchestrator.ts` |
| 评分通路 | 不再给 `timeoutMs` | `packages/server/evaluator/src/judge-agent.ts` |
| 实时总线 | 事件总线挪到 `globalThis`（HMR 把模块重新实例化会劈出第二条总线） | `packages/server/evaluator/src/events.ts` |
| 客户端 | `tokens: event.tokens ?? base.tokens`（`null` 不许把已显示的 tok 抹掉）；只用轮次时渲染成 `轮次 N` | `packages/client/client/src/row-live.ts`、`packages/client/ui/src/composite/log-format.ts` |

**没改的**：`RunCreate` / `EvalRun` 契约一个字未动（没有轮次上限字段，也没有超时字段）；
`timed-out` 这个行状态**保留**（今天只由适配器自报触发，见 §7）；`attempts`、自动重试退避
（`ROW_RETRY.delayMs`，那是重试间隔不是时限）照旧。

## 3. 轮次怎么数（真值表）

| 适配器 | 计数键 | 备注 |
|---|---|---|
| claude-code | 去重后的主循环 `assistant.message.id`（同一响应的多个内容块共享 id；`parent_tool_use_id` 非空的子智能体消息不计） | 与 SDK 自己 `maxTurns` 的「API round-trips」同口径；`num_turns` 只在一次都没数到时兜底，且不一致时留 WARN |
| dsh | `step/start` | dsh 的 `turn/end` 是**整段任务**一条，照它数永远是 1 |
| codex | `item.updated` / `item.completed` 上 `reasoning` + `agent_message` 的去重 `item.id` | **近似**，见 §7 |

三条硬口径（三家逐字一致，抄三遍必然漂移，所以落在骨架 `turn.ts` 里）：
一次 API 往返算一次；**采不到就是 `null`，绝不填 0**；`turns` 与 `tokens` 互不兜底
（轮次不因为 token 没采到就停涨，反之亦然）。

## 4. 「不够实时」的真因：SSE 是通的，断在开发态的两条总线上

链路本身是**推送**，没有轮询：适配器 `onEvent` → `publishRowEvent`（先追加 `events.jsonl`，再同步扇出）
→ SSE 路由 `/api/runs/{runId}/rows/{rowId}/stream` → 客户端 `useRunLiveMetrics` / `useRowStream`
→ 行卡片实时覆盖显示。

实测断点（2026-09-28 白天那次「轮次一直停在 1」）：**Next dev 的 HMR 会把模块重新实例化**，
于是进程里存在两条互不相干的总线——写入方落在新模块的 `paths`/`subscribers`，而页面上那条
SSE 连接挂在旧模块上。

| 探针 | 结果 |
|---|---|
| 同一条路由，原始 `EventSource`（`afterSeq=0` 回放） | **12743 帧**（落盘与扇出都没问题） |
| 页面里应用自己那条连接，连续观察 19–30s | **0 帧**，而 `readyState: 1`（连接活着、只是永远收不到新事件） |

修法：总线实例挂到 `globalThis.__aievalRowEventBus`（`events.ts`），HMR 之后仍是同一条。
修后实测：**在跑动中触碰一个源文件触发 HMR，行卡片的轮次从 15 继续涨到 25**（同一连接、不刷新页面）。

## 5. 真机证据（`http://localhost:3083`，Next dev）

### 5.1 实时轮次与磁盘一致

| 断言 | 实测 |
|---|---|
| 行卡片轮次是活的 | 一次真实运行里 `usage` 事件连续 36+ 条，`turns` 1→37 单调上涨；卡片显示过 `轮次 38` / `44` / `96` |
| 与磁盘一致 | 终态 `run.json` 的 `turns` 与过程中最后一条事件同值（`3cf0b7d1` 收在 **109**） |

### 5.2 「评测完成没有触发评分流程」= 假象，评分确实跑了

目标轮 `/runs?panel=detail&id=3cf0b7d1-078b-460e-b4bc-008233e7fbd9`（磁盘实测）：

```
run.status = done
rows[0].status = judged          attempts = 2
rows[0].turns = 109              durationMs = 1189208
rows[0].tokens = { input: 192327, cached: 7870720, output: 45155 }
rows[0].score.totalScore = 100   judgedAt = 2026-09-28T08:52:46.634Z
```

—— `score` 非空、`judgedAt` 有值、行状态 `judged`：评分流程被触发了，而且出分了。
当时界面上那张卡片是**冻结**的（§4 的旧连接），不是没评分。

### 5.3 tok / 缓存命中一直「采集中」= 网关行为，不是我们的解析 bug

用 SDK 探针（打开 `includePartialMessages`）逐帧看该网关（likecode / `jd/GLM-5.3`）：

| 帧 | `usage` |
|---|---|
| 流式 `assistant` 帧 | `input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0`（**全 0**） |
| `result` 帧（一次运行收尾时） | `input 65,063 / cached 407,808 / output 5,940`（真实值） |

所以运行过程中**没有**可用数字可显示。这里踩过一次坑：早先版本把全 0 的三元组当成「采到了 0」
显示成 `tok 0`——这是**假零**，与「没采到」含义相反；现已改为全 0 ⇒ `null` ⇒ 界面显示「采集中」。
取消的运行同样保留已采到的值（`12eff3a1`：`canceled`，但 `turns=17`、
`tokens={65063,407808,5940}` 照常落盘）。

## 6. 实现层用例与变异验证

| 断言 | 文件 |
|---|---|
| usage 的门槛是轮次：只带轮次也发、同值不重发、只有 tokens 时不发但结果仍带上 | `packages/server/agents/src/turn.test.ts` |
| 估算计量只进事件、不进结果（`tokensEstimated`） | 同上 |
| 挂住的适配器不会因为时间流逝被叫停（执行不限时间），只有 signal 能停它 | 同上 |
| 适配器彻底不响应时不自超时；用户终止后行与**轮**都必须真的收尾 | `packages/server/evaluator/src/orchestrator-timeout-isolation.test.ts` |
| 协作适配器被终止时，行 `canceled` 且适配器交回的计量与轮次照常落盘（不是两个 null） | 同上 |
| 行收尾之后适配器才吐出来的日志不再落盘（迟到事件闸门） | `packages/server/evaluator/src/orchestrator-judge-route-b.test.ts` |
| `usage.tokens` 允许 `null`、`turns` 必填；`rowTimeoutMs` 已从设置契约消失 | `packages/server/contracts/src/{agent-event.test.ts,settings.test.ts}` |
| 旧 `config.json` 里的 `rowTimeoutMs` 被读侧丢掉 | `packages/server/core/src/config-store.test.ts` |
| 事件总线跨模块重新实例化仍是同一条（HMR 守卫） | `packages/server/evaluator/src/events.test.ts` |
| **权威计量到达后跑动期估算作废**（其后的 `usage` 事件不许再回落到估算值） | `packages/server/agents/src/turn.test.ts` |
| `tokens: null` 不清空已显示的 tok；只有轮次时渲染 `轮次 N`；评分配置卡不再有「单行超时」 | `packages/client/{client/src/row-live.test.tsx,ui/src/composite/{log-format.test.ts,judge-settings-card.test.tsx}}` |

**变异验证**：本轮新加的守卫逐条做了变异（把实现改坏 ⇒ 必须看见对应用例失败 ⇒ 复原 ⇒ 比对 SHA256）。
M1–M25 全部真跑；唯一一条「变异了也不失败」的惰性守卫（codex 的「工具条目不计轮次」用了
`item.started`，永远走不到计数路径）已改成 `item.completed`，改后变异如期失败。改过的源文件全部复原且
哈希一致（例：`turn.ts`、`providers/claude-code/events.ts`、`evaluator/src/orchestrator.ts`）。
最新一条是复查时补的 M25（`turn.ts`：不把估算作废 ⇒ 新增的「权威值作废」用例红；
复原后 SHA256 `BDC34CD5…` 与变异前逐字节一致）。

**全量回归**：`pnpm vitest run --no-file-parallelism` 一次跑完 **148 个文件 / 1526 条用例，全绿**
（墙钟 1845s）。同一天早些时候按默认并行度跑同一套，有 13 个文件报
`Test timed out in 60000ms`（core 的 mirror / workspace 那批真 git + evaluator 的重夹具）——
`--no-file-parallelism` 下这 13 个文件全部通过（例：`mirror-ref.test.ts` 47s、
`workspace-prepare-b.test.ts` 24s，都远超 60s 的超时线，串行时不争 CPU 就没事）。
修复后再跑一次默认并行度，evaluator 又有 5 个文件超时（同样那批重夹具）；把这 5 个文件单独串行跑
**21/21 全过**。**两处红都是机器负载导致的假红**（进程创建被 DLP/EDR 收税，见
`2026-09-28-test-runtime-it-request.md`），不是本次改动的回归——判据是它们在串行下全过，
且超时行的用例本身与本次改动无关（串行/并行模式、重试、失败隔离）。

## 7. 未覆盖 / 已知代价

1. **codex 的轮次是近似值**：`item.*` 与「模型 API 往返」不是一一对应——一次调用同时产出
   `reasoning` + `agent_message` 会**高估**，不带 reasoning 的调用会**低估**。
   实测样本：真实 10 次模型调用 vs 15 个计数条目。**没做**「读 `$CODEX_HOME` 下 `sessions` 目录的
   rollout 文件精确核对」这件事（用户当时选了「先按事件近似」）。
2. **dsh 适配器的轮次与实时性没在真机上跑过**（只有单测）：本次真机验证全走 claude-code 一家。
3. **网关不回流式 usage** ⇒ tok / 缓存命中在**运行过程中**永远显示「采集中」，只有一次运行收尾
   （`result` 帧到达）才有值。这是该网关的行为，本次没有做任何「中途估算 token 并显示」的改动
   （claude-code 的估算只进事件、不进结果，界面上仍按「采集中」显示）。
4. **不限时间的代价**：一个连停止信号都不理的适配器会让那一行**一直挂着**（原来有兜底超时就一定能收场）。
   今天的兜底只有「用户点终止 ⇒ `terminalWaiters` 唤醒行任务 + 5 秒交卷窗口」；**没有**自动兜底。
   这条不变量原来由时间保证，现在由用户操作保证——它是用户明确要的口径，但不是免费的。
5. **`timed-out` 行状态今天只能由适配器自报触发**：三家真实适配器都不产出 `AGENT_TIMED_OUT`
   （`providers/<kind>/` 里 `grep` 为空），评分阶段的 `AGENT_TIMED_OUT` 分支保留只为历史数据与类型完整性。
6. 三个冒烟运行（`12eff3a1` canceled / `0a7fb912` 修复前残留的 `run=running` + 行 `canceled` /
   `e9dd27d9` 被我重启服务打断）已在收尾时按用户决定**全部删除**（证据留在本文，产物不必留）。

## 8. 收尾时用户拍板的两件事

1. **tok / 缓存命中的措辞**：**保持「采集中」不动**——该网关运行期确实没有用量可采（§5.3），
   照实说「还没采到」比编一个数好；跑完收尾帧一到就变真值。
2. **三个冒烟运行**：**全部删除**（见 §7 第 6 条）。
