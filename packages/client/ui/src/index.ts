/** ui 公共出口：纯展示组件与界面原语。本包不调接口（数据由调用方以 props 注入）。 */
export { DensityProvider, useDensityMode } from './base/density-context';
export { COMPACT_FONT_TOKENS, compactTheme, type DensityMode } from './base/density';
export { SYSTEM_DARK_QUERY, readSystemDark, resolveThemeMode, type ThemePreference } from './base/theme-resolve';
export { useResolvedTheme, type ResolvedTheme, type UseResolvedThemeOptions } from './base/app-theme';
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
export { EllipsisText, type EllipsisTextProps } from './base/ellipsis-text';
export { EmptyState, type EmptyStateProps } from './base/empty-state';
export { Toolbar, type ToolbarProps } from './base/toolbar';
export { formatBytes, formatDateTime, shortHash } from './base/format';
export { ListDetailLayout, type ListDetailLayoutProps } from './base/list-detail-layout';
export { AppTopNav, type AppTopNavItem, type AppTopNavProps } from './composite/app-top-nav';
export { DemoListPage, type DemoListPageProps, type DemoRecordView } from './composite/demo-list-page';
