'use client';

/**
 * 评测页：左侧列表 + 右侧栏（详情 / 创建表单 / 编辑表单），形态与用例页同口径。
 * 七条口径：
 * 1. `useSearchParams` 会把用到它的子树退化为客户端渲染，故给它一个 `Suspense` 边界
 * （Next 16 文档 useSearchParams 的 Prerendering 一节）；
 * 2. **行级抽屉打开时**才订阅这一行的数据（日志事件 / 消息 / 改动索引 / 评分流水）；
 * 页签切换不重订阅：三个视图共用同一个 `rowId`，切回日志时滚动位置与已展开的块都还在。
 * 实时指标那一路只为在跑的行各开一条；
 * 3. 行级三视图的数据都在同一个 `rowId` 上按需取：日志 = `useRowStream` + `useRowLog`
 * + `useRowMessages`、改动 = `useRowDiffIndex` + `useRowDiffFile`、
 * 评分详情 = 快照里的 `score` 与 `rubric` + 评分那条事件流 `useRowJudgeEvents`
 * （评审者自己的原始输出，judging 才接 SSE）；
 * 4. 页面的可测逻辑（URL 解析、错误文案、日志抽屉的三态）都在 `@/src/runs-view` 与
 * `@/src/log-drawer-state`，本文件只做拼装；
 * 5. **本页自己不套 `PageShell`**：`ListDetailLayout` 内部已经是 `PageShell`，
 * 再包一层会多出一个 `ConfigProvider` 与一圈 16px 内边距，与本仓另一处同样形态的
 * `/cases` 页不一致——两页的骨架必须逐字同形，否则宽度偏好与吸底几何会各自漂移。
 * 6. **右栏三态**`?panel=detail|new|edit&id=…`：编辑与详情共用同一份快照
 * （`selectedId` 两态都取 id）。与 `/cases` 的一处有意差异：runs 页没有需要复位的跨面板
 * 临时状态（用例页那套 `go` 复位是为仓库校验回显服务的），故不引入那层。
 * 7. **行级三视图住同一个抽屉 + 页签头**（`RunDetailDrawer`）：日志 / 变更 / 评分切换时
 * **不卸载**内容（滚动位置、展开态、过滤条件都活着）；排名仍是页面级主抽屉。
 * 8. **本页是「run 焦点」的唯一写入方**：右栏选中哪一轮就 `setFocusedRun(那一轮)`、离开即复位，
 * 全局提问浮层据此把其余轮次的未答提问**暂缓**（不弹、不取消）。焦点是模块级单例——
 * 浮层挂在页面壳外面，`Context` 够不着本页的查询参数。
 */
import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { isRunningRow, type AgentEnvironment, type EvalRun, type RowDiffIndex, type Rubric, type RunCreate, type ScoreResult } from '@aieval/contracts';
import {
  buildAgentEnvironment,
  useAbortRow,
  useAbortRun,
  useCases,
  useCreateRun,
  useDeleteRun,
  postInjectAttachment,
  useCheckpointRow,
  useFollowUpAvailability,
  useFollowUpRow,
  useInjectMessages,
  useRowArtifactFile,
  useRowDiffFile,
  useRowDiffIndex,
  useRowJudgeEvents,
  useRowLog,
  useRowMessages,
  useRowStream,
  useRun,
  useRunActivity,
  useRunArtifacts,
  useRunLiveMetrics,
  useRunModelOptions,
  useRunTestResults,
  useRuns,
  useRescoreRow,
  useRetryRow,
  setFocusedRun,
  useSettings,
  useStartRun,
  useUpdateRun,
  type AgentLogModel,
  type AgentLogSource,
} from '@aieval/client';
import {
  ARTIFACT_OVERVIEW_LABEL,
  PlusIcon,
  AgentLogLayout,
  Alert,
  AlertDescription,
  AlertTitle,
  AppTopNav,
  ArtifactFileContent,
  ArtifactOverview,
  Badge,
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  DiffFileContent,
  DataTable,
  DiffView,
  EllipsisText,
  EmptyState,
  FollowUpComposer,
  Hint,
  InjectComposer,
  ListDetailLayout,
  MAIN_DRAWER_STYLE,
  PageHeader,
  RankTable,
  RunCreatePanel,
  RunDetailDrawer,
  RunDetailPanel,
  ScoreDetailView,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  ScoreChart,
  Skeleton,
  // 能力声明的形状搬运（契约的扁平三格 → 界面要的字典）：唯一的一份实现，页面不自己摊
  toCapabilityMap,
  buildAgentLogModel,
  diagnosticsOf,
  formatDateTime,
  formatEventLog,
  orderForDisplay,
  rawOutputLabel,
  toast,
  useAppliedThemeMode,
  type DataTableColumn,
  // 表单交回的值的形状：创建与编辑两条路径都按它收敛（`RunUpdate` 与它逐字段一致）
  type Loadable,
  type RunDetailTab,
  type RunFormValues,
  requestCommandPalette,
} from '@aieval/ui';
import { buildRowFacts, contextWindowOf, resolveLogDrawer } from '@/src/log-drawer-state';
import { NAV_ITEMS } from '@/src/nav';
import { describeError, parseRunsPanel, runListTitle, runScoreDistribution, runScoreSummary, runsPanelHref, type OpenDrawer } from '@/src/runs-view';
import { usePageTitle } from '../use-page-title';

/** 轮级状态 → 中文与徽标配色（行级状态在 ui 的 `EvalRowCard` 里；轮级只有 4 个值）
 *
 * **实心底色只留给「执行中」**：一轮跑完是常态、不是警报，十行「已完成」各顶一个黑白实心胶囊
 * 会盖过真正的信息（分数、失败）。未开始 / 部分完成 / 已完成都用描边档，靠文字区分。 */
const RUN_STATUS_META: Record<EvalRun['status'], { label: string; variant: 'outline' | 'secondary' | 'default' }> = {
  idle: { label: '待开始', variant: 'outline' },
  running: { label: '执行中', variant: 'secondary' },
  partial: { label: '部分完成', variant: 'outline' },
  done: { label: '已完成', variant: 'outline' },
};

/**
 * 「状态」列的排序序：按**业务生命周期**idle → running → partial → done。
 * 不按枚举名、也不按中文标签的字符串排——「部分完成」按拼音会插在「未开始」前面，那是没人能预期的序。
 * 写成 `Record<EvalRun['status'], number>` 是为了让契约新增状态时 tsc 直接报错。
 * 枚举外的状态值进不了这张表：`run.json` 里状态不合枚举会被 run-store 的 `safeParse` 跳过。
 */
const RUN_STATUS_RANK: Record<EvalRun['status'], number> = { idle: 0, running: 1, partial: 2, done: 3 };

/** 六列声明的宽度（px）：标题 / 状态 / 得分 / 候选数 / 执行模式 / 创建时间 */
const RUN_COLUMN_WIDTH = { title: 200, status: 88, score: 168, rows: 72, executionMode: 88, createdAt: 144 } as const;

/*
 * 六列声明宽度之和 = 200 + 88 + 168 + 72 + 88 + 144 = 760；容器更宽时由 `fillColumnId` 把
 * 剩余宽度全部给标题列，更窄时横向滚动。固定列的偏移只认这些声明值。
 */

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
 * ③ 这里**只写升序语义**：方向由套件的排序态施加，比较器自己再按方向翻一次就是翻两次。
 *
 * 同值的行不需要兜底键：服务端给的就是 `createdAt` 降序（api/runs.ts 的 `listRunsView`），
 * `Array.prototype.sort` 稳定 ⇒ 比较为 0 的行永远保持那个顺序（同一用例的多轮自然聚在一起、
 * 组内最近创建的在前面），与排序方向无关。
 *
 * ⚠️ cases 页有同口径的实现（本次口径：比较器不抽模块）。改这里必须同时改那边。
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
 * 列表的五列（列序即版面口径，与用例页同形）。
 *
 * 显示与排序**共用同一份拼法**（`runListTitle`）：备注非空时是「用例标题 · 备注」，
 * 否则只有用例标题。两处各拼一份的漂移症状是「看到的和排的不是一回事」。
 * 标题本身是**快照**（`caseTitle`）：用例改名不会改写历史轮次，所以排/显的都是历史标题。
 * 固定位置写在列定义上（`pinned` + 声明的 `size`），偏移由套件算。
 */
