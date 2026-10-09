'use client';

/**
 * 行级事实进度条（L1）：状态 · 用量（含思考 token）· 耗时 · 轮次 · 错误。
 *
 * 五条口径：
 *   1. **`null` 不显示成 0**：用量、思考 token、耗时、错误各自「没采到」时给一句话
 *      （「用量未采集」）或整格不出现，绝不写 0——0 是一个**读数**，「没采到」不是；
 *   2. **耗时只有这一个口径**：已结束用 `endedAt − startedAt` 的结算值，未结束才本地走秒表
 *      （`useNow` 只在真的在跑时挂定时器，抽成 `durationMsOf` 便于单测）；
 *   3. **领域事实不在这里**（用户 2026-10-07 口径）：`facts.domain`（智能体 · 模型 · 思考强度 ·
 *      改动 · 评分）由 `agent-log-domain-facts.tsx` **单独占一行**画。并回本条末尾时，「改动 /
 *      评分」会被自然折行甩到第二行、与前三格拆散；而这两组是连起来读的一句话。本条只画
 *      「这一行跑了什么」那几个读数；
 *   4. **不可折叠、也不放入口**：「原始输出」归 `raw-output-panel`，「？环境信息」归工具条预设，
 *      放进来会让固定区变成第二个工具条；
 *   5. **不展示「结束原因」**（用户 2026-10-07 口径）：`end` 事件里的 `exitReason` 只逐字落在
 *      **下载台账**里——⚠️ **它不在「原始输出」里**（那个面板只收 `log` 事件）。事实条不再重复这一格：
 *      同一格要说的处境，状态徽标已经说了一遍。
 *
 * 「等待答复」是**派生**的（`waitingSince` 由调用方从当前节点的块里扫出来）：
 * 它不进 `facts`、也不进 `rowEvents`，因为它是**当前态**而不是发生过的事件。
 */
import { Badge, Flex, Tag, theme, Typography } from 'antd';
import type { ReactNode } from 'react';
import type { AgentLogFacts, AgentRunStatus } from './types';
import { formatDuration } from '../../base/metric-line';
import { formatTokens, formatUsageTriple } from '../../base/usage-metrics';
import { useNow } from '../../base/use-now';

/** antd 的主题 token（`theme.useToken()` 那一格），分段着色用它取语义色 */
type Token = ReturnType<typeof theme.useToken>['token'];

export interface AgentLogFactsBarProps {
  facts: AgentLogFacts;
  /** 「等待答复」徽标：真的在等时才给非空（**派生**，不新增契约字段） */
  waitingSince: string | null;
  /** 内容被上限截断时如实显示那句话；`null` = 完整 */
  contentTruncatedReason?: string | null;
}

/** 状态色档 → antd `Badge` 的档位。**只有 `running` 挂动效**（`processing` 自带波纹） */
const BADGE_STATUS: Record<AgentRunStatus['tone'], 'processing' | 'default' | 'success' | 'error' | 'warning'> = {
  running: 'processing',
  pending: 'default',
  ok: 'success',
  failed: 'error',
  canceled: 'warning',
};

