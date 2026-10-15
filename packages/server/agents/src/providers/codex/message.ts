/**
 * codex 的**内容级归一**：app-server 通知 → 契约的消息草稿与子任务行。
 * 行级事件（计量、时长、失败）在 `events.ts`，两者共用 `run-state.ts` 的同一把尺子。
 *
 * 四条取值口径：
 *   1. **一条通知只在一处归一**：本轮运行期由通知驱动（实时），收尾由 `reader` 补**子线程的历史**
 *      ——子线程的 `item/*` 是否推给连接由上游决定，`reader` 是那条路上唯一的兜底。
 *   2. **块序号不由本模块分配**：契约里文本/思考块的标识就是「该载体内的第几个块」，合并器按
 *      **首次到达顺序**发号（`message.ts` 的 `applyBlock`）⇒ 这里一律给 `{ kind: 'index', index: 0 }`
 *      ——同键的后续投递（增量 → 快照）落进同一个槽位，不同键各自占一个新号。
 *   3. **不编造**：拿不到就是 `null`。推理 `content[]` 为空（上游只回密文）时正文是 `null` +
 *      `'none'`，**绝不回落到 `summary`** 冒充全文；子任务状态推不出来就记 `unknown` + `statusMissing`。
 *   4. **消息级用量恒 `null`**：app-server 只到线程级（`ThreadTokenUsage{total,last}`），对 `total`
 *      差分在并发子线程与 turn/item 边界不一致时无法证明归属 ⇒ 不拿线程级读数冒充单条消息。
 */
import { MCP_TOOL_NAME_PREFIX, type SubagentRecord, type UsageTokens } from '@aieval/contracts';
import { toolCallBlockDraft, toolResultBlockDraft, thinkingBlockDraft, textBlockDraft, truncate, unrecognizedBlockDraft, type MessageDraft } from '../../message';
import type {
  AppServerItem,
  AppServerItemEntry,
  AppServerNotificationPayload,
  AppServerThread,
} from './appserver/protocol';
import type { AppServerThreadRef } from './appserver/reader';
import { CODEX_ASK_TOOL_NAME, type CodexAskQuestion } from './ask-user';
import { breakdownToTokens } from './events';
import { blockIndexFor, countRoundTrips, noteDeltaRoundTrip, rememberSubagentFacts, roundTripForItem, roundTripsOf, type CodexRunState } from './run-state';

/** 归一产物：消息草稿与子任务行（同一身份多次投递，后者是完整快照） */
export interface CodexMessageProjection {
  drafts: MessageDraft[];
  subagents: SubagentRecord[];
}

export interface CodexMessageContext {
  /** 主线程 id：子线程的 id 与它相等时 `subagentId` 记 `null`（主会话消息） */
  mainThreadId: string;
}

/**
 * 归一一条通知。
 *
 * `roundTrip` 取该线程**当前**已开到的往返号（下限 1）：契约要求它从 1 递增，而一条通知到达时
 * 它所属的那次往返可能还没被开号 ⇒ **先开号再取号**（条目与增量都在本文件这一层开，
 * 见 `countRoundTrips` 与 `noteDeltaRoundTrip`），于是同一次往返的思考、正文与工具调用落在
 * **同一个载体**里，不同往返的产出各占一条消息（号源与两条判据见 `run-state.ts`）。
 */
export function projectCodexMessages(
  payload: AppServerNotificationPayload,
  runState: CodexRunState,
  context: CodexMessageContext,
): CodexMessageProjection {
  const empty: CodexMessageProjection = { drafts: [], subagents: [] };

  if (payload.kind === 'agentMessageDelta') {
    /**
     * 增量也要在**开号那一处**过一道：`item/started` 与增量谁先到不由本层定，
     * 增量先到时不开号，这一段文本会落进上一次往返的载体（见 `noteDeltaRoundTrip`）。
     */
    noteDeltaRoundTrip(payload.threadId, 'agentMessage', payload.itemId, runState);
    return {
      drafts: [
        draft({
          vendorId: payload.itemId,
          threadId: payload.threadId,
          context,
          runState,
          role: 'assistant',
          chunk: 'delta',
          blockKind: 'text',
          blocks: [textBlockDraft(payload.delta, 'delta')],
          raw: payload,
        }),
      ],
      subagents: [],
    };
  }

  if (payload.kind === 'reasoningTextDelta' || payload.kind === 'reasoningSummaryDelta') {
    /**
     * 两条增量通道对应思考块的两档（**通道决定档位，不由家决定**）：
     * `item/reasoning/textDelta` 是完整推理正文，`item/reasoning/summaryTextDelta` 是厂商摘要。
     * 它们落进同一个载体的**不同槽位**（块序号按「载体 + 条目 + 块种」分配），因此一条推理条目
     * 可以同时有「全文」与「摘要」两块。
     *
     * 同时把增量记进台账：完成通知要靠它判断「这一块的快照该不该补、补什么」——
     * 只回密文的路由上全文永远不写在 `content[]` 里，那块就只剩增量这一条命。
     */
    const full = payload.kind === 'reasoningTextDelta';
    // 同上：推理增量与它的 `item/started` / `item/completed` 必须落在同一个号上
    noteDeltaRoundTrip(payload.threadId, 'reasoning', payload.itemId, runState);
    const key = deltaKey(payload.threadId, payload.itemId);
    const entry = runState.reasoningDeltas.get(key) ?? {};
    if (full) entry.full = `${entry.full ?? ''}${payload.delta}`;
    else entry.summary = `${entry.summary ?? ''}${payload.delta}`;
    runState.reasoningDeltas.set(key, entry);
    return {
      drafts: [
        draft({
          vendorId: payload.itemId,
          threadId: payload.threadId,
          context,
          runState,
          role: 'assistant',
          chunk: 'delta',
          blockKind: full ? 'reasoning-full' : 'reasoning-summary',
          blocks: [thinkingBlockDraft(payload.delta, full ? 'full' : 'summary', 'delta')],
          raw: payload,
        }),
      ],
      subagents: [],
    };
  }

  if (payload.kind === 'itemStarted' || payload.kind === 'itemCompleted') {
    /**
     * 两条通知走同一个归一函数，**但推理条目必须分开**：`item/started` 的推理条目两格都是空数组
     * （实测），那是「开始推理了」的占位，不是「这一轮没有文本」的结论（见 `projectItem`）。
     *
     * **开号也在这一处**，不假定行级投影（`events.ts`）已经跑过：生产接线里那边确实先跑、
     * 这里的调用是幂等的空转（同一身份只开一次），但消息的合并键**不能**依赖另一层的执行顺序
     * ——只走内容级的消费方（收尾回读、单测）若漏了那一层，整批条目会共用一个号、被折叠成一条。
     */
    countRoundTrips(payload.item, payload.threadId, runState);
    return projectItem(payload.item, payload.threadId, payload, runState, context, payload.kind === 'itemStarted');
  }

  if (payload.kind === 'turnPlanUpdated') {
    /**
     * `turn/plan/updated` 是**整表覆盖**的清单快照（不是调用）：产物与 `plan` 条目同形，
     * 于是界面上的计划卡片只有一张、由 `family: 'task'` + `payload.kind: 'plan'` 驱动。
     * 协议层这一侧没有 `explanation`（那是 `TurnPlanUpdatedNotification` 的字段，本仓的窄声明未收）
     * ⇒ `note` 记 `null`，不拿步骤文本凑。
     */
    return {
      drafts: [
        draft({
          vendorId: null,
          threadId: payload.threadId,
          context,
          runState,
          role: 'assistant',
          chunk: 'snapshot',
          blockKind: 'plan',
          blocks: [
            toolCallBlockDraft(
              planCallId(payload.threadId, payload.turnId),
              PLAN_TOOL_NAME,
              { plan: payload.steps.map((one) => ({ step: one.step, status: one.status })) },
              'codex',
            ),
          ],
          raw: payload,
        }),
      ],
      subagents: [],
    };
  }

  /**
   * 两条**没有渲染消费点**的增量通道：显式丢弃并计数（三家统一的「非渲染增量」表）。
   *
   * 为什么不能落到函数末尾的 `return empty`：那样「我们主动丢了」与「上游压根没发」
   * 在日志里**长得一模一样**，排障时只能靠猜。这里登记进 `runState.droppedDeltas`，
   * 收尾由 `finalizeCodex` 打一条 DEBUG 汇总；**只记数、不记正文**（记正文就是另一个 O(n²) 文件）。
   *
   * 两条各自为什么可以丢：
   *   · `item/plan/delta` —— 计划是**整表覆盖**的清单（`turn/plan/updated` 已经出计划卡片），
   *     逐字流没有中间态可渲染；
   *   · `item/commandExecution/outputDelta` —— 命令输出在工具结果里有一份完整的，
   *     逐字流进界面只会把卡片刷屏。
   */
  if (payload.kind === 'planDelta' || payload.kind === 'commandOutputDelta') {
    runState.droppedDeltas.set(payload.kind, (runState.droppedDeltas.get(payload.kind) ?? 0) + 1);
    return empty;
  }

  return empty;
}

