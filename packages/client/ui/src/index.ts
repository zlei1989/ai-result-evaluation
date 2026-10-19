/** ui 公共出口：纯展示组件与界面原语。本包不调接口（数据由调用方以 props 注入）。 */
export { SYSTEM_DARK_QUERY, readSystemDark, resolveThemeMode, type ThemePreference } from './base/theme-resolve';
export { useAppliedThemeMode, useResolvedTheme, type ResolvedTheme, type UseResolvedThemeOptions } from './base/app-theme';
/**
 * 提示通道：`Toaster` 一次挂全（Provider + Portal + Viewport + 列表），`toast` 是按意图命名的调用面
 * （success / error / info / warning / promise），底层是同一个模块级单例，不需要 hook 或上下文。
 * 明暗不在这里配：toast 读 `globals.css` 的语义变量，而真源只有 `html[data-theme]` 一处。
 */
export { Toaster } from './components/ui/toast';
export { toast } from './base/toast';
export { PageShell, type PageShellProps } from './base/page-shell';
export { PageHeader, type PageHeaderProps } from './base/page-header';
export { readStoredPreference, useStoredWidth } from './base/stored-preference';
// 分栏几何：分隔条占位宽 + 宽度规划纯函数。`ListDetailLayout` 之外没有消费者，
// 但它是「窄窗下列表栏不低于 min」的唯一判据来源，故与布局组件并列转出，便于调用方核几何。
export { PANE_SEPARATOR_WIDTH, planPaneWidths, type PaneWidthPlan } from './base/pane-width-plan';
export {
  // 主抽屉与二级抽屉的宽度档：数值只在应用全局样式里写一次，这里转出的是变量引用。
  // 评测页的 `Sheet`、`AgentLogDrawer` 与技能预览都从这一份取——漂移是静默的
  // （把其中一个值就地写死 ⇒ 那一处掉回默认宽度，而没有任何用例变红），见该文件头。
  // `MAIN_DRAWER_STYLE` 还把「二级层打开时主抽屉左移」接在了 Base UI 的嵌套计数上。
  MAIN_DRAWER_STYLE,
  WIDE_DRAWER_SIZE,
} from './base/drawer-geometry';
export { EllipsisText, type EllipsisTextProps } from './base/ellipsis-text';
export { EmptyState, type EmptyStateProps } from './base/empty-state';
export { Toolbar, type ToolbarProps } from './base/toolbar';
/**
 * 数据表套件（TanStack v9）：列固定、行虚拟化、列显隐/排序/行选择（后三者默认关）。
 * 固定列的唯一输入是列定义里的 `size`；缺了 `size` 时 `DataTable` 在渲染前抛错，
 * 静态守卫（`data-table.static.test.ts`）同时扫产品代码里的列定义。
 */
export {
  columnPinningOf,
  DATA_TABLE_SCROLL_STYLE,
  DataTable,
  pinnedColumnsMissingSize,
  type DataTableCellAttributes,
  type DataTableColumn,
  type DataTableElementAttributes,
  type DataTableFeatures,
  type DataTableProps,
  type DataTableRowAttributes,
} from './base/data-table';
export { formatBytes, formatDateTime, shortHash } from './base/format';
export { MonoText, type MonoTextProps } from './base/mono-text';
export { RubricSummaryText, RubricTable, type RubricTableProps } from './composite/rubric-table';
export { RubricAdjustModal, type RubricAdjustModalProps } from './composite/rubric-adjust-modal';
export {
  RubricRecognizeModal,
  type RubricRecognizeModalProps,
} from './composite/rubric-recognize-modal';
export { ROW_STATUS_COLORS, RowStatusTag, type RowStatusTagProps } from './base/row-status-tag';
export { MetricLine, formatCacheHitRate, formatCount, formatDuration, type MetricLineProps } from './base/metric-line';
/**
 * 派生指标：`tok/s` 与「这段时间是哪一种口径」。
 * 为什么从 ui 转出去而不是留在内部：apps/web-next 若将来要把 tok/s 放到卡片上，
 * 必须用**同一份**公式（跨三家统一口径的唯一保证），不能在页面里再写一遍除法。
 */
