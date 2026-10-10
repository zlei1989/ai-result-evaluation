/**
 * 每候选行事件日志的一条。
 * 三个必须成立的口径：
 *   1. 形状由**本项目**定义：不复用任何厂商 SDK 的消息形状，
 *      否则日志格式会随厂商版本漂移，还会把「本项目根本不消费的内容类型」当兼容包袱带上；
 *   2. `seq` 单调递增且从 1 开始，由 core 的事件日志写入器分配（`appendEvent`）——
 *      前端按它去重与续订（`Last-Event-ID` 语义）；
 *   3. 判别联合用 `discriminatedUnion` 而不是 `z.union`：前者在解析失败时给出的
 *      报错会带上「哪个 type 的哪个字段不对」，排查坏日志时这是唯一有用的信息。
 */
import { z } from 'zod';
// `EvalRowStatusSchema` 给 status 事件；`RowMcpChannelSchema` 给 `vendor-system.mcpChannel`
// （同一份「通道」值域，与行级观测格的 `judgedBy` 同源派生——各写一份枚举必然漂移）
import { EvalRowStatusSchema, RowMcpChannelSchema } from './run';
import { ScoreResultSchema } from './score';

/** 事件公共字段：序号（从 1 开始）与 ISO 8601 时间戳 */
const baseFields = { seq: z.number().int().positive(), at: z.string() };

/**
 * `usage` 事件的计量三元组（2026-10-XX 扩展：后两格可选，见各自的注释）。
 *
 * ## 1. `input` 是**非缓存输入**——这条是三家归一后的结果，不是任何一家的原文
 *
 * 三家的厂商字段对 cache 的处置**根本不同**（逐条实测过，不是推测）：
 *
 * | 家 | 厂商字段 | `input` 原文是否含 cache |
 * |---|---|---|
 * | claude | `input_tokens` / `cache_read_input_tokens` / `cache_creation_input_tokens`（三格分列） | **不含**（Anthropic 语义） |
 * | codex | `inputTokens` / `cachedInputTokens`（cached 是 input 的**明细**；SDK 时代旧称 `input_tokens` / `cached_input_tokens`，右列那组读数就是那时的） | **含**（真机：`{input_tokens:8152, cached_input_tokens:6656}`，6656 < 8152） |
 * | dsh | `inputTokens` / `cacheReadTokens` / `cacheWriteTokens` / `totalTokens` | **不含**（本机恒等式判定：`1219 + 7040 + 0 + 1 = 8260`） |
 *
 * ⇒ 适配器**把 `input` 归一到「非缓存输入」**：claude / dsh 原样，codex 必须做减法
 * `input = inputTokens − cachedInputTokens`（落点在 `providers/codex/run-state.ts` 的 `normalizedInput`，
 * 消费方是 `providers/codex/events.ts`，那里写了「为什么」）。
 *
 * 这条归一是**跨家可比的唯一前提**，也是本仓「消灭按厂商分支」的落点：
 * 消费方拿到的事件永远是同一个口径，不必、也**不许**再去问「这一条是哪个家发的」。
 * 归一前 codex 的 `input` 里含 cache，于是同一个公式在 codex 上算出的分母偏大
 * ⇒ 命中率被系统性低估，而三个家看起来「都算对了」。
 *
 * ## 2. 派生公式（**在消费方算，适配器绝不预先算比率**）
 *
 * 为什么不算好再发：比率是**展示口径**，而同一个数在不同地方要的分母不一样（命中率要
 * `input + cached`，成本要 `input + output`，速度要 `output / 时长`）。适配器算好一个比率，
 * 换个口径就得改协议、就得兼容历史日志里那个已经算错的数。所以这里只保证**原料齐全**。
 *
 *   · **缓存命中率** = `cached / (input + cached)`
 *     分母是「本次 prompt 总量」：归一之后 `input`（未命中）与 `cached`（命中）**互斥**。
 *     只除 `input` 会算出 4051% 这种读不懂的数（真机 dsh：`input 218 / cached 8832`）。
 *   · **生成速率（tok/s）** ≈ `output / ((apiMs − ttftMs) / 1000)` —— **只有 claude 能这么算**
 *     （它同时有 `apiMs` 与 `ttftMs`，减掉首字等待才是真正的「生成」速度）；
 *     另两家没有 `apiMs` ⇒ 只能退化成 `output / (totalMs / 1000)`，而那个数**含工具执行时间**、
 *     与 claude 的那个**不可直接比**⇒ 显示时必须带上 `timing.source === 'events'` 的警示
 *     （口径差异见上面 `timing` 的注释）。
 *   · **首字延迟** = `ttftMs`（只有 claude 有）。
 *
 * ## 3. 缺失一律 `null`，绝不填 `0`
 *
 * `reasoningOutput` / `total` 采不到时是 `null`（不是 0）：`reasoningOutput: 0` 会让人得出
 * 「这家模型不做推理」的错误结论，而事实是「这家不上报这个数」。同理，`input` / `cached` / `output`
 * 三个必填格一旦缺任何一个，适配器就**整格交 `null`**（`tokens: null`）并落一条 WARN，
 * 而不是把缺的那个补成 0。
 */
