'use client';

/**
 * 输入区的**共用件**（L2）：一条草稿的状态机（正文 + 附件清单 + 上传）+ 那一行输入区本身。
 *
 * 为什么单独一格：这一面有**两个入口共用一个形态**——运行中的「人工消息」（`inject-composer.tsx`）
 * 与跑完之后的「追问」（`follow-up-composer.tsx`）。两者只差「这一句话怎么发出去」，
 * 而形态必须**逐像素相同**：各写一份的结果是同一种控件在两个入口长得不一样，而那种漂移
 * 没人会当场发现。所以两个入口都只调 `CompactComposerArea`，自己不拼任何输入区结构。
 *
 * 形态取 AI Elements 的 `Prompt Input`：一个 `InputGroup` 里装下全部——
 *   · `InputGroupTextarea`（`data-slot=input-group-control`，可访问名由 placeholder 给）；
 *   · 附件清单在 `block-start` 的 addon 里（`Attachment` 一份一条、各自带移除键）；
 *   · 「添加附件」与「发送」在 `block-end` 的 addon 里（发送靠 `disabled={!canSend}`）。
 * 键盘口径：`Enter` 发送、`Shift+Enter` 换行；**输入法组合中的 `Enter` 是选词**（不发送）。
 * 附件入口有两个：框内的「添加附件」开系统选择器，以及**把文件拖进输入区**（同一落点、同一条回调）。
 *
 * 四条口径原样保留（它们是从调用方搬过来的，理由不变）：
 *   1. **文件不往任何地方传**：隐藏的 `input[type=file]` 只交出 `File`，落盘走调用方的
 *      multipart 回调（让附件组件自传会变成两份真相）；
 *   2. **附件清单只占一行**（`AttachmentGroup` 横向滚动）：它住在框内的 block-start，
 *      再高就会把日志区挤没；
 *   3. **字号与间距取密度作用域**（`[data-density]` 的 CSS 变量 + `text-body` / `gap-*` 类）：
 *      输入区不另包一层主题，避免出现第二份字号来源；
 *   4. **超限的那一份在选文件那一刻就拦掉、根本不进清单**（20 MB / 10 个，判据从
 *      `@aieval/contracts` 读，与服务端同一份常量）。这一道只为体验——服务端照样拦，界面能被
 *      绕开；让用户先选完 11 个文件、传到一半再收到 400，等于白等一趟往返。拦下时给一句
 *      可展示的中文原因（走 `onError` 那条既有通路），点名是哪一份、超了哪一条限制。
 *
 * 本件**不判厂商、也不判可用性**：`canSend` 与 `disabled` 由调用方给（只有它知道这一档投不投得进去、
 * 有没有写动作在途）。
 */
import { ArrowUpIcon, FileTextIcon, ImageIcon, PaperclipIcon, XIcon } from 'lucide-react';
import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type Dispatch,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
  type SetStateAction,
} from 'react';
import {
  ATTACHMENT_MAX_FILE_BYTES,
  ATTACHMENT_MAX_PER_MESSAGE,
  ServiceError,
  type InjectAttachment,
} from '@aieval/contracts';
import { formatBytes } from '../../base/format';
import {
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentContent,
  AttachmentDescription,
  AttachmentGroup,
  AttachmentMedia,
  AttachmentTitle,
} from '../../components/ui/attachment';
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea } from '../../components/ui/input-group';
import { newInjectMessageId, type PendingInjectAttachment } from './inject-vocab';

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
  /** 清单里被移除的那一份（按 `uid` 认：同一份文件选两次是两条） */
  onRemovePending(uid: string): void;
  /** 新选进来（或拖进来）的文件：先落盘拿到路径，再允许发送 */
  onPickFiles(files: readonly File[]): void;
}

