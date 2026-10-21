/**
 * pi 子智能体的 **wire 级内容通道**：不经转写文件，直接订阅子会话自己的事件流。
 *
 * ## 为什么需要这一层（转写文件通道的两条短处）
 *
 * 子会话的事件不进父会话的 `session.subscribe` 流（SDK 的订阅是实例级的），扩展对外又只发
 * 生命周期事件 ⇒ 逐步骤正文此前只能读扩展写的转写文件（`transcript.ts`，`source: 'session-file'`）。
 * 文件通道有两条短处：**轮级时延**（`turn_end` 才 flush，一轮之内的中间过程不落盘）与
 * **旁路身份**（界面上带「补录」角标，实时性与 wire 不可比）。
 *
 * ## 通道怎么拿到（`docs/rpc.md` 记载的 manager registry）
 *
 * 扩展把它的 `AgentManager` 挂在 `globalThis[Symbol.for("pi-subagents:manager")]`（先到先得：
 * 槽非空就不写）。`getRecord(id)` 返回的 record 上有**子会话的活句柄** `session`，
 * 对它 `subscribe()` 即可拿到与主会话同构的全量事件流（含逐字增量）。
 *
 * 每个本次运行拿到**自己那份** manager 的办法（并发两行时槽只有一个）：
 * **每个本次运行 reload 落定后把当时的注册表条目快照进行的、随即删掉全局槽**——下一行 reload 时
 * 扩展工厂见槽是空的，就会挂上自己的 manager。扩展工厂的执行点在 `loader.reload()`
 * （`resource-loader.js` 的 `loadFinalExtensionSet` → `initializeExtension`），
 * `createAgentSession`（我们传了 loader）与 `bindExtensions` 都不再执行工厂 ⇒ 快照紧跟
 * reload 之后即可覆盖全部 claim 点。**删槽是契约外动作**：已核扩展不自读该槽
 * （全包仅定义 / claim / release 三处使用），release 侧有双重卫兵（槽 === 自己的条目才删），
 * 我们先删等于让它空转一次。
 *
 * 并发竞态：两行同时 reload 时，后一本次运行的工厂可能落在「前行 claim 之后、快照删槽之前」的
 * 微任务缝隙里而错过 claim ⇒ reload + 快照 + 删槽整段走**模块级互斥链**（跨行共享，
 * 见 `reloadChain`）。互斥失败（快照落空）的姿态是降级：本次运行退回转写文件通道，不失败。
 *
 * ## 事件怎么进来、怎么出去
 *
 * `subagents:started`（扩展总线）触发订阅：先同步试一次 `getRecord`，拿不到再按
 * `PI_SUBAGENT_WIRE_POLL_MS` 重试到放弃上限（会话在 `onSessionCreated` 才出现，`started` 早于它）。
 * 到手即 `session.subscribe()`。**订阅回调只做两件事**：快照载荷（厂商事件对象可能被
 * 后续帧原地改写，见 `snapshotPiPayload`）+ 写缓冲——不投影、不发射、不抛（那一刻不在
 * 骨架的 try/catch 里，一次抛错就能带走整行）。投影层在每个父事件之后
 * `drain(已落账的身份)` 取走缓冲折成消息草稿（`source: 'wire'`、盖 `subagentId`）。
 *
 * ## 为什么还要一个**合成帧泵**（实时性的成立前提）
 *
 * 排空挂在「父会话的下一个事件」上，于是实时性等于**父会话的事件密度**——而派发期是父会话
 * 最安静的时候：`Agent` 是阻塞工具，真机原始帧计数（`pi 1.3.0`，脚本式上游）里从
 * `tool_execution_start` 到 `tool_execution_end` 之间只有 **4 帧 `tool_execution_update` +
 * 1 帧 `entry_appended`**，没有一帧带子任务正文。缓冲照常进帐，靠这几帧去取的话子任务的正文
 * 会按它们的节奏一小段一小段地出（或整段攒到工具收尾**一次性**涌出），而不是边产边长。
 *
 * 所以写缓冲之后要**自己造一次心跳**：`attachPump` 收下一个「往父事件流里塞一帧」的入口，
 * 骨架照常把那一帧交给 `project` ⇒ 投影层的排空照常跑。合成帧本身不带任何正文
 * （`events.ts` 认出 `PI_SUBAGENT_WIRE_TICK_TYPE` 即返回空投影），它只是**一次排空的借口**。
 *
 * 两条设计约束：
 *   · **至多一帧在飞**（`tickPending`）：子会话一轮能产十几条事件，一条一帧会把投影刷成流水；
 *     `drain` 跑过就清旗，于是「有新内容 ⇒ 下一帧」始终成立，延迟仍是毫秒级。
 *   · **泵可以不在**（区间之间、wire 不可用）：此时只写缓冲，接上泵的那一刻若缓冲非空就补一帧
 *     ——否则那批正文要等父会话自己的下一个事件（正是这条要修的那个病）。
 *
 * ## 泵今天值多少（真机量过，别按设计意图读）
 *
 * 派发期**并非**「父会话一个事件都不产」：真机原始帧计数（`pi 1.3.0`，脚本式上游）显示
 * `tool_execution_start` 到 `tool_execution_end` 之间有 **4 帧 `tool_execution_update` + 1 帧
 * `entry_appended`**（都不带子任务正文）；而父会话除这几类帧之外还有别的帧会触发排空
 * （`message_start` / `message_update` / `turn_start` 等）。真网关每臂 3 样本的对照（接泵 / 不接泵，
 * 指标 = 子任务正文首条到账相对父会话下一个帧的先后）：**接泵臂稳定早 2–3 ms，不接泵臂出现过
 * 85 / 124 ms 的提前量** ⇒ 在前台派发这条路上，泵的收益**量不到**（噪声量级，方向还不一致）。
 *
 * 那它为什么还留着：唯一真正依赖它的是**彻底静默的父会话**那一档，本仓用夹具钉住了
 * （`index.test.ts` 的 `hangPrompt` 守卫：摘泵即挂到超时）。真机今天没观测到「完全无父事件」的
 * 派发窗口，但观测不到不等于不存在（厂商改帧、或某条 wire / 档位不发那几类帧时它就会回来），
 * 而泵的成本是封顶的（至多一帧在飞 + 25 ms 节流 + 空转封顶）。
 * **要删它的判据**：把那条 `hangPrompt` 守卫连同夹具一起删掉，并证明真机不存在完全静默的派发窗口。
 *
 * ## 轮次与转写通道的对齐（去重的成立前提）
 *
 * 转写路径按「助手行序」从 1 数轮（`transcript.ts`），wire 路径按「助手 `message_end`
 * 序」数轮，并在订阅时用 `session.messages` 里已有的助手消息数做**基数**——两者对同一条
 * 消息给出同一轮次，于是同一条消息在两条通路上的载体键（`carrierKeyOf`）相同，投影层按
 * 「第一条到达者胜出」去重（wire 更快，通常胜出；订阅前的缺口由订阅那一刻的**补账**填上，
 * 见 `backfillHistory`，转写只剩真正的兜底角色）。
 * `session.messages` 读不出（不是数组）时**放弃订阅**而不是猜基数——轮次错一格就是键错
 * 一条，去重失效会在账本里留双份。
 *
 * ## 失败姿态（全部退回转写文件通道，不影响结论）
 *
 * 快照落空（扩展没装载 / 互斥缝隙错过 claim）、`getRecord` 拿不到 record、record 迟迟
 * 没有 session、订阅抛错——各自静默降级；转写路径照常兜底（含 `session.messages` 也读不出时
 * 的那一段缺口与全部正文）。
 * 唯一点名的异常是**缓冲越界截断**（父会话长时间无事件时子会话还在产流）：静默丢半段
 * 与「本来就这些」在界面上长得一样。
 */