export const UsageTokensSchema = z.object({
  /** **非缓存输入**（归一后；codex 已减去 cached，见上面第 1 节）。必填 */
  input: z.number(),
  /** **缓存读**（命中部分）。与 `input` 互斥 ⇒ 命中率的分母是两者之和。必填 */
  cached: z.number(),
  /** 模型输出。必填 */
  output: z.number(),
  /**
   * **思考 / 推理 token**（可选，`null` = 这家没报）。
   * 三家原文：claude 的 `output_tokens_details.thinking_tokens`、codex 的 `reasoningOutputTokens`
   * （app-server 的按线程累计里**运行期就在报**，主线程与每个子线程各一份；SDK 时代旧称
   * `reasoning_output_tokens`，那会儿才「只在会话文件里有」）、dsh 的 `reasoningTokens`
   * （当前通道不投送 ⇒ 恒 `null`）。
   * ⚠️ 它是**输出的一部分**还是**额外**的一格，三家口径不同 ⇒ **不要**把它加进 `output` 去算成本
   * （那会双计），只按它自己展示。
   */
  reasoningOutput: z.number().nullable().optional(),
  /**
   * **厂商自报的总量原文**（可选，`null` = 这家没报）。
   *
   * ⚠️ **它不参与归一后的恒等式**，别拿它去验算 `input + cached + output`：
   *   · dsh 的 `totalTokens` 实测是 `input + cacheRead + cacheWrite + output`（含**缓存写**，
   *     而本契约三元组里根本没有缓存写那一格）⇒ 两边天然对不上；
   *   · codex 的 `total_tokens` 含 `reasoning_output_tokens`，而 `output_tokens` 是否含推理
   *     也没有单独探测过。
   * 保留它的唯一理由是**排障**：能拿它和本仓归一后的数并排看，一眼看出「是厂商口径不同」
   * 还是「我们读错了字段」。它是**证据**，不是计算输入。
   */
  total: z.number().nullable().optional(),
});

/**
 * **一台 MCP 服务**在厂商系统层事件里的那一格（`error` 是第四格）。
 *
 * 为什么是对象而不是名字字符串：真机 claude 的 `system/init` 投的就是对象
 * （`mcp_servers: [{name,status,source}, …]`，四台真机样本与判据通道见
 * `docs/features/mcp-config.md` 的「三家的判据通道」），而这三个格各自回答一个不同的问题——
 * `name` 是哪一台、`status` 厂商报的连接状态（`pending` / `connected` / `failed` / `needs-auth`）、
 * `source` 它是从哪来的（`dynamic` = 本仓程序化注入 / `project` = 被测仓库自带 `.mcp.json`）。
 * 只留名字等于把「装没装上」「是谁下发的」两件事一起丢掉。
 *
 * `error` 是**厂商原文**：`MCP「<name>」未能启动：<厂商原文首行>` 这句文案里，
 * 唯一有价值的就是后半句，而它只在厂商这一格上（claude 的 `mcp_servers[].error`、
 * codex 的 `mcpServer/startupStatus/updated.error`；dsh 起不来时**不投结构化错误** ⇒ 恒 `null`，
 * 那一家的文案由判据侧自己说清凭什么）。
 *
 * **四格各自可空**（`null` = 厂商这一格没给）：与事件里那六格同一条口径——
 * `null` 是「没投送」，不是空值；**空字符串按「没给」处置**（厂商给空串与不给没有语义差别）。
 */
