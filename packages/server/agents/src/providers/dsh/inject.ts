/**
 * dsh 的**人工消息面**（投递两档 + 撤回）：`'idle'` 走 wire、`'round'` 与撤回走进程内插件。
 *
 * 为什么两档要分两条路（判据是厂商那一侧的落点，见 `docs/protocols/dsh.md`）：
 *  · **wire 上只有 `session/prompt` 一条入队面**，它落 `next-turn`（= 这一整轮没活可干了、另起一轮）
 *    ⇒ 正好是契约的 `'idle'` 档，`client.prompt(sessionId, blocks)` 一次调用就够；
 *  · 契约的 `'round'` 档（下一次模型往返之前）在 wire 上**没有**投递面：厂商的
 *    `agent.steer(message)` 落在 `next-step`，而它只在 runtime 进程内可达 ⇒ 与既有
 *    `stream-tap` / 提问应答者同一种成法：**写一支插件进本行的 profile 目录**（overlay `insert`，
 *    相对名按 `<dshHome>` 解析），靠一对文件型 side channel 与父进程来回。
 *
 * 两条 side channel（同一套 JSONL 机制、方向相反，两边各自轮询；与 `ask-user.ts` 同形）：
 *  · **投递流水**（这里写、插件读）：一行一个动作——`{kind:'steer'}` 让插件调 `agent.steer`、
 *    `{kind:'remove'}` 让插件调 `agent.inbox.remove`；
 *  · **收据流水**（插件写、这里读）：`plugin-loaded`（插件加载与 `ctx.agents` 是否可用）、
 *    `steered` / `failed`（那一条到底投出去没有）、`removed`（按身份撤到没有）。
 *
 * 三条跨进程边界（与 ask-user 逐字同源）：
 *  · **身份由端口给**：契约的 `UserMessage.id` 就是「端口这一侧怎么认这一条」，投递与撤回都按它配对。
 *    `'round'` 档那条消息由插件照着这个 id 造（`agent.steer` 与 `inbox.remove` 因此同一个身份）；
 *    `'idle'` 档走 wire，厂商自己铸那条消息的 id ⇒ 撤回闭包负责在两者之间翻译（见块内注释）；
 *  · **撤回只有 `boolean`**：`inbox.remove(id)` 返回「它还在不在待处理队列里」，
 *    分不开「已经被模型吃掉」与「id 不对」。id 由我们保证 ⇒ `false` 读作**已被消费**
 *    （`already-consumed`，竞态里厂商赢的那一支），超时读作 `unknown`；
 *  · **wait 语义不在这里**：投不进去时的等待预算与收场归调用方那一侧的表，本模块只如实回报
 *    「投出去了 / 投失败了」。
 */
import { appendFileSync, readFileSync } from 'node:fs';
import { createLogger } from '@aieval/core';
import type { InjectionBoundary, RetractOutcome } from '@aieval/contracts';
import { asRecord, readString } from '../../json';
import type { InjectionPort } from '../../types';

const logger = createLogger('agents/dsh/inject');

/** 插件本体相对 `configHome` 的落点（overlay 里 `name: "./aieval-inject.mjs"`，同 stream-tap） */
export const DSH_INJECT_PLUGIN_RELATIVE_PATH = 'aieval-inject.mjs';
/** 投递流水（这里写、插件读）相对 `configHome` 的落点 */
export const DSH_INJECT_QUEUE_RELATIVE_PATH = 'aieval-inject-queue.jsonl';
/** 收据流水（插件写、这里读）相对 `configHome` 的落点 */
export const DSH_INJECT_RECEIPTS_RELATIVE_PATH = 'aieval-inject-receipts.jsonl';