import { asRecord, readField, readString } from '../../json';
import type { MessageDraft } from '../../message';
import { piAssistantMessageDraft, piDeltaMessageDraft, piToolResultMessageDraft, snapshotPiPayload } from './message';

/** 扩展挂在 globalThis 上的跨包单例键（其 `docs/rpc.md`「The manager registry」节） */
/** 扩展挂在 globalThis 上的跨包单例键（其 `docs/rpc.md`「The manager registry」节）；测试模拟厂商侧时也从这里取，避免字面量散布漂移 */
export const PI_SUBAGENTS_MANAGER_KEY = Symbol.for('pi-subagents:manager');

/**
 * 单个身份的 wire 缓冲上限。
 *
 * 正常路径碰不到：排空按 `PI_SUBAGENT_WIRE_TICK_MS` 的节拍跑，一个 100 token/s 的子会话
 * 每拍只攒两三帧。它挡的是「行迟迟不落账 + 子会话还在产流」那条病态长尾——而**逐字增量
 * 让这条长尾快了两三个数量级**（一条几千 token 的答复就是几千帧）⇒ 越界不再是稀有事件，
 * 淘汰策略因此必须按块形态分档（见 `evictOverflow`：先吃增量、快照垫底）。
 * 上限本身不必跟着增量放大：缓冲里的条目是轻量快照对象，5000 条的内存可忽略，
 * 而「攒到 5000 条还没人来取」本身就是要被点名的病，不是要被容纳的常态。
 */
export const PI_SUBAGENT_WIRE_BUFFER_MAX = 5000;

/**
 * 合成帧的判别类型。**必须是厂商取值域外的字符串**：它要穿过骨架的 `project` 而不被
 * 当成真事件（`events.ts` 认出它就返回空投影，一条草稿都不落——否则原始输出面板会被
 * 「未识别的厂商载荷」刷满）。带 `aieval` 前缀即与厂商的 `snake_case` 取值域天然不撞。
 */
