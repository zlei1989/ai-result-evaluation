/**
 * 一轮的**内容块 → 渲染块**：纯函数，无 React、无取数、无折叠态。
 *
 * 四条规整（每一条都对应一次真实的误读）：
 *   1. 按 `callId` 配对 `tool-call` 与 `tool-result`；**缺 `callId` 或配不上 ⇒ 降级成独立条目，不编造关联**
 *      （按出现顺序两两配对会把 A 的结果挂到 B 的调用上，而界面上看起来完全正常）；
 *   2. **相邻**的工具条目合并成一个工具组，中间夹了别的东西就断开；
 *   3. **派发点**出 `subagent-bar`（导航），**不进工具组**——「多了一个可进去看的东西」与「调用了什么」
 *      是两件事，同一轮会同时出现。命不中时挂在轮末，**不隐藏**（藏起来等于「这一轮没派子任务」）；
 *   4. `family === 'task' | 'ask-user'` 的块**从工具组里提出、原地成卡**并**切断**合并链；
 *      同一轮只有**最后一次** `task` 调用出面板（更早的收进面板底部的「本轮另有 N 次更新」）。
 *
 * **本函数不碰**：`chunk` / 增量累积 / 快照覆盖（那是数据层）、折叠默认态（那是组件的 `activeKey`）。
 * 折叠态放这里会让「同一份输入」在不同的折叠历史下需要不同的输出，而返回值会被缓存——
 * 缓存与折叠态混在一起就是「用户展开的面板自己合上了」。
 *
 * `running` 不由本函数推断：它来自 `LogTurn.running`（数据层按「该轮是否已结束」给），
 * 本函数只做转发。入参里根本没有「这一轮结束了没有」这个信息，猜「最后一轮 = 流式中」
 * 会让一次被中断的回复永远转圈。
 */
import type {
  AskUserInteraction,
  AttachmentBlock,
  ContentBlock,
  LogNode,
  LogNodeIndex,
  RowNode,
  SessionNode,
  TaskPanel,
  TextBlock,
  ThinkingBlock,
  ToolCallBlock,
  ToolCardResult,
  ToolFamilyPayload,
  TruncationState,
  UnrecognizedPayloadBlock,
} from './types';

/**
 * 时间轴上的一条渲染块。**判别联合**而不是「扁平接口 + 一堆按 kind 才有意义的可空字段」：
 * 后者每加一类带专属数据的块就要再挂一个可空字段，且一个 `text` 要承载五种语义。
 */
export type RenderBlock =
  | { kind: 'text'; block: TextBlock }
  | { kind: 'thinking'; block: ThinkingBlock }
  | { kind: 'tool-group'; entries: ToolGroupEntry[] }
  | { kind: 'attachment'; block: AttachmentBlock }
  | { kind: 'unrecognized'; block: UnrecognizedPayloadBlock }
  | { kind: 'subagent-bar'; node: SessionNode }
  | { kind: 'row-summary'; node: RowNode }
  | { kind: 'task-panel'; panel: TaskPanel; earlierCount: number; cardId: string }
  | { kind: 'ask-user-card'; interaction: AskUserInteraction; cardId: string };

/** 工具结果的界面形状（结果由数据层判定好了长度与截断，UI 不判断大小） */
export interface ToolOutput {
  text: string;
  /**
   * 厂商已解析的结构化结果；`null` = 这一家没给（**不是**「空对象」）。
   * dsh 的 `read` / `write` / `edit` 把行数、改动对象这类**已解析事实**只放在这里，
   * 丢掉它等于让「有数据」变成「看不见」。
   */
  structured: unknown;
  status: 'ok' | 'error' | 'unknown';
  bytes: number;
  truncation: TruncationState;
}

/**
 * 一个工具条目 = 一次调用 +（可能有的）结果。
 *
 * **`running` 与「有没有 `output`」是两件事**：折叠态下它们要显示成两句话——
 * 「进行中」（转圈）与「结果未采集」（静态灰字 + 原因）。推断出来的话，
 * 「这一家拿不到工具结果」会永远显示成「正在跑」，而那是「假装采到了」的反面。
 */
