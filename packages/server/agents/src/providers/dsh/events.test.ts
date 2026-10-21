// @vitest-environment node
/**
 * dsh 的通知投影（按真实探测到的厂商事件形态）。
 * 探测结论（`docs/protocols/dsh.md`）：
 * 通知是 `{ method, params }`，事件全在 `method === 'session.event'` 里；用量在
 * `params.event.type === 'assistant/message'` 的 `params.event.data.usage`；轮次结束与失败在
 * `params.event.type === 'turn/end'`。下面每条用例的构造数据都照真机读数的真实字段名写
 * （产物在 `probe/dumps/v3/` 与 `probe/dumps/v11/`）。
 * 收尾轮补充的去重口径：投影**不自己 draft `usage`**（发射权归骨架那个三家共用的循环内发射口），
 * 但 `takeTurnTokens` 的**取走即归零**必须保留——两条都在下面有用例钉住。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { ACTIVITY_SUMMARY_MAX_LENGTH } from '../../activity';
import type { TurnState } from '../../turn';
import type { DshProjectionRunState } from './events';
import { dshSubagentTurns, dshSubagentUsage } from './message';
import {
  DSH_ASSISTANT_MESSAGE_TYPE,
  DSH_SUBAGENT_FINISHED_METHOD,
  DSH_SUBAGENT_STARTED_METHOD,
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
 * **派发时刻的子任务行能否落进界面的某一轮**。
 *
 * 这一家的派发行在 `subagent.started` 那一刻是**没名没姓**的：任务名在另一条消息（`subagent/catalog`）里，
 * 派发调用 id 厂商压根不给（真机 `subagent.started` 只有两个 sessionId）。而界面按
 * 「`parentCallId` 或 任务名逐字相同」把子任务行挂到派发点上——两条判据都缺时，那条行落不进任何一轮，
 * 整段运行期这个子任务**没有卡片、也没有「进入」入口**（用户可见的形状：子智能体在跑，界面上找不到它）。
 *
 * 于是投影要补两条：父会话 `tool/call` 记下「这次派发在飞」（唯一能同时拿到调用 id 与任务描述的地方），
 * 目录项到达时按任务名认领，并把运行行**再投一条**更完整的（同一身份覆盖累积）。
 */
