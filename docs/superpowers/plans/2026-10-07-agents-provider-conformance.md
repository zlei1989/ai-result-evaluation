# 新增智能体 SDK 的一致性测试方案

**判据源**：`docs/superpowers/specs/2026-10-01-agent-message-spec-design-v3.md`（下称「规范」）。本文件定义**怎么验**，规范定义**验什么**；两者冲突时以规范为准。

**要解决的问题**：加一家 SDK 时，现有测试会给你一片绿，然后真机上依次挂掉。2026-10-07 的 codex 改造就是实例——单测全绿（agents 包 585 条通过），真机上连续暴露三类缺陷，其中两类**在单测环境里原理上不可能复现**。

## 一、为什么现有测试拦不住（失败分类学）

| 类 | 形态 | 为什么单测绿 | 本次实例 |
|---|---|---|---|
| **A 装载/解析** | 厂商包或可执行文件的定位在**打包器/产物环境**里失效 | 单测跑在纯 Node，解析器更宽松；夹具用假目录「怎么搭怎么解析」 | Next/Turbopack 把 `createRequire` 换成自己的 ⇒ `resolve()` 返回模块 id（`[externals]/…`） |
| **B 凭据与路由** | 密钥/网关/provider 选择没真正传到厂商进程 | 假 SDK / 假 app-server 不看这些**传输字段** | provider 写了 `requires_openai_auth`（走登录态）、且漏了 `model_provider`（退回内置 provider） |
| **C 协议时序** | 夹具的时序比真实更苛刻或更宽松 | 夹具自己定的时序当然自洽 | 夹具在 `turn/start` 处理内同步投通知，而真实订阅在其后 ⇒ 40s 超时 |
| **D 消息契约** | 信封/内容块/子任务/环境/计量的形状与规范不符 | 已有跨家一致性测试，但**手工维护三家**，第四家不会被自动要求通过 | —— |
| **E 生命周期** | 取消、清理、子进程回收 | 单测里没有真进程可回收 | 终止后 codex 子进程不回收 ⇒ 下一轮清理 EPERM |
| **F 能力声明诚实性** | 声明 `yes` 却拿不到 / 声明 `no` 其实拿得到 | 声明与产物**没有互相钉** | —— |

⇒ 结论：**单层测试不够**。A/B/E 只能真机拦；D/F 要 provider-agnostic 的套件自动施加；C 要夹具时序保真且被单独钉住。

## 二、四层结构

```
① 静态层     packages/server/agents/src/static-assertions.test.ts（扩）
             禁：厂商包静态 import；解析器单路径（必须打包器免疫）；凭据写进 process.env
② 契约层     packages/server/agents/src/providers/conformance/**（新）
             任何 provider 提供一份 fixture 就必须通过同一套断言（§2.1–2.9 / §5 / §7）
③ 集成层     packages/server/agents/src/providers/<kind>/index.test.ts（既有）
             该家特有的协议细节、时序、边界
④ 真机冒烟   scripts/agent-live-smoke.mjs（新）+ 一条命令
             起真评测跑一家，断言「跑完 + 有评分 + 消息合规 + 环境/思考/子智能体/工具在位」
```

②是本方案的主体：**把「加一家」从「再写一遍三家的测试」变成「实现一个 fixture 接口」**。

## 三、契约层：一致性套件

### 3.1 用法（新增一家的全部接入成本）

```ts
// providers/<kind>/conformance.test.ts
import { describeProviderConformance } from '../conformance/kit';
import { createFixture } from './conformance-fixture';

describeProviderConformance('acme', createFixture);
```

套件内部按 `describe` 分组，组名直接引用规范条目，红的时候一眼知道违反哪条。

### 3.2 fixture 接口（只要求「能造出场景」，不要求实现细节）

```ts
interface ProviderFixture {
  kind: AgentKind;
  /** 该家的能力声明（本次运行的），用于 §2.7 的逐格互钉 */
  capability: MessageCapability;
  /**
   * 造一次「跑完」的运行：输入 = 场景名，输出 = 该家原生的**线级事件序列**
   * （不是归一后的消息——归一正是被测对象）
   */
  scenarios: Record<ScenarioName, () => { events: unknown[]; expect: ScenarioExpect }>;
  /** 假凭据/假路由：用于 §3 的「传输字段」断言（假 SDK 也必须能观察请求） */
  wire: { route: RouteInput; captured: () => unknown[] };
}

type ScenarioName =
  | 'plain-reply'        // 纯文本答复（§2.1 信封、§2.2 text 块）
  | 'thinking-full'      // 思考正文（§2.2 thinking、§2.7 thinkingTextKind='full'）
  | 'thinking-encrypted' // 只有密文/摘要 ⇒ text:null + 'none'，**不回落 summary**（§2.2）
  | 'tool-shell'         // 命令类工具（§5.1 run-shell 族、§2.2 tool-call/tool-result 配对）
  | 'tool-edit'          // 文件改动（§5.1 edit-file 族）
  | 'tool-plan'          // 计划清单（§5.1 task 族 + §5.3 合并语义）
  | 'subagent'           // 子任务（§2.8 四条硬规则 + 子消息挂 parentCallId）
  | 'usage-pair'         // 主+子都有用量（§2.4/2.5/2.6 配对与归属）
  | 'usage-missing'      // 缺一格 ⇒ 整格 null（不拿部分和冒充）
  | 'env-vendor-system'  // 环境信息（§2.9 vendor-system 事件）
  | 'cancel'             // 取消（§2.3 行级事件 + 结算语义）
  | 'failure';           // 失败归因（错误码 + 流内原因优先）
```

### 3.3 断言组（逐组对应规范条目，红即定位）

