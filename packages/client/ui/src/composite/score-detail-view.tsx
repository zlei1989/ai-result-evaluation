'use client';

/**
 * 评分详情：评分运行信息 + 总分 + 满分 + 逐项达成 / 未达成 + 每项理由 + 总评 + 记账 + 模型原始返回
 * + 评分原始输出（评审会话的 `log` 原文）。
 * 八条口径：
 *   1. **总分原样显示 `score.totalScore`，前端不重算**——它是服务端按权重加总出来的权威值
 *      （缺一项即整行判失败），在这里「按评分表现场加一遍」会把数据不一致静默改写成另一个数；
 *   2. **满分来自 `score.maxScore`**（不是常量 100，也不现算）——它是这一分生成时那张表的权重之和；
 *   3. **未达成的项必须与达成项区分开**：它们才是使用者要看的重点。标记落在**行**上
 *      （`data-achieved` 数据属性 + 语义色），故改成表格之后不会被摊平；
 *   4. 判定与评分表按**引用键**对齐；评分表里有而判定里没有的项**显式标出**（不静默跳过）
 *      ——那种「看起来正常」的表格比报错危险得多；
 *   5. 原始返回必须可见（解析失败时它是判断「提示词问题还是模型问题」的唯一线索），但**不占正文高度**：
 *      正文在**二级抽屉**里整段看，入口按钮**挂在主抽屉的 `footer`** 上，
 *      正文里既没有标题也没有按钮；开合态**受控**（`rawOpen` / `onRawOpenChange`）——入口在页面那一层，
 *      状态只能由页面持（切行 / 关抽屉时也要能一起收掉，见 `apps/web-next/app/runs/page.tsx`）；
 *      正文由 `JsonText` 渲染：是 JSON 就缩进格式化 + 高亮，不是就逐字原样；
 *   6. 逐项明细走 antd **`Table`（`size="small"`）**，与 `rubric-table` 的只读形态同一口径。
 *      **一组一张表**：组名是评分表自己的结构，摊成一张大表反而要多一列「组名」，而那一列在
 *      每一行都重复一遍。列是固定的 ⇒「缺判定」不再是「少一行」，而是那一行的判定列如实写出
 *      「缺少判定」（口径 4 因此变得**看得见**，不再依赖某个兄弟元素刚好没被渲染出来）；
 *   7. **顶部那两行说的是「这一分是谁打的、花了多少」**——全部取自 `score` 自己的五格
 *      （`judgeAgentKind` / `judgeModelId` / `judgeEffort` / `judgeTokens` / `judgeDurationMs`），
 *      形态沿用「无标题、两行」（第一行身份、第二行用量 / 耗时，理由见正文那段注释）。
 *      ⚠️ 这一整段是**评分自己**的花销，不是被评那一行（`EvalRow` 的五格）——
 *      而抽屉叫「评分详情」——读者拿执行的花销去理解评分，两件事差了整整一个阶段（`EvalRow.durationMs`
 *      契约里就写明不含评分阶段）。故候选那五格**不再进这个抽屉**（行卡片与执行日志里都有），
 *      评分的两格由两条评分通路**在评分时落盘**（见 `contracts/src/score.ts` 的 `judgeTokens`）。
 *      于是本视图的**评分与评分表**只吃 `score` 与 `rubric`：没有「行数据配错分」这条缝了；
 *   8. **评分原始输出**（评审者会话的 `log` 事件逐字原文，与执行日志的「原始输出」同口径同正文）
 *      与原始返回同一套形态：入口按钮在页面 `footer` 上、正文在本层二级抽屉里、开合受控
 *      （`judgeOutput.open` / `onOpenChange`）。它与 `score` / `rubric` **不是同一份数据**
 *      （`judge-events.jsonl` 是评审过程的流水，不是这一分的结构化产物），故走独立的
 *      `judgeOutput` prop 组、不并进 `score`——判据、三态与提示行全在 `ScoreJudgeOutputProps`。
 *      它**不判可见性**：文本 API 评分没有这条流、评分没开始也没有，判据在调用方（页面）；
 *      **0 条原文也照常渲染**（智能体评分的行没有「藏入口」的口径——空态写在正文里，见
 *      「这一行评分没有留下原始输出记录」那一支）。
 */
