// @vitest-environment node
/**
 * 人工消息的**传输形状**：条目、附件清单、四个动作的请求与响应。
 *
 * 三组判据各自的载重：
 *   · **形状闸门**（id 与附件清单）：`messageId` 是拼附件目录名的那一段，`..` / 分隔符 / 空串
 *     必须在这一格就断；附件清单里**没有字节数**——大小由取件那一刻现读，登记时那个数既可能过期
 *     也算不出来（多一格 `bytes` 就是第二份真相）。
 *   · **没有默认值**：`requires` / `attachments` 缺席一律 400。默认值会把「少传了一格」静默变成
 *     一个看起来合法的值，而 `requires` 默认成 `'idle'` 会让「立即发送」悄悄退化成「排队」。
 *   · **成功结局与错误结局分得开**：撤回的三个成功结局在 200 里回，`consumed` / `not-found` /
 *     厂商说不支持走错误响应，故它们**不在**这个 schema 的取值里。
 */
import { describe, expect, it } from 'vitest';
import { ATTACHMENT_MAX_PER_MESSAGE, AttachmentKindSchema } from './agent-message';
import {
  INJECT_RETRACT_OUTCOMES,
  InjectAttachmentSchema,
  InjectMessageIdSchema,
  InjectMessagePromoteAcceptedSchema,
  InjectMessageRetractAcceptedSchema,
  InjectMessageSchema,
  InjectMessageSendRequestSchema,
} from './inject-message';

/** 一条合法的登记请求（去掉哪一格就测哪一格） */
const send = {
  runId: 'run-1',
  candidateId: 'candidate-1',
  messageId: '0f5b6c1e-1a2b-4c3d-8e9f-0123456789ab',
  text: '先跑一遍测试',
  attachments: [],
  requires: 'idle' as const,
};

/** 一条合法的快照条目（三格时刻都有值，免得「抄漏一格」在用例里也被抄一遍） */
const entry = {
  messageId: 'm-1',
  text: '先跑一遍测试',
  attachments: [{ kind: 'image' as const, path: '/runs/r1/candidates/rw1/attachments/m-1/a.png', mimeType: 'image/png' }],
  requires: 'round' as const,
  state: 'delivered' as const,
  createdAt: '2026-09-22T10:30:00.000Z',
  deliveredAt: '2026-09-22T10:31:00.000Z',
  settledAt: null,
  outcome: null,
  reason: null,
};

describe('messageId 的形状（身份判据 + 拼路径的安全边界）', () => {
  it('收下前端生成的 uuid 与短 id', () => {
    expect(InjectMessageIdSchema.safeParse('0f5b6c1e-1a2b-4c3d-8e9f-0123456789ab').success).toBe(true);
    expect(InjectMessageIdSchema.safeParse('m-1').success).toBe(true);
    expect(InjectMessageIdSchema.safeParse('a').success).toBe(true);
  });

  it('拒掉空串、`..`、前导点、分隔符与超长：它们都是「拼出来的路径会跑到别处」的形态', () => {
    for (const bad of ['', '..', '.hidden', 'a/b', 'a\\b', '../x', 'a b', '-lead', 'a'.repeat(129)]) {
      expect(InjectMessageIdSchema.safeParse(bad).success, bad).toBe(false);
    }
    // 128 正好收下（边界值本身也是判据）
    expect(InjectMessageIdSchema.safeParse('a'.repeat(128)).success).toBe(true);
  });
});

describe('一条人工消息的形状', () => {
  it('逐格收下（含附件清单与三格时刻），并保留 null 的语义', () => {
    const parsed = InjectMessageSchema.parse(entry);
    expect(parsed).toEqual(entry);
    expect(parsed.settledAt).toBeNull();
    expect(parsed.outcome).toBeNull();
  });

  it('附件清单只有三格：没有字节数（大小在取件那一刻现读）', () => {
    expect(Object.keys(InjectAttachmentSchema.shape).sort()).toEqual(['kind', 'mimeType', 'path']);
    // 分档词表与账本里的附件块同源：多一档时两处一起变，不会出现「队列表说 file、账本说 image」
    expect([...AttachmentKindSchema.options]).toEqual(['image', 'file']);
  });

  it('四态与两档边界原样透出（词表由 inject-vocab 独占，这里不另立一套）', () => {
    expect(InjectMessageSchema.safeParse({ ...entry, state: 'gone', settledAt: '2026-09-22T10:32:00.000Z', outcome: 'timed-out', reason: '等太久了' }).success).toBe(true);
    // 词表外的取值一律拒掉；「四态与三格时刻的耦合」（如 queued ⇒ deliveredAt 为 null）**不在**这里管
    // ——那是队列表状态机的义务，形状层管它只会把合法的中间态误判成非法
    expect(InjectMessageSchema.safeParse({ ...entry, state: 'pending' }).success).toBe(false);
    expect(InjectMessageSchema.safeParse({ ...entry, requires: 'now' }).success).toBe(false);
  });
});

