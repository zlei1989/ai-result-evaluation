'use client';

/**
 * `agent-log` 的四份**视图态**的唯一持有者（headless，无渲染）：
 * 当前节点 / 跟随最新 / 过滤 / 环境抽屉开合，外加 `activeKey` 折叠态。
 *
 * 三条边界：
 *   1. **不持有 data**：节点内容、环境、原始输出一律由 props 注入——
 *      这里只有「用户把界面调成什么样」；
 *   2. **折叠态是「默认态 ∪ 手动开过的 ∖ 手动关掉的」**：默认态由调用方用
 *      `defaultOpenKeysOf(turns, nodes)` 算好传进来（它是**纯函数**，不进组件树）；
 *   3. **外置它是为了换交互形态**（S5）：消费方自己持有同样这四份 state 即可，
 *      不必继承 `AgentLogLayout` 的内部实现。
 *
 * 折叠键的生成函数（`renderBlockKey` 在 L1 的 `agent-message-timeline`，行键 `toolEntryKey` 在 L0 的
 * `tool-item-detail`）：**依赖只准向下**，L1 不许 import L2，而 L2 可以 import L1。
 * 两处各写一份必然漂移，漂移的表现是「我展开的那条自己合上了」。
 *
 * 本文件**只算块级键**（行键由 L0 的 `ToolGroupPanel` 直接消费，并由 L1 的 `renderBlockKey` 从**首条行键**派生出组键。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AgentLogModel, LogNodeIndex, LogTurn } from './types';
import { buildRenderBlocks, nodeIndex } from './render-blocks';
import { renderBlockKey } from './agent-message-timeline';

/** 过滤两格。它与 `AgentLogViewState.filters` 是同一个形状：`AgentLogLayout` 的轮次级过滤吃它 */
export interface AgentLogFilters {
  onlyTools: boolean;
  onlyErrors: boolean;
}

export interface AgentLogViewState {
  activeNodeId: string;
  setActiveNodeId(id: string): void;
  /** 跟随最新；`false` 由用户上翻触发（开关与角落浮出按钮**共用这一份**） */
  follow: boolean;
  setFollow(next: boolean): void;
  filters: AgentLogFilters;
  setFilters(next: AgentLogFilters): void;
  environmentOpen: boolean;
  setEnvironmentOpen(open: boolean): void;
  /** 折叠态键集合：内置默认态 ∪ 用户手动开过的 ∖ 用户手动关掉的 */
  openKeys: ReadonlySet<string>;
  onOpenChange(key: string, open: boolean): void;
}

/** 空集合与空轮次常量：默认值不能每次渲染新建一个（那会让下游的 `useMemo` 全部失效） */
const EMPTY_KEYS: ReadonlySet<string> = new Set<string>();
const EMPTY_TURNS: readonly LogTurn[] = [];

/** 加一个键（已有则原样返回，避免无谓的重渲染） */
function withKey(keys: ReadonlySet<string>, key: string): ReadonlySet<string> {
  if (keys.has(key)) return keys;
  const next = new Set(keys);
  next.add(key);
  return next;
}

/** 去掉一个键（没有则原样返回） */
function withoutKey(keys: ReadonlySet<string>, key: string): ReadonlySet<string> {
  if (!keys.has(key)) return keys;
  const next = new Set(keys);
  next.delete(key);
  return next;
}

/**
 * 打开抽屉时该选中哪个节点：
 * ① `model.activeNodeId` 若在 `nodes` 里就用它（页面可能已经指定了要看哪个子任务）；
 * ② 否则取第一个 `kind === 'main'` 的节点（主会话是默认视图）；
 * ③ 再否则取第一个节点的 id；一个节点都没有时给空串。
 */
export function defaultActiveNodeId(model: AgentLogModel): string {
  if (model.nodes.some((node) => node.id === model.activeNodeId)) return model.activeNodeId;
  const main = model.nodes.find((node) => node.kind === 'main');
  if (main !== undefined) return main.id;
  return model.nodes[0]?.id ?? '';
}

/**
 * 一轮的**内置默认展开态**（表格 + 例外），只加键、不加「收起」：
 *   · 进行中的工具组展开（`turn.running` 或组内有 `running` 的调用）——「这一步正在干什么」不能被折叠吞掉； * · **失败不是展开的理由**（覆盖的例外 2）：失败的工具组与组内的
 * 失败行**都默认收起**，与成功的一视同仁。「这一组里有失败」由**组头的「失败 N」标记**承担
 * （`ToolGroupPanel`），证据要用户自己点开；
 *   · 思考块 / `unrecognized` 块**不加键**（默认收起）；
 *   · 计划清单：首次（`change === null`）、进行中、或结果未采集时展开，其余收起；
 *   · 问答卡片：`pending && running` 展开（等待态是「卡住了」的唯一信号）；
 *     `timeout` / `unavailable` / `rejected` 展开（没能问成人也不该藏起来），其余收场收起。
 *
 * 正文 / 附件 / 子任务占位条 / 行级汇总**不折叠**，故也不在这里加键。
 * 本函数是纯函数：默认态与折叠历史无关，同一份输入永远给同一份键集合（这就是它不放进 hook 的理由）。
 */
