# 契约体系

## 定位

`@aieval/contracts` 是全仓唯一跨端契约真源：zod 3 schema + 领域类型 + 错误码，服务端与客户端共享同一份；类型一律 `z.infer` 从 schema 派生，不存在「schema 与类型各写一份」。依赖方向上 contracts → 无——只依赖 zod 这类第三方，指回任何 `@aieval/*` 都是环；ui / client / core / agents / evaluator / api 的跨端类型全部从这里取。

## 形态与交互

一领域一文件，`index.ts` 分组汇总导出全部名字（含 type 导出），框架层只从包出口 import：

| 文件 | 领域 |
|---|---|
| `errors.ts` | 错误码表 `ERROR_CODES` + `STATUS_BY_CODE` / `httpStatusFor` + `ServiceError` |
| `settings.ts` | 设置契约与默认值（`SETTINGS_DEFAULTS`、主题三档、评分默认） |
| `provider.ts` | 供应商：落盘形态、下行形态（掩码）、create / patch 入参；另住**统一的关闭思考档名** `EFFORT_OFF`（`'off'`，四家各自翻成厂商词汇） |
| `case.ts` | 用例：`TestCaseSchema`、创建 / 补丁入参、`RepoInfo`、`CASE_ID_PATTERN` / `isCaseIdShapeValid`（id 文件名安全）、`CaseList`（列表 + 被跳过的坏文件原因） |
| `case-sync.ts` | 用例同步：`CaseSyncStatus`（`GET /api/cases/sync-status` 的只读快照，含 `remoteAhead` 的「未知用 `null`」口径）、`CaseSyncAction`（人工提交 / 拉取） |
| `run.ts` | 评测与候选行：`EvalRunSchema` / `EvalRowSchema`、行状态机、diff 响应 |
| `artifact.ts` | **候选产物**（`RESULT.md` / `RESULT.html` / `RESULT.svg`）：唯一一份后缀白名单（数组顺序 = 同一候选内的读取顺序）、`artifactKindOf`（大小写不敏感、只认一层文件名，也是读盘那一路路径穿越的第一道门）、索引 / 正文两个出口形状、两个上限（超过读取上限**拒绝**、超过正文字符上限**截断** + `truncated`） |
| `score.ts` | 评分结果 + 送模型的输出契约（两份投影，见「机制与演化」） |
| `agent.ts` | `AGENT_KINDS` / `AgentKind` / `AGENT_LABELS` |
| `agent-event.ts` | 行级事件日志条目（`seq` 从 1 单调递增，判别联合用 `discriminatedUnion`） |
| `agent-message.ts` | 统一消息信封、内容块、工具族、子任务行、计量结构，以及**五组能力声明**（行级 `capability` / 内容级 `messageCapability` / 下发级 `injection` / 交互面 `interaction` / 人工消息面 `turnInjection`）——五组分开的理由同源：变化原因、消费方与判据通道各不相同。信封里两处跨端共用的小工具也在这里：折叠键 `messageFoldKey`（**段 + 载体键**，服务端折叠与界面折叠共用同一份实现）与段号 `segment`（第几次追问那一段；缺席 = 第一次跑那一段） |
| `inject-vocab.ts` | 人工消息的**词表**：投递两档（`round` / `idle`）、一条的四态（`queued` / `delivered` / `consumed` / `gone`）、收场五值（投递两值 + 两种丢弃 + 撤回的两个结果）。单独一格是为了断掉 `agent-event` 与 `agent-message` 的循环引用（理由与 `ask-user-vocab.ts` 同源） |
| `inject-message.ts` | 人工消息的**传输形状**：快照里的一条、随它发出去的附件清单，以及发送 / 改期 / 撤回 / 上传四个动作的请求与响应 |
| `agent-environment.ts` | 智能体环境信息模型（与执行日志解耦，由日志层展示） |
| `rubric.ts` | 评分表：schema、引用键、`validateRubric`、`composeTotalScore`、`renderRubricForJudge` |
| `effort.ts` | 档位域算法（`CANONICAL_EFFORT_LEVELS` / `intersectEfforts`） |
| `repo-source.ts` | 用例代码来源的形态判定、归一与仓库名解析 |

契约的成对形态：`XSchema`（zod schema，运行时校验）+ `X = z.infer<…>`（编译期类型）。schema 是真源，类型是投影——改字段只改 schema 一处，两侧同时生效。

