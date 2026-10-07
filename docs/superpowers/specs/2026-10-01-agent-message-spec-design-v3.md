# Agent 消息规范 v3：契约、三家映射与实施路径

> **本文自包含**：接口声明、字段含义、三家取值路径、缺失影响与实施步骤全部写在本文内，不需要查阅任何其它文档。
> **阅读顺序 = 实施顺序**：先读契约与字段映射，再按家落地实现，接着是工具族与面板投影、流式与合并、缺失影响、配置面，最后照落地清单收口。每章开头即写该章产出，可以逐章实施、逐章验证。全部内容都在本文内，不需要查阅其它文档。

## 章节地图

| 章 | 标题 | 本章产出 |
|---|---|---|
| 1 | 术语与约定 | 三家缩写、四个易混量（往返/厂商轮/步骤/子任务）的定义、子智能体分量的口径 |
| 2 | 统一消息契约 | 可直接落进代码的 TypeScript 接口 + 每个字段的含义与缺失语义（含族载荷、环境信息、**读数的两个尺度**与**轮次/用量归属键**） |
| 3 | 字段级三家映射 | 每个字段在三家的取值路径、取不到时填什么、默认能力取值（含**思考强度档位**） |
| 4 | 三家实施路径 | 逐家、逐步骤的落地顺序与关键实现点 |
| 5 | 工具族与面板投影 | 10 个工具族的归一规则、三家工具名映射、2 张面板的数据来源 |
| 6 | 流式与合并规则 | 增量/快照的产出规则、覆盖合并算法、顺序保证 |
| 7 | 缺失影响矩阵 | 谁缺什么、影响什么、消费方必须遵守的展示义务 |
| 8 | 配置面 | 三家必须写死的开关与闸门，以及必须规避的配置 |
| 9 | 落地清单 | 按包与按顺序的改动面、守卫与变异验证、**本期不做的边界**，以及测试夹具的模块图判据 |
| 10 | 附录：最小实例集 | 每种块与事件的一手样例 |

---

## 1. 术语与约定

### 1.1 三家

| 缩写 | 指什么 | 取数通道 |
|---|---|---|
| `claude-code` | `@anthropic-ai/claude-agent-sdk`（Anthropic Agent SDK）驱动的 claude CLI | SDK 消息流（`system` / `assistant` / `user` / `result` / `stream_event`）+ **CLI 落盘的子智能体转录**（`<configHome>/projects/<项目目录>/<sessionId>/subagents/agent-<agentId>.jsonl`，只用于子智能体那一份用量与轮次） |
| `codex` | **`@openai/codex-sdk`** 驱动的 codex 运行时（SDK 内部以 `exec --experimental-json` 形态驱动其自带可执行文件，可用 `codexPathOverride` 换可执行文件） | SDK 产出的事件流（JSONL）+ **会话文件**（`$CODEX_HOME/sessions/…/rollout-*.jsonl`，主线程与**全部子线程**各一份，子线程沿 spawn 链递归发现）。子线程身份与状态只从这两条通道取（这家不发 hook 回调） |
| `dsh` | DeepSeek Harness | 会话协议通知流，method 四种：`session.event` / `session.status` / `subagent.started` / `subagent.finished`（**子会话的事件在同一条流里**，靠 `params.sessionId` 分辨归属） |

### 1.2 四个易混的"轮次/步骤"量

| 量 | 定义 | claude-code | codex | dsh |
|---|---|---|---|---|
| `roundTrip` | **模型往返序号**：一次模型 API 往返 = 1，从 1 递增 | 合成：按 `assistant.message.id` 去重计数 | 合成：按模型产出条目 `item.id` 去重计数 | 合成：按 `step/start` 边界计数 |
| `vendorTurn` | **厂商自己的轮号** | 无 | 无 | 有：`turn`（**用户轮号**，不是模型往返号） |
| `step` | **一轮内的第几次调用** | 无 | 无 | 有：`step` |
| `subagentId` | 子智能体/子线程身份 | `task_started.task_id`（同一条子任务的 `task_notification.task_id` 同值；真派发的那个与转录文件名里的 `agentId` 同值） | **子线程 id**：事件流由 `collab_tool_call.receiver_thread_ids` 给出，会话文件由 `session_meta.id` 给出（两者同值，也等于文件名末段） | 三级兜底：`subagentId` → `agentId` → `childSessionId`（与随后子会话事件的 `params.sessionId` 同值） |

`subagentId` 在三家都是厂商原生 id（dsh 是子会话 id，claude 是任务 id，codex 是线程 id）⇒ 子任务载荷里的 `vendorId` 与它同值；codex 的消息侧靠会话文件的线程身份带上这一格。

`roundTrip` 三家都要合成，且计数方法不同 ⇒ **跨家比较前必须确认口径**，不要把某家偏高的近似值当成另一家的等价物。

### 1.3 三条全局约定

1. **`null` 只表示"未采集"**，永远不等于 0。缺数据一律 `null`，禁止用 0、空串、空数组冒充。
2. **不合成无法验证的值**：可以不采（`null`），不可以猜。文本类字段尤其如此——上游没给正文时，不得拿摘要、token 数或统计量顶替。
3. **每个值都带来源**：同一字段在不同家可能来自事件流、会话文件或 hook，来源必须随值一起给出，否则消费方无法判断实时性与可比性。
4. **契约里的名字不随厂商版本漂移**：事件与块的 `type` 一律 kebab-case 单词，**不复用厂商的点号写法**（`turn/end`、`subagent.started` 只出现在映射表与 `raw` 里，不进契约）；厂商原文只出现在 `name` / `vendorType` / `raw` 这类数据位上。代理自产 id 一律叫 `<domain>Id`（`messageId` / `callId` / `subagentId`），厂商原始 id 另存 `vendorId`。

---

## 2. 统一消息契约

### 2.1 消息信封

```ts
/** 数据来源：决定实时性与可信度，消费方必须读 */
type MessageSource = 'wire' | 'hook' | 'session-file' | 'aggregate';

/** 块形态：'delta' 是增量片段，'snapshot' 是该块的当前完整内容 */
type ChunkKind = 'delta' | 'snapshot';

interface AgentMessage {
  /** 本项目生成的稳定消息 id（`<runId>:<seq>`），与厂商 id 解耦 */
  messageId: string;
  /** 厂商侧消息/条目 id；厂商没有则为 null */
  vendorId: string | null;
  /** 说话者；codex 由条目类型派生 */
  role: 'assistant' | 'user' | 'tool' | 'system';
  /** 数据来源 */
  source: MessageSource;
  /** 模型往返序号，从 1 递增；三家均为合成值 */
  roundTrip: number;
  /** 厂商轮号；无则为 null */
  vendorTurn: number | null;
  /** 一轮内的第几次调用；无则为 null */
  step: number | null;
  /** 派生这条消息的那次工具调用 id；无则为 null */
  parentCallId: string | null;
  /** 子智能体身份；主线程消息为 null */
  subagentId: string | null;
  /** 块形态 */
  chunk: ChunkKind;
  /** 这条消息里的块收尾了没有：每个块都收到过快照是 'snapshot'，有块停在增量累积值上是 'open' */
  assembly: 'snapshot' | 'open';
  /** 覆盖合并键：`<subagentId ?? 'main'>|<roundTrip>|<role>|<parentCallId ?? '-'>`（消费方按它覆盖累积） */
  mergeKey: string;
  /** 内容块，按到达顺序；**数组下标就是块序号** */
  blocks: ContentBlock[];
  /** 该条消息的原始载荷（未归类字段原样保留，供排障） */
  raw: unknown;
  /**
   * **这条消息所属的那一次模型调用**的用量（可选）。**只有 dsh 交**（取值路径见 §3.1 的 `usage` 行与 §3.2）。
   * 这条读数**不是累计、不进任何合计**，与 `roundTrip` / `step` 各自独立。
   * 缺键与显式 `null` **同义**：这条消息没有消息级用量（这一格**没有** `subagentTokens` 那种三态语义）。
   */
  usage?: UsageTokens | null;
}
```

**字段缺失语义**

| 字段 | 为 `null` 的含义 | 消费方义务 |
|---|---|---|
| `vendorId` | 该家没有可用的消息级 id | 不得把它当去重键；用 `messageId` |
| `vendorTurn` | 该家没有厂商轮号 | 不得用 `roundTrip` 冒充（两者语义不同） |
| `step` | 该家没有"一轮内第几次调用" | 不得按 `step` 分组做跨家对比 |
| `parentCallId` | 该家给不出派生关系 | 子任务归属改用 `subagentId` |
| `subagentId` | 这条来自主线程 | — |
| `assembly` / `mergeKey` | 不是可空格（各恒为两个取值之一 / 一个字符串） | `'open'` 时按"未收尾"呈现；按 `mergeKey` 覆盖累积 |
| `usage` | 这条消息没有消息级用量（含「这一家根本不交消息级用量」） | **不得渲染成 0**；`null` 时界面整行不出（见 §6.4）；不得拿它参与任何合计 |

### 2.2 内容块

```ts
interface TextBlock      { type: 'text';        text: string }
interface ThinkingBlock  { type: 'thinking';    text: string | null;
                           /** 'full' = 完整推理；'summary' = 厂商摘要；'none' = 有思考但无文本 */
                           textKind: 'full' | 'summary' | 'none';
                           /** 签名/校验串，仅审计用，不进任何呈现；无则 null */
                           signature: string | null }
interface ToolCallBlock  { type: 'tool-call';   callId: string;
                           /** 归一后的族名；无法归类时 null */
                           family: ToolFamily | null;
                           /** 厂商原始工具名（codex 可能为派生名） */
                           name: string;
                           input: unknown;      /** 原始入参，未做语义改写 */
                           /** 归一后的**族载荷**（只有 `task` / `ask-user` 两族有）；没有则 null */
                           payload: ToolCallPayload | null }
interface ToolResultBlock{ type: 'tool-result'; callId: string;
                           /** 厂商给出的结构化结果**原文**（给了才填）；没有则 null。归一后的族字段见 §5.1 */
                           structured: unknown;
                           isError: boolean;
                           text: string;
                           /** 截断**三态**：见下方「截断的表达」 */
                           truncation: TruncationState }
interface AttachmentBlock{ type: 'attachment';  kind: 'image' | 'file';
                           path: string | null; mimeType: string | null }
interface UnrecognizedPayloadBlock
                         { type: 'unrecognized';
                           /** 'unrecognized' = 类型本身不认识；'unmapped-shape' = 类型认识但形状对不上 */
                           reason: 'unrecognized' | 'unmapped-shape';
                           /** 厂商原始类型（如 `session/title` / `todo_list`），仅供参考 */
                           vendorType: string | null;
                           raw: string | null }

/** `none` = 确认完整；`truncated` = 确认被截断；`unknown` = **没采到标记** */
type TruncationState =
  | { kind: 'none' }
  | { kind: 'truncated'; reason: string | null }
  | { kind: 'unknown' };

type ContentBlock = TextBlock | ThinkingBlock | ToolCallBlock | ToolResultBlock
                  | AttachmentBlock | UnrecognizedPayloadBlock;

type ToolFamily = 'read-file' | 'write-file' | 'edit-file' | 'search-content' | 'list-files'
                | 'run-shell' | 'web-search' | 'spawn-agent' | 'task' | 'ask-user';

/** 族载荷：只给「本次调用之后的归一结果」，`kind` 与 `family` 必须对得上（`plan` ↔ `task`、`ask-user` ↔ `ask-user`） */
type ToolCallPayload =
  | { kind: 'plan';     steps: TaskStep[];         note: string | null }
  | { kind: 'ask-user'; questions: AskUserQuestion[] }

interface TaskStep        { id: string | null;                        /** null = 这一家给不出（**不自己发号**） */
                            subject: string;
                            /** 四态。`unknown` 是**独立的一档**（既不是待办也不是完成），不能并进任何一边 */
                            status: 'pending' | 'inProgress' | 'completed' | 'unknown';
                            owner: string | null;                      /** null = 这家没有「指派」这个概念；`''` = 有概念但无人认领 */
                            blockedBy: string[] | null }               /** null = 拿不到依赖表（不是空表） */
interface AskUserQuestion { header: string;                            /** 展示标签，同时是答案的配对键；厂商没给时落 `''` */
                            prompt: string;                            /** = 三家的 `question` */
                            options: AskUserOption[];
                            multiSelect: boolean;                      /** claude `multiSelect` / dsh `multi_select` */
                            allowOther: boolean;                       /** codex `isOther`：允不允许自由输入 */
                            secret: boolean }                          /** codex `isSecret`：默认遮罩（**显示口径，不是安全边界**） */
interface AskUserOption   { label: string; description: string | null; recommended: boolean }
```

**块的三条口径**：

- **`payload: null` 不是错误**：族不在 `task` / `ask-user` 里、或厂商形状认不出，都落它 ⇒ 消费方走通用工具行（**调用不会消失**，只是没有专门卡片）。空表（`steps: []` / `questions: []`）与 `null` 是两件事：前者是「厂商给了空表」。
- **`unrecognized` 是「原样保留」，不是「一行文字」**：正文是该载荷的原文，不得画成附件、也不得推给下载台账（台账承载不了原样载荷）。
- **`payload` 可缺**：磁盘上已有的 `messages.jsonl` 没有这一格，读侧把「键不存在」与「显式 `null`」当同一件事。工具块只允许经适配器公共层的构造器产出，手搓块会静默少掉这一格。

**实例**

```jsonc
// 一条带思考与工具调用的 assistant 消息
{ "messageId": "run-7:12", "vendorId": "msg_01H…", "role": "assistant", "source": "wire",
  "roundTrip": 2, "vendorTurn": null, "step": null, "parentCallId": null, "subagentId": null,
  "chunk": "snapshot", "assembly": "snapshot",
  "blocks": [
    { "type": "thinking", "text": "先读配置再决定改哪一行。", "textKind": "full", "signature": "EqQBC…" },
    { "type": "text", "text": "我先看一下配置文件。" },
    { "type": "tool-call", "callId": "toolu_01A…", "family": "read-file", "name": "Read",
      "input": { "file_path": "src/config.ts" } }
  ],
  "raw": { /* 厂商原始载荷 */ } }

// 对应的工具结果
{ "messageId": "run-7:13", "vendorId": null, "role": "tool", "source": "wire",
  "roundTrip": 2, "vendorTurn": null, "step": null, "parentCallId": null, "subagentId": null,
  "chunk": "snapshot", "assembly": "snapshot",
  "blocks": [ { "type": "tool-result", "callId": "toolu_01A…", "structured": { "totalLines": 42 },
                "isError": false, "text": "export const config = …", "truncation": { "kind": "unknown" } } ],
  "raw": {} }
// `parentCallId` 是「**派生这条消息**的那次工具调用 id」：工具结果不派生任何东西 ⇒ `null`；
// 子智能体（侧链）消息才带它，且与 `subagentId` 同值（claude 的 `parent_tool_use_id` 一格两义）
```

### 2.3 行级事件

行级事件与消息**并行**输出，不进 `blocks`。八个类型：

```ts
type AgentEvent =
  | { seq: number; at: string; type: 'status'; status: EvalRowStatus }
  | { seq: number; at: string; type: 'log'; stream: 'stdout' | 'stderr';
      text: string;        /** 原始负载（排障用） */
      summary?: string }   /** 给人看的一句话；无则省略，消费方不得拿 text 顶替 */
  | { seq: number; at: string; type: 'vendor-system';
      /** 厂商系统层事实：工具面 / 斜杠命令 / 子智能体定义 / MCP 服务 / 权限档 / 输出风格 */
      tools: string[] | null;          slashCommands: string[] | null;
      agents: string[] | null;         mcpServers: string[] | null;
      permissionMode: string | null;   outputStyle: string | null }
  | { seq: number; at: string; type: 'usage'; tokens: UsageTokens | null;
      /** 子智能体那一份用量；见下方三档语义 */
      subagentTokens?: UsageTokens | null;
      /** 子智能体那一份轮次；三档语义与上一格逐字相同 */
      subagentTurns?: number | null;
      timing: UsageTiming | null; turns: number }
  | { seq: number; at: string; type: 'diff-summary'; filesChanged: number;
      insertions: number; deletions: number; truncated: boolean }
  | { seq: number; at: string; type: 'score'; score: ScoreResult }
  | { seq: number; at: string; type: 'error'; message: string; stack?: string }
  | { seq: number; at: string; type: 'end'; exitReason: string };
```

- `seq` 从 1 单调递增，用于去重与断线续订；`at` 是**本项目**写入时间，不是厂商时间。
- `usage` 的必填格只有 `turns`；`tokens` / `timing` / `subagentTokens` / `subagentTurns` 都可空。
- `turns` 与 `tokens` **相互独立**：`turns` 是「到目前为止的模型往返次数」，每见到一次新往返就应发一条；`tokens` 采不到就是 `null`，不得因为 token 缺失而停发轮次。
- `timing` 的 `apiMs` / `ttftMs` 多数家没有 ⇒ 各自为 `null`；`source` 恒有值，决定这组时长能不能与另一家横着比。
- `vendor-system` **只在厂商真的投送了那一行时才有**：没有这一行的那一家不发这条事件（消费方整组走 `not-exposed`），不得发一条各格全 `null` 的事件冒充。六格各自可空，`null` = 这一格厂商没投送，`[]` = 采到了、确实是空的（两者在界面上是两句不同的话）。

**`subagentTokens` / `subagentTurns` 的三档语义**（`tokens` / `turns` 已是「主会话 + 全部子智能体」的**合计**，这两格是其中的**分量**）：

| 取值 | 含义 |
|---|---|
| **整格缺席** | 这一条没带这一格（旧版本写的事件 / 这一条不谈它）⇒ 消费方保持上一份 |
| `null` | 有子智能体但**没采到**（含「有任何一个子智能体读失败」）⇒ 合计**退回主会话口径**（这一条只对「合计由主 + 子拼出来」的两家成立；dsh 的合计是逐条累加的流水，退不回，见 §7.3） |
| `{0,0,0}` / `0` | **确实没有子智能体**（或子智能体一个 token / 一个往返都没花） |

- ⚠️ **`null` 与 `0` 在轮次那一格上含义相反**（与用量那一格的 `null` / `{0,0,0}` 同源）：契约与日志里「没采到」与「确实没有」必须长得不一样。
- **两格恒有分量关系**：`subagentTokens ≤ tokens`（逐格）、`subagentTurns ≤ turns`。消费方按「主会话 = 合计 − 分量」推主会话那一行 ⇒ **分量与合计必须同刻成对交出**，只给分量不给合计会让那个减法算出负数。
- 写入侧的三档是**不对称**的：分量写**显式 `null`** 表示「明确没采到」⇒ **覆盖**旧值；**缺键**才是「本条不带」⇒ 保持。合计（`tokens` / `turns`）的 `null` 只表示「本条不带」。

**实例**

```jsonc
{ "seq": 41, "at": "2026-10-01T05:24:31.002Z", "type": "usage", "turns": 6,
  "tokens": { "input": 1219, "cached": 7040, "output": 114, "reasoningOutput": 52, "total": 8260 },
  "subagentTokens": { "input": 320, "cached": 1024, "output": 40, "reasoningOutput": null, "total": null },
  "subagentTurns": 2,
  "timing": { "totalMs": 4820, "apiMs": null, "ttftMs": null, "source": "events" } }
// 主会话那一行由相减得出：输入 899 · 缓存 6016 · 输出 74；轮次：主 4 / 子 2
```

### 2.4 计量结构

```ts
interface UsageTokens {
  /** **非缓存输入** token。三家统一口径：claude-code 与 dsh 的原文即不含缓存、原样取；codex 的 `input_tokens` 含缓存读，适配器必须减掉 `cached_input_tokens` */
  input: number;
  /** **命中缓存的输入** token（缓存读）。与 `input` 互斥，两者之和才是本次送进模型的 prompt 总量 */
  cached: number;
  /** 输出 token（含思考 token） */
  output: number;
  /** 其中属于思考的部分；采不到为 null */
  reasoningOutput?: number | null;
  /** 厂商自报的总量原文；它**不参与**归一后的加和关系，仅供参考 */
  total?: number | null;
}

interface UsageTiming {
  /** 整轮墙钟时长（含工具执行） */
  totalMs: number | null;
  /** 仅模型 API 往返时间；采不到为 null——不得用 totalMs 顶替 */
  apiMs: number | null;
  /** 首 token 时延；采不到为 null */
  ttftMs: number | null;
  /** 'vendor' = 厂商自报；'events' = 由事件/会话行时间戳算出（含工具时间） */
  source: 'vendor' | 'events';
}
```

派生指标一律由消费方按下列公式算，适配器不预先算比率：

| 指标 | 公式 | 前置条件 |
|---|---|---|
| 缓存命中率 | `cached / (input + cached)` | 三家同式；`input` 已归一为**非缓存输入**，分母即本次 prompt 总量（分子含在分母里，结果不可能超 100%） |
| 生成速率 tok/s | `output / ((apiMs - ttftMs) / 1000)` | 需要 `apiMs` 与 `ttftMs` 都有值；**除以 1000 是把毫秒换成秒** |
| 生成速率（退化） | `output / (totalMs / 1000)` | 无 `apiMs`，或 `apiMs - ttftMs` 不为正时使用；**分母含工具时间**，展示必须标注 |
| 首字延迟 | `ttftMs` | — |

**思考 token（`reasoningOutput`）的三条口径**：

- **它是 `output` 的子集，不是第四个加数**：`output` 已含它，任何界面与统计都**不得**把它再加进 `output`（那是双计），也不得拿它当跨家比较的分子——它只回答「输出里有多少是思考」。
- **只收结算值**：跑动期的估算帧（claude 的 `system/thinking_tokens` 一类）不进这一格，也不落 attachment；采不到就 `null`，**绝不填 0**（`0` 会被读成「这次没思考」）。
- **去重比较必须纳入这一格**：同一条读数的去重判据只比 `input` / `cached` / `output` 时，「只有思考 token 变了」的新值永远发不出去（界面冻在第一次的读数上）。
- **`modelUsage[].thinkingTokens`（claude）只作交叉校验，不作主源**：它的范围比 `result.usage` 大（含后台任务 / 侧链 / 上下文压缩），两者不一致时落一条 WARN，**不静默挑一个**、也不把两个数平滑混用。

**求和口径（三家共用同一份实现，各家不自己写加法）**

- **子智能体那一份** = `sumUsageTokens(各子会话/子线程/子智能体文件的用量)`：逐格相加 `input` / `cached` / `output`；`reasoningOutput` **一格都没采到才是 `null`**（有一格就相加）；`total` **不相加**（它是厂商自报的**单个会话的累计快照**，相加得到的是我们的算术，与「厂商原文」那一格的语义冲突）⇒ 子智能体那一份的 `total` 恒 `null`。
- **合计** = `addUsage(主会话, 子智能体那一份)`，三条口径：
  1. **子那一份逐格为零 ⇒ 返回主会话原样**：加一个零必须是恒等变换，否则会把厂商自报的 `total` 抹成 `null`（没有子智能体的行正是这一档）；
  2. **主会话拿不出来 ⇒ `null`**：绝不拿子那一份冒充总数；
  3. **子那一份读失败 ⇒ 主会话那一份**：这就是「全量或 null」第三档的落点。
- **「全量或 null」**：分量的读数是**全量或 `null`，没有部分和**——只读到一部分时交出去的那个数既不是合计也不是主会话，而界面上它与全量合计长得一模一样 ⇒ 宁可不出数，并落一条**点名**（哪个子智能体 / 子线程 / 文件读不到）的 WARN。
- **落点**：`EvalRow.tokens` / `turns` 是**合计**，`EvalRow.subagentTokens` / `subagentTurns` 是**分量**，四格同源（`usage` 事件 → 适配器结果 → 行快照）。后两格是**可选格**：老 `run.json` 没有它们，写成必填会让 `listRuns()` 静默跳过老记录。

### 2.5 读数的两个尺度（会话尺度 / 行尺度）

同一个字段里的 `tokens`，在两家适配器里**不是同一把尺子**，消费方必读：

| 尺度 | 含义 | 出现处 |
|---|---|---|
| **行尺度** | **整行**（主会话 + 全部子智能体）的累计 | `dsh` 的**每一条**读数——含带会话身份的那些（`assistant/message` 的用量**无条件**并进 `state.usage*`，交出的都是全树累计） |
| **会话尺度** | **那一个会话自己**的累计 | `claude-code` 的**每一条**读数；dsh / codex 的**分量**格（`subagentTokens` / `subagentTurns`，见 §2.4） |

