/**
 * 人工消息的**队列表**：人往运行中的一行送的那句话在服务端进程内的唯一真相源，外加端口实现与它的变更信号。
 *
 * 一条记录的命运只有四条：被取件投出去（`queued → delivered`）、被撤回（→ `gone`）、
 * 被候选收场或等待预算丢弃（→ `gone`）、以及被惰性判定成「模型已经看到了」（→ `consumed`）。
 * 四条都走本模块的收口，因此「表里那一格变了」与「消费方看到的事实」永远同时发生。
 *
 * 六格口径（改本模块之前先读完）：
 *
 *   1. **表在进程内、住本包**（与「待答提问」挂起表同形），**只有「变了」的信号总线挂 `globalThis`**：
 *      dev 的 HMR 会重新实例化模块，总线放模块作用域会让「编排层 publish 到旧集合、SSE 订阅新集合」
 *      静默失效（订阅端一个事件都收不到，而两侧日志都正常）。表本身由本模块独占读写，
 *      裂脑只可能发生在模块被重建的那一瞬间，代价是「那一刻的在途消息要重新登记」——
 *      与「重启即无从投递」同一条如实声明的口径。
 *   2. **键是 `runId + candidateId`**：端口要找到「哪一行」的那份状态，而 `@aieval/agents` 里没有行身份
 *      （业务无关），所以端口由编排层实现、在闭包里捕获这一对键，经入参传进去。
 *   3. **`messageId` 是幂等键**：客户端为每一条草稿生成它，服务端以它去重——重复登记回**同一条**
 *      （不新增、不重置状态）。没有它，用户点两次「发送」= 模型看到两遍。
 *   4. **`drain` 只把条目移出可取集合，不改「已交给厂商」那一格**：取件那一刻适配器还没把话交给厂商，
 *      `deliveredAt` 要等它真的交出去（`markDelivered`）才写——`state` 回答「还能不能要回来」，
 *      `deliveredAt` 回答「什么时候真的交出去的」，两者不是同一件事。
 *   5. **不做持续对账**：取件之后一条消息**同时**在我们的表与厂商的队列里，「一条消息只在一个地方」
 *      如实翻译成「我们的表是我们知道的全部，厂商侧只在撤回那一刻读一次」。故 `consumed` 是**惰性判定**。
 *   6. **候选收场与等待预算是两件事**：前者管「这个候选真的结束了，表里剩下的怎么办」，后者管
 *      「适配器已收工、只剩队列时还要等多久」。两者都落 `gone`，但原因不同（见 `settleCandidateReason`
 *      与 `expireWaitReason`）。
 *
 * 两条**时序性质**（如实登记，不是缺陷；界面必须容得下它们）：
 *   · **`'idle'` 档在本轮收场那一刻才登记**：适配器只在「这一整轮没活可干了」时才取这一档
 *     ⇒ 同一条运行内几乎没有「撤回窗口」——刚点发送就发现它已经排队完毕是常态；
 *   · **在途取件的节拍 = 通知边界**：端口只有 `drain` 一格、没有「有新消息」的信号
 *     ⇒ 两次通知之间到达的人话要等到下一格才被取走。**界面上的「排队中」必须容得下这段延迟**，
 *     不要把它渲染成「已送达」。
 *
 * 依赖方向：本模块只认 `@aieval/contracts`（形状）与 `@aieval/agents`（端口的四格契约与 `UserMessage`）。
 */
import type {
  InjectAttachment as ContractInjectAttachment,
  InjectMessage as ContractInjectMessage,
  InjectMessageOutcome,
  InjectionBoundary,
  RetractOutcome,
} from '@aieval/contracts';
import { createLogger } from '@aieval/core';
import type { UserMessage } from '@aieval/agents';

const log = createLogger('inject-queue');

