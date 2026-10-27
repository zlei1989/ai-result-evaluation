// @vitest-environment node
/**
 * 真机冒烟：**自定义请求头有没有真的发到网关**（真 CLI + 本地假网关 + 产品那条 `agentProvider.run`）。
 *
 * 为什么单测不够：四家的落点守卫证明的是「我们把头填进了厂商的那个参数 / 文件 / 环境变量」，
 * 而「厂商真的把它发到了请求上」是另一件事——SDK 的读法可能只在某个域名下生效、CLI 可能把那一格当
 * 未知字段丢掉、打包器可能改写解析路径。这些差异单测一律看不见（正是本仓「测试环境 ≠ 运行环境」那条）。
 * 这里量的是**假网关收到的入站请求头**，那是这一段链路上最硬的一件事。
 *
 * 开关（默认跳过，避免进内循环与 CI）：
 * ```
 * AIEVAL_LIVE_HEADERS=1 pnpm vitest run packages/server/agents/src/request-headers-live.test.ts
 * ```
 * 可选的 `AIEVAL_LIVE_HEADERS_KINDS=cc,codex,dsh,pi` 圈定要跑哪几家（缺省四家全跑）。
 *
 * 边界：网关是**本地假的上游**（按路径回最小 SSE，两条 wire 各一种）。只把模型那一端脚本化，
 * 厂商侧（SDK 装载、子进程、会话装配、请求构造）走的全是真包。四家缺一不可地**各自跑一次**——
 * 某一家在本机起不来时该家用例**红**而不是跳过：跳过会让人把「没跑」读成「跑过了」。
 *
 * ⚠️ **一家红先看是哪一等失败**：这条用例先把「有没有打到网关」单独断言，就是为了不把
 * 「厂商进程根本没起来」（本机打包件 / 沙箱 / 冷启动的偶发）读成「头没到」。真机上见过
 * cc 的打包二进制偶发启动失败（`exists but failed to launch`），单跑重试即可——那不是本功能的缺陷，
 * 是那一层启动的问题；判据是重试后是否稳定绿。
 */
import { createServer, type IncomingHttpHeaders } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgentKind, ProtocolType } from './types';
import { getProvider } from './registry';

const ENABLED = process.env.AIEVAL_LIVE_HEADERS === '1';
const HEADER_NAME = 'x-aieval-smoke';
const HEADER_VALUE = 'custom-header-smoke-1';
/** 真实运行一次的上限：模型那一端是脚本化的，本机一次只要几秒；给足冷启动（首次 spawn CLI）的余量 */
const TIMEOUT_MS = 180_000;

/** 一条入站请求：路径 + 头 + 原文（正文不用，但留着便于排障） */
interface Captured {
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

/** 本地假网关：记下每一次入站请求，按路径回一条最小 SSE（anthropic messages / openai responses 两种） */
function startGateway(): Promise<{ seen: Captured[]; port: number; close: () => Promise<void> }> {
  const seen: Captured[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      seen.push({ url: req.url ?? '', headers: { ...req.headers }, body });
      const url = req.url ?? '';
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
        // Responses wire：消息项 + 正文增量 + 终止响应（`status: 'completed'` 是 stopReason 的来源）。
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

const requested = (process.env.AIEVAL_LIVE_HEADERS_KINDS ?? '')
  .split(',')
  .map((one) => one.trim())
  .filter((one) => one !== '');
const selected = requested.length === 0 ? KINDS : KINDS.filter((one) => requested.includes(one.kind));

let gateway: Awaited<ReturnType<typeof startGateway>>;
let root = '';

beforeAll(async () => {
  if (!ENABLED) return;
  gateway = await startGateway();
  root = mkdtempSync(join(tmpdir(), 'aieval-header-live-'));
});

afterAll(async () => {
  if (!ENABLED) return;
  await gateway.close();
  rmSync(root, { recursive: true, force: true });
});

describe.skipIf(!ENABLED)('真机：自定义请求头真的发到了网关', () => {
  for (const entry of selected) {
    it(
      `${entry.kind}：入站请求上带着 ${HEADER_NAME}`,
      async () => {
        if (gateway === undefined) throw new Error('网关没有起起来（见 beforeAll）');
        const before = gateway.seen.length;
        // 工作区**先建好**：dsh 把子进程的 cwd 设成它（`processCwd`），cwd 不存在时 spawn 会失败；
        // 生产路径上由 `prepareCandidateWorkspace` 建，这里冒烟得自己先建一份
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
          requestHeaders: { 'X-Aieval-Smoke': HEADER_VALUE },
          signal: new AbortController().signal,
          onEvent: () => {},
        });

        const inbound = gateway.seen.slice(before);
        // 先报「有没有打到网关」：一次请求都没有时，下面那条「头没到」会产生误导性的归因
        expect(inbound.length, `${entry.kind} 一次请求都没打到网关（run 结果：${JSON.stringify(result.error ?? result.exitReason)}）`).toBeGreaterThan(0);
        const landed = inbound.filter((one) => one.headers[HEADER_NAME] === HEADER_VALUE);
        const observed = inbound.map((one) => `${one.url} → ${Object.keys(one.headers).filter((name) => name.startsWith('x-')).join(',')}`);
        expect(landed.length, `${entry.kind} 的入站请求上没看到 ${HEADER_NAME}（实际：${JSON.stringify(observed)}）`).toBeGreaterThan(0);
      },
      TIMEOUT_MS,
    );
  }
});
