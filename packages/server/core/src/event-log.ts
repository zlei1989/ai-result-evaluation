/**
 * 每候选行的事件日志（`events.jsonl`）：追加 / 全量读 / 按 seq 续订 / 清空。
 * 四个必须成立的口径：
 *   1. `seq` 由**本模块**分配（文件里已有的最大 seq + 1，从 1 开始）：单调递增是 SSE
 *      `Last-Event-ID` 续订与前端去重的唯一依据，交给调用方自己发号必然重号；
 *   2. 追加用 `appendFileSync`（O_APPEND 语义）：Node 是单线程事件循环，本模块同步写盘，
 *      同一进程里的并发调用天然串行；事件日志不做跨进程写（§11 R6）；
 *   3. 坏行只跳过该行并 WARN，绝不让整段历史消失——JSONL 的意义就是「一行坏了不牵连别人」；
 *      schema 校验也放在读取侧（`AgentEventSchema.safeParse`），让手工编辑出来的脏数据可见；
 *   4. 文件不存在一律当空日志（读返回 `[]`，清空是 no-op）：评测还没跑过的行也要能打开抽屉。
 * 读写两侧的校验**都要有，且职责不同**（§11 R26）：读侧容忍是为了「一行坏不牵连别人」，写侧必须拒绝——
 * `events.jsonl` 是本阶段的唯一真相源，写进去一条不符合契约的事件（p3/p4 的形状漂移、NaN 之类
 * JSON.stringify 会改写成 null 的载荷），读侧会**静默丢掉那一行**：抽屉、`/log` 与 SSE 回放里
 * 这条事件凭空消失，而磁盘上却有它。故写入点直接抛中文 `ServiceError`，让坏数据在这里就暴露。
 * 与计划里的实现块有一处**有意**不同：发号用的最大 seq 取自 `maxSeqInFile`（「能解析出数字
 * `seq` 的行」），不是 `readEvents` 的返回值。理由是口径 3 与口径 1 在这里会打架——
 * 「合法 JSON 但不符合 schema」的行同样占着一个 seq 号，拿合格事件的最大 seq 发号就会与它重号。
 * 详见 maxSeqInFile 的注释。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { AgentEventSchema, ServiceError, type AgentEvent } from '@aieval/contracts';
import { createLogger } from './logger';

const log = createLogger('event-log');

/**
 * 待写入的事件：`AgentEvent` 是**判别联合**，直接用 `Omit<AgentEvent, 'seq' | 'at'>` 不会分配到各成员——
 * `keyof (A | B)` 只留公共键，类型被压成 `{ type: 'status' | 'log' | … } & { at?: string }`，
 * 于是 `appendEvent(file, { type: 'log', stream: 'stdout', text })` 这种字面量会因**多余属性**（TS2353）
 * 编译失败——而它正是 p4 唯一的调用形态，`pnpm typecheck` 会直接红。
 * 分配式 Omit 让每个联合成员各自被 Omit，成员自己的字段（stream / text / tokens / exitReason …）得以保留。
 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export type PendingAgentEvent = DistributiveOmit<AgentEvent, 'seq' | 'at'> & { at?: string };

/**
 * 追加一条事件并写入 events.jsonl（seq 由本模块按文件已有最大 seq + 1 分配），返回写入的完整事件。
 * `at` 缺省时补 `new Date().toISOString()`（ISO 8601 带时区，与全仓口径一致）。
 * **为什么不去读 `readEvents` 的最大值**（§11 R24，计划里的实现块就是这么写的，实测过不了它自己的用例）：
 * `readEvents` 按契约把「合法 JSON 但不符合 schema」的行丢掉，可那一行**已经占着它的 seq 号**——
 * 按「合格事件的最大 seq」发号，新事件就与磁盘上已有的一个 seq 重号；客户端拿着 `Last-Event-ID: 3`
 * 重连时，重复的那条会被前端去重悄悄丢掉（spec §7.4 要求「每行一个带单调序号的事件」、§8 按 `seq`
 * 续订）。故发号只看「这一行能不能解析出数字 `seq`」（`maxSeqInFile`，且不 WARN），与读取侧的
 * schema 过滤是两件事：前者问的是「这个号被占用过没有」，后者问的是「这条事件能不能用」。
 * 每次追加都要读一遍已有文件来定 seq：这是 O(n)/条的，但换来的是「进程重启后继续追加不重号」这个必要性质——
 * 内存里缓存计数器会让重启后的第一条重号。
 * 已记录的性能注记（p4 提出，本阶段不改）：一行的事件数到几千时，累计写入会退化成 O(n²)。
 * 真到那一步的修法是「按文件缓存 max seq + 比对文件字节数，长度不符才回读」——既保住不重号，
 * 又不牺牲正确性；本阶段先保正确，因为一轮评测的事件量还在几百量级。
 */