/**
 * 一条附件的**结构化清单**：形状的定义在 `@aieval/contracts`（`InjectAttachmentSchema`），
 * 这里只转出类型。为什么不在本包再写一份接口：同一份清单要在三处出现（队列表、消息账本里的
 * 附件块、快照响应），写三份的话加一格时必有一处漏改，而漏改的症状是那一格在某一面上静默消失。
 *
 * `path` 必须是**绝对路径**（提示词里给模型的就是它，模型据此去读文件）；`bytes` 不在清单里
 * ——大小在拼提示词那一刻按路径现读，登记时那个数既可能过期（文件被换过）也可能算不出来。
 */
export type InjectAttachment = ContractInjectAttachment;

/**
 * 队列表里的一条：形状同样由 `@aieval/contracts` 定义（`InjectMessageSchema`），本包转出类型。
 * `messageId` 同时是幂等键与三处共用的钥匙（表 / 账本 / 候选级事件）。
 */
export type InjectQueueEntry = ContractInjectMessage;

/** 表里的键：一行一份（`runId:candidateId`，与编排层别处那些进程内表的键法同形） */
function queueKey(runId: string, candidateId: string): string {
  return `${runId}:${candidateId}`;
}

/**
 * 服务端写入时刻的 ISO 8601 带时区串（三个时刻格共用的唯一一处口径）。
 *
 * 为什么不留 epoch 毫秒：这三格要落进快照、要给人读、还要与轮上候选上别的时刻（`EvalRun.createdAt`
 * 那一家）并排显示——两种形状并存会让每一条消费路径都得自己知道「这一格是数字」，
 * 界面还要为此并列两个格式化函数。与提问应答面的 `askedAt` 同口径。
 */
function nowIso(): string {
  return new Date().toISOString();
}

/**
 * 变更信号总线（**只有它挂 `globalThis`**，见文件头口径 1）。
 * 负载为空：信号只推「变了，重读」，内容由快照端点给——把内容塞进信号，乱序到达时旧内容会盖掉新内容。
 */
interface InjectQueueBus {
  /** `runId:candidateId` → 该候选的条目数组；插入顺序即登记顺序（取件的先后由它决定） */
  entries: Map<string, InjectQueueEntry[]>;
  /**
   * `runId:candidateId` → `messageId → 撤回句柄`。与条目分开存是**刻意的**：条目是快照面
   * （要能整条交给快照端点），而撤回句柄是一个闭包——把它挂进条目，快照面就会长出一个
   * 序列化不了、也没人该读的格子。
   */
  retractors: Map<string, Map<string, Retractor>>;
  subscribers: Set<() => void>;
}

/** 适配器登记回来的「怎么把这一条从厂商队列里要回来」（厂商差异全在那个闭包里） */
type Retractor = (id: string) => Promise<RetractOutcome>;

const BUS_KEY = '__aievalInjectQueueBus';
type GlobalWithBus = typeof globalThis & { [BUS_KEY]?: InjectQueueBus };
const globalWithBus = globalThis as GlobalWithBus;
globalWithBus[BUS_KEY] ??= { entries: new Map(), retractors: new Map(), subscribers: new Set() };
const bus: InjectQueueBus = globalWithBus[BUS_KEY];

/** 发布一条「这个候选的队列变了」：同步、不落盘、无负载；订阅者抛错只记日志（一个坏订阅者不能打断其余） */
export function publishInjectChanged(): void {
  // 先复制一份再遍历：订阅者在回调里退订是合法用法，遍历原集合会漏掉后续订阅者
  for (const listener of [...bus.subscribers]) {
    try {
      listener();
    } catch (error) {
      // 上下文整份交出去（含 `stack`）：这里要能回答「哪个订阅者、坏在哪一行」，
      // 只留 `message` 的话堆栈在日志里就永久丢了
      log.error('队列变动的订阅者抛错（其余订阅者与登记 / 撤回不受影响）', { error });
    }
  }
}

