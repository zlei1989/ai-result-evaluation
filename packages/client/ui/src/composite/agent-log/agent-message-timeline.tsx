'use client';

/**
 * 轮次时间轴（L1）：**逐轮 `map` 渲染，`turns` 多大就渲染多少**。
 *
 * 四条边界（§9.0 的三条纪律 + §7.2 的性能护栏）：
 *   1. **不虚拟化**：虚拟滚动是 L2 `virtual-turn-list` 的事。内嵌只读视图常常只有几轮，
 *      为它引一层虚拟列表是净亏；
 *   2. **props 里没有任何 subagent 字段**：「当前在第几级」是 `AgentLogLayout` 的事，
 *      于是「子任务与主会话同形」是同一个组件、同一份 props 形状，不可能漂移；
 *   3. **不认识折叠态本身**：它只把 `openKeys` 翻译成每个块的 `BlockRenderContext`
 *      （`open` + `onOpenChange`），块怎么画在 L0 注册表里；
 *   4. **`buildRenderBlocks` 只在单轮渲染入口（`renderTurn`）里被调用**：调用方若在渲染层外面
 *      先全建一遍，虚拟滚动就只省了 DOM、没省计算。
 *
 * 本文件同时是**折叠态键生成函数**的真源之一（`renderBlockKey` 与 `turnKey` 在这里；`toolEntryKey` 的真源在 L0 的 `tool-item-detail`）：
 * L2 的 `use-agent-log-view` 与 `virtual-turn-list` 都要用同一份——各写一遍必然漂移，
 * 而漂移的表现是「我展开的那条自己合上了」。键放在 L1 而不是 L2，是因为**依赖只准向下**：
 * L1 不许 import L2，而 L2 可以 import L1。
 */
import { Card, Flex, Tag, theme, Typography } from 'antd';
import { Fragment, useMemo, type ReactNode } from 'react';
import type { RowEvent, LogNodeIndex, LogTurn, MessageCapabilityMap, SessionNode, AgentTokens } from './types';
import { buildRenderBlocks, type RenderBlock } from './render-blocks';
// 行键只有一处真源：L0 的 `tool-item-detail`（`ToolGroupPanel` 的 React key 与受控行键都用它）。
// 本文件不另写一份公式——两处各写一遍必然漂，漂了的表现是「失败的行走不到默认展开」。
import { toolEntryKey } from './tool-item-detail';
import {
  DEFAULT_BLOCK_RENDERERS,
  blockRendererOf,
  useBlockRenderers,
  type BlockRenderContext,
  type BlockRenderer,
} from './block-renderer-registry';
import { MarkdownText } from '../../base/markdown-text';
import { formatUsageTriple } from '../../base/usage-metrics';

/**
 * 折叠态键：轮次里的一类块。
 * `text` / `thinking` / `attachment` / `unrecognized` 用块自己的 `id`（数据层给的稳定键）；
 * 两族卡片用**承载载荷的那个 `tool-call` 块的 `id`**（`cardId`），同一轮多次 `task` 调用因而各自独立。
 * **不用数组下标**：轮次内容会随流式追加变长，下标会漂（「我展开的那条自己合上了」正是这么来的）。
 *
 * 工具组那一格的键**带 `tool-group:` 前缀**：组内每一行的键（`tool-item-detail` 的 `toolEntryKey`，
 * 由 L0 的 `ToolGroupPanel` 消费）本来就是 `callId` 或源块 id，不加前缀的话
 * 「组键」与「该组第一条的行键」会是同一个字符串——展开组会顺带展开第一行，两份状态串成一份。
 */
export function renderBlockKey(block: RenderBlock, index: number, turnAt: string): string {
  switch (block.kind) {
    case 'text':
    case 'thinking':
    case 'attachment':
    case 'unrecognized':
      return block.block.id;
    case 'tool-group': {
      const first = block.entries[0];
      return first === undefined ? `${turnAt}#${index}` : `tool-group:${toolEntryKey(first)}`;
    }
    case 'task-panel':
      return block.cardId;
    case 'ask-user-card':
      return block.cardId;
    case 'subagent-bar':
      return `subagent:${block.node.id}`;
    case 'row-summary':
      return `row:${block.node.id}`;
  }
}