- **`turn` 只回答「出自哪个会话的第几轮」，不改变值的尺度**（见 §2.6）。跨家读一个带会话身份的读数之前，先确认它属于哪一档。
- ⇒ 带会话身份的读数**不是行级读数**：claude 的行级三格（卡片 / 抽屉事实条 / 快照）只认 `turn.subagentId` **为空或缺省**的那一条，读侧必须按会话身份过滤（判据各落一处：`client/src/row-live.ts` 与 `apps/web-next/src/log-drawer-state.ts`）。
- ⚠️ **同一道过滤落在 dsh 身上是「有界的过度过滤」**：它挡掉的是一条**本来就是行尺度**的读数，最坏情形是卡片那几格在子会话干活期间冻在上一条主会话读数上（**不倒流**、下一条主会话读数到达即追平）。**两处不受影响**：快照那一格（`patchRow` **不加**过滤——dsh 带身份的读数就是本行累计）；codex（它的 `turn.subagentId` 恒 `null` ⇒ 过滤是空操作）。
- **真正的收口方向是让生产侧把尺度写进读数**（加一格尺度标记，或让 dsh 只累主会话 + 分量）：读侧修不干净（`row-live.ts` 的折叠函数拿不到 provider）。未做。

### 2.6 轮次与用量的归属键

每一条 `usage` 事件可以带一个**归属键**，说明「这次读数发生在哪个会话的哪一轮」：

```ts
/** 这一条读数**属于哪一轮**。整格可选：缺键与显式 `null` 同义（没有归属信息） */
turn: { subagentId: string | null;   /** 会话身份，与 `SubagentRecord.subagentId` / `LogTurn.subagentId` 同一套 id；`null` = 主会话 */
        round: number } | null       /** **该会话自己的**第几次模型往返（每会话各自 1..N），**不是**本行累计轮次 */
```

- ⚠️ 它与同一对象里那个**必填**的 `turns`（本行累计轮次，服务进度条与 `EvalRow.turns`）**不是一回事、不得互相顶替**：`turns` 回答「这一行跑到第几轮了」（行的尺度），`turn` 回答「这一条读数发生在哪一轮」（会话的尺度）。
- ⚠️ **整格可选是硬要求**：磁盘上已有大量没有这一格的 `usage` 行，写成必填会让老日志在回放 / SSE 续订时成片解析失败。读侧把「键缺席」与「显式 `null`」当**同一件事**。草稿层（`AgentEventDraft`）**恒带这一格**（没有归属时写 `null`），与 `timing` / `subagentTokens` 同一条处置：草稿层少一种形态，就少一处「某家用 `undefined`、某家用 `null`」的漂移。
- 传播链（**只到界面为止**）：`TurnProjection.turn` → `AgentEventDraft` → `AgentEvent` → 界面 `RowEvent.turn`。**`EvalRow` / `run.json` / `RowLiveMetrics` 一概不改**——它只服务抽屉的落点，不是行级事实（行级事实已经在 `tokens` / `turns` 上）。
- 三家的归属实现：

  | 家 | 归属键 | 配套要求 |
  |---|---|---|
  | dsh | `(sessionIdProfileSubagent(sessionId), data.step)` ——`data.step` 是该会话自己的步号（主会话真机 1,2,3；子会话也从 1 起） | 消息信封的 `roundTrip` **同步改用它**（不再用全局 `state.turns`），否则主会话时间轴会出现 `1,2,5,6` 的洞。**`state.turns` 照旧全局自增**（`EvalRow.turns` 与「主 + 全部子」的口径靠它）。**没有 `data.step` 的出口**（`turn/end` 实测不带 step、形状异常时也可能缺）取**该会话上一次见到的 step**（一张按会话分组的小表，与 `sessionUsage` 同一处、同一个 `resetDshMessageStateForTesting`）；**不得回落 `state.turns`**（那正是要消灭的错位）；一次都没见过该会话的 step ⇒ `turn: null` |
  | claude-code |  `(null, state.turns)` 恒成立——读数只由**主循环**消息触发（`parent_tool_use_id` 非空的侧链**一条 `usage` 事件都不发**，发射门槛是轮次） | **侧链消息按每会话自己的号编号**（`roundTripOfSession`：按 `parent_tool_use_id` 分组、每组数**去重后的 `assistant.message.id` 个数**，首次出现顺序 = 1..N），否则子会话那几十条消息全挤在父会话派发的那一轮里（该节点只剩一个轮次行）。主会话仍用 `state.turns` 那一套；流式增量那条路走**同一个**函数 |
  | codex | `(null, state.turns)`（事件流只有主线程，子线程不产 `usage` 事件） | **计数键收窄成只数 `AgentMessage`**，事件流与会话文件**两侧同改**（会话文件侧同时按 `itemId` 去重）。理由：两把尺子都得从**两侧都能看见的东西**上数出来——`reasoning` 条目在部分路由上事件流看不见（既有口径被它系统性抬高）。**语义变化如实登记**：codex 的「轮次」从此是「模型答复条目数」，比既有近似口径**更低**；一个 `AgentMessage` 都没有的运行 ⇒ 轮次 `null`（界面显示「未采集」）。子线程自己的轮次号仍是**每个文件各自从 1 数**，与归属键各说各话 |

- 「谁是子会话」的判据与消息归属共用同一份（dsh 见 §4.3 步骤 4 的三级兜底；claude 用 `parent_tool_use_id`；codex 用子线程 id）。

### 2.7 能力声明

每家每次运行都带一份能力声明，说明"这次到底能拿到什么"。取值五态：

```ts
type Capability =
  | 'yes'                    // 有值，且来自厂商原生字段
  | 'no'                     // 这家结构上就没有这个能力
  | 'unverified'             // 没验证过，不要当有也不要当没有
  | 'off-by-adapter'         // 厂商有，但当前实现没接
  | 'not-projected-by-vendor'; // 厂商侧有数据，但不投送到我们拿得到的通道

type MissingReason =
  | 'not-supported'   // 这家结构上就没有这个概念（换配置 / 换路由都没用）
  | 'not-exposed'     // 厂商有数据，但没投送到我们读得到的通道
  | 'not-observed'    // 厂商有、通道也有，但我们没接；或本次运行里根本没出现（用户没派生子智能体一类）
  | 'unverified';     // 有通道但没验证过，不敢说采到了

interface MessageCapability {
  thinkingText: Capability;      thinkingTextKind: 'full' | 'summary' | 'none';
  toolInput: Capability;         toolResult: Capability;
  subagent: Capability;          streamingDelta: Capability;
  /** 下面五格的取数通道；对应那格为 `'yes'` 时必填，其余情况为 `null` */
  thinkingTextSource: MessageSource | null;    toolInputSource: MessageSource | null;
  toolResultSource: MessageSource | null;      subagentSource: MessageSource | null;
  streamingDeltaSource: MessageSource | null;
  /** 下面五格为什么取不到；对应那格非 `'yes'` 时必填，`'yes'` 时为 `null` */
  thinkingTextReason: MissingReason | null;    toolInputReason: MissingReason | null;
  toolResultReason: MissingReason | null;      subagentReason: MissingReason | null;
  streamingDeltaReason: MissingReason | null;
  /** 这一族能力成立的**前提**（路由 / 模型 / 开关）；空数组 = 无条件成立 */
  notes: string[];
}
```

规则：

- **通道与原因逐格声明**，不是整份声明一份：codex 的思考正文来自会话文件，而它的事件流那一格按厂商定义只有摘要（`not-projected-by-vendor` / `not-exposed`）——两件事必须能同时表达。
- 取值为 `no` / `not-projected-by-vendor` / `off-by-adapter` 的格**必须**配一条 `MissingReason`，对应关系为 `no → 'not-supported'`、`not-projected-by-vendor → 'not-exposed'`、`off-by-adapter → 'not-observed'`（当前实现没接这一格）或 `'unverified'`（只做过部分验证）。`unverified` 这一态本身就是 `'unverified'`；它只用于确实没验证过的格，不得当成"没有"。
- 取值为 `'yes'` 的格**必须**同时给出它那一格的 `source`（值从哪条通道取到）；其余四态的 `source` 为 `null`。
- **能力随路由翻转**：同一份能力位在不同路由下取值不同（codex 的多智能体在会拒绝命名空间工具的路由上被判 `unsupported call`，在另一条路由上整条派发链跑得通）⇒ 必须把路由与模型名写进 `notes`，不得把某一条路由上的取值写成这家的固有属性。
- `thinkingTextKind` **不是**能力位，是"思考文本属于哪一档"的取值（`'full'` 完整推理 / `'summary'` 厂商摘要 / `'none'` 有思考但无文本）：它随 `thinkingText` 一起声明，`thinkingText` 非 `'yes'` 时按 `'none'` 填。

### 2.8 子任务行

子任务不走 `AgentMessage`，而是一行一子任务的记录：

```ts
interface SubagentRecord {
  /** 子智能体/子线程身份；与厂商 id 同值 */
  subagentId: string;
  /** 展示名；采不到为 null（消费方显示身份前 8 位） */
  name: string | null;
  /** 派发方式（如 spawn_agent / subagent / Task），采不到为 null */
  kind: string | null;
  /** 这行记录的数据来源 */
  source: MessageSource;
  /** 归一到五种之一；厂商没给状态且无法推导时为 'unknown' */
  status: 'running' | 'completed' | 'failed' | 'stopped' | 'unknown';
  /** null = 状态已采集到；非 null = 未采集到的原因 */
  statusMissing: MissingReason | null;
  /** 结果摘要（子智能体的最终答复）；取消场景可能为 null */
  outcome: string | null;
  /** **派生这个子任务的那次工具调用 id**；给不出为 null。与消息的 `parentCallId` 同源同义 */
  parentCallId: string | null;
  /** 嵌套父链；顶层子任务为 null（父就是主会话时也记 null） */
  parentSubagentId: string | null;
  /** 该子任务自己的用量；采不到为 null */
  usage: UsageTokens | null;
}
```

四条硬规则：

- **状态与"状态是否采到"分开记**：`status` 永远给一个可渲染的值（采不到就 `'unknown'`），`statusMissing` 说明为什么采不到。不得用 `status: null` 表示未采集。契约五态之外，界面另有第六种显示值「未收场」（运行期被终止、`finished` 永不到达）。
- **`outcome` 只放文本**：厂商给的是结构化对象时取其中的文本块；拿不到文本就 `null`，不得用推理内容、工具输出或状态文案顶替。
- **`parentCallId` 是两套 id 之间的唯一桥**：子任务**记录**的身份是厂商原生 id（`task_id` / 子线程 id / `agentId`），而子智能体的**消息**挂在**派生它的那次工具调用 id** 上。少了这一格，消费方按 `subagentId` 分桶时子任务的消息会全部落回主会话或被丢掉。**给不出就记 `null`，不猜**（消费方退化为按名字认，而不是编一个）。
- **`parentSubagentId` 只在父本身也是一条子任务时给 id**：父是主会话（或主会话身份未知）时记 `null`——照抄主会话 id 会让消费方挂到一个不存在的父节点上（界面表现：进入子任务后面包屑整段消失）。

### 2.9 环境信息（与消息解耦的旁路契约）

「这一行运行在什么环境里」。**不进 `AgentMessage`**：厂商系统提示词与工具模式串可能几十 KB（并进主模型意味着每次流式提交都在搬它），而它只在环境抽屉打开时才需要。

```ts
type EnvSource = 'user' | 'project' | 'vendor' | 'observed';

type EnvItem =
  | { present: true;  id: string; label: string;
      text: string;                                  /** 长文本按**原文**给，由数据层按上限截断 */
      truncated: { reason: string; bytes: number } | null;   /** null = 完整 */
      copyPath?: string;                             /** 有约定路径时界面额外给「复制」 */
      at: string | null }
  | { present: false; id: string; label: string;
      missing: MissingReason };                      /** 「这一格没有」**必须**带原因 */

interface EnvGroup { id: string; title: string; source: EnvSource; items: EnvItem[] }

interface AgentEnvironment {
  summary: { agentKind: string; modelId: string;
             effort: string | null;                  /** 我们**要求**的档位，不是实际生效的档位 */
             providerName: string; baseUrl: string; workspaceBase: string; baselineCommit: string };
  groups: EnvGroup[];
}
```

- **四组的 `source` 回答「这条要求是谁下发的」**：`user` 用户层（附件与上下文引用，**不含用户提示词**）、`vendor` 厂商系统层（系统提示词 / 已调度的工具 / 斜杠命令与子智能体定义 / 工具模式串）、`project` **本仓**下发的运行配置（权限档 / 被禁用的工具 / 模型与思考强度 / 工作区与基线）、`observed` 实测统计（用过的工具及次数）。
- **「已调度的工具」与「用过的工具」必须分开**：前者是厂商自报的**工具面**（`vendor-system.tools`，回答「它当时手里有什么」），后者从内容记录里的 `tool-call` 块按 `name` 计数（回答「它用了什么」）。混成一个列表就会出现「列了 30 个工具，其实只用了 2 个」的误读。
- **厂商系统层只从 `vendor-system` 事件取**，不读那条 `log` 原文（形状由厂商定、随版本漂移；逐字认字段等于把厂商适配搬进浏览器）。没有这条事件的那一家整组走 `not-exposed`。
- **适配器只负责把 `vendor-system` 发出来**，拼装（截断、字节数、组名、列表上限）在数据层，界面只渲染给到的形状。

---

## 3. 字段级三家映射

表中"路径"一律写成 `载荷 → 字段`；`—` 表示该家没有这个来源。

### 3.1 信封字段

| 字段 | claude-code | codex | dsh |
|---|---|---|---|
| `messageId` | 适配器生成 `<runId>:<seq>` | 同左 | 同左 |
| `vendorId` | `assistant.message.id` | `item.id`（会话文件里是 `item_completed.item.id`，与事件流同值） | `data.message.id` |
| `role` | `assistant.message.role` | **派生**：`AgentMessage` / `Reasoning` → `assistant`；`CommandExecution` 的**结果**那一半 → `tool`（调用那一半是 `assistant`）；`CollabAgentToolCall` → `assistant`（派发调用的载体）；其余条目（`UserMessage`、将来新增的）不产出消息 | `data.message.role` |
| `source` | `'wire'`（SDK 消息流） | `'session-file'`（消息与子任务行的主通道：工具真名、结构化入参与 `call_id` 配对键都只在这里）+ `'wire'`（事件流：派发调用那一块与子任务壳）——**没有 hook 通道** | `'wire'`（会话通知流） |
| `roundTrip` | 按 `assistant.message.id` 去重计数；**只数主循环**（侧链消息的 `parent_tool_use_id` 非空 ⇒ 不计入）**但按每会话自己的号编号**：侧链按 `parent_tool_use_id` 分组、每组数去重后的 `message.id` 个数（首次出现顺序 1..N），主会话仍用 `state.turns`（见 §2.6）；**一次都没数到时给 1**（这一格是必填正整数） | 按模型产出条目中的 **`AgentMessage`** 的 `item.id` 去重计数（两侧同一把尺子：事件流与会话文件**都只数答复条目**；会话文件侧同时按 `itemId` 去重）；**一次都没数到时给 1** | 按 `step/start` 事件边界计数（不分会话 ⇒ 合计天然是全树的）；**消息信封这一格取该会话自己的 `data.step`**（见 §2.6） |
| `vendorTurn` | `null` | `null`（`turn_id` 是字符串稳定标识，不是序号 ⇒ 不冒充数字） | `data.message.turn`（用户轮号） |
| `step` | `null` | `null` | `data.message.step` |
| `parentCallId` | `parent_tool_use_id`（与工具调用 id 同空间；子智能体消息上它与 `subagentId` **同值**） | `null`（会话文件的条目不带派生关系；子智能体消息的归属改用 `subagentId`） | `null`（真机通知载荷没有子会话 id / `agentId`，而 `subagent` 工具调用的 `callId` 是 `call_…\|<uuid>` 复合形状、与身份不是同一个值 ⇒ 给不出就不猜） |
| `subagentId` | `parent_tool_use_id`（侧链消息；主循环为 `null`） | 子线程 id（= 会话文件名末段；主线程为 `null`） | 三级兜底：`subagentId` → `agentId` → `childSessionId`（与 `params.sessionId` 同值） |
| `chunk` | 恒 `'snapshot'`（完整 `assistant` / `user` 消息）；`stream_event` 的增量才是 `'delta'`，而该选项当前未开（见第 7 章）；**即便开启也只覆盖主会话** | 恒 `'snapshot'`（事件流无 delta 形态） | 恒 `'snapshot'`（块取自 `assistant/message.content[]`，`data.stream[]` 未接） |
| `raw` | 该条 SDK 消息原样 | 该条事件或会话记录原样 | 该条通知原样 |
| `usage`（消息级） | `null`（**不交**：wire 上它的 `output_tokens` 在本仓网关下恒 0 ⇒ 照快照求和会得出「这条没产出」的静默假数） | `null`（**不交**：事件流没有消息级用量，只有轮级的 `turn.completed` / token 通知） | `assistant/message` 的 `data.usage` 三项原文（`inputTokens` / `cacheReadTokens` / `outputTokens`）；**三项缺一 ⇒ 整格 `null`，不填 0**；主会话与子会话**同一个函数**产出（`dshAssistantMessageDraft` 不分会话） |

### 3.2 内容块

| 块 | claude-code | codex | dsh |
|---|---|---|---|
| `text` | `assistant.message.content[type=text].text` | 会话文件 `item_completed` 的 `AgentMessage`：`item.text` 优先，否则 `content[].text` 用 `\n` 拼接 | `assistant/message` 的 `data.message.content[type=text].text`（整块快照） |
| `thinking` | `assistant.message.content[type=thinking]`（`thinking` + `signature`）；流式为 `thinking_delta` / `signature_delta` | **会话文件** `Reasoning`：`raw_content` 拼串非空 ⇒ 正文（`full`）；否则 `summary_text` 非空 ⇒ 摘要（`summary`）；都空 ⇒ `text:null` + `none`。事件流的 `reasoning` item 按厂商定义只给**摘要**，正文不在那里 | `data.message.content[type=reasoning].text`（整块快照，`signature` 恒 `null`） |
| `tool-call` | `content[type=tool_use]`：`id` / `name` / `input` | **会话文件**：`CommandExecution` → 调用块（真名取同 `call_id` 的 `function_call.name`，缺席回落 `exec_command`；入参由 `arguments` JSON 串解析，解析不了退回原串）；`CollabAgentToolCall` → 派发调用块；`mcp_tool_call` → 调用块（`callId` = 条目 id、`name` = `<server>/<tool>`、`input` = `arguments`，**不属十族** ⇒ `family: null`）；`file_change` 的文件改动由 `command_execution` 承载，不另产块；条目级 `error`（`item.type === 'error'`，例如「有无法识别的配置项」）**不产消息块**，落一条行级 `error` 事件（非致命告警，不得当成运行失败）；事件流的 `command_execution` 只有命令文本、没有真名与结构化入参 | `tool/call` 事件的 `data`：`callId` / `name` / `arguments`（JSON 字符串，要自己解析） |
| `tool-result` | `user.message.content[type=tool_result]`：`tool_use_id` / `content` / `is_error`；结构化旁路 `tool_use_result` | 会话文件：`CommandExecution` → 结果块（`aggregated_output` / `exit_code`，`structured` 只放 `{exitCode}`；`stdout` 与 `stderr` **合流**，拆不开 ⇒ 不编 `stderr`） | `tool/result` 事件的 `data.message`：`toolCallId` / `content[]` / `isError`；**结构化结果在 `data.meta`**（`content[]` 只是给模型看的文本） |
| `attachment` | — | — | —（**契约保留，当前三家适配器都不产出**：`attachmentBlockDraft` 在公共层有定义但无调用点） |
| `unrecognized` | — | — | —（**契约保留，当前三家适配器都不产出**：未识别的厂商内容一律落事件侧那条保留原始负载的 `log`，消息侧无产出点） |

**消息级用量（`AgentMessage.usage`）的实现口径**：

- **契约层可选、草稿层必填**（`MessageDraft.usage: UsageTokens | null`）：前者兼容磁盘上已有的老消息，后者由 `tsc` 把所有构造点列出来 ⇒ 不会出现「某家 `undefined`、某家 `null`」的漂移（与 `timing` / `subagentTokens` 同一条处置）。三家所有构造点 + 测试夹具里的 `MessageDraft` 字面量都要显式补 `usage: null`。
- **合并器按「带值覆盖、缺省保留」**：同一条**逻辑消息**会多次投递（增量块 / block-end 快照），`usage` 只在完整 `assistant/message` 那一次到达；后到的投递不带它时**必须保留已采到的值**。
- **取值函数是纯读**：`readUsageTokens(usage): UsageTokens | null`（不产草稿）与字段名表 `DSH_USAGE_FIELDS` 一起放在 dsh 的 **`protocol.ts`**（wire 形状的唯一真源，且它**不 import 本目录任何模块**）；`events.ts` 的 `readTokens` 改成「调它 + 落草稿」，并**继续 re-export** `DSH_USAGE_FIELDS`。
  ⚠️ **方向是硬约束**：`events.ts` 已 import `message.ts`，纯读函数若留在 `events.ts`，`message.ts` 反过来 import 它就是**循环依赖**。一份实现两处调用（防两套字段名漂移）。
- **一个字节都不动的行级口径**：`state.usage*` 的累加、`usage` 事件的累计里程碑、`EvalRow.tokens`、`subagentTokens` / `subagentTurns`。**消息级用量不参与任何合计**——本设计**不**承诺「Σ 消息级 = 行级」（跨投递去重与跨会话归属是另一件事）。
- 重复投递在消息级不可见：同一条消息被重投时只保留**最后一条带值**的 `usage`。

### 3.3 子任务

| 维度 | claude-code | codex | dsh |
|---|---|---|---|
| 启动 | `system` 子类型 `task_started`：`task_id` / `subagent_type` / `description` / `prompt` / `spawn_depth`。**先过形状判据**（三格至少一格非 `null`）才认；判不过的条目**不产行** | 事件流 `item.type='collab_tool_call'`：`tool`（`spawn_agent` / `wait` / `close_agent` 等）/ `prompt` / `receiver_thread_ids` / `agents_states`（**以子线程 id 为键的对象**，不是数组）。`item.started` 时 `receiver_thread_ids` 是空数组 ⇒ 不落行（「还没建」与「建了没给 id」分不开） | `subagent.started` / `subagent.finished` 两条顶层通知；身份**三级兜底**：`subagentId` → `agentId` → `childSessionId` |
| 名称 | `task_started.description` | 事件流：`prompt` 首行；会话文件：`session_meta.source.subagent.thread_spawn.agent_nickname` | catalog `label`（catalog 可能先于 start/finish 到达 ⇒ 按 `childId` 记住，否则收场时名字只能是 `null`） |
| 类型 | `task_started.subagent_type` | 事件流 `collab_tool_call.tool`；会话文件：**父**会话文件里那条协作条目的 `tool` | catalog `mode`（`one-shot` / `continuable`）；收场时 `provider` 优先 |
| 状态 | `task_notification.status` ∈ `completed` / `failed` / `stopped`（`task_started` 时记 `running`）；终态是原生字段 ⇒ `statusMissing` 恒 `null` | 两条通道：事件流 `agents_states[<子线程 id>].status`（**只认得出 `completed` / `failed`**，其余按 `running` + `statusMissing:'unverified'`）；会话文件——有 `AgentMessage` ⇒ `completed`，一条都没有 ⇒ `unknown` + `unverified`（这家没有可靠的终态字段） | **两格合读**（`status` × `stopReason`）：`ok+completed` ⇒ `completed`；`ok+max-tokens` ⇒ `failed`；`error+aborted` ⇒ `stopped`；`error+error` ⇒ `failed`；其余组合（含未观测的 `refusal`）⇒ `unknown` + `unverified` |
| 结果摘要 | `task_notification.summary` | 事件流 `agents_states[<子线程 id>].message`；会话文件：子线程最后一条 `AgentMessage` 的正文 | `subagent.finished` 载荷 `lastAssistantMessage` 里 `type='text'` 的块（取消时可能只有 `reasoning` ⇒ `null`，不拿推理顶替） |
| `parentCallId` | `tool_use_id`（与子消息上的 `parent_tool_use_id`、派发工具调用块的 `id` **三者同值**） | 两条通道给的是**不同的值**：事件流用**条目 id**（事件流内部的配对键，与派发调用块同值）；会话文件用**父会话文件里那条协作条目的真 `call_id`**（按 `item.id` 与 `function_call.call_id` 配对，配不上记 `null`，不拿条目号冒充） | `null`（真机载荷没有子会话 id / `agentId`，而 `subagent` 工具调用的 `callId` 是 `call_…\|<uuid>` 复合形状、与身份不是同一个值 ⇒ 不猜） |
| 嵌套父链 | `spawn_depth > 1` 时取**消息**上的 `parent_agent_id`（深度 1 时该格本身是 `null`，与主会话不可区分 ⇒ 记 `null`）；`task_started` 载荷里没有父 id。**不得照字面拿 `parent_agent_id` 判父子**——那会得出「所有子智能体都没有父」 | 会话文件 `session_meta.parent_thread_id`（`thread_spawn.depth` 给深度）；**父就是主线程时记 `null`** | `null`（真机通知不带父 id；只有「父会话是不是主会话」这一条判据） |
| 子任务级用量 | **CLI 落盘的子智能体转录**：`<configHome>/projects/<项目目录>/<sessionId>/subagents/agent-<agentId>.jsonl`，按 `message.id` 去重后求和（`task_notification.usage` 是 `total_tokens` / `tool_uses` / `duration_ms` 的**异形**，没有三元组 ⇒ 不采用）。**只在收尾读一次盘**（终态通知那一帧只登记记录），全量读因此从 2 次降到 1 次 | 子线程会话文件 `token_count.info.total_token_usage`（含 `reasoning_output_tokens`）；三格缺任一 ⇒ `null` | 子会话 `assistant/message` 的 `data.usage` 按 `params.sessionId` 分组求和（**白名单只含本行的子会话**：那张表是模块级的，别的行的会话也在里面） |
| 子任务级轮次 | 该转录按 `message.id` 去重后的**个数**（与用量同一次读盘） | 该子线程会话文件里 `turnIds` 的个数（**只收「真的有内容」的轮**：桶里得有本模块消费的记录类型，只有开工痕迹的不算） | 该子会话自己的 `step/start` 计数（与合计**同一个计数点**，只是按会话另记一格） |
| 轨迹可达性 | 子智能体消息与主会话同流投送（带 `parent_tool_use_id`）；适配器已显式开 `forwardSubagentText: true`——不开时只有 `tool_use` / `tool_result` 块，看不到子智能体说的话与想的事。**token 级增量只覆盖主会话** | **不在主流里**，必须读子线程会话文件；子线程沿 spawn 链**递归发现**（种子是事件流的 `receiver_thread_ids`，嵌套的那些只写在派发者自己的文件里） | 子会话事件直接出现在同一条通知流里（`params.sessionId` = 子会话 id） |
| 未收场 | 无通知 ⇒ 保持「运行中」 | 会话文件仍在，可读部分轨迹 | 运行时被终止时 `subagent.finished` 不会到达 ⇒ 必须显示「未收场」 |