/** 订阅**后续**的变更信号，返回退订函数（可重复调用）。不回放历史：要当前状态就读 `listInjectEntries` */
export function subscribeInjectChanges(listener: () => void): () => void {
  bus.subscribers.add(listener);

  return () => {
    bus.subscribers.delete(listener);
  };
}

/** 这个候选当前的条目（含终态：`gone` 留在表里正是为了让重复撤回能答「已经处理过了」） */
export function listInjectEntries(runId: string, candidateId: string): InjectQueueEntry[] {
  return bus.entries.get(queueKey(runId, candidateId)) ?? [];
}

/** 这个候选还有没有**没投递**的条目（`queued` 或已取件但还没确认交付）：等待窗口与「不收场」的判据 */
export function hasUndeliveredInjectEntries(runId: string, candidateId: string): boolean {
  return listInjectEntries(runId, candidateId).some((entry) => isUndelivered(entry));
}

/**
 * 「还没交给厂商」的两态：`queued`（还在我们手里）与 `delivered` 且 `deliveredAt === null`
 * （已取件、适配器还没确认厂商收下）。后者不能算已投递——账本记的是「模型真收到了什么」。
 */
export function isUndelivered(entry: InjectQueueEntry): boolean {
  return entry.state === 'queued' || (entry.state === 'delivered' && entry.deliveredAt === null);
}

/**
 * **取件规则**（契约的一半，故意写成纯函数：它是这一面唯一能被独立断言的语义）。
 *
 *   · `'round'`——**只**取要求 `'round'` 的条目（「立即发送」要的就是这一档：下一次模型往返之前投）；
 *   · `'idle'`——取**全部**可取的，其中要求 `'round'` 的**排在前面**（它等得更久）。
 *
 * 只有**未取走**的条目参与（`queued`）：已经交出去过的不再取第二次——那会让模型看到两遍。
 * 顺序取登记顺序（数组序），即「先来先投」。
 */
export function selectForDrain(entries: readonly InjectQueueEntry[], boundary: InjectionBoundary): InjectQueueEntry[] {
  const takeable = entries.filter((entry) => entry.state === 'queued');
  if (boundary === 'round') return takeable.filter((entry) => entry.requires === 'round');
  return [...takeable.filter((entry) => entry.requires === 'round'), ...takeable.filter((entry) => entry.requires === 'idle')];
}

/** 附件清单里的一行（提示词形状的一部分；大小拿不到就不写那一格——**不猜一个数**） */
function attachmentLine(attachment: InjectAttachment, bytes: number | null): string {
  const size = bytes === null ? '' : ` (${formatBytes(bytes)})`;
  return `- ${attachment.path ?? '（没有路径的附件）'}${size}`;
}

/**
 * 人类可读的字节数（提示词里的清单用）。只给一位小数：模型要判断的是「值不值得读」，
 * 精确到字节的数字对它没有任何用处，反而占上下文。
 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * **拼给厂商的那段正文**（编排层拼，适配器原样交出去）：人写的那句话 + 空行 + 附件清单。
 *
 * 三条口径：
 *   · 清单放在那句话**之后**——先给话再给材料，模型读到的顺序与人写的顺序一致；
 *   · 每个候选给**大小**：模型据此判断值不值得去读那几个文件；
 *   · 路径必须是**绝对**的（模型的工作目录是候选工作区，相对路径对它没有意义）。
 *
 * `sizeOf` 由调用方注入（产品侧读盘、用例侧给固定值）：本函数因此是纯的，
 * 「拼出来的形状」这件事可以不碰磁盘就断言。
 */
export function composeInjectedText(
  text: string,
  attachments: readonly InjectAttachment[],
  sizeOf: (path: string) => number | null,
): string {
  const withPath = attachments.filter((attachment) => attachment.path !== null);
  if (withPath.length === 0) return text;
  const lines = withPath.map((attachment) => attachmentLine(attachment, sizeOf(attachment.path!)));
  return `${text}\n\n[附件]\n${lines.join('\n')}`;
}

