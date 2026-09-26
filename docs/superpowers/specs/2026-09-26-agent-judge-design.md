# AI 生成代码评测工具 —— 智能体评分设计

> 前置阅读：`docs/superpowers/specs/2026-09-22-features-design.md`（三功能域总体设计）、
> `docs/superpowers/specs/2026-09-22-scaffold-design.md`（分层与边界）。
> 本文只描述**本次新增**的部分；与既有 spec 冲突之处，以本文为准并在 §3 逐条说明。

## 1. 要解决的问题

1. **大改动评不了分。** 评分走纯文本 API：评分提示词 + 代码改动 + 维度定义一次性塞进一次请求。
   改动量超过模型上下文窗口时只有两条路——请求直接失败，或按 `diffBudgetBytes`（默认 256 KB）
   裁掉一部分文件。后者更危险：**分数照样出得来，只是它在不完整的输入上得出**，看起来与正常分数
   没有区别。要评大改动，必须让评审者自己去仓库里看，而不是我们把改动压成一段文本喂给它。
2. **评分这一步没有重试出口。** 今天 `isRunnableRow` 把 `judged` 排除在外，而一次评分失败
   （`JUDGE_PARSE_FAILED`、评分超时、服务重启打断成 `interrupted`）之后，除了**新建整轮评测**
   （连带重跑候选 agent，分钟级成本）没有别的路。评分本身是一次廉价的、可重复的动作，
   它不该和「重跑候选」绑在一起。

## 2. 本阶段范围

**做：**

- 设置页「评分配置」在「默认评分模型」下方增加「默认评分智能体」（Claude Code / Codex / DSH，可清空）；
- 创建评测表单增加「使用智能体评分」开关（antd `Switch`，默认关闭）；
- `agents` 包补上「智能体的最终答复」出口（今天这个值被丢弃）；
- 评分新增第二条通路：由评分智能体在**该行工作区**里自行查看改动并给出 5 维 JSON；
- 行级「重新评分」：只重跑评分步骤，带二次确认。

**不做（本期明确排除）：**

| 不做的事 | 理由 |
|---|---|
| diff 超过阈值自动改走智能体评分 | 用户口径：超限只是动机，不落成行为。是否走智能体**完全**由创建评测时的开关决定，一轮里只有一把尺子 |
| 一轮内混用两种评分方式 | 同上。开关是轮级的，创建后不可改（沿用执行模式的既有口径） |
| 评分智能体自带一套供应商 + 模型 | 复用「默认评分模型」那一对（用户口径）。好处之一是 R14 接缝表达式一个字都不用改，见 §3 |
| 用例级覆盖评分智能体 | 用例上已有评分模型覆盖，再加一层智能体覆盖会让「这一分怎么来的」需要查三处配置 |
| 重新评分时切换评分方式 | 用户口径：沿用本轮模式。代价见 §14 第 5 条 |
| 评分智能体的独立计量快照 | 快照里的 `tokens` 是**候选**的计量，混入评分消耗会让「这个模型多省」这个结论失真。评分智能体的用量只转发成日志行 |
| 评分维度自定义 | 沿用「本期固定 5 维等权」 |

## 3. 关键决策与理由

