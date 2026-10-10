// @vitest-environment node
/**
 * 记录日志（`messages.jsonl`）：追加（一行一条记录）、全量读、按 `mergeKey` / `subagentId`
 * 覆盖累积、清空，以及坏行的容忍。
 *
 * 六条关键守卫：
 *   ① **一条记录一行**、逐字读回（`messageId` / `mergeKey` / `blocks` 都不能被改写）——
 *      覆盖累积全靠这两把键，写入时丢一格就等于把合并算法废掉；
 *   ② **两种记录共用一个文件**（`message` / `subagent`），读取时按 `type` 分流；
 *   ③ **`foldMessages` 是覆盖而非追加**：同一 `mergeKey` 的多条只留最后一条（它的 `blocks` 已是全量），
 *      且顺序按**首次出现**（打字过程中的覆盖不该让这条消息跳到列表末尾）；
 *   ④ 坏行（写一半被杀、手工编辑、空行）只跳过该行并 WARN，其余记录必须全部读出来；
 *   ⑤ **写**进去的记录必须符合契约：读侧容忍（④）是为了「一行坏不牵连别人」，写侧容忍的后果是
 *      唯一真相源静默少记录（写成功、读时被 schema 丢掉）；
 *   ⑥ 清空后重新追加是干净的（重跑同一行不能把两次尝试的对话混在一起）。
 */
import { appendFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RowRecordSchema, ServiceError, type AgentMessage, type SubagentRecord } from '@aieval/contracts';
import {
  appendMessage,
  appendRecord,
  appendSubagent,
  foldMessages,
  foldSubagents,
  readRecords,
  readRowRecords,
  resetRecords,
} from './message-log';
import { removeTreeWithRetry } from './testing/cleanup';

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aieval-messages-'));
  file = join(dir, 'messages.jsonl');
});

afterEach(() => {
  vi.restoreAllMocks();
  removeTreeWithRetry(dir);
});

/** 一条最小合法消息（用例只覆盖自己关心的格） */
function message(overrides: Partial<AgentMessage> = {}): AgentMessage {
  return {
    messageId: 'run-1:1',
    vendorId: 'msg_1',
    role: 'assistant',
    source: 'wire',
    roundTrip: 1,
    turn: null,
    step: null,
    parentCallId: null,
    subagentId: null,
    chunk: 'snapshot',
    assembly: 'snapshot',
    mergeKey: 'main|1|assistant|-',
    blocks: [{ type: 'text', text: '答复' }],
    raw: { kind: 'raw' },
    ...overrides,
  };
}

/** 一条最小合法子任务行 */
function subagent(overrides: Partial<SubagentRecord> = {}): SubagentRecord {
  return {
    subagentId: 'child-1',
    name: '检查工作区',
    kind: 'spawn_agent',
    source: 'wire',
    status: 'running',
    statusMissing: null,
    outcome: null,
    parentCallId: null,
    parentSubagentId: null,
    usage: null,
    ...overrides,
  };
}

