/**
 * 活动行的**实时内容**（2026-10-10）：折 AgentMessage（正文 / 工具摘要）与「按阶段择一条流」。
 *
 * 四组判据，每一组都有独立的靶子：
 *   ① `activityOfMessage` —— 从消息里挑哪个块当活动文案（正文优先、工具给摘要、其余不给）；
 *   ② `parseActivityFrame` —— 坏帧不打断整条流（与服务端同一口径：一条畸形帧只丢它自己）；
 *   ③ 订阅哪条流 —— 评分阶段看评审者那条，终态一条都不开（开了就是白挂一条连接）；
 *   ④ 不回放历史 —— 两条流的 URL 都带 `?replay=0`（实测某行 `messages.jsonl` 4 MB，
 *      为一句文案把它搬过 socket 是纯浪费；这条只能靠 URL 钉住，拼错了浏览器不报错）。
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { AgentMessage } from '@aieval/contracts';
import { EMPTY_ACTIVITY, activityOfMessage, parseActivityFrame, useRunActivity } from './run-activity';
import { FakeEventSource, installEventSourceStub } from './testing/event-source';

/** 一条消息：用例只覆盖自己关心的格，其余按契约的「没有」填 */
function message(overrides: Partial<AgentMessage>): AgentMessage {
  return {
    messageId: 'm-1',
    vendorId: null,
    role: 'assistant',
    source: 'wire',
    roundTrip: 1,
    turn: null,
    step: null,
    parentCallId: null,
    subagentId: null,
    chunk: 'delta',
    assembly: 'open',
    mergeKey: 'main|1|assistant|-',
    blocks: [],
    raw: null,
    ...overrides,
  };
}

describe('activityOfMessage（这一条消息里显示什么）', () => {
  it('正文：取 text 与「还在写」这一格（判据只有消息级 assembly）', () => {
    const activity = activityOfMessage(
      message({ assembly: 'open', blocks: [{ type: 'text', text: '正在改 lib/http.js' }] }),
    );
    expect(activity).toEqual({ text: '正在改 lib/http.js', streaming: true, toolSummary: null });
  });

  it('工具块：用适配器算好的 `summary`；老数据缺这一格时回落到「调用工具 <名字>」', () => {
    const withSummary = activityOfMessage(
      message({
        chunk: 'snapshot',
        assembly: 'snapshot',
        blocks: [{ type: 'tool-call', callId: 'c1', family: 'read-file', name: 'Read', input: { path: 'a.ts' }, summary: '调用工具 Read：a.ts' }],
      }),
    );
    expect(withSummary).toEqual({ text: null, streaming: false, toolSummary: '调用工具 Read：a.ts' });

    // 老记录（`summary` 那格还没有）：显示成「调用工具 Read」而不是一片空白
    const legacy = activityOfMessage(
      message({
        chunk: 'snapshot',
        assembly: 'snapshot',
        blocks: [{ type: 'tool-call', callId: 'c2', family: 'read-file', name: 'Read', input: null }],
      }),
    );
    expect(legacy.toolSummary).toBe('调用工具 Read');
  });

  it('取**最后**那个可显示的块：正文之后又调了工具 ⇒ 显示工具', () => {
    const activity = activityOfMessage(
      message({
        chunk: 'snapshot',
        assembly: 'snapshot',
        blocks: [
          { type: 'text', text: '我先看一下。' },
          { type: 'tool-call', callId: 'c1', family: 'read-file', name: 'Read', input: null, summary: '调用工具 Read：a.ts' },
        ],
      }),
    );
    expect(activity.toolSummary).toBe('调用工具 Read：a.ts');
    expect(activity.text).toBeNull();
  });

  it('推理 / 工具结果 / 空正文**都不占**这一行（2026-10-07 口径）；都没有时返回「没有内容」', () => {
    const thinkingOnly = activityOfMessage(
      message({ blocks: [{ type: 'thinking', text: '想一下', textKind: 'full', signature: null }] }),
    );
    expect(thinkingOnly).toBe(EMPTY_ACTIVITY);

    // 空串正文是**真机见过的形态**：显示成空白比停在上一条更糟 ⇒ 继续往前找
    const trailingEmpty = activityOfMessage(
      message({ blocks: [{ type: 'text', text: '有内容' }, { type: 'text', text: '' }] }),
    );
    expect(trailingEmpty.text).toBe('有内容');
  });

  it('机器负载（评分阶段的评分结果 JSON）**不当正文**：跳过它继续往前找', () => {
    // 真机形态（run 7f05c765 的 judge-messages.jsonl 最后一条逐字如此）：
    // 不过这道闸的话，卡片底部会逐字滚出这坨 JSON
    const verdict = '{"judgments":[{"id":"A1","achieved":true,"reason":"改了 DTO"}]}';
    const onlyJson = activityOfMessage(message({ chunk: 'snapshot', assembly: 'snapshot', blocks: [{ type: 'text', text: verdict }] }));
    expect(onlyJson).toBe(EMPTY_ACTIVITY);

    // 前面还有人话（工具摘要）⇒ 回落到那一句，而不是吐 JSON
    const withTool = activityOfMessage(
      message({
        chunk: 'snapshot',
        assembly: 'snapshot',
        blocks: [
          { type: 'tool-call', callId: 'c1', family: 'run-shell', name: 'Bash', input: null, summary: '调用工具 Bash：git status' },
          { type: 'text', text: verdict },
        ],
      }),
    );
    expect(withTool.toolSummary).toBe('调用工具 Bash：git status');
    expect(withTool.text).toBeNull();
  });

  it('带 `[标签]` 前缀的 JSON 同样挡下（与 `log.summary` 那道闸同一份判据）', () => {
    const tagged = activityOfMessage(
      message({ chunk: 'snapshot', assembly: 'snapshot', blocks: [{ type: 'text', text: '[评分智能体] {"text":"评分中的信封"}' }] }),
    );
    expect(tagged).toBe(EMPTY_ACTIVITY);
  });
});

