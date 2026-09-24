/** EllipsisText：内容渲染与全量提示。 */
import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Tooltip } from 'antd';
import { isValidElement } from 'react';
import { EllipsisText } from './ellipsis-text';
import { installResizeObserverStub } from '../testing/resize-observer';

// jsdom 不提供 ResizeObserver，而 Typography 的 ellipsis（单行省略）内部
// （@rc-component/resize-observer）会直接 new 全局构造器：不打桩，挂载即抛
// ReferenceError —— 环境缺口，不是被测代码的问题（见 src/testing/resize-observer.ts）。
beforeEach(() => {
  installResizeObserverStub();
});

describe('EllipsisText', () => {
  it('渲染文本', () => {
    render(<EllipsisText text="D:/a/very/long/path/to/module" />);
    expect(screen.getByText('D:/a/very/long/path/to/module')).toBeInTheDocument();
  });

  it('宽度固定时落到 style（保证列宽不被长文本顶开）', () => {
    render(<EllipsisText text="abc" width={120} />);
    expect(screen.getByText('abc').style.maxWidth).toBe('120px');
  });

  it('monospace 时用 code 样式（哈希 / 路径可读性）', () => {
    render(<EllipsisText text="abcdef1" monospace />);
    expect(screen.getByText('abcdef1').tagName.toLowerCase()).toBe('code');
  });

  it('空串不挂 Tooltip（空浮层无意义）', () => {
    const { container } = render(<EllipsisText text="" />);
    expect(container.querySelector('.ant-tooltip')).toBeNull();
    // 上面这条**单独不构成守卫**：antd 的浮层要 hover 才渲染，而且渲染在 body 的 portal 里，
    // container 内本来就永远查不到 .ant-tooltip。实测（包与不包 Tooltip 逐字节比对 innerHTML）：
    // 两种写法的 DOM 完全相同，而 <Tooltip title=""> 即便 hover 也不开浮层——DOM 层面这条契约
    // 不可观测。要钉住它只能在元素层断言：空串时返回的是裸内容。
    const bare = EllipsisText({ text: '' });
    expect(isValidElement(bare)).toBe(true);
    expect(isValidElement(bare) ? bare.type : null).not.toBe(Tooltip);
    // 对照组：证明这条探针真的能探到 Tooltip（否则上面那条断言只是在断言「不是元素」）。
    const wrapped = EllipsisText({ text: 'abc' });
    expect(isValidElement(wrapped) ? wrapped.type : null).toBe(Tooltip);
  });
});
