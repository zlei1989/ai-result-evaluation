# AI 生成代码评测工具 —— 评分通路的原生结构化输出设计（零三方依赖）

> 前置阅读：`docs/superpowers/specs/2026-09-22-features-design.md`（§5.6 智能体适配器、§5.7 评分器）、
> `docs/superpowers/specs/2026-09-26-agent-judge-design.md`（智能体评分通路与 `finalText` 出口）、
> `docs/superpowers/specs/2026-09-28-rubric-scoring-design.md`（评分体系重构，§6.1/§6.5 会与本设计的契约同批替换）。
> 本文只描述**本次新增**的部分；与既有 spec 冲突之处，以本文为准并在 §9 逐条说明。

## 1. 要解决的问题

1. **评分结果的形状今天是「请求」而不是「约束」**。两条通路都只能把输出契约写成提示词文本
   （`contracts/src/score.ts` 的 `JUDGE_OUTPUT_CONTRACT`），然后祈祷模型照做：文本通路靠
   `judgeRow` 的「解析失败 → 把原因回问模型，最多 2 轮」（`evaluator/src/judge.ts:390-444`），
   智能体通路连这一步都没有——`judgeRowByAgent` 拿到 `finalText` 只解析**一次**，
   不合格直接 `JUDGE_PARSE_FAILED`（`evaluator/src/judge-agent.ts:201-212`），整行落 `failed`。
   「智能体评了一次、模型回了段散文」这件事今天没有任何补救，只能人工「重新评分」。

2. **两家 CLI 都提供原生开关，而我们的窄结构把它们关在门外**（§1.1 实测）：claude-code 的
   `Options.outputFormat` 与 codex 的 `TurnOptions.outputSchema` 都能让上游**按 schema 生成**，
   而我们的适配器连字段都没有——`ClaudeQueryOptions`（`providers/claude-code/sdk.ts:25-61`）与
   `CodexThread.runStreamed(prompt, { signal })`（`providers/codex/sdk.ts:82`）都只声明了今天用到的那几格。
   这正是 `permission.ts` 文件头登记过的那类缺陷形状：「外壳比厂商窄，就等于把厂商的能力关在门外」
   （本仓实测：claude 的 `permissionMode` 曾被钉成 `'acceptEdits'`，加一个只读档都过不了编译）。

3. **能力差异必须可解释**：dsh 的 SDK 客户端没有这个入口（§1.1），所以「有的行被 schema 约束、
   有的行没有」是既成事实。今天没有任何一处记录这件事，于是同一次评测里两个候选的分数
   **在不知道约束强度不同的情况下被横向比较**——与 `EvalRow.effort` 那条「分高的那行可能是模型更强、
   也可能只是它跑了 max」是同一类误读。

4. **本设计不引入任何三方件**：不加 npm 依赖（不做 zod → JSON Schema 的自动转换）、不安装任何
   CLI 插件、不改 `pnpm-lock.yaml`。schema 以字面量形式写进契约，用一致性守卫钉住它与既有契约同形；
   dsh 走「有痕降级」而不是靠外部插件补齐。

### 1.1 实测依据（2026-09-28，本机安装态）

| 事实 | 怎么验的 |
|---|---|
| claude-code CLI 有 schema 开关 | `claude.exe --help`（CLI **2.1.281**）→ `--json-schema <schema>   JSON Schema for structured output` |
| claude-code SDK 的落点 | `@anthropic-ai/claude-agent-sdk@0.3.281` 的 `sdk.d.ts`：`:1009-1012` `JsonSchemaOutputFormat = { type: 'json_schema'; schema: Record<string, unknown> }`；`:2389-2391` `OutputFormat = JsonSchemaOutputFormat`；`:1905-1917` `Options.outputFormat`（JSDoc 逐字：*Output format configuration for structured responses. When specified, the agent will return structured data matching the schema.*） |
| claude-code 的结果出口 | 同一个 `sdk.d.ts`：`:5581` 收尾消息上 `structured_output?: unknown`（与 `result: string` 并存）；`:2054-2065` 说明结构化那一轮属于 **end-turn tool session**——「以一条成功的 tool_result 载体收尾、**没有尾随 assistant 消息**」，真正的产出在同轮的 `structured_output` attachment 里 |
| claude-code 自己会重试 | 同一个 `sdk.d.ts`：错误子类型 `error_max_structured_output_retries`（`:5471`）与终止原因 `structured_output_retry_exhausted`（`:9324`）——形状不符时是 CLI 在重问，不是我们 |
| codex CLI 有 schema 开关 | `codex.exe exec --help`（**0.156.1**）→ `--output-schema <FILE>   Path to a JSON Schema file describing the model's final response shape` |
| codex SDK 的落点 | `@openai/codex-sdk@0.156.1` 的 `dist/index.d.ts:169-174` `TurnOptions = { outputSchema?: unknown; signal?: AbortSignal }`，`:208` / `:211` 的 `runStreamed(input, turnOptions?)` 与 `run(input, turnOptions?)` **共用它**；用法见该包 `README.md` 的 "Structured output" 一节 |
| dsh 没有这个入口 | `@deepseek-ai/dsh-sdk-client@0.1.7-rc.1` 的 `lib/types/types.d.ts`：`HarnessClientOptions` 只有 dshBin / profile / patches / dshHome / processCwd / env / 各超时，`DeepSeekHarnessOptions` 只加 cwd / provider / model / reasoningEffort / maxTokens——**没有 schema 格**；`lib/index.js:161-191` 的 argv 只有 `--profile` 与 `--patch`；`@deepseek-ai/dsh@0.1.7-rc.1` 的 `dsh --help` 实测无任何结构化输出开关 |

