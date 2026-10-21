// @vitest-environment node
/**
 * cc 的**注入面**（第五组 `turnInjection`）：投递、撤回、续接，以及声明与事实的互钉。
 *
 * 这一面最容易腐烂的地方是「声明说能投、实际投不进去」——而它**没有任何报错**，形态只是
 * 「按钮可点、消息静默消失」。故这个文件把三件事分开钉：
 *   ① **零回归的正面判据**：端口缺席（或 `available: false`）时 `prompt` 仍是**字符串**——
 *      字符串题面下 CLI 判 `isSingleUserTurn`、首条 `result` 就到头，行为与没有这个功能时逐字相同；
 *   ② **投递的两个边界**：工具结果到达取 `'round'`、`result` 收场取 `'idle'`，且**缺省车道**
 *      （不写 `priority`）——那是真机证过的折入形状；
 *   ③ **收场由我们驱动**：streaming input 下输入流不 `end()` 查询不会自己结束，夹具会一直挂着
 *      ⇒ 「收场」这件事有一条会红的判据，而不是靠注释。
 *
 * 另有一条**消费方**的判据：缺省车道的落点在 `tool_result` 块的 `content` 里，只认 `text` 块
 * 会把它读成「没进主轮」（`tool_result.content` 既可能是字符串也可能是块数组，两种都要读）。
 */
import { describe, expect, it } from 'vitest';
import { TurnInjectionCapabilitySchema, type AgentEvent } from '@aieval/contracts';
import { createMessageAssembler } from '../../message';
import { setAgentRuntimeForTesting } from '../../runtime';
import {
  collectEvents,
  createFakeClaudeSdk,
  createRecorder,
  createRunInput,
  createTurnState,
} from '../../testing/agent-fixtures';
import type { InjectionBoundary, InjectionPort, RetractOutcome, UserMessage } from '../../types';
import { claudeCodeProvider } from './index';
import { createClaudeMessageNormalizer } from './message';
import { CLAUDE_PACKAGE_NAME } from './sdk';

/** 一条人工消息（端口交出来的形状：身份 + **编排层已经拼好**的正文） */
function human(id: string, text: string): UserMessage {
  return { id, text };
}

/** 端口的观测量：取件边界序列、登记回来的撤回闭包、投出去的身份 */
interface PortSpy {
  port: InjectionPort;
  drains: InjectionBoundary[];
  deliveredIds: string[];
  /** 每批登记回来的「怎么要回来」；用例拿它当编排层调（适配器只登记、不自己撤） */
  retracts: ((id: string) => Promise<RetractOutcome>)[];
}

/**
 * 一份**编排层那一侧的假端口**。`plan` 按「第几次取件」给货，于是「第一轮给、第二轮不给」
 * 这类时序能写出来；不给货就交空数组（与真端口同形）。
 */
function createPortSpy(
  plan: (boundary: InjectionBoundary, index: number) => UserMessage[] = () => [],
  available = true,
): PortSpy {
  const drains: InjectionBoundary[] = [];
  const deliveredIds: string[] = [];
  const retracts: ((id: string) => Promise<RetractOutcome>)[] = [];
  return {
    drains,
    deliveredIds,
    retracts,
    port: {
      available,
      drain: (boundary) => {
        const index = drains.length;
        drains.push(boundary);
        return plan(boundary, index);
      },
      markDelivered: (ids, retract) => {
        deliveredIds.push(...ids);
        retracts.push(retract);
      },
      // 编排层自己那一侧的撤回入口（适配器不调它，故这里只需要一个合法实现）
      retract: async () => 'unsupported',
    },
  };
}

/** `system/init`：会话 id 从这里取（收尾上报的那一格） */
const INIT = { type: 'system', subtype: 'init', session_id: 'session-abc', uuid: 'u-init', tools: ['Bash'] };
/** 一次带工具调用的模型往返 */
const ASSISTANT_TOOL = {
  type: 'assistant',
  uuid: 'u-a1',
  session_id: 'session-abc',
  message: {
    id: 'm-1',
    role: 'assistant',
    content: [{ type: 'tool_use', id: 'toolu-1', name: 'Bash', input: { command: 'sleep 4' } }],
  },
};
/** 工具结果到达 = 「一批工具跑完、下一次模型往返之前」那个可观察边界（`'round'` 档的取件点） */
const TOOL_RESULT = {
  type: 'user',
  uuid: 'u-t1',
  session_id: 'session-abc',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu-1', content: 'probe-tool-done' }] },
};
/** 一轮收场（streaming input 下**每一轮**都有一条） */
function result(text: string): unknown {
  return { type: 'result', subtype: 'success', result: text, session_id: 'session-abc', num_turns: 1, uuid: `u-r-${text}` };
}

