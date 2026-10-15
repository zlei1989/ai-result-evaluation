'use client';

/**
 * 输入区的**共用件**（L2）：一条草稿的状态机（正文 + 附件清单 + 上传）+ 那一行输入区本身。
 *
 * 为什么单独一格：这一面有**两个入口共用一个形态**——运行中的「人工消息」（`inject-composer.tsx`）
 * 与跑完之后的「追问」（`follow-up-composer.tsx`）。两者只差「这一句话怎么发出去」，
 * 而形态（附件 chips 住框上方、X 自带的圆形发送键、紧凑密度只套输入区）必须**逐像素相同**：
 * 各写一份的结果是同一种控件在两个入口长得不一样，而那种漂移没人会当场发现。
 *
 * 三条口径原样保留（它们是从调用方搬过来的，理由不变）：
 *   1. **`beforeUpload: () => false`**：文件不往任何地方传，只留在调用方手里——它走本仓的
 *      multipart 端点（让 antd 自传会变成两份真相）；
 *   2. **附件清单住框上方一行 chips**（`scrollX`，只占一行高）、**不进 `prefix`**：
 *      `Attachments` 把清单渲在自己内部，塞进 `prefix` 会被挤进输入框那一行；
 *   3. **紧凑密度只套输入区**（`ConfigProvider` + `compactTheme`）：X 的 `Sender` / `Attachments`
 *      没有 `size` 能力，不套就是「页面 12px、输入框 14px」；而整支抽屉的字号不动是用户口径。
 *   4. **超限的那一份在选文件那一刻就拦掉、根本不进清单**（20 MB / 10 个，判据从
 *      `@aieval/contracts` 读，与服务端同一份常量）。这一道只为体验——服务端照样拦，界面能被
 *      绕开；让用户先选完 11 个文件、传到一半再收到 400，等于白等一趟往返。拦下时给一句
 *      可展示的中文原因（走 `onError` 那条既有通路），点名是哪一份、超了哪一条限制。
 *
 * 本件**不判厂商、也不判可用性**：`canSend` 与 `disabled` 由调用方给（只有它知道这一档投不投得进去、
 * 有没有写动作在途）。
 */
