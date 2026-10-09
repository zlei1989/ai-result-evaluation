/**
 * 事件 → 日志行（纯函数，无 React 依赖，可单独测）。
 * 八种事件类型各有一行可读文本：**任何一种被静默丢掉，排障时就少一条证据**
 * （spec §5.6.3 要求未识别的事件也要保留原始负载，不得丢弃）。
 *
 * 本模块**只负责把已落盘的事件渲染成行**：它不推断行状态、不看快照、不合并轮次——
 * 「这一行现在是什么状态」的唯一来源是 `EvalRow.status`（快照），拿日志反推状态等于
 * 造第二份真相。同理，同一行重跑后新一轮的 seq 会回到 1，怎么切分由数据层
 * （`useRowStream` 的文件头口径 5）决定，这里只管把拿到的这一批逐行渲染。
 *
 * 时间戳取**本机时区**的 `HH:mm:ss`（与 `base/format.ts` 的 `formatDateTime` 同一口径：
 * 界面上所有时间都是使用者的本地时间）；非法输入原样返回——显示 `Invalid Date`
 * 比显示原始串更糟。
 *
 * `score` 行有**两条通路**，文字上必须分得开（spec §10 展示表）：`judgeAgentKind === null`
 * ⇔ 纯文本 API 评分（老记录经契约的 `.default(null)` 读盘后同样是 `null`），此时行文保持原样；
 * 非 null 才在模型名前面加上智能体名与「（智能体）」——同一行重跑后两次评分的日志混在一条流里，
 * 少了智能体名就分不出哪个分是哪条通路打的，而两条通路的分数不可比
 * （README「分数怎么来的」的既有口径）。
 *
 * `usage` 行在 2026-10-XX 起多带**时间与两个派生比率**（用户口径：消息里要有算 tok/s 与
 * 缓存命中率所需的全部数据）。三条取舍：
 *   · **原料缺失就说「未采集」**：`timing` 为 `null` 时那一截写「耗时未采集」，
 *     绝不当成 0 秒（0 秒会算出一个无穷大的 tok/s，而真正的事实是「这一家没报时间」）；
 *   · **派生比率用 `usage-metrics.ts` 的那一份实现**（跨三家统一的公式），本模块不再写第二份；
 *   · **来源必须标**：`'events'` 的时长含工具执行，与 `'vendor'` 的纯模型时间不可直接比
 *     （见 `timingSourceLabel`）——tok/s 后面缀一个 `(墙钟)` 就是为了不让人把两者放进同一张表。
 */
import { AGENT_LABELS, ROW_STATUS_LABELS, type AgentEvent } from '@aieval/contracts';
import { formatCacheHitRate, formatGenerationRate, formatTokens, timingSourceLabel } from '../base/usage-metrics';

