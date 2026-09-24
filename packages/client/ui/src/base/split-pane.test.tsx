/**
 * SplitPane：两栏顺序、侧栏宽度、宿主可滚动。
 * 关键点：sidePosition='end' 时侧栏必须排在主区**之后**（本项目右栏全靠它）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SplitPane } from './split-pane';
import { installResizeObserverStub } from '../testing/resize-observer';

// jsdom 不提供 ResizeObserver，而 antd 的 Splitter 内部（@rc-component/resize-observer）
// 直接读全局构造器、没有 polyfill：不打桩，挂载即抛 ReferenceError（见 src/testing/resize-observer.ts）。
beforeEach(() => {
  installResizeObserverStub();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SplitPane', () => {
  // `collapseBelow` 的取值**有意不设守卫**：它只喂给 Splitter.Panel.min，而 jsdom 里容器宽恒未测量
  // ⇒ 分隔条的 aria-valuemin/now/max 全落到 0、合成拖拽的位移也被夹成 0，删掉它没有任何 DOM 可观测量。

  it('sidePosition=start 时侧栏在前', () => {
    render(
      <SplitPane side={<span>侧栏</span>} sidePosition="start">
        <span>主区</span>
      </SplitPane>,
    );
    const side = screen.getByText('侧栏');
    const main = screen.getByText('主区');
    expect(side.compareDocumentPosition(main) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('sidePosition=end 时侧栏在后（右栏形态）', () => {
    render(
      <SplitPane side={<span>侧栏</span>} sidePosition="end">
        <span>主区</span>
      </SplitPane>,
    );
    const side = screen.getByText('侧栏');
    const main = screen.getByText('主区');
    expect(main.compareDocumentPosition(side) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('两栏宿主都可滚动、都有 minWidth:0（否则长内容会顶宽父级）', () => {
    render(
      <SplitPane side={<span>侧栏</span>} sidePosition="end">
        <span>主区</span>
      </SplitPane>,
    );
    const sideHost = screen.getByTestId('split-side-host');
    const mainHost = screen.getByTestId('split-main-host');
    for (const host of [sideHost, mainHost]) {
      expect(host.style.overflow).toBe('auto');
      expect(host.style.minWidth).toBe('0px');
      expect(host.style.height).toBe('100%');
    }
  });

  it('侧栏宽度落到 Panel 上（sideWidth 落成 Panel 的内联 flex，而不是只渲染出一个分隔条）', () => {
    const { container } = render(
      <SplitPane side={<span>侧栏</span>} sidePosition="end" sideWidth={360}>
        <span>主区</span>
      </SplitPane>,
    );
    // 两栏必定渲染出一个分隔条
    expect(container.querySelectorAll('.ant-splitter-bar').length).toBe(1);
    // 但「有分隔条」与 sideWidth 无关：删掉 defaultSize={sideWidth} 它照样绿。
    // 唯一能看见 sideWidth 的是 Panel 的内联 flex —— useSizes 用 defaultSize 种 innerSizes，
    // 而 jsdom 里容器宽测不到（containerSize 为 undefined）⇒ panelSizes 回落成 sizes，
    // 于是侧栏 InternalPanel 拿到 size=360 ⇒ flexBasis:360px / flexGrow:0（主线那栏则是 auto / 1）。
    const sidePanel = screen.getByTestId('split-side-host').closest<HTMLElement>('.ant-splitter-panel');
    expect(sidePanel?.style.flexBasis).toBe('360px');
    expect(sidePanel?.style.flexGrow).toBe('0');
  });
});
