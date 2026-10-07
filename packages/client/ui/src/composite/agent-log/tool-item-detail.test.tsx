/**
 * ToolItemDetail：单条工具行（摘要行 + 展开后的命令/参数与结果）。
 *
 * 五条守卫：
 *   · 摘要行有工具名与参数摘要（`value ?? text` 的第一行）；
 *   · `name === ''` 时写「工具名未采集」+ 原因，**不编名字**；
 *   · `output === null && missingReason` 时写清「结果未采集 · 原因」；
 *   · `family !== null` 时出族 `Tag`；
 *   · **孤立结果不编工具名**（且不出现工具名那一格）；结果**不截断**（没有「展开全部」按钮）。
 */
import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installResizeObserverStub } from '../../testing/resize-observer';
import type { OrphanToolResult, ToolItem } from './render-blocks';
import { ToolItemDetail, toolEntryKey } from './tool-item-detail';

// `EllipsisText` 走 antd 的省略测量，它 `new ResizeObserver`（jsdom 没有）⇒ 与 ellipsis-text.test 同一口径
beforeEach(() => {
  installResizeObserverStub();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const AT = '2026-10-02T08:00:00.000Z';

function callItem(overrides: Partial<ToolItem> = {}): ToolItem {
  return {
    kind: 'call',
    callId: 'call-1',
    blockId: 'm1#0',
    name: 'Bash',
    nameMissing: null,
    family: 'run-shell',
    input: { value: '{"command":"npm test"}', text: '{"command":"npm test"}', bytes: 22 },
    output: null,
    at: AT,
    running: false,
    ...overrides,
  };
}

function orphanResult(overrides: Partial<OrphanToolResult> = {}): OrphanToolResult {
  return {
    kind: 'orphan-result',
    callId: null,
    blockId: 'm1#7',
    at: AT,
    output: { text: '命令输出原文', structured: null, status: 'ok', bytes: 12, truncation: { kind: 'none' } },
    ...overrides,
  };
}

describe('ToolItemDetail', () => {
  it('摘要行有工具名、参数摘要与族 Tag', () => {
    render(<ToolItemDetail entry={callItem()} open={false} onOpenChange={vi.fn()} missingReason={null} />);

    expect(screen.getByText('Bash')).toBeInTheDocument();
    expect(screen.getByText('{"command":"npm test"}')).toBeInTheDocument();
    expect(screen.getByText('跑命令')).toBeInTheDocument();
  });

  it('name 为空串时写「工具名未采集」+ 原因，且不出族以外的名字', () => {
    const { container } = render(
      <ToolItemDetail
        entry={callItem({ name: '', nameMissing: null })}
        open={false}
        onOpenChange={vi.fn()}
        missingReason={null}
      />,
    );

    expect(screen.getByText('工具名未采集 · 没验证过')).toBeInTheDocument();
    expect(container.querySelector('code')).toBeNull();
  });

  it('结果没到且给了原因时写清「结果未采集 · 原因」', () => {
    const { container } = render(
      <ToolItemDetail
        entry={callItem()}
        open
        onOpenChange={vi.fn()}
        missingReason="这家结构上不支持"
      />,
    );

    // 摘要行与正文各说一次（摘要行给的是折叠态能看到的结论，正文展开后仍在）
    expect(screen.getAllByText('结果未采集 · 这家结构上不支持')).toHaveLength(2);
    expect(container.querySelector('.ant-collapse-body')).toHaveTextContent('结果未采集 · 这家结构上不支持');
  });

  it('展开后给出完整参数（含字节数）与结果原文，以及截断提示', () => {
    render(
      <ToolItemDetail
        entry={callItem({
          input: { value: '{"command":"ls"}', text: '{\n  "command": "ls"\n}', bytes: 24 },
          output: { text: 'a.txt\nb.txt', structured: null, status: 'ok', bytes: 12, truncation: { kind: 'truncated', reason: '只留前 100KB' } },
        })}
        open
        onOpenChange={vi.fn()}
        missingReason={null}
      />,
    );

    // 正文用 `text`（逐字原文）优先，摘要行才用 `value`；默认 matcher 会把缩进折成一个空格
    expect(screen.getByText('{ "command": "ls" }')).toBeInTheDocument();
    expect(screen.getByText('参数原文 24 字节')).toBeInTheDocument();
    expect(screen.getByText(/a\.txt/)).toBeInTheDocument();
    expect(screen.getByText('输出已被截断（只留前 100KB）')).toBeInTheDocument();
  });

  it('结果失败时看得见（`AgentRunStateTag` 在结果到手时不表态，这一格不能也沉默）', () => {
    render(
      <ToolItemDetail
        entry={callItem({
          output: { text: 'boom', structured: null, status: 'error', bytes: 4, truncation: { kind: 'none' } },
        })}
        open={false}
        onOpenChange={vi.fn()}
        missingReason={null}
      />,
    );

    expect(screen.getByText('失败')).toBeInTheDocument();
  });

  /**
   * 结构化结果（规范：**有 `meta` 就不要退回去解析文本**）。
   *
   * 为什么必须钉：dsh 的 `read` / `write` / `edit` 把行数、改动对象这类**已解析过的事实**
   * 只放在 `tool-result.structured` 里，正文那一段只是给人看的摘要（`<path>…</path>` 那种）。
   * 丢掉这一格时**界面上没有任何异常**——只是那些事实永远看不见，故必须有守卫。
   */
  it('结构化结果有落点（渲染成等宽 JSON 并标注），`null` 时整段不出现', () => {
    const { container, unmount } = render(
      <ToolItemDetail
        entry={callItem({
          output: {
            text: '摘要正文',
            structured: { lines: [{ number: 78, text: '<div id="app">' }], totalLines: 112 },
            status: 'ok',
            bytes: 12,
            truncation: { kind: 'none' },
          },
        })}
        open
        onOpenChange={vi.fn()}
        missingReason={null}
      />,
    );

    expect(screen.getByText('结构化结果')).toBeInTheDocument();
    expect(container.textContent).toContain('totalLines');
    // 2026-10-04：这一格与其它 JSON 原文同档（`JsonText`）——缩进 + 高亮都得真的落到节点上
    expect(container.querySelectorAll('[data-json-token]').length).toBeGreaterThan(0);
    unmount();

    // `null` = 这一家没给 ⇒ **不画空框**（空框会被读成「结构化结果坏了」）
    const empty = render(
      <ToolItemDetail entry={callItem()} open onOpenChange={vi.fn()} missingReason={null} />,
    );
    expect(empty.container.textContent).not.toContain('结构化结果');
  });

  it('孤立结果：写「配不上调用」+ 结果原文，且不编一个工具名', () => {
    const { container } = render(
      <ToolItemDetail entry={orphanResult()} open onOpenChange={vi.fn()} missingReason={null} />,
    );

    expect(screen.getByText('孤立结果（配不上调用）')).toBeInTheDocument();
    expect(screen.getByText('命令输出原文')).toBeInTheDocument();
    // 没有工具名 ⇒ 不出现等宽名字那一格
    expect(container.querySelector('code')).toBeNull();
  });

  it('超长结果不截断、也没有「展开全部」按钮（原文一字不少，滚动交给 MonoText）', () => {
    const long = `${'x'.repeat(4_500)}TAIL`;
    render(
      <ToolItemDetail
        entry={callItem({ output: { text: long, structured: null, status: 'ok', bytes: long.length, truncation: { kind: 'none' } } })}
        open
        onOpenChange={vi.fn()}
        missingReason={null}
      />,
    );

    expect(screen.queryByText('展开全部')).toBeNull();
    expect(screen.getByText(long)).toBeInTheDocument();
  });

  it('行键：callId 优先，缺了用源块 id（**不拿轮次时刻当身份**）', () => {
    expect(toolEntryKey(callItem())).toBe('call-1');
    // 孤立结果也照用它的 callId：配不上调用不等于它没有身份
    expect(toolEntryKey(orphanResult({ callId: 'call_7' }))).toBe('call_7');
    // 两边都没有 callId 时才退回源块 id（`messageId#块下标`，同轮唯一）
    expect(toolEntryKey(callItem({ callId: null, blockId: 'm2#3' }))).toBe('m2#3');
    expect(toolEntryKey(orphanResult({ callId: null, blockId: 'm2#4' }))).toBe('m2#4');
    // 同一轮（`at` 逐字相同）的两条必须拿到不同的键——`at` 是轮次派生时刻，撞键就是重复 key
    const sameRound = [
      orphanResult({ callId: null, blockId: 'm2#4' }),
      orphanResult({ callId: null, blockId: 'm2#5' }),
    ];
    expect(new Set(sameRound.map((entry) => toolEntryKey(entry))).size).toBe(2);
  });
});
