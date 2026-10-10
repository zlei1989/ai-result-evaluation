/**
 * UnrecognizedBlockView：我们不认识的厂商载荷。
 *
 * 三条守卫：
 *   · **默认收起**：`open === false` 时正文**不在 DOM 里**（antd 的 `Collapse` 收起时不渲染 children）；
 *   · 展开后给出**载荷原文**（是 JSON ⇒ 走 `JsonText` 缩进格式化 + 高亮），而不是把 `vendorType` 当正文；
 *   · `raw === null` 时说「原样载荷未采集」，不留空面板。
 *
 * ⚠️ 判据不能再用 `getByText(RAW)` 整串匹配：JSON 会被切成多个 token 节点
 * （`getByText` 只看元素的**直接文本子节点**，于是它会恒查不到——一条永远绿的假守卫）。
 * 改为断言**载荷里独有的片段**（`改实现`），它与标签里的 `todo_list` 分得开。
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { UnrecognizedBlockView } from './unrecognized-block-view';
import type { UnrecognizedPayloadBlock } from './types';

const RAW = '{"type":"todo_list","items":[{"text":"改实现"}]}';

function unrecognized(overrides: Partial<UnrecognizedPayloadBlock> = {}): UnrecognizedPayloadBlock {
  return {
    kind: 'unrecognized',
    id: 'blk-unknown',
    at: '2026-10-02T08:00:00.000Z',
    messageId: 'msg-1',
    subagentId: null,
    role: 'assistant',
    source: 'wire',
    assembly: 'snapshot',
    mergeKey: 'main|1|assistant|-',
    usage: null,
    reason: 'unrecognized',
    vendorType: 'todo_list',
    raw: RAW,
    ...overrides,
  };
}

describe('UnrecognizedBlockView', () => {
  it('默认收起：正文不在 DOM 里，标题与厂商类型仍在', () => {
    const { container } = render(<UnrecognizedBlockView block={unrecognized()} open={false} onOpenChange={vi.fn()} />);

    expect(screen.getByText('未识别的厂商载荷')).toBeInTheDocument();
    expect(screen.getByText('todo_list')).toBeInTheDocument();
    // 载荷独有的片段（标签里只有 `todo_list`，没有这一句）⇒ 收起时它一个字符都不该在
    expect(container.textContent).not.toContain('改实现');
  });

  it('展开后给出载荷原文（JSON ⇒ 格式化 + 高亮），且不是拿厂商类型顶替', () => {
    const { container } = render(<UnrecognizedBlockView block={unrecognized()} open onOpenChange={vi.fn()} />);

    const text = container.textContent ?? '';
    // 载荷的键与值都在，且已格式化（原文里冒号后没有空格）
    expect(text).toContain('"type": "todo_list"');
    expect(text).toContain('"text": "改实现"');
    expect(text).not.toContain('{"type":"todo_list"');
    // 三个键（type / items / text）都带高亮标记
    expect(container.querySelectorAll('[data-json-token="key"]')).toHaveLength(3);
  });

  it('raw 为 null 时说「原样载荷未采集」', () => {
    render(<UnrecognizedBlockView block={unrecognized({ raw: null })} open onOpenChange={vi.fn()} />);

    expect(screen.getByText('原样载荷未采集')).toBeInTheDocument();
  });

  it('vendorType 为空时不画一个空 Tag', () => {
    const { container } = render(
      <UnrecognizedBlockView block={unrecognized({ vendorType: null })} open={false} onOpenChange={vi.fn()} />,
    );

    expect(container.querySelectorAll('.ant-tag')).toHaveLength(0);
  });

  it('收起态点标题会把「要打开」上报给调用方（受控）', () => {
    const onOpenChange = vi.fn();
    render(<UnrecognizedBlockView block={unrecognized()} open={false} onOpenChange={onOpenChange} />);

    screen.getByText('未识别的厂商载荷').click();

    expect(onOpenChange).toHaveBeenCalledWith(true);
  });
});
