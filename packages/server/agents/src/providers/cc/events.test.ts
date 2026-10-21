// @vitest-environment node
/**
 * cc 的消息投影：计量三项齐全才有值、缺项 → null + WARN、重复丢弃、未识别保留。
 * 这里的两条断言（未识别不丢失 / 缺失得 null）是核心守卫，必须逐字验。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { TurnState } from '../../turn';
import { projectClaudeMessage, skillsFromInitFrame } from './events';
import { resetClaudeTaskNamesForTesting } from './message';

/**
 * 子任务名字表是**模块级**的（收场帧没有 `description`，名字只能在派发帧记下，见 `message.ts` 顶部）：
 * 生产上 `task_id` 每轮都是新 UUID、不会串，但**用例之间会串** ⇒ 每条用例前清一次，
 * 判据才只取决于本用例喂进去的消息。
 */
beforeEach(() => {
  resetClaudeTaskNamesForTesting();
});

const CONTEXT = { kind: 'cc', baseUrl: 'https://gw.example.com/anthropic' } as const;

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
   * 终态轮次的口径：**以我们数出来的为准**（跑动期界面看的就是它，两边必须同源），
   * `num_turns` 只在一次都没数到时兜底；两者不一致要落 WARN——「厂商报 60、我们数出 58」这种事
   * 绝不静默。下面各条分别钉这几件事。
   */
  it('我们自己数到的轮次优先于 num_turns；厂商**少报**时落一条 WARN', () => {
    const state = newState();
    // 先喂三条不同 id 的 assistant（数到 3 次往返），再给一条自报 1 的 result
    for (const id of ['m1', 'm2', 'm3']) {
      projectClaudeMessage(
        { type: 'assistant', uuid: `a-${id}`, message: { id, content: [{ type: 'text', text: '改好了' }] } },
        state,
        CONTEXT,
      );
    }
    const projection = projectClaudeMessage(
      // `result_index: 0` = 厂商明说「这是第一条 result」⇒ 只有这一条才做刻度核对（见下一条用例）
      { type: 'result', subtype: 'success', uuid: 'r-mismatch', result: '完成', num_turns: 1, result_index: 0 },
      state,
      CONTEXT,
    );

    expect(projection.turns).toBe(3);
    const warn = projection.drafts.find(
      (draft) => draft.type === 'log' && draft.stream === 'stderr' && draft.text.includes('num_turns'),
    );
    expect(warn?.type === 'log' ? warn.text : '').toContain('num_turns=1');
    expect(warn?.type === 'log' ? warn.text : '').toContain('步数=3');
  });

  /**
   * **厂商多报也要喊，但文案要说清"也可能是我们少算"**。
   *
   * 上一版按方向静默了多报（理由：多报的已知成因是厂商把同一次往返的多次投递按多次计）。
   * 那条理由**不成立**：多报这一档里混着第二种成因——本层按 `message.id` 去重，**两条不同往返
   * 撞同一个 id 时只算一轮**（网关/代理复用 id 属真实可能），那时 `turns` 偏小、厂商才是对的。
   * 两种成因从读数上分不开 ⇒ 这一档必须说话，让人去查上游是否复用 id。
   */
  it('厂商**多报**落 WARN，且文案点名「也可能是我们按 id 去重少算」', () => {
    const state = newState();
    projectClaudeMessage(
      { type: 'assistant', uuid: 'a1', message: { id: 'm1', content: [{ type: 'text', text: '改好了' }] } },
      state,
      CONTEXT,
    );
    const projection = projectClaudeMessage(
      { type: 'result', subtype: 'success', uuid: 'r-over', result: '完成', num_turns: 3, result_index: 0 },
      state,
      CONTEXT,
    );
    expect(projection.turns).toBe(1);
    const warn = projection.drafts.find(
      (draft) => draft.type === 'log' && draft.stream === 'stderr' && draft.text.includes('num_turns'),
    );
    expect(warn?.type === 'log' ? warn.text : '').toContain('num_turns=3');
    expect(warn?.type === 'log' ? warn.text : '').toContain('也可能是我们少算');
    expect(warn?.type === 'log' ? warn.text : '').toContain('message.id');
  });

  /**
   * `result_index` **缺席**的那一档：整条刻度核对不发。
   *
   * 为什么不许退回「按 0 处置」：老生产方没有这一格、in-process 那一面「does not number yet」
   * ⇒ 按 0 就等于把**每一条** `result` 都当第一条，第 2 轮起「本轮往返数」与「整条查询累计」
   * 两种刻度一比就**假报**；另一头（第一条的编号因写入失败被消费掉）还会让核对**永远不跑**。
   * 少一条提示日志、换掉两种失灵，判据就是下面两行。
   */
  it('result_index 缺席 ⇒ 不发刻度核对（不按 0 冒充第一条）', () => {
    const state = newState();
    projectClaudeMessage(
      { type: 'assistant', uuid: 'a3', message: { id: 'm1', content: [{ type: 'text', text: '改好了' }] } },
      state,
      CONTEXT,
    );
    const projection = projectClaudeMessage(
      { type: 'result', subtype: 'success', uuid: 'r-noindex', result: '完成', num_turns: 9 },
      state,
      CONTEXT,
    );

    // 轮次仍以数出来的为准（核对只是提示，读数口径不受它影响）
    expect(projection.turns).toBe(1);
    expect(projection.drafts.some((draft) => draft.type === 'log' && draft.text.includes('num_turns'))).toBe(false);
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

  it('usage 缺一项 → tokens null，并落一条保留原始负载的 WARN', () => {
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
 * 跑动期的实时用量估算（用户口径：cc 也要在跑动期就看到 tok/轮次）。
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

    // 轮次在这一条上就涨（**不等 token**）：发射门槛是轮次，不是「轮次与 token 同时在」
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

    // 这一格一旦变成 false，估算就会流进结果、进而落进快照 —— 崩溃/被杀的候选会看起来像「采到了计量」
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
   * **全 0 的估算快照 = 「这一条还没填好」，不是「采到了 0」**。
   *
   * 实测那一轮（`12eff3a1` 的 cc 行，`likecode` 网关 + `jd/GLM-5.3`）：17 条 assistant
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

  /**
   * **估算表只在「真读到权威值」时才清**（结算与否看的是那一格有没有数，不是这一帧是不是 `result`）。
   *
   * 为什么这一条承重：`result.usage` 缺项那一档虽然罕见（代码自己为它写了 WARN），但无条件清
   * 会把「还没结算那一轮」的估算也丢掉、又没有任何权威值顶上来 ⇒ 下一条 usage 事件的读数
   * **比上一条小**，而「候选到目前为止的累计、单调不减」是这条通道自己声明的口径。
   * 两个方向都钉：有权威值 ⇒ 清；缺项 ⇒ 留着那笔账（下一轮继续算）。
   */
  it('result 的 usage 缺项 ⇒ 不清估算表（结了零个字节就不算结算）', () => {
    const state = newState();
    projectClaudeMessage(assistantMessage({ uuid: 'u-est', messageId: 'm-est', usage: TRIO }), state, CONTEXT);
    expect(state.usageByMessageId.size).toBe(1);

    // 缺 `cache_read_input_tokens`：三项不齐 ⇒ 权威值没到手
    const partial = projectClaudeMessage(
      { type: 'result', subtype: 'success', uuid: 'r-partial', result: '完成', usage: { input_tokens: 5, output_tokens: 1 } },
      state,
      CONTEXT,
    );
    expect(partial.tokens).toBeNull();
    expect(state.usageByMessageId.size, '缺项那一帧不许把还没结算的估算丢掉').toBe(1);

    // 权威值齐了 ⇒ 清（这才是「这一轮已结算」）
    projectClaudeMessage(
      { type: 'result', subtype: 'success', uuid: 'r-full', result: '完成', usage: TRIO },
      state,
      CONTEXT,
    );
    expect(state.usageByMessageId.size).toBe(0);
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
   * 归属：claude 的读数只由**主循环**消息触发（侧链 `parent_tool_use_id`
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
    // 归属格写**显式 `null`**：投影层与草稿层同一种形状
    //（`AgentEventDraft` 那一格恒在，没有归属就是 `null`），读的人不必去问「缺省与 null 在这里有没有别」。
    expect(side.turns).toBeNull();
    expect(side.turn).toBeNull();
  });

  /**
   * 收尾读数的归属：`result` 是**主循环**的收尾那条 ⇒ 它的**每一个**返回点
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
   * 归属里的轮次必须是**刚数出来的那个数**，不是一个长得像的常量。
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
   * **「还在动」的两个心跳必须交出事件**：`tool_progress`（长工具的执行进度，字段照 SDK 的
   * `SDKToolProgressMessage`）与 `system/api_retry`（上游可重试失败后的退避重试，字段照
   * `SDKAPIRetryMessage`）。骨架的看门狗把「这一条投影有没有交出东西」当静止判据
   *（`turn.ts` 的 `projectionHasOutput`），而这两类都不在识别名单里 ⇒ 它们**必须**走未识别兜底、
   * 各交出一条 log。一旦被当成「没内容的噪声」丢掉，正在重试或正在跑长工具的候选就会被判成静止超时。
   */
  it('tool_progress 与 system/api_retry 各交出一条保留原始负载的日志（它们是「还在动」的心跳）', () => {
    const progress = {
      type: 'tool_progress',
      tool_use_id: 'toolu_1',
      tool_name: 'Bash',
      parent_tool_use_id: null,
      elapsed_time_seconds: 42,
      uuid: 'progress-1',
      session_id: 'session-1',
      heartbeat: true,
    };
    const retry = {
      type: 'system',
      subtype: 'api_retry',
      attempt: 3,
      max_retries: 5,
      retry_delay_ms: 4_000,
      error_status: 529,
      error: 'overloaded',
      uuid: 'retry-1',
      session_id: 'session-1',
    };
    const state = newState();
    const first = projectClaudeMessage(progress, state, CONTEXT);
    const second = projectClaudeMessage(retry, state, CONTEXT);
    expect(first.drafts).toHaveLength(1);
    expect(second.drafts).toHaveLength(1);
    // 保留原始负载（与上面那条未识别 type 同一口径）：读的人要能从原文认出是哪一类心跳
    expect(JSON.parse(first.drafts[0]?.type === 'log' ? first.drafts[0].text : '')).toEqual(progress);
    expect(JSON.parse(second.drafts[0]?.type === 'log' ? second.drafts[0].text : '')).toEqual(retry);
  });

  /**
   * stream_event **不进原始日志**（用户口径，真机形状照抄）：
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
   * `system/thinking_tokens`（**思考进度帧**）同样不进原始日志（第二个通道）。
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

  it('assistant 的文本块与工具块都落盘（工具调用是候选为的一部分）', () => {
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
   * 工具块那一条的**人话摘要**（用户口径）：卡片底部的活动行显示 `summary`，
   * 而 `[{"type":"tool_use",…}]` 那种几百字符的 JSON 不是消息。原始负载仍逐字在 `text` 里。
   *
   * **带参数**：只给工具名（`调用工具 Bash`）时，同一行原始负载里 `input.command` 明明写着
   * `ls -la "D:/w"` —— 那句摘要比它替换掉的人话信息量更低（活动行反而更差）。
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

  it('空文本块不落成空日志：有别的块时只落别的块', () => {
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
   * 口径：**成功返回不播、报错必须播**——活动行回答「在做什么」，
   * 而「这个候选出事了」没有别的候选级出口。原始负载两种情形都照旧逐字落盘。
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
 * 最终答复出口：评分智能体要从结果里读到「模型最后说了什么」，
 * 而不是从 `log` 事件流里重建——重建三家形状各不相同，不可靠。
 * cc 的收尾消息是 `result`，故答复只在它上面采；中间轮次的 assistant 文本不算答复。
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

describe('projectClaudeMessage：形状异常与空文案', () => {
  it('usage 根本不是对象（形状异常）→ tokens null 且仍落一条带原始负载的 WARN（不得静默）', () => {
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
 * 结构化输出的最终答复出口（评分通路的结构化产出）。
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
    // 判据必须**点名**那条不一致 WARN：本 fixture 没有 `usage`，而 `readTokens`
    // 在三元组不齐时**无条件**落一条「用量负载不完整…」WARN ⇒ 原来那句 `includes('[WARN]')` 与「两源不
    // 一致」无关地**恒真**。实测形状：把 events.ts 里那条不一致 WARN 整段删掉，本文件 31 条**全绿** ——
    // 也就是说「两个来源不一致要落 WARN」这条要求在仓里当时没有任何会红的用例（plan-mandated 假守卫）。
    expect(
      projection.drafts.some(
        (draft) => draft.type === 'log' && draft.text.includes('structured_output 与 result 文本不一致'),
      ),
    ).toBe(true);
  });

  it('两个来源同时存在且内容**一致** ⇒ 不落那条不一致 WARN（否证）', () => {
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
   * 出厂形状的**四态**（空串那一格也在内）。
   * `structured_output?: unknown` 什么都没承诺，下面三条把「没验证过的输入假设」两侧都封住：
   * 显式 `null` 与空串 `''` 都与「字段缺失」同义（没有**可用的**结构化产出），已序列化的 JSON
   * 字符串按 JSON 文本原样用（不二次编码）。真机只需要确认走的是哪一支。
   */
  it('structured_output 是显式 null ⇒ 按「没有结构化产出」处理：落到 result 文本，且不落不一致 WARN', () => {
    const state = newState();
    const raw = { type: 'result', result: '{"verdict":"还行"}', structured_output: null };
    const projection = projectClaudeMessage(raw, state, CONTEXT);

    // 修好之前这里会是字符串 'null'（`safeStringify(null)`）⇒ 每一条非 schema 候选的答复都被静默顶掉
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
    // schema 约束下的每个候选都会失败在「顶层不是对象」。逐字相等就是这条的判据。
    expect(state.finalText).toBe('{"verdict":"还行"}');
  });
});

/**
 * 结构化输出重试用尽的归因。
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
 * **`assistant` 帧自带的 `error` / `aborted` 两格**（厂商在合成的 API-error 消息上写它们）。
 *
 * 为什么这一组守卫承重：这两格过去**一格都不读** ⇒ 一次 401 / 429 只在 assistant 帧上报错、
 * 没走到 `result` 的运行，在事件流里与一条普通答复**逐字相同**，整候选被记成成功。
 * 而分档是另一半判据：`api_retry` 用的是**同一个**错误枚举（`sdk.d.ts` 的
 * `SDKAPIRetryMessage.error`）⇒ 可重试档一律判失败会把「厂商自己重试成功」的行判死，
 * 而骨架的 `failure` 一旦写入就再也清不掉（`turn.ts` 的消费循环是最后写入者赢）。
 */
describe('projectClaudeMessage：assistant 帧的上游错误与截断', () => {
  /** 一条带 `error` 的合成 API-error 消息（真机形状：正文为空、错误在信封上） */
  function errorFrame(error: string, uuid: string): Record<string, unknown> {
    return {
      type: 'assistant',
      uuid,
      session_id: 's1',
      parent_tool_use_id: null,
      error,
      message: { id: `msg_${uuid}`, role: 'assistant', content: [] },
    };
  }

  /** 取这一条投影里所有 stderr 日志的正文（WARN 的落点） */
  function stderrTexts(projection: ReturnType<typeof projectClaudeMessage>): string[] {
    return projection.drafts.flatMap((draft) =>
      draft.type === 'log' && draft.stream === 'stderr' ? [draft.text] : [],
    );
  }

  it('终局错误（authentication_failed）⇒ 归成 AUTH_FAILED，不是 AGENT_FAILED', () => {
    const projection = projectClaudeMessage(errorFrame('authentication_failed', 'e1'), newState(), CONTEXT);

    // 归因走 errors.ts 的那份映射（这里再抄一遍必然漂）：密钥不对就该落 AUTH_FAILED
    expect(projection.failure?.code).toBe('AUTH_FAILED');
    // 点名厂商原值：排障时搜的就是它
    expect(stderrTexts(projection).join('\n')).toContain('authentication_failed');
  });

  it('model_not_found / invalid_request / billing_error 都是终局档（重试不会变好）', () => {
    for (const [index, error] of ['model_not_found', 'invalid_request', 'billing_error'].entries()) {
      const projection = projectClaudeMessage(errorFrame(error, `t${index}`), newState(), CONTEXT);
      expect(projection.failure, error).not.toBeNull();
    }
  });

  /**
   * 这一条是分档的**反向判据**：可重试档只留痕、不判失败。
   * 没有它，一次 `overloaded`（厂商退避重试后成功）会让整行永远判失败。
   */
  it('可重试档（overloaded / rate_limit / server_error）只落 WARN，不判失败', () => {
    for (const [index, error] of ['overloaded', 'rate_limit', 'server_error'].entries()) {
      const projection = projectClaudeMessage(errorFrame(error, `r${index}`), newState(), CONTEXT);

      expect(projection.failure, error).toBeNull();
      // 但必须留痕：静默丢掉等于让「上游抖过一次」这件事从证据里消失
      expect(stderrTexts(projection).join('\n'), error).toContain(error);
    }
  });

  /** `max_output_tokens` 另有自愈通道（`resumed_from_incomplete_thinking`）⇒ 同属可重试档 */
  it('max_output_tokens 不判失败（下一轮接着上一轮的思考块跑完）', () => {
    const projection = projectClaudeMessage(errorFrame('max_output_tokens', 'm1'), newState(), CONTEXT);

    expect(projection.failure).toBeNull();
  });

  it('aborted ⇒ 落一条「正文可能断在词中间」的 WARN，但不判失败（终止由骨架的 canceled 通路定）', () => {
    const projection = projectClaudeMessage(
      {
        type: 'assistant',
        uuid: 'a1',
        parent_tool_use_id: null,
        aborted: true,
        message: { id: 'msg_a1', role: 'assistant', content: [{ type: 'text', text: '写到一半就被' }] },
      },
      newState(),
      CONTEXT,
    );

    expect(projection.failure).toBeNull();
    expect(stderrTexts(projection).join('\n')).toContain('截断');
    // 正文照旧交出去（截断的半句仍是证据，只是旁边多一句提醒）
    expect(projection.drafts.some((draft) => draft.type === 'log' && draft.text.includes('写到一半就被'))).toBe(true);
  });

  it('没有这两格的普通 assistant 帧：一条 WARN 都不多（其余档位逐字不变）', () => {
    const projection = projectClaudeMessage(
      {
        type: 'assistant',
        uuid: 'ok1',
        parent_tool_use_id: null,
        message: { id: 'msg_ok1', role: 'assistant', content: [{ type: 'text', text: '正常答复' }] },
      },
      newState(),
      CONTEXT,
    );

    expect(projection.failure).toBeNull();
    expect(stderrTexts(projection)).toEqual([]);
  });

  /** 轮次与用量估算照旧：错误帧也是一次真实的模型往返（少数一轮会让后面每一轮都差一） */
  it('错误帧照样计一次模型往返', () => {
    const projection = projectClaudeMessage(errorFrame('overloaded', 'c1'), newState(), CONTEXT);

    expect(projection.turns).toBe(1);
  });
});

/**
 * 子智能体生命周期：claude 侧走 SDK **原生 `system/task_*` 消息**。
 *
 * 为什么这些守卫值得存在：`system` 类型过去**一律**落成 `unknownEventDraft`
 * （`events.ts` 的兜底分支），于是子智能体的派生与收场**只在原始 JSON 里躺着**、
 * 界面上完全不可见。这些消息（CLI 2.1.281）**默认就发**，不需要任何 SDK 选项。
 *
 * 载荷逐字取自真机，不是编的形状。
 */
describe('projectClaudeMessage：子智能体生命周期', () => {
  /** 真机 task_started ① */
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

  /** 真机 task_notification ② */
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
    // 厂商原生 id ⇒ vendorId 与 subagentId 同值（claude **不需要合成 id**）
    expect(payload.vendorId).toBe('ac9fca27ed014a4ea');
    // 归属键：**这就是「用 parent_tool_use_id 划分归属」的那座桥**（三者相同）
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
    // status 是真实终态 ⇒ **claude 侧用不到 statusMissing**（只有 codex 要用）
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
   * 会让下游的配对**静默错位**（「缺就是缺」）。所以取第三条：**发事件、身份为 null**，
   * 让下游**显式**看到"这一条没有身份可用"，配对不上时是**响的**而不是错的。
   *
   * 观测到的 `task_id` 都非空 ⇒ 这条防御路径在生产上大概率不可达；
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
   * `message.subagentId` 是 **v2 契约**的事，等那一层落地时再从这里取。
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
 * **厂商系统层事实的归一**。
 *
 * 这一节补的缺口：`system/init` 行过去只以**原始 JSON** 落成一条 `log`，于是「这个候选被下发了
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
    /**
     * 真机形状（run `7f05c765` 的候选 `057d00fb` 逐字，四台全给——回放这份样本就是
     * 「真机上 claude 的 `mcp_servers` 不再被折成 `[]`」那条验收的证据）：
     * `mcp_servers` 是**对象数组** `{name, status, source}`，不是字符串数组。
     */
    mcp_servers: [
      { name: 'context7', status: 'pending', source: 'project' },
      { name: 'playwright', status: 'pending', source: 'project' },
      { name: 'find', status: 'connected', source: 'project' },
      { name: 'japi', status: 'pending', source: 'project' },
    ],
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
      // 对象数组**逐格保留**：旧实现只留字符串项，把这四台折成了 `[]`
      //（而 `[]` 在本仓是「投送了，确实是空的」——真机四台 MCP 于是从事件流里彻底消失）
      mcpServers: [
        { name: 'context7', status: 'pending', source: 'project', error: null },
        { name: 'playwright', status: 'pending', source: 'project', error: null },
        { name: 'find', status: 'connected', source: 'project', error: null },
        { name: 'japi', status: 'pending', source: 'project', error: null },
      ],
      // 通道自报：claude 的判据来源是 `system/init` 里那一台的 `status`
      mcpChannel: 'vendor-status',
      permissionMode: 'bypassPermissions',
      outputStyle: 'default',
      // 技能面只在流循环里采一次（`getContextUsage`），init 这一条还没有它 ⇒ **不带这一格**
      //（不是 `null`：`null` 会被读侧读成「厂商投送了、清单是空的」）
      // 技能那一格缺席在这一条上（`.toEqual` 按「键不存在」比，故这里不写它）
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
      mcpServers: [
        { name: 'context7', status: 'pending', source: 'project', error: null },
        { name: 'playwright', status: 'pending', source: 'project', error: null },
        { name: 'find', status: 'connected', source: 'project', error: null },
        { name: 'japi', status: 'pending', source: 'project', error: null },
      ],
      // 通道自报：claude 的判据来源是 `system/init` 里那一台的 `status`
      mcpChannel: 'vendor-status',
      permissionMode: 'bypassPermissions',
      outputStyle: 'default',
      // 同一条口径：技能面还没采 ⇒ 这一条不带那一格（见上面那条用例）
    });
  });

  /**
   * **厂商原文那一格**：`status: 'failed'` 的条目带 `error` 时逐字留下来——
   * 候选失败文案 `MCP「<name>」未能启动：<厂商原文首行>` 的后半句只能从这里来。
   */
  it('`mcp_servers[].error` 逐字保留（归一不会把它吃掉），没有这一格时记 `null`', () => {
    const projection = projectClaudeMessage(
      {
        ...INIT,
        uuid: 's-init-error',
        mcp_servers: [
          { name: 'probe', status: 'failed', error: 'MCP server "probe" failed to connect: spawn ENOENT\n第二行细节' },
          { name: 'find', status: 'connected' },
        ],
      },
      newState(),
      CONTEXT,
    );

    expect(projection.drafts.find((draft) => draft.type === 'vendor-system')).toMatchObject({
      mcpServers: [
        {
          name: 'probe',
          status: 'failed',
          source: null,
          error: 'MCP server "probe" failed to connect: spawn ENOENT\n第二行细节',
        },
        // 厂商这一格没给 ⇒ `null`（不是空串，也不是「没有失败」）
        { name: 'find', status: 'connected', source: null, error: null },
      ],
    });
  });

  /**
   * `mcp_servers` 那一格的三态：
   *   · 整格不在 / 不是数组 ⇒ `null`（厂商没投送）——**不编 `[]`**；
   *   · `[]` ⇒ `[]`（投送了，确实是空的）；
   *   · 对象项里缺的格 ⇒ 该格 `null`（厂商没给那一格，不是空串）。
   */
  it('`mcp_servers` 三态分开：缺格/非数组记 null、空数组记 []、对象里缺的格记 null', () => {
    const of = (mcpServers: unknown, uuid: string): unknown => {
      const { mcp_servers: _dropped, ...rest } = INIT;
      const projection = projectClaudeMessage({ ...rest, mcp_servers: mcpServers, uuid }, newState(), CONTEXT);
      return projection.drafts.find((draft) => draft.type === 'vendor-system');
    };

    expect(of(undefined, 'm-1')).toMatchObject({ mcpServers: null });
    expect(of('context7', 'm-2')).toMatchObject({ mcpServers: null });
    expect(of([], 'm-3')).toMatchObject({ mcpServers: [] });
    // 只有名字的那一项（老形态）也读得动：名字是它真给了的，另两格真没给 ⇒ null
    expect(of([{ name: 'japi' }], 'm-4')).toMatchObject({
      mcpServers: [{ name: 'japi', status: null, source: null }],
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

/**
 * **历史重放帧**（`SDKUserMessageReplay.isReplay`）：续接（`resume`）时 CLI 把这条会话
 * **已经发生过**的用户侧消息再投一遍。
 *
 * 为什么这一条守卫承重：重放帧带的是**自己的** `uuid`（与原帧不同）⇒ 既有那张去重表挡不住它；
 * 而追问是**追加到同一行**上的（工作区与产物都不重置）⇒ 收下就是把上一轮的工具结果连同证据
 * 再写一遍。症状不是报错，而是「追问之后抽屉里多出一份上一轮的记录」。
 */
describe('projectClaudeMessage：续接时的历史重放帧', () => {
  /** 一条被重放的工具结果（真机形状：与原帧几乎相同，只多 `isReplay` 且 `uuid` 是新的） */
  const REPLAYED = {
    type: 'user',
    uuid: 'replay-1',
    session_id: 's1',
    isReplay: true,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_old', content: '上一轮的工具结果' }] },
  };

  it('重放帧零事件产出（不把上一轮的证据再写一遍）', () => {
    expect(projectClaudeMessage(REPLAYED, newState(), CONTEXT).drafts).toEqual([]);
  });

  it('重放的**报错**工具结果同样不产出（否则上一轮的失败会在候选再播一次）', () => {
    const projection = projectClaudeMessage(
      {
        ...REPLAYED,
        uuid: 'replay-2',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_old', content: '炸了', is_error: true }] },
      },
      newState(),
      CONTEXT,
    );

    expect(projection.drafts).toEqual([]);
  });

  /** 反向判据：没有这一格的普通工具结果照旧落原始负载（修正不许把正常路径一起吞掉） */
  it('不带 isReplay 的同形帧照旧落原始负载', () => {
    const { isReplay: _dropped, ...live } = REPLAYED;
    const projection = projectClaudeMessage({ ...live, uuid: 'live-1' }, newState(), CONTEXT);

    expect(projection.drafts).toHaveLength(1);
    expect(projection.drafts[0]?.type).toBe('log');
  });
});

/**
 * **工具调用被当场拒**（`system/permission_denied`）。
 *
 * 为什么必须有人话摘要：它是**评分档的常态**——那一段走 `dontAsk` + `permissionPrompts: 'none'`
 * （本进程没有批准面），厂商据此把该拒的当场拒掉并发这一帧。它又是「模型想写盘但被拒」的
 * **唯一候选级出口** ⇒ 只落原始 JSON 时活动行一个字都不说，排障只能逐笔翻原始负载。
 */
describe('projectClaudeMessage：工具调用被权限档当场拒', () => {
  function denied(extra: Record<string, unknown>): Record<string, unknown> {
    return {
      type: 'system',
      subtype: 'permission_denied',
      uuid: `pd-${JSON.stringify(extra).length}`,
      session_id: 's1',
      tool_name: 'Write',
      tool_use_id: 'toolu_w1',
      message: 'Write is not allowed in read-only mode',
      ...extra,
    };
  }

  it('给一条带人话摘要的日志，原文在同一条的 text 里（不重复落第二遍）', () => {
    const projection = projectClaudeMessage(denied({ decision_reason: '只读档不允许写盘' }), newState(), CONTEXT);

    /**
     * **一条，不是两条**：摘要之外仍要留证，而这一条的 `text` 就是完整的原始负载
     * ⇒ 再落一条逐字相同的 `unknownEventDraft` 只是把同一坨 JSON 在抽屉里显示两遍。
     */
    const logs = projection.drafts.filter((draft) => draft.type === 'log');
    expect(logs).toHaveLength(1);
    const summary = logs[0];
    // 摘要点名工具与原因；`工具被拒` 与 `工具报错` 刻意是两句话（排障下一步不同）
    expect(summary?.type === 'log' ? summary.summary : '').toBe('工具被拒 Write：只读档不允许写盘');
    // 原始负载逐字在同一条 log 的 text 里（证据不少一个字）
    expect(summary?.type === 'log' ? summary.text : '').toContain('toolu_w1');
  });

  it('原因按信息量取第一个非空：decision_reason → message → decision_reason_type', () => {
    const viaMessage = projectClaudeMessage(denied({}), newState(), CONTEXT);
    expect(summaryOf(viaMessage)).toBe('工具被拒 Write：Write is not allowed in read-only mode');

    const viaType = projectClaudeMessage(
      denied({ message: '', decision_reason_type: 'mode' }),
      newState(),
      CONTEXT,
    );
    expect(summaryOf(viaType)).toBe('工具被拒 Write：mode');
  });

  it('三格原因都没有 ⇒ 只留前半句（不编原因、不留空冒号）', () => {
    const projection = projectClaudeMessage(denied({ message: '' }), newState(), CONTEXT);
    expect(summaryOf(projection)).toBe('工具被拒 Write');
  });

  /** **不判失败**：被拒一次不是这个候选失败了——模型会看到工具结果并换一条路 */
  it('不折成 failure（被拒不等于这个候选失败）', () => {
    expect(projectClaudeMessage(denied({}), newState(), CONTEXT).failure).toBeNull();
  });
});

/**
 * **非 Agent 的后台任务帧不许播「已派发子任务」**。
 *
 * 真机形态（CLI 2.1.281）：模型把一条 `sleep 5 && echo ok` 放进后台（`Bash` 的
 * `run_in_background: true`）时，CLI 发一条 `task_started`，其 `subagent_type` / `spawn_depth` /
 * `prompt` **三格全缺**、且**没有** `ambient` / `skip_transcript`（它不是「非活动」的 watcher，
 * 就是一条普通后台命令）。活动行显示的是这条日志的 `summary` ⇒ 不挡就会播
 * 「已派发子任务：sleep 5 && echo ok」，而面板与 `messages.jsonl` 那边按同一条判据一个候选都不产
 * （两个面互相打脸）。判据与消息侧同源（`isDispatchShaped`），收场帧按 id 追随。
 */
describe('projectClaudeMessage：非 Agent 的后台任务不占活动行', () => {
  /** 真机那一帧的逐字键集（只有 task_id / tool_use_id / description / is_backgrounded / task_type） */
  function backgroundBash(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      type: 'system',
      subtype: 'task_started',
      uuid: 'ts-bash',
      session_id: 's1',
      task_id: 'bwudyo91e',
      tool_use_id: 'toolu_bash_1',
      description: 'sleep 5 && echo ok',
      is_backgrounded: true,
      task_type: 'local_bash',
      ...extra,
    };
  }

  it('三格形状全缺的后台命令 ⇒ 不产 subagent 载荷，退回未识别兜底（证据一个字节不少）', () => {
    const state = newState();
    const start = projectClaudeMessage(backgroundBash(), state, CONTEXT);
    // 不产 `kind: 'subagent'`（活动行就是读它的 `summary`），退回落原始负载的那条兜底
    expect(start.drafts.some((draft) => draft.type === 'log' && draft.text.includes('"kind":"subagent"'))).toBe(false);
    expect(start.drafts.some((draft) => draft.type === 'log' && draft.text.includes('sleep 5 && echo ok'))).toBe(true);
    expect(summaryOf(start)).toBe('');

    // 收场帧按 id 追随（逐帧重判会把真派发的收场帧判成幻影）
    const end = projectClaudeMessage(
      { type: 'system', subtype: 'task_notification', uuid: 'tn-bash', session_id: 's1', task_id: 'bwudyo91e', status: 'completed', summary: 'Background command completed' },
      state,
      CONTEXT,
    );
    expect(end.drafts.some((draft) => draft.type === 'log' && draft.text.includes('"kind":"subagent"'))).toBe(false);
    expect(summaryOf(end)).toBe('');
  });

  /** **反向判据**：真派发照旧播那句话——判据不是恒假的（真机形状：`task_type` 也是 `local_agent`） */
  it('三格齐的真派发照旧产日志（判据不是恒假）', () => {
    const projection = projectClaudeMessage(
      backgroundBash({ task_id: 'real-agent-1', task_type: 'local_agent', subagent_type: 'general-purpose', spawn_depth: 1, prompt: '数一下行数' }),
      newState(),
      CONTEXT,
    );
    expect(projection.drafts).toHaveLength(1);
    expect(summaryOf(projection)).toContain('已派发子任务');
  });

  /**
   * **厂商显式说了是什么，就不再按形状猜**：`task_type` 与三格形状冲突时以 `task_type` 为准。
   *
   * 这一档在真机上不出现（厂商不会给后台 Bash 任务填 `subagent_type`），钉的是**优先级**：
   * 判据若反过来（形状压过显式字段），`Workflow` 那一档就会重新漏出去——它的 `prompt` 非空。
   */
  it('task_type 说不是派发时，三格齐也判幻影', () => {
    const projection = projectClaudeMessage(
      backgroundBash({ task_id: 'conflict-1', subagent_type: 'general-purpose', spawn_depth: 1, prompt: '算 1+1' }),
      newState(),
      CONTEXT,
    );
    expect(projection.drafts.some((draft) => draft.type === 'log' && draft.text.includes('"kind":"subagent"'))).toBe(false);
    expect(summaryOf(projection)).toBe('');
  });
});

/**
 * **`Workflow` 后台任务不许播「已派发子任务」**。
 *
 * 真机形态（CLI 2.1.301）：模型调用 `Workflow` 工具启动本地工作流时，CLI 发的 `task_started` 是
 * `task_type: 'local_workflow'`、`workflow_name: '<脚本 meta.name>'`，而 `subagent_type` 与
 * `spawn_depth` **都缺**、`prompt` **非空**（内容是**整份工作流脚本源码**）⇒ 只看三格形状会把它
 * 当成一次派发：活动行播「已派发子任务：<工作流描述>」，收尾再喊一句「读不到子智能体 <task_id>」
 * （它本来就没有子智能体转录）。厂商在这一格上直接给了答案，判据按它走。
 */
describe('projectClaudeMessage：Workflow 后台任务不占活动行', () => {
  /** 真机那一帧的逐字键集与取值（`deep-research` 工作流，只截断过长的 description / prompt） */
  function workflowStarted(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      type: 'system',
      subtype: 'task_started',
      uuid: 'ts-workflow',
      session_id: 's1',
      task_id: 'w6v9zbi71',
      run_id: '0mvb8c39o-02e33eef',
      tool_use_id: 'toolu_wf_1',
      description: 'Deep research harness — fan-out web searches, fetch sources',
      task_type: 'local_workflow',
      workflow_name: 'deep-research',
      prompt: 'export const meta = { name: \'deep-research\', description: \'Deep research harness\' }',
      ...extra,
    };
  }

  it('task_type=local_workflow ⇒ 不产 subagent 载荷，退回未识别兜底（证据一个字节不少）', () => {
    const state = newState();
    const start = projectClaudeMessage(workflowStarted(), state, CONTEXT);
    expect(start.drafts.some((draft) => draft.type === 'log' && draft.text.includes('"kind":"subagent"'))).toBe(false);
    // 原始帧照旧留证（未识别兜底那条）
    expect(start.drafts.some((draft) => draft.type === 'log' && draft.text.includes('local_workflow'))).toBe(true);
    expect(summaryOf(start)).toBe('');

    // 收场帧按 id 追随（`task_notification` 上不带 `task_type`，逐帧重判会把它当成真收场）
    const end = projectClaudeMessage(
      { type: 'system', subtype: 'task_notification', uuid: 'tn-wf', session_id: 's1', task_id: 'w6v9zbi71', status: 'completed', summary: 'workflow completed' },
      state,
      CONTEXT,
    );
    expect(end.drafts.some((draft) => draft.type === 'log' && draft.text.includes('"kind":"subagent"'))).toBe(false);
    expect(summaryOf(end)).toBe('');
  });

  /** **反向判据**：`local_agent` 即便三格全缺也照旧播——厂商说它是 agent 任务，不需要形状佐证 */
  it('task_type=local_agent 且三格全缺 ⇒ 照旧派发', () => {
    const projection = projectClaudeMessage(
      workflowStarted({ task_id: 'agent-no-shape', task_type: 'local_agent', workflow_name: undefined, prompt: undefined }),
      newState(),
      CONTEXT,
    );
    expect(summaryOf(projection)).toContain('已派发子任务');
  });

  /** **回落那一级照旧**：`task_type` 缺席时按形状判（`prompt` 非空 ⇒ 派发）——老生产方的形状不变 */
  it('task_type 缺席 ⇒ 回落形状判据', () => {
    const projection = projectClaudeMessage(
      workflowStarted({ task_id: 'legacy-1', task_type: undefined }),
      newState(),
      CONTEXT,
    );
    expect(summaryOf(projection)).toContain('已派发子任务');
  });

  /** **未知取值也回落形状**（不是白名单）：厂商将来新增一种真是派发的类型时不许把它判成幻影 */
  it('没见过的 task_type ⇒ 回落形状判据', () => {
    const projection = projectClaudeMessage(
      workflowStarted({ task_id: 'future-1', task_type: 'some_future_kind' }),
      newState(),
      CONTEXT,
    );
    expect(summaryOf(projection)).toContain('已派发子任务');
  });
});

/** 取这条投影里那条带摘要的日志的摘要正文 */
function summaryOf(projection: ReturnType<typeof projectClaudeMessage>): string {
  const draft = projection.drafts.find((one) => one.type === 'log' && one.summary !== undefined);
  return draft?.type === 'log' ? (draft.summary ?? '') : '';
}

/**
 * **厂商标了「这不是活动」的 task 帧**（`ambient` / `skip_transcript`）。
 *
 * 厂商 JSDoc 逐字 *"hosts should exclude them from activity indicators"*，而活动行正是那个
 * indicator ⇒ 给摘要就会把一条 live-update watcher 播成「已派发子任务」。
 */
describe('projectClaudeMessage：ambient 的 task 帧不占活动行', () => {
  function started(extra: Record<string, unknown>): Record<string, unknown> {
    return {
      type: 'system',
      subtype: 'task_started',
      uuid: `ts-${JSON.stringify(extra).length}`,
      session_id: 's1',
      task_id: 'task-amb',
      tool_use_id: 'toolu_a1',
      description: '看着文件变化',
      subagent_type: 'general-purpose',
      spawn_depth: 1,
      ...extra,
    };
  }

  for (const flag of ['ambient', 'skip_transcript'] as const) {
    it(`${flag} 为真 ⇒ 不给活动行摘要，但原始负载照发（证据不少一个字）`, () => {
      const projection = projectClaudeMessage(started({ [flag]: true }), newState(), CONTEXT);

      const draft = projection.drafts[0];
      expect(draft?.type).toBe('log');
      expect(draft?.type === 'log' ? draft.summary : 'x').toBeUndefined();
      // 载荷仍然是那条可解析的 subagent JSON
      expect(draft?.type === 'log' ? draft.text : '').toContain('"kind":"subagent"');
    });
  }

  /** 反向判据：没标这两格的真派发照旧播「已派发子任务」 */
  it('没有这两格的真派发照旧给活动行摘要', () => {
    const projection = projectClaudeMessage(started({}), newState(), CONTEXT);
    const draft = projection.drafts[0];
    expect(draft?.type === 'log' ? draft.summary : '').toContain('子任务');
  });
});

/**
 * **上游错误那一档的用量是「全 0 占位」，不是「采到了 0」**。
 *
 * 厂商 JSDoc 逐字：*Crash/startup-error results may carry zeroed values*。真机形状（上游 400）：
 * `subtype: 'success'` + `is_error: true`，而 `usage` 三项**齐全但全 0** ⇒ 按结构判据它「齐了」，
 * 按值判据它什么都没说。仓内硬口径是「计量绝不填 0」（`: 0` 会让人得出「这家很省」的错误结论），
 * 故按**没采到**处置，与估算路径里那条「全 0 的快照 = 这一条还没填好」同一条口径。
 */
describe('projectClaudeMessage：全 0 的结算值按「未采集」处理', () => {
  function upstreamErrorResult(usage: Record<string, unknown>): Record<string, unknown> {
    return {
      type: 'result',
      subtype: 'success',
      is_error: true,
      uuid: 'r-zero',
      session_id: 's1',
      num_turns: 1,
      result_index: 0,
      result: 'API Error: 400 probe 造的 400',
      usage,
    };
  }

  it('三项齐全但全 0 ⇒ 两格都是 `null`，且落一条点名「全 0」的 WARN', () => {
    const projection = projectClaudeMessage(
      upstreamErrorResult({ input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 }),
      newState(),
      CONTEXT,
    );
    expect(projection.tokens).toBeNull();
    const warn = projection.drafts.find((draft) => draft.type === 'log' && draft.stream === 'stderr');
    expect(warn?.type === 'log' ? warn.text : '').toContain('全 0');
  });

  /** 反向判据：只要有一项非 0 就照常采到（判据不是「凡上游错误一律 null」） */
  it('任意一项非 0 ⇒ 照常采到（判据不是恒 null）', () => {
    const projection = projectClaudeMessage(
      upstreamErrorResult({ input_tokens: 7, cache_read_input_tokens: 0, output_tokens: 0 }),
      newState(),
      CONTEXT,
    );
    expect(projection.tokens).toEqual({ input: 7, cached: 0, output: 0, reasoningOutput: null, total: null });
  });

  /**
   * **零值有两种，只有一种是异常**：`num_turns: 0` 的全 0 是「这次收尾本来就没有模型往返」
   * （真机：一次 `ok: true` 的嵌套派发运行里，中间那条 `result` 就是它），零是**事实**
   * ⇒ 仍判「没采到」（不许填 0 进计量），但**不该喊 WARN**（那不是要人看的异常）。
   */
  /**
   * **静默的只有「成功收尾 + `num_turns: 0`」那一档**（真机嵌套派发的收场帧就是它：`success` /
   * `is_error: false` / 全 0）。失败帧即便 `num_turns` 是 0 也要说话——崩溃与启动错误恰好是最可能
   * `num_turns: 0` 的一档，把它们一起静默掉就等于把这条 WARN 的靶子打掉。两条用例分钉两个方向。
   */
  it('成功收尾 + `num_turns: 0` 的全 0 ⇒ 判「未采集」且不落 WARN', () => {
    const projection = projectClaudeMessage(
      {
        type: 'result',
        subtype: 'success',
        is_error: false,
        uuid: 'r-zero-ok',
        session_id: 's1',
        // 帧**顶层**的 `num_turns`（不是 usage 里的那一格）：判据读的是它
        num_turns: 0,
        result_index: 1,
        result: '嵌套子智能体的收场帧',
        usage: { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 },
      },
      newState(),
      CONTEXT,
    );
    expect(projection.tokens).toBeNull();
    const stderrLines = projection.drafts
      .filter((draft) => draft.type === 'log' && draft.stream === 'stderr')
      .map((draft) => (draft.type === 'log' ? draft.text : ''));
    expect(stderrLines).toEqual([]);
  });

  it('**失败**收尾 + `num_turns: 0` 的全 0 ⇒ 照旧落 WARN（崩溃/启动错误正是这一档）', () => {
    const projection = projectClaudeMessage(
      {
        ...upstreamErrorResult({ input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 }),
        num_turns: 0,
      },
      newState(),
      CONTEXT,
    );
    expect(projection.tokens).toBeNull();
    const stderrLines = projection.drafts
      .filter((draft) => draft.type === 'log' && draft.stream === 'stderr')
      .map((draft) => (draft.type === 'log' ? draft.text : ''));
    expect(stderrLines.some((line) => line.includes('全 0'))).toBe(true);
  });
});

/**
 * **上下文压缩那一档要占活动行**（`system/status`）。
 *
 * 真机两帧逐字：`{status:'compacting', compact_output_chars:0}` 与
 * `{status:null, compact_result:'failed', compact_error:'too_few_groups'}`（单个大文件顶过阈值、
 * 但可压的分组太少）。压缩是长过程——它此前只躺在原始 JSON 里，界面既不知道在压缩、
 * 也不知道压失败了。**同一 subtype 的 `requesting` 是每轮一条的心跳**（25 轮的运行里 25 条）
 * ⇒ 它不给摘要，照旧只落原始负载（反向判据在下）。
 */
describe('projectClaudeMessage：上下文压缩帧占活动行', () => {
  function statusFrame(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return { type: 'system', subtype: 'status', uuid: 'st-1', session_id: 's1', ...extra };
  }

  it('`compacting` ⇒ 摘要说「开始压缩」，原始负载照发', () => {
    const projection = projectClaudeMessage(statusFrame({ status: 'compacting', compact_output_chars: 0 }), newState(), CONTEXT);
    expect(summaryOf(projection)).toContain('压缩');
    expect(projection.drafts.some((draft) => draft.type === 'log' && draft.text.includes('"subtype":"status"'))).toBe(true);
  });

  it('压缩失败 ⇒ 摘要带上厂商给的原因（`compact_error`）', () => {
    const projection = projectClaudeMessage(
      statusFrame({ status: null, compact_result: 'failed', compact_error: 'too_few_groups' }),
      newState(),
      CONTEXT,
    );
    expect(summaryOf(projection)).toContain('压缩失败');
    expect(summaryOf(projection)).toContain('too_few_groups');
  });

  it('压缩成功 ⇒ 摘要说完成（`status` 是 `null` 时靠 `compact_result` 判）', () => {
    const projection = projectClaudeMessage(statusFrame({ status: null, compact_result: 'success' }), newState(), CONTEXT);
    expect(summaryOf(projection)).toContain('压缩完成');
  });

  /** 反向判据：心跳帧**不占活动行**（否则 25 轮的运行会多出 25 条「正在请求」噪声） */
  it('`requesting` ⇒ 不给摘要，但原始负载照发', () => {
    const projection = projectClaudeMessage(statusFrame({ status: 'requesting' }), newState(), CONTEXT);
    expect(summaryOf(projection)).toBe('');
    expect(projection.drafts.some((draft) => draft.type === 'log' && draft.text.includes('"status":"requesting"'))).toBe(true);
  });
});

/**
 * **`system/init` 自带的技能名单是 `skills` 那一格的回落来源**。
 *
 * 为什么必须有这条回落：`getContextUsage()` 那条探针**只在「这个候选配了技能」时才跑**
 * （编排层按「空集不给键」的口径不下发 `skills`）⇒ 没配技能的候选上收尾那条事件本来一个
 * `skills` 格都不带，而下游把「没有这一格」读成**厂商没投送**——可厂商在 `system/init` 里
 * 明明投了（真机 19 条）。这一格是免费的：init 帧本来就在手上。
 *
 * 三条刻度：只有名字 ⇒ `source` / `path` 记 `null`、`origin` 落 `'unverified'`（**不猜**来源）；
 * 空数组 ⇒ `[]`（「投送了、一条都没有」与「没有这一格」是两句话）；形状不认识 ⇒ `undefined`。
 */
describe('cc：init 帧自带的技能名单', () => {
  const LAYOUT = { configHome: '/tmp/cc-probe-home', cwd: '/tmp/cc-probe-cwd' };

  it('名字数组 ⇒ 逐条给出行，来源未知（不猜厂商自带还是候选装的）', () => {
    const candidates = skillsFromInitFrame({ skills: ['probe-skill', 'deep-research'] }, LAYOUT);
    expect(candidates).toEqual([
      { name: 'probe-skill', source: null, path: null, origin: 'unverified' },
      { name: 'deep-research', source: null, path: null, origin: 'unverified' },
    ]);
  });

  it('空数组 ⇒ `[]`（投送了、一条都没有），不是 `undefined`', () => {
    expect(skillsFromInitFrame({ skills: [] }, LAYOUT)).toEqual([]);
  });

  it('没有这一格 / 形状不认识 ⇒ `undefined`（与「采不到」同形，不编一个空清单）', () => {
    expect(skillsFromInitFrame({}, LAYOUT)).toBeUndefined();
    expect(skillsFromInitFrame({ skills: 'probe-skill' }, LAYOUT)).toBeUndefined();
    expect(skillsFromInitFrame(null, LAYOUT)).toBeUndefined();
  });
});

/**
 * **上游重试帧占活动行**（`system/api_retry`）。
 *
 * 真机读数（上游连续 500、429、断流三臂）：一帧一次重试，最多 10 次、墙钟最长约 3 分钟，
 * 期间**没有任何 assistant / result** ⇒ 这一帧是长退避期间唯一的候选级出口。
 * 原先它只落原始 JSON（`summary: null`），界面在那三分钟里一个字都不说，读者分不清
 * 「在重试」与「卡死了」。原始负载照旧整条落盘。
 */
describe('projectClaudeMessage：上游重试帧占活动行', () => {
  /** 真机那一帧的逐字键集与取值 */
  function retryFrame(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      type: 'system',
      subtype: 'api_retry',
      uuid: 'retry-1',
      session_id: 's1',
      attempt: 3,
      max_retries: 10,
      retry_delay_ms: 2039,
      error_status: 500,
      error: 'server_error',
      ...extra,
    };
  }

  it('摘要含「第几次 / 上限 / 等多久 / 状态码」，且原始负载照发', () => {
    const projection = projectClaudeMessage(retryFrame(), newState(), CONTEXT);
    expect(summaryOf(projection)).toContain('500');
    expect(summaryOf(projection)).toContain('3/10');
    expect(summaryOf(projection)).toContain('2.0 s');
    // 原始负载一整条都在（排障读的就是它）
    expect(projection.drafts.some((draft) => draft.type === 'log' && draft.text.includes('"subtype":"api_retry"'))).toBe(true);
  });

  /** 连接错那一档没有 `error_status`（真机 `error: 'no_response'` 一类）⇒ 用 `error` 名，不编状态码 */
  it('缺 `error_status` ⇒ 摘要用 `error` 名，不编一个状态码', () => {
    const projection = projectClaudeMessage(retryFrame({ error_status: undefined, error: 'no_response' }), newState(), CONTEXT);
    expect(summaryOf(projection)).toContain('no_response');
    expect(summaryOf(projection)).not.toContain('上游 5');
  });

  /** 三格都缺席时摘要仍要成句（不吐 `undefined` / 空串） */
  it('三格全缺 ⇒ 仍是一句可读摘要', () => {
    const projection = projectClaudeMessage(
      retryFrame({ error_status: undefined, error: undefined, attempt: undefined, max_retries: undefined, retry_delay_ms: undefined }),
      newState(),
      CONTEXT,
    );
    expect(summaryOf(projection)).toBe('上游错误');
  });
});

/**
 * **失败收尾时厂商自己写的诊断不许丢**。
 *
 * `result` 帧的 `type` 被识别 ⇒ **不走未识别兜底**，凡是没有被显式读出来的格一个字节都不剩。
 * 真机读数（上游连续 500、重试 10 次耗尽）：`subtype: 'error_during_execution'`、`result` 缺失、
 * `terminal_reason: 'aborted_streaming'`、`errors: ['[ede_diagnostic] result_type=user
 * last_content_type=n/a stop_reason=null']`——`errors` 是唯一说明「为什么这一轮没有答复」的文本。
 */
describe('projectClaudeMessage：失败收尾的厂商诊断', () => {
  /** 真机那条失败收尾帧的键集（`result` 缺席，只留下诊断格） */
  function failureResult(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      uuid: 'res-fail-1',
      session_id: 's1',
      duration_ms: 1,
      duration_api_ms: 0,
      num_turns: 1,
      result_index: 0,
      total_cost_usd: 0,
      // 用量四项齐（缺项会另落一条「用量负载不完整」的 WARN，把这条用例的判据搅浑）
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        output_tokens_details: { thinking_tokens: 0 },
      },
      ...extra,
    };
  }

  it('`result` 为空时把 `terminal_reason` 拼进失败文案（比 subtype 具体）', () => {
    const projection = projectClaudeMessage(failureResult({ terminal_reason: 'prompt_too_long' }), newState(), CONTEXT);
    expect(projection.failure?.message).toContain('error_during_execution');
    expect(projection.failure?.message).toContain('prompt_too_long');
  });

  it('`terminal_reason` 缺席 ⇒ 文案里不出现那一格（不编一个空值）', () => {
    const projection = projectClaudeMessage(failureResult(), newState(), CONTEXT);
    expect(projection.failure?.message).toContain('error_during_execution');
    expect(projection.failure?.message).not.toContain('terminal_reason');
  });

  it('`errors[]` 落一条 stderr 日志（不读的格一个字节都不剩）', () => {
    const projection = projectClaudeMessage(
      failureResult({ errors: ['[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null'] }),
      newState(),
      CONTEXT,
    );
    const line = projection.drafts.find((draft) => draft.type === 'log' && draft.stream === 'stderr' && draft.text.includes('收尾错误'));
    expect(line?.type === 'log' ? line.text : '').toContain('ede_diagnostic');
  });

  /** 反向判据：`errors` 缺席或空数组时**不落**那条日志（否则每个候选失败都多一条空噪声） */
  it('`errors` 缺席 / 空数组 ⇒ 不落那条日志', () => {
    for (const extra of [{}, { errors: [] }, { errors: [''] }]) {
      const projection = projectClaudeMessage(failureResult(extra), newState(), CONTEXT);
      const line = projection.drafts.find((draft) => draft.type === 'log' && draft.stream === 'stderr' && draft.text.includes('收尾错误'));
      expect(line).toBeUndefined();
    }
  });
});