import { LinkOutlined } from '@ant-design/icons';
import { Button, ConfigProvider, Flex, theme } from 'antd';
import { useCallback, useMemo, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react';
import {
  ATTACHMENT_MAX_FILE_BYTES,
  ATTACHMENT_MAX_PER_MESSAGE,
  ServiceError,
  type InjectAttachment,
} from '@aieval/contracts';
import { formatBytes } from '../../base/format';
import { XAttachments, type XAttachmentItem, type XAttachmentsHandle } from '../../base/x-attachments';
import { XSender, XSenderHeader } from '../../base/x-sender';
import { useDensityMode } from '../../base/density-context';
import { compactTheme, type DensityMode } from '../../base/density';
import { newInjectMessageId, pickedFiles, type PendingInjectAttachment } from './inject-vocab';

/** 一次附件上传：文件与它归属的那条草稿的 id */
export interface ComposerUploadInput {
  messageId: string;
  file: File;
}

export interface ComposerDraftOptions {
  /** 落一份附件（走本仓的 multipart 端点），拿回它的清单项 */
  onUploadAttachment(input: ComposerUploadInput): Promise<InjectAttachment>;
  /**
   * 失败原因交回调用方呈现（本层不弹全局提示：它不知道宿主用哪一种）。两种来源共用这一格：
   * 上传真的失败了，以及文件在**选进来那一刻**就超限（后者根本没发起上传）。
   */
  onError?(cause: unknown): void;
}

/** 一条草稿的状态与动作（正文 / 附件清单 / 上传 / 清空） */
export interface ComposerDraftState {
  draft: string;
  setDraft: Dispatch<SetStateAction<string>>;
  /** 清单（含正在上传与上传失败的那几份） */
  pending: readonly PendingInjectAttachment[];
  setPending: Dispatch<SetStateAction<readonly PendingInjectAttachment[]>>;
  /** 已经落盘、可以随这句话一起发出去的那几份 */
  ready: readonly PendingInjectAttachment[];
  /** 有附件正在上传（在途时不许发送：那会漏掉这一份） */
  uploading: boolean;
  /** 这一条草稿的 id（**调用时才铸**：附件落点目录与账本共用同一把钥匙） */
  draftId(): string;
  /** 受理之后清空这一条草稿（失败时框里的内容一个字都不动，用户不必重打） */
  reset(): void;
  /** 清单里被移除的那几份（X 交回的是**剩下的**那份清单） */
  onPendingItemsChange(next: readonly XAttachmentItem[]): void;
  /** 新选进来（或拖进来）的文件：先落盘拿到路径，再允许发送 */
  onPickFiles(items: readonly XAttachmentItem[]): void;
}

/**
 * 这一批选进来的文件里，**哪些收得下、哪些超限**（前置拦的判据与文案都在这一处）。
 *
 * 两条限制彼此独立、各自点名：单份超 20 MB 与整条消息超 10 个的处置不同（换个小文件 / 删几个），
 * 合成一句「附件不合法」会让用户不知道该做哪一件。上限从 `@aieval/contracts` 读，与服务端
 * **同一份常量**——在这里另写一份字面量，改了契约就会出现「界面放行、服务端拒绝」。
 *
 * `existing` 是清单里**已经有的**份数：条数上限判的是整条消息，不是这一批。判过的那几份由调用方
 * 记进去重集合（含被拒的），否则同一次选择里的后续回调会把它们反复判一遍。
 */
export function filterWithinAttachmentLimits<T extends { file: File }>(
  picked: readonly T[],
  existing: number,
): { accepted: readonly T[]; reasons: readonly string[] } {
  const accepted: T[] = [];
  const reasons: string[] = [];
  for (const item of picked) {
    if (item.file.size > ATTACHMENT_MAX_FILE_BYTES) {
      reasons.push(
        `「${item.file.name}」有 ${formatBytes(item.file.size)}，超过单个附件的上限 ${formatBytes(ATTACHMENT_MAX_FILE_BYTES)}`,
      );
      continue;
    }
    if (existing + accepted.length + 1 > ATTACHMENT_MAX_PER_MESSAGE) {
      reasons.push(
        `「${item.file.name}」超出了单条消息最多 ${String(ATTACHMENT_MAX_PER_MESSAGE)} 个附件的上限，先删掉几个再加`,
      );
      continue;
    }
    accepted.push(item);
  }
  return { accepted, reasons };
}

/**
 * 一条草稿的状态机。
 *
 * 「先落盘拿到路径、再允许发送」是**时序上的硬要求**：登记那一刻正文与附件清单就是完整事实，
 * 故上传在选文件时就发生，失败只影响它自己（其余照旧上传）。一条失败的原因交回调用方提示。
 */
export function useComposerDraft(options: ComposerDraftOptions): ComposerDraftState {
  const { onUploadAttachment, onError } = options;
  const [draft, setDraft] = useState('');
  const [pending, setPendingState] = useState<readonly PendingInjectAttachment[]>([]);
  /**
   * 清单的**镜像**：`onPickFiles` 要在事件里同步判「还收得下几份」，而 state 的更新是异步的。
   * ref 与 state 由下面这一个写入口一起推进（`reset` 与外部回填撤回的那条也走它），
   * 故事件里读到的永远是最新值；两处各写一份的结果是「明明还剩 3 个名额，第 4 个却被拒」。
   */
  const pendingRef = useRef<readonly PendingInjectAttachment[]>([]);
  const setPending = useCallback<Dispatch<SetStateAction<readonly PendingInjectAttachment[]>>>((action) => {
    const next = typeof action === 'function' ? action(pendingRef.current) : action;
    pendingRef.current = next;
    setPendingState(next);
  }, []);

  /** 这一条草稿的 id：第一次要它的时候铸（附件落盘与登记共用同一个），发出去之后清掉 */
  const draftIdRef = useRef<string | null>(null);
  /** 已经交给上传流程的清单 `uid`（触发态的清单是累积的，不去重会上传两份） */
  const seenIdsRef = useRef<Set<string>>(new Set());

  const draftId = useCallback((): string => {
    if (draftIdRef.current === null) draftIdRef.current = newInjectMessageId();
    return draftIdRef.current;
  }, []);

  const reset = useCallback((): void => {
    setDraft('');
    setPending([]);
    draftIdRef.current = null;
    seenIdsRef.current = new Set();
  }, []);

  const onPendingItemsChange = useCallback((next: readonly XAttachmentItem[]) => {
    const kept = new Set(next.map((item) => item.uid));
    setPending((previous) => previous.filter((item) => kept.has(item.uid)));
  }, []);

  const onPickFiles = useCallback(
    (items: readonly XAttachmentItem[]) => {
      const picked = pickedFiles(items, seenIdsRef.current);
      if (picked.length === 0) return;
      /**
       * **这一批里的每一份都只判一次**：X 的触发态在选多份文件时会按份回调几次，
       * 每次都把累积的清单交回来；只把「收下的」记进 `seen` 的话，被拒的那一份会在后续几次里
       * 反复被判、反复弹同一句提示。`seen` 按**这一次选择**的 `uid` 记（`uid` 每次选择都是新的），
       * 故用户删掉几个再重新选同一份文件仍会被重新考虑——被拒过的文件不该被永久拉黑。
       */
      for (const { uid } of picked) seenIdsRef.current.add(uid);
      // 前置拦：超限的那几份不进清单、也不发起上传（一次选多个时合成一句提示，不刷屏）
      const { accepted, reasons } = filterWithinAttachmentLimits(picked, pendingRef.current.length);
      if (reasons.length > 0) onError?.(new ServiceError('INVALID_QUERY', reasons.join('\n')));
      if (accepted.length === 0) return;
      const messageId = draftId();
      setPending([
        ...pendingRef.current,
        ...accepted.map(({ uid, file }) => ({
          uid,
          name: file.name,
          status: 'uploading' as const,
          path: null,
          // 浏览器认不出类型时给空串 ⇒ 落 `null`（与契约同口径：空串会被当成一个「有值的类型」显示）
          mimeType: file.type === '' ? null : file.type,
        })),
      ]);
      for (const { uid, file } of accepted) {
        void onUploadAttachment({ messageId, file }).then(
          (attachment) => {
            setPending((previous) =>
              previous.map((item) =>
                item.uid === uid ? { ...item, status: 'done', path: attachment.path, mimeType: attachment.mimeType } : item,
              ),
            );
          },
          (cause: unknown) => {
            setPending((previous) => previous.map((item) => (item.uid === uid ? { ...item, status: 'error' } : item)));
            onError?.(cause);
          },
        );
      }
    },
    [draftId, onError, onUploadAttachment],
  );

  const ready = useMemo(
    () => pending.filter((item) => item.status === 'done' && item.path !== null),
    [pending],
  );

  return {
    draft,
    setDraft,
    pending,
    setPending,
    ready,
    uploading: pending.some((item) => item.status === 'uploading'),
    draftId,
    reset,
    onPendingItemsChange,
    onPickFiles,
  };
}

/**
 * 已经落盘的那几份 → 契约里的附件清单。
 *
 * `kind` 按契约那一条规则从 `mimeType` 分档（`File.type` 以 `image/` 开头即图片）：
 * 它决定账本里那一条附件块画成图片还是文件，而**这一格是清单里唯一能回答它的地方**
 * （落盘之后只剩路径与 MIME 类型）。一律给 `'file'` 会让一张图在日志里被画成一个文件。
 */
export function attachmentListOf(ready: readonly PendingInjectAttachment[]): InjectAttachment[] {
  return ready.map((item) => ({
    kind: item.mimeType !== null && item.mimeType.startsWith('image/') ? 'image' : 'file',
    path: item.path,
    mimeType: item.mimeType,
  }));
}

/** 紧凑主题按明暗预生成一次（与 `PageShell` / 应答宿主同一份口径：别每次渲染重建 ThemeConfig） */
const COMPACT_THEMES: Record<DensityMode, ReturnType<typeof compactTheme>> = {
  light: compactTheme('light'),
  dark: compactTheme('dark'),
};

export interface CompactComposerAreaProps {
  draft: string;
  onDraftChange(next: string): void;
  /** 点发送键或回车（调用方在这一刻决定这一句话的意图） */
  onSend(): void;
  placeholder: string;
  /** 只读态（写动作在途 / 这一档不能用） */
  disabled: boolean;
  pending: readonly PendingInjectAttachment[];
  onPendingItemsChange(next: XAttachmentItem[]): void;
  onPickFiles(items: XAttachmentItem[]): void;
  /** 这一键此刻能不能点（正文非空或附件已落盘、且没有写动作在途、且这一档投得进去） */
  canSend: boolean;
  /** 输入框下面那行常驻提示 */
  hint: ReactNode;
  /** 一次性提示（撤回已交给厂商的那一条之后出现） */
  notice?: ReactNode;
  /** 附件清单那一行的 testid（两个入口各用自己的名字，免得两处的用例互相撞上） */
  attachmentsTestId: string;
}

/**
 * 输入区那一块（**在 `ConfigProvider` 里面**读 token 的那一半）。
 *
 * 为什么拆成两半：`theme.useToken()` 读的是最近一层 `ConfigProvider`，而这一块要的是**紧凑之后**
 * 的间距与字号。在外层读 token 再传进来，等于把「段落内缩」钉回抽屉那份密度——两处数值会各说各话。
 */
function ComposerInputArea({
  draft,
  onDraftChange,
  onSend,
  placeholder,
  disabled,
  pending,
  onPendingItemsChange,
  onPickFiles,
  canSend,
  hint,
  notice,
  attachmentsTestId,
}: CompactComposerAreaProps): ReactNode {
  const { token } = theme.useToken();
  const trigger = useRef<XAttachmentsHandle | null>(null);

  /**
   * 清单项：把草稿里的附件翻成 X 认的形状。
   * X 只认 `uid` / `name` / `status` 三格，我们自己的 `path` 不进这一层（那是发消息时用的）。
   */
  const items = useMemo<XAttachmentItem[]>(
    () =>
      pending.map((item) => ({
        uid: item.uid,
        name: item.name,
        status: item.status === 'error' ? 'error' : item.status === 'uploading' ? 'uploading' : 'done',
      })),
    [pending],
  );

  return (
    <Flex vertical gap={token.marginXXS} style={{ padding: `${token.paddingXS}px ${token.paddingMD}px` }}>
      {notice}
      <XSender
        value={draft}
        onChange={onDraftChange}
        onSubmit={onSend}
        placeholder={placeholder}
        disabled={disabled}
        // 清单住框上方一行（`scrollX` 只占一行高）；空清单时**不渲染那个面板**（否则白吃一段高度）
        header={
          items.length === 0 ? undefined : (
            <XSenderHeader>
              <Flex data-testid={attachmentsTestId}>
                <XAttachments items={items} overflow="scrollX" onChange={onPendingItemsChange} />
              </Flex>
            </XSenderHeader>
          )
        }
        // 触发态：回形针在框内左侧，它同时是「点选」与「拖拽落点」（`Attachments` 在它外面套了拖拽区）
        prefix={
          <XAttachments
            ref={trigger}
            beforeUpload={() => false}
            disabled={disabled}
            // 拖到抽屉里任何地方都算数（缺省只贴在触发按钮那一小块上）
            getDropContainer={() => document.body}
            onChange={onPickFiles}
          >
            <Button size="small" type="text" icon={<LinkOutlined aria-hidden />} aria-label="添加附件" disabled={disabled} />
          </XAttachments>
        }
        // 一行起步、最多 6 行（再长就把日志区压没了）；不写 `maxRows` 会用 X 的默认 8 行
        autoSize={{ minRows: 1, maxRows: 6 }}
        /**
         * 发送键仍是 **X 自带的那一颗**（`components.SendButton`，圆形上箭头），只是把
         * 「能不能点」显式交给这里：给 `Sender` 传 `disabled={false}` 会让 X 自己那条
         * 「输入为空就禁用」失效（`ActionButton` 读的是 `restProps.disabled ?? …`，`??` 只跳过
         * `null`/`undefined`），于是空框上那颗键看着可点、点下去什么都不发生。
         * 契约里「只有附件、没有正文」是合法的一条 ⇒ 那一档要能点，空框那一档要灰掉。
         */
        suffix={(_origin, { components }) => <components.SendButton disabled={!canSend} />}
      />
      {hint}
    </Flex>
  );
}

/**
 * 输入区（两个入口共用的那一块）：**只有这一层套紧凑密度**。
 * 调用方把状态机的四格与两句提示递进来即可，形态一处都不用再管。
 */
export function CompactComposerArea(props: CompactComposerAreaProps): ReactNode {
  const mode = useDensityMode();
  return (
    <ConfigProvider theme={COMPACT_THEMES[mode]}>
      <ComposerInputArea {...props} />
    </ConfigProvider>
  );
}
