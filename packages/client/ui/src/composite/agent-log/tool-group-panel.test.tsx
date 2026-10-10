/**
 * ToolGroupPanel：工具组折叠面板（两级折叠）。
 *
 * 五条守卫：
 *   · 组头的 `工具调用 × N` **只数 `entry.kind === 'call'`**——把孤立结果算进去就是虚报调用次数
 *     （一条调用被画成卡片却仍算进 N，读数就是不实的）；
 *   · 调用名汇总去重、最多 3 个、多了缀「等 N 个」；
 *   · 组头带**「失败 N」**（2026-10-03 用户口径）：失败的工具组与失败行都默认收起，
 *     于是「这一组里有失败」只能靠这一格在收起态露出来；N 数的是**结果为 `error` 的条目**
 *     （与「工具调用 × N」是两个口径，失败的孤立结果也算），一条失败都没有时整格不渲染；
 *   · 展开后组内出 `ToolItemDetail`，收起时组内的行**不在 DOM 里**；
 *   · 行开合**受控**：`openEntries` 不给这个键时正文不出现，给了才出现（本件自己不持态）。
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installResizeObserverStub } from '../../testing/resize-observer';
import type { OrphanToolResult, ToolGroupEntry, ToolItem } from './render-blocks';
import { ToolGroupPanel } from './tool-group-panel';

// 组内的工具行会渲染 `EllipsisText`（antd 的省略测量要 `ResizeObserver`，jsdom 没有）
beforeEach(() => {
  installResizeObserverStub();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const AT = '2026-10-02T08:00:00.000Z';

function call(overrides: Partial<ToolItem> = {}): ToolItem {
  return {
    kind: 'call',
    callId: 'call-1',
    blockId: 'm1#0',
    name: 'Read',
    nameMissing: null,
    family: 'read-file',
    input: { value: '{"path":"a.ts"}', text: '{"path":"a.ts"}', bytes: 14, description: null },
    output: { text: '结果原文', structured: null, status: 'ok', bytes: 12, truncation: { kind: 'none' } },
    at: AT,
    running: false,
    ...overrides,
  };
}

const orphan: OrphanToolResult = {
  kind: 'orphan-result',
  callId: null,
  blockId: 'm1#9',
  at: AT,
  output: { text: '配不上调用的结果', structured: null, status: 'ok', bytes: 12, truncation: { kind: 'none' } },
};

/** 结果为 `error` 的孤立结果：它同样是一次失败，组头的「失败 N」要把它算进去 */
const failedOrphan: OrphanToolResult = {
  ...orphan,
  output: { text: '配不上调用的失败结果', structured: null, status: 'error', bytes: 8, truncation: { kind: 'none' } },
};

/** 一次失败的调用（结果原文与状态都按 `error` 给） */
function failedCall(overrides: Partial<ToolItem> = {}): ToolItem {
  return call({
    output: { text: 'boom', structured: null, status: 'error', bytes: 4, truncation: { kind: 'none' } },
    ...overrides,
  });
}

const props = {
  open: true,
  onOpenChange: vi.fn(),
  openEntries: new Set<string>(),
  onEntryOpenChange: vi.fn(),
};

