'use client';

/**
 * 用例只读详情（右栏内容）：字段回显 + 评分标准项（只读）+ 考题提示词 + 「编辑」「删除」。
 *
 * 纯展示：不调接口；删除的确认是**内联确认条**（不弹层），真正的删除动作由调用方执行。
 * 五条口径：
 *   1. commit 与仓库路径都给**全量**值（等宽 `<code>`），短哈希只在列表里用——
 *      详情栏是用户核对「这一轮测的到底是哪个提交」的地方，这里再省略就等于没地方能看全；
 *   2. 删除提示必须说清「已完成的评测记录会保留」：评测里冗余存了标题 / 仓库 / commit，
 *      这句话是用户敢按下去的依据；
 *   3. `referencedRuns` 为 `null` 时**不显示数字**——把「不知道」显示成 0，会让用户以为删除没有影响；
 *   4. **评分口径只有「评分标准项」这一份真源**：用例的评分表以 `RubricTable` 的 `readOnly` 形态
 *      展示（组 → 评分项：ID / 目标 / 权重），增删改只在使用例表单那一侧；
 *   5. **只有考题提示词走 markdown 渲染**（`XMarkdownText`，理由见那张卡片的注释）。
 */
import { isNoneSource, type TestCase } from '@aieval/contracts';
import { useState, type ReactNode } from 'react';
import { Alert, AlertDescription, AlertTitle } from '../components/ui/alert';
import { Button } from '../components/ui/button';
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { formatDateTime } from '../base/format';
import { XMarkdownText } from '../base/x-markdown';
import { RubricTable } from './rubric-table';

export interface CaseDetailPanelProps {
  testCase: TestCase;
  /** 引用该用例的评测数；null = 调用方尚不知道这个数（不是 0） */
  referencedRuns: number | null;
  onEdit: () => void;
  /**
   * 删除动作。**返回在途请求的 promise**（`() => remove(id)`，而不是 `() => { void remove(id) }`）：
   * 确认条要等它结束才收起，按钮在途期间保持禁用——返回 undefined 时用户看到的是
   * 「点一下就没反应」，再点一次就是第二次 DELETE。
   * 若页面确实拿不到 promise（例如删除被交给了别处的状态机），就把 `deleting` 接上，
   * 用禁用代替等待。
   */
  onDelete: () => void | Promise<unknown>;
  /** 删除请求在途：给确认按钮上禁用，避免重复点 */
  deleting?: boolean;
}

/** 一条只读字段：`dt` 是标签，`dd` 是值 */
interface DetailField {
  key: string;
  label: string;
  value: ReactNode;
}