/**
 * 这一批选进来的文件里，**哪些收得下、哪些超限**（前置拦的判据与文案都在这一处）。
 *
 * 两条限制彼此独立、各自点名：单份超 20 MB 与整条消息超 10 个的处置不同（换个小文件 / 删几个），
 * 合成一句「附件不合法」会让用户不知道该做哪一件。上限从 `@aieval/contracts` 读，与服务端
 * **同一份常量**——在这里另写一份字面量，改了契约就会出现「界面放行、服务端拒绝」。
 *
 * `existing` 是清单里**已经有的**份数：条数上限判的是整条消息，不是这一批。
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

  const draftId = useCallback((): string => {
    if (draftIdRef.current === null) draftIdRef.current = newInjectMessageId();
    return draftIdRef.current;
  }, []);

  const reset = useCallback((): void => {
    setDraft('');
    setPending([]);
    draftIdRef.current = null;
  }, []);

  const onRemovePending = useCallback((uid: string) => {
    setPending((previous) => previous.filter((item) => item.uid !== uid));
  }, []);

  const onPickFiles = useCallback(
    (files: readonly File[]) => {
      if (files.length === 0) return;
      // 每一份铸一个 uid：清单按它认条目，同一份文件重复选两次是两条
      const picked = files.map((file) => ({ uid: newInjectMessageId(), file }));
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
    onRemovePending,
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

export interface CompactComposerAreaProps {
  draft: string;
  onDraftChange(next: string): void;
  /** 点发送键或回车（调用方在这一刻决定这一句话的意图） */
  onSend(): void;
  placeholder: string;
  /** 只读态（写动作在途 / 这一档不能用） */
  disabled: boolean;
  pending: readonly PendingInjectAttachment[];
  /** 清单里被移除的那一份 */
  onRemovePending(uid: string): void;
  onPickFiles(files: readonly File[]): void;
  /** 这一键此刻能不能点（正文非空或附件已落盘、且没有写动作在途、且这一档投得进去） */
  canSend: boolean;
  /** 输入框下面那行常驻提示 */
  hint: ReactNode;
  /** 一次性提示（撤回已交给厂商的那一条之后出现） */
  notice?: ReactNode;
  /** 附件清单那一行的 testid（两个入口各用自己的名字，免得两处的用例互相撞上） */
  attachmentsTestId: string;
}

/** 草稿里一份附件此刻的处境：一句短文案（清单只占一行，塞不下长句） */
const ATTACHMENT_STATUS_TEXT: Record<PendingInjectAttachment['status'], string> = {
  uploading: '上传中…',
  done: '已就绪',
  error: '上传失败',
};

/**
 * 输入区（两个入口共用的那一块）：Prompt Input 的骨架在这里落一次，两个入口只递状态与两句话。
 *
 * 字号与间距取**密度作用域**（`[data-density]` 的变量），不另包一层主题——同一屏的字号
 * 因此只有一个来源。键盘口径也收在这一处：`Enter` 提交、`Shift+Enter` 换行、输入法组合中的
 * `Enter` 不提交（那一下是选词；提交会把半句话发出去）。
 */
