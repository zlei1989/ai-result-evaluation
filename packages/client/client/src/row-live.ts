/**
 * 跑动期的**实时叠加层**：tok / 轮次 / 行开始时刻 + 智能体最近一条输出。
 *
 * 为什么单独一条流（而不是复用 `useRowStream`）：抽屉那条流要的是**全量事件**（几千条，供日志视图
 * 逐行渲染与下载），而这里要的只是几个字段。把两者分成两个 hook 之后：
 * · 指标这条只保留**折叠结果**，详情页同时开着 6 个候选也不会把事件堆在内存里；
 * · 抽屉关着的时候不必为了几个数字把全量日志拉进浏览器。
 *
 * 五条口径：
 * 1. **值来自事件流、终态交回快照**：跑动期的 tok/轮次是适配器上报值或实时估算（每一条事件自带
 * `tokensBasis`，见 contracts 的 `agent-event.ts`——A2 起口径挂在事件上，不再挂在适配器的
 * 能力声明上），行一进终态就关掉这一行的连接并 mutate 一次快照——界面随后显示的是快照里的
 * 权威值，这里不再自作主张；
 * 2. **只订阅在跑的行的**（调用方传 `rowIds`）：详情页一屏最多几行，而列表页有几十轮——
 * 那条「几十条长连接」的约束就是靠调用方把集合收窄来满足的；
 * 3. **seq 回到 1 = 新一代**：同一行重跑时编排层会删掉事件日志、seq 从 1 重新发号，
 * 旧一轮的指标与文本必须清掉（判据与 `row-stream.ts` 的口径 5 同源，只是这里只关心折叠结果）；
 * 4. **活动消息是「人话」，且按固定节奏采样发布**：卡片底部那一行显示的是
 * `log.summary`；没有摘要、文本又是一坨 JSON 时它**不当消息**——原始负载
 * 照旧在抽屉里逐字可见，但把 `{"method":"session.event",…}` 滚到卡片上就是拿 JSON 冒充消息
 * （判据在 `activityOf`）。发布也不是逐帧的：一行实测有 ~5500 条事件，逐帧 setState
 * 就是每秒几十次整页重渲染——帧只折进 `states`，`latestText` 由 `LIVE_TEXT_SAMPLE` 的定时器
 * 统一发布（那一行的动效本身就是 1.8s 一轮，晚一拍到达不影响观感）；
 * 5. **候选的计量在候选阶段结束那一刻冻结**：评分智能体跑在**同一个工作区**
 * （`judgeRowByAgent`），它的事件也被转发进**同一条流**，于是 `status: judging` 之后每一条
 * `usage` 报的都是**评审者**的用量。卡片上「tok / 缓存命中 / 轮次 / 耗时」
 * 回答的是「候选跑了多少轮、多省」，被评审者的数覆盖就是答非所问——实测某行候选
 * `490,906 tok / 28 轮`，评分期间那几格显示成 `13,715 tok / 2 轮`（那 13,715 是评分智能体的）。
 * 故候选阶段一结束，这几格不再接受任何 `usage`；耗时由界面停在结束时刻（见 `MetricLine`）。
 * `subagentTokens`与 `tokens` 是**同一条冻结口径**：两者是同一次 `usage` 里的
 * 合计与分量，冻结自然同进同出——候选阶段一结束就**都不再更新**；评分智能体的用量既不在
 * 合计里，也不在分量里（它压根不是「候选派发的子智能体」，见的不含那一格）。
 * `subagentTurns`是同一对**轮次版**：`turns` 是合计、它是分量，
 * 冻结与（显式 `null` 清、整格缺席才保持）都与 `subagentTokens` 逐字相同。
 * **带会话身份的 `usage` 同样不是行级读数**：`turn.subagentId` 非空的那一条报的是
 * **那个子会话自己的**累计（claude 收尾逐轮发的就是它），一律不折进这几格——理由与判据在 `stepLiveState`。
 *
 * 与 `useRowStream` 的分工：那边用 `Set<seq>` 去重 + 保序（日志视图不能有重复行、不能倒着长），
 * 这边只需要「旧帧不回退」——`usage` 是覆盖语义、`text` 是覆盖语义、`status` 只认第一次 running，
 * 所以一个 `lastSeq` 游标就够了（少一份状态，也少一处漂移）。
 */
