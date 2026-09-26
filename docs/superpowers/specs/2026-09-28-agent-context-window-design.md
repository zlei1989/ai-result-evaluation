# AI 生成代码评测工具 —— 模型上下文窗口与思考强度设计（取数 · 存储 · 三家表达）

> 前置阅读：`docs/superpowers/specs/2026-09-22-features-design.md`（三功能域总体设计）、
> `docs/superpowers/specs/2026-09-26-agent-judge-design.md`（智能体评分与三家适配器的既有分工）。
> 本文只描述**本次新增**的部分；与既有 spec 冲突之处，以本文为准并在 §9 逐条说明。

## 1. 要解决的问题

1. **智能体不知道模型的上下文窗口，而且三家「知道」的方式完全不同**（本机实测，见 §1.1）：

   | | claude-code | codex | dsh |
   |---|---|---|---|
   | 窗口来源 | CLI 内置 registry，**按模型名**判 | CLI 内置模型目录 + 配置覆盖 | LLM 插件目录里的显式 `contextWindow` |
   | 1M 怎么表达 | 模型名**后缀** `模型名[1m]` | 整数配置 `model_context_window` | 目录字段 `models[].contextWindow` |
   | 我们的网关模型名（`Claude-Sonnet-4.6` / `GLM-5.3`） | 不是 Anthropic 的官方拼写，CLI 只能按自己的默认值判（推断，见 §1.1 末段） | **不在目录里**（实测 absent） | 不在目录里 |

   今天的代码把同一个 `modelId` 原样交给三家（`providers/claude-code/index.ts:84`、`providers/codex/index.ts:47`、
   `providers/dsh/index.ts:146`），于是三家各自按「我猜的窗口」决定何时压缩 / 截断：cc 对非 canonical 名字用默认值、
   codex 用未知模型的兜底、dsh 回落到插件默认值 **1,000,000**（`llm-deepseek/src/adapter.ts:147` 的
   `DEFAULT_CONTEXT_WINDOW`，经 `adapter.ts:405-407` 的 `configured?.contextWindow ?? defaultContextWindow` 生效）。
   评测跑在大改动上，**窗口猜小了会中途丢上下文，猜大了会让请求撞上限**，而这两种失真都不会在界面上留下任何痕迹。

2. **「1M 只能靠后缀」这条局部约定覆盖不了真实需要**：网关 `/v1/models` 返回的 47 条模型里，窗口分布是
   `1.05M`（8 条 GPT 系）→ `1048576`（GLM / Kimi / Gemini）→ `1000000`（Claude 全家、DeepSeek）→ `983040`
   → `400000` → `262144` → `200000` → `131072` → `98304`（只有 `gpt-image-2` 没有任何窗口字段）。
   只特判 1M，等于 400k / 262k / 200k / 131k / 98k 这些档位一个都没被表达。

3. **窗口数据源已经拿到、却被丢掉**：上游 `/models` 的每条记录都带着窗口，而
   `api/providers.ts:269` 的 `extractModelIds` 只取 `data[].id`，其余字段全部丢弃。

4. **思考强度今天完全不可选，而三家都能收**：网关已经逐模型给出「支持哪些档位」与「推荐哪一档」
   （47 条里 26 条有，4 种形状，见 §1.1），可这些字段和窗口一样被 `extractModelIds` 丢掉；
   与此同时三家的入口都现成——cc 是 `query({ options: { effort } })`
   （`sdk.d.ts` 的 `Options.effort`，值域 `low/medium/high/xhigh/max`）、codex 是
   `startThread({ modelReasoningEffort })`（`dist/index.d.ts`，值域多出 `minimal`/`ultra`/`persistent`）、
   dsh 是 `new DeepSeekHarness({ reasoningEffort })`（`llm-deepseek` 只认 `off/low/high/max`）。
   于是「同一个模型用高档还是低档」这件事今天只能靠改供应商配置或改代码，**同一次评测里的不同候选
   也无法各自带档位**——而这恰恰是横向比较里最容易被误读的变量（分高的那一行，可能是模型更强，
   也可能只是它跑了 `max`）。

### 1.1 实测依据（2026-09-28，本机）

| 事实 | 怎么验的 |
|---|---|
| 网关 `/v1/models` 同时给 6 种同义窗口字段 | `GET http://likecode-llm-proxy-test.jd.com/v1/models` → HTTP 200、47 条；每条带 `max_input_tokens` / `contextWindow` / `context_window` / `context_length` / `limit.context` / `capabilities.contextWindow`（外加 `top_provider.context_length` 与输出侧 `max_tokens` / `max_output_tokens` / `limit.output`），如 `jd/glm-5.2` 是 `1048576` / 输出 `131072` |
| codex 认 `model_context_window` | CLI 0.154.0：`codex exec --strict-config -c model_context_window=1000000 …` 通过配置校验并继续执行；对照 `-c aieval_bogus_key=1` 立刻 `Error loading config.toml: unknown configuration field` |
| codex 的内置目录不含我们的模型名 | `codex debug models` → 11 条，全部 GPT 系；`Claude-Sonnet-4.6` / `GLM-5.3` / `gpt-5.1` 均 absent |
| codex-sdk 把 `config` 摊成 `--config` | `@openai/codex-sdk/README.md:137-149`：JSON → 点分路径 → TOML 字面量 → 重复 `--config key=value` |
| DSH 的注入点是 `<DSH_HOME>/settings.yaml` | `dsh-settings-file` README：默认文档 `<harness home>/settings.yaml`，`dshHome` 取 `$DSH_HOME`；`llm-deepseek` README：「用户设置文档里的 `llm-deepseek:` 分节覆盖任意字段」，其 schema 有 `models[].contextWindow` / `defaultContextWindow`（正整数） |
| DSH 未列出模型的默认窗口是 1M | `llm-deepseek/src/adapter.ts:147,405-407`（`DEFAULT_CONTEXT_WINDOW = 1_000_000`） |
| 网关逐模型给强度元数据（26/47 条），4 种形状 | 同一个响应：`supportedEffortLevels` / `reasoning.supported_efforts` 给档位数组，`recommendEffortLevel` / `reasoning.default_effort` 给推荐档，`capabilities.effort` 是逐档对象（`{ high: { supported: true, recommend: true }, … }`）。实测分布：`low/medium/high/xhigh/max`（13 条，推荐 `high`）、`low/high/max`（10 条，推荐 `high`）、`high/max`（2 条：`GLM-5.2` / `jd/glm-5.2`，推荐 `max`）、`low/medium/xhigh`（1 条：`qwen-3.8-max`，推荐 `medium`）；其余 21 条连 `capabilities.effort` 都没有（含 `Claude-Sonnet-4.6`、Gemini 全家、`GPT-5.4`、`GPT 5.3-codex`、`kimi-k2.7-code`、`gpt-image-2`） |
| 三家的强度入口与值域 | cc：`sdk.d.ts` 的 `effort?: ('low' \| 'medium' \| 'high' \| 'xhigh' \| 'max') \| number`（SDK 会转成 `--effort`，且文档写明 CLI 可能**静默降档**）；codex：`@openai/codex-sdk/dist/index.d.ts` 的 `ModelReasoningEffort = 'minimal' \| 'low' \| 'medium' \| 'high' \| 'xhigh' \| 'max' \| 'ultra' \| 'persistent'`；dsh：`llm-deepseek` 的 `reasoningEffort` 只认 `off \| low \| high \| max`（`src/index.ts:142,191`），且 harness 侧对不支持的档位直接报 `UNSUPPORTED_REASONING_EFFORT`（`llm/src/index.ts:886`） |