describe('projectDshNotification：派发行的派发点（目录项晚到 ⇒ 补投一条更完整的）', () => {
  /** 派发工具调用：入参里的 `description` 就是任务名（与目录项 `label` 同源） */
  function dispatchCall(callId: string, description: string, toolName = 'subagent'): unknown {
    return sessionEvent('tool/call', {
      turn: 1,
      step: 1,
      callId,
      name: toolName,
      arguments: JSON.stringify({ description, prompt: '去核实一下' }),
    });
  }
  /** 目录项：`label` = 任务名，`childId` = 子任务身份 */
  function catalogFor(childId: string, label: string): unknown {
    return sessionEvent('subagent/catalog', { version: 0, childId, childCreatedAt: 1, mode: 'one-shot', label });
  }
  const CHILD = 'a5e63152-5662-4986-a190-7849eeac0f0b';
  const started = (childId = CHILD): unknown => ({ method: 'subagent.started', params: { parentSessionId: 'session-1', childSessionId: childId } });
  /** 收场通知（真机形状：身份 / 终态 / 结果都在这一条里） */
  const finished = (childId = CHILD): unknown => ({
    method: 'subagent.finished',
    params: {
      provider: 'spawn',
      agentId: childId,
      parentSessionId: 'session-1',
      childSessionId: childId,
      status: 'ok',
      stopReason: 'completed',
      lastAssistantMessage: [{ type: 'text', text: '3' }],
    },
  });
  /** 带派发记账三格的取数面（生产上由 `index.ts` 每个候选建一份） */
  function newRunState() {
    return {
      childSessions: new Set<string>(),
      finishedSessions: new Set<string>(),
      dispatchStarts: new Map(),
      claimedDispatches: new Map<string, string>(),
      deliveredStarts: new Map<string, string>(),
    };
  }

  it('派发 → 运行行（无名、无派发点）→ 目录项 ⇒ 补投一条带任务名与派发点的 running 行', () => {
    const state = newState();
    const runState = newRunState();
    projectDshNotification(dispatchCall('call_00_a', 'Count lines in notes.txt'), state, CONTEXT, runState);

    const atStart = projectDshNotification(started(), state, CONTEXT, runState);
    expect(atStart.subagents?.[0]).toMatchObject({ subagentId: CHILD, name: null, parentCallId: null, status: 'running' });

    // 目录项到达：任务名与派发点都补上了 ⇒ 再投一条（同一身份覆盖累积）
    const atCatalog = projectDshNotification(catalogFor(CHILD, 'Count lines in notes.txt'), state, CONTEXT, runState);
    expect(atCatalog.drafts).toEqual([]);
    expect(atCatalog.subagents).toHaveLength(1);
    expect(atCatalog.subagents?.[0]).toMatchObject({
      subagentId: CHILD,
      name: 'Count lines in notes.txt',
      kind: 'one-shot',
      parentCallId: 'call_00_a',
      status: 'running',
      outcome: null,
      usage: null,
    });
  });

  it('收尾那条带上同一个派发点（否则覆盖会把派发点抹掉）', () => {
    const state = newState();
    const runState = newRunState();
    projectDshNotification(dispatchCall('call_00_a', 'Count lines in notes.txt'), state, CONTEXT, runState);
    projectDshNotification(started(), state, CONTEXT, runState);
    projectDshNotification(catalogFor(CHILD, 'Count lines in notes.txt'), state, CONTEXT, runState);

    const atFinish = projectDshNotification(finished(), state, CONTEXT, runState);
    expect(atFinish.subagents?.[0]).toMatchObject({ subagentId: CHILD, parentCallId: 'call_00_a', status: 'completed' });
  });

  it('目录项**先到**时：started 那一条自己就带名字与派发点（不重发）', () => {
    const state = newState();
    const runState = newRunState();
    projectDshNotification(dispatchCall('call_00_a', 'Count lines in notes.txt'), state, CONTEXT, runState);
    projectDshNotification(catalogFor(CHILD, 'Count lines in notes.txt'), state, CONTEXT, runState);

    const atStart = projectDshNotification(started(), state, CONTEXT, runState);
    expect(atStart.subagents?.[0]).toMatchObject({ name: 'Count lines in notes.txt', parentCallId: 'call_00_a' });
    // 目录项若因版本递增重发：逐字相同 ⇒ 不带新事实，不重发
    const again = projectDshNotification(catalogFor(CHILD, 'Count lines in notes.txt'), state, CONTEXT, runState);
    expect(again.subagents ?? []).toEqual([]);
  });

  it('`subagent_fork` 同样是派发工具：它那条路也要记账（同一个插件挂的第二个名字）', () => {
    const state = newState();
    const runState = newRunState();
    projectDshNotification(dispatchCall('call_fork_1', '分叉一个子任务', 'subagent_fork'), state, CONTEXT, runState);
    projectDshNotification(started(), state, CONTEXT, runState);

    const atCatalog = projectDshNotification(catalogFor(CHILD, '分叉一个子任务'), state, CONTEXT, runState);
    expect(atCatalog.subagents?.[0]).toMatchObject({
      subagentId: CHILD,
      name: '分叉一个子任务',
      parentCallId: 'call_fork_1',
    });
  });

  it('名单是**枚举**的：`workflow` 那种一次调用派多个子智能体的工具不记账（认领必然撞车）', () => {
    const state = newState();
    const runState = newRunState();
    projectDshNotification(dispatchCall('call_wf_1', '编排一批子任务', 'workflow'), state, CONTEXT, runState);
    projectDshNotification(started(), state, CONTEXT, runState);

    const atCatalog = projectDshNotification(catalogFor(CHILD, '编排一批子任务'), state, CONTEXT, runState);
    expect(atCatalog.subagents?.[0]).toMatchObject({ name: '编排一批子任务', parentCallId: null });
  });

  it('任务名撞车（两条在飞的派发同名）⇒ 不认领派发点，但名字照给（界面退回「任务名逐字相同」那条判据）', () => {
    const state = newState();
    const runState = newRunState();
    projectDshNotification(dispatchCall('call_00_a', '同名任务'), state, CONTEXT, runState);
    projectDshNotification(dispatchCall('call_00_b', '同名任务'), state, CONTEXT, runState);
    projectDshNotification(started(), state, CONTEXT, runState);

    const atCatalog = projectDshNotification(catalogFor(CHILD, '同名任务'), state, CONTEXT, runState);
    expect(atCatalog.subagents?.[0]).toMatchObject({ name: '同名任务', parentCallId: null });
  });

  it('子会话自己再派子智能体不进这个候选的记账（嵌套派发不参与认领）', () => {
    const state = newState();
    const runState = newRunState();
    projectDshNotification(started(), state, CONTEXT, runState);
    // 生产上「这个 id 是子会话」由通知流的过滤器登记（`index.ts` 的 `noteChildSession`，
    // 它在投影之前跑）⇒ 这里照样补上，否则测的是「没有白名单时会不会误记」
    runState.childSessions.add(CHILD);
    const nested = sessionEvent(
      'tool/call',
      { turn: 1, step: 1, callId: 'call_00_nested', name: 'subagent', arguments: JSON.stringify({ description: '嵌套任务' }) },
      CHILD,
    );
    projectDshNotification(nested, state, CONTEXT, runState);
    expect(runState.dispatchStarts.size).toBe(0);
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
   * 与 cc 同待遇：那边非文本块走 `others` 分支落一条原始负载日志
   * （`providers/cc/events.ts` 的 `assistantDrafts`），所以两家的推理在抽屉里都看得到。
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

  it('实测确认：assistant/message 的用量被提取并记进**候选累计**，并当场交出去（字段名逐字来自探测 dump）', () => {
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

  /**
   * 缓存两格缺席 ⇒ **按 0 计**，不是「整条作废」。
   *
   * 判据是厂商自己的写入口径（`@deepseek-ai/dsh-llm-pi-ai` 的 `mapUsage`）：
   * `...usage.cacheRead > 0 ? { cacheReadTokens } : {}` —— **大于 0 才写**，所以字段缺席在语义上
   * 就是 0（冷缓存的首条请求正是这个形状：`{inputTokens:12601, outputTokens:434, totalTokens:13035}`）。
   * 曾经的读法是「三项缺一即 null」，代价是那一条里的 input / output 一起消失——真机上单条
   * 差 65% 的非缓存输入，而 WARN 文案说「本次运行按未采集计量处理」，与同一行照旧上报的数打架。
   */
  it('缓存两格缺席（厂商 > 0 才写）⇒ 按 0 计，同一条的 input / output 照常累计', () => {
    const state = newState();
    const projection = projectDshNotification(
      sessionEvent(DSH_ASSISTANT_MESSAGE_TYPE, {
        turn: 1,
        step: 1,
        // 真机冷缓存首条：没有 cacheReadTokens，恒等式 13035 = 12601 + 434 成立
        usage: { [DSH_USAGE_FIELDS.input]: 12601, [DSH_USAGE_FIELDS.output]: 434, [DSH_USAGE_FIELDS.total]: 13035 },
      }),
      state,
      CONTEXT,
    );
    expect(projection.tokens).toEqual({
      input: 12601,
      cached: 0,
      output: 434,
      reasoningOutput: null,
      total: 13035,
    });
    expect(state.usageInput).toBe(12601);
    // 没有警告：这是正常形状，不是「读不动」
    expect(projection.drafts.filter((draft) => draft.type === 'log')).toHaveLength(0);
  });

  /**
   * 两格必在（`inputTokens` / `outputTokens` 无条件写）⇒ 读不到才是「读不动」：
   * 那一条按未采到处置并落 WARN，措辞要说得清「丢的是这一条、不是整行」。
   */
  it('缺 inputTokens / outputTokens ⇒ 这一条按未采到处置 + WARN（措辞不再说「本次运行」）', () => {
    const projection = projectDshNotification(
      sessionEvent(DSH_ASSISTANT_MESSAGE_TYPE, {
        usage: { [DSH_USAGE_FIELDS.cached]: 347 },
      }),
      newState(),
      CONTEXT,
    );
    expect(projection.tokens).toBeNull();
    const warns = projection.drafts.flatMap((draft) => (draft.type === 'log' ? [draft.text] : []));
    expect(warns.some((text) => text.includes('缺 inputTokens / outputTokens'))).toBe(true);
    expect(warns.some((text) => text.includes('这一条'))).toBe(true);
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

  /**
   * `totalTokens` 与三格**同族**（都是「这一条读数自己」的量）⇒ 一律相加。
   *
   * 判据两条：① 厂商源码里 `mapUsage` 直传 pi-ai 的 `usage.totalTokens`，而那一格来自**该次响应**；
   * ② 真机四条 `assistant/message` 的恒等式逐条成立（`10058+384+110 = 10552`、…、`8613+13312+604 = 22529`），
   * 而四条之和是 57447。按「覆盖」读会把这个候选记成最后一步的 22529——比同一个对象里求和出来的
   * `cached: 34688` 还小，任何并排对照都会得出「我们读错了字段」。
   */
  it('usage.total 与三格同族 ⇒ 逐条相加（真机四条读数）', () => {
    const state = newState();
    // 真机读数（runs/93e6186f… 的 dsh 行）：每条都满足自己的恒等式
    const steps = [
      { input: 10058, cached: 384, output: 110, total: 10552 },
      { input: 377, cached: 10368, output: 184, total: 10929 },
      { input: 2680, cached: 10624, output: 133, total: 13437 },
      { input: 8613, cached: 13312, output: 604, total: 22529 },
    ];
    for (const [index, one] of steps.entries()) {
      projectDshNotification(
        sessionEvent(DSH_ASSISTANT_MESSAGE_TYPE, {
          turn: 1,
          step: index + 1,
          usage: {
            [DSH_USAGE_FIELDS.input]: one.input,
            [DSH_USAGE_FIELDS.cached]: one.cached,
            [DSH_USAGE_FIELDS.output]: one.output,
            [DSH_USAGE_FIELDS.total]: one.total,
          },
        }),
        state,
        CONTEXT,
      );
    }
    const projection = projectDshNotification(
      sessionEvent(DSH_TURN_END_TYPE, { turn: 1, reason: { kind: 'completed' } }),
      state,
      CONTEXT,
    );
    expect(projection.tokens).toEqual({
      input: 21728,
      cached: 34688,
      output: 1031,
      reasoningOutput: null,
      total: 57447,
    });
    // 恒等式在**合计**上同样成立（分量含缓存写那一格，这一份读数里缓存写缺席 = 0）
    const tokens = projection.tokens;
    expect(tokens?.total).toBe((tokens?.input ?? 0) + (tokens?.cached ?? 0) + (tokens?.output ?? 0));
  });

  /**
   * 恒等式不成立 ⇒ 总量按「没采到」处置（`null`）+ WARN，分量照常累计。
   * 判据：宁可说不出总量，也不给一个自己都解释不了的数。
   */
  it('厂商自报总量与分量之和不一致 ⇒ total 置 null + WARN，分量不受影响', () => {
    const state = newState();
    const projection = projectDshNotification(
      sessionEvent(DSH_ASSISTANT_MESSAGE_TYPE, {
        turn: 1,
        step: 1,
        // 分量之和 226（含缓存写 4），厂商却说 999
        usage: {
          [DSH_USAGE_FIELDS.input]: 10,
          [DSH_USAGE_FIELDS.cached]: 200,
          [DSH_USAGE_FIELDS.output]: 12,
          [DSH_USAGE_FIELDS.cacheWrite]: 4,
          [DSH_USAGE_FIELDS.total]: 999,
        },
      }),
      state,
      CONTEXT,
    );
    expect(projection.tokens).toEqual({
      input: 10,
      cached: 200,
      output: 12,
      reasoningOutput: null,
      total: null,
    });
    expect(
      projection.drafts.some((draft) => draft.type === 'log' && draft.text.includes('厂商自报总量与分量之和不一致')),
    ).toBe(true);
  });

  it('恒等式把缓存写那一格算进去（分量 = input + cached + cacheWrite + output）', () => {
    const projection = projectDshNotification(
      sessionEvent(DSH_ASSISTANT_MESSAGE_TYPE, {
        turn: 1,
        step: 1,
        // 不计缓存写会误判成「不一致」：1219 + 7040 + 1 = 8260 - 0 ⇒ 这里故意给非零缓存写
        usage: {
          [DSH_USAGE_FIELDS.input]: 1219,
          [DSH_USAGE_FIELDS.cached]: 7040,
          [DSH_USAGE_FIELDS.cacheWrite]: 300,
          [DSH_USAGE_FIELDS.output]: 1,
          [DSH_USAGE_FIELDS.total]: 8560,
        },
      }),
      newState(),
      CONTEXT,
    );
    expect(projection.tokens?.total).toBe(8560);
    expect(projection.drafts.filter((draft) => draft.type === 'log')).toHaveLength(0);
  });

  it('非 error 的 turn/end 原因（aborted 等）不算失败', () => {
    const state = newState();
    projectDshNotification(sessionEvent('step/start', { turn: 1, step: 1 }), state, CONTEXT);
    const projection = projectDshNotification(
      // 真机形状：`aborted.reason` 是对象 `{kind:'user'}`（厂商 `TurnEndReasonMap`），不是字符串
      sessionEvent(DSH_TURN_END_TYPE, { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } }),
      state,
      CONTEXT,
    );
    expect(projection.failure).toBeNull();
    expect(projection.turns).toBe(1);
  });

  /**
   * `session.status`（真机每个候选两条：`running` / `idle`）是**已识别且有意不投影**的一格 ⇒
   * 零草稿。曾经的实现让它落进 `unknown` 兜底，于是每个候选多两条原始 JSON 日志，
   * 界面「未识别的厂商载荷」汇总里混着与轮次、内容、失败都无关的厂商状态。
   */
  it('已识别但有意不投影的通知（session.status）不产任何草稿', () => {
    const running = projectDshNotification(
      { method: 'session.status', params: { sessionId: 'session-1', status: 'running' } },
      newState(),
      CONTEXT,
    );
    const idle = projectDshNotification(
      { method: 'session.status', params: { sessionId: 'session-1', status: 'idle' } },
      newState(),
      CONTEXT,
    );
    expect([...running.drafts, ...idle.drafts]).toEqual([]);
    expect(running.turns).toBeNull();
  });

  /**
   * 真机**每个候选必现**的一批厂商事件（本轮真机通知直方图逐条核过）⇒ 显式登记成「已识别、零草稿」，
   * 不再走 `unknown` 兜底。判据：它们既不携带轮次、也不携带用量或失败，落成原始 JSON 只是噪声——
   * 而噪声的代价是「真正未识别的类型」被埋在几百条 JSON 里（`session/title` 那条正是被埋的一格）。
   */
  it('真机必现的九种事件不再落 unknown 兜底（其中 session/title 落一条人话日志）', () => {
    const quiet = [
      'turn/start',
      'permission/preset',
      'sandbox/mode',
      'approval/policy',
      'agent/inbox/spliced',
      'request/context',
      'step/end',
      'system/message',
      'llm/retry-started',
      'subagent/descriptor',
    ];
    for (const type of quiet) {
      const projection = projectDshNotification(
        sessionEvent(type, { anything: 'x' }, 'session-1'),
        newState(),
        CONTEXT,
      );
      expect(projection.drafts, type).toEqual([]);
    }
    // session/title 是**有信息量**的一格（会话标题），落一条 log 而不是原始 JSON 的兜底
    const title = projectDshNotification(
      sessionEvent('session/title', { title: '用 subagent 工具派一个子智能体', messageSeqs: [8] }),
      newState(),
      CONTEXT,
    );
    expect(title.drafts).toHaveLength(1);
    expect(title.drafts[0]?.type === 'log' && title.drafts[0].text).toBe('用 subagent 工具派一个子智能体');
  });

  /**
   * `subagent/descriptor` 的**真实身份**：它不产草稿（投影拿不出子任务记录），
   * 但它的信封 `params.sessionId` 是子会话白名单的来源之一——真机上 `subagent` 工具派发时
   * 只投这一条、**没有** `subagent.started`。
   *
   * ⚠️ 登记发生在**过滤器**那一层（`index.ts` 的 `noteChildSession` 读 `childSessionIdentities`），
   * 不是投影：投影只回答「这条要不要产事件」。过滤器那一侧在 `index.test.ts` 里有守卫。
   */
  it('subagent/descriptor 不产草稿（子会话身份由过滤器那一层登记）', () => {
    const projection = projectDshNotification(
      sessionEvent('subagent/descriptor', { version: 3, mode: 'one-shot', provider: 'spawn', label: '读文件' }, 'child-1'),
      newState(),
      CONTEXT,
    );
    expect(projection.drafts).toEqual([]);
    expect(projection.tokens).toBeNull();
  });
});

/**
 * 消息级用量。三条判据：
 *   · wire 上的 `data.usage` **逐字**进这条消息的 `usage`（不是累计快照、不是候选级 tokens）；
 *   · 三项缺一 ⇒ 消息级与候选级**同时**是「未采集」（都不填 0）；
 *   · 子会话的消息同样带它自己的用量（与主会话共用同一个归一函数）。
 */
/**
 * `assistant/message` 的**块序**（内容快照）与 stream-tap 增量的**位次空间**必须对齐：
 * 快照里 text/reasoning 块的序号是它在 `content[]` 里的**内容位次**，而 tap 的
 * `positionOf` 按「该次尝试里块的首见顺序」发号（工具调用块**也占号**）⇒ 两者只有在
 * 工具调用块**真的被投影出来**时才落在同一个槽位。
 *
 * 真机形状（本次审计的现场，`basic-1792169692459` 的 seq 14）：块序是
 * `["text","tool-call","text"]`，工具调用块的字段是 **`id`**（`ToolCallBlock{type,id,name,arguments}`），
 * 只有 `tool/call` 那条**事件**的 `data` 里才叫 `callId`。读错字段名的后果有两层：
 * 块从快照里消失（紧随的 `tool/call` 只补内容、补不回位次），以及**同一段文本渲染两次**
 * （增量落 `index:2`、快照落 `index:1`，两个载体各自渲染一次）。
 */
describe('assistant/message 的内容快照：工具调用块与块位次', () => {
  it('工具调用块按 `id` 读出来（真机字段名），且它占住内容位次 ⇒ 其后的文本块序号与增量一致', () => {
    const projection = projectDshNotification(
      sessionEvent(DSH_ASSISTANT_MESSAGE_TYPE, {
        turn: 1,
        step: 1,
        message: {
          id: 'msg-1',
          role: 'assistant',
          content: [
            { type: 'text', text: '\n\n' },
            { type: 'tool-call', id: 'call_ba1f832657b14e85ade228d3', name: 'bash', arguments: '{"command":"wc -l hello.txt"}' },
            { type: 'text', text: '\n' },
          ],
        },
      }),
      newState(),
      CONTEXT,
    );

    const blocks = projection.messages?.[0]?.blocks ?? [];
    expect(blocks.map((one) => one.block.type)).toEqual(['text', 'tool-call', 'text']);
    // 位次是**内容位次**（含工具调用块）：0 / 调用身份 / 2
    expect(blocks.map((one) => one.identity)).toEqual([
      { kind: 'index', index: 0 },
      { kind: 'call', callId: 'call_ba1f832657b14e85ade228d3' },
      { kind: 'index', index: 2 },
    ]);
  });

  it('`tool/call` 事件那条通道仍读 `callId`（两条通道的字段名不同，不许互相顶替）', () => {
    const projection = projectDshNotification(
      sessionEvent('tool/call', {
        turn: 1,
        step: 1,
        callId: 'call_13f80cd1a2d84a379b1dc3e4',
        name: 'bash',
        arguments: '{"command":"wc -l hello.txt"}',
      }),
      newState(),
      CONTEXT,
    );

    expect(projection.messages?.[0]?.blocks[0]?.identity).toEqual({ kind: 'call', callId: 'call_13f80cd1a2d84a379b1dc3e4' });
  });
});

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

  it('缓存读缺席 ⇒ 消息级按 0 计（与候选级同一份读数）；input / output 缺失才是「未采到」', () => {
    const state = newState();
    const projection = projectDshNotification(
      sessionEvent(DSH_ASSISTANT_MESSAGE_TYPE, {
        turn: 1,
        step: 1,
        // 真机冷缓存首条：没有 cacheReadTokens（厂商 > 0 才写）⇒ 按 0，不是整条作废
        usage: { [DSH_USAGE_FIELDS.input]: 12601, [DSH_USAGE_FIELDS.output]: 434, [DSH_USAGE_FIELDS.total]: 13035 },
        message: { role: 'assistant', content: [{ type: 'text', text: '好' }] },
      }),
      state,
      CONTEXT,
    );

    expect(projection.messages?.[0]?.usage).toEqual({
      input: 12601,
      cached: 0,
      output: 434,
      reasoningOutput: null,
      total: 13035,
    });
    expect(projection.tokens?.input).toBe(12601);
  });

  it('子会话的消息同样带它自己的用量', () => {
    // 先按真机外形登记子会话（`dshSubagentIdOf` 只认登记过的 id）
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
 * **消息级用量与候选级累计并存且互不影响**。
 * 两条口径同源于同一条 wire 负载，但一个是「这一次调用」、一个是「到目前为止」——
 * 改动最容易在这里出静默的错：拿累计当消息级（页脚数字越滚越大）或反过来（卡片少报）。
 */
describe('消息级与候选级两条口径并存', () => {
  it('同一条通知喂两处：消息级各是各的，候选级是两次之和', () => {
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
    // 候选级：两次之和（既有口径一个字不动）
    expect(second.tokens).toEqual({ input: 505, cached: 15872, output: 1403, reasoningOutput: null, total: null });
  });
});

/**
 * 归属与**每会话自己的**轮次号（spec
 * `docs/protocols/message-spec.md`「轮次归属」）。
 *
 * 口径：消息的 `roundTrip` 与 `usage.turn.round` 是**同一个数**，都由 `message.ts` 的
 * `dshTurnAttribution` 算出来——**按会话单调编号**（会话计数是权威、厂商的 `step` 只用来补缺口，
 * 因为 `step` 是「每个 turn 内从 1 数」），不带 `step` 的出口（`turn/end`、tap 增量）退回**该会话**
 * 当前往返号，一次都没见过的会话给 `null`（**不拿候选累计号顶替**）。合计（`turns` / `tokens`）
 * 仍是全树口径，与这两格不是一回事。
 */
describe('projectDshNotification：归属（每会话自己的 step）', () => {
  /**
   * 子会话身份的**唯一登记口**是顶层 `subagent.started`（`message.ts` 的 `dshSubagentRecord`）：
   * 不喂它的话 `dshSubagentIdOf` 认不出 `child-1`，归属会退回主会话（`subagentId: null`）
   * ——而「子会话的 step 归到它自己名下」这条判据就白钉了。
   */
  const CHILD_STARTED = { method: 'subagent.started', params: { subagentId: 'child-1', parentSessionId: 'session-1' } };

  /**
   * 每会话自己的往返号（与厂商给的 `step` 不是一回事：`step` 每个 turn 内从 1 数）。
   * 消息的 `roundTrip` 与 `usage.turn.round` 都用它。
   * 用 `state.turns`（候选全局计数）⇒ 主会话第二条读到的是**别人**的数——**1**
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
    // 子会话插一条（候选累计轮次照样 +1：`state.turns` 是**全树**口径，见下一条用例）
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

  /**
   * **真机形状：厂商的 `step` 是「每个 turn 内从 1 数」**（同一会话两段：`turn=1 step=1,2` 与
   * `turn=2 step=1,2`，会话日志与原始通知两处都是这个形状）。
   *
   * 缺陷形状：直接拿 `step` 当往返号 ⇒ 第二段的读数与第一段**撞号**（都是 1、2），而**不带 step
   * 的出口**（stream-tap 增量、`turn/end`）走的是会话计数（3、4）⇒ 同一条逻辑消息的增量与快照
   * 落进两个载体：界面上同一段答复出现两次、第一段那条被覆盖掉。
   * 口径：会话计数是权威，`step` 只用来补缺口（见 `dshTurnAttribution`）。
   */
  it('跨 turn 不撞号：两段各两步 ⇒ 往返号 1/2/3/4，且不带 step 的出口与最后一步同号', () => {
    const state = newState();
    const rounds: number[] = [];
    const feed = (turn: number, step: number): void => {
      projectDshNotification(sessionEvent('step/start', { turn, step }), state, CONTEXT);
      const message = projectDshNotification(
        sessionEvent(DSH_ASSISTANT_MESSAGE_TYPE, {
          turn,
          step,
          message: { content: [{ type: 'text', text: `t${turn}s${step}` }] },
        }),
        state,
        CONTEXT,
      );
      rounds.push(message.messages?.[0]?.roundTrip ?? -1);
    };
    feed(1, 1);
    feed(1, 2);
    const endOfTurn1 = projectDshNotification(sessionEvent(DSH_TURN_END_TYPE, { turn: 1, reason: { kind: 'completed' } }), state, CONTEXT);
    feed(2, 1);
    feed(2, 2);
    const endOfTurn2 = projectDshNotification(sessionEvent(DSH_TURN_END_TYPE, { turn: 2, reason: { kind: 'completed' } }), state, CONTEXT);

    expect(rounds).toEqual([1, 2, 3, 4]);
    expect(endOfTurn1.turn).toEqual({ subagentId: null, round: 2 });
    expect(endOfTurn2.turn).toEqual({ subagentId: null, round: 4 });
  });

  it('漏了一条 step/start 也不撞号：`step` 把缺口补进会话计数（真机形状：子会话的前几条事件厂商不投）', () => {
    const state = newState();
    // 子会话的第一步：`step/start` 没到（真机上它属于厂商不投的那几条），只有消息
    projectDshNotification(CHILD_STARTED, state, CONTEXT);
    const first = projectDshNotification(
      sessionEvent(DSH_ASSISTANT_MESSAGE_TYPE, { turn: 1, step: 1, message: { content: [{ type: 'text', text: '一' }] } }, 'child-1'),
      state,
      CONTEXT,
    );
    expect(first.messages?.[0]?.roundTrip).toBe(1);
    // 第二步的 `step/start` 到了 ⇒ 计数为 1，消息按 step=2 补缺口 ⇒ 2（不是又一条 1）
    projectDshNotification(sessionEvent('step/start', { turn: 1, step: 2 }, 'child-1'), state, CONTEXT);
    const second = projectDshNotification(
      sessionEvent(DSH_ASSISTANT_MESSAGE_TYPE, { turn: 1, step: 2, message: { content: [{ type: 'text', text: '二' }] } }, 'child-1'),
      state,
      CONTEXT,
    );
    expect(second.messages?.[0]?.roundTrip).toBe(2);
  });

  /**
   * **子会话的失败不是候选的失败**（真机读数：只把子会话打挂（注入 400）、父会话正常答完，
   * 整行却是 `ok:false / exitReason:'error'`，错误文案与 stack 全是**子会话**那一句）。
   *
   * 口径与 `finalText` 那道会话闸**完全同源**：`assistant/message` 那一支有
   * `dshSubagentIdOf(sessionId) === null` 的闸，`turn/end` 的 `failure` 那一支原来没有 ⇒
   * 一次成功的运行被判失败（不评分、还可能被自动重试），而界面上看到的错误与父会话的产出无关。
   * 子会话那一笔**照旧留证据**：`error` 草稿进事件日志，子任务行的终态走
   * `subagent.finished{status,stopReason}` 那条通道。
   */
  it('子会话的 `turn/end(kind:error)` 只留证据、不判整候选失败；主会话的同样失败照旧判失败', () => {
    const state = newState();
    projectDshNotification(CHILD_STARTED, state, CONTEXT);
    const child = projectDshNotification(
      sessionEvent(
        DSH_TURN_END_TYPE,
        { turn: 1, reason: { kind: 'error', error: { message: 'child hit a 400', code: 'INVALID_REQUEST' } } },
        'child-1',
      ),
      state,
      CONTEXT,
    );
    // 证据照留（一条 error 草稿，带厂商原文）
    expect(child.drafts.some((draft) => draft.type === 'error' && draft.message.includes('child hit a 400'))).toBe(true);
    // 但不改候选结论
    expect(child.failure).toBeNull();

    // 主会话的失败照旧判失败（同一支分支、同一份判据，两个方向都要钉）
    const main = projectDshNotification(
      sessionEvent(DSH_TURN_END_TYPE, { turn: 1, reason: { kind: 'error', error: { message: 'main hit a 500' } } }),
      newState(),
      CONTEXT,
    );
    expect(main.failure?.code).toBe('AGENT_FAILED');
  });

  /**
   * **`usage` 键缺席是厂商允许的形状**（真机：被 `interrupt_agent` 打断在流中间的那条
   * `assistant/message` 只有 `{interrupted:true, message}`、没有 `usage`）⇒ 不读、也不落 WARN。
   * 无条件读会把「厂商没报」说成「我们读不动」，文案里还带着字面量 `undefined`。
   * 键在、形状不对（缺 `inputTokens` / `outputTokens`）才是真问题 ⇒ 那一条照旧 WARN。
   */
  it('`assistant/message` 缺 usage 键 ⇒ 不落 WARN；键在而形状不对 ⇒ 照旧 WARN', () => {
    const absent = projectDshNotification(
      sessionEvent(DSH_ASSISTANT_MESSAGE_TYPE, {
        turn: 1,
        step: 1,
        interrupted: true,
        message: { content: [{ type: 'text', text: '半截' }] },
      }),
      newState(),
      CONTEXT,
    );
    expect(absent.drafts.filter((draft) => draft.type === 'log' && draft.text.includes('[WARN]'))).toHaveLength(0);

    const malformed = projectDshNotification(
      sessionEvent(DSH_ASSISTANT_MESSAGE_TYPE, {
        turn: 1,
        step: 1,
        usage: { outputTokens: 3 },
        message: { content: [{ type: 'text', text: '好' }] },
      }),
      newState(),
      CONTEXT,
    );
    expect(
      malformed.drafts.some((draft) => draft.type === 'log' && draft.text.includes('用量负载读不动')),
    ).toBe(true);
  });

  /**
   * **乱序 / 重复 / 迟到**：往返号必须「同一个 `(turn, step)` 永远同一个号、不同组合不同号」。
   *
   * 三种形状都来自对抗性复核（受控探针，真机暂未观测到乱序）：
   *   · 同一条读数被投影两次（重复投送 / 快照与增量各走一遍）；
   *   · 某一步的 `step/start` 迟到（先到的是它的消息）；
   *   · 缺口后的真 `step/start` 又到（子会话前几条事件厂商不投，随后又被补投）。
   * 任何按算术推出来的号（`count - 本turn步数 + step`）都会在这些形状下回退或撞号——那会让同一条
   * 逻辑消息的增量与快照落进两个载体，正是往返号这一格要消灭的形状。
   */
  /**
   * **终止路径的「事实缺失」档**（R6-A 的真机读数）：`signal` 已 abort 时子会话不会被等，
   * 也就不可能再有读数 —— 分量必须按「缺失」交 `null`（判据 `subagentsUnsettled`），
   * 不能按「还在跑、以后会报」交 `{0,0,0}` + `turns`。这一格是纯函数判据，直接钉在取数面上。
   */
  it('`subagentsUnsettled` ⇒ 分量两格都交 null（终止 / 等不到那一档）', () => {
    // **直接传字面量**（不是先赋给变量再传）：这一格必须写在两个函数的签名上——漏了它，
    // excess property check 会让下面这两行**编译不过**，而运行期它一直是生效的（调用方传的
    // 就是 `DshRunState` 那个对象）⇒ 漏声明的真实后果是「展开成新字面量」的重构静默丢掉这一档
    // （`null` 被说成 `{0,0,0}`：没采到变成了确实没有）。
    expect(dshSubagentUsage({
      childSessions: new Set(['child-x']),
      finishedSessions: new Set<string>(),
      subagentsUnsettled: true,
    })).toBeNull();
    expect(dshSubagentTurns({
      childSessions: new Set(['child-x']),
      finishedSessions: new Set<string>(),
      subagentsUnsettled: true,
    })).toBeNull();
    // 没有这个标记时仍是「还在跑 ⇒ 按 0 计（它还会报）」
    expect(dshSubagentUsage({ childSessions: new Set(['child-x']), finishedSessions: new Set<string>() })).toEqual({
      input: 0,
      cached: 0,
      output: 0,
      reasoningOutput: null,
      total: null,
    });
  });

  /**
   * R6-B 的两档「编造事实」（受控读数，载荷都取自厂商通知的真实形状）：
   *   · `turn/end{reason:{kind:'error'}}` **没带 error 格** ⇒ 旧实现把 `safeStringify(undefined)` 当原因
   *     交出去，界面上是一句「原因：undefined」（`error:null` 那档是「null」）；
   *   · `usage` 里的**负数**照收 ⇒ 卡片显示负 token、累计倒退，而子会话分量那一侧被 `Math.max(0,…)`
   *     夹掉 ⇒ 合计说 -5、分量说「没报」，两句话互相拆台。负数按「读不动」处置，与缺项同档。
   */
  /**
   * **`reason` 在场却读不出 `kind`**（形状漂移：字符串 / 缺 `kind`）⇒ 必须留痕（R6-B 的 F6）：
   * 不留的话这一档与「正常 completed」在投影里不可分——零草稿、零 WARN、行判成功。
   */
  it('`turn/end` 的收场原因读不出 ⇒ 落一条 WARN（不改写结论）', () => {
    const state = newState();
    const odd = projectDshNotification(sessionEvent(DSH_TURN_END_TYPE, { turn: 1, reason: 'completed' }), state, CONTEXT);
    expect(odd.drafts.some((draft) => draft.type === 'log' && draft.text.includes('收场原因读不出'))).toBe(true);
    // 正常的 completed **不许**落这条
    const normal = projectDshNotification(
      sessionEvent(DSH_TURN_END_TYPE, { turn: 1, reason: { kind: 'completed' } }),
      newState(),
      CONTEXT,
    );
    expect(normal.drafts.some((draft) => draft.type === 'log' && draft.text.includes('收场原因读不出'))).toBe(false);
  });

  /**
   * **可选格在场却读不动 ⇒ 落 WARN**（R6-B 的 F3）：`cacheReadTokens: "5"` / `NaN` 这类形状原先
   * 被静默当 0（缓存命中率少算、零痕迹），而必填两格同款坏法会 WARN + 整条跳过——两侧不对称。
   * 这一条仍然照常累计（缓存那几格按 0 是厂商写入口径），但「读不动」与「确实是 0」要分得开。
   */
  it('可选用量格在场却读不动 ⇒ 落一条 WARN（累计照旧）', () => {
    const bad = projectDshNotification(
      sessionEvent(DSH_ASSISTANT_MESSAGE_TYPE, {
        turn: 1,
        step: 1,
        usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: '5' },
        message: { content: [{ type: 'text', text: '好' }] },
      }),
      newState(),
      CONTEXT,
    );
    expect(bad.drafts.some((draft) => draft.type === 'log' && draft.text.includes('在场但读不动'))).toBe(true);
    expect(bad.tokens).toMatchObject({ input: 10, output: 2, cached: 0 });

    // 真正缺席（口径就是 0）**不许**落这条
    const absent = projectDshNotification(
      sessionEvent(DSH_ASSISTANT_MESSAGE_TYPE, {
        turn: 1,
        step: 1,
        usage: { inputTokens: 10, outputTokens: 2 },
        message: { content: [{ type: 'text', text: '好' }] },
      }),
      newState(),
      CONTEXT,
    );
    expect(absent.drafts.some((draft) => draft.type === 'log' && draft.text.includes('在场但读不动'))).toBe(false);
  });

  it('畸形负载不许编造事实：缺 error 格说清缺席；负数用量按「读不动」处置', () => {
    const state = newState();
    const failure = projectDshNotification(
      sessionEvent(DSH_TURN_END_TYPE, { turn: 1, reason: { kind: 'error' } }),
      state,
      CONTEXT,
    );
    expect(failure.failure?.message).not.toContain('undefined');
    expect(failure.failure?.message).toContain('没带原因');

    // 负数用量：整条不采（tokens 不带值），并落一条「读不动」的 WARN
    const negative = projectDshNotification(
      sessionEvent(DSH_ASSISTANT_MESSAGE_TYPE, {
        turn: 1,
        step: 1,
        usage: { inputTokens: -5, outputTokens: -3, cacheReadTokens: -1 },
        message: { content: [{ type: 'text', text: '好' }] },
      }),
      newState(),
      CONTEXT,
    );
    expect(negative.tokens).toBeNull();
    expect(
      negative.drafts.some((draft) => draft.type === 'log' && draft.text.includes('用量负载读不动')),
    ).toBe(true);
  });

  it('乱序/重复/迟到：同一个 `(turn, step)` 拿回同一个号，不同组合不撞号', () => {
    const state = newState();
    const roundOf = (turn: number, step: number): number => {
      const projected = projectDshNotification(
        sessionEvent(DSH_ASSISTANT_MESSAGE_TYPE, { turn, step, message: { content: [{ type: 'text', text: `t${turn}s${step}` }] } }),
        state,
        CONTEXT,
      );
      return projected.messages?.[0]?.roundTrip ?? -1;
    };
    // ① 正常顺序：1/2/3/4
    expect([roundOf(1, 1), roundOf(1, 2), roundOf(2, 1), roundOf(2, 2)]).toEqual([1, 2, 3, 4]);
    // ② 重复投影同一条读数 ⇒ 同一个号（幂等），且不推进「最后一次往返」
    expect(roundOf(2, 1)).toBe(3);
    const afterRepeat = projectDshNotification(
      sessionEvent(DSH_TURN_END_TYPE, { turn: 2, reason: { kind: 'completed' } }),
      state,
      CONTEXT,
    );
    expect(afterRepeat.turn).toEqual({ subagentId: null, round: 4 });
    // ③ 迟到：先到 step 2 的消息（新组合 ⇒ 新号），随后 step 1 的 step/start + 消息（仍是新组合）
    const lateState = newState();
    const lateOf = (turn: number, step: number, withStart: boolean): number => {
      if (withStart) projectDshNotification(sessionEvent('step/start', { turn, step }, undefined), lateState, CONTEXT);
      const projected = projectDshNotification(
        sessionEvent(DSH_ASSISTANT_MESSAGE_TYPE, { turn, step, message: { content: [{ type: 'text', text: `t${turn}s${step}` }] } }),
        lateState,
        CONTEXT,
      );
      return projected.messages?.[0]?.roundTrip ?? -1;
    };
    const first = lateOf(1, 1, false);
    const late = lateOf(1, 2, false);
    expect([first, late]).toEqual([1, 2]);
    // 迟到的 `step/start` + 重投影：两处都回到**同一个**号（不产生第三个数）
    expect(lateOf(1, 2, false)).toBe(late);
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
    // `turn/end` 的载荷里没有 step ⇒ 退回**该会话**最后一个 step（不是候选累计号）
    const end = projectDshNotification(sessionEvent(DSH_TURN_END_TYPE, { turn: 1, reason: { kind: 'completed' } }, 'child-1'), state, CONTEXT);
    expect(end.turn).toEqual({ subagentId: 'child-1', round: 1 });
    // 一次 step 都没见过的会话 ⇒ 没有归属（不拿候选累计号顶替）
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

  /**
   * `turn/start` 零草稿：轮次的落点是卡片上那一格（`usage` 事件的 `turns`），不是活动行，
   * 更不是一条原始 JSON——真机每轮都投一条，落成日志只会把原始输出面板刷成 JSON 流水。
   */
  it('turn/start 零草稿（轮次由 usage 事件承载，不进活动行、也不进原始输出）', () => {
    const projection = projectDshNotification(sessionEvent('turn/start', { turn: 2 }), newState(), CONTEXT);

    expect(projection.drafts).toEqual([]);
    expect(projection.turns).toBeNull();
  });

  /**
   * `assistant/attempt` = **一次没落成 `assistant/message` 的模型尝试**（厂商 `agent-loop`
   * 对一次尝试只写两者之一）。它的用量在 `data.stream[]` 的最后一条 `usage` chunk 上，
   * 而漏读它是一次**静默少算**：真机上被重试掉的那次尝试带着真实用量
   * （`{inputTokens:374, outputTokens:102, cacheReadTokens:5888}`），厂商自己的 token meter
   * 算进本轮合计，我们不算 ⇒ 一次带重试的运行 total 少 24%、且没有任何 WARN。
   *
   * 载荷逐字取自真机（该次运行的 `assistant/attempt`：`stream[]` 里
   * `{type:'chunk', chunk:{type:'usage', usage:{…}}}` 排在最后，`finish` 是 `kind:'error'`）。
   */
  it('assistant/attempt 的用量进行的累计（重试掉的失败尝试不再静默少算）', () => {
    const state = newState();
    const projection = projectDshNotification(
      sessionEvent('assistant/attempt', {
        turn: 1,
        step: 1,
        stream: [
          { type: 'chunk', time: 1, chunk: { type: 'block-start', index: 0, blockType: 'text' } },
          { type: 'text-chunks', time0: 1, index: 0, dt: [0], texts: ['我先跑一条命令'] },
          {
            type: 'chunk',
            time: 2,
            chunk: {
              type: 'usage',
              usage: {
                [DSH_USAGE_FIELDS.input]: 374,
                [DSH_USAGE_FIELDS.output]: 102,
                [DSH_USAGE_FIELDS.cached]: 5888,
                [DSH_USAGE_FIELDS.total]: 6364,
              },
            },
          },
          { type: 'chunk', time: 3, chunk: { type: 'finish', reason: { kind: 'error' } } },
        ],
      }),
      state,
      CONTEXT,
    );

    // 分量与恒等式都按与 assistant/message 同一份读数走
    expect(projection.tokens).toEqual({ input: 374, cached: 5888, output: 102, reasoningOutput: null, total: 6364 });
    expect(state.usageInput).toBe(374);
    expect(state.usageCached).toBe(5888);
    expect(state.usageOutput).toBe(102);
    expect(state.usageTotal).toBe(6364);
    // 它没有内容快照（正文的落点是 stream-tap 增量）⇒ 不产消息
    expect(projection.messages ?? []).toEqual([]);
  });

  it('assistant/attempt 的用量：真机上失败尝试的 usage 是真 0（坏 key）⇒ 照记不误、不落 WARN', () => {
    const state = newState();
    const projection = projectDshNotification(
      sessionEvent('assistant/attempt', {
        turn: 1,
        step: 1,
        stream: [
          { type: 'chunk', time: 1, chunk: { type: 'usage', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } } },
        ],
      }),
      state,
      CONTEXT,
    );

    expect(projection.drafts).toEqual([]);
    expect(state.usageInput).toBe(0);
    expect(state.usageOutput).toBe(0);
  });

  it('assistant/attempt 读不到 usage chunk ⇒ 什么都不记（不把一次尝试当 0 记进去）', () => {
    const state = newState();
    const projection = projectDshNotification(
      sessionEvent('assistant/attempt', { turn: 1, step: 1, stream: [{ type: 'text-chunks', index: 0, texts: ['半截'] }] }),
      state,
      CONTEXT,
    );

    expect(projection.tokens).toBeNull();
    expect(state.usageInput).toBeNull();
    expect(projection.drafts).toEqual([]);
  });

  /**
   * `llm/retry` = **被重试掉的那次尝试**（配对的那条 `llm/retry-started` 是开工标记，零草稿）。
   * 它过去整条落进未识别兜底（一条原始 JSON）；而「这一步为什么慢」的唯一解释就在这里——
   * 重试后成功的运行在 `turn/end` 上看不出任何痕迹。
   */
  it('llm/retry 落一条人话 WARN（第几次 / 上限 / 厂商原文 / 等多久），不改写结论', () => {
    const projection = projectDshNotification(
      sessionEvent('llm/retry', {
        retryId: '4e0b474e-f894-442e-af4d-4b01f4c31c57',
        turn: 1,
        step: 1,
        provider: 'aieval-route',
        retry: 1,
        maxRetries: 5,
        delayMs: 466.9,
        failure: { message: 'terminated', code: 'TRANSPORT' },
      }),
      newState(),
      CONTEXT,
    );

    expect(projection.drafts).toHaveLength(1);
    const draft = projection.drafts[0];
    expect(draft?.type).toBe('log');
    expect(draft?.type === 'log' && draft.stream).toBe('stderr');
    expect(draft?.type === 'log' && draft.text).toBe('[WARN] 厂商重试（第 1/5 次，[TRANSPORT] terminated，467 ms 后重发）');
    expect(projection.failure).toBeNull();
  });

  /**
   * 权限档只有 `permission/preset` 一条来源（真机 seq 0，每次都投）：
   * 契约的 `vendor-system.permissionMode` 在 dsh 这一家就是这里的 preset 字符串。
   * 不登记的表现是环境抽屉上「权限档」**恒为空**——连评分阶段被限成 `read-only` 都看不出来。
   */
  /**
   * **权限档是会话属性**（R5-B 的真机读数）：续接 / 追问段厂商不再投 `permission/preset`，而那一段的
   * `vendor-system` 若交 `null`，读侧（环境抽屉取最后一条）会把权限档抹成「未暴露」——实际档位没变。
   * 所以会话级记一份，本段观测不到时用它兜底；两条出口都要兜。
   */
  it('续接段观测不到 permission/preset ⇒ 用同一会话早先那段记下的档位兜底（不是 null）', () => {
    const state = newState();
    const runState: DshProjectionRunState = {
      childSessions: new Set<string>(),
      finishedSessions: new Set<string>(),
    };
    // 首段：厂商投了 permission/preset
    projectDshNotification(sessionEvent('permission/preset', { preset: 'danger-full-access' }), state, CONTEXT, runState);
    const first = projectDshNotification(
      sessionEvent('request/header', { header: { tools: [{ name: 'read' }] } }),
      state,
      CONTEXT,
      { childSessions: new Set<string>(), finishedSessions: new Set<string>(), permissionPreset: 'danger-full-access' },
    );
    expect(first.drafts.some((draft) => draft.type === 'vendor-system' && draft.permissionMode === 'danger-full-access')).toBe(true);

    // 续接段：同一个 sessionId，厂商**不**再投 preset ⇒ 会话级记忆兜底
    const second = projectDshNotification(
      sessionEvent('request/header', { header: { tools: [{ name: 'read' }] } }),
      newState(),
      CONTEXT,
      { childSessions: new Set<string>(), finishedSessions: new Set<string>() },
    );
    expect(second.drafts.some((draft) => draft.type === 'vendor-system' && draft.permissionMode === 'danger-full-access')).toBe(true);
  });

  it('permission/preset 填进 vendor-system.permissionMode（工具表那条出口带上它）', () => {
    const runState: DshProjectionRunState = { childSessions: new Set<string>(), finishedSessions: new Set<string>() };
    const preset = projectDshNotification(
      sessionEvent('permission/preset', { preset: 'read-only' }),
      newState(),
      CONTEXT,
      runState,
    );
    expect(preset.drafts).toEqual([]);
    expect(runState.permissionPreset).toBe('read-only');

    const header = projectDshNotification(
      sessionEvent('request/header', { header: { tools: [{ name: 'read' }, { name: 'bash' }] } }),
      newState(),
      CONTEXT,
      runState,
    );
    expect(header.drafts[0]?.type === 'vendor-system' && header.drafts[0].permissionMode).toBe('read-only');
  });

  it('权限预设还没到时 permissionMode 是 null（不发明一个档位）', () => {
    const header = projectDshNotification(
      sessionEvent('request/header', { header: { tools: [{ name: 'read' }] } }),
      newState(),
      CONTEXT,
      { childSessions: new Set<string>(), finishedSessions: new Set<string>() },
    );
    expect(header.drafts[0]?.type === 'vendor-system' && header.drafts[0].permissionMode).toBeNull();
  });

  /**
   * **非零退出**：厂商对 shell 类工具写的是 `message.isError: false` + 正文尾部的
   * `[exit code: N]`（工具描述逐字：「Non-zero exits are reported, not errored」），
   * 而**结构化**的退出码在同一次运行的 `job/settled` 上（`detail: "exit code: N"`，
   * `toolCall.callId` 与结果的 `message.toolCallId` 同值；真机顺序 `job/settled → tool/result`）。
   *
   * 不补这一格的后果：结果块被界面画成 **ok**——四家里只有 dsh 连 `isError` 都不置，
   * 一次失败的命令在对话视图里看不出来。播报口径与 codex 同尺（只置块级 `isError`，不加活动行摘要）。
   */
  describe('非零退出：`job/settled` 的结构化退出码补进结果块的 isError', () => {
    const jobSettled = (callId: string, detail: string | null, _turn = 1, _step = 1, status = 'completed'): unknown =>
      sessionEvent('job/settled', {
        jobId: 'bash-1',
        kind: 'bash',
        label: 'node -e "process.exit(7)"',
        toolCall: { callId, rootCallId: callId },
        status,
        // `detail` 缺席是**真机形状**（`workflow` 被 `job_kill` 且调用方没传 reason 时厂商整格不写）
        ...(detail === null ? {} : { detail }),
        // ⚠️ 真机 `job/settled` **不带** `turn`/`step`（R6-A 的 `R6A-wfkill` 原文、R7-A 的 37 档专项）
        // ⇒ 夹具也不带：带上会让发号表在测试里多走一格，测出来的轮次序列与真机不同
      });
    const toolResult = (callId: string, isError: boolean): unknown =>
      sessionEvent('tool/result', {
        turn: 1,
        step: 1,
        message: {
          role: 'tool',
          toolCallId: callId,
          isError,
          content: [{ type: 'text', text: '[stderr]\nboom\n[exit code: 7]' }],
          id: 'msg-1',
        },
      });

    it('`exit code: 7` ⇒ 结果块 isError=true，且活动行**不**加摘要（与 codex 同尺）', () => {
      const runState = { childSessions: new Set<string>(), finishedSessions: new Set<string>() };
      const settled = projectDshNotification(jobSettled('call_x', 'exit code: 7'), newState(), CONTEXT, runState);
      // `job/*` 的处置口径不变：照旧一条原始 JSON（登记是顺带的）
      expect(settled.drafts).toHaveLength(1);
      expect(settled.drafts[0]?.type).toBe('log');
      const result = projectDshNotification(toolResult('call_x', false), newState(), CONTEXT, runState);
      expect(result.messages?.[0]?.blocks[0]?.block).toMatchObject({ type: 'tool-result', isError: true });
      // 活动行不给摘要（`summary` 缺省）
      expect(result.drafts[0]?.type === 'log' && result.drafts[0].summary).toBeUndefined();
    });

    it('`exit code: 0` ⇒ 不置 isError（成功返回照旧不播）', () => {
      const runState = { childSessions: new Set<string>(), finishedSessions: new Set<string>() };
      projectDshNotification(jobSettled('call_ok', 'exit code: 0'), newState(), CONTEXT, runState);
      const result = projectDshNotification(toolResult('call_ok', false), newState(), CONTEXT, runState);
      expect(result.messages?.[0]?.blocks[0]?.block).toMatchObject({ isError: false });
    });

    it('没有 `job/settled`（例如 read / write 这类没有 job 的工具）⇒ 以厂商的 isError 为准', () => {
      const runState = { childSessions: new Set<string>(), finishedSessions: new Set<string>() };
      const result = projectDshNotification(toolResult('call_read', true), newState(), CONTEXT, runState);
      expect(result.messages?.[0]?.blocks[0]?.block).toMatchObject({ isError: true });
      const ok = projectDshNotification(toolResult('call_read2', false), newState(), CONTEXT, runState);
      expect(ok.messages?.[0]?.blocks[0]?.block).toMatchObject({ isError: false });
    });

    /**
     * **被信号杀掉的收场也算失败**（厂商 `processOutcome` 的另一支：`status: 'killed'` ⇒
     * `detail: "signal: SIGTERM"` 或 `"killed before exit"`）。只认 `exit code: N` 会让超时 /
     * `job_kill` / 运行时收工杀掉的命令在界面上显示成成功——那正是这一格要消灭的形状。
     */
    it('被信号杀掉（`signal: …` / `killed before exit`）⇒ 结果块 isError=true', () => {
      const runState = { childSessions: new Set<string>(), finishedSessions: new Set<string>() };
      projectDshNotification(jobSettled('call_sig', 'signal: SIGTERM', 1, 1, 'killed'), newState(), CONTEXT, runState);
      const killed = projectDshNotification(toolResult('call_sig', false), newState(), CONTEXT, runState);
      expect(killed.messages?.[0]?.blocks[0]?.block).toMatchObject({ type: 'tool-result', isError: true });

      const before = { childSessions: new Set<string>(), finishedSessions: new Set<string>() };
      projectDshNotification(jobSettled('call_kill', 'killed before exit', 1, 1, 'killed'), newState(), CONTEXT, before);
      const killedEarly = projectDshNotification(toolResult('call_kill', false), newState(), CONTEXT, before);
      expect(killedEarly.messages?.[0]?.blocks[0]?.block).toMatchObject({ isError: true });
    });

    /**
     * **`job/settled` 晚于 `tool/result`**（真机：被 `job_kill` / 超时杀掉的命令就是这个顺序）：
     * 结果已经交出去了，按登记值改判改不到它 ⇒ 必须**重投同一条**（身份与块键都没变，合并是覆盖）。
     */
    it('`job/settled` 晚到 ⇒ 把已投影的结果重投一次并改判成失败', () => {
      const runState = { childSessions: new Set<string>(), finishedSessions: new Set<string>() };
      // 先到结果（此时还不知道它会被杀）
      const early = projectDshNotification(toolResult('call_late', false), newState(), CONTEXT, runState);
      expect(early.messages?.[0]?.blocks[0]?.block).toMatchObject({ isError: false });
      // 再到 job/settled（killed）
      const late = projectDshNotification(jobSettled('call_late', 'signal: SIGTERM; Test abort per instruction', 1, 1, 'killed'), newState(), CONTEXT, runState);
      expect(late.messages).toHaveLength(1);
      expect(late.messages?.[0]?.blocks[0]?.block).toMatchObject({ type: 'tool-result', isError: true });
      // 同一条消息（身份与块键都没变）：不是新增载体
      expect(late.messages?.[0]?.vendorId).toBe(early.messages?.[0]?.vendorId);
      expect(late.messages?.[0]?.blocks[0]?.block).toMatchObject({ callId: 'call_late' });
    });

    /**
     * **`status: 'killed'` 而 `detail` 整格缺席**（R6-A 的真机形状）：`run_in_background` 起的
     * workflow 被 `job_kill` 杀掉、调用方**没传 `reason`**（可选参数）⇒ 厂商只在 `killReason !== undefined`
     * 时才补 `detail` ⇒ 事件是 `{status:'killed', cause:'kill'}`、**没有 detail 键**。
     * 只按「detail 非空才算失败」判，这条被杀的作业在界面上画成 ok——所以判据必须读结构化的 `status`。
     */
    it('`status: killed` 且没有 detail 键 ⇒ 仍然判失败（workflow 被 job_kill 的真机形状）', () => {
      const runState = { childSessions: new Set<string>(), finishedSessions: new Set<string>() };
      const settled = projectDshNotification(jobSettled('call_wf', null, 1, 1, 'killed'), newState(), CONTEXT, runState);
      expect(settled.drafts).toHaveLength(1);
      const killed = projectDshNotification(toolResult('call_wf', false), newState(), CONTEXT, runState);
      expect(killed.messages?.[0]?.blocks[0]?.block).toMatchObject({ type: 'tool-result', isError: true });

      // `completed` 且没有 detail（正常收场的形状）⇒ 不判失败
      const okState = { childSessions: new Set<string>(), finishedSessions: new Set<string>() };
      projectDshNotification(jobSettled('call_ok2', null, 1, 1, 'completed'), newState(), CONTEXT, okState);
      const ok = projectDshNotification(toolResult('call_ok2', false), newState(), CONTEXT, okState);
      expect(ok.messages?.[0]?.blocks[0]?.block).toMatchObject({ isError: false });
    });

    /**
     * **`detail` 里的失败标记压过 `status`**（R6-B 的 F9 残留格）：`completed` + `signal: SIGTERM`
     * 是自相矛盾的形状——按「有失败证据」处置（旧实现正是 true）；让 status 压过它会把这条判成成功，
     * 方向错得危险。而 `killed` 无 detail 那一档由 `status` 兜住（R6-A 的真机形状）。
     */
    it('`completed` + `detail: signal: …`（自相矛盾形状）⇒ 仍判失败', () => {
      const runState = { childSessions: new Set<string>(), finishedSessions: new Set<string>() };
      projectDshNotification(jobSettled('call_mix', 'signal: SIGTERM', 1, 1, 'completed'), newState(), CONTEXT, runState);
      const mixed = projectDshNotification(toolResult('call_mix', false), newState(), CONTEXT, runState);
      expect(mixed.messages?.[0]?.blocks[0]?.block).toMatchObject({ isError: true });
    });

    /**
     * **不读 `cause`**（R6-A 的受控 20 档）：`cause` 与 `status` **不同源**——`killJob` /
     * `cancelForTeardown` 先设 `settleCause` 再等生产方 outcome（中间还夹 `await job.pump.done`），
     * 那条窄竞态里事件是 `{status:'completed', detail:'exit code: 0', cause:'kill'}`：
     * 一次**正常退出**的命令。读 `cause` 会把它画成失败。
     */
    it('`completed` + `exit code: 0` + `cause: kill`（窄竞态）⇒ 不判失败', () => {
      const runState = { childSessions: new Set<string>(), finishedSessions: new Set<string>() };
      const settled = sessionEvent('job/settled', {
        jobId: 'bash-race',
        kind: 'bash',
        label: 'node -e "process.exit(0)"',
        toolCall: { callId: 'call_race', rootCallId: 'call_race' },
        status: 'completed',
        cause: 'kill',
        detail: 'exit code: 0',
        turn: 1,
        step: 1,
      });
      projectDshNotification(settled, newState(), CONTEXT, runState);
      const ok = projectDshNotification(toolResult('call_race', false), newState(), CONTEXT, runState);
      expect(ok.messages?.[0]?.blocks[0]?.block).toMatchObject({ isError: false });
    });

    /**
     * **未观测的 status 词 + 没有 detail ⇒ 判不了失败，但不能一声不吭**（R6-B 的 F9 残留）：
     * 今天厂商只产出 `completed` / `killed`，所以这条 WARN 只在形状漂移时出现；没有它，
     * `terminated` 这类词会让一条失败的作业静默画成 ok。
     */
    it('未观测的 job 收场状态且没有 detail ⇒ 落一条点名 WARN（不判失败但不静默）', () => {
      const runState = { childSessions: new Set<string>(), finishedSessions: new Set<string>() };
      const settled = projectDshNotification(jobSettled('call_odd', null, 1, 1, 'terminated'), newState(), CONTEXT, runState);
      expect(
        settled.drafts.some((draft) => draft.type === 'log' && draft.text.includes('未观测的词')),
      ).toBe(true);
      // 已知的两档**不许**落这条 WARN（否则正常运行会被刷噪声）
      const known = projectDshNotification(jobSettled('call_known', null, 1, 1, 'completed'), newState(), CONTEXT, runState);
      expect(known.drafts.some((draft) => draft.type === 'log' && draft.text.includes('未观测的词'))).toBe(false);
    });

    it('退出码按 callId 配对：另一个 call 的失败不牵连这一条', () => {
      const runState = { childSessions: new Set<string>(), finishedSessions: new Set<string>() };
      projectDshNotification(jobSettled('call_a', 'exit code: 3'), newState(), CONTEXT, runState);
      const other = projectDshNotification(toolResult('call_b', false), newState(), CONTEXT, runState);
      expect(other.messages?.[0]?.blocks[0]?.block).toMatchObject({ isError: false });
    });
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

/**
 * `user/message` 的**技能目录**（`data.source.kind === 'skill-catalog'`）——这一家的 skills 判据。
 *
 * 真机口径：目录正文是一个 `<available_skills>` 块，逐行
 * `` - `<name>`: <description> ``；全轮**恰好一条**。判据必须按 `source.kind` 数，
 * **不许按「正文里出现过 `<available_skills>` 这个词」**——控制臂（一个 skill 都没有）
 * 用后者会得到 5 条纯噪声（厂商自己的提示词与工具描述里就有这个词）。
 *
 * 这一支还必须**显式分流**：未识别的 `session.event` 会走 `unknown(raw)` 兜底，
 * 把一条几十 KB 的 JSON 落进「原始输出」面板（真机目录正文本身就有几 KB）。
 */
describe('projectDshNotification：技能目录（user/message / skill-catalog）', () => {
  const catalog = (names: readonly string[]): unknown => ({
    method: 'session.event',
    params: {
      sessionId: 'session-1',
      event: {
        type: 'user/message',
        data: {
          source: { kind: 'skill-catalog' },
          content: [
            {
              type: 'text',
              text: [
                '<system-reminder>',
                'A skill is a reusable set of task-specific instructions. The following skills are available in this session:',
                '',
                '<available_skills>',
                ...names.map((name) => `- \`${name}\`: probe skill ${name}`),
                '</available_skills>',
              ].join('\n'),
            },
          ],
        },
      },
    },
  });

  it('目录消息 ⇒ 一条带 skills 的 vendor-system（名字按厂商顺序，来源未证实）', () => {
    const runState = { childSessions: new Set<string>(), finishedSessions: new Set<string>(), headerTools: null, skillCatalog: null };
    const projection = projectDshNotification(catalog(['alpha', 'beta']), newState(), CONTEXT, runState);

    expect(projection.drafts).toHaveLength(1);
    expect(projection.drafts[0]).toMatchObject({
      type: 'vendor-system',
      skills: [
        // 这一家的目录**只有名字** ⇒ 来源未证实（不许猜）
        { name: 'alpha', source: null, path: null, origin: 'unverified' },
        { name: 'beta', source: null, path: null, origin: 'unverified' },
      ],
    });
    // 跨消息状态记下来了：后面那条 `request/header` 发出时要把这一格一起带上
    expect(runState.skillCatalog).toEqual(['alpha', 'beta']);
  });

  it('清单没变 ⇒ 不再发事件（每个 step 都投一条，逐条落盘等于抄 N 遍）', () => {
    const runState = { childSessions: new Set<string>(), finishedSessions: new Set<string>(), headerTools: null, skillCatalog: ['alpha'] };
    const projection = projectDshNotification(catalog(['alpha']), newState(), CONTEXT, runState);

    expect(projection.drafts).toEqual([]);
  });

  it('读不出块 ⇒ 不发事件（`[]` 是「投送了、确实一条都没有」，与「读不动」不是一回事）', () => {
    const runState = { childSessions: new Set<string>(), finishedSessions: new Set<string>(), headerTools: null, skillCatalog: null };
    const projection = projectDshNotification(
      {
        method: 'session.event',
        params: {
          sessionId: 'session-1',
          event: { type: 'user/message', data: { source: { kind: 'skill-catalog' }, content: [{ type: 'text', text: '换了形状的正文' }] } },
        },
      },
      newState(),
      CONTEXT,
      runState,
    );

    expect(projection.drafts).toEqual([]);
    expect(runState.skillCatalog).toBeNull();
  });

  it('别的 `user/message`（不是目录）照旧落原始 JSON 兜底——分流不是「静默丢掉不认识的消息」', () => {
    const runState = { childSessions: new Set<string>(), finishedSessions: new Set<string>(), headerTools: null, skillCatalog: null };
    const projection = projectDshNotification(
      {
        method: 'session.event',
        params: {
          sessionId: 'session-1',
          event: { type: 'user/message', data: { source: { kind: 'user-input' }, content: [{ type: 'text', text: '你好' }] } },
        },
      },
      newState(),
      CONTEXT,
      runState,
    );

    expect(projection.drafts).toHaveLength(1);
    expect(projection.drafts[0]?.type).toBe('log');
    expect(projection.drafts[0]?.type === 'log' ? projection.drafts[0].text : '').toContain('user-input');
  });
});

/**
 * 最终答复的**会话归属**（`state.finalText` 只认主会话）。
 *
 * 子会话的 `assistant/message` 与主会话走同一条通知流、且明确放行（见 `index.ts` 的放行规则），
 * 少了这道过滤，子智能体在候选答复之后再说话就会把它顶掉——而评分通路只读最终答复
 * （`AgentRunResult.finalText`），症状是「拿子智能体那句话去评分」，`ok` 仍是 true、零 WARN。
 * 判据与另三家同尺（codex 的 `threadId === mainThreadId`、claude 只在主循环 `result` 上写、
 * pi 只认父会话的 `message_end`），一致性套件也要求「`finalText` 必须是主会话答复之一」。
 */
describe('projectDshNotification：最终答复只认主会话', () => {
  /** 真机 `subagent.started` 形状：身份只在 `childSessionId`（与随后子会话事件的 `params.sessionId` 同值） */
  const CHILD = 'b91cd0e2-58e2-4b0f-9b1e-3f5b3b4a1f77';
  const assistantOf = (sessionId: string, text: string): unknown =>
    sessionEvent(
      DSH_ASSISTANT_MESSAGE_TYPE,
      { turn: 1, step: 1, message: { id: `m-${sessionId}`, content: [{ type: 'text', text }] } },
      sessionId,
    );

  it('子会话在候选答复之后再说话 ⇒ `finalText` 仍是主会话那一句', () => {
    const state = newState();
    const runState = {
      childSessions: new Set<string>(),
      finishedSessions: new Set<string>(),
      headerTools: null,
      skillCatalog: null,
    };
    // 子会话身份必须先登记：`dshSubagentIdOf` 只认登记过的 id
    projectDshNotification(
      { method: DSH_SUBAGENT_STARTED_METHOD, params: { parentSessionId: 'session-1', childSessionId: CHILD } },
      state,
      CONTEXT,
      runState,
    );
    projectDshNotification(assistantOf('session-1', '主会话：数完了。'), state, CONTEXT, runState);
    projectDshNotification(assistantOf(CHILD, '子智能体：文件有 3 行。'), state, CONTEXT, runState);

    expect(state.finalText).toBe('主会话：数完了。');
  });

  it('子会话的正文照旧落一条日志（证据不因为归属过滤而丢）', () => {
    const state = newState();
    const runState = {
      childSessions: new Set([CHILD]),
      finishedSessions: new Set<string>(),
      headerTools: null,
      skillCatalog: null,
    };
    const projection = projectDshNotification(assistantOf(CHILD, '子智能体：文件有 3 行。'), state, CONTEXT, runState);

    expect(projection.drafts.some((draft) => draft.type === 'log' && draft.text === '子智能体：文件有 3 行。')).toBe(true);
  });
});

/**
 * 子任务记录的 `kind` 在**收尾那一刻不许换词**。
 *
 * 契约：`kind` 是「派发方式」（如 `spawn_agent` / `subagent` / `Task`），界面把它渲染成
 * 「派发方式」那一格（`build-model` → `subagent-bar`）。catalog 的 `mode`（`one-shot` /
 * `continuable`）是这一格在本次运行的取值；`subagent.finished` 上的 `provider` 是另一件事
 * （跑这个子会话的提供方名），契约里没有它的落点。把 `provider` 写进 `kind` 的后果是：
 * 同一张卡片在跑动期显示 `one-shot`、收尾那一刻变成 `spawn`，而 `mode` 此后彻底消失。
 */
describe('dshSubagentRecord：终态记录与派发记录同形', () => {
  const CHILD = 'c0f2f0b0-52c1-4a25-9d1e-6b0a3c9d2a11';
  const runState = (): {
    childSessions: Set<string>;
    finishedSessions: Set<string>;
    dispatchStarts: Map<string, { description: string | null; claimedBy: string | null }>;
    claimedDispatches: Map<string, string>;
    deliveredStarts: Map<string, string>;
  } => ({
    childSessions: new Set<string>(),
    finishedSessions: new Set<string>(),
    dispatchStarts: new Map(),
    claimedDispatches: new Map(),
    deliveredStarts: new Map(),
  });

  it('收尾那条的 `kind` 仍是 catalog 的 `mode`（厂商 `provider` 不占这一格）', () => {
    const state = newState();
    const run = runState();
    projectDshNotification(
      { method: DSH_SUBAGENT_STARTED_METHOD, params: { parentSessionId: 'session-1', childSessionId: CHILD } },
      state,
      CONTEXT,
      run,
    );
    projectDshNotification(
      sessionEvent('subagent/catalog', { version: 0, childId: CHILD, childCreatedAt: 1, mode: 'one-shot', label: '数一数' }),
      state,
      CONTEXT,
      run,
    );
    const finished = projectDshNotification(
      {
        method: DSH_SUBAGENT_FINISHED_METHOD,
        params: {
          provider: 'spawn',
          agentId: CHILD,
          parentSessionId: 'session-1',
          childSessionId: CHILD,
          status: 'ok',
          stopReason: 'completed',
          lastAssistantMessage: [{ type: 'text', text: '3' }],
        },
      },
      state,
      CONTEXT,
      run,
    );

    expect(finished.subagents?.[0]).toMatchObject({ subagentId: CHILD, kind: 'one-shot', status: 'completed' });
  });
});

/**
 * `turn/end` 的非 `completed` 收场**必须留痕**（失败通道只有 `kind === 'error'` 一条）。
 *
 * 厂商在 `reason.kind` 上明确报了「这一轮怎么了」：`aborted`（被取消）/ `blocked` /
 * `max-tokens`（撞到输出上限）/ `interrupted` / `forked`。这些档位**不改写** `ok`（与另三家同尺：
 * claude 的 `aborted`、codex 的 `interrupted`、pi 的 `length` 都只落 WARN），但也不能一个字都不留——
 * 否则排障时「这一轮为什么结束」只能去翻厂商会话日志。
 */
describe('projectDshNotification：非 completed 的收场要留痕（不改结论）', () => {
  it('`max-tokens` ⇒ 一条 stderr WARN（带档位与厂商原文），且 failure 仍是 null', () => {
    const state = newState();
    const projection = projectDshNotification(
      sessionEvent(DSH_TURN_END_TYPE, { turn: 1, reason: { kind: 'max-tokens' } }),
      state,
      CONTEXT,
    );

    expect(projection.failure).toBeNull();
    const warn = projection.drafts.find((draft) => draft.type === 'log' && draft.stream === 'stderr');
    const text = warn?.type === 'log' ? warn.text : '';
    expect(text).toContain('max-tokens');
    expect(text).toContain('不改写');
  });

  it('`completed` 与 `error` 两档不额外落 WARN（前者的痕在计量与轮次上，后者有自己的失败出口）', () => {
    const done = projectDshNotification(
      sessionEvent(DSH_TURN_END_TYPE, { turn: 1, reason: { kind: 'completed' } }),
      newState(),
      CONTEXT,
    );
    expect(done.drafts).toEqual([]);

    const failed = projectDshNotification(
      sessionEvent(DSH_TURN_END_TYPE, { turn: 1, reason: { kind: 'error', error: { message: 'boom', code: 'TRANSPORT' } } }),
      newState(),
      CONTEXT,
    );
    expect(failed.drafts.map((draft) => draft.type)).toEqual(['error']);
  });
});

/**
 * 目录项**晚于收尾**到达时，不许把已经跑完的子任务打回「运行中」。
 *
 * 补投的那条是运行行（`status: 'running'`、`usage: null`），而读侧按 `subagentId` 覆盖累积、
 * **最后一条赢**（`client/ui` 的 `build-model`）⇒ 少了这道判据，卡片会从「已完成 + 有用量」
 * 退回「运行中 + 用量空」，而界面上没有任何报错。判据取**事实**（`finishedSessions` 已登记），
 * 不靠「厂商一定先发目录项」这条顺序假设。
 */
describe('projectDshNotification：收尾之后到的目录项不覆盖终态', () => {
  const CHILD = '7d1a1f6e-2f4c-4b8a-9c31-5a6f9a2b0e55';
  const catalog = (label: string): unknown =>
    sessionEvent('subagent/catalog', { version: 1, childId: CHILD, childCreatedAt: 1, mode: 'one-shot', label });
  const newRunState = (): {
    childSessions: Set<string>;
    finishedSessions: Set<string>;
    dispatchStarts: Map<string, { description: string | null; claimedBy: string | null }>;
    claimedDispatches: Map<string, string>;
    deliveredStarts: Map<string, string>;
  } => ({
    childSessions: new Set<string>(),
    finishedSessions: new Set<string>(),
    dispatchStarts: new Map(),
    claimedDispatches: new Map(),
    deliveredStarts: new Map(),
  });

  it('started → catalog → finished → 又一条 catalog ⇒ 不再补投运行行', () => {
    const state = newState();
    const run = newRunState();
    projectDshNotification(
      { method: DSH_SUBAGENT_STARTED_METHOD, params: { parentSessionId: 'session-1', childSessionId: CHILD } },
      state,
      CONTEXT,
      run,
    );
    projectDshNotification(catalog('数一数'), state, CONTEXT, run);
    projectDshNotification(
      {
        method: DSH_SUBAGENT_FINISHED_METHOD,
        params: {
          provider: 'spawn',
          agentId: CHILD,
          parentSessionId: 'session-1',
          childSessionId: CHILD,
          status: 'ok',
          stopReason: 'completed',
          lastAssistantMessage: [{ type: 'text', text: '3' }],
        },
      },
      state,
      CONTEXT,
      run,
    );
    // 「已收场」这件事实由**通知流**在过滤器里登记（`index.ts` 的 `noteFinishedChildSession`）——
    // 投影这一层只读它（`DshProjectionRunState.finishedSessions` 是只读的），用例照这一分工补上
    run.finishedSessions.add(CHILD);
    // 目录项因 version 递增重发（内容与上次不同，绕开签名判据）
    const late = projectDshNotification(catalog('数一数（改名了）'), state, CONTEXT, run);

    expect(late.subagents ?? []).toEqual([]);
  });
});

/**
 * `turn/end(kind:'error')` 的两格事实都要留：**厂商原文**与**厂商的结构化失败码**。
 *
 * 判据是「结构化码不许被丢掉」：归因那一层只能从文案里正则抓状态码，而 `LlmFailure.code`
 * 是厂商唯一的机器可读档位——丢失它的代价是「不带状态码原文的鉴权 / 配额失败」被折成笼统的
 * `AGENT_FAILED`，而那一档在编排层的自动重试表里（同一个恒失败配置被白跑两遍）。
 */
describe('projectDshNotification：失败原文与结构化码都要留', () => {
  it('`reason.error` 是对象 ⇒ 事件文案同时带 code 与 message', () => {
    const projection = projectDshNotification(
      sessionEvent(DSH_TURN_END_TYPE, { turn: 1, reason: { kind: 'error', error: { message: 'boom', code: 'TRANSPORT' } } }),
      newState(),
      CONTEXT,
    );

    const failure = projection.drafts.find((draft) => draft.type === 'error');
    const text = failure?.type === 'error' ? failure.message : '';
    expect(text).toContain('TRANSPORT');
    expect(text).toContain('boom');
    expect(projection.failure?.code).toBe('AGENT_FAILED');
  });

  it('`reason.error` 是纯字符串（SDK 折过的那一支）⇒ 原文一字不动，也不编一个码', () => {
    const projection = projectDshNotification(
      sessionEvent(DSH_TURN_END_TYPE, { turn: 1, reason: { kind: 'error', error: '网关 502' } }),
      newState(),
      CONTEXT,
    );

    const failure = projection.drafts.find((draft) => draft.type === 'error');
    expect(failure?.type === 'error' ? failure.message : '').toBe('网关 502');
  });
});
