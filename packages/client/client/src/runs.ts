/**
 * 评测数据层：列表 / 详情 / 创建 / 启动 / 终止 / 产物读取 / 候选池。
 * 三条约定：
 * 1. **加键在这里，不在页面里**：`/api/runs` 与 `/api/runs/{id}` 被本文件的取数 hook 与
 * `row-stream.ts` 共用（终态后要 mutate 的就是这两个键），字面量散落必然漂移；
 * 2. **实时性由 run 信号驱动，轮询只剩慢兜底**：
 * `useRunEvents`（`run-events.ts`）订阅全局流 `/api/runs/stream`，服务端每落盘一次快照
 * 就推一条 `run-updated`，客户端收到即重验列表与详情——状态翻转是毫秒级的
 * 「变了才读」，而不再是每 3 秒问一次。慢兜底只在「还有活在跑」时
 * 开着，给「信号通道万一断了」兜底；`refreshInterval` 传**数字**而不是函数的
 * 理由不变（函数形式每帧都是新引用，SWR 的轮询 effect 会反复重挂、计时器被
 * 反复重置——而跑着的评测正是页面重渲染最频繁的时候），间隔走 state 镜像，
 * 见 `useFallbackRun`；
 * 3. mutation 成功后写缓存 + `revalidate:false`，再显式刷新列表（回写约定）。
 * 这里没用 `useSWRMutation`：启动/终止的响应要同时写进**详情**与**列表**两个键，
 * 而它只绑定一个键，用了还得再手写一次 mutate——不如从一开始就用 `useSWRConfig.mutate`。
 * 顺带一个结构性好处：runId 是**调用时**才拿到的，这些写操作因此根本没被挂进 SWR 的
 * fetcher，「窗口重新获得焦点 ⇒ 重发一次写请求」这条 p2 踩过的坑在形状上就不存在
 * （`runs.test.tsx` 的「焦点重验」一节把它钉住，防的是将来有人改写成 SWR 挂载式）。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import useSWR, { useSWRConfig } from 'swr';
import {
  isRunningRow,
  type AgentKind,
  type CheckpointCapability,
  type EvalRun,
  type MessageCapability,
  type ProtocolType,
  type ProviderModel,
  type RowArtifactFile,
  type RowDiffFile,
  type RowDiffIndex,
  type RunArtifactIndex,
  type RunTestResults,
  type RunCreate,
  type RunUpdate,
  type TurnInjectionCapability,
  type AgentEvent,
} from '@aieval/contracts';
import { useRunEvents } from './run-events';
import { RUNS_KEY, runKey } from './run-keys';
import { delJson, getJson, postJson, putJson } from './http';

// 键的真源在 `run-keys.ts`（叶子模块）；这里 re-export 是为了让三条行级流与页面的
// 既有 import 路径一律不动（它们都从 './runs' 拿键）。
export { RUNS_KEY, runKey };

/**
 * 一行的产物端点（diff / log / stream / messages / 评分那两条同前缀）——SSE 与多处按需读取共用，
 * 免得字面量三份。`query` 由调用方给（含 `?`），本函数只负责拼，不解释语义。
 * 评分那条的 `seq` 是**独立一套**（`appendEvent` 按文件续号），`afterSeq` 不许拿执行日志的号来续。
 */
export function runRowUrl(
  runId: string,
  rowId: string,
  artifact: 'diff' | 'artifacts' | 'log' | 'stream' | 'messages' | 'messages/stream' | 'judge/events' | 'judge/events/stream',
  query = '',
): string {
  return `${runKey(runId)}/rows/${rowId}/${artifact}${query}`;
}

/**
 * 一轮的**候选产物清单**端点（`/api/runs/{id}/artifacts`）：轮级而不是行级——
 * 它一次给的是「这一轮每个候选各自有哪些 `RESULT.*`」，界面拿它决定「产物总览」按钮出不出现。
 * 单独一个构造函数而不复用 `runRowUrl`：那一个的前缀是 `/rows/<rowId>`，这一条不属于任何一行。
 */
export function runArtifactsUrl(runId: string): string {
  return `${runKey(runId)}/artifacts`;
}

/**
 * 一轮的**测试结果投影**端点（`/api/runs/{id}/test-results`）：排名页通过率列的数据源。
 *
 * 独立于 `runArtifactsUrl`：那一条扫的是产物文件，这一条读的是每行消息账本里的测试命令输出；
 * 两者都在排名抽屉打开时才取，但一份读不出来不该牵连另一份。
 */