**未能验证（两条，都是原生二进制挡住静态读取）**：① cc 的内置 registry 内容读不到
（本机是 `claude.exe`，npm 包只提供 `cli-wrapper.cjs` / `install.cjs`），所以「网关上的 `Claude-Sonnet-4.6`
被 cc 当成官方名还是未知名」是**推断**，不是实测；② `[1m]` 后缀对**非 Claude 模型名**是否安全。网关的 `POST /v1/messages` 本次实测整片回
`500 服务维护中`（`GLM-5.3` 与 `GLM-5.3[1m]` 各打一次都是 500），而本机的 claude CLI 是原生二进制
（`@anthropic-ai/claude-code-win32-x64` 的 `claude.exe`），无法静态确认它是否在发请求前剥掉后缀。
这一条写进 §8 的验收项，退路见 §9。

## 2. 本阶段范围

**做：**

- 拉取 `/models` 时解析窗口与输出上限，按模型 id 存进供应商模型清单；
- 设置页的模型清单行显示窗口，并允许**手工填写 / 修改 / 清空**（原生 anthropic / openai 的 `/models` 不带窗口，手工是唯一兜底）；
- 创建评测的模型下拉显示窗口标签（`1M` / `200K` …），选中的仍是原模型名；
- 智能体路由携带中性事实 `contextWindow`（+ `maxOutputTokens`）；
- 三家各自把这一格翻译成自己的方言：cc 走 `[1m]` 后缀、codex 走 `model_context_window`、dsh 走 `$DSH_HOME/settings.yaml` 的 `llm-deepseek.models[]`；
- 拉取 `/models` 时解析每模型的**思考强度档位与推荐档**，并允许在创建评测时**逐行**选强度；
- 强度选项 = **该供应商模型支持的档位 ∩ 该行智能体能收的档位**（服务端算好给表单，创建时再校验一次），
  永远多一个「默认」（= 不传，沿用模型自己的默认档）。

**不做（本期明确排除）：**

| 不做的事 | 理由 |
|---|---|
| 按模型名家族猜窗口（`claude*` → 200k 之类） | 猜错就是**静默换模型**：用户看到的是自己选的名字，跑的是另一个窗口。宁可「未知」 |
| 用窗口算本仓自己的行为（`diffBudgetBytes`、评分提示词裁剪按窗口比例） | 那是第二个需求。本期窗口只作为事实**传给智能体**，本仓自己的裁剪口径一个字不改 |
| 启动时自动补拉所有供应商的清单 | 拉取是显式动作（有 15s 超时、有上游失败面）。把它塞进启动路径 = 给服务启动加一条网络依赖 |
| cc 的非 1M 窗口表达 | CLI 没有这个入口：它只认「1M 变体」这一种窗口表达。真要把 200k 告诉 cc，得改上游，不在本仓能力范围内（§9 第 1 条） |
| 行快照存窗口 | 快照已有 `modelId`；窗口是**模型属性**，与 `baseUrl` / `apiKey` 同口径（§3 D7） |
| codex 的 `model_catalog_json` | 单模型场景 `model_context_window` 已足够；catalog 是「整份目录」的替换，多一个文件落盘面与一套格式 |
| DSH 的 `patches` 通道 | `patches` 是给 profile 打补丁的（`HarnessClientOptions.patches`），与「声明某个模型的窗口」不是一件事；写 settings.yaml 直接、可被用户看见 |
| cc 的「每模型手动开关」 | 用户口径：窗口 ≥ 1M 就加。退路在 §9 第 1 条，等冒烟结果再决定是否单开一条需求 |
| **手工编辑**强度档位 | 档位是上游声明的**能力**，手工填等于替网关编造能力（「我填了 max」和「它真支持 max」在界面上会长得一样）。窗口可以手工填是因为它是**事实且必需**（原生清单根本不给），档位不认识时的正确表现是「只有默认」 |
| 给评分通路（文本 API / 评分智能体）配强度 | 评分那把尺子要跨轮次可比：给评分模型单独一个强度旋钮，等于同一批分数里混进两种尺子。要加得单开一条需求 |
| 暴露 `thinking` 开关（`capabilities.thinking` 的 on/off） | 用户口径只要**强度**。`thinking.supported === false` 的模型自然表现为「只有默认」，语义已经够了；再开一个开关就是第二个维度 |
| 按强度自动重试 / 对比矩阵（同模型跑多档） | 那是「一轮里同一模型多行」的用法，用现有的多行能力就够了（每行各自选档），不需要新的编排语义 |

## 3. 关键决策与理由

