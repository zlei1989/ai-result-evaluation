'use client';

/**
 * 追问的**输入区**（L2）：跑完的那一行底下那一行输入框——人补一句话，让它接着同一段会话
 * 再跑一段（不重建工作区、不重置计量，跑完自动重评）。
 *
 * 形态**与运行中那条输入区逐像素相同**（共用 `composer-input.tsx`）：`Prompt Input` 的骨架
 * 一处都不在这里重复拼。差别只有两处，都在**语义**上：
 *   · **没有排队区**：追问不是「排队等取件」，它当场起一段（续接之后的追问天然落在排队那一档，
 *     而那一档的含义已经由 `followUpRow` 在服务端落实）；
 *   · **一句话 + 附件清单直接发出去**，没有 `requires`（档位是排队那一档，不由界面选）。
 *
 * 输入区上方还有一排**建议 chips**（`Suggestion`）：点一下就把那句话当作追问发出去。
 * 建议由这一行的**结局**派生（见 `followUpSuggestionsOf`），不是一排固定文案——
 * 固定文案在失败行与成功行说同一句话，只能算装饰。
 *
 * 四条口径：
 *   · **不判可用性**：这一块只在「这一行此刻能追问」时被渲染出来（入口按钮的判据来自服务端的
 *     `followUpAvailability` 读侧，拒绝原因就是那颗按钮的浮层）。chips 的禁用与那句原因都只读
 *     调用方递进来的**同一份判据**（`followUpVerdict`）——这里不自己复算一遍，两处各判一次必然漂移；
 *   · **空输入不许发**：一句话都没有、附件也没有的追问交给模型只会得到一句「你发了什么」
 *     （服务端也拦，这里先拦只为不让用户白等一次往返）；
 *   · **附件先落盘、再允许发送**：登记那一刻正文与附件清单就是完整事实（与人工消息同一条时序）；
 *   · **chip 发送不动草稿**：它发的是那一条建议本身，框里已经打了一半的话与附件清单原样留着
 *     （被 chip 顺手清掉就等于把用户写的东西丢了）。
 */
import { useCallback, useState, type ReactNode } from 'react';
import type { FollowUpVerdict, InjectAttachment } from '@aieval/contracts';
import { Button } from '../../components/ui/button';
import type { AgentLogFacts } from './types';
import { newInjectMessageId } from './inject-vocab';
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
  /** 这一行的**行级事实**：建议 chips 的唯一依据（结局 + 有没有改动，都是真实读数） */
  facts: AgentLogFacts;
  /**
   * 追问判据（服务端 `followUpAvailability` 读侧，按行取）。
   * `undefined` = 还没读到：chips 一样禁用，原因如实说「还没读到」——禁用而不解释等于一个坏掉的按钮。
   */
  followUpVerdict?: FollowUpVerdict;
  /** 发一条追问；服务端接受之后这一行会翻成「准备中」，进度由轮级信号与行级流驱动 */
  onSend(input: FollowUpSendInput): Promise<void>;
  /** 落一份附件（走本仓的 multipart 端点），拿回它的清单项 */
  onUploadAttachment(input: FollowUpUploadInput): Promise<InjectAttachment>;
  /** 失败原因交回调用方呈现（本件不弹全局提示：它不知道宿主用哪一种） */
  onError?(cause: unknown): void;
}

/** 输入框下面那行常驻提示：说清这一句话发出去之后会发生什么（而不是只说「能发」） */
export const FOLLOW_UP_HINT = '追问会接着这一行原来那段会话再跑一段：工作区不重建、计量照旧累加，收尾后自动重新评分。';

/**
 * 建议 chips 的**文案来源**：这一行的结局。
 *
 * 为什么是规则而不是模型生成：这一句话发出去是**真的要跑一段**（分钟级、耗计量），
 * 所以它必须贴着这一行此刻的处境；而「结局 + 有没有改动」两格就是数据层已经采到的读数
 * （`facts.status.tone` / `facts.error` / `facts.domain` 的 `diff` 格）。规则还带来两个好处：
 * 同一行每次看到的建议一致（不闪），且**没有新增依赖、没有额外往返**。
 *
 * 三档各有各的下一步、不可互借：
 *   · 失败 / 有错误 —— 先问「为什么」，或把最后那段日志摘出来（这两种答案都在原始输出里）；
 *   · 随轮次中断 —— 问「做到哪一步」，再从停下的地方接（工作区还在，重跑整行是浪费）；
 *   · 跑成功 —— 有改动就总结改动，没改动就总结结论。
 * 还没跑完（`pending` / `running`）**一条都不给**：没有结局可依据，给什么都是猜。
 */
