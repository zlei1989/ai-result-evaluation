'use client';

/**
 * 预置的执行日志抽屉（L2）：**唯一一处主 `<Drawer>`**（环境抽屉那个是内部件，另算一处）。
 *
 * 它是「评测页一行接线」的那个件：`open` / `onClose` / `model` 三格就能用，
 * 其余全是可选——**重组能力不要求调用方付税**。
 *
 * 几何（§5.1，全部按 antd 6 实测修正过）：
 *   · `width` **已废弃** ⇒ 用 `size`（CSS 表达式可以直接给）；
 *   · `maskClosable` **已废弃** ⇒ 用 `mask.closable`；
 *   · `styles.body.padding = 0`：内边距由内容自己给（否则正文贴死抽屉边框）；
 *   · `destroyOnHidden`：关掉即卸载，不留浮层状态（与环境抽屉同口径）。
 *
 * ⚠️ **宽度与语义槽样式取自 `../../base/drawer-geometry`，不在这里再写一份字面量**：
 * 评测页的「变更详情」「评分详情」两个抽屉与它共用同一份口径（三个抽屉必须一样宽，
 * 而各写一份的漂移是静默的——见那个文件的文件头）。
 */
import { Drawer } from 'antd';
import type { ReactNode } from 'react';
import { DRAWER_SEMANTIC_STYLES, MAIN_DRAWER_PUSH, WIDE_DRAWER_SIZE } from '../../base/drawer-geometry';
import { AgentLogLayout, type AgentLogLayoutProps } from './agent-log-layout';

export interface AgentLogDrawerProps extends AgentLogLayoutProps {
  open: boolean;
  onClose(): void;
  /** 抽屉标题；默认「执行日志」 */
  title?: ReactNode;
}

export function AgentLogDrawer({ open, onClose, title, ...layoutProps }: AgentLogDrawerProps): ReactNode {
  return (
    <Drawer
      title={title ?? '执行日志'}
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
      {/* 抽屉正文取满抽屉剩余高度（`body` 的 padding 已置 0），几何与内嵌场景（S1）完全一致 */}
      <AgentLogLayout {...layoutProps} />
    </Drawer>
  );
}