export {
  formatGenerationRate,
  generationWindowMs,
  timingSourceLabel,
} from './base/usage-metrics';
export {
  // 类名要跨包核对的缘故见 `agent-activity-line.tsx` 的文件头：样式在 apps/web-next 的 globals.css 里，
  // 两处各写一份字符串必然漂移，而「类名对不上」在浏览器里是静默的（动画消失、无报错）。
  ACTIVITY_TYPING_CLASS,
  AgentActivityLine,
  activityText,
  lastSegmentOf,
  staticActivityText,
  typingOf,
  type ActivityTyping,
  type AgentActivity,
  type AgentActivityLineProps,
} from './base/agent-activity-line';
export { ListDetailLayout, type ListDetailLayoutProps } from './base/list-detail-layout';
export { AppTopNav, type AppTopNavItem, type AppTopNavProps } from './composite/app-top-nav';
export {
  CommandPalette,
  GatedCommandPalette,
  requestCommandPalette,
  type CommandPaletteEntry,
  type CommandPaletteGroup,
  type CommandPaletteProps,
  type GatedCommandPaletteProps,
} from './composite/command-palette';
export { CaseFormPanel, type CaseFormPanelProps } from './composite/case-form-panel';
export { CaseDetailPanel, type CaseDetailPanelProps } from './composite/case-detail-panel';
export {
  CASES_TABLE_COLUMN_WIDTH,
  CASES_TABLE_MIN_WIDTH,
  CASES_TABLE_TITLE_MIN_WIDTH,
  CasesTable,
  type CasesTableProps,
} from './composite/cases-table';
export { ProviderTable, type ProviderTableProps } from './composite/provider-table';
/**
 * 设置屏共用的三件小组件：语义告警、删除二次确认、表格空态。
 * 它们的消费者都在设置屏（页面 + 几张表），但页面在 `apps/web-next` 里，只能经包根取用。
 */