## 数据与契约

- **冗余快照是承重的，不是反范式**：评测记录的价值在「可追溯」。`EvalRun` 快照 `caseTitle` / `repoPath` / `commitHash` / `repoBranch` / `rubric`，`EvalRow` 快照 `providerName` / `baseUrl`——只存外键的话，删用例 / 改供应商之后，历史评测就说不清「当时测了什么」。`rubric` 快照同时决定满分：评分表改了之后，历史分与它自己的满分仍然自洽。冗余的是展示与追溯所需的**只读快照**，不是可变配置。
- **可选字段是载重的**：`useAgentJudge`、`attempts`、`error.stage`、`subagentTokens`、`subagentTurns`、`effort`、`judgeAgentKind`、`judgeEffort`、`structuredOutput`、`judgeTokens`、`judgeDurationMs`、`note` 等在磁盘上都可能有旧记录缺格。必填会让 `EvalRunSchema.safeParse` 失败而 `listRuns()` 对失败**静默跳过**——表现为「评测记录凭空少了几轮」，两端都不报错。故新字段一律 `.default(...)`（用户备注 `note` 缺格读成空串）；跳过必须可见：`listRuns` 在同一趟扫描最后记一条**汇总 WARN**。
- **时间字段一律 ISO 8601 带时区字符串**（如 `2026-09-22T10:30:00.000Z`），不用 epoch——人可读，且免时区歧义。
- **`EvalRow.diff` 只存计数摘要不存正文**（diff 正文按需现算，一轮可达数 MB）；`tokens` 为 `null` 表示未采到，**绝不填 0**。
- **评分契约 `ScoreResult`**：逐项二元判定 `judgments`（引用键有 id 用 id、没 id 用 `#k`；缺一项即整行失败）+ `totalScore`（系统按权重加总，**模型不给总分**）+ `maxScore`（满分快照，必须为正）+ 尺子四格（`judgeProviderId` / `judgeModelId` / `judgeAgentKind` / `judgeEffort`——光有模型名回答不了「这个分是文本请求打的还是智能体会话打的、什么强度」）。
- **落盘 / 下行双形态**：`ProviderSchema` 含明文 `apiKey`，只在服务端流转；`ProviderViewSchema` = `omit(apiKey)` + `extend(apiKeyMasked)` 掩码下行——字段是否存在由类型保证，不靠「记得别传」；create / patch 入参用 `.partial()`。
- **错误码体系**：`ERROR_CODES`（4xx 在前、5xx 在后）+ `STATUS_BY_CODE` / `httpStatusFor`（每个码必须有 HTTP 映射）+ `ServiceError`（服务端与客户端共用同一张表）。`AgentErrorCode` 是 agents 包的领域归因，**不进 `ERROR_CODES`**——它没有对应 HTTP 状态，进了就得编造状态码。
- **`AGENT_KINDS` / `AgentKind` 的真源在 contracts**（`agent.ts`），agents 包**再导出**：contracts 不能 import agents（那是环），而前端下拉与 `EvalRow.agentKind` 要从同一处派生。
- **`turnInjection`（人工消息面，第五组）是家 × 两档 × 两件事 + 续接一格的矩阵**，形状与另四组不同：
  - `delivery.{round,idle}` 与 `resume` 共用同一个**能力格**形状，每格声明 `state`（五态词表**原样复用、一个词不加**）+ 必填 `reason`（非 `yes` 时）+ **`channel`**（`'wire'` / `'in-process-plugin'` / `'in-process-sdk'`）+ **`gate`**（`{ version }` 或 `null`）+ **`experimental`** + **`proofDriver`** / `proofDriverReason`。三个非显然字段各有理由：`channel` 要它是因为**代价不同**（wire 上现成的方法 / 进程内 SDK / 为它常驻一支插件 + side channel 是三件事）；`gate` 要它是因为有的家是**真版本门**（方法自某版起才存在，或某个参数自某版起必填），塞进 `notes` 就没人读得到；`experimental` 留着是因为「wire 上有」≠「官方承诺稳定」。
  - **撤回另按 `(家, 档)` 声明、与投递分开**——「能收但不能撤」是合法的一家。取值**四档**：`by-id` / `flush-only`（只能整条队列全清）/ `none` / `unverified`，且 `reason` 必填、**要把判据写进去**（按什么认人 / 是不是整条清）：`by-id` 在三家认的是三个不同的身份（我们自铸的 uuid / 我们自己发的 messageId / 厂商的提交 id），界面要说得出「撤回可能撤掉哪一条」。**不许写成一格「支持撤回」**。
  - **`resume` 是单格**、不按边界分两档：续接不是「哪一档」的问题，它是「从哪条会话接着跑」。续接之后的追问**天然落在 `'idle'` 档**，而 `'round'` 只活在「同一条命」里——这一格就是这个组合关系唯一可查的能力位。
  - **缺席按「不知道」处置，不编一份都支持的**（照 `messageCapability` 的缺省 `null`，**不照** `OPTIMISTIC_CAPABILITY`）：猜错会让界面说谎，而说谎的形态是「按钮可点、消息静默消失」。
  - 今天的取值：**投递两档只有 dsh 是 `yes`**；cc 与 codex 记 `unverified` / `unverified`——cc 是「通道与接线都在、厂商侧那个投递点没被真路径观测过」，codex 是「两档的方法名与前置条件出自从 wire 生成物，真机投递点没有读数」；pi 记 `off-by-adapter` / `not-observed`（厂商侧那条通道在、适配器一格端口都没挂）。撤回 pi `flush-only`、cc 与 dsh `by-id`、codex `'round'` 是 `none` / `'idle'` 是 `by-id`；续接四家都是 `yes`（dsh 那一格的正向证据走真路径）。四家的落点与边界见各自接入篇的《注入与续接》。
