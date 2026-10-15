/**
 * dsh 的**提问应答面**（ask-user）：厂商自己的提问工具照挂，旁边再装一个应答者插件。
 *
 * 为什么应答面必须是一个插件：dsh 的 JSON-RPC 线面上没有「服务端问客户端」那一类（通知四个、请求三个），
 * 提问走的是**进程内**服务——Cordis 的一条 waterfall 监听器 `user-questions/request`
 * （`@deepseek-ai/dsh-user-questions`）：**return 一份 `{answers}` 即认领**、`next()` 即委派，
 * 一个应答者都没有时落到厂商内置的 fail-closed 分支（码 `NO_PROVIDER`）。应答者只能注册在厂商进程里
 * ⇒ 适配器把一个**插件**写进每行的配置根，overlay 里 `insert` 一行指向它（相对名按 `<dshHome>` 解析：
 * 落点与挂载路径与 `stream-tap.ts` 逐字相同，理由见那里的 JSDoc）。
 *
 * 两条 side channel（同一套 JSONL 机制、方向相反，两边各自轮询）：
 *   · **提问流水**（插件写、适配器读）：每收到一问追加一行 `{phase:'request', key, callId, questions, …}`，
 *     认领 / 委派 / 插件加载各追加一行——它是「厂商的提问真的到了我们手里」的唯一证据；
 *   · **答复流水**（适配器写、插件读）：每服务完一问追加一行 `{key, answers}`（或 `{key, delegate:true}`），
 *     插件按 `key` 取**最后一条**配得上的行。
 * 为什么不各自用一个固定文件装一份 JSON：一条提问与一次答复都可能不止一份（模型一轮里问两次、
 * 追问再来一轮），而固定文件只会互相覆盖。追加 + 按 `key` 配对让它天然支持并发。
 *
 * 三条跨进程边界（`signal` / `agent` / `next` 过不去，只有数据过得去）：
 *   · **`key` 取厂商那一侧的 `wait.callId`**——答案要按它配回那次调用，父进程不许自己编一个；
 *     厂商没给（`mode: legacy` 那条路）时才退化成进程内自增的匿名键，且父进程一律交「委派」；
 *   · **等待窗口归厂商的等待档**（见 `index.ts` 的 overlay）：本模块不自己设到点收场，但**认厂商的
 *     `request.signal`**——模型自己给正数 `timeout` 时，厂商到点会 `abort` 这个 signal，那一刻必须
 *     立刻委派（`next()`），让厂商走它自己的 `{pending:true}` 收场；不读 signal 的话那一档永远走不到
 *     （真机：模型要 5 s、人的答复 8 s 才到，工具调用到结果拖了 8031 ms 且交回的是答案而不是 pending）；
 *   · **子智能体发起的提问到不了这里**——厂商的进程内服务在进 waterfall 之前先 `assertLiveRoot`
 *     （不是活着的根就抛 `CALLER_NOT_LIVE` / `DELEGATED_CALLER`，源码逐字：「an owned child has no
 *     human answerer and would block forever」）⇒ 交给提问端口的 `subagentId` 恒 `null`，
 *     本模块不做子智能体判定。
 */
import { appendFileSync, readFileSync } from 'node:fs';
import { createLogger } from '@aieval/core';
import type { AskUserQuestion } from '@aieval/contracts';
import { DEFAULT_ASK_USER_BUDGET_MS, type AskUserPort } from '../../ask-user';
import { asRecord, readString } from '../../json';
import { toolPayloadOf } from '../../tool-payload';
import type { AskUserReply } from '../../types';

const logger = createLogger('agents/dsh/ask-user');

/** 插件本体相对 `configHome` 的落点（overlay 里 `name: "./aieval-ask-answerer.mjs"`，同 stream-tap） */
export const DSH_ASK_ANSWERER_PLUGIN_RELATIVE_PATH = 'aieval-ask-answerer.mjs';
/** 提问流水（插件写、适配器读）相对 `configHome` 的落点 */
export const DSH_ASK_ANSWERER_TRANSCRIPT_RELATIVE_PATH = 'aieval-ask-answerer.jsonl';
/** 答复流水（适配器写、插件读）相对 `configHome` 的落点 */
export const DSH_ASK_ANSWERER_REPLIES_RELATIVE_PATH = 'aieval-ask-replies.jsonl';

/**
 * 模型看到的那个提问工具名（厂商原文；`tool-family.ts` 也认它）。
 * 厂商的提问请求里**不带工具名**（只有问题、调用 id 与等待档）⇒ 这一格只能由适配器补。
 */
