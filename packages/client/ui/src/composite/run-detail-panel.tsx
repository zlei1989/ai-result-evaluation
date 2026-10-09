'use client';

/**
 * 评测详情面板：顶部信息卡（串行进度在卡内底部）+ 候选卡片列表 + 吸底操作栏。
 *
 * 顶部信息**与用例详情同构**（用户口径 2026-09-28）：`Card` 标题 = 用例标题，正文是
 * `Descriptions` 的「标签 : 值」。值一律给**全量**——详情栏是核对「这一轮跑的到底是哪份代码」
 * 的地方，短哈希 / 省略号在这里就等于没地方能看全（与 `case-detail-panel.tsx` 的口径 1 同源）。
 *
 * 四条口径：
 *   1. 「开始」必须先 `Modal.confirm` 列出本次将执行的候选清单（spec §5.3）——
 *      误点一次要烧掉几十分钟的额度与时间，确认框是这里唯一的安全带；
 *   2. 「终止」用 `Popconfirm`（它杀进程、不可撤销）；单行的终止在卡片上，同一套语义；
 *   3. 排序与排名**共用同一份判据**（`compareRows`，用户口径 2026-09-29）：总分降序 → 耗时升序 →
 *      tok（输入+输出）升序；三项全同才算并列（同名次，不硬拆成 1、2 名）。未出分的行排在最后、
 *      不参与排名，只有 1..3 名带徽标；未采集的耗时/tok 按最差算（见 `compareRows` 的注释）；
 *   4. 吸底栏用 `Layout.Footer` 但把它的默认内边距清零——那是页面级的 24/50，
 *      放进右栏会把卡片顶出视口；间距交给 `Flex` 的 `gap`（见计划「修正 8」）。
 *      2026-10-07 用户口径（「视觉上下边距一样宽」）在这一条上追加半句：清零之后**上边补回
 *      `PANE_PADDING`**（下边那 8px 是 `ListDetailLayout` 详情槽自己的 padding，不归本组件），
 *      于是「分隔线→内容」与「内容→栏底」都是 8px；左右仍为 0。
 *
 * 第五条口径（2026-09-28）：「编辑 / 删除」两个入口放在**顶部信息卡的 `extra`** 上，
 * 与 `case-detail-panel.tsx` 逐字同形（同一个位置、同一套 Popconfirm 语义）；两者都只在
 * **没有行在运行**时可用——判据是 contracts 的 `hasLiveRows`，与服务端抛 409 的那一条同源。
 *
 * 两条读数口径（都不猜）：
 *   · **进度与状态全部来自快照**（`row.status` / `run.executionMode`）：不用「有没有分数」这类
 *     前端推断去判断终态——那正是「把旧数据渲染成新数据」的形状；
 *   · 串行进度的分子是 **`TERMINAL_ROW_STATUSES` 的行数**（计划「修正 7」），不是「已评分」的行数。
 *
 * 本仓约定：两个汉字的按钮一律 `autoInsertSpace={false}`（见 provider-table.tsx 的文件头），
 * 否则可访问名会变成「开 始」/「确 定」，用例与屏幕阅读器都会撞上。
 */
import { Badge, Button, Card, Descriptions, Flex, Layout, Modal, Popconfirm, Progress, Tooltip, Typography, theme } from 'antd';
import type { DescriptionsProps } from 'antd';
import type { ReactNode } from 'react';
import {
  AGENT_LABELS,
  TERMINAL_ROW_STATUSES,
  hasLiveRows,
  isRunnableRow,
  isRunningRow,
  type AgentKind,
  type EvalRow,
  type EvalRun,
} from '@aieval/contracts';
import { PANE_PADDING } from '../base/list-detail-layout';
import type { LiveMetricsView } from '../base/metric-line';
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
  onOpenLog: (rowId: string) => void;
  onOpenDiff: (rowId: string) => void;
  onOpenScore: (rowId: string) => void;
  /** 打开编辑表单（右栏切到 edit） */
  onEdit: () => void;
  /**
   * 删除这一轮。**必须返回在途请求的 promise**（`() => remove(id)`，而不是 `() => { void remove(id) }`）：
   * antd 的 `ActionButton` 只在 `onConfirm` 返回 thenable 时才等待它——返回 undefined 时确认框会
   * **立刻关闭**，用户看到的是「点一下就没反应」，再点一次就是第二次 DELETE
   *（`case-detail-panel.tsx` 的 `onDelete` 注释同此口径）。
   */
  onDelete: () => void | Promise<unknown>;
  /** 删除请求在途：给确认按钮上 loading，避免重复点 */
  deleting?: boolean;
}

