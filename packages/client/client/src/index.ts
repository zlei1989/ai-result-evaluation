/** client 公共出口：数据获取 hooks 与 HTTP 原语。类型全部来自 contracts。 */
export { delJson, getJson, postJson, putJson } from './http';
export { useSettings } from './settings';
// MCP 探活：无缓存的一次性 POST，行级 loading 与结果留在展示层
export { MCP_TEST_URL, probeMcpServer } from './mcp';
export {
  COMMITS_KEY,
  matchesCommitsKey,
  useCases,
  useCaseSyncAction,
  useCaseSyncStatus,
  useCommitCandidates,
  useCreateCase,
  useDeleteCase,
  useGenerateRubric,
  useTestCase,
  useUpdateCase,
  useValidateRepo,
} from './cases';
export {
  useCreateProvider,
  useDeleteProvider,
  useFetchProviderModels,
  useProviderModels,
  useProviders,
  useUpdateProvider,
} from './providers';
export {
  AGENT_OPTIONS_KEY,
  RUNS_KEY,
  runKey,
  runRowMessagesStreamUrl,
  runRowUrl,
  useAbortRow,
  useAbortRun,
  useCreateRun,
  useDeleteRun,
  useRowDiffFile,
  useRowDiffIndex,
  useRowLog,
  useRun,
  useRunModelOptions,
  useRuns,
  useRescoreRow,
  useRetryRow,
  useStartRun,
  useUpdateRun,
  type AgentModelOption,
  type AgentOptionGroup,
} from './runs';
export { useRowStream } from './row-stream';
export {
  foldRowRecords,
  mergeRowRecords,
  parseRowRecordFrame,
  useRowMessages,
  type RowMessagesPayload,
  type UseRowMessagesResult,
} from './row-messages';
export { useRunLiveMetrics, type RowLiveMetrics } from './row-live';
/**
 * 活动行的**实时打字内容**：折 AgentMessage 的内容流，
 * 与 `useRunLiveMetrics` 折事件流是同一层的两条路——活动行把两者叠起来用。
 */
export {
  EMPTY_ACTIVITY,
  activityOfMessage,
  parseActivityFrame,
  useRunActivity,
  type ActivityRowInput,
  type RowActivity,
} from './run-activity';
/**
 * 环境信息的拼装。**纯函数**，与 `buildRowFacts` / `buildAgentLogModel` 同一条边界：
 * 页面只做拼装，判定与文案都在数据层定死（页面没有测试面）。
 */
export { ENV_GROUP_ORDER, buildAgentEnvironment, envItem, type BuildEnvironmentInput } from './build-environment';
/**
 * **界面模型的类型转发**。
 *
 * 定义只有一处：`@aieval/ui` 的 `src/composite/agent-log/types.ts`（那些名字是**界面词汇**——
 * 色档、折叠键、渲染块、文案表——放不进服务端的 `@aieval/contracts`）。
 * 这里 `export type … from` 的唯一目的是**消费方的 import 路径**：页面与测试都已经依赖
 * `@aieval/client`，不必再为几个类型多记一条 `@aieval/ui` 的路径；而 `AGENTS.md` 的依赖表里
 * 也没有 `client → ui` 那条边。
 *
 * **它不是第二份真值、也不产生新的依赖边**：`export type` 在编译期被 `verbatimModuleSyntax`
 * 整体抹掉，运行时的 `@aieval/client` 与 `@aieval/ui` 之间没有任何 import。
 */
export type {
  AgentEnvironment,
  AgentLogDiagnostics,
  AgentLogFacts,
  AgentLogFactsInput,
  AgentLogModel,
  AgentLogSource,
  AgentRunStatus,
  AskUserInteraction,
  AskUserPending,
  AskUserSettled,
  CapabilityDecl,
  DomainFact,
  DomainFactSegment,
  Loadable,
  LogNode,
  LogNodeStatus,
  LogTurn,
  MessageCapabilityMap,
  RenderBlock,
  RowEvent,
  RowNode,
  SessionNode,
  TaskPanel,
  ToolItem,
  TruncationState,
} from '@aieval/ui';