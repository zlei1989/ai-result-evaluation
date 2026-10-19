'use client';

/**
 * 人工消息的**输入区与排队区**（L2）：抽屉底部那一段固定区（`AgentLogLayout` 的 `footer` 槽）。
 *
 * 形态按 spec §4.4 的定稿，四处都是刻意的：
 *
 *   1. **输入区就是一行**：`Prompt Input` 的骨架全在共用件 `composer-input.tsx` 里（`InputGroup`
 *      + `InputGroupTextarea` + 两个 addon）；本件只递状态与两句话，自己不拼任何输入区结构。
 *      附件清单住框内的 `block-start`、发送键在框内的 `block-end`——两个键都在框里，
 *      「这一句话会以什么形式发出去」在一处看全。
 *   2. **输入区与页面同一密度**：字号与间距取 `[data-density]` 的 CSS 变量（命名类），
 *      不另包主题——作用域变量是唯一来源。
 *   3. **排队区在输入区上方**、默认收起（初值在调用方那次挂载里给），`gone` 不进队列
 *      （判定收在 `inject-vocab.ts` 一处）。
 *   4. **「删除」是双态动作**：还在排队的那条直接摘掉、已交给厂商的那条走撤回——成不成由
 *      这一家这一档的声明决定（按钮的可用性与 tooltip 全部来自 `inject-vocab.ts` 的派生）。
 *      撤回成功后**文本与附件一起回填**（只回文本会静默丢文件），交出去过的那条另给一句一次性提示。
 *
 * **不判厂商**：所有「哪家能做到哪一档」都从 `declaration` 读；`null` 读作「不知道」。
 *
 * 输入区那一行本身（连同一条草稿的状态机）住在共用的 `composer-input.tsx`：跑完之后那一支的
 * 「追问」输入区用的就是同一份，形态因此只有一处定义（两处各写一份的结果是同一种控件在两个入口
 * 长得不一样，而那种漂移没人会当场发现）。
 */
import { XIcon } from 'lucide-react';
import { useCallback, useState, type ReactNode } from 'react';
import type {
  InjectAttachment,
  InjectMessage,
  InjectionBoundary,
  TurnInjectionCapability,
} from '@aieval/contracts';
import { Alert, AlertAction, AlertDescription } from '../../components/ui/alert';
import { Button } from '../../components/ui/button';
import { attachmentListOf, CompactComposerArea, useComposerDraft } from './composer-input';
import { InjectQueuePanel } from './inject-queue-panel';
import {
  INJECT_QUEUE_HINT,
  deliveryAvailability,
  refillDraftAttachments,
  refillDraftText,
  refillNoticeOf,
} from './inject-vocab';

/** 一次发送的三格（`messageId` 由本件铸：它同时是服务端的幂等键与附件目录名） */
export interface InjectSendInput {
  messageId: string;
  text: string;
  attachments: InjectAttachment[];
  requires: InjectionBoundary;
}

/** 一次附件上传：文件与它归属的那条草稿的 id */
export interface InjectUploadInput {
  messageId: string;
  file: File;
}

export interface InjectComposerProps {
  /** 这一行的队列快照（**含终态**：`gone` 由本件跳过） */
  messages: readonly InjectMessage[];
  /** 这一行的家在这一面上的声明；`null` = 不知道（不编一份「都支持」） */
  declaration: TurnInjectionCapability | null;
  /** 有没有写动作在途（数据层给；在途时输入区与按钮都禁用） */
  busy?: boolean;
  /** 发一条（登记）；服务端按 `messageId` 幂等，重发不新增 */
  onSend(input: InjectSendInput): Promise<void>;
  /** 「立即发送」：把这一条的要求由「排队」改成「立即」 */
  onPromote(messageId: string): Promise<void>;
  /** 「删除」：服务端按这一条当前的状态分派（摘掉 / 撤回 / 明确拒绝） */
  onRetract(messageId: string): Promise<void>;
  /** 落一份附件（走本仓的 multipart 端点），拿回它的清单项 */
  onUploadAttachment(input: InjectUploadInput): Promise<InjectAttachment>;
  /** 失败原因交回调用方呈现（本件不弹全局提示：它不知道宿主用哪一种） */
  onError?(cause: unknown): void;
}

