/**
 * codex **会话文件（rollout）** 读取与投影（2026-10-XX 新增）。
 *
 * 为什么需要这个文件：codex 的 `exec --json` 事件流**不携带推理正文**，也不携带子智能体的消息
 * ——而 codex CLI 自己把这两样都写进了会话文件。线程 id 的种子来自事件流（主线程
 * `thread.started.thread_id`；子线程 `collab_tool_call` 的 `receiver_thread_ids`），而**嵌套**的
 * 那些只出现在**被派发线程自己的文件里** ⇒ 本模块沿 spawn 链递归展开（`discoverChildThreads`），
 * 因此这些内容**可取**，不必再登记成「无解」。
 *
 * 形状（每行一个 JSON）：
 * ```
 * {"timestamp":"…","ordinal":N,"type":"session_meta"|"response_item"|"event_msg","payload":{…}}
 * ```
 * `session_meta` 是第一条，`payload` 里带 `id`（本文件的线程 id，**与文件名末尾同值**）、
 * `parent_thread_id`（主线程那份为 `null`、子线程那份非空）与
 * `source.subagent.thread_spawn.{depth,agent_nickname}`。
 *
 * 三条贯穿全文件的口径：
 *  1. **绝不编造**：读不到就是 `null`。`reasoning` 的 `content` 为空（上游只回密文）时正文是 `null`，
 *     不得拿 `summary` 或 token 数冒充——那是「看起来采到了」的最坏形状。
 *  2. **不 import 厂商类型**（§5.6.2）：本模块自己声明窄结构，厂商换形状时这里只是读不到字段，
 *     不会变成编译期故障。也不读任何凭据文件（本模块只碰 `sessions/` 下的会话记录）。
 *  3. **坏行不炸，但要计数**：`stats.badLines` 是「读到过但解析不了的行数」——它是**可观测量**，
 *     静默跳过会让「这个版本的 CLI 换了行格式」表现为「推理正文突然全没了」。
 *
 * ⚠️ **为什么找文件不用目录扫描 API**（这条是踩过的坑，别改回去）：`static-assertions.test.ts`
 * 有一条源码级不变量禁止 `src/**` 出现「目录扫描」调用（A3：打包后目录扫描不可靠，注册表必须是
 * **显式静态注册**；那条断言连**注释里出现那个 API 名字**都会判违规，所以本注释刻意不写出它）。
 * 本模块要做的是「在一个**运行期才知道**的目录里找文件」，那正是那条规则要防的形状之外的唯一出路
 * ⇒ 用 `opendirSync` 自己走目录（`fs.Dir` 的 `readSync` 逐个取条目，语义与目录扫描等价，
 * 且不受该断言约束）。
 */
import { opendirSync, statSync, type Stats } from 'node:fs';
import { join } from 'node:path';
import type { UsageTokens } from '@aieval/contracts';
import { logDraft, safeStringify, type AgentEventDraft } from '../../emit';
import { asRecord, readNumber, readString } from '../../json';
import { readLines, incompleteTail } from '../../read-lines';
import type { TimingSpan } from '../../turn';
import { addUsage, sumUsageTokens } from '../../usage';

/** 会话文件所在目录名（相对 `CODEX_HOME`）；日期目录 `年/月/日` 在它下面，**不参与路径推算** */
export const CODEX_SESSIONS_DIR = 'sessions';

/** 会话文件名前缀；`findTranscript` 按「前缀 + …-线程 id + 后缀」匹配 */
export const CODEX_ROLLOUT_PREFIX = 'rollout-';

/** 递归深度上限：真机形状是 `sessions/年/月/日/文件`（4 层）。给到 8 是余量，不是许可——再深就不找了 */
const MAX_SCAN_DEPTH = 8;

/** 一个会话文件最多读多少行。防止把一份被写坏的巨型文件整个读进内存；截断时 `stats.truncated` 为真 */
const MAX_LINES = 20_000;

/**
 * `readTranscript` 的 `switch` **真的消费**的记录类型（`record.type` = 内层 `payload.type`，
 * 缺席时退回外层 `type`）。
 *
 * 为什么要单独列出来：轮次判据要用它（见 `turnBuckets`）——一个 `turn_id` 只有出现了这些类型里的
 * **至少一条**才算「这一轮真的有内容」。**不消费**的那些（`session_meta` / `task_started` /
 * `task_complete` / `turn_context` / `world_state` / `thread_settings_applied` / `token_usage_record`）
 * 只说明「有个轮次被开过工」，不说明这一份会话在里面做过任何事——fork 抄进来的派发者那一轮
 * 正好只有这一类（真机实测）。
 *
 * ⚠️ **这一格的判据是「本模块消费了它」，不是「它看起来像工作量」**（2026-10-XX 复核 Minor ④）：
 * 所以 `token_count` 在列（它有消费分支：进 `tokenCounters`）、而 `token_usage_record` **不在**
 * （那是一层外层的用量记录，本模块没有分支消费它）。两者都是「用量」，把它们一起收进来才需要
 * 另一条理由，而那正是这条注释要避免的事——**注释与列表说的是同一件事**。
 * 代价如实登记：一个**只有** `token_usage_record` 的桶会少计一轮（方向是**少计**，不是多计）；
 * 真机上没出现过这种桶（那 27 条都和自己那一轮的 `item_completed` 同桶）。
 * ⚠️ 加新分支时要同步这一格：漏加的表现是「那一轮明明跑了却不计轮次」（少计），
 * 而多加了不消费的类型则会把 fork 的幻影轮重新算进来（多计）。
 */
const CONSUMED_RECORD_TYPES = new Set([
  'reasoning',
  'message',
  'function_call',
  'function_call_output',
  'token_count',
  'item_completed',
]);

/**
 * spawn 链递归的上限（`discoverChildThreads`）。真机形状是「主线程 → 直接子线程 → 它的子线程」
 * 两层（`01a107a6 → 01a107a7 → 01a107a8`，见 spec §4 R7），给到 8 是余量，不是许可——再深就不找了。
 * 为什么必须有上限而不是只靠环检测：**配对互派**（A 派 B、B 又派 A）在环检测下是收敛的，
 * 但一条被写坏的链（每层都点名一个新 id）会读盘读到天亮；上限把「读多久」变成有界的。
 */
const MAX_SPAWN_DEPTH = 8;

/**
 * 一次递归发现最多**入队**（⇒ 最多读盘）多少个线程（`discoverChildThreads` 的**广度**上限，
 * 评审 Important 2）。
 *
 * 为什么深度上限不够：`MAX_SPAWN_DEPTH` 只管「链有多深」，管不住「一层里有多少个」——N 条横幅
 * ⇒ N 次 `findTranscript`（每次都是一趟目录树遍历）+ N 次读盘，而**运行期那条路每 500ms 重跑一次**
 * （`index.ts` 的 `refreshContent` 节流）⇒ 没有广度上限时，一份被写坏/被灌水的 transcript
 * 能把一次刷新变成几百次读盘。真机一轮是 3 个子线程，给到 32 是余量，不是许可。
 *
 * ⚠️ **这个预算只管「递归自己发现到的」那些线程，不含种子**（2026-10-XX 复核 B）：种子是事件流
 * （`childThreadIds` ← `collab_tool_call.receiver_thread_ids`）**直接点名**的，是厂商的事实，它们的
 * 条数本来就由那条事件流自己封着（一次运行的事件流有多大，种子就有多少）。拿这个常数去卡种子，
 * 效果是**一个非对抗的触发**：事件流点了 33 个直接子线程的行，分量会整格 `null`——不是「读不动」
 * 也不是「被灌水」，只是种子的条数恰好超过了一个为**发现**定的余量。故预算是「递归自己读了几个」，
 * 种子不计入（2026-10-XX 复核 B 加的守卫把这条钉住了）。
 *
 * ⚠️ **到顶不是「就这样算」**：被截断的清单**不是全量** ⇒ 分量整格 `null`（「全量或 null」）
 * 并落一条点名 WARN（不静默）。这一格定得再宽松也不改变那条口径——**宽松的是上限，不是算术**。
 */
export const MAX_DISCOVERED_CHILD_THREADS = 32;

/**
 * 会话文件的一行。
 * `type` 与 `payload.type` **是两个层次**：真机里 `payload` 自带 `type`（`message` / `reasoning` /
 * `function_call` / `function_call_output` / `token_count` / `task_started` / `task_complete` /
 * `item_completed`），外层那一格是 `session_meta` / `response_item` / `event_msg`。
 * 本模块**只认 `payload.type`**（唯一驱动语义的那一格），外层类型仅用于兜底判断（见 `innerPayloadOf`）。
 */
export interface CodexTranscriptRecord {
  /** 行内时间戳（ISO 8601）；缺失为 null */
  timestamp: string | null;
  /** 行序号；缺失为 null */
  ordinal: number | null;
  /** `payload.type`；缺失为 null（调用方按「不认识」处理，不猜） */
  type: string | null;
  /** 该行**内层**的那个对象（真机形状：外层记录的 `payload`）；无法收窄时为 null */
  payload: Record<string, unknown> | null;
  /** 厂商轮的稳定标识（真机 23/16 次出现）；缺失为 null */
  turnId: string | null;
}

/** `session_meta` 里我们真正消费的部分（其余键原样留在 `payload` 里，需要时再收） */
export interface CodexTranscriptSessionMeta {
  /** `payload.id`——本会话文件所属的线程 id（与文件名末尾同值，互为校验） */
  threadId: string | null;
  /** `payload.session_id`。真机子线程那份等于**父线程 id**（与 `parent_thread_id` 同值） */
  sessionId: string | null;
  /** **主线程那份为 null、子线程那份非空** ⇒ 这一格就是「我是不是子线程」的判据 */
  parentThreadId: string | null;
  timestamp: string | null;
  cwd: string | null;
  originator: string | null;
  cliVersion: string | null;
  /** `source.subagent.thread_spawn`；不是子线程生成的会话时为 null */
  threadSpawn: {
    parentThreadId: string | null;
    /** 嵌套深度（主线程 1 起） */
    depth: number | null;
    agentPath: string | null;
    /** 昵称。**先前标为「无解」的缺口，这里是它的原生来源** */
    agentNickname: string | null;
  } | null;
  /** 原始 payload（诊断 / 将来加字段时不必再动读取层） */
  payload: Record<string, unknown>;
}

/** `payload.type === 'message'`：`{role, content:[{type:'input_text'|'output_text', text}]}` */
export interface CodexTranscriptMessage {
  role: string | null;
  text: string;
  /** 非空的内容块类型（`input_text` / `output_text` / …）；用来区分「模型说的」与「喂进去的」 */
  blockTypes: string[];
  turnId: string | null;
}

/** `payload.type === 'function_call'`：`{name, arguments}`——**`name` 是工具真名** */
export interface CodexTranscriptFunctionCall {
  name: string | null;
  /** 原样保留（是 JSON 字符串的那个形状，不解析——解析失败会丢掉原文） */
  arguments: string | null;
  callId: string | null;
  turnId: string | null;
}

/** `payload.type === 'function_call_output'`：与上面按 `call_id` 配对（按序压栈，见 `readTranscript`） */
export interface CodexTranscriptFunctionCallOutput {
  callId: string | null;
  output: string | null;
  turnId: string | null;
}

/**
 * `payload.type === 'item_completed'` 的一条已完成条目（`item` 原样保留）。
 *
 * 为什么必须读它：**模型产出条目的权威来源**。`response_item/message` 那一类只涵盖喂进去的
 * 提示（`developer` / `user`），而模型说的、想的、调的工具全在 `event_msg` 的
 * `item_completed` 里，`item.id` 还与事件流 `item.started` / `item.completed` 的 `id` **同值**
 * ⇒ 它是「同一条目在事件流与会话文件之间对得上」的唯一稳定键。
 */
export interface CodexTranscriptCompletedItem {
  /** `item.id`——与事件流同值；缺失为 `null`（调用方退回按序合成，**不猜**） */
  itemId: string | null;
  /** `item.type`（真机 `AgentMessage` / `Reasoning` / `CommandExecution` / `CollabAgentToolCall` / `UserMessage`） */
  itemType: string | null;
  /** `payload.item` 原样（一个字段都不改：归一在消息层做，读取层只交事实） */
  item: Record<string, unknown> | null;
  /** 行内 `turn_id`（厂商轮的稳定标识）；缺失为 null */
  turnId: string | null;
  /** 该条目完成时刻（`payload.completed_at_ms`，epoch 毫秒）；缺失为 null */
  completedAtMs: number | null;
}

/** `payload.type === 'token_count'` 的一条快照（原样保留，一个数都不改） */
export interface CodexTranscriptTokenCounter {
  callId: string | null;
  turnId: string | null;
  /** `info.total_token_usage`（整段累计） */
  totalUsage: CodexTokenUsage | null;
  /** `info.last_token_usage`（最近一次调用） */
  lastUsage: CodexTokenUsage | null;
  modelContextWindow: number | null;
}

/**
 * 用量三项 + 推理输出。
 * ⚠️ **`reasoningOutput` 是「推理输出 token」这一格的唯一来源**：codex 的 `turn.completed` 事件流
 * 里**没有**这个数，只有会话文件的 `token_count.reasoning_output_tokens` 有。
 * 采不到一律 `null`（**绝不填 0**——0 会让人得出「这家不做推理」的错误结论）。
 */
export interface CodexTokenUsage {
  input: number | null;
  cachedInput: number | null;
  cacheWriteInput: number | null;
  output: number | null;
  reasoningOutput: number | null;
  total: number | null;
}

