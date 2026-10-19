'use client';

/**
 * 行级事实进度条（L1）：状态 · 用量（含思考 token）· 上下文用量（用了窗口的多少）· 耗时 · 轮次 · 错误。
 *
 * 五条口径：
 *   1. **`null` 不显示成 0**：用量、思考 token、耗时、错误各自「没采到」时给一句话
 *      （「用量未采集」）或整格不出现，绝不写 0——0 是一个**读数**，「没采到」不是。
 *      上下文用量同理：缺分子说「上下文未采集」、缺上限说「上限未采集」，**没有 0% 这一档**；
 *   2. **耗时只有这一个口径**：已结束用 `endedAt − startedAt` 的结算值，未结束才本地走秒表
 *      （`useNow` 只在真的在跑时挂定时器，抽成 `durationMsOf` 便于单测）；
 *   3. **领域事实不在这里**：`facts.domain`（智能体 · 模型 · 思考强度 ·
 *      改动 · 评分）由 `agent-log-domain-facts.tsx` **单独占一行**画。并回本条末尾时，「改动 /
 *      评分」会被自然折行甩到第二行、与前三格拆散；而这两组是连起来读的一句话。本条只画
 *      「这一行跑了什么」那几个读数；
 *   4. **不可折叠、也不放入口**：「原始输出」归 `raw-output-panel`，「？环境信息」归工具条预设，
 *      放进来会让固定区变成第二个工具条；
 *   5. **不展示「结束原因」**：`end` 事件里的 `exitReason` 只逐字落在
 *      **下载台账**里——⚠️ **它不在「原始输出」里**（那个面板只收 `log` 事件）。事实条不再重复这一格：
 *      同一格要说的处境，状态徽标已经说了一遍。
 *
 * 「等待答复」是**派生**的（`waitingSince` 由调用方从当前节点的块里扫出来）：
 * 它不进 `facts`、也不进 `rowEvents`，因为它是**当前态**而不是发生过的事件。
 */
import type { ReactNode } from 'react';
import { Badge } from '../../components/ui/badge';
import { Progress } from '../../components/ui/progress';
import type { AgentLogFacts, AgentRunStatus } from './types';
import { formatDuration } from '../../base/metric-line';
import { formatCount, formatTokens, formatUsageTriple } from '../../base/usage-metrics';
import { useNow } from '../../base/use-now';


export interface AgentLogFactsBarProps {
  facts: AgentLogFacts;
  /** 「等待答复」徽标：真的在等时才给非空（**派生**，不新增契约字段） */
  waitingSince: string | null;
  /** 内容被上限截断时如实显示那句话；`null` = 完整 */
  contentTruncatedReason?: string | null;
}

/**
 * 状态色档 → 圆点色与动效。**只有 `running` 挂动效**（圆点自己一遍波纹）：
 * 动效是「此刻在跑」的旁路信号，静止状态下它什么也不表示。
 */
const STATUS_DOT: Record<AgentRunStatus['tone'], string> = {
  running: 'bg-info animate-pulse',
  pending: 'bg-muted-foreground',
  ok: 'bg-success',
  failed: 'bg-destructive',
  canceled: 'bg-warning',
};

/**
 * 思考 token 的**可加性说明**。`basis !== 'additive'` 时界面**不提供任何相加口径**：
 * 相加即双计（`subset-of-output`），或连跨家比较都不允许（`unknown`）。
 * 表里只有「可加性未知」这一格（`subset-of-output` 不附任何说明，文案从简）；
 * `additive` 本来就能加，也没有说明可写。
 */
const THINKING_BASIS_HINTS: Partial<Record<NonNullable<AgentLogFacts['thinking']>['basis'], string>> = {
  unknown: '（可加性未知）',
};

/**
 * 这一行的耗时（毫秒）。三种情形各有明确结果，**不猜**：
 *   · `startedAt === null`（还没开始）⇒ `null`，那一格整格不显示；
 *   · `endedAt` 非空 ⇒ **结算值** `endedAt − startedAt`（终态不该再涨）；
 *   · 未结束 ⇒ `now − startedAt`，由调用方每秒推进 `now`（本地走秒表）。
 * 时刻解析不出来时给 `null`：显示 `NaN` 或一个假读数都比不显示糟。
 */
