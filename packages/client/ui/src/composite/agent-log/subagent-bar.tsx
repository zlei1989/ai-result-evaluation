'use client';

/**
 * 子任务占位条：派发点上的一条**导航入口**（「现在有什么在跑」），与「调用了什么」是两件事，
 * 故它从工具组里提出、原地出现（§6.3）。
 *
 * **版面：头部一行 + 字段两行**（2026-10-07 起；此前是三格并排一行）
 *   · 头部：左＝身份（子任务标签 / 名称 / 状态），右＝动作（重试、进入）；
 *   · 字段第一行**结果摘要**：整行独占——它是长文本，独行才多显示几个字；
 *   · 字段第二行：左「用量」、右「派发方式」。
 *
 * 两处「右边」都靠 `marginInlineStart: 'auto'` 顶过去，**不用 `justify="space-between"`**：
 * `justify` 是**逐行**生效的，一旦名称长到把动作组挤到下一行，那一行只有它一个元素，
 * `space-between` 会把它推到**左**端（`base/toolbar.tsx` 的注释记着同一族事故：单子元素 + space-between
 * = 贴左）；第二行的「派发方式」还要在主会话（没有用量那一格）时也留在右边。auto 外边距在
 * 「同行两格」与「各自成行」两种情形下都把它顶到右端，故两处都只用这一种机制。
 *
 * 六条口径：
 *   · **任务名为空时用 id 前缀兜底**（`子任务 <subagentId 前 8 位>`）：claude 的聚合形态就是
 *     `name: null`，显示空白会被读成「界面坏了」；主会话/子任务共用同一份形状，故兜底只认 id；
 *   · **状态与「状态未采集」同时显示**（两句并列）：`status` 永远有一个可渲染的值
 *     （采不到就是 `'unknown'`），而「为什么是 unknown」是另一格，藏起来等于把
 *     「这家结构上不支持」说成「我们没接」；
 *   · 三格（派发方式 / 结果摘要 / 用量）**拿不到时各显示「未采集」而不是空白**；
 *     **`usage === null` 且是主会话时不显示这一格**——主会话的用量本来就不在这个节点上
 *     （它在 `AgentLogModel.facts.tokens`），画一个「未采集」是在报一个不存在的缺口；
 *   · **用量的三个数走千分位 + `tok` 单位**（`formatUsageTriple`，与事实条、逐轮页脚同一口径）：
 *     `500864` 要一位一位数，而同一个数在事实条上已经是 `500,864 tok`——同一个量在三处长得不一样
 *     会让人怀疑自己看错了行；
 *   · 「进入」与「重试」都只在调用方给了回调时可用：**不给回调不给按钮**（重试）或给禁用态（进入），
 *     免得点下去无声无息；
 *   · **各格用 `Flex` 手摆，不用 `Descriptions column={3}`**（2026-10-03 真机实测的版面缺陷）：
 *     `Descriptions` 的三列布局把标签列压到只剩一个汉字宽，实测「派发方式」竖排成「派发方式」四个字
 *     各占一行、值 `spawn` 也逐字符断行——子任务条是抽屉里最窄的一处（抽屉宽度的一半再扣掉时间轴
 *     左槽），固定列宽在这里必然崩。手摆之后每格的宽度**由所在行给**：摘要那一格吃满整行
 *     （靠纵向容器的 stretch，故它**不能**带 `flex` 的横向 basis），第二行两格各按内容宽、窄了换行。
 */
import { Button, Card, Flex, Tag, Typography } from 'antd';
import type { CSSProperties, ReactNode } from 'react';
import { EllipsisText } from '../../base/ellipsis-text';
import { formatUsageTriple } from '../../base/usage-metrics';
import type { LogNodeStatus, SessionNode } from './types';
import { LOG_NODE_STATUS_LABELS, MISSING_REASON_LABELS } from './types';

export interface SubagentBarProps {
  node: SessionNode;
  /** 「进入」；未给时按钮 disabled */
  onEnter?(nodeId: string): void;
  /** 节点状态未采集时的重试（`source.retryNode`）；未给时不渲染重试按钮 */
  onRetry?(nodeId: string): void;
}

/**
 * 状态七档 → `Tag` 色档。
 * **`stopped` / `canceled` / `unsettled` / `unknown` 一律中性**：它们各有一句自己的中文，
 * 涂成红色会把「不知道」说成「失败」，涂成绿色会把「等不到了」说成「完成」。
 */
