'use client';

/**
 * 时间轴上的**段标题**：「追问 ×N」+ 时刻 + **那次追问的正文**。
 *
 * 为什么它是一个块而不是一行小字：一次追问是**又开一次 `run()`**，那一段自己的厂商轮次从 1
 * 重新数 ⇒ 时间轴上会出现第二个「轮次 1」。没有这一行时，读者会把它当成首段的第 1 轮又画了一遍；
 * 而只有「追问 ×N」而没有正文时，读者又要往下找「他到底追问了什么」——那段正文就是这一段的标题，
 * 它只在这里出现一次（轮次里那份已被数据层提出来了，见 `build-model.ts` 的 `isSegmentHead`）。
 *
 * 四条口径：
 *   · **首段不画**（`segment === 0`）：题面那张卡片就是它的开头（调用方负责这一判据）；
 *   · 号与行快照的 `followUpRounds` 同源（都是「第几次追问」）⇒ 与候选卡片上的人工消息计数能对上；
 *   · 时刻取这一段的开始时刻（数据层给：这一段最早的那一条消息），拿不到（空串）就不画那一格；
 *   · 正文缺失（`text === null`）时**只少那一块**，段号照旧——旧运行的账本里没有那条记录，
 *     而「第几次追问」这个事实仍在。
 *
 * 数据层负责「哪一段从哪一轮开始、那句人话是什么」，本件只管画——它不认识消息、也不读账本。
 */
import { Flex, Tag, Typography, theme } from 'antd';
import type { ReactNode } from 'react';
import { XMarkdownText } from '../../base/x-markdown';

export interface SegmentDividerProps {
  /** 段号（≥1）。`0` 不画——调用方负责（首段没有分隔线） */
  segment: number;
  /** 这一段的开始时刻；空串 = 拿不到 */
  at: string;
  /** 那次追问的正文；`null` = 账本里没有这一条（旧运行） */
  text: string | null;
}

export function SegmentDivider({ segment, at, text }: SegmentDividerProps): ReactNode {
  const { token } = theme.useToken();
  return (
    <Flex vertical data-testid="agent-log-segment-divider" data-segment={segment}>
      {/*
        标题行 = 「追问 ×N」+ 时刻，**不画横线**：段与段之间靠这一行自己的形状（青色 Tag）分开就够，
        加一条线只会让这一块看起来像「被分隔线切过」的一段正文。
        这一行也是自己拼、不用 `Divider` 的标题槽：`Divider` 带文字时**它自己就是 flex 容器**
        （`align-items: center`），塞进纵向 flex 里当一项时高度会被拉伸、`inner-text` 会被压成一条竖缝
        ——真机上表现为「段标题占满一整屏、正文被挤到右边缘外面」。
      */}
      <Flex align="center" gap={token.marginXS}>
        <Tag color="cyan">追问 ×{segment}</Tag>
        {at === '' ? null : <Typography.Text type="secondary">{formatClock(at)}</Typography.Text>}
      </Flex>
      {/* 正文与标题**同一个块**：它是这一段的标题（那句人话），不是下一条消息。
          正文走 markdown（与正文块同一条口径：人写的那句话里可能有列表、代码、强调），
          左侧与标题的形状对齐（标题那一整行都缩进在正文之外，正文不需要再缩进） */}
      {text === null ? null : (
        <Flex style={{ paddingTop: token.paddingXS }}>
          <XMarkdownText text={text} open={false} />
        </Flex>
      )}
    </Flex>
  );
}

/**
 * ISO 时间 → 本地 `HH:mm:ss`；非法输入原样返回。
 * 与时间轴左槽的 `formatClock` 同一口径（那一份是模块内私有的，故这里重写一份最小的——
 * 两者显示的是同一件事，要求只是「同一时刻显示成同一个样子」）。
 */
function formatClock(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
