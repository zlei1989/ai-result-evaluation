// @vitest-environment node
/**
 * claude-code 的消息投影：计量三项齐全才有值、缺项 → null + WARN、重复丢弃、未识别保留。
 * 这里的两条断言（未识别不丢失 / 缺失得 null）是本计划的核心守卫，必须逐字按 spec §5.6.3 的措辞验。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { TurnState } from '../../turn';
import { projectClaudeMessage } from './events';
import { resetClaudeTaskNamesForTesting } from './message';

/**
 * 子任务名字表是**模块级**的（收场帧没有 `description`，名字只能在派发帧记下，见 `message.ts` 顶部）：
 * 生产上 `task_id` 每轮都是新 UUID、不会串，但**用例之间会串** ⇒ 每条用例前清一次，
 * 判据才只取决于本用例喂进去的消息。
 */
beforeEach(() => {
  resetClaudeTaskNamesForTesting();
});

const CONTEXT = { kind: 'claude-code', baseUrl: 'https://gw.example.com/anthropic' } as const;

/** 每个用例一份新状态：seen / turns / turnKeys 是同一次 run 内的累计量 */
function newState(): TurnState {
  return {
    seen: new Set(),
    turns: 0,
    usageInput: null,
    usageCached: null,
    usageOutput: null,
    usageReasoningOutput: null,
    usageTotal: null,
    // claude 的时间直接随投影交出（厂商自报），这一格本家不写；但状态形状三家是同一份
    timing: null,
    usageByMessageId: new Map(),
    turnKeys: new Set(),
    finalText: null,
  };
}

describe('projectClaudeMessage：result 与计量', () => {
  it('三项齐全时取数值（cached 取 cache_read_input_tokens）', () => {
    const projection = projectClaudeMessage(
      {
        type: 'result',
        subtype: 'success',
        uuid: 'r1',
        result: '任务完成',
        num_turns: 4,
        usage: { input_tokens: 120, cache_read_input_tokens: 30, output_tokens: 45 },
      },
      newState(),
      CONTEXT,
    );
    // 两个可选格这一条没给 ⇒ `null`（**不是 0**）：
    // `reasoningOutput: 0` 会让人得出「这家不做推理」，而事实是「这一条没报这一格」
    expect(projection.tokens).toEqual({
      input: 120,
      cached: 30,
      output: 45,
      reasoningOutput: null,
      total: null,
    });
    expect(projection.turns).toBe(4);
    expect(projection.failure).toBeNull();
    expect(projection.drafts.some((draft) => draft.type === 'log' && draft.text === '任务完成')).toBe(true);
  });

  /**
   * 思考 token 的落点（2026-10-XX 新增）：claude 的 `usage.output_tokens_details.thinking_tokens`。
   *
   * 为什么这一格值得单独守：它是**跨三家唯一的「思考量」来源之一**（codex 在会话文件的
   * `reasoning_output_tokens`、dsh 在 `reasoningTokens`），三家的字段名与路径都不一样，
   * 而契约里只有一格 `reasoningOutput`。读错了不会报错、只会一直显示「未采集」。
   * `input` 在这一家**不做减法**（Anthropic 的三格天生分列）——这一条同时也钉住那件事。
   */
  it('思考 token 取 output_tokens_details.thinking_tokens；input 不做减法（三家口径差异的落点）', () => {
    const projection = projectClaudeMessage(
      {
        type: 'result',
        subtype: 'success',
        uuid: 'r-thinking',
        result: '完成',
        usage: {
          input_tokens: 120,
          cache_read_input_tokens: 30,
          cache_creation_input_tokens: 700,
          output_tokens: 45,
          output_tokens_details: { thinking_tokens: 12 },
        },
      },
      newState(),
      CONTEXT,
    );
    expect(projection.tokens).toEqual({
      input: 120, // **不**减去 cached（与 codex 相反：那边的 cached 是 input 的明细）
      cached: 30, // 缓存**读**；缓存**写**（cache_creation_input_tokens）不计入命中率分子
      output: 45,
      reasoningOutput: 12,
      total: null, // claude 不报「总量原文」⇒ null，不拿三项之和冒充
    });
  });

  /**
   * 时间格（2026-10-XX 新增）：`result` 上三个**厂商自报**的时长。
   * `source: 'vendor'` 是这一格的重点——它是纯模型时间（不含工具执行），与另两家按事件时间戳
   * 算出来的墙钟不可直接比（口径差异见 contracts 的 `timing` 注释）。
   */
  it('时间：duration_ms / duration_api_ms / ttft_ms 原样带出，source 是 vendor', () => {
    const projection = projectClaudeMessage(
      {
        type: 'result',
        subtype: 'success',
        uuid: 'r-timing',
        result: '完成',
        duration_ms: 166_712,
        duration_api_ms: 158_753,
        ttft_ms: 7_558,
      },
      newState(),
      CONTEXT,
    );
    expect(projection.timing).toEqual({
      // `firstMs` / `lastMs` 是**相对**的：厂商只报时长、没有绝对时刻，骨架只做 `lastMs - firstMs`
      firstMs: 0,
      lastMs: 166_712,
      apiMs: 158_753,
      ttftMs: 7_558,
      source: 'vendor',
    });
  });

  it('时间：三格缺任意两格照样带上（各格独立）；一个都没有时整格不出现（不是全 null 的空壳）', () => {
    const partial = projectClaudeMessage(
      { type: 'result', subtype: 'success', uuid: 'r-t2', result: '完成', duration_ms: 1_000 },
      newState(),
      CONTEXT,
    );
    expect(partial.timing).toEqual({
      firstMs: 0,
      lastMs: 1_000,
      apiMs: null, // 采不到就是 null，**不许**拿 totalMs 冒充（那会把工具耗时算进模型速度）
      ttftMs: null,
      source: 'vendor',
    });

    const none = projectClaudeMessage(
      { type: 'result', subtype: 'success', uuid: 'r-t3', result: '完成', usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 } },
      newState(),
      CONTEXT,
    );
    // `undefined` = 「这一条没带时间」：骨架据此**保留**上一次的值，而不是把它清成 null
    expect(none.timing).toBeUndefined();
  });

  it('usage 整个缺失 → tokens null（不是 0）', () => {
    const projection = projectClaudeMessage(
      { type: 'result', subtype: 'success', uuid: 'r2', result: '完成', num_turns: 2 },
      newState(),
      CONTEXT,
    );
    expect(projection.tokens).toBeNull();
    expect(projection.turns).toBe(2);
  });

  /**
   * 终态轮次的口径（2026-09-28）：**以我们数出来的为准**（跑动期界面看的就是它，两边必须同源），
   * `num_turns` 只在一次都没数到时兜底；两者不一致要落 WARN——「厂商报 60、我们数出 58」这种事
   * 绝不静默。下面三条分别钉这三件事。
   */
  it('我们自己数到的轮次优先于 num_turns，两者不一致时落一条 WARN', () => {
    const state = newState();
    // 先喂一条 assistant（数到 1 次往返），再给一条自报 3 的 result
    projectClaudeMessage(
      { type: 'assistant', uuid: 'a1', message: { id: 'm1', content: [{ type: 'text', text: '改好了' }] } },
      state,
      CONTEXT,
    );
    const projection = projectClaudeMessage(
      { type: 'result', subtype: 'success', uuid: 'r-mismatch', result: '完成', num_turns: 3 },
      state,
      CONTEXT,
    );

    expect(projection.turns).toBe(1);
    const warn = projection.drafts.find(
      (draft) => draft.type === 'log' && draft.stream === 'stderr' && draft.text.includes('num_turns'),
    );
    expect(warn?.type === 'log' ? warn.text : '').toContain('num_turns=3');
    expect(warn?.type === 'log' ? warn.text : '').toContain('轮次=1');
  });

  it('两者一致时不落 WARN（不制造噪声）', () => {
    const state = newState();
    projectClaudeMessage(
      { type: 'assistant', uuid: 'a2', message: { id: 'm1', content: [{ type: 'text', text: '改好了' }] } },
      state,
      CONTEXT,
    );
    const projection = projectClaudeMessage(
      { type: 'result', subtype: 'success', uuid: 'r-same', result: '完成', num_turns: 1 },
      state,
      CONTEXT,
    );

    expect(projection.turns).toBe(1);
    expect(projection.drafts.some((draft) => draft.type === 'log' && draft.text.includes('num_turns'))).toBe(false);
  });

  it('usage 缺一项 → tokens null，并落一条保留原始负载的 WARN（Review Focus #5）', () => {
    const projection = projectClaudeMessage(
      {
        type: 'result',
        uuid: 'r3',
        result: '完成',
        usage: { input_tokens: 120, output_tokens: 45 }, // 少了 cache_read_input_tokens
      },
      newState(),
      CONTEXT,
    );
    expect(projection.tokens).toBeNull();
    const warn = projection.drafts.find((draft) => draft.type === 'log' && draft.stream === 'stderr');
    const text = warn?.type === 'log' ? warn.text : '';
    expect(text).toContain('不填 0');
    expect(text).toContain('input_tokens'); // 原始负载保留下来了
  });

  it('is_error 的 result → failure，并且按文案归因', () => {
    const projection = projectClaudeMessage(
      { type: 'result', subtype: 'error_max_turns', uuid: 'r4', is_error: true, result: 'HTTP 429 too many requests' },
      newState(),
      CONTEXT,
    );
    expect(projection.failure?.code).toBe('RATE_LIMITED');
    expect(projection.drafts.some((draft) => draft.type === 'error')).toBe(true);
  });
});

