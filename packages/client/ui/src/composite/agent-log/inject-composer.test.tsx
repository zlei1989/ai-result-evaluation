/**
 * 输入区与排队区（L2）：这一块是用户唯一看得见的那一面，用例按「用户会怎么看/怎么点」组织。
 *
 * 七组靶子（每一组坏掉都没有运行时症状——界面照旧画得出来，只是说的不是真的）：
 *   1. **可用性由声明决定**（`yes` 可用 / `off-by-adapter` 置灰且说「我们还没接」/ `unverified`
 *      置灰且说「还不能用：没验证过」/ 声明缺席说「读不到声明」——四句「不能」互不相同）；
 *   2. **发出去先排队**：发送固定用 `'idle'` 档，`messageId` 由本件铸（幂等键）；
 *   3. 发送失败时框里的内容**一个字不动**（用户不必重打）；
 *   4. 排队区默认收起、露出计数、`gone` 不渲染；
 *   5. 「删除」撤回成功后**文本与附件一起回填**，交出去过的那条另给一次性提示（缺一不可）；
 *   6. 附件：选一份 → 走 multipart 回调拿回路径 → 出现在框上方那一行；**超限的那一份不进清单**
 *      （判据与服务端读同一处常量，界面这一道只为体验）；
 *   7. 紧凑密度只套输入区（静态判据：`ConfigProvider` 不包排队区——真机字号读数在冒烟里）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ATTACHMENT_MAX_FILE_BYTES,
  ATTACHMENT_MAX_PER_MESSAGE,
  ServiceError,
  type InjectAttachment,
  type InjectMessage,
  type TurnInjectionCapability,
} from '@aieval/contracts';
import { InjectComposer, type InjectSendInput, type InjectUploadInput } from './inject-composer';
import { installMatchMediaStub } from '../../testing/match-media';
import { installResizeObserverStub } from '../../testing/resize-observer';

beforeEach(() => {
  installResizeObserverStub();
  installMatchMediaStub();
});

const YES = { state: 'yes' as const, reason: null, channel: 'wire' as const, gate: null, experimental: false, proofDriver: 'real-path' as const, proofDriverReason: null };
const OFF_BY_ADAPTER = { ...YES, state: 'off-by-adapter' as const, reason: 'not-observed' as const };
const UNVERIFIED = { ...YES, state: 'unverified' as const, reason: 'unverified' as const };

function declarationOf(overrides: Partial<TurnInjectionCapability> = {}): TurnInjectionCapability {
  return {
    delivery: { round: YES, idle: YES },
    retract: { round: { state: 'by-id', reason: '按身份撤' }, idle: { state: 'by-id', reason: '按身份撤' } },
    resume: YES,
    notes: [],
    ...overrides,
  };
}

function messageOf(messageId: string, overrides: Partial<InjectMessage> = {}): InjectMessage {
  return {
    messageId,
    text: `${messageId} 的正文`,
    attachments: [],
    requires: 'idle',
    state: 'queued',
    createdAt: '2026-09-22T10:30:00.000Z',
    deliveredAt: null,
    settledAt: null,
    outcome: null,
    reason: null,
    ...overrides,
  };
}

const ATTACHMENT: InjectAttachment = { kind: 'file', path: '/tmp/row/attachments/m-1/a.md', mimeType: 'text/markdown' };

/** 渲染这个件；每个回调默认给一个 resolved 的实现（用例只覆盖自己要考的那一个） */
function renderComposer(options: {
  messages?: readonly InjectMessage[];
  declaration?: TurnInjectionCapability | null;
  busy?: boolean;
  onSend?: (input: InjectSendInput) => Promise<void>;
  onPromote?: (messageId: string) => Promise<void>;
  onRetract?: (messageId: string) => Promise<void>;
  onUploadAttachment?: (input: InjectUploadInput) => Promise<InjectAttachment>;
  onError?: (cause: unknown) => void;
} = {}) {
  return render(
    <InjectComposer
      messages={options.messages ?? []}
      declaration={options.declaration === undefined ? declarationOf() : options.declaration}
      busy={options.busy ?? false}
      onSend={options.onSend ?? (() => Promise.resolve())}
      onPromote={options.onPromote ?? (() => Promise.resolve())}
      onRetract={options.onRetract ?? (() => Promise.resolve())}
      onUploadAttachment={options.onUploadAttachment ?? (() => Promise.resolve(ATTACHMENT))}
      onError={options.onError ?? vi.fn()}
    />,
  );
}