export function runTestResultsUrl(runId: string): string {
  return `${runKey(runId)}/test-results`;
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

/**
 * 一行的**候选活动流**端点：`/messages/stream?replay=0` = **不回放历史**。
 * 卡片底部那一行的实时打字现在走整轮共享的聚合流（见 `run-stream-hub.ts`）：它只要「此刻在打字的
 * 那一句」，而历史里没有增量，回放只会把整份 `messages.jsonl` 读出来、推过 socket 再丢掉。
 * 这个构造器仍留在出口面上——行级端点本身照旧服务，直连它的消费方按这里的形状拼 URL。
 */
export function runRowActivityStreamUrl(runId: string, rowId: string): string {
  return runRowUrl(runId, rowId, 'messages/stream', '?replay=0');
}

/**
 * 一轮的**聚合流**端点：一轮下所有行的实时数据走这一条。
 *
 * `after` 是一张**逐行游标表**（`rowId:seq` 逗号分隔），不是单一 seq——每行的 `seq` 按各自文件发号，
 * 跨行没有可比性。空表（`cursors` 为空）时不带这个参数：**不回放历史、只推实时帧**。
 * 行 id 逐个编码：它来自 URL 那一侧，`encodeURIComponent` 是唯一能保证 `,` / `:` / 空格
 * 不会被当成分隔符的那一步（拼错的症状是「某一行的历史静默不回放」）。
 */
export function runAggregateStreamUrl(runId: string, cursors: ReadonlyMap<string, number>): string {
  const table = [...cursors].map(([rowId, seq]) => `${encodeURIComponent(rowId)}:${seq}`).join(',');
  return `${runKey(runId)}/stream${table === '' ? '' : `?after=${table}`}`;
}

/**
 * 一行的**评分活动流**端点：`/judge/messages/stream?replay=0`。
 * 评审者是**另一个会话**，它的消息落在自己的文件里（`judge-messages.jsonl`）——活动行在评分阶段
 * 看的是这一条，不是候选那条（两条同时订阅会让那一行被候选的残留内容占住）；聚合流上这两条
 * channel 是同一帧族，靠 `rowChannel` 分。
 */
export function runRowJudgeActivityStreamUrl(runId: string, rowId: string): string {
  return `${runKey(runId)}/rows/${rowId}/judge/messages/stream?replay=0`;
}

/** 候选池与能力元数据的端点 */
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
  // 与下面 useRun 的订阅共用同一条——页面上无论挂几个 hook，全局流只有一条
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
 * 两半接缝各有各的守卫，**别把其中一条读成两条都管**：
 * · **api 侧的响应形状**由 `apps/web-next/src/route-runs.test.ts` 钉死（它直接断言响应里
 * `options[0]` 的键集合）——api 偷偷加/改名一格，那里当场红；
 * · **本接口这三格**由 `runs.test.tsx` 的那条形状用例钉住：对象字面量赋给 `AgentModelOption`
 * 会走**多余属性检查**，少一格就直接 tsc 报错。为什么非要在 client 侧再钉一条：从这里删掉
 * `efforts` 时路由测试**照样绿**（它管的是 JSON，不是这个接口），而所有消费点传的都是函数值、
 * 三格又全是可选的 ⇒ 结构类型下「少一格」天然可赋值，**tsc 与测试都不会响**。
 *
 * 后三格**必须在这里声明**：api 是按「有意义才出现」投影的
 * （缺省 = 窗口未知 / 无可选档 / 上游没推荐），表现是界面**静默**丢掉那一格：少 `efforts` 时
 * 创建表单的「思考强度」下拉永远是空的，而没有任何一处会报错。
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
  /**上游推荐档；**只在它落在 `efforts` 里时**才有值（界面据此在标签上标「推荐」、不预选） */
  recommendedEffort?: string;
}