/**
 * 跑动期的实时用量估算（用户口径，2026-09-26：claude-code 也要在跑动期就看到 tok/轮次）。
 *
 * 依据（本机安装的 SDK 类型文档 `@anthropic-ai/claude-agent-sdk/sdk.d.ts`）：
 *   · assistant 消息带 `message.usage`，但它**不是最终值**（同一 message.id 会按内容块重复到达，
 *     每次只带该块的快照；「本轮总用量」在 result 消息上）；
 *   · result 的 `usage` 是**主循环**的合计（明写排除 Task 子智能体 / sidechain / 辅助调用），
 *     所以估算必须**只累加主循环**、**按 message.id 归并**，否则与终值不是同一个口径。
 *
 * 口径（三条都必须守住）：
 *   ① 估算只作为 `usage` **事件草稿**发出，**绝不**写进 `TurnProjection.tokens/turns`
 *      ——后者会流进 `AgentRunResult` 与落盘快照：崩溃/超时的行必须仍然是「未采集」，
 *      不能把估算伪装成采集结果；
 *   ② 单调不减：同一条 message.id 的后续快照覆盖前一份（不重复计数），值没变化就不重复发事件；
 *   ③ 子智能体的用量不计入（它不在 result 的合计口径里）。
 */
describe('projectClaudeMessage：跑动期的实时用量估算', () => {
  /** 一条主循环 assistant 消息（形状按探测 dump：用量在 message.usage 上） */
  function assistantMessage(input: {
    uuid: string;
    messageId: string;
    usage?: unknown;
    parentToolUseId?: string | null;
  }): unknown {
    return {
      type: 'assistant',
      uuid: input.uuid,
      parent_tool_use_id: input.parentToolUseId ?? null,
      message: {
        id: input.messageId,
        content: [{ type: 'text', text: `来自 ${input.messageId}` }],
        ...(input.usage === undefined ? {} : { usage: input.usage }),
      },
    };
  }

  const TRIO = { input_tokens: 100, cache_read_input_tokens: 20, output_tokens: 5 };

  it('主循环 assistant 消息：按 message.id 计一次轮次，估算以 tokensEstimated 交回骨架（界面靠它实时刷新）', () => {
    const projection = projectClaudeMessage(assistantMessage({ uuid: 'u1', messageId: 'm1', usage: TRIO }), newState(), CONTEXT);

    // 轮次在这一条上就涨（**不等 token**）：这正是原来「轮次被 token 拖住」的修法
    expect(projection.turns).toBe(1);
    // 估算走 tokens + tokensEstimated：只进事件、不进结果（见下一条）
    // （两个可选格在估算路径上是 `null`：`output_tokens_details` 不在流式中间快照里）
    expect(projection.tokens).toEqual({ input: 100, cached: 20, output: 5, reasoningOutput: null, total: null });
    expect(projection.tokensEstimated).toBe(true);
    // 估算不再自己 draft usage 事件（发射权归骨架，去重也在那里）
    expect(projection.drafts.some((draft) => draft.type === 'usage')).toBe(false);
  });

  it('估算被标成 tokensEstimated（骨架据此**不**把它写进 AgentRunResult）', () => {
    const projection = projectClaudeMessage(assistantMessage({ uuid: 'u2', messageId: 'm2', usage: TRIO }), newState(), CONTEXT);

    // 这一格一旦变成 false，估算就会流进结果、进而落进快照 —— 崩溃/被杀的行会看起来像「采到了计量」
    expect(projection.tokensEstimated).toBe(true);
  });

  it('不同 message.id：用量累加、轮次按 id 数（单调不减）', () => {
    const state = newState();
    projectClaudeMessage(assistantMessage({ uuid: 'u3', messageId: 'm1', usage: TRIO }), state, CONTEXT);
    const second = projectClaudeMessage(
      assistantMessage({
        uuid: 'u4',
        messageId: 'm2',
        usage: { input_tokens: 300, cache_read_input_tokens: 40, output_tokens: 7 },
      }),
      state,
      CONTEXT,
    );

    expect(second.turns).toBe(2);
    expect(second.tokens).toEqual({ input: 400, cached: 60, output: 12, reasoningOutput: null, total: null });
  });

  it('同一条 message.id 的后续快照**覆盖**前一份（轮次不重复计数）', () => {
    const state = newState();
    projectClaudeMessage(assistantMessage({ uuid: 'u5', messageId: 'm1', usage: TRIO }), state, CONTEXT);
    // 同一个 API 轮次按内容块重复到达：output 从 5 长到 9，input 不变
    const grown = projectClaudeMessage(
      assistantMessage({
        uuid: 'u6',
        messageId: 'm1',
        usage: { input_tokens: 100, cache_read_input_tokens: 20, output_tokens: 9 },
      }),
      state,
      CONTEXT,
    );

    expect(grown.turns).toBe(1); // 还是同一次往返
    expect(grown.tokens).toEqual({ input: 100, cached: 20, output: 9, reasoningOutput: null, total: null });
  });

  it('子智能体的消息不计入轮次、也不计用量（result 的合计口径里没有它）', () => {
    const state = newState();
    const projection = projectClaudeMessage(
      assistantMessage({ uuid: 'u9', messageId: 'sub-m1', usage: TRIO, parentToolUseId: 'toolu_1' }),
      state,
      CONTEXT,
    );

    expect(projection.turns).toBeNull();
    expect(projection.tokens).toBeNull();
    expect(state.usageByMessageId.size).toBe(0);
    expect(state.turns).toBe(0);
  });

  /**
   * **全 0 的估算快照 = 「这一条还没填好」，不是「采到了 0」**（2026-09-28 真机实测）。
   *
   * 实测那一轮（`12eff3a1` 的 claude-code 行，`likecode` 网关 + `jd/GLM-5.3`）：17 条 assistant
   * 消息的 `usage` 三项**全是 0**，而收尾 `result` 上的结算值是 `输入 65,063 / 缓存 407,808 /
   * 输出 5,940`。不过滤的话界面整轮显示「tok 0」——那是与「采集中」含义相反的假数。
   */
  it('估算：全 0 的用量快照按「还没采到」处理（不显示假的 tok 0），轮次照常涨', () => {
    const state = newState();
    const projection = projectClaudeMessage(
      assistantMessage({
        uuid: 'u-zero',
        messageId: 'm-zero',
        usage: { input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 },
      }),
      state,
      CONTEXT,
    );

    expect(projection.tokens).toBeNull();
    expect(state.usageByMessageId.size).toBe(0);
    // 轮次与它无关：照样 +1（这正是「轮次不被 token 拖住」那条口径的一半）
    expect(projection.turns).toBe(1);
  });

  // 这一组是**新口径**的核心：轮次与用量各自独立。
  // 实测缺口：那一轮 60 次模型往返、而用量几乎采不到 ⇒ 旧口径整轮只发得出一条 usage（turns: 1）。
  it('采不到用量时**照样**按 message.id 计轮次（轮次不被 token 拖住）', () => {
    const state = newState();
    const first = projectClaudeMessage(
      assistantMessage({ uuid: 'u10', messageId: 'm9', usage: { input_tokens: 100, output_tokens: 5 } }),
      state,
      CONTEXT,
    );
    const second = projectClaudeMessage(assistantMessage({ uuid: 'u11', messageId: 'm10' }), state, CONTEXT);

    expect(first.tokens).toBeNull(); // 三项不齐 ⇒ 不发明一个 0
    expect(first.turns).toBe(1);
    expect(second.tokens).toBeNull();
    expect(second.turns).toBe(2);
  });

  it('缺 message.id 时轮次与用量都不出数（没有归并键 ⇒ 重复到达会重复计数，宁可不出数）', () => {
    const state = newState();
    const projection = projectClaudeMessage(
      { type: 'assistant', uuid: 'u12', parent_tool_use_id: null, message: { content: [], usage: TRIO } },
      state,
      CONTEXT,
    );

    expect(projection.turns).toBeNull();
    expect(projection.tokens).toBeNull();
  });

  /**
   * 归属（2026-10-05，spec §2.3）：claude 的读数只由**主循环**消息触发（侧链 `parent_tool_use_id`
   * 非空时 `countModelRoundTrip` 返回 `null` ⇒ 骨架根本不发 `usage`）⇒ 归属恒是主会话 + 当前主循环计数。
   */
  it('usage 投影带归属（主会话 + 主循环计数）；侧链消息不带归属也不发 usage', () => {
    const TRIO = { input_tokens: 100, cache_read_input_tokens: 20, output_tokens: 5 };
    const state = newState();
    const first = projectClaudeMessage(assistantMessage({ uuid: 'u1', messageId: 'msg-1', usage: TRIO }), state, CONTEXT);
    expect(first.turns).toBe(1);
    expect(first.turn).toEqual({ subagentId: null, round: 1 });

    const side = projectClaudeMessage(
      assistantMessage({ uuid: 'u2', messageId: 'sub-msg-1', usage: TRIO, parentToolUseId: 'toolu_1' }),
      state,
      CONTEXT,
    );
    // 侧链不占主循环的号（既有口径）⇒ 这一条没有轮次，也就没有归属可言。
    // 归属格写**显式 `null`**（2026-10-05 审查轮 1 裁定）：投影层与草稿层同一种形状
    //（`AgentEventDraft` 那一格恒在，没有归属就是 `null`），读的人不必去问「缺省与 null 在这里有没有别」。
    expect(side.turns).toBeNull();
    expect(side.turn).toBeNull();
  });

  /**
   * 收尾读数的归属（2026-10-05，spec §2.3）：`result` 是**主循环**的收尾那条 ⇒ 它的**每一个**返回点
   * 都要带同一格「(主会话, 数出来的号)」：结构化输出重试用尽、正常收尾、以及别种 `is_error` 的失败收尾。
   *
   * 为什么这一条要单独钉：`TurnProjection.turn` 是**可选格**，漏填既不报类型错、也不会让任何既有用例变红
   * ——而漏掉的那一支一旦有轮次，骨架照样发 `usage`（发射门槛只看轮次）⇒ 界面上那一条读数退成
   * 「没有归属 ⇒ 按时刻乱归位」，正是本设计要消灭的错位（范式同 dsh 的 `turn/end`：成功与失败两个分支都要带）。
   */
  it('result 的每个返回点都带归属；一次号都没数到时整格是 null（不编一个号）', () => {
    const state = newState();
    projectClaudeMessage(assistantMessage({ uuid: 'u-r0', messageId: 'm-r0', usage: TRIO }), state, CONTEXT);

    // ① 正常收尾
    const ok = projectClaudeMessage(
      { type: 'result', subtype: 'success', uuid: 'r-ok', result: '完成' },
      state,
      CONTEXT,
    );
    expect(ok.turns).toBe(1);
    expect(ok.turn).toEqual({ subagentId: null, round: 1 });

    // ② 结构化输出重试用尽（评分通路的收场）
    const exhausted = projectClaudeMessage(
      { type: 'result', subtype: 'error_max_structured_output_retries', uuid: 'r-ex', is_error: true, result: '' },
      state,
      CONTEXT,
    );
    expect(exhausted.failure?.code).toBe('AGENT_FAILED');
    expect(exhausted.turn).toEqual({ subagentId: null, round: 1 });

    // ③ 别种失败收尾（`is_error` 且 subtype 不是结构化重试）
    const failed = projectClaudeMessage(
      { type: 'result', subtype: 'error_max_turns', uuid: 'r-fail', is_error: true, result: 'HTTP 429 too many requests' },
      state,
      CONTEXT,
    );
    expect(failed.failure?.code).toBe('RATE_LIMITED');
    expect(failed.turn).toEqual({ subagentId: null, round: 1 });

    // ④ 一次往返都没数到（没有 assistant 消息、也没有 num_turns 兜底）⇒ 没有归属可言：`null`，不编号
    // （与「计量绝不填 0」同一条口径：没有号就不假装有）
    const noRound = projectClaudeMessage({ type: 'result', uuid: 'r-none', result: '完成' }, newState(), CONTEXT);
    expect(noRound.turns).toBeNull();
    expect(noRound.turn).toBeNull();
  });

  /**
   * 归属里的轮次必须是**刚数出来的那个数**，不是一个长得像的常量（2026-10-05 审查轮 1 / 发现 1）。
   *
   * 为什么这一条非有不可：上面两组的四处断言全是 `round: 1`（那两组的主循环只投了一条消息），
   * 于是**把四个出口统统硬编码成 `round: 1` 也能让整个包全绿**——而「轮次 = 主循环计数」正是本任务的
   * 核心断言。同族的 dsh 守卫断的就是第 2 轮（`providers/dsh/events.test.ts`）。
   *
   * 这一条因此用**同一个 state** 连投两条不同 `message.id` 的主循环消息，再让**每一个**能发 `usage`
   * 的出口（assistant / result 的正常收尾 / 结构化输出重试用尽 / 别种失败收尾）各报一次归属，
   * 四处都必须是第 2 轮；最后插一条侧链消息，证明它既不占号也带不来归属（既有一轮一次的口径）。
   */
  it('归属的轮次是数出来的：第二条主循环消息之后，四个出口都报 round 2', () => {
    const state = newState();
    const first = projectClaudeMessage(
      assistantMessage({ uuid: 'u-n1', messageId: 'msg-n1', usage: TRIO }),
      state,
      CONTEXT,
    );
    const second = projectClaudeMessage(
      assistantMessage({ uuid: 'u-n2', messageId: 'msg-n2', usage: TRIO }),
      state,
      CONTEXT,
    );
    expect(first.turn).toEqual({ subagentId: null, round: 1 });
    expect(second.turn).toEqual({ subagentId: null, round: 2 });

    // 三个收尾出口与 assistant 同源：报的也是这个数（不是各自抄了一个常量）
    const ok = projectClaudeMessage(
      { type: 'result', subtype: 'success', uuid: 'r-n-ok', result: '完成' },
      state,
      CONTEXT,
    );
    const exhausted = projectClaudeMessage(
      { type: 'result', subtype: 'error_max_structured_output_retries', uuid: 'r-n-ex', is_error: true, result: '' },
      state,
      CONTEXT,
    );
    const failed = projectClaudeMessage(
      { type: 'result', subtype: 'error_max_turns', uuid: 'r-n-fail', is_error: true, result: 'HTTP 429 too many requests' },
      state,
      CONTEXT,
    );
    expect(ok.turn).toEqual({ subagentId: null, round: 2 });
    expect(exhausted.turn).toEqual({ subagentId: null, round: 2 });
    expect(failed.turn).toEqual({ subagentId: null, round: 2 });

    // 侧链消息插在中间：它不占号（既有口径），也就带不来归属 —— 上面那个 2 一动不动
    const side = projectClaudeMessage(
      assistantMessage({ uuid: 'u-n3', messageId: 'sub-n2', usage: TRIO, parentToolUseId: 'toolu_2' }),
      state,
      CONTEXT,
    );
    expect(side.turns).toBeNull();
    expect(side.turn).toBeNull();
    expect(state.turns).toBe(2);
  });
});

