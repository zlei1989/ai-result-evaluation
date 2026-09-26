// @vitest-environment node
/**
 * codex 的事件投影：模型产出条目 → 轮次（近似）、turn.completed 计量、item 累积文本只发增量、未识别保留。
 * 轮次口径见 `events.ts` 的文件头（codex 的 JSON 事件流里没有逐次模型请求事件，故按 reasoning /
 * agent_message 条目近似，误差方向一并写在文件头）。
 * codex 的 `item.updated` 是**累积**文本，全量重发会让日志抽屉里同一段话出现 N 次——这正是 spec
 * 给「唯一允许丢弃的事件是重复事件」举的例子。
 */
import { describe, expect, it } from 'vitest';
import type { TurnState } from '../../turn';
import { projectCodexEvent } from './events';

const CONTEXT = { kind: 'codex', baseUrl: 'https://gw.example.com/openai/v1' } as const;

function newState(): TurnState {
  return {
    seen: new Set(),
    turns: 0,
    usageInput: null,
    usageCached: null,
    usageOutput: null,
    usageReasoningOutput: null,
    usageTotal: null,
    // codex 的事件流一个时间字段都没有 ⇒ 本家不写这一格（时长在 finalize 里读会话文件时补）
    timing: null,
    usageByMessageId: new Map(),
    turnKeys: new Set(),
    finalText: null,
  };
}

describe('projectCodexEvent：计量与轮次', () => {
  /**
   * 轮次口径（用户口径，2026-09-28）：一次模型 API 往返算一次，而 codex 的 JSON 事件流里**没有**
   * 逐次请求事件（顶层只有 thread/turn/item 三类，见 events.ts 的文件头）⇒ 按**模型产出条目**
   * （`reasoning` / `agent_message`）近似，并按 `item.id` 去重（三种 item.* 事件共享同一个 id）。
   */
  it('模型产出条目（reasoning / agent_message）→ 轮次按 item.id 去重计数', () => {
    const state = newState();
    const seen = new Map<string, string>();
    const first = projectCodexEvent(
      { type: 'item.completed', item: { id: 'rs-1', type: 'reasoning', text: '想一下' } },
      state,
      seen,
      CONTEXT,
    );
    const second = projectCodexEvent(
      { type: 'item.completed', item: { id: 'msg-1', type: 'agent_message', text: '答复' } },
      state,
      seen,
      CONTEXT,
    );
    expect(first.turns).toBe(1);
    expect(second.turns).toBe(2);

    // 同一条目的后续快照（item.updated / item.completed 共享 id）**不**再算一次
    const again = projectCodexEvent(
      { type: 'item.updated', item: { id: 'msg-1', type: 'agent_message', text: '答复，补一句' } },
      state,
      seen,
      CONTEXT,
    );
    expect(again.turns).toBeNull();
    expect(state.turns).toBe(2);
  });

  it('工具类条目（command_execution 等）不算轮次：一次调用可以带多个，数它们会明显偏高', () => {
    const state = newState();
    // 用 `item.completed`（**唯一**会走计数路径的两种事件之一；`item.started` 落在「未识别 → 原样保留」
    // 那一支，拿它当夹具会让这条守卫变成空转——实测踩过）
    const projection = projectCodexEvent(
      { type: 'item.completed', item: { id: 'cmd-1', type: 'command_execution', command: 'npm test', status: 'completed' } },
      state,
      new Map(),
      CONTEXT,
    );
    expect(projection.turns).toBeNull();
    expect(state.turns).toBe(0);
  });

  it('turn.completed：只交计量，轮次带上**已经数到**的值（一条整段任务一条，不能拿它数轮次）', () => {
    const state = newState();
    const seen = new Map<string, string>();
    projectCodexEvent({ type: 'item.completed', item: { id: 'rs-1', type: 'reasoning', text: '想' } }, state, seen, CONTEXT);
    const projection = projectCodexEvent(
      { type: 'turn.completed', usage: { input_tokens: 11, cached_input_tokens: 3, output_tokens: 7 } },
      state,
      seen,
      CONTEXT,
    );
    /**
     * ⚠️ **`input` 是归一到「非缓存输入」之后的值**（2026-10-XX）：`11 − 3 = 8`。
     * codex 的 `input_tokens` **含**缓存读（`cached_input_tokens` 是它的明细，真机
     * `{input_tokens:8152, cached_input_tokens:6656}`），而契约的 `input` 是不含 cache 的
     * ⇒ 这一格必须减。不减的话命中率公式 `cached/(input+cached)` 在 codex 上分母偏大、
     * 命中率被系统性低估——这条断言就是那处归一化的守卫（写在最显眼的位置，免得被「顺手改回去」）。
     */
    expect(projection.tokens).toEqual({ input: 8, cached: 3, output: 7, reasoningOutput: null, total: null });
    expect(projection.turns).toBe(1);
    // 再收一条 turn.completed 也不会把轮次 +1（原来是这么数的，正是要修的那个「永远是 1」）
    const again = projectCodexEvent(
      { type: 'turn.completed', usage: { input_tokens: 20, cached_input_tokens: 4, output_tokens: 9 } },
      state,
      seen,
      CONTEXT,
    );
    expect(again.turns).toBe(1);
    expect(state.turns).toBe(1);
  });

  it('input 里含缓存读 ⇒ 减掉；cached > input 这种脏形状按 0 收（不把负数放进事件）', () => {
    const projection = projectCodexEvent(
      // 真机恒有 cached <= input；这一条是**防御**用例：一旦形状变了，负的 input 会渲染成读不懂的比率
      { type: 'turn.completed', usage: { input_tokens: 5, cached_input_tokens: 9, output_tokens: 1 } },
      newState(),
      new Map(),
      CONTEXT,
    );
    expect(projection.tokens).toEqual({ input: 0, cached: 9, output: 1, reasoningOutput: null, total: null });
  });

  it('一个条目都没观察到时轮次是 null（不发明一个 0）', () => {
    const projection = projectCodexEvent({ type: 'turn.completed' }, newState(), new Map(), CONTEXT);
    expect(projection.turns).toBeNull();
    expect(projection.tokens).toBeNull();
  });

  it('usage 缺项 → tokens null 且落 WARN（不是 0）', () => {
    const projection = projectCodexEvent(
      { type: 'turn.completed', usage: { input_tokens: 11, output_tokens: 7 } },
      newState(),
      new Map(),
      CONTEXT,
    );
    expect(projection.tokens).toBeNull();
    const warn = projection.drafts.find((draft) => draft.type === 'log' && draft.stream === 'stderr');
    expect(warn?.type === 'log' ? warn.text : '').toContain('不填 0');
  });
});