| # | 决策 | 被否决的替代 | 理由 |
|---|---|---|---|
| D1 | 契约里只存**中性事实** `contextWindow: number`，`[1m]` / `model_context_window` / `settings.yaml` 三种写法全部留在各家适配器 | ① 契约里存一个 `oneM: boolean`；② 契约里存「给 cc 的模型名」 | ① 只覆盖 1M 一档，400k / 262k 依然无处安放（§1 第 2 条）；② 把厂商方言写进跨端契约，等于让供应商域知道 cc 的语法。D1 与既有分工一致：`AgentRunInput.route` 今天就是「协议 + 地址 + 密钥 + 模型名」四个中性事实 |
| D2 | 取数按**字段优先级**取第一个正整数：`max_input_tokens` → `contextWindow` → `context_window` → `context_length` → `limit.context` → `capabilities.contextWindow`；输出同理（`max_tokens` → `max_output_tokens` → `maxTokens` → `maxOutputTokens` → `limit.output`） | ① 只认一个字段；② 深度遍历整个 JSON 找像窗口的键 | ① 六个字段今天都在同一个响应里（§1.1），只认一个就会在别的网关上瞎；② 深遍历会把 `top_provider.context_length` 这类**上下文相关**的字段混进来，且无法解释「为什么取了这个数」。优先级表是穷举的、可测的 |
| D3 | 手工覆盖优先于拉取值，用**逐字段来源** `contextWindowSource: 'fetched' \| 'manual'` 记住这件事 | ① 不做来源，拉取一律以上游为准；② 只在「现值与上游值不同」时保留用户值 | ① 用户把网关填错的窗口改成真值，下次拉取**静默打回**，他以为改了却没用——本仓最忌讳的静默丢数据（`providers.ts:74-88`、`:462-470` 两处注释都是这个口径）；② 无法区分「用户改过」与「上游刚刚更新了」，会把合法的上游更新挡住 |
| D4 | cc 的规则：`contextWindow >= 1_000_000` ⇒ 传 `modelId[1m]`，**对非 Claude 名字一样加** | ① 只对 `id` 含 `claude` 的加；② 每模型手动开关 | 用户口径（2026-09-28）：窗口 ≥ 1M 就加。风险与退路在 §9 第 1 条 |
| D5 | DSH 的窗口**写文件**（`<configHome>/settings.yaml`），不写环境变量 | 环境变量 | `llm-deepseek` 的窗口只在设置文档里（`defaultContextWindow` / `models[].contextWindow`），没有对应的 env；`DEEPSEEK_*` 那几个是地址与凭据 |
| D6 | codex 只给 `model_context_window`，**不设** `model_auto_compact_token_limit` | 一并设死压缩阈值 | 那个键是「何时自动压缩」，CLI 自己按窗口推导比我们猜更准；我们只提供它拿不到的事实 |
| D7 | 行快照（`EvalRun.rows[].modelId`）**不加**窗口字段 | 快照一份窗口 | 与 `baseUrl` / `apiKey` 同口径：它们也不进快照，运行时从配置现读。窗口改了模型清单后历史行显示新值，可接受；真要留证据，事件日志里有适配器打的那一行 |
| D8 | 窗口未知 ⇒ 三家**都不注入**，保持今天的行为 | 给一个兜底数字（200k / 1M） | 兜底数字会让「未知」和「知道」在界面上长得一样，而 DSH 本来就有自己的默认值——再兜一层等于替用户改 DSH 的语义 |
| D9 | 常量 `ONE_M_CONTEXT = 1_000_000` 放 cc 适配器内部 | 放 contracts 或 settings | 它是 **cc 的方言阈值**（「多大算 1M 变体」），不是领域概念。放契约里会诱导别人用它做别的判断 |
| D10 | 强度选项 = **上游档位 ∩ 该行智能体的档位**，在服务端算好（投影进候选池），创建时再校验一次 | ① 把上游档位原样列出，让不支持的组合到运行时才炸；② 只列上游档位并在适配器里就近取整（`medium` → `high`） | ① 违反本仓既有口径「不要让人选完到运行时才失败」（`features spec §5.1`）：dsh 侧对不支持的档位是**硬报错**（`UNSUPPORTED_REASONING_EFFORT`），codex 侧对未知模型也可能拒；② 就近取整是**静默改语义**——用户选 `medium`、实跑 `high`，而分数会被当成 medium 的成绩 |
| D11 | 每个智能体的档位域写进**注册表元数据**（`AgentProviderMetadata.reasoningEfforts`），并由 `registry.test.ts` 强制每家显式声明 | 把三家的值域硬编码在 api 层的交集函数里 | 与 `protocolType` / `capability` 同一条 A3 口径：**智能体的能力只有一个查询点**。硬编码在 api 层，将来加第四家就会出现「注册表说一套、交集函数说另一套」 |
| D12 | 强度进**行快照**（`rows[].effort`），窗口不进（D7） | 两者同一处置 | 两者性质不同：窗口是**模型属性**（与 `baseUrl` 同口径，运行时现读）；强度是**这一行的配置**，与 `modelId` / `agentKind` 同级——它必须跟着行一起被重跑、被展示、被比较 |
| D13 | 未选 / 未知档位 ⇒ **不传**该选项，让模型用自己的默认 | 传一个我们自己选的「默认档」（如 `high`） | 与 D8 同一条口径：不拿一个编造的值冒充「已知」。界面上「默认」是占位符而不是某个具体档 |
| D14 | 不预选推荐档，只在选项标签上标「推荐」 | 自动预选 `recommendedEffort` | 预选会让「我没选过」与「我选了推荐档」在快照里长得一样，而两者在口径上是不同的（前者跟随模型升级，后者锁死一个档）。标签已经给出足够提示 |

## 4. 契约变更（`packages/server/contracts`）

### 4.1 `src/provider.ts`：模型条目带上窗口与档位

```ts
export const ProviderModelSchema = z.object({
  id: z.string().min(1),
  source: z.enum(['fetched', 'manual']),
  /**
   * 上下文窗口（token 数）。**可空**是刻意的：原生 anthropic / openai 的 /models 不带这个信息，
   * 自建网关也未必给（实测 likecode 47 条里 46 条有、gpt-image-2 没有）。
   * null / 缺省 = 未知 —— 三家适配器都不注入，绝不拿一个兜底数字冒充「已知」。
   */
  contextWindow: z.number().int().positive().optional(),
  /** 单次输出上限。今天只有 dsh 的目录用得上（maxTokens），cc / codex 的方言里没有对应项 */
  maxOutputTokens: z.number().int().positive().optional(),
  /**
   * contextWindow 这一格的来源：'manual' = 用户在设置页改过，拉取不得覆盖。
   * 缺省按条目自身的 source 解释（fetched 条目的窗口来自上游，manual 条目本来就只有手工值）。
   * **值可以缺席**：用户在设置页「清空」也记成 manual —— 语义是「别用上游那个数」，
   * 而不只是「别覆盖这个数」。
   */
  contextWindowSource: z.enum(['fetched', 'manual']).optional(),
  /**
   * 上游声明的思考强度档位（原样保留上游的顺序与拼写：`low` / `medium` / `high` / `xhigh` / `max` …）。
   * 空 / 缺省 = 上游没说（实测 47 条里 21 条如此）⇒ 界面上只有「默认」可选。
   * **不做归一化、不做去重之外的加工**：档位名是上游的词汇，翻译成各家方言是适配器的事（D1）。
   */
  supportedEfforts: z.array(z.string().min(1)).optional(),
  /** 上游推荐的档位；不在 supportedEfforts 里时按「没有推荐」处置（不猜） */
  recommendedEffort: z.string().min(1).optional(),
});
```

