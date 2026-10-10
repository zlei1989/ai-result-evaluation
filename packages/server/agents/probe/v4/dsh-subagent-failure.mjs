/**
 * **最后一个 dsh 空白**：
 * 子任务**失败（非取消）**路径的 `subagent.finished` 形态。
 *
 * 已闭合的两格（2026-09-30）：成功 = `status:"ok"` + `stopReason:"completed"`；
 * 取消 = `status:"error"` + `stopReason:"aborted"`。**失败**（非取消）从未覆盖。
 *
 * 类型面（本轮新查，`@deepseek-ai/dsh-subagent` 的 typert 声明逐字）：
 * ```
 * export interface SubagentStopReasonMap {
 *   completed: 'completed'; aborted: 'aborted'; error: 'error';
 *   'max-tokens': 'max-tokens'; refusal: 'refusal';
 * }
 * ```
 * ⇒ 非取消的失败候选是 `error` / `max-tokens` / `refusal`。本脚本挑**可以确定性制造**的那个：
 * 把本次运行的路由 `maxTokens` 压到 400，让子智能体的「最后一条普通 turn」撞上输出上限
 * ⇒ 期望 `stopReason: 'max-tokens'`（也可能落成 `error`）。
 *
 * 顺带抓 `subagent/descriptor`（「只见到事件名，未解析」的那一格）与 `subagent/catalog`。
 *
 * 用法：node probe/v4/dsh-subagent-failure.mjs
 */
import { note, writeDump } from './lib/env.mjs';
import { runDshTurn } from './lib/dsh-harness.mjs';

/** 顶层通知（`subagent.*` 不在 `params.event` 下）。 */
function subagentLoads(notifications) {
  return notifications
    .filter((one) => typeof one?.method === 'string' && one.method.startsWith('subagent'))
    .map((one) => ({ method: one.method, params: one.params }));
}

/** 会话事件里的 subagent 家族（`subagent/catalog` / `subagent/descriptor` 等）。 */
function subagentEvents(notifications) {
  return notifications
    .filter((one) => typeof one?.params?.event?.type === 'string' && one.params.event.type.startsWith('subagent'))
    .map((one) => ({ type: one.params.event.type, data: one.params.event.data }));
}

const PROMPT = [
  '严格按顺序执行，不要跳过：',
  '1. 调用 subagent 工具**一次**（前台运行，不要 run_in_background）：',
  '   description = "Long essay"',
  '   prompt = "写一篇 3000 字的中文长文，主题是海洋。必须连续输出完整正文，不要提前结束，不要问我问题。"',
  '2. 拿到子智能体的返回后，只回复一个词：done',
].join('\n');

const run = await runDshTurn({
  label: 'subagent-failure',
  protocolType: 'openai',
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-chat',
  prompt: PROMPT,
  // 关键：把上限压低，让子智能体的 turn 撞上输出上限 ⇒ 非取消的失败收场
  maxTokens: 400,
  timeoutMs: 420_000,
  settleMs: 10_000,
});

const loads = subagentLoads(run.notifications);
const events = subagentEvents(run.notifications);
note('子任务顶层通知：');
for (const one of loads) note('  ·', one.method, JSON.stringify(one.params).slice(0, 700));
note('子任务会话事件：');
for (const one of events) note('  ·', one.type, JSON.stringify(one.data).slice(0, 700));

const finished = loads.filter((one) => one.method === 'subagent.finished');
const verdict = finished.length === 0
  ? '本轮没有收到 subagent.finished（子任务没跑起来或没收场）——本项仍未闭合'
  : `收到 ${finished.length} 条 subagent.finished：status=${JSON.stringify(finished.map((one) => one.params?.status))}，stopReason=${JSON.stringify(finished.map((one) => one.params?.stopReason))}`;
note('判定：', verdict);

const file = writeDump('v4/dsh-subagent-failure', {
  at: new Date().toISOString(),
  prompt: PROMPT,
  model: 'deepseek-chat',
  maxTokens: 400,
  runError: run.error,
  finalResponse: run.result?.finalResponse ?? null,
  notificationCount: run.notifications.length,
  distribution: run.summary,
  subagentLoads: loads,
  subagentEvents: events,
  verdict,
  dumpFile: run.dumpFile,
});
note('落盘：', file);