describe('parseActivityFrame（一帧的解析）', () => {
  it('正常帧取出 `message`；子任务帧与非 JSON 一律返回 null', () => {
    const one = message({ blocks: [{ type: 'text', text: '在写' }] });
    expect(parseActivityFrame(JSON.stringify({ type: 'message', message: one }))?.blocks).toHaveLength(1);
    expect(parseActivityFrame(JSON.stringify({ type: 'subagent', subagent: {} }))).toBeNull();
    expect(parseActivityFrame('这不是 JSON')).toBeNull();
    expect(parseActivityFrame('null')).toBeNull();
  });
});

describe('useRunActivity（按阶段择一条流、不回放历史）', () => {
  beforeEach(() => {
    FakeEventSource.reset();
    installEventSourceStub();
  });

  afterEach(() => {
    // 替身由 `vi.stubGlobal` 装上：统一还原（与 `row-live.test.tsx` 同一条纪律）
    vi.unstubAllGlobals();
  });

  it('跑动期订阅候选那条、评分期订阅评分那条，URL 都带 `?replay=0`', () => {
    renderHook(() => useRunActivity({ runId: 'run-1', rows: [{ id: 'w-1', status: 'running' }] }));
    expect(FakeEventSource.instances.map((source) => source.url)).toEqual([
      '/api/runs/run-1/rows/w-1/messages/stream?replay=0',
    ]);

    renderHook(() => useRunActivity({ runId: 'run-1', rows: [{ id: 'w-1', status: 'judging' }] }));
    expect(FakeEventSource.instances.map((source) => source.url)).toContain(
      '/api/runs/run-1/rows/w-1/judge/messages/stream?replay=0',
    );
  });

  it('终态的行一条连接都不开（这一行已经收起）', () => {
    renderHook(() => useRunActivity({ runId: 'run-1', rows: [{ id: 'w-1', status: 'judged' }] }));
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it('delta 帧把正文折进活动（换行原样保留，切段在 ui 那一层做）', async () => {
    const { result } = renderHook(() => useRunActivity({ runId: 'run-1', rows: [{ id: 'w-1', status: 'running' }] }));
    const source = FakeEventSource.instances[0];
    expect(source).toBeDefined();

    act(() => {
      source?.emitNamed('message', JSON.stringify({ type: 'message', message: message({ blocks: [{ type: 'text', text: '第一段\n第二段' }] }) }));
    });

    await waitFor(() => expect(result.current['w-1']?.text).toBe('第一段\n第二段'));
    expect(result.current['w-1']?.streaming).toBe(true);
  });
});
