'use client';

/**
 * 评测页：左侧列表 + 右侧栏（详情 / 创建表单 / 编辑表单），形态与用例页同口径。
 * 七条口径：
 * 1. `useSearchParams` 会把用到它的子树退化为客户端渲染，故给它一个 `Suspense` 边界
 * （Next 16 文档 useSearchParams 的 Prerendering 一节）；
 * 2. **日志那一条 SSE 只在该候选的日志抽屉打开时订阅**（实时指标那一路只为在跑的候选各开一条）；
 * 3. 三个抽屉的数据各自按需取：日志 = `useCandidateStream`+ `useCandidateLog`
 * + `useCandidateMessages`、改动 = `useCandidateDiffIndex` + `useCandidateDiffFile`、
 * 评分详情 = 快照里的 `score` 与 `rubric` + 评分那条事件流 `useCandidateJudgeEvents`
 * （评审者自己的原始输出，只在抽屉开着才取、judging 才接 SSE）；
 * 4. 页面的可测逻辑（URL 解析、错误文案、日志抽屉的三态）都在 `@/src/runs-view` 与
 * `@/src/log-drawer-state`，本文件只做拼装；
 * 5. **本页自己不套 `PageShell`**：`ListDetailLayout` 内部已经是 `PageShell`，
 * 再包一层会多出一个 `ConfigProvider` 与一圈 16px 内边距，与本仓另一处同样形态的
 * `/cases` 页不一致——两页的骨架必须逐字同形，否则宽度偏好与吸底几何会各自漂移。
 * 6. **右栏三态**`?panel=detail|new|edit&id=…`：编辑与详情共用同一份快照
 * （`selectedId` 两态都取 id）。与 `/cases` 的一处有意差异：runs 页没有需要复位的跨面板
 * 临时状态（用例页那套 `go` 复位是为仓库校验回显服务的），故不引入那层。
 * 7. **「执行日志」全页只有一支抽屉**：
 * 「读取中」那一支**什么都不渲染**——那时 `model` 还没算出来，弹出来的必然是空壳，
 * 而它会把真抽屉的入场动画重置（实测：遮罩与面板各重放一次）。根因与实测日志见
 * `src/drawer-geometry.test.ts` 里那一组用例的注释。
 * 8. **本页是「run 焦点」的唯一写入方**：右栏选中哪一轮就 `setFocusedRun(那一轮)`、离开即复位，
 * 全局提问浮层据此把其余轮次的未答提问**暂缓**（不弹、不取消）。焦点是模块级单例——
 * 浮层挂在页面壳外面，`Context` 够不着本页的查询参数。
 */
import { Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { PlusOutlined } from '@ant-design/icons';
import { Alert, App, Button, Drawer, Flex, Table, Tag, Tooltip, Typography } from 'antd';
import type { TableColumnsType } from 'antd';
import { isRunningCandidate, type AgentEnvironment, type EvalRun, type CandidateDiffIndex, type Rubric, type RunCreate, type ScoreResult } from '@aieval/contracts';
import {
  buildAgentEnvironment,
  useAbortCandidate,
  useAbortRun,
  useCases,
  useCreateRun,
  useDeleteRun,
  postInjectAttachment,
  useFollowUpAvailability,
  useFollowUpCandidate,
  useInjectMessages,
  useCandidateArtifactFile,
  useCandidateDiffFile,
  useCandidateDiffIndex,
  useCandidateJudgeEvents,
  useCandidateLog,
  useCandidateMessages,
  useCandidateStream,
  useRun,
  useRunActivity,
  useRunArtifacts,
  useRunLiveMetrics,
  useRunModelOptions,
  useRuns,
  useRescoreCandidate,
  useRetryCandidate,
  setFocusedRun,
  useSettings,
  useStartRun,
  useUpdateRun,
  type AgentLogModel,
  type AgentLogSource,
} from '@aieval/client';
import {
  ARTIFACT_OVERVIEW_LABEL,
  AgentLogDrawer,
  AppTopNav,
  ArtifactFileContent,
  ArtifactOverview,
  DRAWER_SEMANTIC_STYLES,
  DiffFileContent,
  DiffView,
  EllipsisText,
  EmptyState,
  FollowUpComposer,
  InjectComposer,
  ListDetailLayout,
  MAIN_DRAWER_PUSH,
  RankTable,
  RunCreatePanel,
  RunDetailPanel,
  RunDetailSkeleton,
  ScoreDetailView,
  TableScrollArea,
  // 能力声明的形状搬运（契约的扁平三格 → 界面要的字典）：唯一的一份实现，页面不自己摊
  toCapabilityMap,
  Toolbar,
  WIDE_DRAWER_SIZE,
  buildAgentLogModel,
  diagnosticsOf,
  formatDateTime,
  formatEventLog,
  rawOutputLabel,
  useAppliedThemeMode,
  // 表单交回的值的形状：创建与编辑两条路径都按它收敛（`RunUpdate` 与它逐字段一致）
  type Loadable,
  type RunFormValues,
} from '@aieval/ui';
import { buildCandidateFacts, resolveLogDrawer } from '@/src/log-drawer-state';
import { NAV_ITEMS } from '@/src/nav';
import { describeError, parseRunsPanel, runListTitle, runsPanelHref, type OpenDrawer } from '@/src/runs-view';

/** 轮级状态 → 中文与颜色（候选级状态在 ui 的 CandidateStatusTag 里；轮级只有 4 个值） */
const RUN_STATUS_META: Record<EvalRun['status'], { label: string; color: string }> = {
  idle: { label: '未开始', color: 'default' },
  running: { label: '执行中', color: 'processing' },
  partial: { label: '部分完成', color: 'warning' },
  done: { label: '已完成', color: 'success' },
};

/**
 * 「状态」列的排序序：按**业务生命周期**idle → running → partial → done。
 * 不按枚举名、也不按中文标签的字符串排——「部分完成」按拼音会插在「未开始」前面，那是没人能预期的序。
 * 写成 `Record<EvalRun['status'], number>` 是为了让契约新增状态时 tsc 直接报错。
 * 枚举外的状态值进不了这张表：`run.json` 里状态不合枚举会被 run-store 的 `safeParse` 跳过。
 */
const RUN_STATUS_RANK: Record<EvalRun['status'], number> = { idle: 0, running: 1, partial: 2, done: 3 };

/** 「标题」列的兜底最小宽度：左栏被拖窄时，这一列至少还得读得下一整个用例名（与用例页同口径的 240） */
const RUN_TITLE_MIN_WIDTH = 240;

/** 另外四列申报的宽度：状态 / 候选数 / 执行模式 / 创建时间 */
const RUN_COLUMN_WIDTH = { status: 96, candidates: 80, executionMode: 96, createdAt: 150 } as const;

/**
 * 列表表格的最小宽度：左栏窄于它时**才**横向滚动，并把「标题」钉在左边
 * （用户口径：「标题列左悬浮」；与用例页、供应商表同一套口径，见
 * `ProviderTable` 的 `PROVIDER_TABLE_MIN_WIDTH`）。
 *
 * 为什么必须有这个数：不给 `scroll.x` 时 rc-table 不设宽度，左栏被拖窄只会把五列**按比例压扁**——
 * 「标题」是唯一吃剩余宽度的列，它是第一个被压到只剩省略号的；给了数字后 rc-table 把 `width`
 * + `minWidth: 100%` 落到表格上，溢出变成**表格内部**的横向滚动，标题列钉在左侧、其余四列滑走。
 *
 * 662 = 四列宽（96 / 80 / 96 / 150）+ 标题列下限 240。≥662 时五列全都看得见、不滚（表格按
 * `minWidth: 100%` 铺满左栏，多出来的宽度全给标题列），<662 时横向滚动、标题留在左边。
 * ⚠️ jsdom 没有布局引擎、宽度量不了：这个数只由真机冒烟记录看着。
 */
const RUNS_TABLE_MIN_WIDTH =
  RUN_TITLE_MIN_WIDTH +
  RUN_COLUMN_WIDTH.status +
  RUN_COLUMN_WIDTH.candidates +
  RUN_COLUMN_WIDTH.executionMode +
  RUN_COLUMN_WIDTH.createdAt;

/**
 * 列表排序的两个比较器。
 * 三条口径，缺一条都会在真机上看见怪序：
 *
 * ① 文本一律 `localeCompare('zh-Hans-CN', { numeric: true })`：默认的码点比较对中文等于乱序，
 * `numeric` 让「测试2」排在「测试10」前面而不是后面；
 * ② **空值当最小值**，而且走显式分支：排的「标题」是 `runListTitle` 的拼法（用例标题快照，
 * 备注非空时再接「 · 备注」），而契约对 `caseTitle` 只声明 `z.string()`（**没有 `min(1)`**），
 * 手改过的 `run.json` 能写空串进列表——不管的话 `String(undefined)` 会把 `"undefined"`
 * 当正常字符串混进序里；
 * ③ 这里**只写升序语义**：方向由 antd 施加（它拿 `sortOrder === 'ascend' ? res : -res` 整体取反），
 * 自己再按方向翻一次就是翻两次。
 *
 * 同值的候选不需要兜底键：服务端给的就是 `createdAt` 降序（api/runs.ts 的 `listRunsView`），
 * `Array.prototype.sort` 稳定 ⇒ 比较为 0 的候选永远保持那个顺序（同一用例的多轮自然聚在一起、
 * 组内最近创建的在前面），与排序方向无关。
 *
 * ⚠️ cases 页有同口径的两份就地实现（本次口径：比较器不抽模块）。改这里必须同时改那边。
 */
function compareSortText(left: unknown, right: unknown): number {
  const leftBlank = typeof left !== 'string' || left.trim() === '';
  const rightBlank = typeof right !== 'string' || right.trim() === '';
  if (leftBlank || rightBlank) return leftBlank === rightBlank ? 0 : leftBlank ? -1 : 1;
  return (left as string).localeCompare(right as string, 'zh-Hans-CN', { numeric: true });
}

/** 时间比较器（升序语义）：一律按时刻值比；解析不出时刻的（脏数据）与文本空值同一档，当最小值 */
function compareSortTime(left: unknown, right: unknown): number {
  const leftMs = typeof left === 'string' ? Date.parse(left) : Number.NaN;
  const rightMs = typeof right === 'string' ? Date.parse(right) : Number.NaN;
  const leftInvalid = Number.isNaN(leftMs);
  const rightInvalid = Number.isNaN(rightMs);
  // 同类 ISO 串的字典序与时刻序一致，但混进带时区偏移的写法（+08:00 与 Z 表示同一时刻）就会错位，故一律比毫秒数
  if (leftInvalid || rightInvalid) return leftInvalid === rightInvalid ? 0 : leftInvalid ? -1 : 1;
  return leftMs - rightMs;
}

/**
 * 一个文件的正文。
 * 必须是**独立组件**：`useCandidateDiffFile` 是 hook，不能由页面按 path 循环调用；
 * 每个文件一个实例，SWR 的订阅与缓存才能按文件各自生效（这正是惰性加载要的形状）。
 */
function DiffFileBody({
  runId,
  candidateId,
  path,
  dark,
}: {
  runId: string;
  candidateId: string;
  path: string;
  dark: boolean;
}): ReactNode {
  const { file, error, isLoading } = useCandidateDiffFile(runId, candidateId, path);
  return <DiffFileContent file={file} error={error} isLoading={isLoading} dark={dark} />;
}

/**
 * 一份候选产物的正文（「产物总览」二级抽屉里的那张卡）。
 *
 * 与 `DiffFileBody` 同一条理由，必须是**独立组件**：`useCandidateArtifactFile` 是 hook，
 * 不能由抽屉按「候选 × 文件名」循环调用；每份一个实例，SWR 的订阅与缓存才能按
 * 「这个候选的这一份」各自生效——这正是「一份读不出来只坏那一张卡」要的形状。
 */
function ArtifactFileBody({ runId, candidateId, name }: { runId: string; candidateId: string; name: string }): ReactNode {
  const { file, error, isLoading } = useCandidateArtifactFile(runId, candidateId, name);
  return <ArtifactFileContent file={file} error={error} isLoading={isLoading} />;
}

/**
 * 「变更详情」「评分详情」两个抽屉共用的几何口径——**与「执行日志」是同一份**。
 *
 * 常量住在 `@aieval/ui` 的 `base/drawer-geometry`：那三个抽屉分居两个包（执行日志的几何在
 * `AgentLogDrawer` 里），各写一份必然漂移，而漂移是静默的（实测：antd 6 废弃
 * `width` 后这两处漏改，抽屉掉回默认 `378px`，比执行日志窄一半，且没有任何用例变红）。
 *
 * ⚠️ **宽度走 `size`，不走 `styles.wrapper.width`**（antd 6 已废弃 `width`，控制台会打 warning）。
 * 所以本页的抽屉都摊开这一份 `{ size, styles }`：`size` 是宽度本身，`styles` 是
 * 「窄屏兜底 + 内容区 `padding: 0`」（内边距由各抽屉自己的内容给）。
 *
 * `push` 也在这里：二级抽屉打开时**被推开的正是这三个主抽屉**，
 * 而位移量取的是被推开那一方自己的配置（见 `MAIN_DRAWER_PUSH` 的注释）。
 */
const DRAWER_GEOMETRY = {
  size: WIDE_DRAWER_SIZE,
  styles: DRAWER_SEMANTIC_STYLES,
  push: MAIN_DRAWER_PUSH,
} as const;

/**
 * 「执行日志」**读取中 / 失败**那一支画的空抽屉：与 `AgentLogDrawer` 同几何
 * （同一份 `DRAWER_GEOMETRY`，不是照抄一遍——宽度改了这里必须跟着改）。
 * 单独一个常量而不是就地写两遍：读取中与失败两支本来就该一样宽。
 */
const LOG_FALLBACK_DRAWER = {
  placement: 'right',
  ...DRAWER_GEOMETRY,
  mask: { enabled: true, closable: true },
  destroyOnHidden: true,
} as const;

/**
 * 「这个候选还没开始跑」时抽屉吃的空模型。
 *
 * 为什么必须有一个**非空**的模型：抽屉的内部空态判据是 `model.empty`（文案「还没有日志 ·
 * 这个候选还没开始执行」），而 `empty === true` 与 `empty === false` 是**两种不同的空**
 * （三种空）——没有模型就没有事实条可画，故给一份如实为空的模型，
 * 而不是让抽屉在 `model === undefined` 上崩掉。
 *
 * 这一支只在**真的没跑过**（`status === 'pending'`）时用到：跑了却没有任何记录的候选
 * 走的是「有内容、但这一类内容没被转发」那一档（它的 `facts.live` / 节点能力位决定文案）。
 */
const NEVER_RAN_MODEL: AgentLogModel = {
  specVersion: 1,
  facts: {
    status: { tone: 'pending', label: '待开始' },
    startedAt: null,
    endedAt: null,
    turns: { current: 0, total: null },
    tokens: null,
    thinking: null,
    domain: [],
    error: null,
  },
  nodes: [
    {
      kind: 'main',
      id: 'main',
      parentId: null,
      spawnedBy: null,
      status: 'unknown',
      statusMissing: 'not-observed',
      startedAt: null,
      endedAt: null,
      content: { status: 'ready', data: [] },
      contentTruncatedReason: null,
      capability: {},
      capabilityNotes: [],
      source: 'wire',
      subagentId: null,
      vendorId: null,
      dispatchKind: null,
      name: null,
      nameMissing: null,
      userPrompt: null,
      usage: null,
      outcome: null,
      sessionFacts: null,
    },
  ],
  activeNodeId: 'main',
  candidateEvents: [],
  // 一次都没跑过 ⇒ 没有追问，也就没有段
  segments: [],
  empty: true,
};

/**
 * 日志抽屉的**数据来源**（`AgentLogSource`）：组件只在需要时喊一声，
 * 「取不取、缓存多久、怎么合并」由这里决定。三个口子都是可选的，
 * 缺一个只是那处如实降级（「未提供」/ 无入口 / 无重试按钮），**不崩溃**。
 *
 * 为什么收成一个对象而不是散成三个回调：散着放时，换一个消费场景会漂移成
 * 「接了 retry 忘了 diagnostics」，而漏接是**运行时的空白**、不是类型错误。
 */
function logSource(input: {
  runId: string;
  candidateId: string;
  refreshLog: () => void;
  refreshMessages: () => void;
}): AgentLogSource {
  const { runId, candidateId, refreshLog, refreshMessages } = input;
  return {
    /**
     * **环境信息已经按值给了**（`environment` props），故这里是一次空操作——
     * 但**不能省略这个口子**：`AgentLogLayout` 拿「它存不存在」判重试按钮画不画
     * （`undefined` ⇒ 无重试按钮）。省掉它，读取失败时就只剩一句错误、没有重试。
     */
    requestEnvironment: () => undefined,
    // 原始输出是**按需注入**的独立 Loadable（体积与时机两条理由）；
    // 这一条本仓今天没有端点，故如实留空 ⇒ 界面显示「未提供」，而不是永远转圈。
    requestDiagnostics: () => undefined,
    retryNode: () => {
      // 节点内容按值给（UI 不做取数），「重取」在这里就是重取这个候选的两条来源
      void runId;
      void candidateId;
      refreshLog();
      refreshMessages();
    },
  };
}

export default function Page(): ReactNode {
  // useSearchParams 需要 Suspense 边界：没有它，整页都会掉出预渲染
  return (
    <Suspense fallback={null}>
      <RunsPage />
    </Suspense>
  );
}

function RunsPage(): ReactNode {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { message } = App.useApp();
  const panel = parseRunsPanel(searchParams);
  const [drawer, setDrawer] = useState<OpenDrawer | null>(null);
  const { runs, isLoading, error: listError } = useRuns();
  // 详情与编辑都要这一轮的快照（编辑表单的预填只有这一个来源），故两态都取 id
  const selectedId = panel.panel === 'detail' || panel.panel === 'edit' ? panel.id : null;
  /**
   * **焦点 = 右栏正在看的那一轮**：全局提问浮层据此把其余轮次的未答提问**暂缓**
   * （不弹、不取消、仍在挂起表计时）；没在看某一轮（右栏关闭、或本页根本没选中）时是 `null`，
   * 浮层于是照旧弹全部。焦点放模块级单例而不是本页 state——浮层挂在页面壳外面，够不着这里。
   */
  useEffect(() => {
    setFocusedRun(selectedId);
  }, [selectedId]);
  /** 离开本页（切到别的路由即卸载）：不再有「在看某一轮」这回事，复位成「全部可弹」 */
  useEffect(() => () => setFocusedRun(null), []);
  const { run, error: runError } = useRun(selectedId);
  const { cases } = useCases();
  /**
   * 设置页那一格「默认评分智能体」是否已配置：开关打开而它没配时，创建表单要
   * **当场**给内联提示，而不是等候选跑完几分钟后才在评分阶段失败。
   * `settings === undefined`（SWR 首帧 / 读设置失败）时传 `undefined`：未知 ≠ 没配，
   * 不能把「还没读到设置」显示成「你没配」。
   */
  const { settings } = useSettings();
  const { optionsFor, capabilityOf, defaultEffortOf, messageCapabilityOf, turnInjectionOf } = useRunModelOptions();
  const { create, isCreating } = useCreateRun();
  const { update, isUpdating } = useUpdateRun();
  const { remove, isDeleting } = useDeleteRun();
  const { start, isStarting } = useStartRun();
  const { abort, isAborting } = useAbortRun();
  const { abortCandidate } = useAbortCandidate();
  const { rescoreCandidate, isRescoring } = useRescoreCandidate();
  const { retryCandidate, isRetrying } = useRetryCandidate();
  const runId = run?.id ?? '';
  const logCandidateId = drawer?.kind === 'log' ? drawer.candidateId : null;
  const diffCandidateId = drawer?.kind === 'diff' ? drawer.candidateId : null;
  /** 抽屉要渲染的那一行（评分详情那一支也用它；拿不到就整段不渲染）。排名抽屉没有候选 id，故恒 undefined */
  const logCandidate =
    drawer === null || drawer.kind === 'rank' ? undefined : run?.candidates.find((row) => row.id === drawer.candidateId);
  /**
   * 只在该候选的日志抽屉打开时才订阅它的事件流。
   * `attemptKey` 取这个候选的 `attempts`：重跑同一行时它会变，订阅因此重挂——不重挂的话
   * 抽屉会一直显示上一轮的原始输出（连接可能已被终态关掉，也可能还活着但游标停在上一代），
   * 而连接徽标照旧显示「实时连接中」（判据与理由见 `useCandidateStream` 的口径 5）。
   */
  const stream = useCandidateStream({
    runId,
    candidateId: logCandidateId ?? '',
    enabled: logCandidateId !== null,
    attemptKey: String(logCandidate?.attempts ?? 0),
  });
  /**
   * 跑动期的实时指标：**只为在跑的候选**各开一条连接，
   * 界面上的 tok / 轮次 / 耗时因此不必等这个候选结束。
   * 行集合每帧都是新数组：`useRunLiveMetrics` 内部按 join 出来的稳定键做依赖，
   * 所以这里不需要 useMemo（多一层记忆化只会多一个可能不同步的来源）。
   */
  const liveCandidateIds = (run?.candidates ?? []).filter((row) => isRunningCandidate(row.status)).map((row) => row.id);
  const live = useRunLiveMetrics({ runId, candidateIds: liveCandidateIds });
  /**
   * 活动行的**实时内容**：与上面那条指标流并列的另一路——它折的是 AgentMessage
   *，指标那条折的是事件。活动行把两者叠起来用：消息流有内容就以它为准，
   * 没有才回落到 `log.summary`（`live.latestText`）。
   * 行集合同样只取在跑的：终态那一行已经收起，多开连接只是浪费（`useRunActivity` 里也再挡一次）。
   */
  const activityCandidates = (run?.candidates ?? [])
    .filter((row) => isRunningCandidate(row.status))
    .map((row) => ({ id: row.id, status: row.status }));
  const activity = useRunActivity({ runId, candidates: activityCandidates });
  const log = useCandidateLog(runId, logCandidateId ?? '', logCandidateId !== null);
  /**
   * 时间轴的来源：内容级记录（消息 + 子任务行）。与上一条事件流**并列**、各自独立——
   * 「事件读不出来」不代表时间轴没东西可画，反过来也一样。
   */
  const messages = useCandidateMessages({ runId, candidateId: logCandidateId ?? '', enabled: logCandidateId !== null });
  /**
   * 人工消息的队列快照 + 写动作（发送 / 立即发送 / 删除 / 附件）：
   * **只在闸门开着且日志抽屉开着时订阅**（`enabled`）——闸门关着的一轮不许有人往它里面送话，
   * 那是服务端也认的同一条判据（`EvalRun.injectMessages`）。
   */
  const inject = useInjectMessages({
    runId,
    candidateId: logCandidateId ?? '',
    enabled: logCandidateId !== null && run?.injectMessages === true,
  });
  /**
   * 追问（第二期）：入口按钮的判据 + 写动作。
   *
   * **判据从服务端读**（`useFollowUpAvailability`）：七档拒绝里有一半的事实在盘上与厂商声明上，
   * 浏览器一格都看不到——界面自己编一句「这一家不支持续接」就是第二份说法。`revision` 带上
   * 每个候选的状态与会话 id：判据的前两档（正在跑 / 上一次没收尾）随候选状态翻转，而这一条读侧
   * 没有信号流；`useRun` 的快照一变这里就跟着重读一次。
   */
  const followUps = useFollowUpAvailability({
    runId,
    enabled: selectedId !== null,
    revision: (run?.candidates ?? [])
      .map((row) => `${row.id}:${row.status}:${row.sessionId === null ? '-' : row.sessionId}`)
      .join('|'),
  });
  const { followUpCandidate, isFollowingUp } = useFollowUpCandidate();
  /**
   * 索引是**分页**的（首帧只拉一页 30 条，其余按滚动逐页追加，**已加载的页不回收**），
   * 故这里自己累积已加载的文件：每次把新到的那一页接在后面，滚到底再由 `onLoadMore` 取下一页。
   * 不累积的话，头部写着「共 N 个文件」而列表只有 30 条，第 31 个之后的文件永远看不到。
   */
  const [diffOffset, setDiffOffset] = useState(0);
  const diffIndex = useCandidateDiffIndex(runId, diffCandidateId ?? '', diffCandidateId !== null, diffOffset);
  const [diffFiles, setDiffFiles] = useState<CandidateDiffIndex['files']>([]);
  /** 已经并入累积列表的页起点：同一页重渲染/重取时不重复追加 */
  const appendedOffsetRef = useRef<number | null>(null);
  /**
   * 实际明暗**读已解析的结果**，不在这里再解析一次。
   * `useResolvedTheme()` 的偏好缺省是 `'dark'`（SSR 兜底），不传偏好就会拿到暗色——
   * 既是第二份判据、又会把 `data-theme` 改回暗色，于是 ConfigProvider 是明亮主题、
   * diff 视图却按暗色渲染（症状：亮色主题下背景不对）。真正的解析在 `providers.tsx`。
   */
  const themeMode = useAppliedThemeMode();
  /** 当前评分详情对应的候选 id（不是评分抽屉时为 null）：footer 的入口与二级抽屉都以它为判据 */
  const scoreCandidateId = drawer?.kind === 'score' ? drawer.candidateId : null;
  /**
   * 评分详情对应的那一行（分与状态都在它身上）：`scoreDetail` 与「原始输出」入口的可见性都读它。
   * 候选状态也在这里取——**judging ⇔ 无分**（首评 / 重评的入口都会同步清分），两个判据读同一行才不会漂。
   */
  const scoreCandidate = scoreCandidateId === null ? undefined : run?.candidates.find((row) => row.id === scoreCandidateId);
  /**
   * 评分详情抽屉要的**两样东西来自同一份 run 快照**：这个候选的 `score` 与这一轮的评分表 `rubric`
   * ——评分表是这一分生成时那张表的快照（与 `score.maxScore` 同源），改用例不会换掉它，
   * 而详情正是按**引用键**把判定与评分表逐项对齐的（少了这张表，逐项判定一项也画不出来）。
   * 「这一分是谁打的、花了多少」那**五格**也全在 `score` 上 ⇒ 这里**不再递候选**：
   * 那是执行那一份数据，而抽屉叫「评分详情」。
   * 合成一个对象再判空：拆成多个变量时 JSX 里得各自判空，而「有分却没表」那一格一旦漏判，
   * 渲染出的是一张对不上任何判定的空表。
   */
  const scoreDetail = ((): { score: ScoreResult; rubric: Rubric } | null => {
    if (run === undefined || scoreCandidate === undefined || scoreCandidate.score === null) return null;
    return { score: scoreCandidate.score, rubric: run.rubric };
  })();
  /**
   * 「原始输出 N 条」二级抽屉（评分那条流）的开合：入口按钮挂在评分详情抽屉的 `footer` 上，
   * 故状态住在页面这一层，视图是**受控**的。
   *
   * **记的是「哪一行开着」，不是一个 boolean**：换行、关抽屉、URL 深链三条路都会换 `candidateId`，
   * 用 boolean 就得在每一处记得清掉它，漏一处的症状是「点开另一候选的评分详情，二级抽屉自己弹出来」
   * ——那种 bug 只在特定点击顺序下出现。带上候选 id 之后判据自动为假（关抽屉时 `drawer` 已是 null）。
   */
  const [judgeOutputCandidateId, setJudgeOutputCandidateId] = useState<string | null>(null);
  const judgeOutputOpen = scoreCandidateId !== null && judgeOutputCandidateId === scoreCandidateId;
  /** 这个候选正在评分（judging）吗：SSE 的开关（judging 才接，终态行只拉历史） */
  const judgeLive = scoreCandidate?.status === 'judging';
  /**
   * 「原始输出」入口的可见性（设计口径）：**有分**时按 `score.judgeAgentKind` 判——文本 API 评分
   * 没有评审会话（`judge-events.jsonl` 不存在）⇒ 不渲染；智能体评分的候选**常驻**（含 0 条：
   * 空态写在二级抽屉的正文里，不靠藏按钮表达）。**评分进行中**（judging ⇔ 无分，
   * `judgeAgentKind` 要等分落下来才有）按轮级开关 `run.useAgentJudge` 判。重跑候选
   * （running）期间不渲染——评审还没开始，那时文件已被清空、一个字都不剩。
   */
  const judgeOutputVisible =
    scoreCandidate !== undefined &&
    ((scoreDetail !== null && scoreDetail.score.judgeAgentKind !== null) ||
      (run?.useAgentJudge === true && judgeLive));
  /**
   * 评分那条事件流（评审者自己的流水）：入口可见才取数；judging 才接 SSE（空闲零连接）。
   * `live` 进依赖 ⇒ judging → 终态的翻转会把 effect 重挂一次、历史重读成终值（口径见
   * `judge-events.ts` 文件头）；分落进行里那一刀不归它管（run 信号流的职责）。
   */
  const judgeOutput = useCandidateJudgeEvents({
    runId,
    candidateId: scoreCandidateId ?? '',
    enabled: judgeOutputVisible,
    live: judgeLive,
  });
  /** 折成「原始输出」面板的候选（`log` 事件逐字原文）：与执行日志抽屉共用同一个折法 */
  const judgeDiagnostics = useMemo(() => diagnosticsOf(judgeOutput.events), [judgeOutput.events]);
  /** 入口按钮与二级抽屉标题同文（`rawOutputLabel` 是同一份实现）：ready 才带条数，读取中 / 失败不带 */
  const judgeOutputLabel = rawOutputLabel(judgeOutput.status === 'ready' ? judgeDiagnostics.lines.length : null);

  /**
   * 「产物总览」：这一轮各候选工作区根下的 `RESULT.*` 清单 + 二级抽屉的开合。
   *
   * **只在排名抽屉打开时才扫盘**（`enabled`）：一次扫描 = 每个候选一次 `readdir`，
   * 页面开着一个没打开排名的详情时扫它没有意义。
   * 开关记的是 boolean 而不是「哪一行」：它属于**整轮**，没有行这一维（与 `judgeOutputCandidateId` 那类不同）；
   * 关掉排名抽屉时在它的 `onClose` 里一并复位——否则重开排名抽屉时二级抽屉会自己弹出来。
   */
  const artifacts = useRunArtifacts(runId, drawer?.kind === 'rank');
  const [artifactOpen, setArtifactOpen] = useState(false);

  /** 换一行（或重开抽屉）时把累积清空，免得看到上一候选的文件 */
  useEffect(() => {
    setDiffFiles([]);
    setDiffOffset(0);
    appendedOffsetRef.current = null;
  }, [diffCandidateId, runId]);

  /** 把新到的那一页并进累积列表；同一页只并一次（SWR 重取/重渲染都会再跑这个 effect） */
  useEffect(() => {
    const page = diffIndex.index;
    if (page === undefined) return;
    // 只认「当前请求的那一页」：翻页途中上一个响应晚到，会把错误的页并进来；
    // 并进去之后 `diffFiles.length` 变了、`onLoadMore` 又按它算下一页 ⇒ 一个自我维持的加载循环
    if (page.offset !== diffOffset) return;
    if (appendedOffsetRef.current === page.offset) return;
    appendedOffsetRef.current = page.offset;
    setDiffFiles((previous) => (page.offset === 0 ? page.files : [...previous, ...page.files]));
  }, [diffIndex.index, diffOffset]);

  /**
   * 日志抽屉显示什么：判定与文案都在 `resolveLogDrawer`（纯函数 + 有测试面）。
   * **`failed` 那一支不能渲染抽屉内容**：它在两条来源都空时的空态是
   * 「还没有日志 · 这个候选还没开始执行」，与「读不出来」一起出现会把一个带文件路径的真实故障
   * 说成「还没开始跑」。`stream.error` 也必须进去（它过去被这里丢掉）：断线时徽标只显示
   * 「未连接」而没有原因，使用者分不清「这个候选还没开始跑」与「实时通道连不上」。
   *
   * `recordCount` 是**第二条来源**（内容记录）：它非零时即使一条事件都没有，时间轴仍有东西可画，
   * 故不该整段替换成故障提示。
   */
  const logState = resolveLogDrawer({
    events: stream.events,
    recordCount: messages.records.length,
    logError: log.error,
    streamError: stream.error,
    isLoading: log.isLoading || messages.isLoading,
  });

  /**
   * 事实条与时间轴模型：**页面只做拼装**——`buildCandidateFacts`（候选级事实的界面口径）与
   * `buildAgentLogModel`（契约形状 → 界面模型）都是纯函数，各自有守卫。
   *
   * 为什么不在这里拼 `AgentLogModel`：那是数据层的活（它才认识 `mergeKey` / 轮次号的换算），
   * 而把它摊在页面里意味着页面读源码守卫才能钉住形状。这里的 `useMemo` 依赖三个输入，
   * 为的是「一次上游提交只重建一次」（父组件因 SSE 重渲染时不重算）。
   */
  const logFacts = logCandidate === undefined ? null : buildCandidateFacts({ row: logCandidate, events: stream.events });
  /**
   * 这个候选的**能力声明**：五格各自带「从哪条通道取到 / 为什么取不到」。
   *
   * 按**行**取而不是按轮取：同一轮的不同一候选可以是不同智能体，取错一个候选就会把
   * 「codex 的思考正文只在会话文件里」说成「claude 的流式增量没投送」。
   * 拿不到（元数据还没到 / 后端没给这一格）就是 `null`——**不编一份「都支持」**，
   * 装配层会如实回落成「没验证过」。
   */
  const logCapability = logCandidate === undefined ? null : messageCapabilityOf(logCandidate.agentKind);
  const logModel =
    logFacts === null
      ? null
      : buildAgentLogModel({
        records: messages.records,
        events: stream.events,
        facts: logFacts,
        startedAt: logFacts.startedAt,
        // 工作目录的绝对前缀不进折叠标题：摘要里的路径在这一步相对化（判据在 `buildAgentLogModel`）
        workspacePath: logCandidate?.workspacePath ?? '',
        // 声明缺失时**不传这一格**（装配层回落成「没验证过」），而不是传一份空 map：
        // 空 map 与「五格都 yes」在界面上都长得像「有声明」，而那两件事完全不同
        ...(logCapability === null ? {} : { capability: toCapabilityMap(logCapability) }),
        // 能力成立的**前提**（路由 / 模型 / 开关）：空数组 = 无条件成立，如实照抄服务端的 notes
        capabilityNotes: logCapability?.notes ?? [],
      });
  const logDiagnostics = useMemo(() => diagnosticsOf(stream.events), [stream.events]);

  /**
   * 环境信息：**按值给**抽屉，不新开端点——四组数据页面都已经拿在手上
   * （运行配置来自 `EvalCandidate` / `EvalRun` 的快照字段、厂商系统层来自事件流里的 `system/init` 行、
   * 实测统计来自内容记录里的 `tool-call`）。
   *
   * 为什么不做成「点了才取」：`requestEnvironment` 那一格存在意义是**把取数时机从组件里搬出去**，
   * 而这里的「取数」是本进程内一次纯函数调用 ⇒ 按值给才是它该有的形态，
   * 点开即有内容，不必先闪一下「读取中」。`logSource` 里仍然保留那个口子，见那里的注释。
   */
  // 「未选档位」时这个候选会落到哪一档（注册表元数据）：运行配置那一格照着它写，
  // 界面里不写死厂商名与档位（见 `build-environment.ts` 的 `effortLine`）。
  // 先取进常量：下面那个对象字面量里连着判两次同一个值，读的人得自己证「两次结果相同」。
  const defaultEffort = logCandidate === undefined ? undefined : defaultEffortOf(logCandidate.agentKind);
  const logEnvironment: Loadable<AgentEnvironment> | undefined = useMemo(
    () =>
      logCandidate === undefined
        ? undefined
        : {
          status: 'ready',
          data: buildAgentEnvironment({
            row: logCandidate,
            workspaceBase: run?.workspaceBase ?? '',
            events: stream.events,
            records: messages.records,
            ...(defaultEffort === undefined ? {} : { defaultEffort }),
          }),
        },
    [logCandidate, run?.workspaceBase, stream.events, messages.records, defaultEffort],
  );

  const logSourceRef = useMemo(
    () =>
      logCandidateId === null
        ? undefined
        : logSource({ runId, candidateId: logCandidateId, refreshLog: log.refresh, refreshMessages: messages.refresh }),
    [runId, logCandidateId, log.refresh, messages.refresh],
  );

  /**
   * `image-view` 块缩略图的 URL：**接线在页面**——只有这里知道这个候选是哪一轮的哪一行。
   * 入参是数据层换算好的**工作区相对路径**（不在工作区内时根本不会走到这里），
   * 故这里只做一件事：拼那条读工作区字节的路由。`encodeURIComponent` 必须给：
   * 文件名里可能有空格、`#`、`%`，不编码时请求会落到另一条路径上。
   */
  const imageSrcOf = useMemo(
    () =>
      logCandidateId === null
        ? undefined
        : (previewPath: string): string =>
          `/api/runs/${runId}/candidates/${logCandidateId}/image?path=${encodeURIComponent(previewPath)}`,
    [runId, logCandidateId],
  );

  /**
   * 底部槽里的**输入区**：只有「这一轮的闸门开着 **且** 这个候选此刻还有活在跑」时才渲染。
   *
   * 为什么要判候选状态：队列表的取件发生在**这个候选**的投递循环里（适配器收工时那次 `drain`），
   * 一行已经收场之后再送话，那一条永远等不到取件——界面给一个发了也没人收的输入区，
   * 等于把「投不进去」说成「能投」。`isRunningCandidate` 是契约里那一条（与「能不能重评/重跑」
   * 同一个落点），不在这里另写一份判据。
   *
   * 声明按**这个候选自己的家**取（同一轮的不同一候选可以是不同智能体）：`null` 读作「不知道」，
   * 界面据此置灰并如实说「读不到声明」，**不编一份「都支持」**。
   */
  const injectFooter =
    run?.injectMessages === true && logCandidate !== undefined && isRunningCandidate(logCandidate.status) ? (
      <InjectComposer
        messages={inject.messages}
        declaration={turnInjectionOf(logCandidate.agentKind)}
        busy={inject.busy}
        onSend={async (input) => {
          await inject.send({
            runId,
            candidateId: logCandidate.id,
            messageId: input.messageId,
            text: input.text,
            attachments: input.attachments,
            requires: input.requires,
          });
        }}
        onPromote={async (messageId) => {
          await inject.promote(messageId);
        }}
        onRetract={async (messageId) => {
          await inject.retract(messageId);
        }}
        // 先落盘拿到路径、再点发送：附件目录名用同一条草稿的 id
        onUploadAttachment={async (input) => inject.uploadAttachment(input.messageId, input.file)}
        // 失败原因交回这里呈现（`describeError`：ServiceError 的中文 message 直接展示）
        onError={(cause) => void message.error(describeError(cause))}
      />
    ) : undefined;

  /**
   * 追问的**输入区**：只在「这个候选是点「追问」打开的、且它此刻不在跑」时渲染。
   *
   * 与运行中那条输入区互斥（那一支的判据是 `isRunningCandidate`）：行在跑时「追问」按钮本来就是禁用的
   * （判据在服务端那一份里），这里再挡一次是为了「抽屉先开着、候选随后跑起来」那一拍——
   * 那一刻该显示的是排队输入区（`injectFooter`），而不是一个点了会被 409 拒的追问框。
   * `onUploadAttachment` 走的是**同一条 multipart 端点**：附件落点就是同一个
   * `candidateDir/attachments/<messageId>/`（生命周期挂在候选目录上，不按入口分两处）。
   */
  const followUpFooter =
    drawer?.kind === 'log' && drawer.followUp === true && logCandidate !== undefined && !isRunningCandidate(logCandidate.status) ? (
      <FollowUpComposer
        busy={isFollowingUp}
        onSend={async (input) => {
          await followUpCandidate({
            runId,
            candidateId: logCandidate.id,
            messageId: input.messageId,
            text: input.text,
            attachments: input.attachments,
          });
          // 发出去之后这个候选会翻成「准备中」：判据（能否追问）跟着变，顺手重读一次
          await followUps.refresh();
        }}
        onUploadAttachment={async (input) => postInjectAttachment({ runId, candidateId: logCandidate.id, ...input })}
        onError={(cause) => void message.error(describeError(cause))}
      />
    ) : undefined;

  /**
   * 底部槽这一格**只有两个可能**：追问输入区（这个候选跑完了、人是点「追问」进来的）或
   * 运行中的排队输入区。两支互斥（判据见上面各自的注释），缺席时一个节点都不渲染。
   */
  const logFooter = followUpFooter ?? injectFooter;

  /** 每次操作都收口到 `describeError`：ServiceError 的中文 message 直接展示，其余给兜底文案 */
  const guard = async (action: () => Promise<unknown>): Promise<void> => {
    try {
      await action();
    } catch (cause) {
      void message.error(describeError(cause));
    }
  };

  /**
   * 创建：把表单交回的 `RunFormValues` 收敛成契约的 `RunCreate`。
   * **显式剥掉 `id`**（不依赖 zod 对未知键的静默剥离）：创建路径不接受行身份这件事必须写在
   * 这里看得见的地方——靠 `RunCreateSchema` 的 strip 是隐式的，将来谁把 schema 改成 strict
   * 就会在运行期多出一堆 400。
   * `effort` 必须一起带上：契约显式声明了这一格，漏掉就是静默丢掉用户选的思考强度；
   * `note` 同理——它在契约里是可选键，类型不会提醒，漏掉就是「界面填了备注、落库却没有」。
   */
  const handleCreate = async (values: RunFormValues): Promise<void> => {
    const input: RunCreate = {
      caseId: values.caseId,
      note: values.note,
      executionMode: values.executionMode,
      useAgentJudge: values.useAgentJudge,
      askUser: values.askUser,
      injectMessages: values.injectMessages,
      // 三个必填字段与 effort 保持同一行：`runs-page-wiring.test.ts` 按这一串文本钉住「创建路径重映射过」
      candidates: values.candidates.map((row) => ({
        agentKind: row.agentKind, providerId: row.providerId, modelId: row.modelId, effort: row.effort,
      })),
    };
    try {
      const created = await create(input);
      // 创建完直接进详情：使用者下一步一定是点「开始」
      router.replace(runsPanelHref('detail', created.id));
    } catch (cause) {
      void message.error(describeError(cause));
    }
  };

  /**
   * 编辑：把在途请求的 promise **交回给表单**（`RunCreatePanel` 的 `onSubmit` 注释写明了原因：
   * 返回 undefined 时保存前的确认框会立刻关闭并显示成「点一下没反应」）。
   * `RunFormValues` 与契约的 `RunUpdate` 逐字段一致（含候选 id 与 effort），故原样交给数据层——
   * 在这里再抄一遍字段只会静默丢掉后来新增的格子。
   */
  const handleUpdate = async (values: RunFormValues): Promise<void> => {
    if (run === undefined) return;
    try {
      await update(run.id, values);
      void message.success('评测已保存');
      router.replace(runsPanelHref('detail', run.id));
    } catch (cause) {
      // 失败就留在编辑态（不跳转）：中文原因由服务端给，改完可以原地再存一次
      void message.error(describeError(cause));
    }
  };

  /**
   * 删除：**必须把在途 promise 交回确认框**（`RunDetailPanel` 的 `onDelete` 注释写明了原因）。
   * `workspaceRemoved === false` 时如实说一句「有残留」——盘子上的候选工作区没能回收，
   * 那既不等于删除失败，也不该假装干净。
   */
  const handleDelete = (): Promise<void> | undefined => {
    if (run === undefined) return undefined;
    return remove(run.id)
      .then((result) => {
        void message.success(result.workspaceRemoved ? '评测已删除' : '评测已删除；候选工作区有残留（被占用），可手动清理');
        // 删除后回列表（无右栏）：右栏留在一条已经不存在的轮次上没有意义
        closePanel();
      })
      // 失败在这里收束：把 reject 交回给 antd 只会在控制台留一条未处理的 rejection，
      // 用户已经在 message.error 里拿到了中文原因
      .catch((error) => void message.error(describeError(error)));
  };

  const closePanel = (): void => {
    setDrawer(null);
    router.replace(runsPanelHref(null, null));
  };

  /** 下载用 `/log` 的全量（而不是连接里收到的那份）：连接可能中途断过，落盘的那份才是完整的 */
  const handleDownloadLog = (): void => {
    const text = formatEventLog(log.events ?? stream.events);
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `row-${logCandidateId ?? 'log'}.log`;
    link.click();
    // 立即 revoke 会让部分浏览器拿不到内容，下一拍再释放
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  const columns: TableColumnsType<EvalRun> = [
    {
      // 列名只叫「标题」：与用例页的列表头逐字同形，左栏就一列标题，不必再冠以「用例」
      title: '标题',
      dataIndex: 'caseTitle',
      // 显示与排序**共用同一份拼法**（`runListTitle`）：备注非空时是「用例标题 · 备注」，
      // 否则只有用例标题。两处各拼一份的漂移症状是「看到的和排的不是一回事」。
      // 标题本身是**快照**（`caseTitle`）：用例改名不会改写历史轮次，所以排/显的都是历史标题。
      // 文本列首次点击升序：antd 的默认 `sortDirections` 是 `['ascend','descend']`，不用显式给
      sorter: (a: EvalRun, b: EvalRun) => compareSortText(runListTitle(a), runListTitle(b)),
      // 钉在左边：横向滚动时其余四列从它下面滑过，「这个候选是哪个用例的评测」
      // 始终看得见。第一列的 sticky `left` 恒为 0，**不依赖自身申报宽度**（要靠前面列宽累加的是
      // 第二个之后的固定列，本表没有），所以下面那条「不传 width」的口径原样保留。
      fixed: 'left',
      // 不传 width：与用例页同口径——省略号落在单元格右边缘，栏位拖宽后长标题多显示
      // （写死 px 时文字块比单元格宽，超出的一段连同省略号一起被单元格裁掉）
      render: (_caseTitle: string, record) => <EllipsisText text={runListTitle(record)} />,
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: RUN_COLUMN_WIDTH.status,
      // 生命周期正序（未开始 → 执行中 → 部分完成 → 已完成）首次即升序：默认 `sortDirections` 就够
      sorter: (a: EvalRun, b: EvalRun) => RUN_STATUS_RANK[a.status] - RUN_STATUS_RANK[b.status],
      render: (status: EvalRun['status']) => <Tag color={RUN_STATUS_META[status].color}>{RUN_STATUS_META[status].label}</Tag>,
    },
    {
      title: '候选数',
      dataIndex: 'candidates',
      width: RUN_COLUMN_WIDTH.candidates,
      align: 'left',
      render: (_candidates, record) => record.candidates.length,
    },
    {
      title: '执行模式',
      dataIndex: 'executionMode',
      width: RUN_COLUMN_WIDTH.executionMode,
      render: (mode: EvalRun['executionMode']) => (mode === 'serial' ? '串行' : '并行'),
    },
    {
      title: '创建时间',
      dataIndex: 'createdAt',
      width: RUN_COLUMN_WIDTH.createdAt,
      // 默认排序：进入页面就是「创建时间」倒序。
      // 用 `defaultSortOrder`（非受控初值）而不是 `sortOrder`：声明后者等于接管三态推进，
      // 表头箭头的展示与状态推进仍由 antd 自己负责（写 `sortOrder` 就必须回写它，漏一次就点不动）。
      defaultSortOrder: 'descend',
      // 时间列首次点击降序（先给「最新在前」才符合直觉）：`sortDirections` 的首项就是首次方向
      sortDirections: ['descend', 'ascend'],
      sorter: (a: EvalRun, b: EvalRun) => compareSortTime(a.createdAt, b.createdAt),
      render: (createdAt: string) => formatDateTime(createdAt),
    },
  ];

  const list = (
    <Flex vertical style={{ height: '100%', minHeight: 0 }}>
      <Toolbar
        extra={
          // 创建 / 添加类按钮全站同形：前导加号 + 虚线边框。两个细节都不能省：
          // ① `color="default"` 与 `variant="dashed"` 必须成对给——antd 6 的 `variant` 单给会静默降级成实线；
          // ② 图标 `aria-hidden`：`@ant-design/icons` 自带 `role="img" aria-label="plus"`，
          // 不藏起来可访问名会变成「plus 创建评测」
          <Button
            color="default"
            variant="dashed"
            size="small"
            icon={<PlusOutlined aria-hidden />}
            onClick={() => router.replace(runsPanelHref('new', null))}
          >
            创建评测
          </Button>
        }
      />
      {listError !== null && listError !== undefined && (
        <Alert type="error" showIcon title={`评测列表加载失败：${describeError(listError)}`} />
      )}
      {runs !== undefined && runs.length === 0 ? (
        <EmptyState
          title="还没有评测"
          description="先创建一个用例，再用它开一轮评测"
          action={{
            label: '创建评测',
            icon: <PlusOutlined aria-hidden />,
            variant: 'dashed',
            onClick: () => router.replace(runsPanelHref('new', null)),
          }}
        />
      ) : (
        // 纵向还是外层容器滚：`scroll={{ y }}` 会让 rc-table 把 `.ant-table-body` 的 `overflow-y`
        // 写死成 `scroll`，数据没超出也常驻一条空滚动条（口径见 `TableScrollArea` 的文件头）。
        // 表头由 `sticky` 钉住；容器在工具栏**下面**，工具栏不跟着滚走。
        <TableScrollArea>
          {/* 显式给行类型（`<Table<EvalRun>>`）：`columns` 的 `TableColumnsType<EvalRun>` 与
              `onRow` 的 `record` 都靠它对齐；`list-table-scroll-wiring.test.ts` 也按 `<Table<` 钉住
              「表格在滚动容器里面」这一条 */}
          <Table<EvalRun>
            size="small"
            rowKey="id"
            loading={isLoading}
            columns={columns}
            dataSource={runs ?? []}
            pagination={false}
            sticky
            // 只给 `x`（**只开横向**，纵向那一位仍留给外层容器）：它是「左栏够不够宽」的判据本身——
            // 表格拿到 `width: 662px` + `min-width: 100%`，窄于 662 时内部横向滚动（标题钉在左侧），
            // 宽于 662 时按 100% 铺满、一条滚动条都不出现。给 `true` 等于没有下限，给 `'max-content'`
            // 则按最宽内容撑开 —— 两者都让固定列失效（理由详见 `RUNS_TABLE_MIN_WIDTH`）。
            // ⚠️ 与 `sticky` 同时在场是安全组合：rc-table 在 `fixHeader || isSticky` 分支里把
            // `scrollXStyle` 落在 `.ant-table-body` 上、表头另拆成 `.ant-table-sticky-holder`，
            // 所以横向滚动不会把吸顶的表头一起带走（真机几何见本轮冒烟记录）。
            scroll={{ x: RUNS_TABLE_MIN_WIDTH }}
            // 同用例页：列宽由表头算，`EllipsisText` 的省略号才有确定的分母。
            // `sticky` 本就会让 rc-table 落到 `fixed`，显式写出来是为了不把这条前提交给巧合
            tableLayout="fixed"
            onRow={(record) => ({
              onClick: () => router.replace(runsPanelHref('detail', record.id)),
              style: record.id === selectedId ? { background: 'var(--app-selected)', cursor: 'pointer' } : { cursor: 'pointer' },
            })}
          />
        </TableScrollArea>
      )}
    </Flex>
  );

  const detail =
    panel.panel === 'new' ? (
      <RunCreatePanel
        // **原样交出去，不许写 `cases ?? []`**：未知（首帧 / 读失败）与「一个用例都没有」对编辑表单是
        // 两件事——`[]` 会让它把「还没读到」判成「当前用例已被删除」（见面板 `caseOptions` 那一段）。
        // 两个面板同此口径（与本页 `judgeAgentConfigured` 的「未知 ≠ 没配」同源）。
        cases={cases}
        modelOptionsFor={optionsFor}
        defaultEffortOf={defaultEffortOf}
        judgeAgentConfigured={settings === undefined ? undefined : settings.defaultJudgeAgent !== null}
        saving={isCreating}
        onSubmit={(values) => void handleCreate(values)}
        onCancel={closePanel}
      />
    ) : panel.panel === 'edit' && run !== undefined ? (
      // 快照没到之前**不渲染编辑面板**（`&& run !== undefined` 是条件本身，不是冗余判断）：
      // 编辑表单的预填只有 `initial` 一个来源，拿不到快照就只剩一张空白表单，而它是**全量替换**语义
      // ——照着它保存会把这一轮已有的候选整批换掉。等下面那两条 loading / not-found 分支即可。
      <RunCreatePanel
        mode="edit"
        initial={run}
        // 同上面那一处：`cases` 未知时原样传 undefined（直开 / 刷新编辑链接时它常比快照后到）
        cases={cases}
        modelOptionsFor={optionsFor}
        defaultEffortOf={defaultEffortOf}
        judgeAgentConfigured={settings === undefined ? undefined : settings.defaultJudgeAgent !== null}
        saving={isUpdating}
        // **直接交函数，不写成 `(values) => void handleUpdate(values)`**：`void` 让箭头函数返回
        // undefined，保存前的确认框就不再等这一笔 PUT（`RunCreatePanel` 的 `onSubmit` 注释同此口径）。
        onSubmit={handleUpdate}
        // 取消回详情而不是回列表：用户是从详情点进来的，退回一步才是原位
        onCancel={() => router.replace(runsPanelHref('detail', run.id))}
      />
    ) : selectedId === null ? null : runError !== null && runError !== undefined && run === undefined ? (
      <EmptyState
        title="评测不存在或已被删除"
        description="它可能被手工清理过；回到列表重新选择一轮"
        action={{ label: '回到列表', onClick: closePanel }}
      />
    ) : run === undefined ? (
      // 快照没到 ⇒ 按详情面板的形状摆骨架（不是空态：空态会被读成「这一轮没有候选」）。
      // 编辑态也走这一支：它同样在等这一份快照，而骨架的尺寸与真实右栏一致，换内容时不会整栏重排。
      <RunDetailSkeleton />
    ) : (
      <RunDetailPanel
        run={run}
        starting={isStarting}
        aborting={isAborting}
        capabilityOf={capabilityOf}
        liveOf={(candidateId) => live[candidateId]}
        activityOf={(candidateId) => activity[candidateId]}
        onStart={() => void guard(() => start(run.id))}
        onAbortRun={() => void guard(() => abort(run.id))}
        onAbortCandidate={(candidateId) => void guard(() => abortCandidate(run.id, candidateId))}
        onRescoreCandidate={(candidateId) => void guard(() => rescoreCandidate(run.id, candidateId))}
        rescoring={isRescoring}
        onRetryCandidate={(candidateId) => void guard(() => retryCandidate(run.id, candidateId))}
        retrying={isRetrying}
        // 「追问」只打开这个候选的抽屉（输入区在 footer 上），故它没有自己的写请求：
        // 真正的承诺在那一句话发出去的时候，不需要额外一道确认
        onFollowUpCandidate={(candidateId) => setDrawer({ kind: 'log', candidateId, followUp: true })}
        followUpOf={followUps.verdictOf}
        followingUp={isFollowingUp}
        onOpenLog={(candidateId) => setDrawer({ kind: 'log', candidateId })}
        onOpenDiff={(candidateId) => setDrawer({ kind: 'diff', candidateId })}
        onOpenScore={(candidateId) => setDrawer({ kind: 'score', candidateId })}
        // 排名抽屉比的是候选之间的名次：它没有「哪一行」这一维，故不开候选 id
        onOpenRank={() => setDrawer({ kind: 'rank' })}
        onEdit={() => router.replace(runsPanelHref('edit', run.id))}
        onDelete={handleDelete}
        deleting={isDeleting}
      />
    );

  return (
    <>
      <AppTopNav items={[...NAV_ITEMS]} active="runs" onNavigate={(href) => router.push(href)} />
      <ListDetailLayout list={list} detail={detail} detailOpen={panel.panel !== null} widthStorageKey="runs-detail-width" />

      {/*
        「执行日志」抽屉：**几何与滚动容器的归属都在 `AgentLogDrawer` 里**，
        页面不套 `Drawer`、也不给内边距——它内部要自持一个确定高度的视口（虚拟列表需要它），
        外面再包一层会让那条高度链断掉（表现为整页被内容撑长、该出现的滚动条不出现）。
        宽度与语义槽样式取自同一个 `DRAWER_GEOMETRY`（组件内引的是同一份常量），
        故它与下面的「变更详情」「评分详情」**必然等宽**。

        **读取中那一支什么都不渲染**（2026-10-03 用户口径「点开会闪一下」的修法）：那时 `model`
        还没算出来，弹出来的是空壳，而它会把真抽屉的入场动画重置（遮罩与面板各重放一次）。
        **故障那一支仍然整段替换**（既有口径不变）：抽屉内部的空态是
        「还没有日志 · 这个候选还没开始执行」，与「读不出来」一起出现会把一个带文件路径的真实故障
        说成「还没开始跑」。两条来源的**非破坏性**提示（有数据时的实时通道故障 / 读失败）
        照旧交给抽屉渲染，不藏真数据。
      */}
      {logState.kind === 'loading' ? null : logState.kind === 'failed' ? (
        <Drawer {...LOG_FALLBACK_DRAWER} title="执行日志" open={drawer?.kind === 'log'} onClose={() => setDrawer(null)}>
          <div style={{ padding: 16 }}>
            <Alert
              data-testid="run-log-drawer-failed"
              type="error"
              showIcon
              title="执行日志读取失败"
              description={logState.message}
            />
          </div>
        </Drawer>
      ) : (
        <AgentLogDrawer
          open={drawer?.kind === 'log'}
          onClose={() => setDrawer(null)}
          model={logModel ?? NEVER_RAN_MODEL}
          diagnostics={{ status: 'ready', data: logDiagnostics }}
          {...(logEnvironment === undefined ? {} : { environment: logEnvironment })}
          {...(logSourceRef === undefined ? {} : { source: logSourceRef })}
          {...(imageSrcOf === undefined ? {} : { imageSrcOf })}
          onDownload={handleDownloadLog}
          // 工具条上的「追问」入口：与候选卡片那颗是同一个动作，但它是**开合**——
          // 抽屉已经开着，点一下把底部槽切成追问输入区，再点一下收回去（不重新路由、不关抽屉）。
          // 判据直接读服务端那一份（`followUps`），点下去与按钮上的话永远一致。
          onFollowUp={() => {
            if (logCandidateId === null) return;
            const open = drawer?.kind === 'log' && drawer.followUp === true;
            setDrawer({ kind: 'log', candidateId: logCandidateId, followUp: !open });
          }}
          followUpVerdict={logCandidateId === null ? undefined : followUps.verdictOf(logCandidateId)}
          // 非破坏性提示：判定在纯函数里（`resolveLogDrawer`），渲染在 `AgentLogLayout` 里。
          // **有真数据时如实说明，不把它藏起来**——两条来源的故障各占一个提示位。
          notice={logState.warning === undefined ? undefined : `日志可能不完整：${logState.warning}`}
          liveError={logState.liveError}
          connected={stream.connected}
          // 底部槽（第三段固定区）：运行中那一支是排队/插队输入区，跑完之后那一支是追问输入区
          {...(logFooter === undefined ? {} : { footer: logFooter })}
        />
      )}

      <Drawer
        title="变更详情"
        placement="right"
        {...DRAWER_GEOMETRY}
        open={drawer?.kind === 'diff'}
        onClose={() => setDrawer(null)}
        destroyOnHidden
      >
        {diffIndex.index === undefined ? (
          <div style={{ padding: 16 }}>
            <Typography.Text type="secondary">
              {diffIndex.error === null || diffIndex.error === undefined
                ? '正在计算改动…'
                : `读取失败：${describeError(diffIndex.error)}`}
            </Typography.Text>
          </div>
        ) : (
          <DiffView
            // 列表给**累积**的那些文件，计数与截断信息仍取本页响应（它们是全局值）
            index={{ ...diffIndex.index, files: diffFiles }}
            dark={themeMode === 'dark'}
            {...(diffFiles.length < diffIndex.index.total ? { onLoadMore: () => setDiffOffset(diffFiles.length) } : {})}
            renderFileBody={(path) => (
              <DiffFileBody runId={runId} candidateId={diffCandidateId ?? ''} path={path} dark={themeMode === 'dark'} />
            )}
          />
        )}
      </Drawer>

      <Drawer
        title="评分详情"
        placement="right"
        {...DRAWER_GEOMETRY}
        open={drawer?.kind === 'score'}
        onClose={() => setDrawer(null)}
        destroyOnHidden
        /*
          「原始输出 N 条」入口在 **footer** 上：不占正文的高度、也不随正文一起滚走；
          正文里既没有标题也没有按钮。
          可见性判据是 `judgeOutputVisible`（智能体评分的候选常驻、评分进行中也开、
          文本 API 与 running 期间没有）；不可见时 footer 整段为 null。
        */
        footer={
          judgeOutputVisible ? (
            <Flex justify="flex-end" gap={8}>
              <Button
                size="small"
                autoInsertSpace={false}
                data-testid="score-judge-output-open"
                onClick={() => setJudgeOutputCandidateId(scoreCandidateId)}
              >
                {judgeOutputLabel}
              </Button>
            </Flex>
          ) : null
        }
      >
        {scoreDetail === null ? (
          <div style={{ padding: 16 }}>
            <EmptyState title="这个候选还没有评分" description="评分在 agent 跑完之后进行；失败的候选不会有分" />
          </div>
        ) : (
          <ScoreDetailView
            // 抽屉里的**五格**全在 `score` 上（顶部那一段说的是**这一分**是谁打的、
            // 花了多少）⇒ 这里只递 `score` 与它的评分表快照，**不再传候选**——少一个能配错的来源
            score={scoreDetail.score}
            rubric={scoreDetail.rubric}
            // 「原始输出」那一组（口径见 ScoreJudgeOutputProps）：可见性已在 judgeOutputVisible
            // 判过，这里只管折数据——错误折成中文（describeError）、三态交给视图
            judgeOutput={
              judgeOutputVisible
                ? {
                  state:
                      judgeOutput.status === 'error'
                        ? { status: 'error', error: judgeOutput.error }
                        : judgeOutput.status === 'loading'
                          ? { status: 'loading' }
                          : { status: 'ready', data: judgeDiagnostics },
                  errorText: judgeOutput.status === 'error' ? describeError(judgeOutput.error) : null,
                  judging: judgeLive,
                  liveError: judgeOutput.liveError,
                  onRetry: judgeOutput.retry,
                  open: judgeOutputOpen,
                  onOpenChange: (next) => setJudgeOutputCandidateId(next ? scoreCandidateId : null),
                }
                : undefined
            }
          />
        )}
      </Drawer>

      {/*
        「排名」抽屉：第四个主抽屉，几何与上面三个同一份（`DRAWER_GEOMETRY`）——
        它比的是候选之间的名次，比评分详情更需要宽度，不该另立一档。
        数据全部来自**已在内存里的这一份 run 快照**（各候选的 `score` + 轮级 `rubric`）：
        没有任何一次网络往返，也没有「详情按需再拉一次」这一步。
        `runningCount` 数的是 `isRunningCandidate` 的候选数（不是 `hasLiveCandidates` 那个布尔：
        后者的轮级那一格数不出 N，会出现「有 0 行正在执行」这种自相矛盾的句子）。
        run 未知（首帧 / 快照没到）时整段不渲染：排名表没有「部分数据」可言，少一个候选就是错的名次。

        **「产物总览」是从这里推出来的第二层**（与评分详情那两个二级抽屉同一模式）：
        入口按钮在 `footer` 上、正文在 `ArtifactOverview` 里，开合态受控（住页面）。
        `ArtifactOverview` 必须留在本抽屉的**子树里**：它内部渲染的 `NestedDrawer` 靠
        `parentContext` 把主抽屉推开，而那个 context 只有 React 树能带过去（portal 带不走）。
      */}
      {run !== undefined && (
        <Drawer
          title="排名"
          placement="right"
          {...DRAWER_GEOMETRY}
          open={drawer?.kind === 'rank'}
          // 关掉排名抽屉时把二级抽屉的开合一起收掉：重开时它不该自己弹出来
          onClose={() => {
            setDrawer(null);
            setArtifactOpen(false);
          }}
          // 关掉即卸载：再次打开要按**那一刻**的快照重算名次（分数还在 SSE 里变），
          // 留着上一次的结点只会让「重新打开的排名」看起来没刷新
          destroyOnHidden
          /*
            「产物总览」的入口：**至少有一份产物才出现**（扫不到就没有可总览的东西）。
            读不到清单时置灰 + Tooltip 挂中文原因，而不是静默不出现——会自己冒出来的按钮，
            「点了没反应」与「它压根不在」是最难自查的两种状态（与「排名」按钮的同一条口径）。
            读取中 / 确实没有产物两种情况都不画 footer。
          */
          footer={
            artifacts.index !== undefined && artifacts.index.total > 0 ? (
              <Flex justify="flex-end">
                <Button size="small" autoInsertSpace={false} data-testid="rank-artifacts-open" onClick={() => setArtifactOpen(true)}>
                  {ARTIFACT_OVERVIEW_LABEL}
                </Button>
              </Flex>
            ) : artifacts.error !== null && artifacts.error !== undefined ? (
              <Flex justify="flex-end">
                <Tooltip title={`读不到产物清单：${describeError(artifacts.error)}`}>
                  <Button size="small" autoInsertSpace={false} disabled>
                    {ARTIFACT_OVERVIEW_LABEL}
                  </Button>
                </Tooltip>
              </Flex>
            ) : null
          }
        >
          <RankTable run={run} runningCount={liveCandidateIds.length} />
          {/* 二级抽屉只渲染 portal，不占正文盒子：排在表格之后不影响它的高度链 */}
          <ArtifactOverview
            run={run}
            index={artifacts.index}
            open={artifactOpen}
            onOpenChange={setArtifactOpen}
            renderBody={({ candidateId, name }) => <ArtifactFileBody runId={runId} candidateId={candidateId} name={name} />}
          />
        </Drawer>
      )}
    </>
  );
}
