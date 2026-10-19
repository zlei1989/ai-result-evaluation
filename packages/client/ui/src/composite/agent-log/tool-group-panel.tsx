'use client';

/**
 * 工具组：连续的几次工具调用合成一个 `Trace`（外层一行摘要 + 组内每条一行嵌套 `TraceCollapsible`）。
 *
 * 五条口径：
 *   · **`N` 只数 `entry.kind === 'call'` 的行**：孤立结果不是「调用」——
 *     把一条调用画成卡片却仍算进 N，读数就是不实的；
 *   · 组头四格各就各位：`工具调用 × N` 是标题，调用名汇总（去重、最多 3 个 + `等 N 个`）紧跟其后，
 *     「失败 N」与状态汇总（进行中转圈 / 结果未采集的灰字，分派仍收在 `AgentRunStateTag`）；
 *   · **「失败 N」是失败在收起态的唯一落点**：失败的工具组与组内的失败行
 *     **都默认折叠**，于是组头不表态的话，收起时就完全看不出这一组里出过错。N 数的是
 *     **结果为 `error` 的条目**（调用与孤立结果都算）——它与「工具调用 × N」是两个口径，
 *     各答各的问题；一条失败都没有时整格不渲染（不画一个恒为 0 的读数）；
 *   · **折叠态一律受控**：组头的开合走 `open`，组内各行走 `openEntries` + `onEntryOpenChange`
 *     （键由 `toolEntryKey` 给，与 React 的 `key` 同源；失败帧列表再加一层 `|frames` 后缀）；
 *     本件不持任何开合态；
 *   · 组头的 `TraceLine.status` **从各条目的 `block.assembly` 推**（任一条还在收 ⇒ `running`；
 *     都收口且有失败 ⇒ `error`；否则不传）。它回答「组里还在动吗」，与「转圈」的
 *     `running`（轮次未结束且结果未到）是两个问题，故不共用一格。
 *   · 本件**不调用** `onRequestDiagnostics`：本层没有「原始输出」入口（那是固定区的 `RawOutputPanel`），
 *     在展开工具组时顺带取原文是错的时机。它留在签名里是因为注册表统一注入这一格，
 *     去掉它就得让注册表按块类型分支。
 */
import type { ReactNode } from 'react';
import { CircleIcon, CircleXIcon } from 'lucide-react';
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from '../../components/ui/trace';
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

/**
 * 失败帧列表在**同一份折叠态**里的键后缀（与 `agent-message-timeline.tsx` 的 `|raw` 同一手法）：
 * 帧是工具行正文里的第二层开合，各行的帧必须各开各的。
 */
const FRAMES_SUFFIX = '|frames';

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
  /** 组头动效的唯一判据：任一条**源块**还在收（`assembly === 'open'`） */
  const status = entries.some((entry) => entry.assembly === 'open') ? 'running' : failed > 0 ? 'error' : undefined;

  return (
    <Trace data-testid="tool-group">
      <TraceCollapsible open={open} onOpenChange={onOpenChange}>
        <div className="flex w-full min-w-0 items-center gap-2">
          <TraceCollapsibleTrigger>
            <TraceLine status={status} data-testid="tool-group-line">
              <TraceIcon>{status === 'error' ? <CircleXIcon /> : <CircleIcon />}</TraceIcon>
              <TraceTitle>{`工具调用 × ${calls.length}`}</TraceTitle>
              {names !== null && <TraceDescription>{names}</TraceDescription>}
              {/* 失败在收起态的可见性全靠这一格（组与失败行都默认折叠，见文件头）：
                  `AgentRunStateTag` 在结果到手时不表态，指望它露出失败是等不到的 */}
              {failed > 0 && <span className="shrink-0 text-sub text-destructive">{`失败 ${failed}`}</span>}
            </TraceLine>
          </TraceCollapsibleTrigger>
          <AgentRunStateTag
            running={pending.some((call) => call.running)}
            hasResult={pending.length === 0}
            // 原因由注册表从能力声明的 `toolResult` 那一维推出来（拿不到就是 `null` ⇒ 只写「结果未采集」）
            missingReason={missingReason}
            since={pending[0]?.at ?? null}
          />
        </div>
        <TraceCollapsibleContent>
          <div className="flex flex-col">
            {entries.map((entry) => {
              const key = toolEntryKey(entry);
              const framesKey = `${key}${FRAMES_SUFFIX}`;
              return (
                <ToolItemDetail
                  key={key}
                  entry={entry}
                  open={openEntries.has(key)}
                  onOpenChange={(next) => onEntryOpenChange(key, next)}
                  framesOpen={openEntries.has(framesKey)}
                  onFramesOpenChange={(next) => onEntryOpenChange(framesKey, next)}
                  testOpenKeys={openEntries}
                  onTestOpenChange={onEntryOpenChange}
                  missingReason={missingReason}
                />
              );
            })}
          </div>
        </TraceCollapsibleContent>
      </TraceCollapsible>
    </Trace>
  );
}
