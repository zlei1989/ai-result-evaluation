'use client';

/**
 * 评分详情：总分 + 满分 + 逐项达成 / 未达成 + 每项理由 + 总评 + 评分者 + 模型原始返回。
 * 六条口径：
 *   1. **总分原样显示 `score.totalScore`，前端不重算**——它是服务端按权重加总出来的权威值
 *      （缺一项即整行判失败），在这里「按评分表现场加一遍」会把数据不一致静默改写成另一个数；
 *   2. **满分来自 `score.maxScore`**（不是常量 100，也不现算）——它是这一分生成时那张表的权重之和；
 *   3. **未达成的项必须与达成项区分开**：它们才是使用者要看的重点。标记落在**行**上
 *      （`data-achieved` 数据属性 + 语义色），故改成表格之后不会被摊平；
 *   4. 判定与评分表按**引用键**对齐；评分表里有而判定里没有的项**显式标出**（不静默跳过）
 *      ——那种「看起来正常」的表格比报错危险得多；
 *   5. 原始返回必须可见（解析失败时它是判断「提示词问题还是模型问题」的唯一线索），但**不占正文高度**：
 *      正文在**二级抽屉**里整段看，入口按钮**挂在主抽屉的 `footer`** 上（2026-10-03 立、2026-10-04 改），
 *      正文里既没有标题也没有按钮；开合态**受控**（`rawOpen` / `onRawOpenChange`）——入口在页面那一层，
 *      状态只能由页面持（切行 / 关抽屉时也要能一起收掉，见 `apps/web-next/app/runs/page.tsx`）；
 *      正文由 `JsonText` 渲染：是 JSON 就缩进格式化 + 高亮，不是就逐字原样；
 *   6. 逐项明细走 antd **`Table`（`size="small"`）**，与 `rubric-table` 的只读形态同一口径。
 *      **一组一张表**：组名是评分表自己的结构，摊成一张大表反而要多一列「组名」，而那一列在
 *      每一行都重复一遍。列是固定的 ⇒「缺判定」不再是「少一行」，而是那一行的判定列如实写出
 *      「缺少判定」（口径 4 因此变得**看得见**，不再依赖某个兄弟元素刚好没被渲染出来）。
 */
import { Flex, Table, Tag, Typography, theme } from 'antd';
import type { TableColumnsType } from 'antd';
import type { HTMLAttributes, ReactNode } from 'react';
import { AGENT_LABELS, rubricItemKeys, type Rubric, type ScoreResult } from '@aieval/contracts';
import { EllipsisText } from '../base/ellipsis-text';
import { JsonText } from '../base/json-text';
import { NestedDrawer } from '../base/nested-drawer';
import { formatDateTime } from '../base/format';

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

export function ScoreDetailView({ score, rubric, rawOpen, onRawOpenChange }: ScoreDetailViewProps): ReactNode {
  // 未达成项的语义色取 antd token（不写 `var(--ant-color-error)` 字面量：换主题时这里跟着走）
  const { token } = theme.useToken();
  const keys = rubricItemKeys(rubric);
  const byId = new Map(score.judgments.map((judgment) => [judgment.id, judgment]));

  /**
   * 每组的引用键：`rubricItemKeys` 的展平顺序就是「组序 → 项序」，按各组的项数切片即可
   * （与 `rubric-table` 同一手法）。**不按对象反查**（早先那版是 `items.indexOf(item)`）：
   * 两项内容完全相同时它永远命中第一项，第二项的判定会被贴到第一行上——表格化之后这个错
   * 更看不出来（一行一列都长得对）。
   */
  const keysByGroup = ((): string[][] => {
    const sliced: string[][] = [];
    let cursor = 0;
    for (const group of rubric.groups) {
      sliced.push(keys.slice(cursor, cursor + group.items.length));
      cursor += group.items.length;
    }
    return sliced;
  })();

  /** 某一组的行：判定按引用键取，取不到就是 `undefined`（由判定列如实显示「缺少判定」） */
  const rowsFor = (groupIndex: number): ScoreRow[] => {
    const items = rubric.groups[groupIndex]?.items ?? [];
    const groupKeys = keysByGroup[groupIndex] ?? [];
    return items.map((item, index) => {
      const key = groupKeys[index] ?? '';
      return { index, key, goal: item.goal, weight: item.weight, judgment: byId.get(key) };
    });
  };

  return (
    <Flex vertical gap={16} style={{ padding: 16 }}>
      <Flex align="baseline" gap={8} wrap>
        {/* 总分原样显示（见文件头口径 1） */}
        <Typography.Title level={4}>{score.totalScore}</Typography.Title>
        <Typography.Text type="secondary">
          满分 {score.maxScore} 分 · 共 {keys.length} 项
        </Typography.Text>
      </Flex>

      <Flex vertical gap={8}>
        {rubric.groups.map((group, groupIndex) => (
          // key 带组序号：两份同名的组（脏数据）不该撞成同一个 key
          <Flex vertical gap={4} key={`${groupIndex}-${group.name}`}>
            <Typography.Text strong>{group.name}</Typography.Text>
            <Table<ScoreRow>
              // 紧凑尺寸与 `rubric-table` 的只读形态同口径（用户 2026-10-03 口径）
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

      {/* 评分者一行分**两条通路**（spec §10 展示表）：`judgeAgentKind === null` ⇔ 纯文本 API 评分
          （老记录读盘后同样是 `null`，契约里 `.default(null)`），此时「评分模型：…」那一段逐字节保持
          原样；非 null 才多出「评分智能体：X · 模型：Y」——光有模型名回答不了「这一分是文本请求打的
          还是智能体会话打的」，而两条通路的分数不可比（README「分数怎么来的」的既有口径）。
          「输出约束」只陈述**我们提交了什么**（spec D10）：true = 提交给模型的是 schema 约束，false =
          只有提示词契约（文本通路与 dsh 通路）。它不表示上游一定照做了（网关可能把那一格丢掉，
          spec §9 第 1 条），故不写「模型已按 schema 返回」这类承诺，也不给告警样式——false 只是事实。 */}
      <Typography.Text type="secondary">
        {score.judgeAgentKind === null
          ? `评分模型：${score.judgeModelId}`
          : `评分智能体：${AGENT_LABELS[score.judgeAgentKind]} · 模型：${score.judgeModelId}`}
        {' · '}
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
    </Flex>
  );
}