/**
 * 插件轮询间隔（毫秒）：一次人工投递的等待以秒计，这个拍子对「发完立刻接着说」足够跟手，
 * 而空转只读一个几 KB 的文件。与 `ask-user.ts` 的桥同量级。
 *
 * ⚠️ **它同时决定了骨架那一格「在等人工消息」的含义**（`turn.ts` 的
 * `INJECTION_WAIT_SUSPENDS_WATCHDOG`）：桥每一拍都会在 `'idle'` 边界取一次件，空手而归是常态，
 * 而骨架把「`'idle'` 边界空手而归」读作「适配器已收工、只剩队列」⇒ **窗口从运行一开始就是开的**。
 * 今天那一格是 `false`（不豁免），所以没有可观测后果；**在没有改取件方式之前不许把它翻成 `true`**——
 * 那等于把整轮的静止超时都关掉（真挂死再也看不出来）。要打开它，先让 `'idle'` 档由
 * 「会话真的空闲」驱动（厂商有 `session.status: idle` 这个信号，适配器已经收得到）。
 */
export const DSH_INJECT_POLL_MS = 20;

/**
 * 一次撤回的最长等待（毫秒）：撤回是「父进程写文件 → 插件读 → `inbox.remove`」两跳，
 * 正常一个来回在毫秒级；等到这个上限就如实回 `unknown`（而不是把一个撤回请求永远挂着）。
 * 它**不是**等待预算——那一条归编排层（端口到点只是「不再等这一条」）。
 */
export const DSH_INJECT_RETRACT_BUDGET_MS = 5_000;

/**
 * 插件源码（整份内联成字符串，运行时落盘）：**不依赖任何包**（只有 node: 内建），
 * 所有路径与厂商对象都防御式收窄，且每一步都包在 try/catch 里——它在厂商 runtime 进程里跑，
 * 任何抛错都可能打断被测运行。
 *
 * 两条与厂商对象打交道的口径：
 *  · **`ctx.agents.get(sessionId)`**（agent 服务）拿那条活会话的 `Agent`；拿不到（进程里还没有
 *    这条会话、或这一版的服务面不同）就回一条 `failed` 收据，由父进程记 ERROR；
 *  · **消息自己造**：厂商的 `createUserMessage` 不住在我们解析得到的包里（插件从 `<dshHome>` 加载，
 *    裸包名解析不到），而 `inbox` / `session` 对它只做 JSON 快照与身份比对 ⇒ 照厂商那一份的
 *    字段逐格写出来（`{id, role, content, source:{kind:'user'}}`）即可，并深冻结成与厂商
 *    `createMessage()` 同一形状。
 */
