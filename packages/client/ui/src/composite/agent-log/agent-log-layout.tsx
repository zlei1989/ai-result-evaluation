'use client';

/**
 * 抽屉正文的一体化布局（L2）：固定区 + 滚动区 + 浮动件。**不套抽屉壳**——
 * 内嵌只读视图（S1）直接用这个件，几何口径不变，只是参照物从抽屉面板换成宿主容器。
 *
 * 八条口径：
 * 1. **最外层取满父容器的全部高度**（`height: '100%'`，不是 `minHeight`）：虚拟列表要有确定高度的视口
 * 才能算出「渲染哪几项」；滚动容器是时间轴自己，不是抽屉面板；
 * 2. **根节点显式声明 `color` / `background`**（硬要求）：宿主外层主题类名存在时，
 * 「靠继承拿颜色」的文字会变成近黑落在暗底上，而读 token 的组件不受影响——页面呈「组件正常、正文发黑」；
 * 3. **节点内容四态作用于时间轴区，不是整个抽屉**：固定区（进度条 / 面包屑 / 工具条）在任何一态下都在；
 * 4. **过滤在轮次级生效**（两个开关 AND），过滤不改面包屑与提示条的可见性（它们是导航，不是内容）；
 * 5. **跟随最新只有一份 state**：工具条开关、角落浮动按钮都读 `viewState.follow`；
 *    「读者是否还在活边」由 `Message Scroller` 判（`end` 变真 ⇒ 释放跟随），恢复只走显式动作。
 *    **未读仍是本仓的轮次水位**（`filtered.length - readCountRef.current`）：库没有未读数 API；
 * 6. **工具条动作是数据**：`actions` 传了就用传入的，不传用 `useAgentLogToolbarPreset` 的预设
 *    （这条守卫拦的是「预设盖掉调用方传进来的动作」：传了还读预设，工具条上会出现调用方没要的按钮）；
 * 7. **底部槽（`footer`）是第三段固定区**：它排在滚动区**之后**，故滚动区按它的高度**自动缩水**
 *    （`flex: 1` + `minHeight: 0` 已经保证了这一条，不需要额外改高度算术）。槽里**不加内边距**：
 *    占用它的件（消息输入区）自己那一层各段的内缩不同（排队行贴边、输入框内缩），
 *    在这里统一加一层 padding 会让它没法贴边。
 * 8. **浮动件（「回到最新」）住在滚动区的 Root 里**（不是根节点上）：定位基准因此是滚动区，而滚动区的
 *    高度已经扣掉了底部固定区 ⇒ 有没有 footer 都不必算高度差；它也不会压在 footer 里的输入区上
 *    （压在发送键上时点击会被它拦掉：症状是「那颗键点不动」）。
 */
import { ArrowDown } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Alert, AlertAction, AlertTitle } from '../../components/ui/alert';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Skeleton } from '../../components/ui/skeleton';
import { Switch } from '../../components/ui/switch';
import type {
  AgentLogDiagnostics,
  AgentEnvironment,
  AgentLogModel,
  AgentLogSource,
  Loadable,
  LogNode,
  LogNodeIndex,
  LogSegment,
  LogTurn,
  MessageCapabilityMap,
  RowEvent,
  SessionNode,
} from './types';
import { capabilityReasonOf } from './types';
import type { CheckpointCapability } from '@aieval/contracts';
import type { CheckpointTarget } from './checkpoint-marker';
import { nodeIndex } from './render-blocks';
import type { BlockRenderer } from './block-renderer-registry';
import { blockRendererOf, useBlockRenderers } from './block-renderer-registry';
import { AgentLogFactsBar } from './agent-log-facts-bar';
import { AgentLogDomainFacts } from './agent-log-domain-facts';
import { LogNodeBreadcrumb, nodeDisplayName } from './log-node-breadcrumb';
import { AgentEnvironmentDrawer } from './agent-environment-drawer';
import { RawOutputPanel, hasRawEntry } from './raw-output-panel';
import { EmptyState } from '../../base/empty-state';
import { useAgentLogView, type AgentLogFilters, type AgentLogViewState } from './use-agent-log-view';
import { useAgentLogToolbarPreset, type ToolbarAction } from './agent-log-toolbar-preset';
import { VirtualTurnList, type ListController } from './virtual-turn-list';
import { rowEventsOfTurn, turnKey } from './agent-message-timeline';
import { MessageScrollerButton } from '../../components/ui/message-scroller';
import { LogScroller, type LogScrollerCommands } from './log-scroller';

/** 空轮次常量：`content` 不是 `ready` 时统一给这一份（每次新建数组会让下游的 memo 全部失效） */
const EMPTY_TURNS: readonly LogTurn[] = [];

/** 空键集合常量：外置视图态时喂给内部 hook，让它跳过默认展开键的计算（同一条 memo 理由） */
const EMPTY_KEYS: ReadonlySet<string> = new Set<string>();

