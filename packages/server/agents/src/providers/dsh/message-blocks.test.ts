// @vitest-environment node
/**
 * dsh **`assistant/message` 的块位次**守卫：快照侧与旁路增量侧必须落在同一把尺子上。
 *
 * 尺子是「**第几个见过的块**」——两侧的实现方式不同，判据在同一条消息上：
 *   · 快照侧（`dshAssistantMessageDraft`）取块在 `content[]` 里的**下标**（空块、认不出的类型块
 *     同样占一格，因为厂商的装配器就是「one block per seen index」）；
 *   · 增量侧（`stream-tap.ts` 的 `positionOf`）给每个 `block-start` 发一个号。
 * 位次是**合并槽位的键**：两侧差一个号，同一段正文就落进两个槽位、界面上画两次，而两条都留在产物里。
 *
 * 为什么单测还不够：`content[]` 里到底会不会出现空块由**厂商装配器**决定（`blocks()` 不滤空、
 * 只有 `interruptedBlocks()` 那一支滤空白），假上游能造、单测只能假设。故真机那一条（同目录的
 * `block-index-real-path.test.ts`）钉的是「厂商确实把空块放进了 `content[]`」这个前提。
 */
import { describe, expect, it } from 'vitest';
import { dshAssistantMessageDraft } from './message';

/** 造一条 `assistant/message` 通知（只带块位次判据需要的那几格） */
function assistantMessage(content: readonly unknown[]): Record<string, unknown> {
  return {
    method: 'session.event',
    params: {
      sessionId: 'session-main',
      event: {
        type: 'assistant/message',
        data: { turn: 1, step: 1, message: { id: 'msg-blocks', content } },
      },
    },
  };
}

/** 块的槽位键（与 `applyBlock` 的 `identityKey` 同形：`i:<下标>` / `c:<调用 id>`） */
function slotKeys(content: readonly unknown[]): string[] {
  const draft = dshAssistantMessageDraft(assistantMessage(content), 'session-main', 1);
  return (draft?.blocks ?? []).map((block) =>
    block.identity.kind === 'index' ? `i:${block.identity.index}` : `c:${block.identity.callId}`);
}

describe('dsh 的块位次（快照侧）', () => {
  it('空文本块**占位次**：它后面的正文拿到 `content` 下标 1，不是「已产出块的个数」0', () => {
    expect(slotKeys([
      { type: 'text', text: '' },
      { type: 'text', text: '正文甲' },
    ])).toEqual(['i:1']);
  });

  it('认不出的类型块与空思考块同样占位次', () => {
    expect(slotKeys([
      { type: 'image', source: {} },
      { type: 'text', text: '正文甲' },
    ])).toEqual(['i:1']);
    // 思考块**照旧产出块**（`textKind: 'none'`），它占的是自己那一格
    expect(slotKeys([
      { type: 'reasoning', text: '' },
      { type: 'text', text: '正文甲' },
    ])).toEqual(['i:0', 'i:1']);
  });

  it('工具调用块用 `callId` 当槽位键（不占下标号），它后面的正文位次仍按 `content` 下标', () => {
    expect(slotKeys([
      { type: 'tool-call', id: 'call-1', name: 'bash', arguments: '{}' },
      { type: 'text', text: '正文甲' },
    ])).toEqual(['c:call-1', 'i:1']);
    expect(slotKeys([
      { type: 'text', text: '先说一句' },
      { type: 'tool-call', id: 'call-1', name: 'bash', arguments: '{}' },
    ])).toEqual(['i:0', 'c:call-1']);
  });

  it('空块 + 工具调用 + 正文：正文位次是 2（三格各占其一）', () => {
    expect(slotKeys([
      { type: 'text', text: '' },
      { type: 'tool-call', id: 'call-1', name: 'bash', arguments: '{}' },
      { type: 'text', text: '正文甲' },
    ])).toEqual(['c:call-1', 'i:2']);
  });
});
