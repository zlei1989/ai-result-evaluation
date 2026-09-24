// @vitest-environment node
/**
 * 客户端 HTTP：四个方法 + 错误映射。
 * 关键点：响应体不是 JSON 时也必须抛 ServiceError（兜底 INTERNAL），
 * 不能因为解析响应失败而抛出 TypeError——错误路径自己不能二次抛错。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ServiceError } from '@aieval/contracts';
import { delJson, getJson, postJson, putJson } from './http';

afterEach(() => {
  vi.unstubAllGlobals();
});

/** 造一个 fetch 桩：返回指定状态与 body */
function stubFetch(status: number, body: unknown, ok = status < 400): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      new Response(typeof body === 'string' ? body : JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    ),
  );
}

describe('getJson', () => {
  it('2xx 时返回解析后的 JSON', async () => {
    stubFetch(200, { theme: 'dark' });
    expect(await getJson('/api/settings')).toEqual({ theme: 'dark' });
  });

  it('把传入的 URL 原样交给 fetch', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await getJson('/api/settings');
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/settings');
  });

  it('非 2xx 时抛 ServiceError，透传 code / message / context', async () => {
    stubFetch(400, { error: { code: 'NOT_WRITABLE', message: '目录不可写', context: { path: 'D:/x' } } });
    let caught: unknown;
    try {
      await getJson('/api/settings');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ServiceError);
    const error = caught as ServiceError;
    expect(error.code).toBe('NOT_WRITABLE');
    expect(error.message).toBe('目录不可写');
    expect(error.context).toEqual({ path: 'D:/x' });
  });

  it('非 2xx 且响应体不是 JSON 时兜底 INTERNAL + HTTP 状态码文案', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>502</html>', { status: 502 })));
    let caught: unknown;
    try {
      await getJson('/api/settings');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ServiceError);
    const error = caught as ServiceError;
    expect(error.code).toBe('INTERNAL');
    expect(error.message).toContain('502');
    // 服务端没带 context 时必须保持 undefined（不能退化成 null）
    expect(error.context).toBeUndefined();
  });

  it('非 2xx 且响应体缺 error 字段时同样兜底，不抛 TypeError', async () => {
    stubFetch(500, { unexpected: true });
    let caught: unknown;
    try {
      await getJson('/api/settings');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ServiceError);
    const error = caught as ServiceError;
    expect(error.code).toBe('INTERNAL');
    expect(error.message).toContain('500');
    expect(error.context).toBeUndefined();
  });
});

describe('postJson / putJson / delJson', () => {
  it('putJson 发送 PUT 且带 JSON 请求体', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await putJson('/api/settings', { theme: 'dark' });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('PUT');
    expect(init.body).toBe('{"theme":"dark"}');
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');
  });

  it('postJson 发送 POST 且带 JSON content-type', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await postJson('/api/x', { a: 1 });
    const init = (fetchMock.mock.calls[0] as [string, RequestInit])[1];
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');
  });

  it('delJson 发送 DELETE 且不带请求体', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await delJson('/api/x');
    const init = (fetchMock.mock.calls[0] as [string, RequestInit])[1];
    expect(init.method).toBe('DELETE');
    expect(init.body).toBeUndefined();
  });
});
