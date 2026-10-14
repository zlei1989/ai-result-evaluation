/**
 * **族载荷的归一**：`task` / `ask-user` 两族的厂商原始入参 → 契约的 `ToolCallPayload`
 * 。
 *
 * 为什么这一层必须住在 agents 里：`ToolCallBlock.input` 是**厂商原文**，而这两族的载荷
 * 过去没有归一 ⇒ 「这一坨是 `todos` 还是 `plan`」「这个布尔叫 `multiSelect` 还是 `multi_select`」
 * 这些判断住在了界面的 `build-model.ts` 里。那是把厂商适配搬进浏览器：厂商改一个字段名，
 * 症状是界面上**静默**少一张卡片或少一个「可多选」Tag，而所有包的用例照样全绿。
 *
 * 三家的原始形状（映射表，逐条都有实测来源）：
 *
 * | 族 | cc | dsh | codex |
 * |---|---|---|---|
 * | `task` | `TodoWrite` 的 `{todos: [{content, status}]}`；`Task*` 那套工作项注册表是**逐条 patch**，整表在 `providers/cc/task-registry.ts` 里按 run 累积（本模块只吃单次入参，看不到历史） | `todo_write` 的 `{todos: [{content, status}]}`（整表覆盖） | `update_plan` 的 `{explanation?, plan: [{step, status}]}` |
 * | `ask-user` | `AskUserQuestion` 的 `{questions: [{id, question, header, options[], multiSelect}]}` | `ask_user_question` 的 `{questions: [{id, question, header?, options[]?, multi_select?}]}` | `request_user_input` 的 `{questions: [{id, header, question, options[]}]}` + 答案侧的 `isOther` / `isSecret` |
 *
 * 四条取值口径（每一条都对应一次真实的误读）：
 *   1. **认不出就 `null`，绝不猜**：形状对不上时给通用工具行，调用照样在界面上留痕；
 *      猜一个空清单出来会把那次调用**整条顶掉**（看不见了）；
 *   2. **族是权威**：`family === 'task'` 时只找清单形状，喂进来一个问题数组记 `null`——
 *      不因为「形状像另一族」就改判（改判等于让适配器的归族白做）；
 *   3. **`unknown` 是独立的一档**：认不出的状态落 `unknown`（既不是待办也不是完成）；
 *      claude 独有的 `deleted` 也落它——当 `completed` 是撒谎，当 `pending` 是它明明已被删除。
 *      （`deleted` 在**整表**形状里落 `unknown`：它还在这张表里；在 cc 那套**逐条 patch** 的台账里
 *      按**移除**处置——那正是这个指令的语义，见 `providers/cc/task-registry.ts`。两处都未在真机观测到。）
 *   4. **缺的格记 `null`，不编 0 / 空串**。唯一的例外是 `subject` 与 `header`：它们在三家
 *      都可能**本身就是空串**（厂商给了空），那时保留空串而不是改写成 `null`。
 *
 * **`allowOther` 成立有两条路**（`vendor` 因此是必填入参，不能从工具名反推）：
 *   · **题目上声明**：codex 的 `isOther`、pi 的 `allowOther`（后者是我们注册的宿主工具，schema 由我们写）；
 *   · **答案面固有**：cc 的提问工具入参里没有这一格（它的 schema 逐字写着「不要给 'Other' 选项，
 *     那个界面上自动提供」），dsh 的答复项恒带可选 `custom`
 *     （源码：`...answer.custom !== undefined ? { custom: answer.custom } : {}`）⇒ 这两家恒 `true`。
 *     判据是**答复形状**而不是提问形状：这一格问的是「用户能不能自己写一句话」，这两家无论题目
 *     怎么写都收得下那句话——cc 真机读数逐字 `The user answered: "…"="<自由输入>"`。
 *
 * 输入允许是 **JSON 字符串**（codex 与 dsh 的 `arguments` 在归一前就是字符串）
 * 或已经是对象；坏 JSON 与标量一律按「认不出」处置（`null`），**不抛**。
 */
import type { AgentKind, AskUserQuestion, TaskStep, ToolCallPayload, ToolFamily } from '@aieval/contracts';

/**
 * 取 `input` 的结构化半边。
 * 字符串先试 `JSON.parse`（坏 JSON ⇒ `null`）；对象直接用；数组与标量都记「不是清单形状」。
 */
