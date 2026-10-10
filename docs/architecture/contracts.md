# 契约体系

## 定位

`@aieval/contracts` 是全仓唯一跨端契约真源：zod 3 schema + 领域类型 + 错误码，服务端与客户端共享同一份；类型一律 `z.infer` 从 schema 派生，不存在「schema 与类型各写一份」。依赖方向上 contracts → 无——只依赖 zod 这类第三方，指回任何 `@aieval/*` 都是环；ui / client / core / agents / evaluator / api 的跨端类型全部从这里取。

## 形态与交互

一领域一文件，`index.ts` 分组汇总导出全部名字（含 type 导出），框架层只从包出口 import：

| 文件 | 领域 |
|---|---|
| `errors.ts` | 错误码表 `ERROR_CODES` + `STATUS_BY_CODE` / `httpStatusFor` + `ServiceError` |
| `settings.ts` | 设置契约与默认值（`SETTINGS_DEFAULTS`、主题三档、评分默认） |
| `provider.ts` | 供应商：落盘形态、下行形态（掩码）、create / patch 入参 |
| `case.ts` | 用例：`TestCaseSchema`、创建 / 补丁入参、`RepoInfo`、`CASE_ID_PATTERN` / `isCaseIdShapeValid`（id 文件名安全）、`CaseList`（列表 + 被跳过的坏文件原因） |
| `case-sync.ts` | 用例同步：`CaseSyncStatus`（`GET /api/cases/sync-status` 的只读快照，含 `remoteAhead` 的「未知用 `null`」口径）、`CaseSyncAction`（人工提交 / 拉取） |
| `run.ts` | 评测与候选行：`EvalRunSchema` / `EvalRowSchema`、行状态机、diff 响应 |
| `score.ts` | 评分结果 + 送模型的输出契约（两份投影，见「机制与演化」） |
| `agent.ts` | `AGENT_KINDS` / `AgentKind` / `AGENT_LABELS` |
| `agent-event.ts` | 行级事件日志条目（`seq` 从 1 单调递增，判别联合用 `discriminatedUnion`） |
| `agent-message.ts` | 统一消息信封、内容块、工具族、子任务行、计量结构与能力声明 |
| `agent-environment.ts` | 智能体环境信息模型（与执行日志解耦，由日志层展示） |
| `rubric.ts` | 评分表：schema、引用键、`validateRubric`、`composeTotalScore`、`renderRubricForJudge` |
| `effort.ts` | 档位域算法（`CANONICAL_EFFORT_LEVELS` / `intersectEfforts`） |
| `repo-source.ts` | 用例代码来源的形态判定、归一与仓库名解析 |

契约的成对形态：`XSchema`（zod schema，运行时校验）+ `X = z.infer<…>`（编译期类型）。schema 是真源，类型是投影——改字段只改 schema 一处，两侧同时生效。

## 数据与契约

- **冗余快照是承重的，不是反范式**：评测记录的价值在「可追溯」。`EvalRun` 快照 `caseTitle` / `repoPath` / `commitHash` / `repoBranch` / `rubric`，`EvalRow` 快照 `providerName` / `baseUrl`——只存外键的话，删用例 / 改供应商之后，历史评测就说不清「当时测了什么」。`rubric` 快照同时决定满分：评分表改了之后，历史分与它自己的满分仍然自洽。冗余的是展示与追溯所需的**只读快照**，不是可变配置。
- **可选字段是载重的**：`useAgentJudge`、`attempts`、`error.stage`、`subagentTokens`、`subagentTurns`、`effort`、`judgeAgentKind`、`judgeEffort`、`structuredOutput`、`judgeTokens`、`judgeDurationMs` 等在磁盘上都可能有旧记录缺格。必填会让 `EvalRunSchema.safeParse` 失败而 `listRuns()` 对失败**静默跳过**——表现为「评测记录凭空少了几轮」，两端都不报错。故新字段一律 `.default(...)`；跳过必须可见：`listRuns` 在同一趟扫描最后记一条**汇总 WARN**。
- **时间字段一律 ISO 8601 带时区字符串**（如 `2026-09-22T10:30:00.000Z`），不用 epoch——人可读，且免时区歧义。
- **`EvalRow.diff` 只存计数摘要不存正文**（diff 正文按需现算，一轮可达数 MB）；`tokens` 为 `null` 表示未采到，**绝不填 0**。
- **评分契约 `ScoreResult`**：逐项二元判定 `judgments`（引用键有 id 用 id、没 id 用 `#k`；缺一项即整行失败）+ `totalScore`（系统按权重加总，**模型不给总分**）+ `maxScore`（满分快照，必须为正）+ 尺子四格（`judgeProviderId` / `judgeModelId` / `judgeAgentKind` / `judgeEffort`——光有模型名回答不了「这个分是文本请求打的还是智能体会话打的、什么强度」）。
- **落盘 / 下行双形态**：`ProviderSchema` 含明文 `apiKey`，只在服务端流转；`ProviderViewSchema` = `omit(apiKey)` + `extend(apiKeyMasked)` 掩码下行——字段是否存在由类型保证，不靠「记得别传」；create / patch 入参用 `.partial()`。
- **错误码体系**：`ERROR_CODES`（4xx 在前、5xx 在后）+ `STATUS_BY_CODE` / `httpStatusFor`（每个码必须有 HTTP 映射）+ `ServiceError`（服务端与客户端共用同一张表）。`AgentErrorCode` 是 agents 包的领域归因，**不进 `ERROR_CODES`**——它没有对应 HTTP 状态，进了就得编造状态码。
- **`AGENT_KINDS` / `AgentKind` 的真源在 contracts**（`agent.ts`），agents 包**再导出**：contracts 不能 import agents（那是环），而前端下拉与 `EvalRow.agentKind` 要从同一处派生。

