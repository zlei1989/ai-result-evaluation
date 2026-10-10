// @vitest-environment node
/**
 * dsh 的通知投影（按真实探测到的厂商事件形态）。
 * 探测结论（`docs/protocols/dsh.md`）：
 * 通知是 `{ method, params }`，事件全在 `method === 'session.event'` 里；用量在
 * `params.event.type === 'assistant/message'` 的 `params.event.data.usage`；轮次结束与失败在
 * `params.event.type === 'turn/end'`。下面每条用例的构造数据都照 `probe/dumps/dsh.json` 的真实字段名写。
 * 收尾轮补充的去重口径：投影**不自己 draft `usage`**（发射权归骨架那个三家共用的循环内发射口），
 * 但 `takeTurnTokens` 的**取走即归零**必须保留——两条都在下面有用例钉住。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { ACTIVITY_SUMMARY_MAX_LENGTH } from '../../activity';
import type { TurnState } from '../../turn';
import {
  DSH_ASSISTANT_MESSAGE_TYPE,
  DSH_TURN_END_TYPE,
  DSH_USAGE_FIELDS,
  projectDshNotification,
  resetSubagentCatalogForTesting,
} from './events';

/**
 * 子任务的 `childSessionId → catalog` 关联表是**模块级**的（任务名与身份分两条消息到达，
 * 见 `rememberSubagentCatalog` 的 JSDoc）。生产上每个 run 的 childId 都是新 UUID、不会串；
 * 但**用例之间会串**——实测症状：「catalog 未到」那条用例读到了上一条用例留下的 label。
 * 所以每条用例前清一次：判据必须只取决于本用例喂进去的消息。
 */
beforeEach(() => {
  resetSubagentCatalogForTesting();
});

const CONTEXT = { kind: 'dsh', baseUrl: 'https://gw.example.com/deepseek/v1' } as const;

function newState(): TurnState {
  return {
    seen: new Set(),
    turns: 0,
    usageInput: null,
    usageCached: null,
    usageOutput: null,
    usageReasoningOutput: null,
    usageTotal: null,
    // 时间跨度也归骨架维护（dsh 的 `turn/start` / `assistant/message` / `turn/end` 都往里记）
    timing: null,
    usageByMessageId: new Map(),
    turnKeys: new Set(),
    finalText: null,
  };
}

/**
 * 造一条真实的会话事件通知（外形照 dump：`{ method, params: { sessionId, event } }`）。
 * 第三参是**会话身份**（缺省 = 主会话 `session-1`）：子会话的事件与主会话在同一条流里，
 * 靠这一格区分（归属口径的守卫要按会话喂数据）。
 */
function sessionEvent(type: string, data: unknown, sessionId = 'session-1'): unknown {
  return { method: 'session.event', params: { sessionId, event: { type, seq: 1, time: 1, data } } };
}

/**
 * 子智能体生命周期：dsh 侧是**顶层通知**（`{ method, params }`，
 * 不是 `session.event` 包一层）+ 一条 `subagent/catalog` 会话事件。
 *
 * 载荷逐字取自真机。为什么这些守卫值得存在：`projectDshNotification` 过去
 * **只认 `session.event` 一种外形**，其余一律落 `unknownEventDraft` ⇒ 真机抓到两条
 * `subagent.*` 通知，却是 31 条 log 里的一坨原始 JSON，界面上看不出派过子任务。
 */
