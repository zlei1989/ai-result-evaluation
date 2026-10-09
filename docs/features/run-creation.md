# 创建评测

## 定位

创建评测 = 给一道固定的题（用例）配一组候选（智能体 × 模型 × 思考强度）与执行模式。创建那一刻把用例的题面、仓库来源与评分表快照进轮次——换用例、改用例、删用例都不影响已建的轮次。创建后即落库（`idle`）**不自动开跑**：「开始」是评测详情页的显式动作。入口在 `/runs` 页右上「创建评测」，右栏表单（`?panel=new`）。

## 页面形态与交互

### 表单字段

| 字段 | 控件与行为 |
|---|---|
| 用例 | `Select`，选项显示「标题 · 仓库名 · commit 短哈希」（仓库名走 `displayRepoName`）；必填。编辑态原用例被删掉时补一个**禁用占位项**（否则下拉空白，用户只改执行模式、一保存就换了个用例） |
| 执行模式 | `Radio.Group`：串行（默认）/ 并行；串行在前、并行在后。默认串行是因为并行不设并发上限——多候选一起开跑时最先撞上的通常是供应商限流 |
| 候选行 | `Form.List` 动态增减，每行三个选择：智能体（Claude Code / Codex / DeepSeek Harness）+ 模型 + **思考强度** |
| 使用智能体评分 | `Switch`，默认关。打开而未配置默认评分智能体时给内联 `Alert` 指向设置页并说清「这一轮会创建失败（服务端当场拒绝）」；「或新建评测时关闭『使用智能体评分』」那条出路只出现在**服务端**的拒绝文案里。值随创建一并落库 |

编辑态复用同一张表单（`mode: 'new' | 'edit'`），差别只有候选行可以带 `id`（见《修改、重跑与删除评测》）。

### 候选行表格

候选行是一张 small `Table`，列序固定**智能体 ｜ 模型 ｜ 思考强度 ｜（无标题的）操作列**：字段名交给列头、`Form.Item` 不再给 `label`（右栏只有 ~545px 宽，竖排标签在多候选时最贵），可访问名由控件自己的 `aria-label` 承担；操作列右对齐，三个图标按钮顺序是**上移 / 下移 / 删除**——候选顺序就是**串行执行顺序**；边界行**置灰而不是隐藏**，删除用危险色 `variant="link"`；**删光最后一行是可达状态**，空态文案「还没有候选：点下面的「添加候选」加一行」；模型池与强度档位由整张表的 `shouldUpdate` 订阅（判据是 `(agentKind, modelKey)` 的**签名**，行数变化也必须重画——否则新加的候选根本不出现）。

### 模型候选池按协议过滤

判据是「智能体接受的协议**集合**」`AgentProviderMetadata.protocolTypes`，四处消费点统一走 `acceptsProtocol(metadata, providerRecord.protocolType)`——协议类型只决定「模型能否驱动某智能体」，不可行的组合在创建阶段就消失，而不是等到运行时炸：

- 选 `Claude Code` → 只列 `anthropic` 协议供应商的模型（它的集合是 `['anthropic']`）。
- 选 `Codex` → 只列 `openai` 协议供应商的模型（它的集合是 `['openai']`）。
- 选 `DSH` → **两类协议供应商的模型都列**（它的集合是 `['openai','anthropic']`：两条 wire 都真机跑通含计量）。
- 自动拉取（`fetched`）与手工维护（`manual`）的模型用 `Tag` 区分来源。
- 过滤后无可选项时，该行立即内联 `Alert` 说明原因与出路，实际文案「{智能体} 没有可选的模型：请到设置里添加协议匹配的供应商，并为它维护模型清单」——`ui` 不硬编码「哪家配哪种协议」。
- 候选池与元数据的唯一出口是 `GET /api/runs/model-options`（`listAgentModelOptions()`）：一次取回三家的 `protocolTypes` / `usage` / `cancelMidTurn` / `efforts` / `defaultEffort`（仅声明该格的家出现）/ `messageCapability` 与各自过滤后的模型清单，**表单不硬编码三家与协议的对应关系**。
- 模型下拉在模型名后补窗口 `Tag`（`1M` / `200K`），`Select` 的 value 不变（仍是 `providerId::modelId`）；**换模型或换智能体都要作废本行已选强度**（与「换智能体作废模型」同一口径）。

