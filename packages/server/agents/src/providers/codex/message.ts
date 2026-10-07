/**
 * codex 的**消息归一**（spec v3 §3.1 / §3.2 / §3.3 / §4.2）：把会话文件折成统一的 `AgentMessage`
 * 与 `SubagentRecord`。事件投影仍在 `events.ts` / `transcript.ts`（行级审计与摘要），本文件只管内容级视图。
 *
 * **为什么这一家只从会话文件出消息**（与另两家的差别，写清楚以免被当成遗漏）：
 *   · 事件流的 `item` 缺三样东西——**工具真名**（只有 `command_execution` 这种派生条目名）、
 *     **结构化入参**（只有 `command` 文本）、以及工具结果与调用之间的 `call_id`；
 *   · 而同一个条目在会话文件里是**完整记录**（`CommandExecution` 带 `command[]` / `stdout` /
 *     `stderr` / `exit_code` / `status`，`function_call` 带真名与 `arguments`，`function_call_output`
 *     按 `call_id` 配对）；
 *   · 两边都出会让**每一条消息出现两次**（身份键不同：事件流用 `item_N`、会话文件用 `call_id`），
 *     而「同一件事两条记录」正是本契约要消灭的东西。
 *   ⇒ 一次投递，取自会话文件的权威记录。代价如实登记：**运行期看不到 codex 的消息**
 *     （会话文件要等流跑完才完整），运行期只有事件流给出的派发事件与状态。
 *
 * 取值路径逐条（真机逐字核过，见 `probe/dumps/v4/**\/rollout-*.jsonl`）：
 *   · `item.type === 'AgentMessage'` → `content[].text`（正文）→ `text` 块。
 *   · `item.type === 'Reasoning'` → `summary_text[]` 是**厂商摘要**（`textKind: 'summary'`），
 *     `raw_content[]` 是完整推理正文（`textKind: 'full'`）。真机的 wire 层 `summary` 常为空数组，
 *     故**优先取 `raw_content`**，摘要只在正文缺席时兜底——两者都不许用 `output` 之类的统计量顶替。
 *   · `item.type === 'CommandExecution'` → 一次 `run-shell`：工具调用块的真名取 `response_item/
 *     function_call.name`（同一 `call_id` 配对），入参是那份 `arguments`（JSON 字符串 ⇒ 解析成对象）；
 *     结果块给 `aggregated_output` 文本与结构化 `{exitCode, status}`。
 *     ⚠️ `aggregated_output` 是 **stdout 与 stderr 合流**（拆不开）⇒ 归一结果里不编 `stderr`。
 *   · `item.type === 'CollabAgentToolCall'` → `spawn-agent` 族的工具调用（`tool` 是协作动作名），
 *     并据 `agents_states`（**以子线程 id 为键的对象**）产出/刷新子任务行。
 *   · `item.type === 'UserMessage'` **不产出消息**：那是喂进去的输入，不是模型产出。
 *   · `roundTrip`：按**模型答复条目**（`AgentMessage`）的 `item.id` 去重计数（2026-10-05 收窄，
 *     spec §2.3：与事件流那条通道同一把尺子，见 `TURN_ITEM_TYPES`）。
 *     语义如实登记：codex 的「轮次」从此是「**模型答复条目数**」，比旧口径（`Reasoning` +
 *     `AgentMessage`，被推理条目系统性抬高）更低——一次运行一个 `AgentMessage` 都没有时轮次是
 *     `null`（界面显示「未采集」），那比一个被抬高的假数好。
 *   · `vendorTurn` / `step`：**这家没有**（恒 `null`）。
 *   · `parentSubagentId`：子线程会话文件的 `session_meta.parent_thread_id`（主线程那份为 `null`），
 *     **但顶层子任务记 `null`**——`spawn_agent` 派出的子线程这一格就是主线程 id，照抄会让会话树上
 *     多出一条指向不存在节点的父链（见 `nestedParentOf`）。
 *   · 子任务状态：`agents_states[<子线程 id>].status`（事件流与会话文件同形）；**取不到就记
 *     `unknown` + `statusMissing`**，不猜终态。答复取同格的 `message`，或子会话文件里最后一条
 *     `AgentMessage`。
 *   · 子任务级用量：子会话的 `token_count.info.total_token_usage`（含 `reasoning_output_tokens`）。
 */