| # | 决策 | 被否决的替代 | 理由 |
|---|---|---|---|
| D1 | 评分智能体复用「默认评分模型」那一对 `(providerId, modelId)`，只额外选「用哪家 CLI 驱动」 | ① 评分智能体自带独立供应商 + 模型；② 每轮在表单里单独选 | ② 会把「一个 Switch」变成一组选择器，与用户口径直接冲突。① 需要多一组下拉并解释两组配置的关系。复用之后，「评分路由怎么解析」这件事**完全不变**——`resolveJudgeRoute`（用例覆盖 > 全局默认，四种中文 CONFLICT）与 `orchestrator.ts:552` 那对**被 R14 守卫钉死为恒等**的优先级表达式一个字都不用改 |
| D2 | 智能体的最终答复走**新的结果字段** `AgentRunResult.finalText` | ① 让评分智能体把 JSON 写进工作区的约定文件，我们读文件；② 从 `log` 事件流里重建答复 | ② 不可靠：codex 发的是**增量 delta**、dsh 的 assistant 文本今天**根本没被投影**（`providers/dsh/events.ts` 的 `assistant/message` 分支只取用量）。① 多一个失败模式（它没写/写错名），且「查看改动」抽屉是**按需现算工作区 diff** 的，那个文件会显示成候选自己创建的。D2 是唯一一条三家统一、且不引入新失败面的通道 |
| D3 | `EvalRun.useAgentJudge` 在**创建时快照**，运行中不可改 | 评分时读当前设置 | 沿用执行模式（`executionMode`）的既有口径。运行中改开关会让同一轮里前后两行用不同的尺子，而它们的分数会被并排比较 |
| D4 | 评分方式也记进**行级**的 `ScoreResult.judgeAgentKind` | 只记在 `EvalRun` 上 | 轮级字段回答「这一轮打算怎么评」，行级字段回答「这一分实际是谁打的」。冗余快照的同一理由（features spec §7.2）：配置改了之后，历史行仍要能说清自己的分是怎么来的 |
| D5 | 新增的两个快照字段一律 `.default(...)` | 必填 | **载重决定**：`run-store.ts:50` 用 `EvalRunSchema.safeParse` 读盘，任何必填新字段都会让磁盘上已有的 `run.json` 解析失败 ⇒ `listRuns()` 静默跳过（只记 WARN）、`getRun()` 抛 INTERNAL。老评测必须照样能读 |
| D6 | `RunCreateSchema` 里**显式声明** `useAgentJudge` | 靠 zod 的 `passthrough` 或默认行为 | zod 3 的 `z.object` 默认 **strip 未知键**：不声明的话，表单提交的开关会被**静默丢弃**（不是 400），服务端永远收不到它 |
| D7 | 评分智能体跑在**该行现有工作区**里 | 另建一份只读副本 | 副本要再复制一次整个仓库（大仓是分钟级与 GB 级）。代价（它可能改动工作区）见 §14 第 1 条，用「提示词只读要求 + 评后 diff 摘要对照」如实标注，不静默兜底 |
| D8 | 评分智能体用**独立的**配置目录 `.judgehome` | 复用该行的 `.agenthome` | 评分智能体可能与被测智能体不是同一家；`.agenthome` 是 `CLAUDE_CONFIG_DIR` / `DSH_HOME` / `CODEX_HOME` 的落点，两家格式不同，共用一个目录会互相破坏 |
| D9 | 评分阶段的外层兜底**必须另起一套** | 沿用候选 agent 阶段那个 backstop 定时器 | 那个定时器在候选 agent 阶段结束后就被 `clearTimeout` 了。而 `turn.ts` 的 JSDoc 明写 `runTurn` **可能无界返回**（`dispose` 只能尽力让迭代结束），评分阶段没有外层兜底就会永远停在 `judging` |
| D10 | 重新评分**追加**事件，不 `resetEvents` | 像重跑那样清空日志 | 事件日志是执行的唯一真相源（features spec §7.4）。重新评分是「同一个工作区上的第二次评分」，把第一次的证据删掉等于抹掉历史 |
| D11 | 重新评分沿用本轮模式 | 让用户当场选 | 用户口径。代价见 §14 第 5 条 |
| D12 | `AGENT_KINDS` / `AgentKindSchema` / `AGENT_LABELS` 从 `run.ts` 拆到新的 `contracts/src/agent.ts` | ① 直接在 `score.ts` 里写一份 `z.enum([...])`；② 让 `score.ts` 直接 import `run.ts` | ① 是第二份真源，违反 features spec §11 R1。② 成环：`run.ts` 已经 import `score.ts`。拆出后 `run.ts` 原样再导出，`index.ts` 的 barrel 出口不变，**所有现有 import 零改动** |

## 4. 契约变更（`packages/server/contracts`）

### 4.1 新增 `src/agent.ts`

`AGENT_KINDS` / `AgentKindSchema` / `AgentKind` / `AGENT_LABELS` 四个成员从 `run.ts` 原样搬过来（只依赖 zod）。
`run.ts` 用 `export { … } from './agent'` 再导出，`index.ts` 的出口清单不变。

### 4.2 `settings.ts`

```ts
export const SettingsSchema = z.object({
  // …既有字段…
  /** 默认评分智能体：null = 未配置（此时「使用智能体评分」的评测会在创建时被拦下） */
  defaultJudgeAgent: AgentKindSchema.nullable(),
});

export const SETTINGS_DEFAULTS: Settings = {
  // …既有默认值…
  defaultJudgeAgent: null,
};
```

**不需要改的**：`SettingsPatchSchema`（`SettingsSchema.partial()`）、`PUT /api/settings`（无字段白名单，直通 `SettingsPatchSchema.parse`）、
`useSettings()`（SWR key 是字面量）、设置页的 `changeSettings`。`api/settings.ts` 的 `normalize()` 会自动给老配置补 `null`。

### 4.3 `run.ts`

