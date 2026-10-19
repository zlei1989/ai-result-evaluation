'use client';

/**
 * 应答弹层：把「智能体正在等你回答」这件事变成一组可点的表单，一题一步，
 * 点最后一问的「完成」时交出一份**与问题逐问对上**的答案。
 *
 * 应答面用 `@shadcn/react/questionnaire` 的官方件（`Root` / `Item` / `Choice` / `Input` /
 * `Previous` / `Skip` / `Next` / `Submit`），弹层仍是底部 `Sheet`。七条口径逐条落在这里：
 *   1. **不点「完成」就不交出**：提交只由表单的 `submit` 事件触发，而且只受理**「完成」按钮自己**
 *      触发的提交（`SubmitEvent.submitter` 必须带着本件的完成标记）；拿不到 `submitter` 一律拒收。
 *      官方的 Enter 手势走的是不带 submitter 的 `requestSubmit()`，因此输入框里按 Enter 交不出答案——
 *      非末题只推进、末题什么也不做。叉 / 遮罩 / Esc 走 `Sheet` 的 `onClose`，不上交、不写任何东西——
 *      「关掉」不是「回答」，那一问继续留在待答队列里。关闭按钮刻意放在表单**外面**：表单里出现第二枚
 *      默认 `submit` 的按钮，点「关闭」就会连带交出答案（浏览器的隐式提交不会问你）；
 *   2. **一题一步**：所有问题都登记进同一个表单，官方件用 `hidden` / `inert` 藏掉非当前问，
 *      页脚按步切换「下一步 / 完成」——半份答案交不出去；
 *   3. **配对键只有 `header`**（契约里没有 id，也没有下标语义）：草稿以 `header` 为键，
 *      `Questionnaire.Root` 的受控 `item` 也传 `header`；选项的 `value` 一律用**标签**、绝不用下标——
 *      按下标配对会把答案配到另一个问题上；
 *   4. **`custom` 与 `selected` 的关系随 `multiSelect` 分档**：多选是**并存**（勾选标签与自由输入
 *      都算，选项不禁用），单选是**覆盖**（此时 `selected` 交空数组，且选项逐个 `disabled`——写了话
 *      再点选项等于给出一个会被丢掉的选择）。这是产出方一侧的口径，复盘卡片
 *      （`agent-log/ask-user-card.tsx`）按同一份语义回填，两边漂了答卷就对不上；
 *   5. **在途归调用方**：`submitting` 是 prop，本件不认识请求，也就无从知道什么时候在途；
 *      失败后的提示与保持开窗也归调用方（本组件不调接口、不提示错误）；
 *   6. **关闭即丢弃**：Sheet 关到底时重置 `attempt`，下次打开是崭新一题；
 *      重置点是 `onOpenChangeComplete(false)`（关到底、退场结束那一格），草稿与官方件的内部状态
 *      一起随 `SheetContent` 卸载；
 *   7. **没有作答面的问题放行空答案**：一问既没有选项、又不允许自由输入时，用户没有任何可表达的答案，
 *      页脚那一枚按钮必须仍然能走。官方 `Next` / `Submit` 会先校验当前问（未答且未跳过一律拦下），
 *      所以这一档改用 `Questionnaire.Skip` 承当页脚主按钮：它按「跳过」收场再推进 / 提交，
 *      交出去的那份答卷仍是空答案（见 `renderPrimary` 处的口径）。
 *
 * `secret` 的遮罩用 `Collapsible` 代管开合（本层不持开合态）：
 * **遮罩是显示口径、不是安全边界**——答案照样按「完成」交出去。
 *
 * **主题与密度不在这里决定**：本件只吃 props，不包 `ConfigProvider`。密度由
 * `[data-density]` 的 CSS 变量供给，宿主挂在应用根上拿到的就是 `:root` 的紧凑档；
 * 本件再包一层只会得到两份字号来源。
 *
 * 弹层是**底部 Sheet**：它是一问一答的临时任务面，不是需要打断页面的模态决策；底部弹入保留
 * 背后的页面上下文，也沿用了原先「从下往上」的空间关系。高度上限只写在 `SheetContent` 上，
 * 正文自己滚动，标题与页脚始终可见。
 */
