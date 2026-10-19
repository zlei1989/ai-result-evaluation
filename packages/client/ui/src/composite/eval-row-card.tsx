'use client';

/**
 * 单候选卡片：标题行（智能体 · 模型 · 思考强度） + 分支 + 计量 + 状态 + 按钮组。
 * **供应商不占标题行的位置**：名字与接口地址挂在**模型名**的浮层上，
 * 悬浮才出——供应商是「这个模型跑在哪个网关上」的补充信息，不是并排比较时要看的那一格。
 * 版面上的分隔靠卡片自己的标题栏与 `gap` 承担，**不额外插分隔线**：它的默认外边距是页面级的，
 * 塞进卡片里就得手调。
 * 四件必须显式表达的事：
 * 1. `queued` → 「串行排队中：前一行结束后自动开始」；
 * 2. `row.diff.truncated` → 「diff 已截断」（这一次的分是在不完整输入下得出的）；
 * 3. `capability.cancelMidTurn === false` → 按钮文案退化为「关闭运行时」；
 * 4. `row.error` → 错误码 + 可读原因，不能只留一个红色徽标。
 * 另加一条**不可撤销**的动作口径：终止该行前必须确认（它杀 agent 子进程）——
 * 与吸底栏的整轮终止同一套语义。
 *
 * 两个「重跑」按钮的可用面（判据在 contracts 里）：
 * · 「重新执行」（连候选 agent 带评分重跑）与「重新评分」的硬前提相同：
 * **不在跑 + 有可比基线 + 有已产出的改动**——也就是「这一行真的跑过一次、留下了产出」；
 * · **已经出分的行同样给**（晚间口径：「已出分、无报错时取消禁用」）。误点的代价
 * 改由二次确认承担（一个说清「候选会重跑」，一个说清「现有分数会被替换」）；
 * · 判据**不看**`error` / `error.stage`：失败发生在哪一段不再决定按钮能不能按。
 * 禁用时一律用浮层说清原因。
 *
 * **单行执行**：「只执行当前候选项，不要完成后重新执行下方已经执行过的
 * 候选项」。于是那个按钮的**可用面比上面宽一档**——判据换成 contracts 的 `canRunRow`（不在跑就放行，
 * **含一次都没跑过的行**），文案按行态分叉：
 * · 没跑过（`baselineCommit === ''` 或没有 diff） ⇒ 「**开始执行**」= 这一行的首跑；
 * · 跑过 ⇒ 「**重新执行**」= 整段重跑。
 * 为什么必须放开这一档：过去没跑过的行只能靠「开始」跑，而「开始」的语义是**所有可执行行**
 * （`isRunnableRow`）——想单独跑三行里的第二行时，它会顺带把上面失败过的行一起重跑一遍。
 * `canRetryRow` 因此只剩「这次是首跑还是重跑」这一个用途：它决定文案与确认框措辞，不再决定能不能按。
 *
 * **追问**（第二期）是这一组里唯一**不自己算判据**的按钮：它能不能按由服务端的可用性读侧给
 * （`followUpVerdict`）——七档拒绝里有一半的事实（工作区还在不在 / 用例还在不在 / 这一家的声明）
 * 在盘上与厂商声明上，浏览器一格都看不到。禁用时的浮层文案**直接用服务端那一句**
 * （`verdict.reason`，与真追问抛的 409 逐字相同），界面一个字都不自己编。
 * 判据还没读到（`undefined`）时**置灰并说清「读不到判据」**：猜「能追问」会让用户点下去才拿到 409。
 *
 * 禁用控件的原因一律走浮层（`Hint`），且触发点包在按钮**外面**：禁用按钮自己不触发鼠标事件，
 * 直接挂在它上面时真实浏览器里什么都不会出现——jsdom 的合成事件验不出这一条。
 *
 * 卡片底部还有一行**活动行**（`AgentActivityLine`）：跑动期显示智能体最近一条
 * 输出、文字上有一条周期性扫过的高光；终态整行消失。它是否出现**只由 `row.status` 决定**——
 * 拿不到实时值时显示回落文案，而不是整行消失（同 `MetricLine` 的 `live` 口径）。
 */