import type { AgentMessage, SubagentRecord, UsageTokens } from '@aieval/contracts';
import { asRecord, readNumber, readString } from '../../json';
import {
  textBlockDraft,
  thinkingBlockDraft,
  toolCallBlockDraft,
  truncate,
  usageTokens,
  type MessageDraft,
} from '../../message';
import { normalizedInput } from './transcript';
import {
  discoverChildThreads,
  findTranscript,
  readTranscript,
  type ChildThreadDiscovery,
  type CodexTranscript,
  type CodexTranscriptCompletedItem,
  type CodexTranscriptReader,
  type DiscoveredChildThread,
} from './transcript';

/** 归一产物：主线程与全部子线程的消息 + 子任务行 */
export interface CodexMessageProjection {
  messages: MessageDraft[];
  subagents: SubagentRecord[];
}

/**
 * 算作「一次模型往返」的条目类型（2026-10-05 收窄，spec §2.3）：**与会话文件之外那条通道同一把尺子**
 * （`events.ts` 的 `TURN_ITEM_TYPES`）。⚠️ 会话文件里看得见 `Reasoning` 而事件流看不见它
 * （DeepSeek 路由上 codex 不投影 reasoning item）⇒ 数它就会得到两套轮次号（真机：42 vs 18）。
 */
const TURN_ITEM_TYPES = new Set(['AgentMessage']);

