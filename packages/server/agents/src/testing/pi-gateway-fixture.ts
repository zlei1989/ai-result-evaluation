/**
 * pi 的**本地假网关**：真包跑完整装配时用它抓出站请求的**请求体**。
 *
 * 为什么请求侧断言必须走这条路：档位与时长两件事在入参上都看不出对错——档位要过一遍厂商的夹档
 * （`reasoning` 关着时任何档都被夹成 `off`；`max` 没有映射时被夹到 `high`），时长只能用厂商消息
 * 自带的两个数算（自己拿事件时刻现算也能凑出一个数，但那是另一个口径）。假 SDK 看到的只是入参，
 * 只有真包打出来的那份请求体与那条 `usage` 事件能回答「发出去的到底是什么」。
 *
 * 网关按**请求路径**回一段对应 wire 的最简流：openai 的 `data:` 增量块与 anthropic 的具名 SSE
 * 事件是两种格式，回错了这一行会以厂商原文的 `stopReason: 'error'` 收场（请求侧断言仍在，
 * 但结论栏会无谓地变红）；anthropic 那条走 `@anthropic-ai/sdk`，少一个 `message_stop` 同样算失败。
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

/** 一条出站请求：打过来的路径 + 解析后的请求体 */
export interface CapturedPiRequest {
  url: string;
  body: Record<string, unknown>;
}

/** 起一台假网关；它收到的每一份请求体都进 `seen`（顺序即到达顺序） */
export function startPiGateway(seen: CapturedPiRequest[]): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const url = req.url ?? '';
      seen.push({ url, body: raw === '' ? {} : (JSON.parse(raw) as Record<string, unknown>) });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (url.startsWith('/v1/messages')) {
        res.write(`event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: 'm1', type: 'message', role: 'assistant', model: 'm', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 1 } } })}\n\n`);
        res.write('event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n');
        res.write('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"done"}}\n\n');
        res.write('event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n');
        res.write('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n');
        res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
      } else {
        res.write(`data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: { role: 'assistant', content: 'done' }, finish_reason: null }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } })}\n\n`);
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
  const root = mkdtempSync(join(tmpdir(), 'pi-gateway-'));
  const cwd = join(root, 'workspace');
  const configHome = join(root, '.agenthome');
  mkdirSync(cwd, { recursive: true });
  const events: AgentEvent[] = [];
  const result = await piProvider.run({
    ...createRunInput({ cwd, configHome }),
    prompt: 'say done',
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
    onEvent: (event) => events.push(event),
  });
  expect(result.ok, result.error?.message).toBe(true);
  const body = seen.at(-1)?.body;
  expect(body, '网关一条请求都没收到').toBeDefined();
  return { body: body ?? {}, events };
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
