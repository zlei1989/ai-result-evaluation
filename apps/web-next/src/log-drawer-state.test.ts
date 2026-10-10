// @vitest-environment node
/**
 * 日志抽屉的「读失败 / 读取中 / 有内容」判定（纯函数）。
 *
 * 这个文件守的是一条会被误读的边界：api 的读失败原因**带文件路径**（`读取执行日志失败（…events.jsonl）：…`），
 * 而抽屉的空态文案是「还没有日志 · 这一行还没开始执行」。两者一起出现时，
 * 使用者会把一个真实的故障读成「还没开始跑」——去等一个永远不会开始的执行。
 * 所以有错且**两条来源都空**时必须整段替换抽屉内容，且这条判定必须能被直接测到。
 */
import { describe, expect, it } from 'vitest';
import {
  AGENT_LABELS,
  ServiceError,
  type AgentEvent,
  type EvalRow,
  type ScoreResult,
  type UsageTokens,
} from '@aieval/contracts';
import { buildRowFacts, resolveLogDrawer } from './log-drawer-state';

/** 一条真实形状的 log 事件（只有 seq/at/type 之外还带 stream/text，够用即可） */
function event(seq: number): AgentEvent {
  return { seq, at: '2026-09-22T08:00:00.000Z', type: 'log', stream: 'stdout', text: `第 ${seq} 行` };
}

const readFailure = new ServiceError(
  'INTERNAL',
  '读取执行日志失败（D:\\ws\\run-1\\rows\\row-1\\events.jsonl）：Unexpected token < in JSON at position 0',
);