export { SettingsAlert, type SettingsAlertProps, type SettingsAlertTone } from './composite/settings-alert';
export { ConfirmDialog, type ConfirmDialogProps } from './composite/confirm-dialog';
export {
  SettingsEmpty,
  type SettingsEmptyAction,
  type SettingsEmptyProps,
} from './composite/settings-empty';
export { SkillTable, type SkillTableProps } from './composite/skill-table';
export { SkillDetailDrawer, type SkillDetailDrawerProps } from './composite/skill-detail-drawer';
export {
  ProviderFormModal,
  type ProviderFormModalProps,
  type ProviderFormValues,
} from './composite/provider-form-modal';
export {
  ProviderModelsModal,
  type ProviderModelsModalProps,
} from './composite/provider-models-modal';
export {
  MODEL_IMPORT_MODAL_WIDTH,
  ProviderModelImportModal,
  type ProviderModelImportModalProps,
} from './composite/provider-model-import-modal';
export {
  McpServerTable,
  endpointText,
  hasConfiguredSecret,
  removeServer,
  upsertServer,
  type McpServerRow,
  type McpServerTableProps,
} from './composite/mcp-server-table';
export {
  MCP_FORM_MODAL_WIDTH,
  McpServerFormModal,
  // 表单值 → 契约条目的**唯一**变换（组件与用例共用）：漏转出的话调用方只能自己再摊一遍，
  // 而「值为空的行丢掉」「args 一行一个」这两条语义在两个实现里必然漂移
  buildMcpConfig,
  type McpKeyValueRow,
  type McpServerFormModalProps,
  type McpServerFormValues,
} from './composite/mcp-server-form-modal';
export {
  MCP_PASTE_MODAL_WIDTH,
  McpPasteModal,
  type McpPasteModalProps,
} from './composite/mcp-paste-modal';
// 测试连接的结果区：两个入口（行内 / 表单）共用同一份渲染，「说什么话」只有一处实现
export {
  McpProbeResultView,
  McpProbeWaiting,
  type McpProbeOutcome,
  type McpProbeResultViewProps,
} from './composite/mcp-probe-result';
export { JudgeSettingsCard, type JudgeSettingsCardProps } from './composite/judge-settings-card';
export {
  WorkspaceSettingsCard,
  type WorkspaceSettingsCardProps,
} from './composite/workspace-settings-card';
export {
  RunCreatePanel,
  // 编辑模式的保存前确认框要用的判据（「这次会作废哪几行」）：面板自己拿它填确认框的内容。
  // **没有任何页面消费者**（别再照抄成「页面拿它决定弹不弹」：弹不弹是面板在 `handleFinish` 里自己判的，
  // 页面只把 `onSubmit` 转发出去）。它随组件一起转出，是因为这条判据与组件同源、且要被**直接**测到
  // （`run-create-panel.test.tsx` 里的 `invalidatedRows` 那一组）。
  invalidatedRows,
  type RunCreatePanelProps,
  type RunFormValues,
  type RunModelOption,
} from './composite/run-create-panel';
export { EvalRowCard, type AgentCapabilityView, type EvalRowCardProps } from './composite/eval-row-card';
export {
  RANK_BADGE_LIMIT,
  RunDetailPanel,
  //  把 `completionPercent(done, total)` 列为 `run-detail-panel.tsx` 的**具名出口**
  //（并在正文里论证它「必须抽出来」：留在组件里时「零行不出现 NaN」那条守卫只能退化成
  // 间接断言）。它必须出现在包根出口清单里，否则 – 的逐名比对不成立。
  completionPercent,
  // 名次与展示顺序的判据也一并转出：排名抽屉要拿**同一份**名次去排它的列，
  // 页面若自己再算一遍就会出现「卡片挂第 1 名、抽屉里排第 2」（`rankOf` 的注释同此口径）
  orderForDisplay,
  rankOf,
  type RunDetailPanelProps,
} from './composite/run-detail-panel';
export { ScoreDetailView, type ScoreDetailViewProps } from './composite/score-detail-view';
export {
  // 排名表：列是候选、行是各项事实（身份 / 执行 / 评分 / 总分），左首列锁住、其余列横向滚动。
  // 三个几何常量、判据说明与名次标记一并转出：守卫按它们断言（判据那几句由具名片段拼装，
  // 改判据时必须回来改这几段；名次标记的拼法同理——用例照抄一份就会与实现漂移）。
  RANK_CANDIDATE_WIDTH,
  RANK_CRITERIA_PARTS,
  RANK_CRITERIA_TEXT,
  RANK_LABEL_WIDTH,
  RankTable,
  rankMarker,
  rankTableMinWidth,
  type RankTableProps,
} from './composite/rank-table';
export {
  // 排名抽屉里的评分对比图（横柱 = 总分）。只导出界面与几个常量：
  // 高度与列宽由静态用例对拍（`ResponsiveContainer` 在 jsdom 里量不到尺寸，尺寸必须可计算）
  SCORE_CHART_LABEL_WIDTH,
  SCORE_CHART_ROW_HEIGHT,
  SCORE_CHART_WIDTH,
  ScoreChart,
  scoreChartData,
  scoreChartDomainMax,
  scoreChartHeight,
  type ScoreChartDatum,
  type ScoreChartProps,
} from './composite/score-chart';
export { DiffFileContent, DiffView, type DiffViewProps } from './composite/diff-view';
export {
  // 产物总览（二级抽屉）：按名次逐份摆候选工作区根下的 `RESULT.*`。
  // 文案常量与高度常量一并转出：页面那个入口按钮与抽屉标题必须同文（两处字面量必然漂移），
  // 高度那一格由静态守卫钉住（它是 iframe 的唯一尺寸来源）
  ARTIFACT_FRAME_HEIGHT,
  ARTIFACT_OVERVIEW_LABEL,
  ArtifactFileContent,
  ArtifactOverview,
  artifactCardTitle,
  type ArtifactFileContentProps,
  type ArtifactOverviewProps,
} from './composite/artifact-overview';
export { formatEventLine, formatEventLog } from './composite/log-format';
/**
 * 应答弹层：吃 `agent-log/types` 那份问题形状（`AskUserQuestion` / `AskUserAnswer`），
 * 纯展示、不调接口——请求与错误提示全归宿主。它摆在 `composite/` 顶层而不是 `agent-log/` 里：
 * `agent-log` 是「复盘一个已结束的运行」的只读目录，应答面是产出方对面的一件独立东西。
 */
export { AskUserPanel, type AskUserPanelProps } from './composite/ask-user-panel';
/**
 * 「执行日志」抽屉（`agent-log`）：**整个目录就是那个通用组件**——吃「一个智能体运行的过程 +
 * 它跑在什么环境里」，不认「评测行」这个业务概念。三层的分界与各自能吃什么是设计的一部分，
 * 故这里把三层各自的门面都转出来（内嵌场景用 `AgentLogLayout`，只读时间轴用 `AgentMessageTimeline`）。
 */
export {
  AgentLogDrawer,
  type AgentLogDrawerProps,
} from './composite/agent-log/agent-log-drawer';
/**
 * 评测详情的**同一个抽屉 + 页签头**：日志 / 变更 / 评分住在一个 `Sheet` 里，切页签不卸载。
 * 排名不在这里（它是页面级视图，比的是候选之间）。开合与页签都归调用方。
 */