/**
 * 只有 1..3 名带徽标（spec §5.3）。并列时两行同名次，故这里没有「名次唯一」的假设。
 * 导出它而不是在测试里抄一份 3：改阈值时用例必须跟着显式改。
 */
export const RANK_BADGE_LIMIT = 3;

/**
 * 串行进度百分比：`total <= 0` 时返回 **0**，绝不让除零的 `NaN` 流进界面。
 * 单独抽成纯函数是因为它必须能被**直接**测到：`Progress` 的 `percent` 只决定条宽、
 * 不产生可断言的文案，留在组件里就只能靠间接断言——「零行时不出现 NaN」这条
 * （Review Focus 第 4 条）会退化成一条谁也测不到的注释。
 */
export function completionPercent(done: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((done / total) * 100);
}

/**
 * 排序与名次的**唯一判据**（用户口径 2026-09-29）：总分降序 → 耗时升序 → tok 升序；
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
 * （2026-10-XX 的归一化：codex 侧做过 `input_tokens − cached_input_tokens`，claude / dsh 原文就不含 cache）
 * ⇒ `input` / `cached` / `output` 三者互斥，`input + output` 不会双计。改契约那一格时必须回来看这里。
 */
function totalTokens(row: EvalRow): number {
  if (row.tokens === null) return Number.POSITIVE_INFINITY;
  return row.tokens.input + row.tokens.output;
}

