/**
 * pi 子智能体的**转写文件投影**：把派发扩展写的逐 agent JSONL 折成**子任务自己的消息**。
 *
 * ## 为什么需要这一层（本家子任务步骤的唯一通道）
 *
 * `Agent` 子会话在同一个进程里**另起一个 pi 会话**，它的事件**不进父会话的 `session.subscribe`
 * 流**（父会话那条路只看得到派发工具的返回值）。于是界面上那个子任务节点
 * （`build-model.ts` 按 `message.subagentId` 分桶、按 `message.roundTrip` 分轮）**一条轮次都建不出来**，
 * 「子智能体日志不显示」就是这么来的——消息不在产物里，是**根本没采到**。
 *
 * 两条候选通道都**取不到子会话正文**，故不用：
 *   · 扩展事件总线除 `subagents:started / completed / failed` 外只有身份与元数据频道
 *     （`created` / `compacted` / `steered` / `scheduled` / `ready`），没有内容帧；
 *   · `Agent` 工具的 `tool_execution_update` 载荷只有一行 spinner 活动文案
 *     （`N tool uses...` + `spinnerFrame`）——既没有正文，又按帧动画的频率刷，
 *     落进投影会把「原始输出」面板刷成流水。
 *
 * 真正带正文的是**扩展自己写的转写文件**（`@tintinweb/pi-subagents` 的 `output-file.ts`，
 * 默认开）：每个子智能体一份 JSONL，`turn_end` 时 flush ⇒ 运行中就能读到已落的那一段。
 *
 * ## 逐行的形状与「复用而不是另写一个解析器」
 *
 * 每行是 `{isSidechain, agentId, type, message, timestamp, cwd}`：
 *   · `type: 'assistant'` 的 `message` 与父会话 `message_end.message` **同构**
 *     （`content[]` 的 `text` / `thinking` / `toolCall`、`usage`、`stopReason`、`responseId`）
 *     ⇒ 直接交给 `piAssistantMessageDraft`，这一层不重写块解析；
 *   · `type: 'toolResult'` 的 `message` 是 `ToolResultMessage`（`toolCallId` / `toolName` /
 *     `content[]` / `isError` / `durationMs`），与 `tool_execution_end` 只差一层信封
 *     （正文在 `message.content` 而不是 `event.result.content`）⇒ 拼成等价事件后交给
 *     `piToolResultMessageDraft`，正文抽取与块构造同样只有一份实现；
 *   · `type: 'user'` / `'system'` **不投影**：首行是这次派发的任务提示词，它在主会话时间轴里
 *     已经逐字可见（`Agent` 工具调用块的 `input`），再当一条消息只会让子任务节点的首轮
 *     混进一句不是它自己说的话。
 *
 * ## 轮次：**子任务自己数自己的**
 *
 * `roundTrip` 取该子会话自己的模型往返序（每条助手行 +1，工具结果沿用当前号）——
 * 与 claude 的 `roundTripOfSession` 逐字同一条口径（主会话与各子会话各数各的）。
 * 共用一个计数器会让子任务那几十条消息全落在同一个轮次行里（界面按 `message.roundTrip`
 * 给每个会话节点分轮）。
 *
 * ## 三条读取纪律
 *
 *   · **路径自己算，不扫目录**：转写根（`<tmpdir>/pi-subagents-<uid>`）是**全机共享**的，
 *     扫目录找文件会让并发的两行互相认领对方的子任务 ⇒ 路径由**本行的 `cwd` + 本会话的
 *     `sessionId`**（`AgentSession.sessionId`，与扩展取号的那一处同源）+ 子任务身份拼出来；
 *   · **宽容解析**：文件是边跑边追加的，末行可能停在半截 ⇒ 逐行 `JSON.parse`、坏行跳过、
 *     **丢掉没有换行结尾的末行**，一次都不抛（读子任务正文失败不该把一次跑完的运行翻成失败）；
 *   · **有上限**：越界截断并**点名**（悄悄少一半正文与「本来就这些」在界面上长得一样）。
 */
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asRecord, readString } from '../../json';
import type { MessageDraft } from '../../message';
import { piAssistantMessageDraft, piToolResultMessageDraft } from './message';