export const DSH_INJECT_PLUGIN_SOURCE = `// 由 ai-result-evaluation 的 dsh 适配器写入：进程内的人工消息投递面（steer / inbox.remove）。
// 为什么存在：契约的 'round' 档与「撤回已投递」在 wire 上都没有落点——两者都只在 runtime 进程内，
// 只能靠父子进程的文件型 side channel 接出来。
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const POLL_MS = ${DSH_INJECT_POLL_MS};

export default function aievalInject(ctx) {
  const home = process.env.DSH_HOME;
  if (typeof home !== 'string' || home === '') return;
  const queue = join(home, '${DSH_INJECT_QUEUE_RELATIVE_PATH}');
  const receipts = join(home, '${DSH_INJECT_RECEIPTS_RELATIVE_PATH}');
  const record = (row) => {
    try {
      appendFileSync(receipts, JSON.stringify(row) + '\\n');
    } catch {
      // 观测写失败不影响运行：丢一行收据比打断一次运行便宜
    }
  };
  // agent 服务：两条取法都试（ctx.get('agents') 是服务表的通用入口；ctx.agents 是属性式访问）。
  // 两条都拿不到不算致命——收据里如实写 hasAgents: false，投递那一步会回 agent-not-found。
  //
  // *****每次用时现取，不许在加载那一刻缓存*****：插件是 boot 时加载的，而 agents 服务由另一行
  // 插件（dsh-agent）provide —— 加载顺序不保证它在那一刻已经就位（真机实测：加载时取不到、
  // 几步之后就有）。缓存一次就等于把「这一行插件排在哪」变成投递能不能用的前提。
  const agentService = () => {
    try {
      if (ctx !== null && typeof ctx === 'object' && typeof ctx.get === 'function') {
        const viaGet = ctx.get('agents');
        if (viaGet !== null && viaGet !== undefined) return viaGet;
      }
    } catch {
      // 服务没注册：落到下一条取法
    }
    try {
      return ctx !== null && typeof ctx === 'object' ? ctx.agents ?? null : null;
    } catch {
      return null;
    }
  };
  const hasAgents = () => {
    const service = agentService();
    return service !== null && typeof service === 'object' && typeof service.get === 'function';
  };
  const agentFor = (sessionId) => {
    try {
      if (typeof sessionId !== 'string' || sessionId === '') return null;
      const service = agentService();
      if (service === null || typeof service !== 'object' || typeof service.get !== 'function') return null;
      return service.get(sessionId) ?? null;
    } catch {
      return null;
    }
  };
  // 深冻结成与厂商 createMessage() 同一形状（厂商对消息做 JSON 快照与身份比对，不做字段校验）
  const freeze = (value) => {
    if (value !== null && typeof value === 'object') {
      for (const key of Object.keys(value)) freeze(value[key]);
      Object.freeze(value);
    }
    return value;
  };
  const messageOf = (id, text) =>
    freeze({ id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } });
  // 加载收据**先写**：它是「插件到底有没有被厂商加载」的唯一判据，不许被后面任何一步挡住
  record({
    phase: 'plugin-loaded',
    at: Date.now(),
    url: import.meta.url,
    pid: process.pid,
    // 加载那一刻的读数：多半是 false（服务由另一行插件 provide，加载顺序不保证）——它只是事实
    serviceAtLoad: hasAgents()
  });
  let cursor = 0;
  const pump = () => {
    let text;
    try {
      text = readFileSync(queue, 'utf8');
    } catch {
      return;
    }
    // 半截尾行留给下一拍：只处理以换行收尾的那些行
    const end = text.lastIndexOf('\\n');
    if (end === -1) return;
    const lines = text.slice(0, end).split('\\n');
    for (; cursor < lines.length; cursor += 1) {
      const line = lines[cursor];
      if (line.trim() === '') continue;
      let row = null;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      if (row === null || typeof row !== 'object') continue;
      const key = typeof row.key === 'string' ? row.key : null;
      if (key === null) continue;
      /**
       * 这一条到底在干什么：失败收据必须带上它（'steer' / 'remove' / null）。
       *
       * 为什么：父进程对失败的措辞两种动作**相反**——投递失败可以说「这一条不会进模型的上下文」，
       * 撤回失败说同一句就是假话（那一条**可能已经进了**上下文，只是我们撤不回来）。少了这一格，
       * 排障会被引到相反结论，且撤回方要白等到预算到点才知道结果。
       */
      const action = row.kind === 'remove' ? 'remove' : row.kind === 'steer' ? 'steer' : null;
      try {
        const agent = agentFor(row.sessionId);
        if (agent === null) {
          record({ phase: 'failed', key, at: Date.now(), reason: 'agent-not-found', action });
          continue;
        }
        if (row.kind === 'remove') {
          const removed = agent.inbox.remove(row.messageId);
          record({
            phase: 'removed',
            key,
            at: Date.now(),
            messageId: row.messageId,
            removed: removed === true,
            hasAgents: hasAgents()
          });
          continue;
        }
        if (row.kind === 'steer') {
          agent.steer(messageOf(key, typeof row.text === 'string' ? row.text : ''));
          record({
            phase: 'steered',
            key,
            at: Date.now(),
            messageId: key,
            target: 'next-step',
            hasAgents: hasAgents()
          });
          continue;
        }
        record({ phase: 'failed', key, at: Date.now(), reason: 'unknown-kind', action: null });
      } catch (error) {
        record({
          phase: 'failed',
          key,
          at: Date.now(),
          action,
          reason: String(error && error.message ? error.message : error)
        });
      }
    }
  };
  pump();
  const timer = setInterval(pump, POLL_MS);
  // 不让这一拍把 runtime 进程钉住：收尾该由厂商的 shutdown 决定，不由一个旁路定时器决定
  if (typeof timer.unref === 'function') timer.unref();
}
`;

/** 插件侧 `agent.steer` 落的那一档（收据里回写，供排障与判据核对） */
export const DSH_INJECT_STEER_TARGET = 'next-step';

