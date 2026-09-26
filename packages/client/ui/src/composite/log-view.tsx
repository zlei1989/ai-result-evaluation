'use client';

/**
 * 执行日志：流式追加的事件 + 自动滚底开关 + 下载 + 连接状态。
 * 四条口径：
 *   1. 自动滚底是**可关的**：用户往上翻看历史时，新事件不该把视图拽回底部；
 *   2. `connected` 如实反映连接状态（未连接时写「未连接」，不假装在实时）；
 *   3. 没有事件时给空态：任务还没开始跑时，空文本框会被误读成「日志是空的」；
 *   4. 正文**整段**来自 `formatEventLog(events)`（经 `useMemo` 缓存），组件自己不持有
 *      累计文本——同一行重跑时数据层按「seq 回到 1 = 新一代」把事件整段换掉
 *      （`useRowStream` 口径 5），视图跟着换即可；若在这里 append，
 *      同一个抽屉里会留下两条 `seq=1`、两条 `seq=2` 且无法区分谁是谁。
 *      **不做分段**是有意的取舍：分段需要轮次 id，而 `EvalRow` 里没有；
 *      数据层已经在唯一正确的位置（收到 seq=1 的那一刻）完成替换，视图再猜一次等于第二份判据。
 *
 * 「未开始（`events.jsonl` 不存在）」与「读失败」是两种空态，由调用方区分：
 * 读失败走 `useRowLog` 的 `error`（api 的中文原因带文件路径），在页面层展示；
 * 本组件只负责「这一个抽屉里的内容」，不吞错误也不假装有日志。
 */
import { Badge, Button, Flex, Switch, Typography } from 'antd';
import { useMemo, useState, type ReactNode } from 'react';
import type { AgentEvent } from '@aieval/contracts';
import { EmptyState } from '../base/empty-state';
import { MonoText } from '../base/mono-text';
import { formatEventLog } from './log-format';

export interface LogViewProps {
  events: AgentEvent[];
  connected: boolean;
  onDownload: () => void;
}

export function LogView({ events, connected, onDownload }: LogViewProps): ReactNode {
  const [autoScroll, setAutoScroll] = useState(true);
  // 事件数组每次刷新都是新引用，join 的成本远小于「每渲染一次拼一遍」
  const text = useMemo(() => formatEventLog(events), [events]);

  return (
    // 抽屉内容区 padding 已置 0（spec §7.2.1 ②），内边距由内容自己给——否则日志正文会贴死抽屉边框
    <Flex vertical gap={8} style={{ padding: 16 }}>
      <Flex align="center" justify="space-between" gap={8} wrap>
        <Badge status={connected ? 'processing' : 'default'} text={connected ? '实时连接中' : '未连接'} />
        <Flex align="center" gap={8}>
          <Switch size="small" checked={autoScroll} onChange={setAutoScroll} aria-label="自动滚底" />
          <Typography.Text type="secondary">自动滚底</Typography.Text>
          <Button size="small" autoInsertSpace={false} onClick={onDownload}>
            下载
          </Button>
        </Flex>
      </Flex>

      {events.length === 0 ? (
        <EmptyState title="还没有日志" description="这一行还没开始执行，或执行尚未产生输出" />
      ) : (
        <MonoText text={text} maxHeight={520} autoScroll={autoScroll} dataTestId="log-view-text" />
      )}
    </Flex>
  );
}
