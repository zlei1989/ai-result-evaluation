/**
 * 两个输入入口的 `Prompt Input` 形态（L2 共用件）。
 *
 * 三条靶子，坏掉都**没有运行时症状**（界面照旧画得出来，只是两个入口慢慢长得不一样）：
 *   1. **两个入口的输入区结构一致**：同一份 `CompactComposerArea`、同一组 `data-slot`。
 *      各写一份的结果是同一种控件在两个入口形态不同，而这种漂移没人会当场发现；
 *   2. **附件清单可移除、发送后草稿清空**：清单与正文一起构成「这一句话」，留下残影就是发错内容；
 *   3. **Enter 发送 / Shift+Enter 换行**，且**中文输入法组合中的 Enter 不发送**（那一下是选词）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { InjectAttachment, TurnInjectionCapability } from '@aieval/contracts';
import { InjectComposer } from './inject-composer';
import { FollowUpComposer, type FollowUpSendInput, type FollowUpUploadInput } from './follow-up-composer';
import type { AgentLogFacts } from './types';
import { installMatchMediaStub } from '../../testing/match-media';
import { installResizeObserverStub } from '../../testing/resize-observer';

beforeEach(() => {
  installResizeObserverStub();
  installMatchMediaStub();
});

const YES = { state: 'yes' as const, reason: null, channel: 'wire' as const, gate: null, experimental: false, proofDriver: 'real-path' as const, proofDriverReason: null };
const DECLARATION: TurnInjectionCapability = {
  delivery: { round: YES, idle: YES },
  retract: { round: { state: 'by-id', reason: '按身份撤' }, idle: { state: 'by-id', reason: '按身份撤' } },
  resume: YES,
  notes: [],
};

const ATTACHMENT: InjectAttachment = { kind: 'file', path: '/tmp/row/attachments/m-1/a.md', mimeType: 'text/markdown' };

/** 行级事实（建议 chips 从它派生；这一条只考形态，给一份最小的成功行即可） */
const FACTS: AgentLogFacts = {
  status: { tone: 'ok', label: '已评分' },
  startedAt: null,
  endedAt: null,
  turns: { current: 0, total: null },
  tokens: null,
  thinking: null,
  domain: [],
  error: null,
  contextUsed: null,
  contextWindow: null,
};

/** 追问那一支（入口按钮在卡片上，输入区只在可用时被挂出来） */
function renderFollowUp(options: {
  onSend?: (input: FollowUpSendInput) => Promise<void>;
  onUploadAttachment?: (input: FollowUpUploadInput) => Promise<InjectAttachment>;
} = {}) {
  return render(
    <FollowUpComposer
      facts={FACTS}
      onSend={options.onSend ?? (() => Promise.resolve())}
      onUploadAttachment={options.onUploadAttachment ?? (() => Promise.resolve(ATTACHMENT))}
      onError={vi.fn()}
    />,
  );
}

/** 运行中注入那一支（没有排队消息 ⇒ 只剩输入区） */
function renderInject() {
  return render(
    <InjectComposer
      messages={[]}
      declaration={DECLARATION}
      onSend={() => Promise.resolve()}
      onPromote={() => Promise.resolve()}
      onRetract={() => Promise.resolve()}
      onUploadAttachment={() => Promise.resolve(ATTACHMENT)}
      onError={vi.fn()}
    />,
  );
}

/** 输入区的**结构指纹**：Prompt Input 骨架里每个 `data-slot` 连同对齐档，按 DOM 顺序 */
function shapeOf(container: HTMLElement): string[] {
  const group = container.querySelector('[data-slot="input-group"]');
  if (group === null) throw new Error('输入区不是 InputGroup（Prompt Input 的骨架没落下）');
  return [...group.querySelectorAll('[data-slot]')].map((element) => {
    const align = element.getAttribute('data-align');
    return align === null ? (element.getAttribute('data-slot') ?? '') : `${element.getAttribute('data-slot') ?? ''}@${align}`;
  });
}

/** 输入框里那颗按钮的可访问名（两个入口必须同名同序：一个叫「发送」一个叫「发送消息」就是漂移） */
function buttonLabelsOf(container: HTMLElement): string[] {
  return [...container.querySelectorAll('button')]
    .map((button) => button.getAttribute('aria-label') ?? '')
    .filter((label) => label !== '');
}

