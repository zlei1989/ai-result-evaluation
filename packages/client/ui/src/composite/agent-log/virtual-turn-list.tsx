'use client';

/**
 * 轮次时间轴的虚拟滚动（L2）：把「按项渲染」接到 L1 的单轮渲染上。
 *
 * ⚠️ **虚拟化本身住在 `base/virtual-list.tsx`**（**虚拟化的唯一持有者**，两处内容共用：
 * 时间轴与固定区的原文行；全仓另一处 `<Listy>` 在问答卡片里，不虚拟化）。本文件只剩这一层的事：
 *   1. **`buildRenderBlocks` 在按项渲染回调里才被调用**：在渲染层外面先全建一遍的话，
 *      虚拟滚动只省了 DOM、没省计算（`itemRender` 调的就是 `renderTurn`）；
 *   2. 「跳转」「回到最新」经 `VirtualListHandle.scrollToKey` 落到 `Listy.scrollTo`。
 *
 * `userPrompt` 与 `notices` 是**列表里的头几行**（不是列表外的固定条）：它们在时间轴上就是首条消息，
 * 钉在顶上会让长提示词永久占掉一屏高度。
 */
import { Flex } from 'antd';
import { useCallback, useImperativeHandle, useMemo, useRef, type ReactNode, type Ref } from 'react';
import { VirtualList, type VirtualListHandle } from '../../base/virtual-list';
import type { LogNodeIndex, LogSegment, LogTurn, MessageCapabilityMap, CandidateEvent, SessionNode } from './types';
import { UserPromptBlock, renderTurn, turnKey, type TurnRenderContext } from './agent-message-timeline';
import { SegmentDivider } from './segment-divider';
import { blockRendererOf, useBlockRenderers, type BlockRenderer } from './block-renderer-registry';

export interface ListController {
  scrollToTurn(index: number, align?: 'top' | 'bottom'): void;
  scrollToBottom(): void;
}

export interface VirtualTurnListProps {
  turns: readonly LogTurn[];
  nodes: LogNodeIndex;
  renderBlock?: BlockRenderer;
  openKeys?: ReadonlySet<string>;
  onOpenChange?(key: string, open: boolean): void;
  candidateEvents?: readonly CandidateEvent[];
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
  /**
   * 工作区相对路径 → 可加载的图片 URL（`image-view` 块的缩略图）。
   * **必须显式接上**（与下面三个出口同一条理由）：漏传时缩略图不画，界面上只降级成一句
   * 「当前视图不提供图片预览」——看起来像配置问题，其实是接线漏了。
   */
  imageSrcOf?: (previewPath: string) => string;
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
  const { turns, userPrompt, notices, activeNodeId, nodes, candidateEvents, openKeys, onOpenChange, controllerRef, segmentDividers, segments } = props;

  /** 列表命令式句柄（跳轮次 / 回到最新经它落到 `Listy.scrollTo`） */
  const listRef = useRef<VirtualListHandle>(null);

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

  /** 单轮渲染的上下文：与 L1 的 props 同形，外加整份轮次（候选级事件要靠邻轮判归属） */
  const turnContext = useMemo<TurnRenderContext>(
    () => ({
      nodes,
      renderBlock: dispatch,
      openKeys,
      onOpenChange,
      candidateEvents,
      activeNodeId,
      turns,
      // 四个出口**逐个显式接上**：漏掉任何一个，对应那一格就会「看得见、说不出」或「点不动」
      onEnterNode: props.onEnterNode,
      onRetryNode: props.onRetryNode,
      imageSrcOf: props.imageSrcOf,
      capability: props.capability,
    }),
    [
      nodes,
      dispatch,
      openKeys,
      onOpenChange,
      candidateEvents,
      activeNodeId,
      turns,
      props.onEnterNode,
      props.onRetryNode,
      props.imageSrcOf,
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

  useImperativeHandle(controllerRef, () => ({ scrollToTurn, scrollToBottom }), [scrollToTurn, scrollToBottom]);

  return (
    <Flex vertical flex={1} style={{ minHeight: 0 }} data-testid="virtual-turn-list">
      <VirtualList
        items={rows}
        rowKey={(row) => row.key}
        // 按项渲染：`buildRenderBlocks` 在这一层才被调用（护栏）
        itemRender={(row) => (row.kind === 'head' ? row.node : renderTurn(row.turn, row.index, turnContext))}
        controllerRef={listRef}
      />
    </Flex>
  );
}
