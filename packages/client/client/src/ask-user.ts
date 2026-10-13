/**
 * 应答面的数据层：待答队列的订阅（快照 + 信号流）与应答动作（POST）。
 *
 * 通道是「信号 + 重读」两件套（与 `run-events.ts` 的 run 级信号流同形），有**两处不能照抄**：
 *   1. **帧里没有载荷**：服务端只发 `event: ask-user-changed` 加一行空的 `data:`（见 api 的
 *      `ask-user-stream.ts`），`event.data` 是空串 ⇒ 本 hook 只认事件名，一个字节都不读。
 *      那一行空的 `data:` 是服务端**必须**给的：SSE 规范下没有 `data` 字段的块根本不派发事件，
 *      客户端再怎么写也收不到（载荷本身是空的这一条不变，`JSON.parse` 那类写法在这里没有意义）；
 *   2. **没有 `afterSeq` / `Last-Event-ID`**：信号不可续订，断线期间服务端发的帧永远补不回来，
 *      故**重连本身当一条信号**补读一次快照；不补就会漏掉断线期间登记的那几问（挂起表不重放）。
 *
 * 快照（`GET /api/ask-user`）是唯一读侧：它同时服务「晚开的页面」与「刷新」，信号只推「变了」。
 * 读失败时**保持现状**——把「读不到」折成「没有待答」会让正开着的弹层凭空消失；下一次信号或重连
 * 还会再读一次。
 *
 * 队列规则（先来后到 / 收到确认才出队 / 关掉不算答）全在 `ask-user-queue.ts` 的纯函数里，
 * 本文件只负责把它们接到通道上，并把「提交在途」这一格状态带给面板。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { getJson, postJson } from './http';
import {
  EMPTY_ASK_USER_QUEUE,
  applyAskUserSnapshot,
  confirmAskUserAnswered,
  currentAskUser,
  dismissAskUser,
  reopenAskUser,
  type AskUserQueueState,
} from './ask-user-queue';
import type { AskUserAnswerAccepted, AskUserAnswerRequest, PendingAskUser, PendingAskUserList } from '@aieval/contracts';
import type { AskUserAnswer } from '@aieval/ui';

/** 待答快照端点（读侧唯一入口） */
export const ASK_USER_URL = '/api/ask-user';
/** 待答信号流：帧里只有「变了」，载荷是空串（`data:` 字段必须在，见文件头第 1 条） */
export const ASK_USER_STREAM_URL = '/api/ask-user/stream';
/** 应答提交端点（写侧唯一入口） */
export const ASK_USER_ANSWERS_URL = '/api/ask-user/answers';
/** 信号帧的事件名（与 api 的 `toFrame` 同字面量；载荷是空串，见文件头第 1 条） */
export const ASK_USER_CHANGED_EVENT = 'ask-user-changed';

/**
 * 应答动作：把一份答案 POST 回去。**只有 200 是受理**——409（别处先答了）、404（已收场 / 重启过）
 * 与网络错都抛 `ServiceError`，由调用方决定怎么提示；本函数不认识队列，也不改任何状态。
 */
export function postAskUserAnswers(
  askId: string,
  answers: readonly AskUserAnswer[],
): Promise<AskUserAnswerAccepted> {
  const body: AskUserAnswerRequest = {
    askId,
    // 界面侧那份答案是只读数组（`selected: readonly string[]`），契约要可变数组：摊平一次。
    // 数量与顺序一个字都不改——「逐问对上」由服务端校验，客户端不替它做主
    answers: answers.map((answer) => ({
      header: answer.header,
      selected: [...answer.selected],
      custom: answer.custom,
    })),
  };
  return postJson<AskUserAnswerAccepted>(ASK_USER_ANSWERS_URL, body);
}

export interface UseAskUserQueueResult {
  /** 此刻该弹出的那一问：队首，且没被用户关掉。`null` = 没有要答的（或被关掉的那一问还挂在队首） */
  current: PendingAskUser | null;
  /** 还没答的提问，顺序 = 服务端快照的顺序（先来后到） */
  pending: readonly PendingAskUser[];
  /** 还没答的总数（含被关掉的那一条） */
  pendingCount: number;
  /** 排在这一问之后的条数：面板标题右侧的「还有 N 个待答」 */
  waitingCount: number;
  /** 「完成」的请求在途：面板主按钮转圈并禁用 */
  submitting: boolean;
  /** 交出一份答案：**收到确认才出队**；失败（包括 409 / 404）时这一问留在队列里，并把原因抛出 */
  submit(answers: AskUserAnswer[]): Promise<void>;
  /** 关掉弹层：不发请求、队列不变，只记「这一问这次不自动弹」 */
  close(): void;
  /** 重新打开被关掉的那一问 */
  reopen(): void;
}

