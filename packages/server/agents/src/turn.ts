/**
 * 三家共用的运行骨架：注入 → 消费事件流 → 释放 → 组装结果。
 * 为什么集中一处：释放顺序、**轮次的发射门槛**、判定优先级（signal 已中止 → canceled；
 * 其余按实际结果）三家必须逐字一致——抄三遍必然漂移，而这几件事出错时都表现为
 * 「偶发卡住 / 状态对不上 / 数字不动」，是最难查的一类问题。厂商差异全部通过 hooks 注入。
 * 注意：本函数**不抛**——所有失败都折进 AgentRunResult.error（错误码需要承载处），
 * 编排层因此不需要给每个本次运行套 try/catch。
 */
import { createLogger } from '@aieval/core';
import type { SubagentRecord, UsageTiming, UsageTokens, UsageTurn } from '@aieval/contracts';
import { createEventEmitter, logDraft, type AgentEventDraft, type EventEmitter } from './emit';
import { classifyAgentFailure, type AgentFailure } from './errors';
import { createMessageAssembler, type BlockIndexAllocator, type MessageDraft } from './message';
import { releaseTurn, RELEASE_GRACE_MS } from './release';
import {
  buildStructuredOutputFeedback,
  inspectStructuredOutput,
  planStructuredOutput,
  type StructuredOutputInspection,
} from './structured-output';
import { createAskUserPort, type AskUserPort } from './ask-user';
import { withInjectionWait } from './inject';
import type { AgentKind, AgentRunInput, AgentRunResult, InjectionPort } from './types';

/**
 * **没开闸门时的注入端口**（调用方没传 `input.inject`）：与「调用方传了一个 `available: false`
 * 的端口」逐格同形，适配器因此只判 `available` 一格。
 *
 * 为什么 `retract` 回 `'unsupported'` 而不是 `'unknown'`：没接端口就是**做不到撤回**
 * （能力面上那一格是 `none` / `off-by-adapter`），而 `'unknown'` 读起来像「我们再查查」——
 * 界面据此说的话完全不同。
 */
const CLOSED_INJECTION_PORT: InjectionPort = {
  available: false,
  drain: () => [],
  markDelivered: () => {},
  retract: async () => 'unsupported',
};

export interface TurnContext {
  input: AgentRunInput;
  /** 骨架持有的中止入口：厂商 SDK 需要它硬中止（claude 的 abortController / codex 的 signal） */
  controller: AbortController;
  emitter: EventEmitter;
  /**
   * **提问端口**：模型问到用户时，适配器从这一格拿「问一次」（`ask`），并按 `available` 决定
   * 挂不挂厂商钩子、开不开厂商开关（没挂应答面 ⇒ 一个都不动，既有行为逐字不变）。
   * 等待语义（本次运行终止 / 预算 / 静止超时豁免 / 回调抛错）全收在它里面，适配器不自己判。
   */
  askUser: AskUserPort;
  /**
   * **注入端口**：人往运行中的这一轮送话时，适配器从这一格取件（`drain`）、把「怎么要回来」
   * 登记回去（`markDelivered`）、并按 `available` 决定挂不挂厂商那一侧的投递形状
   * （没开闸门 ⇒ 一格都不挂，既有行为逐字不变——这就是零回归的判据）。
   *
   * 为什么由骨架备好而不是让适配器自己读 `input.inject`：缺席时要有一个**关闭档**替代物
   * （`available: false`、`drain` 恒空、`retract` 恒 `unsupported`），四处各写一遍必然漂；
   * 这与 `askUser` 由骨架备好是同一处置（那边还多一层等待语义，注入的等待语义在编排层那一侧）。
   */
  inject: InjectionPort;
  /**
   * **内容级消息的流外投递口**：厂商把「模型的一次工具调用」放在事件流之外（codex 的提问是
   * server→client 请求，厂商的线程条目里没有这一格，见 `providers/codex/ask-user.ts`）时，
   * 观察到它的适配器用这一格把那条消息投进账本——不投，账本里就只剩答复那一半。
   *
   * 为什么不让适配器自己写 `input.onMessage`：`messageId` 的 `seq`、合并键、块序号都由合并器分配，
   * 绕开它等于在适配器里再造一遍取号，两处必然漂（表现是同一轮里块互相覆盖）。
   * 投进来的草稿与通知流里那些走**同一条路**（合并器 → `onMessage`），消费方看不出差别。
   */
  emitMessage: (draft: MessageDraft) => void;
}

/** 收尾产出的两类载荷：运行级事件与内容级消息（顺序即产出顺序，各自内部保序） */
export interface TurnFinalize {
  drafts: AgentEventDraft[];
  messages?: MessageDraft[];
  subagents?: SubagentRecord[];
  /**
   * 收尾交回的**计量**。为什么必须能交回结果值：
   * codex 的子线程用量**只在收尾读盘时才知道**，而编排层第 6 步会用 `result.tokens` 覆盖快照
   * ⇒ 只发一条 `usage` 事件的话，那个数会在几毫秒后被不含子线程的 `result.tokens` 盖掉
   * （界面在终态那一下「掉下去」）。
   * `tokens` / `turns` 的 `null` 与缺省都表示「本条不带这一格」（**不是清空**）——
   * 与 `TurnProjection.tokens` 的处置逐字相同。
   */
  tokens?: UsageTokens | null;
  /**
   * **子智能体那一份**。⚠️ **这一格的 `null` 语义与 `tokens` 刻意不同**（预检裁定）：
   * `null` = **明确没采到** ⇒ 覆盖成 `null`（否则读失败时旧的偏大分量会留在那儿，
   * 而合计已退回主会话口径 ⇒ 破坏 `subagentTokens ≤ tokens` 这条不变量）；
   * 只有**缺省（undefined）**才是「本条不带这一格、保持原值」。
   * 为什么不让两者同语义：`tokens` 的 null = 「这一条没带计量」（在 dsh 上轮次单独到达是常态），
   * 而子智能体那一份只有「读到了」与「读失败了」两种，没有「这一条不谈它」这种中间态。
   */
  subagentTokens?: UsageTokens | null;
  /**
   * **子智能体那一份**轮次。与 `subagentTokens` **逐条同语义**（含那一条不对称）：
   * `null` = **明确没采到** ⇒ 覆盖成 `null`（子线程被上限截断、某个子智能体读不出轮次时必须能清掉，
   * 否则它与已退回主会话口径的 `turns` 一起破坏 `subagentTurns ≤ turns`）；
   * 只有**缺省（undefined）**才是「本条不带这一格、保持原值」。
   */
  subagentTurns?: number | null;
  turns?: number | null;
  /**
   * 本次运行**实际**走的是哪条通道（可选）：`true` = 答复落在原生 schema 通道上。
   * 缺省 = 没走原生通道（该家没有这条通道，或本次没要求 schema）——缺省与 `false` 同义，
   * 因为「没上报」在消费侧与「没走」是同一件事。
   * 为什么由适配器上报：只有适配器知道厂商这一轮到底照做没有（cc 的收尾消息里有没有
   * `structured_output`、codex 有没有把 schema 发进 `turn/start`）。骨架**不再**读任何能力位。
   */
  applied?: { structuredOutput: boolean };
  /**
   * 这次跑在哪条**会话**上（可选上报）：`null` 与缺席都表示「本条不带这一格、保持原值」——
   * 骨架只搬运、不猜：这一格只有适配器拿得到（各家的会话 id / 会话文件各不相同），
   * 读不到就如实不报（结果那一格照旧是 `null`）。
   */
  sessionId?: string | null;
}

/** 一次运行的消费句柄：各家 start() 造出来，骨架负责按固定顺序使用并保证一定会释放 */
export interface TurnStart {
  /** 在途消息流；迭代结束即「在途 turn 终结」 */
  stream: AsyncIterable<unknown>;
  /** 发停止信号；允许空实现（dsh 的 cancelMidTurn 为 false） */
  interrupt: () => void;
  /**
   * 硬回收：必须幂等（用 createDisposer 包一层最省事），并且必须在返回后的**有限时间内**做完
   * **它自己拥有的**那些回收（子进程 / 临时目录 / 关闭信号）——骨架的
   * `for await (const raw of started.stream)` 只有自己退出才会走到 `finally` 释放，第二段的 5 秒兜底
   * 只保证 `dispose()` **被调用**。
   *
   * ⚠️ **硬要求：进程回收是「整棵树 + 等确认」，不是「发个信号」**。
   * `child.kill()` 在 Windows 上只杀直接子进程，而厂商 CLI 会在自己内部 spawn 一串下级进程
   * （真机：codex 的插件同步 `git` 链），它们**继承父进程的句柄**、继续捏着本次运行的配置目录
   * （`.agenthome` / `.judgehome`），下一轮的行产物清理就此 `EPERM`。落地口径：
   *   · **谁 spawn 谁负责整棵回收**（本仓自己 spawn 的：`providers/codex/appserver/client.ts`
   *     走 `process-tree.ts` 的 `terminateProcessTree`，Windows `taskkill /T /F`、POSIX 进程组）；
   *   · **SDK 代 spawn 的家**（claude / dsh）拿不到 pid，只能走 SDK 的硬停止通道 ⇒ 那是**尽力**，
   *     必须在《厂商进程生命周期规范》的归属表里如实登记，不许声称做到了。
   * 骨架这一层的义务是**顺序**（`interrupt` → 终结在途 turn → `dispose`）与**兜底调用**；
   * 「整棵」这件事在适配器里。
   * **能力边界**：`dispose` 只能**尽力**让 `stream`
   * 的迭代结束——本层无法强制中止一个卡在 `await` 上的迭代器：`dispose` 里的「关闭迭代」类动作
   * （例如关闭厂商 SDK 的事件迭代）在迭代挂起时只是**排队**，要等它自己落到下一个挂起点（yield / 结束）
   * 才生效 ⇒ **`runTurn` 可能无界返回**。所以这里不再是「必须在有限时间内让迭代结束」的硬约束，
   * 而是「尽力 + 登记边界」。
   * 「一行不会永远停在 running」这条**用户可见**的不变量：**静止由看门狗兜底、总时长仍不限**
   * （用户口径「执行不限时间、评分不限轮次和时间」：编排层没有 `hardDeadline` / `timedOutCandidates`）。
   * 看门狗只是**发起停止的又一个来源**（两级上限见 `AgentRunInput.watchdog`）——发起之后仍然要适配器
   * 肯把迭代交出来，一个连停止信号都不理的适配器会让那一行**一直挂着**，这是已知代价（登记在包的
   * README 里）。能停下它的另外两个来源是用户点「终止」与宿主停机：编排层在行落终态时唤醒行任务、
   * 并给 5 秒交卷窗口（`orchestrator.ts` 的 `terminalWaiters` / `TERMINATION_GRACE_MS`）。
   * codex 侧的具体边界与可达的那一格见 `providers/codex/index.ts` 的 `closeRunStream`。
   * T7–T9 各自要有一条用例钉住「dispose 之后流与回收的可观测量」——不一定是「流在有限时间内结束」。
   */
  dispose: () => Promise<void>;
  /**
   * **流正常结束之后**、释放之前的一次性收尾（可选）。返回的事件由骨架按顺序发出。
   *
   * 为什么需要这一格（2026-10-XX 新增，codex 的会话文件读取）：有一类信息**只在事件流关闭之后**
   * 才可读——codex CLI 把推理正文与子智能体的消息写进 `$CODEX_HOME` 下 `sessions/` 里的
   * `rollout-*.jsonl`，
   * 而那份文件在整个运行期间都在被追加。放到投影里会在每条事件上都读一次盘（且读到半截文件），
   * 放到 dispose 里又太晚（那之后发的事件没人保证还在消费）。
   *
   * 三条语义，缺一条都会让某家出现「行为悄悄变了」：
   *   1. **流跑完就调用**（正常结束；**迭代抛错 / 被中止时也调**，见下）：codex 的收尾读的是
   *      `$CODEX_HOME/sessions/rollout-*.jsonl`，而那份文件**是 CLI 边跑边追加的**——它记下的
   *      就是「跑到哪就写到哪」的真实内容，不是一份需要跑完才成立的产物。失败或终止的运行里，
   *      那份文件同样有内容（一条被中断的 codex 行留下 688 KB 的会话文件，里面是
   *      完整的推理、正文与工具调用）。**丢掉它等于把已经落盘的事实藏起来**，
   *      表现就是抽屉上那句「还没有日志 · 本次运行还没开始执行」——而本次运行明明跑过。
   *      （收尾**只读盘、不编造**，读不到就一条都不产出；而「失败行看不到它说过什么」是排障时最缺的
   *      那一条信息——所以失败与终止的运行同样收尾。）
   *   2. **抛错只记日志**，不改变本次运行的结论——收尾失败是**补充信息**失败，
   *      不该把一次成功的运行翻成失败（与 `dispose` 的处置同一条理由：可见性次于结论）；
   *      反过来，收尾**成功**也不改变结论：失败仍然是失败，只是内容补上了。
   *   3. **释放之前调用**：它可能需要本次运行还活着的资源（临时目录、文件句柄）。
   *
   * 为什么返回值是「事件」而不是 `TurnProjection`：收尾不产生新消息的计量或失败归因，
   * 硬套投影形状会逼实现写一堆 `tokens: null, turns: null, failure: null` 的噪声。
   */
  finalize?: () => TurnFinalize;
  /**
   * **在同一会话里追问一轮**（可选）：返回**新的活动区间**（新的 `stream` / `project`），
   * 骨架把它与首轮**逐字同形地**消费（同一套去重、累计与失败取舍）。
   *
   * 用途只有一个：**结构化输出的形状修正**——首轮答复过了 `JSON.parse` 但不符合
   * `AgentRunInput.outputSchema` 时，骨架把「问题清单 + schema + 它自己的原文」交给这一格，
   * 让模型**只改形状、不重跑任务**（`buildStructuredOutputFeedback` 的原文就是这么写的）。
   *
   * 三条契约（缺一条就会在真机上出问题）：
   *   · **同一个运行时**：`dispose` 仍然只由首轮那一格负责（`releaseTurn` 记忆化，整 run 一次），
   *     追问**不许**新建进程——新建一个等于把「同会话」这件事丢掉，成本也翻倍；
   *   · **同一会话**：模型手里已经有首轮的全部上下文（工作区、工具结果、自己的答复），
   *     换会话重问就是让它把活重干一遍，而那正是这一格要避免的；
   *   · **不实现就是不修**：没有这条通道的家在答复不合格时如实收场（骨架会落一条 WARN），
   *     由调用方按 `finalText` 的既有契约处置。
   *
   * 为什么挂在 `start` 的产物上而不是 `TurnHooks` 上：追问要用到**这一次运行**的运行时与会话
   * （dsh 的 `sessionId`、codex 的 thread、cc 的 session），那些东西只有 `start` 造得出来——
   * 挂在 hooks 上就得靠模块级表去捞它们。
   */
  continue?: (prompt: string) => Promise<TurnStart>;
  /** 投影一条原始消息；state 由骨架维护并传给每一家 */
  project: (raw: unknown, state: TurnState) => TurnProjection;
}

