/**
 * 供应商数据层：列表 + 增删改 + 模型清单增删 + /models 拉取。
 *
 * 回写约定与 settings.ts 同源，但有一处**刻意不同**：
 *   - 这些 mutation 一律**不开 `populateCache`**。后端返回的是**单个** `ProviderView`，而 mutation 的
 *     key 指向的是**列表**；把单个对象写进列表缓存，下一次渲染 `providers.map` 直接 TypeError。
 *   - 列表刷新改为 mutation 成功后显式 `mutate(LIST_KEY)`（契约 §7「列表类在 mutation 后显式 mutate 一次刷新」）。
 *   - 显式 `revalidate: false` 关掉 useSWRMutation 默认的「成功后自动重新验证」：否则一次删除会发两次 GET，
 *     而「刷新了几次」正是本包测试要钉的东西。
 */
import useSWR, { useSWRConfig } from 'swr';
import useSWRMutation from 'swr/mutation';
import type { ProviderCreate, ProviderModelCapability, ProviderPatch, ProviderView } from '@aieval/contracts';
import { delJson, getJson, postJson, putJson } from './http';

const LIST_KEY = '/api/providers';

/** DELETE /api/providers/{id} 的响应体：路由回 `{ ok: true }` 而不是 204（delJson 走 res.json()，空体会抛 SyntaxError） */
interface OkBody {
  ok: boolean;
}

/**
 * 单条模型增删的 URL。
 * `modelId` 必须 encodeURIComponent：模型名里带 `+` / `#` / `&` 是常态（`vendor/model+x`），
 * 不编码时 `#` 之后会被当片段丢掉、`+` 会被服务端解成空格 —— 表现是「点了删除没反应」或删错条目。
 */
function modelsUrl(providerId: string, modelId?: string): string {
  const base = `${LIST_KEY}/${encodeURIComponent(providerId)}/models`;
  return modelId === undefined ? base : `${base}?modelId=${encodeURIComponent(modelId)}`;
}

export function useProviders(): {
  providers: ProviderView[] | undefined;
  error: unknown;
  isLoading: boolean;
  refresh: () => void;
} {
  const { data, error, isLoading, mutate } = useSWR<ProviderView[]>(LIST_KEY, getJson);
  return {
    providers: data,
    error,
    isLoading,
    // 包一层而不是直接把 mutate 透出去：契约要求 refresh 是「无参、无返回」的动作
    refresh: (): void => {
      void mutate();
    },
  };
}

export function useCreateProvider(): {
  create: (input: ProviderCreate) => Promise<ProviderView>;
  isCreating: boolean;
} {
  const { mutate } = useSWRConfig();
  const { trigger, isMutating } = useSWRMutation(
    LIST_KEY,
    (key: string, { arg }: { arg: ProviderCreate }) => postJson<ProviderView>(key, arg),
    { revalidate: false },
  );
  const create = async (input: ProviderCreate): Promise<ProviderView> => {
    const created = await trigger(input);
    await mutate(LIST_KEY);
    return created;
  };
  return { create, isCreating: isMutating };
}

export function useUpdateProvider(): {
  update: (id: string, patch: ProviderPatch) => Promise<ProviderView>;
  isUpdating: boolean;
} {
  const { mutate } = useSWRConfig();
  const { trigger, isMutating } = useSWRMutation(
    LIST_KEY,
    (key: string, { arg }: { arg: { id: string; patch: ProviderPatch } }) =>
      putJson<ProviderView>(`${key}/${encodeURIComponent(arg.id)}`, arg.patch),
    { revalidate: false },
  );
  const update = async (id: string, patch: ProviderPatch): Promise<ProviderView> => {
    const updated = await trigger({ id, patch });
    await mutate(LIST_KEY);
    return updated;
  };
  return { update, isUpdating: isMutating };
}

export function useDeleteProvider(): { remove: (id: string) => Promise<void>; isDeleting: boolean } {
  const { mutate } = useSWRConfig();
  const { trigger, isMutating } = useSWRMutation(
    LIST_KEY,
    (key: string, { arg }: { arg: string }) => delJson<OkBody>(`${key}/${encodeURIComponent(arg)}`),
    { revalidate: false },
  );
  const remove = async (id: string): Promise<void> => {
    await trigger(id);
    await mutate(LIST_KEY);
  };
  return { remove, isDeleting: isMutating };
}

export function useFetchProviderModels(): {
  fetchModels: (id: string) => Promise<ProviderView>;
  isFetching: boolean;
} {
  const { mutate } = useSWRConfig();
  const { trigger, isMutating } = useSWRMutation(
    LIST_KEY,
    (key: string, { arg }: { arg: string }) =>
      postJson<ProviderView>(`${key}/${encodeURIComponent(arg)}/models/fetch`, {}),
    { revalidate: false },
  );
  const fetchModels = async (id: string): Promise<ProviderView> => {
    const view = await trigger(id);
    await mutate(LIST_KEY);
    return view;
  };
  return { fetchModels, isFetching: isMutating };
}

export function useProviderModels(): {
  add: (id: string, modelId: string) => Promise<ProviderView>;
  remove: (id: string, modelId: string) => Promise<ProviderView>;
  /**
   * 设置某条模型的上下文窗口；`contextWindow: null` = 清空（服务端会记住「这是用户的手工表态」，
   * 下一次拉取不再覆盖它）。走 PUT 而不是 PATCH：本包 http 原语里只有 putJson。
   */
  setContext: (id: string, modelId: string, capability: ProviderModelCapability) => Promise<ProviderView>;
  isMutating: boolean;
} {
  const { mutate } = useSWRConfig();
  const addMutation = useSWRMutation(
    LIST_KEY,
    (_key: string, { arg }: { arg: { id: string; modelId: string } }) =>
      postJson<ProviderView>(modelsUrl(arg.id), { id: arg.modelId, source: 'manual' }),
    { revalidate: false },
  );
  const removeMutation = useSWRMutation(
    LIST_KEY,
    (_key: string, { arg }: { arg: { id: string; modelId: string } }) =>
      delJson<ProviderView>(modelsUrl(arg.id, arg.modelId)),
    { revalidate: false },
  );
  const setContextMutation = useSWRMutation(
    LIST_KEY,
    (_key: string, { arg }: { arg: { id: string; modelId: string; capability: ProviderModelCapability } }) =>
      putJson<ProviderView>(modelsUrl(arg.id), { id: arg.modelId, ...arg.capability }),
    { revalidate: false },
  );
  const add = async (id: string, modelId: string): Promise<ProviderView> => {
    const view = await addMutation.trigger({ id, modelId });
    await mutate(LIST_KEY);
    return view;
  };
  const remove = async (id: string, modelId: string): Promise<ProviderView> => {
    const view = await removeMutation.trigger({ id, modelId });
    await mutate(LIST_KEY);
    return view;
  };
  const setContext = async (
    id: string,
    modelId: string,
    capability: ProviderModelCapability,
  ): Promise<ProviderView> => {
    const view = await setContextMutation.trigger({ id, modelId, capability });
    await mutate(LIST_KEY);
    return view;
  };
  return {
    add,
    remove,
    setContext,
    isMutating: addMutation.isMutating || removeMutation.isMutating || setContextMutation.isMutating,
  };
}
