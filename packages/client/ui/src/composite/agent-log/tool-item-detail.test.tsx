/**
 * ToolItemDetail：单条工具行（`Trace` 摘要行 + 展开后的命令/参数与结果）。
 *
 * 八条守卫：
 *   · 摘要行的行首有**一块**身份牌子 + 参数摘要（`description` 缺席时是 `value ?? text` 的第一行）；
 *   · **行首族名优先、没映射才回落工具名**（二选一，都在行首）；工具名落到展开后的正文；
 *   · **摘要行优先给入参里的 `description`**（模型自己写的一句人话），原文仍留在展开后的正文里；
 *   · `name === ''` 时**不编名字**，如实写「未采集」+ 原因；
 *   · `output === null && missingReason` 时写清「结果未采集 · 原因」；
 *   · 孤立结果不编工具名（且不出现工具名那一格）；结果**不截断**（没有「展开全部」按钮）；
 *   · **动效的唯一判据是 `block.assembly`**：`open` ⇒ `TraceLine status="running"` 且标题写现在时，
 *     快照 ⇒ 不传 `status`（标题回到光秃秃的那句话）。没有第二个「流式中」布尔可传；
 *   · **失败输出走 Stack Trace 的结构**：首行错误 + 可折叠的帧列表，而不是一整段等宽文本。
 */
import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installResizeObserverStub } from '../../testing/resize-observer';
import type { OrphanToolResult, ToolGroupEntry, ToolItem } from './render-blocks';
import { ToolItemDetail, toolEntryKey } from './tool-item-detail';

// `MonoText` 走 antd 的滚动容器；`JsonText` 的测量会 `new ResizeObserver`（jsdom 没有）
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
    inputError: null,
    output: null,
    at: AT,
    assembly: 'snapshot',
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
    assembly: 'snapshot',
    ...overrides,
  };
}

/** 一条失败结果（stderr 那种多行原文） */
function failedOutput(text: string): ToolItem['output'] {
  return { text, structured: null, status: 'error', bytes: text.length, truncation: { kind: 'none' } };
}

/** 渲染一条工具行；开合两格都给默认值，用例只改自己关心的那一格 */
function renderDetail(
  entry: ToolGroupEntry,
  options: { open?: boolean; framesOpen?: boolean; missingReason?: string | null } = {},
): ReturnType<typeof render> & { onOpenChange: ReturnType<typeof vi.fn>; onFramesOpenChange: ReturnType<typeof vi.fn> } {
  const onOpenChange = vi.fn();
  const onFramesOpenChange = vi.fn();
  const view = render(
    <ToolItemDetail
      entry={entry}
      open={options.open ?? true}
      onOpenChange={onOpenChange}
      framesOpen={options.framesOpen ?? false}
      onFramesOpenChange={onFramesOpenChange}
      missingReason={options.missingReason ?? null}
    />,
  );
  return Object.assign(view, { onOpenChange, onFramesOpenChange });
}

/** 摘要行（收起态那一行）的文本 */
function headerOf(container: HTMLElement): string {
  return container.querySelector('[data-slot="trace-collapsible-trigger"]')?.textContent ?? '';
}

/** 展开后的正文文本 */
function bodyOf(container: HTMLElement): string {
  return container.querySelector('[data-slot="trace-collapsible-content"]')?.textContent ?? '';
}