/** 归一一条已完成的条目（运行期通知与收尾读回的条目走**同一个函数**，两侧不可能漂移） */
function projectItem(
  item: AppServerItem,
  threadId: string,
  raw: unknown,
  runState: CodexRunState,
  context: CodexMessageContext,
  /** 这一条来自 `item/started`（内容还没到）而不是 `item/completed`（内容已定） */
  started: boolean,
): CodexMessageProjection {
  const where = { vendorId: item.id === '' ? null : item.id, threadId, context, runState, raw, chunk: 'snapshot' as const, blockKind: 'item' };
  if (item.kind === 'agentMessage') {
    // 空正文不产消息（契约的 `text` 是 `string`，一条空块在界面上只是一行空白）
    if (item.text === '') return { drafts: [], subagents: [] };
    return {
      drafts: [draft({ ...where, role: 'assistant', blockKind: 'text', blocks: [textBlockDraft(item.text, 'snapshot')] })],
      subagents: [],
    };
  }
  if (item.kind === 'reasoning') {
    /**
     * `item/started` 的推理条目**不产块**：那一刻 `summary` / `content` 都是空数组，而在这个位置上
     * 「空数组」只说明**还没到**，不说明「没有文本」。落一块空快照的代价是**后面每一个字都被丢掉**——
     * 合并器的槽位一旦被快照 seal，随后的 `item/reasoning/textDelta` 会被「已 seal + 增量 ⇒ 丢弃」
     * 整段扔掉，而完成通知又不补封口，于是那一块永远停在 `text: null` + `none`。
     * 症状（`messageId: run-codex:N` 的产物）：5020/5020 个思考块全是这个形状，
     * 界面上就是「思考信息没采到」。文本由增量累积、由 `item/completed` 封口（见 `reasoningDrafts`）。
     */
    if (started) return { drafts: [], subagents: [] };
    return { drafts: reasoningDrafts(item, where, runState), subagents: [] };
  }
  if (item.kind === 'commandExecution') {
    return { drafts: commandDrafts(item, where, started), subagents: [] };
  }
  if (item.kind === 'fileChange') {
    return { drafts: fileChangeDrafts(item, where), subagents: [] };
  }
  if (item.kind === 'mcpToolCall') {
    return { drafts: mcpDrafts(item, where), subagents: [] };
  }
  if (item.kind === 'plan') {
    return {
      drafts: [
        draft({
          ...where,
          role: 'assistant',
          blockKind: 'plan',
          blocks: [
            toolCallBlockDraft(
              item.id,
              PLAN_TOOL_NAME,
              { plan: item.text === '' ? [] : [{ step: item.text, status: 'unknown' }] },
              'codex',
            ),
          ],
        }),
      ],
      subagents: [],
    };
  }
  if (item.kind === 'webSearch') {
    return { drafts: webSearchDrafts(item, where), subagents: [] };
  }
  if (item.kind === 'dynamicToolCall') {
    return {
      drafts: [draft({ ...where, role: 'assistant', blockKind: 'tool-call', blocks: [dynamicCallBlock(item)] })],
      subagents: [],
    };
  }
  if (item.kind === 'collabToolCall') {
    return projectCollab(item, threadId, raw, runState, context, started);
  }
  if (item.kind === 'subAgentActivity') {
    return { drafts: [], subagents: [subAgentActivityRecord(item, threadId, runState, context)] };
  }
  if (item.kind === 'other') {
    /**
     * **未识别的条目类型**：产一条 `unrecognized` 块把厂商原文留下。
     *
     * 为什么不能什么都不产：未识别的**方法**有 `unknownEventDraft` 兜底，未识别的**类型**此前
     * 两处投影（本函数与 `events.ts` 的 `activityDrafts`）都没有分支，也没有 `usage` / 轮次留痕
     * ⇒ 厂商真投了、我们一个字都不留。真机读数（真 `codex app-server` + 脚本式上游让模型调
     * `view_image`，`imageView` 帧两投）：事件流与消息账本对它的命中数都是 **0**，而同一次运行里
     * 已归一的 `commandExecution` 留了痕——「厂商没发」与「厂商发了、我们没接」因此在产物里长得
     * 一模一样，正是排障最贵的那类假相等。
     *
     * 只在 `item/completed` 产（`item/started` 那一刻内容还没定，与 `fileChange` / `agentMessage`
     * 同一条口径）；代价是半途被中断的那一条只剩 `started`，此时不留痕——与其余块种一致。
     * 块的 `vendorType` 取厂商的 `type` 原文，`raw` 是条目对象原文（见 `AppServerItem` 的 `other` 支）。
     */
    if (started) return { drafts: [], subagents: [] };
    return {
      drafts: [draft({ ...where, role: 'assistant', blockKind: 'item', blocks: [unrecognizedBlockDraft(item.type, item.raw)] })],
      subagents: [],
    };
  }
  /**
   * `userMessage`（喂进去的输入，不是模型产出）与 `toolOutput`（`functionCallOutput`：它是工具输出的
   * 旁路副本，而命令执行与 MCP 两条路已经各自带回了结果）**都不产出消息**，也不是丢弃
   * ——两者的原文各有归属：题面由编排层写进账本，工具结果由 `commandExecution` / `mcpToolCall` 带回。
   * 这一支今天不可达（上面两个 `other` 之外的类型都归一过了），留作类型收窄的兜底。
   */
  return { drafts: [], subagents: [] };
}

