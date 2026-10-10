/**
 * codex 的**行级事件投影**：app-server 通知 → `AgentEventDraft` 与 `TurnProjection`。
 * 内容级视图（消息与子任务行）在 `message.ts`，两份共用 `run-state.ts` 的同一把尺子。
 *
 * 三条职责边界：
 *   1. **只投影行级事实**：计量、轮次、时长、失败、未识别通知的原始负载，以及**活动行的那一句话**
 *      （`activityDrafts`，产物是 `log` 事件）。内容与子任务行一律走 `message.ts`——一条通知只在
 *      一处归一，两处都出会让同一条目落两次。
 *      两处例外，都各有理由：骨架状态 `finalText`（它不落事件、也不出内容块，而本层恰好是
 *      **拿得到 state 且已经按主线程判过**的地方），以及活动行（卡片底部那一行只吃 `log` 事件，
 *      同一条通知若不在这里补一句人话，那一行就只剩「更新计划：N 步」——真机形态见 `activityDrafts`）。
 *   2. **轮次按线程分别数**（`run-state.ts` 的 `countRoundTrips`），这里交出的是**主线程**那一份
 *      ——进度条与 `EvalRow.turns` 读的是本行跑到第几轮。子线程那一份由 `message.ts` 用同一个函数
 *      数出来，收尾时两半相加。
 *   3. **「过路报错」与「这一轮的结论」分开**：`error` 通知是**每次尝试**都会发的过路消息（上游自己
 *      还会重试），折成失败会把一次最终成功的运行判死 ⇒ 它只落一条 WARN；`turn/completed` 才是
 *      结论（`failed` 折失败、`interrupted` 是「被中止」不是失败）。
 */
import type { UsageTokens } from '@aieval/contracts';
import {
  planSummary,
  subagentDispatchSummary,
  subagentSettledSummary,
  toolCallSummary,
  toolErrorSummary,
} from '../../activity';
import { logDraft, safeStringify, unknownEventDraft, vendorSystemDraft, type AgentEventDraft } from '../../emit';
import { classifyAgentMessage, type FailureContext } from '../../errors';
import { usageTokens } from '../../message';
import type { TimingSpan, TurnProjection, TurnState } from '../../turn';
import type { AppServerItem, AppServerNotificationPayload, AppServerTurn } from './appserver/protocol';
import { APPLY_PATCH_TOOL_NAME, COMMAND_TOOL_NAME, collabStatusOf, subAgentActivityStatus } from './message';
import { countRoundTrips, normalizedInput, noteMcpStartup, observedTurns, type CodexRunState } from './run-state';

/** 一轮已交出的权威读数（收尾要与它比「是否真的更新」） */
export interface CodexEventContext {
  kind: 'codex';
  baseUrl: string;
  /** 主线程 id：只有它的 `turn/completed` 结算本次运行 */
  mainThreadId: string;
}

export interface CodexEventProjection {
  projection: TurnProjection;
  /**
   * 本条通知交出的权威读数；`null` = 本条不带计量。
   * 与 `projection.tokens` 的区别：后者是「本条要发出去的值」，这一格是「本行已知的最新值」
   * （`turn/completed` 不带用量时它仍是 `null`，调用方**保持**上一份，不回填 0）。
   */
  tokens: UsageTokens | null;
}