/**
 * 轮次的稳定键：`round` 是「模型一次 API 往返」的编号，`null` = 不属于任何轮次的内容。
 * 虚拟列表的 `rowKey`、React key、跳轮次都挂在它上面。**不用数组下标**：轮次会随流式追加而增删。
 */
export function turnKey(turn: LogTurn, index: number): string {
  return turn.round !== null ? `round-${turn.round}` : `unassigned-${turn.at}-${index}`;
}

/**
 * 挂在第 `index` 轮之后的行级事件。**两条规则，不留洞**（2026-10-05，spec §2.4）：
 *   ① **有归属键**（`event.turn !== null`）：本轮的 `(subagentId, round)` 与它**逐字相同**才归本轮。
 *      本节点没有这一轮 ⇒ **本节点不显示它**（它属于别的会话节点，在那里显示）——回落按时刻会把
 *      「不属于这一轮的读数」混进最后一轮，那正是这次要修的毛病。
 *   ② **没有归属键**（`error` / `warning` / 算不出归属的里程碑）：沿用按时刻的老规则
 *      ——「该事件的 `at` <= 该轮 `at` 的**最后一轮**」。写成「本轮的 `at` 不晚于事件、且下一轮的
 *      `at` 晚于事件」是因为列表按项渲染时只看得到相邻两项；早于**所有**轮次的事件挂到第一轮
 *      （不丢），最后一轮兜住它之后的全部事件。
 * 比较用字符串字面序（两侧都是数据层给的 ISO 串，字面序即时间序；不解析成 `Date` 也就没有 NaN 这类分支）。
 */
export function rowEventsOfTurn(
  turns: readonly LogTurn[],
  events: readonly RowEvent[],
  index: number,
): readonly RowEvent[] {
  const turn = turns[index];
  if (turn === undefined) return [];
  const next = turns[index + 1];
  return events.filter((event) => {
    if (event.turn !== null) {
      return event.turn.subagentId === turn.subagentId && event.turn.round === turn.round;
    }
    return (index === 0 || turn.at <= event.at) && (next === undefined || next.at > event.at);
  });
}

/** 行级事件 → 标签色档：`milestone` 中性、`warning` 警告色、`error` 错误色（三档不许合并） */
const EVENT_TAG_COLOR: Record<RowEvent['level'], string> = {
  milestone: 'default',
  warning: 'warning',
  error: 'error',
};

