'use client';

/**
 * 一行计量摘要：token / 缓存命中 / 轮次 / 耗时 / 得分。
 * **`null` 与 `0` 必须长得不一样**（spec §5.6.3）：`null` = 没采到（显示「未采集」；
 * 该智能体根本不上报用量时显示「不支持计量」），`0` = 真的是 0（例如 0 轮）。
 * 把 `null` 渲染成 0 会让人得出「这家很省」的错误结论，比不显示更糟；
 * 反过来把真实的 0 吃掉同样会让人以为采集坏了。
 * token 只累加「输入 + 输出」：**归一之后**三元组的三项互不相交（`input` 是非缓存输入、
 * `cached` 是缓存读、`output` 是产出）⇒ 三项相加也不会重复计数，而缓存读不属于「这一行花了多少钱」
 * 里的新输入那一部分（它已经在 `input` 之外单独计数，见 `usage-metrics.ts`）。
 * 「缓存命中」是**派生**指标（不新增采集字段）：契约把 `input` 定义成**非缓存输入**
 * ⇒ `input` 与 `cached` 互斥，分母只能是两者之和，见 `formatCacheHitRate`。
 *
 * ⚠️ **这个互斥是适配器归一出来的，不是天然如此**（2026-10-XX 补注）：codex 的
 * `input_tokens` **含**缓存读（`cached_input_tokens` 是它的明细，真机 `8152 / 6656`），
 * 适配器做了减法 `input = input_tokens − cached_input_tokens`；claude 与 dsh 的原文本来就不含 cache。
 * 消费方因此**不必、也不许**再按家分支——`cached / (input + cached)` 对三家都是同一个口径。
 * 这一格自己不需要 `timing`：命中率只用到 token 两格。
 *
 * 「生成速率（tok/s）」**不在这个组件里**（它要 `timing`，而快照里没存这一格）：
 * 公式、来源标注与「未采集」的判定都在 `usage-metrics.ts`，今天只有日志抽屉消费它。
 *
 * 跑动期的第三种状态「**采集中**」（用户口径，2026-09-26）：行还在跑、适配器又还没报数时，
 * 说「未采集」是**错的**——那是「这一行结束了也没采到」的结论（终态口径），两者混在一起会让人
 * 以为采集坏了。故 `running` 为真时这几格显示「采集中」；得分不在此列（评分在跑完之后才发生，
 * 始终是「未评分」）。
 *
 * 而 `running` 里还要再分两段（用户口径，2026-09-29）：**候选阶段**与**评分阶段**。
 * 评分智能体跑在同一个工作区里、事件也进同一条流（`judgeRowByAgent` 转发适配器事件），它报的
 * tok / 轮次是**评审者**的——覆盖上去会让「这个模型多省」变成「这把尺子多贵」。故叠加层带一格
 * `candidateEnded`（`status: judging` 一到即为真）：那之后这几格冻结在候选的读数上，秒表停在
 * 候选结束那一刻（与快照的 `durationMs` 同口径：它只算候选那一段），没采到时说「未采集」
 * 而不是「采集中」——那几格此后不会再有人报数，说「采集中」是空承诺。
 */
import { Flex, Tooltip, Typography } from 'antd';
import type { ReactNode } from 'react';
import type { ScoreResult } from '@aieval/contracts';
import { formatCacheHitRate } from './usage-metrics';
import { useNow } from './use-now';

/**
 * 行在跑动期的实时叠加层（来自 SSE）。
 * 形状与 `@aieval/client` 的 `RowLiveMetrics` **逐字段一致**（ui 不能 import client，故在此重复声明）：
 * 两边脱钩时 `apps/web-next` 的接线处会 tsc 报错——那是最早、也最便宜的一次拦截。
 *
 * `latestText` 是 2026-09-29 加进来的**同一路数据**（同一条流折出来的**给人看的一句话**）：
 * 它由 `AgentActivityLine` 消费，本文件（计量那一行）**不看它**——计量与「最近在干什么」
 * 是两件事，混在一行里会让「未采集」与「没有消息」分不开。
 */
export interface LiveMetricsView {
  /** 这一行开始执行的时刻（毫秒）；null = 还没开始（准备中），此时不走秒表 */
  startedAtMs: number | null;
  tokens: { input: number; cached: number; output: number } | null;
  turns: number | null;
  /**
   * **给人看的一句话**（适配器给的 `log.summary` 优先，判定见 `@aieval/client` 的 `activityOf`）；
   * null = 还没有可说的事（活动行据此回落成状态文案）。**原始日志不会进这一格**：
   * 没有摘要的 JSON 行（厂商信封）只是排障证据，不显示在卡片上。
   */
  latestText: string | null;
  /**
   * 候选阶段是否已经结束（`status: judging` 或终态一到即为真，折叠口径见 `row-live.ts` 第 5 条）：
   * 为真时 `tokens` / `turns` 已经是**冻结**的候选读数，评分智能体的用量不会进这几格。
   */
  candidateEnded: boolean;
  /** 候选阶段结束的时刻（毫秒）；null = 还没结束 / 那个时刻解析不出来（耗时那一格退回快照值） */
  candidateEndedAtMs: number | null;
}