describe('resolveLogDrawer', () => {
  it('读失败且没有事件 → failed，文案就是 api 的中文原因（含文件路径）', () => {
    const state = resolveLogDrawer({ events: [], logError: readFailure, isLoading: false });

    expect(state.kind).toBe('failed');
    // 路径必须在文案里：只说「读取失败」的话，使用者没有任何下一步可做
    expect(state.kind === 'failed' ? state.message : '').toContain('events.jsonl');
    expect(state.kind === 'failed' ? state.message : '').toContain('读取执行日志失败');
  });

  it('读失败但手上还有事件 → 照旧渲染日志，另给一条非破坏性提示（不把真数据藏起来）', () => {
    const state = resolveLogDrawer({ events: [event(1), event(2)], logError: readFailure, isLoading: false });

    expect(state.kind).toBe('log');
    expect(state.kind === 'log' ? state.events.map((item) => item.seq) : []).toEqual([1, 2]);
    expect(state.kind === 'log' ? state.warning : undefined).toContain('events.jsonl');
  });

  it('首次拉取中（没数据、没错误）→ loading，与「读失败」区分开', () => {
    expect(resolveLogDrawer({ events: [], logError: null, isLoading: true })).toEqual({ kind: 'loading' });
  });

  it('读失败优先于「读取中」：已经在手上的失败不会被一个转圈盖掉', () => {
    // SWR 重验期间 isLoading 仍可能为 true（手上还有上一次的错误）。把错误判定排在 loading 之后，
    // 表现是「抽屉一直转圈」——而真相是上一次已经失败了，转圈会让人一直等下去
    expect(resolveLogDrawer({ events: [], logError: readFailure, isLoading: true }).kind).toBe('failed');
  });

  it('拉完了但一条事件都没有 → log（空数组交给抽屉说「还没有日志」，那是真的没开始跑）', () => {
    expect(resolveLogDrawer({ events: [], logError: null, isLoading: false })).toEqual({ kind: 'log', events: [] });
  });

  it('非 ServiceError 的失败兜底成一句中文，不透英文内部错误', () => {
    const state = resolveLogDrawer({ events: [], logError: new TypeError('Failed to fetch'), isLoading: false });

    expect(state.kind === 'failed' ? state.message : '').toBe('操作失败，请稍后重试');
  });

  it('**实时通道故障且没有事件 → failed，带上原因**（断流不能只说「还没有日志」）', () => {
    // 场景：`/stream` 建立了但一帧都收不到（C1 的零交付 / 中间层掐断），或环境没有 EventSource。
    // 过去页面只喂 `logError`（这里为 null）⇒ 抽屉回到 `log` 态、渲染空态
    // 「还没有日志 · 这一行还没开始执行」+ 徽标「未连接」——**没有原因、没有出路提示**。
    const state = resolveLogDrawer({
      events: [],
      logError: null,
      streamError: new Error('实时日志连接中断：浏览器会自动重连，已收到的日志不受影响'),
      isLoading: false,
    });

    expect(state.kind).toBe('failed');
    const message = state.kind === 'failed' ? state.message : '';
    expect(message).toContain('实时通道不可用');
    // 原因本身要在（使用者据此判断是网络还是环境不支持）；措辞不能借用「读取失败」
    expect(message).toContain('自动重连');
    expect(message).not.toContain('读取执行日志失败');
  });

  it('实时通道故障但手上还有事件 → 照旧渲染日志，另给一条实时通道提示（不把真数据藏起来）', () => {
    const state = resolveLogDrawer({
      events: [event(1), event(2)],
      logError: null,
      streamError: new Error('当前环境不支持 EventSource：只能查看已落盘的日志，无法实时追加'),
      isLoading: false,
    });

    expect(state.kind).toBe('log');
    expect(state.kind === 'log' ? state.events.map((item) => item.seq) : []).toEqual([1, 2]);
    // 提示位是 liveError 而不是 warning：后者说的是「读文件失败」，两者必须能分开
    expect(state.kind === 'log' ? state.liveError : undefined).toContain('实时通道已断');
    expect(state.kind === 'log' ? state.warning : undefined).toBeUndefined();
  });

  it('两种故障同时存在时不吞任何一条：读失败进 warning、实时通道进 liveError', () => {
    const state = resolveLogDrawer({
      events: [event(1)],
      logError: readFailure,
      streamError: new Error('实时日志连接中断：浏览器会自动重连，已收到的日志不受影响'),
      isLoading: false,
    });

    expect(state.kind === 'log' ? state.warning : undefined).toContain('events.jsonl');
    expect(state.kind === 'log' ? state.liveError : undefined).toContain('实时通道已断');
  });

  it('streamError 为 null/undefined 都不算故障（hook 的初值就是 null）', () => {
    expect(resolveLogDrawer({ events: [], logError: null, streamError: null, isLoading: true })).toEqual({
      kind: 'loading',
    });
    expect(resolveLogDrawer({ events: [], logError: null, streamError: undefined, isLoading: false })).toEqual({
      kind: 'log',
      events: [],
    });
  });

  /**
   * 抽屉有**两条独立的来源**：行级事件（固定事实条与「原始输出」）与内容记录（时间轴）。
   * 一条读不出来不等于没有内容可看——反过来也一样。故 `failed` 只在**两条都空**时才成立。
   */
  it('事件一条都没有但**有内容记录** → 不是 failed（时间轴有东西可画，事件那条路空是正常的）', () => {
    const state = resolveLogDrawer({ events: [], recordCount: 3, logError: readFailure, isLoading: false });
    expect(state.kind).toBe('log');
    expect(state.kind === 'log' ? state.warning : '').toContain('events.jsonl');
  });

  it('两条来源都空且都有错 → failed（两条原因都在，缺一条就少一条排障线索）', () => {
    const state = resolveLogDrawer({
      events: [],
      recordCount: 0,
      logError: readFailure,
      streamError: new Error('实时日志连接中断'),
      isLoading: false,
    });
    expect(state.kind).toBe('failed');
    expect(state.kind === 'failed' ? state.message : '').toContain('events.jsonl');
  });
});

