/**
 * dsh 的**真路径驱动器**：真运行时 + 叠加配置把路由指向本机假上游 + 我们的应答者插件。
 *
 * 这一份存在的理由（也是它与「夹具扮演端口」那一档的根本差别）：那一档把适配器将来那一格
 * ——「厂商问了 ⇒ 拿提问端口问一次 ⇒ 把答复装成该家的应答形状」放在夹具里，于是它**证不到**
 * 「厂商的提问请求真的到了我们手里」与「我们的答复真的回到了厂商」。这里厂商那一侧全是真的：
 * 真 dsh 运行时起起来、模型那一问真的走厂商自己的进程内提问服务、我们的插件真的被
 * `user-questions/request` 这条 waterfall 派发到、答复真的变成厂商的工具结果。
 * 我们只换掉**上游那个模型**（本机假 `/v1/messages` 按剧本回一帧提问工具的 `tool_use`）。
 *
 * **夹具一件都不替适配器做**：应答面那两半都在产品里（`providers/dsh/ask-user.ts`）——插件本体由
 * 适配器落进 `<configHome>` 根、overlay 里那一行与等待档只在这一轮挂了应答面时才有、父进程那一半
 * （认领那一问 + 把答复写回答复流水）由适配器的桥承担。本驱动器只**读**两份流水，不写任何一边：
 * 于是「厂商的请求真的到了我们手里」与「我们的答复真的交回了厂商」这两条事实都不是夹具自述。
 *
 * 唯一的一处注入是**把别的注入清掉**（`setAgentRuntimeForTesting(null)`）：同一份套件里前面那些场景
 * 注入的是假 SDK，而这里要的是真模块本身——不清就等于「真路径」跑在假件上。
 *
 * 三条口径：
 *   · **上游模型是假的**：这里证的是「厂商的通道与工具是真的」，不是「真模型会自发提问」，
 *     后者只在真机冒烟里看（见 `askUserProofDriver` 的声明注释）；
 *   · **两臂只差应答面那一格**：同一条剧本、同一份路由各跑一次；没有回调那一臂**不挂应答者**
 *     （这才是不问就不动在本地的落点），于是那一问落到厂商自己的**定时档**收场上。
 *   · **等待上限按「宁可超时也不假红」定**：驱动器自己的墙钟是这一层唯一的兜底——插件等答复的
 *     窗口比它长（产品的窗口 = 端口缺省预算 + 两分钟，见 `ask-user.ts`），所以「答复没交回去」
 *     的表现是**墙钟到点 + 那一问落厂商自己的收场**（可读的红），而不是整份用例永远挂着。
 *   · **计量快照的重复投送在收口时折成一条**（见 `foldRepeatedUsage`）：厂商在收尾那条通知上
 *     把最新一份累计计量再交一次，而**它到底有没有在收尾前被读到是竞态**（实测同一条脚本、
 *     同一臂四次运行的事件条数是 24 / 24 / 25 / 25）⇒ 不折叠的话，产物条数与两臂指纹都成了
 *     掷骰子。这一条是**证据收集口径**，写在驱动器里；适配器那一侧的根因（收尾与在飞的
 *     `next()` 之间没有屏障）不在本驱动器的射程内。
 *
 * 本模块只被 `*.test.ts` import（与 `agent-fixtures.ts` 同一条口径）。
 */
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentEvent, AgentMessage, InjectionBoundary, RetractOutcome } from '@aieval/contracts';
import { setAgentRuntimeForTesting } from '../runtime';
import type { AskUserReply, AskUserRequest, InjectionPort, UserMessage } from '../types';
import {
  DSH_ASK_ANSWERER_REPLIES_RELATIVE_PATH,
  DSH_ASK_ANSWERER_TRANSCRIPT_RELATIVE_PATH,
} from '../providers/dsh/ask-user';
import { DSH_INJECT_RECEIPTS_RELATIVE_PATH } from '../providers/dsh/inject';
import { dshProvider } from '../providers/dsh';
import type { ConformanceProduct } from '../providers/conformance/kit';
import { collectEvents, createRunInput } from './agent-fixtures';
import { removeTreeWithRetry } from './cleanup';

/** 上游模型名：模型那一侧是假的，这个名字只决定请求体里的一个字符串 */
export const DSH_REAL_PATH_MODEL = 'real-path-model';

/** 脚本式上游要的凭据：占位串即可（请求根本不出本机） */
const PLACEHOLDER_KEY = 'real-path-placeholder-not-a-secret';