/** `readTranscript` 的返回值（字段名用本仓自己的词，厂商键名的对应关系写在各自的注释里） */
export interface CodexTranscript {
  /**
   * 文件里**第一条** `session_meta`（= 这一份会话**自己**的记录）。
   * ⚠️ 子线程文件里可能有**两条**：第 2 条是 fork 时抄进来的**派发者副本** ⇒ 后到的那条**不覆盖**
   * （2026-10-XX 修复：身份必须是文件自己的，理由与真机形状见 `readTranscript` 的 `session_meta` 分支）。
   */
  sessionMeta: CodexTranscriptSessionMeta | null;
  /** `reasoning` 行的正文（已按行顺序拼接、已去空）；一行都没有可读正文时为 null */
  reasoning: string[];
  messages: CodexTranscriptMessage[];
  functionCalls: CodexTranscriptFunctionCall[];
  functionCallOutputs: CodexTranscriptFunctionCallOutput[];
  /** 已完成条目（模型产出与工具执行的权威载体，见 `CodexTranscriptCompletedItem`），按行序 */
  completedItems: CodexTranscriptCompletedItem[];
  tokenCounters: CodexTranscriptTokenCounter[];
  /**
   * 去重后的 `turn_id`（按**首次出现顺序**），即厂商轮的稳定标识。
   * ⚠️ **只收「真的有内容」的那些轮**（2026-10-XX 修复）：fork 抄进来的派发者那一轮只有
   * `task_started` / `turn_context` 这类开工痕迹（本模块不消费）⇒ 不算一轮，否则子线程的轮次会多 1
   * （真机：2 而不是 1）。判据逐字写在 `turnBuckets` 的注记里。
   */
  turnIds: string[];
  /**
   * 整份会话文件的**时间跨度**（2026-10-XX 新增，只服务 `usage` 事件的 `timing`）。
   *
   * 为什么只有这两个时刻、没有 `totalMs`：差值是消费方的事（契约里 `timing` 才有时长），
   * 这里交出的只是**行时间戳的首末两点**这个客观事实。判空一律用 `null`——
   * 一行时间戳都解析不出来时两点都是 `null`（**不拿 0 冒充**）。
   *
   * ⚠️ 这是**墙钟**（含工具执行、等待子进程），与 claude 自报的 `duration_ms`（纯模型时间）
   * 不可直接比 ⇒ 消费方必须看 `timing.source`（这里是 `'events'`）。
   */
  timing: {
    /** 第一条**带可解析时间戳**的行（真机是 `session_meta`）；没有则为 null */
    firstTimestamp: string | null;
    /** 最后一条带可解析时间戳的行；没有则为 null */
    lastTimestamp: string | null;
  };
  /** 读取面的可观测量（不是诊断附属品：坏行计数是「格式漂移」的唯一信号） */
  stats: {
    /** 读进来的行数（含坏行） */
    lines: number;
    /** 解析不了的行数（**不静默**） */
    badLines: number;
    /** 是否因 `MAX_LINES` 截断 */
    truncated: boolean;
  };
}

/**
 * 在 `codexHome/sessions/` 下**递归**找 `rollout-*-<threadId>.jsonl`；找不到返回 `null`（**不抛**）。
 *
 * 为什么靠文件名而**不靠日期目录推算**：目录是 `年/月/日` 三级，按日期拼路径会在**跨午夜**的运行上
 * 直接找错目录（会话在 23:59 开始、记录在次日 00:01 落盘就是那一格）。文件名末尾的线程 id 才是稳定键。
 *
 * 判据用 `endsWith('-' + threadId + '.jsonl')` 而不是 `includes(threadId)`：后者会让
 * `abc` 命中 `…-xabc.jsonl`（另一个线程）。多个候选时取**排序后第一个**（ISO 时间戳前缀天然按时间有序
 * ⇒ 取最早的那份，且结果确定，不依赖文件系统的遍历顺序）。
 */
export function findTranscript(codexHome: string, threadId: string): string | null {
  // 空 id 会让 `endsWith('-.jsonl')` 退化成「任意会话文件」，必须挡住
  if (threadId === '') return null;
  const suffix = `-${threadId}.jsonl`;
  const found = scanForRollout(join(codexHome, CODEX_SESSIONS_DIR), suffix, 0);
  if (found.length === 0) return null;
  return found.sort()[0] ?? null;
}

/**
 * 递归收集匹配的会话文件。
 * 每一层都自己 try/catch：**目录不存在**（还没跑过 codex）、**权限不足**、**走到一半被删**
 * 都只该是「没找到」，不该把异常冒进适配器（本模块的调用点在一次运行**结束**时，抛错会污染结论）。
 * 只 `isDirectory()` 才递归（符号链接不跟）：既避免环，也不会跑出 `sessions/` 之外。
 */
function scanForRollout(dir: string, suffix: string, depth: number): string[] {
  if (depth > MAX_SCAN_DEPTH) return [];
  const matches: string[] = [];
  let entries: ReturnType<typeof opendirSync> | null = null;
  try {
    entries = opendirSync(dir);
    for (;;) {
      const entry = entries.readSync();
      if (entry === null) break;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        matches.push(...scanForRollout(path, suffix, depth + 1));
        continue;
      }
      if (entry.isFile() && entry.name.startsWith(CODEX_ROLLOUT_PREFIX) && entry.name.endsWith(suffix)) {
        matches.push(path);
      }
    }
  } catch {
    // 「读不到这个目录」与「这个目录里没有匹配」在这一层是同一件事：返回已找到的那些
    return matches;
  } finally {
    try {
      entries?.closeSync();
    } catch {
      // 关目录失败无所谓：句柄随进程回收，而这里抛错会把「找到的文件」一起丢掉
    }
  }
  return matches;
}

/**
 * **可续读的解析态**：`CodexTranscript` 加上两个必须跨次读留着的局部量
 * （原先是 `readTranscript` 里的两个 `Map`，2026-10-06 增量读要用它们接着数）。
 */
interface TranscriptParseState {
  transcript: CodexTranscript;
  /** `call_id → 输出`：会话文件里 `function_call_output` **紧跟**对应的 `function_call`（真机实测） */
  outputsByCallId: Map<string, Array<string | null>>;
  /** 见下面 `turnBuckets` 那段注释（`turnIds` 的来源） */
  turnBuckets: Map<string, boolean>;
}

/** 空白的解析态（整份读与增量读都从这里开始） */
function createParseState(): TranscriptParseState {
  return {
    transcript: {
      sessionMeta: null,
      reasoning: [],
      messages: [],
      functionCalls: [],
      functionCallOutputs: [],
      completedItems: [],
      tokenCounters: [],
      turnIds: [],
      timing: { firstTimestamp: null, lastTimestamp: null },
      stats: { lines: 0, badLines: 0, truncated: false },
    },
    outputsByCallId: new Map(),
    turnBuckets: new Map(),
  };
}

/**
 * 消费**一行**——**唯一一份**逐行解析规则（整份读与增量读都走它，两处各写一份必然漂移）。
 * 返回 `false` = 行数已到 `MAX_LINES`：调用方不必再解析后面的行（字节照读，行不再消费）。
 *
 * 坏行**跳过但计数**（`stats.badLines`）；空行既不是内容也不是坏行（尾部换行是常态）。
 */
function consumeLine(state: TranscriptParseState, rawLine: string): boolean {
  const { transcript } = state;
  const line = rawLine.trim();
  if (line === '') return true;
  if (transcript.stats.lines >= MAX_LINES) {
    transcript.stats.truncated = true;
    return false;
  }
  transcript.stats.lines += 1;

  const record = parseRecord(line);
  if (record === null) {
    transcript.stats.badLines += 1;
    return true;
  }
  if (record.turnId !== null) {
    /**
     * `turn_id` → **这一轮在文件里有没有真内容**（按首次出现顺序）。
     *
     * 为什么不是「见到 `turn_id` 就记一轮」（2026-10-XX 修复，真机实测）：fork 出来的子线程文件里，
     * CLI 把**派发者那一轮的开工记录**也抄了进来——真机 `01a107a7…jsonl` 里那个 bucket
     * （`01a107a6-ff6a…`，即**主线程**的那一轮）**只有** `task_started` + `turn_context` 两条，
     * 而这两条都在本模块**不被消费**的那一档（`switch` 的 `default`），整份文件里没有一条属于它的
     * 消息 / 推理 / 工具 / 条目 ⇒ 它**不是这一份会话跑过的一轮**，只是 fork 的痕迹。照它计数会让这个
     * 子线程的轮次多 1（真机：2 而不是 1；整行 4 而不是 3）——而「轮次」正是本设计要做成可比的那一格。
     * 判据因此是「**这一轮有本模块消费的内容**」（`CONSUMED_RECORD_TYPES`）：`task_started` /
     * `turn_context` / `session_meta` 这类只有开工痕迹的桶不算。⚠️ `token_count` **在**那个集合里
     * （它有消费分支）⇒ 只有 `token_count` 的桶**算**一轮，这一条由一条专门的用例钉着；
     * 而 `token_usage_record`（同为用量、但本模块没有分支消费它）**不在**集合里 ⇒ 只有它的桶会少计
     * 一轮（方向安全的残留，逐字登记在 `CONSUMED_RECORD_TYPES` 的注释里）。
     */
    const hasContent = state.turnBuckets.get(record.turnId) ?? false;
    state.turnBuckets.set(record.turnId, hasContent || CONSUMED_RECORD_TYPES.has(record.type ?? ''));
  }
  noteTimestamp(transcript, record.timestamp);
  const payload = record.payload;
  switch (record.type) {
    case 'session_meta':
      /**
       * ⚠️ **第一条 `session_meta` 胜出，后到的副本不覆盖**（2026-10-XX 修复，真机实测）：
       * 子线程的文件里可能有**两条** —— 第 1 行是它**自己**的（`id` = 本文件所属线程、
       * `thread_source: "subagent"`、`parent_thread_id` 指向派发者），第 2 行是 **fork 时抄进来的
       * 派发者那份**（`id` = 主线程、`thread_source: "user"`）。原来这里是「后到覆盖」⇒
       * `sessionMeta.threadId` 变成**主线程**，`subagentPayload` 于是把主线程的 id / 父链 / 深度 /
       * 昵称当成这个子任务的显示出来（真机 `01a107a7…jsonl` 逐字如此，spec §4 R7 表后第 1 条）。
       * 判据是**文件里就是这么写的**：第一条是这一份会话自己的记录，后一条是它派发者的副本。
       * ⚠️ 残留：万一 CLI 反过来写（副本在前），这里会取错——真机上两个 fork 文件都是「自己在前」，
       * 没有反例；要更准就得把「这文件是按哪个线程 id 找到的」也传进来，而本层的签名只有路径
       * （`readTranscript(file)`，文件名那一段是 `findTranscript` 的判据、不是这一层的输入）。
       */
      if (transcript.sessionMeta === null && payload !== null) {
        transcript.sessionMeta = readSessionMeta(payload);
      }
      break;
    case 'reasoning': {
      // 正文取 `content[].reasoning_text`；`content` 为空（上游只回密文）⇒ 这一行为空，**不**回落摘要
      const reasoning = reasoningTextOf(record);
      if (reasoning !== null) transcript.reasoning.push(reasoning);
      break;
    }
    case 'message':
      transcript.messages.push({
        role: readString(payload, 'role'),
        text: messageTextOf(payload),
        blockTypes: messageBlockTypes(payload),
        turnId: record.turnId,
      });
      break;
    case 'function_call':
      transcript.functionCalls.push({
        name: readString(payload, 'name'),
        arguments: readString(payload, 'arguments'),
        callId: readString(payload, 'call_id'),
        turnId: record.turnId,
      });
      break;
    case 'function_call_output': {
      const output = transcriptFunctionOutput(payload);
      const callId = readString(payload, 'call_id');
      if (callId !== null) {
        // 按 id 收进索引（配对在 `finishParse` 里按序做）；同 id 多条时**都留着**，不覆盖
        const bucket = state.outputsByCallId.get(callId) ?? [];
        bucket.push(output.output);
        state.outputsByCallId.set(callId, bucket);
      }
      transcript.functionCallOutputs.push(output);
      break;
    }
    case 'token_count':
      transcript.tokenCounters.push(readTokenCounter(payload, record.turnId));
      break;
    case 'item_completed': {
      // 模型产出与工具执行的权威载体：`item` 原样留，`item.id` 与事件流同值（见类型注释）
      const item = asRecord(payload?.item);
      transcript.completedItems.push({
        itemId: readString(item, 'id'),
        itemType: readString(item, 'type'),
        item,
        turnId: record.turnId,
        completedAtMs: readNumber(payload, 'completed_at_ms'),
      });
      break;
    }
    default:
      // task_started / task_complete / 将来新增的类型：本条不消费。
      // **刻意不落事件**：这一层是「读文件」，不是「事件投影」；把每一条都变成一条日志
      // 只会让抽屉被会话文件的内部账目（task_started 之类）灌满，而它们没有一个字是用户要看的。
      break;
  }
  return true;
}

/**
 * 收尾：轮次与调用配对。**每次增量之后都重跑一遍**（两处都**幂等**：`turnIds` 由累积的
 * `turnBuckets` 重算，配对按 `callId` 的桶序号重算，重复跑结果相同）。
 */