describe('projectDshNotification：子智能体生命周期', () => {
  /** 真机 subagent.started ① */
  const STARTED = {
    method: 'subagent.started',
    params: { parentSessionId: 'session-16c91eba4bf54932a23c6dd4f39eb05b', childSessionId: 'a5e63152-5662-4986-a190-7849eeac0f0b' },
  };
  /** 真机 subagent/catalog ②——**任务名在这一条里** */
  const CATALOG = {
    method: 'session.event',
    params: {
      sessionId: 'session-16c91eba4bf54932a23c6dd4f39eb05b',
      event: {
        type: 'subagent/catalog',
        seq: 22,
        time: 1790757576230,
        data: { version: 0, childId: 'a5e63152-5662-4986-a190-7849eeac0f0b', childCreatedAt: 1790757576213, mode: 'one-shot', label: 'Count lines in notes.txt' },
      },
    },
  };
  /** 真机 subagent.finished ③ */
  const FINISHED = {
    method: 'subagent.finished',
    params: {
      provider: 'spawn',
      agentId: 'a5e63152-5662-4986-a190-7849eeac0f0b',
      parentSessionId: 'session-16c91eba4bf54932a23c6dd4f39eb05b',
      childSessionId: 'a5e63152-5662-4986-a190-7849eeac0f0b',
      status: 'ok',
      stopReason: 'completed',
      lastAssistantMessage: [
        { type: 'reasoning', text: 'Both methods agree: the file has 3 lines.' },
        { type: 'text', text: '3' },
      ],
    },
  };

  it('subagent.started ⇒ 一条可解析的「已派发子任务」日志（身份来自通知，任务名随后由 catalog 补）', () => {
    const projection = projectDshNotification(STARTED, newState(), CONTEXT);
    expect(projection.drafts).toHaveLength(1);
    const [draft] = projection.drafts;
    expect(draft?.type).toBe('log');

    const payload = JSON.parse((draft as { text: string }).text);
    expect(payload.kind).toBe('subagent');
    expect(payload.phase).toBe('start');
    expect(payload.source).toBe('wire');
    // 厂商原生 id：真机 agentId 与 childSessionId 同值
    expect(payload.subagentId).toBe('a5e63152-5662-4986-a190-7849eeac0f0b');
    expect(payload.vendorId).toBe('a5e63152-5662-4986-a190-7849eeac0f0b');
    // catalog 还没到 ⇒ 名字为 null，**不编**
    expect(payload.name).toBeNull();
    expect(payload.parentSessionId).toBe('session-16c91eba4bf54932a23c6dd4f39eb05b');
    /**
     * 摘要里**不留占位名**：旧实现写成 `已派发子任务：子任务`——一句同义反复，
     * 读的人只会以为界面坏了（词表实现见 `src/activity.ts`）。
     */
    expect(draft?.type === 'log' ? draft.summary : undefined).toBe('已派发子任务');
  });

  it('catalog 到达后，finish 能带上厂商给的任务名与 mode（跨消息关联）', () => {
    const state = newState();
    projectDshNotification(STARTED, state, CONTEXT);
    // catalog 自身不产出面向用户的事件（它是身份补充，不是进度）——但必须被记住
    const catalogProjection = projectDshNotification(CATALOG, state, CONTEXT);
    expect(catalogProjection.drafts).toHaveLength(0);

    const projection = projectDshNotification(FINISHED, state, CONTEXT);
    const payload = JSON.parse((projection.drafts[0] as { text: string }).text);
    expect(payload.phase).toBe('end');
    expect(payload.name).toBe('Count lines in notes.txt');
    expect(payload.subagentKind).toBe('one-shot');
    expect(payload.confidence).toBe('exact');
  });

  it('catalog 未到就 finish ⇒ 仍发事件，name/kind 为 null 且 confidence=unknown（不编）', () => {
    const projection = projectDshNotification(FINISHED, newState(), CONTEXT);
    const payload = JSON.parse((projection.drafts[0] as { text: string }).text);
    expect(payload.name).toBeNull();
    expect(payload.subagentKind).toBeNull();
    // 身份关联没建立 ⇒ 显式标出来，而不是让下游以为这是完整数据
    expect(payload.confidence).toBe('unknown');
  });

  it('status/stopReason 映射到契约值域：ok+completed ⇒ completed', () => {
    const projection = projectDshNotification(FINISHED, newState(), CONTEXT);
    const payload = JSON.parse((projection.drafts[0] as { text: string }).text);
    expect(payload.status).toBe('completed');
    // 厂商原文一并留着（抽屉里的证据）
    expect(payload.vendorStatus).toBe('ok');
    expect(payload.stopReason).toBe('completed');
    // outcome 取 lastAssistantMessage 里的 text 块，**不取 reasoning**
    expect(payload.outcome).toBe('3');
  });

  it('未验证的 status 取值**原样透出**，不假装映射成 failed（真机只覆盖成功路径）', () => {
    const projection = projectDshNotification(
      { ...FINISHED, params: { ...FINISHED.params, status: 'weird', stopReason: 'mystery' } },
      newState(),
      CONTEXT,
    );
    const payload = JSON.parse((projection.drafts[0] as { text: string }).text);
    expect(payload.status).toBeNull();
    expect(payload.statusMissing).toBe('unverified');
    expect(payload.vendorStatus).toBe('weird');
    expect(payload.stopReason).toBe('mystery');
  });

  it('缺 childSessionId/agentId 时身份为 null，但事件照发（不丢「派过子任务」这件事实）', () => {
    const projection = projectDshNotification(
      { method: 'subagent.started', params: { parentSessionId: 'session-1' } },
      newState(),
      CONTEXT,
    );
    const payload = JSON.parse((projection.drafts[0] as { text: string }).text);
    expect(payload.kind).toBe('subagent');
    expect(payload.subagentId).toBeNull();
    expect(payload.vendorId).toBeNull();
  });
});

/**
 * 最终答复出口：答复在 `assistant/message` 的
 * `params.event.data.message.content[]` 里，**必须按块类型过滤**——
 * 同一个数组里的 `reasoning` 块也带 `text` 字段，不过滤会把推理混进答复。
 */