| 组 | 断言 | 规范 |
|---|---|---|
| 信封 | 逐字段存在性与类型；`source`/`vendorId`/`vendorTurn` 缺失记 `null` 而非省略 | §2.1 / §3.1 |
| 内容块 | 块 `kind` 属闭集；`text`/`thinking`/`tool-call`/`tool-result` 的不变量（如 thinking 密文不回落） | §2.2 / §3.2 |
| 流式合并 | 增量→快照覆盖后**唯一**且等于快照；合并键稳定 | §6.1–6.3 |
| 工具族 | 每个工具块 `family` 属十族或 `null`；`name` 与族自洽 | §5.1 / §5.2 |
| 子任务 | `status` 与 `statusMissing` 分离；`outcome` 只放文本；`parentCallId` 是唯一桥；`parentSubagentId` 父为主会话时 `null` | §2.8 |
| 环境信息 | 四组 `source` 正确；**已调度工具**与**用过的工具**分开；无 `vendor-system` 的整组 `not-exposed` | §2.9 |
| 计量 | 合计与分量成对；任一分量缺失 ⇒ 该格 `null`；轮次与用量**同一把尺** | §2.4–2.6 |
| 能力互钉 | 声明 `yes` ⇒ 套件必须能造出该块；声明 `no`/`not-projected-by-vendor`/`off-by-adapter` ⇒ 必须配对应 `MissingReason`；`yes` 必须有 `source`，其余必须 `null` | §2.7 |
| 缺失记账 | 每个「没有」都带 `MissingReason`，且与能力声明的态对应 | §2.7 / §7 |
| 行级事件 | `usage`/`log`/`error` 的 `stream` 与载荷形状 | §2.3 |

**能力互钉是这套件的核心价值**：它让「声明」与「产物」互为判据，堵住 F 类——声明 `thinkingText: 'yes'` 却造不出 thinking 块，直接红。

### 3.4 夹具时序保真（堵 C 类）

套件强制两条：
1. **订阅早于提示词**：fixture 必须能表达「通知在 `subscribe` 之前产生」这一形态，并断言**不丢**（对应本次 40s 超时的真因）；
2. **终态只在结算后投递**：fixture 若把终态通知与「请求返回」写在同一 tick，套件判为**不合规夹具**（真实世界里终态必然晚于响应）。

## 四、真机冒烟（堵 A/B/E 类）

`scripts/agent-live-smoke.mjs`：对指定 `--kind` 跑一次真实评测（复用 evaluator），四格断言：

1. **装载**：provider 能解析到厂商入口（打包后的产物环境，不是纯 Node）——A 类的唯一拦法；
2. **传输**：厂商进程收到的**路由/凭据/provider 选择**与本次运行一致——B 类的唯一拦法（codex 侧可从 `app-server` 的启动配置或请求事实核对）；
3. **产物**：跑完且有评分（`run.status=done`、`row.score != null`）；
4. **形状**：`GET /api/runs/<id>/rows/<row>/messages` 的返回过一遍契约层的形状断言（§2.2/2.8/2.9 的**线上形态**）。

要求：`--kind` 必填（不给默认家，避免「默认跑的那家绿了就当四家都绿」）；凭据只从环境变量读（本仓既有规矩）；把厂商进程的 stderr 落到日志（本次排查难的直接原因）。

## 五、新增一家 SDK 的接入清单（checklist）

按序做，每条都有判据：

1. **定义能力声明**（§2.7 五态 × 五格 + `notes` 写清路由/模型前提）→ 跑契约层「能力互钉」组
2. **定 wire 形态**：厂商包怎么定位（静态 import？子进程？）→ 若走子进程，**必须打包器免疫**（禁把 `import { createRequire } from 'node:module'` 当唯一路径，见 `docs/codex-faq.md`）
3. **定凭据与 provider 传递**：密钥进子进程环境 + provider 条目名与 `model_provider` 类字段**成对**给出；base_url 归一（该补 `/v1` 就补）→ 真机冒烟第 2 格
4. **写 fixture 的 12 个场景** → 契约层全绿
5. **接生命周期**：取消必须能终止在途轮次；`dispose` 必须**真正回收**子进程；清理遇 `EPERM` 重试 → 集成层 + 真机冒烟第 1/3 格
6. **登记缺失**：§7 缺失影响矩阵里这一家的每一格，要么有产物、要么有 `MissingReason` → 契约层「缺失记账」组
7. **跑真机冒烟并留证据**（`run.status` / `score` / 消息形状抽样）→ 写进本次关账记录

## 六、落地任务

| # | 任务 | 判据 |
|---|---|---|
| 1 | 建 `providers/conformance/kit.ts` + `types.ts`：套件骨架（分组、fixture 接口、断言组空实现） | `describeProviderConformance` 可被三家接入且全绿（先做「信封」「能力互钉」两组） |
| 2 | 迁移 `providers/message-conformance.test.ts` 的跨家断言进套件（该文件瘦身为「三家 fixture 的差异说明」） | 三家各自 `conformance.test.ts` 通过；断言条数不少于迁移前 |
| 3 | 补齐剩余断言组（内容块/流式/工具族/子任务/环境/计量/缺失记账） | 每组至少一条**变异验证**：把该组要拦的缺陷造回去 ⇒ 该组红 |
| 4 | 夹具时序保真两条（订阅早于提示词、终态晚于响应） | 变异：把终态通知挪到「请求返回同 tick」⇒ 套件判不合规 |
| 5 | `scripts/agent-live-smoke.mjs`（`--kind` 必填，四格断言） | 对 codex 跑通并打印四格证据；对缺 `model_provider` 的构造红在第 2 格 |
| 6 | 扩 `static-assertions.test.ts`：厂商包禁静态 import、解析器禁单路径、凭据禁写 `process.env` | 三条各自变异见红 |
| 7 | 写「新增 SDK 接入清单」进 `packages/server/agents/README.md` | 清单与本文件第五节逐条一致 |

**顺序理由**：1→2 先把套件跑起来（不追求全覆盖），3 再逐组加断言——每加一组都能立刻拿三家验证「这条断言是不是恒真」（恒真的断言没有区分力，本仓已有多次教训）。

## 八、落地进度（按提交记，随时更新）