/** 一次模型往返（`message.id` 是轮次去重的键：每轮各给一个不同的，`state.turns` 才会累计） */
function assistantMessage(id: string): unknown {
  return {
    type: 'assistant',
    uuid: `u-${id}`,
    session_id: 'session-abc',
    message: { id, role: 'assistant', content: [{ type: 'text', text: `第 ${id} 次往返` }] },
  };
}

/**
 * 一条带用量的收场帧。`index` 是厂商的 `result_index`（「这是第几条 `result`，从 0 起」），
 * `numTurns` 是**这一轮**的模型往返数。
 */
function resultWithUsage(
  text: string,
  usage: { input: number; cached: number; output: number; numTurns: number; index: number },
): unknown {
  return {
    type: 'result',
    subtype: 'success',
    result: text,
    session_id: 'session-abc',
    num_turns: usage.numTurns,
    result_index: usage.index,
    uuid: `u-r-${usage.index}`,
    usage: { input_tokens: usage.input, cache_read_input_tokens: usage.cached, output_tokens: usage.output },
  };
}

/** 一轮：init → 带工具调用的往返 → 工具结果 → 收场 */
const ONE_ROUND = [INIT, ASSISTANT_TOOL, TOOL_RESULT, ASSISTANT_TOOL, result('第一轮答复')];

/**
 * 跑一次运行，并在上限内落定。
 *
 * 为什么必须包一层：适配器若**不收输入流**，那条假流会一直挂着（正是要拦的缺陷）——
 * 那时用例必须**红在一句人话上**，而不是把整个文件挂到超时。
 */
async function runWithin(
  input: Parameters<typeof claudeCodeProvider.run>[0],
  ms = 3_000,
): Promise<Awaited<ReturnType<typeof claudeCodeProvider.run>>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      claudeCodeProvider.run(input),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('运行未在预算内落定：适配器多半没有收输入流（streaming input 下查询不会自己结束）')),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

describe('cc 注入面：端口缺席或关着时零回归', () => {
  it('调用方没传端口 ⇒ `prompt` 仍是字符串（不进 streaming input）', async () => {
    const recorder = createRecorder();
    setAgentRuntimeForTesting({ sdkModule: { [CLAUDE_PACKAGE_NAME]: createFakeClaudeSdk({ recorder, events: [INIT, result('答复')] }) } });
    const run = await claudeCodeProvider.run(createRunInput({ prompt: '把标题改成示例项目' }));

    expect(recorder.promptIsStream).toBe(false);
    expect(recorder.prompt).toBe('把标题改成示例项目');
    expect(recorder.pushed).toEqual([]);
    expect(run.sessionId).toBe('session-abc');
  });

  it('传了端口但 `available: false` ⇒ 一格都不挂：取件一次都不调', async () => {
    const spy = createPortSpy(() => [human('m-1', '顺便把 changelog 补上')], false);
    const recorder = createRecorder();
    setAgentRuntimeForTesting({ sdkModule: { [CLAUDE_PACKAGE_NAME]: createFakeClaudeSdk({ recorder, events: [INIT, result('答复')] }) } });
    await claudeCodeProvider.run(createRunInput({ inject: spy.port }));

    expect(recorder.promptIsStream).toBe(false);
    expect(spy.drains).toEqual([]);
    expect(spy.deliveredIds).toEqual([]);
  });
});