function finishParse(state: TranscriptParseState): CodexTranscript {
  const { transcript } = state;
  /**
   * 轮次 = **真的有内容的**那些 `turn_id`（`Map` 的插入顺序 = 文件里首次出现的顺序）。
   * 为什么不在消费时直接 push：一条 `turn_id` 第一次出现时可能只有开工记录（`task_started`），
   * 要等这一轮后面出现了真内容才能确定它算一轮 ⇒ 只能读完整份文件再定（见 `consumeLine` 的注释）。
   *
   * ⚠️ **这一格（`turnIds`）与子节点时间轴用的那一把尺子不同源**（2026-10-05 终审 Important 2 登记，
   * **不改计算**）：子节点时间轴按**消息的 `roundTrip`** 分组，而那是 `message.ts` 的
   * 「`AgentMessage` 条目去重计数」；这里是**会话文件的 `turn_id`**（厂商自己的轮号，一次任务
   * 常常只有几条）。两个数都可能对，但它们回答的不是同一个问题 ⇒ **行合计的分量仍是本口径**
   * （`childUsageOf` 的 `turns`，见 `TranscriptProjection.subagentTurns`），于是卡片上的
   * 「轮次 = 主 + 子」**不等于**两个会话节点各自显示的轮次之和（真机：卡片 21 = 主 18 + 子 3，
   * 而子节点时间轴上排到 round 13 ⇒ 18 + 13 ≠ 21）。具体后果例：一条**只产推理与工具调用、
   * 一条答复都没有**的子线程，它的消息全部落在 round 1，而行合计照样报 N（N = 该文件的 `turn_id` 数）。
   */
  transcript.turnIds = [...state.turnBuckets].filter(([, hasContent]) => hasContent).map(([turnId]) => turnId);

  // 配对（同一 `call_id` 的第 N 个输出配第 N 个调用；文件里两者相邻，按序对即可）
  const matched = new Map<string, number>();
  transcript.functionCallOutputs = transcript.functionCallOutputs.map((output) => {
    if (output.callId === null) return output;
    const bucket = state.outputsByCallId.get(output.callId);
    const index = matched.get(output.callId) ?? 0;
    matched.set(output.callId, index + 1);
    return { ...output, output: bucket?.[index] ?? output.output };
  });

  return transcript;
}

/**
 * 逐行解析一份会话文件（**整份**，一次读完）。坏行**跳过但计数**（`stats.badLines`）；
 * 文件读不出来时返回 `null`（调用方区分「没有这个文件」与「文件是空的」——前者是常态）。
 *
 * 读盘走共用的 `readLines`（**分块**，不再 `readFileSync` 整份，2026-10-06）：峰值内存从
 * 「整份文本 + `split('\n')` 数组」（2–3× 文件大小）降到「一块 + 当前行」。
 *
 * ⚠️ **它是「整份读」的纯函数入口**（用例与不接缓存的调用方用它）：末尾那段没有换行收尾的内容
 * **照解析**（`readLines` 的默认 `'deliver'`）。接缓存的 `createCachedTranscriptReader` 走**另一条**
 * 语义（`'skip'`：那一段可能是 CLI 写了一半的行，留给下一次读）——两者的差别只在「未收尾的尾巴」，
 * 而真机转录**以换行收尾**（本机两份产物逐字节核过）。
 */
export function readTranscript(file: string): CodexTranscript | null {
  const state = createParseState();
  try {
    readLines(file, (line) => {
      consumeLine(state, line);
    });
  } catch {
    return null;
  }
  return finishParse(state);
}

/**
 * **run 作用域的转录缓存 + 增量读**（2026-10-06 用户口径：「不要重复读取文件，采用增量方式
 * 避免大文件导致内存溢出」）。
 *
 * 为什么需要它：codex 的内容面每 `CONTENT_READ_MIN_INTERVAL_MS`（500 ms）读一次会话文件，
 * 而**同一个文件**在一行里还要被用量面再读一遍、收尾再读一遍——一份只增不减的 jsonl
 * 因此会被整份重复解析几十上百次（真机单份 700 KB 量级，长运行里只会更大）。
 *
 * 三条性质（各自对应一条守卫）：
 *   · **同一版本零 IO**（键 = `路径 + size + mtimeMs`）：文件没长就直接交回上一次的解析结果；
 *   · **只读新增那段**：文件长了就从 `offset` 接着读（`readLines` 的 `offset`），把新行**合并进**
 *     同一份解析态——已经解析过的字节一个都不再碰；
 *   · **变短 / 换过 ⇒ 整份重读**：`size < offset` 说明盘上那份不是「我们读过的那份的延续」
 *     （CLI 只追加，这一支是防御）⇒ 丢掉缓存重来，绝不拿错位的偏移去读。
 *
 * ⚠️ **未收尾的那一段留给下一次读**（`incompleteTail: 'skip'`）：CLI 边写边 flush，可能读到
 * 半截行；照它解析会多算一条坏行、而且偏移越过它之后**永远补不回来**（那一行写完后我们再也不会读它）。
 * 代价如实登记：**文件最后一行没有换行收尾**时，它要等到下一次读才被解析——真机上不会发生
 * （转录以换行收尾），而收尾那一次读不做特例，好让两处语义只有一条。
 *
 * ⚠️ **它是有状态的**（与纯函数 `readTranscript` 刻意分开）：返回值是**同一个** `CodexTranscript`
 * 对象，会随后续读**原地增长**。调用方只在同一次同步投影里用它（`discoverChildThreads` →
 * `projectCodexMessages` / `projectTranscriptDrafts`），不跨周期持有。
 * ⚠️ **run 作用域、显式传入**（不是模块级）：模块级会把整份转录留在进程里，长跑的服务端会一直涨。
 */
export interface CodexTranscriptCache {
  entries: Map<string, { size: number; mtimeMs: number; offset: number; state: TranscriptParseState }>;
}

/** 建一个 **run 作用域**的转录缓存（每行一个，三个读盘面共用） */
export function createCodexTranscriptCache(): CodexTranscriptCache {
  return { entries: new Map() };
}

/**
 * 从内层读者交回的转录**重建可续读状态**（冷路径用；判据与 `consumeLine` 里那两处一一对应）：
 *   · `turnBuckets`：**只有「有内容」这一档需要记住**——不在 `turnIds` 里的轮次默认「还没看到内容」
 *     （`consumeLine` 里那句 `?? false`），所以重建成 `turnIds → true` 就够了；
 *   · `outputsByCallId`：`finishParse` 的配对是**按序**把桶里第 N 项贴到第 N 个输出上
 *     ⇒ 把已经配好的输出按 `callId` 顺序收回来，就是原先那只桶（长度与序号都对得上）。
 */
function stateFromTranscript(transcript: CodexTranscript): TranscriptParseState {
  const outputsByCallId = new Map<string, Array<string | null>>();
  for (const output of transcript.functionCallOutputs) {
    if (output.callId === null) continue;
    const bucket = outputsByCallId.get(output.callId) ?? [];
    bucket.push(output.output);
    outputsByCallId.set(output.callId, bucket);
  }
  return {
    transcript,
    outputsByCallId,
    turnBuckets: new Map(transcript.turnIds.map((turnId) => [turnId, true])),
  };
}

/**
 * 把**内层读者**包成带缓存 + 增量的读者（`TranscriptTargets` 那几个投影的注入口）。
 * 返回的函数与内层**同签名同语义**（读不到返回 `null`），只是多了上面那三条性质。
 *
 * ⚠️ **冷路径（没缓存 / 文件变短）交给内层读者做整份解析**，再从它交回的转录重建可续读状态
 * ——而不是自己再解析一遍：内层是**注入点**（用例喂合成转录、喂抛错的读者都靠它），
 * 绕过它等于把那两条守卫的靶子抽掉。
 */
export function createCachedTranscriptReader(
  cache: CodexTranscriptCache,
  inner: CodexTranscriptReader['read'] = readTranscript,
): CodexTranscriptReader['read'] {
  return (file) => {
    let stats: Stats;
    try {
      stats = statSync(file);
    } catch {
      // 盘上没有这个文件（含用例注入的合成读者）⇒ 交给内层：这一层只负责「同一版本不重读」
      cache.entries.delete(file);
      return inner(file);
    }
    const entry = cache.entries.get(file);
    // ① 没长（且没被改过）⇒ **零 IO、零解析**（这就是「不重复读取文件」的落点）
    if (entry !== undefined && stats.size === entry.size && stats.mtimeMs === entry.mtimeMs) {
      return entry.state.transcript;
    }
    // ② 长了 ⇒ **只读新增那段**，合并进同一份解析态
    if (entry !== undefined && stats.size > entry.size) {
      try {
        const read = readLines(
          file,
          (line) => {
            consumeLine(entry.state, line);
          },
          { offset: entry.offset, incompleteTail: 'skip' },
        );
        entry.offset = read.nextOffset;
        entry.size = stats.size;
        entry.mtimeMs = stats.mtimeMs;
      } catch {
        cache.entries.delete(file);
        return null;
      }
      return finishParse(entry.state);
    }
    // ③ 冷路径 / 变短了（被截断或换过）⇒ 内层整份解析，再重建可续读状态
    const transcript = inner(file);
    if (transcript === null) {
      cache.entries.delete(file);
      return null;
    }
    /**
     * 「从哪继续读」必须与内层**实际消费到哪**对齐：
     *   · 末尾那段没有换行收尾的内容若**能解析成一条记录**，内层（`'deliver'` 语义）已经消费过它
     *     ⇒ 偏移记到文件末尾；否则下一次读会把它**再解析一遍**（重复计数：条目与计量都会翻倍）；
     *   · 解析不了（CLI 写了一半的行）⇒ 偏移记到它的起点，等它写完再读（**不丢记录**）。
     * ⚠️ 后者会让那半截行在 `stats.badLines` 上多记一次（内层当下已经跳过它一次）——方向安全：
     * 多的是一条「坏行」的计数，不是数。
     */
    const tail = incompleteTail(file, stats.size);
    const offset = tail.text !== '' && parseRecord(tail.text.trim()) !== null ? stats.size : tail.start;
    cache.entries.set(file, { size: stats.size, mtimeMs: stats.mtimeMs, offset, state: stateFromTranscript(transcript) });
    return transcript;
  };
}

/**
 * 把一行的 `timestamp` 记进首末两点（2026-10-XX 新增）。
 *
 * 三条判据，每条都有理由：
 *   · **解析不动的串一律跳过**：`firstTimestamp` / `lastTimestamp` 是给 `Date.parse` 用的，
 *     收一个 `'t'` 这种值进去，长度那一侧会在**消费方**才炸（而这里返回的是「读取面的客观事实」，
 *     不该带坏值出去）。跳过不等于丢信息：坏行本来就由 `stats.badLines` 计数。
 *   · **只认第一条 / 覆盖最后一条**，不取 min / max：会话文件是**追加写**的，行序就是时间序；
 *     取 min/max 只会把时钟回拨那类脏数据算进来，得出一个比真实值更长的跨度。
 *   · **首末两点都在这里维护**（而不是读完再扫一遍）：一次遍历，且与坏行计数同一处逻辑，
 *     将来加新的行类型时不会漏掉这一格。
 */
function noteTimestamp(transcript: CodexTranscript, raw: string | null): void {
  if (raw === null) return;
  if (!Number.isFinite(Date.parse(raw))) return;
  transcript.timing.firstTimestamp ??= raw;
  transcript.timing.lastTimestamp = raw;
}

/**
 * 解析一行；解析不了 / 不是对象时返回 `null`（调用方计入 `badLines`，**不抛**）。
 * `JSON.parse` 对任意输入都可能抛（半截行、二进制混入），所以整段包在 try 里。
 */
export function parseRecord(line: string): CodexTranscriptRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  const record = asRecord(parsed);
  if (record === null) return null;
  const payload = innerPayloadOf(record);
  return {
    timestamp: readString(record, 'timestamp'),
    ordinal: readNumber(record, 'ordinal'),
    type: readString(payload, 'type') ?? readString(record, 'type'),
    payload,
    // `turn_id` 的落点：真机在**行内**（外层），内层偶尔也带一份 ⇒ 两处都认，外层优先
    turnId: readString(record, 'turn_id') ?? readString(payload, 'turn_id'),
  };
}

/**
 * 取该行的**内层对象**（承载语义的那一层）——`payload`。
 * 两种形状都要认（本仓实测与题面样例各是一种）：
 *   · 真机：`{type:'response_item', payload:{type:'reasoning', …}}` —— 语义类型在内层的 `type` 上；
 *   · 样例：`{type:'reasoning', payload:{content:…}}` —— 内层没有 `type`，外层那一格就是类型。
 * 所以两种都返回 `payload`，而**类型判定**（`parseRecord`）写成
 * `payload.type ?? 外层 type`：前者优先、后者兜底，与上面两种形状一一对应。
 * `payload` 不是对象（缺字段 / 是字符串）时返回 null，让类型回落成外层的那一格。
 */
function innerPayloadOf(record: Record<string, unknown>): Record<string, unknown> | null {
  return asRecord(record.payload);
}

/** `session_meta` → 我们消费的那几格（其余键原样留在 `payload` 里） */
function readSessionMeta(payload: Record<string, unknown>): CodexTranscriptSessionMeta {
  const spawn = asRecord(asRecord(payload.source)?.subagent);
  const threadSpawn = asRecord(spawn?.thread_spawn);
  return {
    // 真机里 `payload.id` 就是**本文件的线程 id**、`session_id` 是**父**（主线程那份两者相同）
    threadId: readString(payload, 'id'),
    sessionId: readString(payload, 'session_id'),
    parentThreadId: readString(payload, 'parent_thread_id'),
    timestamp: readString(payload, 'timestamp'),
    cwd: readString(payload, 'cwd'),
    originator: readString(payload, 'originator'),
    cliVersion: readString(payload, 'cli_version'),
    threadSpawn:
      threadSpawn === null
        ? null
        : {
          parentThreadId: readString(threadSpawn, 'parent_thread_id'),
          depth: readNumber(threadSpawn, 'depth'),
          agentPath: readString(threadSpawn, 'agent_path'),
          agentNickname: readString(threadSpawn, 'agent_nickname'),
        },
    payload,
  };
}

