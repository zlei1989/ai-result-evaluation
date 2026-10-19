'use client';

/**
 * 评测详情面板：顶部信息卡（串行进度在卡内底部）+ 候选卡片列表 + 吸底操作栏。
 *
 * 顶部信息**与用例详情同构**：卡片标题 = 用例标题，正文是「标签 : 值」的字段表；备注非空时
 * 多一行「备注」（唯一一格用户注解）。值一律给**全量**——详情栏是核对「这一轮跑的到底是哪份代码」
 * 的地方，短哈希 / 省略号在这里就等于没地方能看全（与 `case-detail-panel.tsx` 的口径同源）。
 *
 * 五条口径：
 *   1. 「开始」必须先确认并**列出本次将执行的候选清单**——
 *      误点一次要烧掉几十分钟的额度与时间，确认框是这里唯一的安全带；
 *   2. 「终止」用确认语义（它杀进程、不可撤销）；单行的终止在卡片上，同一套语义；
 *   3. 排序与排名**共用同一份判据**（`compareRows`）：总分降序 → 耗时升序 →
 *      tok（输入+输出）升序；三项全同才算并列（同名次，不硬拆成 1、2 名）。未出分的行排在最后、
 *      不参与排名，只有 1..3 名带徽标；未采集的耗时/tok 按最差算（见 `compareRows` 的注释）；
 *   4. 吸底栏把上边距补成 `PANE_PADDING`、下边留 0——下边那 16px 由 `ListDetailLayout` 详情槽
 *      自己的 padding 提供，于是「分隔线→内容」与「内容→栏底」都是 8px；左右为 0，与卡片那一列对齐；
 *   5. 「编辑 / 删除」两个入口放在**顶部信息卡的右上角**，与 `case-detail-panel.tsx` 同形；
 *      两者都只在**没有行在运行**时可用——判据是 contracts 的 `hasLiveRows`，与服务端抛 409
 *      的那一条同源。禁用原因走浮层，浮层的触发点包在按钮外面（禁用按钮自己不触发鼠标事件）。
 *
 * 两条读数口径（都不猜）：
 *   · **进度与状态全部来自快照**（`row.status` / `run.executionMode`）：不用「有没有分数」这类
 *     前端推断去判断终态——那正是「把旧数据渲染成新数据」的形状；
 *   · 串行进度的分子是 **`TERMINAL_ROW_STATUSES` 的行数**，不是「已评分」的行数。
 */
import { useState, type ReactNode } from 'react';
import {
  AGENT_LABELS,
  TERMINAL_ROW_STATUSES,
  type AgentKind,
  type EvalRow,
  type EvalRun,
  type FollowUpVerdict,
  hasLiveRows,
  isNoneSource,
  isRunnableRow,
  isRunningRow,
} from '@aieval/contracts';
import { XIcon } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '../components/ui/alert';
import { Button } from '../components/ui/button';
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Progress } from '../components/ui/progress';
import { PANE_PADDING } from '../base/pane-metrics';
import type { LiveMetricsView } from '../base/metric-line';
import type { AgentActivity } from '../base/agent-activity-line';
import { ConfirmDialog } from '../base/confirm-dialog';
import { Hint, HintProvider } from '../base/hint';
import { EvalRowCard, type AgentCapabilityView } from './eval-row-card';

