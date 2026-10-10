/**
 * 日志抽屉该渲染什么：把「读失败 / 实时通道故障 / 读取中 / 有内容」收成一个纯函数。
 *
 * 为什么必须抽出来并有守卫：「读不出来」与「实时通道断了」这两件事只能在页面层表达；
 * 而抽屉在**两条来源都空**时给的空态是「还没有日志 · 这一行还没开始执行」——与故障同时出现时，
 * 使用者会把一个**真实的故障**（api 折出来的中文原因带文件路径 / SSE 连接中断）读成「还没开始跑」，
 * 于是去等一个永远不会开始的执行。这是「坏比缺更糟」的典型形状：少一句日志只是缺，
 * 说错一句则是把人引到错误的方向。
 * 页面本身没有测试面（`apps/web-next` 不能写 `.tsx` 测试），故判定与文案都在这里定死。
 *
 * **两条来源、各自独立**：抽屉的内容来自
 * ① 行级**事件**（`/log` + `/stream`：固定事实条与「原始输出」）
 * ② 内容级**记录**（`/messages` + `/messages/stream`：时间轴）。
 * 两者会**各自失败**，而「事件读不出来」不等于「没有内容可看」——
 * 反过来也一样。故这里收的是**两条来源合起来的可渲染性**（`hasContent`）。
 *
 * 四条判定口径：
 * 1. **有错且两条来源都没有东西**→ `failed`：整段替换抽屉内容。
 * 两种错都走这里：`logError` 是**读文件失败**（带 `events.jsonl` 路径），`streamError` 是
 * **实时通道不可用**（连接中断 / 环境不支持 EventSource / 坏帧）——后者过去被页面直接丢掉，
 * 于是断流只表现为「还没有日志 + 未连接」，没有原因；
 * 2. **有错但手上还有东西**→ 照旧渲染，另给一条非破坏性提示
 * ——与用例页 `resolveCasePanel` 的 `stale` 同一口径：只要还有真数据就别把它藏起来。
 * 两种提示分开表达：`liveError` 是实时通道，`warning` 是读文件失败；
 * 3. **没东西也没错**→ `loading` 只表示「第一次拉取还在路上」，一旦拿到空结果就不是加载中，
 * 该由抽屉说「还没有日志」（那是真的没开始跑，两者必须能分开）；
 * 4. `streamError` 里 `undefined` 与 `null` 等价（`useRowStream.error` 的初值是 `null`）。
 */
import { AGENT_LABELS, ROW_STATUS_LABELS, isRunningRow, type AgentEvent, type EvalRow } from '@aieval/contracts';
import type { AgentLogFactsInput, AgentRunStatus, DomainFact, DomainFactSegment } from '@aieval/client';
import { describeError } from './runs-view';

export type LogDrawerState =
  /** 首次拉取中（两条来源都还没有东西、也还没有错误） */
  | { kind: 'loading' }
  /** 有故障且两条来源都没有东西：抽屉整段显示这句原因，**不渲染空态** */
  | { kind: 'failed'; message: string }
  /** 有东西可渲染（两条都空时由抽屉给「还没有日志」空态）；两个提示位见文件头口径 2 */
  | { kind: 'log'; events: AgentEvent[]; liveError?: string; warning?: string };

export interface LogDrawerInput {
  /** 已交付的事件（页面传的是 `useRowStream().events`：`/log` 首帧 + SSE 增量、已按 seq 去重） */
  events: AgentEvent[];
  /**
   * 内容级记录（消息 + 子任务行）的条数：与 `events` 是**两条独立的来源**，
   * 任一条有东西就不算「没内容」。不给按 0 算。
   */
  recordCount?: number;
  /** `useRowLog().error`：ServiceError 时 message 就是 api 的中文原因（**带 events.jsonl 路径**） */
  logError: unknown;
  /** `useRowStream().error`：实时通道的原因（断线会自动重连 / 环境不支持 / 坏帧） */
  streamError?: unknown;
  /** 事件或记录的首次拉取还在路上 */
  isLoading: boolean;
}