/**
 * 推理正文：`payload.content[].reasoning_text` 拼起来；**`content` 为空 ⇒ `null`**。
 *
 * 这一格是本次改造的全部意义所在，故把「什么算没有正文」写死：
 *   · `content` 缺失 / 不是数组 / 空数组 ⇒ `null`；
 *   · `content` 里的块不是对象、或缺 `reasoning_text`、或 `reasoning_text` 是空串 ⇒ 该块贡献空；
 *   · 全部块都贡献空 ⇒ `null`（**不是空串**：与 `AgentRunResult.finalText` 同一口径——
 *     「未采到」与「明确是空的」是两件事）。
 * **刻意不回落 `summary`**：真机上 `summary` 是空数组，但就算将来它有了内容，摘要也**不是**正文
 * （§5.6.3：不得用摘要冒充）。这一条是防「看起来采到了」的关键，别顺手加个 `?? summary`。
 */
export function reasoningTextOf(record: {
  payload: Record<string, unknown> | null;
}): string | null {
  const content = record.payload?.content;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const block of content) {
    const text = readString(asRecord(block), 'reasoning_text');
    if (text !== null && text !== '') parts.push(text);
  }
  if (parts.length === 0) return null;
  return parts.join('\n');
}

/** `message` 的正文：`content[].text` 拼起来（只取 `input_text` / `output_text` 两种块） */
function messageTextOf(payload: Record<string, unknown> | null): string {
  return messageBlocks(payload)
    .filter((block) => block.type === 'input_text' || block.type === 'output_text')
    .map((block) => block.text)
    .join('');
}

/** `message` 的非空内容块类型（用来区分 role 与真实块类型不一致的那种行） */
function messageBlockTypes(payload: Record<string, unknown> | null): string[] {
  return messageBlocks(payload)
    .map((block) => block.type)
    .filter((type): type is string => type !== null);
}

/** `message.content` 摊平成 `{type, text}`（形状不认识时给空数组，不抛） */
function messageBlocks(payload: Record<string, unknown> | null): Array<{ type: string | null; text: string }> {
  const content = payload?.content;
  if (!Array.isArray(content)) return [];
  const blocks: Array<{ type: string | null; text: string }> = [];
  for (const block of content) {
    const record = asRecord(block);
    if (record === null) continue;
    const text = readString(record, 'text');
    if (text === null || text === '') continue;
    blocks.push({ type: readString(record, 'type'), text });
  }
  return blocks;
}

/**
 * `function_call_output` 的输出文本。
 * 输出这一格**可能是字符串，也可能是个对象**（不同 CLI 版本/命令见过两种），故两种都认：
 * 字符串原样；对象里按 `output` → `text` → `content` 的顺序找第一个字符串。
 * 找不到就 `null`（不 `safeStringify` 一个对象进来冒充正文——那是「看起来采到了」）。
 */
function transcriptFunctionOutput(payload: Record<string, unknown> | null): CodexTranscriptFunctionCallOutput {
  const raw = payload?.output;
  const direct = typeof raw === 'string' ? raw : null;
  const nested = direct === null ? asRecord(raw) : null;
  return {
    callId: readString(payload, 'call_id'),
    output: direct ?? readString(nested, 'output') ?? readString(nested, 'text') ?? readString(nested, 'content'),
    turnId: readString(payload, 'turn_id'),
  };
}

/** `token_count` → 一份快照；`info` 缺失或字段缺失 ⇒ 对应的数是 `null`（**不填 0**） */
function readTokenCounter(payload: Record<string, unknown> | null, turnId: string | null): CodexTranscriptTokenCounter {
  const info = asRecord(payload?.info);
  return {
    callId: readString(payload, 'call_id'),
    turnId: readString(payload, 'turn_id') ?? turnId,
    totalUsage: readUsage(asRecord(info?.total_token_usage)),
    lastUsage: readUsage(asRecord(info?.last_token_usage)),
    modelContextWindow: readNumber(info, 'model_context_window'),
  };
}

/** 用量三项 + 推理输出 + 合计；每一格独立可缺（缺 = null） */
function readUsage(usage: Record<string, unknown> | null): CodexTokenUsage | null {
  if (usage === null) return null;
  return {
    input: readNumber(usage, 'input_tokens'),
    cachedInput: readNumber(usage, 'cached_input_tokens'),
    cacheWriteInput: readNumber(usage, 'cache_write_input_tokens'),
    output: readNumber(usage, 'output_tokens'),
    // 这一格只存在于会话文件里（事件流的 turn.completed 没有它）
    reasoningOutput: readNumber(usage, 'reasoning_output_tokens'),
    total: readNumber(usage, 'total_tokens'),
  };
}

/** 投影结果：`drafts` 是要发出去的事件，`usage` / `timing` 是给调用方与事件流合并用的权威值 */
export interface TranscriptProjection {
  drafts: AgentEventDraft[];
  /**
   * **主 + 子**的合计用量（spec 2026-10-04 §2.3），已按本仓契约**归一**
   * （`input` 减掉了 cached，见 `normalizedTotalUsage`），另带只存在于会话文件里的
   * `reasoningOutput` / `total` 两格（2026-10-XX 起 `usage` 事件装得下它们了）。
   * 由调用方按「值更新才发一条」的规矩决定要不要顺带刷新一条 `usage` 事件（见 `codex/index.ts`）。
   *
   * ⚠️ 这一格**已经是合计**（子那一份并进来了）：消费方不得再与 `subagentUsage` 相加
   * ——那会把子线程算两遍，而两处都是「能算出来的数」，界面上看不出错。
   * 子那一份没读全时退回主线程口径（就是 `normalizedTotalUsage(main)` 那个值）。
   */
  usage: UsageTokens | null;
  /**
   * 子线程那一份（**整条 spawn 链，含嵌套**，spec §4 R7）；`null` = 有子线程但读不全（全量或 null），
   * 无子线程时是 `{0,0,0}`。
   * 与 `usage` **同时**消费：只给分量不给合计时，界面按「主会话 = 合计 − 分量」会算出负数。
   * ⚠️ `{0,0,0}` 的意思是「**事件流没给出过 `receiver_thread_ids`**」，不等于「这一行确实没有
   * 子智能体」（前提与失效史见 `childUsageOf` 的注记）——别拿它当「没有子智能体」的证明。
   */
  subagentUsage: UsageTokens | null;
  /**
   * 子线程的轮次数之和（`turnIds` 去重后的个数）；`null` 的口径与 `subagentUsage` 相同。
   *
   * ⚠️ **它与子节点时间轴上的轮次不是同一把尺子**（2026-10-05 终审 Important 2 登记，**不改计算**）：
   * 这里数的是**会话文件的 `turn_id`**（厂商轮号），而子节点时间轴按**消息的 `roundTrip`** 分组
   * （= `message.ts` 的 `AgentMessage` 条目计数）。真机实测：子线程文件 13 条 `AgentMessage`
   * （子节点显示 round 1..13）而 `turn_context` 只有 3 条 ⇒ 这一格是 3。于是行卡片的
   * 「轮次 = 主 + 子」与两个节点各自显示的轮次**互不自洽**（18 + 13 ≠ 21）。真修要动 `EvalRow.turns`
   * （spec §2.5 明文不动），故本次只登记；后续任务见设计文档的同一条残留。
   */
  subagentTurns: number | null;
  /**
   * 会话文件首末两行时间戳的**跨度**（`source: 'events'`，含工具执行的墙钟）。
   * 为什么由这一层交出去而不是让 `index.ts` 自己算：**只有这一层知道那份文件的内容**，
   * 而「首末两点 → 跨度」的换算在骨架里已经有一份（`turn.ts` 的 `resolveTiming`）⇒ 这里只交出
   * 两个时刻，别在这里算第二个版本的差值。
   *
   * 三种情况都是 `undefined`（= 这一条消息不带时间，骨架会保留上一次的值）：
   * 没读到主线程文件、文件里一行时间戳都没有、只有一个端点（差值算不出来）。
   * **绝不**退回去拿我们自己的 `at` 时间戳冒充厂商时间——那是本仓明令禁止的那类假数。
   */
  timing?: TimingSpan;
}

/**
 * 子线程那一份：用量分量与轮次之和。
 * 两格的口径**恒一致**（要么都是数、要么都是 `null`）：一个没有用量却没有轮次的子线程，
 * 或者反过来，都会让「有子线程但读不全」这件事变得不可判。
 */
export interface ChildThreadUsage {
  /**
   * `null` = 有子线程但读不全（全量或 null）；没有子线程时是 `{0,0,0}`（确实没有，不是没采到）。
   * 口径是**整条 spawn 链**（含嵌套，spec §4 R7）：种子 + 由种子沿可识别形状派发的全部后代。
   * ⚠️ 「确实没有」的前提见 `childUsageOf` 的注记：`{0,0,0}` 只说明**事件流没给过子线程 id**
   * （= 递归一个种子都没有），不说明这一行真的没派过子智能体。
   */
  usage: UsageTokens | null;
  /** 各线程 `turnIds` 去重后的个数相加；`null` 的口径与 `usage` 相同 */
  turns: number | null;
}

/**
 * 「读一个会话文件」这**一件事**的窄声明。
 * 为什么在这里而不是 `sdk.ts`（那里才是厂商外壳）：这不是厂商 SDK 的一部分——它是**文件格式**，
 * 与 `@openai/codex-sdk` 无关（换掉 SDK 也照样读它）。放这里让「读盘」这一能力在单测里可替换
 * （`startCodex` 的第二个参数），而生产路径拿到的是 `readTranscript` 本身。
 */
export interface CodexTranscriptReader {
  /** 解析一个会话文件；读不出来返回 null（**不抛**） */
  read: (file: string) => CodexTranscript | null;
}

/**
 * 事件流里「与后续读会话文件有关」的那些可观测事实。
 * 为什么单独一个类型、且由 `noteThreadIds` 读写：**主线程 id 与子线程 id 只在事件流里出现**
 * （`thread.started.thread_id` 与 `collab_tool_call.receiver_thread_ids`），而消费它们的是
 * **跑完之后**的那一步。把这一格显式建模出来，「拿到了哪些 id」就不再是散落在闭包里的隐式状态。
 */
export interface TranscriptTargets {
  /** 主线程 id（事件流 `thread.started.thread_id`）；没见到就一直 `null`（**不猜**） */
  mainThreadId: string | null;
  /** 子线程 id：去重、保持**首次出现顺序**（顺序即投影顺序） */
  childThreadIds: string[];
}

/**
 * 从一条事件流事件里收集线程 id（就地写入 `targets`）。
 *
 * 判据是**实测的形状**，不是猜的：
 *   · `thread.started` 带 `thread_id`（主线程）；
 *   · `collab_tool_call` 带 `receiver_thread_ids`（数组，子线程）。
 * ⚠️ `collab_tool_call` 的**其余形状未经本仓探测确认**（题面只说 `receiver_thread_ids` 来自它），
 * 故这里对「不是字符串的成员」「不是数组的字段」一律**跳过**——宁可少收一个 id（表现为
 * 那条子线程读不到、日志里有一条 WARN），也不要拿一个猜出来的 id 去读盘。
 *
 * 返回是否有新增（调用方据此决定要不要记日志）：这条信息值得记——「派了几个子智能体」在
 * codex 的事件流里**没有别的出口**（`collab_tool_call` 的子智能体消息是不给的）。
 */
export function noteThreadIds(targets: TranscriptTargets, event: Record<string, unknown> | null): boolean {
  const type = readString(event, 'type');
  if (type === 'thread.started') {
    const threadId = readString(event, 'thread_id');
    if (threadId === null || threadId === '') return false;
    if (targets.mainThreadId === threadId) return false;
    targets.mainThreadId = threadId;
    return true;
  }
  /**
   * 多智能体条目：**真机的外面还包着一层 `item.*`**（2026-10-03 实测）——
   * `{ type:'item.completed', item:{ type:'collab_tool_call', receiver_thread_ids:[子线程 id] } }`。
   * 原来只认顶层 `type === 'collab_tool_call'`，于是 `childThreadIds` **永远是空的**：
   * 子线程的会话文件从来没被读过 ⇒ 子任务行没有名称/终态/结果摘要，
   * 子智能体自己的轨迹更是一条消息都没有（用户口径：「codex 子任务里面没有日志」）。
   * 两种外形都认（顶层与内层），与 `noteThreadIds` 的调用点同一条口径。
   */
  const collab = type === 'collab_tool_call' ? event : asRecord(event?.item);
  if (readString(collab, 'type') !== 'collab_tool_call') return false;
  const receivers = collab?.receiver_thread_ids;
  if (!Array.isArray(receivers)) return false;
  let added = false;
  for (const receiver of receivers) {
    if (typeof receiver !== 'string' || receiver === '') continue;
    /**
     * **主线程 id 绝不进 `childThreadIds`**（2026-10-04 评审 Minor 4）：真机上没出现过，但这个形状
     * 一旦出现就要命——主线程的会话文件会被当成「一个子线程」再读一遍，`childUsageOf` 会把它算进
     * 子那一份（主线程算两遍），而「全量或 null」**抓不住**它（那条规则只挡「读不到」，不挡「重复」）。
     * 事件流的常规顺序是 `thread.started` 先到（本仓全部夹具同形）⇒ 这一格通常已经有值。
     * 残留的一格（id 在 `thread.started` 之前就被收进来、而它恰好就是主线程）如实登记：
     * 那种顺序在本仓没见过，且它只会让「主线程被算两遍」这个形状重新出现——不是新引入的风险。
     */
    if (receiver === targets.mainThreadId) continue;
    if (targets.childThreadIds.includes(receiver)) continue;
    targets.childThreadIds.push(receiver);
    added = true;
  }
  return added;
}

