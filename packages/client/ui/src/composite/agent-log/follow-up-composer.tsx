'use client';

/**
 * 追问的**输入区**（L2）：跑完的那一行底下那一行输入框——人补一句话，让它接着同一段会话
 * 再跑一段（不重建工作区、不重置计量，跑完自动重评）。
 *
 * 形态**与运行中那条输入区逐像素相同**（共用 `composer-input.tsx`）：附件 chips 住框上方一行、
 * 发送键是 X 自带的圆形上箭头、紧凑密度只套这一块。差别只有两处，都在**语义**上：
 *   · **没有排队区**：追问不是「排队等取件」，它当场起一段（续接之后的追问天然落在排队那一档，
 *     而那一档的含义已经由 `follow-upRow` 在服务端落实）；
 *   · **一句话 + 附件清单直接发出去**，没有 `requires`（档位是排队那一档，不由界面选）。
 *
 * 三条口径：
 *   · **不判可用性**：这一块只在「这一行此刻能追问」时被渲染出来（入口按钮的判据来自服务端的
 *     可用性读侧），故它不自己复算一遍——两处各判一次必然漂移；
 *   · **空输入不许发**：一句话都没有、附件也没有的追问交给模型只会得到一句「你发了什么」
 *     （服务端也拦，这里先拦只为不让用户白等一次往返）；
 *   · **附件先落盘、再允许发送**：登记那一刻正文与附件清单就是完整事实（与人工消息同一条时序）。
 */
import { Flex, Typography } from 'antd';
import { useCallback, useState, type ReactNode } from 'react';
import type { InjectAttachment } from '@aieval/contracts';
import { attachmentListOf, CompactComposerArea, useComposerDraft } from './composer-input';

/** 一次追问要交出去的三格（`messageId` 由本件铸：它同时是附件目录名与账本钥匙） */
export interface FollowUpSendInput {
  messageId: string;
  text: string;
  attachments: InjectAttachment[];
}

/** 一次附件上传：文件与它归属的那条草稿的 id */
export interface FollowUpUploadInput {
  messageId: string;
  file: File;
}

export interface FollowUpComposerProps {
  /** 有没有写动作在途（数据层给；在途时输入区禁用、发送键灰掉） */
  busy?: boolean;
  /** 发一条追问；服务端接受之后这一行会翻成「准备中」，进度由轮级信号与行级流驱动 */
  onSend(input: FollowUpSendInput): Promise<void>;
  /** 落一份附件（走本仓的 multipart 端点），拿回它的清单项 */
  onUploadAttachment(input: FollowUpUploadInput): Promise<InjectAttachment>;
  /** 失败原因交回调用方呈现（本件不弹全局提示：它不知道宿主用哪一种） */
  onError?(cause: unknown): void;
}

/** 输入框下面那行常驻提示：说清这一句话发出去之后会发生什么（而不是只说「能发」） */
export const FOLLOW_UP_HINT = '追问会接着这一行原来那段会话再跑一段：工作区不重建、计量照旧累加，收尾后自动重新评分。';

export function FollowUpComposer({ busy = false, onSend, onUploadAttachment, onError }: FollowUpComposerProps): ReactNode {
  const composer = useComposerDraft({ onUploadAttachment, onError });
  const { draft, ready, uploading, draftId, reset } = composer;
  const [submitting, setSubmitting] = useState(false);

  const canSend = !busy && !uploading && (draft.trim() !== '' || ready.length > 0);

  /**
   * 发送。**受理之后才清草稿**（失败时框里的内容一个字都不动，用户不必重打）——
   * 与人工消息那一侧同一条：追问失败的原因（接不上会话 / 附件没了 / 这一家不支持续接）
   * 由调用方直接展示，而那句话多半要改一改再发。
   */
  const handleSend = useCallback(() => {
    if (!canSend || submitting) return;
    const messageId = draftId();
    setSubmitting(true);
    void onSend({ messageId, text: draft, attachments: attachmentListOf(ready) })
      .then(() => {
        reset();
      })
      .catch((cause: unknown) => onError?.(cause))
      .finally(() => setSubmitting(false));
  }, [canSend, submitting, draftId, onSend, draft, ready, reset, onError]);

  return (
    <Flex vertical data-testid="follow-up-composer">
      <CompactComposerArea
        draft={draft}
        onDraftChange={composer.setDraft}
        onSend={handleSend}
        placeholder="接着这一行再补一句话（它会带着原来那段上下文继续跑）"
        disabled={busy}
        pending={composer.pending}
        onPendingItemsChange={composer.onPendingItemsChange}
        onPickFiles={composer.onPickFiles}
        canSend={canSend}
        attachmentsTestId="follow-up-attachments"
        hint={
          <Typography.Text type="secondary" data-testid="follow-up-hint">
            {FOLLOW_UP_HINT}
          </Typography.Text>
        }
      />
    </Flex>
  );
}
