'use client';

/**
 * 预置的执行日志抽屉（L2）：**唯一一处主 `<Drawer>`**（环境抽屉那个是内部件，另算一处）。
 *
 * 它是「评测页一行接线」的那个件：`open` / `onClose` / `model` 三格就能用，
 * 其余全是可选——**重组能力不要求调用方付税**。
 *
 * 标题栏 = 「执行日志」+ 竖分隔线 + 节点面包屑：面包屑是这一支日志的导航
 * （主会话 / 子任务），与标题同一行才看得出「现在这条日志是哪一层」。
 * 标题栏在 `Drawer` 里、`AgentLogLayout` 画不到那里，故**视图态由本件持有**
 * （外置时以调用方那份为准）——标题栏与正文读的必须是同一份，否则点面包屑换不了节点。
 *
 * 几何（全部按 antd 6 实测修正过）：
 *   · `width` **已废弃**⇒ 用 `size`（CSS 表达式可以直接给）；
 *   · `maskClosable` **已废弃**⇒ 用 `mask.closable`；
 *   · `styles.body.padding = 0`：内边距由内容自己给（否则正文贴死抽屉边框）；
 *   · `destroyOnHidden`：关掉即卸载，不留浮层状态（与环境抽屉同口径）。
 *
 * ⚠️ **宽度与语义槽样式取自 `../../base/drawer-geometry`，不在这里再写一份字面量**：
 * 评测页的「变更详情」「评分详情」两个抽屉与它共用同一份口径（三个抽屉必须一样宽，
 * 而各写一份的漂移是静默的——见那个文件的文件头）。
 */
import { Badge, Divider, Drawer, Flex, Tooltip, theme } from 'antd';
import type { ReactNode } from 'react';
import { DRAWER_SEMANTIC_STYLES, MAIN_DRAWER_PUSH, WIDE_DRAWER_SIZE } from '../../base/drawer-geometry';
import { AgentLogLayout, type AgentLogLayoutProps } from './agent-log-layout';
import { LogNodeBreadcrumb, nodeChain } from './log-node-breadcrumb';
import { useAgentLogView } from './use-agent-log-view';

export interface AgentLogDrawerProps extends AgentLogLayoutProps {
  open: boolean;
  onClose(): void;
  /** 抽屉标题；默认「执行日志」 */
  title?: ReactNode;
  /**
   * 实时通道是否连着；不给就不画那一格（不假装在实时，也不把「没有这个信息」说成「离线未连接」）。
   *
   * 只有状态点，文字在 Tooltip 里；点落在**面包屑之前**——那里答的是「这条日志此刻还在不在长」，
   * 与「现在看的是哪一层」是两件事，但都属于标题栏的导航面。
   */
  connected?: boolean;
}

/** 连接状态的文案：连上 / 断开各一句，Tooltip 与 `aria-label` 共用同一份 */
function connectionText(connected: boolean): string {
  return connected ? '实时连接中' : '离线未连接';
}

export function AgentLogDrawer({ open, onClose, title, connected, ...layoutProps }: AgentLogDrawerProps): ReactNode {
  const { token } = theme.useToken();
  // 标题栏里的面包屑要读「当前在哪个节点」，故视图态提到本件：不传就由本件持有一份
  // （hook 无条件调用，外置时内部那份没有任何消费者）
  const internalViewState = useAgentLogView({ model: layoutProps.model });
  const viewState = layoutProps.viewState ?? internalViewState;
  // 空模型 / 当前节点是候选级汇总（`kind === 'row'`，不进面包屑）时链是空的：
  // 那时连分隔线也不画，不留一根后面什么都没有的竖线
  const hasNodeBreadcrumb = nodeChain(layoutProps.model.nodes, viewState.activeNodeId).length > 0;

  return (
    <Drawer
      title={
        <Flex align="center" gap={token.marginSM}>
          <span>{title ?? '执行日志'}</span>
          {/* antd 6 的竖线走 `orientation`（`type` 已废弃），候选内间距由外面的 gap 给 */}
          {hasNodeBreadcrumb && <Divider orientation="vertical" style={{ margin: 0 }} />}
          {/*
            连接状态：**只有点**，文字在 Tooltip 里（`aria-label` 同文，读屏不靠悬停）。
            `tabIndex` 让键盘也能触发 Tooltip；点落在面包屑之前——它与面包屑同属标题栏的导航面。
            `size="small"` 对 status 徽标不改变外观（`Badge.js` 只把它拼进计数徽标的 `ScrollNumber`），
            写出来是为了「抽屉里每个带 size 的组件都写死 small」这条口径能静态核对
            （见 `agent-log-facts-bar.tsx` 的同名注释与 `agent-log-size-sweep.test.ts`）。
          */}
          {connected !== undefined && (
            <Tooltip title={connectionText(connected)}>
              <span
                role="img"
                aria-label={connectionText(connected)}
                tabIndex={0}
                data-testid="agent-log-connection"
                style={{ display: 'inline-flex', alignItems: 'center' }}
              >
                <Badge size="small" status={connected ? 'processing' : 'default'} />
              </span>
            </Tooltip>
          )}
          {hasNodeBreadcrumb && (
            <LogNodeBreadcrumb
              nodes={layoutProps.model.nodes}
              activeNodeId={viewState.activeNodeId}
              onSelect={viewState.setActiveNodeId}
            />
          )}
        </Flex>
      }
      placement="right"
      size={WIDE_DRAWER_SIZE}
      // 里面的二级抽屉（原始输出 / 环境信息 / 卡片原文）打开时，**本抽屉**被推开多远：
      // 这一格必须给被推开的那个（见 `MAIN_DRAWER_PUSH` 的注释），给二级抽屉是空转
      push={MAIN_DRAWER_PUSH}
      open={open}
      onClose={onClose}
      // 关掉即卸载（`destroyOnHidden` 已保证），故 `open === false` 时正文一个节点都不在 DOM 里
      destroyOnHidden
      mask={{ enabled: true, closable: true }}
      styles={DRAWER_SEMANTIC_STYLES}
      data-testid="agent-log-drawer"
    >
      {/* 抽屉正文取满抽屉剩余高度（`body` 的 padding 已置 0），几何与内嵌场景（S1）完全一致。
          面包屑已在标题栏 ⇒ 让布局别在工具条行再画一份 */}
      <AgentLogLayout {...layoutProps} viewState={viewState} nodeBreadcrumbPlacement="header" />
    </Drawer>
  );
}
