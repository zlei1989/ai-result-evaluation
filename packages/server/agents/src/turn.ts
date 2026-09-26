/**
 * 三家共用的运行骨架：注入 → 消费事件流 → 释放 → 组装结果。
 * 为什么集中一处：释放顺序（§5.6.5）、**轮次的发射门槛**、判定优先级（signal 已中止 → canceled；
 * 其余按实际结果）三家必须逐字一致——抄三遍必然漂移，而这几件事出错时都表现为
 * 「偶发卡住 / 状态对不上 / 数字不动」，是最难查的一类问题。厂商差异全部通过 hooks 注入。
 * 注意：本函数**不抛**——所有失败都折进 AgentRunResult.error（§5.6.6 的错误码需要承载处），
 * 编排层因此不需要给每一行套 try/catch。
 */
import { createLogger } from '@aieval/core';
import type { SubagentRecord, UsageTiming, UsageTokens } from '@aieval/contracts';
import { createEventEmitter, logDraft, type AgentEventDraft, type EventEmitter } from './emit';
import { classifyAgentFailure, type AgentFailure } from './errors';
import { createMessageAssembler, type BlockIndexAllocator, type MessageDraft } from './message';
import { releaseTurn, RELEASE_GRACE_MS } from './release';
import type { AgentKind, AgentRunInput, AgentRunResult } from './types';

export interface TurnContext {
  input: AgentRunInput;
  /** 骨架持有的中止入口：厂商 SDK 需要它硬中止（claude 的 abortController / codex 的 signal） */
  controller: AbortController;
  emitter: EventEmitter;
}

/** 收尾产出的两类载荷：行级事件与内容级消息（顺序即产出顺序，各自内部保序） */
export interface TurnFinalize {
  drafts: AgentEventDraft[];
  messages?: MessageDraft[];
  subagents?: SubagentRecord[];
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
   * **能力边界（评审 F3 的原始表述在此修正，复评 I1 的证据链）**：`dispose` 只能**尽力**让 `stream`
   * 的迭代结束——本层无法强制中止一个卡在 `await` 上的迭代器：`dispose` 里的「关闭迭代」类动作
   * （例如关闭厂商 SDK 的事件迭代）在迭代挂起时只是**排队**，要等它自己落到下一个挂起点（yield / 结束）
   * 才生效 ⇒ **`runTurn` 可能无界返回**。所以这里不再是「必须在有限时间内让迭代结束」的硬约束，
   * 而是「尽力 + 登记边界」。
   * 「一行不会永远停在 running」这条**用户可见**的不变量**因此不再由时间保证**（用户口径，2026-09-28
   * 「执行不限时间、评分不限轮次和时间」：编排层原来的 `hardDeadline` / `timedOutRows` 已随之删除）。
   * 今天能停下它的只有用户点「终止」——编排层在行落终态时唤醒行任务、并给 5 秒交卷窗口
   * （`orchestrator.ts` 的 `terminalWaiters` / `TERMINATION_GRACE_MS`）；一个连停止信号都不理的适配器
   * 会让那一行**一直挂着**，这是本次口径的已知代价（登记在包的 README 与冒烟记录里）。
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
   *   1. **只在流正常跑完时调用**（迭代抛错 / 被中止时不调）：失败或被用户终止的运行不该再补
   *      一份「跑完之后才读到的」内容，那是把两条互不相关的事实拼在一起；
   *   2. **抛错只记日志**，不改变本次运行的结论——收尾失败是**补充信息**失败，
   *      不该把一次成功的运行翻成失败（与 `dispose` 的处置同一条理由：可见性次于结论）；
   *   3. **释放之前调用**：它可能需要本次运行还活着的资源（临时目录、文件句柄）。
   *
   * 为什么返回值是「事件」而不是 `TurnProjection`：收尾不产生新消息的计量或失败归因，
   * 硬套投影形状会逼实现写一堆 `tokens: null, turns: null, failure: null` 的噪声。
   */
  finalize?: () => TurnFinalize;
  /** 投影一条原始消息；state 由骨架维护并传给每一家 */
  project: (raw: unknown, state: TurnState) => TurnProjection;
}