export function projectCodexEvent(
  payload: AppServerNotificationPayload,
  state: TurnState,
  runState: CodexRunState,
  context: CodexEventContext,
): CodexEventProjection {
  const idle = (drafts: AgentEventDraft[] = []): CodexEventProjection => ({
    projection: { drafts, tokens: null, turns: null, turn: null, failure: null },
    tokens: null,
  });

  if (payload.kind === 'itemStarted' || payload.kind === 'itemCompleted') {
    // 条目自身的归一在 `message.ts`（那时才知道块与族）；这里出**活动行那一句**，并推进轮次计数
    const drafts = activityDrafts(payload.item, payload.kind === 'itemCompleted', runState);
    const turns = countRoundTrips(payload.item, payload.threadId, runState);
    /**
     * **最终答复**（骨架的 `state.finalText`，评分通路读的就是它）：codex 没有另两家那种显式的收尾
     * 消息（claude 的 `result` / dsh 的 `assistant/message`），答复就是主线程 `item/completed` 上的
     * `agentMessage` 条目——而 `turn/start` 的 `outputSchema` 约束的**正是这条条目的正文**
     * ⇒ 这一格不写，`capability.structuredOutput: true` 与「评分智能体能拿到 JSON」之间就断了。
     *
     * 条件三条，每条各挡一种错法：
     *   · `itemCompleted`：`item/started` 的正文可能只是半截（增量还在流），拿它当答复就是交残句；
     *   · 主线程：子线程的结论不许顶掉主会话的产出（`finalText` 一行只有一个格子）；
     *   · 正文非空：空块在界面上只是一行空白，写进去会把「没采到」伪装成「答复了空串」——
     *     `judge-agent.ts` 对这两种形态给的是**两句不同的中文归因**。
     * 覆盖语义与另两家一致（后到的主线程答复覆盖先到的），见 `turn.ts` 的 `TurnState.finalText`。
     */
    if (
      payload.kind === 'itemCompleted' &&
      payload.item.kind === 'agentMessage' &&
      payload.threadId === context.mainThreadId &&
      payload.item.text !== ''
    ) {
      state.finalText = payload.item.text;
    }
    if (turns === null || payload.threadId !== context.mainThreadId) return idle(drafts);
    /**
     * 归属：与 `turns` 同一个号（本条通知来自主线程）⇒ 界面能把这条读数放回它自己那一轮。
     * 子线程的条目**刻意不给归属**：本行的事件流只有主线程的进度语义，把子线程的号贴上来
     * 会让界面按 `turns` 反推出的会话关系全错。
     */
    return {
      projection: {
        drafts,
        tokens: null,
        turns,
        turn: { subagentId: null, round: turns },
        failure: null,
      },
      tokens: null,
    };
  }

  if (payload.kind === 'turnCompleted') {
    return projectTurnCompleted(payload.threadId, payload.turn, runState, context);
  }

  if (payload.kind === 'tokenUsage') {
    /**
     * 线程级用量的**唯一来源**（协议没有「按线程读用量」的请求）。这里只记账、不发事件：
     * `usage` 事件的发射门槛是轮次，而用量通知本身不带轮次——带一条轮次相同的 usage 是纯噪声，
     * 且会把归属贴到错误的轮上。下一次 `turn/completed` 会把它带出去。
     */
    runState.usageByThread.set(payload.threadId, payload.usage);
    return idle();
  }

  if (payload.kind === 'mcpStartupStatus') {
    /**
     * **MCP 的厂商侧判据**（codex）：`starting` / `ready` / `failed`。
     *
     * 三条口径：
     *   · 每条通知交**累积之后的全部服务器**（`noteMcpStartup` 的返回值）：codex 只报变化的那一台，
     *     而观测格按名字对全表 ⇒ 最后那一条必须自足；
     *   · 通道自报 `vendor-startup-status`：推导据此把 `ready` 读成「已就绪」、把「没有这一台工具」
     *     读成「不判失败」（这一家拿不到工具表）；
     *   · 其余五格如实记 `null`（**不是空数组**）：这一条事实里只有 MCP 那一格，投送面就是它。
     *
     * ⚠️ **能力缺口**：`ready` 只证明「装上了」，不证明「调得动」——本机自定义 Responses 网关下
     * 模型发起的 MCP 调用回 `unsupported call`（上游命名空间被拍平，见 `docs/protocols/codex.md` 的「能力缺口」
     * 与 `CODEX_MCP_DISPATCH_GAP_NOTE`）。本条事件因此**只承载启动状态**，一个字都不暗示可用性。
     */
    const servers = noteMcpStartup(runState, payload.name, payload.status, payload.error);
    return idle([
      vendorSystemDraft({
        tools: null,
        slashCommands: null,
        agents: null,
        mcpServers: servers.map((one) => ({ name: one.name, status: one.status, source: null, error: one.error })),
        mcpChannel: 'vendor-startup-status',
        permissionMode: null,
        outputStyle: null,
      }),
    ]);
  }

  if (payload.kind === 'error') {
    /**
     * `error` 通知是**每次尝试**都会发的过路消息（它的同名声明还带 `willRetry`，协议层这一侧只留了
     * 文案）⇒ 折成失败会把一次最终成功的运行判死（真机形状：「Reconnecting… 5/5」，
     * 随后那一轮照样跑完）。故只落一条 WARN；失败由 `turn/completed` 的 `failed` 折进结论。
     */
    return idle([
      logDraft('stderr', `[WARN] codex 报错（本轮尚未结算）：${payload.message}`),
    ]);
  }

  if (payload.kind === 'turnPlanUpdated') {
    // 计划面板由 `message.ts` 出块；这里只留一行摘要（原始负载在块的 `raw` 里）。文案与另两家的清单工具同形。
    return idle([logDraft('stdout', safeStringify(payload), planSummary(payload.steps.length))]);
  }

  /**
   * 其余通知**一条事件都不发**：增量的落点是内容块（`message.ts`），落到行级日志里只会把抽屉灌满
   * （一次答复几十条片段）。未识别的通知（`other`）照旧保留原始负载——静默丢弃会让
   * 「上游换了方法名」表现为「什么都没发生」。
   */
  if (payload.kind === 'other') return idle([unknownEventDraft({ method: payload.method })]);
  return idle();
}