export function projectCodexMessages(input: {
  codexHome: string;
  mainThreadId: string | null;
  /** 子线程 id（来自 `collab_tool_call.receiver_thread_ids`），顺序即事件顺序 */
  childThreadIds: readonly string[];
  /** 读取函数；缺省 = 真的读盘。测试喂合成 transcript 时只换这一格（与事件侧同一个注入口） */
  read?: CodexTranscriptReader['read'];
  /**
   * 已经算好的一份**递归发现**（`transcript.ts` 的 `discoverChildThreads`）。缺省 = 自己发现一次。
   *
   * ⚠️ **2026-10-06 起内容面也走递归发现**（此前只吃事件流点名的种子）：只吃种子时，
   * **沿 spawn 链递归发现的嵌套子线程既没有子任务行、也没有消息**——而它们的用量**已经**进了
   * `subagentTokens`（那一份从 R7 起就是递归的）⇒ 界面上「Σ 各行 ≠ 分量」，且嵌套子智能体的
   * 用量在抽屉里根本没有那一行。`index.ts` 的每个读周期只发现一次，把同一份传给内容面与用量面。
   */
  discovery?: ChildThreadDiscovery;
}): CodexMessageProjection {
  const read = input.read ?? readTranscript;
  const messages: MessageDraft[] = [];
  const subagents: SubagentRecord[] = [];
  /** 主线程 id 收进 const：非空判定要能**穿过下面的闭包**（`dispatchOf` 在闭包里读它） */
  const mainThreadId = input.mainThreadId;
  if (mainThreadId === null) return { messages, subagents };
  const main = readByThreadId(input.codexHome, mainThreadId, read);
  if (main === null) return { messages, subagents };
  messages.push(...threadMessages(main, null));
  /**
   * 递归发现（含嵌套）。⚠️ 缺省那一支是给**测试与其它调用方**的方便门：生产路径（`index.ts`）
   * 总是把同一个周期里算好的那一份传进来，免得一次刷新里发现两遍。
   */
  const threads =
    input.discovery?.threads ??
    discoverChildThreads({
      codexHome: input.codexHome,
      childThreadIds: input.childThreadIds,
      mainThreadId,
      read,
    }).threads;
  /**
   * **派发信息按父线程取**（2026-10-06 修）：`dispatchIndex` 读的是「谁派发了它」那一份文件里的
   * 协作条目，而嵌套子线程的派发者是**另一条子线程**（不是主线程）⇒ 只建 `dispatchIndex(main)`
   * 时嵌套行的 `kind` / `parentCallId` 恒 `null`，界面按 `parentCallId` 找派发点就找不到它
   * （`build-model.ts` 的 ③ 名字回填只看主会话消息，够不着子线程里的那次调用）。
   * 按父线程 id 记忆化：一层只建一次索引，深度 8 的上限也就 8 份。
   */
  const dispatchByThread = new Map<string, ReturnType<typeof dispatchIndex>>();
  const dispatchOf = (parentThreadId: string | null): ReturnType<typeof dispatchIndex> => {
    // 父是主线程（或未知）：与改动前逐字同一条路
    if (parentThreadId === null || parentThreadId === mainThreadId) {
      const cached = dispatchByThread.get(mainThreadId);
      if (cached !== undefined) return cached;
      const built = dispatchIndex(main);
      dispatchByThread.set(mainThreadId, built);
      return built;
    }
    const cached = dispatchByThread.get(parentThreadId);
    if (cached !== undefined) return cached;
    const parent = threads.find((thread) => thread.threadId === parentThreadId)?.transcript ?? null;
    // 父的转录读不到 ⇒ 没有派发信息可言（**不猜**）：这一行的 `kind` / `parentCallId` 记 `null`
    const built = parent === null ? new Map<string, { tool: string | null; callId: string | null }>() : dispatchIndex(parent);
    dispatchByThread.set(parentThreadId, built);
    return built;
  };
  for (const thread of threads) {
    const record = childRecord(thread, dispatchOf(thread.spawnedBy).get(thread.threadId), mainThreadId);
    if (record !== null) subagents.push(record);
    /**
     * **子线程的轨迹也要投影**（2026-10-03 用户口径：「codex 子任务里面没有日志」）。
     *
     * 这里原来只建了一条子任务**行**（身份 / 名称 / 终态 / 结果摘要 / 用量），
     * 而**它自己那 47 个条目一条消息都没产出**——界面上点进子任务就是空的，
     * 尽管它的会话文件（真机 266 KB、`AgentMessage` 与 `Reasoning` 俱全）就在盘上。
     * v3 §4.2 步骤 5 写的就是「用子线程 id 定位子会话文件，读出子智能体的**完整轨迹**」，
     * 这一格是漏实现的，不是设计如此。
     *
     * 载体用**子线程 id**（`subagentId = threadId`，与子任务行的身份同值）：
     * 合并键因此天然与主线程隔离，界面按 `subagentId` 就能把消息归到那条子任务上。
     */
    if (thread.transcript !== null) messages.push(...threadMessages(thread.transcript, thread.threadId));
  }
  return { messages, subagents };
}

/**
 * 一条线程会话文件里的消息：按**行序**遍历已完成条目（顺序即发生顺序），
 * 往返序号与块序号都在这一遍里推进（两者都是「第几个」的相对量，不需要消息 id 参与）。
 *
 * `subagentId` 为 `null` = 主线程；给子线程 id = 那条子任务的轨迹（见调用点）。
 */
function threadMessages(transcript: CodexTranscript, subagentId: string | null): MessageDraft[] {
  const drafts: MessageDraft[] = [];
  /**
   * 块序号：`载体 → 下一个序号`。**每个载体一个计数器**（键是固定的 `'block'`，因为一次只处理
   * 一条转录，载体随 `subagentId` 分文件处理）——按块类型各配一个计数器会让思考块与正文块撞号。
   */
  const blockIndices = new Map<string, number>();
  let roundTrip = 0;
  /** 已经算过一轮的条目 id：文件里同一个条目重复落行时不重复推高轮次（与事件流的 `turnKeys` 同构） */
  const countedItems = new Set<string>();
  /**
   * 每一条草稿的轮次号 = **到目前为止已数到的答复条目数**（下限 1）。
   * ⚠️ 非答复条目（推理 / 工具）因此与**最近一次答复**同号（同一轮、同一载体）：这个号回答的是
   * 「已经产出过几条答复」，而推理条目对这把尺子是**透明**的（事件流那条通道上它连号都不给，
   * 见 `events.ts` 的 `countModelOutputItem` 返回 `null`）——与另两家的 `roundTripOf` 同一处置。
   * 代价如实登记：一次模型往返里的推理与它**产出**的那条答复可能落在相邻两轮（推理取的是上一条
   * 答复的号）；换来的是「重复落行不推高号」这条去重口径仍然**可观测**（见 `transcript.test.ts`
   * 的「会话文件的轮次只数 AgentMessage」——把去重去掉，那条用例的最后一个号会红）。
   */
  for (const [index, item] of transcript.completedItems.entries()) {
    if (item.itemType !== null && TURN_ITEM_TYPES.has(item.itemType)) {
      const key = item.itemId ?? `#${index}`;
      if (!countedItems.has(key)) {
        countedItems.add(key);
        roundTrip += 1;
      }
    }
    drafts.push(...itemMessages(item, { roundTrip: Math.max(roundTrip, 1), subagentId, transcript, blockIndices }));
  }
  return drafts;
}

