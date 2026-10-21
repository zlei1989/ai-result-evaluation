'use client';

/**
 * 应答弹层：把「智能体正在等你回答」这件事变成一组可点的表单，一题一步，
 * 点最后一问的「完成」时交出一份**与问题逐问对上**的答案。
 *
 * 七条口径（每条都对应一处真实的误读、误操作或走不通的路）：
 *   1. **不点「完成」就不交出**：步进与选择都是本组件自己的 `attempt` state，
 *      上一步 / 关闭 / 遮罩都不产生完成事件——「关掉」不是「回答」，那一问继续留在待答队列里；
 *   2. **一题一步**：一次只画一问，页脚按步切换「下一步 / 完成」，避免把半份答案当成一份交出去；
 *   3. **配对键只有 `header`**（契约里没有 id，也没有下标语义）：`selected` 装的是**选项标签**，
 *      故选项的 `value` 一律用标签、绝不用下标——按下标匹配会把答案配到另一个问题上；
 *   4. **`custom` 与 `selected` 的关系随 `multiSelect` 分档**：多选是**并存**（勾选标签与自由输入
 *      都算），单选是**覆盖**（此时 `selected` 交空数组，且选项整组禁用——写了话再点选项等于给出一个
 *      会被丢掉的选择）。这是产出方一侧的口径，复盘卡片（`agent-log/ask-user-card.tsx`）按同一份
 *      语义回填，两边漂了答卷就对不上；
 *   5. **在途归调用方**：`submitting` 是 prop，本件不认识请求，也就无从知道什么时候在途；
 *      失败后的提示与保持开窗也归调用方（本组件不调接口、不提示错误）；
 *   6. **关闭即丢弃**：`Drawer` 关到底时重置 `attempt`，下次打开是崭新一题。
 *      `Drawer` 没有 `afterClose`，重置点是 `afterOpenChange(false)`；
 *   7. **没有作答面的问题放行空答案**：一问既没有选项、又不允许自由输入时，用户没有任何可表达的答案，
 *      页脚那一枚按钮必须仍然能走（详见 `canAdvance` 处的口径）。
 *
 * `secret` 的遮罩复用复盘卡片的写法（`Collapse` 代管开合，本层不持开合态）：
 * **遮罩是显示口径、不是安全边界**——答案照样按「完成」交出去。
 *
 * **主题与密度不在这里决定**：本件只吃 props，不包 `ConfigProvider`。全站紧凑密度只在
 * `PageShell` 子树里生效，而本弹层的宿主挂在应用根的全局 `Provider` 上、不在任何 `PageShell` 里，
 * 故那一层由**宿主**自己包（两处都包会得到两层密度，谁生效取决于嵌套顺序）。
 */
import { Button, Checkbox, Collapse, Drawer, Flex, Input, Radio, Tag, Typography, theme } from 'antd';
import { useState, type ReactNode } from 'react';
import { BOTTOM_PANEL_SIZE, DRAWER_SEMANTIC_STYLES } from '../base/drawer-geometry';
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

/** 遮罩与 `Collapse` 的稳定键（`Collapse` 的 `items` 要 key） */
const SECRET_KEY = 'secret-answer';

/**
 * 选项候选的渲染模型 → `Radio.Group` / `Checkbox.Group` 的 `options` 项。
 * 标签那一侧塞 `ReactNode`：**描述与「推荐」标记跟着选项走**，少一层手写子节点。
 */
function toOptionNode(option: AskUserOption): { label: ReactNode; value: OptionValue } {
  return {
    value: option.label,
    label: (
      <Flex vertical>
        <Flex align="center" gap={4} wrap>
          <Typography.Text>{option.label}</Typography.Text>
          {option.recommended && <Tag>推荐</Tag>}
        </Flex>
        {option.description !== null && <Typography.Text type="secondary">{option.description}</Typography.Text>}
      </Flex>
    ),
  };
}

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
 * `selected` 的顺序一律**按选项在题目里的出现顺序**（不是点击顺序，也不是 `Checkbox.Group` 出参
 * 的字典序）：复盘卡片按题目顺序渲染选项，答卷换成别的顺序就会看起来像乱序。
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
          // `Checkbox.Group` 的出参是**排过序的**（不是点击顺序）：按选项原顺序归一。
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

