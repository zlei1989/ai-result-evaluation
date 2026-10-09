/**
 * 评测数据层：列表 / 详情 / 创建 / 启动 / 终止 / 产物读取 / 候选池。
 * 三条约定：
 *   1. **加键在这里，不在页面里**：`/api/runs` 与 `/api/runs/{id}` 被本文件的取数 hook 与
 *      `row-stream.ts` 共用（终态后要 mutate 的就是这两个键），字面量散落必然漂移；
 *   2. **实时性由 run 信号驱动，轮询只剩慢兜底**（用户口径 2026-10-08「不要来回刷新」）：
 *      `useRunEvents`（`run-events.ts`）订阅 `/api/runs/events`，服务端每落盘一次快照
 *      就推一条 `run-updated`，客户端收到即重验列表与详情——状态翻转是毫秒级的
 *      「变了才读」，而不再是每 3 秒问一次。慢兜底（60 秒）只在「还有活在跑」时
 *      开着，给「信号通道万一断了」兜底；`refreshInterval` 传**数字**而不是函数的
 *      理由不变（函数形式每帧都是新引用，SWR 的轮询 effect 会反复重挂、计时器被
 *      反复重置——而跑着的评测正是页面重渲染最频繁的时候），间隔走 state 镜像，
 *      见 `useFallbackRun`；
 *   3. mutation 成功后写缓存 + `revalidate:false`，再显式刷新列表（契约 §7 的回写约定）。
 *      这里没用 `useSWRMutation`：启动/终止的响应要同时写进**详情**与**列表**两个键，
 *      而它只绑定一个键，用了还得再手写一次 mutate——不如从一开始就用 `useSWRConfig().mutate`。
 *      顺带一个结构性好处：runId 是**调用时**才拿到的，这些写操作因此根本没被挂进 SWR 的
 *      fetcher，「窗口重新获得焦点 ⇒ 重发一次写请求」这条 p2 踩过的坑在形状上就不存在
 *      （`runs.test.tsx` 的「焦点重验」一节把它钉住，防的是将来有人改写成 SWR 挂载式）。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import useSWR, { useSWRConfig } from 'swr';
import {
  isRunningRow,
  type AgentKind,
  type EvalRun,
  type MessageCapability,
  type ProtocolType,
  type ProviderModel,
  type RowDiffFile,
  type RowDiffIndex,
  type RunCreate,
  type RunUpdate,
  type AgentEvent,
} from '@aieval/contracts';
import { useRunEvents } from './run-events';
import { RUNS_KEY, runKey } from './run-keys';
import { delJson, getJson, postJson, putJson } from './http';

// 键的真源在 `run-keys.ts`（叶子模块）；这里 re-export 是为了让三条行级流与页面的
// 既有 import 路径一律不动（它们都从 './runs' 拿键）。
export { RUNS_KEY, runKey };

/**
 * 一行的产物端点（diff / log / stream / messages 同前缀）——SSE 与两处按需读取共用，免得字面量三份。
 * `query` 由调用方给（含 `?`），本函数只负责拼，不解释语义。
 */
export function runRowUrl(runId: string, rowId: string, artifact: 'diff' | 'log' | 'stream' | 'messages' | 'messages/stream', query = ''): string {
  return `${runKey(runId)}/rows/${rowId}/${artifact}${query}`;
}

/**
 * 一行的**消息流**端点（`/messages/stream`）：内容级 SSE，与行级事件流并行。
 * 单独一个函数而不复用 `runRowUrl` 的查询串：这条流**没有 `afterSeq` 续订**——
 * 它每次连接都回放全量，客户端按 `mergeKey` 覆盖累积（**不按 `messageId` 去重**）。
 * 拼错一个 query 不会报错，只会静默拿到一份对不上的视图。
 */
export function runRowMessagesStreamUrl(runId: string, rowId: string): string {
  return runRowUrl(runId, rowId, 'messages/stream');
}

/** 候选池与能力元数据的端点（见计划「修正 2/3」） */
export const AGENT_OPTIONS_KEY = '/api/runs/model-options';