/**
 * 一条已完成条目 → 0..n 条消息草稿。
 * `CommandExecution` 产出**两条**（调用 + 结果）：它们在同一份记录里，而契约把它们分成两种块、
 * 两条消息（`role` 一条 `tool`、`parentCallId` 一条 `null`），合并键因此天然不同、不会互相覆盖。
 */
function itemMessages(
  item: CodexTranscriptCompletedItem,
  context: {
    roundTrip: number;
    subagentId: string | null;
    transcript: CodexTranscript;
    blockIndices: Map<string, number>;
  },
): MessageDraft[] {
  const payload = item.item;
  const type = item.itemType;
  if (payload === null || type === null) return [];
  const envelope = {
    vendorId: item.itemId,
    source: 'session-file' as const,
    roundTrip: context.roundTrip,
    // 这家没有厂商轮号与步骤号：`turnId` 是厂商轮的**稳定标识**（字符串），不是序号 ⇒ 不冒充数字
    vendorTurn: null,
    step: null,
    parentCallId: null,
    subagentId: context.subagentId,
    /**
     * 消息级用量：**codex 交不出来**（wire 只有轮级的 `turn.completed`，会话文件只有 `token_count`，
     * 两者都不是「这条消息那一次调用」）⇒ 一律 `null`（不是 0）。界面因此不给它画页脚。
     */
    usage: null,
    raw: payload,
  };
  /**
   * 块序号：**每个载体一个计数器**（不分块类型）。
   *
   * 为什么不能按块类型各配一个计数器：那样「思考块 0」与「正文块 0」会撞进同一个槽位
   * （块标识就是块序号），后到的正文会把思考块覆盖掉——真机上一条消息里同时有推理与正文是常态。
   */
  const nextIndex = (): number => {
    const index = context.blockIndices.get('block') ?? 0;
    context.blockIndices.set('block', index + 1);
    return index;
  };
  if (type === 'AgentMessage') {
    const text = itemText(payload);
    if (text === '') return [];
    return [
      {
        ...envelope,
        role: 'assistant',
        chunk: 'snapshot',
        blocks: [textBlockDraft(text, 'snapshot', { kind: 'index', index: nextIndex() })],
      },
    ];
  }
  if (type === 'Reasoning') {
    const { text, kind } = reasoningOf(payload);
    return [
      {
        ...envelope,
        role: 'assistant',
        chunk: 'snapshot',
        blocks: [thinkingBlockDraft(text, kind, 'snapshot', null, { kind: 'index', index: nextIndex() })],
      },
    ];
  }
  if (type === 'CommandExecution') {
    const callId = item.itemId;
    if (callId === null || callId === '') return [];
    return [
      shellCallMessage(envelope, payload, callId, context.transcript),
      shellResultMessage(envelope, payload, callId),
    ];
  }
  if (type === 'CollabAgentToolCall') {
    const callId = item.itemId;
    if (callId === null || callId === '') return [];
    return [
      {
        ...envelope,
        // 工具调用投在 `assistant` 上（与 claude 的 `tool_use` 块同一条消息同形）；**结果**才投在
        // `tool` 上——那是同一个载体的两块，合并后与另两家逐字段同形
        role: 'assistant',
        chunk: 'snapshot',
        blocks: [toolCallBlockDraft(callId, readString(payload, 'tool') ?? 'collab_tool_call', collabInput(payload), undefined)],
      },
    ];
  }
  // 其余条目类型（`UserMessage`、将来新增的）：**不产出消息**。`UserMessage` 是喂进去的输入，
  // 把输入当产出会让对话视图把「我们说的话」混进「模型说的话」。
  return [];
}