**claude 的 `result.subagent_stats` 只作聚合与交叉校验**：它是**未收编进 SDK 类型面**的聚合计数（`spawned` / `requested` / `max_depth` / `completed` / `failed` / `killed` / `refused` / `by_type`，可能随版本变动）⇒ 落成一对 `source: 'aggregate'` 的子任务行（`name` 为 `null`、`outcome` 带计数，供聚合面板用），**不得作为逐个身份的来源**。它与 `task_*` 不一致时**以 `task_*` 为准**并落一条 WARN。

### 3.4 计量

| 量 | claude-code | codex | dsh |
|---|---|---|---|
| 输入（非缓存） | `result.usage.input_tokens`（原文即不含 cache） | 事件流 `turn.completed.usage.input_tokens − cached_input_tokens`；会话文件 `token_count.info.total_token_usage.*` 同式（**必须减**） | `usage.inputTokens`（原文即不含 cache） |
| 命中缓存 | `cache_read_input_tokens` | `cached_input_tokens` | `cacheReadTokens` |
| 输出 | `output_tokens` | `output_tokens` | `outputTokens` |
| 思考 token | `output_tokens_details.thinking_tokens` | `reasoning_output_tokens`（**只有会话文件的 `token_count` 有**，事件流的 `turn.completed` 不含它） | `reasoningTokens`（当前通道不投送 ⇒ `null`） |
| 缓存写 | `cache_creation_input_tokens`（**不计入 `cached`**） | `cache_write_input_tokens`（**不计入 `cached`**） | `cacheWriteTokens`（**不计入 `cached`**） |
| 总量原文 | 无（分列计数，没有合计格 ⇒ `null`） | 事件流按类型面**没有**总量格 ⇒ `null`；会话文件 `token_count.info.total_token_usage.total_tokens` | `totalTokens` |
| 整轮时长 | `result.duration_ms` | 会话文件首末行 `timestamp` 之差 | 会话事件 `time` 首末之差 |
| 仅 API 时长 | `result.duration_api_ms` | `null` | `null` |
| 首 token 时延 | `result.ttft_ms` | `null` | `null` |
| 时间来源标记 | `'vendor'` | `'events'` | `'events'` |
| **子智能体那一份用量** | 读 CLI 转录目录，**按 `message.id` 去重后**逐格求和（同一往返会按内容块出现多次，第一条的 `output_tokens` 是 0 ⇒ 不去重会双计 input / cached）。读法三条：**同步分块流式读**（`openSync` + 64 KB `readSync` + `StringDecoder`，**不许** `readFileSync` 整份 ⇒ 峰值内存从「整份 + 行数组」降到「最大单行 + 一块」；**必须同步**——`finalize` / `project` 都是同步钩子，改异步要动钩子签名并波及另两家）；**同版本不重复解析**（给「路径 + size + mtime」加 **run 作用域**的小缓存，不是模块级：避免跨 run 留大对象；收尾那一次仍然真读，命中缓存的只是「文件没长」的那些）；解析规则逐字不变 | Σ 各子线程会话文件的累计用量（`normalizedTotalUsage`） | Σ 本行子会话白名单的 `sessionUsage[id]` |
| **子智能体那一份轮次** | 同一份转录里 `message.id` 去重后的个数之和 | Σ 各子线程 `turnIds` 的个数（只收有内容的轮） | Σ 本行子会话白名单的 `step/start` 计数 |
| 子智能体**自己的**用量行 | **不发**：收尾只交 `usage`（合计）与 `turns` 两格，事件流里一条带会话身份的读数据都没有 | 不发（子线程不产 `usage` 事件） | 发：带会话身份的读数与本行累计**在同一条流里交错**，是**行尺度**（见 §2.5） |

**三处必须写进适配器的口径差异**：

1. **输入的 cache 口径**：codex 的 `input_tokens` 含缓存读，另两家不含 ⇒ codex 必须做减法（`Math.max(0, input − cached)`），归一后三家统一用 `cached / (input + cached)` 算命中率。
2. **缓存写不进 `cached`**：三家的 `cache_creation_input_tokens` / `cache_write_input_tokens` / `cacheWriteTokens` 都是「写进缓存」，与「从缓存读」是两件事，一律不进 `cached`（否则第一轮就会显示命中率 100%）。
3. **合计与分量必须成对**：`subagentTokens` / `subagentTurns` 是 `tokens` / `turns` 的分量，**同刻交出**（只给分量会让「主会话 = 合计 − 分量」算出负数）。运行期合计口径不含子那一份的那两家（claude / codex 的运行期轮次只有主循环）**运行期不交分量**，等收尾两格一起换权威值。

### 3.5 能力声明（默认取值）

| 能力 | claude-code | codex | dsh |
|---|---|---|---|
| `thinkingText` | `'yes'`（SDK 消息流） | `'yes'`（**会话文件**通道）；事件流那一格记 `not-projected-by-vendor`（`reasoning` item 按厂商定义只给推理摘要，正文只在会话文件里） | `'yes'`（会话通知流） |
| `thinkingTextKind` | `'full'` | `'full'`（会话文件正文）/ `'summary'`（事件流那一格） | `'full'` |
| `toolInput` | `'yes'` | `'yes'`（真名与结构化入参取自会话文件；事件流那一格只有命令文本与协作动作名，记 `not-projected-by-vendor`） | `'yes'` |
| `toolResult` | `'yes'` | `'yes'` | `'yes'` |
| `subagent` | `'yes'`（轨迹完整度取决于 `forwardSubagentText`：SDK 默认只投送子智能体的 `tool_use` / `tool_result` 块，**本适配器已显式开启**，故其文本与思考块也会到达；`CLAUDE_CODE_EXTRA_BODY` 那个覆盖层**对子智能体同样生效**） | `'yes'`（依赖多智能体开关与路由；轨迹取自子线程会话文件） | `'yes'` |
| `streamingDelta` | 声明 `'yes'`；**实际取不到**：适配器没有给 `includePartialMessages`，消息流里不会出现 `stream_event`（`stream_event` 的解析路径已就位，开启该选项即可生效）；且即便开启也只覆盖主会话 | `'no'`（事件流无 delta 形态） | 声明 `'yes'`；**实际取不到**：消息块一律取自 `assistant/message` 的 `content[]`（整块快照），`data.stream[]` 那条增量通道没有取数实现 |
| 各格的 `source` | 五格全 `'wire'` | `thinkingText` / `toolInput` / `subagent` 三格 `'session-file'`；`streamingDelta` 为 `null`（配 `not-supported`） | 五格全 `'wire'` |

**思考 token 的可得性**（对应 `reasoningOutput` 那一格）：claude `'yes'`（`result.usage.output_tokens_details.thinking_tokens`，恒 ≤ `output`）；codex `'yes'`（**只在会话文件的 `token_count` 里**，事件流的 `turn.completed` 不含它；⚠️ **样本只覆盖部分路由** ⇒ 能力声明必须带路由前提）；dsh 不投送（本条路由的用量映射从不写这一格 ⇒ `not-projected-by-vendor` + `not-exposed`）。三家都**只收结算值**，采不到一律 `null`（口径见 §2.4）。

> 同一份适配器元数据里另有两格与消息无关、本文不展开：`protocolTypes`（这家能收的协议**集合**，候选池过滤的真源）与 `reasoningEfforts`（档位域，按家各不相同）。

### 3.6 思考强度档位（`effort`）

口径三条，**契约与界面统一用档名 `off`**，翻译由各适配器做：

| 输入 | 语义 | 三家落地 |
|---|---|---|
| **未选**（`undefined`） | **不指定**，让 SDK / 厂商自己推断 | claude / codex：`effort` 那一格**一个键都不加**；**dsh 例外** ⇒ 显式传 `high`（它没有「不传就推断」这条路：不传 = harness 不写 reasoning 字段 = **显式关闭**） |
| **显式 `off`** | **要求不思考**（`EvalRow.effort` 记的是「我们**要求**的档位」，不是「实际生效的档位」） | dsh：原样交 `'off'`（关闭由 harness 的 `off: null` 实现，适配器**不自己特判**）；claude：`thinking: { type: 'disabled' }` 且**不传** `effort`，另有 spawn 时的 env 覆盖层（见下一条）；codex：`model_reasoning_effort` 翻成 **`none`**（`codexEffortOf`）**且** CLI config 多一格 `model_reasoning_summary: 'none'` |
| 其余档位 | 原样透传 | 三家的档位域各不相同（dsh 只有 `off` / `low` / `high` / `max`）；**只有关闭档不同名** |

```ts
// 唯一的取档实现，各家 run 入口一处（别在两处各写一份）
// dsh —— 恒带，不再有「undefined 时一个键都不加」这条路
const effort = input.effort ?? DSH_DEFAULT_EFFORT;      // 'high'
...{ reasoningEffort: effort }                           // 'off' 也原样交出
// claude-code（startClaudeCode 的 options）：两个键各自条件展开，互不代替
...(input.effort === undefined || input.effort === 'off' ? {} : { effort: input.effort }),
...(input.effort === 'off' ? { thinking: { type: 'disabled' as const } } : {}),
// claude-code（buildSubprocessEnv 的 injected）：env 覆盖层，与上面两格各管一批模型
...claudeExtraEnvFor(input.effort),                       // 见下方「off 在两家厂商侧都要多一格」
// codex —— 未选照旧不传；只有关闭档走映射
...(input.effort === undefined ? {} : { modelReasoningEffort: codexEffortOf(input.effort) }),
function codexEffortOf(effort: string): string { return effort === 'off' ? 'none' : effort; }
// codex —— 同一处再给 config 的**第三实参**（不许挤掉 contextWindow 那一格）
config: buildCodexConfig(baseUrl, input.route.contextWindow,
  input.effort === 'off' ? 'none' : undefined),
```

- **dsh 的档位 → wire 拼写**（与档位域**同源派生**）：`{ off: null, low: 'low', high: 'high', max: 'max' }`。`off` 的 `null` 表示「不写这个键」⇒ 落到 `thinking: { type: 'disabled' }`（anthropic-messages wire）/ `reasoning: { effort: 'none' }`（openai-responses wire）；其余三档原样透传（`max` 不在 OpenAI 的枚举里，但该网关实测接受——换网关若拒它，**只改这一张表**，界面仍是四档：档位域是智能体的能力，不是网关的词汇表）。注册表 `reasoningEfforts` 的键集合必须**逐字等于**这张表的键：界面能选而 patch 里没有 ⇒ dsh 在 `initialize` 阶段以 `UNSUPPORTED_REASONING_EFFORT` 收场，用户是**选完到运行时才失败**。
- **注册表**：`AgentProviderMetadata` 新增**可选** `defaultEffort?: string`——**只有 dsh 声明**（`DSH_DEFAULT_EFFORT = 'high'`，它必须同时满足「在 `DSH_REASONING_WIRE` 的键里」与「不是关闭档」，由守卫钉住）。claude / codex 不声明（未选由厂商推断，API 侧无从校验）。
- **候选与校验**：候选 =（上游声明过 `supportedEfforts` ? 交集 : 该家**完整档位域**）**∪ 该家的关闭档**；「未指定」**不是候选数组的元素**，而是 Select 的**清空态**（否则「关闭」永远点不到）。API 建行时**未选也要校验**：`declared = row.effort ?? metadata.defaultEffort`，`declared` 不在候选里就建行即拒（claude / codex 没声明 ⇒ 未选不校验）。档位域、推荐档与上游取数面见 `2026-09-22-scaffold-design.md` §13.5。
- **`off` 在两家厂商侧都要多一格才可能生效**（依赖厂商 CLI 内部行为，见 §8.1）：
  - claude：spawn CLI 时注入环境变量 `CLAUDE_CODE_EXTRA_BODY`，值**必须由 `JSON.stringify({ thinking: { type: 'disabled' } })` 生成**（逐字节等于 `{"thinking":{"type":"disabled"}}`；CLI 对**非法 JSON 静默忽略整条**，实测踩过：PowerShell 吃掉内层引号 ⇒ env 变成 `{thinking:{type:disabled}}` ⇒ 无报错、字段仍缺失）。落点是一条**导出的纯函数** `claudeExtraEnvFor(effort)`：`off` ⇒ `{ CLAUDE_CODE_EXTRA_BODY: '{"thinking":{"type":"disabled"}}' }`，其余档位与未选 ⇒ **空对象**，再把它展开进 `buildSubprocessEnv` 的 `injected`。**必须给空对象**，不能写 `CLAUDE_CODE_EXTRA_BODY: off ? VALUE : undefined`（值为 `undefined` 的键会被**删掉** ⇒ 在非 off 档删掉宿主继承来的同名变量，改变其它档位的行为）。`thinking` 选项那一格**保留**：`thinking: { type: 'disabled' }` 经 SDK 转成 argv `--thinking disabled` **到得了 CLI**，被丢在**组装请求体**那一格 ⇒ CLI 的模型能力门**放行**的模型由这一格生效，**不放行**的模型由 env 覆盖层兜底（两半各管一批模型，不许删掉任何一半）。
  - codex：多一格 CLI config `model_reasoning_summary: 'none'`（**只在 `off` 时给**；其余档位与未选传 `undefined` ⇒ **键整个不出现**）。做法是把 `reasoningSummary` 作为 `buildCodexConfig(baseUrl, contextWindow, reasoningSummary?)` 的**第三实参**（不许挤掉 `contextWindow` 那一格），由它按「`undefined` ⇒ 不写这个键」的条件展开产出。触发条件是 `include: ["reasoning.encrypted_content"]` **∧** `reasoning.summary` 同时存在：**两半缺一都关不掉**（`effort: 'none'` 单独给无效，`include` 不可配——上游硬编码）。⚠️ 「键不存在」与「键在、值为 `undefined`」在本仓 SDK 下**行为等价**（它对 `undefined` 值的键直接跳过、不产出任何 `--config` 参数）⇒ 钉形态是为了**逐键对账**与抗 SDK 漂移，不是功能差异。
  - ⚠️ **codex 的 `off` 当前做不到「零推理」**：真机上 `turn_context` 直证 `effort="none"` **∧** `summary="none"`（主线程与子线程都到），**网关照样推理**（`off` 行 28 条 reasoning 条目、网关自述 7,347 思考 token；同 run 未选对照行 13 条）⇒ 那两格**确实到了 CLI**，是网关侧不认。极简 prompt 上的「0 条」**不外推到 agentic 长链路**。这一格因此只能按「已按要求下发」呈现，不得按「它没思考」呈现（与 §3.6 顶部「要求 vs 实际」同一口径）。
- **`off` 的生效是有前提的**（换网关 / 换 CLI 版本 / **换链路形态**都要重测）：claude 依赖 CLI 的模型能力门与 body 覆盖层的展开顺序（前置：hipaa 策略为假、`CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` **未设**）；codex 依赖网关对 `(include ∧ summary)` 的组合行为。⇒ **界面文案一律写成「要求不思考」而不是「它没思考」**（出处 `contracts` 的 `effortLabel`，行卡片标签与浮层共用同一份文案，**只此一处**）——`EvalRow.effort` 这一格记的本就是「我们**要求**的档位」。**清空态与显式 `off` 必须分开说**：清空态的占位文案写「未指定（由该家适配器决定：dsh 走 `high`）」；客户端拼环境信息的那一处旧文案「未指定（沿用厂商默认档）」同步改成这句（对 dsh 是假的）。
- **claude 的前置条件被破坏时是「静默失效」，必须变成可观测的**：`off` 档且合并后的子进程 env 里**存在** `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` ⇒ 落**一条 WARN**，点名宿主用的那个**键名原文**、说清后果（关闭被静默忽略、本次运行的 `off` 档读数作废）与下一步（去掉该变量后重跑）。三条判据细节：① 看**存在**（`!== undefined`）而不是真值——宿主可能写 `true` / `1` / 空串；② 键名按**大小写不敏感**查找并回报**原拼写**（Windows 环境块常写 `Path`）；③ **只在 `off` 档看**，其余档位与未选连一条日志都不多。
  **它是观测，不是拦截**：不许抛错、不许因此跳过这一行、不许改动注入、不许删改宿主那个变量；判据抽成**纯函数**（`hostDisablesBetas(合并后的 env, effort)`，返回命中的**键名原文**或 `null`），与 `claudeExtraEnvFor` 同一形态——`recorder.env` 是「宿主 + 注入」的合并对象，拿它断言在宿主设过时必然假红。WARN 文案由导出的模板常量 `CLAUDE_OFF_DISABLED_WARNING_TEXT` 拼出（全句只有 `<键名原文>` 一个可变 token），并以 `{ variable: <键名原文>, effort: 'off' }` 作第二个参数透传（**不 `JSON.stringify`**）；模板**导出给测试逐字比对**，用例不得另抄一份正文。
  **codex 侧不加对称观测**：它的失效模式是「CLI 内部把 config 键改名 / 忽略」，**启动前没有任何可读的信号源** ⇒ 加了只能是**假观测**；那一侧的探测器就是真机判据（该行的 reasoning 条目数）。
- **读数与判据的两把尺子**：单测证明「我们注入了什么」，真机证明「它生效了」，两者缺一都不算验收。真机判据读的是**行的产物**（dsh / claude 读 `messages.jsonl` 按 `mergeKey` 折叠后含 `thinking` 块的消息条数，主线程与子智能体分开；codex 读 `.agenthome/sessions/**/rollout-*.jsonl` 的 `reasoning` 条目数；`turn_context` 的键路径是 `payload.collaboration_mode.settings.reasoning_effort`（**少一层的 `payload.reasoning_effort` 是错路径**），摘要那一格在 `payload.summary`），且**「0」必须与同一 run 里的「未选」对照行成对读**（对照行 > 0 才算这一轮可判读）。**不要**用出网请求体当验收判据，也不要在 body / 日志文本里子串搜 `thinking`（真机上命中全是无关），CLI 自述的 `thinking_tokens` **没有区分力**。
- **路径 B（智能生成 / 智能识别 / 文本评分）没有思考档位这一格**：`TextRoute` 上只有协议 / 地址 / 密钥 / 模型 / 窗口 / 输出上限，一个 reasoning / thinking 参数都不发 ⇒ 行为由供应商默认决定（本机实测：anthropic 协议端点默认会思考、openai 协议端点落 `none`）。**它不能被我们默认关闭**这句话在它身上不成立（我们根本没有旋钮）；给它旋钮会牵动「这条路绝不用智能体」的口径，是另一次裁定。
- **历史可比性**：`run.json` 里没写 `effort` 的行，**dsh 的**实际档位从「关闭」变为 `high` ⇒ 同一行重跑与旧结果不同源（另两家不受影响）；**不做**按创建时间区分老新的补偿（那是第二个真相）。

---

## 4. 三家实施路径

每家的步骤按依赖排列，可逐步实现、逐步验证。

### 4.1 claude-code

**步骤 1｜建会话**
- 用 Agent SDK `query({ prompt, options })`；`cwd` 指向工作区，并过一遍 `realpathSync.native`（Windows 8.3 短名会被 CLI 的安全门拦下，表现为 0 改动）；取不到真实路径时回落原值并记 DEBUG，不让整行失败。
- `settingSources` 决定读哪些**文件系统 settings**：`'user'` = 配置根下的 `settings.json`、`'project'` = `${cwd}/.claude/settings.json`、`'local'` = `${cwd}/.claude/settings.local.json`；`[]` = 隔离模式（一个都不读，代价是**仓库自带的 `CLAUDE.md` 与项目配置也读不到**——`'project'` 是加载 `CLAUDE.md` 的必要条件）。需要它们时给 `['user', 'project', 'local']`，此时**必须**同时给 `settings: { env: { … } }`：仓库自带的 `.claude/settings.json` 就在 `'project'` 档里，它的 `env` 块会盖掉子进程环境注入的地址与密钥，而 `settings`（等价 CLI 的 `--settings`，flag 档）优先级高于 project / local，能把路由压回去。两半必须成对给。
- `env` 注入模型与路由（`ANTHROPIC_BASE_URL` / `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` / `CLAUDE_CONFIG_DIR`），不要依赖用户全局配置；`env` 是**替换**语义，要自己展开宿主环境。base URL 要去掉尾部 `/v1`（SDK 自己追加 `/v1/messages`）。
- **模型名**：`contextWindow ≥ 1_000_000` 时给模型名追加 `[1m]` 后缀（幂等、大小写不敏感）；其余原样。
- **工具面**：`disallowedTools` **无条件**禁七项（`CronCreate` / `CronDelete` / `CronList` / `ScheduleWakeup` / `PushNotification` / `DesignSync` / `WebSearch`，**不按模型名分档**——分档那一条分支与它的禁用名单一起删掉）；**只禁工具、不禁网络**（`Bash` / `WebFetch` 照旧可用）。`CLAUDE_CODE_ENABLE_TODO_TOOLS=1` 常开，让新模型上也补齐 `TaskCreate` / `TaskGet` / `TaskList` / `TaskUpdate`。
- **结构输出与档位按需带**：`outputSchema` 为 `undefined` / `null` 时一个字段都不加；`effort` 为 `undefined` 时同理（让模型用自己的默认档）。
- 权限用显式模式（`full` → `bypassPermissions` **必须**配 `allowDangerouslySkipPermissions: true`；`read-only` → `dontAsk` + `permissionPrompts: 'none'`）；不给 `maxTurns`（不给即不限）。若需要接收提问，见步骤 7。
- **编排开关与闸门**：`settings` 档显式给 `enableWorkflows: true` 与 `workflowSizeGuideline: 'medium'`，并在 `injected` 里注入 `CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS=8` 与 `CLAUDE_CODE_WORKFLOW_SIZE_WARNING_AGENTS=8`；规模计数由适配器按 `subagent-start` 自己留痕（作用域与「为什么总数不硬拦」见 §8.1 / §8.2）。

**步骤 2｜流式增量（当前未启用）**
- 增量通道是 SDK 的 `includePartialMessages: true` + `stream_event`：`message_start` → `content_block_start` → 多个 `content_block_delta` → `content_block_stop` → `message_delta` → `message_stop`。
- 增量子类型（判据是 `content_block_delta.delta.type`）：`text_delta`（正文）、`thinking_delta`（思考正文）、`signature_delta`（签名，落**同一个思考块**的槽位）、`input_json_delta`（工具入参分片，**不进消息层**）；其余子类型按未知跳过。
- **自己累积**：SDK 只转发原始事件，不提供累积文本；按 `index` 分组累积到块。`message_start` 记下 `message.id` 与一批块序号分配器，随后的完整 `assistant` 消息用同一个 `message.id` 把分配器取走 ⇒ 增量与快照落到同一批槽位。
- 流式事件只覆盖主会话：其 `parent_tool_use_id` 恒为 `null`，子智能体的 token 级增量不会转发，子任务归属一律用完整消息上的 `parent_tool_use_id`。
- **适配器当前没有给 `includePartialMessages`** ⇒ 实际拿不到 `stream_event`（解析路径已就位，开启该选项即生效）；能力位那一格因此与实现不一致，见第 7 章。