export const DSH_ASK_USER_TOOL = 'ask_user_question';

/**
 * `tool-ask-user` 那一行的等待档（overlay 里 `config.timeout`，单位秒）——**两档各自对应
 * 「这一轮有没有人能被问到」**，取值与应答面同源派生（`buildDshRoutePatch` 只按一个自变量选）：
 *
 *   · **挂了应答面**：`timed` + `-1`。厂商源码在 `timeout === -1` 时**回落阻塞档**
 *     （`ctx.userQuestions.ask`）：既不设到点收场，又把 `wait.callId` 带出来——而
 *     `mode: legacy` 那条路调 `ask()` 时**不带调用 id**，答案就配不回那次调用。侧信道的一个来回
 *     也不至于被一个秒级窗口掐掉，等待预算由提问端口那一侧管（编排层落「超时」）。
 *   · **没挂应答面**：`timed` + 有限秒数。阻塞档下没人认领时模型一问就吃一个工具错误
 *     （`no user-questions answerer accepted the request`，码 `NO_PROVIDER`）；定时档到点交回的是
 *     厂商设计好的「待答」结果（`{pending:true, callId, message}`），且秒数是「没人应答时的等待上限」
 *     ——无人值守下等人没有收益，故取 1。
 */
export const DSH_ASK_WAIT_TIMEOUT_ANSWERED_SECONDS = -1;
export const DSH_ASK_WAIT_TIMEOUT_UNANSWERED_SECONDS = 1;

/**
 * 插件等答复的上限（毫秒）：**比提问端口自己那条兜底长**，好让收场由我们这一侧定
 * （编排层到点落「超时」并把答复交回插件），这个窗口只是「父进程那半整个失联」时的最后一道兜底
 * ——到点插件 `next()` 委派，厂商随即以它自己的收场结束那一问，而不是把运行永远挂在一次提问上。
 * 与端口的缺省预算同源派生（端口没有厂商预算时用的就是它），改一处必然要改另一处。
 */
export const DSH_ASK_ANSWERER_WAIT_MS = DEFAULT_ASK_USER_BUDGET_MS + 120_000;

/**
 * 两端的轮询间隔：两侧加起来一个来回约 2 拍。取值与 `stream-tap.ts` 同量级——
 * 一次问答的人工等待以秒计，20ms 的拍子对「答完立刻接着说」足够跟手，而空转只读一个几 KB 的文件。
 */
export const DSH_ASK_ANSWERER_POLL_MS = 20;

/**
 * 插件源码（整份内联成字符串，运行时落盘）：**不依赖任何包**（只有 node: 内建），
 * 所有路径都防御式收窄，且整段包在 try/catch 里——它在厂商 runtime 进程里跑，
 * 任何抛错都可能打断被测运行，观测与应答都不许制造失败（失败一律退成 `next()` 委派）。
 *
 * 认领用的是 waterfall 的 return：**不调 `attachWait`**——那一格一认领就停掉 Host 自己的定时器，
 * 而本适配器要的是「答案由父进程给」这条最朴素的路，等待档留在厂商的工具行上。
 */
