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
// 有**两条**：行级（候选 + 编排层留痕）与评分（评审者自己的流水，`judge-events.jsonl`）。
// 另有 **run 级**的一套（一轮下所有行的同一条流）：聚合流按它一次订阅整轮，
// listener 因此多一个 `rowId` 实参——它只有这一条流，得自己把帧归到行上
export {
  publishJudgeEvent,
  publishRowEvent,
  subscribeJudgeEvents,
  subscribeRowEvents,
  subscribeRunEvents,
  subscribeRunJudgeEvents,
} from './events';

// run 级信号总线：`saveRun` 落盘后的「快照变了」提示。`subscribeRunChanges` 出口给 api 层的
// SSE 端点（/api/runs/events）用；`publishRunChanged` 刻意不出口——唯一发射点在 `saveRun` 体内，
// 包外没有第二个合法发射方（出口它会诱人在编排层「顺手补一条」，那正是发射点分裂的开端）
export { subscribeRunChanges } from './run-signals';

// 挂起表：待答提问在进程内的唯一真相源（写侧 `resolveAskUser` 是应答面唯一写入口）。
// 读侧三件（`listPendingAskUser` / `subscribeAskUserChanges` / `resolveAskUser`）出口给 api 的三个端点；
// `registerAskUser` 出口给编排层登记提问（05 号那一格接线）；`publishAskUserChanged` 刻意不出口——
// 发射点全在表内部（登记 / 答复 / 取消），出口它会诱人在编排层「顺手补一条」，那正是发射点分裂的开端
export {
  listPendingAskUser,
  registerAskUser,
  resetAskUserForTesting,
  resolveAskUser,
  subscribeAskUserChanges,
  type AskUserSettled,
  type AskUserStage,
  type PendingAskHandle,
  type PendingAskUserEntry,
  type PendingAskUserRequest,
  type RegisterAskUserInput,
} from './ask-user';

// 人工消息面（/api/inject-messages 的三条端点 + 撤回）：快照、信号订阅、登记、改期、撤回。
// 表与端口的实现都在本包（端口由编排层实现、在闭包里捕获行身份），api 层只认这几个名字——
// 与挂起表那一组同一形状。`createInjectionPort` / `waitForInjectQueue` 刻意不出口：
// 它们只由本包编排层调用（端口要找到「哪一行」的状态，包外没有第二个合法造法）。
export {
  listInjectMessages,
  promoteInjectMessage,
  registerInjectMessage,
  resetInjectQueueForTesting,
  retractInjectMessage,
  subscribeInjectChanges,
  type InjectAttachment,
  type InjectQueueEntry,
  type InjectRetractResult,
} from './inject-port';

// 记录总线：消息与子任务行共用 `messages.jsonl`，落盘 + 进程内扇出。
// `publishRowRecord` 与两个窄包装都出口：api 层的回放路由要读文件，而想按类型分流的订阅方
// 需要拿到整个 `RowRecord`；`publishRow*` 是编排层用的写入口（跨包只需要读侧，但出口面成对更好用）。
// 评分有**自己的一条**（`judge-messages.jsonl`）：写侧只有编排层用，读侧给 api 的评分路由。
// 与事件总线同形：行级一套 + **run 级**一套（聚合流按 run 级一次订阅整轮的两条 channel）
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
  subscribeRunJudgeRecords,
  subscribeRunRecords,
} from './row-messages';

// 评分器：解析（纯函数）与一次评分调用
export { judgeRow, parseJudgeResponse, type JudgeInput } from './judge';

// 编排：轮级状态机与重启恢复。
// `runRow` 刻意不在这里导出：它是本包测试与状态机内部用的行级入口，不属于跨包契约。
// `followUpRow` 出口：api 层的追问入口要跨包调它（与 `retryRow` / `rescoreRow` 同一形状——
// 同步返回「已经在准备中」的快照，拒绝时抛带中文原因的 CONFLICT）。
// `followUpAvailability` 是它的**读侧**（界面入口要靠它决定按钮的禁用与 Tooltip 文案）：
// 两处共用契约里的同一份判据，出口自然成对。
export {
  abortRow,
  abortRun,
  assertRunMutable,
  deleteRun,
  drainRunningTasks,
  checkpointRow,
  followUpAvailability,
  followUpRow,
  recoverInterruptedRuns,
  rescoreRow,
  retryRow,
  startRun,
  type CheckpointInput,
  type FollowUpInput,
} from './orchestrator';