/** 归一草稿的信封（除 `role` / `chunk` / `blocks` 外的那几格），三处消息共用一份形状 */
type Envelope = Omit<MessageDraft, 'role' | 'chunk' | 'blocks'>;

/**
 * 一次 shell 执行 → **调用消息**。
 * 工具真名取 `function_call.name`（会话文件里同一 `call_id` 配对），缺席时退回 `exec_command`
 * ——它是当前模型预设里这一族的真名（**不是**事件流那个派生条目名 `command_execution`）。
 */
function shellCallMessage(
  envelope: Envelope,
  payload: Record<string, unknown>,
  callId: string,
  transcript: CodexTranscript,
): MessageDraft {
  const call = functionCallFor(transcript, callId);
  return {
    ...envelope,
    role: 'assistant',
    chunk: 'snapshot',
    blocks: [
      /**
       * 走公共草稿函数（不再就地手搓块对象）：族载荷的归一住在那一处，
       * 手搓的块会静默少掉 `payload`（它的类型是必填，而运行时没有守卫）。
       * `run-shell` 不属于本期收编的两族 ⇒ 那一格会是 `null`，界面走通用工具行。
       */
      toolCallBlockDraft(callId, call?.name ?? 'exec_command', parseArguments(call?.arguments ?? null, commandShape(payload)), 'run-shell'),
    ],
  };
}

/**
 * 一次 shell 执行 → **结果消息**（与调用分成两条：与另两家同形，消费方按 `role` 分流渲染）。
 *
 * ⚠️ `aggregated_output` 是 stdout 与 stderr **合流**（拆不开）⇒ 归一结果里不编 `stderr`；
 * 运行中省略 `exit_code` 是常态 ⇒ 结构化格记 `null`（**不是** `{exitCode: null}`）。
 * 结构化里只放**退出码**、不放 `status`：成功与否由退出码表达（`0` / 非 `0`），
 * 而另两家的结果格也只有退出码——把 `status` 放进去会让同一次执行的归一结果逐家不同。
 */
function shellResultMessage(envelope: Envelope, payload: Record<string, unknown>, callId: string): MessageDraft {
  const output = readString(payload, 'aggregated_output') ?? readString(payload, 'formatted_output') ?? '';
  const { text, truncated } = truncate(output);
  const exitCode = readNumber(payload, 'exit_code');
  return {
    ...envelope,
    role: 'tool',
    chunk: 'snapshot',
    blocks: [
      {
        phase: 'snapshot',
        identity: { kind: 'call', callId },
        block: {
          type: 'tool-result',
          callId,
          structured: exitCode === null ? null : { exitCode },
          isError: exitCode !== null && exitCode !== 0,
          text,
          // 本家不给截断标记 ⇒ `unknown`（「输出可能不完整」），**不写「确认完整」**
          truncation: truncated ? { kind: 'truncated', reason: '超过工具结果上限' } : { kind: 'unknown' },
        },
      },
    ],
  };
}

/**
 * 派发信息：`子线程 id → { 派发动作名, 那次工具调用的 call_id }`，**从父会话文件里取**。
 *
 * 为什么需要它（2026-10-03 真机实测的坑）：子线程的会话文件里**没有**「谁派发了我」这一格，
 * 于是收尾那次交出的子任务行 `parentCallId` 恒为 `null`、`kind` 也恒为 `null`
 * ——它会**覆盖**事件流那条（读侧按 `subagentId` 覆盖累积）⇒ 界面上「进入子任务」的入口
 * 反而消失了（事件流那条本来是有 `parentCallId` 的）。
 *
 * 判据：父会话文件里 `CollabAgentToolCall` 条目的 `receiver_thread_ids` 含这个子线程 id，
 * 而它在会话文件里**紧跟**对应的 `function_call`（同一条 `call_id` 配对，与命令执行同一套）。
 * 真机核过：`function_call.name = 'spawn_agent'` + `arguments = {"message": …}`。
 * 配不上就返回 `null`——**不猜**。
 */