- **声明与证据的分界：`proofDriver`**（`'real-path'` / `'synthetic-fixture'`）回答「这一格的证据是哪一档」，与 `state` 是两个问题。**`yes` 必须配 `real-path`**：夹具扮演厂商那一端时「我们传了什么」看得见、「厂商拿它做了什么」看不见 ⇒ 假件证不出「厂商真的收下了、模型真的看到了」。非 `yes` 的格同样必填——**真路径上观察到做不到也是一种证据**，与「没验过」必须分得开。

## 机制与演化

- **两份契约投影同批替换**（最核心的口径，真源在 `score.ts` 文件头）：`JUDGE_OUTPUT_CONTRACT`（文本契约，进提示词）与 `JUDGE_OUTPUT_JSON_SCHEMA`（结构化输出，经 `AgentRunInput.outputSchema` 交给四家——cc / codex 走原生字段、pi 走工具通道（strict），dsh 由适配器内部填充）是**同一条契约的两个投影**，必须**同批修改**——只动一侧会让「模型按 schema 回的」与「解析器按提示词认的」分叉，界面表现为「模型回得挺好、解析就是失败」。守卫在 `score.test.ts`：同形守卫（字段名逐项对齐）+「两份投影里都不出现 `totalScore`」+「`minItems` / `maxItems` 不存在」（项数由每张评分表决定，编译期字面量表达不了，只能由结构检查判）。schema 手写字面量，**不引 `zod-to-json-schema`、不写通用转换器**（那是第二份真源）；只用可移植子集（无 `oneOf` / `const` / `prefixItems` / `uniqueItems`）。`achieved` 请求侧取 boolean 严档、解析侧宽容读——有意登记的差异。
- **schema 分层机制**：schema 同时承担运行时校验与类型推导的单一真源。读侧容忍——`listRuns()` 对坏快照跳过并记汇总 WARN（一条坏数据不该让整个列表白屏）；写侧 `appendEvent` 也做 `safeParse`（写侧容忍的后果是静默少一条事件）。
- **契约先行的组织方式**：全部契约一次性建好、后续只消费。跨边界可见的名字由一份「接缝契约」钉死——**为什么、怎么做、叫什么**各由一份文档回答，名字只在一处定义。
- **类型期与运行期依赖边的区分**：`@aieval/client` 用 `export type … from '@aieval/ui'` 转出界面类型，编译期即被抹掉，故依赖方向表不列这条边、ui 放 `devDependencies`。**只允许 `export type`**：写成值导出就真有运行时依赖，得回来改表。
- **`protocolTypes` 是集合不是单值**：整体替换而非并存加格——不留两格真源；四处判定点读同一判据 `acceptsProtocol`，文案收成 `protocolMismatchMessage`。
- **能力声明与产品互钉（`turnInjection` 这一组的成文规矩）**：规则写死「**声明不许先于夹具**」——哪家接通，该格声明与那个能造出该事实的场景必须**同一次提交**进来。守卫按三格（`delivery.round` / `delivery.idle` / `resume`）逐格判四件事：① 声明自身的 schema 合规与「非 `yes` ⇒ `reason` 在白名单里」；② **每一格都要有证明安排**（非 `yes` 的格要的是**反断言**——确实做不到；跳过会让「没接」与「接坏了」看起来一模一样）；③ 夹具登记的驱动器档位必须与声明里那一格**逐字相同**（「这一格的证据是哪一档」只能有一个答案，两处各写一份时消费方读到的是声明那一份）；④ `yes` ⇒ 真路径**且**观察到成立，非 `yes` ⇒ 不许观察到成立（自相矛盾即红）。
  这条规矩**一并补上了先例那个洞**：`askUserProofDriver` 当年只核声明自身的合规性，从来没人核过「这家提交的驱动器真的是真路径」——驱动器**真伪**现在由接入守卫静态核对（登记的驱动器在盘上、没有假厂商记号、真的走了产品那条造客户端的路）。

