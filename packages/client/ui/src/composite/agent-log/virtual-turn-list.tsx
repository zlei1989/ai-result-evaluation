'use client';

/**
 * 轮次时间轴的虚拟滚动（L2）：把「按项渲染」接到 L1 的单轮渲染上。
 *
 * ⚠️ **虚拟化本身住在 `base/virtual-list.tsx`**（**虚拟化的唯一持有者**，两处内容共用：
 * 时间轴与固定区的原文行；全仓另一处 `<Listy>` 在问答卡片里，不虚拟化）。本文件只剩这一层的事：
 *   1. **`buildRenderBlocks` 在按项渲染回调里才被调用**：在渲染层外面先全建一遍的话，
 *      虚拟滚动只省了 DOM、没省计算（`itemRender` 调的就是 `renderTurn`）；
 *   2. **「已渲染 N」数的是我们自己标的 `data-turn-row`**（数 antd 内部类名会把嵌套 `Listy`
 *      的项一起算进来）。拿不到（从未滚动过 / 容器为空 / jsdom 量不到高度）时退回 `turns.length`
 *      —— **那是退化值，不是真值**，注释见 `shownRendered`；
 *   3. 「跳到轮次」「回到最新」经 `VirtualListHandle.scrollToKey` 落到 `Listy.scrollTo`。
 *
 * `userPrompt` 与 `notices` 是**列表里的头几行**（不是列表外的固定条）：它们在时间轴上就是首条消息，
 * 钉在顶上会让长提示词永久占掉一屏高度。
 */
import { Flex, theme, Typography } from 'antd';
import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type ReactNode, type Ref } from 'react';
import { VirtualList, type VirtualListHandle } from '../../base/virtual-list';
import type { LogNodeIndex, LogTurn, MessageCapabilityMap, RowEvent, SessionNode } from './types';
import { UserPromptBlock, renderTurn, turnKey, type TurnRenderContext } from './agent-message-timeline';
import { blockRendererOf, useBlockRenderers, type BlockRenderer } from './block-renderer-registry';

/** 「已渲染 N」的锚点属性：由 L1 的轮次行标注（`data-turn-row`） */
const TURN_ROW_ATTR = 'data-turn-row';

export interface ListController {
  scrollToTurn(index: number, align?: 'top' | 'bottom'): void;
  scrollToBottom(): void;
  /** 当前实际挂载的轮次行数（未测量到时是退化的 `turns.length`） */
  readonly renderedCount: number;
}

export interface VirtualTurnListProps {
  turns: readonly LogTurn[];
  nodes: LogNodeIndex;
  renderBlock?: BlockRenderer;
  openKeys?: ReadonlySet<string>;
  onOpenChange?(key: string, open: boolean): void;
  rowEvents?: readonly RowEvent[];
  userPrompt?: SessionNode['userPrompt'];
  notices?: readonly ReactNode[];
  activeNodeId?: string;
  /**
   * 子任务占位条上的「进入 ▸」（`BlockRenderContext` 的三个出口之一）。
   *
   * ⚠️ **必须在这里显式接上**：`TurnRenderContext` 与
   * `MessageTimelineProps` 同形，而这一格漏传时占位条的按钮**看上去完全正常、点下去毫无反应**——
   * 视图态切不过去，子任务的记录也就永远进不去（这正是「原始日志有内容、抽屉里看不到」的形状）。
   */
  onEnterNode?(nodeId: string): void;
  /** 节点内容读失败时的重取（同上：漏传时占位条不给重试按钮） */
  onRetryNode?(nodeId: string): void;
  /** 「原始输出」面板展开时向数据层上报一次 */
  onRequestDiagnostics?(): void;
  /**
   * 当前节点的能力声明（`BlockRenderContext` 的第四个出口）。
   *
   * ⚠️ **必须在这里显式接上**（与上面三个出口同一条理由）：
   * 本组件是**逐格重建** `TurnRenderContext` 的，漏传时 `AgentRunStateTag` 会静默退回
   * 那句光秃秃的「结果未采集」——界面上看起来完全正常，只是**永远说不出原因**。
   */
  capability?: MessageCapabilityMap;
  /** 由 `AgentLogLayout` 持有的命令式句柄（跳轮次 / 回到最新） */
  controllerRef?: Ref<ListController>;
  /** 「已渲染 N / 共 M 轮」的第一个数：**L2 的护栏**，L1 不渲染它 */
  onRenderedChange?(rendered: number): void;
}

/**
 * 列表的一项：用户提示词 / 补充提示是**头几行**，其余是轮次。
 * 这样提示词跟着列表一起滚（而不是钉在顶上），虚拟化也照常只挂载可见项。
 */
type TurnListRow =
  | { kind: 'head'; key: string; node: ReactNode }
  | { kind: 'turn'; key: string; turn: LogTurn; index: number };