/** `timeline` 槽位收到的 props：**已经定好的分派函数 + 折叠态 + 轮次**，调用方不必自己重新拼一遍 */
export interface TimelineSlotProps {
  /** 当前节点的轮次（已过滤、已分组、未建渲染块） */
  turns: readonly LogTurn[];
  nodes: LogNodeIndex;
  /** 块分派（默认实现 = 注册表） */
  renderBlock: BlockRenderer;
  openKeys: ReadonlySet<string>;
  onOpenChange(key: string, open: boolean): void;
  rowEvents: readonly RowEvent[];
  userPrompt: SessionNode['userPrompt'];
  /** 段分隔（「追问 ×N」）画不画；由本件按 `node.kind` 定（见 `VirtualTurnListProps.segmentDividers`） */
  segmentDividers: boolean;
  /**
   * 段这一层的事实（`AgentLogModel.segments`）：段标题里的那句追问与这一段的时刻。
   * 只在主会话节点给——子会话节点不画段标题（见 `segmentDividers`）。
   */
  segments?: readonly LogSegment[];
  /**
   * 下面几格与 `MessageTimelineProps` 同源（补的是设计文档的 props 清单里没有、
   * 但 `BlockRenderContext` 明确要的几处）。全可选 ⇒ 只用文档里那几个字段的消费方照样可用。
   */
  notices?: readonly ReactNode[];
  onEnterNode?(nodeId: string): void;
  onRetryNode?(nodeId: string): void;
  onRequestDiagnostics?(): void;
  /**
   * 当前节点的能力声明：进 `BlockRenderContext`，供 `AgentRunStateTag` 说出
   * 「结果未采集 · **为什么**」。**取当前节点的那一份**（不是主会话的）：同一行的不同子任务
   * 采数通道可以不同（codex 迁移 app-server 前，子任务正文只在子线程会话文件里；今天唯一走 `session-file` 的是 claude 的子智能体用量），拿错节点就会说错原因。
   */
  capability?: MessageCapabilityMap;
  /** 轮末「回到这里」：能力声明与两个出口（见 `CheckpointMarker`） */
  checkpoint?: CheckpointCapability | null;
  onCheckpoint?(target: CheckpointTarget): void;
  checkpointAnchorOf?(target: CheckpointTarget): { keepAt: string; dropFrom: string | null } | null;
  /**
   * 滚动视口（Message Scroller 的 Viewport）。默认时间轴把它当 react-virtual 的滚动元素；
   * 自带时间轴（S1/S5）的槽位可以不用它——滚动本身仍由这一层的 `LogScroller` 负责。
   */
  scrollElementRef?: RefObject<HTMLElement | null>;
}

export interface AgentLogLayoutProps {
  model: AgentLogModel;
  environment?: Loadable<AgentEnvironment>;
  diagnostics?: Loadable<AgentLogDiagnostics>;
  source?: AgentLogSource;
  onDownload?(): void;
  /** 工具条动作：不传 = 用预设 */
  actions?: readonly ToolbarAction[];
  /** 时间轴槽位：不传 = `VirtualTurnList`（虚拟滚动）；传函数拿到的是已经定好的那一套 props */
  timeline?: ReactNode | ((props: TimelineSlotProps) => ReactNode);
  /**
   * 轮末「回到某一轮」的能力声明与两个出口（可选）。不传 = 不画这一格——
   * 与 `capability` 同一条「不编一份都支持」的口径。
   */
  checkpoint?: CheckpointCapability | null;
  onCheckpoint?(target: CheckpointTarget): void;
  checkpointAnchorOf?(target: CheckpointTarget): { keepAt: string; dropFrom: string | null } | null;
  /** 视图态外置（S5）：不传则由本件内部用 `useAgentLogView` */
  viewState?: AgentLogViewState;
  /**
   * 非破坏性提示（如「日志可能不完整：<原因>」）：手上还有真数据、但内容可能不全时如实说明。
   * **不藏起来**——「可能不完整」与「读失败」是两件事，后者整段替换抽屉内容（页面层的口径）。
   */
  notice?: ReactNode;
  /** 实时通道故障的一句话（断线 / 环境不支持 EventSource / 坏帧）。与 `notice` 分开：**前者说通道，后者说内容** */
  liveError?: ReactNode;
  /**
   * 实时通道是否连着；**不给就不渲染那一格**（不假装在实时，也不把「没有这个信息」说成「未连接」）。
   * 那一格落在**原文行**的最左侧（与「原始输出 N 条」合并成一行省空间）。
   */
  connected?: boolean;
  /**
   * 这一行是否已经收场（终态）。
   *
   * 终态行没有实时流是**正常的**，与运行中断线是两件事：同一个「未连接」在三处出现时，
   * 读的人分不清「跑完了」与「通道挂了」。传 `true` 时文案改成「已结束」，不再与「通道挂了」共用一个说法。
   * 不传按「不知道」处理，文案保持中性的「未连接」。
   */
  settled?: boolean;
  /**
   * 底部槽：排在滚动区之后的第三段固定区（本仓放消息输入区）。
   * 不给就**一个节点都不渲染**（不留空位、不动高度）——那是「这一行不收人工消息」的如实表达。
   */
  footer?: ReactNode;
  /**
   * 本视图是否在前台（默认 `true`）。不住在页签里的宿主不必传。
   *
   * 传 `false` 时把内部二级层（环境信息）收起来：页签切走后日志面板只是 `hidden`，
   * 而环境抽屉走 portal，仍会浮在别的页签之上。只在**切走**这一刻关，不动用户的开合偏好
   * 之外的任何状态（滚动位置、折叠态都不受影响）。
   */
  active?: boolean;
}

/** 当前视图的节点：找不到（模型换了）时回落到主会话，再回落到第一个节点 */
function nodeOf(model: AgentLogModel, nodeId: string): LogNode | undefined {
  return (
    model.nodes.find((node) => node.id === nodeId) ??
    model.nodes.find((node) => node.kind === 'main') ??
    model.nodes[0]
  );
}

/** 节点的轮次：只有 `ready` 才是一个真读数（`loading` / `error` 都不是「零轮」） */
function readyTurnsOf(node: LogNode | undefined): readonly LogTurn[] {
  return node !== undefined && node.content.status === 'ready' ? node.content.data : EMPTY_TURNS;
}

/** 会话节点的用户提示词（行级汇总节点没有这一格） */
function userPromptOf(node: LogNode | undefined): SessionNode['userPrompt'] {
  return node !== undefined && node.kind !== 'row' ? node.userPrompt : null;
}