import { Collapsible } from '@base-ui/react/collapsible';
import { Questionnaire } from '@shadcn/react/questionnaire';
import { LoaderCircle, X } from 'lucide-react';
import { useState, type ChangeEvent, type FormEvent, type ReactNode } from 'react';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Field, FieldDescription } from '../components/ui/field';
import { Input } from '../components/ui/input';
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '../components/ui/sheet';
import { firstLine } from './agent-log/ask-user-card';
import type { AskUserAnswer, AskUserOption, AskUserQuestion } from './agent-log/types';

export interface AskUserPanelProps {
  /** 受控开合。关 = 丢弃未提交的输入，不产生任何事件 */
  open: boolean;
  /** 这一次要答的问题（一到多问，逐问推进） */
  questions: readonly AskUserQuestion[];
  /** 「完成」后的请求在途：主按钮转圈并禁用（避免连点两次提交两份答案） */
  submitting: boolean;
  /** 「完成」的唯一出口：交出与 `questions` **逐问对上**的一份答案（数量与顺序都对齐） */
  onComplete: (answers: AskUserAnswer[]) => void;
  /** 叉 / 遮罩 / Esc：不写任何东西、不发请求（「关掉」不是「回答」） */
  onClose: () => void;
  /** 可选：队列里还剩几问（只用于标题右侧的提示，不参与任何判定） */
  pendingCount?: number;
}

/** 一个选项在表单里的值：**选项标签**（`AskUserAnswer.selected` 的语义就是标签，不是下标） */
type OptionValue = string;

/** 用户对某一问写下的草稿。`custom` 原样存，`null` 只在「交出答案」时才出现 */
interface QuestionDraft {
  selected: readonly OptionValue[];
  custom: string;
}

/**
 * 这一次作答的草稿。
 *
 * `currentHeader` 与 `picks` **存在一起**、并跟**这一问的身份**绑死（不用 effect 事后清）：
 * 题换了之后读 `picks` 先比 `currentHeader`，对不上就当空。用 effect 清会在
 * 「题已换、旧草稿还在」的那一帧里画出上一题的答案，而那一帧用户可能正好点「完成」。
 */
interface Attempt {
  /** 正在答的那一问的 `header`；`null` = 还没开始过（空串是合法标题，不能拿来当「没开始」） */
  currentHeader: string | null;
  picks: Readonly<Record<string, QuestionDraft>>;
}

/** 关到底时要回到的初始草稿。同一个空对象复用，读的人一眼知道「这就是丢弃」 */
const EMPTY_ATTEMPT: Attempt = { currentHeader: null, picks: {} };

/** 空白草稿：`custom` 存原文，清空输入框 ⇒ 单选那一档的选项当场恢复可选 */
const EMPTY_DRAFT: QuestionDraft = { selected: [], custom: '' };

/** 选项行：整行可点，选中态由官方件写进输入的 `checked`（不看点击顺序） */
const OPTION_ROW_CLASS =
  'w-full items-start rounded-lg border border-border px-snug py-tight font-normal hover:bg-muted/50';

/**
 * 一问的标题：`header` 为空时退回 `prompt` 的第一行（与复盘卡片同一口径）。
 * **不截断 `header`**——截断会改事实。
 */
function questionTitle(question: AskUserQuestion): string {
  return question.header !== '' ? question.header : firstLine(question.prompt);
}

/** 这一问用户写下的自由输入：`''` / 只有空白 = 没写（两处判定共用它，免得读法漂移） */
function customOf(draft: QuestionDraft | undefined): string | null {
  return draft !== undefined && draft.custom.trim() !== '' ? draft.custom : null;
}

/**
 * 取出这一问的答案；**逐问对上**的那一份数组就是按本函数逐问算出来的。
 *
 * `selected` 的顺序一律**按选项在题目里的出现顺序**（不是点击顺序，也不是选项组的出参顺序）：
 * 复盘卡片按题目顺序渲染选项，答卷换成别的顺序就会看起来像乱序。
 *
 * `custom` 与 `selected` 的关系**按单选 / 多选分档**（与 `AskUserAnswerSchema` 那条口径同源）：
 *   · **单选 = 覆盖**：用户写了话，选项就不再算答案的一部分 ⇒ `selected` 交空数组。留着原选项会让
 *     任何只读 `selected` 的消费方（含厂商那边的工具结果）读到一份自相矛盾的答案；
 *   · **多选 = 并存**：自由输入是**补充项**，勾选的标签与那句话**都**进答卷（少任何一半都丢信息）。
 */
