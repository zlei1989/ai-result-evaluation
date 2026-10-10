/**
 * RawOutputPanel：两种变体共用一个件（固定区的逐行原文 / 卡片底部的单份原文）。
 *
 * 七条守卫： * · 入口是**按钮**、正文在**二级抽屉**里：抽屉关着时正文一个节点都不在
 * DOM 里（`destroyOnHidden`），点开才出现——这条同时钉住了「原文不再挤占主抽屉高度」；
 * · 逐行渲染 `[HH:mm:ss] source 原文`（时间不写死时钟，只钉形状——它走本机时区）；
 * · `summary` 有就**优先**渲染，且 `text` 原文**仍在**；
 * · `summary === null` 时**不拿 `text` 顶替**（变异体 (w)：`summary ?? text` 会让原文出现两次）；
 * · `lines` 为空数组时**连入口都不渲染**；
 * · 单份变体 `raw === null` 说「结果未采集」，`truncation.kind === 'unknown'` 说「可能不完整」
 * 而**绝不说「完整」**（变异体 (x)）；
 * · 开合态**受控优先**：给了 `open` 就归调用方，且点按钮与关抽屉都回调一次
 * （固定区那一支靠这个回调向数据层上报「我需要了」，漏了它就等于把懒加载的触发点丢了）； * · **本件不自带布局容器**：两个按钮就是渲染根上的直接子节点，
 * 没有中间那一层——把 `Flex` 包回去时那条红。
 */
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RawOutputPanel } from './raw-output-panel';
import { installResizeObserverStub } from '../../testing/resize-observer';
import type { AgentLogDiagnostics, ToolCardResult } from './types';

/**
 * 正文走虚拟滚动（`base/virtual-list.tsx`），而 `Listy` 内部 `new ResizeObserver(...)`
 * （`@rc-component/resize-observer` 的 `ensureResizeObserver` 读**全局构造器**）：
 * jsdom 里不打桩，抽屉一打开就抛 `ReferenceError`。与本仓其它渲染 `Table` / `Listy` 的用例同处置。
 *
 * 桩**不改变断言口径**：jsdom 的 `clientHeight` 恒为 0 ⇒ `VirtualList` 不给 `height`
 * ⇒ `Listy` 全量渲染，所以下面「每一行都在」的断言照样成立（那是它的退化口径，设计如此）。
 */
beforeEach(() => {
  installResizeObserverStub();
});

const diagnostics: AgentLogDiagnostics = {
  lines: [
    { at: '2026-10-02T08:00:01.000Z', source: 'stdout', text: '开始改文件', summary: '收到一条未识别的厂商事件' },
    { at: '2026-10-02T08:00:02.000Z', source: 'stderr', text: '警告原文', summary: null },
  ],
  truncatedReason: null,
};