## 机制与演化

- **两份契约投影同批替换**（最核心的口径，真源在 `score.ts` 文件头）：`JUDGE_OUTPUT_CONTRACT`（文本契约，进提示词）与 `JUDGE_OUTPUT_JSON_SCHEMA`（结构化输出，给 claude-code 的 `outputFormat` 与 codex 的 `outputSchema`）是**同一条契约的两个投影**，必须**同批修改**——只动一侧会让「模型按 schema 回的」与「解析器按提示词认的」分叉，界面表现为「模型回得挺好、解析就是失败」。守卫在 `score.test.ts`：同形守卫（字段名逐项对齐）+「两份投影里都不出现 `totalScore`」+「`minItems` / `maxItems` 不存在」（项数由每张评分表决定，编译期字面量表达不了，只能由结构检查判）。schema 手写字面量，**不引 `zod-to-json-schema`、不写通用转换器**（那是第二份真源）；只用可移植子集（无 `oneOf` / `const` / `prefixItems` / `uniqueItems`）。`achieved` 请求侧取 boolean 严档、解析侧宽容读——有意登记的差异。
- **schema 分层机制**：schema 同时承担运行时校验与类型推导的单一真源。读侧容忍——`listRuns()` 对坏快照跳过并记汇总 WARN（一条坏数据不该让整个列表白屏）；写侧 `appendEvent` 也做 `safeParse`（写侧容忍的后果是静默少一条事件）。
- **契约先行的组织方式**：p0 一次性建好全部契约、后续计划只消费。跨计划可见的名字由一份「接缝契约」钉死——spec 说为什么、计划说怎么做、接缝契约说叫什么；三份文档各自回答一个问题，名字只在一处定义。
- **类型期与运行期依赖边的区分**：`@aieval/client` 用 `export type … from '@aieval/ui'` 转出界面类型，编译期即被抹掉，故依赖方向表不列这条边、ui 放 `devDependencies`。**只允许 `export type`**：写成值导出就真有运行时依赖，得回来改表。
- **演化：`protocolType` 单值 → `protocolTypes` 集合**（dsh 两条 wire 都真机跑通后收口）：整体替换而非并存加格——不留两格真源；四处判定点改读同一判据 `acceptsProtocol`，文案收成 `protocolMismatchMessage`。

## 已知边界与取舍

| 边界 | 状态 | 处置与判据 |
|---|---|---|
| `AgentErrorCode` 不进 `ERROR_CODES` | 有意设计 | 它没有对应 HTTP 状态，进了 `STATUS_BY_CODE` 就得编造状态码；由 `errors.test.ts`「AgentErrorCode 不进 ERROR_CODES」钉住 |
| 契约可选字段的兼容载荷 | 常态 | 旧记录缺格是常态，必填会让 `listRuns()` 静默跳过整轮；处置：新字段一律 `.default(...)`，跳过必须在同趟扫描记**汇总 WARN**（「列表短了」与「为什么短」在同一条日志流里挨着） |
| dsh 是否还有第三条 wire | 未验证 | `protocolTypes` 单值改集合时只真机验证了两条；若发现第三条，单值 / 集合设计需重开（收口时的残余不确定性，如实登记） |
| 结构化输出不承诺上游照做 | 有意登记 | `structuredOutput` 记的是「schema 真的下发给了适配器」，网关可能丢掉这格而分照样记 `true`；`achieved` 请求侧 boolean 严档、解析侧宽容读（有意登记的差异，与旧体系「schema 拒 6 分、解析器夹紧到 5」同一形状） |

## 相关链接

- 仓库内活文档：`AGENTS.md`「技术栈」（zod 3 契约行）、「依赖方向」（contracts → 无的环约束、类型转出不算依赖边的口径）、「约束」（`agentProvider.run` 唯一入口与注册表判据）——按节名定位，表与规则的真源在那里，本文不复制
- 知识文章：[仓库分层与依赖方向](/architecture/layering)、[工具链与命令聚合](/architecture/toolchain)（架构域同批）
- [用例管理](/features/case-management) —— 评分标准项契约（引用键 / `validateRubric` / 快照）与 `repo-source` 形态判定的消费现场
- [《评分》](/features/judging)、[《数据与存储》](/features/storage) —— `ScoreResult` 的评分侧全链、落盘与原子写
- [故障索引](/faq/) —— 契约解析失败类报错的排障入口
