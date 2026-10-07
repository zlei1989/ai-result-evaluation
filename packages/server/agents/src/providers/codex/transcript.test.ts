// @vitest-environment node
/**
 * codex 会话文件（rollout）读取与投影。
 *
 * ⚠️ **夹具全部是这里内联的合成字符串**（用户口径：不许把 `probe/dumps/` 下的真实产物拷进仓库
 * ——那是 gitignore 的）。合成的好处不只是体积：它把「我们**认为**会话文件长什么样」这件事
 * 写成了可执行断言，将来 CLI 换形状时红的正是这里，而不是某个「推理正文悄悄没了」的静默现象。
 *
 * 覆盖的形状（逐条对应要点）：
 *   ① 推理正文提取（`content[].reasoning_text`，多块拼接）；
 *   ② `content` 为空 ⇒ `null`（**不得**回落 `summary` 或 token 数）；
 *   ③ 子线程 `session_meta` 的 `parent_thread_id` / `depth` / `agent_nickname`；
 *   ④ `token_count` 各字段落位（含只存在于会话文件里的 `reasoning_output_tokens`）；
 *   ⑤ 坏行计数不炸；
 *   ⑥ fork 抄进来的两份东西**都不算数**（2026-10-XX 修复）：第 2 条 `session_meta` 是派发者副本
 *      ⇒ 身份仍取**文件自己**那一份；派发者那一轮的开工痕迹（`task_started` / `turn_context`）
 *      ⇒ **不算一轮**（判据见 `readTranscript` 的 `turnBuckets`）。
 * 另外覆盖：递归查找（跨日期目录 + 跨午夜）、跨 `threadId` 后缀不误命中、`turn_id` 去重、
 * 函数调用与输出的配对，以及 index 层的接线（跑完才读 / 抛错不改结论 / 失败不读）。
 */
import type { AgentEvent, AgentMessage, SubagentRecord } from '@aieval/contracts';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setAgentRuntimeForTesting } from '../../runtime';
import { createMessageAssembler } from '../../message';
import { collectEvents, createFakeCodexSdk, createRecorder, createRunInput, createTurnState } from '../../testing/agent-fixtures';
import { codexProvider } from './index';
import { projectCodexEvent } from './events';
import { projectCodexMessages } from './message';
import { codexEventToMessage } from './message-events';
import { CODEX_PACKAGE_NAME } from './sdk';
import {
  discoverChildThreads,
  findTranscript,
  MAX_DISCOVERED_CHILD_THREADS,
  noteThreadIds,
  parseRecord,
  projectChildThreadUsage,
  projectTranscriptDrafts,
  readTranscript,
  reasoningTextOf,
  spawnedThreadIdsOf,
  type CodexTranscript,
  type TranscriptProjection,
  type TranscriptTargets,
} from './transcript';
// ─────────────────────────────────────────────────────────────────────────────
// 合成夹具：每一行都是「一行一个 JSON」的字面量
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 会话文件里 `payload` **自带 `type`**（真机形状）。
 * 为什么两种形状都要有夹具：题面给的逐字样例是「外层 `type` 就是语义类型、`payload` 里没有 `type`」，
 * 而本仓在真机 dump 上见过的是「外层 `response_item`、内层 `payload.type` 才有语义」。
 * 读取层必须两种都认（判据写成 `payload.type ?? 外层 type`），所以两种都钉一遍。
 */
const line = (record: Record<string, unknown>): string => JSON.stringify(record);

const sessionMetaLine = (overrides: {
  id: string;
  sessionId: string;
  parentThreadId: string | null;
  threadSpawn: Record<string, unknown> | null;
  /** 会话**被创建**的时刻（内层 `payload.timestamp`）；缺省 = 真机夹具那个固定值 */
  timestamp?: string;
  /**
   * 这一**行**被写下来的时刻（外层 `timestamp`）；缺省 = 与 `timestamp` 同值。
   * 为什么留这一格：真机上外层比内层晚一点点（实测 **109ms**），而那个差值正是
   * 「fork 出来的嵌套线程会被时序判据误判」这条坑的来源（见 R7 评审那一条用例）。
   */
  lineTimestamp?: string;
}): string =>
  line({
    timestamp: overrides.lineTimestamp ?? overrides.timestamp ?? '2026-09-30T21:24:34.570Z',
    ordinal: 0,
    type: 'session_meta',
    payload: {
      session_id: overrides.sessionId,
      id: overrides.id,
      parent_thread_id: overrides.parentThreadId,
      timestamp: overrides.timestamp ?? '2026-09-30T21:24:34.570Z',
      cwd: 'D:/work/repo',
      originator: 'codex_exec',
      cli_version: '0.154.0',
      source:
        overrides.threadSpawn === null ? { subagent: null } : { subagent: { thread_spawn: overrides.threadSpawn } },
    },
  });

const MAIN_THREAD_ID = '01a0f434-707e-7563-9f07-95f376e7b56a';
const PARENT_THREAD_ID = '01a0f434-5def-7161-afca-c0a8934ee770';
const CHILD_THREAD_ID = '01a0f434-aaaa-7161-afca-c0a8934ee999';

/** 主线程那份：`parent_thread_id` 为 **null**（这一格就是「我是不是子线程」的判据） */
const MAIN_META = sessionMetaLine({
  id: MAIN_THREAD_ID,
  sessionId: MAIN_THREAD_ID,
  parentThreadId: null,
  threadSpawn: null,
});

/** 子线程那份：`parent_thread_id` 非空 + `thread_spawn` 带 depth / agent_nickname */
const CHILD_META = sessionMetaLine({
  id: CHILD_THREAD_ID,
  sessionId: PARENT_THREAD_ID, // 真机：子线程那份的 session_id 等于**父**线程 id
  parentThreadId: PARENT_THREAD_ID,
  threadSpawn: {
    parent_thread_id: PARENT_THREAD_ID,
    depth: 1,
    agent_path: null,
    agent_nickname: '工作区检查',
  },
});

/** 主线程正文：推理 → 工具调用 → 工具输出 → 答复 → 计量，末尾带一个坏行 */
const MAIN_TRANSCRIPT_LINES: readonly string[] = [
  MAIN_META,
  /** 推理正文在 `content[].reasoning_text`；`summary` 是**空数组**（真机） */
  line({
    timestamp: '2026-09-30T21:24:40.000Z',
    ordinal: 1,
    type: 'response_item',
    turn_id: 'turn-1',
    payload: {
      type: 'reasoning',
      id: 'rs-1',
      summary: [],
      content: [{ reasoning_text: '先看看仓库结构。' }, { reasoning_text: '然后读 README。' }],
      encrypted_content: 'gAAAA…',
    },
  }),
  line({
    timestamp: '2026-09-30T21:24:41.000Z',
    ordinal: 2,
    type: 'response_item',
    turn_id: 'turn-1',
    payload: {
      type: 'function_call',
      name: 'exec_command',
      arguments: '{"cmd":"ls"}',
      call_id: 'call-1',
    },
  }),
  line({
    timestamp: '2026-09-30T21:24:42.000Z',
    ordinal: 3,
    type: 'response_item',
    turn_id: 'turn-1',
    payload: { type: 'function_call_output', call_id: 'call-1', output: 'README.md\nsrc\n' },
  }),
  /** `message`：`{role, content:[{type,text}]}`；这里的 `type` 在 `payload` 里 */
  line({
    timestamp: '2026-09-30T21:24:43.000Z',
    ordinal: 4,
    type: 'response_item',
    turn_id: 'turn-1',
    payload: {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: '仓库里有 README 与 src。' }],
    },
  }),
  /** `token_count`：`reasoning_output_tokens` 只在这里出现（事件流的 turn.completed 没有它） */
  line({
    timestamp: '2026-09-30T21:24:44.000Z',
    ordinal: 5,
    type: 'event_msg',
    turn_id: 'turn-1',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: {
          input_tokens: 1000,
          cached_input_tokens: 900,
          cache_write_input_tokens: 0,
          output_tokens: 50,
          reasoning_output_tokens: 30,
          total_tokens: 1050,
        },
        last_token_usage: {
          input_tokens: 1000,
          cached_input_tokens: 900,
          cache_write_input_tokens: 0,
          output_tokens: 50,
          reasoning_output_tokens: 30,
          total_tokens: 1050,
        },
        model_context_window: 128000,
      },
    },
  }),
  line({ timestamp: '2026-09-30T21:24:45.000Z', ordinal: 6, type: 'event_msg', payload: { type: 'task_started' } }),
  '{这一行不是合法 JSON',
  '',
];

/** 上游只回密文的那一格（`content: []`）：正文必须是 `null`，**不得**回落 `summary` */
const ENCRYPTED_ONLY_LINES: readonly string[] = [
  MAIN_META,
  line({
    timestamp: '2026-09-30T21:24:40.000Z',
    ordinal: 1,
    type: 'response_item',
    payload: {
      type: 'reasoning',
      id: 'rs-enc',
      summary: [{ text: '这是摘要，不是正文' }],
      content: [],
      encrypted_content: 'gAAAA…',
    },
  }),
];

/** 子线程的正文：它自己的消息（`role` 见 `assistant`）与**工具真名**（`spawn_agent` 而不是什么别名） */const CHILD_TRANSCRIPT_LINES: readonly string[] = [
  CHILD_META,
  line({
    timestamp: '2026-09-30T21:24:50.000Z',
    ordinal: 1,
    type: 'response_item',
    turn_id: 'turn-1',
    payload: {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'README 的标题是「示例项目」。' }],
    },
  }),
  line({
    timestamp: '2026-09-30T21:24:51.000Z',
    ordinal: 2,
    type: 'response_item',
    turn_id: 'turn-1',
    payload: { type: 'function_call', name: 'spawn_agent', arguments: '{"task":"x"}', call_id: 'call-9' },
  }),
];

// ─────────────────────────────────────────────────────────────────────────────
// 消息归一用的夹具（`event_msg/item_completed`：模型产出与工具执行的**权威载体**）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 一条已完成条目。真机的 `payload.item.type` 是**大写驼峰**（`AgentMessage` / `Reasoning` /
 * `CommandExecution` / `CollabAgentToolCall` / `UserMessage`），与事件流那个小写派生名
 * （`agent_message` / `reasoning` / `command_execution`）**不是一个词汇表**——两处都要按实测写。
 */
const itemCompletedLine = (item: Record<string, unknown>, turnId = 'turn-1'): string =>
  line({
    timestamp: '2026-09-30T21:24:41.500Z',
    ordinal: 9,
    type: 'event_msg',
    turn_id: turnId,
    payload: { type: 'item_completed', thread_id: MAIN_THREAD_ID, turn_id: turnId, item, started_at_ms: 1, completed_at_ms: 2 },
  });

/** 主线程的消息夹具：推理 → 一次 shell（调用 + 结果）→ 答复；`UserMessage` 不该产出消息 */
const MAIN_MESSAGE_LINES: readonly string[] = [
  MAIN_META,
  line({
    timestamp: '2026-09-30T21:24:41.000Z',
    ordinal: 2,
    type: 'response_item',
    turn_id: 'turn-1',
    payload: { type: 'function_call', name: 'exec_command', arguments: '{"cmd":"npm run build"}', call_id: 'call-1' },
  }),
  itemCompletedLine({ type: 'UserMessage', id: 'um-1', content: [{ type: 'text', text: '把构建跑起来' }] }),
  itemCompletedLine({ type: 'Reasoning', id: 'rs-1', summary_text: [], raw_content: ['先跑构建。'] }),
  itemCompletedLine({
    type: 'CommandExecution',
    id: 'call-1',
    command: ['powershell.exe', '-Command', 'npm run build'],
    aggregated_output: 'error TS2304',
    exit_code: 1,
    status: 'completed',
  }),
  itemCompletedLine({ type: 'AgentMessage', id: 'msg-1', content: [{ type: 'Text', text: '构建失败：TS2304。' }] }),
];

/** 子线程的消息夹具 + 它自己的 `token_count`（子任务级用量的唯一来源） */
const CHILD_MESSAGE_LINES: readonly string[] = [
  CHILD_META,
  itemCompletedLine({ type: 'AgentMessage', id: 'child-msg', content: [{ type: 'Text', text: 'CHILD-TOOL-RAN' }] }),
  line({
    timestamp: '2026-09-30T21:24:52.000Z',
    ordinal: 2,
    type: 'event_msg',
    turn_id: 'turn-1',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: {
          input_tokens: 1000,
          cached_input_tokens: 900,
          cache_write_input_tokens: 0,
          output_tokens: 50,
          reasoning_output_tokens: 30,
          total_tokens: 1050,
        },
        model_context_window: 128000,
      },
    },
  }),
];

// ─────────────────────────────────────────────────────────────────────────────
// 临时目录与断言小工具
// ─────────────────────────────────────────────────────────────────────────────
let scratch: string | null = null;

/**
 * 造一个临时的 `CODEX_HOME`，把给定的会话文件写到指定相对路径下。
 * 为什么真的落盘：`findTranscript` / `readTranscript` 的**全部意义**就是读盘，
 * 用内存假文件系统去测它们等于把被测对象换成另一个实现。
 */
function makeCodexHome(files: Record<string, readonly string[]>): string {
  scratch = mkdtempSync(join(tmpdir(), 'aieval-codex-transcript-'));
  for (const [relative, lines] of Object.entries(files)) {
    const file = join(scratch, relative);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
  }
  return scratch;
}

/** 在 scratch 里再写一个文件（同一个 `CODEX_HOME` 下可以有多个会话文件） */
function writeInto(home: string, relative: string, lines: readonly string[]): string {
  const file = join(home, relative);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
  return file;
}

/** 会话文件的相对路径（`年/月/日` 三级 + 文件名末尾是线程 id） */
function rolloutPath(threadId: string): string {
  return join('sessions', '2026', '09', '30', `rollout-2026-09-30T21-24-34-570Z-${threadId}.jsonl`);
}

/**
 * 造一个**真的** `CODEX_HOME`，里面放主线程与子线程两份会话文件。
 * 为什么接线用例也走真文件（而不是注入一个内存读取器）：`finalize` 那一层的第一步是
 * **在盘上找文件**，注入读取器会把「找」这一步一起跳过——而那正是最容易错的一格
 * （文件名末尾必须真的等于线程 id）。真文件让整条链（找 → 读 → 投影 → 发事件）都被覆盖。
 */
function makeRealCodexHome(): string {
  const home = makeCodexHome({ 'sessions/keep.txt': ['x'] });
  writeInto(home, rolloutPath(MAIN_THREAD_ID), MAIN_TRANSCRIPT_LINES);
  writeInto(home, rolloutPath(CHILD_THREAD_ID), CHILD_TRANSCRIPT_LINES);
  return home;
}

/** 注入用的「一读就炸」读取器（测骨架对收尾抛错的处置） */
function throwingReader(message: string): { read: () => never } {
  return {
    read: () => {
      throw new Error(message);
    },
  };
}

/** 一条日志载荷里那个 `kind`（不是 JSON / 没有 kind 时为 null） */
function kindOfText(text: string): string | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const kind = (parsed as { kind?: unknown }).kind;
    return typeof kind === 'string' ? kind : null;
  } catch {
    return null;
  }
}

/** 从**已发出**的事件里取 `kind`（`null` = 不是 JSON 日志） */
function kindOf(event: AgentEvent): string | null {
  return event.type === 'log' ? kindOfText(event.text) : null;
}