```ts
export const RunCreateSchema = z.object({
  // …既有字段…
  /** 这一轮是否由评分智能体评分；缺省 false（老客户端与手工 POST 不带这个字段时仍然合法） */
  useAgentJudge: z.boolean().default(false),
});

export const EvalRunSchema = z.object({
  // …既有字段…
  /** 创建时的评分方式快照；`.default(false)` 是载重的：磁盘上已有的 run.json 没有这个字段，必须有默认值才读得出来（D5） */
  useAgentJudge: z.boolean().default(false),
});
```

新增纯函数（服务端与界面**共用同一份**判据，避免两处漂移）：

```ts
/**
 * 该行能否「重新评分」：不重跑候选 agent，只在既有工作区上重跑评分步骤。
 * 三个条件缺一不可：
 *   · 不在运行中（preparing / running / judging）——正在跑的行有自己的生命周期；
 *   · baselineCommit !== ''——prepare 阶段成功过，diff 有可比基线；
 *   · diff !== null——第 6 步（collectDiff）跑过，说明 agent 阶段已结束。
 * 于是 judged / failed / timed-out / canceled / interrupted 都可重评，
 * 而 pending / skipped 会得到「该行还没跑过」的明确拒绝。
 */
export function canRescoreRow(row: EvalRow): boolean;
```

### 4.4 `score.ts`

```ts
export const ScoreResultSchema = z.object({
  // …既有字段…
  /** 这一分是哪个智能体打的；null ⇔ 走纯文本 API（磁盘上已有的评分记录也落在 null，故必须有默认值） */
  judgeAgentKind: AgentKindSchema.nullable().default(null),
});
```

## 5. 设置页「默认评分智能体」

`packages/client/ui/src/composite/judge-settings-card.tsx` 在「默认评分模型」那个 `Form.Item` **下方**加一个同形的 `Form.Item`：

- 控件：antd `Select`，`aria-label="默认评分智能体"`，`allowClear`，`size="small"`（随卡片），选项来自 `AGENT_KINDS` + `AGENT_LABELS`。
- 清空 → `onChange({ defaultJudgeAgent: null })`（与 `defaultJudge` 的「null 即未配置」同一口径）。
- **协议兼容是硬约束**（D1 的直接后果）：Codex 只吃 OpenAI 兼容、Claude Code 只吃 Anthropic 兼容、
  **DSH 两条都吃**（2026-09-30 起：适配器统一走 `llm-pi-ai` 路由，`anthropic → anthropic-messages`、
  `openai → openai-responses`，两条 wire 都真机跑通过——见契约 §11 的 **R37 收口** 与
  `docs/superpowers/notes/2026-09-30-dsh-pi-ai-route-probe.md`）。
  不兼容的智能体在该下拉里 `disabled` 并在标签上写明原因；已存的值变成不兼容时，
  照抄现有「悬空」那套红色 `Alert` 模式给一条点名两个 id 的告警。
  ⚠️ 判据是**集合**：`acceptsProtocol(metadata, protocolType)` / `accepted.includes(judgeProtocol)`，
  不是 `metadata.protocolType === …`。
- **协议表只从注册表元数据来**：设置页调 `useRunModelOptions()`（已存在的 client hook）拿到
  `{ agentKind, protocolTypes }[]` 传给卡片。`ui` 包里**不写**「哪家智能体配哪种协议」这张表——
  那是 `agents` 注册表 + `api/runs.ts` 的 `listAgentModelOptions()` 的职责（features spec §5.6.2 A3）。
  拿不到这份数据时**不拦**（列出全部），服务端仍有一道校验（§6）。
- 新增提醒：**默认评分模型未配置或悬空**时，这个下拉照样可用（用户可以先选智能体）；
  兼容性判据只在「能确定默认评分模型的协议」时才生效。
- **保存不被阻止**：服务端不拒收「智能体与默认评分模型协议不匹配」的组合——两个下拉可以按任意顺序填，
  填一半就报错会让人没法保存中间状态。拦截发生在**创建评测**（§6）与**评分**（§7.3）两处。

`JudgeSettingsCardProps` 增加一个可选 prop：`agentProtocols?: { agentKind: AgentKind; protocolTypes: readonly ProtocolType[] }[]`
（**2026-09-30 由 `protocolType: ProtocolType` 改为集合**，与 `AgentProviderMetadata.protocolTypes` 同形。
把集合当单值用（`accepted[0] !== judgeProtocol`）会让 DSH 这种双协议智能体被误判成不兼容，
`judge-settings-card.test.tsx` 有一条「双协议智能体的选项**不**被禁用」专门钉住它。）

## 6. 创建评测表单「使用智能体评分」

`packages/client/ui/src/composite/run-create-panel.tsx`：

