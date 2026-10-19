'use client';

/**
 * 虚拟滚动列表：**虚拟化的唯一持有者**——全仓 `useVirtualizer` 只出现在这里
 * （机器判据在 `agent-log/agent-log-layering.test.ts` (c)）。
 *
 * 为什么抽成原语：`agent-log` 有两处内容都可能长到上千行（轮次时间轴、原文行的逐行台账），
 * 两处各接一遍虚拟化就是两份高度测量、两份退化兜底、两份「量不到就不虚拟化」。
 *
 * 四条口径（照做，别照抄设计文档）：
 *   1. **量不到就不虚拟化**：jsdom 里 `clientHeight === 0`，此时**不给**虚拟化 ⇒ 全量渲染，
 *      这正是单测能数到全部内容的原因；环境里没有 `ResizeObserver`（老浏览器）时同样退化为全量渲染，**不抛**；
 *   2. **宿主必须是有确定高度的 Flex 子项**：自建宿主时本件的根是 `flex: 1` + `minHeight: 0`，
 *      调用方要把它放进「像抽屉正文那样高度有界」的容器；外部宿主（`scrollElementRef`）由调用方
 *      负责有界高度。否则 `clientHeight` 量出来是 0 ⇒ **静默地不虚拟化**（不报错、只是又变慢）；
 *   3. **「已渲染 N」由调用方数自己标的锚点属性**（`onMeasured` 交回宿主元素）：数框架内部类名
 *      会把嵌套列表的项一起算进来；
 *   4. **两套宿主**：不传 `scrollElementRef` 时本件自建滚动容器（原文行）；传了就把行交给外部容器
 *      （`container`）与外部滚动元素（Message Scroller 的 Viewport）。外部模式下行必须是
 *      **外部容器的直接子节点**（Message Scroller 要靠子节点测量与锚定），故 `row` 的 `style`
 *      与 `measureRef` 要落到行根上，中间不能再包一层定位 div。
 */
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type Ref,
  type RefObject,
} from 'react';

/** 命令式句柄：跳转用（「跳到轮次」「回到最新」都走它） */
export interface VirtualListHandle {
  /** 滚到 `rowKey` 等于 `key` 的那一项；越界（列表里还没有那一项）时什么都不做 */
  scrollToKey(key: string, align?: 'top' | 'bottom'): void;
}

/** 单行的外层参数：`style` 与 `measureRef` **必须**落到行根节点上（外部容器靠它测量与定位） */
export interface VirtualRowArgs {
  key: string;
  index: number;
  /** 虚拟化时是绝对定位样式；退化渲染时是空对象（行按内容流排布） */
  style: CSSProperties;
  /** 逐项测量回调（react-virtual 的 `measureElement`）；退化渲染时为 `undefined` */
  measureRef: ((node: HTMLElement | null) => void) | undefined;
  children: ReactNode;
}

/** 外部容器参数：总高度只在虚拟化时给数字，退化渲染时给 `null`（容器按内容高度） */
export interface VirtualContainerArgs {
  totalSize: number | null;
  children: ReactNode;
}

export interface VirtualListProps<T> {
  /** 只读数组（契约里的数据是 `readonly …[]`） */
  items: readonly T[];
  /** 行的稳定键；`rowKey` 要能跨追加保持不变（虚拟化与锚点都按它认同一行） */
  rowKey(item: T, index: number): string;
  itemRender(item: T, index: number): ReactNode;
  /** 每次测量（挂载 / 尺寸变化 / 可见范围变化）时回调：调用方在这一刻数「已渲染 N」 */
  onMeasured?(host: HTMLElement): void;
  controllerRef?: Ref<VirtualListHandle>;
  /** 本件自建宿主时的 `data-testid`（外部宿主由调用方自己标） */
  testId?: string;
  /** 外部滚动容器（Message Scroller 的 Viewport）：给了就不自建滚动宿主 */
  scrollElementRef?: RefObject<HTMLElement | null>;
  /** 外部容器（Message Scroller 的 Content）：拿总高度与已定位的行 */
  container?(args: VirtualContainerArgs): ReactNode;
  /** 单行的外层（Message Scroller 的 Item） */
  row?(args: VirtualRowArgs): ReactNode;
  /** react-virtual 的首帧估值（挂载后逐项测量真实高度），默认 96 */
  estimateSize?: number;
  /** 可视区外多挂的行数，默认 4 */
  overscan?: number;
}

/** 一行 + 它的稳定键（键只在 `items` 变时重算） */
interface Row<T> {
  key: string;
  index: number;
  item: T;
}

