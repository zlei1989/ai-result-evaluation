/** core 公共出口：零依赖基础能力（日志、配置落盘、路径工具、git 原语、工作区、事件日志）。 */
export { createLogger, type Logger } from './logger';
export {
  getConfigDir,
  loadConfig,
  saveConfig,
  setConfigDirForTesting,
  type AppConfig,
} from './config-store';
export {
  assertSkillName,
  compareSkillNames,
  getSkillsRoot,
  isSkillDisabled,
  readSkillFileText,
  readSkillTree,
  scanSkills,
  skillsDirOf,
  type ScannedSkill,
  type SkillScan,
} from './skill-store';
export {
  SkillMaterializeError,
  installableSkills,
  materializeSkills,
  type SkillMaterializeInput,
  type SkillSource,
} from './skill-materialize';
export {
  assertCaseId,
  caseFile,
  deleteCaseFile,
  getCasesRoot,
  getCasesRootOverrideForTesting,
  listCases,
  readCase,
  setCasesRootForTesting,
  writeCase,
} from './case-store';
export {
  abortPendingGitOperation,
  aheadBehind,
  commitFile,
  currentBranch,
  fastForwardToUpstream,
  fetchRemote,
  headCommit,
  isPathDirty,
  isRepoRoot,
  listCommitsSince,
  mergeUpstream,
  pathStatusCode,
  pushRemote,
  readWorktreeState,
  remoteNames,
  resetSoft,
  upstreamRef,
} from './case-git';
export {
  defaultCasesRoot,
  defaultWorkspaceRoot,
  expandHome,
  resolveCasesRootForRead,
  resolveRootForRead,
  validateCasesRoot,
  validateWorkspaceRoot,
} from './paths';
export {
  assertCommit,
  checkoutRow,
  collectDiff,
  copyWorkspace,
  ensureCaseCache,
  extractDiffFile,
  initEmptySourceRepository,
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
  prepareEmptyRowWorkspace,
  prepareRowWorkspace,
  rowAgentHomeDir,
  rowAttachmentDir,
  rowAttachmentsDir,
  rowAttemptsFile,
  rowDir,
  rowEventsFile,
  rowJudgeEventsFile,
  rowJudgeHomeDir,
  rowJudgeMessagesFile,
  rowMessagesFile,
  rowWorkspaceDir,
  runDir,
  runSnapshotFile,
} from './workspace';
// 人工消息附件的落盘原语（id 形状闸门、文件名净化、重名排序、原子写、清点）：
// 机制进 core，上限与拒绝文案在 api 层（它才知道「这一次上传算第几个」）
export {
  assertInjectMessageId,
  listAttachmentFileNames,
  sanitizeAttachmentName,
  writeAttachmentFile,
  type WrittenAttachment,
} from './attachment-store';
// 候选产物（`RESULT.*`）的扫盘与读取：识别口径全部来自 contracts 的白名单，
// 本模块只管「工作区根第一层、普通文件、两道门、两个上限」
export {
  readWorkspaceArtifact,
  scanWorkspaceArtifacts,
  type WorkspaceArtifactEntry,
} from './artifact-store';
export { appendEvent, maxEventSeq, readEvents, readEventsAfter, resetEvents, type PendingAgentEvent } from './event-log';
// MCP stdio 探活原语：机制进 core（与 git-exec.ts 同一类「非智能体子进程原语」），
// 策略（失败分档与文案）在 api/src/mcp.ts。⚠️ 探活不是跑智能体，不受 agentProvider.run 唯一入口约束。
export {
  McpStdioProbeError,
  probeMcpStdio,
  type McpStdioProbeErrorKind,
  type McpStdioProbeInput,
  type McpStdioProbeOutcome,
} from './mcp-probe';
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