/** 骨架维护的跨消息状态 */
export interface TurnState {
  /** 已见过的厂商消息 id：唯一允许丢弃的事件是**重复事件**（§5.6.3） */
  seen: Set<string>;
  /**
   * 已累计的轮次：**一次模型 API 往返算一次**（用户口径，2026-09-28）。三家各自在这个字段上
   * 累加/覆盖自己的口径（claude-code 用「见过的 `assistant.message.id` 数」覆盖；codex 数
   * 「模型产出条目」；dsh 数 `step`），骨架只负责把它交给结果与 `usage` 事件。
   * **这个 `0` 只表示「已观察到的轮次累计」，不是「采到了 0 轮」**（评审 F5）：适配器不要把 state.turns
   * 直接回填进 `TurnProjection.turns`——没采到轮次时它必须是 `null`（「计量绝不填 0」是硬口径），
   * 否则 tokens 已采到、轮次没采到时就会发出 `turns: 0` 的 usage 事件，让人得出「这家很省」的错误结论。
   */
  turns: number;
  /**
   * 已累计的计量（`null` = 还没采到任何一项，不是 0）。
   * 为什么骨架要管这件事（Task 12 实测新增）：dsh 的真实形状是「用量在 `assistant/message` 上、
   * 轮次在 `step/start` / `turn/end` 上」——两者**不在同一条通知**里。适配器把用量记在这里，
   * 到给出轮次的那条出口上连同轮次一起交出去，于是「一条通知给 tokens、另一条给 turns」也能落成
   * 一条合法的 usage 事件（而不是静默丢掉计量）。
   * 口径（2026-09-28）：**dsh 这里是整行累计**（交出时带全量，事件本身是覆盖语义），
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
   * 本行到目前为止的**时间跨度**（2026-10-XX 新增；`null` = 一次都没采到时间）。
   * 为什么放在 `TurnState` 而不是骨架的局部变量：dsh 的 `assistant/message` 与 `turn/end`
   * 都要读它（每一次交出的是「到目前为止」的累计跨度，与 `usage*` 三格同一口径），
   * 而这两条出口都是 `project` 里的纯函数分支——只有 `state` 能在它们之间传递。
   * claude / codex 两家**不写这一格**（前者的时间直接随投影交出、后者在 `finalize` 里现读会话文件）。
   */
  timing: TimingSpan | null;
  /**
   * claude-code 的**跑动期用量估算**：`message.id` → 那条 API 轮次的用量。
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
   * 那个键：claude-code 用主循环的 `assistant.message.id`（一条响应会按内容块多条到达、共享同一个
   * id）；codex 用模型产出条目的 `item.id`（`item.started`/`updated`/`completed` 共享同一个 id）。
   * 为什么与 `usageByMessageId` 分开、且**不用** `state.turns` 自增：那张表只收「三项用量齐全」
   * 的消息，而轮次必须在采不到用量时照样涨——实测那一轮 claude-code 的用量几乎采不到，
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
   * 为什么要跨消息存活：新块只能追加到末尾、序号一经分配不再变化（spec §6.2 第 4 条），
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
   * `tokens` 是**估算值**（用户口径，2026-09-26 的 claude-code）：它只进 `usage` 事件给界面看，
   * **绝不进 `AgentRunResult.tokens`**——否则「崩溃 / 超时 / 被杀」的行会带着一份估算被写成
   * 「采到了计量」，而快照是唯一落盘真相。缺省（undefined）= 权威值。
   * 为什么这个标记在投影上、而不复用注册表的 `capability.liveUsage`：那一格回答的是
   * 「跑动期事件要不要回写快照」（编排层的决策），这一格回答的是「本条消息给的这个数算不算结果」
   * （骨架的决策）。按 kind 反查注册表会把骨架耦合到注册表，而投影本来就知道自己报的是什么。
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
  /** 本条消息给出的轮次总数；未给出为 null */
  turns: number | null;
  /** 本条消息是否表示失败 */
  failure: AgentFailure | null;
  /**
   * 本条消息归一出来的**消息草稿**（spec v3 §2 的 `AgentMessage`，缺省 = 本条不产出消息）。
   * 合并、块序号分配与 `messageId` 由骨架的合并器统一做（`message.ts`），各家只填信封字段与块。
   * 与 `drafts`（行级事件）**并行**输出：事件是行级审计与 SSE 的载体，消息是内容级视图的载体。
   */
  messages?: MessageDraft[];
  /**
   * 本条消息归一出来的**子任务行**（spec v3 §2.6）。同一身份会多次投递（派发 / 收场），
   * 后者是完整快照；缺省 = 本条不改变任何子任务状态。
   */
  subagents?: SubagentRecord[];
}