describe('cc 注入面：投递的两个边界（streaming input）', () => {
  it('工具结果到达取 `round` 档，投出去的形状是**缺省车道**（`priority` 整个缺席）+ 自铸 uuid', async () => {
    // 第一次取件（`'round'`）给一条；`'idle'` 一条都不给 ⇒ 本轮收场时收流
    const spy = createPortSpy((boundary) => (boundary === 'round' && spy.drains.length <= 1 ? [human('m-1', '顺便把 changelog 补上')] : []));
    const recorder = createRecorder();
    setAgentRuntimeForTesting({
      sdkModule: { [CLAUDE_PACKAGE_NAME]: createFakeClaudeSdk({ recorder, events: [], streamRounds: [ONE_ROUND] }) },
    });
    await runWithin(createRunInput({ inject: spy.port, prompt: '把标题改成示例项目' }));

    // 题面本身也从这条流进去（streaming input 下没有「一次性 prompt」那一格）
    expect(recorder.promptIsStream).toBe(true);
    expect(recorder.prompt).toBeNull();
    expect(recorder.pushed).toHaveLength(2);
    expect(recorder.pushed[0]).toEqual({
      type: 'user',
      message: { role: 'user', content: '把标题改成示例项目' },
      parent_tool_use_id: null,
    });

    const injected = recorder.pushed[1] as Record<string, unknown>;
    expect(injected['type']).toBe('user');
    expect(injected['message']).toEqual({ role: 'user', content: '顺便把 changelog 补上' });
    expect(injected['parent_tool_use_id']).toBeNull();
    // 身份由**我们**铸（撤回按它认人）；车道**不写**（缺省 = `'next'`，那正是 `'round'` 档的落点）
    expect(typeof injected['uuid']).toBe('string');
    expect(injected['uuid']).not.toBe('');
    expect('priority' in injected).toBe(false);

    // 边界序列：工具结果那一帧取 `'round'`，收场那一帧取 `'idle'`
    expect(spy.drains).toEqual(['round', 'idle']);
    expect(spy.deliveredIds).toEqual(['m-1']);
    expect(spy.retracts).toHaveLength(1);
  });

  it('`idle` 档在轮次收场取件，投出去之后 CLI 另起一轮（而不是把本轮切成两条 `result`）', async () => {
    // 只有在**第一次**收场时给一条 idle；第二次收场一条都没有 ⇒ 收流收场
    const spy = createPortSpy((boundary, index) => (boundary === 'idle' && index === 0 ? [human('m-2', '再跑一遍测试')] : []));
    const recorder = createRecorder();
    setAgentRuntimeForTesting({
      sdkModule: {
        [CLAUDE_PACKAGE_NAME]: createFakeClaudeSdk({
          recorder,
          events: [],
          streamRounds: [
            [INIT, ASSISTANT_TOOL, result('第一轮答复')],
            [ASSISTANT_TOOL, result('第二轮答复')],
          ],
        }),
      },
    });
    const run = await runWithin(createRunInput({ inject: spy.port }));

    // 两条 result 都被处理过：最终答复是**最后**那一轮那条
    expect(run.finalText).toBe('第二轮答复');
    // 投了两条：题面 + 收场时取到的那一条（`'idle'` 档）
    expect(recorder.pushed).toHaveLength(2);
    expect((recorder.pushed[1] as { message: { content: string } }).message.content).toBe('再跑一遍测试');
    expect(spy.drains).toEqual(['idle', 'idle']);
  });

  it('队列里没有待投递的消息 ⇒ 本轮收场就收流（收场由适配器驱动）', async () => {
    // 这条用例的判据就是「能落定」：适配器不收流的话假流会一直挂着，`runWithin` 会红在超时那句话上
    const spy = createPortSpy();
    const recorder = createRecorder();
    setAgentRuntimeForTesting({
      sdkModule: { [CLAUDE_PACKAGE_NAME]: createFakeClaudeSdk({ recorder, events: [], streamRounds: [ONE_ROUND] }) },
    });
    const run = await runWithin(createRunInput({ inject: spy.port }));
    expect(run.finalText).toBe('第一轮答复');
  });

  it('一条查询里多轮：用量**累加**（`result.usage` 每一轮一份），且不拿每轮的 num_turns 去比累计轮次', async () => {
    /**
     * 两条判据都只在这条路上成立：streaming input 下 `result` 是**每一轮一条**——
     *   · 用量那一格：厂商 JSDoc 逐字 *"MAIN AGENT LOOP ONLY … per-turn in streaming-input
     *     sessions"* ⇒ 覆盖式记账会把候选级用量记成「只有最后一轮」；
     *   · 轮次那一条：`num_turns` 数的是**这一轮**的模型往返，而状态里的轮次是整条查询的累计
     *     ⇒ 从第 2 轮起比对必然假报一条 WARN。
     */
    const spy = createPortSpy((boundary, index) => (boundary === 'idle' && index === 0 ? [human('m-2', '再跑一遍测试')] : []));
    const events: AgentEvent[] = [];
    const recorder = createRecorder();
    setAgentRuntimeForTesting({
      sdkModule: {
        [CLAUDE_PACKAGE_NAME]: createFakeClaudeSdk({
          recorder,
          events: [],
          streamRounds: [
            [INIT, assistantMessage('a-1'), resultWithUsage('第一轮答复', { input: 10, cached: 2, output: 5, numTurns: 1, index: 0 })],
            [assistantMessage('a-2'), resultWithUsage('第二轮答复', { input: 20, cached: 3, output: 7, numTurns: 1, index: 1 })],
          ],
        }),
      },
    });
    const run = await runWithin(createRunInput({ inject: spy.port, onEvent: collectEvents(events) }));

    expect(run.finalText).toBe('第二轮答复');
    // 两轮各自那一份都在（覆盖式记账只会剩 20 / 3 / 7）
    expect(run.tokens).toMatchObject({ input: 30, cached: 5, output: 12 });
    const stderr = events
      .filter((event) => event.type === 'log' && event.stream === 'stderr')
      .map((event) => (event.type === 'log' ? event.text : ''))
      .join('\n');
    expect(stderr).not.toContain('num_turns');
  });

  /**
   * **跑动期读数与结果口径必须同源，且单调不减**（多轮那一条路上才暴露的两个缺口）。
   *
   * 两件事过去各自错：
   *   ① **估算会把权威值盖回去**：估算表（`state.usageByMessageId`）原来整行只增不清，于是
   *      `result` 的权威值到手之后，**下一条 assistant 消息**又把全表和交出去，骨架的
   *      `liveTokens = estimatedTokens ?? tokens` 读回估算 ⇒ 界面上 tok **往回跳**。
   *      真机形状让这件事特别刺眼：流式快照的三项常常接近 0，而权威值是几万
   *      ⇒ 本用例用「快照极小、结算值很大」的数字把它钉死；
   *   ② **事件与结果两套口径**：投影原样透传「本轮」那一份、而骨架对 `tokens` 是覆盖语义
   *      ⇒ `usage` 事件只剩最后一轮，`finalize` 交的却是全轮累加（界面与 `run.json` 各说各话）。
   */
  it('多轮：usage 事件的读数单调不减，且最后一条与结果那一格同值（估算不许盖回权威值）', async () => {
    /** 一次带**极小**用量的模型往返（真机：流式快照的 usage 远小于结算值，常常是 0） */
    function assistantWithUsage(id: string, usage: { input: number; output: number }): unknown {
      return {
        type: 'assistant',
        uuid: `u-${id}`,
        session_id: 'session-abc',
        message: {
          id,
          role: 'assistant',
          content: [{ type: 'text', text: `第 ${id} 次往返` }],
          usage: { input_tokens: usage.input, cache_read_input_tokens: 0, output_tokens: usage.output },
        },
      };
    }

    const spy = createPortSpy((boundary, index) => (boundary === 'idle' && index === 0 ? [human('m-2', '再跑一遍测试')] : []));
    const events: AgentEvent[] = [];
    const recorder = createRecorder();
    setAgentRuntimeForTesting({
      sdkModule: {
        [CLAUDE_PACKAGE_NAME]: createFakeClaudeSdk({
          recorder,
          events: [],
          streamRounds: [
            [
              INIT,
              assistantWithUsage('a-1', { input: 1, output: 1 }),
              resultWithUsage('第一轮答复', { input: 1_000, cached: 100, output: 500, numTurns: 1, index: 0 }),
            ],
            [
              assistantWithUsage('a-2', { input: 2, output: 1 }),
              resultWithUsage('第二轮答复', { input: 2_000, cached: 200, output: 600, numTurns: 1, index: 1 }),
            ],
          ],
        }),
      },
    });
    const run = await runWithin(createRunInput({ inject: spy.port, onEvent: collectEvents(events) }));

    const usages = events.flatMap((event) => (event.type === 'usage' && event.tokens !== null ? [event.tokens] : []));
    expect(usages.length).toBeGreaterThanOrEqual(2);
    /**
     * **单调不减**：缺陷①的直接判据。没有「每条 result 清一次估算表 + 估算以已结算累计为底」
     * 这两条，第二轮那条估算会交出一个 `input: 3`（两条快照之和），而上一条事件已经是 1,000
     * ⇒ 这里当场见红。
     */
    for (const [index, tokens] of usages.entries()) {
      if (index === 0) continue;
      const previous = usages[index - 1];
      expect(tokens.input, `第 ${index + 1} 条 usage 的 input 比上一条小`).toBeGreaterThanOrEqual(previous?.input ?? 0);
      expect(tokens.output, `第 ${index + 1} 条 usage 的 output 比上一条小`).toBeGreaterThanOrEqual(previous?.output ?? 0);
    }
    // 两轮累加（覆盖式记账只会剩 2000 / 200 / 600）
    expect(run.tokens).toMatchObject({ input: 3_000, cached: 300, output: 1_100 });
    /**
     * **事件与结果同源**：缺陷②的直接判据——最后一条 `usage` 事件就是候选级累计，
     * 而不是「最后一轮那一份」。
     */
    expect(usages.at(-1)).toMatchObject({ input: 3_000, cached: 300, output: 1_100 });
    /**
     * **逐条钉死整个序列**（这一条才是缺陷①的完整判据）。
     *
     * 第 3 条是要害：第二轮那条估算必须是「已结算的 1,000/100/500 **+ 这一轮在飞的** 2/0/1」
     * = `1002/100/501`。少了「每条 `result` 清一次估算表」，它会变成 `1003/100/502`
     * ——把第一轮那条快照又算了一遍（**单调性察觉不到这 1 个 token 的重复计**，所以必须钉值）。
     * 每条 `basis` 也一起钉：估算与权威值交替出现，而权威值那两条**绝不能**是 `estimated`。
     * **末条是收尾补发的那一条**（全树口径；本场景没有子智能体 ⇒ 它与末条 `result` 同值）——
     * 它的存在让「跑动期事件只有主会话、收尾才是全树」这件事在事件流里也收口。
     */
    expect(
      events.flatMap((event) =>
        event.type === 'usage' && event.tokens !== null
          ? [{ basis: event.tokensBasis, input: event.tokens.input, cached: event.tokens.cached, output: event.tokens.output }]
          : [],
      ),
    ).toEqual([
      { basis: 'estimated', input: 1, cached: 0, output: 1 },
      { basis: 'reported', input: 1_000, cached: 100, output: 500 },
      { basis: 'estimated', input: 1_002, cached: 100, output: 501 },
      { basis: 'reported', input: 3_000, cached: 300, output: 1_100 },
      { basis: 'reported', input: 3_000, cached: 300, output: 1_100 },
    ]);
  });
});