describe('登记请求：没有默认值，超限点名限制', () => {
  it('合法请求原样收下', () => {
    expect(InjectMessageSendRequestSchema.parse(send)).toEqual(send);
  });

  it('`requires` 缺席 ⇒ 400（不是静默变成「排队」：「立即发送」会悄悄退化）', () => {
    const { requires: _drop, ...withoutRequires } = send;
    expect(InjectMessageSendRequestSchema.safeParse(withoutRequires).success).toBe(false);
  });

  it('`attachments` 缺席 ⇒ 400（不是静默变成空清单：那份清单是模型能去读文件与否的唯一线索）', () => {
    const { attachments: _drop, ...withoutAttachments } = send;
    expect(InjectMessageSendRequestSchema.safeParse(withoutAttachments).success).toBe(false);
  });

  it(`超过 ${ATTACHMENT_MAX_PER_MESSAGE} 个附件 ⇒ 400，且原因点名是条数限制`, () => {
    const one = { kind: 'file' as const, path: '/abs/a.txt', mimeType: 'text/plain' };
    const overflow = { ...send, attachments: Array.from({ length: ATTACHMENT_MAX_PER_MESSAGE + 1 }, () => one) };
    const result = InjectMessageSendRequestSchema.safeParse(overflow);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain(String(ATTACHMENT_MAX_PER_MESSAGE));
    // 正好 10 个收下（边界值）
    expect(
      InjectMessageSendRequestSchema.safeParse({ ...send, attachments: Array.from({ length: ATTACHMENT_MAX_PER_MESSAGE }, () => one) }).success,
    ).toBe(true);
  });

  it('空消息 ⇒ 400；「只有附件没有正文」合法', () => {
    expect(InjectMessageSendRequestSchema.safeParse({ ...send, text: '' }).success).toBe(false);
    expect(InjectMessageSendRequestSchema.safeParse({ ...send, text: '   ' }).success).toBe(false);
    expect(
      InjectMessageSendRequestSchema.safeParse({ ...send, text: '', attachments: [{ kind: 'file', path: '/abs/a.txt', mimeType: null }] })
        .success,
    ).toBe(true);
  });
});

describe('撤回与改期的响应：成功结局与错误结局分得开', () => {
  it('撤回的三个成功结局都在 200 的形状里，撤不动的三档不在', () => {
    expect([...INJECT_RETRACT_OUTCOMES]).toEqual(['removed', 'retracted', 'already-retracted']);
    for (const outcome of INJECT_RETRACT_OUTCOMES) {
      expect(InjectMessageRetractAcceptedSchema.safeParse({ outcome, message: entry }).success, outcome).toBe(true);
    }
    for (const bad of ['consumed', 'not-found', 'unsupported', 'unknown']) {
      expect(InjectMessageRetractAcceptedSchema.safeParse({ outcome: bad, message: entry }).success, bad).toBe(false);
    }
  });

  it('改期只有两档成功结局：交出去之后改不了不属于这个形状', () => {
    expect(InjectMessagePromoteAcceptedSchema.safeParse({ outcome: 'promoted', message: entry }).success).toBe(true);
    expect(InjectMessagePromoteAcceptedSchema.safeParse({ outcome: 'already-round', message: entry }).success).toBe(true);
    expect(InjectMessagePromoteAcceptedSchema.safeParse({ outcome: 'not-queued', message: entry }).success).toBe(false);
    expect(InjectMessagePromoteAcceptedSchema.safeParse({ outcome: 'not-found', message: entry }).success).toBe(false);
  });
});