### 1.2 未能验证的三条（照实登记，进 §11 冒烟）

> 状态：第 1–3 条均待真机确认（必须用真机结论替换，不许用推断）。

1. **cc 在 `outputFormat` 下 `result.result` 里到底是什么**。SDK 的类型面说 `structured_output` 与
   `result` 并存（§1.1），而它同时说结构化那一轮没有尾随 assistant 消息——两者只能说明
   「`structured_output` 一定有值」，**不能说明 `result` 是否仍是那段 JSON 文本**。本设计因此要求
   适配器**优先取 `structured_output`**（§5.3），并在冒烟里 dump 一次真实收尾消息。
2. **两家网关是否透传**。cc 走 Anthropic Messages、codex 走 Responses（`wire_api: 'responses'`），
   两者最终都是请求体里的一个结构化输出字段。网关不认时的表现**不是报错**，而是模型照旧自由生成
   ——即「我们以为已经强约束，实际什么都没发生」。这条只能真机验（§11 第 2 项），并靠
   `ScoreResult.structuredOutput` 记账把「这一行到底有没有吃到约束」变成可回答的问题。
3. **codex 在 schema 不被上游接受时的失败面**（`turn.failed` / `error` 事件的文案形状），
   以及 `item.type === 'agent_message'` 在结构化模式下是否仍然成立（该形状此前也只是**防御性过滤**，
   见 `providers/codex/events.ts:60-67`）。

## 2. 本阶段范围

**做：**

- 契约里新增一份**评分输出的 JSON Schema 字面量**（`JUDGE_OUTPUT_JSON_SCHEMA`），与
  `JUDGE_OUTPUT_CONTRACT` 同形、同一处维护；
- `ScoreResult` 新增 `structuredOutput: boolean`，回答「这一分是在 schema 约束下拿到的吗」；
- `agents` 层新增「中性事实」入参 `AgentRunInput.outputSchema?` 与能力声明
  `AgentProviderMetadata.capability.structuredOutput`；
- 两家适配器各自翻译成自家方言：cc 走 `outputFormat`、codex 走 `outputSchema`（并优先从
  `structured_output` 取答复）；
- 编排层按能力声明决定是否带 schema，**不支持时发一条行日志**（有痕降级）并把结论记进 `ScoreResult`；
- 评分详情显示「输出约束」一格。

**不做（本期明确排除）：**

| 不做的事 | 理由 |
|---|---|
| **引入任何三方件**（npm 依赖 / CLI 插件 / 改 lockfile） | 用户口径（2026-09-28）。schema 是 5 个字段的固定形状，为它引一个 zod→JSON Schema 的转换器是拿一条供应链换 40 行字面量；给 dsh 装外部插件更是把「评分能不能跑」绑在一个非本仓维护的包上 |
| 文本通路（`judgeRow`）加结构化输出 | 它走我们自己的 HTTP 调用，跨 openai / anthropic 两种 wire，且已经有「回问 2 轮」。schema 字面量就位后这是一处独立小改动，等 agent 通路真机验完再单开（§13 第 1 条） |
| 候选阶段（执行智能体）加 schema | 候选的产出是**代码改动**，不是 JSON。约束它的最终答复没有意义，而 codex 的 `outputSchema` 是 turn 级选项：候选阶段不传即逐字不变 |
| 用 schema **替换**结构检查 / 解析器 | schema 是请求侧约束，`validateJudgeResponse` / `collectJudgeDimensions` 仍是唯一判据（§3 D6）。两条通路给的必须是同一把尺子 |
| 用 schema 取消文本通路的回问轮次 | 同上：schema 提高「一次就合格」的概率，不改变「不合格怎么办」的处置 |
| 给 dsh 补一个自研的结构化输出运行时 | harness 的结构化输出机制挂在**委派子智能体**上（带 `outputSchema` 的子运行由 in-process 委派驱动安装一个 `structured_output` 工具，`subagent-dsh-sdk` 这一侧明确声明不支持把 schema 传进子进程），而我们的适配器驱动的是**顶层会话**，SDK 客户端根本没有把 schema 传进去的通道。自研意味着在我们的仓库里实现一个 harness 插件并长期跟随其内部接口——那是拿「一份要自己养的适配层」换掉「零三方」的初衷 |
| 本期把 `totalScore` 从契约文本与 schema 里去掉 | 我们本来就不采信模型自报的总分（`composeTotalScore` 重算），但契约文本今天要求它、rubric spec 会整段替换这份文本——两件事同批做才不会出现「文本一套、schema 另一套」（§13 第 3 条） |

## 3. 关键决策与理由

