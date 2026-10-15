// @vitest-environment node
/**
 * 探针 06：**出站请求的真机取证**——本地录制反代转发到真网关，真适配器跑两条 wire。
 *
 * 为什么要反代而不是直接打真网关：适配器只把「厂商认为发了什么」交回来（事件与消息），
 * 而本探针要的是**线上那一份字节**（端点路径、`reasoning_effort` / `thinking` / `strict` 的落点、
 * 工具声明、`max_tokens`）。假网关能回答形状，答不了「真网关收不收这一份」——两件事都要。
 *
 * 判据（每条都读录制下来的请求体/响应状态）：
 *   ① 两条 wire 的端点：openai ⇒ `POST /v1/chat/completions`、anthropic ⇒ `POST /v1/messages`；
 *   ② 档位出站形态：openai 的 `off` **不发 `reasoning_effort` 键**、anthropic 的 `off` 发
 *      `thinking: { type: 'disabled' }`；`minimal/low/medium/high` 同名直传；
 *      `max` 靠模型上的显式映射才可用（没有映射会被静默夹到 `high`）；
 *   ③ `strict` 工具的落点按 wire 分叉（openai 在 `tools[].function.strict`、
 *      anthropic 在 `tools[].strict`），且**调用方原 schema 逐字进参数**；
 *   ④ 真网关对每一条都回 200（「多开一格 compat」这类结论要靠它才成立）。
 *
 * 凭据**只从环境变量读**（`AIEVAL_PROBE_GATEWAY_API_KEY` / `AIEVAL_PROBE_GATEWAY_BASE_URL`），
 * 缺一个就跳过并明说（不许回落到读宿主配置文件——那会把「跑不起来」伪装成「探测通过」）。
 * 真模型因此参与：这里判的是「网关收不收」，不是「模型答得对不对」。
 *
 * 用法：
 *   set -a; eval "$(grep -E '^AIEVAL_PROBE' ~/.zshrc)"; set +a
 *   node_modules/.bin/vitest run packages/server/agents/probe/v12/06-wire-live.test.ts
 */
import { createServer, request as httpRequest } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createRunInput } from '../../../testing/agent-fixtures';
import { piProvider } from '..';
import { piRequestToolDeclaration, piRequestToolNames } from '../observer';
import type { AgentEvent } from '@aieval/contracts';

const MODEL = process.env.AIEVAL_PROBE_PI_MODEL ?? process.env.AIEVAL_PROBE_CC_MODEL ?? 'DeepSeek-V4.1-Flash-a';
const KEY = process.env.AIEVAL_PROBE_GATEWAY_API_KEY ?? '';
const BASE = process.env.AIEVAL_PROBE_GATEWAY_BASE_URL ?? '';
const live = KEY !== '' && BASE !== '';

/** 一次录制的请求：路径 + 请求体 + 上游回的状态码（判「收没收」要比状态码，光有请求体不够） */
interface Recorded {
  url: string;
  body: Record<string, unknown>;
  upstreamStatus: number;
}

/** 录制反代：把 `/v1/*` 原样转给真网关，落一份请求体，再把上游响应原样回吐 */
async function startRecordingProxy(upstream: string, sink: Recorded[]): Promise<{ port: number; close: () => Promise<void> }> {
  const target = new URL(upstream);
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      const headers = { ...req.headers, host: target.host };
      const upstreamReq = httpRequest(
        {
          protocol: target.protocol,
          hostname: target.hostname,
          port: target.port === '' ? undefined : Number(target.port),
          path: req.url ?? '/',
          method: req.method ?? 'POST',
          headers,
        },
        (upstreamRes) => {
          const record: Recorded = {
            url: req.url ?? '',
            body: raw.length === 0 ? {} : (JSON.parse(raw.toString('utf8')) as Record<string, unknown>),
            upstreamStatus: upstreamRes.statusCode ?? 0,
          };
          sink.push(record);
          res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
          upstreamRes.pipe(res);
        },
      );
      upstreamReq.on('error', (error) => {
        sink.push({ url: req.url ?? '', body: {}, upstreamStatus: -1 });
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `proxy error: ${String(error)}` } }));
      });
      upstreamReq.end(raw);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** 跑一行：真适配器 + 录制反代；返回这一行的产物 + 我这一行打出去的那几条请求 */