/**
 * 慢兜底间隔（毫秒）：**不是**实时通道，只是「信号万一断了」的保险网——
 * EventSource 自带断线重连、SWR 保留焦点重验，正常情况这条永远不触发。
 * 60 秒的量级：短到「信号断了一分钟内状态仍然会收敛」，长到「即便真断了也不构成打扰」。
 */
const RUN_FALLBACK_POLL_MS = 60_000;

/** 一轮「还有活在跑」：轮级 status 与行级状态都要看——编排层翻转轮状态有一拍延迟 */
function isLiveRun(run: EvalRun): boolean {
  return run.status === 'running' || run.rows.some((row) => isRunningRow(row.status));
}

/**
 * 「还有活在跑 ⇒ 每 60 秒慢兜底一次，跑完立刻停」的取数（列表与详情共用一份口径）。
 *
 * 实时性不靠这条：状态翻转由 `useRunEvents` 的信号驱动（文件头约定 2），这里的
 * `refreshInterval` 只是信号通道全断时的保险网。
 *
 * 间隔走 state 镜像而不是直接读 `data`：`data` 是 `useSWR` 的返回值，在它自己的 options 里
 * 引用它是 TDZ 报错；而函数形式（`refreshInterval: (latest) => …`）每帧都是新引用，会让 SWR 的
 * 轮询 effect 每帧重挂并重置计时器——SSE 每来一条事件就重渲染一次，兜底反而永远触发不了。
 * 用 state 镜像后间隔只在「有/没有活在跑」翻转时变一次，SWR 见间隔变了就重新调度（0 ⇒ 停）。
 */
function useFallbackRun<T>(
  key: string | null,
  isLive: (data: T) => boolean,
): ReturnType<typeof useSWR<T>> {
  const [pollMs, setPollMs] = useState(0);
  const response = useSWR<T>(key, getJson, { refreshInterval: pollMs });
  const live = response.data !== undefined && isLive(response.data);
  useEffect(() => {
    setPollMs(live ? RUN_FALLBACK_POLL_MS : 0);
  }, [live]);
  return response;
}

export function useRuns(): { runs: EvalRun[] | undefined; error: unknown; isLoading: boolean; refresh: () => void } {
  // 列表的重验也由信号驱动（`currentRunId` 缺省 = 只重验列表键）：连接是模块级单例，
  // 与下面 useRun 的订阅共用同一条——页面上无论挂几个 hook，`/api/runs/events` 只有一条
  const { data, error, isLoading, mutate } = useFallbackRun<EvalRun[]>(RUNS_KEY, (runs) => runs.some(isLiveRun));
  useRunEvents({});
  return { runs: data, error, isLoading, refresh: () => void mutate() };
}

export function useRun(id: string | null): {
  run: EvalRun | undefined;
  error: unknown;
  isLoading: boolean;
  refresh: () => void;
} {
  // 行级 SSE 覆盖逐行的计量跳动；轮级状态与排名的收敛由信号（saveRun 落盘即推）驱动重验，
  // 60 秒慢兜底让「信号通道万一断掉」也不会永久停在「执行中」
  const { data, error, isLoading, mutate } = useFallbackRun<EvalRun>(
    id === null ? null : runKey(id),
    isLiveRun,
  );
  // 详情打开时才把详情键并进重验范围（currentRunId 为 null 时列表页只重验列表）
  useRunEvents({ currentRunId: id });
  return { run: data, error, isLoading, refresh: () => void mutate() };
}

/**
 * 候选池里的一个模型：与 api 的 `AgentModelOption`（`packages/server/api/src/runs.ts`）**逐字段**一致
 * （client 不能 import api，故此处重复声明）。
 *
 * 两半接缝各有各的守卫，**别把其中一条读成两条都管**（2026-10-06 fix 轮的审查更正）：
 *   · **api 侧的响应形状**由 `apps/web-next/src/route-runs.test.ts` 钉死（它直接断言响应里
 *     `options[0]` 的键集合）——api 偷偷加/改名一格，那里当场红；
 *   · **本接口这三格**由 `runs.test.tsx` 的那条形状用例钉住：对象字面量赋给 `AgentModelOption`
 *     会走**多余属性检查**，少一格就直接 tsc 报错。为什么非要在 client 侧再钉一条：从这里删掉
 *     `efforts` 时路由测试**照样绿**（它管的是 JSON，不是这个接口），而所有消费点传的都是函数值、
 *     三格又全是可选的 ⇒ 结构类型下「少一格」天然可赋值，**tsc 与测试都不会响**。
 *
 * 后三格**必须在这里声明**（2026-10-06 fix 轮补上）：api 是按「有意义才出现」投影的
 * （缺省 = 窗口未知 / 无可选档 / 上游没推荐），表现是界面**静默**丢掉那一格：少 `efforts` 时
 * 创建表单的「思考强度」下拉永远是空的（面板读的正是它），而没有任何一处会报错。
 */