export interface MetricLineProps {
  tokens: { input: number; cached: number; output: number } | null;
  turns: number | null;
  durationMs: number | null;
  score: ScoreResult | null;
  /** 该智能体采不到用量（注册表 `metadata.capability.usage === false`）——文案与「未采集」不同 */
  usageUnsupported?: boolean;
  /** 这一行此刻是否在运行（准备中 / 执行中 / 评分中）——决定「采集中」与实时值是否生效 */
  running?: boolean;
  /**
   * 跑动期的实时值；**只在 `running` 为真时生效**（终态一律以快照里的权威值为准）。
   * 这里**只声明它真正要的那几格**：叠加层里还有一格是**给人看的一句话**
   * （`LiveMetricsView.latestText`），那格由 `AgentActivityLine` 消费、本组件不看——
   * 直接收整个 `LiveMetricsView` 会让每一条计量用例都被迫携带一个与自己无关的字段。
   * 候选阶段的结束点（`candidateEnded` / `candidateEndedAtMs`）**要**：它决定这几格是否已冻结。
   */
  live?: Pick<LiveMetricsView, 'startedAtMs' | 'tokens' | 'turns' | 'candidateEnded' | 'candidateEndedAtMs'>;
}

/** 千分位：横排数字用逗号分组，扫一眼就能估量级 */
export function formatCount(value: number): string {
  return value.toLocaleString('en-US');
}

/** 毫秒 → `45s` / `6m23s` / `1h05m`；负数与非有限数按 `0s` 处理（脏值不该让界面出现 NaN） */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0s';
  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h${String(minutes).padStart(2, '0')}m`;
  if (minutes > 0) return `${minutes}m${String(seconds).padStart(2, '0')}s`;
  return `${seconds}s`;
}

/**
 * 缓存命中率：`缓存读 / 总输入`，四舍五入成整数百分比（`98%`）。
 * 实现与口径说明搬到 `usage-metrics.ts`（2026-10-XX）：日志行也要用同一个公式，
 * 而这个文件是 `.tsx`（带 React），纯函数的日志模块不该 import 它。这里只做**再导出**，
 * 既有调用点（`packages/client/ui/src/index.ts` 与用例）一个字都不用改。
 */
export { formatCacheHitRate } from './usage-metrics';

export function MetricLine({
  tokens,
  turns,
  durationMs,
  score,
  usageUnsupported = false,
  running = false,
  live,
}: MetricLineProps): ReactNode {
  /**
   * 实时叠加层**只在运行期生效**：终态的耗时/用量以快照为准（结算值不该被一个还在涨的秒表顶掉）。
   * 运行期里再分两段：候选阶段一结束（`candidateEnded`），叠加层里的这几格就**冻结**在那里——
   * 评分智能体报的 tok / 轮次是评审者的，覆盖上去就是答非所问（见文件头口径 5）。
   * 冻结后**仍然用叠加层里的值**而不是快照：它是候选那一段的读数，且不会在评分期间闪成「未采集」
   * （快照靠 3 秒轮询补，冻结值本来就和它同源；差异只在「估算被权威值替换」这条既有口径上）。
   */
  const overlay = running ? live : undefined;
  const frozen = overlay?.candidateEnded === true;
  const liveTokens = overlay?.tokens ?? null;
  const shownTokens = liveTokens ?? tokens;
  const shownTurns = overlay?.turns ?? turns;
  /**
   * 秒表：候选阶段看着它涨；一进评分就停在候选结束那一刻（快照里的 `durationMs` 同口径——
   * 只算候选那一段，横向比的是候选的成本而不是整行墙钟，停下来才不会在终态那一下往回跳几分钟）。
   * 拿不到开始时刻（刚进准备阶段）或结束时刻解析不出来时，退回快照里的权威值。
   */
  const ticking = overlay !== undefined && !frozen && overlay.startedAtMs !== null;
  const now = useNow(ticking);
  const elapsedMs = ticking && overlay.startedAtMs !== null ? now - overlay.startedAtMs : null;
  const frozenElapsedMs =
    frozen && overlay.startedAtMs !== null && overlay.candidateEndedAtMs !== null
      ? overlay.candidateEndedAtMs - overlay.startedAtMs
      : null;
  const shownDurationMs = elapsedMs ?? frozenElapsedMs ?? durationMs;

  // 没采到用量时的文案分三种：不支持计量 > 运行中「采集中」 > 终态「未采集」。
  // 「采集中」不能盖掉「不支持计量」：那家适配器永远不会报数，说「采集中」是误导；
  // 它也**只属于候选阶段**：进了评分，这几格不会再有人报数（评分智能体的用量不进这几格）
  const collecting = running && !frozen;
  const missingTokensText = usageUnsupported ? '不支持计量' : collecting ? '采集中' : '未采集';
  const missingTurnsText = collecting ? '采集中' : '未采集';
  // 没采到用量时给一句明确的中文：绝不给 0
  const tokenText = shownTokens === null ? missingTokensText : formatCount(shownTokens.input + shownTokens.output);
  const tokenDetail =
    shownTokens === null
      ? undefined
      : `输入 ${formatCount(shownTokens.input)} · 缓存 ${formatCount(shownTokens.cached)} · 输出 ${formatCount(shownTokens.output)}`;
  // 命中率与 tok 同源：没采到用量时同样只说「未采集 / 采集中 / 不支持计量」，不显示 0%（0 与「没采到」含义相反）
  const hitRateText = shownTokens === null ? missingTokensText : formatCacheHitRate(shownTokens);

  return (
    <Flex gap={16} wrap>
      <Tooltip title={tokenDetail}>
        <Typography.Text type="secondary">tok {tokenText}</Typography.Text>
      </Tooltip>
      <Typography.Text type="secondary">缓存命中 {hitRateText}</Typography.Text>
      <Typography.Text type="secondary">轮次 {shownTurns === null ? missingTurnsText : formatCount(shownTurns)}</Typography.Text>
      <Typography.Text type="secondary">
        耗时 {shownDurationMs === null ? (collecting ? '采集中' : '未采集') : formatDuration(shownDurationMs)}
      </Typography.Text>
      <Typography.Text type="secondary">得分 {score === null ? '未评分' : formatCount(score.totalScore)}</Typography.Text>
    </Flex>
  );
}