export { RunDetailDrawer, type RunDetailDrawerProps, type RunDetailTab } from './composite/run-detail-drawer';
export {
  AgentLogLayout,
  type AgentLogLayoutProps,
  type TimelineSlotProps,
} from './composite/agent-log/agent-log-layout';
/**
 * 人工消息的**输入区与排队区**：装配侧把它塞进 `AgentLogLayout` 的 `footer` 槽
 * （只有「这一行允许人送话」时才渲染它）。它自带排队区，故调用方不必自己拼两段。
 */
export {
  InjectComposer,
  type InjectComposerProps,
  type InjectSendInput,
  type InjectUploadInput,
} from './composite/agent-log/inject-composer';
/**
 * 追问的**输入区**（第二期）：同一个 `footer` 槽的另一支（跑完之后那一行补一句话）。
 * 与上面那一支共用同一条草稿状态机与同一块输入区（`composer-input.tsx`）⇒ 形态逐像素相同。
 */
export {
  FollowUpComposer,
  FOLLOW_UP_HINT,
  type FollowUpComposerProps,
  type FollowUpSendInput,
  type FollowUpUploadInput,
} from './composite/agent-log/follow-up-composer';
export { VirtualTurnList, type VirtualTurnListProps } from './composite/agent-log/virtual-turn-list';
export {
  AgentMessageTimeline,
  renderTurn,
  type MessageTimelineProps,
  type RenderTurn,
} from './composite/agent-log/agent-message-timeline';
export {
  BlockRendererProvider,
  DEFAULT_BLOCK_RENDERERS,
  blockRendererOf,
  useBlockRenderers,
  type BlockRenderContext,
  type BlockRenderer,
  type BlockRendererProviderProps,
  type BlockRendererRegistry,
} from './composite/agent-log/block-renderer-registry';
export {
  buildRenderBlocks,
  hasToolCall,
  nodeIndex,
  taskPanelOf,
  type OrphanToolResult,
  type RenderBlock,
  type ToolGroupEntry,
  type ToolItem,
  type ToolOutput,
} from './composite/agent-log/render-blocks';
export {
  activeNodeOf,
  buildAgentLogModel,
  diagnosticsOf,
  rowEventsOf,
  userPromptOf,
  type AgentLogFactsInput,
  type BuildAgentLogModelInput,
} from './composite/agent-log/build-model';
/**
 * 段分隔（时间轴上那一行「追问 ×N」）：由数据层定的段号驱动，虚拟列表按段首插入。
 * 单独转出是因为「一行一段」这件事在别的消费场景（比如将来的只读导出）也要用同一件。
 */
export { SegmentDivider, type SegmentDividerProps } from './composite/agent-log/segment-divider';
// 轮末「回到某一轮」：可用性与禁用原因只从能力声明读（UI 不判厂商）
export {
  CheckpointMarker,
  checkpointFileNote,
  checkpointReasonOf,
  type CheckpointMarkerProps,
  type CheckpointTarget,
} from './composite/agent-log/checkpoint-marker';
export {
  useAgentLogView,
  type AgentLogViewState,
} from './composite/agent-log/use-agent-log-view';
export {
  agentLogToolbarPreset,
  useAgentLogToolbarPreset,
  type AgentLogToolbarPresetInput,
  type ToolbarAction,
} from './composite/agent-log/agent-log-toolbar-preset';
export {
  MISSING_REASON_LABELS,
  CAPABILITY_LEVEL_LABELS,
  LOG_NODE_STATUS_LABELS,
  MESSAGE_SOURCE_LABELS,
  TOOL_FAMILY_LABELS,
  /**
   * 契约的**扁平**能力声明（`toolResult` / `toolResultSource` / `toolResultReason` 三格同名前缀）
   * → 界面要的**字典**形状（每维一个 `{ level, source, reason }` 三元组）。
   *
   * 页面从 `/api/runs/model-options` 拿到的是契约形状，而 `AgentLogModel`
   * 要的是字典形状——两者之间的**唯一**搬运点就是它。不导出的话，页面只能自己摊一遍，
   * 而那正是「一份形状两个实现」的老路（摊错一维的症状是那一格显示成「没验证过」）。
   */
  toCapabilityMap,
  truncationNote,
  type AgentEnvironment,
  type AgentLogDiagnostics,
  type AgentLogFacts,
  type AgentLogModel,
  type AgentLogSource,
  type AgentRunStatus,
  type AskUserAnswer,
  type AskUserInteraction,
  type AskUserOption,
  type AskUserOutcome,
  type AskUserPending,
  type AskUserQuestion,
  type AskUserSettled,
  type CapabilityDecl,
  type DomainFact,
  type DomainFactSegment,
  type EnvGroup,
  type EnvItem,
  type Loadable,
  type LogNode,
  type LogNodeIndex,
  type LogNodeStatus,
  type LogTurn,
  type MessageCapabilityMap,
  type RowEvent,
  type RowNode,
  type SessionFacts,
  type SessionNode,
  type TaskPanel,
  type TaskStep,
  type ToolCardResult,
  type ToolFamilyPayload,
  type TruncationState,
} from './composite/agent-log/types';
/**
 * 评分详情抽屉的「原始输出」二级抽屉要的两样：正文（与执行日志的原文面板共用一份）
 * 与入口 / 标题共用的文案。页面（footer 按钮）与视图（抽屉标题）各消费一半，
 * 不从包根转出就只能深路径 import 或各写一份。
 */
