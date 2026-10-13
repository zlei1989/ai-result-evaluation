/**
 * 待答队列的**推进规则**（纯函数：无 DOM、无请求、无 React）：先来后到、收到确认才出队、关掉不算答。
 *
 * 三份事实各有归属，本模块只做合并：
 *   · **快照是唯一的读侧**（`GET /api/ask-user`）：队列顺序**就是快照顺序**——挂起表按提问时刻
 *     给清单，客户端再排一次只会在「两次登记的间隙里读到过一次快照」时把后问的排到先问的前面；
 *   · **确认是唯一的出队凭据**：`confirmAskUserAnswered` 只由「应答 POST 收到 200」驱动。用户点
 *     「完成」本身不出队——请求失败、409（别处先答了）、404（已收场 / 重启过）都必须让这一问留在
 *     队列里，否则用户以为答完了，而厂商那边等到的是「无人应答」；
 *   · **关掉只是本地记号**：`dismissAskUser` 一个字都不动 `pending`，只记「这一问这次不自动弹」。
 *     它仍在队列里（行侧照旧在等），能再打开（`reopenAskUser`）。
 *
 * `settled` 那一格防的是**迟到的快照**：读快照与应答 POST 并发时，先发出、后到达的那份清单里
 * 还列着已经答完的一问（服务端算它时这一问还在表里），不记名它就会再弹一次。从快照里消失的条目
 * 同样记名——服务端说它不在待答里了，那么无论它是被谁答的、被取消的还是超时的，都不该再弹。
 * 代价如实登记：该集合随页面会话单调增长，每条一个 UUID、一次作答一条。
 */
import type { PendingAskUser } from '@aieval/contracts';

/** 队列状态：还没答的提问 + 两格本地记号（已收场的、被关掉的） */
export interface AskUserQueueState {
  /** 还没答的提问；顺序 = 服务端快照的顺序（先来后到），队首是下一条要答的 */
  readonly pending: readonly PendingAskUser[];
  /** 已收场的 `askId`：迟到的快照仍可能列着它，不许据此把它塞回队列 */
  readonly settled: readonly string[];
  /** 被用户关掉的那一问（关 ≠ 答：它仍在 `pending` 里，只是不再自动弹出） */
  readonly dismissedAskId: string | null;
}

/** 初始态：一条待答都没有 */
export const EMPTY_ASK_USER_QUEUE: AskUserQueueState = { pending: [], settled: [], dismissedAskId: null };

/**
 * 用一份快照对齐队列：顺序取快照（先来后到是服务端的事实），已收场的条目不再进队。
 * 被关掉的那一问从快照里消失时把记号一并清掉——否则一个指向已收场提问的记号会把下一问挡在门外。
 */
export function applyAskUserSnapshot(
  state: AskUserQueueState,
  snapshot: readonly PendingAskUser[],
): AskUserQueueState {
  const incoming = new Set(snapshot.map((item) => item.askId));
  const settled = new Set(state.settled);
  for (const item of state.pending) {
    if (!incoming.has(item.askId)) settled.add(item.askId);
  }
  const pending = snapshot.filter((item) => !settled.has(item.askId));
  const dismissedAskId =
    state.dismissedAskId !== null && pending.some((item) => item.askId === state.dismissedAskId)
      ? state.dismissedAskId
      : null;
  return { pending, settled: [...settled], dismissedAskId };
}

/** 出队：只在服务端确认受理了这一次应答之后调用（见文件头第二条） */
export function confirmAskUserAnswered(state: AskUserQueueState, askId: string): AskUserQueueState {
  return {
    pending: state.pending.filter((item) => item.askId !== askId),
    settled: state.settled.includes(askId) ? state.settled : [...state.settled, askId],
    dismissedAskId: state.dismissedAskId === askId ? null : state.dismissedAskId,
  };
}

/** 关掉弹层：只记「这一问这次不自动弹」，队列一字不动（关 ≠ 答） */
export function dismissAskUser(state: AskUserQueueState, askId: string): AskUserQueueState {
  return { ...state, dismissedAskId: askId };
}

/** 重新打开被关掉的那一问：清掉记号即可，它本来就还在队列里 */
export function reopenAskUser(state: AskUserQueueState): AskUserQueueState {
  if (state.dismissedAskId === null) return state;
  return { ...state, dismissedAskId: null };
}

/** 此刻该弹出的那一问：队首，且没有被用户关掉。`null` = 没有要答的，或队首刚被关掉 */
export function currentAskUser(state: AskUserQueueState): PendingAskUser | null {
  const head = state.pending[0];
  if (head === undefined) return null;
  return head.askId === state.dismissedAskId ? null : head;
}