export const McpServerEntrySchema = z.object({
  name: z.string().nullable(),
  status: z.string().nullable(),
  source: z.string().nullable(),
  /**
   * 厂商原文（见上面那段）。`.default(null)` 而不是必填：早期落盘的
   * `events.jsonl` 里这一格**不存在**，写成必填会让那些条目解析失败 ⇒ 整条 `vendor-system` 被
   * `readEvents` 跳过（最难查的一类静默失败）。缺省读成「厂商没给」，**不编**。
   */
  error: z.string().nullable().default(null),
});

/** 一台 MCP 服务的推导类型：适配器与消费方（日志行 / 环境抽屉）都用它，别各写一份形状 */
export type McpServerEntry = z.infer<typeof McpServerEntrySchema>;

/** 一格文本：非字符串、空串都按「厂商没给」处置（`null`）——空串与不给在语义上没有差别 */
function entryText(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * **MCP 服务清单的读侧兼容归一**。
 *
 * 做什么：把任意形态的 `mcpServers` 一格读成 `McpServerEntry[] | null`——**唯一**一处认
 * 「历史字符串形态」的地方，契约 schema 与两个消费方都调它（两处各写一份必然漂移）。
 *
 * 怎么做（逐条判，不猜）：
 *   · **非数组 ⇒ `null`**（含 `undefined` / 字符串 / 数字）：厂商这一格没投送到我们能读的通道，
 *     按本仓那两句口径记「没投送」，**绝不**回一个 `[]`（那是「投送了，确实是空的」，与它含义相反）；
 *   · **数组 ⇒ 逐项归一**，`[]` 原样返回（投送了、清单确实是空的，这一态必须留得住）：
 *     - 字符串项 ⇒ `{name: 那一串, status: null, source: null, error: null}`。这是旧版落盘的
 *       `events.jsonl` 里的形态（适配器当时只留名字），历史行靠这一支才读得回来——名字是它当时
 *       真给了的，另三格它当时真没给，如实记 `null` 而不是编一个 `pending`/`project`；
 *     - 对象项 ⇒ 取 `name` / `status` / `source` / `error` 四格（非字符串或空串记 `null`）；
 *     - 其余项（数字、`null`、嵌套数组）**丢掉**：它是脏数据，但一项坏不牵连整格。
 *
 * 幂等：本函数对自己归一出来的形状再跑一遍结果逐字相同（消费方拿到已归一的形状时不必分支）。
 */
export function normalizeMcpServers(value: unknown): McpServerEntry[] | null {
  if (!Array.isArray(value)) return null;
  const entries: McpServerEntry[] = [];
  for (const item of value) {
    if (typeof item === 'string') {
      entries.push({ name: entryText(item), status: null, source: null, error: null });
      continue;
    }
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    entries.push({
      name: entryText(record['name']),
      status: entryText(record['status']),
      source: entryText(record['source']),
      error: entryText(record['error']),
    });
  }
  return entries;
}

export const AgentEventSchema = z.discriminatedUnion('type', [
  /** 行状态变更：与 EvalRow.status 同一套词，1:1 映射 */
  z.object({ ...baseFields, type: z.literal('status'), status: EvalRowStatusSchema }),
  /**
   * 一行日志：stdout / stderr 分流；适配器未识别的事件也要投影成一条 log 而不是丢弃。
   *
   * `summary` 是**给人看的一句话**（卡片底部的活动行显示的就是它）：
   *   · `text` 永远是**原始负载**（排障证据，抽屉逐字显示），`summary` 只是同一件事的人话版本
   *     （例如 dsh 的 `tool/call` 信封 → 「调用 pwsh：npm run build-only」）；
   *   · **可选**：适配器不认识那个形状时就没有它。消费方**不许**拿 `text` 去凑——JSON 不是消息
   *     （用户口径：那一行动效里绝不能出现 `{"method":"session.event",…}`）；
   *   · 刻意**不新增事件类型**：原始行已经落盘了，再加一条「只为人看」的行等于让抽屉噪声翻倍
   *     （dsh 投影文件头里对 `session.status` 的处置是同一条口径）。
   */
  z.object({
    ...baseFields,
    type: z.literal('log'),
    stream: z.enum(['stdout', 'stderr']),
    text: z.string(),
    summary: z.string().optional(),
  }),
  /**
   * **厂商系统层事实**：本次运行被下发了什么（工具面 / 斜杠命令 /
   * 子智能体定义 / 权限档 / 输出风格 / MCP 服务）。
   *
   * 为什么必须是**独立事件**而不是让消费方去解析那条 `log` 原文：
   *   · 原文是**排障证据**，形状由厂商定、随版本漂移；消费方逐字认 `subtype === 'init'` /
   *     `slash_commands` / `permissionMode` 就是把厂商适配搬进了浏览器（本仓的边界是
   *     「厂商差异全部吸收在 agents 包内」）；
   *   · 归一之后，加第四家或厂商改字段只动适配器一处，界面与环境抽屉一行不改。
   *
   * **六格各自可空**：`null` = 这一格厂商没投送到我们能读的通道（`not-exposed`），
   * **不是空数组**——`[]` 的含义是「采到了，确实是空的」，两者在界面上是两句不同的话
   * （「没投送」vs「一个都没有」）。整条事件**只在厂商真的投送了这一行时才有**：
   * 没有这一行的那一家（codex / dsh 都没有 `system/init`）**不发这条事件**，
   * 消费方据此整组走 `not-exposed`，而不是显示成一堆空值。
   */
  z.object({
    ...baseFields,
    type: z.literal('vendor-system'),
    /** 厂商自报的**工具面**（「它当时手里有什么」；与「它用了什么」是两件事，后者从调用统计来） */
    tools: z.array(z.string()).nullable(),
    /** 斜杠命令 / 子智能体定义；拿不到为 `null` */
    slashCommands: z.array(z.string()).nullable(),
    agents: z.array(z.string()).nullable(),
    /**
     * 厂商下发的 **MCP 服务清单**（对象数组，见 `McpServerEntrySchema`）。
     *
     * 为什么必须是对象数组而不是字符串数组：真机 claude 投的就是对象数组，只留字符串项会把
     * 四台折成 `[]`，而 `[]` 在本仓的定义是「投送了，确实是空的」——事件流里于是留下
     * 「厂商一台都没下发」这句假话，真正的四台只剩原始 JSON 那条 log。
     *
     * **同时收下历史形态**（`z.string()` 那一支）：旧版落盘的 `events.jsonl` 里
     * 这一格就是字符串数组，写成只认对象会让那些历史行**整行**解析失败——`core` 的 `readEvents`
     * 只 WARN 后跳过 ⇒ 抽屉里那一整条 `vendor-system` 凭空消失。归一的落点是
     * `normalizeMcpServers`（一处共用），读回来的老形态是 `{name, status: null, source: null}`。
     */
    mcpServers: z
      .array(z.union([McpServerEntrySchema, z.string()]))
      .nullable()
      .transform(normalizeMcpServers),
    /**
     * 这一条里的 MCP 事实是从**哪个通道**读到的（三家各一格）。
     *
     * 为什么要由事件自报：行级观测格的四个结论有一半来自形状，而**同一个形状在不同通道上读法相反**
     * ——「工具表里没有这一台」在 claude / codex 上是「不判失败」，在 dsh 上**就是判失败**
     * （它起不来时工具静默消失、会话照常跑完、没有任何结构化错误）。让事件自报通道之后，
     * 推导不必按厂商名去查一张静态表（声明与实际读到的东西会各自漂移），`events.jsonl` 也自证得清。
     *
     * `.optional()`：早期落盘的 claude 事件里没有这一格，写成必填会让它整行解析失败
     * （同上面 `mcpServers` 的历史兼容）。缺格按 `'vendor-status'` 处置——那是当时唯一存在的通道。
     */
    mcpChannel: RowMcpChannelSchema.nullable().optional(),
    /** 厂商回显的权限档（真机 `bypassPermissions` 逐字）：**它比本仓那份常量更可信**，见环境抽屉 */
    permissionMode: z.string().nullable(),
    outputStyle: z.string().nullable(),
  }),
  /**
   * 计量快照。两个字段**各自独立**（用户口径）：
   *   · `turns` **必填**——「到目前为止观察到的主循环模型请求次数」（一次模型 API 往返算一次）。
   *     它是本轮唯一能实时、跨三家同口径拿到的量（claude-code 数 `assistant.message.id`、
   *     dsh 数 `step`、codex 数模型产出条目），故每见到一次新请求就该发一条事件；
   *   · `tokens` **可空**——采不到就是 `null`（绝不发三个 0）。
   *
   * 为什么 tokens 从「必填」放宽成「可空」：原来的 schema 要求 tokens 与 turns 同时在，
   * 于是 claude-code 的轮次被**它采不到的 token** 拖住——实测一轮 60 次模型往返，
   * 整轮只发得出一条 `usage`（`turns: 1, tokens: {0,0,0}`），界面于是永远停在「轮次 1」。
   * 轮次是独立的一把尺子，不该等另一把尺子。
   */
  z.object({
    ...baseFields,
    type: z.literal('usage'),
    /**
     * **这一格的累计口径跟着 `turn` 走**（与 `turn` 那一格成对）：
     *   · `turn` 缺省 / 显式 `null` / `turn.subagentId === null`（**主会话读数**）⇒ 它是**本行**的累计
     *     快照（覆盖语义：每见一次新读数就发一条带累计值的快照）；
     *   · `turn.subagentId` **非空**（**子会话读数**）⇒ 它是**那个子会话自己的**累计（前 k 轮之和，
     *     k = `turn.round`；累计 ⇒ 单调不减 ⇒ 每轮都成为里程碑）。
     *
     * 为什么子会话那一条**不能**给「行累计」：收尾那一刻只确知「主会话的最终值 + 各子会话的逐轮值」，
     * 每轮的「行累计」需要真实的交错时刻才算得出来，那是**造数** ⇒ 宁可给这一份
     * 说得清的、也不编那一份说不清的。
     *
     * ⚠️ 因此**不许**拿「`tokens` − `subagentTokens`」去反推带会话身份那一条里的主会话：那个减法
     * 只在**主会话读数**上成立（`subagentTokens` 是**行级**分量，与「这个会话花了多少」不是一把尺子）。
     * ⚠️ 这一点与 dsh **不同**（dsh 的子会话读数给的是**全树**累计）——是**已知差异**，跨家比这一格
     * 之前先看 `turn`。
     */
    tokens: UsageTokensSchema.nullable(),
    /**
     * `tokens` 那一格是**厂商上报的权威值**还是**我们的跑动期估算**。
     *
     * 只描述 `tokens`：`turns` / `subagentTokens` / `subagentTurns` **恒为权威值**
     * （骨架里只有 `tokensEstimated` 一个标记，它只挂在 tokens 那一支上）。
     *
     * 为什么要有一格而不是让消费方按厂商/能力去推：估算与权威在事件里长得一模一样
     * （都是「到目前为止的累计」），而消费方的处置**相反**——今天的读侧就是编排层的跑动期回写段
     * （`orchestrator.ts` 的 `onEvent`）：只有显式 `'reported'` 才写快照，估算值只走事件流给界面看。
     * 让每条事件自报来源之后，那一层不必在跑之前反查注册表的 `capability.liveUsage`
     * （能力判定全部收进 `agentProvider.run`）。
     *
     * `.optional()`：老事件没有这一格 ⇒ 读侧按 `'estimated'`（安全侧：宁可不落盘，
     * 也不把估算写进唯一落盘真相）。
     */
    tokensBasis: z.enum(['reported', 'estimated']).optional(),
    /**
     * **子智能体那一份**用量：`tokens` 已是「主会话 + 全部子智能体」的合计，
     * 这一格是其中的分量。界面用它把 Tooltip 拆成两行（主会话 / 子智能体）。
     *
     * 三档语义（**与 `tokens` 的 null 不是同一件事**）：
     *   · 整格缺席 = 这条事件来自还没有这一格的旧版本，或这一条没带这一格（消费方保持上一份）；
     *   · `null` = 有子智能体但**没采到**（含「有任何一个子智能体读失败」）——
     *     此时 `tokens` 退回主会话口径；
     *   · `{0,0,0}` = **确实没有子智能体**。
     *
     * 为什么不并进 `tokens`：合计与分量是两件事实，消费方（卡片 Tooltip）两件都要；
     * 只给合计的话界面就只能显示一个说不清来源的数。**它不是第二份真值**：恒有
     * `subagentTokens ≤ tokens`（逐格），主会话那一行由相减得出。
     * ⚠️ 那条不等式只对**主会话读数**（`turn` 缺省 / `null` / `subagentId === null`）成立：带非空
     * `subagentId` 的读数里 `tokens` 是**该会话自己的累计**（见 `tokens` 那一格的注释），两者不同尺，
     * **不许相减**（那是「读数口径跟着 `turn` 走」的另一半）。
     */
    subagentTokens: UsageTokensSchema.nullable().optional(),
    /**
     * **子智能体那一份**轮次（与上一格同一条处置）：`turns` 已是「主会话 +
     * 全部子智能体」的合计，这一格是其中的分量。界面用它把「轮次」那一格的 Tooltip 拆成两行
     * （主会话 = `turns − subagentTurns`）。
     *
     * 三档语义与 `subagentTokens` **逐字相同**（**与 `turns` 的 null 不是同一件事**）：
     *   · 整格缺席 = 这条事件来自还没有这一格的旧版本，或这一条没带这一格（消费方保持上一份）；
     *   · `null` = 有子智能体但**没采到轮次**（含「有任何一个子智能体读失败」）——
     *     此时 `turns` 退回主会话口径；
     *   · `0` = **确实没有子智能体**（子智能体一个往返都没跑）。
     *
     * ⚠️ **`null` 与 `0` 在这一格上含义相反**（与 `subagentTokens` 的 `{0,0,0}` / `null` 同源）：
     * 界面只在「有分量且大于 0」时才画第二行，于是两者都只画一行——但契约与日志里
     * 「没采到」与「确实没有」必须长得不一样。**恒有 `subagentTurns ≤ turns`**。
     */
    subagentTurns: z.number().nullable().optional(),
    /**
     * 这一条读数**属于哪一轮**：
     * `subagentId` = 会话身份（`null` = 主会话，与 `SubagentRecord.subagentId` / `LogTurn.subagentId`
     * 同一套 id），`round` = **该会话自己的**第几次模型往返（每会话各自 1..N）。
     *
     * ⚠️ 与同一对象里那个 `turns`（**必填**、本行累计轮次、服务进度条与 `EvalRow.turns`）
     * **不是一回事**，两者不得互相顶替：`turns` 回答「这一行跑到第几轮了」（行尺度），
     * 这一格回答「这一条读数发生在哪一轮」（会话尺度）。界面按它把「用量 … 轮次 N」放回**它自己那一轮**；
     * 只按 `turns` 放会得到「里程碑全挤在最后一轮」。
     *
     * ⚠️ **读数的口径跟着这一格走**：`subagentId === null` 的那一条是**主会话**的读数
     * （`tokens` = 本行累计）；`subagentId` **非空**的那一条是**那个子会话自己**的读数（`tokens` = 该会话
     * 自己的累计，见 `tokens` 那一格的注释）——**别把两者放进同一条累计序列**（那正是真机那次
     * 「子任务的用量写到主会话里了」的形状）。界面按这一格**分桶**比较：每个会话只与自己的上一条比。
     * 同一对象里的 `subagentTokens` / `subagentTurns` 则**恒是行级分量**（不随这一格变），不要用它去反推
     * 带会话身份那一条的「主会话那一份」。
     *
     * 为什么整格可选（与 `timing` 同一条处置，**不是** `subagentTokens` 那种三态）：
     *   · 磁盘上已有大量没有这一格的 `usage` 行，写成必填会让老日志在回放 / SSE 续订时成片解析失败；
     *   · 「键缺席」与「显式 `null`」在读侧**是同一件事**（没有归属信息 ⇒ 界面按时刻归位）——
     *     这一格没有 `subagentTokens` 那种「没采到 vs 确实没有」的语义差。
     */
    turn: z
      .object({
        subagentId: z.string().nullable(),
        round: z.number().int().positive(),
      })
      .nullable()
      .optional(),
    /**
     * 这一轮的时间数据（2026-10-XX 新增）。**整格可选且可空**：采不到就是「没有这一格」或
     * 显式的 `null`，一个 0 都不许编（`totalMs: 0` 会被读成「瞬间跑完」，与「没采到」含义相反，
     * 正是那条硬口径要防的）。
     * 为什么**可缺**而不是必填可空：磁盘上已有的历史 `usage` 行里没有这一格，写成必填会让
     * 所有老日志在回放 / SSE 续订时**成片解析失败**（`log.summary` 当初放宽成可选是同一条理由）。
     * 今天新写的事件一律带它（`null` 表示未采集）——见 agents 的 `emit.ts` 里那一格是必填的草稿。
     *
     * **必须带 `source`，因为三家拿到的根本不是同一种东西**：
     *   · `'vendor'` = **厂商自报**的时长（claude 的 `result.duration_ms` / `duration_api_ms` / `ttft_ms`）。
     *     它是**纯模型时间**：工具执行、文件读写、子进程等待都不在里面；
     *   · `'events'` = **我们按事件/行时间戳算出来的**（codex 的会话文件行 `timestamp`、dsh 的会话事件 `time`）。
     *     它是**墙钟**：把工具执行、等待子进程、重试全部算了进去。
     * ⇒ 两者**不可直接比**（同一个模型在 codex 上的 tok/s 会因工具耗时天然偏低）。不标出来源，
     *   消费方就会把「一个含工具耗时、一个不含」的两个数放进同一张对比表——那是本仓最忌讳的
     *   「看起来可比，其实两个口径」。
     *
     * 各格的口径（全部可空、缺失一律 `null`）：
     *   · `totalMs`：**整轮**时长（含工具执行）。`'vendor'` 时是厂商原文，`'events'` 时是
     *     首末时间戳之差；
     *   · `apiMs`：**只有 claude 有这一个原生字段**（`duration_api_ms` = 仅 API 往返的时间）。
     *     另两家采不到 ⇒ `null`（**不许**拿 `totalMs` 冒充：那会把工具耗时算进模型速度）；
     *   · `ttftMs`：首 token 时延（claude 的 `ttft_ms`）。另两家采不到 ⇒ `null`。
     */
    timing: z
      .object({
        totalMs: z.number().nullable(),
        apiMs: z.number().nullable(),
        ttftMs: z.number().nullable(),
        source: z.enum(['vendor', 'events']),
      })
      .nullable()
      .optional(),
    turns: z.number(),
  }),
  /** diff 计数摘要：正文不落库，打开抽屉时按需现算 */
  z.object({
    ...baseFields,
    type: z.literal('diff-summary'),
    filesChanged: z.number(),
    insertions: z.number(),
    deletions: z.number(),
    truncated: z.boolean(),
  }),
  /** 评分结果：整份 ScoreResult 随事件落盘，抽屉直接读它 */
  z.object({ ...baseFields, type: z.literal('score'), score: ScoreResultSchema }),
  /** 失败归因：message 是给用户看的中文，stack 可省 */
  z.object({ ...baseFields, type: z.literal('error'), message: z.string(), stack: z.string().optional() }),
  /** 运行结束：exitReason 是 AgentExitReason 的字符串形式（不引入 agents 依赖） */
  z.object({ ...baseFields, type: z.literal('end'), exitReason: z.string() }),
]);
export type AgentEvent = z.infer<typeof AgentEventSchema>;
/** 计量三元组（+ 两个可选格）的推导类型：适配器与消费方都用它，别各写一份形状 */
export type UsageTokens = z.infer<typeof UsageTokensSchema>;
/**
 * `usage` 事件里那格时间数据的推导类型。
 * `Extract<AgentEvent, …>` 只为拿到这个成员；`NonNullable` 去掉外层的 `| null`——适配器内部
 * 传递时形状恒定（缺数据是**整格不发**，不是发一个各格为 null 的对象），
 * 而 `null` 那一档由「有没有这一格」表达（见 `emit.ts` 的 `AgentEventDraft`）。
 */
export type UsageTiming = NonNullable<Extract<AgentEvent, { type: 'usage' }>['timing']>;
/**
 * `usage` 事件里那格归属信息的推导类型。与 `UsageTiming` 同一条处置：
 * `NonNullable` 去掉外层的 `| null`——适配器内部传递时形状恒定（没有归属由草稿层的 `null` 表达）。
 */
export type UsageTurn = NonNullable<Extract<AgentEvent, { type: 'usage' }>['turn']>;

/** 八个事件类型：SSE 过滤与界面分组用；与上面联合的成员一一对应 */
export const AGENT_EVENT_TYPES: readonly AgentEvent['type'][] = [
  'status', 'log', 'vendor-system', 'usage', 'diff-summary', 'score', 'error', 'end',
];
