// @vitest-environment node
/**
 * 真机冒烟：**四家智能体到底按不按设置里的重试次数重试**（真 CLI / SDK + 本地假网关 + 产品那条 `agentProvider.run`）。
 *
 * 为什么单测不够：四家的落点守卫证明的是「我们把数填进了厂商的那个环境变量 / config / overlay / settings」，
 * 而「厂商真的照它重试」是另一件事——键名写错、被更深的一层忽略、或厂商自己还有一条固定次数的重试链，
 * 单测一律看不见（正是本仓「测试环境 ≠ 运行环境」那条）。
 *
 * 判据是**假网关收到了几条模型请求**：设置 `modelRetries: 2` + 前两次回 500 ⇒ 恰好 1 + 2 = 3 条。
 * 它同时钉住四件事：① 这一格真的到了适配器；② 厂商认这个键；③ 语义是「重试几次」而不是
 * 「总共几次」（后者会收到 2 条）；④ 四家用同一个数（对齐）。
 *
 * 开关（默认跳过，避免进内循环与 CI）：
 * ```
 * AIEVAL_LIVE_RETRIES=1 pnpm vitest run packages/server/agents/src/model-retries-live.test.ts
 * ```
 * 可选的 `AIEVAL_LIVE_RETRIES_KINDS=cc,codex,dsh,pi` 圈定要跑哪几家（缺省四家全跑）。
 *
 * 边界：网关是**本地假的上游**（模型那一端脚本化，两条 wire 各一种错误体与成功体）；厂商侧
 * （SDK 装载、子进程、会话装配、请求构造）走的全是真包。某一家在本机起不来时该家用例**红**而不是跳过：
 * 跳过会让人把「没跑」读成「跑过了」。
 */
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgentKind, ProtocolType } from './types';
import { getProvider } from './registry';

const ENABLED = process.env.AIEVAL_LIVE_RETRIES === '1';
/** 每次运行注入的重试次数（夹具值，不是产品默认值）：跑 3 条请求就能判语义，且退避只等 0.5 + 1 s */
const MODEL_RETRIES = 2;
/** 真实运行一次的上限：模型那一端是脚本化的，本机一次只要几秒；给足冷启动（首次 spawn CLI）的余量 */
const TIMEOUT_MS = 180_000;

/** 一条入站请求：路径 + 原文（只数条数、排障时看是什么路径） */
interface Captured {
  url: string;
  body: string;
}