export interface TurnHooks {
  kind: AgentKind;
  /** 建运行时并返回消费句柄；抛错由骨架折进结果（加载失败 → AGENT_LOAD_FAILED） */
  start: (context: TurnContext) => Promise<TurnStart>;
}

export async function runTurn(input: AgentRunInput, hooks: TurnHooks): Promise<AgentRunResult> {
  const startedAt = Date.now();
  const emitter = createEventEmitter(input.onEvent);
  const logger = createLogger(`agents/${hooks.kind}`);

  /**
   * 受保护的事件发射（评审 F1）：`onEvent` 是**消费方**的代码，它会抛——p4 的
   * `publishRowEvent → appendEvent` 按契约 R26 在写侧 schema 不过时抛 `ServiceError`，磁盘写失败同样抛。
   * 而本函数的承诺是「永不抛、所有失败折进 AgentRunResult.error」，且 p4 的编排层**不给每一行套
   * try/catch**（正因 run() 承诺不抛）。裸调 `emitter.emit` 一旦被消费方抛错，后果按位置分两种：
   *  - 循环内：异常被下面的 catch 归因成 `AGENT_FAILED`，把「日志写盘失败」误报成「适配器运行失败」；
   * 循环外（释放路径的 `onGraceExceeded` 尤其）：`finally` 里的 `await triggerRelease()` 抛出 ⇒
   *    `dispose()` 可能未走完，且正常结论被异常替换。
   * 因此**本文件里全部 6 个发射点**都走这里（启动前中止 / 第二段兜底 / 循环内 drafts / 循环内 usage /
   * canceled 摘要 / error 事件），`emit.ts` 的裸调只允许出现在这个 `try` 里。
   * 注意这是**约定 + 用例**层面的保证，不是类型层面的：`(draft) => void` 拦不住调用方传入一个未包装的
   * 闭包（复评的新洞 NEW-2 就是这么造出存活变异体的），所以每个调用点都得有回归钉。
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
    emit(logDraft('stderr', '[WARN] 该行在启动前已被终止，本次运行未启动任何智能体进程'));
    return {
      ok: false,
      exitReason: 'canceled',
      tokens: null,
      turns: null,
      durationMs: 0,
      // 这一格没建过运行时、也没消费过事件流 ⇒ 没有答复可言，只能是「未采到」（不是空串）
      finalText: null,
      error: { code: 'AGENT_CANCELED', message: '该行在启动前已被终止' },
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
  let signalCanceled = false;
  let failure: AgentFailure | null = null;
  /** 权威计量（进结果、进而进快照）：只有非估算值才写这里 */
  let tokens: AgentRunResult['tokens'] = null;
  /** 估算计量（claude-code 的跑动期估算）：只进事件，绝不进结果 */
  let estimatedTokens: AgentRunResult['tokens'] = null;
  let turns: number | null = null;
  /**
   * 上一次**发出去**的那一对（轮次 / 计量）：同一条消息的重复快照不该刷屏。
   * 去重放在骨架里而不是各家投影里（原来 claude-code 的 `isSameUsage` 就在做这件事）：
   * 三家的「什么时候值得发一条」必须是同一条规则，否则界面上的数会因家而异。
   */
  let emittedUsage: { tokens: AgentRunResult['tokens']; turns: number; timing: UsageTiming | null } | null = null;

  let settleTurn: () => void = () => {};
  const turnSettled = new Promise<void>((resolve) => {
    settleTurn = resolve;
  });

  // 第二段兜底的可见信号：既要进服务日志，也要进该行事件日志（界面上的日志抽屉看得到）
  const onGraceExceeded = (): void => {
    const text = `[WARN] ${hooks.kind} 在 ${RELEASE_GRACE_MS / 1000} 秒内未结束在途 turn，已强制释放运行时（该适配器不响应停止信号，属已知能力差异）`;
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
    // 翻转成 canceled（评审 F4）。signal 仍只用来判 canceled，不参与其它原因的推断，口径不变。
    signalCanceled = true;
    requestStop();
  };

  input.signal.addEventListener('abort', onAbort, { once: true });

  try {
    const started = await hooks.start({ input, controller, emitter });
    handle = started;
    if (stopRequested) requestStop();
    logger.debug('适配器已启动，开始消费事件流', {
      kind: hooks.kind,
      cwd: input.cwd,
      model: input.route.modelId,
    });
    for await (const raw of started.stream) {
      const projection = started.project(raw, state);
      for (const draft of projection.drafts) emit(draft);
      for (const message of projection.messages ?? []) emitMessage(message);
      for (const record of projection.subagents ?? []) emitSubagent(record);
      if (projection.turns !== null) turns = projection.turns;
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
           * 权威值一到，估算**作废**（2026-09-28 复查新增）。两者都是「到目前为止的累计」
           * （claude-code 的估算按 `message.id` 归并求和，权威值只在收尾的 `result` 上），
           * 而估算的来源被 SDK 明写为 not final ⇒ 留着它，收尾那条 `usage` 事件就还会显示一个
           * 偏小的假数，正是本仓最忌讳的那种「看起来采到了」。
           */
          estimatedTokens = null;
        }
      }
      /**
       * 发射门槛是**轮次**，不是「tokens 与轮次同时在」（2026-09-28 用户口径修正）。
       *
       * 改之前：只有本条投影**同时**给出 tokens 与 turns 才发 `usage`。后果实测过——claude-code
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
      const liveTiming = resolveTiming(state.timing);
      if (projection.turns !== null && !sameUsage(emittedUsage, liveTokens, liveTiming, projection.turns)) {
        // `timing` 恒带这一格（没有时间时是 `null`）：契约里它是 `.nullable()`，而「带一个 null」
        // 与「整个键不存在」在读侧是同一件事——都走 `.nullable()` 那一支，故不必分两种形状。
        emit({ type: 'usage', tokens: liveTokens, timing: liveTiming, turns: projection.turns });
        emittedUsage = { tokens: liveTokens, turns: projection.turns, timing: liveTiming };
      }
      if (projection.failure !== null) failure = projection.failure;
    }
    /**
     * 收尾投影（可选，见 `TurnStart.finalize`）：流**正常跑完**、且**本次运行没有失败**时才做，
     * 并且**在释放之前**。失败只记日志——收尾是补充信息，不该把一次跑完的运行翻成失败
     * （`dispose` 同一条处置）。
     *
     * 为什么失败时不收尾（`failure !== null` 也跳过）：一条 `{type:'error'}` / `turn.failed` 意味着
     * 这次运行**没跑完**，而收尾读的是「跑完之后才完整」的产物（codex 的会话文件）。在没跑完的
     * 运行上补一份不完整的内容，只会把两条互不相关的事实拼在一起——而且那一行的结论已经是失败，
     * 补出来的内容没有消费者（错误与终止都不重试、不评分）。**不做**的是「猜到用户想看点东西」。
     */
    if (started.finalize !== undefined && failure === null) {
      try {
        const finalized = started.finalize();
        for (const draft of finalized.drafts) emit(draft);
        for (const message of finalized.messages ?? []) emitMessage(message);
        for (const record of finalized.subagents ?? []) emitSubagent(record);
      } catch (error) {
        logger.error('收尾投影失败（已忽略，不影响本次运行的结论）', { kind: hooks.kind, error });
      }
    }
  } catch (cause) {
    if (stopRequested) {
      // 停止请求引发的流中断不是失败：结论由 canceled 通路给出（§5.6.5 的判定优先级）
      logger.debug('事件流因停止请求结束', { kind: hooks.kind, error: cause });
    } else {
      const classified = classifyAgentFailure(cause, { kind: hooks.kind, baseUrl: input.route.baseUrl });
      /**
       * 退出错误与「流内错误」的取舍（2026-09-27，目标页 codex 实测）。
       *
       * 背景：SDK 抛出的退出错误把 **stderr 全文**拼进 message（`@openai/codex-sdk` 的
       * `Codex Exec exited with code ${code}: ${stderr}`），而 codex CLI **每次运行都会**把
       * `Reading prompt from stdin...` 写到 stderr——于是 codex 的**每一行**失败都会被写成
       * 「`Codex Exec exited with code 1: Reading prompt from stdin...`」：
       * 这句话里没有一个字是失败原因（实测：同一份 argv 打到一个完整的假 Responses API 上，
       * 退出码 0、事件流正常、stderr 里照样是这一行）。
       *
       * 而失败原因**通常已经在同一次运行的事件流里**：`project` 会把 `{"type":"error",…}` 与
       * `turn.failed` 收成 `failure`（真实那一轮是
       * 「Reconnecting... 5/5 (We're currently experiencing high demand…)」→ 上游 5xx 抖动）。
       * 原来的写法让退出错误**无条件覆盖**它，于是用户拿到的是一条误导性说明、真正的原因只剩日志抽屉里有。
       *
       * 处置（两条判据，取其一才覆盖）：
       *   ① 退出错误**自己带**可识别的 HTTP 状态（`AUTH_FAILED` / `RATE_LIMITED` 这类高分归因）⇒ 它更具体，覆盖；
       *   ② 退出错误的 stderr **有实质内容**（剥掉 CLI 那条 banner 之后还有字）⇒ 它比流内的一句抱怨更有料，覆盖；
       * 否则保留流内错误——它才是「为什么断了」的直接陈述，并把退出码作为**补充**写进文案。
       * 文案里保留「CLI 以退出码 N 收场」这一事实：那确实是本次运行的真实结束方式，不该抹掉；
       * 但绝不让它**顶替**原因。stderr 原文一个字符都不删，只是不再冒充原因（它在退出错误的 cause 里）。
       */
      if (failure !== null && !exitErrorAddsDetail(classified, cause)) {
        failure = {
          code: failure.code,
          message: `${failure.message}（随后 codex CLI 以退出码 ${exitCodeOf(cause) ?? '未知'} 收场）`,
          ...(failure.stack === undefined ? {} : { stack: failure.stack }),
        };
        logger.error('适配器运行失败（保留事件流里的原因，退出错误只是 CLI 收场）', {
          kind: hooks.kind,
          code: failure.code,
          exitMessage: classified.message,
        });
      } else {
        failure = classified;
        logger.error('适配器运行失败', { kind: hooks.kind, code: failure.code, error: cause });
      }
      /**
       * **CLI 的 stderr 也必须落进该行事件流**（2026-09-27 目标页实测补的）。
       *
       * 为什么不能只留在 `cause` 里：`cause` 只进服务端日志，而使用者看的是「查看日志」抽屉。
       * 实测那一行失败时抽屉里的最后几行只有上游的 `Reconnecting…`，**看不到 CLI 自己怎么说的**
       * ——而「是网关 500 还是 Responses 契约不被满足」这个关键区分，恰恰只有 CLI 的 stderr 能回答
       * （上游 500 已经由 `POST /v1/responses` 直接探测证实；但若将来是**契约不兼容**，
       * 唯一能看见它的地方就是这里）。stderr 是**证据**，不是结论，所以按 log 事件落盘、
       * 不冒充 `error` 事件的文案；样板行已经由 `exitErrorAddsDetail` 判定过，这里原样保留全文。
       */
      const cliDetail = stripCliBoilerplate(cause instanceof Error ? cause.message : String(cause));
      if (cliDetail !== '') {
        emit(logDraft('stderr', `[${hooks.kind}] CLI 退出详情（stderr）：${cliDetail}`));
      }
    }
  } finally {
    input.signal.removeEventListener('abort', onAbort);
    // 「终结在途 turn」：释放序列的第二段落在这里（适配器自己的 finally 清理完成）
    settleTurn();
    const report = await triggerRelease();
    if (report.disposeError !== null) {
      logger.error('释放运行时失败（已忽略，避免掩盖本次运行的结论）', { error: report.disposeError });
    }
  }

  const result = assembleResult({
    startedAt,
    canceled: signalCanceled,
    failure,
    tokens,
    turns,
    finalText: state.finalText,
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
 *   ③ **来源不一致 ⇒ 整格作废**（`null`）：`'vendor'` 的纯模型时间与 `'events'` 的墙钟**不可相减**
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
    // `apiMs` / `ttftMs` 同样是「先到的那一份说了算」：它们是**同一次往返**的三个侧面，
    // 后到的消息若不带这两格（`undefined`），不该把已经采到的值抹掉；
    // 带了就以新的为准（同一个值，只有厂商刷新时才变）。
    ...(next.apiMs === undefined || next.apiMs === null ? { apiMs: previous.apiMs } : { apiMs: next.apiMs }),
    ...(next.ttftMs === undefined || next.ttftMs === null ? { ttftMs: previous.ttftMs } : { ttftMs: next.ttftMs }),
    source: next.source,
  };
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
 * 这一次观察到的「轮次 + 计量 + 时长」是否与上次发出去的**逐字段相同**（相同就不再发事件）。
 * `null` 只与 `null` 相同：从「没采到」变成「采到了 0」是一次真实变化，必须发出去
 * （界面要能从「采集中」变成 0）。
 * `timing` 进判据而**不是被忽略**：dsh 的 `turn/end` 会把同一笔计量再交一次，而那时右端点
 * 已经往后推了（同一个 step 里工具也跑过）⇒ 不比较它就会把「这一轮到底花了多久」永远冻结在
 * 第一个 step 上。三格逐字段比（含 `source`：来源换了就是另一个口径的数，不能当成没变）。
 */
function sameUsage(
  previous: { tokens: AgentRunResult['tokens']; turns: number; timing: UsageTiming | null } | null,
  tokens: AgentRunResult['tokens'],
  timing: UsageTiming | null,
  turns: number,
): boolean {
  if (previous === null) return false;
  if (previous.turns !== turns) return false;
  if (!sameTiming(previous.timing, timing)) return false;
  const left = previous.tokens;
  const right = tokens;
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
 * 退出错误的 stderr 里**需要被忽略的样板**（见 `exitErrorAddsDetail` 的注释）。
 *
 * `Reading prompt from stdin...` 是 **codex CLI 每次运行都打**的提示，与成功失败无关
 * （实测：同一份 argv 打到一个完整的假 Responses API 上，退出码 0、事件流正常，stderr 里照样是这一行）。
 * 它出现在错误文案里时**零信息量**，却会让「真正的失败原因」看不见。
 *
 * 两处形态都要覆盖，**这是实测的坑**：SDK 把 `Codex Exec exited with code N:` 与 stderr **拼在同一行**
 * （`Codex Exec exited with code 1: Reading prompt from stdin...`），所以「按行匹配 CLI 的那句提示」
 * 永远匹配不上——`stderr` 与那句提示之间隔着 SDK 的前缀。故这里按**前缀**与**整行**两种形态各给一条：
 *   · `^Codex Exec exited with (code \d+|signal \S+):\s*` —— SDK 的包装（行内前缀，可重复剥）；
 *   · `^Reading prompt from stdin\.{0,3}$` —— CLI 的提示（它自己成行时）。
 */
const SDK_EXIT_PREFIX = /^Codex Exec exited with (?:code \d+|signal \S+):\s*/;
const CLI_STDERR_BOILERPLATE: readonly RegExp[] = [/^Reading prompt from stdin\.{0,3}$/];

/**
 * 退出错误是否**比流内错误更值得展示**。
 *
 * 三条判据（按「信息量」从高到低）：
 *   ① 退出错误**自己归到了确定性错误码**（`AUTH_FAILED` / `RATE_LIMITED`）⇒ 它更具体，覆盖。
 *      典型：`Codex Exec exited with code 1: 401 Unauthorized`——那比流内一句「high demand」有用得多。
 *   ② 退出错误带 **4xx** 状态 ⇒ 同上，覆盖（4xx 指向凭据/请求，是确定性归因）；
 *   **5xx 刻意不在此列**（2026-09-27 目标页实测修正）：网关 5xx 抖动时，流内那句
 *      「We're currently experiencing high demand…」是**关于这次失败的信息**，而
 *      「unexpected status 500」只说了一个瞬时面——两者归因码都是 `AGENT_FAILED`（可重试），
 *      那就该留下信息更多的那条，而不是让退出错误把原因换掉。
 *   ③ 退出错误的 stderr 剥掉样板后**还有实质内容**（不是只有一句状态行）⇒ 那是 CLI/上游给的正文，覆盖。
 * 都不成立（常态：只剩 `Reading prompt from stdin...` 或一句 `unexpected status 5xx`）⇒ 保留流内原因，
 * 并把退出码写成补充。
 */
function exitErrorAddsDetail(classified: AgentFailure, cause: unknown): boolean {
  if (classified.code === 'AUTH_FAILED' || classified.code === 'RATE_LIMITED') return true;
  const raw = cause instanceof Error ? cause.message : String(cause);
  const status = httpStatusIn(`${classified.message}\n${raw}`);
  if (status !== null && status < 500) return true;
  return stripCliBoilerplate(raw) !== '' && !isStatusOnlyDetail(stripCliBoilerplate(raw));
}

/**
 * 这段 stderr 是不是**只说了「状态码是多少」**（`unexpected status 500 Service Unavailable`）。
 * 为什么要单独判：它是 CLI 对 5xx 的固定措辞，**没有任何关于失败原因的信息**——
 * 不排除它的话，判据 ③ 会把它当成「有实质内容」而把流内那句真正的原因换掉（实测踩过：
 * 写成弱断言时这条守不住，4xx/5xx 的区分也就跟着失效）。
 * 判据按**行**做：一行里除了状态短语没有别的字才算「只有状态」；夹带正文的仍然算有料。
 */
function isStatusOnlyDetail(detail: string): boolean {
  const lines = detail.split('\n').map((line) => line.trim()).filter((line) => line !== '');
  if (lines.length === 0) return false;
  return lines.every((line) => /^(?:unexpected\s+)?status\s+[45]\d{2}\b.*$/i.test(line));
}

/**
 * 剥掉 SDK 前缀与 CLI 样板，只留实质内容；全是样板时返回空串。
 *
 * 为什么是**固定点循环**而不是扫两遍：前缀与样板可能任意嵌套（`…exited with code 1: Reading prompt…`
 * 是行内前缀 + 行内样板；将来 CLI 若把提示单独成行，就变成前缀 + 独立行）。每轮剥掉一层、
 * 直到没有变化为止，两种形态都不需要另写分支；`SDK_EXIT_PREFIX` 用 while 剥是因为它可能重复
 *（网关/包两层的包装）。轮数天然有界（每轮至少消耗一个前缀或一行），不会死循环。
 */
function stripCliBoilerplate(message: string): string {
  let current = message;
  for (;;) {
    const withoutPrefix = current.replace(SDK_EXIT_PREFIX, '');
    const withoutBanner = withoutPrefix
      .split('\n')
      .filter((line) => !CLI_STDERR_BOILERPLATE.some((pattern) => pattern.test(line.trim())))
      .join('\n')
      .trim();
    if (withoutBanner === current.trim()) return withoutBanner;
    current = withoutBanner;
  }
}

/**
 * 从文案里读 HTTP 状态码（**4xx 与 5xx 都要认**）。
 * 与 `errors.ts` 那张「给用户归因用」的小表（400/401/403/404/429）刻意不同：这里问的是
 * 「这段话里有没有状态码、是哪一档」（用来判断信息量与是否确定性失败），不是「该归到哪个错误码」。
 * 只认 4xx 的写法会让「unexpected status 500」被当成「没带状态」（2026-09-27 实测修正）。
 */
function httpStatusIn(message: string): number | null {
  const match = /\b([45]\d{2})\b/.exec(message);
  return match?.[1] === undefined ? null : Number(match[1]);
}

/** 从退出错误里读 CLI 的退出码（读不到即 null——**不猜** 1） */
function exitCodeOf(cause: unknown): number | null {
  const message = cause instanceof Error ? cause.message : String(cause);
  const match = /exited with code (\d+)/.exec(message);
  return match?.[1] === undefined ? null : Number(match[1]);
}

/**
 * 组装结果。判定优先级固定（§5.6.5 起、2026-09-28 收窄）：signal 已中止 → canceled；其余按实际结果。
 * 为什么 canceled 排在最前：终止是唯一能表达「外部要求停止」的输入，故以它为准。
 * **`timed-out` 这一支已经不存在**：执行与评分都不限时间（用户口径），适配器没有内层上限，
 * 编排层也不再起兜底定时器 ⇒ 这一格没有生产者。`AgentExitReason` 与行状态里的 `timed-out`
 * 保留（历史 `run.json` 里还有它，读侧与重试判据都要认）。
 * `exitReason` 与 `error.code` 刻意不同名（§5.6.6）：前者是给编排层的分类信号，后者是写给用户看的归因。
 * 收的是 `emit`（受保护的发射器）而不是 `EventEmitter` 本身：结论摘要与 error 事件也必须走同一个
 * try/catch，否则消费方抛错会让本函数抛，而它正是「永不抛」承诺的最后一道出口（评审 F1）。
 */
function assembleResult(input: {
  startedAt: number;
  canceled: boolean;
  failure: AgentFailure | null;
  tokens: AgentRunResult['tokens'];
  turns: number | null;
  finalText: AgentRunResult['finalText'];
  emit: (draft: AgentEventDraft) => void;
}): AgentRunResult {
  const durationMs = Date.now() - input.startedAt;
  // finalText 与 tokens/turns 同路：三种结论（canceled / error / completed）都要带出去，
  // 排障时「它说了什么」是唯一能回答「跑到哪一步了」的证据
  const base = { tokens: input.tokens, turns: input.turns, durationMs, finalText: input.finalText };
  if (input.canceled) {
    input.emit(logDraft('stderr', '[WARN] 该行已被终止：适配器已停止并释放运行时'));
    return {
      ok: false,
      exitReason: 'canceled',
      ...base,
      error: { code: 'AGENT_CANCELED', message: '该行已被用户终止' },
    };
  }
  if (input.failure !== null) {
    input.emit({ type: 'error', message: input.failure.message, stack: input.failure.stack });
    return { ok: false, exitReason: 'error', ...base, error: input.failure };
  }
  return { ok: true, exitReason: 'completed', ...base };
}
