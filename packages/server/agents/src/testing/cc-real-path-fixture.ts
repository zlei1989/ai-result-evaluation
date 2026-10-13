/**
 * cc 的**真路径驱动器**：真 CLI（SDK 自带）+ 本机假 `/v1/messages` 上游，只把上游模型脚本化。
 *
 * 这一份存在的理由（也是它与「夹具扮演端口」那一档的根本差别）：那一档把适配器将来那一格
 * ——「厂商问了 ⇒ 拿提问端口问一次 ⇒ 把答复装成该家的应答帧」放在夹具里，于是它**证不到**
 * 「厂商的提问请求真的到了我们手里」与「我们的答复真的回到了厂商」。这里两边都是真的：
 * CLI 是 SDK 自带的那个二进制、权限协议是厂商的、递答案走厂商自己的 `updatedInput`，我们只把
 * **上游那一侧模型**换成一段固定剧本（本机假 `/v1/messages` 主动回一帧提问工具的 `tool_use`）。
 *
 * 判据落在两处**厂商自己写出来的原文**上，都不经过我们的投影：
 *   · 假上游收到的**后续请求体**里那份 `tool_result`——模型最终看到的就是它；
 *   · 适配器的权限钩子被调用时拿到的入参（它证明提问真的走到了我们这一侧）。
 *
 * 三条口径：
 *   · **上游模型是假的**：这里证的是「厂商的通道与工具是真的」，不是「真模型会自发提问」，
 *     后者只在真机冒烟里看（见 `askUserProofDriver` 的声明注释）；
 *   · **两臂只差回调那一格**：同一条剧本、同一份载荷各跑一次，带回调那一次由真钩子驱动；
 *   · **等待上限按「宁可超时也不假红」定**：真 CLI 有冷启动与进程创建的开销（本机计价单位是进程
 *     创建），上限给足；到点用 abort 收场而不是让整份用例挂在默认超时上。
 *
 * 本模块只被 `*.test.ts` import（与 `agent-fixtures.ts` 同一条口径）。
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentEvent, AgentMessage } from '@aieval/contracts';
import { setAgentRuntimeForTesting } from '../runtime';
import type { AskUserReply, AskUserRequest } from '../types';
import { collectEvents, createRunInput } from './agent-fixtures';
import { removeTreeWithRetry } from './cleanup';
import type { ConformanceProduct } from '../providers/conformance/kit';
import { claudeCodeProvider } from '../providers/cc';

/** 上游模型名：模型那一侧是假的，这个名字只决定请求体里的一个字符串 */
export const CC_REAL_PATH_MODEL = 'claude-sonnet-4-5';

/** 脚本式上游要的凭据：占位串即可（请求根本不出本机） */
const PLACEHOLDER_KEY = 'real-path-placeholder-not-a-secret';

/**
 * 一次真路径运行的墙钟上限（毫秒）。给足的理由：真 CLI 的冷启动 + 一次权限往返 + 收尾，
 * 量级在秒级，而机器带负载时进程创建会慢一个数量级。**到点按失败收场**——上限的作用是
 * 把「挂死」变成一条可读的红，不是把慢读成不同意（口径：宁可超时也不假红）。
 */
export const CC_REAL_PATH_TIMEOUT_MS = 180_000;

/** 假上游的落点与它收到的入站请求（`body` 是解析后的请求体，判据从它读 `tool_result`） */
export interface CcScriptedUpstream {
  url: string;
  records: Record<string, unknown>[];
  close: () => void;
}

/** 一条 SSE 响应（`event: …\ndata: …` 两行一组） */
function sseOf(events: ReadonlyArray<readonly [string, unknown]>): string {
  return events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');
}

/** 一轮纯文本收尾（`end_turn`）——剧本的第二轮之后全是它 */
function textTurn(text: string): string {
  return sseOf([
    ['message_start', { type: 'message_start', message: { id: 'msg_text', type: 'message', role: 'assistant', model: CC_REAL_PATH_MODEL, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }],
    ['message_stop', { type: 'message_stop' }],
  ]);
}

/**
 * 一轮工具调用（`stop_reason: 'tool_use'`）——剧本的第一轮，逼客户端真的去执行那个工具。
 * 入参用 `input_json_delta` 分片下发（与真上游同形：整份 `input` 只在 `content_block_start` 上给
 * 空对象，实体走增量），少了这一段 CLI 会拿不到入参。
 */
function toolTurn(callId: string, toolName: string, input: unknown): string {
  return sseOf([
    ['message_start', { type: 'message_start', message: { id: `msg_${callId}`, type: 'message', role: 'assistant', model: CC_REAL_PATH_MODEL, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: callId, name: toolName, input: {} } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 5 } }],
    ['message_stop', { type: 'message_stop' }],
  ]);
}

/**
 * 起一台脚本式上游：**第一条带工具表的 `/v1/messages` 请求**回一帧提问工具的 `tool_use`，
 * 其余一律回纯文本收尾。
 *
 * 判据是「带工具表的第一条」而不是「第几条」：CLI 在会话建立前后会打几条不带工具表的请求
 * （`count_tokens`、探活），按序号数会让剧本错位——错位的表现是「提问没发生」，而那是假红。
 */
