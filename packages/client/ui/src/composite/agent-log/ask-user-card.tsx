'use client';

/**
 * `ask-user` 族的问答卡片：时间轴上**唯一「会等人」的东西**，而应答面是**按轮显式开启**的
 * （`EvalRun.askUser`；没开的轮次里模型连提问工具都拿不到）。故它的第一职责不是好看，
 * 而是**让「卡在等人回答」一眼可见**。
 *
 * 九条口径（每条都对应一次真实的误读）：
 *   1. **外壳是 `Card`、不是一格折叠面板**：卡面标题只写「问题 N 个」+ 收场态。
 *      **问题类型一个字都不进卡面标题**——`header` 是某一问的事，写在这里会让整张卡片
 *      看起来都属于那一问（两问的卡片上只显示第一问的名字，读者会以为第二问不存在）；
 *   2. **每个问题各占一格折叠面板，默认全部收起**（等待中也不例外）：等待态由卡面那枚
 *      「等待答复中… 12m」承担，不必靠展开；面板标题是**问题类型 + 题目**（`header` Tag +
 *      「可多选」+ 单行省略的 `prompt`），面板体里是**选项与作答**；
 *   3. **「还没收场」是独立的一支**（`state: 'pending'`）：并进七态里的任何一格，
 *      都会把「还在等」说成「已经收场」。`pending` 内部再分两种——
 *      `running === true` 走秒表；`running === false` 是**静态灰字**「结果未采集」
 *      （**不能一直转圈**，否则一次没采到的结果会被永远读成「还在等」）；
 *   4. **答案按 `label` 匹配回填**：`selected` 装的是选项标签，不是 id、也不是下标；
 *   5. **选项里没有的标签原样显示**（多一个 `Tag`）：配不上是事实，
 *      藏起来就成了「答的和问的对不上时界面上看不出来」；
 *   6. **`custom` 与 `selected` 的关系随 `multiSelect` 分档**：多选是**并存**（两半都画），单选是**覆盖**（`custom` 就是全部答案）；
 *      **「其它（自由输入）」那格卡片只在有自由输入内容时出现**（`custom` 为空就不画——不画卡片 ≠ 丢内容，
 *      作答区里的「选项里没有的」照旧直接铺在问题下）；
 *   7. **只读复盘视图**：不提供任何「回答」按钮——应答面在**弹层**（宿主 + 弹层组件），
 *      卡片只回答「当时问了什么、最后怎么收场的」；**原文入口落在卡面 footer**（`Card` 的 `actions`）：
 *      「原始结果」+「重新读取」，没采到原文时整格不画；
 *   8. **不重排选项、不美化 `header`**：`recommended` 的置顶是厂商给的顺序，UI 只加一个 `Tag`；
 *      截断会改事实（与「工具名原样透传」同一口径）；
 *   9. **折叠态一律受控**（本层不持态，见 `agent-log-layering.test.ts` 的 (d)）：一问一格键，
 *      键由 `questionPanelKey` 给（`<卡片 id>|q<序号>`——`header` 可以重复也可以为空，
 *      序号加卡片 id 才是身份）；`secret: true` 的遮罩**是显示口径、不是安全边界**
 *      （原文仍在结果与事件台账里），遮罩用 `Collapse` 的展开来表达「展开即显示」。
 */
import { Badge, Card, Collapse, Flex, Listy, Tag, theme, Typography } from 'antd';
import { useMemo, type ReactNode } from 'react';
import { EllipsisText } from '../../base/ellipsis-text';
import { formatDuration } from '../../base/metric-line';
import { SHRINKABLE_TITLE_STYLE } from '../../base/shrinkable-collapse-title';
import { useNow } from '../../base/use-now';
import { RawOutputPanel } from './raw-output-panel';
import type { AskUserAnswer, AskUserInteraction, AskUserOutcome, AskUserQuestion } from './types';
import { ASK_USER_OUTCOME_LABELS } from './types';

export interface AskUserCardProps {
  /**
   * 这一块的稳定 id（数据层给的 `messageId#块下标`）。
   * 卡片要拿到它是因为**一问一格折叠键**：键必须跨轮唯一，而同一张卡片里的两问也不能撞
   * （`header` 可以重复、也可以为空）——卡片 id 加序号才构成身份。
   */
  cardId: string;
  interaction: AskUserInteraction;
  /** 已展开的问题面板键（`questionPanelKey`）；**受控**（L0 自己不持态） */
  openQuestions: ReadonlySet<string>;
  onQuestionOpenChange(key: string, open: boolean): void;
  /** 底部「原始结果」二级抽屉的开合（**受控透传**：L0 自己不持态） */
  rawOpen: boolean;
  onRawOpenChange(next: boolean): void;
  onRequestDiagnostics?(): void;
}