export interface AgentModelOption {
  providerId: string;
  providerName: string;
  modelId: string;
  source: ProviderModel['source'];
  /** 上下文窗口（token）；缺省 = 未知（界面显示「未知」，绝不兜底一个数字） */
  contextWindow?: number;
  /**
   * 该组合**可选**的思考强度档位（api 已把上游声明的档位与本行智能体的档位域求过交；
   * 上游未声明 ⇒ 该家完整档位域）。**该家能收关闭档、且交集里还没有它时**，关闭档会被并入并排在
   * 首位（上游自己已声明 `off` 时保留上游顺序）；缺省 = 一个档位都没有。
   */
  efforts?: string[];
  /** 上游推荐档；**只在它落在 `efforts` 里时**才有值（界面据此在标签上标「推荐」、不预选，spec D14） */
  recommendedEffort?: string;
}

/**
 * 一种智能体的能力元数据 + 候选池：与 api 的 `AgentOptionGroup` 逐字段一致。
 * client 不能 import api，所以这份形状在两侧各声明一次；**字段集合由路由测试钉死**
 * （见 Task 10：断言响应对象的键集合），**本接口自己那一半**由 `runs.test.tsx` 的接缝形状用例钉住
 * ——路由测试读的是 JSON，把某一格从这里删掉它照样绿（两边都钉才叫接缝）。
 */
export interface AgentOptionGroup {
  agentKind: AgentKind;
  /** 该智能体接受的协议**集合**（服务端来自 agents 注册表；DSH 两条 wire ⇒ 两个元素） */
  protocolTypes: readonly ProtocolType[];
  usage: boolean;
  cancelMidTurn: boolean;
  /**
   * 该智能体能收的思考强度**档位域**（服务端来自 agents 注册表的 `metadata.reasoningEfforts`）。
   *
   * 谁在用它：设置页「评分配置」里「思考强度」的候选 = 模型声明 ∩ **这一格**——判据与后端
   * `requireJudgeEffort` 是同一个 `intersectEfforts`。少这一格，卡片只能兜规范五档，
   * dsh 收不了的 `medium` 就会摆上界面并被存进设置，直到生成 / 识别时被硬拒
   * （2026-10-07 Task 12 补上；此前 api 一直在发，只有这份重复声明的形状漏了它）。
   */
  efforts: readonly string[];
  /**
   * 「未选档位」时该家**实际会用的档**（服务端来自 agents 注册表的 `metadata.defaultEffort`）；
   * 缺省 = 这家不声明（由厂商推断默认档）。
   *
   * 谁在用它：创建表单「思考强度」的占位符——那句「未指定（DeepSeek Harness 用 high）」里的
   * 厂商名与档位**都由这一格拼出来**，UI 不再写死（写死就是第二份真源：厂商名或缺省档改了，
   * 占位符仍会静默说错）。同 `efforts` 那条：这一格漏声明时 tsc 与测试都不会响，界面只是
   * 静默退回一句泛化的「未指定」——故路由测试按「有意义才出现」把它钉在键集合里。
   */
  defaultEffort?: string;
  /**
   * 消息能力声明（spec v3 §2.5）：五格各带 `source` / `reason`，外加 `notes`。
   *
   * **逐格原样来自服务端**（api 从 agents 注册表元数据透出）。数据层不许裁剪、也不许在这一层
   * 补默认值：界面那四句「这家结构上不支持 / 厂商没投送 / 我们没接 / 没验证过」全靠它，
   * 缺一格就会被读成「没有这个能力」。取不到时 `messageCapabilityOf` 给 `null`，
   * **不是**一份编出来的「都支持」——具体理由见那个投影的注释。
   */
  messageCapability: MessageCapability;
  options: AgentModelOption[];
}