/** 造一行评测：只给 `buildRowFacts` 读的那几格（默认 = 评分中、快照还没写用量） */
function row(overrides: Partial<EvalRow> = {}): EvalRow {
  return {
    id: 'row-1',
    agentKind: 'claude-code',
    providerId: 'p-anthropic',
    providerName: 'Anthropic 网关',
    baseUrl: 'https://gw.example.com/anthropic',
    modelId: 'claude-opus-4-6',
    status: 'judging',
    branch: 'test/row-1',
    workspacePath: 'D:\\runs\\run-1\\rows\\row-1\\workspace',
    baselineCommit: '30b86eedca90b70d15b9eb9e75b454a2574762d4',
    // claude 的跑动期 usage 事件带 `tokensBasis: 'estimated'`（估算不回写快照）⇒ 终态之前
    // `row.tokens` 恒为 null，事实条这一格只能从事件流取。下面守的正是「从**哪一条**事件取」
    tokens: null,
    turns: null,
    durationMs: null,
    diff: null,
    score: null,
    error: null,
    attempts: 1,
    ...overrides,
  };
}

/**
 * 一份完整的评分结果（本文件多条用例共用）。`judgeAgentKind` 由各用例按通路补：
 * `null` = 纯文本 API 通路，非空 = 智能体通路——两条通路的展示面不同，故不写进这份共用夹具。
 */
const SCORE = {
  judgments: [],
  totalScore: 57,
  maxScore: 60,
  verdict: '还行',
  raw: '{}',
  judgeProviderId: 'p-anthropic',
  judgeModelId: 'deepseek-flash',
  judgedAt: '2026-10-07T01:00:00.000Z',
  // 强度未指定（一个强度键都没发）：下面两条用例都不涉及评分者的强度通路
  judgeEffort: null,
  structuredOutput: false,
  // 评分自己的花销：这一格进的是**评分详情抽屉**，不在事实条上，故这里给 null 即可
  judgeTokens: null,
  judgeDurationMs: null,
} satisfies Omit<ScoreResult, 'judgeAgentKind'>;

/**
 * 一条 `usage` 事件：`turn` 缺省 = 主会话读数；`turn.subagentId` **非空**= **那个子会话自己的**读数
 * （`tokens` 是该会话的累计，与这一行的累计不是一把尺子）。
 *
 * `turn` 允许显式 `null`（契约那一格是 `.nullable.optional`，读侧与键缺席同一件事）——用例要能写出
 * 「三档主会话读数」里的中间那一档。
 */
function usageEvent(input: {
  seq: number;
  tokens: UsageTokens | null;
  turns: number;
  turn?: { subagentId: string | null; round: number } | null;
}): AgentEvent {
  return {
    seq: input.seq,
    at: '2026-10-06T01:21:00.000Z',
    type: 'usage',
    tokens: input.tokens,
    turns: input.turns,
    ...(input.turn === undefined ? {} : { turn: input.turn }),
  };
}

/**
 * 事实条的**行级读数只认主会话那一条**。
 *
 * 为什么这一格会被会话尺度读数污染：claude 收尾为每个子会话逐轮发一条 `turn.subagentId` 非空的 `usage`
 * （`tokens` = **该子会话自己的**累计），而它**排在主会话读数之后**；这一格取的是「最后一条 usage」。
 * 真机复算（run `155f7f1e` 的 claude 行）：评分期事实条显示子会话的 16,335，而这一行的权威值是 34,101。
 * 行级读数没有第二个出口可退回——`row.tokens` 在 claude 上终态之前恒为 null。
 */