export const DSH_ASK_ANSWERER_PLUGIN_SOURCE = `// 由 ai-result-evaluation 的 dsh 适配器写入：进程内提问服务的应答者（文件型双向 side channel）。
// 为什么存在：dsh 的 JSON-RPC 面没有「服务端问客户端」那一类，答案只能从 runtime 进程内的应答者回去。
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export default function aievalAskAnswerer(ctx) {
  const home = process.env.DSH_HOME;
  if (typeof home !== 'string' || home === '') return;
  const transcript = join(home, '${DSH_ASK_ANSWERER_TRANSCRIPT_RELATIVE_PATH}');
  const replies = join(home, '${DSH_ASK_ANSWERER_REPLIES_RELATIVE_PATH}');
  const record = (row) => {
    try {
      appendFileSync(transcript, JSON.stringify(row) + '\\n');
    } catch {
      // 观测写失败不影响运行：丢一行比打断一次运行便宜
    }
  };
  // 答复流水里**最后一条**配得上这个 key 的行（半截行 / 坏行当作还没到，下一拍再读）
  const replyFor = (key) => {
    let text;
    try {
      text = readFileSync(replies, 'utf8');
    } catch {
      return null;
    }
    let found = null;
    for (const line of text.split('\\n')) {
      if (line.trim() === '') continue;
      try {
        const row = JSON.parse(line);
        if (row !== null && typeof row === 'object' && row.key === key) found = row;
      } catch {
        // 半截行：跳过
      }
    }
    return found;
  };
  // url 是「这个相对名按哪个目录解析」的唯一判据（写错落点时插件根本没被加载，见 stream-tap.ts）
  record({ phase: 'plugin-loaded', at: Date.now(), url: import.meta.url, pid: process.pid });
  let anonymous = 0;
  ctx.on('user-questions/request', async (request, next) => {
    let key = null;
    try {
      const wait = request !== null && typeof request === 'object' ? request.wait : null;
      const callId = wait !== null && typeof wait === 'object' && typeof wait.callId === 'string' && wait.callId !== ''
        ? wait.callId
        : null;
      key = callId !== null ? callId : 'anonymous-' + String(process.pid) + '-' + String((anonymous += 1));
      const agent = request !== null && typeof request === 'object' ? request.agent : null;
      const session = agent !== null && typeof agent === 'object' ? agent.session : null;
      record({
        phase: 'request',
        key,
        at: Date.now(),
        callId,
        questions: request !== null && typeof request === 'object' && Array.isArray(request.questions) ? request.questions : [],
        // Agent 是活对象（可能带 getter / 环）⇒ 只抄两格身份，绝不 JSON.stringify 整个 agent
        agentId: agent !== null && typeof agent === 'object' ? agent.id ?? null : null,
        sessionId: session !== null && typeof session === 'object' ? session.id ?? null : null,
        wait: wait ?? null,
        hasSignal: request !== null && typeof request === 'object' && request.signal !== undefined
      });
      // 厂商的等待档到点时会 abort 它（TimedQuestionWait，随 request 一起进 waterfall）。
      // ⚠️ **必须每拍检查**：本模块同步认领、同步阻塞，信号发出后没人读它的话，
      // 那一问会一直挂在插件的返回上 ⇒ 厂商那条 {pending:true} 收场永远走不到
      // （真机：模型要 5 s、人 8 s 才答，工具结果拖到 8031 ms 且交回的是答案）。
      const signal = request !== null && typeof request === 'object' ? request.signal : null;
      const deadline = Date.now() + ${DSH_ASK_ANSWERER_WAIT_MS};
      for (;;) {
        const reply = replyFor(key);
        if (reply !== null) {
          if (Array.isArray(reply.answers)) {
            record({ phase: 'answer', key, at: Date.now() });
            return { answers: reply.answers };
          }
          record({
            phase: 'delegate',
            key,
            at: Date.now(),
            reason: typeof reply.reason === 'string' ? reply.reason : 'unanswered'
          });
          return next();
        }
        if (signal !== null && typeof signal === 'object' && signal.aborted === true) {
          record({ phase: 'delegate', key, at: Date.now(), reason: 'vendor-signal-aborted' });
          return next();
        }
        if (Date.now() >= deadline) {
          record({ phase: 'delegate', key, at: Date.now(), reason: 'answer-timeout' });
          return next();
        }
        await new Promise((resolve) => setTimeout(resolve, ${DSH_ASK_ANSWERER_POLL_MS}));
      }
    } catch (error) {
      record({ phase: 'error', key, at: Date.now(), reason: String(error && error.message ? error.message : error) });
      return next();
    }
  });
}
`;

/**
 * 厂商**进程内服务**的提问项 → 契约的问题形状。
 *
 * 复用族载荷的归一函数：它是唯一知道各家字段名差异的地方。这一格的形状与 `ask_user_question`
 * 的**工具入参**同源（厂商的 `questionRequest()` 逐字段搬过来），只有一处拼写不同——
 * 服务侧是驼峰 `multiSelect`、工具 schema 是蛇形 `multi_select`，而归一函数两种都认
 * （`tool-payload.ts` 的 `questionOf`），故这里不必自己再翻一遍。
 */
export function dshQuestionsOf(questions: readonly unknown[]): AskUserQuestion[] {
  const payload = toolPayloadOf('ask-user', { questions }, 'dsh');
  return payload?.kind === 'ask-user' ? payload.questions : [];
}