/**
 * 推理条目 → 至多两条消息（全文一块、摘要一块）。
 *
 * 档位判据（**逐字对齐计划表**）：
 *   · `content[]` 非空 ⇒ 思考**全文**（`textKind: 'full'`，`source: 'wire'`）；
 *   · `content[]` **为空**（上游只回密文）⇒ 正文 `null` + `'none'`，**绝不回落到 `summary` 冒充全文**。
 *     此时若摘要通道另有内容，它作为**摘要**那一块单独产出（`textKind: 'summary'`）——
 *     两块各自说清自己是什么，而不是让摘要顶替全文。
 *
 * 增量通道（`item/reasoning/textDelta` 与 `.../summaryTextDelta`）先到时会各占一个槽位，
 * 完成通知必须**补同一槽位的快照**，否则那一块永远停在 `assembly: 'open'`（界面按「未收尾」呈现）。
 * 判据是「该通道有没有过增量」：有过 ⇒ 补快照封口（上游只回密文、但增量已经把全文推完时，
 * 快照就是那段增量本身）；没有过 ⇒ 那一条通道这一轮根本没内容，**不补空格**。
 *
 * ⚠️ **封口不可省**：`full` 与增量逐字相同时也**必须**发这一条快照。
 * 判据若写成「逐字相同 ⇒ 不重发，免得同一份内容说两遍」，代价是那一块**永远收不了尾**；
 * 而「内容相同」与「已收尾」是两件事，`assembly` 这一格只有快照能翻。重发是幂等的（覆盖语义）。
 */
function reasoningDrafts(
  item: Extract<AppServerItem, { kind: 'reasoning' }>,
  where: DraftEnvelope,
  runState: CodexRunState,
): MessageDraft[] {
  const full = joinLines(item.content);
  const summary = joinLines(item.summary);
  const streamed = runState.reasoningDeltas.get(deltaKey(where.threadId, item.id)) ?? null;
  const drafts: MessageDraft[] = [];
  /**
   * 全文那一块：**有过增量就必须补快照**（`full` 与逐字推完的增量同值时也照发）。
   * 封口是**必须动作**而不是可选重复——增量先到时槽位还是 `open`，不补这一条，那一块在界面上
   * 会永远挂着「思考中…」（`assembly: 'open'` 就是「未收尾」）。内容不变的重发是幂等的：
   * 合并器对同一个块标识是**覆盖**语义（`applyBlock` 的「已有键 + 快照 ⇒ 覆盖并 seal」）。
   */
  const fullText = full ?? streamed?.full ?? null;
  if (fullText !== null) {
    drafts.push(draft({ ...where, role: 'assistant', blockKind: 'reasoning-full', blocks: [thinkingBlockDraft(fullText, 'full', 'snapshot')] }));
  } else if (summary === null) {
    /**
     * 两处都没内容：落一块 `text: null` + `'none'`（「有思考但拿不到文本」，不是「没有思考」）。
     * 有摘要时由下面那块出摘要，这里的空块不出（避免同一件事两块）。
     */
    drafts.push(draft({ ...where, role: 'assistant', blockKind: 'reasoning-full', blocks: [thinkingBlockDraft(null, 'none', 'snapshot')] }));
  }
  // 摘要那一块同理：有摘要（或摘要只走了增量）就得补快照封口
  const summaryText = summary ?? streamed?.summary ?? null;
  if (summaryText !== null) {
    drafts.push(draft({ ...where, role: 'assistant', blockKind: 'reasoning-summary', blocks: [thinkingBlockDraft(summaryText, 'summary', 'snapshot')] }));
  }
  return drafts;
}

/**
 * `commandExecution` → 调用 + 结果两条消息。
 *
 * 调用块的工具真名用 `exec_command`（本仓工具表里 `run-shell` 那一族的真名），**不是**协议里的
 * 条目类型名——条目类型是派生名，界面的族卡片按工具名判族。入参给 `{ command, cwd }`（真机
 * `command` 是字符串，`cwd` 是执行目录；两者都是这次调用的事实）。
 *
 * 结果块：`structured = { exitCode, durationMs }`（**取不到就整格 `null`，不是 `{}`**），
 * `isError` 只在**退出码非零**时为真。输出是 `aggregatedOutput`（stdout 与 stderr **合流**，
 * 拆不开 ⇒ 归一结果里不编 `stderr`）。
 *
 * ⚠️ **`item/started` 只出调用块，不出结果块**：那一刻退出码与输出都还没有，而这一家的结果块在
 * 那个状态下**不携带任何「还在跑」的信息**——`structured` 两格皆空 ⇒ 整格 `null`、`output` 是空串、
 * `isError` 是 `false`（契约里 `tool-result` 没有第三态，`false` 就是「没出错」这条断言）。
 * 代价有两层：跑动期界面显示「工具已返回空结果」；而块一旦以 snapshot 落进槽位就 **seal**，
 * 进程在命令中途被杀时，这条「成功、空输出」就是账本里的终态。结果等 `item/completed` 再出。
 */
