// @vitest-environment node
/**
 * 测试结果的**数据层只读投影**：从已落盘的消息账本里认出测试命令与它的输出，
 * 产出排名页要的三态（采集到 / 未采集 / 解析失败）。
 *
 * 这里刻意**不读事件台账**：事件里只有 `log` 原文，没有工具调用与结果的配对；
 * 投影只消费 `messages`（`tool-call` + `tool-result`），因此不需要改事件形状，也不写任何文件。
 */
import { describe, expect, it } from 'vitest';
import {
  visibleMessages,
  withoutVoidedTotals,
  type AgentMessage,
  type CheckpointVoid,
} from '@aieval/contracts';
import { projectRowTestSummary } from './run-test-results';

const OUTPUT = ` RUN  v4.1.11 /repo

 ✓ src/x.test.ts > 数学 > 加法通过 1ms
 × src/x.test.ts > 数学 > 减法失败 2ms

 Test Files  1 failed (1)
      Tests  1 failed | 1 passed (2)
   Start at  16:39:40
   Duration  70ms`;

function message(blocks: AgentMessage['blocks']): AgentMessage {
  return {
    messageId: `m-${Math.random()}`,
    vendorId: null,
    role: 'assistant',
    source: 'wire',
    origin: 'case-prompt',
    roundTrip: 1,
    turn: null,
    step: null,
    parentCallId: null,
    subagentId: null,
    chunk: 'snapshot',
    assembly: 'snapshot',
    mergeKey: 'main|1|assistant|-',
    blocks,
    raw: null,
  };
}

function call(callId: string, command: string): AgentMessage['blocks'][number] {
  return {
    type: 'tool-call',
    callId,
    family: 'run-shell',
    name: 'Bash',
    input: { command },
    payload: null,
    summary: command,
  };
}

function result(callId: string, text: string, truncated = false): AgentMessage['blocks'][number] {
  return {
    type: 'tool-result',
    callId,
    isError: false,
    text,
    structured: null,
    truncation: truncated ? { kind: 'truncated', reason: '输出超过上限' } : { kind: 'none' },
  };
}

describe('projectRowTestSummary', () => {
  it('配对 tool-call 与 tool-result 后解析出计数（不读事件台账）', () => {
    const summary = projectRowTestSummary('row-1', [
      message([call('c1', 'pnpm test')]),
      message([result('c1', OUTPUT)]),
    ]);
    expect(summary).toMatchObject({
      rowId: 'row-1',
      status: 'collected',
      framework: 'pnpm',
      command: 'pnpm test',
      passed: 1,
      failed: 1,
      skipped: 0,
      total: 2,
    });
  });

  it('没有测试命令 ⇒ not-collected（不是 0 通过）', () => {
    expect(
      projectRowTestSummary('row-1', [message([call('c1', 'ls -la')]), message([result('c1', 'a.txt')])]),
    ).toEqual({ rowId: 'row-1', status: 'not-collected' });
  });

  it('输出被截断 ⇒ unparsed（不在残缺文本上算通过率）', () => {
    const summary = projectRowTestSummary('row-1', [
      message([call('c1', 'pnpm test')]),
      message([result('c1', OUTPUT, true)]),
    ]);
    expect(summary.status).toBe('unparsed');
    if (summary.status !== 'unparsed') throw new Error('期望 unparsed');
    expect(summary.reason).toContain('截断');
    expect('passed' in summary).toBe(false);
  });

  it('同一行跑了多次测试 ⇒ 取最后一次可配对的调用（最新事实，不把历史加总）', () => {
    const summary = projectRowTestSummary('row-1', [
      message([call('c1', 'pnpm test'), result('c1', OUTPUT)]),
      message([call('c2', 'pnpm test'), result('c2', OUTPUT)]),
    ]);
    expect(summary).toMatchObject({ status: 'collected', total: 2 });
  });
});

/**
 * **作废段默认跳过**（回到某一轮之后）：轮次计数、用量与排名页的通过率都不含作废段。
 *
 * 三条判据各自走**生产读侧的那一个函数**（不是本文件另写一套）：
 *   · 历史/轮次：`visibleMessages`（api 的 `getRowRecords` 就是它）；
 *   · 用量/轮次合计：`withoutVoidedTotals`（api 的读侧投影）；
 *   · 排名：`projectRowTestSummary` 吃过滤后的消息——作废段里那次失败不再算通过率。
 */
describe('作废段在读侧默认跳过', () => {
  /** 一条消息补上轮次/段号那两格（其余字段复用本文件的 `message` 构造） */
  function messageIn(segment: number, roundTrip: number, blocks: AgentMessage['blocks']): AgentMessage {
    return {
      ...message(blocks),
      segment,
      roundTrip,
      messageId: `m-${segment}-${roundTrip}-${Math.random()}`,
      mergeKey: `main|${roundTrip}|assistant|-`,
    };
  }

  /** 回到第 0 段第 2 轮：第 3 轮与其后的第 1 段整体作废 */
  const voided: CheckpointVoid = {
    checkpointId: 'cp-1',
    segment: 0,
    turn: 2,
    throughSegment: 1,
    at: '2026-10-19T00:00:00.000Z',
    tokens: { input: 200, cached: 0, output: 20 },
    turns: 1,
  };

  const kept = messageIn(0, 1, [call('c-keep', 'ls')]);
  const voidedTail = messageIn(0, 3, [call('c-tail', 'pnpm test'), result('c-tail', OUTPUT)]);
  const voidedSegment = messageIn(1, 1, [call('c-seg', 'pnpm test'), result('c-seg', OUTPUT)]);

  it('轮次计数与历史都不含作废段', () => {
    const visible = visibleMessages([kept, voidedTail, voidedSegment], [voided]);
    expect(visible).toEqual([kept]);
    // 「轮次 = 一次模型往返」：可见的主会话往返只有第 1 轮
    expect(new Set(visible.map((one) => one.roundTrip)).size).toBe(1);
  });

  it('用量与轮次合计扣掉作废那一截（行快照仍是历史真相）', () => {
    const total = withoutVoidedTotals({ tokens: { input: 500, cached: 10, output: 50 }, turns: 4 }, [voided]);
    expect(total).toEqual({ tokens: { input: 300, cached: 10, output: 30 }, turns: 3 });
  });

  it('排名页的通过率不含作废段里那次测试', () => {
    const visible = visibleMessages([kept, voidedTail, voidedSegment], [voided]);
    // 作废段里那次「1 失败 1 通过」不再参与：可见段里根本没有测试命令
    expect(projectRowTestSummary('row-1', visible)).toEqual({ rowId: 'row-1', status: 'not-collected' });
    // 对照组：不滤的话排名页会拿到那一份失败
    expect(projectRowTestSummary('row-1', [kept, voidedTail, voidedSegment])).toMatchObject({
      status: 'collected',
      failed: 1,
    });
  });
});