import { LoaderCircleIcon } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import {
  AGENT_LABELS,
  EFFORT_OFF,
  ROW_STATUS_LABELS,
  type EvalRow,
  type EvalRowStatus,
  type FollowUpVerdict,
  canRescoreRow,
  canRetryRow,
  canRunRow,
  isRunningRow,
} from '@aieval/contracts';
import { Alert, AlertTitle } from '../components/ui/alert';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { AgentActivityLine, type AgentActivity } from '../base/agent-activity-line';
import { ConfirmDialog } from '../base/confirm-dialog';
import { Hint, HintProvider } from '../base/hint';
import { MetricLine, type LiveMetricsView } from '../base/metric-line';

/** 该行智能体的能力元数据（来自注册表） */
export interface AgentCapabilityView {
  usage: boolean;
  cancelMidTurn: boolean;
}

export interface EvalRowCardProps {
  row: EvalRow;
  /** 排名徽标：只有 1..3 名才传（并列同名次由调用方算好） */
  rank?: number;
  /** 串行模式下等待中的行 */
  queued?: boolean;
  /** 不传按「都支持」处理 */
  capability?: AgentCapabilityView;
  /**
   * 跑动期的实时指标（来自 SSE 的叠加层，见 `MetricLine` 的 `live`）。
   * 透传即可：**「这一行是否在跑」由 `row.status` 决定**（不是由传没传 live 决定）——
   * 终态的行即使还带着一份实时值，也必须显示快照里的权威值。
   */
  live?: LiveMetricsView;
  /**
   * 跑动期的**实时活动内容**（来自 `useRunActivity` 的消息流折叠）：有正文在流时
   * 活动行逐字打字、换行清空重打；没有就回落到 `live.latestText` 那一档。
   * 与 `live` 同一条纪律：**透传即可**，「这一行是否在跑」由 `row.status` 决定。
   */
  activity?: AgentActivity | null;
  onAbort: () => void;
  onOpenLog: () => void;
  onOpenDiff: () => void;
  onOpenScore: () => void;
  onRescore: () => void;
  /** 重评请求在途：按钮转圈并禁用（避免连点两次） */
  rescorePending?: boolean;
  /**
   * 单行**执行**：只跑这一行（候选 agent + 评分整段），本轮其他行一律不动。
   * 界面文案按行态分叉：没跑过 = 「开始执行」、跑过 = 「重新执行」。
   * 与「重新评分」是**两个按钮**：前者要跑候选（分钟级），后者只重算评分（几十秒）——
   * 合成一个按钮会让用户按下去才知道跑的是哪一段。
   * 可用面由 contracts 的 `canRunRow` 决定（**不在跑就放行**，含一次都没跑过的行）；
   * `canRetryRow` 只决定文案（这次是重跑还是首跑）。
   */
  onRetry: () => void;
  retryPending?: boolean;
  /**
   * 追问（第二期）：接着这一行原来那段会话再补一句话。
   * **不传即不渲染这个按钮**（没有回调的按钮是一个点了没反应的按钮，比没有更糟）。
   * 它只负责**打开输入区**（真正的承诺在那一次发送上），故不需要二次确认。
   */
  onFollowUp?: () => void;
  /** 追问请求在途：按钮转圈并禁用（避免连点两次） */
  followUpPending?: boolean;
  /**
   * 这一行此刻能不能追问（服务端的可用性读侧给的那一条结论）。
   * `undefined` = **还没有这一行的判据**（未加载 / 读失败）⇒ 按钮置灰并如实说明；
   * 判据本身与文案都在契约的 `canFollowUpRow` 里，这里一个条件都不复算。
   */
  followUpVerdict?: FollowUpVerdict;
}

/** 缺省能力：按「都支持」处理——多给一个终止按钮，比无端禁用安全 */
const DEFAULT_CAPABILITY: AgentCapabilityView = { usage: true, cancelMidTurn: true };

