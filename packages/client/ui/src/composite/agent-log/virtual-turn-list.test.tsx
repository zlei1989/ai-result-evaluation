/**
 * `VirtualTurnList`（L2）的守卫。
 *
 * jsdom 里量不到高度（`clientHeight === 0`）是**预期**：那一档退化为「不虚拟化」，
 * 于是全部轮次都挂在 DOM 上——这正是本文件能数轮次的原因，也钉住了「拿不到高度不抛」这条兜底。
 * 虚拟化本身（动态高度补偿、只挂载可见项）jsdom 验不了，属真实浏览器冒烟项。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { createRef } from 'react';
import type { ContentBlock, LogTurn, TextBlock } from './types';
import { nodeIndex } from './render-blocks';
import { VirtualTurnList, type ListController } from './virtual-turn-list';
import { installResizeObserverStub } from '../../testing/resize-observer';

const AT = '2026-10-02T10:44:31.000Z';

// jsdom 没有 `ResizeObserver`：`@tanstack/react-virtual` 与本件自建宿主的高度测量都会 new 它，
// 不打桩挂载即抛（见 src/testing/resize-observer.ts）。
beforeEach(() => {
  installResizeObserverStub();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function textBlock(id: string, text: string): TextBlock {
  return {
    kind: 'text',
    id,
    at: AT,
    messageId: 'm1',
    subagentId: null,
    role: 'assistant',
    source: 'wire',
    assembly: 'snapshot',
    mergeKey: 'main|1|assistant|-',
    segment: 0,
    usage: null,
    text,
  };
}

function turn(round: number, text: string, segment = 0, block: Partial<TextBlock> = {}): LogTurn {
  return {
    round,
    segment,
    at: AT,
    subagentId: null,
    blocks: [{ ...textBlock(`b${segment}-${round}`, text), ...block }] as ContentBlock[],
    // 规则 3 的兜底定位键：夹具里恒等于首块的 `messageId`（`textBlock` 造的就是它）
    fallbackMessageId: 'm1',
    tokens: null,
    durationMs: null,
    running: false,
  };
}

describe('VirtualTurnList', () => {
  it('拿不到高度就不虚拟化：每一项都渲染，读数照实报上去', () => {
    const turns = [turn(1, '第一轮正文'), turn(2, '第二轮正文'), turn(3, '第三轮正文')];
    const onRenderedChange = vi.fn();

    const { container } = render(
      <VirtualTurnList turns={turns} nodes={nodeIndex([])} onRenderedChange={onRenderedChange} />,
    );

    expect(container.querySelectorAll('[data-turn-row]').length).toBe(3);
    expect(screen.getByText('第一轮正文')).toBeInTheDocument();
    expect(screen.getByText('第三轮正文')).toBeInTheDocument();
    // 「已渲染 N / 共 M 轮」那一行现在渲在固定区的原文行（`AgentLogLayout`），本件只负责把两个数报出去
    expect(onRenderedChange).toHaveBeenCalledWith(3, 3);
  });

  it('考题提示词与补充提示是列表里的头几行（跟着列表滚，不钉在顶上）', () => {
    const turns = [turn(1, '第一轮正文')];

    render(
      <VirtualTurnList
        turns={turns}
        nodes={nodeIndex([])}
        userPrompt={{ text: '帮我把 build 脚本修好', at: AT }}
        notices={[<span key="notice">该子任务的对话未转发（只投送了工具调用）</span>]}
      />,
    );

    const prompt = screen.getByTestId('agent-log-user-prompt');
    expect(prompt).toHaveTextContent('考题提示词');
    const notice = screen.getByText('该子任务的对话未转发（只投送了工具调用）');
    expect(prompt.compareDocumentPosition(notice) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(notice.compareDocumentPosition(screen.getByText('第一轮正文')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('controllerRef 暴露跳轮次 / 回到最新，越界不抛', () => {
    const turns = [turn(1, '第一轮正文'), turn(2, '第二轮正文')];
    const controllerRef = createRef<ListController>();

    render(<VirtualTurnList turns={turns} nodes={nodeIndex([])} controllerRef={controllerRef} />);

    expect(controllerRef.current).not.toBeNull();
    expect(() => controllerRef.current?.scrollToTurn(0, 'top')).not.toThrow();
    expect(() => controllerRef.current?.scrollToTurn(1, 'bottom')).not.toThrow();
    expect(() => controllerRef.current?.scrollToBottom()).not.toThrow();
    // 越界（轮次被流式回退掉）时什么都不做，而不是抛
    expect(() => controllerRef.current?.scrollToTurn(99)).not.toThrow();
    expect(typeof controllerRef.current?.renderedCount).toBe('number');
  });

  it('空轮次不抛，读数如实报 0 / 0', () => {
    const controllerRef = createRef<ListController>();
    const onRenderedChange = vi.fn();

    render(
      <VirtualTurnList
        turns={[]}
        nodes={nodeIndex([])}
        controllerRef={controllerRef}
        onRenderedChange={onRenderedChange}
      />,
    );

    expect(onRenderedChange).toHaveBeenCalledWith(0, 0);
    expect(() => controllerRef.current?.scrollToBottom()).not.toThrow();
  });
});

/**
 * **段标题**：追问那一段的第一个轮次之前插一个「追问 ×N」+ 时刻 + **那句追问**的块。
 *
 * 为什么这一个块必须存在：那一段自己的厂商轮次从 1 重新数 ⇒ 时间轴上会出现第二个「轮次 1」，
 * 没有它时读者会把它当成首段的第 1 轮又画了一遍；而只有「追问 ×N」没有正文时，
 * 读者还要往下找「他到底追问了什么」——那句正文由数据层从轮次的展示块里提出来
 * （`AgentLogModel.segments`），段标题是它**唯一**的出口。
 */