/** 一次登记的结果：`created` 为 `false` = 这个 `messageId` 已经在表里（幂等命中，回同一条） */
export interface EnqueueInjectResult {
  entry: InjectQueueEntry;
  created: boolean;
}

/** 登记入参：`messageId` 由调用方（客户端）生成，表不自己发号——它同时是幂等键 */
export interface EnqueueInjectInput {
  runId: string;
  candidateId: string;
  messageId: string;
  text: string;
  attachments: readonly InjectAttachment[];
  requires: InjectionBoundary;
}

/**
 * 登记一条人工消息（**唯一的入表口**）。
 *
 * 幂等：同一个 `messageId` 再登记一次 ⇒ 回**同一条**、一个新字段都不改
 * （`created: false`）。改字段比新增更坏——用户点两次「发送」时，第二次提交的内容
 * 会悄悄覆盖第一次已被取走的那一条，而模型看到的是哪一个版本无从追。
 */
export function enqueueInjectMessage(input: EnqueueInjectInput): EnqueueInjectResult {
  const { runId, candidateId, messageId } = input;
  const key = queueKey(runId, candidateId);
  let entries = bus.entries.get(key);
  if (entries === undefined) {
    entries = [];
    bus.entries.set(key, entries);
  }
  const existing = entries.find((entry) => entry.messageId === messageId);
  if (existing !== undefined) return { entry: existing, created: false };

  const entry: InjectQueueEntry = {
    messageId,
    text: input.text,
    attachments: [...input.attachments],
    requires: input.requires,
    state: 'queued',
    createdAt: nowIso(),
    deliveredAt: null,
    settledAt: null,
    outcome: null,
    reason: null,
  };
  entries.push(entry);
  publishInjectChanged();
  return { entry, created: true };
}

/** 「立即发送」的结果：只对**还没取走**的条目可用（交出去之后边界已经用掉了） */
export type PromoteInjectResult = 'promoted' | 'already-round' | 'not-queued' | 'not-found';

/**
 * 「立即发送」：把这一条的 `requires` 由 `'idle'` 改成 `'round'`。
 * **单向**——只能变早不能变晚（把已经要求「立即」的那条改回「排队」会让它比原来更晚到，那不是用户的意图）。
 */
export function promoteInjectEntry(runId: string, candidateId: string, messageId: string): PromoteInjectResult {
  const entry = listInjectEntries(runId, candidateId).find((item) => item.messageId === messageId);
  if (entry === undefined) return 'not-found';
  if (entry.state !== 'queued') return 'not-queued';
  if (entry.requires === 'round') return 'already-round';
  entry.requires = 'round';
  publishInjectChanged();
  return 'promoted';
}

/**
 * 取件（端口的 `drain` 的表侧一半）：把选中的条目移出可取集合。
 *
 * 两条刻意的处置：
 *   · `state` 改成 `'delivered'`（「已交给厂商」那一格），但 **`deliveredAt` 仍是 `null`**——
 *     它是「真的交出去了」的时刻，由 `markInjectEntriesDelivered` 写。于是「取走但没交成」
 *     的那一条既不会被再取一次（不会让模型看到两遍），也仍然是**未投递**（等待窗口与候选收场照旧管它）；
 *   · 交出去的正文用 `composeInjectedText` 拼好（附件清单已在里面）——适配器只认文本，
 *     它不该、也无法自己知道附件在哪。
 */
export function takeInjectEntries(
  runId: string,
  candidateId: string,
  boundary: InjectionBoundary,
  sizeOf: (path: string) => number | null,
): UserMessage[] {
  const selected = selectForDrain(listInjectEntries(runId, candidateId), boundary);
  for (const entry of selected) entry.state = 'delivered';
  if (selected.length > 0) publishInjectChanged();
  return selected.map((entry) => ({ id: entry.messageId, text: composeInjectedText(entry.text, entry.attachments, sizeOf) }));
}