export function AskUserPanel({
  open,
  questions,
  submitting,
  onComplete,
  onClose,
  pendingCount,
}: AskUserPanelProps): ReactNode {
  const { token } = theme.useToken();
  /** 这一次作答的草稿；关到底即丢 */
  const [attempt, setAttempt] = useState<Attempt>({ currentHeader: null, picks: {} });

  const firstQuestion = questions[0] ?? null;
  const currentHeader = attempt.currentHeader ?? firstQuestion?.header ?? null;
  const stepIndex = Math.max(
    0,
    questions.findIndex((question) => question.header === currentHeader),
  );
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
   */
  const canAdvance = currentAnswer !== null && (!answerable || hasAnswer(currentAnswer));

  /**
   * 改这一问的草稿：先按 `previous.currentHeader` **重新定位**那一问再合并。
   *
   * 为什么不在闭包里直接用渲染期算好的 `current`：`setAttempt` 的回调可能排在两次渲染之后执行，
   * 而 `questions` 是 props、宿主随时可能换掉它（队列推进就是这种情况）。以渲染期的 `current` 为准，
   * 换题的那一瞬间就会把答案写进上一题的格子里。
   */
  const patchCurrent = (patch: Partial<QuestionDraft>): void => {
    setAttempt((previous) => {
      const header = previous.currentHeader ?? questions[0]?.header ?? null;
      const question = questions.find((item) => item.header === header);
      // 这一问已经不在清单里（题换了）：旧草稿整批作废，宁可让用户重答，也不把答案配错
      if (question === undefined) return { currentHeader: null, picks: {} };
      const draft = previous.picks[question.header] ?? { selected: [], custom: '' };
      return {
        currentHeader: question.header,
        picks: { ...previous.picks, [question.header]: { ...draft, ...patch } },
      };
    });
  };

  /** 「下一步」：只推进到下一问，**不交出任何东西** */
  const goNext = (): void => {
    const next = questions[stepIndex + 1];
    if (next === undefined) return;
    setAttempt((previous) => ({ ...previous, currentHeader: next.header }));
  };

  const goPrev = (): void => {
    const previousQuestion = questions[stepIndex - 1];
    if (previousQuestion === undefined) return;
    setAttempt((previous) => ({ ...previous, currentHeader: previousQuestion.header }));
  };

  /** 「完成」：按 `questions` 的顺序逐问算出答案——顺序与数量都跟着问题，不跟点击顺序 */
  const complete = (): void => {
    onComplete(questions.map((question) => answerOf(question, attempt.picks[question.header])));
  };

  /** 选项候选的渲染模型：标签那一侧塞 ReactNode，描述与「推荐」标记跟着选项走 */
  const optionNodes = (current?.options ?? []).map(toOptionNode);

  /**
   * 单选一栏要不要整组禁用：用户写了自由输入就是「这句话就是全部答案」（覆盖档），
   * 此时再让他点选项等于给出一个**会被丢掉**的选择——禁用比「点了没用」诚实。
   * 多选那一档不禁用：自由输入是补充项，勾选与它一起交出去（见 `answerOf`）。
   * 判据取草稿里的原文（不是算出来的 `custom`）：清空输入框 ⇒ 选项当场恢复可选。
   */
  const optionsLocked = current !== null && !current.multiSelect && customOf(currentDraft) !== null;

  const answerArea =
    current === null ? null : (
      <Flex vertical gap={token.paddingSM}>
        {!hasAnswerSurface(current) && (
          // 没有作答面时正文是空的（空选项组什么都不画），给一行说明：
          // 只有标题 + 一枚能走的按钮，用户不知道「为什么没得选还能点」，也不知道点下去会交出什么
          <Typography.Text type="secondary">
            这一问没有可选的答案（智能体没给选项，也不接受自由输入），直接往下走即可
          </Typography.Text>
        )}
        {current.multiSelect ? (
          <Checkbox.Group
            // 草稿里存的是只读数组（契约口径），`Checkbox.Group` 的 `value` 要可变数组，摊平一次
            value={[...(currentDraft?.selected ?? [])]}
            data-testid="ask-user-options"
            onChange={(checked: OptionValue[]) => patchCurrent({ selected: checked })}
            options={optionNodes}
          />
        ) : (
          <Radio.Group
            // 未选时是 `undefined`（匹配不到任何选项），而不是空串——空串会是一个「叫空串的选项」
            value={currentDraft?.selected[0]}
            data-testid="ask-user-options"
            // 写了自由输入就锁住整组（判据见 `optionsLocked`）；清空输入框即解锁
            disabled={optionsLocked}
            onChange={(event) => patchCurrent({ selected: [event.target.value as OptionValue] })}
            options={optionNodes}
          />
        )}
        {current.allowOther && (
          <Flex vertical gap={token.marginXXS}>
            <Typography.Text type="secondary">
              {current.multiSelect
                ? '补充（自由输入，与上面选中的标签一起算作答）'
                : optionsLocked
                  ? '其它（自由输入，写了它就只交这句话；清空后选项恢复可选）'
                  : '其它（自由输入，写了它就覆盖上面的选项）'}
            </Typography.Text>
            <Input.TextArea
              // 底部弹层的高度有限，多个候选会把选项挤出视野（正文可滚，但读起来就费劲了）
              rows={2}
              value={currentDraft?.custom ?? ''}
              aria-label="自由输入"
              data-testid="ask-user-custom"
              onChange={(event) => patchCurrent({ custom: event.target.value })}
            />
          </Flex>
        )}
      </Flex>
    );

  return (
    <Drawer
      open={open}
      // 底部弹入：本仓此前只用过右侧。`size` 对 bottom 是**高度**，故必须用 bottom 那一档常量
      // （宽度那一档在宽屏上是 800px 起步，当高度用会顶穿视口）
      placement="bottom"
      size={BOTTOM_PANEL_SIZE}
      title={
        current === null
          ? '智能体提问'
          : `第 ${stepIndex + 1}/${questions.length} 题 · ${questionTitle(current)}`
      }
      extra={
        pendingCount !== undefined && pendingCount > 0 ? (
          <Typography.Text type="secondary">{`还有 ${pendingCount} 个待答`}</Typography.Text>
        ) : null
      }
      // 关 ≠ 答：只回调，一个字都不提交
      onClose={onClose}
      // 关掉即卸载：`open === false` 时正文一个节点都不在 DOM 里（不留上一问的答案）
      destroyOnHidden
      mask={{ enabled: true, closable: true }}
      styles={DRAWER_SEMANTIC_STYLES}
      // `Drawer` 没有 `afterClose`：重置点是开合动画结束时的这一格（关到底才丢草稿）
      afterOpenChange={(next) => {
        if (!next) setAttempt({ currentHeader: null, picks: {} });
      }}
      footer={
        <Flex justify="flex-end" gap={token.marginXS}>
          {stepIndex > 0 && (
            <Button size="small" autoInsertSpace={false} data-testid="ask-user-prev" onClick={goPrev}>
              上一步
            </Button>
          )}
          <Button
            size="small"
            type="primary"
            autoInsertSpace={false}
            loading={submitting}
            // 没得答的面放行空答案，其余仍要求先答（判据见 `canAdvance`）
            disabled={submitting || !canAdvance}
            data-testid="ask-user-complete"
            onClick={() => {
              if (isLast) complete();
              else goNext();
            }}
          >
            {isLast ? '完成' : '下一步'}
          </Button>
        </Flex>
      }
    >
      <Flex vertical gap={token.paddingMD} style={{ padding: token.paddingMD }} data-testid="ask-user-panel">
        {current === null ? (
          <Typography.Text type="secondary">没有问题要回答</Typography.Text>
        ) : current.secret ? (
          // 遮罩：默认 `••••`，展开才显示作答区。本层不持开合态（`Collapse` 代管），
          // 与复盘卡片同一条口径——遮罩是显示口径，不是安全边界
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
                children: answerArea,
              },
            ]}
          />
        ) : (
          answerArea
        )}
      </Flex>
    </Drawer>
  );
}
