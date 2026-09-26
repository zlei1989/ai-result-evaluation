/** core 公共出口：零依赖基础能力（日志、配置落盘、路径工具、git 原语、工作区、事件日志）。 */
export { createLogger, type Logger } from './logger';
export {
  getConfigDir,
  loadConfig,
  saveConfig,
  setConfigDirForTesting,
  type AppConfig,
} from './config-store';
export { defaultWorkspaceRoot, expandHome, resolveRootForRead, validateWorkspaceRoot } from './paths';
export {
  assertCommit,
  checkoutRow,
  collectDiff,
  copyWorkspace,
  ensureCaseCache,
  extractDiffFile,
  isGitRepo,
  listCommits,
  resolveRepoInfo,
  truncateDiff,
} from './git';
export {
  REMOTE_PROBE_TIMEOUT_MS,
  REMOTE_TRANSFER_TIMEOUT_MS,
  defaultBranchName,
  ensureMirror,
  ensureRemotesDir,
  fetchMirror,
  isMirrorReady,
  mirrorDir,
  probeRemote,
  readMirrorRecord,
  remotesDir,
  resolveRemoteRef,
} from './mirror';
export {
  caseCacheDir,
  ensureRowJudgeHome,
  prepareRowWorkspace,
  rowAgentHomeDir,
  rowAttemptsFile,
  rowDir,
  rowEventsFile,
  rowJudgeHomeDir,
  rowMessagesFile,
  rowWorkspaceDir,
  runDir,
  runSnapshotFile,
} from './workspace';
export { appendEvent, readEvents, readEventsAfter, resetEvents, type PendingAgentEvent } from './event-log';
export {
  appendMessage,
  appendRecord,
  appendSubagent,
  foldMessages,
  foldSubagents,
  readRecords,
  readRowRecords,
  resetRecords,
} from './message-log';