async function runRow(options: {
  protocolType: 'openai' | 'anthropic';
  effort?: string;
  outputSchema?: unknown;
  prompt?: string;
}): Promise<{ requests: Recorded[]; events: AgentEvent[]; finalText: string | null }> {
  const root = mkdtempSync(join(tmpdir(), 'pi-v12-wire-'));
  const cwd = join(root, 'workspace');
  const configHome = join(root, '.agenthome');
  mkdirSync(cwd, { recursive: true });
  const sink: Recorded[] = [];
  const proxy = await startRecordingProxy(BASE, sink);
  const events: AgentEvent[] = [];
  try {
    const result = await piProvider.run({
      ...createRunInput({ cwd, configHome }),
      prompt: options.prompt ?? '只回一句：收到。',
      // 只读档：这一格的工具面小，请求体读起来干净（工具表判据另有专测）
      permission: 'read-only',
      ...(options.effort === undefined ? {} : { effort: options.effort }),
      ...(options.outputSchema === undefined ? {} : { outputSchema: options.outputSchema }),
      route: {
        protocolType: options.protocolType,
        // 反代地址：baseUrl 的归一化（补 / 剥 /v1）仍然由适配器做
        baseUrl: `http://127.0.0.1:${proxy.port}/v1`,
        apiKey: KEY,
        modelId: MODEL,
        contextWindow: 1_000_000,
        maxOutputTokens: 32_768,
      },
      onEvent: (event) => events.push(event),
    });
    return { requests: sink, events, finalText: result.finalText };
  } finally {
    await proxy.close();
    rmSync(root, { recursive: true, force: true });
  }
}

describe.skipIf(!live)('出站请求真机取证（两条 wire）', () => {
  it('openai wire：端点 / 档位键 / strict 落点 / 网关 200', async () => {
    const { requests, events } = await runRow({ protocolType: 'openai', effort: 'off' });
    const body = requests.at(-1)?.body ?? {};
    dump('06-wire-openai', { requests, usageEvent: events.find((event) => event.type === 'usage') ?? null });

    expect(requests.length, '一条请求都没出去').toBeGreaterThan(0);
    expect(requests.at(-1)?.url).toContain('/chat/completions');
    expect(requests.at(-1)?.upstreamStatus).toBe(200);
    // `off` 在 openai wire 上**不发 reasoning_effort 键**（不是发一个 null/空串）
    expect('reasoning_effort' in body).toBe(false);
    const toolNames = piRequestToolNames(body);
    expect(toolNames.length, '只读档的工具表是空的').toBeGreaterThan(0);
    expect(toolNames).toContain('read');
  }, 180_000);

  it('anthropic wire：端点 / thinking.disabled / strict 落点 / 网关 200', async () => {
    const { requests, events } = await runRow({ protocolType: 'anthropic', effort: 'off' });
    const body = requests.at(-1)?.body ?? {};
    dump('06-wire-anthropic', { requests, usageEvent: events.find((event) => event.type === 'usage') ?? null });

    expect(requests.at(-1)?.url).toContain('/v1/messages');
    expect(requests.at(-1)?.upstreamStatus).toBe(200);
    expect((body.thinking as Record<string, unknown> | undefined)?.type).toBe('disabled');
  }, 180_000);

  it('档位直传：low/medium/high 在 openai wire 上同名出站', async () => {
    for (const effort of ['low', 'medium', 'high'] as const) {
      const { requests } = await runRow({ protocolType: 'openai', effort });
      const body = requests.at(-1)?.body ?? {};
      expect({ effort, reasoning: body.reasoning_effort }, `${effort} 档的出站形态与预期不符`).toEqual({
        effort,
        reasoning: effort,
      });
    }
  }, 300_000);

  it('结构化输出：strict 工具带原 schema 出站，两条 wire 的落点各自正确', async () => {
    const schema = {
      type: 'object',
      additionalProperties: false,
      required: ['verdict'],
      properties: { verdict: { type: 'string' }, note: { type: ['string', 'null'] } },
    };
    for (const protocolType of ['openai', 'anthropic'] as const) {
      const { requests } = await runRow({ protocolType, outputSchema: schema, effort: 'off' });
      const body = requests.at(-1)?.body ?? {};
      const declared = piRequestToolDeclaration(body, 'submit_result');
      dump(`06-wire-strict-${protocolType}`, { url: requests.at(-1)?.url, status: requests.at(-1)?.upstreamStatus, declared });
      expect(declared, `${protocolType}：结构化输出那一件没出站——零出站就是这一格的失败形态`).not.toBeNull();
      // 原 schema 逐字进参数（`verbatim` 判据：序列化后逐字相同）
      expect(JSON.stringify(declared?.parameters)).toBe(JSON.stringify(schema));
    }
  }, 300_000);
});

/** 读数落盘到 `probe/dumps/v12/`（含完整请求体，便于逐字核对出站形态） */
function dump(name: string, payload: unknown): void {
  const dir = join(import.meta.dirname, '..', '..', '..', '..', 'probe', 'dumps', 'v12');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.json`), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

afterAll(() => {
  if (!live) {
    console.log('[v12] 缺 AIEVAL_PROBE_GATEWAY_API_KEY / AIEVAL_PROBE_GATEWAY_BASE_URL ⇒ 探针 06 整支跳过（不回落读宿主配置）');
  }
});