describe('projectDshNotification：最终答复（finalText）', () => {
  it('assistant/message 的 text 块被记为最终答复', () => {
    const state = newState();
    projectDshNotification(
      {
        method: 'session.event',
        params: {
          sessionId: 's1',
          event: {
            type: 'assistant/message',
            data: {
              turn: 1,
              message: { role: 'assistant', content: [{ type: 'text', text: '{"dimensions":[]}' }] },
            },
          },
        },
      },
      state,
      CONTEXT,
    );
    expect(state.finalText).toBe('{"dimensions":[]}');
  });

  // 同一个 content 数组里的 reasoning 块**也带 text 字段**（dump 形状）。
  // 不过滤就会把推理内容拼进答复 ⇒ JSON 解析失败，而表象像「模型不守契约」。
  it('reasoning 块不算答复（它也带 text 字段，必须按 type 过滤）', () => {
    const state = newState();
    projectDshNotification(
      {
        method: 'session.event',
        params: {
          sessionId: 's1',
          event: {
            type: 'assistant/message',
            data: {
              turn: 1,
              message: {
                role: 'assistant',
                content: [
                  { type: 'reasoning', text: '让我先想想这道题该怎么打分' },
                  { type: 'text', text: '{"verdict":"还行"}' },
                ],
              },
            },
          },
        },
      },
      state,
      CONTEXT,
    );
    expect(state.finalText).toBe('{"verdict":"还行"}');
  });

  /**
   * **推理原文必须留下证据**。
   *
   * 为什么这条守卫值得存在：过滤掉 reasoning 是**对的**（否则推理混进答复），但**只过滤不落盘
   * 就是把证据丢了**——dsh 实测每次模型往返都带完整推理文本（真机三次往返分别 259 / 68 / 143 字符），
   * 而修复前适配器**一个字都不留**（`assistant/message` 只投影 `type==='text'`）。
   *
   * 与 claude-code 同待遇：那边非文本块走 `others` 分支落一条原始负载日志
   * （`providers/claude-code/events.ts` 的 `assistantDrafts`），所以两家的推理在抽屉里都看得到。
   *
   * ⚠️ 一条被推翻的旧口径：本文件上游曾写「dsh 的 reasoning 实测 `text` 恒为空串」——
   * **探测中继把整条流转成单块、破坏 SSE 分块**会造成这个假象；走 SDK 时推理文本完整。
   */
  it('reasoning 块要落一条日志（原始信封是证据，只过滤不落盘等于丢掉它），但**不给摘要**', () => {
    const state = newState();
    const reasoning = '让我先想想这道题该怎么打分：这行改动没有测试，按 rubric 该扣分';
    const projection = projectDshNotification(
      sessionEvent(DSH_ASSISTANT_MESSAGE_TYPE, {
        turn: 1,
        step: 1,
        usage: { [DSH_USAGE_FIELDS.input]: 10, [DSH_USAGE_FIELDS.cached]: 0, [DSH_USAGE_FIELDS.output]: 2 },
        message: {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: reasoning },
            { type: 'text', text: '{"verdict":"还行"}' },
          ],
        },
      }),
      state,
      CONTEXT,
    );

    // 答复仍只取 text 块（推理不能混进去）
    expect(state.finalText).toBe('{"verdict":"还行"}');
    // 推理另落一条：原文在**原始信封**里逐字可查
    const reasoningLog = projection.drafts.find((d) => d.type === 'log' && d.text.includes(reasoning));
    expect(reasoningLog).toBeDefined();
    /**
     * 判据是「**没有摘要**」：给了摘要（旧文案 `思考：<推理>`）活动行就会永久停在英文推理上——
     * 同一轮里推理行排在答复行之后 ⇒ 最新一句恒是它。人话落点是思考块，日志这条只作证据。
     */
    expect(reasoningLog?.type === 'log' ? reasoningLog.summary : 'x').toBeUndefined();
    // 两条都在（答复一条 + 推理一条），不是互相替代
    expect(projection.drafts.filter((d) => d.type === 'log')).toHaveLength(2);
  });

  it('空的 reasoning 块不落日志（dsh 也会发占位空块，落了就是噪声）', () => {
    const projection = projectDshNotification(
      sessionEvent(DSH_ASSISTANT_MESSAGE_TYPE, {
        turn: 1,
        step: 1,
        usage: { [DSH_USAGE_FIELDS.input]: 10, [DSH_USAGE_FIELDS.cached]: 0, [DSH_USAGE_FIELDS.output]: 2 },
        message: { role: 'assistant', content: [{ type: 'reasoning', text: '' }] },
      }),
      newState(),
      CONTEXT,
    );

    expect(projection.drafts.filter((d) => d.type === 'log')).toHaveLength(0);
  });
});

