// @vitest-environment node
/**
 * `events.ts` 的行为契约：app-server 通知 → 行级事件与 `TurnProjection`。
 *
 * 逐条钉住计划表的行级那几格：增量给不给轮次、`turn/completed` 的计量与时长、
 * 失败/中止的分档、按线程的用量累计、未识别通知不丢。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { TurnState } from '../../turn';
import { createTurnState } from '../../testing/agent-fixtures';
import { readNotification, type AppServerItem, type AppServerNotificationPayload } from './appserver/protocol';
import { breakdownToTokens, projectCodexEvent, turnTimingOf, type CodexEventContext } from './events';
import { createCodexRunState, type CodexRunState } from './run-state';

const MAIN = 'thread-main';
const CONTEXT: CodexEventContext = { kind: 'codex', baseUrl: 'https://gw.example.com/v1', mainThreadId: MAIN };

/** 一件 `agentMessage` 条目（事件层只关心它的 id 与类型） */
function agentMessage(id: string, text = '好'): AppServerItem {
  return { kind: 'agentMessage', id, text, phase: null };
}

function project(
  payload: AppServerNotificationPayload,
  options: { state?: TurnState; runState?: CodexRunState } = {},
): ReturnType<typeof projectCodexEvent> {
  return projectCodexEvent(payload, options.state ?? createTurnState(), options.runState ?? createCodexRunState(), CONTEXT);
}

/** 一轮的载荷（`Turn` 的必填格都填上，测试只覆盖关心的那几格） */
function turn(overrides: Record<string, unknown> = {}): AppServerNotificationPayload {
  return {
    kind: 'turnCompleted',
    threadId: MAIN,
    turn: {
      id: 'turn-1',
      items: [],
      itemsView: 'full',
      status: 'completed',
      error: null,
      errorCode: null,
      errorStatusCode: null,
      startedAt: null,
      completedAt: null,
      durationMs: null,
      ...overrides,
    } as never,
  };
}

describe('增量与条目：只推进轮次，不产日志垃圾', () => {
  /**
   * **跑动期的用量必须随条目一起交出去**。
   *
   * 要拦的缺陷：用量通知只记账（它自己不带轮次、不发事件），而条目这一支把 `tokens` 写死 `null`
   * ⇒ 两件事被拆进互不相交的分支，整轮事件流的 tok 全是 `null`。评测一行通常只有一个 turn，
   * 于是界面**全程**停在「采集中」，跑到收尾才第一次出数。另两家都在跑动期交累计值。
   */
  it('已记账的线程累计用量随主线程条目交出（不必等 `turn/completed`）', () => {
    const state = createTurnState();
    const runState = createCodexRunState();
    project(
      {
        kind: 'tokenUsage',
        threadId: MAIN,
        usage: { total: { inputTokens: 120, cachedInputTokens: 20, outputTokens: 7 }, last: null } as never,
      },
      { state, runState },
    );
    const outcome = project(
      { kind: 'itemCompleted', threadId: MAIN, turnId: 'turn-1', item: agentMessage('msg_aaa111'), completedAtMs: null },
      { state, runState },
    );
    // `input` 是**非缓存输入**（120 − 20），与契约口径一致
    expect(outcome.projection.tokens).toMatchObject({ input: 100, cached: 20, output: 7 });
    expect(outcome.tokens).toMatchObject({ input: 100, cached: 20, output: 7 });
  });

  it('一个用量通知都没来过 ⇒ 条目这一支的 tokens 仍是 null（不填 0）', () => {
    const outcome = project({ kind: 'itemCompleted', threadId: MAIN, turnId: 'turn-1', item: agentMessage('msg_aaa111'), completedAtMs: null });
    expect(outcome.projection.tokens).toBeNull();
  });

  it('答复增量不发事件、也不给轮次（开号在内容级那一处，事件流的发射门槛仍是模型产出条目）', () => {
    const outcome = project({ kind: 'agentMessageDelta', threadId: MAIN, turnId: 'turn-1', itemId: 'msg_aaa111', delta: '你' });
    expect(outcome.projection).toMatchObject({ drafts: [], tokens: null, turns: null, failure: null });
  });

  it('推理增量不发事件（它的落点是思考块，见 message.ts）', () => {
    const outcome = project({ kind: 'reasoningTextDelta', threadId: MAIN, turnId: 'turn-1', itemId: 'r1', delta: '想' });
    expect(outcome.projection.drafts).toEqual([]);
  });

  it('主线程的答复条目：一次新**响应**一票，并给出归属（`subagentId: null` + 该轮号）', () => {
    const state = createTurnState();
    const runState = createCodexRunState();
    const first = project({ kind: 'itemCompleted', threadId: MAIN, turnId: 'turn-1', item: agentMessage('msg_aaa111'), completedAtMs: null }, { state, runState });
    expect(first.projection.turns).toBe(1);
    expect(first.projection.turn).toEqual({ subagentId: null, round: 1 });

    // 同一条目的后续快照（`item/started` + `item/completed`）不重复计数
    const repeat = project({ kind: 'itemStarted', threadId: MAIN, turnId: 'turn-1', item: agentMessage('msg_aaa111') }, { state, runState });
    expect(repeat.projection.turns).toBeNull();

    // 换一个**响应 id** 才是新的一次往返（号源是 id 后缀，不是「见过几个条目」）
    const second = project({ kind: 'itemCompleted', threadId: MAIN, turnId: 'turn-1', item: agentMessage('msg_bbb222'), completedAtMs: null }, { state, runState });
    expect(second.projection.turns).toBe(2);

    // 同一次响应里的推理条目与答复条目**共享**那个后缀 ⇒ 不另开一票
    const sameResponse = project({ kind: 'itemCompleted', threadId: MAIN, turnId: 'turn-1', item: { kind: 'reasoning', id: 'rs_bbb222', summary: [], content: [] }, completedAtMs: null }, { state, runState });
    expect(sameResponse.projection.turns).toBeNull();
  });

  it('推理条目**推进**往返（它就是「这次往返开始了」的那一条），工具条目对这把尺子透明', () => {
    const runState = createCodexRunState();
    const state = createTurnState();
    const reasoning: AppServerItem = { kind: 'reasoning', id: 'rs_aaa111', summary: [], content: [] };
    expect(project({ kind: 'itemCompleted', threadId: MAIN, turnId: 'turn-1', item: reasoning, completedAtMs: null }, { state, runState }).projection.turns).toBe(1);
    // 工具调用归**当前**这次往返：它不开新号、也不返回号（返回值是 usage 事件的发射门槛）
    const command: AppServerItem = { kind: 'commandExecution', id: 'call_x1', command: 'ls', cwd: null, status: 'completed', output: null, exitCode: 0, durationMs: 1 };
    expect(project({ kind: 'itemCompleted', threadId: MAIN, turnId: 'turn-1', item: command, completedAtMs: null }, { state, runState }).projection.turns).toBeNull();
    // 它后面那次模型产出才是新的一次往返
    const next: AppServerItem = { kind: 'reasoning', id: 'rs_bbb222', summary: [], content: [] };
    expect(project({ kind: 'itemCompleted', threadId: MAIN, turnId: 'turn-1', item: next, completedAtMs: null }, { state, runState }).projection.turns).toBe(2);
  });

  it('turn 的第一条通知就是工具执行 ⇒ 补记那一票（这次调用不占用后面那次答复的号）', () => {
    const runState = createCodexRunState();
    const state = createTurnState();
    const command: AppServerItem = { kind: 'commandExecution', id: 'call_x1', command: 'ls', cwd: null, status: 'completed', output: null, exitCode: 0, durationMs: 1 };
    // 工具本身不给轮次（发射门槛仍是「模型产出」），但它把这一次往返记下了
    expect(project({ kind: 'itemCompleted', threadId: MAIN, turnId: 'turn-1', item: command, completedAtMs: null }, { state, runState }).projection.turns).toBeNull();
    const answer: AppServerItem = { kind: 'agentMessage', id: 'msg_bbb222', text: '好', phase: null };
    expect(project({ kind: 'itemCompleted', threadId: MAIN, turnId: 'turn-1', item: answer, completedAtMs: null }, { state, runState }).projection.turns).toBe(2);
  });

  it('子线程的答复条目**不**推高本行的轮次（本行的事件流只有主线程的进度语义）', () => {
    const outcome = project({
      kind: 'itemCompleted',
      threadId: 'thread-child',
      turnId: 'child-turn',
      item: agentMessage('m1'),
      completedAtMs: null,
    });
    expect(outcome.projection.turns).toBeNull();
    expect(outcome.projection.turn).toBeNull();
  });
});