export function useCreateRun(): { create: (input: RunCreate) => Promise<EvalRun>; isCreating: boolean } {
  const { mutate } = useSWRConfig();
  const [isCreating, setCreating] = useState(false);

  const create = useCallback(
    async (input: RunCreate): Promise<EvalRun> => {
      setCreating(true);
      try {
        const run = await postJson<EvalRun>(RUNS_KEY, input);
        // 新建的轮直接进详情缓存（revalidate:false，避免紧接的 GET 用旧值覆盖），再刷新列表让它出现在最前
        await mutate(runKey(run.id), run, { revalidate: false });
        await mutate(RUNS_KEY);
        return run;
      } finally {
        setCreating(false);
      }
    },
    [mutate],
  );

  return { create, isCreating };
}

/**
 * 编辑一轮评测（「修改」）：PUT 全量可变字段 → 回写详情与列表两个键。
 * 形状与本文件其它写操作逐字相同（见文件头约定 3）：手工 `mutate`、`revalidate: false`、
 * 再显式刷新列表——缺任何一处都会出现「详情新、列表旧」。
 * 入参**原样**送上线（不挑字段、不补默认值）：`rows[].id`（原地更新这一行、保留它的结果）
 * 与 `rows[].effort`（思考强度）都是服务端要读的字段，钩子在中间重抄一遍就会静默丢字段。
 * `isUpdating` 只用于按钮转圈与禁用；可用性判据是 contracts 的 `hasLiveRows`，与服务端同一份。
 */
export function useUpdateRun(): {
  update: (runId: string, input: RunUpdate) => Promise<EvalRun>;
  isUpdating: boolean;
} {
  const { mutate } = useSWRConfig();
  const [isUpdating, setUpdating] = useState(false);

  const update = useCallback(
    async (runId: string, input: RunUpdate): Promise<EvalRun> => {
      setUpdating(true);
      try {
        const run = await putJson<EvalRun>(runKey(runId), input);
        // revalidate:false：响应就是最新值，再拉一次只会多一次请求，还可能被慢响应覆盖成旧值
        await mutate(runKey(runId), run, { revalidate: false });
        await mutate(RUNS_KEY);
        return run;
      } finally {
        setUpdating(false);
      }
    },
    [mutate],
  );

  return { update, isUpdating };
}

/**
 * 删除一轮评测：清掉详情缓存（照 `useDeleteCase` 的口径）+ 刷新列表。
 * 响应里的 `workspaceRemoved` 必须原样交给页面：`false` = 磁盘上的行工作区没能回收，
 * 界面要如实说出来（不假装干净，也不把「回收失败」说成「删除失败」）。
 */
export function useDeleteRun(): {
  remove: (runId: string) => Promise<{ workspaceRemoved: boolean }>;
  isDeleting: boolean;
} {
  const { mutate } = useSWRConfig();
  const [isDeleting, setDeleting] = useState(false);

  const remove = useCallback(
    async (runId: string): Promise<{ workspaceRemoved: boolean }> => {
      setDeleting(true);
      try {
        const result = await delJson<{ workspaceRemoved: boolean }>(runKey(runId));
        // 删掉的详情缓存必须清掉：留着它，改回同一个 URL 时会先渲染一条已经不存在的轮次
        await mutate(runKey(runId), undefined, { revalidate: false });
        await mutate(RUNS_KEY);
        return result;
      } finally {
        setDeleting(false);
      }
    },
    [mutate],
  );

  return { remove, isDeleting };
}

export function useStartRun(): { start: (runId: string) => Promise<EvalRun>; isStarting: boolean } {
  const { mutate } = useSWRConfig();
  const [isStarting, setStarting] = useState(false);

  const start = useCallback(
    async (runId: string): Promise<EvalRun> => {
      setStarting(true);
      try {
        const run = await postJson<EvalRun>(`${runKey(runId)}/start`, {});
        await mutate(runKey(runId), run, { revalidate: false });
        await mutate(RUNS_KEY);
        return run;
      } finally {
        setStarting(false);
      }
    },
    [mutate],
  );

  return { start, isStarting };
}