## 已知边界与取舍

| 边界 | 状态 | 处置与判据 |
|---|---|---|
| `AgentErrorCode` 不进 `ERROR_CODES` | 有意设计 | 它没有对应 HTTP 状态，进了 `STATUS_BY_CODE` 就得编造状态码；由 `errors.test.ts`「AgentErrorCode 不进 ERROR_CODES」钉住 |
| 契约可选字段的兼容载荷 | 常态 | 旧记录缺格是常态，必填会让 `listRuns()` 静默跳过整轮；处置：新字段一律 `.default(...)`，跳过必须在同趟扫描记**汇总 WARN**（「列表短了」与「为什么短」在同一条日志流里挨着） |
| dsh 是否还有第三条 wire | 未验证 | 目前真机只跑到两条；若发现第三条，单值 / 集合设计需重开（残余不确定性，如实登记） |
| 结构化输出是**每-run 通道事实**，不是能力位 | 有意设计 | `structuredOutput` 记「这一次有没有走原生 schema 通道」，由适配器上报（cc 按收尾消息里有没有 `structured_output`、codex 按这次有没有把 schema 发进 `turn/start`、pi 按答复是否确实来自被 strict 约束的工具参数、dsh 恒 `false`）；`false` **不等于答复不合格**——保证强度四家不同（原生字段 / 工具通道 / 适配器填充层），交付契约相同。`achieved` 请求侧 boolean 严档、解析侧宽容读（有意登记的差异：请求侧拦身份、解析侧拦形状） |
| `turnInjection` 的互钉能拦什么、拦不到什么 | 已划清 | 拦「声明 `yes` 却拿假件证明」「声明与夹具登记的驱动器不一致」「非 `yes` 的格没有反断言」三类；**拦不到**的是夹具自报的 `observed` 那一格，以及三处一起成心写对的情形——那只有真机冒烟拦得住（与下发级注入面那条边界同源） |
| 能力五态里 `off-by-adapter` 允许搭两句缺失原因（`not-observed` 或 `unverified`） | 已对齐 | 契约层两者都放行，界面侧的「等级 → 默认原因」表钉 `not-observed`，而真读到 `reason` 时以**声明里的那一句**为准（两处都在，别只改一处） |

## 相关链接

- 仓库内参考：[《工具链与命令聚合》](/architecture/toolchain)（技术栈与 zod 3 契约行）、[《仓库分层与依赖方向》](/architecture/layering)（contracts → 无的环约束、类型转出不算依赖边的口径）、[《Provider 抽象与 run 入口》](/protocols/provider-run)（`agentProvider.run` 唯一入口与注册表判据）
- 知识文章：[仓库分层与依赖方向](/architecture/layering)、[工具链与命令聚合](/architecture/toolchain)（架构域同批）
- [用例管理](/features/case-management) —— 评分标准项契约（引用键 / `validateRubric` / 快照）与 `repo-source` 形态判定的消费现场
- [《评分》](/features/judging)、[《数据与存储》](/features/storage) —— `ScoreResult` 的评分侧全链、落盘与原子写
- [《Provider 抽象与 run 入口》](/protocols/provider-run)、[《行执行与日志》](/features/row-execution) —— `turnInjection` 那一组的两个消费面（入参两格 / 结果一格；队列表四态与账本 `origin`）
- [故障索引](/faq/) —— 契约解析失败类报错的排障入口
