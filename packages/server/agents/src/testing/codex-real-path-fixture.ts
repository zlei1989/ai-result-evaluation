/**
 * codex 的**真路径驱动器**：真 `codex app-server` + 本机假 `/v1/responses` 上游，只把上游模型脚本化。
 *
 * 这一份存在的理由（也是它与「夹具扮演端口」那一档的根本差别）：那一档把适配器将来那一格
 * ——「厂商问了 ⇒ 拿提问端口问一次 ⇒ 把答复装成该家的应答帧」放在夹具里，于是它**证不到**
 * 「厂商的提问请求真的到了我们手里」与「我们的答复真的回到了厂商」。这里厂商那一侧全是真的：
 * 真二进制起 app-server、真 JSON-RPC 管道、厂商自己在运行期下发 `item/tool/requestUserInput`、
 * 我们回帧之后厂商自己把它折成工具结果交给下一轮请求。我们只换掉**上游那个模型**
 * （本机假 `/v1/responses` 按剧本回一帧提问工具的 `function_call`）。
 *
 * **产品那一侧全在链路上**：线程级那两格提问开关由 `buildCodexConfig` 按应答面打开，服务端请求的
 * 分类与回帧走 `appserver/client.ts` 的应答者通道，问题映射与应答帧由 `providers/codex/ask-user.ts`
 * 产出——驱动器只交出 `onAskUser`（编排层将来扮演的那一半）并收集产物。它因此能证到那一格最要紧的
 * 事实：**删掉产品的回帧，这一条真路径就挂住**（厂商测到不回帧时会一直等）。
 *
 * 三条口径：
 *   · **上游模型是假的**：这里证的是「厂商的通道与工具是真的」，不是「真模型会自发提问」，
 *     后者只在真机冒烟里看（见 `askUserProofDriver` 的声明注释）；
 *   · **两臂只差回调那一格**：同一条剧本、同一份装配各跑一次；没有回调那一臂由**骨架端口自己**
 *     给出「无人应答」，驱动器按厂商原生的「没有答案」回一帧空表——实测不回帧时厂商会一直等
 *     （`isBlocking: false` 且 `autoResolutionMs: null` 都不让它自己收场），那一臂根本跑不完；
 *   · **等待上限按「宁可超时也不假红」定**：真二进制的冷启动 + 两次上游往返，机器带负载时慢一个
 *     数量级；到点用 abort 收场而不是让整份用例挂在默认超时上。
 *
 * 本模块只被 `*.test.ts` import（与 `agent-fixtures.ts` 同一条口径）。
 */
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentEvent, AgentMessage } from '@aieval/contracts';
import { vendorNoticeMethodOf } from '../providers/conformance/ask-user';
import { createAskUserPort } from '../ask-user';
import { codexProvider, defaultCodexRuntimeHooks } from '../providers/codex';
import type { AskUserReply, AskUserRequest } from '../types';
import type { ConformanceProduct } from '../providers/conformance/kit';
import { collectEvents, createRunInput } from './agent-fixtures';
import { removeTreeWithRetry } from './cleanup';

/** 上游模型名：模型那一侧是假的，这个名字只决定请求体里的一个字符串 */
export const CODEX_REAL_PATH_MODEL = 'real-path-model';

/** 脚本式上游要的凭据：占位串即可（请求根本不出本机） */
const PLACEHOLDER_KEY = 'real-path-placeholder-not-a-secret';

/**
 * 一次真路径运行的墙钟上限（毫秒）。给足的理由：真二进制的冷启动 + 两次上游往返 + 收尾，
 * 量级在秒级，而机器带负载时进程创建会慢一个数量级。**到点按失败收场**——上限的作用是把
 * 「挂死」变成一条可读的红，不是把慢读成不同意（口径：宁可超时也不假红）。
 */
export const CODEX_REAL_PATH_TIMEOUT_MS = 180_000;

/**
 * 线程级配置里那两格提问工具开关：**夹具替接线票打开**（见文件头）。
 *
 * 两格都开是照探针的臂定义（`on` 臂），不是按「哪一格才管用」挑的：本探针不回答那个问题，
 * 而只开一格时厂商的行为差异属于接线票的读数面。
 */