describe('projectClaudeMessage：重复与未识别', () => {
  it('同一 uuid 只投影一次（唯一允许丢弃的一类）', () => {
    const state = newState();
    const message = { type: 'assistant', uuid: 'a1', message: { content: [{ type: 'text', text: 'hello' }] } };
    const first = projectClaudeMessage(message, state, CONTEXT);
    const second = projectClaudeMessage(message, state, CONTEXT);
    expect(first.drafts).toHaveLength(1);
    expect(second.drafts).toEqual([]);
  });

  it('未识别的 type 被投影成保留原始负载的日志事件（逐字段保留，不丢失）', () => {
    const payload = { type: 'future_thing', uuid: 'f1', payload: { nested: [1, 2], deep: { a: true } } };
    const projection = projectClaudeMessage(payload, newState(), CONTEXT);
    expect(projection.drafts).toHaveLength(1);
    const draft = projection.drafts[0];
    expect(JSON.parse(draft?.type === 'log' ? draft.text : '')).toEqual(payload);
  });

  /**
   * stream_event **不进原始日志**（2026-10-09 用户口径，真机形状照抄）：
   * 一条增量只带一小段 delta（真机一次运行几百上千条），落进未识别兜底会把「原始输出」面板
   * 刷成 JSON 流水。它的落点只有对话视图（消息侧 `streamEvent` 折成 `chunk:'delta'`、
   * 编排层只广播不落盘 ⇒ SSE 驱动执行日志打字机）。事件侧零产出、去重照常（同 uuid 再来仍丢）。
   */
  it('stream_event 零事件产出（thinking/text 两种 delta 都不落原始日志），重复 uuid 照常丢弃', () => {
    const state = newState();
    const thinkingDelta = {
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '.' } },
      session_id: '871f7b1e-2643-4680-8cdb-04def93bd8a4',
      parent_tool_use_id: null,
      uuid: '4f922758-dffb-4b88-af65-c4a3f6a28fbc',
    };
    expect(projectClaudeMessage(thinkingDelta, state, CONTEXT).drafts).toEqual([]);
    const textDelta = {
      type: 'stream_event',
      uuid: 'se-text-1',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '正在' } },
    };
    expect(projectClaudeMessage(textDelta, state, CONTEXT).drafts).toEqual([]);
    // 去重照常：同一 uuid 的第二条增量仍然零产出（不因「本来就不落」而跳过 seen 表）
    expect(projectClaudeMessage(textDelta, state, CONTEXT).drafts).toEqual([]);
  });

  /**
   * `system/thinking_tokens`（**思考进度帧**）同样不进原始日志（2026-10-09 真机修的第二个通道）。
   *
   * 为什么单独一条用例：第一版只挡了 `stream_event`，而真机上刷屏的其实是**这一种**——
   * run `7f05c765` 的 claude 行 12,509 条 `log` 里有 **11,629 条**是它（93%），
   * 评分智能体那条路再叠 670 条。形状逐字取自那次真机的 `events.jsonl`。
   *
   * 它不是内容也不是计量：SDK 的 `SDKThinkingTokensMessage` 注释逐字写着
   * *Live thinking-token estimate … Approximate progress for spinners/pills, not the authoritative
   * billed output_tokens* ⇒ 权威值在收尾的 `result.usage.output_tokens_details.thinking_tokens`。
   */
  it('system/thinking_tokens 零事件产出（真机 11,629 条的那种刷屏帧），重复 uuid 照常丢弃', () => {
    const state = newState();
    // 真机原文（run 7f05c765 的 claude 行，只删掉与本条无关的字段顺序差异）
    const frame = {
      type: 'system',
      subtype: 'thinking_tokens',
      estimated_tokens: 1,
      estimated_tokens_delta: 1,
      session_id: '8a23d018-0dec-4c5c-b67f-8d98ac31d970',
      uuid: 'b51b18af-2b8c-4af6-a4d8-abbc51c011ac',
    };
    expect(projectClaudeMessage(frame, state, CONTEXT).drafts).toEqual([]);
    // 去重表照常走：同 uuid 第二条仍零产出（也仍然不许落盘）
    expect(projectClaudeMessage(frame, state, CONTEXT).drafts).toEqual([]);

    /**
     * 反向判据（这条用例的靶子）：`system` 下**别的** subtype 照旧保留原始负载——
     * 把排除条件写成「凡 system 一律丢」会让 `status` / `compact_boundary` 这些真事实消失，
     * 那种「顺手多丢一点」正是本条要拦的另一半。
     */
    const status = { type: 'system', subtype: 'status', status: 'compacting', uuid: 'status-1' };
    const projection = projectClaudeMessage(status, newState(), CONTEXT);
    expect(projection.drafts).toHaveLength(1);
    expect(JSON.parse(projection.drafts[0]?.type === 'log' ? projection.drafts[0].text : '')).toEqual(status);
  });

  it('assistant 的文本块与工具块都落盘（工具调用是候选行为的一部分）', () => {
    const projection = projectClaudeMessage(
      {
        type: 'assistant',
        uuid: 'a2',
        message: {
          content: [
            { type: 'text', text: '我来改文件' },
            { type: 'tool_use', id: 't1', name: 'Edit', input: { path: 'README.md' } },
          ],
        },
      },
      newState(),
      CONTEXT,
    );
    const texts = projection.drafts
      .filter((draft) => draft.type === 'log')
      .map((draft) => (draft.type === 'log' ? draft.text : ''));
    expect(texts[0]).toBe('我来改文件');
    expect(texts[1]).toContain('tool_use');
  });

  /**
   * 工具块那一条的**人话摘要**（用户口径，2026-09-29）：卡片底部的活动行显示 `summary`，
   * 而 `[{"type":"tool_use",…}]` 那种几百字符的 JSON 不是消息。原始负载仍逐字在 `text` 里。
   *
   * **2026-10-07 加参数**：从前只给工具名（`调用工具 Bash`），而同一行原始负载里 `input.command`
   * 写着 `ls -la "D:/w"` —— 那句摘要比它替换掉的人话信息量更低（活动行反而更差）。
   * 现在参数摘要与另两家共用 `src/activity.ts`：同一句句式、同一把截断尺子。
   */
  it('工具块带人话摘要（工具名 + 参数，多个块串成一句），原始 JSON 一个字段都不少', () => {
    const projection = projectClaudeMessage(
      {
        type: 'assistant',
        uuid: 'a-tool',
        message: {
          content: [
            { type: 'tool_use', id: 't1', name: 'Edit', input: { path: 'README.md' } },
            { type: 'tool_use', id: 't2', name: 'Edit', input: { path: 'a.ts' } },
            { type: 'tool_use', id: 't3', name: 'Bash', input: { command: 'ls' } },
          ],
        },
      },
      newState(),
      CONTEXT,
    );
    const [draft] = projection.drafts;

    expect(draft?.type === 'log' ? draft.summary : undefined).toBe(
      '调用工具 Edit：README.md；调用工具 Edit：a.ts；调用工具 Bash：ls',
    );
    expect(draft?.type === 'log' ? draft.text : '').toContain('"name":"Bash"');
  });

  it('assistant 没有可读内容块时也保留原始负载（不产生空投影）', () => {
    const projection = projectClaudeMessage({ type: 'assistant', uuid: 'a3' }, newState(), CONTEXT);
    expect(projection.drafts).toHaveLength(1);
  });

  it('空文本块不落成空日志：有别的块时只落别的块（评审 L4）', () => {
    // `{ type: 'text', text: '' }` 不是「未知事件」，但它也不是一条可读日志——落下去就是抽屉里的一行空白。
    const projection = projectClaudeMessage(
      {
        type: 'assistant',
        uuid: 'a4',
        message: {
          content: [
            { type: 'text', text: '' },
            { type: 'tool_use', id: 't2', name: 'Edit', input: { path: 'README.md' } },
          ],
        },
      },
      newState(),
      CONTEXT,
    );
    const logs = projection.drafts
      .filter((draft) => draft.type === 'log')
      .map((draft) => (draft.type === 'log' ? draft.text : ''));
    expect(logs).toHaveLength(1); // 只有工具块那一条
    expect(logs).not.toContain('');
    expect(logs[0]).toContain('tool_use');
  });

  it('只有空文本块时退回原始负载（既不落空日志，也不静默丢弃）', () => {
    const raw = { type: 'assistant', uuid: 'a5', message: { content: [{ type: 'text', text: '' }] } };
    const projection = projectClaudeMessage(raw, newState(), CONTEXT);
    expect(projection.drafts).toHaveLength(1);
    const draft = projection.drafts[0];
    expect(JSON.parse(draft?.type === 'log' ? draft.text : '')).toEqual(raw);
  });

  /**
   * `user` 消息承载的是工具结果（真机形状：
   * `{"type":"user","message":{"role":"user","content":[{"tool_use_id":…,"type":"tool_result","content":…}]}}`）。
   *
   * 口径（2026-10-07 统一）：**成功返回不播、报错必须播**——活动行回答「在做什么」，
   * 而「这一行出事了」没有别的行级出口。原始负载两种情形都照旧逐字落盘。
   */
  it('工具结果：成功返回**不给摘要**、报错给「工具报错：…」，两者的原始负载都不动', () => {
    const ok = projectClaudeMessage(
      {
        type: 'user',
        uuid: 'u-ok',
        message: {
          role: 'user',
          content: [{ tool_use_id: 't1', type: 'tool_result', content: 'File created successfully at: D:\\w\\index.html' }],
        },
      },
      newState(),
      CONTEXT,
    );
    expect(ok.drafts).toHaveLength(1);
    expect(ok.drafts[0]?.type === 'log' ? ok.drafts[0].summary : 'x').toBeUndefined();
    expect(ok.drafts[0]?.type === 'log' ? ok.drafts[0].text : '').toContain('File created successfully');

    const bad = projectClaudeMessage(
      {
        type: 'user',
        uuid: 'u-bad',
        message: {
          role: 'user',
          content: [
            {
              tool_use_id: 't2',
              type: 'tool_result',
              is_error: true,
              // 内容块数组那种外形（真机两种都出现过）
              content: [{ type: 'text', text: 'Error: ENOENT: no such file or directory' }],
            },
          ],
        },
      },
      newState(),
      CONTEXT,
    );
    expect(bad.drafts[0]).toMatchObject({ summary: '工具报错：Error: ENOENT: no such file or directory' });
  });
});

