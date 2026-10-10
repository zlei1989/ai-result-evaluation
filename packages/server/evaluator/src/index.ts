/** evaluator 公共出口：文本 API、评分路由、运行快照、事件总线、评分器、编排。 */
export { callTextApi, type TextRoute } from './text-api';
// 评分路由与「谁驱动这一分」。`requireJudgeAgent` 必须在这里出口：它是
// 名字里**唯一**有跨包消费者的一个——api 层在创建评测时要提前拦配置问题，而包 exports 只映射 `.`，
// 深路径 import 拿不到（`index.test.ts` 按**完整集合**守卫本文件的出口面）。
// 其余新名字（`judgeRowByAgent` / `JudgeAgentError` / `AgentJudgeInput` / `finalizeScore`）刻意不出口：
// 消费者都在本包内、走相对 import，多出口一个就多一份永久摩擦（每次加出口都要显式改那条守卫）。
// 档位那两个**必须出口**：`resolveJudgeEffort` 是唯一读点，而 api 层的生成 / 识别要跨包调它，
// 并当场用 `requireJudgeEffort` 校验（两道一起给，调用方不必自己拼第二份判据）。
export { requireJudgeAgent, requireJudgeEffort, resolveJudgeEffort, resolveJudgeRoute } from './judge-route';

// 运行快照：一轮评测的可展示状态都在这里
export { getRun, listRuns, listRunsForCase, saveRun } from './run-store';

// 事件总线：落盘 + 进程内扇出。`PendingRowEvent` 不导出：只有本包的编排层在发事件。
// 有**两条**：行级（候选 + 编排层留痕）与评分（评审者自己的流水，`judge-events.jsonl`）
export { publishJudgeEvent, publishRowEvent, subscribeJudgeEvents, subscribeRowEvents } from './events';

// run 级信号总线：`saveRun` 落盘后的「快照变了」提示。`subscribeRunChanges` 出口给 api 层的
// SSE 端点（/api/runs/events）用；`publishRunChanged` 刻意不出口——唯一发射点在 `saveRun` 体内，
// 包外没有第二个合法发射方（出口它会诱人在编排层「顺手补一条」，那正是发射点分裂的开端）
export { subscribeRunChanges } from './run-signals';

// 记录总线：消息与子任务行共用 `messages.jsonl`，落盘 + 进程内扇出。
// `publishRowRecord` 与两个窄包装都出口：api 层的回放路由要读文件，而想按类型分流的订阅方
// 需要拿到整个 `RowRecord`；`publishRow*` 是编排层用的写入口（跨包只需要读侧，但出口面成对更好用）。
// 评分有**自己的一条**（`judge-messages.jsonl`）：写侧只有编排层用，读侧给 api 的评分路由
export {
  broadcastJudgeMessage,
  broadcastRowMessage,
  publishJudgeMessage,
  publishJudgeRecord,
  publishJudgeSubagentRecord,
  publishRowMessage,
  publishRowRecord,
  publishSubagentRecord,
  subscribeJudgeRecords,
  subscribeRowRecords,
} from './row-messages';

// 评分器：解析（纯函数）与一次评分调用
export { judgeRow, parseJudgeResponse, type JudgeInput } from './judge';

// 编排：轮级状态机与重启恢复。
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