/** 行状态 → 徽标配色：跑批色系与终态色系刻意分开（同色时只能逐字读才分得清） */
const STATUS_VARIANT: Record<EvalRowStatus, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  pending: 'outline',
  preparing: 'secondary',
  running: 'secondary',
  judging: 'secondary',
  judged: 'default',
  failed: 'destructive',
  'timed-out': 'destructive',
  canceled: 'outline',
  skipped: 'outline',
  interrupted: 'destructive',
};

/**
 * 「执行」这一格不可用的原因（只有一个否定面：这一行正在跑）。
 *
 * 「没基线 / 没产出」不再是否定面——它们恰恰是**首跑**的正常形态（判据见 `canRunRow`）。
 * 措辞与编排层 `retryRow` 里那一条 CONFLICT 同义（那边是「请先终止它，再执行」）：
 * 「界面说 A、服务端说 B」是漂移的老形状。
 *
 * 文案里点名的按钮必须是**界面上真的那颗**（「开始执行」/「终止」）：浮层让人「点「开始」」，
 * 而界面上没有叫「开始」的按钮，是最难自查的一种指错路。
 */
function runDisabledReason(row: EvalRow, running: boolean): string {
  if (running) return '这一行正在执行：等它收场，或先点「终止」';
  return '这一行此刻不能执行：请刷新后重试';
}

/**
 * 「重新评分」不可用的原因（与编排层的 `rescoreRefusal` **共享「在跑 / 没基线 / 没产出」那三条且同序**，
 * 文案**同义但不逐字**——服务端那句把状态放进 `ROW_STATUS_LABELS`，随「准备中 / 执行中 / 评分中」变；
 * 服务端另有界面看不见的 `settling` 一条）。判据**不看失败阶段**：已经出分的行、智能体阶段失败的
 * 行都可重评，因此这里只剩三条。
 */
function rescoreDisabledReason(row: EvalRow, running: boolean): string {
  if (running) return '这一行正在执行：等它收场，或先点「终止」';
  if (row.baselineCommit === '') return '这一行的工作区还没准备好：请先点「开始执行」跑一次';
  if (row.diff === null) return '这一行还没有跑过：没有可重新评分的变更';
  return '这一行还没完整跑过一次：请先点「开始执行」';
}

/** 在途按钮的内容：转圈图标 + 文案（可访问名只由文案构成，图标 aria-hidden） */
function ButtonContent({ busy, children }: { busy: boolean; children: ReactNode }): ReactNode {
  return (
    <>
      {busy ? <LoaderCircleIcon className="size-3 animate-spin" aria-hidden /> : null}
      {children}
    </>
  );
}

