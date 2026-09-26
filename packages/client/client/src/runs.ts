/**
 * 评测数据层：列表 / 详情 / 创建 / 启动 / 终止 / 产物读取 / 候选池。
 * 三条约定：
 *   1. **加键在这里，不在页面里**：`/api/runs` 与 `/api/runs/{id}` 被四个 hook 与
 *      `row-stream.ts` 共用（终态后要 mutate 的就是这两个键），字面量散落必然漂移；
 *   2. 轮询只在「还有活在跑」时开（spec §8 末段）。`refreshInterval` 传的是**数字**而不是
 *      函数：函数形式每帧都是新引用，SWR 的轮询 effect（deps 里就有 `refreshInterval`）因此
 *      每帧重挂、计时器被反复重置——而正在跑的评测恰恰是页面重渲染最频繁的时候（SSE 每来一条
 *      事件就渲染一次），3 秒的轮询会一直等不到触发。数字形式的代价是「必须先有数据才能算」，
 *      而 `data` 正是 `useSWR` 的返回值（在自己的 options 里引用它是 TDZ 报错，brief 的原稿
 *      就是这么写的），所以间隔走一份 state 镜像，见 `usePollingRun`；
 *   3. mutation 成功后写缓存 + `revalidate:false`，再显式刷新列表（契约 §7 的回写约定）。
 *      这里没用 `useSWRMutation`：启动/终止的响应要同时写进**详情**与**列表**两个键，
 *      而它只绑定一个键，用了还得再手写一次 mutate——不如从一开始就用 `useSWRConfig().mutate`。
 *      顺带一个结构性好处：runId 是**调用时**才拿到的，四个写操作因此根本没被挂进 SWR 的
 *      fetcher，「窗口重新获得焦点 ⇒ 重发一次写请求」这条 p2 踩过的坑在形状上就不存在
 *      （`runs.test.tsx` 的「焦点重验」一节把它钉住，防的是将来有人改写成 SWR 挂载式）。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import useSWR, { useSWRConfig } from 'swr';
import {
  isRunningRow,
  type AgentKind,
  type EvalRun,
  type ProtocolType,
  type ProviderModel,
  type RowDiffFile,
  type RowDiffIndex,
  type RunCreate,
  type RunUpdate,
  type AgentEvent,
} from '@aieval/contracts';
import { delJson, getJson, postJson, putJson } from './http';

/** 列表键：与 useRuns / useCreateRun / useStartRun 的显式刷新共用 */
export const RUNS_KEY = '/api/runs';

/** 单轮详情键 */
export function runKey(runId: string): string {
  return `${RUNS_KEY}/${runId}`;
}

/**
 * 一行的产物端点（diff / log / stream 同前缀）——SSE 与两处按需读取共用，免得字面量三份。
 * `query` 由调用方给（含 `?`），本函数只负责拼，不解释语义。
 */
export function runRowUrl(runId: string, rowId: string, artifact: 'diff' | 'log' | 'stream', query = ''): string {
  return `${runKey(runId)}/rows/${rowId}/${artifact}${query}`;
}

/** 候选池与能力元数据的端点（见计划「修正 2/3」） */
export const AGENT_OPTIONS_KEY = '/api/runs/model-options';

/** 有在跑的行时的轮询间隔（spec §8 末段） */
const RUN_POLL_MS = 3000;

/** 一轮「还有活在跑」：轮级 status 与行级状态都要看——编排层翻转轮状态有一拍延迟 */
function isLiveRun(run: EvalRun): boolean {
  return run.status === 'running' || run.rows.some((row) => isRunningRow(row.status));
}

/**
 * 「还有活在跑 ⇒ 每 3 秒轮询一次，跑完立刻停」的取数（列表与详情共用一份口径）。
 *
 * 间隔走 state 镜像而不是直接读 `data`：`data` 是 `useSWR` 的返回值，在它自己的 options 里
 * 引用它是 TDZ 报错；而函数形式（`refreshInterval: (latest) => …`）每帧都是新引用，会让 SWR 的
 * 轮询 effect 每帧重挂并重置计时器——SSE 每来一条事件就重渲染一次，跑着的评测反而永远轮询不到。
 * 用 state 镜像后间隔只在「有/没有活在跑」翻转时变一次，SWR 见间隔变了就重新调度（0 ⇒ 停）。
 */
