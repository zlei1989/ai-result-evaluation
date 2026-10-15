'use client';

/**
 * 人工消息的**输入区与排队区**（L2）：抽屉底部那一段固定区（`AgentLogLayout` 的 `footer` 槽）。
 *
 * 形态按 spec §4.4 的定稿，四处都是刻意的：
 *
 *   1. **输入区就是一行**：`Sender` 的 `prefix` 里放 `Attachments` 包一颗回形针按钮
 *      （`Attachments` 在它外面套拖拽区与隐藏的 file input ⇒ 那颗按钮同时是「点选」与
 *      「拖拽落点」，拖到抽屉里任何地方都算数）；发送键用 X 自带的圆形上箭头（`components.SendButton`，
 *      **不另画一颗**，只把「能不能点」显式交给调用方，理由见下面 `suffix` 那一处注释）；
 *      `beforeUpload: () => false` 是硬要求——文件**不往任何地方传**，走本仓的 multipart 端点
 *      （让 antd 自传会变成两份真相）。**附件清单住框上方一行 chips**（`scrollX`，只占一行高），
 *      **不进 `prefix`**：`Attachments` 把清单渲在自己内部，塞进 `prefix` 会被挤进输入框那一行。
 *   2. **紧凑密度只套输入区**（`ConfigProvider` + `compactTheme`）：X 的 `Sender` / `Attachments`
 *      没有 `size` 能力，不套就是「页面 12px、输入框 14px」；而整支抽屉的字号不动是用户口径。
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
import { Alert, Flex, Typography, theme } from 'antd';
import { useCallback, useState, type ReactNode } from 'react';
import type {
  InjectAttachment,
  InjectMessage,
  InjectionBoundary,
  TurnInjectionCapability,
} from '@aieval/contracts';
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
  const { token } = theme.useToken();

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
      <Typography.Text type="secondary" data-testid="inject-unavailable">
        {availability.note}
      </Typography.Text>
    ) : (
      // 能投：也要说清「发出去不等于立刻到」（取件在下一次通知边界、排队那一档要等本轮收完）
      <Typography.Text type="secondary" data-testid="inject-queue-hint">
        {INJECT_QUEUE_HINT}
      </Typography.Text>
    );

  return (
    <Flex vertical data-testid="inject-composer">
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
      {/* 紧凑密度只套输入区这一块（`CompactComposerArea` 内部那一层 `ConfigProvider`） */}
      <CompactComposerArea
        draft={draft}
        onDraftChange={setDraft}
        onSend={handleSend}
        placeholder={availability.available ? '给这一轮的智能体补一句话（先排队，等它下一次可投递的时机）' : '这一档不能用（原因见下方）'}
        disabled={!availability.available || busy}
        pending={pending}
        onPendingItemsChange={composer.onPendingItemsChange}
        onPickFiles={composer.onPickFiles}
        canSend={canSend}
        attachmentsTestId="inject-attachments"
        hint={hint}
        notice={
          notice === null ? null : (
            <Alert
              type="warning"
              showIcon
              // antd 6 把 Alert 的关闭面收进 `closable`：`closable` 与 `onClose` 旧名都会被废弃。
              // 传对象即「可关闭」（antd 内部的判据是 `isPlainObject(closable) ⇒ isClosable`），
              // 故不再另给 `closable` 布尔值
              closable={{ onClose: () => setNotice(null) }}
              title={notice}
              data-testid="inject-refill-notice"
              style={{ marginBottom: token.marginXXS }}
            />
          )
        }
      />
    </Flex>
  );
}