export interface RunDetailPanelProps {
  run: EvalRun;
  starting: boolean;
  aborting: boolean;
  /** 每行智能体的能力元数据（usage / cancelMidTurn）；不传按「都支持」处理 */
  capabilityOf?: (agentKind: AgentKind) => AgentCapabilityView;
  /**
   * 每行的**实时指标**（跑动期的叠加层）；不传即没有实时通道，卡片显示快照值。
   * 由调用方提供而不是本组件自己订阅：ui 层不许 import 数据层（`@aieval/client`），
   * 而「哪些行要订阅」是页面的事（只有在这一屏里、且正在跑的行才值得开连接）。
   */
  liveOf?: (rowId: string) => LiveMetricsView | undefined;
  /**
   * 每行的**实时活动内容**：与 `liveOf` 并列的第二路（`useRunActivity` 折 AgentMessage）。
   * 由调用方提供是同一个理由：ui 层不许 import 数据层，而「哪些行要订阅」是页面的事。
   */
  activityOf?: (rowId: string) => AgentActivity | undefined;
  onStart: () => void;
  onAbortRun: () => void;
  onAbortRow: (rowId: string) => void;
  onRescoreRow: (rowId: string) => void;
  /** 重评请求在途：透给卡片做转圈与禁用（避免连点两次） */
  rescoring: boolean;
  /** 单行**执行**：只跑这一行（候选 agent + 评分），本轮其他行不动；文案见行卡片（「开始执行 / 重新执行」） */
  onRetryRow: (rowId: string) => void;
  /** 单行执行请求在途：同上，只用于转圈与禁用 */
  retrying: boolean;
  /**
   * 这一行此刻能不能**追问**（第二期：接着原来那段会话再补一句话）。
   * 由调用方（页面）从服务端的可用性读侧取——判据里有一半的事实在盘上与厂商声明上，
   * 浏览器一格都看不到，故 ui 层不复算也不编文案。**不传即不渲染那个按钮**。
   */
  onFollowUpRow?: (rowId: string) => void;
  /** 追问判据：按行取；`undefined` = 还没有这一行的结论（未加载 / 读失败） */
  followUpOf?: (rowId: string) => FollowUpVerdict | undefined;
  /** 追问请求在途：透给卡片做转圈与禁用 */
  followingUp?: boolean;
  onOpenLog: (rowId: string) => void;
  onOpenDiff: (rowId: string) => void;
  onOpenScore: (rowId: string) => void;
  /**
   * 打开「排名」抽屉（比的是候选之间的名次，**不带行 id**）。
   * 与上面三个读单行产物的入口并列，但它是**整轮**的视角。
   */
  onOpenRank: () => void;
  /** 打开编辑表单（右栏切到 edit） */
  onEdit: () => void;
  /**
   * 关闭右栏（回到单栏列表）。
   *
   * 桌面双栏下这是右栏**唯一**的关闭入口：退回列表只能点顶栏「评测」、而那会丢掉这一页的
   * 查询参数与滚动位置；窄屏由 `Sheet` 头部的关闭键承担，这一格可以不传。
   */
  onClose?: () => void;
  /**
   * 删除这一轮。**可以返回在途请求的 promise**：确认框只在它落定后才关闭，
   * 否则用户看到的是「点一下没反应」，再点一次就是第二次 DELETE。
   */
  onDelete: () => void | Promise<unknown>;
  /** 删除请求在途：给确认按钮上在途态，避免重复点 */
  deleting?: boolean;
}

/**
 * 只有 1..3 名带徽标。并列时两行同名次，故这里没有「名次唯一」的假设。
 * 导出它而不是在测试里抄一份 3：改阈值时用例必须跟着显式改。
 */
export const RANK_BADGE_LIMIT = 3;

/**
 * 串行进度百分比：`total <= 0` 时返回 **0**，绝不让除零的 `NaN` 流进界面。
 * 单独抽成纯函数是因为它必须能被**直接**测到：进度条只吃数字、不产生可断言的文案，
 * 留在组件里就只能靠间接断言——「零行时不出现 NaN」这条会退化成一条谁也测不到的注释。
 */
export function completionPercent(done: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((done / total) * 100);
}

/**
 * 排序与名次的**唯一判据**：总分降序 → 耗时升序 → tok 升序；
 * 三项全同才返回 `0`（= 并列）。
 *
 * 为什么必须收敛成**一个**函数：展示顺序与名次徽标都从它派生，两处各写一份判据的漂移形状是
 * 「排在第 2 张的卡片挂着第 1 名」——那种错在界面上看起来完全像是数据有问题，而不是判据有分歧。
 *
 * 两条口径（都说的是「不知道 ≠ 更好」）：
 *   · **未采集（`null`）在它参与的那一项上按最差算**（`Infinity`）：有数的一方胜出，
 *     两边都没采到才算相等。把 `null` 当相等或当 0，都是在让「没采到」白捡一个更好的名次；
 *   · tok 只算**输入 + 输出**，与卡片上显示的那个数同源（缓存读单列在「缓存命中」里；
 *     三元组相加会把缓存读重复计一遍，见 `metric-line.tsx`）。
 *
 * 比较一律走 `!==` 分支而**不做减法**：两边都「最差」时 `Infinity - Infinity` 是 `NaN`，
 * 而 `NaN !== 0` 会让它冒充「不相等」——并列就被拆成了随机的先后。
 */
