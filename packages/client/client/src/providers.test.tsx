/**
 * 供应商 hooks：列表读取与 refresh、增删改、模型清单增删、拉取，以及**mutation 后列表刷新**。
 *
 * 每个用例挂一份全新的 SWR 缓存：默认 cache 是模块级单例，沿用同一份会让第二个用例挂载时
 * 直接命中上一个用例的数据与在飞去重项，一次 GET 都不发（理由同 settings.test.tsx）。
 */
import { createElement, type ReactNode } from 'react';
import { SWRConfig } from 'swr';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { ProviderView } from '@aieval/contracts';
import {
  useCreateProvider,
  useDeleteProvider,
  useFetchProviderModels,
  useProviderModels,
  useProviders,
  useUpdateProvider,
} from './providers';

const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(SWRConfig, { value: { provider: () => new Map() } }, children);

afterEach(() => {
  vi.unstubAllGlobals();
});

/** 下行形态的供应商：只有掩码，没有 apiKey */
const VIEW: ProviderView = {
  id: 'p-1',
  name: 'DeepSeek 官方',
  protocolType: 'openai',
  baseUrl: 'https://api.deepseek.com/v1',
  apiKeyMasked: 'sk-***mnop',
  models: [{ id: 'deepseek-chat', source: 'manual' }],
  createdAt: '2026-09-22T10:00:00.000Z',
  updatedAt: '2026-09-22T10:00:00.000Z',
};

const CREATE_INPUT = {
  name: 'DeepSeek 官方',
  protocolType: 'openai' as const,
  baseUrl: 'https://api.deepseek.com/v1',
  apiKey: 'sk-secret',
  models: [],
};

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

/** 造一个按方法分派的 fetch 桩，并记录每一次调用 */
function stubFetch(handlers: { list?: ProviderView[]; mutation?: ProviderView } = {}): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    if ((init?.method ?? 'GET') === 'GET') return json(handlers.list ?? [VIEW]);
    return json(handlers.mutation ?? VIEW);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/**
 * 造一个「mutation 成功后 GET 才会给出新内容」的假上游：列表有没有被刷新，直接看得到。
 * 断言可观测的**列表内容**，而不是「mutate 被调用过」—— 后者对任何实现都成立；
 * 而列表刷新正是设置页依赖的东西：不刷新时界面停在旧数据上，用户以为「保存没生效」。
 */
function stubListAfterMutation(next: ProviderView[], mutationBody: unknown): ReturnType<typeof vi.fn> {
  let list: ProviderView[] = [VIEW];
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    if ((init?.method ?? 'GET') === 'GET') return json(list);
    list = next;
    return json(mutationBody);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('useProviders', () => {
  it('挂载后 GET /api/providers（cache key 就是真实路由）', async () => {
    const fetchMock = stubFetch();

    const { result } = renderHook(() => useProviders(), { wrapper });

    await waitFor(() => expect(result.current.providers).toBeDefined());
    expect(result.current.providers?.[0]?.name).toBe('DeepSeek 官方');
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/providers');
  });

  it('refresh 再发一次 GET', async () => {
    const fetchMock = stubFetch();
    const { result } = renderHook(() => useProviders(), { wrapper });
    await waitFor(() => expect(result.current.providers).toBeDefined());

    result.current.refresh();

    await waitFor(() =>
      expect(fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === undefined).length)
        .toBeGreaterThanOrEqual(2),
    );
  });
});

