// @vitest-environment node
/**
 * SSE 信封契约的守卫：四类帧（run 信号 / 行级事件 / 行级消息 / 两个信号）的判别联合、
 * 每类帧「该有的格有、该没有的格没有」，以及三条只能靠断言钉住的口径——
 * 判别字面量不许与 `AGENT_EVENT_TYPES` 撞名、`DRAWER_CHANNELS` 与 `DrawerChannelSchema` 同源、
 * **归属格不许与任何业务字段同名**。
 *
 * 为什么撞名那条要单独钉住：判别键统一是 `type`，而事件族成员是**按 `AgentEventSchema.options`
 * 映射出来**的，谁新增一个与信号帧 / 消息帧同名的类型，联合本身的构造就会失败
 * （zod 抛 `Discriminator property type has duplicate value …`）——那是一条模块加载即炸的错，
 * 报错里没有「本仓这两族为什么必须错开」的理由；断言把这句话写进用例名。
 *
 * 样本的写法：每一格都按上游契约的**必填项**给全（默认值也给成默认值本身），
 * 于是「解析结果逐字等于输入」这条断言只说明信封——它原样带上了归属格、没有吃掉载荷格。
 */
import { describe, expect, it } from 'vitest';
import { AGENT_EVENT_TYPES } from './agent-event';
import { DRAWER_CHANNELS, DrawerChannelSchema, RunStreamFrameSchema, type RunStreamFrame } from './run-stream';

/** 事件公共两格：`seq` 由 core 的事件日志写入器分配，`at` 是 ISO 8601 */
const base = { seq: 1, at: '2026-09-22T10:30:00.000Z' };

/** 一条 `log` 事件：下面「缺归属格」「坏 rowChannel」两条反例都拿它当底样 */
const logEvent = { ...base, type: 'log', stream: 'stdout', text: '开始执行' };

/** 十种事件各一条合法样本（每一格都按契约必填项给全），用来钉「每个成员都被扩上了归属格」 */
const eventSamples = [
  { ...base, type: 'status', status: 'running' },
  logEvent,
  {
    ...base,
    type: 'vendor-system',
    tools: null,
    slashCommands: null,
    agents: null,
    mcpServers: null,
    permissionMode: null,
    outputStyle: null,
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
    type: 'inject-message',
    messageId: 'msg-1',
    requires: 'round',
    outcome: 'delivered',
    reason: null,
  },
  {
    ...base,
    type: 'score',
    score: {
      judgments: [{ id: 'A1', achieved: true, reason: '字段进了契约' }],
      totalScore: 18,
      maxScore: 32,
      verdict: '完成度高',
      raw: '{}',
      judgeProviderId: 'p-1',
      judgeModelId: 'deepseek-chat',
      judgedAt: '2026-09-22T10:30:00.000Z',
      judgeAgentKind: null,
      judgeEffort: null,
      judgeTokens: null,
      judgeDurationMs: null,
      structuredOutput: false,
    },
  },
  { ...base, type: 'error', message: 'CLI 未安装' },
  { ...base, type: 'end', exitReason: 'completed' },
];

/**
 * 消息族的两条样本：`RowRecord` 的两个成员（内容流一条、派发视图一条）。
 * 两条各用一个 channel，顺带覆盖通道值域的两端。
 */
const messageRecord = {
  type: 'message',
  message: {
    messageId: 'run-1:7',
    vendorId: null,
    role: 'assistant',
    source: 'wire',
    origin: 'case-prompt',
    roundTrip: 1,
    turn: null,
    step: null,
    parentCallId: null,
    subagentId: null,
    chunk: 'delta',
    assembly: 'open',
    mergeKey: 'main|1|assistant|-',
    blocks: [],
    raw: {},
  },
};
const subagentRecord = {
  type: 'subagent',
  subagent: {
    subagentId: 'sa-1',
    name: '探查仓库',
    kind: 'agent',
    source: 'wire',
    status: 'running',
    statusMissing: null,
    outcome: null,
    parentCallId: null,
    parentSubagentId: null,
    usage: null,
  },
};
const recordSamples = [messageRecord, subagentRecord];

/** 正例统一走它：解析失败时把 zod 的原因抛出来，而不是让断言停在 `null` 上 */
const parseFrame = (input: unknown) => {
  const parsed = RunStreamFrameSchema.safeParse(input);
  if (!parsed.success) throw new Error(`帧解析失败：${parsed.error.message}`);
  return parsed.data;
};

