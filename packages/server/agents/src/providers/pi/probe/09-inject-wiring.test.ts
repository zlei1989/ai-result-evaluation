// @vitest-environment node
/**
 * 探针 09：**注入端口到底有没有接线**——用「模型侧真的看到了那句话」当判据。
 *
 * 要回答的问题：适配器把 `turnInjection.delivery.*` 声明成 `off-by-adapter`（厂商有、我们没接）。
 * 这句话有两种结局，而界面上**都不报错**：
 *   · 真的没接 ⇒ 人送的话只有一条路可走（运行结束后的追问），运行中的那一轮收不到；
 *   · 其实接了（或有副作用）⇒ 声明在说假话，界面按「这家不收运行中的人话」置灰是错的。
 *
 * 判据不看声明、不看日志，看**厂商那一侧**：
 *   ① 出站请求里有没有那一句哨兵（模型侧可见 = 真的投出去了）；
 *   ② 编排层端口上有没有收到投递回调（`markDelivered` 被调用 = 适配器认了这笔投递）；
 *   ③ 三格读数（`steer` / `followUp` / 端口回调）各自独立记，别把它们折成一个布尔。
 *
 * 为什么用真适配器 + 自造假网关：端口只在 `run()` 活着的时候存在，必须边跑边投。
 * 网关在**收到第一次请求**之后翻转一个旗，测试据此把话投出去（不靠墙钟猜时机）。
 *
 * 用法（不需要凭据）：
 *   node_modules/.bin/vitest run packages/server/agents/src/providers/pi/probe/09-inject-wiring.test.ts
 */
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentEvent, AgentMessage } from '@aieval/contracts';
import { createRunInput } from '../../../testing/agent-fixtures';
import { piProvider } from '..';

/** 投出去的那句哨兵（模型侧可见 = 真的投出去了） */
const SENTINEL = '注入哨兵-7f3a';
const MODEL = 'probe-model';

/** 一台「会说两轮」的假网关：第一轮让模型调 bash 歇一会，第二轮收尾 */
function startTurnsGateway(state: { requests: Array<Record<string, unknown>>; firstSeen: boolean }) {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const body = raw === '' ? {} : (JSON.parse(raw) as Record<string, unknown>);
      state.requests.push(body);
      state.firstSeen = true;
      const index = state.requests.length - 1;
      const frames = index === 0
        // 第一轮：派一件 bash（给注入留出「轮次之间」的窗口）
        ? toolFrames('bash', { command: 'sleep 1' }, 'toolu_sleep')
        : textFrames('收尾。');
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const frame of frames) res.write(frame);
      res.end();
    });
  });
  return new Promise<{ port: number; close: () => void }>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        port: typeof address === 'object' && address !== null ? address.port : 0,
        close: () => server.close(),
      });
    });
  });
}

const start = (message: { id: string; type: string; role: string; model: string; content: unknown[]; stop_reason: null; stop_sequence: null; usage: Record<string, number> }): string =>
  `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message })}\n\n`;

function textFrames(text: string): string[] {
  return [
    start({ id: 'm1', type: 'message', role: 'assistant', model: MODEL, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 1 } }),
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
    `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })}\n\n`,
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ];
}

function toolFrames(name: string, input: Record<string, unknown>, callId: string): string[] {
  return [
    start({ id: 'm1', type: 'message', role: 'assistant', model: MODEL, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 1 } }),
    `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: callId, name, input: {} } })}\n\n`,
    `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } })}\n\n`,
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":2}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ];
}

describe('运行中的人话：端口接没接', () => {
  it('适配器收到注入端口后：那一句有没有真的到模型侧（哨兵判据）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-v12-inject-'));
    const cwd = join(root, 'workspace');
    const configHome = join(root, '.agenthome');
    mkdirSync(cwd, { recursive: true });

    const state = { requests: [] as Array<Record<string, unknown>>, firstSeen: false };
    const gateway = await startTurnsGateway(state);
    const events: AgentEvent[] = [];
    const messages: AgentMessage[] = [];
    /** 端口读数：`drain` 在哪些边界被调过、`markDelivered` 记账了几条（三格各自独立记） */
    const port = { drainBoundaries: [] as string[], deliveredIds: [] as string[], available: true };

    const controller = new AbortController();
    try {
      const run = piProvider.run({
        ...createRunInput({ cwd, configHome }),
        prompt: '先跑一条命令，然后收尾。',
        permission: 'full',
        route: {
          protocolType: 'anthropic',
          baseUrl: `http://127.0.0.1:${gateway.port}/v1`,
          apiKey: 'sk-probe',
          modelId: MODEL,
          contextWindow: 100_000,
          maxOutputTokens: 8_192,
        },
        signal: controller.signal,
        onEvent: (event) => events.push(event),
        onMessage: (message) => messages.push(message),
        /**
         * 端口形状照 `AgentRunInput.inject` 的契约给（与编排层的 `createInjectionPort` 同形）：
         * 每个边界都回**同一句哨兵**（一直有件可投），于是「适配器有没有去取件」这件事
         * 在三个边界上都留得下读数；只有真的投出去时才会走 `markDelivered`。
         */
        inject: {
          available: true,
          drain: (boundary) => {
            port.drainBoundaries.push(boundary);
            return [{ id: `inject-${port.drainBoundaries.length}`, text: SENTINEL }];
          },
          markDelivered: (ids) => {
            port.deliveredIds.push(...ids);
          },
          retract: async () => 'unsupported' as const,
        },
      });

      // 等第一条请求出去（不靠墙钟猜），再投一句话
      const deadline = Date.now() + 20_000;
      while (!state.firstSeen && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
      expect(state.firstSeen, '网关一条请求都没收到 ⇒ 这一格没跑起来').toBe(true);
      const result = await run;
      const allText = JSON.stringify(state.requests);
      const reading = {
        requestCount: state.requests.length,
        sentinelInAnyRequest: allText.includes(SENTINEL),
        port,
        resultOk: result.ok,
        eventTypes: events.map((event) => event.type),
        messageCount: messages.length,
      };
      dump('09-inject-wiring', reading);

      /**
       * 判据：声明说「一格端口都不挂」⇒ 这一句**不许**出现在任何出站请求里，
       * 端口回调也不许被调用（那会说明适配器认了一笔它其实没投的账）。
       */
      expect(allText.includes(SENTINEL), '哨兵出现在了出站请求里：适配器其实把话投给了厂商').toBe(false);
      expect(port.deliveredIds, '`markDelivered` 被调用了：适配器认了一笔没投出去的账').toEqual([]);
      // 三个边界一次都没被取件 ⇒ 「一格端口都不挂」这条声明在真机上成立
      expect(port.drainBoundaries, '适配器在某个边界上取了件 ⇒ 声明与事实不符').toEqual([]);
    } finally {
      gateway.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 180_000);
});

/** 读数落盘到 `probe/dumps/v12/` */
function dump(name: string, payload: unknown): void {
  const dir = join(import.meta.dirname, '..', '..', '..', '..', 'probe', 'dumps', 'v12');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.json`), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}
