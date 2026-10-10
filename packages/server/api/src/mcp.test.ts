// @vitest-environment node
/**
 * MCP 探活服务：入口二选一、失败分档（十档 + 两档兜底）、补充说明、超时与**串行**。
 *
 * 两条夹具口径：
 *   · **http 走真 `fetch` 接口的替身**（`vi.stubGlobal`）：判据全在「发了什么 / 收到什么」上，
 *     用替身能把 404 / 405 / 401 / 429 / 200-非 MCP / 200-软错误六种形状逐条造出来
 *     （真跑一遍要外网、要真 key，且六种形状里有一半造不出来）；
 *   · **stdio 换掉 core 的 `probeMcpStdio`**（只换这一个导出，其余导出原样透传）：
 *     core 已经在自己的用例里用**真子进程**验过机制，这里要验的是「拿到哪种信号 ⇒ 说哪句话」。
 *     ⚠️ 与 `settings.test.ts` 同一条坑：`vi.mock` 的前置提升**只作用于本文件**。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MCP_PROBE_NOTES,
  MCP_PROBE_TIMEOUT_MS,
  ServiceError,
  type McpProbeResult,
  type McpServerConfig,
} from '@aieval/contracts';
import { McpStdioProbeError, loadConfig, saveConfig, setConfigDirForTesting } from '@aieval/core';
import { probeMcpServer } from './mcp';
import { removeTreeWithRetry } from './testing/cleanup';

vi.mock('@aieval/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aieval/core')>();
  return { ...actual, probeMcpStdio: vi.fn(actual.probeMcpStdio) };
});

const { probeMcpStdio } = await import('@aieval/core');
const probeMock = vi.mocked(probeMcpStdio);

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aieval-mcp-'));
  setConfigDirForTesting(dir);
  probeMock.mockReset();
});

afterEach(() => {
  setConfigDirForTesting(null);
  vi.unstubAllGlobals();
  vi.useRealTimers();
  removeTreeWithRetry(dir);
});

/** 一次 HTTP 步骤的替身返回：给 `raw` 就直接用它当体（造 HTML / 空体），否则按 json 序列化 */
interface StubStep {
  status?: number;
  json?: unknown;
  raw?: string;
  contentType?: string;
  headers?: Record<string, string>;
  /** 网络层失败：以这个 errno 构造 `TypeError: fetch failed` 的 cause */
  networkError?: string;
  /** 一直不返回（等 abort）；超时用例用它 */
  hang?: boolean;
}

type StepName = 'initialize' | 'notifications/initialized' | 'tools/list' | 'tools/call';

interface RecordedCall {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/** 三步响应的默认形状：SSE + 合法 MCP（context7 实测就是 SSE） */
const SSE_CONTENT_TYPE = 'text/event-stream';

function sseFrame(json: unknown): string {
  return `event: message\ndata: ${JSON.stringify(json)}\n\n`;
}

/**
 * 装一个「会说 MCP 的 http 端点」替身：按请求体里的 `method` 分派，并记录每次调用。
 * 默认成功路径三步齐全；要给某一步换形状就传 `steps` 覆盖。
 */
function installEndpoint(steps: Partial<Record<StepName, StubStep>> = {}): { calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const defaults: Record<StepName, StubStep> = {
    initialize: {
      json: {
        jsonrpc: '2.0',
        id: 1,
        result: {
          protocolVersion: '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'Context7', version: '4.3.0' },
        },
      },
    },
    'notifications/initialized': { status: 202, raw: '' },
    'tools/list': {
      json: {
        jsonrpc: '2.0',
        id: 2,
        result: { tools: [{ name: 'resolve-library-id' }, { name: 'query-docs' }] },
      },
    },
    'tools/call': {
      json: {
        jsonrpc: '2.0',
        id: 3,
        result: { content: [{ type: 'text', text: 'Available Libraries: - Title: React' }] },
      },
    },
  };

  vi.stubGlobal('fetch', async (url: string, init: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    const method = String(body.method) as StepName;
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>));
    calls.push({ method, url: String(url), headers, body });

    const step = { ...defaults[method], ...(steps[method] ?? {}) };
    if (step.hang === true) {
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    }
    if (step.networkError !== undefined) {
      const cause = Object.assign(new Error(`getaddrinfo ${step.networkError}`), { code: step.networkError });
      throw new TypeError('fetch failed', { cause });
    }
    const contentType = step.contentType ?? SSE_CONTENT_TYPE;
    const text = step.raw ?? (contentType.includes('text/event-stream') ? sseFrame(step.json) : JSON.stringify(step.json));
    return new Response(text, { status: step.status ?? 200, headers: { 'content-type': contentType, ...(step.headers ?? {}) } });
  });

  return { calls };
}

