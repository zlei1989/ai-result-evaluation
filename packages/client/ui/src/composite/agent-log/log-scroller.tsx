'use client';

/**
 * 日志滚动区（L2）：把 `Message Scroller` 的跟随语义接到本仓的滚动区上。
 *
 * 它只做三件事：
 *   1. **组合**上游的固定层级（Provider → Root → Viewport → 内容）；内容区由调用方给
 *      （时间轴是 `VirtualTurnList` 的 `MessageScrollerContent`），浮出按钮住在 Root 里、Viewport 之后；
 *   2. **把命令式滚动交出去**：`scrollToEnd` / `scrollToMessage` 直接来自 `useMessageScroller`；
 *   3. **把「读者离开活边」这一件事翻译成本仓的 `follow: boolean`**：库用 `end`（下方还有内容）
 *      表达它，且**跟随期间恒为 `false`**（跟随输出时它把 `end` 压住）。于是「`end` 变真 ⇒ 释放跟随」
 *      与「显式恢复 ⇒ 重新打开跟随并在 Provider 拿到新值之后滚到底」各一条，方向单一、不会互相打架。
 *
 * 两个已知边界（都与库的 DOM 观测方式有关）：
 *   · `preserveScrollOnPrepend` 关掉：本仓的时间轴只追加、不前置历史；开着它时虚拟化窗口的
 *     增删会被当成「前置了历史」，库会补偿 `scrollTop`，表现是上翻被抵消；
 *   · 跟随的恢复只由显式动作触发（工具条开关 / 浮出按钮）。库在用户上翻后自己不会再打开跟随。
 */
import { useEffect, useImperativeHandle, useRef, type ReactNode, type Ref, type RefObject } from 'react';
import type { MessageScrollerScrollOptions } from '@shadcn/react/message-scroller';

import {
  MessageScroller,
  MessageScrollerProvider,
  MessageScrollerViewport,
  useMessageScroller,
  useMessageScrollerScrollable,
} from '../../components/ui/message-scroller';

/** 日志滚动区的命令：回到最新 / 滚到某一条消息（Message Scroller 的两个命令） */
export interface LogScrollerCommands {
  scrollToEnd(options?: MessageScrollerScrollOptions): void;
  scrollToMessage(messageId: string, options?: MessageScrollerScrollOptions): void;
}

export interface LogScrollerProps {
  /** 读者在活边才跟随（库的 `autoScroll`）：关掉它，新内容不抢视口 */
  autoScroll: boolean;
  /** 库判「下方还有内容」时通知一次：读者已经离开活边，释放跟随（只往释放方向通知） */
  onReleaseFollow(): void;
  /** 滚动视口：虚拟列表要拿它当滚动元素（react-virtual 的 `getScrollElement`） */
  viewportRef: RefObject<HTMLDivElement | null>;
  controllerRef?: Ref<LogScrollerCommands>;
  /** 滚动内容：时间轴，或节点四态里的空态 / 错误态 */
  children: ReactNode;
  /** 浮出按钮（回到最新）：住在 Root 里、Viewport 之后（库的固定层级） */
  backToLatest?: ReactNode;
}

export function LogScroller({
  autoScroll,
  onReleaseFollow,
  viewportRef,
  controllerRef,
  children,
  backToLatest,
}: LogScrollerProps): ReactNode {
  return (
    <MessageScrollerProvider autoScroll={autoScroll}>
      <MessageScroller className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
        <MessageScrollerViewport
          ref={viewportRef}
          data-testid="agent-log-scroll-viewport"
          aria-label="日志"
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain contain-content"
          // 见文件头「已知边界」：只追加的时间轴不能被库当成前置历史去补偿滚动位置
          preserveScrollOnPrepend={false}
        >
          {children}
        </MessageScrollerViewport>
        {backToLatest}
        <ScrollerBinding autoScroll={autoScroll} onReleaseFollow={onReleaseFollow} controllerRef={controllerRef} />
      </MessageScroller>
    </MessageScrollerProvider>
  );
}

/**
 * 把库的命令与状态接到 React 的 ref / 回调上。
 *
 * 为什么单拆一层：`useMessageScroller` 只能读 Provider 的 context，而本件自己就是 Provider 的
 * 持有者 ⇒ 命令必须在 Provider **内部**的子节点里取。它不渲染任何可见节点。
 */
function ScrollerBinding({
  autoScroll,
  onReleaseFollow,
  controllerRef,
}: Pick<LogScrollerProps, 'autoScroll' | 'onReleaseFollow' | 'controllerRef'>): null {
  const { scrollToEnd, scrollToMessage } = useMessageScroller();
  const { end } = useMessageScrollerScrollable();

  useImperativeHandle(
    controllerRef,
    () => ({
      scrollToEnd: (options?: MessageScrollerScrollOptions): void => {
        scrollToEnd(options);
      },
      scrollToMessage: (messageId: string, options?: MessageScrollerScrollOptions): void => {
        scrollToMessage(messageId, options);
      },
    }),
    [scrollToEnd, scrollToMessage],
  );

  /** 释放回调放进 ref：调用方每次渲染新建箭头函数，直接进依赖会让通知跟着每帧重跑 */
  const onReleaseRef = useRef(onReleaseFollow);
  useEffect(() => {
    onReleaseRef.current = onReleaseFollow;
  }, [onReleaseFollow]);

  useEffect(() => {
    // 只往「释放」方向通知：`end` 为真 = 下方还有内容 = 读者不在活边。
    // 库在跟随期间会把 `end` 压成 false（「跟随时 end 恒假」），所以这里不会误伤跟随
    if (end) onReleaseRef.current();
  }, [end]);

  /** 上一帧的 autoScroll：只在「变真」的那一刻滚一次，不是每次渲染都滚 */
  const previousAutoScrollRef = useRef(autoScroll);
  useEffect(() => {
    const turnedOn = autoScroll && !previousAutoScrollRef.current;
    previousAutoScrollRef.current = autoScroll;
    if (!turnedOn) return;
    // **必须等到 Provider 拿到新的 autoScroll 之后**再滚：库用 autoScroll 决定滚完进哪种模式，
    // 在同一个事件里先 setFollow 再调，库读到的还是旧值，模式会停在 free-scrolling（新内容不再跟随）
    scrollToEnd();
  }, [autoScroll, scrollToEnd]);

  return null;
}
