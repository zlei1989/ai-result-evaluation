/**
 * dsh 会话通知的**判别常量**（真机逐字核过，见 `probe/dumps/v4/dsh-*.jsonl`）。
 *
 * 为什么单独一个模块：`events.ts`（行级事件投影）与 `message.ts`（内容级消息归一）都要按这些
 * 字符串分流，两处各写一份必然漂移——而漂移的症状是「某一类通知在事件里出现、在消息里消失」
 * （或反过来），排查时看不出是哪一层丢的。
 *
 * 通知共四种 method：`session.event`（具体事件，判别字段是 `params.event.type`）、
 * `session.status`（会话级状态）、`subagent.started`、`subagent.finished`。后两种是**顶层通知**，
 * 不套在 `session.event` 里。
 *
 * ⚠️ 它**同时是 dsh 用量字段名与读法的唯一真源**：`events.ts`（行级累计）与
 * `message.ts`（消息级那一次调用）都按同一份字段名读——两处各写一份必然漂移，而漂移的症状是
 * 「事件里的用量对、消息上的用量不对」（或反过来），界面上看着都正常。
 */
import type { UsageTokens } from '@aieval/contracts';
import { asRecord, readNumber } from '../../json';

/** 承载会话事件的通知方法名；其余方法（`session.status` 等）不产生事件。 */
export const DSH_SESSION_EVENT_METHOD = 'session.event';
/** 携带用量与会话消息的通知方法名（实测：用量挂在它的 `data.usage` 上，正文在 `data.message` 上）。 */
export const DSH_ASSISTANT_MESSAGE_TYPE = 'assistant/message';
/** 轮次结束的事件类型（实测：失败与收尾从这里取）。 */
export const DSH_TURN_END_TYPE = 'turn/end';
/** **一次模型 API 往返**的落点（实测：`turn/start` 之后、`assistant/message` 之前）——轮次在这里 +1 */
export const DSH_STEP_START_TYPE = 'step/start';
/** 轮次开始（用户口径：卡片底部的活动行滚动**事件消息**，轮次边界也是一条） */
export const DSH_TURN_START_TYPE = 'turn/start';
/** 工具调用事件类型（实测：`data.{name, arguments}`，`arguments` 是 JSON 字符串） */
export const DSH_TOOL_CALL_TYPE = 'tool/call';
/** 工具结果事件类型（实测：`data.message.{content[], isError}`，结构化结果在同级 `data.meta` 里） */
export const DSH_TOOL_RESULT_TYPE = 'tool/result';
/**
 * **每次模型往返都会投**的那一条请求头：`data.header.tools` 就是那一轮模型看到的工具面。
 *
 * 它是 dsh 侧 MCP 的**唯一判据**：这一家起不来时工具**静默**从表里消失
 * （四臂实测）——会话照常跑完、`turn/end` 照常 `completed`、
 * SDK 不抛错、`failOnStartupError` 真假在观察面上没有差异 ⇒ 除了「表里有没有它的工具」，
 * 我们这一侧没有任何别的信号。工具名的形状与另两家一致：`mcp__<serverName>__<tool>`。
 */
export const DSH_REQUEST_HEADER_TYPE = 'request/header';
/**
 * **注入的 user-role 消息**（真机：`data.content[0].text` 是正文，`data.source.kind` 说明它是什么）。
 *
 * 它是 skills 那一格的载体：这一家把「本次会话有哪些 skill」合成一条 user 消息塞进提示词
 * （真机全轮**恰好一条**）。⚠️ 它必须**显式分流**——未识别的 `session.event` 会走
 * `unknown(raw)` 兜底，落成一条几十 KB 的原始 JSON 日志，把「原始输出」面板刷满。
 */
export const DSH_USER_MESSAGE_TYPE = 'user/message';
/** 上一条消息里「技能目录」那一类的 `data.source.kind`（真机逐字） */
export const DSH_SKILL_CATALOG_KIND = 'skill-catalog';

/**
 * 子智能体**派生**通知的方法名（真机 `subagent.started` ①）。
 * ⚠️ 它是**顶层通知**（`{ method, params }`），**不是** `session.event` 包一层——
 * 这是它必须显式分流的原因（只认 `session.event` 一种外形会把它落进 `unknownEventDraft`）。
 */