const HTTP_ENTRY: McpServerConfig = {
  transport: 'http',
  enabled: true,
  url: 'https://mcp.context7.com/mcp',
  headers: { CONTEXT7_API_KEY: 'ctx7sk-secret-value' },
};

const STDIO_ENTRY: McpServerConfig = {
  transport: 'stdio',
  enabled: true,
  command: 'npx',
  args: ['-y', '@playwright/mcp@latest', '--browser=chrome', '--isolated'],
};

/** stdio 成功：core 的返回形状（serverInfo 与工具数） */
const STDIO_OK = {
  serverName: 'Playwright',
  serverVersion: '1.64.0',
  protocolVersion: '2025-06-18',
  toolCount: 25,
  elapsedMs: 2_807,
  stderr: '',
  teardown: 'stdin-eof' as const,
};

/** 断言失败形状的三段（省得每条用例各写三行） */
function failureOf(result: McpProbeResult): { tier: string; message: string; vendorText: string } {
  if (result.failure === undefined) throw new Error(`期望失败，实际 ok=${String(result.ok)}`);
  return result.failure;
}

describe('入口二选一', () => {
  it('{name} 用已保存的那一份（含它的 url 与请求头）', async () => {
    saveConfig({ ...loadConfig(), settings: { ...loadConfig().settings, mcpServers: { context7: HTTP_ENTRY } } });
    const { calls } = installEndpoint();

    const result = await probeMcpServer({ name: 'context7' });

    expect(result.ok).toBe(true);
    expect(calls[0]?.url).toBe('https://mcp.context7.com/mcp');
    expect(calls[0]?.headers.CONTEXT7_API_KEY).toBe('ctx7sk-secret-value');
  });

  it('{name} 指向不存在的条目 ⇒ 中文 NOT_FOUND（不是「测试失败」，是请求本身错了）', async () => {
    const error = await probeMcpServer({ name: 'nope' }).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ServiceError);
    expect((error as ServiceError).code).toBe('NOT_FOUND');
    expect((error as ServiceError).message).toContain('nope');
  });

  it('{entry} 用表单当前值、**不落盘**：配置里那一份的地址一字未动', async () => {
    saveConfig({ ...loadConfig(), settings: { ...loadConfig().settings, mcpServers: { context7: HTTP_ENTRY } } });
    const { calls } = installEndpoint();

    const result = await probeMcpServer({
      entry: { transport: 'http', enabled: true, url: 'https://form.example.com/mcp' },
    });

    expect(result.ok).toBe(true);
    expect(calls[0]?.url).toBe('https://form.example.com/mcp');
    // 落盘那一份没被本次探测动过（单独取出来收窄，别写成一串 `&&` —— 那串表达式的类型是联合，断不到 url）
    const saved = loadConfig().settings.mcpServers.context7;
    expect(saved?.transport === 'http' ? saved.url : null).toBe('https://mcp.context7.com/mcp');
  });
});