export function CompactComposerArea({
  draft,
  onDraftChange,
  onSend,
  placeholder,
  disabled,
  pending,
  onRemovePending,
  onPickFiles,
  canSend,
  hint,
  notice,
  attachmentsTestId,
}: CompactComposerAreaProps): ReactNode {
  /** 「添加附件」那一颗键只负责开系统选择器：真正的落盘由 `onPickFiles` 走调用方的回调 */
  const fileInput = useRef<HTMLInputElement | null>(null);

  const submit = useCallback((): void => {
    if (disabled || !canSend) return;
    onSend();
  }, [disabled, canSend, onSend]);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>): void => {
      if (event.key !== 'Enter' || event.shiftKey) return;
      // 组合输入中的回车属于输入法（选词），不属于发送
      if (event.nativeEvent.isComposing) return;
      event.preventDefault();
      submit();
    },
    [submit],
  );

  /**
   * 拖拽落点：拖进来的文件与点选走**同一条回调**（否则两条路会各自判一次上限、各自落一次盘）。
   * 落点就是输入区这一块——抽屉别处不再接拖拽（那里没有附件的语义，接了只会让文件落在看不见的地方）。
   */
  const handleDrop = useCallback(
    (event: DragEvent<HTMLDivElement>): void => {
      if (disabled) return;
      event.preventDefault();
      onPickFiles([...(event.dataTransfer?.files ?? [])]);
    },
    [disabled, onPickFiles],
  );

  const handleFiles = useCallback(
    (event: ChangeEvent<HTMLInputElement>): void => {
      const files = [...(event.currentTarget.files ?? [])];
      // 清空选择器：同一份文件再选一次也要触发 change（不清就选不动第二次）
      event.currentTarget.value = '';
      onPickFiles(files);
    },
    [onPickFiles],
  );

  return (
    <div
      data-testid="composer-dropzone"
      className="flex flex-col gap-hair px-roomy py-tight"
      onDragOver={(event) => {
        // 不 `preventDefault` 就没有 `drop` 事件（浏览器默认拒绝接收）
        if (!disabled) event.preventDefault();
      }}
      onDrop={handleDrop}
    >
      {notice}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <InputGroup>
          {/*
            附件清单住 **block-start** addon：`AttachmentGroup` 横向滚动、只占一行。
            空清单时**不渲染这个 addon**（否则白吃一段高度，框顶多出一条空白）。
          */}
          {pending.length > 0 && (
            <InputGroupAddon align="block-start">
              <AttachmentGroup data-testid={attachmentsTestId}>
                {pending.map((item) => (
                  <Attachment key={item.uid} state={item.status} size="xs">
                    <AttachmentMedia variant="icon">
                      {item.mimeType !== null && item.mimeType.startsWith('image/') ? (
                        <ImageIcon aria-hidden />
                      ) : (
                        <FileTextIcon aria-hidden />
                      )}
                    </AttachmentMedia>
                    <AttachmentContent>
                      <AttachmentTitle>{item.name}</AttachmentTitle>
                      <AttachmentDescription>{ATTACHMENT_STATUS_TEXT[item.status]}</AttachmentDescription>
                    </AttachmentContent>
                    <AttachmentActions>
                      {/* 可访问名带上文件名：清单里多份时读屏器要能分清删的是哪一份 */}
                      <AttachmentAction
                        aria-label={`移除 ${item.name}`}
                        disabled={disabled}
                        onClick={() => onRemovePending(item.uid)}
                      >
                        <XIcon aria-hidden />
                      </AttachmentAction>
                    </AttachmentActions>
                  </Attachment>
                ))}
              </AttachmentGroup>
            </InputGroupAddon>
          )}
          <InputGroupTextarea
            value={draft}
            onChange={(event) => onDraftChange(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            disabled={disabled}
            rows={1}
            // 一行起步、最多 6 行（再长就把日志区压没了）；`field-sizing-content` 负责长高
            className="max-h-40 min-h-8"
          />
          {/*
            block-end：附件键在左、发送键靠右（`ml-auto` 从发送键那一侧把两个键拉开）。
            发送键的禁用**只由 `canSend` 判**：空框要灰、只有附件也要能点，
            而这两档都只有调用方知道（契约允许「只有附件、没有正文」这一条）。
          */}
          <InputGroupAddon align="block-end">
            <InputGroupButton
              size="icon-sm"
              variant="outline"
              aria-label="添加附件"
              disabled={disabled}
              onClick={() => fileInput.current?.click()}
            >
              <PaperclipIcon aria-hidden />
            </InputGroupButton>
            <InputGroupButton
              type="submit"
              size="icon-sm"
              variant="default"
              className="ml-auto"
              aria-label="发送"
              disabled={disabled || !canSend}
            >
              <ArrowUpIcon aria-hidden />
            </InputGroupButton>
          </InputGroupAddon>
        </InputGroup>
      </form>
      {/* 隐藏的文件选择器：「添加附件」那一颗键开它；`multiple` 一次选多份 */}
      <input ref={fileInput} type="file" multiple className="hidden" tabIndex={-1} aria-hidden onChange={handleFiles} />
      {hint}
    </div>
  );
}