function commandDrafts(
  item: Extract<AppServerItem, { kind: 'commandExecution' }>,
  where: DraftEnvelope,
  started: boolean,
): MessageDraft[] {
  if (item.id === '') return [];
  const output = item.output ?? '';
  const { truncated } = truncate(output);
  const call = draft({
    ...where,
    role: 'assistant',
    blockKind: 'tool-call',
    blocks: [toolCallBlockDraft(item.id, COMMAND_TOOL_NAME, { command: item.command, cwd: item.cwd }, 'codex', 'run-shell')],
  });
  if (started) return [call];
  return [
    call,
    draft({
      ...where,
      role: 'tool',
      blockKind: 'tool-result',
      blocks: [
        toolResultBlockDraft(item.id, output, {
          structured: item.exitCode === null && item.durationMs === null ? null : { exitCode: item.exitCode, durationMs: item.durationMs },
          isError: item.exitCode !== null && item.exitCode !== 0,
          // 本家不给截断标记 ⇒ 只有自己截过才算「确认被截断」，其余记 `unknown`（输出可能不完整）
          ...(truncated ? { truncation: { kind: 'truncated' as const, reason: '超过工具结果上限' } } : {}),
        }),
      ],
    }),
  ];
}

/**
 * `fileChange` → 调用 + 结果两条消息（工具名 `apply_patch`，`edit-file` 族）。
 *
 * 契约：调用块的入参给 `{ changes }`（`path` / `kind`，厂商原文），结果块的结构化格给
 * `{ changes, status }`——`status` 是 `completed` / `failed` / `declined` / `inProgress`，
 * `failed` 与 `declined` 都算错误（一次被拒的补丁与一次失败的补丁在界面上都该显眼）。
 */
function fileChangeDrafts(item: Extract<AppServerItem, { kind: 'fileChange' }>, where: DraftEnvelope): MessageDraft[] {
  if (item.id === '') return [];
  const changes = item.changes.map((one) => ({ path: one.path, kind: one.kind }));
  return [
    draft({
      ...where,
      role: 'assistant',
      blockKind: 'tool-call',
      blocks: [toolCallBlockDraft(item.id, APPLY_PATCH_TOOL_NAME, { changes }, 'codex', 'edit-file')],
    }),
    draft({
      ...where,
      role: 'tool',
      blockKind: 'tool-result',
      blocks: [
        toolResultBlockDraft(item.id, '', {
          structured: { changes, status: item.status },
          isError: item.status === 'failed' || item.status === 'declined',
        }),
      ],
    }),
  ];
}

/**
 * `mcpToolCall` → 调用 + 结果两条消息（**新增能力**）。
 *
 * 三条判据：
 *   · `name = 'mcp__<server>__<tool>'`——与共享约定（`contracts` 的 `MCP_TOOL_NAME_PREFIX`）
 *     以及另几家**同形**；厂商给的就是 `namespace: 'mcp__<server>'` + `name: '<tool>'` 这一对，
 *     拼成扁平串时那个前缀属于原名的一部分，不能丢。MCP 工具**不进那十族**（它承载任意工具，猜一个族等于编一个事实）
 *     ⇒ `family` 显式记 `null`，界面走通用渲染并保留原名；
 *   · `isError = error != null`（协议给的是**错误对象**，不是布尔）：未完成时 `result` / `error`
 *     都是 `null` ⇒ 不判错、也不断言成功；
 *   · 结果正文取 `result.content[].text`；拿不到文本而错误对象有 `message` 时用后者（错误文案是
 *     这一次调用的**结果**，不是另一次）。
 */
function mcpDrafts(item: Extract<AppServerItem, { kind: 'mcpToolCall' }>, where: DraftEnvelope): MessageDraft[] {
  if (item.id === '') return [];
  const name = `${MCP_TOOL_NAME_PREFIX}${item.server}__${item.tool}`;
  const error = item.error as Record<string, unknown> | null;
  const errorMessage = typeof error?.message === 'string' ? error.message : null;
  const text = contentText((item.result as { content?: unknown } | null)?.content) ?? errorMessage ?? '';
  const { truncated } = truncate(text);
  return [
    draft({
      ...where,
      role: 'assistant',
      blockKind: 'tool-call',
      blocks: [toolCallBlockDraft(item.id, name, item.arguments ?? null, 'codex', null)],
    }),
    draft({
      ...where,
      role: 'tool',
      blockKind: 'tool-result',
      blocks: [
        toolResultBlockDraft(item.id, text, {
          // `result` 缺席时结构化格记 `null`（**不是 `{}`**）
          structured: item.result ?? null,
          isError: item.error !== null && item.error !== undefined,
          ...(truncated ? { truncation: { kind: 'truncated' as const, reason: '超过工具结果上限' } } : {}),
        }),
      ],
    }),
  ];
}

/** `webSearch` → 调用 + 结果两条：`query` 即入参；结果条目的结构化出口这一层拿不到 ⇒ `null` */
function webSearchDrafts(item: Extract<AppServerItem, { kind: 'webSearch' }>, where: DraftEnvelope): MessageDraft[] {
  if (item.id === '') return [];
  return [
    draft({
      ...where,
      role: 'assistant',
      blockKind: 'tool-call',
      blocks: [toolCallBlockDraft(item.id, 'web_search', { query: item.query }, 'codex')],
    }),
    draft({
      ...where,
      role: 'tool',
      blockKind: 'tool-result',
      blocks: [toolResultBlockDraft(item.id, '', { structured: null, isError: false })],
    }),
  ];
}

/**
 * `dynamicToolCall` → 一条调用消息（工具名取 `namespace.tool`，与 MCP 同一条口径）。
 * 结果不在这里编造：`contentItems` 是厂商给的内容块数组，而本层的工具结果块只承载文本 +
 * 结构化载荷，硬塞进去会得到一个既不是文本也不是结构的四不像 ⇒ 只出调用，结果留空。
 */