export const PI_SUBAGENT_WIRE_TICK_TYPE = 'aieval:pi-subagent-wire-tick';

/** 空转的续泵上限（见 `fruitlessTicks`：一次正常投递要两帧，故下限是 2） */
export const PI_SUBAGENT_WIRE_MAX_FRUITLESS_TICKS = 3;

/**
 * 两帧合成帧之间的最小间隔（毫秒）。
 *
 * 为什么要节流：子会话一轮能产**几千帧逐字增量**，不节流就是几千次投影——每次都要走一遍
 * 全身份排空与载体去重。25 ms 把投影次数压到 ≤40 次/秒，而**每一拍 `drain` 把这一拍攒下的
 * 增量整批取走** ⇒ 节流压的是「投影次数」，不是「正文的新鲜度」：帧再密也不会被丢，
 * 只是攒到下一拍一起出。
 *
 * 为什么是 25 ms 而不更小：人眼的帧预算是 16 ms 起，40 次/秒已在「连续」那一侧；
 * 再小只增加投影开销，换不到可感知的流畅度。导出供测试钉值。
 */
export const PI_SUBAGENT_WIRE_TICK_MS = 25;

/**
 * 订阅重试的节拍与放弃上限。真机上 `started` 到会话出现是毫秒级，但子会话的创建包含
 * 扩展自建装载器的整段初始化（jiti 无模块缓存、每次全量编译）——**测试全量并本次运行的 CPU
 * 争抢下实测会超过 10 s**，窗口太短会把这一档误判成「没有会话」而整行退回转写通道。
 * 放长到 60 s 没有代价：轮询在终态 / 退订 / 收尾时都会停，计时器也不占事件循环。
 * 导出供测试钉值：节拍一变，「订阅密度」与「放弃窗口」两个行为面就跟着变，得是有意的。
 */
export const PI_SUBAGENT_WIRE_POLL_MS = 20;
export const PI_SUBAGENT_WIRE_GIVE_UP_MS = 60_000;

/** 测试期覆写轮询节拍与放弃上限（产品默认值由独立用例钉住） */
let timingsForTesting: { pollMs: number; giveUpMs: number; tickMs?: number } | null = null;

export function setPiSubagentWireTimingsForTesting(timings: { pollMs: number; giveUpMs: number; tickMs?: number } | null): void {
  timingsForTesting = timings;
}

/**
 * 模块级互斥链：`reload + 快照 + 删槽` 整段串行（**跨行共享**，进程内唯一）。
 * 链上吞掉前一次的失败——一次本次运行的装配失败不该让后面所有本次运行的装配都排队等一个死 promise。
 */
let reloadChain: Promise<unknown> = Promise.resolve();

/** 测试期重置互斥链与全局槽（否则跨用例残留会让「先到先得」的用例互相干扰） */
export function resetPiSubagentWireForTesting(): void {
  reloadChain = Promise.resolve();
  delete (globalThis as Record<symbol, unknown>)[PI_SUBAGENTS_MANAGER_KEY];
}

/** registry 条目上本模块用的那一格（收窄到用的形状，不抄厂商的 `.d.ts`） */
interface PiSubagentManagerEntry {
  getRecord: (id: string) => unknown;
}

/**
 * 子会话的**收窄视图**：只保留原始对象本身，方法一律经**属性访问**调用
 * （`raw['subscribe'](…)`）——`this` 绑定在原始实例上。把方法摘下来装进新对象再调，
 * `this` 会指向包装对象，SDK 内部的实例字段（`_eventListeners`）全部读不到，
 * 表现是订阅当场 TypeError、这一身份静默退回转写通道。
 */
interface PiSubagentSessionLike {
  raw: Record<string, unknown>;
}

/** 读全局槽上的注册表条目，形状不对（或没挂）返回 `null` */
function readManagerEntry(): PiSubagentManagerEntry | null {
  const value = (globalThis as Record<symbol, unknown>)[PI_SUBAGENTS_MANAGER_KEY];
  const record = asRecord(value);
  if (record === null || typeof record['getRecord'] !== 'function') return null;
  // 与子会话同一条理由：方法经原始对象调用（this 绑定），不摘下来
  return { getRecord: record['getRecord'].bind(record) as (id: string) => unknown };
}

/**
 * 子会话句柄收窄：订阅入口与消息数组两格都在才可用（少任何一格都谈不上对齐轮次）。
 * `messages` 在这里读一次只做**形状校验**（getter 经 `readField` 求值，抛错按「没有」处理）；
 * 取值一律在使用时再读（`attach` 的基数计算），不存快照。
 */
