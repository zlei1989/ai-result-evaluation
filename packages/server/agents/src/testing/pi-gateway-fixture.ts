/**
 * pi 的**本地假网关**：真包跑完整装配时用它抓出站请求的**请求体**。
 *
 * 为什么请求侧断言必须走这条路：档位与时长两件事在入参上都看不出对错——档位要过一遍厂商的夹档
 * （`reasoning` 关着时任何档都被夹成 `off`；`max` 没有映射时被夹到 `high`），时长只能用厂商消息
 * 自带的两个数算（自己拿事件时刻现算也能凑出一个数，但那是另一个口径）。假 SDK 看到的只是入参，
 * 只有真包打出来的那份请求体与那条 `usage` 事件能回答「发出去的到底是什么」。
 *
 * 网关按**请求路径**回一段对应 wire 的最简流：OpenAI Responses 的具名事件（`response.created` /
 * `response.output_item.*` / `response.output_text.delta` / `response.completed`）与 anthropic 的具名
 * SSE 事件是两种格式，回错了这一行会以厂商原文的 `stopReason: 'error'` 收场（请求侧断言仍在，
 * 但结论栏会无谓地变红）；两条 wire 都走官方 SDK 的流解析器，少一个终止事件同样算失败。
 * 助手正文由 `respond(请求体)` 决定（缺省恒回 `'done'`）：**脚本式上游**只扮演模型，
 * 厂商侧（装配、会话、投影）走的都是真包。
 *
 * 本模块只被 `*.test.ts` import（与 `agent-fixtures.ts` 同一条口径）。
 */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from 'vitest';
import type { AgentEvent } from '@aieval/contracts';
import { createRunInput } from './agent-fixtures';
import { piProvider } from '../providers/pi';
import type { AgentRunResult } from '../types';

/** 一条出站请求：打过来的路径 + 解析后的请求体 */
export interface CapturedPiRequest {
  url: string;
  body: Record<string, unknown>;
}

/**
 * 起一台假网关；它收到的每一份请求体都进 `seen`（顺序即到达顺序）。
 *
 * `respond` 是**脚本式上游**：它按收到的请求体决定这一轮助手说什么（缺省恒回 `'done'`）。
 * 续接那一类判据要靠它——「厂商把上一轮的转录重新灌进请求」这件事，只有让上游**照请求体**作答，
 * 才能在答复那一条通道上也被观测到（只看请求体是机制层，只看答复是端到端层，两层都要）。
 */