| # | 决策 | 被否决的替代 | 理由 |
|---|---|---|---|
| D1 | schema 以**手写字面量**放在 `contracts/src/score.ts`（`JUDGE_OUTPUT_JSON_SCHEMA`），并用一条一致性守卫钉住它与 `DIMENSIONS` / `DimensionScoreSchema` / `JUDGE_OUTPUT_CONTRACT` 同形 | ① 引入 `zod-to-json-schema`；② 自研通用的 zod → JSON Schema 转换器 | ① 违反本期的零三方约束；② 为一个 5 字段的固定形状写通用转换器，是**第二份真源**（转换器本身的正确性没人验），而本设计要的只是「字段名只有一处」（D6 同源） |
| D2 | 契约里存的是**中性事实** `outputSchema?: Record<string, unknown>`（JSON Schema 本身与厂商无关），`outputFormat` / `--output-schema` / 「没有这一格」三种方言全部留在各家适配器 | 契约里直接放 `ClaudeOutputFormat` / `CodexTurnOptions` 这类厂商形状 | 与 context-window spec 的 D1 同一条口径：`AgentRunInput.route` 今天就是「协议 + 地址 + 密钥 + 模型名」四个中性事实，厂商方言进契约等于让跨端契约知道某一家 CLI 的语法 |
| D3 | 能力声明写进**注册表元数据**：`AgentProviderMetadata.capability.structuredOutput: boolean`（**必填**） | ① 可选字段 + 默认 false；② 把三家的支持情况硬编码在编排层 | ① 可选就会被默认成 false 而无人验证——本仓对 `liveUsage` 的处置正是「可选 + 守卫强制显式声明」，这里直接用更硬的必填（`capability` 里 `cancelMidTurn` / `usage` 已是必填）；② 与 A3「智能体的能力只有一个查询点」冲突，加第四家必然漂移 |
| D4 | 不支持时**有痕降级**：编排层不传 schema，但发一条行日志说明「本行的评分智能体不支持结构化输出，回落到提示词契约」，并把 `ScoreResult.structuredOutput = false` 记下来 | ① 静默不传；② 直接拒绝运行（dsh 不能评分） | ① 静默降级是本仓反复禁止的一类（「两条通路同一件事在界面上长得不一样」）；② schema 是**增强**不是前提，为它牺牲一条通路的可用性不划算。降级 + 记账让「这一分被约束到什么程度」可回答 |
| D5 | schema 与提示词契约**同形**（含 `totalScore`），不因为「我们不采信它」就把它从 schema 里删掉 | schema 只保留我们真正读的三个字段 | 一份文本、一份 schema 指向不同形状，就是 §1 第 1 条要消灭的那类漂移的翻版；`totalScore` 由模型给出、我们重算，多一个被忽略的字段比两份契约不一致便宜 |
| D6 | 解析判据**一个字不改**：`collectJudgeDimensions` / `parseJudgeResponse` / `validateJudgeResponse` 与 `finalizeScore` 的「5 维、1–5、总分重算」全部原样 | 有 schema 了就把解析放宽（例如按缺的维度算平均） | 「不存在宽松版解析器」是既有 spec 明写的口径；schema 只能让「不合格」更少见，不能改变「不合格时怎么办」 |
| D7 | schema 里 `score` 用 `integer` + `minimum: 1` + `maximum: 5`（**严**） | 放宽成 `type: 'integer'` 以与解析侧的「越界夹紧」对齐 | 夹紧是**解析侧的兜底**（模型越界时我们不丢这一维），而 schema 是**请求侧的阻止**：能在上游阻止「6 分」这种输出，就不该先让它生成再悄悄改成 5。代价是两条通路在「越界」这一格上表现不同（agent 通路不会被夹紧），**照实登记**在 §9 并用一条用例把这个差异钉住 |
| D8 | 结果的出口仍然是 `AgentRunResult.finalText`：cc 在 `structured_output` 存在时把它 `JSON.stringify` 后作为 `finalText` | 新增 `AgentRunResult.structuredOutput` | `finalText` 的 JSDoc 已经把「需要结构化答复的调用方从这里取」写死（`agents/src/types.ts:112-120`）；加第二个出口会让每个调用方都要处理「哪个才是答复」，而候选阶段根本不用它。序列化后仍是文本，解析侧的唯一入口不变 |
| D9 | schema 的**严格度只到可移植子集**：`type` / `properties` / `required` / `additionalProperties` / `enum` / `integer` + `minimum`/`maximum` / `minItems` / `maxItems`；不用 `oneOf` / `const` / `prefixItems` / `uniqueItems` | 用 `oneOf` + `const key` 把「第 N 项必须是第 N 维」也写进 schema | 两家对 JSON Schema 子集的接受面不同，写进去的每一格都要分别真机验证；而「恰好 5 个 key、key 不重复、顺序」本来就不是 schema 能可靠表达的（`uniqueItems` 是整对象去重，达不到目的）——那部分继续由结构检查判，schema 只保证「5 条、key 取值合法、score 在 1–5、字段齐全」 |
| D10 | `structuredOutput` 记进 **`ScoreResult`**，不记进行快照（`EvalRow`） | 记进 `EvalRow` | 它是**这一分的属性**（与 `judgeProviderId` / `judgeModelId` / `judgeAgentKind` 同级），不是「这一行的配置」；`EvalRow` 今天没有任何评分侧字段，加一个就等于把评分详情的职责劈成两半 |
| D11 | 能力缺失的守卫是**纵深两道**：编排层不传（第一道）+ 适配器收到 schema 却不支持就报中文错（第二道） | 只做第一道 | 第一道在生产路径上就够，但适配器的入参是**公开类型**（`AgentRunInput` 谁都能构造）；第二道让「悄悄忽略一个我们看不懂的入参」不可能发生，与 dsh 适配器里其他防御性分支同形 |

