'use client';

/**
 * 上下文窗口的展示：一个纯函数 + 一个 Tag（今天只有**创建评测的模型下拉**在用它——设置页的模型清单
 * 是「输入 / 输出」两列 `InputNumber`，不渲染窗口 Tag）。
 *
 * 为什么不做四舍五入到整数档：`1048576`（1.05M）与 `1000000`（1M）在 cc 的 `[1m]` 后缀阈值
 * 上**恰好分处两侧**，都显示成「1M」会把那个差别抹掉 —— 而这正是用户排障时
 * 第一个要看的东西（「我明明选了 1M 的模型，为什么没加后缀」）。
 * 未知一律显示「未知」，不显示 0、也不留空：0 与「没采到」含义相反（同一口径）。
 */
import type { ReactNode } from 'react';
import { Tag } from 'antd';

/** 窗口的紧凑文案：≥1M 保留两位再去尾零（`1M` / `1.05M`），其余按 K 取整（`400K` / `131K`） */
export function formatContextWindow(contextWindow?: number): string {
  if (contextWindow === undefined) return '未知';
  if (contextWindow >= 1_000_000) return `${(contextWindow / 1_000_000).toFixed(2).replace(/\.?0+$/, '')}M`;
  return `${Math.round(contextWindow / 1000)}K`;
}

export function ContextWindowTag({ contextWindow }: { contextWindow?: number }): ReactNode {
  // 颜色只在窗口已知时给：未知不是一种「状态」，给它上色会让人以为那是采到的值
  return <Tag color={contextWindow === undefined ? undefined : 'geekblue'}>{formatContextWindow(contextWindow)}</Tag>;
}