/**
 * 实时通道的故障原因：`useRowStream` 的三个 `setError` 都塞的是**普通 `Error`**
 * （`实时日志连接中断：…` / `当前环境不支持 EventSource：…` / `收到无法解析的事件帧，已跳过`），
 * 而通用的 `describeError` 只透 `ServiceError` 的 message、其余一律折成「操作失败，请稍后重试」
 * ——直接把 `Error` 喂给它等于把**唯一的原因**丢掉。
 * 所以这里按 `Error.message` 取原文，非 `Error` 才退回通用兜底。
 */
function reasonText(error: unknown): string {
  return error instanceof Error ? error.message : describeError(error);
}

/** 两种故障的措辞必须分开：`streamError` 说的是实时通道，不是「读取失败」（那是文件读不出来） */
function streamFailureMessage(error: unknown): string {
  return `实时通道不可用：${reasonText(error)}。仅显示已落盘的内容，实时追加暂时不可用`;
}

function streamWarningMessage(error: unknown): string {
  return `实时通道已断：${reasonText(error)}。已收到的内容不受影响`;
}

export function resolveLogDrawer(input: LogDrawerInput): LogDrawerState {
  const { events, logError, streamError, isLoading } = input;
  const hasContent = events.length > 0 || (input.recordCount ?? 0) > 0;

  if (logError != null) {
    const message = describeError(logError);
    // 两条来源都没有东西：整段替换。**不要**改成「渲染抽屉 + 一条 Alert」——
    // 抽屉在两者都空时会同时渲染「还没有日志」空态，那正是本条要防的误读
    if (!hasContent) return { kind: 'failed', message };
    // 有数据：读失败与实时通道故障**都要说**（少说一条就少一条排障线索）
    return {
      kind: 'log',
      events,
      warning: message,
      ...(streamError == null ? {} : { liveError: streamWarningMessage(streamError) }),
    };
  }

  // 实时通道的故障：没有它，抽屉只会显示「还没有日志 + 未连接」，使用者看不到任何原因
  if (streamError != null) {
    if (!hasContent) return { kind: 'failed', message: streamFailureMessage(streamError) };
    return { kind: 'log', events, liveError: streamWarningMessage(streamError) };
  }

  if (isLoading && !hasContent) return { kind: 'loading' };
  return { kind: 'log', events };
}

/**
 * 行状态 → 事实条的**色档**。
 *
 * `tone` 是**界面词汇**（决定徽标色与要不要挂动效），文案一律用 `ROW_STATUS_LABELS`
 * （十态一字不丢）。为什么不把 `EvalRowStatus` 直接写进 `AgentLogModel`：
 * `preparing` / `judging` / `judged` / `interrupted` 只有本仓的评分通路才有，
 * 通用消费方没有这些段——写进模型等于「换一个消费场景就要先改模型」。
 *
 * `skipped`（串行队列里没轮到）落 `canceled` 而不是 `failed`：它没跑，不是跑坏了。
 */
function toneOf(status: EvalRow['status']): AgentRunStatus['tone'] {
  switch (status) {
    case 'pending':
    case 'preparing':
      return 'pending';
    case 'running':
    case 'judging':
      return 'running';
    case 'judged':
      return 'ok';
    case 'failed':
    case 'timed-out':
    case 'interrupted':
      return 'failed';
    default:
      return 'canceled';
  }
}

/**
 * 最后一条满足条件的行级事件；没有就 `null`（`target: ES2022`，故不用 `Array.findLast`）。
 * `matches` 不给 = 只按类型取最后一条（`end` 那一格就是这么用的）。
 */
