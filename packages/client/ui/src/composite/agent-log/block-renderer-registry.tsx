'use client';

/**
 * 块渲染注册表：**判别联合管类型，注册表管分派**——两者不互斥。
 *   · `RenderBlock` 的判别联合保证「每类块只有在自己那一支里字段可读」；
 *   · 注册表保证「新增一类块**不必改 timeline**」。
 *
 * 只有前者时穷尽性检查（`assertNever`）得写在 `agent-message-timeline` 里，
 * 于是加一个 arm 就要改它——「扩展零改动」当场失败。
 *
 * `DEFAULT_BLOCK_RENDERERS` 是**一张平表**：加一项不触碰别人的那一行。
 * 外部消费方连这张表都不用改：`BlockRendererProvider` 直接**叠加**（默认表 ⊕ Provider）。
 * 明确不提供「部分覆盖某一臂的内部」——注册表以 `kind` 为粒度，半个渲染器是自相矛盾的。
 */
import { createContext, useContext, useMemo, type ReactNode } from 'react';
import type { RenderBlock } from './render-blocks';
import { capabilityReasonOf, type MessageCapabilityMap } from './types';
import { AskUserCard } from './ask-user-card';
import { AttachmentBlockView } from './attachment-block-view';
import { RowSummaryLine } from './row-summary-line';
import { SubagentBar } from './subagent-bar';
import { TaskPanelCard } from './task-panel-card';
import { TextBlockView } from './text-block-view';
import { ThinkingBlockView } from './thinking-block-view';
import { ToolGroupPanel } from './tool-group-panel';
import { UnrecognizedBlockView } from './unrecognized-block-view';

/**
 * 块分派上下文。
 *
 * **刻意不提供「流式中」这个布尔**：再放一个 `streaming` 与块自己的 `assembly` 并存
 * ⇒ 组件层出现**第二个真值**，而 `assembly` 由数据层给、`streaming` 无人给，两者必然漂移
 * （表现是「块结束了动效还在转」）。需要动效的渲染件**自己读 `block.assembly`**。
 */
export interface BlockRenderContext {
  /** 折叠态是否打开（**受控**：折叠态住在 `useAgentLogView` 里，不住在组件树里） */
  open: boolean;
  onOpenChange(next: boolean): void;
  /**
   * 卡片底部「原始结果」二级抽屉的开合。**与 `open` 是同一份折叠态、不同后缀的键**
   * （键 = 块键 + `|raw`，由 L1 的 `contextOf` 拼）：它俩是两个独立的东西——卡片收起了、
   * 里面的抽屉照样可以开着，反之亦然。L0 只负责把这两格透传给 `RawOutputPanel`，
   * **自己不持态**（纪律 2 / `agent-log-layering.test.ts` (d)）。
   */
  rawOpen: boolean;
  onRawOpenChange(next: boolean): void;
  /**
   * 用户在工具组里点开某一行。`key` 是 `ToolItem.callId ?? ContentBlockBase.id`——
   * **不用数组下标**：轮次内容会随流式追加变长，下标会漂（「我展开的那条自己合上了」正是这么来的）。
   */
  openKeys?: ReadonlySet<string>;
  onEntryOpenChange?(key: string, open: boolean): void;
  /** 「进入子任务」（`subagent-bar` 上唯一有副作用的动作） */
  onEnterNode?(nodeId: string): void;
  /** 节点内容读失败时的重试（`source.retryNode` 的入口；不给时**不渲染**重试按钮） */
  onRetryNode?(nodeId: string): void;
  /** 「原始输出」面板展开时向数据层上报一次（`source.requestDiagnostics`） */
  onRequestDiagnostics?(): void;
  /**
   * 当前节点的**能力声明**。
   *
   * 为什么它必须在上下文里：`AgentRunStateTag` 的 `missingReason` 设计上就是「`capability` 给」，
   * 而缺了它这一格谁也够不到 ⇒ 三个调用点只能硬写 `null`，界面上恒是光秃秃的「结果未采集」——
   * 使用者知道没采到，却分不清「这家没投送」与「我们没接」（该去找厂商还是改我们自己）。
   *
   * **可选**：不给就退回那句光秃秃的文案（不编原因）。L0 只读它、不推断——
   * 拿不到原因时显示成「进行中」是另一条禁令（`running` 不由「有没有结果」推）。
   */
  capability?: MessageCapabilityMap;
}

/** 渲染器注册表：**九个臂齐全**（用映射类型写，漏一臂编译期就报错，比运行时的兜底更早） */
export type BlockRendererRegistry = {
  readonly [K in RenderBlock['kind']]: (
    block: Extract<RenderBlock, { kind: K }>,
    ctx: BlockRenderContext,
  ) => ReactNode;
};

