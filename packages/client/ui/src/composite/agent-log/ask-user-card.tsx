'use client';

/**
 * `ask-user` 族的问答卡片：时间轴上**唯一「会等人」的东西**，而本仓恰恰是无人值守
 * （`approvalPolicy: 'never'`，没有应答面）。故它的第一职责不是好看，
 * 而是**让「卡在等人回答」一眼可见**。
 *
 * 七条口径（每条都对应一次真实的误读）：
 *   1. **「还没收场」是独立的一支**（`state: 'pending'`）：并进七态里的任何一格，
 *      都会把「还在等」说成「已经收场」。`pending` 内部再分两种——
 *      `running === true` 走秒表；`running === false` 是**静态灰字**「结果未采集」
 *      （**不能一直转圈**，否则一次没采到的结果会被永远读成「还在等」）；
 *   2. **答案按 `label` 匹配回填**：`selected` 装的是选项标签，不是 id、也不是下标；
 *   3. **选项里没有的标签原样显示**（多一个 `Tag`）：配不上是事实，
 *      藏起来就成了「答的和问的对不上时界面上看不出来」；
 *   4. **`custom` 的语义随 `multiSelect` 变**：多选是**补充**，单选是**覆盖**；
 *   5. **只读复盘视图**：不提供任何「回答」按钮（本仓没有应答 handler，
 *      `approvalPolicy: 'never'`），没有应答面就没有可用的输入框；
 *   6. **不重排选项、不美化截断 `header`**：`recommended` 的置顶是厂商给的顺序，UI 只加一个 `Tag`；
 *      截断会改事实（与「工具名原样透传」同一口径）；
 *   7. `secret: true` 的遮罩**是显示口径、不是安全边界**（原文仍在结果与事件台账里）。
 *      遮罩用 `Collapse` 的展开来表达「展开即显示」——本层不持任何开合态。
 */
import { Badge, Collapse, Flex, Listy, Tag, Typography } from 'antd';
import { useMemo, type ReactNode } from 'react';
import { EllipsisText } from '../../base/ellipsis-text';
import { formatDuration } from '../../base/metric-line';
import { useNow } from '../../base/use-now';
import { RawOutputPanel } from './raw-output-panel';
import type { AskUserAnswer, AskUserInteraction, AskUserOutcome, AskUserQuestion } from './types';
import { ASK_USER_OUTCOME_LABELS } from './types';

export interface AskUserCardProps {
  interaction: AskUserInteraction;
  open: boolean;
  onOpenChange(next: boolean): void;
  /** 底部「原始结果」二级抽屉的开合（**受控透传**：L0 自己不持态） */
  rawOpen: boolean;
  onRawOpenChange(next: boolean): void;
  onRequestDiagnostics?(): void;
}

const PANEL_KEY = 'ask-user';
const SECRET_KEY = 'secret-answer';

/** 非空判定：契约里 `null` = 没采到，空串同样是「没有这句话」 */
function hasText(value: string | null): value is string {
  return value !== null && value !== '';
}

/** ISO 时刻 → 毫秒；缺失或非法时 `null`（等待时长宁可不说，也不给 NaN） */
function parseAt(iso: string): number | null {
  if (iso === '') return null;
  const ms = new Date(iso).getTime();
  return Number.isNaN(ms) ? null : ms;
}

/** 取第一行（`header` 为空时的回落标题）；整段只有空白时原样返回 */
function firstLine(text: string): string {
  const first = text.split('\n')[0]?.trim() ?? '';
  return first === '' ? text.trim() : first;
}

interface PairedAnswers {
  byHeader: ReadonlyMap<string, AskUserAnswer>;
  /** 对不上问题的、以及同一个 `header` 的第二份答案：**不静默丢弃** */
  unmatched: readonly AskUserAnswer[];
}

/**
 * 逐问配答案：`AskUserAnswer.header` 是契约里**唯一**的配对键（没有 id，也没有下标语义）。
 * 按 `header` 配不上的答案收进 `unmatched` 原样列出——「答的和问的对不上」是事实。
 */
function pairAnswers(
  questions: readonly AskUserQuestion[],
  answers: readonly AskUserAnswer[] | null,
): PairedAnswers {
  if (answers === null) return { byHeader: new Map(), unmatched: [] };
  const asked = new Set(questions.map((question) => question.header));
  const byHeader = new Map<string, AskUserAnswer>();
  const unmatched: AskUserAnswer[] = [];
  for (const answer of answers) {
    if (!asked.has(answer.header) || byHeader.has(answer.header)) unmatched.push(answer);
    else byHeader.set(answer.header, answer);
  }
  return { byHeader, unmatched };
}