function dynamicCallBlock(item: Extract<AppServerItem, { kind: 'dynamicToolCall' }>): ReturnType<typeof toolCallBlockDraft> {
  const name = item.namespace === null ? item.tool : `${item.namespace}.${item.tool}`;
  return toolCallBlockDraft(item.id, name, item.arguments ?? null, 'codex', null);
}

/**
 * `collabAgentToolCall` → 派发调用的那一块 + 每个收件线程一条子任务行。
 *
 * 配对键是**条目 id**：它同时写进子任务行的 `parentCallId`，两侧同值 ⇒ 界面能把「进入子任务」
 * 这个入口挂到这次调用上（`buildAgentLogModel` 用 `spawnedBy.callId` 去时间轴上找那次调用）。
 * 入参只留 `prompt`：载荷里另外那些（`model` / `reasoningEffort` / `agentsStates`）是**编排内部状态**，
 * 不是这次工具调用的入参，混进去会让「参数原文」变得不可读。
 */
function projectCollab(
  item: Extract<AppServerItem, { kind: 'collabToolCall' }>,
  threadId: string,
  raw: unknown,
  runState: CodexRunState,
  context: CodexMessageContext,
  /** 这一帧来自 `item/started`（内容还没到） */
  started: boolean,
): CodexMessageProjection {
  const callId = item.id === '' ? null : item.id;
  const subagents: SubagentRecord[] = [];
  for (const receiver of item.receiverThreadIds) {
    if (receiver === '') continue;
    /**
     * 派发台账：收尾时给子线程补行要用同一份（身份 + 派发方式 + 父线程）。
     *
     * **只有派发动作能写这一格，而且先到的赢**：`wait` / `closeAgent` 与 `spawnAgent` 共享
     * `receiverThreadIds`，而真机顺序是派发在后（receiver id 要到 `item/completed` 才出现，
     * `wait` 在 `item/started` 就带着它）⇒ 无条件覆盖必然让台账停在**等待**那次调用上，
     * 于是子任务行的 `kind` 变成 `wait`、`parentCallId` 指向等待调用，界面按它去时间轴找
     * 「进入子任务」的入口就落到了错的卡片上。判据与 `events.ts` 的 `isDispatch` 同源（名字以
     * `spawn` 开头），两处各写一遍必然漂移。
     */
    if (callId !== null && isDispatchTool(item.tool) && !runState.dispatches.has(receiver)) {
      runState.dispatches.set(receiver, { tool: item.tool, callId, parentThreadId: threadId });
    }
    /**
     * **这一帧对这条子线程什么也没说时不产记录**（真机读数：`wait` / `closeAgent` 的 `item/started`
     * 带 `agentsStates: {}`，而折叠是整条覆盖 ⇒ 它会把已经采到的 `completed` / `outcome` 打回
     * `unknown/unverified` + `null`，且那一帧恰好排在 `completed` **之后**）。
     * 判据是「这一帧有没有这条子线程的状态格」——将来某一版在 started 就带上状态时，它照旧出记录。
     */
    if (started && !item.agentsStates.some((one) => one.threadId === receiver)) continue;
    subagents.push(dispatchRecord(receiver, threadId, item.agentsStates, runState, context));
  }
  if (callId === null) return { drafts: [], subagents };
  return {
    drafts: [
      draft({
        vendorId: callId,
        threadId,
        context,
        runState,
        role: 'assistant',
        chunk: 'snapshot',
        blockKind: 'tool-call',
        /**
         * 族按**工具名**判（走 `toolCallBlockDraft` 的缺省参数，即 `classifyTool`）：`spawn_agent` 是
         * 本仓工具表里的 `spawn-agent`，而 `wait` / `close_agent` 这类协作动作名判不出来 ⇒ `null`
         * （走通用渲染）。这里**不能**显式传 `null`——那会绕开归类，把派发调用也降级成通用行。
         */
        blocks: [toolCallBlockDraft(callId, item.tool, { prompt: item.prompt }, 'codex')],
        raw,
      }),
    ],
    subagents,
  };
}

/**
 * 派发条目里的子任务行（运行期就能落，不必等收尾）。
 *
 * 状态**三档**，由协议给的 `CollabAgentStatus` 直接推出（不再只有「完成 / 未知」两档）：
 * `completed` → `completed`；`errored` / `notFound` → `failed`；`interrupted` / `shutdown` → `stopped`；
 * `pendingInit` / `running` → `running`。取值不在这一档里 ⇒ `unknown` + `statusMissing: 'unverified'`
 * （「这个取值我没见过」与「还没跑完」是两件事，界面要能分开说）。
 */
function dispatchRecord(
  threadId: string,
  senderThreadId: string,
  states: Array<{ threadId: string; status: string; message: string | null }>,
  runState: CodexRunState,
  context: CodexMessageContext,
): SubagentRecord {
  const state = states.find((one) => one.threadId === threadId) ?? null;
  const { status, statusMissing } = collabStatusOf(state?.status ?? null);
  const dispatch = runState.dispatches.get(threadId) ?? null;
  const facts = rememberSubagentFacts(runState, threadId, {
    kind: dispatch?.tool ?? null,
    outcome: state?.message ?? null,
    parentCallId: dispatch?.callId ?? null,
    parentSubagentId: nestedParentOf(senderThreadId, runState, context),
  });
  return {
    subagentId: threadId,
    name: runState.nicknames.get(threadId) ?? null,
    kind: facts.kind,
    source: 'wire',
    status,
    statusMissing,
    outcome: facts.outcome,
    parentCallId: facts.parentCallId,
    parentSubagentId: facts.parentSubagentId,
    usage: null,
  };
}

/**
 * 这次协作调用是不是**派发**（而不是 `wait` / `closeAgent` 这类对已有子线程的操作）。
 *
 * 判据是「名字以 `spawn` 开头」而不是一张精确名表：真机见到的是 camelCase 的 `spawnAgent`，
 * 而协议把这一族的名字留成自由字符串 ⇒ 精确匹配会在厂商换个拼法时**静默**失效。
 * 导出是为了让 `events.ts`（活动行那一句）与本文件（派发台账）共用同一把判据——各写一遍必然漂移。
 */
export function isDispatchTool(tool: string): boolean {
  return tool.toLowerCase().startsWith('spawn');
}