export interface ToolItem {
  kind: 'call';
  callId: string | null;
  /**
   * 源块自己的稳定 id（数据层给：`messageId#块下标`）。
   *
   * 为什么必须带上它：行键（`toolEntryKey`）在 `callId` 拿不到时得有一个**唯一**的身份，
   * 而 `at` 是**轮次派生**的时刻（同一轮的每个块逐字相同）——拿它当身份，一轮里两条
   * 缺 `callId` 的条目会撞成同一个 React key（2026-10-07 真机的重复键报错）。
   */
  blockId: string;
  name: string;
  nameMissing: ToolCallBlock['nameMissing'];
  /** 归一后的族名；`null` = 适配器不认识（与「族认得但卡片没收录」不是一回事，后者 `family` 非空） */
  family: ToolCallBlock['family'];
  input: ToolCallBlock['input'];
  output: ToolOutput | null;
  at: string;
  /** 有调用、结果还没到、且所在轮次尚未结束 —— 只有这一种情况才转圈（`LogTurn.running` 转发） */
  running: boolean;
}

/**
 * 「配不上调用」的结果也必须上时间轴：它是**已经发生的事实**，丢掉等于这一轮没跑过那个工具。
 * 它不编造工具名（没有就是没有），也不参与「工具调用 × N」的计数——那个数回答的是「调用了几次」。
 */
export interface OrphanToolResult {
  kind: 'orphan-result';
  callId: string | null;
  /**
   * 源块自己的稳定 id（同 `ToolItem.blockId`）：`callId` 也为 `null` 时，行键**只剩它**能保证唯一
   * （`at` 是轮次派生时刻，同轮每个块都相同）。
   */
  blockId: string;
  at: string;
  output: ToolOutput;
}

/** 工具组里的一行 */
export type ToolGroupEntry = ToolItem | OrphanToolResult;

/** 结果块 → 工具条目的 `output`（`status` / `structured` 已由数据层判定，这里只搬运） */
function outputOf(block: Extract<ContentBlock, { kind: 'tool-result' }>): ToolOutput {
  return {
    text: block.text,
    structured: block.structured,
    status: block.status,
    bytes: block.bytes,
    truncation: block.truncation,
  };
}

/** 结果块 → 卡片底部的「原始结果」 */
function cardResultOf(block: Extract<ContentBlock, { kind: 'tool-result' }> | undefined): ToolCardResult | null {
  if (block === undefined) return null;
  return { ok: block.status !== 'error', raw: block.text, truncation: block.truncation };
}

/** 找这次调用配上的结果块（同一批块内、`callId` 对得上；配不上就是没有，**不猜**） */
function resultFor(blocks: readonly ContentBlock[], callId: string | null): ToolCardResult | null {
  if (callId === null) return null;
  return cardResultOf(
    blocks.find(
      (block): block is Extract<ContentBlock, { kind: 'tool-result' }> => block.kind === 'tool-result' && block.callId === callId,
    ),
  );
}

/**
 * `task` 族载荷 → 界面形状。
 *
 * ⚠️ **只做字段搬运，不算任何派生值**：`counts` / `change` 由数据层给
 * （UI 按项渲染、看不到上一轮，跨轮比较它做不到）。
 * 载荷缺失时调用方回退成普通工具行——v3 的通用回退不算失败。
 */
export function taskPanelOf(
  payload: ToolFamilyPayload,
  context: { at: string; running: boolean; result: ToolCardResult | null },
): TaskPanel | null {
  if (payload.family !== 'task') return null;
  const panel = payload.panel;
  return {
    ...panel,
    // 载荷没带时刻就用调用块的时刻（两者都是「这次调用发生在什么时候」）
    at: panel.at === '' ? context.at : panel.at,
    running: context.running,
    result: context.result ?? panel.result,
  };
}

/**
 * 子任务为什么必须由 `spawnedBy` 定位、而不是靠一个 `kind: 'subagent'` 的块：
 * subagent 是**与消息平级的独立事件、不是消息的子结构**。为它伪造一个内容块，
 * 等于要数据层为一件并列事件伪造一个块。
 *
 * `callId` 优先：它比 `messageId` 精确（同一轮里可能有多条消息，而一次派发只对应一次调用）。
 */
function nodeForBlock(block: ContentBlock, nodes: LogNodeIndex): SessionNode | null {
  for (const node of nodes.values()) {
    if (node.kind === 'row') continue;
    const from = node.spawnedBy;
    if (from === null) continue;
    if (block.kind === 'tool-call' && from.callId !== null && block.callId !== null && from.callId === block.callId) {
      return node;
    }
    if (from.callId === null && from.messageId === block.messageId) return node;
  }
  return null;
}