function statusColor(status: LogNodeStatus): 'processing' | 'success' | 'error' | 'default' {
  switch (status) {
    case 'running':
      return 'processing';
    case 'completed':
      return 'success';
    case 'failed':
      return 'error';
    default:
      return 'default';
  }
}

/** 任务名的兜底：`null` 与空串都算「没给名字」（空白会被读成界面坏了） */
function displayName(node: SessionNode): string {
  if (node.name !== null && node.name !== '') return node.name;
  const id = node.subagentId !== null && node.subagentId !== '' ? node.subagentId : node.id;
  return `子任务 ${id.slice(0, 8)}`;
}

export function SubagentBar({ node, onEnter, onRetry }: SubagentBarProps): ReactNode {
  /**
   * 一格：标签在上、值在下。
   * `style` 由调用方按**所在行**给——摘要那格独占一行、吃满宽度（父级纵向 Flex 的 stretch），
   * 给它一个横向 `flex` basis 反而会把它按列主轴算成高度；第二行两格才需要显式的 `flex`。
   */
  const field = (key: string, label: string, children: ReactNode, style?: CSSProperties): ReactNode => (
    <Flex key={key} vertical style={{ minWidth: 0, ...style }}>
      <Typography.Text type="secondary">{label}</Typography.Text>
      {children}
    </Flex>
  );

  return (
    <Card size="small">
      <Flex vertical gap={8}>
        {/* 头部：左＝身份，右＝动作 */}
        <Flex align="center" gap={8} wrap>
          <Flex align="center" gap={4} wrap style={{ minWidth: 0 }}>
            <Tag>子任务</Tag>
            <Typography.Text strong>{displayName(node)}</Typography.Text>
            <Tag color={statusColor(node.status)}>{LOG_NODE_STATUS_LABELS[node.status]}</Tag>
            {node.statusMissing !== null && (
              <Typography.Text type="secondary">
                {`状态未采集 · ${MISSING_REASON_LABELS[node.statusMissing]}`}
              </Typography.Text>
            )}
          </Flex>
          {/* 动作组：auto 外边距顶到右端；`flex: none` 免得名称过长时把按钮压扁 */}
          <Flex align="center" gap={4} style={{ marginInlineStart: 'auto', flex: '0 0 auto' }}>
            {/* 重试在前、进入在后：导航入口留在最右角，恢复动作不抢它的位置 */}
            {onRetry !== undefined && (
              <Button size="small" type="text" autoInsertSpace={false} onClick={() => onRetry(node.id)}>
                重试
              </Button>
            )}
            <Button size="small" type="link" disabled={onEnter === undefined} onClick={() => onEnter?.(node.id)}>
              进入 ▸
            </Button>
          </Flex>
        </Flex>

        {/* 第一行：结果摘要独占（长文本，独行才多显示几个字） */}
        {field(
          'outcome',
          '结果摘要',
          node.outcome === null ? <Typography.Text type="secondary">未采集</Typography.Text> : <EllipsisText text={node.outcome} />,
        )}

        {/* 第二行：左「用量」、右「派发方式」（后者 auto 外边距钉右，没有用量那格时也在右边） */}
        <Flex gap={12} wrap>
          {/* 主会话没有自己这一格 ⇒ 整格不画；子任务没采到 ⇒ 如实说「用量未采集」。
              有值的那一支走 `formatUsageTriple`（千分位 + `tok`）：事实条、逐轮页脚、轮末里程碑
              与这一格是**同一个数**，四处必须长得一样（各写一份模板就会在加单位时漏掉一处） */}
          {node.usage === null && node.kind === 'main'
            ? null
            : field(
              'usage',
              '用量',
              <Typography.Text type={node.usage === null ? 'secondary' : undefined}>
                {node.usage === null ? '用量未采集' : formatUsageTriple(node.usage)}
              </Typography.Text>,
              { flex: '0 1 auto' },
            )}
          {field('dispatch', '派发方式', <Typography.Text>{node.dispatchKind ?? '未采集'}</Typography.Text>, {
            flex: '0 0 auto',
            marginInlineStart: 'auto',
          })}
        </Flex>
      </Flex>
    </Card>
  );
}