describe('http 探活（档位 A + 一次只读调用）', () => {
  it('成功：三步握手 + 一次 resolve-library-id，档位 http+call，带服务器自述与工具数', async () => {
    const { calls } = installEndpoint();

    const result = await probeMcpServer({ entry: HTTP_ENTRY });

    expect(result.ok).toBe(true);
    expect(result.tier).toBe('http+call');
    expect(result.serverName).toBe('Context7');
    expect(result.serverVersion).toBe('4.3.0');
    expect(result.toolCount).toBe(2);
    expect(result.failure).toBeUndefined();
    expect(calls.map((call) => call.method)).toEqual([
      'initialize',
      'notifications/initialized',
      'tools/list',
      'tools/call',
    ]);
    // 三条发送口径：accept 同时声明两种（服务端可能回 SSE）、content-type 是 JSON
    expect(calls[0]?.headers.accept).toBe('application/json, text/event-stream');
    expect(calls[0]?.headers['content-type']).toBe('application/json');
  });

  it('只读调用的必填参给齐（query + libraryName）：少一个，Input validation error 会盖掉鉴权错误', async () => {
    const { calls } = installEndpoint();

    await probeMcpServer({ entry: HTTP_ENTRY });

    const call = calls.find((item) => item.method === 'tools/call');
    expect(call?.body.params).toEqual({
      name: 'resolve-library-id',
      arguments: { query: 'react hooks', libraryName: 'react' },
    });
  });

  it('端点没有已知的只读探测工具 ⇒ 档位如实停在 A，并说明「未校验密钥」', async () => {
    installEndpoint({ 'tools/list': { json: { jsonrpc: '2.0', id: 2, result: { tools: [{ name: 'search' }] } } } });

    const result = await probeMcpServer({ entry: HTTP_ENTRY });

    expect(result.tier).toBe('A');
    expect(result.toolCount).toBe(1);
    expect(result.notes).toContain(MCP_PROBE_NOTES.noReadonlyTool);
  });

  it('服务端下发 Mcp-Session-Id 时后续请求回带（协议允许有状态，读到就带、读不到就走无状态）', async () => {
    const { calls } = installEndpoint({
      initialize: {
        json: { jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-06-18', serverInfo: { name: 'S' } } },
        headers: { 'mcp-session-id': 'sess-42' },
      },
    });

    await probeMcpServer({ entry: HTTP_ENTRY });

    expect(calls[0]?.headers['mcp-session-id']).toBeUndefined();
    expect(calls[1]?.headers['mcp-session-id']).toBe('sess-42');
    expect(calls[3]?.headers['mcp-session-id']).toBe('sess-42');
  });

  it('404 ⇒ 端点不存在，厂商原文照抄（context7 风格体）', async () => {
    installEndpoint({
      initialize: {
        status: 404,
        contentType: 'application/json',
        raw: '{"error":"not_found","message":"Endpoint not found. Use /mcp for MCP protocol communication."}',
      },
    });

    const result = await probeMcpServer({ entry: HTTP_ENTRY });

    expect(result.ok).toBe(false);
    expect(failureOf(result).tier).toBe('not-found');
    expect(failureOf(result).message).toBe('端点不存在（HTTP 404）');
    expect(failureOf(result).vendorText).toContain('Endpoint not found. Use /mcp for MCP protocol communication.');
  });

  it('405 + text/html ⇒ 该地址不是 MCP 端点，原文里带着那页 HTML', async () => {
    installEndpoint({
      initialize: { status: 405, contentType: 'text/html', raw: '<!doctype html><h1>405</h1>' },
    });

    const result = await probeMcpServer({ entry: HTTP_ENTRY });

    expect(failureOf(result).tier).toBe('not-mcp-endpoint');
    expect(failureOf(result).message).toBe('该地址不是 MCP 端点（HTTP 405）');
    expect(failureOf(result).vendorText).toContain('<!doctype html>');
  });

  /**
   * 405 的判据是**两半**（`405` **+** `text/html`）。只按状态码判的话，
   * 一个「只认 POST / 某路径」的 MCP 网关会被说成「该地址不是 MCP 端点」——用户照着这句话换地址，
   * 换到哪儿都是同一个 405。宁可落兜底档少说一句，也不给一个改不好的结论。
   */
  it('405 但内容类型不是 text/html ⇒ 归兜底档（判据的另一半缺了就不下那个结论）', async () => {
    installEndpoint({
      initialize: { status: 405, contentType: 'application/json', raw: '{"error":"method_not_allowed"}' },
    });

    const result = await probeMcpServer({ entry: HTTP_ENTRY });

    expect(failureOf(result).tier).toBe('http-error');
    expect(failureOf(result).message).toBe('端点返回了 HTTP 错误（HTTP 405）');
    expect(failureOf(result).vendorText).toContain('method_not_allowed');
  });

  it('401 ⇒ 需要鉴权，`www-authenticate` 与体一起进厂商原文', async () => {
    installEndpoint({
      initialize: {
        status: 401,
        contentType: 'application/json',
        raw: '{"error":"missing required Authorization header"}',
        headers: { 'www-authenticate': 'Bearer error="invalid_request"' },
      },
    });

    const result = await probeMcpServer({ entry: HTTP_ENTRY });

    expect(failureOf(result).tier).toBe('auth');
    expect(failureOf(result).message).toBe('需要鉴权（HTTP 401）');
    expect(failureOf(result).vendorText).toContain('www-authenticate: Bearer error="invalid_request"');
    expect(failureOf(result).vendorText).toContain('missing required Authorization header');
  });

  it('429 ⇒ 被上游限流', async () => {
    installEndpoint({ initialize: { status: 429, contentType: 'text/plain', raw: 'slow down' } });

    const result = await probeMcpServer({ entry: HTTP_ENTRY });

    expect(failureOf(result).tier).toBe('rate-limited');
    expect(failureOf(result).message).toBe('被上游限流（HTTP 429）');
  });

  /**
   * 403 与 401 同档——这条同时钉住「判据是**共用**的」：分档走 `providers.ts` 的
   * `upstreamStatusErrorCode`（要求复用），那边少写一个 403 时这里与
   * `providers.test.ts` 会**同时**红。探活自己的中文结论（`需要鉴权`）不跟着变。
   */
  it('403 与 401 同档（判据复用 providers 的 upstreamStatusErrorCode，两条路径不各写一份）', async () => {
    installEndpoint({ initialize: { status: 403, contentType: 'text/plain', raw: 'forbidden' } });

    const result = await probeMcpServer({ entry: HTTP_ENTRY });

    expect(failureOf(result).tier).toBe('auth');
    expect(failureOf(result).message).toBe('需要鉴权（HTTP 403）');
    expect(failureOf(result).vendorText).toBe('forbidden');
  });

  it('其它非 2xx（表外）⇒ 兜底档，但仍是中文结论 + 状态码', async () => {
    installEndpoint({ initialize: { status: 502, contentType: 'text/plain', raw: 'bad gateway' } });

    const result = await probeMcpServer({ entry: HTTP_ENTRY });

    expect(failureOf(result).tier).toBe('http-error');
    expect(failureOf(result).message).toBe('端点返回了 HTTP 错误（HTTP 502）');
  });

  it('200 但不是 MCP（体里没有 jsonrpc / protocolVersion）⇒ 响应不是 MCP 协议', async () => {
    installEndpoint({ initialize: { status: 200, contentType: 'application/json', raw: '{"hello":"world"}' } });

    const result = await probeMcpServer({ entry: HTTP_ENTRY });

    expect(failureOf(result).tier).toBe('not-mcp');
    expect(failureOf(result).message).toContain('响应不是 MCP 协议');
    expect(failureOf(result).vendorText).toContain('{"hello":"world"}');
  });

  it('key 无效：HTTP 200 + 体里软错误（isError 是 null）⇒ 必须匹配文案，不能只看状态码', async () => {
    installEndpoint({
      'tools/call': {
        json: {
          jsonrpc: '2.0',
          id: 3,
          result: {
            content: [
              {
                type: 'text',
                text: 'Invalid API key. Please check your API key. API keys should start with \'ctx7sk\' prefix.',
              },
            ],
          },
        },
      },
    });

    const result = await probeMcpServer({ entry: HTTP_ENTRY });

    expect(result.ok).toBe(false);
    expect(result.tier).toBe('http+call');
    expect(failureOf(result).tier).toBe('invalid-key');
    expect(failureOf(result).message).toBe('API key 无效');
    // 两段式的第二段：厂商那句话原样照抄（FAQ 按原文索引）
    expect(failureOf(result).vendorText).toBe(
      'Invalid API key. Please check your API key. API keys should start with \'ctx7sk\' prefix.',
    );
  });

  it('只读调用返回认不出的错误（isError: true）⇒ 兜底档 tool-call-failed', async () => {
    installEndpoint({
      'tools/call': {
        json: { jsonrpc: '2.0', id: 3, result: { isError: true, content: [{ type: 'text', text: 'quota exceeded' }] } },
      },
    });

    const result = await probeMcpServer({ entry: HTTP_ENTRY });

    expect(failureOf(result).tier).toBe('tool-call-failed');
    expect(failureOf(result).vendorText).toBe('quota exceeded');
  });

  it('域名解析失败 ⇒ 网络档，原文带 ENOTFOUND', async () => {
    installEndpoint({ initialize: { networkError: 'ENOTFOUND' } });

    const result = await probeMcpServer({ entry: HTTP_ENTRY });

    expect(failureOf(result).tier).toBe('network');
    expect(failureOf(result).message).toContain('域名解析或网络不可达');
    expect(failureOf(result).vendorText).toContain('ENOTFOUND');
  });

  it('挂住不返回 ⇒ 超时档，中文结论带「已等待 15 s」，且计时器罩住整段等待', async () => {
    installEndpoint({ initialize: { hang: true } });
    vi.useFakeTimers();

    const pending = probeMcpServer({ entry: HTTP_ENTRY });
    await vi.advanceTimersByTimeAsync(MCP_PROBE_TIMEOUT_MS.http + 10);
    const result = await pending;

    expect(result.ok).toBe(false);
    expect(failureOf(result).tier).toBe('timeout');
    expect(failureOf(result).message).toBe('超时（已等待 15 s）');
    expect(result.elapsedMs).toBeGreaterThanOrEqual(MCP_PROBE_TIMEOUT_MS.http);
  });
});

describe('stdio 探活（保持 A 档）', () => {
  it('成功：握手拿回 serverInfo 与工具数，并写明「只做握手、浏览器通道未校验」', async () => {
    probeMock.mockResolvedValue(STDIO_OK);

    const result = await probeMcpServer({ entry: STDIO_ENTRY });

    expect(result.ok).toBe(true);
    expect(result.tier).toBe('A');
    expect(result.serverName).toBe('Playwright');
    expect(result.toolCount).toBe(25);
    // stdio 侧**不**叠只读调用：playwright MCP 没有「只读且不启浏览器」的探测工具
    expect(result.notes).toContain(MCP_PROBE_NOTES.stdioHandshakeOnly);
  });

  it('command 含 npx ⇒ 附一行「首次启动还要下载依赖」', async () => {
    probeMock.mockResolvedValue(STDIO_OK);

    const result = await probeMcpServer({ entry: STDIO_ENTRY });

    expect(result.notes).toContain(MCP_PROBE_NOTES.npxFirstRun);
  });

  it('command 不含 npx/npm ⇒ 不附那一行（无关的话不说）', async () => {
    probeMock.mockResolvedValue(STDIO_OK);

    const result = await probeMcpServer({
      entry: { transport: 'stdio', enabled: true, command: 'uvx', args: ['mcp-server-fetch'] },
    });

    expect(result.notes).not.toContain(MCP_PROBE_NOTES.npxFirstRun);
  });

  it('ENOENT ⇒ 命令无法启动，厂商原文是 Node 的原话', async () => {
    probeMock.mockRejectedValue(
      new McpStdioProbeError('spawn', 'spawn npx ENOENT', { code: 'ENOENT' }),
    );

    const result = await probeMcpServer({ entry: STDIO_ENTRY });

    expect(failureOf(result).tier).toBe('spawn');
    expect(failureOf(result).message).toBe('命令无法启动');
    expect(failureOf(result).vendorText).toContain('spawn npx ENOENT');
  });

  it('npx 非零退出 ⇒ 依赖拉取失败，stderr 原文进第二段', async () => {
    probeMock.mockRejectedValue(
      new McpStdioProbeError('exited', 'MCP 服务在握手完成前退出（exit code 1）', {
        code: 1,
        stderr: 'npm error code E404\nnpm error 404 Not Found - GET https://registry/x',
      }),
    );

    const result = await probeMcpServer({ entry: STDIO_ENTRY });

    expect(failureOf(result).tier).toBe('dependency');
    expect(failureOf(result).message).toBe('依赖拉取失败（exit code 1）');
    expect(failureOf(result).vendorText).toContain('npm error 404 Not Found');
  });

  it('非 npx 的命令早退 ⇒ 归「命令无法启动」而不是「依赖拉取失败」', async () => {
    probeMock.mockRejectedValue(
      new McpStdioProbeError('exited', 'MCP 服务在握手完成前退出（exit code 3）', { code: 3, stderr: 'bad flag' }),
    );

    const result = await probeMcpServer({
      entry: { transport: 'stdio', enabled: true, command: 'uvx', args: ['--nope'] },
    });

    expect(failureOf(result).tier).toBe('spawn');
    expect(failureOf(result).message).toBe('命令无法启动（exit code 3）');
    expect(failureOf(result).vendorText).toBe('bad flag');
  });

  /**
   * 「握手前退出」（`code === null`：进程没给出退出码就没了）**不算**依赖拉取失败——
   * 这一档逐字归在「命令无法启动」里。症状差别很实在：拉包失败要等下载、
   * 要查 registry；起不来要查命令名与参数。这里连 stderr 都带着 npm 的原文，
   * 但「没有退出码」这一条就把结论压回了起不来那一档。
   */
  it('npx 的「握手前退出」（没有退出码）⇒ 命令无法启动，不是依赖拉取失败', async () => {
    probeMock.mockRejectedValue(
      new McpStdioProbeError('exited', 'MCP 服务在握手完成前退出', {
        code: null,
        stderr: 'npm error code E404',
      }),
    );

    const result = await probeMcpServer({ entry: STDIO_ENTRY });

    expect(failureOf(result).tier).toBe('spawn');
    expect(failureOf(result).message).toBe('命令无法启动（握手前退出）');
  });

  it('npx 以 0 退出 ⇒ 命令无法启动（正常收工，问题在命令本身而不是下载）', async () => {
    probeMock.mockRejectedValue(
      new McpStdioProbeError('exited', 'MCP 服务在握手完成前退出（exit code 0）', {
        code: 0,
        stderr: 'Usage: playwright-mcp [options]',
      }),
    );

    const result = await probeMcpServer({ entry: STDIO_ENTRY });

    expect(failureOf(result).tier).toBe('spawn');
    expect(failureOf(result).message).toBe('命令无法启动（exit code 0）');
  });

  /**
   * 判据是**两半**：npx/npm **非零退出 + stderr**。没有 stderr 就没有厂商原话可抄，
   * 那种失败归「起不来」更诚实（`dependency` 这一档的下一句话是「去看 npm 报了什么」，而这里没有）。
   */
  it('npx 非零退出但没有 stderr ⇒ 命令无法启动（判据的另一半缺了）', async () => {
    probeMock.mockRejectedValue(
      new McpStdioProbeError('exited', 'MCP 服务在握手完成前退出（exit code 1）', { code: 1 }),
    );

    const result = await probeMcpServer({ entry: STDIO_ENTRY });

    expect(failureOf(result).tier).toBe('spawn');
    expect(failureOf(result).message).toBe('命令无法启动（exit code 1）');
    // 没有 stderr 时第二段抄的是我们自己的那句话（Node 的原话在 message 里）
    expect(failureOf(result).vendorText).toBe('MCP 服务在握手完成前退出（exit code 1）');
  });

  it('握手超时 ⇒ 超时档带「已等待 30 s」（stdio 预算是 30 s）', async () => {
    probeMock.mockRejectedValue(new McpStdioProbeError('timeout', '等待 npx 的响应超时'));

    const result = await probeMcpServer({ entry: STDIO_ENTRY });

    expect(failureOf(result).tier).toBe('timeout');
    expect(failureOf(result).message).toBe('超时（已等待 30 s）');
  });

  it('回了非 MCP 的东西 ⇒ 响应不是 MCP 协议', async () => {
    probeMock.mockRejectedValue(
      new McpStdioProbeError('protocol', 'initialize 的响应里没有 result.protocolVersion', { stderr: '{"ok":true}' }),
    );

    const result = await probeMcpServer({ entry: STDIO_ENTRY });

    expect(failureOf(result).tier).toBe('not-mcp');
    expect(failureOf(result).vendorText).toBe('{"ok":true}');
  });

  it('把条目的 env 交给 core，超时预算用 stdio 的 30 s（不是 http 的 15 s）', async () => {
    probeMock.mockResolvedValue(STDIO_OK);

    await probeMcpServer({
      entry: { transport: 'stdio', enabled: true, command: 'npx', args: ['-y', 'x'], env: { NODE_ENV: 'production' } },
    });

    expect(probeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'npx',
        args: ['-y', 'x'],
        env: { NODE_ENV: 'production' },
        timeoutMs: MCP_PROBE_TIMEOUT_MS.stdio,
      }),
    );
  });
});