function lastEvent<T extends AgentEvent['type']>(
  events: readonly AgentEvent[],
  type: T,
  matches?: (event: Extract<AgentEvent, { type: T }>) => boolean,
): Extract<AgentEvent, { type: T }> | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event === undefined || event.type !== type) continue;
    const typed = event as Extract<AgentEvent, { type: T }>;
    if (matches === undefined || matches(typed)) return typed;
  }
  return null;
}

/**
 * 分段事实的**纯文本**：把各段 `text` 拼回来（顺序就是渲染顺序）。
 *
 * 为什么由这一层拼：`DomainFact.value` / `hint` 除了上屏还给读屏与排障文本用，
 * 而**分段只描述「怎么画」**（`types.ts` 的 `DomainFactSegment`）⇒ 两者必须逐字一致。
 * 手写第二遍数字就是两份真源，迟早对不上（症状是「复制出来的改动数」与眼睛看到的不是一件事）。
 */
function segmentsText(segments: readonly DomainFactSegment[]): string {
  return segments.map((segment) => segment.text).join('');
}

/**
 * 这一行的事实 → `AgentLogModel.facts`。
 *
 * 三处必须守的口径：
 * · **拿不到就是 `null`**：`tokens` 为空时不写 0（`null` 是「没采到」，0 是「采到了且为零」，
 * 两者在界面上是两句话）；
 * · **行级读数只认主会话那一条**：`turn.subagentId` 非空的 `usage` 是**会话尺度**
 * 读数（那个子会话自己的累计，claude 收尾逐轮才发） ⇒ 不许拿它当这一行的事实，判据见 `lastUsage`；
 * · **`domain` 由这里拼成「一行文字 + 一个色档」**：`score` / `diff` 属于**领域事实**
 * （通用组件不认识「评分」「改动」这两个业务概念），故格名与值都在这一层给；
 * · **`turns.total` 恒为 `null`**：快照里的 `turns` 是「到目前为止」，不是「一共就这么多」
 * ——写一个会走动的数当分母，进度条会在跑到第 3 轮时显示「3 / 3」。
 *
 * 行级的**开始时刻只能从事件流取**：`EvalRow.startedAt` 是轮级字段，拿它当行级开始时刻
 * 会让同轮的另一行显示出一个不属于自己的耗时。
 */