import { Alert, Button, Flex, Skeleton, Table, Tag, Typography, theme } from 'antd';
import type { TableColumnsType } from 'antd';
import type { HTMLAttributes, ReactNode } from 'react';
import { AGENT_LABELS, rubricEntries, type Rubric, type RubricEntry, type ScoreResult } from '@aieval/contracts';
import { EllipsisText } from '../base/ellipsis-text';
import { JsonText } from '../base/json-text';
import { formatDuration } from '../base/metric-line';
import { NestedDrawer } from '../base/nested-drawer';
import { formatDateTime } from '../base/format';
import { formatUsageTriple } from '../base/usage-metrics';
import { diagnosticsBody, rawOutputLabel } from './agent-log/raw-output-panel';
import type { AgentLogDiagnostics, Loadable } from './agent-log/types';

export interface ScoreDetailViewProps {
  score: ScoreResult;
  /** 这一轮用的评分表（**快照**，与 `score` 来自同一份 run.json） */
  rubric: Rubric;
  /**
   * 「模型原始返回」二级抽屉的开合（**受控**，口径 5）：入口按钮在主抽屉的 `footer` 上、
   * 由页面渲染，故状态只能住在页面那一层。
   */
  rawOpen: boolean;
  onRawOpenChange(next: boolean): void;
  /**
   * 「评分原始输出」二级抽屉（口径 8）：**不给 = 这一行没有这个入口**（文本 API 评分 /
   * 评分还没开始——判据在调用方），此时连抽屉都不渲染。给了就由本视图负正文与三态。
   */
  judgeOutput?: ScoreJudgeOutputProps;
}

/**
 * 评分原始输出那一格的全部输入（口径 8）。数据是**评审会话的 `log` 事件原文**
 * （`judge-events.jsonl` 经 `diagnosticsOf` 折成行），不是 `score` 的一部分——
 * 读取有自己的三态与重试，故独立成组而不是塞进 `score`。
 */
export interface ScoreJudgeOutputProps {
  /** 历史读取的三态（与执行日志抽屉的 `Loadable` 同一形状） */
  state: Loadable<AgentLogDiagnostics>;
  /** `state === 'error'` 时已经折好的中文原因（本包不认识 `ServiceError`，折错在数据层做） */
  errorText: string | null;
  /** 评分进行中（judging ⇔ 无分）：正文顶部多一行「正在评分」的提示，终态行恒 false */
  judging: boolean;
  /** SSE 断线的一句警示（历史已在手时仍可能非空；重连成功自动清空） */
  liveError: string | null;
  /** 历史读取失败后的重试入口（`state === 'error'` 时才有机会被点到） */
  onRetry(): void;
  /** 二级抽屉开合（**受控**，同 `rawOpen` 的口径：入口按钮在页面那一层） */
  open: boolean;
  onOpenChange(next: boolean): void;
}

/** 判定（`score.judgments` 的一项）：按引用键与评分表的项对齐 */
type ScoreJudgment = ScoreResult['judgments'][number];

/** 表格的一行 = 一个评分项 + 它的判定（`judgment === undefined` ⇒ 数据不一致，判定列显式写出来） */
interface ScoreRow {
  /** 组内序号：`rowKey` 用它——引用键在损坏的快照里可能重复，序号不会 */
  index: number;
  /** 引用键（与 `judgment.id` 对齐，也是这一行 `data-testid` 的后缀） */
  key: string;
  goal: string;
  weight: number;
  judgment: ScoreJudgment | undefined;
}

/**
 * 挂在 `<tr>` 上的属性：`onRow` 的返回类型在 antd 里只声明了事件处理器，而这一页要挂
 * `data-*`（守卫按数据属性断言，比断言 class 稳）与行内语义色。显式写出这一支，不写 `as any`
 * ——那会把真正的类型错误一起吞掉。
 */
type ScoreRowAttributes = HTMLAttributes<HTMLElement> & {
  'data-testid': string;
  'data-achieved': 'yes' | 'no';
};