| 任务 | 状态 | 提交 / 证据 |
|---|---|---|
| 1 建套件骨架 | ✅ | `089c627`：`providers/conformance/kit.ts`（判据组，现为 **11 组**）+ `kit.test.ts`（**25 条：7 正例 + 18 反例**，每条判据都见过失败） |
| 2 三家接入 | 进行中 | codex ✅ `c169b0b`（当时 8 组在真实归一产物上全通过；现为 11 组）；claude-code / dsh 待接 |
| 3 真机冒烟 | ✅ | `6afbbd3` `providers/live-smoke.test.ts`：四格断言、默认跳过、`AIEVAL_LIVE_KIND` 必填；**已在 codex 上真跑 4/4**（一次完整评测 250s） |
| 4 夹具时序保真 | ✅ | `4df9a7a`：判据建在**传输笔迹**上（四条判据 + 7 条自测），设计见 §十五 |
| 5 静态层 | 部分 ✅ | `750a7d6`：打包器免疫守卫（含「注释里写着三条要求」的盲区样本，变异见红）。厂商包禁静态 import、凭据禁写 `process.env` 两条**本仓早已有**，无需重做 |
| 6 扩静态层其余 | ✅ | 同上（既有守卫已覆盖） |
| 7 接入清单进 README | ✅ | `fd80275`：`README.md` §8.1 |

### 载体修正（相对本方案初稿）

- **真机冒烟不做成 `.mjs` 脚本，改成 vitest 承载**：形状判据要复用 `@aieval/contracts` 的 zod schema，而该包直出 TS 源码，`.mjs` 里 import 不到；做成 `.mjs` 就只能复制一份形状（两份必然漂移）或放弃形状判据。改后既有真机判据、又只有一份形状真源。
- **判据组从 8 组扩到 11 组**：+§2.10「行结果」（`ok` + `finalText`，并行会话引入）、+§2.11「结构化输出与产出可解析」、+「传输时序（C 类）」。后两组的判据本体各自独立成模块（`structured-output.ts` / `transport.ts`），套件只负责接线与点名到场景。

### §2.10 行结果（2026-10-07 追加，由并行的 codex 结构化输出改造引入）

**为什么必须由套件统一钉，而不是各家自己测**：评分通路只读 `AgentRunResult.finalText`——它是「智能体评分」这条产品通路的**唯一入口**。在这条判据之前，「哪条消息算最终答复」只有各家自己的用例在管，于是：**codex 在 app-server 重构里整体漏写了这一格，`providers/codex/*` 全绿，真机上评分智能体永远拿不到答复**（`JUDGE_PARSE_FAILED`）。

判据三条（`checkFinalAnswer`）：
1. `finalText === ''` ⇒ 红（**没采到必须记 `null`**，空串与 `null` 是不同的归因）；
2. `ok ∧ 产物里有已收尾的主会话答复 ∧ finalText === null` ⇒ 红（**漏写这一格＝评分通路拿不到答复**）；
3. `finalText` 非 `null` 时必须是产物里某条主会话答复的正文（不许是拼接或改写过的）。

### 并发协作边界（2026-10-07 实测）

本仓可能同时有另一个会话在改同一批文件。当时他们持有：`conformance/kit.ts`、`kit.test.ts`、`codex/conformance.test.ts`、`codex/events.ts`、`codex/index.test.ts`、`agents/src/types.ts`、`evaluator/src/judge-agent.ts`、`docs/codex-faq.md`、parity spec。

规矩：
- **`git status` 里不属于你的改动保持原样**，不修、不回退、不「顺手」格式化——即使它当前是红的（那次 `kit.ts:280` 有一条他们新写判据的类型错误，改它只会打架）。
- 落自己的活时**优先挑不重叠的文件**；必须重叠时先让路，等对方收手再改。
- 自己提交用**显式路径**（本仓明令禁止 `git add -A`），这样别人的在途改动不会被卷进来。

## 十、claude-code / dsh 接入的已知入口（侦察结果，省得重做）

### claude-code

- **消息归一入口**：`createClaudeMessageNormalizer()`（`providers/claude-code/message.ts`），惯用法与跨家一致性测试一致：
  ```ts
  const normalizer = createClaudeMessageNormalizer();
  const state = createTurnState();                       // `../testing/agent-fixtures`
  const drafts = raws.flatMap((raw) => normalizer.normalize(raw, state).messages);
  // 再喂 createMessageAssembler 得到 AgentMessage[]
  ```
- **§2.10 那一格**：`state.finalText`（`TurnState`）。claude 由 `result` 消息 / `structured_output` 设置
  （`events.ts:281/283`，序列化优先级见 `events.test.ts` 的 `projectClaudeMessage：最终答复` 组）。
- **流式增量**：`stream_event`（`message_start` → `content_block_delta`）之后到 `assistant` 全量消息。
- **工具块**：`assistant` 消息里的 `{ type: 'tool_use', id, name, input }` + `user` 消息里的
  `{ type: 'tool_result', tool_use_id, content }`。
- **⚠️ 子任务不在消息层**：`task_started` / `task_notification` 经 `projectClaudeMessage` 出来的是
  **log 草稿**（`draft.type === 'log'`，见 `events.test.ts:848`），而 §2.8 的 `SubagentRecord` 是在别处
  拼的（`index.ts` 的投影 + `message.ts` 的 `ClaudeTaskShape`）。真机形状（逐字取自 §6.4.1）：
  ```ts
  { type: 'system', subtype: 'task_started', task_id, tool_use_id, description,
    subagent_type, is_backgrounded, spawn_depth, task_type, prompt }
  { type: 'system', subtype: 'task_notification', task_id, tool_use_id, status, summary,
    usage: { total_tokens, tool_uses, duration_ms } }
  ```
  `tool_use_id` 是三处同值的那个键（派发工具调用 id / 子消息的 `parent_tool_use_id` / 本记录的 `parentCallId`）。

### 三家共用的样板

三家的 `SubagentRecord` 与跨家一致性断言都在 **`providers/message-conformance.test.ts`**（760 行）里
已经写好一遍——Task 2 的迁移就是把它按家拆成 fixture：**先读那个文件，不要从零推形状**。

### run 级测试台的写法（claude 侧已侦察，2026-10-07）

三家都用同一套注入与收集惯用法（`providers/claude-code/index.test.ts:1062-1067` 是活的样板）：

