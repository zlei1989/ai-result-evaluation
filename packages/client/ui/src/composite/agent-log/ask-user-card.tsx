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
 *      问题面板自己**不带边框**（`bordered={false}`）——框由 `Card` 出，面板再画一圈就是框里套框；
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
import { useMemo, type ReactNode } from 'react';
import { Badge } from '../../components/ui/badge';
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from '../../components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../../components/ui/collapsible';
import { ChevronRightIcon } from 'lucide-react';
import { EllipsisText } from '../../base/ellipsis-text';
import { formatDuration } from '../../base/metric-line';
import { useNow } from '../../base/use-now';
import { RawOutputPanel } from './raw-output-panel';
import type { AskUserAnswer, AskUserInteraction, AskUserOutcome, AskUserQuestion } from './types';
import { ASK_USER_OUTCOME_LABELS } from './types';

export interface AskUserCardProps {
  /**
   * 这一块的稳定 id（数据层给的 `mergeKey#块下标`，跨流式帧稳定——`messageId` 每次投递都换新，
   * 不能当身份）。
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

/** 收场徽标：色档与文案都取 `ASK_USER_OUTCOME_LABELS`（`data-tone` 是给用例的稳定判据） */
const OUTCOME_CLASS: Record<AskUserOutcome extends never ? never : 'success' | 'warning' | 'default' | 'error', string> = {
  success: 'border-success/40 text-success',
  warning: 'border-warning/40 text-warning',
  default: 'border-border text-muted-foreground',
  error: 'border-destructive/40 text-destructive',
};

function SettledStatus({ outcome }: { outcome: AskUserOutcome }): ReactNode {
  const meta = ASK_USER_OUTCOME_LABELS[outcome];
  return (
    <Badge variant="outline" className={OUTCOME_CLASS[meta.tone]} data-tone={meta.tone}>
      {meta.label}
    </Badge>
  );
}

/**
 * 面板标题：**问题类型 + 题目**。
 *
 * 两个 Tag 各有事实：`header` 是这一问的名字（空的不画一个空 Tag），「可多选」是作答形态
 * （收起态下它是唯一能看出「这题能多选」的地方——作答区在面板体里）。
 */
function QuestionTitle({ question }: { question: AskUserQuestion }): ReactNode {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1" data-testid="question-title">
      {question.header !== '' && <Badge variant="outline">{question.header}</Badge>}
      {question.multiSelect && <Badge variant="outline">可多选</Badge>}
      {/*
        题目那一格**必须自己可收缩**（`minWidth: 0` + `flex: 1`）——`EllipsisText` 的
        `max-width: 100%` 分母是**整个容器**，不是「扣掉前面两个 Tag 之后的剩余宽度」；
        不套这一层的话，长题目会把两个 Tag 挤到第二行，而它自己到容器宽度才截断。
      */}
      <div className="min-w-0 flex-1">
        {/* 单行省略 + 原生 title 显全量：题目本来就长，截断到一行不改事实（原文可查） */}
        <EllipsisText text={firstLine(question.prompt)} tooltip={question.prompt} />
      </div>
    </div>
  );
}

interface QuestionBodyProps {
  question: AskUserQuestion;
  /** 已收场且答案到手时为那份答案；`null` = 还没收场、或答案没采到（都不画答案区） */
  answer: AskUserAnswer | null;
}