import { useEffect, useState } from 'react';
import { useSWRConfig } from 'swr';
import { AGENT_EVENT_TYPES, TERMINAL_ROW_STATUSES, type AgentEvent } from '@aieval/contracts';
import { getJson } from './http';
import { isTerminalEvent, parseFrame } from './row-stream';
import { RUNS_KEY, runKey, runRowUrl } from './runs';

/** 界面要的字段（ui 只依赖它们，不依赖下面的游标） */
export interface RowLiveMetrics {
  /** 这一行开始执行的时刻（`status: running` 事件的 `at`）；null = 还没开始（准备中 / 待开始） */
  startedAtMs: number | null;
  /**
   * 到目前为止的用量（`usage` 事件里的值；null = 还没有人报过）。
   *
   * ⚠️ **`input` 是「非缓存输入」**（2026-10-XX 起契约明确，各适配器已归一：codex 侧减过
   * `cached_input_tokens`）⇒ 命中率 = `cached / (input + cached)`、总输入 = 两者之和，
   * 两个公式在**三家逐字相同**，消费方不必也**不许**再按家分支（见 `usage-metrics.ts`）。
   * `timing`（时长 / 首字 / tok/s 的原料）**不在这一格里**：快照里也没有这一格，
   * 它今天只随 `usage` 事件进日志抽屉（口径与代价登记在 `MetricLine` 的文件头）。
   */
  tokens: { input: number; cached: number; output: number } | null;
  /**
   * **子智能体那一份**用量：`tokens` 是「主会话 + 全部子智能体」的合计，
   * 这一格是分量（卡片 Tooltip 据此拆两行）。`null` = 没有子智能体或没采到。
   * 冻结口径与 `tokens` **逐字相同**：候选阶段一结束就不再接受任何 `usage`。
   */
  subagentTokens: { input: number; cached: number; output: number } | null;
  /**
   * **子智能体那一份轮次**：`turns` 是「主会话 + 全部子智能体」的合计，
   * 这一格是分量（卡片「轮次」那一格的 Tooltip 据此拆两行）。`null` = 没有子智能体或没采到。
   * 三档语义与 `subagentTokens` **逐字相同**（显式 `null` 清、整格缺席才保持）；
   * 冻结口径与 `tokens` / `turns` 也**逐字相同**：候选阶段一结束就不再接受任何 `usage`。
   */
  subagentTurns: number | null;
  turns: number | null;
  /**
   * 卡片底部那一行**给人看的一句话**（判定见 `activityOf`）：`log.summary` 优先，其次是本身就人写的
   * 文本；null = 还没有可说的事 ⇒ 界面回落成状态文案。
   * **原始日志不在这里**：JSON 永远不会进这一格（它只是排障证据，在抽屉里逐字可见）。
   * 名字仍叫 `latestText` 而不是 `latestActivity`：它照旧是「最近一条文本」，只是**明确了哪一类文本
   * 才算数**（人话算、JSON 不算）。改名要同步 ui 的镜像类型与三处夹具，收益只是措辞，故留着。
   */
  latestText: string | null;
  /**
   * **候选阶段是否已经结束**（口径 5：收到 `judging` 或任何终态帧即为 true）。
   * 结束之后 `tokens` / `turns` 就**冻结**在候选那一段的读数上：评分智能体报的用量不属于候选，
   * 一律不再折进来（界面据此把那几格按「候选的值」渲染，见 `MetricLine`）。
   */
  candidateEnded: boolean;
  /**
   * 候选阶段结束的时刻（毫秒）；null = 还没结束，或结束那一帧的 `at` 解析不出来。
   * 与 `candidateEnded` **不是冗余**：时间戳解析不出来时阶段照样结束了（冻结必须生效），
   * 只是界面里「耗时」那一格得退回快照值——绝不拿 0 或 NaN 去冒充一个时刻。
   */
  candidateEndedAtMs: number | null;
}

/** 折叠游标：在上面那些字段之外多带一个「已处理到的 seq」用于丢弃旧帧 */
export interface RowLiveState extends RowLiveMetrics {
  lastSeq: number;
}