/** `Loadable` 的 `error` 是 `unknown`：能给一句人话就给，给不出就如实说「未知错误」 */
function errorText(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  return '未知错误';
}

/** 提示位有没有内容：`undefined` / `null` / `false` 都算「不传」，**不留空位** */
function hasNotice(node: ReactNode): boolean {
  return node !== undefined && node !== null && node !== false;
}

/**
 * 非破坏性提示的三种语气（信息 / 警告 / 错误）。
 *
 * 统一走 vendored `Alert`：`role="alert"` 与版式由它给，颜色只引语义变量，
 * 不在这里另写一套提示条（同一屏两套边框与间距的漂移是静默的）。
 */
function InfoNotice({ children }: { children: ReactNode }): ReactNode {
  return (
    <Alert className="border-info/40 bg-info/5">
      <AlertTitle className="text-info">{children}</AlertTitle>
    </Alert>
  );
}

function WarningNotice({ children }: { children: ReactNode }): ReactNode {
  return (
    <Alert className="border-warning/40 bg-warning/5">
      <AlertTitle className="text-warning">{children}</AlertTitle>
    </Alert>
  );
}

/**
 * 「等待答复」的判据：当前节点的块里存在 `pending && running` 的问答卡片，取它的 `at`。
 * **纯派生**（不新增契约字段、也不进 `rowEvents`）：它是当前态，不是发生过的事件。
 */
export function waitingSinceOf(turns: readonly LogTurn[]): string | null {
  for (const turn of turns) {
    for (const block of turn.blocks) {
      if (block.kind !== 'tool-call') continue;
      const payload = block.tool;
      if (payload === null || payload.family !== 'ask-user') continue;
      if (payload.interaction.state === 'pending' && payload.interaction.running) return payload.interaction.at;
    }
  }
  return null;
}

/** 「这一类内容没被转发」的判据：一个 `role === 'assistant'` 的正文 / 思考块都没有 */
function hasAssistantText(turns: readonly LogTurn[]): boolean {
  return turns.some((turn) =>
    turn.blocks.some((block) => block.role === 'assistant' && (block.kind === 'text' || block.kind === 'thinking')),
  );
}

/** 有工具块（工具调用或工具结果）——「有内容但没对话」的那一档必须有它才说得通 */
function hasToolBlocks(turns: readonly LogTurn[]): boolean {
  return turns.some((turn) => turn.blocks.some((block) => block.kind === 'tool-call' || block.kind === 'tool-result'));
}

/**
 * 第二、三种「空」的提示条。三段文案各有判据，**互不替代**：
 *   ① 能力声明说子任务轨迹拿不到 ⇒ 把**原因**带上（原因是 `MissingReason` 四态，四句互不相同）；
 *   ② 内容来自会话文件、而这一行还没结束 ⇒ 说明「完整轨迹要等运行结束」；
 *   ③ 其余 ⇒「该子任务的对话未转发（只投送了工具调用）」，**不写「它什么都没说」**。
 *
 * 原因那一格走 `MISSING_REASON_LABELS`（**不是**拿能力等级去索引它——两套词汇不同，
 * 对照表在 `types.ts` 的 `CAPABILITY_TO_MISSING_REASON`）：契约的配对不变量保证
 * `level !== 'yes'` 时 `reason` 非空，真拿到 `null` 时退回**等级自己的文案**，不留半句话。
 */
export function notForwardedNotice(node: LogNode, turns: readonly LogTurn[]): ReactNode | null {
  if (!hasToolBlocks(turns) || hasAssistantText(turns)) return null;

  // 原因那一格与工具卡片的「结果未采集 · 原因」走**同一个函数**（`capabilityReasonOf`）：
  // 两处各判一次的话，同一个能力维度在两句话里可能给出不同答案
  const reason = capabilityReasonOf(node.capability['subagent']);
  if (reason !== null) return <InfoNotice>{`子任务轨迹不可用 · ${reason}`}</InfoNotice>;
  if (node.kind !== 'row' && node.source === 'session-file' && node.endedAt === null) {
    return <InfoNotice>运行期只有派发事件与状态，完整轨迹要等运行结束</InfoNotice>;
  }
  return <InfoNotice>该子任务的对话未转发（只投送了工具调用）</InfoNotice>;
}

/**
 * **子任务节点的空态**（`turns.length === 0` 且内容已就绪）：一句「为什么这里没有内容」+ 一条退路。
 *
 * 为什么不能沿用行级那句「这一行还没开始执行，或执行尚未产生输出」：站在子任务上时那一行
 * **可能已经跑完**（真机实测：主会话 7 轮、子任务记录齐备、`outcome` 非空），
 * 那句话会被读成「界面坏了」。这里说的是这个子任务自己的事实。
 *
 * 三句**互不替代**，按「这个子任务现在是什么状态」分：
 *   · 有 `outcome` ⇒ 内容**在**，只是不在轨迹里（它是另一条通道：适配器从子任务收场载荷里取）
 * ⇒ 文案直接指向那条占位条，别让读者以为「什么都没采到」；
 *   · **运行中**（且连结果摘要都还没有）⇒ 它还在跑，正文只是还没到
 * ——说成「没有对话记录」会被读成「这家不投送」，而事实是「再等等」；
 *   · 其余（终态且没有 `outcome`）⇒ 连结果摘要都没有，这时才说「轨迹不可用」并带上能力声明里的
 * 原因（四句原因互不相同，见；`level === 'yes'` 时原因那格没意义，只陈述事实）。
 */