/**
 * 「这个线程派发过哪些线程」——**一个会话文件里能读出子线程 id 的两种实测外形**（去重、按出现顺序）。
 *
 * 这一格是 spec §4 **R7** 的修法①（递归发现）唯一的取数面：事件流只点名主线程直接派发的那些
 * （`collab_tool_call.receiver_thread_ids`），**由子线程再派发的**它一个都不提，
 * 而它们的存在只写在**派发者自己的文件**里。没有这一格，codex 那一行的子智能体用量会
 * 系统性少报（真机一轮约 15–20%，见 spec §4 R7 的实测）。
 *
 * 两种外形都要认，缺一种就会在对应场景下**静默漏计**：
 *
 *  ① `CollabAgentToolCall.receiver_thread_ids` —— **厂商原生**。子线程自己拿到了多智能体工具时，
 *     它派发的线程就写在它自己的 `item_completed` 里，与主线程事件流那一格**同名同形**
 *     （所以这一条是「事件流那套判据读同一份内容」，不是新判据）。`depth ≥ 2` 的正规形状就是它。
 *  ② CLI 启动横幅里的 `session id: <uuid>` —— **本仓真机唯一实际发生过的形状**
 *     （`8e13e7a3` 那一轮）：子线程**没有**多智能体工具，于是它按自己的判断**shell 出去**
 *     起了另一个 codex（子线程 transcript 里没有 `collab_tool_call`、也没有 `spawn_agent` 调用，
 *     只有一条 `exec_command`），新会话 id 只出现在那条命令的**输出**里：
 *     ```
 *     OpenAI Codex v0.156.1
 *     --------
 *     workdir: …
 *     session id: 01a107a8-951e-7530-8947-cc99dffdfab3
 *     --------
 *     ```
 *     扫描面因此是 `function_call_output.output`（模型可见的那份工具输出）与
 *     `item_completed` 里 `CommandExecution` 的 `stdout` / `aggregated_output` / `formatted_output`
 *     ——同一件事的两处记录，去重后无副作用。
 *
 * ⚠️ **判据写窄是有意的**：第 ② 种只认「整行就是 `session id: ` + 36 位 uuid」这一条**横幅**，
 * 不认裸 uuid、不认 `--json` 输出里的 `session_id` 字段。理由：宽判据会把「列出会话目录」
 * 「`cat` 别人的 rollout」这类输出的 id 也当成派发证据，而那会**多算**别的线程的用量
 * ——多算与少算都是假数，而多算会被读成「这一行真的花了这么多」。
 *
 * ⚠️ **横幅本身分不出「新起」与「复用」——这一格只交「它点了谁的名」**（评审 Important 1）：
 * `codex exec resume <id>` 会打出**同一条横幅**、里面是**已存在**的会话 id ⇒ 光看横幅，
 * 「这个子线程新起了一个会话」与「它接着一个**旧**会话跑」是同一条记录。那个判别**不住在这里**
 * （它要读对方的 `session_meta.timestamp`，是 `discoverChildThreads` 的事，见那边的注记）：
 * 本函数只如实交出文件里写着的东西，**时序判断一个字都不做**。
 * ⚠️ 我**没有**在这里加「同一 `call_id` 只认一条」之类的启发式：真机上同一条命令的输出在
 * `function_call_output` 与 `CommandExecution` 里各记一份，本来就该去重（调用方按 id 去重）。
 *
 * ⚠️ **它读的是「谁派发了谁」，不是「谁属于这一行」**：环（互派）、自指、以及点名**主线程或自己**
 * 这三种形状都在 `discoverChildThreads` 里去重挡掉（点名主线程那一条**有前提**，见那边的注记），
 * 本函数只如实交出文件里写着的东西。
 */
export function spawnedThreadIdsOf(transcript: CodexTranscript): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  const collect = (candidate: unknown): void => {
    if (typeof candidate !== 'string' || candidate === '') return;
    if (seen.has(candidate)) return;
    seen.add(candidate);
    ids.push(candidate);
  };

  // 外形 ①：厂商原生的多智能体条目（与 `noteThreadIds` 读事件流时同一格）
  for (const item of transcript.completedItems) {
    if (item.itemType !== 'CollabAgentToolCall') continue;
    const receivers = item.item?.receiver_thread_ids;
    if (!Array.isArray(receivers)) continue;
    for (const receiver of receivers) collect(receiver);
  }

  // 外形 ②：CLI 启动横幅（见函数头；同一件事在 `response_item` 与 `event_msg` 两处各记一份）
  for (const output of transcript.functionCallOutputs) {
    if (output.output === null) continue;
    for (const id of sessionBannerThreadIds(output.output)) collect(id);
  }
  for (const item of transcript.completedItems) {
    if (item.itemType !== 'CommandExecution') continue;
    for (const field of COMMAND_OUTPUT_FIELDS) {
      const text = readString(item.item, field);
      if (text === null) continue;
      for (const id of sessionBannerThreadIds(text)) collect(id);
    }
  }

  return ids;
}

/** `CommandExecution` 条目里承载进程输出的三格（真机三格同值，取到哪个算哪个） */
const COMMAND_OUTPUT_FIELDS = ['stdout', 'aggregated_output', 'formatted_output'] as const;

/**
 * CLI 启动横幅：整行就是 `session id: <uuid>`（判据为什么写这么窄，见 `spawnedThreadIdsOf` 的注记）。
 *
 * 三个标志各有用处：`m` 让 `^` / `$` 按行走；`i` **容忍大小写**（真机 uuid 是小写，但不为这个
 * 让一条横幅整条读不出来）；`g` 交给 `matchAll` 逐个取。
 * **不需要 `\r?`**：`m` 模式下的 `$` 本来就认 `\r` 之前的位置，CRLF 与「末尾孤立 CR」两种形状
 * 都实测过，加不加 `\r?` 结果逐字相同 ⇒ 不写那一格冗余（评审 Minor 3）。
 * 放在模块级是安全的：本模块只把它交给 `matchAll`（内部克隆正则、**不会**动这里的 `lastIndex`，
 * 实测调用前后都是 0），从不调 `exec` / `test` ⇒ 不存在「上一次匹配的游标串到下一次」的问题。
 */
const SESSION_BANNER_PATTERN =
  /^[ \t]*session id:[ \t]*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})[ \t]*$/gim;

/**
 * 从一段文本里捞 CLI 启动横幅的 `session id: <uuid>`；**小写归一后**交出。
 *
 * 为什么 `.toLowerCase()` 是**必需**的（评审 Minor 7）：`i` 让大写 uuid 的横幅也能被认出来，
 * 而会话文件名是**小写**的（`findTranscript` 按 `-<id>.jsonl` 后缀匹配）⇒ 留着大写等于
 * **凭空造出一个读不到的线程**，而「全量或 null」接不住它（那条规则挡的是「读不到」，
 * 不挡「自己把 id 写坏」）：分量会整格变 `null`，看起来像「这一行读不到子智能体」。
 */
function sessionBannerThreadIds(text: string): string[] {
  const ids: string[] = [];
  for (const match of text.matchAll(SESSION_BANNER_PATTERN)) {
    const id = match[1];
    if (id === undefined || id === '') continue;
    ids.push(id.toLowerCase());
  }
  return ids;
}

/**
 * 沿 spawn 链递归发现的**一个**子线程（含嵌套）。
 * 「发现」而不是「事件流点名」是这一格的全部意义：事件流点名的是**种子**，
 * 由种子自己文件里读出来的是嵌套的那些（spec §4 R7）。
 */
export interface DiscoveredChildThread {
  threadId: string;
  /**
   * **本模块自己的发现深度**：事件流点名的为 1，由它们再派发的为 2……
   * ⚠️ 与厂商的 `sessionMeta.threadSpawn.depth` **不是同一把尺**（那一格是厂商记的、且只对
   * 「真的走了多智能体工具」的线程存在）⇒ 两处不要混用、不要互相校验。
   */
  discoveryDepth: number;
  /** 派发它的线程 id；事件流点名的那一批是主线程派的（主线程 id 未知时为 `null`，**不猜**） */
  spawnedBy: string | null;
  /** 会话文件的解析结果；**读不到时为 `null`**（文件不在 / 读不动）——调用方据此落点名 WARN 并整格 null */
  transcript: CodexTranscript | null;
}

/**
 * 一次递归发现的**全部**结果。为什么不是「一个线程数组」：这一层还产出两个**判断**
 * ——「有没有被上限截断」（决定分量能不能给数）与「跳过了哪些旧会话」（决定分量里**不该**有什么），
 * 二者都由 `discoverChildThreads` 唯一一处算出，调用方只负责把它们变成日志与 `null`。
 */
export interface ChildThreadDiscovery {
  /** 发现的线程（父在子前、同层按文件里的出现顺序）；顺序即投影顺序 */
  threads: DiscoveredChildThread[];
  /**
   * 因**哪一条上限**而停止枚举：`'depth'` = `MAX_SPAWN_DEPTH`，`'count'` = `MAX_DISCOVERED_CHILD_THREADS`；
   * 没被截断时为 `null`。
   * ⚠️ 非 `null` 时分量必须整格 `null`（「全量或 null」）：被截断的清单**不是**全量，
   * 拿它的和当总数正是本仓最忌讳的一类假数（界面上的和看起来是对的）。调用方同时落点名 WARN。
   * 判据是「**真的**还有没走的分支」而不是「碰到过上限那一层」：深度到顶但那个线程没有子线程时
   * 什么都不缺 ⇒ 记 `null`（否则一个正常的深链会把整格无谓地打成 `null`）。
   * ⚠️ **为什么记「哪一条」而不是一个布尔**（2026-10-XX 复核 Minor ①）：WARN 里那句
   * 「已发现的 N 个（已达上限）」在**深度**那条路上是假的——深度到顶时 N 远小于线程数上限 32，
   * 印出来就是「7 个（已达上限）」配「上限 32」这种自相矛盾的一对。记下是哪条到顶，那句话才说得准；
   * 也让两条守卫各自钉住自己那条路（深度那条只由深度守卫走到）。
   */
  truncatedBy: 'depth' | 'count' | null;
  /**
   * 递归**自己发现到**的线程数（不含事件流点名的种子，见 `MAX_DISCOVERED_CHILD_THREADS` 的注释）。
   * 为什么单独交出来：截断那条 WARN 要说清「读到了多少个、其中多少个是递归额外发现的」，而
   * `threads.length` 把种子和发现混在一起（2026-10-XX Wave A 复核 Minor ①：种子不计入预算之后
   * 那句「已发现的 N 个」会印出 33 而上限写 32，读起来自相矛盾）。
   */
  discoveredCount: number;
  /** 被判定为「早于派发线程创建时刻」而排除的会话（疑为 `codex exec resume` 复用的旧会话） */
  skippedPriorSessions: Array<{ threadId: string; spawnedBy: string }>;
}