/**
 * **取消之后一条都不再投**（取消的语义是「不再产生新的模型往返」）。
 *
 * 为什么这一组守卫承重：收场判据**在适配器这一层**——streaming input 下「还要不要再投一条、
 * 要不要收流」全由流循环里那个取件分支决定，而 `stopRequested` 只有骨架看得见。不立停止位的话，
 * 用户点终止、`interrupt()` 已经发出去之后，被中断那一轮的 `result` 仍会把队列里剩下的消息
 * 投给 CLI，并且因为「投出去了」而**不收流** ⇒ CLI 另起一轮，再被 5 秒后的 `dispose()` 硬杀在
 * 半路（那一轮的产物归属不明）。症状不是报错，而是「点了停止，它又跑了一轮」。
 */
describe('cc 注入面：终止之后不再投递、并且收流', () => {
  it('终止之后不再取件、不再向厂商投人工消息（哪怕队列里还有货）', async () => {
    /**
     * **确定性的终止时刻**：在端口的第一次取件里就 `abort()`。
     * 这条链是同步的——`abort` → 骨架的 `onAbort` → `requestStop` → `releaseTurn` 同步调
     * `handle.interrupt()`（见 `release.ts`）⇒ 适配器的停止位在这一刻就已经立起来了，
     * 不依赖任何定时器或调度顺序。
     *
     * 随后端口**每次**取件都给货：没有停止位的话，收场那一帧会取到这条、投给 CLI、
     * 并因为「投出去了」而不收流 ⇒ 另起一轮（真机上就是「点了停止，它又跑了一轮」）。
     */
    const controller = new AbortController();
    const spy = createPortSpy((_boundary, index) => {
      if (index === 0) {
        controller.abort();
        return [];
      }
      return [human(`m-${index}`, '再顺手改一下')];
    });
    const recorder = createRecorder();
    setAgentRuntimeForTesting({
      sdkModule: {
        [CLAUDE_PACKAGE_NAME]: createFakeClaudeSdk({
          recorder,
          events: [],
          // 两轮脚本：没有停止位时第二轮会真的跑起来
          streamRounds: [ONE_ROUND, ONE_ROUND],
          /**
           * **被中断那一轮仍然吐出它自己的 `result`**（真机：`interrupt()` 之后厂商不当场闭嘴）。
           * 这一格是本守卫的要害：缺了它，那条 `result` 根本到不了流循环，于是「停止之后还会不会
           * 再投一条」在用例里不可达——守卫会绿在「那一帧从没到过」上（变异验证当场暴露过这件事）。
           */
          afterStop: [result('被中断那一轮的收尾')],
        }),
      },
    });
    const settled = await runWithin(createRunInput({ inject: spy.port, signal: controller.signal }));

    expect(settled.exitReason).toBe('canceled');
    // 停止之后**一次都不再取件**：`'round'` 那一次（就是触发终止的那次）之后再没有 `'idle'`
    expect(spy.drains).toEqual(['round']);
    // 投出去的只有题面那一条：终止后队列里的货一条都没交给厂商
    expect(recorder.pushed).toHaveLength(1);
    // 也**没有**把任何一条登记成「已投递」（撤回面不会对着没投出去的消息说「撤不回来」）
    expect(spy.deliveredIds).toEqual([]);
  });

  /**
   * **取件与投递之间的那一刻**（竞态的真实形状）：`drain` 已经把消息交出来了，而 `push` 之前
   * 输入流被收掉（终止落在这两步中间）。
   *
   * 为什么这一条必须单独钉：`markDelivered` 的契约是「适配器把消息真交给厂商**之后**」才调。
   * 把推失败的也登记进去，后果**不是**少投一条，而是**撤回面说假话**——那条消息已经被 `drain`
   * 从编排层队列里取走、却一个字节都没进 CLI 的命令队列，于是撤回会拿它的 uuid 去问厂商，
   * 厂商回 `false`（队列里没有这个 uuid），而 `false` 在这一家的读法里是
   * 「**已经交给智能体了，撤不回来**」⇒ 界面告诉用户「来不及了」，而它根本没交出去。
   */
  it('取件之后、投递之前被收流：那一条不登记成「已投递」（撤回面不许说「已经交出去了」）', async () => {
    const controller = new AbortController();
    const spy = createPortSpy((_boundary, index) => {
      // 第一次取件：先把流收掉（同步链：abort → interrupt → inputStream.end()），再把货交出来
      if (index === 0) {
        controller.abort();
        return [human('m-race', '这一条卡在收流那一刻')];
      }
      return [];
    });
    const recorder = createRecorder();
    setAgentRuntimeForTesting({
      sdkModule: {
        [CLAUDE_PACKAGE_NAME]: createFakeClaudeSdk({
          recorder,
          events: [],
          streamRounds: [ONE_ROUND],
          afterStop: [result('被中断那一轮的收尾')],
        }),
      },
    });
    await runWithin(createRunInput({ inject: spy.port, signal: controller.signal }));

    // 取件发生过（这正是竞态的前提：货已经从编排层队列里出来了）
    expect(spy.drains).toEqual(['round']);
    // 但它没能进厂商队列 ⇒ 既不登记身份、也不登记「怎么要回来」
    expect(spy.deliveredIds).toEqual([]);
    expect(spy.retracts).toEqual([]);
    // 厂商那一侧只收到题面：那条人工消息确实没投出去
    expect(recorder.pushed).toHaveLength(1);
  });
});

