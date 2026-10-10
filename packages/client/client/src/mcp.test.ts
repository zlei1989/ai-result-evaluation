// @vitest-environment node
/**
 * MCP 探活数据层：URL、请求体、两种失败的分野（探活结论 vs 请求失败）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ServiceError, type McpProbeResult } from '@aieval/contracts';
import { MCP_TEST_URL, probeMcpServer } from './mcp';

afterEach(() => {
  vi.unstubAllGlobals();
});

const OK_RESULT: McpProbeResult = {
  ok: true,
  tier: 'A',
  serverName: 'Playwright',
  serverVersion: '1.64.0',
  toolCount: 25,
  elapsedMs: 2807,
  notes: [],
};

/** 记下请求的 fetch 替身 */
function stubFetch(response: () => Response): { calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit): Promise<Response> => {
    calls.push({ url: String(url), init });
    return response();
  });
  return { calls };
}

describe('probeMcpServer', () => {
  it('POST 到 /api/settings/mcp/test，body 原样（二选一由契约定，这一层不加工）', async () => {
    const { calls } = stubFetch(() => Response.json(OK_RESULT));

    const result = await probeMcpServer({ name: 'playwright' });

    expect(calls[0]?.url).toBe(MCP_TEST_URL);
    expect(calls[0]?.init.method).toBe('POST');
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ name: 'playwright' });
    expect(result).toEqual(OK_RESULT);
  });

  it('探活失败（200 + ok:false）原样返回，不抛：那是**结论**，不是请求出错', async () => {
    const failure: McpProbeResult = {
      ok: false,
      tier: 'A',
      elapsedMs: 12,
      failure: { tier: 'not-found', message: '端点不存在（HTTP 404）', vendorText: '{"error":"not_found"}' },
      notes: [],
    };
    stubFetch(() => Response.json(failure));

    const result = await probeMcpServer({ entry: { transport: 'http', enabled: true, url: 'https://x/y' } });

    expect(result.ok).toBe(false);
    expect(result.failure?.tier).toBe('not-found');
  });

  it('请求本身失败（404 / 500 / 网络）折成 ServiceError 抛出，调用方拿得到中文原因', async () => {
    stubFetch(
      () =>
        new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'MCP 服务器「gone」不在配置里，先保存再测' } }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        }),
    );

    const error = await probeMcpServer({ name: 'gone' }).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ServiceError);
    expect((error as ServiceError).message).toContain('不在配置里');
  });
});