/**
 * 最终答复出口（spec §8 / D2）：评分智能体要从结果里读到「模型最后说了什么」，
 * 而不是从 `log` 事件流里重建——重建三家形状各不相同，不可靠。
 * claude-code 的收尾消息是 `result`，故答复只在它上面采；中间轮次的 assistant 文本不算答复。
 */
describe('projectClaudeMessage：最终答复（finalText）', () => {
  it('result 消息的 result 字段被记为最终答复（AgentRunResult.finalText 的来源）', () => {
    const state = newState();
    projectClaudeMessage({ type: 'result', uuid: 'r-final', result: '{"dimensions":[]}' }, state, CONTEXT);
    expect(state.finalText).toBe('{"dimensions":[]}');
  });

  it('assistant 消息不写最终答复（收尾以 result 为准，中间轮次的文本不算）', () => {
    const state = newState();
    projectClaudeMessage(
      { type: 'assistant', uuid: 'a-final', message: { content: [{ type: 'text', text: '我先看看' }] } },
      state,
      CONTEXT,
    );
    expect(state.finalText).toBeNull();
  });
});

describe('projectClaudeMessage：形状异常与空文案（评审 N2 / N3）', () => {
  it('usage 根本不是对象（形状异常）→ tokens null 且仍落一条带原始负载的 WARN（N2：不得静默）', () => {
    const projection = projectClaudeMessage(
      { type: 'result', uuid: 'r6', result: '完成', usage: 5 },
      newState(),
      CONTEXT,
    );
    expect(projection.tokens).toBeNull();
    const warn = projection.drafts.find((draft) => draft.type === 'log' && draft.stream === 'stderr');
    const text = warn?.type === 'log' ? warn.text : '';
    expect(text).toContain('不填 0');
    expect(text).toContain('5'); // 原始负载保留下来了
  });

  it('usage 整个缺失也落 WARN（与形状异常合流，N2）', () => {
    const projection = projectClaudeMessage({ type: 'result', uuid: 'r7', result: '完成' }, newState(), CONTEXT);
    expect(projection.tokens).toBeNull();
    expect(projection.drafts.some((draft) => draft.type === 'log' && draft.stream === 'stderr')).toBe(true);
  });

  it('is_error 且 result 是空串 → 用 subtype 兜底文案，绝不产生空文案的失败（N3）', () => {
    const projection = projectClaudeMessage(
      { type: 'result', subtype: 'error_max_turns', uuid: 'r8', is_error: true, result: '' },
      newState(),
      CONTEXT,
    );
    expect(projection.failure?.message).toContain('error_max_turns');
    expect(projection.failure?.message).not.toBe('');
    const errorDraft = projection.drafts.find((draft) => draft.type === 'error');
    expect(errorDraft?.type === 'error' ? errorDraft.message : '').toContain('error_max_turns');
    // 空串不该被当成「最终答复」落成空日志
    expect(projection.drafts.some((draft) => draft.type === 'log' && draft.text === '')).toBe(false);
  });
});

