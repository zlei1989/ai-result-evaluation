// @vitest-environment node
/**
 * 契约 schema 的守卫：**事件**（九个成员的判别联合、类型清单、以及两条最容易漏的字段约束）、
 * **消息信封**（`AgentMessageSchema` 的可选格）与 **`agent-message.ts` 里另外两组形状**
 * （ask-user 的答案侧、交互面能力声明）。
 *
 * 为什么这些守卫都住在本文件：`agent-message.ts` 的形状没有独立的测试文件，
 * 而它们与前两组是同一份契约文件里的同一类东西（zod 形状 + 字段之间的对应关系），
 * 分散到多个文件只会让「这个形状有没有人管」变成要翻目录才知道的事。
 *
 * 注意：`seq` 从 1 开始单调递增（由 core 的事件日志写入器分配），`at` 是 ISO 8601 字符串——
 * 这两条决定了 SSE 的 `Last-Event-ID` 续订能不能工作。
 * 另有一条守卫钉住 `seq` 的「正整数」约束（见对应 it 内注释）：把 `.int().positive()` 删掉会失败；
 * `at` 则刻意只声明为 `z.string()`（ISO 8601 由写入方保证，契约层不做日期校验），不设约束。
 */
import { describe, expect, it } from 'vitest';
import { AGENT_EVENT_TYPES, AgentEventSchema, normalizeMcpServers } from './agent-event';
import {
  AgentMessageSchema,
  AskUserAnswerSchema,
  AskUserOutcomeSchema,
  AskUserResultSchema,
  InteractionCapabilitySchema,
} from './agent-message';

const base = { seq: 1, at: '2026-09-22T10:30:00.000Z' };