describe('补充说明与占位符', () => {
  it('停用条目仍可测，并写明「已停用，不会注入」', async () => {
    const { calls } = installEndpoint();

    const result = await probeMcpServer({ entry: { ...HTTP_ENTRY, enabled: false } });

    expect(result.ok).toBe(true);
    expect(result.notes).toContain(MCP_PROBE_NOTES.disabled);
    // 「仍可测」= 真的发出去了，而不是提前返回一句「已停用」
    expect(calls.length).toBeGreaterThan(0);
  });

  it('${VAR} 占位在宿主环境里没设置 ⇒ 不带这个头，并说明原因', async () => {
    delete process.env.AIEVAL_PROBE_TEST_KEY;
    const { calls } = installEndpoint();

    const result = await probeMcpServer({
      entry: {
        transport: 'http',
        enabled: true,
        url: 'https://mcp.context7.com/mcp',
        headers: { CONTEXT7_API_KEY: '${AIEVAL_PROBE_TEST_KEY}' },
      },
    });

    expect(calls[0]?.headers.CONTEXT7_API_KEY).toBeUndefined();
    expect(result.notes).toContain(MCP_PROBE_NOTES.envUnset('AIEVAL_PROBE_TEST_KEY'));
    // 一个敏感值都没带上 ⇒ 必须说清「这是匿名探测」，别让「连通」被读成「密钥可用」
    expect(result.notes).toContain(MCP_PROBE_NOTES.anonymous);
  });

  it('${VAR} 设置了就带真值（占位只在探测时解析，配置里存的仍是那串字面）', async () => {
    process.env.AIEVAL_PROBE_TEST_KEY = 'ctx7sk-real';
    try {
      const { calls } = installEndpoint();

      await probeMcpServer({
        entry: {
          transport: 'http',
          enabled: true,
          url: 'https://mcp.context7.com/mcp',
          headers: { CONTEXT7_API_KEY: '${AIEVAL_PROBE_TEST_KEY}' },
        },
      });

      expect(calls[0]?.headers.CONTEXT7_API_KEY).toBe('ctx7sk-real');
    } finally {
      delete process.env.AIEVAL_PROBE_TEST_KEY;
    }
  });

  it('`${VAR:-default}` 这类不支持的写法 ⇒ 丢掉该键并说明（照发出去只会拿回一句「key 无效」）', async () => {
    const { calls } = installEndpoint();

    const result = await probeMcpServer({
      entry: {
        transport: 'http',
        enabled: true,
        url: 'https://mcp.context7.com/mcp',
        headers: { CONTEXT7_API_KEY: '${AIEVAL_PROBE_TEST_KEY:-fallback}' },
      },
    });

    expect(calls[0]?.headers.CONTEXT7_API_KEY).toBeUndefined();
    expect(result.notes).toContain(MCP_PROBE_NOTES.envUnsupported('${AIEVAL_PROBE_TEST_KEY:-fallback}'));
  });

  it('带上了密钥就不说「匿名探测」（说了就是假话）', async () => {
    installEndpoint();

    const result = await probeMcpServer({ entry: HTTP_ENTRY });

    expect(result.notes).not.toContain(MCP_PROBE_NOTES.anonymous);
  });
});