/**
 * 「此刻在做什么」那一句（活动行的 `log.summary`）。
 *
 * **为什么这一层要发日志**：卡片底部那一行只吃 `log` 事件的 `summary` / 人话 `text`
 * （判定在 `@aieval/client` 的 `activityOf`），而 app-server 重写后**工具面的内容全走
 * `message.ts` 的块** ⇒ 只出块不出日志，那一行整轮只剩「更新计划：N 步」。真机症状
 * （run `7d8d5f3b`）：74 条事件 / 44 条 log / **10 条带摘要且全是计划那一句**，最后一条摘要还是
 * `{"method":"account/rateLimits/updated"}`（机器负载 ⇒ 被 `activityOf` 挡下）
 * ⇒ 活动行自第 6 条事件起**永久冻住**；而抓包证明 `item/started` 起来时就带着完整 `command`
 * （`probe/dumps/v6/codex-chat-wire-appserver-live-responses-subagent.jsonl`）——信息一直都在。
 * 另两家（dsh / claude）都是「同一条工具通知既出块、也出一行带摘要的日志」，这里补的就是那半边。
 *
 * **发什么由 `src/activity.ts` 的词表定**（三家同形），本函数只决定**在哪一条通知上发**：
 *   · `commandExecution` —— 只在**开始**发：那一刻命令行已完整（上面的真机证据）；
 *     完成时的输出与退出码是**结果**，落点是结果块与原始输出面板，不进活动行；
 *   · `fileChange` —— 只在**完成**发：`item/started` 的 `changes` 可能还是空的，
 *     拿它出一行会得到没有信息的「调用工具 apply_patch」；
 *   · `mcpToolCall` —— 开始发调用、完成只在**报错**时发（错误没有别的行级出口）；
 *   · `webSearch` / `dynamicToolCall` —— 开始发调用；
 *   · `collabToolCall` / `subAgentActivity` —— 派发与收场（见 `collabDrafts`）；
 *   · `agentMessage` —— 完成时落一条日志，**不带摘要**：正文本身就是人话，
 *     由 `activityOf` 直取 `text`（与 claude 的文本块、dsh 的答复行同待遇）；
 *   · `reasoning` / 增量 / 计划条目 —— **不发**：正文的落点是思考块与内容块，
 *     增量逐条进日志只会把抽屉灌满（一次答复几十条片段）。
 */