/** 本地假网关：前 `failuresLeft` 次模型请求回 500，之后按路径回一条最小 SSE（两种 wire 各一种） */
function startGateway(): Promise<{
  seen: Captured[];
  port: number;
  /** 重置「还失败几次」（每次运行前调）：只对模型路径计数 */
  arm: (failures: number) => void;
  close: () => Promise<void>;
}> {
  const seen: Captured[] = [];
  let failuresLeft = 0;
  const isModelPath = (url: string): boolean => url.includes('/messages') || url.includes('/responses');
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const url = req.url ?? '';
      seen.push({ url, body });
      if (isModelPath(url) && failuresLeft > 0) {
        failuresLeft -= 1;
        res.writeHead(500, { 'content-type': 'application/json' });
        // 两条 wire 各自的错误信封：换错信封时厂商可能把它当不可重试的畸形响应，读数会变成 1 条
        res.end(
          JSON.stringify(
            url.includes('/messages')
              ? { type: 'error', error: { type: 'api_error', message: '服务维护中' } }
              : { error: { type: 'server_error', code: 'server_error', message: '服务维护中' } },
          ),
        );
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (url.includes('/messages')) {
        res.write(
          'event: message_start\ndata: {"type":"message_start","message":{"id":"m1","type":"message","role":"assistant","model":"m","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":5,"output_tokens":1}}}\n\n',
        );
        res.write('event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n');
        res.write('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"done"}}\n\n');
        res.write('event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n');
        res.write('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n');
        res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
      } else {
        const item = {
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'done', annotations: [] }],
        };
        const events: Array<[string, Record<string, unknown>]> = [
          ['response.created', { type: 'response.created', response: { id: 'resp_1', status: 'in_progress' } }],
          [
            'response.output_item.added',
            {
              type: 'response.output_item.added',
              output_index: 0,
              item: { id: 'msg_1', type: 'message', role: 'assistant', status: 'in_progress', content: [] },
            },
          ],
          [
            'response.output_text.delta',
            { type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: 'msg_1', delta: 'done' },
          ],
          ['response.output_item.done', { type: 'response.output_item.done', output_index: 0, item }],
          [
            'response.completed',
            {
              type: 'response.completed',
              response: {
                id: 'resp_1',
                status: 'completed',
                output: [item],
                usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
              },
            },
          ],
        ];
        for (const [name, data] of events) res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
      }
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      resolve({
        seen,
        port,
        arm: (failures) => {
          failuresLeft = failures;
        },
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

/**
 * 四家各用一条**本机能装载**的组合：cc 只吃 anthropic 协议、codex 只吃 openai；dsh / pi 两家协议都收，
 * 这里各取一条。模型名挑各家 CLI 目录里常见的形状（它们只影响请求体里的 model 字段，网关不看）。
 */
const KINDS: Array<{ kind: AgentKind; protocolType: ProtocolType; modelId: string }> = [
  { kind: 'cc', protocolType: 'anthropic', modelId: 'claude-sonnet-4-6' },
  { kind: 'codex', protocolType: 'openai', modelId: 'gpt-5' },
  { kind: 'dsh', protocolType: 'openai', modelId: 'deepseek-chat' },
  { kind: 'pi', protocolType: 'anthropic', modelId: 'claude-sonnet-4-6' },
];

const requested = (process.env.AIEVAL_LIVE_RETRIES_KINDS ?? '')
  .split(',')
  .map((one) => one.trim())
  .filter((one) => one !== '');
const selected = requested.length === 0 ? KINDS : KINDS.filter((one) => requested.includes(one.kind));

let gateway: Awaited<ReturnType<typeof startGateway>>;
let root = '';

beforeAll(async () => {
  if (!ENABLED) return;
  gateway = await startGateway();
  root = mkdtempSync(join(tmpdir(), 'aieval-retries-live-'));
});

afterAll(async () => {
  if (!ENABLED) return;
  await gateway.close();
  rmSync(root, { recursive: true, force: true });
});

describe.skipIf(!ENABLED)('真机：四家智能体按设置的重试次数重试', () => {
  for (const entry of selected) {
    it(
      `${entry.kind}：前两次 500 + 设 ${MODEL_RETRIES} 次 ⇒ 恰好 ${MODEL_RETRIES + 1} 条模型请求`,
      async () => {
        if (gateway === undefined) throw new Error('网关没有起起来（见 beforeAll）');
        const before = gateway.seen.length;
        // 每次运行重新装填失败次数：只算模型路径，别的入站请求（若有）不消耗预算
        gateway.arm(MODEL_RETRIES);
        // 工作区**先建好**：dsh 把子进程的 cwd 设成它（`processCwd`），cwd 不存在时 spawn 会失败
        const cwd = join(root, entry.kind, 'workspace');
        mkdirSync(cwd, { recursive: true });
        const result = await getProvider(entry.kind).run({
          cwd,
          configHome: join(root, entry.kind, '.agenthome'),
          permission: 'full',
          prompt: '只回复 done',
          route: {
            protocolType: entry.protocolType,
            baseUrl: `http://127.0.0.1:${gateway.port}/${entry.protocolType}`,
            apiKey: 'sk-smoke',
            modelId: entry.modelId,
          },
          modelRetries: MODEL_RETRIES,
          signal: new AbortController().signal,
          onEvent: () => {},
        });

        const inbound = gateway.seen.slice(before).filter((one) => one.url.includes('/messages') || one.url.includes('/responses'));
        // 条数就是判据：1 条 = 一次都没重试（键没生效 / 被厂商忽略）；2 条 = 把「重试几次」读成了「总共几次」
        expect(
          inbound.length,
          `${entry.kind} 的模型请求条数不对（run: ${JSON.stringify(result.error ?? result.exitReason)}；`
            + `入站：${JSON.stringify(gateway.seen.slice(before).map((one) => one.url))}）`,
        ).toBe(MODEL_RETRIES + 1);
        expect(result.ok, `${entry.kind} 重试用满后仍然失败：${result.error?.message ?? result.exitReason}`).toBe(true);
      },
      TIMEOUT_MS,
    );
  }
});