/** 折叠的起点（也是「新一轮」重置到的状态） */
export const LIVE_STATE_INIT: RowLiveState = {
  startedAtMs: null,
  tokens: null,
  subagentTokens: null,
  subagentTurns: null,
  turns: null,
  latestText: null,
  candidateEnded: false,
  candidateEndedAtMs: null,
  lastSeq: 0,
};

/**
 * 活动文本的**采样节奏**（毫秒）。
 * 写成可变对象是本仓的既有约定（同 `TEXT_API_RETRY` / `ROW_RETRY`）：用例把它调小以免每条用例
 * 真等一秒，而**产品默认值必须有独立用例钉住**、`afterEach` 必须还原（AGENTS.md）。
 * 为什么是 1s：卡片上那一行的动效是 1.8s 一轮的，文字跟着采样走完全够用，而重渲染因此被压到
 * 每秒最多一次（帧率再高也不变）——这是「日志帧不逐帧 setState」那条守卫的另一半。
 */
export const LIVE_TEXT_SAMPLE = { intervalMs: 1000 };

/**
 * 把一条事件折进游标：
 *   · `seq === 1` ⇒ **新一代**（编排层清过事件日志，见文件头口径 3），先归零再应用本帧；
 *   · `seq <= lastSeq` ⇒ 旧帧（重连重推的边界帧、乱序到达的旧事件），**原样返回**——
 *     不回退是这里唯一要守的性质：界面上的数字一旦掉下去，使用者只会以为采集坏了；
 *   · `status` ⇒ 三个落点：`running` 记**第一次**的开始时刻（重跑时先归零，所以不会沿用上一轮的时刻）；
 *     `judging` 与任何**终态**记「候选阶段到此结束」（口径 5，此后 `usage` 一律折不进来）；
 *     其余（`preparing` / `pending`）只推进游标——它们既不是开始也不是结束；
 *   · `usage` ⇒ 覆盖 tok/轮次（事件里的值已经是「到目前为止」的口径，这里**不再累加**）；
 *     唯一的例外是 `tokens: null`：那表示这一条事件没带计量（只报轮次），保留上一份而不是清空；
 *   · `log` ⇒ 更新 `latestText`：有 `summary` 就用它；没有摘要且文本是**机器形状**（JSON）、或者
 *     文本是空串时**保留上一句**——三档判据全部收在 `activityOf` 里（文件头口径 4）。
 *
 * 已知副作用（如实登记，与 `row-stream.ts` 口径 5 的登记同源）：`seq === 1` 的判据只看序号，
 * 所以**同一轮内**真的重复投递了 `seq === 1` 时，会多走一次归零（指标短暂回落到只有这一帧的效果）。
 * 服务端的口径是「按 seq 去重、不主动制造重复帧」，且每行一轮只会有一条 seq === 1 ⇒ 不会发生；
 * 换来的是「重跑一定被认出来」这条更重要的性质（漏判的代价是拿着上一轮的数字冒充新一轮）。
 */