/** 骨架维护的跨消息状态 */
export interface TurnState {
  /** 已见过的厂商消息 id：唯一允许丢弃的事件是**重复事件** */
  seen: Set<string>;
  /**
   * 已累计的轮次：**一次模型 API 往返算一次**（用户口径）。三家各自在这个字段上
   * 累加/覆盖自己的口径（cc 用「见过的 `assistant.message.id` 数」覆盖；codex 数**模型答复
   * 条目**（`item.type === 'agent_message'`——推理与工具条目对这把尺子透明）；
   * dsh 数 `step`），骨架只负责把它交给结果与 `usage` 事件。
   * **这个 `0` 只表示「已观察到的轮次累计」，不是「采到了 0 轮」**：适配器不要把 state.turns
   * 直接回填进 `TurnProjection.turns`——没采到轮次时它必须是 `null`（「计量绝不填 0」是硬口径），
   * 否则 tokens 已采到、轮次没采到时就会发出 `turns: 0` 的 usage 事件，让人得出「这家很省」的错误结论。
   */
  turns: number;
  /**
   * 已累计的计量（`null` = 还没采到任何一项，不是 0）。
   * 为什么骨架要管这件事：dsh 的真实形状是「用量在 `assistant/message` 上、
   * 轮次在 `step/start` / `turn/end` 上」——两者**不在同一条通知**里。适配器把用量记在这里，
   * 到给出轮次的那条出口上连同轮次一起交出去，于是「一条通知给 tokens、另一条给 turns」也能落成
   * 一条合法的 usage 事件（而不是静默丢掉计量）。
   * 口径：**dsh 这里是整行累计**（交出时带全量，事件本身是覆盖语义），
   * claude 两者同消息、codex 根本不用这三个字段（它只在 `turn.completed` 上现取 usage）。
   */
  usageInput: number | null;
  usageCached: number | null;
  usageOutput: number | null;
  /**
   * 累计的**思考 token**（2026-10-XX 新增；`null` = 这一家一次都没报过，不是 0）。
   * 为什么与上面三格分开放而不是并进一个对象：三格在 dsh 上要**逐 step 相加**（现在的写法），
   * 而这一格只有 dsh 用得到；并成一个对象会让三家的写法都被迫改一遍（收益只是形式统一）。
   * 口径与实现（哪些家会写、相加还是覆盖）见 `providers/dsh/events.ts` 的 `assistant/message` 分支。
   */
  usageReasoningOutput: number | null;
  /**
   * **厂商自报的总量**（2026-10-XX 新增；`null` = 没报）。
   * ⚠️ 只**覆盖**、不相加，且**不参与**归一后的恒等式（它是排障证据，见契约的 `UsageTokensSchema`）。
   */
  usageTotal: number | null;
  /**
   * 本次运行到目前为止的**时间跨度**（2026-10-XX 新增；`null` = 一次都没采到时间）。
   * 为什么放在 `TurnState` 而不是骨架的局部变量：dsh 的 `assistant/message` 与 `turn/end`
   * 都要读它（每一次交出的是「到目前为止」的累计跨度，与 `usage*` 三格同一口径），
   * 而这两条出口都是 `project` 里的纯函数分支——只有 `state` 能在它们之间传递。
   * claude / codex 两家**不写这一格**（前者的时间直接随投影交出、后者在 `finalize` 里现读会话文件）。
   */
  timing: TimingSpan | null;
  /**
   * cc 的**跑动期用量估算**：`message.id` → 那条 API 轮次的用量。
   *
   * 为什么需要它：SDK 在流式响应里按**完成的内容块**逐条发 assistant 消息，若干条共享
   * `message.id`、各自带一份尚未最终的 `message.usage`（`sdk.d.ts`：message.usage is not final），
   * 而结算值只在 `result` 消息上。要「跑动期就出货」，就必须按 id 归并（后到的快照覆盖先到的），
   * 否则同一条消息的重复快照会被重复累加、出一个偏大的假数。
   * **只服务估算**：它不参与 `AgentRunResult`（那条路只认 result 的结算值与 codex/dsh 的权威口径）。
   */
  usageByMessageId: Map<string, UsageTokens>;
  /**
   * **轮次计数键**（一次模型 API 往返一个键，按集合去重后 `size` 就是轮次）。各家用自己能拿到的
   * 那个键：cc 用主循环的 `assistant.message.id`（一条响应会按内容块多条到达、共享同一个
   * id）；codex 用**模型答复条目**（`item.type === 'agent_message'`）的 `item.id`
   * （`item.started`/`updated`/`completed` 共享同一个 id；推理与工具条目不算——它们对这把尺子透明，
   * 见 `providers/codex/events.ts` 的 `TURN_ITEM_TYPES`）。
   * 为什么与 `usageByMessageId` 分开、且**不用** `state.turns` 自增：那张表只收「三项用量齐全」
   * 的消息，而轮次必须在采不到用量时照样涨——实测那一轮 cc 的用量几乎采不到，
   * 「轮次被 token 拖住」的根因正在这里。
   */
  turnKeys: Set<string>;
  /**
   * 智能体的最终答复（供 `AgentRunResult.finalText` 带出）。
   * 由各家的 `project` 在**已识别的那条收尾消息**上写入；没见到就保持 null（不猜）。
   * 为什么放在跨消息状态里、而不是让 `project` 直接返回：`project` 的返回值是**事件**，
   * 而答复不是事件——它已经作为 log 事件落过盘了，再发一条就是重复。
   *
   * ⚠️ 它与 `finalText` 的关系是**覆盖**：每见到一条带正文的消息就更新一次，所以它最终是
   * 「最后一条非空正文」。这不等价于「用户看到的最终答复」（评分通路读的正是这一格），
   * 且三家都是同一行为 —— 契约上按「最后一次观察到的正文」用。
   */
  finalText: string | null;
  /**
   * **块序号分配器**：`载体 → 分配器`，由各家的 `project` 维护（骨架只提供存放处）。
   * 载体 = `subagentId ?? 'main'` + `roundTrip` + `role` + `parentCallId`（与合并键同一口径）。
   * 为什么要跨消息存活：新块只能追加到末尾、序号一经分配不再变化，
   * 而块序号正是合并键里区分「同一轮的第几个块」的那一段。
   */
  blockIndices?: Map<string, BlockIndexAllocator>;
  /**
   * **块序号计数器**：`载体 → 已经分配出去的块数`，给**顺序分配**的通道用（codex 的事件流：一条条目
   * 一个块、按到达顺序占号）。与上面的 `blockIndices` 分开：那一格存的是分配器实例（dsh 要按厂商
   * 序号换算），这一格只是一个计数。
   */
  messageBlockCounters?: Map<string, number>;
}

/**
 * 一条消息**自带**的时间数据（2026-10-XX 新增）。
 *
 * 为什么不是「直接给一个 `totalMs`」：三家能给的东西形状不同，而这个类型要让两者都能表达——
 *   · claude 的 `result` 上直接有 `duration_ms`，另有 `duration_api_ms` / `ttft_ms` 两个**只有它
 *     才有**的格子（真机四个样本全在）⇒ 这三个数按厂商原文带出去，**一个都不许换算或丢失**；
 *   · codex / dsh 只能在事件或会话文件行时间戳上找首末两点**现减**（于是我们算出来的那一段
 *     含工具执行时间）⇒ 这种数据只能表达成「起点 + 终点」。
 * 合并成一种形状（两个时刻 + 两个可选格）之后，骨架不必知道谁是谁，而**来源必须标出来**
 * （口径差异见契约的 `timing` 注释：vendor 是纯模型时间，events 是墙钟，两者不可直接比）。
 *
 * ⚠️ 两个时刻**各自可空**，且判空一律用 `null` 而不是 0：epoch 0 是合法时刻，
 * 拿 0 当哨兵会让「真的有这一格」被当成「没有」——与「0 与没采到含义相反」是同一条推论。
 */
export interface TimingSpan {
  /** 这一段的**起点**（epoch 毫秒）；null = 这一条消息给不出起点 */
  firstMs: number | null;
  /** 这一段的**终点**（epoch 毫秒）；null = 这一条消息给不出终点 */
  lastMs: number | null;
  /**
   * 仅 API 时长（毫秒）。**只有 claude 有**（`duration_api_ms`），另两家一律 `null`。
   * 为什么不让骨架拿 `totalMs` 兜底：那会把工具执行时间算进「模型有多快」，而两者真机能差好几倍。
   * 缺省（undefined）= 这一条消息没带这一格（与「带了、但值是 null」在**事件**层是同一件事，
   * 因为契约里这一格可空；草稿层不区分，见 `emit.ts` 的 `AgentEventDraft`）。
   */
  apiMs?: number | null;
  /** 首 token 时延（毫秒）。同上，**只有 claude 有**（`ttft_ms`）。 */
  ttftMs?: number | null;
  /**
   * 这段时间的**来源**（必填，因为它是消费方唯一能看出「能不能横向比」的依据）：
   *   · `'vendor'` = 厂商自报（纯模型时间）；
   *   · `'events'` = 我们按事件 / 会话文件行时间戳算的（含工具执行）。
   * 口径差异见 contracts 的 `timing` 注释——**别在这一层合并两种来源**：一家只会有一种来源，
   * 而 `mergeTiming` 里对来源不一致的处置是「整格作废」（见那个函数的注释）。
   */
  source: UsageTiming['source'];
}