三个字段全部**可选**，因此磁盘上已有的 `config.json`（46 条模型、一个窗口都没有）无需迁移：
`loadConfig()` 不做 zod 校验（只 JSON.parse + 合并默认值，`core/src/config-store.ts:70-89`），
缺字段就是 `undefined` = 未知。

### 4.2 `packages/server/agents/src/types.ts`：路由携带中性事实

```ts
route: {
  // **单值**：一次运行只走一条 wire。与之相对，智能体的**能力**是集合
  // （`AgentProviderMetadata.protocolTypes`，2026-09-30 起，见契约 §11 的 R37 收口）——
  // 两者不是一回事：供应商的协议与本次路由的协议都是「一条」，智能体能接受的是「一组」。
  protocolType: ProtocolType;
  baseUrl: string;
  apiKey: string;
  modelId: string;
  /**
   * 该模型声明的上下文窗口（token）。**可选**：既有夹具与将来的第三方 provider 不该被它挡住，
   * 缺省 = 未知（各家保持自己的默认行为）。它是**事实**，不是方言：
   * cc 读它决定要不要加 [1m] 后缀、codex 读它填 model_context_window、
   * dsh 读它写进 per-run overlay 的 `models[]` —— 三种写法都不出现在这一格里。
   */
  contextWindow?: number;
  /** 单次输出上限；今天只有 dsh 用（可选，理由同上） */
  maxOutputTokens?: number;
}
```

### 4.3 `packages/server/api/src/runs.ts`：候选池投影

`AgentModelOption`（`listModelOptions` 的元素）增加：

```ts
{
  // …既有 providerId / providerName / modelId / source…
  contextWindow?: number;          // 供下拉显示标签
  /** **已经与智能体取值域求过交**的档位（D10）；空数组 = 这个组合只有「默认」 */
  efforts: string[];
  /** 推荐档，且必须落在 efforts 里才有值（上游推荐了但这家智能体收不了 ⇒ 不显示推荐） */
  recommendedEffort?: string;
}
```

`AgentOptionGroup` 增加 `efforts: readonly string[]`（该智能体自己的完整取值域，来自注册表元数据），
表单在「换智能体」时用它做即时校验提示。

`RunRowInput` 增加 `effort?: string`（**逐行**，见 §4.4）；`createRun` 的校验链在既有
「用例 → 评分通路 → 供应商 → 模型 → 协议」之后接一条**强度校验**：不在交集里 ⇒ `INVALID_QUERY` +
中文原因（点名该模型支持的档位与该智能体能收的档位）——这是 D10 的第二道闸，防的是绕过表单直接打接口。

**值仍是原始 `modelId`**：`ListModelOptions` 的消费方（`run-create-panel.tsx` 的 `encodeModelKey(providerId, modelId)`）
编码不变——窗口与强度只影响标签与另一个下拉，不影响标识。

### 4.4 行快照与智能体输入（强度为什么不在 route 里）

```ts
// contracts/src/run.ts —— 与 agentKind / providerId / modelId 同级
export interface RunRowInput {
  agentKind: AgentKind;
  providerId: string;
  modelId: string;
  /** 本次这一行要求模型用的思考强度；缺省 = 不指定（沿用模型自己的默认档，D13） */
  effort?: string;
}
```

```ts
// agents/src/types.ts —— 与 permission / prompt 同级，**不进 route**
export interface AgentRunInput {
  // …既有字段…
  /**
   * 要求的思考强度（可选）。为什么放这里而不是 route：route 是**连接事实**（协议 / 地址 / 密钥 / 模型名 / 窗口），
   * 而强度是**请求参数**——它与 permission / prompt 同类，且它的值域由该行选的智能体决定，与连接无关。
   */
  effort?: string;
}
```

`AgentProviderMetadata` 增加 `reasoningEfforts: readonly string[]`（该家能表达的完整档位域，
由 `registry.test.ts` 强制每家显式声明，口径同 `capability.liveUsage`）：

| 智能体 | `reasoningEfforts` | 依据 |
|---|---|---|
| claude-code | `['low', 'medium', 'high', 'xhigh', 'max']` | `sdk.d.ts` 的 `Options.effort` / `EffortLevel` |
| codex | `['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'persistent']` | `codex-sdk` 的 `ModelReasoningEffort` |
| dsh | `['off', 'low', 'high', 'max']` | `llm-deepseek` 的 `reasoningEffort` schema |

## 5. 取数实现（`packages/server/api/src/providers.ts`）

### 5.1 `extractModelIds` → `extractModels`

```ts
/** 一个模型条目：id + 可选的窗口 / 输出上限（上游给不出就是 undefined，绝不猜） */
interface ExtractedModel {
  id: string;
  contextWindow?: number;
  maxOutputTokens?: number;
}

/** 窗口 / 输出上限的字段优先级（§3 D2）：按顺序取第一个能解析成正整数的，点号表示嵌套 */
const CONTEXT_WINDOW_KEYS = [
  'max_input_tokens', 'contextWindow', 'context_window', 'context_length',
  'limit.context', 'capabilities.contextWindow',
] as const;
const OUTPUT_TOKENS_KEYS = ['max_tokens', 'max_output_tokens', 'maxTokens', 'maxOutputTokens', 'limit.output'] as const;
```

- 取数用一个小 `readPath(entry, 'limit.context')`（按 `.` 切、逐层取对象），六个键一条循环，没有特例；
- 解析规则：`number` 或数字字符串（`'1048576'`）→ `Number(v)`，要求 `Number.isInteger(n) && n > 0`，否则跳过换下一个字段；
- 上界**不设**：OpenRouter 一类的清单里有 2M 窗口，加一个上界只会把合法的截掉；
- `data: ['a','b']`（纯字符串形态）继续支持，此时两个可选字段都是 `undefined`；
- 原有的 `trim` 与去重口径（`providers.ts:264-283`）逐字保留。

### 5.2 合并规则（`fetchProviderModels`）

⚠️ **这是本次最容易踩的坑**：`providers.ts:476-480` 现在把 fetched 条目**重建成 `{ id, source: 'fetched' }`**，
照原样上线的话，点一次「拉取模型」会把所有窗口（以及将来任何逐条目字段）**全部清空**。合并改成：