/**
 * 一次真路径运行的墙钟上限（毫秒）。给足的理由：厂商运行时冷启动 + 两次上游往返 + 收尾，
 * 量级在秒级，而机器带负载时进程创建会慢一个数量级。**到点按失败收场**——上限的作用是把
 * 「挂死」变成一条可读的红，不是把慢读成不同意（口径：宁可超时也不假红）。
 */
export const DSH_REAL_PATH_TIMEOUT_MS = 180_000;

/** 观测两套流水的轮询间隔：一次问答的人工等待以秒计，这个拍子对「答完立刻接着说」足够跟手 */
const POLL_MS = 20;

/** 假上游的落点与它收到的入站请求（`body` 是解析后的请求体，判据从它读工具结果） */
export interface DshScriptedUpstream {
  url: string;
  records: Record<string, unknown>[];
  close: () => void;
}

/** 一条 SSE 响应（`event: …\ndata: …` 两行一组） */
function sseOf(events: ReadonlyArray<readonly [string, unknown]>): string {
  return events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');
}

/** 一轮纯文本收尾——剧本的第二轮之后全是它 */
function textTurn(text: string): string {
  return sseOf([
    ['message_start', { type: 'message_start', message: { id: 'msg_text', type: 'message', role: 'assistant', model: DSH_REAL_PATH_MODEL, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 4, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 4 } }],
    ['message_stop', { type: 'message_stop' }],
  ]);
}

/**
 * 一轮工具调用（`stop_reason: 'tool_use'`）——剧本的第一轮，逼运行时真的去执行那个工具。
 * 入参用 `input_json_delta` 分片下发（与真上游同形：整份 `input` 只在 `content_block_start`
 * 上给空对象，实体走增量），少了这一段客户端会拿不到入参。
 */
function toolTurn(callId: string, toolName: string, input: unknown): string {
  return sseOf([
    ['message_start', { type: 'message_start', message: { id: `msg_${callId}`, type: 'message', role: 'assistant', model: DSH_REAL_PATH_MODEL, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 4, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: callId, name: toolName, input: {} } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 7 } }],
    ['message_stop', { type: 'message_stop' }],
  ]);
}

/**
 * 起一台脚本式上游：**第一条带工具表的 `/v1/messages` 请求**回一帧提问工具的 `tool_use`，
 * 其余一律回纯文本收尾。
 *
 * 判据是「带工具表的第一条」而不是「第几条」：运行时在会话建立前后会打几条不带工具表的请求
 * （探活、模型目录），按序号数会让剧本错位——错位的表现是「提问没发生」，而那是假红。
 */
export async function startDshScriptedUpstream(options: {
  /** 那一帧提问工具调用的 id（厂商把它当 `toolCallId`，也是答案要配上的那个 id） */
  callId: string;
  /** 提问工具名（厂商原文；驱动器用它判「这一条请求带没带那件工具」） */
  toolName: string;
  /** 提问工具的入参（厂商方言，逐个字段照厂商 schema 给） */
  args: unknown;
  /** 收尾那几轮的正文（`finalText` 的来源） */
  finalText: string;
  /**
   * 第一条带工具表的请求**压住多久再回**（毫秒）。
   *
   * 为什么需要这一格：人工消息要投进「一轮在途」里才有判据——压住这一条就给出一个确定的窗口
   * （`'round'` 档的 steer 落在下一次 step 边界、`'idle'` 档的 followup 落在下一轮）。
   * 缺省 0 = 立刻回（既有那一臂的行为逐字不变）。
   */
  holdMs?: number;
}): Promise<DshScriptedUpstream> {
  const records: Record<string, unknown>[] = [];
  let asked = false;
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: Record<string, unknown> = {};
      try {
        body = raw === '' ? {} : (JSON.parse(raw) as Record<string, unknown>);
      } catch {
        // 解析不了就按空体处置：这一条不是我们要读的那一类（判据读的是 JSON 体）
      }
      records.push({ url: request.url ?? '', body });
      const tools = Array.isArray(body['tools']) ? (body['tools'] as Array<{ name?: unknown }>) : [];
      const shouldAsk = !asked && tools.some((tool) => tool?.name === options.toolName);
      if (shouldAsk) asked = true;
      const reply = (): void => {
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        response.end(shouldAsk ? toolTurn(options.callId, options.toolName, options.args) : textTurn(options.finalText));
      };
      const hold = shouldAsk ? options.holdMs ?? 0 : 0;
      if (hold > 0) setTimeout(reply, hold);
      else reply();
    });
  });
  server.unref();
  const url = await new Promise<string>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve(`http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}`);
    });
  });
  return { url, records, close: () => server.close() };
}