describe('appendRecord / appendMessage / appendSubagent', () => {
  it('一行一条记录、逐字读回（`messageId` / `mergeKey` / `blocks` 都不被改写）', () => {
    const written = appendMessage(file, message());
    expect(written).toEqual(message());
    // 文件里就是**一行** JSON（appendFileSync 的 O_APPEND 语义）
    const lines = readFileSync(file, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual({ type: 'message', message: message() });
    expect(readRowRecords(file).messages).toEqual([message()]);
  });

  it('`messageId` 与 `mergeKey` 由适配器给，本模块不补、不改（补了会让消费方拿两套号对不上）', () => {
    const written = appendMessage(file, message({ messageId: 'run-9:42', mergeKey: 'sub|7|assistant|call_1' }));
    expect(written.messageId).toBe('run-9:42');
    expect(written.mergeKey).toBe('sub|7|assistant|call_1');
  });

  it('两种记录共用一个文件，读侧按 `type` 分流', () => {
    appendMessage(file, message());
    appendSubagent(file, subagent());
    appendSubagent(file, subagent({ subagentId: 'child-2', status: 'completed', statusMissing: null }));
    const { messages, subagents } = readRowRecords(file);
    expect(messages.map((entry) => entry.messageId)).toEqual(['run-1:1']);
    expect(subagents.map((entry) => entry.subagentId)).toEqual(['child-1', 'child-2']);
    // 原始顺序也在（需要按到达顺序做别的处理时不必再解析一遍文件）
    expect(readRecords(file).map((record) => record.type)).toEqual(['message', 'subagent', 'subagent']);
  });

  it('写侧拒绝坏数据（缺 `mergeKey` 这种形状漂移必须在写入点暴露，而不是读取时静默丢弃）', () => {
    const bad = { ...message(), mergeKey: undefined } as unknown as AgentMessage;
    expect(() => appendMessage(file, bad)).toThrow(ServiceError);
    // 写入被拒 ⇒ 文件里一条都没有（不会留下「谁也读不到」的残行）
    expect(existsSync(file)).toBe(false);
  });

  it('子任务行的 `statusMissing` 与 `status` 分开记（采不到必须显式说明原因，不得用 null 状态表达）', () => {
    appendSubagent(file, subagent({ status: 'unknown', statusMissing: 'unverified' }));
    const written = readRowRecords(file).subagents[0];
    expect(written).toMatchObject({ status: 'unknown', statusMissing: 'unverified' });
    // 契约层不接受「状态为空」的写法
    const bad = { type: 'subagent' as const, subagent: { ...subagent(), status: null } };
    expect(RowRecordSchema.safeParse(bad).success).toBe(false);
  });

  it('目录不存在时自己建（消息可能先于行目录就位到达）', () => {
    const nested = join(dir, 'run-1', 'rows', 'row-1', 'messages.jsonl');
    appendRecord(nested, { type: 'message', message: message() });
    expect(existsSync(nested)).toBe(true);
  });
});

describe('readRowRecords / readRecords', () => {
  it('文件不存在返回空（评测还没跑过的行也要能打开对话视图）', () => {
    expect(readRecords(join(dir, 'nope.jsonl'))).toEqual([]);
    expect(readRowRecords(join(dir, 'nope.jsonl'))).toEqual({ messages: [], subagents: [] });
  });

  it('坏行只跳过该行并 WARN，其余记录全部读出来', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    writeFileSync(
      file,
      [
        JSON.stringify({ type: 'message', message: message({ messageId: 'run-1:1' }) }),
        '{这一行不是合法 JSON',
        JSON.stringify({ type: 'message', message: { messageId: 'run-1:2' } }), // 合法 JSON 但不符合契约
        '',
        JSON.stringify({ type: 'message', message: message({ messageId: 'run-1:3' }) }),
      ].join('\n'),
      'utf8',
    );
    expect(readRowRecords(file).messages.map((entry) => entry.messageId)).toEqual(['run-1:1', 'run-1:3']);
    // 两种坏行各一条 WARN（文件头口径 4）
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('容忍 UTF-8 BOM（外部工具编辑过的文件首行会带 U+FEFF）', () => {
    writeFileSync(file, `\uFEFF${JSON.stringify({ type: 'message', message: message() })}\n`, 'utf8');
    expect(readRowRecords(file).messages).toHaveLength(1);
  });

  it('追加后故意改坏文件里的 `blocks`，读侧必须跳过它（而不是抛）', () => {
    appendMessage(file, message());
    appendFileSync(
      file,
      `${JSON.stringify({ type: 'message', message: { ...message({ messageId: 'run-1:2' }), blocks: 'not-an-array' } })}\n`,
      'utf8',
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(readRowRecords(file).messages.map((entry) => entry.messageId)).toEqual(['run-1:1']);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('foldMessages：按 `mergeKey` 覆盖累积', () => {
  it('同一 `mergeKey` 的多条只留最后一条（它的 blocks 已是全量），顺序按首次出现', () => {
    const folded = foldMessages([
      message({ messageId: 'run-1:1', chunk: 'delta', assembly: 'open', blocks: [{ type: 'text', text: '我先看' }] }),
      message({ messageId: 'run-1:2', blocks: [{ type: 'text', text: '我先看一下配置文件。' }] }),
      message({
        messageId: 'run-1:3',
        roundTrip: 2,
        mergeKey: 'main|2|assistant|-',
        blocks: [{ type: 'text', text: '第二步' }],
      }),
      // 第一条逻辑消息在第二轮里又被覆盖一次：它必须仍排在**首位**（不能跳到末尾）
      message({ messageId: 'run-1:4', blocks: [{ type: 'text', text: '我先看一下配置文件，然后动手。' }] }),
    ]);
    expect(folded.map((entry) => entry.messageId)).toEqual(['run-1:4', 'run-1:3']);
    expect(folded.map((entry) => (entry.blocks[0] as { text: string }).text)).toEqual([
      '我先看一下配置文件，然后动手。',
      '第二步',
    ]);
  });

  it('折叠出来的每一条都仍是合法消息（消费方拿到的就是契约形状）', () => {
    const folded = foldMessages([message({ messageId: 'run-1:1' }), message({ messageId: 'run-1:2' })]);
    for (const entry of folded) expect(RowRecordSchema.safeParse({ type: 'message', message: entry }).success).toBe(true);
  });

  it('空输入给空数组（不发明一条空消息）', () => {
    expect(foldMessages([])).toEqual([]);
  });
});

describe('foldSubagents：按 `subagentId` 覆盖累积', () => {
  it('派发一条、收场一条 ⇒ 只留收场那条（它是完整快照），顺序按首次出现', () => {
    const folded = foldSubagents([
      subagent(),
      subagent({ subagentId: 'child-2', name: '第二个' }),
      subagent({ status: 'completed', outcome: '跑完了' }),
    ]);
    expect(folded.map((entry) => entry.subagentId)).toEqual(['child-1', 'child-2']);
    expect(folded[0]).toMatchObject({ status: 'completed', outcome: '跑完了' });
  });
});

describe('resetRecords', () => {
  it('清空后重新追加是干净的（重跑同一行不把两次尝试的对话混在一起）', () => {
    appendMessage(file, message({ messageId: 'run-1:1' }));
    expect(existsSync(file)).toBe(true);
    resetRecords(file);
    expect(existsSync(file)).toBe(false);
    appendMessage(file, message({ messageId: 'run-1:1', blocks: [{ type: 'text', text: '这一次' }] }));
    expect(readRowRecords(file).messages).toHaveLength(1);
  });

  it('文件不存在时是 no-op（不抛）', () => {
    expect(() => resetRecords(join(dir, 'nope.jsonl'))).not.toThrow();
  });

  it('BOM 与空行的处理与读取侧一致（同一个文件在两处不能被切成不同的行）', () => {
    writeFileSync(file, `\uFEFF${JSON.stringify({ type: 'message', message: message() })}\n\n`, 'utf8');
    resetRecords(file);
    expect(existsSync(file)).toBe(false);
  });
});