describe('ToolGroupPanel', () => {
  it('组头的 N 只数 call，孤立结果不算「调用」', () => {
    const entries: ToolGroupEntry[] = [call(), call({ callId: 'call-2', name: 'Bash' }), orphan];
    render(<ToolGroupPanel {...props} entries={entries} />);

    expect(screen.getByText('工具调用 × 2')).toBeInTheDocument();
    expect(screen.queryByText('工具调用 × 3')).toBeNull();
  });

  it('调用名汇总：去重后最多 3 个，多了缀「等 N 个」', () => {
    const entries: ToolGroupEntry[] = [
      call({ callId: 'c1', name: 'Read' }),
      call({ callId: 'c2', name: 'Bash' }),
      call({ callId: 'c3', name: 'Read' }),
    ];
    const { unmount } = render(<ToolGroupPanel {...props} entries={entries} />);
    expect(screen.getByText('Read、Bash')).toBeInTheDocument();
    unmount();

    const four: ToolGroupEntry[] = [
      call({ callId: 'c1', name: 'Read' }),
      call({ callId: 'c2', name: 'Bash' }),
      call({ callId: 'c3', name: 'Grep' }),
      call({ callId: 'c4', name: 'Task' }),
    ];
    render(<ToolGroupPanel {...props} entries={four} />);
    expect(screen.getByText('Read、Bash、Grep 等 4 个')).toBeInTheDocument();
  });

  it('名字一个都没采到时如实说「调用名未采集」', () => {
    render(<ToolGroupPanel {...props} entries={[call({ name: '' })]} />);

    expect(screen.getByText('调用名未采集')).toBeInTheDocument();
  });

  it('展开后出组内的工具行，收起时行不在 DOM 里', () => {
    const { unmount } = render(<ToolGroupPanel {...props} entries={[call()]} />);
    // 组头也有一份名字汇总，故按行内那两格（族名 Tag + 参数摘要）来断言
    expect(screen.getByText('读文件')).toBeInTheDocument();
    expect(screen.getByText('{"path":"a.ts"}')).toBeInTheDocument();
    unmount();

    const { container: closed } = render(<ToolGroupPanel {...props} open={false} entries={[call()]} />);
    // 收起时组头在、组内一行都不渲染
    expect(screen.getByText('工具调用 × 1')).toBeInTheDocument();
    expect(closed.querySelectorAll('.ant-collapse-item')).toHaveLength(1);
    expect(screen.queryByText('{"path":"a.ts"}')).toBeNull();
  });

  it('组状态汇总：有结果还没到的调用时转圈，全部到齐时不表态', () => {
    const { container, unmount } = render(
      <ToolGroupPanel {...props} entries={[call({ output: null, running: true })]} />,
    );
    expect(container.querySelector('.ant-badge-status-processing')).not.toBeNull();
    unmount();

    const { container: done } = render(<ToolGroupPanel {...props} entries={[call()]} />);
    expect(done.querySelector('.ant-badge-status-processing')).toBeNull();
    expect(screen.queryByText('结果未采集')).toBeNull();
  });

  it('组状态汇总：轮次结束而结果没到 → 静态灰字「结果未采集」', () => {
    const { container } = render(
      <ToolGroupPanel {...props} entries={[call({ output: null, running: false })]} />,
    );

    // 组头的状态汇总（`items[].extra`）就是那一句灰字，且**不带**转圈徽标
    expect(container.querySelector('.ant-collapse-extra')).toHaveTextContent('结果未采集');
    expect(container.querySelector('.ant-badge-status-processing')).toBeNull();
  });

  it('组头带「失败 N」：N 数结果为 error 的条目（含失败的孤立结果），与「工具调用 × N」各自独立', () => {
    const entries: ToolGroupEntry[] = [call({ callId: 'c1' }), failedCall({ callId: 'c2' }), failedOrphan];
    const { container } = render(<ToolGroupPanel {...props} open={false} entries={entries} />);

    // 两个读数各说各的：调用次数只数 call，失败数数的是失败结果（调用与孤立结果都算）
    expect(screen.getByText('工具调用 × 2')).toBeInTheDocument();
    expect(container.querySelector('.ant-collapse-extra')).toHaveTextContent('失败 2');
  });

  it('一条失败都没有时组头不出现「失败」这一格（不画一个恒为 0 的读数）', () => {
    const { container } = render(<ToolGroupPanel {...props} open={false} entries={[call(), orphan]} />);

    expect(container.querySelector('.ant-collapse-extra')).not.toHaveTextContent('失败');
  });

  it('收起态就能看出这组有失败，而组内的行一条都不挂载（失败 N 是折叠口径的补偿）', () => {
    const { container } = render(
      <ToolGroupPanel {...props} open={false} entries={[failedCall({ callId: 'c1' })]} />,
    );

    expect(container.querySelector('.ant-collapse-extra')).toHaveTextContent('失败 1');
    // 组头在、组内一行都没有：证据要用户自己点开（2026-10-03 用户口径）
    expect(container.querySelectorAll('.ant-collapse-item')).toHaveLength(1);
    expect(screen.queryByText('boom')).toBeNull();
  });

  it('点开某一行时把「哪一行、开还是关」上报给调用方（受控）', () => {
    const onEntryOpenChange = vi.fn();
    render(
      <ToolGroupPanel
        {...props}
        onEntryOpenChange={onEntryOpenChange}
        entries={[call({ callId: 'call-9', name: 'Grep' })]}
      />,
    );

    // 组头也有一份名字汇总 ⇒ 只点行里那一格（参数摘要）
    fireEvent.click(screen.getByText('{"path":"a.ts"}'));

    expect(onEntryOpenChange).toHaveBeenCalledWith('call-9', true);
  });

  it('行展开由 openEntries 决定：不给键时正文不出现，给了才出现', () => {
    const entry = call({ output: { text: '结果原文', structured: null, status: 'ok', bytes: 12, truncation: { kind: 'none' } } });
    const { rerender } = render(<ToolGroupPanel {...props} entries={[entry]} />);
    expect(screen.queryByText('结果原文')).toBeNull();

    rerender(<ToolGroupPanel {...props} openEntries={new Set(['call-1'])} entries={[entry]} />);
    expect(screen.getByText('结果原文')).toBeInTheDocument();
  });

  it('组里只有孤立结果时也照常成组（调用数 0，但没有名字可汇总就不画那一格）', () => {
    render(<ToolGroupPanel {...props} entries={[orphan]} />);

    expect(screen.getByText('工具调用 × 0')).toBeInTheDocument();
    expect(screen.queryByText('调用名未采集')).toBeNull();
  });

  it('同一轮的两条孤立结果各自独立开合（轮次时刻不是身份，两条不能共用一个键）', () => {
    // `at` 是**轮次派生**的时刻（行开始时刻 + 轮号）：同一轮的每个块逐字相同，
    // 拿它当身份必然撞键——真机报的就是 `2026-10-07T03:03:14.381Z|orphan` 撞了自己
    const output = (text: string): OrphanToolResult['output'] => ({ ...orphan.output, text });
    const entries: ToolGroupEntry[] = [
      { ...orphan, callId: 'call_00_a', output: output('第一条结果原文') },
      { ...orphan, callId: 'call_00_b', output: output('第二条结果原文') },
    ];
    const onEntryOpenChange = vi.fn();
    const { unmount } = render(
      <ToolGroupPanel {...props} onEntryOpenChange={onEntryOpenChange} entries={entries} />,
    );

    // 两行的摘要行逐字相同 ⇒ 按下标点第一条，看它上报的键认不认得出是**哪一条**
    const rows = screen.getAllByText('孤立结果（配不上调用）');
    const firstRow = rows[0];
    if (firstRow === undefined) throw new Error('应有两条孤立结果行');
    fireEvent.click(firstRow);
    const key: unknown = onEntryOpenChange.mock.calls[0]?.[0];
    expect(key).toBe('call_00_a');
    unmount();

    // 那个键只能展开它自己那一行：缺陷版两条共用一个键 ⇒ 给一条的键会把两条一起展开
    render(<ToolGroupPanel {...props} openEntries={new Set([String(key)])} entries={entries} />);
    expect(screen.getByText('第一条结果原文')).toBeInTheDocument();
    expect(screen.queryByText('第二条结果原文')).toBeNull();
  });

  it('同一轮两条缺 callId 的同名调用各自独立开合（身份退回源块 id）', () => {
    // `at` 相同、名字相同、`callId` 都缺 ⇒ 旧的 `at|name` 兜底会把两条键成同一个
    const output = (text: string): ToolItem['output'] => ({
      text,
      structured: null,
      status: 'ok',
      bytes: text.length,
      truncation: { kind: 'none' },
    });
    const entries: ToolGroupEntry[] = [
      call({ callId: null, blockId: 'm1#0', name: 'Bash', output: output('第一条结果原文') }),
      call({ callId: null, blockId: 'm1#1', name: 'Bash', output: output('第二条结果原文') }),
    ];
    const onEntryOpenChange = vi.fn();
    const { unmount } = render(
      <ToolGroupPanel {...props} onEntryOpenChange={onEntryOpenChange} entries={entries} />,
    );

    // 行首现在是族名（「读文件」），`code` 那一格（工具名）已经让到展开后的正文里 ⇒
    // 用参数摘要定位这两行；两行的摘要逐字相同，故仍按下标点第二条
    const rows = screen.getAllByText('{"path":"a.ts"}');
    const secondRow = rows[1];
    if (secondRow === undefined) throw new Error('应有两条同名调用行');
    fireEvent.click(secondRow);
    expect(onEntryOpenChange).toHaveBeenCalledWith('m1#1', true);
    unmount();

    render(<ToolGroupPanel {...props} openEntries={new Set(['m1#1'])} entries={entries} />);
    expect(screen.getByText('第二条结果原文')).toBeInTheDocument();
    expect(screen.queryByText('第一条结果原文')).toBeNull();
  });
});