/**
 * 从「事件流点名的那批子线程 id」出发，沿 spawn 链把**嵌套**子线程也找出来（spec §4 R7 修法①）。
 *
 * 为什么要递归而不是只读那批 id：主线程的 `receiver_thread_ids` 结构上**看不到**嵌套
 * ——真机一轮里 4 个 rollout 只点名了 1 个，另外两个（子线程 shell 出去起的 codex）从来没人提。
 *
 * 五条边界，每条都对应一种真会发生的形状：
 *
 *   · **去重 + 环安全**：`seen` 在入队时写入，互派（A↔B）与自指都只会被收一次。
 *     ⚠️ 「**点名主线程会被挡住**」这句话**有前提**（评审 Minor 6）：主线程 id 是**预置**进 `seen`
 *     的，而 `mainThreadId` 的类型是 `string | null`，投影那条路上它**真的会是 `null`**
 *     （`thread.started` 还没到、而 `collab_tool_call` 先到——本仓没见过的顺序，但类型上可达）。
 *     那个窗口里这条形状**挡不住**：主线程会被当成一个子线程再读一遍、算进分量，而「全量或 null」
 *     抓不住它（那条规则只挡「读不到」，不挡「重复」）。**不在这里补一个猜出来的主线程 id 去堵它**
 *     ——判据必须是事实（与 `noteThreadIds` 同一条口径：宁可少收，不拿猜的 id 去读盘）。
 *   · **深度上限**：到 `MAX_SPAWN_DEPTH` 就不再往下展开（见那个常量的注释）。
 *     ⚠️ 判据是「**真的有**没走的分支」，不是「碰到过上限那一层」，而且那一问必须**再减掉 `seen` 里
 *     已经走过的**（2026-10-XX 复核 A）：光看「这个线程有没有下游」会**多报**——下游恰好是**回指**
 *     （写回自己、或写回上一层已经走过的那个）时，一个线程文件都不会因为这条界而漏读 ⇒ 什么都不缺。
 *     那种形状下置真的代价是双份的：分量整格 `null`（本来算得出来），WARN 还宣称「不是全量」——
 *     **那句话是假的**。广度那条路本来就是这个判据（`!seen.has`），两条路现在同一把尺。
 *   · **广度上限**：递归**自己发现到**的线程最多 `MAX_DISCOVERED_CHILD_THREADS` 个（见那个常量的注释）。
 *     ⚠️ **种子（事件流点名的那批）不占这个预算**：它们是事实，条数由事件流自己封着；预算封的是
 *     「我们沿 spawn 链额外读了多少个」这件事。把种子算进去会让「直接子线程多于上限」的行整格 `null`
 *     （2026-10-XX 复核 B：那是非对抗触发，而且 §2.3 / R7 从没说过 32 里含种子）。
 *     两条上限任一真的砍掉了分支 ⇒ `truncatedBy` 记下是哪一条 ⇒ 分量整格 `null` + 点名 WARN（不静默，评审 Minor 4）。
 *     截断时 `turns` / `tokens` / 缓存命中**都会**退回主线程口径（`index.ts` 的 `finalize` 兜着）⇒ 那条 WARN
 *     说的是**整行三格**，不只是分量那一格（2026-10-XX 复核 C）。
 *   · **早于派发者的会话不算本次的**：`codex exec resume <id>` 会**复用旧会话**并打出**同一条横幅**
 *     ⇒ 横幅分不出「新起」与「接着旧的跑」（见 `spawnedThreadIdsOf` 的注记）。判据落在**时序**上：
 *     派发者**先存在**，它新起的会话不可能比它自己还早 ⇒ 一个 `session_meta.timestamp` **早于
 *     派发者创建时刻**的会话必然是**旧**会话（同一行历次尝试留下的死会话就是这么被复用的）。
 *     ⚠️ **「派发者创建时刻」取的是厂商自己那一格（`session_meta.timestamp`），不是行首时间戳**——
 *     后者会把 **fork 出来的**嵌套线程误判成旧会话（两条独立理由，逐字写在 `dispatcherCreatedAt`
 *     的注记里）。⚠️ 而「厂商自己那一格」自 2026-10-XX 起**真的是派发者自己的**：读取层取文件里
 *     **第一条** `session_meta`（身份那条修复）⇒ 这里不再可能取到 fork 源的创建时刻。
 *     ⚠️ **为什么不拿「横幅那一行的时间戳」当界**（评审 Important 1 的草图，这里刻意没照做）：
 *     真机上那一行是命令**结束**的时刻——`8e13e7a3` 那一轮里 `01a107a8-951e` 的 meta 是
 *     `16:04:11.297`，而带横幅的那一行是 `16:04:22.995`（晚 11.7 秒）⇒ 照那条界判会把**真的新会话
 *     一起排除**，R7 当场重开。判据只能松到「派发者自己的创建时刻」，再紧就是拿少计换少计。
 *     ⚠️ **三者缺一即保留**（读不到 meta / 时间戳解析不动 / 派发者的界缺失）：没有可用的时序
 *     就是**没有判据**，此时保留 = 改动前的行为 ⇒ 那一条漏网之鱼由 spec §4 R7 的残留登记兜着
 *     （这条判据是**减少**多计，不是**证明**没有多计）。
 *   · **读不到就到此为止**：文件不在时没有正文可扫 ⇒ 不再往它的下游猜（`transcript: null` 会被
 *     `childUsageOf` 变成整格 `null`，调用方同时落一条点名 WARN）。
 *
 * 顺序（父在子前、同层按文件里的出现顺序）是**投影顺序**：`projectTranscriptDrafts` 按这个顺序发草稿，
 * 所以子任务的记录总是先于它自己派发的那些。
 *
 * ⚠️ **2026-10-06 起导出**：内容投影（`message.ts` 的 `projectCodexMessages`）也要走**同一份**发现
 * ——它此前只吃事件流点名的种子，于是**递归发现的嵌套子线程既没有子任务行、也没有消息**
 * （用量进了 `subagentTokens`，界面上却没有那一行）。调用方（`index.ts`）每个读周期只发现一次，
 * 把结果传给内容面与用量面两张投影（`discovery` 入参）。
 */
export function discoverChildThreads(input: {
  codexHome: string;
  childThreadIds: readonly string[];
  /** 主线程 id：用来把「自己被点名」这一形状挡在分量之外；不知道时为 `null`（见上面那条前提） */
  mainThreadId: string | null;
  read: CodexTranscriptReader['read'];
}): ChildThreadDiscovery {
  const threads: DiscoveredChildThread[] = [];
  const skippedPriorSessions: ChildThreadDiscovery['skippedPriorSessions'] = [];
  let truncatedBy: ChildThreadDiscovery['truncatedBy'] = null;
  const seen = new Set<string>();
  if (input.mainThreadId !== null) seen.add(input.mainThreadId);
  /**
   * `dispatcherCreatedAt` = 派发者（上一个被读出来的线程）**自己那一份** `session_meta.timestamp`
   * ——即「派发者会话被创建的时刻」。
   *
   * ⚠️ **这一句在 2026-10-XX 之前是假的，现在是真的**（复核 E → 身份那条修复）：那时读取层是
   * 「后到覆盖」，派发者自己若是 fork，文件里那**两条** `session_meta`（自己的 + **它 fork 自的那个
   * 会话**的副本）会让这里取到**后者** ⇒ 界更松（fork 源更早 ⇒ 更少候选被判旧 ⇒ 过计窗口更宽）。
   * 身份修复之后 `readTranscript` 取**第一条**（= 派发者自己那一份），这个界因此收紧到语义上
   * 本来就该是的那一格；真机复跑也证实「0 WARN、逐格不变」（spec §4 R7 的残留名单随之删掉这一条）。
   * 深度 1 的种子是事件流直接点名的（不是从横幅读出来的）⇒ 这一格恒为 `null`、不做时序判定
   * ——事件流的 `receiver_thread_ids` 是厂商自己的派发记录，不需要我们再用时间去猜。
   *
   * ⚠️ **这一格刻意用内层 `payload.timestamp` 而不是行首的外层 `timestamp`**（两者都是现成的）：
   * ① 外层那一格是「这行**被写下来**的时刻」，内层才是厂商记的「这个会话**被创建**的时刻」——
   * 判据要的正是后者；② 更要命的是**它会把真的嵌套线程误判成旧会话**：同一个 fork 让「行被写下来」
   * 比「会话被创建」晚一点点（真机实测 **109ms**：`01a107a7…` 的外层 `16:02:37.143` vs 内层
   * `16:02:37.034`）⇒ 拿外层当界，那条**真的**嵌套线程（自己的创建时刻夹在这两个数之间，真机
   * 那一轮里就是 `01a107a7…`）会被判成「早于派发者」而丢掉（少计）。用内层则两侧取的是同一类记录
   * （都是「会话被创建的时刻」）⇒ 判据比的是同一件事。
   */
  const queue: Array<{
    threadId: string;
    discoveryDepth: number;
    spawnedBy: string | null;
    dispatcherCreatedAt: string | null;
  }> = [];
  /**
   * 递归**自己发现到**的条数——广度预算卡的就是这一格，**种子不计入**（见常量的注释）。
   * 为什么分成两个入口（`enqueueSeed` / `enqueueDiscovered`）而不是一个布尔参数：这两批是**两种
   * 东西**（事件流点名的既成事实 / 我们沿 spawn 链读出来的），而预算只对后者有意义——写成两个名字，
   * 「谁在花预算」在调用点一眼可见，也不存在「布尔传反」这一档（2026-10-XX Wave A 复核 Minor ④；
   * 复核 B 的实现正是栽在同一处：种子照样记进了预算）。
   */
  let discovered = 0;
  /** 收下这个候选（`seen` 挡重复的调用方已经判过） */
  const accept = (candidate: (typeof queue)[number]): void => {
    seen.add(candidate.threadId);
    queue.push(candidate);
  };
  /** 种子：事件流**直接点名**的那批（`seen` 挡重复；**不占**广度预算，理由见常量的注释） */
  const enqueueSeed = (candidate: (typeof queue)[number]): void => {
    if (seen.has(candidate.threadId)) return;
    accept(candidate);
  };
  /**
   * 发现：递归自己读出来的那批——**只有这一批**占广度预算，到顶 ⇒ `truncatedBy = 'count'`，
   * 后面的一个都不再收。
   * ⚠️ 计的是「曾经入队的**发现**数」而不是 `threads.length + queue.length`：那个队列是「只推进下标、
   * 不搬元素」的，已经处理过的条目**仍然留在数组里** ⇒ 那个和会把每个已出队的线程**数两遍**，
   * 上限于是提前一格生效（本仓实测：上限 32 只收到 31 个，由一个用例抓出来）。这一格正好是
   * 「递归最多额外读盘多少次」这个我们真正想封顶的量。
   */
  const enqueueDiscovered = (candidate: (typeof queue)[number]): void => {
    if (seen.has(candidate.threadId)) return;
    if (discovered >= MAX_DISCOVERED_CHILD_THREADS) {
      truncatedBy = 'count'; // 到顶了：后面的 id 一个都不再收（分量随之整格 null）
      return;
    }
    discovered += 1;
    accept(candidate);
  };
  for (const threadId of input.childThreadIds) {
    if (threadId === '') continue;
    enqueueSeed({ threadId, discoveryDepth: 1, spawnedBy: input.mainThreadId, dispatcherCreatedAt: null });
  }
  // 边遍历边入队（BFS）：下标推进而不是 shift()，避免每个元素搬一次数组
  for (let index = 0; index < queue.length; index += 1) {
    const next = queue[index];
    if (next === undefined) continue;
    const transcript = readByThreadId(input.codexHome, next.threadId, input.read);
    if (
      next.dispatcherCreatedAt !== null &&
      transcript !== null &&
      predatesDispatcher(transcript, next.dispatcherCreatedAt)
    ) {
      skippedPriorSessions.push({ threadId: next.threadId, spawnedBy: next.spawnedBy ?? '' });
      continue;
    }
    threads.push({
      threadId: next.threadId,
      discoveryDepth: next.discoveryDepth,
      spawnedBy: next.spawnedBy,
      transcript,
    });
    if (transcript === null) continue;
    const childIds = spawnedThreadIdsOf(transcript);
    if (next.discoveryDepth >= MAX_SPAWN_DEPTH) {
      /**
       * 只有**真的有下游、且那个下游还没走过**时才算被截断（复核 A）：一排回指（写回自己 / 写回
       * 上一层已经走过的）看起来「有下游」，但 `seen` 一个都不会放行 ⇒ 一条线程文件都不会因此漏读
       * ⇒ 什么都不缺。判据必须与广度那条路同一把尺（`!seen.has`），否则「不是全量」那句话会是假的。
       */
      if (childIds.some((id) => !seen.has(id))) truncatedBy = 'depth';
      continue;
    }
    const dispatcherCreatedAt = transcript.sessionMeta?.timestamp ?? null;
    for (const childId of childIds) {
      enqueueDiscovered({
        threadId: childId,
        discoveryDepth: next.discoveryDepth + 1,
        spawnedBy: next.threadId,
        dispatcherCreatedAt,
      });
    }
  }
  return { threads, truncatedBy, discoveredCount: discovered, skippedPriorSessions };
}

/**
 * 这个会话是不是**早于**派发者被创建的（⇒ 是 `codex exec resume` 复用的旧会话，不属于本次运行）。
 * 三种「判不出来」都返回 `false`（= 保留，见 `discoverChildThreads` 的注记）：缺 meta、时间戳不是
 * 合法时刻、派发者的界不是合法时刻。**严格小于**：同一时刻按「新起的」算——这一条同时兜住
 * 「候选是 fork、两边取到的是同一条记录」那一档（见 `dispatcherCreatedAt` 的注记）。
 */
function predatesDispatcher(transcript: CodexTranscript, dispatcherCreatedAt: string): boolean {
  const metaTimestamp = transcript.sessionMeta?.timestamp ?? null;
  if (metaTimestamp === null) return false;
  const metaMs = Date.parse(metaTimestamp);
  const dispatcherMs = Date.parse(dispatcherCreatedAt);
  if (!Number.isFinite(metaMs) || !Number.isFinite(dispatcherMs)) return false;
  return metaMs < dispatcherMs;
}

/**
 * 把主线程与全部子线程的会话文件投影成事件。
 *
 * 为什么是「一条 log = 一件事、载荷带 `kind` 判别」而不是新增事件类型：v1 的 `AgentEvent` 是
 * 7 型封闭联合（`packages/server/contracts/src/agent-event.ts`），**没有** thinking / subagent 事件；
 * claude-code 与 dsh 侧的子任务也走同一形状（`kind: 'subagent'` 的 JSON 载荷）⇒ 这里保持一致，
 * 消费方按 `kind` 过滤即可重建。**这是本仓已确立的落点，不是本模块的临时发明。**
 *
 * 每条载荷都带 `source`（`'main'` = 主线程、`'subagent'` = 子线程）与 `origin: 'transcript'`
 * （= 这一条来自会话文件，不是事件流）。为什么必须标出来源：这些内容**在时间上属于过去**
 * （文件是跑完之后才读的），与事件流里实时到达的条目混在一起而不加标记，会让日志抽屉的顺序
 * 撒一个「这些推理是最后才发生的」的谎。
 */