## 4. 契约变更（`packages/server/contracts`）

### 4.1 `src/score.ts`：`JUDGE_OUTPUT_JSON_SCHEMA`

新增导出（与 `JUDGE_OUTPUT_CONTRACT` 相邻，头注写明「两份必须同批修改」）：

```ts
/** 单维下限（与 `DimensionScoreSchema.score` 的 `min(1)` 同一条口径，导出以便 schema 与解析器共用） */
export const MIN_SCORE_PER_DIMENSION = 1;
export const MAX_SCORE_PER_DIMENSION = 5; // 原为模块内私有，改为导出

/**
 * 评分输出的 JSON Schema（结构化输出用）：给 claude-code 的 `outputFormat` 与 codex 的 `outputSchema` 用。
 * 三条口径：
 *   1. **只用可移植子集**（D9）：不出现 `oneOf` / `const` / `prefixItems` / `uniqueItems`；
 *   2. **与 `JUDGE_OUTPUT_CONTRACT` 同形**（D5）：三个顶层字段一个不少；
 *   3. 维度 key 的枚举**由 `DIMENSIONS` 求值**（不是手抄 5 个字符串）——手抄就会在加维度时漏改。
 * 它**不是**判据：合格与否仍由 `collectJudgeDimensions` 判（D6）。
 */
export const JUDGE_OUTPUT_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['dimensions', 'totalScore', 'verdict'],
  properties: {
    dimensions: {
      type: 'array',
      minItems: DIMENSION_COUNT,
      maxItems: DIMENSION_COUNT,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['key', 'label', 'score', 'reason'],
        properties: {
          key: { type: 'string', enum: DIMENSIONS.map((dimension) => dimension.key) },
          label: { type: 'string' },
          score: { type: 'integer', minimum: MIN_SCORE_PER_DIMENSION, maximum: MAX_SCORE_PER_DIMENSION },
          reason: { type: 'string' },
        },
      },
    },
    totalScore: { type: 'integer', minimum: 0, maximum: 100 },
    verdict: { type: 'string' },
  },
} as const;
```

### 4.2 `ScoreResultSchema` 新增 `structuredOutput`

```ts
  /**
   * 这一分是不是在 **schema 约束**下拿到的（false = 只靠提示词契约）。
   * 为什么必须记：dsh 没有这个入口、文本通路本期也没开（§2），于是同一次评测里
   * 「被约束的候选」与「没被约束的候选」会同时存在——不记下来，两者的分数就被当成同一口径比较。
   * `.default(false)` 同 `judgeAgentKind`：磁盘上已有的评分记录要能读回。
   */
  structuredOutput: z.boolean().default(false),
```

### 4.3 一致性守卫（`src/score.test.ts`）

| 断言 | 拦的是什么 |
|---|---|
| `JUDGE_OUTPUT_JSON_SCHEMA.properties.dimensions.items.properties.key.enum` 与 `DIMENSIONS.map(d => d.key)` **逐项、按序**相等 | 有人加了一维却只改了 `DIMENSIONS` |
| `dimensions.minItems === maxItems === DIMENSION_COUNT`；`score.minimum/maximum` 等于两个导出常量 | 有人改了 `DimensionScoreSchema` 却漏改 schema（或反之） |
| 顶层 `required` 与 `properties` 的键集合相等，且 `additionalProperties === false` | 「同形」这条口径失效（漏字段 / 允许多余字段） |
| **双向样例**：一份合格样例（5 维齐全、score 在 1–5）同时过 schema 与 `parseJudgeResponse`；一份「少一维」样例被 schema 拒绝（`minItems`）**且**解析失败（维度缺失） | 两份契约在正常路径上分叉 |
| **登记差异**：`score: 6` 的样例被 schema 拒绝，而 `parseJudgeResponse` 把它夹紧成 5 | D7 那条有意为之的差异被谁「顺手对齐」掉（要么是有人放宽 schema，要么是有人给解析器加了越界失败） |

## 5. `agents`：能力声明与三家落点

### 5.1 `src/types.ts`

```ts
export interface AgentRunInput {
  // …既有字段不动…
  /**
   * 要求模型**按这份 JSON Schema 生成**最终答复（可选）。缺省 = 不约束，行为与今天逐字相同。
   * 它是中性事实（D2）：翻译成 `outputFormat` / `--output-schema` 是适配器的事；
   * 不支持这一格的适配器**必须报错**，不许静默忽略（D11）。
   */
  outputSchema?: Record<string, unknown>;
}

export interface AgentProviderMetadata {
  // …既有字段不动…
  capability: {
    cancelMidTurn: boolean;
    usage: boolean;
    liveUsage?: 'reported' | 'estimated';
    /** 该适配器能不能把 `AgentRunInput.outputSchema` 落到实处（必填，D3） */
    structuredOutput: boolean;
  };
}
```

