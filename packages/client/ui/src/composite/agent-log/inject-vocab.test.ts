// @vitest-environment node
/**
 * 人工消息界面词表与派生判定的用例：**四态怎么显示、按钮能不能点、点了会怎样**。
 *
 * 判据全部来自契约形状与声明取值，与「哪一家今天填什么」无关——逐家取值由装配侧那条用例
 * （`apps/web-next/src/inject-declaration.test.ts`）钉住，这里只用代表性的声明字面量。
 */
import { describe, expect, it } from 'vitest';
import type { InjectAttachment, InjectMessage, TurnInjectionCapability } from '@aieval/contracts';
import {
  INJECT_QUEUE_HINT,
  INJECT_STATE_PRESENTATION,
  attachmentNameOf,
  deleteActionOf,
  deliveryAvailability,
  newInjectMessageId,
  pendingFromAttachment,
  promoteActionOf,
  refillDraftAttachments,
  refillDraftText,
  refillNoticeOf,
  visibleInjectMessages,
  type PendingInjectAttachment,
} from './inject-vocab';
import { INJECT_MESSAGE_ID_PATTERN } from '@aieval/contracts';

/** 一份合法声明；只改要考的那一格 */
function declarationOf(overrides: {
  delivery?: Partial<TurnInjectionCapability['delivery']>;
  retract?: Partial<TurnInjectionCapability['retract']>;
}): TurnInjectionCapability {
  const offByAdapter = { state: 'off-by-adapter' as const, reason: 'not-observed' as const, channel: 'wire' as const, gate: null, experimental: false, proofDriver: 'synthetic-fixture' as const, proofDriverReason: '夹具扮演厂商那一端（测试夹具，只为形状）' };
  return {
    delivery: { round: offByAdapter, idle: offByAdapter, ...overrides.delivery },
    retract: {
      round: { state: 'by-id', reason: '按身份撤' },
      idle: { state: 'by-id', reason: '按身份撤' },
      ...overrides.retract,
    },
    resume: offByAdapter,
    notes: [],
  };
}

const YES = { state: 'yes' as const, reason: null, channel: 'wire' as const, gate: null, experimental: false, proofDriver: 'real-path' as const, proofDriverReason: null };

/** 一条人工消息；只给要考的那几格 */
function messageOf(overrides: Partial<InjectMessage> = {}): InjectMessage {
  return {
    messageId: 'm-1',
    text: '顺便把 changelog 也补上',
    attachments: [],
    requires: 'idle',
    state: 'queued',
    createdAt: '2026-09-22T10:30:00.000Z',
    deliveredAt: null,
    settledAt: null,
    outcome: null,
    reason: null,
    ...overrides,
  };
}

const ATTACHMENT: InjectAttachment = { kind: 'file', path: '/tmp/a.md', mimeType: 'text/markdown' };

describe('visibleInjectMessages：gone 跳过、其余原样保留', () => {
  it('`gone` 不进队列区（它留在表里只为幂等，不是为了被画成一个还在等的人话）', () => {
    const queued = messageOf({ messageId: 'a', state: 'queued' });
    const gone = messageOf({ messageId: 'b', state: 'gone', outcome: 'timed-out', reason: '等太久了' });
    const delivered = messageOf({ messageId: 'c', state: 'delivered', deliveredAt: '2026-09-22T10:31:00.000Z' });
    expect(visibleInjectMessages([queued, gone, delivered]).map((item) => item.messageId)).toEqual(['a', 'c']);
  });

  it('`consumed` 与 `delivered` 照旧显示（它们是「还在队列里、只是撤不回来」）', () => {
    const consumed = messageOf({ messageId: 'x', state: 'consumed', reason: '已交给模型' });
    expect(visibleInjectMessages([consumed])).toHaveLength(1);
  });

  it('空队列给空数组（不是 undefined）', () => {
    expect(visibleInjectMessages([])).toEqual([]);
  });
});