- 在「执行模式」之后加 `Form.Item name="useAgentJudge" label="使用智能体评分" valuePropName="checked"` + `<Switch />`；
  `initialValues` 里 `useAgentJudge: false`（用户口径：默认关闭）。
- `handleFinish` 的 payload 补上 `useAgentJudge: values.useAgentJudge ?? false`。
- **开关打开而设置页没配默认评分智能体**时给一条内联 `Alert` 指出路——否则要等候选 agent 跑完
  几分钟之后才在评分步骤炸（与「模型池为空」同一条口径：不要让人选完到运行时才失败）。
  为此 `RunCreatePanelProps` 增加 `judgeAgentConfigured?: boolean`（`runs` 页从 `useSettings()` 派生）。

**创建时服务端再拦一次**（`api/src/runs.ts` 的 `createRun`）：`useAgentJudge === true` 时校验

1. `settings.defaultJudgeAgent` 非空；
2. 用该用例解析出的评分模型那一对（用例覆盖 > 全局默认）所属供应商的协议，
   能被 `getProvider(kind).metadata.protocolTypes` **接受**（判据 `acceptsProtocol()`，2026-09-30 起是集合；
   此前是单值 `protocolType` 的相等比较）。

两条都抛 `CONFLICT` + 可直接展示的中文原因，指向设置页。**用例级覆盖**这条只能在服务端判
（表单一句话说不清「这个用例把评分模型换到了另一种协议」），这也是它放在创建时的理由。

## 7. 评分执行：第二条通路

### 7.1 新模块 `evaluator/src/judge-agent.ts`

```ts
export interface AgentJudgeInput {
  kind: AgentKind;
  /** 评分智能体的 cwd = 该行工作区（改完的状态） */
  cwd: string;
  /** 独立的评分智能体配置目录（§8.3） */
  configHome: string;
  route: TextRoute;              // 复用「默认评分模型」那一对
  baselineCommit: string;        // 告诉它拿什么当基线看 diff
  judgePrompt: string;
  taskPrompt: string;
  dimensions: readonly { key: DimensionKey; label: string }[];
  timeoutMs: number;
  signal: AbortSignal;
  onEvent: (e: AgentEvent) => void;   // 日志行加 [评分智能体] 前缀后转发进行事件日志
}

export async function judgeRowByAgent(input: AgentJudgeInput): Promise<ScoreResult>;
```

提示词（`buildAgentJudgePrompt`）逐段拼，顺序与 `judge.ts` 的 `buildJudgePrompt` 对齐：
考题 → 维度定义 → 用例评分提示词 → **改动怎么看** → 输出契约。

「改动怎么看」这一段是本通路存在的理由，必须写清：
工作区就是当前目录、基线是 `<baselineCommit>`、用 `git diff <baselineCommit>` 看已跟踪改动、
未跟踪的新文件要自己列出来；**改动可能很大，不要试图把它整段打印出来，按文件读、按需读**。

**只读要求**（§14 第 1 条的处置）必须显式写进提示词：不要修改、创建、删除工作区里的任何文件，
不要执行会写文件的命令（格式化、安装依赖、跑测试），只读评审。

失败面（与文本通路同形）：

| 情况 | 处置 |
|---|---|
| `result.ok !== true` | 透传适配器错误码（`AGENT_TIMED_OUT` / `AGENT_FAILED` / `AUTH_FAILED` / `RATE_LIMITED` / `AGENT_CANCELED`），文案已是中文 |
| `result.finalText === null` | `JUDGE_PARSE_FAILED`：「评分智能体没有给出可读的最终答复（该适配器未回传最终消息）」 |
| 答复解析失败 | 复用 `parseJudgeResponse`（围栏剥离 / 越界夹紧 / **维度缺失直接失败**三条口径一个字不改）→ `JUDGE_PARSE_FAILED` + raw 进 `context.raw`，由编排层写进日志 |

### 7.2 两条通路统一收口

`judge.ts` 现在把「拼 `ScoreResult` + `ScoreResultSchema` 自检 + 总分重算」写在 `judgeRow` 里。
抽成一个两路共用的函数（`finalizeScore`），签名收 `(parsed, raw, judgeProviderId, judgeModelId, judgeAgentKind)`：

- **同一个 5 维口径、同一份契约自检、同一条「总分一律由 5 维重算、不采信模型自报」的口径**；
- 文本通路传 `judgeAgentKind: null`，智能体通路传实际 kind；
- `raw` 的长度上限（成功 20 000 字符 / 失败 2 000 字符）两路共用。

### 7.3 编排层第 7 步

