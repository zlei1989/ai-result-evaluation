/**
 * 卡片底部那一候选的**实时打字内容**：订阅 AgentMessage 的内容流，折叠成
 * 「这一刻该显示什么」。
 *
 * 为什么与 `useCandidateMessages` 分开（而不是复用它）：抽屉那条要的是**全量对话**（几百条记录、
 * 每次连接回放全量），而这里只要「最新一条消息里最后那个可显示的块」。
 * 两条流的**传输**也是分开的：这一路走整轮共享的**聚合流**（与实时指标那一路同一条连接），
 * 抽屉走单行单 channel 的抽屉流——一屏 6 个候选各开一条抽屉级连接，等于为一句文案把几十 MB
 * 搬进浏览器。
 *
 * 四条口径：
 * 1. **不回放历史**：历史里没有增量，而活动行要的正是「此刻」——所以这一路注册时不带游标
 * （URL 上没有 `?after=`），服务端只推实时增量。刷新之后的静态内容由既有那一路
 * `log.summary` 兜底——两层合起来才是「实时优先、历史兜底」，而不是「实时没有就空着」。
 * 2. **按候选状态挑 channel**：`judging` 看**评分**那条，其余看候选那条（两条都收会让活动行
 * 在评分阶段被候选的残留内容占住）。挑的是**帧**：两条 channel 的消息都在同一条连接上。
 * 3. **终态即不订**（与 `useRunLiveMetrics` 同口径）：候选跑完了这一路就收起，不必再折它的帧。
 * 4. **合并到一帧发布一次**：delta 帧服务端已按 16ms 合并，但 6 行同时打字仍会是每帧多次 setState；
 * 这里把一帧内所有候选的变化攒到一次提交（与 `useCandidateMessages` 同一条理由与写法）。
 *
 * 与 `useRunLiveMetrics` 的分工：那边折的是**事件**（tok / 轮次 / log 摘要），这边折的是**消息**。
 * 活动行把两者叠起来用：消息流有内容就以它为准，没有就回落到事件流折出来的 `log.summary`。
 */
import { useEffect, useState } from 'react';
import {
  TERMINAL_CANDIDATE_STATUSES,
  type AgentMessage,
  type EvalCandidateStatus,
  type CandidateChannelMessageFrame,
  type RunStreamFrame,
} from '@aieval/contracts';
import { looksLikeMachinePayload } from './candidate-live';
import { isCandidateRecordFrame, subscribeRunStream } from './run-stream-hub';

/**
 * 活动行此刻该显示什么。
 * 三格互斥：`text` 有值 = 正在打字的正文；`toolSummary` 有值 = 最近一次工具调用；
 * 两者都是 `null` = 这一刻没有可显示的内容（界面回落到 `log.summary` / 状态文案）。
 */
export interface CandidateActivity {
  /** 正文（text 块的**累积**文本；服务端每次回吐的是「到目前为止的完整块」）。null = 没有正文在流 */
  text: string | null;
  /** 这一条逻辑消息**收尾了没有**：`false` ⇒ 还在写，界面挂闪烁光标（判据只有 `message.assembly`） */
  streaming: boolean;
  /** 工具块的**一句话摘要**（`tool-call.summary`，由适配器生成）；null = 这一刻没有工具活动 */
  toolSummary: string | null;
}

/** 「这一刻没有可显示的内容」——同一份常量，免得每次返回新对象把「没变」判成「变了」 */
export const EMPTY_ACTIVITY: CandidateActivity = { text: null, streaming: false, toolSummary: null };