function activityDrafts(item: AppServerItem, completed: boolean, runState: CodexRunState): AgentEventDraft[] {
  if (item.kind === 'commandExecution') {
    if (!completed) return [activityLine(toolCallSummary(COMMAND_TOOL_NAME, { command: item.command, cwd: item.cwd }), item)];
    /**
     * 完成这一支**只看「有没有跑起来」**，不看退出码：
     *   · `failed` / `declined`（起不来或被拒）是「这条命令没执行」——与文件补丁同一档，必须播；
     *   · 正常的 `completed` **一律不播**，哪怕 `exitCode` 非零：真机 33 条命令里 6 条非零（18%），
     *     而那是 `grep` / `Test-Path` 一类探测的正常返回，播成「工具报错」是**误导**不是保守。
     */
    if (item.status === 'failed' || item.status === 'declined') {
      return [activityLine(toolErrorSummary(`命令${item.status === 'declined' ? '被拒' : '失败'}`), item)];
    }
    return [];
  }
  if (item.kind === 'fileChange') {
    if (!completed) return [];
    const paths = item.changes.map((one) => one.path);
    if (item.status === 'failed' || item.status === 'declined') {
      // 路径可能一条都没有（`changes` 为空）⇒ 不留一对空括号
      const where = paths.length === 0 ? '' : `（${paths.join('、')}）`;
      return [activityLine(toolErrorSummary(`改文件${item.status === 'declined' ? '被拒' : '失败'}${where}`), item)];
    }
    return [activityLine(toolCallSummary(APPLY_PATCH_TOOL_NAME, { changes: item.changes }), item)];
  }
  if (item.kind === 'mcpToolCall') {
    const name = `${item.server}.${item.tool}`;
    if (!completed) return [activityLine(toolCallSummary(name, item.arguments), item)];
    /**
     * 错误对象只声明了「有错」：`message` 拿不到时给一句不说细节的「工具报错」，
     * 不拿 `result` 或 `status` 凑（那样会把一次成功读成失败，或反过来）。
     */
    const error = item.error as Record<string, unknown> | null;
    const message = typeof error?.message === 'string' ? error.message : null;
    /**
     * 判据是「**错误对象在**，或 `status` 明确是 `failed`」——两者取或，各挡一种错法：
     *   · 只看 `status`：厂商把失败写成别的取值时会静默不播；
     *   · 只看 `error`：`status: 'failed'` 而 `error` 缺席（协议这一格是 `unknown`）时同样静默。
     * 细节拿不到就说一句「工具报错」，**不拿 `result` 凑**（那会把一次失败说成有结果）。
     */
    const failed = (item.error !== null && item.error !== undefined) || item.status === 'failed';
    return failed ? [activityLine(toolErrorSummary(message), item)] : [];
  }
  if (item.kind === 'dynamicToolCall') {
    if (completed) return [];
    const name = item.namespace === null ? item.tool : `${item.namespace}.${item.tool}`;
    return [activityLine(toolCallSummary(name, item.arguments), item)];
  }
  if (item.kind === 'webSearch') {
    return completed ? [] : [activityLine(toolCallSummary('web_search', { query: item.query }), item)];
  }
  if (item.kind === 'collabToolCall') return collabDrafts(item, completed, runState);
  if (item.kind === 'subAgentActivity') return subagentActivityDrafts(item, runState);
  if (item.kind === 'agentMessage') {
    // 答复正文：只在完成时落（`item/started` 的正文可能只是半截，增量还在流）
    return completed && item.text !== '' ? [logDraft('stdout', item.text)] : [];
  }
  return [];
}

/**
 * 协作调用：**派发**在完成时播（receiver id 那一刻才到）、其余协作动作在开始时播、**收场**在完成时播。
 *
 * ⚠️ **派发为什么不能放在 `item/started`**（真机抓包 `probe/dumps/v6/codex-chat-wire-appserver-live-responses-subagent.jsonl`）：
 * `L48 item/started` 的 `receiverThreadIds` 是**空数组**（`agentsStates` 也是 `{}`），id 要到
 * `L51 item/completed` 才出现（`["01a115e7-…"]`）⇒ 在开始那一刻遍历 receiver 只会得到零条，
 * 「已派发子任务」在生产里永不播（这一支是死代码，而夹具若写厂商不产出的形状，守卫就会假绿）。
 * 而 `wait` 那一支在 `item/started` 就带 id（`L59`）⇒ 它照旧在开始播「调用工具 wait」。
 *
 * 收场判据是「终态 ∧ 与上次不同」（`runState.subagentStatus`）：同一次收场会在多次协作调用、
 * 子线程自己的活动条目与它自己那一轮的 `turn/completed` 上**重复出现**，不去重就会播三四遍。
 *
 * **名字**：`thread/started` 登记昵称这条路只在主线程实测到（同一份抓包里 `thread/started` 仅一条、
 * 且 `agentNickname: null`；子线程的昵称只出现在收尾 `thread/list` 的响应里）⇒ 运行期的派发/收场行
 * **多数是无名的那一档**，这是词表允许的形状，不是缺陷。子任务行在收尾取数后会有名字，
 * 两个面因此可能不一致——登记在《进程生命周期》的归属表，不在这一层编名字。
 */
