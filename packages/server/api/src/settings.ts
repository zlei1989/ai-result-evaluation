/**
 * 应用设置服务：读时归一化、写时按需校验、出口一律掩码。
 * 五个口径：
 *   1. 下行的 workspaceRoot / casesRoot **恒为绝对路径**——`~` 只在配置文件里作为可读的写法，
 *      到了客户端一律展开，避免每个消费方各自处理 `~`；
 *   2. 只有**改动根目录时**才做磁盘校验——改主题不该去动磁盘；
 *   3. `casesRoot` 的解析（环境变量只做默认值）与用例读写**共用同一个函数**
 *      （`resolveCasesRootForRead`）：两处各判一次必然漂移，症状是「设置页显示一个路径、用例落在另一个」；
 *   4. `saveConfig` 抛的裸 errno 折成可直接展示的中文 `INTERNAL`（见 `updateSettings` 的 catch，
 *      否则路由层会把 errno 原文返回给用户）；
 *   5. 本文件的两个入口都回 **`SettingsView`**（`env` / `headers` 的敏感值已掩码）。
 *      服务端自己要拿明文（MCP 注入）时读 `loadConfig()`——照 `providers.ts` 的先例：
 *      出口走 view，真源永远是落盘那份，别把掩码串注进厂商配置。
 */
import {
  ServiceError,
  SETTINGS_DEFAULTS,
  preserveUnchangedSecrets,
  toSettingsView,
  type Settings,
  type SettingsPatch,
  type SettingsView,
} from '@aieval/contracts';
import {
  getConfigDir,
  loadConfig,
  resolveCasesRootForRead,
  resolveRootForRead,
  saveConfig,
  validateCasesRoot,
  validateWorkspaceRoot,
} from '@aieval/core';

/**
 * 归一化：补全缺失字段并把两个根目录展开为绝对路径（只展开，不校验可写性）。
 * 这里的 `|| SETTINGS_DEFAULTS.*` 是**必需的防御**，不是多余的兜底：
 * `SettingsPatch.workspaceRoot` 的类型是 `string | undefined`，所以 `{ workspaceRoot: undefined }`
 * 能通过类型检查；它经 `{ ...config.settings, ...patch }` 合并后会把存量根目录覆盖成 `undefined`，
 * 而 `patch.workspaceRoot !== undefined` 的校验闸门**正好放它过去**（校验被跳过）。
 * 没有这一层，坏值会一路走到读取路径，让一个契约上只对外吐中文 ServiceError 的服务
 * 抛出原始的英文 TypeError（`Cannot read properties of undefined (reading 'startsWith')`）。
 * `resolveRootForRead` 已把 `''` 映射为默认值，`||` 用同一个算子把 `undefined`/`null` 一并覆盖。
 * `casesRoot` 走的是同一个形状，只是它的默认值还要经过环境变量（见 `resolveCasesRootForRead`）。
 */
function normalize(settings: Settings): Settings {
  return {
    ...SETTINGS_DEFAULTS,
    ...settings,
    workspaceRoot: resolveRootForRead(settings.workspaceRoot || SETTINGS_DEFAULTS.workspaceRoot),
    casesRoot: resolveCasesRootForRead(settings.casesRoot || SETTINGS_DEFAULTS.casesRoot),
  };
}

/**
 * 读设置：归一化后**转出口形态**（MCP 的 `env` / `headers` 敏感值出掩码）。
 * 转换只影响返回值，落盘那份一字不动——`toSettingsView` 会新建整棵对象，不是就地改写。
 */
export function getSettings(): SettingsView {
  return toSettingsView(normalize(loadConfig().settings));
}

/**
 * 应用设置补丁。改动根目录（工作区 / 用例）时先校验（不可写则抛 NOT_WRITABLE 且不落盘），
 * 其余字段直接合并。
 * 校验出现在**同一个请求**里是为了不让设置页出现半生效状态：两格各存一次的话，
 * 用户会拿到「工作区已改、用例目录没改」这种谁也解释不清的结果。
 *
 * 合并**之前**先消解 MCP 密钥的「未改动」信号（空串 / 与本服务端掩码串逐字相同 ⇒ 保留落盘原值）：
 * `mcpServers` 是整份替换，界面拿到的是掩码，原样回传会把真密钥覆盖成掩码串。
 * 返回值同 `getSettings` —— 出口形态，别拿它当落盘真源用。
 */
export function updateSettings(patch: SettingsPatch): SettingsView {
  const config = loadConfig();
  let next: Settings = { ...config.settings, ...preserveUnchangedSecrets(config.settings, patch) };

  if (patch.workspaceRoot !== undefined) {
    const { resolved } = validateWorkspaceRoot(patch.workspaceRoot);
    next = { ...next, workspaceRoot: resolved };
  }
  if (patch.casesRoot !== undefined) {
    const { resolved } = validateCasesRoot(patch.casesRoot);
    next = { ...next, casesRoot: resolved };
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
  return toSettingsView(next);
}
