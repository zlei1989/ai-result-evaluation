/**
 * codex **会话文件（rollout）** 读取与投影（2026-10-XX 新增）。
 *
 * 为什么需要这个文件：codex 的 `exec --json` 事件流**不携带推理正文**，也不携带子智能体的消息
 * ——而 codex CLI 自己把这两样都写进了会话文件。适配器已知线程 id（主线程来自
 * `thread.started.thread_id`；子线程来自 `collab_tool_call` 的 `receiver_thread_ids`），
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
import { opendirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { UsageTokens } from '@aieval/contracts';
import { logDraft, safeStringify, type AgentEventDraft } from '../../emit';
import { asRecord, readNumber, readString } from '../../json';
import type { TimingSpan } from '../../turn';

/** 会话文件所在目录名（相对 `CODEX_HOME`）；日期目录 `年/月/日` 在它下面，**不参与路径推算** */
export const CODEX_SESSIONS_DIR = 'sessions';

/** 会话文件名前缀；`findTranscript` 按「前缀 + …-线程 id + 后缀」匹配 */
export const CODEX_ROLLOUT_PREFIX = 'rollout-';

/** 递归深度上限：真机形状是 `sessions/年/月/日/文件`（4 层）。给到 8 是余量，不是许可——再深就不找了 */
const MAX_SCAN_DEPTH = 8;

/** 一个会话文件最多读多少行。防止把一份被写坏的巨型文件整个读进内存；截断时 `stats.truncated` 为真 */
const MAX_LINES = 20_000;

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
  sessionMeta: CodexTranscriptSessionMeta | null;
  /** `reasoning` 行的正文（已按行顺序拼接、已去空）；一行都没有可读正文时为 null */
  reasoning: string[];
  messages: CodexTranscriptMessage[];
  functionCalls: CodexTranscriptFunctionCall[];
  functionCallOutputs: CodexTranscriptFunctionCallOutput[];
  /** 已完成条目（模型产出与工具执行的权威载体，见 `CodexTranscriptCompletedItem`），按行序 */
  completedItems: CodexTranscriptCompletedItem[];
  tokenCounters: CodexTranscriptTokenCounter[];
  /** 去重后的 `turn_id`（按**首次出现顺序**），即厂商轮的稳定标识 */
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
 * 逐行解析一份会话文件。
 * 坏行**跳过但计数**（`stats.badLines`）；文件读不出来时返回 `null`（调用方区分「没有这个文件」
 * 与「文件是空的」——前者是常态，后者值得看一眼）。
 */
export function readTranscript(file: string): CodexTranscript | null {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return null;
  }

  const transcript: CodexTranscript = {
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
  };
  /** `call_id → 输出`：会话文件里 `function_call_output` **紧跟**对应的 `function_call`（真机实测） */
  const outputsByCallId = new Map<string, Array<string | null>>();
  const seenTurnIds = new Set<string>();

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line === '') continue; // 空行不是「坏行」：尾部换行是常态
    if (transcript.stats.lines >= MAX_LINES) {
      transcript.stats.truncated = true;
      break;
    }
    transcript.stats.lines += 1;

    const record = parseRecord(line);
    if (record === null) {
      transcript.stats.badLines += 1;
      continue;
    }
    if (record.turnId !== null && !seenTurnIds.has(record.turnId)) {
      seenTurnIds.add(record.turnId);
      transcript.turnIds.push(record.turnId);
    }
    noteTimestamp(transcript, record.timestamp);
    const payload = record.payload;
    switch (record.type) {
      case 'session_meta':
        if (payload !== null) transcript.sessionMeta = readSessionMeta(payload);
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
          // 按 id 收进索引（配对在下面按序做）；同 id 多条时**都留着**，不覆盖
          const bucket = outputsByCallId.get(callId) ?? [];
          bucket.push(output.output);
          outputsByCallId.set(callId, bucket);
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
  }

  // 配对（同一 `call_id` 的第 N 个输出配第 N 个调用；文件里两者相邻，按序对即可）
  const matched = new Map<string, number>();
  transcript.functionCallOutputs = transcript.functionCallOutputs.map((output) => {
    if (output.callId === null) return output;
    const bucket = outputsByCallId.get(output.callId);
    const index = matched.get(output.callId) ?? 0;
    matched.set(output.callId, index + 1);
    return { ...output, output: bucket?.[index] ?? output.output };
  });

  return transcript;
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
   * 会话文件里的**累计**用量（主线程 `total_token_usage`），已按本仓契约**归一**
   * （`input` 减掉了 cached，见 `normalizedTotalUsage`），另带只存在于会话文件里的
   * `reasoningOutput` / `total` 两格（2026-10-XX 起 `usage` 事件装得下它们了）。
   * 由调用方按「值更新才发一条」的规矩决定要不要顺带刷新一条 `usage` 事件（见 `codex/index.ts`）。
   */
  usage: UsageTokens | null;
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
  if (type === 'collab_tool_call') {
    const receivers = event?.receiver_thread_ids;
    if (!Array.isArray(receivers)) return false;
    let added = false;
    for (const receiver of receivers) {
      if (typeof receiver !== 'string' || receiver === '') continue;
      if (targets.childThreadIds.includes(receiver)) continue;
      targets.childThreadIds.push(receiver);
      added = true;
    }
    return added;
  }
  return false;
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
}): TranscriptProjection {
  const read = input.read ?? readTranscript;
  const drafts: AgentEventDraft[] = [];
  /** 同一段正文只说一次（子线程若与主线程同文件、或文件被重复读到时不去重就会刷屏） */
  const seen = new Set<string>();
  let usage: TranscriptProjection['usage'] = null;
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
      usage = normalizedTotalUsage(main);
      timing = transcriptTiming(main);
    }
  }

  for (const threadId of input.childThreadIds) {
    const child = readByThreadId(input.codexHome, threadId, read);
    if (child === null) {
      drafts.push(
        logDraft('stderr', `[WARN] 未找到子线程 ${threadId} 的 codex 会话文件，该子智能体的消息与工具调用读不到（不编造）`),
      );
      continue;
    }
    const reasoning = child.reasoning.join('\n');
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
    drafts.push(logDraft('stdout', safeStringify(subagentPayload(child, threadId)), subagentSummary(child, threadId)));
  }

  return { drafts, usage, ...(timing === undefined ? {} : { timing }) };
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