describe('projectDshNotification（通知投影）', () => {
  it('未识别的通知保留原始负载（一条都不丢）', () => {
    const payload = { method: 'session.update', params: { text: 'hello', nested: [1, 2] } };
    const projection = projectDshNotification(payload, newState(), CONTEXT);
    expect(projection.drafts).toHaveLength(1);
    expect(JSON.parse(projection.drafts[0]?.type === 'log' ? projection.drafts[0].text : '')).toEqual(payload);
  });

  it('没有 method 的通知同样保留原始负载（形状未知不等于可以丢）', () => {
    const projection = projectDshNotification({ anything: true }, newState(), CONTEXT);
    expect(projection.drafts).toHaveLength(1);
  });

  it('实测确认：assistant/message 的用量被提取并记进**本行累计**，并当场交出去（字段名逐字来自探测 dump）', () => {
    const state = newState();
    const projection = projectDshNotification(
      sessionEvent(DSH_ASSISTANT_MESSAGE_TYPE, {
        turn: 1,
        step: 1,
        usage: { [DSH_USAGE_FIELDS.input]: 218, [DSH_USAGE_FIELDS.cached]: 8832, [DSH_USAGE_FIELDS.output]: 2 },
      }),
      state,
      CONTEXT,
    );
    // 累计值留在 state 上（**不清零**：现在的口径是「到目前为止」，三条出口都从这里取）
    expect(state.usageInput).toBe(218);
    expect(state.usageCached).toBe(8832);
    expect(state.usageOutput).toBe(2);
    // 当场交出这一份累计（界面上的 tok 因此在一个 step 内也会动）
    // 两个可选格这一条没给 ⇒ `null`（**不是 0**）
    expect(projection.tokens).toEqual({
      input: 218,
      cached: 8832,
      output: 2,
      reasoningOutput: null,
      total: null,
    });
    // 本条不是轮次计数的落点（那个是 `step/start`）⇒ 还没数到任何 step 时给 null，不发明一个 0
    expect(projection.turns).toBeNull();
  });

  it('用量字段缺席（可选字段）⇒ null + WARN，绝不填 0（没采到与 0 必须能区分）', () => {
    const projection = projectDshNotification(
      sessionEvent(DSH_ASSISTANT_MESSAGE_TYPE, {
        usage: { [DSH_USAGE_FIELDS.input]: 12, [DSH_USAGE_FIELDS.output]: 5 }, // 没有 cacheReadTokens
      }),
      newState(),
      CONTEXT,
    );
    expect(projection.tokens).toBeNull();
    expect(
      projection.drafts.some((draft) => draft.type === 'log' && draft.text.includes('[WARN] 用量负载不完整')),
    ).toBe(true);
  });

  /**
   * 轮次口径（用户口径）：**一次模型 API 往返 = 一个 step**。
   * 计数点选 `step/start`（「这一次请求已经发出去了」），而不是收尾的 `turn/end`
   * ——实测那一轮 59 个 step、而 `turn/end` 只有 1 条，按它数出来永远是「轮次 1」。
   */
  it('step/start ⇒ 轮次 +1（一次模型 API 往返算一次）；turn/end 不再计数', () => {
    const state = newState();
    const first = projectDshNotification(sessionEvent('step/start', { turn: 1, step: 1 }), state, CONTEXT);
    const second = projectDshNotification(sessionEvent('step/start', { turn: 1, step: 2 }), state, CONTEXT);
    expect(first.turns).toBe(1);
    expect(second.turns).toBe(2);
    expect(state.turns).toBe(2);

    const end = projectDshNotification(
      sessionEvent(DSH_TURN_END_TYPE, { turn: 1, reason: { kind: 'completed' } }),
      state,
      CONTEXT,
    );
    expect(end.turns).toBe(2); // 收尾只是把当前值再交一次，不再 +1
    expect(state.turns).toBe(2);
    expect(end.failure).toBeNull();
    expect(end.drafts).toHaveLength(0);
  });

  it('turn/end 的结构化失败对象（实测的传输失败形状）⇒ failure，并按文案归因', () => {
    const projection = projectDshNotification(
      sessionEvent(DSH_TURN_END_TYPE, {
        turn: 1,
        reason: { kind: 'error', error: { message: 'HTTP 401 unauthorized', code: 'TRANSPORT' } },
      }),
      newState(),
      CONTEXT,
    );
    expect(projection.failure?.code).toBe('AUTH_FAILED');
    expect(projection.drafts.some((draft) => draft.type === 'error')).toBe(true);
  });

  it('turn/end 的字符串型失败（SDK 把非结构化异常折成 errorChain 字符串）同样被认出来', () => {
    // 实测依据：`errorChain(error)` 对普通 Error 返回 string，而 `TurnEndReasonMap.error` 的声明是
    // `LlmFailure` 对象 ⇒ 真实载荷与类型面不一致。只认对象会让这一类失败静默变成 ok:true
    const projection = projectDshNotification(
      sessionEvent(DSH_TURN_END_TYPE, { turn: 1, reason: { kind: 'error', error: '传输中断' } }),
      newState(),
      CONTEXT,
    );
    expect(projection.failure).not.toBeNull();
    expect(projection.drafts.some((draft) => draft.type === 'error')).toBe(true);
  });

  it('收尾交出的是**累计**计量（不清零），发射权归骨架（同一轮只发一条 usage）', () => {
    // 裁决（端到端出现过同一轮两条 usage）：投影只交 tokens/turns，
    // 由骨架唯一的循环内发射口发那一条 usage（去重也在骨架里）。
    // 用户口径：累计值**不取走归零**——事件本身是覆盖语义，跨 step 相加由累计值天然给出。
    const state = newState();
    projectDshNotification(sessionEvent('step/start', { turn: 1, step: 1 }), state, CONTEXT);
    projectDshNotification(
      sessionEvent(DSH_ASSISTANT_MESSAGE_TYPE, {
        turn: 1,
        step: 1,
        usage: { [DSH_USAGE_FIELDS.input]: 218, [DSH_USAGE_FIELDS.cached]: 8832, [DSH_USAGE_FIELDS.output]: 2 },
      }),
      state,
      CONTEXT,
    );
    // 第二个 step：用量继续累加，交出的是**两段之和**
    projectDshNotification(sessionEvent('step/start', { turn: 1, step: 2 }), state, CONTEXT);
    projectDshNotification(
      sessionEvent(DSH_ASSISTANT_MESSAGE_TYPE, {
        turn: 1,
        step: 2,
        usage: { [DSH_USAGE_FIELDS.input]: 10, [DSH_USAGE_FIELDS.cached]: 5, [DSH_USAGE_FIELDS.output]: 3 },
      }),
      state,
      CONTEXT,
    );
    const projection = projectDshNotification(
      sessionEvent(DSH_TURN_END_TYPE, { turn: 1, reason: { kind: 'completed' } }),
      state,
      CONTEXT,
    );
    expect(projection.tokens).toEqual({
      input: 228,
      cached: 8837,
      output: 5,
      reasoningOutput: null,
      total: null,
    });
    expect(projection.turns).toBe(2);
    expect(projection.drafts).toHaveLength(0); // 一条 usage 都不在这里 draft（否则与骨架那条重复）
    // 累计值留在 state 上（下一轮的用量继续加在同一个基数上，事件里永远是「到目前为止」）
    expect(state.usageInput).toBe(228);
  });

  it('非 error 的 turn/end 原因（aborted 等）不算失败', () => {
    const state = newState();
    projectDshNotification(sessionEvent('step/start', { turn: 1, step: 1 }), state, CONTEXT);
    const projection = projectDshNotification(
      sessionEvent(DSH_TURN_END_TYPE, { turn: 1, reason: { kind: 'aborted', reason: 'user' } }),
      state,
      CONTEXT,
    );
    expect(projection.failure).toBeNull();
    expect(projection.turns).toBe(1);
  });

  it('已识别但有意不投影的通知（session.status）也保留原始负载，不静默丢弃', () => {
    // 实测：`session.status` 是 running/idle 两条，与轮次语义无关，骨架不需要它。
    // 「有意不投影」不等于「可以丢」——它仍然落一条保留负载的日志事件
    const projection = projectDshNotification(
      { method: 'session.status', params: { sessionId: 'session-1', status: 'idle' } },
      newState(),
      CONTEXT,
    );
    expect(projection.drafts).toHaveLength(1);
    expect(projection.turns).toBeNull();
  });
});

