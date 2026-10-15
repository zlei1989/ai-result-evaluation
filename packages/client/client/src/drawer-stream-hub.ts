/**
 * 抽屉流的客户端出口：**一行 × 一个 channel 一条连接**，三个抽屉 hook（`useRowStream` /
 * `useRowMessages` / `useRowJudgeEvents`）都从这里取帧。
 *
 * 为什么要有这一层：执行日志抽屉原先自己开两条连接（行级事件 + 消息），评分抽屉再开一条，
 * 每条都自己 `new EventSource`、自己按事件名订阅、自己去重。合并之后**连接与解帧只有一份**，
 * 各 hook 只保留自己的折叠逻辑——那是它们各自真正的价值所在。
 *
 * 三层分工（本文件只占第三层）：
 *   · **原语**（`sse-keyed-hub.ts`）：键控的连接管理 + 解帧 + 扇出，与业务无关；
 *   · **信封**（`@aieval/contracts` 的 `RunStreamFrameSchema`）：帧的形状只有那一份；
 *   · **本文件**：键 = `runId:rowId:rowChannel`、URL 拼装（含 `afterSeq`）、以及
 *     「一帧属于哪一族」的两条判别谓词。
 *
 * 两处与契约绑死、不许在本文件里再写一份的东西：
 *   · **具名事件清单**取 `AGENT_EVENT_TYPES`（行级事件的十种）+ 记录那两种，漏一种就是
 *     「那一种事件在真实浏览器里收不到」（规范：具名事件不进 `onmessage`）；
 *   · **帧的解析**用信封契约 `RunStreamFrameSchema`（坏帧返回 `null` 交给 `onInvalidFrame`）。
 *
 * ⚠️ **同一键的续订游标以先到的订阅者为准**：事件那条 hook 先拿到 `/log` 历史、再带着
 * `afterSeq` 订阅，消息那条 hook 只想要全量消息、没有游标可言。两者谁先挂上由各自的 REST
 * 往返决定，后来者共用先到者的连接——多回放一段事件由它自己按 seq 去重（少一段才是错的）。
 */
import {
  AGENT_EVENT_TYPES,
  RunStreamFrameSchema,
  type AgentEvent,
  type DrawerChannel,
  type RowChannelEventFrame,
  type RowChannelMessageFrame,
  type RowRecord,
  type RunStreamFrame,
} from '@aieval/contracts';
import { runKey } from './run-keys';
import { createKeyedSseHub, type SseSink } from './sse-keyed-hub';

/**
 * 抽屉流的一个订阅者（帧已按信封契约解析、且属于它订阅的那个键）。
 * 归属格叫 `rowChannel`（不是 `channel`）：`ask-user` 事件自带一格同名的业务字段，见契约那份说明。
 */
export type DrawerSink = SseSink<RunStreamFrame>;

/**
 * 这条流会发的**具名事件**：行级事件的十种 + 记录那两种（`message` / `subagent`）。
 * `error` 不必列——它在 `EventSource` 上由 `onerror` 承载（原语的注释里写了为什么）。
 */
const DRAWER_EVENT_NAMES: readonly string[] = [...AGENT_EVENT_TYPES, 'message', 'subagent'];

/** 连接故障的一句人话（各条流的措辞可以不同，这里两条 hook 共用同一句） */
const DISCONNECTED_MESSAGE = '实时连接中断：浏览器会自动重连，已收到的内容不受影响';

/**
 * 抽屉流的连接键：`runId:rowId:rowChannel`（一行一个 channel 一条流）。
 *
 * `runId` 与 `rowId` 都不含 `:`（前者是 `randomUUID()`，后者也是），故键可以被 `url` 无损拆回三段。
 */
export function drawerStreamKey(runId: string, rowId: string, rowChannel: DrawerChannel): string {
  return `${runId}:${rowId}:${rowChannel}`;
}

/**
 * 抽屉流的端点：`GET /api/runs/[runId]/drawer/stream?rowId=&rowChannel=&afterSeq=`。
 * `cursor` 是**事件那一侧**的续订起点（消息那一侧每次连接都全量回放，不受它影响）；
 * 服务端还会优先读 `Last-Event-ID`（浏览器自动重连时带的就是它）。
 */
