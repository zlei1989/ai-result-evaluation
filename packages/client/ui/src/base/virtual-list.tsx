'use client';

/**
 * 虚拟滚动列表：**虚拟化的唯一持有者**——全仓只有这一处 `<Listy>`。
 *
 * 为什么抽成原语：`agent-log` 有两处内容都可能长到上千行（轮次时间轴、原文行的逐行台账），
 * 两处各接一遍 `Listy` 就是两份高度测量、两份退化兜底、两份「量不到就不虚拟化」——
 * 而 `agent-log-layering.test.ts` (c) 那条纪律（虚拟化的入口只许出现在一处）本来就是这个意思。
 *
 * 四条实测口径（照做，别照抄设计文档）：
 *   1. **`Listy` 总是把 token 派生的 `itemHeight` 传给底层**（antd 6.6 的 `listy/index.js` 里写死的），
 *      所以「不传 `itemHeight`」只是本仓的**调用口径**；动态高度补偿实际来自底层逐项测量，
 *      与传不传无关。推论：**要真正虚拟化必须给 `height`** —— 本件用外层容器 + `ResizeObserver` 量出可用高度；
 *   2. **量不到就不虚拟化**：jsdom 里 `clientHeight === 0`，此时**不给** `height` ⇒ `Listy` 全量渲染，
 *      这正好让单测能数到全部内容；环境里没有 `ResizeObserver`（老浏览器）时同样退化为不虚拟化，**不抛**；
 *   3. **宿主必须是有确定高度的 Flex 子项**：本件的根是 `flex: 1` + `minHeight: 0`，调用方要把它放进
 *      「像抽屉正文那样高度有界」的容器；否则 `clientHeight` 量出来是 0 ⇒ **静默地不虚拟化**
 *      （不报错、只是又变慢，这正是这条口径必须写下来的原因）；
 *   4. **「已渲染 N」不能用 `Listy` 的回调**（它没有透传 `onVisibleChange`）：调用方在 `onMeasured`
 *      里数**自己标的**锚点属性（数 antd 内部类名会把嵌套 `Listy` 的项一起算进来）。
 */
import { Flex, Listy } from 'antd';
import type { ListyRef } from 'antd';
import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type ReactNode, type Ref } from 'react';

/** 命令式句柄：跳转用（「跳到轮次」「回到最新」都走它） */
export interface VirtualListHandle {
  /** 滚到 `rowKey` 等于 `key` 的那一项；越界（列表里还没有那一项）时什么都不做 */
  scrollToKey(key: string, align?: 'top' | 'bottom'): void;
}

export interface VirtualListProps<T> {
  /** 只读数组（契约里的数据是 `readonly …[]`）；内部摊平一次给 `Listy`（它要可变数组） */
  items: readonly T[];
  /**
   * 行的稳定键。**给下标**（`Listy` 自己那一侧只收一参）：原文行没有 id，
   * 调用方要拿「序号 + 时间戳」造键——见 `rows` 那一段为什么键在这里预先算好。
   */
  rowKey(item: T, index: number): string;
  itemRender(item: T, index: number): ReactNode;
  /** 每次测量（挂载 / 尺寸变化 / 滚动）时回调：调用方在这一刻数「已渲染 N」 */
  onMeasured?(host: HTMLElement): void;
  controllerRef?: Ref<VirtualListHandle>;
  /** 本件根节点的 `data-testid`（用例与调用方定位用） */
  testId?: string;
}

export function VirtualList<T>({
  items,
  rowKey,
  itemRender,
  onMeasured,
  controllerRef,
  testId,
}: VirtualListProps<T>): ReactNode {
  const listyRef = useRef<ListyRef>(null);
  /** 列表宿主的容器：量它的可用高度（`Listy` 要的是数字，不是 `100%`） */
  const hostRef = useRef<HTMLElement | null>(null);
  const [height, setHeight] = useState<number | undefined>(undefined);
  /**
   * `Listy` 的 `items` 要**可变**数组，而调用方的数据是只读的（契约里就是 `readonly …[]`）。
   * 摊平一次并挂住引用：直接在 JSX 里 `[...items]` 会每次渲染新建一个数组，
   * 而它正是 `Listy` 判「要不要重算」的依据。
   */
  const listItems = useMemo(() => [...items], [items]);
  /**
   * 键在这里**预先算好**，行对象形如 `{ key, index, item }`，`Listy` 那一侧只给 `rowKey="key"`。
   *
   * 为什么不把回调直接交给 `Listy`：它的 `rowKey` 类型是 `keyof T | ((item: T) => Key)` 这个**联合**，
   * 传一个两参函数进去 TS 认不出来（而调用方需要下标才能给无 id 的行造稳定键）。
   * 键只在 `items` 变时才重算（`rowKey` 走 ref：调用方每次渲染新建箭头函数，进依赖就等于每帧重算）。
   */
  const rowKeyRef = useRef(rowKey);
  useEffect(() => {
    rowKeyRef.current = rowKey;
  }, [rowKey]);
  const rows = useMemo(
    () => listItems.map((item, index) => ({ key: rowKeyRef.current(item, index), index, item })),
    [listItems],
  );

  /** 上报回调放进 ref：调用方每次渲染新建的箭头函数，直接进依赖会让测量回调每帧换一次身份 */
  const onMeasuredRef = useRef(onMeasured);
  useEffect(() => {
    onMeasuredRef.current = onMeasured;
  }, [onMeasured]);

  /** 量一次可用高度，并把「量到了」这件事交给调用方（它可能还要数已渲染行数） */
  const measure = useCallback((host: HTMLElement | null): void => {
    if (host === null) return;
    setHeight(host.clientHeight > 0 ? host.clientHeight : undefined);
    onMeasuredRef.current?.(host);
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    // 首帧先量一次：`ResizeObserver` 只在尺寸**变化**时回调，挂载那一次不能等
    measure(host);
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => measure(host));
    observer.observe(host);
    return () => observer.disconnect();
  }, [measure]);

  useImperativeHandle(
    controllerRef,
    () => ({
      scrollToKey: (key: string, align: 'top' | 'bottom' = 'top'): void => {
        listyRef.current?.scrollTo({ key, align });
      },
    }),
    [],
  );

  return (
    <Flex vertical flex={1} style={{ minHeight: 0 }} data-testid={testId}>
      <Flex vertical ref={hostRef} flex={1} style={{ minHeight: 0 }}>
        <Listy
          ref={listyRef}
          virtual
          // 不传 `itemHeight`（本仓口径，见文件头）；`height` 量得到才给 ⇒ 量不到就全量渲染
          {...(height === undefined ? {} : { height })}
          items={rows}
          rowKey="key"
          itemRender={(row) => itemRender(row.item, row.index)}
          onScroll={(event) => measure(event.currentTarget)}
        />
      </Flex>
    </Flex>
  );
}
