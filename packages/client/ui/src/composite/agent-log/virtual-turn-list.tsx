'use client';

/**
 * 轮次时间轴的虚拟滚动（L2）：把「按项渲染」接到 L1 的单轮渲染上。
 *
 * ⚠️ **虚拟化本身住在 `base/virtual-list.tsx`**（**虚拟化的唯一持有者**，两处内容共用：
 * 时间轴与固定区的原文行）。本文件只剩这一层的事：
 *   1. **`buildRenderBlocks` 在按项渲染回调里才被调用**：在渲染层外面先全建一遍的话，
 *      虚拟滚动只省了 DOM、没省计算（`itemRender` 调的就是 `renderTurn`）；
 *   2. **「已渲染 N」数的是我们自己标的 `data-turn-row`**（数框架内部类名会把嵌套的列表
 *      的项一起算进来）。拿不到（从未滚动过 / 容器为空 / jsdom 量不到高度）时退回 `turns.length`
 *      —— **那是退化值，不是真值**，注释见 `shownRendered`；
 *   3. **每行是一个 `MessageScrollerItem`**（外部宿主模式）：滚动容器的跟随 / 锚定 / 定位
 *      都靠「内容区的直接子节点」认消息，故行根必须是 Item，中间不能再包一层定位 div。
 *      `scrollAnchor` 只标**当前轮次的边界**（最后一段的首行）——虚拟化会随窗口不断增删子节点，
 *      库把「新出现的锚点」当成新轮次并滚过去；历史段的锚点若也标上，上翻经过段首时会被拽回去；
 *   4. 跳转先经 `VirtualListHandle.scrollToKey` 让目标行挂上，再由外层用库的
 *      `scrollToMessage` 精确对齐（未挂上那一帧由库的 pending 机制在行挂载后补上）。
 *
 * `userPrompt` 与 `notices` 是**列表里的头几行**（不是列表外的固定条）：它们在时间轴上就是首条消息，
 * 钉在顶上会让长提示词永久占掉一屏高度。
 */
import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type ReactNode, type Ref, type RefObject } from 'react';
import { VirtualList, type VirtualContainerArgs, type VirtualListHandle, type VirtualRowArgs } from '../../base/virtual-list';
import { MessageScrollerContent, MessageScrollerItem } from '../../components/ui/message-scroller';
import type { LogNodeIndex, LogSegment, LogTurn, MessageCapabilityMap, RowEvent, SessionNode } from './types';
import type { CheckpointCapability } from '@aieval/contracts';
import type { CheckpointTarget } from './checkpoint-marker';
import { UserPromptBlock, renderTurn, turnKey, type TurnRenderContext } from './agent-message-timeline';
import { SegmentDivider } from './segment-divider';
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
   * 要不要在段首画「追问 ×N」分隔行。
   * **只有主会话节点为真**（调用方按 `node.kind` 给）：子会话节点里的轮次属于那个子任务自己，
   * 它没有被人追问过——在那里画一行「追问 ×1」是把父会话的动作安到它头上。
   */
  segmentDividers?: boolean;
  /**
   * 段这一层的事实（`AgentLogModel.segments`）：第几次追问、那句追问是什么、什么时候问的。
   * 只在 `segmentDividers` 为真时被用；缺失 = 一个段标题都不画（**不编一行只有号没有正文的标题**）。
   */
  segments?: readonly LogSegment[];
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
  /** 轮末「回到这里」：能力声明与两个出口（与 `capability` 逐条同源，漏传会静默不显示按钮） */
  checkpoint?: CheckpointCapability | null;
  onCheckpoint?(target: CheckpointTarget): void;
  checkpointAnchorOf?(target: CheckpointTarget): { keepAt: string; dropFrom: string | null } | null;
  /** 由 `AgentLogLayout` 持有的命令式句柄（跳轮次 / 回到最新） */
  controllerRef?: Ref<ListController>;
  /**
   * 「已渲染 N / 共 M 轮」的两个数**往上报**（本件不再自己渲染那一行）：
   * 它现在住在固定区的原文行、紧挨着「下载台账」后面（用户口径）。
   * 报的是 `(已渲染, 总轮次)`：两者一个是实测值、一个是数据的长度，凑齐才念得成一句话。
   */
  onRenderedChange?(rendered: number, total: number): void;
  /**
   * 外部滚动容器（Message Scroller 的 Viewport）：给了就把行交给它的内容区（MessageScrollerContent）。
   * 不给时本件自建宿主（测试与嵌入场景），此时不产生任何 Message Scroller 语义。
   */
  scrollElementRef?: RefObject<HTMLElement | null>;
}