export function VirtualTurnList(props: VirtualTurnListProps): ReactNode {
  const { token } = theme.useToken();
  const registry = useBlockRenderers();
  const dispatch = props.renderBlock ?? blockRendererOf(registry);
  const { turns, userPrompt, notices, activeNodeId, nodes, rowEvents, openKeys, onOpenChange, controllerRef } = props;

  /** 列表宿主的容器：这里只用来**数已渲染行数**（高度测量在 `VirtualList` 里） */
  const listHostRef = useRef<HTMLElement | null>(null);
  /** 列表命令式句柄（跳轮次 / 回到最新经它落到 `Listy.scrollTo`） */
  const listRef = useRef<VirtualListHandle>(null);
  /** 实测到的「已渲染轮数」；`null` = 还没量到（退化，见 `shownRendered`） */
  const [rendered, setRendered] = useState<number | null>(null);

  /** 上报回调放进 ref：它是调用方每次渲染新建的箭头函数，直接进依赖会让测量回调每帧换一次身份 */
  const onRenderedChangeRef = useRef(props.onRenderedChange);
  useEffect(() => {
    onRenderedChangeRef.current = props.onRenderedChange;
  }, [props.onRenderedChange]);

  /**
   * 数一次已渲染行数。**只在 `VirtualList` 报「量过了」时数**——它已经把宿主交到手上，
   * 与那边的高度测量是同一次回调（两处各自 ResizeObserver 就是两份判据）。
   */
  const countRendered = useCallback((host: HTMLElement): void => {
    listHostRef.current = host;
    const count = host.querySelectorAll(`[${TURN_ROW_ATTR}]`).length;
    setRendered(count);
    onRenderedChangeRef.current?.(count);
  }, []);

  /** 列表数据：提示词与补充提示在前，轮次在后 */
  const rows = useMemo<TurnListRow[]>(() => {
    const head: TurnListRow[] = [];
    if (userPrompt !== undefined && userPrompt !== null) {
      head.push({ kind: 'head', key: 'user-prompt', node: <UserPromptBlock userPrompt={userPrompt} /> });
    }
    (notices ?? []).forEach((notice, index) => {
      head.push({ kind: 'head', key: `notice-${index}`, node: notice });
    });
    return [
      ...head,
      ...turns.map((turn, index) => ({ kind: 'turn' as const, key: turnKey(turn, index), turn, index })),
    ];
  }, [turns, userPrompt, notices]);

  /** 单轮渲染的上下文：与 L1 的 props 同形，外加整份轮次（行级事件要靠邻轮判归属） */
  const turnContext = useMemo<TurnRenderContext>(
    () => ({
      nodes,
      renderBlock: dispatch,
      openKeys,
      onOpenChange,
      rowEvents,
      activeNodeId,
      turns,
      // 四个出口**逐个显式接上**：漏掉任何一个，对应那一格就会「看得见、说不出」或「点不动」
      onEnterNode: props.onEnterNode,
      onRetryNode: props.onRetryNode,
      onRequestDiagnostics: props.onRequestDiagnostics,
      capability: props.capability,
    }),
    [
      nodes,
      dispatch,
      openKeys,
      onOpenChange,
      rowEvents,
      activeNodeId,
      turns,
      props.onEnterNode,
      props.onRetryNode,
      props.onRequestDiagnostics,
      props.capability,
    ],
  );

  const scrollToTurn = useCallback(
    (index: number, align: 'top' | 'bottom' = 'top'): void => {
      const turn = turns[index];
      // 越界（轮次被流式追加/回退掉）时什么都不做：抛错会让一次滚动静默变成白屏
      if (turn === undefined) return;
      listRef.current?.scrollToKey(turnKey(turn, index), align);
    },
    [turns],
  );

  const scrollToBottom = useCallback((): void => {
    const last = turns.length - 1;
    const turn = turns[last];
    if (turn === undefined) return;
    listRef.current?.scrollToKey(turnKey(turn, last), 'bottom');
  }, [turns]);

  /**
   * 「已渲染 N」的展示值：量到过就用实测值，没量到就退回 `turns.length`。
   * **后者是退化值而不是真值**（jsdom 里从不滚动、空列表也量不到），
   * 但「显示一个偏大的数」比「显示 0」更接近事实：不虚拟化时 N 本来就等于 M。
   */
  const shownRendered = rendered ?? turns.length;

  useImperativeHandle(
    controllerRef,
    () => ({ scrollToTurn, scrollToBottom, renderedCount: shownRendered }),
    [scrollToTurn, scrollToBottom, shownRendered],
  );

  return (
    <Flex vertical flex={1} style={{ minHeight: 0 }} data-testid="virtual-turn-list">
      <VirtualList
        items={rows}
        rowKey={(row) => row.key}
        // 按项渲染：`buildRenderBlocks` 在这一层才被调用（护栏）
        itemRender={(row) => (row.kind === 'head' ? row.node : renderTurn(row.turn, row.index, turnContext))}
        // 宿主由 `VirtualList` 交回来：已渲染计数与高度测量是同一次回调
        onMeasured={countRendered}
        controllerRef={listRef}
      />
      {/* 列表尾部一行：既是调试指标也是性能护栏（N 失控增长时立刻看得见） */}
      <Flex justify="flex-end" style={{ paddingTop: token.marginXXS }}>
        <Typography.Text type="secondary">
          已渲染 {shownRendered} / 共 {turns.length} 轮
        </Typography.Text>
      </Flex>
    </Flex>
  );
}