export function CaseDetailPanel({
  testCase,
  referencedRuns,
  onEdit,
  onDelete,
  deleting = false,
}: CaseDetailPanelProps): ReactNode {
  // 确认条是否展开：删除是破坏性动作，先问一句，点「确认删除」才真的发请求
  const [confirming, setConfirming] = useState(false);
  // 本次确认的请求是否在途：在途期间禁用两个按钮，避免重复提交
  const [busy, setBusy] = useState(false);

  const deleteHint =
    referencedRuns === null
      ? '已完成的评测记录会保留（用例标题 / 仓库路径 / commit 已作为快照存在评测里）；用例级缓存仓库会一并删除。'
      : `已被 ${referencedRuns} 个评测引用；评测记录会保留（用例标题 / 仓库路径 / commit 已作为快照存在评测里），用例级缓存仓库会一并删除。`;

  /** 确认删除：等调用方交回 promise 再收起确认条；失败原因由调用方提示，这里只收束状态 */
  const handleConfirmDelete = (): void => {
    setBusy(true);
    void Promise.resolve(onDelete()).finally(() => {
      setBusy(false);
      setConfirming(false);
    });
  };

  /**
   * 字段表：**分支只在远端用例出现**（`repoBranch !== null`）。
   * 本地用例 / 旧数据渲染出的字段与新增这一列之前逐字相同——给它们摆一行「分支：—」等于凭空多一个
   * 让人去猜「为什么是空的」的字段。远端则必须有这一行：分支决定了从哪条历史取起点。
   * 评分标准项**不在这张表里**：一条两列表格塞不下二级表格，它自己占一张卡片（见下方）。
   */
  const fields: DetailField[] = [
    {
      key: 'repoPath',
      label: '代码仓库',
      // 全量路径 + 可选中复制：右栏可能只有 320px，靠换行而不是省略。
      // 无来源显示短标签「无」，哨兵串 `none://` 不是给用户看的信息，说全的话放 `title` 里
      value: isNoneSource(testCase.repoPath) ? (
        <code className="font-mono break-all" title="空仓库，无来源代码">
          无
        </code>
      ) : (
        <code className="font-mono break-all">{testCase.repoPath}</code>
      ),
    },
    ...(testCase.repoBranch === null
      ? []
      : [
        {
          key: 'repoBranch',
          label: '分支',
          value: <code className="font-mono break-all">{testCase.repoBranch}</code>,
        },
      ]),
    {
      key: 'commitHash',
      label: 'commit',
      value:
        testCase.commitHash === null ? (
          <span className="text-muted-foreground">默认分支 HEAD</span>
        ) : (
          <code className="font-mono break-all">{testCase.commitHash}</code>
        ),
    },
    // 评分模型**不在用例上**：这一行是固定文案，回答的是「这个用例拿什么打分」这个必然会被问一次的问题。
    // 写成「跟随全局默认」而不是删掉这一行——删掉之后用户只能去设置页找答案，而这里本来一句话就能说清。
    {
      key: 'judgeModel',
      label: '评分模型',
      value: <span className="text-muted-foreground">跟随全局默认（设置 → 评分配置）</span>,
    },
    { key: 'createdAt', label: '创建时间', value: formatDateTime(testCase.createdAt) },
    { key: 'updatedAt', label: '更新时间', value: formatDateTime(testCase.updatedAt) },
  ];

  return (
    <div className="flex flex-col gap-2">
      <Card size="sm" data-testid="case-detail-card">
        <CardHeader>
          <CardTitle className="break-words">{testCase.title}</CardTitle>
          <CardAction>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" data-testid="case-detail-edit" onClick={onEdit}>
                编辑
              </Button>
              <Button
                variant="destructive"
                size="sm"
                data-testid="case-detail-delete"
                disabled={busy || deleting}
                onClick={() => setConfirming(true)}
              >
                删除
              </Button>
            </div>
          </CardAction>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
            {fields.map((field) => (
              <div key={field.key} className="contents">
                <dt className="text-muted-foreground">{field.label}</dt>
                <dd className="min-w-0">{field.value}</dd>
              </div>
            ))}
          </dl>

          {/* 内联确认条：不弹层，位置就在被删对象旁边。提示里那句「评测记录会保留」是用户敢按的依据 */}
          {confirming && (
            <Alert variant="destructive" className="mt-3" data-testid="case-delete-confirm">
              <AlertTitle>删除这个用例？</AlertTitle>
              <AlertDescription>{deleteHint}</AlertDescription>
              <div className="mt-2 flex justify-end gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  data-testid="case-delete-cancel"
                  disabled={busy || deleting}
                  onClick={() => setConfirming(false)}
                >
                  取消
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  data-testid="case-delete-confirm-ok"
                  disabled={busy || deleting}
                  onClick={handleConfirmDelete}
                >
                  确认删除
                </Button>
              </div>
            </Alert>
          )}
        </CardContent>
      </Card>

      <Card size="sm" data-testid="case-task-prompt">
        <CardHeader>
          <CardTitle>考题提示词</CardTitle>
        </CardHeader>
        <CardContent>
          {/* 考题提示词是**模型/外部系统写的 markdown**（真实用例里带 14 个标题、23 行表格、6 个围栏
              代码块），所以走 `XMarkdownText` 渲染；卡片只管标题 / 边框，正文排版归 typeset。
              它是**已经收尾**的静态文本，故 `open={false}`。 */}
          <XMarkdownText text={testCase.taskPrompt} open={false} />
        </CardContent>
      </Card>

      {/* 评分标准项（只读）：这一轮拿什么打分，在详情里要能逐项核对（组名 / 目标 / 权重 + 表尾满分）。
          只读形态由 `readOnly` 给（表格不渲染任何输入框与增删控件），故 `onChange` 在这一格**不可达**
          ——props 要求给一个，它留空而不是省略，是为了让「详情页一行数据都不写」在类型上就成立。 */}
      <Card size="sm" data-testid="case-rubric-detail">
        <CardHeader>
          <CardTitle>评分标准项</CardTitle>
        </CardHeader>
        <CardContent>
          <RubricTable value={testCase.rubric} onChange={() => {}} readOnly />
        </CardContent>
      </Card>
    </div>
  );
}
