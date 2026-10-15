/**
 * 一次 codex 运行的**跨通知状态**（app-server 通道）。
 *
 * 为什么单独一个文件：`events.ts`（行级）与 `message.ts`（内容级）都要读同一把尺子与同一份台账，
 * 而两处各建一份必然漂移——漂移的症状是「轮次与子任务行对不上」这种看不出是谁错的错。
 * 这里只放**事实与计数**，不放任何展示口径。
 *
 * 三条约定：
 *   1. **轮次按线程分别开号**：`roundTripKeys` 的键是线程 id，值是那一线程见过的
 *      **模型往返身份**集合（身份 = 模型产出条目 id 的后缀，同一次响应的推理与答复共享它，
 *      取法与两条判据见 `countRoundTrips`）。一次模型往返算一票 ⇒ `size` 就是该线程的往返数。
 *      主线程与子线程各数各的，谁都不借用谁的号。
 *   2. **用量按线程记累计快照**：`usageByThread` 的值是厂商自报的 `ThreadTokenUsage`
 *      （`total` 累计 + `last` 最近一轮），**只从运行期的 `thread/tokenUsage/updated` 来**
 *      ——协议没有「按线程读用量」的请求。这里不做差分、不做归属推断。
 *   3. **派发台账只记观测到的事实**：`dispatches` 的键是子线程 id，值是「谁派发了它、用的哪次调用」。
 *      昵称来自 `thread/started` 的 `Thread.agentNickname`；收尾时 `reader` 给出更权威的一份。
 */
import type { VendorSkill } from '@aieval/contracts';
import type { AppServerItem, AppServerThreadUsage } from './appserver/protocol';

/** 一个子线程的派发台账（身份在本行的运行期就能拿到，不必等收尾） */
export interface CodexDispatch {
  /** 派发动作名（`spawn_agent` / `wait` …）；采不到为 `null` */
  tool: string | null;
  /** 派发那次**工具调用**的 id：子任务行的 `parentCallId` 与调用块的 `callId` 同值才谈得上配对 */
  callId: string | null;
  /** 派发者的线程 id（嵌套父链的判据：`null` = 主线程派发的 ⇒ 顶层子任务） */
  parentThreadId: string | null;
}

/**
 * 子任务行上**不许被后来的帧抹掉**的那几格（口径与套件的 `PRESERVED_SUBAGENT_FIELDS` 同源：
 * `name` 走昵称表、`usage` 走用量表，各自另有真源，这里只收另外四格）。
 */
export interface CodexSubagentFacts {
  kind: string | null;
  outcome: string | null;
  parentCallId: string | null;
  parentSubagentId: string | null;
}