/**
 * 消息级用量。三条判据：
 *   · wire 上的 `data.usage` **逐字**进这条消息的 `usage`（不是累计快照、不是行级 tokens）；
 *   · 三项缺一 ⇒ 消息级与行级**同时**是「未采集」（都不填 0）；
 *   · 子会话的消息同样带它自己的用量（与主会话共用同一个归一函数）。
 */
describe('assistant/message 的消息级 usage', () => {
  it('wire 的 data.usage 逐字进这条消息的 usage', () => {
    const projection = projectDshNotification(
      sessionEvent(DSH_ASSISTANT_MESSAGE_TYPE, {
        turn: 1,
        step: 1,
        usage: { [DSH_USAGE_FIELDS.input]: 295, [DSH_USAGE_FIELDS.cached]: 7424, [DSH_USAGE_FIELDS.output]: 841 },
        message: { role: 'assistant', content: [{ type: 'text', text: '好' }] },
      }),
      newState(),
      CONTEXT,
    );

    expect(projection.messages?.[0]?.usage).toEqual({
      input: 295,
      cached: 7424,
      output: 841,
      reasoningOutput: null,
      total: null,
    });
  });

  it('三项缺一 ⇒ 消息级是 null（不填 0），行级同样是「未采集」', () => {
    const state = newState();
    const projection = projectDshNotification(
      sessionEvent(DSH_ASSISTANT_MESSAGE_TYPE, {
        turn: 1,
        step: 1,
        // 没有 cacheReadTokens：dsh 的缓存命中是**独立一格**，缺它就不算读全（不填 0）
        usage: { [DSH_USAGE_FIELDS.input]: 12, [DSH_USAGE_FIELDS.output]: 5 },
        message: { role: 'assistant', content: [{ type: 'text', text: '好' }] },
      }),
      state,
      CONTEXT,
    );

    expect(projection.messages?.[0]?.usage).toBeNull();
    expect(projection.tokens).toBeNull();
  });

  it('子会话的消息同样带它自己的用量', () => {
    // 先按真机外形登记子会话（`sessionIdProfileSubagent` 只认登记过的 id）
    projectDshNotification(
      { method: 'subagent.started', params: { parentSessionId: 'session-1', childSessionId: 'child-1' } },
      newState(),
      CONTEXT,
    );
    const projection = projectDshNotification(
      sessionEvent(
        DSH_ASSISTANT_MESSAGE_TYPE,
        {
          turn: 1,
          step: 2,
          usage: { [DSH_USAGE_FIELDS.input]: 1002, [DSH_USAGE_FIELDS.cached]: 8320, [DSH_USAGE_FIELDS.output]: 1531 },
          message: { role: 'assistant', content: [{ type: 'text', text: '子会话答复' }] },
        },
        'child-1',
      ),
      newState(),
      CONTEXT,
    );

    expect(projection.messages?.[0]?.subagentId).toBe('child-1');
    expect(projection.messages?.[0]?.usage).toEqual({
      input: 1002,
      cached: 8320,
      output: 1531,
      reasoningOutput: null,
      total: null,
    });
  });
});

/**
 * **消息级用量与行级累计并存且互不影响**。
 * 两条口径同源于同一条 wire 负载，但一个是「这一次调用」、一个是「到目前为止」——
 * 改动最容易在这里出静默的错：拿累计当消息级（页脚数字越滚越大）或反过来（卡片少报）。
 */
describe('消息级与行级两条口径并存', () => {
  it('同一条通知喂两处：消息级各是各的，行级是两次之和', () => {
    const state = newState();
    const first = projectDshNotification(
      sessionEvent(DSH_ASSISTANT_MESSAGE_TYPE, {
        turn: 1,
        step: 1,
        usage: { [DSH_USAGE_FIELDS.input]: 295, [DSH_USAGE_FIELDS.cached]: 7424, [DSH_USAGE_FIELDS.output]: 841 },
        message: { role: 'assistant', content: [{ type: 'text', text: '第一条' }] },
      }),
      state,
      CONTEXT,
    );
    const second = projectDshNotification(
      sessionEvent(DSH_ASSISTANT_MESSAGE_TYPE, {
        turn: 1,
        step: 2,
        usage: { [DSH_USAGE_FIELDS.input]: 210, [DSH_USAGE_FIELDS.cached]: 8448, [DSH_USAGE_FIELDS.output]: 562 },
        message: { role: 'assistant', content: [{ type: 'text', text: '第二条' }] },
      }),
      state,
      CONTEXT,
    );

    // 消息级：每条各是它自己那一次调用的值（不是累计）
    expect(first.messages?.[0]?.usage?.input).toBe(295);
    expect(second.messages?.[0]?.usage?.input).toBe(210);
    // 行级：两次之和（既有口径一个字不动）
    expect(second.tokens).toEqual({ input: 505, cached: 15872, output: 1403, reasoningOutput: null, total: null });
  });
});

