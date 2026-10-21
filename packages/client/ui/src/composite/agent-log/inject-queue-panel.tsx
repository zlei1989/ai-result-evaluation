'use client';

/**
 * 排队区（L1 受控组合件）：把这个候选的若干条人工消息画成「单行直出 / 多行折叠」两种形态。
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
 * 标题传 `SHRINKABLE_TITLE_STYLE`：antd 的 `.ant-collapse-title` 是 `min-width: auto` 的 flex 项，
 * 标题里一旦出现 `nowrap` 的长内容就会把整行顶宽、外层冒出横向滚动条。今天这行只有一句固定的
 * 短文案 + 计数，短标题传了没有副作用；留着是为了「以后往标题里放摘要」不必再想起这一格。
 */
import { Collapse, Flex, theme } from 'antd';
import type { ReactNode } from 'react';
import type { InjectMessage, TurnInjectionCapability } from '@aieval/contracts';
import { InjectMessageItem } from './inject-message-item';
import { visibleInjectMessages } from './inject-vocab';
import { SHRINKABLE_TITLE_STYLE } from '../../base/shrinkable-collapse-title';

/** 折叠面板的键（只有一格） */
const QUEUE_PANEL_KEY = 'inject-queue';

export interface InjectQueuePanelProps {
  /** 这个候选的队列快照（含终态：`gone` 由本件跳过） */
  messages: readonly InjectMessage[];
  /** 这个候选的家在这一面上的声明；`null` = 不知道 */
  declaration: TurnInjectionCapability | null;
  /** 折叠态（受控）；默认收起由调用方给初值 */
  collapsed: boolean;
  onCollapsedChange(collapsed: boolean): void;
  /** 有没有写动作在途（在途时每个候选的两颗按钮都禁用） */
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
  const { token } = theme.useToken();
  const visible = visibleInjectMessages(messages);
  // 一条都没有 ⇒ 一个节点都不渲染（不占高度：输入区上面不留一段空白）
  if (visible.length === 0) return null;

  const rows = visible.map((message) => (
    <InjectMessageItem
      key={message.messageId}
      message={message}
      declaration={declaration}
      busy={busy}
      onPromote={onPromote}
      onRetract={onRetract}
    />
  ));

  return (
    <Flex vertical data-testid="inject-queue" style={{ paddingInline: token.paddingMD }}>
      {visible.length === 1 ? (
        // 一条时不套壳：标题（「1 条排队消息」）比内容还长，折起来只会多一次点击
        <Flex vertical>{rows}</Flex>
      ) : (
        <Collapse
          size="small"
          activeKey={collapsed ? [] : [QUEUE_PANEL_KEY]}
          onChange={(keys) => onCollapsedChange(keys.length === 0)}
          expandIconPlacement="end"
          styles={SHRINKABLE_TITLE_STYLE}
          items={[
            {
              key: QUEUE_PANEL_KEY,
              label: `${String(visible.length)} 条排队消息`,
              children: <Flex vertical>{rows}</Flex>,
            },
          ]}
        />
      )}
    </Flex>
  );
}