```ts
const current = requireProvider(fresh, providerId);
const manual = current.models.filter((m) => m.source === 'manual');           // 原样保留（既有规则）
const byId = new Map(current.models.map((m) => [m.id, m]));
const manualIds = new Set(manual.map((m) => m.id));
const models = [
  ...manual,
  ...[...new Set(fetched)].filter((id) => !manualIds.has(id)).map((id) => {
    const upstream = extractedById.get(id);            // 本次上游给的窗口 / 输出上限
    const previous = byId.get(id);
    // 用户手工改过（或手工清空）就保留用户那份；否则以上游为准
    return previous?.contextWindowSource === 'manual'
      ? { id, source: 'fetched' as const, ...pickContext(previous) }
      : { id, source: 'fetched' as const, ...pickContext(upstream) };
  }),
];
```

- `pickContext(x)` 只挑 `contextWindow` / `maxOutputTokens` / `contextWindowSource` 三个键（缺席不写 `undefined`）；
- 上游这次没给窗口、而条目也没有手工覆盖 ⇒ 三个键都不写（= 未知），**不保留上一轮的旧值**：上游下架了窗口就是下架了（与「上游已下架 ⇒ 清掉条目」同一条「刷新」语义）；
- 日志 `模型清单已更新` 增加 `withWindow: <条数>`，让「补齐了多少条」在服务端可观测。

### 5.3 手工维护（设置页）

新增 `setProviderModelContext(providerId, modelId, context)`：写 `contextWindow` / `maxOutputTokens`（正整数或清空）
并把 `contextWindowSource` 置为 `'manual'`。清单里没有这条 ⇒ `NOT_FOUND`（与 `removeProviderModel` 同口径）。
窗口为 `null` 时清除这三个键——**但 `contextWindowSource: 'manual'` 要留下**（§3 D3：清空也是一次明确的表态）。

### 5.4 强度档位与推荐档（同一个响应里，`extractModels` 一起取）

```ts
/** 档位数组的优先级（D2 同一条口径：第一个「像档位表」的胜出） */
const EFFORT_LIST_KEYS = ['supportedEffortLevels', 'reasoning.supported_efforts'] as const;
const RECOMMENDED_EFFORT_KEYS = ['recommendEffortLevel', 'reasoning.default_effort'] as const;
```

- 第三种形态（本网关也有）是 `capabilities.effort` 的**逐档对象**：
  `{ supported: true, low: { supported: true }, high: { supported: true, recommend: true }, … }`——
  取值为对象且 `value.supported === true` 的键，保持上游给的键顺序；`recommend === true` 的那一档同时充当推荐档；
- 清洗：只留非空字符串、按首次出现去重；`supportedEfforts` 为空数组 ⇒ 三个字段都不写（= 上游没说，界面只有「默认」）；
- `recommendedEffort` 不在 `supportedEfforts` 里 ⇒ **两个都当成上游没说**（不猜、不补）；
- **不做**与智能体取值域的交集：上游词汇的解析在 api 的取数层，交集在候选池投影处（D10），两件事分开。

### 5.5 合并里的强度字段

与窗口同一段合并代码、同一条规则：上游这次给了就以上游为准（条目若被标成 `contextWindowSource === 'manual'`，
只保护**窗口**那一格）；上游这次没给 ⇒ 三个强度字段都不写（`supportedEfforts` / `recommendedEffort` 一起清掉，
不保留上一轮的旧档位）。

## 6. 三家的表达（`packages/server/agents`）

一句话口径：**编排层给事实，适配器给方言**。编排层只改一处——`evaluator/src/orchestrator.ts:1083-1088` 组装 route 时，
从供应商清单里那条模型条目读出窗口填进 `route.contextWindow` / `route.maxOutputTokens`。

### 6.1 claude-code：`modelId[1m]`

```ts
/** 多大算「1M 变体」：cc 的方言阈值，不是领域概念（§3 D9） */
const ONE_M_CONTEXT = 1_000_000;

// startClaudeCode 里：
const model = input.route.contextWindow !== undefined && input.route.contextWindow >= ONE_M_CONTEXT
  ? `${input.route.modelId}[1m]`
  : input.route.modelId;
const query = sdk.query({ prompt: input.prompt, options: { …, model, … } });
logger.debug('claude-code 已注入路由并启动查询', {
  model,                                   // ← 记**真正传给 CLI 的名字**（排障要看的就是这个）
  declaredModel: input.route.modelId,      // ← 以及业务身份，两者不同时才出现
  contextWindow: input.route.contextWindow,
  baseUrl: env.ANTHROPIC_BASE_URL,
  cwd,
});
```

- cc 的 `maxOutputTokens` **不注入**：SDK 的 `options` 里没有对应项（会话级输出上限由 CLI 自己管）。
- 已知限制：非 1M 的窗口 cc 收不到（它没有入口）。所以 400k / 262k / 200k 这些模型在 cc 行上的表现**与今天完全一致**——这不是本次引入的退步，而是 cc 的能力边界，如实写进 §9。

### 6.2 codex：`model_context_window`

```ts
export function buildCodexConfig(baseUrl: string, contextWindow?: number): CodexConfig {
  return {
    model_provider: CODEX_PROVIDER_ID,
    model_providers: { /* 原样不动 */ },
    tools: { web_search: false },
    features: { multi_agent: false },
    // 窗口未知时**整个键都不出现**：写 0 或写一个兜底值都等于替 CLI 编造事实（§3 D8）
    ...(contextWindow === undefined ? {} : { model_context_window: contextWindow }),
  };
}
```

`CodexConfig` 接口加一格 `model_context_window?: number`。SDK 会把它摊成 `--config model_context_window=1048576`
（README `:137-149`），本机 0.154.0 已实测接受这个键（§1.1）。

### 6.3 dsh：`<DSH_HOME>/settings.yaml`（**2026-09-30 已迁移**，落点改为 per-run overlay）

> **本节描述的实现已在 2026-09-30 退役**（`docs/superpowers/plans/2026-09-30-dsh-dual-protocol.md` Task 6）。
> `settings.yaml` 是 dsh-settings 的**旧版本迁移 shim**（安装态启动即改名 `.imported` 再逐段 `update()`），
> 把新能力压在一条将来会消失的兼容层上不划算；而适配器改走 pi-ai 路由之后，路由 / 模型 / 档位
> 本来就要在 overlay 里声明一次，窗口与上限**搭同一份 overlay** 即可——两处声明同一个模型只会漂移。
>
> **新落点**：`<configHome>/aieval-route.patch.yml` 的 `llm-pi-ai.providers.aieval-route.models[0]` 下，
> `contextWindow` / `maxTokens` 两个键；未知 ⇒ **不写那个键**（语义从「删文件清残留」变成「整份重建」：
> overlay 每次运行都由 `buildDshRoutePatch()` 纯函数整份重写，同一份输入两次调用逐字相同）。
> 判据同步改成「overlay 里有没有那个键」，见 `providers/dsh/index.test.ts` 的 `dsh 的 overlay 落点`。
> 下面这段代码**保留作历史记录**，不要照着它改回去。

