/**
 * 设置数据层：GET /api/settings + PUT 补丁。
 * 回写约定：mutation 成功后 populateCache 回写响应，并 revalidate:false ——
 * 少了 revalidate:false，紧随其后的 GET 会用旧值覆盖刚写入的新值（表现为主题弹回去）。
 */
import useSWR from 'swr';
import useSWRMutation from 'swr/mutation';
import type { Settings, SettingsPatch } from '@aieval/contracts';
import { getJson, putJson } from './http';

const KEY = '/api/settings';

export function useSettings(): {
  settings: Settings | undefined;
  error: unknown;
  isLoading: boolean;
  update: (patch: SettingsPatch) => Promise<Settings>;
  isUpdating: boolean;
} {
  const { data, error, isLoading } = useSWR<Settings>(KEY, getJson);
  const { trigger, isMutating } = useSWRMutation(
    KEY,
    (key: string, { arg }: { arg: SettingsPatch }) => putJson<Settings>(key, arg),
    { populateCache: true, revalidate: false },
  );
  return { settings: data, error, isLoading, update: trigger, isUpdating: isMutating };
}