describe('buildRowFacts：行级读数只认主会话那一条 usage', () => {
  it('带会话身份的 usage 排在最后时，事实条仍取**最后一条主会话读数**', () => {
    const facts = buildRowFacts({
      row: row(),
      events: [
        // 主会话读数（这一行的累计）：收尾之前最后一条
        usageEvent({ seq: 1, tokens: { input: 30580, cached: 59008, output: 3521 }, turns: 6 }),
        // 收尾那批：子会话自己的累计，逐轮一条，排在主会话读数**之后**
        usageEvent({
          seq: 2,
          tokens: { input: 13540, cached: 0, output: 107 },
          turns: 6,
          turn: { subagentId: 'ad10334291b5f86e0', round: 1 },
        }),
        usageEvent({
          seq: 3,
          tokens: { input: 14738, cached: 13568, output: 1597 },
          turns: 6,
          turn: { subagentId: 'ad10334291b5f86e0', round: 2 },
        }),
      ],
    });

    // 行级事实：tok 取主会话那一条（改掉就是真机那次的 16,335 = 14738 + 1597）
    expect(facts.tokens).toEqual({ input: 30580, cached: 59008, output: 3521 });
    expect(facts.turns).toEqual({ current: 6, total: null });
    // 思考 token 那一格**不在这里断**：主会话读数没带 `reasoningOutput` 时它恒为 `null`，删不删身份过滤
    // 都成立 ⇒ 换到下面「主会话带 reasoningOutput」那条用例
  });

  it('主会话三档（turn 缺省 / 显式 null / subagentId === null）照旧被采纳——判据是身份，不是 turn 在不在', () => {
    // **每一档都让它当最后一条**、前面压一条会话尺度读数：只验「最后那一档」的话，另外两档被滤掉
    // 也看不出来（后一条照样给出期望值）——三档必须各自可观察
    const sessionScale = usageEvent({
      seq: 1,
      tokens: { input: 13540, cached: 0, output: 107 },
      turns: 6,
      turn: { subagentId: 'sub-1', round: 1 },
    });

    // ① `turn` 整格缺席（老事件 / 主会话读数不带归属）
    const turnAbsent = buildRowFacts({
      row: row(),
      events: [sessionScale, usageEvent({ seq: 2, tokens: { input: 100, cached: 0, output: 10 }, turns: 2 })],
    });
    // ② 显式 `turn: null`（契约那一格的注释：读侧与键缺席是同一件事）
    const turnNull = buildRowFacts({
      row: row(),
      events: [sessionScale, usageEvent({ seq: 2, tokens: { input: 200, cached: 20, output: 20 }, turns: 3, turn: null })],
    });
    // ③ 显式 `subagentId: null`（主会话身份）
    const subagentIdNull = buildRowFacts({
      row: row(),
      events: [
        sessionScale,
        usageEvent({ seq: 2, tokens: { input: 900, cached: 100, output: 40 }, turns: 4, turn: { subagentId: null, round: 4 } }),
      ],
    });

    // 三档各当一次「最后一条」：任何一档被滤掉，对应的那条断言当场红
    // （判据写成「带 turn 就跳过」红 ②③；写成 `event.turn?.subagentId === null`、丢掉 `?? null` 红 ①②）
    expect(turnAbsent.tokens).toEqual({ input: 100, cached: 0, output: 10 });
    expect(turnNull.tokens).toEqual({ input: 200, cached: 20, output: 20 });
    expect(subagentIdNull.tokens).toEqual({ input: 900, cached: 100, output: 40 });
    expect(subagentIdNull.turns.current).toBe(4);
  });

  /**
   * **身份判据是 `?? null`，不是真值**。
   *
   * 上面那条只钉到「`null` 身份算主会话」，而 `subagentId` 的类型是 `string | null` ⇒ 空串是一个
   * **非 `null` 的身份**：`lastEvent` 的匹配谓词一旦写成真值判断（`!event.turn?.subagentId`），这一条会被
   * 当主会话读数采纳，事实条于是拿会话尺度读数冒充这一行（正是 C1 的形状，只是触发条件从「有身份」
   * 缩成「身份非空串」）。这一条是那道变异体在**本文件**的唯一靶子。
   */
  it('身份判据是「非 null」而不是「非空」：空串身份的 usage 同样不被采纳', () => {
    const facts = buildRowFacts({
      row: row(),
      events: [
        usageEvent({ seq: 1, tokens: { input: 100, cached: 0, output: 10 }, turns: 2 }),
        usageEvent({ seq: 2, tokens: { input: 999, cached: 0, output: 999 }, turns: 9, turn: { subagentId: '', round: 1 } }),
      ],
    });

    expect(facts.tokens).toEqual({ input: 100, cached: 0, output: 10 });
    expect(facts.turns).toEqual({ current: 2, total: null });
  });

  /**
   * **取「最后一条」而不是「第一条」**：`lastEvent` 这一轮从「过滤后取末尾」改写成了
   * 从末尾往前找的那段循环，而新用例里主会话读数**最多一条** ⇒ 方向没有靶子。两条主会话读数**值不同**时，
   * 正向与反向给出的答案不同，这才叫钉住（取第一条会把事实条退回到旧的那条读数）。
   */
  it('主会话读数不止一条时取**后一条**（正向找第一条会拿到旧值）', () => {
    const facts = buildRowFacts({
      row: row(),
      events: [
        usageEvent({ seq: 1, tokens: { input: 10, cached: 0, output: 1 }, turns: 1 }),
        usageEvent({ seq: 2, tokens: { input: 900, cached: 100, output: 40 }, turns: 4 }),
      ],
    });

    expect(facts.tokens).toEqual({ input: 900, cached: 100, output: 40 });
    expect(facts.turns).toEqual({ current: 4, total: null });
  });

  /**
   * **思考 token 那一格与 `tokens` 同源**（都取自那一条被采纳的主会话读数）：会话尺度读数里没有这一格
   * ⇒ 不许把它清掉。⚠️ 这一格必须是**有区分力的**形状：主会话读数带
   * `reasoningOutput`、会话尺度读数不带 ⇒ 删掉身份过滤时这一格会变成 `null`；原来那条断言写成
   * `toBeNull`，删不删过滤都成立 ——它谁也钉不住。
   */
  it('主会话读数带 reasoningOutput 时思考那一格留着（会话尺度读数不许把它清掉）', () => {
    const facts = buildRowFacts({
      row: row(),
      events: [
        usageEvent({ seq: 1, tokens: { input: 30580, cached: 59008, output: 3521, reasoningOutput: 2495 }, turns: 6 }),
        usageEvent({
          seq: 2,
          tokens: { input: 13540, cached: 0, output: 107 },
          turns: 6,
          turn: { subagentId: 'ad10334291b5f86e0', round: 1 },
        }),
        usageEvent({
          seq: 3,
          tokens: { input: 14738, cached: 13568, output: 1597 },
          turns: 6,
          turn: { subagentId: 'ad10334291b5f86e0', round: 2 },
        }),
      ],
    });

    // 本用例**只有这一条断言**：删掉身份过滤时它是第一个（也是唯一一个）红的（actual 会变成 null）
    expect(facts.thinking).toEqual({ tokens: 2495, basis: 'subset-of-output' });
  });
});