describe('四态的文案：`queued` 必须容得下那段延迟', () => {
  it('四态各有一句话，且互不相同', () => {
    const labels = Object.values(INJECT_STATE_PRESENTATION).map((entry) => entry.note);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('`queued` 不写成「已送达」：明说取件在下一次通知边界、且排队那一档要等本轮收完', () => {
    const note = INJECT_STATE_PRESENTATION.queued.note;
    expect(note).toContain('通知');
    expect(note).toContain('本轮');
    expect(note).not.toContain('已送到');
  });

  it('`consumed` 说的是「撤不回来」，`delivered` 说的是「还没被读」', () => {
    expect(INJECT_STATE_PRESENTATION.consumed.note).toContain('撤不回来');
    expect(INJECT_STATE_PRESENTATION.delivered.note).toContain('还没');
  });
});

describe('deliveryAvailability：由声明决定这一档能不能投', () => {
  it('声明说 `yes` ⇒ 可用、没有话要说', () => {
    expect(deliveryAvailability(declarationOf({ delivery: { idle: YES } }), 'idle')).toEqual({
      available: true,
      note: null,
    });
  });

  it('声明缺席（null）⇒ 不可用，且说的是「读不到声明」，不是「这家不支持」', () => {
    const idle = deliveryAvailability(null, 'idle');
    expect(idle.available).toBe(false);
    expect(idle.note).toContain('声明');
    expect(idle.note).not.toContain('结构上不支持');
  });

  it('`no` / `not-projected-by-vendor` / `off-by-adapter` / `unverified` 四句互不相同', () => {
    const notes = [
      deliveryAvailability(declarationOf({ delivery: { idle: { ...YES, state: 'no', reason: 'not-supported' } } }), 'idle'),
      deliveryAvailability(
        declarationOf({ delivery: { idle: { ...YES, state: 'not-projected-by-vendor', reason: 'not-exposed' } } }),
        'idle',
      ),
      deliveryAvailability(declarationOf({ delivery: { idle: { ...YES, state: 'off-by-adapter', reason: 'not-observed' } } }), 'idle'),
      deliveryAvailability(declarationOf({ delivery: { idle: { ...YES, state: 'unverified', reason: 'unverified' } } }), 'idle'),
    ].map((entry) => entry.note);
    expect(notes.every((note) => note !== null)).toBe(true);
    expect(new Set(notes).size).toBe(4);
  });

  it('「这家结构上没有」与「厂商有、我们还没接」不合成一句', () => {
    const no = deliveryAvailability(declarationOf({ delivery: { idle: { ...YES, state: 'no', reason: 'not-supported' } } }), 'idle');
    const off = deliveryAvailability(
      declarationOf({ delivery: { idle: { ...YES, state: 'off-by-adapter', reason: 'not-observed' } } }),
      'idle',
    );
    expect(no.note).toContain('不支持');
    expect(off.note).toContain('还没接');
    expect(no.note).not.toBe(off.note);
  });

  it('缺席与「没验证过」也要是两句不同的话', () => {
    const absent = deliveryAvailability(null, 'idle');
    const unverified = deliveryAvailability(
      declarationOf({ delivery: { idle: { ...YES, state: 'unverified', reason: 'unverified' } } }),
      'idle',
    );
    expect(absent.note).not.toBe(unverified.note);
  });

  /**
   * **`unverified` 单开一句模板**（与另三态不同）：「没验证过」说的是**我们不敢保证**，
   * 不是「已经确认不行」——套进「投不进去：」会被读成后者，与词表把它与 `no` 分开的用意相反。
   * 判据钉在**模板前缀**上：只把 `reason` 换掉是换不出这个区别的。
   */
  it('`unverified` 说的是「还不能用」，不是「投不进去」', () => {
    const unverified = deliveryAvailability(
      declarationOf({ delivery: { idle: { ...YES, state: 'unverified', reason: 'unverified' } } }),
      'idle',
    );
    expect(unverified.available).toBe(false);
    expect(unverified.note).toContain('还不能用');
    expect(unverified.note).not.toContain('投不进去');
    expect(unverified.note).toContain('没验证过');
    // 「立即发送」那一档走同一个模板（两档不各说一套）
    expect(deliveryAvailability(declarationOf({ delivery: { round: { ...YES, state: 'unverified', reason: 'unverified' } } }), 'round').note)
      .toContain('还不能用');
  });

  it('另三态仍是「投不进去」那句断言（`unverified` 只改自己那一支）', () => {
    for (const [state, reason] of [
      ['no', 'not-supported'],
      ['not-projected-by-vendor', 'not-exposed'],
      ['off-by-adapter', 'not-observed'],
    ] as const) {
      const cell = { ...YES, state, reason };
      expect(deliveryAvailability(declarationOf({ delivery: { idle: cell } }), 'idle').note, state)
        .toContain('投不进去');
    }
  });

  it('两档各读自己那一格：idle 可用不代表 round 可用', () => {
    const declaration = declarationOf({ delivery: { idle: YES } });
    expect(deliveryAvailability(declaration, 'idle').available).toBe(true);
    expect(deliveryAvailability(declaration, 'round').available).toBe(false);
  });

  it('那句人话点明是哪一档投不进去（两档不会给出同一句话）', () => {
    const declaration = declarationOf({ delivery: { idle: YES } });
    expect(deliveryAvailability(declaration, 'round').note).toContain('立即发送');
  });
});

describe('deleteActionOf：「删除」是双态动作', () => {
  it('`queued` ⇒ 直接摘掉，可点', () => {
    const action = deleteActionOf(messageOf({ state: 'queued' }), null);
    expect(action.enabled).toBe(true);
    expect(action.tooltip).toContain('摘');
  });

  it('`consumed` ⇒ 任何时候都禁用，并明说撤不回来（不看声明）', () => {
    for (const declaration of [null, declarationOf({ retract: { idle: { state: 'by-id', reason: '按身份撤' } } })]) {
      const action = deleteActionOf(messageOf({ state: 'consumed', reason: '已经交给模型了' }), declaration);
      expect(action.enabled).toBe(false);
      expect(action.tooltip).toContain('撤不回来');
    }
  });

  it('`delivered` + `by-id` ⇒ 可撤，且 tooltip 带上这一家的判据', () => {
    const action = deleteActionOf(
      messageOf({ state: 'delivered', deliveredAt: '2026-09-22T10:31:00.000Z' }),
      declarationOf({ retract: { idle: { state: 'by-id', reason: '按我们自铸的 uuid' } } }),
    );
    expect(action.enabled).toBe(true);
    expect(action.tooltip).toContain('按我们自铸的 uuid');
  });

  it('`delivered` + `flush-only` ⇒ 禁用，如实说「只能整条清空」', () => {
    const action = deleteActionOf(
      messageOf({ state: 'delivered', deliveredAt: '2026-09-22T10:31:00.000Z' }),
      declarationOf({ retract: { idle: { state: 'flush-only', reason: '只有 clearQueue()' } } }),
    );
    expect(action.enabled).toBe(false);
    expect(action.tooltip).toContain('整条');
    expect(action.tooltip).toContain('只有 clearQueue()');
  });

  it('`delivered` + `none` ⇒ 禁用，说的是「这一家撤不回已交出去的消息」', () => {
    const action = deleteActionOf(
      messageOf({ state: 'delivered', deliveredAt: '2026-09-22T10:31:00.000Z' }),
      declarationOf({ retract: { idle: { state: 'none', reason: '在途注入没有撤回面' } } }),
    );
    expect(action.enabled).toBe(false);
    expect(action.tooltip).toContain('撤不回');
    expect(action.tooltip).toContain('在途注入没有撤回面');
  });

  it('`delivered` + `unverified` ⇒ 允许试，但 tooltip 先如实说「没验证过」', () => {
    const action = deleteActionOf(
      messageOf({ state: 'delivered', deliveredAt: '2026-09-22T10:31:00.000Z' }),
      declarationOf({ retract: { idle: { state: 'unverified', reason: '没跑过真路径' } } }),
    );
    expect(action.enabled).toBe(true);
    expect(action.tooltip).toContain('没验证过');
  });

  it('`delivered` 而声明缺席 ⇒ 禁用，且与四档里任何一句都不同（「读不到声明」是第五件事）', () => {
    const action = deleteActionOf(messageOf({ state: 'delivered', deliveredAt: '2026-09-22T10:31:00.000Z' }), null);
    expect(action.enabled).toBe(false);
    expect(action.tooltip).toContain('声明');
  });

  it('`delivered` 的两档撤回能力各读自己那一格（idle 能撤不代表 round 能撤）', () => {
    const declaration = declarationOf({
      retract: { round: { state: 'none', reason: '在途注入没有撤回面' } },
    });
    expect(deleteActionOf(messageOf({ state: 'delivered', deliveredAt: '2026-09-22T10:31:00.000Z', requires: 'round' }), declaration).enabled).toBe(false);
    expect(deleteActionOf(messageOf({ state: 'delivered', deliveredAt: '2026-09-22T10:31:00.000Z', requires: 'idle' }), declaration).enabled).toBe(true);
  });
});

describe('promoteActionOf：「立即发送」只对「还在排队且要求排队」的那一条可用', () => {
  it('`queued` + `requires: idle` + round 档可用 ⇒ 可点', () => {
    const action = promoteActionOf(
      messageOf({ state: 'queued', requires: 'idle' }),
      declarationOf({ delivery: { round: YES } }),
    );
    expect(action.enabled).toBe(true);
  });

  it('`queued` 但本来就要求立即发送 ⇒ 禁用（重复点同一颗按钮不该再发一次）', () => {
    const action = promoteActionOf(
      messageOf({ state: 'queued', requires: 'round' }),
      declarationOf({ delivery: { round: YES } }),
    );
    expect(action.enabled).toBe(false);
    expect(action.tooltip).toContain('本来');
  });

  it('已经交出去 / 已被读到 ⇒ 禁用：边界已经用掉了', () => {
    for (const state of ['delivered', 'consumed'] as const) {
      const action = promoteActionOf(messageOf({ state, deliveredAt: '2026-09-22T10:31:00.000Z' }), declarationOf({ delivery: { round: YES } }));
      expect(action.enabled).toBe(false);
      expect(action.tooltip).toContain('用掉');
    }
  });

  it('这一家的「立即发送」档投不进去 ⇒ 禁用，并给出那一档自己的那句话', () => {
    const declaration = declarationOf({
      delivery: { round: { ...YES, state: 'off-by-adapter', reason: 'not-observed' } },
    });
    const action = promoteActionOf(messageOf({ state: 'queued', requires: 'idle' }), declaration);
    expect(action.enabled).toBe(false);
    expect(action.tooltip).toContain('立即发送');
    expect(action.tooltip).toContain('还没接');
  });
});

describe('refillNoticeOf：回填时那句一次性提示', () => {
  it('交出去过的（`deliveredAt` 非 null）⇒ 给提示，说清重发会变成两条', () => {
    const notice = refillNoticeOf(messageOf({ state: 'gone', outcome: 'retracted', deliveredAt: '2026-09-22T10:31:00.000Z' }));
    expect(notice).toContain('已经交给过');
    expect(notice).toContain('两条');
  });

  it('从没投出去过的（`deliveredAt` 为 null）⇒ 不给提示（它还没到过模型手上）', () => {
    expect(refillNoticeOf(messageOf({ state: 'queued', deliveredAt: null }))).toBeNull();
  });

  it('按 `deliveredAt` 判而不是按 `state`：撤回成功后条目是 `gone`，但它确实到过厂商手里', () => {
    expect(refillNoticeOf(messageOf({ state: 'gone', deliveredAt: '2026-09-22T10:31:00.000Z' }))).not.toBeNull();
  });
});

describe('附件清单在界面上只数条数（字节数与大小都由服务端在取件那刻现读）', () => {
  it('附件跟着消息一起来，界面不改写它', () => {
    const message = messageOf({ attachments: [ATTACHMENT] });
    expect(message.attachments).toHaveLength(1);
    expect(message.attachments[0]?.path).toBe('/tmp/a.md');
  });
});

describe('回填（「删除」把内容还回输入框）', () => {
  it('正文补在现有草稿**前面**、用一个换行隔开（用户原话）', () => {
    expect(refillDraftText('我刚写了一半', '还回来的这句')).toBe('还回来的这句\n我刚写了一半');
  });

  it('草稿是空的（或只有空白）⇒ 不加前导换行', () => {
    expect(refillDraftText('', '还回来的这句')).toBe('还回来的这句');
    expect(refillDraftText('   ', '还回来的这句')).toBe('还回来的这句');
  });

  it('★ 附件跟着一起回填（只回正文会静默丢文件）', () => {
    const message = messageOf({ state: 'gone', attachments: [ATTACHMENT] });
    const next = refillDraftAttachments([], message);
    expect(next).toHaveLength(1);
    expect(next[0]?.path).toBe('/tmp/a.md');
    expect(next[0]?.mimeType).toBe('text/markdown');
    // 回填回来的附件本来就在盘上 ⇒ 直接是「已落盘」，不该卡在 uploading
    expect(next[0]?.status).toBe('done');
  });

  it('回填的正文与附件是**同一份口径**：两者一起决定「框里的内容与撤回前一致」', () => {
    const message = messageOf({ state: 'gone', text: '原话', attachments: [ATTACHMENT] });
    const draft = refillDraftText('', message.text);
    const pending = refillDraftAttachments([], message);
    expect(draft).toBe('原话');
    expect(pending.map((item) => item.path)).toEqual(['/tmp/a.md']);
  });

  it('草稿里已经有别的附件时，回填的排在前面且不重复', () => {
    const existing: PendingInjectAttachment[] = [
      { uid: 'u-1', name: 'b.md', status: 'done', path: '/tmp/b.md', mimeType: null },
    ];
    const message = messageOf({ state: 'gone', attachments: [ATTACHMENT] });
    const once = refillDraftAttachments(existing, message);
    expect(once.map((item) => item.path)).toEqual(['/tmp/a.md', '/tmp/b.md']);
    // 同一条消息再撤一次（幂等回 already-retracted）不该变成两份
    expect(refillDraftAttachments(once, message).map((item) => item.path)).toEqual(['/tmp/a.md', '/tmp/b.md']);
  });

  it('附件显示名取路径最后一段；拿不到路径时给一句兜底（不留半句话）', () => {
    expect(attachmentNameOf('/tmp/row/attachments/m-1/说明.md')).toBe('说明.md');
    expect(pendingFromAttachment({ kind: 'file', path: null, mimeType: null }, 'u-1').name).toBe('附件');
  });

  it('铸出来的消息 id 必须是契约允许的形状（它同时是幂等键与附件目录名）', () => {
    const id = newInjectMessageId();
    expect(INJECT_MESSAGE_ID_PATTERN.test(id)).toBe(true);
    expect(newInjectMessageId()).not.toBe(id);
  });
});

describe('常驻提示：发出去不等于立刻到', () => {
  it('点明取件在下一次通知边界、且排队那一档要等本轮收完', () => {
    expect(INJECT_QUEUE_HINT).toContain('通知');
    expect(INJECT_QUEUE_HINT).toContain('本轮');
    expect(INJECT_QUEUE_HINT).toContain('立刻');
  });
});