```ts
const configHome = mkdtempSync(join(tmpdir(), 'claude-conformance-'));
const recorder = createRecorder();                       // ../testing/agent-fixtures
setAgentRuntimeForTesting({
  sdkModule: { [CLAUDE_PACKAGE_NAME]: createFakeClaudeSdk({ recorder, events: [...] }) },
});
const messages: AgentMessage[] = [];   // ← onMessage 是内容流（spec §2），与 onEvent 并行且独立
const records: SubagentRecord[] = [];  // ← onSubagent 是派发视图
const events: AgentEvent[] = [];
const result = await claudeCodeProvider.run(createRunInput({
  configHome,
  onMessage: (message) => messages.push(message),
  onSubagent: (record) => records.push(record),
  onEvent: collectEvents(events),
}));
// ConformanceProduct：messages / subagents / events / usage（result.turns、result.subagentTurns…）
//                     / result: { ok: result.ok, finalText: result.finalText }
```

**⚠️ 异步与同步的接缝（必须先定，否则会撞墙）**：`provider.run` 是异步的，而套件的
`ConformanceFixture.scenarios` 是**同步**的取值器。**不要去改套件签名**（那要动 11 组判据与两个模块），
也不必给套件加缓存——**fixture 自己先异步建好产物，再把同步取值器交给套件**：

```ts
const products = await buildAllScenarios();   // 顶层 await（vitest 支持 ESM 顶层 await）
describeProviderConformance({
  kind: claudeCodeProvider.kind,
  capability: claudeCodeProvider.metadata.messageCapability,
  scenarios: { 'plain-reply': () => products['plain-reply'], /* … */ },
});
```

这样还有一个附带好处：**每个场景的真实运行只跑一次**（套件会对每个场景多次 `build()`，
若取值器里现跑，11 组判据会把一次真实运行放大成十几次）。

**dsh 侧（已侦察的部分，2026-10-07）**：惯用法与 claude 同形——`createFakeDshSdk({ recorder, events })`
（选项：`hang` / `throwAfterEvents` / `createError` / `startError` / `onConstruct`）+ `DSH_PACKAGE_NAME`
（`./sdk`）+ `dshProvider.run(createRunInput({...}))`。`events` 是**真实的 `{ method, params }` 通知**。

已知的通知形状（逐字取自 `providers/message-conformance.test.ts:214-235`）：

```ts
{ method: 'session.event', params: { sessionId: 'session-main',
    event: { type: 'step/start', time: 1, data: { turn: 1, step: 1 } } } }
{ method: 'session.event', params: { sessionId: 'session-main',
    event: { type: 'assistant/message', time: 1, data: { turn: 1, step: 1,
      message: { id: 'cfc5cb78', role: 'assistant', content: [{ type: 'text', text: '…' }] } } } } }
```

**还缺四类形状**（下一步先读 `providers/dsh/index.test.ts`：思考块、工具调用/结果、`subagent` 工具调用与
子会话、用量与收尾）：那是 dsh fixture 的唯一剩余门槛。写法照 `claude-code/conformance.test.ts`——
它在第一次运行就 10/11 通过，可为模板。

**四类形状的权威清单**（逐条取自 `providers/dsh/message.ts:5-34` 的文件头，那是本仓对真机取值路径的
逐字记录；⚠️ 但它是**文档级**的，字段名仍需一次实测核对——claude 那份之所以一次通过，是因为形状是
**字面量样本**而非散文）：

| 场景 | 事件类型 | 取值路径 |
|---|---|---|
| 思考正文 | `assistant/message` | `data.message.content[]` 里 `{type:'reasoning', text}`（⚠️ `reasoning` 块**也带 `text`**，一律先按 `type` 过滤） |
| 工具调用 | `tool/call` | `data.{callId, name, arguments}`，`arguments` 是 **JSON 字符串** |
| 工具结果 | `tool/result` | `data.message.{toolCallId, content[], isError}`；**结构化结果在 `data.meta`**（有 `meta` 就不要退回解析文本） |
| 子任务 | `subagent.started` / `subagent/catalog` / `subagent.finished` | 身份 `agentId`（与 `childSessionId` 同值）；名称与 mode 只在 `catalog`（`childId`/`mode`/`label`）；终态**两格合读** `status` + `stopReason` |
| 子任务用量 | `assistant/message.data.usage`（按 `params.sessionId` 分组求和） | 子任务级用量**不在**子任务通知里 |
| 收尾答复 | `assistant/message` 的 `type==='text'` 块 | `outcome` 与 `finalText` 都只认 text 块（取消时可能只有 `reasoning`） |

信封一律是 `{ method:'session.event', params:{ sessionId, event:{ type, time, data } } }`；
`roundTrip` 取厂商的每会话 `step` 号（主会话从 1 数，不被别的会话推高）。

**2026-10-07 的一次受控尝试（9/11 通过，文件已删除，未提交）**：按上面清单写完 dsh fixture 后，
11 组里 9 组一次通过，两条红都**未判定**，故不留红文件、口径是「先定位再写」：

1. **用量不对称**：`plain-reply` 报「给了 `subagentTurns` 却把合计 `turns` 记成 null」——即 dsh 返回了
   分量轮次（0）而合计轮次是 `null`，正是判据要拦的方向（分量不可能比合计更清楚）。
   **未判定**：是 provider 的问题，还是我没取对合计字段（`AgentRunResult.turns` 在 dsh 上可能需要
   会话文件才有值）。**下一步**：先读 `dsh/index.ts` 里 `turns` 的返回处，再决定改 fixture 还是记缺陷。