export function defaultOpenKeysOf(turns: readonly LogTurn[], nodes: LogNodeIndex): ReadonlySet<string> {
  const keys = new Set<string>();

  for (const [turnIndex, turn] of turns.entries()) {
    // `nodeId` 只参与 `buildRenderBlocks` 的轮上下文：本函数拿不到 `activeNodeId`（纯函数），
    // 而规则 3 的定位只用 `messageId` / `callId`，该字段在当前实现里不参与任何分支。
    const messageId = turn.blocks[0]?.messageId ?? null;
    const blocks = buildRenderBlocks(turn.blocks, nodes, {
      at: turn.at,
      running: turn.running,
      messageId,
      nodeId: '',
      // 与时间轴同一口径：行级汇总只在第一轮出现（它不折叠，故这里不影响默认展开键，
      // 但两处必须传同一个值，否则键集合会随实现细节漂）
      firstTurn: turnIndex === 0,
    });

    blocks.forEach((block, index) => {
      const key = renderBlockKey(block, index, turn.at);
      switch (block.kind) {
        case 'tool-group': {
          // 只有「进行中」入键：**失败不入键**。
          // 于是组内那一行也不因失败而入键——组与行各自都收起，证据要点两次，
          // 这是刻意换来的版面整洁；失败在收起态的可见性由组头的「失败 N」标记负责
          // （那个标记画在 `ToolGroupPanel` 里，本函数只算折叠键、画不了它）。
          const running = turn.running || block.entries.some((entry) => entry.kind === 'call' && entry.running);
          if (running) keys.add(key);
          break;
        }
        case 'task-panel':
          if (block.panel.change === null || block.panel.running || block.panel.result === null) keys.add(key);
          break;
        case 'ask-user-card': {
          const interaction = block.interaction;
          if (interaction.state === 'pending') {
            if (interaction.running) keys.add(key);
          } else if (
            interaction.outcome === 'timeout' ||
            interaction.outcome === 'unavailable' ||
            interaction.outcome === 'rejected'
          ) {
            keys.add(key);
          }
          break;
        }
        // 思考块与 `unrecognized` 块默认收起：不加键就是收起（`openKeys.has(key) === false`）
        default:
          break;
      }
    });
  }

  return keys;
}

/**
 * 视图态的四份 state + 折叠态。
 *
 * `defaultOpenKeys` **不传时本 hook 自己算**（按当前节点的轮次）：这份默认态依赖
 * `activeNodeId`，而 `activeNodeId` 正住在本 hook 里——让调用方在**调用本 hook 之前**算好，
 * 就要求调用方先知道「待会儿选中哪个节点」，那是个先有鸡还是先有蛋的环
 * （`AgentLogLayout` 只能用「模型建议的默认节点」去猜，用户切到子任务后默认展开就失效了）。
 * 传进来的值仍然以调用方为准：想换一套默认态（例如「永远全开」）直接给一个集合即可。
 */
export function useAgentLogView(input: {
  model: AgentLogModel;
  defaultOpenKeys?: ReadonlySet<string>;
}): AgentLogViewState {
  const { model, defaultOpenKeys } = input;
  const [activeNodeId, setActiveNodeId] = useState(() => defaultActiveNodeId(model));
  const [follow, setFollow] = useState(true);
  const [filters, setFilters] = useState<AgentLogFilters>({ onlyTools: false, onlyErrors: false });
  const [environmentOpen, setEnvironmentOpen] = useState(false);
  /** 用户手动开过的键 */
  const [openedKeys, setOpenedKeys] = useState<ReadonlySet<string>>(EMPTY_KEYS);
  /** 用户手动关掉的键：**没有它就没法关掉一个默认展开的块**（例如正在跑的工具组） */
  const [closedKeys, setClosedKeys] = useState<ReadonlySet<string>>(EMPTY_KEYS);

  // 模型换了（`model` 引用变了）：当前选中的节点已不在 `nodes` 里 ⇒ 回落到默认节点。
  // 放在 effect 里而不是渲染期派生：切换节点是用户的动作，选中的那一份必须是**真的 state**
  // （派生会让「用户刚点的节点」与「模型建议的节点」每次渲染都打架）。
  useEffect(() => {
    if (model.nodes.some((node) => node.id === activeNodeId)) return;
    setActiveNodeId(defaultActiveNodeId(model));
  }, [model, activeNodeId]);

  // 当前节点的轮次 → 内置默认展开态。两份 memo 都挂在「节点 / 轮次」上：
  // 同一份 `nodes` 引用不重算（(a) 的口径）。调用方自己给了默认态时不白算一遍。
  const currentNode = model.nodes.find((node) => node.id === activeNodeId);
  const currentTurns = currentNode !== undefined && currentNode.content.status === 'ready' ? currentNode.content.data : EMPTY_TURNS;
  const computedDefaults = useMemo(
    () => (defaultOpenKeys === undefined ? defaultOpenKeysOf(currentTurns, nodeIndex(model.nodes)) : EMPTY_KEYS),
    [defaultOpenKeys, currentTurns, model.nodes],
  );
  const defaults = defaultOpenKeys ?? computedDefaults;

  const onOpenChange = useCallback((key: string, open: boolean) => {
    // 两边都记：开 = 从「关掉」集合移除并记进「开过」；关 = 反过来。
    // 只记一份「开过」的话，默认展开的块用户关不掉（并集会把默认态又加回来）。
    if (open) {
      setClosedKeys((prev) => withoutKey(prev, key));
      setOpenedKeys((prev) => withKey(prev, key));
    } else {
      setOpenedKeys((prev) => withoutKey(prev, key));
      setClosedKeys((prev) => withKey(prev, key));
    }
  }, []);

  const openKeys = useMemo(() => {
    const merged = new Set<string>(defaults);
    for (const key of openedKeys) merged.add(key);
    // 「手动关掉」覆盖默认态：一个正在跑的工具组也必须关得掉（用户的动作优先于内置规则）
    for (const key of closedKeys) merged.delete(key);
    return merged as ReadonlySet<string>;
  }, [defaults, openedKeys, closedKeys]);

  return {
    activeNodeId,
    setActiveNodeId,
    follow,
    setFollow,
    filters,
    setFilters,
    environmentOpen,
    setEnvironmentOpen,
    openKeys,
    onOpenChange,
  };
}
