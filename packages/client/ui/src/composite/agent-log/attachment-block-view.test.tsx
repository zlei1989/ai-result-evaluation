/**
 * AttachmentBlockView：认识的**真实附件**。
 *
 * 三条守卫：
 *   · `image` / `file` 各有中文标；
 *   · `path === null`（内联附件）显示「内联内容，无路径」——**不显示空白、也不编造路径**；
 *   · **本期不加载缩略图**：`<img>` 一个都不能有（加载远程资源会牵出鉴权、体积、CSP 三件事）。
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AttachmentBlockView } from './attachment-block-view';
import type { AttachmentBlock } from './types';

function attachment(overrides: Partial<AttachmentBlock> = {}): AttachmentBlock {
  return {
    kind: 'attachment',
    id: 'att-1',
    at: '2026-10-02T08:00:00.000Z',
    messageId: 'msg-1',
    subagentId: null,
    role: 'user',
    source: 'wire',
    assembly: 'snapshot',
    mergeKey: 'main|1|assistant|-',
    usage: null,
    attachmentKind: 'image',
    path: 'D:\\runs\\shot.png',
    mimeType: 'image/png',
    ...overrides,
  };
}

describe('AttachmentBlockView', () => {
  it('图片：标「图片」+ 路径 + MIME', () => {
    render(<AttachmentBlockView block={attachment()} />);

    expect(screen.getByText('图片')).toBeInTheDocument();
    expect(screen.getByText('D:\\runs\\shot.png')).toBeInTheDocument();
    expect(screen.getByText('image/png')).toBeInTheDocument();
  });

  it('文件：标「文件」', () => {
    render(
      <AttachmentBlockView
        block={attachment({ attachmentKind: 'file', path: 'D:\\runs\\report.md', mimeType: 'text/markdown' })}
      />,
    );

    expect(screen.getByText('文件')).toBeInTheDocument();
    expect(screen.getByText('D:\\runs\\report.md')).toBeInTheDocument();
  });

  it('内联附件（path === null）显示「内联内容，无路径」而不是空白', () => {
    render(<AttachmentBlockView block={attachment({ path: null })} />);

    expect(screen.getByText('内联内容，无路径')).toBeInTheDocument();
  });

  it('本期不加载缩略图：不出现 <img>', () => {
    const { container } = render(<AttachmentBlockView block={attachment()} />);

    expect(container.querySelector('img')).toBeNull();
  });

  it('MIME 没采到时不出这一格（也不留一个空标签）', () => {
    const { container } = render(<AttachmentBlockView block={attachment({ mimeType: null })} />);

    expect(container.textContent).not.toContain('image/png');
  });
});