/**
 * 一条消息里**最后那个可显示的块**决定了活动行显示什么。
 *
 * 为什么从后往前找：一条消息可以有多个块（正文 → 工具调用 → 工具结果），活动行回答的是
 * 「此刻在做什么」，而**块数组的顺序就是发生顺序**。
 * · `text` → 打字内容（空串跳过：真机见过 `text: ''` 的增量，显示成空白比停在上一条更糟）；
 * · `tool-call` → 摘要（*服务端算好的那一格**；老数据没有它时回落到「调用工具 <名字>」，
 * 与 `activity.ts` 的 `toolCallSummary` 同一句话）；
 * · `thinking` / `tool-result` / 附件 → **不给活动文案**（：工具成功返回、推理
 * 都不占这个候选），继续往前找；都没有就返回「没有内容」。
 */
export function activityOfMessage(message: AgentMessage): CandidateActivity {
  for (let index = message.blocks.length - 1; index >= 0; index -= 1) {
    const block = message.blocks[index];
    if (block === undefined) continue;
    if (block.type === 'text') {
      if (block.text === '') continue;
      /**
       * **机器负载不当消息**：评分阶段的正文就是那坨评分结果 JSON
       * （真机 `judge-messages.jsonl` 最后一条逐字是 `{"judgments":[{"id":"A1",…`），照打就是
       * 拿 JSON 冒充消息——口径与 `log.summary` 那道闸**同一份判据**
       *（`row-live.ts` 的 `looksLikeMachinePayload`，这里不重写一遍）。
       * 跳过它继续往前找：前面可能还有工具摘要或人话；都没有就回落到 `log.summary` 那一档。
       */
      if (looksLikeMachinePayload(block.text)) continue;
      return { text: block.text, streaming: message.assembly === 'open', toolSummary: null };
    }
    if (block.type === 'tool-call') {
      return { text: null, streaming: false, toolSummary: toolSummaryOf(block) };
    }
  }
  return EMPTY_ACTIVITY;
}

/** 工具块的一句话：优先用适配器算好的 `summary`（老数据缺这一格），缺了就用名字兜一句 */
function toolSummaryOf(block: Extract<AgentMessage['blocks'][number], { type: 'tool-call' }>): string {
  if (block.summary !== undefined && block.summary !== '') return block.summary;
  const name = block.name.trim();
  return name === '' ? '调用工具' : `调用工具 ${name}`;
}

/** 一行订阅哪个 channel：评分阶段看评审者那条；终态**不订阅**（这个候选已经收起） */
function channelOf(status: EvalCandidateStatus): 'candidate' | 'judge' | null {
  if (status === 'judging') return 'judge';
  if (TERMINAL_CANDIDATE_STATUSES.includes(status)) return null;
  return 'candidate';
}

/**
 * 一帧算不算活动内容：消息帧（`subagent` 候选是派发视图的原料，不占卡片底部那一行）折出
 * 「这一刻该显示什么」，其余帧一律 `null`。
 * **信封解析与坏帧丢弃在 hub 那一层**（`run-stream-hub.ts` 的 `parse`）：一条畸形帧
 * 在那里就被丢掉了，到不了这里——本函数只管「这一帧属于活动行吗」。
 */
export function activityOfFrame(frame: RunStreamFrame): CandidateActivity | null {
  if (!isCandidateRecordFrame(frame) || frame.type !== 'message') return null;
  return activityOfMessage(frame.message);
}

/** 界面要的一行输入（调用方给快照里的候选状态，本 hook 据此选流） */
export interface ActivityCandidateInput {
  id: string;
  status: EvalCandidateStatus;
}

/**
 * 订阅若干候选的实时活动内容，返回 `候选 id → 活动`。
 * 只订阅在跑的行（终态由 `channelOf` 挡掉），且向**整轮共享**的聚合流注册一个 sink：
 * 多条候选的消息在同一条连接上，靠帧里的 `candidateId` / `candidateChannel` 分流（与 `useRunLiveMetrics`
 * 同口径：详情页一屏最多几行，而列表页有几十轮）。
 */
