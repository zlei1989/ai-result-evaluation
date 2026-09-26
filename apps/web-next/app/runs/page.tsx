'use client';

/**
 * 评测页：左侧列表 + 右侧栏（详情 / 创建表单 / 编辑表单），形态与用例页同口径（spec §4.1/§5.3）。
 * 六条口径：
 *   1. `useSearchParams` 会把用到它的子树退化为客户端渲染，故给它一个 `Suspense` 边界
 *      （Next 16 文档 useSearchParams 的 Prerendering 一节）；
 *   2. **逐行 SSE 只在该行的日志抽屉打开时订阅**（spec §8 末段）：否则 10 个候选 × 多个评测
 *      会开出几十条长连接；
 *   3. 三个抽屉的数据各自按需取：日志 = `useRowStream`（实时）+ `useRowLog`（下载要全量）、
 *      改动 = `useRowDiff`（服务端每次现算）、评分详情 = 快照里的 `score` 与 `rubric`（不额外请求）；
 *   4. 页面的可测逻辑（URL 解析、错误文案、日志抽屉的三态）都在 `@/src/runs-view` 与
 *      `@/src/log-drawer-state`，本文件只做拼装；
 *   5. **本页自己不套 `PageShell`**：`ListDetailLayout` 内部已经是 `PageShell`（脚手架原语），
 *      再包一层会多出一个 `ConfigProvider` 与一圈 16px 内边距，与本仓另一处同样形态的
 *      `/cases` 页不一致——两页的骨架必须逐字同形，否则宽度偏好与吸底几何会各自漂移。
 *   6. **右栏三态**（2026-09-28）`?panel=detail|new|edit&id=…`：编辑与详情共用同一份快照
 *      （`selectedId` 两态都取 id）。与 `/cases` 的一处有意差异：runs 页没有需要复位的跨面板
 *      临时状态（用例页那套 `go()` 复位是为仓库校验回显服务的），故不引入那层。
 */
import { Suspense, useEffect, useRef, useState, type ReactNode } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { PlusOutlined } from '@ant-design/icons';
import { Alert, App, Button, Drawer, Flex, Table, Tag, Typography } from 'antd';
import type { TableColumnsType } from 'antd';
import { isRunningRow, type EvalRun, type RowDiffIndex, type Rubric, type RunCreate, type ScoreResult } from '@aieval/contracts';import {
  useAbortRow,
  useAbortRun,
  useCases,
  useCreateRun,
  useDeleteRun,
  useRowDiffFile,
  useRowDiffIndex,
  useRowLog,
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
} from '@aieval/client';
import {
  AppTopNav,
  DiffFileContent,
  DiffView,
  EllipsisText,
  EmptyState,
  ListDetailLayout,
  LogView,
  RunCreatePanel,
  RunDetailPanel,
  ScoreDetailView,
  TableScrollArea,
  Toolbar,
  formatDateTime,
  formatEventLog,
  useAppliedThemeMode,
  // 表单交回的值的形状：创建与编辑两条路径都按它收敛（`RunUpdate` 与它逐字段一致）
  type RunFormValues,
} from '@aieval/ui';
import { resolveLogDrawer } from '@/src/log-drawer-state';
import { NAV_ITEMS } from '@/src/nav';
import { describeError, parseRunsPanel, runsPanelHref, type DrawerKind } from '@/src/runs-view';