/**
 * 一种智能体的能力元数据 + 候选池：与 api 的 `AgentOptionGroup` 逐字段一致。
 * client 不能 import api，所以这份形状在两侧各声明一次；**字段集合由路由测试钉死**
 * （见：断言响应对象的键集合），**本接口自己那一半**由 `runs.test.tsx` 的接缝形状用例钉住
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
   *。
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
   * 消息能力声明：五格各带 `source` / `reason`，外加 `notes`。
   *
   * **逐格原样来自服务端**（api 从 agents 注册表元数据透出）。数据层不许裁剪、也不许在这一层
   * 补默认值：界面那四句「这家结构上不支持 / 厂商没投送 / 我们没接 / 没验证过」全靠它，
   * 缺一格就会被读成「没有这个能力」。取不到时 `messageCapabilityOf` 给 `null`，
   * **不是**一份编出来的「都支持」——具体理由见那个投影的注释。
   */
  messageCapability: MessageCapability;
  /**
   * **回到某一轮**的能力声明（服务端来自注册表 `metadata.checkpoint`，逐格原样透出）。
   *
   * 谁在用它：轮末「回到这里」的可用性与禁用原因**只从这一格来**（界面不判厂商）。
   * 取不到时 `checkpointOf` 给 `null`——**不是**一份编出来的「都支持」：猜错会让按钮可点、
   * 点下去却什么都不发生（或静默退化成普通续接），而界面上一切正常。
   */
  checkpoint: CheckpointCapability;
  /**
   * 注入面声明（`turnInjection`）：送话的两档边界、已交给厂商那一条能不能按条撤回、以及续接。
   *
   * **可选**：还没接这一面的家整组不交（服务端按「有意义才出现」投影 ⇒ 缺席时这一格不存在）。
   * 取不到时 `turnInjectionOf` 给 `null`，**不是**一份编出来的「都支持」：猜错会让界面说谎
   * （说「能投」而实际投不进去），而说谎的形态是「按钮可点、消息静默消失」。
   */
  turnInjection?: TurnInjectionCapability;
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
 * 重新评分：只重跑评分步骤。回写两个键与本文件其它写操作同形——
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
 * 只跑这一行（候选 agent + 评分），本轮其他行一律不动——
 * 「只执行当前候选项，不要完成后重新执行下方已经执行过的候选项」。
 * 与 `useRescoreRow`是同一个形状、不同的端点。回写两个键的理由与其它写操作一样：
 * 状态立刻变成 `preparing` 这件事必须同时被详情与列表看到。
 * `isRetrying` 只用于按钮转圈与禁用；可用性判据是 contracts 的 `canRunRow`（*不在跑就放行**，
 * 含一次都没跑过的行）；`canRetryRow` 只决定文案。
 *
 * ⚠️ **这一次请求可能很久才回来**：
 * 服务端的准备阶段（镜像 fetch + 复制 + checkout）跑在 `retryRow` 返回**之前**，而它是同步重活。
 * 不是本 hook 的问题，写在这里是为了下一个人排查「点了没反应」时不必从零开始
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
 * 服务端每次都要现场跑 git 算 diff。
 *
 * `offset` / `limit` 显式给：索引是**分页**的，调用方要靠翻页把「共 N 个文件」逐个加载出来
 *。只写死第一页会让第 31 个之后的文件永远拿不到——而头部还写着「共 N 个」。
 *
 * `revalidateOnFocus: false`：这个 GET 在服务端是**一次真实的 git 计算**（合并三样 diff + 裁剪，
 * 可达数 MB 的输出与秒级耗时），而 SWR 默认会在窗口重新获得焦点时重跑它——每切回一次页面就重算一次。
 * 抽屉里的 diff 是「打开时看一眼」的产出快照，需要更新的使用者重新打开一次抽屉即可。
 *
 * 失败的读侧（工作区被占用 / 权限不足 / git 锁）给一个 `refresh`：错误页上的「重新读取」按钮
 * 是这条路径唯一的出路，另外三个视图都由各自的重取入口兜底。
 */