export function stepLiveState(state: RowLiveState, event: AgentEvent): RowLiveState {
  const base = event.seq === 1 ? LIVE_STATE_INIT : state;
  if (event.seq !== 1 && event.seq <= base.lastSeq) return base;

  if (event.type === 'status') {
    if (event.status === 'running' && base.startedAtMs === null) {
      const parsed = Date.parse(event.at);
      // 时间戳解析不出来就不记（NaN 流进界面会渲染出「NaNs」），下一帧或快照会补上
      return { ...base, startedAtMs: Number.isFinite(parsed) ? parsed : null, lastSeq: event.seq };
    }
    /**
     * **候选阶段的结束点**（口径 5）：第一条 `judging` 或**终态**状态帧，只认第一条。
     * 终态也要认，不能只看 `judging`：候选失败的行过一会儿可能被「重新评分」，那时历史里
     * 第一条 `judging` 出现在几十分钟之后，拿它当结束点会把中间那段空档算进「候选耗时」。
     * `pending` / `preparing` **不算**：串行排队中的行先收到的是它们，认了就等于这一行还没跑就冻结。
     */
    if ((event.status === 'judging' || TERMINAL_ROW_STATUSES.includes(event.status)) && !base.candidateEnded) {
      const parsed = Date.parse(event.at);
      return {
        ...base,
        candidateEnded: true,
        candidateEndedAtMs: Number.isFinite(parsed) ? parsed : null,
        lastSeq: event.seq,
      };
    }
  }
  if (event.type === 'usage') {
    // 候选阶段结束之后的 `usage` 是**评分智能体**的（轮次从 1 重新数，token 是评审者自己的）：
    // 覆盖上去就等于把「候选跑了多少轮、多省」换成了「这把尺子多贵」（口径 5）
    if (base.candidateEnded) return { ...base, lastSeq: event.seq };
    /**
     * **带会话身份的 `usage` 不是行级读数**：
     * `turn.subagentId` **非空**的那一条报的是**那个子会话自己的**累计（历史上 claude 收尾为每个子会话
     * 逐轮发过这一批，已停发、`turn.subagentId` 恒为 `null`；今天**只有 dsh**会发它，
     * 见 `providers/dsh/events.ts`），而行级读数（卡片 / 抽屉事实条 / 快照）
     * 只认 `turn` 缺省 / 显式 `null` / `subagentId === null` 的那一条。
     *
     * 为什么必须在这一层挡：那一批会话尺度读数**排在主会话读数之后** ⇒ 不挡就会被当成
     * 「最新一条」整个覆盖上去。真机复算（run `155f7f1e` 的 claude 行）：评分期卡片 `tok` 显示 **16,335**
     * （子会话自己的累计 14738/13568/1597），而权威行值是 **34,101**；Tooltip 还写成
     * 「主会话 0/0/0 ｜ 子智能体 14738/13568/1597」。改前最后一条 `usage` 恒是主会话读数
     * （同 run 的 dsh 行最后一条是 `turn = { subagentId: null }`） ⇒ 这是本次新增的会话尺度事件带来的形状。
     *
     * 只推进游标：这一帧本身是有效的（`lastSeq` 不能倒，去重与续订都靠它），只是它不属于**这一行**。
     * 判据收敛成一处 `?? null`：`turn` 整格缺席与显式 `null` 在读侧是同一件事，
     * 而 `subagentId` 是 `string | null` ⇒ 三档主会话读数自然合流。
     */
    if ((event.turn?.subagentId ?? null) !== null) return { ...base, lastSeq: event.seq };
    // `tokens: null` = **这一条没带计量**（轮次每到一次新的模型往返就发一条，而 token 常常采不到），
    // 此时**保留上一份**：整条事件是覆盖语义，把 tokens 也覆盖成 null 会让界面上的 tok
    // 从有数掉回「采集中」——数字往回流比不显示更糟。`turns` 是必填的，直接覆盖。
    //
    // 子智能体那一份**刻意不写成 `?? base.subagentTokens`**（与编排层 `patchRow` 同一条规则）：
    // 它的三档是「缺席 / null / {0,0,0}」三件不同的事——显式 `null` 表示**有子智能体但读失败**
    //（那时同一条事件的 `tokens` 已退回主会话口径），必须**清掉**上一份；否则界面上会留下一个
    // 偏大的分量，`subagentTokens ≤ tokens` 这条不变量当场被破坏（主会话会算出负数）。
    // 只有 `undefined`（老日志里整格缺席）才保持上一份。两行看着像，语义相反，不许合并。
    // `subagentTurns`（轮次那一份）与 `subagentTokens` **逐字同一条规则**，理由也逐字相同：
    // 显式 `null` 清、整格缺席才保持（那时 `turns` 已退回主会话口径，「合计 − 分量」不许为负）。
    return {
      ...base,
      tokens: event.tokens ?? base.tokens,
      subagentTokens: event.subagentTokens === undefined ? base.subagentTokens : event.subagentTokens,
      subagentTurns: event.subagentTurns === undefined ? base.subagentTurns : event.subagentTurns,
      turns: event.turns,
      lastSeq: event.seq,
    };
  }
  if (event.type === 'log') {
    return { ...base, latestText: activityOf(event, base.latestText), lastSeq: event.seq };
  }
  return { ...base, lastSeq: event.seq };
}