function collabDrafts(
  item: Extract<AppServerItem, { kind: 'collabToolCall' }>,
  completed: boolean,
  runState: CodexRunState,
): AgentEventDraft[] {
  const receivers = item.receiverThreadIds.filter((threadId) => threadId !== '');
  /** 工具名以 `spawn` 开头才算派发：真机见到的是 `spawnAgent`（`run-state.ts` 的注释里另记过 `spawn_agent`） */
  const isDispatch = item.tool.toLowerCase().startsWith('spawn');
  if (!completed) {
    // 派发那一刻还没有 receiver id（见上）⇒ 开始这一支不给 spawn 出句子；`wait` / `closeAgent` 走通用工具句
    if (isDispatch) return [];
    return [activityLine(toolCallSummary(item.tool, null), item)];
  }
  const drafts: AgentEventDraft[] = [];
  // 派发在前、收场在后：同一个通知里两者都成立时（子任务派出去就已经是终态），顺序要读得通
  if (isDispatch) {
    for (const threadId of receivers) {
      drafts.push(activityLine(subagentDispatchSummary(runState.nicknames.get(threadId) ?? null), item));
    }
  }
  for (const state of item.agentsStates) {
    if (state.threadId === '') continue;
    const status = collabStatusOf(state.status).status;
    const changed = runState.subagentStatus.get(state.threadId) !== status;
    // 「最近见到的状态」照记：先 `running` 后 `completed` 是两次不同的事实，下一次终态才算「变化」
    rememberSubagentStatus(runState, state.threadId, status);
    if (!changed || !isSettledStatus(status)) continue;
    drafts.push(activityLine(subagentSettledSummary(runState.nicknames.get(state.threadId) ?? null, status), item));
  }
  return drafts;
}

/** `subAgentActivity`：只有终态且**与上次不同**才播一句收场（`started` / `interacted` 是「在跑」，派发时已经播过） */
function subagentActivityDrafts(
  item: Extract<AppServerItem, { kind: 'subAgentActivity' }>,
  runState: CodexRunState,
): AgentEventDraft[] {
  const status = subAgentActivityStatus(item.activity);
  if (item.agentThreadId === '') return [];
  const changed = runState.subagentStatus.get(item.agentThreadId) !== status;
  rememberSubagentStatus(runState, item.agentThreadId, status);
  if (!changed || !isSettledStatus(status)) return [];
  return [activityLine(subagentSettledSummary(runState.nicknames.get(item.agentThreadId) ?? null, status), item)];
}

/**
 * 子线程自己那一轮的 `turn/completed` → 一句收场。
 *
 * 为什么必须有这一支：收场的另两个来源（协作调用的 `agentsStates`、`subAgentActivity`）都依赖
 * 模型**再调一次** `wait` / `closeAgent` 或厂商推活动条目；模型若派发完直接收尾，活动行就会一直停在
 * 「调用工具 spawnAgent」，而子任务行按 `turn.status` 已经写着「已完成」（`message.ts` 的
 * `terminalStatusOf` 读的是同一份事实）⇒ 同一个事实两个面说法不同。
 *
 * 状态映射与 `terminalStatusOf` **同一张表**：`completed` → 已完成、`failed` → 失败、
 * `interrupted` → 已停止；`inProgress` 不播。去重仍走 `subagentStatus`（多轮子线程会来回切）。
 */
function subagentTurnDrafts(
  threadId: string,
  turn: AppServerTurn,
  runState: CodexRunState,
): AgentEventDraft[] {
  const status = turn.status === 'completed' ? 'completed' : turn.status === 'failed' ? 'failed' : turn.status === 'interrupted' ? 'stopped' : null;
  if (status === null || threadId === '') return [];
  const changed = runState.subagentStatus.get(threadId) !== status;
  rememberSubagentStatus(runState, threadId, status);
  if (!changed) return [];
  return [logDraft('stdout', safeStringify({ kind: 'subagentTurn', threadId, status: turn.status }), subagentSettledSummary(runState.nicknames.get(threadId) ?? null, status))];
}

/** 终态三档（`completed` / `failed` / `stopped`）；`running` 与 `unknown` 都不是收场 */
function isSettledStatus(status: string): boolean {
  return status === 'completed' || status === 'failed' || status === 'stopped';
}