/**
 * 归属与**每会话自己的**轮次号（spec
 * `docs/protocols/message-spec.md`「轮次归属」）。
 *
 * 口径：消息的 `roundTrip` 与 `usage.turn.round` 是**同一个数**，都由 `message.ts` 的
 * `dshTurnAttribution` 算出来——取厂商给的**每会话** `step`（真机：主会话 1,2,3、子会话 1,2,3），
 * 不带 `step` 的出口（`turn/end`）退回**该会话**最后一个 step，一次都没见过的会话给 `null`
 * （**不拿本行累计号顶替**）。合计（`turns` / `tokens`）仍是全树口径，与这两格不是一回事。
 */
describe('projectDshNotification：归属（每会话自己的 step）', () => {
  /**
   * 子会话身份的**唯一登记口**是顶层 `subagent.started`（`message.ts` 的 `dshSubagentRecord`）：
   * 不喂它的话 `sessionIdProfileSubagent` 认不出 `child-1`，归属会退回主会话（`subagentId: null`）
   * ——而「子会话的 step 归到它自己名下」这条判据就白钉了。
   */
  const CHILD_STARTED = { method: 'subagent.started', params: { subagentId: 'child-1', parentSessionId: 'session-1' } };

  /**
   * 每会话自己的轮次号：`data.step` 是厂商给的**每会话**序号
   * （真机：主会话 1,2,3、子会话 1,2,3），消息的 `roundTrip` 与 `usage.turn.round` 都用它。
   * 用 `state.turns`（本行全局计数）⇒ 主会话第二条读到的是**别人**的数——**1**
   * （全局计数里只有子会话那一步），子会话再多跑几步时它还会被推得更高。号因此既不等于自己的步数、
   * 也不等于任何会话的步数。
   */
  it('消息的轮次号是**该会话自己的** step：别的会话插进来也不会把它推高', () => {
    const state = newState();
    const main1 = projectDshNotification(
      sessionEvent(DSH_ASSISTANT_MESSAGE_TYPE, { turn: 1, step: 1, message: { content: [{ type: 'text', text: '一' }] } }),
      state,
      CONTEXT,
    );
    // 子会话插一条（本行累计轮次照样 +1：`state.turns` 是**全树**口径，见下一条用例）
    projectDshNotification(sessionEvent('step/start', { turn: 1, step: 1 }, 'child-1'), state, CONTEXT);
    const main2 = projectDshNotification(
      sessionEvent(DSH_ASSISTANT_MESSAGE_TYPE, { turn: 1, step: 2, message: { content: [{ type: 'text', text: '二' }] } }),
      state,
      CONTEXT,
    );
    expect(main1.messages?.[0]?.roundTrip).toBe(1);
    expect(main2.messages?.[0]?.roundTrip).toBe(2);
    // 归属：主会话（`subagentId: null`）+ 各自的 step
    expect(main1.turn).toEqual({ subagentId: null, round: 1 });
    expect(main2.turn).toEqual({ subagentId: null, round: 2 });
  });

  it('归属带上会话身份：子会话的 step 归到它自己名下；`turn/end` 归到该会话最后一个 step', () => {
    const state = newState();
    // 先认下「child-1 是一个子会话」（身份登记见上面那条的 JSDoc）
    projectDshNotification(CHILD_STARTED, state, CONTEXT);
    projectDshNotification(sessionEvent('step/start', { turn: 1, step: 1 }, 'child-1'), state, CONTEXT);
    const child = projectDshNotification(
      sessionEvent(DSH_ASSISTANT_MESSAGE_TYPE, { turn: 1, step: 1, usage: { inputTokens: 4, cacheReadTokens: 1, outputTokens: 3 } }, 'child-1'),
      state,
      CONTEXT,
    );
    expect(child.turn).toEqual({ subagentId: 'child-1', round: 1 });
    // `turn/end` 的载荷里没有 step ⇒ 退回**该会话**最后一个 step（不是本行累计号）
    const end = projectDshNotification(sessionEvent(DSH_TURN_END_TYPE, { turn: 1, reason: { kind: 'completed' } }, 'child-1'), state, CONTEXT);
    expect(end.turn).toEqual({ subagentId: 'child-1', round: 1 });
    // 一次 step 都没见过的会话 ⇒ 没有归属（不拿本行累计号顶替）
    const stranger = projectDshNotification(sessionEvent(DSH_TURN_END_TYPE, { turn: 1, reason: { kind: 'completed' } }, 'child-2'), newState(), CONTEXT);
    expect(stranger.turn).toBeNull();
  });
});

/**
 * 工具调用 / 结果的**人话摘要**（用户口径）。
 *
 * 背景：卡片底部那一条活动行显示的是 `log.summary`。实测里
 * 142 条日志绝大多数是 `{"method":"session.event","params":{…}}` 信封——没有摘要时界面只能
 * 把那坨 JSON 滚出来（用户原话：「动画内容应该是具体的消息，不应该是 json 字符串」）。
 *
 * 两条口径，缺一条这个功能就白做：
 *   ① `text` **一个字都不改**（原始负载是排障证据，抽屉里逐字可见）——摘要只是多出来的一格；
 *   ② 摘要必须是**人话**：参数取 `command` / `file_path` 这类字段，且单行化 + 截断，
 *      不许把整段脚本抄进去。
 */
