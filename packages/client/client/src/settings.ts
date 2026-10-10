/**
 * 设置数据层：GET /api/settings + PUT 补丁。
 * 回写约定：mutation 成功后 populateCache 回写响应，并 revalidate:false ——
 * 少了 revalidate:false，紧随其后的 GET 会用旧值覆盖刚写入的新值（表现为主题弹回去）。
 */
import useSWR from 'swr';
import useSWRMutation from 'swr/mutation';
import type { SettingsPatch, SettingsView } from '@aieval/contracts';
import { getJson, putJson } from './http';

const KEY = '/api/settings';

export function useSettings(): {
  settings: SettingsView | undefined;
  error: unknown;
  isLoading: boolean;
  update: (patch: SettingsPatch) => Promise<SettingsView>;
  isUpdating: boolean;
} {
  // 类型是**出口形态**（`SettingsView`）：GET 与 PUT 回的都是掩码后的那份，明文密钥不会经这里到界面。
  // 服务端要明文时读落盘的 `Settings`（见 api 的 settings.ts），那是另一条线，别从这里绕回去。
  const { data, error, isLoading } = useSWR<SettingsView>(KEY, getJson);
  const { trigger, isMutating } = useSWRMutation(
    KEY,
    (key: string, { arg }: { arg: SettingsPatch }) => putJson<SettingsView>(key, arg),
    { populateCache: true, revalidate: false },
  );
  return { settings: data, error, isLoading, update: trigger, isUpdating: isMutating };
}