```ts
setRowStatus(runId, rowId, 'judging');
const judgingConfig = loadConfig();                       // 与「这一分是哪把尺子打的」同一份快照（R14 原有口径不动）
const route = resolveJudgeRoute({ judgeProviderId: testCase.judgeProviderId, judgeModelId: testCase.judgeModelId });
const score = run.useAgentJudge
  ? await judgeRowByAgent({
      kind: requireJudgeAgent(judgingConfig, route),   // 未配置 / 协议不兼容在这里抛 CONFLICT
      cwd: prepared.workspacePath,
      configHome: judgeHome,                           // 第 4 步之后建好的 .judgehome
      route,
      baselineCommit: prepared.baselineCommit,
      // …题面、评分提示词、维度、超时、signal、onEvent…
    })
  : await judgeRow({ ... });                           // 既有路径，零改动
```

`requireJudgeAgent(config, route)`（放 `evaluator`，与 `resolveJudgeRoute` 同层，因为它同时被 api 层复用）：

- `settings.defaultJudgeAgent === null` → `CONFLICT`「这一轮启用了智能体评分，但设置页没有配置默认评分智能体：请到「设置 → 评分配置」选择，或新建一轮时关闭「使用智能体评分」」；
- 协议不匹配 → `CONFLICT`，点名智能体名、供应商名与两种协议，指向设置页。

**超时与终止**（D9）：

- 内层：`timeoutMs = settings.rowTimeoutMs` 交给适配器；
- 外层：**另起**一套 backstop（`rowTimeoutMs + backstopMarginMs`）+ `hardDeadline`（再宽限 `HARD_STOP_MARGIN_MS`），
  与候选 agent 阶段同形，复用同一套 `timedOutRows` / `userAborted` 记账；
- stop signal **复用该行已注册的那个 `AbortController`**：于是「终止」按钮（`abortRow`）在评分阶段天然有效，
  不需要新的终止入口；
- 超时收尾：该行 `timed-out` + `AGENT_TIMED_OUT`，文案写「评分智能体超过…」以便与候选 agent 超时区分。

`.agenthome` 与 `.judgehome` 分开（D8）：

- `core/workspace.ts` 新增 `rowJudgeHomeDir(workspaceRoot, runId, rowId)` → `{rowDir}/.judgehome`；
- `clearRowArtifacts` 补第三条 `rmSync`（**分开写**，符合该函数「新落的东西默认不被顺手删掉」的口径）；
- 建目录由 core 提供（路径的所有者），评分阶段调用。

### 7.4 工作区污染对照（D7 的处置）

**只对智能体通路做**（文本通路只读磁盘、不启动任何进程，它不可能改动工作区）。
评分结束后重算一次 `collectDiff` 摘要，与评分前那一份比对（文件数 / 增删行数）。
不一致 → 落一条点名的 `[WARN]` 日志：「评分智能体执行期间工作区被改动（改动前 N 个文件 +A −B，改动后 M 个文件 +C −D）；
『查看改动』抽屉显示的是当前状态，可能已不是候选 agent 的产出」。
**不自动回滚**（工作区已无干净基线可回退：候选的改动含未提交与未跟踪文件），只如实标注。

对照的「评分前那一份」在两处来源不同，但都是同一个算法：
完整跑一行时用第 6 步刚落进快照的 `row.diff`；重新评分时用评分开始前现算的那一份。

## 8. `agents` 包：最终答复出口（D2）

### 8.1 类型

```ts
export interface AgentRunResult {
  // …既有字段…
  /** 最终答复文本；null = 未采到（**不猜**，与 tokens/turns 同一条「绝不填 0」口径） */
  finalText: string | null;
}
```

`TurnState` 加 `finalText: string | null`（三家共用的跨消息状态），`runTurn` 初始化 `null`，
`assembleResult` 的 `base` 原样带出——**canceled / timed-out / error 三种结论也带**：
「它到底说了什么」在排障时同样有用（超时的行尤其需要）。

`TurnProjection` **不变**：`finalText` 只经 `TurnState` → 结果，不进事件流。

### 8.2 三家采集点

| 家 | 采集点 | 依据 |
|---|---|---|
| claude-code | `result` 消息的 `result` 字段（`projectResult` 里已在手） | 探测 dump + `events.test.ts` 已有「result → 日志」的用例 |
| codex | `item.completed` / `item.updated` 且 `item.type === 'agent_message'` 的累积文本（取最后一次） | **未被探测覆盖**，见 §14 第 2 条 |
| dsh | `assistant/message` → `params.event.data.message.content[]` 按 `type === 'text'` 过滤出非空文本后 `join('\n')` | `probe/dumps/dsh.json:1047-1063` 实测：`content` 里同时有 `{type:'reasoning'}` 与 `{type:'text',text:'好'}` |