/**
 * 领域事实的**分段**：改动那一格按 git stat 上色（`+N` 绿 / `−N` 红）。
 * 评分那一格**只给分**——同一天的另一条口径把「评分模型：…」那句提示删了，
 * 因为尺子是谁由**评分详情**那一页说，事实条上再写一遍是与它争夺注意力。
 *
 * 为什么守在这里：分段是**数据层声明**的（界面不解析文本，见 `DomainFactSegment` 的注释），
 * 而 `value` 是给读屏与排障用的纯文本——两者必须逐字一致。手写第二遍数字就会漂移，
 * 症状是「复制出来的那一串字」与眼睛看到的不是一件事，且**没有任何别的地方会红**。
 */
describe('buildRowFacts：领域事实的分段', () => {
  it('改动那一格：分段拼起来逐字等于 `value`，且只有 `+N` / `−N` 两段带色档', () => {
    const facts = buildRowFacts({
      row: row({ diff: { filesChanged: 1, insertions: 111, deletions: 0, truncated: false } }),
      events: [],
    });

    const diff = facts.domain.find((fact) => fact.id === 'diff');
    expect(diff?.value).toBe('1 个文件 +111 −0');
    expect(diff?.segments).toEqual([
      { text: '1 个文件 ' },
      { text: '+111', tone: 'insertion' },
      { text: ' −0', tone: 'deletion' },
    ]);
    // 逐字同源：分段拼起来就是 `value`（两处不一致时这条先红）
    expect(diff?.segments?.map((segment) => segment.text).join('')).toBe(diff?.value);
    // 整格**不再**给色档：它按 git stat 排版，渲染层据此不再套 Tag
    expect(diff?.tone).toBeUndefined();
  });

  it('评分那一格只给分：不再产出「评分模型：…」那句提示（两条通路都不给）', () => {
    const textPath = buildRowFacts({ row: row({ score: { ...SCORE, judgeAgentKind: null } }), events: [] });
    const textCell = textPath.domain.find((fact) => fact.id === 'score');
    expect(textCell?.value).toBe('57/60');
    expect(textCell?.tone).toBe('success');
    // 靶子是那句被删掉的提示：把 `hint` / `hintSegments` 加回来这条就红
    expect(textCell?.hint).toBeUndefined();
    expect(textCell?.hintSegments).toBeUndefined();

    // 智能体通路**同一口径**：一条给一条不给，会让人以为只有文本通路才说得出尺子是谁
    const agentPath = buildRowFacts({ row: row({ score: { ...SCORE, judgeAgentKind: 'claude-code' } }), events: [] });
    const agentCell = agentPath.domain.find((fact) => fact.id === 'score');
    expect(agentCell?.hint).toBeUndefined();
    expect(agentCell?.hintSegments).toBeUndefined();
  });

  /**
   * 「谁在跑」三格：智能体 · 模型 · 思考强度**排在最前**。
   *
   * 为什么钉在这里：这三格与「改动 / 评分」同属固定区的**第二行**（`agent-log-domain-facts.tsx`），
   * 顺序即渲染顺序 ⇒ 顺序只能由数据层保证。值走 `segments` 的 `tag` 段、一色一格
   * （`blue` / `geekblue` / `purple`），与评分详情顶部那一段同色。
   */
  it('「谁在跑」三格在最前：智能体 → 模型 → 思考强度（一色一格），改动与评分在后', () => {
    const facts = buildRowFacts({
      row: row({
        effort: 'max',
        diff: { filesChanged: 1, insertions: 2, deletions: 3, truncated: false },
        score: { ...SCORE, judgeAgentKind: null },
      }),
      events: [],
    });

    expect(facts.domain.map((fact) => fact.id)).toEqual(['agent', 'model', 'effort', 'diff', 'score']);

    const agent = facts.domain[0];
    expect(agent?.label).toBe('智能体');
    expect(agent?.value).toBe(AGENT_LABELS['claude-code']);
    expect(agent?.segments).toEqual([{ text: AGENT_LABELS['claude-code'], tag: true, tagTone: 'blue' }]);
    expect(facts.domain[1]?.segments).toEqual([{ text: 'claude-opus-4-6', tag: true, tagTone: 'geekblue' }]);
    expect(facts.domain[2]?.value).toBe('max');
    expect(facts.domain[2]?.segments).toEqual([{ text: 'max', tag: true, tagTone: 'purple' }]);
  });

  /**
   * 思考强度键**缺席**（老快照没有这一格）⇒「未指定」。
   * 反向那一半：**不是** `off`——显式关闭档是一个真实读数，与「没这一格」不是同一件事。
   */
  it('思考强度键缺席 ⇒「未指定」，不是 `off`、也不是空白', () => {
    const effort = buildRowFacts({ row: row(), events: [] }).domain.find((fact) => fact.id === 'effort');

    expect(effort?.value).toBe('未指定');
    expect(effort?.value).not.toBe('off');
    expect(effort?.value).not.toBe('');
  });
});