/** 厂商派发到应答者手里的那一问原文（判据读它核对字段名与等待档） */
export interface DshAskRecord {
  questions: VendorQuestion[];
  callId: string | null;
  wait: unknown;
}

/** 厂商的提问项（只声明本驱动器要读的字段，不引厂商类型） */
interface VendorQuestion {
  id: string;
  question: string;
  header?: string;
  options?: Array<{ label?: string; description?: string | null }> | null;
  multiSelect?: boolean;
}

/** 一次真路径运行的产物 */
export interface DshRealPathRun {
  product: ConformanceProduct;
  /** 这一次运行的假上游（判据从它的 `records` 读出站请求里的工具结果） */
  upstream: DshScriptedUpstream;
  /** 应答面被问了几次（**提问那一次**） */
  askCalls: number;
  /** 应答面收到的入参（按调用顺序）——它证明提问真的到了我们这一侧 */
  requests: AskUserRequest[];
  /** 厂商派发出来的那一问原文（按到达顺序，读自插件写的 sidecar） */
  askRecords: DshAskRecord[];
  /** 适配器写回答复流水的**答案帧**（按发出顺序；「委派」那些行不算）——判据从它核对装帧形状 */
  answerBatches: unknown[];
  /** 插件自报的加载信息（`import.meta.url` 是「相对名按哪个目录解析」的唯一判据） */
  pluginLoaded: { url: string; pid: number } | null;
  /** 本次运行的墙钟（毫秒） */
  elapsedMs: number;
}

/** 一次运行要的装配：临时行目录 + 真运行时 + 脚本式上游 */
export interface DshRealPathOptions {
  /** 这一次提问的那一帧（调用 id / 工具名 / 厂商方言入参） */
  frame: { callId: string; toolName: string; args: unknown };
  /** 收尾正文（两臂必须同值，否则指纹比对比的是剧本差异而不是应答面那一格） */
  finalText: string;
  /**
   * 应答面：`undefined` = 不挂（对照臂，**连应答者插件都不落盘**）。**必须显式给这一格**——
   * 它的存在与否正是两臂唯一的自变量。
   */
  onAskUser: ((request: AskUserRequest) => Promise<AskUserReply>) | undefined;
}

/**
 * 把「与上一条**逐字相同**」的 `usage` 事件折成一条（见文件头那条口径）。
 *
 * `usage` 事件交的是**累计快照**（「把最新的一份带上」）⇒ 同值的第二条不携带任何新信息；
 * 读数一旦不同就是新信息，照旧逐条留下。比较时略去 `seq`：它是发射时补的序号，
 * 同一份快照在两次运行里落在不同的号上，拿它比会把「同一条读数」读成「两次读数」。
 */
function foldRepeatedUsage(events: readonly AgentEvent[]): AgentEvent[] {
  /**
   * 递归按键排序后序列化（键序差异不该冒充「两次读数」）；**时刻那几格不比**——同一份快照的
   * 两次投送按定义落在不同的时刻上（与指纹那边的跳过表同一份口径）。
   */
  const skipped = new Set(['at', 'timing', 'totalMs', 'apiMs', 'ttftMs', 'durationMs']);
  const canonical = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value !== null && typeof value === 'object') {
      return `{${Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !skipped.has(key))
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
        .join(',')}}`;
    }
    return JSON.stringify(value) ?? 'undefined';
  };
  const out: AgentEvent[] = [];
  let previous: string | null = null;
  for (const event of events) {
    if (event.type === 'usage') {
      const { seq: _seq, ...snapshot } = event;
      const shape = canonical(snapshot);
      if (shape === previous) continue;
      previous = shape;
    }
    out.push(event);
  }
  return out;
}