/**
 * 列表的一项：用户提示词 / 补充提示 / **段分隔**是头几行与插行，其余是轮次。
 * 这样提示词跟着列表一起滚（而不是钉在顶上），虚拟化也照常只挂载可见项。
 */
type TurnListRow =
  | { kind: 'head'; key: string; node: ReactNode }
  | { kind: 'turn'; key: string; turn: LogTurn; index: number };

export function VirtualTurnList(props: VirtualTurnListProps): ReactNode {
  const registry = useBlockRenderers();
  const dispatch = props.renderBlock ?? blockRendererOf(registry);
  const { turns, userPrompt, notices, activeNodeId, nodes, rowEvents, openKeys, onOpenChange, controllerRef, segmentDividers, segments } = props;

  /** 列表命令式句柄（跳轮次经它落到 react-virtual 的 `scrollToIndex`） */
  const listRef = useRef<VirtualListHandle>(null);
  /** 实测到的「已渲染轮数」；`null` = 还没量到（退化，见 `shownRendered`） */
  const [rendered, setRendered] = useState<number | null>(null);

  /** 上报回调放进 ref：它是调用方每次渲染新建的箭头函数，直接进依赖会让测量回调每帧换一次身份 */
  const onRenderedChangeRef = useRef(props.onRenderedChange);
  useEffect(() => {
    onRenderedChangeRef.current = props.onRenderedChange;
  }, [props.onRenderedChange]);

  /**
   * 数一次已渲染行数。**只在 `VirtualList` 报「可见范围变了」时数**——它已经把宿主交到手上，
   * 与那边的高度测量是同一次回调（两处各自 ResizeObserver 就是两份判据）。
   */
  const countRendered = useCallback((host: HTMLElement): void => {
    const count = host.querySelectorAll(`[${TURN_ROW_ATTR}]`).length;
    setRendered(count);
    // 报数不在这里：这一次回调只拿得到「已渲染」，总量在 `turns` 上，
    // 而这个 `useCallback` 的依赖是空的（测量回调必须身份稳定）⇒ 在这里读 `turns` 会读到首帧的量。
    // 统一由下面那个 effect 报（它两个数都拿得到，且 `setRendered` 会把测量结果带过去）。
  }, []);

  /**
   * 列表数据：提示词与补充提示在前，随后是轮次；**每换一段插一行分隔**（「追问 ×N」）。
   *
   * 段分隔只在主会话节点画（`segmentDividers`）：子会话节点里的那些轮次是某个子任务自己的，
   * 那个子任务里没有人追问过——在那里画「追问 ×1」是把父会话的动作安到子任务头上。
   */
  const rows = useMemo<TurnListRow[]>(() => {
    const head: TurnListRow[] = [];
    if (userPrompt !== undefined && userPrompt !== null) {
      head.push({ kind: 'head', key: 'user-prompt', node: <UserPromptBlock userPrompt={userPrompt} /> });
    }
    (notices ?? []).forEach((notice, index) => {
      head.push({ kind: 'head', key: `notice-${index}`, node: notice });
    });
    const body: TurnListRow[] = [];
    turns.forEach((turn, index) => {
      const previous = turns[index - 1];
      /**
       * 段标题**整段块之一**（分隔线 + 「追问 ×N」+ 时刻 + 那句追问），插在该段**第一个轮次之前**。
       * 判据与既有实现逐字相同（「换段了」），只是标题的内容来源换成了**段这一层的数据**
       * （`AgentLogModel.segments`）：那句人话已由数据层从轮次的展示块里提出来 ⇒ 标题就是它唯一的出口。
       *
       * 数据层没给这一段的结论（老调用方 / 段事实缺失）时**不编一行**：只有「追问 ×N」而没有
       * 正文的标题会把读者引向「他追问了什么」而答不出来——宁可不画。
       */
      if (segmentDividers === true && turn.segment > 0 && previous?.segment !== turn.segment) {
        const fact = segments?.find((one) => one.segment === turn.segment);
        if (fact !== undefined) {
          body.push({
            kind: 'head',
            key: `segment-${turn.segment}`,
            node: <SegmentDivider segment={fact.segment} at={fact.at} text={fact.text} />,
          });
        }
      }
      body.push({ kind: 'turn', key: turnKey(turn, index), turn, index });
    });
    return [...head, ...body];
  }, [turns, userPrompt, notices, segmentDividers, segments]);

  /**
   * 当前轮次的边界（`scrollAnchor` 只标这一行）：最后一段的第一行——段分隔（「追问 ×N」）
   * 或该段首个轮次；首段则取题面卡片，没有题面时取首轮。
   *
   * 为什么不标每个历史段：虚拟化窗口会随滚动不断增删子节点，库把「新出现的锚点」当成新的
   * 一轮并把它滚到顶部 ⇒ 上翻经过历史段首时会被拽回去。只保留当前边界，锚定语义仍在
   * （新追问开始时那句话停在顶上、回复在下面长出来）。
   */
  const anchorKey = useMemo<string | null>(() => {
    const last = turns[turns.length - 1];
    if (last === undefined) return null;
    if (last.segment === 0) {
      return (
        rows.find((row) => row.key === 'user-prompt')?.key ??
        rows.find((row) => row.kind === 'turn' && row.turn.segment === 0)?.key ??
        null
      );
    }
    return (
      rows.find((row) => row.key === `segment-${last.segment}`)?.key ??
      rows.find((row) => row.kind === 'turn' && row.turn.segment === last.segment)?.key ??
      null
    );
  }, [rows, turns]);

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
      checkpoint: props.checkpoint,
      onCheckpoint: props.onCheckpoint,
      checkpointAnchorOf: props.checkpointAnchorOf,
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
      props.checkpoint,
      props.onCheckpoint,
      props.checkpointAnchorOf,
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

  useEffect(() => {
    // 走 ref 而不是直接依赖 prop：调用方每次渲染新建箭头函数，进依赖会让本件每帧重跑一次
    onRenderedChangeRef.current?.(shownRendered, turns.length);
  }, [shownRendered, turns.length]);

  useImperativeHandle(
    controllerRef,
    () => ({ scrollToTurn, scrollToBottom, renderedCount: shownRendered }),
    [scrollToTurn, scrollToBottom, shownRendered],
  );

  const scrollElementRef = props.scrollElementRef;
  const external = scrollElementRef !== undefined;

  return (
    <VirtualList
      items={rows}
      rowKey={(row) => row.key}
      // 按项渲染：`buildRenderBlocks` 在这一层才被调用（护栏）
      itemRender={(row) => (row.kind === 'head' ? row.node : renderTurn(row.turn, row.index, turnContext))}
      // 宿主由 `VirtualList` 交回来：已渲染计数与高度测量是同一次回调
      onMeasured={countRendered}
      controllerRef={listRef}
      testId={external ? undefined : 'virtual-turn-list'}
      scrollElementRef={scrollElementRef}
      // 外部宿主（Message Scroller）：行必须是内容区的直接子节点，定位与测量都落在 Item 根上
      row={
        external
          ? ({ key, index, style, measureRef, children }: VirtualRowArgs): ReactNode => (
            <MessageScrollerItem
              key={key}
              ref={measureRef}
              data-index={index}
              messageId={key}
              scrollAnchor={key === anchorKey}
              style={style}
              className="min-w-0"
            >
              {children}
            </MessageScrollerItem>
          )
          : undefined
      }
      container={
        external
          ? ({ totalSize, children }: VirtualContainerArgs): ReactNode => (
            <MessageScrollerContent
              data-testid="virtual-turn-list"
              className="h-auto min-h-full gap-0"
              // 虚拟化时高度由行偏移的总长度给（行是绝对定位的，内容区不再靠子节点撑开）；
              // 退化渲染时不给高度，交给内容自己撑
              style={totalSize === null ? undefined : { height: totalSize, position: 'relative' }}
            >
              {children}
            </MessageScrollerContent>
          )
          : undefined
      }
    />
  );
}