/** 输入框（X 的 `Sender` 内部那个 textarea） */
function textarea(): HTMLTextAreaElement {
  return screen.getByRole('textbox') as HTMLTextAreaElement;
}

/** 发送键：X 自带那颗圆形上箭头（按图标认，别按位置认） */
function sendButton(): HTMLButtonElement {
  const found = [...document.querySelectorAll('.ant-sender button')].find(
    (button) => button.querySelector('[aria-label="arrow-up"]') !== null,
  );
  if (found === undefined) throw new Error('输入区里没有那颗圆形上箭头（发送键的形态变了）');
  return found as HTMLButtonElement;
}

/** 打字并敲回车（`submitType` 的默认就是「回车发送」，与真实用户路径一致） */
function typeAndSend(text: string): void {
  fireEvent.change(textarea(), { target: { value: text } });
  fireEvent.keyDown(textarea(), { key: 'Enter', code: 'Enter' });
}

describe('可用性由声明决定（不判厂商）', () => {
  it('声明说两档都行 ⇒ 输入区可用，并且**如实说「发出去不等于立刻到」**', async () => {
    renderComposer({ declaration: declarationOf() });
    expect(textarea()).toBeEnabled();
    expect(screen.getByTestId('inject-queue-hint').textContent).toContain('通知');
    expect(screen.queryByTestId('inject-unavailable')).toBeNull();
  });

  it('`off-by-adapter` ⇒ 置灰，且说的是「厂商有、我们还没接」', () => {
    renderComposer({ declaration: declarationOf({ delivery: { round: YES, idle: OFF_BY_ADAPTER } }) });
    expect(textarea()).toBeDisabled();
    const note = screen.getByTestId('inject-unavailable').textContent ?? '';
    expect(note).toContain('还没接');
    expect(note).toContain('排队');
  });

  /**
   * `unverified` 与 `off-by-adapter` 在界面上必须是**两句不同的话**：前者是「我们不敢保证」
   * （通道与接线可能都在），后者是「还没接」。都写成「投不进去」会把用户引向错的动作
   * （一个该等，一个该催我们自己验）。
   */
  it('`unverified` ⇒ 置灰，说的是「还不能用 / 没验证过」而不是「投不进去」', () => {
    renderComposer({ declaration: declarationOf({ delivery: { round: YES, idle: UNVERIFIED } }) });
    expect(textarea()).toBeDisabled();
    const note = screen.getByTestId('inject-unavailable').textContent ?? '';
    expect(note).toContain('还不能用');
    expect(note).toContain('没验证过');
    expect(note).not.toContain('投不进去');
    // 占位符不再与下面那句话打架（它说的是「不能用」，不是「投不进去」）
    expect(screen.getByPlaceholderText(/不能用/)).toBeInTheDocument();
  });

  it('声明缺席（`null`）⇒ 置灰，说的是「读不到声明」而不是「这家不支持」', () => {
    renderComposer({ declaration: null });
    expect(textarea()).toBeDisabled();
    const note = screen.getByTestId('inject-unavailable').textContent ?? '';
    expect(note).toContain('声明');
    expect(note).not.toContain('结构上不支持');
  });

  it('两句话必须是两句（把「读不到声明」说成「我们没接」会把用户引向错的动作）', () => {
    const { unmount } = renderComposer({ declaration: null });
    const absent = screen.getByTestId('inject-unavailable').textContent;
    unmount();
    renderComposer({ declaration: declarationOf({ delivery: { round: YES, idle: OFF_BY_ADAPTER } }) });
    expect(screen.getByTestId('inject-unavailable').textContent).not.toBe(absent);
  });

  it('写动作在途 ⇒ 输入区禁用（免得同一句话发两遍）', () => {
    renderComposer({ busy: true });
    expect(textarea()).toBeDisabled();
  });
});

