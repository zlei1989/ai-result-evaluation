// @vitest-environment node
/**
 * cc 主会话的**流式增量必须与它那条快照落进同一个载体**（`mergeKey` = 会话|轮次|角色|派生调用）。
 *
 * 为什么这条对齐是硬要求：载体的文本槽一旦被块结束快照 `sealed`，后到的增量按 `MessageAssembler`
 * 的「已 seal + 增量 ⇒ 丢弃」被**静默吃掉**（`message.ts` 的 `applyBlock`）——没有日志、没有报错，
 * 界面只在快照到达时整段出现。增量落错载体还有第二档后果：上一轮的文本槽若还没被占
 * （上一轮只产出工具调用，走 `c:<callId>` 槽），增量会写进去看着在长，却**挂在前一轮的轮次位置上**。
 * 两档都让「打字机」不可信，所以对齐由本文件钉住。
 *
 * 号从哪来（cc 是四家唯一需要专门处置的）：
 *   · 主会话的轮次号取 `message.id` 在 `state.turnKeys` 里的位次——那是 events 侧按到达顺序记的
 *     **完整 assistant 消息 id**（`countModelRoundTrip`）。增量到达时那条完整消息还没到，
 *     所以**不能**拿 `state.turns`（= 账里的条数）当号：它答的是「已经数到几条」；
 *   · 兄弟实现各自的判据不同、别照抄：pi 的 `state.turns` 由 `turn_start` 推进（该轮**开始**时），
 *     codex 取线程答复条目数且**先计入再取号**，dsh 的增量直接带厂商自己的 `step` 号
 *     ——它们的号在该轮开始时就已经正确，只有 cc 的计数点在**该轮结束时**。
 *
 * 夹具走的是与 `cc/index.ts` 的 `project` 逐字相同的顺序：先 `projectClaudeMessage`
 * （事件侧，推进 `state.turns`），再 `messages.normalize`（消息侧，产内容消息），最后喂
 * `MessageAssembler`（与编排层同一条落盘路径）。于是这里的号与真机逐字同源。
 */
import { describe, expect, it } from 'vitest';
import { createMessageAssembler, type MessageDraft } from '../../message';
import type { TurnState } from '../../turn';
import { projectClaudeMessage } from './events';
import { createClaudeMessageNormalizer } from './message';

function makeState(): TurnState {
  return {
    seen: new Set(),
    turns: 0,
    usageInput: null,
    usageCached: null,
    usageOutput: null,
    usageReasoningOutput: null,
    usageTotal: null,
    timing: null,
    usageByMessageId: new Map(),
    turnKeys: new Set(),
    finalText: null,
  };
}

/** 流量开始：厂商声明「我要开始流这条消息了」，带 message.id */
const messageStart = (uuid: string, messageId: string): unknown => ({
  type: 'stream_event',
  uuid,
  event: { type: 'message_start', message: { id: messageId } },
});

/** 一段正文增量 */
const textDelta = (uuid: string, text: string): unknown => ({
  type: 'stream_event',
  uuid,
  event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
});

/** 完整 assistant 消息（块结束快照） */
const assistant = (uuid: string, messageId: string, content: unknown[]): unknown => ({
  type: 'assistant',
  uuid,
  parent_tool_use_id: null,
  message: { id: messageId, role: 'assistant', content },
});

/** 工具结果（user 消息里的 tool_result 块） */
const toolResult = (uuid: string, callId: string, text: string): unknown => ({
  type: 'user',
  uuid,
  parent_tool_use_id: null,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: callId, content: text }] },
});

interface Row {
  frame: string;
  /** 归一器产出的草稿落进哪个键 */
  key: string;
  chunk: string;
  /** 装配器回吐的这一条：这个载体**当时**的正文长度（累积值）——它涨了才算「增量生效」 */
  carrierText: number;
}

/** 顺序跑一遍帧序列：投影 → 归一 → 装配（前两步顺序与 `cc/index.ts` 的 project 逐字相同） */
function run(frames: readonly { label: string; raw: unknown }[]): Row[] {
  const state = makeState();
  const normalizer = createClaudeMessageNormalizer();
  const assembler = createMessageAssembler({ runId: 'probe' });
  const rows: Row[] = [];
  for (const { label, raw } of frames) {
    projectClaudeMessage(raw, state, { kind: 'cc', baseUrl: 'http://probe.invalid' });
    const out = normalizer.normalize(raw, state);
    for (const draft of out.messages as readonly MessageDraft[]) {
      const draftKey = [draft.subagentId ?? 'main', String(draft.roundTrip), draft.role, draft.parentCallId ?? '-'].join('|');
      assembler.ingest(draft, (message) => {
        rows.push({
          frame: label,
          key: draftKey,
          chunk: message.chunk,
          carrierText: message.blocks.reduce(
            (total, block) => total + (block.type === 'text' || block.type === 'thinking' ? (block.text ?? '').length : 0),
            0,
          ),
        });
      });
    }
  }
  return rows;
}