export function VirtualList<T>({
  items,
  rowKey,
  itemRender,
  onMeasured,
  controllerRef,
  testId,
  scrollElementRef,
  container,
  row: rowWrapper,
  estimateSize = 96,
  overscan = 4,
}: VirtualListProps<T>): ReactNode {
  /** 自建滚动容器的宿主（外部模式下不用） */
  const hostRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = scrollElementRef ?? hostRef;
  /** 量到的可用高度；`undefined` = 没量到（或高度为 0）⇒ 退化为全量渲染 */
  const [height, setHeight] = useState<number | undefined>(undefined);

  /**
   * 键在这里**预先算好**：`getItemKey` 只收下标，而调用方的 `rowKey` 可能需要下标
   * （原文行没有 id）。`rowKey` 走 ref：调用方每次渲染新建箭头函数，进依赖等于每帧重算。
   */
  const rowKeyRef = useRef(rowKey);
  useEffect(() => {
    rowKeyRef.current = rowKey;
  }, [rowKey]);
  const rows = useMemo(
    () => items.map((item, index) => ({ key: rowKeyRef.current(item, index), index, item })),
    [items],
  );

  /** 上报回调放进 ref：调用方每次渲染新建箭头函数，直接进依赖会让测量回调每帧换一次身份 */
  const onMeasuredRef = useRef(onMeasured);
  useEffect(() => {
    onMeasuredRef.current = onMeasured;
  }, [onMeasured]);

  const measure = useCallback((host: HTMLElement | null): void => {
    if (host === null) return;
    setHeight(host.clientHeight > 0 ? host.clientHeight : undefined);
  }, []);

  useEffect(() => {
    const host = scrollRef.current;
    if (host === null) return;
    // 首帧先量一次：`ResizeObserver` 只在尺寸**变化**时回调，挂载那一次不能等
    measure(host);
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => measure(host));
    observer.observe(host);
    return () => observer.disconnect();
  }, [measure, scrollRef]);

  /** 量得到高度才虚拟化；量不到 ⇒ 全量渲染（本仓口径，见文件头口径 1） */
  const virtualized = height !== undefined;

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => estimateSize,
    getItemKey: (index) => rows[index]?.key ?? index,
    overscan,
  });

  const virtualItems = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();

  /** 可见范围变化后回报一次：调用方据此数已渲染行数（退化时行数就是 `items.length`） */
  useEffect(() => {
    const host = scrollRef.current;
    if (host !== null) onMeasuredRef.current?.(host);
  }, [rows, scrollRef, virtualized, virtualItems.length]);

  const renderRow = useCallback(
    (entry: Row<T>, style: CSSProperties | undefined, measureRef: ((node: HTMLElement | null) => void) | undefined): ReactNode => {
      const content = itemRender(entry.item, entry.index);
      if (rowWrapper !== undefined) {
        return rowWrapper({ key: entry.key, index: entry.index, style: style ?? {}, measureRef, children: content });
      }
      return (
        <div key={entry.key} ref={measureRef} data-index={entry.index} style={style}>
          {content}
        </div>
      );
    },
    [itemRender, rowWrapper],
  );

  const rendered = virtualized
    ? virtualItems.flatMap((virtualItem) => {
      const entry = rows[virtualItem.index];
      if (entry === undefined) return [];
      return [
        renderRow(
          entry,
          {
            position: 'absolute',
            top: 0,
            left: 0,
            width: '100%',
            // 逐项定位：`transform` 而不是 `top`，避免每帧触发布局
            transform: `translateY(${virtualItem.start}px)`,
          },
          virtualizer.measureElement,
        ),
      ];
    })
    : rows.map((entry) => renderRow(entry, undefined, undefined));

  useImperativeHandle(
    controllerRef,
    () => ({
      scrollToKey: (key: string, align: 'top' | 'bottom' = 'top'): void => {
        const index = rows.findIndex((entry) => entry.key === key);
        // 越界（列表里还没有那一项）时什么都不做：抛错会让一次滚动静默变成白屏
        if (index < 0) return;
        // 本仓的命令式口径是 `top` / `bottom`（调用方按轮次对齐），react-virtual 认的是 `start` / `end`
        virtualizer.scrollToIndex(index, { align: align === 'bottom' ? 'end' : 'start' });
      },
    }),
    [rows, virtualizer],
  );

  if (scrollElementRef === undefined) {
    return (
      <div ref={hostRef} data-testid={testId} style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        <div style={virtualized ? { height: totalSize, position: 'relative' } : { position: 'relative' }}>{rendered}</div>
      </div>
    );
  }

  const children = container === undefined
    ? rendered
    : container({ totalSize: virtualized ? totalSize : null, children: rendered });
  return <>{children}</>;
}