export function projectTranscriptDrafts(input: {
  codexHome: string;
  mainThreadId: string | null;
  /** 子线程 id（来自 `collab_tool_call.receiver_thread_ids`），顺序即事件顺序 */
  childThreadIds: readonly string[];
  /** 读取函数；缺省 = 真的读盘（`readTranscript`）。测试喂合成 transcript 时只换这一格 */
  read?: CodexTranscriptReader['read'];
  /**
   * 已经算好的一份递归发现（`discoverChildThreads` 的产物）。给定则**不再重复发现**：
   * 一个读周期里内容面与用量面共用同一份（目录扫描与读盘都省一遍）。
   * ⚠️ 必须与本次的两个入参（`codexHome` / `childThreadIds` / `mainThreadId`）同源——
   * 传一份别的周期的发现进来，分量与内容就会来自两批不同的线程。
   */
  discovery?: ChildThreadDiscovery;
}): TranscriptProjection {
  const read = input.read ?? readTranscript;
  const drafts: AgentEventDraft[] = [];
  /** 同一段正文只说一次（子线程若与主线程同文件、或文件被重复读到时不去重就会刷屏） */
  const seen = new Set<string>();
  /** 主线程那一份（合计的一半；子那一份在下面按线程 id 读出来）。读不到时是 `null`，**不是 0** */
  let usage0: TranscriptProjection['usage'] = null;
  let timing: TranscriptProjection['timing'];

  if (input.mainThreadId !== null) {
    const main = readByThreadId(input.codexHome, input.mainThreadId, read);
    if (main === null) {
      // 找不到就**落一条日志**而不是静默：这是「会话文件在不在」的唯一可见信号，
      // 排障时它决定了「是适配器没读」还是「CLI 没写」
      drafts.push(
        logDraft(
          'stderr',
          `[WARN] 未找到主线程 ${input.mainThreadId} 的 codex 会话文件（${CODEX_SESSIONS_DIR} 目录下无匹配），本次运行读不到推理正文（不编造）`,
        ),
      );
    } else {
      const reasoning = main.reasoning.join('\n');
      if (reasoning !== '' && !seen.has(reasoning)) {
        seen.add(reasoning);
        drafts.push(
          logDraft(
            'stdout',
            safeStringify({
              kind: 'thinking',
              origin: 'transcript',
              source: 'main',
              threadId: input.mainThreadId,
              text: reasoning,
            }),
            `推理正文（${input.mainThreadId.slice(0, 8)}，来自会话文件）`,
          ),
        );
      }
      // 会话文件存在的**证据**（含坏行计数与文件里数出来的轮次标识数）：即使一条推理正文都没有，
      // 这一条也让「读到了文件但里面没有正文」与「根本没读到文件」在日志里可区分
      drafts.push(logDraft('stdout', safeStringify(transcriptManifest(main, input.mainThreadId))));
      usage0 = normalizedTotalUsage(main);
      timing = transcriptTiming(main);
    }
  }

  /**
   * 子线程的读取面：**每个线程只读一次**（沿 spawn 链递归展开，含嵌套），用量分量与下面那几条
   * 草稿都从这一份来。
   * 为什么先把读取收起来（而不是在循环里边读边算）：分量必须在任何一条草稿之前算定
   * ——它决定 `usage` 是「主 + 子」的合计还是退回主线程口径。
   */
  const discovery =
    input.discovery ??
    discoverChildThreads({
      codexHome: input.codexHome,
      childThreadIds: input.childThreadIds,
      mainThreadId: input.mainThreadId,
      read,
    });
  const children = discovery.threads;
  /** 子线程的用量与轮次：**整棵树**（含嵌套）**读不全或被上限截断都算没读到**（spec §2.2「全量或 null」） */
  const { usage: subagentUsage, turns: subagentTurns } = childUsageOf(discovery);

  /**
   * 两条**不静默**的日志（评审 Important 2 / Minor 4）：它们说的都是「这一格为什么给不出数（或少了谁）」，
   * 而那正是抽屉唯一能回答的问题。少了它们，上限与旧会话排除都会表现成「子智能体用量就是这么多」。
   *
   * ⚠️ **截断那条必须点名整行三格**（2026-10-XX 复核 C）：分量整格 `null` 之后，`index.ts` 的
   * `finalize` 仍然会把 `turns` / `tokens` / 缓存命中退回**主线程口径**（与 `tokens` 在分量读不出来时
   * 的回落同一条口径，刻意保留）⇒ 那一行上摆着的三个数**都不含**没读到的子线程，而 "子智能体那一份
   * 给 null" 只说了其中一格。界面据此把那三个数读成「这一行的总量」就是这么来的。
   *
   * ⚠️ **两个数必须分开说**（2026-10-XX Wave A 复核 Minor ①）：预算封的是「递归额外发现」，
   * 而 `children.length` 里**混着种子** ⇒ 只印一个总数会出现「读到了 33 个，而上限写着 32」这种
   * 自相矛盾的句子（种子不占预算，33 完全可以合法地大于 32）。所以这里把「本次读到多少」与
   * 「其中递归额外发现多少」分开印。
   *
   * ⚠️ **「到顶的是哪一条」也要说**（Wave A 复核 Minor ① 的后半）：早先那句「递归额外发现 7 个
   * （已达上限）」在**深度**那条路上是假的——深度到顶时那个数远小于线程数上限 32，印出来就是
   * 「7（已达上限）」配「上限 32」这种自相矛盾的一对。`truncatedBy` 记下了是哪条到顶，这里按它措辞。
   */
  if (discovery.truncatedBy !== null) {
    const capLabel =
      discovery.truncatedBy === 'depth'
        ? `深度上限（${MAX_SPAWN_DEPTH} 层）`
        : `递归额外发现的线程数上限（${MAX_DISCOVERED_CHILD_THREADS} 个）`;
    drafts.push(
      logDraft(
        'stderr',
        `[WARN] codex 子线程的递归发现在上限处停止（到顶的是${capLabel}）：本次读到 ${children.length} 个线程，其中递归额外发现 ${discovery.discoveredCount} 个**不是全量** ⇒ 子智能体那一份给 null（不拿部分和冒充总数）；⚠️ 这一行的 tok / 缓存命中 / 轮次**都不含**未读到的那些子线程（它们退回主线程口径）`,
      ),
    );
  }
  if (discovery.skippedPriorSessions.length > 0) {
    const named = discovery.skippedPriorSessions
      .map((entry) => `${entry.threadId}（由 ${entry.spawnedBy === '' ? '未知线程' : entry.spawnedBy} 派发）`)
      .join('、');
    drafts.push(
      logDraft(
        'stderr',
        `[WARN] 跳过 ${discovery.skippedPriorSessions.length} 个早于派发线程创建时刻的会话（疑为 \`codex exec resume\` 复用的旧会话，例如本行历次尝试留下的死会话）——它们不属于本次运行，不计入分量：${named}`,
      ),
    );
  }

  for (const child of children) {
    const threadId = child.threadId;
    const transcript = child.transcript;
    if (transcript === null) {
      // 既有行为不变（深度 1 那句一字未改）：读不到就落一条点名的 WARN，且**不给数**。
      // 嵌套的那些也走这里 ⇒ 「少读了一个嵌套子线程」在抽屉里看得见，不会静默漏计。
      drafts.push(logDraft('stderr', missingChildWarning(child)));
      continue;
    }
    const reasoning = transcript.reasoning.join('\n');
    if (reasoning !== '' && !seen.has(reasoning)) {
      seen.add(reasoning);
      drafts.push(
        logDraft(
          'stdout',
          safeStringify({ kind: 'thinking', origin: 'transcript', source: 'subagent', threadId, text: reasoning }),
          `子智能体推理正文（${threadId.slice(0, 8)}）`,
        ),
      );
    }
    drafts.push(
      logDraft('stdout', safeStringify(subagentPayload(transcript, threadId)), subagentSummary(transcript, threadId)),
    );
  }

  // 合计 = 主 + 子；子那一份没读全时退回主线程口径（`usage0` 保持原样）
  const usage = addUsage(usage0, subagentUsage);
  return { drafts, usage, subagentUsage, subagentTurns, ...(timing === undefined ? {} : { timing }) };
}

/**
 * 「这个子线程的会话文件读不到」那一句 WARN。
 * 深度 1 的那句**逐字保留**（既有日志面的形状，别顺手改）；嵌套的那些多说一句「谁派的、它是嵌套的」
 * ——点名一个 id 而不说它从哪来，排障时等于没说。
 */
function missingChildWarning(child: DiscoveredChildThread): string {
  if (child.discoveryDepth <= 1) {
    return `[WARN] 未找到子线程 ${child.threadId} 的 codex 会话文件，该子智能体的消息与工具调用读不到（不编造）`;
  }
  return `[WARN] 未找到嵌套子线程 ${child.threadId}（由 ${child.spawnedBy ?? '上级子线程'} 沿 spawn 链发现，深度 ${child.discoveryDepth}）的 codex 会话文件，该子智能体的消息与工具调用读不到（不编造）`;
}

/**
 * 一次发现（**整棵树，含嵌套**）→ 分量（纯函数：读取在外面，两处的读取面各自不同，
 * 但「怎么算这一份」只有这一份实现）。
 *
 * 「全量或 null」是这一格的全部要点，**两种**触发方式都归到同一档：只要**有一个**子线程读不到
 * （文件不在、或读到了但里面没有可用的累计用量），**或**枚举被上限截断（见下面那条 ⚠️），
 * 整个分量就是 `null`、轮次也是 `null` —— **绝不把部分子线程的和当成「子智能体那一份」**。
 * 那个形状（少算一个子智能体、却报得像采到了）正是本仓最忌讳的一类假数：界面上的和看起来是对的。
 * 没有子线程时给 `{0,0,0}` 与 0：这是「确实没有」，与「没采到」是两件事。
 *
 * ⚠️ **「确实没有」有前提，别把它读成对事实的证明**：`{0,0,0}` 只在「**事件流给出过
 * `receiver_thread_ids`**」这条判据下成立（空集 = `noteThreadIds` 一个 id 都没收到）。而这个取数面
 * 在本仓**静默失效过**（只认顶层 `collab_tool_call` 时 `childThreadIds` 恒为空 —— 见 `events.ts`
 * 的注记与 `transcript.test.ts` 那条真机外形的用例）⇒ 路由拒绝命名空间工具 / `multi_agent=false` /
 * CLI 换形状时，这里的意思是「**本次没给**」，而不是「这一行确实没有子智能体」。
 * 要下后一个结论，得先确认事件流真的没给（当前判据覆盖实测到的两种外形）。
 *
 * ⚠️ **这条前提在递归之后一字未变，而且更要紧了**（spec §4 **R7**，2026-10-XX 修复）：
 * `childThreadIds` 是递归的**种子**——种子为空时嵌套**无从发现**（没有任何线程文件会被打开）。
 * 所以 `{0,0,0}` 读作「事件流没点名任何子线程」，而**不是**「这一行确实没有子智能体」，
 * 后者在「事件流没给 id、而 CLI 其实派过」时是假的。反过来，种子非空之后这一格是**整棵链**的和
 * （主线程 + 它点名的 + 由它们派发的，逐层展开），不再只是「直接派发的那些」。
 *
 * ⚠️ **仍然会有残留漏计**（如实登记，spec §4 R7）：递归靠**派发者文件里读得出的形状**
 * （`spawnedThreadIdsOf` 的两种）。派发者用别的方式起会话、或 CLI 把横幅形状换掉，那一支就发现不了
 * ⇒ 表现为**少计**。所以这一格今天的口径是「事件流点名的那批 + 由它们沿可识别形状派发的全部后代」，
 * 不是「这一行花掉的全部」。**不因为「够用了」就把它说成完整**——那是本仓最忌讳的那类措辞。
 *
 * ⚠️ **被上限截断时整格 `null`**（评审 Important 2 / Minor 4）：`discovery.truncatedBy` 非 `null`
 * 说明枚举**在中途停了**，那份清单不是全量 ⇒ 它的和**不能**当分量（那正是本仓最忌讳的「部分和看起来像
 * 总数」）。这是本仓唯一一处**主动**把一份**本来算得出来**的和丢掉的地方，代价是明摆着的：
 * 界面上少一行，换的是不出一句「子智能体就花了这么多」的假话。上限本身定得宽松（32 / 深度 8）
 * 就是为了让这一档几乎不可达，而**宽松的是上限，不是算术**。
 * ⚠️ 反过来，`discovery.skippedPriorSessions`（早于派发者的旧会话）**不**让整格变 `null`：
 * 排除它们是一个**判断**（它们不是本次运行的），不是「读不到」——判断的结果就是「分量里没有它们」，
 * 而那个判断本身由 WARN 点名、可复核。
 */
function childUsageOf(discovery: ChildThreadDiscovery): ChildThreadUsage {
  if (discovery.truncatedBy !== null) return { usage: null, turns: null };
  const parts: UsageTokens[] = [];
  let turns = 0;
  for (const child of discovery.threads) {
    const transcript = child.transcript;
    const usage = transcript === null ? null : normalizedTotalUsage(transcript);
    if (transcript === null || usage === null) return { usage: null, turns: null };
    parts.push(usage);
    turns += transcript.turnIds.length;
  }
  return { usage: sumUsageTokens(parts), turns };
}

/** 线程 id → 会话文件 → 解析结果；任一步失败都返回 `null`（调用方负责落「读不到」的日志） */
function readByThreadId(
  codexHome: string,
  threadId: string,
  read: CodexTranscriptReader['read'],
): CodexTranscript | null {
  const file = findTranscript(codexHome, threadId);
  if (file === null) return null;
  return read(file);
}