/** 收场 Tag：色档与文案都取 `ASK_USER_OUTCOME_LABELS`，`default` 档就是中性（不传 `color`） */
function SettledStatus({ outcome }: { outcome: AskUserOutcome }): ReactNode {
  const meta = ASK_USER_OUTCOME_LABELS[outcome];
  return <Tag color={meta.tone === 'default' ? undefined : meta.tone}>{meta.label}</Tag>;
}

interface QuestionViewProps {
  question: AskUserQuestion;
  /** 已收场且答案到手时为那份答案；`null` = 还没收场、或答案没采到（都不画答案区） */
  answer: AskUserAnswer | null;
}

/** 一个问题：`header` + 正文 + 选项（+ 答案回填） */
function QuestionView({ question, answer }: QuestionViewProps): ReactNode {
  // `Listy` 要 `T[]`，而契约给的是只读数组；摊平一次并挂住引用
  const options = useMemo(() => [...question.options], [question.options]);
  const selected = answer === null ? [] : answer.selected;
  const custom = answer !== null && hasText(answer.custom) ? answer.custom : null;
  /** 单选 + 自由输入 ⇒ **覆盖**：选项上的「已选」不再显示 */
  const overridden = !question.multiSelect && custom !== null;
  /** `secret` 时勾选标也不画（它同样泄漏答案）：整份答案一起进遮罩里 */
  const marksVisible = !overridden && !question.secret;
  const known = new Set(question.options.map((option) => option.label));
  const unknown = selected.filter((label) => !known.has(label));

  const answerNodes =
    answer === null ? null : (
      <Flex vertical gap={4}>
        {/* 遮罩里选项旁的勾选看不到，故把「选了哪些」写成一句话 */}
        {question.secret && !overridden && selected.length > 0 && (
          <Typography.Text>{`已选：${selected.join('、')}`}</Typography.Text>
        )}
        {!question.multiSelect && custom !== null ? (
          <Typography.Text>{`自由输入（覆盖选项）：${custom}`}</Typography.Text>
        ) : custom !== null ? (
          <Typography.Text>{`补充：${custom}`}</Typography.Text>
        ) : null}
        {unknown.length > 0 && (
          <Flex align="center" gap={4} wrap>
            <Typography.Text type="secondary">选项里没有的：</Typography.Text>
            {unknown.map((label) => (
              <Tag key={label} color="success">
                {label}
              </Tag>
            ))}
          </Flex>
        )}
      </Flex>
    );

  return (
    <Flex vertical gap={4}>
      <Flex align="center" gap={4} wrap>
        {/* 空 `header` 不画一个空 Tag：「没有标题」不是一句标题 */}
        {question.header !== '' && <Tag>{question.header}</Tag>}
        {question.multiSelect && <Tag>可多选</Tag>}
      </Flex>
      <Typography.Paragraph>{question.prompt}</Typography.Paragraph>
      {options.length > 0 && (
        <Listy
          items={options}
          rowKey={(option) => option.label}
          itemRender={(option) => (
            <Flex vertical>
              <Flex align="center" gap={4} wrap>
                <Typography.Text>{option.label}</Typography.Text>
                {option.recommended && <Tag>推荐</Tag>}
                {marksVisible && selected.includes(option.label) && <Tag color="success">已选</Tag>}
              </Flex>
              {option.description !== null && <Typography.Text type="secondary">{option.description}</Typography.Text>}
            </Flex>
          )}
        />
      )}
      {question.allowOther && <Typography.Text type="secondary">其它（自由输入）</Typography.Text>}
      {answerNodes !== null &&
        (question.secret ? (
          // 遮罩：默认 `••••`，展开即显示（`Collapse` 代管开合，本层不引入 state）
          <Collapse
            ghost
            destroyOnHidden
            items={[
              {
                key: SECRET_KEY,
                label: (
                  <Flex align="center" gap={4}>
                    <Typography.Text code>••••</Typography.Text>
                    <Typography.Text type="secondary">显示</Typography.Text>
                  </Flex>
                ),
                children: answerNodes,
              },
            ]}
          />
        ) : (
          answerNodes
        ))}
    </Flex>
  );
}