### 5.2 三家落点（唯一真源，与 `permission.ts` 的「三份表放一起才准」同一分工）

| kind | `capability.structuredOutput` | 落点 | 结果出口 |
|---|---|---|---|
| `claude-code` | `true` | `query({ options: { outputFormat: { type: 'json_schema', schema } } })` | 收尾消息的 `structured_output`（D8：序列化后进 `finalText`） |
| `codex` | `true` | `thread.runStreamed(prompt, { signal, outputSchema })`（SDK 自行落成 `--output-schema <FILE>`） | 仍是 `item.type === 'agent_message'` 的文本 |
| `dsh` | `false` | 无（SDK 客户端没有这一格） | 不变 |

### 5.3 claude-code（`providers/claude-code/`）

1. `sdk.ts` 的窄结构加一格（值域逐字来自 `sdk.d.ts:1905-1917`，并像 `permissionMode` 那样把
   「为什么写完整联合」的理由写在注释里）：

   ```ts
   /**
    * 结构化输出（`sdk.d.ts:1905-1917` / `JsonSchemaOutputFormat`）。
    * 不给 ⇒ 与今天逐字相同；给了 ⇒ CLI 自己负责让模型按 schema 生成，
    * 并在形状不符时**自己重问**（用尽后以 `error_max_structured_output_retries` 收场）。
    */
   outputFormat?: { type: 'json_schema'; schema: Record<string, unknown> };
   ```

2. `index.ts:79` 的 `sdk.query({ options })` 里，`input.outputSchema === undefined` 时**一个字段都不加**
   （保证「没传 schema 的行」的行为逐字不变）：

   ```ts
   ...(input.outputSchema === undefined
     ? {}
     : { outputFormat: { type: 'json_schema' as const, schema: input.outputSchema } }),
   ```

3. `events.ts` 的 `projectResult`：**优先** `structured_output`（D8）。

   ```ts
   // 结构化输出优先：`structured_output` 是 CLI 按 schema 校验过的产出，`result` 在结构化那一轮
   // 可能只是载体（sdk.d.ts:2054-2065）。出口选择**不改本文件的形状**——projectResult 仍是纯函数，
   // 只产 drafts；两个来源**同时存在且内容不同**时落一条 WARN（与 num_turns 不一致那条同一处置：
   // 同一件事有两个来源、我们不静默挑一个）。只有一个来源或两者一致时不发任何东西（不制造噪声）。
   // 上面那条 `logDraft('stdout', text)` 不动：抽屉里仍要能看到 CLI 的收尾原文。
   const structured = message?.structured_output;
   if (structured !== undefined) {
     const serialized = safeStringify(structured);
     if (text !== null && text !== '' && text !== serialized) {
       drafts.push(
         logDraft('stderr', '[WARN] claude-code 的 structured_output 与 result 文本不一致；'
           + '本行的最终答复以 structured_output 为准（结构化输出是 CLI 按 schema 校验过的产出）'),
       );
     }
     state.finalText = serialized;
   } else if (text !== null && text !== '') {
     state.finalText = text;   // 既有路径，一个字不改
   }
   ```

4. `errors.ts` 的归因补一条：`error_max_structured_output_retries` 要走一句能直接展示的中文
   （「模型在多次重试内没有给出符合 schema 的评分结果：请检查评分提示词，或换一家评分智能体」），
   而不是把 CLI 的英文 subtype 原样冒到界面。归因码仍是 `AGENT_FAILED`（它不是密钥/限流/超时）。
   > **实施期落点修正（2026-09-29：Task 3 落地，全分支终审 M2 回写本行）**：实际落在
   > `packages/server/agents/src/providers/claude-code/events.ts` 的 `projectResult`（`:132-148`：
   > 中文归因进 `failure.message`，英文 subtype 另落一条 `stderr` WARN），**不是** `errors.ts`——
   > 理由是 `error_max_structured_output_retries` 是 **claude 一家的 subtype**，而 `errors.ts` 是三家共用的
   > 中性归因层（输入只有 message 文本与 baseUrl），把某一家 CLI 的枚举塞进共享层与
   > 「厂商方言留在 `providers/<kind>/`」这条既有边界冲突。归因码按本设计仍是 `AGENT_FAILED`。
   > 授权出处：计划的「计划对 spec 的两处修正」第 1 条
   > （`docs/superpowers/plans/2026-09-28-structured-judge-output.md:36-40`）。

### 5.4 codex（`providers/codex/`）

1. `sdk.ts:82` 的窄结构放宽成与 SDK 同形（`dist/index.d.ts:169-174`）：

   ```ts
   runStreamed: (
     prompt: string,
     options: { signal: AbortSignal; outputSchema?: Record<string, unknown> },
   ) => Promise<CodexRun>;
   ```