/**
 * 一条 `log` 事件能给出什么**人话**（卡片底部那一行显示的就是它）：
 * · 有 `summary` ⇒ 用它——这是「具体消息」的唯一来源，例如 dsh 的
 * `tool/call` 信封 → 「调用工具 pwsh：npm run build-only」；
 * · 候选串（`summary` 或 `text`）是**机器负载**（见 `looksLikeMachinePayload`） ⇒ 不是消息，
 * **保留上一句**：原始负载是排障证据，把它滚到卡片上就是拿 JSON 冒充消息。
 * **摘要也要过这一关**：适配器会把模型的 JSON 评分结果原样压成一行摘要发下来（评分阶段正是这种
 * 形状），那一句同样不该滚到卡片上——判据只有这一份，两边各写一遍必然漂移；
 * · 其余情况（claude-code 的答复、codex 的增量、stderr 的 WARN）本身就是人写的，直接用。
 * 空串按「这一条没带内容」处理：界面上宁可停在上一条，也不要闪成一片空白
 * （`emit` 层已经不肯把 `''` 落成日志，这里不假设调用方一定干净）。
 */
export function activityOf(event: { text: string; summary?: string | undefined }, previous: string | null): string | null {
  const summary = event.summary;
  const candidate = (summary !== undefined && summary !== '' ? summary : event.text).trim();
  if (candidate === '' || looksLikeMachinePayload(candidate)) return previous;
  return candidate;
}

/**
 * 这一行是不是**机器负载**（厂商信封那类 JSON），而不是写给人看的一句话。
 *
 * 两步，顺序不能换：
 * 1. **整串**解析得动且是对象 / 数组 ⇒ 机器负载。`[{"type":"tool_use",…}]`（claude-code 的工具块）
 * 本身就是 JSON **数组**，先摘「前缀标签」会把这一整行摘空（第一版就是这么错的，
 * `row-live.test.tsx` 里那条「第一帧就是 JSON」当场变红）；
 * 2. 否则摘掉**前缀标签**再看——本仓转发出来的厂商信封长这样：
 * `[评分智能体] {"method":"session.event","params":{…}}`，只判整串开头会把它当人话放行
 *。标签的判据是**不含 `{` `}` `"`**：
 * 带了这三个字符的不是标签，而是 JSON 的一部分。
 * 解析不动时一律按**人话**处理：宁可显示一句奇怪的话，也不要静默丢掉一条消息
 * （`[WARN] 用量负载不完整` 就走这一支）。
 *
 * **导出**：活动行的打字档（`run-activity.ts`）也要过这一关——评分阶段的正文就是那坨
 * 评分结果 JSON（真机 `judge-messages.jsonl` 最后一条正是 `{"judgments":[…]}`），不过闸就会
 * 把它逐字滚到卡片上，而口径同 （判据只能有一份，两边各写一遍必然漂移）。
 */
export function looksLikeMachinePayload(text: string): boolean {
  if (isJsonContainer(text)) return true;
  const tag = /^\[[^\]{}"]*\]\s*/.exec(text);
  return tag !== null && isJsonContainer(text.slice(tag[0].length));
}

/** 这一段文本本身是不是一个 JSON 容器（对象 / 数组）；标量、纯文本、坏 JSON 都不算 */
function isJsonContainer(text: string): boolean {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null;
  } catch {
    return false;
  }
}

/** 折叠一段**历史**（首帧拉 `/log` 后用；之后每帧走增量的 `stepLiveState`） */
export function foldLiveMetrics(events: readonly AgentEvent[]): RowLiveState {
  return events.reduce(stepLiveState, LIVE_STATE_INIT);
}

/** 游标 → 界面要的那些字段（把内部游标挡住，ui 不可能依赖它） */
function toMetrics(state: RowLiveState): RowLiveMetrics {
  return {
    startedAtMs: state.startedAtMs,
    tokens: state.tokens,
    subagentTokens: state.subagentTokens,
    subagentTurns: state.subagentTurns,
    turns: state.turns,
    latestText: state.latestText,
    candidateEnded: state.candidateEnded,
    candidateEndedAtMs: state.candidateEndedAtMs,
  };
}