export interface CodexRunState {
  /**
   * `线程 id → 见过的模型往返身份`（一票一轮，`size` 就是往返数）。
   *
   * ⚠️ 身份**不是**答复条目 id：一次模型往返里只有收尾那次会发 `agentMessage`，中间那些
   * 「想 + 调工具」的往返一条答复都没有。按答复条目去重的话，整个 turn 的条目都会落在同一个号上，
   * 而合并键（`subagentId|roundTrip|role|parentCallId`）里只有 `roundTrip` 能区分同角色的消息
   * ⇒ 整轮的思考、工具调用与最终答复被合并成一条。身份的取法与两条判据见 `countRoundTrips`。
   */
  roundTripKeys: Map<string, Set<string>>;
  /**
   * `线程 id → 最近一次模型产出之后有没有工具活动`。
   *
   * 只在**拿不到往返身份**（条目 id 里没有分隔符）时兜底判「这是不是新的一次往返」；
   * 身份拿得到时它不参与判号。工具活动条目自己照旧不给轮次（`countRoundTrips` 返回 `null`）。
   */
  toolActivitySinceOutput: Map<string, boolean>;
  /**
   * `线程 id|条目 id → 这条条目所属那次模型往返的号`（**一经登记不再变**）。
   *
   * 为什么必须有这一格：消息的载体键里带轮次号，而同一条条目有**两条入口**——运行期的
   * `item/*` 通知与收尾 `thread/read` 的全量回读。号若按「该线程当前累计值」现算，两条入口
   * 会算出不同的号：运行期是逐条推进的（当下值恰好是本条的号），而收尾那一批条目**已经数过**
   * （`countRoundTrips` 按身份去重、不再推进）⇒ 整批都读到**最终号**。
   *
   * 后果是重复而不是覆盖：载体键不同 ⇒ 合并器按键归位时各占一条逻辑消息，同一句话在界面上
   * 出现两次，且补齐的那份按到达顺序追加在最后一轮之后（第 1 轮的内容排在第 N 轮后面）。
   * 按键折叠去不掉它——键本身就是被打破的那一格。
   *
   * 登记时机是「这条条目第一次产块」，取号口径见 `roundTripForItem`。
   */
  itemRoundTrip: Map<string, number>;
  /**
   * `线程 id → 厂商自报的累计用量`（只来自 `thread/tokenUsage/updated`）
   */
  usageByThread: Map<string, AppServerThreadUsage>;
  /** `子线程 id → 派发台账` */
  dispatches: Map<string, CodexDispatch>;
  /**
   * `子线程 id → 已经交出去过的**不可丢事实**`（`kind` / `outcome` / `parentCallId` / `parentSubagentId`）。
   *
   * 为什么必须有这一格：同一条子线程会由**多帧**投递（派发、`wait` / `closeAgent`、活动条目、
   * 收尾读回），而折叠是**整条覆盖**（`core/message-log.ts` 的 `latest.set`）⇒ 后一帧里为空的那些格
   * 会把先采到的事实抹掉。真机读数（真模型臂，12 条投递序列）：`closeAgent` 的 `item/started`
   * 在 `completed` **之后**到达，那一帧 `agentsStates` 是 `{}` ⇒ 记录里 `outcome` 被抹成 `null`、
   * 状态从 `completed` 掉回 `unknown/unverified`。本仓一致性套件的 `PRESERVED_SUBAGENT_FIELDS`
   * 明写「覆盖不许丢事实」，但 codex 的套件夹具里没有 `wait`/`closeAgent`（真机每个模型都会调）。
   */
  subagentFacts: Map<string, CodexSubagentFacts>;
  /** `子线程 id → 昵称`（`thread/started` 的 `Thread.agentNickname`；收尾时可被 reader 覆盖） */
  nicknames: Map<string, string>;
  /**
   * `子线程 id → 最近一次观测到的状态`（契约五态；来自协作调用的 `agentsStates` 与 `subAgentActivity`）。
   *
   * 为什么要有这一格：同一次**收场**会在多条通知上重复出现（派发那次调用完成时、`wait` 完成时、
   * 子线程自己的活动条目上），而活动行播的是「刚发生的事」——不去重就会把同一句话播三四遍。
   * 判据是**状态变化**（终态且与上次不同），所以这里存的是事实（最近见到的状态），不是「播过没有」。
   */
  subagentStatus: Map<string, string>;
  /**
   * `线程 id|条目 id → 已推完的推理增量`（全文与摘要各一格）。
   * 完成通知要靠它兑现「这一块该补什么快照」：只回密文的路由上，全文永远不写在 `content[]` 里，
   * 那一块就只剩增量这一条命——没有这份台账就只能补一个空格，把已经拿到的正文丢掉。
   */
  reasoningDeltas: Map<string, { full?: string; summary?: string }>;
  /**
   * `载体键|条目 id|块种 → 块序号`（块序号在该载体内唯一，一经分配不再变化）。
   *
   * 为什么必须由本层分配而不是一律给 0：契约的块标识就是**该载体内的第几个块**，而一个载体里
   * 会同时有推理块、正文块与工具块（它们来自不同的条目）⇒ 全给 0 会让后到的块**覆盖**先到的
   * （合并器按标识归位），真机形状「同一条消息里既想又想写」会静默只剩最后一块。
   */
  blockIndices: Map<string, number>;
  /**
   * `通知 kind → 被**显式丢弃**的增量帧数`。
   *
   * 为什么要有这一格：协议里五条增量通道只有三条有渲染落点（正文 + 推理全文 + 推理摘要），
   * 另外两条（`item/plan/delta`、`item/commandExecution/outputDelta`）**没有消费方**。
   * 不写分支、落到兜底 return 的话，与「厂商压根没发这一条」在日志里长得一样。
   * 这里留计数：收尾时一条 DEBUG 汇总，把「我们主动丢了什么」与「上游没给」分开。
   * 只记数、不记正文（落正文就是另一个 O(n²) 的日志文件）。
   */
  droppedDeltas: Map<string, number>;
  /**
   * `MCP server 名字 → 最近一次启动状态`（codex 判据）。
   *
   * 为什么必须**累积**：codex 每条通知只报**变化的那一台**（`{name, status, error}`），
   * 而推导要按名字对全表（「我们注入的每一台各是什么状态」）⇒ 只有累积之后，最后一条事件才是
   * 一份**自足**的厂商事实。行级观测格取的就是最后那一条。
   *
   * 为什么放在 run 状态而不是事件投影的局部变量：`events.ts` 与收尾的 `vendor-system` 都要读它，
   * 而投影是**逐条无状态**调用的（`projectCodexEvent` 每次只看到一个 payload）。
   */
  mcpStartup: Map<string, { status: string; error: string | null }>;
  /**
   * 本行的**技能清单**（`skills/list` 采到的那一份，起会话之后立刻取一次）。
   *
   * 为什么放在 run 状态：两个消费方都要读它——`events.ts` 的 MCP 启动状态那一支（每发一条
   * `vendor-system` 都要把这一格带上，否则最后那条事件会把技能面抹成「厂商没投送」），
   * 以及收尾那条事件本身。与 `mcpStartup` 同一条理由（投影是逐条无状态调用的）。
   *
   * `null` = 探针还没跑（理论上不会：它在流开始之前就 await 完了）。
   * `entries: null` = **采不到**，与 `[]`（厂商回了、确实一条都没有）不是一回事。
   */
  skillProbe: { entries: VendorSkill[] | null; error: string | null } | null;
}

