/**
 * 跑动期的实时指标（用户口径，2026-09-26）：tok / 轮次 / **开始时刻**。
 *
 * 为什么需要它：行结束之前快照里 `tokens/turns/durationMs` 都是 null，界面只能显示「未采集」。
 * 事件流里其实早就有答案（`usage` 事件按轮次推、`status: running` 事件带 `at`），
 * 这个模块把事件折成界面要的三个数：
 *   · `startedAtMs` 取自**第一条 `status: running` 的 `at`**——界面靠它本地走秒表（每行开始时刻不同）；
 *   · `tokens` / `turns` 取**最后一条 `usage`**（事件里的值已经是「到目前为止」的累计口径，
 *     这里只做「最新值」，不自己再累加一遍）。
 *
 * 三条折叠规则必须有区分力（各自的用例在下面）：
 *   ① **旧帧不回退**：重连时服务端会把边界那条再推一遍，它不能把新的数改回旧的；
 *   ② **seq 回到 1 = 新一代**：同一行重跑（编排层会先删掉事件日志，seq 重新从 1 发号）时，
 *      上一轮的指标必须清掉——否则界面会拿旧一轮的 tok 冒充新一轮的起手值；
 *   ③ 终态帧之后**这一行的连接要关掉**（值由快照接管），且不能牵连别行的连接；
 *   ④ **进评分即冻结**（用户口径，2026-09-29）：`status: judging` 之后的 `usage` 报的是**评审者**的
 *      用量（评分智能体跑在同一个工作区、事件进同一条流），一律不再折进候选的 tok / 轮次。
 */
import { createElement, type ReactNode } from 'react';
import { SWRConfig } from 'swr';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { AgentEvent } from '@aieval/contracts';
import { LIVE_TEXT_SAMPLE, foldLiveMetrics, useRunLiveMetrics } from './row-live';
import { useRun, useRuns } from './runs';
import { FakeEventSource, installEventSourceStub } from './testing/event-source';
import { makeEvent, makeRun } from './testing/run-fixtures';

type FetchHandler = (url: string, init?: RequestInit) => Promise<Response>;
type FetchMock = Mock<FetchHandler>;

const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(SWRConfig, { value: { provider: () => new Map() } }, children);

/** SSE 的 `data:` 行内容就是一条事件的 JSON（与 api 的 toFrame 逐字同形） */
function frame(event: AgentEvent): string {
  return JSON.stringify(event);
}

/** 三行事件：准备中 → 跑起来（带 at）→ 一条用量 */
const START_AT = '2026-09-22T08:01:30.000Z';
function historyFor(rowId: string): AgentEvent[] {
  return [
    makeEvent({ seq: 1, type: 'status', status: 'preparing' }),
    makeEvent({ seq: 2, type: 'status', status: 'running', at: START_AT }),
    makeEvent({ seq: 3, type: 'usage', tokens: { input: 100, cached: 10, output: 20 }, turns: 1 }),
  ];
}

