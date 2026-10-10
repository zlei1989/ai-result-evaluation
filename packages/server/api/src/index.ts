/** api 公共出口：业务服务层，框架层只从这里 import。 */
export { getSettings, updateSettings } from './settings';
export {
  addProviderModel,
  createProvider,
  deleteProvider,
  fetchProviderModels,
  listAllModelOptions,
  listProviders,
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

// 评测域（p5）：创建 / 列表 / 详情 / 启动 / 终止 / 候选池投影。
// 候选池与 `usage` / `cancelMidTurn` 同源（agents 注册表元数据），故一次取全（§11 R11/R12）。
// `rescoreRow`（Task 7）：行级重新评分，web-next 的 rescore 路由从 api 包根取它。
// `retryRow`（2026-09-27）：行级重试执行（连候选 agent 一起重跑），web-next 的 retry 路由从 api 包根取它。
// `updateRun` / `deleteRun`（2026-09-28）：整轮的编辑与删除，web-next 的 PUT / DELETE 路由从 api 包根取它们。
export {
  abortRow,
  abortRun,
  createRun,
  deleteRun,
  getRunView,
  listAgentModelOptions,
  listModelOptions,
  listRunsView,
  rescoreRow,
  retryRow,
  startRun,
  updateRun,
  type AgentModelOption,
  type AgentOptionGroup,
} from './runs';
export {
  assertRowExists,
  getRowDiffFile,
  getRowDiffIndex,
  getRowJudgeLog,
  getRowJudgeRecords,
  getRowLog,
  getRowRecords,
  resetRowDiffCache,
} from './run-artifacts';
// 两条事件流：行级（候选 + 编排层留痕）与评分（`judge-events.jsonl`，2026-10-10 起分开）
export { streamJudgeEvents, streamRowEvents } from './run-stream';
// 消息流（spec v3 §2）：内容级通道，与上面的事件流并行——两条流的去重键与生命周期都不同。
// 记录流同样有两条：候选（`messages.jsonl`）与评分（`judge-messages.jsonl`）
export { streamJudgeRecords, streamRowRecords, type RecordStreamOptions } from './messages-stream';
// run 级信号流：跨轮次的状态翻转通道（快照变了 ⇒ 客户端重读 REST），与三条行级流并行
export { streamRunSignals } from './run-events';