export function useAbortRun(): { abort: (runId: string) => Promise<EvalRun>; isAborting: boolean } {
  const { mutate } = useSWRConfig();
  const [isAborting, setAborting] = useState(false);

  const abort = useCallback(
    async (runId: string): Promise<EvalRun> => {
      setAborting(true);
      try {
        const run = await postJson<EvalRun>(`${runKey(runId)}/abort`, {});
        await mutate(runKey(runId), run, { revalidate: false });
        await mutate(RUNS_KEY);
        return run;
      } finally {
        setAborting(false);
      }
    },
    [mutate],
  );

  return { abort, isAborting };
}

export function useAbortRow(): {
  abortRow: (runId: string, rowId: string) => Promise<EvalRun>;
  isAborting: boolean;
} {
  const { mutate } = useSWRConfig();
  const [isAborting, setAborting] = useState(false);

  const abortRow = useCallback(
    async (runId: string, rowId: string): Promise<EvalRun> => {
      setAborting(true);
      try {
        const run = await postJson<EvalRun>(`${runKey(runId)}/rows/${rowId}/abort`, {});
        await mutate(runKey(runId), run, { revalidate: false });
        await mutate(RUNS_KEY);
        return run;
      } finally {
        setAborting(false);
      }
    },
    [mutate],
  );

  return { abortRow, isAborting };
}

/**
 * 重新评分：只重跑评分步骤（spec §9）。回写两个键与本文件其它写操作同形——
 * 「状态立刻变成 judging」这件事必须同时被详情与列表看到。
 * `isRescoring` 在界面上只用于**转圈与禁用**（避免连点两次）；它不参与可用性判据，
 * 那个判据是 contracts 的 `canRescoreRow`，与服务端同一份。
 */
export function useRescoreRow(): {
  rescoreRow: (runId: string, rowId: string) => Promise<EvalRun>;
  isRescoring: boolean;
} {
  const { mutate } = useSWRConfig();
  const [isRescoring, setRescoring] = useState(false);

  const rescoreRow = useCallback(
    async (runId: string, rowId: string): Promise<EvalRun> => {
      setRescoring(true);
      try {
        const run = await postJson<EvalRun>(`${runKey(runId)}/rows/${rowId}/rescore`, {});
        await mutate(runKey(runId), run, { revalidate: false });
        await mutate(RUNS_KEY);
        return run;
      } finally {
        setRescoring(false);
      }
    },
    [mutate],
  );

  return { rescoreRow, isRescoring };
}

/**
 * 单行**执行**（内部名仍是 retry；界面文案按行态分叉：没跑过 = 「开始执行」、跑过 = 「重新执行」）：
 * 只跑这一行（候选 agent + 评分），本轮其他行一律不动——2026-09-29 用户口径
 * 「只执行当前候选项，不要完成后重新执行下方已经执行过的候选项」。
 * 与 `useRescoreRow`（只重跑评分）是同一个形状、不同的端点。回写两个键的理由与其它写操作一样：
 * 状态立刻变成 `preparing` 这件事必须同时被详情与列表看到。
 * `isRetrying` 只用于按钮转圈与禁用；可用性判据是 contracts 的 `canRunRow`（**不在跑就放行**，
 * 含一次都没跑过的行）；`canRetryRow` 只决定文案（这次是重跑还是首跑）。
 *
 * ⚠️ **这一次请求可能很久才回来**（2026-09-29 冒烟实测：远端仓库 + 冷镜像时 >5 分钟）：
 * 服务端的准备阶段（镜像 fetch + 复制 + checkout）跑在 `retryRow` 返回**之前**，而它是同步重活。
 * 不是本 hook 的问题（它也做不了什么），写在这里是为了下一个人排查「点了没反应」时不必从零开始
 * ——详见 `docs/features/row-execution.md` 已知边界里「retry 准备阶段同步重活」条。
 */