/**
 * 一个问题的折叠键：`<卡片 id>|q<序号>`。
 *
 * 为什么序号是身份：`header` 是**可以重复也可以为空**的一格（dsh 侧本来就是可选的，见
 * `AskUserQuestion`），拿它当键会让两问共用一个面板——展开一个，另一个跟着开。
 * 卡片 id（块 id）由数据层给定、全仓唯一，故本函数不需要再做任何去重。
 */
export function questionPanelKey(cardId: string, index: number): string {
  return `${cardId}|q${index}`;
}

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

/**
 * 取第一行（`header` 为空时的回落标题）；整段只有空白时原样返回。
 * **应答弹层也用它**：标题取 `header`、为空退回 `prompt` 第一行这条口径两边必须逐字一致，
 * 否则同一问在问答两侧显示成两个不同的名字。
 */
export function firstLine(text: string): string {
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

/**
 * 面板标题：**问题类型 + 题目**。
 *
 * 两个 Tag 各有事实：`header` 是这一问的名字（空的不画一个空 Tag），「可多选」是作答形态
 * （收起态下它是唯一能看出「这题能多选」的地方——作答区在面板体里）。
 */
function QuestionTitle({ question }: { question: AskUserQuestion }): ReactNode {
  return (
    <Flex align="center" gap={4} wrap>
      {question.header !== '' && <Tag>{question.header}</Tag>}
      {question.multiSelect && <Tag>可多选</Tag>}
      {/*
        题目那一格**必须自己可收缩**（`minWidth: 0` + `flex: 1`）——`EllipsisText` 的
        `max-width: 100%` 分母是**整个容器**，不是「扣掉前面两个 Tag 之后的剩余宽度」；
        不套这一层的话，长题目会把两个 Tag 挤到第二行，而它自己到容器宽度才截断。
      */}
      <Flex style={{ minWidth: 0, flex: 1 }}>
        {/* 单行省略 + Tooltip 显全量：题目本来就长，截断到一行不改事实（原文可查） */}
        <EllipsisText text={firstLine(question.prompt)} tooltip={question.prompt} />
      </Flex>
    </Flex>
  );
}

interface QuestionBodyProps {
  question: AskUserQuestion;
  /** 已收场且答案到手时为那份答案；`null` = 还没收场、或答案没采到（都不画答案区） */
  answer: AskUserAnswer | null;
}

/** 面板体：**选项与作答**（问题类型与题目在面板标题里，这里不再重复画一遍） */
function QuestionBody({ question, answer }: QuestionBodyProps): ReactNode {
  const { token } = theme.useToken();
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

  /**
   * 作答区：`secret` 的塞进遮罩（见文件头第 9 条），其余原样。
   * 抽成一处是因为下面有**两种外壳**（自由输入那张卡片 / 直接铺在问题下），
   * 各写一份就会有一支漏掉遮罩——`allowOther + secret` 的问题会把答案裸在卡片里。
   */
  const answerArea =
    answerNodes === null ? null : question.secret ? (
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
    );

  return (
    <Flex vertical gap={4}>
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
      {/*
        「其它（自由输入）」与它的作答区**合成一格卡片**：此前那只是一句悬空的次要文本，
        下面接什么全凭读者猜；卡片给了它标题与边界，「这一格是自由输入」于是有了归属。
        `marginBlockStart` 取 token：它与上面那个选项列表（`Listy`）是两件事，
        紧贴着会把卡片的顶边读成列表的一部分。

        **没有自由输入内容就不画这格卡片**（`custom` 为空：还没作答、或答了但没写自己的话）：
        顶着这个标题的空框会让人去里面找东西，而里面什么都没有。不画卡片不等于丢内容——
        作答区的另一半（「选项里没有的」标签）照旧直接铺在问题下（下面那一支）。
      */}
      {question.allowOther && custom !== null ? (
        <Card size="small" title="其它（自由输入）" style={{ marginBlockStart: token.marginSM }}>
          {answerArea}
        </Card>
      ) : (
        // 非「自由输入」的问题，以及没有自由输入内容时：作答区照旧直接铺在问题下面，不多包一层
        answerArea
      )}
    </Flex>
  );
}

export function AskUserCard({
  cardId,
  interaction,
  openQuestions,
  onQuestionOpenChange,
  rawOpen,
  onRawOpenChange,
  onRequestDiagnostics,
}: AskUserCardProps): ReactNode {
  const { token } = theme.useToken();
  const questions = interaction.questions;
  const atMs = parseAt(interaction.at);
  const waiting = interaction.state === 'pending' && interaction.running;
  // hook 在任何分支之前调用；`waiting === false`（终态 / 结果没到）时不挂定时器
  const now = useNow(waiting && atMs !== null);
  const outcome = interaction.state === 'settled' ? ASK_USER_OUTCOME_LABELS[interaction.outcome] : null;
  const paired = useMemo(
    () => pairAnswers(questions, interaction.state === 'settled' ? interaction.answers : null),
    [questions, interaction],
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

  /** 原文那一份：只有「已收场且原文到手」才有；`pending` 一支连 `result` 这一格都没有 */
  const rawResult = interaction.state === 'settled' ? interaction.result : null;

  /**
   * footer（`Card` 的 `actions`）：只放原文入口——「原始结果」+「重新读取」两枚按钮由
   * `RawOutputPanel` 一并给出（重试那一格在它里面）。没采到原文时给 `undefined` ⇒ 整格不画，不留空边。
   *
   * 外面套一层 `Flex` 是为了**左对齐**：antd 把 `actions` 的每一项摆成居中
   * （`.ant-card-actions > li` 带 `text-align: center`），而这一格是动作按钮、不是图标动作，
   * 居中会让它悬在卡片中间、与左上角的卡面标题对不齐。`Flex` 是块级 flex 容器，
   * `text-align` 管不到它的项，默认就从行首排（不必显式给 `justify`）；
   * 顺带承担两枚按钮之间的间距（`RawOutputPanel` 不自带容器，见它的口径 7）。
   *
   * **左内边距对齐卡面**：`actions` 那一行自己没有左右 padding，不补这一格按钮组就贴在卡片边框上，
   * 而卡面标题与正文都在 `paddingSM` 处（`.ant-card-head` / `.ant-card-body` 的 12px）——
   * 于是正文左对齐、footer 却比它多出一个按钮的宽度差。
   */
  const footer =
    rawResult === null
      ? undefined
      : [
        <Flex key="raw" align="center" gap={8} wrap style={{ paddingInlineStart: token.paddingSM }}>
          <RawOutputPanel
            source={{ kind: 'single', result: rawResult }}
            open={rawOpen}
            onOpenChange={onRawOpenChange}
            label="原始结果"
            onRetry={onRequestDiagnostics}
          />
        </Flex>,
      ];

  return (
    <Card
      size="small"
      data-testid="ask-user-card"
      title={
        // 自己的锚点（不数 antd 的 `.ant-card-head`）：卡面标题的**内容口径**由用例守
        <Flex vertical data-testid="ask-user-card-title">
          <Flex align="center" gap={4} wrap>
            <Typography.Text>{`问题 ${questions.length} 个`}</Typography.Text>
            {statusNode}
          </Flex>
          {hasText(noteLine) && <Typography.Text type="secondary">{noteLine}</Typography.Text>}
        </Flex>
      }
      /*
        footer 的内容见上面那个 `footer` 常量（左对齐的理由写在那里）。
      */
      actions={footer}
    >
      <Collapse
        destroyOnHidden
        /* 面板键是序号（稳定、不随 `header` 重复而漂）；折叠态那一格用 `questionPanelKey` */
        activeKey={questions.flatMap((_, index) => (openQuestions.has(questionPanelKey(cardId, index)) ? [String(index)] : []))}
        onChange={(keys) => {
          // antd 给的是**新的全量开合集合**：逐问对上，只把变化的那一问报出去
          questions.forEach((_, index) => {
            const open = openQuestions.has(questionPanelKey(cardId, index));
            if (keys.includes(String(index)) !== open) onQuestionOpenChange(questionPanelKey(cardId, index), !open);
          });
        }}
        // 标题里是单行省略的题目（`EllipsisText`）：标题不给收缩就会把整行顶宽（见常量处）
        styles={SHRINKABLE_TITLE_STYLE}
        items={questions.map((question, index) => ({
          key: String(index),
          label: <QuestionTitle question={question} />,
          children: <QuestionBody question={question} answer={paired.byHeader.get(question.header) ?? null} />,
        }))}
      />
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
    </Card>
  );
}
