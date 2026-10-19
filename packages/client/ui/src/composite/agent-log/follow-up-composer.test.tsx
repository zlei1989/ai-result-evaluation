/**
 * 追问的输入区（L2）：跑完的那一行底下那一行输入框。
 *
 * 六条靶子（每一条坏掉都没有运行时症状——界面照旧画得出来，只是说的不是真的）：
 *   1. **空输入不许发**：一句话都没有、附件也没有的追问交给模型只会得到一句「你发了什么」；
 *   2. 发送把「这一句话 + 附件清单 + 这条草稿的 id」一起交出去（`messageId` 同时是附件目录名）；
 *   3. **附件先落盘、再允许发送**：选一份文件走 multipart 回调拿回路径，名字出现在框上方那一行；
 *   4. 附件 `kind` 按 MIME 分档（一律给 `file` 会让一张图在日志里被画成一个文件）；
 *   5. 发送失败时框里的内容**一个字不动**（用户不必重打），原因交回调用方；超限的那一份
 *      **不进清单**（判据与第一期、与服务端同一份常量）——两条输入区吃同一个共用件，故这一条
 *      在两边同时成立；
 *   6. **形态复用第一期那一套**（静态判据）：走共用的 `CompactComposerArea`，
 *      自己不 import X 的任何一个件——「另造一套」在这条上当场红。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ATTACHMENT_MAX_FILE_BYTES, ServiceError, type FollowUpVerdict, type InjectAttachment } from '@aieval/contracts';
import {
  FollowUpComposer,
  followUpSuggestionsOf,
  type FollowUpSendInput,
  type FollowUpUploadInput,
} from './follow-up-composer';
import type { AgentLogFacts } from './types';
import { installMatchMediaStub } from '../../testing/match-media';
import { installResizeObserverStub } from '../../testing/resize-observer';

beforeEach(() => {
  installResizeObserverStub();
  installMatchMediaStub();
});

const ATTACHMENT: InjectAttachment = { kind: 'file', path: '/tmp/row/attachments/m-1/a.md', mimeType: 'text/markdown' };

/** 这一行的行级事实（建议 chips 从它派生；默认 = 跑成功、有改动、窗口已知） */
const FACTS: AgentLogFacts = {
  status: { tone: 'ok', label: '已评分' },
  startedAt: '2026-10-02T10:00:00.000Z',
  endedAt: '2026-10-02T10:03:00.000Z',
  turns: { current: 2, total: null },
  tokens: { input: 218, cached: 8_832, output: 1_420 },
  thinking: null,
  domain: [{ id: 'diff', label: '改动', value: '2 个文件 +10 −3' }],
  error: null,
  contextUsed: 9_050,
  contextWindow: 128_000,
};

/** 渲染这个件；每个回调默认给一个 resolved 的实现（用例只覆盖自己要考的那一个） */
function renderComposer(options: {
  busy?: boolean;
  onSend?: (input: FollowUpSendInput) => Promise<void>;
  onUploadAttachment?: (input: FollowUpUploadInput) => Promise<InjectAttachment>;
  onError?: (cause: unknown) => void;
  facts?: AgentLogFacts;
  followUpVerdict?: FollowUpVerdict;
} = {}) {
  return render(
    <FollowUpComposer
      busy={options.busy ?? false}
      facts={options.facts ?? FACTS}
      followUpVerdict={options.followUpVerdict ?? { ok: true }}
      onSend={options.onSend ?? (() => Promise.resolve())}
      onUploadAttachment={options.onUploadAttachment ?? (() => Promise.resolve(ATTACHMENT))}
      onError={options.onError ?? vi.fn()}
    />,
  );
}

/** 输入框（`InputGroupTextarea` 渲染出的那个受控 textarea） */
function textarea(): HTMLTextAreaElement {
  return screen.getByRole('textbox') as HTMLTextAreaElement;
}

/** 发送键：Prompt Input 的 block-end addon 里那颗键（两个入口同名同序，按可访问名认） */
function sendButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: '发送' }) as HTMLButtonElement;
}