function asChildSession(value: unknown): PiSubagentSessionLike | null {
  const record = asRecord(value);
  if (record === null || typeof record['subscribe'] !== 'function') return null;
  if (!Array.isArray(readField(record, 'messages'))) return null;
  return { raw: record };
}

/** `session.messages` 里已完成助手消息的条数（wire 轮次的基数；与转写的助手行序同源） */
function countAssistantMessages(messages: readonly unknown[]): number {
  return messages.filter((message) => readString(asRecord(message), 'role') === 'assistant').length;
}

/**
 * 单个身份的缓冲：事件按到达序排，轮次在**入缓冲时**就定死（助手收尾 +1，工具沿用当前值，
 * 增量取「当前 + 1」——它属于那条还没收尾的消息）。
 */
interface WireBuffer {
  entries: Array<
    | { kind: 'assistant'; round: number; message: unknown }
    | { kind: 'tool'; round: number; event: unknown }
    | { kind: 'delta'; round: number; event: unknown }
  >;
  /**
   * 越界丢弃的条数，**按块形态分两格**（drain 时点名一次后清零）。
   *
   * 分开记是因为两者的严重性差一个档：快照是权威正文（丢了就真的没有了，界面上
   * 「少一整轮」与「本来就没说」长得一样），而增量只是实时预告——既不落盘
   * （编排层对 `chunk: 'delta'` 只扇出不写文件），又会被同一块的收尾快照整块覆盖 ⇒ **自愈**。
   * 合成一格会让「只丢了几帧预告」和「真丢了一轮正文」在排障时分不开。
   */
  droppedDeltas: number;
  droppedSnapshots: number;
}

/** 单个身份已成功的订阅：退订函数与轮次计数器（计数在吸收事件时前进，与 drain 批次无关） */
interface WireSubscription {
  unsubscribe: () => void;
  round: number;
}

/** 一次 wire 通道的排空结果（warnings 由投影层落成点名 WARN，不在这里发射） */
export interface PiSubagentWireDrain {
  messages: MessageDraft[];
  warnings: string[];
}

/** 每个本次运行一份的 wire 通道（跨行共享的只有互斥链与全局槽本身） */
export interface PiSubagentWire {
  /**
   * 互斥地跑一次 `loader.reload()` 并紧跟快照 + 删槽。
   *
   * **必须包住 reload 本身**：扩展工厂（claim 点）在 reload 里执行，只包 bindExtensions
   * 包不到 claim。兜底重建装载器的那次 reload 也要走这里——它同样会执行工厂，
   * 后一次快照覆盖前一次（前一份 manager 随被丢弃的装载器一起死掉）。
   * 返回值原样透传 reload 的结果。
   */
  reload<T>(reloadFn: () => Promise<T>): Promise<T>;
  /** 总线报「开始」：触发订阅（先同步试一次，拿不到再按节拍重试） */
  onStarted(agentId: string): void;
  /** 总线报终态：停轮询、退订（缓冲保留给收尾排空） */
  onSettled(agentId: string): void;
  /**
   * 接上**本条活动区间**的合成帧入口：缓冲进账时由它往父事件流里塞一帧，换来一次排空
   * （为什么非要这一下，见文件头「合成帧泵」）。
   *
   * 每条活动区间一份（首轮与每个修正轮各自的流）；接上的那一刻若缓冲已非空就**立刻补一帧**
   * ——那批正文是在「上一条区间已终、这一条还没接」的缝隙里进来的，没人替它排空。
   * 返回解绑函数：区间收尾时摘掉，之后的缓冲进账回到「只写不泵」。
   */
  attachPump(push: () => void): () => void;
  /** 只排空**指定身份**的缓冲（行还没落账的身份留在缓冲里等下一批，事件不重放） */
  drain(agentIds: Iterable<string>): PiSubagentWireDrain;
  /** 本次运行收尾：全部退订、清缓冲（快照条目随本次运行实例一起回收） */
  dispose(): void;
  /** 快照是否拿到了本次运行的 registry 条目（没拿到 = 本次运行退回转写文件通道） */
  readonly available: boolean;
}

/**
 * 造一行用的 wire 通道。**不接日志器**：这一层只交事实，装配面（`index.ts`）按
 * `available` 落它的 WARN——模块本身保持与 `transcript.ts` 同样的纯度。
 */