export function durationMsOf(facts: AgentLogFacts, now: number): number | null {
  if (facts.startedAt === null) return null;
  const started = Date.parse(facts.startedAt);
  if (Number.isNaN(started)) return null;
  if (facts.endedAt === null) return now - started;
  const ended = Date.parse(facts.endedAt);
  return Number.isNaN(ended) ? null : ended - started;
}

/** 是否该本地走秒表：还没开始、或已经结束，都不该挂定时器 */
function isTicking(facts: AgentLogFacts): boolean {
  return facts.startedAt !== null && facts.endedAt === null;
}

/**
 * 上下文用量的**三种状态**（缺数据时各不相同，绝不合成 0%）：
 *   · `no-usage` —— 这一行没采到**占用**（最后一条主会话读数）：连分子都没有；
 *   · `no-limit` —— 占用有了，但模型没声明窗口：**没有分母，就没有百分比**；
 *   · `ready` —— 两者都在。
 *
 * 分子只读 `facts.contextUsed`（最后一条主会话 usage 的 `input + cached`）——
 * **不读 `facts.tokens`**：那是整行累计账单，拿它算百分比，长跑行会涨过 100%。
 */
export type ContextMeter =
  | { state: 'no-usage' }
  | { state: 'no-limit'; used: number }
  | { state: 'ready'; used: number; limit: number; percent: number };

/**
 * 事实条那一格要的三样：占用 / 上限 / 百分比。**只读本行的真实读数**，不兜底任何默认窗口。
 * 脏值（负数 / 非有限）按「未采集」处理；真实的 0 照常算（那是「这一刻 prompt 是空的」）。
 */
export function contextMeterOf(facts: AgentLogFacts): ContextMeter {
  const used = facts.contextUsed;
  if (used === null || !Number.isFinite(used) || used < 0) return { state: 'no-usage' };
  const limit = facts.contextWindow;
  if (limit === null || !Number.isFinite(limit) || limit <= 0) return { state: 'no-limit', used };
  return { state: 'ready', used, limit, percent: Math.round((used / limit) * 100) };
}