export function useAskUserQueue(): UseAskUserQueueResult {
  const [state, setState] = useState<AskUserQueueState>(EMPTY_ASK_USER_QUEUE);
  const [submitting, setSubmitting] = useState(false);
  /** 读快照的序号：响应到达时若已有更晚的一次读发出，这份快照整份丢弃（旧清单会盖住新的） */
  const readSeqRef = useRef(0);
  /**
   * 在途标记放 ref 而不是读 `submitting` state：`setSubmitting` 要等下一次渲染才落到按钮的
   * `disabled` 上，同一 tick 内的第二次「完成」（双击）会读到还没更新的 state ⇒ 发出第二份答案。
   */
  const inFlightRef = useRef(false);

  useEffect(() => {
    let cancelled = false;

    /** 重读一次快照并对齐队列；迟到的响应与卸载后的响应都整份丢弃 */
    const read = async (): Promise<void> => {
      readSeqRef.current += 1;
      const seq = readSeqRef.current;
      try {
        const snapshot = await getJson<PendingAskUserList>(ASK_USER_URL);
        if (cancelled || seq !== readSeqRef.current) return;
        setState((previous) => applyAskUserSnapshot(previous, snapshot));
      } catch {
        // 读不到就保持现状（见文件头）：下一次信号或重连会再读一次
      }
    };

    void read();

    // 环境没有 EventSource（老浏览器 / 测试没装替身）时退化为「只在挂载时读一次」：不抛，
    // 也不影响页面——与行级流同一条兜底口径
    if (typeof EventSource === 'undefined') return () => { cancelled = true; };

    const source = new EventSource(ASK_USER_STREAM_URL);
    /** 重连判据：首次连接不补读（挂载时那一次读就在同一瞬间），此后每次重连补一次 */
    let openedOnce = false;
    source.onopen = () => {
      if (openedOnce) void read();
      openedOnce = true;
    };
    // 只认事件名：帧里没有载荷（见文件头第 1 条），读 `event.data` 只会拿到空串
    const onChanged = (): void => { void read(); };
    source.addEventListener(ASK_USER_CHANGED_EVENT, onChanged);

    return () => {
      cancelled = true;
      source.removeEventListener(ASK_USER_CHANGED_EVENT, onChanged);
      source.close();
    };
  }, []);

  const current = currentAskUser(state);

  const submit = useCallback(
    (answers: AskUserAnswer[]): Promise<void> => {
      // 答的必须是**用户看见的那一问**：面板只画队首，这里也只认队首（被关掉的那一问不算「在看」）
      const visible = currentAskUser(state);
      if (visible === null || inFlightRef.current) return Promise.resolve();
      inFlightRef.current = true;
      setSubmitting(true);
      const askId = visible.askId;
      return postAskUserAnswers(askId, answers)
        .then(() => {
          // **收到确认才出队**：POST 200 就是服务端的受理凭据。409 / 404 / 网络错都走 catch，
          // 这一问原样留在队列里——乐观出队会让用户以为答完了，而厂商那边等到的是「无人应答」
          setState((previous) => confirmAskUserAnswered(previous, askId));
        })
        .finally(() => {
          inFlightRef.current = false;
          setSubmitting(false);
        });
    },
    [state],
  );

  /** 关 ≠ 答：只记本地记号，不发请求、不动队列 */
  const close = useCallback((): void => {
    const visible = currentAskUser(state);
    if (visible === null) return;
    setState((previous) => dismissAskUser(previous, visible.askId));
  }, [state]);

  const reopen = useCallback((): void => {
    setState(reopenAskUser);
  }, []);

  return {
    current,
    pending: state.pending,
    pendingCount: state.pending.length,
    waitingCount: Math.max(0, state.pending.length - 1),
    submitting,
    submit,
    close,
    reopen,
  };
}