export interface TurnProjection {
  /** 本条消息要发出去的事件（空数组 = 纯重复事件，唯一允许丢弃的一类） */
  drafts: AgentEventDraft[];
  /** 本条消息采到的计量；未采到为 null（**不是 0**） */
  tokens: UsageTokens | null;
  /**
   * **子智能体那一份**用量。三档：
   *   · 缺省（undefined）= 本条不带这一格（保持骨架里已有的那一份）；
   *   · `{…}` = 「主会话之外、到目前为止」的读数（仍在跑的子智能体算「到目前为止」）；
   *   · `null` = **明确没采到**（有子智能体但读失败）⇒ 骨架把它记成 null，界面据此退回单行 Tooltip。
   * 与 `tokens` 的 null 语义不同：`tokens: null` 是「本条没带」，这里是「本条说了：没有这个数」。
   */
  subagentTokens?: UsageTokens | null;
  /**
   * **子智能体那一份**轮次。三档与 `subagentTokens` **逐字相同**：
   *   · 缺省（undefined）= 本条不带这一格（保持骨架里已有的那一份）；
   *   · `0`/`n` = 「主会话之外、到目前为止」的读数（仍在跑的子智能体算「到目前为止」）；
   *   · `null` = **明确没采到**（有子智能体但读不出轮次）⇒ 骨架把它记成 null，界面据此退回单行。
   * ⚠️ 它是**分量**：`turns` 仍是主 + 子的合计，骨架**不做加法**（加了就是双计）。
   * 恒有 `subagentTurns ≤ turns` —— 这一条正是「运行期交不出分量时不要硬交」的依据（各家的运行期
   * `turns` 口径见 providers：例如 codex 运行期只有主线程轮次 ⇒ 那一格此时不交，等收尾两格一起给）。
   */
  subagentTurns?: number | null;
  /**
   * `tokens` 是**估算值**（用户口径）：它只进 `usage` 事件给界面看，
   * **绝不进 `AgentRunResult.tokens`**——否则「崩溃 / 超时 / 被杀」的本次运行会带着一份估算被写成
   * 「采到了计量」，而快照是唯一落盘真相。缺省（undefined）= 权威值。
   * 为什么这个标记在投影上、而不复用别处的静态能力声明：静态声明回答的是「这一家整体上算不算
   * 估算家」（消费方据此决定要不要回写快照），这一格回答的是「本条消息给的这个数算不算结果」
   * （骨架的决策）。A2 起前者改由**事件自带的 `tokensBasis`** 表达（见下面 `liveTokensBasis`），
   * 静态声明那一路已经没有消费方；而按 kind 反查注册表会把骨架耦合到注册表，
   * 投影本来就知道自己报的是什么。
   */
  tokensEstimated?: boolean;
  /**
   * 本条消息自带的时间跨度（**可选**，2026-10-XX 新增）。
   *
   * 为什么由**骨架**累计而不是各家的 `project` 自己算比值：这件事在三家**逐字相同**
   * （首见即起点，再见即终点），抄三遍必然漂移；而 `usage` 事件的发射口本来就只有骨架那一个
   * （循环内的 `emit({type:'usage',…})`），把 timing 也放在那里，「一条 usage 事件 = 当时
   * 所有已知的计量与时间」这条不变式就不用三家各自维持。
   *
   * 三条语义：
   *   · **缺省（undefined）= 这一条没带时间**（不是「把已采到的时间清掉」）——claude 只在收尾的
   *     `result` 上给，dsh 只在 `turn/end`（与 `assistant/message`）上给，中间那些消息一律不带；
   *   · **`firstMs` 只认第一条**（最小值不取：`events` 来源下首末两点来自**有序**的事件流，
   *     取最小/最大反而会把时钟回拨那类脏数据算进来）；
   *   · **两点各自可空**（`null`）：只知起点时照样记起点，等终点到了再算——一条只有起点的跨度
   *     不产生 `totalMs`（差值算不出来就是算不出来，**不拿 0 冒充**）。
   */
  timing?: TimingSpan;
  /**
   * 这一条读数**属于哪一轮**：`subagentId` = 会话身份（`null` = 主会话），
   * `round` = **该会话自己的**第几次模型往返。缺省/`null` = 本条没有归属 ⇒ 发出去的 `usage.turn` 是 `null`。
   *
   * ⚠️ **刻意不结转上一条**（与 `subagentTokens` 的「保持原值」相反）：归属说的是「**这一条**读数发生在
   * 哪一轮」，结转会把上一条的会话贴到这一条上（dsh 的 `turn/end`、codex 的收尾条都可能换了会话）。
   * 三家的义务因此是一致的：**凡是能触发 `usage` 事件的那条投影，就要带上这一格**。
   */
  turn?: UsageTurn | null;
  /** 本条消息给出的轮次总数；未给出为 null */
  turns: number | null;
  /** 本条消息是否表示失败 */
  failure: AgentFailure | null;
  /**
   * 本条消息表示**一次新的模型往返已经开始**（厂商起了一轮）。
   *
   * 为什么需要这一格：墙钟看门狗的口径是「一次模型往返」而不是「厂商的一轮」（见下面 `consume` 的
   * 记账注释），而它的重置点只有两处——区间起点、以及 `turns` 递进。一次运行**跨多轮**时
   * （人话在收场后被续跑成一幕新的 turn），两轮之间有一段既没有新区间、也没有轮次递进的空档，
   * 上一轮耗掉的墙钟会一直算进新的一轮里 ⇒ 上一轮接近预算时，新起的那一轮会被自己的看门狗掐掉。
   * 厂商在轮次起点发的通知就是这一格的落点（缺省 = 本条不声明）。
   */
  roundTripStarted?: boolean;
  /**
   * 本条消息归一出来的**消息草稿**（`AgentMessage`，缺省 = 本条不产出消息）。
   * 合并、块序号分配与 `messageId` 由骨架的合并器统一做（`message.ts`），各家只填信封字段与块。
   * 与 `drafts`（运行级事件）**并行**输出：事件是运行级审计与 SSE 的载体，消息是内容级视图的载体。
   */
  messages?: MessageDraft[];
  /**
   * 本条消息归一出来的**子任务行**。同一身份会多次投递（派发 / 收场），
   * 后者是完整快照；缺省 = 本条不改变任何子任务状态。
   */
  subagents?: SubagentRecord[];
}

export interface TurnHooks {
  kind: AgentKind;
  /** 建运行时并返回消费句柄；抛错由骨架折进结果（加载失败 → AGENT_LOAD_FAILED） */
  start: (context: TurnContext) => Promise<TurnStart>;
}

/**
 * 结构化输出的**修正轮上限**（不含首次回答）：2 轮 = 最多 3 次模型往返。
 * 为什么是 2：与文本评分通路的 `JUDGE_REPAIR_ROUNDS` 同数（两条通路的成本口径要对齐），
 * 而形状错误通常一轮就够——继续追问只会在一个不肯守契约的模型上白烧上下文。
 */
export const STRUCTURED_OUTPUT_REPAIR_ROUNDS = 2;

/**
 * 空闲上限缺省值（毫秒）：连续这段时间**没有任何产品事件**就判本次运行静止。
 *
 * 取值受三条约束，缺一条就会误杀或白等：
 *   · **大于已知的合法静默**：厂商的自动重试退避最长可到 60 s（一轮默认重试链实测最长静默 8 s），
 *     首字延迟也在这一档里；
 *   · **大于宿主的等待预算**：运行内首次注入的等待预算是 20 s 量级；
 *   · **不晚于厂商自带的兜底**：几家自带的流空闲容错在 300 s 上下，等它只会更晚发现挂死。
 */
export const DEFAULT_IDLE_TIMEOUT_MS = 180_000;

/**
 * 单次**模型往返**的墙钟上限缺省值（毫秒）：它只兜「一直有输出、但一次往返都不收尾」那一格，
 * 与「一本次运行跑多久」无关（用户口径「执行不限时间」不变；套在整本次运行上等于把总上限加回来）。
 * 比空闲上限宽三倍多，又与各家自带的兜底同量级但**独立**（不继承它的失效）：两级同时开着时，
 * 先开火的总是空闲那一级，墙钟是给 drip 型挂死准备的第二道闸。
 */
export const DEFAULT_TURN_WALL_CLOCK_MS = 600_000;

/** 看门狗开火的是哪一级：空闲（没有输出）还是单轮墙钟（一次模型往返不收尾） */
export type WatchdogTrip = 'idle' | 'turn-wall-clock';

/**
 * 「工具在途可以合法静默」的家 ⇒ 在途工具期间**两级**静止计时都挂起。
 *
 * 为什么是**按家**的表而不是按事件：同一个形状（工具调用之后整段没有输出）在两家的含义相反——
 *   · dsh：工具输出**不投**通知流（`tool/call` / `tool/result` 只有首尾两发）⇒ 一条全程无输出的长命令
 *     与「对端挂了」在这条通道上完全同形；它的 `bash` 还允许显式 `timeoutMs`（上限 600 s）
 *     ⇒ 不豁免就会把合法的静默长命令判成静止超时；
 *   · pi：同理。`tool_execution_update` **只在工具有输出时**才发（bash 把子进程 stdout/stderr 的
 *     `data` 事件接成更新回调），静默工具全程只有 `tool_execution_start` 那一发；它的 bash 工具
 *     **没有默认超时**（`timeout` 是可选参数，不传就不设表）；事件全集里也没有心跳 / keep-alive
 *     这类事件（`agent_start/end`、`turn_start/end`、`message_*`、`tool_execution_*`，加上会话级的
 *     `agent_settled` / `queue_update` / `compaction_*` / `auto_retry_*` / `bash_execution_update`）
 *     ⇒ 静默长工具与「对端挂了」在这条通道上同形，不豁免就会把 `pnpm install` 那种三分钟不吭声的
 *     合法命令判成静止超时；
 *   · cc / codex：工具在途自带节拍（cc 每 30 s 一件 `tool_progress`、codex 的单次 `exec_command`
 *     静默硬夹 30 s）⇒ 豁免它们只会把真挂死的工具藏起来。
 * 表是**穷尽**的（`Record<AgentKind, boolean>`）：每个 kind 都必须显式给一格，新增一家时漏了这格
 * 会在编译期报错。取值口径是**默认不豁免**（比「默认豁免」严：宁可早发现挂死，要放宽必须显式登记
 * 一行，并给出该家「工具在途确实可能合法静默」的证据）。
 * 工具自己的预算不在骨架这一层：卡死的工具只能靠用户点「终止」，这是既有口径。
 *
 * ⚠️ **「等待审批在途」不在这张表里（未豁免，如实登记）**：口径要求它也挂起，但识别「在等审批」的
 * 事件**按家不同、今天采不到**——dsh 的 `read-only` 档 approval 仍是 `ask`（越界操作停在无人应答的
 * 批准上，见 `types.ts` 的 `AgentPermission`），而它的 wire 上没有「待批准」这条通知（server→client
 * 请求通道尚未实现，`approval/policy` 只是装配期一次性的档位事实）⇒「在等审批」与「对端挂了」在这条
 * 通道上同形。**不许拿事件名凑判据**：要放宽这一格，先按家拿到可证的信号再往这张表里加，并同步
 * 《进程生命周期》的「静止超时」一节。
 */
const TOOL_IN_FLIGHT_SUSPENDS_WATCHDOG: Record<AgentKind, boolean> = {
  cc: false,
  codex: false,
  dsh: true,
  pi: true,
};

/**
 * 「在等用户回答」期间 ⇒ **两级**静止计时都挂起，四家一律挂起。
 *
 * 与上面那张表的差别是刻意的：工具在途「有没有节拍」按家不同，而**等人回答这一段时间里四家都不会
 * 有任何厂商事件**——厂商正阻塞在同一次工具调用上，人在浏览器里答多久与厂商没有任何关系。
 * cc 这一家是这条最直白的实例：提问落在**权限回调**上，回调不返回期间厂商在整段等待里既不下发
 * 工具结果、也不再发后续请求；不豁免的话，每一次人工介入都会被看门狗按静止超时收掉
 * （空闲上限是分钟级，而人答一题常常更久）。这一段的时限由**这一问自己的等待预算**给（见
 * `ask-user.ts` 的 `DEFAULT_ASK_USER_BUDGET_MS` 与厂商自己的预算），所以挂起不等于无限等。
 * 表仍是**穷尽**的（`Record<AgentKind, boolean>`）：新增一家时必须显式给一格，
 * 免得「这家为什么豁免」变成没人回答得了的问题。
 */
const AWAITING_ANSWER_SUSPENDS_WATCHDOG: Record<AgentKind, boolean> = {
  cc: true,
  codex: true,
  dsh: true,
  pi: true,
};

/**
 * 「在等人工消息」期间（适配器已收工、只剩队列）⇒ 两级静止计时都挂起。
 *
 * 判据由**端口那一侧**给（`inject.ts` 的 `InjectionWaitSink`）：适配器在 `'idle'` 边界空手而归，
 * 说明它这一整轮没活可干了，此刻唯一还可能让它继续跑的就是队列里再来一条人话。
 * 窗口因此**很窄**——适配器还在跑时事件照来，那一段不豁免；宽了就会把真挂死藏起来。
 *
 * **取值口径 = 默认不豁免**（与「工具在途」那张表同源，见上面那段注释）：逐家打开要给出
 * 「该家在这一段确实可能合法静默」的证据。四家今天全 `false`——「收工之后继续等队列」那条行为
 * （`followUp` 那样的唤醒面）还没有一家接线，打开它只会让真正的挂死在界面上看不出来。
 * 表是**穷尽**的（`Record<AgentKind, boolean>`）：新增一家漏了这格会在编译期报错。
 */
const INJECTION_WAIT_SUSPENDS_WATCHDOG: Record<AgentKind, boolean> = {
  cc: false,
  codex: false,
  dsh: false,
  pi: false,
};

/**
 * **仅供用例**：把某一家的上面那一格临时改成 `true`（`null` = 还原）。
 *
 * 为什么需要它：产品侧四家全 `false`（要证据才打开），而这段接线本身必须能被断言——
 * 「窗口开着时看门狗不排、窗口合上后它重新排」这条不变量，只有在某一格能临时打开时才看得见。
 * 与 `setAgentRuntimeForTesting` 同一条处置：非测试环境调用直接抛错，免得有人把它当产品开关用。
 */
export function setInjectionWaitSuspendsForTesting(kind: AgentKind, value: boolean | null): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('setInjectionWaitSuspendsForTesting 只能用在用例里（产品侧的取值必须来自证据）');
  }
  if (value === null) delete injectionWaitOverrides[kind];
  else injectionWaitOverrides[kind] = value;
}

const injectionWaitOverrides: Partial<Record<AgentKind, boolean>> = {};

/** 在册的一次在途运行：宿主停机时按它逐个发起停止、并等它们各自释放完 */
interface LiveSession {
  kind: AgentKind;
  /** 发起停止（与用户点「终止」同一条路径；消费相之外是空操作——跑完了不再翻转结论） */
  stop: () => void;
  /** 该次运行的释放完成（含 5 秒交卷窗口；约定不 reject） */
  released: Promise<void>;
}

/** 本进程在册的在途运行（`runTurn` 进出自动登记 / 注销）。模块级：宿主停机要能看到全部 */
const liveSessions = new Set<LiveSession>();