**步骤 3｜归一消息与块**
- `assistant` 消息 → 遍历 `message.content[]` 产出块：`text` / `thinking`（含 `signature`，空文本记 `text:null` + `textKind:'none'`）/ `tool_use`；其余类型**静默丢弃**。
- `user` 消息 → 若含 `tool_result`，产出 `tool-result` 块；同时读 `tool_use_result` 作为 `structured`——它是**工具的完整 Output 对象**（形状按工具名而定），不是发给模型的那份字符串内容，能读它就不要再从文本里正则提取。
- 工具结果文本上限 `TOOL_RESULT_MAX_CHARS = 20_000`（超出即截断）；厂商不给截断标记 ⇒ `truncation` 记 `unknown`。
- `system` 消息按子类型分流：`init` → **`vendor-system` 事件**（六格：`tools` / `slashCommands` / `agents` / `mcpServers` / `permissionMode` / `outputStyle`；字段不是数组 ⇒ `null`「没投送」，空数组 ⇒ `[]`「确实为空」，空串按没给），同时**记下 `session_id`**（定位子智能体转录目录的唯一钥匙）；`task_started` / `task_notification` 走子任务通道。
- **`system/thinking_tokens` 逐帧估算通道不投影**：它是「还没结算」的高频帧（一轮能到几千条），**不落 `attachment`、不进 `reasoningOutput`、也不落 `log`**——落盘只增噪声。`reasoningOutput` 只收 `result.usage` 的**结算值**。
- `result` 消息给终局用量与时延；一次 turn **恰好一条**，且在该 turn 的 `assistant` / `user` / `stream_event` 之后到达 ⇒ 可当收轮信号。结构化输出有两条落点（字段优先、`result` 文本兜底），两者不一致时落一条 WARN。

**步骤 4｜覆盖合并（关键）**
- 同一条 `assistant.message.id` 会被**分多条**投递：SDK 每完成一个非空内容块就发一条，每条只带该块（思考 / 正文 / 工具调用各一条），这些条共享同一个 id。
- 合并规则：同一条 `message.id` 会被**按内容块**分多次投递，每次只带一个块 ⇒ **新块追加到末尾、同键覆盖**（不得把每次投递都当成"整条消息的第 0 块"）；块序号按**首次到达**分配，分配后不再变化。增量（步骤 2）先按 `index` 累积成一个块，再按同一键覆盖。

**步骤 5｜子任务**
- `task_started`：`task_id` → `subagentId`；`description` → `name`；`subagent_type` → `kind`；`spawn_depth` 用于层级。`task_notification`：`status` → 终态；`summary` → `outcome`。
- **形状判据（先判形状，再产行）**：`subagent_type` / `spawn_depth` / `prompt` **至少一格非 `null`**（`''` 与 `0` 都算「给了」——判严了会把真派发判成幻影，比多一条幽灵行更坏）。判决只按 **`start` 帧**做，收场帧按同一个 id 追随（收场帧不承载形状证据）。三档：`'dispatch'` 产行并进入事实核对名单；`'phantom'`（CLI 给**非 Agent 任务**发的条目，盘上永远没有它的转录）**不产行**；`'unjudged'`（只见到收场帧）照产行，只落一条「可能少算」的 WARN。
- 子智能体的**工具调用与工具结果**块随主流到达（带 `parent_tool_use_id`），按它归属到对应子任务；`task_started.tool_use_id`、派生该子任务的工具调用 id、子消息上的 `parent_tool_use_id` 三者同值 ⇒ `parentCallId` 直接取 `tool_use_id` 并配到派发工具块上。
- 子智能体自己的文本与思考块：SDK **默认不转发**（只投 `tool_use` / `tool_result`），适配器显式给 `forwardSubagentText: true` ⇒ 两类块都会到达；不给时子任务视图只剩工具流水。
- 嵌套父链没有原生字段在 `task_started` 上（它只给 `spawn_depth`）：父任务的 id 取**消息**上的 `parent_agent_id`——**深度 ≥ 2 有效**；深度 1 时该格是 `null`，与主会话不可区分 ⇒ `parentSubagentId` 记 `null`，层级靠 `spawn_depth` 表达。
- 子任务行的 `usage` **不取** `task_notification.usage`（`total_tokens` / `tool_uses` / `duration_ms` 是另一种形状，没有三元组）；它由步骤 5.2 的读盘补齐，拿到时整条记录的 `source` 改成 `'session-file'`。

**步骤 5.1｜子智能体那一份用量与轮次（读 CLI 转录）**
- **为什么读盘**：`forwardSubagentText: true` 转发过来的侧链消息虽然带 `message.usage`，但**流式快照的 `output_tokens` 恒为 0**（结算值只在主会话的 `result.usage` 上）⇒ 照快照求和会得出「子智能体输出 0 token」这种静默假数。唯一权威源是 CLI 自己落盘的文件。
- **路径**：`<configHome>/projects/<项目目录>/<sessionId>/subagents/agent-<agentId>.jsonl`。`sessionId` 来自 `system/init`；**采不到 `sessionId` 就不猜目录**（猜错会把别的会话的转录算到这一行上），直接按「没有目录」处置。项目目录名不重算：遍历 `projects/` 下每个目录，取第一个 `<项目>/<sessionId>/subagents` 读得动的。文件过滤 `agent-*.jsonl` 并**按名字排序**（让点名 WARN 的顺序确定）；`agent-*.meta.json` 不是转录（后缀挡住）。
- **单个文件的读数规则（只有这一条）**：逐行 JSON；半截行 / 坏行**跳过**（CLI 边跑边写，这是常态）；只认 `type === 'assistant'`；按 `message.id` **去重、后到覆盖**（同一次往返会按内容块出现多次，第一条的 `output_tokens` 是 0 ⇒ 逐条相加会把 input / cached 双计）；三项（`input_tokens` / `cache_read_input_tokens` / `output_tokens`）缺一，或认得是 `assistant` 却拿不到 `message.id` ⇒ **整份文件作废**（跳过会让那一次往返从合计与轮次里一起消失）；一条可用记录都没有（空文件 / 被中断在半截）⇒ 同样作废。文件读数 = `sumUsageTokens(去重后的各次往返)`，轮次 = 去重后的 `message.id` **个数**。
- **聚合（全部子智能体）**：读取集 = **目录里枚举出来的转录 ∪ 事实核对名单**——盘上有就必须读（转录比事件流更硬），名单里有就必须读得动。**有任何一个进 `missing` ⇒ 两格一起 `null`**（「全量或 null」：部分和会被读成总数，而界面上它与全量合计长得一模一样），并落一条**点名**的 WARN；读到的那些**不进合计**。
- **「确实没有」的出口**：会话目录不存在、或目录里一个转录都没有，且名单里也没有形状像派发的 id ⇒ `subagentTokens = {0,0,0}`、`subagentTurns = 0`；名单里**有** ⇒ 事实缺失：两格 `null` + 点名那些 id。
- **读数时机：只在收尾读一次盘**（`index.ts` 的 `finalSubagents`；终态通知那一帧只登记记录，**不读盘**）。每个子智能体的全量读因此从 2 次降到 1 次；代价是子智能体收场到收尾之间那一格显示「用量未采集」，终态值由收尾保证（`turn.ts` 的 `finally`，正常 / 失败 / 被终止都会跑）。
- **登记要连派发帧一起**（`rememberSubagent` 记 `running`，终态优先）⇒ 没有终态通知的子智能体（CLI 没投送 `task_notification` / 运行被中断）在收尾那批里也有它，`SubagentRecord.usage` 不再恒为 `null`。
- **读法三条**（用户点名的内存与重复读两件事，落点在 `subagent-usage.ts` 与 `index.ts` 的缓存）：
  1. **同步分块流式读**：`readOne` 逐行消费（`openSync` + 64 KB `readSync` + `StringDecoder`），**不许** `readFileSync` 整份；解析规则逐字保留（只认 `type === 'assistant'`、`message.id` 去重后到覆盖、三项齐全才认、认得却读不全 ⇒ 整份作废、半截行跳过）。
     ⚠️ **必须同步**：`finalize` 与 `project` 都是同步钩子，改异步要动钩子签名并波及另两家（代价远大于收益）。
  2. **同版本不重复解析**：给「路径 + size + mtime」加一个 **run 作用域**的小缓存（不是模块级：避免跨 run 留大对象）；同版本直接复用解析结果，版本变了才重读。收尾那一次读取**仍然真读**（全量的前提）。
  3. **收尾那一条路径与子任务条那一格共用同一个缓存** ⇒ 同一版本的文件各只 open 一次。
- **不发逐轮读数**：事件流里 `turn.subagentId` 恒 `null`（与 codex 同形），也不交逐轮明细（`rounds` 已删）——两个读出口只交 `usage` 与 `turns`。
- **主会话轮次的计数**：只数**主循环**的 `assistant.message.id`（侧链消息的 `parent_tool_use_id` 非空 ⇒ 直接返回 `null`，不计数），这正是「主 + 子」这条加法成立的前提。`num_turns` 只作兜底（我们一次都没数到时才用），两者不一致时落一条 WARN。
- **抽屉里那一格（单个子智能体）**：按 **wire id 拼单个文件名**（`agent-<id>.jsonl`）——真派发那条 wire id 与文件名里的 `agentId` 同值，所以这个入口的匹配语义天然正确；它只回答「**这一个**花了多少」，与上面的「全部加起来」共用同一条读数规则（各写一份的症状是「同一份文件在两处算出两个数」）。

**步骤 6｜规划数据**
- 工具按模型门控：`TaskCreate`/`TaskGet`/`TaskList`/`TaskUpdate` 或 `TodoWrite` 只在部分模型默认给出；适配器用 `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` 常开四件套。
- ⚠️ **冷存储下 `Task*` 必失败**：CLI 不建 `<configHome>/.claude/tasks/<sessionId>` 与其中的 `.lock`（工具对 ENOENT 未兜底，报 `ENOENT lstat '…tasks/<sessionId>'` → `EPERM mkdir '…/.lock.lock'`）⇒ 要用 `Task*` 就**必须先自己把这两级目录建出来**。
- 进度清单的**数据源是「整表」形态的调用**：`TodoWrite` 的 `{ todos: [{ content, status }] }` 会被归一成 `plan` 载荷（`kind:'plan'` + `steps[]` + `note:null`）。**适配器不做跨调用累积**（它无状态）：`Task*` 四件套是逐条 patch 的注册表，入参里没有 `todos` / `plan` / `steps` 任何一个键 ⇒ `family` 仍是 `task`，但 `payload` 记 `null`（消费方走通用工具行，进度面板如实显示「未使用进度清单」，不编一张表出来）。
- `TaskCreate` 的返回 id 从**携带 tool_result 的 user 消息**的 `tool_use_result` 里读结构化对象，不要从文本里正则提取。
- 工具入参的键名要认多个写法（`taskId` / `id` / `task_id`，`activeForm` / `active_form`）：CLI 只在执行前修这些名字，流里看不到修复结果。
- `deleted`（状态被删除）归 `unknown`：当 `completed` 是撒谎，当 `pending` 是它明明已被删除。

**步骤 7｜交互与计划模式**
- `AskUserQuestion`、`EnterPlanMode`、`ExitPlanMode` 三个工具**只在注册了 `canUseTool` 回调时才出现在工具表里**；不注册则连工具都没有。给了 `tools` 数组收窄能力时，必须把 `AskUserQuestion` 也列进去，否则提问能力直接消失。
- 自动放行模式（`bypassPermissions`、`acceptEdits`）会在回调之前解决调用 ⇒ 回调不会触发。要真正收到问题，改用 `PreToolUse` hook 拦截，或使用会走审批的权限模式。

**步骤 8｜工具族映射**
- 工具表项数由**模型与开关**共同决定（同一版本在不同模型与开关下取到过 23～30 项），族映射要按**工具名**做，不按数量。
- 子智能体工具是同一个东西的两种叫法：`system/init` 工具表与部分模型叫 `Task`，入站工具表与另一些模型叫 `Agent`（工具 schema 里的名字也是 `Agent`）。两个名字都要映射到同一族，不要按名字拆成两族。
- `Bash` 结果**没有结构化退出码**：失败时结果文本形如 `Exit code N`，从文本解析；成功时该格保持 `null`，不要填 0。
- 长输出会走持久化文件路径，工具结果里给的是路径而不是正文。

**步骤 9｜计量**
- 用量从 `result.usage` 取：`input_tokens`（不含缓存）、`cache_read_input_tokens`、`output_tokens`、`output_tokens_details.thinking_tokens`。**三项必填格缺任何一项 ⇒ 整格 `null` 并落一条 WARN**，绝不把缺的那格补成 0。`total` 恒 `null`（这家没有厂商自报的总量格）。
- 时延从 `result` 取：`duration_ms`、`duration_api_ms`、`ttft_ms`，来源标 `'vendor'`（三家只有这一家有 `apiMs` 与 `ttftMs`）。
- `thinking_tokens` 在 `usage.output_tokens_details` 里，该格可能整个缺失、也可能给 0：**0 不等于这家不思考**（兼容后端会把「上游没报」写成 0）⇒ 缺失记 `null`、读到 0 **照实记 0**（这一格是厂商原文），但不得据此断言「这家不思考」。`output_tokens` 已含思考量，归一后不要再做减法。
- **跑动期是估算**：按 `assistant.message.usage` 的同 `message.id` 后到覆盖再求和（侧链消息与缺 `message.id` 的直接不算，三项全 0 的快照当「还没填好」丢弃），标 `tokensEstimated: true` ⇒ 只进 `usage` 事件供界面显示，**绝不回写运行快照、也绝不进结果**；结算值一到，估算作废。
- **子智能体那一份**（`subagentTokens` / `subagentTurns`）与收益无关：见步骤 5.1，由收尾读盘交出。
- **`effort` 三档**：未选 ⇒ `effort` 与 `thinking` 两格都不出现；`off` ⇒ `thinking: { type: 'disabled' }` 且不传 `effort`，**外加 spawn 时经 `claudeExtraEnvFor` 注入 `CLAUDE_CODE_EXTRA_BODY`**（见 §3.6 / §8.1）；其余档位原样透传。注入点在 `startClaudeCode` 调 `buildSubprocessEnv` 的 `injected`（与 `CLAUDE_CODE_ENABLE_TODO_TOOLS` 同一个对象）。

### 4.2 codex

**步骤 1｜启动与路由**
- 用 **`@openai/codex-sdk`** 发起：`new Codex({ apiKey, baseUrl, config, env })` → `startThread(线程选项)` → `await runStreamed(提示词, { signal, outputSchema? })` → 迭代 `run.events`（异步生成器，逐个产出已解析的事件对象；`thread.id` 到首轮开始后才有值）。
- SDK 内部以 **`exec --experimental-json`** 形态驱动**它自带的那个可执行文件**：可执行文件由平台包解析而来（Windows x64 上是 `@openai/codex-win32-x64` 的 `vendor/<target-triple>/bin/codex.exe`），**提示词从 stdin 传入**，模型与开关经 `--config <点号键>=<TOML 字面量>` 注入。给了 `env` 就**不继承** `process.env`，必须自带完整环境。
- `CODEX_HOME` 的位置受可执行文件位置约束：可执行文件在工作区内时，`$CODEX_HOME` 也必须落在工作区内，否则进程起不来；可执行文件在工作区外时任意位置都行。scratch 目录（`TMPDIR` / `TEMP` / `TMP`）不要用系统临时目录。
- 模型 provider 的 `wire_api` **只有 `responses` 一个合法值**，写成 `chat` 会在启动阶段失败。

**步骤 2｜解析事件流**
- 事件类型共 **8 种**，由 SDK 声明的联合给出：`thread.started`（拿 `thread_id`）、`turn.started`、`item.started`、`item.updated`、`item.completed`、`turn.completed`、`turn.failed`、`error`。
- item 类型也是 **8 种**，由 SDK 声明的联合给出：`agent_message`（`text` 是正文）、`reasoning`（`text` 是**推理摘要**，不是正文）、`command_execution`（`command` / `aggregated_output` / 运行中省略的 `exit_code` / `status`）、`file_change`（`changes[]{path, kind}` / `status`）、`mcp_tool_call`（`server` / `tool` / `arguments` / `result` / `error` / `status`）、`web_search`（`query`）、`todo_list`（`items[]{text, completed}`）、`error`（`message`）。
- 多智能体的 `collab_tool_call` 会出现在事件流里，但**不在** SDK 声明的联合内（形状见步骤 5）。
- item 级 `error` 是**非致命告警**（例如"有无法识别的配置项"），不得当成运行失败；失败只认顶层的 `error` / `turn.failed`。
- **事件流不带时间戳**，也不带工具真名：命令类 item 只有 `command` 文本（工具真名 `exec_command` 只在会话文件里）⇒ 时间与工具真名都要从会话文件补。

**步骤 3｜读会话文件**
- 路径：`$CODEX_HOME/sessions/<年>/<月>/<日>/rollout-<ISO 时间>-<线程id>.jsonl`。
- 查找方式：在 `sessions/` 下**递归**找 `rollout-*-<线程id>.jsonl`（`MAX_SCAN_DEPTH = 8`，只递归目录、不跟符号链接），按**文件名末尾的线程 id** 匹配，不要按日期目录推算（跨午夜会找错目录）；判据用 `endsWith('-' + id + '.jsonl')` 而不是 `includes`（后者会让 `abc` 命中 `…-xabc.jsonl`）；多个候选取**排序后第一个**（ISO 前缀天然按时间有序，结果不依赖文件系统遍历顺序）。目录不存在 / 权限不足 / 走到一半被删都只是「没找到」，不抛。
- 逐行 JSON，外层 `type` 是 `session_meta` / `response_item` / `event_msg`，**语义由内层 `payload.type` 决定**（缺席时退回外层 `type` —— 两种外形都要认）。
- 行内另有 `timestamp`（ISO 8601，**只在外层**）、`ordinal`、`turn_id`（外层优先、内层兜底）三格；`timestamp` 只维护**首末两点**（第一条 / 覆盖最后一条，不取 min/max）——它是这一家**唯一**的时长来源。
- 第一条必是 `session_meta`：`id`（本线程 id，与文件名末段同值）、`parent_thread_id`（主线程为 `null`）、`source.subagent.thread_spawn.{parent_thread_id, depth, agent_nickname}`。**只有第一条 `session_meta` 生效**：fork 出来的子线程文件里还有一条**派发者副本**，让副本胜出会把身份、父链、昵称全部算到主线程头上。
- **只消费六种记录类型**（`reasoning` / `message` / `function_call` / `function_call_output` / `token_count` / `item_completed`），其余（`session_meta` / `task_started` / `task_complete` / `turn_context` / `world_state` / `token_usage_record` …）只说明「有个轮次被开过工」，**不落事件**。
- 解析要容错：空行跳过、坏行跳过**但计数**（`stats.badLines` 是「厂商换了行格式」的唯一早期信号）；行数上限 `MAX_LINES = 20_000`，到顶置 `stats.truncated` 并停读。
- 工具调用的真名与入参在这里：`function_call.name` / `arguments`（**JSON 字符串**，要自己解析，解析不了退回原串），`function_call_output` 按 `call_id` 与调用配对；`CommandExecution.command` 可能是数组也可能是单串。

**步骤 4｜补思考正文**
- 从 `Reasoning` 条目的 `raw_content` 拼出正文（`full`）；`raw_content` 为空时退回 `summary_text`（`summary`）；两者都空 ⇒ `text:null` + `textKind:'none'`。
- 事件流的 `reasoning` item 按厂商定义**只有摘要**，正文只在会话文件里 ⇒ 这一格的 `source` 记 `'session-file'`。
- `content` 为空（只有 `encrypted_content`）时**不回落 `summary`**：摘要是摘要，不是正文。

**步骤 5｜子任务**
- **种子**：事件流 `collab_tool_call.receiver_thread_ids` 给出**直接子线程 id**（`item.started` 时是空数组 ⇒ 那时不落行，也不编 id）；`prompt` 是派发任务原文，首行即名称。
- **递归发现（必须做）**：由子线程**自己派发**的那些线程，事件流一个字都不提——它们只写在**派发者自己的文件**里 ⇒ 从种子出发沿 spawn 链逐层展开（BFS，父在子前、同层按文件里的出现顺序）。下游有两种可识别外形：① 该文件的 `item_completed` 里 `CollabAgentToolCall.receiver_thread_ids`（厂商原生）；② 子线程 `shell` 出去起了另一个 codex 时，新会话 id 只出现在**CLI 启动横幅**里（`function_call_output.output` 与 `CommandExecution` 的 `stdout` / `aggregated_output` / `formatted_output`），横幅判据写窄（整行就是 `session id: <uuid>`，命中后小写归一）。
- **两条上限**：深度 `MAX_SPAWN_DEPTH = 8`、递归**自己发现到**的线程数 `MAX_DISCOVERED_CHILD_THREADS = 32`（种子是事件流点名的事实，**不占这个预算**）。判据是「**真的有**没走的分支」（要减掉已走过的），回指 / 互指不算截断；任一上限真的砍掉分支 ⇒ 记下是哪一条，**分量整格 `null`** + 点名 WARN。
- **旧会话排除**：`codex exec resume <id>` 会复用旧会话并打出同一条横幅。判据落在时序上——候选的 `session_meta.timestamp` **严格早于**派发者创建时刻 ⇒ 判为旧会话跳过（三种「判不出来」都**保留**：读不到 meta / 时间戳解析不动 / 派发者界缺失）。
- **父子链路**：子会话文件的 `session_meta.parent_thread_id` 给父线程，`thread_spawn.depth` 给深度，`thread_spawn.agent_nickname` 给名称。**父就是主线程时 `parentSubagentId` 记 `null`**（照抄主线程 id 会让消费方挂到一个不存在的父节点上）。
- **子任务行有两条来源**，读侧按 `subagentId` 覆盖累积：
  - **事件流（派发即落，`source: 'wire'`）**：身份 = `receiver_thread_ids` 的第一个非空串；名称 = `prompt` 首行；`kind` = `tool`；状态 = `agents_states[<子线程 id>].status`（**只认得出 `completed` / `failed`**，其余按 `running` + `statusMissing:'unverified'`——「还没跑完」与「这个取值我没见过」是两件事）；`outcome` = 同格的 `message`；`parentCallId` = **条目 id**（与派发调用块同值，是事件流内部的配对键）。
  - **会话文件（收尾与运行期读盘，`source: 'session-file'`）**：状态**没有可靠的终态字段**（hook 载荷里没有 `status`），只能用文件里的证据推——有 `AgentMessage` ⇒ `completed`，一条都没有 ⇒ `unknown` + `unverified`；`outcome` = 最后一条 `AgentMessage` 正文；`usage` = 该线程 `token_count` 的累计用量；`kind` 与 `parentCallId` 从**父**会话文件里那条协作条目配对取（按 `item.id` 与 `function_call.call_id` 配对，配不上记 `null`，**不拿条目号冒充**——两条通道的 `parentCallId` 因此是**不同的值**，各成一组、互不覆盖）。
- 子智能体轨迹同样来自会话文件：运行期**随主线程一起刷新**（见步骤 5.1），不是「等整段跑完才有」。
- **轮次分量**：该子线程会话文件里 `turnIds` 的个数；**只收「真的有内容」的轮**——桶里得有本模块消费的记录类型（fork 会把派发者那一轮的开工痕迹抄进子线程文件，只有痕迹的桶不算一轮，否则子线程轮次会多 1）。

**步骤 5.1｜读盘时机：运行期就要读，收尾再读一次补齐**

- **会话文件是 CLI 边跑边追加的**：每完成一个条目就多一行，随时都读得到已经发生的部分。两种时机**都要**，缺一个就有用户可见的空档：
  - **运行期（节流刷新）**：拿到主线程 id 之后才读。两道闸门：① **时间闸门** `CONTENT_READ_MIN_INTERVAL_MS = 500`（距上次读盘不足就不读）；② **同形重交节流** `SAME_SHAPE_REEMIT_MS = 3000`（块数与上次相同、内容变了 ⇒ 至多 3 秒交一次）。块数一变立刻交，与上次逐字段相同则不交。读到内容就把**整份折叠视图**交出去（消费方按 `mergeKey` / `subagentId` 覆盖累积，重发同一条是幂等的）。没有这一步，一整段 2–10 分钟的运行里抽屉**一个字都没有**——这一家是**唯一**内容只走会话文件的适配器，没有别的兜底。**不要**把「内容条数变了没」当闸门：它会把子线程刚出现的那一段整段跳过。
  - **收尾（结束时一次）**：正常完成 / 失败 / 被终止都要读（在释放之前、`finally` 里），用来补齐流关闭前后 CLI 写的最后几行。
- **半截行是安全的**：读取器逐行容错（坏行跳过并计数），最后一行写了一半时只丢那一行，下次刷新就补上 ⇒ 不需要任何「文件写完没」的判据。
- **找不到文件 / 读不出条目 = 这一次不交内容**，不是「采到了空」：原样保持上一次的投影，绝不交一份空消息列表把已经有内容的那一屏抹掉。
- 每次尝试的**线程 id 都不同**（`thread.started` 每次新发），故同一个 `$CODEX_HOME` 下历次尝试留下的多个 rollout 文件不会互相串：按线程 id 匹配只会命中本次那一份。
- 三条边界：**只读盘、不编造**（找不到就一条都不产出，绝不在失败的运行上造出「看起来跑过」的内容）；**不改结论**（读盘抛错只记日志，失败仍是失败、成功仍是成功）；**排在释放之前**（`dispose` 之后临时目录与句柄都没了）。
- 为什么失败时更要读：codex 的消息**只**从这条通道出（事件流缺工具真名、结构化入参与 `call_id` 配对键），不读就只剩一句失败归因——而「它失败前说了什么、调了什么」正是排障要看的东西。