export function useRunActivity(input: { runId: string; candidates: readonly ActivityCandidateInput[] }): Record<string, CandidateActivity> {
  const { runId } = input;
  // 候选的集合与**阶段**都要进依赖：阶段一变（running → judging）就得换一批帧来折，
  // 数组每帧都是新引用 ⇒ 拼成稳定的键（与 `useRunLiveMetrics` 的 rowKey 同一条理由）
  const rowKey = input.candidates.map((row) => `${row.id}:${channelOf(row.status) ?? 'none'}`).join(',');
  const [activities, setActivities] = useState<Record<string, CandidateActivity>>({});

  useEffect(() => {
    if (runId === '' || rowKey === '') {
      setActivities({});
      return;
    }
    const targets = rowKey
      .split(',')
      .map((entry) => {
        const [id = '', channel = ''] = entry.split(':');
        return { id, channel: channel === 'judge' ? ('judge' as const) : channel === 'candidate' ? ('candidate' as const) : null };
      })
      .filter((one): one is { id: string; channel: 'candidate' | 'judge' } => one.channel !== null && one.id !== '');
    if (targets.length === 0) {
      setActivities({});
      return;
    }

    let cancelled = false;
    /** 行 → 这一阶段该折的 channel（`judging` 的行只收评审者那条） */
    const channelByCandidate = new Map(targets.map((target) => [target.id, target.channel]));
    /** 一帧内各候选的最新活动：攒到下一次提交一起写进 state（口径 4） */
    const pending = new Map<string, CandidateActivity>();
    /** 上一次**发布出去**的活动（候选 id → 活动）：只用来压掉「内容没变」的帧 */
    const published = new Map<string, CandidateActivity>();
    let frame: number | null = null;
    // 目标集合变了就清空旧值：留着已经不在订阅里的行，界面会拿旧内容当当前值
    setActivities({});

    const flush = (): void => {
      frame = null;
      if (cancelled || pending.size === 0) return;
      const batch = [...pending];
      pending.clear();
      for (const [candidateId, activity] of batch) published.set(candidateId, activity);
      setActivities((previous) => {
        const next = { ...previous };
        for (const [candidateId, activity] of batch) next[candidateId] = activity;
        return next;
      });
    };

    /**
     * `requestAnimationFrame` 在**后台标签页里会暂停**，而流不会停——不兜底就是「后台攒一大坨、
     * 切回来卡一下」，故用定时器兜住同一帧（与 `useCandidateMessages` 逐字同一条理由）。
     */
    const schedule = (): void => {
      if (frame !== null) return;
      frame =
        typeof requestAnimationFrame === 'function'
          ? requestAnimationFrame(flush)
          : (setTimeout(flush, 16) as unknown as number);
    };

    /** 活动内容是否与上一次发布的一模一样（一样就不必惊动 React：delta 帧里大量重复投递） */
    const same = (left: CandidateActivity | undefined, right: CandidateActivity): boolean =>
      left !== undefined && left.text === right.text && left.streaming === right.streaming && left.toolSummary === right.toolSummary;

    /** 这一帧归不归本 sink：消息帧、行在订阅集合里、且 channel 与那一行当前阶段对得上 */
    const matches = (candidate: RunStreamFrame): candidate is CandidateChannelMessageFrame =>
      isCandidateRecordFrame(candidate) && channelByCandidate.get(candidate.candidateId) === candidate.candidateChannel;

    const handleFrame = (candidate: RunStreamFrame): void => {
      if (cancelled || !matches(candidate)) return;
      const next = activityOfFrame(candidate);
      if (next === null) return;
      const candidateId = candidate.candidateId;
      if (same(published.get(candidateId) ?? pending.get(candidateId), next)) return;
      pending.set(candidateId, next);
      schedule();
    };

    const unsubscribe = subscribeRunStream({ runId, sink: { match: matches, onFrame: handleFrame } });

    return () => {
      cancelled = true;
      unsubscribe();
      if (frame !== null) {
        if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame);
        else clearTimeout(frame);
        frame = null;
      }
    };
  }, [rowKey, runId]);

  return activities;
}