2. **思考证明失败**：`thinking-full` 报「声明 `thinkingText=yes` 但场景里没有 thinking 块」，
   而 dsh 声明的正是 `thinkingTextSource: 'wire'`（`dsh/index.ts:649`）——即**走线就该拿得到**。
   **已核对（2026-10-07）**：`dsh/message.ts:129-142` 读的正是 `type === 'reasoning'` + `readString(block,'text')`
   → `thinkingBlockDraft(…, 'full', …)`，与我造的形状**逐字相符**
   ⇒ **这不是形状问题**，嫌疑转向**事件路由**：`assistant/message` 整类没被处理，而 `tool/call` / `tool/result`
   那两类到了（否则 `toolInput`/`toolResult` 两组也会红，它们却过了）。
   **最可能的原因**：`params.sessionId` 与我传的 `'session-main'` 对不上——夹具里那个常量是
   `DSH_SESSION_PLACEHOLDER = 'session-fake'`（`testing/agent-fixtures.ts:376`），假件用的会话号很可能就是它。
   **决定性的下一步实验**：把 fixture 的 `sessionId` 换成 `DSH_SESSION_PLACEHOLDER` 再跑一次。
   **✅ 实验已做（2026-10-07），结论：我自造的 `sessionId` 是两条红的共同根因**：

   | `params.sessionId` | 消息数 | 块类型 | 运行结果 |
   |---|---|---|---|
   | `'session-main'`（自造） | 0 | — | `turns=null`、`finalText=null` |
   | `DSH_SESSION_PLACEHOLDER`（假件的会话号） | 1 | `thinking,text` | `turns=1`、`finalText=答复` |

   ⇒ 自造会话号会让**整类会话事件被静默丢弃**：消息 0 条、合计轮次采不到、`finalText` 为 `null`；
   而**工具那两组判据照样过**（它们不看消息），于是红在「思考块不存在」这种误导性位置。
   用量那条红（分量 0 而合计 null）**也是同一个根因**——事件全丢时合计采不到，分量默认 0。
   **判定**：不是 dsh 的缺陷，也不是块形状问题，是 fixture 的会话号没与假件对齐。
   **教训**：会话号这类「看不见的匹配键」错了，症状会伪装成完全无关的判据失败；写 fixture 时
   凡是有「必须与假件一致」的常量，优先直接用夹具导出的那个（`DSH_SESSION_PLACEHOLDER`），不要自造。

**2026-10-07 第二次受控尝试（10/11，文件已删除，未提交）**：修好会话号后重跑，思考 / 用量 / 时序 /
最终答复 / 结构化全部转绿，**只剩子任务那一格**：`声明 subagent=yes，但 subagent 场景没有产出子任务行`。

已确认并可直接复用的两条形状事实（本轮从实现里读出来的，不是猜的）：

1. **子任务身份在 `params.subagentId`，不在 `data` 里**——`dsh/message.ts:249-251` 逐字：
   「`subagent.started` 的 `params.subagentId` 与随后子会话事件里的 `params.sessionId` **同值**
   （都是那个裸 UUID），而主会话是另一种形状（`session-<32 位 hex>`）」。
   ⇒ 子任务事件的信封应是 `params: { sessionId, subagentId, event: { type, time, data } }`，
   子会话自己的消息则用 `params.sessionId = <子任务身份>`。**改完仍不产出子任务行**，
   说明记录不是这一条路径产出的。
2. **子任务记录很可能与 claude 同构、不在消息归一里**：`message.ts` 的子任务段落处理的是
   `outcome` / 子任务用量（§4.3 步骤 4），而派发面板那一侧的 `SubagentRecord` 大概率由 **run 路径
   （`events.ts` / `index.ts` 的投影）** 产出。
   **下一步**：读 `dsh/index.ts` 里 `onSubagent` 的调用处（那才是记录的真源），或直接取
   `dsh/index.test.ts` 里收集 `records` 的那个用例的**输入事件字面量**——claude 那份 fixture 一次
   通过靠的就是这种字面量样本。

**2026-10-07 第三次受控尝试（10/11，文件已删除，未提交）**：按上一条指向修好后，**子任务那一格转绿**
（记录由 `dshSubagentRecord` 产出，读法见下），红移到最后一格，而这一格是**真发现**。

**已确认的形状事实（写 fixture 直接可用）**：

- **子任务事件是顶层 `method`**：`subagent.started` / `subagent.finished`，**不是** `session.event`
  里的 `event.type`。依据 `dsh/message.ts:313-316`：`readString(notification,'method')` 与
  `DSH_SUBAGENT_STARTED_METHOD` / `DSH_SUBAGENT_FINISHED_METHOD` 比对，不匹配直接 `null`。
- **身份取 `params.subagentId`**（三级兜底 `subagentId` → `agentId` → `childSessionId`，`message.ts:328-333`）；
  子会话自己的 `assistant/message` 用 `params.sessionId = <子任务身份>`。
- **终态两格合读**：`params.status` + `params.stopReason`，`ok` + `completed` ⇒ `completed`（映射表 `message.ts:305-311`）。

**🔴 真发现：dsh 声明 `streamingDelta: 'yes'`，但适配器从不产出 delta 消息。**

- 证据：`dsh/index.ts:648` 声明 `streamingDelta: 'yes'`、`:657` 声明 `streamingDeltaSource: 'wire'`
  （无前置条件）；而 **dsh 全目录除这两行声明外不存在任何 delta 处理**——
  `grep -n "delta\|Delta" packages/server/agents/src/providers/dsh/message.ts` **零命中**，
  即消息归一只产出 `chunk: 'snapshot'` 的草稿。
- 判据来源：套件「能力声明与产物互钉」（§2.7）要求「声明 `yes` ⇒ 必须造得出」。
- 这正是 F 类（能力声明诚实性）的实例：**同一条判据在 codex 与 claude 上都过，到 dsh 才红**——
  单写一家的测试永远发现不了。
- **收口方式（2026-10-07 补充事实后收敛为三选一，需产品决策，不要擅自选）**：
  已核实的事实：① 适配器认识的事件类型里**没有任何增量类**（只有整块的 `assistant/message`、
  `tool/call`、`tool/result`、`subagent.*`）；② `dsh/index.ts:660` 的 notes 自述「本路由不产出
  `reasoning-delta`，推理整块在 `block-end` 到达」⇒ **本路由是块粒度投送**；③ 本仓**没有 dsh 的
  真机转储**（`probe/dumps` 下 0 个 dsh 文件），故「厂商到底流不流」这件事**没有证据**。
  | 候选值 | 语义 | 何时选它 |
  |---|---|---|
  | `'no'` + `not-supported` | 厂商就不支持逐字增量 | 若确认 wire 只有整块事件 |
  | `'off-by-adapter'` + `not-observed` | 厂商有、我们没接 | 若 wire 有增量事件而适配器没处理（那就该去接上，而不是改声明） |
  | `'unverified'` + `unverified` | 我们没验过 | **在没有转储、无法判定时的诚实取值** |
  方案主张：**宁可说没有/没验过，也不要说「拿得到」而实际拿不到**——后者会让消费方按「有增量」
  画一个永远不动的打字机光标。
  要判定，最省的一步是取**一次 dsh 真机转储**（跑一次带 dsh 行的评测并落盘），
  看事件流里有没有逐字增量事件；有 ⇒ 去接上（`off-by-adapter`），没有 ⇒ 改 `'no'`。

  **2026-10-07 又补一条本地证据（不必花钱）**：本仓已装的 `@deepseek-ai/dsh-sdk-client`
  （`node_modules/.pnpm/@deepseek-ai+dsh-sdk-client*`，18 个文件）里 **`delta` 零命中**
  ——SDK 自己暴露的协议面上没有增量类事件。它与上面两条一致，三条证据都指向「这条路由不投送逐字增量」。
  ⚠️ 但**仍不等于证明**：SDK 可能透传未类型化的事件。故取值保守到 `'off-by-adapter'`
  与 `'unverified'` 之间仍应由一次真机转储裁定，**不要用「本地没搜到」当厂商事实**。