describe('turn/completed：计量、时长、归属', () => {
  it('用量取该线程最近一次累计快照；时长按秒换算', () => {
    const runState = createCodexRunState();
    const state = createTurnState();
    project(
      {
        kind: 'tokenUsage',
        threadId: MAIN,
        usage: {
          total: { totalTokens: 1000, inputTokens: 1000, cachedInputTokens: 900, cacheWriteInputTokens: 0, outputTokens: 50, reasoningOutputTokens: 7 },
          last: { totalTokens: 10, inputTokens: 10, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 1, reasoningOutputTokens: 0 },
          modelContextWindow: null,
        },
      },
      { state, runState },
    );
    const outcome = project(
      turn({
        items: [agentMessage('m1')],
        startedAt: 1_700_000_000,
        completedAt: 1_700_000_011,
        durationMs: 11_000,
      }),
      { state, runState },
    );
    // `input` 已减 cached（1000 − 900）⇒ 契约的三元组是非缓存输入
    expect(outcome.tokens).toEqual({ input: 100, cached: 900, output: 50, reasoningOutput: 7, total: 1000 });
    expect(outcome.projection.turns).toBe(1);
    expect(outcome.projection.turn).toEqual({ subagentId: null, round: 1 });
    // 秒 → 毫秒：两点相乘后由骨架现减（11 秒 = 11000 毫秒）
    expect(outcome.projection.timing).toEqual({ firstMs: 1_700_000_000_000, lastMs: 1_700_000_011_000, source: 'events' });
  });

  it('`input − cached` 的真机形状（8152 / 6656 ⇒ 1496）', () => {
    expect(breakdownToTokens({ inputTokens: 8152, cachedInputTokens: 6656, outputTokens: 30 })).toEqual({
      input: 1496,
      cached: 6656,
      output: 30,
      reasoningOutput: null,
      total: null,
    });
  });

  it('`cached > input`（上游数据自相矛盾）时夹到 0：负 token 会让命中率与成本两条公式同时失去意义', () => {
    expect(breakdownToTokens({ inputTokens: 10, cachedInputTokens: 900, outputTokens: 1 })?.input).toBe(0);
  });

  it('三项缺一 ⇒ 整格 null（不填 0）', () => {
    expect(breakdownToTokens({ inputTokens: 10, cachedInputTokens: 1 })).toBeNull();
    expect(breakdownToTokens(null)).toBeNull();
    expect(breakdownToTokens({ inputTokens: 10, cachedInputTokens: 1, outputTokens: 2 })).not.toBeNull();
  });

  /**
   * 时刻缺一端时的两臂。
   *
   * 要拦的缺陷：时间被建模成「必须两点」，于是厂商在**同一个 `Turn`** 上给出的 `durationMs`
   * 被整格丢掉 ⇒ 行上的时长永久为空。而 `TimingSpan` 只要求两端之差有意义（不要求绝对时刻），
   * 以 0 为基准给出同样长的跨度是事实而非「拿 0 冒充」——真正不许编的是**三格全缺**那一档。
   */
  it('时刻缺一端但有 `durationMs` ⇒ 回落成同样长的跨度（厂商给的时长不丢）', () => {
    expect(turnTimingOf({ startedAt: 1, completedAt: null, durationMs: 500 } as never)).toEqual({
      firstMs: 0,
      lastMs: 500,
      source: 'events',
    });
    const outcome = project(turn({ startedAt: 1_700_000_000, completedAt: null, durationMs: 5 }));
    expect(outcome.projection.timing).toEqual({ firstMs: 0, lastMs: 5, source: 'events' });
  });

  it('三格全缺 ⇒ **不带** timing（算不出来就是算不出来，不编一个 0 长度）', () => {
    expect(turnTimingOf({ startedAt: null, completedAt: null, durationMs: null } as never)).toBeNull();
    const outcome = project(turn({ startedAt: null, completedAt: null, durationMs: null }));
    expect(outcome.projection.timing).toBeUndefined();
  });

  it('`turn/completed` 自带 usage 时以它为准（协议后加字段的那条路）', () => {
    const outcome = project(
      turn({
        items: [agentMessage('m1')],
        usage: { inputTokens: 20, cachedInputTokens: 5, outputTokens: 3, reasoningOutputTokens: 0, totalTokens: 23 },
      }),
    );
    expect(outcome.tokens).toEqual({ input: 15, cached: 5, output: 3, reasoningOutput: 0, total: 23 });
  });

  it('`status: failed` ⇒ 一条 error 事件 + 失败归因（文案里的 401 归 AUTH_FAILED）', () => {
    // 归因取**厂商原文的话术**：`TurnError` 在这一侧的窄声明里只有 `message`，而状态码写在文案里
    const outcome = project(turn({ status: 'failed', error: 'unexpected status 401: 密钥无效' }));
    expect(outcome.projection.failure?.code).toBe('AUTH_FAILED');
    expect(outcome.projection.drafts.some((draft) => draft.type === 'error')).toBe(true);
  });

  it('`status: failed` 且没有原因文案时不编造：给一句「未给出原因」，仍按失败归因', () => {
    const outcome = project(turn({ status: 'failed', error: null }));
    expect(outcome.projection.failure?.code).toBe('AGENT_FAILED');
    expect(outcome.tokens).toBeNull();
  });

  /**
   * **失败是结论，不是提前退出**。
   *
   * 要拦的缺陷：失败那一支在算计量与时长**之前**就 return，而厂商就在同一条 `turn/completed` 上
   * 给了这两格 ⇒ 一次 401 / 429 / 上游 5xx 的行时长永久为空、计量为 `null`，偏偏 `interrupted`
   * 那一档有（两档不对称本身就说明是漏写）。既有用例只断言 `failure`，拿不给用量的夹具一跑就恒绿。
   */
  it('`status: failed` 仍要带上这一轮的计量与时长（与 completed / interrupted 同待遇）', () => {
    const runState = createCodexRunState();
    project(
      {
        kind: 'tokenUsage',
        threadId: MAIN,
        usage: { total: { inputTokens: 50, cachedInputTokens: 10, outputTokens: 4 }, last: null } as never,
      },
      { runState },
    );
    const outcome = project(
      turn({ status: 'failed', error: 'unexpected status 429: 太快了', startedAt: 1_700_000_000, completedAt: 1_700_000_012 }),
      { runState },
    );
    expect(outcome.projection.failure?.code).toBe('RATE_LIMITED');
    expect(outcome.projection.tokens).toMatchObject({ input: 40, cached: 10, output: 4 });
    expect(outcome.projection.timing).toEqual({ firstMs: 1_700_000_000_000, lastMs: 1_700_000_012_000, source: 'events' });
  });

  /**
   * **归因优先认厂商的机器可读分类**（`TurnError.codexErrorInfo`）。
   *
   * 要拦的缺陷：只读 `message` 文案。那条路是「从文案里正则提 HTTP 状态」，厂商改一句措辞就错档
   * ——归成 `AGENT_FAILED` 之后它还在自动重试表里，于是一个 401 会被重跑两遍、每次再等 3 秒，
   * 而它重试多少次都是同一个失败。这里的文案**刻意不含任何状态码**，只有枚举说得出真相。
   */
  it('`codexErrorInfo` 说了算：文案里没有状态码也能归对档', () => {
    const unauthorized = project(turn({ status: 'failed', error: '这次没成', errorCode: 'unauthorized' }));
    expect(unauthorized.projection.failure?.code).toBe('AUTH_FAILED');

    const limited = project(turn({ status: 'failed', error: '这次没成', errorCode: 'usageLimitExceeded' }));
    expect(limited.projection.failure?.code).toBe('RATE_LIMITED');

    // 归不了档的分类**不强行映射**，但要把厂商怎么说的带进文案（排障看得见）
    const other = project(turn({ status: 'failed', error: '这次没成', errorCode: 'sandboxError' }));
    expect(other.projection.failure?.code).toBe('AGENT_FAILED');
    expect(other.projection.failure?.message).toContain('sandboxError');
  });

  /**
   * **上游 HTTP 失败：判据是对象变体里的 `httpStatusCode`，不是变体名**。
   *
   * 要拦的缺陷：只比字符串枚举。真机对上游 401 报的是
   * `{"responseStreamDisconnected":{"httpStatusCode":401}}`（500 同形、状态码为 `null`）——
   * 变体名 `responseStreamDisconnected` 说的是**传输层**、分不出鉴权与过载 ⇒ 只比名字时四条
   * 机器可读分支**恒不命中**，401 只能靠 `additionalDetails` 里那个「401」被正则认出来
   * （厂商换一句文案就错档）。这里的文案刻意**不含 401**，只有状态码说得出真相。
   */
  it('对象变体的 `httpStatusCode` 说了算：文案里没有状态码也能归对档', () => {
    const unauthorized = project(turn({
      status: 'failed',
      error: '请求中断了',
      errorCode: 'responseStreamDisconnected',
      errorStatusCode: 401,
    }));
    expect(unauthorized.projection.failure?.code).toBe('AUTH_FAILED');

    const limited = project(turn({
      status: 'failed',
      error: '请求中断了',
      errorCode: 'responseStreamDisconnected',
      errorStatusCode: 429,
    }));
    expect(limited.projection.failure?.code).toBe('RATE_LIMITED');

    // 状态码为 null（连接被拒那一档）：不强行归档，交回文案那条路，分类名照旧进文案
    const unknown = project(turn({
      status: 'failed',
      error: 'We\'re currently experiencing high demand, which may cause temporary errors.',
      errorCode: 'responseStreamDisconnected',
      errorStatusCode: null,
    }));
    expect(unknown.projection.failure?.code).toBe('AGENT_FAILED');
    expect(unknown.projection.failure?.message).toContain('responseStreamDisconnected');
  });

  it('`status: interrupted` **不是**失败：只落一条 WARN，`failure` 保持 null', () => {
    const outcome = project(turn({ status: 'interrupted' }));
    expect(outcome.projection.failure).toBeNull();
    expect(outcome.projection.drafts).toEqual([
      { type: 'log', stream: 'stderr', text: '[WARN] codex 本轮被中止（用户终止或上游打断）' },
    ]);
  });

  it('子线程的 `turn/completed` 不结算本行（不发计量、不给轮次），但仍推进它自己的轮次', () => {
    const runState = createCodexRunState();
    const outcome = project(
      {
        kind: 'turnCompleted',
        threadId: 'thread-child',
        turn: { id: 'ct', items: [agentMessage('m1')], itemsView: 'full', status: 'completed', error: null, errorCode: null,
          errorStatusCode: null, startedAt: null, completedAt: null, durationMs: null },
      },
      { runState },
    );
    expect(outcome.projection.tokens).toBeNull();
    expect(outcome.projection.turns).toBeNull();
    // 子线程自己那一份数到了（收尾求和读的就是它）
    expect(runState.roundTripKeys.get('thread-child')?.size).toBe(1);
  });
});

