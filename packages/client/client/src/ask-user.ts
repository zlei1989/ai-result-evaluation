/**
 * 应答面的数据层：待答队列的订阅（快照 + 全局流的信号）与应答动作（POST）。
 *
 * 通道是「信号 + 重读」两件套，有**三处不能照抄**：
 *   1. **信号来自全局流**（`GET /api/runs/stream`）：这一族帧与列表状态、人工消息队列共用同一条
 *      页面级长连接，本 hook **不再自己 `new EventSource`**（三条流并存时页面会让每个消费方
 *      各开一条，界面看不出来、只有 Network 面板能看见）；
 *   2. **帧里没有载荷**，只有一个判别值 `{ type: 'ask-user-changed' }`：清单内容一律靠重读快照拿。
 *      同一条连接上还有 `run-updated` / `inject-messages-changed` 两族，**只认自己这一族**
 *      （不认的帧也重读一次快照，等于把别的功能的翻转放大成好几次全量读）；
 *   3. **没有 `afterSeq` / `Last-Event-ID`**：信号不可续订，断线期间服务端发的帧永远补不回来，
 *      故**重连本身当一条信号**补读一次快照；不补就会漏掉断线期间登记的那几问（挂起表不重放）。
 *      这条判据在全局流那一层统一（`global-stream-hub.ts` 的 `onReconnect`），这里不另写一份。
 *
 * 快照（`GET /api/ask-user`）是唯一读侧：它同时服务「晚开的页面」与「刷新」，信号只推「变了」。
 * 读失败时**保持现状**——把「读不到」折成「没有待答」会让正开着的弹层凭空消失；下一次信号或重连
 * 还会再读一次。
 *
 * **弹谁**按 run 焦点过滤（**暂缓**）：`focusedRunId` 之外的那些轮次的提问不弹、不取消、不出队，
 * 仍留在 `pending` 里由挂起表计时；焦点为 `null`（没在看某一轮）时全部可弹。
 * 队列规则（先来后到 / 收到确认才出队 / 关掉不算答）全在 `ask-user-queue.ts` 的纯函数里，
 * 本文件只负责把它们接到通道上，并把「提交在途」这一格状态带给面板。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { getJson, postJson } from './http';
import {
  EMPTY_ASK_USER_QUEUE,
  answerableAskUser,
  applyAskUserSnapshot,
  confirmAskUserAnswered,
  currentAskUser,
  dismissAskUser,
  reopenAskUser,
  type AskUserQueueState,
} from './ask-user-queue';
import { subscribeGlobalStream } from './global-stream-hub';
import type { AskUserAnswerAccepted, AskUserAnswerRequest, PendingAskUser, PendingAskUserList } from '@aieval/contracts';
import type { AskUserAnswer } from '@aieval/ui';

/** 待答快照端点（读侧唯一入口；`?runId=` 可选过滤） */
export const ASK_USER_URL = '/api/ask-user';
/** 应答提交端点（写侧唯一入口） */
export const ASK_USER_ANSWERS_URL = '/api/ask-user/answers';

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

export interface UseAskUserQueueInput {
  /**
   * 焦点轮：只弹这一轮的提问（其余轮的**暂缓**）。`null` / 缺省 = 没在看某一轮
   * （列表页、别的页面）⇒ 全部可弹。页面用 `run-focus.ts` 的 `useFocusedRun()` 给它。
   */
  focusedRunId?: string | null;
}

export interface UseAskUserQueueResult {
  /**
   * 此刻该弹出的那一问：**有资格弹的**队首，且没被用户关掉。
   * `null` = 没有要答的、队首刚被关掉、或焦点那一轮没有待答提问（其余轮的仍暂缓在队列里）。
   */
  current: PendingAskUser | null;
  /**
   * 还没答的提问，顺序 = 服务端快照的顺序（先来后到）。
   * **含暂缓的那些与已被关掉的**：暂缓不是取消，判据（队列长度不变）就落在这里。
   */
  pending: readonly PendingAskUser[];
  /** 还没答的总数（含暂缓的与被关掉的那一条） */
  pendingCount: number;
  /** 焦点内有资格弹的条数（浮层入口的徽标与显隐用它：暂缓的那些不提示） */
  answerableCount: number;
  /** 焦点内排在这一问之后的条数：面板标题右侧的「还有 N 个待答」 */
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

export function useAskUserQueue(input: UseAskUserQueueInput = {}): UseAskUserQueueResult {
  const focusedRunId = input.focusedRunId ?? null;
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

    // 全局流：帧里只有判别值（见文件头第 2 条），只认自己那一族；重连补读由 hub 统一通知
    // （环境没有 EventSource 时退化为「只在挂载时读一次」，不抛也不影响页面）
    const off = subscribeGlobalStream({
      onFrame: (frame) => {
        if (frame.type === 'ask-user-changed') void read();
      },
      onReconnect: () => void read(),
    });

    return () => {
      cancelled = true;
      off();
    };
  }, []);

  const current = currentAskUser(state, focusedRunId);
  const answerable = answerableAskUser(state, focusedRunId);

  const submit = useCallback(
    (answers: AskUserAnswer[]): Promise<void> => {
      // 答的必须是**用户看见的那一问**：面板只画有资格弹的队首，这里也只认它
      // （被关掉的那一问不算「在看」；暂缓的那些连队首都当不上，因此答不到别的轮次上去）
      const visible = currentAskUser(state, focusedRunId);
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
    [state, focusedRunId],
  );

  /** 关 ≠ 答：只记本地记号，不发请求、不动队列 */
  const close = useCallback((): void => {
    const visible = currentAskUser(state, focusedRunId);
    if (visible === null) return;
    setState((previous) => dismissAskUser(previous, visible.askId));
  }, [state, focusedRunId]);

  const reopen = useCallback((): void => {
    setState(reopenAskUser);
  }, []);

  return {
    current,
    pending: state.pending,
    pendingCount: state.pending.length,
    answerableCount: answerable.length,
    waitingCount: Math.max(0, answerable.length - 1),
    submitting,
    submit,
    close,
    reopen,
  };
}
