// @vitest-environment node
/**
 * 路由层端到端：/api/providers 的四个文件。
 *
 * 与 route-settings.test.ts 同源：不只测「返回了 200」，每条用例都**回读磁盘上的配置**
 * （`loadConfig()`）—— 响应体是内存对象，证明不了落盘；而「服务端拒绝了就不能落盘」
 * 正是本域最要紧的那类守卫。
 *
 * 拉模型的路由会真的调 `fetch`：一律用假上游（`vi.stubGlobal`）并在 afterEach 还原，
 * 绝不打真实网关（那会把用户密钥送到真实服务，也让用例依赖外部可用性）。
 *
 * 配置目录一律指向 mkdtempSync 出来的临时目录，绝不碰真实的 ~/.aieval。
 * 本文件是 `.ts`（不是 `.tsx`）：apps/web-next 保留 jsx: preserve，该应用内不能写 JSX 测试。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { maskApiKey, type Provider } from '@aieval/contracts';
import { loadConfig, saveConfig, setConfigDirForTesting } from '@aieval/core';
import { GET as listRoute, POST as createRoute } from '@/app/api/providers/route';
import { DELETE as deleteRoute, PUT as updateRoute } from '@/app/api/providers/[providerId]/route';
import { DELETE as removeModelRoute, POST as addModelRoute, PUT as setModelContextRoute } from '@/app/api/providers/[providerId]/models/route';
import { POST as fetchModelsRoute } from '@/app/api/providers/[providerId]/models/fetch/route';
import { removeTreeWithRetry } from './testing/cleanup';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aieval-route-providers-'));
  setConfigDirForTesting(dir);
});

afterEach(() => {
  // 顺序要紧：先复位再删目录，否则万一删目录抛错，覆盖值会漏给下一个文件
  setConfigDirForTesting(null);
  vi.unstubAllGlobals();
  removeTreeWithRetry(dir);
});

/** 用真实的 Request 全局构造请求，和 Next 交给路由的入参同形 */
function jsonRequest(path: string, method: string, body?: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** 动态段上下文：Next 15 起 params 是 Promise（本机 16.2.7 的 route.md 明确如此），await 后才拿到值 */
function ctxOf(providerId: string): { params: Promise<{ providerId: string }> } {
  return { params: Promise.resolve({ providerId }) };
}

/** 直接往配置里塞一条供应商，避免每条用例都先走一遍 POST */
function seedProvider(patch: Partial<Provider> = {}): Provider {
  const config = loadConfig();
  const provider: Provider = {
    id: 'p-1',
    name: 'DeepSeek 官方',
    protocolType: 'openai',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: 'sk-original-key',
    models: [{ id: 'manual-model', source: 'manual' }],
    createdAt: '2026-09-22T10:00:00.000Z',
    updatedAt: '2026-09-22T10:00:00.000Z',
    ...patch,
  };
  saveConfig({ ...config, providers: [...config.providers, provider] });
  return provider;
}

/** 假上游：只认 /models；返回给定响应并记录调用参数 */
function stubUpstream(body: string | unknown, status = 200): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(
    async () =>
      new Response(typeof body === 'string' ? body : JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** 按 id 取磁盘上的供应商 */
function stored(providerId: string): Provider | undefined {
  return loadConfig().providers.find((item) => item.id === providerId);
}

/**
 * 按 URL 分派的假上游：地址容错回退（`{base}/models` 404 → `{base}/v1/models`）
 * 要断言路由这一层「最终打了哪几条地址」，单一响应的 stubUpstream 区分不出来。
 */
function stubUpstreamByUrl(routes: Record<string, [number, unknown]>): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (url: string) => {
    const hit = routes[String(url)];
    if (hit === undefined) throw new Error(`假上游没有配这条地址：${url}`);
    const [status, body] = hit;
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('GET /api/providers', () => {
  it('列表只回掩码；磁盘上仍是明文（明文只进不出）', async () => {
    seedProvider();

    const res = await listRoute();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].apiKeyMasked).not.toBe('sk-original-key');
    expect('apiKey' in body[0]).toBe(false);
    expect(JSON.stringify(body)).not.toContain('sk-original-key');
    expect(stored('p-1')?.apiKey).toBe('sk-original-key');
  });
});

describe('POST /api/providers', () => {
  it('合法请求返回 200、落盘、响应里没有明文密钥', async () => {
    const res = await createRoute(
      jsonRequest('/api/providers', 'POST', {
        name: 'DeepSeek 官方',
        protocolType: 'openai',
        baseUrl: 'https://api.deepseek.com/v1',
        apiKey: 'sk-new-key',
      }),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe('DeepSeek 官方');
    expect(body.apiKeyMasked).not.toBe('sk-new-key');
    expect('apiKey' in body).toBe(false);
    expect(loadConfig().providers).toHaveLength(1);
    expect(loadConfig().providers[0]?.apiKey).toBe('sk-new-key');
    // models 是契约里的默认值（`.default([])`），请求体不带它也必须落成空数组而不是 undefined
    expect(body.models).toEqual([]);
  });

  it('缺 apiKey 返回 400 INVALID_QUERY（context 是真 zod 的 issues），且不落盘', async () => {
    const res = await createRoute(
      jsonRequest('/api/providers', 'POST', {
        name: 'DeepSeek 官方',
        protocolType: 'openai',
        baseUrl: 'https://api.deepseek.com/v1',
      }),
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('INVALID_QUERY');
    expect(body.error.context[0].path).toEqual(['apiKey']);
    // 被拒的请求不得落盘：少了这条，「先调服务再 parse」的变异体会全绿
    expect(loadConfig().providers).toEqual([]);
  });

  it('语法坏掉的请求体返回 400「请求体不是合法 JSON」', async () => {
    const res = await createRoute(
      new Request('http://localhost/api/providers', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{bad json',
      }),
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toBe('请求体不是合法 JSON');
  });
});

describe('PUT /api/providers/[providerId]', () => {
  // 编辑弹窗留空密钥 → 页面不下发 apiKey→ 服务端保留原密钥。
  // 这条链路断了的表现是「改个名字，所有代调开始 401」。
  it('不带 apiKey 的补丁只改名字，密钥与掩码都不变', async () => {
    seedProvider();

    const res = await updateRoute(jsonRequest('/api/providers/p-1', 'PUT', { name: '改名了' }), ctxOf('p-1'));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe('改名了');
    expect(body.apiKeyMasked).toBe(maskApiKey('sk-original-key'));
    expect(stored('p-1')?.apiKey).toBe('sk-original-key');
  });

  it('显式下发 apiKey 时替换密钥（掩码随之变化）', async () => {
    seedProvider();

    const res = await updateRoute(jsonRequest('/api/providers/p-1', 'PUT', { apiKey: 'sk-rotated' }), ctxOf('p-1'));

    expect(res.status).toBe(200);
    const after = await res.json();
    expect(stored('p-1')?.apiKey).toBe('sk-rotated');
    expect(after.apiKeyMasked).toBe(maskApiKey('sk-rotated'));
    expect(after.apiKeyMasked).not.toBe(maskApiKey('sk-original-key'));
  });

  // 页面侧的「空串不下发」没有任何自动化测试可写（该应用不能写 .tsx 测试），
  // 所以这里守的是它的**兜底**：万一哪天折叠退化、真的把空串发出来，必须是一次响亮的 400，
  // 而不是静默地把用户的密钥抹成空（服务层的空串语义是「保留原密钥」，只靠它看不出发送方错了）。
  // 这条同时钉住 ProviderPatchSchema.apiKey 的 min(1) —— 把它放宽成 z.string() 本用例就红。
  it('apiKey 传空串返回 400 INVALID_QUERY，密钥与掩码都不变（空串既不生效也不落盘）', async () => {
    seedProvider();

    const res = await updateRoute(
      jsonRequest('/api/providers/p-1', 'PUT', { name: '改名了', apiKey: '' }),
      ctxOf('p-1'),
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('INVALID_QUERY');
    expect(body.error.context[0].path).toEqual(['apiKey']);
    // 整份补丁被拒 ⇒ 连同一个请求里的改名也不落盘（原子性：不留半个补丁）
    expect(stored('p-1')?.apiKey).toBe('sk-original-key');
    expect(stored('p-1')?.name).toBe('DeepSeek 官方');
  });

  it('不存在的 id 返回 404 NOT_FOUND', async () => {
    const res = await updateRoute(jsonRequest('/api/providers/nope', 'PUT', { name: 'x' }), ctxOf('nope'));

    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('NOT_FOUND');
  });
});

describe('DELETE /api/providers/[providerId]', () => {
  it('删除返回 { ok: true }（不是 204）并真的落盘', async () => {
    seedProvider();

    const res = await deleteRoute(jsonRequest('/api/providers/p-1', 'DELETE'), ctxOf('p-1'));

    expect(res.status).toBe(200);
    // 必须是 JSON 体：客户端 delJson 走 res.json()，204 的空体会抛 SyntaxError
    expect(await res.json()).toEqual({ ok: true });
    expect(loadConfig().providers).toEqual([]);
  });

  it('再删一次返回 404（幂等删除会掩盖前端 id 传错）', async () => {
    const res = await deleteRoute(jsonRequest('/api/providers/p-1', 'DELETE'), ctxOf('p-1'));

    expect(res.status).toBe(404);
  });
});

describe('POST /api/providers/[providerId]/models', () => {
  it('加一条模型并落成 manual', async () => {
    seedProvider();

    const res = await addModelRoute(
      jsonRequest('/api/providers/p-1/models', 'POST', { id: 'deepseek-reasoner', source: 'manual' }),
      ctxOf('p-1'),
    );

    expect(res.status).toBe(200);
    // 响应体必须是 ProviderView（客户端把 res.json() 直接当 ProviderView 解析）：
    // `{ ok: true }` 也能满足「200 + 磁盘已改」，只有回读响应体的字段才钉得住这条契约。
    const body = await res.json();
    expect(body.id).toBe('p-1');
    expect(body.apiKeyMasked).toBe(maskApiKey('sk-original-key'));
    expect(body.models).toContainEqual({ id: 'deepseek-reasoner', source: 'manual' });
    expect(stored('p-1')?.models).toEqual([
      { id: 'manual-model', source: 'manual' },
      { id: 'deepseek-reasoner', source: 'manual' },
    ]);
  });

  // 请求体里的 source 只用来过契约校验：来源由服务端固定为 manual。
  // 允许客户端声明 fetched，用户手工填的模型就会在下一次拉取里被按「已下架」清掉。
  it('请求体声明 source: fetched 也照旧落成 manual', async () => {
    seedProvider();

    await addModelRoute(
      jsonRequest('/api/providers/p-1/models', 'POST', { id: 'sneaky', source: 'fetched' }),
      ctxOf('p-1'),
    );

    expect(stored('p-1')?.models).toContainEqual({ id: 'sneaky', source: 'manual' });
  });

  it('空 id 返回 400 且不落盘', async () => {
    seedProvider();

    const res = await addModelRoute(
      jsonRequest('/api/providers/p-1/models', 'POST', { id: '', source: 'manual' }),
      ctxOf('p-1'),
    );

    expect(res.status).toBe(400);
    expect(stored('p-1')?.models).toEqual([{ id: 'manual-model', source: 'manual' }]);
  });

  // 路由层的 zod 不是装饰：完全没有 id 时若直接把它交给服务层，`manualModels([undefined])`
  // 会在 `raw.trim()` 上抛 TypeError，用户拿到的是 500「服务端内部错误」而不是可读的 400。
  it('请求体没有 id 时返回 400（不让 undefined 落到服务层的 trim 上变成 500）', async () => {
    seedProvider();

    const res = await addModelRoute(jsonRequest('/api/providers/p-1/models', 'POST', {}), ctxOf('p-1'));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('INVALID_QUERY');
    expect(body.error.message).toBe('查询参数不合法');
    expect(body.error.context[0].path).toEqual(['id']);
    expect(stored('p-1')?.models).toEqual([{ id: 'manual-model', source: 'manual' }]);
  });
});

describe('DELETE /api/providers/[providerId]/models', () => {
  it('按 query 里的 modelId 删掉那一条', async () => {
    seedProvider({ models: [{ id: 'keep', source: 'manual' }, { id: 'drop', source: 'manual' }] });

    const res = await removeModelRoute(
      jsonRequest('/api/providers/p-1/models?modelId=drop', 'DELETE'),
      ctxOf('p-1'),
    );

    expect(res.status).toBe(200);
    // 同上：删除同样回 ProviderView，回 `{ ok: true }` 会让客户端 delJson 的 ProviderView 解析落空
    const body = await res.json();
    expect(body.id).toBe('p-1');
    expect(body.apiKeyMasked).toBe(maskApiKey('sk-original-key'));
    expect(body.models).toEqual([{ id: 'keep', source: 'manual' }]);
    expect(stored('p-1')?.models).toEqual([{ id: 'keep', source: 'manual' }]);
  });

  // 模型名里带 `/` `+` `#` 是常态（`vendor/model+x`）。客户端按 encodeURIComponent 传参
  //，服务端这一侧必须解出**逐字符相同**的 id：
  // 少了这半边，`+` 会被解成空格、`#` 之后会被当片段丢掉，表现为「点了删除没反应」。
  it('编码过的 modelId（含 / + #）能精确命中那一条', async () => {
    seedProvider({
      models: [
        { id: 'vendor/model+x#1', source: 'manual' },
        { id: 'vendor model x 1', source: 'manual' },
      ],
    });

    const res = await removeModelRoute(
      jsonRequest('/api/providers/p-1/models?modelId=vendor%2Fmodel%2Bx%231', 'DELETE'),
      ctxOf('p-1'),
    );

    expect(res.status).toBe(200);
    expect(stored('p-1')?.models).toEqual([{ id: 'vendor model x 1', source: 'manual' }]);
  });

  it('缺 modelId 返回 400 INVALID_QUERY（不能把「没给 id」当成「删掉全部」）', async () => {
    seedProvider();

    const res = await removeModelRoute(jsonRequest('/api/providers/p-1/models', 'DELETE'), ctxOf('p-1'));

    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toContain('缺少查询参数 modelId');
    expect(stored('p-1')?.models).toEqual([{ id: 'manual-model', source: 'manual' }]);
  });
});

describe('POST /api/providers/[providerId]/models/fetch', () => {
  it('openai 协议：按 Authorization: Bearer 发给 {baseUrl}/models，并把结果合并进清单', async () => {
    seedProvider();
    const fetchMock = stubUpstream({ data: [{ id: 'fetched-a' }, { id: 'manual-model' }] });

    const res = await fetchModelsRoute(jsonRequest('/api/providers/p-1/models/fetch', 'POST', {}), ctxOf('p-1'));

    expect(res.status).toBe(200);
    // 拉取同样回 ProviderView（客户端 fetchModels 把它当 ProviderView 返回给调用方）
    const body = await res.json();
    expect(body.id).toBe('p-1');
    expect(body.apiKeyMasked).toBe(maskApiKey('sk-original-key'));
    expect(body.models).toEqual([
      { id: 'manual-model', source: 'manual' },
      { id: 'fetched-a', source: 'fetched' },
    ]);
    expect(stored('p-1')?.models).toEqual([
      { id: 'manual-model', source: 'manual' },
      { id: 'fetched-a', source: 'fetched' },
    ]);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.deepseek.com/v1/models');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer sk-original-key');
  });

  // 修订：协议不再阻止拉取（原的服务端 400 已删除），改由地址形态兜底 ——
  // 路由层要钉的是「anthropic 供应商也能拉到」，以及回退确实发生在服务端这一层。
  it('anthropic 协议：地址缺 /v1 时回退 /v1/models，返回 200 并合并进清单', async () => {
    seedProvider({ protocolType: 'anthropic', baseUrl: 'https://gw.example.com' });
    const fetchMock = stubUpstreamByUrl({
      'https://gw.example.com/models': [404, 'not found'],
      'https://gw.example.com/v1/models': [200, { data: [{ id: 'fetched-a' }] }],
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const res = await fetchModelsRoute(jsonRequest('/api/providers/p-1/models/fetch', 'POST', {}), ctxOf('p-1'));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.models).toEqual([
      { id: 'manual-model', source: 'manual' },
      { id: 'fetched-a', source: 'fetched' },
    ]);
    expect(stored('p-1')?.models).toEqual([
      { id: 'manual-model', source: 'manual' },
      { id: 'fetched-a', source: 'fetched' },
    ]);
    expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual([
      'https://gw.example.com/models',
      'https://gw.example.com/v1/models',
    ]);
  });

  // 修订：地址填的是 Messages 根（`/anthropic`）时清单接口仍在站点根上 ——
  // 路由层要钉的是「子路径两条都 404 后确实又打了根的两条」，不是只把第一条的 404 报回去。
  it('anthropic 协议：地址带子路径时回退到站点根，返回 200 并合并进清单', async () => {
    seedProvider({ protocolType: 'anthropic', baseUrl: 'https://gw.example.com/anthropic' });
    const fetchMock = stubUpstreamByUrl({
      'https://gw.example.com/anthropic/models': [404, 'not found'],
      'https://gw.example.com/anthropic/v1/models': [404, 'not found'],
      'https://gw.example.com/models': [404, 'not found'],
      'https://gw.example.com/v1/models': [200, { data: [{ id: 'fetched-a' }] }],
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const res = await fetchModelsRoute(jsonRequest('/api/providers/p-1/models/fetch', 'POST', {}), ctxOf('p-1'));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.models).toEqual([
      { id: 'manual-model', source: 'manual' },
      { id: 'fetched-a', source: 'fetched' },
    ]);
    expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual([
      'https://gw.example.com/anthropic/models',
      'https://gw.example.com/anthropic/v1/models',
      'https://gw.example.com/models',
      'https://gw.example.com/v1/models',
    ]);
  });

  it('上游 401 映射 401 AUTH_FAILED（context 带 host），清单不动', async () => {
    seedProvider();
    stubUpstream({ error: 'bad key' }, 401);

    const res = await fetchModelsRoute(jsonRequest('/api/providers/p-1/models/fetch', 'POST', {}), ctxOf('p-1'));

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe('AUTH_FAILED');
    expect(body.error.context).toEqual({ host: 'api.deepseek.com' });
    expect(stored('p-1')?.models).toEqual([{ id: 'manual-model', source: 'manual' }]);
  });
});

/**
 * PUT /api/providers/{id}/models：设置单条模型的窗口（设置页的行内编辑器走它）。
 * 与同文件其余用例同口径：断言**落盘事实**，因为响应体是内存对象，证明不了「用户改的东西真的存下来了」。
 */
describe('PUT /api/providers/{id}/models：设置模型窗口', () => {
  it('写入后回读磁盘：窗口是新的、来源是 manual', async () => {
    seedProvider({ models: [{ id: 'm', source: 'fetched', contextWindow: 1_000_000 }] });

    const res = await setModelContextRoute(
      jsonRequest('/api/providers/p-1/models', 'PUT', { id: 'm', contextWindow: 262_144 }),
      ctxOf('p-1'),
    );

    expect(res.status).toBe(200);
    expect(stored('p-1')?.models[0]).toEqual({
      id: 'm',
      source: 'fetched',
      contextWindow: 262_144,
      contextWindowSource: 'manual',
    });
  });

  it('非正整数窗口被 zod 挡成 400，一个字节都不落盘', async () => {
    seedProvider({ models: [{ id: 'm', source: 'fetched', contextWindow: 1_000_000 }] });

    const res = await setModelContextRoute(
      jsonRequest('/api/providers/p-1/models', 'PUT', { id: 'm', contextWindow: 0 }),
      ctxOf('p-1'),
    );

    expect(res.status).toBe(400);
    expect(stored('p-1')?.models[0]?.contextWindow).toBe(1_000_000);
    expect(stored('p-1')?.models[0]?.contextWindowSource).toBeUndefined();
  });
});