/**
 * 结构化输出的最终答复出口（2026-09-28 评分通路的结构化产出）。
 *
 * 为什么出口要优先取 `structured_output`：结构化那一轮可能以 tool_result 载体收尾、**没有尾随
 * assistant 消息**（`sdk.d.ts:2054-2065` 逐字写着 end-turn tool sessions "ends on a successful
 * tool_result carrier — with no trailing assistant message — followed by a `structured_output`
 * attachment holding the turn's actual output"）⇒ 同一轮的 `result` 文本可能为空串。若仍只看
 * `result`，评分阶段拿到的就是「未采到答复」，而模型其实已经按 schema 给出了结论。
 * 下面六条分别钉：优先取、两个来源不一致时不静默、一致时不落 WARN、缺失时既有路径逐字不变、
 * 显式 `null` 与空串按缺失处理、字符串形态不二次编码。
 */
describe('projectClaudeMessage：结构化输出的最终答复出口', () => {
  it('structured_output 存在 ⇒ finalText 是它的序列化（即使 result 是空串）', () => {
    const state = newState();
    const raw = { type: 'result', subtype: 'success', result: '', structured_output: { verdict: '还行' } };
    projectClaudeMessage(raw, state, CONTEXT);
    expect(state.finalText).toBe('{"verdict":"还行"}');
  });

  it('两个来源同时存在且内容不同 ⇒ 落一条 WARN，且以 structured_output 为准', () => {
    const state = newState();
    const raw = {
      type: 'result', result: '我给了个散文',
      structured_output: { dimensions: [], totalScore: 0, verdict: '还行' },
    };
    const projection = projectClaudeMessage(raw, state, CONTEXT);
    expect(state.finalText).toBe('{"dimensions":[],"totalScore":0,"verdict":"还行"}');
    // 判据必须**点名**那条不一致 WARN（修复轮 2 / Finding 1）：本 fixture 没有 `usage`，而 `readTokens`
    // 在三元组不齐时**无条件**落一条「用量负载不完整…」WARN ⇒ 原来那句 `includes('[WARN]')` 与「两源不
    // 一致」无关地**恒真**。实测形状：把 events.ts 里那条不一致 WARN 整段删掉，本文件 31 条**全绿** ——
    // 也就是说「两个来源不一致要落 WARN」这条要求在仓里当时没有任何会红的用例（plan-mandated 假守卫）。
    expect(
      projection.drafts.some(
        (draft) => draft.type === 'log' && draft.text.includes('structured_output 与 result 文本不一致'),
      ),
    ).toBe(true);
  });

  it('两个来源同时存在且内容**一致** ⇒ 不落那条不一致 WARN（否证，修复轮 2 / R25）', () => {
    const state = newState();
    // 一致时 `result` 与序列化逐字相同（结构化那条路径上 `result` 就是同一份 JSON 文本）
    const serialized = '{"verdict":"还行"}';
    const projection = projectClaudeMessage(
      { type: 'result', result: serialized, structured_output: { verdict: '还行' } },
      state,
      CONTEXT,
    );
    expect(state.finalText).toBe(serialized);
    // 同样点名文案，不写 blanket 的「一条 [WARN] 都没有」（本 fixture 无 usage ⇒ 会有无关的用量 WARN）
    expect(
      projection.drafts.some(
        (draft) => draft.type === 'log' && draft.text.includes('structured_output 与 result 文本不一致'),
      ),
    ).toBe(false);
  });

  it('没有 structured_output ⇒ 仍取 result（既有路径逐字不变）', () => {
    const state = newState();
    projectClaudeMessage({ type: 'result', result: '{"verdict":"还行"}' }, state, CONTEXT);
    expect(state.finalText).toBe('{"verdict":"还行"}');
  });

  /**
   * 出厂形状的**四态**（修复轮 1 控制方 Finding A、B；修复轮 2 的 R24 补了空串那一格）。
   * `structured_output?: unknown` 什么都没承诺，下面三条把「没验证过的输入假设」两侧都封住：
   * 显式 `null` 与空串 `''` 都与「字段缺失」同义（没有**可用的**结构化产出），已序列化的 JSON
   * 字符串按 JSON 文本原样用（不二次编码）。真机只需要确认走的是哪一支。
   */
  it('structured_output 是显式 null ⇒ 按「没有结构化产出」处理：落到 result 文本，且不落不一致 WARN', () => {
    const state = newState();
    const raw = { type: 'result', result: '{"verdict":"还行"}', structured_output: null };
    const projection = projectClaudeMessage(raw, state, CONTEXT);

    // 修好之前这里会是字符串 'null'（`safeStringify(null)`）⇒ 每一条非 schema 行的答复都被静默顶掉
    expect(state.finalText).toBe('{"verdict":"还行"}');
    // 判据必须**点名**那条 WARN，不能写「一条 [WARN] 都没有」：本 fixture 没有 usage，而 `readTokens` 的
    // 「用量负载不完整」WARN 是既有行为、与本次出口无关 ⇒ blanket 断言在这里必然假红，且红的原因还不是
    // 被测行为（与 COMMIT-RULES 第五节「探针必须红在被测行为上」同一条教训）。
    expect(
      projection.drafts.some(
        (draft) => draft.type === 'log' && draft.text.includes('structured_output 与 result 文本不一致'),
      ),
    ).toBe(false);
  });

  it('structured_output 是空串 ⇒ 与 null 同义：落到 result 文本（空产出不许顶掉非空答复）', () => {
    const state = newState();
    const projection = projectClaudeMessage(
      { type: 'result', result: '{"verdict":"还行"}', structured_output: '' },
      state,
      CONTEXT,
    );

    // 修好之前：`''` 既非 undefined 也非 null ⇒ 走结构化分支、serialized = '' ⇒ 非空的 result 被空串顶掉，
    // 还会因为 '' !== text 落一条假的不一致 WARN。这与下面 `result` 那一支拒绝空串的判据自相矛盾（N3）。
    expect(state.finalText).toBe('{"verdict":"还行"}');
    expect(
      projection.drafts.some(
        (draft) => draft.type === 'log' && draft.text.includes('structured_output 与 result 文本不一致'),
      ),
    ).toBe(false);
  });

  it('structured_output 是已序列化的 JSON 字符串 ⇒ 原样当 JSON 文本（不二次编码）', () => {
    const state = newState();
    projectClaudeMessage({ type: 'result', structured_output: '{"verdict":"还行"}' }, state, CONTEXT);

    // 二次编码的产物是 '"{\"verdict\":\"还行\"}"' ⇒ 下游 parse 出来是**字符串**而不是对象，
    // schema 约束下的每一行都会失败在「顶层不是对象」。逐字相等就是这条的判据。
    expect(state.finalText).toBe('{"verdict":"还行"}');
  });
});