describe('按线程用量与未识别通知', () => {
  it('用量通知只记账、不发事件（它的出口是下一条 turn/completed）', () => {
    const outcome = project({
      kind: 'tokenUsage',
      threadId: MAIN,
      usage: {
        total: { totalTokens: 1, inputTokens: 1, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 },
        last: { totalTokens: 1, inputTokens: 1, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 },
        modelContextWindow: null,
      },
    });
    expect(outcome.projection.drafts).toEqual([]);
    expect(outcome.projection.turns).toBeNull();
  });

  it('`error` 通知只落 WARN、不进失败通道（过路报错不代表这一轮的结论）', () => {
    const outcome = project({ kind: 'error', threadId: MAIN, message: 'Reconnecting… 5/5' });
    expect(outcome.projection.failure).toBeNull();
    expect(outcome.projection.drafts[0]).toMatchObject({ type: 'log', stream: 'stderr' });
  });

  it('计划更新落一条摘要（面板由 message.ts 出块）', () => {
    const outcome = project({ kind: 'turnPlanUpdated', threadId: MAIN, turnId: 'turn-1', steps: [{ step: 'a', status: 'pending' }] });
    expect(outcome.projection.drafts[0]).toMatchObject({ type: 'log', stream: 'stdout', summary: '更新计划：1 步' });
  });

  /**
   * **未识别的通知要连 `params` 一起留下**。
   *
   * 要拦的缺陷：兜底只留方法名。schema 里有 84 个通知方法而这一层只归一了十几个 ⇒ 这一支常走，
   * 而正文全在 `params` 里：`model/rerouted`（模型被**静默**改路由，这是必须看见的事实）、
   * `warning` / `deprecationNotice` 的原文、`serverRequest/resolved` 的回执…… 只留方法名时，
   * 「上游换了载荷结构」与「上游什么都没发」在产物里长得一样。
   */
  it('未识别的通知**保留原始负载**（连 params 一起，上游加了方法名不该表现为「什么都没发生」）', () => {
    const outcome = project({
      kind: 'other',
      method: 'model/rerouted',
      params: { threadId: MAIN, from: 'gpt-5.1-codex', to: 'gpt-5.1-codex-mini' },
    });
    expect(outcome.projection.drafts).toEqual([
      {
        type: 'log',
        stream: 'stdout',
        text: '{"method":"model/rerouted","params":{"threadId":"thread-main","from":"gpt-5.1-codex","to":"gpt-5.1-codex-mini"}}',
      },
    ]);
  });
});

