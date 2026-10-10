'use client';

/**
 * 用例只读详情（右栏内容）：字段回显 + 评分标准项（只读）+ 考题提示词 + 「编辑」「删除」。
 *
 * 纯展示：不调接口；删除的确认由 Popconfirm 负责「问一句」，真正的删除动作由调用方执行。
 * 五条口径：
 *   1. commit 与仓库路径都给**全量**值（`Typography.Text code`），短哈希只在列表里用——
 *      详情栏是用户核对「这一轮测的到底是哪个提交」的地方，这里再省略就等于没地方能看全；
 *   2. 删除提示必须说清「已完成的评测记录会保留」：评测里冗余存了标题 / 仓库 / commit，
 *      这句话是用户敢按下去的依据；
 *   3. `referencedRuns` 为 `null` 时**不显示数字**——把「不知道」显示成 0，会让用户以为删除没有影响；
 *   4. **评分口径只有「评分标准项」这一份真源**：用例的评分表以 `RubricTable` 的 `readOnly` 形态
 *      展示（组 → 评分项：ID / 目标 / 权重），增删改只在使用例表单那一侧；
 *      旧的「评分维度」行与「评分提示词」卡片已随本次重构删除（`judgePrompt` 连契约字段一起没了）
 *      ——照旧渲染它们等于给用户看一个不存在字段；
 *   5. **只有考题提示词走 markdown 渲染**（`MarkdownText`，理由见那张卡片的注释）。
 */
import type { TestCase } from '@aieval/contracts';
import { Button, Card, Descriptions, Flex, Popconfirm, Typography } from 'antd';
import type { DescriptionsProps } from 'antd';
import type { ReactNode } from 'react';
import { formatDateTime } from '../base/format';
import { MarkdownText } from '../base/markdown-text';
import { RubricTable } from './rubric-table';

export interface CaseDetailPanelProps {
  testCase: TestCase;
  /** 引用该用例的评测数；null = 调用方尚不知道这个数（不是 0） */
  referencedRuns: number | null;
  onEdit: () => void;
  /**
   * 删除动作。**必须返回在途请求的 promise**（`() => remove(id)`，而不是 `() => { void remove(id) }`）：
   * antd 的 `ActionButton` 只在 `onConfirm` 返回 thenable 时才等待它——返回 undefined 时确认框会
   * **立刻关闭**，用户看到的是「点一下就没反应」，再点一次就是第二次 DELETE。
   * 若页面确实拿不到 promise（例如删除被交给了别处的状态机），就把 `deleting` 接到入口按钮的
   * `disabled` 上，用禁用代替等待，别让确认框提前关闭。
   */
  onDelete: () => void | Promise<unknown>;
  /** 删除请求在途：给确认按钮上 loading，避免重复点 */
  deleting?: boolean;
}

export function CaseDetailPanel({ testCase, referencedRuns, onEdit, onDelete, deleting = false }: CaseDetailPanelProps): ReactNode {
  const deleteHint =
    referencedRuns === null
      ? '已完成的评测记录会保留（用例标题 / 仓库路径 / commit 已作为快照存在评测里）；用例级缓存仓库会一并删除。'
      : `已被 ${referencedRuns} 个评测引用；评测记录会保留（用例标题 / 仓库路径 / commit 已作为快照存在评测里），用例级缓存仓库会一并删除。`;

  /**
   * 字段表：**分支只在远端用例出现**（`repoBranch !== null`）。
   * 本地用例 / 旧数据渲染出的字段与新增这一列之前**逐字相同**——给它们摆一行「分支：—」等于凭空多一个
   * 让人去猜「为什么是空的」的字段。远端则必须有这一行：分支决定了从哪条历史取起点。
   * 评分标准项**不在这张表里**：一条 Descriptions 行塞不下二级表格，它自己占一张卡片（见下方）。
   */
  const fields: NonNullable<DescriptionsProps['items']> = [
    {
      key: 'repoPath',
      label: '代码仓库',
      // 全量路径 + 可选中复制：右栏可能只有 320px，靠换行而不是省略
      children: <Typography.Text code>{testCase.repoPath}</Typography.Text>,
    },
    ...(testCase.repoBranch === null
      ? []
      : [
        {
          key: 'repoBranch',
          label: '分支',
          children: <Typography.Text code>{testCase.repoBranch}</Typography.Text>,
        },
      ]),
    {
      key: 'commitHash',
      label: 'commit',
      children:
        testCase.commitHash === null ? (
          <Typography.Text type="secondary">默认分支 HEAD</Typography.Text>
        ) : (
          <Typography.Text code>{testCase.commitHash}</Typography.Text>
        ),
    },
    // 评分模型**不在用例上**：这一行是固定文案，回答的是「这个用例拿什么打分」这个必然会被问一次的问题。
    // 写成「跟随全局默认」而不是删掉这一行——删掉之后用户只能去设置页找答案，而这里本来一句话就能说清。
    { key: 'judgeModel', label: '评分模型', children: <Typography.Text type="secondary">跟随全局默认（设置 → 评分配置）</Typography.Text> },
    { key: 'createdAt', label: '创建时间', children: formatDateTime(testCase.createdAt) },
    { key: 'updatedAt', label: '更新时间', children: formatDateTime(testCase.updatedAt) },
  ];

  return (
    <Flex vertical gap={8}>
      <Card
        size="small"
        title={testCase.title}
        extra={
          <Flex gap={8}>
            {/* 两个汉字的标签必须关掉 antd 的自动空格：否则可访问名变成「编 辑」/「删 除」 */}
            <Button size="small" autoInsertSpace={false} data-testid="case-detail-edit" onClick={onEdit}>
              编辑
            </Button>
            <Popconfirm
              title="删除这个用例？"
              description={deleteHint}
              okText="确认删除"
              cancelText="取消"
              okButtonProps={{ danger: true, loading: deleting, autoInsertSpace: false }}
              cancelButtonProps={{ autoInsertSpace: false }}
              onConfirm={onDelete}
            >
              <Button size="small" danger autoInsertSpace={false} data-testid="case-detail-delete">
                删除
              </Button>
            </Popconfirm>
          </Flex>
        }
      >
        {/* antd 6 的 Descriptions 推荐 items（子节点写法已弃用） */}
        <Descriptions size="small" column={1} items={fields} />
      </Card>

      <Card size="small" title="考题提示词">
        {/* 考题提示词是**模型/外部系统写的 markdown**（真实用例里带 14 个标题、23 行表格、6 个围栏
            代码块），所以走 `MarkdownText` 渲染。**卡片的 title / 边框属于卡片本身**，
            这一改只换卡片里的孩子。 */}
        <MarkdownText text={testCase.taskPrompt} />
      </Card>

      {/* 评分标准项（只读）：这一轮拿什么打分，在详情里要能逐项核对（组名 / 目标 / 权重 + 表尾满分）。
          只读形态由 `readOnly` 给（表格不渲染任何输入框与增删控件），故 `onChange` 在这一格**不可达**
          ——props 要求给一个，它留空而不是省略，是为了让「详情页一行数据都不写」在类型上就成立。 */}
      <Card size="small" title="评分标准项">
        <RubricTable value={testCase.rubric} onChange={() => {}} readOnly />
      </Card>
    </Flex>
  );
}
