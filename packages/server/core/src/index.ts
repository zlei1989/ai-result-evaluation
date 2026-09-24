/** core 公共出口：零依赖基础能力（日志、配置落盘、路径工具）。 */
export { createLogger, type Logger } from './logger';
export {
  getConfigDir,
  loadConfig,
  saveConfig,
  setConfigDirForTesting,
  type AppConfig,
  type ProviderModelRecord,
  type ProviderRecord,
  type ProtocolType,
  type TestCaseRecord,
} from './config-store';
export { defaultWorkspaceRoot, expandHome, resolveRootForRead, validateWorkspaceRoot } from './paths';