export function AskUserCard({
  interaction,
  open,
  onOpenChange,
  rawOpen,
  onRawOpenChange,
  onRequestDiagnostics,
}: AskUserCardProps): ReactNode {
  const questions = interaction.questions;
  const firstQuestion = questions[0] ?? null;
  const atMs = parseAt(interaction.at);
  const waiting = interaction.state === 'pending' && interaction.running;
  // hook 在任何分支之前调用；`waiting === false`（终态 / 结果没到）时不挂定时器
  const now = useNow(waiting && atMs !== null);
  const outcome = interaction.state === 'settled' ? ASK_USER_OUTCOME_LABELS[interaction.outcome] : null;
  const paired = useMemo(
    () => pairAnswers(questions, interaction.state === 'settled' ? interaction.answers : null),
    [questions, interaction],
  );

  const titleNode =
    firstQuestion === null ? null : firstQuestion.header !== '' ? (
      <Typography.Text type="secondary">{firstQuestion.header}</Typography.Text>
    ) : (
      // `header` 为空时用**截断到一行**的 `prompt`（prompt 本来就长；header 本身一个字都不动）
      <EllipsisText text={firstLine(firstQuestion.prompt)} tooltip={firstQuestion.prompt} />
    );

  const statusNode: ReactNode =
    interaction.state === 'pending' ? (
      interaction.running ? (
        <Flex align="center" gap={4}>
          <Badge size="small" status="processing" />
          <Typography.Text>
            {atMs === null ? '等待答复中…' : `等待答复中… ${formatDuration(now - atMs)}`}
          </Typography.Text>
        </Flex>
      ) : (
        <Typography.Text type="secondary">结果未采集</Typography.Text>
      )
    ) : (
      // `unavailable` / `skipped` / `canceled` 的色档是 `default`（中性）：它们**不是红色错误**
      <SettledStatus outcome={interaction.outcome} />
    );

  /**
   * 收场行的那一句说明。
   * `pending && !running`（轮次已结束、结果没到）**不给**「会一直等到轮次被取消」——
   * 轮次已经结束了，那句话当场就是假的；这一支只留「结果未采集」。
   */
  const noteLine =
    interaction.state === 'pending'
      ? interaction.running
        ? '无人值守的运行里，这一步会一直等到轮次被取消'
        : null
      : (outcome?.note ?? null);

  return (
    <Collapse
      destroyOnHidden
      activeKey={open ? [PANEL_KEY] : []}
      onChange={(keys) => onOpenChange(keys.length > 0)}
      items={[
        {
          key: PANEL_KEY,
          label: (
            <Flex vertical>
              <Flex align="center" gap={4} wrap>
                <Typography.Text>{`问题 ${questions.length} 个`}</Typography.Text>
                {titleNode}
                {statusNode}
              </Flex>
              {hasText(noteLine) && <Typography.Text type="secondary">{noteLine}</Typography.Text>}
            </Flex>
          ),
          children: (
            <Flex vertical gap={8}>
              {questions.map((question, index) => (
                // 问题的稳定键只有 `header`（契约没给 id）；重复标题时靠序号兜底，**不用它做配对**
                <QuestionView
                  key={`${index}|${question.header}`}
                  question={question}
                  answer={paired.byHeader.get(question.header) ?? null}
                />
              ))}
              {interaction.state === 'settled' && interaction.answers === null && (
                <Typography.Text type="secondary">答案未采集</Typography.Text>
              )}
              {paired.unmatched.length > 0 && (
                <Flex vertical gap={4}>
                  <Typography.Text type="secondary">
                    {`另有 ${paired.unmatched.length} 份答案没能回填到问题上：`}
                  </Typography.Text>
                  {paired.unmatched.map((answer) => (
                    <Flex key={`${answer.header}|${answer.selected.join('、')}`} align="center" gap={4} wrap>
                      <Tag>{answer.header}</Tag>
                      {answer.selected.length > 0 && <Typography.Text>{answer.selected.join('、')}</Typography.Text>}
                      {hasText(answer.custom) && <Typography.Text>{answer.custom}</Typography.Text>}
                    </Flex>
                  ))}
                </Flex>
              )}
              {/* 归一化是视图，原文才是事实。`pending` 一支**没有** `result` 这一格（契约如此）：
                  「还没收场」时连原文都还没有，也就没有可查的东西 */}
              {interaction.state === 'settled' && interaction.result !== null && (
                <RawOutputPanel
                  source={{ kind: 'single', result: interaction.result }}
                  open={rawOpen}
                  onOpenChange={onRawOpenChange}
                  label="原始结果"
                  onRetry={onRequestDiagnostics}
                />
              )}
            </Flex>
          ),
        },
      ]}
    />
  );
}