const RUN_COLUMNS: DataTableColumn<EvalRun>[] = [
  {
    id: 'caseTitle',
    header: '标题',
    accessorFn: (run) => runListTitle(run),
    size: RUN_COLUMN_WIDTH.title,
    pinned: 'start',
    sortFn: (left, right) => compareSortText(runListTitle(left.original), runListTitle(right.original)),
    cell: ({ row }) => <EllipsisText text={runListTitle(row.original)} />,
  },
  {
    id: 'status',
    header: '状态',
    accessorFn: (run) => RUN_STATUS_RANK[run.status],
    size: RUN_COLUMN_WIDTH.status,
    // 生命周期正序（未开始 → 执行中 → 部分完成 → 已完成）
    sortFn: (left, right) => RUN_STATUS_RANK[left.original.status] - RUN_STATUS_RANK[right.original.status],
    cell: ({ row }) => (
      <Badge variant={RUN_STATUS_META[row.original.status].variant}>
        {RUN_STATUS_META[row.original.status].label}
      </Badge>
    ),
  },
  {
    id: 'score',
    header: '得分',
    // 排序用最高分：与「排名」抽屉同一口径（未出分的轮次垫底，按 -1 处理，不拿 0 分冒充）
    accessorFn: (run) => runScoreSummary(run)?.best ?? -1,
    size: RUN_COLUMN_WIDTH.score,
    sortFn: (left, right) => (runScoreSummary(left.original)?.best ?? -1) - (runScoreSummary(right.original)?.best ?? -1),
    sortDescFirst: true,
    // 满分不固定 100，且读的是**评分那一刻**的快照：`得分 / 满分` 两个数必须成对出现。
    // 第二行是**每个候选自己的分**（见 `runScoreDistribution`）：最高分盖得住失败，
    // 「3 个候选里 1 个超时」必须在列表上就能看见，而不是点进右栏才发现。
    cell: ({ row }) => {
      const summary = runScoreSummary(row.original);
      if (summary === null) return <span className="text-muted-foreground">—</span>;
      const distribution = runScoreDistribution(row.original);
      const incomplete = summary.scored < summary.total;
      const tone = summary.unscored > 0 ? 'text-warning' : 'text-muted-foreground';
      return (
        <div className="flex flex-col gap-0.5 leading-tight tabular-nums">
          <span className="flex items-baseline gap-1">
            <span className="font-medium">{summary.best}</span>
            <span className="text-sub text-muted-foreground">/ {summary.max}</span>
            {incomplete ? <span className={`text-sub ${tone}`}>{`${summary.scored}/${summary.total} 出分`}</span> : null}
          </span>
          {distribution === null ? null : (
            <span className={`text-sub ${tone}`}>{distribution}</span>
          )}
        </div>
      );
    },
  },
  {
    id: 'rows',
    header: '候选数',
    accessorFn: (run) => run.rows.length,
    size: RUN_COLUMN_WIDTH.rows,
    enableSorting: false,
    cell: ({ row }) => row.original.rows.length,
  },
  {
    id: 'executionMode',
    header: '执行模式',
    accessorFn: (run) => run.executionMode,
    size: RUN_COLUMN_WIDTH.executionMode,
    enableSorting: false,
    cell: ({ row }) => (row.original.executionMode === 'serial' ? '串行' : '并行'),
  },
  {
    id: 'createdAt',
    header: '创建时间',
    accessorFn: (run) => run.createdAt,
    size: RUN_COLUMN_WIDTH.createdAt,
    sortFn: (left, right) => compareSortTime(left.original.createdAt, right.original.createdAt),
    // 默认视图就是「创建时间」倒序：最新的一轮在最上面（服务端顺序即此，首点落到 desc）
    sortDescFirst: true,
    cell: ({ row }) => formatDateTime(row.original.createdAt),
  },
];

/**
 * 一个文件的正文。
 * 必须是**独立组件**：`useRowDiffFile` 是 hook，不能由页面按 path 循环调用；
 * 每个文件一个实例，SWR 的订阅与缓存才能按文件各自生效（这正是惰性加载要的形状）。
 */
function DiffFileBody({
  runId,
  rowId,
  path,
  dark,
}: {
  runId: string;
  rowId: string;
  path: string;
  dark: boolean;
}): ReactNode {
  const { file, error, isLoading } = useRowDiffFile(runId, rowId, path);
  return <DiffFileContent file={file} error={error} isLoading={isLoading} dark={dark} />;
}

/**
 * 一份候选产物的正文（「产物总览」二级抽屉里的那张卡）。
 *
 * 与 `DiffFileBody` 同一条理由，必须是**独立组件**：`useRowArtifactFile` 是 hook，
 * 不能由抽屉按「行 × 文件名」循环调用；每份一个实例，SWR 的订阅与缓存才能按
 * 「这一行的这一份」各自生效——这正是「一份读不出来只坏那一张卡」要的形状。
 */
function ArtifactFileBody({ runId, rowId, name }: { runId: string; rowId: string; name: string }): ReactNode {
  const { file, error, isLoading } = useRowArtifactFile(runId, rowId, name);
  return <ArtifactFileContent file={file} error={error} isLoading={isLoading} />;
}

/**
 * 主抽屉的几何：宽度、窄屏兜底与**嵌套让位量**都来自 `@aieval/ui` 的 `base/drawer-geometry`。
 *
 * 行级三视图走 `RunDetailDrawer`（它自己消费同一份）；这里只剩「排名」这个页面级视图。
 * `Sheet` 的默认宽度是 `w-3/4` + `sm:max-w-sm`，不显式覆盖就会掉回默认档，三个视图宽窄不一。
 */
const DRAWER_STYLE = MAIN_DRAWER_STYLE;

