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

// jsdom 没有 `ResizeObserver`：`Listy` 内部（`@rc-component/virtual-list`）会 new 它，
// 不打桩挂载即抛（见 src/testing/resize-observer.ts）。本件自己也会 new 一个来量高度。
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
    usage: null,
    text,
  };
}

function turn(round: number, text: string): LogTurn {
  return {
    round,
    at: AT,
    subagentId: null,
    blocks: [textBlock(`b${round}`, text)] as ContentBlock[],
    tokens: null,
    durationMs: null,
    running: false,
  };
}

describe('VirtualTurnList', () => {
  it('拿不到高度就不虚拟化：每一项都渲染，「已渲染 N / 共 M 轮」如实给出', () => {
    const turns = [turn(1, '第一轮正文'), turn(2, '第二轮正文'), turn(3, '第三轮正文')];

    const { container } = render(<VirtualTurnList turns={turns} nodes={nodeIndex([])} />);

    expect(container.querySelectorAll('[data-turn-row]').length).toBe(3);
    expect(screen.getByText('第一轮正文')).toBeInTheDocument();
    expect(screen.getByText('第三轮正文')).toBeInTheDocument();
    expect(screen.getByText('已渲染 3 / 共 3 轮')).toBeInTheDocument();
  });

  it('用户提示词与补充提示是列表里的头几行（跟着列表滚，不钉在顶上）', () => {
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
    expect(prompt).toHaveTextContent('用户提示词');
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

  it('空轮次不抛，尾部那一行如实说 0 / 0', () => {
    const controllerRef = createRef<ListController>();

    render(<VirtualTurnList turns={[]} nodes={nodeIndex([])} controllerRef={controllerRef} />);

    expect(screen.getByText('已渲染 0 / 共 0 轮')).toBeInTheDocument();
    expect(() => controllerRef.current?.scrollToBottom()).not.toThrow();
  });
});