describe('useCreateProvider', () => {
  it('create 发 POST /api/providers，体里是四个字段 + 空清单', async () => {
    const fetchMock = stubFetch({ mutation: VIEW });
    const { result } = renderHook(() => useCreateProvider(), { wrapper });

    const created = await result.current.create(CREATE_INPUT);

    expect(created.id).toBe('p-1');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/providers');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual(CREATE_INPUT);
  });

  // 这条是本任务的核心守卫：mutation 若不刷新列表，新建的供应商在页面上「保存成功但列表里没有」。
  // 断言可观测结果（列表内容），不是断言「mutate 被调用过」——后者对任何实现都成立。
  it('create 成功后列表里出现新建的那条', async () => {
    let list: ProviderView[] = [];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'GET') return json(list);
      list = [VIEW];
      return json(VIEW);
    });
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => ({ list: useProviders(), create: useCreateProvider() }), { wrapper });
    await waitFor(() => expect(result.current.list.providers).toEqual([]));

    await result.current.create.create(CREATE_INPUT);

    await waitFor(() => expect(result.current.list.providers?.[0]?.id).toBe('p-1'));
  });
});

describe('useUpdateProvider / useDeleteProvider', () => {
  it('update 发 PUT /api/providers/{id}：id 进 URL、补丁进体', async () => {
    const fetchMock = stubFetch({ mutation: VIEW });
    const { result } = renderHook(() => useUpdateProvider(), { wrapper });

    await result.current.update('p-1', { name: '改名了' });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/providers/p-1');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(String(init.body))).toEqual({ name: '改名了' });
  });

  it('remove 发 DELETE /api/providers/{id} 并返回 void', async () => {
    const fetchMock = stubFetch();
    const { result } = renderHook(() => useDeleteProvider(), { wrapper });

    await expect(result.current.remove('p-1')).resolves.toBeUndefined();

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/providers/p-1');
    expect(init.method).toBe('DELETE');
  });

  // 与 create 同一条守卫：mutation 之后不刷新列表，改名在页面上就是「保存成功但列表没变」，
  // 用户只能刷新页面才看得到（页面的三态分支正是按列表渲染的）。
  it('update 成功后列表刷新成新内容', async () => {
    const renamed = { ...VIEW, name: '改名了' };
    stubListAfterMutation([renamed], renamed);
    const { result } = renderHook(() => ({ list: useProviders(), update: useUpdateProvider() }), { wrapper });
    await waitFor(() => expect(result.current.list.providers?.[0]?.name).toBe('DeepSeek 官方'));

    await result.current.update.update('p-1', { name: '改名了' });

    await waitFor(() => expect(result.current.list.providers?.[0]?.name).toBe('改名了'));
  });

  it('remove 成功后列表刷新（被删的那条从列表里消失）', async () => {
    stubListAfterMutation([], { ok: true });
    const { result } = renderHook(() => ({ list: useProviders(), remove: useDeleteProvider() }), { wrapper });
    await waitFor(() => expect(result.current.list.providers).toEqual([VIEW]));

    await result.current.remove.remove('p-1');

    await waitFor(() => expect(result.current.list.providers).toEqual([]));
  });
});

describe('useFetchProviderModels', () => {
  it('fetchModels 发 POST /api/providers/{id}/models/fetch', async () => {
    const fetchMock = stubFetch({ mutation: VIEW });
    const { result } = renderHook(() => useFetchProviderModels(), { wrapper });

    const view = await result.current.fetchModels('p-1');

    expect(view.models).toEqual(VIEW.models);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/providers/p-1/models/fetch');
    expect(init.method).toBe('POST');
  });

  // 拉取的合并结果落在列表里，弹窗里的模型清单跟着刷新（清单就是按列表props渲染的）。
  it('fetchModels 成功后列表刷新成新清单', async () => {
    const fetched = { ...VIEW, models: [{ id: 'deepseek-reasoner', source: 'fetched' as const }] };
    stubListAfterMutation([fetched], fetched);
    const { result } = renderHook(() => ({ list: useProviders(), fetch: useFetchProviderModels() }), { wrapper });
    await waitFor(() => expect(result.current.list.providers?.[0]?.models).toEqual(VIEW.models));

    await result.current.fetch.fetchModels('p-1');

    await waitFor(() =>
      expect(result.current.list.providers?.[0]?.models).toEqual([{ id: 'deepseek-reasoner', source: 'fetched' }]),
    );
  });
});