describe('发送', () => {
  it('回车发送：带 `messageId` + 正文 + 「排队」那一档（要插队就在排队行上点「立即发送」）', async () => {
    const onSend = vi.fn((_input: InjectSendInput) => Promise.resolve());
    renderComposer({ onSend });
    typeAndSend('顺便把 changelog 也补上');
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    const input = onSend.mock.calls[0]?.[0] as InjectSendInput;
    expect(input.text).toBe('顺便把 changelog 也补上');
    expect(input.requires).toBe('idle');
    expect(input.attachments).toEqual([]);
    // 形状由契约钉死：它同时是服务端的幂等键与附件目录名
    expect(input.messageId).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
  });

  it('受理之后输入框清空（失败时**一个字都不动**，见下一条）', async () => {
    renderComposer({ onSend: () => Promise.resolve() });
    typeAndSend('这句话会成功');
    await waitFor(() => expect(textarea().value).toBe(''));
  });

  it('失败 ⇒ 原因交给调用方，框里的内容原样留着（用户不必重打）', async () => {
    const onError = vi.fn();
    renderComposer({ onSend: () => Promise.reject(new Error('这一行不存在')), onError });
    typeAndSend('这句话会失败');
    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(textarea().value).toBe('这句话会失败');
  });

  it('空的框按回车不发（X 自己的空输入判据）', () => {
    const onSend = vi.fn(() => Promise.resolve());
    renderComposer({ onSend });
    fireEvent.keyDown(textarea(), { key: 'Enter', code: 'Enter' });
    expect(onSend).not.toHaveBeenCalled();
  });

  /**
   * 发送键（X 自带那颗圆形上箭头）的禁用态**两档都要对**。
   *
   * 这一条来自真实浏览器冒烟：给 `Sender` 传 `disabled={false}` 会让 X 自己那条「输入为空就禁用」
   * **彻底失效**（`ActionButton` 的判据是 `restProps.disabled ?? rootDisabled ?? context.onSendDisabled`，
   * `??` 只在 `null`/`undefined` 上继续往下问）⇒ 空框上那颗键看着可点、点下去什么都不发生。
   * 而契约里「只有附件、没有正文」是合法的一条 ⇒ 那一档又必须能点。两档只能由调用方判。
   */
  it('空框 + 没有附件 ⇒ 发送键禁用（不许留一颗点了没反应的键）', () => {
    renderComposer();
    expect(sendButton()).toBeDisabled();
  });

  it('★ 只有附件、没有正文 ⇒ 发送键可点（契约允许这一条：清单本身就是内容）', async () => {
    const { container } = renderComposer({ onUploadAttachment: () => Promise.resolve(ATTACHMENT) });
    expect(sendButton()).toBeDisabled();
    const input = container.querySelector('input[type="file"]');
    Object.defineProperty(input, 'files', { value: [new File(['hello'], 'a.md', { type: 'text/markdown' })] });
    fireEvent.change(input as Element);
    await waitFor(() => expect(sendButton()).toBeEnabled());
  });

  it('有正文 ⇒ 可点；投不进去的家 ⇒ 禁用', () => {
    const { unmount } = renderComposer();
    expect(sendButton()).toBeDisabled();
    fireEvent.change(textarea(), { target: { value: '有正文' } });
    expect(sendButton()).toBeEnabled();
    unmount();
    renderComposer({ declaration: null });
    fireEvent.change(textarea(), { target: { value: '有正文' } });
    expect(sendButton()).toBeDisabled();
  });
});

describe('排队区', () => {
  it('默认收起：两条以上收进面板，**露出计数**（那两颗按钮被藏起来后唯一的可见信号）', () => {
    renderComposer({ messages: [messageOf('m-1'), messageOf('m-2')] });
    expect(screen.getByText('2 条排队消息')).toBeInTheDocument();
    expect(screen.queryByText(/m-1 的正文/)).toBeNull();
  });

  it('单行直出（不套壳）', () => {
    renderComposer({ messages: [messageOf('m-1')] });
    expect(screen.getByText(/m-1 的正文/)).toBeInTheDocument();
    expect(screen.queryByText(/条排队消息/)).toBeNull();
  });

  it('`gone` 不进队列（它留在快照里只为幂等，画出来就是把消失的消息说成还在等）', () => {
    renderComposer({
      messages: [messageOf('m-1', { state: 'gone', outcome: 'timed-out', reason: '等太久了', settledAt: '2026-09-22T10:32:00.000Z' })],
    });
    expect(screen.queryByText(/m-1 的正文/)).toBeNull();
  });

  it('「删除」把**这一条**的 id 交出去（画错行会把别人的消息撤掉）', async () => {
    const onRetract = vi.fn(() => Promise.resolve());
    renderComposer({ messages: [messageOf('m-7')], onRetract });
    fireEvent.click(screen.getByRole('button', { name: '删除' }));
    await waitFor(() => expect(onRetract).toHaveBeenCalledWith('m-7'));
  });

  it('「立即发送」把这一条 id 交出去', async () => {
    const onPromote = vi.fn(() => Promise.resolve());
    renderComposer({ messages: [messageOf('m-7')], onPromote });
    fireEvent.click(screen.getByRole('button', { name: '立即发送' }));
    await waitFor(() => expect(onPromote).toHaveBeenCalledWith('m-7'));
  });
});