/** 从一条 draft 的日志里取载荷（不是日志 / 解析不了时给空对象） */
function payloadOf(draft: { type: string; text?: string } | undefined): Record<string, unknown> {
  if (draft === undefined || draft.type !== 'log' || draft.text === undefined) return {};
  try {
    const parsed: unknown = JSON.parse(draft.text);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** 在 drafts 里找 `kind` 匹配的那一条，返回它的载荷 */
function findPayload(drafts: ReadonlyArray<{ type: string; text?: string }>, kind: string): Record<string, unknown> {
  return payloadOf(drafts.find((draft) => draft.type === 'log' && kindOfText(draft.text ?? '') === kind));
}

afterEach(() => {
  setAgentRuntimeForTesting(null);
  if (scratch !== null) {
    rmSync(scratch, { recursive: true, force: true });
    scratch = null;
  }
});

// ─────────────────────────────────────────────────────────────────────────────

describe('reasoningTextOf —— 推理正文的唯一来源', () => {
  it('拼 `content[].reasoning_text`（真机形状；`summary` 是空数组，一个字段都不掺）', () => {
    const record = parseRecord(MAIN_TRANSCRIPT_LINES[1] ?? '');
    expect(record?.type).toBe('reasoning');
    expect(reasoningTextOf(record ?? { payload: null })).toBe('先看看仓库结构。\n然后读 README。');
  });

  it('`content` 为空 ⇒ null（上游只回密文的那一格；**不**回落 summary、**不**编空串）', () => {
    const record = parseRecord(ENCRYPTED_ONLY_LINES[1] ?? '');
    expect(record?.type).toBe('reasoning');
    expect(reasoningTextOf(record ?? { payload: null })).toBeNull();
  });

  it('`content` 缺失 / 不是数组 / 块里没有 `reasoning_text` ⇒ 一律 null（不猜）', () => {
    expect(reasoningTextOf({ payload: { type: 'reasoning' } })).toBeNull();
    expect(reasoningTextOf({ payload: { type: 'reasoning', content: 'x' } })).toBeNull();
    expect(reasoningTextOf({ payload: { type: 'reasoning', content: [{ text: '不是这个字段' }] } })).toBeNull();
    expect(reasoningTextOf({ payload: { type: 'reasoning', content: [{ reasoning_text: '' }] } })).toBeNull();
  });

  it('外层没有 payload.type 时也能认出类型（`payload.type ?? 外层 type`）', () => {
    // 题面逐字样例的形状：`type` 与 `payload` 平级，`payload` 里没有 `type`
    const record = parseRecord(
      line({ timestamp: 't', ordinal: 1, type: 'reasoning', payload: { content: [{ reasoning_text: '样例形状' }] } }),
    );
    expect(record?.type).toBe('reasoning');
    expect(reasoningTextOf(record ?? { payload: null })).toBe('样例形状');
  });
});

describe('readTranscript —— 逐行解析', () => {
  it('坏行跳过但计数；其余字段各就各位（含 `reasoning_output_tokens`）', () => {
    const home = makeCodexHome({ [rolloutPath(MAIN_THREAD_ID)]: MAIN_TRANSCRIPT_LINES });
    const file = findTranscript(home, MAIN_THREAD_ID);
    expect(file).not.toBeNull();
    const parsed = readTranscript(String(file)) as CodexTranscript;

    // ⑤ 坏行计数不炸：8 行内容里有一行不是 JSON、一行是空行（空行**不算**坏行）
    expect(parsed.stats).toEqual({ lines: 8, badLines: 1, truncated: false });
    // ① 推理正文
    expect(parsed.reasoning).toEqual(['先看看仓库结构。\n然后读 README。']);
    // `session_meta`（主线程那份 parent 为 null）
    expect(parsed.sessionMeta?.threadId).toBe(MAIN_THREAD_ID);
    expect(parsed.sessionMeta?.parentThreadId).toBeNull();
    expect(parsed.sessionMeta?.cliVersion).toBe('0.154.0');
    expect(parsed.sessionMeta?.threadSpawn).toBeNull();
    // 工具调用保留**工具真名**，输出按 `call_id` 配上
    expect(parsed.functionCalls).toEqual([
      { name: 'exec_command', arguments: '{"cmd":"ls"}', callId: 'call-1', turnId: 'turn-1' },
    ]);
    expect(parsed.functionCallOutputs).toEqual([{ callId: 'call-1', output: 'README.md\nsrc\n', turnId: null }]);
    // `message` 的 role 与正文
    expect(parsed.messages).toEqual([
      { role: 'assistant', text: '仓库里有 README 与 src。', blockTypes: ['output_text'], turnId: 'turn-1' },
    ]);
    // ④ token_count 字段落位（推理输出 token 只有这里才有）
    expect(parsed.tokenCounters).toHaveLength(1);
    expect(parsed.tokenCounters[0]?.totalUsage).toEqual({
      input: 1000,
      cachedInput: 900,
      cacheWriteInput: 0,
      output: 50,
      reasoningOutput: 30,
      total: 1050,
    });
    expect(parsed.tokenCounters[0]?.lastUsage?.reasoningOutput).toBe(30);
    expect(parsed.tokenCounters[0]?.modelContextWindow).toBe(128000);
    // `turn_id` 去重后按**首次出现顺序**（同一轮的多条只算一个）
    expect(parsed.turnIds).toEqual(['turn-1']);
  });

  it('字段缺失一律 null，**绝不填 0**（`token_count` 的 info 整个缺失也一样）', () => {
    const home = makeCodexHome({
      [rolloutPath(MAIN_THREAD_ID)]: [
        MAIN_META,
        line({ timestamp: 't', ordinal: 1, type: 'event_msg', payload: { type: 'token_count' } }),
      ],
    });
    const parsed = readTranscript(String(findTranscript(home, MAIN_THREAD_ID)));
    expect(parsed?.tokenCounters[0]?.totalUsage).toBeNull();
    expect(parsed?.tokenCounters[0]?.lastUsage).toBeNull();
    expect(parsed?.tokenCounters[0]?.modelContextWindow).toBeNull();
  });

  it('读不出来的文件 ⇒ null（调用方据此区分「没有这个文件」与「文件是空的」）', () => {
    expect(readTranscript(join(tmpdir(), 'aieval-does-not-exist-9f3a.jsonl'))).toBeNull();
  });
});

describe('findTranscript —— 递归查找', () => {
  it('在 `sessions/年/月/日/` 下按**文件名末尾的线程 id** 找到文件（不靠日期推算）', () => {
    const home = makeCodexHome({
      'sessions/2026/09/30/rollout-2026-09-30T21-24-34-570Z-aaa.jsonl': [MAIN_META],
    });
    // 日期目录**故意**与实际无关：判据只看文件名末尾的线程 id
    const found = findTranscript(home, 'aaa');
    expect(found).not.toBeNull();
    expect(found?.endsWith(join('2026', '09', '30', 'rollout-2026-09-30T21-24-34-570Z-aaa.jsonl'))).toBe(true);
  });

  it('跨午夜那一份也找得到（同一次运行的会话可以落在**不同的日期目录**下）', () => {
    const home = makeCodexHome({
      // 按会话开始时间拼 `年/月/日` 的旧写法只能命中时间戳命名的那个，跨午夜时另一个就永远找不到
      'sessions/2026/09/30/rollout-2026-09-30T23-59-00-000Z-nav.jsonl': [MAIN_META],
      'sessions/2026/10/01/rollout-2026-10-01T00-01-00-000Z-aaa.jsonl': [MAIN_META],
    });
    expect(findTranscript(home, 'aaa')).not.toBeNull();
  });

  it('线程 id 必须落在**文件名末尾**：另一个线程（`xaaa`）不算命中', () => {
    const home = makeCodexHome({
      'sessions/2026/09/30/rollout-2026-09-30T21-24-34-570Z-xaaa.jsonl': [MAIN_META],
    });
    expect(findTranscript(home, 'aaa')).toBeNull();
    expect(findTranscript(home, 'xaaa')).not.toBeNull();
  });

  it('目录不存在 / 空 id ⇒ null（**不抛**）', () => {
    const home = makeCodexHome({ 'sessions/keep.txt': ['x'] });
    expect(findTranscript(home, 'nope')).toBeNull();
    expect(findTranscript(join(home, '根本没有这个目录'), 'aaa')).toBeNull();
    // 空 id 会让「以 `-.jsonl` 结尾」退化成「任意会话文件」，必须挡住
    expect(findTranscript(home, '')).toBeNull();
  });

  it('多个候选时取排序后的第一个（ISO 时间戳前缀 ⇒ 最早的那份；结果与遍历顺序无关）', () => {
    const home = makeCodexHome({
      'sessions/2026/09/30/rollout-2026-09-30T22-00-00-000Z-dup.jsonl': [MAIN_META],
      'sessions/2026/09/29/rollout-2026-09-29T10-00-00-000Z-dup.jsonl': [MAIN_META],
    });
    expect(findTranscript(home, 'dup')).toContain('2026-09-29');
  });
});

describe('noteThreadIds —— 只从事件流里取 id', () => {
  it('`thread.started.thread_id` 给主线程；`collab_tool_call.receiver_thread_ids` 给子线程（去重、保序）', () => {
    const targets: TranscriptTargets = { mainThreadId: null, childThreadIds: [] };
    noteThreadIds(targets, { type: 'turn.started' });
    expect(targets).toEqual({ mainThreadId: null, childThreadIds: [] });

    noteThreadIds(targets, { type: 'thread.started', thread_id: 'main-1' });
    expect(targets.mainThreadId).toBe('main-1');

    expect(noteThreadIds(targets, { type: 'collab_tool_call', receiver_thread_ids: ['c1', 'c2', 'c1'] })).toBe(true);
    expect(targets.childThreadIds).toEqual(['c1', 'c2']);
    // 没有新增时返回 false（调用方据此决定要不要记日志）
    expect(noteThreadIds(targets, { type: 'collab_tool_call', receiver_thread_ids: ['c2'] })).toBe(false);
  });

  /**
   * **真机的外面还包着一层 `item.*`**（2026-10-03 实测，用户口径「codex 子任务里面没有日志」）。
   *
   * 事件流给的是 `{ type:'item.completed', item:{ type:'collab_tool_call', receiver_thread_ids:[…] } }`，
   * 而原来只认顶层 `type === 'collab_tool_call'` ⇒ `childThreadIds` **永远是空的**：
   * 子线程的会话文件从来没被读过，子任务行没有名称/终态/结果摘要，子智能体自己的轨迹一条消息都没有。
   */
  it('内层 `item.type === collab_tool_call` 也要收（真机就是这种外形）', () => {
    const targets: TranscriptTargets = { mainThreadId: null, childThreadIds: [] };
    const added = noteThreadIds(targets, {
      type: 'item.completed',
      item: { id: 'item_8', type: 'collab_tool_call', tool: 'spawn_agent', receiver_thread_ids: ['child-1'] },
    });
    expect(added).toBe(true);
    expect(targets.childThreadIds).toEqual(['child-1']);
  });

  it('形状不对时一个 id 都不收（宁可少收一个，也不拿猜出来的 id 去读盘）', () => {
    const targets: TranscriptTargets = { mainThreadId: null, childThreadIds: [] };
    noteThreadIds(targets, { type: 'thread.started', thread_id: '' });
    noteThreadIds(targets, { type: 'thread.started' });
    noteThreadIds(targets, { type: 'collab_tool_call', receiver_thread_ids: 'c1' });
    noteThreadIds(targets, { type: 'collab_tool_call', receiver_thread_ids: [1, null, {}] });
    expect(targets).toEqual({ mainThreadId: null, childThreadIds: [] });
  });

  /**
   * 2026-10-04 评审 Minor 4：真机上没出现过「主线程被列进 `receiver_thread_ids`」，但这个形状一旦
   * 出现就要命——主线程的会话文件会被当成**一个子线程**再读一遍，`childUsageOf` 把它算进子那一份
   * （主线程算两遍），而「全量或 null」**抓不住**它（那条规则只挡「读不到」，不挡「重复」）。
   */
  it('`receiver_thread_ids` 里出现主线程 id 时跳过它，同一个数组里的真子线程照收', () => {
    const targets: TranscriptTargets = { mainThreadId: null, childThreadIds: [] };
    noteThreadIds(targets, { type: 'thread.started', thread_id: 'main-1' });

    const added = noteThreadIds(targets, { type: 'collab_tool_call', receiver_thread_ids: ['main-1', 'child-1'] });

    // 主线程那一份被跳过 ⇒ 它不会让 `childThreadIds` 凭空多出一格（`added` 仍为真：真的收了 child-1）
    expect(added).toBe(true);
    expect(targets.childThreadIds).toEqual(['child-1']);
    // 只列主线程时**一个都不收**，且返回 false（调用方据此不记日志）
    expect(noteThreadIds(targets, { type: 'collab_tool_call', receiver_thread_ids: ['main-1'] })).toBe(false);
    expect(targets.childThreadIds).toEqual(['child-1']);
  });
});

describe('projectTranscriptDrafts —— 接进事件模型', () => {
  it('主线程：thinking 载荷带 source / origin，另有一条读取面清单（坏行计数可见）', () => {
    const home = makeCodexHome({ [rolloutPath(MAIN_THREAD_ID)]: MAIN_TRANSCRIPT_LINES });
    const projected = projectTranscriptDrafts({
      codexHome: home,
      mainThreadId: MAIN_THREAD_ID,
      childThreadIds: [],
      read: readTranscript,
    });

    const thinking = findPayload(projected.drafts, 'thinking');
    expect(thinking.source).toBe('main');
    expect(thinking.origin).toBe('transcript');
    expect(thinking.threadId).toBe(MAIN_THREAD_ID);
    expect(thinking.text).toBe('先看看仓库结构。\n然后读 README。');

    const listed = findPayload(projected.drafts, 'transcript');
    expect(listed.badLines).toBe(1);
    expect(listed.turnIds).toEqual(['turn-1']);
    // 会话文件首末两行的时间戳也进清单（`timing` 缺数据时排障的唯一入口）
    expect(listed.firstTimestamp).toBe('2026-09-30T21:24:34.570Z');
    expect(listed.lastTimestamp).toBe('2026-09-30T21:24:45.000Z');
    /**
     * 累计用量单独交出去，且**已归一**（2026-10-XX 起 `usage` 事件装得下这五格）：
     *   · `input: 1000 − 900 = 100` —— codex 的 `input_tokens` **含**缓存读，契约的 `input` 不含
     *     ⇒ 归一化的减法就落在这一层（另一处在 `events.ts` 的 wire 通路，两处用同一份实现）；
     *   · `reasoningOutput` / `total` 是**只有会话文件里才有**的两格（事件流的 `turn.completed`
     *     不带它们）——这正是「跑完之后读一次会话文件」这条路的存在价值之一。
     */
    expect(projected.usage).toEqual({
      input: 100,
      cached: 900,
      output: 50,
      reasoningOutput: 30,
      total: 1050,
    });
    // 首末两点的时间跨度（`source: 'events'`：墙钟，含工具执行）——**这里只交两个时刻**，
    // 差值由骨架算（`turn.ts` 的 `resolveTiming`），本层不写第二个版本的换算
    expect(projected.timing).toEqual({
      firstMs: Date.parse('2026-09-30T21:24:34.570Z'),
      lastMs: Date.parse('2026-09-30T21:24:45.000Z'),
      apiMs: null,
      ttftMs: null,
      source: 'events',
    });
  });

  it('子线程：`kind: subagent` 载荷带上父链 / 深度 / 昵称，以及它自己的消息与工具真名', () => {
    const home = makeCodexHome({
      [rolloutPath(MAIN_THREAD_ID)]: [MAIN_META],
      [rolloutPath(CHILD_THREAD_ID)]: CHILD_TRANSCRIPT_LINES,
    });
    const projected = projectTranscriptDrafts({
      codexHome: home,
      mainThreadId: MAIN_THREAD_ID,
      childThreadIds: [CHILD_THREAD_ID],
      read: readTranscript,
    });

    const payload = findPayload(projected.drafts, 'subagent');
    // ③ 子线程 session_meta 的父链 / 深度 / 昵称（先前标为「无解」的缺口）
    expect(payload.parentThreadId).toBe(PARENT_THREAD_ID);
    expect(payload.parentToolUseId).toBe(PARENT_THREAD_ID);
    expect(payload.spawnDepth).toBe(1);
    expect(payload.agentNickname).toBe('工作区检查');
    expect(payload.name).toBe('工作区检查');
    expect(payload.subagentId).toBe(CHILD_THREAD_ID);
    expect(payload.vendorId).toBe(CHILD_THREAD_ID);
    // 不是生命周期事件：假装成 start 会让下游把一次派发数成两次
    expect(payload.phase).toBe('transcript');
    // 子智能体的消息与**工具真名**
    expect(payload.messages).toEqual([{ role: 'assistant', text: 'README 的标题是「示例项目」。' }]);
    expect(payload.functionCalls).toEqual([{ name: 'spawn_agent', arguments: '{"task":"x"}' }]);
    // 活动行是一句人话，不是 JSON
    const summary = projected.drafts.find((draft) => draft.type === 'log' && kindOfText(draft.text) === 'subagent');
    expect(summary?.type === 'log' ? summary.summary : null).toBe('子智能体记录（工作区检查，深度 1）');
  });

  it('读不到会话文件时落 WARN 日志（**不编造**，且「没读到」是可见的）', () => {
    const home = makeCodexHome({ 'sessions/keep.txt': ['x'] });
    const projected = projectTranscriptDrafts({
      codexHome: home,
      mainThreadId: 'missing-main',
      childThreadIds: ['missing-child'],
      read: readTranscript,
    });
    const texts = projected.drafts.map((draft) => (draft.type === 'log' ? draft.text : ''));
    expect(texts.some((text) => text.includes('未找到主线程'))).toBe(true);
    expect(texts.some((text) => text.includes('未找到子线程'))).toBe(true);
    expect(projected.usage).toBeNull();
    // 读不到文件 ⇒ **没有时间**（`undefined`）：绝不退回去拿我们自己的 `at` 冒充厂商时间
    expect(projected.timing).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 子线程并进合计（spec 2026-10-04 §2.3）：合成「主线程 + 若干子线程」的读取面
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 一个线程的会话文件行：`turnIds` 一行一个（`turn_id` 的去重与顺序在读取层，那一格正是
 * 「子线程轮次」的来源），末尾一行 `token_count`。
 *
 * ⚠️ `totalTokenUsage` 里的数用**我们归一后的词汇**（`input` = **非缓存**输入，与
 * `TranscriptProjection.usage` 同形）⇒ 落盘时要把 cached 加回 `input_tokens`：会话文件那一格
 * **含**缓存读，读取层会减掉它（`normalizedInput`）。不这样翻译，「主 100 / 子 10」这种输入
 * 在投影后会变成 `max(0, 100 − 900) = 0`，断言就与 brief 的数对不上了。
 *
 * ⚠️ **每一轮那一行必须是「本模块会消费」的记录类型**（2026-10-XX 修复）：轮次判据要求
 * 「这一轮**真的有内容**」——原先这里挂的是 `task_started`（**不消费**的那一档，与 fork 抄进来的
 * 开工痕迹同类）⇒ 读取层会正确地把它**排除**，于是这些夹具的轮次全变 0。这里改挂一条
 * `item_completed`（`item.type` 用 `UserMessage`）：它是消费类型（⇒ 这一轮算数），而消息投影对
 * 未映射的条目类型**不产出消息**（`message.ts` 的 `itemMessages` 末句），既不进 `TURN_ITEM_TYPES`
 * 的往返计数、也不改变既有断言。
 */
function threadLines(
  meta: string,
  spec: { totalTokenUsage: Record<string, number>; turnIds: string[] },
): string[] {
  const input = spec.totalTokenUsage.input ?? 0;
  const cached = spec.totalTokenUsage.cached ?? 0;
  const output = spec.totalTokenUsage.output ?? 0;
  return [
    meta,
    ...spec.turnIds.map((turnId, index) =>
      line({
        timestamp: '2026-09-30T21:24:40.000Z',
        ordinal: index,
        type: 'event_msg',
        turn_id: turnId,
        // 这一行只为带出 `turn_id`；类型必须落在「消费」那一档，否则这一轮不计（见上面的注记）
        payload: {
          type: 'item_completed',
          thread_id: null,
          turn_id: turnId,
          item: { type: 'UserMessage', id: `um-${turnId}`, content: [] },
          started_at_ms: 1,
          completed_at_ms: 2,
        },
      }),
    ),
    line({
      timestamp: '2026-09-30T21:24:44.000Z',
      ordinal: spec.turnIds.length,
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: {
            input_tokens: input + cached,
            cached_input_tokens: cached,
            output_tokens: output,
          },
        },
      },
    }),
  ];
}

/** 子线程的 `session_meta`（父链 / 深度 / 昵称与真机同形；名称用它自己的 id，一眼看得出是哪一条） */
function childMetaLine(threadId: string): string {
  return sessionMetaLine({
    id: threadId,
    sessionId: PARENT_THREAD_ID,
    parentThreadId: PARENT_THREAD_ID,
    threadSpawn: {
      parent_thread_id: PARENT_THREAD_ID,
      depth: 1,
      agent_path: null,
      agent_nickname: `子-${threadId}`,
    },
  });
}

/**
 * 合成「主线程 + 若干子线程」的读取面，跑一次 `projectTranscriptDrafts`。
 * 三格输入：主线程（用量 + turnIds）、子线程数组（同上）、`missing`（**只登记 id、不写文件**的线程
 * ⇒ 用来钉「读不到」那一档）。`codexHome` 用 `mkdtempSync`，`read` 用该文件既有的注入写法。
 */
function projectWith(input: {
  main: { totalTokenUsage: Record<string, number>; turnIds: string[] };
  children: { id: string; totalTokenUsage: Record<string, number>; turnIds: string[] }[];
  missing?: string[];
}): TranscriptProjection {
  const home = makeCodexHome({ [rolloutPath(MAIN_THREAD_ID)]: threadLines(MAIN_META, input.main) });
  for (const child of input.children) {
    writeInto(home, rolloutPath(child.id), threadLines(childMetaLine(child.id), child));
  }
  return projectTranscriptDrafts({
    codexHome: home,
    mainThreadId: MAIN_THREAD_ID,
    // `missing` 里的线程**只登记 id**（盘上没有它的文件）⇒ 这正是「有子线程但读不到」那一档
    childThreadIds: [...input.children.map((child) => child.id), ...(input.missing ?? [])],
    read: readTranscript,
  });
}

describe('子线程并进合计（spec 2026-10-04 §2.3）', () => {
  it('主线程与子线程的用量相加；子那一份单独给出；轮次取两边的 turnIds 之和', () => {
    const projected = projectWith({
      main: { totalTokenUsage: { input: 100, cached: 900, output: 50 }, turnIds: ['t1', 't2'] },
      children: [
        { id: 'c1', totalTokenUsage: { input: 10, cached: 20, output: 5 }, turnIds: ['u1'] },
        { id: 'c2', totalTokenUsage: { input: 1, cached: 2, output: 3 }, turnIds: ['v1', 'v2'] },
      ],
    });
    expect(projected.usage).toMatchObject({ input: 111, cached: 922, output: 58 });
    expect(projected.subagentUsage).toMatchObject({ input: 11, cached: 22, output: 8 });
    expect(projected.subagentTurns).toBe(3);
  });

  it('没有子线程 ⇒ 子那一份 {0,0,0}、轮次 0（确实没有，不是 null）', () => {
    const projected = projectWith({ main: { totalTokenUsage: { input: 5, cached: 0, output: 1 }, turnIds: ['t1'] }, children: [] });
    expect(projected.subagentUsage).toEqual({ input: 0, cached: 0, output: 0, reasoningOutput: null, total: null });
    expect(projected.subagentTurns).toBe(0);
  });

  it('某个子线程文件读不到 ⇒ 子那一份 null、合计退回主线程口径（全量或 null）', () => {
    const projected = projectWith({
      main: { totalTokenUsage: { input: 5, cached: 0, output: 1 }, turnIds: ['t1'] },
      children: [{ id: 'c1', totalTokenUsage: { input: 10, cached: 0, output: 1 }, turnIds: ['u1'] }],
      missing: ['c2'],
    });
    expect(projected.subagentUsage).toBeNull();
    expect(projected.subagentTurns).toBeNull();
    expect(projected.usage).toMatchObject({ input: 5, cached: 0, output: 1 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 嵌套子线程：沿 spawn 链递归发现（spec §4 R7，2026-10-XX 修复）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 一个「孙线程」id。它与 `CHILD_THREAD_ID` 的唯一区别是**没有任何父链**——这正是真机的形状：
 * 子线程没有多智能体工具，于是它 shell 出去起了一个新的 codex，那个新会话的 `session_meta`
 * 是 `source:"exec"`、无 `parent_thread_id`（`8e13e7a3` 那一轮的 `01a107a8-951e…` 逐字如此）。
 */
const GRANDCHILD_THREAD_ID = '01a0f434-bbbb-7161-afca-c0a8934ee111';

/** 第二个孙线程（用来钉「同层多个后代都要收」与「去重」） */
const GRANDCHILD_TWO_THREAD_ID = '01a0f434-cccc-7161-afca-c0a8934ee222';

/**
 * 一个**旧**会话的 id（R7 评审 Important 1：`codex exec resume` 复用旧会话那一档）。
 * 它落在盘上、读得到、用量很大——正是「全量或 null」接不住的那个形状。
 */
const STALE_THREAD_ID = '01a0f434-eeee-7161-afca-c0a8934ee333';

/**
 * 孙线程的 `session_meta`：**照真机写**——`source:"exec"`（`thread_spawn` 为 null）、
 * `parent_thread_id` 为 null、`session_id` 等于它自己。
 * 为什么这一格是这条用例的要点：**递归不能依赖父链**。真机上这些嵌套线程的父链根本不存在，
 * 唯一线索是派发者文件里那一条命令输出（`sessionBannerOutputLine`）⇒ 靠父链的实现必红。
 */
const nestedMetaLine = (threadId: string): string =>
  sessionMetaLine({ id: threadId, sessionId: threadId, parentThreadId: null, threadSpawn: null });

/**
 * 「子线程 shell 出去起了另一个 codex」的真实形状（逐字取自真机 `01a107a7-250e…jsonl` 的
 * `function_call_output`）：新会话 id 只出现在**命令输出**里，形状是 CLI 的启动横幅
 * （`session id: <uuid>` 独占一行，CRLF 结尾）。
 *
 * ⚠️ `turn_id` 用子线程**自己那一轮**的 id（`u1`，与 `threadLines` 里那个同值）：这条命令发生在
 * 子线程的某一轮**之内**，凭空写一个新 id 会多算一个轮次——而轮次是要进计量的。
 */
const sessionBannerOutputLine = (sessionId: string, callId: string): string =>
  sessionBannerOutputLineWithTurn(sessionId, callId, 'u1');

/**
 * 同上，但 `turn_id` 由调用方给（复核 A 的深度链要用它）：**每一条链文件属于不同的线程**，
 * 复用种子那个 `u1` 会让每条文件多算一个 `turn_id`（真机上同一线程内才同值）。
 */
const sessionBannerOutputLineWithTurn = (sessionId: string, callId: string, turnId: string): string =>
  line({
    timestamp: '2026-09-30T21:24:52.000Z',
    ordinal: 3,
    type: 'response_item',
    turn_id: turnId,
    payload: {
      type: 'function_call_output',
      id: 'fco-1',
      call_id: callId,
      output:
        'OpenAI Codex v0.156.1\r\n' +
        '--------\r\n' +
        'workdir: D:\\.tmp\\aieval\\runs\\x\\workspace\r\n' +
        'model: deepseek-flash\r\n' +
        'provider: aieval\r\n' +
        'approval: never\r\n' +
        'sandbox: danger-full-access\r\n' +
        'reasoning effort: none\r\n' +
        'reasoning summaries: none\r\n' +
        `session id: ${sessionId}\r\n` +
        '--------\r\n' +
        'user\r\n' +
        'Reply with exactly: SUBAGENT_OK\r\n',
    },
  });

/**
 * 子线程自己的 `item_completed` 里那条多智能体条目（外形①：厂商原生）。
 * `sender_thread_id` 用**它自己**：真机上这一格就是派发者。`turn_id` 同上（不虚增轮次）。
 */
const collabSpawnItemLine = (senderThreadId: string, receiverIds: readonly string[]): string =>
  line({
    timestamp: '2026-09-30T21:24:53.000Z',
    ordinal: 4,
    type: 'event_msg',
    turn_id: 'u1',
    payload: {
      type: 'item_completed',
      thread_id: senderThreadId,
      turn_id: 'u1',
      item: {
        type: 'CollabAgentToolCall',
        id: 'call-collab-1',
        tool: 'spawn_agent',
        status: 'completed',
        sender_thread_id: senderThreadId,
        receiver_thread_ids: [...receiverIds],
        receiver_agents: [],
      },
      started_at_ms: 1,
      completed_at_ms: 2,
    },
  });

/** CLI 启动横幅的原文（真机形状；`\r\n` 与末尾那段 user 提示都照抄） */
const codexBannerText = (sessionId: string): string =>
  'OpenAI Codex v0.156.1\r\n' +
  '--------\r\n' +
  'workdir: D:/work/repo\r\n' +
  'model: deepseek-flash\r\n' +
  'provider: aieval\r\n' +
  'approval: never\r\n' +
  'sandbox: danger-full-access\r\n' +
  'reasoning effort: none\r\n' +
  'reasoning summaries: none\r\n' +
  `session id: ${sessionId}\r\n` +
  '--------\r\n' +
  'user\r\n' +
  'Reply with exactly: SUBAGENT_OK\r\n';

/**
 * 横幅只出现在 **`CommandExecution` 条目**里的那种记录（评审 Minor 5 的覆盖面）。
 * 为什么必须有这一条：`spawnedThreadIdsOf` 的第三条扫描分支是
 * `stdout` / `aggregated_output` / `formatted_output` **三个字段**，而真机上这三格是**同值**的
 * ⇒ 夹具也照这个写：三格同一个 id（顺带钉住「三格重复只收一次」）。
 * 真机同一条命令在 `response_item.function_call_output` 与这里各记一份，本夹具**只留这一份**
 * ⇒ 覆盖的就是那一条分支本身（`function_call_output` 那条路由另一条用例覆盖）。
 *
 * ⚠️ 横幅里那个 id 由参数给（2026-10-XX 复核 A/F）：回指那条守卫要它点名**任意**一个线程
 * （自己 / 上一层），而「三格同值只收一次」那条要的正是**同一条记录里三格同值**这个形状。
 */
const commandExecutionBannerLine = (sessionId: string): string => {
  const banner = codexBannerText(sessionId);
  return line({
    timestamp: '2026-09-30T21:24:54.000Z',
    ordinal: 5,
    type: 'event_msg',
    turn_id: 'u1',
    payload: {
      type: 'item_completed',
      thread_id: CHILD_THREAD_ID,
      turn_id: 'u1',
      item: {
        type: 'CommandExecution',
        id: 'call-cmd-1',
        process_id: '79728',
        command: ['codex.exe', 'exec', 'Reply with exactly: SUBAGENT_OK'],
        source: 'unified_exec_startup',
        status: 'completed',
        stdout: banner,
        stderr: '',
        aggregated_output: banner,
        formatted_output: banner,
        exit_code: 0,
      },
      started_at_ms: 1,
      completed_at_ms: 2,
    },
  });
};

/**
 * 深度链上的第 `index` 层（深 1 = 种子那一层由 `childThreadIds` 给，这里从深 2 起用）。
 * 为什么不用现成的两个孙线程 id：这条守卫要的是一条**正好走到深度上限**的链（复核 A）。
 * ⚠️ 前缀刻意避开 `CHILD_THREAD_ID` 用的 `aaaa`：撞上「种子自己」会变成自指，链就短了一层。
 */
const chainThreadId = (index: number): string =>
  `01a0f434-ffff-7161-afca-0000000000${String(index).padStart(2, '0')}`;

/** 事件流点名的第 `index` 个种子（复核 B：种子数要多于广度上限） */
const seedThreadId = (index: number): string =>
  `01a0f434-bbbb-7161-afca-0000000000${String(index).padStart(2, '0')}`;

/** 全部 `kind: 'subagent'` 载荷（按出现顺序）——`findPayload` 只取第一条，这里要逐条看 */
function subagentPayloads(drafts: ReadonlyArray<{ type: string; text?: string }>): Record<string, unknown>[] {
  return drafts
    .filter((draft) => draft.type === 'log' && kindOfText(draft.text ?? '') === 'subagent')
    .map((draft) => payloadOf(draft));
}

describe('嵌套子线程沿 spawn 链递归发现（spec §4 R7）', () => {
  /**
   * 三层：主线程 →（事件流点名 `childThreadIds`）子线程 c1 →（**c1 文件里那一条命令输出**）孙线程 g1。
   *
   * 这条用例是 R7 的守卫，判据逐条对应缺口本身：
   *   · 孙线程**没有任何父链**（`nestedMetaLine`）⇒ 只有递归才找得到它；
   *   · 它的用量与轮次都要进**分量**（不只是进日志）；
   *   · `subagentTokens ≤ tokens` 仍成立（合计与分量同一遍折出来）。
   * 破法（mutation）：把 `discoverChildThreads` 的递归改回「只读 `childThreadIds` 那一层」，
   * 这条必红（分量变成 11/22/8 而不是 12/24/11）。
   */
  it('孙线程（无父链、只在子线程的命令输出里出现）的用量与轮次都进分量与合计', () => {
    const home = makeCodexHome({
      [rolloutPath(MAIN_THREAD_ID)]: threadLines(MAIN_META, {
        totalTokenUsage: { input: 100, cached: 900, output: 50 },
        turnIds: ['t1', 't2'],
      }),
    });
    writeInto(home, rolloutPath(CHILD_THREAD_ID), [
      ...threadLines(childMetaLine(CHILD_THREAD_ID), {
        totalTokenUsage: { input: 10, cached: 20, output: 5 },
        turnIds: ['u1'],
      }),
      sessionBannerOutputLine(GRANDCHILD_THREAD_ID, 'call-1'),
    ]);
    writeInto(home, rolloutPath(GRANDCHILD_THREAD_ID), threadLines(nestedMetaLine(GRANDCHILD_THREAD_ID), {
      totalTokenUsage: { input: 1, cached: 2, output: 3 },
      turnIds: ['w1', 'w2'],
    }));

    const projected = projectTranscriptDrafts({
      codexHome: home,
      mainThreadId: MAIN_THREAD_ID,
      // ⚠️ 事件流**只点名了 c1**：g1 完全靠递归发现
      childThreadIds: [CHILD_THREAD_ID],
      read: readTranscript,
    });

    // 分量 = c1(10/20/5) + g1(1/2/3)
    expect(projected.subagentUsage).toMatchObject({ input: 11, cached: 22, output: 8 });
    // 轮次：孙线程的 `turnIds` 也要算进来（c1 一轮 + g1 两轮）
    expect(projected.subagentTurns).toBe(3);
    // 合计 = 主(100/900/50) + 分量，且**同一遍**折出来 ⇒ `subagentTokens ≤ tokens` 天然成立
    expect(projected.usage).toMatchObject({ input: 111, cached: 922, output: 58 });

    // 孙线程自己也有一条 `kind: 'subagent'` 记录（否则「读到了但没投影」会静默）
    const ids = subagentPayloads(projected.drafts).map((payload) => payload.subagentId);
    expect(ids).toEqual([CHILD_THREAD_ID, GRANDCHILD_THREAD_ID]);

    /**
     * 运行期与终态**同一份判据**：`projectChildThreadUsage`（运行期那条取数面）给出的分量
     * 必须与上面那个一模一样的值。两处各写一遍递归，漂移的表现是「跑动期的子智能体用量
     * 与终态不一样」——这一条就是防它的。
     */
    const runtime = projectChildThreadUsage({
      codexHome: home,
      mainThreadId: MAIN_THREAD_ID,
      childThreadIds: [CHILD_THREAD_ID],
      read: readTranscript,
    });
    expect(runtime.usage).toEqual(projected.subagentUsage);
    expect(runtime.turns).toBe(projected.subagentTurns);
  });

  /**
   * 外形①（厂商原生）：子线程自己拿到了多智能体工具时，它派发的线程写在它自己的
   * `CollabAgentToolCall.receiver_thread_ids` 里——与主线程事件流那一格**同名同形**。
   * 同一条用例顺带钉住三种「不该被当成子线程」的形状：**自指**、**点名主线程**、**重复**。
   */
  it('子线程自己的 `receiver_thread_ids` 也要展开；自指 / 主线程 / 重复都不重复计入', () => {
    const home = makeCodexHome({
      [rolloutPath(MAIN_THREAD_ID)]: threadLines(MAIN_META, {
        totalTokenUsage: { input: 100, cached: 0, output: 10 },
        turnIds: ['t1'],
      }),
    });
    writeInto(home, rolloutPath(CHILD_THREAD_ID), [
      ...threadLines(childMetaLine(CHILD_THREAD_ID), {
        totalTokenUsage: { input: 10, cached: 0, output: 1 },
        turnIds: ['u1'],
      }),
      // 自指 + 主线程 + 同一个孙线程写两遍：只有孙线程该被收，且只收一次
      collabSpawnItemLine(CHILD_THREAD_ID, [
        CHILD_THREAD_ID,
        MAIN_THREAD_ID,
        GRANDCHILD_TWO_THREAD_ID,
        GRANDCHILD_TWO_THREAD_ID,
      ]),
    ]);
    writeInto(home, rolloutPath(GRANDCHILD_TWO_THREAD_ID), threadLines(nestedMetaLine(GRANDCHILD_TWO_THREAD_ID), {
      totalTokenUsage: { input: 1, cached: 0, output: 2 },
      turnIds: ['w1'],
    }));

    const projected = projectTranscriptDrafts({
      codexHome: home,
      mainThreadId: MAIN_THREAD_ID,
      childThreadIds: [CHILD_THREAD_ID],
      read: readTranscript,
    });
    // 主线程（100）绝不能被算进分量：分量只有 c1 与 g2
    expect(projected.subagentUsage).toMatchObject({ input: 11, cached: 0, output: 3 });
    expect(projected.subagentTurns).toBe(2);
    expect(projected.usage).toMatchObject({ input: 111, cached: 0, output: 13 });
    expect(subagentPayloads(projected.drafts).map((payload) => payload.subagentId)).toEqual([
      CHILD_THREAD_ID,
      GRANDCHILD_TWO_THREAD_ID,
    ]);
  });

  /**
   * 「全量或 null」在嵌套这一层照旧：**孙线程**读不到 ⇒ 整格 `null`、合计退回主线程口径，
   * 且 WARN **点名那个嵌套 id**（不点名就等于没报）。
   */
  it('孙线程读不到 ⇒ 分量整格 null、合计退回主线程口径，且 WARN 点名嵌套 id', () => {
    const home = makeCodexHome({
      [rolloutPath(MAIN_THREAD_ID)]: threadLines(MAIN_META, {
        totalTokenUsage: { input: 5, cached: 0, output: 1 },
        turnIds: ['t1'],
      }),
    });
    writeInto(home, rolloutPath(CHILD_THREAD_ID), [
      ...threadLines(childMetaLine(CHILD_THREAD_ID), {
        totalTokenUsage: { input: 10, cached: 0, output: 1 },
        turnIds: ['u1'],
      }),
      sessionBannerOutputLine(GRANDCHILD_THREAD_ID, 'call-1'),
    ]);
    // 孙线程**只登记在子线程的输出里**，盘上没有它的文件

    const projected = projectTranscriptDrafts({
      codexHome: home,
      mainThreadId: MAIN_THREAD_ID,
      childThreadIds: [CHILD_THREAD_ID],
      read: readTranscript,
    });
    expect(projected.subagentUsage).toBeNull();
    expect(projected.subagentTurns).toBeNull();
    // 合计退回主线程口径（**不是**「主 + 读到的那个子线程」的部分和）
    expect(projected.usage).toMatchObject({ input: 5, cached: 0, output: 1 });

    const texts = projected.drafts.map((draft) => (draft.type === 'log' ? draft.text : ''));
    // 只看 WARN：子任务载荷里也会出现那个 id（那是**派发证据**本身），别把它当成日志
    const warn = texts.find((text) => text.startsWith('[WARN]') && text.includes(GRANDCHILD_THREAD_ID));
    expect(warn).toContain('未找到嵌套子线程');
    expect(warn).toContain(CHILD_THREAD_ID); // 点出「谁派的」
  });

  /**
   * 横幅**只出现在 `CommandExecution` 的三格输出里**（`function_call_output` 那一路没有）。
   *
   * 为什么单独一条（评审 Minor 5）：`spawnedThreadIdsOf` 的第三条扫描分支
   * （`stdout` / `aggregated_output` / `formatted_output`）原先**一条合成覆盖都没有**——
   * 将来有人把那三个字段名改了，真机那两条嵌套子线程会**静默消失**，而那正是 R7 要消灭的形状。
   * 夹具照真机写：**三格同值**（真机就是三格同值）。
   *
   * ⚠️ **「三格同值只收一次」这件事由 `spawnedThreadIdsOf` 自己保证，不是 `enqueue` 的 `seen`**
   * （2026-10-XX 复核 F：原先这条用例的标题/注释把它记在 `enqueue` 名下，而 `enqueue` 的 `seen`
   * 挡的是**另一个**形状——递归撞上已入队的 id）：三格同值走的是**同一个函数、同一次调用**，
   * 而那个函数的 `collect` 本来就带自己的 `seen`。所以判据只能落在那一次调用上——把 `enqueue`
   * 的 `seen` 去掉，下面那两条聚合断言**照样是绿的**（同一条命令本来也只会入队一次）。
   */
  it('横幅只在 `CommandExecution` 的三格输出里（无 `function_call_output`）也能发现，三格同值只收一次', () => {
    const home = makeCodexHome({
      [rolloutPath(MAIN_THREAD_ID)]: threadLines(MAIN_META, {
        totalTokenUsage: { input: 100, cached: 0, output: 10 },
        turnIds: ['t1'],
      }),
    });
    writeInto(home, rolloutPath(CHILD_THREAD_ID), [
      ...threadLines(childMetaLine(CHILD_THREAD_ID), {
        totalTokenUsage: { input: 10, cached: 0, output: 1 },
        turnIds: ['u1'],
      }),
      commandExecutionBannerLine(GRANDCHILD_THREAD_ID),
    ]);
    writeInto(home, rolloutPath(GRANDCHILD_THREAD_ID), threadLines(nestedMetaLine(GRANDCHILD_THREAD_ID), {
      totalTokenUsage: { input: 1, cached: 0, output: 2 },
      turnIds: ['w1'],
    }));

    const projected = projectTranscriptDrafts({
      codexHome: home,
      mainThreadId: MAIN_THREAD_ID,
      childThreadIds: [CHILD_THREAD_ID],
      read: readTranscript,
    });
    /**
     * **这条才是「三格同值只收一次」的判据**（复核 F）：直接问**那一次扫描**交出了什么。
     * 三格同值而交出 `[g1]`（长度 1）⇒ 去重发生在扫描内部；若那个 `seen` 被去掉，这里立刻是
     * `[g1, g1, g1]`（长度 3）——而下游那两条聚合断言**看不出**这件事（`enqueue` 会替它兜住）。
     */
    const childTranscript = readTranscript(join(home, rolloutPath(CHILD_THREAD_ID)));
    expect(childTranscript).not.toBeNull();
    // 类型收窄：上一行的断言已经把 `null` 那一档排除了，这里只让编译器也知道
    if (childTranscript === null) throw new Error('夹具没读到子线程文件');
    expect(spawnedThreadIdsOf(childTranscript)).toEqual([GRANDCHILD_THREAD_ID]);

    // 下游照旧：孙线程进分量，且只进一次（11/0/3；轮次 = 子 1 + 孙 1）
    expect(projected.subagentUsage).toMatchObject({ input: 11, cached: 0, output: 3 });
    expect(projected.subagentTurns).toBe(2);
    expect(subagentPayloads(projected.drafts).map((payload) => payload.subagentId)).toEqual([
      CHILD_THREAD_ID,
      GRANDCHILD_THREAD_ID,
    ]);
  });

  /**
   * `codex exec resume <id>` 会打出**同一条横幅**、里面是**已存在**的会话 id ⇒ 光看横幅，「新起一个」
   * 与「接着一个旧会话跑」是同一条记录（评审 Important 1）。判据落在时序上：一个**早于派发者创建时刻**
   * 的会话必然是旧的（本行历次尝试留下的死会话就是这么被复用的）⇒ 排除，**不计入分量**，并点名。
   *
   * 破法（mutation）：把 `discoverChildThreads` 里那次 `predatesDispatcher` 判定去掉 ⇒ 这条必红
   * （那个旧会话的用量会被算进分量，这一行就从「少计」翻成「多计」）。
   */
  it('早于派发者创建时刻的会话（疑为 `codex exec resume` 复用的旧会话）被排除并点名，不进分量', () => {
    const home = makeCodexHome({
      [rolloutPath(MAIN_THREAD_ID)]: threadLines(MAIN_META, {
        totalTokenUsage: { input: 100, cached: 0, output: 10 },
        turnIds: ['t1'],
      }),
    });
    writeInto(home, rolloutPath(CHILD_THREAD_ID), [
      ...threadLines(childMetaLine(CHILD_THREAD_ID), {
        totalTokenUsage: { input: 10, cached: 0, output: 1 },
        turnIds: ['u1'],
      }),
      sessionBannerOutputLine(STALE_THREAD_ID, 'call-stale'),
    ]);
    /**
     * 那个「旧会话」：**文件在、读得到、用量还是个大数**（这正是要害——它读得到，所以
     * 「全量或 null」那条规则**接不住**它：那一档只挡「读不到」，不挡「算进了不该算的」）。
     * 它的 `session_meta.timestamp` 比子线程自己的创建时刻（`sessionMetaLine` 的默认值）早 24 分钟。
     */
    writeInto(home, rolloutPath(STALE_THREAD_ID), threadLines(
      sessionMetaLine({
        id: STALE_THREAD_ID,
        sessionId: STALE_THREAD_ID,
        parentThreadId: null,
        threadSpawn: null,
        timestamp: '2026-09-30T21:00:00.000Z',
      }),
      { totalTokenUsage: { input: 7000, cached: 0, output: 9000 }, turnIds: ['s1'] },
    ));

    const projected = projectTranscriptDrafts({
      codexHome: home,
      mainThreadId: MAIN_THREAD_ID,
      childThreadIds: [CHILD_THREAD_ID],
      read: readTranscript,
    });
    // 分量里**只有** c1：那个旧会话（7000/0/9000）一个字都不许进来
    expect(projected.subagentUsage).toMatchObject({ input: 10, cached: 0, output: 1 });
    expect(projected.subagentTurns).toBe(1);
    expect(projected.usage).toMatchObject({ input: 110, cached: 0, output: 11 });
    expect(subagentPayloads(projected.drafts).map((payload) => payload.subagentId)).toEqual([CHILD_THREAD_ID]);

    // 排除是**判断**，不是「没读到」⇒ 必须点名（不静默）
    const texts = projected.drafts.map((draft) => (draft.type === 'log' ? draft.text : ''));
    const warn = texts.find((text) => text.startsWith('[WARN]') && text.includes(STALE_THREAD_ID));
    expect(warn).toContain('resume');
    expect(warn).toContain(CHILD_THREAD_ID);
    // 而且**不是**「未找到」那一档（文件明明在）：两件事在日志里必须分得开
    expect(texts.some((text) => text.startsWith('[WARN]') && text.includes('未找到'))).toBe(false);
  });

  /**
   * 广度上限（评审 Important 2）：横幅行数多于 `MAX_DISCOVERED_CHILD_THREADS` 时，发现被**有界**截断，
   * 且算术**不静默改变**——被截断的清单不是全量 ⇒ 分量整格 `null`（**不是**「已发现那些的和」）。
   *
   * 破法（mutation）：把 `enqueue` 的上限判定去掉（或把常量调到很大）⇒ 这条必红
   * （分量会变成那三十几个孙线程的部分和，看起来完全正常）。
   */
  it(`横幅行数超过广度上限（${MAX_DISCOVERED_CHILD_THREADS}）⇒ 有界截断、分量整格 null 并点名上限`, () => {
    const home = makeCodexHome({
      [rolloutPath(MAIN_THREAD_ID)]: threadLines(MAIN_META, {
        totalTokenUsage: { input: 100, cached: 0, output: 10 },
        turnIds: ['t1'],
      }),
    });
    // 上限 + 2 个孙线程，**每一个都真的落盘、读得到**（⇒ null 只可能来自截断，不可能来自「读不到」）
    const grandchildIds = Array.from(
      { length: MAX_DISCOVERED_CHILD_THREADS + 2 },
      (_unused, index) => `01a0f434-dddd-7161-afca-00000000${String(index).padStart(4, '0')}`,
    );
    writeInto(home, rolloutPath(CHILD_THREAD_ID), [
      ...threadLines(childMetaLine(CHILD_THREAD_ID), {
        totalTokenUsage: { input: 10, cached: 0, output: 1 },
        turnIds: ['u1'],
      }),
      ...grandchildIds.map((id) => sessionBannerOutputLine(id, `call-${id}`)),
    ]);
    for (const id of grandchildIds) {
      writeInto(home, rolloutPath(id), threadLines(nestedMetaLine(id), {
        totalTokenUsage: { input: 1, cached: 0, output: 2 },
        turnIds: ['w1'],
      }));
    }

    const projected = projectTranscriptDrafts({
      codexHome: home,
      mainThreadId: MAIN_THREAD_ID,
      childThreadIds: [CHILD_THREAD_ID],
      read: readTranscript,
    });
    // 算术不静默改变：**不是**「前 N 个的和」，而是「这一格给不出来」
    expect(projected.subagentUsage).toBeNull();
    expect(projected.subagentTurns).toBeNull();
    expect(projected.usage).toMatchObject({ input: 100, cached: 0, output: 10 });

    // 有界：**发现到的**正好是上限（种子那一个不占预算 ⇒ 一共上限 + 1 个）
    expect(subagentPayloads(projected.drafts)).toHaveLength(MAX_DISCOVERED_CHILD_THREADS + 1);

    const texts = projected.drafts.map((draft) => (draft.type === 'log' ? draft.text : ''));
    const warn = texts.find((text) => text.startsWith('[WARN]') && text.includes('上限'));
    expect(warn).toContain(String(MAX_DISCOVERED_CHILD_THREADS));
    // 一条「未找到」都不该有：没有文件缺失，null 来自截断（两件事在日志里必须分得开）
    expect(texts.some((text) => text.startsWith('[WARN]') && text.includes('未找到'))).toBe(false);
  });

  /**
   * **广度预算不含种子**（2026-10-XX 复核 B）：事件流**直接点名**了 34 个（> 32）子线程时，
   * 一个线程文件都没多发现 ⇒ 什么都没被砍掉 ⇒ 分量照给，**不是**整格 `null`。
   *
   * 为什么这条值得单独一条守卫（复核给的理由）：把种子算进那 32 的预算，触发面是**非对抗的**
   * ——只要一行派了 33 个直接子线程，分量就整格 `null`，而 §2.3 / R7 从没说过 32 里含种子。
   * 预算封的是「我们沿 spawn 链额外读了多少个」，种子是事件流给的既成事实，条数由事件流自己封着。
   *
   * 破法（mutation）：把 `discovered` 换回 `queue.length`（= 种子又占上预算了）⇒ 这条必红
   * （后两个种子被当成「截断」丢掉 ⇒ 分量整格 `null`）。
   */
  it('事件流直接点名的种子多于广度上限 ⇒ 不截断、分量照给（预算只封「发现到的」那些）', () => {
    const home = makeCodexHome({ 'sessions/keep.txt': ['x'] });
    // 每一个种子都**真的落盘、读得到**（⇒ 若变成 null，只可能来自「被预算砍掉」，不可能来自「读不到」）
    const seedIds = Array.from({ length: MAX_DISCOVERED_CHILD_THREADS + 2 }, (_unused, index) => seedThreadId(index));
    writeInto(home, rolloutPath(MAIN_THREAD_ID), threadLines(MAIN_META, {
      totalTokenUsage: { input: 100, cached: 900, output: 50 },
      turnIds: ['t1'],
    }));
    for (const id of seedIds) {
      writeInto(home, rolloutPath(id), threadLines(childMetaLine(id), {
        totalTokenUsage: { input: 2, cached: 3, output: 4 },
        turnIds: ['u1'],
      }));
    }

    const projected = projectTranscriptDrafts({
      codexHome: home,
      mainThreadId: MAIN_THREAD_ID,
      childThreadIds: seedIds,
      read: readTranscript,
    });
    // 34 个种子全在分量里（每个 2/3/4）——一个都没被预算砍掉
    expect(projected.subagentUsage).toMatchObject({
      input: 2 * seedIds.length,
      cached: 3 * seedIds.length,
      output: 4 * seedIds.length,
    });
    expect(projected.subagentTurns).toBe(seedIds.length);
    expect(projected.usage).toMatchObject({ input: 168, cached: 1002, output: 186 });
    expect(subagentPayloads(projected.drafts)).toHaveLength(seedIds.length);

    const texts = projected.drafts.map((draft) => (draft.type === 'log' ? draft.text : ''));
    // 一条上限 WARN 都不该有：没有任何分支被砍掉
    expect(texts.some((text) => text.startsWith('[WARN]') && text.includes('上限'))).toBe(false);
  });

  /**
   * 上一条的反面：**递归自己发现到的**线程数超过预算时，仍然是「有界截断 + 整格 `null` + 点名上限」
   * （预算没有因为「种子不计入」而一起失效——那会从「非对抗的假 null」翻成「对抗性的部分和」）。
   *
   * 破法（mutation）：把 `discovered >= MAX_DISCOVERED_CHILD_THREADS` 整条判定去掉 ⇒ 这条必红
   * （分量变成 32 个孙线程的部分和，看起来完全正常）。
   */
  it('递归发现到的线程数超过广度上限 ⇒ 仍然有界截断、整格 null 并点名上限', () => {
    const home = makeCodexHome({
      [rolloutPath(MAIN_THREAD_ID)]: threadLines(MAIN_META, {
        totalTokenUsage: { input: 100, cached: 0, output: 10 },
        turnIds: ['t1'],
      }),
    });
    const grandchildIds = Array.from(
      { length: MAX_DISCOVERED_CHILD_THREADS + 2 },
      (_unused, index) => `01a0f434-dddd-7161-afca-00000000${String(index).padStart(4, '0')}`,
    );
    writeInto(home, rolloutPath(CHILD_THREAD_ID), [
      ...threadLines(childMetaLine(CHILD_THREAD_ID), {
        totalTokenUsage: { input: 2, cached: 0, output: 4 },
        turnIds: ['u1'],
      }),
      ...grandchildIds.map((id) => sessionBannerOutputLine(id, `call-${id}`)),
    ]);
    for (const id of grandchildIds) {
      writeInto(home, rolloutPath(id), threadLines(nestedMetaLine(id), {
        totalTokenUsage: { input: 1, cached: 0, output: 2 },
        turnIds: ['w1'],
      }));
    }

    const projected = projectTranscriptDrafts({
      codexHome: home,
      mainThreadId: MAIN_THREAD_ID,
      childThreadIds: [CHILD_THREAD_ID],
      read: readTranscript,
    });
    expect(projected.subagentUsage).toBeNull();
    expect(projected.subagentTurns).toBeNull();
    // 有界：1 个种子 + **上限**个发现到的（种子不占预算，发现的那些才占）
    expect(subagentPayloads(projected.drafts)).toHaveLength(MAX_DISCOVERED_CHILD_THREADS + 1);
    const texts = projected.drafts.map((draft) => (draft.type === 'log' ? draft.text : ''));
    const countWarn = texts.find((text) => text.startsWith('[WARN]') && text.includes('上限'));
    expect(countWarn).toContain(String(MAX_DISCOVERED_CHILD_THREADS));
    // 这一条到顶的是**线程数**上限（夹具里 32 个发现正好用满）——与深度那条路措辞不同
    expect(countWarn).toContain('到顶的是递归额外发现的线程数上限');
  });

  /**
   * **深度帽的判据要减掉 `seen`**（2026-10-XX 复核 A）：一个线程**正好坐在深度上限上**，而它文件里的
   * 「下游」是**回指**——写回自己（或写回上一层已经走过的那个）。`seen` 一个都不会放行 ⇒ 实际上
   * 一条线程文件都没漏读 ⇒ **不该**置 `truncated`：分量算得出来，也没有那句「不是全量」的 WARN
   * （那句话在这个形状下是**假的**，而代价是双份的：整格 `null` + 一句不实的警告）。
   *
   * 破法（mutation）：把判据换回 `childIds.length > 0`（光看「有没有下游」）⇒ 这条必红
   * （分量整格 `null`，且多出一句「不是全量」）。
   */
  it('回指正好落在深度上限上 ⇒ 不算截断：分量照给、也没有「不是全量」的 WARN', () => {
    const home = makeCodexHome({ 'sessions/keep.txt': ['x'] });
    writeInto(home, rolloutPath(MAIN_THREAD_ID), threadLines(MAIN_META, {
      totalTokenUsage: { input: 100, cached: 0, output: 10 },
      turnIds: ['t1'],
    }));
    /**
     * 深度链：种子 c1（深 1）→ c2 → … → c8（深 8 = 上限），每一层都用**它自己文件里的横幅**
     * 点名下一个 ⇒ 走到 c8 时 `discoveryDepth === MAX_SPAWN_DEPTH`。⚠️ 层数**从 2 数起**：种子
     * 自己已经吃掉深 1（`MAX_SPAWN_DEPTH` 是模块私有的，这里按它今天的值 **8** 写死）。
     *
     * ⚠️ **把那个常量调大，这条用例不会红**（2026-10-XX Wave A 复核指出：原先这里写着「改那个常量
     * 这条用例会跟着红」，**那句是错的**）：上限若变成 9，深度 8 就不再走那条分支，而 c8 的回指
     * 本来也被 `seen` 挡掉 ⇒ 分量与轮次一字不变，断言照样全绿。**「上限那个数」由下一条用例钉**
     * （深度 8 点到**盘上新线程** ⇒ 必须报告截断）。
     */
    const chain = Array.from({ length: 7 }, (_unused, index) => chainThreadId(index + 2));
    writeInto(home, rolloutPath(CHILD_THREAD_ID), [
      ...threadLines(childMetaLine(CHILD_THREAD_ID), { totalTokenUsage: { input: 2, cached: 0, output: 3 }, turnIds: ['u1'] }),
      sessionBannerOutputLineWithTurn(chain[0] as string, 'call-d2', 'u1'),
    ]);
    for (let index = 0; index < chain.length; index += 1) {
      const id = chain[index] as string;
      const next = chain[index + 1] ?? id; // 最后一层（深 8）**回指自己**
      writeInto(home, rolloutPath(id), [
        ...threadLines(nestedMetaLine(id), { totalTokenUsage: { input: 1, cached: 0, output: 1 }, turnIds: [`t-${id}`] }),
        /**
         * ⚠️ 这条横幅的 `turn_id` 必须给**这一层自己那一轮**（不是种子那个 `u1`）：真机上派发
         * 发生在派发者**当前这一轮之内**，所以两处同值；而这里每一层是**不同的线程**，
         * 复用 `u1` 会让每一条链文件多出一个 `turn_id` ⇒ 轮次从 8 变成 15（本轮实测踩到）。
         */
        sessionBannerOutputLineWithTurn(next, `call-${next}`, `t-${id}`),
      ]);
    }

    const projected = projectTranscriptDrafts({
      codexHome: home,
      mainThreadId: MAIN_THREAD_ID,
      childThreadIds: [CHILD_THREAD_ID],
      read: readTranscript,
    });
    // 分量照给：种子 2/0/3 加 7 层各 1/0/1
    expect(projected.subagentUsage).toMatchObject({ input: 9, cached: 0, output: 10 });
    expect(projected.subagentTurns).toBe(8);
    expect(projected.usage).toMatchObject({ input: 109, cached: 0, output: 20 });

    const texts = projected.drafts.map((draft) => (draft.type === 'log' ? draft.text : ''));
    // 一句「不是全量」都不该有：那个回指什么都没漏掉
    expect(texts.some((text) => text.startsWith('[WARN]') && text.includes('不是全量'))).toBe(false);
    expect(texts.some((text) => text.startsWith('[WARN]') && text.includes('上限'))).toBe(false);
  });

  /**
   * **深度帽的触发方向**（2026-10-XX Wave A 复核 Important）。上一条钉的是「不该触发时不触发」，
   * 这一条钉**该触发时确实触发**——而这条分支是 `transcript.ts` 里**唯一**能把 `truncated` 置真的
   * 地方（广度那条只管线程数）。破掉它（改 `false`、或整段删掉），**加这条之前那 88 条里没有一条会红**
   * （实测：加上这条之后全套 89 条里**恰好只有这一条**红），形状却正好翻回本仓最忌讳的那一档：
   * **拿部分和冒充总数，而且一声不响**（连 WARN 都没有）。
   *
   * 夹具：种子 c1（深 1）→ c2 → … → c8（深 8 = 上限），而 c8 的横幅点的是**盘上新线程 c9**
   * ——它**不在 `seen` 里**（不是回指）⇒ 这一条必须报告截断 ⇒ 分量整格 `null` + 轮次 `null` +
   * 点名「不是全量」的 WARN。⚠️ c9 的文件**真的落盘**（读得到）：`null` 只可能来自「被上限砍掉」，
   * 不可能来自「读不到」（两者在日志里必须分得开）。
   *
   * 顺带钉住 WARN 里那两个数**分开说**（Wave A 复核 Minor ①）：本次读到 8 个（种子 c1 + 递归发现的
   * c2…c8），其中递归额外发现 7 个（上限 32）——种子不占预算，所以「读到的个数」本来就可以大于上限，
   * 混成一个数会印出自相矛盾的句子。
   *
   * 破法（mutation）：把深度分支的 `if (childIds.some((id) => !seen.has(id))) truncated = true;`
   * 换成 `false` ⇒ 这条必红（分量变成「已读到那 8 个的和」，看起来完全正常、且没有 WARN）。
   */
  it('深度上限点到**盘上新线程** ⇒ 截断：分量整格 null、轮次 null、并点名「不是全量」', () => {
    const home = makeCodexHome({ 'sessions/keep.txt': ['x'] });
    writeInto(home, rolloutPath(MAIN_THREAD_ID), threadLines(MAIN_META, {
      totalTokenUsage: { input: 100, cached: 0, output: 10 },
      turnIds: ['t1'],
    }));
    // 链：c2…c9 **都真的落盘**；c2…c8 各自点名下一个 ⇒ c8（深 8）点名的是从未入过队的 c9
    const chain = Array.from({ length: 8 }, (_unused, index) => chainThreadId(index + 2));
    writeInto(home, rolloutPath(CHILD_THREAD_ID), [
      ...threadLines(childMetaLine(CHILD_THREAD_ID), { totalTokenUsage: { input: 2, cached: 0, output: 3 }, turnIds: ['u1'] }),
      sessionBannerOutputLineWithTurn(chain[0] as string, 'call-d2', 'u1'),
    ]);
    for (let index = 0; index < chain.length; index += 1) {
      const id = chain[index] as string;
      const next = chain[index + 1];
      writeInto(home, rolloutPath(id), [
        ...threadLines(nestedMetaLine(id), { totalTokenUsage: { input: 1, cached: 0, output: 1 }, turnIds: [`t-${id}`] }),
        // 最后一层（c9）不再点名：它只是「被 c8 点到、但没被收下」的那一个
        ...(next === undefined ? [] : [sessionBannerOutputLineWithTurn(next, `call-${next}`, `t-${id}`)]),
      ]);
    }

    const projected = projectTranscriptDrafts({
      codexHome: home,
      mainThreadId: MAIN_THREAD_ID,
      childThreadIds: [CHILD_THREAD_ID],
      read: readTranscript,
    });
    // 分量与轮次一起整格 null（不是「已读到那 8 个的部分和」），合计退回主线程口径
    expect(projected.subagentUsage).toBeNull();
    expect(projected.subagentTurns).toBeNull();
    expect(projected.usage).toMatchObject({ input: 100, cached: 0, output: 10 });

    const texts = projected.drafts.map((draft) => (draft.type === 'log' ? draft.text : ''));
    const warn = texts.find((text) => text.startsWith('[WARN]') && text.includes('不是全量'));
    expect(warn).toContain('上限');
    /**
     * **到顶的是哪一条必须说对**（Wave A 复核 Minor ① 的后半）：这条夹具到顶的是**深度**上限，
     * 而递归额外发现只有 7 个（线程数上限是 32）⇒ 早先那句「递归额外发现 7 个（**已达上限**）」
     * 配着「上限 32」是一对自相矛盾的话。现在按 `truncatedBy` 措辞。
     */
    expect(warn).toContain('到顶的是深度上限（8 层）');
    expect(warn).not.toContain('已达上限');
    // 两个数分开说：读到 8 个（种子 1 + 发现 7），其中递归额外发现 7 个
    expect(warn).toContain('本次读到 8 个线程');
    expect(warn).toContain('递归额外发现 7 个');
    // 一条「未找到」都不该有：c9 的文件在盘上，null 来自截断（两件事在日志里必须分得开）
    expect(texts.some((text) => text.startsWith('[WARN]') && text.includes('未找到'))).toBe(false);
  });

  /**
   * 这一条钉的是**派发者的界取哪一格时间戳**（判据落在 `predatesDispatcher` 的两侧）：必须取**内层**
   * `payload.timestamp`（厂商记的「会话创建时刻」），不能取**行首**的外层 `timestamp`——真机上外层比
   * 同一条记录的内层晚 **109ms**（`16:02:37.143` vs `16:02:37.034`）。夹具把这个差写进派发者那一份
   * （内层 `21:24:30.000` / 行首 `21:24:30.100`），并让**候选自己**的创建时刻**夹在两者之间**
   * （`21:24:30.050`）⇒ 取内层：`30.050 > 30.000` ⇒ 保留；取行首：`30.050 < 30.100` ⇒ 被误判成旧会话
   * 而丢掉（R7 从少计翻成更隐蔽的少计）。
   *
   * ⚠️ **2026-10-XX 起这条用例的口径变了，注释跟着改**（身份那条修复的连带影响）：候选文件里那条
   * **派发者副本**（第 2 条 `session_meta`）**不再覆盖**候选自己那一份 ⇒ 候选的时间戳恒等于
   * **它自己**的创建时刻。夹具仍照真机带上那份副本，钉的是「它被忽略」这件事（副本的内层
   * `21:24:30.000` 若还生效，下面那条断言会因为别的原因而通过 ⇒ 看不出判据取错了哪一格）。
   *
   * 破法（mutation）：把 `dispatcherCreatedAt` 换回 `transcript.timing.firstTimestamp` ⇒ 这条必红。
   */
  it('候选自己是 fork（文件里带派发者的 meta 副本）⇒ 不被时序判据误判成旧会话', () => {
    const home = makeCodexHome({
      [rolloutPath(MAIN_THREAD_ID)]: threadLines(MAIN_META, {
        totalTokenUsage: { input: 100, cached: 0, output: 10 },
        turnIds: ['t1'],
      }),
    });
    // 派发者 c1：**行首时间戳比它自己的创建时刻晚 100ms**（照真机那 109ms 写）
    const dispatcherMeta = sessionMetaLine({
      id: CHILD_THREAD_ID,
      sessionId: PARENT_THREAD_ID,
      parentThreadId: PARENT_THREAD_ID,
      threadSpawn: { parent_thread_id: PARENT_THREAD_ID, depth: 1, agent_path: null, agent_nickname: '子-c1' },
      timestamp: '2026-09-30T21:24:30.000Z',
      lineTimestamp: '2026-09-30T21:24:30.100Z',
    });
    writeInto(home, rolloutPath(CHILD_THREAD_ID), [
      ...threadLines(dispatcherMeta, {
        totalTokenUsage: { input: 10, cached: 0, output: 1 },
        turnIds: ['u1'],
      }),
      sessionBannerOutputLine(GRANDCHILD_THREAD_ID, 'call-fork'),
    ]);
    // 孙线程 g1：**它自己也是被 fork 出来的**，创建时刻夹在派发者的内层（.000）与行首（.100）之间
    writeInto(home, rolloutPath(GRANDCHILD_THREAD_ID), [
      ...threadLines(
        sessionMetaLine({
          id: GRANDCHILD_THREAD_ID,
          sessionId: GRANDCHILD_THREAD_ID,
          parentThreadId: null,
          threadSpawn: null,
          timestamp: '2026-09-30T21:24:30.050Z',
        }),
        {
          totalTokenUsage: { input: 1, cached: 0, output: 3 },
          turnIds: ['w1'],
        },
      ),
      // 第 2 条 meta = fork 时抄进来的**派发者那份副本**（真机 `01a107a7…jsonl` 第 2 行同形）
      sessionMetaLine({
        id: CHILD_THREAD_ID,
        sessionId: PARENT_THREAD_ID,
        parentThreadId: PARENT_THREAD_ID,
        threadSpawn: { parent_thread_id: PARENT_THREAD_ID, depth: 1, agent_path: null, agent_nickname: '子-c1' },
        timestamp: '2026-09-30T21:24:30.000Z',
      }),
    ]);

    const projected = projectTranscriptDrafts({
      codexHome: home,
      mainThreadId: MAIN_THREAD_ID,
      childThreadIds: [CHILD_THREAD_ID],
      read: readTranscript,
    });
    // g1 必须**在**分量里（11/0/4），且**没有**任何「跳过旧会话」的 WARN
    expect(projected.subagentUsage).toMatchObject({ input: 11, cached: 0, output: 4 });
    expect(projected.subagentTurns).toBe(2);
    expect(subagentPayloads(projected.drafts).length).toBeGreaterThanOrEqual(2);
    const texts = projected.drafts.map((draft) => (draft.type === 'log' ? draft.text : ''));
    expect(texts.some((text) => text.startsWith('[WARN]') && text.includes('resume'))).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// fork 抄进来的元信息：不再顶替身份与轮次（真机两例，2026-10-XX 修复）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 真机形状（`8e13e7a3…/77a9dcf7…/.agenthome` 的 `01a107a7…jsonl` 逐字如此）：子线程文件里
 * **两条** `session_meta` —— 第 1 行是它**自己**的（`{id: 01a107a7…, parent_thread_id: 01a107a6…,
 * forked_from_id: 01a107a6…}`），第 2 行是 **fork 时抄进来的派发者那份**（`{id: 01a107a6…}`）。
 * 同一个 fork 还把派发者那一轮的开工记录（`task_started` + `turn_context`）也带了进来。
 * 下面两条各钉一半：**身份**与**轮次**。
 */
describe('fork 抄进来的元信息不再顶替身份与轮次（2026-10-XX 修复）', () => {
  /**
   * ① **身份**：读取层原来是「后到覆盖」⇒ `sessionMeta.threadId` 变成**主线程**，
   * 于是派发面板上这个子任务的 id / 父链 / 深度 / 昵称**全显示成主线程的**。
   * 判据是**文件里就是这么写的**：第一条是这一份会话自己的记录，后一条是它派发者的副本 ⇒ 取第一条。
   *
   * 破法（mutation）：把 `readTranscript` 的 `session_meta` 分支换回无条件赋值（后到覆盖）⇒ 这条必红。
   */
  it('第 2 条 `session_meta` 是派发者副本时，身份仍是**文件自己的**那一份', () => {
    const home = makeCodexHome({ 'sessions/keep.txt': ['x'] });
    writeInto(home, rolloutPath(MAIN_THREAD_ID), threadLines(MAIN_META, {
      totalTokenUsage: { input: 100, cached: 0, output: 10 },
      turnIds: ['t1'],
    }));
    const childLines = threadLines(childMetaLine(CHILD_THREAD_ID), {
      totalTokenUsage: { input: 10, cached: 0, output: 1 },
      turnIds: ['u1'],
    });
    // 第 2 行就是那份副本（真机也是第 2 行），其余照旧
    writeInto(home, rolloutPath(CHILD_THREAD_ID), [childLines[0] as string, MAIN_META, ...childLines.slice(1)]);

    // 直读那一层：身份 = 它自己那一份
    expect(readTranscript(join(home, rolloutPath(CHILD_THREAD_ID)))?.sessionMeta?.threadId).toBe(CHILD_THREAD_ID);
    /**
     * ⚠️ 主线程那一份**不受影响**——但**这条断言在这一格是同值的**：主线程文件里只有**一条**
     * `session_meta` ⇒「第一条胜出」与「后到覆盖」结果相同（Wave A 复核 Minor ⑤ 点名了这一点）。
     * 它钉的是「没有回归」（主线程的读取一个字段都没被这次改动碰到），**不是**「判据正确」；
     * 判据本身由上面那条（第 2 条是副本）与消息层那条守卫钉。主线程**没有**派发者，也就不会有副本，
     * 所以这里无法造出更强的形状——如实说明，不假装它是第二条守卫。
     */
    expect(readTranscript(join(home, rolloutPath(MAIN_THREAD_ID)))?.sessionMeta?.threadId).toBe(MAIN_THREAD_ID);

    const projected = projectTranscriptDrafts({
      codexHome: home,
      mainThreadId: MAIN_THREAD_ID,
      childThreadIds: [CHILD_THREAD_ID],
      read: readTranscript,
    });
    // 用户看得见的那一面：子任务记录的四个身份格都是**它自己**的（不是主线程的）
    const payload = subagentPayloads(projected.drafts)[0];
    expect(payload?.subagentId).toBe(CHILD_THREAD_ID);
    expect(payload?.vendorId).toBe(CHILD_THREAD_ID);
    expect(payload?.parentThreadId).toBe(PARENT_THREAD_ID);
    expect(payload?.spawnDepth).toBe(1);
    expect(payload?.name).toBe(`子-${CHILD_THREAD_ID}`);
  });

  /**
   * ② **轮次**：那个 fork 还带进来一个**只有开工痕迹**的 `turn_id` 桶（真机：`task_started` +
   * `turn_context`，两条都落在本模块**不消费**的那一档）。照「见到 `turn_id` 就记一轮」计数，
   * 这个子线程会算 **2** 轮（真机实测），而它**真跑过的**只有 1 轮 ⇒ 整行的轮次 4 而不是 3
   * ——正好落在本设计要做成可比的那一格上。
   *
   * 判据：**桶里得有本模块消费的内容**（消息 / 推理 / 工具 / 条目 / 用量）才算一轮；只有开工痕迹的
   * 不算（见 `readTranscript` 的 `turnBuckets`）。
   *
   * 破法（mutation）：把轮次判据换回「见到 `turn_id` 就算」（`turnBuckets.set(record.turnId, true)`）
   * ⇒ 这条必红（`subagentTurns` 变 2）。
   */
  it('fork 抄进来的「空轮」不计轮次：只跑过一轮的文件数出 1 轮', () => {
    const home = makeCodexHome({ 'sessions/keep.txt': ['x'] });
    writeInto(home, rolloutPath(MAIN_THREAD_ID), threadLines(MAIN_META, {
      totalTokenUsage: { input: 100, cached: 0, output: 10 },
      turnIds: ['t1'],
    }));
    /** 派发者（主线程）那一轮的 id（真机：`01a107a6-ff6a…`）——它这一轮的开工记录被抄进了子线程文件 */
    const phantomTurnId = '01a107a6-ff6a-72c3-a604-6cdf1cc6f609';
    /** 子线程**自己**那一轮（真机：`01a107a7-25ff…`） */
    const ownTurnId = '01a107a7-25ff-7e90-b47f-0eecc174e220';
    writeInto(home, rolloutPath(CHILD_THREAD_ID), [
      childMetaLine(CHILD_THREAD_ID),
      // 幻影桶：只有开工痕迹（`task_started` + `turn_context`），与真机那两条逐字同形
      line({
        timestamp: '2026-10-04T16:02:37.143Z',
        ordinal: 1,
        type: 'event_msg',
        payload: { type: 'task_started', turn_id: phantomTurnId, root_turn_id: phantomTurnId, started_at: 1 },
      }),
      line({
        timestamp: '2026-10-04T16:02:37.150Z',
        ordinal: 2,
        type: 'turn_context',
        payload: { turn_id: phantomTurnId, root_turn_id: phantomTurnId, cwd: 'D:/work/repo' },
      }),
      // 自己那一轮：哪怕只有一条条目，也算「真的有内容」
      line({
        timestamp: '2026-10-04T16:02:40.000Z',
        ordinal: 3,
        type: 'event_msg',
        turn_id: ownTurnId,
        payload: {
          type: 'item_completed',
          thread_id: CHILD_THREAD_ID,
          turn_id: ownTurnId,
          item: { type: 'UserMessage', id: 'um-own', content: [] },
          started_at_ms: 1,
          completed_at_ms: 2,
        },
      }),
      line({
        timestamp: '2026-10-04T16:02:44.000Z',
        ordinal: 4,
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: { total_token_usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 1 } },
        },
      }),
    ]);

    // 直读那一层：轮次只留下**真跑过**的那一个
    expect(readTranscript(join(home, rolloutPath(CHILD_THREAD_ID)))?.turnIds).toEqual([ownTurnId]);

    const projected = projectTranscriptDrafts({
      codexHome: home,
      mainThreadId: MAIN_THREAD_ID,
      childThreadIds: [CHILD_THREAD_ID],
      read: readTranscript,
    });
    // 整格：分量照给，而**轮次是 1 不是 2**
    expect(projected.subagentUsage).toMatchObject({ input: 10, cached: 0, output: 1 });
    expect(projected.subagentTurns).toBe(1);
    // 运行期与终态同一份判据 ⇒ 那一格也必须一致
    expect(projectChildThreadUsage({
      codexHome: home,
      mainThreadId: MAIN_THREAD_ID,
      childThreadIds: [CHILD_THREAD_ID],
      read: readTranscript,
    }).turns).toBe(1);
  });

  /**
   * 判据的**另一面**（Wave A 复核 Minor ④）：`CONSUMED_RECORD_TYPES` 里的 `token_count` 不是摆设
   * ——一个**只有** `token_count` 的桶**算**一轮。为什么得单独钉：本文件里所有 `token_count` 夹具
   * 都**不带** `turn_id` ⇒ 把 `'token_count'` 从那个集合里删掉，**一条用例都不会红**（这条判据此前
   * 是无守卫的，而注释却拿它当例子）。夹具就是真机那一行的形状（`payload.type = 'token_count'`、
   * `payload.turn_id` 带上这一轮的 id）。
   *
   * 破法（mutation）：把 `'token_count'` 从 `CONSUMED_RECORD_TYPES` 里删掉 ⇒ 这条必红
   * （`turnIds` 变成空数组 ⇒ 「这一轮明明跑了却不计轮次」）。
   */
  it('只有 `token_count` 的桶算一轮（消费类型那一格有人守着）', () => {
    const home = makeCodexHome({ 'sessions/keep.txt': ['x'] });
    const usageOnlyTurnId = '01a107a7-25ff-7e90-b47f-0eecc174e220';
    writeInto(home, rolloutPath(CHILD_THREAD_ID), [
      childMetaLine(CHILD_THREAD_ID),
      line({
        timestamp: '2026-10-04T16:02:44.000Z',
        ordinal: 1,
        type: 'event_msg',
        turn_id: usageOnlyTurnId,
        payload: {
          type: 'token_count',
          turn_id: usageOnlyTurnId,
          info: { total_token_usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 1 } },
        },
      }),
    ]);

    const transcript = readTranscript(join(home, rolloutPath(CHILD_THREAD_ID)));
    expect(transcript?.turnIds).toEqual([usageOnlyTurnId]);
    // 走完整投影也一样：这一轮进子轮次，用量同时进分量
    const projected = projectTranscriptDrafts({
      codexHome: home,
      mainThreadId: MAIN_THREAD_ID,
      childThreadIds: [CHILD_THREAD_ID],
      read: readTranscript,
    });
    expect(projected.subagentTurns).toBe(1);
    expect(projected.subagentUsage).toMatchObject({ input: 10, cached: 0, output: 1 });
  });

  /**
   * **身份修复在消息层的两个连带格**（Wave A 复核 Minor ⑤）：这两个格子都由
   * `transcript.sessionMeta` 推出，而它此前会被 fork 抄进来的副本顶替——
   *   · `childRecord` 的 `name` 取 `sessionMeta.threadSpawn.agentNickname`：副本（主线程那份）的
   *     `thread_spawn` 是 `null` ⇒ 名称**整个丢掉**（`null`）；
   *   · `nestedParentOf` 取 `sessionMeta.parentThreadId`：副本那一格是**派发者的**父链，于是**嵌套的**
   *     fork 子线程会被当成**顶层**（`parentSubagentId` 记 `null`）⇒ 界面上挂到主会话节点、而不是
   *     它真正的子任务节点，面包屑少一段（`message.ts` 那两处的注释里有真机表现）。
   * 两个都在**正确的方向**上，这条守卫把「改动半径」显式钉住（而不是让它隐式留在别处）。
   *
   * 破法（mutation）：把 `readTranscript` 的 `session_meta` 换回无条件赋值（后到覆盖）⇒ 这条必红。
   */
  it('fork 子线程在消息层的两个连带格：名称取自己的昵称、嵌套父链取自己真正的父', () => {
    const home = makeCodexHome({ 'sessions/keep.txt': ['x'] });
    writeInto(home, rolloutPath(MAIN_THREAD_ID), MAIN_MESSAGE_LINES);
    /** c1 自己那一份 meta：父是**主线程** ⇒ 顶层（`parentSubagentId` 记 `null`，契约 §2.6） */
    const ownChildMeta = sessionMetaLine({
      id: CHILD_THREAD_ID,
      sessionId: MAIN_THREAD_ID,
      parentThreadId: MAIN_THREAD_ID,
      threadSpawn: { parent_thread_id: MAIN_THREAD_ID, depth: 1, agent_path: null, agent_nickname: '子-c1' },
    });
    const childLines = threadLines(ownChildMeta, {
      totalTokenUsage: { input: 10, cached: 0, output: 1 },
      turnIds: ['u1'],
    });
    // c1 的文件：自己那份 + fork 抄进来的**主线程**副本（第 2 行，与真机同序）
    writeInto(home, rolloutPath(CHILD_THREAD_ID), [childLines[0] as string, MAIN_META, ...childLines.slice(1)]);
    /**
     * g1 自己那一份 meta：父是 **c1**（一条子线程）⇒ **嵌套**，`parentSubagentId` 该交出 c1 的 id。
     * 它自己也是 fork（副本是 c1 那份，父 = 主线程）⇒ 旧判据下它会被当成**顶层**（`null`）。
     */
    const ownNestedMeta = sessionMetaLine({
      id: GRANDCHILD_THREAD_ID,
      sessionId: CHILD_THREAD_ID,
      parentThreadId: CHILD_THREAD_ID,
      threadSpawn: { parent_thread_id: CHILD_THREAD_ID, depth: 2, agent_path: null, agent_nickname: '子-g1' },
    });
    const nestedLines = threadLines(ownNestedMeta, {
      totalTokenUsage: { input: 1, cached: 0, output: 1 },
      turnIds: ['w1'],
    });
    writeInto(home, rolloutPath(GRANDCHILD_THREAD_ID), [
      nestedLines[0] as string,
      ownChildMeta, // fork 抄进来的**派发者（c1）**那一份
      ...nestedLines.slice(1),
    ]);

    const projected = projectCodexMessages({
      codexHome: home,
      mainThreadId: MAIN_THREAD_ID,
      childThreadIds: [CHILD_THREAD_ID, GRANDCHILD_THREAD_ID],
    });
    expect(projected.subagents).toHaveLength(2);
    // 修好之前：两格的 `name` 都是副本的 `thread_spawn`（null ⇒ 名称整个丢掉），父链都被当成顶层
    expect(projected.subagents[0]).toMatchObject({
      subagentId: CHILD_THREAD_ID,
      name: '子-c1',
      parentSubagentId: null,
    });
    expect(projected.subagents[1]).toMatchObject({
      subagentId: GRANDCHILD_THREAD_ID,
      name: '子-g1',
      parentSubagentId: CHILD_THREAD_ID,
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// index 层的接线（用注入的读取器，不碰盘）
// ─────────────────────────────────────────────────────────────────────────────

describe('codex 适配器接线：会话文件的读取时机与计量合并', () => {
  /**
   * **运行期就要交内容**（2026-10-03 修正，用户口径「Codex 执行日志看不到内容」）。
   *
   * 这一家是**唯一**内容只走会话文件的适配器：事件流那条通道缺工具真名、结构化入参与
   * `call_id` 配对键，故消息一个都不从它出。原来只在 `finalize` 里读盘 ⇒ 一整段运行里
   * 抽屉一个字都没有（真机 2–10 分钟），失败或被终止时更是一条都拿不到。
   * 而 `rollout-*.jsonl` 是 CLI **边跑边追加**的：随时都读得到已经发生的部分。
   *
   * 判据选「**会话文件已经写完、而流还没跑完**的时刻就已经收到消息」——这一条在
   * 「只在收尾读」的实现下必红：那一刻 `finalize` 还没被调用。
   */
  it('流还没跑完就先交出内容：会话文件已落盘的条目在运行期就进 `onMessage`', async () => {
    const messages: AgentMessage[] = [];
    const recorder = createRecorder();
    /**
     * 事件流：交出 `thread.started` 之后**挂住**（模拟一段长运行）。
     * `hang: true` 是这一格的要点——不然事件流会立刻跑完，那就变成「收尾读盘」那条既有路径了，
     * 而本用例要验的是**在流还开着的时候**内容就已经交出来。
     */
    setAgentRuntimeForTesting({
      sdkModule: {
        [CODEX_PACKAGE_NAME]: createFakeCodexSdk({
          recorder,
          hang: true,
          events: [
            { type: 'thread.started', thread_id: MAIN_THREAD_ID },
            { type: 'item.completed', item: { id: 'i-1', type: 'agent_message', text: '正在处理' } },
          ],
        }),
      },
    });
    // 真 `CODEX_HOME`：会话文件按真名落盘，读取走生产路径（找文件那一步也覆盖）。
    // ⚠️ 用 `MAIN_MESSAGE_LINES`（`item_completed` 那套）而不是 `MAIN_TRANSCRIPT_LINES`：
    // 后者是**读取面**的夹具（`response_item` 行），它本来就产不出消息。
    //
    // ⚠️ **末尾再接一条答复条目**（2026-10-05 口径变更）：新口径下同一轮里的条目共用一个**载体**
    // （合并键 = `subagentId|roundTrip|role|parentCallId`），而运行期那层「只交变化」的节流
    // （`index.ts` 的 `changedMessages`）按**草稿**判「块数没变 ⇒ 至多每 3 秒交一次」——于是同一轮里
    // 后到的草稿在**只读一次盘**的这一刻会被节流掉（本用例的流是挂住的，全程只读一次）。接一条
    // **开了新一轮**的答复之后，它自成新载体 ⇒ 这一读就带得出正文（本用例要钉的正是「运行期就交付」）。
    // 该节流与轮次的交互已登记为 Task 5 报告的顾虑（生产上每 500 ms 有一次读盘，滞后上界约 3 秒）。
    const home = makeCodexHome({ 'sessions/keep.txt': ['x'] });
    writeInto(home, rolloutPath(MAIN_THREAD_ID), [
      ...MAIN_MESSAGE_LINES,
      itemCompletedLine({ type: 'AgentMessage', id: 'msg-2', content: [{ type: 'Text', text: '再做一步' }] }),
    ]);
    const controller = new AbortController();

    const running = codexProvider.run(
      createRunInput({
        configHome: home,
        signal: controller.signal,
        onEvent: collectEvents([]),
        onMessage: (message) => messages.push(message),
      }),
    );
    /**
     * 给它一点真实时间把事件流消费掉。**不用假定时器**：这一格要验的正是「在读盘这件事上
     * 有没有真的发生」，而节流闸门是按真实钟走的（`CONTENT_READ_MIN_INTERVAL_MS`）。
     */
    await new Promise((resolve) => {
      setTimeout(resolve, 800);
    });

    expect(messages.length, '流还在跑时一条消息都没交出来（运行期抽屉必然为空）').toBeGreaterThan(0);
    expect(messages.some((message) => message.blocks.some((block) => block.type === 'text'))).toBe(true);

    // 收尾：让这一次运行结束（不留下挂着的 promise）
    controller.abort();
    await running;
  });

  it('流跑完之后才读会话文件：thinking / transcript / subagent 都在 usage 之后（真文件，整条链都走）', async () => {
    const events: AgentEvent[] = [];
    const recorder = createRecorder();
    setAgentRuntimeForTesting({
      sdkModule: {
        [CODEX_PACKAGE_NAME]: createFakeCodexSdk({
          recorder,
          events: [
            { type: 'thread.started', thread_id: MAIN_THREAD_ID },
            { type: 'collab_tool_call', receiver_thread_ids: [CHILD_THREAD_ID] },
            { type: 'item.completed', item: { id: 'msg-1', type: 'agent_message', text: '做完了' } },
            { type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 2 } },
          ],
        }),
      },
    });

    // 真 `CODEX_HOME`：会话文件按真名落盘 ⇒ 读取走的是生产路径（找文件那一步也覆盖了）
    const home = makeRealCodexHome();
    const result = await codexProvider.run(
      createRunInput({ configHome: home, onEvent: collectEvents(events) }),
    );
    expect(result.ok).toBe(true);

    const kinds = events.map((event) => kindOf(event)).filter((kind): kind is string => kind !== null);
    expect(kinds).toContain('thinking');
    expect(kinds).toContain('transcript');
    expect(kinds).toContain('subagent');
    // 子线程的信息来自**它自己那份**会话文件（父链 / 深度 / 昵称都在里面）
    const subagent = events
      .filter((event) => kindOf(event) === 'subagent')
      .map((event) => (event.type === 'log' ? (JSON.parse(event.text) as Record<string, unknown>) : {}));
    expect(subagent[0]?.parentThreadId).toBe(PARENT_THREAD_ID);
    expect(subagent[0]?.functionCalls).toEqual([{ name: 'spawn_agent', arguments: '{"task":"x"}' }]);

    // 会话文件的计量比事件流给的**更新** ⇒ 多一条 usage 事件（`turns` 沿用事件流的同一口径 1）。
    // 两处都按同一套归一化：事件流那条 `input = 1 − 0`、文件那条 `input = 1000 − 900 = 100`。
    const usageTokens = events
      .filter((event) => event.type === 'usage')
      .map((event) => (event.type === 'usage' ? event.tokens : null));
    expect(usageTokens).toContainEqual({ input: 1, cached: 0, output: 2, reasoningOutput: null, total: null });
    expect(usageTokens).toContainEqual({ input: 100, cached: 900, output: 50, reasoningOutput: 30, total: 1050 });
    expect(usageTokens.at(-1)).toEqual({ input: 100, cached: 900, output: 50, reasoningOutput: 30, total: 1050 });
    const lastUsage = events.filter((event) => event.type === 'usage').at(-1);
    expect(lastUsage?.type === 'usage' ? lastUsage.turns : null).toBe(1);
    /**
     * **时长只可能出现在这一条（会话文件那条）上**（2026-10-XX）：codex 的事件流一个时间字段都没有
     * ⇒ 前面那些 `usage` 事件的 `timing` 是 `null`，而文件那条带着 `source: 'events'` 的跨度。
     * 断言的数值就是夹具首末两行的时间戳之差（21:24:34.570 → 21:24:45.000 = 10430 ms）。
     */
    expect(lastUsage?.type === 'usage' ? lastUsage.timing : undefined).toEqual({
      totalMs: 10_430,
      apiMs: null,
      ttftMs: null,
      source: 'events',
    });
    const earlierUsages = events.filter((event) => event.type === 'usage').slice(0, -1);
    for (const event of earlierUsages) {
      expect(event.type === 'usage' ? event.timing : 'nope').toBeNull();
    }
    // 会话文件的内容**排在**事件流之后：它是跑完之后才读到的，顺序上不能撒谎
    expect(events.findIndex((event) => kindOf(event) === 'thinking')).toBeGreaterThan(
      events.findIndex((event) => event.type === 'usage'),
    );
  });

  /**
   * 截断之后**这一行上摆着的那三个数是自洽的**（2026-10-XX 复核 C）：分量整格 `null`，而
   * `tokens` / 缓存命中 / `turns` **一起**退回主线程口径（`index.ts` 的 `finalize` 那两处回落，
   * 刻意保留：与 `tokens` 在分量读不出来时的回落同一条口径）。这条守卫把那个**成对**关系钉住——
   * 只钉分量 `null` 的话，将来有人把 `turns` 改成「拿已发现那些的和」，界面就会出现
   * 「主线程口径的 tok + 含了一部分子线程的轮次」，而两边都各有一个 WARN 说「不是全量」。
   * 顺带钉住那条 WARN 说的是**整行三格**（复核 C 的另一半：WARN 不能只提分量那一格）。
   *
   * 夹具与「横幅数超广度上限」那条同形（35 个只写在子线程文件里的孙线程 ⇒ 必定截断），
   * 但走的是**整条 provider 链路**：这里要看的正是 `finalize` 交付的那个 `usage` 事件。
   *
   * 破法（mutation）：把 `finalize` 的 `turns` 改成 `lastTurns + (projected.subagentUsage === null ? 0 : …)`
   * 之类「截断也加点东西」的写法 ⇒ 这条的 `turns` 断言必红。
   */
  it('截断那一档：分量 null 时 tokens 与 turns 一起退回主线程口径（两个数成对，不是各退各的）', async () => {
    const events: AgentEvent[] = [];
    const recorder = createRecorder();
    const home = makeCodexHome({ 'sessions/keep.txt': ['x'] });
    // 主线程文件里的累计（归一后 100/900/50）+ 1 个轮次标识
    writeInto(home, rolloutPath(MAIN_THREAD_ID), threadLines(MAIN_META, {
      totalTokenUsage: { input: 100, cached: 900, output: 50 },
      turnIds: ['t1'],
    }));
    // 子线程文件里写了 35 条横幅（> 广度上限 32）⇒ 递归必定在上限处被砍断
    const grandchildIds = Array.from(
      { length: MAX_DISCOVERED_CHILD_THREADS + 3 },
      (_unused, index) => `01a0f434-dddd-7161-afca-00000000${String(index).padStart(4, '0')}`,
    );
    writeInto(home, rolloutPath(CHILD_THREAD_ID), [
      ...threadLines(childMetaLine(CHILD_THREAD_ID), {
        totalTokenUsage: { input: 7, cached: 0, output: 700 },
        turnIds: ['u1'],
      }),
      ...grandchildIds.map((id) => sessionBannerOutputLine(id, `call-${id}`)),
    ]);
    for (const id of grandchildIds) {
      writeInto(home, rolloutPath(id), threadLines(nestedMetaLine(id), {
        totalTokenUsage: { input: 1, cached: 0, output: 200 },
        turnIds: ['w1'],
      }));
    }
    setAgentRuntimeForTesting({
      sdkModule: {
        [CODEX_PACKAGE_NAME]: createFakeCodexSdk({
          recorder,
          events: [
            { type: 'thread.started', thread_id: MAIN_THREAD_ID },
            { type: 'collab_tool_call', receiver_thread_ids: [CHILD_THREAD_ID] },
            // 主线程的轮次（1）：`finalTurns` 就建在它上面。
            // 2026-10-05 口径变更：轮次只数**答复条目** ⇒ 这里原来是一条 `reasoning`（新口径下它不推高
            // 轮次，`lastTurns` 会是 `null`、收尾那一条 usage 事件根本不会发 ⇒ 本用例的断言全落空）。
            { type: 'item.completed', item: { id: 'msg-1', type: 'agent_message', text: '在想' } },
            { type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 900, output_tokens: 50 } },
          ],
        }),
      },
    });

    await codexProvider.run(createRunInput({ configHome: home, onEvent: collectEvents(events) }));

    const lastUsage = events.filter((event) => event.type === 'usage').at(-1);
    // 分量：整格 null（`subagentTokens` 的「明确没采到」那一档）
    expect(lastUsage?.type === 'usage' ? lastUsage.subagentTokens : 'not-usage').toBeNull();
    // 合计：主线程口径（100/900/50）——**不是**「主 + 已发现那些」的部分和
    expect(lastUsage?.type === 'usage' ? lastUsage.tokens : null).toEqual({
      input: 100,
      cached: 900,
      output: 50,
      reasoningOutput: null,
      total: null,
    });
    /**
     * 轮次：主线程口径 1（**不是** 1 + 已发现的那些子线程轮次）。这一格与上面那两格必须**同时**
     * 退回：只退一半就等于界面拿两个不同口径的数拼出一个不存在的主会话。
     */
    expect(lastUsage?.type === 'usage' ? lastUsage.turns : null).toBe(1);
    // 轮次那一格的分量同样整格 null（截断 ⇒ 不拿部分和冒充，与 `subagentTokens` 同一档）
    expect(lastUsage?.type === 'usage' ? lastUsage.subagentTurns : 'not-usage').toBeNull();

    // WARN 必须说清「这一行的三格都不含未读到的子线程」，不能只说分量那一格
    const warns = events
      .filter((event) => event.type === 'log')
      .map((event) => (event.type === 'log' ? event.text : ''))
      .filter((text) => text.startsWith('[WARN]') && text.includes('上限'));
    expect(warns).toHaveLength(1);
    const warn = warns[0] as string;
    expect(warn).toContain('tok');
    expect(warn).toContain('缓存');
    expect(warn).toContain('轮次');
  });

  it('会话文件的计量不比事件流更新时**不补** usage 事件（同一笔账不重复发）', async () => {
    const events: AgentEvent[] = [];
    const recorder = createRecorder();
    setAgentRuntimeForTesting({
      sdkModule: {
        [CODEX_PACKAGE_NAME]: createFakeCodexSdk({
          recorder,
          events: [
            { type: 'thread.started', thread_id: MAIN_THREAD_ID },
            { type: 'item.completed', item: { id: 'msg-1', type: 'agent_message', text: '做完了' } },
            // **不带 usage** 的 turn.completed：事件流这条通路交不出计量（tokens 保持 null），
            // 于是「该不该由会话文件补一条」由文件的数决定，与「同一条账重复发」区分得清清楚楚
            { type: 'turn.completed' },
          ],
        }),
      },
    });
    // 真文件里的累计归一后是 {100, 900, 50, +reasoning 30 / total 1050}，
    // 事件流一次都没交过计量（null）⇒ 补一条
    const home = makeRealCodexHome();
    await codexProvider.run(createRunInput({ configHome: home, onEvent: collectEvents(events) }));
    const usageTokens = events
      .filter((event) => event.type === 'usage')
      .map((event) => (event.type === 'usage' ? event.tokens : null));
    expect(usageTokens).toEqual([
      null,
      { input: 100, cached: 900, output: 50, reasoningOutput: 30, total: 1050 },
    ]);
    // 但推理正文照样补进去了（计量与正文是两条独立的通路）
    expect(events.map((event) => kindOf(event))).toContain('thinking');
  });

  it('事件流已经给出**同一笔**计量时不再补（避免把同一个数发两遍）', async () => {
    const events: AgentEvent[] = [];
    const recorder = createRecorder();
    setAgentRuntimeForTesting({
      sdkModule: {
        [CODEX_PACKAGE_NAME]: createFakeCodexSdk({
          recorder,
          events: [
            { type: 'thread.started', thread_id: MAIN_THREAD_ID },
            { type: 'item.completed', item: { id: 'msg-1', type: 'agent_message', text: '做完了' } },
            // 事件流与文件里的累计**归一后逐字段相同** ⇒ `isStrictlyNewer` 为假，收尾不再补一条
            { type: 'turn.completed', usage: { input_tokens: 1000, cached_input_tokens: 900, output_tokens: 50 } },
          ],
        }),
      },
    });
    const home = makeRealCodexHome();
    await codexProvider.run(createRunInput({ configHome: home, onEvent: collectEvents(events) }));
    const usages = events.filter((event) => event.type === 'usage');
    const usageTokens = usages.map((event) => (event.type === 'usage' ? event.tokens : null));
    /**
     * 三条事件，逐条各有理由：
     *   · 第 1 条 `null`：`agent_message` 条目把轮次推到 1，此刻还没有计量（**轮次的发射门槛**）；
     *   · 第 2 条：事件流那条 `turn.completed`（归一后 `1000 − 900 = 100`）；
     *   · 第 3 条：**会话文件**那条。它与第 2 条的三个必填格**逐字段相同**（100 / 900 / 50），
     *     但 `reasoningOutput` / `total` 是从「没有」变成「有」（30 / 1050）⇒ `auxiliaryGrew` 为真
     *     ⇒ 仍然发一条：这两格**只有会话文件里有**，不发就等于整条通路白读。
     * 「同一个数发两遍」这件事仍然守着：三格相同的那一份**恰好出现两次**（一次来自事件流、
     * 一次来自文件，后者多带两格），**没有第四条**（收尾不会把同一份再发一遍）。
     */
    expect(usageTokens).toEqual([
      null,
      { input: 100, cached: 900, output: 50, reasoningOutput: null, total: null },
      { input: 100, cached: 900, output: 50, reasoningOutput: 30, total: 1050 },
    ]);
    /**
     * 时长只出现在**最后那一条**上：codex 的事件流一个时间字段都没有 ⇒ 事件流那条 `timing` 是
     * `null`，而会话文件首末两点算出来的跨度（21:24:34.570 → 21:24:45.000 = 10430 ms）落在文件那条。
     */
    expect(usages[1]?.type === 'usage' ? usages[1].timing : 'not-usage').toBeNull();
    expect(usages[2]?.type === 'usage' ? usages[2].timing : 'not-usage').toEqual({
      totalMs: 10_430,
      apiMs: null,
      ttftMs: null,
      source: 'events',
    });
    expect(events.map((event) => kindOf(event))).toContain('thinking');
    const listed = events
      .filter((event) => kindOf(event) === 'transcript')
      .map((event) => (event.type === 'log' ? (JSON.parse(event.text) as Record<string, unknown>) : {}));
    expect(listed[0]?.lastTimestamp).toBe('2026-09-30T21:24:45.000Z');
  });

  it('读取器抛错不改本次运行的结论（收尾是补充信息，不是运行的一部分）', async () => {
    const events: AgentEvent[] = [];
    const recorder = createRecorder();
    setAgentRuntimeForTesting({
      sdkModule: {
        [CODEX_PACKAGE_NAME]: createFakeCodexSdk({
          recorder,
          events: [
            { type: 'thread.started', thread_id: MAIN_THREAD_ID },
            { type: 'item.completed', item: { id: 'msg-1', type: 'agent_message', text: '做完了' } },
            { type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 2 } },
          ],
        }),
      },
    });
    // 这一格**必须**注入：要测的是「读取这一步抛错」时骨架的处置，真文件读不出异常。
    // 注意 `configHome` 用**空**的临时目录（不是 `makeRealCodexHome()`）：后者会让
    // `findTranscript` 正常找到文件，于是根本走不到会抛的那一步（注入的读取器就不生效了）。
    const home = makeCodexHome({ 'sessions/keep.txt': ['x'] });
    const original = codexProvider.transcriptReader;
    codexProvider.transcriptReader = throwingReader('读盘炸了');
    try {
      const result = await codexProvider.run(createRunInput({ configHome: home, onEvent: collectEvents(events) }));
      expect(result).toMatchObject({ ok: true, exitReason: 'completed' });
      // 收尾那一步抛错 ⇒ 运行结论不变，而计量仍是事件流那条（归一后 `1 − 0 = 1`）
      expect(result.tokens).toEqual({ input: 1, cached: 0, output: 2, reasoningOutput: null, total: null });
    } finally {
      codexProvider.transcriptReader = original;
    }
    // 读取在 `dispose`（删临时目录）**之前**跑过：在途 turn 已经终结
    expect(recorder.order).toContain('turn-end');
  });

  /**
   * **失败 / 被终止的运行照样读会话文件**（2026-10-03 修正的口径）。
   *
   * 为什么这条必须钉住：codex 的消息**只**从收尾这条通道出，而它读的
   * `sessions/rollout-*.jsonl` 是 CLI **边跑边追加**的——跑挂了的会话文件里同样有内容
   * （真机实测：一条被中断的 codex 行留下 688 KB 会话文件，推理、正文、工具调用俱全）。
   * 原来只在「跑完且没失败」时收尾，代价是**失败的那一行抽屉里永远空着**，
   * 而那正是排障时最需要看的一行。
   *
   * 反向的一半同样重要：收尾**不改结论**（失败仍是失败），也**不编造**（读不到就一条都不产出）。
   */
  it('失败 / 被终止的运行**照样**读会话文件：内容补上，但结论与归因一个字都不变', async () => {
    const events: AgentEvent[] = [];
    const messages: AgentMessage[] = [];
    const recorder = createRecorder();
    setAgentRuntimeForTesting({
      sdkModule: {
        [CODEX_PACKAGE_NAME]: createFakeCodexSdk({
          recorder,
          events: [
            { type: 'thread.started', thread_id: MAIN_THREAD_ID },
            { type: 'turn.failed', error: { message: 'HTTP 401 unauthorized' } },
          ],
        }),
      },
    });
    /**
     * 这一格**必须真读盘**：要验的是「失败路径会不会走到读会话文件那一步」，
     * 而 `findTranscript` 是这条链的第一步（注入读取器会把「找文件」一起跳过）。
     * 用 `MAIN_MESSAGE_LINES`（`item_completed` 那套夹具）而不是 `MAIN_TRANSCRIPT_LINES`：
     * 后者是**读取面**的夹具（`response_item` 行），它本来就产不出消息
     * ——拿它当判据会把「读取面夹具不产消息」误判成「失败路径没读文件」。
     */
    const home = makeCodexHome({ 'sessions/keep.txt': ['x'] });
    writeInto(home, rolloutPath(MAIN_THREAD_ID), MAIN_MESSAGE_LINES);
    const original = codexProvider.transcriptReader;
    const read = vi.fn(original.read);
    codexProvider.transcriptReader = { read };
    let result: Awaited<ReturnType<typeof codexProvider.run>>;
    try {
      result = await codexProvider.run(
        createRunInput({ configHome: home, onEvent: collectEvents(events), onMessage: (message) => messages.push(message) }),
      );
    } finally {
      codexProvider.transcriptReader = original;
    }

    // ① 结论不变：仍然是一次失败，归因仍是那条 401（`AUTH_FAILED`，不在收尾这一步被改写）
    expect(result).toMatchObject({ ok: false, exitReason: 'error' });
    expect(result.error?.code).toBe('AUTH_FAILED');
    // ② 收尾这一步真的去读盘了（失败路径不读会话文件时，这一条会红）
    expect(read, '失败路径没有读会话文件').toHaveBeenCalled();
    // ③ 内容补上了：会话文件里的消息真的交了出来
    expect(messages.length, '读了文件却没交出消息').toBeGreaterThan(0);
    expect(messages.some((message) => message.blocks.some((block) => block.type === 'text'))).toBe(true);
    // ④ 收尾读盘发生在 `dispose`（删临时目录）**之前**——否则真机上永远读不到文件
    expect(recorder.order).toContain('turn-end');
  });
});

describe('会话文件 → 消息与子任务行（spec v3 §2 / §4.2）', () => {
  /**
   * 把主线程与子线程两份会话文件投影成消息。
   * 产物经**合并器**走一遍（与生产路径同一条：`finalize` 的草稿由骨架的合并器发射），
   * 于是断言看到的是消费方真正拿到的 `AgentMessage`（而不是中间的块草稿）。
   */
  function projectMain(childIds: readonly string[] = []): { messages: AgentMessage[]; subagents: SubagentRecord[] } {
    const home = makeCodexHome({ 'sessions/keep.txt': ['x'] });
    writeInto(home, rolloutPath(MAIN_THREAD_ID), MAIN_MESSAGE_LINES);
    if (childIds.length > 0) writeInto(home, rolloutPath(CHILD_THREAD_ID), CHILD_MESSAGE_LINES);
    const projected = projectCodexMessages({ codexHome: home, mainThreadId: MAIN_THREAD_ID, childThreadIds: childIds });
    const assembler = createMessageAssembler({ runId: 'run-codex' });
    const messages: AgentMessage[] = [];
    for (const draft of projected.messages) assembler.ingest(draft, (message) => messages.push(message));
    return { messages, subagents: projected.subagents };
  }

  /**
   * **子线程的轨迹也要出消息**（2026-10-03 用户口径：「codex 子任务里面没有日志」）。
   *
   * 缺陷形状：`projectCodexMessages` 只给子线程建了一条**子任务行**，它自己那几十个条目
   * （真机：47 个，`AgentMessage` / `Reasoning` / `CommandExecution` 俱全）**一条消息都没产出**
   * ⇒ 界面上点进子任务就是空的，而它的会话文件就在盘上。v3 §4.2 步骤 5 写的是「读出子智能体的
   * **完整轨迹**」，这一格原来是漏实现的。
   */
  it('子线程的轨迹照常出消息，且**归属到那条子任务**（`subagentId` = 子线程 id）', () => {
    const { messages } = projectMain([CHILD_THREAD_ID]);
    const childMessages = messages.filter((message) => message.subagentId === CHILD_THREAD_ID);

    expect(childMessages.length, '子线程一条消息都没产出（点进子任务会是空的）').toBeGreaterThan(0);
    // 载体隔离：子线程的消息**不会**混进主会话（合并键以 `subagentId` 打头）
    for (const message of childMessages) expect(message.mergeKey.startsWith(`${CHILD_THREAD_ID}|`)).toBe(true);
    // 轨迹里有内容，不只是空壳
    expect(childMessages.some((message) => message.blocks.some((block) => block.type === 'text'))).toBe(true);
    expect(messages.filter((message) => message.subagentId === null).length).toBeGreaterThan(0);
  });

  /** 嵌套形态：这条子线程的 `parent_thread_id` **不是**主线程 id ⇒ 父链照抄（顶层形态见下一条用例） */
  it('子任务行：身份是子线程 id、父链取 `parent_thread_id`、名称取 `agent_nickname`、用量按 `total_token_usage` 归一', () => {
    const { subagents } = projectMain([CHILD_THREAD_ID]);
    expect(subagents).toHaveLength(1);
    expect(subagents[0]).toMatchObject({
      subagentId: CHILD_THREAD_ID,
      name: '工作区检查',
      // 派发方式只在父消息的 `collab_tool_call` 里 ⇒ 这一格给不出来就是 null（不编）
      kind: null,
      source: 'session-file',
      parentSubagentId: PARENT_THREAD_ID,
      // 子会话里有 `AgentMessage` ⇒ 它确实产出了答复（这一家没有原生状态字段，只能靠这条证据推）
      status: 'completed',
      statusMissing: null,
      outcome: 'CHILD-TOOL-RAN',
    });
    // 用量：`input` 必须减掉 cached（与主线程同一口径）
    expect(subagents[0]?.usage).toMatchObject({ input: 100, cached: 900, output: 50, reasoningOutput: 30, total: 1050 });
  });

  /**
   * **顶层子线程的父链必须记 `null`**（契约 §2.6：`parentSubagentId` 是「嵌套父链；顶层子任务为 `null`」）。
   *
   * 真机形状（2026-10-03 那次 codex 运行，主线程用 `spawn_agent` 派出的审查子线程）：
   * 子线程的 `session_meta.parent_thread_id` **就是主线程 id**（派发它的正是主线程），
   * 而 `thread_spawn.depth` 是 `1`。照抄这一个字段会让消费方把顶层子任务挂到一个
   * **不存在的节点**上——界面按 `parentSubagentId === null ? 'main' : 'subagent:' + parentSubagentId`
   * 建树，而主会话那一节的 id 是 `main`，于是 `subagent:<主线程 id>` 谁都不是。
   * 真机表现：进子任务后面包屑只剩一个节点名，**没有「主会话」那一段**，回不去。
   */
  it('顶层子线程（`parent_thread_id` 就是主线程 id）：父链记 `null`，不是主线程 id', () => {
    const home = makeCodexHome({ 'sessions/keep.txt': ['x'] });
    writeInto(home, rolloutPath(MAIN_THREAD_ID), MAIN_MESSAGE_LINES);
    writeInto(home, rolloutPath(CHILD_THREAD_ID), [
      // 真机：子线程那份的 `session_id` 等于**父**（这里是主）线程 id，`parent_thread_id` 同值
      sessionMetaLine({
        id: CHILD_THREAD_ID,
        sessionId: MAIN_THREAD_ID,
        parentThreadId: MAIN_THREAD_ID,
        threadSpawn: { parent_thread_id: MAIN_THREAD_ID, depth: 1, agent_path: null, agent_nickname: 'Kierkegaard' },
      }),
      itemCompletedLine({ type: 'AgentMessage', id: 'child-msg', content: [{ type: 'Text', text: 'PASS' }] }),
    ]);
    const projected = projectCodexMessages({ codexHome: home, mainThreadId: MAIN_THREAD_ID, childThreadIds: [CHILD_THREAD_ID] });

    expect(projected.subagents).toHaveLength(1);
    expect(projected.subagents[0]).toMatchObject({
      subagentId: CHILD_THREAD_ID,
      name: 'Kierkegaard',
      status: 'completed',
      parentSubagentId: null,
    });
  });

  it('子会话里没有答复时：终态记 `unknown` + `statusMissing`（不猜），`outcome` 保持 null', () => {
    const home = makeCodexHome({ 'sessions/keep.txt': ['x'] });
    writeInto(home, rolloutPath(MAIN_THREAD_ID), MAIN_MESSAGE_LINES);
    // 只留 `session_meta`：这个子线程还什么都没产出
    writeInto(home, rolloutPath(CHILD_THREAD_ID), [CHILD_META]);
    const projected = projectCodexMessages({ codexHome: home, mainThreadId: MAIN_THREAD_ID, childThreadIds: [CHILD_THREAD_ID] });
    expect(projected.subagents[0]).toMatchObject({
      status: 'unknown',
      statusMissing: 'unverified',
      outcome: null,
      usage: null,
    });
  });

  it('一条条目一次投递：推理 / 工具调用 / 工具结果 / 答复各就其位（同载体的块累积成一条）', () => {
    const { messages } = projectMain();
    /**
     * 预期形状。**合并器每条投递都产出一条消息**（内容是该合并键到目前为止的完整块列表），
     * 所以这里的条数 = **投递数**，不是「最终有几条逻辑消息」：
     *   · `UserMessage` **不产出消息**（那是喂进去的输入）；
     *   · `Reasoning`、`CommandExecution` 的**调用**与 `AgentMessage` 落在**同一个载体**（同一次模型往返、
     *     都是主线程的 `assistant` 面）⇒ 第二、三、四条投递逐次累积「思考 → 思考 + 工具调用 →
     *     思考 + 工具调用 + 正文」，与另两家同形（dsh 的推理与 `tool/call` 也落在同一条 `assistant/message` 上）；
     *     **2026-10-05 口径变更**：轮次只数答复条目 ⇒ 这三条同属第 **1** 轮（旧口径下答复把轮次推到 2、
     *     自成一条新消息），所以「答复开新载体」这条旧预期不再成立；
     *   · `CommandExecution` 的**结果**在 `tool` 载体的另一条消息里，靠 `callId` 与调用配对；
     *   · 块序号在**那条线程**上顺序分配（不随载体重置）⇒ 同一载体里「思考 / 工具调用 / 正文」各占一号、
     *     不会互相覆盖（旧口径下它们分属两个载体，各从 0 起算）。
     */
    expect(messages).toHaveLength(4);
    expect(messages[0]).toMatchObject({
      role: 'assistant',
      roundTrip: 1,
      source: 'session-file',
      blocks: [{ type: 'thinking', text: '先跑构建。', textKind: 'full', signature: null }],
    });
    expect(messages[1]).toMatchObject({
      role: 'assistant',
      roundTrip: 1,
      blocks: [
        { type: 'thinking', text: '先跑构建。', textKind: 'full', signature: null },
        { type: 'tool-call', callId: 'call-1', family: 'run-shell', name: 'exec_command', input: { cmd: 'npm run build' } },
      ],
    });
    expect(messages[2]).toMatchObject({
      role: 'tool',
      roundTrip: 1,
      blocks: [
        {
          type: 'tool-result',
          callId: 'call-1',
          structured: { exitCode: 1 },
          isError: true,
          text: 'error TS2304',
          // 本家不给截断标记 ⇒ `unknown`（「输出可能不完整」），**不是**「确认完整」
          truncation: { kind: 'unknown' },
        },
      ],
    });
    expect(messages[3]).toMatchObject({
      role: 'assistant',
      // 2026-10-05 口径变更：答复条目与它同一次往返的推理 / 工具调用同号（旧口径是 2 ⇒ 新载体、新消息）
      roundTrip: 1,
      vendorId: 'msg-1',
      blocks: [
        { type: 'thinking', text: '先跑构建。', textKind: 'full', signature: null },
        { type: 'tool-call', callId: 'call-1', family: 'run-shell', name: 'exec_command', input: { cmd: 'npm run build' } },
        { type: 'text', text: '构建失败：TS2304。' },
      ],
    });
  });

  it('工具真名取 `function_call.name`（事件流只有派生条目名），`arguments` 的 JSON 串解析成对象', () => {
    const { messages } = projectMain();
    const call = messages.flatMap((message) => message.blocks).find((block) => block.type === 'tool-call');
    expect(call).toMatchObject({ name: 'exec_command', input: { cmd: 'npm run build' } });
    // 结果按同一个 `callId` 配对到调用上：结果的 `callId` 与调用逐字相同
    const result = messages.flatMap((message) => message.blocks).find((block) => block.type === 'tool-result');
    expect(result).toMatchObject({ type: 'tool-result', callId: 'call-1' });
  });

  /**
   * 会话文件的轮次号与事件流同一把尺子（2026-10-05，spec §2.3）：`Reasoning` 条目**不**推高轮次。
   * 真机形状：主线程文件里 24 条 `Reasoning` + 18 条 `AgentMessage` ⇒ 旧口径数到 42、事件流只有 18。
   * 去重靶子：同一条目重复落行（`item_completed` 两次同一个 `id`）时号不许被推高。
   *
   * ⚠️ **期望值不是 brief 里那一行 `[1, 1, 2, 2]`**（控制者的 brief 自相矛盾：Step 3 的数组与 Step 5 的
   * 实现代码不可兼得，实测证据见 Task 5 报告 §TDD 与 §裁定）。这里按 **Step 5 的实现代码**（逐字）取
   * `[1, 1, 1, 1]`：非答复条目取「已数到的答复数（下限 1）」，而推理与工具条目对这把尺子是透明的。
   * 判据是**这条用例自己的两个靶子都必须打得响**（仓规：没见过失败的守卫不算守卫）：
   *   · 变异①把 `Reasoning` 加回计数键 ⇒ `[1, 2, 3, 3]`（第 2–4 个号红）；
   *   · 变异②去掉 `countedItems` 去重 ⇒ `[1, 1, 1, 2]`（第 4 个号红）。
   * 若按 brief 那一行 `[1, 1, 2, 2]`（= 「非答复条目取下一条答复的号」）实现，变异②**打不响**
   * ——这个夹具的「重复落行」就白摆了，而它的头一句注释写的正是「去重靶子」。
   */
  it('会话文件的轮次只数 AgentMessage：推理条目不推高号，重复 itemId 不重复计数', () => {
    const home = makeCodexHome({
      [rolloutPath(MAIN_THREAD_ID)]: [
        MAIN_META,
        itemCompletedLine({ type: 'Reasoning', id: 'rs-1', summary_text: [], raw_content: ['先想一下'] }),
        itemCompletedLine({ type: 'AgentMessage', id: 'msg-1', content: [{ type: 'Text', text: '答复一' }] }),
        // 第一次答复之后的推理：旧口径会把它数成第 3 轮，新口径下它**不**推高号（仍是 1）
        itemCompletedLine({ type: 'Reasoning', id: 'rs-2', summary_text: [], raw_content: ['再想一下'] }),
        // 同一条目重复落行：不许再推高（与事件流的 `turnKeys` 去重同构）——这一格就是去重的靶子
        itemCompletedLine({ type: 'AgentMessage', id: 'msg-1', content: [{ type: 'Text', text: '答复一' }] }),
      ],
    });
    const projected = projectCodexMessages({ codexHome: home, mainThreadId: MAIN_THREAD_ID, childThreadIds: [] });
    expect(projected.messages.map((draft) => draft.roundTrip)).toEqual([1, 1, 1, 1]);
    // 投递照旧：去重**只**作用于计数（同一份草稿仍然交出去，合并键在上游）
    expect(projected.messages.map((draft) => draft.vendorId)).toEqual(['rs-1', 'msg-1', 'rs-2', 'msg-1']);
  });

  /**
   * **跨通道同号**（2026-10-05 终审 Important 3）：上面那条只钉会话文件侧、`events.test.ts` 只钉事件流侧，
   * 而**没有任何用例把同一串条目同时喂给两侧比号**——真机上「18 == 18」只是单次运行的巧合。
   *
   * 三位参与者，缺一不可：
   *   · ① `projectCodexEvent`（事件流，生产路径）；
   *   · ② `projectCodexMessages`（会话文件，生产路径，夹具真的落盘）；
   *   · ③ `message-events.ts` 的 `codexEventToMessage`——生产**不走**它，但「三端一致性」套件拿它代表 codex，
   *     而它原来以 `{agent_message, reasoning}` 推进计数（2026-10-05 收窄成只数答复）。
   *     没有这一位，把 `reasoning` 加回它的计数键时本用例**不会红**——那正是终审点名的那把「第三把尺子」。
   *
   * 靶子：同一批**答复条目**在三条通道上拿到**同一个号**（重复 id 的那条不许把号推高），
   * 而 `reasoning` 在三处都**透明**（事件流连号都不给 ⇒ `null`；另两条给它「最近一次答复的号」）。
   */
  it('同一串条目喂三条通道：答复条目的号逐条相同，重复 id 不推高，`reasoning` 处处透明', () => {
    /** 事件流那一条的失败归因上下文（与 `events.test.ts` 同形；本用例不触发失败分支） */
    const CONTEXT = { kind: 'codex', baseUrl: 'https://gw.example.com/openai/v1' } as const;

    /**
     * **共享的条目清单**（一份真源）：两条通道的词汇表不同，拼写由下面两个小函数分别给出，
     * 免得「同一串条目」在两侧各写一份、悄悄漂移成两串。
     */
    const items: readonly { kind: 'reasoning' | 'answer'; id: string; text: string }[] = [
      { kind: 'reasoning', id: 'rs-1', text: '先想一下' },
      { kind: 'answer', id: 'msg-1', text: '答复一' },
      { kind: 'reasoning', id: 'rs-2', text: '再想一下' },
      { kind: 'answer', id: 'msg-2', text: '答复二' },
      // 重复 id 的条目：会话文件里同一个 `item_completed` 再落一行；事件流里同一个 item 的后续快照
      { kind: 'answer', id: 'msg-1', text: '答复一' },
    ];
    /** 事件流词汇表：**小写派生名**（`agent_message` / `reasoning`），答复正文在 `text` 里 */
    const streamItem = (item: (typeof items)[number]): Record<string, unknown> => ({
      type: item.kind === 'answer' ? 'agent_message' : 'reasoning',
      id: item.id,
      text: item.text,
    });
    /** 会话文件词汇表：**大写驼峰**，答复在 `content[]`、推理在 `raw_content[]`（两套词汇表不是一个） */
    const fileItem = (item: (typeof items)[number]): Record<string, unknown> =>
      item.kind === 'answer'
        ? { type: 'AgentMessage', id: item.id, content: [{ type: 'Text', text: item.text }] }
        : { type: 'Reasoning', id: item.id, summary_text: [], raw_content: [item.text] };

    // ① 事件流：逐条喂生产那一条（`index.ts` 的 `project` 只调它）
    const streamTurns: (number | null)[] = [];
    const streamState = createTurnState();
    const seenTexts = new Map<string, string>();
    for (const item of items) {
      streamTurns.push(projectCodexEvent({ type: 'item.completed', item: streamItem(item) }, streamState, seenTexts, CONTEXT).turns);
    }

    // ② 会话文件：一次读盘得出的每条草稿的号
    const home = makeCodexHome({
      [rolloutPath(MAIN_THREAD_ID)]: [MAIN_META, ...items.map((item) => itemCompletedLine(fileItem(item)))],
    });
    const fileRoundTrips = projectCodexMessages({ codexHome: home, mainThreadId: MAIN_THREAD_ID, childThreadIds: [] }).messages.map(
      (draft) => draft.roundTrip,
    );

    // ③ `message-events.ts`：**同一份状态**逐条喂（真实管线就是这么调它的），取每条草稿的号
    const syntheticState = createTurnState();
    const syntheticRoundTrips = items.map(
      (item) => codexEventToMessage({ type: 'item.completed', item: streamItem(item) }, syntheticState)[0]?.roundTrip ?? null,
    );

    // 靶子一：同一批答复条目的号逐条相同（`[null,1,null,2,null]` = 只有答复条目推高号；
    // 重复 id 那条落在第 2 轮上 ⇒ 它**没有**把号推到 3）
    expect(streamTurns).toEqual([null, 1, null, 2, null]);
    expect(fileRoundTrips).toEqual([1, 1, 1, 2, 2]);
    expect(syntheticRoundTrips).toEqual(fileRoundTrips);

    // 靶子二：`reasoning` 在三处都**透明**（事件流不给号；另两条给「最近一次答复的号」，两侧同值）
    const reasoningAt = items.map((item, index) => (item.kind === 'reasoning' ? index : -1)).filter((index) => index >= 0);
    expect(reasoningAt).toHaveLength(2);
    for (const index of reasoningAt) {
      expect(streamTurns[index]).toBeNull();
      expect(fileRoundTrips[index]).toBe(syntheticRoundTrips[index]);
    }
  });
});

/**
 * **嵌套子线程在内容面也要有自己的行与消息**（2026-10-06 修）。
 *
 * 缺陷形状：用量面（`projectTranscriptDrafts` → `discoverChildThreads`）自 R7 起就是**递归**的，
 * 而内容面（`message.ts` 的 `projectCodexMessages`）只吃**事件流点名的种子** ⇒ 沿 spawn 链
 * 递归发现的嵌套子线程**既没有子任务行、也没有消息**：它的用量已经进了 `subagentTokens`，
 * 界面上却没有那一行 —— 用户口径要的正是「主会话 + 每个 subagent 的用量」。
 *
 * 三条判据（缺一条就有一种静默的错）：
 *   ① 嵌套子线程产出一条 `SubagentRecord`（身份 / 父链 / 用量），且 `kind` / `parentCallId`
 *      取自**它父线程**的转录（否则界面按 `parentCallId` 找不到派发点，那一行仍然不可达）；
 *   ② 它自己的消息也投影出来（`subagentId` = 它）；
 *   ③ **Σ 各行的用量 === `subagentTokens`**——这条等式正是缺口本身。
 */
describe('嵌套子线程在内容面也有行与消息（2026-10-06）', () => {
  /**
   * 三层夹具：主线程 →（事件流点名 = 种子）c1 →（c1 文件里的**协作条目 + 命令横幅**）g1。
   * g1 的 `session_meta` **没有任何父链**（`nestedMetaLine`，真机形状）⇒ 只有递归发现找得到它。
   */
  function nestedHome(): string {
    const home = makeCodexHome({ 'sessions/keep.txt': ['x'] });
    writeInto(home, rolloutPath(MAIN_THREAD_ID), MAIN_MESSAGE_LINES);
    writeInto(home, rolloutPath(CHILD_THREAD_ID), [
      // c1 自己：元信息 + 一轮 + 用量（`threadLines` 的翻译：落盘的 `input_tokens` 要含 cached）
      ...threadLines(childMetaLine(CHILD_THREAD_ID), {
        totalTokenUsage: { input: 10, cached: 20, output: 5 },
        turnIds: ['u1'],
      }),
      itemCompletedLine({ type: 'AgentMessage', id: 'c1-msg', content: [{ type: 'Text', text: 'CHILD-OK' }] }, 'u1'),
      // 派发 g1 的两条证据：协作条目（`dispatchIndex` 的来源）+ 命令横幅（递归发现的来源）
      collabSpawnItemLine(CHILD_THREAD_ID, [GRANDCHILD_THREAD_ID]),
      sessionBannerOutputLine(GRANDCHILD_THREAD_ID, 'call-1'),
      // `parentCallId` 的配对键：会话文件里那条 `function_call`（`call_id` 与协作条目的 id 同值）
      line({
        timestamp: '2026-09-30T21:24:53.500Z',
        ordinal: 10,
        type: 'response_item',
        turn_id: 'u1',
        payload: { type: 'function_call', name: 'spawn_agent', arguments: '{"task":"g1"}', call_id: 'call-collab-1' },
      }),
    ]);
    writeInto(home, rolloutPath(GRANDCHILD_THREAD_ID), [
      ...threadLines(nestedMetaLine(GRANDCHILD_THREAD_ID), {
        totalTokenUsage: { input: 1, cached: 2, output: 3 },
        turnIds: ['w1'],
      }),
      itemCompletedLine({ type: 'AgentMessage', id: 'g1-msg', content: [{ type: 'Text', text: 'SUBAGENT_OK' }] }, 'w1'),
    ]);
    return home;
  }

  /**
   * 与生产路径同一条：产物过一遍**合并器**，于是断言看到的是消费方真正拿到的 `AgentMessage`
   * （而不是中间的块草稿 `{ phase, identity, block }`）。
   */
  function projectNested(): { messages: AgentMessage[]; subagents: SubagentRecord[] } {
    const projected = projectCodexMessages({
      codexHome: nestedHome(),
      mainThreadId: MAIN_THREAD_ID,
      // ⚠️ 事件流**只点名 c1**：g1 完全靠递归发现（旧行为下它一行都没有）
      childThreadIds: [CHILD_THREAD_ID],
    });
    const assembler = createMessageAssembler({ runId: 'run-codex' });
    const messages: AgentMessage[] = [];
    for (const draft of projected.messages) assembler.ingest(draft, (message) => messages.push(message));
    return { messages, subagents: projected.subagents };
  }

  it('① 嵌套子线程有自己的行：身份 / 用量 / 取自**父线程**转录的派发信息', () => {
    const { subagents } = projectNested();

    expect(subagents.map((record) => record.subagentId)).toEqual([CHILD_THREAD_ID, GRANDCHILD_THREAD_ID]);
    expect(subagents[1]).toMatchObject({
      subagentId: GRANDCHILD_THREAD_ID,
      // 真机形状：嵌套线程的 `session_meta` 没有父链 ⇒ 顶层（与既有口径一致，本次不动）
      parentSubagentId: null,
      // 派发动作与调用 id 来自**c1 那一份**文件（主线程文件里没有这条协作条目）
      kind: 'spawn_agent',
      parentCallId: 'call-collab-1',
      source: 'session-file',
      status: 'completed',
      usage: { input: 1, cached: 2, output: 3, reasoningOutput: null, total: null },
    });
  });

  it('② 嵌套子线程自己的消息也投影出来（点进去不是空的）', () => {
    const { messages } = projectNested();
    const grandchildMessages = messages.filter((message) => message.subagentId === GRANDCHILD_THREAD_ID);

    expect(grandchildMessages.length, '嵌套子线程一条消息都没产出（点进去会是空的）').toBeGreaterThan(0);
    expect(
      grandchildMessages.some((message) => message.blocks.some((block) => block.type === 'text' && block.text.includes('SUBAGENT_OK'))),
    ).toBe(true);
    // 载体隔离：它的消息不会混进主会话或父线程（合并键以身份打头）
    for (const message of grandchildMessages) expect(message.mergeKey.startsWith(`${GRANDCHILD_THREAD_ID}|`)).toBe(true);
  });

  it('③ Σ 各子任务行的用量 === `subagentTokens`（分量读到的每一个都有自己那一行）', () => {
    const home = nestedHome();
    /** 生产路径的形状：一个读周期里**只发现一次**，内容面与用量面共用（`index.ts` 的 `discover()`） */
    const discovery = discoverChildThreads({
      codexHome: home,
      mainThreadId: MAIN_THREAD_ID,
      childThreadIds: [CHILD_THREAD_ID],
      read: readTranscript,
    });
    const content = projectCodexMessages({
      codexHome: home,
      mainThreadId: MAIN_THREAD_ID,
      childThreadIds: [CHILD_THREAD_ID],
      discovery,
    });
    const component = projectChildThreadUsage({
      codexHome: home,
      mainThreadId: MAIN_THREAD_ID,
      childThreadIds: [CHILD_THREAD_ID],
      discovery,
    }).usage;

    // 分量本身：c1(10/20/5) + g1(1/2/3)
    expect(component).toMatchObject({ input: 11, cached: 22, output: 8 });
    // 逐行相加必须**逐字等于**它（改前这里是 10/20/5 —— 少的正是 g1 那一行）
    const sum = content.subagents.reduce(
      (total, record) => ({
        input: total.input + (record.usage?.input ?? 0),
        cached: total.cached + (record.usage?.cached ?? 0),
        output: total.output + (record.usage?.output ?? 0),
      }),
      { input: 0, cached: 0, output: 0 },
    );
    expect(sum).toEqual({ input: component?.input, cached: component?.cached, output: component?.output });
  });

  it('④ `totalUsageOf` 与分量同一把尺子：最后一条 `token_count` 缺项时退到**前一条读得全的**', () => {    const home = makeCodexHome({ 'sessions/keep.txt': ['x'] });
    writeInto(home, rolloutPath(MAIN_THREAD_ID), MAIN_MESSAGE_LINES);
    writeInto(home, rolloutPath(CHILD_THREAD_ID), [
      childMetaLine(CHILD_THREAD_ID),
      itemCompletedLine({ type: 'AgentMessage', id: 'c1-msg', content: [{ type: 'Text', text: 'CHILD-OK' }] }),
      line({
        timestamp: '2026-09-30T21:24:44.000Z',
        ordinal: 7,
        type: 'event_msg',
        turn_id: 'u1',
        payload: {
          type: 'token_count',
          info: { total_token_usage: { input_tokens: 30, cached_input_tokens: 20, output_tokens: 5 } },
        },
      }),
      // 最后一条**读不全**（只有 output）⇒ 两处都必须退到上面那条，而不是一个给数、一个给 null
      line({
        timestamp: '2026-09-30T21:24:45.000Z',
        ordinal: 8,
        type: 'event_msg',
        turn_id: 'u1',
        payload: { type: 'token_count', info: { total_token_usage: { output_tokens: 9 } } },
      }),
    ]);
    const content = projectCodexMessages({ codexHome: home, mainThreadId: MAIN_THREAD_ID, childThreadIds: [CHILD_THREAD_ID] });
    const component = projectChildThreadUsage({
      codexHome: home,
      mainThreadId: MAIN_THREAD_ID,
      childThreadIds: [CHILD_THREAD_ID],
      read: readTranscript,
    }).usage;

    // 行的用量与分量同值（改前：分量 10/20/5 而这一行 `usage: null` ⇒ Σ 各行对不上分量）
    expect(content.subagents[0]?.usage).toEqual({ input: 10, cached: 20, output: 5, reasoningOutput: null, total: null });
    expect(component).toEqual({ input: 10, cached: 20, output: 5, reasoningOutput: null, total: null });
  });
});

/**
 * **一个读周期里每个线程文件只读一次**（2026-10-06 用户口径：「不要重复读取文件」）。
 *
 * `index.ts` 的每个读周期只发现一次（`discover()`），把同一份递归发现传给内容面与用量面。
 * 破法：任一处不传 `discovery` ⇒ 那一次会**重新发现**（每个线程再扫一遍 `sessions/` + 读一份文件）。
 * 判据取「内层读者被调用了几次」——它正好等于「打开了几个线程文件」。
 */
describe('一个读周期只发现一次：内容面与用量面共用（2026-10-06）', () => {
  it('主线程 + 子线程各读一次：两处投影共用同一份发现', () => {
    const home = makeCodexHome({ 'sessions/keep.txt': ['x'] });
    writeInto(home, rolloutPath(MAIN_THREAD_ID), MAIN_MESSAGE_LINES);
    writeInto(home, rolloutPath(CHILD_THREAD_ID), CHILD_MESSAGE_LINES);
    const read = vi.fn(readTranscript);

    const discovery = discoverChildThreads({
      codexHome: home,
      mainThreadId: MAIN_THREAD_ID,
      childThreadIds: [CHILD_THREAD_ID],
      read,
    });
    projectCodexMessages({ codexHome: home, mainThreadId: MAIN_THREAD_ID, childThreadIds: [CHILD_THREAD_ID], read, discovery });
    projectChildThreadUsage({ codexHome: home, mainThreadId: MAIN_THREAD_ID, childThreadIds: [CHILD_THREAD_ID], read, discovery });

    // 发现读子线程一份（`discoverChildThreads` 不读主线程），内容面读主线程一份 ⇒ 恰好两次
    expect(read).toHaveBeenCalledTimes(2);
    expect(new Set(read.mock.calls.map((call) => String(call[0]))).size).toBe(2);
  });
});