/** 两轮（各带流式 + 一次工具往返）——与真机 cc 行的形状同构 */
const TWO_ROUNDS: readonly { label: string; raw: unknown }[] = [
  { label: 'T1 message_start', raw: messageStart('u1', 'msg_A') },
  { label: 'T1 delta 1', raw: textDelta('u2', '第一') },
  { label: 'T1 delta 2', raw: textDelta('u3', '句话') },
  { label: 'T1 快照', raw: assistant('u4', 'msg_A', [{ type: 'text', text: '第一句话' }]) },
  {
    label: 'T1 tool_use',
    raw: assistant('u5', 'msg_A', [{ type: 'tool_use', id: 'call_1', name: 'Bash', input: { command: 'ls' } }]),
  },
  { label: 'T1 tool_result', raw: toolResult('u6', 'call_1', 'ok') },
  { label: 'T2 message_start', raw: messageStart('u7', 'msg_B') },
  { label: 'T2 delta 1', raw: textDelta('u8', '第二') },
  { label: 'T2 delta 2', raw: textDelta('u9', '句话') },
  { label: 'T2 快照', raw: assistant('u10', 'msg_B', [{ type: 'text', text: '第二句话' }]) },
];

describe('cc 主会话流式增量的载体对齐', () => {
  it('第 1 轮：增量与该轮快照同键，且增量当场写进载体', () => {
    const rows = run(TWO_ROUNDS);
    const deltaKeys = rows.filter((row) => row.frame.startsWith('T1 delta')).map((row) => row.key);
    const snapshotKey = rows.find((row) => row.frame === 'T1 快照')?.key;
    expect(deltaKeys).toEqual([snapshotKey, snapshotKey]);
    expect(rows.find((row) => row.frame === 'T1 delta 1')?.carrierText).toBe('第一'.length);
    expect(rows.find((row) => row.frame === 'T1 delta 2')?.carrierText).toBe('第一句话'.length);
  });

  it('第 2 轮：增量**不**落上一轮的载体（否则会被已 seal 的槽位静默丢弃）', () => {
    const rows = run(TWO_ROUNDS);
    const deltaKeys = rows.filter((row) => row.frame.startsWith('T2 delta')).map((row) => row.key);
    const snapshotKey = rows.find((row) => row.frame === 'T2 快照')?.key;
    expect(snapshotKey).toBe('main|2|assistant|-');
    expect(deltaKeys).toEqual([snapshotKey, snapshotKey]);
    // 增量到达那一刻载体就该长起来（等快照才出现 = 使用者看到的「只有全部完成才显示」）
    expect(rows.find((row) => row.frame === 'T2 delta 1')?.carrierText).toBe('第二'.length);
    expect(rows.find((row) => row.frame === 'T2 delta 2')?.carrierText).toBe('第二句话'.length);
    // 第 1 轮的载体不许被这一轮的增量改写
    expect(rows.filter((row) => row.key === 'main|1|assistant|-').at(-1)?.carrierText).toBe('第一句话'.length);
  });

  it('每条消息的增量都归自己那一轮（多轮不串联）', () => {
    const rows = run([
      ...TWO_ROUNDS,
      { label: 'T3 message_start', raw: messageStart('u11', 'msg_C') },
      { label: 'T3 delta 1', raw: textDelta('u12', '第三') },
      { label: 'T3 delta 2', raw: textDelta('u13', '句话') },
      { label: 'T3 快照', raw: assistant('u14', 'msg_C', [{ type: 'text', text: '第三句话' }]) },
    ]);
    for (const [round, key] of [
      ['T1', 'main|1|assistant|-'],
      ['T2', 'main|2|assistant|-'],
      ['T3', 'main|3|assistant|-'],
    ] as const) {
      expect(rows.filter((row) => row.frame.startsWith(`${round} delta`)).map((row) => row.key)).toEqual([key, key]);
      expect(rows.find((row) => row.frame === `${round} 快照`)?.key).toBe(key);
    }
  });

  it('同一条消息分块多次投递：号按 message.id 稳定（第 2 次投递不新开一轮、不挪轮次）', () => {
    const rows = run([
      { label: 'T1 message_start', raw: messageStart('u1', 'msg_A') },
      { label: 'T1 快照 第1块', raw: assistant('u2', 'msg_A', [{ type: 'text', text: '第一句话' }]) },
      {
        label: 'T1 快照 第2块',
        raw: assistant('u3', 'msg_A', [
          { type: 'text', text: '第一句话' },
          { type: 'tool_use', id: 'call_1', name: 'Bash', input: { command: 'ls' } },
        ]),
      },
      { label: 'T2 message_start', raw: messageStart('u4', 'msg_B') },
      { label: 'T2 增量', raw: textDelta('u5', '第二') },
      { label: 'T2 快照', raw: assistant('u6', 'msg_B', [{ type: 'text', text: '第二句话' }]) },
    ]);
    // 同一条消息的两次投递都落它自己那一轮（号由 id 的位次给，不由投递次数给）
    expect(rows.filter((row) => row.frame.startsWith('T1 快照')).map((row) => row.key)).toEqual([
      'main|1|assistant|-',
      'main|1|assistant|-',
    ]);
    expect(rows.find((row) => row.frame === 'T2 增量')?.key).toBe('main|2|assistant|-');
    expect(rows.find((row) => row.frame === 'T2 快照')?.key).toBe('main|2|assistant|-');
  });
});