export function drawerStreamUrl(runId: string, rowId: string, rowChannel: DrawerChannel, cursor: number): string {
  return `${runKey(runId)}/drawer/stream?rowId=${encodeURIComponent(rowId)}&rowChannel=${rowChannel}&afterSeq=${cursor}`;
}

/** 键拆回三段（`drawerStreamKey` 的逆）：键的格式只有这一处知道 */
function partsOf(key: string): [runId: string, rowId: string, rowChannel: DrawerChannel] {
  const [runId = '', rowId = '', rowChannel = 'candidate'] = key.split(':');
  return [runId, rowId, rowChannel as DrawerChannel];
}

/** 模块级单例：一个键一条连接，无论挂了多少个 hook 实例（与 run 信号流同一条口径） */
const hub = createKeyedSseHub<RunStreamFrame>({
  url: (key, cursor) => {
    const [runId, rowId, rowChannel] = partsOf(key);
    return drawerStreamUrl(runId, rowId, rowChannel, cursor);
  },
  eventNames: DRAWER_EVENT_NAMES,
  parse: (data) => {
    let raw: unknown;
    try {
      raw = JSON.parse(data);
    } catch {
      return null;
    }
    const parsed = RunStreamFrameSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  },
  disconnected: DISCONNECTED_MESSAGE,
});

/**
 * 一帧是不是「行级事件」：信封里除记录那两种之外都是（判别键是顶层 `type`）。
 * 两条 hook 靠它把自己那一族挑出来——同一条连接上两族是混着来的。
 */
export function isAgentEventFrame(frame: RunStreamFrame): frame is RowChannelEventFrame {
  return frame.type !== 'message' && frame.type !== 'subagent';
}

/** 一帧是不是「行级记录」（消息 / 子任务行） */
export function isRowRecordFrame(frame: RunStreamFrame): frame is RowChannelMessageFrame {
  return frame.type === 'message' || frame.type === 'subagent';
}

/**
 * 事件帧 → `AgentEvent`：归属两格（`rowId` / `channel`）由信封承载，折叠层只认事件自己那份载荷。
 * 多出来的两格是**有意留着**的（折叠与渲染都不读它们），再按 `AgentEventSchema` 剥一遍
 * 等于对每一帧做第二次 zod 解析——那正是这条流最热的路径。
 *
 * 归属格叫 `rowChannel` 而**不是** `channel`，正是为了让事件自己那一格 `channel`（`ask-user`
 * 的业务字段，落盘契约）原样留在载荷里（见 `contracts/src/run-stream.ts`）：撞名时
 * `.extend()` 与展开顺序都会把它顶掉，而消费方（`ui/composite/log-format.ts` 的提问行）
 * 只会印出 `undefined`，不报错。
 */
export function eventOf(frame: RowChannelEventFrame): AgentEvent {
  return frame;
}

/** 记录帧 → `RowRecord`（同上：归属两格留着，折叠只读 `type` / `mergeKey` / `subagentId`） */
export function recordOf(frame: RowChannelMessageFrame): RowRecord {
  return frame;
}

/**
 * 订阅某个抽屉（`cursor` 只在开这条连接时起作用，见文件头）。
 * 返回退订函数：最后一个订阅者退订即关连接（抽屉关掉不留长连接）。
 */
export function subscribeDrawerStream(
  runId: string,
  rowId: string,
  rowChannel: DrawerChannel,
  sink: DrawerSink,
  cursor = 0,
): () => void {
  return hub.subscribe(drawerStreamKey(runId, rowId, rowChannel), sink, cursor);
}

/** 测试复位：关掉全部连接（用例之间不串连接与订阅） */
export function resetDrawerStreamHubForTesting(): void {
  hub.reset();
}

/** 当前开着的连接数（用例断言共享与归零关连接；生产代码不读它） */
export function drawerStreamOpenCount(): number {
  return hub.openCount();
}