export function AgentLogFactsBar({ facts, waitingSince, contentTruncatedReason }: AgentLogFactsBarProps): ReactNode {
  // 两个会走秒的量共用一次心跳：耗时（未结束）与等待时长（真的在等）
  const now = useNow(isTicking(facts) || waitingSince !== null);
  const durationMs = durationMsOf(facts, now);
  const waitedMs = waitingSince === null ? null : now - Date.parse(waitingSince);
  // 只有需要开口的档位才有说明（`undefined` ⇒ 这一格不画，免得占一份 flex 间距）
  const thinkingHint = facts.thinking === null ? undefined : THINKING_BASIS_HINTS[facts.thinking.basis];
  // 上下文用量：分子来自本行 tokens、分母来自模型声明的窗口；任一缺格就**不给比值**
  const context = contextMeterOf(facts);

  return (
    <div className="flex flex-wrap items-center gap-snug" data-testid="agent-log-facts-bar">
      {/* 状态文案照数据层给的渲染（`label` 是数据层的词汇，组件不自己翻译状态）：
          圆点是「一眼看出在跑 / 挂了」的那一格，文案承担语义；`data-status` 是给用例的稳定判据 */}
      <span className="inline-flex items-center gap-1.5 text-sm" data-status={facts.status.tone}>
        <span aria-hidden className={`size-1.5 shrink-0 rounded-full ${STATUS_DOT[facts.status.tone]}`} />
        {facts.status.label}
      </span>

      {/* 用量格：`tokens === null` 说「未采集」而不是三个 0；思考 token 只在这一格里出现。
          文案走 `formatUsageTriple`（千分位 + `tok` 单位）——与里程碑 / 逐条页脚 / 子任务卡片同一出口 */}
      <div className="flex items-center gap-hair" data-testid="agent-log-facts-tokens">
        {facts.tokens === null ? (
          <span className="text-muted-foreground">用量未采集</span>
        ) : (
          <span className="text-muted-foreground">{formatUsageTriple(facts.tokens)}</span>
        )}
        {facts.thinking !== null && (
          <div className="flex items-center gap-hair" data-testid="agent-log-facts-thinking">
            <span className="text-muted-foreground">思考 {formatTokens(facts.thinking.tokens)}</span>
            {thinkingHint !== undefined && <span className="text-muted-foreground">{thinkingHint}</span>}
          </div>
        )}
      </div>

      {/* 上下文占用格（`Context`）：紧挨用量三元组——一个是「一共花了多少」，一个是「此刻占了多少」。
          **不是** `context-window-tag` 的容量展示：那一格说「这个模型窗口多大」，这里说「这一行此刻用了多少」。
          分子只读 `contextUsed`（最后一条主会话读数），**不读** `facts.tokens`（整行累计账单）：
          两者混用会让长跑行的百分比涨过 100%。三档缺数据各有各的说法，绝不落到 `0%`。
          进度条只画到 100%（再长也没有第二圈），百分比与两个数照实写（超窗也是真读数）。 */}
      <div className="flex items-center gap-hair" data-testid="agent-log-facts-context">
        {context.state === 'no-usage' ? (
          <span className="text-muted-foreground">上下文未采集</span>
        ) : context.state === 'no-limit' ? (
          <span className="text-muted-foreground">上下文上限未采集（用量 {formatTokens(context.used)}）</span>
        ) : (
          <>
            <span className="text-muted-foreground">上下文 {context.percent}%</span>
            <Progress value={Math.min(100, context.percent)} aria-label="上下文用量" className="w-16 shrink-0" />
            <span className="text-muted-foreground">
              {formatCount(context.used)} / {formatCount(context.limit)} tok
            </span>
          </>
        )}
      </div>

      {/* 耗时格：`startedAt === null` 时整格不显示（不是「0s」，那是编出来的读数） */}
      {durationMs !== null && (
        <span className="text-muted-foreground" data-testid="agent-log-facts-duration">
          耗时 {formatDuration(durationMs)}
        </span>
      )}

      {/* 轮次格**排在末尾**（用户 2026-10-07 口径：输入 · 缓存 · 输出 · 耗时 · 轮次）：
          前三格是这一次的**量**、耗时是它花了多久，轮次是「跑了几轮」这个过程读数——
          放在用量前面会把「量」那一串读断。`total` 为 `null` 时只说当前值（不编一个会走动的分母） */}
      <span className="text-muted-foreground" data-testid="agent-log-facts-turns">
        轮次 {facts.turns.current}
        {facts.turns.total === null ? '' : ` / ${facts.turns.total}`} 轮
      </span>

      {/* 失败归因：`code` 可以为 null（不是每种失败都有错误码），有就一起给，没有就不留空格 */}
      {facts.error !== null && (
        <Badge variant="outline" className="border-destructive/40 text-destructive" data-testid="agent-log-facts-error">
          {/* 中文原因在前、归因码在后：码是给 grep 用的，回答不了「发生了什么」 */}
          {facts.error.code === null ? facts.error.message : `${facts.error.message}（${facts.error.code}）`}
        </Badge>
      )}

      {/* 「等待答复」只在真的在等时出现（判据由调用方从当前节点的块里扫出来） */}
      {waitingSince !== null && (
        <span className="inline-flex items-center gap-1.5 text-sm" data-status="running" data-testid="agent-log-facts-waiting">
          <span aria-hidden className={`size-1.5 shrink-0 rounded-full ${STATUS_DOT.running}`} />
          {`等待答复 ${formatDuration(waitedMs ?? 0)}`}
        </span>
      )}

      {/* 内容被上限截断时如实显示那句话；`null` = 完整，什么都不显示 */}
      {contentTruncatedReason !== undefined && contentTruncatedReason !== null && contentTruncatedReason !== '' && (
        <span className="text-warning" data-testid="agent-log-facts-truncated">
          {contentTruncatedReason}
        </span>
      )}
    </div>
  );
}