describe('cc 注入面：撤回（`cancelAsyncMessage` 不在公开面）', () => {
  /** 跑一轮并投一条人工消息，把「怎么要回来」那个闭包取出来 */
  async function delivered(cancelResult: 'ok' | 'absent' | 'false' | 'garbage' | 'reject'): Promise<{
    recorder: ReturnType<typeof createRecorder>;
    retract: (id: string) => Promise<RetractOutcome>;
  }> {
    const spy = createPortSpy((boundary) => (boundary === 'round' ? [human('m-1', '顺便把 changelog 补上')] : []));
    const recorder = createRecorder();
    setAgentRuntimeForTesting({
      sdkModule: { [CLAUDE_PACKAGE_NAME]: createFakeClaudeSdk({ recorder, events: [], streamRounds: [ONE_ROUND], cancelResult }) },
    });
    await runWithin(createRunInput({ inject: spy.port }));
    const retract = spy.retracts[0];
    if (retract === undefined) throw new Error('这一轮没有登记撤回闭包：投递没发生，用例的前提不成立');
    return { recorder, retract };
  }

  it('撤回按**我们自铸的 uuid** 认人：`cancelled: true` ⇒ retracted', async () => {
    const { recorder, retract } = await delivered('ok');
    await expect(retract('m-1')).resolves.toBe('retracted');
    const injected = recorder.pushed[1] as { uuid: string };
    // 认的是那一条自己的身份（不是文本、也不是「最近一条」）
    expect(recorder.cancelCalls).toEqual([injected.uuid]);
  });

  it('`cancelled: false` ⇒ already-consumed（竞态里厂商赢，不是「撤回失败」）', async () => {
    const { retract } = await delivered('false');
    await expect(retract('m-1')).resolves.toBe('already-consumed');
  });

  it('这一版没有那条控制请求 ⇒ unsupported（如实说做不到，不假装试过）', async () => {
    const { recorder, retract } = await delivered('absent');
    await expect(retract('m-1')).resolves.toBe('unsupported');
    expect(recorder.cancelCalls).toEqual([]);
  });

  it('回执形状不认识 / 请求抛错 ⇒ unknown（采不到 ≠ 撤失败）', async () => {
    const garbage = await delivered('garbage');
    await expect(garbage.retract('m-1')).resolves.toBe('unknown');
    const rejected = await delivered('reject');
    await expect(rejected.retract('m-1')).resolves.toBe('unknown');
  });

  it('不是这一批里的 id ⇒ unsupported（不把别人的身份当成自己的）', async () => {
    const { recorder, retract } = await delivered('ok');
    await expect(retract('m-other')).resolves.toBe('unsupported');
    expect(recorder.cancelCalls).toEqual([]);
  });
});

