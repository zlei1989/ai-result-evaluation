'use client';

/**
 * 单候选卡片：标题行（智能体 · 模型 · 思考强度） + 分支 + 计量 + 状态 + 按钮组。
 * **供应商不占标题行的位置**（2026-10-07 用户口径）：名字与接口地址挂在**模型名**的浮层上，
 * 悬浮才出——供应商是「这个模型跑在哪个网关上」的补充信息，不是并排比较时要看的那一格。
 * 版面上的分隔靠 `Card` 自己的标题栏与 `Flex` 的 `gap` 承担，**不额外插 `Divider`**：
 * 它的默认外边距是页面级的，塞进卡片里就得手调，与「间距走 antd 默认」相悖。
 * 四件必须显式表达的事（缺一件使用者就会误判）：
 *   1. `queued` → 「串行排队中：前一行结束后自动开始」；
 *   2. `row.diff.truncated` → 「diff 已截断」（这一次的分是在不完整输入下得出的）；
 *   3. `capability.cancelMidTurn === false` → 按钮文案退化为「关闭运行时」（spec §5.6.2）；
 *   4. `row.error` → 错误码 + 可读原因，不能只留一个红 Tag。
 * 另加一条**不可撤销**的动作口径：终止该行前必须 `Popconfirm`（它杀 agent 子进程）——
 * 与吸底栏的整轮终止同一套语义，见下方按钮处的注释。
 *
 * 两个「重跑」按钮的可用面（用户口径 2026-09-28 **晚间修订**，判据在 contracts 里）：
 *   · 「重新执行」（连候选 agent 带评分重跑）与「重新评分」（只重跑评分）的硬前提相同：
 *     **不在跑 + 有可比基线 + 有已产出的改动**——也就是「这一行真的跑过一次、留下了产出」；
 *   · **已经出分的行（`judged`）同样给**（晚间口径：「已出分、无报错时取消禁用」）。误点的代价
 *     改由 `Popconfirm` 二次确认承担（一个说清「候选会重跑」，一个说清「现有分数会被替换」）；
 *   · 判据**不看** `error` / `error.stage`：失败发生在哪一段不再决定按钮能不能按。
 * 禁用时一律用 `Tooltip` 说清原因。
 *
 * **单行执行（2026-09-29 用户口径）**：「只执行当前候选项，不要完成后重新执行下方已经执行过的
 * 候选项」。于是那个按钮的**可用面比上面宽一档**——判据换成 contracts 的 `canRunRow`（不在跑就放行，
 * **含一次都没跑过的行**），文案按行态分叉：
 *   · 没跑过（`baselineCommit === ''` 或没有 diff）⇒ 「**开始执行**」= 这一行的首跑；
 *   · 跑过 ⇒ 「**重新执行**」= 整段重跑（原来是唯一一档）。
 * 为什么必须放开这一档：过去没跑过的行只能靠「开始」跑，而「开始」的语义是**所有可执行行**
 * （`isRunnableRow`）——想单独跑三行里的第二行时，它会顺带把上面失败过的行一起重跑一遍。
 * `canRetryRow` 因此只剩「这次是首跑还是重跑」这一个用途：它决定文案与确认框措辞，不再决定能不能按。
 *
 * 两条本仓约定：
 *   · 两个汉字的按钮一律 `autoInsertSpace={false}`（antd 默认会在中间插一个空格，
 *     可访问名会变成「终 止」，用例与屏幕阅读器都会撞上；见 provider-table.tsx 的文件头）；
 *   · 状态文案取自 contracts 的 `ROW_STATUS_LABELS`，这里不抄第二份。
 * 第三条是终审 FIX-6 补上的（原本漏了，而 jsdom 不会提醒）：
 *   · **禁用控件的原因一律走 `Tooltip`，且 `Tooltip` 只能包在一个真实 DOM 元素（`span`）上**。
 *     它的直接子节点若是 `Popconfirm` 这类组件，悬浮事件会被那一条链吃掉——真实浏览器里鼠标悬浮
 *     禁用态的「重新评分」连一个 `.ant-tooltip` 节点都不出现（jsdom 照样绿）。见按钮处那段注释。
 *
 * 卡片底部还有一行**活动行**（`AgentActivityLine`，用户口径 2026-09-29）：跑动期显示智能体最近一条
 * 输出、文字上有一条周期性扫过的高光；终态整行消失。它是否出现**只由 `row.status` 决定**——
 * 拿不到实时值（历史还没拉回来）时显示回落文案，而不是整行消失（同 `MetricLine` 的 `live` 口径）。
 */