```ts
/**
 * 把窗口写进本次运行的设置文档。
 * 为什么写文件而不是环境变量：llm-deepseek 的窗口只在设置文档里（§3 D5）。
 * 为什么是 per-row 的 configHome：那正是本行的 DSH_HOME（`workspace.ts` 的 `.agenthome` 落点）。
 */
function writeDshSettings(
  configHome: string, model: string, contextWindow?: number, maxOutputTokens?: number,
): void {
  const file = join(configHome, 'settings.yaml');
  if (contextWindow === undefined) {
    rmSync(file, { force: true });      // 未知 ⇒ 不留旧值（幂等；目录是每行新建的，通常本来就不存在）
    return;
  }
  writeFileSync(file, [
    '# 由 ai-result-evaluation 写入：声明本次运行所用模型的上下文窗口',
    'llm-deepseek:',
    '  models:',
    `    - id: ${yamlString(model)}`,
    `      contextWindow: ${contextWindow}`,
    ...(maxOutputTokens === undefined ? [] : [`      maxTokens: ${maxOutputTokens}`]),
    '',
  ].join('\n'), { encoding: 'utf8', mode: 0o600 });
}
```

- 写入时机：`startDsh` 里、`await runtime.start()` **之前**（运行时启动后才读设置文档）；
- 分节名 `llm-deepseek` 与键名 `models[].contextWindow` / `maxTokens` 来自插件 README 与 schema（§1.1）；
- 未知 ⇒ 删文件：不然上一次运行的窗口会残留成「这次也这么算」；
- 已知边界：DSH 的 `models` 列表是**整份替换**（插件 README 明写），所以我们只声明这一条；未列出的模型照旧走 `defaultContextWindow`。

### 6.4 三家的强度表达

一句话：**编排层给档位字符串，适配器给参数名**。`input.effort === undefined` ⇒ 三家都不传该选项（D13）。

| | 落点 | 写法 |
|---|---|---|
| claude-code | `providers/claude-code/index.ts` 的 `sdk.query` options | `...(input.effort === undefined ? {} : { effort: input.effort })`（SDK 自己转成 `--effort`） |
| codex | `providers/codex/index.ts` 的 `client.startThread` | `...(input.effort === undefined ? {} : { modelReasoningEffort: input.effort })`（`CodexThreadOptions` 加一格可选字段） |
| dsh | `providers/dsh/index.ts` 的 `new sdk.DeepSeekHarness` | `...(input.effort === undefined ? {} : { reasoningEffort: input.effort })` |

三条都**不做值映射**：档位字符串按上游词汇原样透传，能不能收由 D10 的交集在创建时就保证。
理由：任何映射表（`medium` → `high` 之类）都是静默改语义，而分数会被当成用户选的那一档的成绩（D10 的否决项 ②）。

三家的 debug 日志各补一行 `effort`（cc 那条已经在 §6.1 记了 `model`，一并记 `effort`）——「这一分是在哪一档上跑出来的」
必须能从服务端日志回答。

## 7. 界面（`packages/client/ui`，写前按 AGENT.md 用 context7 查 antd 用法）

1. **设置页 · 模型清单**（**2026-09-30 起住在 `provider-models-modal.tsx`**，入口是供应商列表的「模型」按钮；它此前长在 `provider-form-modal.tsx` 的编辑态里，那一版的行文与取舍**不改**，只是换了宿主，常量同时改名为 `MODEL_COLUMN_WIDTH` / `MODELS_MODAL_WIDTH`，守卫搬到 `provider-models-modal.test.tsx`）：**一个 `size="small"`、`showHeader={false}` 的 `Table`**
   （用户口径，2026-09-29 两稿：一稿把「每行一个 `Flex`」换成表格，二稿调列序并逐格精简），列序固定为
   **模型 ｜ 来源 ｜ 输入 ｜ 输出 ｜ 操作**：
   - **表头隐藏**：五列的含义在输入框占位符（`窗口 token 数` / `输出上限`）与按钮里已经写全，
     表头只是把同样的话再说一遍，还白占一行高度；
   - **模型**列开 `ellipsis` 且**不套 `code`**：网关的模型名可以很长（`vendor/very-long-name`），
     撑破弹窗比截断更糟（`ellipsis` 会让 antd 把 `tableLayout` 切成 `fixed`，故其余列必须显式给宽度）；
   - **来源**列只剩来源 Tag —— `手工` Tag 已删除；
   - **输入**（窗口）与**输出**（最大输出）各占一列、都是 `InputNumber`、都 **7em** 宽：值只在输入框里
     （原先「窗口 Tag + 输入框」把同一个值显示两遍）；两格**一次提交**（用户点一次保存表达的是「这一行就是这样」）；
     没碰过的输入回落到清单里的现值，**不与「清空」混同**（草稿状态按 `Object.hasOwn` 判「改过没有」）；
   - **操作**列**右对齐**、两个图标按钮（保存 / 移除）+ `Tooltip`（文字进 tooltip、可访问名走 `aria-label`，
     因为 Tooltip 不产生可访问名）——两个汉字的文字按钮在这一列里占掉半张表；
   - **「手工维护」的可视信号 = 保存图标变黄 + 提示语**（Tag 删掉之后由它承担）：
     `contextWindowSource === 'manual'` 时按钮取 antd 预设色 `gold`（随主题走，**不硬写颜色**），
     且 tooltip 与可访问名同为「保存窗口，模型已被手工维护」；
   - 保存走 `setProviderModelContext(modelId, { contextWindow, maxOutputTokens })`（`null` = 明确清空）。
   - **列宽是算出来的，不是拍的**（2026-09-29 三稿，用户报「输入框被隐藏 + 列宽不合理」后改）：
     这张表是 `table-layout: fixed`（模型列的 `ellipsis` 决定的），格子比内容窄时 `td` 是 `overflow: visible`
     —— 内容会**直接压到相邻列上**。浏览器实测：输入列原写 96px、内容宽只剩 80px，而 `7em` 在 14px 字号下是
     **98px** ⇒ 向右溢出 10px，两个输入框互相压、右边界再盖住操作列的图标按钮。
     现在：输入/输出列 **116px**（= 7em 的 98px + 单元格内边距 16px + 2px 余量），
     弹窗宽度 **720**（560 时模型列被挤到 140px，长模型名只剩省略号；现在 280px），
     `MODEL_COLUMN_WIDTH` / `MODELS_MODAL_WIDTH` 是导出的常量，由 `provider-models-modal.test.tsx` 的列宽守卫盯着。
   - 窗口的格式化仍是那条纯函数（`ContextWindowTag` 现在只服务创建评测的模型下拉）。