- ⚠️ 在选定之前，dsh 的 fixture **无法全绿**（这条红是真阳性）；不要在 fixture 里绕过它。

**教训（写给下一个执行者）**：散文级形状足以写出**接近**正确的 fixture（9/11），但要一次调绿，
关键那几格必须拿到**字面量样本**。两条红都不是"看不懂"，而是"两种可能各自成立、需要一次判定"——
这种情况下不要猜着改，先定位。

**假件的选项与导入（逐字，省一次侦察）**：

```ts
// 假件：testing/agent-fixtures.ts:176
interface FakeClaudeSdkOptions {
  recorder: FakeVendorRecorder;        // createRecorder()
  events: readonly unknown[];          // 本次运行按顺序吐出的原始消息
  interrupt?: 'stop' | 'ignore';       // 忽略停止信号，模拟非合作适配器
  interruptRejects?: string;           // interrupt() 以该原因拒绝（钉 handler 有没有吞掉它）
  hang?: boolean;                      // 吐完后挂住（测超时与终止）
  throwAfterEvents?: unknown;          // 吐完后抛出（模拟进程非零退出）
}

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentEvent, AgentMessage, SubagentRecord } from '@aieval/contracts';
import { setAgentRuntimeForTesting } from '../../runtime';
import { collectEvents, createFakeClaudeSdk, createRecorder, createRunInput } from '../../testing/agent-fixtures';
import { claudeCodeProvider } from './index';
import { CLAUDE_PACKAGE_NAME } from './sdk';
import { describeProviderConformance, type ConformanceProduct } from '../conformance/kit';
// 收尾要还原：afterEach(() => { setAgentRuntimeForTesting(null); })，临时目录用 testing/cleanup.ts 的
// removeTreeWithRetry（claude 的 configHome 不放会堆满 tmp）。
```

**原始消息形状（逐字取自 `providers/message-conformance.test.ts:181-198` 与 `events.test.ts:822-846`）**：

```ts
// 流式增量（只覆盖主会话）：先 message_start，再 content_block_delta，最后全量 assistant
{ type: 'stream_event', uuid, event: { type: 'message_start', message: { id: 'msg_1' } } }
{ type: 'stream_event', uuid, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '没问题' } } }
{ type: 'assistant', uuid, parent_tool_use_id: null, message: { id: 'msg_1', role: 'assistant', content: [{ type: 'text', text: '没问题，工具已就绪。' }] } }
// 工具：调用在 assistant 里，结果在 user 里
{ type: 'assistant', uuid, message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] } }
{ type: 'user',      uuid, message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: '…' }] } }
// 收尾（`finalText` 与用量都从它来）
{ type: 'result', subtype: 'success', result: '…', usage: { input_tokens, cache_read_input_tokens, output_tokens } }
// 子任务（真机逐字，见 §十）：system/task_started 与 system/task_notification
```

## 十二、交接（给下一个执行者）

### 已完成，带提交可查

| 产物 | 提交 | 复现命令 |
|---|---|---|
| 契约层套件（11 组判据） | `089c627` | `pnpm vitest run packages/server/agents/src/providers/conformance` |
| 套件自测（25 条：7 正例 + 18 反例） | `089c627` | 同上 |
| codex 接入 | `c169b0b` | `pnpm vitest run packages/server/agents/src/providers/codex/conformance.test.ts` |
| 静态层打包器免疫守卫 | `750a7d6` | `pnpm vitest run packages/server/agents/src/static-assertions.test.ts` |
| 真机冒烟五格 | `6afbbd3` `4f6c344` | 见 §8.1 的 README 命令（默认跳过） |
| README §8.1 接入清单 | `fd80275` | — |

整体自洽核验（含并发会话的在途改动）：`pnpm vitest run packages/server/agents` ⇒ **37 passed / 1 skipped（632 tests）**。

### 尚未完成的两项，以及各自的真实门槛

**(1) claude-code / dsh 接入套件** —— 门槛比初稿估的**高一档**（2026-10-07 实测修正）：claude 的 `SubagentRecord` **不在消息归一里**，而是在 `index.ts` 的 **run 路径**上产出（`events.ts:145` 的注释点名：「面板与 `messages.jsonl` 走 `message.ts` 的 `SubagentRecord`」，收集点在 `index.test.ts:1064` 的 `records` sink）。
⇒ fixture 必须驱动 **run 级测试台**（codex 侧对应物是 `index.test.ts` 的 `collect()` + 假 app-server；claude 侧要用 `setAgentRuntimeForTesting` 注入假 SDK 模块），**不是**「读两个文件的样板照抄」。
已就位（§十）：claude 的消息归一入口、`state.finalText` 的设值路径、工具块与流式增量形状、`task_*` 逐字真机形状，以及那条**误导性红因**（造了 `task_*` 却拿不到 `subagents` 会红在「能力互钉」上，看起来像能力声明写错，实际是子任务行不在消息层）。
**下一步**：照 `claude-code/index.test.ts:1040-1130` 的 run 台写法（注入假 SDK + 收集 `records` 与 `messages`）搭 fixture 骨架 → 按 §三 的 12 个场景补齐。dsh 侧尚未侦察，预计同样是 run 级。