/**
 * 回收本进程里所有在途运行，供宿主的停机信号处理器调用（见 `apps/web-next/instrumentation.ts`）。
 *
 * 两步顺序是刻意的：**先全部发起停止，再一起等各自释放**——逐个「停一个等一个」会让第 N 个会话
 * 白等前面每一个的 5 秒交卷窗口。没有在途运行时立即 resolve。
 * 不设上限：停机预算是**停机方**的事（那个调用点自己给），本层只保证「发起了停止、并等到各自释放」
 *（释放本身可能无界——那正是适配器不响应停止信号、连 dispose 也叫不醒迭代器的那一格）。
 */
export async function disposeLiveSessions(): Promise<void> {
  const sessions = [...liveSessions];
  if (sessions.length === 0) return;
  const logger = createLogger('agents/lifecycle');
  logger.warn('宿主停机：回收在途会话', {
    count: sessions.length,
    kinds: sessions.map((session) => session.kind),
  });
  for (const session of sessions) {
    try {
      session.stop();
    } catch (error) {
      // 停止信号自身失败不得挡住其余会话的回收：与 `release.ts` 里 interrupt 的 try/catch 同一条理由
      logger.error('发起停止失败（继续回收其余会话）', { kind: session.kind, error });
    }
  }
  await Promise.all(sessions.map((session) => session.released));
}

/**
 * 这一条投影有没有交出**任何产品事件**（看门狗的「有输出」判据）。
 * 刻意从宽：运行级事件、消息、子任务行、计量事件（`turns` 一到就发 `usage`）都算。判据窄了会把
 * 「工具在途的一整段」读成静止——cc 的 `tool_progress` / `system/api_retry` 走的是未识别负载的
 * 兜底投影，漏掉它们等于误杀正在干活的工具。
 */
function projectionHasOutput(projection: TurnProjection): boolean {
  return (
    projection.drafts.length > 0
    || (projection.messages?.length ?? 0) > 0
    || (projection.subagents?.length ?? 0) > 0
    || projection.turns !== null
  );
}

/**
 * 把一条投影里的工具块折进在途集合：`tool-call` 记上、`tool-result` 按**同一个 `callId`** 销账。
 *
 * 为什么按块判而不是按厂商事件名：工具的在途状态是**跨家同形**的东西（调用有 id、结果配对同一个 id），
 * 而各家的事件名互不相同；按块判等于复用消息层已经归一好的配对键。
 * 两个方向都危险：漏记 ⇒ 静默的长工具被误杀；错销账（别的 id 的结果把它清了）⇒ 挂死的工具被当成
 * 合法静默、再也不会被发现。
 */
function trackToolBlocks(projection: TurnProjection, inFlight: Set<string>): void {
  for (const message of projection.messages ?? []) {
    for (const draft of message.blocks) {
      const { block } = draft;
      if (block.type === 'tool-call') inFlight.add(block.callId);
      else if (block.type === 'tool-result') inFlight.delete(block.callId);
    }
  }
}

/**
 * 问题清单的第一条 → 一行可展示的文本。
 * 日志里只放第一条：完整清单是**回灌给模型**的原料（在修正提示词里），日志的读者是人，
 * 他要的是「哪儿不对」而不是一份逐格报告。
 */
function firstProblem(inspected: Extract<StructuredOutputInspection, { ok: false }>): string {
  const first = inspected.problems[0];
  return first === undefined ? '（未给出具体问题）' : `${first.path}：${first.message}`;
}

