/**
 * 日志抽屉该渲染什么：把「读失败 / 实时通道故障 / 读取中 / 有日志」收成一个纯函数（页面只做拼装）。
 *
 * 为什么必须抽出来并有守卫：`LogView` 的 props 被契约 §8 钉死为 `{events, connected, onDownload}`，
 * **没有 error 位**，所以「读不出来」与「实时通道断了」这两件事只能在页面层表达；而它在 `events`
 * 为空时给的空态是「还没有日志 · 这一行还没开始执行」——与故障同时出现时，使用者会把一个
 * **真实的故障**（api 折出来的中文原因带文件路径 / SSE 连接中断）读成「还没开始跑」，
 * 于是去等一个永远不会开始的执行。这是「坏比缺更糟」的典型形状：少一句日志只是缺，
 * 说错一句则是把人引到错误的方向。
 * 页面本身没有测试面（`apps/web-next` 不能写 `.tsx` 测试），故判定与文案都在这里定死。
 *
 * 四条判定口径：
 *   1. **有错且一条事件都没有** → `failed`：整段替换抽屉内容，**不渲染 LogView**（否则它的空态会误导）。
 *      两种错都走这里：`logError` 是**读文件失败**（带 `events.jsonl` 路径），`streamError` 是
 *      **实时通道不可用**（连接中断 / 环境不支持 EventSource / 坏帧）——后者过去被页面直接丢掉，
 *      于是断流只表现为「还没有日志 + 未连接」，没有原因（计划 Review Focus 5 要求的正是「如实
 *      反映未连接**并给出原因**」）；
 *   2. **有错但手上有事件** → 照旧渲染 LogView（数据是真的），另给一条非破坏性提示
 *      —— 与用例页 `resolveCasePanel` 的 `stale` 同一口径：只要还有真数据就别把它藏起来。
 *      两种提示分开表达：`liveError` 是实时通道（不是「读取失败」），`warning` 是读文件失败；
 *   3. **没数据也没错** → `loading` 只表示「第一次拉取还在路上」，一旦拿到 `[]` 就不是加载中，
 *      该由 LogView 说「还没有日志」（那是真的没开始跑，两者必须能分开）；
 *   4. `streamError` 里 `undefined` 与 `null` 等价（`useRowStream().error` 的初值是 `null`）。
 */
import type { AgentEvent } from '@aieval/contracts';
import { describeError } from './runs-view';

export type LogDrawerState =
  /** 首次拉取中（还没有任何事件、也还没有错误） */
  | { kind: 'loading' }
  /** 有故障且手上没有事件：抽屉整段显示这句原因，**不渲染 LogView 的空态** */
  | { kind: 'failed'; message: string }
  /** 有事件可渲染（`events` 为空时由 LogView 给「还没有日志」空态）；两个提示位见文件头口径 2 */
  | { kind: 'log'; events: AgentEvent[]; liveError?: string; warning?: string };

export interface LogDrawerInput {
  /** 已交付的事件（页面传的是 `useRowStream().events`：`/log` 首帧 + SSE 增量、已按 seq 去重） */
  events: AgentEvent[];
  /** `useRowLog().error`：ServiceError 时 message 就是 api 的中文原因（**带 events.jsonl 路径**） */
  logError: unknown;
  /** `useRowStream().error`：实时通道的原因（断线会自动重连 / 环境不支持 / 坏帧） */
  streamError?: unknown;
  /** `useRowLog().isLoading` */
  isLoading: boolean;
}

/**
 * 实时通道的故障原因：`useRowStream` 的三个 `setError` 都塞的是**普通 `Error`**
 * （`实时日志连接中断：…` / `当前环境不支持 EventSource：…` / `收到无法解析的事件帧，已跳过`），
 * 而通用的 `describeError` 只透 `ServiceError` 的 message、其余一律折成「操作失败，请稍后重试」
 * ——直接把 `Error` 喂给它等于把**唯一的原因**丢掉（那正是 M2 的另一半）。
 * 所以这里按 `Error.message` 取原文，非 `Error` 才退回通用兜底。
 */
function reasonText(error: unknown): string {
  return error instanceof Error ? error.message : describeError(error);
}

/** 两种故障的措辞必须分开：`streamError` 说的是实时通道，不是「读取失败」（那是文件读不出来） */
function streamFailureMessage(error: unknown): string {
  return `实时通道不可用：${reasonText(error)}。仅显示已落盘的日志，实时追加暂时不可用`;
}

function streamWarningMessage(error: unknown): string {
  return `实时通道已断：${reasonText(error)}。已收到的日志不受影响`;
}

export function resolveLogDrawer(input: LogDrawerInput): LogDrawerState {
  const { events, logError, streamError, isLoading } = input;

  if (logError != null) {
    const message = describeError(logError);
    // 手上一条事件都没有：整段替换。**不要**改成「渲染 LogView + 一条 Alert」——
    // LogView 在 events 为空时会同时渲染「还没有日志」空态，那正是本条要防的误读
    if (events.length === 0) return { kind: 'failed', message };
    // 有数据：读失败与实时通道故障**都要说**（少说一条就少一条排障线索）
    return {
      kind: 'log',
      events,
      warning: message,
      ...(streamError == null ? {} : { liveError: streamWarningMessage(streamError) }),
    };
  }

  // 实时通道的故障（C1 的零交付、中间层掐断、坏帧都会走到这里）：没有它，抽屉只会显示
  // 「还没有日志 + 未连接」，使用者看不到任何原因，也分不清「没开始跑」与「连不上」
  if (streamError != null) {
    if (events.length === 0) return { kind: 'failed', message: streamFailureMessage(streamError) };
    return { kind: 'log', events, liveError: streamWarningMessage(streamError) };
  }

  if (isLoading && events.length === 0) return { kind: 'loading' };
  return { kind: 'log', events };
}