/**
 * 活动行（候选卡片底部那一行）只吃 `log` 事件的 `summary` / 人话 `text`，而 app-server 的工具面
 * 全走 `message.ts` 的块 ⇒ 不在这里补一句，那一行整轮只剩「更新计划：N 步」
 * （真机 run `7d8d5f3b`：74 条事件里 10 条带摘要、全是计划那一句，活动行因此永久冻住）。
 *
 * 逐条钉住**在哪一条通知上发**与**发什么**：开始发「在做什么」、完成只发报错或结果类事实。
 */
describe('活动行：`调用工具 <名>：<参数摘要>`（词表在 src/activity.ts）', () => {
  /** 取那条活动行日志的 `text`（证据负载） */
  function codexDraft(outcome: ReturnType<typeof project>): string {
    const log = outcome.projection.drafts.find((draft) => draft.type === 'log');
    return log?.type === 'log' ? log.text : '';
  }

  const COMMAND: AppServerItem = {
    kind: 'commandExecution',
    id: 'c1',
    command: 'npm run build',
    cwd: 'D:\\w',
    status: 'inProgress',
    output: null,
    exitCode: null,
    durationMs: null,
  };

  it('命令：`item/started` 就发（那一刻命令行已完整），证据**不带输出正文**', () => {
    const outcome = project({ kind: 'itemStarted', threadId: MAIN, turnId: 't1', item: COMMAND });
    expect(outcome.projection.drafts).toHaveLength(1);
    const draft = outcome.projection.drafts[0];
    expect(draft).toMatchObject({ type: 'log', stream: 'stdout', summary: '调用工具 exec_command：npm run build' });
    // 证据是条目本身（识别字段），但 `aggregatedOutput` 不进事件流：它的落点是结果块
    const evidence = JSON.parse(draft?.type === 'log' ? draft.text : '{}');
    expect(evidence.command).toBe('npm run build');
    expect(evidence.status).toBe('inProgress');
    expect('output' in evidence).toBe(false);
  });

  it('命令完成**不播**结果（输出与退出码的落点是结果块；活动行回答的是「在做什么」）', () => {
    const outcome = project({
      kind: 'itemCompleted',
      threadId: MAIN,
      turnId: 't1',
      item: { ...COMMAND, status: 'completed', output: 'built in 1.2s', exitCode: 0, durationMs: 1200 },
      completedAtMs: null,
    });
    expect(outcome.projection.drafts).toEqual([]);
  });

  it('命令**没跑起来**（`failed` / `declined`）要播，非零退出码不播——两件事，判据分开', () => {
    const declined = project({
      kind: 'itemCompleted',
      threadId: MAIN,
      turnId: 't1',
      item: { ...COMMAND, status: 'declined', output: null, exitCode: null, durationMs: null },
      completedAtMs: null,
    });
    expect(declined.projection.drafts[0]).toMatchObject({ summary: '工具报错：命令被拒' });

    const failed = project({
      kind: 'itemCompleted',
      threadId: MAIN,
      turnId: 't1',
      item: { ...COMMAND, status: 'failed', output: null, exitCode: null, durationMs: null },
      completedAtMs: null,
    });
    expect(failed.projection.drafts[0]).toMatchObject({ summary: '工具报错：命令失败' });

    // 正常跑完但退出码非零（`grep` 没命中这类）**不播**：真机 33 条里 6 条如此
    const nonzero = project({
      kind: 'itemCompleted',
      threadId: MAIN,
      turnId: 't1',
      item: { ...COMMAND, status: 'completed', output: 'no match', exitCode: 1, durationMs: 30 },
      completedAtMs: null,
    });
    expect(nonzero.projection.drafts).toEqual([]);
  });

  it('补丁：只在完成发（开始那一刻 `changes` 可能还是空的），失败/被拒走「工具报错」', () => {
    const started = project({
      kind: 'itemStarted',
      threadId: MAIN,
      turnId: 't1',
      item: { kind: 'fileChange', id: 'f1', status: 'inProgress', changes: [] },
    });
    expect(started.projection.drafts).toEqual([]);

    const done = project({
      kind: 'itemCompleted',
      threadId: MAIN,
      turnId: 't1',
      item: { kind: 'fileChange', id: 'f1', status: 'completed', changes: [{ path: 'index.html', kind: 'add' }] },
      completedAtMs: null,
    });
    expect(done.projection.drafts[0]).toMatchObject({ summary: '调用工具 apply_patch：index.html' });

    const declined = project({
      kind: 'itemCompleted',
      threadId: MAIN,
      turnId: 't1',
      item: { kind: 'fileChange', id: 'f2', status: 'declined', changes: [{ path: 'a.ts', kind: 'update' }] },
      completedAtMs: null,
    });
    expect(declined.projection.drafts[0]).toMatchObject({ summary: '工具报错：改文件被拒（a.ts）' });

    // 路径一条都没有时不留一对空括号
    const anonymous = project({
      kind: 'itemCompleted',
      threadId: MAIN,
      turnId: 't1',
      item: { kind: 'fileChange', id: 'f3', status: 'failed', changes: [] },
      completedAtMs: null,
    });
    expect(anonymous.projection.drafts[0]).toMatchObject({ summary: '工具报错：改文件失败' });
  });

  it('MCP：开始发调用，完成只在**报错**时发（错误没有别的行级出口）', () => {
    const call: AppServerItem = {
      kind: 'mcpToolCall',
      id: 'm1',
      server: 'docs',
      tool: 'search',
      status: 'inProgress',
      durationMs: null,
      arguments: { query: 'vue 3 cdn' },
      result: null,
      error: null,
    };
    expect(project({ kind: 'itemStarted', threadId: MAIN, turnId: 't1', item: call }).projection.drafts[0]).toMatchObject({
      summary: '调用工具 docs.search：vue 3 cdn',
    });
    expect(
      project({ kind: 'itemCompleted', threadId: MAIN, turnId: 't1', item: { ...call, status: 'completed', result: { content: [] } }, completedAtMs: null })
        .projection.drafts,
    ).toEqual([]);
    expect(
      project({
        kind: 'itemCompleted',
        threadId: MAIN,
        turnId: 't1',
        item: { ...call, status: 'failed', error: { message: 'unauthorized' } },
        completedAtMs: null,
      }).projection.drafts[0],
    ).toMatchObject({ summary: '工具报错：unauthorized' });
    // 错误对象没有 message：照样说「工具报错」，不拿 result / status 凑一句细节
    expect(
      project({ kind: 'itemCompleted', threadId: MAIN, turnId: 't1', item: { ...call, status: 'failed', error: {} }, completedAtMs: null })
        .projection.drafts[0],
    ).toMatchObject({ summary: '工具报错' });
    // `status: 'failed'` 而错误对象缺席（协议那一格是 `unknown`）同样要播
    expect(
      project({ kind: 'itemCompleted', threadId: MAIN, turnId: 't1', item: { ...call, status: 'failed', error: null }, completedAtMs: null })
        .projection.drafts[0],
    ).toMatchObject({ summary: '工具报错' });
  });

  it('证据负载**不带结果正文**（命令输出 / MCP 结果 / 动态工具内容块的落点是结果块，不进事件流）', () => {
    const command = codexDraft(
      project({
        kind: 'itemStarted',
        threadId: MAIN,
        turnId: 't1',
        item: { kind: 'commandExecution', id: 'c1', command: 'ls', cwd: null, status: 'inProgress', output: 'x'.repeat(500), exitCode: null, durationMs: null },
      }),
    );
    expect(command).not.toContain('xxx');

    const mcp = codexDraft(
      project({
        kind: 'itemCompleted',
        threadId: MAIN,
        turnId: 't1',
        item: {
          kind: 'mcpToolCall',
          id: 'm1',
          server: 'fs',
          tool: 'read',
          status: 'failed',
          durationMs: 3,
          arguments: { path: 'a.txt' },
          result: { content: [{ type: 'text', text: 'y'.repeat(500) }] },
          error: { message: 'boom' },
        },
        completedAtMs: null,
      }),
    );
    expect(mcp).not.toContain('yyy');
    // 入参留着（它说明本次调用要干什么）
    expect(mcp).toContain('a.txt');

    const dynamic = codexDraft(
      project({
        kind: 'itemStarted',
        threadId: MAIN,
        turnId: 't1',
        item: { kind: 'dynamicToolCall', id: 'd1', namespace: null, tool: 'lookup', status: 'inProgress', success: null, durationMs: null, arguments: null, contentItems: [{ text: 'z'.repeat(500) }] },
      }),
    );
    expect(dynamic).not.toContain('zzz');
  });

  it('联网搜索与动态工具：开始发调用', () => {
    expect(
      project({ kind: 'itemStarted', threadId: MAIN, turnId: 't1', item: { kind: 'webSearch', id: 'w1', query: 'vue 3 cdn' } })
        .projection.drafts[0],
    ).toMatchObject({ summary: '调用工具 web_search：vue 3 cdn' });
    expect(
      project({
        kind: 'itemStarted',
        threadId: MAIN,
        turnId: 't1',
        item: { kind: 'dynamicToolCall', id: 'd1', namespace: null, tool: 'lookup', status: 'inProgress', success: null, durationMs: null, arguments: { id: 7 }, contentItems: null },
      }).projection.drafts[0],
    ).toMatchObject({ summary: '调用工具 lookup：{"id":7}' });
  });

  it('答复正文落一条日志但**不带摘要**（它本身就是人话，由 `activityOf` 直取 `text`）', () => {
    const outcome = project({
      kind: 'itemCompleted',
      threadId: MAIN,
      turnId: 't1',
      item: agentMessage('m9', '页面已经建好了'),
      completedAtMs: null,
    });
    expect(outcome.projection.drafts).toEqual([{ type: 'log', stream: 'stdout', text: '页面已经建好了' }]);
    // 轮次归属照旧（这条通知同时是「一次模型往返」）
    expect(outcome.projection.turn).toEqual({ subagentId: null, round: 1 });
  });

  it('推理条目**不发**日志（正文的落点是思考块；增量逐条进日志只会把抽屉灌满）', () => {
    const outcome = project({
      kind: 'itemCompleted',
      threadId: MAIN,
      turnId: 't1',
      item: { kind: 'reasoning', id: 'r1', summary: [], content: ['想'] },
      completedAtMs: null,
    });
    expect(outcome.projection.drafts).toEqual([]);
  });
});