export function startPiGateway(
  seen: CapturedPiRequest[],
  respond: (body: Record<string, unknown>) => string = () => 'done',
): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const url = req.url ?? '';
      const body = raw === '' ? {} : (JSON.parse(raw) as Record<string, unknown>);
      seen.push({ url, body });
      const text = respond(body);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (url.startsWith('/v1/messages')) {
        res.write(`event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: 'm1', type: 'message', role: 'assistant', model: 'm', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 1 } } })}\n\n`);
        res.write('event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n');
        res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })}\n\n`);
        res.write('event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n');
        res.write('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n');
        res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
      } else {
        // Responses wire：消息项 + 正文增量 + 终止响应（`status: 'completed'` 是 stopReason 的来源）。
        // 事件名与 `type` 两处都给：SDK 按 `data:` 迭代，但 `.on('response.output_text.delta')`
        // 那类订阅看的是 `event:` 名——少一边就会有一处判据读不到。
        const item = {
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text, annotations: [] }],
        };
        const events: Array<[string, Record<string, unknown>]> = [
          ['response.created', { type: 'response.created', response: { id: 'resp_1', status: 'in_progress' } }],
          ['response.output_item.added', {
            type: 'response.output_item.added',
            output_index: 0,
            item: { id: 'msg_1', type: 'message', role: 'assistant', status: 'in_progress', content: [] },
          }],
          ['response.output_text.delta', {
            type: 'response.output_text.delta',
            item_id: 'msg_1',
            output_index: 0,
            content_index: 0,
            delta: text,
          }],
          ['response.output_item.done', { type: 'response.output_item.done', output_index: 0, item }],
          ['response.completed', {
            type: 'response.completed',
            response: {
              id: 'resp_1',
              status: 'completed',
              output: [item],
              usage: { input_tokens: 5, input_tokens_details: { cached_tokens: 0 }, output_tokens: 2, total_tokens: 7 },
            },
          }],
        ];
        for (const [name, payload] of events) {
          res.write(`event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`);
        }
        res.write('data: [DONE]\n\n');
      }
      res.end();
    });
  });
  server.unref();
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({ server, port: typeof address === 'object' && address !== null ? address.port : 0 });
    });
  });
}

/** 一个**已备好的行目录**：续接那类用例要在同一条行目录上连跑两次，故由调用方给出根 */
export interface PiRowDir {
  cwd: string;
  configHome: string;
}

/** 造一个行目录（`cwd` = `<root>/workspace`、`configHome` = `<root>/.agenthome`，与编排层同形） */
export function createPiRowDir(root: string): PiRowDir {
  const cwd = join(root, 'workspace');
  const configHome = join(root, '.agenthome');
  mkdirSync(cwd, { recursive: true });
  return { cwd, configHome };
}

/** 在某条行目录上跑一轮真包：prompt 与 wire 由调用方给，`resume` 给了就走续接 */
export async function runPiRowIn(
  seen: CapturedPiRequest[],
  dir: PiRowDir,
  port: number,
  options: {
    protocolType: 'openai' | 'anthropic';
    prompt: string;
    resume?: { sessionId: string };
    effort?: string;
    outputSchema?: unknown;
  },
): Promise<{ body: Record<string, unknown>; events: AgentEvent[]; result: AgentRunResult }> {
  const events: AgentEvent[] = [];
  const result = await piProvider.run({
    ...createRunInput({ cwd: dir.cwd, configHome: dir.configHome }),
    prompt: options.prompt,
    route: {
      protocolType: options.protocolType,
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: 'sk-gateway',
      modelId: 'm1',
      contextWindow: 100_000,
      maxOutputTokens: 32_768,
    },
    // 未选档位时**不给这一格**（给了空串是另一回事）
    ...(options.effort === undefined ? {} : { effort: options.effort }),
    // 要 schema 时给这一格：结构化输出那一件工具随之进请求（判据读出站体，不读入参）
    ...(options.outputSchema === undefined ? {} : { outputSchema: options.outputSchema }),
    // 续接：这一格指向**该家要落的那个键**（pi 是会话文件路径，见 providers/pi/index.ts）
    ...(options.resume === undefined ? {} : { resume: options.resume }),
    onEvent: (event) => events.push(event),
  });
  expect(result.ok, result.error?.message).toBe(true);
  const body = seen.at(-1)?.body;
  expect(body, '网关一条请求都没收到').toBeDefined();
  return { body: body ?? {}, events, result };
}

/**
 * 跑一行真包：档位走 `effort`、wire 走 `protocolType`，返回网关收到的最后一份请求体与这一行的事件流。
 *
 * `maxOutputTokens` 给 32768：anthropic 侧的预算是 `min(档位预算, maxTokens - 1024)`，取小了四档
 * 会互相塌缩成同一个数（那是另一条已知边界，不该混进逐档对照表）。每行一棵自己的行目录——
 * 技能与凭据都往 `configHome` 里落，共用一棵会让上一行的物化泄漏到下一行。
 */
export async function runPiRow(
  seen: CapturedPiRequest[],
  port: number,
  options: { protocolType: 'openai' | 'anthropic'; effort?: string; outputSchema?: unknown },
): Promise<{ body: Record<string, unknown>; events: AgentEvent[] }> {
  const dir = createPiRowDir(mkdtempSync(join(tmpdir(), 'pi-gateway-')));
  const { body, events } = await runPiRowIn(seen, dir, port, {
    protocolType: options.protocolType,
    prompt: 'say done',
    ...(options.effort === undefined ? {} : { effort: options.effort }),
    ...(options.outputSchema === undefined ? {} : { outputSchema: options.outputSchema }),
  });
  return { body, events };
}

/** 事件流里最后一条 `usage`（时长与计量都挂在这条上） */
export function lastPiUsage(events: AgentEvent[]): Extract<AgentEvent, { type: 'usage' }> {
  const usages = events.filter(
    (event): event is Extract<AgentEvent, { type: 'usage' }> => event.type === 'usage',
  );
  const last = usages.at(-1);
  expect(last, '这一行没有发出任何 usage 事件').toBeDefined();
  return last as Extract<AgentEvent, { type: 'usage' }>;
}