export function EvalRowCard({
  row,
  rank,
  queued = false,
  capability = DEFAULT_CAPABILITY,
  live,
  activity,
  onAbort,
  onOpenLog,
  onOpenDiff,
  onOpenScore,
  onRescore,
  rescorePending = false,
  onRetry,
  retryPending = false,
  onFollowUp,
  followUpPending = false,
  followUpVerdict,
}: EvalRowCardProps): ReactNode {
  const running = isRunningRow(row.status);
  // `row.diff === null` = 这一行还没有产出：点开只会拿到一个 CONFLICT，
  // 所以按钮禁用，并在浮层里说清原因——禁用而不解释等于一个坏掉的按钮。
  const hasDiff = row.diff !== null;
  const rescorable = canRescoreRow(row);
  const rescoreHint = rescorable ? undefined : rescoreDisabledReason(row, running);
  /**
   * 单行执行（内部名仍是 retry：`canRunRow` / 路由 `/retry` 都不动，改的只是**能不能按**与**叫什么**）。
   *   · 能不能按 = `canRunRow`（不在跑就放行，含一次都没跑过的行）；
   *   · 叫什么 = 「这一行跑过没有」——**与此刻在不在跑无关**：正在首跑的行（`preparing` / `running`）
   *     也该显示「重新执行」（它确实已经跑起来了），显示「开始执行」会让人以为还没开始。
   * 文案与确认框措辞都从这里派生：两处各写一份判据，必然出现「按钮写重新执行、确认框说首跑」这种漂移。
   */
  const runnable = canRunRow(row);
  const rerun = canRetryRow(row) || isRunningRow(row.status);
  const runLabel = rerun ? '重新执行' : '开始执行';
  const runHint = runnable ? undefined : runDisabledReason(row, running);
  /**
   * 追问这一格的三态：`ok`（能按）/ 不可行（原因来自服务端）/ **没有判据**（还没读到）。
   * 「没有判据」与「不可行」分开说：前者要用户刷新，后者要用户换一件事做（排队 / 重新执行）。
   */
  const followUpOk = followUpVerdict?.ok === true;
  const followUpHint = followUpVerdict === undefined
    ? '读不到这一行的追问判据（服务端没给出）：请刷新后重试'
    : followUpVerdict.ok
      ? undefined
      : followUpVerdict.reason;

  /** 当前打开的确认框：三个动作的代价各不相同，各自一段文案（不合并成一个「确定吗」） */
  const [confirm, setConfirm] = useState<'run' | 'rescore' | 'abort' | null>(null);

  return (
    <HintProvider>
      {/* `shrink-0`：卡片住在 `run-row-list` 的滚动容器里。默认的 `flex-shrink: 1` 会让 4 个候选
          在 800/768 高的窗口里被压到 116–124px（内容 144px），`overflow: hidden` 于是把
          六个行操作整排裁掉——候选再多也只会继续压，不会出滚动条。 */}
      <Card size="sm" data-testid="eval-row-card" className="shrink-0">
        <CardHeader>
          <CardTitle>
            <div className="flex flex-wrap items-center gap-2">
              {rank === undefined ? null : <Badge variant="secondary">第 {rank} 名</Badge>}
              {/**
               * **候选没答**：这一格与状态徽标并列显示，因为两者说的是**两件事** ——
               * 状态说的是「这一行怎么样了」，而这一格说的是「那次评分评的是一个**没答**的候选」。
               * 只显示前者，会把一次空答复显示得和正常一样（这正是这一格存在的理由）。
               *
               * 判据用 `=== true` 而不是真值判断：三态里**键缺席与 `null` 都是「未记录」**，
               * 它们不该显示成任何一个结论（旧数据属于这一档）。
               */}
              {row.emptyAnswer === true ? <Badge variant="destructive">候选未作答</Badge> : null}
              <span className="font-medium">{AGENT_LABELS[row.agentKind]}</span>
              <span className="text-muted-foreground">·</span>
              {/* 模型名 + 供应商浮层：供应商信息挂在这一格上、鼠标移入才浮出，
                  标题行因此不再有「供应商」徽标。为什么挂模型名而不是别处：名字与网关是同一件事的两半
                  （`deepseek-flash` 单独看不知道跑在哪个网关上），而接口地址太长，本来就只该按需显示。 */}
              <Hint label={`供应商：${row.providerName}（${row.baseUrl}）`}>
                <code className="text-xs">{row.modelId}</code>
              </Hint>
              {/* 思考强度：**只在行上真的写了档位时显示**（`row.effort`）——
                  「没说」与「说了 high」必须分得开（前者跟随适配器缺省，后者是这一行锁死的档）；
                  档位一律照上游的词汇原样显示（关闭档也写 `off`，不加工）。 */}
              {row.effort === undefined ? null : (
                <Hint label={row.effort === EFFORT_OFF ? '关闭思考' : `思考强度：${row.effort}`}>
                  <Badge variant="outline">{row.effort}</Badge>
                </Hint>
              )}
            </div>
          </CardTitle>
          <CardAction>
            <div className="flex flex-wrap items-center gap-1">
              {/* 「重试过」必须可见：瞬时失败是**自动重试**的，不标出来的话
                  「试了三次才成功」与「一次就成功」在卡片上长得一模一样 */}
              {row.attempts > 1 ? <Badge variant="secondary">已重试 {row.attempts - 1} 次</Badge> : null}
              {/* 「被人插过话」必须可见：判分照旧把那些消息当证据，而它与没插过话的轮次**不可直接比**。
                  计数读的是**行快照** `followUps`（不走事件流：列表视图的成本会随轮次数涨），而它由编排层在
                  落账本那一段同时加一 ⇒ N 与账本对齐（队列表里那些还没投递的不算）。
                  **文案是「人工消息」不是「追问」**：这一格数的是**总数**——运行中插进去的话与跑完之后
                  的追问都算。「追问」在术语里只指跑完之后另起一段那一支，写成「人工追问 ×N」会把
                  2 条注入 + 1 次追问读成被追问了 3 次。 */}
              {row.followUps > 0 ? (
                <Hint label="这一行被人工消息干预过：判分证据里含这几条人写的消息（运行中补的话与跑完之后的追问都算），产物与没有人工消息的候选不可直接比">
                  <Badge variant="secondary">人工消息 ×{row.followUps}</Badge>
                </Hint>
              ) : null}
              {row.diff?.truncated === true ? (
                // 截断是**可见的降级**：评分模型看到的也是截断后的那一份，
                // 所以这一格说的是「这一行的分只覆盖了前一部分变更」，不只是界面没显示全
                <Hint label="变更正文超过体积上限，只保留了头尾：评分模型读到的也是这一份，分不覆盖被丢弃的文件">
                  <Badge variant="outline">变更已截断</Badge>
                </Hint>
              ) : null}
              <Badge variant={STATUS_VARIANT[row.status]}>{ROW_STATUS_LABELS[row.status]}</Badge>
            </div>
          </CardAction>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          <div className="text-sm text-muted-foreground">
            分支 <code className="text-xs">{row.branch}</code>
          </div>
          <MetricLine
            tokens={row.tokens}
            // 子智能体那一份：契约里是可选格，老快照没有它就退回一行浮层
            subagentTokens={row.subagentTokens}
            // 轮次那一份同理（同一天追加）：少了这一行，卡片上的「轮次」浮层在任何一行都不出现，
            // 而 `tsc` 与其余用例全都照常通过（可选格）——`eval-row-card.test.tsx` 末尾那条
            // 透传守卫就是为它准备的
            subagentTurns={row.subagentTurns}
            turns={row.turns}
            durationMs={row.durationMs}
            score={row.score}
            usageUnsupported={!capability.usage}
            // 「在跑」由行状态决定，实时值只是运行期的叠加层（见 props 注释）
            running={running}
            live={live}
          />
          {queued && (
            <Alert>
              <AlertTitle>串行排队中：前一行结束后自动开始</AlertTitle>
            </Alert>
          )}
          {row.error !== null && (
            // 中文原因在前、归因码在前者之后：码是给 grep 用的（`docs/faq/` 按报错原文索引），
            // 但它回答不了「发生了什么」——两格都给，顺序按读者需要的先后来
            <Alert variant="destructive">
              <AlertTitle>{`${row.error.message}（${row.error.code}）`}</AlertTitle>
            </Alert>
          )}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={onOpenLog}>
                执行日志
              </Button>
              <Hint label={hasDiff ? undefined : '这一行还没有产出变更'}>
                <Button size="sm" variant="outline" disabled={!hasDiff} onClick={onOpenDiff}>
                  变更详情
                </Button>
              </Hint>
              {/* 按钮顺序是**用户指定的版面口径**：执行日志 / 变更详情 / 执行这一行 /
                  评分详情 / 重新评分。用例按可访问名查按钮、不按位置断言，故改顺序不会误报；
                  反过来，想再调顺序时请连这一行注释一起改——否则下一个人只能靠猜。
                  这一格（2026-09-29 口径修订）：**只跑当前候选项**——「重新执行」= 连候选 agent 一起
                  重跑、「开始执行」= 这一行的首跑（两者是同一条链路，只按行态换文案）。
                  与「重新评分」是**两件事、两笔成本**（分钟级 vs 几十秒），故不做成一个按钮。
                  可用面：`canRunRow`（不在跑就给，含没跑过的行）——误点的代价由各自的确认框拦一次，
                  不由判据替人说不。 */}
              <Hint label={runHint}>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={!runnable}
                  data-testid="retry-wrapper"
                  data-loading={retryPending ? 'true' : undefined}
                  onClick={() => setConfirm('run')}
                >
                  <ButtonContent busy={retryPending}>{runLabel}</ButtonContent>
                </Button>
              </Hint>
              <Button size="sm" variant="outline" disabled={row.score === null} onClick={onOpenScore}>
                评分详情
              </Button>
              {/* 重新评分只重跑评分步骤、不重跑候选 agent，但它会**替换掉现有的分数**：
                  故与「终止」同一套语义，先确认再动手。 */}
              <Hint label={rescoreHint}>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={!rescorable}
                  data-testid="rescore-wrapper"
                  data-loading={rescorePending ? 'true' : undefined}
                  onClick={() => setConfirm('rescore')}
                >
                  <ButtonContent busy={rescorePending}>重新评分</ButtonContent>
                </Button>
              </Hint>
              {/**
               * 追问（第二期）：排在两个「重跑」之后——它既不是重跑整行、也不是重算分，
               * 而是「接着原来那段会话再跑一段」，故自成一格。
               * **没有二次确认**：这一键只打开输入区，真正的承诺在那一句话发出去的时候
               * （输入框下面那行提示写明了代价）。给它加一道确认框只会让「打开输入区」也变成两步。
               * 没有 `onFollowUp` 就不渲染（同 `agent-log-layout` 的「不给 `retryNode` 就不渲染重试键」）。
               */}
              {onFollowUp === undefined ? null : (
                <Hint label={followUpHint}>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={!followUpOk}
                    data-testid="follow-up-wrapper"
                    data-loading={followUpPending ? 'true' : undefined}
                    onClick={onFollowUp}
                  >
                    <ButtonContent busy={followUpPending}>追问</ButtonContent>
                  </Button>
                </Hint>
              )}
            </div>
            {running && (
              // 「终止」杀的是 agent 子进程、不可撤销 ⇒ 与吸底栏的整轮终止**同一套语义**：
              // 先确认再动手。
              <Button
                size="sm"
                variant="destructive"
                data-testid="row-abort"
                onClick={() => setConfirm('abort')}
              >
                {capability.cancelMidTurn ? '终止' : '关闭运行时'}
              </Button>
            )}
          </div>
          {/* 卡片底部：跑动期的**活动行**（智能体最近一条输出 + 高光扫过）。
              钉在最底下是因为它是这一张卡片里唯一会自己动的东西——上面三行（分支 / 计量 / 按钮）
              都是稳定信息，把动效夹在中间会让每次重渲染都像「卡片在跳」。
              **是否显示由 `row.status` 决定**（不是由传没传 `live` 决定，与 `MetricLine` 的 `live` 同口径）：
              拿不到实时值（历史还没拉回来）时它显示回落文案，而不是整行消失。 */}
          <AgentActivityLine status={row.status} latestText={live?.latestText ?? null} activity={activity} />
        </CardContent>
      </Card>

      <ConfirmDialog
        open={confirm === 'run'}
        onOpenChange={(next) => setConfirm(next ? 'run' : null)}
        title={rerun ? '重新执行这一行？' : '开始执行这一行？'}
        description={
          rerun
            ? '智能体与评分都会重跑：工作区会被重新准备，现有分数会被新的评分结果替换。只跑这一行，这次评测的其他候选不动。'
            : '只跑这一个候选：这次评测的其他候选（含已经执行过的）都不会重跑。'
        }
        confirmLabel={rerun ? '重新执行' : '开始执行'}
        onConfirm={onRetry}
        testId="row-run-confirm"
      />
      <ConfirmDialog
        open={confirm === 'rescore'}
        onOpenChange={(next) => setConfirm(next ? 'rescore' : null)}
        title="重新评分这一行？"
        description="只重跑评分步骤，智能体不会再跑；现有的分数会被新的评分结果替换。"
        confirmLabel="重新评分"
        onConfirm={onRescore}
        testId="row-rescore-confirm"
      />
      <ConfirmDialog
        open={confirm === 'abort'}
        onOpenChange={(next) => setConfirm(next ? 'abort' : null)}
        title="终止这一行？"
        description="正在跑的智能体子进程会被杀掉，这一行就此收场，且不可撤销。"
        confirmLabel="终止"
        destructive
        onConfirm={onAbort}
        testId="row-abort-confirm"
      />
    </HintProvider>
  );
}