export const DSH_SUBAGENT_STARTED_METHOD = 'subagent.started';
/** 子智能体**收场**通知的方法名（真机 ③：身份 / 终态 / 结果全在这一条） */
export const DSH_SUBAGENT_FINISHED_METHOD = 'subagent.finished';
/**
 * 子任务目录项（`session.event` 里的 `subagent/catalog`，真机 ②）。
 * **任务名（`label`）与 mode 只在这一条里** ⇒ 必须跨消息记住，否则 start/finish 都拿不到名字。
 */
export const DSH_SUBAGENT_CATALOG_TYPE = 'subagent/catalog';
/** 子任务目录项的第二种载体（子会话里的事件，身份只在信封 `params.sessionId` 上） */
export const DSH_SUBAGENT_DESCRIPTOR_TYPE = 'subagent/descriptor';
/**
 * **流式增量伪事件**（stream-tap 机制——本仓自造、不经厂商通知通道）。
 *
 * 厂商的逐字流（`agent/assistant-stream` 进程内事件）不投送到 stdio 通知流（任何版本都不投，
 * 见 `docs/faq/deepseek-harness.md`），适配器把一个插件写进每行的 profile 目录、由它把
 * `StreamChunk` 旁路到 `<configHome>/aieval-stream-tap.jsonl`；适配器 tail 该文件后包成这种
 * `session.event` 形状的**伪通知**喂给投影——与真通知同一条 `project` 路径，读侧零分叉。
 *
 * 命名与处置两条硬口径：
 *  · 类型名用 **delta**（与契约词汇 `chunk: 'delta'` 同源），不用厂商存储层的 `chunk`/`text-chunks`
 *    字眼——那两个词在本仓另有所指（信封字段 / packed row），混用排障时对不上号；
 *  · `events.ts` 里**必须显式分流**：这一支只产 `chunk: 'delta'` 的内容消息、**零事件草稿**——
 *    绝不能落进「未识别厂商负载一律落 `log`」的兜底（否则一条增量一行 log，原始输出面板
 *    会被几百条 JSON 刷满，真要看的 stderr 反而没了）。
 */
export const DSH_STREAM_DELTA_TYPE = 'aieval/delta';

/**
 * **通知流中断伪事件**（同样是本仓自造）：适配器观察到自己的通知订阅**中途失败**
 * （SDK 的 `NotificationSubscriptionImpl.fail()`——过滤器抛错、或传输读循环死掉）时补投的一条
 * `session.event`，投影成一条 stderr 的 `log`。
 *
 * 为什么必须有它：那种失败在 SDK 里是**静默**的（兄弟订阅与传输不受影响），把它当成「流正常结束」
 * ⇒ 症状是**执行日志整段空白、行照旧判成功、任何日志里都没有线索**
 * （run `7f05c765` 的 dsh 行：厂商会话日志 201 条事件、我们只收到前 13 条）。
 * 与 `DSH_STREAM_DELTA_TYPE` 同一处置纪律：**显式分流**，且这一支**只产一条 log**，
 * 绝不许落进「未识别负载」的兜底（那会把一条诊断淹没在几百条 JSON 里）。
 */
export const DSH_STREAM_FAILURE_TYPE = 'aieval/stream-failure';

/**
 * 用量三元组的字段名，**逐字来自真实探测**（`probe/dumps/dsh.json` 的
 * `assistant/message → data.usage`）：`{"inputTokens":218,"outputTokens":2,"cacheReadTokens":8832,…}`。
 *
 * ⚠️ 字段名表住在这里：`message.ts`（消息归一）也要按同一份字段名读，
 * 而 `events.ts` 已经 import `message.ts` ⇒ 留在那边就是**循环依赖**。
 * `events.ts` 继续 re-export 这个名字，既有 import 路径不动。
 */
export const DSH_USAGE_FIELDS = {
  input: 'inputTokens',
  cached: 'cacheReadTokens',
  output: 'outputTokens',
  /** 思考 token（`TokenUsage.reasoningTokens`，类型上可选）：**采不到就是 null，不填 0** */
  reasoning: 'reasoningTokens',
  /** 厂商自报的总量（`TokenUsage.totalTokens`）：**只是证据**，不参与归一后的恒等式（见契约注释） */
  total: 'totalTokens',
} as const;

/**
 * 读一次模型调用的用量：三项（非缓存输入 / 缓存读 / 输出）缺一 ⇒ `null`（**不填 0**）；
 * 可选两格（思考 token、厂商总量）读不到就是 `null`。
 *
 * **纯函数**：不落日志、不改状态——落 WARN 是调用方（`events.ts` 的 `readTokens`）的事，
 * 因为消息归一那一层没有 drafts 收集器（这是我们把它抽出来的直接原因）。
 */