export function createCodexRunState(): CodexRunState {
  return {
    roundTripKeys: new Map(),
    toolActivitySinceOutput: new Map(),
    itemRoundTrip: new Map(),
    usageByThread: new Map(),
    dispatches: new Map(),
    subagentFacts: new Map(),
    nicknames: new Map(),
    subagentStatus: new Map(),
    reasoningDeltas: new Map(),
    blockIndices: new Map(),
    droppedDeltas: new Map(),
    mcpStartup: new Map(),
    skillProbe: null,
  };
}

/**
 * 记一台 MCP server 的启动状态（**后到的覆盖先到的**：同一台会走 `starting → ready` 两拍）。
 *
 * 返回**累积之后的全量**（顺序 = 首次出现的顺序）：调用方把这一份原样交给 `vendor-system`，
 * 于是「最后一条事件自带全部服务器」是构造上的性质，而不是消费方再去拼一次。
 */
export function noteMcpStartup(
  state: CodexRunState,
  name: string,
  status: string,
  error: string | null,
): Array<{ name: string; status: string; error: string | null }> {
  state.mcpStartup.set(name, { status, error });
  return [...state.mcpStartup].map(([serverName, one]) => ({ name: serverName, status: one.status, error: one.error }));
}

/**
 * 当前的 MCP 启动状态**全量**（与 `noteMcpStartup` 的返回值逐字同形，只是不写状态）。
 *
 * 为什么需要它：`vendor-system` 的消费方（编排层的行级 MCP 证据、环境抽屉）都**取最后一条**读，
 * 于是「收尾再发一条带技能清单的事件」必须把 MCP 那一格一起带上，否则最后那条事件里的
 * MCP 事实就是空的、把先前那几拍抹掉（`null` 的读数是「厂商没投送」）。
 */