describe('ToolItemDetail', () => {
  /**
   * 行首那一块牌子的口径：`Bash` 与「跑命令」是同一件事的两种说法，
   * **二选一、族名优先，且都在行首**——「工具名在行首、族 Tag 在行尾」是一行里说两遍。
   * 这条闸同时钉住「工具名没有被丢掉」：它原样落到展开后的正文。
   */
  it('行首是族名（人话）、工具名落到展开后的正文，参数摘要照旧', () => {
    const { container } = renderDetail(callItem());

    const header = headerOf(container);
    const body = bodyOf(container);
    // 二选一：行首只有「跑命令」，`Bash` 一个字母都不在收起态那一行里
    expect(header).toContain('跑命令');
    expect(header).not.toContain('Bash');
    expect(header).toContain('{"command":"npm test"}');
    // 工具名没丢：展开后的正文里原样给出（排障要与厂商日志对号）
    expect(body).toContain('工具原名');
    expect(body).toContain('Bash');
  });

  /**
   * 摘要行的标题**自己就是可收缩的**：长命令不许把整行顶宽成横向滚动条。
   *
   * 判据取 Trace 的结构：标题那一格带 `truncate`（`overflow: hidden` + 省略号），而它所在的
   * 行是 `min-w-0` 的 flex 项。几何判据（标题宽度收到可用宽度、列表 `scrollWidth === clientWidth`）
   * 在真实服务上读 `getBoundingClientRect`；jsdom 没有布局，只能钉住这两条结构。
   */
  it('标题可收缩（`truncate` + 行 `min-w-0`）：长摘要不会把整行顶宽成横向滚动条', () => {
    const { container } = renderDetail(callItem(), { open: false });

    const title = container.querySelector('[data-slot="trace-title"]');
    expect(title?.className, '标题没有走截断（长命令会把整行顶宽）').toContain('truncate');
    const line = container.querySelector('[data-slot="trace-line"]');
    expect(line?.className, '标题所在的行不是可收缩的 flex 项').toContain('min-w-0');
  });

  it('没有族映射（`family === null`）时行首回落工具名——且正文不再重复一遍', () => {
    const { container } = renderDetail(callItem({ family: null }));

    const header = headerOf(container);
    expect(header).toContain('Bash');
    expect(header).not.toContain('跑命令');
    expect(bodyOf(container)).not.toContain('工具原名');
  });

  it('name 为空串：行首给族名，正文如实写「工具原名未采集 · 原因」（**不编名字**）', () => {
    const { container } = renderDetail(callItem({ name: '', nameMissing: null }));

    expect(headerOf(container)).toContain('跑命令');
    // 不编名字：整件里一个厂商工具名都不出（结果正文的 `<code>` 不是工具名）
    expect(container.querySelector('code[data-tool-name]')).toBeNull();
    expect(bodyOf(container)).toContain('工具原名未采集 · 没验证过');
  });

  it('name 为空串且没有族映射：行首就是「工具名未采集 · 原因」', () => {
    renderDetail(callItem({ name: '', nameMissing: null, family: null }), { open: false });

    expect(screen.getByText('工具名未采集 · 没验证过')).toBeInTheDocument();
  });

  it('结果没到且给了原因时写清「结果未采集 · 原因」', () => {
    const { container } = renderDetail(callItem(), { missingReason: '这家结构上不支持' });

    // 摘要行旁边（`AgentRunStateTag`）与正文各说一次
    expect(screen.getAllByText('结果未采集 · 这家结构上不支持')).toHaveLength(2);
    expect(bodyOf(container)).toContain('结果未采集 · 这家结构上不支持');
  });

  it('展开后给出完整参数（含字节数）与结果原文，以及截断提示', () => {
    renderDetail(
      callItem({
        input: { value: '{"command":"ls"}', text: '{\n  "command": "ls"\n}', bytes: 24, description: null },
        output: { text: 'a.txt\nb.txt', structured: null, status: 'ok', bytes: 12, truncation: { kind: 'truncated', reason: '只留前 100KB' } },
      }),
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
    const { container } = renderDetail(
      callItem({ input: { value: raw, text: raw, bytes: 66, description: '看生产改动与状态' } }),
    );

    expect(screen.getByText('看生产改动与状态')).toBeInTheDocument();
    // 摘要行（收起态唯一可见的一行）里不再有那串 JSON……
    expect(headerOf(container)).not.toContain('git --no-pager diff');
    // ……但它一字不少地留在展开后的正文里（「原文可查」不靠标题兜）
    expect(bodyOf(container)).toContain(raw);
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
    const { container } = renderDetail(
      callItem({
        summary: '看生产改动与状态（git --no-pager diff）',
        input: { value: raw, text: raw, bytes: 66, description: '看生产改动与状态' },
      }),
    );

    // 摘要行（收起态唯一可见的一行）逐字是服务端那一句——`description` 单独那句已被它吸收
    expect(headerOf(container)).toContain('看生产改动与状态（git --no-pager diff）');
    // 原文一字不少地留在展开后的正文里
    expect(bodyOf(container)).toContain(raw);
  });

  /**
   * 老记录（`summary` 这一格落盘之前的 `messages.jsonl`）**必须还能读**：
   * 那一格不存在时回落到 `input.description`，刷新旧 run 不出现回退。
   */
  it('老记录没有 `summary` 这一格 ⇒ 回落到 `description`', () => {
    const raw = '{"command":"git --no-pager diff","description":"看生产改动与状态"}';
    const { container } = renderDetail(
      callItem({ input: { value: raw, text: raw, bytes: 66, description: '看生产改动与状态' } }),
    );

    expect(headerOf(container)).toContain('看生产改动与状态');
  });

  /**
   * **`status` 从 `block.assembly` 派生，不从第二个 prop 来**。
   *
   * 判据分两半（缺一半就分不清「没传 status」与「传了个恒 undefined 的假格」）：
   *   · `assembly === 'open'` ⇒ `data-status="running"` + 标题「正在运行 · …」（现在时）；
   *   · `assembly === 'snapshot'` ⇒ **没有** `data-status` 这个属性（Trace 的规则是跑完不传），
   *     标题回到光秃秃的那句话。
   */
  it('`assembly` 是动效的唯一判据：open ⇒ status="running" 且标题现在时，快照 ⇒ 不传 status', () => {
    const { container, unmount } = renderDetail(callItem({ assembly: 'open', running: true }));
    const running = container.querySelector('[data-slot="trace-line"]');
    expect(running).toHaveAttribute('data-status', 'running');
    expect(container.querySelector('[data-slot="trace-title"]')).toHaveTextContent('正在运行 · ');
    unmount();

    const { container: done } = renderDetail(callItem({ assembly: 'snapshot' }));
    const line = done.querySelector('[data-slot="trace-line"]');
    expect(line, '快照块不该带 status').not.toBeNull();
    expect(line?.hasAttribute('data-status'), '快照块仍然传了 status ⇒ 跑完还在 shimmer').toBe(false);
    expect(done.querySelector('[data-slot="trace-title"]')).not.toHaveTextContent('正在运行');
  });

  it('结果失败时看得见：status="error" + 标题「失败：…」（不靠颜色单独表达）', () => {
    const { container } = renderDetail(callItem({ output: failedOutput('boom') }), { open: false });

    expect(container.querySelector('[data-slot="trace-line"]')).toHaveAttribute('data-status', 'error');
    // 状态词写进标题（只靠颜色的话，读屏与色觉障碍用户拿不到这个事实）
    expect(headerOf(container)).toContain('失败：');
  });

  /**
   * 失败输出**不是「一段更长的文本」**：它有自己的结构（首行错误 + 帧列表），
   * 且帧列表是第二层折叠——收起时不进 DOM、展开才出现。
   *
   * 为什么必须钉：一整段 `MonoText` 与 Stack Trace 在「字都在」这个层面完全一样，
   * 只有节点结构能区分「读者先看到第一行，再决定要不要看帧」与「在一屏 stderr 里自己找」。
   */
  it('失败输出走 Stack Trace：首行错误 + 可折叠的帧列表，而不是一整段等宽文本', () => {
    const text = ['Error: boom', '    at run (/app/src/a.ts:10:3)', '    at next (node_modules/x/y.js:2:1)'].join('\n');
    const entry = callItem({ output: failedOutput(text) });
    const { container, rerender } = renderDetail(entry, { framesOpen: false });

    const stack = container.querySelector('[data-testid="stack-trace"]');
    expect(stack, '失败输出没有走 Stack Trace 的结构').not.toBeNull();
    expect(stack?.querySelector('[data-slot="trace-line"]')).toHaveAttribute('data-status', 'error');
    // **不是**一整段等宽文本：失败这一支不渲染 CodeBlock
    expect(container.querySelector('[data-slot="code-block-content"]')).toBeNull();
    // 收起的帧列表不在 DOM 里（真的有两档，而不是一直摊着）
    expect(container.querySelector('[data-testid="stack-frames"]')).toBeNull();

    rerender(
      <ToolItemDetail
        entry={entry}
        open
        onOpenChange={vi.fn()}
        framesOpen
        onFramesOpenChange={vi.fn()}
        missingReason={null}
      />,
    );
    const frames = container.querySelectorAll('[data-testid="stack-frames"] li');
    expect(frames).toHaveLength(2);
    // 自己的帧与框架帧分开：`node_modules` 的帧不该与我们的代码同色
    expect(frames[0]).toHaveAttribute('data-frame', 'own');
    expect(frames[1]).toHaveAttribute('data-frame', 'framework');
    // 标题会被截断，故错误那句话在正文顶部重复一遍
    expect(container.querySelector('[data-testid="stack-error"]')).toHaveTextContent('Error: boom');
  });

  /**
   * 结构化结果（规范：**有 `meta` 就不要退回去解析文本**）。
   *
   * 为什么必须钉：dsh 的 `read` / `write` / `edit` 把行数、改动对象这类**已解析过的事实**
   * 只放在 `tool-result.structured` 里，正文那一段只是给人看的摘要（`<path>…</path>` 那种）。
   * 丢掉这一格时**界面上没有任何异常**——只是那些事实永远看不见，故必须有守卫。
   */
  it('结构化结果有落点（渲染成等宽 JSON 并标注），`null` 时整段不出现', () => {
    const { container, unmount } = renderDetail(
      callItem({
        output: {
          text: '摘要正文',
          structured: { lines: [{ number: 78, text: '<div id="app">' }], totalLines: 112 },
          status: 'ok',
          bytes: 12,
          truncation: { kind: 'none' },
        },
      }),
    );

    expect(screen.getByText('结构化结果')).toBeInTheDocument();
    expect(container.textContent).toContain('totalLines');
    // 这一格与其它 JSON 原文同档（`JsonText`）——缩进 + 高亮都得真的落到节点上
    expect(container.querySelectorAll('[data-json-token]').length).toBeGreaterThan(0);
    unmount();

    // `null` = 这一家没给 ⇒ **不画空框**（空框会被读成「结构化结果坏了」）
    const empty = renderDetail(callItem());
    expect(empty.container.textContent).not.toContain('结构化结果');
  });

  it('孤立结果：写「配不上调用」+ 结果原文，且不编一个工具名', () => {
    const { container } = renderDetail(orphanResult());

    expect(screen.getByText('孤立结果（配不上调用）')).toBeInTheDocument();
    expect(screen.getByText('命令输出原文')).toBeInTheDocument();
    // 没有工具名 ⇒ 不出现工具名那一格
    expect(container.querySelector('code[data-tool-name]')).toBeNull();
  });

  it('超长结果不截断、也没有「展开全部」按钮（原文一字不少，滚动交给 CodeBlock）', () => {
    const long = `${'x'.repeat(4_500)}TAIL`;
    renderDetail(callItem({ output: { text: long, structured: null, status: 'ok', bytes: long.length, truncation: { kind: 'none' } } }));

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

  /**
   * 参数解析失败那一行必须真的画出来：`input` 是空对象，与「模型真传了空对象」同形，
   * 只有 `inputError` 能说出真相。这里钉**文本**；`/dev/agent-log` 的冒烟钉几何。
   *
   * 变异体：把 `tool-item-detail.tsx` 里那条 `hasText(item.inputError) && <Alert …>` 删掉 ⇒ 本用例红。
   */
  it('带 inputError 的调用画出一句可读提示（含厂商原文）；没有则不画', () => {
    const view = renderDetail(callItem({ inputError: 'Unexpected token: not valid JSON' }));
    expect(view.getByText(/参数不是合法 JSON/)).toBeTruthy();
    expect(view.getByText(/not valid JSON/)).toBeTruthy();
    view.unmount();

    const without = renderDetail(callItem());
    expect(without.queryByText(/参数不是合法 JSON/)).toBeNull();
  });
});