/** 空集合常量：默认值不能每次渲染新建一个 `Set`（那会让下游的 `useMemo` 全部失效） */
const EMPTY_KEYS: ReadonlySet<string> = new Set<string>();

/**
 * 「结果未采集」的原因：**只认 `toolResult` 那一维**。
 *
 * 为什么是这一维：`AgentRunStateTag` 说的是「这次工具调用的结果没有」，而它对应的能力格
 * 就是 `toolResult`（契约里五维之一）。拿 `thinkingText` 或 `subagent` 的原因去解释工具结果，
 * 会把「子任务整块没采到」说成「它没有子任务」——两个不同的坑，修法也不同。
 * 三个调用点（工具组状态行、组内每一行、计划清单）共用这一处推导，不各判一次。
 */
function toolResultReasonOf(ctx: BlockRenderContext): string | null {
  return capabilityReasonOf(ctx.capability?.['toolResult']);
}

/** 默认那九臂（本仓的业务口径只住在这张表里） */
export const DEFAULT_BLOCK_RENDERERS: BlockRendererRegistry = {
  text: (block) => <TextBlockView block={block.block} />,
  thinking: (block, ctx) => (
    <ThinkingBlockView block={block.block} open={ctx.open} onOpenChange={ctx.onOpenChange} />
  ),
  'tool-group': (block, ctx) => (
    <ToolGroupPanel
      entries={block.entries}
      open={ctx.open}
      onOpenChange={ctx.onOpenChange}
      openEntries={ctx.openKeys ?? EMPTY_KEYS}
      onEntryOpenChange={ctx.onEntryOpenChange ?? (() => undefined)}
      onRequestDiagnostics={ctx.onRequestDiagnostics}
      missingReason={toolResultReasonOf(ctx)}
    />
  ),
  attachment: (block) => <AttachmentBlockView block={block.block} />,
  unrecognized: (block, ctx) => (
    <UnrecognizedBlockView block={block.block} open={ctx.open} onOpenChange={ctx.onOpenChange} />
  ),
  'subagent-bar': (block, ctx) => (
    <SubagentBar node={block.node} onEnter={ctx.onEnterNode} onRetry={ctx.onRetryNode} />
  ),
  'row-summary': (block) => <RowSummaryLine node={block.node} />,
  'task-panel': (block, ctx) => (
    <TaskPanelCard
      panel={block.panel}
      earlierCount={block.earlierCount}
      open={ctx.open}
      onOpenChange={ctx.onOpenChange}
      rawOpen={ctx.rawOpen}
      onRawOpenChange={ctx.onRawOpenChange}
      onRequestDiagnostics={ctx.onRequestDiagnostics}
      missingReason={toolResultReasonOf(ctx)}
    />
  ),
  'ask-user-card': (block, ctx) => (
    <AskUserCard
      interaction={block.interaction}
      open={ctx.open}
      onOpenChange={ctx.onOpenChange}
      rawOpen={ctx.rawOpen}
      onRawOpenChange={ctx.onRawOpenChange}
      onRequestDiagnostics={ctx.onRequestDiagnostics}
    />
  ),
};

/** 块分派：注册表与自定义策略的公共形状 */
export type BlockRenderer = (block: RenderBlock, ctx: BlockRenderContext) => ReactNode;

const RegistryContext = createContext<BlockRendererRegistry>(DEFAULT_BLOCK_RENDERERS);

export interface BlockRendererProviderProps {
  /** 只需给新增 / 覆盖的那几项 */
  renderers: Partial<BlockRendererRegistry>;
  children: ReactNode;
}

/**
 * 在默认表之上**叠加**。不提供「整体替换」：那会让「扩展一下就把默认渲染器弄丢了」，
 * 而那种缺陷在页面上表现为**大面积空白**、控制台只有一句 `undefined is not a function`，
 * 很容易被误判成数据没到。
 */
export function BlockRendererProvider({ renderers, children }: BlockRendererProviderProps): ReactNode {
  const parent = useContext(RegistryContext);
  const merged = useMemo<BlockRendererRegistry>(() => ({ ...parent, ...renderers }), [parent, renderers]);
  return <RegistryContext.Provider value={merged}>{children}</RegistryContext.Provider>;
}

/** 取合并后的表（默认表 ⊕ 最近的 Provider） */
export function useBlockRenderers(): BlockRendererRegistry {
  return useContext(RegistryContext);
}

/**
 * 把注册表包成 `MessageTimeline` 吃的那个 `renderBlock` 形状。
 * 放在这里而不是 timeline 里：timeline 不该知道「默认实现是注册表」这件事。
 */
export function blockRendererOf(registry: BlockRendererRegistry): BlockRenderer {
  return (block, ctx) => registry[block.kind](block as never, ctx);
}