describe('AgentEventSchema', () => {
  it('接受行级事件成员（九个成员各有样本；`vendor-system` 的形状另有一组专测）', () => {
    const events = [
      { ...base, type: 'status', status: 'running' },
      { ...base, type: 'log', stream: 'stdout', text: '开始执行' },
      {
        ...base,
        type: 'vendor-system',
        tools: ['Task'],
        slashCommands: ['design'],
        agents: ['claude'],
        mcpServers: [{ name: 'find', status: 'connected', source: 'project' }],
        permissionMode: 'bypassPermissions',
        outputStyle: 'default',
      },
      { ...base, type: 'usage', tokens: { input: 10, cached: 2, output: 3 }, turns: 1 },
      { ...base, type: 'diff-summary', filesChanged: 2, insertions: 12, deletions: 3, truncated: false },
      {
        ...base,
        type: 'ask-user',
        askId: 'ask-1',
        callId: 'call-1',
        toolName: 'AskUserQuestion',
        channel: 'vendor-tool',
        outcome: 'answered',
        waitedMs: 12_000,
      },
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
   * `log.summary` 是**可选**的「人话摘要」（卡片底部的活动行显示它）。
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

  // 用户口径：轮次（一次模型 API 往返算一次）必须能**独立于 token** 上报。
  // 实测缺口：原来 tokens 必填 ⇒ cc 那一轮的 token 采不到，整轮只发得出一条
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
   * 归属格：这一条读数**属于哪一轮**。
   * 三个靶子：① 老日志（没有这一格）必须照样解析；② 带上的值必须原样保留；
   * ③ 号必须是**正整数**——`0` / 小数 / 负数都不是一个轮次，放过去界面就会去找一个不存在的轮次。
   */
  it('usage 的归属格 turn 可缺可空、带上时原样保留（老日志必须照样解析）', () => {
    // ① 整格缺席（历史行）
    expect(AgentEventSchema.safeParse({ ...base, type: 'usage', tokens: null, turns: 3 }).success).toBe(true);
    // ② 显式 null = 这一条算不出归属（读侧与「键缺席」同义：界面按时刻归位）
    const none = AgentEventSchema.safeParse({ ...base, type: 'usage', tokens: null, turns: 3, turn: null });
    expect(none.success).toBe(true);
    expect(none.success ? none.data : null).toMatchObject({ turn: null });
    // ③ 主会话与子会话两种身份都原样保留
    for (const turn of [{ subagentId: null, round: 2 }, { subagentId: 'child-1', round: 5 }]) {
      const parsed = AgentEventSchema.safeParse({ ...base, type: 'usage', tokens: null, turns: 3, turn });
      expect(parsed.success).toBe(true);
      expect(parsed.success ? parsed.data : null).toMatchObject({ turn });
    }
    // ④ 形状不对必须拒
    for (const bad of [{ subagentId: null, round: 0 }, { subagentId: null, round: 1.5 }, { subagentId: 7, round: 1 }]) {
      expect(AgentEventSchema.safeParse({ ...base, type: 'usage', tokens: null, turns: 3, turn: bad }).success).toBe(false);
    }
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

  // 补的守卫（缺口）：`score` 成员是 ScoreResultSchema 在事件层的唯一消费点，
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

/**
 * `vendor-system.mcpServers` 的形状。
 *
 * 为什么必须是对象数组：真机 claude 的 `system/init` 投的就是**对象数组**
 * （`[{name,status,source}]`，判据通道与真机样本见 `docs/features/mcp-config.md` 的「三家的判据通道」）。
 * 只认字符串项会把四台折成 `[]`——而 `[]` 在本仓的定义是「投送了，**确实是空的**」，
 * 那是一句假话，且它把「厂商下发了四台 MCP」这件事实从事件流里彻底抹掉（`null` 才是「没投送」）。
 */
describe('vendor-system 的 mcpServers', () => {
  /** 真机 run `7f05c765` 的 claude 候选行 raw `system/init` 逐字（四台，来源全是项目 `.mcp.json`） */
  const REAL_MCP_SERVERS = [
    { name: 'context7', status: 'pending', source: 'project' },
    { name: 'playwright', status: 'pending', source: 'project' },
    { name: 'find', status: 'connected', source: 'project' },
    { name: 'japi', status: 'pending', source: 'project' },
  ];

  /** 一条六格齐备的 `vendor-system`（只有 `mcpServers` 随用例变） */
  const vendorEvent = (mcpServers: unknown): Record<string, unknown> => ({
    ...base,
    type: 'vendor-system',
    tools: ['Task'],
    slashCommands: ['design'],
    agents: ['claude'],
    mcpServers,
    permissionMode: 'bypassPermissions',
    outputStyle: 'default',
  });

  it('接受对象数组：`{name, status, source}` 逐格原样保留（不再被折成 `[]`）', () => {
    const parsed = AgentEventSchema.safeParse(vendorEvent(REAL_MCP_SERVERS));

    expect(parsed.success).toBe(true);
    expect(parsed.success ? parsed.data : null).toMatchObject({ mcpServers: REAL_MCP_SERVERS });
  });

  /**
   * 两态不许互相顶替（本仓反复强调的那两句）：`null` = 厂商没投送，`[]` = 投送了确实是空的。
   * 这一条盯着的是**归一实现**：字符串数组归一成 `[]`、或空数组被归一成 `null`，
   * 都会让界面把「四个都没看到」说成「厂商说一台都没有」。
   */
  it('`null` 与 `[]` 两态各自原样保留', () => {
    const nothing = AgentEventSchema.safeParse(vendorEvent(null));
    expect(nothing.success && nothing.data.type === 'vendor-system' ? nothing.data.mcpServers : 'parse-failed').toBeNull();

    const empty = AgentEventSchema.safeParse(vendorEvent([]));
    expect(empty.success && empty.data.type === 'vendor-system' ? empty.data.mcpServers : 'parse-failed').toEqual([]);
  });

  /**
   * **历史事件必须照样读得动**（旧版落盘的 `events.jsonl` 里 `mcpServers` 是字符串数组）。
   *
   * 为什么这条不能省：读侧走的是 `AgentEventSchema.safeParse`，契约一旦只认对象数组，
   * 历史行会**整行解析失败**——`core` 的 `readEvents` 只 WARN 后跳过，于是日志抽屉里
   * 那一整条 `vendor-system` 凭空消失（最难查的一类静默失败）。
   * 归一之后：老形态（只有一个名字）读成 `{name, status: null, source: null}`——
   * 名字是它当时真的给了的，另两格它当时真的没给，如实记 `null`，**不编**。
   */
  it('历史字符串形态读侧兼容归一（老 events.jsonl 必须照样解析出名字）', () => {
    const legacy = AgentEventSchema.safeParse(vendorEvent(['context7', 'playwright']));

    expect(legacy.success).toBe(true);
    expect(legacy.success && legacy.data.type === 'vendor-system' ? legacy.data.mcpServers : 'parse-failed').toEqual([
      { name: 'context7', status: null, source: null, error: null },
      { name: 'playwright', status: null, source: null, error: null },
    ]);
  });

  /**
   * 归一函数是**一处共用的那一份**（消费方 `build-environment.ts` / `log-format.ts` 直接调它）：
   * 它们拿到的可能是不经 schema 的历史形状（`/log` 是 `getJson<AgentEvent[]>`，没有运行时校验），
   * 两处各写一份归一必然漂移。`null`（没投送）与 `[]`（投送了确实是空的）在这里也必须分得开。
   */
  it('`normalizeMcpServers` 是共用的那一份：字符串读成对象、两态各自保留、垃圾项丢掉', () => {
    expect(normalizeMcpServers(['find'])).toEqual([{ name: 'find', status: null, source: null, error: null }]);
    expect(normalizeMcpServers([{ name: 'find', status: 'connected', source: 'project' }])).toEqual([
      { name: 'find', status: 'connected', source: 'project', error: null },
    ]);
    // 厂商给了空串 = 这一格没给（与 `mcpServers` 那六格同一条处置），不是「名字叫空串的一台」
    expect(normalizeMcpServers([{ name: 'find', status: '', source: 'project' }])).toEqual([
      { name: 'find', status: null, source: 'project', error: null },
    ]);
    expect(normalizeMcpServers(null)).toBeNull();
    expect(normalizeMcpServers([])).toEqual([]);
    // 非数组（厂商把这一格投成字符串/数字）⇒ 整格按「没投送」处置，而不是编一个空数组
    expect(normalizeMcpServers('context7')).toBeNull();
    // 认不出的项丢掉（它是脏数据），认得出的照留——不因为一项坏就丢掉整格
    expect(normalizeMcpServers([42, 'find'])).toEqual([{ name: 'find', status: null, source: null, error: null }]);
  });

  /**
   * **厂商原文那一格**（行失败文案要用它）：
   * 名字 / 状态 / 来源都不足以说清「为什么没起来」，而厂商恰好给了原文——
   * 它是「MCP「<name>」未能启动：<厂商原文首行>」这句话里唯一有价值的那半句。
   */
  it('`error` 逐字保留厂商原文；老事件缺这一格读成 `null`（不是空串）', () => {
    const withError = normalizeMcpServers([
      { name: 'probe', status: 'failed', source: null, error: 'MCP client for `probe` failed to start: No such file or directory' },
    ]);
    expect(withError).toEqual([
      {
        name: 'probe',
        status: 'failed',
        source: null,
        error: 'MCP client for `probe` failed to start: No such file or directory',
      },
    ]);
    // 空串 = 「厂商这一格没给」（与 name / status / source 同一条处置）
    expect(normalizeMcpServers([{ name: 'probe', status: 'failed', source: null, error: '' }])).toEqual([
      { name: 'probe', status: 'failed', source: null, error: null },
    ]);
    // 旧版落盘的条目没有这一格 ⇒ 读成 `null`，且**整条事件照样解析**
    const legacy = AgentEventSchema.safeParse(vendorEvent([{ name: 'find', status: 'connected', source: 'project' }]));
    expect(legacy.success).toBe(true);
    expect(legacy.success && legacy.data.type === 'vendor-system' ? legacy.data.mcpServers : 'parse-failed').toEqual([
      { name: 'find', status: 'connected', source: 'project', error: null },
    ]);
  });

  /**
   * **这条事件里的 MCP 事实是从哪个通道读到的**（三家各一格）。
   *
   * 为什么必须由**事件自己**说：行级观测格的四个结论（`connected` / `unavailable` / `unverified` /
   * `skipped`）只有一半来自形状——「表里没有它」在 claude 上是「不判失败」，在 dsh 上**就是判失败**
   * （它起不来时工具静默消失，那是唯一判据）。让事件自报通道，`events.jsonl` 才自证得清，
   * 消费方也不必按厂商名去查一张静态表（声明与实际读到的东西会各自漂移）。
   *
   * 老事件没有这一格（那时只有 claude 落了它）⇒ `.optional()`：读侧按 `'vendor-status'` 处置，
   * 写成必填会让历史 `vendor-system` 整行解析失败。
   */
  it('`mcpChannel` 三档可辨、老事件缺格照样解析（缺格 = claude 那条 status 通道）', () => {
    for (const mcpChannel of ['vendor-status', 'vendor-startup-status', 'vendor-tool-table'] as const) {
      const parsed = AgentEventSchema.safeParse({ ...vendorEvent(null), mcpChannel });
      expect(parsed.success && parsed.data.type === 'vendor-system' ? parsed.data.mcpChannel : 'parse-failed').toBe(mcpChannel);
    }
    // 老事件（那一条没有这一格）：整条照样解析，那一格是「没给」
    const legacy = AgentEventSchema.safeParse(vendorEvent(null));
    expect(legacy.success && legacy.data.type === 'vendor-system' ? legacy.data.mcpChannel : 'parse-failed').toBeUndefined();
    // 编造的通道被拒（它决定结论，不许从磁盘上塞一个我们不认识的档进来）
    expect(AgentEventSchema.safeParse({ ...vendorEvent(null), mcpChannel: 'model-said-so' }).success).toBe(false);
  });
});

describe('AGENT_EVENT_TYPES', () => {
  it('十个类型、顺序即书写顺序（`vendor-system` 紧随 `log`）', () => {
    // `vendor-system` 挨着 `log` 排：两者都是**厂商侧投送的事实**（原文 / 归一之后的形状）；
    // `usage` 之后那一串则是本仓自己发的过程事件（计量 / 改动 / 提问收场 / 人工消息落点 / 评分 /
    // 失败 / 结束），其中 `diff-summary` / `ask-user` / `inject-message` 相邻——三条都是编排层
    // 自己算出来的行级观测（后两条成对：一条是「模型问人」，一条是「人喂模型」）
    expect([...AGENT_EVENT_TYPES]).toEqual([
      'status', 'log', 'vendor-system', 'usage', 'diff-summary', 'ask-user', 'inject-message', 'score', 'error', 'end',
    ]);
  });

  it('与联合成员一一对应（新增成员时忘补清单会当场红）', () => {
    const members = AgentEventSchema.options.map((option) => option.shape.type.value);
    expect([...AGENT_EVENT_TYPES].sort()).toEqual([...members].sort());
  });
});

describe('usage 事件的 subagentTokens', () => {
  it('带这一格时原样解析；这一格是子智能体那一份，不是合计', () => {
    const parsed = AgentEventSchema.parse({
      seq: 7,
      at: '2026-10-04T00:00:00.000Z',
      type: 'usage',
      tokens: { input: 100, cached: 20, output: 30 },
      subagentTokens: { input: 40, cached: 10, output: 5 },
      timing: null,
      turns: 3,
    });
    expect(parsed.type === 'usage' && parsed.subagentTokens).toEqual({ input: 40, cached: 10, output: 5 });
  });

  it('缺这一格（老日志）照样解析得动——它是可选格', () => {
    const parsed = AgentEventSchema.parse({
      seq: 8,
      at: '2026-10-04T00:00:00.000Z',
      type: 'usage',
      tokens: null,
      turns: 1,
    });
    expect(parsed.type === 'usage' && parsed.subagentTokens).toBeUndefined();
  });

  it('显式的 null（有子智能体但没采到）与「没有这一格」是两件事，都必须能表达', () => {
    const parsed = AgentEventSchema.parse({
      seq: 9,
      at: '2026-10-04T00:00:00.000Z',
      type: 'usage',
      tokens: null,
      subagentTokens: null,
      timing: null,
      turns: 1,
    });
    expect(parsed.type === 'usage' && parsed.subagentTokens).toBeNull();
  });
});

/**
 * `usage` 事件的 `subagentTurns`（与 `subagentTokens` 逐格同一条处置）。
 * 三态与上面那一格**逐字对应**：有值 / 缺格（老日志）/ 显式 `null`（有子智能体但读不到轮次）。
 * ⚠️ 这一格是**分量**（`turns` 是主会话 + 全部子智能体的合计），不是合计——
 * 读成合计的话界面画出来的「主会话轮次」会等于 0。
 */
describe('usage 事件的 subagentTurns', () => {
  it('带这一格时原样解析；它是子智能体那一份轮次', () => {
    const parsed = AgentEventSchema.parse({
      seq: 10,
      at: '2026-10-04T00:00:00.000Z',
      type: 'usage',
      tokens: null,
      turns: 9,
      subagentTurns: 4,
    });
    expect(parsed.type === 'usage' && parsed.subagentTurns).toBe(4);
  });

  it('缺这一格（老日志）照样解析得动——它是可选格', () => {
    const parsed = AgentEventSchema.parse({
      seq: 11,
      at: '2026-10-04T00:00:00.000Z',
      type: 'usage',
      tokens: null,
      turns: 1,
    });
    expect(parsed.type === 'usage' && parsed.subagentTurns).toBeUndefined();
  });

  it('显式的 null（子智能体的轮次读不到）与「没有这一格」是两件事，都必须能表达', () => {
    const parsed = AgentEventSchema.parse({
      seq: 12,
      at: '2026-10-04T00:00:00.000Z',
      type: 'usage',
      tokens: null,
      turns: 1,
      subagentTurns: null,
    });
    // 显式 null = 「明确没采到」⇒ 消费方清掉旧分量；缺格 = 「本条不带」⇒ 保持原值
    expect(parsed.type === 'usage' && parsed.subagentTurns).toBeNull();
  });
});

/**
 * 消息级用量（`AgentMessage.usage`）。
 * 两条判据的靶子：① 老 `messages.jsonl` 里**没有这一格**，写必填会让回放成片失败；
 * ② 这一格进的是「该次模型调用的用量」，三项必填、可选两格可缺可空，但绝不接受非数字。
 *
 * ⚠️ 信封（`AgentMessageSchema`）的守卫**就住在本文件**（仓里没有 `agent-message.test.ts`）。
 */
describe('AgentMessageSchema 的消息级 usage', () => {
  const messageBase = {
    messageId: 'run-1:1',
    vendorId: null,
    role: 'assistant' as const,
    source: 'wire' as const,
    roundTrip: 1,
    turn: null,
    step: null,
    parentCallId: null,
    subagentId: null,
    chunk: 'snapshot' as const,
    assembly: 'snapshot' as const,
    mergeKey: 'main|1|assistant|-',
    blocks: [{ type: 'text' as const, text: '正文' }],
    raw: null,
  };

  it('老消息（没有 usage 键）照样解析成功', () => {
    expect(AgentMessageSchema.safeParse(messageBase).success).toBe(true);
  });

  it('带 usage 时逐字保留；显式 null 合法', () => {
    const parsed = AgentMessageSchema.parse({
      ...messageBase,
      usage: { input: 295, cached: 7424, output: 841 },
    });
    expect(parsed.usage).toEqual({ input: 295, cached: 7424, output: 841 });
    expect(AgentMessageSchema.safeParse({ ...messageBase, usage: null }).success).toBe(true);
  });

  it('三项必填、可选两格可缺可空，但不接受非数字', () => {
    expect(AgentMessageSchema.safeParse({ ...messageBase, usage: { input: 1, cached: 2 } }).success).toBe(false);
    expect(AgentMessageSchema.safeParse({ ...messageBase, usage: { input: '1', cached: 2, output: 3 } }).success).toBe(false);
    expect(
      AgentMessageSchema.parse({
        ...messageBase,
        usage: { input: 1, cached: 2, output: 3, reasoningOutput: null, total: 7 },
      }).usage,
    ).toEqual({ input: 1, cached: 2, output: 3, reasoningOutput: null, total: 7 });
  });
});

/**
 * `vendor-system.skills`：厂商当时**看见了哪几条技能**（逐条带来源分档）。
 *
 * 三态与 `mcpServers` 逐条同构，理由也一样——它们回答的是不同的问题：
 *   · **缺席**（老 `events.jsonl` 里没有这一格）⇒ `undefined`，读侧按「没这一格」处置；
 *   · **`null`** ⇒ 厂商**没投送**这一格（或我们没采到）；
 *   · **`[]`** ⇒ 投送了、确实一条都没有。
 * 把「没投送」写成 `[]`（或反过来）会让界面说一句厂商没说过的话。
 *
 * `origin` 那一格是**归一后的来源分档**（由采集它的适配器按 `classifySkillOrigin` 判：
 * 那一层同时知道行配置目录与工作目录）；`source` 是**厂商原值照抄**，两格都在才追得回事件。
 */
describe('vendor-system 的 skills', () => {
  /** 真机 `getContextUsage().skills.skillFrontmatter` 的三档原值（本机实测） */
  const REAL_SKILLS = [
    { name: 'tang-poem-meal', source: 'userSettings', path: null, origin: 'local-enabled' },
    { name: 'repo-owned-probe', source: 'projectSettings', path: null, origin: 'repo-provided' },
    { name: 'dataviz', source: 'built-in', path: null, origin: 'vendor-builtin' },
  ];

  const vendorEvent = (skills: unknown): Record<string, unknown> => ({
    ...base,
    type: 'vendor-system',
    tools: ['Task'],
    slashCommands: ['design'],
    agents: ['claude'],
    mcpServers: null,
    permissionMode: 'bypassPermissions',
    outputStyle: 'default',
    skills,
  });

  it('逐条原样保留（名字 / 厂商原值 / 落点 / 归一后的来源分档）', () => {
    const parsed = AgentEventSchema.safeParse(vendorEvent(REAL_SKILLS));
    expect(parsed.success).toBe(true);
    expect(parsed.success ? parsed.data : null).toMatchObject({ skills: REAL_SKILLS });
  });

  it('三态不许互相顶替：缺席 / null / []', () => {
    const absent = AgentEventSchema.safeParse({ ...vendorEvent(null), skills: undefined });
    expect(absent.success && 'skills' in absent.data ? absent.data.skills : 'parse-failed').toBeUndefined();
    const nothing = AgentEventSchema.safeParse(vendorEvent(null));
    expect(nothing.success && nothing.data.type === 'vendor-system' ? nothing.data.skills : 'parse-failed').toBeNull();
    const empty = AgentEventSchema.safeParse(vendorEvent([]));
    expect(empty.success && empty.data.type === 'vendor-system' ? empty.data.skills : 'parse-failed').toEqual([]);
  });

  it('编造的来源分档被拒，空名字被拒（名字是这一格与我们的清单配对的唯一键）', () => {
    expect(AgentEventSchema.safeParse(vendorEvent([{ ...REAL_SKILLS[0], origin: 'mine' }])).success).toBe(false);
    expect(AgentEventSchema.safeParse(vendorEvent([{ ...REAL_SKILLS[0], name: '' }])).success).toBe(false);
    // 厂商没给来源 ⇒ source 为 null（不是空串）：那是「厂商没报这一格」，与「报了一个空来源」不同
    expect(AgentEventSchema.safeParse(vendorEvent([{ name: 'x', source: null, path: null, origin: 'unverified' }])).success).toBe(true);
  });
});

/**
 * **ask-user 的答案侧**（问题侧见 `AskUserQuestionSchema`）。
 *
 * 两条判据的靶子：① 一份答案的三个格子各有归处——`selected` 装**选项标签**（配对键只有
 * `header`，装 id 或下标会让答案配到另一个问题上）、`custom` 的 `null` 表示「没写自己的话」；
 * ② 收场方式是**既有七态**，不新造枚举也不许少一格（少了哪一格，落盘的收场标记与只读卡片
 * 就会各说一套）。
 */
describe('ask-user 答案侧', () => {
  it('一份答案 = header + selected（选项标签）+ custom；三项缺一不可', () => {
    const answer = { header: '选路径', selected: ['选项 A', '选项 C'], custom: null };
    const parsed = AskUserAnswerSchema.safeParse(answer);
    expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues)).toBe(true);
    expect(parsed.success ? parsed.data : null).toEqual(answer);
    // `custom` 必填可空：`null` = 没写自己的话，`''` = 写了但内容为空——两种事实不许互相顶替
    expect(AskUserAnswerSchema.safeParse({ header: 'H', selected: [] }).success).toBe(false);
    // `selected` 是标签数组：自由输入不是选项，不许混进这一格；数字更不行
    expect(AskUserAnswerSchema.safeParse({ header: 'H', selected: '选项 A', custom: null }).success).toBe(false);
    expect(AskUserAnswerSchema.safeParse({ header: 'H', selected: [1], custom: null }).success).toBe(false);
    // 空选择合法：多选里「一个都没勾、只写了自己的话」是真实答案
    expect(AskUserAnswerSchema.safeParse({ header: 'H', selected: [], custom: '都不选' }).success).toBe(true);
  });

  it('收场方式就是既有七态（不新造，也不许少一格）', () => {
    expect([...AskUserOutcomeSchema.options]).toEqual([
      'answered',
      'auto-resolved',
      'skipped',
      'timeout',
      'unavailable',
      'rejected',
      'canceled',
    ]);
    // 「还没收场」不是收场方式：它是提问的另一支状态，混进这一格会让「答完了吗」永远判不出来
    expect(AskUserOutcomeSchema.safeParse('pending').success).toBe(false);
  });

  /**
   * **结果载荷**（答案在 `tool-result` 那一半）：只读卡片的回填只认这一格，
   * 故它必须①不接受缺答案的 `answered`、②不接受「六态里带了答案」——
   * 那两种形状都会让「有没有人答过」这个问题再也答不出来。
   */
  it('结果载荷 = outcome + answers；`answered` 与「有答案」成对，其余六态恒 null', () => {
    const answered = { outcome: 'answered', answers: [{ header: '选路径', selected: ['选项 A'], custom: null }] };
    expect(AskUserResultSchema.safeParse(answered).success).toBe(true);
    // 答了但一个选项都没选（自由输入那一支）：空数组是**有答案**，与 null 不是一回事
    expect(AskUserResultSchema.safeParse({ outcome: 'answered', answers: [{ header: 'H', selected: [], custom: '都不对' }] }).success).toBe(true);
    expect(AskUserResultSchema.safeParse({ outcome: 'timeout', answers: null }).success).toBe(true);
    // 缺答案数组本身就不合法（「没采到」与「没人答」是两件事，前者是坏数据）
    expect(AskUserResultSchema.safeParse({ outcome: 'timeout' }).success).toBe(false);
    // 收场方式必须是那七态之一：从磁盘上塞一个我们不认识的档进来要当场拒
    expect(AskUserResultSchema.safeParse({ outcome: 'gave-up', answers: null }).success).toBe(false);
  });
});

/**
 * **交互面能力声明**（与「行级」「内容级」「下发级」并列的一组）。
 *
 * 五条判据的靶子，与 `InjectionStateSchema` 同源：
 *   · `askUser` 用**既有五态词表**（不新造取值）；
 *   · 非 `yes` ⇒ 必须给出缺失原因，`yes` ⇒ 原因必须为 `null`；
 *   · `askUserChannel` **只在 `yes` 时有值**——它回答「模型看到的提问工具是厂商提供的还是
 *     我们注册的」，没有这条通道时留着它等于给消费方一个查不到的来源；
 *   · `askUserProofDriver` **必填**：这一句 `yes` 是靠真路径证出来的、还是夹具代跑的；
 *   · **`yes` 不许配 `synthetic-fixture`**——声明得出「能被问」就得拿真路径证明，而
 *     `synthetic-fixture` 必须给出原因（它是临时档，说不清为什么就该删掉它）。
 */
describe('交互面能力声明', () => {
  /** 一份可解析的声明；`driver` 与 `driverReason` 由各条用例按要判的那一格覆盖 */
  const declaration = (
    askUser: unknown,
    askUserChannel: unknown,
    askUserReason: unknown,
    driver: unknown = 'real-path',
    driverReason: unknown = null,
  ) => ({
    askUser,
    askUserChannel,
    askUserReason,
    askUserProofDriver: driver,
    askUserProofDriverReason: driverReason,
    notes: [],
  });

  it('yes：必须给出通道（厂商工具 / 宿主工具），原因必须为 null', () => {
    for (const channel of ['vendor-tool', 'host-tool'] as const) {
      expect(InteractionCapabilitySchema.safeParse(declaration('yes', channel, null)).success, channel).toBe(true);
    }
    expect(InteractionCapabilitySchema.safeParse(declaration('yes', 'vendor-tool', 'not-observed')).success).toBe(false);
    // 声明得出「这家能被问」却说不出提问工具是谁提供的 ⇒ 消费方分不清提示词来源
    expect(InteractionCapabilitySchema.safeParse(declaration('yes', null, null)).success).toBe(false);
  });

  it('yes 必须拿真路径证明：`yes` + `synthetic-fixture` 被拒', () => {
    // 夹具扮演厂商那一端能让判据全绿，却证不到「请求真的到了我们手里、答复真的回到了厂商」——
    // 那句 `yes` 因此只能是假的
    expect(
      InteractionCapabilitySchema.safeParse(
        declaration('yes', 'vendor-tool', null, 'synthetic-fixture', '这一家今天驱动不了真路径'),
      ).success,
    ).toBe(false);
    // 同一组字段在真路径上照旧可解析（被拒的是组合，不是这两个字段本身）
    expect(InteractionCapabilitySchema.safeParse(declaration('yes', 'vendor-tool', null, 'real-path')).success).toBe(true);
  });

  it('synthetic-fixture 是临时档：必须给出非空原因', () => {
    expect(InteractionCapabilitySchema.safeParse(declaration('no', null, 'not-supported', 'synthetic-fixture', null)).success).toBe(false);
    expect(InteractionCapabilitySchema.safeParse(declaration('no', null, 'not-supported', 'synthetic-fixture', '   ')).success).toBe(false);
    expect(InteractionCapabilitySchema.safeParse(declaration('no', null, 'not-supported', 'synthetic-fixture', '驱动器还没接')).success).toBe(true);
    // real-path 反过来不许挂原因：那时没有要解释的东西，留着它只会让读者以为这一档有保留
    expect(InteractionCapabilitySchema.safeParse(declaration('no', null, 'not-supported', 'real-path', '驱动器还没接')).success).toBe(false);
  });

  it('驱动器那一格必填（答不出就不该声明 yes）', () => {
    const { askUserProofDriver: _driver, ...withoutDriver } = declaration('yes', 'vendor-tool', null);
    expect(InteractionCapabilitySchema.safeParse(withoutDriver).success).toBe(false);
  });

  it('四种「没有」：必须给出原因、通道必须为 null', () => {
    const nonYes: ReadonlyArray<readonly [string, string]> = [
      ['no', 'not-supported'],
      ['unverified', 'unverified'],
      ['off-by-adapter', 'not-observed'],
      ['not-projected-by-vendor', 'not-exposed'],
    ];
    for (const [askUser, reason] of nonYes) {
      expect(InteractionCapabilitySchema.safeParse(declaration(askUser, null, reason)).success, askUser).toBe(true);
    }
    // 非 yes 不给原因 ⇒ 「这家结构上没有」与「我们有这个能力但没接」在数据上同形
    expect(InteractionCapabilitySchema.safeParse(declaration('no', null, null)).success).toBe(false);
    // 非 yes 却带着通道 ⇒ 消费方会去读一条并不存在的通道
    expect(InteractionCapabilitySchema.safeParse(declaration('off-by-adapter', 'host-tool', 'not-observed')).success).toBe(false);
  });

  it('取值域就是既有五态（编造的档被拒）', () => {
    for (const state of ['yes', 'no', 'unverified', 'off-by-adapter', 'not-projected-by-vendor'] as const) {
      const channel = state === 'yes' ? 'host-tool' : null;
      const reason = state === 'yes' ? null : 'unverified';
      expect(InteractionCapabilitySchema.safeParse(declaration(state, channel, reason)).success, state).toBe(true);
    }
    expect(InteractionCapabilitySchema.safeParse(declaration('maybe', null, 'unverified')).success).toBe(false);
  });
});