describe('RunStreamFrameSchema 的 run 信号帧', () => {
  it('run-updated 帧只有 runId：解析后逐字等于输入（不多一格、不少一格）', () => {
    expect(parseFrame({ type: 'run-updated', runId: 'run-1' })).toEqual({ type: 'run-updated', runId: 'run-1' });
  });

  it('run-updated 缺 runId 被拒（信号必须说清是哪一轮落盘了）', () => {
    expect(RunStreamFrameSchema.safeParse({ type: 'run-updated' }).success).toBe(false);
  });
});

describe('RunStreamFrameSchema 的行级事件帧', () => {
  /**
   * **对着未加归属格的原始样本逐格比**，而不是与「拼好的帧」比——这一条是本文件最要紧的判据。
   *
   * 与拼好的帧比是查不出撞名的：`.extend()` 对同名键是**覆盖**，而组帧写作 `{ ...event, rowId, rowChannel }`
   * 时展开顺序也是覆盖 ⇒ 「输入」本身在那一刻就已经被顶掉了，两边比出来照样相等（绿的）。
   * 真发生过：`ask-user` 事件自带一格 `channel`（提问工具来源），信封那一格当时也叫 `channel`，
   * 于是这一支的业务通道从类型与运行时双双消失，界面（`ui/composite/log-format.ts` 的提问行）
   * 只印出 `undefined`，没有任何报错。改成对原始样本比之后，任何归属格与业务字段撞名都会在这里红。
   */
  it('每个事件类型各扩上 rowId + rowChannel，业务载荷与 seq 逐字保留', () => {
    for (const event of eventSamples) {
      const parsed = parseFrame({ ...event, rowId: 'w-1', rowChannel: 'judge' }) as Record<string, unknown>;
      for (const [key, value] of Object.entries(event)) {
        expect([key, parsed[key]]).toEqual([key, value]);
      }
      expect(parsed['rowId']).toBe('w-1');
      expect(parsed['rowChannel']).toBe('judge');
    }
  });

  // 少一个类型的样本 ⇒ 那一个成员的帧形状就没人钉：上游加一格而这里没扩上时，
  // 症状是那一格在 SSE 上恒 `undefined`（消费方不报错，只是永远读不到）
  it('样本覆盖全部事件类型', () => {
    expect(eventSamples.map((event) => event.type).sort()).toEqual([...AGENT_EVENT_TYPES].sort());
  });

  it('缺 rowId 的行级事件帧被拒（归属格是信封存在的理由）', () => {
    expect(RunStreamFrameSchema.safeParse({ ...logEvent, rowChannel: 'candidate' }).success).toBe(false);
  });

  it('rowChannel 不在值域被拒（`judge2` 不是通道，不许静默收下）', () => {
    expect(RunStreamFrameSchema.safeParse({ ...logEvent, rowId: 'w-1', rowChannel: 'judge2' }).success).toBe(false);
  });

  /**
   * 上面那条「逐格保留」的失败信息是一条 `[key, value]` 数组，读起来要知道去哪儿找原因；
   * 这一条把**真实踩过的那一格**单独立成用例——它红的时候，用例名本身就是根因。
   */
  it('ask-user 事件的业务通道原样保留（信封的 rowChannel 不许顶掉它）', () => {
    const askUser = eventSamples.find((event) => event.type === 'ask-user');
    if (askUser === undefined) throw new Error('样本里没有 ask-user：上一条「样本覆盖全部事件类型」已经失败');
    const parsed = parseFrame({ ...askUser, rowId: 'w-1', rowChannel: 'candidate' }) as Extract<
      RunStreamFrame,
      { type: 'ask-user' }
    >;
    expect(parsed.channel).toBe('vendor-tool');
    expect(parsed.rowChannel).toBe('candidate');
  });
});