describe('projectCodexEvent：累积文本与未识别事件', () => {
  it('item 的累积文本只发新增部分', () => {
    const seenTexts = new Map<string, string>();
    const state = newState();
    const first = projectCodexEvent(
      { type: 'item.completed', item: { id: 'i1', text: '第一步' } },
      state,
      seenTexts,
      CONTEXT,
    );
    const second = projectCodexEvent(
      { type: 'item.updated', item: { id: 'i1', text: '第一步，第二步' } },
      state,
      seenTexts,
      CONTEXT,
    );
    expect(first.drafts[0]?.type === 'log' ? first.drafts[0].text : '').toBe('第一步');
    expect(second.drafts[0]?.type === 'log' ? second.drafts[0].text : '').toBe('，第二步');
  });

  it('完全重复的累积更新被丢弃（唯一允许丢弃的一类）', () => {
    const seenTexts = new Map<string, string>();
    const state = newState();
    const event = { type: 'item.updated', item: { id: 'i1', text: '同一段' } };
    projectCodexEvent(event, state, seenTexts, CONTEXT);
    const repeated = projectCodexEvent(event, state, seenTexts, CONTEXT);
    expect(repeated.drafts).toEqual([]);
  });

  it('没有可读文本的 item（命令执行等）保留原始负载', () => {
    const payload = { type: 'item.completed', item: { id: 'c1', type: 'command_execution', command: 'npm test' } };
    const projection = projectCodexEvent(payload, newState(), new Map(), CONTEXT);
    expect(projection.drafts).toHaveLength(1);
    expect(JSON.parse(projection.drafts[0]?.type === 'log' ? projection.drafts[0].text : '')).toEqual(payload);
  });

  it('未识别的 type（thread.started 与未来新增类型）保留原始负载', () => {
    const payload = { type: 'thread.started', thread_id: 't1' };
    const projection = projectCodexEvent(payload, newState(), new Map(), CONTEXT);
    expect(projection.drafts).toHaveLength(1);
    expect(JSON.parse(projection.drafts[0]?.type === 'log' ? projection.drafts[0].text : '')).toEqual(payload);
  });

  it('turn.failed 按文案归因（401 → AUTH_FAILED）', () => {
    const projection = projectCodexEvent(
      { type: 'turn.failed', error: { message: 'HTTP 401 unauthorized' } },
      newState(),
      new Map(),
      CONTEXT,
    );
    expect(projection.failure?.code).toBe('AUTH_FAILED');
    expect(projection.drafts.some((draft) => draft.type === 'error')).toBe(true);
  });
});