export function useRetryRow(): {
  retryRow: (runId: string, rowId: string) => Promise<EvalRun>;
  isRetrying: boolean;
} {
  const { mutate } = useSWRConfig();
  const [isRetrying, setRetrying] = useState(false);

  const retryRow = useCallback(
    async (runId: string, rowId: string): Promise<EvalRun> => {
      setRetrying(true);
      try {
        const run = await postJson<EvalRun>(`${runKey(runId)}/rows/${rowId}/retry`, {});
        await mutate(runKey(runId), run, { revalidate: false });
        await mutate(RUNS_KEY);
        return run;
      } finally {
        setRetrying(false);
      }
    },
    [mutate],
  );

  return { retryRow, isRetrying };
}

/**
 * 变更详情的**文件索引**（一页，默认 30 条，不含 diff 正文）：**按需**（只在抽屉打开时拉）——
 * 服务端每次都要现场跑 git 算 diff（spec §7.2）。
 *
 * `offset` / `limit` 显式给：索引是**分页**的，调用方要靠翻页把「共 N 个文件」逐个加载出来
 * （spec §5.3.4）。只写死第一页会让第 31 个之后的文件永远拿不到——而头部还写着「共 N 个」。
 *
 * `revalidateOnFocus: false`：这个 GET 在服务端是**一次真实的 git 计算**（合并三样 diff + 裁剪，
 * 可达数 MB 的输出与秒级耗时），而 SWR 默认会在窗口重新获得焦点时重跑它——每切回一次页面就重算一次。
 * 抽屉里的 diff 是「打开时看一眼」的产出快照，需要更新的使用者重新打开一次抽屉即可。
 */
export function useRowDiffIndex(
  runId: string,
  rowId: string,
  enabled: boolean,
  offset = 0,
  limit = 30,
): { index: RowDiffIndex | undefined; error: unknown; isLoading: boolean } {
  const { data, error, isLoading } = useSWR<RowDiffIndex>(
    enabled && runId !== '' && rowId !== ''
      ? runRowUrl(runId, rowId, 'diff', `?offset=${offset}&limit=${limit}`)
      : null,
    getJson,
    { revalidateOnFocus: false },
  );
  return { index: data, error, isLoading };
}

/**
 * 单个文件的 diff 正文。
 *
 * **`path === undefined` 就是「还没滚动到这个文件」**，此时 SWR key 传 `null`、一个请求都不发——
 * 不需要另造一个 `enabled` 布尔（两个开关必然漂移成「传了 path 却是 disabled」这种矛盾态）。
 * 同一个文件重复请求由 SWR 自己的缓存兜住，不会重复打服务端。
 */
export function useRowDiffFile(
  runId: string,
  rowId: string,
  path: string | undefined,
): { file: RowDiffFile | undefined; error: unknown; isLoading: boolean } {
  const { data, error, isLoading } = useSWR<RowDiffFile>(
    path !== undefined && runId !== '' && rowId !== ''
      ? runRowUrl(runId, rowId, 'diff', `?file=${encodeURIComponent(path)}`)
      : null,
    getJson,
    { revalidateOnFocus: false },
  );
  return { file: data, error, isLoading };
}

/**
 * 执行日志全量：抽屉首帧与「下载台账」共用（下载要的是完整落盘内容，不依赖长连接是否活着）。
 *
 * 这里**不关**焦点重验（与 `useRowDiffIndex` 相反，是有意的）：读一个 jsonl 文件比现场算 diff 便宜
 * 几个数量级，而「下载」直接消费这份数据——切回窗口时重读一次，换来一份更完整的落盘日志。
 *
 * `refresh` 是给`AgentLogSource.retryNode` 用的：节点内容**按值给**（UI 不做取数），
 * 于是「重取」在页面上就是重取这两条来源——它就是 SWR 的 `mutate`，没有第二份缓存。
 */
export function useRowLog(
  runId: string,
  rowId: string,
  enabled: boolean,
): { events: AgentEvent[] | undefined; error: unknown; isLoading: boolean; refresh: () => void } {
  const { data, error, isLoading, mutate } = useSWR<AgentEvent[]>(
    enabled && runId !== '' && rowId !== '' ? runRowUrl(runId, rowId, 'log') : null,
    getJson,
  );
  return { events: data, error, isLoading, refresh: () => void mutate() };
}