/**
 * 「这一行还没开始跑」时抽屉吃的空模型。
 *
 * 为什么必须有一个**非空**的模型：抽屉的内部空态判据是 `model.empty`（文案「还没有日志 ·
 * 这一行还没开始执行」），而 `empty === true` 与 `empty === false` 是**两种不同的空**
 * （三种空）——没有模型就没有事实条可画，故给一份如实为空的模型，
 * 而不是让抽屉在 `model === undefined` 上崩掉。
 *
 * 这一支只在**真的没跑过**（`status === 'pending'`）时用到：跑了却没有任何记录的行
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
    // 还没开始跑：没有占用读数、窗口也未知（都不是 0）
    contextUsed: null,
    contextWindow: null,
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
  rowEvents: [],
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
  rowId: string;
  refreshLog: () => void;
  refreshMessages: () => void;
}): AgentLogSource {
  const { runId, rowId, refreshLog, refreshMessages } = input;
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
      // 节点内容按值给（UI 不做取数），「重取」在这里就是重取这一行的两条来源
      void runId;
      void rowId;
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
  usePageTitle('评测');
  const router = useRouter();
  const searchParams = useSearchParams();
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
  const { optionsFor, capabilityOf, defaultEffortOf, messageCapabilityOf, checkpointOf, turnInjectionOf } = useRunModelOptions();
  const { create, isCreating } = useCreateRun();
  const { update, isUpdating } = useUpdateRun();
  const { remove, isDeleting } = useDeleteRun();
  const { start, isStarting } = useStartRun();
  const { abort, isAborting } = useAbortRun();
  const { abortRow } = useAbortRow();
  const { rescoreRow, isRescoring } = useRescoreRow();
  const { retryRow, isRetrying } = useRetryRow();
  const runId = run?.id ?? '';
  /**
   * 行级抽屉的 id 与当前页签：三个视图共用**同一行**，故只有一份 id。
   * 页签只决定渲染哪一块；数据订阅在抽屉打开期间全部保持（切页签不重取、不闪加载），
   * 这也是「切走时不卸载」的一半——另一半在 `RunDetailDrawer` 的 `keepMounted`。
   */
  const drawerRowId = drawer?.kind === 'row' ? drawer.rowId : null;
  const drawerTab: RunDetailTab = drawer?.kind === 'row' ? drawer.tab : 'log';
  const logRowId = drawerRowId;
  const diffRowId = drawerRowId;
  /** 抽屉要渲染的那一行（评分详情那一支也用它；拿不到就整段不渲染）。排名抽屉没有行 id，故恒 undefined */
  const logRow = drawerRowId === null ? undefined : run?.rows.find((row) => row.id === drawerRowId);
  /**
   * 只在该行的日志抽屉打开时才订阅它的事件流。
   * `attemptKey` 取这一行的 `attempts`：重跑同一行时它会变，订阅因此重挂——不重挂的话
   * 抽屉会一直显示上一轮的原始输出（连接可能已被终态关掉，也可能还活着但游标停在上一代），
   * 而连接徽标照旧显示「实时连接中」（判据与理由见 `useRowStream` 的口径 5）。
   */
  const stream = useRowStream({
    runId,
    rowId: logRowId ?? '',
    enabled: logRowId !== null,
    attemptKey: String(logRow?.attempts ?? 0),
  });
  /**
   * 跑动期的实时指标：**只为在跑的行**各开一条连接，
   * 界面上的 tok / 轮次 / 耗时因此不必等这一行结束。
   * 行集合每帧都是新数组：`useRunLiveMetrics` 内部按 join 出来的稳定键做依赖，
   * 所以这里不需要 useMemo（多一层记忆化只会多一个可能不同步的来源）。
   */
  const liveRowIds = (run?.rows ?? []).filter((row) => isRunningRow(row.status)).map((row) => row.id);
  const live = useRunLiveMetrics({ runId, rowIds: liveRowIds });
  /**
   * 活动行的**实时内容**：与上面那条指标流并列的另一路——它折的是 AgentMessage
   *，指标那条折的是事件。活动行把两者叠起来用：消息流有内容就以它为准，
   * 没有才回落到 `log.summary`（`live.latestText`）。
   * 行集合同样只取在跑的：终态那一行已经收起，多开连接只是浪费（`useRunActivity` 里也再挡一次）。
   */
  const activityRows = (run?.rows ?? [])
    .filter((row) => isRunningRow(row.status))
    .map((row) => ({ id: row.id, status: row.status }));
  const activity = useRunActivity({ runId, rows: activityRows });
  const log = useRowLog(runId, logRowId ?? '', logRowId !== null);
  /**
   * 时间轴的来源：内容级记录（消息 + 子任务行）。与上一条事件流**并列**、各自独立——
   * 「事件读不出来」不代表时间轴没东西可画，反过来也一样。
   */
  const messages = useRowMessages({ runId, rowId: logRowId ?? '', enabled: logRowId !== null });
  /**
   * 人工消息的队列快照 + 写动作（发送 / 立即发送 / 删除 / 附件）：
   * **只在闸门开着且日志抽屉开着时订阅**（`enabled`）——闸门关着的一轮不许有人往它里面送话，
   * 那是服务端也认的同一条判据（`EvalRun.injectMessages`）。
   */
  const inject = useInjectMessages({
    runId,
    rowId: logRowId ?? '',
    enabled: logRowId !== null && run?.injectMessages === true,
  });
  /**
   * 追问（第二期）：入口按钮的判据 + 写动作。
   *
   * **判据从服务端读**（`useFollowUpAvailability`）：七档拒绝里有一半的事实在盘上与厂商声明上，
   * 浏览器一格都看不到——界面自己编一句「这一家不支持续接」就是第二份说法。`revision` 带上
   * 每行的状态与会话 id：判据的前两档（正在跑 / 上一次没收尾）随行状态翻转，而这一条读侧
   * 没有信号流；`useRun` 的快照一变这里就跟着重读一次。
   */
  const followUps = useFollowUpAvailability({
    runId,
    enabled: selectedId !== null,
    revision: (run?.rows ?? [])
      .map((row) => `${row.id}:${row.status}:${row.sessionId === null ? '-' : row.sessionId}`)
      .join('|'),
  });
  const { followUpRow, isFollowingUp } = useFollowUpRow();
  const { checkpointRow, isCheckingPoint } = useCheckpointRow();
  /**
   * **回到某一轮**的待办目标：点「回到这里」先把目标记下来，再复用追问输入区收一句话
   * （「从这一点接着要做什么」）。提交时这一格还在 ⇒ 走 `/api/checkpoint`，否则走追问。
   *
   * 为什么不单独做一个弹窗：输入区的附件上传、错误呈现、忙碌态都与追问逐字相同；
   * 另起一个弹窗等于把同一套交互抄第二遍，两处必然漂。
   */
  const [checkpoint, setCheckpoint] = useState<{
    segment: number;
    turn: number;
    keepAt: string;
    dropFrom: string | null;
  } | null>(null);
  /**
   * 索引是**分页**的（首帧只拉一页 30 条，其余按滚动逐页追加，**已加载的页不回收**），
   * 故这里自己累积已加载的文件：每次把新到的那一页接在后面，滚到底再由 `onLoadMore` 取下一页。
   * 不累积的话，头部写着「共 N 个文件」而列表只有 30 条，第 31 个之后的文件永远看不到。
   */
  const [diffOffset, setDiffOffset] = useState(0);
  const diffIndex = useRowDiffIndex(runId, diffRowId ?? '', diffRowId !== null, diffOffset);
  const [diffFiles, setDiffFiles] = useState<RowDiffIndex['files']>([]);
  /** 已经并入累积列表的页起点：同一页重渲染/重取时不重复追加 */
  const appendedOffsetRef = useRef<number | null>(null);
  /**
   * 实际明暗**读已解析的结果**，不在这里再解析一次。
   * `useResolvedTheme()` 的偏好缺省是 `'dark'`（SSR 兜底），不传偏好就会拿到暗色——
   * 既是第二份判据、又会把 `data-theme` 改回暗色，于是页面底色与 diff 视图的配色互相打架
   * （症状：亮色主题下背景不对）。真正的解析在 `providers.tsx`。
   */
  const themeMode = useAppliedThemeMode();
  /** 当前评分详情对应的行 id（不是评分抽屉时为 null）：footer 的入口与二级抽屉都以它为判据 */
  const scoreRowId = drawerRowId;
  /**
   * 评分详情对应的那一行（分与状态都在它身上）：`scoreDetail` 与「原始输出」入口的可见性都读它。
   * 行状态也在这里取——**judging ⇔ 无分**（首评 / 重评的入口都会同步清分），两个判据读同一行才不会漂。
   */
  const scoreRow = scoreRowId === null ? undefined : run?.rows.find((row) => row.id === scoreRowId);
  /**
   * 评分详情抽屉要的**两样东西来自同一份 run 快照**：这一行的 `score` 与这一轮的评分表 `rubric`
   * ——评分表是这一分生成时那张表的快照（与 `score.maxScore` 同源），改用例不会换掉它，
   * 而详情正是按**引用键**把判定与评分表逐项对齐的（少了这张表，逐项判定一项也画不出来）。
   * 「这一分是谁打的、花了多少」那**五格**也全在 `score` 上 ⇒ 这里**不再递候选行**：
   * 那是执行那一份数据，而抽屉叫「评分详情」。
   * 合成一个对象再判空：拆成多个变量时 JSX 里得各自判空，而「有分却没表」那一格一旦漏判，
   * 渲染出的是一张对不上任何判定的空表。
   */
  const scoreDetail = ((): { score: ScoreResult; rubric: Rubric } | null => {
    if (run === undefined || scoreRow === undefined || scoreRow.score === null) return null;
    return { score: scoreRow.score, rubric: run.rubric };
  })();
  /**
   * 「模型原始返回」二级抽屉的开合：入口按钮挂在评分详情抽屉的 `footer` 上，
   * 故状态住在页面这一层，视图是**受控**的（`rawOpen` / `onRawOpenChange`）。
   *
   * **记的是「哪一行开着」，不是一个 boolean**：换行、关抽屉、URL 深链三条路都会换 `rowId`，
   * 用 boolean 就得在每一处记得清掉它，漏一处的症状是「点开另一行的评分详情，二级抽屉自己弹出来」
   * ——那种 bug 只在特定点击顺序下出现。带上行 id 之后判据自动为假（关抽屉时 `drawer` 已是 null）。
   */
  const [rawRowId, setRawRowId] = useState<string | null>(null);
  const rawOpen = drawerTab === 'score' && scoreRowId !== null && rawRowId === scoreRowId;
  /** 「原始输出 N 条」二级抽屉（评分那条流）的开合：与 `rawRowId` 同一条「记哪一行」的口径 */
  const [judgeOutputRowId, setJudgeOutputRowId] = useState<string | null>(null);
  const judgeOutputOpen = drawerTab === 'score' && scoreRowId !== null && judgeOutputRowId === scoreRowId;
  /** 这一行正在评分（judging）吗：SSE 的开关（judging 才接，终态行只拉历史） */
  const judgeLive = scoreRow?.status === 'judging';
  /**
   * 「原始输出」入口的可见性（设计口径）：**有分**时按 `score.judgeAgentKind` 判——文本 API 评分
   * 没有评审会话（`judge-events.jsonl` 不存在）⇒ 不渲染；智能体评分的行**常驻**（含 0 条：
   * 空态写在二级抽屉的正文里，不靠藏按钮表达）。**评分进行中**（judging ⇔ 无分，
   * `judgeAgentKind` 要等分落下来才有）按轮级开关 `run.useAgentJudge` 判。重跑候选
   * （running）期间不渲染——评审还没开始，那时文件已被清空、一个字都不剩。
   */
  const judgeOutputVisible =
    scoreRow !== undefined &&
    ((scoreDetail !== null && scoreDetail.score.judgeAgentKind !== null) ||
      (run?.useAgentJudge === true && judgeLive));
  /**
   * 评分那条事件流（评审者自己的流水）：入口可见才取数；judging 才接 SSE（空闲零连接）。
   * `live` 进依赖 ⇒ judging → 终态的翻转会把 effect 重挂一次、历史重读成终值（口径见
   * `judge-events.ts` 文件头）；分落进行里那一刀不归它管（run 信号流的职责）。
   */
  const judgeOutput = useRowJudgeEvents({
    runId,
    rowId: scoreRowId ?? '',
    enabled: judgeOutputVisible,
    live: judgeLive,
  });
  /** 折成「原始输出」面板的行（`log` 事件逐字原文）：与执行日志抽屉共用同一个折法 */
  const judgeDiagnostics = useMemo(() => diagnosticsOf(judgeOutput.events), [judgeOutput.events]);
  /** 入口按钮与二级抽屉标题同文（`rawOutputLabel` 是同一份实现）：ready 才带条数，读取中 / 失败不带 */
  const judgeOutputLabel = rawOutputLabel(judgeOutput.status === 'ready' ? judgeDiagnostics.lines.length : null);

  /**
   * 「产物总览」：这一轮各候选工作区根下的 `RESULT.*` 清单 + 二级抽屉的开合。
   *
   * **只在排名抽屉打开时才扫盘**（`enabled`）：一次扫描 = 每行一次 `readdir`，
   * 页面开着一个没打开排名的详情时扫它没有意义。
   * 开关记的是 boolean 而不是「哪一行」：它属于**整轮**，没有行这一维（与 `rawRowId` 那类不同）；
   * 关掉排名抽屉时在它的 `onClose` 里一并复位——否则重开排名抽屉时二级抽屉会自己弹出来。
   */
  const artifacts = useRunArtifacts(runId, drawer?.kind === 'rank');
  /**
   * 排名页的「测试通过率」列：与产物清单同一开关（只在排名抽屉打开时读消息账本）。
   * 读不到时 `results` 是 `undefined`，表格写「未采集」——**不拿空对象当成 0 个通过**。
   */
  const runTests = useRunTestResults(runId, drawer?.kind === 'rank');
  const [artifactOpen, setArtifactOpen] = useState(false);

  /** 换一行（或重开抽屉）时把累积清空，免得看到上一行的文件 */
  useEffect(() => {
    setDiffFiles([]);
    setDiffOffset(0);
    appendedOffsetRef.current = null;
  }, [diffRowId, runId]);

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
   * 「还没有日志 · 这一行还没开始执行」，与「读不出来」一起出现会把一个带文件路径的真实故障
   * 说成「还没开始跑」。`stream.error` 也必须进去（它过去被这里丢掉）：断线时徽标只显示
   * 「未连接」而没有原因，使用者分不清「这一行还没开始跑」与「实时通道连不上」。
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
   * 事实条与时间轴模型：**页面只做拼装**——`buildRowFacts`（行级事实的界面口径）与
   * `buildAgentLogModel`（契约形状 → 界面模型）都是纯函数，各自有守卫。
   *
   * 为什么不在这里拼 `AgentLogModel`：那是数据层的活（它才认识 `mergeKey` / 轮次号的换算），
   * 而把它摊在页面里意味着页面读源码守卫才能钉住形状。这里的 `useMemo` 依赖三个输入，
   * 为的是「一次上游提交只重建一次」（父组件因 SSE 重渲染时不重算）。
   */
  const logFacts = logRow === undefined
    ? null
    : buildRowFacts({
      row: logRow,
      events: stream.events,
      /**
       * 上下文用量的**上限**：从候选池按 `providerId + modelId` 配（模型清单里的声明）。
       * 拿不到就如实 `null`——界面显示「上限未采集」，不兜底一个默认窗口（编一个出来，百分比就是假读数）。
       */
      contextWindow: contextWindowOf(logRow, optionsFor(logRow.agentKind)),
    });
  /**
   * 这一行的**能力声明**：五格各自带「从哪条通道取到 / 为什么取不到」。
   *
   * 按**行**取而不是按轮取：同一轮的不同候选可以是不同智能体，取错一行就会把
   * 「codex 的思考正文只在会话文件里」说成「claude 的流式增量没投送」。
   * 拿不到（元数据还没到 / 后端没给这一格）就是 `null`——**不编一份「都支持」**，
   * 装配层会如实回落成「没验证过」。
   */
  const logCapability = logRow === undefined ? null : messageCapabilityOf(logRow.agentKind);
  const logModel =
    logFacts === null
      ? null
      : buildAgentLogModel({
        records: messages.records,
        events: stream.events,
        facts: logFacts,
        startedAt: logFacts.startedAt,
        // 声明缺失时**不传这一格**（装配层回落成「没验证过」），而不是传一份空 map：
        // 空 map 与「五格都 yes」在界面上都长得像「有声明」，而那两件事完全不同
        ...(logCapability === null ? {} : { capability: toCapabilityMap(logCapability) }),
        // 能力成立的**前提**（路由 / 模型 / 开关）：空数组 = 无条件成立，如实照抄服务端的 notes
        capabilityNotes: logCapability?.notes ?? [],
      });
  const logDiagnostics = useMemo(() => diagnosticsOf(stream.events), [stream.events]);

  /**
   * 环境信息：**按值给**抽屉，不新开端点——四组数据页面都已经拿在手上
   * （运行配置来自 `EvalRow` / `EvalRun` 的快照字段、厂商系统层来自事件流里的 `system/init` 行、
   * 实测统计来自内容记录里的 `tool-call`）。
   *
   * 为什么不做成「点了才取」：`requestEnvironment` 那一格存在意义是**把取数时机从组件里搬出去**，
   * 而这里的「取数」是本进程内一次纯函数调用 ⇒ 按值给才是它该有的形态，
   * 点开即有内容，不必先闪一下「读取中」。`logSource` 里仍然保留那个口子，见那里的注释。
   */
  // 「未选档位」时这一行会落到哪一档（注册表元数据）：运行配置那一格照着它写，
  // 界面里不写死厂商名与档位（见 `build-environment.ts` 的 `effortLine`）。
  // 先取进常量：下面那个对象字面量里连着判两次同一个值，读的人得自己证「两次结果相同」。
  const defaultEffort = logRow === undefined ? undefined : defaultEffortOf(logRow.agentKind);
  const logEnvironment: Loadable<AgentEnvironment> | undefined = useMemo(
    () =>
      logRow === undefined
        ? undefined
        : {
          status: 'ready',
          data: buildAgentEnvironment({
            row: logRow,
            workspaceBase: run?.workspaceBase ?? '',
            events: stream.events,
            records: messages.records,
            ...(defaultEffort === undefined ? {} : { defaultEffort }),
          }),
        },
    [logRow, run?.workspaceBase, stream.events, messages.records, defaultEffort],
  );

  const logSourceRef = useMemo(
    () =>
      logRowId === null
        ? undefined
        : logSource({ runId, rowId: logRowId, refreshLog: log.refresh, refreshMessages: messages.refresh }),
    [runId, logRowId, log.refresh, messages.refresh],
  );

  /**
   * 底部槽里的**输入区**：只有「这一轮的闸门开着 **且** 这一行此刻还有活在跑」时才渲染。
   *
   * 为什么要判行态：队列表的取件发生在**这一行**的投递循环里（适配器收工时那次 `drain`），
   * 一行已经收场之后再送话，那一条永远等不到取件——界面给一个发了也没人收的输入区，
   * 等于把「投不进去」说成「能投」。`isRunningRow` 是契约里那一条（与「能不能重评/重跑」
   * 同一个落点），不在这里另写一份判据。
   *
   * 声明按**这一行自己的家**取（同一轮的不同候选可以是不同智能体）：`null` 读作「不知道」，
   * 界面据此置灰并如实说「读不到声明」，**不编一份「都支持」**。
   */
  const injectFooter =
    run?.injectMessages === true && logRow !== undefined && isRunningRow(logRow.status) ? (
      <InjectComposer
        messages={inject.messages}
        declaration={turnInjectionOf(logRow.agentKind)}
        busy={inject.busy}
        onSend={async (input) => {
          await inject.send({
            runId,
            rowId: logRow.id,
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
        onError={(cause) => void toast.error(describeError(cause))}
      />
    ) : undefined;

  /**
   * **这一轮的厂商条目坐标**（「回到这里」把轮次坐标翻成厂商条目 id 的唯一一处）。
   *
   * 判据只用消息账本：`keepAt` = 被保留那一轮**最后一条**有 `vendorId` 的消息（CC 的
   * `resumeSessionAt` 认的就是这条 chain entry），`dropFrom` = 下一轮**第一条 user 消息**的
   * `vendorId`（CC 的 `resumeDropsTurn` 要的「被丢掉那一轮的 prompt」）。
   * 账本没记条目（旧数据 / 厂商不投送）⇒ `null`，界面据此把按钮置灰并给出这一次的事实原因。
   */
  const checkpointAnchorOf = useCallback(
    (target: { segment: number; turn: number }): { keepAt: string; dropFrom: string | null } | null => {
      const records = messages.records.flatMap((record) => (record.type === 'message' ? [record.message] : []));
      const inTurn = (turn: number): typeof records =>
        records.filter((message) => (message.segment ?? 0) === target.segment && message.roundTrip === turn);
      const keep = [...inTurn(target.turn)].reverse().find((message) => message.vendorId !== null);
      if (keep?.vendorId == null) return null;
      const nextTurn = inTurn(target.turn + 1);
      const drop =
        nextTurn.find((message) => message.role === 'user' && message.vendorId !== null) ??
        nextTurn.find((message) => message.vendorId !== null);
      return { keepAt: keep.vendorId, dropFrom: drop?.vendorId ?? null };
    },
    [messages.records],
  );

  /**
   * 「回到这里」：记下目标并打开**同一套输入区**（问「从这一点接着要做什么」）。
   * 真正发请求在输入区的 `onSend` 里分岔（有目标 ⇒ `/api/checkpoint`）。
   * 目标算不出来时什么都不做——按钮那一刻本来就是禁用的（同一个 `checkpointAnchorOf` 判据）。
   */
  const handleCheckpoint = useCallback(
    (target: { segment: number; turn: number }): void => {
      const anchor = checkpointAnchorOf(target);
      if (anchor === null) return;
      setCheckpoint({ ...target, ...anchor });
      setDrawer((previous) =>
        previous?.kind === 'row'
          ? { ...previous, followUp: true }
          : { kind: 'row', rowId: logRowId ?? '', tab: 'log', followUp: true },
      );
    },
    [checkpointAnchorOf, logRowId],
  );

  /**
   * 追问的**输入区**：只在「这一行是点「追问」打开的、且它此刻不在跑」时渲染。
   *
   * 与运行中那条输入区互斥（那一支的判据是 `isRunningRow`）：行在跑时「追问」按钮本来就是禁用的
   * （判据在服务端那一份里），这里再挡一次是为了「抽屉先开着、行随后跑起来」那一拍——
   * 那一刻该显示的是排队输入区（`injectFooter`），而不是一个点了会被 409 拒的追问框。
   * `onUploadAttachment` 走的是**同一条 multipart 端点**：附件落点就是同一个
   * `rowDir/attachments/<messageId>/`（生命周期挂在行目录上，不按入口分两处）。
   */
  const followUpFooter =
    drawer?.kind === 'row' && drawer.tab === 'log' && drawer.followUp === true && logRow !== undefined && logModel !== null && !isRunningRow(logRow.status) ? (
      <FollowUpComposer
        busy={isFollowingUp || isCheckingPoint}
        // 建议 chips 读装配好的行级事实（`contextUsed` 是装配层从事件流算出来的，`logFacts` 里没有）
        facts={logModel.facts}
        // 追问判据（服务端读侧）：chips 的禁用与原因只读这一份，不在输入区里再判一遍
        followUpVerdict={followUps.verdictOf(logRow.id)}
        onSend={async (input) => {
          /**
           * 有「回到某一轮」的目标 ⇒ 这一次提交是**从那一轮续跑**（旧内容先标作废），
           * 否则就是普通追问。两条路共用同一个输入区：附件、错误呈现与忙碌态一行都不重复。
           */
          if (checkpoint !== null) {
            await checkpointRow({
              runId,
              rowId: logRow.id,
              segment: checkpoint.segment,
              turn: checkpoint.turn,
              keepAt: checkpoint.keepAt,
              dropFrom: checkpoint.dropFrom,
              messageId: input.messageId,
              text: input.text,
              attachments: input.attachments,
            });
            setCheckpoint(null);
          } else {
            await followUpRow({
              runId,
              rowId: logRow.id,
              messageId: input.messageId,
              text: input.text,
              attachments: input.attachments,
            });
          }
          // 发出去之后这一行会翻成「准备中」：判据（能否追问）跟着变，顺手重读一次
          await followUps.refresh();
        }}
        onUploadAttachment={async (input) => postInjectAttachment({ runId, rowId: logRow.id, ...input })}
        onError={(cause) => void toast.error(describeError(cause))}
      />
    ) : undefined;

  /**
   * 底部槽这一格**只有两个可能**：追问输入区（这一行跑完了、人是点「追问」进来的）或
   * 运行中的排队输入区。两支互斥（判据见上面各自的注释），缺席时一个节点都不渲染。
   */
  const logFooter = followUpFooter ?? injectFooter;
  /**
   * 离开「追问/续跑」那一刻作废掉待办目标：否则下一次点普通的「追问」会带着上一次的
   * 「回到第 N 轮」一起发出去——那是一次静默的错误续段。
   */
  useEffect(() => {
    if (drawer?.kind !== 'row' || drawer.followUp !== true) setCheckpoint(null);
  }, [drawer]);

  /** 每次操作都收口到 `describeError`：ServiceError 的中文 message 直接展示，其余给兜底文案 */
  const guard = async (action: () => Promise<unknown>): Promise<void> => {
    try {
      await action();
    } catch (cause) {
      void toast.error(describeError(cause));
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
      rows: values.rows.map((row) => ({
        agentKind: row.agentKind, providerId: row.providerId, modelId: row.modelId, effort: row.effort,
      })),
    };
    try {
      const created = await create(input);
      // 创建完直接进详情：使用者下一步一定是点「开始」
      router.replace(runsPanelHref('detail', created.id));
    } catch (cause) {
      void toast.error(describeError(cause));
    }
  };

  /**
   * 编辑：把在途请求的 promise **交回给表单**（`RunCreatePanel` 的 `onSubmit` 注释写明了原因：
   * 返回 undefined 时保存前的确认框会立刻关闭并显示成「点一下没反应」）。
   * `RunFormValues` 与契约的 `RunUpdate` 逐字段一致（含行 id 与 effort），故原样交给数据层——
   * 在这里再抄一遍字段只会静默丢掉后来新增的格子。
   */
  const handleUpdate = async (values: RunFormValues): Promise<void> => {
    if (run === undefined) return;
    try {
      await update(run.id, values);
      void toast.success('评测已保存');
      router.replace(runsPanelHref('detail', run.id));
    } catch (cause) {
      // 失败就留在编辑态（不跳转）：中文原因由服务端给，改完可以原地再存一次
      void toast.error(describeError(cause));
    }
  };

  /**
   * 删除：**必须把在途 promise 交回确认框**（`RunDetailPanel` 的 `onDelete` 注释写明了原因）。
   * `workspaceRemoved === false` 时如实说一句「有残留」——盘子上的行工作区没能回收，
   * 那既不等于删除失败，也不该假装干净。
   */
  const handleDelete = (): Promise<void> | undefined => {
    if (run === undefined) return undefined;
    return remove(run.id)
      .then((result) => {
        void toast.success(result.workspaceRemoved ? '评测已删除' : '评测已删除；行工作区有残留（被占用），可手动清理');
        // 删除后回列表（无右栏）：右栏留在一条已经不存在的轮次上没有意义
        closePanel();
      })
      // 失败在这里收束：把 reject 交回给确认框只会在控制台留一条未处理的 rejection，
      // 用户已经在 toast.error 里拿到了中文原因
      .catch((error) => void toast.error(describeError(error)));
  };

  const closePanel = (): void => {
    setDrawer(null);
    router.replace(runsPanelHref(null, null));
  };

  /**
   * 切页签：只改同一支抽屉的 `tab`，`rowId` 不变 ⇒ 面板不重挂载。
   *
   * 评分页签的两个二级层（原始返回 / 原始输出）在这里一并收掉：它们的开合态住在页面，
   * 留在别的页签上会成为「浮在主抽屉之上、却不属于当前页签」的孤儿层。
   * 日志页签的环境信息由 `AgentLogLayout` 的 `active` 自己收（它的开合态在布局件内部）。
   */
  const handleDrawerTabChange = (tab: RunDetailTab): void => {
    setRawRowId(null);
    setJudgeOutputRowId(null);
    setDrawer((previous) => {
      if (previous === null || previous.kind !== 'row') return previous;
      return { ...previous, tab, followUp: tab === 'log' ? previous.followUp : false };
    });
  };

  /** 下载用 `/log` 的全量（而不是连接里收到的那份）：连接可能中途断过，落盘的那份才是完整的 */
  const handleDownloadLog = (): void => {
    const text = formatEventLog(log.events ?? stream.events);
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `row-${logRowId ?? 'log'}.log`;
    link.click();
    // 立即 revoke 会让部分浏览器拿不到内容，下一拍再释放
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  const list = (
    <div className="flex h-full min-h-0 flex-col gap-4">
      {/* 页标题按 shadcn 的 page header 约定：标题 24 / 描述 14 + muted，动作靠右。
          它不跟密度档——密度管正文与行高，页标题一旦被压到正文同号，整页就没有视觉重心。 */}
      <PageHeader
        title="评测"
        description={
          runs === undefined ? '正在加载…' : `共 ${runs.length} 次评测 · 点一行查看分数、日志与变更`
        }
        actions={
          <Button size="sm" onClick={() => router.replace(runsPanelHref('new', null))}>
            <PlusIcon aria-hidden />
            创建评测
          </Button>
        }
      />
      {listError !== null && listError !== undefined && (
        // 说清「屏幕上这份列表可能是旧的」：SWR 读失败时保留上一份数据，
        // 只报「加载失败」而列表还在，读起来像「加载成功但内容没变」
        <Alert variant="destructive" className="mb-2">
          <AlertTitle>{`评测列表读不出来：${describeError(listError)}`}</AlertTitle>
          <AlertDescription>列表显示的可能还是上一次读到的内容；刷新页面会重新请求。</AlertDescription>
        </Alert>
      )}
      {runs !== undefined && runs.length === 0 ? (
        <EmptyState
          title="还没有评测"
          description="先创建一个用例，再新建一次评测"
          action={{
            label: '创建评测',
            icon: <PlusIcon aria-hidden />,
            variant: 'dashed',
            onClick: () => router.replace(runsPanelHref('new', null)),
          }}
        />
      ) : (
        // 纵向与横向滚动都由 DataTable 自己的容器承担：空数据不会出现常驻滚动条，
        // 标题列由 `pinned: 'start'` 钉在左边（偏移来自声明的 240），它的宽度由
        // `fillColumnId` 吃掉容器剩余宽度——表格铺满整栏，右侧不再留一条空白。
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border">
          <DataTable
            columns={RUN_COLUMNS}
            fillColumnId="caseTitle"
            data={runs ?? []}
            rowKey={(record) => record.id}
            rowHeight={40}
            enableSorting
            // 默认创建时间倒序（与服务端顺序一致，首点落回 desc）
            defaultSorting={[{ id: 'createdAt', desc: true }]}
            tableAttributes={{ 'data-testid': 'runs-table' }}
            emptyText={isLoading ? <Skeleton className="h-4 w-full" /> : '还没有评测'}
            rowAttributes={(record) => {
              const selected = record.id === selectedId;
              return {
                'data-testid': 'run-list-row',
                'data-selected': String(selected),
                'aria-selected': selected,
                tabIndex: 0,
                // 行是「按钮」语义：空格默认会滚动页面，必须拦下（与用例页的行同口径）
                onKeyDown: (event) => {
                  if (event.key !== 'Enter' && event.key !== ' ') return;
                  event.preventDefault();
                  router.replace(runsPanelHref('detail', record.id));
                },
                // 选中态**不能只靠底色**：`bg-muted` 与 `bg-background` 的明度差在浅色主题下约 3.5%，
                // 键盘焦点再落到同一格就没有任何变化。故选中另给左侧 2px 主色条（落在首列单元格上，
                // 表格是 separate border 模型，`<tr>` 的 box-shadow 不保证绘制），
                // 焦点另给一圈 ring——两者是不同信号，互不覆盖。
                className: `group cursor-pointer outline-none focus-visible:outline-2 focus-visible:[outline-style:solid] focus-visible:outline-offset-[-2px] focus-visible:outline-ring ${
                  selected ? 'bg-muted' : 'bg-background'
                }`,
                onClick: () => router.replace(runsPanelHref('detail', record.id)),
              };
            }}
            cellAttributes={(record, columnId) =>
              columnId === 'caseTitle' && record.id === selectedId
                ? { className: 'shadow-[inset_2px_0_0_var(--primary)]' }
                : undefined
            }
            ariaLabel="评测列表"
          />
        </div>
      )}
    </div>
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
      // ——照着它保存会把这一轮已有的行整批换掉。等下面那两条 loading / not-found 分支即可。
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
        description="它可能被手工清理过；回到列表重新选择一次评测"
        action={{ label: '回到列表', onClick: closePanel }}
      />
    ) : run === undefined ? (
      <EmptyState title="正在加载评测…" />
    ) : (
      <RunDetailPanel
        run={run}
        starting={isStarting}
        aborting={isAborting}
        capabilityOf={capabilityOf}
        liveOf={(rowId) => live[rowId]}
        activityOf={(rowId) => activity[rowId]}
        onStart={() => void guard(() => start(run.id))}
        onAbortRun={() => void guard(() => abort(run.id))}
        onAbortRow={(rowId) => void guard(() => abortRow(run.id, rowId))}
        onRescoreRow={(rowId) => void guard(() => rescoreRow(run.id, rowId))}
        rescoring={isRescoring}
        onRetryRow={(rowId) => void guard(() => retryRow(run.id, rowId))}
        retrying={isRetrying}
        // 「追问」只打开这一行的抽屉（输入区在 footer 上），故它没有自己的写请求：
        // 真正的承诺在那一句话发出去的时候，不需要额外一道确认
        onFollowUpRow={(rowId) => {
          setCheckpoint(null);
          setDrawer({ kind: 'row', rowId, tab: 'log', followUp: true });
        }}
        followUpOf={followUps.verdictOf}
        followingUp={isFollowingUp}
        onOpenLog={(rowId) => setDrawer({ kind: 'row', rowId, tab: 'log' })}
        onOpenDiff={(rowId) => setDrawer({ kind: 'row', rowId, tab: 'diff' })}
        onOpenScore={(rowId) => setDrawer({ kind: 'row', rowId, tab: 'score' })}
        // 排名抽屉比的是候选之间的名次：它没有「哪一行」这一维，故不开行 id
        onOpenRank={() => setDrawer({ kind: 'rank' })}
        onEdit={() => router.replace(runsPanelHref('edit', run.id))}
        // 桌面双栏下的关闭入口：退回单栏列表，URL 随之回到不带 panel 的形态
        onClose={closePanel}
        onDelete={handleDelete}
        deleting={isDeleting}
      />
    );

  return (
    <>
      <AppTopNav items={[...NAV_ITEMS]} active="runs" onNavigate={(href) => router.push(href)} onSearch={requestCommandPalette} />
      <ListDetailLayout
        list={list}
        detail={detail}
        detailOpen={panel.panel !== null}
        widthStorageKey="runs-detail-width"
        onRequestCloseDetail={closePanel}
      />

      {/*
        「评测详情」抽屉：**同一个抽屉 + 页签头**（日志 / 变更 / 评分）。
        三个入口仍然一次点击直达各自的页签；切页签只换可见面板，**不卸载**——
        滚动位置、展开过的工具行、过滤条件因此活着，也不会播「关一个、开一个」两遍动画。

        正文的高度链：`RunDetailDrawer` 的面板是纵向 flex，页签面板 `flex-1 min-h-0`，
        日志页签里的 `AgentLogLayout` 再取满剩余高度（虚拟列表需要一个确定高度的视口）。
        页面这里只给内容与内边距，不套第二层滚动区。

        **读取中**在页签里给一句空态（不是整段不渲染）：抽屉已经是同一个元素，
        不会再有「空壳重放进场动画」的问题；点「执行日志」立刻有回应比什么都不弹更好。
        **故障**仍然整段替换日志页签的正文：抽屉内部的空态是「还没有日志 · 这一行还没开始执行」，
        与「读不出来」一起出现会把一个带文件路径的真实故障说成「还没开始跑」。
        两条来源的**非破坏性**提示（有数据时的实时通道故障 / 读失败）照旧交给布局件渲染。
      */}
      <RunDetailDrawer
        open={drawer?.kind === 'row'}
        onClose={() => setDrawer(null)}
        activeTab={drawerTab}
        onTabChange={handleDrawerTabChange}
        log={
          logState.kind === 'loading' ? (
            <div className="flex min-h-0 flex-1 items-center justify-center p-roomy">
              <EmptyState title="正在加载日志…" />
            </div>
          ) : logState.kind === 'failed' ? (
            <div className="min-h-0 flex-1 overflow-auto px-roomy pb-roomy">
              <Alert variant="destructive" data-testid="run-log-drawer-failed">
                <AlertTitle>执行日志读取失败</AlertTitle>
                <AlertDescription>{logState.message}</AlertDescription>
              </Alert>
            </div>
          ) : (
            <AgentLogLayout
              // 日志页签被切走时把它内部的二级层（环境信息）收起来：否则那个 portal
              // 会浮在变更 / 评分页签之上
              active={drawerTab === 'log'}
              model={logModel ?? NEVER_RAN_MODEL}
              diagnostics={{ status: 'ready', data: logDiagnostics }}
              {...(logEnvironment === undefined ? {} : { environment: logEnvironment })}
              {...(logSourceRef === undefined ? {} : { source: logSourceRef })}
              onDownload={handleDownloadLog}
              // 非破坏性提示：判定在纯函数里（`resolveLogDrawer`），渲染在 `AgentLogLayout` 里。
              // **有真数据时如实说明，不把它藏起来**——两条来源的故障各占一个提示位。
              notice={logState.warning === undefined ? undefined : `日志可能不完整：${logState.warning}`}
              liveError={logState.liveError}
              connected={stream.connected}
              // 终态行没有实时流是正常的：不传这一格时文案是「未连接」，读起来像通道故障
              settled={logRow !== undefined && !isRunningRow(logRow.status)}
              // 轮末「回到这里」：能力声明只从注册表元数据来（页面不判厂商），
              // 厂商条目坐标由消息账本那两格现算（算不出 ⇒ 按钮置灰并说明这一次的事实原因）
              checkpoint={logRow === undefined ? null : checkpointOf(logRow.agentKind)}
              {...(logRow === undefined ? {} : { onCheckpoint: handleCheckpoint })}
              checkpointAnchorOf={checkpointAnchorOf}
              // 底部槽（第三段固定区）：运行中那一支是排队/插队输入区，跑完之后那一支是追问输入区
              {...(logFooter === undefined ? {} : { footer: logFooter })}
            />
          )
        }
        diff={
          // 变更详情自己管滚动（左树与右栏各自滚），外层只负责把它撑满可用高度：
          // 这里再套一层 `overflow-auto` 就会出现第二条滚动条
          <div className="flex min-h-0 flex-1 flex-col">
            {diffIndex.index === undefined ? (
              diffIndex.error === null || diffIndex.error === undefined ? (
                <p className="px-roomy pt-roomy text-sm text-muted-foreground">正在读取变更…</p>
              ) : (
                // 失败与「正在读」必须分开：把故障写在同一行灰字里，使用者分不清是慢还是坏了，
                // 也没有任何出路。故给标题 + 中文原因 + 可重试的按钮，原始 git 串收进折叠区。
                <div className="px-roomy pt-roomy">
                  <Alert variant="destructive" data-testid="run-diff-drawer-failed">
                    <AlertTitle>变更详情读取失败</AlertTitle>
                    <AlertDescription>
                      读取这一行的代码改动时失败，暂时看不到 diff。常见原因是工作区正被其它进程占用，
                      或文件权限不允许读取；处理之后点「重新读取」。
                    </AlertDescription>
                    <div className="mt-2 flex flex-wrap items-center gap-3">
                      <Button size="sm" variant="outline" onClick={diffIndex.refresh}>
                        重新读取
                      </Button>
                      <Collapsible>
                        <CollapsibleTrigger className="text-sub text-muted-foreground underline underline-offset-4 hover:text-foreground">
                          查看原始错误
                        </CollapsibleTrigger>
                        <CollapsibleContent>
                          <p className="mt-2 font-mono text-sub break-all text-muted-foreground">
                            {describeError(diffIndex.error)}
                          </p>
                        </CollapsibleContent>
                      </Collapsible>
                    </div>
                  </Alert>
                </div>
              )
            ) : (
              <DiffView
                // 列表给**累积**的那些文件，计数与截断信息仍取本页响应（它们是全局值）
                index={{ ...diffIndex.index, files: diffFiles }}
                dark={themeMode === 'dark'}
                {...(diffFiles.length < diffIndex.index.total ? { onLoadMore: () => setDiffOffset(diffFiles.length) } : {})}
                renderFileBody={(path) => (
                  <DiffFileBody runId={runId} rowId={diffRowId ?? ''} path={path} dark={themeMode === 'dark'} />
                )}
              />
            )}
          </div>
        }
        score={
          <>
            <div className="min-h-0 flex-1 overflow-auto px-roomy pb-roomy">
              {scoreDetail === null ? (
                <EmptyState title="这一行还没有评分" description="评分在智能体跑完之后进行；失败的行不会有分" />
              ) : (
                <ScoreDetailView
                  // 抽屉里的**五格**全在 `score` 上（顶部那一段说的是**这一分**是谁打的、
                  // 花了多少）⇒ 这里只递 `score` 与它的评分表快照，**不再传候选行**——少一个能配错的来源
                  score={scoreDetail.score}
                  rubric={scoreDetail.rubric}
                  rawOpen={rawOpen}
                  // 二级抽屉只能开、由它自己关；这里的 `false` 就是「关掉了」这一个动作
                  onRawOpenChange={(next) => setRawRowId(next ? scoreRowId : null)}
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
                        onOpenChange: (next) => setJudgeOutputRowId(next ? scoreRowId : null),
                      }
                      : undefined
                  }
                />
              )}
            </div>
            {/*
              「查看原始返回」与「原始输出 N 条」两个入口都在 **footer** 上：不占正文的高度、
              也不随正文一起滚走；正文里既没有标题也没有按钮。
              **没有分就没有「查看原始返回」**：那一格是空态「这一行还没有评分」，没有原文可看。
              「原始输出」有自己的可见性判据（`judgeOutputVisible`：智能体评分的行常驻、评分进行中
              也开、文本 API 与 running 期间没有）——两个按钮各判各的，footer 整段不渲染
              才是「两个入口都没有」。
            */}
            {scoreDetail === null && !judgeOutputVisible ? null : (
              <SheetFooter className="flex flex-row justify-end gap-2 border-t">
                {scoreDetail !== null && (
                  <Button
                    size="sm"
                    variant="outline"
                    data-testid="score-raw-open"
                    onClick={() => setRawRowId(scoreRowId)}
                  >
                    查看原始返回
                  </Button>
                )}
                {judgeOutputVisible && (
                  <Button
                    size="sm"
                    variant="outline"
                    data-testid="score-judge-output-open"
                    onClick={() => setJudgeOutputRowId(scoreRowId)}
                  >
                    {judgeOutputLabel}
                  </Button>
                )}
              </SheetFooter>
            )}
          </>
        }
      />

      {/*
        「排名」抽屉：页面级的独立主抽屉，几何与行级详情共用同一份（`MAIN_DRAWER_STYLE`）——
        它比的是候选之间的名次，比评分详情更需要宽度，不该另立一档。
        数据全部来自**已在内存里的这一份 run 快照**（各行的 `score` + 轮级 `rubric`）：
        没有任何一次网络往返，也没有「详情按需再拉一次」这一步。
        `runningCount` 数的是 `isRunningRow` 的行数（不是 `hasLiveRows` 那个布尔：
        后者的轮级那一格数不出 N，会出现「有 0 行正在执行」这种自相矛盾的句子）。
        run 未知（首帧 / 快照没到）时整段不渲染：排名表没有「部分数据」可言，少一行就是错的名次。

        **「产物总览」是从这里推出来的第二层**：
        入口按钮在 footer 上、正文在 `ArtifactOverview` 里，开合态受控（住页面）。
        `ArtifactOverview` 必须留在本抽屉的**子树里**：它内部渲染的 `NestedDrawer` 靠
        React 树把宿主的上下文带过去（portal 带不走）。
      */}
      {run !== undefined && (
        <Sheet
          open={drawer?.kind === 'rank'}
          // 关掉排名抽屉时把二级抽屉的开合一起收掉：重开时它不该自己弹出来
          onOpenChange={(next) => {
            if (next) return;
            setDrawer(null);
            setArtifactOpen(false);
          }}
        >
          <SheetContent side="right" data-drawer="main" style={DRAWER_STYLE}>
            <SheetHeader>
              <SheetTitle>排名</SheetTitle>
              <SheetDescription>候选之间的名次（与候选卡片共用同一份判据）</SheetDescription>
            </SheetHeader>
            <div className="min-h-0 flex-1 overflow-auto px-4 pb-4">
              {/* 评分对比图：横向柱长 = 各候选总分，顺序取排名判据（与下表同源，不在这里再排一次）。
                  没有出分候选时它自己显示「未采集」，不画空坐标系。 */}
              <ScoreChart rows={orderForDisplay(run.rows)} />
              <RankTable run={run} runningCount={liveRowIds.length} testResults={runTests.results} />
            </div>
            {/*
              「产物总览」的入口：**至少有一份产物才出现**（扫不到就没有可总览的东西）。
              读不到清单时置灰 + 浮层挂中文原因，而不是静默不出现——会自己冒出来的按钮，
              「点了没反应」与「它压根不在」是最难自查的两种状态（与「排名」按钮的同一条口径）。
              读取中 / 确实没有产物两种情况都不画 footer。
            */}
            {artifacts.index !== undefined && artifacts.index.total > 0 ? (
              <SheetFooter className="flex flex-row justify-end gap-2 border-t">
                <Button size="sm" variant="outline" data-testid="rank-artifacts-open" onClick={() => setArtifactOpen(true)}>
                  {ARTIFACT_OVERVIEW_LABEL}
                </Button>
              </SheetFooter>
            ) : artifacts.error !== null && artifacts.error !== undefined ? (
              <SheetFooter className="flex flex-row justify-end gap-2 border-t">
                <Hint label={`读不到产物清单：${describeError(artifacts.error)}`}>
                  <Button size="sm" variant="outline" disabled>
                    {ARTIFACT_OVERVIEW_LABEL}
                  </Button>
                </Hint>
              </SheetFooter>
            ) : null}
            {/* 二级抽屉只渲染 portal，不占正文盒子：排在表格之后不影响它的高度链 */}
            <ArtifactOverview
              run={run}
              index={artifacts.index}
              open={artifactOpen}
              onOpenChange={setArtifactOpen}
              renderBody={({ rowId, name }) => <ArtifactFileBody runId={runId} rowId={rowId} name={name} />}
            />
          </SheetContent>
        </Sheet>
      )}
    </>
  );
}