export function useRowDiffIndex(
  runId: string,
  rowId: string,
  enabled: boolean,
  offset = 0,
  limit = 30,
): { index: RowDiffIndex | undefined; error: unknown; isLoading: boolean; refresh: () => void } {
  const { data, error, isLoading, mutate } = useSWR<RowDiffIndex>(
    enabled && runId !== '' && rowId !== ''
      ? runRowUrl(runId, rowId, 'diff', `?offset=${offset}&limit=${limit}`)
      : null,
    getJson,
    { revalidateOnFocus: false },
  );
  return { index: data, error, isLoading, refresh: () => void mutate() };
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
 * 「产物总览」的清单（这一轮每个候选工作区根下的 `RESULT.*`）。
 *
 * 与 `useRowDiffIndex` 同一条「只读的展示快照」口径（`revalidateOnFocus: false`）：
 * 一次扫描 = 每行一次 `readdir`，切回窗口就重扫没有意义。
 * **打开期间不自动重扫**：关掉排名抽屉再打开（`enabled` 由 false 翻回 true）即重扫一次——
 * 候选还在跑时想看到最新产物，走这条路。
 */
export function useRunArtifacts(
  runId: string,
  enabled: boolean,
): { index: RunArtifactIndex | undefined; error: unknown; isLoading: boolean } {
  const { data, error, isLoading } = useSWR<RunArtifactIndex>(
    enabled && runId !== '' ? runArtifactsUrl(runId) : null,
    getJson,
    { revalidateOnFocus: false },
  );
  return { index: data, error, isLoading };
}

/**
 * 一轮的**测试结果**投影（排名页的通过率列）。
 *
 * 与 `useRunArtifacts` 同一条「打开才取、只读快照」口径：读的是每行消息账本，
 * 不是实时的运行状态；关掉排名抽屉再打开即重读一次。
 * 返回 `undefined` = 还没读到（界面写「未采集」），**不回落成 0**。
 */
export function useRunTestResults(
  runId: string,
  enabled: boolean,
): { results: RunTestResults | undefined; error: unknown; isLoading: boolean } {
  const { data, error, isLoading } = useSWR<RunTestResults>(
    enabled && runId !== '' ? runTestResultsUrl(runId) : null,
    getJson,
    { revalidateOnFocus: false },
  );
  return { results: data, error, isLoading };
}

/**
 * 单个候选的**一份**产物正文。
 *
 * **`name === undefined` 就是「这一份还没取」**，此时 SWR key 传 `null`、一个请求都不发
 * （与 `useRowDiffFile` 同一条口径：不另造一个 `enabled` 布尔，两个开关必然漂移）。
 * 文件名虽然只可能是 `RESULT.md` 这类白名单里的值，仍照常编码：拼 URL 的那一步不该假设取值面。
 */
export function useRowArtifactFile(
  runId: string,
  rowId: string,
  name: string | undefined,
): { file: RowArtifactFile | undefined; error: unknown; isLoading: boolean } {
  const { data, error, isLoading } = useSWR<RowArtifactFile>(
    name !== undefined && runId !== '' && rowId !== ''
      ? runRowUrl(runId, rowId, 'artifacts', `?name=${encodeURIComponent(name)}`)
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
 * 候选池 + 能力元数据。一次取全三个 kind：
 * 创建表单要按行的智能体过滤模型池，候选卡片要 `usage` / `cancelMidTurn`，
 * 两者同源，分两次请求只会让「同一个 kind 的两份元数据」有机会不一致。
 *
 * 三个出口都给：`options` 是钉的原始列表形状，`optionsFor` / `capabilityOf` 是页面
 * 真正要用的两个投影（`RunCreatePanel.modelOptionsFor` / `RunDetailPanel.capabilityOf`
 * 就是照它们解构的）。投影在这里做，页面里就不必各自 `find` 一遍、也不会各自漏掉缺省值。
 */
export function useRunModelOptions(): {
  options: AgentOptionGroup[] | undefined;
  optionsFor: (agentKind: AgentKind) => AgentModelOption[];
  capabilityOf: (agentKind: AgentKind) => { usage: boolean; cancelMidTurn: boolean };
  defaultEffortOf: (agentKind: AgentKind) => string | undefined;
  messageCapabilityOf: (agentKind: AgentKind) => MessageCapability | null;
  checkpointOf: (agentKind: AgentKind) => CheckpointCapability | null;
  turnInjectionOf: (agentKind: AgentKind) => TurnInjectionCapability | null;
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
   * 注入面声明；`null` = 不知道（这一家整组没交，或元数据还没到）。
   *
   * 与 `messageCapabilityOf` 同一条口径：**不编一份「都支持」**。界面拿它决定输入区能不能用、
   * 两颗操作按钮禁不禁用，猜错的形态是「按钮可点、消息静默消失」——没有报错，只有人以为自己发了。
   */
  /**
   * 「回到某一轮」的能力声明；`null` = 不知道（元数据还没到 / 后端没给这一格）。
   *
   * 与 `messageCapabilityOf` 同一条口径：**不编一份「都支持」**。界面拿到 `null` 时按
   * 「没验证过」置灰并如实说明——那比让按钮可点、点下去无声失败要诚实。
   */
  const checkpointOf = useCallback(
    (agentKind: AgentKind): CheckpointCapability | null => byKind.get(agentKind)?.checkpoint ?? null,
    [byKind],
  );

  const turnInjectionOf = useCallback(
    (agentKind: AgentKind): TurnInjectionCapability | null => byKind.get(agentKind)?.turnInjection ?? null,
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

  return {
    options: data,
    optionsFor,
    capabilityOf,
    defaultEffortOf,
    messageCapabilityOf,
    checkpointOf,
    turnInjectionOf,
    isLoading,
    error,
  };
}