**步骤 6｜计量与轮次**
- 事件流 `turn.completed.usage` 的字段集是五个：`input_tokens` / `cached_input_tokens` / `cache_write_input_tokens` / `output_tokens` / `reasoning_output_tokens`；**没有 `total_tokens`**——总量只在会话文件的 `token_count.info.total_token_usage` 里。三项必填格缺任一 ⇒ 整格 `null` + 一条 WARN。
- SDK 会把**缺失**的 `cache_write_input_tokens` 补成 `0`，所以该格为 `0` 不等于「厂商报过 0」；本仓不消费这一格。
- **`input` 必须减去 `cached_input_tokens`**（`input_tokens` 含缓存读，`cached_input_tokens` 是它的明细），并夹到非负；否则命中率会系统性低估。
- 会话文件的累计用量从 `tokenCounters` **逆序**找第一个三项齐全的 `total_token_usage`（事件流的账与文件的账是同一笔，谁更新由「至少一格更大、且没有一格更小」判定，相同则不重发）。
- 时间只能从会话文件行的 `timestamp` 首末两点算跨度，标 `'events'`；`apiMs` 与 `ttftMs` 保持 `null`，不要用跨度顶替。**时长与计量绑在一起**：只有拿到可用的累计用量时那条收尾 `usage` 事件才带 `timing`。
- **轮次（本行的 `turns`）**：**只数模型答复条目 `AgentMessage`** 的 `item.id`（去重），事件流与会话文件**两侧同改**（会话文件侧另按 `itemId` 去重）。**不要去数 `Reasoning`**：它只在会话文件里稳定可见，部分路由上事件流根本不投影它 ⇒ 两把尺子必然分叉（把轮次号系统性抬高）。本模块的消费类型集合（`TURN_ITEM_TYPES`，只含 `agent_message`）就是这条判据的落点。一次都没数到 ⇒ `null`，不编 0。
- **子智能体那一份**（`subagentTokens` / `subagentTurns`）：
  - **运行期**：`sub = Σ 各子线程累计用量`（截断或任一读不到 ⇒ `null`），合计 `combine(main, sub)`；三条件分支——合计拿得出来 ⇒ 合计与分量**一起**交；合计拿不出来但分量算得出 ⇒ 这一条不设计量（保持上一份）；分量本身读不出来 ⇒ 分量交**显式 `null`**（否则「主线程口径的合计 + 上一版非零分量」会让界面把主会话算小）。**运行期不交 `subagentTurns`**（那时 `turns` 只有主线程那一份，交了就会破坏 `subagentTurns ≤ turns`）。
  - **收尾**：`projected.usage` 本身**已经是主 + 子**的合计（不要再加一次分量，那会把子线程算两遍）；`finalTurns = lastTurns + (subagentTurns ?? 0)`；`finalTurns === null` 时分量也交**显式 `null`**（不留孤儿分量）。截断时三格一起退回主线程口径，并由那条点名整行的 WARN 说清。
- **`effort` 三档**：未选 ⇒ **不加键**；`off` ⇒ `modelReasoningEffort` 翻成 `'none'`（`codexEffortOf`，**一处映射**）**且** config 多一格 `model_reasoning_summary: 'none'`（**两格一起才可能关掉**，见 §3.6）；其余档位原样透传。落点是 `buildCodexConfig(baseUrl, input.route.contextWindow, input.effort === 'off' ? 'none' : undefined)`——**第三实参**，不许挤掉 `contextWindow`。
  ⚠️ **SDK 的类型面落后于 CLI**：`ModelReasoningEffort` 声明 8 档、**不含 `none`**，而 CLI 实测接受它 ⇒ 这一格用 `string` 传，**不能**把「类型面没有」当成「这家做不到」。
- **内容面与用量面共用同一份递归发现**：`discoverChildThreads` 在每个读周期**只发现一次**（节流闸门之内、收尾再一次），内容面与用量面共用一个可选的 `discovery` 入参 ⇒ **嵌套子线程也有自己的子任务行与消息**（判据：`Σ 各行 usage === subagentTokens`）。派发信息（`kind` / `parentCallId`）**按父线程**的转录取（`dispatchOf` 按父线程 id 记忆化）——只建主线程索引时那两格恒 `null`，而界面按 `parentCallId` 找派发点 ⇒ 那一行不可达。
- **读盘面：增量 + 分块**（不要重复读整份文件）：共用 `read-lines.ts`（claude 的同步分块读搬出来两家共用，支持 `offset` 续读与 `incompleteTail: 'skip'`）+ **run 作用域**的 `createCodexTranscriptCache()` / `createCachedTranscriptReader(cache, inner)`：**同一版本 ⇒ 零 IO**；**长了 ⇒ 只读新增那段**（合并进同一份解析态）；**变短 / 换过 ⇒ 整份重读**；冷路径仍走内层读者。`readTranscript(file)` 保持「整份读」的纯函数入口（末尾那段没有换行收尾的内容照解析），带缓存那条路对它用 `'skip'`（那一段可能是 CLI 写了一半的行）。
  内存事实：分块 + 增量消掉的是「整份文本 + `split('\n')` 数组」那 2–3×；**解析结果本身仍随运行增长**，上界是既有的 `MAX_LINES = 20_000`（不放开）。
- **行的累计与分量用同一条判据**（`totalUsageOf` / `normalizedTotalUsage`：从后往前找第一个三项齐的 `token_count`）——否则末条缺项时会出现「分量有值、这一行 `usage: null`」。

**步骤 7｜工具族与已知限制**
- 当前模型预设的工具表（`exec_command` / `write_stdin` / `request_user_input` / `view_image` / 多智能体命名空间 / `get_goal` / `create_goal` / `update_goal` / `web_search`）里没有文件读写类工具：`read-file` / `write-file` / `edit-file` / `search-content` / `list-files` **五族取不到值**，文件改动经 `exec_command` 承载（落在 `run-shell` 族）。该点随模型预设变化，实现按工具名归族即可，不要写死"这家没有文件工具"。
- 联网工具在本仓配置里被关掉（`tools.web_search=false`）⇒ `web-search` 族同样取不到值。
- 工具真名（`exec_command` / `spawn_agent` / `wait_agent` 等）只在会话文件里；事件流只有派生**条目名**（`command_execution`、`collab_tool_call`），不要把它当工具名。
- `request_user_input` 在 exec 路径不可用：它出现在工具表里，但调用会被拒 ⇒ 该族记 `outcome: 'unavailable'`。
- 规划工具 `update_plan` 需要显式开启（`tools.update_plan.enabled=true`）才出现在工具表；它在事件流里落成 `todo_list` 条目，载荷是 `{ text, completed }` **二态**，恢复不出 `in_progress`，该态一律 `unknown`。

**步骤 8｜多智能体开关**
- **`features.multi_agent = true`（必须开）**；写在 `tools.` 前缀下会被忽略。理由：子智能体是评测面之一（另两家默认可用），而**关掉换不来「安静地没有子任务」**——`spawn_agent` 会变成一次**失败的工具调用**（token 花了、轮次占了、工具结果里躺着配置提示），事件流里连 `collab_tool_call` 都没有 ⇒ 子任务面板**恒空**。
- 能力随路由翻转：同一条 `spawn_agent` 调用，某些自建网关路由会判 `unsupported call`，带工具列表的请求也可能被网关整体拒绝；另一条路由上整条派发链（`spawn_agent` → `wait` → `close_agent`）跑得通。**模型名是否被该版本认识不是决定因素**。被拒时的表现是「模型调了、被拒」，事件流里有那条失败的工具结果 ⇒ 界面据此说「派发被路由拒绝」，而不是「没派子任务」。
- ⇒ 必须把路由与模型名记为能力声明的前提：同一份能力位在不同路由下取值不同，不得把某一条路由上的取值写成这家的固有属性。

**多智能体条目的形状与投影**（`collab_tool_call`）：
- 它在 `item.started` / `item.updated` / `item.completed` 三种事件里都出现，且**不在 SDK 声明的 item 联合里**：`{ type:'collab_tool_call', tool:'spawn_agent'|'wait'|'close_agent', sender_thread_id, receiver_thread_ids:[子线程 id], prompt, agents_states:{<子线程 id>:{status, message}}, status? }`。
- **`item.started` 时 `receiver_thread_ids` 是空数组**（子线程还没建）⇒ 只在拿到 id 时才落子任务行，
  **不编一个 id**（「还没建」与「建了没给 id」在数据上分不开）。
- **一条子任务会来多条协作记录**（spawn → wait → close），每条都带同一个 `subagentId`
  ⇒ 派发点只能由**派发动作**（`spawn_agent` 这类）认领，不能先到先得（否则入口挂到「收场」那一步上）。
- **派发调用也要落一条消息**：界面上「进入子任务」的入口挂在派发工具调用上，
  只交子任务行、不交调用 ⇒ 占位条画不出来。事件流这一侧没有会话文件的 `function_call.call_id`，
  故**以条目 id 作为配对键**（调用块与子任务行两侧同值即可配对）。
- 终态取 `agents_states[<子线程 id>].status`；**只认得出 `completed` / `failed`**，
  其余按「还在跑」处理并把没验证过的取值标 `statusMissing:'unverified'`。
  收尾读子线程会话文件会交出更完整的同 `subagentId` 记录（`outcome`、真实用量、父链），读侧按身份覆盖。

### 4.3 dsh

**步骤 1｜建会话**
- 用 Harness 类建会话并订阅通知；协议类型（openai 兼容 / anthropic 兼容）与模型在路由配置里给。
- **本行的路由 patch 要一次写全三件事**：① 路由与档位键；② `- insert: [{ id: tool-ask-user, name: '@deepseek-ai/dsh-tool-ask-user' }]`——`dsh-base` 与 `dsh-sdk-app` 两个 bundle **都不带**它，不加就没有问答工具（包已随 dsh 装好，**不需要**改 profile 的 `dependencies`）；③ 关联网时 `- id: tool-web` + `config: { search: false, fetch: true, searchTimeoutMs: 60000 }`（三格缺一就被整份替换 + schema 默认值改回去，见 §8.1）。**落点是每行的 `DSH_HOME/profiles/sdk/cordis.patch.yml`**——适配器只建空 `.agenthome`、profile 由 dsh 播种，**改全局 `~/.dsh` 对评测无效**。
- 通知共四种 method：`session.event`（具体事件）、`session.status`（会话级状态）、`subagent.started`、`subagent.finished`。前两种的 `params.sessionId` 标出事件属于哪个会话——**子会话的事件也在同一条流里**，带的是子会话自己的 id；后两种是顶层通知，不套在 `session.event` 里。

**步骤 2｜块协议**
- 消息块取自 `assistant/message` 的 `data.message.content[]`：`text` / `reasoning` / `tool-call` 三种，**一条消息就是一次完整快照**（三条消息草稿恒 `chunk:'snapshot'`，块也恒 `snapshot`）。空内容或一个块都没有 ⇒ 不产消息。
- 块序号在**每条 `assistant/message` 内**顺序分配（`index = blocks.length`）；它与 `data.stream[]` 里的 `chunk.index` 是**两个空间**，不要混用。
- **`data.stream[]` 那条增量通道当前没有取数实现**：`chunk:*`（`block-start` / `text-delta` / `reasoning-delta` / `tool-call-delta` / `block-end` / `usage` / `finish`）与 `*-chunks`（`text-chunks` / `reasoning-chunks` / `tool-call-chunks`）两族条目都不解析，落到「未识别事件」那条保留原始负载的 `log`。⚠️ 其中 **`reasoning-delta` 这条路由根本不产出**（推理整块在 `block-end` 到达）⇒ 不要为它写等待逻辑。能力位 `streamingDelta` 与实际不一致，见第 7 章。
- **思考没有逐字增量**：推理正文整块到达 ⇒ 思考按整块渲染，不要等逐字增量；主任务与子任务同理。

**步骤 3｜归一消息**
- **`assistant/message`**：`data.message.content[]` 给块，`data.usage` 给该次往返用量（**同时摊到这条消息的 `usage` 上**，见 §3.2），`data.turn` / `data.step` 给厂商轮号与该会话自己的步号。
- **消息信封的两个号**：`roundTrip` 取 `data.step`（**该会话自己的**，不是本行全局累计——否则主会话时间轴会出现 `1,2,5,6` 的洞），`vendorTurn` 取 `data.turn`；`usage` 事件的归属键同刻带 `(sessionIdProfileSubagent(sessionId), data.step)`（见 §2.6）。**`state.turns` 照旧全局自增**（`EvalRow.turns` 与「主 + 全部子」的口径靠它），两者不得互相顶替。
- `tool/call` 给 `callId` / `name` / `arguments`（`arguments` 是 **JSON 字符串**，要自己解析）；`tool/result` 给 `message.{toolCallId, content[], isError}`，另有 `error?` 与 **`meta`**——**结构化结果在 `meta` 里**（`content[]` 只是给模型看的那份文本）。
- 块类型是 `reasoning` / `text` / `tool-call`，且 `reasoning` 块**也带 `text` 字段** ⇒ 取值必须先按 `type` 过滤，绝不按 `text` 字段取值（否则推理正文会混进最终答复）。

**步骤 4｜子任务**
- **身份三级兜底**：`subagentId` → `agentId` → `childSessionId`（三个名字指的是同一个东西，哪一格有值随版本与通道而变）。**只认后两个会让一条子会话消息都归不到**（本机载荷只有 `subagentId` / `vendorId` / `parentSessionId`），而多登记一个不存在的 id 是无害的。三个候选名都登记进「哪些会话是子会话」的表，消息据此归到子任务上；`parentSessionId` 另进一张**否决表**（防止把主会话的消息认成子智能体的）。
- **订阅必须放行整棵会话树，不是只放行主会话**：子会话的 `session.event` 与主会话在**同一条通知流**里，`params.sessionId` 是**子会话自己的 id**；判据写成「只放行主会话那个 id」会把子智能体的 `assistant/message` / `tool/call` / `tool/result` **全部丢掉**（抽屉里占位条在、点进去一个字都没有）。放行三条：**不带会话归属的顶层通知一律放行**（`subagent.started` / `subagent.finished` 没有 `params.sessionId`，而它们是子会话 id 的**唯一来源**）；本会话的事件放行；**已登记的子会话**的事件放行。
- **名称与类型**：另一条会话事件 `subagent/catalog` 给 `childId` / `createdAt` / `mode`（`one-shot` / `continuable`）/ `label?`；**`provider` 不在 catalog 里**，只在 `subagent.finished` 上。catalog 可能先于 start / finish 到达 ⇒ 要按 `childId` 记住（它**不产任何事件**，只登记），否则收场时名字只能填 `null`。名称取 catalog `label`，类型取 catalog `mode`（收场时 `provider` 优先）。
- **`subagent/descriptor` 不得当身份来源**：它的 `data` 里**没有 `childId`**（身份只在信封的 `params.sessionId` 上），而且**不是逐子任务必发**（三个子任务可能只到两条）⇒ 身份只能取自 `subagent/catalog` 或顶层通知；名字与类型可以取它，身份不行。
- **终态用两格合读的映射表**（`status` × `stopReason`）：`ok`+`completed` ⇒ `completed`；`ok`+`max-tokens` ⇒ `failed`（字面「成功」实为被输出上限截断）；`error`+`aborted` ⇒ `stopped`（字面「失败」实为主动取消）；`error`+`error` ⇒ `failed`；其余组合（含未观测的 `refusal`）⇒ `unknown` + `statusMissing: 'unverified'`，**不猜**。**硬规则：只要 `stopReason !== 'completed'`，一律不得记成 `completed`**——`status` 这一格两个方向都会骗人，必须两格一起读。
- 结果摘要取 `subagent.finished` 载荷里 `lastAssistantMessage` 的 `type='text'` 块（非空块按换行拼接）；取消场景可能只有 `reasoning` 块，此时 `outcome` 保持 `null`，不得拿推理顶替。
- **`parentCallId` 与 `parentSubagentId` 都记 `null`**：通知载荷里没有可对齐的调用 id（`subagent` 工具调用的 `callId` 是 `call_…|<uuid>` 复合形状，与身份不是同一个值），也没有父 id。界面因此退化为「派发工具入参里的任务名 == 子任务名」逐字相同才认派发点。
- 子智能体轨迹直接从通知流里取（`params.sessionId` = 子会话 id）；运行时被强制终止时不会收到 `subagent.finished` ⇒ 面板必须能显示「未收场」。
- 归属键没有工具调用 id，只有会话 id 层级；跨家比较时不要把它当「调用级」归属。

**步骤 4.1｜子智能体那一份用量与轮次（按子会话分组求和）**

- **为什么按白名单求和**：按会话记的两张表（用量 `sessionUsage`、轮次 `sessionTurns`）是**模块级**的——同一个 Node 进程里并行跑着好几行，主会话之外还有**别的行**的会话。只有「本行的子会话白名单」能把这一行圈出来（白名单来自通知流：`subagent.started` / `finished` 的身份）。
- **用量分量** = Σ 白名单里各子会话的 `assistant/message.data.usage`（三项必填格齐才累加，缺项整条丢弃并落 WARN）。三档：
  - 白名单为空 ⇒ `{0,0,0}`（**确实没有**，不是 `null`）；
  - 子会话**已收场却一条用量都没报** ⇒ `null`（事实缺失）；
  - 仍在跑的子会话 ⇒ 按「到目前为止」计入。
- **轮次分量** = Σ 白名单里各子会话的 `step/start` 计数，三档与用量**逐字相同**（同一份白名单、**同一个**事实缺失谓词 `dshSilentChildSessions = 白名单 ∩ 已收场 − 有用量`）。两格由**同一条 `step/start`** 驱动（合计 `turns` 全局自增的那一行旁边就记这一格），故 `subagentTurns ≤ turns` 是构造上的。判据取「有没有报到用量」而不是「有没有 `step/start`」：后者是**第二个谓词**，会与用量那一格分歧（一个子会话报了用量却没有 step 时，两格会一格有数一格 `null`，而 WARN 只说得清其中一格）。
- **两条出口**：
  - **带分量的三条事件出口**（`step/start`、`assistant/message`、`turn/end`）**都同时带两格**——否则会出现「上一版的非零用量分量 + `null` 的轮次分量」这种两句互相矛盾的话摆在同一格上；
  - **收尾（`finalize`）也交一次**：`usage` 事件的发射门槛是**轮次**，而「子会话收场却没用量」这个结论是在**不带轮次**的 `subagent.finished` 上成立的 ⇒ 那一轮之后再没有消息时结论就送不出去。收尾每次运行都跑，且分量的**显式 `null` 会覆盖**旧值。
- 分量走 `null` 时**必须点名**：WARN 文案列出那些「已收场却没有用量事件」的子会话 id，并说清「tok 与轮次的分量都给不出（不编造、不填 0），合计仍是已观察到的全树读数」。`{0,0,0}` / `0` 那一档（确实没有）**不刷噪声**。
- 累加**没有去重键**（这一家从不写 `state.seen`）：唯一的去重是 `usage` 事件的发射门（与上次逐字段相同就不发），它只决定「要不要发这条事件」，不改已累加的值。
- 合计 `tokens` / `turns` 与另两家不同源：它由适配器**逐条无条件累加**得到（不是「主 + 子」拼出来的），所以「读失败时退回主会话口径」这条**机制**在这一家不成立——已经并进来的别的子会话用量退不回去。三家的共同保证因此落在另外两条上：① 分量一律 `null`（界面据此一律退回一行）；② `subagentTokens ≤ tokens` 照旧成立。

**步骤 5｜容错与状态**
- 权限与审批类事件（`approval/asked`、`approval/decided`、`approval/policy`、`permission/preset`、`sandbox/mode`）至少投影成 `log` 行，不要静默丢弃：无人值守的运行里审批不会被应答，这些行是排障的唯一线索。
- 任何未识别的事件也要投影成一条 `log`，保留原始载荷。
- **有意不投影的清单**（与上面两条分开，它们落盘只增噪声，**既不落 `log` 也不落 attachment**）：`session.status`（会话级状态通知，与轮次语义无关）、`data.stream[]` 的两族增量条目（`chunk:*` 与 `*-chunks`，当前没有取数实现）。
- **`turn/end` 的失败投影**：`reason.kind === 'error'` ⇒ 落一条 `error` 行级事件；`turn/start` / `turn/end` 同时是轮次边界（归属键见 §2.6）。

**步骤 6｜计量**
- 用量在 `assistant/message` 的 `data.usage`：`inputTokens`（**不含**缓存，直接当 `input`）/ `cacheReadTokens`（当 `cached`）/ `outputTokens`（当 `output`，已含思考量）/ `totalTokens`（厂商自报总量，只作参考，不参与归一后的加和）。**三项必填格缺任一 ⇒ 整条不计入并落一条 WARN**，绝不填 0。
- 累加**不清零**：三项逐条相加；`reasoningOutput` 读到才相加（一格都没读到才是 `null`）；`total` 是累计快照 ⇒ **只覆盖、不相加**。
- `cacheWriteTokens` 不进 `cached`：缓存**写**不是缓存**读**，把它算进命中率会得出「第一轮就命中」的假象。
- `reasoningTokens` 在类型上存在但当前通道不写这一格 ⇒ 记 `null`（该格能力位记 `not-projected-by-vendor`），不要用 `outputTokens` 去凑。
- 时间从会话事件的 `time`（毫秒）算，标 `'events'`（`apiMs` / `ttftMs` 恒 `null`）；只认三处带时间的通知（`turn/start` / `assistant/message` / `turn/end`）。
- **轮次**：`step/start` 每来一条记一次（**唯一计数点**，不分会话 ⇒ 合计天然是全树的）；消息信封上的 `roundTrip` 取「已数到的轮次数」，一次都没数到时给 1（信封这一格是必填正整数）。
- **子智能体那一份**（`subagentTokens` / `subagentTurns`）见步骤 4.1：按本行子会话白名单分组求和，与合计同刻成对交出。

**步骤 7｜工具族与路由 patch**
- 工具表约 25 项；五类文件工具（`read` / `write` / `edit` / `grep` / `glob`）都有结构化结果，落在 `tool/result` 的 `meta` 里：`read` 给 `{lines[], totalLines}`、`grep` 给 `{shape:'matches', files[], total, truncated}`、`glob` 给 `{shape:'paths', paths[], truncated}`、`write` 给 `{operation, diffs[]}`、`edit` 给 `{diffs[{path, oldText, newText}]}`。**写文件的字节数拿不到**，`edit` 的替换处数也拿不到 ⇒ 这两格保持 `null`；有 `meta` 就不要退回去解析文本。
- `pwsh` 的结果**没有 `meta`**：退出码只在文本尾部的 `[exit code: N]` 里，成功时不带这个尾部 ⇒ 该格保持 `null`，不要填 0。
- 关闭联网工具时，路由 patch 是**整份替换**语义：只写要改的那一格会把同组的其它键抹掉，随后被 schema 默认值悄悄改回。必须把该组的全部键一次写全。

**步骤 8｜交互**
- `ask_user_question` 可用；无人应答时工具结果 `isError` 为真，文本形如 `Error: no user-questions answerer accepted the request` ⇒ 该族记 `outcome: 'unavailable'`，不要当成用户拒绝。子智能体内不可发起提问（该限制在另两家同样成立），调用会被拒并给出说明调用方归另一个智能体所有的文案。

---

## 5. 工具族与面板投影

### 5.1 分族规则

族名由**工具名**决定，不由家决定。归不进任何一族的工具，`family` 记 `null`，并在 `name` 里保留原名（消费方对 `null` 走通用渲染）。

**渲染侧的硬约束**：UI **只按 `family` 分支，永不按 `name` 或 `agentKind` 分支**（按名字分支等于把厂商适配搬进界面，工具表一改就静默失效）。