2. `index.ts:62` 的调用点按需带上它（同样：`undefined` 时一个字段都不加）：

   ```ts
   const run = await thread.runStreamed(input.prompt, {
     signal: streamAbort.signal,
     ...(input.outputSchema === undefined ? {} : { outputSchema: input.outputSchema }),
   });
   ```

3. **`events.ts` 不动**：结构化模式下 `agent_message` 的文本就是那段 JSON，采集点不变；
   §1.2 第 3 条的真机结论若与此不符，按实测回写（「探测前不当成已验证事实」是既有口径）。

### 5.5 dsh（`providers/dsh/index.ts`）

`startDsh` 开头加**纵深防御**（D11，生产路径上不可达——编排层不会传）：

```ts
// 第二道守卫（第一道在编排层：它按注册表能力决定不传）：dsh 的 SDK 客户端没有结构化输出通道，
// 悄悄忽略这个入参会让调用方以为「已经强约束」，而实际什么都没发生——本仓最忌讳的静默降级。
if (input.outputSchema !== undefined) {
  throw new Error('deepseek harness 的 SDK 客户端不支持结构化输出（没有 schema 入参）：这一行只能用提示词契约约束返回形状');
}
```

## 6. `evaluator` / 编排层

### 6.1 `judge-agent.ts`

`AgentJudgeInput` 增加 `outputSchema?: Record<string, unknown>`，原样转发给 `provider.run`；
`finalizeScore` 调用处多传一格 `structuredOutput: input.outputSchema !== undefined`。
其余四条例（只读档、`ok` 判定先于读答复、`finalText === null` 与空串分开、解析与收口共用）**一个字不改**。

### 6.2 `judge.ts`（共用尺子）

`finalizeScore` 的入参新增**必填** `structuredOutput: boolean`：让两个调用点（文本通路 / 智能体通路）
各自表一次态，而不是吃一个「谁也没选过」的默认值——与 `AgentRunInput.permission` 必填同一条口径。
文本通路那一处传 `false`（§2 非目标）。

### 6.3 文本通路

`judgeRow` 的调用、回问轮次（`JUDGE_REPAIR_ROUNDS = 2`）、`buildJudgeFeedback` 全部不动。

### 6.4 编排层（`orchestrator.ts` 的 `runJudgeStage`）

```ts
const kind = requireJudgeAgent({ defaultJudgeAgent: config.settings.defaultJudgeAgent, route });
// 能力决定要不要带 schema；**不支持必须留痕**（D4）：降级是允许的，静默降级不是。
const structuredOutput = getProvider(kind).metadata.capability.structuredOutput;
if (!structuredOutput) {
  publishRowEvent(ctx.runId, ctx.rowId, {
    type: 'log',
    stream: 'stderr',
    text: `[评分] ${AGENT_LABELS[kind]} 不支持结构化输出，本行回落到提示词契约（返回形状由结构检查兜底）`,
  });
}
```

`judgeRowByAgent({ …, outputSchema: structuredOutput ? JUDGE_OUTPUT_JSON_SCHEMA : undefined })`。

## 7. 界面

`packages/client/ui/src/composite/score-detail-view.tsx` 的「评分者」一行（`:44-48`）补第三段：
`输出约束：schema 约束` / `输出约束：提示词约束`（由 `score.structuredOutput` 决定）。
沿用 antd 组件与紧凑密度（写前按 AGENT.md 用 context7 查组件用法），**不新增字号与行内边距**。
`structuredOutput === false` 时**不显示任何告警样式**——它不是错误，只是事实（与「文本 API 评分」同一处置）。

## 8. 测试计划（TDD；每条新守卫都要变异验证）

| 层 | 用例 | 变异验证（把要拦的缺陷造回去，必须红） |
|---|---|---|
| contracts | §4.3 的五条一致性守卫 | 删掉 `enum` 里的一维 → 红；把 `score` 改成只写 `type: 'integer'` → 红 |
| contracts | `structuredOutput` 的默认值：老 `run.json` 里的 `ScoreResult` 读盘后是 `false` | 去掉 `.default(false)` → 读盘用例红 |
| agents | claude：假 SDK 断言 `options.outputFormat.schema === JUDGE_OUTPUT_JSON_SCHEMA`；**不传 schema 时 `outputFormat` 键不存在** | 把 `outputFormat` 从 options 里删掉 → 红；改成永远带上（`{}` 也带）→ 「不传时键不存在」那条红 |
| agents | codex：断言 `runStreamed` 第二参带 `outputSchema`；不传时第二参只有 `signal` | 同上两条同形 |
| agents | claude `events.ts`：`structured_output` 存在时 `finalText` 是它的序列化；不存在时仍取 `result`；两者**不一致**时多一条 `[WARN]` 草稿、**一致**时没有 | 把优先顺序反过来 → 红；去掉那条 WARN → 红 |
| agents | dsh：`input.outputSchema` 非空 ⇒ 抛中文错且不 spawn | 删掉守卫 → 红 |
| agents | `registry.test.ts`：三家都显式声明了 `capability.structuredOutput` | 把 dsh 那一格删掉 → 编译期红（必填），断言再兜一层 |
| evaluator | 带 schema 走通一条：`provider.run` 收到 schema、`ScoreResult.structuredOutput === true` | 把 `structuredOutput` 写死 `false` → 红 |
| evaluator | 不带 schema 时逐字保持今天的行为（现有用例**不许改**，必须全绿） | —（这条是回归，不是新守卫） |
| evaluator | 文本通路 `finalizeScore` 传 `false` | 传 `true` → 红 |
| 编排层 | `useAgentJudge` + dsh：该行事件日志里有一条降级说明，且 `ScoreResult.structuredOutput === false` | 去掉那条 `publishRowEvent` → 红 |
| 编排层 | `useAgentJudge` + claude-code：**没有**降级日志，`structuredOutput === true` | 把能力判断写死 `false` → 红 |

