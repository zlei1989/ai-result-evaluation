/**
 * 追问的**数据层**（第二期：对已经跑过的候选补一句话，接着同一段会话再跑一段）。
 *
 * 两块，各一条路由：
 *   · **可用性读侧**（`GET /api/follow-up/availability?runId=…`）：整轮一行一条结论
 *     （能不能追问 + 不可行的中文原因）。它是**界面入口的唯一判据来源**——七档拒绝里有一半的
 *     事实（工作区还在不在 / 用例还在不在 / 这一家的声明）在盘上与厂商声明上，浏览器一格都看不到，
 *     界面自己编一句就是第二份说法；
 *   · **写侧**（`POST /api/follow-up`）：一句话 + 附件清单，回这一轮的快照。
 *
 * 三条与 `inject-messages.ts`（同一族的另一条路）刻意不同的地方：
 *   1. **没有信号流、也没有队列**：追问不是「排队等取件」，它当场起一段，进度由轮级信号与
 *      候选级流驱动（`useRun` 那一套已经在页面上）。故这里没有 `EventSource`，也没有快照重读；
 *   2. **写侧回写详情与列表两个键**（与 `useRescoreCandidate` / `useRetryCandidate` 逐字同形）：
 *      「这个候选立刻变成准备中」必须同时被两处看到；
 *   3. **可用性读侧要在候选状态变化时重读**：判据的前两档（正在跑 / 上一次没收尾）随候选的状态翻转，
 *      而这一条读侧不挂任何信号流。故 `useFollowUpAvailability` 收一个 `revision`
 *      （调用方把「会改变判据的那几格」拼成一个字符串传进来）：它一变就重读，
 *      而**旧值照旧显示**（SWR 的 `keepPreviousData`）——不重读的代价是入口的禁用态永远停在
 *      第一次渲染那一刻（症状是「候选跑完了，追问按钮还是灰的」）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import useSWR, { useSWRConfig } from 'swr';
import type { EvalRun, FollowUpAvailability, FollowUpRequest, FollowUpVerdict } from '@aieval/contracts';
import { getJson, postJson } from './http';
import { RUNS_KEY, runKey } from './run-keys';

/** 追问的写侧端点（请求体即契约里的 `FollowUpRequestSchema`） */
export const FOLLOW_UP_URL = '/api/follow-up';
/** 可用性读侧端点（定位走查询参数，照人工消息快照那一格） */
export const FOLLOW_UP_AVAILABILITY_URL = '/api/follow-up/availability';

/** 一轮的可用性地址（SWR 键）：换轮即换键 */
export function followUpAvailabilityUrl(runId: string): string {
  return `${FOLLOW_UP_AVAILABILITY_URL}?runId=${encodeURIComponent(runId)}`;
}

/**
 * 发一条追问。**同步拿到「已经在准备中」的快照**（与 `rescoreCandidate` 同一形状）：追问是分钟级的，
 * 进度交给轮级信号与候选级流；拒绝（409 这个候选接不上 / 400 请求不合法 / 404 行不存在）
 * 抛 `ServiceError`，中文原因由调用方直接展示。
 */
export function postFollowUp(request: FollowUpRequest): Promise<EvalRun> {
  return postJson<EvalRun>(FOLLOW_UP_URL, request);
}

export interface UseFollowUpAvailabilityInput {
  runId: string;
  /** 闸门：抽屉没开 / 没有选中轮次时不发请求 */
  enabled: boolean;
  /**
   * 判据的**版本串**：调用方把「会改变追问判据的那几格」拼进来
   * （候选的状态与会话 id、用例是否还在），一变就重读。
   * 不给 = 只在挂载时读一次（调用方自己不关心候选状态变化时的重读）。
   */
  revision?: string;
}

export interface UseFollowUpAvailabilityResult {
  /** 按候选 id 取这个候选的结论；`undefined` = **还没有这个候选的判据**（未加载 / 读失败） */
  verdictOf: (candidateId: string) => FollowUpVerdict | undefined;
  isLoading: boolean;
  error: unknown;
  /** 手动重读（追问发出之后、或调用方自己知道判据变了） */
  refresh: () => Promise<void>;
}

/** 空表常量：稳定身份，免得下游 memo 每次渲染都失效 */
const EMPTY_VERDICTS: Readonly<Record<string, FollowUpVerdict>> = {};

/**
 * 订阅一轮的追问可用性。
 *
 * `revision` **不进 SWR 键**（那会把它当成查询参数发给服务端，也会把缓存切成一堆条目），
 * 它驱动的是一次 `mutate()`：值变了就重读，而**旧值照旧显示**（SWR 重验期间保留上一份数据）
 * ——不重读的代价是入口的禁用态永远停在第一次渲染那一刻（症状是「候选跑完了，追问按钮还是灰的」）。
 * 首次挂载不补读：那是同一瞬间刚发出去的那一次请求。
 */
export function useFollowUpAvailability(
  input: UseFollowUpAvailabilityInput,
): UseFollowUpAvailabilityResult {
  const { runId, enabled, revision = '' } = input;
  const active = enabled && runId !== '';
  const key = active ? followUpAvailabilityUrl(runId) : null;
  const { data, error, isLoading, mutate } = useSWR<FollowUpAvailability>(key, getJson);

  /** 上一次据以重读的版本串：与当前相同就不重复请求（挂载那一拍也不补读） */
  const lastRevision = useRef(revision);
  useEffect(() => {
    if (!active) return;
    if (lastRevision.current === revision) return;
    lastRevision.current = revision;
    void mutate();
  }, [active, revision, mutate]);

  const byCandidateId = ((): Readonly<Record<string, FollowUpVerdict>> => {
    if (data === undefined) return EMPTY_VERDICTS;
    const map: Record<string, FollowUpVerdict> = {};
    for (const { candidateId: id, verdict } of data.candidates) map[id] = verdict;
    return map;
  })();

  const verdictOf = useCallback((candidateId: string): FollowUpVerdict | undefined => byCandidateId[candidateId], [byCandidateId]);

  return {
    verdictOf,
    isLoading,
    error,
    refresh: async (): Promise<void> => {
      await mutate();
    },
  };
}

/**
 * 追问（写侧）。回写两个键与本包其它写操作同形——「状态立刻变成准备中」这件事必须同时被
 * 详情与列表看到。`isFollowingUp` 只用于**转圈与禁用**（避免连点两次）；它不参与可用性判据，
 * 那个判据是服务端的可用性读侧（与真追问同一份 `canFollowUpCandidate`，见那个函数的注释）。
 */
export function useFollowUpCandidate(): {
  followUpCandidate: (request: FollowUpRequest) => Promise<EvalRun>;
  isFollowingUp: boolean;
} {
  const { mutate } = useSWRConfig();
  const [isFollowingUp, setFollowingUp] = useState(false);

  const followUpCandidate = useCallback(
    async (request: FollowUpRequest): Promise<EvalRun> => {
      setFollowingUp(true);
      try {
        const run = await postFollowUp(request);
        await mutate(runKey(request.runId), run, { revalidate: false });
        await mutate(RUNS_KEY);
        return run;
      } finally {
        setFollowingUp(false);
      }
    },
    [mutate],
  );

  return { followUpCandidate, isFollowingUp };
}