describe('projectDshNotification：工具调用 / 结果的人话摘要', () => {
  it('tool/call：摘要 = 工具名 + 参数里最说明问题的那个字段', () => {
    const projection = projectDshNotification(
      sessionEvent('tool/call', {
        turn: 1,
        step: 23,
        callId: 'call_00_btJVXbiWzWNpqEFBrmyx7061',
        name: 'pwsh',
        arguments: '{"command": "npm run build-only 2>&1 | Select-Object -Last 20"}',
      }),
      newState(),
      CONTEXT,
    );

    expect(projection.drafts).toHaveLength(1);
    const [draft] = projection.drafts;
    expect(draft?.type === 'log' ? draft.summary : undefined).toBe(
      '调用工具 pwsh：npm run build-only 2>&1 | Select-Object -Last 20',
    );
    // 证据没被动过：`text` 仍是那条原始 JSON（含 callId 那种只对排障有意义的字段）
    expect(draft?.type === 'log' ? draft.text : '').toContain('call_00_btJVXbiWzWNpqEFBrmyx7061');
    // 工具事件既不报计量也不计数（与 `unknown` 同一个出口口径）
    expect(projection.tokens).toBeNull();
    expect(projection.turns).toBeNull();
  });

  it('参数里没有那几个关键字 ⇒ 退化成紧凑 JSON；不是 JSON ⇒ 原样用（两条都不许空着）', () => {
    const compact = projectDshNotification(
      sessionEvent('tool/call', { name: 'x', arguments: '{"foo": "bar"}' }),
      newState(),
      CONTEXT,
    );
    expect(compact.drafts[0]).toMatchObject({ summary: '调用工具 x：{"foo":"bar"}' });

    const notJson = projectDshNotification(
      sessionEvent('tool/call', { name: 'x', arguments: '不是 JSON 的参数' }),
      newState(),
      CONTEXT,
    );
    expect(notJson.drafts[0]).toMatchObject({ summary: '调用工具 x：不是 JSON 的参数' });
  });

  it('摘要单行化并截断（几百字符的脚本不许整段进事件日志）', () => {
    const projection = projectDshNotification(
      sessionEvent('tool/call', {
        name: 'pwsh',
        arguments: JSON.stringify({ command: `第一行\n第二行 ${'a'.repeat(300)}` }),
      }),
      newState(),
      CONTEXT,
    );

    const summary = (() => {
      const [draft] = projection.drafts;
      return draft?.type === 'log' ? (draft.summary ?? '') : '';
    })();
    expect(summary).not.toContain('\n');
    expect(summary.endsWith('…')).toBe(true);
    // 前缀 + 上限 + 省略号：多一个字符都说明上限没生效
    expect(summary.length).toBeLessThanOrEqual('调用工具 pwsh：'.length + ACTIVITY_SUMMARY_MAX_LENGTH + 1);
  });

  /**
   * 模型说的话要能在卡片上滚（用户口径：「实时滚动智能体的 event message」，
   * 而且「评分的消息也在这里滚动展示」——评分阶段跑的是同一个适配器，走的就是这条出口）。
   *
   * **不带摘要**（统一口径）：它本身就是人话，`activityOf` 在没有摘要时直接取 `text`；
   * 再配一份截断过的摘要等于同一句话存两份（两处口径还会漂移）。
   */
  it('assistant/message 的文本落成一条日志（过去只进 finalText，整轮不出现在任何地方）', () => {
    const state = newState();
    const projection = projectDshNotification(
      sessionEvent(DSH_ASSISTANT_MESSAGE_TYPE, {
        turn: 1,
        step: 1,
        // 计量给全：缺项时那一条 WARN 也会进 drafts，会把本用例的断言搅成「取到了 WARN」
        usage: { [DSH_USAGE_FIELDS.input]: 10, [DSH_USAGE_FIELDS.cached]: 0, [DSH_USAGE_FIELDS.output]: 2 },
        message: { role: 'assistant', content: [{ type: 'text', text: '我先把\n构建跑起来' }] },
      }),
      state,
      CONTEXT,
    );

    expect(projection.drafts).toHaveLength(1);
    const [draft] = projection.drafts;
    expect(draft?.type === 'log' ? draft.summary : 'x').toBeUndefined();
    expect(draft?.type === 'log' ? draft.text : '').toBe('我先把\n构建跑起来');
    expect(state.finalText).toBe('我先把\n构建跑起来');
  });

  it('没有文本块的 assistant/message 不落空日志（纯工具调用的一轮不产生噪声）', () => {
    const projection = projectDshNotification(
      sessionEvent(DSH_ASSISTANT_MESSAGE_TYPE, {
        turn: 1,
        step: 2,
        // 同上：计量给全，剩下的一条 draft 只可能是那句答复
        usage: { [DSH_USAGE_FIELDS.input]: 10, [DSH_USAGE_FIELDS.cached]: 0, [DSH_USAGE_FIELDS.output]: 2 },
        message: { role: 'assistant', content: [{ type: 'reasoning', text: '' }] },
      }),
      newState(),
      CONTEXT,
    );

    expect(projection.drafts).toHaveLength(0);
  });

  it('turn/start 只落原始负载、**不给摘要**（轮次的落点是卡片上那一格，不是活动行）', () => {
    const projection = projectDshNotification(sessionEvent('turn/start', { turn: 2 }), newState(), CONTEXT);

    const [draft] = projection.drafts;
    expect(draft?.type === 'log' ? draft.summary : 'x').toBeUndefined();
    expect(draft?.type === 'log' ? draft.text : '').toContain('"turn/start"');
  });

  it('tool/result：**只有报错才给摘要**；成功返回不播（结果在结果块与原始输出面板里）', () => {
    const ok = projectDshNotification(
      sessionEvent('tool/result', {
        message: {
          role: 'tool',
          toolCallId: 'call_1',
          content: [{ type: 'text', text: 'started background job pwsh-16' }],
          isError: false,
        },
      }),
      newState(),
      CONTEXT,
    );
    expect(ok.drafts[0]?.type === 'log' ? ok.drafts[0].summary : 'x').toBeUndefined();
    // 证据照旧：原文仍在 text 里
    expect(ok.drafts[0]?.type === 'log' ? ok.drafts[0].text : '').toContain('started background job pwsh-16');

    const bad = projectDshNotification(
      sessionEvent('tool/result', {
        message: { role: 'tool', toolCallId: 'call_2', content: [{ type: 'text', text: 'ENOENT: no such file' }], isError: true },
      }),
      newState(),
      CONTEXT,
    );
    expect(bad.drafts[0]).toMatchObject({ summary: '工具报错：ENOENT: no such file' });
  });
});