function structuredOf(input: unknown): Record<string, unknown> | null {
  if (typeof input === 'string') {
    try {
      const parsed: unknown = JSON.parse(input);
      return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }
  return typeof input === 'object' && input !== null && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : null;
}

function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** 一个 JSON 对象（数组与标量都不是）；拿不到给空对象，让下游的 `??` 链走到「都没有」 */
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/**
 * 厂商的状态取值 → 契约四态（**三家的并集**）：
 * `completed` / `in_progress` / `inProgress` / `pending` / `todo`。
 * 其余一律 `unknown`——**不猜成成功**（把 `deleted` 读成「完成」会让一张已经撤销的清单显示成做完）。
 *
 * **这是族里唯一一处状态映射**：整表形状（`todos` / `plan` / `steps`）与 claude 那套
 * **逐条 patch** 的 `Task*` 注册表（见 `providers/cc/task-registry.ts`）都读它——
 * 两处各写一份必然漂，漂的表现是「同一个状态串在某一家显示成进行中、在另一家显示成未知」。
 */
export function taskStepStatusOf(status: string | null): TaskStep['status'] {
  if (status === 'completed') return 'completed';
  if (status === 'in_progress' || status === 'inProgress') return 'inProgress';
  if (status === 'pending' || status === 'todo') return 'pending';
  return 'unknown';
}

/**
 * 清单一项的状态：除了上面那四个字面量，还认 claude 的 `completed: true` 写法
 * （`TodoWrite` 的历史形状）。
 */
function stepStatusOf(item: Record<string, unknown>): TaskStep['status'] {
  if (item.completed === true) return 'completed';
  return taskStepStatusOf(asString(item.status));
}

/**
 * 清单一步的正文取值（四个名字，逐家来源）：`subject`（契约名）、`text`、
 * `content`（claude `TodoWrite` 与 dsh `todo_write`）、`step`（**codex `update_plan`**）。
 * 都没有时给空串——那是「厂商给了空」，不是「没采到」。
 */
function stepSubjectOf(item: Record<string, unknown>): string {
  return asString(item.subject) ?? asString(item.text) ?? asString(item.content) ?? asString(item.step) ?? '';
}

function taskStepOf(raw: unknown): TaskStep {
  const item = asRecord(raw);
  return {
    id: asString(item.id),
    subject: stepSubjectOf(item),
    status: stepStatusOf(item),
    owner: asString(item.owner),
    // 依赖表认不出来时是 `null`（「这家没有这个概念」），不是空表（那是「有概念、当前没有依赖」）
    blockedBy: Array.isArray(item.blockedBy) ? item.blockedBy.filter((value) => typeof value === 'string') : null,
  };
}

/**
 * 清单形状 → `plan` 载荷。
 *
 * 三种键名都认：`todos`（claude `TodoWrite` / dsh `todo_write`）、`plan`（codex `update_plan`）、
 * `steps`（规范初稿的写法，实测未见于三家，保留是为了不让历史记录整条落空）。
 * **一个都不在 ⇒ `null`**：那是「这次调用不是清单」，而不是「清单是空的」。
 */
function planPayloadOf(structured: Record<string, unknown>): ToolCallPayload | null {
  const hasPlan = 'todos' in structured || 'plan' in structured || 'steps' in structured;
  if (!hasPlan) return null;
  const rawSteps = asArray(structured.todos ?? structured.plan ?? structured.steps);
  return {
    kind: 'plan',
    steps: rawSteps.map(taskStepOf),
    // codex 的 `explanation`（为什么改计划；**app-server 通道下本仓窄声明未收这一格 ⇒ `note` 恒 `null`**，仅历史 `codex exec` 记录里有）；另两家没有这一格 ⇒ `null`
    note: asString(structured.explanation),
  };
}

function optionOf(raw: unknown): AskUserQuestion['options'][number] {
  const option = asRecord(raw);
  return {
    label: asString(option.label) ?? '',
    description: asString(option.description),
    // 三家里 codex 直接给 `recommended`；claude / dsh 用「放在首位」表达（见下面的模块头）
    recommended: option.recommended === true,
  };
}

/**
 * 这一家的**答案面**是否恒收得下用户自己写的话（见模块头那两条路）。只有这两家成立：
 * cc 的提问由 CLI 自己的界面兜底「Other」、dsh 的答复项恒带可选 `custom`；
 * 另两家由厂商（codex）或我们自己（pi）在题目上声明，不看这一格。
 */
function answerSurfaceTakesFreeText(vendor: AgentKind): boolean {
  return vendor === 'cc' || vendor === 'dsh';
}

function questionOf(raw: unknown, vendor: AgentKind): AskUserQuestion {
  const item = asRecord(raw);
  return {
    header: asString(item.header) ?? '',
    prompt: asString(item.question) ?? asString(item.prompt) ?? '',
    options: asArray(item.options).map(optionOf),
    // `multi_select` 是 dsh 的写法：只认驼峰版本会让它的多选静默显示成单选
    multiSelect: item.multiSelect === true || item.multi_select === true,
    // codex 的 `isOther` 与 pi 的 `allowOther` 是同一件事的两种拼法；cc / dsh 另有答案面这一处来源
    allowOther: item.allowOther === true || item.isOther === true || answerSurfaceTakesFreeText(vendor),
    secret: item.secret === true || item.isSecret === true,
  };
}

/**
 * 问答形状 → `ask-user` 载荷；没有 `questions` 键 ⇒ `null`（不是这一族）。
 * `vendor` 只影响 `allowOther` 那一格（见模块头）——两家答案面固有自由输入的家靠它把这一格点亮。
 */
function askUserPayloadOf(structured: Record<string, unknown>, vendor: AgentKind): ToolCallPayload | null {
  if (!('questions' in structured)) return null;
  return { kind: 'ask-user', questions: asArray(structured.questions).map((raw) => questionOf(raw, vendor)) };
}

/**
 * 一次工具调用的族载荷。`family` 为 `null`（适配器不认识这个工具）或不属于本期两族时一律 `null`——
 * 其余八族今天没有卡片，**不替它们猜**（猜出来的卡片会把工具行顶掉）。
 *
 * `vendor` 必填（不是可选、也不是按工具名反推）：`allowOther` 那一格要看**这一家**的答案面
 * （见模块头），反推会在同名工具跨家出现时静默给错这一格——而错的那一格正是「弹层有没有自由输入」。
 */
export function toolPayloadOf(family: ToolFamily | null, input: unknown, vendor: AgentKind): ToolCallPayload | null {
  if (family !== 'task' && family !== 'ask-user') return null;
  const structured = structuredOf(input);
  if (structured === null) return null;
  return family === 'task' ? planPayloadOf(structured) : askUserPayloadOf(structured, vendor);
}