function subagentEmptyState(node: SessionNode): ReactNode {
  const name = nodeDisplayName(node);
  // 与上面那条提示条、以及工具卡片的「结果未采集 · 原因」共用同一处推导
  const reason = capabilityReasonOf(node.capability['subagent']);
  if (node.outcome !== null) {
    return (
      <EmptyState
        title="这个子任务没有逐条对话记录"
        description={`${name} 的轨迹为空：这一家没有把它自己的往返投送到我们能读的通道。它的结果摘要与用量在上面那条子任务占位条里。`}
      />
    );
  }
  if (node.status === 'running') {
    return (
      <EmptyState
        title="这个子任务还在跑"
        description={`${name} 的逐步骤正文还没到：这一家可能在收尾时才把它交出来。卡片上那一格的身份、状态与用量不受影响。`}
      />
    );
  }
  return (
    <EmptyState
      title="这个子任务没有对话记录"
      description={
        reason === null
          ? `${name} 的轨迹为空：记录里没有归属到它的消息。`
          : `${name} 的轨迹不可用 · ${reason}。`
      }
    />
  );
}

/**
 * 一轮有没有「工具调用」类的块（`onlyTools` 的判据）。
 *
 * 语义与 `render-blocks.ts` 的 `hasToolCall` 相同（两族卡片本来就是 `tool-call` 块，
 * 配不上调用的 `tool-result` 也会成组），**但故意不建渲染块**：过滤是**全轮扫描**，
 * 在渲染层外面为每一轮建一次渲染块正是明令禁止的那件事（虚拟滚动就只省了 DOM）。
 */
function turnHasToolCall(turn: LogTurn): boolean {
  return turn.blocks.some((block) => block.kind === 'tool-call' || block.kind === 'tool-result');
}

/**
 * 一轮有没有**数据给的**失败（`onlyErrors` 的判据）。只认四类，**不按 `outcome` 猜**：
 *   · `tool-result.status === 'error'`（工具结果块自己说的）；
 *   · 问答卡片收场成 `unavailable` / `rejected`（本仓已知边界与「子智能体不能提问」）；
 *   · 挂在它后面的行级事件的 `level === 'error'`。
 * `timeout` / `skipped` / `canceled` 算不算失败由厂商的结果定，UI 不替它判断。
 */
export function turnHasError(turn: LogTurn, events: readonly RowEvent[]): boolean {
  if (events.some((event) => event.level === 'error')) return true;
  return turn.blocks.some((block) => {
    if (block.kind === 'tool-result') return block.status === 'error';
    if (block.kind !== 'tool-call') return false;
    const payload = block.tool;
    if (payload === null || payload.family !== 'ask-user') return false;
    const interaction = payload.interaction;
    if (interaction.state !== 'settled') return false;
    return interaction.outcome === 'unavailable' || interaction.outcome === 'rejected';
  });
}

/** 一轮是否命中过滤（两个开关 **AND**：都开时两个条件都要满足） */
export function turnMatchesFilters(turn: LogTurn, events: readonly RowEvent[], filters: AgentLogFilters): boolean {
  if (filters.onlyTools && !turnHasToolCall(turn)) return false;
  if (filters.onlyErrors && !turnHasError(turn, events)) return false;
  return true;
}

/**
 * 轮次级过滤：不含目标块的轮次**整轮隐藏**（否则会得到一屏「轮次 12（空）」的噪声）。
 * 两个开关都没开时**原样返回**：不做任何扫描（这是内循环里最常走的那条路）。
 */
export function filterTurns(
  turns: readonly LogTurn[],
  rowEvents: readonly RowEvent[],
  filters: AgentLogFilters,
): readonly LogTurn[] {
  if (!filters.onlyTools && !filters.onlyErrors) return turns;
  return turns.filter((turn, index) => turnMatchesFilters(turn, rowEventsOfTurn(turns, rowEvents, index), filters));
}

/** 工具条：逐个动作渲染。`visible === false` 的不渲染；只承载数据的动作也不渲染（见下方注释） */
function ToolbarActions({
  actions,
  numberDraft,
  onNumberDraft,
  onNumberCommit,
}: {
  actions: readonly ToolbarAction[];
  numberDraft: number | null;
  onNumberDraft(next: number | null): void;
  onNumberCommit(action: ToolbarAction & { number: NonNullable<ToolbarAction['number']> }): void;
}): ReactNode {
  return (
    <div className="flex flex-wrap items-center gap-snug">
      {actions.map((action) => {
        if (action.visible === false) return null;

        if (action.toggle !== undefined) {
          return (
            <div key={action.key} className="flex items-center gap-hair">
              {/* `aria-label` 与文案同名：开关没有可访问名时屏读器只会念「开关」 */}
              <Switch
                size="sm"
                checked={action.toggle.checked}
                onCheckedChange={action.toggle.onChange}
                disabled={action.disabled}
                aria-label={action.label}
              />
              <span className="text-body">{action.label}</span>
            </div>
          );
        }

        if (action.number !== undefined) {
          const number = action.number;
          return (
            <div key={action.key} className="flex items-center gap-hair">
              <span className="text-body">{action.label}</span>
              <input
                type="number"
                className="h-6 w-16 rounded-md border border-input bg-background px-1.5 text-xs text-foreground"
                min={number.min}
                max={number.max}
                value={numberDraft ?? number.value}
                disabled={action.disabled}
                aria-label={action.label}
                onChange={(event) => onNumberDraft(event.target.value === '' ? null : Number(event.target.value))}
                // 回车 / 失焦即跳；越界在提交时 clamp，回显值由动作数据给
                onKeyDown={(event) => {
                  if (event.key === 'Enter') onNumberCommit({ ...action, number });
                }}
                onBlur={() => onNumberCommit({ ...action, number })}
              />
            </div>
          );
        }

        // 纯图标按钮：`aria-label` 与原生 `title` 都写 label（「？环境信息」是唯一一处）
        if (action.icon !== undefined) {
          return (
            <Button
              key={action.key}
              variant="ghost"
              size="icon-sm"
              aria-label={action.label}
              title={action.label}
              disabled={action.disabled}
              onClick={action.onSelect}
            >
              {action.icon}
            </Button>
          );
        }

        // **只承载数据的动作不渲染控件**：既没有形态（toggle / number / icon）也没有回调的动作
        // 没有可点的东西，它的 `label` / `visible` 归对应的面板（「原始输出 N 条」就是这样一格，
        // 正文在固定区的 `RawOutputPanel` 里）。渲染一个点不动的按钮等于给同一件事开第二个入口。
        if (action.onSelect === undefined) return null;

        return (
          <Button key={action.key} size="xs" variant="outline" disabled={action.disabled} onClick={action.onSelect}>
            {action.label}
          </Button>
        );
      })}
    </div>
  );
}