/**
 * stream-tap 增量伪事件（`aieval/delta`）：**只产内容消息、事件侧零草稿**。
 *
 * 为什么这一条必须有专门守卫：这是 dsh 唯一一条**自造**的通知类型，
 * 而它的分流一旦写错（落进末尾的未识别 `log` 兜底），一次运行几百上千条增量帧就会把
 * 「原始输出」面板刷成 JSON 流水——那正是这条口径要防的事，且症状（面板卡死）与故障原因
 * （分流写错）在界面上完全对不上。套件的增量隔离判据用条数间接钉它，这里直接钉草稿数组。
 */
describe('projectDshNotification：stream-tap 增量（aieval/delta）', () => {
  /** 一条 tap 伪通知（形状与 `stream-tap.ts` 的 `lineToNotification` 逐字同构） */
  const delta = (kind: 'text' | 'reasoning', text: string, position: number): unknown =>
    // 事件类型**写字面量**（不是 import 常量）：这个名字是适配器自己造、写 sidecar 又读回来的，
    // 钉住字面量才能拦住「改名之后两边对不上」——那时 delta 会静默掉进未识别兜底。
    sessionEvent('aieval/delta', { turn: 1, step: 1, delta: { kind, text, position } });

  it('零事件草稿 + 一条 `chunk: delta` 消息（原始输出面板上一条都不该有）', () => {
    const projection = projectDshNotification(delta('text', '没问题，', 0), newState(), CONTEXT);
    expect(projection.drafts).toEqual([]);
    expect(projection.messages).toHaveLength(1);
    const message = projection.messages?.[0];
    expect(message?.chunk).toBe('delta');
    expect(message?.source).toBe('hook');
    expect(message?.blocks).toEqual([{ phase: 'delta', identity: { kind: 'index', index: 0 }, block: { type: 'text', text: '没问题，' } }]);
  });

  it('`reasoning` 档走思考块（**结果与思考的判别式就是块类型**，不新增信封格）', () => {
    const projection = projectDshNotification(delta('reasoning', '先看配置', 1), newState(), CONTEXT);
    expect(projection.drafts).toEqual([]);
    const block = projection.messages?.[0]?.blocks[0];
    expect(block?.phase === 'delta' ? block.block.type : null).toBe('thinking');
  });
});

/**
 * **通知流中断**伪事件（`aieval/stream-failure`，真机事故的产物）。
 *
 * 为什么必须有这一支：SDK 的订阅失败是**静默**的（兄弟订阅与传输读循环都不受影响，
 * 见 `lib/index.js` 的 `NotificationSubscriptionImpl.push/fail`），把它当成「流正常结束」就会
 * 得到**执行日志整段空白、行照旧判 judged、任何日志里零线索**的真机形状
 * （run `7f05c765` 的 dsh 行：厂商会话日志 201 条事件、我们只收到前 13 条）。
 * 这一支的存在意义只有一个：让「为什么是空的」在界面上有答案——**一条** stderr 的 log。
 */
describe('projectDshNotification：通知流中断（aieval/stream-failure）', () => {
  it('产且只产一条 stderr 的 log，把原因与「断在哪」写出来（不判失败：产物是有效的）', () => {
    const projection = projectDshNotification(
      sessionEvent('aieval/stream-failure', {
        reason: 'TransportClosedError: notification subscription closed',
        receivedNotifications: 13,
      }),
      newState(),
      CONTEXT,
    );
    expect(projection.drafts).toHaveLength(1);
    const draft = projection.drafts[0];
    expect(draft?.type).toBe('log');
    expect(draft?.type === 'log' ? draft.stream : null).toBe('stderr');
    const text = draft?.type === 'log' ? draft.text : '';
    expect(text).toContain('通知流中断');
    expect(text).toContain('TransportClosedError');
    expect(text).toContain('13');
    // 归因**不**落 failure：丢的是过程证据，不是结果（那一轮的 diff 与评分照旧有效）
    expect(projection.failure).toBeNull();
    expect(projection.messages ?? []).toEqual([]);
  });
});