### 思考强度

- **未选 = 不指定**（dsh 的适配器落到它自己的缺省 `high`；claude / codex 干脆不传、由厂商推断），**要关闭必须显式选 `off`**（契约里的统一档名 `EFFORT_OFF`，各家负责翻成厂商词汇）；档位字符串按上游词汇**原样透传**，三家都不做值映射、不做就近取整（`medium` → `high` 是静默改语义）。
- 强度下拉的选项 = 该行当前模型的 `option.efforts`（服务端已算好投影进候选池；一个档都没有该键**不出现**，界面只给「未指定」）；推荐档标「推荐」、**默认不预选**（预选会让「我没选过」与「我选了推荐档」在快照里长得一样）；占位符是「未指定（DeepSeek Harness 用 high）」——厂商名与缺省档都由注册表元数据拼出；**关闭档不带「推荐」后缀**。
- 候选 =（上游声明过 `supportedEfforts` ? 上游 ∩ 该家档位域 : 该家**完整档位域**）**∪ 关闭档**，在服务端算好；关闭档 `EFFORT_OFF` 若该家能收且不在交集里则并入并**排第一位**——它表达的是「我们这一侧关掉思考」，不是模型声明的能力，不受交集裁剪。档位域只有一处算法：`intersectEfforts`（`contracts/src/effort.ts`），两个角色四个调用点共用——候选池传**该家完整档位域**，评分校验与设置页评分配置卡片传规范五档 `CANONICAL_EFFORT_LEVELS`。
- 每个智能体的档位域写进注册表元数据（`reasoningEfforts`，**必填**，由注册表测试强制每家显式声明）；「未选时实际会用的档」也写进元数据（`defaultEffort`，**只有 dsh 声明**）：

| 智能体 | `reasoningEfforts` | `defaultEffort` |
|---|---|---|
| claude-code | `['off', 'low', 'medium', 'high', 'xhigh', 'max']` | ——（未选由厂商推断） |
| codex | `['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'persistent']` | —— |
| dsh | `['off', 'low', 'high', 'max']` | `'high'` |

- **创建与编辑都按同一份候选校验，未选也要校验**（`declared = row.effort ?? metadata.defaultEffort`，`declared` 不在候选里就建行即拒；没声明 `defaultEffort` 的家未选不校验）——这一道拦的是**绕过表单直接打接口**：命中即抛 `INVALID_QUERY`，中文原因**同时点名两个值域**与最终候选（「{智能体} 不能按 {档} 跑 {模型}：该模型支持的档位是 …，{智能体} 能收的是 …，可选的是 …」），未选档位触发时还要说明「未选档位时 {智能体} 会用 {档}」。

### 提交与落库

提交校验：至少一行；每行三个选择均已确认（强度可留「未指定」）；执行模式已选。创建后即落库（状态 `idle`），不自动开跑。

## 数据与契约

- `RunCreateSchema.rows[]` 每行 `agentKind` / `providerId` / `modelId` / `effort`：`effort` **逐行且必须显式声明**——zod 3 的 `z.object` 默认 strip 未知键，不声明的话表单提交的强度会被**静默丢弃**（不是 400）。`useAgentJudge` 同理，payload 显式补 `useAgentJudge: values.useAgentJudge ?? false`，不显式声明就会被静默丢掉。
- **服务端创建时再拦一次**（`createRun`）：`useAgentJudge === true` 时校验 `defaultJudgeAgent` 非空、且**设置页全局默认评分模型**所属供应商的协议能被该智能体接受（用例上不再有评分模型覆盖）；三处都抛 `CONFLICT` + 可直接展示的中文原因（未配置 / 枚举之外的值 / 协议不接受，`requireJudgeAgent`）。
- **强度进行快照**（`rows[].effort`），**窗口不进**：窗口是模型属性（与 `baseUrl` 同口径，运行时现读），强度是这一行的配置（与 `modelId` 同级，必须跟着行一起被重跑、被展示、被比较）。记的是**我们要求的**档位，不是实际生效的档位。
- `EvalRun` 冗余快照：`caseId` + `caseTitle` / `repoPath` / `repoBranch` / `commitHash` / `rubric` 六格——用例改分支 / 删除后，这一轮从哪个分支的哪个 commit、用哪把尺子起跑仍读得出来；分支 tip 每次评测重新解析（跟随语义），`commitHash` 钉死（优先于分支）。
- `AgentModelOption`：`contextWindow?`、`efforts?`（已按规则算过）、`recommendedEffort?`（必须落在 `efforts` 里才有值）；`AgentOptionGroup`：`efforts`（该家完整取值域，**唯一消费方是设置页的评分配置卡片**——候选行表单不读它，行内强度选项来自模型条目自己的 `efforts`）、`defaultEffort`、`messageCapability`。