function dispatchIndex(main: CodexTranscript): Map<string, { tool: string | null; callId: string | null }> {
  const index = new Map<string, { tool: string | null; callId: string | null }>();
  for (const item of main.completedItems) {
    if (item.itemType !== 'CollabAgentToolCall' || item.item === null) continue;
    const receivers = item.item.receiver_thread_ids;
    if (!Array.isArray(receivers)) continue;
    const tool = readString(item.item, 'tool');
    /**
     * 调用 id 的取法：会话文件里协作条目的 `item.id` 是 `item_8` 那种**条目号**，
     * 而配对的 `function_call.call_id` 才是真调用 id。先按 `call_id` 精确配（真机同值），
     * 配不上就留 `null`——**不拿条目号冒充**。
     */
    const callId = item.itemId === null ? null : functionCallIdFor(main, item.itemId);
    for (const receiver of receivers) {
      if (typeof receiver !== 'string' || receiver === '') continue;
      if (index.has(receiver)) continue;
      index.set(receiver, { tool, callId });
    }
  }
  return index;
}

/** `item.id → function_call.call_id`：会话文件里用同一个 id 配对（真机核过） */
function functionCallIdFor(transcript: CodexTranscript, itemId: string): string | null {
  const direct = functionCallFor(transcript, itemId);
  if (direct !== null) return itemId;
  // 条目号与调用 id 不同值时，按「同一个协作条目的 id」找一次（真机同一份文件里两者同值）
  for (const call of transcript.functionCalls) {
    if (call.callId === itemId) return call.callId;
  }
  return null;
}

/**
 * 子线程 → 子任务行。
 *
 * 状态：本家**没有可靠的终态字段**（hook 载荷里没有 `status`；`agents_states` 只在事件流那一侧，
 * 而事件流在失败/中断时不完整）⇒ 判据只用**会话文件里的证据**：
 *   · 有 `AgentMessage` ⇒ 它确实产出了答复，记 `completed`；
 *   · 一条都没有 ⇒ `unknown` + `statusMissing: 'unverified'`（**没有验证过**这条路径的映射，
 *     不是「这家没有状态」）。
 * 名称取 `thread_spawn.agent_nickname`（hook 载荷里没有名称，这条是原生来源）。
 * 派发动作与调用 id 从**父会话文件**里取（见 `dispatchIndex`）——子线程文件里没有这两格。
 *
 * ⚠️ **转录由调用方给**（2026-10-06）：它已经是递归发现的产物（`DiscoveredChildThread.transcript`），
 * 本函数不再自己读一次盘——此前内容面按 id 各读一遍、用量面又发现一遍，同一个文件一周期读两次。
 */
function childRecord(
  thread: DiscoveredChildThread,
  dispatch: { tool: string | null; callId: string | null } | undefined,
  mainThreadId: string,
): SubagentRecord | null {
  const transcript = thread.transcript;
  if (transcript === null) return null;
  const threadId = thread.threadId;
  const answered = transcript.completedItems.some((item) => item.itemType === 'AgentMessage');
  return {
    subagentId: threadId,
    /**
     * 名称取 `sessionMeta.threadSpawn.agentNickname`。
     * ⚠️ **这一格依赖 `readTranscript` 的身份判据**（2026-10-XX）：fork 出来的子线程文件里有**两条**
     * `session_meta`——自己那份（`thread_spawn` 齐全）与**派发者副本**（主线程那份，`thread_spawn`
     * 为 `null`）⇒ 读取层若让副本胜出，这里会**整个丢掉**名称（`null`）。今天取第一条（文件自己的）
     * ⇒ 拿到真昵称；守卫在 `transcript.test.ts` 的「fork 子线程在消息层的两个连带格」。
     */
    name: transcript.sessionMeta?.threadSpawn?.agentNickname ?? null,
    // 派发方式（`spawn_agent` / `wait` …）只在父会话文件的协作条目里 ⇒ 从 `dispatch` 取
    kind: dispatch?.tool ?? null,
    source: 'session-file',
    status: answered ? 'completed' : 'unknown',
    statusMissing: answered ? null : 'unverified',
    // 结果摘要：子会话里最后一条 assistant 消息的正文
    outcome: lastAssistantText(transcript),
    /**
     * 派生它的那次工具调用 id（契约 v3 §2.6 的 `parentCallId`）。
     *
     * 子线程会话文件里**没有**这一格，故从**父会话文件**的协作条目里配对取（见 `dispatchIndex`）。
     * 取不到就是 `null`——**不猜**；`null` 时界面退化为按「入参里的任务名 == 子任务名」认派发点。
     */
    parentCallId: dispatch?.callId ?? null,
    parentSubagentId: nestedParentOf(transcript, mainThreadId),
    usage: totalUsageOf(transcript),
  };
}