describe('两个入口的输入区结构一致（同一组件，形态不漂）', () => {
  it('★ 运行中注入 与 已跑完追问 渲染出的输入区结构逐格相同', () => {
    const inject = renderInject();
    const followUp = renderFollowUp();

    expect(shapeOf(inject.container), '两个入口的输入区骨架不一致（有人又拼了一份）').toEqual(shapeOf(followUp.container));
    expect(buttonLabelsOf(inject.container), '两个入口的输入区按钮不一致').toEqual(buttonLabelsOf(followUp.container));
    expect(buttonLabelsOf(inject.container)).toEqual(['添加附件', '发送']);

    inject.unmount();
    followUp.unmount();
  });

  it('结构确实来自 Prompt Input：InputGroup + Textarea + block-end addon + 隐藏 file input', () => {
    const { container } = renderFollowUp();
    const group = container.querySelector('[data-slot="input-group"]');
    expect(group).not.toBeNull();
    // 输入框是 group 里那个受控 textarea（不是 X 的 Sender 内嵌件）
    expect(group?.querySelector('[data-slot="input-group-control"]')?.tagName).toBe('TEXTAREA');
    // 附件与发送两个入口都在**框内**：附件在 block-start（有附件时才出现），发送在 block-end
    expect(group?.querySelector('[data-align="block-end"]')).not.toBeNull();
    expect(container.querySelector('input[type="file"]')).not.toBeNull();
  });

  it('两个入口自己都不拼输入区：只调共用件（静态判据）', () => {
    for (const file of ['follow-up-composer.tsx', 'inject-composer.tsx'] as const) {
      const source = readFileSync(join(import.meta.dirname, file), 'utf8');
      expect(source, `${file} 自己拼了 InputGroup`).not.toContain('<InputGroup');
      expect(source, `${file} 自己拼了 textarea`).not.toContain('<textarea');
      expect(source, `${file} 没走共用件`).toContain('<CompactComposerArea');
    }
  });
});

describe('附件清单与草稿', () => {
  it('★ 附件清单可移除：点「移除」那一份就从清单里消失', async () => {
    const { container } = renderFollowUp();
    const input = container.querySelector('input[type="file"]');
    Object.defineProperty(input, 'files', { value: [new File(['hello'], 'a.md', { type: 'text/markdown' })] });
    fireEvent.change(input as Element);

    await waitFor(() => expect(screen.getByTestId('follow-up-attachments').textContent).toContain('a.md'));
    fireEvent.click(screen.getByRole('button', { name: '移除 a.md' }));
    expect(screen.queryByTestId('follow-up-attachments')).toBeNull();
  });

  it('★ 拖一份文件进输入区 ⇒ 与点选同一条路（落盘回调拿到原始 File）', async () => {
    const onUploadAttachment = vi.fn((_input: FollowUpUploadInput) => Promise.resolve(ATTACHMENT));
    const { container } = renderFollowUp({ onUploadAttachment });
    const dropzone = container.querySelector('[data-testid="composer-dropzone"]');
    expect(dropzone, '输入区没有拖拽落点（旧交互丢了）').not.toBeNull();

    const file = new File(['hello'], 'dropped.md', { type: 'text/markdown' });
    fireEvent.drop(dropzone as Element, { dataTransfer: { files: [file] } });

    await waitFor(() => expect(onUploadAttachment).toHaveBeenCalledTimes(1));
    expect(onUploadAttachment.mock.calls[0]?.[0]).toMatchObject({ file });
    expect((await screen.findByTestId('follow-up-attachments')).textContent).toContain('dropped.md');
  });

  it('★ 发送之后草稿与附件清单一起清空（下一句从空白开始）', async () => {
    const onSend = vi.fn(() => Promise.resolve());
    const { container } = renderFollowUp({ onSend });
    const input = container.querySelector('input[type="file"]');
    Object.defineProperty(input, 'files', { value: [new File(['hello'], 'a.md', { type: 'text/markdown' })] });
    fireEvent.change(input as Element);
    await waitFor(() => expect(screen.getByTestId('follow-up-attachments')).toBeInTheDocument());

    fireEvent.change(screen.getByRole('textbox'), { target: { value: '看这份附件' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));

    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue(''));
    expect(screen.queryByTestId('follow-up-attachments')).toBeNull();
  });
});

describe('Enter / Shift+Enter 口径', () => {
  it('Enter 发送；Shift+Enter 换行（不发送）', () => {
    const onSend = vi.fn(() => Promise.resolve());
    renderFollowUp({ onSend });
    const textarea = screen.getByRole('textbox');

    fireEvent.change(textarea, { target: { value: '第一行' } });
    fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter', shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();

    fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' });
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it('中文输入法组合中的 Enter 是选词，不许发送', () => {
    const onSend = vi.fn(() => Promise.resolve());
    renderFollowUp({ onSend });
    const textarea = screen.getByRole('textbox');

    fireEvent.change(textarea, { target: { value: 'shu ru fa' } });
    fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter', isComposing: true });
    expect(onSend).not.toHaveBeenCalled();
  });
});