/** 轮级状态 → 中文与颜色（行级状态在 ui 的 RowStatusTag 里；轮级只有 4 个值） */
const RUN_STATUS_META: Record<EvalRun['status'], { label: string; color: string }> = {
  idle: { label: '未开始', color: 'default' },
  running: { label: '执行中', color: 'processing' },
  partial: { label: '部分完成', color: 'warning' },
  done: { label: '已完成', color: 'success' },
};

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
 * 三个抽屉共用的几何口径（spec §7.2.1）。抽成常量而不是各写一遍：
 * 三处手抄必然漂移，而漂移的症状只是「某个抽屉宽度/内边距不一样」——没有任何用例会红。
 *
 * · 宽度 `max(50vw, 800px)`：用 CSS `max()` 而不是在 JS 里量 `window.innerWidth`，
 *   后者要挂 resize 监听、首帧还得处理 SSR 无水 `window` 的情况，而 `max()` 由浏览器直接算；
 * · `maxWidth: '100vw'` 与 antd 自带的 `.ant-drawer-content-wrapper{max-width:100vw}` 同值，
 *   **显式写出来是为了让「窄屏下 800px 下限不许把抽屉撑出屏幕」这条意图留在代码里**；
 * · `body.padding: 0` 之后内边距改由内容自己给（日志与评分详情各自加，变更详情在内层块上给），
 *   否则正文会贴死抽屉边框。
 */