export function currentMcpStartup(
  state: CodexRunState,
): Array<{ name: string; status: string; error: string | null }> {
  return [...state.mcpStartup].map(([serverName, one]) => ({ name: serverName, status: one.status, error: one.error }));
}

/**
 * 取该载体里这个块的序号（同一个「载体键|条目 id|块种」重复取到同一个号 ⇒ 增量与快照落进同一槽位）。
 * 载体键由调用方给（`subagentId` + 轮次 + `role`），块种区分同一条目里的全文与摘要。
 */
export function blockIndexFor(state: CodexRunState, carrier: string, itemId: string, kind: string): number {
  const key = `${carrier}|${itemId}|${kind}`;
  const existing = state.blockIndices.get(key);
  if (existing !== undefined) return existing;
  // 号源是「该载体里已经开过几个槽位」：新块只能追加到末尾
  const next = [...state.blockIndices.keys()].filter((one) => one.startsWith(`${carrier}|`)).length;
  state.blockIndices.set(key, next);
  return next;
}

/**
 * 记一次模型往返并返回到目前为止的往返数（`null` = 本条通知没有推进往返）。
 *
 * **号源是厂商的响应身份，不是答复条目数**。codex 的模型产出条目 id 形如 `rs_<响应 id>` /
 * `msg_<响应 id>`：同一次响应里，推理条目与答复条目**共享同一个 id 后缀**（真机三种 id 格式
 * 都如此：`rs_<hex32>`、`rs_<uuid>`、`rs_<时刻+随机>`），换一次响应就换一个后缀。
 * 拿它当身份，一次响应恰好开一个号——包括那些**一条 `agentMessage` 都没发的往返**
 * （模型只想了一下就调工具），它们同样是模型往返，也该各占一条消息。
 *
 * 两条判据按序用：
 *   ① **身份**（主判据）：后缀没见过 ⇒ 开新号；见过 ⇒ 归它那一次（`item/started` 与
 *      `item/completed`、增量与快照都共享同一个 id，天然去重）；
 *   ② **结构**（拿不到身份时的兜底）：`item.id` 里没有分隔符时只能看有没有工具活动
 *      ——上一次模型产出之后跑过工具才算新的一次往返。⚠️ 这条判据单独用是不够的：
 *      用户提问那一轮（`askUser`）里，模型答复之后直接就是下一次往返，中间没有任何工具条目
 *      （提问走 server→client 请求，不进条目流）⇒ 只靠结构会把两次往返并成一个号。
 *
 * **工具活动条目不开号**：它记一笔「有工具活动」（兜底判据要用），并在一次产出都没见过时
 * **补记一票**——工具执行蕴含它前面必有一次模型往返，不补这一票，那次调用会与它后面那次答复
 * 共用一个号（真机形状：turn 的第一条通知就是命令执行，模型这一次没发推理）。
 *
 * ⚠️ **返回 `null` 而不是当前值**：本条通知没有推进往返时，发一条内容相同的 usage 只是噪声
 * （`runTurn` 的发射门槛就是轮次）。
 */
export function countRoundTrips(item: AppServerItem, threadId: string, state: CodexRunState): number | null {
  // `other` 变体的 id 可为 `null`；它在 `roundTripRoleOf` 里已是「透明」，这里只是把类型收窄
  return noteRoundTrip(threadId, item.kind, item.id ?? '', state);
}