/**
 * 答复 → 厂商应答者要的批次：`[{id, selected, custom?}]`，**一题一条、按厂商的问题 id 认领**
 * （契约的答复按 `header` 配对那一问，厂商那一侧要的是它自己的 `id`）。
 *
 * 两处刻意的处置：
 *   · **没有答复的那一题落「跳过」**：厂商把跳过的题定义成 `selected: []` 且不带 `custom`
 *     ——整份答复为空（没人答）走的是另一条路（父进程交「委派」，见 `startDshAskAnswerer`）；
 *   · **`custom` 为 `null` 就不带这个键**：厂商的 `answerResult()` 按 `custom !== undefined` 决定
 *     要不要把它交给模型，而契约的 `null`（没写自己的话）与 `''`（写了但内容为空）是两件事。
 *     `custom` 有值时**原样带着**：多选那一档它是**补充项**（`selected` 与它并存在同一个答复项里，
 *     厂商文档的原话是「supplements a multi-select answer」），单选那一档它是**全部答案**
 *     （界面在单选上禁用选项并交空 `selected`）——两个字段都表达得下，不需要另造形状。
 * ⚠️ 两题共用同一个 `header` 时按 `header` 查表必然配到同一份答案上——这一层不另造配对键，
 * 撞车的提问由提问端口在问人之前整场拦下（`ask-user.ts` 的 `duplicateHeaderOf`），因此到这里的问题
 * 标题两两不同（「厂商没给标题」与「给了空标题」在契约那一格仍不可分，两题都是空串同样算撞车）。
 */
export function dshAnswerBatchOf(reply: AskUserReply, questions: readonly unknown[]): unknown[] {
  const contract = dshQuestionsOf(questions);
  return questions.map((raw, index) => {
    const id = readString(asRecord(raw), 'id') ?? '';
    const answer = reply.answers?.find((one) => one.header === contract[index]?.header);
    if (answer === undefined) return { id, selected: [] };
    return {
      id,
      selected: [...answer.selected],
      ...(answer.custom === null ? {} : { custom: answer.custom }),
    };
  });
}

/**
 * 读一份 JSONL 流水（文件不存在、半截行、坏行一律跳过）。
 * 两份流水都是**按需出现**的（没人提问时文件根本不存在），因此这里不区分「还没写」与「写坏了」：
 * 两种都只意味着「这一拍没有新行」，下一拍自然重读。
 */
function readRows(file: string): Array<Record<string, unknown>> {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const rows: Array<Record<string, unknown>> = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const row = asRecord(JSON.parse(line));
      if (row !== null) rows.push(row);
    } catch {
      // 半截行：跳过
    }
  }
  return rows;
}

/** 应答面的父进程那一半（见模块头） */
export interface DshAskAnswererBridge {
  /**
   * 停机（幂等）：唤醒轮询、不再看新的提问。
   * **不等在飞的那一问**——它的收场归提问端口（行终止 / 预算），而这里等它只会把释放拖到一个
   * 人工等待的时长上（十分钟级）。
   */
  close(): void;
  /**
   * 插件**有没有加载收据**（它 `ctx.on` 之前写的第一行）：`null` = 整轮没等到。
   *
   * 为什么要这个读数：插件没被厂商加载/激活时，这一侧的**所有**出口都是静默的——提问流水
   * 永远是空的（模型的问题落回厂商自己的等待档），而厂商那边只会在它的 stderr 留一行
   * `N entries did not activate`（适配器不读它的 stderr）。收尾据此落一条点名 WARN。
   */
  pluginLoaded(): { url: string } | null;
}

export interface DshAskAnswererOptions {
  /** 提问端口：认领一问就问它一次，答复由它给（等待语义、落盘、看门狗豁免都在它那一侧） */
  port: AskUserPort;
  /** 提问流水（插件写、这里读） */
  transcriptPath: string;
  /** 答复流水（这里写、插件读） */
  repliesPath: string;
  /** 轮询间隔（毫秒）；缺省 `DSH_ASK_ANSWERER_POLL_MS` */
  pollMs?: number;
}

/**
 * 起一个桥：轮询插件写的提问流水，把每一问交给提问端口，再把答复追加回答复流水。
 *
 * 三条口径：
 *   · **一问只服务一次**：游标按「流水里第几条 `phase:'request'`」推进（流水是追加型，
 *     行序就是到达序）⇒ 插件的重复写行、坏行都不会让同一问被问两遍；
 *   · **并发的两问各自服务**：不排队等前一问收场——追加 + 按 `key` 配对本来就不会串答案，
 *     而排队会让第二问在界面上迟迟不出现；
 *   · **循环自身不许抛**：读文件与端口调用都各自兜住（端口契约上不抛，兜的是实现缺陷），
 *     一次读盘抖动不该让应答面从此静音。
 */