export function compareRows(a: EvalRow, b: EvalRow): number {
  // 未出分兜底成 -Infinity：本面板只拿它比出分的行（调用处先过滤），但它是导出的判据，
  // 别处直接拿去排全量时也不会把没分的行顶到最前面
  const scoreA = a.score === null ? Number.NEGATIVE_INFINITY : a.score.totalScore;
  const scoreB = b.score === null ? Number.NEGATIVE_INFINITY : b.score.totalScore;
  if (scoreA !== scoreB) return scoreA > scoreB ? -1 : 1;

  const durationA = a.durationMs ?? Number.POSITIVE_INFINITY;
  const durationB = b.durationMs ?? Number.POSITIVE_INFINITY;
  if (durationA !== durationB) return durationA < durationB ? -1 : 1;

  const tokensA = totalTokens(a);
  const tokensB = totalTokens(b);
  if (tokensA !== tokensB) return tokensA < tokensB ? -1 : 1;

  return 0;
}

/**
 * 卡片上那个 tok 数：输入 + 输出（缓存读不计入）；未采集按最差算。
 *
 * ⚠️ 这个加法**跨三家口径一致**，前提是契约把 `input` 定义成**非缓存输入**
 * （归一化时 codex 侧做过 `input_tokens − cached_input_tokens`，claude / dsh 原文就不含 cache）
 * ⇒ `input` / `cached` / `output` 三者互斥，`input + output` 不会双计。改契约那一格时必须回来看这里。
 */
function totalTokens(row: EvalRow): number {
  if (row.tokens === null) return Number.POSITIVE_INFINITY;
  return row.tokens.input + row.tokens.output;
}

/**
 * 名次 = 1 + 按同一判据**严格优于**它的行数；三项全同 ⇒ 同名次（并列）；没有分的行不给名次。
 *
 * 导出它（而不是留在组件里）是因为**排名抽屉**要拿同一份名次去排它的列：名次在本仓只有一个判据，
 * 两处各算一次的形状是「卡片挂第 1 名、抽屉里排第 2」——那种错看起来像数据坏了，而不是判据分叉。
 * 入参是**全量行**（含未出分的），未出分的行既不给自己名次、也不让别人多一名。
 */
export function rankOf(rows: EvalRow[], row: EvalRow): number | undefined {
  if (row.score === null) return undefined;
  let better = 0;
  for (const other of rows) {
    // 未出分的行不参与排名：它们在列表里垫底，但不算「优于」任何一行
    if (other.score === null) continue;
    if (compareRows(other, row) < 0) better += 1;
  }
  return better + 1;
}

/** 展示顺序：有分的按同一判据在前（全同时 `sort` 稳定，保持创建顺序），其余保持原始顺序 */
export function orderForDisplay(rows: EvalRow[]): EvalRow[] {
  const scored = rows.filter((row) => row.score !== null).sort(compareRows);
  const rest = rows.filter((row) => row.score === null);
  return [...scored, ...rest];
}

/** 缺省能力：按「都支持」处理（与 `EvalRowCard` 的缺省一致） */
const OPTIMISTIC_CAPABILITY: AgentCapabilityView = { usage: true, cancelMidTurn: true };

/** 顶部信息卡的一格：`label` 与值分两列渲染（与用例详情同构） */
interface HeaderField {
  key: string;
  label: string;
  children: ReactNode;
}

