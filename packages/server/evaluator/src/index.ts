/** evaluator 公共出口：文本 API（p0）、评分路由（p0）、运行快照、事件总线、评分器、编排。 */
export { callTextApi, type TextRoute } from './text-api';
// 评分路由（p0）与「谁驱动这一分」（Task 3）。`requireJudgeAgent` 必须在这里出口：它是本任务新增的
// 名字里**唯一**有跨包消费者的一个——api 层在创建评测时要提前拦配置问题，而包 exports 只映射 `.`，
// 深路径 import 拿不到（`index.test.ts` 按**完整集合**守卫本文件的出口面）。
// 其余新名字（`judgeRowByAgent` / `JudgeAgentError` / `AgentJudgeInput` / `finalizeScore`）刻意不出口：
// 消费者都在本包内、走相对 import，多出口一个就多一份永久摩擦（每次加出口都要显式改那条守卫）。
export { requireJudgeAgent, resolveJudgeRoute } from './judge-route';

// 运行快照：一轮评测的可展示状态都在这里（Task 1）
export { getRun, listRuns, listRunsForCase, saveRun } from './run-store';

// 事件总线：落盘 + 进程内扇出（Task 2）。`PendingRowEvent` 不导出：只有本包的编排层在发事件
export { publishRowEvent, subscribeRowEvents } from './events';

// 记录总线（spec v3 §2）：消息与子任务行共用 `messages.jsonl`，落盘 + 进程内扇出。
// `publishRowRecord` 与两个窄包装都出口：api 层的回放路由要读文件，而想按类型分流的订阅方
// 需要拿到整个 `RowRecord`；`publishRow*` 是编排层用的写入口（跨包只需要读侧，但出口面成对更好用）
export {
  publishRowMessage,
  publishRowRecord,
  publishSubagentRecord,
  subscribeRowRecords,
} from './row-messages';

// 评分器：解析（纯函数）与一次评分调用（Task 3 / Task 4）
export { judgeRow, parseJudgeResponse, type JudgeInput } from './judge';

// 编排：轮级状态机与重启恢复（Task 5 / Task 6 / Task 7）。
// `runRow` 刻意不在这里导出：它是本包测试与状态机内部用的行级入口，不属于跨包契约
export {
  abortRow,
  abortRun,
  assertRunMutable,
  deleteRun,
  drainRunningTasks,
  recoverInterruptedRuns,
  rescoreRow,
  retryRow,
  startRun,
} from './orchestrator';