describe('撤回之后回填（删除是双态动作）', () => {
  it('★ 文本与附件**一起**回填；从没投出去过的那条不给一次性提示', async () => {
    const message = messageOf('m-1', { text: '还回来的这句', attachments: [ATTACHMENT] });
    renderComposer({ messages: [message], onRetract: () => Promise.resolve() });

    fireEvent.click(screen.getByRole('button', { name: '删除' }));

    await waitFor(() => expect(textarea().value).toBe('还回来的这句'));
    // 附件跟着回来（只回文本会静默丢文件）：路径不上屏幕，故以「框上方那一行的清单里出现了它」为判据
    // （X 把文件名拆成主名与后缀两个节点，故按整段 `textContent` 判，不逐节点找文本）
    const chips = await screen.findByTestId('inject-attachments');
    expect(chips.textContent).toContain('a.md');
    expect(screen.queryByTestId('inject-refill-notice')).toBeNull();
  });

  it('草稿里已有半句 ⇒ 回填的内容补在**前面**、用一个换行隔开', async () => {
    renderComposer({ messages: [messageOf('m-1', { text: '先说的' })], onRetract: () => Promise.resolve() });
    fireEvent.change(textarea(), { target: { value: '我刚写了一半' } });
    fireEvent.click(screen.getByRole('button', { name: '删除' }));
    await waitFor(() => expect(textarea().value).toBe('先说的\n我刚写了一半'));
  });

  it('★ 交给过厂商的那条回填时给一句一次性提示（重发会变成两条）', async () => {
    // 它是**已交给厂商**的那一条（撤得回来，故「删除」在；`deliveredAt` 非空 ⇒ 回填时要提示）
    const message = messageOf('m-1', { state: 'delivered', deliveredAt: '2026-09-22T10:31:00.000Z' });
    renderComposer({ messages: [message], onRetract: () => Promise.resolve() });
    fireEvent.click(screen.getByRole('button', { name: '删除' }));
    const notice = await screen.findByTestId('inject-refill-notice');
    expect(notice.textContent).toContain('两条');
  });

  it('撤回失败（409「已经交给模型了」）⇒ 原因交给调用方，**框里不回填**', async () => {
    const onError = vi.fn();
    renderComposer({
      messages: [messageOf('m-1', { state: 'delivered', deliveredAt: '2026-09-22T10:31:00.000Z' })],
      onRetract: () => Promise.reject(new Error('已经交给智能体了，撤不回来')),
      onError,
    });
    fireEvent.click(screen.getByRole('button', { name: '删除' }));
    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(textarea().value).toBe('');
  });
});