describe('FollowUpComposer：发送', () => {
  it('空输入 ⇒ 发送键禁用；打字之后才可点，并把这句话与草稿 id 一起交出去', async () => {
    const onSend = vi.fn((_input: FollowUpSendInput) => Promise.resolve());
    renderComposer({ onSend });

    expect(sendButton()).toBeDisabled();
    fireEvent.change(textarea(), { target: { value: '接着把测试补上' } });
    await waitFor(() => expect(sendButton()).toBeEnabled());
    fireEvent.click(sendButton());

    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    const call = onSend.mock.calls[0]?.[0] as FollowUpSendInput;
    expect(call.text).toBe('接着把测试补上');
    expect(call.attachments).toEqual([]);
    // 这条草稿的 id 同时是附件目录名与账本钥匙（客户端铸，服务端按它对齐两处）
    expect(call.messageId).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
  });

  it('受理之后清空输入框（下一条追问从空白开始）', async () => {
    renderComposer();
    fireEvent.change(textarea(), { target: { value: '第一句' } });
    await waitFor(() => expect(sendButton()).toBeEnabled());
    fireEvent.click(sendButton());
    await waitFor(() => expect(textarea().value).toBe(''));
  });

  it('发送失败 ⇒ 框里的内容一个字不动，原因交回调用方（那句话多半要改一改再发）', async () => {
    const onError = vi.fn();
    renderComposer({ onSend: () => Promise.reject(new Error('这一行没有可续接的会话')), onError });

    fireEvent.change(textarea(), { target: { value: '在吗' } });
    await waitFor(() => expect(sendButton()).toBeEnabled());
    fireEvent.click(sendButton());

    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(textarea().value).toBe('在吗');
  });

  it('常驻提示说清发出去之后会发生什么（不是只说「能发」）', () => {
    renderComposer();
    expect(screen.getByTestId('follow-up-hint').textContent).toContain('接着这一行原来那段会话');
    expect(screen.getByTestId('follow-up-hint').textContent).toContain('自动重新评分');
  });

  it('有写动作在途 ⇒ 输入框禁用（连点两次会变成两段上下文）', () => {
    renderComposer({ busy: true });
    expect(textarea()).toBeDisabled();
  });
});

describe('FollowUpComposer：附件', () => {
  it('选一份文件 ⇒ 走 multipart 回调（隐藏的 file input 只交 `File`，文件不往别处传）⇒ 名字进框内那一行', async () => {
    const onUploadAttachment = vi.fn((_input: FollowUpUploadInput) => Promise.resolve(ATTACHMENT));
    const { container } = renderComposer({ onUploadAttachment });

    const input = container.querySelector('input[type="file"]');
    expect(input).not.toBeNull();
    const file = new File(['hello'], 'a.md', { type: 'text/markdown' });
    Object.defineProperty(input, 'files', { value: [file] });
    fireEvent.change(input as Element);

    await waitFor(() => expect(onUploadAttachment).toHaveBeenCalledTimes(1));
    expect((onUploadAttachment.mock.calls[0]?.[0] as FollowUpUploadInput).file).toBe(file);
    const chips = await screen.findByTestId('follow-up-attachments');
    expect(chips.textContent).toContain('a.md');
  });

  /**
   * 前置拦**在追问这一边同样生效**：两条输入区吃同一个共用件（`composer-input.tsx`），
   * 所以这一条不是「又实现了一遍」，而是钉住「追问那一支真的接的是那一份共用件」。
   */
  it('★ 超 20 MB 的那一份不进清单，原因走 `onError`（共用件的前置拦两条输入区都吃）', async () => {
    const onUploadAttachment = vi.fn((_input: FollowUpUploadInput) => Promise.resolve(ATTACHMENT));
    const onError = vi.fn();
    const { container } = renderComposer({ onUploadAttachment, onError });

    const input = container.querySelector('input[type="file"]');
    Object.defineProperty(input, 'files', {
      value: [new File([new ArrayBuffer(ATTACHMENT_MAX_FILE_BYTES + 1)], 'big.bin')],
    });
    fireEvent.change(input as Element);

    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(onUploadAttachment).not.toHaveBeenCalled();
    expect(screen.queryByTestId('follow-up-attachments')).toBeNull();
    const cause = onError.mock.calls[0]?.[0] as ServiceError;
    expect(cause).toBeInstanceOf(ServiceError);
    expect(cause.message).toContain('20.0 MB');
    expect(cause.message).toContain('big.bin');
  });

  it('附件 `kind` 按 MIME 分档（图片给 `image`——一律给 `file` 会让一张图在日志里被画成文件）', async () => {
    const onSend = vi.fn((_input: FollowUpSendInput) => Promise.resolve());
    // 落盘那一份的 MIME 才是判据（`File.type` 由浏览器给，路径回读时只剩它）
    const image: InjectAttachment = { kind: 'image', path: '/tmp/row/attachments/m-1/shot.png', mimeType: 'image/png' };
    const { container } = renderComposer({ onSend, onUploadAttachment: () => Promise.resolve(image) });

    const input = container.querySelector('input[type="file"]');
    const file = new File(['png'], 'shot.png', { type: 'image/png' });
    Object.defineProperty(input, 'files', { value: [file] });
    fireEvent.change(input as Element);
    // 等「那一份已经落盘」：清单按文件类型画图标，故判据只能是「清单位置出现了」——
    // 名字那一档由上面那条 md 的用例钉
    await waitFor(() => expect(screen.getByTestId('follow-up-attachments')).toBeInTheDocument());

    fireEvent.change(textarea(), { target: { value: '看这张图' } });
    await waitFor(() => expect(sendButton()).toBeEnabled());
    fireEvent.click(sendButton());

    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect((onSend.mock.calls[0]?.[0] as FollowUpSendInput).attachments).toEqual([
      { kind: 'image', path: image.path, mimeType: 'image/png' },
    ]);
  });

  it('只有附件、没有正文也能发（那份清单本身就是内容）', async () => {
    const onSend = vi.fn((_input: FollowUpSendInput) => Promise.resolve());
    const { container } = renderComposer({ onSend });
    const input = container.querySelector('input[type="file"]');
    Object.defineProperty(input, 'files', { value: [new File(['x'], 'a.md', { type: 'text/markdown' })] });
    fireEvent.change(input as Element);

    await waitFor(() => expect(sendButton()).toBeEnabled());
    fireEvent.click(sendButton());
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect((onSend.mock.calls[0]?.[0] as FollowUpSendInput).attachments).toHaveLength(1);
  });
});

