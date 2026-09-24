/** contracts 公共出口：跨端共享的契约与错误模型。框架层只从这里 import。 */
export { ERROR_CODES, ServiceError, httpStatusFor, type ErrorCode } from './errors';
export {
  DefaultJudgeSchema,
  SETTINGS_DEFAULTS,
  SettingsPatchSchema,
  SettingsSchema,
  ThemeModeSchema,
  type Settings,
  type SettingsPatch,
  type ThemeMode,
} from './settings';