**dsh 必须按 `type === 'text'` 过滤**：同一个 `content` 数组里的 `reasoning` 块**也带 `text` 字段**，
不过滤会把推理内容混进答复。

三家共用的两条次级口径：`''` **不写**（与「空串既落不成日志也不该落」的既有原则一致）；
每见到一次就覆盖（多轮时最后一次即最终答复）。

## 9. 重新评分

### 9.1 语义

「重新评分」= 在**该行现有工作区**上重跑第 7 步评分，**不重跑**候选 agent、不重建工作区、不改分支、
不动 `diff` 摘要。模式沿用 `run.useAgentJudge`（D11）；评分模型走 `resolveJudgeRoute` 的**当前配置**
（用例覆盖 > 全局默认），所以「到设置页换个评分模型再点重新评分」天然生效，不需要新的选择器。

### 9.2 入口与判据

- 行卡片（`eval-row-card.tsx`）加一个「重新评分」按钮 + `Popconfirm` 二次确认（与「终止」同一套形态）。
- 可点判据用 contracts 的 `canRescoreRow`（§4.3），**服务端与界面共用同一份**；
  不可点时按钮 `disabled` 并用 `Tooltip` 说明原因。
- 服务端不满足时抛 `CONFLICT` + 具体原因（界面不该给它按钮，真调到了要明确报出来，而不是静默成功）。

### 9.3 执行（`evaluator.rescoreRow(runId, rowId)`）

1. `requireRow` → `canRescoreRow` 不通过即抛；
2. `loadConfig()`；用例必须仍存在（题面与评分提示词没有快照进 `run.json`，与 `startRun` 同一条口径）；
3. 注册 `AbortController` 到 `rowAborts`（「终止」按钮在评分阶段照常有效）；
4. 落一条 `log` 事件：`[重新评分] 用户请求重新评分（模式：评分智能体 / 评分模型），本次不重跑候选智能体`；
5. `setRowStatus(runId, rowId, 'judging', { error: null, score: null })`——先清掉上一次的分数与失败归因
   （与 `runRowAttempt` 的 `preparing` 重置同口径；后果见 §14 第 6 条）；
6. 跑评分（与 §7.3 **同一个函数**，避免两份逻辑漂移）：
   - 文本通路：重算 `truncateDiff(collectDiff(workspacePath, baselineCommit).text, diffBudgetBytes)`
     （与第 6 步同一个算法，抽一个小助手共用）；
   - 智能体通路：不需要 diff 文本；
7. 落盘：`patchRow({ score })` → `publishRowEvent({ type: 'score' })` → `setRowStatus('judged')` →
   `publishRowEvent({ type: 'end', exitReason: 'rescored' })`；
8. 失败/终止/超时：复用现有的 `settleFailed` / `settleStopped` 与那套优先级记账；
9. `finally`：`clearRowRuntime` → `finalizeRun(runId)`（吞异常记 ERROR，与 `startRun` 的 `.finally` 同一处置）
   ——让「补完最后一个失败行」的 `partial` 能翻回 `done`；
10. 返回最新快照（HTTP 层要拿它做 `populateCache`）。

**并发安全性**：`mutateRow` 整体同步（读快照 → 改 → 落盘之间没有 `await`），Node 单线程下与并行行的
快照写入不会交错。重评期间该行处于 `judging`，`isRunningRow` 已经让 `startRun` 拒绝启动
（既有守卫，不需要新加）。

**`end` 事件的 `exitReason` 用 `'rescored'`**：契约里它是 `z.string()`，日志行渲染成 `结束 rescored`
（与既有 `结束 completed` / `结束 canceled` 同形）。

## 10. 展示

| 位置 | 改动 |
|---|---|
| `score-detail-view.tsx` | `judgeAgentKind !== null` 时把「评分模型：X」改成「评分智能体：Claude Code · 模型：X」（查 `AGENT_LABELS`） |
| `log-format.ts` 的 `score` 分支 | 智能体评分时补上智能体名，让日志里的两次评分事件可区分 |
| 行卡片 | **不加**「智能体评分」Tag：开关是轮级且创建后不可改，一轮里只有一把尺子，行上再标一遍没有新信息 |
| `README.md` 的「分数怎么来的」 | 说明两条通路、`rowTimeoutMs` 同时约束两段（§14 第 4 条）、以及「不同轮次之间分数不可比」这条既有口径 |

## 11. 数据与落盘