export async function startCcScriptedUpstream(options: {
  /** 那一帧提问工具调用的 id（也是权限钩子回的 `toolUseID`，两者必须同值） */
  callId: string;
  /** 提问工具名（厂商原文） */
  toolName: string;
  /** 提问工具的入参（厂商方言，逐个字段照厂商 schema 给） */
  input: unknown;
  /** 收尾那几轮的正文（`finalText` 的来源） */
  finalText: string;
}): Promise<CcScriptedUpstream> {
  const records: Record<string, unknown>[] = [];
  let asked = false;
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const url = request.url ?? '';
      let body: Record<string, unknown> = {};
      try {
        body = raw === '' ? {} : (JSON.parse(raw) as Record<string, unknown>);
      } catch {
        // 解析不了就按空体处置：这一条不是我们要读的那一类（判据读的是 `/v1/messages` 的 JSON 体）
      }
      records.push({ url, body });
      // token 计数请求回 JSON（回 SSE 会让 CLI 在会话建立前就出错）
      if (url.includes('count_tokens')) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ input_tokens: 1 }));
        return;
      }
      const tools = Array.isArray(body['tools']) ? (body['tools'] as unknown[]) : [];
      const shouldAsk = !asked && tools.length > 0;
      if (shouldAsk) asked = true;
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      response.end(shouldAsk ? toolTurn(options.callId, options.toolName, options.input) : textTurn(options.finalText));
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

/** 一次真路径运行的产物 */
export interface CcRealPathRun {
  product: ConformanceProduct;
  /** 这一次运行的假上游（判据从它的 `records` 读出站请求里的 `tool_result`） */
  upstream: CcScriptedUpstream;
  /** 应答面被问了几次（**提问工具那一次**；普通工具不进这一格，见 `providers/cc/ask-user.ts`） */
  askCalls: number;
  /** 应答面收到的入参（按调用顺序）——它证明提问真的到了我们这一侧 */
  requests: AskUserRequest[];
  /** 本次运行的墙钟（毫秒） */
  elapsedMs: number;
}

/** 一次运行要的装配：临时行目录 + 真 SDK 模块 + 脚本式上游 */
export interface CcRealPathOptions {
  /** 这一次提问的那一帧（调用 id / 工具名 / 厂商方言入参） */
  frame: { callId: string; toolName: string; input: unknown };
  /** 收尾正文（两臂必须同值，否则指纹比对比的是剧本差异而不是回调那一格） */
  finalText: string;
  /**
   * 应答面：`undefined` = 不挂（对照臂）。**必须显式给这一格**——`createRunInput` 的默认值里
   * 没有它，但把「不挂」写成字段缺席是有意的：这一格的存在与否正是两臂唯一的自变量。
   */
  onAskUser: ((request: AskUserRequest) => Promise<AskUserReply>) | undefined;
}

/**
 * 跑一次真路径：真 CLI + 脚本式上游 + 真权限协议。
 *
 * 这一层只交出 `onAskUser`（编排层将来扮演的那一半）与产物收集；**钩子的形状与递答案的实现
 * 全在产品侧**（`providers/cc/ask-user.ts`），夹具不参与——那正是这一条与「夹具扮演端口」的分界。
 */
export async function runCcRealPath(options: CcRealPathOptions): Promise<CcRealPathRun> {
  const root = mkdtempSync(join(tmpdir(), 'cc-real-path-'));
  const cwd = join(root, 'workspace');
  const configHome = join(root, '.agenthome');
  mkdirSync(cwd, { recursive: true });
  mkdirSync(configHome, { recursive: true });
  // 一个最小工作区：真 CLI 需要一个存在的 cwd（`Bash` / `Read` 的落点），本场景不读它
  writeFileSync(join(cwd, 'notes.txt'), 'alpha\nbeta\ngamma\ndelta\n', 'utf8');

  const upstream = await startCcScriptedUpstream({
    callId: options.frame.callId,
    toolName: options.frame.toolName,
    input: options.frame.input,
    finalText: options.finalText,
  });
  const messages: AgentMessage[] = [];
  const events: AgentEvent[] = [];
  const requests: AskUserRequest[] = [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CC_REAL_PATH_TIMEOUT_MS);
  const started = Date.now();
  // 真厂商件：SDK 模块就是装在本包里的那一份，`loadClaudeSdk` 走注入表拿到它
  const sdk = await import('@anthropic-ai/claude-agent-sdk');
  setAgentRuntimeForTesting({ sdkModule: sdk });
  try {
    const outcome = await claudeCodeProvider.run({
      ...createRunInput({
        cwd,
        configHome,
        permission: 'full',
        prompt: '请先用提问工具向我确认一件事，确认之后收尾。',
        route: {
          protocolType: 'anthropic',
          baseUrl: upstream.url,
          apiKey: PLACEHOLDER_KEY,
          modelId: CC_REAL_PATH_MODEL,
        },
        signal: controller.signal,
        onEvent: collectEvents(events),
      }),
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
      onMessage: (message) => messages.push(message),
    });
    return {
      upstream,
      askCalls: requests.length,
      requests,
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
    setAgentRuntimeForTesting(null);
    removeTreeWithRetry(root);
  }
}

/**
 * 出站请求里那一条 `tool_result` 的正文（按调用 id 找）——**模型最终看到的那一份**。
 *
 * 读法：后续入站请求体的 `messages[].content[]` 里 `type === 'tool_result'` 的块。
 * 它不经过本仓任何投影：厂商把它写进上下文时是什么样，这里就是什么样。
 */
export function toolResultTextOf(run: CcRealPathRun, callId: string): string | null {
  for (const record of run.upstream.records) {
    const body = record['body'];
    if (typeof body !== 'object' || body === null) continue;
    const messages = (body as { messages?: unknown }).messages;
    if (!Array.isArray(messages)) continue;
    for (const message of messages) {
      const content = (message as { content?: unknown }).content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        const item = block as { type?: unknown; tool_use_id?: unknown; content?: unknown };
        if (item.type !== 'tool_result' || item.tool_use_id !== callId) continue;
        return typeof item.content === 'string' ? item.content : JSON.stringify(item.content ?? null);
      }
    }
  }
  return null;
}