/**
 * 列定义与组无关（组只决定表里有哪几行），故放在组件外：它既不读 props 也不读 token。
 * **每一列都显式给 `key`**：不给时 antd 拿 `dataIndex` 当列键，而「判定」与「理由」两列都取自
 * 同一个判定对象（没有 `dataIndex`）⇒ 会撞成同一个列键。
 */
const COLUMNS: TableColumnsType<ScoreRow> = [
  {
    key: 'key',
    title: '引用键',
    dataIndex: 'key',
    width: 128,
    // 引用键是**标识符**，不许在词中间折行（`vue3-cdn` 折成 `vue3-` / `cdn` 会被读成两个东西，
    // 而这一列正是拿去与 `run.json` / 评分表对照的那把键）。走本仓的单元格原语：不传宽度 ⇒
    // 能吃多少显示多少、真超长才省略，**全量在 Tooltip 里**（`base/ellipsis-text.tsx` 的口径）。
    render: (key: string) => <EllipsisText text={key} monospace />,
  },
  {
    key: 'goal',
    title: '目标',
    dataIndex: 'goal',
    render: (goal: string) => <Typography.Text>{goal}</Typography.Text>,
  },
  {
    key: 'weight',
    title: '权重',
    dataIndex: 'weight',
    width: 88,
    render: (weight: number) => <Typography.Text strong>{weight} 分</Typography.Text>,
  },
  {
    key: 'judgment',
    title: '判定',
    width: 96,
    render: (_, row) =>
      row.judgment === undefined ? (
        // 评分表里有、判定里没有：显式写出来（口径 4）。不写「未达成」——那是另一个事实
        <Tag color="warning">缺少判定</Tag>
      ) : (
        <Tag color={row.judgment.achieved ? 'success' : 'error'}>{row.judgment.achieved ? '达成' : '未达成'}</Tag>
      ),
  },
  {
    key: 'reason',
    title: '理由',
    render: (_, row) => <Typography.Text type="secondary">{row.judgment?.reason ?? ''}</Typography.Text>,
  },
];

/** 评分原始输出正文区的内边距（px）：二级抽屉的 `body.padding` 已置 0，由内容自己给（与原文面板同口径） */
const JUDGE_BODY_PADDING = 16;

/**
 * 评分原始输出的正文（口径 8）：三态 + 顶部两行可选提示（「正在评分」/ 实时连接警示）
 * + ready 态复用 `diagnosticsBody`（与执行日志的原文面板**同一份**行渲染）。
 *
 * 布局用**结构性不变量**写进内联 style（`display` / `flexDirection`）：antd 的 `Flex` 这两个属性
 * 走 CSS 类、内联读不到，而这里「列表吃满剩余高度」是虚拟滚动的**前提**（`base/virtual-list.tsx`
 * 口径 3：量不到高度就静默退化为全量渲染）。
 */