- **配置**：`~/.aieval/config.json` 的 `settings.defaultJudgeAgent`（`null` / 三个 kind 之一）。
- **快照**：`run.json` 的 `EvalRun.useAgentJudge`（轮级）与每行 `score.judgeAgentKind`（行级）。
- **产物目录**新增 `{workspaceRoot}/{runId}/rows/{rowId}/.judgehome`（评分智能体的独立配置目录）。
- **迁移**：无。两个新快照字段都带默认值，老 `run.json` 原样可读（D5）。

## 12. 错误处理

| 场景 | 错误码 | 文案要点 |
|---|---|---|
| 开关开但设置页未配置默认评分智能体 | `CONFLICT` | 指向「设置 → 评分配置」，并给出「或新建一轮时关闭使用智能体评分」 |
| 评分智能体与评分模型协议不兼容 | `CONFLICT` | 点名智能体、供应商、期望协议与实际协议 |
| 评分智能体没给出可读答复 | `JUDGE_PARSE_FAILED` | 「该适配器未回传最终消息」 |
| 评分智能体答复不合法 JSON / 缺维度 / 分数非数字 | `JUDGE_PARSE_FAILED` | 复用 `parseJudgeResponse` 的既有中文文案；raw 进日志抽屉 |
| 评分智能体进程起不来 / 鉴权失败 / 限流 | 透传 `AGENT_FAILED` / `AUTH_FAILED` / `RATE_LIMITED` | 适配器层已是中文 |
| 评分智能体超时 | 该行 `timed-out` + `AGENT_TIMED_OUT` | 「评分智能体超过…」，与候选 agent 超时区分 |
| 用户终止评分 | 该行 `canceled` | 沿用「终态优先」 |
| 对不可重评的行点重新评分 | `CONFLICT` | 分三种，各自点名：`preparing`/`running`/`judging` 的行 → 「正在运行中，请先终止」；`diff === null` → 「该行还没跑过，请先点『开始』」；`baselineCommit === ''` → 「工作区未就绪（准备阶段没成功过），请先点『开始』」 |

## 13. 测试

**契约（`contracts`）**

- `defaultJudgeAgent` 默认 `null`、三值合法、非法值拒绝；
- `useAgentJudge` 缺省为 `false`（`RunCreateSchema` 与 `EvalRunSchema` 各一条）；
- **老 `run.json`（缺 `useAgentJudge` 与 `judgeAgentKind`）仍能 `safeParse` 成功** ← 必须做**变异验证**：
  去掉 `.default(...)` 后这条守卫必须变红；
- `canRescoreRow` 的真值表（六种终态里哪些可重评、三种在途状态一律不可）；
- `agent.ts` 拆分后 barrel 出口不变（现有 `index.test.ts` 的断言必须原样通过）。

**适配器（`agents`）**

- 三家各一条：识别的消息 → `finalText` 是期望文本；
- dsh：`content` 里混 `reasoning` 块时，答复**只有** `type === 'text'` 的那些（防止推理内容混入）；
- 三条负例：`finalText` 为 `null`（没见到识别的消息 / 文本为空串）；
- `turn.ts`：`finalText` 在 `ok: true` 与三种失败结论下都被带出。

**评分（`evaluator`）**

- `judge-agent.ts`：拼词含只读要求与基线 commit；`ok !== true` 透传错误码；`finalText === null` → `JUDGE_PARSE_FAILED`；
  围栏 / 越界夹紧 / 维度缺失三条口径与文本通路**逐字一致**（同一个 `parseJudgeResponse`）；
- `finalizeScore` 两路共用：`judgeAgentKind` 分别为 `null` 与具体 kind；
- orchestrator：开关关 → 走文本通路（既有用例全绿）；开关开 → 走智能体通路；
  未配置智能体 → 该行 `failed` + `CONFLICT`；协议不兼容 → 同上；
  评分阶段超时 → `timed-out`，且**不**永远停在 `judging`；
- 工作区污染对照：评分后 diff 摘要变了 → 有一条点名的 `WARN` 日志。

**重新评分（`evaluator` + `api`）**

- `canRescoreRow` 不通过的三条路径各抛一次 `CONFLICT`；
- 打桩适配器：重评后 `score` 被替换、状态回到 `judged`、**事件日志里两次 `score` 事件都在**（追加而非清空）；
- 重评后 `partial` → `done`（最后一个失败行被补上）；
- 用例被删 → `CONFLICT`。

**界面（`ui`）**

- `judge-settings-card`：新 Select 渲染三个选项；不兼容项 `disabled`；已存值不兼容时出红色 `Alert`；
  清空回写 `{ defaultJudgeAgent: null }`；
- `run-create-panel`：Switch 默认关闭；打开后提交的 payload 里 `useAgentJudge === true`；
  未配置默认评分智能体时出内联 `Alert`；
