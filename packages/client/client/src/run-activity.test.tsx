/**
 * 活动行的**实时内容**：折 AgentMessage与「按阶段择一条流」。
 *
 * 四组判据，每一组都有独立的靶子：
 * ① `activityOfMessage` ——从消息里挑哪个块当活动文案（正文优先、工具给摘要、其余不给）；
 * ② `activityOfFrame` ——坏帧 / 非消息帧不当活动（坏帧由 `sse-keyed-hub` 的 `parse` 丢，见 `run-stream-hub.test.ts`）；
 * ③ **看哪个 channel 的帧** ——评分阶段看评审者那条，终态一条都不订；
 * ④ **不回放历史** ——活动行只贡献实时帧（注册时不带游标 ⇒ URL 上没有 `?after=`；
 * 实测某行 `messages.jsonl` 4 MB，为一句文案把它搬过 socket 是纯浪费）。
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { AgentMessage } from '@aieval/contracts';
import { EMPTY_ACTIVITY, activityOfFrame, activityOfMessage, useRunActivity } from './run-activity';
import { resetRunStreamHubForTesting } from './run-stream-hub';
import { FakeEventSource, installEventSourceStub } from './testing/event-source';

/** 一条消息：用例只覆盖自己关心的格，其余按契约的「没有」填 */
function message(overrides: Partial<AgentMessage>): AgentMessage {
  return {
    messageId: 'm-1',
    vendorId: null,
    role: 'assistant',
    source: 'wire',
    origin: 'case-prompt',
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

/** 聚合流的一帧：消息载荷 + 信封归属格（与 api 的 `toMessageFrame` 逐字同形，无名事件） */
function frame(rowId: string, rowChannel: 'candidate' | 'judge', message: AgentMessage): string {
  return JSON.stringify({ type: 'message', rowId, rowChannel, message });
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

  it('推理 / 工具结果 / 空正文**都不占**这一行；都没有时返回「没有内容」', () => {
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
    // 真机形态（`judge-messages.jsonl` 最后一条逐字如此）：
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
    // 标签样本取历史 `events.jsonl` 里真实出现过的形态（评分行曾带转发前缀）；这里钉的是
    // 判据本身——任何「`[标签]` + JSON」的载荷都不许上卡片，与哪条流无关
    const tagged = activityOfMessage(
      message({ chunk: 'snapshot', assembly: 'snapshot', blocks: [{ type: 'text', text: '[评分智能体] {"text":"评分中的信封"}' }] }),
    );
    expect(tagged).toBe(EMPTY_ACTIVITY);
  });
});

describe('activityOfFrame（这一帧算不算活动内容）', () => {
  it('消息帧取出内容；子任务帧与事件帧一律返回 null（它们不占卡片底部那一行）', () => {
    const one = message({ blocks: [{ type: 'text', text: '在写' }] });
    const activity = activityOfFrame({ type: 'message', rowId: 'w-1', rowChannel: 'candidate', message: one });
    expect(activity).toEqual({ text: '在写', streaming: true, toolSummary: null });

    // 子任务行是派发视图的原料，不是「此刻在做什么」的那句话
    expect(
      activityOfFrame({
        type: 'subagent',
        rowId: 'w-1',
        rowChannel: 'candidate',
        subagent: { subagentId: 's-1', description: '查一下', status: 'running' },
      } as never),
    ).toBeNull();
    expect(
      activityOfFrame({ type: 'log', seq: 1, at: '2026-09-22T08:00:00.000Z', stream: 'stdout', text: '一行日志', rowId: 'w-1', rowChannel: 'candidate' }),
    ).toBeNull();
  });
});

describe('useRunActivity（走聚合流、按阶段挑 channel、不回放历史）', () => {
  beforeEach(() => {
    FakeEventSource.reset();
    resetRunStreamHubForTesting();
    installEventSourceStub();
  });

  afterEach(() => {
    // 替身由 `vi.stubGlobal` 装上：统一还原（与 `row-live.test.tsx` 同一条纪律）
    vi.unstubAllGlobals();
  });

  it('两路活动行共用**一条**聚合流连接；活动的行集合不贡献游标（URL 上没有 `?after=`）', async () => {
    const running = renderHook(() => useRunActivity({ runId: 'run-1', rows: [{ id: 'w-1', status: 'running' }] }));
    const judging = renderHook(() => useRunActivity({ runId: 'run-1', rows: [{ id: 'w-2', status: 'judging' }] }));
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    expect(FakeEventSource.instances[0]?.url).toBe('/api/runs/run-1/stream');

    // 阶段决定「关心哪个 channel 的帧」：候选那条只喂给跑动行，评分那条只喂给评分行
    const source = FakeEventSource.instances[0];
    await act(async () => {
      source?.emit(frame('w-1', 'candidate', message({ blocks: [{ type: 'text', text: '候选在写' }] })));
      source?.emit(frame('w-2', 'judge', message({ blocks: [{ type: 'text', text: '评审在看' }] })));
    });
    await waitFor(() => expect(running.result.current['w-1']?.text).toBe('候选在写'));
    await waitFor(() => expect(judging.result.current['w-2']?.text).toBe('评审在看'));
    // 串行检查：对方的 channel 一帧都没折进来
    expect(running.result.current['w-2']).toBeUndefined();
    expect(judging.result.current['w-1']).toBeUndefined();

    // 候选 channel 的帧到达评分行所在的 hook：不折（阶段已经切到评审者）
    await act(async () => {
      source?.emit(frame('w-2', 'candidate', message({ blocks: [{ type: 'text', text: '候选的残留' }] })));
    });
    expect(judging.result.current['w-2']?.text).toBe('评审在看');
  });

  it('终态的行一条连接都不开（这一行已经收起）', async () => {
    renderHook(() => useRunActivity({ runId: 'run-1', rows: [{ id: 'w-1', status: 'judged' }] }));
    // 订阅是晚一拍开的：等过微任务再断言「真的没有连接」（否则这条用例在「压根还没开」时也会绿）
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it('delta 帧把正文折进活动（换行原样保留，切段在 ui 那一层做）', async () => {
    const { result } = renderHook(() => useRunActivity({ runId: 'run-1', rows: [{ id: 'w-1', status: 'running' }] }));
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const source = FakeEventSource.instances[0];
    expect(source).toBeDefined();

    act(() => {
      source?.emit(frame('w-1', 'candidate', message({ blocks: [{ type: 'text', text: '第一段\n第二段' }] })));
    });

    await waitFor(() => expect(result.current['w-1']?.text).toBe('第一段\n第二段'));
    expect(result.current['w-1']?.streaming).toBe(true);
  });
});