describe('FollowUpComposer：形态复用第一期那一套（静态判据）', () => {
  it('走共用的 `CompactComposerArea`，自己不 import X 的任何一个件', () => {
    const source = readFileSync(join(import.meta.dirname, 'follow-up-composer.tsx'), 'utf8');
    // 「另造一套」的两种形态：自己拼 X 的 Sender / 自己再套一层密度
    expect(source).not.toContain('@ant-design/x');
    expect(source).not.toContain('ConfigProvider');
    expect(source).toContain('CompactComposerArea');
  });
});

/**
 * 建议 chips（`Suggestion`）：输入区上方一排短句，**点一下直接发**。
 *
 * 四条靶子：
 *   · 点一下真的走发送路径（不是只把文字填进输入框——那样用户还得再按一次）；
 *   · 发送中一起禁用（连点两次就是两段上下文）；
 *   · 不可追问时禁用，且原因**逐字来自** `followUpAvailability` 的判据（不自己编一句）；
 *   · 建议由**这一行的结局**派生（失败 / 中断 / 成功各一档，没有结局就没有建议），
 *     不是一排固定文案——固定文案会退化成装饰。
 */
describe('FollowUpComposer：建议 chips', () => {
  /** 第一枚 chip 的可访问名（成功行的第一档建议） */
  function chip(): HTMLButtonElement {
    return screen.getByRole('button', { name: '把这次改动总结成三条' }) as HTMLButtonElement;
  }

  it('点一下直接发送：发送回调收到的正文就是 chip 文案（不是只填进输入框）', async () => {
    const onSend = vi.fn((_input: FollowUpSendInput) => Promise.resolve());
    renderComposer({ onSend });

    fireEvent.click(chip());

    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    const input = onSend.mock.calls[0]?.[0] as FollowUpSendInput;
    expect(input.text).toBe('把这次改动总结成三条');
    expect(input.attachments).toEqual([]);
    expect(input.messageId).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
    // 没有「先填进框里」这半步：框里一个字都不该多出来
    expect(textarea().value).toBe('');
  });

  it('不可追问时（followUpAvailability 拒绝）chips 禁用，原因逐字来自那份判据', () => {
    renderComposer({ followUpVerdict: { ok: false, reason: '这一行上一次追问还没收尾' } });

    expect(chip()).toBeDisabled();
    expect(screen.getByTestId('follow-up-suggestions-blocked')).toHaveTextContent('这一行上一次追问还没收尾');
  });

  it('发送中 chips 一起禁用（连点两次会变成两段上下文）', async () => {
    let release: (() => void) | undefined;
    const onSend = vi.fn(
      (_input: FollowUpSendInput) =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    renderComposer({ onSend });

    fireEvent.click(chip());
    await waitFor(() => expect(chip()).toBeDisabled());

    release?.();
    await waitFor(() => expect(chip()).toBeEnabled());
  });

  it('建议由这一行的结局派生：失败 / 中断 / 成功各一档，未跑完没有建议', () => {
    const failed = followUpSuggestionsOf({
      status: { tone: 'failed', label: '失败' },
      error: { code: 'AGENT_FAILED', message: '非零退出码' },
      domain: [],
    });
    expect(failed[0]).toContain('失败');

    const canceled = followUpSuggestionsOf({
      status: { tone: 'canceled', label: '已中断' },
      error: null,
      domain: [],
    });
    expect(canceled.length).toBeGreaterThan(0);
    expect(canceled[0]).toContain('中断');

    const ok = followUpSuggestionsOf({ status: { tone: 'ok', label: '已评分' }, error: null, domain: [] });
    expect(ok.length).toBeGreaterThan(0);

    // 还没跑完（pending / running）：没有结局可依据 ⇒ 一条建议都不给
    expect(followUpSuggestionsOf({ status: { tone: 'pending', label: '待开始' }, error: null, domain: [] })).toEqual([]);
    expect(followUpSuggestionsOf({ status: { tone: 'running', label: '执行中' }, error: null, domain: [] })).toEqual([]);
  });
});