const ASK_SWITCH_TOOLS = { experimental_request_user_input: { enabled: true } } as const;
const ASK_SWITCH_FEATURES = { default_mode_request_user_input: true } as const;

/** 假上游的落点与它收到的入站请求（`body` 是解析后的请求体，判据从它读工具结果） */
export interface CodexScriptedUpstream {
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
    ['response.created', { type: 'response.created', response: { id: 'resp_text' } }],
    ['response.output_item.done', {
      type: 'response.output_item.done',
      output_index: 0,
      item: {
        type: 'message',
        id: 'msg_text',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text, annotations: [] }],
      },
    }],
    ['response.completed', { type: 'response.completed', response: { id: 'resp_text', usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }],
  ]);
}

/**
 * 一轮工具调用——剧本的第一轮，逼客户端真的去执行那个工具。
 *
 * `arguments` 是**字符串**（Responses 线面上工具实参就是这么传的）；整份调用以
 * `response.output_item.done` 一次性下发，与真上游同形。
 */
function toolTurn(callId: string, toolName: string, args: unknown): string {
  return sseOf([
    ['response.created', { type: 'response.created', response: { id: 'resp_call' } }],
    ['response.output_item.done', {
      type: 'response.output_item.done',
      output_index: 0,
      item: {
        type: 'function_call',
        id: `fc_${callId}`,
        call_id: callId,
        name: toolName,
        arguments: JSON.stringify(args),
        status: 'completed',
      },
    }],
    ['response.completed', { type: 'response.completed', response: { id: 'resp_call', usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }],
  ]);
}

/**
 * 起一台脚本式上游：**第一条带提问工具表的 `/v1/responses` 请求**回一帧提问工具的 `function_call`，
 * 其余一律回纯文本收尾。
 *
 * 判据是「第一条带那件工具表的」而不是「第几条」：app-server 起来时会先打几条别的请求
 * （探活、模型目录），按序号数会让剧本错位——错位的表现是「提问没发生」，而那是假红。
 */
export async function startCodexScriptedUpstream(options: {
  /** 那一帧提问工具调用的 id（厂商把它当 `itemId` 回给客户端，两处必须同值） */
  callId: string;
  /** 提问工具名（厂商原文；驱动器用它判「这一条请求带没带那件工具」） */
  toolName: string;
  /** 提问工具的入参（厂商方言，逐个字段照厂商 schema 给） */
  args: unknown;
  /** 收尾那几轮的正文（`finalText` 的来源） */
  finalText: string;
  /**
   * **按入站请求体现算**收尾正文的剧本（给了就以它为准）。
   *
   * 为什么要这一格：脚本式上游扮演的是「模型」——只有让它读一眼请求体，那一条「上下文真的走到了
   * 模型面前」的判据才谈得上（否则答复与请求体无关，读回暗号只是自说自话）。
   */
  finalTextOf?: (body: Record<string, unknown>) => string;
}): Promise<CodexScriptedUpstream> {
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
        // 解析不了就按空体处置：这一条不是我们要读的那一类（判据读的是 `/v1/responses` 的 JSON 体）
      }
      records.push({ url: request.url ?? '', body });
      const tools = Array.isArray(body['tools']) ? (body['tools'] as Array<{ name?: unknown }>) : [];
      const shouldAsk = !asked && tools.some((tool) => tool?.name === options.toolName);
      if (shouldAsk) asked = true;
      const finalText = options.finalTextOf?.(body) ?? options.finalText;
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      response.end(shouldAsk ? toolTurn(options.callId, options.toolName, options.args) : textTurn(finalText));
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

/** 厂商自己那条服务端请求的原始 params（判据读它核对字段名与预算那一格） */
export interface CodexAskRequestRecord {
  id: number | string;
  params: Record<string, unknown>;
}

/** 一次真路径运行的产物 */
export interface CodexRealPathRun {
  product: ConformanceProduct;
  /** 这一次运行的假上游（判据从它的 `records` 读出站请求里的工具结果） */
  upstream: CodexScriptedUpstream;
  /** 应答面被问了几次（**提问请求那一次**；审批类不进这一格，见文件头） */
  askCalls: number;
  /** 应答面收到的入参（按调用顺序）——它证明提问真的到了我们这一侧 */
  requests: AskUserRequest[];
  /** 厂商下发的提问请求原文（按到达顺序）；非提问类的服务端请求**一条都不该有** */
  askRequests: CodexAskRequestRecord[];
  /**
   * 真写回厂商的那几帧（按发出顺序）。判据从它核对「答复真的装进了这一家的应答形状」——
   * 驱动器包在产品那个应答者外面（`wrapServerRequest`），故产品写出的每一帧都在这里留一份。
   */
  answerFrames: unknown[];
  /** 本次运行的墙钟（毫秒） */
  elapsedMs: number;
  /**
   * 厂商下发的**每一条通知原文**（`{method, params}`，按到达顺序）。
   *
   * 为什么驱动器要自己收一份：本仓对未识别通知的投影只留方法名（`protocol.ts` 的 `other` 那一支
   * 把 `params` 丢掉，那条日志事件的正文就是 `{"method":"…"}`）⇒「厂商投的是什么」在产物里读不到，
   * 而两臂比对与排障都要它（例如开关那一臂多出来的那条 `warning`，正文才是证据）。
   */
  vendorNotices: Array<{ method: string; params: unknown }>;
}

/**
 * 本次运行里**厂商自己投的、本仓没有专门投影的通知**方法名全集（去重）。
 *
 * 用途只有一处：两臂比对时点名「哪几条通知的进出是提问开关带来的」（见
 * `AskUserProbe.control.askSwitchNotices`）。零条也是合法事实（那一档就直接比原始指纹）。
 */
export function codexVendorNoticesOf(run: CodexRealPathRun): string[] {
  const methods = new Set<string>();
  for (const event of run.product.events) {
    const method = vendorNoticeMethodOf(event);
    if (method !== null) methods.add(method);
  }
  return [...methods];
}

/** 一次运行要的装配：临时行目录 + 真二进制 + 脚本式上游 */
export interface CodexRealPathOptions {
  /** 这一次提问的那一帧（调用 id / 工具名 / 厂商方言入参） */
  frame: { callId: string; toolName: string; args: unknown };
  /** 收尾正文（两臂必须同值，否则指纹比对比的是剧本差异而不是回调那一格） */
  finalText: string;
  /**
   * 应答面：`undefined` = 不挂（对照臂）。**必须显式给这一格**——「不挂」是有意的字段缺席：
   * 这一格的存在与否正是两臂唯一的自变量。
   */
  onAskUser: ((request: AskUserRequest) => Promise<AskUserReply>) | undefined;
}

/** 厂商的提问参数（只声明本模块要读的字段，不引厂商类型） */
interface VendorAskParams {
  itemId: string;
  questions: Array<{ id: string }>;
  autoResolutionMs?: number | null;
}

/**
 * 跑一次真路径：真 app-server + 脚本式上游 + 真服务端请求 + 产品的应答帧。
 *
 * 这一层只交出 `onAskUser`（编排层将来扮演的那一半）与产物收集；**开关与回帧都在产品里**
 * （`buildCodexConfig` 按应答面开那两格、`providers/codex/ask-user.ts` 产出应答帧、
 * `appserver/client.ts` 写回同一条 stdin），判据不参与。
 */
export async function runCodexRealPath(options: CodexRealPathOptions): Promise<CodexRealPathRun> {
  const root = mkdtempSync(join(tmpdir(), 'codex-real-path-'));
  const cwd = join(root, 'workspace');
  const configHome = join(root, '.agenthome');
  mkdirSync(cwd, { recursive: true });
  mkdirSync(configHome, { recursive: true });

  const upstream = await startCodexScriptedUpstream({
    callId: options.frame.callId,
    toolName: options.frame.toolName,
    args: options.frame.args,
    finalText: options.finalText,
  });
  const messages: AgentMessage[] = [];
  const events: AgentEvent[] = [];
  const requests: AskUserRequest[] = [];
  const askRequests: CodexAskRequestRecord[] = [];
  const answerFrames: unknown[] = [];
  const vendorNotices: Array<{ method: string; params: unknown }> = [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CODEX_REAL_PATH_TIMEOUT_MS);
  const started = Date.now();
  /**
   * 入参先于运行造好：提问端口要拿它当上下文（取消、缺省预算、日志），而服务端请求是在运行
   * **途中**到的 ⇒ 端口必须在 run 之前就在手上。回调那一格的存在与否是两臂唯一的自变量。
   */
  const input = createRunInput({
    cwd,
    configHome,
    permission: 'full',
    prompt: '请先用提问工具向我确认一件事，确认之后收尾。',
    route: {
      protocolType: 'openai',
      baseUrl: upstream.url,
      apiKey: PLACEHOLDER_KEY,
      modelId: CODEX_REAL_PATH_MODEL,
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
  const port = createAskUserPort(input, { kind: 'codex' });
  const originalHooks = codexProvider.runtimeHooks;
  codexProvider.runtimeHooks = {
    // 真二进制照旧由产品那一侧解析（这里显式点名，免得「换成了假的」这件事无人察觉）
    resolveBinary: defaultCodexRuntimeHooks.resolveBinary,
    /**
     * 产品的客户端照旧由产品那一侧建（连 spawn 都是真的），驱动器只**包一层**：把厂商下发的原始
     * params 记一份（判据核对字段名）、把驱动器这一路产出的帧抄一份。分类与回帧都交给**产品那一个
     * 应答者**（`index.ts` 造的 `createCodexAskResponder`）——驱动器自己再造一个的话，
     * 产品在应答者里做的那些事（把提问那一半投进账本、主线程 id 判据）在真路径场景里就不会发生，
     * 而症状是界面上只剩一条没有题目的答复行，其余判据全绿。
     *
     * 驱动器那条订阅另收一份厂商原文：未识别通知的 `params` 在产品里读不到
     * （`protocol.ts` 的 `other` 只留方法名，见 `CodexRealPathRun.vendorNotices`）。
     */
    createClient: (clientInput) => {
      const client = defaultCodexRuntimeHooks.createClient({
        ...clientInput,
        wrapServerRequest: (inner) => async (request) => {
          if (request.method === 'item/tool/requestUserInput') {
            askRequests.push({ id: request.id, params: (request.params ?? {}) as Record<string, unknown> });
          }
          const result = await inner(request);
          if (result !== null) answerFrames.push(result);
          return result;
        },
      });
      client.subscribe((notification) => {
        vendorNotices.push({ method: notification.method, params: notification.params });
      });
      return client;
    },
  };
  try {
    const outcome = await codexProvider.run({ ...input, onMessage: (message) => messages.push(message) });
    return {
      upstream,
      askCalls: requests.length,
      requests,
      askRequests,
      answerFrames,
      vendorNotices,
      elapsedMs: Date.now() - started,
      product: {
        messages,
        subagents: [],
        events: events as unknown as Array<Record<string, unknown>>,
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
    clearTimeout(timer);
    codexProvider.runtimeHooks = originalHooks;
    removeTreeWithRetry(root);
  }
}

/**
 * 出站请求里那一条工具结果的正文（按调用 id 找）——**模型最终看到的那一份**。
 *
 * 读法：后续入站请求体的 `input[]` 里 `type === 'function_call_output'` 且 `call_id` 相同的
 * 那一条的 `output`。它不经过本仓任何投影：厂商把它写进上下文时是什么样，这里就是什么样。
 */
export function codexToolResultTextOf(run: CodexRealPathRun, callId: string): string | null {
  for (const record of run.upstream.records) {
    const body = record['body'];
    if (typeof body !== 'object' || body === null) continue;
    const input = (body as { input?: unknown }).input;
    if (!Array.isArray(input)) continue;
    for (const entry of input) {
      const item = entry as { type?: unknown; call_id?: unknown; output?: unknown };
      if (item.type !== 'function_call_output' || item.call_id !== callId) continue;
      return typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? null);
    }
  }
  return null;
}