**(2) 夹具时序保真（C 类）** —— ✅ **已落地**（`4df9a7a`），设计定案见 §十五。关键决定：判据**不建在 fixture 自述上**（「我缓冲了通知」谁都能填），建在**传输层事件序列**（谁先谁后 + 消费方实际收到什么）上——那是唯一可机械核对的事实。四条判据 + 7 条自测（三条真故障形态各有反例），已接进套件（`transport` 可选字段 + `checkTransportDeliveryGroup`）。
留白与 §2.11 同：**消息级 fixture 录不到订阅与响应**，给不出笔迹 ⇒ 该组对它空转；传输层真机那一侧由 `live-smoke.test.ts` 的 ①/③ 格与各家自己的传输用例守。

### 当前阻塞条件（如实记录）

`packages/server/agents/src/providers/conformance/kit.ts` 自本轮系列的第 5 轮起一直被**另一个会话**以未提交状态持有（同时持有 15 个文件，含 `kit.test.ts`、`codex/conformance.test.ts`、`codex/events.ts`、`agents/src/types.ts`、`evaluator/src/judge-agent.ts`、`docs/codex-faq.md`、parity spec）。上面 (1)(2) 都要落在这个包上，改它就是打架 ⇒ **等对方提交后再动**。

## 十四、结构化输出（智能体作为评分者）

**为什么单列**：评分通路只读 `AgentRunResult.finalText`，并要求它是**可解析的 JSON**——「结构化输出」就是把这一步从「靠模型自觉吐 JSON」变成「厂商保证形状」的那条路。功能本身的实现设计见 `docs/superpowers/plans/2026-09-28-structured-judge-output.md`（Task 1–9：`outputSchema` 入参、三家落点、evaluator 转发与记账、编排层的**有痕降级**）。**本节只定义验证点，不改那条设计。**

### 14.1 三类缺陷与对应判据

| # | 缺陷形态 | 判据落在哪一层 |
|---|---|---|
| 1 | 声明 `structuredOutput: true`，但请求里**没带 schema** | 契约层：fixture 记录的请求要点里必须含 schema（与能力声明互钉） |
| 2 | schema 带上了，结果侧**不认厂商的结构化产出**（落到推理内容 / 工具输出 / 空串） | 契约层：`structured-output` 场景的 `result.finalText` 必须 **`JSON.parse` 成功**且等于期望对象 |
| 3 | 厂商不支持、或重试用尽 ⇒ **静默给空结果** | 契约层 + 真机：解析失败必须**有痕**（明确失败码 / `error` 事件），不许静默回落成空评分 |

### 14.2 降级路径同样要判

否则「不支持结构化的那一家」永远评不了分。`structuredOutput: false` 时允许 `finalText` 是**从文本里提取的 JSON**，但必须同样满足「可 `JSON.parse`」。这与 claude 已有的出口口径一致（`providers/claude-code/events.ts`：`structured_output` 优先于 `result` 文本；两者内容不同 ⇒ 落一条不一致 WARN；`structured_output` 为 `null`/空串 ⇒ 按「没有结构化产出」回落 `result`）。

### 14.3 契约层要加的东西

- fixture 增加一个场景 **`structured-output`**；
- fixture 增加一个可选字段 **`requests`**：记录本次运行发往厂商的请求要点（至少 `hasOutputSchema: boolean`）。这是 B 类「传输」在契约层的**可判定形态**——「schema 真的带上了」除了真机没有别的验法，而它在假件里至少可判定；
- 新增判据 **`checkStructuredOutput`**，四条：
  1. 能力声明 `structuredOutput === true` ⇒ `requests` 里 `hasOutputSchema === true`（声明与请求互钉）；
  2. `structured-output` 场景的 `result.finalText` 能 `JSON.parse`；
  3. 解析出的对象与 fixture 声明的期望逐字段相等（**不许是拼接/改写过的文本**）；
  4. 形如「厂商返回解析失败」的场景必须带痕（失败码或 `error` 事件），**空结果不算带痕**。

### 14.4 真机冒烟要加的一格

在 `AIEVAL_LIVE_AGENT_JUDGE=1` 档下新增**第 ⑥ 格**：评分记录里 `structuredOutput === true`，且其 `raw` 能 `JSON.parse`；同时断言没有 `JUDGE_PARSE_FAILED` 一类解析失败码。
这是**真机唯一能证明「评分者确实按 schema 作答」**的地方——契约层验的是归一产物，验不到厂商那一侧真的收到了 schema。

### 14.5 边界（必须写明，别误读）

本方案能证明的是**链路**：schema 带上了、产出可解析、失败有痕。**证明不了「评分结论是否正确」**——`packages/server/agents/src/permission.ts:94` 记的盲评案例正是「链路全通（`ok`、`judgments` 齐、`structuredOutput: true`）、结论全错」。评分质量属另一层（评分器设计 / rubric / 模型能力），本方案不覆盖；**不得以「结构化通了」代替「评分对了」**。

### 14.6 真机证据（2026-10-07）

`AIEVAL_LIVE_AGENT_JUDGE=1` 档、codex 行 + **codex 作评分者**，一次完整跑（341s）六格全通过：

```
run 65d93cba  run.status=done  row.status=judged      Test Files 1 passed · Tests 6 passed
score.structuredOutput = True（Boolean）              ← 走的是结构化通路，不是文本降级
score.judgeAgentKind   = 'codex'                     ← 评分者就是刚重构过的这一家
score.judgeProviderId  = baf094b1…（deepseek-openai） judgeModelId = deepseek-flash
score.totalScore = 57 / 57   verdict 272 字   raw 1957 字且可 JSON.parse
```

三点值得记：

1. **结构化通路真的通了**：早先同一套冒烟跑出的是 `structuredOutput=False` + `judgeAgentKind=''`（走文本降级、评分者信息为空），现在同一格是 `True` + `'codex'` —— 这两格一起变，说明「评分者按 schema 作答」这件事**被记录下来了**，而不只是产物恰好能 parse；
2. **codex 能当评分者**：重构后的这一家既做被测者又做评分者，两条路都跑通；
3. **⑥ 格的断言设计被真实取值检验过**：它不假设一定走结构化（降级路径同样要过），而这一跑恰好走的是结构化那条 —— 两条通路都已被真机覆盖过一次。

### 14.7 落地状态（2026-10-07 结）

