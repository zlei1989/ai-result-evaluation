// @vitest-environment node
/**
 * 一候选的记录折叠（`foldCandidateRecords` / `mergeCandidateRecords`）：**折叠键必须带段号**。
 *
 * 为什么这一条是缺陷级而不是风格问题：一次追问是又开一次 `run()`，那一段自己的厂商轮次从 1
 * 重新数 ⇒ 两段的载体键**逐字相同**（`main|1|assistant|-`）。按裸 `mergeKey` 折叠就是「后一段
 * 把前一段同键的那条整条吃掉」——真机症状是**关掉再打开执行日志，首段的消息全没了**
 * （抽屉重新打开时先拉 `/messages`，走的就是本文件的折叠；而服务端与 ui 两侧早已用
 * `(segment, mergeKey)`，只有这里漏了）。
 *
 * 本仓的折叠键真源是 `@aieval/contracts` 的 `messageFoldKey`：服务端（`@aieval/core`）、
 * 界面装配（`@aieval/ui`）与本文件三处必须同一条式子——各写一份就是「一处认段、一处不认」，
 * 看起来像内容丢失而不是合并错。
 */
import { describe, expect, it } from 'vitest';
import type { AgentMessage, CandidateRecord } from '@aieval/contracts';
import { foldCandidateRecords, mergeCandidateRecords } from './candidate-messages';

/** 一条消息记录（只给折叠用得上的那几格；其余按契约必填格补齐） */
function message(input: {
  mergeKey: string;
  segment?: number;
  role?: AgentMessage['role'];
  text?: string;
}): CandidateRecord {
  const message: AgentMessage = {
    messageId: `m-${input.mergeKey}-${String(input.segment ?? 0)}`,
    vendorId: null,
    role: input.role ?? 'assistant',
    source: 'wire',
    origin: 'case-prompt',
    ...(input.segment === undefined ? {} : { segment: input.segment }),
    roundTrip: 1,
    turn: null,
    step: null,
    parentCallId: null,
    subagentId: null,
    chunk: 'snapshot',
    assembly: 'snapshot',
    mergeKey: input.mergeKey,
    blocks: [{ type: 'text', text: input.text ?? '正文' }],
    usage: null,
    raw: null,
  };
  return { type: 'message', message };
}

/** 折叠后每条的 `(段号, 正文首块)`——顺序也一并断言（顺序 = 首次出现顺序） */
function shapeOf(records: readonly CandidateRecord[]): [number, string][] {
  return records.map((record) => {
    if (record.type !== 'message') throw new Error('本组用例只有消息记录');
    const first = record.message.blocks[0];
    return [record.message.segment ?? 0, first?.type === 'text' ? first.text : ''];
  });
}

describe('foldCandidateRecords：折叠键带段号（两段的同号轮次各留各的）', () => {
  /** 首段与追问那一段的「第 1 轮」：载体键逐字相同、段号不同 */
  const twoSegments: CandidateRecord[] = [
    message({ mergeKey: 'main|1|assistant|-', text: '首段的第 1 轮' }),
    message({ mergeKey: 'main|1|tool|-', role: 'tool', text: '首段的工具结果' }),
    message({ mergeKey: 'main|2|assistant|-', text: '首段的第 2 轮' }),
    message({ mergeKey: 'main|1|user|-|followup:f1', role: 'user', segment: 1, text: '再解释一遍' }),
    message({ mergeKey: 'main|1|assistant|-', segment: 1, text: '追问那一段的第 1 轮' }),
    message({ mergeKey: 'main|1|tool|-', role: 'tool', segment: 1, text: '追问那一段的工具结果' }),
    message({ mergeKey: 'main|2|assistant|-', segment: 1, text: '追问那一段的第 2 轮' }),
  ];

  it('两段同键的消息**都在**（后一段不许把前一段吃掉）', () => {
    expect(shapeOf(foldCandidateRecords(twoSegments))).toEqual([
      [0, '首段的第 1 轮'],
      [0, '首段的工具结果'],
      [0, '首段的第 2 轮'],
      [1, '再解释一遍'],
      [1, '追问那一段的第 1 轮'],
      [1, '追问那一段的工具结果'],
      [1, '追问那一段的第 2 轮'],
    ]);
  });

  it('同一段内的多次投递照旧覆盖（delta 之后是快照 ⇒ 留最后一条）', () => {
    const folded = foldCandidateRecords([
      message({ mergeKey: 'main|1|assistant|-', text: '半截' }),
      message({ mergeKey: 'main|1|assistant|-', text: '完整正文' }),
    ]);
    expect(shapeOf(folded)).toEqual([[0, '完整正文']]);
  });

  it('段号缺席（老记录）与显式 0 是同一个键（首段只有一条）', () => {
    const folded = foldCandidateRecords([
      message({ mergeKey: 'main|1|assistant|-', text: '老记录' }),
      message({ mergeKey: 'main|1|assistant|-', segment: 0, text: '新记录' }),
    ]);
    expect(shapeOf(folded)).toEqual([[0, '新记录']]);
  });

  it('增量合并（SSE 那条路）同一条口径：先到的那一段不会被后来的覆盖', () => {
    const first = mergeCandidateRecords([], twoSegments.slice(0, 3));
    const merged = mergeCandidateRecords(first, twoSegments.slice(3));
    expect(shapeOf(merged)).toEqual([
      [0, '首段的第 1 轮'],
      [0, '首段的工具结果'],
      [0, '首段的第 2 轮'],
      [1, '再解释一遍'],
      [1, '追问那一段的第 1 轮'],
      [1, '追问那一段的工具结果'],
      [1, '追问那一段的第 2 轮'],
    ]);
  });
});
