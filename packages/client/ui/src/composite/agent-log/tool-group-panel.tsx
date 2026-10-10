'use client';

/**
 * 工具组：连续的几次工具调用合成一个折叠面板（外层带边框），组内每条一行嵌套 `Collapse ghost`。
 *
 * 五条口径：
 *   · **`N` 只数 `entry.kind === 'call'` 的行**：孤立结果不是「调用」——
 *     把一条调用画成卡片却仍算进 N，读数就是不实的；
 *   · 组头四格各就各位：`工具调用 × N` + 调用名汇总（去重、最多 3 个 + `等 N 个`）在 `label`，
 *     「失败 N」+ 状态汇总在 `extra`（进行中转圈 / 结果未采集的灰字，分派仍收在 `AgentRunStateTag`）； * · **「失败 N」是失败在收起态的唯一落点**：失败的工具组与组内的失败行
 *     **都默认折叠**，于是组头不表态的话，收起时就完全看不出这一组里出过错。N 数的是
 *     **结果为 `error` 的条目**（调用与孤立结果都算）——它与「工具调用 × N」是两个口径，
 *     各答各的问题；一条失败都没有时整格不渲染（不画一个恒为 0 的读数）；
 *   · **折叠态一律受控**：组头的开合走 `open`，组内各行走 `openEntries` + `onEntryOpenChange`
 *     （键由 `toolEntryKey` 给，与 React 的 `key` 同源）；本件不持任何开合态；
 *   · 本件**不调用** `onRequestDiagnostics`：本层没有「原始输出」入口（那是固定区的 `RawOutputPanel`），
 *     在展开工具组时顺带取原文是错的时机。它留在签名里是因为注册表统一注入这一格，
 *     去掉它就得让注册表按块类型分支。
 */
import { Collapse, Flex, Tag, Typography } from 'antd';
import type { ReactNode } from 'react';
import { AgentRunStateTag } from './agent-run-state-tag';
import type { ToolGroupEntry, ToolItem } from './render-blocks';
import { ToolItemDetail, toolEntryKey } from './tool-item-detail';

export interface ToolGroupPanelProps {
  entries: ToolGroupEntry[];
  open: boolean;
  onOpenChange(next: boolean): void;
  /** 组内各行的展开键（`toolEntryKey` = `callId ?? 源块 id`）；受控 */
  openEntries: ReadonlySet<string>;
  onEntryOpenChange(key: string, open: boolean): void;
  /** 「原始输出」面板展开时上报数据层（可选） */
  onRequestDiagnostics?(): void;
  /**
   * 「结果未采集」的原因（能力声明的 `toolResult` 那一维，由注册表从 `BlockRenderContext` 推出）。
   * `null` = 声明里没谈到这一维 ⇒ 只写「结果未采集」，**不编一句话**。
   *
   * 为什么由外面给而不是本件自己查：L0 拿不到能力声明（它不在 props 里），
   * 而**在 L0 里塞一份 `useContext` 就等于把上下文依赖藏进纯渲染件**——那正是分层纪律要防的。
   */
  missingReason?: string | null;
}

const PANEL_KEY = 'tool-group';

/**
 * 调用名汇总：去重后最多给 3 个，多了缀「等 N 个」（N 是**去重后**的名字数）。
 * 一条名字都没采到时如实说「调用名未采集」——组头只剩一个数字会让人以为界面漏了什么。
 */
function nameSummary(calls: readonly ToolItem[]): string | null {
  if (calls.length === 0) return null;
  const names = [...new Set(calls.map((call) => call.name).filter((name) => name !== ''))];
  if (names.length === 0) return '调用名未采集';
  const head = names.slice(0, 3).join('、');
  return names.length > 3 ? `${head} 等 ${names.length} 个` : head;
}

export function ToolGroupPanel({
  entries,
  open,
  onOpenChange,
  openEntries,
  onEntryOpenChange,
  missingReason = null,
}: ToolGroupPanelProps): ReactNode {
  const calls = entries.filter((entry): entry is ToolItem => entry.kind === 'call');
  /** 结果还没到的调用：组的状态由它们定（全部到齐 ⇒ 这一格不表态） */
  const pending = calls.filter((call) => call.output === null);
  /**
   * 失败条目数。**数结果状态、不数调用次数**，且**孤立结果也算**：
   * 一个配不上调用的失败结果同样是一次失败，漏掉它就会出现「组头说没失败、组里却有一条红的」。
   */
  const failed = entries.filter((entry) => entry.output?.status === 'error').length;
  const names = nameSummary(calls);

  const label = (
    <Flex align="center" gap={4} wrap>
      <Typography.Text>{`工具调用 × ${calls.length}`}</Typography.Text>
      {names !== null && <Typography.Text type="secondary">{names}</Typography.Text>}
    </Flex>
  );

  return (
    <Collapse
      destroyOnHidden
      activeKey={open ? [PANEL_KEY] : []}
      onChange={(keys) => onOpenChange(keys.length > 0)}
      items={[
        {
          key: PANEL_KEY,
          label,
          extra: (
            <Flex align="center" gap={4}>
              {/* 失败在收起态的可见性全靠这一格（组与失败行都默认折叠，见文件头）：
                  `AgentRunStateTag` 在结果到手时不表态，指望它露出失败是等不到的 */}
              {failed > 0 && <Tag color="error">{`失败 ${failed}`}</Tag>}
              <AgentRunStateTag
                running={pending.some((call) => call.running)}
                hasResult={pending.length === 0}
                // 原因由注册表从能力声明的 `toolResult` 那一维推出来（拿不到就是 `null` ⇒ 只写「结果未采集」）
                missingReason={missingReason}
                since={pending[0]?.at ?? null}
              />
            </Flex>
          ),
          children: (
            <Flex vertical>
              {entries.map((entry) => {
                const key = toolEntryKey(entry);
                return (
                  <ToolItemDetail
                    key={key}
                    entry={entry}
                    open={openEntries.has(key)}
                    onOpenChange={(next) => onEntryOpenChange(key, next)}
                    missingReason={missingReason}
                  />
                );
              })}
            </Flex>
          ),
        },
      ]}
    />
  );
}