/** 空池的稳定引用：每次返回新数组会让表单的 Select options 每帧重建 */
const EMPTY_OPTIONS: AgentModelOption[] = [];

/** 未知 kind 的能力默认值：按「都支持」处理（多给一个终止按钮，比无端禁用安全） */
const OPTIMISTIC_CAPABILITY = { usage: true, cancelMidTurn: true } as const;

/**
 * 候选池 + 能力元数据（见计划「修正 2/3」）。一次取全三个 kind：
 * 创建表单要按行的智能体过滤模型池，候选卡片要 `usage` / `cancelMidTurn`，
 * 两者同源，分两次请求只会让「同一个 kind 的两份元数据」有机会不一致。
 *
 * 三个出口都给：`options` 是契约 §7 钉的原始列表形状，`optionsFor` / `capabilityOf` 是页面
 * 真正要用的两个投影（契约 §8 的 `RunCreatePanel.modelOptionsFor` / `RunDetailPanel.capabilityOf`
 * 就是照它们解构的）。投影在这里做，页面里就不必各自 `find` 一遍、也不会各自漏掉缺省值。
 */
export function useRunModelOptions(): {
  options: AgentOptionGroup[] | undefined;
  optionsFor: (agentKind: AgentKind) => AgentModelOption[];
  capabilityOf: (agentKind: AgentKind) => { usage: boolean; cancelMidTurn: boolean };
  defaultEffortOf: (agentKind: AgentKind) => string | undefined;
  messageCapabilityOf: (agentKind: AgentKind) => MessageCapability | null;
  isLoading: boolean;
  error: unknown;
} {
  const { data, error, isLoading } = useSWR<AgentOptionGroup[]>(AGENT_OPTIONS_KEY, getJson);
  const byKind = useMemo(
    () => new Map((data ?? []).map((group) => [group.agentKind, group])),
    [data],
  );

  const optionsFor = useCallback(
    (agentKind: AgentKind): AgentModelOption[] => byKind.get(agentKind)?.options ?? EMPTY_OPTIONS,
    [byKind],
  );
  const capabilityOf = useCallback(
    (agentKind: AgentKind): { usage: boolean; cancelMidTurn: boolean } => {
      const group = byKind.get(agentKind);
      return group === undefined
        ? OPTIMISTIC_CAPABILITY
        : { usage: group.usage, cancelMidTurn: group.cancelMidTurn };
    },
    [byKind],
  );
  /**
   * 能力声明（不是上面的 `capabilityOf`——两者刻意不合并）。
   *
   * **缺省是 `null`，不是一份编出来的「都支持」**：`capabilityOf` 那两格是**行级**能力
   * （能不能终止、能不能计量），乐观默认值只是「多给一个按钮」；而这里是**逐格的采数事实**，
   * 编一份出来等于替厂商声明「我们验过这一家」，而真相可能是「还没验证」。
   * 拿不到就如实给 `null`，界面据此显示「没验证过」——那是真的。
   */
  const messageCapabilityOf = useCallback(
    (agentKind: AgentKind): MessageCapability | null => byKind.get(agentKind)?.messageCapability ?? null,
    [byKind],
  );

  /**
   * 「未选档位」时该家实际会用的档；`undefined` = 这家不声明（由厂商推断）或元数据还没到。
   *
   * 与 `capabilityOf` 的乐观默认值**刻意相反**：那两格猜错只是多给一个按钮，而这一格是
   * 界面**说出口的一句话**（「未指定（DeepSeek Harness 用 high）」）——猜一个档出来就是
   * 替厂商承诺，拿不到时界面宁可只说「未指定」（缺一句事实好过编一句）。
   */
  const defaultEffortOf = useCallback(
    (agentKind: AgentKind): string | undefined => byKind.get(agentKind)?.defaultEffort,
    [byKind],
  );

  return { options: data, optionsFor, capabilityOf, defaultEffortOf, messageCapabilityOf, isLoading, error };
}