/** 转写根的前缀（扩展在 `os.tmpdir()` 下按 uid 分目录，见其 `output-file.ts` 的 `sessionTaskDir`） */
const TRANSCRIPT_ROOT_PREFIX = 'pi-subagents-';

/** 子任务身份与会话 id 的合法字符：两者都要拼进路径，故**只收**这一套（挡 `..` 与分隔符） */
const SAFE_PATH_SEGMENT = /^[A-Za-z0-9_-]+$/;

/**
 * 单个子会话最多投影多少行。真机一次派发是几十行（29 行 / 49 KB），
 * 上限只为挡住「异常长的子会话把产物撑爆」，正常路径永远碰不到。
 */
export const PI_SUBAGENT_TRANSCRIPT_MAX_LINES = 5000;

/** 一次转写读取的结果 */
export interface PiSubagentTranscript {
  /** 按到达顺序的子会话消息（读不到任何一条时是空数组，不是 `null`） */
  messages: MessageDraft[];
  /**
   * 需要**点名**的异常（读到了且没截断就是 `null`）：文件读不到、身份不合法、正文被上限截断。
   * 调用方把它落成一条 WARN 事件；它**不影响结论**——子任务正文是补充信息。
   */
  warning: string | null;
}

/**
 * `cwd` → 转写目录名。**逐字照抄**扩展的 `encodeCwd`（`output-file.ts`）：
 * 两种分隔符都换 `-`、去掉 Windows 盘符前缀、去掉开头的 `-`（POSIX 根与 UNC）。
 * 抄的是**它定下的目录布局**，不是它的实现——改了这里就等于改路径，两边必须同改。
 */
function encodeCwd(cwd: string): string {
  return cwd
    .replace(/[/\\]/g, '-')
    .replace(/^[A-Za-z]:-/, '')
    .replace(/^-+/, '');
}

/** 转写根：`<tmpdir>/pi-subagents-<uid>`（扩展按 uid 分目录；取不到 uid 的平台按它自己那份 0） */
function transcriptRoot(): string {
  return join(tmpdir(), `${TRANSCRIPT_ROOT_PREFIX}${process.getuid?.() ?? 0}`);
}

/**
 * 某个子智能体的转写文件**绝对路径**；身份或会话 id 含路径分隔符时返回 `null`
 * （拿不到就不读：宁可登记成边界，也不去碰一个拼出来的、可能指到别处的路径）。
 */
export function piSubagentTranscriptPath(params: {
  cwd: string;
  sessionId: string;
  agentId: string;
}): string | null {
  const { cwd, sessionId, agentId } = params;
  if (!SAFE_PATH_SEGMENT.test(sessionId) || !SAFE_PATH_SEGMENT.test(agentId)) return null;
  return join(transcriptRoot(), encodeCwd(cwd), sessionId, 'tasks', `${agentId}.output`);
}

/**
 * 读一个子智能体的转写并折成消息。
 *
 * 失败姿态一律是**可继续**的：文件不在（扩展没装 / 转写被关掉 / 子会话还没落盘）、
 * 权限读不了、正文超上限 —— 都是 `messages: []`（或部分）+ 一条点名原因，由调用方落成 WARN。
 * 「读不到」与「本家结构上没有」因此不会混成同一句话。
 */
export function readPiSubagentTranscript(params: {
  cwd: string;
  sessionId: string;
  agentId: string;
}): PiSubagentTranscript {
  const path = piSubagentTranscriptPath(params);
  if (path === null) {
    return { messages: [], warning: `子任务 ${params.agentId} 的身份或会话 id 含路径分隔符，不去拼转写路径` };
  }
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    return {
      messages: [],
      warning: `子任务 ${params.agentId} 的转写读不到（${typeof code === 'string' ? code : String(error)}）：`
        + '这个子任务的步骤不在产物里，界面上只有生命周期、终局报告与用量',
    };
  }
  const projected = projectTranscriptLines(text, params.agentId, params.sessionId);
  return {
    messages: projected.messages,
    warning: projected.dropped > 0
      ? `子任务 ${params.agentId} 的转写超过 ${PI_SUBAGENT_TRANSCRIPT_MAX_LINES} 行，`
        + `只投影了最后 ${PI_SUBAGENT_TRANSCRIPT_MAX_LINES} 行（丢了 ${projected.dropped} 行）`
      : null,
  };
}