/** 面板体：**选项与作答**（问题类型与题目在面板标题里，这里不再重复画一遍） */
function QuestionBody({ question, answer }: QuestionBodyProps): ReactNode {
  // 契约给的是只读数组；摊平一次并挂住引用
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
      <div className="flex flex-col gap-1">
        {/* 遮罩里选项旁的勾选看不到，故把「选了哪些」写成一句话 */}
        {question.secret && !overridden && selected.length > 0 && (
          <span>{`已选：${selected.join('、')}`}</span>
        )}
        {!question.multiSelect && custom !== null ? (
          <span>{`自由输入（覆盖选项）：${custom}`}</span>
        ) : custom !== null ? (
          <span>{`补充：${custom}`}</span>
        ) : null}
        {unknown.length > 0 && (
          <div className="flex flex-wrap items-center gap-1">
            <span className="text-muted-foreground">选项里没有的：</span>
            {unknown.map((label) => (
              <Badge
                key={label}
                variant="outline"
                className="border-success/40 text-success"
              >
                {label}
              </Badge>
            ))}
          </div>
        )}
      </div>
    );

  /**
   * 作答区：`secret` 的塞进遮罩（见文件头第 9 条），其余原样。
   * 抽成一处是因为下面有**两种外壳**（自由输入那张卡片 / 直接铺在问题下），
   * 各写一份就会有一支漏掉遮罩——`allowOther + secret` 的问题会把答案裸在卡片里。
   */
  const answerArea =
    answerNodes === null ? null : question.secret ? (
      // 遮罩：默认 `••••`，展开即显示（折叠面板代管开合，本层不引入 state）
      <Collapsible data-secret-mask>
        <CollapsibleTrigger className="flex items-center gap-1 text-sm">
          <code className="font-mono">••••</code>
          <span className="text-muted-foreground">显示</span>
        </CollapsibleTrigger>
        <CollapsibleContent>{answerNodes}</CollapsibleContent>
      </Collapsible>
    ) : (
      answerNodes
    );

  return (
    <div className="flex flex-col gap-1">
      {options.length > 0 && (
        <ul className="flex flex-col gap-1" data-testid="question-options">
          {options.map((option) => (
            <li key={option.label} className="flex flex-col">
              <div className="flex flex-wrap items-center gap-1">
                <span>{option.label}</span>
                {option.recommended && <Badge variant="outline">推荐</Badge>}
                {marksVisible && selected.includes(option.label) && (
                  <Badge
                    variant="outline"
                    className="border-success/40 text-success"
                  >
                    已选
                  </Badge>
                )}
              </div>
              {option.description !== null && (
                <span className="text-muted-foreground">{option.description}</span>
              )}
            </li>
          ))}
        </ul>
      )}
      {/*
        「其它（自由输入）」与它的作答区**合成一格卡片**：此前那只是一句悬空的次要文本，
        下面接什么全凭读者猜；卡片给了它标题与边界，「这一格是自由输入」于是有了归属。
        上边距取密度档：它与上面那个选项列表是两件事，
        紧贴着会把卡片的顶边读成列表的一部分。

        **没有自由输入内容就不画这格卡片**（`custom` 为空：还没作答、或答了但没写自己的话）：
        顶着这个标题的空框会让人去里面找东西，而里面什么都没有。不画卡片不等于丢内容——
        作答区的另一半（「选项里没有的」标签）照旧直接铺在问题下（下面那一支）。
      */}
      {question.allowOther && custom !== null ? (
        <Card size="sm" className="mt-snug" data-testid="ask-user-other-card">
          <CardHeader>
            <CardTitle>其它（自由输入）</CardTitle>
          </CardHeader>
          <CardContent>{answerArea}</CardContent>
        </Card>
      ) : (
        // 非「自由输入」的问题，以及没有自由输入内容时：作答区照旧直接铺在问题下面，不多包一层
        answerArea
      )}
    </div>
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
        <span className="inline-flex items-center gap-1" data-status="running">
          <span aria-hidden className="size-1.5 shrink-0 animate-pulse rounded-full bg-info" />
          <span>{atMs === null ? '等待答复中…' : `等待答复中… ${formatDuration(now - atMs)}`}</span>
        </span>
      ) : (
        <span className="text-muted-foreground">结果未采集</span>
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
   * 外面套一层 flex 容器是为了**左对齐**：这一格是动作按钮、不是图标动作，
   * 居中会让它悬在卡片中间、与左上角的卡面标题对不齐；
   * 顺带承担两枚按钮之间的间距（`RawOutputPanel` 不自带容器，见它的口径 7）。
   *
   * **左内边距对齐卡面**：不补这一格按钮组就贴在卡片边框上，
   * 而卡面标题与正文都有自己的横向内边距——于是正文左对齐、footer 却比它多出一个按钮的宽度差。
   */
  const footer =
    rawResult === null ? undefined : (
      <div className="flex flex-wrap items-center gap-2 ps-sm">
        <RawOutputPanel
          source={{ kind: 'single', result: rawResult }}
          open={rawOpen}
          onOpenChange={onRawOpenChange}
          label="原始结果"
          onRetry={onRequestDiagnostics}
        />
      </div>
    );

  return (
    <Card size="sm" data-testid="ask-user-card">
      <CardHeader>
        <CardTitle>
          {/* 自己的锚点（不数卡片内部类名）：卡面标题的**内容口径**由用例守 */}
          <div className="flex flex-col" data-testid="ask-user-card-title">
            <div className="flex flex-wrap items-center gap-1">
              <span>{`问题 ${questions.length} 个`}</span>
              {statusNode}
            </div>
            {hasText(noteLine) && <span className="text-sm text-muted-foreground">{noteLine}</span>}
          </div>
        </CardTitle>
      </CardHeader>

      <CardContent>
        {/* **面板不带自己那层边框**：框由 `Card` 出，面板再画一圈就是框里套框——
            收起态看起来像卡片里嵌了两个小盒子，而每一问本来就只是卡片里的一行。
            这里只留两问之间的一条分隔线。 */}
        <div className="flex flex-col">
          {questions.map((question, index) => {
            const key = questionPanelKey(cardId, index);
            return (
              <Collapsible
                key={key}
                open={openQuestions.has(key)}
                onOpenChange={(next) => onQuestionOpenChange(key, next)}
                className="border-b border-border last:border-b-0"
              >
                <CollapsibleTrigger
                  className="flex w-full min-w-0 items-center gap-1 py-1 text-left text-sm"
                  data-question-panel={index}
                >
                  <ChevronRightIcon
                    aria-hidden
                    className="size-3.5 shrink-0 text-muted-foreground transition-transform data-[panel-open]:rotate-90"
                  />
                  <QuestionTitle question={question} />
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <QuestionBody question={question} answer={paired.byHeader.get(question.header) ?? null} />
                </CollapsibleContent>
              </Collapsible>
            );
          })}
        </div>
        {interaction.state === 'settled' && interaction.answers === null && (
          <span className="text-muted-foreground">答案未采集</span>
        )}
        {paired.unmatched.length > 0 && (
          <div className="mt-2 flex flex-col gap-1">
            <span className="text-muted-foreground">
              {`另有 ${paired.unmatched.length} 份答案没能回填到问题上：`}
            </span>
            {paired.unmatched.map((answer) => (
              <div key={`${answer.header}|${answer.selected.join('、')}`} className="flex flex-wrap items-center gap-1">
                <Badge variant="outline">{answer.header}</Badge>
                {answer.selected.length > 0 && <span>{answer.selected.join('、')}</span>}
                {hasText(answer.custom) && <span>{answer.custom}</span>}
              </div>
            ))}
          </div>
        )}
      </CardContent>

      {/* footer 的内容见上面那个 `footer` 常量（左对齐的理由写在那里） */}
      {footer === undefined ? null : <CardFooter className="ps-sm">{footer}</CardFooter>}
    </Card>
  );
}