/** `CollabAgentStatus` → 契约五态；推不出来的一律 `unknown` + `unverified` */
export function collabStatusOf(vendorStatus: string | null): { status: SubagentRecord['status']; statusMissing: SubagentRecord['statusMissing'] } {
  if (vendorStatus === 'completed') return { status: 'completed', statusMissing: null };
  if (vendorStatus === 'errored' || vendorStatus === 'notFound') return { status: 'failed', statusMissing: null };
  if (vendorStatus === 'interrupted' || vendorStatus === 'shutdown') return { status: 'stopped', statusMissing: null };
  if (vendorStatus === 'pendingInit' || vendorStatus === 'running') return { status: 'running', statusMissing: null };
  return { status: 'unknown', statusMissing: 'unverified' };
}

/**
 * `subAgentActivity` → 子任务行的状态刷新（**不产消息**：它是活动条目，不是内容）。
 * 四档 `kind` 逐档映射见 `subAgentActivityStatus`（活动行那边读的是**同一个函数**，两处不许各写一份）。
 */
function subAgentActivityRecord(
  item: Extract<AppServerItem, { kind: 'subAgentActivity' }>,
  senderThreadId: string,
  runState: CodexRunState,
  context: CodexMessageContext,
): SubagentRecord {
  const threadId = item.agentThreadId;
  const status = subAgentActivityStatus(item.activity);
  const dispatch = runState.dispatches.get(threadId) ?? null;
  const facts = rememberSubagentFacts(runState, threadId, {
    kind: dispatch?.tool ?? null,
    // 活动条目本身不带结论 ⇒ 不覆盖已经采到的那一份（非 null 才覆盖，见 rememberSubagentFacts）
    outcome: null,
    parentCallId: dispatch?.callId ?? null,
    parentSubagentId: nestedParentOf(senderThreadId, runState, context),
  });
  return {
    subagentId: threadId,
    name: runState.nicknames.get(threadId) ?? null,
    kind: facts.kind,
    source: 'wire',
    status,
    statusMissing: status === 'unknown' ? 'unverified' : null,
    outcome: facts.outcome,
    parentCallId: facts.parentCallId,
    parentSubagentId: facts.parentSubagentId,
    usage: null,
  };
}

/**
 * `subAgentActivity.activity` → 契约五态：`completed` → `completed`，`interrupted` → `stopped`，
 * `started` / `interacted` → `running`，其余 → `unknown`（**不猜**）。
 * 导出是因为活动行（`events.ts`）也要按同一张表判「这是不是收场」——两份实现必然漂移。
 */
export function subAgentActivityStatus(activity: string): SubagentRecord['status'] {
  if (activity === 'completed') return 'completed';
  if (activity === 'interrupted') return 'stopped';
  if (activity === 'started' || activity === 'interacted') return 'running';
  return 'unknown';
}

/**
 * 嵌套父链（`parentSubagentId` 是「嵌套父链；**顶层子任务为 `null`**」）。
 *
 * 判据是**派发者是不是主线程**：`spawn_agent` 从主线程派出去的那些子线程，协议给的
 * `senderThreadId` 就是主线程 id，而它们在会话树上属于**顶层**——照抄主线程 id 会指向一个
 * 不存在的节点（主会话那一节的 id 是 `main`），界面上的表现是「面包屑里『主会话』那一段消失」。
 * 父本身就是一条子线程（嵌套）时才交出 id；父线程未知时同样记 `null`（**不猜**）。
 */
function nestedParentOf(senderThreadId: string, runState: CodexRunState, context: CodexMessageContext): string | null {
  if (senderThreadId === '' || senderThreadId === context.mainThreadId) return null;
  return senderThreadId;
}

/** 消息信封：除 `role` / `blocks` 外的那几格，四条出口共用一份形状 */
interface DraftEnvelope {
  vendorId: string | null;
  threadId: string;
  context: CodexMessageContext;
  runState: CodexRunState;
  raw: unknown;
  /** 块形态：增量片段 `'delta'`、完整内容 `'snapshot'` */
  chunk: MessageDraft['chunk'];
  /** 块种（同一条目里区分全文 / 摘要 / 工具块；参与块序号的分配键） */
  blockKind: string;
}

/**
 * 一条消息草稿。
 *
 * `roundTrip` 在**这里**统一取号（而不是各自算）：它的语义是「这条消息属于该会话的第几次模型往返」，
 * 而号源就是 `run-state.ts` 的答复条目计数。取号前**先把本条计入**——`item/started` 与它的增量
 * 必须落在同一个号上，否则合并键会把同一块拆成两条逻辑消息。
 *
 * 块序号同样在这里分配（`run-state.ts` 的 `blockIndexFor`）：同一个「载体 + 条目 + 块种」重复投递
 * 拿到同一个号（增量与快照因此合到一块），不同块各占一个新号（推理块与正文块不会互相覆盖）。
 */
function draft(envelope: DraftEnvelope & { role: MessageDraft['role']; blocks: MessageDraft['blocks'] }): MessageDraft {
  const { threadId, context, runState } = envelope;
  const subagentId = threadId === context.mainThreadId ? null : threadId;
  /**
   * 轮次号取**这条条目自己那一次往返**（`roundTripForItem`，第一次问就钉住），
   * 不是「该线程此刻累计几轮」——后者会让收尾全量回读的那一批条目整批落到最终号上，
   * 与运行期算出的号对不上，于是同一条条目出两份（机制见 `run-state.ts` 的 `itemRoundTrip`）。
   */
  const roundTrip = roundTripForItem(runState, threadId, envelope.vendorId ?? '');
  /**
   * 载体键 = `subagentId` + 轮次 + `role`——与 `message.ts`（公共层）的 `carrierKeyOf` 同口径，
   * 只是不含 `parentCallId`（codex 的消息这一格恒 `null`）。**必须带 `role`**：同一个轮次里
   * 「调用」与「结果」是两条消息、各自的块序号从 0 起算，不带 `role` 会让结果块覆盖调用块。
   */
  const carrier = [subagentId ?? 'main', String(roundTrip), envelope.role].join('|');
  const index = blockIndexFor(runState, carrier, envelope.vendorId ?? '', envelope.blockKind);
  return {
    vendorId: envelope.vendorId,
    role: envelope.role,
    source: 'wire',
    roundTrip,
    // 厂商轮号是 `Turn.id`（标识，不是序号）⇒ 不冒充数字；这一家没有「一轮内第几次调用」
    turn: null,
    step: null,
    // 派生关系挂在子任务行的 `parentCallId` 上（消息这一格留给工具结果与调用的配对）
    parentCallId: null,
    subagentId,
    chunk: envelope.chunk,
    // 块标识统一用块序号（新块只能追加到末尾，见 `run-state.ts` 的 `blockIndexFor`）
    blocks: envelope.blocks.map((one) => ({ ...one, identity: { kind: 'index' as const, index } })),
    /**
     * 消息级用量：**结构性给不出**（app-server 只到线程级，差分无法证明归属）⇒ 恒 `null`（不是 0）。
     * 界面因此不给它画页脚——与另两家「有就给」的差别是真实的能力差，登记在能力声明里。
     */
    usage: null,
    raw: envelope.raw,
  };
}

