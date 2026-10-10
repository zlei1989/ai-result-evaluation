/** ui 公共出口：纯展示组件与界面原语。本包不调接口（数据由调用方以 props 注入）。 */
export { DensityProvider, useDensityMode } from './base/density-context';
export { COMPACT_FONT_TOKENS, compactTheme, type DensityMode } from './base/density';
export { SYSTEM_DARK_QUERY, readSystemDark, resolveThemeMode, type ThemePreference } from './base/theme-resolve';
export { useAppliedThemeMode, useResolvedTheme, type ResolvedTheme, type UseResolvedThemeOptions } from './base/app-theme';
export { PageShell, type PageShellProps } from './base/page-shell';
export { readStoredPreference, useStoredWidth } from './base/stored-preference';
export { SplitPane, type SplitPaneProps } from './base/split-pane';
export {
  HANDLE_HIT_WIDTH,
  ResizableColumns,
  restoreWidthsToAvailable,
  type PaneGeometry,
  type ResizablePane,
  type ResizableColumnsProps,
} from './base/resizable-columns';
export {
  // 三个右侧抽屉（变更详情 / 评分详情 / 执行日志）**共用**的宽度口径：宽度与语义槽样式
  // 全站只有这一份字面量，评测页与 `AgentLogDrawer` 都从这里取——漂移是静默的
  // （把其中一个值就地写死 ⇒ 那一处掉回默认 378px，而没有任何用例变红），见该文件头。
  // `MAIN_DRAWER_PUSH` 是「二级抽屉打开时把主抽屉推开多远」，**必须给主抽屉**（给二级是空转）。
  // 二级抽屉那一档宽度（`NESTED_DRAWER_SIZE`）**不转出**：它的两个消费者（`NestedDrawer` 与
  // 「环境信息」抽屉）都在包内。
  DRAWER_SEMANTIC_STYLES,
  MAIN_DRAWER_PUSH,
  WIDE_DRAWER_SIZE,
} from './base/drawer-geometry';
export { EllipsisText, type EllipsisTextProps } from './base/ellipsis-text';
export { EmptyState, type EmptyStateProps } from './base/empty-state';
export { Toolbar, type ToolbarProps } from './base/toolbar';
export {
  TABLE_SCROLL_STYLE,
  TableScrollArea,
  type TableScrollAreaProps,
} from './base/table-scroll-area';
export { formatBytes, formatDateTime, shortHash } from './base/format';
export { MonoText, type MonoTextProps } from './base/mono-text';
export { MarkdownText, type MarkdownTextProps } from './base/markdown-text';
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
  ACTIVITY_SWEEP_CLASS,
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
export { CaseFormPanel, type CaseFormPanelProps } from './composite/case-form-panel';
export { CaseDetailPanel, type CaseDetailPanelProps } from './composite/case-detail-panel';
export { ProviderTable, type ProviderTableProps } from './composite/provider-table';
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
  type RunDetailPanelProps,
} from './composite/run-detail-panel';
export { ScoreDetailView, type ScoreDetailViewProps } from './composite/score-detail-view';
export { DiffFileContent, DiffView, type DiffViewProps } from './composite/diff-view';
export { formatEventLine, formatEventLog } from './composite/log-format';
/**
 * 「执行日志」抽屉（`agent-log`）：**整个目录就是那个通用组件**——吃「一个智能体运行的过程 +
 * 它跑在什么环境里」，不认「评测行」这个业务概念。三层的分界与各自能吃什么是设计的一部分，
 * 故这里把三层各自的门面都转出来（内嵌场景用 `AgentLogLayout`，只读时间轴用 `AgentMessageTimeline`）。
 */
export {
  AgentLogDrawer,
  type AgentLogDrawerProps,
} from './composite/agent-log/agent-log-drawer';
export {
  AgentLogLayout,
  type AgentLogLayoutProps,
  type TimelineSlotProps,
} from './composite/agent-log/agent-log-layout';
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
  type AgentLogFactsInput,
  type BuildAgentLogModelInput,
} from './composite/agent-log/build-model';
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
export { allFixtures, claudeFixture, codexFixture, dshFixture, type AgentLogFixture } from './composite/agent-log/fixtures';
