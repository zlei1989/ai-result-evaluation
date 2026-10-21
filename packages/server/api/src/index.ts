/** api 公共出口：业务服务层，框架层只从这里 import。 */
export { getSettings, updateSettings } from './settings';
// 技能清单：扫盘（core）+ 合并停用名单（缺省 = 开启），每条恒给 disabled 布尔
export { listSkills } from './skills';
// MCP 探活（「测试连接」）：策略层（http 三步 + 一次只读调用、失败分档、串行），
// 机制在 core/src/mcp-probe.ts。⚠️ 探活不是跑智能体，不走 agentProvider.run。
export { probeMcpServer } from './mcp';
export {
  addProviderModel,
  createProvider,
  deleteProvider,
  importProviderModels,
  listAllModelOptions,
  listProviders,
  previewProviderModels,
  removeProviderModel,
  setProviderModelContext,
  updateProvider,
} from './providers';
export {
  createCase,
  deleteCase,
  getCase,
  listCases,
  listCommitCandidates,
  updateCase,
  validateRepo,
} from './cases';
// 用例同步（2026-10）：后台把用例文件逐文件提交并推到远端，冲突由智能体裁定。
// `enqueueCaseSync` 由 `cases.ts` 的写路径调用（不 await），另两个从 web-next 的状态/动作路由取。
export { enqueueCaseSync, getCaseSyncStatus, resetCaseSyncForTesting, runCaseSync } from './case-sync';
export { generateRubric, resolveJudgeRoute, type GenerateRubricResult } from './judge';
// 重启恢复的调用点在 web-next 的启动钩子里，而依赖方向表里 web-next 只到 api / core / ui / client / contracts
// （AGENTS.md），evaluator 不在其中，也没出现在 apps/web-next/package.json 的依赖里——pnpm 的严格
// node_modules 下直连会解析失败。api → evaluator 是允许的方向，故在这里转出一次。
export { recoverInterruptedRuns } from '@aieval/evaluator';
// 宿主停机回收：web-next 的启动钩子在 SIGTERM / SIGINT 上要释放本进程在册的在途会话
// （厂商 SDK 代 spawn 的工具子进程是 detach 的，宿主一死就成孤儿）。理由与上一行同源——
// web-next 只到 api，agents 不在它的依赖里 ⇒ 在这里转出一次。
export { disposeLiveSessions } from '@aieval/agents';

// 评测域：创建 / 列表 / 详情 / 启动 / 终止 / 候选池投影。
// 候选池与 `usage` / `cancelMidTurn` 同源（agents 注册表元数据），故一次取全。
// `rescoreCandidate`：候选级重新评分，web-next 的 rescore 路由从 api 包根取它。
// `retryCandidate`：候选级重试执行（连候选 agent 一起重跑），web-next 的 retry 路由从 api 包根取它。
// `updateRun` / `deleteRun`：整轮的编辑与删除，web-next 的 PUT / DELETE 路由从 api 包根取它们。
export {
  abortCandidate,
  abortRun,
  createRun,
  deleteRun,
  getRunView,
  listAgentModelOptions,
  listModelOptions,
  listRunsView,
  rescoreCandidate,
  retryCandidate,
  startRun,
  updateRun,
  type AgentModelOption,
  type AgentOptionGroup,
} from './runs';
// 人工追问（第二期）：对已经跑过的候选接着同一段上下文再跑一段。
// 存在性检查与请求上限在本层，可用性判据与拒绝原因在 evaluator（界面按 409 的中文原因给 Tooltip）。
export { followUpCandidate, getFollowUpAvailability, type FollowUpRequest } from './follow-up';
export {
  assertCandidateExists,
  getCandidateArtifactFile,
  getCandidateDiffFile,
  getCandidateDiffIndex,
  getCandidateJudgeLog,
  getCandidateJudgeRecords,
  getCandidateLog,
  getCandidateRecords,
  getCandidateWorkspaceImage,
  getRunArtifactIndex,
  resetCandidateDiffCache,
} from './run-artifacts';
// 两条事件流：候选级（候选 + 编排层留痕）与评分（`judge-events.jsonl`，与候选级分开）
export { streamJudgeEvents, streamCandidateEvents } from './run-stream';
// 聚合流：一轮下所有候选的实时数据收进**一条**连接（逐行游标 `?after=w-1:12,w-2:5`：
// 候选事件按各自 seq 续订、两 channel 的消息恒为实时增量）。旧的候选级流仍在服役，两者并存
export { streamRunAggregate, type CandidateCursors } from './run-aggregate-stream';
// 消息流：内容级通道，与上面的事件流并行——两条流的去重键与生命周期都不同。
// 记录流同样有两条：候选（`messages.jsonl`）与评分（`judge-messages.jsonl`）
export { streamJudgeRecords, streamCandidateRecords, type RecordStreamOptions } from './messages-stream';
// 抽屉流：单个候选单 channel 的**完整流水**（该族事件按 seq 续订 + 该族消息全量回放），
// 两个抽屉各开自己 channel 的那一条。上面四条候选级流本票仍在服役，收缩归后续
export { streamDrawer } from './drawer-stream';
// 全局流：三条全局总线（run 信号 / 待答挂起表 / 人工消息队列）收进**一条**页面级长连接，
// 帧是信封里的那三种信号（无载荷、无 id、不因终态关流）。下面两条单信号流仍在服役，收缩归后续
export { streamGlobalSignals } from './run-events';
// 应答面：待答提问的快照读侧与唯一写入口（三个端点见 web-next 的 /api/ask-user/*）
export { answerAskUser, getPendingAskUser } from './ask-user';
// 待答清单的单信号流：只推「变了，重读」（无序号、不可续订、不因终态关流）。
// 客户端已改从全局流收这一族信号，这条端点本身没有消费方了，收缩归后续
export { streamAskUserChanges } from './ask-user-stream';
// 人工消息面（五个端点见 web-next 的 /api/inject-messages/*）：快照、发送、改期、撤回、附件落盘。
// 真相源是 evaluator 的队列表，本层只做「校验行存在 + 折成 HTTP 结局 + 附件落盘」。
export {
  assertUploadContentLength,
  getInjectMessages,
  promoteInjectMessage,
  retractHttpResult,
  retractInjectMessage,
  saveInjectAttachment,
  sendInjectMessage,
  type SaveInjectAttachmentInput,
} from './inject-messages';
// 人工消息队列的单信号流：与待答清单那条同形（只推「变了，重读」，客户端已改从全局流收）
export { streamInjectMessages } from './inject-messages-stream';