- 行卡片：「重新评分」按钮在不可重评的行上 `disabled` 且 `Tooltip` 给出原因；可重评时点开是 `Popconfirm`。

**路由（`web-next`）**

- `POST /api/runs` 收到 `useAgentJudge` 并写进快照 ← **专治 zod strip 静默丢字段**（D6）；
- 创建时未配置智能体 / 协议不兼容 → 409 + 中文原因；
- `POST /api/runs/{runId}/rows/{rowId}/rescore` 的正例与 409 分支。

## 14. 已知边界（如实登记，不静默兜底）

1. **评分智能体可能改动工作区。**「查看改动」抽屉是按需现算工作区 diff 的，而评分发生在 diff 摘要
   采集**之后** ⇒ 它若改了文件，抽屉显示的就不再是候选的产出。处置：提示词只读要求 + 评后摘要对照 +
   点名 `WARN`；**不自动回滚**（候选的改动含未提交与未跟踪文件，没有干净基线可回退）。
2. **codex 的 `agent_message` 形状未经探测确认。** `probe/dumps/codex.json` 只跑出
   `item.type === 'error'`（那次网络不通）。实现计划里登记一次探测任务（`probe/raw-events.mts`，
   网络可用时跑）；**探测前不许把它当成已验证事实**。拿不到时表现为 `finalText === null` →
   该行明确失败，而不是静默出一个空分。
3. **评分智能体的计量不进快照**（只转发成日志行）。它的成本与候选 agent 同量级，但界面上看不到
   「这次评分花了多少 token」——需要时看日志抽屉。
4. **`rowTimeoutMs` 现在同时约束两段**：候选 agent 跑一次、评分智能体再跑一次，两次各自有界。
   开智能体评分的轮次需要把「单行超时」相应调大，README 要写清。
5. **重新评分沿用本轮模式**（用户口径）：若是「新建一轮时忘了打开开关、跑完才发现 diff 太大」，
   补救路径仍然只有新建一轮。
6. **重新评分前会清空该行快照里的旧分数**：重评失败会丢掉上一次的分数（历史仍在事件日志的
   `score` 事件里）。这是为了不让界面出现「状态是评分中、却挂着上一次的分数」这种误导性组合。
7. **一次评分仍然是一次请求级别的判断**：智能体通路解决了「看不到全部改动」，但没有解决
   「看不到测试运行结果」这条既有限制（README 已有登记）。

## 15. 实施顺序

| 任务 | 内容 | 依赖 |
|---|---|---|
| T1 | contracts：拆 `agent.ts`、4 个新字段、`canRescoreRow` | — |
| T2 | agents：`finalText` 出口 + 三家采集点 | T1 |
| T3 | evaluator：`judge-agent.ts` + `finalizeScore` 收口 + 第 7 步分支 + `.judgehome` + 污染对照 | T2 |
| T4 | 设置页「默认评分智能体」（含协议过滤） | T1 |
| T5 | 创建评测 Switch + 内联 Alert + 创建时服务端校验 | T1 |
| T6 | 重新评分：`rescoreRow` + api + 路由 + client hook + 行卡片按钮 | T3 |
| T7 | 展示：评分详情与日志行 | T3 / T6 |
| T8 | README 更新 + 全链 `typecheck` / `lint` / `test` + 真实浏览器冒烟 | 全部 |

每个任务收尾都跑 `pnpm typecheck` → `pnpm lint` → `pnpm test`；**新增的每条回归守卫都要做变异验证**
（把要拦的缺陷人为造回去，确认守卫变红，再还原并核对文件哈希未变）。

## 16. 澄清结论

本次设计通过对话确定、且与既有 spec 无关的开放问题，逐条记录结论（含被否决的选项）：

1. **评分智能体用哪个模型** → 复用「默认评分模型」那一对（D1）。否决了「自带独立供应商 + 模型」与
   「每轮在表单里单独选」。
2. **「文件变更超过 1M」这条线要不要落成行为** → 不落成行为，纯动机。是否走智能体完全由创建评测时的
   开关决定；否决了「超阈值自动改走智能体」与「超阈值只给告警」。
3. **智能体的最终答复怎么拿回来** → 给 `agents` 包补 `finalText` 出口（D2）。否决了「让智能体写约定
   文件」与「从日志事件流重建」。
4. **重新评分做到哪一层** → 只做行级，沿用本轮模式，带二次确认（D11）。否决了「模式当场选」与
   「轮级批量」。
5. **开关的默认值** → 关闭（用户口径）。
6. **行卡片要不要标「智能体评分」** → 不加（§10）：开关是轮级的，一轮里只有一把尺子。