function rememberSubagentStatus(runState: CodexRunState, threadId: string, status: string): void {
  if (threadId === '') return;
  runState.subagentStatus.set(threadId, status);
}

/**
 * 一条活动行日志：`text` 是**证据**（原始条目），`summary` 是给人看的那句话。
 *
 * 证据刻意**去掉正文型重字段**（见 `evidenceOf`）：那些字段的落点是结果块，而事件流的每一条都要过
 * SSE 推给浏览器 ⇒ 在这里再抄一份会让一次构建的几万行输出或一个 MCP 结果把事件流撑大一个量级
 * （它们在各目的结果块里已经是权威的一份）。
 */
function activityLine(summary: string, item: AppServerItem): AgentEventDraft {
  return logDraft('stdout', safeStringify(evidenceOf(item)), summary);
}

/**
 * 证据负载：三类**带正文**的条目只留识别字段，其余条目原样（它们本来就只有识别字段）。
 * 三类分别是 `commandExecution.output`（命令输出）、`mcpToolCall.result`（工具结果）、
 * `dynamicToolCall.contentItems`（内容块数组）。
 */
function evidenceOf(item: AppServerItem): unknown {
  if (item.kind === 'commandExecution') {
    return {
      kind: item.kind,
      id: item.id,
      command: item.command,
      cwd: item.cwd,
      status: item.status,
      exitCode: item.exitCode,
      durationMs: item.durationMs,
    };
  }
  if (item.kind === 'mcpToolCall') {
    return {
      kind: item.kind,
      id: item.id,
      server: item.server,
      tool: item.tool,
      status: item.status,
      durationMs: item.durationMs,
      // 入参留着：它说明「本次调用要干什么」，而结果正文不留（落点是结果块）
      arguments: item.arguments,
    };
  }
  if (item.kind === 'dynamicToolCall') {
    return {
      kind: item.kind,
      id: item.id,
      namespace: item.namespace,
      tool: item.tool,
      status: item.status,
      success: item.success,
      durationMs: item.durationMs,
      arguments: item.arguments,
    };
  }
  return item;
}

/**
 * `turn/completed`：计量 + 时长 + 失败 + 轮次归属。
 *
 * 四条判据：
 *   · **只认主线程**：子线程的 `turn/completed` 是子任务自己的一轮（它的用量按线程记在
 *     `thread/tokenUsage/updated` 里），拿它当本轮的收尾会把整行提前结算；
 *   · **时长用厂商时刻**：`startedAt` / `completedAt` 是**秒**（app-server 的 `Turn`），换算成毫秒后
 *     交出去现减；`apiMs` / `ttftMs` 恒 `null`——那两格只有 claude 有，**不许**拿 `totalMs` 冒充；
 *   · **`interrupted` 不是失败**：用户点「终止」时上游报的正是这一档，折成失败会把一次人为终止
 *     变成「适配器出错」；
 *   · **`input` 减 cached**（见 `run-state.ts` 的 `normalizedInput`）。
 */
function projectTurnCompleted(
  threadId: string,
  turn: AppServerTurn,
  runState: CodexRunState,
  context: CodexEventContext,
): CodexEventProjection {
  if (threadId !== context.mainThreadId) {
    // 子线程的一轮：条目里没有逐条通知的那些答复也要计入它自己的轮次（子任务行由 `message.ts` 刷新）
    for (const item of turn.items) countRoundTrips(item, threadId, runState);
    // 收场的第三个来源：模型不再调 `wait` / `closeAgent` 时，这一条是活动行唯一能拿到的终态
    return { projection: { drafts: subagentTurnDrafts(threadId, turn, runState), tokens: null, turns: null, turn: null, failure: null }, tokens: null };
  }
  for (const item of turn.items) countRoundTrips(item, threadId, runState);
  const turns = observedTurns(runState, threadId);
  const turnRef = turns === null ? null : { subagentId: null, round: turns };
  const drafts: AgentEventDraft[] = [];

  if (turn.status === 'failed') {
    const message = turn.error ?? 'codex 报告本轮失败（未给出原因）';
    drafts.push({ type: 'error', message });
    return {
      projection: {
        drafts,
        tokens: null,
        turns,
        turn: turnRef,
        /**
         * 归因取**厂商原文**：`TurnError` 这一侧只声明了 `message`（`codexErrorInfo` 那个结构化枚举
         * 不在窄声明里），而 401 / 429 这类状态就写在文案里 ⇒ 交给共用的 `classifyAgentMessage`。
         */
        failure: classifyAgentMessage(message, failureContext(context)),
      },
      tokens: null,
    };
  }
  if (turn.status === 'interrupted') {
    // 中止不是失败：结论由「用户点了终止」那条通路给出（`runTurn` 的 canceled）
    drafts.push(logDraft('stderr', '[WARN] codex 本轮被中止（用户终止或上游打断）'));
  }

  const tokens = usageOfTurn(turn, runState, context.mainThreadId);
  /**
   * 时间只在**两点都给得出**时才有意义：`resolveTiming` 对缺一端的情形返回 `null`（整格不发）
   * ⇒ 这里照原样交出两个可空时刻，不在这里拼一个 `totalMs` 出来；两点缺一时**整格不带**
   * （`TurnProjection.timing` 的缺省语义是「这一条没带时间」，不是「把已采到的时间清掉」）。
   */
  const timing = turnTimingOf(turn);
  return {
    projection: {
      drafts,
      tokens,
      turns,
      turn: turnRef,
      ...(timing === null ? {} : { timing }),
      failure: null,
    },
    tokens,
  };
}