describe('RunStreamFrameSchema 的行级消息帧', () => {
  /** 与事件族**同一条判据**（对着原始样本逐格比）：消息族同样会被同名归属格静默顶掉业务格 */
  it('两个成员各带 rowId + rowChannel，载荷逐字保留、且没有 seq', () => {
    const channels = ['candidate', 'judge'];
    recordSamples.forEach((record, index) => {
      const rowChannel = channels[index % channels.length];
      const parsed = parseFrame({ ...record, rowId: 'w-1', rowChannel }) as Record<string, unknown>;
      for (const [key, value] of Object.entries(record)) {
        expect([key, parsed[key]]).toEqual([key, value]);
      }
      expect(parsed['rowId']).toBe('w-1');
      expect(parsed['rowChannel']).toBe(rowChannel);
      // 消息帧**没有** `seq`：`messageId` 跨运行重号、delta 覆盖使历史可变，
      // 按 seq 续订对一份可变历史没有意义（去重靠 messageId、覆盖靠 mergeKey）
      expect('seq' in parsed).toBe(false);
    });
  });

  it('样本覆盖 RowRecord 的两个成员', () => {
    expect(recordSamples.map((record) => record.type).sort()).toEqual(['message', 'subagent']);
  });

  // `mergeKey` 是消息账本里的覆盖合并键：少了它客户端无法把 delta 与 snapshot 配对
  // （症状是同一块内容在界面里叠加成两份），而帧只要能解析出来就没人在这一层拦它
  it('message 帧缺 mergeKey 被拒（信封不许吃掉账本的必填格）', () => {
    const { mergeKey: _mergeKey, ...messageWithoutMergeKey } = messageRecord.message;
    expect(
      RunStreamFrameSchema.safeParse({
        ...messageRecord,
        message: messageWithoutMergeKey,
        rowId: 'w-1',
        rowChannel: 'candidate',
      }).success,
    ).toBe(false);
  });

  it('缺 rowId 的消息帧被拒', () => {
    expect(RunStreamFrameSchema.safeParse({ ...messageRecord, rowChannel: 'candidate' }).success).toBe(false);
  });
});

describe('RunStreamFrameSchema 的两个信号帧', () => {
  const signalTypes = ['ask-user-changed', 'inject-messages-changed'] as const;

  it('都是无载荷帧：解析后逐字等于 `{ type }`（推信号不推内容，客户端收到后重读快照）', () => {
    for (const type of signalTypes) {
      expect(parseFrame({ type })).toEqual({ type });
    }
  });

  it('都没有归属格与 seq（信号不属于任何一行、也不可续订）', () => {
    for (const type of signalTypes) {
      const parsed = parseFrame({ type });
      expect('rowId' in parsed).toBe(false);
      expect('rowChannel' in parsed).toBe(false);
      expect('seq' in parsed).toBe(false);
    }
  });
});

describe('信封的判别字面量', () => {
  /** 帧联合的全部判别值：从成员表逐字读出（真源，不是手抄的第二份名单） */
  const frameTypes = RunStreamFrameSchema.options.map((option) => option.shape.type.value as string);
  /**
   * **非事件族**的字面量名单（run 信号 + 两个消息成员 + 两个信号）。
   * 这是一份**独立于 schema** 的期望值——从这份名单反推出来的断言才说明得了「联合里有什么」。
   */
  const NON_EVENT_FRAME_TYPES = [
    'run-updated',
    'message',
    'subagent',
    'ask-user-changed',
    'inject-messages-changed',
  ];

  it('帧联合恰好由「事件族十个 + 非事件族五个」组成：不多一个、不少一个', () => {
    expect([...frameTypes].sort()).toEqual([...AGENT_EVENT_TYPES, ...NON_EVENT_FRAME_TYPES].sort());
  });

  // 判别键统一是 `type`：撞名时 zod 会在**构造联合**时抛重复判别值（模块加载即炸），
  // 这条断言不依赖 zod 那个行为，自己把「两族为什么必须错开」写在用例名下——
  // 将来谁把一个信号帧或消息帧的字面量取成某个事件类型，这里给的是可读的一句话
  it('非事件族的字面量与 AGENT_EVENT_TYPES 无交集', () => {
    const eventTypes = new Set<string>(AGENT_EVENT_TYPES);
    expect(NON_EVENT_FRAME_TYPES.filter((type) => eventTypes.has(type))).toEqual([]);
  });
});

describe('DRAWER_CHANNELS', () => {
  it('值域是 candidate / judge，且 DrawerChannelSchema 与它同源（抽屉流的 URL 参数共用这一份，不许各写一份枚举）', () => {
    expect([...DRAWER_CHANNELS]).toEqual(['candidate', 'judge']);
    expect(DrawerChannelSchema.options).toEqual([...DRAWER_CHANNELS]);
  });
});