export function appendEvent(file: string, event: PendingAgentEvent): AgentEvent {
  const full: unknown = { ...event, seq: maxSeqInFile(file) + 1, at: event.at ?? new Date().toISOString() };

  // 写侧校验（文件头「读写两侧的校验都要有，且职责不同」）：唯一真相源不能写坏数据——
  // 坏数据的表现不是「报错」而是「静默消失」，即读侧的 schema 过滤把它丢掉
  //（抽屉 / `/log` / SSE 回放里都没有它），磁盘上却留着一行谁也读不到的 JSON。
  // 为什么抛 INTERNAL 而不是别的 code：这不是用户输入的问题（p4 用的是类型正确的对象字面量），
  // 而是我们自己的形状漂移，属于「本不该发生」的内部错误。
  const parsed = AgentEventSchema.safeParse(full);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue === undefined || issue.path.length === 0 ? '（根对象）' : issue.path.join('.');
    throw new ServiceError(
      'INTERNAL',
      `事件写入被拒绝：字段「${path}」不符合事件契约（唯一真相源不写坏数据，否则读取侧会静默丢弃这条事件）`,
      { cause: parsed.error, context: { file, path, issue: issue?.message } },
    );
  }

  mkdirSync(join(file, '..'), { recursive: true });
  // 落盘的是校验后的对象（而不是 full）：保证磁盘上那一行一定能被读侧的同一份 schema 读回来
  appendFileSync(file, `${JSON.stringify(parsed.data)}\n`, 'utf8');
  return parsed.data;
}

/** 读全量（抽屉首帧 + 下载）；文件不存在返回 [] */
export function readEvents(file: string): AgentEvent[] {
  return parseLines(file, 0);
}

/** 只读 seq > afterSeq 的部分（SSE 按 Last-Event-ID 续订） */
export function readEventsAfter(file: string, afterSeq: number): AgentEvent[] {
  return parseLines(file, afterSeq);
}

/** 清空该行的事件日志（重跑同一行前调用，避免新旧事件混在一个文件里） */
export function resetEvents(file: string): void {
  if (!existsSync(file)) return;
  // 删文件而不是写空串：下一次 appendEvent 会重新建，seq 自然从 1 开始
  rmSync(file, { force: true });
  log.info('事件日志已清空', { file });
}

/**
 * 逐行解析并校验，跳过 afterSeq 之前的、空行的、坏 JSON 的与不符合 schema 的行。
 * 坏行只 WARN 不抛：日志抽屉的可用性优先于数据完备性——一行写坏不该让整段历史打不开。
 */
function parseLines(file: string, afterSeq: number): AgentEvent[] {
  if (!existsSync(file)) return [];
  // 容忍 UTF-8 BOM：外部工具（PowerShell 5.1）编辑过的文件首行会带 U+FEFF，JSON.parse 直接抛
  const text = readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  const events: AgentEvent[] = [];

  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      log.warn('事件日志有一行不是合法 JSON，已跳过', { file, line: line.slice(0, 200) });
      continue;
    }
    const result = AgentEventSchema.safeParse(parsed);
    if (!result.success) {
      log.warn('事件日志有一行不符合事件契约，已跳过', { file, line: line.slice(0, 200) });
      continue;
    }
    if (result.data.seq > afterSeq) events.push(result.data);
  }

  return events;
}

/**
 * 文件里**已用过**的最大 seq：逐行 `JSON.parse`，只认数字型 `seq`，解析不出来的行静默跳过。
 * 为什么不能复用 `readEvents` 来发号（计划里的实现块就是这么写的，实测过不了它自己的用例）：
 * `readEvents` 会把「合法 JSON 但不符合事件 schema」的行丢掉，可那样的行（手工改坏的旧事件、
 * 缺字段的历史事件）**已经占着一个 seq 号**——按「合格事件的最大 seq」发号，新事件就与它重号，
 * 而重号是前端去重与 `Last-Event-ID` 续订唯一不能容忍的事（文件头口径 1）。用例里那条
 * `{seq:3, type:'log', stream:'stdout'}`（缺 text）之后追加的事件必须拿到 seq 4 而不是 2。
 * 为什么坏行在这里**静默**：坏行由读取侧报一次就够；追加路径也 WARN 的话，每写一条事件都会把
 * 整段历史里的坏行重报一遍——用例据此断言「读一次日志恰好 2 条 WARN」。
 */
function maxSeqInFile(file: string): number {
  if (!existsSync(file)) return 0;
  // BOM 与空行的处理必须与 parseLines 一致，否则同一个文件在两处会被切成不同的行
  const text = readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  let max = 0;
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const seq = (parsed as { seq?: unknown }).seq;
    // 接受口径必须与 agent-event 契约一致（`z.number().int().positive()`），而不是「是个有限数就行」：
    // 手工编辑出的 `{"seq":1.5}`（或 0 / 负数）一旦被当成已用号，之后**每一条**事件的 seq 都会被
    // 抬成非整数，于是 readEvents 的 schema 校验把它们全部丢掉——日志从此静默停止记录
    // （唯一真相源失效，界面上却什么错都看不到），这正是 R24 要堵的那类静默失败。
    if (typeof seq === 'number' && Number.isInteger(seq) && seq > 0 && seq > max) max = seq;
  }
  return max;
}