/** 这条派发记录属不属于这一轮（按 `messageId` 或该轮的任一 `callId` 判）——轮末兜底要用 */
function spawnedByThisTurn(
  node: SessionNode,
  blocks: readonly ContentBlock[],
  messageId: string | null,
): boolean {
  const from = node.spawnedBy;
  if (from === null) return false;
  if (messageId !== null && from.messageId === messageId) return true;
  return blocks.some((block) => block.kind === 'tool-call' && from.callId !== null && block.callId === from.callId);
}

/** 这一轮里被处理过的派发点（含轮末兜底补上的那些） */
function barNodes(
  blocks: readonly ContentBlock[],
  nodes: LogNodeIndex,
  messageId: string | null,
): SessionNode[] {
  const found: SessionNode[] = [];
  for (const block of blocks) {
    const hit = nodeForBlock(block, nodes);
    if (hit !== null && !found.includes(hit)) found.push(hit);
  }
  // 命不中的挂在轮末，**不隐藏**：藏起来等于「这一轮没派子任务」
  for (const node of nodes.values()) {
    if (node.kind === 'row') continue;
    if (found.includes(node)) continue;
    if (!spawnedByThisTurn(node, blocks, messageId)) continue;
    found.push(node);
  }
  return found;
}

/**
 * 行级汇总节点：只在时间轴上占一条带计数与状态的说明行。
 * **不可点、不进面包屑**——点进去只会得到一个空会话。
 */
function rowNodes(nodes: LogNodeIndex): RowNode[] {
  const rows: RowNode[] = [];
  for (const node of nodes.values()) if (node.kind === 'row') rows.push(node);
  return rows;
}

/**
 * 一**轮**的内容块 → 渲染块。
 *
 * 输入假设（数据层保证，本函数不校验也不补救）：同 `messageId` 的多条消息**已合并完毕**；
 * 缺格一律 `null`（例外是工具名：拿不到时是**空串** + `nameMissing`）；块的 `id` 已由数据层给定。
 * `nodes` 是整棵会话树索引，只为规则 3 定位派发点而给——列表按项渲染时复用同一份索引。
 */