2. **创建评测 · 模型下拉**（`run-create-panel.tsx:246-258`）：`option.contextWindow` 有值时在模型名后补一个 Tag
   （`1M` / `200K`），**Select 的 value 不变**（仍是 `providerId::modelId`）。
3. **创建评测 · 强度下拉**（同行、模型下拉之后）：选项 = 该行当前模型的 `option.efforts`（服务端已求过交），
   推荐档在标签里标「推荐」；**默认不预选**，占位符是「默认」（D14）。换模型或换智能体都要**作废本行已选强度**
   （与「换智能体作废模型」同一口径：`efforts` 为空数组时置空并提示「该组合只有默认」）。
   值编码成裸字符串（档位名里没有 `::` 之类的分隔符风险），随行一起提交。
4. 行快照的展示：评测详情里那一行的模型名旁显示档位（如 `GLM-5.3 · high`），缺省不显示——
   「没说」与「说了 high」必须在界面上分得开。
5. 以上都不手写字号 / 不手调行内边距（AGENT.md「已知坑」：紧凑密度下显式 `fontSize` 会让实效字号掉到 10px）。
6. **创建评测 · 候选行是一张 small `Table`**（用户口径 2026-09-29，与上面「模型清单」同一形态）：
   一行一个候选，列序固定为 **智能体 ｜ 模型 ｜ 思考强度 ｜ （无标题的）操作列**：
   - **字段名交给列头，`Form.Item` 不再给 `label`**：竖排标签在多候选时是最贵的高度（右栏只有 ~545px 宽，
     每个候选白多一行标签）。真机实测：同一轮两个候选，这一块的高度 **164px → 91px**（thead 29 + 两行 62）；
   - **可访问名由控件自己的 `aria-label` 承担**（列头 `<th>` 不会成为输入框的可访问名）——
     按名字定位控件的用例与屏读器都只认它；
   - **操作列的列名留空**（用户口径 2026-09-29 二稿）：三个按钮各自带 `Tooltip` 与 `aria-label`，
     表头再写一遍「操作」只是白占这一列的宽度预算（那一列现在只装三个图标）；
   - **操作列右对齐，三个图标按钮的顺序是 上移 / 下移 / 删除**（用户口径 2026-09-29 二稿）：
     候选顺序就是**串行执行顺序**，所以顺序要能改；上移 / 下移 是 `ArrowUpOutlined` / `ArrowDownOutlined` 的
     `variant="link"` 图标按钮，边界行（第一行 / 最后一行）**置灰而不是隐藏**——按钮位置固定，眼睛不用重新找；
     删除仍是危险色 `variant="link"`（文字进 `Tooltip`、可访问名走 `aria-label`）。
     行高 30px 时三个 21×21 的图标按钮与同行两个下拉**中心对齐**（实测同一中心线 310 / 310），
     不再需要「空标签的 `Form.Item` 撑出标签行」那套对齐技巧（那是 Flex 版的补丁）；
   - **模型池与强度档位由整张表的 `shouldUpdate` 订阅**（判据是 `(agentKind, modelKey)` 的**签名**：
     行数变化也必须重画，否则新加的候选根本不出现）；
   - 删光最后一行是**可达状态**（用户点删最后一行）：空态文案是中文的
     「还没有候选：点下面的「添加候选」加一行」——不给 `locale.emptyText` 就是 antd 默认的英文 "No data"；
   - 列的宽度只在浏览器里定：智能体 130 / 强度 120 / 操作 **80**（= 三个图标各 21 + 间距 2×2 + 内边距），
     **模型列不给宽度**，吃掉剩余宽度（实测 330px，长模型名 + 来源 Tag + 窗口 Tag 一行放得下，不省略）。

## 8. 测试计划（TDD；每条新守卫都要做变异验证）

| 层 | 用例 |
|---|---|
| contracts | 三个新字段可选：老形态（只有 `id` + `source`）解析通过；带窗口往返不丢 |
| api / extractModels | 六个窗口字段的优先级各一条；嵌套 `limit.context` / `capabilities.contextWindow`；数字字符串；`0` / 负数 / 小数 / `'abc'` 一律跳过并继续看下一个字段；`data: ['a']` 纯字符串形态仍是合法条目且窗口为 `undefined` |
| api / 合并 | ① 拉取**不清空**窗口（喂一个带窗口的响应，断言落盘里有窗口）；② 手工覆盖不被拉取打回；③ 上游这次没给窗口 ⇒ 三个键都不写（不保留旧值）；④ manual 条目依旧原样保留；⑤ 强度同一条规则（上游给了就换、没给就清），且窗口的手工覆盖**不**顺带保护强度（两件事） |
| api / setProviderModelContext | 写入 / 改 / 清空（清空后 `contextWindowSource` 仍是 `manual`）；清单里没有的模型 ⇒ `NOT_FOUND` |
| agents / claude-code | 窗口 `1000000` → `model === 'X[1m]'`；`1048576` → 同为 `[1m]`；`999999` → `'X'`；未知 → `'X'`；日志里是真正传给 CLI 的名字 |
| agents / codex | 给窗口 ⇒ 传给 SDK 的 config 里有 `model_context_window`，且值逐字相等；不给 ⇒ **该键不存在**（不是 `undefined` 也不是 0） |
| agents / dsh | 给窗口 ⇒ `configHome/settings.yaml` 内容正确（含 `id` / `contextWindow`，有输出上限时含 `maxTokens`）；不给 ⇒ 文件**不存在**（含「上次留下的文件被删掉」这一条） |
| evaluator | 编排层组装的 route 带上窗口与输出上限（用假适配器断言收到的 route） |
| ui | 模型行显示窗口 Tag / `手工` 标记；下拉的窗口 Tag 不影响提交的 `modelId` |
| api / extractModels（强度） | 三种形态各一条：`supportedEffortLevels`、`reasoning.supported_efforts`、`capabilities.effort` 逐档对象（含 `recommend` 标记的那一档）；两种推荐字段各一条；`recommendedEffort` 不在 `supportedEfforts` 里 ⇒ 两个都不写；空档位表 ⇒ 三个字段都不写 |
| api / 候选池交集 | 表驱动：`(上游档位形状 × 三种 agentKind)` → 期望的 `efforts`。必须覆盖四条边界：`qwen-3.8-max`（`low/medium/xhigh` × dsh ⇒ `['low']`）、`GLM-5.2`（`high/max` × dsh ⇒ `['high','max']`）、上游无档位（⇒ `[]`）、推荐档不收（⇒ `recommendedEffort` 为空） |
| api / createRun 校验 | 行里的 `effort` 不在交集 ⇒ `INVALID_QUERY` 且中文原因点名两个值域；在交集里 ⇒ 落库；缺省 ⇒ 快照里是 `undefined` |
| agents / 三家强度 | 给了 `effort` ⇒ 各自收到正确参数名与值（cc `options.effort` / codex `modelReasoningEffort` / dsh `reasoningEffort`）；**不给 ⇒ 该键不存在**（不是 `undefined`、不是空串） |
| agents / registry | 三家都显式声明 `reasoningEfforts`（缺一家即红，口径同 `liveUsage` 那条守卫） |
| ui（强度） | 换模型 / 换智能体作废已选强度；交集为空时只有「默认」；推荐档带「推荐」标签但**不预选**；行快照展示档位、缺省不展示 |

