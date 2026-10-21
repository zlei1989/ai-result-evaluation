/**
 * ImageViewBlockView：模型看过的一张图片。
 *
 * 四条守卫：
 *   · 路径照原文显示（它是这一块的身份，预览不了也在）；
 *   · 给 `srcOf` 且路径在工作区内 ⇒ 画缩略图，`src` 就是 `srcOf` 的返回值；
 *   · **不给 `srcOf`** ⇒ 如实说「当前视图不提供图片预览」，不留一个空框；
 *   · `previewPath === null`（不在该候选工作区内）⇒ 说另一句话，且**一个 `<img>` 都不许有**
 *     （拿宿主绝对路径去请求等于让服务端开一个任意文件读的口子）。
 */
import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ImageViewBlockView } from './image-view-block-view';
import { installResizeObserverStub } from '../../testing/resize-observer';
import type { ImageViewBlock } from './types';

// antd 的 `Image` 挂着 `@rc-component/resize-observer` 的观察器：jsdom 没有它，不打桩挂载即抛
// （见 `src/testing/resize-observer.ts`）。本文件的三个用例都只关心画了什么。
beforeEach(() => {
  installResizeObserverStub();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function imageView(overrides: Partial<ImageViewBlock> = {}): ImageViewBlock {
  return {
    kind: 'image-view',
    id: 'img-1',
    at: '2026-10-02T08:00:00.000Z',
    messageId: 'msg-1',
    subagentId: null,
    role: 'assistant',
    source: 'wire',
    assembly: 'snapshot',
    mergeKey: 'main|1|assistant|-',
    segment: 0,
    usage: null,
    path: 'shots/a.png',
    previewPath: 'shots/a.png',
    ...overrides,
  };
}

describe('ImageViewBlockView', () => {
  it('画缩略图：路径 + 标「查看图片」+ `src` 取自 `srcOf`；预览入口由 antd 承担', () => {
    const { container } = render(
      <ImageViewBlockView block={imageView()} srcOf={(path) => `/api/image?path=${encodeURIComponent(path)}`} />,
    );

    expect(screen.getByText('查看图片')).toBeInTheDocument();
    expect(screen.getByText('shots/a.png')).toBeInTheDocument();
    const img = container.querySelector('img');
    expect(img?.getAttribute('src')).toBe('/api/image?path=shots%2Fa.png');
    expect(img?.getAttribute('alt')).toBe('shots/a.png');

    // 点击放大由 antd 的预览承担：`preview` 打开时根节点才挂 `role="button"` 与那层 cover，
    // 本件因此不必自造弹层。**不点开**：放大器一开会量滚动条（jsdom 的 `getComputedStyle`
    // 不支持伪元素），那是环境缺口而不是本件的行为。
    const root = container.querySelector('.ant-image');
    if (root === null) throw new Error('缩略图的容器没有画出来');
    expect(root.getAttribute('role')).toBe('button');
    expect(container.querySelector('.ant-image-cover')).not.toBeNull();
  });

  it('不给 `srcOf` ⇒ 如实说「当前视图不提供图片预览」，不画 `<img>`', () => {
    const { container } = render(<ImageViewBlockView block={imageView()} />);

    expect(screen.getByText('当前视图不提供图片预览')).toBeInTheDocument();
    expect(container.querySelector('img')).toBeNull();
  });

  it('`previewPath === null`（不在工作区内）⇒ 说另一句话，路径照旧显示', () => {
    const { container } = render(
      <ImageViewBlockView
        block={imageView({ path: '/tmp/elsewhere/a.png', previewPath: null })}
        srcOf={() => '/api/image?path=whatever'}
      />,
    );

    expect(screen.getByText('这张图不在该候选工作区内，无法预览')).toBeInTheDocument();
    expect(screen.getByText('/tmp/elsewhere/a.png')).toBeInTheDocument();
    expect(container.querySelector('img')).toBeNull();
  });
});