/** 读插件写的 sidecar（不存在 ⇒ 空表 = 没挂插件或没收到请求） */
function readTranscript(file: string): Array<Record<string, unknown>> {
  try {
    return readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch {
    return [];
  }
}

/**
 * 跑一次真路径：真运行时 + 脚本式上游 + 真进程内问答。
 *
 * 这一层只交出 `onAskUser`（编排层将来扮演的那一半）与产物收集；**插件那一行与等待档的接线
 * 全在本模块**（产品侧那两处还没有，见文件头），判据不参与。
 */
export async function runDshRealPath(options: DshRealPathOptions): Promise<DshRealPathRun> {
  const root = mkdtempSync(join(tmpdir(), 'dsh-real-path-'));
  const cwd = join(root, 'workspace');
  const configHome = join(root, '.dshhome');
  mkdirSync(cwd, { recursive: true });
  mkdirSync(configHome, { recursive: true });
  const transcriptPath = join(configHome, DSH_ASK_ANSWERER_TRANSCRIPT_RELATIVE_PATH);
  const repliesPath = join(configHome, DSH_ASK_ANSWERER_REPLIES_RELATIVE_PATH);

  const upstream = await startDshScriptedUpstream({
    callId: options.frame.callId,
    toolName: options.frame.toolName,
    args: options.frame.args,
    finalText: options.finalText,
  });
  const messages: AgentMessage[] = [];
  const events: AgentEvent[] = [];
  const requests: AskUserRequest[] = [];
  const askRecords: DshAskRecord[] = [];
  const answerBatches: unknown[] = [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DSH_REAL_PATH_TIMEOUT_MS);
  const started = Date.now();
  /**
   * **把别的注入清掉**：同一份套件前面那些场景注入的是假 SDK，而真路径要的是真模块本身。
   * 这一步之后适配器走的就是产品那条加载路径（`loadDshSdk()` 自己 import 厂商包）。
   */
  setAgentRuntimeForTesting(null);
  /**
   * 入参先于运行造好：提问端口要拿它当上下文（取消、缺省预算、日志），而那一问是在运行
   * **途中**到的 ⇒ 端口必须在 run 之前就在手上。回调那一格的存在与否是两臂唯一的自变量。
   */
  const input = createRunInput({
    cwd,
    configHome,
    permission: 'full',
    prompt: '请先用提问工具向我确认一件事，确认之后收尾。',
    route: {
      protocolType: 'anthropic',
      baseUrl: upstream.url,
      apiKey: PLACEHOLDER_KEY,
      modelId: DSH_REAL_PATH_MODEL,
    },
    signal: controller.signal,
    onEvent: collectEvents(events),
    ...(options.onAskUser === undefined
      ? {}
      : {
        onAskUser: async (request: AskUserRequest): Promise<AskUserReply> => {
          requests.push(request);
          return options.onAskUser === undefined
            ? { outcome: 'unavailable', answers: null }
            : options.onAskUser(request);
        },
      }),
  });
  /**
   * 观测那一半：轮询插件写的**提问流水**（厂商派发出来的那一问原文）与适配器写的**答复流水**
   * （它交回插件的答案批次）。认领与回写都由产品承担（`ask-user.ts` 的桥）——驱动器只读文件，
   * 因此「厂商的请求真的到了我们手里」与「我们的答复真的交回去了」两条事实都不是夹具自述。
   */
  let observing = true;
  const observe = (async () => {
    let seenAsks = 0;
    let seenReplies = 0;
    while (observing) {
      const asked = readTranscript(transcriptPath).filter((row) => row['phase'] === 'request');
      for (; seenAsks < asked.length; seenAsks += 1) {
        const row = asked[seenAsks];
        const wait = (row?.['wait'] ?? null) as { callId?: unknown } | null;
        askRecords.push({
          questions: (row?.['questions'] ?? []) as VendorQuestion[],
          callId: typeof wait?.callId === 'string' ? wait.callId : null,
          wait,
        });
      }
      const replies = readTranscript(repliesPath);
      for (; seenReplies < replies.length; seenReplies += 1) {
        const row = replies[seenReplies];
        // 只有「真交了答案」的那些行算应答帧；「委派」那一行是适配器在说「这一问没有答案」
        if (Array.isArray(row?.['answers'])) answerBatches.push({ answers: row['answers'] });
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  })();
  try {
    const outcome = await dshProvider.run({ ...input, onMessage: (message) => messages.push(message) });
    return {
      upstream,
      askCalls: requests.length,
      requests,
      askRecords,
      answerBatches,
      pluginLoaded: (() => {
        const row = readTranscript(transcriptPath).find((one) => one.phase === 'plugin-loaded');
        if (row === undefined) return null;
        return { url: String(row['url'] ?? ''), pid: Number(row['pid'] ?? 0) };
      })(),
      elapsedMs: Date.now() - started,
      product: {
        messages,
        subagents: [],
        events: foldRepeatedUsage(events) as unknown as Array<Record<string, unknown>>,
        usage: {
          tokens: outcome.tokens === null
            ? null
            : {
              input: outcome.tokens.input,
              cached: outcome.tokens.cached,
              output: outcome.tokens.output,
              reasoningOutput: null,
              total: null,
            },
          turns: outcome.turns,
          subagentTokens: outcome.subagentTokens ?? null,
          subagentTurns: outcome.subagentTurns ?? null,
        },
        result: { ok: outcome.ok, finalText: outcome.finalText },
      },
    };
  } finally {
    observing = false;
    await observe;
    clearTimeout(timer);
    setAgentRuntimeForTesting(null);
    removeTreeWithRetry(root);
  }
}

/**
 * 出站请求里那一条工具结果的正文（按调用 id 找）——**模型最终看到的那一份**。
 *
 * 读法：后续入站请求体的 `messages[].content[]` 里 `type === 'tool_result'` 的块。
 * 它不经过本仓任何投影：厂商把它写进上下文时是什么样，这里就是什么样。
 */
export function dshToolResultTextOf(run: DshRealPathRun, callId: string): string | null {
  for (const record of run.upstream.records) {
    const body = record['body'];
    if (typeof body !== 'object' || body === null) continue;
    const messages = (body as { messages?: unknown }).messages;
    if (!Array.isArray(messages)) continue;
    for (const message of messages) {
      const content = (message as { content?: unknown }).content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        const item = block as { type?: unknown; tool_use_id?: unknown; content?: unknown; is_error?: unknown };
        if (item.type !== 'tool_result' || item.tool_use_id !== callId) continue;
        return typeof item.content === 'string' ? item.content : JSON.stringify(item.content ?? null);
      }
    }
  }
  return null;
}

/**
 * **人工消息面的真路径驱动器**：真运行时 + 脚本式上游 + 产品的插件与桥，判据是**模型看到的请求体**。
 *
 * 为什么非它不可（与「假 SDK」那一档的根本差别）：`'round'` 档与撤回都在 runtime 进程内
 * （`agent.steer` / `inbox.remove`），假件那一档把 SDK 换掉之后，看得见的只有「我们写了什么文件」，
 * 看不见「插件拿它做了什么」。这里厂商那一侧全是真的：插件真的被 overlay 加载、真的从
 * `ctx.agents` 拿到那条 `Agent`、真的把话投进待处理队列，而**判据落在下一次入站请求体里**——
 * 模型到底看没看到那句话，只有那一份说了算。
 *
 * 三条口径：
 *   · **端口由驱动器扮演**（它就是编排层将来那一半：一张表 + `drain` / `markDelivered` / `retract`），
 *     产品那一侧一格都不替；
 *   · **注入发生在「一轮在途」的窗口里**：上游把第一条带工具表的请求压住 `holdMs`，驱动器在这个
 *     窗口内把条目放进端口——这正是人工消息的真实时刻（人是在跑着的时候说话的）；
 *   · **墙钟上限按「宁可超时也不假红」定**（`DSH_REAL_PATH_TIMEOUT_MS`）：到点按失败收场，
 *     把「挂死」变成一条可读的红。
 */
export interface DshInjectionRealPathRun {
  upstream: DshScriptedUpstream;
  /** 这一轮交付出去的**厂商身份**，按档分开记（`'round'` 档就是我们铸的那个 id） */
  delivered: { round: string[]; idle: string[] };
  /** 端口那次撤回的结果（没发就是 `null`） */
  retractOutcome: RetractOutcome | null;
  /**
   * 某条哨兵词出现在**第几条入站请求**里（每条请求给一份「含它的消息下标」）；
   * 空数组 = 这一条请求没带它。判据读它，不读我们交给厂商的入参。
   */
  sentinelInRequests: (sentinel: string) => number[][];
  /** 插件自报的加载事实（`serviceAtLoad` 是**加载那一刻**的读数，不是判据——见收据那一侧） */
  pluginLoaded: { url: string; serviceAtLoad: boolean } | null;
  /**
   * 插件的**动作收据**（`steered` / `removed` 那些行）：`hasAgents` 是**动手那一刻**重新探到的
   * 读数 ⇒ 它才是「这一档在 sdk profile 下拿不拿得到 Agent」的判据（加载顺序不保证顺序）。
   */
  actionReceipts: Array<Record<string, unknown>>;
  product: ConformanceProduct;
  elapsedMs: number;
}

/**
 * 驱动器扮演的端口：一张表 + 三个动作。`available: true` 是这一档的前提
 * （产品只在挂了开着的端口时才插件、才取件）。
 */
function createDriverPort(): {
  port: InjectionPort;
  push: (text: string, requires: InjectionBoundary) => string;
  delivered: { round: string[]; idle: string[] };
} {
  const entries: Array<UserMessage & { requires: InjectionBoundary }> = [];
  const delivered = { round: [] as string[], idle: [] as string[] };
  /** 我们铸的那些身份（`'round'` 档的身份由我们铸 ⇒ 它就是端口那一条的 id） */
  const roundIds = new Set<string>();
  const retracts = new Map<string, (id: string) => Promise<RetractOutcome>>();
  let seq = 0;
  const port: InjectionPort = {
    available: true,
    drain: (boundary) => {
      // 契约：`'round'` 只取要求 `'round'` 的条目、`'idle'` 取全部（`'round'` 在前）
      const taken = entries.filter((entry) => (boundary === 'round' ? entry.requires === 'round' : true));
      for (const entry of taken) entries.splice(entries.indexOf(entry), 1);
      return taken.map(({ id, text }) => ({ id, text }));
    },
    markDelivered: (ids, retract) => {
      for (const id of ids) {
        retracts.set(id, retract);
        // 两档登记回来的**都是我们自己的 id**（驱动器的表按它取撤回句柄）；
        // 这里按「是不是 `'round'` 档铸的那个」分成两摞，只为了用例能分别看两档的投递
        (roundIds.has(id) ? delivered.round : delivered.idle).push(id);
      }
    },
    retract: async (id) => {
      const one = retracts.get(id);
      return one === undefined ? 'unsupported' : one(id);
    },
  };
  return {
    port,
    delivered,
    push: (text, requires) => {
      seq += 1;
      const id = `driver-entry-${String(seq)}`;
      if (requires === 'round') roundIds.add(id);
      entries.push({ id, text, requires });
      return id;
    },
  };
}

/** 一次入站请求体里含某个哨兵词的消息下标（`messages[].content[]` 的文本块） */
function sentinelMessagesIn(body: unknown, sentinel: string): number[] {
  const messages = (body as { messages?: unknown } | null)?.messages;
  if (!Array.isArray(messages)) return [];
  const hits: number[] = [];
  messages.forEach((message, index) => {
    const content = (message as { content?: unknown }).content;
    const blocks = Array.isArray(content) ? content : [];
    const text = blocks
      .map((block) => {
        const item = block as { type?: unknown; text?: unknown; content?: unknown };
        if (item.type === 'text' && typeof item.text === 'string') return item.text;
        return JSON.stringify(item.content ?? '');
      })
      .join('\n');
    if (text.includes(sentinel)) hits.push(index);
  });
  return hits;
}

/** 一条人工消息的哨兵词与被压住的窗口（毫秒） */
export interface DshInjectionArm {
  /** 这一轮要投的哨兵词：`'round'` 档一条、`'idle'` 档两条（第二条投出去后立刻撤回） */
  sentinels: { round: string; idle: string; retracted: string };
  /** 上游压住第一条带工具表的请求多久（毫秒） */
  holdMs: number;
}

/**
 * 跑一次真路径人工消息：**一轮在途时先投三条**（`'round'` 一条、`'idle'` 两条），
 * 然后把第二条 `'idle'` 撤回来。判据由调用方从 `sentinelInRequests` 上取。
 */
export async function runDshRealPathInjection(arm: DshInjectionArm): Promise<DshInjectionRealPathRun> {
  const root = mkdtempSync(join(tmpdir(), 'dsh-inject-real-path-'));
  const cwd = join(root, 'workspace');
  const configHome = join(root, '.dshhome');
  mkdirSync(cwd, { recursive: true });
  mkdirSync(configHome, { recursive: true });
  const upstream = await startDshScriptedUpstream({
    callId: 'call_inject_hold',
    toolName: 'ask_user_question',
    args: {
      questions: [
        {
          id: 'q-hold',
          header: '占位',
          question: '在跑的时候人说话了，先回一句？',
          options: [{ label: '好' }],
        },
      ],
    },
    finalText: '收尾。',
    holdMs: arm.holdMs,
  });
  const messages: AgentMessage[] = [];
  const events: AgentEvent[] = [];
  const driver = createDriverPort();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DSH_REAL_PATH_TIMEOUT_MS);
  const started = Date.now();
  setAgentRuntimeForTesting(null);
  const input = createRunInput({
    cwd,
    configHome,
    permission: 'full',
    prompt: '先问我一句，然后收尾。',
    route: {
      protocolType: 'anthropic',
      baseUrl: upstream.url,
      apiKey: PLACEHOLDER_KEY,
      modelId: DSH_REAL_PATH_MODEL,
    },
    signal: controller.signal,
    inject: driver.port,
    onEvent: collectEvents(events),
    /**
     * 应答面：**只为压住那个窗口**——被压住的那 2 秒里驱动器投三条，正是「一轮在途」的窗口。
     * 答复按厂商的问题 id 配对（少一题会被厂商拒），选项取第一条。
     */
    onAskUser: async (request: AskUserRequest): Promise<AskUserReply> => {
      await new Promise((resolve) => setTimeout(resolve, Math.round(arm.holdMs / 2)));
      return {
        outcome: 'answered',
        answers: request.questions.map((question) => ({
          header: question.header,
          selected: question.options.slice(0, 1).map((option) => option.label),
          custom: null,
        })),
      };
    },
  });
  const waitFor = async (what: string, check: () => boolean): Promise<void> => {
    const deadline = Date.now() + DSH_REAL_PATH_TIMEOUT_MS;
    for (;;) {
      if (check()) return;
      if (Date.now() >= deadline) throw new Error(`等待超时：${what}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  const running = dshProvider.run({ ...input, onMessage: (message) => messages.push(message) });
  try {
    // 窗口：第一条带工具表的请求到了（= 一轮在途），此时人说话
    await waitFor('第一条带工具表的请求到达', () =>
      upstream.records.some((record) =>
        Array.isArray((record['body'] as { tools?: unknown } | null)?.tools)));
    driver.push(arm.sentinels.round, 'round');
    driver.push(arm.sentinels.idle, 'idle');
    driver.push(arm.sentinels.retracted, 'idle');
    // 三条都交付出去（两条走 wire 的 prompt、一条写投递流水），再撤回最后那一条
    await waitFor('两条 idle 档被交付', () => driver.delivered.idle.length >= 2);
    const retractTarget = driver.delivered.idle[driver.delivered.idle.length - 1];
    const retractOutcome = retractTarget === undefined ? null : await driver.port.retract(retractTarget);
    const outcome = await running;
    const receipts = readTranscript(join(configHome, DSH_INJECT_RECEIPTS_RELATIVE_PATH));
    return {
      upstream,
      delivered: driver.delivered,
      retractOutcome,
      sentinelInRequests: (sentinel: string) =>
        upstream.records.map((record) => sentinelMessagesIn(record['body'], sentinel)),
      pluginLoaded: (() => {
        const row = receipts.find((one) => one['phase'] === 'plugin-loaded');
        if (row === undefined) return null;
        return { url: String(row['url'] ?? ''), serviceAtLoad: row['serviceAtLoad'] === true };
      })(),
      actionReceipts: receipts.filter((one) => one['phase'] === 'steered' || one['phase'] === 'removed'),
      elapsedMs: Date.now() - started,
      product: {
        messages,
        subagents: [],
        events: foldRepeatedUsage(events) as unknown as Array<Record<string, unknown>>,
        usage: {
          // 与另一个驱动器同形：这一格交真读数，配对判据（分量 ≤ 合计）才有东西可比
          tokens: outcome.tokens === null
            ? null
            : {
              input: outcome.tokens.input,
              cached: outcome.tokens.cached,
              output: outcome.tokens.output,
              reasoningOutput: null,
              total: null,
            },
          turns: outcome.turns,
          subagentTokens: outcome.subagentTokens ?? null,
          subagentTurns: outcome.subagentTurns ?? null,
        },
        result: { ok: outcome.ok, finalText: outcome.finalText },
      },
    };
  } finally {
    clearTimeout(timer);
    setAgentRuntimeForTesting(null);
    upstream.close();
    removeTreeWithRetry(root);
  }
}

/** 续接真路径的产物：判据读**入站请求体**，不读通知流（那一条不回放历史） */
export interface DshResumeRealPathRun {
  /** 第一轮（新会话）铸出来的会话 id；第二轮 adopt 用的就是它 */
  sessionId: string | null;
  /** adopt 那一轮自己的会话身份（必须与第一轮同值，否则续接没落到同一条上） */
  resumedSessionId: string | null;
  /** 阴性对照（不 resume）铸出来的身份（必须与第一轮**不同**） */
  controlSessionId: string | null;
  /** 第一轮（写）发出的入站请求条数 */
  writeRequests: number;
  /** 第二轮（adopt）发出的入站请求条数 */
  resumeRequests: number;
  /** 暗号在**第二轮**请求体里出现的次数（> 0 = 前一轮的历史真的被带回来了） */
  nonceInResumeRequests: number;
  /** 暗号在**阴性对照**那一轮里出现的次数（必须为 0） */
  nonceInControlRequests: number;
  elapsedMs: number;
}

/**
 * 跑一条**跨运行**的续接真路径：新会话写暗号 → 另起一次运行用官方的 `session/resume` adopt 它
 * → 再跑一次**不** resume 的阴性对照。三次共用同一个 `DSH_HOME`（resume 读的就是它）。
 *
 * 判据为什么落在**入站请求体**上：这一家 resume 之后通知流**不回放历史**（见
 * `docs/faq/deepseek-harness.md`），所以「模型还记不记得」在通知流里看不见；看得见的是
 * 我们发给上游的那份请求体里有没有前一轮的对话。假上游记录的正是它。
 * 少了阴性对照，「请求体里有暗号」可能只是工作区或别处泄漏——那一条判据会假绿。
 */
export async function runDshRealPathResume(nonce: string): Promise<DshResumeRealPathRun> {
  const root = mkdtempSync(join(tmpdir(), 'dsh-resume-real-path-'));
  const cwd = join(root, 'workspace');
  const configHome = join(root, '.dshhome');
  mkdirSync(cwd, { recursive: true });
  mkdirSync(configHome, { recursive: true });
  // 工具名给一个永远不会出现在工具表里的字面量 ⇒ 每一轮都回纯文本收尾（这一档不用工具调用）
  const upstream = await startDshScriptedUpstream({
    callId: 'call_resume_unused',
    toolName: 'aieval-resume-never-matches',
    args: {},
    finalText: '好。',
  });
  const started = Date.now();
  setAgentRuntimeForTesting(null);
  const runOnce = async (prompt: string, resumeSessionId?: string): Promise<string | null> => {
    const result = await dshProvider.run(createRunInput({
      cwd,
      configHome,
      permission: 'full',
      prompt,
      route: {
        protocolType: 'anthropic',
        baseUrl: upstream.url,
        apiKey: PLACEHOLDER_KEY,
        modelId: DSH_REAL_PATH_MODEL,
      },
      ...(resumeSessionId === undefined ? {} : { resume: { sessionId: resumeSessionId } }),
    }));
    return result.sessionId ?? null;
  };
  try {
    // ① 写：新会话，让模型记住暗号
    let mark = upstream.records.length;
    const sessionId = await runOnce(`请原样复述这个暗号，不要做别的事：${nonce}`);
    const writeRequests = upstream.records.length - mark;
    if (sessionId === null) throw new Error('第一轮没拿到会话 id ⇒ 无从续接');

    // ② adopt：新的运行时进程、同一个 DSH_HOME
    mark = upstream.records.length;
    const resumedSessionId = await runOnce('我刚才让你复述的暗号是什么？', sessionId);
    const resumeRequests = upstream.records.length - mark;
    const resumeBody = JSON.stringify(upstream.records.slice(mark).map((one) => one['body']));

    // ③ 阴性对照：同 DSH_HOME、同 cwd，但**不** resume（全新会话）
    mark = upstream.records.length;
    const controlSessionId = await runOnce('我刚才让你复述的暗号是什么？');
    const controlBody = JSON.stringify(upstream.records.slice(mark).map((one) => one['body']));

    const occurrences = (text: string): number => text.split(nonce).length - 1;
    return {
      sessionId,
      resumedSessionId,
      controlSessionId,
      writeRequests,
      resumeRequests,
      nonceInResumeRequests: occurrences(resumeBody),
      nonceInControlRequests: occurrences(controlBody),
      elapsedMs: Date.now() - started,
    };
  } finally {
    setAgentRuntimeForTesting(null);
    upstream.close();
    removeTreeWithRetry(root);
  }
}