/**
 * 最终答复出口（spec §8 / D2）。codex 的答复只在 `item.type === 'agent_message'` 上，
 * 且是**累积**文本（每见一次覆盖一次 ⇒ 最后一次即最终）。
 *
 * ⚠️ 这个形状**未经探测确认**：探针那次网络不通，只跑出 `item.type === 'error'` + `item.message`
 * （**没有 `item.text`**，见 `docs/superpowers/notes/2026-09-22-features-p3-agent-probe.md`）。
 * 故下面这一组是**防御性**守卫：它钉的是「过滤条件只认 `agent_message`」，不是在宣称
 * 别的 item 通道实测也带 `text`——把过滤去掉，本组用例照样必须变红（见计划里的变异清单）。
 */
describe('projectCodexEvent：最终答复（finalText）', () => {
  it('agent 消息被记为最终答复，且取累积文本的最后一次', () => {
    const state = newState();
    const seen = new Map<string, string>();
    projectCodexEvent({ type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: '{"dim' } }, state, seen, CONTEXT);
    projectCodexEvent({ type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: '{"dimensions":[]}' } }, state, seen, CONTEXT);
    expect(state.finalText).toBe('{"dimensions":[]}');
  });

  it('带 text 但不是 agent_message 的 item 不算最终答复（过滤条件必须点名 agent_message）', () => {
    const state = newState();
    const seen = new Map<string, string>();
    // 夹具形状说明（终审 FIX-4）：**不能**写成 `{type:'error', text:…}`——那个组合是**被实测否掉**的
    // （错误项带的是 `item.message`、`text` 缺席），拿它当夹具等于把一个假形状写成已验证事实。
    // 这里用一个工具类 item（`command_execution`，与本文件上一条用例同一形状假设）承载 `text`，
    // 要钉的性质与形状无关：**只要不是 agent_message，带 text 也不能成为最终答复**。
    projectCodexEvent(
      { type: 'item.completed', item: { id: 'i2', type: 'command_execution', text: 'npm test 的输出' } },
      state,
      seen,
      CONTEXT,
    );
    expect(state.finalText).toBeNull();
  });
});

describe('projectCodexEvent：形状异常（评审 N2）', () => {
  it('usage 根本不是对象（形状异常）→ tokens null 且仍落一条带原始负载的 WARN（不得静默）', () => {
    const projection = projectCodexEvent({ type: 'turn.completed', usage: 5 }, newState(), new Map(), CONTEXT);
    // 轮次这一格没有生产者（本条不是模型产出条目）⇒ null，不发明一个 0
    expect(projection.turns).toBeNull();
    expect(projection.tokens).toBeNull();
    const warn = projection.drafts.find((draft) => draft.type === 'log' && draft.stream === 'stderr');
    const text = warn?.type === 'log' ? warn.text : '';
    expect(text).toContain('不填 0');
    expect(text).toContain('5');
  });
});