/** ISO 时间 → 本地 `HH:mm:ss`；非法输入原样返回（与 `composite/log-format.ts` 的 `formatClock` 同口径） */
function formatClock(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** 轮次左槽宽（实测基线 §5.0.4：宽 64 + 右 padding 8）。写进内联样式：这是结构性不变量，不是排版偏好 */
const TURN_GUTTER_WIDTH = 64;

/**
 * 卡片底部「原始结果」抽屉在**同一份折叠态**里的键后缀（见 `contextOf`）。
 * 用后缀而不是第二份 state：`openKeys` 本来就是一份「任意字符串键」的集合，
 * 而 L1 不许持态（`agent-log-layering.test.ts` (d)）。
 */
const RAW_DRAWER_SUFFIX = '|raw';

export interface MessageTimelineProps {
  /** 轮次（**已分组、未建渲染块**——渲染块在本文件的单轮入口里现建） */
  turns: readonly LogTurn[];
  /** 会话树索引：`buildRenderBlocks` 的规则 3（派发点）要用 */
  nodes: LogNodeIndex;
  /** 块分派。不传 = 走默认注册表（`blockRendererOf(useBlockRenderers())`） */
  renderBlock?: BlockRenderer;
  /** 折叠态（受控）：不传 = 全部按默认态、不可交互 */
  openKeys?: ReadonlySet<string>;
  onOpenChange?(key: string, open: boolean): void;
  /** 行级事件：有归属键的按「会话 + 号」落到那一轮，无键的按 `at` 落在轮次之间（见 `rowEventsOfTurn`） */
  rowEvents?: readonly RowEvent[];
  /** 该节点的首条消息（用户提示词）。**L1 不知道它从哪来**，只负责摆最前、不折叠 */
  userPrompt?: SessionNode['userPrompt'];
  /** 只用于给 `buildRenderBlocks` 的轮上下文（规则 3 的兜底定位），不参与任何分支 */
  activeNodeId?: string;
  /** 用户提示词之后的补充提示（如「该子任务的对话未转发」）。**L1 不知道它从哪来，只负责摆** */
  notices?: readonly ReactNode[];
  /**
   * 下面三个回调补的是 §9.1 的 props 清单里没有、但 `BlockRenderContext` 明确要的三格
   * （`onEnterNode` 是子任务占位条唯一有副作用的动作）。不给就退化成「没有这个入口」，
   * 而不是在 L1 里自己造一份导航态。三格全可选 ⇒ 既有的 props 形状一个字段都不用改。
   */
  onEnterNode?(nodeId: string): void;
  onRetryNode?(nodeId: string): void;
  onRequestDiagnostics?(): void;
  /**
   * 当前节点的**能力声明**：原样进每个块的 `BlockRenderContext`
   * （`AgentRunStateTag` 的「结果未采集 · 原因」就是从这里取的，见 `block-renderer-registry`）。
   * **L1 不读它**——它只负责转发，读懂是 L0 与注册表的事。
   */
  capability?: MessageCapabilityMap;
}

/**
 * 单轮渲染入口收到的上下文：`MessageTimelineProps` 去掉 `turns`，**外加整份轮次**。
 * 为什么要把 `turns` 带回来：**无归属键的**行级事件按 `at` 落在轮次之间，判定「这一轮是不是最后一个
 * `at` 不晚于事件的轮次」要看邻轮。该字段可选 ⇒ 只给 `Omit<MessageTimelineProps, 'turns'>` 的调用方照样可用。
 */
export interface TurnRenderContext extends Omit<MessageTimelineProps, 'turns'> {
  turns?: readonly LogTurn[];
}

/** 单轮渲染入口：虚拟列表按项渲染时调的就是它（`buildRenderBlocks` 在这里才被调用） */
export type RenderTurn = (turn: LogTurn, index: number) => ReactNode;

/**
 * 不传 `renderBlock` 时的兜底分派：直接用**默认注册表**。
 * 组件内部走 `useBlockRenderers()`（能吃到 `BlockRendererProvider` 的叠加），
 * 这个常量只服务「外部直接调 `renderTurn`」这一种调用方式——那里没有 hook 可挂。
 */
const DEFAULT_RENDERER: BlockRenderer = blockRendererOf(DEFAULT_BLOCK_RENDERERS);

/** 单轮渲染：左槽（轮次 + 时刻）+ 右内容（渲染块序列 + 挂在轮末的行级事件） */
export function renderTurn(turn: LogTurn, index: number, props: TurnRenderContext): ReactNode {
  const events = rowEventsOfTurn(props.turns ?? [], props.rowEvents ?? [], index);
  return <TurnRow turn={turn} index={index} props={props} events={events} />;
}

/**
 * 这一轮里**每条 assistant 消息**自己的用量（2026-10-06）。
 *
 * 为什么必须按逻辑消息去重：同一条消息的正文块与工具调用块带的是**同一个** usage ⇒ 逐块渲染
 * 会把同一行数字画两遍。去重键取 `mergeKey`（**逻辑消息**的定义，见 `ContentBlockBase.mergeKey`）。
 * ⚠️ 同一轮里用 `messageId` 当键**结果相同**（那些块来自同一条折叠后的消息，共用一个 id）——
 * 这不是区分力所在（2026-10-06 变异验证实测：把键换成 `messageId` 用例照样绿）；
 * 真正的靶子是「**根本不去重**」，用例 ① 钉的是它。
 *
 * 为什么在轮末渲染而不是插进渲染块之间：渲染块是判别联合、相邻工具条目会并成一个 `tool-group`
 * ⇒ 渲染块的下标与 `turn.blocks` 不对齐，按块下标插入会把页脚插到错的块后面。
 *
 * 只有 `assistant` 消息才可能有消息级用量（工具结果消息恒 `null`）；`usage === null` 一档整行不画。
 */
function usageFootersOf(turn: LogTurn): { mergeKey: string; usage: AgentTokens }[] {
  const seen = new Map<string, AgentTokens>();
  for (const block of turn.blocks) {
    if (block.role !== 'assistant' || block.usage === null) continue;
    if (!seen.has(block.mergeKey)) seen.set(block.mergeKey, block.usage);
  }
  return [...seen].map(([mergeKey, usage]) => ({ mergeKey, usage }));
}

/** 单轮的实际渲染。抽成组件是为了能读主题 token（间距一律走 token，不手写像素） */
function TurnRow({
  turn,
  index,
  props,
  events,
}: {
  turn: LogTurn;
  index: number;
  props: TurnRenderContext;
  events: readonly RowEvent[];
}): ReactNode {
  const { token } = theme.useToken();
  const { nodes, activeNodeId = '', openKeys, onOpenChange, renderBlock, onEnterNode, onRetryNode, onRequestDiagnostics, capability } = props;
  const dispatch = renderBlock ?? DEFAULT_RENDERER;

  // 本轮第一条块的 `messageId`：规则 3 在 `callId` 为 null 时用它兜底定位派发点（本轮没有块时给 null）
  const messageId = turn.blocks[0]?.messageId ?? null;
  const blocks = buildRenderBlocks(turn.blocks, nodes, {
    at: turn.at,
    running: turn.running,
    messageId,
    nodeId: activeNodeId,
    // 行级汇总那条说明行是**整个节点**的事实，只在第一轮之后画一次（见 `buildRenderBlocks` 的注释）
    firstTurn: index === 0,
  });

  /** 每个块拿到的受控闭包：折叠态只从 `openKeys` / `onOpenChange` 来，L1 自己不持态 */
  const contextOf = (key: string): BlockRenderContext => ({
    open: openKeys?.has(key) ?? false,
    onOpenChange: (next) => onOpenChange?.(key, next),
    // 卡片底部「原始结果」抽屉：**同一份折叠态、加后缀的键**——独立于卡片自身的开合，
    // 且不新增状态通道（L1 依然一份 state 都不持）
    rawOpen: openKeys?.has(`${key}${RAW_DRAWER_SUFFIX}`) ?? false,
    onRawOpenChange: (next) => onOpenChange?.(`${key}${RAW_DRAWER_SUFFIX}`, next),
    openKeys,
    // 组内每一行的键也是同一份折叠态：同一个 `onOpenChange` 转发即可（键由 L0 按 `callId` 给）
    onEntryOpenChange: onOpenChange === undefined ? undefined : (entryKey, next) => onOpenChange(entryKey, next),
    onEnterNode,
    onRetryNode,
    onRequestDiagnostics,
    // 能力声明原样下发（L1 不读它）：`AgentRunStateTag` 的「结果未采集 · 原因」取自这里
    capability,
  });

  return (
    // `data-turn-row` 是 L2 数「已渲染 N 轮」的锚点（数我们自己标的属性，而不是 antd 内部类名，
    // 这样嵌套的 Listy 项不会被误算进来）
    <Flex gap={token.marginSM} data-turn-row={turnKey(turn, index)}>
      <Flex vertical align="flex-end" style={{ width: TURN_GUTTER_WIDTH, flexShrink: 0 }}>
        <Typography.Text type="secondary">{turn.round === null ? '未归属' : `轮次 ${turn.round}`}</Typography.Text>
        <Typography.Text type="secondary">{formatClock(turn.at)}</Typography.Text>
      </Flex>

      <Flex vertical gap={token.marginSM} style={{ flex: 1, minWidth: 0 }}>
        {turn.durationMs !== null && (
          // 口径与设计文档的示例一致：轮次耗时带一位小数（「本轮 3.2s」），它不是结算级别的计量
          <Typography.Text type="secondary">本轮 {(turn.durationMs / 1000).toFixed(1)}s</Typography.Text>
        )}
        {blocks.map((block, blockIndex) => {
          const key = renderBlockKey(block, blockIndex, turn.at);
          return <Fragment key={key}>{dispatch(block, contextOf(key))}</Fragment>;
        })}
        {usageFootersOf(turn).map((footer) => (
          // 锚点照 `data-turn-row` / `data-row-event` 的既有习惯：断言数自己标的属性，不数 antd 内部类名。
          // `italic` 是刻意的（用户 2026-10-06 口径）：顶部事实条是正体灰字、轮末里程碑是 Tag 色块，
          // 这一行只有斜体才与前两者两两可分；antd 没有比 secondary 更弱的档，所以不引入手写样式。
          <Typography.Text key={footer.mergeKey} type="secondary" italic data-usage-footer>
            本条 {formatUsageTriple(footer.usage)}
          </Typography.Text>
        ))}
        <RowEventLines events={events} />
      </Flex>
    </Flex>
  );
}

/**
 * 挂在轮末的行级事件（行距 4 = `marginXXS`，见 §5.0.4）。
 *
 * `data-row-event` 是**每一条行级事件**自己的锚点（值是色档 `event.level`）：`data-turn-row` 只标在
 * 轮次行上（一个轮次一行，与这一轮挂了几条事件无关），所以**数用量行只能用这个锚点**。
 * 少它的时候「主会话节点里恰好只有它自己那两条用量」这类断言会写成「数轮次行」——恒等于轮次数，
 * 任何水位变异下都绿（2026-10-05 审查 Important C：那条断言当时**没有**被落实）。
 */
function RowEventLines({ events }: { events: readonly RowEvent[] }): ReactNode {
  const { token } = theme.useToken();
  if (events.length === 0) return null;
  return (
    <Flex vertical gap={token.marginXXS}>
      {events.map((event, index) => (
        <Flex key={`${event.at}#${index}`} align="center" gap={token.marginXXS} data-row-event={event.level}>
          <Tag color={EVENT_TAG_COLOR[event.level]}>{event.text}</Tag>
          <Typography.Text type="secondary">{formatClock(event.at)}</Typography.Text>
        </Flex>
      ))}
    </Flex>
  );
}

/**
 * 首条消息：用户提示词。**不折叠**——它是「这个节点被要求做什么」的唯一说明（D4）。
 * `userPrompt === null` 时整块不渲染（不给空卡片：「没采到」与「没有提示词」是两件事）。
 *
 * 具名导出是因为虚拟列表也要用它（L2 可以 import L1）：提示词在抽屉里同样是**首条消息**，
 * 若在虚拟列表外面另画一份，「滚动区里只有一轮轮」与「提示词永远钉在顶上」就会同时成立。
 */
export function UserPromptBlock({ userPrompt }: { userPrompt: NonNullable<SessionNode['userPrompt']> }): ReactNode {
  const { token } = theme.useToken();
  return (
    <Card size="small" data-testid="agent-log-user-prompt">
      <Flex vertical gap={token.marginXXS}>
        <Flex align="center" gap={token.marginXS}>
          <Typography.Text strong>用户提示词</Typography.Text>
          <Typography.Text type="secondary">{formatClock(userPrompt.at)}</Typography.Text>
        </Flex>
        <MarkdownText text={userPrompt.text} />
      </Flex>
    </Card>
  );
}

export function AgentMessageTimeline(props: MessageTimelineProps): ReactNode {
  const { token } = theme.useToken();
  const registry = useBlockRenderers();
  // 默认分派是**注册表**（能吃到 Provider 的叠加）；传了 `renderBlock` 就用传入的（S5 换整套折叠策略）
  const fromRegistry = useMemo(() => blockRendererOf(registry), [registry]);
  const dispatch = props.renderBlock ?? fromRegistry;

  const rest: TurnRenderContext = { ...props, renderBlock: dispatch };

  return (
    <Flex vertical gap={token.marginMD} data-testid="agent-message-timeline">
      {props.userPrompt !== undefined && props.userPrompt !== null && <UserPromptBlock userPrompt={props.userPrompt} />}
      {/* 补充提示紧挨用户提示词之后：它们是「这一段内容为什么长这样」的说明，属于导航级信息 */}
      {props.notices?.map((notice, index) => (
        <Fragment key={index}>{notice}</Fragment>
      ))}
      {props.turns.map((turn, index) => (
        <Fragment key={turnKey(turn, index)}>{renderTurn(turn, index, rest)}</Fragment>
      ))}
    </Flex>
  );
}