/**
 * 从 `request/header` 的 `data` 里读**工具名清单**；读不到给 `null`。
 *
 * 两条口径：
 *   · **只取名字**（真机同一条里每把工具还带几百字的英文 `description`）：描述对判据毫无用处，
 *     进事件流只会把它撑大（一条 header 几十 KB × 每个 step 一条）；
 *   · **形状不对就是 `null`**（没有 `header` / `tools` 不是数组 / 项不是对象）：`[]` 在本仓的定义是
 *     「投送了、确实是空的」，拿一个读不动的形状去发它等于说一句假话 —— 而这句话会让推导
 *     把一台明明起来了的 MCP 判成「没起来」。
 */
export function readHeaderTools(data: unknown): string[] | null {
  const tools = asRecord(asRecord(data)?.header)?.['tools'];
  if (!Array.isArray(tools)) return null;
  const names: string[] = [];
  for (const tool of tools) {
    const name = asRecord(tool)?.['name'];
    // 一项坏不牵连整表：认得出的照留（与契约的 `normalizeMcpServers` 同一条处置）
    if (typeof name === 'string' && name !== '') names.push(name);
  }
  return names;
}

export function readUsageTokens(usage: unknown): UsageTokens | null {
  const record = asRecord(usage);
  const input = readNumber(record, DSH_USAGE_FIELDS.input);
  const cached = readNumber(record, DSH_USAGE_FIELDS.cached);
  const output = readNumber(record, DSH_USAGE_FIELDS.output);
  if (input === null || cached === null || output === null) return null;
  return {
    input,
    cached,
    output,
    reasoningOutput: readNumber(record, DSH_USAGE_FIELDS.reasoning),
    total: readNumber(record, DSH_USAGE_FIELDS.total),
  };
}

/** `<available_skills>` 块的登记行：`- \`<name>\`: <description>`（真机逐字） */
const SKILL_CATALOG_LINE = /^-\s+`([^`]+)`\s*:/;
/** 块围栏（厂商原文；两行之间的登记行才是清单本体） */
const SKILL_CATALOG_OPEN = '<available_skills>';
const SKILL_CATALOG_CLOSE = '</available_skills>';

/**
 * 从 `user/message` 的 `data` 里读**技能目录里的名字**；读不到给 `null`。
 *
 * 形状（真机）：`data.source.kind === 'skill-catalog'` 的那些消息，正文是
 * ```
 * <system-reminder>
 * A skill is a reusable set of task-specific instructions. The following skills are available in this session:
 *
 * <available_skills>
 * - `agents-skill`: probe skill agents-skill
 * ...
 * </available_skills>
 * ```
 * 正文可能落在 `data.content[]`（user-role 消息的本体）——`.text` 块的原文按 `readContentText` 的
 * 口径拼起来再切块；`data.message.content[]`（另一条既有载体的形状）也读，两处都读不到就是 `null`。
 *
 * ⚠️ **判据是 `<available_skills>` 块本身，不是「正文里出现过这个词」**：真机控制臂（一个 skill
 * 都没有）用 grep 那个词会得到 5 条噪声——厂商自己的提示词与工具描述里就有它。
 * 两条口径：
 *   · 块在、行读得出 ⇒ 名字数组（`[]` = 「投送了、确实一条都没有」）；
 *   · 块不在 / 正文读不出 ⇒ `null`（采不到）——与上一条是两句不同的话。
 */
export function readSkillCatalog(data: unknown): string[] | null {
  const record = asRecord(data);
  if (record === null) return null;
  const text = contentText(record['content']) || contentText(asRecord(record['message'])?.['content']);
  if (text === '') return null;
  const open = text.indexOf(SKILL_CATALOG_OPEN);
  const close = text.indexOf(SKILL_CATALOG_CLOSE, open + SKILL_CATALOG_OPEN.length);
  if (open < 0 || close < 0) return null;
  const names: string[] = [];
  for (const line of text.slice(open + SKILL_CATALOG_OPEN.length, close).split('\n')) {
    const matched = SKILL_CATALOG_LINE.exec(line.trim());
    // 一项坏不牵连整块（与 `readHeaderTools` 同一条处置）
    if (matched !== null && matched[1] !== undefined && matched[1] !== '') names.push(matched[1]);
  }
  return names;
}

/** `content[]` 里的文本块按顺序拼成一个字符串；形状不对给空串 */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      const record = asRecord(block);
      return record?.['type'] === 'text' && typeof record['text'] === 'string' ? record['text'] : '';
    })
    .filter((text) => text !== '')
    .join('\n');
}