export async function runTurn(input: AgentRunInput, hooks: TurnHooks): Promise<AgentRunResult> {
  const startedAt = Date.now();
  const emitter = createEventEmitter(input.onEvent);
  const logger = createLogger(`agents/${hooks.kind}`);

  /**
   * 受保护的事件发射：`onEvent` 是**消费方**的代码，它会抛——
   * `publishCandidateEvent → appendEvent` 在写侧 schema 不过时抛 `ServiceError`，磁盘写失败同样抛。
   * 而本函数的承诺是「永不抛、所有失败折进 AgentRunResult.error」，且编排层**不给每个本次运行套
   * try/catch**（正因 run() 承诺不抛）。裸调 `emitter.emit` 一旦被消费方抛错，后果按位置分两种：
   *  - 循环内：异常被下面的 catch 归因成 `AGENT_FAILED`，把「日志写盘失败」误报成「适配器运行的失败」；
   * 循环外（释放路径的 `onGraceExceeded` 尤其）：`finally` 里的 `await triggerRelease()` 抛出 ⇒
   *    `dispose()` 可能未走完，且正常结论被异常替换。
   * 因此**本文件里全部 6 个发射点**都走这里（启动前中止 / 第二段兜底 / 循环内 drafts / 循环内 usage /
   * canceled 摘要 / error 事件），`emit.ts` 的裸调只允许出现在这个 `try` 里。
   * 注意这是**约定 + 用例**层面的保证，不是类型层面的：`(draft) => void` 拦不住调用方传入一个未包装的
   * 闭包，所以每个调用点都得有回归钉。
   * 必须记 `logger.error`：`release.ts` 的对应修复刻意吞掉 `onGraceExceeded` 的异常（「可见性次于
   * 一定回收」），这层若不记，这类失败就彻底静默了。
   */
  const emit = (draft: AgentEventDraft): void => {
    try {
      emitter.emit(draft);
    } catch (error) {
      logger.error('事件回调失败（不掩盖本次运行的结论）', { error });
    }
  };

  /**
   * 消息合并器：**一份 run 一个**（块序号分配与 `messageId` 的 `seq` 都要跨消息存活）。
   * 与事件同一条处置（消费方抛错不得打断运行、更不得改写结论）：消息是内容视图的载体，
   * 它出问题不该把一次跑完的运行翻成失败。
   */
  const assembler = createMessageAssembler({ runId: `run-${hooks.kind}` });
  const emitMessage = (draft: MessageDraft): void => {
    // 没传 `onMessage` 的调用方不消费内容视图：合并器整条链路都不启用（省掉序号分配与块合并）
    const sink = input.onMessage;
    if (sink === undefined) return;
    try {
      assembler.ingest(draft, sink);
    } catch (error) {
      logger.error('消息回调失败（不掩盖本次运行的结论）', { error });
    }
  };
  /** 子任务行：同一身份多次投递（后者是完整快照），骨架只负责按顺序交出去 */
  const emitSubagent = (record: SubagentRecord): void => {
    const sink = input.onSubagent;
    if (sink === undefined) return;
    try {
      sink(record);
    } catch (error) {
      logger.error('子任务回调失败（不掩盖本次运行的结论）', { error });
    }
  };

  // 进入即已中止：不建任何运行时，直接给 canceled（否则会「起了再杀」，白跑一次冷启动）
  if (input.signal.aborted) {
    emit(logDraft('stderr', '[WARN] 本次运行在启动前已被终止，本次运行未启动任何智能体进程'));
    return {
      ok: false,
      exitReason: 'canceled',
      tokens: null,
      // 一本次运行都没跑 ⇒ 谈不上「子智能体那一份」（用量与轮次同一条「采不到就是 null」）
      subagentTokens: null,
      subagentTurns: null,
      turns: null,
      durationMs: 0,
      // 这一格没建过运行时、也没消费过事件流 ⇒ 没有答复可言，只能是「未采到」（不是空串）
      finalText: null,
      // 一本次运行都没跑 ⇒ schema 一次都没下发（与「要求了但被降级」在结果上同值，见 applied 的 JSDoc）
      applied: { structuredOutput: false },
      // 同理：一本次运行都没跑 ⇒ 没有会话可指（`null` = 不能续接，与「采不到」同一处置）
      sessionId: null,
      error: { code: 'AGENT_CANCELED', message: '本次运行在启动前已被终止' },
    };
  }

  const controller = new AbortController();
  const state: TurnState = {
    seen: new Set(),
    turns: 0,
    usageInput: null,
    usageCached: null,
    usageOutput: null,
    usageReasoningOutput: null,
    usageTotal: null,
    timing: null,
    usageByMessageId: new Map(),
    turnKeys: new Set(),
    finalText: null,
  };
  let handle: TurnStart | undefined;
  let release: Promise<{ disposeError: unknown | null }> | undefined;
  let stopRequested = false;
  /**
   * 外部要求停止的来源：`'signal'`＝用户点「终止」（`input.signal`）；`'shutdown'`＝宿主停机
   * （`disposeLiveSessions()`）。两者都落 `canceled`——都表达「外部要求停止」，也都不进自动重试。
   */
  let stopOrigin: 'signal' | 'shutdown' | null = null;
  /**
   * **消费相**：从「向适配器要运行时」到「进入释放」这一段。两个判据共用这条边界——
   * 看门狗只在这一段计时（释放阶段静止是正常的），宿主停机的「停止」也只在这一段改结论
   *（与 finally 里摘掉 abort 监听器同一条口径：跑完了就不再翻转结论）。
   */
  let consuming = true;
  let failure: AgentFailure | null = null;
  /** 权威计量（进结果、进而进快照）：只有非估算值才写这里 */
  let tokens: AgentRunResult['tokens'] = null;
  let subagentTokens: UsageTokens | null = null;
  /**
   * **子智能体那一份**轮次：与 `subagentTokens` 同一条搬运规则（见两个接口的注释）。
   * 初值 `null` = 还没有任何一家交过这一格；骨架**只搬运、不累加**（合计由各家自己算好）。
   */
  let subagentTurns: number | null = null;
  /**
   * 本次运行**实际**走的是哪条通道：由适配器在收尾投影里上报，骨架只搬运。
   * 初值 `false` = 没走原生 schema 通道——「没上报」与「没走」在消费侧是同一件事。
   */
  let appliedStructuredOutput = false;
  /**
   * 这次运行跑在哪条会话上：由适配器在收尾投影里上报，骨架只搬运。
   * 初值 `null` = 没有可续接的会话（或这一家没上报）——两者在消费侧的处置相同（不能续接）。
   */
  let sessionId: AgentRunResult['sessionId'] = null;
  /** 估算计量（cc 的跑动期估算）：只进事件，绝不进结果 */
  let estimatedTokens: AgentRunResult['tokens'] = null;
  let turns: number | null = null;
  /**
   * 上一次**发出去**的那一对（轮次 / 计量）：同一条消息的重复快照不该刷屏。
   * 去重放在骨架里而不是各家投影里（原来 cc 的 `isSameUsage` 就在做这件事）：
   * 三家的「什么时候值得发一条」必须是同一条规则，否则界面上的数会因家而异。
   */
  let emittedUsage: {
    tokens: AgentRunResult['tokens'];
    /**
     * 上一次发出去的来源（A2）。**必须进去重判据**：估算与权威值恰好相同时，
     * 「这一格从估算变成权威」仍是一次真实变化——消费方（编排层）据此才决定回写快照，
     * 少了它那一条权威事件会被当成重复快照吃掉，快照要等到终态那一次写入才拿得到这个数。
     */
    tokensBasis: 'reported' | 'estimated';
    subagentTokens: AgentRunResult['subagentTokens'];
    subagentTurns: AgentRunResult['subagentTurns'];
    turns: number;
    timing: UsageTiming | null;
    /** 归属也进去重判据：换了会话或换了轮次就是一次真实变化（界面要重画落点） */
    turn: UsageTurn | null;
  } | null = null;

  let settleTurn: () => void = () => {};
  const turnSettled = new Promise<void>((resolve) => {
    settleTurn = resolve;
  });

  // 第二段兜底的可见信号：既要进服务日志，也要进本次运行事件日志（界面上的日志抽屉看得到）
  const onGraceExceeded = (): void => {
    const text = `[WARN] ${hooks.kind} 在 ${RELEASE_GRACE_MS / 1000} 秒内未结束在途 turn，已强制释放运行时（可能是适配器不响应停止信号，也可能是它正卡在一次长采集里——这条日志区分不了这两种成因，别照着它断言能力差异）`;
    logger.warn(text, { kind: hooks.kind });
    emit(logDraft('stderr', text));
  };

  // 释放只会跑一次：release 记忆化，因此「终止与释放同时到达」也只释放一次
  const triggerRelease = (): Promise<{ disposeError: unknown | null }> => {
    release ??= releaseTurn(
      {
        interrupt: () => {
          handle?.interrupt();
        },
        settled: turnSettled,
        dispose: async () => {
          await handle?.dispose();
        },
      },
      onGraceExceeded,
    );
    return release;
  };

  // 停止请求若在 start() 之前到达，只记下来：此时还没有「被关闭的对象」，提前释放会漏关随后建出的
  // 客户端——A7 要防的正是这条路径（守卫必须绑定对象）
  const requestStop = (): void => {
    stopRequested = true;
    if (handle !== undefined) void triggerRelease();
  };
  const onAbort = (): void => {
    // 「运行期间观察到过 abort」比结论时刻再读 `signal.aborted` 更贴近「用户要求停止」的语义：
    // 释放阶段最长可等 5 秒（等 dispose），其间用户点「终止」会把一次**已经正常跑完**的运行
    // 翻转成 canceled。signal 仍只用来判 canceled，不参与其它原因的推断，口径不变。
    //（监听器在 finally 里摘掉，所以「跑完之后再点终止」不在此列。）
    stopOrigin = 'signal';
    requestStop();
  };

  input.signal.addEventListener('abort', onAbort, { once: true });

  /**
   * 看门狗：两级**静止**上限（`AgentRunInput.watchdog`，缺省常亮）。它是「另一个终止发起者」——
   * 到点走 `requestStop()` 那条与用户点「终止」相同的释放路径，结论由 `assembleResult` 落 `timed-out`。
   *
   * 为什么是「单个定时器 + 每次重排」而不是轮询：两级上限都是分钟级，轮询要么粒度粗（发现延迟）
   * 要么空转（每个本次运行一个滴答）；重排只在有事件时发生。判据只有两个时刻：
   * `idleDeadlineMs`（最后一次输出 + 空闲上限）与 `wallDeadlineMs`（本次模型往返起表 + 单轮上限）。
   */
  const limits = {
    idle: input.watchdog?.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
    wall: input.watchdog?.turnWallClockMs ?? DEFAULT_TURN_WALL_CLOCK_MS,
  };
  let idleDeadlineMs = 0;
  let wallDeadlineMs = 0;
  let watchdogTimer: ReturnType<typeof setTimeout> | undefined;
  /** 开火的那一级（null = 没开火）；一旦非空就锁住，不再重复开火 */
  let watchdogTrip: WatchdogTrip | null = null;
  /** 在途工具（`callId`）：只有 `TOOL_IN_FLIGHT_SUSPENDS_WATCHDOG` 里的家才让这一格参与判据 */
  const inFlightTools = new Set<string>();
  /** 正在等用户回答的提问数：由提问端口进入 / 离开等待时登记，可重入（并发两问各记一次） */
  let pendingAsks = 0;
  /** 在等人工消息的窗口数：由注入端口那一侧的包装层登记（至多一次在飞，仍按可重入写） */
  let pendingInjects = 0;
  /** 已观察到的累计轮次：它**递进**才说明一次模型往返收尾、下一次起表（见「墙钟按一次往返计」） */
  let observedTurns = 0;

  const noteActivity = (): void => {
    if (limits.idle > 0) idleDeadlineMs = Date.now() + limits.idle;
  };
  const noteRoundTrip = (): void => {
    if (limits.wall > 0) wallDeadlineMs = Date.now() + limits.wall;
  };
  /** 在途工具期间是否挂起计时（只对登记过的家生效；两级一起挂起，见那张表的注释） */
  const suspendedByTool = (): boolean =>
    TOOL_IN_FLIGHT_SUSPENDS_WATCHDOG[hooks.kind] === true && inFlightTools.size > 0;
  /** 在等用户回答期间是否挂起计时（两级一起挂起，见那张表的注释） */
  const suspendedByAsk = (): boolean =>
    AWAITING_ANSWER_SUSPENDS_WATCHDOG[hooks.kind] === true && pendingAsks > 0;
  /**
   * 在等人工消息期间是否挂起计时（判据口见 `inject.ts` 的 `InjectionWaitSink`）。
   * 取值先看用例覆盖、再看那张穷尽表——覆盖只活在测试期（见 `setInjectionWaitSuspendsForTesting`）。
   */
  const suspendedByInject = (): boolean =>
    (injectionWaitOverrides[hooks.kind] ?? INJECTION_WAIT_SUSPENDS_WATCHDOG[hooks.kind]) === true && pendingInjects > 0;
  /** 两级静止计时是否都挂起（工具在途 / 在等用户回答 / 在等人工消息，各自按家取值） */
  const suspended = (): boolean => suspendedByTool() || suspendedByAsk() || suspendedByInject();

  /**
   * 两个「人在这一侧」的等待面（在等人回答 / 在等人工消息）**共用一份墙钟记账**：
   * 两级静止计时挂起期间厂商一个事件都不会产出，而那一段不是模型的时间——两处各记一份会让
   * 两段重叠时把同一段时间推两次（墙钟被推得比真实等待还长，真挂死更难被发现）。
   * 计数按「谁先进入谁起表、最后一个离开才推表」算：重叠只算一次、先后两段各算各的。
   */
  let waitStartedMs = 0;
  let pendingHumanWaits = 0;
  const enterHumanWait = (): void => {
    if (pendingHumanWaits === 0) waitStartedMs = Date.now();
    pendingHumanWaits += 1;
    armWatchdog();
  };
  const leaveHumanWait = (): void => {
    pendingHumanWaits -= 1;
    if (pendingHumanWaits > 0) return;
    // 墙钟量的是「一次模型往返」：等人那一段不是模型的时间，整体顺延（否则答完即超时）
    const waited = Date.now() - waitStartedMs;
    if (limits.wall > 0 && waited > 0) wallDeadlineMs += waited;
    noteActivity();
    armWatchdog();
  };

  const askUserWait = {
    enter: (): void => {
      pendingAsks += 1;
      enterHumanWait();
    },
    leave: (): void => {
      pendingAsks -= 1;
      leaveHumanWait();
    },
  };

  /**
   * 注入端口的等待登记口（见 `inject.ts` 的 `InjectionWaitSink`）：与提问那一格**逐条同源**
   * ——进入挂起两级计时，离开时推墙钟 + 重起空闲表 + 重排看门狗（三件都不可省）。
   * 唯一不同的是判据源：这一格由端口那一侧的包装层登记（取件空手而归 = 适配器已收工）。
   */
  const injectionWait = {
    enter: (): void => {
      pendingInjects += 1;
      enterHumanWait();
    },
    leave: (): void => {
      pendingInjects -= 1;
      leaveHumanWait();
    },
  };

  /** 提问端口：适配器从 `TurnContext.askUser` 拿它（等待语义只在 `ask-user.ts` 写一遍） */
  const askUser = createAskUserPort(input, { kind: hooks.kind, wait: askUserWait });

  /**
   * 注入端口：调用方传了就**包一层**再透给适配器（包装层只登记「现在在等」这一格，
   * 见 `inject.ts`），没传就是**关闭档**（`available: false`、取件恒空、撤回恒 `unsupported`）。
   * 两条口径都在这一处落地，适配器因此只有一个判据要读（`available`）：
   * 「调用方没传端口」与「调用方传了一个关着的端口」在适配器那一侧**必须同形**，
   * 否则「没开闸门 ⇒ 一格都不挂」这条零回归判据会有两个形状。
   */
  const injectWait = withInjectionWait(input.inject ?? CLOSED_INJECTION_PORT, injectionWait);
  const inject = injectWait.port;

  const clearWatchdog = (): void => {
    if (watchdogTimer === undefined) return;
    clearTimeout(watchdogTimer);
    watchdogTimer = undefined;
  };

  /**
   * 重排下一次判定：取两级里最近的那个；两级都被挂起时不排——挂起期间是靠
   * 「挂起结束的那一刻」再排一次（在途工具靠下一条事件、在等回答靠 `AskUserWaitSink.leave`）。
   */
  const armWatchdog = (): void => {
    clearWatchdog();
    if (!consuming || watchdogTrip !== null) return;
    const deadlines: number[] = [];
    if (!suspended()) {
      if (limits.idle > 0) deadlines.push(idleDeadlineMs);
      if (limits.wall > 0) deadlines.push(wallDeadlineMs);
    }
    if (deadlines.length === 0) return;
    watchdogTimer = setTimeout(onWatchdog, Math.max(Math.min(...deadlines) - Date.now(), 0));
  };

  const onWatchdog = (): void => {
    watchdogTimer = undefined;
    if (!consuming || watchdogTrip !== null) return;
    const now = Date.now();
    if (!suspended()) {
      if (limits.idle > 0 && now >= idleDeadlineMs) {
        tripWatchdog('idle', limits.idle);
        return;
      }
      if (limits.wall > 0 && now >= wallDeadlineMs) {
        tripWatchdog('turn-wall-clock', limits.wall);
        return;
      }
    }
    // 只是被挂起（或有更近的定时器提前到点）：换个时刻再判
    armWatchdog();
  };

  /**
   * 开火：留痕（服务日志 + 本次运行事件流）后走 `requestStop()`，到点放弃等待、结论落 `timed-out`。
   * 留痕是硬要求——「我们把它掐了」必须与「它自己挂了」在日志里分得开。
   */
  const tripWatchdog = (reason: WatchdogTrip, timeoutMs: number): void => {
    watchdogTrip = reason;
    clearWatchdog();
    /**
     * 亚秒预算（探针/测试）下 `Math.round` 会把秒数说成 0——那不是「没等」，
     * 文案里带上毫秒原文，读的人不必去猜预算。
     */
    const seconds = Math.round(timeoutMs / 1_000);
    const budget = seconds >= 1 ? `${seconds} 秒` : `${timeoutMs} 毫秒`;
    /**
     * **卡在哪一段要说得出来**：`handle === undefined` 表示本次运行还停在 `hooks.start()` 里
     * （装配 / 建会话 / 投首轮提示词），此刻**没有句柄可释放** ⇒ 释放路径会走到「没有句柄」那一支，
     * 行也不会因为这次看门狗就落定（能力边界，见「进程生命周期」的已知边界表）。
     * 文案不点名这一段的话，用户只看到一句「静止 N 秒」，分不出是模型没响应还是装配没回来。
     */
    const phase = handle === undefined
      ? '（卡在装配段：`start()` 还没返回，本层没有句柄可释放——本次运行不会因这次看门狗而落定）'
      : '（适配器已启动，按释放路径收场）';
    const text = reason === 'idle'
      ? `[WARN] 看门狗：本次运行已静止 ${budget}（没有任何事件），按静止超时终止并释放运行时${phase}`
      : `[WARN] 看门狗：单次模型调用超过 ${budget} 仍未收尾，按静止超时终止并释放运行时${phase}`;
    logger.warn('看门狗判定本次运行静止超时', { kind: hooks.kind, reason, timeoutMs, started: handle !== undefined });
    emit(logDraft('stderr', text));
    requestStop();
  };

  /**
   * 该次运行的释放完成（宿主停机据此等它；`finally` 末尾 resolve）。
   * 登记的是**本次运行**而不是某个适配器对象：句柄要到 `consume()` 才拿到，而停机可能发生在
   * 装配的等待里——`stop` 走 `requestStop()` 那条既定路径（句柄到了会补一次释放，见那两处注释）。
   */
  let settleReleased: () => void = () => {};
  const released = new Promise<void>((resolve) => {
    settleReleased = resolve;
  });
  const liveSession: LiveSession = {
    kind: hooks.kind,
    stop: () => {
      // 消费相之外是空操作：跑完了的结论不再翻转（与 finally 里摘掉 abort 监听器同一条口径）
      if (!consuming) return;
      stopOrigin ??= 'shutdown';
      requestStop();
    },
    released,
  };

  /**
   * `hooks.start` 的产物**提到 `try` 外面**：收尾投影在 `finally` 里跑（失败 / 终止也要收尾，
   * 见那一处的注释），而 `finally` 里看不见 `try` 块内的 `const`。类型由 `hooks.start` 推出来。
   */
  let started: Awaited<ReturnType<TurnHooks['start']>> | undefined;

  /**
   * 结构化输出的**编排**（骨架侧的全部内容）：schema 一律交给 `start`（不再替厂商摘键），
   * 编译一次判据（`planStructuredOutput`），首轮答复不合格时按需追问。
   * 「要不要 schema」只看调用方给没给——本层不读任何能力位。
   */
  const plan = input.outputSchema === undefined || input.outputSchema === null
    ? null
    : planStructuredOutput(input.outputSchema);
  if (plan !== null && plan.kind === 'parse-only') {
    // 编译不出来必须留痕：否则「我们其实没校验形状」这件事就静默了
    logger.warn('这份 JSON Schema 不在可编译的子集里，本次只判「答复是不是合法 JSON」', {
      kind: hooks.kind,
      reason: plan.reason,
    });
  } else if (plan !== null && plan.ignoredKeywords.length > 0) {
    logger.debug('JSON Schema 里有不认识的 keyword（已 fail-open 放行，不作为不合格的理由）', {
      kind: hooks.kind,
      keywords: plan.ignoredKeywords,
    });
  }

  /**
   * 消费**一条活动区间**（首轮与每一修正轮共用同一段）：投影 → 发事件 → 累计计量 → 收失败。
   *
   * 为什么抽成函数：修正轮是「同一会话里的又一条活动区间」，它与首轮必须**逐字同形**
   * （同一套去重、同一套发射门槛、同一套失败取舍）。抄一遍的代价不是代码量，而是
   * 「修正轮里采到的用量不算数」这类只在真机上偶发的问题。
   */
  async function consume(interval: TurnStart): Promise<void> {
    handle = interval;
    // 停止请求若在区间之间到达：这一刻才拿到「被关闭的对象」，补一次释放
    if (stopRequested) requestStop();
    // 一条活动区间就是一次模型往返：墙钟从这一刻起表（修正轮也算一次新的往返）
    noteRoundTrip();
    noteActivity();
    armWatchdog();
    for await (const raw of interval.stream) {
      const projection = interval.project(raw, state);
      /**
       * 看门狗的三格记账（判据见 `AgentRunInput.watchdog` 与那两张表的注释）：
       *   · 有输出 ⇒ 重置空闲计时（这是唯一能区分「模型想得久」与「对端挂了」的信号）；
       *   · 工具块 ⇒ 在途集合按 `callId` 配平（只有能合法静默的家让这一格参与判据）；
       *   · 轮次递进 ⇒ 一次往返收尾、重新起表（墙钟按一次模型往返计，不按厂商 turn）。
       */
      if (projectionHasOutput(projection)) noteActivity();
      trackToolBlocks(projection, inFlightTools);
      if (projection.turns !== null && projection.turns > observedTurns) {
        observedTurns = projection.turns;
        noteRoundTrip();
      }
      /**
       * **厂商起了一轮 ⇒ 重新起表**（见 `TurnProjection.roundTripStarted`）：跨轮的运行里，
       * 上一轮耗掉的墙钟不该算进新起的那一轮。
       */
      if (projection.roundTripStarted === true) noteRoundTrip();
      armWatchdog();
      for (const draft of projection.drafts) emit(draft);
      for (const message of projection.messages ?? []) emitMessage(message);
      for (const record of projection.subagents ?? []) emitSubagent(record);
      if (projection.turns !== null) turns = projection.turns;
      /**
       * 子智能体那一份：**照原样搬运，骨架不做加法**——合计由各家自己算好，
       * 骨架加一次就成了双计。缺省（undefined）= 本条不带这一格（保持原值）；
       * **显式 `null` = 明确没采到 ⇒ 覆盖成 null**（见 `TurnFinalize.subagentTokens` 的注释）。
       */
      if (projection.subagentTokens !== undefined) subagentTokens = projection.subagentTokens;
      /**
       * 子智能体那一份**轮次**：与上一格逐字同一条规则（缺省保持 / 显式 `null` 覆盖）。
       * 两格分开判而不是合成一个对象：它们的生产者可能不同（dsh 两格都在投影里，codex 的轮次
       * 只在收尾那一条路上），合成一处会让「只带了其中一格」变成「另一格被顺手清掉」。
       */
      if (projection.subagentTurns !== undefined) subagentTurns = projection.subagentTurns;
      /**
       * 时间跨度：折进 `state.timing`（dsh 自己已经在 `state` 上写了，这里合并的是它交出来的那份
       * 与别家随投影交出来的那份——两处用**同一个** `mergeTiming`，形状与规则只有一份）。
       */
      if (projection.timing !== undefined) state.timing = mergeTiming(state.timing, projection.timing);
      if (projection.tokens !== null) {
        if (projection.tokensEstimated === true) {
          estimatedTokens = projection.tokens;
        } else {
          tokens = projection.tokens;
          /**
           * 权威值一到，估算**作废**。两者都是「到目前为止的累计」
           * （cc 的估算按 `message.id` 归并求和，权威值只在收尾的 `result` 上），
           * 而估算的来源被 SDK 明写为 not final ⇒ 留着它，收尾那条 `usage` 事件就还会显示一个
           * 偏小的假数，正是本仓最忌讳的那种「看起来采到了」。
           */
          estimatedTokens = null;
        }
      }
      /**
       * 发射门槛是**轮次**，不是「tokens 与轮次同时在」（用户口径）。
       *
       * 改之前：只有本条投影**同时**给出 tokens 与 turns 才发 `usage`。后果实测过——cc
       * 的 assistant 消息常常不带完整用量，于是那一轮 60 次模型往返、整轮只发得出一条
       * `usage`（`turns: 1, tokens: {0,0,0}`），界面永远停在「轮次 1」。
       *
       * 现在：轮次一到就发，`tokens` 带上**到目前为止**的值（还没拿到权威值时才用跑动期估算，
       * 权威值一到估算立即作废；一次都没采到就是 null）。
       * 为什么带累计值而不是原样透传本条的 tokens：事件与界面都是**覆盖**语义
       *（`row-live.ts` 的 `stepLiveState` 直接覆盖），只带 turns 的那一条若把 tokens 写成 null，
       * 界面上的 tok 会从有数掉回「采集中」——数字往回流比不显示更糟。
       * 反过来「本条只有 tokens、还没有轮次」**不发**：那正是老口径要防的那一格（`turns` 必填），
       * 而结果值照旧更新（`tokens` 已经记下）⇒ 采到的计量不会因为不发事件而丢。
       * 最后一层是去重：与上次发出去的那一对**逐字段相同**就不发（同一内容块重复到达、
       * 同一个 message.id 的重复快照都不该刷日志）。
       *
       * `timing`（2026-10-XX）：与 `tokens` 同一条处置——带**到目前为止**的那一份，
       * 采不到就是 `null`（契约里这一格可空）。它**也在去重判据里**：dsh 的 `turn/end` 会把同一笔
       * 计量再交一次，而时间右端点这时往前推了（同一个 step 里工具也跑过）⇒ 那条事件必须发出去，
       * 否则界面上的时长永远停在第一个 step 的读数上。反过来「计量与时长逐字段都没变」才不发。
       */
      const liveTokens = estimatedTokens ?? tokens;
      /**
       * 这一条事件的来源（A2）：估算还是厂商上报的权威值。消费方（编排层的跑动期回写段）据此决定
       * 要不要写快照，于是它不再需要在跑之前反查注册表的 `capability.liveUsage`。
       * 判据与 `liveTokens` **同源且同源是硬要求**——那一条就是 `estimatedTokens ?? tokens`，
       * 故估算还在时它必是估算值（权威值一到，上面的 `estimatedTokens = null` 已经把估算作废）。
       * 与 `liveTokens` 一样先算一次再用：`emittedUsage` 必须记下**发出去的那一个值**，
       * 两处各写一遍表达式，将来改一处就会让去重判据与事件内容悄悄不一致。
       */
      const liveTokensBasis = estimatedTokens !== null ? 'estimated' : 'reported';
      const liveTiming = resolveTiming(state.timing);
      /**
       * 归属：**本条投影自带**，缺省即 `null`——不结转、也不拿 `projection.turns` 顶替
       * （那是本次运行累计轮次，与「这一条属于哪一轮」是两把尺子）。
       */
      const liveTurn = projection.turn ?? null;
      if (
        projection.turns !== null
        && !sameUsage(
          emittedUsage,
          liveTokens,
          liveTokensBasis,
          subagentTokens,
          subagentTurns,
          liveTiming,
          projection.turns,
          liveTurn,
        )
      ) {
        // `timing` 恒带这一格（没有时间时是 `null`）：契约里它是 `.nullable()`，而「带一个 null」
        // 与「整个键不存在」在读侧是同一件事——都走 `.nullable()` 那一支，故不必分两种形状。
        emit({
          type: 'usage',
          tokens: liveTokens,
          tokensBasis: liveTokensBasis,
          subagentTokens,
          subagentTurns,
          timing: liveTiming,
          turn: liveTurn,
          turns: projection.turns,
        });
        emittedUsage = {
          tokens: liveTokens,
          tokensBasis: liveTokensBasis,
          subagentTokens,
          subagentTurns,
          turns: projection.turns,
          timing: liveTiming,
          turn: liveTurn,
        };
      }
      if (projection.failure !== null) failure = projection.failure;
    }
  }

  /**
   * 结构化输出的修正轮：首轮答复「拿到了但不合格」时在同一会话里追问，最多
   * `STRUCTURED_OUTPUT_REPAIR_ROUNDS` 轮。**只修形状**——提示词里明写不许重跑任务、不许改判定。
   *
   * 四条不做修正的边界（该说的都留痕，不静默）：
   *   · 没要求 schema（`plan === null`）；
   *   · 首轮就以失败收场（`failure !== null`）——那是「没问到」，不是「答错了」；
   *   · 已经被要求停止（`stopRequested`）：不再产生任何模型往返；
   *   · 没采到最终答复（`finalText === null`）：没有可回灌的原文，追问等于凭空重问一遍。
   *
   * 耗尽后**不改写结论**：`ok` / `exitReason` / `finalText` 保持最后一轮的样子，由调用方按
   * 「答复解析不了」的既有面处置（评分通路的 `JUDGE_PARSE_FAILED`）。
   */
  async function repairStructuredOutput(): Promise<void> {
    if (plan === null || failure !== null || stopRequested) return;
    let text = state.finalText;
    if (text === null) {
      logger.warn('要求了结构化输出，但这一次没有采到可读的最终答复 ⇒ 不做修正', { kind: hooks.kind });
      return;
    }
    let inspected = inspectStructuredOutput(plan, text);
    if (inspected.ok) return;
    for (let round = 1; round <= STRUCTURED_OUTPUT_REPAIR_ROUNDS; round += 1) {
      const askAgain = handle?.continue;
      if (askAgain === undefined) {
        // 没有同会话追问通道的家：如实收场。这条 WARN 是「为什么没修」的唯一答案，不能省
        const problem = firstProblem(inspected);
        emit(logDraft('stderr', `[WARN] 答复不符合本次要求的 JSON Schema，且该适配器不支持同会话修正：${problem}`));
        logger.warn('答复不符合 JSON Schema，该适配器不支持同会话修正', { kind: hooks.kind, problem });
        return;
      }
      if (stopRequested) return;
      emit(
        logDraft(
          'stderr',
          `[WARN] 结构化输出未通过校验，要求模型修正（第 ${round}/${STRUCTURED_OUTPUT_REPAIR_ROUNDS} 步）：${firstProblem(inspected)}`,
        ),
      );
      const prompt = buildStructuredOutputFeedback({
        outputSchema: input.outputSchema,
        raw: text,
        problems: inspected.problems,
      });
      await consume(await askAgain(prompt));
      // 追问本身把这一轮跑失败了：结论按失败收场（修正不掩盖失败）
      if (failure !== null || stopRequested) return;
      text = state.finalText ?? text;
      inspected = inspectStructuredOutput(plan, text);
      if (inspected.ok) {
        emit(logDraft('stderr', `[INFO] 结构化输出在第 ${round} 步修正后通过了校验`));
        return;
      }
    }
    const problem = firstProblem(inspected);
    emit(
      logDraft(
        'stderr',
        `[WARN] 结构化输出修正 ${STRUCTURED_OUTPUT_REPAIR_ROUNDS} 步后仍未通过校验：${problem}`,
      ),
    );
    logger.warn('结构化输出修正用尽仍不合格（结论不改写：由调用方按答复不可解析处置）', {
      kind: hooks.kind,
      rounds: STRUCTURED_OUTPUT_REPAIR_ROUNDS,
      problems: inspected.problems,
    });
  }

  try {
    liveSessions.add(liveSession);
    // 从「向适配器要运行时」起表：装配与握手本身也可能挂住（首次注入的等待预算是 20 s 量级）
    noteRoundTrip();
    noteActivity();
    armWatchdog();
    started = await hooks.start({ input, controller, emitter, askUser, inject, emitMessage });
    logger.debug('适配器已启动，开始消费事件流', {
      kind: hooks.kind,
      cwd: input.cwd,
      model: input.route.modelId,
    });
    await consume(started);
    await repairStructuredOutput();
  } catch (cause) {
    if (stopRequested) {
      // 停止请求引发的流中断不是失败：结论由 canceled 通路给出（判定优先级）
      logger.debug('事件流因停止请求结束', { kind: hooks.kind, error: cause });
    } else {
      const classified = classifyAgentFailure(cause, { kind: hooks.kind, baseUrl: input.route.baseUrl });
      /**
       * 退出错误与「流内错误」的取舍。
       *
       * 两个来源：流内错误由 `project` 从事件流里收（`{"type":"error",…}` / `turn.failed`）；
       * 退出错误是适配器**自己 spawn 的进程**终止时抛出的 cause——codex 这一侧的形态由 app-server
       * 客户端给出（`codex app-server 进程已退出（code=N） stderr: …`，见 `appserver/client.ts`），
       * **没有 SDK 的前缀包装**，附在后面的 stderr 是**尾巴**（只留尾部若干字符），不是全文。
       *
       * 处置：只有退出错误**更具体**时才让它覆盖流内原因（三条判据见 `exitErrorAddsDetail`，
       * 取其一；③ 是机械判据，不看流内错误缺不缺）。否则保留流内错误——它才是「为什么断了」的
       * 直接陈述——并把「CLI 以退出码 N 收场」写成**补充**：那确实是本次运行的真实结束方式，
       * 不该抹掉，但绝不让它**顶替**原因。退出错误的原文一个字符都不删（它在 cause 里，
       * 另有出口把它落进本次运行事件流）。
       */
      // 读进局部变量再判：`failure` 会被下面的闭包（`consume` / 修正轮）赋值，
      // 而 tsc 的控制流分析看不见闭包里的写入 ⇒ 这里必须显式断言回声明类型，
      // 否则它把此刻的值窄化成 `null`、再取属性就是 `never`
      const failureSoFar = failure as AgentFailure | null;
      if (failureSoFar !== null && !exitErrorAddsDetail(classified, cause)) {
        failure = {
          code: failureSoFar.code,
          message: `${failureSoFar.message}（随后 codex CLI 以退出码 ${exitCodeOf(cause) ?? '未知'} 收场）`,
          ...(failureSoFar.stack === undefined ? {} : { stack: failureSoFar.stack }),
        };
        logger.error('适配器运行的失败（保留事件流里的原因，退出错误只是 CLI 收场）', {
          kind: hooks.kind,
          code: failureSoFar.code,
          exitMessage: classified.message,
        });
      } else {
        failure = classified;
        logger.error('适配器运行的失败', { kind: hooks.kind, code: failure.code, error: cause });
      }
      /**
       * **CLI 的 stderr 也必须落进本次运行事件流**。
       *
       * 为什么不能只留在 `cause` 里：`cause` 只进服务端日志，而使用者看的是「执行日志」抽屉
       * （`[codex]` 那几行在它的「原始输出」里）。「是网关 5xx 抖动，还是 Responses 契约不被满足」
       * 这个区分只有 stderr 能回答；抽屉里缺了它，那一本次运行失败就只剩上游的 `Reconnecting…`。
       * stderr 是**证据**，不是结论：按 log 事件落盘、不冒充 `error` 事件的文案，内容原样保留
       * （只经 `stripCliBoilerplate` 剔除已知样板，而当前样板集合为空）。
       */
      /**
       * ⚠️ **前缀不许断言来源**：这条 `cause` 在三条路上都走到这里——厂商 CLI 的退出 / stderr、
       * `AgentLoadError`（我们加载厂商包失败）、以及适配器自己抛的任何错。真机读数（三条臂逐字）：
       * 运行配置目录不可写时那条裸 `EACCES: permission denied, open '<configHome>/.npmrc'`、
       * 厂商包导出面不匹配、技能物化失败——**三条都不是 CLI 的错**，却都被旧文案标成
       * 「CLI 退出详情（stderr）」，读的人会去查 CLI。故这里只说「哪一侧的哪一种可能」，
       * 由 `message` 自己说话。
       */
      const cliDetail = stripCliBoilerplate(cause instanceof Error ? cause.message : String(cause));
      if (cliDetail !== '') {
        emit(logDraft('stderr', `[${hooks.kind}] 失败详情（CLI 退出 / 适配器自身错误都在这一档）：${cliDetail}`));
      }
    }
  } finally {
    // 消费相到此为止：看门狗停表（释放阶段的静止是正常的），停机也不再翻转结论
    consuming = false;
    clearWatchdog();
    // 「在等人工消息」那一格**必须随这一轮一起闭合**：它的窗口只在适配器跑动期间有意义，
    // 留着会让下一轮（或释放阶段）的判据带着上一轮的挂起状态（`clearWatchdog` 已停表，
    // 这里清的是计数与墙钟记账，见 `leaveHumanWait`）
    injectWait.close();
    input.signal.removeEventListener('abort', onAbort);
    /**
     * 收尾投影（可选，见 `TurnStart.finalize`）——**无论正常跑完、失败还是被终止都做**，
     * 并且**在释放之前**（它可能需要本次运行还活着的资源：临时目录、文件句柄）。
     *
     * 为什么放在 `finally` 而不是正常路径的末尾：codex 的消息**只**从收尾这条
     * 通道出（事件流缺工具真名、结构化入参与 `call_id` 配对键），而它读的
     * `$CODEX_HOME/sessions/rollout-*.jsonl` **是 CLI 边跑边追加的**——跑失败 / 被终止的会话文件里
     * 同样有内容（一条被中断的 codex 行可能留下 688 KB 会话文件，推理、正文、工具调用俱全）。
     * 原来只在 `failure === null` 时收尾，代价是「失败的那一行抽屉里永远空着」——
     * 而那正是排障时最需要看的一行。
     *
     * 三条边界：
     *   · **只读盘、不编造**：收尾投影读不到会话文件就一条都不产出（`projectCodexMessages` 的既有口径），
     *     所以这一步不会在失败的运行上凭空造出「看起来跑过」的内容；
     *   · **不改结论**：抛错只记日志（失败仍是失败、成功仍是成功），与 `dispose` 同一条处置；
     *   · **终止（用户点停止）之后落盘与否由上层决定**：`publish*` 的闸门在编排层，
     *     这一层只负责把内容交出去（`runTurn` 不知道「行已终态」这件事）。
     */
    if (started !== undefined && started.finalize !== undefined) {
      try {
        const finalized = started.finalize();
        for (const draft of finalized.drafts) emit(draft);
        for (const message of finalized.messages ?? []) emitMessage(message);
        for (const record of finalized.subagents ?? []) emitSubagent(record);
        // 收尾交回的计量折进结果（见 `TurnFinalize` 的注释）：`tokens`/`turns` 的 null 与缺省都表示
        // 「本条不带」；`subagentTokens` / `subagentTurns` 的显式 null 表示「明确没采到」⇒ 覆盖成 null
        // （见 `TurnFinalize.subagentTokens` / `TurnFinalize.subagentTurns`）
        if (finalized.tokens != null) tokens = finalized.tokens;
        if (finalized.subagentTokens !== undefined) subagentTokens = finalized.subagentTokens;
        if (finalized.subagentTurns !== undefined) subagentTurns = finalized.subagentTurns;
        if (finalized.turns != null) turns = finalized.turns;
        // 通道事实（谁走哪条只有适配器知道）：与上面几格不同，`false` 与「没上报」同义，
        // 故只在上报为 `true` 时覆盖——缺省保持 false
        if (finalized.applied?.structuredOutput === true) appliedStructuredOutput = true;
        // 会话 id（与 `tokens` 同一条「带值覆盖、缺省保留」）：读不到会话的家/次一律不报，
        // 报了就覆盖——它回答的是「这一整次运行跑在哪条会话上」，不存在「本条不谈它」的中间态
        if (finalized.sessionId != null) sessionId = finalized.sessionId;
      } catch (error) {
        logger.error('收尾投影失败（已忽略，不影响本次运行的结论）', { kind: hooks.kind, error });
      }
    }
    /**
     * **未收尾的槽在这里收口**（见 `MessageAssembler.sealOpen`）：厂商的块结束快照**不保证**
     * 覆盖每一个槽——cc 真机实测有轮次只投递 `tool_use` 的完整消息，正文只以流式增量到达
     * ⇒ 那个正文槽永远等不到自己的快照，载体停在 `assembly: 'open'`，界面据此显示「正在思考」，
     * 而整行早已结束。会话收尾时按**当前累积值**封口，让「这一段说完了」成为事实。
     *
     * 位置在 `finalize` **之后**：codex 的最后一批消息正是从那一步交出来的，它们同样要进装配器。
     * 失败只记日志：收口是内容视图的收尾，不改写本次运行的结论（与上面两条同一条处置）。
     */
    if (input.onMessage !== undefined) {
      try {
        const sealedCarriers = assembler.sealOpen(input.onMessage);
        if (sealedCarriers > 0) {
          logger.debug('收口未等到块结束快照的载体', { kind: hooks.kind, sealedCarriers });
        }
      } catch (error) {
        logger.error('收口未完成的消息载体失败（不影响本次运行的结论）', { error });
      }
    }
    // 「终结在途 turn」：释放序列的第二段落在这里（适配器自己的 finally 清理完成）
    settleTurn();
    const report = await triggerRelease();
    if (report.disposeError !== null) {
      logger.error('释放运行时失败（已忽略，避免掩盖本次运行的结论）', { error: report.disposeError });
    }
    // 注销与「释放完成」同时发生：宿主停机等到这里才返回（登记见上面的 liveSession）
    liveSessions.delete(liveSession);
    settleReleased();
  }

  const result = assembleResult({
    startedAt,
    stop: stopOrigin,
    timedOut: watchdogTrip === null ? null : { reason: watchdogTrip, timeoutMs: watchdogTrip === 'idle' ? limits.idle : limits.wall },
    failure,
    tokens,
    subagentTokens,
    subagentTurns,
    turns,
    finalText: state.finalText,
    applied: { structuredOutput: appliedStructuredOutput },
    sessionId,
    emit,
  });
  logger.info('适配器运行结束', {
    kind: hooks.kind,
    exitReason: result.exitReason,
    durationMs: result.durationMs,
    turns: result.turns,
    metered: result.tokens !== null,
  });
  return result;
}