/** ISO 时间 → 本地 `HH:mm:ss`；非法输入原样返回 */
function formatClock(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** 一条事件 → 一行日志文本（`[时间] 内容`） */
export function formatEventLine(event: AgentEvent): string {
  const time = formatClock(event.at);
  switch (event.type) {
    case 'log':
      return `[${time}] ${event.stream} ${event.text}`;
    case 'vendor-system':
      return `[${time}] ${vendorSystemLine(event)}`;
    case 'status':
      return `[${time}] 状态 ${ROW_STATUS_LABELS[event.status]}`;
    case 'usage':
      // 轮次与计量各自独立（2026-09-28）：一条只带轮次的 usage 是常态（轮次一到就发），
      // 这时只说轮次——写三个 0 会让人以为「这家很省」，写「未采集」又会与真正的终态混淆。
      return `[${time}] ${usageLine(event)}`;
    case 'diff-summary':
      return `[${time}] 改动 ${event.filesChanged} 个文件 +${event.insertions} −${event.deletions}${
        event.truncated ? '（已截断）' : ''
      }`;
    case 'score':
      return `[${time}] 评分 总分 ${event.score.totalScore} · ${
        event.score.judgeAgentKind === null
          ? event.score.judgeModelId
          : `${AGENT_LABELS[event.score.judgeAgentKind]}（智能体）· ${event.score.judgeModelId}`
      }`;
    case 'error':
      return `[${time}] 错误 ${event.message}`;
    case 'end':
      return `[${time}] 结束 ${event.exitReason}`;
  }
}

/** 全部事件 → 多行文本（日志抽屉的正文与下载内容共用同一个出口） */
export function formatEventLog(events: AgentEvent[]): string {
  return events.map(formatEventLine).join('\n');
}

/** 取 `vendor-system` 事件（判别联合的窄化辅助：调用方拿到的就是那个成员） */
type VendorSystemEvent = Extract<AgentEvent, { type: 'vendor-system' }>;

/**
 * `vendor-system` 事件的正文（不含 `[时间] ` 前缀）。
 *
 * 三段判据（2026-10-04）：
 *   · **计数写「N 项」而不是把工具名铺开**：真机 21 个工具、47 条斜杠命令，铺开来会把
 *     抽屉正文一屏占满，而这一行要回答的只是「有没有、大概多少」——逐项内容在环境抽屉里；
 *   · **缺的格整段不出现**：`null` 是「厂商没投送」，写成「斜杠命令 0 项」与它含义相反
 *     （`[]` 才是「采到了，确实是空的」，那时才写 0 项）；
 *   · 六格全空（理论上的边界）写「未采集」，**不留一行光秃秃的前缀**。
 */
function vendorSystemLine(event: VendorSystemEvent): string {
  const parts: string[] = [];
  const counted: readonly [keyof VendorSystemEvent, readonly string[] | null, string][] = [
    ['tools', event.tools, '工具'],
    ['slashCommands', event.slashCommands, '斜杠命令'],
    ['agents', event.agents, '子智能体定义'],
    ['mcpServers', event.mcpServers, 'MCP'],
  ];
  for (const [, values, label] of counted) {
    if (values === null) continue;
    parts.push(`${label} ${values.length} 项`);
  }
  if (event.permissionMode !== null) parts.push(`权限档 ${event.permissionMode}`);
  if (event.outputStyle !== null) parts.push(`输出风格 ${event.outputStyle}`);
  return parts.length === 0 ? '系统层 未采集' : `系统层 ${parts.join(' · ')}`;
}

/** 取 `usage` 事件（判别联合的窄化辅助：调用方拿到的就是那个成员） */
type UsageEvent = Extract<AgentEvent, { type: 'usage' }>;

/**
 * `usage` 事件的正文（不含 `[时间] ` 前缀）。
 *
 * 形状（片段之间只用 ` · ` 连，缺的那截整段不出现）：
 * ```
 * 用量 输入 218 tok · 缓存 8,832 tok · 命中 98% · 输出 2 tok · 轮次 1 · 耗时 166.7s · 首字 7.6s · 生成 0.3 tok/s ·（厂商自报…）
 * ```
 * 四段判据：
 *   · `tokens === null` ⇒ **只说轮次**（这一条没带计量；写三个 0 会让人以为「这家很省」）；
 *   · 有 tokens ⇒ 三项（`formatTokens`：千分位 + `tok`）+ **命中率**（`usage-metrics.ts` 的统一公式，
 *     它是百分比、**不带** `tok`）；
 *   · `timing === null` ⇒ **只说「耗时未采集」**（不写 0s：0 秒会算出一个无穷大的 tok/s）；
 *     有 `timing` ⇒ 耗时 + （有则）首字延迟 + （算得出则）tok/s，并按来源缀一句口径说明；
 *   · 两个可选格（思考 / 厂商总量）有值才显示——`null` 是「这一家不报」，显示成 0 是撒谎。
 */
function usageLine(event: UsageEvent): string {
  const parts: string[] = [];
  if (event.tokens !== null) {
    const { input, cached, output, reasoningOutput, total } = event.tokens;
    // 三个 token 计数走 `formatTokens`（千分位 + `tok`）；**命中率不带走**——它是百分比，不是 token 数
    // （判据见 `usage-metrics.ts` 的 `formatTokens`：标签里有没有那个词不算数，这个数是不是 token 才算）
    parts.push(
      `用量 输入 ${formatTokens(input)} · 缓存 ${formatTokens(cached)} · 命中 ${formatCacheHitRate(event.tokens)} · 输出 ${formatTokens(output)}`,
    );
    // 思考 token 是**输出的一部分还是额外的一格**三家口径不同 ⇒ 只展示、不并入 output（见契约注释）
    if (reasoningOutput != null) parts.push(`思考 ${formatTokens(reasoningOutput)}`);
    // 厂商自报总量：排障用（与归一后的三项**对不上是正常的**，见契约注释）
    if (total != null) parts.push(`厂商总量 ${formatTokens(total)}`);
  }
  parts.push(`轮次 ${event.turns}`);

  const timing = event.timing ?? null;
  if (timing === null) {
    // 「未采集」而不是 0：这一格是 tok/s 的分母，编一个 0 会得出无穷大
    parts.push('耗时未采集');
    return parts.join(' · ');
  }
  if (timing.totalMs !== null) parts.push(`耗时 ${(timing.totalMs / 1000).toFixed(1)}s`);
  if (timing.ttftMs !== null) parts.push(`首字 ${(timing.ttftMs / 1000).toFixed(1)}s`);
  const rate = formatGenerationRate(event.tokens, timing);
  // 算不出来（缺时长 / 分母为 0）就说「未采集」——绝不给 NaN 或 0.0
  parts.push(rate === null ? '生成速率未采集' : `生成 ${rate} tok/s`);
  // 来源标注：`'events'` = 墙钟（含工具执行），与纯模型时间不可直接比，见 `timingSourceLabel`
  parts.push(`（${timingSourceLabel(timing.source)}）`);
  return parts.join(' · ');
}
