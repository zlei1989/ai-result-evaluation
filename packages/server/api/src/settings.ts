/**
 * 应用设置服务：读时归一化、写时按需校验。
 * 两个口径：
 *   1. 下行的 workspaceRoot **恒为绝对路径**——`~` 只在配置文件里作为可读的写法，
 *      到了客户端一律展开，避免每个消费方各自处理 `~`；
 *   2. 只有**改动 workspaceRoot 时**才做磁盘校验——改主题不该去动磁盘。
 */
import { ServiceError, SETTINGS_DEFAULTS, type Settings, type SettingsPatch } from '@aieval/contracts';
import { getConfigDir, loadConfig, resolveRootForRead, saveConfig, validateWorkspaceRoot } from '@aieval/core';

/**
 * 归一化：补全缺失字段并把 workspaceRoot 展开为绝对路径（只展开，不校验可写性）。
 * 这里的 `|| SETTINGS_DEFAULTS.workspaceRoot` 是**必需的防御**，不是多余的兜底：
 * `SettingsPatch.workspaceRoot` 的类型是 `string | undefined`，所以 `{ workspaceRoot: undefined }`
 * 能通过类型检查；它经 `{ ...config.settings, ...patch }` 合并后会把存量根目录覆盖成 `undefined`，
 * 而 `patch.workspaceRoot !== undefined` 的校验闸门**正好放它过去**（校验被跳过）。
 * 没有这一层，坏值会一路走到读取路径，让一个契约上只对外吐中文 ServiceError 的服务
 * 抛出原始的英文 TypeError（`Cannot read properties of undefined (reading 'startsWith')`）。
 * `resolveRootForRead` 已把 `''` 映射为默认值，`||` 用同一个算子把 `undefined`/`null` 一并覆盖。
 */
function normalize(settings: Settings): Settings {
  return {
    ...SETTINGS_DEFAULTS,
    ...settings,
    workspaceRoot: resolveRootForRead(settings.workspaceRoot || SETTINGS_DEFAULTS.workspaceRoot),
  };
}

export function getSettings(): Settings {
  return normalize(loadConfig().settings);
}

/**
 * 应用设置补丁。改动 workspaceRoot 时先校验（不可写则抛 NOT_WRITABLE 且不落盘），
 * 其余字段直接合并。
 */
export function updateSettings(patch: SettingsPatch): Settings {
  const config = loadConfig();
  let next: Settings = { ...config.settings, ...patch };

  if (patch.workspaceRoot !== undefined) {
    const { resolved } = validateWorkspaceRoot(patch.workspaceRoot);
    next = { ...next, workspaceRoot: resolved };
  }

  next = normalize(next);
  config.settings = next;
  // saveConfig 可能抛原始 errno（EPERM / ENOSPC / 只读盘），而契约要求对外错误一律是
  // 可直接展示的中文原因。这里折成 ServiceError，否则路由层会把 errno 原文返回给用户。
  try {
    saveConfig(config);
  } catch (error) {
    throw error instanceof ServiceError
      ? error
      : new ServiceError('INTERNAL', `设置保存失败（${getConfigDir()}）：${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  return next;
}