/**
 * 结构化输出重试用尽的归因（Task 3 Step 5）。
 * 为什么这一格要单独钉：`error_max_structured_output_retries` 是**评分通路**才会遇到的收场
 * （候选执行阶段不传 schema），而它是 CLI 的英文 subtype。把它原样冒到界面，等于让使用者去猜
 * 「我的评分为什么没出分」；折成中文之后，界面上那句话本身就指向可执行的下一步。
 */
describe('projectClaudeMessage：结构化输出重试用尽的归因', () => {
  it('subtype=error_max_structured_output_retries ⇒ 中文归因，不是把 CLI 的英文 subtype 冒到界面', () => {
    const state = newState();
    const projection = projectClaudeMessage(
      { type: 'result', subtype: 'error_max_structured_output_retries', is_error: true, result: '' },
      state,
      CONTEXT,
    );
    expect(projection.failure?.code).toBe('AGENT_FAILED');
    expect(projection.failure?.message).toContain('结构化输出');
    expect(projection.failure?.message).not.toContain('error_max_structured_output_retries');
  });
});

/**
 * 子智能体生命周期（spec §6 / §6.4）：claude 侧走 SDK **原生 `system/task_*` 消息**。
 *
 * 为什么这些守卫值得存在：`system` 类型过去**一律**落成 `unknownEventDraft`
 * （`events.ts` 的兜底分支），于是子智能体的派生与收场**只在原始 JSON 里躺着**、
 * 界面上完全不可见。真机实测（2.1.281）这些消息**默认就发**，不需要任何 SDK 选项。
 *
 * 载荷逐字取自真机（§6.4.1），不是编的形状。
 */