export function followUpSuggestionsOf(
  facts: Pick<AgentLogFacts, 'status' | 'error' | 'domain'>,
): readonly string[] {
  if (facts.status.tone === 'failed' || facts.error !== null) {
    return ['解释这次失败的原因', '把最后 20 行日志里的关键报错摘出来'];
  }
  if (facts.status.tone === 'canceled') {
    return ['中断前做到了哪一步', '从停下的地方把剩下的做完'];
  }
  if (facts.status.tone === 'ok') {
    return facts.domain.some((fact) => fact.id === 'diff')
      ? ['把这次改动总结成三条', '这次改动里哪一处风险最高']
      : ['总结这次回答的要点', '这份结果里还有哪些没覆盖'];
  }
  return [];
}

export function FollowUpComposer({
  busy = false,
  facts,
  followUpVerdict,
  onSend,
  onUploadAttachment,
  onError,
}: FollowUpComposerProps): ReactNode {
  const composer = useComposerDraft({ onUploadAttachment, onError });
  const { draft, ready, uploading, draftId, reset } = composer;
  const [submitting, setSubmitting] = useState(false);

  const canSend = !busy && !uploading && (draft.trim() !== '' || ready.length > 0);

  /**
   * 建议那一排的禁用原因。三档与行卡片上那颗「追问」按钮**同一份判据**：
   * 能问 ⇒ `null`；服务端拒绝 ⇒ 逐字用它的中文原因；还没读到 ⇒ 如实说还没读到。
   */
  const chipsBlockedReason = followUpVerdict === undefined
    ? '还没读到这一行的追问判据（服务端没给出）：建议暂不可用'
    : followUpVerdict.ok
      ? null
      : followUpVerdict.reason;

  const suggestions = followUpSuggestionsOf(facts);

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

  /**
   * 点一枚 chip：**直接把这句话发出去**（不是先填进输入框——那样还得再按一次发送）。
   *
   * 两个要点：
   *   · `messageId` **另铸一个**，不复用 `draftId()`：那条草稿的 id 是它附件目录的名字，
   *     复用会让两条消息共用同一把账本钥匙；
   *   · **不动草稿**：草稿与它的附件清单还在框里，用户接下来照常可以发那一条。
   */
  const sendSuggestion = useCallback(
    (text: string) => {
      if (busy || submitting || chipsBlockedReason !== null) return;
      const messageId = newInjectMessageId();
      setSubmitting(true);
      void onSend({ messageId, text, attachments: [] })
        .catch((cause: unknown) => onError?.(cause))
        .finally(() => setSubmitting(false));
    },
    [busy, submitting, chipsBlockedReason, onSend, onError],
  );

  const chipsDisabled = busy || submitting || chipsBlockedReason !== null;

  return (
    <div data-testid="follow-up-composer" className="flex flex-col">
      {suggestions.length > 0 && (
        <div className="flex flex-col gap-hair px-roomy pt-tight" data-testid="follow-up-suggestions">
          {/* 禁用必须解释：原因逐字来自那份判据，不在这里另写一句 */}
          {chipsBlockedReason !== null && (
            <p className="text-xs text-muted-foreground" data-testid="follow-up-suggestions-blocked">
              {chipsBlockedReason}
            </p>
          )}
          <div className="flex gap-hair overflow-x-auto">
            {suggestions.map((suggestion) => (
              <Button
                key={suggestion}
                type="button"
                variant="outline"
                size="sm"
                className="shrink-0"
                disabled={chipsDisabled}
                onClick={() => sendSuggestion(suggestion)}
              >
                {suggestion}
              </Button>
            ))}
          </div>
        </div>
      )}
      <CompactComposerArea
        draft={draft}
        onDraftChange={composer.setDraft}
        onSend={handleSend}
        placeholder="接着这一行再补一句话（它会带着原来那段上下文继续跑）"
        disabled={busy}
        pending={composer.pending}
        onRemovePending={composer.onRemovePending}
        onPickFiles={composer.onPickFiles}
        canSend={canSend}
        attachmentsTestId="follow-up-attachments"
        hint={
          <p data-testid="follow-up-hint" className="text-xs text-muted-foreground">
            {FOLLOW_UP_HINT}
          </p>
        }
      />
    </div>
  );
}