| 族 | 命中条件 | 归一入参 | 归一结果 |
|---|---|---|---|
| `read-file` | 读单个文件 | `path`、可选 `offset`/`limit` | `totalLines`（有则填；**行数取它，不要用行号最大值**——那会系统性多算 1 行）、`lineNumbersIncluded`（厂商已带行号 ⇒ `true`，UI 不得二次编号）、`kind`（`text`/`image`/`pdf`/`notebook`/`unknown`）、`mediaType`、`bytes`、正文 |
| `write-file` | 新建/整体写入 | `path`、`content` | `created`（新建 / 覆盖）、`bytesWritten`（拿不到则 `null`） |
| `edit-file` | 局部替换 | `path`、`edits[]`（每项 `{oldText, newText, replaceAll}`） | `applied`、`replacements`（拿不到则 `null`；整体替换模式下数量不可知）、`diff`（厂商给了就用厂商的，比我们自己算准） |
| `search-content` | 内容检索 | `pattern`、`caseInsensitive`、`mode`（`content`/`files-with-matches`/`count`/`null`）、可选 `path`/`glob` | `matches[]`（`{file, line, text}`）、`fileCount`、`matchCount`、`truncated`（`mode` 与 `truncated` 一起决定 UI 是列命中还是给「命中已存到另一个文件」的路径） |
| `list-files` | 文件名匹配/列目录 | `pattern` 或 `path` | `files[]`、`count`、`truncated` |
| `run-shell` | 执行命令 | `command`、可选 `shell`/`cwd`/`timeoutMs` | `exitCode`（拿不到则 `null`）、`stdout`、`stderr`、`status`（`completed`/`failed`/`running`/`unknown`）、`outputPath`（长输出只给路径时填，UI 据此渲染「输出已存至 `<path>`」而不是「输出就是这些」）、`truncated` |
| `web-search` | 联网检索 | `query`（dsh 给的是复数 `queries[]` ⇒ 取首个进 `query`，其余进 `raw`） | `results[]`（`{title, url, snippet}`）、`answer`（有的家给一句总结） |
| `spawn-agent` | 派发子智能体 | `prompt`、可选 `name`/`agentType`/`forkTurns`（`none`/`all`）/`model`/`background` | `subagentId`、`vendorId`、`outcome`（子任务最终答复的摘要，供工具卡片直接显示） |
| `task` | 进度清单维护 | 整表替换或逐条 patch | `steps[]`（`{id, subject, status, owner?, blockedBy?}`）、`counts`（`{pending, inProgress, completed}`，派生值放载荷里、UI 不必自己算）、`source`（`'tool'` = 取自工具入参 / `'event'` = 取自事件流条目，**必须标**，否则消费方看不出这份清单的实时性与可比性） |
| `ask-user` | 向用户提问 | `questions[]`（`header` ≤ **8** 字符、选项 **2–4** 个、`multiSelect` 默认 `false` —— 三家取**更严**的那一档） | `answers[]`（`{questionId, selected[], custom}`）、`outcome` ∈ `answered`/`auto-resolved`/`skipped`/`timeout`/`unavailable`/`rejected`/`canceled` |

归一结果里取不到的格一律记 `null`，不得用 0 或空串顶替。唯一例外是 `truncated`：契约里它是布尔，拿不到截断标记时只能记 `false`，消费方**不得**据此断定输出完整。

**后两列与原始载荷的关系**：后两列是**适配器要从厂商原文里取到的事实**（例：codex 的 `cmd` 与 claude 的 `command` 都归到 `command` 一格），取不到就 `null`；`input` / `structured` / `raw` 里的**原始载荷照旧原样保留**，两者并存——归一字段供渲染与统计，原始载荷供排障与「形状没覆盖到」时的兜底。工具名**一律不硬编码**：`name` 原样透传，`family` 只做映射（厂商改名单、加名单都不影响契约）。

**三态显示口径**（对每一族的归一结果都成立）：`ok: true` 但关键字段是 `null` ⇒ **不显示为成功**，标「未采集」。`textKind` 可以渲染，但**不得据它回推厂商**。

**问答族的消费方义务**（`ask-user`）：答案以 `header` 为配对键（`selected[]` 装的是**选项标签**，不是 id / 下标）；`custom`（自由输入）在**多选**时是**追加**（标签与自由输入都显示）、在**单选**时是**覆盖** `selected`——**不得一律追加**（单选会同时显示两个答案）。收场方式七态：`answered` / `auto-resolved` / `skipped` / `timeout` / `unavailable` / `rejected` / `canceled`，**必须按 `outcome` 呈现**，不得假设三家都会挂住或都会收场（dsh 阻塞且没有超时预算、codex 自动决议、claude 有超时与 AFK）；`recommended` 置顶、`allowOther` 追加自由输入入口；子智能体内一律不能提问。

### 5.2 三家工具名 → 族

| 族 | claude-code | codex | dsh |
|---|---|---|---|
| `read-file` | `Read` | — | `read` |
| `write-file` | `Write` | — | `write` |
| `edit-file` | `Edit`、`MultiEdit`、`NotebookEdit` | — | `edit` |
| `search-content` | `Grep` | — | `grep` |
| `list-files` | `Glob`、`LS` | — | `glob` |
| `run-shell` | `Bash`、`PowerShell` | `exec_command`（工具真名，只在会话文件）/ `command_execution`（事件流里的命令**条目**名，不是工具名） | `pwsh` |
| `web-search` | `WebSearch`、`WebFetch` | `web_search` | `web_search`、`web_fetch` |
| `spawn-agent` | `Task` / `Agent`（**同一工具的两种叫法**，谁叫哪个随模型与工具表档位变；两个名字都映射到本族） | `spawn_agent` | `subagent`、`subagent_fork` |
| `task` | `TaskCreate`/`TaskUpdate`/`TaskList`/`TaskGet` 或 `TodoWrite` | `update_plan`（工具；在事件流里落成 `todo_list` 条目） | `todo_write` |
| `ask-user` | `AskUserQuestion` | `request_user_input`（在工具表里但调用被拒） | `ask_user_question` |

`mcp__<server>__<tool>` 这种形态**刻意不进任何族**（`family` 记 `null`，`name` 保留原名）：它是外部工具，归进十族里的任何一族都会让那一族的统计混进别人的数据。

codex 的 `family` 判定补充：事件流的 `command_execution` 条目一律落 `run-shell`（该条目的 `aggregated_output` 是 stdout 与 stderr **合流**，拆不开 ⇒ 归一结果里 `stderr` 记 `null`；`exit_code` 在运行中省略 ⇒ 记 `null`）；文件类五族在 codex 上取不到值（当前模型预设没有这些工具，文件改动经 `exec_command` 承载）。`collab_tool_call` 落 `spawn-agent`；其余条目与工具（`write_stdin` / `view_image` / `wait_agent` / `close_agent` / `send_input` / `resume_agent` / `get_goal` / `create_goal` / `update_goal`）不属这十族 ⇒ `family` 记 `null`，`name` 保留原名。

**codex 的多智能体工具名有两套，随模型预设选中的 multi-agent 版本变**：V1 档 `spawn_agent` / `wait_agent` / `close_agent` / `send_input` / `resume_agent`；V2 档 `send_message` / `followup_task` / `interrupt_agent`（V2 **没有** `close_agent`，续跑改用 `followup_task`，且只接受 V2-capable 的预设、其余直接报错）。**两套名字都要认，一律不得硬编码**——归族与「哪次调用是派发」都建在名字上，硬编码一套会在另一档上静默失灵。名字本身随版本演进也不影响契约：`name` 原样透传（见 §5.1 末）。

**名字是否出现由各家的配置与模型决定，不影响映射本身**：

- claude-code：`MultiEdit`、`LS`、`PowerShell` 在**当前工具表里不出现**（保留映射以兼容工具表变化，不表示当前会出现）；`Task*` 与 `TodoWrite` 二选一（设 `CLAUDE_CODE_ENABLE_TASKS=0` 时才换成 `TodoWrite`）；`AskUserQuestion` 要注册 `canUseTool` 回调才出现；`WebSearch` 在本仓**无条件禁用**（不分模型名），`WebFetch` 不受此限——**`web_fetch` 不属于「搜索」**，本仓只禁搜索。
- codex：`update_plan` 需显式开启（`tools.update_plan.enabled=true`）才出现在工具表；`web_search` 在本仓配置里被关掉（`tools.web_search=false`）；`request_user_input` 在工具表里但调用被拒；多智能体命名空间需 `features.multi_agent=true`。
- dsh：`web_search` / `web_fetch` 是否可用取决于该行的路由 patch（关闭联网工具时是整组键的替换语义：只写要改的那一格会把同组其它键抹掉）。

### 5.3 `task` 族的合并语义

**适配器不做跨调用累积**：`tool-call` 块上的 `payload`（`kind: 'plan'`）就是**本次调用之后的整张清单**，跨快照的差分是消费方的事。三家的入参形状不同，归一只有一处：

| 家 | 入参形状 | 归一 |
|---|---|---|
| claude-code | `TodoWrite` 的 `{ todos: [{ content, status }] }`（**整表**）；`Task*` 四件套是逐条 patch 的注册表，入参里没有清单键 | `payload.kind='plan'`，`subject` ← `content`；`Task*` 的调用 ⇒ `payload: null`（面板取不到数据，如实显示「未使用进度清单」） |
| codex | `update_plan` 的 `{ explanation?, plan: [{ step, status }] }` | `subject` ← `step`，`note` ← `explanation`；载荷是 `{ text, completed }` **二态** ⇒ 恢复不出 `inProgress`，记 `unknown`；条目**没有 id** ⇒ `steps[].id` 只能是 `null`（**不自己发号**） |
| dsh | `todo_write` 的 `{ todos: [{ content, status }] }`（**整表**） | `subject` ← `content` |

状态四态：`pending` / `inProgress` / `completed` / `unknown`。厂商取值归一到这里（认 `in_progress` / `inProgress` / `pending` / `todo` / `completed`，外加 `completed: true` 写法），其余（含 claude 的 `deleted`）落 `unknown`——当 `completed` 是撒谎，当 `pending` 是它明明已被删除。`unknown` 是**独立的一档**（既不是待办也不是完成），面板必须能显示它。

`owner` / `blockedBy` 只有 claude 会提供（它的 `Task*` 是工作项注册表），另两家恒 `null`；`blockedBy` 认不出时记 `null`（「这家没有这个概念」），**不是空表**（那是「有概念、当前没有依赖」）。`subject` 与 `header` 是唯一两个「厂商给了空串就保留空串」的格（其余缺格一律 `null`）。

### 5.4 面板①：进度清单

- 数据来源：`task` 族 `tool-call` 块上的 `payload`（`kind: 'plan'` 的 `steps[]`），取**最近一条**。
- 渲染：按 `status` 分组——`pending` / `inProgress` / `completed` 各一组，**外加 `unknown` 一组**（不得并入任何三态组）。
- `owner` / `blockedBy` 有则显示；`steps[].id` 拿不到就是 `null`，**不要按序号编一个**——编出来的 id 会让依赖看起来解析成功了。
- 缺失处理：本次运行没有任何带 `payload` 的 `task` 族调用（例如 claude 只用了 `Task*` 注册表）⇒ 面板显示「未使用进度清单」，不要显示空表头。

### 5.5 面板②：派发视图

每个子任务一行。每格的取值路径：

| 字段 | claude-code | codex | dsh |
|---|---|---|---|
| `subagentId` | `task_started.task_id`（**只有过了形状判据的才产行**） | 子线程 id（`collab_tool_call.receiver_thread_ids` 的元素，与会话文件名末段同值） | 身份三级兜底：`subagentId` → `agentId` → `childSessionId`（与随后子会话事件的 `params.sessionId` 同值） |
| `name` | `task_started.description` | 事件流：`prompt` 首行；会话文件：`thread_spawn.agent_nickname` | catalog `label` |
| `kind` | `task_started.subagent_type` | 事件流：`collab_tool_call.tool`；会话文件：**父**会话文件里那条协作条目的 `tool` | catalog `mode`（收场时 `provider` 优先） |
| `status` | `task_notification.status`（还没收到通知时记 `running`；终态是原生字段 ⇒ `statusMissing` 恒 `null`） | 事件流：`agents_states[<子线程 id>].status`（只认 `completed` / `failed`，其余按 `running` + `unverified`）；会话文件：有 `AgentMessage` ⇒ `completed`，否则 `unknown` + `unverified` | `status` 与 `stopReason` 两格合读（四行映射表），未覆盖的档记 `unknown` + `unverified` |
| `outcome` | `task_notification.summary` | 事件流：`agents_states[<子线程 id>].message`；会话文件：最后一条 `AgentMessage` 的正文 | `subagent.finished` 载荷里 `type='text'` 的块（取消时可能没有 ⇒ `null`） |
| `usage` | **读 CLI 转录**：该子智能体的 `agent-<agentId>.jsonl` 按 `message.id` 去重后求和；读不到 ⇒ `null`（`task_notification.usage` 是异形，不采用） | 子线程会话文件 `token_count` 的累计用量（三项缺任一 ⇒ `null`） | 子会话 `assistant/message` 的用量按 `params.sessionId` 分组求和（已收场却无用量 ⇒ `null`） |
| `parentSubagentId` | 深度 ≥ 2 时取**消息**上的 `parent_agent_id`；深度 1 时该格为 `null`（与主会话不可区分）⇒ 记 `null` | 子会话文件 `session_meta.parent_thread_id`（`thread_spawn.depth` 给深度）；**父就是主线程时记 `null`**——照抄主线程 id 会让消费方挂到一个不存在的父节点上（表现：进子任务后面包屑没有「主会话」那一段） | `null`（真机通知不带父 id） |
| `parentCallId` | `tool_use_id`（与子消息上的 `parent_tool_use_id`、派发工具调用块的 `id` **三者同值**） | 事件流：**条目 id**（与派发调用块同值）；会话文件：**父会话文件里那条协作条目的真 `call_id`**——两条通道的值不同，各成一组 | `null`（载荷里没有可对齐的调用 id ⇒ 不猜） |
| 轨迹 | 子智能体消息直接出现在主流里（带 `parent_tool_use_id`，文本与思考块由 `forwardSubagentText` 转发） | 读子线程会话文件（消息、工具调用、推理）；与主线程**同一次刷新**，运行期就能看到已完成的部分 | 子会话事件在同一条通知流里（`params.sessionId` = 子会话 id） |

渲染要求：

- **身份**用 `subagentId`；名称缺失时显示身份前 8 位，不要显示 `null`。
- **状态**：契约五态 `running` / `completed` / `failed` / `stopped` / `unknown`；界面另有一种显示值「**未收场**」（运行期被终止、`finished` 永不到达），它不是契约取值。厂商原始状态先归一到五态再进面板。`statusMissing` **非 `null`** 时显示「状态未采集」，同时显示最后一次状态快照（`null` = 状态已采集）。
- **轨迹**：codex 的子智能体轨迹来自子会话文件（消息、工具调用、推理），与主线程在**同一次节流刷新**里读出来（步骤 5.1）⇒ 运行期就能看到已经完成的那部分，不必等整段跑完。
- **层级**：父链可得时缩进显示；父链不可得时全部平铺，不要用"派发顺序"推测层级。

### 5.6 两轴分类（统计与比较）

`family`（§5.1）服务**渲染**，`action` × `target` 服务**统计与比较**：后者覆盖**全部**工具，含没有族的那些。两者**不合并**——`run-shell` 与 `read-file` 在渲染上毫无共同点，在"用了什么工具"的统计上只是两个 `(action, target)` 组合。

```ts
type ToolAction = 'read' | 'write' | 'edit' | 'search' | 'list'
                | 'execute' | 'send' | 'spawn' | 'stop' | 'wait'
                | 'query' | 'resume' | 'deliver';
type ToolTarget = 'file' | 'image' | 'notebook' | 'shell' | 'process'
                | 'agent' | 'job' | 'goal' | 'task' | 'web'
                | 'worktree' | 'skill' | 'user';
```