export function InjectComposer({
  messages,
  declaration,
  busy = false,
  onSend,
  onPromote,
  onRetract,
  onUploadAttachment,
  onError,
}: InjectComposerProps): ReactNode {
  /** 排队区默认收起（用户裁定；收起态的计数是那一行唯一的可见信号） */
  const [queueCollapsed, setQueueCollapsed] = useState(true);
  /** 撤回已交给厂商的那一条之后那句一次性提示 */
  const [notice, setNotice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // 一条草稿（正文 + 附件清单 + 上传）走共用件：追问那一边用的是同一份，形态因此必然一致
  const composer = useComposerDraft({ onUploadAttachment, onError });
  const { draft, setDraft, pending, ready, uploading, draftId, reset } = composer;

  const availability = deliveryAvailability(declaration, 'idle');
  const canSend = availability.available && !busy && !uploading && (draft.trim() !== '' || ready.length > 0);

  /** 发送：固定用「排队」那一档（要提前投递就在排队行上点「立即发送」） */
  const handleSend = useCallback(() => {
    if (!canSend || submitting) return;
    const messageId = draftId();
    setSubmitting(true);
    void onSend({
      messageId,
      text: draft,
      attachments: attachmentListOf(ready),
      requires: 'idle',
    })
      .then(() => {
        // 受理之后才清草稿（失败时框里的内容一个字都不动，用户不必重打）
        reset();
        setNotice(null);
      })
      .catch((cause: unknown) => onError?.(cause))
      .finally(() => setSubmitting(false));
  }, [canSend, submitting, draftId, onSend, draft, ready, reset, onError]);

  /**
   * 「删除」：撤回成功才回填（**文本与附件一起**），并在交出去过的那一条上给一句一次性提示；
   * 失败（409「已经交给模型了」/ 这一家撤不了）把原因交回调用方，队列以服务端快照为准。
   */
  const handleRetract = useCallback(
    (messageId: string) => {
      const message = messages.find((item) => item.messageId === messageId);
      if (message === undefined) return;
      void onRetract(messageId)
        .then(() => {
          setDraft((previous) => refillDraftText(previous, message.text));
          composer.setPending((previous) => refillDraftAttachments(previous, message));
          setNotice(refillNoticeOf(message));
        })
        .catch((cause: unknown) => onError?.(cause));
    },
    [messages, onRetract, onError, setDraft, composer],
  );

  const handlePromote = useCallback(
    (messageId: string) => {
      void onPromote(messageId).catch((cause: unknown) => onError?.(cause));
    },
    [onPromote, onError],
  );

  const hint =
    availability.available === false ? (
      // 不能投：把「为什么」如实写在输入框下面（那几句「不能」互不相同，判定在 `inject-vocab`）
      <p data-testid="inject-unavailable" className="text-xs text-muted-foreground">
        {availability.note}
      </p>
    ) : (
      // 能投：也要说清「发出去不等于立刻到」（取件在下一次通知边界、排队那一档要等本轮收完）
      <p data-testid="inject-queue-hint" className="text-xs text-muted-foreground">
        {INJECT_QUEUE_HINT}
      </p>
    );

  return (
    <div data-testid="inject-composer" className="flex flex-col">
      {/* 排队区不套紧凑密度（整支抽屉的字号不动）；它在输入区**上方** */}
      <InjectQueuePanel
        messages={messages}
        declaration={declaration}
        collapsed={queueCollapsed}
        onCollapsedChange={setQueueCollapsed}
        busy={busy}
        onPromote={handlePromote}
        onRetract={handleRetract}
      />
      {/* 输入区：间距与字号取密度作用域（不另包主题） */}
      <CompactComposerArea
        draft={draft}
        onDraftChange={setDraft}
        onSend={handleSend}
        placeholder={availability.available ? '给这一行的智能体补一句话（先排队，等它下一次可投递的时机）' : '这一档不能用（原因见下方）'}
        disabled={!availability.available || busy}
        pending={pending}
        onRemovePending={composer.onRemovePending}
        onPickFiles={composer.onPickFiles}
        canSend={canSend}
        attachmentsTestId="inject-attachments"
        hint={hint}
        notice={
          notice === null ? null : (
            <Alert data-testid="inject-refill-notice" className="mb-hair">
              <AlertDescription>{notice}</AlertDescription>
              <AlertAction>
                {/* 关闭面：一次性提示由用户自己收回（不给关闭面的提示会一直占着这一行） */}
                <Button variant="ghost" size="icon-xs" aria-label="关闭提示" onClick={() => setNotice(null)}>
                  <XIcon aria-hidden />
                </Button>
              </AlertAction>
            </Alert>
          )
        }
      />
    </div>
  );
}