## 状态机与时序

```text
创建（POST /api/runs）
  └─ 落库 idle（不自动开跑）
       └─ 「开始」＝详情页显式动作（Modal.confirm 列出本次将执行的候选清单，避免误点跑掉几十分钟）
            ├─ 并行：所有候选行同时开跑，不设并发上限
            └─ 串行：一行跑完（含评分）才起下一行
```

- **执行模式随评测落库，运行中不可改**：中途切换会让 `skipped` 语义混乱，且「这一轮用什么模式跑的」本身是复现条件。修改见《修改、重跑与删除评测》。
- **串行不是「共用一个工作目录」**：每候选行依然有独立工作区与独立配置目录——串行若共用一个目录，第二个智能体是在第一个智能体的改动之上继续写，分数无意义、整轮作废；串行省的是 CPU 与供应商配额，不省工作区（靠用例级本地缓存，每行复制是秒级的）。
- **并行不设并发上限**：最先触发的通常是限流而不是机器瓶颈，靠**失败隔离**（一行的失败不牵动其他行）兜住；**时限不设**——执行与评分都跑到自己收场，已登记的代价：滴流的上游响应、或忽略停止信号的适配器会把这一行一直挂在 `running` / `judging`，出路只剩用户点「终止」。
- **编排层准备阶段**（第 1/2 步之前）：`parseRepoSource(run.repoPath)` → remote 时 `ensureMirror`（不联网更新）→ `resolveRemoteRef`（缺省 `fetch: true`，分支 tip 重新解析；钉死的 commit 已在镜像里时一次都不抓，否则这是本轮唯一一次 fetch）→ `prepareRowWorkspace` 传**具体 hash** → `EvalRow.baselineCommit` = 该 40 位 hash。基线解析口径（local 取来源仓库当前检出的 HEAD，remote 取远端默认分支）见《用例管理》的评测准备一节。

## 已知边界与取舍

| 边界 | 状态 | 处置与判据 |
|---|---|---|
| 并行不限并发 | 取舍 | 风险登记：最先撞限流；配套是行级失败隔离 + 「终止」出口，不设全局超时（一行卡住全轮停摆是被否决的方案） |
| 模型池与强度候选按注册表元数据现算 | 判据 | 「绕过表单直接打接口」由服务端同一份候选校验拦（建行即拒、中文原因点名两个值域），不是只靠表单 |
| 窗口未知 ⇒ 三家都不注入 | 判据 | 不拿兜底数字冒充「已知」；手工覆盖只保护窗口这一格，档位永远以上游为准 |
| 「使用智能体评分」打开而未配置默认评分智能体 | 由创建拦住 | 界面 `Alert` 已说清会被服务端拒绝；服务端三处 `CONFLICT` 是真正那道门 |
| 推荐档不预选 | 刻意 | 只在选项标签上标「推荐」——预选会让「我没选过」与「我选了推荐档」在快照里长得一样 |

## 相关链接

- [功能总览](/features/) —— 本域目录层：三大模块与数据模型清单
- [用例管理](/features/case-management) —— 表单里那个「用例」带来什么：题面、仓库来源（含远端镜像）、commit 与评分表快照
- [修改、重跑与删除评测](/features/run-edit-rerun-delete) —— 创建之后的编辑（复用同一张表单、候选行可带 `id`）与两个重跑出口
- [Codex 接入](/protocols/codex)、[《Claude Code 接入》](/protocols/claude-code)、[《DeepSeek Harness 接入》](/protocols/dsh) —— 三家候选智能体
- [《设置》](/features/settings)、[《评分》](/features/judging)、[《评测详情与候选行》](/features/run-detail) —— 供应商协议与模型清单（窗口 / 档位的维护口径）、两条评分通路、详情页形态
- [故障索引](/faq/) —— 创建链路上的报错排障入口