describe('cc 注入面：续接', () => {
  it('给了 `resume` ⇒ 落厂商同名字段；`continue` 一格都不许出现', async () => {
    const recorder = createRecorder();
    setAgentRuntimeForTesting({ sdkModule: { [CLAUDE_PACKAGE_NAME]: createFakeClaudeSdk({ recorder, events: [INIT, result('答复')] }) } });
    await claudeCodeProvider.run(createRunInput({ resume: { sessionId: 'session-abc' } }));

    expect(recorder.options?.resume).toBe('session-abc');
    /**
     * `continue` 取的是「当前目录最近一条」：重跑复用同一个 cwd 时会**静默续上一次尝试**
     * （用户以为在追问，智能体答的是上一轮的工作区上下文）⇒ 这一格必须始终缺席。
     */
    expect('continue' in (recorder.options ?? {})).toBe(false);
  });

  it('没给 `resume` ⇒ 这一格整个缺席（不是给 `undefined`）', async () => {
    const recorder = createRecorder();
    setAgentRuntimeForTesting({ sdkModule: { [CLAUDE_PACKAGE_NAME]: createFakeClaudeSdk({ recorder, events: [INIT, result('答复')] }) } });
    await claudeCodeProvider.run(createRunInput({}));
    expect('resume' in (recorder.options ?? {})).toBe(false);
  });

  it('会话 id 从 `system/init` 取并上报进行的快照；没有 init 就是 `null`（绝不编一个）', async () => {
    const withInit = createRecorder();
    setAgentRuntimeForTesting({ sdkModule: { [CLAUDE_PACKAGE_NAME]: createFakeClaudeSdk({ recorder: withInit, events: [INIT, result('答复')] }) } });
    expect((await claudeCodeProvider.run(createRunInput({}))).sessionId).toBe('session-abc');

    const withoutInit = createRecorder();
    setAgentRuntimeForTesting({ sdkModule: { [CLAUDE_PACKAGE_NAME]: createFakeClaudeSdk({ recorder: withoutInit, events: [ASSISTANT_TOOL, result('答复')] }) } });
    expect((await claudeCodeProvider.run(createRunInput({}))).sessionId).toBeNull();
  });
});