const DRAWER_STYLES = {
  wrapper: { width: 'max(50vw, 800px)', maxWidth: '100vw' },
  body: { padding: 0 },
} as const;

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
  const [drawer, setDrawer] = useState<{ kind: DrawerKind; rowId: string } | null>(null);

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
  const { optionsFor, capabilityOf } = useRunModelOptions();
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
   * 索引是**分页**的（spec §4 ①：首帧只拉一页，DOM 里始终只有几十行），
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
   * 合成一个对象再判空：拆成两个变量时 JSX 里得各自判空，而「有分却没表」那一格一旦漏判，
   * 渲染出的是一张对不上任何判定的空表。
   */
  const scoreDetail = ((): { score: ScoreResult; rubric: Rubric } | null => {
    if (drawer === null || drawer.kind !== 'score' || run === undefined) return null;
    const row = run.rows.find((candidate) => candidate.id === drawer.rowId);
    if (row === undefined || row.score === null) return null;
    return { score: row.score, rubric: run.rubric };
  })();

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
   * **`failed` 那一支不能渲染 `LogView`**：它在没有事件时的空态是「还没有日志 · 这一行还没开始执行」，
   * 与「读不出来」一起出现会把一个带文件路径的真实故障说成「还没开始跑」。
   * `stream.error` 也必须进去（它过去被这里丢掉）：断线时徽标只显示「未连接」而没有原因，
   * 使用者分不清「这一行还没开始跑」与「实时通道连不上」——计划 Review Focus 5 要求的是
   * 「如实反映未连接**并给出原因**」。
   */
  const logState = resolveLogDrawer({
    events: stream.events,
    logError: log.error,
    streamError: stream.error,
    isLoading: log.isLoading,
  });

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
      .catch((error: unknown) => void message.error(describeError(error)));
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
      // 不传 width：与用例页同口径——省略号落在单元格右边缘，栏位拖宽后长标题多显示
      // （写死 px 时文字块比单元格宽，超出的一段连同省略号一起被单元格裁掉）
      render: (title: string) => <EllipsisText text={title} />,
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 96,
      render: (status: EvalRun['status']) => <Tag color={RUN_STATUS_META[status].color}>{RUN_STATUS_META[status].label}</Tag>,
    },
    {
      title: '候选数',
      dataIndex: 'rows',
      width: 80,
      align: 'left',
      render: (_rows: EvalRun['rows'], record) => record.rows.length,
    },
    {
      title: '执行模式',
      dataIndex: 'executionMode',
      width: 96,
      render: (mode: EvalRun['executionMode']) => (mode === 'serial' ? '串行' : '并行'),
    },
    {
      title: '创建时间',
      dataIndex: 'createdAt',
      width: 150,
      render: (createdAt: string) => formatDateTime(createdAt),
    },
  ];

  const list = (
    <Flex vertical style={{ height: '100%', minHeight: 0 }}>
      {/* 不写 title：页面名已由顶栏导航表达，再放一遍「评测记录」标题是重复 */}
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
        // 表格自己不再滚：`scroll={{ y }}` 会让 rc-table 把 `.ant-table-body` 的 `overflow-y` 写死成
        // `scroll`，数据没超出也常驻一条空滚动条（口径见 `TableScrollArea` 的文件头）。
        // 滚动交给外层容器，表头由 `sticky` 钉住；容器在工具栏**下面**，工具栏不跟着滚走。
        <TableScrollArea>
          <Table<EvalRun>
            size="small"
            rowKey="id"
            loading={isLoading}
            columns={columns}
            dataSource={runs ?? []}
            pagination={false}
            sticky
            // 同用例页：列宽由表头算，`EllipsisText` 的省略号才有确定的分母（用户 2026-09-29 的口径）。
            // `sticky` 本就会让 rc-table 落到 `fixed`，显式写出来是为了不把这条前提交给巧合
            tableLayout="fixed"
            onRow={(record) => ({
              onClick: () => router.replace(runsPanelHref('detail', record.id)),
              style:
                record.id === selectedId
                  ? { background: 'var(--app-selected)', cursor: 'pointer' }
                  : { cursor: 'pointer' },
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
        // key 带上 id：`initialValues` 只在挂载时读一次，切换轮次必须重挂载（与 cases 页同手法）
        key={`run-edit-${run.id}`}
        mode="edit"
        initial={run}
        // 同上面那一处：`cases` 未知时原样传 undefined（直开 / 刷新编辑链接时它常比快照后到）
        cases={cases}
        modelOptionsFor={optionsFor}
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

      <Drawer
        title="执行日志"
        placement="right"
        open={drawer?.kind === 'log'}
        onClose={() => setDrawer(null)}
        destroyOnHidden
        styles={DRAWER_STYLES}
      >
        {logState.kind === 'loading' ? (
          <div style={{ padding: 16 }}>
            <Typography.Text type="secondary">正在读取日志…</Typography.Text>
          </div>
        ) : logState.kind === 'failed' ? (
          // 故障（读失败 / 实时通道不可用）：整段替换。**不要**在这里再渲染 LogView——
          // 它的空态会把这次失败说成「还没开始执行」
          <div style={{ padding: 16 }}>
            <Alert
              data-testid="run-log-drawer-failed"
              type="error"
              showIcon
              title="执行日志读取失败"
              description={logState.message}
            />
          </div>
        ) : (
          // 不加内边距：`LogView` 自己已经带 16px，外层再加一圈会变成 32px
          <Flex vertical gap={8}>
            {logState.liveError !== undefined && (
              <Alert
                data-testid="run-log-drawer-live-error"
                type="warning"
                showIcon
                title="实时通道已断"
                description={logState.liveError}
              />
            )}
            {logState.warning !== undefined && (
              <Alert
                data-testid="run-log-drawer-warning"
                type="warning"
                showIcon
                title={`日志可能不完整：${logState.warning}`}
              />
            )}
            <LogView events={logState.events} connected={stream.connected} onDownload={handleDownloadLog} />
          </Flex>
        )}
      </Drawer>

      <Drawer
        title="变更详情"
        placement="right"
        open={drawer?.kind === 'diff'}
        onClose={() => setDrawer(null)}
        destroyOnHidden
        styles={DRAWER_STYLES}
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
            {...(diffFiles.length < diffIndex.index.total
              ? { onLoadMore: () => setDiffOffset(diffFiles.length) }
              : {})}
            renderFileBody={(path) => (
              <DiffFileBody runId={runId} rowId={diffRowId ?? ''} path={path} dark={themeMode === 'dark'} />
            )}
          />
        )}
      </Drawer>

      <Drawer
        title="评分详情"
        placement="right"
        open={drawer?.kind === 'score'}
        onClose={() => setDrawer(null)}
        destroyOnHidden
        styles={DRAWER_STYLES}
      >
        {scoreDetail === null ? (
          <div style={{ padding: 16 }}>
            <EmptyState title="这一行还没有评分" description="评分在 agent 跑完之后进行；失败的行不会有分" />
          </div>
        ) : (
          <ScoreDetailView score={scoreDetail.score} rubric={scoreDetail.rubric} />
        )}
      </Drawer>
    </>
  );
}