export function startDshAskAnswerer(options: DshAskAnswererOptions): DshAskAnswererBridge {
  const pollMs = options.pollMs ?? DSH_ASK_ANSWERER_POLL_MS;
  let closed = false;
  let wake: (() => void) | null = null;

  /** 一拍：到点或被 `close()` 唤醒 */
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

  /** 追加一行答复（整行一次写：插件读到的半截行解析不过就继续等） */
  const reply = (line: Record<string, unknown>): void => {
    try {
      appendFileSync(options.repliesPath, `${JSON.stringify(line)}\n`, { encoding: 'utf8', mode: 0o600 });
    } catch (error) {
      logger.error('答复没能写进 side channel：插件只能等它自己的兜底窗口到点委派', {
        repliesPath: options.repliesPath,
        error,
      });
    }
  };

  const serve = async (row: Record<string, unknown>): Promise<void> => {
    const key = readString(row, 'key');
    const callId = readString(row, 'callId');
    if (key === null) {
      logger.warn('提问流水里有一行没有配对键，答复交不回去', { transcriptPath: options.transcriptPath });
      return;
    }
    /**
     * 没有调用 id 就配不回那次调用（契约要求非空）⇒ 交「委派」：由厂商以它自己的收场结束这一问，
     * 而不是让模型读到一份配不上任何一次调用的答案。`mode: timed` + 阻塞档下这一格不会出现。
     */
    if (callId === null || callId === '') {
      logger.warn('厂商没给调用 id：这一问按「委派」交回（答案配不回那次调用）', { key });
      reply({ key, delegate: true, reason: 'no-call-id' });
      return;
    }
    const questions = Array.isArray(row['questions']) ? row['questions'] : [];
    try {
      const answer = await options.port.ask({
        questions: dshQuestionsOf(questions),
        toolName: DSH_ASK_USER_TOOL,
        callId,
        // 进程内服务自己不设到点收场（等待档在厂商的工具行上，见 index.ts 的 overlay）⇒ 如实 null
        vendorBudgetMs: null,
        // 子智能体的提问到不了应答者（厂商先 `assertLiveRoot`）⇒ 恒 null，见模块头
        subagentId: null,
      });
      if (answer.answers === null) {
        /**
         * 「收场了但没有答案」那几态（等超时 / 随轮次取消 / 通道不可用）：**不编一份空答案**——
         * 厂商的阻塞档对「没人应答」的原生语义就是它自己的 fail-closed 收场，交委派即落到那一支；
         * 而这一问在我们这一侧的收场方式（`outcome`）已经由编排层落进账本与行级事件。
         */
        logger.info('这一问没有答案可回填，按「委派」交回厂商', { callId, outcome: answer.outcome });
        reply({ key, delegate: true, reason: answer.outcome });
        return;
      }
      reply({ key, answers: dshAnswerBatchOf(answer, questions), outcome: answer.outcome });
    } catch (error) {
      // 端口契约上不抛（四条硬规则）——真抛了也不能让这一问永远挂着
      logger.error('提问端口抛错，这一问按「委派」交回厂商', { callId, error });
      reply({ key, delegate: true, reason: 'port-error' });
    }
  };

  const loop = (async (): Promise<void> => {
    /** 已经服务过的提问条数（流水的行序游标，见上面第三条口径） */
    let served = 0;
    while (!closed) {
      const requests = readRows(options.transcriptPath).filter((row) => readString(row, 'phase') === 'request');
      for (; served < requests.length; served += 1) {
        const row = requests[served];
        if (row !== undefined) void serve(row);
      }
      if (closed) return;
      await sleep();
    }
  })();
  void loop.catch((error: unknown) => {
    logger.error('应答面的轮询循环异常退出（此后不再认领新的提问）', { error });
  });

  return {
    /**
     * 判据是**流水里那一行**（不是内存标志）：插件的加载收据是它自己写的第一行，父进程只读流水
     * ⇒ 插件从未加载与「加载了但一行都没写」这两种形状不会混。读盘失败按「没等到」处置。
     */
    pluginLoaded(): { url: string } | null {
      for (const row of readRows(options.transcriptPath)) {
        if (row['phase'] !== 'plugin-loaded') continue;
        const url = readString(row, 'url');
        return { url: url ?? '' };
      }
      return null;
    },
    close(): void {
      if (closed) return;
      closed = true;
      wake?.();
    },
  };
}
