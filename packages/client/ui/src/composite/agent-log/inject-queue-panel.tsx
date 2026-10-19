'use client';

/**
 * 排队区（L1 受控组合件）：把这一行的若干条人工消息画成「单行直出 / 多行折叠」两种形态。
 *
 * 四条口径：
 *   · **一条时不套壳**（标题比内容还长），两条起才收进折叠面板；
 *   · **默认收起**是调用方的初始值（本件受控：`collapsed` + `onCollapsedChange`），
 *     本件不持开合态（分层纪律：L0/L1 一律受控）；
 *   · **收起态必须露出计数**：「N 条排队消息」是那两颗操作按钮被藏起来之后用户唯一的可见信号
 *     （用户明确接受了「收起时看不见按钮」这个代价，故这里不设旁路入口）；
 *   · **`gone` 不进这一层**：跳过由 `visibleInjectMessages` 一处判定（它留在表里只为幂等，
 *     画出来就是把一条已经消失的消息说成还在等）。
 *
 * 开合由 Base UI 的 `Collapsible` 管：收起时面板**卸载**（不是被 CSS 藏住），
 * 再展开拿到的是新挂载的一份——与「它此刻还在队列里」这件事一致。
 */
import { ChevronDownIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import type { InjectMessage, TurnInjectionCapability } from '@aieval/contracts';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../../components/ui/collapsible';
import { InjectMessageRow } from './inject-message-row';
import { visibleInjectMessages } from './inject-vocab';

export interface InjectQueuePanelProps {
  /** 这一行的队列快照（含终态：`gone` 由本件跳过） */
  messages: readonly InjectMessage[];
  /** 这一行的家在这一面上的声明；`null` = 不知道 */
  declaration: TurnInjectionCapability | null;
  /** 折叠态（受控）；默认收起由调用方给初值 */
  collapsed: boolean;
  onCollapsedChange(collapsed: boolean): void;
  /** 有没有写动作在途（在途时每一行的两颗按钮都禁用） */
  busy?: boolean;
  onPromote(messageId: string): void;
  onRetract(messageId: string): void;
}

export function InjectQueuePanel({
  messages,
  declaration,
  collapsed,
  onCollapsedChange,
  busy = false,
  onPromote,
  onRetract,
}: InjectQueuePanelProps): ReactNode {
  const visible = visibleInjectMessages(messages);
  // 一条都没有 ⇒ 一个节点都不渲染（不占高度：输入区上面不留一段空白）
  if (visible.length === 0) return null;

  const rows = visible.map((message) => (
    <InjectMessageRow
      key={message.messageId}
      message={message}
      declaration={declaration}
      busy={busy}
      onPromote={onPromote}
      onRetract={onRetract}
    />
  ));

  return (
    <div data-testid="inject-queue" className="px-roomy">
      {visible.length === 1 ? (
        // 一条时不套壳：标题（「1 条排队消息」）比内容还长，折起来只会多一次点击
        <div className="flex flex-col">{rows}</div>
      ) : (
        <Collapsible open={!collapsed} onOpenChange={(open) => onCollapsedChange(!open)}>
          {/* `group` + `data-panel-open`（落在 trigger 自己身上）驱动箭头翻转 */}
          <CollapsibleTrigger className="group flex w-full items-center justify-between gap-2 py-hair text-xs text-muted-foreground hover:text-foreground">
            <span>{`${String(visible.length)} 条排队消息`}</span>
            <ChevronDownIcon aria-hidden className="size-3.5 transition-transform group-data-panel-open:rotate-180" />
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="flex flex-col">{rows}</div>
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  );
}