/**
 * 适配器把某几条**真的交给了厂商**（端口的 `markDelivered` 的表侧一半）：
 * 写 `deliveredAt` 并把撤回句柄登记到条目上。
 *
 * 认不出的 id 直接忽略（不抛）：适配器可能交回一个我们表里没有的 id（厂商自己铸的那一条），
 * 那不该让它的收尾路径炸掉——端口契约上 `markDelivered` 不抛。
 */
export function markInjectEntriesDelivered(
  runId: string,
  candidateId: string,
  ids: readonly string[],
  retract: (id: string) => Promise<RetractOutcome>,
): InjectQueueEntry[] {
  const now = nowIso();
  const key = queueKey(runId, candidateId);
  const marked: InjectQueueEntry[] = [];
  for (const id of ids) {
    const entry = listInjectEntries(runId, candidateId).find((item) => item.messageId === id);
    if (entry === undefined || entry.deliveredAt !== null) continue;
    entry.deliveredAt = now;
    let handles = bus.retractors.get(key);
    if (handles === undefined) {
      handles = new Map();
      bus.retractors.set(key, handles);
    }
    handles.set(id, retract);
    marked.push(entry);
  }
  if (marked.length > 0) publishInjectChanged();
  return marked;
}

/**
 * 撤回一条（`queued` ⇒ 直接摘掉；`delivered` ⇒ 走这一条登记回来的句柄；`consumed` ⇒ 明确拒绝）。
 *
 * 结果与端点的三个错误码一一对应，但**本层不抛**：HTTP 那一层按 `kind` 映射状态码
 * （`gone` ⇒ 200 + 已经处理过、`not-found` ⇒ 404、`consumed` ⇒ 409）。
 * **成功的撤回（含「本来就是 queued」那一支）落 `gone`** 而不是从表里删掉：
 * 重复撤回要看得出「这一条已经处理过」，删掉就只剩 404，而客户端那两种动作是相反的。
 */
export type InjectRetractResult =
  | { kind: 'removed'; entry: InjectQueueEntry }
  | { kind: 'retracted'; entry: InjectQueueEntry }
  | { kind: 'consumed'; entry: InjectQueueEntry }
  | { kind: 'gone'; entry: InjectQueueEntry }
  | { kind: 'unsupported'; entry: InjectQueueEntry }
  | { kind: 'unknown'; entry: InjectQueueEntry }
  | { kind: 'not-found' };

export async function retractInjectEntry(runId: string, candidateId: string, messageId: string): Promise<InjectRetractResult> {
  const entry = listInjectEntries(runId, candidateId).find((item) => item.messageId === messageId);
  if (entry === undefined) return { kind: 'not-found' };
  if (entry.state === 'gone') return { kind: 'gone', entry };
  if (entry.state === 'consumed') return { kind: 'consumed', entry };
  // 我们自己手里那一条：直接摘掉，不问厂商（它还不知道有这条消息）
  if (entry.state === 'queued') {
    settleInjectEntry(runId, candidateId, entry, 'retracted', null);
    return { kind: 'removed', entry };
  }
  const retract = bus.retractors.get(queueKey(runId, candidateId))?.get(messageId);
  if (retract === undefined) {
    // 取走但从未确认交付（适配器投递失败）：厂商那一侧没有它，撤不撤得掉都由我们说 —— 摘掉即可
    settleInjectEntry(runId, candidateId, entry, 'retracted', null);
    return { kind: 'removed', entry };
  }
  const outcome = await retract(entry.messageId);
  if (outcome === 'retracted') {
    settleInjectEntry(runId, candidateId, entry, 'retracted', null);
    return { kind: 'retracted', entry };
  }
  if (outcome === 'already-consumed') {
    // 竞态里厂商赢：**如实**落「已经被模型看到了」——不许乐观出队（那会让用户以为撤干净了）
    settleInjectEntry(runId, candidateId, entry, 'already-consumed', '这一条已经交给智能体了，撤不回来');
    return { kind: 'consumed', entry };
  }
  // `unsupported` / `unknown`：什么都没改变，那一条留在 `delivered` 上等下一次机会
  return { kind: outcome === 'unsupported' ? 'unsupported' : 'unknown', entry };
}