export function createPiSubagentWire(): PiSubagentWire {
  /** 运行快照到的 registry 条目（最后一次 reload 之后的那份） */
  let entry: PiSubagentManagerEntry | null = null;
  const buffers = new Map<string, WireBuffer>();
  const subscriptions = new Map<string, WireSubscription>();
  /** 已经放弃的身份（轮询到上限 / 订阅抛错）：不再重试，转写文件兜底 */
  const givenUp = new Set<string>();
  /** 已收场的身份（终态后不再重试轮询；缓冲留给收尾排空） */
  const settled = new Set<string>();
  let disposed = false;
  /**
   * 当前活动区间的合成帧入口（`attachPump` 接上 / 摘掉）。区间之间是 `null`——
   * 那段时间里缓冲只进不泵，下一条区间接上时补一帧。
   */
  let pump: (() => void) | null = null;
  /** 已经有一帧在飞、还没被 `drain` 取走：不再叠帧（见文件头「至多一帧在飞」） */
  let tickPending = false;
  /** 节流计时器（挂着的那一发；`dispose` / 摘泵时清掉，免得吊住事件循环） */
  let tickTimer: ReturnType<typeof setTimeout> | null = null;
  /** 上一次真正推出合成帧的时刻（节流基准） */
  let lastTickAt = 0;
  /**
   * 连续「泵了但一条消息都没取出来」的次数，用来给**续泵**封顶。
   *
   * 为什么需要封顶：`drain` 是**选择性**的（只取子任务行已落账的身份），而缓冲里可能
   * 堆着一个**永远不会落账**的身份——派发认领失败（`events.ts` 的 `claimDispatch` 落 WARN
   * 的那一档）时就是这个形状。此时「缓冲非空 ⇒ 再泵一帧」会变成按节拍的永久空转。
   *
   * 封顶放在 2 次之上是因为一次正常的投递**需要两帧**：第一帧让子任务行落账
   * （`deliveredEarlier` 在投影前取快照 ⇒ 那一帧自己取不到），第二帧才真排空。
   * 有新内容进来时计数归零（`absorbEvent`），于是活着的子会话永远泵得动。
   */
  let fruitlessTicks = 0;

  /**
   * 请求一次排空：按节拍推一帧合成帧。
   *
   * 三道闸：已有帧在飞 / 没接泵 / 本次运行已收尾 —— 都只写缓冲不泵。距上一帧不足一个节拍时
   * 挂一发定时器补推（而不是丢掉这次请求）：末尾那几条正文不该因为「来得太快」而等到
   * 父会话的下一个事件。
   */
  const requestTick = (): void => {
    if (disposed || tickPending || pump === null || tickTimer !== null) return;
    if (fruitlessTicks >= PI_SUBAGENT_WIRE_MAX_FRUITLESS_TICKS) return;
    const tickMs = timingsForTesting?.tickMs ?? PI_SUBAGENT_WIRE_TICK_MS;
    const wait = Math.max(0, lastTickAt + tickMs - Date.now());
    const fire = (): void => {
      tickTimer = null;
      // 等待期间可能已被摘泵 / 收尾 / 别处推过一帧：此刻重新判一次，不补发过期的那一下
      if (disposed || tickPending || pump === null) return;
      tickPending = true;
      lastTickAt = Date.now();
      pump();
    };
    if (wait === 0) {
      fire();
      return;
    }
    tickTimer = setTimeout(fire, wait);
    tickTimer.unref?.();
  };

  const bufferOf = (agentId: string): WireBuffer => {
    const existing = buffers.get(agentId);
    if (existing !== undefined) return existing;
    const created: WireBuffer = { entries: [], droppedDeltas: 0, droppedSnapshots: 0 };
    buffers.set(agentId, created);
    return created;
  };

  /**
   * 往缓冲里放一条**已折好的条目**（订阅回调与订阅前的补账共用这一条路）。
   *
   * 三件事的顺序与 `absorbEvent` 的那一段逐字相同：越界先淘汰、再把空转计数归零（有新内容就
   * 该继续泵）、最后请求一次排空。放在一处是为了让「补账进来的历史」与「订阅回调进来的新事件」
   * 在缓冲里**完全同形**——两条路各写一遍必然漂移，而漂移的表现是历史那批不触发排空。
   */
  const pushEntry = (agentId: string, entry: WireBuffer['entries'][number]): void => {
    const buffer = bufferOf(agentId);
    buffer.entries.push(entry);
    if (buffer.entries.length > PI_SUBAGENT_WIRE_BUFFER_MAX) evictOverflow(buffer);
    fruitlessTicks = 0;
    requestTick();
  };

  /**
   * **订阅前的缺口在这里补**：把子会话**已经完成**的消息数组（`session.messages`）折成缓冲条目。
   *
   * 为什么必须有这一下：`subscribe()` 只能收到**订阅之后**的事件，而总线报 `started` 到我们真的
   * 拿到会话句柄之间有一段窗口（`getRecord` 要轮询、假网关或快网关可能已经跑完一轮）——那一段的
   * 助手 / 工具结果事件**不会重放**，此前只能等扩展把转写文件 flush 出来再读（`source: 'session-file'`、
   * 带「补录」角标）。它同时是一条**时序脆弱性**：机器有负载时窗口变宽，界面上的子任务正文会整批
   * 从 wire 掉到转写，而两条通道的实时性不可比（真机守卫因此偶发假红）。
   *
   * 轮次取**绝对序**（助手消息第几条就是第几轮），与 `subscription.round` 的基数、与转写路径的
   * 助手行序三者逐字对齐 ⇒ 同一条消息在两条通道上载体键相同，投影层按「先到者胜出」去重。
   * 拿不到 `messages`（形状不对 / getter 抛）就**不补**：宁可少这一段，也不猜轮次。
   */
  const backfillHistory = (agentId: string, history: readonly unknown[]): void => {
    let round = 0;
    for (const message of history) {
      const record = asRecord(message);
      const role = readString(record, 'role');
      if (role === 'assistant') {
        round += 1;
        pushEntry(agentId, { kind: 'assistant', round, message: record });
        continue;
      }
      if (role !== 'toolResult') continue;
      const toolCallId = readString(record, 'toolCallId');
      // 没有调用 id 就没有合并键的载体，也配不回它的调用块 ⇒ 与转写路径同一条处置：丢掉
      if (toolCallId === null || toolCallId === '') continue;
      pushEntry(agentId, {
        kind: 'tool',
        round: round > 0 ? round : 1,
        event: {
          toolCallId,
          toolName: readString(record, 'toolName'),
          isError: record?.['isError'] === true,
          result: { content: record?.['content'], details: record?.['details'] },
        },
      });
    }
  };

  /** 还有没有没被取走的内容（含越界点名）：续泵与接泵补帧的判据 */
  const hasBuffered = (): boolean => {
    for (const buffer of buffers.values()) {
      if (buffer.entries.length > 0 || buffer.droppedDeltas > 0 || buffer.droppedSnapshots > 0) return true;
    }
    return false;
  };

  /**
   * 订阅一个子会话。**先登记、后订阅**：会话可能在 `subscribe()` 里同步吐出排下的事件
   * （与主会话夹具同一时序），回调此时就要能查到自己的轮次计数器；反过来的顺序会
   * 丢第一批。订阅抛错 ⇒ 撤登记并放弃这一身份（转写兜底，不传染整行）。
   * 方法经 `raw[...]` 属性访问调用——this 绑定在原始实例上（见 `PiSubagentSessionLike`）。
   */
  const attach = (agentId: string, session: PiSubagentSessionLike): void => {
    const messages = readField(session.raw, 'messages');
    const history = Array.isArray(messages) ? (messages as readonly unknown[]) : null;
    const registration: WireSubscription = {
      unsubscribe: () => {},
      round: history === null ? 0 : countAssistantMessages(history),
    };
    try {
      subscriptions.set(agentId, registration);
      /**
       * **先补订阅前的缺口，再订阅**（顺序不可颠倒：补账用绝对轮次，订阅回调从那个基数往下数）。
       * 补进来的条目与新事件在缓冲里同形，排空与去重都只有一条路。
       */
      if (history !== null) backfillHistory(agentId, history);
      // 原地属性访问调用（不能先摘进局部变量——that 会丢 this 绑定，见 PiSubagentSessionLike）
      registration.unsubscribe = (session.raw['subscribe'] as (listener: (event: unknown) => void) => () => void)(
        (event) => absorbEvent(agentId, event),
      );
    } catch {
      subscriptions.delete(agentId);
      givenUp.add(agentId);
    }
  };

  /** 订阅回调的**全部**工作：快照载荷 + 按类型入缓冲。不投影、不发射、不抛。 */
  const absorbEvent = (agentId: string, rawEvent: unknown): void => {
    const subscription = subscriptions.get(agentId);
    if (subscription === undefined) return;
    const record = asRecord(snapshotPiPayload(rawEvent));
    if (record === null) return;
    const type = readString(record, 'type');
    if (type === 'message_end') {
      const message = asRecord(record['message']);
      // 只投影助手收尾：system / user / toolResult 在这条通道里没有增量信息
      // （工具结果的正源是 `tool_execution_end`，两处都投会在同一载体上投两次快照）
      if (readString(message, 'role') !== 'assistant') return;
      // 空内容的助手行也照样占一轮（与转写路径逐字同一条口径）
      subscription.round += 1;
      pushEntry(agentId, { kind: 'assistant', round: subscription.round, message });
      return;
    }
    if (type === 'tool_execution_end') {
      // 工具结果沿用当前轮；一轮都还没有时记 1（轮次从 1 起，与转写路径同一条口径）
      pushEntry(agentId, { kind: 'tool', round: subscription.round > 0 ? subscription.round : 1, event: record });
      return;
    }
    if (type === 'message_update') {
      /**
       * **逐字增量**（子会话与主会话同构的那一格）：子任务节点因此能边产边长字，
       * 而不是整条消息憋到收尾才出现——等待焦虑主要来自这一段。
       *
       * 轮次取**当前轮 + 1**：增量属于那条**还没收尾**的助手消息，而 `round` 只在 `message_end`
       * 才自增 ⇒ 这里不能用当前值（会把增量挂到上一轮已收尾的消息上）。
       * 不在这里自增计数器：同一轮有几十帧增量，自增会让每一帧各占一轮。
       *
       * 归一（含「只认 text_delta / thinking_delta」「空片段丢掉」）在 `piDeltaMessageDraft`
       * 里，这一层只管入缓冲——缓冲里留原始帧，折算一律在排空时做。
       */
      pushEntry(agentId, { kind: 'delta', round: subscription.round + 1, event: record });
      return;
    }
    // 其余帧（块边界、会话级）不入缓冲：没有正文，只会白占一次排空
  };

  /**
   * 轮询直到会话出现 / 收场 / 到放弃上限。**第一次同步试**（真机上 `started` 常常晚于会话
   * 创建，同步那一发就能命中，且让「订阅早于首条事件」成为大概率事实）；重试走计时器，
   * 不阻塞总线回调。放弃上限按**开始时刻**一次性算定——每次重试都重算会把上限推成永远到不了。
   */
  const pollForSession = (agentId: string): void => {
    const manager = entry;
    if (manager === null || disposed || settled.has(agentId) || givenUp.has(agentId)) return;
    const { pollMs, giveUpMs } = timingsForTesting
      ?? { pollMs: PI_SUBAGENT_WIRE_POLL_MS, giveUpMs: PI_SUBAGENT_WIRE_GIVE_UP_MS };
    const deadline = Date.now() + giveUpMs;
    const attempt = (): void => {
      if (disposed || settled.has(agentId) || subscriptions.has(agentId)) return;
      let session: PiSubagentSessionLike | null = null;
      try {
        session = asChildSession(asRecord(manager.getRecord(agentId))?.['session']);
      } catch {
        session = null;
      }
      if (session !== null) {
        attach(agentId, session);
        return;
      }
      if (Date.now() >= deadline) {
        // 放弃是常态之一（spawn 失败的身份永远没有会话）：静默退回转写通道，不点名
        givenUp.add(agentId);
        return;
      }
      const timer = setTimeout(attempt, pollMs);
      timer.unref?.();
    };
    attempt();
  };

  return {
    async reload<T>(reloadFn: () => Promise<T>): Promise<T> {
      const run = async (): Promise<T> => {
        try {
          return await reloadFn();
        } finally {
          /**
           * reload 落定（无论成败）：此刻槽里若有合法条目，必是本次运行工厂挂上的（互斥链保证
           * 上一行已删槽）⇒ 快照进行的、随即删槽。失败的那次也照删——那一行反正要死，
           * 留着槽只会挡住下一行 claim。
           */
          const claimed = readManagerEntry();
          if (claimed !== null) entry = claimed;
          delete (globalThis as Record<symbol, unknown>)[PI_SUBAGENTS_MANAGER_KEY];
        }
      };
      const next = reloadChain.then(run, run);
      reloadChain = next.then(() => undefined, () => undefined);
      return next;
    },
    onStarted: (agentId) => {
      pollForSession(agentId);
    },
    onSettled: (agentId) => {
      settled.add(agentId);
      subscriptions.get(agentId)?.unsubscribe();
    },
    attachPump: (push) => {
      pump = push;
      // 缝隙里进来的那批（上一条区间已终、这一条还没接）此刻才有人能取
      if (hasBuffered()) requestTick();
      return () => {
        if (pump !== push) return;
        pump = null;
        tickPending = false;
        if (tickTimer !== null) {
          clearTimeout(tickTimer);
          tickTimer = null;
        }
      };
    },
    drain: (agentIds) => {
      /**
       * 排空即消旗：这一发合成帧（或父会话自己的事件）已经把缓冲取走了，下一条内容
       * 可以再换一帧。**先清后取**——取的过程里若有新事件进来（订阅回调是同步的），
       * 它那次 `requestTick` 才能排到下一帧，不会被旧旗挡掉。
       */
      tickPending = false;
      const messages: MessageDraft[] = [];
      const warnings: string[] = [];
      for (const agentId of agentIds) {
        const buffer = buffers.get(agentId);
        if (buffer === undefined) continue;
        for (const item of buffer.entries) {
          const draft = foldEntry(item);
          if (draft !== null) messages.push(stampWireDraft(draft, agentId));
        }
        /**
         * 点名**按块形态分两档**：丢快照是真丢正文（权威、不可替代），丢增量只是少了几帧
         * 实时预告（收尾快照一到就整块覆盖 ⇒ 自愈）。合成一句会让排障的人为自愈的那一档
         * 去找不存在的丢数。
         */
        if (buffer.droppedSnapshots > 0) {
          warnings.push(
            `子任务 ${agentId} 的 wire 事件缓冲超过 ${PI_SUBAGENT_WIRE_BUFFER_MAX} 条，`
            + `丢掉了最早的 ${buffer.droppedSnapshots} 条**权威正文**`
            + '（父会话长时间没有事件，子会话还在产流）',
          );
        }
        if (buffer.droppedDeltas > 0) {
          warnings.push(
            `子任务 ${agentId} 的 wire 事件缓冲超过 ${PI_SUBAGENT_WIRE_BUFFER_MAX} 条，`
            + `丢掉了最早的 ${buffer.droppedDeltas} 帧**逐字增量**`
            + '（只影响实时预告的连续性：同一块的收尾快照会覆盖掉累积值，正文不丢）',
          );
        }
        buffer.droppedSnapshots = 0;
        buffer.droppedDeltas = 0;
        buffer.entries.length = 0;
      }
      /**
       * **续泵**：这一发只取走了「已落账身份」那部分，缓冲里还剩别的身份时再约一帧
       * ——它们的子任务行可能正好在这一批里落账（`deliveredEarlier` 是投影前的快照，
       * 本批新落的行要下一帧才看得见）。没有这一句，一次正常投递的第二帧就只能等
       * 父会话的下一个事件，而派发期那个事件根本不存在。
       *
       * 空转封顶（`fruitlessTicks`）在这里记账：这一发一条消息都没取出来就 +1，
       * 连着几发都空就停——缓冲里那位是「永远不会落账的身份」，不该为它按节拍空转。
       */
      if (messages.length === 0 && warnings.length === 0) fruitlessTicks += 1;
      else fruitlessTicks = 0;
      if (hasBuffered()) requestTick();
      return { messages, warnings };
    },
    dispose: () => {
      disposed = true;
      for (const subscription of subscriptions.values()) subscription.unsubscribe();
      subscriptions.clear();
      buffers.clear();
      // 泵与它那发计时器一起收：本次运行已终，再推帧也没有流去接
      pump = null;
      tickPending = false;
      if (tickTimer !== null) {
        clearTimeout(tickTimer);
        tickTimer = null;
      }
    },
    get available(): boolean {
      return entry !== null;
    },
  };
}