/**
 * 增量通知那一侧的同一把尺子：那里没有条目对象，只有 `itemId` 与通道名。
 *
 * 为什么增量也要过这一处：`item/started` 与增量**不保证谁先到**（子线程的条目推不推给本连接
 * 由上游决定），增量先到时若不在这里开号，这一段的文本会落进**上一次往返**的载体里，
 * 后面到达的快照再另开一条 ⇒ 同一段答复被拆成两条、其中一条还停在没有收尾的状态。
 * 载荷里的 `itemId` 与条目 id 逐字相同（`item/agentMessage/delta` 的 `itemId` 就是
 * `item/completed` 的 `item.id`），故两支共用同一个函数。
 */
export function noteDeltaRoundTrip(
  threadId: string,
  kind: 'reasoning' | 'agentMessage',
  itemId: string,
  state: CodexRunState,
): number | null {
  return noteRoundTrip(threadId, kind, itemId, state);
}

function noteRoundTrip(
  threadId: string,
  kind: AppServerItem['kind'],
  itemId: string,
  state: CodexRunState,
): number | null {
  const role = roundTripRoleOf(kind);
  if (role === 'other') return null;

  const keys = state.roundTripKeys.get(threadId) ?? new Set<string>();
  if (role === 'tool-activity') {
    state.toolActivitySinceOutput.set(threadId, true);
    // 产出条目一票都没数到 ⇒ 补记这一次：工具执行蕴含它前面必有一次模型往返
    if (keys.size === 0) {
      keys.add(IMPLICIT_ROUND_TRIP_KEY);
      state.roundTripKeys.set(threadId, keys);
    }
    return null;
  }

  const identity = roundTripIdentityOf(itemId);
  if (identity === null) {
    // 兜底：没有身份可认时，只有「上一次产出之后跑过工具」才算新的一次往返
    if (keys.size > 0 && state.toolActivitySinceOutput.get(threadId) !== true) return null;
    keys.add(`unidentified:${keys.size}`);
  } else {
    if (keys.has(identity)) return null;
    keys.add(identity);
  }
  state.roundTripKeys.set(threadId, keys);
  state.toolActivitySinceOutput.set(threadId, false);
  return keys.size;
}

/** 条目种类在本模块里的角色：模型产出（开号）、工具活动（证明前面有一次往返）、其余（透明） */
function roundTripRoleOf(kind: AppServerItem['kind']): 'model-output' | 'tool-activity' | 'other' {
  if (kind === 'reasoning' || kind === 'agentMessage') return 'model-output';
  if (
    kind === 'commandExecution' ||
    kind === 'fileChange' ||
    kind === 'mcpToolCall' ||
    kind === 'webSearch' ||
    kind === 'dynamicToolCall' ||
    kind === 'collabToolCall' ||
    kind === 'plan'
  ) {
    return 'tool-activity';
  }
  /**
   * `userMessage`（喂进去的输入）与 `toolOutput`（工具输出的旁路副本）在这里**透明**：
   * 它们是输入与回声，不是模型这一次往返的产出，拿它们开号会把往返数虚报上去。
   */
  return 'other';
}

/**
 * 条目 id → 它所属那次模型往返的身份（= 第一个分隔符之后的全部内容）。
 *
 * 拿不到分隔符（或分隔符在首尾）时返回 `null`，交给结构兜底判据 —— **不编一个身份**：
 * 编出来的身份会让同一次响应的两个条目各开一个号（真机上表现为「思考」与「正文」被拆成两张卡片）。
 */
function roundTripIdentityOf(itemId: string): string | null {
  const at = itemId.indexOf('_');
  if (at <= 0 || at === itemId.length - 1) return null;
  return itemId.slice(at + 1);
}

/** 工具条目补记那一票的占位身份（真机身份是 hex / uuid / 时刻串，撞不上） */
const IMPLICIT_ROUND_TRIP_KEY = 'implicit-tool-round-trip';

/** 一个线程的往返数；`null` = 一票都没数到（**绝不编 0**——那是「确实零轮」） */
export function observedTurns(state: CodexRunState, threadId: string): number | null {
  const size = state.roundTripKeys.get(threadId)?.size ?? 0;
  return size > 0 ? size : null;
}