export { diagnosticsBody, rawOutputLabel } from './composite/agent-log/raw-output-panel';
export { allFixtures, claudeFixture, codexFixture, dshFixture, type AgentLogFixture } from './composite/agent-log/fixtures';
/**
 * vendored 原语（`components/ui/`）：上游 shadcn registry 的产物，只做说明符改写
 * （内部别名 → 相对路径、`cn` → `lib/utils`），结构不进本仓的类型体系。
 * 样式是纯 Tailwind 类名，由 `apps/web-next` 的 Tailwind 管线产出（`globals.css` 的 `@source`
 * 覆盖整个 `src/`，故组件放在哪一层都会被扫到）。
 *
 * 逐个具名转出，不用 `export *`：通配符把「哪些是公共面」交给上游文件，而 vendored 件会继续增加，
 * `Card` / `Badge` 这类通用名一旦与既有出口撞名就是编译错。`cn` 不从包根转出——它只是这批文件的
 * 内部换实现点（换合并库时只改 `lib/utils.ts` 一处），不是调用方要用的东西。
 */
export { Alert, AlertAction, AlertDescription, AlertTitle } from './components/ui/alert';
export { Badge, badgeVariants } from './components/ui/badge';
export { Button, buttonVariants } from './components/ui/button';
export { Collapsible, CollapsibleContent, CollapsibleTrigger } from './components/ui/collapsible';
export {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from './components/ui/card';
export { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from './components/ui/empty';
export { Input } from './components/ui/input';
/**
 * 覆盖层与选择类原语：设置屏的对话框（`Dialog`）、评分卡的三个下拉（`Select`）、
 * 页签（`Tabs`，**默认惰性挂载**，见 `components/ui/tabs.test.tsx`）。
 * 逐个具名转出（理由同上：`Card` / `Select` 这类通用名一旦与既有出口撞名就是编译错）。
 */
export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
} from './components/ui/dialog';
export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectScrollDownButton,
  SelectScrollUpButton,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from './components/ui/select';
export { Tabs, TabsContent, TabsList, TabsTrigger } from './components/ui/tabs';
export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './components/ui/tooltip';
export { RadioGroup, RadioGroupItem } from './components/ui/radio-group';
export { Separator } from './components/ui/separator';
export { Skeleton } from './components/ui/skeleton';
export { Switch } from './components/ui/switch';
export {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from './components/ui/table';
export { Textarea } from './components/ui/textarea';
export {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSeparator,
  FieldSet,
  FieldTitle,
} from './components/ui/field';
export { FieldWarning, type FieldWarningProps } from './base/field-warning';
/**
 * 评测屏用的原语：抽屉（`Sheet`）与「禁用原因」的提示壳。
 * 表格 / 徽标 / 卡片那一批已在上面统一转出（两个屏共用），这里不重复转出同名成员。
 * 二次确认框（`ConfirmDialog`）由设置屏转出的那一份对外，评测屏的那一份是包内部件。
 */
export {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from './components/ui/sheet';
export { Hint, HintProvider, type HintProps } from './base/hint';
/**
 * 图标：vendored 原语与 `Sheet` 的关闭键都用 lucide，装配侧没有这一条第三方依赖
 * （也不该为几个图标新增一条依赖边），故经包根转出本屏要用的几个。
 */
export {
  ArrowDownIcon,
  ArrowUpIcon,
  ChevronsUpDownIcon,
  FileTextIcon,
  FlaskConicalIcon,
  LoaderCircleIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
} from 'lucide-react';

/**
 * `/dev/ui-probe` 的探针矩阵：四格 × 四件 × 五块色板，只给真机验收基座用（不进导航）。
 * 页面必须经包根取它：装配侧（`apps/web-next`）没有子路径导出可用。
 */
export { UiProbeGrid } from './dev/ui-probe';
