/**
 * 人工消息的**数据层**：一行的队列快照（读侧唯一入口）+ 信号式 SSE + 四个写动作
 * （发送 / 改期 / 撤回 / 附件上传）。
 *
 * 通道形状照既有两条信号流（`ask-user.ts` 与 `run-events.ts`），三处不能照抄的地方都写在下面对应位置：
 *   1. **信号来自全局流**（`GET /api/runs/stream`）：这一族帧与列表状态、待答快照共用同一条页面级
 *      长连接，本 hook **不再自己 `new EventSource`**；帧里只有一个判别值
 *      `{ type: 'inject-messages-changed' }`（没有载荷、也不按行订阅），同一条连接上还有另两族，
 *      本 hook **只认自己这一族**；
 *   2. **没有 `afterSeq` / `Last-Event-ID`**：信号不可续订，断线期间服务端发的帧永远补不回来，
 *      于是**重连本身当一条信号**补读一次快照（判据在全局流那一层统一，这里不另写一份）；
 *   3. **写动作之后一律重读快照，成败都读**：快照是「这一条现在在哪一态」的唯一权威读侧——
 *      撤回成功那一条会以 `gone` 出现，撤不回来那一条会以 `consumed`（带中文原因）出现，
 *      而**客户端不做乐观出队**（乐观出队会让用户以为撤干净了，而厂商那边还留着；
 *      pi 的全清竞态还会导致双份）。
 *
 * **快照原样透出，一处都不裁**：`gone` 那一条带的 `outcome` / `reason` 正是「它为什么消失」，
 * 「跳过 `gone`」是**渲染层**的口径（渲染层才知道它在画什么），数据层裁掉就等于让界面说不出这句话。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import useSWR from 'swr';
import type {
  InjectAttachmentAccepted,
  InjectMessage,
  InjectMessageList,
  InjectMessagePromoteAccepted,
  InjectMessageRef,
  InjectMessageRetractAccepted,
  InjectMessageSendAccepted,
  InjectMessageSendRequest,
} from '@aieval/contracts';
import { getJson, postForm, postJson } from './http';
import { subscribeGlobalStream } from './global-stream-hub';

/** 快照（`GET`，定位走查询参数）与发送（`POST`，定位走请求体）同住这一条路由 */
export const INJECT_MESSAGES_URL = '/api/inject-messages';
/** 撤回端点（与「删除未投递项」是同一个动作，服务端按状态分派） */
export const INJECT_MESSAGES_RETRACT_URL = '/api/inject-messages/retract';
/** 改期端点（「立即发送」，单向：只能变早） */
export const INJECT_MESSAGES_PROMOTE_URL = '/api/inject-messages/promote';
/** 附件上传端点（`multipart/form-data`） */
export const INJECT_MESSAGES_ATTACHMENTS_URL = '/api/inject-messages/attachments';

/** 一行队列快照的地址（也是 SWR 键）：与 REST 端点同形，换行即换键 */
export function injectMessagesUrl(runId: string, rowId: string): string {
  return `${INJECT_MESSAGES_URL}?runId=${encodeURIComponent(runId)}&rowId=${encodeURIComponent(rowId)}`;
}

/**
 * 发送一条人工消息（登记）。
 *
 * **两种结局都回 200**：首个 `{created:true}`，同一个 `messageId` 再发一次 `{created:false}` + 同一条。
 * 界面对两者的动作完全一样（重读快照）——**不新增、不再投递**由服务端保证，客户端不做第二次去重
 * （两处判重必然漂，而漂的那一次就是「模型看到两遍」）。
 */
export function postInjectMessage(request: InjectMessageSendRequest): Promise<InjectMessageSendAccepted> {
  return postJson<InjectMessageSendAccepted>(INJECT_MESSAGES_URL, request);
}

/** 改期（「立即发送」）：只对还没取走的条目可用 */
export function postInjectMessagePromote(ref: InjectMessageRef): Promise<InjectMessagePromoteAccepted> {
  return postJson<InjectMessagePromoteAccepted>(INJECT_MESSAGES_PROMOTE_URL, ref);
}

/**
 * 撤回一条（界面上的「删除」）：服务端按这一条当前的状态分派。
 *
 * 失败（404 没这个 id / 409 已被模型读到或这一家撤不了）**抛 `ServiceError`**，由调用方提示原因；
 * 本函数不改任何本地状态——重读快照是调用方的事（见文件头第 3 条）。
 */
export function postInjectMessageRetract(ref: InjectMessageRef): Promise<InjectMessageRetractAccepted> {
  return postJson<InjectMessageRetractAccepted>(INJECT_MESSAGES_RETRACT_URL, ref);
}

/**
 * 上传一份附件，拿回它的清单项（`{kind, path, mimeType}`，**没有字节数**——大小由服务端在取件那刻现读）。
 *
 * **先上传拿到路径、再点发送**：登记那一刻正文与附件清单就是完整事实。附件落在
 * `rowDir/attachments/<messageId>/`，`messageId` 由调用方先铸好（它同时是登记的幂等键）。
 */