/**
 * 真机抓包的路径（本机保留，不入库：`probe/dumps/**` 在 `.gitignore` 里——抓包可能含网关返回的敏感原文）。
 * 提到模块级是为了让 `it.skipIf` 能在**收集期**判它在不在。
 */
const SUBAGENT_DUMP = join(
  import.meta.dirname,
  '../../../probe/dumps/v6/codex-chat-wire-appserver-live-responses-subagent.jsonl',
);

describe('真机抓包重放：活动行在真实通知序列上的产出', () => {
  /**
   * 跑**本机保留的真机抓包**（`probe/dumps/v6/codex-chat-wire-appserver-live-responses-subagent.jsonl`，
   * 97 条原始 app-server 通知）过一遍投影，把活动行产出的摘要按顺序钉住。
   *
   * 为什么必须有一条这样的守卫：把「派发的 receiver id 在 `item/started` 就有了」写成夹具前提，
   * 而真机那一刻是空数组、id 要等 `item/completed`（这一条抓包的 L48/L51）⇒ 夹具绿、生产里那句话永不播
   * （审查 B1）。判据取**真实形状**才算数，这一条就是那个形状。
   *
   * **抓包缺席时跳过，而不是红**：它不入库（见上），干净检出上必然没有这个文件——
   * 硬要它存在，等于让一条永远不能变绿的守卫常驻在门禁里，只会训练人忽略红。
   * 判据没有丢：跑过探针的机器照常执行这条重放；要恢复抓包就重跑一次探针。
   */
  it.skipIf(!existsSync(SUBAGENT_DUMP))('`spawnAgent` → `wait` 的真实序列产出「已派发子任务」与「子任务已完成」各一次', () => {
    const path = SUBAGENT_DUMP;
    const notifications = readFileSync(path, 'utf8')
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as { method?: unknown; params?: unknown })
      .filter((record): record is { method: string; params: unknown } => typeof record.method === 'string');
    /**
     * 主线程 id **从抓包里取**（第一条 `thread/started`）：写死一个假值会把主线程的 `turn/completed`
     * 当成子线程的一轮，凭空多播一句收场——这个用例的第一版就是这么错的（真机重放当场抓到）。
     */
    const mainThreadId = (() => {
      for (const record of notifications) {
        const payload = readNotification(record.method, record.params);
        if (payload.kind === 'threadStarted') return payload.thread.id;
      }
      throw new Error('抓包里没有 thread/started，主线程 id 取不到');
    })();

    const state = createTurnState();
    const runState = createCodexRunState();
    const summaries: string[] = [];
    for (const record of notifications) {
      const payload = readNotification(record.method, record.params);
      const draft = projectCodexEvent(payload, state, runState, { ...CONTEXT, mainThreadId }).projection.drafts.find((one) => one.type === 'log');
      if (draft?.type === 'log' && draft.summary !== undefined) summaries.push(draft.summary);
    }

    // 派发那一句**只出现一次**（真机形状下它只能在 `item/completed` 出现），且排在收场之前
    expect(summaries.filter((one) => one.startsWith('已派发子任务'))).toHaveLength(1);
    expect(summaries.filter((one) => one.startsWith('子任务已完成'))).toHaveLength(1);
    expect(summaries.indexOf('已派发子任务')).toBeLessThan(summaries.indexOf('子任务已完成'));
    // 真机没有给子线程发 `thread/started`（昵称只在收尾的 `thread/list` 响应里）⇒ 这两句都是**无名**那一档
    expect(summaries).toContain('已派发子任务');
    expect(summaries).toContain('子任务已完成');
    // `wait` 是「开始就带 receiver」的那一类协作调用，照旧走通用工具句
    expect(summaries).toContain('调用工具 wait');
    // 子线程自己那条命令也要上活动行（「此刻在做什么」包括子智能体干的活）
    expect(summaries.some((one) => one.includes('CHILD-TOOL-RAN'))).toBe(true);
  });
});

