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
 *   ⑤ 坏行计数不炸。
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
import { collectEvents, createFakeCodexSdk, createRecorder, createRunInput } from '../../testing/agent-fixtures';
import { codexProvider } from './index';
import { projectCodexMessages } from './message';
import { CODEX_PACKAGE_NAME } from './sdk';
import {
  findTranscript,
  noteThreadIds,
  parseRecord,
  projectTranscriptDrafts,
  readTranscript,
  reasoningTextOf,
  type CodexTranscript,
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
}): string =>
  line({
    timestamp: '2026-09-30T21:24:34.570Z',
    ordinal: 0,
    type: 'session_meta',
    payload: {
      session_id: overrides.sessionId,
      id: overrides.id,
      parent_thread_id: overrides.parentThreadId,
      timestamp: '2026-09-30T21:24:34.570Z',
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

  it('形状不对时一个 id 都不收（宁可少收一个，也不拿猜出来的 id 去读盘）', () => {
    const targets: TranscriptTargets = { mainThreadId: null, childThreadIds: [] };
    noteThreadIds(targets, { type: 'thread.started', thread_id: '' });
    noteThreadIds(targets, { type: 'thread.started' });
    noteThreadIds(targets, { type: 'collab_tool_call', receiver_thread_ids: 'c1' });
    noteThreadIds(targets, { type: 'collab_tool_call', receiver_thread_ids: [1, null, {}] });
    expect(targets).toEqual({ mainThreadId: null, childThreadIds: [] });
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
// index 层的接线（用注入的读取器，不碰盘）
// ─────────────────────────────────────────────────────────────────────────────

describe('codex 适配器接线：会话文件的读取时机与计量合并', () => {
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

  it('失败 / 被终止的运行**不读**会话文件（不在收尾时去补一份「跑完之后才读到」的内容）', async () => {
    const events: AgentEvent[] = [];
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
    const home = makeRealCodexHome();
    const read = vi.fn(throwingReader('不该被调用').read);    const original = codexProvider.transcriptReader;
    codexProvider.transcriptReader = { read };
    try {
      const result = await codexProvider.run(createRunInput({ configHome: home, onEvent: collectEvents(events) }));
      expect(result).toMatchObject({ ok: false, exitReason: 'error' });
    } finally {
      codexProvider.transcriptReader = original;
    }
    expect(read).not.toHaveBeenCalled();
    // 失败路径上一条会话文件的事件都不该有
    expect(events.map((event) => kindOf(event)).filter((kind) => kind !== null)).toEqual([]);
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

  it('一条条目一层消息：推理 / 工具调用 / 工具结果 / 答复各就其位（同载体的块累积成一条）', () => {
    const { messages } = projectMain();
    /**
     * 预期形状。**合并器每条投递都产出一条消息**（内容是该合并键到目前为止的完整块列表），
     * 所以这里的条数 = **投递数**，不是「最终有几条逻辑消息」：
     *   · `UserMessage` **不产出消息**（那是喂进去的输入）；
     *   · `Reasoning` 与 `CommandExecution` 的**调用**落在**同一个载体**（同一次模型往返、都是主线程的
     *     `assistant` 面）⇒ 第二条投递带齐「思考 + 工具调用」两块，与另两家同形
     *     （dsh 的推理与 `tool/call` 也落在同一条 `assistant/message` 上）；
     *   · `CommandExecution` 的**结果**在 `tool` 载体的另一条消息里，靠 `callId` 与调用配对；
     *   · `AgentMessage` 把轮次推到 2 ⇒ 新载体、新消息（块序号在自己的载体里重新起算）。
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
          truncated: false,
        },
      ],
    });
    expect(messages[3]).toMatchObject({
      role: 'assistant',
      roundTrip: 2,
      vendorId: 'msg-1',
      blocks: [{ type: 'text', text: '构建失败：TS2304。' }],
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
});