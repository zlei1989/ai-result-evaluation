/**
 * ToolItemDetail：单条工具行（摘要行 + 展开后的命令/参数与结果）。
 *
 * 七条守卫：
 *   · 摘要候选的行首有**一块**身份牌子 + 参数摘要（`description` 缺席时是 `value ?? text` 的第一行）；
 *   · **行首族名优先、没映射才回落工具名**（二选一，都在行首）；工具名落到展开后的正文；
 *   · **摘要行优先给入参里的 `description`**（模型自己写的一句人话），原文仍留在展开后的正文里；
 *   · `name === ''` 时**不编名字**，如实写「未采集」+ 原因；
 *   · `output === null && missingReason` 时写清「结果未采集 · 原因」；
 *   · 孤立结果不编工具名（且不出现工具名那一格）；结果**不截断**（没有「展开全部」按钮）；
 *   · 展开后的正文是**无标题小卡片 + 纵向 `Descriptions`**（一格一个字段），参数与结果**整段展开**：
 *     不套限高、不显示字节数、工具名也不包 `code`；「没采到截断标记」那半句不画（真被截过才提示）。
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
    inputError: null,
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
   * **二选一、族名优先，且都在行首**——「工具名在行首、族 Tag 在行尾」是一个候选里说两遍。
   * 这条闸同时钉住「工具名没有被丢掉」：它原样落到展开后的正文。
   */
  it('行首是族名（人话）、工具名落到展开后的正文，参数摘要照旧', () => {
    const { container } = render(<ToolItemDetail entry={callItem()} open onOpenChange={vi.fn()} missingReason={null} />);

    const header = container.querySelector('.ant-collapse-header')?.textContent ?? '';
    const body = container.querySelector('.ant-collapse-body')?.textContent ?? '';
    // 二选一：行首只有「跑命令」，`Bash` 一个字母都不在收起态那一个候选里
    expect(header).toContain('跑命令');
    expect(header).not.toContain('Bash');
    expect(header).toContain('{"command":"npm test"}');
    // 工具名没丢：展开后的正文里原样给出（排障要与厂商日志对号），标签是「工具」
    expect(container.querySelector('.ant-collapse-body th')?.textContent).toBe('工具');
    expect(body).toContain('Bash');
    // 但不再包一层 `code`：这一格是字段值，不是候选内代码
    expect(container.querySelector('.ant-collapse-body code')).toBeNull();
  });

  /**
   * 展开后的正文形态：**一张没有标题的小卡片，里面是纵向 `Descriptions`**。
   *
   * 为什么钉：改回一串手摆的 `Flex` 行时页面照样能读，所有文本断言也都绿（字一个不少），
   * 只有「字段表」这件事没了。三条判据各管一半——
   * 卡片无标题（`.ant-card-head` 一个都不画）、两张卡都取 `small`、字段纵向排（`layout="vertical"`
   * 把标签放进独立的 `<th>` 行；非边框的横向布局只有 `<td>`）。
   */
  it('展开后的正文是「无标题小卡片 + 纵向 Descriptions」：一格一个字段', () => {
    const { container } = render(<ToolItemDetail entry={callItem()} open onOpenChange={vi.fn()} missingReason={null} />);

    const card = container.querySelector<HTMLElement>('.ant-collapse-body .ant-card');
    expect(card).not.toBeNull();
    expect(card?.classList.contains('ant-card-small')).toBe(true);
    // 无标题：卡片头（title / extra 那一条）不渲染
    expect(card?.querySelector('.ant-card-head')).toBeNull();

    const descriptions = card?.querySelector<HTMLElement>('.ant-descriptions');
    expect(descriptions?.classList.contains('ant-descriptions-small')).toBe(true);
    // 纵向布局的判据：每个字段各占一行标签（`<th>`），横向非边框布局里一个都没有
    expect([...(descriptions?.querySelectorAll('th') ?? [])].map((cell) => cell.textContent)).toEqual([
      '工具',
      '参数',
      '结果',
    ]);
  });

  /**
   * 折叠标题那一格**必须可收缩**：摘要候选是 `nowrap` 的长命令，而 antd 的 `.ant-collapse-title`
   * 默认 `min-width: auto` ⇒ 最小宽度按内容算，标题把整行顶宽、外层时间轴冒出横向滚动条，
   * 而省略号永远轮不到（`EllipsisText` 的 `max-width: 100%` 分母就是那个被顶宽的容器）。
   *
   * jsdom 没有布局，这里只能钉住「那一格语义样式在位」；几何判据（标题宽度收到可用宽度、
   * 列表 `scrollWidth === clientWidth`）在真实服务上读 `getBoundingClientRect`。
   */
  it('折叠标题可收缩（`minWidth: 0`）：长摘要不会把整行顶宽成横向滚动条', () => {
    const { container } = render(
      <ToolItemDetail entry={callItem()} open={false} onOpenChange={vi.fn()} missingReason={null} />,
    );

    expect(container.querySelector<HTMLElement>('.ant-collapse-title')?.style.minWidth).toBe('0');
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

  /**
   * 参数与结果**整段展开**：不套限高（`maxHeight`）、不显示字节数。
   *
   * 为什么钉：这两格是排障时要逐字读的原文，限高的小框要先滚才能看全，还容易被读成
   * 「内容就这么多」；字节数是给机器看的口径，占一行只会把真正的内容往下挤。
   */
  it('展开后给出完整参数与结果原文（无限高、无字节数），确认被截断时给出提示', () => {
    const { container } = render(
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

    // 参数是 JSON ⇒ 压成一条 + 高亮（缩进被压掉，键与值之间不留空格）
    expect(screen.getByText('{"command":"ls"}')).toBeInTheDocument();
    expect(container.querySelector('.ant-collapse-body [data-json-token="key"]')).not.toBeNull();
    expect(screen.getByText(/a\.txt/)).toBeInTheDocument();
    // 字节数不再显示；两段原文都不带限高（`MonoText` 只有在传了 `maxHeight` 时才写这一格）
    expect(container.textContent).not.toContain('字节');
    expect([...container.querySelectorAll<HTMLElement>('[style]')].every((el) => el.style.maxHeight === '')).toBe(true);
    // 真被截过仍然要说——那是事实，不是噪声
    expect(screen.getByText('输出已被截断（只留前 100KB）')).toBeInTheDocument();
  });

  /**
   * 「没采到截断标记」（`unknown`）**不画提示**：三家多半不报这一格，那半句几乎每条结果都挂一次；
   * 正文已经整段展开，它只会让人以为内容缺了。原始输出面板那条路径不受影响（它另有自己的用例）。
   */
  it('截断标记没采到（`unknown`）时不画「输出可能不完整」', () => {
    const { container } = render(
      <ToolItemDetail
        entry={callItem({ output: { text: 'ok', structured: null, status: 'ok', bytes: 2, truncation: { kind: 'unknown' } } })}
        open
        onOpenChange={vi.fn()}
        missingReason={null}
      />,
    );

    expect(container.textContent).not.toContain('输出可能不完整');
    expect(container.textContent).not.toContain('没采到截断标记');
  });

  /**
   * 标题（摘要行）**先给模型自己写的那句话**（`input.description`），没有才回落参数原文首行。
   *
   * 为什么必须钉（真机）：dsh 的 `pwsh` 把 `{command, description}` 一起送来，
   * 照原文首行渲染就是 1495px 宽的一整串 JSON——而「这一步在干什么」只在 `description` 里。
   * 这条闸拦的是「又退回照原文首行渲染」：那是**看不出错**的回归（字都在，只是没法读），
   * 所以两半都要断言——摘要行有人话，且**摘要候选里没有那串 JSON**。
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
   * 摘要候选的**第一档**是数据层算好的 `tool-call.summary`（口径：
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
   * 为什么必须钉：dsh 的 `read` / `write` / `edit` 把候选数、改动对象这类**已解析过的事实**
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
    // 压缩档：一条逻辑行（`"totalLines":112` 没有缩进与冒号后的空格），不把格子撑成十几行
    expect(container.textContent).toContain('"totalLines":112');
    expect(container.textContent).not.toContain('"totalLines": 112');
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

  /**
   * 参数解析失败那一行必须真的画出来：`input` 是空对象，与「模型真传了空对象」同形，
   * 只有 `inputError` 能说出真相。这里钉**文本**；`/dev/agent-log` 的冒烟钉几何。
   *
   * 变异体：把 `tool-item-detail.tsx` 里那条 `hasText(item.inputError) && <Alert …>` 删掉 ⇒ 本用例红。
   */
  it('带 inputError 的调用画出一句可读提示（含厂商原文）；没有则不画', () => {
    const view = render(
      <ToolItemDetail entry={callItem({ inputError: 'Unexpected token: not valid JSON' })} open onOpenChange={vi.fn()} missingReason={null} />,
    );
    expect(view.getByText(/参数不是合法 JSON/)).toBeTruthy();
    expect(view.getByText(/not valid JSON/)).toBeTruthy();
    view.unmount();

    const without = render(<ToolItemDetail entry={callItem()} open onOpenChange={vi.fn()} missingReason={null} />);
    expect(without.queryByText(/参数不是合法 JSON/)).toBeNull();
  });
});
