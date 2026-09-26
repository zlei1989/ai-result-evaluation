/** client 公共出口：数据获取 hooks 与 HTTP 原语。类型全部来自 contracts。 */
export { delJson, getJson, postJson, putJson } from './http';
export { useSettings } from './settings';
export {
  COMMITS_KEY,
  matchesCommitsKey,
  useCases,
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
  useRunLiveMetrics,
  type RowLiveMetrics,
} from './row-live';