/**
 * 把这一条投影带的时间跨度折进累计值（见 `TurnProjection.timing` 的三条语义）。
 *
 * 规则只有三条，但每一条都有靶子：
 *   ① **`firstMs` 只认第一条**：一条消息说「起点在 T」之后，后来者再说起点一律忽略。
 *      取最小值是**错的**（本函数刻意不做）：`events` 来源下首末两点来自有序的事件流，
 *      取最小值只会把时钟回拨那种脏数据算进来，得出一个比真实值更长的跨度；
 *   ② **`lastMs` 每次都覆盖**（只要这一条给了）：它才是「跑到现在」的右端点，必须往后走；
 *   ③ **`apiMs` / `ttftMs` 相加**：它们是各家**每一条**投影自报的**增量**（claude 的两格来自厂商
 *      每轮的 `duration_api_ms` / `ttft_ms`），而 `tokens` 那一格是**累计**的 ⇒ 不相加就会出现
 *      「同一条 `usage` 事件里 tokens 是全行、api 只是最后一轮」，消费方按
 *      `output / (apiMs − ttftMs)` 算出的速率被放大到「轮数倍」（真机多轮读数：tokens 3000/80
 *      而 apiMs 只有最后一轮的 55）。
 *      两条边界：某一条不带这两格（`undefined` / `null`）就**不加**它（不是加 0）；
 *      一条都没带过时整格保持 `null`（`null` 与 `undefined` 都当「没带」，只有数字才算数）；
 *   ④ **来源不一致 ⇒ 整格作废**（`null`）：`'vendor'` 的纯模型时间与 `'events'` 的墙钟**不可相减**
 *      （减出来是一个既不是模型时间、也不是墙钟的第三样东西）。它今天不可达（一家只有一种来源，
 *      落点见三家各次的 `timing` 构造），留着是因为将来若某家同时给出两者，静默相减会得出一个
 *      「看起来正常」的错数——那正是本仓最不接受的一类失败。
 */