/** 一条收据（插件写、这里读）；字段按 `phase` 分化，未知 phase 一并忽略 */
interface DshInjectReceipt {
  phase: string;
  key: string | null;
  url: string | null;
  removed: boolean;
  reason: string | null;
  hasAgents: boolean;
  /** 失败收据专属：这一条在干什么（`'steer'` 投递 / `'remove'` 撤回 / `null` 认不出） */
  action: string | null;
}

/**
 * 读收据流水里**新出现**的行（坏行跳过：下一拍自然重读）。
 * 只处理以换行收尾的那些行——半截尾行留到下一拍，否则一次读盘会把一条正在写的收据读成坏行。
 */
function readRows(file: string, from: number): { rows: Array<Record<string, unknown>>; cursor: number } {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return { rows: [], cursor: from };
  }
  const end = text.lastIndexOf('\n');
  if (end === -1) return { rows: [], cursor: from };
  const lines = text.slice(0, end).split('\n');
  const rows: Array<Record<string, unknown>> = [];
  for (let index = from; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined || line.trim() === '') continue;
    try {
      const row = asRecord(JSON.parse(line));
      if (row !== null) rows.push(row);
    } catch {
      // 坏行：跳过（流水按行独立，它不影响后面那些行的解析）
    }
  }
  return { rows, cursor: lines.length };
}

function receiptOf(raw: Record<string, unknown>): DshInjectReceipt {
  return {
    phase: readString(raw, 'phase') ?? '',
    key: readString(raw, 'key'),
    url: readString(raw, 'url'),
    removed: raw['removed'] === true,
    reason: readString(raw, 'reason'),
    /**
     * 两行的键名不同、都要认：`plugin-loaded` 行写的是**加载那一刻的快照** `serviceAtLoad`
     * （插件源码里那句「多半是 false，服务由另一行插件 provide、加载顺序不保证」），
     * 而 `steered` 之类的投递行写的是 `hasAgents`（用时现取的读数）。
     * 只认后者会把加载那行恒读成 false —— 那不是事实，是键名不匹配。
     */
    hasAgents: raw['hasAgents'] === true || raw['serviceAtLoad'] === true,
    action: readString(raw, 'action'),
  };
}

/** 插件自报的加载事实（父进程记日志与排障用；`hasAgents` 是「这一版的服务面能不能拿到 Agent」） */
export interface DshInjectPluginLoaded {
  url: string;
  hasAgents: boolean;
}

export interface DshInjectionDriver {
  /** 停机（幂等）：不再取件、不再看新的收据；在飞的一次撤回按预算到点收场 */
  close(): void;
  /** 插件自报的加载事实（还没收到就是 `null`） */
  pluginLoaded(): DshInjectPluginLoaded | null;
}

export interface DshInjectionOptions {
  /** 调用方交进来的**注入端口**（本模块只消费：取件、登记撤回路径、发起撤回） */
  port: InjectionPort;
  /** 本次运行的会话 id：投递流水里的每一行都带上它，插件据此找 `Agent` */
  sessionId: string;
  /** 投递流水（这里写、插件读） */
  queuePath: string;
  /** 收据流水（插件写、这里读） */
  receiptsPath: string;
  /**
   * `'idle'` 档的交付出口 = wire 的 `session/prompt`（由适配器给，因为它要 `harness.client`）。
   * 返回厂商那条消息的 durable 身份——它同时就是撤回时 `inbox.remove` 要的句柄。
   */
  prompt: (text: string) => Promise<string>;
  /** 轮询间隔（毫秒）；缺省 `DSH_INJECT_POLL_MS` */
  pollMs?: number;
  /** 一次撤回的等待上限（毫秒）；缺省 `DSH_INJECT_RETRACT_BUDGET_MS` */
  retractBudgetMs?: number;
}