function usePollingRun<T>(
  key: string | null,
  isLive: (data: T) => boolean,
): ReturnType<typeof useSWR<T>> {
  const [pollMs, setPollMs] = useState(0);
  const response = useSWR<T>(key, getJson, { refreshInterval: pollMs });
  const live = response.data !== undefined && isLive(response.data);
  useEffect(() => {
    setPollMs(live ? RUN_POLL_MS : 0);
  }, [live]);
  return response;
}

export function useRuns(): { runs: EvalRun[] | undefined; error: unknown; isLoading: boolean; refresh: () => void } {
  const { data, error, isLoading, mutate } = usePollingRun<EvalRun[]>(RUNS_KEY, (runs) => runs.some(isLiveRun));
  return { runs: data, error, isLoading, refresh: () => void mutate() };
}

export function useRun(id: string | null): {
  run: EvalRun | undefined;
  error: unknown;
  isLoading: boolean;
  refresh: () => void;
} {
  // SSE 覆盖逐行的计量跳动；轮级状态与排名的收敛仍靠一次快照刷新，
  // 3 秒兜底让「万一 SSE 断掉」也不会永久停在「执行中」
  const { data, error, isLoading, mutate } = usePollingRun<EvalRun>(
    id === null ? null : runKey(id),
    isLiveRun,
  );
  return { run: data, error, isLoading, refresh: () => void mutate() };
}

/** 候选池里的一个模型：与 api 的 `AgentModelOption` 逐字段一致（client 不能 import api，故此处重复声明） */
export interface AgentModelOption {
  providerId: string;
  providerName: string;
  modelId: string;
  source: ProviderModel['source'];
}

/**
 * 一种智能体的能力元数据 + 候选池：与 api 的 `AgentOptionGroup` 逐字段一致。
 * client 不能 import api，所以这份形状在两侧各声明一次；**字段集合由路由测试钉死**
 * （见 Task 10：断言响应对象的键集合），哪一侧偷偷加字段都会当场失败。
 */
export interface AgentOptionGroup {
  agentKind: AgentKind;
  /** 该智能体接受的协议**集合**（服务端来自 agents 注册表；DSH 两条 wire ⇒ 两个元素） */
  protocolTypes: readonly ProtocolType[];
  usage: boolean;
  cancelMidTurn: boolean;
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
 * 形状与另外四个写操作逐字相同（见文件头约定 3）：手工 `mutate`、`revalidate: false`、
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
 * 重新评分：只重跑评分步骤（spec §9）。回写两个键与另外四个写操作同形——
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
 * ——详见 `docs/superpowers/notes/2026-09-29-single-row-execution-smoke.md` 的「未覆盖项」第 1 条。
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
 * （spec §4 ①）。只写死第一页会让第 31 个之后的文件永远拿不到——而头部还写着「共 N 个」。
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
 * 执行日志全量：抽屉首帧与「下载」共用（下载要的是完整落盘内容，不依赖长连接是否活着）。
 *
 * 这里**不关**焦点重验（与 `useRowDiff` 相反，是有意的）：读一个 jsonl 文件比现场算 diff 便宜
 * 几个数量级，而「下载」直接消费这份数据——切回窗口时重读一次，换来一份更完整的落盘日志。
 */
export function useRowLog(
  runId: string,
  rowId: string,
  enabled: boolean,
): { events: AgentEvent[] | undefined; error: unknown; isLoading: boolean } {
  const { data, error, isLoading } = useSWR<AgentEvent[]>(
    enabled && runId !== '' && rowId !== '' ? runRowUrl(runId, rowId, 'log') : null,
    getJson,
  );
  return { events: data, error, isLoading };
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

  return { options: data, optionsFor, capabilityOf, isLoading, error };
}