/**
 * 本轮应交出的权威读数。
 *
 * 优先级：`turn/completed` 自带的 `turn.usage`（若上游给了）> 该线程最近一次
 * `thread/tokenUsage/updated` 的**累计**快照。两条都拿不到就是 `null`（**不填 0**）。
 * 交出去的是厂商自报的累计值（与终值同口径 ⇒ 骨架据此发 `tokensBasis: 'reported'` 的事件），
 * **不做差分**。
 */
function usageOfTurn(turn: AppServerTurn, runState: CodexRunState, mainThreadId: string): UsageTokens | null {
  /**
   * 本机导出的 `Turn` **没有** `usage` 这一格（用量只在 `thread/tokenUsage/updated` 上），
   * 但协议是实验面、字段可能后加：读到了就用。刻意写成一次收窄读取而不是改 `appserver/protocol.ts`
   * 的窄声明——那一层只声明我们**确实消费**的字段，而这里要的是「有就用、没有就走通知」。
   */
  const fromTurn = breakdownToTokens((turn as { usage?: unknown }).usage);
  if (fromTurn !== null) return fromTurn;
  const threadUsage = runState.usageByThread.get(mainThreadId);
  return threadUsage === undefined ? null : breakdownToTokens(threadUsage.total);
}

/**
 * 用量载荷 → `UsageTokens`（三项齐了才认，缺项即 `null`）。
 * `reasoningOutput` / `total` 是可选格：读得到就带上，读不到就是 `null`（**不填 0**）。
 */
export function breakdownToTokens(value: unknown): UsageTokens | null {
  const record = value as Record<string, unknown> | null | undefined;
  if (record === null || record === undefined || typeof record !== 'object') return null;
  const input = readCount(record, 'inputTokens');
  const cached = readCount(record, 'cachedInputTokens');
  const output = readCount(record, 'outputTokens');
  if (input === null || cached === null || output === null) return null;
  return usageTokens({
    input: normalizedInput(input, cached),
    cached,
    output,
    reasoningOutput: readCount(record, 'reasoningOutputTokens'),
    total: readCount(record, 'totalTokens'),
  });
}

/** 只认有限数：形状不对就是「没采到」（不是 0） */
function readCount(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * 厂商时刻 → 骨架的时间跨度（`source: 'events'`，含工具执行的墙钟）。
 *
 * `startedAt` / `completedAt` 的单位是**秒**（app-server 的 `Turn` 逐字如此），而骨架的 `TimingSpan`
 * 是**毫秒**（与 `Date.now()` 同尺）⇒ 乘法只在这一处做，别在调用方再乘一次。
 */
export function turnTimingOf(turn: AppServerTurn): TimingSpan | null {
  if (turn.startedAt === null || turn.completedAt === null) return null;
  return { firstMs: turn.startedAt * 1000, lastMs: turn.completedAt * 1000, source: 'events' };
}

function failureContext(context: CodexEventContext): FailureContext {
  return { kind: context.kind, baseUrl: context.baseUrl };
}
