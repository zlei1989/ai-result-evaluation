'use client';

/**
 * 行级事实进度条（L1）：状态 · 轮次 · 用量（含思考 token）· 耗时 · 领域事实 · 错误 · 结束原因。
 *
 * 四条口径：
 *   1. **`null` 不显示成 0**：用量、思考 token、耗时、错误、结束原因各自「没采到」时给一句话
 *      （「用量未采集」）或整格不出现，绝不写 0——0 是一个**读数**，「没采到」不是；
 *   2. **耗时只有这一个口径**：已结束用 `endedAt − startedAt` 的结算值，未结束才本地走秒表
 *      （`useNow` 只在真的在跑时挂定时器，抽成 `durationMsOf` 便于单测）；
 *   3. **不解析领域事实**：`facts.domain` 的 `label` / `value` / `hint` 一字不改地照画，
 *      顺序就是数据层给的顺序——UI 不知道「改动」「评分」是什么。要上色 / 做 Tag 的地方由数据层
 *      给成 `segments` / `hintSegments`（每段声明自己是什么），**界面绝不自己去拆 `+111` 这种文本**
 *      （见 `types.ts` 的 `DomainFactSegment`）；
 *   4. **不可折叠、也不放入口**：「原始输出」归 `raw-output-panel`，「？环境信息」归工具条预设，
 *      放进来会让固定区变成第二个工具条。
 *
 * 「等待答复」是**派生**的（`waitingSince` 由调用方从当前节点的块里扫出来）：
 * 它不进 `facts`、也不进 `rowEvents`，因为它是**当前态**而不是发生过的事件。
 */
import { Badge, Flex, Tag, theme, Typography } from 'antd';
import type { ReactNode } from 'react';
import type { AgentLogFacts, AgentRunStatus, DomainFactSegment } from './types';
import { formatDuration } from '../../base/metric-line';
import { ROW_STATUS_COLORS } from '../../base/row-status-tag';
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

/** 领域事实的色档 → `Tag` 的预设色 */
const DOMAIN_TONE_COLOR: Record<NonNullable<AgentLogFacts['domain'][number]['tone']>, string> = {
  default: 'default',
  success: 'success',
  warning: 'warning',
  error: 'error',
};

/**
 * 结束原因 → `Tag` 配色。
 *
 * 这些词是**我们编排层**结算时写下的账（`evaluator` 的 settle 分支：completed / rescored /
 * canceled / interrupted / skipped / timed-out / error），不是厂商词汇，所以这张表留在界面这一层。
 * 其中六个与行状态是**同一个处境**，故直接取 `ROW_STATUS_COLORS`——同一个处境在两个地方不该是
 * 两种颜色，而写死一份就会漂移（`rescored` 没有对应的行状态，取 `judging` 那一档：都在评分这条路上）。
 * 没见过的词退回 `default`：不替未知编一个颜色。
 */
const EXIT_REASON_COLORS: Record<string, string> = {
  completed: ROW_STATUS_COLORS.judged,
  rescored: ROW_STATUS_COLORS.judging,
  canceled: ROW_STATUS_COLORS.canceled,
  interrupted: ROW_STATUS_COLORS.interrupted,
  skipped: ROW_STATUS_COLORS.skipped,
  'timed-out': ROW_STATUS_COLORS['timed-out'],
  error: ROW_STATUS_COLORS.failed,
};

/**
 * 一段领域事实。三种画法**全按数据层的声明**（界面不认「哪个词是加号」）：
 *   · `tag` ⇒ 一枚蓝 `Tag`（模型名这类标识；蓝色是 2026-10-07 用户口径定的）；
 *   · `insertion` / `deletion` ⇒ git 惯例的绿 / 红（`+N` / `−N`）；
 *   · 其余 ⇒ 跟随所在文字的颜色（放进 `type="secondary"` 的 `Text` 里就是次要色）。
 */
function FactSegment({ segment, token }: { segment: DomainFactSegment; token: Token }): ReactNode {
  if (segment.tag === true) return <Tag color="blue">{segment.text}</Tag>;
  if (segment.tone === 'insertion') return <span style={{ color: token.colorSuccess }}>{segment.text}</span>;
  if (segment.tone === 'deletion') return <span style={{ color: token.colorError }}>{segment.text}</span>;
  return segment.text;
}

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

      <Typography.Text type="secondary" data-testid="agent-log-facts-turns">
        轮次 {facts.turns.current}
        {facts.turns.total === null ? '' : ` / ${facts.turns.total}`} 轮
      </Typography.Text>

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

      {/* 领域事实：按数据层给的顺序逐格画，空数组时这一组整个不出现 */}
      {facts.domain.length > 0 && (
        <Flex align="center" gap={token.marginSM} wrap data-testid="agent-log-facts-domain">
          {facts.domain.map((fact) => (
            <Flex key={fact.id} align="center" gap={token.marginXXS}>
              <Typography.Text type="secondary">{fact.label}</Typography.Text>
              {/* 值两种画法：数据层给了 `segments` 就按段画（外层统一次要色，段内再覆盖成绿/红），
                  否则整段一枚色档 Tag（评分那一格就是 `87/100` 那枚绿 Tag） */}
              {fact.segments === undefined ? (
                fact.tone === undefined ? (
                  <Typography.Text>{fact.value}</Typography.Text>
                ) : (
                  <Tag color={DOMAIN_TONE_COLOR[fact.tone]}>{fact.value}</Tag>
                )
              ) : (
                <Typography.Text type="secondary">
                  {fact.segments.map((segment, index) => (
                    <FactSegment key={index} segment={segment} token={token} />
                  ))}
                </Typography.Text>
              )}
              {/* 提示同样可以分段（评分那一格把模型名画成 Tag），没分段就是一句次要色文本 */}
              {fact.hintSegments === undefined
                ? fact.hint !== undefined && <Typography.Text type="secondary">{fact.hint}</Typography.Text>
                : (
                  <Typography.Text type="secondary">
                    {fact.hintSegments.map((segment, index) => (
                      <FactSegment key={index} segment={segment} token={token} />
                    ))}
                  </Typography.Text>
                )}
            </Flex>
          ))}
        </Flex>
      )}

      {/* 失败归因：`code` 可以为 null（不是每种失败都有错误码），有就一起给，没有就不留空格 */}
      {facts.error !== null && (
        <Tag color="error" data-testid="agent-log-facts-error">
          {facts.error.code === null ? facts.error.message : `${facts.error.code} ${facts.error.message}`}
        </Tag>
      )}

      {facts.exitReason !== null && (
        <Typography.Text type="secondary" data-testid="agent-log-facts-exit">
          结束原因 <Tag color={EXIT_REASON_COLORS[facts.exitReason] ?? 'default'}>{facts.exitReason}</Tag>
        </Typography.Text>
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