export function mergeTiming(
  previous: TimingSpan | null,
  next: TimingSpan,
): TimingSpan | null {
  if (previous === null) return next;
  if (previous.source !== next.source) return null;
  return {
    firstMs: previous.firstMs ?? next.firstMs,
    lastMs: next.lastMs ?? previous.lastMs,
    ...sumSpanField('apiMs', previous.apiMs, next.apiMs),
    ...sumSpanField('ttftMs', previous.ttftMs, next.ttftMs),
    source: next.source,
  };
}

/**
 * 一格时长增量的合并：**两边都有数字就相加**，只有一边有就取那一边，都没有就是 `null`。
 *
 * 为什么把 `null` 与 `undefined` 归成同一档（「没带」）：这一层拿不到「厂商说了它是 null」
 * 与「厂商没说」的区别（草稿层刻意不区分，见 `TimingSpan.apiMs` 的注释），
 * 而两种情形在这一格上的处置本来就相同——都表示这一条没有可加的增量。
 */
function sumSpanField(
  key: 'apiMs' | 'ttftMs',
  previous: number | null | undefined,
  next: number | null | undefined,
): { apiMs?: number | null; ttftMs?: number | null } {
  const hasPrevious = typeof previous === 'number';
  const hasNext = typeof next === 'number';
  if (hasPrevious && hasNext) return { [key]: previous + next };
  if (hasNext) return { [key]: next };
  if (hasPrevious) return { [key]: previous };
  return { [key]: null };
}

/**
 * 累计的跨度 → `usage` 事件里那一格（`totalMs` / `apiMs` / `ttftMs` / `source`）。
 *
 * `totalMs` 由首末两点现减；`apiMs` / `ttftMs` **只按原样透出**（缺就是 `null`）。
 * ⚠️ **三家只有一家有 `apiMs` / `ttftMs`**（claude 的 `duration_api_ms` / `ttft_ms`），另两家
 * 采不到 ⇒ 只能是 `null`。这里刻意不接受「拿 `totalMs` 冒充 `apiMs`」的选项：那会算出一个
 * 把工具执行时间也算进去的「模型速度」（真机上两者能差好几倍），而界面/对比表看不出来。
 *
 * 返回 `null` 的两种情形（两种都**不带** `timing` 这一格）：
 *   · 一次都没采到时间（`timing === null`）；
 *   · 采到了但**差值算不出来**（起点或终点缺一个）——算不出来就是算不出来，**不拿 0 冒充**
 *     （`totalMs: 0` 会被读成「瞬间跑完」）。此时 `apiMs` / `ttftMs` 也一起丢了：契约里三格
 *     共用一个 `timing` 对象，而「有首字延迟却没有总时长」这种半边数据会让消费方的公式
 *     （`output / (apiMs − ttftMs)`）失去分母——宁可整格说「未采集」。
 * 差值为负（时钟回拨 / 跨机器时间戳）时**照原样交出去**，不 clamp 成 0：它是脏数据的证据，
 * 抹平成 0 等于把「这一格不可信」伪装成「这一格是 0」。
 */
export function resolveTiming(timing: TimingSpan | null): UsageTiming | null {
  if (timing === null) return null;
  const { firstMs, lastMs, apiMs, ttftMs } = timing;
  const totalMs = firstMs === null || lastMs === null ? null : lastMs - firstMs;
  if (totalMs === null) return null;
  return { totalMs, apiMs: apiMs ?? null, ttftMs: ttftMs ?? null, source: timing.source };
}

