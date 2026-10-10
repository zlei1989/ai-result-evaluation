/**
 * dsh 的**流式增量旁路**（stream-tap，2026-10-09）：把厂商进程内的逐字流接到我们手里。
 *
 * 为什么需要它：厂商的逐字流只存在于 runtime 进程内的 `agent/assistant-stream` 事件里
 * （`AssistantStreamFrame`，携带 `text-delta` / `reasoning-delta` / `block-start` / `block-end`
 * 的原始 `StreamChunk`），而 **stdio 通知流不投送它**——jsonrpc-server 任何版本都只订阅
 * `session/event` / `agent/status` / `session/created` / `subagent/end` 四个进程内事件
 * （源码与真机双重证据，见 `docs/faq/deepseek-harness.md`）。执行日志的打字机效果需要
 * token 级增量 ⇒ 适配器把一个**插件**写进每行的 profile 目录（overlay `insert`，相对名按
 * **`<dshHome>`** 解析——2026-10-10 实测修正，见 `DSH_STREAM_TAP_PLUGIN_RELATIVE_PATH`），由它把 chunk 帧
 * 追加写到 `<configHome>/aieval-stream-tap.jsonl`；本文件在父进程里 tail 这个文件，
 * 把每一行包成 `aieval/delta` **伪通知**（见 `protocol.ts` 的 `DSH_STREAM_DELTA_TYPE`）。
 *
 * 两处刻意的设计（改前先读）：
 *  · **旁路文件而不是合成事件**：runtime 里 `session/event` 是「先落会话日志、再通知」的受控
 *    调度（`session-persistence-jsonl` 就订阅它逐事件写盘）——伪造一条 session 事件会把增量
 *    混进厂商的持久化日志，读回来时 `KNOWN_SESSION_EVENT_TYPES` 又不认它。sidecar 文件
 *    完全在我们自己的管辖下，随行产物清理；
 *  · **块位次换算**：快照侧（`dshAssistantMessageDraft`）给 text/reasoning 块的序号是它在
 *    `content[]` 里的位次（含 tool-call），而增量只带「该次尝试内的流序号」。这里的
 *    `positionOf` 按**该次尝试里块的首见顺序**发号（与厂商 `BlockAssembler.order` 同一算法）
 *    ⇒ 同一条逻辑消息的增量与快照落进同一个槽位，快照到达即覆盖收尾。
 */
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { asRecord, readNumber, readString } from '../../json';
import type { DshNotification } from './sdk';
import { DSH_STREAM_DELTA_TYPE } from './protocol';

/** 旁路文件相对 `configHome` 的落点（插件写、本文件读，两边逐字一致） */
export const DSH_STREAM_TAP_RELATIVE_PATH = 'aieval-stream-tap.jsonl';
/**
 * 插件本体相对 `configHome` 的落点（2026-10-10 修正）。
 *
 * **必须落在 `configHome` 根下**，不是 `profiles/sdk/`：overlay 里写的是 `name: "./aieval-stream-tap.mjs"`，
 * 而运行时按 **`dshHome`** 解析这个 `./` 相对名。原先写在 `profiles/sdk/` 里的后果是**插件从来没被加载过**，
 * 每次运行都打一行 stderr（探针实证两次）：
 *   `dsh: warning: 1 entry did not activate`
 *   `aieval-stream-tap (file:///<dshHome>/aieval-stream-tap.mjs): failed to import`
 * ⇒ 旁路文件恒 0 字节、能力位声明 `streamingDelta: yes` 而界面一条增量都没有（打字机不动）。
 * 这条路径不是猜的：`probe/v3/dsh-tap-truncation.mjs` 的变体 B 会把插件写在两种落点各跑一次对照。
 */
export const DSH_STREAM_TAP_PLUGIN_RELATIVE_PATH = 'aieval-stream-tap.mjs';