describe('VirtualTurnList：段标题', () => {
  const twoSegments = [turn(1, '首段的第 1 轮'), turn(2, '首段的第 2 轮'), turn(1, '追问段的第 1 轮', 1)];
  const oneSegmentFact = [{ segment: 1, at: AT, text: '再翻译成英文' }];

  it('主会话节点：段首插一个「追问 ×1」标题（含正文），且只有一个', () => {
    render(<VirtualTurnList turns={twoSegments} nodes={nodeIndex([])} segmentDividers segments={oneSegmentFact} />);

    const dividers = screen.getAllByTestId('agent-log-segment-divider');
    expect(dividers).toHaveLength(1);
    expect(dividers[0]).toHaveTextContent('追问 ×1');
    // **正文就在这个块里**（不是下一条消息）：用户口径「分割线里还应包括追问的内容」
    expect(dividers[0]).toHaveTextContent('再翻译成英文');
    // 位置：在首段那两轮之后、追问段那一轮之前
    const divider = dividers[0]!;
    expect(divider.compareDocumentPosition(screen.getByText('首段的第 2 轮')) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
    expect(divider.compareDocumentPosition(screen.getByText('追问段的第 1 轮')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('单段（没有追问）一个都不插（首段的分隔就是题面那张卡片）', () => {
    render(<VirtualTurnList turns={[turn(1, '首段的第 1 轮')]} nodes={nodeIndex([])} segmentDividers segments={[]} />);
    expect(screen.queryByTestId('agent-log-segment-divider')).toBeNull();
  });

  it('子会话节点（`segmentDividers` 不给）：轮次照旧分段，但不画那一个块', () => {
    render(<VirtualTurnList turns={twoSegments} nodes={nodeIndex([])} segments={oneSegmentFact} />);
    expect(screen.queryByTestId('agent-log-segment-divider')).toBeNull();
    // 两个「轮次 1」都还在（分段只影响标题那一行，不影响轮次本身）
    expect(screen.getAllByText('轮次 1')).toHaveLength(2);
  });

  /**
   * **数据层没给出这一段的结论时不画**：只有「追问 ×N」而没有正文的标题会把读者引向
   * 「他追问了什么」而答不出来——宁可不画（老调用方 / 段事实缺失那一档）。
   */
  it('`segments` 缺失（老调用方）：一个标题都不画，而不是画一行只有号的', () => {
    render(<VirtualTurnList turns={twoSegments} nodes={nodeIndex([])} segmentDividers />);
    expect(screen.queryByTestId('agent-log-segment-divider')).toBeNull();
  });

  it('两次追问：各有一个自己的标题，各带自己那句正文', () => {
    render(
      <VirtualTurnList
        turns={[turn(1, '首段的第 1 轮'), turn(1, '追问 ×1 的答复', 1), turn(1, '追问 ×2 的答复', 2)]}
        nodes={nodeIndex([])}
        segmentDividers
        segments={[
          { segment: 1, at: AT, text: '逐句用普通话解释诗意' },
          { segment: 2, at: AT, text: '再翻译成英文' },
        ]}
      />,
    );

    const dividers = screen.getAllByTestId('agent-log-segment-divider');
    // 两次追问 = 两个标题，不是把一个累积起来
    expect(dividers).toHaveLength(2);
    expect(dividers[0]).toHaveTextContent('追问 ×1');
    expect(dividers[0]).toHaveTextContent('逐句用普通话解释诗意');
    expect(dividers[1]).toHaveTextContent('追问 ×2');
    expect(dividers[1]).toHaveTextContent('再翻译成英文');
    // 标题在它自己那一段的第一个轮次之前；内容不重复出现在别处
    expect(dividers[0]!.compareDocumentPosition(dividers[1]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getAllByText('逐句用普通话解释诗意')).toHaveLength(1);
  });
});