describe('活动行：子任务的派发与收场', () => {
  /**
   * 协作调用条目。**默认形状取真机**（`probe/dumps/v6/codex-chat-wire-appserver-live-responses-subagent.jsonl`）：
   * `item/started` 的 `receiverThreadIds` 是**空数组**、`agentsStates` 是空表；id 与状态只在
   * `item/completed` 上出现。夹具写别的形状会让「派发」这一支假绿（真发生过一次）。
   */
  function collab(overrides: Partial<Extract<AppServerItem, { kind: 'collabToolCall' }>> = {}): AppServerItem {
    return {
      kind: 'collabToolCall',
      id: 'x1',
      tool: 'spawnAgent',
      status: 'inProgress',
      senderThreadId: MAIN,
      receiverThreadIds: [],
      prompt: null,
      agentsStates: [],
      ...overrides,
    };
  }

  it('派发：**只在 `item/completed`** 播（那一刻 id 才到）；开始那一支一个字都不发', () => {
    const runState = createCodexRunState();
    // 真机的开始形状：没有 receiver ⇒ 不许在开始播（播了就是拿不到身份的空句子）
    expect(project({ kind: 'itemStarted', threadId: MAIN, turnId: 't1', item: collab() }, { runState }).projection.drafts).toEqual([]);

    const done = project(
      {
        kind: 'itemCompleted',
        threadId: MAIN,
        turnId: 't1',
        item: collab({ status: 'completed', receiverThreadIds: ['child-1'], agentsStates: [{ threadId: 'child-1', status: 'pendingInit', message: null }] }),
        completedAtMs: null,
      },
      { runState },
    );
    // 没有昵称就**不留占位**（旧实现写「已派发子任务：子任务」）；子任务名运行期多半拿不到
    expect(done.projection.drafts[0]).toMatchObject({ summary: '已派发子任务' });
  });

  it('派发：`thread/started` 给过昵称时用昵称', () => {
    const runState = createCodexRunState();
    runState.nicknames.set('child-1', 'Review Vue 3 page');
    const done = project(
      { kind: 'itemCompleted', threadId: MAIN, turnId: 't1', item: collab({ status: 'completed', receiverThreadIds: ['child-1'] }), completedAtMs: null },
      { runState },
    );
    expect(done.projection.drafts[0]).toMatchObject({ summary: '已派发子任务：Review Vue 3 page' });
  });

  it('非派发的协作动作（等待 / 关闭）在**开始**走通用工具句', () => {
    const outcome = project({ kind: 'itemStarted', threadId: MAIN, turnId: 't1', item: collab({ tool: 'wait', receiverThreadIds: ['child-1'] }) });
    expect(outcome.projection.drafts[0]).toMatchObject({ summary: '调用工具 wait' });
  });

  it('收场：终态**变化**才播一次——同一次收场会在派发 / wait / 活动条目上重复出现', () => {
    const runState = createCodexRunState();
    const settled = collab({ status: 'completed', receiverThreadIds: ['child-1'], agentsStates: [{ threadId: 'child-1', status: 'completed', message: null }] });

    const first = project({ kind: 'itemCompleted', threadId: MAIN, turnId: 't1', item: settled, completedAtMs: null }, { runState });
    expect(first.projection.drafts.map((draft) => (draft.type === 'log' ? draft.summary : ''))).toEqual(['已派发子任务', '子任务已完成']);

    // 同一条收场再来一次（`wait` 完成时也会带同一份 states）⇒ 收场那句一个字都不许再播
    const again = project({ kind: 'itemCompleted', threadId: MAIN, turnId: 't2', item: { ...settled, id: 'x9' }, completedAtMs: null }, { runState });
    expect(again.projection.drafts.map((draft) => (draft.type === 'log' ? draft.summary : ''))).toEqual(['已派发子任务']);
  });

  it('收场：模型不再调 `wait` / `closeAgent` 时，子线程自己那一轮的 `turn/completed` 就是那个终态', () => {
    const runState = createCodexRunState();
    const childTurn = (status: string): AppServerNotificationPayload => ({
      kind: 'turnCompleted',
      threadId: 'child-1',
      turn: { id: 'ct', items: [], itemsView: 'full', status, error: null, errorCode: null,
        errorStatusCode: null, startedAt: null, completedAt: null, durationMs: null },
    });
    const first = project(childTurn('completed'), { runState });
    expect(first.projection.drafts[0]).toMatchObject({ summary: '子任务已完成' });
    // 同一条终态重复到达不重播；`inProgress` 不播
    expect(project(childTurn('completed'), { runState }).projection.drafts).toEqual([]);
    expect(project(childTurn('inProgress'), { runState }).projection.drafts).toEqual([]);
    // 失败那一档与 `message.ts` 的 `terminalStatusOf` 同一张表
    expect(project(childTurn('failed'), { runState }).projection.drafts[0]).toMatchObject({ summary: '子任务失败' });
    expect(project(childTurn('interrupted'), { runState }).projection.drafts[0]).toMatchObject({ summary: '子任务已停止' });
  });

  it('`subAgentActivity`：终态播一次收场，「在跑」不播', () => {
    const runState = createCodexRunState();
    const activity = (value: string): AppServerItem => ({
      kind: 'subAgentActivity',
      id: 'a1',
      activity: value,
      agentThreadId: 'child-1',
      agentPath: '/root/child',
    });
    expect(project({ kind: 'itemStarted', threadId: MAIN, turnId: 't1', item: activity('started') }, { runState }).projection.drafts).toEqual([]);
    expect(project({ kind: 'itemStarted', threadId: MAIN, turnId: 't1', item: activity('completed') }, { runState }).projection.drafts[0]).toMatchObject({
      summary: '子任务已完成',
    });
    // 同一个终态重复到达不重播
    expect(project({ kind: 'itemStarted', threadId: MAIN, turnId: 't1', item: activity('completed') }, { runState }).projection.drafts).toEqual([]);
  });
});