describe('RawOutputPanel（diagnostics 变体）', () => {
  it('入口是按钮，正文在抽屉里（关着时正文不在 DOM）', () => {
    render(<RawOutputPanel source={{ kind: 'diagnostics', diagnostics }} open={false} onOpenChange={vi.fn()} />);

    expect(screen.getByTestId('raw-output-open')).toHaveTextContent('原始输出 2 条');
    expect(screen.queryByTestId('agent-log-diagnostics')).toBeNull();
    expect(screen.queryByTestId('nested-drawer')).toBeNull();
  });

  it('受控打开时逐行渲染 `[HH:mm:ss] source 原文`，标题带条数', () => {
    render(<RawOutputPanel source={{ kind: 'diagnostics', diagnostics }} open onOpenChange={vi.fn()} />);

    expect(screen.getByTestId('agent-log-diagnostics')).toBeInTheDocument();
    expect(screen.getByText(/^\[\d{2}:\d{2}:\d{2}\] stdout 开始改文件$/)).toBeInTheDocument();
    expect(screen.getByText(/^\[\d{2}:\d{2}:\d{2}\] stderr 警告原文$/)).toBeInTheDocument();
    // 入口按钮与抽屉标题同一句话（点开前后指向的是同一件事）
    expect(screen.getAllByText('原始输出 2 条').length).toBeGreaterThanOrEqual(2);
  });

  it('summary 非空时优先渲染，且 text 原文仍逐字给出', () => {
    render(<RawOutputPanel source={{ kind: 'diagnostics', diagnostics }} open onOpenChange={vi.fn()} />);

    expect(screen.getByText('收到一条未识别的厂商事件')).toBeInTheDocument();
    expect(screen.getByText(/^\[\d{2}:\d{2}:\d{2}\] stdout 开始改文件$/)).toBeInTheDocument();
  });

  it('summary 为 null 时不拿 text 顶替（那段原文在界面上只出现一次）', () => {
    render(<RawOutputPanel source={{ kind: 'diagnostics', diagnostics }} open onOpenChange={vi.fn()} />);

    /**
     * 判据必须按**全文出现次数**数，不能只数带 `[时间] 来源` 前缀的那一行：
     * `summary ?? text` 那条错路渲染出来的是**没有前缀**的 `警告原文`，只查前缀的写法会放过它
     * （这正是「守卫没有区分力」的典型形态——变异体 (w) 跑绿过一次）。
     *
     * ⚠️ 数的是 `document.body` 而**不是 `render` 的 `container`**：antd 的抽屉默认
     * `getContainer = body`，是**portal** 出去的——正文根本不在 `container` 子树里，
     * 按 container 数会恒得 0（这条用例第一次跑就是这么假红的）。
     */
    const occurrences = (document.body.textContent ?? '').split('警告原文').length - 1;
    expect(occurrences).toBe(1);
  });

  it('lines 为空数组时不渲染入口', () => {
    const { container } = render(
      <RawOutputPanel
        source={{ kind: 'diagnostics', diagnostics: { lines: [], truncatedReason: null } }}
        open={false}
        onOpenChange={vi.fn()}
      />,
    );

    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText(/原始输出/)).toBeNull();
  });

  it('truncatedReason 非空时如实显示那句话', () => {
    render(
      <RawOutputPanel
        source={{ kind: 'diagnostics', diagnostics: { ...diagnostics, truncatedReason: '只保留了最近 200 行' } }}
        open
        onOpenChange={vi.fn()}
      />,
    );

    expect(screen.getByText('只保留了最近 200 行')).toBeInTheDocument();
  });

  it('给了 onRetry 才渲染「重新读取」，点了会回调', () => {
    const onRetry = vi.fn();
    const { unmount } = render(
      <RawOutputPanel source={{ kind: 'diagnostics', diagnostics }} open={false} onOpenChange={vi.fn()} />,
    );
    expect(screen.queryByText('重新读取')).toBeNull();
    unmount();

    render(
      <RawOutputPanel
        source={{ kind: 'diagnostics', diagnostics }}
        open={false}
        onOpenChange={vi.fn()}
        onRetry={onRetry}
      />,
    );
    screen.getByText('重新读取').click();
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  /**
   * **本件不自带布局容器**（把包裹那一层去掉，按钮拿出来）。
   *
   * 判据是**父节点身份**而不是「按钮在不在」：包一层 `Flex` 时按钮照样在页面上，只有
   * 「它的父节点是本件的渲染根」才能区分「拿出来」与「还嵌在里面」。
   * 顺带钉住「两个按钮同层」——重试按钮若被挪进别处，第二条也红。
   */
  it('不自带容器：两个入口按钮都是渲染根的直接子节点（没有中间那一层）', () => {
    const { container } = render(
      <RawOutputPanel
        source={{ kind: 'diagnostics', diagnostics }}
        open={false}
        onOpenChange={vi.fn()}
        onRetry={vi.fn()}
      />,
    );

    const open = screen.getByTestId('raw-output-open');
    const retry = screen.getByRole('button', { name: '重新读取' });

    expect(container.childElementCount).toBe(2);
    expect(open.parentElement, '入口按钮还嵌在中间那一层容器里').toBe(container);
    expect(retry.parentElement, '「重新读取」与入口按钮不同层').toBe(container);
  });

  /**
   * 开合**一律受控**（`agent-log-layering.test.ts` (d)：L0/L1 不许持态）。
   * 这条钉住两件事：① 关着时正文不进 DOM（`destroyOnHidden`）；② 点入口按钮**只上报**、
   * 由调用方决定开不开——固定区靠这个回调向数据层上报「我需要了」，漏了它不会有任何别的
   * 用例变红（原文照样能看，只是永远不再重取）。
   */
  it('受控：点入口按钮上报一次，正文出现与否完全听调用方的', () => {
    const onOpenChange = vi.fn();
    const { rerender } = render(
      <RawOutputPanel source={{ kind: 'diagnostics', diagnostics }} open={false} onOpenChange={onOpenChange} />,
    );
    expect(screen.queryByTestId('agent-log-diagnostics')).toBeNull();

    fireEvent.click(screen.getByTestId('raw-output-open'));
    expect(onOpenChange).toHaveBeenCalledWith(true);
    // 受控：调用方没把 `open` 置真，正文就不该出现（本件不许自作主张）
    expect(screen.queryByTestId('agent-log-diagnostics')).toBeNull();

    // 调用方把 `open` 置真之后正文才进 DOM
    rerender(<RawOutputPanel source={{ kind: 'diagnostics', diagnostics }} open onOpenChange={onOpenChange} />);
    expect(screen.getByTestId('agent-log-diagnostics')).toBeInTheDocument();
  });
});

describe('RawOutputPanel（single 变体）', () => {
  const rawPanel = (result: ToolCardResult): ReactNode => (
    <RawOutputPanel source={{ kind: 'single', result }} open onOpenChange={vi.fn()} />
  );

  /**
   * JSON 原文要高亮格式化：这一格走 `JsonText` 而不是**逐字原文** ——
   * `JsonText` —— 是 JSON 就缩进格式化 + 高亮，不是就**逐字原样**（下一条钉回落那一支）。
   * 判据留在**正文宿主**（`raw-output-body`）上：`getByText('{"ok":true}')` 那种整串匹配
   * 在新形态下必然查不到（JSON 被切成了多个 token 节点），而它并不能分辨「格式化了没有」。
   */
  it('默认入口文案是「原始结果」，JSON 正文被格式化并带高亮', () => {
    render(rawPanel({ ok: true, raw: '{"ok":true}', truncation: { kind: 'none' } }));

    expect(screen.getByTestId('raw-output-open')).toHaveTextContent('原始结果');
    const body = screen.getByTestId('raw-output-body');
    // 多行 + 缩进 + 冒号后的空格：原文里一个都没有
    expect(body.textContent).toContain('\n  "ok": true');
    expect(body.textContent).not.toContain('{"ok":true}');
    expect(body.querySelectorAll('[data-json-token="key"]')).toHaveLength(1);
  });

  it('正文不是 JSON 时逐字给出、一个高亮节点都不留（回落那一支与改造前一致）', () => {
    const prose = 'a.txt\nb.txt';
    render(rawPanel({ ok: true, raw: prose, truncation: { kind: 'none' } }));

    const body = screen.getByTestId('raw-output-body');
    expect(body.textContent).toBe(prose);
    expect(body.querySelectorAll('[data-json-token]')).toHaveLength(0);
  });

  it('raw 为 null 时显示「结果未采集」而不是空白', () => {
    render(rawPanel({ ok: false, raw: null, truncation: { kind: 'none' } }));

    expect(screen.getByText('结果未采集')).toBeInTheDocument();
  });

  it('截断标记没采到（unknown）时说「可能不完整」，绝不说「完整」', () => {
    render(rawPanel({ ok: true, raw: '长文本', truncation: { kind: 'unknown' } }));

    expect(screen.getByText(/输出可能不完整/)).toBeInTheDocument();
    expect(screen.queryByText(/^输出完整$/)).toBeNull();
  });

  it('label 可覆盖文案（卡片底部换文案用）', () => {
    render(
      <RawOutputPanel
        source={{ kind: 'single', result: { ok: true, raw: 'x', truncation: { kind: 'none' } } }}
        open
        onOpenChange={vi.fn()}
        label="原始参数"
      />,
    );

    expect(screen.getByTestId('raw-output-open')).toHaveTextContent('原始参数');
  });
});