| 判据 | 落点 | 状态 |
|---|---|---|
| 四条判据本体 | `providers/conformance/structured-output.ts` | ✅ `49bb534`，自测 11 条（4 正例，两条通路各有专条 + 7 反例） |
| 接进套件 | `kit.ts` 的 `checkStructuredOutputGroup` + 用例注册 | ✅ `0152080`，另加 3 条套件级自测（含「红时点名到场景」） |
| 真机 | `live-smoke.test.ts` 第 ⑥ 格 | ✅ `9d36df2`，真跑通过（§14.6 证据） |
| 文档 | 本节 + §14.1–14.5 | ✅ `33b3b13` / `186cf89` |

**一条刻意的留白**：codex 的 fixture **不给 `structuredOutput` 探针**（该字段可选，给了才判）。理由是它属**消息级** fixture——把协议载荷喂进归一函数，**看不到发往厂商的请求**，硬填 `hasOutputSchema: true` 就是自述，属无区分力的假判据。给不出就不给，这一组对 codex 空转；真机那一侧由第 ⑥ 格守（它验的正是「评分者按 schema 作答」）。
⇒ **要让它对某家真正生效**，需要 run 级 fixture（能录下 `turn/start` 之类的请求），也就是 §十二(1) 里 claude/dsh 接入所需的那套 run 台——两件事共用同一份基础设施。

## 十五、C 类（协议时序）判据的设计

**判据载体：传输层笔迹**（`providers/conformance/transport.ts`）。

```ts
interface TransportTranscript {
  steps: { kind: 'subscribe' | 'push' | 'response' | 'terminal'; id?: string }[];  // 按真实发生顺序
  observed: string[];                                                              // 消费方实际收到的 id
}
```

四条判据（缺一不可）：

| # | 判据 | 对应的真故障 |
|---|---|---|
| 1 | **订阅前推送不得丢失**：凡在 `subscribe` 之前产生的 `push`，消费方都必须最终收到 | 厂商在提示词发出后立刻推送，而消费方还没订阅 ⇒ 必须缓冲后补投 |
| 2 | **终态不得早于响应**：同一轮的 `terminal` 必须排在它的 `response` 之后 | 终态与「请求返回」写在同一 tick ⇒ 收尾看到半截状态（单测 40 秒超时的真因） |
| 3 | **不得重复投递**：同一条通知只许到达一次 | 补投与直投各来一次 |
| 4 | **不得凭空冒出**：`observed` 里的每条都必须在笔迹里出现过 | 消费方收到厂商从未发过的条目 |

**为什么不做成 fixture 自述**：自述（「我缓冲了通知」）谁都能填，是没有区分力的假判据。能判的只有**事件发生的先后**这一事实。这也是本方案唯一一次把判据建在「过程」而不是「产物」上——C 类的缺陷本来就只存在于过程里。

**两条踩过的坑**（都留在自测里）：
1. **「厂商发过」必须算上终态**：第一版只把 `push` 算作发过，于是合法的终态 id 被第 4 条判成「凭空冒出」——自测当场抓到（这就是「每条判据都要见过失败」的价值）；
2. **消息级 fixture 给不出笔迹**：直接喂载荷的那类 fixture 看不到订阅与响应，`transport` 字段因此是**可选**的——给不出就不给，不许自述。

## 十六、dsh 那条真缺陷的收口（2026-10-07 结）

**判定：`not-projected-by-vendor` + `not-exposed`。厂商侧有该数据，但不投送到我们订阅到的通道。**

> ⚠️ 本节的第一版判定曾是 `off-by-adapter`（照文档推的），**已被真机实测推翻**。保留这段过程是因为它本身是结论：
> **文档说的层 ≠ 我们能拿到的层**——文档描述的是 LLM 层与会话日志层，我们消费的是 SDK 订阅到的通知层。
> 凡「厂商有没有」的判定，必须落到「我们能不能拿到」，只查文档最多得出「某层有」。

判定依据（两条外部权威资料，不必跑真机就已决定）：

- dsh 官方 `docs/core-data-structures/llm-streaming.md` 给出 `StreamChunk` 的完整定义，其中明确有
  `{ type: 'text-delta'; index; text }`（还有 `reasoning-delta` / `tool-call-delta`，`block-end` 才带装配好的整块）；
- 官方手册的会话日志页说明 rc.8 默认把连续同块增量压成 `text-chunks` 行，展开即 `assistant/chunk` 的
  `text-delta`（并给了 `{"type":"text-chunks",…}` 的实例）。

而本仓 `providers/dsh/message.ts` 只认整块 `assistant/message`、**全文件 `delta` 零命中** ⇒ 我们从不产出
`chunk: 'delta'`。**所以这一格不能记 `'no'`**（那是断言厂商没有）；也正因为本地三条证据（适配器不认增量类、
notes 自述块粒度、已装 SDK 里 delta 零命中）都只能证明「我们没接」，不能证明「厂商没有」，
当初才没有擅自选值——**最终是外部资料把「厂商那一侧」这件事定下来的**。

落地：`dsh/index.ts` 改 `streamingDelta: 'off-by-adapter'` + `source: null` + `reason: 'not-observed'`，
并在 `notes` 第一条写明「运行时**有** `assistant/chunk` 的 `text-delta`，接上之前界面不得按有增量渲染」。
判据：套件第 7 组 + `providers/dsh/conformance.test.ts` **11/11 全通过**（`48ee775`）。
台账：`docs/deepseek-harness-faq.md` 首条（现象原文做标题，含两处资料链接）。

**遗留（可独立排期，不影响本方案收口）**：接上 `assistant/chunk` 的增量通道后，把这一格改回 `'yes'`
并给 fixture 补一个含 delta 的场景——那时它会从「声明诚实」升级成「声明为真」。

## 十七、不做什么

- **不写「假 SDK 的单元测试」来替代真机**：本次 A/B 类缺陷就是这么漏过去的。假的东西只能验形状，验不了「真的传到了」。
- **不为通过套件去放宽断言**：规范里没写的能力**必须**声明为 `no`/`unverified` 并给 `MissingReason`，不许用「近似值」顶替（§1.3 三条全局约定）。
- **不把 probe/** 的探针脚本纳入套件**：它们是历史记录，不是门禁（见 `docs/superpowers/plans/2026-10-05-codex-appserver-refactor.md`）。