function answerOf(question: AskUserQuestion, draft: QuestionDraft | undefined): AskUserAnswer {
  const custom = customOf(draft);
  const selected =
    draft === undefined
      ? []
      : question.multiSelect
        ? [
          // 选项组的出参顺序随实现而变（不是点击顺序）：按选项原顺序归一。
          // 选项之外的标签原样保留在末尾，不静默改写（配不上是事实，删掉就看不见了）
          ...question.options.filter((option) => draft.selected.includes(option.label)).map((option) => option.label),
          ...draft.selected.filter((label) => !question.options.some((option) => option.label === label)),
        ]
        : custom !== null
          ? []
          : [...draft.selected];
  return { header: question.header, selected, custom };
}

/** 这一份答案算不算「答了」：没选也没输入时「下一步 / 完成」禁用（不占位、不催） */
function hasAnswer(answer: AskUserAnswer): boolean {
  return answer.selected.length > 0 || answer.custom !== null;
}

/**
 * 这一问**有没有作答面**：有选项、或允许自由输入，就算有。
 *
 * 两者都没有时（契约的 `options` 没有下限，随时可能是空数组）用户在这一问上**没有任何可表达的答案**，
 * 「没选也没输入」是它唯一可能的产出——那不是「还没答」，而是「这一问没有可答的面」。
 */
function hasAnswerSurface(question: AskUserQuestion): boolean {
  return question.options.length > 0 || question.allowOther;
}

/** 一个选项的正文：标签、推荐标记与描述跟着选项走，不另写子节点 */
function OptionBody({ option }: { option: AskUserOption }): ReactNode {
  return (
    <span className="flex flex-1 flex-col gap-hair">
      <span className="flex flex-wrap items-center gap-hair">
        <span className="text-body">{option.label}</span>
        {option.recommended && <Badge variant="secondary">推荐</Badge>}
      </span>
      {option.description !== null && (
        <span className="text-sub text-muted-foreground">{option.description}</span>
      )}
    </span>
  );
}