| 工具（家） | action | target |
|---|---|---|
| `Read`(cc) · `read`(dsh) | `read` | `file` |
| `read_image`(dsh) · `view_image`(codex) | `read` | `image` |
| `Write`(cc) · `write`(dsh) | `write` | `file` |
| `Edit`(cc) · `edit`(dsh) · `NotebookEdit`(cc) | `edit` | `file` / `notebook` |
| `Glob`(cc) · `glob`(dsh) | `search` | `file` |
| `Grep`(cc) · `grep`(dsh) | `search` | `file` |
| `Bash`(cc) · `pwsh`(dsh) · `exec_command`(codex) | `execute` | `shell` |
| `command_execution`(codex，**条目名**） | `execute` | `shell` |
| `file_change`(codex，**条目名**） | `edit` | `file` |
| `write_stdin`(codex) | `send` | `process` |
| `WebSearch`(cc) · `web_search`(dsh / codex) | `search` | `web`（本仓三家统一禁用 ⇒ 计数恒 0） |
| `WebFetch`(cc) · `web_fetch`(dsh) | `read` | `web` |
| `ExitPlanMode`(cc) · `exit_plan_mode`(dsh) | `send` | `task` |
| `todo_write`(dsh) | `edit` | `task` |
| `update_plan`(codex) | `edit` | `task` |
| `TaskCreate` · `TaskUpdate` · `TaskList` · `TaskGet`(cc) | `edit` / `query` | `job`（**不是 `task`**） |
| `Skill`(cc) · `skill`(dsh) | `execute` | `skill` |
| `Task` / `Agent`(cc) · `subagent` · `subagent_fork`(dsh) · `spawn_agent`(codex) | `spawn` | `agent` |
| `SendMessage`(cc) · `send_message`(dsh) · `send_input`(codex) | `send` | `agent` |
| `TaskStop`(cc) · `interrupt_agent`(dsh) · `close_agent`(codex) | `stop` | `agent` |
| `job_kill`(dsh) | `stop` | `job` |
| `request_user_input`(codex) · `AskUserQuestion`(cc) · `ask_user_question`(dsh) | `query` | `user` |
| `ListAgents`(cc) · `list_agents`(dsh) | `query` | `agent` |
| `job_list`(dsh) | `query` | `job` |
| `job_output`(dsh)（兼两种动作，统计取前者） | `query` | `job` |
| `wait_agent`(codex) | `wait` | `agent` |
| `resume_agent`(codex) | `resume` | `agent` |
| `create_goal` · `get_goal` · `update_goal`(dsh / codex) | `write` / `read` / `edit` | `goal` |
| `EnterWorktree` · `ExitWorktree`(cc) | `send` | `worktree` |
| `Workflow`(cc) · `workflow`(dsh) | `execute` | `agent` |
| `ReportFindings`(cc) | `deliver` | `user` |
| `Cron*` · `ScheduleWakeup` · `DesignSync`(cc) | 已被适配器禁用 | — |

- **落点**：两轴映射表是**纯函数模块**，放 `packages/client/`（`client` 或 `ui`），**不进 `agents` 包**——适配器只认自己那一家的工具名，不该知道别家的名字。
- **codex 的统计列以 item 类型为键**（`command_execution` → `execute/shell`、`file_change` → `edit/file`）：事件流与入站工具表之间**没有可对齐的键**（`command_execution` 条目里根本没有工具名字段）。⇒ `'shell'` / `'apply_patch'` 这类**规范自定名必须标注成合成名**，不得当作厂商真名参与跨家比较。
- **表里有没有这一行 ≠ 这次跑有没有这个工具**：`ExitPlanMode` / `AskUserQuestion` 在 claude 侧是 mode / 回调门控的，`update_plan` / `web_search` 在 codex 侧由配置决定。映射表保留全部条目以兼容工具表变化；统计只数**实际出现的调用**。
- **分工**：渲染读 `family`（10 族），统计读两轴（全部工具），面板读子任务行（§2.8）——三者的取数面互不替代。

---

## 6. 流式与合并规则

### 6.1 两种块形态

- `'delta'`：该块的增量片段，消费方**必须按块累积**。**当前实际只有 claude-code 有这条路径**（`includePartialMessages` 打开后的 `content_block_delta`，且只覆盖主会话）；dsh 的 `data.stream[]` 增量通道没有取数实现，codex 的事件流无 delta 形态 ⇒ 增量是可选的实时增强，**不是任何一家的必备通道**。
- `'snapshot'`：该块的当前完整内容，可**直接覆盖**同键块。**三家实际产出的都是它**：claude-code 的完整 `assistant` / `user` 消息、codex 的会话文件条目、dsh 的 `assistant/message.content[]`（整块）；只有进程被中断的块例外。
- 同一个块可以既有 delta 又有 snapshot：delta 用于实时打字，snapshot 是落盘与抽屉的真相。**消费方只实现 snapshot 也能正确渲染**（把 delta 当作可选的实时增强，因为快照一定在块结束时到达）。

### 6.2 覆盖合并算法

合并键：`(subagentId ?? 'main', roundTrip, 载体, 块标识)`。

| 分量 | 取值 |
|---|---|
| `载体` | 该块所属消息的 `role` 与 `parentCallId`。同一轮里 assistant 消息与工具结果消息各自从 0 起算块序号，只带 `blockIndex` 会把工具结果盖到正文块上 |
| `块标识` | 文本块与思考块用 `blockIndex`（该逻辑消息内的序号，按首次到达顺序分配，一经分配不再变化）；工具调用块与工具结果块用 `callId`（同轮多次调用因此互不覆盖） |

1. 收到 `delta`：把片段追加到该键的累积缓冲区，渲染时显示缓冲区内容。
2. 收到 `snapshot`：用其内容**覆盖**该键的缓冲区与最终内容。
3. 收到同一键的多个 `snapshot`（同一条逻辑消息可能被分多次投递、每次只带一个块）：**后者覆盖前者**，不追加、不拼接。**块序号必须按首次到达分配**——适配器侧要按厂商输出里的序号换算，**不能每次投递都从 0 重开**，否则多个块会挤进同一个槽位、互相覆盖。
4. 新块只能追加到末尾：块序号与 `callId` 一经确定不再变化。**消息信封的 `mergeKey` 就是这条规则的可执行形式**，消费方按它覆盖累积，再在键内按数组下标（= 块序号）或 `callId` 合并到块一级。
5. 合并键不含 `messageId`：同一个块的 delta 与 snapshot 是两条消息，配对只靠上面的键。

### 6.3 顺序与容错

- 事件 `seq` 单调递增；消费方按 `seq` 去重，断线后按 `Last-Event-ID` 语义续订。
- 允许不同块之间乱序到达：合并只依赖合并键，不依赖块与块之间的到达顺序。
- 同一个键上，`delta` 必须先于 `snapshot`（同一家的同一条流内有序）。`snapshot` 之后到达的同键 `delta` **丢弃**、不追加——快照按定义已含它之前的内容，追加会把这一块写重。
- 缺失 `snapshot` 的块（进程中断）保持最后一次 delta 累积值，并由消息上的 `assembly` 标成 `'open'`。**不要**用 `truncated` 表达这件事：那是 `tool-result` 块自己的字段（结果文本有没有被截断），文本块与消息都没有这一格。

---

## 7. 缺失影响矩阵

"谁缺什么、影响什么"是本文最需要被消费方读到的一节。每一条缺失都要落到能力声明的某一格上，写清它属于五态中的哪一种（`yes` / `no` / `unverified` / `off-by-adapter` / `not-projected-by-vendor`），并配一条缺失原因（`no` 配 `not-supported`、`not-projected-by-vendor` 配 `not-exposed`、`off-by-adapter` 配 `not-observed`、`unverified` 配 `unverified`）。**不得**用 0、空串或省略字段代替。

### 7.1 claude-code

| 缺什么 | 缺失性质 | 影响 | 消费方义务 |
|---|---|---|---|
| `vendorTurn`、`step` | 厂商无此字段 | 只有 dsh 能给出厂商轮号与步骤号；跨家比较这两个量没有基准 | 恒 `null`，不显示"0"或"1" |
| 嵌套父链 | 深度 ≥ 2 时父 id 在**消息**的 `parent_agent_id` 上（`task_started` 不带）；深度 1 时该格为 `null` | 深度 1 的父链建不起来（那正是「父就是主会话」的情形） | 深度 ≥ 2 缩进显示；深度 1 平铺，不要推测父节点 |
| `Bash` 成功时的退出码 | 无结构化字段 | 成功路径的退出码恒 `null` | 显示"未采集"，不要显示"0 = 成功" |
| 子智能体的 token 级增量 | 不投送（只发主会话） | 子任务只有整块内容，无实时打字 | 子任务视图不做逐字动画 |
| **流式增量（声明与实现不一致）** | 能力位声明 `streamingDelta: 'yes'`，但适配器**没有开 `includePartialMessages`** | 主会话也拿不到逐字增量（`stream_event` 解析路径已就位，开选项即生效） | 不要按「这家有增量」写动效；按能力位与实际到达的块形态渲染 |
| **子智能体转录读不到** | 会话目录不存在 / 某个 `agent-<id>.jsonl` 读不动 / 空文件 / 三项缺一 / 认得是 assistant 却没有 `message.id` | 子智能体那一份用量与轮次**两格一起 `null`**，合计退回主会话口径 | 按要求退化成一行显示；不得把读到的那些当总数（部分和会被读成合计），日志里那条点名 WARN 说明少了谁 |
| **采不到 `session_id`** | `system/init` 没给（或没到达） | 定位不到「这一行的会话目录」，**不猜目录**（猜错会把别的会话的转录算到这一行上） | 按事实缺失处理（`null` + 点名），不要用别的会话的数兜底 |
| **幻影 `task_*` 与只见到收场帧的条目** | CLI 给非 Agent 任务也发 `task_started`（盘上永远没有它的转录）；收场帧不承载形状证据 | 前者已不产行、也不进事实核对名单；后者**无法判定**是不是子智能体 | 前者不该出现任何提示；后者照产行、两格照算，并落一条「可能少算它（无法判定）」的 WARN——**不要**因此把分量变 `null`，也不要叫它子智能体 |
| **工具结果的本地截断** | 结果正文超过 20 000 字符时由我们自己截断，而厂商不给截断标记 | 界面看不到「确认完整」与「确认被截断」的区分（截断发生在上游那一层，二次截断看不出来） | `truncation` 按 `unknown` 渲染（「输出可能不完整」），不要写「完整」 |
| `thinking_tokens` 缺失或为 0 | 后端不返回这一格时字段缺失；返回 0 时无法区分"这次没有推理"与"这条后端不上报" | 不能判断"这家不思考" | 缺失记 `null`；读到 0 照实记 0，但不得据此断言"这家不思考" |
| **`off` 的关闭依赖宿主环境** | 前置条件（`CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` 不在场、hipaa 策略为假）被破坏时，`thinking` 与 env 覆盖层**双双静默失效**（不报错、思考照旧） | 该行的 `off` 读数作废，而结果里看不出来 | 只见 `off` 档那条点名 WARN 时按「本次 `off` 未生效」呈现，**不要**按「它没思考」呈现 |
| SDK 路径下的 shell | **环境边界，不是厂商能力**：claude.exe 自身的工具沙箱拒绝工具级建目录（`EPERM`），同一份二进制由 CLI 直跑时不受影响 | SDK 路径下 shell 类观测拿不到真实结果，`Bash` / `PowerShell` 的结果为空或报错 | 该族结果为空时标"环境不可用"，不要标"没有执行"，也不要写成"这家不能跑 shell" |

### 7.2 codex

| 缺什么 | 缺失性质 | 影响 | 消费方义务 |
|---|---|---|---|
| 文件类五族 | 当前模型预设的工具表里没有这五类工具（随预设变化，不是"这家没有"） | 文件读写改搜列的统计对 codex 失真 | `family` 为 `null` 时走通用渲染；跨家统计标注"本次运行不适用"，不要写成"这家不支持" |
| `step`、`vendorTurn` | 厂商无此字段（`turn_id` 是字符串标识，不是序号） | 这家给不出厂商轮号与步骤号，跨家比较这两个量没有基准 | 恒 `null`，不要填 0 或 1 |
| **轮次口径已收窄** | 「只数 `Reasoning` + `AgentMessage`」会**系统性偏高**（一次调用常同时产出两个条目，而 `Reasoning` 在部分路由上事件流根本不投影 ⇒ 两把尺子分叉） | 现行口径只数模型答复条目（`AgentMessage`），事件流与会话文件两侧同一把尺子 | 该数从此是「模型答复条目数」，**比既有近似口径更低**；一个 `AgentMessage` 都没有的运行 ⇒ 轮次 `null`（显示「未采集」），**不得**回落成一个被抬高的数 |
| 事件流里的 `role` | 事件流没有 role 概念 | `role` 是派生值 | 不要当厂商原生字段用 |
| 事件流的时间 | 事件流不带时间戳 | tok/s 的分母含工具执行时间 | 展示 tok/s 时标注"墙钟"，不与厂商计时混排 |
| `thinking` 的 `signature` | 厂商条目里没有该字段（会话文件只给密文，不解析） | 无法校验思考块完整性 | 恒 `null` |
| 流式增量 | 事件流无 delta | 无实时打字 | 不做逐字动画 |
| `ask-user` | exec 路径结构性不可用 | 交互族恒空 | 记 `outcome: 'unavailable'` |
| 多智能体与思考 token | 多智能体随路由翻转；`reasoning_output_tokens` 只在会话文件里有 | 同一家的能力在不同路由下不同；思考 token 事件流那一侧恒缺 | 能力声明必须带路由前提；缺值时不要回落成"这家没有" |
| **`off` 的要求下发了、但关不掉** | 网关行为，不是我们的参数问题：`model_reasoning_effort: 'none'` 与 `model_reasoning_summary: 'none'` **都**已到 CLI（真机 `turn_context` 直证主线程与子线程都是这两值），网关仍照样推理 | `off` 行仍有思考产出（28 条 reasoning 条目、自述 7,347 思考 token；同 run 未选对照行 13 条）⇒ 这家当前**没有**「零推理」这一档 | `EvalRow.effort` 记的仍是「我们**要求**的档位」；文案与统计一律按「已要求关闭」说，**不要**按「它没思考」说，也不要用极简 prompt 上的那次「0 条」外推 |
| `in_progress` 态 | 事件流的载荷只有 `{ text, completed }` 二态（`in_progress` 只出现在工具入参里） | 从事件流重建进度面板时无法区分"进行中"与"未开始" | 该态显示 `unknown`，不要猜成 `pending` |
| **`parentCallId` 两条通道不同值** | 事件流给**条目 id**（内部配对键），会话文件给**父会话文件里的真 `call_id`** | 同一条子任务的两份记录不会互相覆盖（值不同） | 按 `subagentId` 分桶，不要假设两份记录的 `parentCallId` 相等 |
| **spawn 链被上限截断** | 深度 8 / 递归发现 32 条（种子不计）任一真的砍掉分支 | `tokens` / 缓存命中 / 轮次**三格一起**退回主线程口径，子智能体那一份整格 `null` | 不许拿部分和冒充总数；那条点名整行的 WARN 已经说明「不含未读到的子线程」 |
| **`{0,0,0}` 的前提** | 子线程 id 的**唯一**来源是事件流的 `receiver_thread_ids`；路由拒绝命名空间工具 / 开关关掉 / CLI 换形状时它为空 | 「确实没有子智能体」只在「事件流没给过 id」这条判据下成立——它说的是「**本次没观察到**」，不是对事实的证明 | 文案写「本次未观察到子智能体」，不要写成「这一行确实没有」 |
| **`resume` 复用的旧会话** | `codex exec resume` 会复用旧会话并打出同一条横幅；只挡住了「明显早于派发者」的那一半 | 残留可能把历次尝试留下的死会话算进分量 | 不要把它读成「已经证明没有多计」 |
| **fork 副本的残留** | 身份判据取文件里**第一条** `session_meta`；CLI 若反序写（副本在前）会取错，而读取层拿不到「按哪个 id 找到的」 | 极端情况下名称 / 父链 / 深度会算到派发者头上 | 该档无法在消费方纠正，登记为已知残留 |
| **轮次少计一档** | 子线程轮次只收「桶里有本模块消费的记录类型」的轮；只有一个外层用量记录的桶会漏一轮 | 子线程轮次可能少 1（方向是**少计**，不是多计） | 不要拿它当精确值；跨家比较前先确认口径 |
| **工具结果的截断标记** | 厂商不给截断标记 | 只有我们自己截断时才是 `truncated` | 其余按 `unknown` 渲染，不写"完整" |
| **原生面板事件不可得** | `PlanUpdate` / `plan_delta` 一类原生面板事件只在 app-server / rollout 协议上，**不在 `exec` 的 JSONL 事件集里** | 经 SDK 拿不到原生面板保真度 | 面板由**工具面重建**（`update_plan` 的入参 + 事件流的 `todo_list` 条目），并把 `in_progress` 按 `unknown` 显示（见 §3.3 / §5.3） |

### 7.3 dsh

| 缺什么 | 缺失性质 | 影响 | 消费方义务 |
|---|---|---|---|
| `reasoningTokens` | 通道不投送（本条路由的用量映射不写这一格） | 思考**计量**跨家只有两家有值；思考**内容**不受影响 | 该格记 `not-projected-by-vendor` + 缺失原因 `not-exposed`；跨家求和不含它 |
| 子任务级用量不在子任务通知里 | `subagent.started` / `subagent.finished` 不带用量 | 子任务级用量要按子会话分组求和才拿得到 | 用子会话的 `assistant/message.usage` 按 `sessionId` 分组求和，`source` 记 `'wire'`（子会话事件与主会话同一条通知流） |
| **子会话已收场却一条用量都没报** | 事实缺失（不是「没花」） | 子智能体那一份用量与轮次**两格一起 `null`**；而合计是逐条累加的流水，**退不回**主会话口径 | 按要求退化成一行；`{0,0,0}` / `0` 与 `null` 必须分开说（前者是「确实没有子智能体」） |
| **流式增量（声明与实现不一致）** | 能力位声明 `streamingDelta: 'yes'`，但 `data.stream[]` 那条通道没有取数实现 | 消息块一律是整块快照，没有逐字打字 | 按 `chunk: 'snapshot'` 渲染，不要等增量 |
| **累加没有去重键** | 这一家不写事件去重表：重复投递的同一条 `assistant/message` 会重复累加 | 用量与轮次可能被重复计数 | 去重只发生在 `usage` 事件的发射门（与上次逐字段相同就不发），它不改已累加的值——消费方不要指望事件里带着去重后的更正 |
| `parentCallId` / `parentSubagentId` | 载荷里没有可对齐的调用 id，也没有父 id | 无法把子任务挂到「哪次调用派生的」，也无法表达两层以上的层级 | 两个格恒 `null`；派发点退化为「派发工具入参里的任务名 == 子任务名」逐字相同才认 |
| 取消时的结果文本 | 可能没有 text 块 | `outcome` 为空 | 保持 `null`，不要用状态文本顶替 |
| `stopReason` 的部分档位 | 厂商值域有五档（`completed` / `aborted` / `error` / `max-tokens` / `refusal`），其中 `error` 与 `refusal` 没有可核对的映射依据 | 状态映射表可能漏档 | 未覆盖档记 `unknown` + 缺失原因 `unverified`（`statusMissing` 非空），不得猜 |
| 收场事件 | 强杀时没有 finished | 面板会缺一行终态 | 必须支持"未收场"显示 |
| 工具调用级归属 | 只有会话 id 层级 | 归属粒度比另两家粗 | 跨家比较归属时标注粒度差异 |

### 7.4 三家共同

| 缺什么 | 缺失性质 | 影响 | 消费方义务 |
|---|---|---|---|
| `web-search` 族数据 | **三家一致地"没有"**：claude 的 `WebSearch` 进无条件禁用名单、codex 硬编码 `tools.web_search: false`、dsh 在 profile patch 里 `tool-web.config.search = false` ⇒ 该族在本仓**恒空** | 该族整体为空 | 显示"未启用联网"，**不得**显示"三家都没搜"（那是把配置结论读成能力结论） |
| 思考块的 `signature` | 有意不进呈现（claude-code 有值，codex 与 dsh 恒 `null`） | 无用户可见影响 | 只在审计视图出现，正文与导出都不显示 |
| 子智能体内的提问 | 三家一致不支持 | 子任务不能向用户提问 | 子任务视图不渲染提问入口 |

---

## 8. 配置面

### 8.1 必须写死的配置

| 家 | 配置 | 值 | 原因 |
|---|---|---|---|
| claude-code | `forwardSubagentText` | `true` | SDK 默认只投送子智能体的 `tool_use` / `tool_result` 块；不开则子任务视图只剩工具流水，看不到子智能体说的话与想的事 |
| claude-code | `disallowedTools` | **无条件**禁七项：`CronCreate` / `CronDelete` / `CronList` / `ScheduleWakeup` / `PushNotification` / `DesignSync` / `WebSearch`（**不按模型名分档**，那条 `/claude/i` 分支与它的禁用名单一起删掉） | 定时任务 / 推送这类工具会绕过评测面；`WebSearch` 是**厂商服务端执行**的工具，只有 claude / gpt 系模型实现它 ⇒ 放行会让「有没有联网」变成**模型差异**，而模型正是本项目的自变量。一律禁用才让该族在**所有模型上一致地"没有"**。**只禁工具、不禁网络**（`Bash` / `WebFetch` 照旧可用；`web_fetch` 不在本条里） |
| claude-code | `CLAUDE_CODE_ENABLE_TODO_TOOLS` | `1` | 规划工具按模型门控，不显式开启就没有进度数据 |
| claude-code | `CLAUDE_CODE_ENABLE_TASKS` | `0`（可选） | 把 `Task*` 四件套换成 `TodoWrite`；后者的入参是**整表**、能进进度面板，而四件套是逐条 patch 的注册表、没有归一载荷 |
| claude-code | `canUseTool` 回调 | 需要交互时注册 | 不注册则 `AskUserQuestion` / `EnterPlanMode` / `ExitPlanMode` 都不出现在工具表里 |
| claude-code | `CLAUDE_CODE_EXTRA_BODY` | `off` 档 spawn CLI 时注入 `{"thinking":{"type":"disabled"}}`（值**由 `JSON.stringify` 生成**，且**只有这一个键**） | CLI 的**模型能力门**对它不认识的模型名判定「不许关思考」⇒ **故意不写** `thinking` 字段（网关本身是尊重这个字段的）⇒ 不注入 env 覆盖层就关不掉。注入由 `claudeExtraEnvFor(input.effort)` 产出：**只有 `off` 档给这一条，其余档位与未选给空对象**（不能给值为 `undefined` 的键——那会在非 off 档删掉宿主继承来的同名变量）；覆盖层经同一条链路**对子智能体同样生效** |
| claude-code | `settingSources` | `['user', 'project', 'local']` | 读得到被测仓库的 `CLAUDE.md` 与项目配置；`[]` 会把它们一起挡掉 |
| claude-code | `settings.env` | 与本次路由同值的 `ANTHROPIC_BASE_URL` / `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` | 打开 `project` 档后，仓库自带的 `.claude/settings.json` 的 `env` 会盖掉本次路由；这一档优先级更高，把它钉回去。与 `settingSources` **成对**给 |
| claude-code | `enableWorkflows` | 显式 `true` | 不设时取「按 plan 默认」这一档**不可控的输入**（`false` 才会把 `Workflow` 从工具表里摘掉）⇒ 显式钉住行为。**它只管"能不能"，不管"会不会"**：`Workflow` 的工具描述把触发条件写死在提示词侧（用户须显式 opt-in，`ultracode` 关键字或原话要求编排）——**普通提示词下模型不会调它**。要观察编排能力，三家必须在同一段提示词里显式 opt-in；不想引入编排，则提示词里避免 `ultracode` 与「用 workflow / 并行开 agent」这类原话 |
| claude-code | `workflowSizeGuideline` | `'medium'` | 总数侧只有 advisory 档位（`small`/`medium`/`large` = 5/10/50），**表达不了 8**；`'8'` 会被忽略并回落 `medium` |
| claude-code | `CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS` | `8`（注入 `buildSubprocessEnv` 的 `injected`，与 `CLAUDE_CODE_ENABLE_TODO_TOOLS` 同一通道） | 厂商侧**唯一的硬闸门，且它管的是并发**。注入后在 CLI 的 debug 日志上出现 `workflow: concurrent agent gate = 8`（`--debug` / `--debug-file` 才写；plain `-p` 的 stdout / stderr 里永远没有） |
| claude-code | `CLAUDE_CODE_WORKFLOW_SIZE_WARNING_AGENTS` | `8`（注入 `injected`） | 与 `workflowSizeGuideline` 合成的 `agentCap` 一起用于**厂商规模告警**。⚠️ **这条告警不进任何可见流**（stdout / stderr / debug 日志 / SDK 消息流全都没有）⇒ 规模告警**只能由我们产出**：适配器按 `subagent-start` 对 `task_type === 'local_workflow'` 计数，超 8 落一条 WARN。**计数是观察，不是拦截** |
| codex | 驱动方式 | `@openai/codex-sdk`：`new Codex({ apiKey, baseUrl, config, env })` → `startThread({ model, workingDirectory, sandboxMode, approvalPolicy, skipGitRepoCheck })` → `runStreamed(prompt)` | 不经裸 CLI 手拼 argv；SDK 用自带的可执行文件以 `exec --experimental-json` 收发 JSONL，`env` 是替换型（要自己展开宿主环境） |
| codex | `wire_api` | `responses` | 唯一合法值，写别的在配置校验阶段就失败 |
| codex | `CODEX_HOME` | 与 SDK 自带的 exe 同区：exe 在工作区内时，它也必须落在工作区内 | 跨区会启动失败 |
| codex | 多智能体 | `features.multi_agent = true`；模型预设的 `model_messages.multi_agent` 必须有值 | 写在 `tools.` 前缀下会被 CLI 忽略；模型预设没有这一格时 `spawn_agent` 被拒为 `unsupported call`，子任务面为空。⚠️ **这一格本仓无法自行满足**：`model_providers.<id>.models[]` / `model_messages` / 顶层 `multi_agent*` / `agent_default_subagent_model` 逐键被 CLI 拒，二进制里也没有自定义 preset 入口 ⇒ 唯一达成路径是**网关侧**提供一个 codex 认识且带 profile 的模型名；能力声明必须把路由与模型名写成前提 |
| codex | `tools.update_plan.enabled` | `true` | 默认关闭，不开启则工具表里没有 `update_plan`，没有进度数据 |
| codex | CLI config `model_reasoning_summary` | **只在 `off` 档**给 `'none'`（`buildCodexConfig` 的**第三实参**）；其余档位与未选 ⇒ **键整个不出现** | 触发条件是 `include: ["reasoning.encrypted_content"]`（上游硬编码、不可配）**∧** `reasoning.summary` 同时存在 ⇒ 两半缺一都关不掉。⚠️ 这一格**到得了 CLI，但网关仍会推理**：真机 `off` 行仍有 28 条 reasoning 条目（同 run 未选对照行 13 条）⇒ 只保证「已按要求下发」 |
| dsh | 子进程环境 | 显式删除 `DEEPSEEK_API_KEY` 与 `DEEPSEEK_BASE_URL` | 宿主凭据被继承时，不用的 `deepseek-official` 路由会静默可用并真实发请求 |
| dsh | 路由 patch（`- id: <插件 id>`） | 该行的 `config` **整份写出**，不做深合并 | 只写要改的那一格会抹掉同组其它键，随后被插件 schema 的默认值改回 |
| dsh | 联网工具的关闭 | 该行 profile patch 的 `tool-web` 一次写全三格：`{ search: false, fetch: true, searchTimeoutMs: 60000 }` | 顶层 `- id: <插件 id>` 覆盖是**整份替换**：只写 `search: false` 会抹掉同组其余键，再被插件 schema 的默认值改回 ⇒ `fetch` 回到 `true`（`web_fetch` 不消失），而 `searchTimeoutMs` **静默从 60000 掉到 30000**（超时腰斩，`--dump-config` 看不到这一层）。判据：`dsh --profile sdk --dump-config` 的合成树里 `search === false` 且 `fetch === true` |

### 8.2 必须规避

| 家 | 不要做什么 | 后果 |
|---|---|---|
| claude-code | 依赖自动放行模式（`bypassPermissions` / `acceptEdits`）同时期望收到提问 | 调用在回调之前就被解决，`canUseTool` 不触发，提问被静默跳过 |
| claude-code | 用 `tools` 数组限制能力却不列出需要的工具 | 该工具直接从工具表消失 |
| codex | exe 在工作区内时，把 `CODEX_HOME` 放到工作区外（例如系统临时目录） | 启动即失败（`os error 5`） |
| codex | 在只支持部分能力的网关路由上开启多智能体 | `spawn_agent` 被拒为 `unsupported call`；带工具列表的请求可能被整体拒绝 |
| codex | 把「近似条目计数」当厂商轮号或跨家可比的往返数 | 现行口径已**收窄成只数模型答复条目**（不再是偏高那个近似值），但它仍是**合成值**、与另两家的计数方法不同 ⇒ 跨家比较前先确认口径（§1.2） |
| dsh | 把宿主的 `DEEPSEEK_API_KEY` / `DEEPSEEK_BASE_URL` 留在子进程环境里 | 不用的 `deepseek-official` 路由静默可用并按公网地址真实计费；`web_search` 也会拿它去打搜索接口 |
| dsh | patch 里只写要改的那一个键 | 同组其它键被抹掉，再被 schema 默认值改回（`searchTimeoutMs` 静默从 60000 变 30000） |
| 三家 | 用 0 或空串表达"未采集" | 下游无法区分"没有"与"没采到" |
| claude-code | 把 `CLAUDE_CODE_EXTRA_BODY` 的值手写成字符串常量（而不是 `JSON.stringify` 生成） | CLI 对**非法 JSON 静默忽略整条**：`thinking` 仍缺失、**没有任何报错**（真机踩过：PowerShell 吃掉内层引号 ⇒ `{thinking:{type:disabled}}`）。所以该值必须由构造保证合法 |
| claude-code | 用 `CLAUDE_CODE_EXTRA_BODY: off ? VALUE : undefined` 这种写法 | 值为 `undefined` 的键会被**删掉** ⇒ 非 off 档会删掉宿主继承来的同名变量，改变其它档位的行为 |
| claude-code | 依赖宿主环境里没有 `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` | 它在场会让 `off` 档的修复**静默失效**（body 覆盖层被前置条件废掉）。**观测不拦截**：`off` 档且该变量在场时落一条 WARN（点名宿主用的那个**键名原文**、说清后果与下一步），照旧注入、不许因此跳过这一行 |
| codex | 把「已给 `model_reasoning_effort:'none'` ∧ `model_reasoning_summary:'none'`」当成「模型真的不思考」 | 两格**都确实到了 CLI**（真机 `turn_context` 直证主线程与子线程），**是网关照样推理** ⇒ 判据只能读**行的产物**（rollout 里的 `reasoning` 条目数），不能读请求体、也不能拿极简 prompt 上的「0 条」外推 |
| codex | 在 config 里写「键在、值为 `undefined`」来表达「不给这一格」 | 本仓 SDK 对 `undefined` 值的键**直接跳过**（不产出任何 `--config` 参数）⇒ 今天与「键缺席」**行为等价**；但**键缺席**才是逐键对账与抗 SDK 漂移都成立的那一种形态（升级后 SDK 若改写这一格，键缺席仍安全） |
| claude-code | 把「总数 ≤ 8」当成本行**所有**子智能体的上限 | 上限的作用域是 **Workflow 派生的 agent**（`task_started.task_type === 'local_workflow'`）；普通 `Task` 子智能体（`local_agent`）厂商**没有任何等价开关**。跨家比较编排规模时必须带上这条口径 |
| claude-code | 自己数到第 9 个就调 `Query.stopTask(taskId)` 硬拦 | 那等于**评测中途改写模型的编排**：被杀掉的 agent 留下半成品，而「编排规模」这个**本该被观察的量**反而被我们自己抹掉。厂商侧唯一的限制就是并发那一格，超出的部分**如实记录** |
| codex | 用配置键给模型预设注入 `multi_agent` profile | 逐键被 CLI 拒（`model_messages` / 顶层 `multi_agent*` / `agent_default_subagent_model` 都被拒；`[agents]` 的 `default_subagent_model` 虽被接受但不含 profile）⇒ 白费工夫，还会让人误以为「配了就通」。这一格只能由网关侧给模型名 |

---

## 9. 落地清单

按实施顺序排列；每步都有可独立验证的产出。

| 序 | 改动面 | 产出 |
|---|---|---|
| 1 | 契约包：消息信封、内容块（含族载荷与 `unrecognized`）、行级事件（含 `vendor-system`）、计量结构（含 `subagentTokens` / `subagentTurns`）、能力声明 | 类型与校验 schema 可被消费方引用 |
| 2 | 环境契约：`AgentEnvironment` / `EnvGroup` / `EnvItem` / `EnvSource` 与数据层的拼装 | 环境抽屉有稳定的取数形状（与消息解耦） |
| 3 | 适配器公共层：覆盖合并、块序号分配、`seq` 分配、工具归族、**族载荷归一**、**用量求和**（`sumUsageTokens` / `addUsage`）、缺失表达工具函数 | 合并、归族、归一与求和各只有一份实现，三家适配器都调它 |
| 4 | 适配器骨架接线：`onMessage` / `onSubagent` 两条回调、`TurnProjection` / `TurnFinalize` 的四格（`tokens` / `turns` / `subagentTokens` / `subagentTurns`）与两套 `null` 语义 | 一家产出的消息与子任务行走同一套合并、发射与覆盖规则 |
| 5 | claude-code 适配器：建会话与路由注入 → 消息归一 → 子任务形状判据 → **读 CLI 转录交子份两格** → 规划数据 → 计量 → 工具族 → 交互 | 该家全字段可产出 |
| 6 | codex 适配器：SDK 启动与 `CODEX_HOME` → 事件流解析 → 会话文件读取（正文 / 工具真名 / 配对键 / 时间戳）→ **spawn 链递归发现与两条上限** → 运行期节流读盘 + 收尾补齐 → 子份两格 → 计量与轮次 → 工具族与开关 | 该家全字段可产出 |
| 7 | dsh 适配器：建会话与路由 patch → 通知分流与**整棵会话树放行** → 消息归一 → 子任务两格读状态与 catalog → **按子会话白名单交子份两格** → 计量 → 工具族 → 未识别事件的容错投影 | 该家全字段可产出 |
| 8 | **三端一致性验证**：同一场景三家归一结果逐字段相等（纯文本、shell 调用与结果、思考档位、工具归族、族载荷、缺失表达） | 三家产出的形状差异只剩「这一家结构上没有」的那几格 |
| 9 | 落盘与推送：`messages.jsonl`（消息与子任务行**一条流**）+ 进程内订阅；每次尝试开始时清空；`GET .../rows/<rowId>/messages`（折叠视图）与 `.../messages/stream`（SSE）| 对话视图与派发面板有唯一真相源，刷新与实时两条路径同源 |
| 10 | 投影层：10 个工具族 + 2 张面板 + **两轴映射表**（纯函数，落 `packages/client/`，不进 `agents` 包，见 §5.6） | 两张面板与跨家统计的数据可渲染（含各类缺失态） |
| 11 | 派生指标：缓存命中率、tok/s、首字延迟（唯一一份实现） | 界面与导出共用同一套算法 |
| 12 | 能力声明与缺失表达接线 | 缺数据时界面显示"未采集"而非 0；声明与实测行为由守卫对齐 |
| 13 | 配置面固化：三家开关与路由前提逐条落进适配器 | 每条开关都有唯一的写入点，能力声明随之带出路由前提 |
| 14 | **消息级用量**：契约加 `usage`（可选）→ 草稿层加 `usage`（必填可空，`tsc` 列出全部构造点）→ 合并器「带值覆盖、缺省保留」→ dsh 的纯读函数（`protocol.ts` 的 `readUsageTokens` + `DSH_USAGE_FIELDS`，`events.ts` 只调它并 re-export）→ 界面页脚（见 `2026-09-30-exec-log-drawer-redesign-design.md` §6.13） | 每条消息自己那一次模型调用的用量可见，行级口径一字不动 |
| 15 | **思考强度档位**：`AgentRunInput.effort` 的口径（§3.6）逐家落地 → 注册表 `defaultEffort`（只有 dsh 声明）→ API 的候选与未选校验 → 界面下拉与文案 | 未选不再等于关闭；`off` 的翻译只在一处；候选里「关闭」点得到 |
| 16 | **测试夹具的模块图**（见本章末「测试夹具不得重入在飞的模块」） | 收集期死锁不会经 `vi.mock` 工厂的 `import()` 链复发 |
| 17 | **消费方改造**：`client` 的 `row-live.ts`（`activityOf` 改读消息事件：优先 `text` / `thinking` 块、工具块用 `tool-call.name`、`attachment` 跳过；`usage` 折叠里「未采集」与「这一条不带」同义 ⇒ 都保持上一份，含 `reasoningOutput`）、`log-format.ts`（`message` 行按块渲染、`usage` 行加「· 思考 N」且该格为 `null` 时**不写这一段**、`formatEventLine` 跟随新的行级事件清单）、`AGENT_EVENT_TYPES`（跟随行级事件清单，SSE 订阅自动跟随）、`metric-line.tsx`（卡片指标显示思考 token，**不得与输出相加**）；`judge-agent.ts` **不变**（`finalText` 的语义与来源不变，仍是结果块的文本） | 界面上四类内容各自成形，且没有一处拿思考 token 去加输出 |
| 18 | **守卫与变异验证**（每条守卫都要把它要拦的缺陷人为造回去、确认守卫**失败**，再还原并核对文件哈希未变）：① 三家各一条映射守卫（用真实形状夹具断言事件类型 + 块类型 + 关键字段）；② claude 同一 `messageId` 分次投递 ⇒ 改成「丢弃同 id 的后续投递」必须红；③ 思考块空文本写 `''` 而不是 `null` 必须红；④ `chunk` 把 `delta` 当 `snapshot` 覆盖必须红；⑤ 把 `reasoningOutput` 加进 `output`、或把它排除出去重比较、或把估算帧当结算值 ⇒ 各自必须红；⑥ `family` 映射：codex 文件类五族要专门断言 `family === null`（防「顺手猜一个族」）；⑦ 静态呈现守卫：渲染与文案模块里**不得出现厂商工具名、`agentKind` 与 `signature`**；⑧ 能力声明与实测行为对齐（含 `usage` 相关那几格）的守卫，且**不许靠默认值蒙混**（缺格一律按不安全侧判）| 每条口径都有会被触发的守卫，而不是一句声明 |
| 19 | **配置面补齐**：claude 的 `enableWorkflows: true` + `workflowSizeGuideline: 'medium'` + 注入 `CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS=8` 与 `CLAUDE_CODE_WORKFLOW_SIZE_WARNING_AGENTS=8`；claude 的 `disallowedTools` 收成**无条件七项**（`WebSearch` 不再分模型名，随之下掉那条按模型名的分支与它的用例）；dsh 的 `tool-web` 三格与 `tool-ask-user` 插入（见 §8.1 / §4.3 步骤 1） | 三家开关各只有一处写入点，且都能被守卫逐字钉住 |

**实现侧的两条硬约束**：

- `agents/src/**` 里**不许出现目录扫描 API**（`readdir` / `readdirSync`，连注释里出现这个名字都会被静态断言判红），只允许一张**不许变长**的豁免表 ⇒ 「递归找 `sessions/`」「遍历 `projects/`」这类需求要按已知路径形态实现，新增豁免必须显式登记进那张表。
- 会话文件与转录都是**厂商边跑边写**的：所有读取都要容忍半截行与坏行（跳过并计数），不能假设「文件已经写完」。

**落盘格式与消费口径**（第 9 步的细则）：

- 文件名 `messages.jsonl`，与 `events.jsonl` 同行目录、**互不合并**：事件按 `seq` 去重与续订（行级），
  记录按 `mergeKey` / `subagentId` 覆盖累积（内容级）。
- 一行一条记录，`RowRecord` 两种载体：`{ type: 'message', message }` 与 `{ type: 'subagent', subagent }`。
- **四格计量的落点不在这个文件里**：`tokens` / `turns` / `subagentTokens` / `subagentTurns` 走 **`usage` 事件**（`seq` 去重）与 **`EvalRow`**（跑动期由事件回写、终态由适配器结果覆盖，写入口是同一个补丁函数）。消息信封上那一格 `usage` 是**消息级**读数（那一次模型调用），**不是累计、不进任何合计**；**单个子任务自己**的用量在 `messages.jsonl` 的 `subagent` 记录里（`SubagentRecord.usage`）。
- 读取侧两步：先按 `type` 分流，再按 `mergeKey`（消息）与 `subagentId`（子任务行）**覆盖累积**，
  顺序按**首次出现**——打字过程中的覆盖不该让这条消息跳到列表末尾。
- 一行都不产出时不建文件：读侧因此不必区分"空文件"与"没有这一格"。
- 每次尝试开始清空（与事件日志同一口径）：它记的是**当前这一次**尝试的内容。
- **实时通道没有 `Last-Event-ID` 续订**：记录没有单调序号（`messageId` 由适配器分配、跨运行会重号），
  每次连接回放全量折叠视图，客户端按 `messageId` 去重、按 `mergeKey` 覆盖累积。SSE 帧因此**不带** `id:`
  帧头（设了它浏览器重连会带一个我们解释不了的值，表现为重连后少一段历史且不报错）。
- 消息流与事件流是**两条独立的长连接**，生命周期也不同：事件流在终态帧后自行关闭，消息流保持打开
  （靠终态关流会让"打开一个跑完的行的对话视图"立刻断连，而那份历史正是要看的东西）。

**历史产物：删除，不做读侧兼容**（与「不考虑兼容、保障代码干净」同一口径）：

- 旧 `events.jsonl`（v1 的七型）与旧 `run.json`：**整轮目录不再提供读入口**（旧轮次不出现在列表与详情里），**不加 `messageSpecVersion` 之类的版本分流** ⇒ `AgentEvent` 只有单一版本，`row-stream.ts` 的「`seq` 回到 1 = 新一代」也只需一套判据。
- `resetEvents`（重跑清日志）保持「删文件而不是写空串」。
- ⚠️ **只针对旧格式**：契约里**新增的可选格**（`messages.jsonl` 的 `payload`、`usage` 事件的可选格、`SubagentRecord` 的可选格）不属于本条——读侧仍须把「键缺席」与显式 `null` 当同一件事，否则老日志会在回放与 SSE 续订时成片解析失败。

### 9.1 测试夹具不得重入「正在求值中」的模块

**目标状态**：`evaluator/src/testing/` 下**被 `vi.mock` 工厂动态 `import()` 的模块，不得对「被 mock 的模块」存在运行时边**。夹具模块可以 `import type` 它们（类型专用 import 被整条擦除，运行时不产生模块请求）。

- **症状（不可归因，所以必须防）**：`vi.mock` 工厂的动态 `import()` 链重入一个**正在求值中**的模块 ⇒ vite ModuleRunner 的 await 环**永不 settle**：整个测试文件 **0 个用例**、无报错、无超时、**零 CPU**（在等，不是在算）。收集阶段的等待**不受** `testTimeout` / `hookTimeout` 管辖；`--pool` / `--no-file-parallelism` / 单 worker / `--reporter=json` 全部无效（json 产物根本不生成）。
- **触发条件是「重入在飞的模块」，不是「图里有环」**：同样的三元环只要不重入在飞模块就正常通过。
- **修复的形态**（以 `evaluator/src/testing/fixtures.ts` 为例）：一条 `import { 一个值, type 若干 } from '@aieval/agents'` 里的**那一个值成员**就是闭合边；把它去掉、改成与该函数**逐字等价的字面量**（真源在 `agents` 的 `permissiveMessageCapability`；由 `AgentProviderMetadata.messageCapability` 的**类型**约束 ⇒ 将来新增必填格时 `tsc` 直接点名，不会静默过期）。
  - **不要**用 `vi.importActual` 去取那个函数：那只是把边换成工厂执行路径上的一次旁路读，时机落在同步函数里 ⇒ 风险面不明。字面量把这条边**彻底去掉**，且不需要任何运行时读。
  - **不要在夹具里另写一个自己的 `permissiveMessageCapability()` 复制函数**：那是第二份真源。
  - **一条类型期本该消失的 import，会因为多了一个值成员而变成真正的运行时边**——这是这类缺陷唯一的成因，看 import 语句的**成员构成**就能认出来。
- **守卫（结构判据，不是类型检查）**，落在 `evaluator/src/static-assertions.test.ts`（它自己不 mock 任何东西 ⇒ **永远能跑**；一条自身也会挂死的守卫不算守卫），用 **TS AST**（不要正则）：
  1. `MOCKED` = **一张登记表**：`@aieval/agents` / `./judge` / `./run-store` / `./text-api`（**所有被 mock 的项目模块**；**显式排除 `node:` 内建**——夹具要能 import `node:fs`，把内建纳入会让守卫落地即红，且那不是本类缺陷）。
  2. `ROOTS` = 扫 `src/**/*.test.ts` 里每个 `vi.mock(...)` 的**工厂实参子树**里 `import('<字面量>')` 的目标；从 ROOTS 出发沿**运行时**相对 import 遍历 `evaluator/src` 内的本地文件得到闭包（类型专用 import 不跟着走）。工厂里出现**非字面量**的 import 目标 ⇒ **直接判红**（推导不出来就不放行）。
  3. 闭包里任一文件对 `MOCKED` 任一目标存在运行时边 ⇒ 红，报 `文件:行:目标`。
- **「运行时边」的判定（逐形态）**：整条 `import type { … }` ⇒ 放行；`typeof import('…')`（类型位置）⇒ 放行；**`vi.importActual('…')` ⇒ 显式放行**（它是 mock 系统的旁路 API、读的是真模块，且是 `fakeAgentsModule` 里两个导出的唯一真源；判它违规会让守卫落地即红并诱使人去拆掉它）。
  其余全违规：有任一成员不带 `type` 的具名 import（**含折行与「成员全带 `type`」的混合形态**——`verbatimModuleSyntax` 下 vite 的 SSR transform 会让它**转译后仍残留一条模块请求**，实测如此）、默认 / 命名空间 / 裸 import、`import x = require(…)`、`export * from`、`export { A } from`、`import {} from` / `export {} from`、任何位置的 `import(…)` / `require(…)`。
- **判据的规格 = 样本表**：把上面每一种写法直接喂给判定函数（负样本必须命中、正样本必须放行），规则被改窄时那条用例先红。
- **绊线**：另加一条用例断言「从源码推导出的集合」与登记表**逐项相等**（新增第三条 mock 或第三个工厂目标模块时它先红一次，逼作者回来看新模块要不要纳入）。
- **范围是「工厂目标的静态可达闭包」，不是整个 `testing/` 目录**：后者包含 `orchestrator-harness.ts` 对 `../run-store` 的**运行时** import（它不是任何工厂的目标、不在环上）⇒ 守卫落地那一刻就是红的，而假红会诱使人削弱断言。
- **修复只解决这一条被追到的边**，不是「所有挂死」的通用修复：同类环若以别的形态出现（转手依赖、非字面量的动态 import 目标），要靠上面这条守卫与它的边界来兜。**不承诺全量全绿**——解冻后那批文件是**第一次**真的执行，可能暴露与本次修复无关的既存红；只承诺「**能被收集**」（汇总行的文件总数与逐包一致、用例数非 0），新出现的红按「回归 / 既存 / 机器慢」三分类登记，**不在本次修复里顺手修**。
- ⚠️ **既存的环境噪声不要与它混为一谈**：本机另有清理期 `EPERM`（临时目录被 git 子进程 cwd 句柄锁住，而 Node 的 `rimraf` 不把 `EPERM` 计入重试）⇒ 那些文件的**通过判据**是「失败条数 == 清理期 EPERM 条数 **且** `AssertionError == 0`」，不是「全绿」。**挂死判据**始终是「**进程自行退出** + **用例数非 0**」（挂死的形态是零输出、不退出、需人工中断）。
- **落地顺序**（判据排在最前，否则没有证据链）：① 去掉那条运行时边（夹具那一行 import 的值成员 → 字面量）；② 最小判别实验（该测试文件）**自行退出且用例数非 0**；③ 整包能被**收集齐**（`--reporter=json` 的 `testResults` 条数 == 该包测试文件数）；④ 新守卫（§4.2 的三步判据 + 样本表 + 绊线）；⑤ 逐条变异验证（把那条边造回去 ⇒ **重新卡死**；只在 import 里加回值成员而调用点仍是字面量 ⇒ 守卫红；去掉 `vi.importActual` 的放行 ⇒ 守卫红）；⑥ 还原并核对文件哈希未变。
- **版本敏感**：本文引的 runner 行号与「`isCircularRequest` 认不出这条环」都对应 **vitest 4.1.11 + vite 8.3.0**（`pnpm-lock.yaml`）；**改了版本别照抄行号**。未验的维度如实登记：`--pool` 的其它取值、非 Windows、vitest 5 / vite 7。

### 9.2 本期不做

- **不把厂商会话文件当主数据源**：它只用于**厂商没别处可给**的那几格——codex 的消息与子任务轨迹、claude 的子智能体转录（用量与轮次）——那些行的 `source` **必须**标出来源；其余字段优先走事件流 / SDK 消息流。
- **不直接操作厂商 CLI**：不 spawn、不解析 CLI 的 stdout、不依赖 CLI 的非 SDK 参数；对 codex 的入口只有 `@openai/codex-sdk`（读它落在 `$CODEX_HOME` 下的会话文件不属于「操作 CLI」）。
- **不做跨轮趋势统计、不做块级 diff 对比。**
- **不改 `finalText` 的语义与评分通路。**
- **不为 `web-search` 族找替代数据源**：统一禁用的目的就是让该族在所有模型上一致地"没有"；`web_fetch` 照旧可用（只禁搜索，不禁联网）。
- **不给普通 `Task` 子智能体自造上限**（`stopTask` 那条路，见 §8.2）。
- **不为原生面板保真度换传输层**（`exec` → app-server 的迁移成本另算，见 §7.2）。

---

## 10. 附录：最小实例集

### 10.1 思考块（三家归一后）

```jsonc
{ "type": "thinking", "text": "先读配置再决定改哪一行。", "textKind": "full", "signature": "EqQBC…" }
```

### 10.1.1 截断的表达（`truncation` 三态）

```jsonc
{ "kind": "truncated", "reason": "超过 256 KB" }   // 确认被截断，并说明为什么
{ "kind": "none" }                                  // 确认完整（厂商或我们自己给出了完整标记）
{ "kind": "unknown" }                               // **没采到标记** —— 消费方不得据此断定完整
```

**为什么不是布尔**：拿不到截断标记时只能记「没采到」，裸布尔会让界面上「确认完整」与
「不知道完不完」长得一模一样。三条口径：

- **认定方向是单向的**：只有拿到明确标记才能写 `none`；**没采到一律 `unknown`**；
- **自家截断要自己认**（适配器截断正文时写 `truncated` + 原因），别把「我们截了」也记成 `unknown`；
- **界面必须三态各说各的话**：`unknown` 写「输出可能不完整（没采到截断标记）」，
  绝不写「完整」——那正是「用负信号断言正事实」。

### 10.2 工具调用与结果（含族载荷）

```jsonc
{ "type": "tool-call", "callId": "call_00_NiG…", "family": "run-shell", "name": "exec_command",
  "input": { "cmd": "npm run build", "shell": "pwsh" } }   // input 是厂商原文（codex 侧 arguments 是 JSON 字符串，落库前解析成对象）
{ "type": "tool-result", "callId": "call_00_NiG…", "structured": { "exitCode": 1 },
  "isError": true, "text": "…error TS2304…", "truncation": { "kind": "unknown" } }
// structured 是归一后的结果；厂商原文是条目里的 exit_code / status / aggregated_output
// truncation：三家都不报截断标记 ⇒ `unknown`（“输出可能不完整”），**不是** `none`

// 同一族的另一次调用：进度清单（`task` 族的族载荷）
{ "type": "tool-call", "callId": "toolu_01B…", "family": "task", "name": "TodoWrite",
  "input": { "todos": [ { "content": "读配置", "status": "completed" },
                        { "content": "改标题", "status": "in_progress" } ] },
  "payload": { "kind": "plan", "note": null,
               "steps": [ { "id": null, "subject": "读配置", "status": "completed", "owner": null, "blockedBy": null },
                          { "id": null, "subject": "改标题", "status": "inProgress", "owner": null, "blockedBy": null } ] } }
// payload 是**本次调用之后的整张清单**（跨调用差分是消费方的事）；`input` 仍是厂商原文
// 认不出形状 ⇒ `payload: null`（走通用工具行，调用不会消失）；空表与 `null` 是两件事
```

**`structured` 必须有落点**：规范要求「有 `meta` 就不要退回去解析文本」，而它承载的是
**已解析过的事实**（dsh 的 `read` 给 `{lines[], totalLines}`、`grep` 给命中数、`write` / `edit`
给改动对象），结果正文那一格往往只是一段给人看的摘要（`<path>…</path>` 那种）。
界面把它渲染成等宽原文并如实标注「结构化结果」即可，**不需要**族专属渲染；
丢掉它等于让「有数据」变成「看不见」。

### 10.3 子任务行

```jsonc
{ "subagentId": "01a0f434-707e-…", "name": "Child runs a tool", "kind": "spawn_agent",
  "source": "session-file", "status": "completed", "statusMissing": null,
  "outcome": "CHILD-TOOL-RAN", "parentCallId": "call_00_ET_…", "parentSubagentId": "01a0f434-5def-…",
  "usage": { "input": 1200, "cached": 8320, "output": 114, "reasoningOutput": 52, "total": 9634 } }
// statusMissing：null = 状态已采集；取不到时写缺失原因（如 `'unverified'`）
// parentCallId：**派生这个子任务的那次工具调用 id** —— 与消息的 parentCallId 同源同义
// usage.total 是厂商原文（codex 口径 = input_tokens 9520（含缓存读）+ output_tokens 114），不参与 input + cached + output 的加和
```

**`parentCallId` 为什么必须在子任务行上**：

- **两套 id 不对等**：子任务**记录**的身份是厂商原生 id（claude 的 `task_id`、dsh 的子会话 id、
  codex 的子线程 id），而子任务的**消息**挂在**派生它的那次工具调用 id** 上（claude 的
  `parent_tool_use_id`）。消费方按 `subagentId` 分桶时，子任务的消息会**全部落回主会话或被丢掉**
  ——表现是点进子任务显示「没有对话记录」，而消息就在文件里。
- 消费方的正确做法是**按 `parentCallId` 建一层别名再分桶**（纯搬运，不含启发式）；
  它同时是「派发导航挂在哪一轮」的唯一定位键——没有它，就只能靠「工具名像不像派发工具 +
  任务名逐字相同」去猜，猜不中时**整棵子任务在界面上不可达**。
- 三家的这一格**不是同一个来源**：claude 取自 `tool_use_id`（与派发调用块、子消息上的
  `parent_tool_use_id` 三处同值）；codex 有两条通道、给的是**两个不同的值**（事件流用条目 id、
  会话文件用父会话文件里的真 `call_id`）；dsh 给不出 ⇒ `null`。
- **给不出就记 `null`**，**不猜**：消费方拿不到这一格时退化为按名字认，而不是编一个。

### 10.4 计量行

```jsonc
{ "seq": 41, "at": "2026-10-01T05:24:31.002Z", "type": "usage", "turns": 6,
  "tokens": { "input": 1221, "cached": 7040, "output": 114, "reasoningOutput": null, "total": 8375 },
  "subagentTokens": { "input": 320, "cached": 1024, "output": 40, "reasoningOutput": null, "total": null },
  "subagentTurns": 2,
  "timing": { "totalMs": 4820, "apiMs": null, "ttftMs": null, "source": "events" } }
// 时长单位毫秒；total 是厂商原文（dsh 口径 = input + 缓存读 + 缓存写 + output），不参与归一后的加和
// tokens / turns 是**全树合计**，subagentTokens / subagentTurns 是其中的**分量**（主会话那一行由相减得出）
// 三档：整格缺席 = 本条不带（保持上一份）；null = 有子智能体但没采到；{0,0,0} / 0 = 确实没有子智能体
```

### 10.5 增量与快照

```jsonc
{ "messageId": "run-7:20", "subagentId": null, "role": "assistant", "source": "wire",
  "parentCallId": null, "roundTrip": 3, "chunk": "delta", "assembly": "open",
  "mergeKey": "main|3|assistant|-",
  "blocks": [ { "type": "text", "text": "我先看" } ] }
{ "messageId": "run-7:24", "subagentId": null, "role": "assistant", "source": "wire",
  "parentCallId": null, "roundTrip": 3, "chunk": "snapshot", "assembly": "snapshot",
  "mergeKey": "main|3|assistant|-",
  "blocks": [ { "type": "text", "text": "我先看一下配置文件。" } ] }
// 两条消息的 `mergeKey` 相同（`'main'` + roundTrip 3 + 载体 assistant/null）⇒ 后者覆盖前者，最终块是快照那句
// 第一条的 `assembly` 是 `'open'`（这一块还在增量累积上），第二条收到快照后才是 `'snapshot'`
// 这两条是**合并规则的例子**：当前三家实际都只产出 snapshot，`'delta'` 要等对应的增量通道接上（见第 7 章）
```

### 10.6 未采集的表达

```jsonc
{ "type": "tool-result", "callId": "toolu_01A…", "structured": null, "isError": false,
  "text": "export const config = …", "truncation": { "kind": "unknown" } }  // structured 未采集 ⇒ null，不是 {}
{ "type": "usage", "tokens": null, "subagentTokens": null, "subagentTurns": null,
  "timing": null, "turns": 1 }   // 用量与时间整体未采集 ⇒ null，不是三个 0
```

### 10.7 系统层事实（`vendor-system`）

```jsonc
{ "seq": 3, "at": "2026-10-01T05:24:02.118Z", "type": "vendor-system",
  "tools": ["Read", "Write", "Bash", "Task"], "slashCommands": ["/clear", "/compact"],
  "agents": ["general-purpose"], "mcpServers": null, "permissionMode": "bypassPermissions",
  "outputStyle": "default" }
// 六格各自可空：null = 这一格厂商没投送到我们能读的通道；[] = 采到了、确实是空的
// 整条事件只在厂商真的投送了那一行时才有（没有这一行的那一家不发这条事件，消费方整组走 not-exposed）
```

### 10.8 消息级用量（dsh）

```jsonc
{ "messageId": "run-7:31", "mergeKey": "main|3|assistant|-", "role": "assistant",
  "roundTrip": 3, "subagentId": null, "chunk": "snapshot",
  "blocks": [ { "type": "text", "text": "我先看一下配置文件。" } ],
  "usage": { "input": 1546, "cached": 9216, "output": 442 } }
// 这一次模型调用自己的用量；不是累计、不进任何合计 ⇒ 不得与 usage 事件的 tokens / 行卡片对账
// 三项缺一 ⇒ 整格 null（不填 0）；claude / codex 恒不交这一格（缺键）
```

### 10.9 轮次与用量的归属键

```jsonc
{ "seq": 41, "at": "2026-10-01T05:24:31.002Z", "type": "usage", "turns": 6,
  "turn": { "subagentId": "48b5bcf6-…", "round": 2 },
  "tokens": { "input": 1211, "cached": 7424, "output": 108 } }
// turns = 这一行跑到第几轮了（**行尺度**：服务进度条与 EvalRow.turns，必填）
// turn  = 这一条读数发生在哪个会话的第几轮（**会话尺度**：只服务抽屉的落点，可选）
// 缺键与显式 null 同义 ⇒ 无归属信息（界面按时刻归位，与老日志逐字相同）
```