import { Alert, Button, Card, Flex, Popconfirm, Tag, Tooltip, Typography } from 'antd';
import type { ReactNode } from 'react';
import {
  AGENT_LABELS,
  EFFORT_OFF,
  canRescoreRow,
  canRetryRow,
  canRunRow,
  isRunningRow,
  type EvalRow,
} from '@aieval/contracts';
import { AgentActivityLine } from '../base/agent-activity-line';
import { MetricLine, type LiveMetricsView } from '../base/metric-line';
import { RowStatusTag } from '../base/row-status-tag';

/** 该行智能体的能力元数据（来自注册表，见计划「修正 3」） */
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
  onAbort: () => void;
  onOpenLog: () => void;
  onOpenDiff: () => void;
  onOpenScore: () => void;
  onRescore: () => void;
  /** 重评请求在途：按钮转圈并禁用（避免连点两次） */
  rescorePending?: boolean;
  /**
   * 单行**执行**：只跑这一行（候选 agent + 评分整段），本轮其他行一律不动。
   * 界面文案按行态分叉（2026-09-29）：没跑过 = 「开始执行」、跑过 = 「重新执行」。
   * 与「重新评分」是**两个按钮**：前者要跑候选（分钟级），后者只重算评分（几十秒）——
   * 合成一个按钮会让用户按下去才知道跑的是哪一段。
   * 可用面由 contracts 的 `canRunRow` 决定（**不在跑就放行**，含一次都没跑过的行）；
   * `canRetryRow` 只决定文案（这次是重跑还是首跑）。
   */
  onRetry: () => void;
  retryPending?: boolean;
}

/** 缺省能力：按「都支持」处理——多给一个终止按钮，比无端禁用安全 */
const DEFAULT_CAPABILITY: AgentCapabilityView = { usage: true, cancelMidTurn: true };

/**
 * 「执行」这一格不可用的原因（只有一个否定面：这一行正在跑）。
 *
 * 2026-09-29 起这条判据的**其余分支全部消失**：过去它逐条对应 `retryRefusal` 的三条硬前提
 * （在跑 → 没基线 → 没产出），而那时「没跑过的行」按不了这个按钮、只能靠「开始」跑整轮；
 * 用户口径改成「只执行当前候选项」之后，没跑过的行**必须**能按（文案变成「开始执行」），
 * 于是「没基线 / 没产出」不再是否定面——它们恰恰是**首跑**的正常形态。
 * 措辞与编排层 `retryRow` 里那一条 CONFLICT 同义（那边是「请先终止它，再执行」）：
 * 「界面说 A、服务端说 B」是漂移的老形状。
 */
function runDisabledReason(row: EvalRow, running: boolean): string {
  if (running) return '正在运行中：请先终止它，再执行';
  // 判据说不行、但上面那条对不上：只有判据**将来新增条件**时才会走到这里（今天不可达；
  // 该函数自身的 docstring 记着「其余分支全部消失」，那两条**今天已不在代码里**——
  // 「哪天删的」在本仓 git 里查不到 diff，只能按那份 docstring 采信）
  return '该行此刻不能执行：请稍候再试';
}

/**
 * 「重新评分」不可用的原因（与编排层的 `rescoreRefusal` **共享「在跑 / 没基线 / 没产出」那三条且同序**，文案**同义但不逐字**——服务端那句把状态放进 `ROW_STATUS_LABELS`，随「准备中 / 执行中 / 评分中」变；服务端另有界面看不见的 `settling` 一条）。
 * 判据**不看失败阶段**（2026-09-28 晚间口径）：已经出分的行、候选 agent 阶段失败的行都可重评，
 * 因此这里只剩「在跑 / 没基线 / 没产出」三条。
 */