/**
 * 起一座桥：从端口取件、按档交付，并把插件的收据翻译成端口的登记与撤回结果。
 *
 * 四条口径：
 *  · **两档各走各的路**：`drain('round')` 的条目写投递流水（插件 `agent.steer` → `next-step`）；
 *    `drain('idle')` 的条目直接 `prompt()`（wire → `next-turn`）。先取 `'round'` 再取 `'idle'`
 *    ——契约定的是「`'idle'` 取全部且 `'round'` 在前」，先取走 `'round'` 之后 `'idle'` 自然只剩
 *    它自己那一档；
 *  · **登记撤回路径的时机是「插件说投出去了」**（收据 `steered`），不是「写进流水」——
 *    写进流水只说明我们想投，id 在那一刻还没进厂商的待处理队列；
 *  · **一次一拍、顺序做**：取件、投递、读收据都在同一条串行链上，不会有两拍同时投同一条；
 *  · **循环自身不许抛**：端口契约上不抛（`drain` / `markDelivered` / `retract` 都不抛），
 *    这里兜的是实现缺陷——一次读盘抖动不该让整个人工消息面从此静音。
 */
export function startDshInjection(options: DshInjectionOptions): DshInjectionDriver {
  const pollMs = options.pollMs ?? DSH_INJECT_POLL_MS;
  const budgetMs = options.retractBudgetMs ?? DSH_INJECT_RETRACT_BUDGET_MS;
  let closed = false;
  let wake: (() => void) | null = null;
  /** 收据流水的读游标（行序即到达序） */
  let cursor = 0;
  let loaded: DshInjectPluginLoaded | null = null;
  /** 在飞的撤回：收据配对的键 → 结果回调 */
  const retractions = new Map<string, (outcome: RetractOutcome) => void>();
  /** 撤回键自增：`inbox.remove` 没有回执以外的配对手段，键必须每一条不同 */
  let retractSeq = 0;

  const append = (row: Record<string, unknown>): void => {
    try {
      appendFileSync(options.queuePath, `${JSON.stringify(row)}\n`, { encoding: 'utf8', mode: 0o600 });
    } catch (error) {
      logger.error('投递流水写不进去：这一条投不出去（它还在编排层的表里，等超时收场）', {
        queuePath: options.queuePath,
        entryId: row['key'],
        error,
      });
    }
  };

  /**
   * 登记撤回路径：**同一条消息的撤回只有一条路**——写一行 `remove` 到投递流水，
   * 等插件回一条 `removed` 收据。超时回 `unknown`（说不出为什么），
   * 插件说「不在待处理队列里」回 `already-consumed`（竞态里厂商赢的那一支）。
   */
  const retract = (vendorId: string): Promise<RetractOutcome> =>
    new Promise<RetractOutcome>((resolve) => {
      if (closed) {
        resolve('unknown');
        return;
      }
      retractSeq += 1;
      const key = `aieval-inject-retract-${String(retractSeq)}`;
      const timer = setTimeout(() => {
        retractions.delete(key);
        resolve('unknown');
      }, budgetMs);
      retractions.set(key, (outcome) => {
        clearTimeout(timer);
        retractions.delete(key);
        resolve(outcome);
      });
      append({ key, kind: 'remove', sessionId: options.sessionId, messageId: vendorId });
    });

  /** 收据 → 端口登记 / 撤回结果 */
  const handleReceipt = (receipt: DshInjectReceipt): void => {
    if (receipt.phase === 'plugin-loaded') {
      loaded = { url: receipt.url ?? '', hasAgents: receipt.hasAgents };
      logger.debug('dsh 人工消息插件已加载', { url: loaded.url, hasAgents: loaded.hasAgents });
      return;
    }
    if (receipt.phase === 'steered' && receipt.key !== null) {
      // 身份由我们铸（等于端口那一条的 id）⇒ 撤回句柄此刻就有了，走进程内的 `inbox.remove`
      options.port.markDelivered([receipt.key], retract);
      return;
    }
    if (receipt.phase === 'removed') {
      const settle = receipt.key === null ? undefined : retractions.get(receipt.key);
      settle?.(receipt.removed ? 'retracted' : 'already-consumed');
      return;
    }
    if (receipt.phase === 'failed') {
      /**
       * **撤回失败**与**投递失败**是两件事，措辞与收场都不同：
       *   · 撤回失败（`action: 'remove'`）：那一条**可能已经进了**模型上下文，我们只是撤不回来
       *     ⇒ 在飞的撤回**当场**按 `'unknown'` 结算（不白等到预算到点），文案不许说「不会进上下文」；
       *   · 投递失败（`action: 'steer'` / 认不出）：不假装 `markDelivered`（账本记的是「模型真收到了
       *     什么」），照旧按「这一条不会进模型上下文」记 ERROR。
       * 认不出动作（旧版插件 / `unknown-kind`）沿用投递那套措辞：那是两条里更保守的一条。
       */
      if (receipt.action === 'remove') {
        if (receipt.key !== null) retractions.get(receipt.key)?.('unknown');
        logger.error('dsh 人工消息撤回失败：那一条可能已经进了模型上下文（撤回结果按「未知」结算）', {
          entryId: receipt.key,
          reason: receipt.reason,
          sessionId: options.sessionId,
        });
        return;
      }
      logger.error('dsh 人工消息投递失败：这一条不会进模型的上下文，等编排层按超时收场', {
        entryId: receipt.key,
        reason: receipt.reason,
        sessionId: options.sessionId,
      });
    }
  };

  const drainReceipts = (): void => {
    const read = readRows(options.receiptsPath, cursor);
    cursor = read.cursor;
    for (const raw of read.rows) handleReceipt(receiptOf(raw));
  };

  /** 一个档位的一次取件（顺序做，见上面第三条口径） */
  const deliver = async (boundary: InjectionBoundary): Promise<void> => {
    if (closed) return;
    const items = options.port.drain(boundary);
    for (const item of items) {
      if (boundary === 'round') {
        append({ key: item.id, kind: 'steer', sessionId: options.sessionId, text: item.text });
        continue;
      }
      try {
        const messageId = await options.prompt(item.text);
        /**
         * `'idle'` 档有**两种身份，而它们不是同一个值**（这一档与 `'round'` 的关键差别）：
         *   · 端口那一侧（账本、等待窗口、撤回句柄）认的是**我们的** `UserMessage.id`
         *     ——`markDelivered(ids, …)` 的 `ids` 逐字就是它（契约：`id` 与队列条目的
         *     `messageId` 同值，`markDelivered` / `retract` 按它认人）；
         *   · 厂商的 `agent.inbox.remove` 认的是**它自己**那条消息的 id（wire 回执给的
         *     `{messageId}`，由 `client.prompt` 的返回值交出来）。
         * 两者在 `'round'` 档同值（消息是我们造的、id 由我们铸），在这一档不同值。
         * 所以：**登记交我们的 id**，再交一个记住厂商 id 的撤回闭包把两跳接上——
         * 交厂商 id 的后果是三处静默失真：编排层按 `entry.messageId` 认不出这一条（账本不落、
         * 交付时刻不写、行按等待预算白等到点），而按客户端 id 撤回还会被读成
         * 「从未确认交付」⇒ 判成已撤回，其实模型已经收到了那句话。
         */
        options.port.markDelivered([item.id], () => retract(messageId));
      } catch (error) {
        logger.error('dsh 的 wire 入队失败：这一条不会进模型的上下文', { entryId: item.id, error });
      }
    }
  };

  const sleep = (): Promise<void> =>
    new Promise((resolve) => {
      const timer = setTimeout(() => {
        wake = null;
        resolve();
      }, pollMs);
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });

  const loop = (async (): Promise<void> => {
    while (!closed) {
      drainReceipts();
      if (closed) return;
      await deliver('round');
      await deliver('idle');
      drainReceipts();
      if (closed) return;
      await sleep();
    }
  })();
  void loop.catch((error: unknown) => {
    logger.error('人工消息面的轮询循环异常退出（此后不再取件）', { error });
  });

  return {
    pluginLoaded: () => loaded,
    close(): void {
      if (closed) return;
      closed = true;
      wake?.();
      // 在飞的撤回：桥停了之后就再没有收据了 ⇒ 如实回 `unknown`，不让调用方等到预算到点
      for (const [, settle] of retractions) settle('unknown');
      retractions.clear();
    },
  };
}
