/**
 * ToolItemDetail：单条工具行（摘要行 + 展开后的命令/参数与结果）。
 *
 * 七条守卫：
 *   · 摘要行的行首有**一块**身份牌子 + 参数摘要（`description` 缺席时是 `value ?? text` 的第一行）；
 *   · **行首族名优先、没映射才回落工具名**（二选一，都在行首）；工具名落到展开后的正文；
 *   · **摘要行优先给入参里的 `description`**（模型自己写的一句人话），原文仍留在展开后的正文里；
 *   · `name === ''` 时**不编名字**，如实写「未采集」+ 原因；
 *   · `output === null && missingReason` 时写清「结果未采集 · 原因」；
 *   · 孤立结果不编工具名（且不出现工具名那一格）；结果**不截断**（没有「展开全部」按钮）。
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
    input: { value: '{"command":"npm test"}', text: '{"command":"npm test"}', bytes: 22, description: null },
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
  /**
   * 行首那一块牌子的口径：`Bash` 与「跑命令」是同一件事的两种说法，
   * **二选一、族名优先，且都在行首**——「工具名在行首、族 Tag 在行尾」是一行里说两遍。
   * 这条闸同时钉住「工具名没有被丢掉」：它原样落到展开后的正文。
   */
  it('行首是族名（人话）、工具名落到展开后的正文，参数摘要照旧', () => {
    const { container } = render(<ToolItemDetail entry={callItem()} open onOpenChange={vi.fn()} missingReason={null} />);

    const header = container.querySelector('.ant-collapse-header')?.textContent ?? '';
    const body = container.querySelector('.ant-collapse-body')?.textContent ?? '';
    // 二选一：行首只有「跑命令」，`Bash` 一个字母都不在收起态那一行里
    expect(header).toContain('跑命令');
    expect(header).not.toContain('Bash');
    expect(header).toContain('{"command":"npm test"}');
    // 工具名没丢：展开后的正文里原样给出（排障要与厂商日志对号）
    expect(body).toContain('工具原名');
    expect(body).toContain('Bash');
  });

  it('没有族映射（`family === null`）时行首回落工具名——且正文不再重复一遍', () => {
    const { container } = render(
      <ToolItemDetail entry={callItem({ family: null })} open onOpenChange={vi.fn()} missingReason={null} />,
    );

    const header = container.querySelector('.ant-collapse-header')?.textContent ?? '';
    expect(header).toContain('Bash');
    expect(header).not.toContain('跑命令');
    expect(container.querySelector('.ant-collapse-body')?.textContent).not.toContain('工具原名');
  });

  it('name 为空串：行首给族名，正文如实写「工具原名未采集 · 原因」（**不编名字**）', () => {
    const { container } = render(
      <ToolItemDetail entry={callItem({ name: '', nameMissing: null })} open onOpenChange={vi.fn()} missingReason={null} />,
    );

    const header = container.querySelector('.ant-collapse-header')?.textContent ?? '';
    expect(header).toContain('跑命令');
    // 不编名字：整件里一个等宽标识符都不出
    expect(container.querySelector('code')).toBeNull();
    expect(container.querySelector('.ant-collapse-body')?.textContent).toContain('工具原名未采集 · 没验证过');
  });

  it('name 为空串且没有族映射：行首就是「工具名未采集 · 原因」', () => {
    render(
      <ToolItemDetail
        entry={callItem({ name: '', nameMissing: null, family: null })}
        open={false}
        onOpenChange={vi.fn()}
        missingReason={null}
      />,
    );

    expect(screen.getByText('工具名未采集 · 没验证过')).toBeInTheDocument();
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
          input: { value: '{"command":"ls"}', text: '{\n  "command": "ls"\n}', bytes: 24, description: null },
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

  /**
   * 标题（摘要行）**先给模型自己写的那句话**（`input.description`），没有才回落参数原文首行。
   *
   * 为什么必须钉（真机）：dsh 的 `pwsh` 把 `{command, description}` 一起送来，
   * 照原文首行渲染就是 1495px 宽的一整串 JSON——而「这一步在干什么」只在 `description` 里。
   * 这条闸拦的是「又退回照原文首行渲染」：那是**看不出错**的回归（字都在，只是没法读），
   * 所以两半都要断言——摘要行有人话，且**摘要行里没有那串 JSON**。
   */
  it('摘要行用入参里的 `description`（人话优先），原文仍留在展开后的正文里', () => {
    const raw = '{"command":"git --no-pager diff","description":"看生产改动与状态"}';
    const { container } = render(
      <ToolItemDetail
        entry={callItem({ input: { value: raw, text: raw, bytes: 66, description: '看生产改动与状态' } })}
        open
        onOpenChange={vi.fn()}
        missingReason={null}
      />,
    );

    expect(screen.getByText('看生产改动与状态')).toBeInTheDocument();
    // 摘要行（收起态唯一可见的一行）里不再有那串 JSON……
    expect(container.querySelector('.ant-collapse-header')?.textContent).not.toContain('git --no-pager diff');
    // ……但它一字不少地留在展开后的正文里（「原文可查」不靠标题兜）
    expect(container.querySelector('.ant-collapse-body')?.textContent).toContain(raw);
  });

  /**
   * 摘要行的**第一档**是数据层算好的 `tool-call.summary`（口径：
   * 词表真源收在 `@aieval/agents` 的 `activity.ts`，界面按分层表不许 import 它）。
   *
   * 为什么必须钉：这一档一旦失效，界面会**静默**退回自己抽 `description` 的老路——
   * 症状是「每族拼法全丢」（`Read` 又变回一串绝对路径、计划类又变回 JSON），
   * 而所有包的用例照样能绿（下面那两档回落还在）。故这里**两格都给且值不同**，
   * 用完整的 header 文本相等来证明用的是服务端那一句。
   */
  it('摘要行优先用数据层算好的 `summary`（带目标那句），压过 `input.description`', () => {
    const raw = '{"command":"git --no-pager diff","description":"看生产改动与状态"}';
    const { container } = render(
      <ToolItemDetail
        entry={callItem({
          summary: '看生产改动与状态（git --no-pager diff）',
          input: { value: raw, text: raw, bytes: 66, description: '看生产改动与状态' },
        })}
        open
        onOpenChange={vi.fn()}
        missingReason={null}
      />,
    );

    // 摘要行（收起态唯一可见的一行）逐字是服务端那一句——`description` 单独那句已被它吸收
    const header = container.querySelector('.ant-collapse-header')?.textContent ?? '';
    expect(header).toContain('看生产改动与状态（git --no-pager diff）');
    // 原文一字不少地留在展开后的正文里
    expect(container.querySelector('.ant-collapse-body')?.textContent).toContain(raw);
  });

  /**
   * 老记录（`summary` 这一格落盘之前的 `messages.jsonl`）**必须还能读**：
   * 那一格不存在时回落到 `input.description`，刷新旧 run 不出现回退。
   */
  it('老记录没有 `summary` 这一格 ⇒ 回落到 `description`', () => {
    const raw = '{"command":"git --no-pager diff","description":"看生产改动与状态"}';
    const { container } = render(
      <ToolItemDetail
        entry={callItem({ input: { value: raw, text: raw, bytes: 66, description: '看生产改动与状态' } })}
        open
        onOpenChange={vi.fn()}
        missingReason={null}
      />,
    );

    expect(container.querySelector('.ant-collapse-header')?.textContent).toContain('看生产改动与状态');
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
    // 这一格与其它 JSON 原文同档（`JsonText`）——缩进 + 高亮都得真的落到节点上
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