export function AskUserPanel({
  open,
  questions,
  submitting,
  onComplete,
  onClose,
  pendingCount,
}: AskUserPanelProps): ReactNode {
  /** 这一次作答的草稿；关到底即丢 */
  const [attempt, setAttempt] = useState<Attempt>(EMPTY_ATTEMPT);

  const firstQuestion = questions[0] ?? null;
  const currentHeader = attempt.currentHeader ?? firstQuestion?.header ?? null;
  const foundIndex =
    currentHeader === null ? -1 : questions.findIndex((question) => question.header === currentHeader);
  // 题换了 / 这一问已不在清单里：退回第一问（宁可让用户重答，也不把答案配错）
  const stepIndex = foundIndex >= 0 ? foundIndex : 0;
  const current = questions[stepIndex] ?? null;
  const isLast = current !== null && stepIndex === questions.length - 1;
  const currentDraft = current === null ? undefined : attempt.picks[current.header];
  const currentAnswer = current === null ? null : answerOf(current, currentDraft);
  const answerable = current !== null && hasAnswerSurface(current);

  /**
   * 页脚那一枚「下一步 / 完成」能不能走（它是推进与提交的**唯一**出口）。
   *
   * 两档：
   *   · **有作答面** ⇒ 必须有答案（选了标签或写了自由输入）。一次提交是真的钱，而空答案必然只换回
   *     一次「无人应答」，所以不占位、不催；
   *   · **没有作答面** ⇒ 放行空答案（交 `selected: []` + `custom: null`）。若不放行，面板就成了死路：
   *     用户既推进不了也提交不了，整轮只能等提问预算（缺省 10 分钟）到点——而弹层是这一功能唯一的人工
   *     入口。空答案本身就是契约认得的形状（`selected` 可以是空数组、`custom` 可以是 `null`），
   *     所以「没东西可答」如实交一份空答卷即可。
   *
   * 另一条路（显式给「跳过这一问」并把收场落成 `skipped`）不走：`onComplete` 只交答案、提交端点只认
   * `answered`，要让 `skipped` 走出去得同时改契约、端点与宿主三处，与本件「只吃 props」的形状冲突。
   * 官方件的 `Skip` 在这里只是**页脚的推进机制**（空答案本来就是这一问的全部答案），不改变收场方式。
   */
  const canAdvance = currentAnswer !== null && (!answerable || hasAnswer(currentAnswer));

  /**
   * 改某一问的草稿：**按 `header` 定位**那一问再合并，不用渲染期的下标。
   *
   * 为什么不直接用 `current`：`setAttempt` 的回调可能排在两次渲染之后执行，
   * 而 `questions` 是 props、宿主随时可能换掉它（队列推进就是这种情况）。以下标为准，
   * 换题的那一瞬间就会把答案写进上一题的格子里。
   */
  const patchQuestion = (
    header: string,
    patch: (draft: QuestionDraft) => QuestionDraft,
  ): void => {
    setAttempt((previous) => {
      const draft = previous.picks[header] ?? EMPTY_DRAFT;
      return { ...previous, picks: { ...previous.picks, [header]: patch(draft) } };
    });
  };

  /** 单选 / 多选的勾选：多选追加或摘掉，单选只留这一枚（受控 `checked` 由草稿算） */
  const toggleOption = (question: AskUserQuestion, label: string, checked: boolean): void => {
    patchQuestion(question.header, (draft) => ({
      ...draft,
      selected: question.multiSelect
        ? checked
          ? [...draft.selected.filter((item) => item !== label), label]
          : draft.selected.filter((item) => item !== label)
        : checked
          ? [label]
          : [],
    }));
  };

  /** 自由输入：原文进草稿（空白由 `customOf` 判成「没写」，不在这里裁剪） */
  const changeCustom = (question: AskUserQuestion, event: ChangeEvent<HTMLInputElement>): void => {
    patchQuestion(question.header, (draft) => ({ ...draft, custom: event.target.value }));
  };

  /** 官方件的受控 `item` 换了一问：记下这一问的 `header`（配对键只有它） */
  const changeStep = (name: string): void => {
    setAttempt((previous) => ({ ...previous, currentHeader: name }));
  };

  /** 「完成」：按 `questions` 的顺序逐问算出答案——顺序与数量都跟着问题，不跟点击顺序 */
  const complete = (): void => {
    onComplete(questions.map((question) => answerOf(question, attempt.picks[question.header])));
  };

  /**
   * 表单 submit 的唯一入口：**只受理「完成」按钮触发的提交**。
   *
   * 官方件的 Enter 手势（输入框 / 选项上回车）走 `form.requestSubmit()`，它不带 `submitter`；
   * 判据取 `SubmitEvent.submitter` 上的完成标记，拿不到 submitter 或标记对不上就只 `preventDefault`
   * 不交答案——宁可让用户再点一次，也不替他交一份可能只答了一半的问卷。
   * 浏览器对普通 Enter 的隐式提交由官方件自己在 keydown 里 `preventDefault()` 掉，
   * 不会以默认 submit 按钮的身份绕到这里。
   */
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    // 表单提交是原生行为：不拦会让浏览器导航走；交出答案只走这一条路
    event.preventDefault();
    const submitter = (event.nativeEvent as SubmitEvent).submitter;
    if (!(submitter instanceof HTMLElement) || !submitter.hasAttribute('data-ask-user-complete')) return;
    // 在途或主按钮禁用时不再受理第二份（连点与连按都交不出两份答案）
    if (submitting || !canAdvance) return;
    complete();
  };

  /**
   * 单选一栏要不要逐个禁用：用户写了自由输入就是「这句话就是全部答案」（覆盖档），
   * 此时再让他点选项等于给出一个**会被丢掉**的选择——禁用比「点了没用」诚实。
   * 多选那一档不禁用：自由输入是补充项，勾选与它一起交出去（见 `answerOf`）。
   * 判据取草稿里的原文（不是算出来的 `custom`）：清空输入框 ⇒ 选项当场恢复可选。
   */
  const isLocked = (question: AskUserQuestion): boolean =>
    !question.multiSelect && customOf(attempt.picks[question.header]) !== null;

  /** 一问的作答面：官方 `Choices` / `Choice`（选项）+ 官方 `Input`（自由输入） */
  const renderAnswerArea = (question: AskUserQuestion): ReactNode => {
    const draft = attempt.picks[question.header];
    const locked = isLocked(question);
    return (
      <div className="flex flex-col gap-snug">
        {!hasAnswerSurface(question) && (
          // 没有作答面时正文是空的（空选项组什么都不画），给一行说明：
          // 只有标题 + 一枚能走的按钮，用户不知道「为什么没得选还能点」，也不知道点下去会交出什么
          <p className="text-sub text-muted-foreground">
            这一问没有可选的答案（智能体没给选项，也不接受自由输入），直接往下走即可
          </p>
        )}
        {question.options.length > 0 && (
          <Questionnaire.Choices className="grid w-full gap-tight">
            {question.options.map((option) => {
              const checked = draft?.selected.includes(option.label) ?? false;
              return (
                <Questionnaire.Choice
                  key={option.label}
                  // 选项的值 = 标签：答卷的 `selected` 装的就是它，不是下标
                  value={option.label}
                  checked={checked}
                  disabled={locked}
                  onChange={(event) => toggleOption(question, option.label, event.target.checked)}
                  className={locked ? `${OPTION_ROW_CLASS} opacity-50` : OPTION_ROW_CLASS}
                >
                  <Questionnaire.ChoiceInput
                    aria-label={option.label}
                    className="mt-0.5 size-4 shrink-0 accent-primary disabled:cursor-not-allowed disabled:opacity-50"
                  />
                  <Questionnaire.ChoiceLabel>
                    <OptionBody option={option} />
                  </Questionnaire.ChoiceLabel>
                </Questionnaire.Choice>
              );
            })}
          </Questionnaire.Choices>
        )}
        {question.allowOther && (
          <Field className="gap-hair">
            <FieldDescription className="text-sub">
              {question.multiSelect
                ? '补充（自由输入，与上面选中的标签一起算作答）'
                : locked
                  ? '其它（自由输入，写了它就只交这句话；清空后选项恢复可选）'
                  : '其它（自由输入，写了它就覆盖上面的选项）'}
            </FieldDescription>
            <Questionnaire.Input
              value={draft?.custom ?? ''}
              onChange={(event) => changeCustom(question, event)}
              render={<Input data-testid="ask-user-custom" aria-label="自由输入" />}
            />
          </Field>
        )}
      </div>
    );
  };

  /**
   * 页脚主按钮：按当前问的作答面挑官方件——
   *   · 有作答面 + 最后一问 ⇒ `Submit`（表单 submit，带完成标记；`onSubmit` 只认它）；
   *   · 有作答面 + 还有后文 ⇒ `Next`（先校验当前问再推进）；
   *   · 没有作答面 ⇒ `Skip`（空答案就是这一问的全部答案）。`Skip` 在末题会自己
   *     `requestSubmit()`，那条路不带 submitter、会被 `onSubmit` 拒收，所以末题改成**点击当场交出**
   *     （用户点的仍是这枚「完成」，只是不绕表单）；非末题照旧由 `Skip` 推进。
   * 三档都受 `submitting` 与 `canAdvance` 管，连点交不出两份。
   */
  const renderPrimary = (): ReactNode => {
    const label = isLast ? '完成' : '下一步';
    const children = (
      <>
        {submitting && <LoaderCircle className="animate-spin" aria-hidden />}
        {label}
      </>
    );
    const button = (
      <Button
        size="sm"
        disabled={submitting || !canAdvance}
        data-testid="ask-user-complete"
        // `onSubmit` 认这一格：只有带着它的 submitter 才是「用户真的点了完成」
        data-ask-user-complete=""
      />
    );
    if (!answerable) {
      return (
        <Questionnaire.Skip
          render={button}
          // 末题：拦掉官方的 skip + requestSubmit，点击当场交出空答案；
          // 非末题：不传 onClick，让 `Skip` 正常推进
          onClick={
            isLast
              ? (event) => {
                event.preventDefault();
                complete();
              }
              : undefined
          }
        >
          {children}
        </Questionnaire.Skip>
      );
    }
    return isLast ? (
      <Questionnaire.Submit render={button}>{children}</Questionnaire.Submit>
    ) : (
      <Questionnaire.Next render={button}>{children}</Questionnaire.Next>
    );
  };

  return (
    <Sheet
      open={open}
      // 关闭手势（叉 / 遮罩 / Esc）统一回到调用方：本件不持开合态
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      // 关到底（退场结束）才丢草稿：这一格对应的是「下次打开是崭新一题」
      onOpenChangeComplete={(next) => {
        if (!next) setAttempt(EMPTY_ATTEMPT);
      }}
    >
      <SheetContent
        side="bottom"
        data-testid="ask-user-panel"
        // 高度上限只写这一处：底部弹层没有上限时，长问句会把页脚按钮顶出视口
        className="max-h-[min(60vh,560px)] gap-0 rounded-t-xl border-t border-border bg-background p-0 text-foreground"
      >
        <SheetHeader className="relative gap-hair border-b border-border px-roomy py-snug pr-12">
          <SheetTitle className="text-title">
            {current === null
              ? '智能体提问'
              : `第 ${stepIndex + 1}/${questions.length} 题 · ${questionTitle(current)}`}
          </SheetTitle>
          {pendingCount !== undefined && pendingCount > 0 && (
            <span className="text-sub text-muted-foreground">{`还有 ${pendingCount} 个待答`}</span>
          )}
          {/* 关闭在表单外面：表单里的按钮默认 submit，点「关闭」会连答案一起交出去 */}
          <SheetClose
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                className="absolute top-2 right-2"
                aria-label="关闭"
              />
            }
          >
            <X aria-hidden />
          </SheetClose>
        </SheetHeader>
        {current === null ? (
          <div className="min-h-0 flex-1 overflow-y-auto px-roomy py-snug">
            <p className="text-sub text-muted-foreground">没有问题要回答</p>
          </div>
        ) : (
          <Questionnaire.Root
            // 受控项就是当前问的 `header`：配对键只有它，换题不靠下标
            item={current.header}
            onItemChange={changeStep}
            onSubmit={submit}
            className="flex min-h-0 flex-1 flex-col"
          >
            <Questionnaire.Progress
              className="sr-only"
              // 官方件的默认可访问名与 `aria-valuetext` 是英文；这里给中文，读屏才不会中英夹着念
              aria-label="答题进度"
              aria-valuetext={`第 ${stepIndex + 1}/${questions.length} 题`}
            >
              {`第 ${stepIndex + 1}/${questions.length} 题`}
            </Questionnaire.Progress>
            <div className="min-h-0 flex-1 overflow-y-auto px-roomy py-snug">
              {questions.map((question) => (
                <Questionnaire.Item
                  key={question.header}
                  // 登记名与配对键是同一个值；官方件靠它决定哪一问是当前问
                  name={question.header}
                  multiple={question.multiSelect}
                  // 有作答面才要求作答：没有作答面的那一档要能放行空答案（判据见 `canAdvance`）
                  required={hasAnswerSurface(question)}
                  className="m-0 min-w-0 border-0 p-0"
                >
                  <Questionnaire.Title className="sr-only">
                    {questionTitle(question)}
                  </Questionnaire.Title>
                  {question.secret ? (
                    // 遮罩：默认 `••••`，展开才显示作答区。本层不持开合态（`Collapsible` 代管），
                    // 与复盘卡片同一条口径——遮罩是显示口径，不是安全边界
                    <Collapsible.Root defaultOpen={false}>
                      <Collapsible.Trigger className="flex items-center gap-tight rounded-md px-1 py-0.5 text-left outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50">
                        <span className="font-mono text-body">••••</span>
                        <span className="text-sub text-muted-foreground">显示</span>
                      </Collapsible.Trigger>
                      <Collapsible.Panel className="pt-snug">{renderAnswerArea(question)}</Collapsible.Panel>
                    </Collapsible.Root>
                  ) : (
                    renderAnswerArea(question)
                  )}
                </Questionnaire.Item>
              ))}
            </div>
            <SheetFooter className="flex-row items-center justify-end gap-tight border-t border-border px-roomy py-snug">
              {stepIndex > 0 && (
                <Questionnaire.Previous
                  render={<Button size="sm" variant="outline" data-testid="ask-user-prev" />}
                >
                  上一步
                </Questionnaire.Previous>
              )}
              {renderPrimary()}
            </SheetFooter>
          </Questionnaire.Root>
        )}
      </SheetContent>
    </Sheet>
  );
}
