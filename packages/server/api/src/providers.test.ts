// @vitest-environment node
/**
 * 供应商服务：CRUD、掩码出口、模型清单的手工维护、全部模型候选。
 * 配置目录一律指向 mkdtempSync 出来的临时目录并在 afterEach 复位 —— 绝不碰真实的 ~/.aieval。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ServiceError, maskApiKey, type ProviderCreate } from '@aieval/contracts';
import { loadConfig, setConfigDirForTesting } from '@aieval/core';
import {
  addProviderModel,
  createProvider,
  deleteProvider,
  fetchProviderModels,
  listAllModelOptions,
  listProviders,
  removeProviderModel,
  setProviderModelContext,
  updateProvider,
} from './providers';
import { updateSettings } from './settings';
import { makeProvider, seedConfig } from './testing/run-fixtures';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aieval-providers-'));
  setConfigDirForTesting(dir);
});

afterEach(() => {
  // 顺序要紧：先复位再删目录，否则万一删目录抛错，覆盖值会漏给下一个文件
  setConfigDirForTesting(null);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  // console.warn 的桩（上游非 2xx 的 WARN 日志）逐个用例装、在这里统一还原
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true, maxRetries: 40, retryDelay: 100 });
});

/** 用例通用的新增入参（密钥是明文，落盘形态与真实一致） */
const CREATE: ProviderCreate = {
  name: 'DeepSeek 官方',
  protocolType: 'openai',
  baseUrl: 'https://api.deepseek.com/v1',
  apiKey: 'sk-abcdefghijklmnop',
  models: [],
};

/** 从磁盘上取一条供应商（用来断言「落盘的到底是什么」，而不是只看内存返回值） */
function stored(providerId: string) {
  return loadConfig().providers.find((item) => item.id === providerId);
}