/**
 * 把一条落终态（幂等：已经是 `gone` / `consumed` 的不再动）。**唯一的状态收口**，
 * 因此「表里那一格变了」「撤回句柄被摘掉」与「信号发出去了」永远同时发生。
 */
export function settleInjectEntry(
  runId: string,
  candidateId: string,
  entry: InjectQueueEntry,
  outcome: InjectMessageOutcome,
  reason: string | null,
): void {
  if (entry.state === 'gone' || entry.state === 'consumed') return;
  entry.state = outcome === 'already-consumed' ? 'consumed' : 'gone';
  entry.outcome = outcome;
  entry.reason = reason;
  entry.settledAt = nowIso();
  bus.retractors.get(queueKey(runId, candidateId))?.delete(entry.messageId);
  publishInjectChanged();
}

/**
 * 候选收场：把这个候选**所有还没投递的**条目落 `gone`（原因 `discarded`）并清表，
 * 返回被丢弃的那些（调用方据此各落一条候选级事件）。
 *
 * 为什么连已投递的条目一起清表：这个候选已经结束了，厂商那边还会不会把它交给模型与我们已经无关，
 * 留着只会让下一轮读取到上一轮的幽灵条目（候选 id 在重跑时复用）。
 */
export function discardUndeliveredInjectEntries(runId: string, candidateId: string): InjectQueueEntry[] {
  const key = queueKey(runId, candidateId);
  const entries = bus.entries.get(key);
  if (entries === undefined) return [];
  const discarded = entries.filter((entry) => isUndelivered(entry));
  for (const entry of discarded) settleInjectEntry(runId, candidateId, entry, 'discarded', '这个候选已经结束，这条消息没能交给智能体');
  bus.entries.delete(key);
  bus.retractors.delete(key);
  publishInjectChanged();
  return discarded;
}

/**
 * 等待预算到点：把这个候选**还没投递的**条目落 `gone`（原因 `timed-out`），返回它们。
 *
 * 与候选收场分开的**唯一**区别就是原因与人话：界面上「这个候选结束了」与「这一条等太久了」
 * 是两句不同的话，而读侧只有这一格能分开它们。终态（已撤回 / 已被吃掉）的条目不动。
 */
export function expireUndeliveredInjectEntries(runId: string, candidateId: string): InjectQueueEntry[] {
  const expired = listInjectEntries(runId, candidateId).filter((entry) => isUndelivered(entry));
  for (const entry of expired) settleInjectEntry(runId, candidateId, entry, 'timed-out', '等太久了，这一条没能交给智能体');
  return expired;
}

/**
 * **仅供用例**：清空全表与所有订阅者，并卸掉等待窗口。
 *
 * 为什么需要它：表挂在 `globalThis` 的那份总线里（口径 1），于是它**跨用例、跨测试文件**活下来——
 * 上一条用例留下的条目会让下一条的快照断言多一条，上一条登记过的 `messageId`
 * 会让下一条同名 id 的登记变成幂等命中。`NODE_ENV` 闸与既有 `resetAskUserForTesting` 同一条理由：
 * 它是测试脚手架，不是产品入口（产品侧清表等于把在等的用户丢下）。
 */
export function resetInjectQueueForTesting(): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('resetInjectQueueForTesting 只能用在用例里（它会清掉还没投递的消息）');
  }
  bus.entries.clear();
  bus.retractors.clear();
  bus.subscribers.clear();
}
