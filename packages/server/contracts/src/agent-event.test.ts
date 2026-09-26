// @vitest-environment node
/**
 * 事件契约：七个成员的判别联合、类型清单、以及两条最容易漏的字段约束。
 * 注意：`seq` 从 1 开始单调递增（由 core 的事件日志写入器分配），`at` 是 ISO 8601 字符串——
 * 这两条决定了 SSE 的 `Last-Event-ID` 续订能不能工作。
 * 另有一条守卫是实施时补上的（见对应 it 内注释）：`seq` 的「正整数」约束原先没有断言，
 * 把 `.int().positive()` 删掉也能全绿；`at` 则刻意只声明为 `z.string()`
 * （ISO 8601 由写入方保证，契约层不做日期校验），故它没有可变异体。
 */
import { describe, expect, it } from 'vitest';
import { AGENT_EVENT_TYPES, AgentEventSchema } from './agent-event';

const base = { seq: 1, at: '2026-09-22T10:30:00.000Z' };

describe('AgentEventSchema', () => {
  it('接受 spec §7.4 的七个成员', () => {
    const events = [
      { ...base, type: 'status', status: 'running' },
      { ...base, type: 'log', stream: 'stdout', text: '开始执行' },
      { ...base, type: 'usage', tokens: { input: 10, cached: 2, output: 3 }, turns: 1 },
      { ...base, type: 'diff-summary', filesChanged: 2, insertions: 12, deletions: 3, truncated: false },
      {
        ...base,
        type: 'score',
        score: {
          judgments: [
            { id: 'A1', achieved: true, reason: '字段进了契约' },
            { id: 'D1', achieved: false, reason: '没补用例' },
          ],
          totalScore: 18,
          maxScore: 32,
          verdict: '完成度高',
          raw: '{}',
          judgeProviderId: 'p-1',
          judgeModelId: 'deepseek-chat',
          judgedAt: '2026-09-22T10:30:00.000Z',
        },
      },
      { ...base, type: 'error', message: 'CLI 未安装' },
      { ...base, type: 'end', exitReason: 'completed' },
    ];
    for (const event of events) {
      expect(AgentEventSchema.safeParse(event).success).toBe(true);
    }
  });

  it('拒绝未识别的 type（日志格式必须由本项目定义，不随厂商漂移）', () => {
    expect(AgentEventSchema.safeParse({ ...base, type: 'tool-call', name: 'read' }).success).toBe(false);
  });

  it('拒绝缺字段的成员：log 缺 stream、usage 缺 turns、end 缺 exitReason', () => {
    expect(AgentEventSchema.safeParse({ ...base, type: 'log', text: 'x' }).success).toBe(false);
    expect(AgentEventSchema.safeParse({ ...base, type: 'usage', tokens: { input: 1, cached: 0, output: 0 } }).success).toBe(false);
    expect(AgentEventSchema.safeParse({ ...base, type: 'end' }).success).toBe(false);
  });

  /**
   * `log.summary` 是**可选**的「人话摘要」（2026-09-29，卡片底部的活动行显示它）。
   * 两个方向都要钉住，各自有靶子：
   *   ① **老日志必须照样解析**——磁盘上已有的行没有这一格，写成必填会让所有历史行在回放 /
   *      SSE 续订时解析失败（那是最难查的一类静默失败：日志在抽屉里成片消失）；
   *   ② 带上它时**原样保留**——被 schema 悄悄 strip 掉的话，适配器那句人话永远到不了界面，
   *      而所有用例（都是直接构造事件、不过 schema）照样全绿。
   */
  it('log 的 summary 可选：老日志（没有这一格）照样解析，新日志带上它也不丢', () => {
    const raw = { ...base, type: 'log', stream: 'stdout', text: '{"method":"session.event"}' };
    expect(AgentEventSchema.safeParse(raw).success).toBe(true);

    const parsed = AgentEventSchema.safeParse({ ...raw, summary: '调用 pwsh：npm run build-only' });
    expect(parsed.success).toBe(true);
    expect(parsed.success ? parsed.data : null).toMatchObject({ summary: '调用 pwsh：npm run build-only' });
  });

  it('usage 的计量是三个数字（缺失计量时适配器根本不该发这条事件，而不是发 0）', () => {
    expect(
      AgentEventSchema.safeParse({ ...base, type: 'usage', tokens: { input: 1, cached: 0, output: 2 }, turns: 3 }).success,
    ).toBe(true);
    expect(
      AgentEventSchema.safeParse({ ...base, type: 'usage', tokens: { input: '1', cached: 0, output: 2 }, turns: 3 }).success,
    ).toBe(false);
  });

  // 2026-09-28 用户口径：轮次（一次模型 API 往返算一次）必须能**独立于 token** 上报。
  // 实测缺口：原来 tokens 必填 ⇒ claude-code 那一轮的 token 采不到，整轮只发得出一条
  // `usage`（`turns: 1, tokens: {0,0,0}`），界面永远停在「轮次 1」。
  it('usage 允许 tokens 为 null（轮次独立上报），但 turns 仍然必填', () => {
    const turnsOnly = { ...base, type: 'usage', tokens: null, turns: 7 };
    expect(AgentEventSchema.safeParse(turnsOnly).success).toBe(true);
    // turns 是这条事件存在的理由，缺了它这条事件没有任何信息 ⇒ 必须拒
    expect(AgentEventSchema.safeParse({ ...base, type: 'usage', tokens: null }).success).toBe(false);
    expect(AgentEventSchema.safeParse({ ...base, type: 'usage', turns: 1 }).success).toBe(false);
  });

  /**
   * 计量与时间的**新增格**（2026-10-XX：tok/s 与缓存命中率的原料）。
   *
   * 这一组守卫的共同靶子是**老日志的向后兼容**：磁盘上已有的 `usage` 事件既没有 `timing`
   * 也没有那两个可选格，schema 若把它们写成必填，所有历史事件在回放 / SSE 续订时会解析失败
   * （表现是「日志在抽屉里成片消失」，最难查的一类静默失败）。
   * ⚠️ 注意 `timing` 在**契约层面也是可选的**（`timing?: … | null`）：三方适配器一定会发它
   * （草稿层必填），但契约必须容得下历史行与「另一端的旧版本」。
   */
  it('usage 的时间格可空、整格可缺（老日志没有它也必须能解析）', () => {
    // ① 整格缺席（历史行）：必须过
    expect(
      AgentEventSchema.safeParse({ ...base, type: 'usage', tokens: { input: 1, cached: 0, output: 2 }, turns: 3 }).success,
    ).toBe(true);
    // ② 显式 null（这一次没采到时间）：必须过，且是「未采集」的唯一写法
    const missing = AgentEventSchema.safeParse({
      ...base,
      type: 'usage',
      tokens: null,
      timing: null,
      turns: 3,
    });
    expect(missing.success).toBe(true);
    expect(missing.success ? missing.data : null).toMatchObject({ timing: null });
    // ③ 三格齐全 + 来源（厂商自报）：原样保留
    const vendor = AgentEventSchema.safeParse({
      ...base,
      type: 'usage',
      tokens: null,
      timing: { totalMs: 166_712, apiMs: 158_753, ttftMs: 7_558, source: 'vendor' },
      turns: 3,
    });
    expect(vendor.success).toBe(true);
    expect(vendor.success ? vendor.data : null).toMatchObject({
      timing: { totalMs: 166_712, apiMs: 158_753, ttftMs: 7_558, source: 'vendor' },
    });
    // ④ `source` 是判别「这个时长能不能与另一家比」的那一格 ⇒ 取值必须封闭
    expect(
      AgentEventSchema.safeParse({
        ...base,
        type: 'usage',
        tokens: null,
        timing: { totalMs: 1, apiMs: null, ttftMs: null, source: 'wall-clock' },
        turns: 1,
      }).success,
    ).toBe(false);
    // ⑤ 时长不是数字 ⇒ 拒（`null` 才是「没采到」，`'1000'` 这种形状不该被接受）
    expect(
      AgentEventSchema.safeParse({
        ...base,
        type: 'usage',
        tokens: null,
        timing: { totalMs: '1000', apiMs: null, ttftMs: null, source: 'events' },
        turns: 1,
      }).success,
    ).toBe(false);
  });

  /**
   * 两个可选格（`reasoningOutput` / `total`）的取值空间：**数字或 `null`，不许缺席成 `undefined` 以外的别的东西**。
   * 为什么 `null` 必须合法：契约的硬口径是「采不到一律 null，绝不填 0」——
   * 若 schema 只收 `number`，适配器就会被迫在「不填」与「填 0」之间二选一，而填 0 是明确禁止的。
   */
  it('usage 的 reasoningOutput / total 可空、可缺，但不接受非数字', () => {
    const withExtras = {
      ...base,
      type: 'usage',
      tokens: { input: 1, cached: 0, output: 2, reasoningOutput: 30, total: 1050 },
      turns: 1,
    };
    expect(AgentEventSchema.safeParse(withExtras).success).toBe(true);
    // 显式 null（这一家不报这一格）合法
    expect(
      AgentEventSchema.safeParse({
        ...base,
        type: 'usage',
        tokens: { input: 1, cached: 0, output: 2, reasoningOutput: null, total: null },
        turns: 1,
      }).success,
    ).toBe(true);
    // 字符串不算数：`'30'` 会被下游当成 `NaN` 参与算术，症状是界面出现 NaN
    expect(
      AgentEventSchema.safeParse({
        ...base,
        type: 'usage',
        tokens: { input: 1, cached: 0, output: 2, reasoningOutput: '30' },
        turns: 1,
      }).success,
    ).toBe(false);
  });

  /**
   * `.default` / `.optional` 之外的一条**行为**断言：zod 对象默认会**剥掉未知键**（strip）。
   *
   * 为什么值得钉：我们**依赖** strip 来保证「厂商原文里那些我们不认识的字段不会一路漂到落盘
   * 的日志里」（本仓的口径是「日志格式由本项目定义」）。万一有人把它改成 `.passthrough()`
   * （或者 zod 默认行为变了），历史日志会开始带上厂商的私有字段——那是格式漂移的起点，
   * 而所有「字段存在」的正向断言都照样绿。
   * 反过来 `input` / `cached` / `output` 这三个**认识**的格必须逐字保留。
   */
  it('未知的用量键会被 strip（日志格式由本项目定义，不随厂商字段漂移）', () => {
    const parsed = AgentEventSchema.safeParse({
      ...base,
      type: 'usage',
      tokens: {
        input: 1,
        cached: 2,
        output: 3,
        // 厂商可能带的、我们不认识的键（真机例：Anthropic 的 cache_creation_input_tokens）
        cache_creation_input_tokens: 700,
        thinkingTokens: 12,
      },
      turns: 1,
    });
    expect(parsed.success).toBe(true);
    const tokens = parsed.success && parsed.data.type === 'usage' ? parsed.data.tokens : null;
    expect(tokens).toEqual({ input: 1, cached: 2, output: 3 });
    expect(tokens !== null && 'cache_creation_input_tokens' in tokens).toBe(false);
  });

  it('status 成员只接受 EvalRowStatus 的取值（事件状态与行状态必须同一套词）', () => {
    expect(AgentEventSchema.safeParse({ ...base, type: 'status', status: 'timed-out' }).success).toBe(true);
    expect(AgentEventSchema.safeParse({ ...base, type: 'status', status: 'timeout' }).success).toBe(false);
  });

  it('error 允许省略 stack', () => {
    expect(AgentEventSchema.safeParse({ ...base, type: 'error', message: 'x', stack: 'at ...' }).success).toBe(true);
    expect(AgentEventSchema.safeParse({ ...base, type: 'error', message: 'x' }).success).toBe(true);
    expect(AgentEventSchema.safeParse({ ...base, type: 'error' }).success).toBe(false);
  });

  // 补的守卫（缺口）：`seq` 是 SSE 去重与 Last-Event-ID 续订的唯一依据，若退化成任意数字
  // （0 / 1.5 / 负数都能过），前端会把「没序号」当成「最后一条」而丢掉后续事件。
  it('seq 必须是正整数（0 与小数都不合法）', () => {
    const end = { ...base, type: 'end', exitReason: 'completed' };
    expect(AgentEventSchema.safeParse({ ...end, seq: 0 }).success).toBe(false);
    expect(AgentEventSchema.safeParse({ ...end, seq: 1.5 }).success).toBe(false);
    expect(AgentEventSchema.safeParse({ ...end, seq: 1 }).success).toBe(true);
    // `at` 必须是字符串：界面直接把它交给 new Date() 显示，数字/对象会在渲染时才炸。
    // 「是 ISO 8601」这一层由写入方（core 的 appendEvent 用 toISOString）保证，契约不做日期格式校验。
    expect(AgentEventSchema.safeParse({ ...end, at: 123 }).success).toBe(false);
  });

  // 补的守卫（缺口）：`score` 成员是 Task 5 的 ScoreResultSchema 在事件层的唯一消费点，
  // 退回 z.any() 也能全绿——那等于「评分事件里的分数不再受逐项判定与满分必须为正的约束」。
  it('score 成员直接消费 ScoreResultSchema（满分必须为正，0 当场红）', () => {
    const score = {
      judgments: [
        { id: 'A1', achieved: true, reason: '字段进了契约' },
        { id: 'D1', achieved: false, reason: '没补用例' },
      ],
      totalScore: 18,
      maxScore: 32,
      verdict: '完成度高',
      raw: '{}',
      judgeProviderId: 'p-1',
      judgeModelId: 'deepseek-chat',
      judgedAt: '2026-09-22T10:30:00.000Z',
    };
    expect(AgentEventSchema.safeParse({ ...base, type: 'score', score }).success).toBe(true);
    // 满分必须为正：`maxScore: 0` 意味着「无从判定」，那种评分结果不该存在
    expect(AgentEventSchema.safeParse({ ...base, type: 'score', score: { ...score, maxScore: 0 } }).success).toBe(false);
  });
});

describe('AGENT_EVENT_TYPES', () => {
  it('七个类型、顺序即 spec §7.4 的书写顺序', () => {
    expect([...AGENT_EVENT_TYPES]).toEqual([
      'status', 'log', 'usage', 'diff-summary', 'score', 'error', 'end',
    ]);
  });

  it('与联合成员一一对应（新增成员时忘补清单会当场红）', () => {
    const members = AgentEventSchema.options.map((option) => option.shape.type.value);
    expect([...AGENT_EVENT_TYPES].sort()).toEqual([...members].sort());
  });
});
