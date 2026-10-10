// @vitest-environment node
/**
 * 路由层端到端：`POST /api/settings/mcp/test`。
 *
 * 这份用例存在的理由与 `route-settings.test.ts` 同款，外加一条本路由独有的：
 * **探活失败必须是 HTTP 200**。把它折成 4xx/5xx 的话，客户端 `postJson` 会走 `toServiceError`，
 * 界面上只剩一句中文 message —— 而失败文案是**两段式**的，第二段（厂商原文）只在响应体里。
 * 这条口径只有在真路由上跑一遍才钉得住（服务层单测里没有 HTTP 状态码这回事）。
 *
 * http 那一路走 `fetch` 替身（不联外网）；stdio 那一路走真子进程夹具（`node -e` 说一句合法
 * MCP 响应）—— 真跑一次握手能把「机制在 core、策略在 api、路由只转发」整条链验通，
 * 而它是本路由唯一不依赖外网的端到端路径。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, saveConfig, setConfigDirForTesting } from '@aieval/core';
import { POST } from '@/app/api/settings/mcp/test/route';
import { removeTreeWithRetry } from './testing/cleanup';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aieval-route-mcp-'));
  setConfigDirForTesting(dir);
});

afterEach(() => {
  setConfigDirForTesting(null);
  vi.unstubAllGlobals();
  removeTreeWithRetry(dir);
});

/** 用真实的 Request 全局构造请求，和 Next 交给路由的入参同形 */
function postRequest(body: string): Request {
  return new Request('http://localhost/api/settings/mcp/test', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
}

/** http 端点的替身：三步响应固定，`notifications/initialized` 回 202 空体 */
function stubHttpEndpoint(): void {
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit): Promise<Response> => {
    const method = (JSON.parse(String(init.body)) as { method: string }).method;
    if (method === 'notifications/initialized') {
      return new Response('', { status: 202, headers: { 'content-type': 'application/json' } });
    }
    const result =
      method === 'initialize'
        ? { protocolVersion: '2025-06-18', serverInfo: { name: 'Context7', version: '4.3.0' } }
        : method === 'tools/list'
          ? { tools: [{ name: 'resolve-library-id' }] }
          : { content: [{ type: 'text', text: 'ok' }] };
    const id = method === 'initialize' ? 1 : method === 'tools/list' ? 2 : 3;
    return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id, result })}\n\n`, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  });
}

describe('POST /api/settings/mcp/test', () => {
  it('{name} 用已保存的那份：200 + 成功形状（档位 / 服务器自述 / 工具数 / 耗时）', async () => {
    const config = loadConfig();
    saveConfig({
      ...config,
      settings: {
        ...config.settings,
        mcpServers: {
          context7: { transport: 'http', enabled: true, url: 'https://mcp.context7.com/mcp' },
        },
      },
    });
    stubHttpEndpoint();

    const res = await POST(postRequest('{"name":"context7"}'));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.tier).toBe('http+call');
    expect(body.serverName).toBe('Context7');
    expect(body.toolCount).toBe(1);
    expect(typeof body.elapsedMs).toBe('number');
    expect(Array.isArray(body.notes)).toBe(true);
  });

  it('{entry} 走表单当前值：不落盘，配置里那份一字未动', async () => {
    const before = JSON.stringify(loadConfig().settings.mcpServers);
    stubHttpEndpoint();

    const res = await POST(
      postRequest('{"entry":{"transport":"http","url":"https://form.example.com/mcp","enabled":true}}'),
    );

    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
    expect(JSON.stringify(loadConfig().settings.mcpServers)).toBe(before);
  });

  it('**探活失败也是 200**：失败以 body.failure 返回（两段式文案的第二段只在体里）', async () => {
    vi.stubGlobal('fetch', async (): Promise<Response> => {
      return new Response('{"error":"not_found","message":"Endpoint not found. Use /mcp for MCP protocol communication."}', {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    });

    const res = await POST(postRequest('{"entry":{"transport":"http","url":"https://mcp.context7.com/nope","enabled":true}}'));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(false);
    expect(body.failure.tier).toBe('not-found');
    expect(body.failure.message).toBe('端点不存在（HTTP 404）');
    expect(body.failure.vendorText).toContain('Endpoint not found.');
  });

  it('两个都不给 ⇒ 400 INVALID_QUERY（请求本身错了，和「连不上」不是一回事）', async () => {
    const res = await POST(postRequest('{}'));

    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('INVALID_QUERY');
  });

  it('名字指向不存在的条目 ⇒ 404 NOT_FOUND + 中文原因', async () => {
    const res = await POST(postRequest('{"name":"nope"}'));
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.message).toContain('nope');
  });

  it('stdio 真子进程握手：整条链（路由 → api 策略 → core 机制）跑通并拿到工具数', async () => {
    // 夹具：一条真 node 子进程，按行协议回 initialize 与 tools/list（不联外网、不拉依赖）
    const script = [
      'const rl = require(\'node:readline\').createInterface({ input: process.stdin });',
      'rl.on("line", (line) => {',
      '  const msg = JSON.parse(line);',
      '  const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");',
      '  if (msg.method === "initialize") send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", serverInfo: { name: "Fixture", version: "1.2.3" } } });',
      '  if (msg.method === "tools/list") send({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "a" }, { name: "b" }] } });',
      '});',
    ].join('\n');

    const res = await POST(
      postRequest(
        JSON.stringify({
          entry: { transport: 'stdio', enabled: true, command: process.execPath, args: ['-e', script] },
        }),
      ),
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.tier).toBe('A');
    expect(body.serverName).toBe('Fixture');
    expect(body.toolCount).toBe(2);
  });
});