describe('同一时刻只允许一个探活', () => {
  it('两次并发探活串行执行，绝不重叠（宿主侧并发是唯一会撞 profile 的组合）', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const order: string[] = [];
    probeMock.mockImplementation(async (input) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      order.push(`start:${input.command}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push(`end:${input.command}`);
      inFlight -= 1;
      return STDIO_OK;
    });

    const [first, second] = await Promise.all([
      probeMcpServer({ entry: { ...STDIO_ENTRY, command: 'first' } as McpServerConfig }),
      probeMcpServer({ entry: { ...STDIO_ENTRY, command: 'second' } as McpServerConfig }),
    ]);

    expect(maxInFlight).toBe(1);
    expect(order).toEqual(['start:first', 'end:first', 'start:second', 'end:second']);
    expect(first.ok && second.ok).toBe(true);
  });

  it('一次探活抛错不会把队列卡死（下一个照常跑）', async () => {
    probeMock.mockRejectedValueOnce(new McpStdioProbeError('spawn', 'boom', { code: 'ENOENT' }));
    probeMock.mockResolvedValueOnce(STDIO_OK);

    const failed = await probeMcpServer({ entry: STDIO_ENTRY });
    const succeeded = await probeMcpServer({ entry: STDIO_ENTRY });

    expect(failed.ok).toBe(false);
    expect(succeeded.ok).toBe(true);
  });
});