/**
 * 嵌套父链（契约 §2.6：`parentSubagentId` 是「嵌套父链；**顶层子任务为 `null`**」）。
 *
 * 子线程会话文件的 `parent_thread_id` 是「**谁派发了我**」的原生事实：`spawn_agent` 从主线程派出去的
 * 那些子线程，这一格**就是主线程 id**（真机 2026-10-03 核过：`parent_thread_id` 与事件流
 * `thread.started.thread_id` 同值、`thread_spawn.depth` 为 1）。而它们在会话树上属于**顶层**：
 * 消费方按「`null` ⇒ 挂在主会话节点上，否则挂 `subagent:<那个 id>`」建树，照抄主线程 id
 * 会指向一个**不存在的节点**（主会话那一节的 id 是 `main`）。
 * 真机表现：进子任务后面包屑只剩子任务名一段，**「主会话」那一段整段消失**（回不去）。
 *
 * 故只有父**本身也是一条子线程**（嵌套，`depth ≥ 2`）时才交出 id；父是主线程、或主线程未知时记 `null`。
 * 与 dsh 侧同一条口径（「父会话 id 等于主会话 id ⇒ `null`」）。
 *
 * ⚠️ **这一格也依赖 `readTranscript` 的身份判据**（2026-10-XX）：fork 出来的子线程文件里那条
 * **派发者副本**的 `parent_thread_id` 是**派发者的**父链 ⇒ 若副本胜出，一个**嵌套**的 fork 子线程
 * 会被当成**顶层**（这里返回 `null`）⇒ 界面把它挂到主会话节点、而不是它真正的父那条子任务下面
 * （表现就是下面注释里说的「面包屑少一段」）。今天取文件里**第一条** `session_meta`（自己的）
 * ⇒ 拿到它真正的父；守卫在 `transcript.test.ts` 的「fork 子线程在消息层的两个连带格」。
 */
function nestedParentOf(transcript: CodexTranscript, mainThreadId: string): string | null {
  const parent = transcript.sessionMeta?.parentThreadId ?? null;
  if (parent === null || parent === mainThreadId) return null;
  return parent;
}

/** 子线程最后一条 `AgentMessage` 的正文（`outcome` 只放文本，拿不到就是 `null`） */
function lastAssistantText(transcript: CodexTranscript): string | null {
  for (let index = transcript.completedItems.length - 1; index >= 0; index -= 1) {
    const item = transcript.completedItems[index];
    if (item === undefined || item.itemType !== 'AgentMessage' || item.item === null) continue;
    const text = itemText(item.item);
    if (text !== '') return text;
  }
  return null;
}

/**
 * 子任务级用量：**最后一个读得出三项的** `token_count.info.total_token_usage`
 * （**必须减 cached**，与主线程同一口径）。
 *
 * ⚠️ **判据与 `transcript.ts` 的 `normalizedTotalUsage` 对齐过**（2026-10-06）：那一份是
 * 「**从后往前找第一个三项齐的**」，而这里此前只看 `at(-1)` 那一条——最后一条缺项时两处会给出
 * 不同的结论（行级分量有值、而这一行的 `usage: null`）⇒ 界面上的「Σ 各子智能体」与分量对不上，
 * 而两处各自看起来都正常。真机形状：CLI 最后写了一条只有 `output_tokens` 的 `token_count`。
 */
