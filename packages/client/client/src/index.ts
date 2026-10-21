/** client 公共出口：数据获取 hooks 与 HTTP 原语。类型全部来自 contracts。 */
export { delJson, getJson, postForm, postJson, putJson } from './http';
export { useSettings } from './settings';
// 技能清单 / 目录树 / 单个文件原文：清单 key 恒定（刷新 = 重新扫盘），树与文件的 key 带名字
// （未选中时不发请求），文件的 key 还带技能内路径
export { SKILLS_KEY, skillFileKey, skillTreeKey, useSkillFile, useSkills, useSkillTree } from './skills';
// MCP 探活：无缓存的一次性 POST，候选级 loading 与结果留在展示层
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
  useImportProviderModels,
  usePreviewProviderModels,
  useProviderModels,
  useProviders,
  useUpdateProvider,
} from './providers';
export {
  AGENT_OPTIONS_KEY,
  RUNS_KEY,
  runKey,
  runArtifactsUrl,
  runCandidateMessagesStreamUrl,
  runCandidateUrl,
  useAbortCandidate,
  useAbortRun,
  useCreateRun,
  useDeleteRun,
  useCandidateArtifactFile,
  useCandidateDiffFile,
  useCandidateDiffIndex,
  useCandidateLog,
  useRun,
  useRunArtifacts,
  useRunModelOptions,
  useRuns,
  useRescoreCandidate,
  useRetryCandidate,
  useStartRun,
  useUpdateRun,
  type AgentModelOption,
  type AgentOptionGroup,
} from './runs';
export { useCandidateStream } from './candidate-stream';
export {
  FOLLOW_UP_AVAILABILITY_URL,
  FOLLOW_UP_URL,
  followUpAvailabilityUrl,
  postFollowUp,
  useFollowUpAvailability,
  useFollowUpCandidate,
  type UseFollowUpAvailabilityInput,
  type UseFollowUpAvailabilityResult,
} from './follow-up';
/** 评分那条事件流（评审者自己的流水）：与候选级流分开的读数与续订（口径见该文件头） */
export { useCandidateJudgeEvents, type UseCandidateJudgeEventsInput, type UseCandidateJudgeEventsResult } from './judge-events';
export {
  foldCandidateRecords,
  mergeCandidateRecords,
  parseCandidateRecordFrame,
  useCandidateMessages,
  type CandidateMessagesPayload,
  type UseCandidateMessagesResult,
} from './candidate-messages';
export { useRunLiveMetrics, type CandidateLiveMetrics } from './candidate-live';
/**
 * 活动行的**实时打字内容**：折 AgentMessage 的内容流（整轮共享的聚合流上的一条 sink），
 * 与 `useRunLiveMetrics` 折事件流是同一层的两条路——活动行把两者叠起来用。
 * `activityOfFrame` 是「这一帧算不算活动内容」的判据（信封的解析与坏帧丢弃在 `sse-keyed-hub` 那一层）。
 */
export {
  EMPTY_ACTIVITY,
  activityOfFrame,
  activityOfMessage,
  useRunActivity,
  type ActivityCandidateInput,
  type CandidateActivity,
} from './run-activity';
/**
 * 环境信息的拼装。**纯函数**，与 `buildCandidateFacts` / `buildAgentLogModel` 同一条边界：
 * 页面只做拼装，判定与文案都在数据层定死（页面没有测试面）。
 */
export { ENV_GROUP_ORDER, buildAgentEnvironment, envItem, type BuildEnvironmentInput } from './build-environment';
/**
 * 应答面：待答队列（订阅 + 应答动作）与它的推进规则。
 * 队列规则是**纯函数**（先来后到 / 收到确认才出队 / 关掉不算答 / 焦点之外**暂缓**），
 * 宿主只做拼装——与上一条同一条边界：判定留在数据层，页面没有测试面。
 */
export {
  ASK_USER_ANSWERS_URL,
  ASK_USER_URL,
  postAskUserAnswers,
  useAskUserQueue,
  type UseAskUserQueueInput,
  type UseAskUserQueueResult,
} from './ask-user';
export {
  EMPTY_ASK_USER_QUEUE,
  answerableAskUser,
  applyAskUserSnapshot,
  confirmAskUserAnswered,
  currentAskUser,
  dismissAskUser,
  reopenAskUser,
  type AskUserQueueState,
} from './ask-user-queue';
/**
 * run 焦点：此刻用户在看着哪一轮。**模块级单例**（不依赖 React 的 `setFocusedRun`），
 * `/runs` 页在右栏选中某一轮时写它、离开时复位，全局提问浮层订阅式读它——
 * 「切走的 run 的未答提问」因此可以**暂缓**（不弹、不取消、仍在挂起表计时）。
 */
export { setFocusedRun, useFocusedRun } from './run-focus';
/**
 * 人工消息面（人往运行中的智能体送话）：一候选的队列快照 + 信号流 + 四个写动作。
 * 与应答面同一条切法——通道与动作在数据层（有测试面），判定与文案在 `@aieval/ui`。
 */
export {
  INJECT_MESSAGES_ATTACHMENTS_URL,
  INJECT_MESSAGES_PROMOTE_URL,
  INJECT_MESSAGES_RETRACT_URL,
  INJECT_MESSAGES_URL,
  injectMessagesUrl,
  postInjectAttachment,
  postInjectMessage,
  postInjectMessagePromote,
  postInjectMessageRetract,
  useInjectMessages,
  type UseInjectMessagesInput,
  type UseInjectMessagesResult,
} from './inject-messages';
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
  AskUserAnswer,
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
  CandidateEvent,
  CandidateNode,
  SessionNode,
  TaskPanel,
  ToolItem,
  TruncationState,
} from '@aieval/ui';