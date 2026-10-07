// @vitest-environment node
/**
 * **同一批原始消息喂给「事件投影 + 消息归一」两条通道时，消息侧必须照常产出。**
 *
 * 这个文件守的是一个真实缺陷（2026-10-03 真机）：`createClaudeMessageNormalizer` 一度与事件投影
 * **共用 `state.seen`**，而 `project()` 总是先跑事件投影（它把 `uuid` 记进去）、再跑消息归一 ——
 * 于是每一条 `assistant` / `user` 消息都在消息侧被当成「重复投递」丢掉：
 * `messages.jsonl` 一行都不写、抽屉里永远显示「还没有日志 · 这一行还没开始执行」，
 * 而 `events.jsonl` 里内容齐全。**两条通道各测各的都不会红**，只有把同一批输入同时喂给两条通道才看得见。
 */
import { describe, expect, it } from 'vitest';
import { createClaudeMessageNormalizer } from './message';
import { projectClaudeMessage } from './events';
import type { TurnState } from '../../turn';

/** 一份空状态：两条通道都只读/写这几格（`seen` 是这条守卫的靶子） */
function state(): TurnState {
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

/** 真机 SDK 消息的最小形状（`uuid` + `message.content[]`） */
function assistantMessage(uuid: string, messageId: string, text: string): unknown {
  return {
    type: 'assistant',
    uuid,
    parent_tool_use_id: null,
    session_id: 's-1',
    message: { id: messageId, type: 'message', role: 'assistant', content: [{ type: 'text', text }] },
  };
}

describe('claude-code：事件与消息两条通道互不吞掉对方', () => {
  it('先跑事件投影、再跑消息归一，消息仍然产得出来（共用 `state.seen` 时会全被丢掉）', () => {
    const turnState = state();
    const normalizer = createClaudeMessageNormalizer();
    const raw = assistantMessage('u-1', 'msg-1', '你好');

    // 顺序与 `index.ts` 的 `project()` 逐字相同：事件在前、消息在后
    projectClaudeMessage(raw, turnState, { kind: 'claude-code', baseUrl: 'http://x' });
    const output = normalizer.normalize(raw, turnState);

    expect(turnState.seen.has('u-1'), '事件侧应当记下这一条的去重键').toBe(true);
    expect(output.messages, '消息侧被事件侧的去重表吞掉了').toHaveLength(1);
    expect(output.messages[0]?.blocks[0]?.block).toMatchObject({ type: 'text', text: '你好' });
  });

  it('同一条消息重复投递时，消息侧**自己**去重（不产出第二条）', () => {
    const turnState = state();
    const normalizer = createClaudeMessageNormalizer();
    const raw = assistantMessage('u-2', 'msg-2', '你好');

    normalizer.normalize(raw, turnState);
    const second = normalizer.normalize(raw, turnState);
    expect(second.messages).toEqual([]);
  });

  it('流式增量与快照共享同一批块序号（消息侧的状态不依赖事件侧）', () => {
    const turnState = state();
    const normalizer = createClaudeMessageNormalizer();
    normalizer.normalize(
      { type: 'stream_event', event: { type: 'message_start', message: { id: 'msg-3' } } },
      turnState,
    );
    const output = normalizer.normalize(assistantMessage('u-3', 'msg-3', '正文'), turnState);
    expect(output.messages).toHaveLength(1);
    expect(output.messages[0]?.chunk).toBe('snapshot');
  });
});