function rescoreDisabledReason(row: EvalRow, running: boolean): string {
  if (running) return '正在运行中：请先终止它，再重新评分';
  if (row.baselineCommit === '') return '这一行的工作区未就绪，请先点「开始」跑一次';
  if (row.diff === null) return '这一行还没有跑过，没有可复评的改动';
  // 同 `runDisabledReason`：判据新增条件时才可达的兜底，今天不放行也不可达（服务端还有一条
  // `settling` 界面看不见——它的口径是「行已落终态、但 `rowAborts` 里还有条目 ⇒ 上一次运行
  // 还没收尾」，与本文件的可用判据无关，那是一个真实可达的 409 窗口）
  return '该行当前不可重新评分：请先点「开始」让它完整跑过一次';
}

export function EvalRowCard({
  row,
  rank,
  queued = false,
  capability = DEFAULT_CAPABILITY,
  live,
  onAbort,
  onOpenLog,
  onOpenDiff,
  onOpenScore,
  onRescore,
  rescorePending = false,
  onRetry,
  retryPending = false,
}: EvalRowCardProps): ReactNode {
  const running = isRunningRow(row.status);
  // `row.diff === null` = 这一行还没有产出（计划「修正 5」）：点开只会拿到一个 CONFLICT，
  // 所以按钮禁用，并在 Tooltip 里说清原因——禁用而不解释等于一个坏掉的按钮。
  const hasDiff = row.diff !== null;
  // 两个动作的可用判据与**服务端同一份**（contracts 的 canRescoreRow / canRetryRow）：
  // 两处各写一份必然漂移，而漂移的表现是「按钮可点、点下去 409」。文案与服务端的关系分两种：
  // **重新评分**那一侧与 `rescoreRefusal` 共享那三条且同序（同义但不逐字，见上一条注释）；
  // **重跑**那一侧不是逐条对应——服务端 `retryRefusal` 只有竞态专用的一句（`retryRow` 的兜底），
  // 而 `runDisabledReason` 今天只剩「正在运行中」一条真实分支（另两条已在 2026-09-29 删除）。
  const rescorable = canRescoreRow(row);
  const rescoreHint = rescorable ? undefined : rescoreDisabledReason(row, running);
  /**
   * 单行执行（内部名仍是 retry：`canRunRow` / 路由 `/retry` 都不动，改的只是**能不能按**与**叫什么**）。
   *   · 能不能按 = `canRunRow`（不在跑就放行，含一次都没跑过的行，2026-09-29 口径）；
   *   · 叫什么 = 「这一行跑过没有」——**与此刻在不在跑无关**：正在首跑的行（`preparing` / `running`）
   *     也该显示「重新执行」（它确实已经跑起来了），显示「开始执行」会让人以为还没开始。
   * 文案与确认框措辞都从这里派生：两处各写一份判据，必然出现「按钮写重新执行、确认框说首跑」这种漂移。
   */
  const runnable = canRunRow(row);
  const rerun = canRetryRow(row) || isRunningRow(row.status);
  const runLabel = rerun ? '重新执行' : '开始执行';
  const runHint = runnable ? undefined : runDisabledReason(row, running);

  return (
    <Card
      size="small"
      title={
        <Flex align="center" gap={8} wrap>
          {rank === undefined ? null : <Tag color="gold">第 {rank} 名</Tag>}
          <Typography.Text strong>{AGENT_LABELS[row.agentKind]}</Typography.Text>
          <Typography.Text type="secondary">·</Typography.Text>
          {/* 模型名 + 供应商浮层（2026-10-07 用户口径）：供应商信息挂在这一格上、鼠标移入才浮出，
              标题行因此不再有「供应商」Tag。为什么挂模型名而不是别处：名字与网关是同一件事的两半
              （`deepseek-flash` 单独看不知道跑在哪个网关上），而接口地址太长，本来就只该按需显示。
              `Tooltip` 包的是 `Typography.Text`（它 `forwardRef` 到真实 `<span>`，见 antd 的
              `typography/Text.js`）：与包 `Tag` 同一形状，不会多套一层元素、不影响 `Flex` 的间距。 */}
          <Tooltip title={`供应商：${row.providerName}（${row.baseUrl}）`}>
            <Typography.Text code>{row.modelId}</Typography.Text>
          </Tooltip>
          {/* 思考强度：**只在行上真的写了档位时显示**（`row.effort`，spec D12）——
              「没说」与「说了 high」必须分得开（前者跟随适配器缺省，后者是这一行锁死的档）；
              档位一律照上游的词汇原样显示（改口径 2026-10-07：关闭档也不再加工，
              四个展示点与候选里写的是同一个词 `off`）。
              2026-10-07 用户口径：普通档的浮层压成一行「思考强度：<档>」（原来那句「这一行要求的
              思考强度：<档>」在标签已写明档位时是重复的）；关闭档那一格只写「关闭思考」——
              标签上已经是 `off`，浮层再把「这一行要求……」说一遍同样啰嗦。 */}
          {row.effort === undefined ? null : (
            <Tooltip title={row.effort === EFFORT_OFF ? '关闭思考' : `思考强度：${row.effort}`}>
              <Tag color="purple">{row.effort}</Tag>
            </Tooltip>
          )}
        </Flex>
      }
      extra={
        <Flex align="center" gap={4}>
          {/* 「重试过」必须可见（2026-09-27）：瞬时失败是**自动重试**的，不标出来的话
              「试了三次才成功」与「一次就成功」在卡片上长得一模一样 */}
          {row.attempts > 1 ? <Tag color="blue">已重试 {row.attempts - 1} 次</Tag> : null}
          {row.diff?.truncated === true ? <Tag color="warning">diff 已截断</Tag> : null}
          <RowStatusTag status={row.status} />
        </Flex>
      }
    >
      <Flex vertical gap={8}>
        <Typography.Text type="secondary">
          分支 <Typography.Text code>{row.branch}</Typography.Text>
        </Typography.Text>
        <MetricLine
          tokens={row.tokens}
          // 子智能体那一份（2026-10-04）：契约里是可选格，老快照没有它就退回一行浮层
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
        {queued && <Alert type="info" showIcon title="串行排队中：前一行结束后自动开始" />}
        {row.error !== null && <Alert type="error" showIcon title={`${row.error.code}：${row.error.message}`} />}
        <Flex justify="space-between" gap={8} wrap>
          <Flex gap={8} wrap>
            <Button size="small" autoInsertSpace={false} onClick={onOpenLog}>
              执行日志
            </Button>
            <Tooltip title={hasDiff ? undefined : '这一行还没有产出改动'}>
              <Button size="small" autoInsertSpace={false} disabled={!hasDiff} onClick={onOpenDiff}>
                变更详情
              </Button>
            </Tooltip>
            {/* 按钮顺序是**用户指定的版面口径**（2026-09-28）：执行日志 / 变更详情 / 执行这一行 /
                评分详情 / 重新评分。用例按可访问名查按钮、不按位置断言，故改顺序不会误报；
                反过来，想再调顺序时请连这一行注释一起改——否则下一个人只能靠猜。
                「变更详情」按钮与抽屉在 2026-09-29 由「查看改动」改名（抽屉另做了重设计，
                见 spec `2026-09-22-scaffold-design.md` §13.8）；**顺序不变**，
                只是这一格的名字变了。
                这一格（2026-09-29 口径修订）：**只跑当前候选项**——「重新执行」= 连候选 agent 一起
                重跑、「开始执行」= 这一行的首跑（两者是同一条链路，只按行态换文案）。
                与「重新评分」是**两件事、两笔成本**（分钟级 vs 几十秒），故不做成一个按钮。
                可用面：`canRunRow`（不在跑就给，含没跑过的行）——误点的代价由各自的
                `Popconfirm` 拦一次，不由判据替人说不。
                两个动作都走 Popconfirm 二次确认 + Tooltip 挂外层 span（禁用态才收得到悬浮事件，
                原因见「重新评分」下面那段长注释——jsdom 验不出来）。 */}
            <Tooltip title={runHint}>
              <span data-testid="retry-wrapper">
                <Popconfirm
                  // 确认框的标题与说明都随行态分叉：首跑说「只有这一个候选会跑」，重跑才说「分数会被替换」
                  title={rerun ? '重新执行这一行？' : '开始执行这一行？'}
                  description={
                    rerun
                      ? '候选 agent 与评分都会重跑：工作区会被重新准备，现有分数会被新的评分结果替换。只跑这一行，本轮其他行不动。'
                      : '只跑这一个候选：本轮其他行（含已经执行过的行）都不会重跑。'
                  }
                  okText="确定"
                  cancelText="取消"
                  okButtonProps={{ autoInsertSpace: false }}
                  cancelButtonProps={{ autoInsertSpace: false }}
                  onConfirm={onRetry}
                  disabled={!runnable}
                >
                  <Button size="small" autoInsertSpace={false} disabled={!runnable} loading={retryPending}>
                    {runLabel}
                  </Button>
                </Popconfirm>
              </span>
            </Tooltip>
            <Button size="small" autoInsertSpace={false} disabled={row.score === null} onClick={onOpenScore}>
              评分详情
            </Button>
            {/* 重新评分只重跑评分步骤、不重跑候选 agent，但它会**替换掉现有的分数**：
                故与「终止」同一套语义，先 Popconfirm 再动手（spec §9 的用户口径）。
                **Tooltip 必须挂在外层 span 上**：它的直接子节点若是 `Popconfirm` 组件，悬浮事件会被
                Popconfirm / Popover 那一条链吃掉——实测（真实浏览器，鼠标悬浮禁用态的「重新评分」）
                连一个 `.ant-tooltip` 节点都不出现，而同一行禁用态的「变更详情」（Tooltip 直接包 Button）
                照常弹出。这与 `case-form-panel.tsx` 文件头要点 3 是同一条规则（antd 的禁用按钮不触发
                鼠标事件，事件由外层元素接住），只是这里中间还夹了一层 Popconfirm。
                ⚠️ jsdom **验不出**这件事（`fireEvent.mouseEnter` 是直接派发到按钮上的合成事件，
                会沿 React 树冒泡上去）：改动这一处之后必须在真实浏览器里悬浮一次，见
                `eval-row-card.test.tsx` 里那组用例的注释。 */}
            <Tooltip title={rescoreHint}>
              <span data-testid="rescore-wrapper">
                <Popconfirm
                  title="重新评分这一行？"
                  description="只重跑评分步骤，候选 agent 不会再跑；现有的分数会被新的评分结果替换。"
                  okText="确定"
                  cancelText="取消"
                  okButtonProps={{ autoInsertSpace: false }}
                  cancelButtonProps={{ autoInsertSpace: false }}
                  onConfirm={onRescore}
                  disabled={!rescorable}
                >
                  <Button size="small" autoInsertSpace={false} disabled={!rescorable} loading={rescorePending}>
                    重新评分
                  </Button>
                </Popconfirm>
              </span>
            </Tooltip>
          </Flex>
          {running && (
            // 「终止」杀的是 agent 子进程、不可撤销 ⇒ 与吸底栏的整轮终止**同一套语义**：
            // 先 `Popconfirm` 再动手（B4 的 RunDetailPanel 文件头口径 2 就是这么写的，
            // 单行这一侧曾经漏了它：一次点击直接把该行置 canceled，实测过两次）。
            // `Popconfirm` 自持浮层状态，本组件仍是纯展示组件，不需要新 prop。
            <Popconfirm
              title="终止这一行？"
              description="正在跑的 agent 子进程会被杀掉，且不可撤销。"
              okText="确定"
              cancelText="取消"
              okButtonProps={{ autoInsertSpace: false }}
              cancelButtonProps={{ autoInsertSpace: false }}
              onConfirm={onAbort}
            >
              <Button size="small" danger autoInsertSpace={false}>
                {capability.cancelMidTurn ? '终止' : '关闭运行时'}
              </Button>
            </Popconfirm>
          )}
        </Flex>
        {/* 卡片底部：跑动期的**活动行**（智能体最近一条输出 + 高光扫过，用户口径 2026-09-29）。
            钉在最底下是因为它是这一张卡片里唯一会自己动的东西——上面三行（分支 / 计量 / 按钮）
            都是稳定信息，把动效夹在中间会让每次重渲染都像「卡片在跳」。
            **是否显示由 `row.status` 决定**（不是由传没传 `live` 决定，与 `MetricLine` 的 `live` 同口径）：
            拿不到实时值（历史还没拉回来）时它显示回落文案，而不是整行消失。 */}
        <AgentActivityLine status={row.status} latestText={live?.latestText ?? null} />
      </Flex>
    </Card>
  );
}