describe('listProviders / createProvider', () => {
  it('新建后能列出，且下行对象只有掩码、没有 apiKey 这个键', () => {
    const created = createProvider(CREATE);

    expect(created.name).toBe(CREATE.name);
    expect(created.apiKeyMasked).toBe(maskApiKey(CREATE.apiKey));
    // 不是「值为空」而是**键不存在**：`{ apiKey: undefined }` 会让 JSON.stringify 丢键、
    // 但 `'apiKey' in obj` 仍为 true，客户端一个 `obj.apiKey ?? ''` 就能把它当字段用。
    expect('apiKey' in created).toBe(false);
    expect(listProviders().map((item) => item.id)).toEqual([created.id]);
    // 最终的判据：整个出口的序列化结果里不得出现明文
    expect(JSON.stringify(listProviders())).not.toContain(CREATE.apiKey);
  });

  it('落盘的是明文密钥（服务端要拿原 token 代调上游），出口已掩码', () => {
    const created = createProvider(CREATE);

    expect(stored(created.id)?.apiKey).toBe(CREATE.apiKey);
    expect(created.apiKeyMasked).not.toBe(CREATE.apiKey);
  });

  it('id 是 UUID v4，createdAt / updatedAt 是 ISO 8601 带时区字符串且初始相等', () => {
    const created = createProvider(CREATE);

    expect(created.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(created.createdAt).toBe(created.updatedAt);
    expect(new Date(created.createdAt).toISOString()).toBe(created.createdAt);
  });

  it('新建时带的模型清单一律归一成 manual，并去掉空白项与重复项', () => {
    // `fetched` 的唯一合法来源是一次真实的拉取调用：允许客户端在新建时声明 fetched，
    // 用户手工填的模型就会在下次拉取时被按「已下架」静默清掉（§6.1 合并而非覆盖要防的正是这个）。
    const created = createProvider({
      ...CREATE,
      models: [
        { id: 'm1', source: 'fetched' },
        { id: ' m1 ', source: 'manual' },
        { id: '', source: 'manual' },
        { id: 'm2', source: 'manual' },
      ],
    });

    expect(created.models).toEqual([
      { id: 'm1', source: 'manual' },
      { id: 'm2', source: 'manual' },
    ]);
  });

  // 新建的密钥也走归一（ProviderCreateSchema 只要求 min(1)，`'   '` 与 `'  sk-x  '` 都能过 zod）。
  it('新建时密钥去掉首尾空白；纯空白被拒（INVALID_QUERY）且不落盘', () => {
    const created = createProvider({ ...CREATE, apiKey: '  sk-padded-key  ' });

    expect(stored(created.id)?.apiKey).toBe('sk-padded-key');
    expect(created.apiKeyMasked).toBe(maskApiKey('sk-padded-key'));

    // 为什么纯空白是**拒绝**而不是「trim 成空串照存」：落盘形态必须满足 ProviderSchema 的
    // `apiKey: min(1)`（config-store 的往返用例盯的就是这条），存空串等于写进一条非法记录，
    // 而掩码也变成空串 —— 界面看起来「还没配密钥」，实际多了一条每次代调都 401 的供应商。
    let caught: unknown;
    try {
      createProvider({ ...CREATE, apiKey: '   ' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ServiceError);
    expect((caught as ServiceError).code).toBe('INVALID_QUERY');
    expect(listProviders()).toHaveLength(1);
  });
});

describe('updateProvider', () => {
  it('只改传入的字段，其余保持原值', () => {
    const created = createProvider(CREATE);

    const next = updateProvider(created.id, { name: '改过的名字' });

    expect(next.name).toBe('改过的名字');
    expect(next.protocolType).toBe(CREATE.protocolType);
    expect(next.baseUrl).toBe(CREATE.baseUrl);
    expect(stored(created.id)?.name).toBe('改过的名字');
  });

  // ProviderPatch 的每个字段都是 `T | undefined`（ProviderCreateSchema.partial()），所以
  // `{ ...provider, ...patch }` 这种写法会把存量字段覆盖成 undefined 后落盘 ——
  // 坏值不在这次响应里，而在**下一次读取**，于是表现为「打开设置页供应商就少了一列」。
  it('显式传 undefined 的补丁不把存量字段覆盖成 undefined', () => {
    const created = createProvider(CREATE);

    const next = updateProvider(created.id, { name: undefined, baseUrl: undefined });

    expect(next.name).toBe(CREATE.name);
    expect(next.baseUrl).toBe(CREATE.baseUrl);
    expect(stored(created.id)?.baseUrl).toBe(CREATE.baseUrl);
  });

  it('不传或传空串的 apiKey 都保留原密钥（掩码不变）', () => {
    const created = createProvider(CREATE);

    const renamed = updateProvider(created.id, { name: '改名了' });
    expect(renamed.apiKeyMasked).toBe(created.apiKeyMasked);
    expect(stored(created.id)?.apiKey).toBe(CREATE.apiKey);

    // 空串是「编辑弹窗留空」的真实取值：写进去等于把用户配好的密钥抹掉，此后所有代调都是 401
    const emptied = updateProvider(created.id, { apiKey: '' });
    expect(emptied.apiKeyMasked).toBe(created.apiKeyMasked);
    expect(stored(created.id)?.apiKey).toBe(CREATE.apiKey);
  });

  it('给了非空 apiKey 时替换，掩码随之变化', () => {
    const created = createProvider(CREATE);

    const next = updateProvider(created.id, { apiKey: 'sk-zzzzzzzzzzzz' });

    expect(stored(created.id)?.apiKey).toBe('sk-zzzzzzzzzzzz');
    expect(next.apiKeyMasked).toBe(maskApiKey('sk-zzzzzzzzzzzz'));
    expect(next.apiKeyMasked).not.toBe(created.apiKeyMasked);
  });

  // 弹窗的 required 只判空串，`'   '` 能过校验、也过了 ProviderPatchSchema 的 min(1)。
  // 旧实现按「非空串即替换」落盘：一次误输入的空格就把可用密钥换成空白串 ——
  // 此后所有代调 401，而表里那个短掩码（`maskApiKey('   ')` → `***`）看起来**像是配好的**，
  // 比空掩码更难发现。所以纯空白必须与空串同一处置：保持原密钥。
  it('纯空白的 apiKey 补丁与空串同处置：落盘密钥与下行掩码都不变', () => {
    const created = createProvider(CREATE);

    const next = updateProvider(created.id, { apiKey: '   ' });

    expect(stored(created.id)?.apiKey).toBe(CREATE.apiKey);
    expect(next.apiKeyMasked).toBe(created.apiKeyMasked);
    expect(next.apiKeyMasked).toBe(maskApiKey(CREATE.apiKey));
  });

  // 与 createProvider 同一口径：非空白的值一律存 trim 后的形态。带空白的 token 进不了
  // `Authorization: Bearer <key>` 头，存原串只会让代调 401，而掩码看起来「明明是配好的」。
  it('带首尾空白的 apiKey 补丁按 trim 后的形态替换', () => {
    const created = createProvider(CREATE);

    const next = updateProvider(created.id, { apiKey: '  sk-zzzzzzzzzzzz  ' });

    expect(stored(created.id)?.apiKey).toBe('sk-zzzzzzzzzzzz');
    expect(next.apiKeyMasked).toBe(maskApiKey('sk-zzzzzzzzzzzz'));
  });

  it('更新推进 updatedAt 且不动 createdAt（用假时钟，不依赖真实耗时）', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-22T10:00:00.000Z'));
    const created = createProvider(CREATE);
    vi.setSystemTime(new Date('2026-09-22T10:05:00.000Z'));

    const next = updateProvider(created.id, { name: 'x' });

    expect(next.createdAt).toBe('2026-09-22T10:00:00.000Z');
    expect(next.updatedAt).toBe('2026-09-22T10:05:00.000Z');
  });

  // 补丁里的 models 是**客户端可控入口**，而契约的 schema 允许声明 `source: 'fetched'`。
  // 不过一遍 manualModels 就会把 fetched 写进清单 —— 下一次拉取按「上游已下架」静默清掉它，
  // 用户看到的是「我刚填的模型又没了」。与 createProvider 同一口径。
  it('补丁里的模型清单走同一套归一化：来源一律 manual、去空白去重', () => {
    const created = createProvider(CREATE);

    const next = updateProvider(created.id, {
      models: [
        { id: 'm1', source: 'fetched' },
        { id: ' m1 ', source: 'manual' },
        { id: '', source: 'manual' },
        { id: 'm2', source: 'fetched' },
      ],
    });

    expect(next.models).toEqual([
      { id: 'm1', source: 'manual' },
      { id: 'm2', source: 'manual' },
    ]);
    expect(stored(created.id)?.models).toEqual(next.models);
  });

  it('不存在的 id 抛 NOT_FOUND', () => {
    let caught: unknown;
    try {
      updateProvider('nope', { name: 'x' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ServiceError);
    expect((caught as ServiceError).code).toBe('NOT_FOUND');
  });
});

describe('deleteProvider', () => {
  it('删除后列表里不再有它', () => {
    const created = createProvider(CREATE);

    deleteProvider(created.id);

    expect(listProviders()).toEqual([]);
  });

  it('不存在的 id 抛 NOT_FOUND（而不是静默成功）', () => {
    let caught: unknown;
    try {
      deleteProvider('nope');
    } catch (error) {
      caught = error;
    }
    expect((caught as ServiceError).code).toBe('NOT_FOUND');
  });

  // 删供应商**不**级联改写 settings.defaultJudge：那会把「删一个供应商」变成一次跨域事务
  //（要在同一次保存里改动另一块配置）。悬空引用由设置页显式提示（Task 6），
  // 并在评分时由 resolveJudgeRoute 兜底报错。这条用例把这个决定钉住。
  it('删除供应商不改写 settings.defaultJudge（悬空引用留给设置页提示）', () => {
    const created = createProvider(CREATE);
    updateSettings({ defaultJudge: { providerId: created.id, modelId: 'm1' } });

    deleteProvider(created.id);

    expect(loadConfig().settings.defaultJudge).toEqual({ providerId: created.id, modelId: 'm1' });
  });
});

describe('addProviderModel / removeProviderModel', () => {
  it('手工添加的条目标记为 manual，并落盘', () => {
    const created = createProvider(CREATE);

    const next = addProviderModel(created.id, 'deepseek-chat');

    expect(next.models).toEqual([{ id: 'deepseek-chat', source: 'manual' }]);
    expect(stored(created.id)?.models).toEqual([{ id: 'deepseek-chat', source: 'manual' }]);
  });

  it('重复添加同 id 是幂等的：不新增、不改来源', () => {
    const created = createProvider(CREATE);
    addProviderModel(created.id, 'm1');

    const next = addProviderModel(created.id, 'm1');

    expect(next.models).toEqual([{ id: 'm1', source: 'manual' }]);
  });

  it('添加时去掉首尾空白；纯空白串被拒（INVALID_QUERY）', () => {
    const created = createProvider(CREATE);

    expect(addProviderModel(created.id, '  m1  ').models).toEqual([{ id: 'm1', source: 'manual' }]);

    let caught: unknown;
    try {
      addProviderModel(created.id, '   ');
    } catch (error) {
      caught = error;
    }
    expect((caught as ServiceError).code).toBe('INVALID_QUERY');
  });

  it('删除一条只删那一条', () => {
    const created = createProvider(CREATE);
    addProviderModel(created.id, 'm1');
    addProviderModel(created.id, 'm2');

    const next = removeProviderModel(created.id, 'm1');

    expect(next.models).toEqual([{ id: 'm2', source: 'manual' }]);
    expect(stored(created.id)?.models).toEqual([{ id: 'm2', source: 'manual' }]);
  });

  // 添加路径会 trim（'  m2  ' 与 'm2' 是同一条），删除路径不 trim 就出现自相矛盾的状态：
  // 界面上明明有 m2，按它发起删除却收到 NOT_FOUND。两端必须同一口径。
  it('删除时同样去掉首尾空白；纯空白串按「没有这条」处理', () => {
    const created = createProvider(CREATE);
    addProviderModel(created.id, 'm1');
    addProviderModel(created.id, 'm2');

    const next = removeProviderModel(created.id, '  m2  ');

    expect(next.models).toEqual([{ id: 'm1', source: 'manual' }]);

    let caught: unknown;
    try {
      removeProviderModel(created.id, '   ');
    } catch (error) {
      caught = error;
    }
    expect((caught as ServiceError).code).toBe('NOT_FOUND');
    // 纯空白串不得误删任何一条
    expect(stored(created.id)?.models).toEqual([{ id: 'm1', source: 'manual' }]);
  });

  // 静默成功会让「删除没生效」看起来像界面 bug，而真正的原因（id 传错、模型早已被拉取覆盖掉）
  // 反而被藏起来。
  it('删除不存在的模型抛 NOT_FOUND', () => {
    const created = createProvider(CREATE);
    addProviderModel(created.id, 'm1');

    let caught: unknown;
    try {
      removeProviderModel(created.id, 'nope');
    } catch (error) {
      caught = error;
    }
    expect((caught as ServiceError).code).toBe('NOT_FOUND');
    expect(stored(created.id)?.models).toEqual([{ id: 'm1', source: 'manual' }]);
  });
});

describe('listAllModelOptions', () => {
  // 评分走纯文本 API、不经过智能体（F3 / §6.2），所以 anthropic 协议的模型和 openai 协议的一样可选：
  // 这里刻意不做协议过滤。过滤掉一半候选，等于把「默认评分模型」的选择面砍掉一半。
  it('两种协议的模型都出现', () => {
    const openai = createProvider({ ...CREATE, name: 'A 网关', protocolType: 'openai' });
    const anthropic = createProvider({
      ...CREATE,
      name: 'B 网关',
      protocolType: 'anthropic',
      baseUrl: 'https://api.deepseek.com/anthropic',
    });
    addProviderModel(openai.id, 'deepseek-chat');
    addProviderModel(anthropic.id, 'claude-sonnet-5');

    const options = listAllModelOptions();

    expect(options.map((option) => `${option.providerName}/${option.modelId}:${option.protocolType}`)).toEqual([
      'A 网关/deepseek-chat:openai',
      'B 网关/claude-sonnet-5:anthropic',
    ]);
    expect(options[0]).toEqual({
      providerId: openai.id,
      providerName: 'A 网关',
      protocolType: 'openai',
      modelId: 'deepseek-chat',
      source: 'manual',
    });
  });

  it('一个供应商都没有时返回空数组（不是 undefined）', () => {
    expect(listAllModelOptions()).toEqual([]);
  });
});

// ─────────────────────────── /models 自动拉取 ───────────────────────────

/**
 * 假上游：只认 /models，返回给定响应。
 * 测试绝不打真实网络 —— 拉模型是本计划唯一会对外发 HTTP 的地方，一次真实调用会让用例
 * 依赖外部服务、还会把用户的密钥送到真实网关。
 *
 * 为什么它不会污染其它用例：`vi.stubGlobal` 改的是本 worker 的 globalThis，文件末尾的
 * `afterEach` 会 `vi.unstubAllGlobals()` 立刻还原；vitest 默认每个测试文件一个进程，
 * 同文件内的用例也都显式 stub 自己需要的那一份。不 stub 的用例（CRUD 那些）压根不触发网络。
 */
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

/** 取一次 fetch 调用的 [url, init]，断言时用 */
function firstCall(fetchMock: ReturnType<typeof vi.fn>): [string, RequestInit] {
  return fetchMock.mock.calls[0] as [string, RequestInit];
}

/**
 * 按 URL 分派的假上游：地址容错回退要断言「先打哪条、再打哪条、打了几次」，
 * 单一响应的 stubUpstream 区分不出多条候选地址；**没配到的地址直接抛**（见下），
 * 于是「候选比用例预期多打了一条」也会立刻炸出来。
 * 没配到的地址**直接抛**而不是回 404：用例写错了要立刻炸，不能伪装成「上游没有这条路径」。
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

/** 全部 fetch 调用的 URL，按调用顺序（回退守卫靠它断言「试了哪几条」） */
function calledUrls(fetchMock: ReturnType<typeof vi.fn>): string[] {
  return fetchMock.mock.calls.map((call) => String(call[0]));
}

describe('fetchProviderModels：请求形状', () => {
  it('请求照 Authorization: Bearer <key> 发，URL 是 {baseUrl}/models（尾斜杠不重复）', async () => {
    const created = createProvider({ ...CREATE, baseUrl: 'https://api.deepseek.com/v1/' });
    const fetchMock = stubUpstream({ data: [{ id: 'm1' }] });

    await fetchProviderModels(created.id);

    const [url, init] = firstCall(fetchMock);
    expect(url).toBe('https://api.deepseek.com/v1/models');
    expect(new Headers(init.headers).get('authorization')).toBe(`Bearer ${CREATE.apiKey}`);
  });

  it('供应商不存在抛 NOT_FOUND，且一次请求都不发', async () => {
    const fetchMock = stubUpstream({ data: [] });

    await expect(fetchProviderModels('nope')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('fetchProviderModels：地址容错回退（协议不再阻止拉取）', () => {
  // 2026-09-26 修订（原 F1「Anthropic 协议没有 /models 接口」）：那条判断只对 api.anthropic.com 成立，
  // 却把「协议类型」当成了「能不能拉清单」的判据 —— 而多数自建网关在版本段上同时提供 OpenAI 风格
  // 的清单接口（实测 likecode 网关：`/models` 404、`/v1/models` 200，Anthropic Messages 在 `/v1/messages`）。
  // 现在协议完全不参与判定，改由**地址形态**兜底：先打 `{地址}/models`，只有 404（路径不存在）
  // 才回退 `{地址}/v1/models`。填 `http://host` 与 `http://host/v1` 都能拉到。
  // （2026-09-30 又在候选末尾补了站点根的两条，那一段的守卫在下一个 describe。）
  it('anthropic 协议照常拉取（地址直接命中时只发一次）', async () => {
    const created = createProvider({
      ...CREATE,
      protocolType: 'anthropic',
      baseUrl: 'https://gw.example.com/v1',
    });
    const fetchMock = stubUpstream({ data: [{ id: 'claude-opus-4-6' }] });

    const next = await fetchProviderModels(created.id);

    expect(next.models).toEqual([{ id: 'claude-opus-4-6', source: 'fetched' }]);
    expect(calledUrls(fetchMock)).toEqual(['https://gw.example.com/v1/models']);
  });

  it('地址缺 /v1 时：第一条 404 → 回退 /v1/models 并合并进清单', async () => {
    const created = createProvider({
      ...CREATE,
      protocolType: 'anthropic',
      baseUrl: 'https://gw.example.com/',
    });
    addProviderModel(created.id, 'manual-keep');
    const fetchMock = stubUpstreamByUrl({
      'https://gw.example.com/models': [404, { error: { message: 'Not found, GET /models' } }],
      'https://gw.example.com/v1/models': [200, { data: [{ id: 'm1' }] }],
    });
    // 第一条的 404 会落一条 WARN（服务端诊断用，正文只进日志）：静音以保持用例输出干净
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const next = await fetchProviderModels(created.id);

    expect(calledUrls(fetchMock)).toEqual(['https://gw.example.com/models', 'https://gw.example.com/v1/models']);
    // 合并语义不变：手工条目留在前，回退拿到的 id 追加为 fetched
    expect(next.models).toEqual([
      { id: 'manual-keep', source: 'manual' },
      { id: 'm1', source: 'fetched' },
    ]);
    expect(stored(created.id)?.models).toEqual(next.models);
  });

  it('两条候选都 404：文案点名两条实际路径，清单不动', async () => {
    const created = createProvider({ ...CREATE, baseUrl: 'https://gw.example.com/' });
    addProviderModel(created.id, 'manual-keep');
    const fetchMock = stubUpstreamByUrl({
      'https://gw.example.com/models': [404, 'not found'],
      'https://gw.example.com/v1/models': [404, 'not found'],
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    let caught: unknown;
    try {
      await fetchProviderModels(created.id);
    } catch (error) {
      caught = error;
    }

    const serviceError = caught as ServiceError;
    expect(serviceError).toBeInstanceOf(ServiceError);
    expect(serviceError.code).toBe('INTERNAL');
    expect(serviceError.message).toContain('404');
    // 只说「返回 HTTP 404」用户无从自查到底打的是哪条地址 —— 两条都试过就必须都点名
    expect(serviceError.message).toContain('/models 与 /v1/models 都不存在');
    expect(calledUrls(fetchMock)).toHaveLength(2);
    expect(stored(created.id)?.models).toEqual([{ id: 'manual-keep', source: 'manual' }]);
  });

  it('401 不回退：换地址也是同一堵墙，只发一次请求', async () => {
    // 回退的判据必须**只有** 404。把 401 也当成「地址不对」会多打一次上游，
    // 还会把「密钥被拒」这层真因盖成「地址不存在」——用户照着改地址越改越远。
    const created = createProvider({ ...CREATE, baseUrl: 'https://gw.example.com/' });
    const fetchMock = stubUpstreamByUrl({ 'https://gw.example.com/models': [401, { error: 'bad key' }] });

    await expect(fetchProviderModels(created.id)).rejects.toMatchObject({ code: 'AUTH_FAILED' });
    expect(calledUrls(fetchMock)).toEqual(['https://gw.example.com/models']);
  });

  it('5xx 同样不回退（路径是通的，问题在上游自己）', async () => {
    const created = createProvider({ ...CREATE, baseUrl: 'https://gw.example.com/' });
    const fetchMock = stubUpstreamByUrl({ 'https://gw.example.com/models': [503, 'maintenance'] });
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(fetchProviderModels(created.id)).rejects.toMatchObject({ code: 'INTERNAL' });
    expect(calledUrls(fetchMock)).toEqual(['https://gw.example.com/models']);
  });

  it('地址本身已带 /v1：不会叠成 /v1/v1/models（只发一次请求）', async () => {
    const created = createProvider({ ...CREATE, baseUrl: 'https://gw.example.com/v1' });
    const fetchMock = stubUpstreamByUrl({
      'https://gw.example.com/v1/models': [200, { data: [{ id: 'm1' }] }],
    });

    await fetchProviderModels(created.id);

    expect(calledUrls(fetchMock)).toEqual(['https://gw.example.com/v1/models']);
  });
});

/**
 * 根回退（2026-09-30 修订）：地址填的是 **Messages 根**（`/anthropic`，README 就教这么填）
 * 或网关自己的前缀（`/api/v1`）时，清单接口往往仍挂在站点根上 —— 只按配置地址拼会一路 404，
 * 而用户的地址、密钥都没错。故候选补上根的 `/models` 与 `/v1/models`，顺序在配置地址之后。
 */
describe('fetchProviderModels：站点根回退', () => {
  it('地址带子路径（/anthropic）：子路径两条 404 后回退到根的 /models', async () => {
    const created = createProvider({
      ...CREATE,
      protocolType: 'anthropic',
      baseUrl: 'https://gw.example.com/anthropic',
    });
    addProviderModel(created.id, 'manual-keep');
    const fetchMock = stubUpstreamByUrl({
      'https://gw.example.com/anthropic/models': [404, 'not found'],
      'https://gw.example.com/anthropic/v1/models': [404, 'not found'],
      'https://gw.example.com/models': [200, { data: [{ id: 'root-m' }] }],
    });
    // 两条 404 各落一条 WARN（服务端诊断用，正文只进日志）：静音以保持用例输出干净
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const next = await fetchProviderModels(created.id);

    // 顺序即口径：配置地址的两条排在根的两条之前（命中时不该多绕一次根）
    expect(calledUrls(fetchMock)).toEqual([
      'https://gw.example.com/anthropic/models',
      'https://gw.example.com/anthropic/v1/models',
      'https://gw.example.com/models',
    ]);
    expect(next.models).toEqual([
      { id: 'manual-keep', source: 'manual' },
      { id: 'root-m', source: 'fetched' },
    ]);
  });

  it('地址带子路径（/api/v1）：只补一次 /v1，再回退到根的 /v1/models', async () => {
    const created = createProvider({ ...CREATE, baseUrl: 'https://gw.example.com/api/v1' });
    const fetchMock = stubUpstreamByUrl({
      'https://gw.example.com/api/v1/models': [404, 'not found'],
      'https://gw.example.com/models': [404, 'not found'],
      'https://gw.example.com/v1/models': [200, { data: [{ id: 'root-m' }] }],
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const next = await fetchProviderModels(created.id);

    // 已以 /v1 结尾 ⇒ 配置地址只有一条（不叠 /api/v1/v1/models）；根的两条按 /models → /v1/models 试
    expect(calledUrls(fetchMock)).toEqual([
      'https://gw.example.com/api/v1/models',
      'https://gw.example.com/models',
      'https://gw.example.com/v1/models',
    ]);
    expect(next.models).toEqual([{ id: 'root-m', source: 'fetched' }]);
  });

  it('地址已带 /v1 时根兜底仍然生效（/v1/models 404 → 根的 /models）', async () => {
    const created = createProvider({ ...CREATE, baseUrl: 'https://gw.example.com/v1' });
    const fetchMock = stubUpstreamByUrl({
      'https://gw.example.com/v1/models': [404, 'not found'],
      // 同一个 URL 不会试第二遍：去重后根的 /v1/models 不再出现
      'https://gw.example.com/models': [200, { data: [{ id: 'root-m' }] }],
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const next = await fetchProviderModels(created.id);

    expect(calledUrls(fetchMock)).toEqual(['https://gw.example.com/v1/models', 'https://gw.example.com/models']);
    expect(next.models).toEqual([{ id: 'root-m', source: 'fetched' }]);
  });

  it('配置地址与站点根都 404：文案点名全部四条路径，清单不动', async () => {
    const created = createProvider({ ...CREATE, baseUrl: 'https://gw.example.com/anthropic' });
    addProviderModel(created.id, 'manual-keep');
    const fetchMock = stubUpstreamByUrl({
      'https://gw.example.com/anthropic/models': [404, 'not found'],
      'https://gw.example.com/anthropic/v1/models': [404, 'not found'],
      'https://gw.example.com/models': [404, 'not found'],
      'https://gw.example.com/v1/models': [404, 'not found'],
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    let caught: unknown;
    try {
      await fetchProviderModels(created.id);
    } catch (error) {
      caught = error;
    }

    const serviceError = caught as ServiceError;
    expect(serviceError.code).toBe('INTERNAL');
    expect(serviceError.message).toContain('404');
    // 试了四条就必须点名四条 —— 只说「/anthropic/models 不存在」用户不会想到根上还有两条
    expect(serviceError.message).toContain(
      '/anthropic/models 与 /anthropic/v1/models 与 /models 与 /v1/models 都不存在',
    );
    expect(calledUrls(fetchMock)).toHaveLength(4);
    expect(stored(created.id)?.models).toEqual([{ id: 'manual-keep', source: 'manual' }]);
  });

  it('子路径下 401 一样不回退到根（密钥问题是同一堵墙）', async () => {
    // 根兜底不能把「密钥被拒」这层真因盖成「地址不存在」：判据仍然只有 404
    const created = createProvider({ ...CREATE, baseUrl: 'https://gw.example.com/anthropic' });
    const fetchMock = stubUpstreamByUrl({
      'https://gw.example.com/anthropic/models': [401, { error: 'bad key' }],
    });

    await expect(fetchProviderModels(created.id)).rejects.toMatchObject({ code: 'AUTH_FAILED' });
    expect(calledUrls(fetchMock)).toEqual(['https://gw.example.com/anthropic/models']);
  });
});

/** 跑一次拉取并丢弃结果：用于把上一轮的 fetched 条目铺进清单 */
async function fetchProviderModelsWith(providerId: string, data: unknown[]): Promise<void> {
  stubUpstream({ data });
  await fetchProviderModels(providerId);
  vi.unstubAllGlobals();
}

describe('fetchProviderModels：合并而非覆盖', () => {
  // §6.1 的两个实现要点之一，也是本计划最重要的回归守卫：手工补的模型每次拉取都丢，
  // 用户会以为是「界面没保存」，而实际上是被 fetched 结果整体冲掉了。
  it('手工条目原样保留（顺序在前、source 不变），新 id 追加为 fetched', async () => {
    const created = createProvider(CREATE);
    addProviderModel(created.id, 'm1');
    addProviderModel(created.id, 'm2');
    stubUpstream({ data: [{ id: 'm1' }, { id: 'm3' }] });

    const next = await fetchProviderModels(created.id);

    expect(next.models).toEqual([
      { id: 'm1', source: 'manual' },
      { id: 'm2', source: 'manual' },
      { id: 'm3', source: 'fetched' },
    ]);
    expect(stored(created.id)?.models).toEqual(next.models);
  });

  it('上一轮 fetched 的条目这次没再返回时被清掉，手工条目照旧留下', async () => {
    const created = createProvider(CREATE);
    addProviderModel(created.id, 'manual-keep');
    await fetchProviderModelsWith(created.id, [{ id: 'stale' }, { id: 'keep' }]);
    stubUpstream({ data: [{ id: 'keep' }] });

    const next = await fetchProviderModels(created.id);

    expect(next.models).toEqual([
      { id: 'manual-keep', source: 'manual' },
      { id: 'keep', source: 'fetched' },
    ]);
  });

  it('拉取结果里与手工条目同 id 的条目不会把它顶掉、也不会出现两条', async () => {
    const created = createProvider(CREATE);
    addProviderModel(created.id, 'm1');
    stubUpstream({ data: [{ id: 'm1' }] });

    const next = await fetchProviderModels(created.id);

    expect(next.models).toEqual([{ id: 'm1', source: 'manual' }]);
  });

  it('重复 id 在 fetched 集合里去重', async () => {
    const created = createProvider(CREATE);
    stubUpstream({ data: [{ id: 'm1' }, { id: 'm1' }, { id: 'm1' }] });

    const next = await fetchProviderModels(created.id);

    expect(next.models).toEqual([{ id: 'm1', source: 'fetched' }]);
  });

  // 上游 id 与清单的另外三个入口（新建/补丁的 manualModels、手工添加、按名删除）同一口径：
  // 都按 trim 后的形态比对。存原串会让上游的 `' m1 '` 与手工的 `'m1'` 并存成两条，
  // 而按 `' m1 '` 删除时比对的是 `'m1'` —— 删掉的正是**手工那条**，清单里留下一条用户从没手工加过、
  // 又删不掉的带空白条目（下一次拉取还会把它原样带回来）。
  it('上游返回的 id 去掉首尾空白：不与同 id 手工条目并存，删除也不会删错那条', async () => {
    const created = createProvider(CREATE);
    addProviderModel(created.id, 'm1');
    stubUpstream({ data: [{ id: ' m1 ' }, '  m2  ', 'm2'] });

    const next = await fetchProviderModels(created.id);

    expect(next.models).toEqual([
      { id: 'm1', source: 'manual' },
      { id: 'm2', source: 'fetched' },
    ]);
    expect(stored(created.id)?.models).toEqual(next.models);
    // 按带空白的 id 删除，删掉的必须是同一条（否则删掉的是手工条目、且留下的条目再也删不掉）
    expect(removeProviderModel(created.id, ' m1 ').models).toEqual([{ id: 'm2', source: 'fetched' }]);
  });
});

describe('fetchProviderModels：响应解析容错', () => {
  it('同时容忍 data[].id 与 data 为字符串数组两种形态', async () => {
    const created = createProvider(CREATE);
    stubUpstream({ data: [{ id: 'obj-form' }, 'str-form', { id: '' }, null, 42, {}] });

    const next = await fetchProviderModels(created.id);

    // 认不出的元素被跳过，**不能**兜底成 String(entry)：那会把 'null' / '[object Object]' 当模型名存进去
    expect(next.models).toEqual([
      { id: 'obj-form', source: 'fetched' },
      { id: 'str-form', source: 'fetched' },
    ]);
  });

  it('data 缺失或不是数组时一条都认不出：报含 host 的中文原因，且不落盘', async () => {
    const created = createProvider(CREATE);
    addProviderModel(created.id, 'manual-keep');
    stubUpstream({ models: [{ id: 'm1' }] });

    let caught: unknown;
    try {
      await fetchProviderModels(created.id);
    } catch (error) {
      caught = error;
    }

    expect((caught as ServiceError).code).toBe('INTERNAL');
    expect((caught as ServiceError).message).toContain('api.deepseek.com');
    expect((caught as ServiceError).message).toContain('没有可识别的模型');
    // 关键：空结果绝不覆盖已有清单，否则用户手工维护的模型会被一次异常响应清空
    expect(stored(created.id)?.models).toEqual([{ id: 'manual-keep', source: 'manual' }]);
  });

  it('响应体不是合法 JSON（网关返回登录页 HTML）时报中文原因且不落盘', async () => {
    const created = createProvider(CREATE);
    addProviderModel(created.id, 'manual-keep');
    stubUpstream('<html>请先登录</html>');

    let caught: unknown;
    try {
      await fetchProviderModels(created.id);
    } catch (error) {
      caught = error;
    }

    expect((caught as ServiceError).code).toBe('INTERNAL');
    expect((caught as ServiceError).message).toContain('不是合法 JSON');
    expect(stored(created.id)?.models).toEqual([{ id: 'manual-keep', source: 'manual' }]);
  });
});

describe('fetchProviderModels：上游错误码映射', () => {
  it('401 映射 AUTH_FAILED 且 context 带 host（界面据此指向设置页）', async () => {
    const created = createProvider(CREATE);
    stubUpstream({ error: 'bad key' }, 401);

    let caught: unknown;
    try {
      await fetchProviderModels(created.id);
    } catch (error) {
      caught = error;
    }

    expect((caught as ServiceError).code).toBe('AUTH_FAILED');
    expect((caught as ServiceError).context).toEqual({ host: 'api.deepseek.com' });
    expect((caught as ServiceError).message).toContain('API 密钥');
  });

  it('429 映射 RATE_LIMITED', async () => {
    const created = createProvider(CREATE);
    stubUpstream({ error: 'slow down' }, 429);

    await expect(fetchProviderModels(created.id)).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });

  it('其余状态码映射 INTERNAL 并带上状态码与 host', async () => {
    const created = createProvider(CREATE);
    stubUpstream('<html>502 Bad Gateway</html>', 502);
    // 正文片段会落一条 WARN（服务端诊断用），这里静音以保持用例输出干净
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    let caught: unknown;
    try {
      await fetchProviderModels(created.id);
    } catch (error) {
      caught = error;
    }

    expect((caught as ServiceError).code).toBe('INTERNAL');
    expect((caught as ServiceError).message).toContain('502');
    expect((caught as ServiceError).message).toContain('api.deepseek.com');
  });

  // message 会被页面原样渲染（`message.error(error.message)`），而网关的正文既可能是一整页登录
  // HTML，也可能**回显我们的请求头**（Authorization: Bearer <明文密钥>）—— 那等于把密钥画在界面上。
  // 正文因此只留在 context 与服务端日志里：诊断能力不降级，用户可见文案里不再有它。
  it('上游正文只进 context 与服务端日志，不进用户可见 message', async () => {
    const created = createProvider(CREATE);
    const echoed = `<html>502 Bad Gateway: Authorization: Bearer ${CREATE.apiKey}</html>`;
    stubUpstream(echoed, 502);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    let caught: unknown;
    try {
      await fetchProviderModels(created.id);
    } catch (error) {
      caught = error;
    }

    const serviceError = caught as ServiceError;
    expect(serviceError.code).toBe('INTERNAL');
    expect(serviceError.message).toContain('502');
    expect(serviceError.message).toContain('api.deepseek.com');
    expect(serviceError.message).not.toContain('Authorization');
    expect(serviceError.message).not.toContain(CREATE.apiKey);
    // 正文内容与旧实现逐字相同（前 200 字），只是换了去处
    expect(serviceError.context).toEqual({ host: 'api.deepseek.com', status: 502, body: echoed.slice(0, 200) });
    const logged = warn.mock.calls
      .flat()
      .map((part) => (typeof part === 'string' ? part : JSON.stringify(part)))
      .join(' ');
    expect(logged).toContain('Authorization');
    expect(logged).toContain('api.deepseek.com');
  });

  it('连不上时映射 INTERNAL 且 message 含 host（baseUrl 不是合法 URL 时也不抛第二个错）', async () => {
    const created = createProvider({ ...CREATE, baseUrl: '不是一个地址' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );

    let caught: unknown;
    try {
      await fetchProviderModels(created.id);
    } catch (error) {
      caught = error;
    }

    expect((caught as ServiceError).code).toBe('INTERNAL');
    expect((caught as ServiceError).message).toContain('不是一个地址');
  });
});

describe('fetchProviderModels：上游挂死的超时', () => {
  // 「只挂不断」的网关是最常见的失败形态：没有上限的 fetch 会让拉取永远不返回 ——
  // 界面既不报错也不结束（按钮一直转），用户只能刷新页面重来。
  // 这里的假上游**永不主动 resolve**，只在收到 abort 信号时才拒绝：于是这条用例同时证明了
  // 「15 秒上限真的挂上了」与「超时折成含 host 的中文原因」。
  it('上游 15 秒不响应即失败：中文超时原因 + host，且不会永远挂住、不落盘', async () => {
    vi.useFakeTimers();
    const created = createProvider(CREATE);
    const fetchMock = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const settled = fetchProviderModels(created.id).then(
      () => 'resolved' as const,
      (error: unknown) => error,
    );

    // 14_999 毫秒时仍在等待：把「15 秒」这个配置值本身钉住（不是随便给个信号就算数）
    await vi.advanceTimersByTimeAsync(14_999);
    expect(await Promise.race([settled, Promise.resolve('pending' as const)])).toBe('pending');

    await vi.advanceTimersByTimeAsync(1);
    // 用同一个竞速取结果，而不是直接 await settled：没有超时保护时请求会一直挂着，
    // 直接 await 只能靠 vitest 的用例超时（5 秒）来判失败 —— 那样失败信息是「超时」，
    // 分不清是被测行为挂住还是用例自己慢；这里断言「已经结算」，失败信息直接指向根因。
    const caught = await Promise.race([settled, Promise.resolve('pending' as const)]);

    expect(caught).not.toBe('pending');
    expect(caught).toBeInstanceOf(ServiceError);
    expect((caught as ServiceError).code).toBe('INTERNAL');
    expect((caught as ServiceError).message).toContain('api.deepseek.com');
    expect((caught as ServiceError).message).toContain('超时');
    // 超时绝不落盘：空清单写回去会静默清掉用户手工维护的模型
    expect(stored(created.id)?.models).toEqual([]);
  });
});

describe('fetchProviderModels：拉取窗口期的并发落盘', () => {
  // 本函数是「读配置 → await 网络 → 写回整份配置」，await 期间任何落盘改动都可能发生：
  // 另一个请求手工加模型、设置页保存、另一个客户端/另一个标签页。用 await **之前**读到的
  // config 整份写回，会把这些改动静默回滚 —— 症状正是「合并而非覆盖」要防的那类数据丢失，
  // 只不过丢的是**别的**改动。所以写回必须基于重新读到的配置。
  //
  // 窗口由假上游制造：fetch 桩在返回 /models 响应**之前**真的往磁盘上写两处改动。
  it('窗口期内的并发改动不被回写覆盖，本次拉取的合并结果照常生效', async () => {
    const created = createProvider(CREATE);
    addProviderModel(created.id, 'manual-keep');
    const fetchMock = vi.fn(async () => {
      // 并发写入 ①：另一个供应商（跨供应商的改动）
      createProvider({ ...CREATE, name: '窗口期新增的供应商', baseUrl: 'https://api.other.com/v1' });
      // 并发写入 ②：另一块配置（设置页保存）
      updateSettings({ theme: 'dark' });
      return new Response(JSON.stringify({ data: [{ id: 'fetched-1' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const next = await fetchProviderModels(created.id);

    // ① 本次拉取的语义不变：手工条目保留在前、新 id 追加为 fetched
    expect(next.models).toEqual([
      { id: 'manual-keep', source: 'manual' },
      { id: 'fetched-1', source: 'fetched' },
    ]);
    // ② 窗口期内的改动必须存活（stale 快照写回会把它们整段抹掉）
    const after = loadConfig();
    expect(after.providers.map((item) => item.name)).toEqual([CREATE.name, '窗口期新增的供应商']);
    expect(after.settings.theme).toBe('dark');
    // ③ 并且目标供应商的清单确实落到了盘上
    expect(after.providers.find((item) => item.id === created.id)?.models).toEqual(next.models);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

/**
 * 窗口的取数与落盘（spec §5.1 / D2）。
 * 上游字段名并不统一：实测 likecode 一个响应里同时给了六种同义字段，而别的网关可能一个都不给 ——
 * 所以这里既盯「优先级取对了」，也盯「取不到就是未知，不许编一个数」。
 */
describe('拉取时解析上下文窗口', () => {
  it('按字段优先级取第一个正整数，并落盘到对应模型条目', async () => {
    const provider = makeProvider({ models: [] });
    seedConfig({ providers: [provider] });
    stubUpstream({
      data: [
        { id: 'low', max_input_tokens: 1000, contextWindow: 2000, max_tokens: 7 },
        { id: 'mid', contextWindow: 2_000_000, max_output_tokens: 64 },
        { id: 'nested', limit: { context: 3_000_000, output: 128 } },
        { id: 'caps', capabilities: { contextWindow: 4_000_000 } },
        { id: 'str', context_window: '5000000' },
      ],
    });

    const stored = await fetchProviderModels(provider.id);
    const byId = new Map(stored.models.map((model) => [model.id, model]));
    expect(byId.get('low')).toMatchObject({ contextWindow: 1000, maxOutputTokens: 7 });
    expect(byId.get('mid')).toMatchObject({ contextWindow: 2_000_000, maxOutputTokens: 64 });
    expect(byId.get('nested')).toMatchObject({ contextWindow: 3_000_000, maxOutputTokens: 128 });
    expect(byId.get('caps')).toMatchObject({ contextWindow: 4_000_000 });
    expect(byId.get('str')).toMatchObject({ contextWindow: 5_000_000 });

    // 落盘事实（不只是内存返回值）
    expect(loadConfig().providers[0]?.models.find((model) => model.id === 'nested')?.contextWindow).toBe(3_000_000);
  });

  it('脏值一律跳过并继续看下一个候选字段；全都取不到就是未知（不写 0、不猜）', async () => {
    const provider = makeProvider({ models: [] });
    seedConfig({ providers: [provider] });
    stubUpstream({
      data: [
        { id: 'dirty', max_input_tokens: 0, contextWindow: -1, context_window: 1.5, context_length: 'abc' },
        { id: 'nullish', max_input_tokens: null, contextWindow: {}, context_window: '' },
        // 换了网关：字段名不在优先级表里 —— 期望「未知」，而不是抛错或猜一个值
        { id: 'unknown-field', context_size: 999 },
      ],
    });

    const stored = await fetchProviderModels(provider.id);
    for (const id of ['dirty', 'nullish', 'unknown-field']) {
      const model = stored.models.find((item) => item.id === id);
      expect(model?.contextWindow, id).toBeUndefined();
      expect(model?.maxOutputTokens, id).toBeUndefined();
    }
  });

  it('脏条目跳过、空清单不落盘（既有口径的回归）', async () => {
    const provider = makeProvider({ models: [{ id: 'keep', source: 'manual' }] });
    seedConfig({ providers: [provider] });
    stubUpstream({ data: [null, 42, { id: '' }, { id: 'ok', max_input_tokens: 8192 }] });

    const stored = await fetchProviderModels(provider.id);
    expect(stored.models.map((model) => model.id)).toEqual(['keep', 'ok']);
    expect(stored.models.find((model) => model.id === 'ok')?.contextWindow).toBe(8192);
  });
});

/**
 * 窗口的合并规则（spec §5.2 / D3）。
 * 三条里最要紧的是第一条：用户把网关填错的窗口改成真值之后，下一次拉取**不许**把它打回 ——
 * 打回是静默的（界面上看不出发生过什么），而用户以为自己的修改生效了。
 */
describe('窗口的合并规则', () => {
  it('用户手工改过的窗口不被拉取打回（逐字段来源 = manual）', async () => {
    const provider = makeProvider({
      models: [{ id: 'm', source: 'fetched', contextWindow: 123_456, contextWindowSource: 'manual' }],
    });
    seedConfig({ providers: [provider] });
    stubUpstream({ data: [{ id: 'm', max_input_tokens: 1_000_000 }] });

    const stored = await fetchProviderModels(provider.id);
    const model = stored.models.find((item) => item.id === 'm');
    // 上游说 1M、用户说 123456 ⇒ 听用户的
    expect(model?.contextWindow).toBe(123_456);
    expect(model?.contextWindowSource).toBe('manual');
  });

  it('上游这次没给窗口 ⇒ 窗口三格一起清掉（不保留上一轮的旧值）；manual 条目始终原样保留', async () => {
    const provider = makeProvider({
      models: [
        { id: 'stale', source: 'fetched', contextWindow: 999, contextWindowSource: 'fetched' },
        { id: 'hand', source: 'manual', contextWindow: 2048 },
      ],
    });
    seedConfig({ providers: [provider] });
    stubUpstream({ data: [{ id: 'stale' }] });

    const stored = await fetchProviderModels(provider.id);
    expect(stored.models.find((item) => item.id === 'stale')?.contextWindow).toBeUndefined();
    expect(stored.models.find((item) => item.id === 'hand')?.contextWindow).toBe(2048);
  });

  it('用户清空过窗口（manual 且没有值）⇒ 拉取也不会把它填回来', async () => {
    const provider = makeProvider({
      models: [{ id: 'm', source: 'fetched', contextWindowSource: 'manual' }],
    });
    seedConfig({ providers: [provider] });
    stubUpstream({ data: [{ id: 'm', max_input_tokens: 1_000_000 }] });

    const stored = await fetchProviderModels(provider.id);
    expect(stored.models.find((item) => item.id === 'm')?.contextWindow).toBeUndefined();
  });
});

/**
 * 手工设置窗口（spec §5.3）：设置页的行内编辑器走它。
 * 两条口径：写值要标 `manual`（下一次拉取才不会打回），**清空也要标** ——
 * 「清空」是一次明确的表态（别用上游那个数），而不只是「别覆盖这个数」。
 */
describe('设置模型窗口（手工覆盖）', () => {
  it('写入窗口时把来源标成 manual；清空时只清值、来源仍是 manual', () => {
    const provider = makeProvider({ models: [{ id: 'm', source: 'fetched', contextWindow: 1 }] });
    seedConfig({ providers: [provider] });

    const written = setProviderModelContext(provider.id, { id: 'm', contextWindow: 262_144 });
    expect(written.models[0]).toEqual({
      id: 'm',
      source: 'fetched',
      contextWindow: 262_144,
      contextWindowSource: 'manual',
    });

    const cleared = setProviderModelContext(provider.id, { id: 'm', contextWindow: null });
    expect(cleared.models[0]?.contextWindow).toBeUndefined();
    expect(cleared.models[0]?.contextWindowSource).toBe('manual');
    // 落盘事实
    expect(loadConfig().providers[0]?.models[0]?.contextWindowSource).toBe('manual');
  });

  it('清单里没有这条模型 ⇒ NOT_FOUND（与删除同口径，不静默新建条目）', () => {
    const provider = makeProvider({ models: [{ id: 'm', source: 'fetched' }] });
    seedConfig({ providers: [provider] });

    expect(() => setProviderModelContext(provider.id, { id: 'ghost', contextWindow: 1 })).toThrow(/ghost/);
    expect(loadConfig().providers[0]?.models.map((model) => model.id)).toEqual(['m']);
  });
});

/**
 * 思考强度的取数（spec §5.4 / D2）。
 * 上游给了**三种**形态，实测都在同一个响应里出现过；而「推荐档不在档位表里」这种自相矛盾的响应
 * 必须按「上游没说」处置 —— 拿它去配一个不存在的档位，运行时会硬报错。
 */
describe('拉取时解析思考强度', () => {
  it('三种形态：supportedEffortLevels / reasoning.supported_efforts / capabilities.effort 逐档对象', async () => {
    const provider = makeProvider({ models: [] });
    seedConfig({ providers: [provider] });
    stubUpstream({
      data: [
        { id: 'a', supportedEffortLevels: ['low', 'high', 'max'], recommendEffortLevel: 'high' },
        { id: 'b', reasoning: { supported_efforts: ['high', 'max'], default_effort: 'max' } },
        {
          id: 'c',
          capabilities: {
            effort: { supported: true, low: { supported: true }, high: { supported: true, recommend: true } },
          },
        },
      ],
    });

    const stored = await fetchProviderModels(provider.id);
    const byId = new Map(stored.models.map((model) => [model.id, model]));
    expect(byId.get('a')).toMatchObject({ supportedEfforts: ['low', 'high', 'max'], recommendedEffort: 'high' });
    expect(byId.get('b')).toMatchObject({ supportedEfforts: ['high', 'max'], recommendedEffort: 'max' });
    // 逐档对象形态：取值为对象且 supported === true 的键，保持上游顺序；recommend 标记者即推荐档
    expect(byId.get('c')).toMatchObject({ supportedEfforts: ['low', 'high'], recommendedEffort: 'high' });
  });

  it('推荐档不在档位表里 / 档位表为空 / 上游根本没给 ⇒ 都按「没说」处置（不猜、不补）', async () => {
    const provider = makeProvider({ models: [] });
    seedConfig({ providers: [provider] });
    stubUpstream({
      data: [
        { id: 'mismatch', supportedEffortLevels: ['low'], recommendEffortLevel: 'max' },
        { id: 'none', supportedEffortLevels: [] },
        { id: 'silent', max_input_tokens: 1000 },
      ],
    });

    const stored = await fetchProviderModels(provider.id);
    for (const id of ['mismatch', 'none', 'silent']) {
      const model = stored.models.find((item) => item.id === id);
      expect(model?.supportedEfforts, id).toBeUndefined();
      expect(model?.recommendedEffort, id).toBeUndefined();
    }
  });

  /**
   * **实测抓取的真实响应形状**（2026-09-28，likecode 网关 `GET /v1/models`，HTTP 200、47 条）。
   *
   * 为什么必须有这一条：上面那些用例用的是我构造的**简化**形状，而真实响应把六种同义字段、
   * 嵌套的 `limit` / `capabilities` / `top_provider`、以及逐档对象的 `capabilities.effort` 全塞在
   * 同一条里。取数的优先级表一旦被改错（比如把 `contextWindow` 提到 `max_input_tokens` 前面、
   * 或去读 `top_provider.context_length`），简化夹具仍可能全绿，而真网关会静默取到另一个数。
   * 三条样本逐字取自那次抓取（只保留我们真正读的字段，其余原样删掉不影响判据）。
   */
  it('实网关的三条样本（含六字段并存 / 无档位 / 逐档对象）解析出与我实测一致的数', async () => {
    const provider = makeProvider({ models: [] });
    seedConfig({ providers: [provider] });
    stubUpstream({
      data: [
        {
          id: 'jd/glm-5.2',
          max_input_tokens: 1048576,
          max_tokens: 131072,
          limit: { context: 1048576, output: 131072 },
          contextWindow: 1048576,
          context_window: 1048576,
          context_length: 1048576,
          maxTokens: 131072,
          maxOutputTokens: 131072,
          top_provider: { context_length: 1048576, max_completion_tokens: 131072 },
          supportedEffortLevels: ['high', 'max'],
          recommendEffortLevel: 'max',
          capabilities: {
            contextWindow: 1048576,
            effort: { supported: true, high: { supported: true, recommend: true }, max: { supported: true } },
          },
        },
        // Claude-Sonnet-4.6：窗口 1M，但**一个档位字段都没有**（thinking 也不支持）
        {
          id: 'Claude-Sonnet-4.6',
          max_input_tokens: 1000000,
          max_tokens: 64000,
          contextWindow: 1000000,
          context_length: 1000000,
          capabilities: { contextWindow: 1000000, thinking: { supported: false } },
        },
        // 五档 + 逐档对象（real payload 里 supportedEffortLevels 与 capabilities.effort 同时存在）
        {
          id: 'gpt-5.6-terra',
          max_input_tokens: 1050000,
          max_tokens: 128000,
          contextWindow: 1050000,
          supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
          recommendEffortLevel: 'high',
          capabilities: {
            effort: {
              supported: true,
              low: { supported: true },
              medium: { supported: true },
              high: { supported: true, recommend: true },
              xhigh: { supported: true },
              max: { supported: true },
            },
          },
        },
      ],
    });

    const stored = await fetchProviderModels(provider.id);
    const byId = new Map(stored.models.map((model) => [model.id, model]));
    expect(byId.get('jd/glm-5.2')).toMatchObject({
      contextWindow: 1_048_576,
      maxOutputTokens: 131_072,
      supportedEfforts: ['high', 'max'],
      recommendedEffort: 'max',
    });
    expect(byId.get('Claude-Sonnet-4.6')).toMatchObject({ contextWindow: 1_000_000, maxOutputTokens: 64_000 });
    expect(byId.get('Claude-Sonnet-4.6')?.supportedEfforts).toBeUndefined();
    expect(byId.get('gpt-5.6-terra')).toMatchObject({
      contextWindow: 1_050_000,
      supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      recommendedEffort: 'high',
    });
  });
});