/** 一个线程的往返数，**没有就是 0**（收尾求和用：每个线程各数各的往返） */
export function roundTripsOf(state: CodexRunState, threadId: string): number {
  return state.roundTripKeys.get(threadId)?.size ?? 0;
}

/**
 * 这条条目所属那次模型往返的号（**第一次问就定下来，以后每次问都是同一个数**）。
 *
 * 为什么不能现算「该线程当前有几轮」：同一条条目有两条入口（运行期通知 / 收尾全量回读），
 * 而收尾那一批条目的号**已经数过**（`countRoundTrips` 按身份去重、不再推进）⇒ 现算会让整批
 * 条目读到最终号，与运行期算出的号不同 ⇒ 载体键被打破、同一条条目出两份（见
 * `CodexRunState.itemRoundTrip`）。登记下来之后，两条入口拿到的号逐字相同，合并器才折得拢。
 *
 * 号源仍是 `roundTripKeys`（本函数不开号，只是把「问的那一刻的号」钉住）：调用方必须**先**
 * 把本条计入（`countRoundTrips` / `noteDeltaRoundTrip`）再来取号，顺序反了会把这条钉在上一轮。
 * 下限 1：一票都没数到时（纯工具条目开局）也得有个能用的号，`0` 不是轮次的合法取值。
 */
export function roundTripForItem(state: CodexRunState, threadId: string, itemId: string): number {
  const key = `${threadId}|${itemId}`;
  const existing = state.itemRoundTrip.get(key);
  if (existing !== undefined) return existing;
  const round = Math.max(roundTripsOf(state, threadId), 1);
  state.itemRoundTrip.set(key, round);
  return round;
}

/**
 * `input − cached`，下限 0。
 *
 * codex 的 `inputTokens` **含**缓存读（`cachedInputTokens` 是它的明细），而契约的 `input` 是
 * **非缓存输入**（另两家的原文天生不含 cache）⇒ 不减就是三家口径里的那一处真实分歧：
 * 命中率公式 `cached/(input+cached)` 的分母偏大、命中率被系统性低估。
 *
 * `cached > input` 是上游数据自相矛盾（真机未出现）。照减会得到负的输入，而负 token 会让命中率与
 * 成本两条公式同时失去意义 ⇒ 夹到 0。这是唯一一处允许夹断的地方，方向是「不编造负值」。
 */
export function normalizedInput(input: number, cached: number): number {
  return Math.max(0, input - cached);
}

/** 该子线程已经交出去过的那几格（没有就是四个 `null`） */
export function subagentFactsOf(state: CodexRunState, subagentId: string): CodexSubagentFacts {
  return state.subagentFacts.get(subagentId) ?? { kind: null, outcome: null, parentCallId: null, parentSubagentId: null };
}

/**
 * 记下这一帧**新采到**的那几格，并交回合并后的全量。
 *
 * 合并规则只有一条：**非 `null` 才覆盖**（后到的帧里为空的格说明「这一帧没说」，不是「事实没了」）。
 * 折叠是整条覆盖，所以「不许丢事实」这件事只能在**产记录之前**做——交给消费方去合并已经太晚
 * （它只看到最后那一条）。
 */
export function rememberSubagentFacts(
  state: CodexRunState,
  subagentId: string,
  incoming: CodexSubagentFacts,
): CodexSubagentFacts {
  const before = subagentFactsOf(state, subagentId);
  const merged: CodexSubagentFacts = {
    kind: incoming.kind ?? before.kind,
    outcome: incoming.outcome ?? before.outcome,
    parentCallId: incoming.parentCallId ?? before.parentCallId,
    parentSubagentId: incoming.parentSubagentId ?? before.parentSubagentId,
  };
  state.subagentFacts.set(subagentId, merged);
  return merged;
}