export function buildRenderBlocks(
  blocks: readonly ContentBlock[],
  nodes: LogNodeIndex,
  turn: {
    at: string;
    running: boolean;
    messageId: string | null;
    nodeId: string;
    /**
     * 这是不是该节点的**第一轮**。
     *
     * 为什么要这一格：`row-summary`（`kind: 'row'` 的说明行）是**整个节点**的一条事实，
     * 不是「每一轮都有的事」。不传的话它会被画进每一轮——冒烟实测里同一句
     * 「汇总 已完成 子任务 1 · 完成 1 · 失败 0」在 codex 夹具的两轮里各出现了一次。
     * 由调用方给（它才知道轮次序号），纯函数不自己推。
     */
    firstTurn: boolean;
  },
): RenderBlock[] {
  const out: RenderBlock[] = [];
  /** 正在累积的工具组（遇到非工具块、两族卡片、派发条或轮末即收拢） */
  let group: ToolGroupEntry[] = [];

  const flush = (): void => {
    if (group.length === 0) return;
    out.push({ kind: 'tool-group', entries: group });
    group = [];
  };

  /** `callId` → 已就位的条目。只在**本轮**范围内配对：跨轮配对会把上一轮的结果挂到这一轮 */
  const byCallId = new Map<string, ToolItem>();

  /**
   * 规则 4 的「同一轮只画最后一次」：先算出**最后一次**带载荷的 `task` 调用是哪一条，
   * 更早的那些在遍历到它们时只记数、不出面板。
   * 判据是 `id` 而不是下标：`id` 由数据层给，是稳定键。
   */
  const taskCallIds = blocks
    .filter((block): block is ToolCallBlock => block.kind === 'tool-call' && block.family === 'task' && block.tool !== null)
    .map((block) => block.id);
  const lastTaskId: string | null = taskCallIds.length === 0 ? null : (taskCallIds[taskCallIds.length - 1] ?? null);
  let earlierTaskCount = 0;

  const bars = barNodes(blocks, nodes, turn.messageId);
  const barIds = new Set(bars.map((node) => node.id));

  for (const block of blocks) {
    /**
     * 规则 3：派发点出导航条、**不进工具组**。
     *
     * 顺序刻意是「先把块本身处理完、再补这条导航」：派发那一次调用**同时也是一次工具调用**，
     * 两个事实（「调用了什么」与「多了个可进去看的东西」）在同一轮里都要留下——
     * 先画条再 `continue` 会把 `spawn_agent` 那一行从工具面板里抹掉，
     * 而验收要求正是「工具面板里有 `spawn_agent` 这一条**且**有一条可点的子任务占位条」。
     */
    const hit = nodeForBlock(block, nodes);
    const bar = hit !== null && barIds.has(hit.id) ? hit : null;
    if (bar !== null) barIds.delete(bar.id); // 同一轮里一个节点只画一条（轮末兜底不会再补）

    switch (block.kind) {
      case 'text':
        flush();
        out.push({ kind: 'text', block });
        break;
      case 'thinking':
        flush();
        out.push({ kind: 'thinking', block });
        break;
      case 'attachment':
        flush();
        out.push({ kind: 'attachment', block });
        break;
      case 'unrecognized':
        flush();
        out.push({ kind: 'unrecognized', block });
        break;
      case 'tool-result': {
        // 配得上就并入那条条目；配不上就独立成条——**绝不丢弃**
        const owner = block.callId === null ? undefined : byCallId.get(block.callId);
        if (owner !== undefined) owner.output = outputOf(block);
        else group.push({ kind: 'orphan-result', callId: block.callId, blockId: block.id, at: block.at, output: outputOf(block) });
        break;
      }
      case 'tool-call': {
        const payload = block.tool;
        // 规则 4：两族卡片提出工具组、**原地**成卡，并切断合并链
        if (block.family === 'task' && payload !== null && payload.family === 'task') {
          if (block.id === lastTaskId) {
            flush();
            const panel = taskPanelOf(payload, {
              at: block.at,
              running: turn.running,
              result: resultFor(blocks, block.callId),
            });
            if (panel !== null) {
              out.push({ kind: 'task-panel', panel, earlierCount: earlierTaskCount, cardId: block.id });
              break;
            }
          }
          // 不是最后一次（或载荷形状对不上）：不出面板，但这次调用仍要在界面上留痕 ⇒ 落到通用工具行
          earlierTaskCount += 1;
        }
        if (block.family === 'ask-user' && payload !== null && payload.family === 'ask-user') {
          flush();
          out.push({ kind: 'ask-user-card', interaction: payload.interaction, cardId: block.id });
          break;
        }
        // 通用工具行：族载荷缺失（适配器不认识、或不在本期两族里）也走这里，**调用不消失**
        const item: ToolItem = {
          kind: 'call',
          callId: block.callId,
          blockId: block.id,
          name: block.name,
          nameMissing: block.nameMissing,
          family: block.family,
          input: block.input,
          output: null,
          at: block.at,
          running: turn.running,
        };
        group.push(item);
        if (block.callId !== null) byCallId.set(block.callId, item);
        break;
      }
    }

    // 规则 3（续）：这一块是某个子任务的派发点 ⇒ 在它**之后**补一条导航条。
    // 放在块之后而不是之前：读的人先看到「调用了 `spawn_agent`」，再看到「点这里进去」。
    if (bar !== null) {
      flush();
      out.push({ kind: 'subagent-bar', node: bar });
    }
  }
  flush();

  // 轮末兜底：命不中的派发条挂在这里（顺序在内容之后，但**不会消失**）
  for (const node of bars) {
    if (!barIds.has(node.id)) continue;
    out.push({ kind: 'subagent-bar', node });
  }
  /**
   * 行级汇总节点（`kind: 'row'`）：**不可点、整条时间轴只画一次**（挂第一轮之后）。
   * 每一轮都画的话，两轮的节点上会出现两句一模一样的说明行——它不是「每轮的事实」。
   */
  if (turn.firstTurn) for (const node of rowNodes(nodes)) out.push({ kind: 'row-summary', node });

  return out;
}

/**
 * 会话树索引：由数据层一次建好，列表按项渲染时复用。
 * 建一次而不是每轮 filter 一遍——`buildRenderBlocks` 会被调用 `turns.length` 次（§7.2 的护栏）。
 */
export function nodeIndex(nodes: readonly LogNode[]): LogNodeIndex {
  return new Map(nodes.map((node) => [node.id, node]));
}

/** 某一轮里有没有「工具调用」类的块（过滤用；两族卡片本质就是工具调用，漏掉它们会被读成缺陷） */
export function hasToolCall(blocks: readonly RenderBlock[]): boolean {
  return blocks.some((block) => block.kind === 'tool-group' || block.kind === 'task-panel' || block.kind === 'ask-user-card');
}