/**
 * 订阅若干行的实时叠加层，返回 `行 id → 字段`。
 * 只订阅传进来的行（调用方按快照里的在跑状态算），且每一行都是**一条独立连接**：
 *   首帧先拉该行的 `/log`（历史里已经有开始时刻、用量与最后一条输出），再按 `afterSeq=该行最后一条的 seq` 续订。
 * 读不到历史的那一行静默不订阅：界面退回快照值（缺的是「实时」，不是数据本身，不值得弹错）。
 *
 * 发布分两路（文件头口径 4）：那几个字段**变了就发**（它们是这一路的正事），
 * `latestText` 走 `LIVE_TEXT_SAMPLE` 的定时器采样发布——帧率再高，重渲染也只是每秒一次。
 */
export function useRunLiveMetrics(input: { runId: string; rowIds: readonly string[] }): Record<string, RowLiveMetrics> {
  const { runId } = input;
  // 数组每帧都是新引用，不能直接进依赖：拼成稳定的键，行集合不变就不重挂连接
  const rowKey = input.rowIds.join(',');
  const { mutate } = useSWRConfig();
  const [metrics, setMetrics] = useState<Record<string, RowLiveMetrics>>({});

  useEffect(() => {
    if (runId === '' || rowKey === '') {
      setMetrics({});
      return;
    }
    const rowIds = rowKey.split(',');
    let cancelled = false;
    const states = new Map<string, RowLiveState>();
    const sources = new Map<string, EventSource>();
    /**
     * 上一次**发布出去**的文本（行 id → 文本）：采样定时器据此判断有没有新东西。
     * 放在 effect 里而**不进 state**——它只服务于发布判定，界面不该看见第二份真相。
     */
    const publishedText = new Map<string, string | null>();
    // 行集合换了就清空旧值：留着已经不在订阅里的行，界面会拿旧指标当当前值
    setMetrics({});

    const publish = (): void => {
      if (cancelled) return;
      const snapshot = Object.fromEntries([...states].map(([rowId, state]) => [rowId, toMetrics(state)]));
      // 记下这一份里各行的文本：采样定时器靠它判断「有没有新东西」
      for (const [rowId, metrics] of Object.entries(snapshot)) publishedText.set(rowId, metrics.latestText);
      setMetrics(snapshot);
    };

    /**
     * 界面看得见的那几个字段是否一模一样（用来压掉与它们无关的帧引起的重渲染）。
     * 候选阶段的结束点（`candidateEnded` / `candidateEndedAtMs`）也在判据里：它一变，界面上的
     * 秒表就要停、措辞也要从「采集中」翻成「未采集」——那是一条必须立刻发布的边。
     * **文本故意不在这个判据里**：它要是进来了，一行几千条日志就会逐帧发布（每秒几十次重渲染）——
     * 文本有它自己的出口（下面那个采样定时器）。
     */
    const sameMetrics = (left: RowLiveMetrics, right: RowLiveMetrics): boolean => {
      const leftTokens = left.tokens;
      const rightTokens = right.tokens;
      const sameTokens =
        leftTokens === null || rightTokens === null
          ? leftTokens === rightTokens
          : leftTokens.input === rightTokens.input &&
            leftTokens.cached === rightTokens.cached &&
            leftTokens.output === rightTokens.output;
      /**
       * **子智能体那一份也在判据里**：漏掉它，一帧只改了分量的 `usage` 就被当成
       * 「什么都没变」丢掉——合计与轮次都没动，而卡片 Tooltip 本应换成新的分量，于是它会永远停在
       * 第一次的读数上（没有任何报错，只是数字不再更新）。判据与 `tokens` **逐字同一套**。
       */
      const leftSubagent = left.subagentTokens;
      const rightSubagent = right.subagentTokens;
      const sameSubagentTokens =
        leftSubagent === null || rightSubagent === null
          ? leftSubagent === rightSubagent
          : leftSubagent.input === rightSubagent.input &&
            leftSubagent.cached === rightSubagent.cached &&
            leftSubagent.output === rightSubagent.output;
      return (
        left.startedAtMs === right.startedAtMs &&
        left.turns === right.turns &&
        // 轮次那一份同理：它单独变（合计没动）时也必须发布，否则 Tooltip 停在第一次的读数上
        left.subagentTurns === right.subagentTurns &&
        left.candidateEnded === right.candidateEnded &&
        left.candidateEndedAtMs === right.candidateEndedAtMs &&
        sameTokens &&
        sameSubagentTokens
      );
    };

    /**
     * 一帧的处理：折叠 → （那几个字段变了才）发布 → 终态则关这一行的连接并刷一次快照。
     *
     * **只有那几个字段变了才立刻 setState**：真实一行会推来几千条 `log` / `diff-summary` 帧，
     * 逐帧发布等于每秒几十次整页重渲染（而它们一个字段都没改）——实测一条 4 分钟的 claude-code 行
     * 有 5500 条事件，其中 `usage` 只有 2 条。折叠本身仍然要跑（`lastSeq` 要推进）。
     * **文本这一路不在这里发布**：它由下面的采样定时器按固定节奏推出（文件头口径 4）。
     */
    const ingest = (rowId: string, event: AgentEvent): void => {
      const previous = states.get(rowId) ?? LIVE_STATE_INIT;
      const next = stepLiveState(previous, event);
      states.set(rowId, next);
      if (!sameMetrics(previous, next)) publish();
      if (!isTerminalEvent(event)) return;
      sources.get(rowId)?.close();
      sources.delete(rowId);
      void mutate(runKey(runId));
      void mutate(RUNS_KEY);
    };

    const connect = (rowId: string, afterSeq: number): void => {
      // 环境没有 EventSource（老浏览器 / 测试替身缺失）时不能抛：指标退回快照值即可
      if (typeof EventSource === 'undefined') return;
      const source = new EventSource(`${runRowUrl(runId, rowId, 'stream')}?afterSeq=${afterSeq}`);
      sources.set(rowId, source);
      const handleFrame = (event: MessageEvent): void => {
        const parsed = parseFrame(String(event.data));
        if (parsed !== null) ingest(rowId, parsed);
      };
      // api 发的是具名事件（`event: <type>`），必须按事件名订阅；无名帧留 onmessage 兜底。
      // `error` 与 useRowStream 同口径：它的 onerror 属性已经被占用，不进这张表（否则同一帧投递两次）
      for (const type of AGENT_EVENT_TYPES) {
        if (type === 'error') continue;
        source.addEventListener(type, handleFrame);
      }
      source.onmessage = handleFrame;
      // 服务端发的具名 error 帧走 onerror（带 data）；连接故障没有 data，两种形状分开处置
      source.onerror = (event: Event) => {
        const data = (event as MessageEvent).data;
        if (typeof data === 'string') handleFrame(event as MessageEvent);
      };
    };

    /**
     * 文本采样：帧只折进 `states`，**发布交给这里**（文件头口径 4）。
     * 只在真的有新文本时发布——一个正在跑但安静的行不该每秒把整页重渲染一次。
     * 与这一轮订阅同生共死：`clearInterval` 在 effect 的清理里（页面反复开关详情不该攒下定时器）。
     */
    const sampler = setInterval(() => {
      if (cancelled) return;
      const changed = [...states].some(([rowId, state]) => (publishedText.get(rowId) ?? null) !== state.latestText);
      if (changed) publish();
    }, LIVE_TEXT_SAMPLE.intervalMs);

    void (async () => {
      for (const rowId of rowIds) {
        if (rowId === '') continue;
        try {
          const history = await getJson<AgentEvent[]>(runRowUrl(runId, rowId, 'log'));
          if (cancelled) return;
          const state = foldLiveMetrics(history);
          states.set(rowId, state);
          publish();
          connect(rowId, state.lastSeq);
        } catch {
          // 这一行读不到历史：不订阅它（见函数头）。别行的订阅照常进行
        }
      }
    })();

    return () => {
      cancelled = true;
      clearInterval(sampler);
      for (const source of sources.values()) source.close();
      sources.clear();
    };
  }, [rowKey, runId, mutate]);

  return metrics;
}