**冒烟（§2 的验收项，必须做）**：创建一轮评测，让 **cc 行跑一个非 Claude 的 ≥1M 模型**（如 `GLM-5.3`，
窗口 `1048576`），确认请求成功、模型名是 `GLM-5.3[1m]`，且网关没有因此报模型不存在。
同时用 CLI 复核：该行的 `.agenthome/settings.yaml`（dsh 行）内容、codex 行的 `--config` 参数（服务端 DEBUG 日志）。

## 9. 风险与已知边界

1. **`[1m]` 对非 Claude 模型名是否安全——未验证**（§1.1）。cc 的 `[1m]` 是 Claude Code 侧的名字变体约定，
   非 Anthropic 名字（`GLM-5.3` / `Gemini-3.1-Pro-Preview` / `DeepSeek-V4-Pro`）加后缀后，
   要么被 CLI 剥掉（安全），要么原样发给网关（可能 404）。
   **处置**：§8 的冒烟项是硬验收；若冒烟发现 404，退路是**给模型条目加一个三态开关**
   （`自动 / 总是加 / 从不加`，默认自动）——那是本次范围之外的一条新需求，不在本 spec 里偷做。
2. **网关 `/v1/messages` 当前不可用**：本次实测 4 次请求全部 `500 服务维护中`（`/v1/models` 正常）。
   冒烟项要等它恢复；这也意味着「窗口取数」可以先落、后缀那半必须先过冒烟再上线。
3. **原生 anthropic / openai 的 `/models` 不带窗口**：这类供应商只能靠设置页手工填，
   界面必须让「未知」看起来就是未知（不要显示成 0 或默认值）。
4. **存量 46 条模型没有窗口**：要用户点一次「拉取模型」才补齐；本 spec 明确**不做**自动补拉（§2）。
   在补齐之前，三家的行为与今天完全一致——这是兼容性，不是缺陷。
5. **DSH 的 `request/context` 事件是最佳验证点**：DSH 会把解析出的窗口回传进会话事件
   （`token-meter` 的压力计算读它、`compaction-basic` 按它算阈值）。实现时用它做一次集成断言，
   比只看文件内容更强：它证明设置文档真的被插件读到了。
6. **档位词汇与三家值域不对齐**：`qwen-3.8-max` 的 `low/medium/xhigh` 在 dsh 行上只剩 `low`（`medium` / `xhigh` 都不收），
   在 cc / codex 行上则是完整三档。**这是交集规则的正常结果、不是缺陷**，但它会让「同一个模型在不同智能体下可选档位不同」
   看起来像 bug——界面上的「默认」与推荐标签要能把这件事讲清楚（§7 第 3 条）。
7. **cc 可能静默降档**：`sdk.d.ts` 对 effort 的注释明写「after any silent downgrade for the selected model」。
   也就是说我们传 `max`、它可能按低一档跑，而**没有任何回报**。本 spec 不做「生效档位」的采集
   （那是事件流里的另一件事，且三家口径不一），如实登记为已知边界：快照里记的是**我们要求的**档位，不是**实际生效的**档位。
8. **存量模型条目没有档位元数据**：与窗口同一条——点一次「拉取模型」才补齐；在那之前强度下拉只有「默认」，
   行为与今天一致。

## 10. 验收标准

1. 设置页点一次「拉取模型」，模型清单里 46 条模型显示各自的窗口（与我实测的分布一致），`gpt-image-2` 显示「未知」。
2. 手工改一条窗口后再拉取一次：**改过的值还在**，且行上有「手工」标记。
3. cc 行用 `Claude-Sonnet-4.6`（1,000,000）与 `GLM-5.3`（1,048,576）：SDK 收到的 `model` 分别是
   `Claude-Sonnet-4.6[1m]` / `GLM-5.3[1m]`；用 `GPT 5.3-codex`（400,000）则是原样名字。
4. codex 行用 `GLM-5.3`：SDK 的 `--config` 里有 `model_context_window=1048576`；服务端 DEBUG 日志可见。
5. dsh 行用 `GLM-5.3`：`<row>/.agenthome/settings.yaml` 内容正确，且该行事件流里的 `request/context` 报出 `1048576`。
6. 窗口未知的模型（或窗口未知的供应商）：三家的启动参数里**都没有**任何窗口痕迹（回归到今天的行为）。
7. `pnpm typecheck` / `pnpm lint` / `pnpm test` 三绿；每条新守卫都做过变异验证（AGENT.md「约束」）。
8. 强度下拉的交集表现（用同一份实测数据核对）：`GLM-5.3`（`low/high/max`）在 cc / codex / dsh 三行上都是三档；
   `qwen-3.8-max`（`low/medium/xhigh`）在 cc / codex 行上是三档、**在 dsh 行上只有 `low`**；
   `Claude-Sonnet-4.6`（上游无档位）三行都只有「默认」；推荐档只在交集内时显示标签（`jd/glm-5.2` 的 `max` 在 dsh 行上应显示推荐，
   而在一个只有 `low/high` 的假设模型上不显示）。
9. 直接打接口提交一个不在交集里的档位 ⇒ `INVALID_QUERY` + 中文原因（点名该模型支持的档位与该智能体能收的档位），
   不是运行时才炸、也不是静默按默认跑。
10. 逐行选不同档位跑一轮：评测详情里每行显示各自的档位；没选的显示为空（而不是显示成某个具体档）。