describe('cc 注入面：声明与事实互钉', () => {
  const declaration = claudeCodeProvider.metadata.turnInjection;

  it('声明本身是合法的一份（跨字段不变量由契约那条 schema 判）', () => {
    expect(declaration).toBeDefined();
    expect(TurnInjectionCapabilitySchema.safeParse(declaration).success).toBe(true);
  });

  it('投递两档是 `unverified`，通道 `wire`、无版本门、非 experimental', () => {
    /**
     * 为什么**还不能**写 `yes`，以及「未验证」到底指哪一半：
     *   · 已真路径证到的一半——消息被厂商**收下**（出站请求体里出现那句话）并**另起一轮**；
     *   · 仍是 `unverified` 的一半——契约 `'round'` 要的「**折进本轮**那条带工具结果的请求」
     *     做不到：折入窗口在厂商构造请求**之前**，而两档取件点都在其后。
     * 声明 `yes` 要配 real-path 场景，故如实记 `unverified`（有通道、那一格没证到）。
     */
    for (const cell of [declaration?.delivery.round, declaration?.delivery.idle]) {
      expect(cell).toMatchObject({
        state: 'unverified',
        reason: 'unverified',
        channel: 'wire',
        gate: null,
        experimental: false,
        // 证据档位：契约要的那一格（折进本轮）没被真路径驱动器观测过 ⇒ 今天只能记 `synthetic-fixture`
        proofDriver: 'synthetic-fixture',
      });
      // 临时档必须说清「为什么不是真路径」（契约只判非空，判不了说的是不是那件事）
      expect(cell?.proofDriverReason ?? '').toContain('折进本轮');
    }
  });

  it('撤回两档都是 `by-id`，且判据里写清「按自铸 uuid」与「不在公开面」', () => {
    for (const cell of [declaration?.retract.round, declaration?.retract.idle]) {
      expect(cell?.state).toBe('by-id');
      expect(cell?.reason).toContain('uuid');
      expect(cell?.reason).toContain('cancel_async_message');
      // 「不在公开面」这件事必须写在判据里：它决定界面说的是「撤回这一条」还是「这一版撤不了」
      expect(cell?.reason).toContain('公开面');
    }
  });

  it('续接是 `yes`（真机两进程 + 阴性对照证过），通道 `wire`、无版本门、驱动器是真路径', () => {
    expect(declaration?.resume).toEqual({
      state: 'yes',
      reason: null,
      channel: 'wire',
      gate: null,
      experimental: false,
      proofDriver: 'real-path',
      proofDriverReason: null,
    });
  });

  it('notes 带上三条会腐烂的前提：落点在 `tool_result.content`、每轮一条 `result`、`resume` 不用 `continue`', () => {
    const notes = (declaration?.notes ?? []).join('\n');
    expect(notes).toContain('tool_result');
    expect(notes).toContain('每一轮一条');
    expect(notes).toContain('不用 `continue`');
  });
});

