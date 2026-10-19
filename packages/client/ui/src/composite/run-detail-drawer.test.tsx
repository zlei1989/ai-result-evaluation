/**
 * 评测详情抽屉（同一个抽屉 + 页签头）的两条核心行为：
 *
 *   1. **切页签不卸载**：日志页签里的滚动位置、展开过的工具行、过滤条件在
 *      「日志 → 变更 → 日志」之后仍在。这是本形态存在的理由——`destroyOnHidden`
 *      会把这三样一起丢掉，切回来只能从头找。
 *   2. **嵌套层打开时主抽屉让位**：二级层（环境信息 / 原始输出）打开后，
 *      主抽屉必须从 Base UI 的 `--nested-dialogs` 计数拿到退出量，而不是写死 360px。
 *
 * jsdom 没有布局引擎，「让位」只能证明**机制**（计数变量 + 内联几何），
 * 真实位移量在冒烟里按 `getBoundingClientRect()` 量。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState, type ReactNode } from 'react';
import { installResizeObserverStub } from '../testing/resize-observer';
import { NestedDrawer } from '../base/nested-drawer';
import { RunDetailDrawer, type RunDetailTab } from './run-detail-drawer';

beforeEach(() => {
  installResizeObserverStub();
});

/**
 * 日志页签的夹具：三样**组件内部状态**分别对应滚动位置、折叠态、过滤条件。
 * 只要切页签时这棵树被卸载，三样就都回到初值——判据因此不依赖任何实现细节。
 */
function LogPanel(): ReactNode {
  const [toolsOpen, setToolsOpen] = useState(false);
  const [filter, setFilter] = useState('');
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <label>
        过滤
        <input aria-label="过滤" value={filter} onChange={(event) => setFilter(event.target.value)} />
      </label>
      <button type="button" onClick={() => setToolsOpen((open) => !open)}>
        展开工具行
      </button>
      {toolsOpen && <p>工具参数：完整命令</p>}
      <div data-testid="log-scroller" style={{ height: 120, overflowY: 'auto' }}>
        <div style={{ height: 2000 }}>日志正文</div>
      </div>
    </div>
  );
}

function Host({ log }: { log: ReactNode }): ReactNode {
  const [tab, setTab] = useState<RunDetailTab>('log');
  return (
    <RunDetailDrawer
      open
      onClose={vi.fn()}
      activeTab={tab}
      onTabChange={setTab}
      log={log}
      diff={<p>变更正文</p>}
      score={<p>评分正文</p>}
    />
  );
}

describe('评测详情抽屉：切页签不丢状态', () => {
  it('日志页签滚到中间、展开工具行、填过过滤条件；切到变更再切回，三者都还在', async () => {
    render(<Host log={<LogPanel />} />);

    const scroller = screen.getByTestId('log-scroller');
    scroller.scrollTop = 120;
    fireEvent.click(screen.getByRole('button', { name: '展开工具行' }));
    fireEvent.change(screen.getByLabelText('过滤'), { target: { value: 'tool' } });

    // 同一个抽屉在切换页签，不是「关一个、开一个」
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    fireEvent.click(screen.getByRole('tab', { name: '变更' }));
    expect(await screen.findByText('变更正文')).toBeInTheDocument();
    expect(screen.getAllByRole('dialog')).toHaveLength(1);

    fireEvent.click(screen.getByRole('tab', { name: '日志' }));

    await waitFor(() => expect(screen.getByTestId('log-scroller')).toBeVisible());
    // 同一个 DOM 节点：不是「重新挂载之后把值恢复回去」，是真的没卸载
    expect(screen.getByTestId('log-scroller')).toBe(scroller);
    expect(scroller.scrollTop).toBe(120);
    expect(screen.getByText('工具参数：完整命令')).toBeInTheDocument();
    expect(screen.getByLabelText('过滤')).toHaveValue('tool');
  });
});

describe('评测详情抽屉：嵌套层让位', () => {
  it('嵌套抽屉打开 → 主抽屉进入 nested 态，几何读 --nested-dialogs（不再写死 360px）', async () => {
    function NestedHost(): ReactNode {
      const [nestedOpen, setNestedOpen] = useState(false);
      return (
        <Host
          log={
            <div>
              <button type="button" onClick={() => setNestedOpen(true)}>
                打开环境
              </button>
              <NestedDrawer open={nestedOpen} onClose={() => setNestedOpen(false)} title="环境信息">
                环境正文
              </NestedDrawer>
            </div>
          }
        />
      );
    }

    render(<NestedHost />);
    fireEvent.click(screen.getByRole('button', { name: '打开环境' }));
    expect(await screen.findByText('环境正文')).toBeInTheDocument();

    const main = screen.getByTestId('run-detail-drawer');
    // Base UI 在父弹层上挂的嵌套信号：计数与 data 属性同时存在
    await waitFor(() => expect(main).toHaveAttribute('data-nested-dialog-open'));
    expect(main.style.getPropertyValue('--nested-dialogs')).toBe('1');

    // 让位量由计数变量驱动；写死像素就会在这条断言上红
    const shift = main.style.getPropertyValue('--drawer-nested-shift');
    expect(shift).toContain('--nested-dialogs');
    expect(shift).not.toMatch(/\b360(?:px)?\b/);
    // 位移量的消费方在全局样式里（`[data-drawer='main']`），主抽屉必须有这个标记
    expect(main).toHaveAttribute('data-drawer', 'main');
  });
});