/**
 * 思考 token 的**可加性说明**。`basis !== 'additive'` 时界面**不提供任何相加口径**：
 * 相加即双计（`subset-of-output`），或连跨家比较都不允许（`unknown`）。
 * 表里只有「可加性未知」这一格（2026-10-07 用户口径：`subset-of-output` 不再附任何说明，
 * 文案从简）；`additive` 本来就能加，也没有说明可写。
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

export function AgentLogFactsBar({ facts, waitingSince, contentTruncatedReason }: AgentLogFactsBarProps): ReactNode {
  const { token } = theme.useToken();
  // 两个会走秒的量共用一次心跳：耗时（未结束）与等待时长（真的在等）
  const now = useNow(isTicking(facts) || waitingSince !== null);
  const durationMs = durationMsOf(facts, now);
  const waitedMs = waitingSince === null ? null : now - Date.parse(waitingSince);
  // 只有需要开口的档位才有说明（`undefined` ⇒ 这一格不画，免得占一份 flex 间距）
  const thinkingHint = facts.thinking === null ? undefined : THINKING_BASIS_HINTS[facts.thinking.basis];

  return (
    <Flex align="center" gap={token.marginSM} wrap data-testid="agent-log-facts-bar">
      {/* 状态文案照数据层给的渲染（`label` 是数据层的词汇，组件不自己翻译状态） */}
      {/* `size="small"` 在这里**不改变外观**，它属于「抽屉里每个带 size 的组件都写死 small」这条全件口径：
          `Badge.js` 把这个值只拼进**计数**徽标的 `ScrollNumber`（`${prefixCls}-count-sm`），
          status 圆点徽标那条分支不带它（实测：抽屉里 status 徽标的类名与圆点宽度加不加都一样，6px）。
          写出来是为了同口径可静态核对，不是「这个徽标偏大」 */}
      <Badge size="small" status={BADGE_STATUS[facts.status.tone]} text={facts.status.label} />

      {/* 用量格：`tokens === null` 说「未采集」而不是三个 0；思考 token 只在这一格里出现。
          文案走 `formatUsageTriple`（千分位 + `tok` 单位）——与里程碑 / 逐条页脚 / 子任务卡片同一出口 */}
      <Flex align="center" gap={token.marginXXS} data-testid="agent-log-facts-tokens">
        {facts.tokens === null ? (
          <Typography.Text type="secondary">用量未采集</Typography.Text>
        ) : (
          <Typography.Text type="secondary">{formatUsageTriple(facts.tokens)}</Typography.Text>
        )}
        {facts.thinking !== null && (
          <Flex align="center" gap={token.marginXXS} data-testid="agent-log-facts-thinking">
            <Typography.Text type="secondary">思考 {formatTokens(facts.thinking.tokens)}</Typography.Text>
            {thinkingHint !== undefined && <Typography.Text type="secondary">{thinkingHint}</Typography.Text>}
          </Flex>
        )}
      </Flex>

      {/* 耗时格：`startedAt === null` 时整格不显示（不是「0s」，那是编出来的读数） */}
      {durationMs !== null && (
        <Typography.Text type="secondary" data-testid="agent-log-facts-duration">
          耗时 {formatDuration(durationMs)}
        </Typography.Text>
      )}

      {/* 轮次格**排在末尾**（用户 2026-10-07 口径：输入 · 缓存 · 输出 · 耗时 · 轮次）：
          前三格是这一次的**量**、耗时是它花了多久，轮次是「跑了几轮」这个过程读数——
          放在用量前面会把「量」那一串读断。`total` 为 `null` 时只说当前值（不编一个会走动的分母） */}
      <Typography.Text type="secondary" data-testid="agent-log-facts-turns">
        轮次 {facts.turns.current}
        {facts.turns.total === null ? '' : ` / ${facts.turns.total}`} 轮
      </Typography.Text>

      {/* 失败归因：`code` 可以为 null（不是每种失败都有错误码），有就一起给，没有就不留空格 */}
      {facts.error !== null && (
        <Tag color="error" data-testid="agent-log-facts-error">
          {facts.error.code === null ? facts.error.message : `${facts.error.code} ${facts.error.message}`}
        </Tag>
      )}

      {/* 「等待答复」只在真的在等时出现（判据由调用方从当前节点的块里扫出来） */}
      {waitingSince !== null && (
        <Badge
          size="small"
          status="processing"
          data-testid="agent-log-facts-waiting"
          text={`等待答复 ${formatDuration(waitedMs ?? 0)}`}
        />
      )}

      {/* 内容被上限截断时如实显示那句话；`null` = 完整，什么都不显示 */}
      {contentTruncatedReason !== undefined && contentTruncatedReason !== null && contentTruncatedReason !== '' && (
        <Typography.Text type="warning" data-testid="agent-log-facts-truncated">
          {contentTruncatedReason}
        </Typography.Text>
      )}
    </Flex>
  );
}