/** 计划类调用的工具名（`update_plan` 在本仓工具表里落 `task` 族，与 claude / dsh 的清单工具同族） */
const PLAN_TOOL_NAME = 'update_plan';
/**
 * 命令执行的工具真名（`exec_command` 是模型实际拿到的名字；条目类型 `commandExecution` 是派生名）。
 * 导出：活动行（`events.ts`）要与工具块用**同一个名字**，各写一份必然漂移。
 */
export const COMMAND_TOOL_NAME = 'exec_command';
/** 文件改动的工具真名（协议只给「有改动」，真名按这一家补丁工具的语义取）；导出理由同上 */
export const APPLY_PATCH_TOOL_NAME = 'apply_patch';

/** 计划条目的调用 id：`turn/plan/updated` 没有条目 id，用「线程 + 轮」合成一个稳定键 */
function planCallId(threadId: string, turnId: string): string {
  return `plan:${threadId}:${turnId}`;
}

/**
 * 一条「提问调用」的消息草稿。
 *
 * 为什么单列：这一家的提问走 **server→client 请求** `item/tool/requestUserInput`，而厂商的线程条目
 * 里**没有这一格**（`ThreadItem` 的变体逐个核对过）⇒ 它永远不进通知流，账本里那**提问的一半**
 * 只能由观察到这次请求的适配器补出来。不补的症状是界面上只剩一条没有题目的答复行。
 *
 * 形状与另三家 wire 上那条 assistant `tool-call` **逐字同形**：`family` 由公共层按工具名归族
 * （`request_user_input` → `ask-user`）、`payload` 由公共层从入参归一 ⇒ 展示侧不必知道
 * 这一家的提问不走条目流。
 *
 * 两格取值理由：
 *   · `callId` 取厂商的 `itemId`——账本的另一半（编排层写的答复 `tool-result`）用的就是它，
 *     错开就是「有卡片没答案」；
 *   · `input` 只给**模型那一次调用**的形状（`questions`）：请求信封里的 `threadId` / `turnId` /
 *     `isBlocking` 是厂商的管道字段，抄进工具入参会被读成模型自己写的字；信封原文留在 `raw` 里供排障。
 */
export function askUserCallDraft(
  params: { itemId: string; threadId: string; questions: readonly CodexAskQuestion[] },
  runState: CodexRunState,
  context: CodexMessageContext,
): MessageDraft {
  return draft({
    vendorId: params.itemId === '' ? null : params.itemId,
    threadId: params.threadId,
    context,
    runState,
    raw: params,
    chunk: 'snapshot',
    blockKind: 'ask-user-call',
    role: 'assistant',
    blocks: [toolCallBlockDraft(params.itemId, CODEX_ASK_TOOL_NAME, { questions: params.questions }, 'codex')],
  });
}

/** 思考正文：`content[]`（已归一成字符串数组）拼行；空数组 ⇒ `null`（**不是空串**） */
function joinLines(parts: readonly string[]): string | null {
  const text = parts.filter((one) => one !== '').join('\n');
  return text === '' ? null : text;
}

/** MCP 结果的文本半边：`content[].text`（拿不到就给 `null`，让调用方决定回落） */
function contentText(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const one of content) {
    const text = (one as { text?: unknown } | null)?.text;
    if (typeof text === 'string' && text !== '') parts.push(text);
  }
  return parts.length === 0 ? null : parts.join('\n');
}

// ---------------------------------------------------------------------------
// 收尾：`reader` 交回的线程树 → 子任务行与子线程消息
// ---------------------------------------------------------------------------

/**
 * 子线程的轮次数（与主线程**同一把尺子**：`run-state.ts` 的答复条目计数在两个通道上是同一个函数）。
 * 收尾那一刻读数来自 `reader`，故先按条目补记，再取号。
 */
export function threadRoundTrips(content: { items: readonly AppServerItemEntry[] } | null, threadId: string, runState: CodexRunState): number {
  for (const entry of content?.items ?? []) countRoundTrips(entry.item, threadId, runState);
  return roundTripsOf(runState, threadId);
}

/**
 * `reader` 读回的一条线程 → 消息草稿（**只用于收尾补齐**）。
 *
 * 与运行期那条路**共用** `projectItem`：同一条条目在两个通道上归一出的块逐字段相同
 * （否则「实时看到的」与「收尾补上的」会在同一槽位上打架）。
 */
export function projectThreadMessages(
  threadId: string,
  items: readonly AppServerItemEntry[],
  runState: CodexRunState,
  context: CodexMessageContext,
): MessageDraft[] {
  const drafts: MessageDraft[] = [];
  for (const entry of items) {
    /**
     * **先开号、再归一**：这一条要按它自己所属的那次往返取号，而收尾读回的这一批条目
     * 很可能一条运行期通知都没走过（子线程的 `item/*` 推不推给本连接由上游决定）
     * ⇒ 号必须在这里补上，否则整批条目都停在 0（全部挤进同一条消息）。
     * 补齐是幂等的：运行期已经数过的条目在这里按身份去重、返回 `null`，不重复开号。
     */
    countRoundTrips(entry.item, threadId, runState);
    const projected = projectItem(entry.item, threadId, entry, runState, context, false);
    drafts.push(...projected.drafts);
  }
  return drafts;
}

/**
 * `reader` 读回的一条线程 → 子任务行（**终态三档由 `turn.status` / `turn.error` / `thread.status` 推出**）。
 *
 * 判据优先级（从最接近事实的证据往下）：
 *   ① 最后一条 `turn` 的 `status`：`completed` / `failed`（配 `error` 文案作 `outcome`）/ `interrupted`；
 *   ② 没有任何 `turn` 可读时看线程状态：`systemError` ⇒ `failed`，`active` ⇒ `running`；
 *   ③ 其余（`idle` / `notLoaded`）⇒ `unknown` + `statusMissing: 'not-observed'`。
 *      ⚠️ **不把 `idle` 当完成**：线程空闲说明不了这一轮跑成了什么（它也可能是刚被派发、还没开跑）。
 */