/**
 * **消费方判据**：缺省车道的落点在 `tool_result` 块的 `content` 里——CLI 把注入的话折进那段正文
 * （形如 `<system-reminder>The user sent a new message while you were working: …</system-reminder>`），
 * 而 `tool_result.content` 有**字符串**与**块数组**两种外形。
 *
 * 只扫 `text` 块会把这件事读成「这句话没进主轮」，
 * 折进来的那段话也会在账本里整段消失。
 */
describe('cc 注入面：落点在 tool_result.content（消费方必须读它）', () => {
  /** 真机那条被折进工具结果正文的原文（措辞逐字来自 CLI 自己写的那句） */
  const FOLDED = [
    'probe-tool-done',
    '',
    '<system-reminder>',
    'The user sent a new message while you were working:',
    '顺便把 changelog 补上',
    '',
    'This is how Claude Code surfaces messages the user sends mid-turn — within the running turn, often alongside the next tool result, rather than as a separate conversation turn. Address the message above as you continue this turn.',
    '</system-reminder>',
  ].join('\n');

  /** 工具结果那条消息（`content` 两种外形各来一次） */
  function frame(content: unknown): unknown {
    return {
      type: 'user',
      uuid: 'u-t1',
      session_id: 'session-abc',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu-1', content }] },
    };
  }

  /** 走一遍消息归一 + 合并，返回消费方真正看到的那条工具结果正文 */
  function toolResultTextOf(content: unknown): string {
    const assembler = createMessageAssembler({ runId: 'run-inject' });
    const messages: { blocks: { type: string; text?: string }[] }[] = [];
    for (const draft of createClaudeMessageNormalizer().normalize(frame(content), createTurnState()).messages) {
      assembler.ingest(draft, (message) => messages.push(message as unknown as { blocks: { type: string; text?: string }[] }));
    }
    const block = messages.flatMap((message) => message.blocks).find((one) => one.type === 'tool-result');
    return block?.text ?? '';
  }

  it('字符串外形：折进 `tool_result.content` 的那句话必须出现在工具结果正文里', () => {
    expect(toolResultTextOf(FOLDED)).toContain('顺便把 changelog 补上');
  });

  it('块数组外形：同上（两种外形都要读，缺一种就有一条路整段静默丢失）', () => {
    expect(toolResultTextOf([{ type: 'text', text: FOLDED }])).toContain('顺便把 changelog 补上');
  });
});