/**
 * 这一次观察到的「轮次 + 计量 + 时长 + 归属 + **两格子智能体分量** + 来源」是否与上次发出去的**逐字段相同**
 * （相同就不再发事件）。
 * `null` 只与 `null` 相同：从「没采到」变成「采到了 0」是一次真实变化，必须发出去
 * （界面要能从「采集中」变成 0）。
 * `timing` 进判据而**不是被忽略**：dsh 的 `turn/end` 会把同一笔计量再交一次，而那时右端点
 * 已经往后推了（同一个 step 里工具也跑过）⇒ 不比较它就会把「这一轮到底花了多久」永远冻结在
 * 第一个 step 上。三格逐字段比（含 `source`：来源换了就是另一个口径的数，不能当成没变）。
 * `tokensBasis`（A2）同理进判据：数值恰好相同的两条里，「估算 → 权威」那次变化正是消费方
 * （编排层的回写段）**唯一**能拿到权威值的时机（见 `emittedUsage.tokensBasis` 的注释）。
 */
function sameUsage(
  previous: {
    tokens: AgentRunResult['tokens'];
    tokensBasis: 'reported' | 'estimated';
    subagentTokens: AgentRunResult['subagentTokens'];
    subagentTurns: AgentRunResult['subagentTurns'];
    turns: number;
    timing: UsageTiming | null;
    turn: UsageTurn | null;
  } | null,
  tokens: AgentRunResult['tokens'],
  tokensBasis: 'reported' | 'estimated',
  subagentTokens: AgentRunResult['subagentTokens'],
  subagentTurns: AgentRunResult['subagentTurns'],
  timing: UsageTiming | null,
  turns: number,
  turn: UsageTurn | null,
): boolean {
  if (previous === null) return false;
  if (previous.turns !== turns) return false;
  if (!sameTiming(previous.timing, timing)) return false;
  // 归属也在判据里：换了会话/轮次 ⇒ 界面上的落点要跟着动，静默不发就是「停在旧轮次」
  if (!sameTurn(previous.turn, turn)) return false;
  // 子智能体那一份也在判据里：它变了界面就要重画 Tooltip（否则那两行永远停在第一次的读数上）
  if (!sameTrio(previous.subagentTokens, subagentTokens)) return false;
  // 轮次那一格同理：`null` 只与 `null` 相同（「没采到」→「采到 0」是一次真实变化，必须发出去）
  if (previous.subagentTurns !== subagentTurns) return false;
  // 来源（A2）：数值相同也要发——见上面 `tokensBasis` 那一段
  if (previous.tokensBasis !== tokensBasis) return false;
  return sameTrio(previous.tokens, tokens);
}

/** 归属逐字段相同；`null` 只与 `null` 相同（从「没有归属」变成「有归属」是一次真实变化） */
function sameTurn(left: UsageTurn | null, right: UsageTurn | null): boolean {
  if (left === null || right === null) return left === right;
  return left.subagentId === right.subagentId && left.round === right.round;
}

/**
 * 三元组逐字段相同；`null` 只与 `null` 相同（「没采到」→「采到 0」是一次真实变化）。
 *
 * ⚠️ **它比不了 `reasoningOutput`**：入参类型是 `AgentRunResult['tokens']`（只有 `input` / `cached`
 * / `output` 三格）⇒ 结构上取不到那一格。去重比较本该纳入这一格，**当前未落地**：
 * 要落地得把判据改成比较事件里的 `UsageTokens`（五格），而不是在这里加字段。
 */
function sameTrio(
  left: AgentRunResult['tokens'],
  right: AgentRunResult['tokens'],
): boolean {
  if (left === null || right === null) return left === right;
  return left.input === right.input && left.cached === right.cached && left.output === right.output;
}

/** 两格 `timing` 是否逐字段相同（都为空、或四格全等） */
function sameTiming(left: UsageTiming | null, right: UsageTiming | null): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.totalMs === right.totalMs
    && left.apiMs === right.apiMs
    && left.ttftMs === right.ttftMs
    && left.source === right.source
  );
}

/**
 * 退出错误正文里**需要被忽略的已知样板**：剥掉它们之后还剩什么，决定 `exitErrorAddsDetail` 的判据③。
 *
 * **集合当前为空**——exec 通道那两条（SDK 拼在退出错误 message 里的运行内前缀、CLI 每次运行都打的
 * 那句 stdin 提示）随通道一起删除：`codex app-server` 不打那条提示，退出错误也不再被 SDK 包装。
 * 保留这张空的样板表与剥样板的函数，而不是把两者一并删掉：剥样板只有这一个落点，将来某个通道
 * 的固定噪声回到这里加一行即可，判据不必重新设计。
 */
const CLI_STDERR_BOILERPLATE: readonly RegExp[] = [];

/**
 * 退出错误是否**比流内错误更值得展示**。
 *
 * 三条判据（按「信息量」从高到低），取其一即覆盖：
 *   ① 退出错误**自己归到了确定性错误码**（`AUTH_FAILED` / `RATE_LIMITED`）⇒ 它更具体，覆盖。
 *   ② 退出错误带 **4xx** 状态 ⇒ 同上，覆盖（4xx 指向凭据/请求，是确定性归因）；
 *   **5xx 刻意不在此列**：网关 5xx 抖动时，流内那句「上游正在过载」是**关于这次失败的信息**，
 *      而「unexpected status 500」只说了一个瞬时面——两者归因码都是 `AGENT_FAILED`（可重试），
 *      那就该留下信息更多的那条，而不是让退出错误把原因换掉。
 *   ③ 退出错误的正文剥掉已知样板后**还有实质内容**（不是只有一句状态行）⇒ 那是 CLI/上游给的正文，覆盖。
 * 三条都不成立（正文为空、或只剩一句状态行）⇒ 保留流内原因，并把退出码写成补充。
 *
 * 判据③是**机械判据**：它只问「剥完样板还剩不剩正文」，不看流内错误缺不缺、也不分厂商
 * （改成「只在流内错误缺失时才生效」会让 cc / dsh 的失败归因静默改变）。
 */
function exitErrorAddsDetail(classified: AgentFailure, cause: unknown): boolean {
  if (classified.code === 'AUTH_FAILED' || classified.code === 'RATE_LIMITED') return true;
  const raw = cause instanceof Error ? cause.message : String(cause);
  const status = httpStatusIn(`${classified.message}\n${raw}`);
  if (status !== null && status < 500) return true;
  return stripCliBoilerplate(raw) !== '' && !isStatusOnlyDetail(stripCliBoilerplate(raw));
}

/**
 * 这段正文是不是**只说了「状态码是多少」**（`unexpected status 500 Service Unavailable`）。
 * 为什么要单独判：它是 CLI 对 5xx 的固定措辞，**没有任何关于失败原因的信息**——把它算进
 * 「有实质内容」，判据③就会让退出错误顶掉流内那句真正的原因，4xx/5xx 的档位区分也跟着失效。
 * 也就是说「排除状态行」是判据③成立的前提，不是可选的美化。
 * 判据按**行**做：一本次运行里除了状态短语没有别的字才算「只有状态」；夹带正文的仍然算有料。
 */
function isStatusOnlyDetail(detail: string): boolean {
  const lines = detail.split('\n').map((line) => line.trim()).filter((line) => line !== '');
  if (lines.length === 0) return false;
  return lines.every((line) => /^(?:unexpected\s+)?status\s+[45]\d{2}\b.*$/i.test(line));
}

/**
 * 剥掉 `CLI_STDERR_BOILERPLATE` 里的已知样板，只留实质内容；全是样板时返回空串。
 *
 * 单一职责：**只**认这张表，不掺任何别的判断——「退出错误够不够具体」的裁决只在 `exitErrorAddsDetail`。
 * 表为空时它就是「按行原样保留 + 去掉首尾空白」。原来那个固定点循环随表里的前缀一起删掉了：
 * 循环存在的理由是「前缀与样板可能嵌套」，而嵌套的唯一来源就是那条运行内前缀。
 */
function stripCliBoilerplate(message: string): string {
  return message
    .split('\n')
    .filter((line) => !CLI_STDERR_BOILERPLATE.some((pattern) => pattern.test(line.trim())))
    .join('\n')
    .trim();
}

/**
 * 从文案里读 HTTP 状态码（**4xx 与 5xx 都要认**）。
 * 与 `errors.ts` 那张「给用户归因用」的小表（400/401/403/404/429）刻意不同：这里问的是
 * 「这段话里有没有状态码、是哪一档」（用来判断信息量与是否确定性失败），不是「该归到哪个错误码」。
 * 只认 4xx 会把「unexpected status 500」当成「没带状态」，判据②的档位区分随之失效。
 */
function httpStatusIn(message: string): number | null {
  const match = /\b([45]\d{2})\b/.exec(message);
  return match?.[1] === undefined ? null : Number(match[1]);
}

/**
 * 从退出错误正文里读退出码：只认 `… exited with code N` 这一种形态（读不到即 null——**不猜** 1）。
 * 该形态是 exec 通道的产物：codex 的退出错误改由 app-server 客户端给出后写的是 `code=N` ⇒ 这里读不到，
 * 退出码补充那一支落到「未知」。本函数只负责形态读取，改不改读法取决于上一层的取舍判据。
 */
function exitCodeOf(cause: unknown): number | null {
  const message = cause instanceof Error ? cause.message : String(cause);
  const match = /exited with code (\d+)/.exec(message);
  return match?.[1] === undefined ? null : Number(match[1]);
}

/**
 * 组装结果。判定优先级固定：外部要求停止 → 看门狗判定静止超时 → 其余按实际结果。
 * 为什么外部停止排在最前：终止是唯一能表达「外部要求停止」的输入，故以它为准；看门狗排第二，
 * 因为「我们把它掐了」要盖过掐断过程中适配器抛出的那些次生失败（否则界面显示的是断流的症状，
 * 而不是「静止超时」这件事本身）。
 * 为什么 `timed-out` 在这里：它是**骨架**判定的结论（适配器内层没有上限、编排层也不起兜底定时器）；
 * 上游自己报的超时走 `failure`（`AGENT_TIMED_OUT` 的码可以有别的来源，「谁掐的」要分得开）。
 * `exitReason` 与 `error.code` 刻意不同名：前者是给编排层的分类信号，后者是写给用户看的归因。
 * 收的是 `emit`（受保护的发射器）而不是 `EventEmitter` 本身：结论摘要与 error 事件也必须走同一个
 * try/catch，否则消费方抛错会让本函数抛，而它正是「永不抛」承诺的最后一道出口。
 */
function assembleResult(input: {
  startedAt: number;
  /** 外部要求停止的来源（null = 没被外部停）：用户点「终止」或宿主停机 */
  stop: 'signal' | 'shutdown' | null;
  /** 看门狗开火的那一级与它用的上限（null = 没开火） */
  timedOut: { reason: WatchdogTrip; timeoutMs: number } | null;
  failure: AgentFailure | null;
  tokens: AgentRunResult['tokens'];
  subagentTokens: AgentRunResult['subagentTokens'];
  subagentTurns: AgentRunResult['subagentTurns'];
  turns: number | null;
  finalText: AgentRunResult['finalText'];
  /** 本次 schema 有没有真的下发（A1）：三种结论都要带出去，它不属于任何一种收场方式 */
  applied: AgentRunResult['applied'];
  /** 这次运行跑在哪条会话上（各适配器上报的那一格，见 `TurnFinalize.sessionId`） */
  sessionId: AgentRunResult['sessionId'];
  emit: (draft: AgentEventDraft) => void;
}): AgentRunResult {
  const durationMs = Date.now() - input.startedAt;
  // finalText 与 tokens/turns 同路：四种结论（canceled / timed-out / error / completed）都要带出去，
  // 排障时「它说了什么」是唯一能回答「跑到哪一步了」的证据
  const base = {
    tokens: input.tokens,
    turns: input.turns,
    subagentTokens: input.subagentTokens,
    subagentTurns: input.subagentTurns,
    durationMs,
    finalText: input.finalText,
    applied: input.applied,
    sessionId: input.sessionId,
  };
  if (input.stop !== null) {
    const by = input.stop === 'signal' ? '用户终止' : '宿主停机';
    input.emit(logDraft('stderr', `[WARN] 本次运行已被终止（${by}）：适配器已停止并释放运行时`));
    return {
      ok: false,
      exitReason: 'canceled',
      ...base,
      error: { code: 'AGENT_CANCELED', message: `本次运行已被终止（${by}）` },
    };
  }
  if (input.timedOut !== null) {
    const limit = input.timedOut.reason === 'idle' ? '空闲' : '单次模型调用';
    const seconds = Math.round(input.timedOut.timeoutMs / 1_000);
    input.emit(logDraft('stderr', `[WARN] 本次运行已按看门狗判定静止超时收场（${limit}上限 ${seconds} 秒）`));
    return {
      ok: false,
      exitReason: 'timed-out',
      ...base,
      error: { code: 'AGENT_TIMED_OUT', message: `本次运行静止超时（${limit}上限 ${seconds} 秒），已释放运行时` },
    };
  }
  if (input.failure !== null) {
    input.emit({ type: 'error', message: input.failure.message, stack: input.failure.stack });
    return { ok: false, exitReason: 'error', ...base, error: input.failure };
  }
  return { ok: true, exitReason: 'completed', ...base };
}