describe('projectClaudeMessage：子智能体生命周期', () => {
  /** 真机 task_started（§6.4.1 ①） */
  const TASK_STARTED = {
    type: 'system',
    subtype: 'task_started',
    uuid: 'u-start',
    task_id: 'ac9fca27ed014a4ea',
    tool_use_id: 'call_e086fd6fde2f4f1ab029fce9',
    description: 'Count lines in notes.txt',
    subagent_type: 'general-purpose',
    is_backgrounded: false,
    spawn_depth: 1,
    task_type: 'local_agent',
    prompt: 'Count the number of lines in the file notes.txt …',
  };

  /** 真机 task_notification（§6.4.1 ②） */
  const TASK_DONE = {
    type: 'system',
    subtype: 'task_notification',
    uuid: 'u-done',
    task_id: 'ac9fca27ed014a4ea',
    tool_use_id: 'call_e086fd6fde2f4f1ab029fce9',
    status: 'completed',
    summary: '**3 lines** in `/tmp/x/notes.txt` (per `wc -l`).',
    usage: { total_tokens: 19901, tool_uses: 2, duration_ms: 14496 },
  };

  it('task_started ⇒ 一条可解析的「已派发子任务」日志（含归属键与身份）', () => {
    const projection = projectClaudeMessage(TASK_STARTED, newState(), CONTEXT);
    expect(projection.drafts).toHaveLength(1);
    const [draft] = projection.drafts;
    expect(draft?.type).toBe('log');

    // 载荷必须**可解析**：这些字段是下游建索引用的，不是给人看的散文
    const payload = JSON.parse((draft as { text: string }).text);
    expect(payload.kind).toBe('subagent');
    expect(payload.phase).toBe('start');
    expect(payload.source).toBe('wire');
    expect(payload.subagentId).toBe('ac9fca27ed014a4ea');
    // 厂商原生 id ⇒ vendorId 与 subagentId 同值（spec §6.4.3：claude **不需要合成 id**）
    expect(payload.vendorId).toBe('ac9fca27ed014a4ea');
    // 归属键：**这就是「用 parent_tool_use_id 划分归属」的那座桥**（真机实测三者相同）
    expect(payload.parentToolUseId).toBe('call_e086fd6fde2f4f1ab029fce9');
    expect(payload.name).toBe('Count lines in notes.txt');
    expect(payload.subagentKind).toBe('general-purpose');
    expect(payload.spawnDepth).toBe(1);
    expect(payload.isBackgrounded).toBe(false);
    // 活动行摘要要能读懂，且带厂商给的任务名
    expect((draft as { summary?: string }).summary).toContain('Count lines in notes.txt');
  });

  it('没有 description 时摘要**不留占位名**（旧实现产出的是「已派发子任务：子任务」）', () => {
    const projection = projectClaudeMessage({ ...TASK_STARTED, description: undefined }, newState(), CONTEXT);
    // 词表实现只有一份（`src/activity.ts`）：名字缺失时整句就是「已派发子任务」
    expect(projection.drafts[0]).toMatchObject({ summary: '已派发子任务' });
  });

  /**
   * 收场帧**没有** `description`（真机键集：`task_notification` = task_id / tool_use_id / status /
   * output_file / summary / usage / uuid / session_id，见 `message.ts` 顶部的名字表）⇒
   * 名字必须从派发帧回填，否则活动行上会出现「已派发子任务：X」紧跟一句无名的「子任务已完成」。
   */
  it('收场帧按真机形状（无 `description`）：名字从派发帧回填，摘要带得上名', () => {
    const state = newState();
    projectClaudeMessage(TASK_STARTED, state, CONTEXT);
    const done = projectClaudeMessage({ ...TASK_DONE, description: undefined }, state, CONTEXT);
    expect(done.drafts[0]).toMatchObject({ summary: `子任务已完成：${TASK_STARTED.description}` });

    // 证据里也带上回填到的那一份（日志只剩 subagentId 的话，按 id 反查名字要另一张表）
    const payload = JSON.parse((done.drafts[0] as { text: string }).text);
    expect(payload.name).toBe(TASK_STARTED.description);
  });

  it('派发帧没到过（只见到收场帧）⇒ 仍然无名，不编一个', () => {
    resetClaudeTaskNamesForTesting();
    const done = projectClaudeMessage({ ...TASK_DONE, description: undefined }, newState(), CONTEXT);
    expect(done.drafts[0]).toMatchObject({ summary: '子任务已完成' });
  });

  it('task_notification ⇒ 结束事件带**真实终态**与结果摘要（不是猜的）', () => {
    const state = newState();
    projectClaudeMessage(TASK_STARTED, state, CONTEXT);
    const projection = projectClaudeMessage(TASK_DONE, state, CONTEXT);

    const payload = JSON.parse((projection.drafts[0] as { text: string }).text);
    expect(payload.phase).toBe('end');
    expect(payload.subagentId).toBe('ac9fca27ed014a4ea');
    // spec §6：status 是真实终态 ⇒ **claude 侧用不到 statusMissing**（只有 codex 要用）
    expect(payload.status).toBe('completed');
    expect(payload.statusMissing).toBeUndefined();
    expect(payload.outcome).toContain('3 lines');
    expect(payload.usage).toEqual({ totalTokens: 19901, toolUses: 2, durationMs: 14496 });
  });

  it('stopped / failed 原样映射（不把非正常收场伪装成 completed）', () => {
    for (const status of ['stopped', 'failed']) {
      const projection = projectClaudeMessage(
        { ...TASK_DONE, uuid: `u-${status}`, status },
        newState(),
        CONTEXT,
      );
      const payload = JSON.parse((projection.drafts[0] as { text: string }).text);
      expect(payload.status).toBe(status);
    }
  });

  /**
   * 缺 `task_id` 时的口径：**照发事件，但身份写 `null`**（不编一个 id、也不把整条丢掉）。
   *
   * 为什么不是"丢掉不投影"（我第一版就是那样）：那样会把**"派了一个子任务"这件事实**
   * 一起丢掉，而它恰好是派发面板要显示的东西。为什么不是"编一个 id"：编出来的 id
   * 会让下游的配对**静默错位**（§4「缺就是缺」）。所以取第三条：**发事件、身份为 null**，
   * 让下游**显式**看到"这一条没有身份可用"，配对不上时是**响的**而不是错的。
   *
   * 真机实测（两次运行）`task_id` 都非空 ⇒ 这条防御路径在生产上大概率不可达；
   * 它保的是平台/版本差异。
   */
  it('task_started 缺 task_id ⇒ 仍发事件，但 subagentId / vendorId 都为 null（不编 id、也不丢事实）', () => {
    // 必须**真的删掉**这个键：`{...obj, task_id: undefined}` 覆盖不掉一个已存在的字符串键
    // （我第一版就是这么写的，用例因此假绿——`readString` 仍读到原值）
    const { task_id: _omitted, ...withoutTaskId } = TASK_STARTED;
    const projection = projectClaudeMessage({ ...withoutTaskId, uuid: 'u-bad' }, newState(), CONTEXT);

    expect(projection.drafts[0]?.type).toBe('log');
    const payload = JSON.parse((projection.drafts[0] as { text: string }).text);
    expect(payload.kind).toBe('subagent');
    expect(payload.phase).toBe('start');
    expect(payload.subagentId).toBeNull();
    expect(payload.vendorId).toBeNull();
    // 归属键与任务名仍要带上：它们能独立成立，不依赖 id
    expect(payload.parentToolUseId).toBe('call_e086fd6fde2f4f1ab029fce9');
    expect(payload.name).toBe('Count lines in notes.txt');
  });

  /**
   * **为什么没有 `state.subagentIds`**（我一开始写错了，改掉）：
   * v1 的 `AgentEvent` 里**没有消息级 `subagentId` 这一格**，`TurnProjection` 也没有承载它的字段
   * ⇒ 在 `TurnState` 里加一个谁都读不到的 Set 就是**死状态**。
   * 子任务的索引信息**就在这两条日志的载荷里**（`subagentId` / `parentToolUseId`），
   * 消费方按 `kind === 'subagent'` 过滤即可重建，不需要骨架替它维护一份镜像。
   * spec §6 的 `message.subagentId` 是 **v2 契约**的事，等那一层落地时再从这里取。
   */
  it('两条日志自成索引：start 与 end 用同一个 subagentId，可配对', () => {
    const state = newState();
    const start = projectClaudeMessage(TASK_STARTED, state, CONTEXT);
    const end = projectClaudeMessage(TASK_DONE, state, CONTEXT);

    const startPayload = JSON.parse((start.drafts[0] as { text: string }).text);
    const endPayload = JSON.parse((end.drafts[0] as { text: string }).text);
    expect(startPayload.subagentId).toBe(endPayload.subagentId);
    // 归属键只在 start 上有（end 的 tool_use_id 同值，但下游配对靠 subagentId 就够）
    expect(endPayload.parentToolUseId).toBe('call_e086fd6fde2f4f1ab029fce9');
  });
});

