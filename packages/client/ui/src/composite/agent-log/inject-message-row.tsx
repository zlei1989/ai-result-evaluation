'use client';

/**
 * 排队区里的**一行**人工消息（L0 纯渲染件：受控、不持开合态、不取数）。
 *
 * 一行五格，各有各的用处，**一格都不能省**（收起态下这一行就是那条消息的全部可见信息）：
 *   · 状态标签——「排队中 / 已交给厂商 / 已被模型读到」三态各一句话（悬停给全）；
 *   · 正文摘要——单行省略 + 悬停看全（长句在窄抽屉里必然溢出，截断了就再也读不全）；
 *   · 投递档——「排队」/「立即发送」（同一条消息在盘上是什么要求，决定了它几时被投出去）；
 *   · 附件条数——正文与附件一起构成一条人工消息，只画正文会让人以为附件没带上；
 *   · 登记时刻——`createdAt`，服务端写入时刻的 ISO 8601 串，走与别处同一档 `formatDateTime`。
 *
 * 两颗操作按钮的**可用性与 tooltip 全部由声明推出**（`deleteActionOf` / `promoteActionOf`），
 * 本件一处都不判厂商：同一个「删除」在「还在我们表里」与「已交给厂商」上是两个动作，
 * 而后者成不成看这一家这一档。
 */
import { Trash2Icon, ZapIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import type { InjectMessage, TurnInjectionCapability } from '@aieval/contracts';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { EllipsisText } from '../../base/ellipsis-text';
import { Hint } from '../../base/hint';
import { formatDateTime } from '../../base/format';
import {
  INJECTION_BOUNDARY_LABELS,
  INJECT_STATE_PRESENTATION,
  deleteActionOf,
  promoteActionOf,
} from './inject-vocab';

export interface InjectMessageRowProps {
  message: InjectMessage;
  /** 这一行的家在这一面上的声明；`null` = 不知道（不编一份「都支持」） */
  declaration: TurnInjectionCapability | null;
  /** 这一条上有写动作在途：两颗按钮都禁用（同一个动作连点两次没有意义，而多发一条是有害的） */
  busy?: boolean;
  onPromote(messageId: string): void;
  onRetract(messageId: string): void;
}

export function InjectMessageRow({ message, declaration, busy = false, onPromote, onRetract }: InjectMessageRowProps): ReactNode {
  const presentation = INJECT_STATE_PRESENTATION[message.state];
  const remove = deleteActionOf(message, declaration);
  const promote = promoteActionOf(message, declaration);
  const attachmentCount = message.attachments.length;

  return (
    <div className="flex items-center gap-tight" data-testid={`inject-message-${message.messageId}`}>
      {/* 状态：文案与那句人话在 `INJECT_STATE_PRESENTATION` 里（`gone` 不该走到这里，调用方先跳过） */}
      <Hint label={presentation.note}>
        <Badge variant="outline" data-tone={presentation.color}>
          {presentation.label}
        </Badge>
      </Hint>

      {/* 正文摘要：占满剩余宽度（`minWidth: 0` 让它在 flex 里真的能收缩，否则省略号轮不到它） */}
      <div className="min-w-0 flex-1">
        <EllipsisText text={message.text} tooltip={message.text} />
      </div>

      {/* 投递档：与正文分开显示——「排队」那一条要等本轮收场，用户据此判断还要等多久 */}
      <span className="text-muted-foreground">{INJECTION_BOUNDARY_LABELS[message.requires]}</span>
      {attachmentCount > 0 && <span className="text-muted-foreground">{`附件 ${String(attachmentCount)} 个`}</span>}
      <span className="text-muted-foreground">{formatDateTime(message.createdAt)}</span>

      <div className="flex items-center gap-hair">
        {/*
          ⚠️ 提示挂在**外面这层 span** 上，不挂在按钮上：**禁用态的按钮不派发鼠标事件**
          （浏览器里 `pointer-events: none`）⇒ 挂在按钮上时浮层永不出现，而禁用态恰恰是最需要
          那句话的地方（「为什么不能点」）。外面这层不是禁用元素，事件照常冒泡上来。
        */}
        <Hint label={promote.tooltip}>
          <span className="inline-flex" data-testid={`inject-promote-${message.messageId}`}>
            {/* `aria-label` 与 tooltip 同名：图标按钮没有可访问名时，读屏器只会念「按钮」 */}
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="立即发送"
              disabled={busy || !promote.enabled}
              onClick={() => onPromote(message.messageId)}
            >
              <ZapIcon aria-hidden />
            </Button>
          </span>
        </Hint>
        <Hint label={remove.tooltip}>
          <span className="inline-flex" data-testid={`inject-retract-${message.messageId}`}>
            <Button
              size="icon-xs"
              variant="ghost"
              className="text-destructive hover:bg-destructive/10"
              aria-label="删除"
              disabled={busy || !remove.enabled}
              onClick={() => onRetract(message.messageId)}
            >
              <Trash2Icon aria-hidden />
            </Button>
          </span>
        </Hint>
      </div>
    </div>
  );
}
