'use client';

/**
 * 评测页：左侧列表 + 右侧栏（详情 / 创建表单 / 编辑表单），形态与用例页同口径（spec §4.1/§5.3）。
 * 七条口径：
 *   1. `useSearchParams` 会把用到它的子树退化为客户端渲染，故给它一个 `Suspense` 边界
 *      （Next 16 文档 useSearchParams 的 Prerendering 一节）；
 *   2. **日志那一条 SSE 只在该行的日志抽屉打开时订阅**（实时指标那一路只为在跑的行各开一条，见 spec §8）；
 *   3. 三个抽屉的数据各自按需取：日志 = `useRowStream`（实时）+ `useRowLog`（下载要全量）
 *      + `useRowMessages`（时间轴的内容级记录）、改动 = `useRowDiffIndex` + `useRowDiffFile`（服务端每次现算）、
 *      评分详情 = 快照里的 `score` 与 `rubric`（不额外请求）；
 *   4. 页面的可测逻辑（URL 解析、错误文案、日志抽屉的三态）都在 `@/src/runs-view` 与
 *      `@/src/log-drawer-state`，本文件只做拼装；
 *   5. **本页自己不套 `PageShell`**：`ListDetailLayout` 内部已经是 `PageShell`（脚手架原语），
 *      再包一层会多出一个 `ConfigProvider` 与一圈 16px 内边距，与本仓另一处同样形态的
 *      `/cases` 页不一致——两页的骨架必须逐字同形，否则宽度偏好与吸底几何会各自漂移。
 *   6. **右栏三态**（2026-09-28）`?panel=detail|new|edit&id=…`：编辑与详情共用同一份快照
 *      （`selectedId` 两态都取 id）。与 `/cases` 的一处有意差异：runs 页没有需要复位的跨面板
 *      临时状态（用例页那套 `go()` 复位是为仓库校验回显服务的），故不引入那层。
 *   7. **「执行日志」全页只有一支抽屉**（2026-10-03 用户口径「点开会闪一下」的修法）：
 *      「读取中」那一支**什么都不渲染**——那时 `model` 还没算出来，弹出来的必然是空壳，
 *      而它会把真抽屉的入场动画重置（实测：遮罩与面板各重放一次）。根因与实测日志见
 *      `src/drawer-geometry.test.ts` 里那一组用例的注释。
 */
import { Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { PlusOutlined } from '@ant-design/icons';
import { Alert, App, Button, Drawer, Flex, Table, Tag, Typography } from 'antd';
import type { TableColumnsType } from 'antd';
import { isRunningRow, type AgentEnvironment, type EvalRun, type RowDiffIndex, type Rubric, type RunCreate, type ScoreResult } from '@aieval/contracts';
import {
  buildAgentEnvironment,
  useAbortRow,
  useAbortRun,
  useCases,
  useCreateRun,
  useDeleteRun,
  useRowDiffFile,
  useRowDiffIndex,
  useRowLog,
  useRowMessages,
  useRowStream,
  useRun,
  useRunLiveMetrics,
  useRunModelOptions,
  useRuns,
  useRescoreRow,
  useRetryRow,
  useSettings,
  useStartRun,
  useUpdateRun,
  type AgentLogModel,
  type AgentLogSource,
} from '@aieval/client';
import {
  AgentLogDrawer,
  AppTopNav,
  DRAWER_SEMANTIC_STYLES,
  DiffFileContent,
  DiffView,
  EllipsisText,
  EmptyState,
  ListDetailLayout,
  MAIN_DRAWER_PUSH,
  RunCreatePanel,
  RunDetailPanel,
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
  useAppliedThemeMode,
  // 表单交回的值的形状：创建与编辑两条路径都按它收敛（`RunUpdate` 与它逐字段一致）
  type Loadable,
  type RunFormValues,
} from '@aieval/ui';
import { buildRowFacts, resolveLogDrawer } from '@/src/log-drawer-state';
import { NAV_ITEMS } from '@/src/nav';
import { describeError, parseRunsPanel, runsPanelHref, type DrawerKind } from '@/src/runs-view';

/** 轮级状态 → 中文与颜色（行级状态在 ui 的 RowStatusTag 里；轮级只有 4 个值） */
const RUN_STATUS_META: Record<EvalRun['status'], { label: string; color: string }> = {
  idle: { label: '未开始', color: 'default' },
  running: { label: '执行中', color: 'processing' },
  partial: { label: '部分完成', color: 'warning' },
  done: { label: '已完成', color: 'success' },
};

/** 「标题」列的兜底最小宽度：左栏被拖窄时，这一列至少还得读得下一整个用例名（与用例页同口径的 240） */
const RUN_TITLE_MIN_WIDTH = 240;

/** 另外四列申报的宽度：状态 / 候选数 / 执行模式 / 创建时间 */
const RUN_COLUMN_WIDTH = { status: 96, rows: 80, executionMode: 96, createdAt: 150 } as const;

/**
 * 列表表格的最小宽度（px）：左栏窄于它时**才**横向滚动，并把「标题」钉在左边
 * （用户口径 2026-10-08：「标题列左悬浮」；与用例页、供应商表同一套口径，见
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
  RUN_COLUMN_WIDTH.rows +
  RUN_COLUMN_WIDTH.executionMode +
  RUN_COLUMN_WIDTH.createdAt;

/** 当前打开的是哪个抽屉（`null` = 都关着） */
type OpenDrawer = { kind: DrawerKind; rowId: string };

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
 * 「变更详情」「评分详情」两个抽屉共用的几何口径（spec §5.3.4「抽屉几何」）——**与「执行日志」是同一份**。
 *
 * 常量住在 `@aieval/ui` 的 `base/drawer-geometry`：那三个抽屉分居两个包（执行日志的几何在
 * `AgentLogDrawer` 里），各写一份必然漂移，而漂移是静默的（2026-10-03 实测：antd 6 废弃
 * `width` 后这两处漏改，抽屉掉回默认 `378px`，比执行日志窄一半，且没有任何用例变红）。
 *
 * ⚠️ **宽度走 `size`，不走 `styles.wrapper.width`**（antd 6 已废弃 `width`，控制台会打 warning）。
 * 所以本页的抽屉都摊开这一份 `{ size, styles }`：`size` 是宽度本身，`styles` 是
 * 「窄屏兜底 + 内容区 `padding: 0`」（内边距由各抽屉自己的内容给）。
 *
 * `push` 也在这里：二级抽屉（「模型原始返回」那种）打开时**被推开的正是这三个主抽屉**，
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
 * 「这一行还没开始跑」时抽屉吃的空模型。
 *
 * 为什么必须有一个**非空**的模型：抽屉的内部空态判据是 `model.empty`（文案「还没有日志 ·
 * 这一行还没开始执行」），而 `empty === true` 与 `empty === false` 是**两种不同的空**
 * （见设计 §6.1 的三种空）——没有模型就没有事实条可画，故给一份如实为空的模型，
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
     * （见 §6.8：`undefined` ⇒ 无重试按钮）。省掉它，读取失败时就只剩一句错误、没有重试。
     */
    requestEnvironment: () => undefined,
    // 原始输出是**按需注入**的独立 Loadable（体积与时机两条理由，见设计文档 §5.3）；
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
  const router = useRouter();
  const searchParams = useSearchParams();
  const { message } = App.useApp();
  const panel = parseRunsPanel(searchParams);
  const [drawer, setDrawer] = useState<OpenDrawer | null>(null);
  const { runs, isLoading, error: listError } = useRuns();
  // 详情与编辑都要这一轮的快照（编辑表单的预填只有这一个来源），故两态都取 id
  const selectedId = panel.panel === 'detail' || panel.panel === 'edit' ? panel.id : null;
  const { run, error: runError } = useRun(selectedId);
  const { cases } = useCases();
  /**
   * 设置页那一格「默认评分智能体」是否已配置（spec §6）：开关打开而它没配时，创建表单要
   * **当场**给内联提示，而不是等候选跑完几分钟后才在评分阶段失败。
   * `settings === undefined`（SWR 首帧 / 读设置失败）时传 `undefined`：未知 ≠ 没配，
   * 不能把「还没读到设置」显示成「你没配」。
   */
  const { settings } = useSettings();
  const { optionsFor, capabilityOf, defaultEffortOf, messageCapabilityOf } = useRunModelOptions();
  const { create, isCreating } = useCreateRun();
  const { update, isUpdating } = useUpdateRun();
  const { remove, isDeleting } = useDeleteRun();
  const { start, isStarting } = useStartRun();
  const { abort, isAborting } = useAbortRun();
  const { abortRow } = useAbortRow();
  const { rescoreRow, isRescoring } = useRescoreRow();
  const { retryRow, isRetrying } = useRetryRow();
  const runId = run?.id ?? '';
  const logRowId = drawer?.kind === 'log' ? drawer.rowId : null;
  const diffRowId = drawer?.kind === 'diff' ? drawer.rowId : null;
  // 只在该行的日志抽屉打开时才订阅它的事件流（spec §8 末段）
  const stream = useRowStream({ runId, rowId: logRowId ?? '', enabled: logRowId !== null });
  /**
   * 跑动期的实时指标（用户口径，2026-09-26）：**只为在跑的行**各开一条连接，
   * 界面上的 tok / 轮次 / 耗时因此不必等这一行结束。
   * 行集合每帧都是新数组：`useRunLiveMetrics` 内部按 join 出来的稳定键做依赖，
   * 所以这里不需要 useMemo（多一层记忆化只会多一个可能不同步的来源）。
   */
  const liveRowIds = (run?.rows ?? []).filter((row) => isRunningRow(row.status)).map((row) => row.id);
  const live = useRunLiveMetrics({ runId, rowIds: liveRowIds });
  const log = useRowLog(runId, logRowId ?? '', logRowId !== null);
  /**
   * 时间轴的来源：内容级记录（消息 + 子任务行）。与上一条事件流**并列**、各自独立——
   * 「事件读不出来」不代表时间轴没东西可画，反过来也一样。
   */
  const messages = useRowMessages({ runId, rowId: logRowId ?? '', enabled: logRowId !== null });
  /**
   * 索引是**分页**的（spec §5.3.4：首帧只拉一页 30 条，其余按滚动逐页追加，**已加载的页不回收**），
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
   * 既是第二份判据、又会把 `data-theme` 改回暗色，于是 ConfigProvider 是明亮主题、
   * diff 视图却按暗色渲染（症状：亮色主题下背景不对）。真正的解析在 `providers.tsx`。
   */
  const themeMode = useAppliedThemeMode();
  /**
   * 评分详情抽屉要的**两样东西来自同一份 run 快照**：这一行的 `score` 与这一轮的评分表 `rubric`
   * ——评分表是这一分生成时那张表的快照（与 `score.maxScore` 同源），改用例不会换掉它，
   * 而详情正是按**引用键**把判定与评分表逐项对齐的（少了这张表，逐项判定一项也画不出来）。
   * 「这一分是谁打的、花了多少」那**五格**也全在 `score` 上（2026-10-08 用户口径）⇒ 这里**不再递候选行**：
   * 那是执行那一份数据，而抽屉叫「评分详情」。
   * 合成一个对象再判空：拆成多个变量时 JSX 里得各自判空，而「有分却没表」那一格一旦漏判，
   * 渲染出的是一张对不上任何判定的空表。
   */
  const scoreDetail = ((): { score: ScoreResult; rubric: Rubric } | null => {
    if (drawer === null || drawer.kind !== 'score' || run === undefined) return null;
    const row = run.rows.find((candidate) => candidate.id === drawer.rowId);
    if (row === undefined || row.score === null) return null;
    return { score: row.score, rubric: run.rubric };
  })();
  /**
   * 「模型原始返回」二级抽屉的开合（2026-10-04 用户口径）：入口按钮挂在评分详情抽屉的 `footer` 上，
   * 故状态住在页面这一层，视图是**受控**的（`rawOpen` / `onRawOpenChange`）。
   *
   * **记的是「哪一行开着」，不是一个 boolean**：换行、关抽屉、URL 深链三条路都会换 `rowId`，
   * 用 boolean 就得在每一处记得清掉它，漏一处的症状是「点开另一行的评分详情，二级抽屉自己弹出来」
   * ——那种 bug 只在特定点击顺序下出现。带上行 id 之后判据自动为假（关抽屉时 `drawer` 已是 null）。
   */
  const [rawRowId, setRawRowId] = useState<string | null>(null);
  /** 当前评分详情对应的行 id（不是评分抽屉时为 null）：footer 的入口与二级抽屉都以它为判据 */
  const scoreRowId = drawer?.kind === 'score' ? drawer.rowId : null;
  const rawOpen = scoreRowId !== null && rawRowId === scoreRowId;

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

  /** 抽屉要渲染的那一行（评分详情那一支也用它；拿不到就整段不渲染） */
  const logRow = drawer === null ? undefined : run?.rows.find((row) => row.id === drawer.rowId);

  /**
   * 事实条与时间轴模型：**页面只做拼装**——`buildRowFacts`（行级事实的界面口径）与
   * `buildAgentLogModel`（契约形状 → 界面模型）都是纯函数，各自有守卫。
   *
   * 为什么不在这里拼 `AgentLogModel`：那是数据层的活（它才认识 `mergeKey` / 轮次号的换算），
   * 而把它摊在页面里意味着页面读源码守卫才能钉住形状。这里的 `useMemo` 依赖三个输入，
   * 为的是「一次上游提交只重建一次」（父组件因 SSE 重渲染时不重算）。
   */
  const logFacts = logRow === undefined ? null : buildRowFacts({ row: logRow, events: stream.events });
  /**
   * 这一行的**能力声明**（spec v3 §2.5）：五格各自带「从哪条通道取到 / 为什么取不到」。
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
   * 环境信息（设计 §4.3）：**按值给**抽屉，不新开端点——四组数据页面都已经拿在手上
   * （运行配置来自 `EvalRow` / `EvalRun` 的快照字段、厂商系统层来自事件流里的 `system/init` 行、
   * 实测统计来自内容记录里的 `tool-call`）。
   *
   * 为什么不做成「点了才取」：`requestEnvironment` 那一格存在的意义是**把取数时机从组件里搬出去**，
   * 而这里的「取数」是本进程内一次纯函数调用（无网络、无 IO）⇒ 按值给才是它该有的形态，
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
   * `effort` 必须一起带上：契约显式声明了这一格，漏掉就是静默丢掉用户选的思考强度。
   */
  const handleCreate = async (values: RunFormValues): Promise<void> => {
    const input: RunCreate = {
      caseId: values.caseId,
      executionMode: values.executionMode,
      useAgentJudge: values.useAgentJudge,
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
      void message.error(describeError(cause));
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
      void message.success('评测已保存');
      router.replace(runsPanelHref('detail', run.id));
    } catch (cause) {
      // 失败就留在编辑态（不跳转）：中文原因由服务端给，改完可以原地再存一次
      void message.error(describeError(cause));
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
        void message.success(result.workspaceRemoved ? '评测已删除' : '评测已删除；行工作区有残留（被占用），可手动清理');
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
    link.download = `row-${logRowId ?? 'log'}.log`;
    link.click();
    // 立即 revoke 会让部分浏览器拿不到内容，下一拍再释放
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  const columns: TableColumnsType<EvalRun> = [
    {
      // 列名只叫「标题」（用户 2026-09-29）：与用例页的列表头逐字同形，左栏就一列标题，不必再冠以「用例」
      title: '标题',
      dataIndex: 'caseTitle',
      // 钉在左边（用户口径 2026-10-08）：横向滚动时其余四列从它下面滑过，「这一行是哪个用例的评测」
      // 始终看得见。第一列的 sticky `left` 恒为 0，**不依赖自身申报宽度**（要靠前面列宽累加的是
      // 第二个之后的固定列，本表没有），所以下面那条「不传 width」的口径原样保留。
      fixed: 'left',
      // 不传 width：与用例页同口径——省略号落在单元格右边缘，栏位拖宽后长标题多显示
      // （写死 px 时文字块比单元格宽，超出的一段连同省略号一起被单元格裁掉）
      render: (title: string) => <EllipsisText text={title} />,
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: RUN_COLUMN_WIDTH.status,
      render: (status: EvalRun['status']) => <Tag color={RUN_STATUS_META[status].color}>{RUN_STATUS_META[status].label}</Tag>,
    },
    {
      title: '候选数',
      dataIndex: 'rows',
      width: RUN_COLUMN_WIDTH.rows,
      align: 'left',
      render: (_rows, record) => record.rows.length,
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
            // 同用例页：列宽由表头算，`EllipsisText` 的省略号才有确定的分母（用户 2026-09-29 的口径）。
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
        description="它可能被手工清理过；回到列表重新选择一轮"
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
        onStart={() => void guard(() => start(run.id))}
        onAbortRun={() => void guard(() => abort(run.id))}
        onAbortRow={(rowId) => void guard(() => abortRow(run.id, rowId))}
        onRescoreRow={(rowId) => void guard(() => rescoreRow(run.id, rowId))}
        rescoring={isRescoring}
        onRetryRow={(rowId) => void guard(() => retryRow(run.id, rowId))}
        retrying={isRetrying}
        onOpenLog={(rowId) => setDrawer({ kind: 'log', rowId })}
        onOpenDiff={(rowId) => setDrawer({ kind: 'diff', rowId })}
        onOpenScore={(rowId) => setDrawer({ kind: 'score', rowId })}
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
        「还没有日志 · 这一行还没开始执行」，与「读不出来」一起出现会把一个带文件路径的真实故障
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
          onDownload={handleDownloadLog}
          // 非破坏性提示：判定在纯函数里（`resolveLogDrawer`），渲染在 `AgentLogLayout` 里。
          // **有真数据时如实说明，不把它藏起来**——两条来源的故障各占一个提示位。
          notice={logState.warning === undefined ? undefined : `日志可能不完整：${logState.warning}`}
          liveError={logState.liveError}
          connected={stream.connected}
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
              <DiffFileBody runId={runId} rowId={diffRowId ?? ''} path={path} dark={themeMode === 'dark'} />
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
          「查看原始返回」的入口在 **footer** 上（2026-10-04 用户口径）：它不再占正文的高度、
          也不再随正文一起滚走；正文里既没有标题也没有按钮。
          **没有分就没有入口**：那一格是空态「这一行还没有评分」，没有原文可看（footer 为 null 时
          antd 连那一条 footer 都不渲染）。
        */
        footer={
          scoreDetail === null ? null : (
            <Flex justify="flex-end">
              <Button
                size="small"
                autoInsertSpace={false}
                data-testid="score-raw-open"
                onClick={() => setRawRowId(scoreRowId)}
              >
                查看原始返回
              </Button>
            </Flex>
          )
        }
      >
        {scoreDetail === null ? (
          <div style={{ padding: 16 }}>
            <EmptyState title="这一行还没有评分" description="评分在 agent 跑完之后进行；失败的行不会有分" />
          </div>
        ) : (
          <ScoreDetailView
            // 抽屉里的**五格**全在 `score` 上（2026-10-08 用户口径：顶部那一段说的是**这一分**是谁打的、
            // 花了多少）⇒ 这里只递 `score` 与它的评分表快照，**不再传候选行**——少一个能配错的来源
            score={scoreDetail.score}
            rubric={scoreDetail.rubric}
            rawOpen={rawOpen}
            // 二级抽屉只能开、由它自己关；这里的 `false` 就是「关掉了」这一个动作
            onRawOpenChange={(next) => setRawRowId(next ? scoreRowId : null)}
          />
        )}
      </Drawer>
    </>
  );
}