/**
 * 转写正文 → 消息草稿。抽成独立入口是为了能用一段文本直接钉住投影规则（路径与读盘另有用例）。
 *
 * 末行处理：`split('\n')` 之后**只有以换行为界的行才算完整**——最后一段若文件没有以换行收尾，
 * 它就是一次 flush 写到一半的残行（`appendFileSync` 不保证原子），丢掉它比解析出半条正文好。
 */
export function projectTranscriptLines(
  text: string,
  agentId: string,
  sessionId: string,
): { messages: MessageDraft[]; dropped: number } {
  const terminated = text.endsWith('\n');
  const raw = text.split('\n');
  if (!terminated) raw.pop();
  const lines = raw.filter((line) => line.trim() !== '');
  const dropped = lines.length > PI_SUBAGENT_TRANSCRIPT_MAX_LINES
    ? lines.length - PI_SUBAGENT_TRANSCRIPT_MAX_LINES
    : 0;
  const kept = dropped > 0 ? lines.slice(-PI_SUBAGENT_TRANSCRIPT_MAX_LINES) : lines;

  const messages: MessageDraft[] = [];
  /** 该子会话自己的模型往返序：每条助手行 +1，工具结果沿用当前号（与 claude 逐字同一条口径） */
  let round = 0;
  for (const line of kept) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      // 半截行 / 坏行：跳过。转写是补充信息，一条坏行不该让整份投影落空
      continue;
    }
    const entry = asRecord(parsed);
    // 同一份文件只该有一个身份；对不上就当坏行（文件名才是身份，内容不是）
    if (readString(entry, 'agentId') !== agentId) continue;
    const message = asRecord(entry?.['message']);
    if (message === null) continue;
    const type = readString(entry, 'type');
    if (type === 'assistant') {
      round += 1;
      const draft = piAssistantMessageDraft(message, round);
      // 空内容的助手行（无块）不产消息，但**照样占一轮**：它就是一次模型往返
      if (draft !== null) messages.push(stamp(draft, agentId, sessionId));
      continue;
    }
    if (type === 'toolResult') {
      const callId = readString(message, 'toolCallId');
      // 没有调用 id 就没有合并键的载体，也配不回它的调用块 ⇒ 如实丢掉
      if (callId === null || callId === '') continue;
      const draft = piToolResultMessageDraft(
        {
          toolCallId: callId,
          toolName: readString(message, 'toolName'),
          isError: message['isError'] === true,
          durationMs: message['durationMs'],
          // 转写里只有 `content`（`details` / `structuredContent` 是进程内的载荷，不落这份文件）
          result: { content: message['content'] },
        },
        round > 0 ? round : 1,
      );
      if (draft !== null) messages.push(stamp(draft, agentId, sessionId));
      continue;
    }
    // `user`（首行是派发提示词，主会话时间轴里已有）与 `system` 不投影
  }
  return { messages, dropped };
}

/**
 * 盖上**子会话的信封**：这两格是本层存在的理由，一处不落地就等于这批消息又回到了主会话。
 *   · `subagentId`：界面按它把消息分给子任务节点（`build-model.ts` 的 `sessionKeyOf`）；
 *   · `source: 'session-file'`：这批内容来自**旁路文件**而不是进程内事件流，
 *     消费方据此知道它的实时性与 `'wire'` 不同（契约里这一格的三种来源就是为这类通道留的）。
 * `parentCallId` 保持草稿自己的值：工具结果靠它配回调用块（助手消息本来就是 `null`）。
 */
function stamp(draft: MessageDraft, agentId: string, sessionId: string): MessageDraft {
  return {
    ...draft,
    source: 'session-file',
    subagentId: agentId,
    // 旁路通道的事实留在原始载荷里：这份正文来自哪个子会话的哪份转写，排障时要能一眼看到
    raw: { type: 'pi-subagent-transcript', agentId, sessionId, entry: draft.raw },
  };
}