/**
 * **厂商系统层事实的归一**（2026-10-04 收口）。
 *
 * 这一节补的缺口：`system/init` 行过去只以**原始 JSON** 落成一条 `log`，于是「这一行被下发了
 * 哪些工具 / 什么权限档」这件事在界面侧只能由**浏览器**去 `JSON.parse` 那条日志、并逐字认
 * `subtype === 'init'` / `slash_commands` / `permissionMode` —— 那是把厂商形状的解析搬到了
 * 消费端（`build-environment.ts`），也正是「转换逻辑只准住在 agents 里」这条边界要拦的东西。
 *
 * 两条口径：
 *   ① 归一事件与**原始负载那条 log 并存**——原文是排障证据，归一不替代它；
 *   ② 缺哪一格就记 `null`，**不编空数组**（`[]` 是「采到了，确实是空的」，与「没投送」相反）。
 */
describe('projectClaudeMessage：system/init 归一成厂商系统层事件', () => {
  const INIT = {
    type: 'system',
    subtype: 'init',
    uuid: 's-init',
    cwd: 'D:/tmp/row-1/workspace',
    tools: ['Task', 'Bash', 'Read', 'Write'],
    slash_commands: ['design', 'verify'],
    agents: ['claude', 'Explore'],
    mcp_servers: [],
    permissionMode: 'bypassPermissions',
    output_style: 'default',
    claude_code_version: '2.0.1',
  };

  it('init 行交出归一后的 vendor-system，同时保留原始负载那条 log', () => {
    const projection = projectClaudeMessage(INIT, newState(), CONTEXT);

    expect(projection.drafts.find((draft) => draft.type === 'vendor-system')).toEqual({
      type: 'vendor-system',
      tools: ['Task', 'Bash', 'Read', 'Write'],
      slashCommands: ['design', 'verify'],
      agents: ['claude', 'Explore'],
      mcpServers: [],
      permissionMode: 'bypassPermissions',
      outputStyle: 'default',
    });
    // 原文必须还在：归一之后的形状答不了「厂商当时到底发了什么」
    expect(
      projection.drafts.some((draft) => draft.type === 'log' && draft.text.includes('"subtype":"init"')),
    ).toBe(true);
  });

  it('缺的格子记 null（不编空数组）：`[]` 是「采到了，确实是空的」', () => {
    const { tools: _omitted, ...withoutTools } = INIT;
    const projection = projectClaudeMessage({ ...withoutTools, uuid: 's-init-2' }, newState(), CONTEXT);

    expect(projection.drafts.find((draft) => draft.type === 'vendor-system')).toEqual({
      type: 'vendor-system',
      tools: null,
      slashCommands: ['design', 'verify'],
      agents: ['claude', 'Explore'],
      mcpServers: [],
      permissionMode: 'bypassPermissions',
      outputStyle: 'default',
    });
  });

  it('不是 init 的 system 行照旧只落原始负载（子智能体那两条仍走各自的分支）', () => {
    const projection = projectClaudeMessage(
      { type: 'system', subtype: 'hook_started', uuid: 's-hook' },
      newState(),
      CONTEXT,
    );

    expect(projection.drafts.some((draft) => draft.type === 'vendor-system')).toBe(false);
    expect(projection.drafts[0]?.type).toBe('log');
  });
});