/**
 * tail 轮询间隔（毫秒）。流式期间厂商通知流是**静默的**（一个 step 内没有任何 session 事件），
 * 没有这一拍，增量要等到快照之后才被读出（打字机不动）；100ms ≈ 10fps，对 CSS 光标
 * （1s 一闪）足够跟手，而对一段 5000 token 的回复也只是每秒十次 stat + 0 字节读。
 */
export const DSH_STREAM_TAP_POLL_MS = 100;

/**
 * 插件源码（整份内联成字符串，运行时落盘）：**不依赖任何包**（只有 node: 内建），
 * 且所有路径都防御式收窄——它在厂商进程里跑，任何抛错都可能打断被测运行，
 * 观测手段没有资格制造失败。`DSH_HOME` 是 SDK 拼给子进程的环境（见 `sdk.ts` 的注入说明），
 * 插件与适配器靠它对上同一个 `configHome`。
 */
export const DSH_STREAM_TAP_PLUGIN_SOURCE = `// 由 ai-result-evaluation 的 dsh 适配器写入（stream-tap）：把厂商进程内的逐字流旁路到 sidecar 文件。
// 为什么存在：stdio 通知流不投送 agent/assistant-stream（任何版本都不投），而执行日志的
// 打字机效果需要 token 级增量。本插件只做追加写；任何失败都吞掉——观测手段绝不打断被测运行。
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';

const TAP_TYPES = new Set(['block-start', 'text-delta', 'reasoning-delta', 'block-end']);

export default function aievalStreamTap(ctx) {
  const home = process.env.DSH_HOME;
  if (typeof home !== 'string' || home === '') return;
  const file = join(home, 'aieval-stream-tap.jsonl');
  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    try {
      if (frame === null || typeof frame !== 'object' || frame.type !== 'chunk') return;
      const chunk = frame.chunk;
      if (chunk === null || typeof chunk !== 'object' || !TAP_TYPES.has(chunk.type)) return;
      const session = agent !== null && typeof agent === 'object' ? agent.session : null;
      const sid = session !== null && typeof session === 'object' ? session.id : null;
      if (typeof sid !== 'string' || sid === '') return;
      appendFileSync(file, JSON.stringify({ sid, frame }) + '\\n');
    } catch {
      // 旁路失败不影响运行：丢一行比打断一次评测便宜得多
    }
  });
}
`;

/** tap 伪通知的会话归属（登记与放行判据见 `createDshStreamTapGate`） */
function tapSessionId(notification: DshNotification): string {
  return typeof notification.params.sessionId === 'string' ? notification.params.sessionId : '';
}

export interface DshStreamTapGate {
  /** 读出新行并放行**会话已知**的伪通知；未知的挂起（下次 drain 再试）。返回数组可能为空。 */
  drain(knownSessions: ReadonlySet<string>): DshNotification[];
  /** 释放文件句柄（幂等；未放行的挂起行随之丢弃——增量本就只广播，迟到的丢掉无害） */
  close(): void;
}

/**
 * tail 旁路文件并把行折成 `aieval/delta` 伪通知，按**会话已知**放行。
 *
 * 为什么要门闸（而不是读出来就放）：子会话的增量行可能在 `subagent.started` **投影之前**落盘
 * （写入方在厂商进程里，与我们的消费节奏无关）。`sessionIdProfileSubagent` 的判据是
 * 「登记过的才是子会话」——没登记的 sid 会被当成**主会话**，子智能体的话就挤进主会话
 * 同 step 号的载体里。门闸把这类行**挂起**，等调用方（`notificationStream`）放行过
 * `subagent.started`、把子会话 id 记进 `knownSessions` 之后再放行。
 */