export function buildRowFacts(input: { row: EvalRow; events: readonly AgentEvent[] }): AgentLogFactsInput {
  const { row, events } = input;
  const live = isRunningRow(row.status);
  const startedAt = events.find((event) => event.type === 'status' && event.status === 'running')?.at ?? null;
  /**
   * **行级读数只认主会话那一条**。
   *
   * `turn.subagentId` **非空**的是**会话尺度**读数（那个子会话自己的累计，claude 收尾逐轮才发）；
   * 拿它当行级事实，抽屉事实条在评分期就会显示子会话的 16,335 ——而这一行的权威值是 34,101
   *（真机复算，run `155f7f1e` 的 claude 行）。它**排在最后**，而这一格取的是「最后一条」。
   * 三档主会话读数（`turn` 整格缺席 / 显式 `null` / `subagentId === null`）合流成一处 `?? null`：
   * 读侧它们本来就是同一件事。
   */
  const lastUsage = lastEvent(events, 'usage', (event) => (event.turn?.subagentId ?? null) === null);
  const lastEnd = lastEvent(events, 'end');

  const domain: DomainFact[] = [];
  /**
   * 「谁在跑」三格：智能体 / 模型 / 思考强度。它们与下面
   * 「改了多少 / 得了多少分」**同属固定区的第二行**（`agent-log-domain-facts.tsx`），
   * 顺序即渲染顺序，故这三格先 push。
   *
   * **为什么不给 `AgentLogFacts` 加三个字段**：`agent-log` 不认「评测行」这个业务概念，
   * 加字段等于把评测行的形状写进通用件；而 `domain` 本来就是「数据层给格名与值、UI 只摆版」的口子。
   *
   * 值走 `segments` 的 `tag` 段、一色一格（智能体 `blue` / 模型 `geekblue` / 思考强度 `purple`），
   * 与评分详情顶部那一段同色——同一个档位在本仓的两处长得一样。档位照上游词汇原样写：
   * 显式关闭档就是 `off`，它**不是**「未指定」的同义词；键缺席才是「未指定」。
   */
  const agentText = AGENT_LABELS[row.agentKind];
  const effortText = row.effort === undefined ? '未指定' : row.effort;
  domain.push(
    {
      id: 'agent',
      label: '智能体',
      value: agentText,
      segments: [{ text: agentText, tag: true, tagTone: 'blue' }],
    },
    {
      id: 'model',
      label: '模型',
      value: row.modelId,
      segments: [{ text: row.modelId, tag: true, tagTone: 'geekblue' }],
    },
    {
      id: 'effort',
      label: '思考强度',
      value: effortText,
      segments: [{ text: effortText, tag: true, tagTone: 'purple' }],
    },
  );
  if (row.diff !== null) {
    /**
     * 改动那一格按 git stat 排版：文件数次要色 + `+N` 绿 + `−N` 红。
     * **分段由这里给**（界面不解析文本，只按每一段的声明上色），纯文本 `value` 由同一份分段拼出来
     * ——写两遍必然漂移，而两者一旦不一致，「读屏 / 复制」拿到的那串字就与眼睛看到的不是一件事。
     */
    const diffSegments: DomainFactSegment[] = [
      { text: `${row.diff.filesChanged} 个文件 ` },
      { text: `+${row.diff.insertions}`, tone: 'insertion' },
      { text: ` −${row.diff.deletions}`, tone: 'deletion' },
    ];
    domain.push({
      id: 'diff',
      label: '改动',
      value: segmentsText(diffSegments),
      segments: diffSegments,
      ...(row.diff.truncated ? { hint: '按预算裁剪过，被丢弃的文件不计入这里' } : {}),
    });
  }
  if (row.score !== null) {
    /**
     * 「评分」这一格**只给分**。
     * 「谁当的尺子」（评分模型 / 评分智能体）归**评分详情**那一页说——事实条上再写一遍
     * 是与那一页争夺注意力，而那一页里连着通路（文本 API / 智能体）与强度一起给，信息是完整的。
     */
    domain.push({
      id: 'score',
      label: '评分',
      value: `${row.score.totalScore}/${row.score.maxScore}`,
      tone: 'success',
    });
  }

  return {
    status: { tone: toneOf(row.status), label: ROW_STATUS_LABELS[row.status] },
    startedAt,
    // 还在跑就没有结束时刻；跑完但事件流里没有 `end` 帧时同样留 `null`（**不编造时刻**）
    endedAt: live ? null : (lastEnd?.at ?? null),
    /**
     * 轮次这一格是**过渡值**：`buildAgentLogModel` 会用时间轴自己的轮次数覆盖 `current`，
     * 并把 `total` 定为 `null`（那才是与时间轴同一把尺子）。
     *
     * 这里**不要把** `row.turns` 当分母：行快照那一格是「已经观察到几轮」，不是「一共几轮」，
     * 拿它当分母会渲染出「轮次 4 / 3 轮」这种自相矛盾的读数
     * （冒烟实测：进度条的 `4 / 3` 与时间轴护栏的 `已渲染 4 / 共 4 轮` 同时出现在屏幕上）。
     */
    turns: { current: lastUsage?.turns ?? 0, total: null },
    tokens: row.tokens ?? lastUsage?.tokens ?? null,
    // 思考 token 与 `tokens` **并列**：它可能是输出的子集（`basis` 决定能不能相加）
    thinking:
      lastUsage?.tokens?.reasoningOutput == null
        ? null
        : { tokens: lastUsage.tokens.reasoningOutput, basis: 'subset-of-output' },
    domain,
    error: row.error === null ? null : { code: row.error.code, message: row.error.message },
    live,
  };
}