export function postInjectAttachment(input: {
  runId: string;
  rowId: string;
  messageId: string;
  file: File;
}): Promise<InjectAttachmentAccepted> {
  const form = new FormData();
  form.set('runId', input.runId);
  form.set('rowId', input.rowId);
  form.set('messageId', input.messageId);
  // 字段名固定 `file`：路由层按这个名字取文件，写错会得到一句「上传请求里没有文件」
  form.set('file', input.file);
  return postForm<InjectAttachmentAccepted>(INJECT_MESSAGES_ATTACHMENTS_URL, form);
}

export interface UseInjectMessagesInput {
  runId: string;
  rowId: string;
  /** 闸门关着 / 抽屉关着时不发任何请求（也不开那条全局信号流） */
  enabled: boolean;
}

export interface UseInjectMessagesResult {
  /** 这一行的人工消息（**含终态**，渲染层自己跳过 `gone`）；顺序即服务端表的顺序 */
  messages: InjectMessage[];
  isLoading: boolean;
  error: unknown;
  /** 重读快照；写动作内部已经调它，这里给的是「手动再读一次」的出口 */
  refresh: () => Promise<void>;
  /** 发一条：`requires` 由调用方给（界面上的发送键固定用「排队」那一档） */
  send(request: InjectMessageSendRequest): Promise<InjectMessageSendAccepted>;
  promote(messageId: string): Promise<InjectMessagePromoteAccepted>;
  retract(messageId: string): Promise<InjectMessageRetractAccepted>;
  uploadAttachment(messageId: string, file: File): Promise<InjectAttachmentAccepted>;
  /** 有没有写动作在途（按钮转圈 / 禁用；同时发多条时按计数） */
  busy: boolean;
}

/**
 * 订阅一行的队列快照。`enabled` 为 false 时（闸门关着、抽屉关着）一个请求都不发。
 */
export function useInjectMessages(input: UseInjectMessagesInput): UseInjectMessagesResult {
  const { runId, rowId, enabled } = input;
  const active = enabled && runId !== '' && rowId !== '';
  const key = active ? injectMessagesUrl(runId, rowId) : null;
  const { data, error, isLoading, mutate } = useSWR<InjectMessageList>(key, getJson);

  /** 写动作在途计数：并发两个动作时不能被先回来的那个清掉 */
  const [busyCount, setBusyCount] = useState(0);

  const refresh = useCallback(async (): Promise<void> => {
    await mutate();
  }, [mutate]);

  /**
   * 信号订阅：帧一到就重读快照。
   *
   * `mutate` 的处理放 `ref`：SWR 每次渲染都给一个新的函数身份，直接进依赖数组会让 effect
   * 每渲染一次就重开一条 SSE（症状是服务端连接数暴涨，而界面看起来正常）。
   */
  const mutateRef = useRef(mutate);
  useEffect(() => {
    mutateRef.current = mutate;
  }, [mutate]);

  useEffect(() => {
    if (!active) return;
    // 全局流：只认自己那一族帧（见文件头第 1 条），重连补读由 hub 统一通知。
    // 环境没有 EventSource 时退化为「只在挂载时读一次」：不抛、也不影响页面——
    // 与既有两条信号流同一条兜底口径
    return subscribeGlobalStream({
      onFrame: (frame) => {
        if (frame.type === 'inject-messages-changed') void mutateRef.current();
      },
      onReconnect: () => void mutateRef.current(),
    });
  }, [active]);

  /**
   * 一个写动作的公共外壳：置忙 → 发请求 → **成败都重读快照** → 清忙。
   *
   * 成败都读的理由见文件头第 3 条：失败那一次也可能改变了表（撤回撞上「已经交给模型了」时
   * 那一条会落 `consumed` 并带上原因），不读就会一直显示旧的 `delivered`。
   */
  const run = useCallback(
    async <T,>(action: () => Promise<T>): Promise<T> => {
      setBusyCount((count) => count + 1);
      try {
        const result = await action();
        await mutateRef.current();
        return result;
      } catch (cause) {
        // 重读失败不该盖住原始错误（那才是用户要读的那一句）
        await mutateRef.current().catch(() => undefined);
        throw cause;
      } finally {
        setBusyCount((count) => count - 1);
      }
    },
    [],
  );

  const send = useCallback(
    (request: InjectMessageSendRequest) => run(() => postInjectMessage(request)),
    [run],
  );
  const promote = useCallback(
    (messageId: string) => run(() => postInjectMessagePromote({ runId, rowId, messageId })),
    [run, runId, rowId],
  );
  const retract = useCallback(
    (messageId: string) => run(() => postInjectMessageRetract({ runId, rowId, messageId })),
    [run, runId, rowId],
  );
  const uploadAttachment = useCallback(
    (messageId: string, file: File) => run(() => postInjectAttachment({ runId, rowId, messageId, file })),
    [run, runId, rowId],
  );

  return {
    messages: data ?? EMPTY_MESSAGES,
    isLoading,
    error,
    refresh,
    send,
    promote,
    retract,
    uploadAttachment,
    busy: busyCount > 0,
  };
}

/** 空数组常量：稳定身份，免得下游 memo 每次渲染都失效 */
const EMPTY_MESSAGES: InjectMessage[] = [];