export function createDshStreamTapGate(file: string): DshStreamTapGate {
  let fd: number | null = null;
  let offset = 0;
  let pendingLine = '';
  /** 未达会话判据的伪通知（挂起等待下次 drain） */
  let held: DshNotification[] = [];
  /** 块位次表：attemptId →（流序号 → 该次尝试内的块位次）。挂在 gate 上（每 run 一个实例，无模块态） */
  const positions = new Map<string, Map<number, number>>();

  const positionOf = (attempt: string, blockIndex: number): number => {
    let byBlock = positions.get(attempt);
    if (byBlock === undefined) {
      byBlock = new Map();
      positions.set(attempt, byBlock);
    }
    const existing = byBlock.get(blockIndex);
    if (existing !== undefined) return existing;
    // 首见顺序发号：与厂商 BlockAssembler.order 同一算法，对齐快照侧 content[] 的位次
    const position = byBlock.size;
    byBlock.set(blockIndex, position);
    return position;
  };

  /** 一行 → 伪通知（或 null）。block-start/block-end 只占位不产消息（v1 不投 block-end） */
  const lineToNotification = (line: string): DshNotification | null => {
    if (line.trim() === '') return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // 坏行跳过、不打 WARN：这是旁路文件，噪声会盖住真正要看的 WARN
      return null;
    }
    const record = asRecord(parsed);
    const sid = readString(record, 'sid');
    const frame = asRecord(record?.frame);
    if (sid === null || frame === null) return null;
    if (readString(frame, 'type') !== 'chunk') return null;
    const chunk = asRecord(frame.chunk);
    const chunkType = readString(chunk, 'type');
    const attempt = readString(frame, 'attemptId');
    const blockIndex = readNumber(chunk, 'index');
    if (attempt === null || blockIndex === null) return null;
    if (chunkType === 'block-start' || chunkType === 'block-end') {
      // 占位（tool-call 块可能只有 start/end、没有增量，但它占一个 content 位次）
      positionOf(attempt, blockIndex);
      return null;
    }
    if (chunkType !== 'text-delta' && chunkType !== 'reasoning-delta') return null;
    const text = readString(chunk, 'text') ?? '';
    if (text === '') return null;
    const data = asRecord(frame);
    return {
      method: 'session.event',
      params: {
        sessionId: sid,
        event: {
          type: DSH_STREAM_DELTA_TYPE,
          time: readNumber(data, 'time') ?? Date.now(),
          data: {
            turn: readNumber(data, 'turn'),
            step: readNumber(data, 'step'),
            delta: {
              kind: chunkType === 'reasoning-delta' ? 'reasoning' : 'text',
              text,
              position: positionOf(attempt, blockIndex),
            },
          },
        },
      },
    };
  };

  const readNewLines = (): DshNotification[] => {
    const out: DshNotification[] = [];
    let size: number;
    try {
      size = statSync(file).size;
    } catch {
      // 文件还没被插件建出来：就是「还没有增量」
      return out;
    }
    if (size < offset) {
      // 文件比上次读的还短（被截断/替换）：从头跟，宁可重放几条也不静默丢一段
      offset = 0;
      pendingLine = '';
    }
    if (size === offset) return out;
    if (fd === null) {
      try {
        fd = openSync(file, 'r');
      } catch {
        return out;
      }
    }
    const length = size - offset;
    const buffer = Buffer.alloc(length);
    const read = readSync(fd, buffer, 0, length, offset);
    offset += read;
    // 半截行留到下次（最后一段可能没写完）
    pendingLine += buffer.toString('utf8', 0, read);
    const lines = pendingLine.split('\n');
    pendingLine = lines.pop() ?? '';
    for (const line of lines) {
      const notification = lineToNotification(line);
      if (notification !== null) out.push(notification);
    }
    return out;
  };

  return {
    drain(knownSessions: ReadonlySet<string>): DshNotification[] {
      held.push(...readNewLines());
      const ready = held.filter((one) => knownSessions.has(tapSessionId(one)));
      held = held.filter((one) => !knownSessions.has(tapSessionId(one)));
      return ready;
    },
    close(): void {
      if (fd !== null) {
        closeSync(fd);
        fd = null;
      }
      held = [];
    },
  };
}