describe('useProviderModels', () => {
  it('add 发 POST /api/providers/{id}/models，体里是 { id, source: manual }', async () => {
    const fetchMock = stubFetch({ mutation: VIEW });
    const { result } = renderHook(() => useProviderModels(), { wrapper });

    await result.current.add('p-1', 'deepseek-reasoner');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/providers/p-1/models');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ id: 'deepseek-reasoner', source: 'manual' });
  });

  // 模型名里带 `/` `+` `#` 是常态（`vendor/model+x`）。不 encodeURIComponent 时
  // `#` 之后会被当片段丢掉、`+` 会被服务端解成空格 —— 表现是「点了删除没反应」或删错条目。
  it('remove 把 modelId 编码进 query（/ + # 都必须转义）', async () => {
    const fetchMock = stubFetch({ mutation: VIEW });
    const { result } = renderHook(() => useProviderModels(), { wrapper });

    await result.current.remove('p-1', 'vendor/model+x#1');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/providers/p-1/models?modelId=vendor%2Fmodel%2Bx%231');
    expect(init.method).toBe('DELETE');
  });

  // 模型清单的增删也以**列表**为准（页面把列表里的 ProviderView 传给弹窗）：不刷新时
  // 用户刚加的模型不出现在弹窗里，会以为「添加没生效」而重复点。
  it('add 成功后列表刷新（新模型出现在列表的那条供应商下）', async () => {
    const added = { ...VIEW, models: [...VIEW.models, { id: 'deepseek-reasoner', source: 'manual' as const }] };
    stubListAfterMutation([added], added);
    const { result } = renderHook(() => ({ list: useProviders(), models: useProviderModels() }), { wrapper });
    await waitFor(() => expect(result.current.list.providers?.[0]?.models).toEqual(VIEW.models));

    await result.current.models.add('p-1', 'deepseek-reasoner');

    await waitFor(() =>
      expect(result.current.list.providers?.[0]?.models).toEqual([
        { id: 'deepseek-chat', source: 'manual' },
        { id: 'deepseek-reasoner', source: 'manual' },
      ]),
    );
  });

  it('remove 成功后列表刷新（被删的模型从清单里消失）', async () => {
    const removed = { ...VIEW, models: [] };
    stubListAfterMutation([removed], removed);
    const { result } = renderHook(() => ({ list: useProviders(), models: useProviderModels() }), { wrapper });
    await waitFor(() => expect(result.current.list.providers?.[0]?.models).toEqual(VIEW.models));

    await result.current.models.remove('p-1', 'deepseek-chat');

    await waitFor(() => expect(result.current.list.providers?.[0]?.models).toEqual([]));
  });

  // 设置窗口走 PUT：`modelId` 只进体里（不进 query），而 `null` 必须**原样发出去**
  // —— 它是「清空」这个意图的载体，被 `?? ''` 或 `|| undefined` 抹掉就等于改成了「不改」。
  it('setContext 发 PUT /api/providers/{id}/models，体里是 { id, contextWindow, maxOutputTokens }', async () => {
    const fetchMock = stubFetch({ mutation: VIEW });
    const { result } = renderHook(() => useProviderModels(), { wrapper });

    await result.current.setContext('p-1', 'vendor/model+x', { contextWindow: 262_144, maxOutputTokens: 8_192 });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/providers/p-1/models');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(String(init.body))).toEqual({
      id: 'vendor/model+x',
      contextWindow: 262_144,
      maxOutputTokens: 8_192,
    });
  });

  it('setContext 传 null 表示清空（两格都原样进体，不被吞掉）', async () => {
    const fetchMock = stubFetch({ mutation: VIEW });
    const { result } = renderHook(() => useProviderModels(), { wrapper });

    await result.current.setContext('p-1', 'm', { contextWindow: null, maxOutputTokens: null });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ id: 'm', contextWindow: null, maxOutputTokens: null });
  });
});