/**
 * 一条缓冲项 → 消息草稿（三种载体各走自己的归一函数；折算一律在排空时做，缓冲里留原始帧）。
 *
 * 增量那一支读的是 `assistantMessageEvent`——与主会话 `message_update` 的投影同一个入口
 * （`piDeltaMessageDraft` 自带「只认 text_delta / thinking_delta」「空片段返回 null」两道闸）。
 */
function foldEntry(item: WireBuffer['entries'][number]): MessageDraft | null {
  if (item.kind === 'assistant') return piAssistantMessageDraft(item.message, item.round);
  if (item.kind === 'tool') return piToolResultMessageDraft(item.event, item.round);
  return piDeltaMessageDraft(asRecord(item.event)?.['assistantMessageEvent'], item.round);
}

/**
 * 越界淘汰：**先吃增量，快照垫底**。
 *
 * 为什么不按到达序一刀切：增量与快照的可替代性差一个档。增量只是实时预告（不落盘、且同一块的
 * 收尾快照会整块覆盖掉累积值 ⇒ 丢了自愈），而快照是权威正文——丢一条就真的少一轮，
 * 界面上与「本来就没说」长得一样。子任务话痨时几千帧增量会在到达序里把第 1 轮那条快照顶出去，
 * 正是这条策略要挡的那一档。
 *
 * 实现取「从旧到新扫一遍、只摘增量」；增量摘完还超限才按到达序砍快照（那已经是
 * 「几千轮都没人来取」的病态，点名会升级成权威正文那一档）。
 */