## 9. 风险与已知边界

1. **网关透传（最高风险）**。schema 落到 wire 上就是请求体里的一格；网关不认时**不报错**，
   只是模型照旧自由生成。可观测手段只有两条：`ScoreResult.structuredOutput` 与 `score.raw`
   （schema 生效时 `raw` 必然是一段能解析的 JSON，且形状与 schema 同形）。§11 第 2 项是判据来源。
   本设计**不假设**网关一定认——它只是把「认不认」变成一次可执行的对照实验。
2. **两条通路在「越界」这一格上有意不同**（D7）：文本通路会把 `score: 6` 夹紧成 5，
   agent 通路在 schema 下根本不会拿到 6（拿到了说明网关没透传，走 §9 第 1 条）。这是登记项，不是缺陷。
3. **cc 的结构化轮次可能更慢**：形状不符时 CLI 自己重问（`error_max_structured_output_retries`），
   单行耗时与轮次都会上升。「评分不限时间」是既有用户口径（`AgentRunInput` 已无 `timeoutMs`），
   而轮次/用量/耗时本来就有记账（`turns` / `tokens` / `durationMs`）。
4. **契约文本与 schema 的漂移**：`JUDGE_OUTPUT_CONTRACT`（文本）与 `JUDGE_OUTPUT_JSON_SCHEMA`（schema）
   是同一条契约的两个投影，靠 §4.3 的守卫与「同批修改」的注释约束。rubric spec 落地时两者必须**同批**替换。
5. **`result.result` 在结构化轮次里的内容未知**（§1.2 第 1 条）：本设计的 D8 用「优先 `structured_output`」
   把这条不确定性挡在出口之外，但**不排除** CLI 把 `result` 也填成同一段 JSON（届时两条分支给出同一结果，
   无害）。冒烟会把真实形状写回本文件。
6. **dsh 的分数与开通 schema 的分数不可直接比较**：这是本设计要暴露的事实（§1 第 3 条），
   不是它能消除的问题。要消除只有一条路——给 dsh 补上结构化输出通道，那是独立需求（§2 已排除自研插件）。

## 10. 验收标准

1. 全部新守卫按 §8 完成**变异验证**（每条都见过红），并把变异记录写进实施计划的关账记录。
2. `pnpm typecheck` / `pnpm lint` / `pnpm test` 全绿；**既有用例一条不改**（除 §8 里明确列出的两处新增断言）。
   > **验收状态（2026-09-29，全分支终审修复波回写）**：`typecheck` / `lint` 已 exit 0；**「`pnpm test` 全绿」在本机不可达**
   > ——本计划**开工前的基线**即 `6 failed | 1529 passed (1535)`，三次全量采样（失败用例 `3 / 8 / 19`）全部是
   > 60s 超时与 Windows 临时目录 EPERM 的负载抖动，**没有一条断言失败**。该条**由控制方裁定 R52 替换接受**为
   > 本环境可验证的形式：**`pnpm test` 的全部失败必须落在已知抖动集（`api/cases-crud`、`core/mirror-*`、
   > `evaluator/orchestrator-*`）内，且已识别的失败文件逐个隔离复跑为绿**（样本 #3 的 12 个失败文件：
   > 12/12 落在集合内、12/12 隔离复跑为绿；样本 #3 与**本计划触碰的 17 个测试文件交集为空**）。
   > **用户可在收口时复核**（口径、三次采样的原始日志与清单都在完成记录 §一 与 SDD 目录里）。
   > 「既有用例一条不改」按 R44/R46/R51 有**一处授权例外**（UI 那条整行期望串：原两段逐字保留、新段位置被整行匹配钉住
   > ⇒ 更新后更强），其中 1 条减覆盖的残余盲区已登记（完成记录 §5.4 / §七 R51）。
3. 真机三项（§11 第 1–3 项）有结论；§1.2 的三条未验证项各自变成「已验证」或「按实测回写本文件」。
4. 页面上：claude-code / codex 行的评分详情显示「输出约束：schema 约束」，dsh 行显示「提示词约束」，
   且 dsh 行的日志抽屉里能看到降级说明。
5. `run.json` 里 `score.structuredOutput` 与「这一行实际有没有带 schema」一致（CLI 复核）。
6. 本设计**未新增任何依赖**：`package.json` 与 `pnpm-lock.yaml` 的 diff 为空。

## 11. 冒烟计划（实施阶段执行）