/** 名次 = 1 + 按同一判据**严格优于**它的行数；三项全同 ⇒ 同名次（并列）；没有分的行不给名次 */
function rankOf(rows: EvalRow[], row: EvalRow): number | undefined {
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
function orderForDisplay(rows: EvalRow[]): EvalRow[] {
  const scored = rows.filter((row) => row.score !== null).sort(compareRows);
  const rest = rows.filter((row) => row.score === null);
  return [...scored, ...rest];
}

/** 缺省能力：按「都支持」处理（与 `EvalRowCard` 的缺省一致） */
const OPTIMISTIC_CAPABILITY: AgentCapabilityView = { usage: true, cancelMidTurn: true };

export function RunDetailPanel({
  run,
  starting,
  aborting,
  capabilityOf,
  liveOf,
  onStart,
  onAbortRun,
  onAbortRow,
  onRescoreRow,
  rescoring,
  onRetryRow,
  retrying,
  onOpenLog,
  onOpenDiff,
  onOpenScore,
  onEdit,
  onDelete,
  deleting = false,
}: RunDetailPanelProps): ReactNode {
  const { token } = theme.useToken();
  const [modal, contextHolder] = Modal.useModal();

  const runnable = run.rows.filter((row) => isRunnableRow(row.status));
  const hasRunning = run.rows.some((row) => isRunningRow(row.status));
  // 分子是终态行数：失败/超时/终止/跳过/被打断都是「跑完了」，不把它们算进去进度永远到不了 100%
  const done = run.rows.filter((row) => TERMINAL_ROW_STATUSES.includes(row.status)).length;
  const total = run.rows.length;
  const serial = run.executionMode === 'serial';

  /**
   * 「能不能改 / 能不能删」：只有一条判据（`hasLiveRows`），由服务端同一份函数抛 409。
   * 有行在跑时两个入口一律禁用；**原因只在「编辑」那一格有 `Tooltip`**（「删除」被 `Popconfirm`
   * 的 `disabled` 一并挡住，禁用态没有任何解释）——正在跑的行有自己的生命周期，处置是「先终止」。
   */
  const live = hasLiveRows(run);
  const mutateDisabledReason = live ? '有候选行正在运行：先终止，再编辑 / 删除' : undefined;

  const startDisabled = starting || hasRunning || runnable.length === 0;
  const startDisabledReason = hasRunning
    ? '有候选行正在运行：等它结束，或先终止'
    : runnable.length === 0
      ? '没有可执行的行（全部已评分）'
      : undefined;

  /** 「开始」的确认框：把将执行的清单摆出来，避免误点跑掉几十分钟 */
  const confirmStart = (): void => {
    modal.confirm({
      title: '开始执行这一轮评测？',
      width: 520,
      // 浮层根节点带一个类名：调用方（与用例）要能收窄到「这一个浮层」——
      // 页面上「开始」「终止」都不止一处，靠全局查询必然撞上「找到多个」。
      rootClassName: 'run-start-confirm',
      content: (
        <Flex vertical gap={4}>
          <Typography.Text>
            执行模式：{serial ? '串行（一行跑完含评分，才起下一行）' : '并行（全部同时开跑）'}
          </Typography.Text>
          <Typography.Text>本次将执行 {runnable.length} 个候选：</Typography.Text>
          {runnable.map((row) => (
            <Typography.Text key={row.id} type="secondary">
              · {AGENT_LABELS[row.agentKind]} · {row.modelId}
            </Typography.Text>
          ))}
        </Flex>
      ),
      okText: '开始',
      cancelText: '取消',
      okButtonProps: { autoInsertSpace: false },
      cancelButtonProps: { autoInsertSpace: false },
      onOk: onStart,
    });
  };

  /**
   * 顶部信息卡的字段表（与 `case-detail-panel.tsx` 的 `fields` 同构，只有字段集不同）：
   *   · **分支只在远端轮次出现**（`repoBranch !== null`）。本地轮次 / 旧数据渲染出的字段与新增这一行
   *     之前逐字相同——摆一行「分支：—」等于凭空多一个让人去猜「为什么是空的」的字段；
   *   · commit 给**全量** 40 位（不再截成短哈希 + Tooltip）：右栏是核对「这一轮测的到底是哪个提交」
   *     的地方，悬停才能看全的写法在这里没有必要——卡片布局本来就有整行的宽度；
   *   · 仓库路径与工作基目录同样给全量，靠换行而不是省略（右栏可能只有 320px）。
   */
  const headerFields: NonNullable<DescriptionsProps['items']> = [
    {
      key: 'repoPath',
      label: '代码仓库',
      children: <Typography.Text code>{run.repoPath}</Typography.Text>,
    },
    ...(run.repoBranch === null
      ? []
      : [
        {
          key: 'repoBranch',
          label: '分支',
          children: <Typography.Text code>{run.repoBranch}</Typography.Text>,
        },
      ]),
    {
      key: 'commitHash',
      label: 'commit',
      children:
        run.commitHash === null ? (
          <Typography.Text type="secondary">默认分支 HEAD</Typography.Text>
        ) : (
          <Typography.Text code>{run.commitHash}</Typography.Text>
        ),
    },
    {
      key: 'workspaceBase',
      label: '工作基目录',
      children: <Typography.Text code>{run.workspaceBase}</Typography.Text>,
    },
  ];

  return (
    <Flex vertical gap={8} style={{ height: '100%', minHeight: 0 }}>
      {/* 顶部信息卡：用例标题 + 代码仓库 /（远端才有）分支 / commit / 工作基目录 */}
      <Card
        size="small"
        title={run.caseTitle}
        data-testid="run-header"
        extra={
          <Flex gap={8}>
            {/* 两个汉字的标签必须关掉 antd 的自动空格：否则可访问名变成「编 辑」/「删 除」 */}
            <Tooltip title={mutateDisabledReason}>
              {/* Tooltip 必须包在一个**真实 DOM 元素**上，不能直接包 `Button`：
                  antd 的禁用按钮不触发鼠标事件（谁接住它谁才有 hover），直接包时
                  真实浏览器里悬浮上去连一个 `.ant-tooltip` 节点都不出现——
                  而「禁用而不解释」正是这条 Tooltip 存在的理由。同 `eval-row-card.tsx` 文件头第 3 条。 */}
              <span>
                <Button
                  size="small"
                  autoInsertSpace={false}
                  disabled={live}
                  data-testid="run-detail-edit"
                  onClick={onEdit}
                >
                  编辑
                </Button>
              </span>
            </Tooltip>
            {/* `loading` 这一格**只在真的要转圈时才存在**（多写一个 `loading: undefined` 都不行）：
                antd 的 `ActionButton` 把 `buttonProps` 展开在自己的 `loading` **之后**
                （`antd@6.6.5/es/_util/ActionButton.js:92-99`），键只要在场（哪怕是 `undefined`）就会盖掉
                它内部那一格 ⇒ `onConfirm={onDelete}` 交回的 promise **照样被等、确认框照样等它落定才关**
                （等待与关闭在 `:42-61`，与按钮的转圈是两条路），丢的只是「按钮在转圈」这个反馈：
                删除期间按钮看起来没反应（正是 `onDelete` 注释里那个「点一下没反应」的观感）。 */}
            <Popconfirm
              title="删除这一轮评测？"
              description="这一轮的全部行工作区与执行日志会一起删掉，不可恢复。"
              okText="确认删除"
              cancelText="取消"
              okButtonProps={{ danger: true, autoInsertSpace: false, ...(deleting ? { loading: true } : {}) }}
              cancelButtonProps={{ autoInsertSpace: false }}
              disabled={live}
              onConfirm={onDelete}
            >
              <Button size="small" danger autoInsertSpace={false} disabled={live} data-testid="run-detail-delete">
                删除
              </Button>
            </Popconfirm>
          </Flex>
        }
      >
        {/* antd 6 的 Descriptions 推荐 items（子节点写法已弃用）；列数固定 1 列：右栏窄，多的列只会挤到换行 */}
        <Descriptions size="small" column={1} items={headerFields} />
        {/* 串行进度钉在信息卡**内部底部**（用户口径 2026-09-29）：它读的是「整轮跑完了几行」，
            与上面这组「这一轮跑的到底是哪份代码」属于同一块元信息；浮在卡片外面时，
            它悬在卡片与候选列表之间，看着像下面那串候选卡片的表头。
            间距用 `marginTop` 而不是外层 `Flex` 的 `gap`：卡片与进度现在是同一个盒子里的上下两段。 */}
        {serial && (
          <Flex align="center" gap={8} data-testid="run-progress" style={{ marginTop: 8 }}>
            <Progress percent={completionPercent(done, total)} size="small" showInfo={false} style={{ flex: 1 }} />
            <Typography.Text type="secondary">
              {done}/{total} 已完成
            </Typography.Text>
          </Flex>
        )}
      </Card>

      <Flex vertical gap={8} data-testid="run-row-list" style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
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
              onAbort={() => onAbortRow(row.id)}
              onRescore={() => onRescoreRow(row.id)}
              rescorePending={rescoring}
              onRetry={() => onRetryRow(row.id)}
              retryPending={retrying}
              onOpenLog={() => onOpenLog(row.id)}
              onOpenDiff={() => onOpenDiff(row.id)}
              onOpenScore={() => onOpenScore(row.id)}
            />
          );
        })}
      </Flex>

      <Layout.Footer
        data-testid="run-footer"
        style={{
          position: 'sticky',
          bottom: 0,
          // 只补**上边**：分隔线与内容之间 8px，内容到栏底也是 8px（后者由 `ListDetailLayout`
          // 详情槽的 `padding` 提供，见 `PANE_PADDING`）⇒ 视觉上下边距一样宽（2026-10-07 用户口径）。
          // 左右仍为 0：横向对齐卡片那一列的左右边，多一圈内边距只会让内容缩进去。
          padding: `${PANE_PADDING}px 0 0`,
          background: token.colorBgContainer,
          borderTop: `1px solid ${token.colorBorderSecondary}`,
        }}
      >
        <Flex justify="space-between" align="center" gap={8} wrap>
          <Flex align="center" gap={8}>
            <Badge status={hasRunning ? 'processing' : 'default'} />
            {/* 执行模式只读展示：**本面板不提供切换入口**（spec §3 F9：执行模式随评测落库、运行中不可改） */}
            <Typography.Text type="secondary">
              {serial ? '串行' : '并行'} · 共 {total} 行
            </Typography.Text>
          </Flex>
          <Flex gap={8}>
            <Tooltip title={startDisabledReason}>
              <Button
                type="primary"
                size="small"
                autoInsertSpace={false}
                loading={starting}
                disabled={startDisabled}
                onClick={confirmStart}
              >
                开始
              </Button>
            </Tooltip>
            <Popconfirm
              title="终止这一轮评测？"
              description="正在跑的 agent 子进程会被杀掉，且不可撤销。"
              okText="确定"
              cancelText="取消"
              okButtonProps={{ autoInsertSpace: false }}
              cancelButtonProps={{ autoInsertSpace: false }}
              disabled={aborting || !hasRunning}
              onConfirm={onAbortRun}
            >
              <Button danger size="small" autoInsertSpace={false} loading={aborting} disabled={aborting || !hasRunning}>
                终止
              </Button>
            </Popconfirm>
          </Flex>
        </Flex>
      </Layout.Footer>
      {contextHolder}
    </Flex>
  );
}
