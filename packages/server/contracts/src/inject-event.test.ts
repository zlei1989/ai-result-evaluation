// @vitest-environment node
/**
 * 人工消息那一面的**词表与候选级事件**：两档边界、四态、五个收场值，以及 `inject-message` 事件本身。
 *
 * 这一格存在的理由是**三处共用一份词表**（队列表的状态、消息账本的 `origin`、候选级事件三轴），
 * 故判据也钉在三件事上：
 *   1. 包根确实把这份词表导出成可枚举的值（消费方不必去深路径 import）；
 *   2. 边界词表**只有一份**——`agent-message` 转出的那一份与 `inject-vocab` 是真源同义
 *      （两份各写一遍枚举必然漂移，而漂移的表现是「同一档在两处叫两个名字」）；
 *   3. 事件的 `outcome` / `reason` **成对**：能落盘的三态必须带原因，不发生变化的
 *      `unsupported` / `unknown` 不在事件词表里（它们什么也没改变，落一条会说假话）。
 */
import { describe, expect, it } from 'vitest';
import { AgentEventSchema } from './agent-event';
import { InjectionBoundarySchema as BoundaryFromMessage } from './agent-message';
import {
  INJECT_DROP_REASONS,
  INJECT_MESSAGE_OUTCOMES,
  INJECT_MESSAGE_STATES,
  InjectMessageOutcomeSchema,
  InjectMessageStateSchema,
  InjectionBoundarySchema,
} from './inject-vocab';

/** 一条最小事件（`seq` / `at` 是公共字段） */
function injectEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    seq: 3,
    at: '2026-10-08T09:00:00.000Z',
    type: 'inject-message',
    messageId: 'm-1',
    requires: 'idle',
    outcome: 'delivered',
    reason: null,
    ...overrides,
  };
}

describe('词表：两档边界只有一份真源', () => {
  it('`agent-message` 转出的那一份与 `inject-vocab` 同值域', () => {
    expect([...BoundaryFromMessage.options]).toEqual([...InjectionBoundarySchema.options]);
    expect([...InjectionBoundarySchema.options]).toEqual(['round', 'idle']);
  });

  it('四态与五个收场值逐字固定（消费方按这些字面量分支）', () => {
    expect([...INJECT_MESSAGE_STATES]).toEqual(['queued', 'delivered', 'consumed', 'gone']);
    expect([...InjectMessageStateSchema.options]).toEqual([...INJECT_MESSAGE_STATES]);
    expect([...INJECT_MESSAGE_OUTCOMES]).toEqual([
      'delivered', 'retracted', 'already-consumed', 'discarded', 'timed-out',
    ]);
    // 「没有投出去」的两种收场单列一格：界面对它们说的是两句不同的话，服务端也要分开落原因
    expect([...INJECT_DROP_REASONS]).toEqual(['discarded', 'timed-out']);
  });

  it('撤回的 `unsupported` / `unknown` 不在事件词表里（那两种什么也没改变）', () => {
    expect(InjectMessageOutcomeSchema.safeParse('unsupported').success).toBe(false);
    expect(InjectMessageOutcomeSchema.safeParse('unknown').success).toBe(false);
  });
});

describe('inject-message 事件', () => {
  it('投递成功：两档都能落，`reason` 为 null', () => {
    const parsed = AgentEventSchema.parse(injectEvent({ requires: 'round' }));
    expect(parsed.type === 'inject-message' ? [parsed.messageId, parsed.requires, parsed.outcome, parsed.reason] : null)
      .toEqual(['m-1', 'round', 'delivered', null]);
  });

  it('丢弃与超时：必须带一句可直接展示的中文原因', () => {
    for (const outcome of ['discarded', 'timed-out', 'already-consumed'] as const) {
      const parsed = AgentEventSchema.parse(injectEvent({ outcome, reason: '这一条没能交给智能体' }));
      expect(parsed.type === 'inject-message' ? parsed.reason : null).toBe('这一条没能交给智能体');
    }
  });

  it('编造的取值被拒（状态与收场都是闭集：多一个档就是界面分不出的一句话）', () => {
    expect(AgentEventSchema.safeParse(injectEvent({ outcome: 'dropped' })).success).toBe(false);
    expect(AgentEventSchema.safeParse(injectEvent({ requires: 'turn' })).success).toBe(false);
    // `reason` 缺席同样被拒：schema 里它是必填的 `string | null`（不是可空格）——
    // 「这一态为什么发生」不许靠缺席表达，那会让读侧分不出「没有原因」与「没写原因」
    const withoutReason = injectEvent();
    delete withoutReason['reason'];
    expect(AgentEventSchema.safeParse(withoutReason).success).toBe(false);
  });
});