function evictOverflow(buffer: WireBuffer): void {
  let excess = buffer.entries.length - PI_SUBAGENT_WIRE_BUFFER_MAX;
  if (excess <= 0) return;
  const kept: WireBuffer['entries'] = [];
  for (const entry of buffer.entries) {
    if (excess > 0 && entry.kind === 'delta') {
      excess -= 1;
      buffer.droppedDeltas += 1;
      continue;
    }
    kept.push(entry);
  }
  // 增量摘完仍超限：只能动快照（按到达序砍最早的那几条）
  if (excess > 0) {
    kept.splice(0, excess);
    buffer.droppedSnapshots += excess;
  }
  buffer.entries = kept;
}

/**
 * 盖上**子会话的信封**（与 `transcript.ts` 的 `stamp` 同一条口径，仅来源一格不同）：
 * `subagentId` 是界面分桶的键；`raw` 包一层排障身份——这份正文来自哪个子会话的哪条事件，
 * 排障时要能一眼看到。`source` 保持归一函数给出的 `'wire'`——这正是这一层存在的意义。
 */
function stampWireDraft(draft: MessageDraft, agentId: string): MessageDraft {
  return {
    ...draft,
    subagentId: agentId,
    raw: { type: 'pi-subagent-wire', agentId, event: draft.raw },
  };
}