export function AgentLogLayout(props: AgentLogLayoutProps): ReactNode {
  const { model, environment, diagnostics, source, onDownload, actions, timeline, notice, liveError, connected, settled = false, footer } = props;

  const nodes = useMemo(() => nodeIndex(model.nodes), [model.nodes]);
  // 视图态：不传就内部持一份。**hook 无条件调用**（不能在条件分支里少调一个 hook），
  // 但外置时内部那份 state 没有任何消费者 ⇒ 连默认展开键都不必算
  // （`defaultOpenKeysOf` 是 O(轮次) 的，白算一遍就是每个数据更新都多跑一趟）。
  const internalViewState = useAgentLogView(
    props.viewState === undefined ? { model } : { model, defaultOpenKeys: EMPTY_KEYS },
  );
  const viewState = props.viewState ?? internalViewState;

  /**
   * 页签切走时收起环境信息：面板只是 `hidden`，而环境抽屉是 portal（不受 `display:none`
   * 影响），不收入会浮在别的页签上。只在「变成非前台」这一刻关，用户切回来看到的是原样。
   */
  const active = props.active ?? true;
  useEffect(() => {
    if (!active) viewState.setEnvironmentOpen(false);
  }, [active, viewState.setEnvironmentOpen]);

  const node = nodeOf(model, viewState.activeNodeId);
  const content = node?.content;
  const turns = readyTurnsOf(node);
  const filtered = useMemo(() => filterTurns(turns, model.rowEvents, viewState.filters), [turns, model.rowEvents, viewState.filters]);
  const filtersActive = viewState.filters.onlyTools || viewState.filters.onlyErrors;
  const waitingSince = useMemo(() => waitingSinceOf(turns), [turns]);
  // 提示条按**未过滤**的轮次算：过滤不影响它的可见性（它是导航级信息，不是内容）
  const notForwarded = useMemo(() => (node === undefined ? null : notForwardedNotice(node, turns)), [node, turns]);

  const registry = useBlockRenderers();
  const defaultRenderer = useMemo(() => blockRendererOf(registry), [registry]);
  const controllerRef = useRef<ListController | null>(null);

  /**
   * 「已渲染 N / 共 M 轮」：**由 `VirtualTurnList` 报上来**（那里才数得到），
   * 渲在**固定区原文行的「下载台账」后面**（用户口径）。`null` = 还没有时间轴（或时间轴是调用方自带的），
   * 那时这一格不出现——数的东西都不在，就不该有读数。
   */
  const [renderedTurns, setRenderedTurns] = useState<{ shown: number; total: number } | null>(null);
  const [rawOpen, setRawOpen] = useState(false);
  /** 「跳到轮次」的输入草稿：非空表示用户正在输入，提交后回落到动作数据里的回显值 */
  const [numberDraft, setNumberDraft] = useState<number | null>(null);
  /** 最近一次跳到的轮次（1 基）；`null` = 还在看最新 */
  const [jumpTarget, setJumpTarget] = useState<number | null>(null);

  // ——— 折叠态：默认展开键由 `defaultOpenKeysOf` 算（住在 hook 里，故这里不重复算一遍）———

  // ——— 跟随最新（库判活边，本仓只留一份状态）———
  /**
   * 已读水位：跟随期间的轮次数。用户上翻后它冻住。
   *
   * **未读 = `filtered.length - readCountRef.current`**：Message Scroller 没有未读数 API，
   * 这个「N 轮未读」是本仓的派生（轮次水位），不随跟随机制一起交出去。
   */
  const readCountRef = useRef(filtered.length);
  /** 滚动区命令（回到最新 / 滚到某轮）：由 `LogScroller` 内部的库串起来 */
  const scrollerRef = useRef<LogScrollerCommands | null>(null);
  /** 滚动视口：默认时间轴用它当 react-virtual 的滚动元素 */
  const viewportRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (viewState.follow) readCountRef.current = filtered.length;
  }, [viewState.follow, filtered.length]);

  /**
   * 库判「下方还有内容」⇒ 读者已离开活边：释放跟随。
   * **只往释放方向改**（恢复一律由显式动作触发），这样工具条开关与库的判定不会互相打架。
   */
  const handleReleaseFollow = useCallback((): void => {
    viewState.setFollow(false);
  }, [viewState.setFollow]);

  const backToLatest = useCallback((): void => {
    // 只打开跟随：滚到底由 `LogScroller` 在 Provider 拿到新的 autoScroll 之后调库的 scrollToEnd
    viewState.setFollow(true);
  }, [viewState.setFollow]);

  const unread = viewState.follow ? 0 : Math.max(filtered.length - readCountRef.current, 0);

  // ——— 工具条 ———
  const presetInput = {
    diagnostics,
    environment,
    turnCount: turns.length,
    currentTurn: jumpTarget ?? Math.max(turns.length, 1),
    viewState,
    onDownload,
    onJumpToTurn: (next: number) => {
      setJumpTarget(next);
      const turn = filtered[next - 1];
      // 越界（轮次被流式追加/回退掉）时什么都不做
      if (turn === undefined) return;
      // 先让虚拟列表把目标行挂上（react-virtual 只挂可见行），再让库按消息 id 精确对齐：
      // 目标行还没挂上时库会挂 pending，在该行挂载后补一次（虚拟化下这是唯一可靠的两步）
      controllerRef.current?.scrollToTurn(next - 1, 'top');
      scrollerRef.current?.scrollToMessage(turnKey(turn, next - 1), { align: 'start' });
    },
    onOpenEnvironment: () => {
      viewState.setEnvironmentOpen(true);
      // 每次打开都喊一声：要不要真去取、走不走缓存是数据层的判断（组件不实现这层缓存）
      source?.requestEnvironment?.();
    },
  };
  const presetActions = useAgentLogToolbarPreset(presetInput);
  const allActions = actions ?? presetActions;
  /**
   * 动作按 `placement` 分两行渲染（渲法完全一样，只是归到不同的行）：
   *   · `toolbar`（默认）⇒ 面包屑那一行的轮次级动作；
   *   · `raw` ⇒ 固定区的**原文行**，紧挨着「原始输出 N 条」（「下载台账」就是这一格）。
   * 两份 memo 挂在 `allActions` 上：预设那份本来就有记忆化，调用方自带的数组则原样透传。
   */
  const toolbarActions = useMemo(() => allActions.filter((action) => action.placement !== 'raw'), [allActions]);
  const rawRowActions = useMemo(() => allActions.filter((action) => action.placement === 'raw'), [allActions]);

  /**
   * 原文行渲不渲染：**有连接状态**（它住这一行），或这一行上有要渲的动作（`visible !== false`），
   * 或**有原文入口**。
   *
   * 「有没有原文」这一条取自 `RawOutputPanel` 的 `hasRawEntry`——两处各写一遍必然漂移，
   * 而漂移的症状是「原文 0 条时下载按钮上面多一条空隙」。
   * 「有连接状态」这一条必须算进去：连接徽标住这一行，漏了它，
   * 「实时通道通不通」会随原文入口一起消失——那不是收起了版面，是丢了一个读数。
   */
  const rawRowVisible =
    connected !== undefined ||
    // 有读数就画：虚拟列表报了数却因为「三样都没有」把整行收掉，那一格读数就永远看不见
    renderedTurns !== null ||
    rawRowActions.some((action) => action.visible !== false) ||
    (diagnostics !== undefined &&
      diagnostics.status === 'ready' &&
      hasRawEntry({ kind: 'diagnostics', diagnostics: diagnostics.data }));

  const commitNumber = useCallback(
    (action: ToolbarAction & { number: NonNullable<ToolbarAction['number']> }): void => {
      const draft = numberDraft ?? action.number.value;
      // 越界 clamp 并**如实回显** clamp 后的值（不让输入框显示一个没跳到的数）
      const clamped = Math.min(Math.max(Math.round(draft), action.number.min), action.number.max);
      action.number.onSubmit(clamped);
      setNumberDraft(null);
    },
    [numberDraft],
  );

  const handleRawOpenChange = useCallback(
    (next: boolean): void => {
      setRawOpen(next);
      // 展开时才向数据层上报一次「我需要了」（面板默认收起，只有展开时才需要）
      if (next) source?.requestDiagnostics?.();
    },
    [source],
  );

  /**
   * 首条那张卡片的两格（题面）。**先取进常量**：时间轴槽位的 props 与空态判据都用它，
   * 两边各调一次 `userPromptOf` 会在源码里读成「两个来源」。
   */
  const userPrompt = userPromptOf(node);
  const timelineProps: TimelineSlotProps = {
    turns: filtered,
    nodes,
    renderBlock: defaultRenderer,
    openKeys: viewState.openKeys,
    onOpenChange: viewState.onOpenChange,
    rowEvents: model.rowEvents,
    userPrompt,
    notices: notForwarded === null ? undefined : [notForwarded],
    // 段分隔（「追问 ×N」）只在主会话节点画：子会话节点里的轮次属于那个子任务自己，
    // 没有人对它追问过——在那里画一行是把父会话的动作安到它头上
    segmentDividers: node === undefined || node.kind === 'main',
    // 段标题的内容（那句追问 + 这一段的时刻）来自**段这一层**的数据，与「画不画」分开：
    // 子会话节点不画标题，故也不必把它带下去
    ...(node === undefined || node.kind === 'main' ? { segments: model.segments } : {}),
    onEnterNode: viewState.setActiveNodeId,
    onRetryNode: source?.retryNode === undefined ? undefined : (nodeId: string) => source.retryNode?.(nodeId),
    onRequestDiagnostics: source?.requestDiagnostics === undefined ? undefined : () => source.requestDiagnostics?.(),
    // 能力声明随节点走：它决定工具/清单卡片上那句「结果未采集 · 为什么」
    capability: node?.capability,
    checkpoint: props.checkpoint,
    onCheckpoint: props.onCheckpoint,
    checkpointAnchorOf: props.checkpointAnchorOf,
    // 滚动视口交给默认时间轴：虚拟化要拿它当 react-virtual 的滚动元素
    scrollElementRef: viewportRef,
  };

  /** 时间轴区的内容：四态各有一幅画面（**不是整个抽屉**，固定区在任何一态下都在） */
  const timelineArea = ((): ReactNode => {
    /**
     * 节点级空态**排在模型级空态之前**。
     *
     * 为什么顺序重要：站在子任务节点上时 `model.empty` 与 `turns.length === 0` 会**同时成立**
     * （整行只有主会话的内容），于是那一档若落到模型级空态，会显示
     * 「还没有日志 · **这一行还没开始执行**，或执行尚未产生输出」——而这一行明明跑完了，
     * 站在子任务上的读者会把它读成「界面坏了」。两句文案说的是两件不同的事：
     *   · 节点级：**这个子任务**的内容没到这里（不是这一行没跑）；
     *   · 模型级：**整行**都还没有内容（还没跑、或跑了但一条内容都没产出）。
     * 主会话节点上两者是同一件事，故只有子任务要分开说。
     */
    if (node !== undefined && node.kind === 'subagent' && (content === undefined || content.status === 'loading')) {
      // 「内容未到」给 Skeleton，**不是空态**：空态会被读成「这个子任务什么都没做」
      return <Skeleton className="h-24 w-full" />;
    }
    if (node !== undefined && node.kind === 'subagent' && content?.status === 'ready' && turns.length === 0) {
      return subagentEmptyState(node);
    }
    if (model.empty) {
      // ① 还没跑过：空态（不是渲染一个空时间轴——那会被读成「界面没渲染出来」）
      return <EmptyState title="还没有日志" description="这一行还没开始执行，或执行尚未产生输出" />;
    }
    if (content === undefined || content.status === 'loading') {
      return <Skeleton className="h-24 w-full" />;
    }
    if (content.status === 'error') {
      return (
        <div className="flex flex-col items-start gap-snug">
          {/* 原因如实显示（与调用方给的中文原因同源），不是一句「出错了」 */}
          <Alert variant="destructive" className="w-full">
            <AlertTitle>节点内容读取失败</AlertTitle>
            <AlertAction>
              {/* 不给 `retryNode` 就只渲染提示、**不渲染按钮**：一个点了没反应的按钮比没有按钮更糟 */}
              {source?.retryNode !== undefined && (
                <Button size="xs" variant="outline" onClick={() => source.retryNode?.(node?.id ?? '')}>
                  重试
                </Button>
              )}
            </AlertAction>
            <div className="col-start-2 text-sm text-muted-foreground">{errorText(content.error)}</div>
          </Alert>
        </div>
      );
    }
    /**
     * 主会话**只有题面、还没有任何轮次**时**不是空态**：首条那张「考题提示词」卡片就是要画的东西。
     * 判据取「有没有题面」而不是「有没有轮次」——题面是资料、轮次是产出，一行刚发起时前者已经有了。
     * 少了这半条，一行刚点完「开始」打开抽屉会看到「还没有日志 · 这一行还没开始执行」，
     * 而它明明已经在跑、题面也已经交出去了。
     */
    if (turns.length === 0 && userPrompt === null) {
      return <EmptyState title="还没有日志" description="这一行还没开始执行，或执行尚未产生输出" />;
    }
    if (filtersActive && filtered.length === 0 && turns.length > 0) {
      return <span className="text-sub text-muted-foreground">没有命中过滤的轮次</span>;
    }
    if (typeof timeline === 'function') return timeline(timelineProps);
    if (timeline !== undefined) return timeline;
    return (
      <VirtualTurnList
        {...timelineProps}
        controllerRef={controllerRef}
        onRenderedChange={(shown, total) => setRenderedTurns({ shown, total })}
      />
    );
  })();

  return (
    // ⚠️ 颜色与背景必须写在**自己的根节点**上：宿主外层主题类名存在时，
    // 靠继承拿颜色的文字会变成近黑落在暗底上，而读 token 的组件不受影响
    <div
      data-testid="agent-log-layout"
      className="relative flex h-full flex-col bg-background text-foreground"
    >
      {/* ① 固定区（不滚、不可折叠）：事实进度条 + 面包屑 + 工具条 + 原始输出 */}
      <div className="flex flex-col gap-hair border-b border-border px-roomy py-snug">
        {/* 两类非破坏性提示放在固定区最上面（有数据时才出现的**额外**行，不挤进事实条那一行） */}
        {hasNotice(notice) && (
          <div data-testid="agent-log-notice">
            <WarningNotice>{notice}</WarningNotice>
          </div>
        )}
        {hasNotice(liveError) && (
          <div data-testid="agent-log-live-error">
            <WarningNotice>{liveError}</WarningNotice>
          </div>
        )}

        {/* 事实条 + 领域事实**两行**：前者讲「这一行跑了什么」
            （状态 / 轮次 / 用量 / 耗时 / 错误），后者讲「这一行是谁在跑、改了什么、得了多少分」
            （智能体 · 模型 · 思考强度 · 改动 · 评分）。**分行是硬要求**：并回一行时靠 `wrap`
            自然折行，「改动 / 评分」会被甩到第二行、与前三格拆散。
            连接状态不在这两行里——它挪去了下面的原文行（见 `rawRowVisible` 的注释） */}
        <AgentLogFactsBar
          facts={model.facts}
          waitingSince={waitingSince}
          contentTruncatedReason={node?.contentTruncatedReason ?? null}
        />
        <AgentLogDomainFacts domain={model.facts.domain} />
        <div className="flex flex-wrap items-center gap-snug">
          <LogNodeBreadcrumb nodes={model.nodes} activeNodeId={viewState.activeNodeId} onSelect={viewState.setActiveNodeId} />
          <ToolbarActions
            actions={toolbarActions}
            numberDraft={numberDraft}
            onNumberDraft={setNumberDraft}
            onNumberCommit={commitNumber}
          />
          {/* 过滤生效时才显示命中数：它回答「我筛掉了多少」，没过滤时这个数是废话 */}
          {filtersActive && (
            <span className="text-sub text-muted-foreground">
              命中 {filtered.length} / {turns.length} 轮
            </span>
          )}
        </div>

        {/* 原始输出（诊断变体）：三态各有画面（`RawOutputPanel` 只画 ready 态，其余由本件决定） */}
        {diagnostics !== undefined && diagnostics.status === 'loading' && <Skeleton className="h-5 w-full" />}
        {diagnostics !== undefined && diagnostics.status === 'error' && (
          <Alert variant="destructive">
            <AlertTitle>原始输出读取失败</AlertTitle>
            {source?.requestDiagnostics !== undefined && (
              <AlertAction>
                <Button size="xs" variant="outline" onClick={() => source.requestDiagnostics?.()}>
                  重试
                </Button>
              </AlertAction>
            )}
          </Alert>
        )}
        {/*
          原文行：连接状态 + 「原始输出 N 条」+ 挂在这一行上的动作（`placement: 'raw'`，预设里是「下载台账」）。
          整行渲不渲染由 `rawRowVisible` 判：**三样都没有时不画**，否则固定区会多出一段空 gap。
          `ToolbarActions` 与工具条那一行是同一个件——两行的渲法不该有两份实现。
        */}
        {rawRowVisible && (
          <div className="flex flex-wrap items-center gap-snug">
            {/*
              连接状态在这一行的**最左侧**（与「原始输出 N 条」合并成一行省空间）。
              状态点只在 `connected` 时按 processing 上色；断线是中性点——processing 的动效
              是「真的在流」的信号，不能在断线时留着。
              **只在传了 `connected` 时**渲染这一格（不传就是「这一行没有实时通道」这个事实，不编一个「未连接」）
            */}
            {connected !== undefined && (
              <span
                data-testid="agent-log-connection"
                data-status={connected ? 'processing' : settled ? 'settled' : 'default'}
                className="inline-flex items-center gap-hair text-sub text-muted-foreground"
              >
                <span
                  aria-hidden
                  className={`size-1.5 shrink-0 rounded-full ${connected ? 'animate-pulse bg-success' : 'bg-faint-foreground'}`}
                />
                {connected ? '实时连接中' : settled ? '已结束' : '未连接'}
              </span>
            )}
            {diagnostics !== undefined && diagnostics.status === 'ready' && (
              <RawOutputPanel
                source={{ kind: 'diagnostics', diagnostics: diagnostics.data }}
                open={rawOpen}
                onOpenChange={handleRawOpenChange}
                onRetry={source?.requestDiagnostics}
              />
            )}
            <ToolbarActions
              actions={rawRowActions}
              numberDraft={numberDraft}
              onNumberDraft={setNumberDraft}
              onNumberCommit={commitNumber}
            />
            {/* 虚拟列表的读数：住「下载台账」**后面**——它是同一个问题的另一半：
                「原文在哪儿下载」与「这一屏画了几轮」一起构成这一行的自检信息 */}
            {renderedTurns !== null && (
              <span className="text-sub text-muted-foreground">
                已渲染 {renderedTurns.shown} / 共 {renderedTurns.total} 轮
              </span>
            )}
          </div>
        )}
      </div>

      {/*
        ② 滚动区：`Message Scroller` 的 Viewport（取满剩余高度）。
        跟随（读者在活边才追新）、上翻释放、滚回最新、滚到某轮都在这一层；
        **滚动区不给自己留内边距**：日志正文贴到抽屉左右边缘，横向空间全给内容。

        浮出按钮住在 Root 里、Viewport 之后：`position: absolute` 量的是 Root，而 Root 的高度
        已经扣掉了底部固定区（footer 在它后面、被 flex 拿去自己的高度）⇒ 有没有 footer 都不必算
        高度差，按钮也不会压在输入区那颗发送键上（压在它上面时点击会被拦截，症状是「发送键点不动」）。
        可点态由库给（无可滚方向时它 `inert` + `data-active="false"`）：本件只在「不跟随」时挂上它。
      */}
      <LogScroller
        autoScroll={viewState.follow}
        onReleaseFollow={handleReleaseFollow}
        viewportRef={viewportRef}
        controllerRef={scrollerRef}
        backToLatest={
          viewState.follow ? null : (
            <MessageScrollerButton
              data-testid="agent-log-back-to-latest"
              direction="end"
              behavior="auto"
              aria-label={`回到最新（${unread} 轮未读）`}
              title={`回到最新（${unread} 轮未读）`}
              onClick={backToLatest}
              style={{ right: 'var(--density-space-md)', bottom: 'var(--density-space-md)' }}
            >
              <ArrowDown aria-hidden />
              {unread > 0 && (
                <Badge variant="destructive" className="absolute -top-1 -right-1 h-5 min-w-5 justify-center px-1">
                  {unread}
                </Badge>
              )}
            </MessageScrollerButton>
          )
        }
      >
        {timelineArea}
      </LogScroller>

      {/* ③ 底部固定区：排队区 + 输入区住这里（**不传就一个节点都不渲染**）。
          它排在滚动区之后 ⇒ 滚动区按它的实际高度自动缩水，这是 flex 的既有行为，
          不需要（也不该）在这里算高度差：算出来的数会在字体加载 / 换密度时过期 */}
      {footer !== undefined && (
        <div data-testid="agent-log-footer" className="flex flex-col border-t border-border">
          {footer}
        </div>
      )}

      {/* 环境抽屉：**内部件**（不是并列组件）——主抽屉一卸载它跟着没，调用方不必接线 */}
      <AgentEnvironmentDrawer
        open={viewState.environmentOpen}
        onOpenChange={viewState.setEnvironmentOpen}
        environment={environment}
        onRetry={source?.requestEnvironment === undefined ? undefined : () => source.requestEnvironment?.()}
        // 能力声明取**当前节点**的那一份（不是主会话的、也不是全局一份）：同一行的不同子任务
        // 采数通道可以不同，拿错节点就会说错原因
        capability={node?.capability}
        capabilityNotes={node?.capabilityNotes}
      />
    </div>
  );
}