export function projectSubagentRecord(
  ref: AppServerThreadRef,
  thread: AppServerThread | null,
  runState: CodexRunState,
  context: CodexMessageContext,
): SubagentRecord {
  const dispatch = runState.dispatches.get(ref.threadId) ?? null;
  const derived = terminalStatusOf(ref, thread);
  const facts = rememberSubagentFacts(runState, ref.threadId, {
    kind: dispatch?.tool ?? null,
    // 读回那一份是权威的：拿得到就用它；拿不到（`idle` / 只有 tool 条目的线程）保留先采到的那一份
    outcome: outcomeOf(thread, derived.status),
    parentCallId: dispatch?.callId ?? null,
    parentSubagentId: nestedParentOf(ref.parentThreadId ?? '', runState, context),
  });
  return {
    subagentId: ref.threadId,
    // 昵称以 `reader` 给的那份为准（`Thread.agentNickname` / `thread_spawn.agent_nickname`），
    // 运行期从 `thread/started` 拿到的那份只作兜底
    name: ref.nickname ?? runState.nicknames.get(ref.threadId) ?? null,
    kind: facts.kind,
    source: 'wire',
    status: derived.status,
    statusMissing: derived.statusMissing,
    outcome: facts.outcome,
    parentCallId: facts.parentCallId,
    parentSubagentId: facts.parentSubagentId,
    /**
     * 子任务级用量：**只从运行期的 `thread/tokenUsage/updated` 取**（协议没有按线程读用量的请求）。
     * 这里不给近似值——`null` = 没采到；「全量或 null」的合成在 `index.ts` 收尾那一处做。
     */
    usage: usageForState(runState, ref.threadId),
  };
}

/** 该线程运行期采到的累计用量（读不到就是 `null`） */
function usageForState(runState: CodexRunState, threadId: string): UsageTokens | null {
  const threadUsage = runState.usageByThread.get(threadId);
  return threadUsage === undefined ? null : breakdownToTokens(threadUsage.total);
}

/**
 * 子任务终态：三档 + 「推不出来」。
 * 记 `unknown` 时**必须**给出缺失原因（契约的 `statusMissing`），否则界面无法区分
 * 「这一家没有状态这一格」与「这一次没采到」。
 */
export function terminalStatusOf(
  ref: AppServerThreadRef,
  thread: AppServerThread | null,
): { status: SubagentRecord['status']; statusMissing: SubagentRecord['statusMissing'] } {
  const lastTurn = thread?.turns.at(-1) ?? null;
  if (lastTurn !== null) {
    if (lastTurn.status === 'completed') return { status: 'completed', statusMissing: null };
    if (lastTurn.status === 'failed') return { status: 'failed', statusMissing: null };
    if (lastTurn.status === 'interrupted') return { status: 'stopped', statusMissing: null };
    if (lastTurn.status === 'inProgress') return { status: 'running', statusMissing: null };
    /**
     * **认不出的取值不读作「还在跑」**：`TurnStatus` 是开放枚举，而归一化层在这一格缺席时
     * 填的就是字符串 `'unknown'`（见 `protocol.ts` 的 `readTurn`）⇒ 把它说成 running 等于
     * 替厂商宣布一件我们并不知道的事，而 `statusMissing: null` 又断言「这一格我们采到了」。
     * 与同文件 `collabStatusOf` 的未知档同口径：记 `unknown` + `unverified`。
     */
    return { status: 'unknown', statusMissing: 'unverified' };
  }
  if (ref.status.type === 'systemError') return { status: 'failed', statusMissing: null };
  if (ref.status.type === 'active') return { status: 'running', statusMissing: null };
  /**
   * `idle` / `notLoaded`：这一档**推不出**终态（`idle` 也可能是「刚被派发、还没开跑」，
   * 拿它当 `completed` 会让一次失败的子任务显示成做完了）。记 `unknown` + 点名原因。
   */
  return { status: 'unknown', statusMissing: 'not-observed' };
}

/**
 * 子任务行的 `outcome`（那一行上「它最后交代了什么」）。
 *
 * **失败那一档优先给厂商的失败原因**：`turn.error` 是这条子线程为什么没跑成的唯一出处，
 * 而最后一条答复正文多半是它失败**之前**说的话——拿后者顶替会让行上写着一句听起来正常的
 * 结论，而真正的原因（鉴权、超限、沙箱）一个字都看不到。拿不到原因时才退回最后一条答复。
 */
function outcomeOf(thread: AppServerThread | null, status: SubagentRecord['status']): string | null {
  const lastTurn = thread?.turns.at(-1) ?? null;
  if (status === 'failed' && lastTurn?.error != null && lastTurn.error !== '') return lastTurn.error;
  return lastAgentText(thread);
}

/** 子线程最后一条答复正文（`outcome` 只放文本，拿不到就是 `null`） */
function lastAgentText(thread: AppServerThread | null): string | null {
  for (let index = (thread?.turns.length ?? 0) - 1; index >= 0; index -= 1) {
    const turn = thread?.turns[index];
    for (let itemIndex = (turn?.items.length ?? 0) - 1; itemIndex >= 0; itemIndex -= 1) {
      const item = turn?.items[itemIndex];
      if (item?.kind === 'agentMessage' && item.text !== '') return item.text;
    }
  }
  return null;
}

/** 推理增量的台账键：条目 id 只在**线程内**唯一，故带上线程 id（跨线程撞 id 会把两块串在一起） */
function deltaKey(threadId: string, itemId: string): string {
  return `${threadId}|${itemId}`;
}

/**
 * 由 `thread/started` 通知登记子线程昵称（`Thread.agentNickname` 的原生来源）。
 * 为什么收在这一处：昵称只在子任务行上展示，而子线程可能在**它自己第一条条目到达之前**
 * 就派发了若干消息 ⇒ 登记得越早，行上的名字越早对得上（收尾时 `reader` 会给更权威的一份）。
 */
export function noteThreadStarted(
  threadId: string,
  nickname: string | null,
  runState: CodexRunState,
): void {
  if (nickname === null || nickname === '') return;
  runState.nicknames.set(threadId, nickname);
}