export function RunDetailPanel({
  run,
  starting,
  aborting,
  capabilityOf,
  liveOf,
  activityOf,
  onStart,
  onAbortRun,
  onAbortRow,
  onRescoreRow,
  rescoring,
  onRetryRow,
  retrying,
  onFollowUpRow,
  followUpOf,
  followingUp = false,
  onOpenLog,
  onOpenDiff,
  onOpenScore,
  onOpenRank,
  onEdit,
  onClose,
  onDelete,
  deleting = false,
}: RunDetailPanelProps): ReactNode {
  const runnable = run.rows.filter((row) => isRunnableRow(row.status));
  const hasRunning = run.rows.some((row) => isRunningRow(row.status));
  // 分子是终态行数：失败/超时/终止/跳过/被打断都是「跑完了」，不把它们算进去进度永远到不了 100%
  const done = run.rows.filter((row) => TERMINAL_ROW_STATUSES.includes(row.status)).length;
  const total = run.rows.length;
  const serial = run.executionMode === 'serial';
  const percent = completionPercent(done, total);

  /**
   * 「能不能改 / 能不能删」：只有一条判据（`hasLiveRows`），由服务端同一份函数抛 409。
   * 有行在跑时两个入口一律禁用；**原因只在「编辑」那一格有浮层**——「删除」被自己的禁用态挡住，
   * 正在跑的行有自己的生命周期，处置是「先终止」。
   */
  const live = hasLiveRows(run);
  const mutateDisabledReason = live ? '有候选行正在运行：先终止，再编辑 / 删除' : undefined;

  /**
   * 「排名」能不能点：**至少要有一行出了分**——没有分就没有名次，抽屉会是一张只有行标签的空表。
   * 判据落在「有没有分」而不是「跑完没有」：跑到一半也能看此刻的名次（那是调试用例时最想看的），
   * 而**部分失败**的轮次里「所有候选都评分完成」这个条件可能永远不成立，按钮会等于永久消失。
   */
  const rankDisabled = run.rows.every((row) => row.score === null);
  const rankDisabledReason = rankDisabled ? '还没有出分的候选：评分完成后才能排名' : undefined;

  const startDisabled = starting || hasRunning || runnable.length === 0;
  const startDisabledReason = hasRunning
    ? '有候选正在执行：等它收场，或先点「终止」'
    : runnable.length === 0
      ? '没有要执行的候选：这一次评测的候选都已评分'
      : undefined;

  /** 确认框由组件自持：三个动作各自一段文案，「开始」那一支还要列出候选清单 */
  const [confirm, setConfirm] = useState<'start' | 'abort' | 'delete' | null>(null);

  /**
   * 顶部信息卡的字段表（与 `case-detail-panel.tsx` 同构，只有字段集不同）：
   *   · **备注只在非空时出现**，且排第一行：它回答「这一轮为什么这么测」，紧跟卡片标题读起来
   *     才像一句副题；空备注摆一行「备注：—」等于凭空多一个让人去猜「为什么是空的」的字段；
   *   · **分支只在远端轮次出现**（`repoBranch !== null`）：本地轮次 / 旧数据渲染出的字段不变；
   *   · commit 给**全量** 40 位：右栏是核对「这一轮测的到底是哪个提交」的地方；
   *   · 仓库路径与工作基目录同样给全量，靠换行而不是省略（右栏可能只有 320px）。
   */
  const headerFields: HeaderField[] = [
    ...(run.note.trim() === ''
      ? []
      : [
        {
          key: 'note',
          label: '备注',
          children: <span>{run.note.trim()}</span>,
        },
      ]),
    {
      key: 'repoPath',
      label: '代码仓库',
      // 无来源显示短标签「无」，哨兵串 `none://` 不是给用户看的信息，说全的话放浮层里
      children: isNoneSource(run.repoPath) ? (
        <Hint label="空仓库，无来源代码">
          <code className="text-xs">无</code>
        </Hint>
      ) : (
        <code className="text-xs break-all">{run.repoPath}</code>
      ),
    },
    ...(run.repoBranch === null
      ? []
      : [
        {
          key: 'repoBranch',
          label: '分支',
          children: <code className="text-xs break-all">{run.repoBranch}</code>,
        },
      ]),
    {
      key: 'commitHash',
      label: '基线提交',
      children:
        run.commitHash === null ? (
          <span className="text-muted-foreground">默认分支 HEAD</span>
        ) : (
          <code className="text-xs break-all">{run.commitHash}</code>
        ),
    },
    {
      key: 'workspaceBase',
      label: '工作区根目录',
      children: <code className="text-xs break-all">{run.workspaceBase}</code>,
    },
  ];

  return (
    <HintProvider>
      <div className="flex h-full min-h-0 flex-col gap-2">
        {/* 顶部信息卡：用例标题 +（备注非空才有）备注 / 代码仓库 /（远端才有）分支 / 基线提交 / 工作区根目录 */}
        <Card size="sm" data-testid="run-header">
          <CardHeader>
            <CardTitle>{run.caseTitle}</CardTitle>
            <CardAction>
              <div className="flex gap-2">
                <Hint label={mutateDisabledReason}>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={live}
                    data-testid="run-detail-edit"
                    onClick={onEdit}
                  >
                    编辑
                  </Button>
                </Hint>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={live}
                  data-testid="run-detail-delete"
                  onClick={() => setConfirm('delete')}
                >
                  删除
                </Button>
                {onClose === undefined ? null : (
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    // 窄屏时右栏整体搬进 Sheet，Sheet 头部已有自己的关闭键；这一格再画一个就是两个 X。
                    // 用祖先属性判据而不是「页面上有没有 Sheet」：两处渲染走的是同一棵组件树。
                    className="in-data-[slot=sheet-content]:hidden"
                    aria-label="关闭详情"
                    data-testid="run-detail-close"
                    onClick={onClose}
                  >
                    <XIcon aria-hidden />
                  </Button>
                )}
              </div>
            </CardAction>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
              {headerFields.map((field) => (
                <div key={field.key} className="col-span-2 grid grid-cols-subgrid">
                  <dt className="text-muted-foreground">{field.label}</dt>
                  <dd className="min-w-0">{field.children}</dd>
                </div>
              ))}
            </dl>
            {/**
             * **可比性提示**（与开关那一格同源）：开着输入区的一轮里，人在半路补的话**照旧进评分证据**
             * ⇒ 它的产物与没插过话的轮次不可直接比。提示放在这里而不是只放卡片上：
             * 评分的证据面在轮次这一层，而候选卡片可能不在视野里（列表要滚动）——
             * 不提示就等于让分数静默地换了口径。
             */}
            {run.injectMessages ? (
              <Alert>
                <AlertTitle>这一次评测开着人工消息</AlertTitle>
                <AlertDescription>
                  运行中补的话会进智能体的上下文，也算进评分证据——所以这一次评测的产物与没被插过话的评测不可直接比。候选卡片上的「人工消息 ×N」是实际送达的条数（运行中补的话与跑完之后的追问都算）。
                </AlertDescription>
              </Alert>
            ) : null}
            {/* 串行进度钉在信息卡**内部底部**：它读的是「整轮跑完了几行」，
                与上面这组「这一轮跑的到底是哪份代码」属于同一块元信息；浮在卡片外面时，
                它悬在卡片与候选列表之间，看着像下面那串候选卡片的表头。 */}
            {serial && (
              <div className="mt-1 flex items-center gap-2" data-testid="run-progress">
                <Progress value={percent} aria-label="串行进度" className="w-full flex-1" />
                <span className="shrink-0 text-xs text-muted-foreground">
                  {done}/{total} 已完成
                </span>
              </div>
            )}
          </CardContent>
        </Card>

        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto" data-testid="run-row-list">
          {orderForDisplay(run.rows).map((row) => {
            const rank = rankOf(run.rows, row);
            return (
              <EvalRowCard
                key={row.id}
                row={row}
                rank={rank !== undefined && rank <= RANK_BADGE_LIMIT ? rank : undefined}
                queued={serial && row.status === 'pending'}
                capability={capabilityOf === undefined ? OPTIMISTIC_CAPABILITY : capabilityOf(row.agentKind)}
                live={liveOf?.(row.id)}
                activity={activityOf?.(row.id)}
                onAbort={() => onAbortRow(row.id)}
                onRescore={() => onRescoreRow(row.id)}
                rescorePending={rescoring}
                onRetry={() => onRetryRow(row.id)}
                retryPending={retrying}
                // 没有回调就不传（卡片据此不渲染那个按钮）：一个点了没反应的按钮比没有按钮更糟
                {...(onFollowUpRow === undefined ? {} : { onFollowUp: () => onFollowUpRow(row.id) })}
                {...(followUpOf === undefined ? {} : { followUpVerdict: followUpOf(row.id) })}
                followUpPending={followingUp}
                onOpenLog={() => onOpenLog(row.id)}
                onOpenDiff={() => onOpenDiff(row.id)}
                onOpenScore={() => onOpenScore(row.id)}
              />
            );
          })}
        </div>

        <footer
          data-testid="run-footer"
          className="sticky bottom-0 border-t"
          style={{ padding: `${PANE_PADDING}px 0 0`, background: 'var(--card)' }}
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              {/* 状态点：有行在跑是实心主色 + 呼吸，全部收场是灰点（颜色不承担全部信息：旁边的文案同时说模式与行数） */}
              <span
                data-testid="run-running-dot"
                aria-hidden
                className={
                  hasRunning
                    ? 'inline-block size-2 animate-pulse rounded-full bg-primary'
                    : 'inline-block size-2 rounded-full bg-muted-foreground/40'
                }
              />
              {/* 执行模式只读展示：**本面板不提供切换入口**（执行模式随评测落库、运行中不可改） */}
              <span className="text-xs text-muted-foreground">
                {serial ? '串行' : '并行'} · 共 {total} 个候选
              </span>
            </div>
            <div className="flex gap-2">
              <Hint label={startDisabledReason}>
                <Button
                  size="sm"
                  disabled={startDisabled}
                  data-loading={starting ? 'true' : undefined}
                  onClick={() => setConfirm('start')}
                >
                  {starting ? <BusyDot busy /> : null}
                  开始执行
                </Button>
              </Hint>
              <Button
                size="sm"
                variant="destructive"
                data-loading={aborting ? 'true' : undefined}
                disabled={aborting || !hasRunning}
                onClick={() => setConfirm('abort')}
              >
                {aborting ? <BusyDot busy /> : null}
                终止
              </Button>
              {/* 「排名」常驻在「开始 / 终止」之后（边界置灰而不是隐藏：会自己冒出来的按钮，
                  用户得先知道它存在）。禁用时**必须**挂浮层说明条件——这个按钮是新面孔，
                  不像「终止」那样一看就懂，而「点了没反应」是最难自查的一种静默。 */}
              <Hint label={rankDisabledReason}>
                <Button size="sm" variant="outline" disabled={rankDisabled} onClick={onOpenRank}>
                  排名
                </Button>
              </Hint>
            </div>
          </div>
        </footer>

        <ConfirmDialog
          open={confirm === 'start'}
          onOpenChange={(next) => setConfirm(next ? 'start' : null)}
          title="开始执行这次评测？"
          description={`执行模式：${serial ? '串行（一行跑完含评分，才起下一行）' : '并行（全部同时开跑）'}`}
          confirmLabel="开始执行"
          onConfirm={onStart}
          testId="run-start-confirm"
        >
          <div className="flex flex-col gap-1 text-sm">
            <span>本次将执行 {runnable.length} 个候选：</span>
            <ul className="flex flex-col gap-0.5">
              {runnable.map((row) => (
                <li key={row.id} className="text-muted-foreground">
                  · {AGENT_LABELS[row.agentKind]} · {row.modelId}
                </li>
              ))}
            </ul>
          </div>
        </ConfirmDialog>
        <ConfirmDialog
          open={confirm === 'abort'}
          onOpenChange={(next) => setConfirm(next ? 'abort' : null)}
          title="终止这次评测？"
          description="正在跑的智能体子进程会被杀掉，这些候选就此收场，且不可撤销。"
          confirmLabel="终止"
          destructive
          onConfirm={onAbortRun}
          testId="run-abort-confirm"
        />
        <ConfirmDialog
          open={confirm === 'delete'}
          onOpenChange={(next) => setConfirm(next ? 'delete' : null)}
          title="删除这次评测？"
          description="这一次评测的全部候选工作区与执行日志会一起删掉，不可恢复。"
          confirmLabel="删除这次评测"
          destructive
          onConfirm={onDelete}
          testId="run-delete-confirm"
        />
      </div>
    </HintProvider>
  );
}

/** 在途态的小转圈：附在吸底栏按钮的文案前（可访问名仍只由文案构成） */
function BusyDot({ busy }: { busy: boolean }): ReactNode {
  return busy ? <span className="inline-block size-2 animate-spin rounded-full border border-current border-t-transparent" aria-hidden /> : null;
}