> 状态（2026-09-29）：Task 1-10 已完成并入库；上表四项**待人工真机执行**，执行后把结论写回 §1.2。

| # | 项 | 判据 |
|---|---|---|
| 1 | cc 真机一次评分（开 schema） | `run.json` 的 `score.structuredOutput === true`；dump 收尾消息，回答 §1.2 第 1 条（`result` 与 `structured_output` 各自内容）。**第二支判据（2026-09-29 终审 M3 追加）**：适配器对两个来源做的是**逐字节**比对（`events.ts` 的 `text !== serialized`）⇒ 真机若把 `result` 填成**同一份 JSON 但键序/空白不同**、或一句**自然语言摘要**，则**每一条 schema 行都会刷一条「不一致」WARN**。故本项要分两支落结论：确认 `result` 就是**同一份 JSON 文本** ⇒ 逐字节比对即正确判据、保留现状；是摘要（或等价但不等字面）⇒ 再决定「两边都能 parse 时做深比较」还是「把该行降为 INFO」——**本设计不改代码**，按实测结论单开一处小改动 |
| 2 | **网关透传对照**：同一用例、同一模型，schema 开 / 关各跑一次 | 开的那次 `raw` 是合法 JSON 且形状与 schema 同形；若仍是散文/解析失败 ⇒ 判定网关未透传，**照实登记进 §9**（不改设计） |
| 3 | codex 真机一次（含一次**故意非法**的 schema） | 正常那次 `structuredOutput === true`；非法那次失败归因是「上游/CLI 拒绝 schema」而不是「模型答错」 |
| 4 | 页面复核 | 评分详情的「输出约束」一格与 `run.json` 互证；dsh 行的降级日志可在抽屉里看到 |

记录口径按 AGENT.md 的四要素（范围清单 / 操作路径 / 浏览器与 CLI 互证 / 未覆盖项）。

## 12. 关键文件清单

| 文件 | 改动 |
|---|---|
| `packages/server/contracts/src/score.ts` | 新增 `JUDGE_OUTPUT_JSON_SCHEMA`、导出两个分值常量、`ScoreResultSchema.structuredOutput` |
| `packages/server/contracts/src/score.test.ts` | §4.3 五条守卫 + 默认值用例 |
| `packages/server/agents/src/types.ts` | `AgentRunInput.outputSchema?`、`capability.structuredOutput` |
| `packages/server/agents/src/registry.test.ts` | 三家显式声明能力的断言 |
| `packages/server/agents/src/providers/claude-code/{sdk,index,events}.ts` | 窄结构加格、调用点按需带、`structured_output` 优先 |
| `packages/server/agents/src/providers/claude-code/{index,events}.test.ts` | §8 对应守卫 |
| `packages/server/agents/src/providers/codex/{sdk,index}.ts` | 窄结构放宽、调用点按需带 |
| `packages/server/agents/src/providers/codex/index.test.ts` | §8 对应守卫 |
| `packages/server/agents/src/providers/dsh/index.ts`（+ `.test.ts`） | 纵深防御守卫 |
| `packages/server/evaluator/src/judge-agent.ts`（+ `.test.ts`） | `outputSchema` 转发与记账 |
| `packages/server/evaluator/src/judge.ts`（+ `.test.ts`） | `finalizeScore` 必填入参（文本通路传 `false`） |
| `packages/server/evaluator/src/orchestrator.ts`（+ `.test.ts`） | 能力判断、降级日志、按需带 schema |
| `packages/client/ui/src/composite/score-detail-view.tsx`（+ `.test.tsx`） | 「输出约束」一格 |
| **不动** | `permission.ts`、`judge-route.ts`、`text-api.ts`、候选阶段全部、所有既有用例 |

## 13. 待评审项

| # | 待决 | 建议 |
|---|---|---|
| 1 | 文本通路（`judgeRow`）本期是否一并开 schema | 不开（§2）。schema 字面量已就位，等 agent 通路真机验完，它是 `callTextApiConversation` 上的一处独立小改动 |
| 2 | D7 那条「越界」差异是否接受 | 接受。请求侧阻止优于解析侧夹紧；差异已用一条用例钉住并登记在 §9 |
| 3 | `totalScore` 是否趁这次从契约文本与 schema 里一起去掉 | 不去（D5）。等 rubric spec 落地时与契约文本**同批**替换 |

**实施期结论**（2026-09-29，Task 1–10 完成后回写）：三条均在实施中被裁决并按此落地，理由各一句——

1. **文本通路本期不开 schema**：`judgeRow` 的调用、回问轮次与 `buildJudgeFeedback` 全部不动（§6.3）；schema 字面量已就位，agent 通路的真机结论出来之前一并开，等于把未验证的落点复制到第二条通路上。
2. **接受 D7 那条「越界」差异**：schema 在**请求侧**阻止 `score: 6`，而解析侧的夹紧是兜底；差异已用一条用例钉住（`score.test.ts`「schema 拒绝越界分数（严档）」）并登记在 §9 第 2 条。
3. **`totalScore` 不动**：与 rubric spec 落地时和契约文本**同批**替换（D5），避免出现「文本一套、schema 另一套」。