function judgeOutputBody(props: ScoreJudgeOutputProps): ReactNode {
  const { state, errorText, judging, liveError, onRetry } = props;
  return (
    <Flex vertical style={{ height: '100%', display: 'flex', flexDirection: 'column' }} data-testid="score-judge-output-body">
      {/* judging 提示：此刻页面上还没有分（judging ⇔ 无分），先说清「以下是当前尝试的输出」， */}
      {/* 免得半截流水被当成上一次评分的依据；终态自动消失（judging 由调用方按行状态给） */}
      {judging && (
        <Flex style={{ padding: `0 ${JUDGE_BODY_PADDING}px 8px` }} data-testid="score-judge-live-note">
          <Typography.Text type="secondary">正在评分，以下为当前尝试的输出</Typography.Text>
        </Flex>
      )}
      {/* 实时连接故障的一句警示（浏览器自动重连，已收内容不丢）：不占高度的固定行，跟着列表滚走就等于没说 */}
      {liveError !== null && (
        <Flex style={{ padding: `0 ${JUDGE_BODY_PADDING}px 8px` }} data-testid="score-judge-live-error">
          <Typography.Text type="warning">{liveError}</Typography.Text>
        </Flex>
      )}
      {state.status === 'loading' && (
        <Flex style={{ padding: JUDGE_BODY_PADDING }}>
          <Skeleton active title={false} paragraph={{ rows: 4 }} />
        </Flex>
      )}
      {state.status === 'error' && (
        <Flex style={{ padding: JUDGE_BODY_PADDING }}>
          <Alert
            type="error"
            showIcon
            title="评分原始输出读取失败"
            // 已折好的中文原因（本包不认识 ServiceError，折错在数据层做）
            description={errorText ?? undefined}
            action={
              <Button size="small" autoInsertSpace={false} onClick={onRetry}>
                重试
              </Button>
            }
          />
        </Flex>
      )}
      {state.status === 'ready' &&
        (state.data.lines.length === 0 ? (
          // 0 条也是事实（智能体评分但一条 log 都没留下、或旧数据没有 judge-events 文件）：
          // 空态写在正文里，不藏入口（口径 8）。judging 期间的 0 条另有说法——评分刚开始，不是「没有」
          <Flex style={{ padding: JUDGE_BODY_PADDING }}>
            <Typography.Text type="secondary">
              {judging ? '评分刚开始，还没有原始输出记录' : '这一行评分没有留下原始输出记录'}
            </Typography.Text>
          </Flex>
        ) : (
          // 有原文：与执行日志共用同一份正文（行渲染、虚拟滚动、截断提示位都只有一份）。
          // flex:1 + minHeight:0 让它吃满提示行之外的剩余高度（虚拟滚动的前提）
          <Flex vertical flex={1} style={{ minHeight: 0 }}>
            {diagnosticsBody(state.data)}
          </Flex>
        ))}
    </Flex>
  );
}