/** /log 按行 id 分发历史；两个快照端点返回**已终态**的轮（不轮询，请求只可能来自显式 mutate） */
function stubFetch(histories: Record<string, AgentEvent[]>): FetchMock {
  const fetchMock = vi.fn<FetchHandler>(async (url: string) => {
    const target = String(url);
    const matched = /\/rows\/([^/]+)\/log$/.exec(target);
    if (matched !== null) {
      return new Response(JSON.stringify(histories[matched[1] ?? ''] ?? []), { status: 200 });
    }
    if (target === '/api/runs') return new Response(JSON.stringify([makeRun()]), { status: 200 });
    if (target === '/api/runs/run-1') return new Response(JSON.stringify(makeRun()), { status: 200 });
    return new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: '没有这个路由' } }), { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** 挂上两行的实时订阅（多行是本 hook 存在的前提：详情页上并行的每一行都要有数） */
function mountLive(rowIds: string[] = ['w-1', 'w-2']) {
  return renderHook(() => useRunLiveMetrics({ runId: 'run-1', rowIds }), { wrapper });
}

beforeEach(() => {
  FakeEventSource.reset();
  installEventSourceStub();
});

/**
 * 文本采样节奏是**可变对象**（与 `TEXT_API_RETRY` / `ROW_RETRY` 同一约定）：用例把它调小，
 * 免得每条用例都真等一秒。**产品默认值必须有独立用例钉住**（否则它成了无人验证的常量），
 * `afterEach` 必须还原——三条都是 AGENT.md 里那条约定的原文。
 */
const DEFAULT_SAMPLE_MS = LIVE_TEXT_SAMPLE.intervalMs;

afterEach(() => {
  LIVE_TEXT_SAMPLE.intervalMs = DEFAULT_SAMPLE_MS;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('foldLiveMetrics（纯折叠）', () => {
  it('开始时刻取第一条 status: running 的 at；准备中不算开始', () => {
    const folded = foldLiveMetrics([
      makeEvent({ seq: 1, type: 'status', status: 'preparing', at: '2026-09-22T08:00:00.000Z' }),
      makeEvent({ seq: 2, type: 'status', status: 'running', at: START_AT }),
      makeEvent({ seq: 3, type: 'status', status: 'judging', at: '2026-09-22T08:09:00.000Z' }),
    ]);

    expect(folded.startedAtMs).toBe(Date.parse(START_AT));
  });

  it('一条 status: running 都没有时为 null（界面据此退回快照里的耗时）', () => {
    expect(foldLiveMetrics([makeEvent({ seq: 1, type: 'status', status: 'preparing' })]).startedAtMs).toBeNull();
  });

  it('tok / 轮次取**最后一条** usage（事件里的值本身就是累计口径，这里不自己再加一遍）', () => {
    const folded = foldLiveMetrics([
      makeEvent({ seq: 1, type: 'usage', tokens: { input: 100, cached: 10, output: 20 }, turns: 1 }),
      makeEvent({ seq: 2, type: 'usage', tokens: { input: 400, cached: 60, output: 52 }, turns: 3 }),
    ]);

    expect(folded.tokens).toEqual({ input: 400, cached: 60, output: 52 });
    expect(folded.turns).toBe(3);
  });

  /**
   * 只带轮次的 `usage` 是**常态**（2026-09-28：轮次每到一次模型往返就发一条，而 token 常常采不到）。
   * 它绝不能把已经显示出来的 tok 清掉——整条事件是覆盖语义，`tokens: null` 必须理解成「这一条没带计量」，
   * 否则界面上的 tok 会在轮次跳动时反复掉回「采集中」（数字往回流比不显示更糟）。
   */
  it('只带轮次的 usage 不清掉已经采到的 tok（tokens: null = 这一条没带计量）', () => {
    const folded = foldLiveMetrics([
      makeEvent({ seq: 1, type: 'usage', tokens: { input: 400, cached: 60, output: 52 }, turns: 1 }),
      makeEvent({ seq: 2, type: 'usage', tokens: null, turns: 2 }),
      makeEvent({ seq: 3, type: 'usage', tokens: null, turns: 3 }),
    ]);

    expect(folded.turns).toBe(3);
    expect(folded.tokens).toEqual({ input: 400, cached: 60, output: 52 });
  });

  it('旧 seq 的重复帧不回退（重连时服务端会把边界那条再推一遍）', () => {
    const folded = foldLiveMetrics([
      makeEvent({ seq: 1, type: 'usage', tokens: { input: 100, cached: 0, output: 5 }, turns: 1 }),
      makeEvent({ seq: 3, type: 'usage', tokens: { input: 300, cached: 0, output: 9 }, turns: 2 }),
      // 重放：seq 3 又推了一遍，之后又来一条更旧的 seq 2（乱序 / 截断后的残留）
      makeEvent({ seq: 3, type: 'usage', tokens: { input: 300, cached: 0, output: 9 }, turns: 2 }),
      makeEvent({ seq: 2, type: 'usage', tokens: { input: 100, cached: 0, output: 5 }, turns: 1 }),
    ]);

    expect(folded.turns).toBe(2);
    expect(folded.tokens).toEqual({ input: 300, cached: 0, output: 9 });
  });

  it('seq 回到 1 = 新一代：上一轮的指标被清掉（重跑不能拿旧数当起手值）', () => {
    const folded = foldLiveMetrics([
      makeEvent({ seq: 1, type: 'status', status: 'running', at: START_AT }),
      makeEvent({ seq: 2, type: 'usage', tokens: { input: 900, cached: 0, output: 90 }, turns: 9 }),
      // 重跑：编排层删掉事件日志，seq 从 1 重新发号，新一轮刚开始（只有 preparing）
      makeEvent({ seq: 1, type: 'status', status: 'preparing', at: '2026-09-22T09:00:00.000Z' }),
    ]);

    expect(folded.tokens).toBeNull();
    expect(folded.turns).toBeNull();
    expect(folded.startedAtMs).toBeNull();
    // 活动行的文字同样归零：上一轮的残留文本会冒充新一轮的输出（界面直接把这段文字滚出来）
    expect(folded.latestText).toBeNull();
  });

  /**
   * 跑动期的**智能体活动文本**（用户口径，2026-09-29）：候选卡片底部那一行显示的是智能体
   * 最近一条输出。它与上面三个数同源（同一条 SSE），但**各管各的**：
   *   · 只有 `log` 事件能改它（`usage` / `status` 帧不许把文字顶掉）；
   *   · 空文本的 log **不清空**已显示的文字（清空的表现是那一行突然变成空白）。
   */
  it('latestText 取**最后一条** log 的文本，别的类型的事件不动它', () => {
    const folded = foldLiveMetrics([
      makeEvent({ seq: 1, type: 'status', status: 'running', at: START_AT }),
      makeEvent({ seq: 2, type: 'log', stream: 'stdout', text: '正在读 lib/http.js' }),
      makeEvent({ seq: 3, type: 'usage', tokens: { input: 10, cached: 0, output: 2 }, turns: 1 }),
      makeEvent({ seq: 4, type: 'log', stream: 'stderr', text: '[WARN] 用量负载不完整' }),
    ]);

    expect(folded.latestText).toBe('[WARN] 用量负载不完整');
    // 计量照旧（两条通路互不覆盖）
    expect(folded.turns).toBe(1);
  });

  it('空文本的 log 不把这一行清成空白', () => {
    const folded = foldLiveMetrics([
      makeEvent({ seq: 1, type: 'log', stream: 'stdout', text: '有内容' }),
      makeEvent({ seq: 2, type: 'log', stream: 'stdout', text: '' }),
    ]);

    expect(folded.latestText).toBe('有内容');
  });

  it('旧 seq 的 log 帧不回退文本（重连会把边界那条再推一遍）', () => {
    const folded = foldLiveMetrics([
      makeEvent({ seq: 1, type: 'log', stream: 'stdout', text: '旧' }),
      makeEvent({ seq: 5, type: 'log', stream: 'stdout', text: '新' }),
      makeEvent({ seq: 2, type: 'log', stream: 'stdout', text: '旧（重放）' }),
    ]);

    expect(folded.latestText).toBe('新');
  });

  /**
   * **JSON 不是消息**（用户口径，2026-09-29 修正）。
   *
   * 适配器把厂商信封原样落盘是**证据**（§5.6.3，抽屉里逐字可见），但把
   * `{"method":"session.event","params":{…}}` 滚到卡片上就是拿 JSON 冒充消息——真机实测：
   * dsh 行的 `log.text` 有 142 条里绝大多数是这种信封，界面上那一行于是成了一坨 JSON。
   * 三档判据（`activityOf`）：有 `summary` 用 summary；没有摘要且文本是 JSON ⇒ 保留上一句；
   * 其余就是人写的文本。
   */
  it('有 summary 时显示 summary（适配器给的那句人话），而不是同一行的原始 JSON', () => {
    const folded = foldLiveMetrics([
      makeEvent({
        seq: 1,
        type: 'log',
        stream: 'stdout',
        text: '{"method":"session.event","params":{"event":{"type":"tool/call"}}}',
        summary: '调用 pwsh：npm run build-only',
      }),
    ]);

    expect(folded.latestText).toBe('调用 pwsh：npm run build-only');
  });

  it('没有摘要的 JSON 行**不当消息**：保留上一句，既不显示 JSON 也不清空', () => {
    const folded = foldLiveMetrics([
      makeEvent({ seq: 1, type: 'log', stream: 'stdout', text: '正在读 lib/http.js' }),
      // 形状照真机：`step/end` 这类信封适配器不给摘要，原样落盘
      makeEvent({
        seq: 2,
        type: 'log',
        stream: 'stdout',
        text: '{"method":"session.event","params":{"event":{"type":"step/end","seq":178}}}',
      }),
    ]);

    expect(folded.latestText).toBe('正在读 lib/http.js');
  });

  it('第一帧就是 JSON 时这一格保持 null（界面回落成状态文案，而不是滚一坨 JSON）', () => {
    const folded = foldLiveMetrics([
      makeEvent({ seq: 1, type: 'log', stream: 'stdout', text: '[{"type":"tool_use","name":"Read"}]' }),
    ]);

    expect(folded.latestText).toBeNull();
  });

  it('只是**前缀**像 JSON 的行当人话处理（解析不动就不是机器负载，不许被吞掉）', () => {
    // 「`[WARN] …` 别被吞掉」那一半由上面「取最后一条 log」那条既有用例钉着（它的末条正是 `[WARN] …`，
    // 本规则第一版只看前缀时就是它红的）；这里补的是另一半：`{` 开头但根本不是 JSON 的日志行。
    const folded = foldLiveMetrics([makeEvent({ seq: 1, type: 'log', stream: 'stderr', text: '{不是 JSON 的日志行' })]);

    expect(folded.latestText).toBe('{不是 JSON 的日志行');
  });

  it('**摘要本身**是 JSON 时也不当消息（评分阶段模型吐的就是 JSON 评分结果）', () => {
    // 适配器把 assistant/message 的原文压成一行摘要发下来，而评分那一轮的原文就是一坨 JSON——
    // 只判 `text` 不判 `summary` 的话，卡片上照样会滚出一串 JSON
    const folded = foldLiveMetrics([
      makeEvent({ seq: 1, type: 'log', stream: 'stdout', text: '正在读 lib/http.js' }),
      makeEvent({
        seq: 2,
        type: 'log',
        stream: 'stdout',
        text: '{"dimensions":[{"key":"correctness","score":4}],"totalScore":84}',
        summary: '{"dimensions":[{"key":"correctness","score":4}],"totalScore":84}',
      }),
    ]);

    expect(folded.latestText).toBe('正在读 lib/http.js');
  });

  it('评分阶段的消息照样滚动（判据与候选阶段同一份：只有 usage 被冻结，活动消息不冻）', () => {
    const folded = foldLiveMetrics([
      makeEvent({ seq: 1, type: 'status', status: 'judging', at: START_AT }),
      makeEvent({ seq: 2, type: 'log', stream: 'stdout', text: '{"method":"session.event"}', summary: '调用工具 read：评分标准.md' }),
    ]);

    expect(folded.candidateEnded).toBe(true);
    expect(folded.latestText).toBe('调用工具 read：评分标准.md');
  });

  it('**前缀标签 + JSON** 也不当消息（评分智能体转发出来的正是这种形状）', () => {
    // 真机踩到：评分阶段转发出来的日志是 `[评分智能体] {"method":"session.event",…}`——
    // 只判整串开头（`[` 后面跟的是中文）会把它当人话放行，卡片上于是滚出一坨 JSON
    const folded = foldLiveMetrics([
      makeEvent({ seq: 1, type: 'log', stream: 'stdout', text: '候选：正在读 lib/http.js' }),
      makeEvent({
        seq: 2,
        type: 'log',
        stream: 'stdout',
        text: '[评分智能体] {"method":"session.event","params":{"sessionId":"s-1"}}',
      }),
    ]);

    expect(folded.latestText).toBe('候选：正在读 lib/http.js');
  });

  it('戴了前缀的**人话**照常显示（判据只清洗机器负载，不清洗历史消息）', () => {
    // 新数据里卡片上不会再出现转发前缀（摘要不带前缀，见 `judge-agent.ts`）；这一条钉的是
    // **老数据**：磁盘上已有的行 `text` 是带前缀的，回放时只要它是人话就照原样显示——
    // 判据只负责把机器负载挡在门外，不做「把前缀剪掉」的清洗（剪错了就静默改写了别人的日志）
    const folded = foldLiveMetrics([
      makeEvent({ seq: 1, type: 'log', stream: 'stdout', text: '[评分智能体] 调用工具 read：README.md' }),
    ]);

    expect(folded.latestText).toBe('[评分智能体] 调用工具 read：README.md');
  });
});

/**
 * **候选阶段结束即冻结**（用户口径，2026-09-29：「只展示执行的 tok 和 轮次，评分不应该覆盖此信息」）。
 *
 * 评分智能体跑在候选**同一个工作区**里，事件也被转发进同一行同一条流（`judgeRowByAgent`），
 * 于是 `status: judging` 之后每一条 `usage` 报的都是**评审者**的用量：轮次从 1 重新数、token 是
 * 评审者自己的。真机实测（run `bea0564d` 的 codex 行）：候选收尾上报 `input 483,723 /
 * cached 455,552 / output 7,183`、`turns 28`，随后评分阶段推来十几条 `turns 1..13` 的小用量——
 * 卡片上那几格当时显示的是 `tok 13,715 / 缓存命中 45% / 轮次 2`，全是评审者的数字。
 *
 * 五条判据（每条都在下面有靶子）：
 *   ① `judging` 之后的 `usage` 一律不进 `tokens` / `turns`；
 *   ② 结束点记在 `candidateEndedAtMs`（界面靠它停表）；
 *   ③ `preparing` / `pending` **不算**结束——认了等于这一行还没跑就被冻住；
 *   ④ 候选**失败**的行同样冻结，且结束点是失败那一刻：它过一会儿可能被「重新评分」，
 *      拿那时才出现的 `judging` 当结束点会把中间的空档算进候选耗时；
 *   ⑤ `seq` 回到 1（重跑）时冻结一起清掉——否则新一轮的数字一个都进不来。
 */
describe('foldLiveMetrics：候选阶段结束即冻结（口径 5）', () => {
  /** 候选收尾的那一条上报（实测值） */
  const CANDIDATE_USAGE = { input: 483_723, cached: 455_552, output: 7_183 };
  const JUDGE_AT = '2026-09-22T08:03:29.343Z';

  it('judging 之后的 usage 不覆盖候选的 tok / 轮次', () => {
    const folded = foldLiveMetrics([
      makeEvent({ seq: 1, type: 'status', status: 'running', at: START_AT }),
      makeEvent({ seq: 2, type: 'usage', tokens: CANDIDATE_USAGE, turns: 28 }),
      makeEvent({ seq: 3, type: 'status', status: 'judging', at: JUDGE_AT }),
      // 评分智能体的用量：轮次重新从 1 数起，tok 只有候选的零头
      makeEvent({ seq: 4, type: 'usage', tokens: { input: 10_834, cached: 0, output: 89 }, turns: 1 }),
      makeEvent({ seq: 5, type: 'usage', tokens: { input: 13_204, cached: 10_816, output: 511 }, turns: 2 }),
    ]);

    expect(folded.tokens).toEqual(CANDIDATE_USAGE);
    expect(folded.turns).toBe(28);
    // 冻结生效，且结束点就是 judging 那一刻（界面用它停表）
    expect(folded.candidateEnded).toBe(true);
    expect(folded.candidateEndedAtMs).toBe(Date.parse(JUDGE_AT));
    // 计数口径：tok 仍是输入 + 输出（缓存读单列在「缓存命中」），13,715 那个数绝不出现
    expect(folded.tokens === null ? null : folded.tokens.input + folded.tokens.output).toBe(490_906);
  });

  it('候选阶段进行中不冻结（此刻的 usage 就是候选自己的）', () => {
    const folded = foldLiveMetrics([
      makeEvent({ seq: 1, type: 'status', status: 'preparing', at: START_AT }),
      makeEvent({ seq: 2, type: 'status', status: 'running', at: START_AT }),
      makeEvent({ seq: 3, type: 'usage', tokens: { input: 100, cached: 10, output: 20 }, turns: 2 }),
    ]);

    expect(folded.candidateEnded).toBe(false);
    expect(folded.candidateEndedAtMs).toBeNull();
    expect(folded.turns).toBe(2);
  });

  it('串行排队的 pending 不算「候选阶段结束」（认了等于这一行还没跑就被冻住）', () => {
    const folded = foldLiveMetrics([
      makeEvent({ seq: 1, type: 'status', status: 'pending', at: START_AT }),
      makeEvent({ seq: 2, type: 'status', status: 'running', at: START_AT }),
      makeEvent({ seq: 3, type: 'usage', tokens: { input: 100, cached: 10, output: 20 }, turns: 2 }),
    ]);

    expect(folded.candidateEnded).toBe(false);
    expect(folded.turns).toBe(2);
  });

  it('候选失败也冻结，且结束点是**失败那一刻**（重评时那条 judging 出现在几十分钟后）', () => {
    const failedAt = '2026-09-22T08:01:45.000Z';
    const folded = foldLiveMetrics([
      makeEvent({ seq: 1, type: 'status', status: 'running', at: START_AT }),
      makeEvent({ seq: 2, type: 'usage', tokens: { input: 19_853, cached: 0, output: 0 }, turns: 3 }),
      makeEvent({ seq: 3, type: 'status', status: 'failed', at: failedAt }),
      // 几十分钟后用户点了「重新评分」：状态回到 judging，评审者开始报用量
      makeEvent({ seq: 4, type: 'status', status: 'judging', at: '2026-09-22T08:40:00.000Z' }),
      makeEvent({ seq: 5, type: 'usage', tokens: { input: 100, cached: 0, output: 10 }, turns: 1 }),
    ]);

    expect(folded.candidateEndedAtMs).toBe(Date.parse(failedAt));
    expect(folded.turns).toBe(3);
    expect(folded.tokens).toEqual({ input: 19_853, cached: 0, output: 0 });
  });

  it('seq 回到 1 = 新一代：冻结一起清掉（重跑的行不能一上来就被冻住）', () => {
    const folded = foldLiveMetrics([
      makeEvent({ seq: 1, type: 'status', status: 'running', at: START_AT }),
      makeEvent({ seq: 2, type: 'usage', tokens: CANDIDATE_USAGE, turns: 28 }),
      makeEvent({ seq: 3, type: 'status', status: 'judged', at: JUDGE_AT }),
      // 重跑：事件日志被删掉、seq 从 1 重新发号
      makeEvent({ seq: 1, type: 'status', status: 'preparing', at: '2026-09-22T09:00:00.000Z' }),
      makeEvent({ seq: 2, type: 'status', status: 'running', at: '2026-09-22T09:00:05.000Z' }),
      makeEvent({ seq: 3, type: 'usage', tokens: { input: 7, cached: 0, output: 3 }, turns: 1 }),
    ]);

    expect(folded.candidateEnded).toBe(false);
    expect(folded.candidateEndedAtMs).toBeNull();
    expect(folded.turns).toBe(1);
    expect(folded.tokens).toEqual({ input: 7, cached: 0, output: 3 });
  });
});

describe('useRunLiveMetrics', () => {
  it('为每一行各开一条连接，afterSeq 取该行历史的最后 seq', async () => {
    stubFetch({
      'w-1': historyFor('w-1'),
      'w-2': [makeEvent({ seq: 1, type: 'status', status: 'preparing' })],
    });

    const { result } = mountLive();

    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(2));
    const urls = FakeEventSource.instances.map((source) => source.url).sort();
    expect(urls).toEqual([
      '/api/runs/run-1/rows/w-1/stream?afterSeq=3',
      '/api/runs/run-1/rows/w-2/stream?afterSeq=1',
    ]);
    // 历史里的值已经在界面上了（不必等第一帧推送）
    await waitFor(() => expect(result.current['w-1']?.turns).toBe(1));
    expect(result.current['w-1']?.startedAtMs).toBe(Date.parse(START_AT));
    expect(result.current['w-2']?.startedAtMs).toBeNull();
  });

  it('具名事件到达时只更新**那一行**（多行共用一份 state 时最容易串行）', async () => {
    stubFetch({
      'w-1': historyFor('w-1'),
      'w-2': [makeEvent({ seq: 1, type: 'status', status: 'running', at: START_AT })],
    });

    const { result } = mountLive();
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(2));
    const byRow = new Map(FakeEventSource.instances.map((source) => [source.url, source]));
    const w2 = byRow.get('/api/runs/run-1/rows/w-2/stream?afterSeq=1');

    await act(async () => {
      const usage = makeEvent({ seq: 2, type: 'usage', tokens: { input: 7, cached: 1, output: 2 }, turns: 4 });
      w2?.emitNamed(usage.type, frame(usage));
    });

    expect(result.current['w-2']?.turns).toBe(4);
    expect(result.current['w-2']?.tokens).toEqual({ input: 7, cached: 1, output: 2 });
    // w-1 一动不动
    expect(result.current['w-1']?.turns).toBe(1);
  });

  it('终态帧到达：关掉**这一行**的连接并刷一次快照，别行的连接不受影响', async () => {
    const fetchMock = stubFetch({
      'w-1': historyFor('w-1'),
      'w-2': [makeEvent({ seq: 1, type: 'status', status: 'running', at: START_AT })],
    });

    // 终态刷新的是详情与列表两个键：挂上消费者它们的键才有 fetcher（真实页面里它们一定在）
    const { result } = renderHook(
      () => ({
        runs: useRuns(),
        detail: useRun('run-1'),
        live: useRunLiveMetrics({ runId: 'run-1', rowIds: ['w-1', 'w-2'] }),
      }),
      { wrapper },
    );
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(2));
    const byRow = new Map(FakeEventSource.instances.map((source) => [source.url, source]));
    const w1 = byRow.get('/api/runs/run-1/rows/w-1/stream?afterSeq=3');
    const w2 = byRow.get('/api/runs/run-1/rows/w-2/stream?afterSeq=1');
    const before = fetchMock.mock.calls.length;

    await act(async () => {
      const end = makeEvent({ seq: 4, type: 'end', exitReason: 'completed' });
      w1?.emitNamed('end', frame(end));
    });

    expect(w1?.closeCount).toBe(1);
    expect(w2?.closeCount).toBe(0);
    // mutate 详情 + 列表各一次（终态之后界面显示的是快照里的权威值）
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(before + 2));
    expect(result.current.live['w-1']?.turns).toBe(1);
  });

  it('日志帧到达时**不逐帧**重渲染（一两千条日志逐帧 setState = 每秒几十次整页渲染）', async () => {
    // 采样节奏调到 60s：这条用例只问「帧本身有没有触发 setState」，采样定时器不许在这中间插一脚
    LIVE_TEXT_SAMPLE.intervalMs = 60_000;
    stubFetch({ 'w-1': historyFor('w-1') });

    const { result } = mountLive(['w-1']);
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const source = FakeEventSource.instances[0];
    const before = result.current;

    await act(async () => {
      // 一行日志：它改的是活动文本（见下面那一小节），而那三个数与它无关 ⇒ 这一刻不该有任何状态更新
      const log = makeEvent({ seq: 4, type: 'log', stream: 'stdout', text: '改了一个文件' });
      source?.emitNamed(log.type, frame(log));
    });

    // 同一份引用 = 没有 setState。文字改由**采样定时器**按固定节奏推送（下一条用例），
    // 于是一行推来几千条日志的代价是每秒一次重渲染，而不是每秒几十次。
    expect(result.current).toBe(before);
  });

  it('没有在跑的行时不发任何请求（详情没打开 / 都在终态）', async () => {
    const fetchMock = stubFetch({});

    const { result } = mountLive([]);

    expect(result.current).toEqual({});
    expect(FakeEventSource.instances).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  /**
   * 活动文本的**采样发布**（用户口径，2026-09-29）。
   * 上面那条守卫要求「日志帧不逐帧 setState」，而候选卡片底部那一行又必须显示最新输出
   * ⇒ 两条同时成立的唯一形状是「**帧只折进状态，发布交给定时器**」：帧率再高，
   * 重渲染也只是一秒一次。三条口径：① 文本按采样节奏到达；② 没有新文本就不发布；
   * ③ 定时器随 effect 清掉（页面反复开关详情不该攒下一堆每秒跑一次的定时器）。
   */
  it('日志帧的文字在下一次采样时进入 state（帧本身不发布，见上一条）', async () => {
    LIVE_TEXT_SAMPLE.intervalMs = 10;
    stubFetch({ 'w-1': historyFor('w-1') });

    const { result } = mountLive(['w-1']);
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const source = FakeEventSource.instances[0];

    await act(async () => {
      const log = makeEvent({ seq: 4, type: 'log', stream: 'stdout', text: '正在改 lib/http.js' });
      source?.emitNamed(log.type, frame(log));
    });

    await waitFor(() => expect(result.current['w-1']?.latestText).toBe('正在改 lib/http.js'));
    // 采样只带文本：历史里折出来的那三个数照旧，不被这一路覆盖
    expect(result.current['w-1']?.turns).toBe(1);
    expect(result.current['w-1']?.startedAtMs).toBe(Date.parse(START_AT));
  });

  it('没有新文本时采样不发布（空转的定时器不该每秒把整页重渲染一次）', async () => {
    LIVE_TEXT_SAMPLE.intervalMs = 10;
    stubFetch({ 'w-1': historyFor('w-1') });

    const { result } = mountLive(['w-1']);
    await waitFor(() => expect(result.current['w-1']?.turns).toBe(1));
    const before = result.current;

    // 空转若干个采样周期：一个字段都没变
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
    });

    expect(result.current).toBe(before);
  });

  it('采样定时器按产品默认节奏建、并在卸载时清掉（每秒一次的定时器不能泄漏）', async () => {
    const setSpy = vi.spyOn(globalThis, 'setInterval');
    const clearSpy = vi.spyOn(globalThis, 'clearInterval');
    stubFetch({ 'w-1': historyFor('w-1') });

    const { unmount } = mountLive(['w-1']);
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));

    // 产品默认节奏：`LIVE_TEXT_SAMPLE` 是可变对象，默认值必须有用例钉住（AGENT.md 的既有口径）
    expect(DEFAULT_SAMPLE_MS).toBe(1000);
    const index = setSpy.mock.calls.findIndex(([, delay]) => delay === DEFAULT_SAMPLE_MS);
    expect(index, '没有按 LIVE_TEXT_SAMPLE.intervalMs 建采样定时器').toBeGreaterThanOrEqual(0);
    const handle = setSpy.mock.results[index]?.value;

    unmount();

    expect(clearSpy).toHaveBeenCalledWith(handle);
  });
});