/**
 * 运行期（`index.ts` 的 `project`）要的那一份子线程用量：按线程 id 读盘再算。
 *
 * 为什么单独导出一个取数面、而不是让运行期也去调 `projectTranscriptDrafts`：那一条路会把整份投影
 * （推理正文、子任务载荷、清单……）重跑一遍，而运行期要的只是「子智能体那一份**用量**」。
 * 轮次那一格跟着一起算出来（两格口径恒一致），今天由收尾消费。
 * 判据与收尾那一条完全同一份实现（`discoverChildThreads` + `childUsageOf`）——两处各写一遍必然漂移，
 * 而漂移的表现是「运行期看到的子智能体用量与终态不一样」，那是最难查的一类。
 * ⚠️ **递归也住在那一份实现里**（spec §4 R7）⇒ 运行期与终态**同时**含嵌套、同时受那两条上限约束，
 * 不存在「终态才修好」的中间态。
 * ⚠️ 但**理由**只有终态那条路说得出来，而真正的理由是**频次**（2026-10-XX 复核 D 改正；原先这里写的是
 * 「这一格没有草稿通道」，**那句是错的**——`TurnProjection.drafts` 就在手边，投影器在运行期本来就往
 * 那里发 `[WARN]` 日志草稿）：运行期那条路**每 500 ms 刷新一次**（`index.ts` 的 `refreshContent` 节流），
 * 一条「上限截断 / 跳过旧会话」的 WARN 会在整段运行里重复几百遍，把抽屉淹掉；而 `finalize`
 * **一次运行只跑一次** ⇒ 同一句话放在终态那份记录里说一遍就够，且不丢（终态记录是这条路的兜底）。
 * 运行期因此只表现为分量 `null`（界面据此退回一行），那两句话等 `finalize` 的 WARN（不静默那一半在那边）。
 */
export function projectChildThreadUsage(input: {
  codexHome: string;
  /** 主线程 id：用来把「主线程自己被点名」这一形状挡在分量之外；不知道时为 `null` */
  mainThreadId: string | null;
  childThreadIds: readonly string[];
  /** 读取函数；缺省 = 真的读盘（与 `projectTranscriptDrafts` 同一个注入口） */
  read?: CodexTranscriptReader['read'];
  /** 同一个读周期里**已经算好**的那份递归发现（判据与 `projectTranscriptDrafts` 逐字相同） */
  discovery?: ChildThreadDiscovery;
}): ChildThreadUsage {
  const read = input.read ?? readTranscript;
  return childUsageOf(
    input.discovery ??
      discoverChildThreads({
        codexHome: input.codexHome,
        childThreadIds: input.childThreadIds,
        mainThreadId: input.mainThreadId,
        read,
      }),
  );
}

/**
 * 「读到了这一份会话文件」的清单（不是推理正文，是**读取面的事实**）。
 * 为什么单独发一条：`badLines > 0` 是「CLI 换了行格式」的唯一信号。只把推理正文发出去的话，
 * 换格式的表现会是「推理突然全没了」，而日志里一个字都不会说为什么。
 */
function transcriptManifest(transcript: CodexTranscript, threadId: string): Record<string, unknown> {
  const meta = transcript.sessionMeta;
  return {
    kind: 'transcript',
    origin: 'transcript',
    source: 'main',
    threadId,
    sessionId: meta?.sessionId ?? null,
    parentThreadId: meta?.parentThreadId ?? null,
    cliVersion: meta?.cliVersion ?? null,
    originator: meta?.originator ?? null,
    lines: transcript.stats.lines,
    badLines: transcript.stats.badLines,
    truncated: transcript.stats.truncated,
    reasonsObserved: transcript.reasoning.length,
    messages: transcript.messages.length,
    functionCalls: transcript.functionCalls.length,
    /**
     * 会话文件首末两行的时间戳（2026-10-XX 新增）。为什么也放进清单：`timing` 缺数据时
     * （`usage` 事件里那一格是 `undefined`）排障唯一的问法是「文件里到底有没有时间戳」，
     * 而这一条清单就是回答它的地方——放在这里比让人去翻几十 MB 的原始 jsonl 便宜得多。
     */
    firstTimestamp: transcript.timing.firstTimestamp,
    lastTimestamp: transcript.timing.lastTimestamp,
    // 厂商轮的稳定标识（会话文件里数出来的）——**本轮刻意不改 codex 的轮次口径**（见 index.ts 的说明）
    turnIds: transcript.turnIds,
    tokenCounters: transcript.tokenCounters.map((counter) => serializedCounter(counter, threadId)),
  };
}

/**
 * 子线程 → `kind: 'subagent'` 载荷（与 claude-code / dsh 的子任务载荷同族）。
 *
 * 三格对齐既有模型（`claude-code/events.ts` 的 `subagentDraft` 是这一族的规格）：
 *   · `subagentId` / `vendorId` ← `session_meta.id`（厂商原生线程 id，**不合成**）；
 *   · `parentToolUseId` ← `session_meta.parent_thread_id`（**嵌套父链**，先前标为「无解」的那一格）；
 *   · `name` ← `source.subagent.thread_spawn.agent_nickname`（昵称）。
 * `phase` 用 `'transcript'` 而不是 `'start'`/`'end'`：**这不是一条生命周期事件**，而是
 * 「跑完之后从会话文件里补出来的一份子智能体记录」。假装成 start 会让下游把一次派发数成两次。
 */
function subagentPayload(transcript: CodexTranscript, threadId: string): Record<string, unknown> {
  const meta = transcript.sessionMeta;
  const spawn = meta?.threadSpawn ?? null;
  return {
    kind: 'subagent',
    phase: 'transcript',
    /**
     * `'session-file'` = 厂商会话文件（**用 v1 §6.1 的枚举原词**——那一节把来源定为
     * `'wire' | 'hook' | 'session-file' | 'aggregate'`，codex 的 `collab_tool_call` 事件不带正文）。
     * 2026-10-01 审计更正：原先这里写的是 `'transcript'`（模块名），与契约枚举不符，已改名。
     */
    source: 'session-file',
    origin: 'transcript',
    subagentId: meta?.threadId ?? threadId,
    vendorId: meta?.threadId ?? threadId,
    /** 嵌套父链：主线程那份 `parent_thread_id` 为 null，子线程那份非空（真机） */
    parentToolUseId: meta?.parentThreadId ?? null,
    parentThreadId: meta?.parentThreadId ?? null,
    /** 嵌套深度与昵称：`source.subagent.thread_spawn` 是它们的**原生来源** */
    spawnDepth: spawn?.depth ?? null,
    name: spawn?.agentNickname ?? null,
    agentNickname: spawn?.agentNickname ?? null,
    agentPath: spawn?.agentPath ?? null,
    // 子智能体自己的产出：消息按 role 分开、工具调用保留**工具真名**（`exec_command` / `spawn_agent` …）
    messages: transcript.messages.map((message) => ({ role: message.role, text: message.text })),
    functionCalls: transcript.functionCalls.map((call) => ({ name: call.name, arguments: call.arguments })),
    functionCallOutputs: transcript.functionCallOutputs.map((output) => output.output),
    turnIds: transcript.turnIds,
    lines: transcript.stats.lines,
    badLines: transcript.stats.badLines,
    tokenCounters: transcript.tokenCounters.map((counter) => serializedCounter(counter, threadId)),
  };
}

/** 活动行的一句话：`子智能体记录（工作区检查，depth 1）` —— 名字缺失时只报线程前缀，**不编名字** */
function subagentSummary(transcript: CodexTranscript, threadId: string): string {
  const spawn = transcript.sessionMeta?.threadSpawn ?? null;
  const who = spawn?.agentNickname ?? transcript.sessionMeta?.threadId ?? threadId;
  const depth = spawn?.depth ?? null;
  return depth === null ? `子智能体记录（${who}）` : `子智能体记录（${who}，深度 ${depth}）`;
}

/** 一份 token 快照的**线上形状**（键名逐字保留厂商的，便于与真机 dump 对照） */
function serializedCounter(counter: CodexTranscriptTokenCounter, threadId: string): Record<string, unknown> {
  return {
    threadId,
    callId: counter.callId,
    turnId: counter.turnId,
    total: serializedUsage(counter.totalUsage),
    last: serializedUsage(counter.lastUsage),
    modelContextWindow: counter.modelContextWindow,
  };
}

function serializedUsage(usage: CodexTokenUsage | null): Record<string, number | null> | null {
  if (usage === null) return null;
  return {
    input_tokens: usage.input,
    cached_input_tokens: usage.cachedInput,
    cache_write_input_tokens: usage.cacheWriteInput,
    output_tokens: usage.output,
    // 这一格是「推理输出 token」的唯一来源（事件流没有它）
    reasoning_output_tokens: usage.reasoningOutput,
    total_tokens: usage.total,
  };
}

/**
 * 会话文件里的**累计**用量 → `usage` 事件那几格（2026-10-XX 起含 `reasoningOutput` / `total`）。
 *
 * 只认 `total_token_usage`：它是整段的累计值，`last_token_usage` 是最近一次调用（两者口径不同，
 * 混用会让「跑动期的数」忽然变小）。
 *
 * ## `input` 必须**减去** cached —— 这条是 codex 与另两家唯一的实质差别
 *
 * codex 的 `input_tokens` **含**缓存读（`cached_input_tokens` 是它的**明细**），真机两处都验过：
 *   · Responses wire 抓包：`{input_tokens:35, input_tokens_details:{cached_tokens:0}, …}`；
 *   · **exec 事件流** `turn.completed.usage`：`{input_tokens:8152, cached_input_tokens:6656}`（6656 < 8152 ⇒ 是子集）；
 *   · **rollout 会话文件**的 `token_count` 也带 cached（本机样本 `{input_tokens:9340, cached_input_tokens:8320}`）。
 *     ⚠️ 早前把 8152/6656 标成"来自会话文件"是**归因错误**，已按产物更正（2026-10-01 审计）。
 * 而本仓契约的 `input` 是**非缓存输入**（claude / dsh 两家的原文天生就是不含 cache 的）。
 * 不减的话，同一个命中率公式 `cached/(input+cached)` 在 codex 上算出的分子不变、分母偏大
 * ⇒ 命中率被系统性低估，而三家看起来「都算对了」——这正是 §7.6.4「消灭按厂商分支」要消灭的东西：
 * **归一化的代价必须由适配器付，不能甩给消费方去记得「这条是 codex 发的」。**
 *
 * 减法见 `normalizedInput`（含 `max(0, …)` 的防御：真机没出现过 cached > input，
 * 但一旦出现，负数流进界面会渲染出读不懂的比率）。
 *
 * 三格**齐了才认**（与 `events.ts` 的 `readTokens` 同一条规矩：缺项 ⇒ `null`，绝不填 0）；
 * `reasoningOutput` / `total` 是**可选格**，采不到就是 `null`（**不填 0**：
 * `reasoningOutput: 0` 会让人得出「这家不做推理」，而事实是「这一格没有」）。
 */
function normalizedTotalUsage(transcript: CodexTranscript): TranscriptProjection['usage'] {
  for (let index = transcript.tokenCounters.length - 1; index >= 0; index -= 1) {
    const usage = transcript.tokenCounters[index]?.totalUsage ?? null;
    if (usage === null) continue;
    if (usage.input === null || usage.cachedInput === null || usage.output === null) continue;
    return {
      input: normalizedInput(usage.input, usage.cachedInput),
      cached: usage.cachedInput,
      output: usage.output,
      reasoningOutput: usage.reasoningOutput,
      total: usage.total,
    };
  }
  return null;
}

/**
 * 会话文件首末两点 → 一份 `source: 'events'` 的跨度；任一端缺一个就返回 `undefined`。
 *
 * 为什么是首末两点而不是 `session_meta.timestamp` 到最后一行的差：那两处的口径差得更远
 * （`session_meta` 是**创建会话**的时刻，可能远早于第一次模型调用）。首末两点是同一份文件里
 * 客观的墙钟起止，且坏行/缺时间戳的行会被 `noteTimestamp` 跳过，不会污染端点。
 *
 * `apiMs` / `ttftMs` **一律不填**（`null`）：codex 的事件流与会话文件里都没有这两个数
 * （`exec --json` 一个时间字段都没有——实测），拿 `totalMs` 冒充会把工具执行时间算进模型速度。
 * ⇒ codex 上只能退化成 `output / totalMs`，且必须带上 `source: 'events'` 的警示。
 */
function transcriptTiming(transcript: CodexTranscript): TimingSpan | undefined {
  const { firstTimestamp, lastTimestamp } = transcript.timing;
  if (firstTimestamp === null || lastTimestamp === null) return undefined;
  const firstMs = Date.parse(firstTimestamp);
  const lastMs = Date.parse(lastTimestamp);
  if (!Number.isFinite(firstMs) || !Number.isFinite(lastMs)) return undefined;
  return { firstMs, lastMs, apiMs: null, ttftMs: null, source: 'events' };
}

/**
 * codex 的 `input_tokens`（**含** cache）→ 本仓契约的 `input`（**非缓存输入**）：两者相减。
 * `max(0, …)` 是防御而不是实测：真机上 `cached_input_tokens <= input_tokens` 恒成立
 * （6656 < 8152），但这个减法一旦被将来的形状变化弄成负数，流到界面上就是一个读不懂的负数，
 * 而 0 至少诚实地表示「这一次没有未命中输入」。**丢掉的那部分差额不做任何补偿性推断**。
 */
export function normalizedInput(inputTokens: number, cachedInputTokens: number): number {
  return Math.max(0, inputTokens - cachedInputTokens);
}