function totalUsageOf(transcript: CodexTranscript): UsageTokens | null {
  for (let index = transcript.tokenCounters.length - 1; index >= 0; index -= 1) {
    const usage = transcript.tokenCounters[index]?.totalUsage ?? null;
    if (usage === null) continue;
    if (usage.input === null || usage.cachedInput === null || usage.output === null) continue;
    return usageTokens({
      input: normalizedInput(usage.input, usage.cachedInput),
      cached: usage.cachedInput,
      output: usage.output,
      reasoningOutput: usage.reasoningOutput,
      total: usage.total,
    });
  }
  return null;
}

/** `AgentMessage.content[]` 的正文（`{type:'Text', text}`；非文本块不进正文） */
function itemText(item: Record<string, unknown>): string {
  const content = item.content;
  if (typeof item.text === 'string') return item.text;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => readString(asRecord(block), 'text') ?? '')
    .filter((text) => text !== '')
    .join('\n');
}

/**
 * `Reasoning` 的正文与档位：**优先 `raw_content`**（完整推理正文，`textKind: 'full'`），
 * 摘要 `summary_text` 只在正文缺席时兜底（那时档位是 `'summary'`）。两者都没有 ⇒
 * `text: null` + `'none'`（「有思考但拿不到文本」，**不是**「没有思考」）。
 */
function reasoningOf(item: Record<string, unknown>): { text: string | null; kind: 'full' | 'summary' | 'none' } {
  const raw = joinStrings(item.raw_content);
  if (raw !== '') return { text: raw, kind: 'full' };
  const summary = joinStrings(item.summary_text);
  if (summary !== '') return { text: summary, kind: 'summary' };
  return { text: null, kind: 'none' };
}

function joinStrings(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value
    .map((entry) => (typeof entry === 'string' ? entry : ''))
    .filter((entry) => entry !== '')
    .join('\n');
}

/** `function_call` 按 `call_id` 找真名与 `arguments`（会话文件里两者同键） */
function functionCallFor(transcript: CodexTranscript, callId: string): { name: string | null; arguments: string | null } | null {
  for (const call of transcript.functionCalls) {
    if (call.callId === callId) return { name: call.name, arguments: call.arguments };
  }
  return null;
}

/**
 * `CommandExecution.command` 是**数组**（真机 `["powershell.exe","-Command","…"]`）⇒
 * `arguments` 缺席时用它拼出可读的入参对象。单字符串形态也认（另一个 CLI 版本的形状）。
 */
function commandShape(payload: Record<string, unknown>): unknown {
  const command = payload.command;
  if (Array.isArray(command)) return { command: command.filter((part): part is string => typeof part === 'string') };
  return command ?? null;
}

/** `arguments` 是 JSON 字符串 ⇒ 解析成对象；解析不了就退回命令形状（不丢事实、不编空对象） */
function parseArguments(raw: string | null, fallback: unknown): unknown {
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** `CollabAgentToolCall` 的入参：`tool` + 收件线程 + 派发原文（`prompt` 可能缺席） */
function collabInput(payload: Record<string, unknown>): unknown {
  const input: Record<string, unknown> = {};
  for (const key of ['tool', 'prompt', 'sender_thread_id', 'receiver_thread_ids']) {
    if (payload[key] !== undefined) input[key] = payload[key];
  }
  return input;
}

/** 线程 id → 会话文件 → 解析结果；任一步失败都返回 `null`（不抛，调用方据 `null` 少一条消息） */
function readByThreadId(
  codexHome: string,
  threadId: string,
  read: CodexTranscriptReader['read'],
): CodexTranscript | null {
  const file = findTranscript(codexHome, threadId);
  return file === null ? null : read(file);
}

/** 归一消息的类型别名（供 providers 的实现签名使用） */
export type CodexMessage = AgentMessage;