export function ScoreDetailView({ score, rubric, rawOpen, onRawOpenChange, judgeOutput }: ScoreDetailViewProps): ReactNode {
  // 未达成项的语义色取 antd token（不写 `var(--ant-color-error)` 字面量：换主题时这里跟着走）
  const { token } = theme.useToken();
  const byId = new Map(score.judgments.map((judgment) => [judgment.id, judgment]));

  /**
   * 每组的项与它们的引用键：由契约的 `rubricEntries` 一次摊平、**按 `groupIndex` 分组**
   * （组边界由它自己算，本组件不再「按各组项数切片取键」——那是同一条枚举规则的第二份实现）。
   * **不按对象反查**（`items.indexOf(item)`）：两项内容完全相同时它永远命中第一项，
   * 第二项的判定会被贴到第一行上——表格化之后这个错更看不出来（一行一列都长得对）。
   */
  const entriesByGroup = ((): RubricEntry[][] => {
    const grouped: RubricEntry[][] = rubric.groups.map(() => []);
    for (const entry of rubricEntries(rubric)) {
      // rubricEntries 的 groupIndex 必然落在 groups 的范围内 ⇒ 兜底分支只为类型收敛，不会真的走到
      (grouped[entry.groupIndex] ??= []).push(entry);
    }
    return grouped;
  })();

  /** 全表项数（「满分 N 分 · 共 M 项」那一行用）：它就是摊平结果的长度，不另算一遍 */
  const itemCount = entriesByGroup.reduce((sum, entries) => sum + entries.length, 0);

  /** 某一组的行：判定按引用键取，取不到就是 `undefined`（由判定列如实显示「缺少判定」） */
  const rowsFor = (groupIndex: number): ScoreRow[] => {
    const entries = entriesByGroup[groupIndex] ?? [];
    return entries.map((entry, index) => ({
      index,
      key: entry.key,
      goal: entry.item.goal,
      weight: entry.item.weight,
      judgment: byId.get(entry.key),
    }));
  };

  return (
    <Flex vertical gap={16} style={{ padding: 16 }}>
      {/* 评分运行信息（口径 7）：这一段说的是**这一分**——谁打的（评分智能体 / 评分模型 / 强度）
          与花了多少（用量 / 耗时），五格全部取自 `score`。**不写标题、并成两行**（形态沿用用户
          内容说的是评分的花销）：
          原来那五行 `Descriptions` 连标题一起占掉一百多像素，而这一段一个取数也没有——它只是把
          **已经落盘**的字段摊开给人核对。标题删掉之后「这一格是谁的」靠标签自带的「评分」二字承担
          （「评分智能体」「评分模型」），抽屉本身又叫「评分详情」，故不需再写一行小标题。
          **分组是显式的、不靠自然折行**（用户口径）：第一行只放「这一分是谁打的」（身份三格），
          第二行放「花了多少」（用量 / 耗时）——自然折行会把用得最多的那一格（用量）挤到第一行、
          把「耗时」甩到第二行单独挂着，量化信息就散了。每一行自己 `wrap`：抽屉更窄时行内折，
          不横向溢出。
          **第一行那三个值走 antd `Tag`、一色一格**：评分智能体 `blue`、
          评分模型 `geekblue`、思考强度 `purple`。标签留在 Tag **外面**、仍是次要色文字
          ——一个 Tag 里塞两种语义（谁是标签、谁是值）会让人一眼读不出来。`purple` 与评测行卡片上
          那个档位 Tag（`eval-row-card.tsx`）同色：同一个档位在本仓的四处展示点长得一样。
          颜色**不随取值变**（`off` 与 `未指定` 同为紫，文本通路与三家智能体同为蓝）：档位之间没有
          排名口径（spec D12），驱动者之间也没有强弱口径——上色成「好 / 坏」就是把一个没证实的结论
          画进界面。
          **文本通路那一格写「文本 API」**（`judgeAgentKind === null`）：这一格回答的是「谁在驱动
          这次评分」，而纯文本通路**没有智能体驱动它**（`judge-route.ts` 的原话）。写厂商名或留空都
          更坏——前者是假话，后者让「两条通路」在界面上再也分不出来（它们的分数不可比）。 */}
      <Flex vertical gap={4} data-testid="score-run-info">
        <Flex gap={16} wrap data-testid="score-judge-meta">
          <Flex align="center" gap={8}>
            <Typography.Text type="secondary">评分智能体</Typography.Text>
            <Tag color="blue">{score.judgeAgentKind === null ? '文本 API' : AGENT_LABELS[score.judgeAgentKind]}</Tag>
          </Flex>
          <Flex align="center" gap={8}>
            <Typography.Text type="secondary">评分模型</Typography.Text>
            <Tag color="geekblue">{score.judgeModelId}</Tag>
          </Flex>
          {/* 拿不到写「未指定」/「未采集」，**绝不写 0**（0 是一个读数，「没采到」不是：
              前者说的是「真的一个 token 都没花」，后者说的是「这一家适配器/网关压根不报」）。
              档位照上游词汇原样写：显式关闭档就是 `off`，它**不是**「未指定」的同义词 */}
          <Flex align="center" gap={8}>
            <Typography.Text type="secondary">思考强度</Typography.Text>
            <Tag color="purple">{score.judgeEffort ?? '未指定'}</Tag>
          </Flex>
        </Flex>
        <Flex gap={12} wrap data-testid="score-judge-usage">
          <Typography.Text type="secondary">
            {score.judgeTokens === null ? '用量未采集' : formatUsageTriple(score.judgeTokens)}
          </Typography.Text>
          <Typography.Text type="secondary">
            {`耗时 ${score.judgeDurationMs === null ? '未采集' : formatDuration(score.judgeDurationMs)}`}
          </Typography.Text>
        </Flex>
      </Flex>

      <Flex align="baseline" gap={8} wrap>
        {/* 总分原样显示（见文件头口径 1） */}
        <Typography.Title level={4}>{score.totalScore}</Typography.Title>
        <Typography.Text type="secondary">
          满分 {score.maxScore} 分 · 共 {itemCount} 项
        </Typography.Text>
      </Flex>

      <Flex vertical gap={8}>
        {rubric.groups.map((group, groupIndex) => (
          // key 带组序号：两份同名的组（脏数据）不该撞成同一个 key
          <Flex vertical gap={4} key={`${groupIndex}-${group.name}`}>
            <Typography.Text strong>{group.name}</Typography.Text>
            <Table<ScoreRow>
              // 紧凑尺寸与 `rubric-table` 的只读形态同口径
              size="small"
              // 分页在这一页没有意义（一张表就是一组，最多十几行），关掉省一截高度
              pagination={false}
              rowKey={(row) => `${groupIndex}-${row.index}`}
              dataSource={rowsFor(groupIndex)}
              columns={COLUMNS}
              onRow={(row): ScoreRowAttributes => ({
                'data-testid': `score-judgment-${row.key}`,
                // 「达成 / 未达成」的**数据属性**判据：比断言 class 稳（antd 换 token 不会让它红），
                // 也正是测试用的那一条
                'data-achieved': row.judgment?.achieved === true ? 'yes' : 'no',
                // 未达成与缺判定的行整行用语义色标出来——它们才是使用者要看的重点。
                // 取 token 而不是写死色值：主题换色时这里跟着走
                ...(row.judgment?.achieved === true ? {} : { style: { color: token.colorError } }),
              })}
            />
          </Flex>
        ))}
      </Flex>

      <Flex vertical gap={4}>
        <Typography.Text strong>总评</Typography.Text>
        <Typography.Paragraph style={{ marginBottom: 0 }}>{score.verdict}</Typography.Paragraph>
      </Flex>

      {/* 记账那一行（口径 7 之后剩下的两格）：**身份与强度已经在顶部那一段里了**，这里不再重复
          （那一段写的是评分的五格 ⇒ 这里不再有「评分智能体：X · 模型：Y ·
          思考强度：Z」与顶部说的是同一件事，两处各排一套只会互相争夺注意力）。
          留下的两格是我们这一侧的**执行事实**：
          「输出约束」= `score.structuredOutput`（spec D10）：**它是骨架按该家能力算出的结论**——
          true = 这一分走了 schema 约束的结构化输出，false = 只有提示词契约（文本通路与 dsh 通路），
          不是「我们提交了什么」的自述（`contracts/src/score.ts` 的 `applied` 口径）。
          它不表示上游一定照做了（网关可能把那一格丢掉，
          spec §9 第 1 条），故不写「模型已按 schema 返回」这类承诺，也不给告警样式——false 只是事实。
          「评分时间」= `judgedAt`（这一分是什么时候落下来的，横向比对时按它排）。 */}
      <Typography.Text type="secondary">
        输出约束：{score.structuredOutput ? 'schema 约束' : '提示词约束'}
        {' · '}
        评分时间：{formatDateTime(score.judgedAt)}
      </Typography.Text>

      {/* 原始返回**不占抽屉正文的高度**，入口也**不在正文里**（口径 5）：按钮挂在主抽屉的 `footer`
          上（页面给），正文在这一层二级抽屉里整段看。开合态受控——页面在切行 / 关抽屉时把 `rawOpen`
          一起收掉，二级抽屉因此不会在换一行之后自己弹出来。 */}
      <NestedDrawer open={rawOpen} onClose={() => onRawOpenChange(false)} title="模型原始返回">
        {/* 抽屉的 `body.padding` 已置 0：内边距自己给，否则原文贴死抽屉边框。
            不传 `maxHeight`：正文交给抽屉 body 自己滚（不在这里开第二个滚动区） */}
        <Flex vertical style={{ padding: 16 }}>
          <JsonText text={score.raw} dataTestId="score-raw" />
        </Flex>
      </NestedDrawer>

      {/* 评分原始输出（口径 8）：与原始返回同一套形态——入口在页面 footer、正文在这里、开合受控。
          标题与入口按钮**同文**（`rawOutputLabel`：ready 带条数，读取中 / 失败不带——那不是一个真读数）。
          `judgeOutput` 不给时整段不渲染（这一行没有这个入口）。 */}
      {judgeOutput !== undefined && (
        <NestedDrawer
          open={judgeOutput.open}
          onClose={() => judgeOutput.onOpenChange(false)}
          title={rawOutputLabel(judgeOutput.state.status === 'ready' ? judgeOutput.state.data.lines.length : null)}
        >
          {judgeOutputBody(judgeOutput)}
        </NestedDrawer>
      )}
    </Flex>
  );
}