describe('附件：点选 → 落盘 → 进清单', () => {
  it('选一份文件 ⇒ 走 multipart 回调（`beforeUpload: () => false`，文件不往别处传）⇒ 名字进框上方那一行', async () => {
    const onUploadAttachment = vi.fn((_input: InjectUploadInput) => Promise.resolve(ATTACHMENT));
    const { container } = renderComposer({ onUploadAttachment });

    const input = container.querySelector('input[type="file"]');
    expect(input).not.toBeNull();
    const file = new File(['hello'], 'a.md', { type: 'text/markdown' });
    Object.defineProperty(input, 'files', { value: [file] });
    fireEvent.change(input as Element);

    await waitFor(() => expect(onUploadAttachment).toHaveBeenCalledTimes(1));
    const call = onUploadAttachment.mock.calls[0]?.[0] as InjectUploadInput;
    expect(call.file).toBe(file);
    // 附件目录名用同一条草稿的 id（先落盘拿到路径、再点发送）
    expect(call.messageId).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
    const chips = await screen.findByTestId('inject-attachments');
    expect(chips.textContent).toContain('a.md');
  });

  /**
   * **前置拦**：超限的那一份根本不进清单、也不走上传。
   *
   * 拦在界面上的理由只是体验（服务端照样拦，界面能被绕开）：让用户先选完 11 个文件、
   * 传到一半再收到 400，等于白等一趟往返。**判据与服务端读同一处常量**（`@aieval/contracts`），
   * 故两边永远同时变——在这里另写一份字面量，改了契约就会出现「界面放行、服务端拒绝」。
   */
  it('★ 单份超 20 MB ⇒ 不进清单、不发起上传，并给一句可展示的中文原因', async () => {
    const onUploadAttachment = vi.fn((_input: InjectUploadInput) => Promise.resolve(ATTACHMENT));
    const onError = vi.fn();
    const { container } = renderComposer({ onUploadAttachment, onError });

    pickFiles(container, [new File([new ArrayBuffer(ATTACHMENT_MAX_FILE_BYTES + 1)], 'big.bin')]);

    // 点选到「进清单」这条路本身是异步的（X 的 upload 回调在微任务里），故断言前先等它落定
    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(onUploadAttachment).not.toHaveBeenCalled();
    expect(screen.queryByTestId('inject-attachments')).toBeNull();
    const cause = onError.mock.calls[0]?.[0] as ServiceError;
    // 形状必须是 `ServiceError`：页面的提示走 `describeError`，别的错误一律折成「操作失败，请稍后重试」
    expect(cause).toBeInstanceOf(ServiceError);
    expect(cause.message).toContain('20.0 MB');
    expect(cause.message).toContain('big.bin');
  });

  it('★ 单条消息超过 10 个 ⇒ 多出来的那几份不进清单（已收下的照旧上传）', async () => {
    const onUploadAttachment = vi.fn((_input: InjectUploadInput) => Promise.resolve(ATTACHMENT));
    const onError = vi.fn();
    const { container } = renderComposer({ onUploadAttachment, onError });

    const files = Array.from(
      { length: ATTACHMENT_MAX_PER_MESSAGE + 2 },
      (_unused, index) => new File([`第 ${String(index)} 份`], `f${String(index)}.txt`, { type: 'text/plain' }),
    );
    pickFiles(container, files);

    await waitFor(() => expect(onError).toHaveBeenCalled());
    expect(onUploadAttachment).toHaveBeenCalledTimes(ATTACHMENT_MAX_PER_MESSAGE);
    const cause = onError.mock.calls[0]?.[0] as ServiceError;
    expect(cause).toBeInstanceOf(ServiceError);
    // 被拦下的那两份点名说清楚是哪两个（用户据此决定删哪个）
    const said = onError.mock.calls.map((one) => (one[0] as ServiceError).message).join('\n');
    expect(said).toContain(`最多 ${String(ATTACHMENT_MAX_PER_MESSAGE)} 个附件`);
    expect(said).toContain('「f10.txt」');
    expect(said).toContain('「f11.txt」');
    // 收下的那 10 份一个都不许出现在原因里（说错一份会让用户去删一个没问题的文件）
    for (const index of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]) {
      expect(said).not.toContain(`「f${String(index)}.txt」`);
    }
  });
});

/**
 * 点选文件（X 的触发态把真实 input 藏在 `Attachments` 里）：把 `files` 挂上去再派发 `change`。
 * 与既有那条用例同一手法——本仓的 `beforeUpload: () => false` 让这条路不需要真上传。
 */
function pickFiles(container: HTMLElement, files: readonly File[]): void {
  const input = container.querySelector('input[type="file"]');
  if (input === null) throw new Error('没找到文件选择器');
  Object.defineProperty(input, 'files', { value: files });
  fireEvent.change(input);
}

describe('紧凑密度只套输入区（静态判据）', () => {
  /**
   * 这一格跨**两个文件**：排队区在 `inject-composer.tsx`（整支抽屉的密度），
   * 输入区与那一层 `ConfigProvider` 在共用件 `composer-input.tsx`（两个入口共用同一份形态）。
   * 判据仍是原来的两条——**顺序**（排队区在上、输入区在下）与**包裹**（`ConfigProvider` 真的
   * 把输入区包在里面）——只是不再假设它们同住一个文件。
   */
  it('排队区在输入区**之前**，且紧凑密度那一层真的包住输入区', () => {
    const composer = readFileSync(join(import.meta.dirname, 'inject-composer.tsx'), 'utf8');
    const queueAt = composer.indexOf('<InjectQueuePanel');
    const inputAt = composer.indexOf('<CompactComposerArea');
    expect(queueAt).toBeGreaterThan(-1);
    expect(inputAt).toBeGreaterThan(queueAt);

    const shared = readFileSync(join(import.meta.dirname, 'composer-input.tsx'), 'utf8');
    const providerAt = shared.indexOf('<ConfigProvider');
    const areaAt = shared.indexOf('<ComposerInputArea');
    expect(providerAt).toBeGreaterThan(-1);
    expect(areaAt).toBeGreaterThan(providerAt);
    // 输入区那一块必须**在** `ConfigProvider` 的闭合之前（否则它其实没被套上）
    expect(shared.indexOf('</ConfigProvider>')).toBeGreaterThan(areaAt);
    // 套的是**紧凑**那一份主题：换成默认主题会让「页面 12px、输入框 14px」当场回来
    expect(shared).toContain('compactTheme(');
  });
});
