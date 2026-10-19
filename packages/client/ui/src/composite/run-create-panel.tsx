'use client';

/**
 * 创建评测表单：用例 + 执行模式 + 使用智能体评分 + 候选行（数组字段）。
 * 四条口径：
 *   1. 模型候选池按**行内的智能体**过滤——池子由 `modelOptionsFor` 注入，
 *      本组件里没有「哪家智能体配哪种协议」这张表（那是 agents 注册表的事，A3）；
 *   2. 池子为空时**当场**给内联 Alert 与出路，而不是等人点了创建才在服务端炸；
 *   3. 模型的 Select 值编码成 `providerId::modelId`：两个不同供应商可能有同名模型，
 *      只存 modelId 会让提交的 providerId 无解。分隔符用 `::`——UUID 不含冒号，
 *      模型名里常见的是单个 `:` 与 `/`；解析时按**第一个**`::` 切，模型名里即使含 `::` 也能还原；
 *   4. 「使用智能体评分」默认**关闭**（用户口径），且开关打开而设置页没配默认评分智能体时
 *      同样当场给内联 Alert——判据由 `judgeAgentConfigured` 注入，本组件不知道设置页长什么样；
 *   5. 执行模式的顺序与默认值：**串行在前、并行在后，默认串行**。
 *   6. **编辑模式**：`mode="edit"` + `initial` 预填，**不新写一个
 *      `RunEditPanel`**——两处字段表必然漂移。两个坑写在 `formDefaults` 与 `caseOptions` 那两处：
 *      执行模式必须取自 `initial`（不能被表单缺省的「串行」盖掉），原用例被删掉时必须补一个禁用
 *      占位项（否则下拉空白，用户只改执行模式、一保存就换了个用例）——注意「用例列表未知」是
 *      **另一回事**，那时一个字都不许说（`cases` 可选，判据只认「已知且不含它」）。
 *      `mode` 与 `initial` 是**判别联合**（不是两个各自可选的格子）：`mode="edit"` 却没给 `initial`
 *      会让编译器当场拒绝，运行期还有一层 `return null` 兜底——理由见 `RunCreatePanelProps` 的注释。
 *   7. **候选行是一张 DataTable**（与设置页「模型清单」同一形态）：一行一个候选，
 *      列序智能体 ｜ 模型 ｜ 思考强度 ｜（无标题的）操作列。竖排标签在多候选时是最贵的高度（右栏只有
 *      ~545px 宽，每个候选白多一行标签），故字段名交给**列头**承担，控件的可访问名改由各自的
 *      `aria-label` 承担（列头 `<th>` 不会成为输入框的可访问名）；操作列**右对齐**、三个图标按钮
 *      按 **上移 / 下移 / 删除**排（用户口径），把「删除」「操作」这些字面宽度还给内容。
 *   8. **窄栏时首列与操作列钉在两侧**：列固定由套件的 `columnPinning` 表达
 *      （`pinned: 'start' | 'end'` + 每列声明的 `size`）；右栏窄到装不下四列时，表格内部横向
 *      滚动，`智能体` 留在左边、三个图标按钮留在右边，中间两列从下面滑过。
 *   9. **备注**（「用例」下方那一格）是可选用户注解，空串 = 没写；它只影响列表「标题」列与
 *      详情顶部信息卡的展示，**不参与任何行的「同一件事」判定**——只改备注保存不会作废任何行。
 *   10. **后两格是 Model Selector 的两个菜单**：模型与「想得多用力」（思考强度）各是下拉菜单，
 *      智能体仍是选择器。三条不变量：
 *      · 模型菜单**只列本行智能体接受的协议**下的模型，且按供应商分组；协议不匹配的组合
 *        **根本不在菜单里**，不是选出来再报错；
 *      · 强度菜单只列该模型「模型 × 智能体」求过交的档位；没选模型 / 没有档位时菜单一个候选都没有
 *        （触发器禁用），不列出来再置灰；
 *      · 模型触发器上带**上下文窗口的容量**（`contextWindow`），不是这一轮用掉多少——
 *        用量（占用条）在事实条上，是另一件事。
 *      切换智能体会清空本行已选的模型与强度（见智能体列的 `onValueChange`）：旧模型可能换了协议、
 *      强度是「模型 × 智能体」的函数，留着就会提交出一个服务端必须拒的组合。
 *
 * 校验在 `run-create-form-schema.ts`（zod resolver）：
 * 「至少一行」「每行的智能体与模型都选了」「用例必选」都在那里，组件里没有第二套规则。
 */
import { ArrowDownIcon, ArrowUpIcon, ChevronDownIcon, LoaderCircleIcon, PlusIcon, Trash2Icon } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Controller, useFieldArray, useForm, useWatch } from 'react-hook-form';
import type { FieldPath } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { z } from 'zod';
import {
  AGENT_KINDS,
  AGENT_LABELS,
  EFFORT_OFF,
  ROW_STATUS_LABELS,
  TERMINAL_ROW_STATUSES,
  displayRepoName,
  isSameRowTarget,
  type AgentKind,
  type EvalRow,
  type EvalRun,
  type ExecutionMode,
  type TestCase,
} from '@aieval/contracts';
import { shortHash } from '../base/format';
import { ContextWindowTag } from '../base/context-window-tag';
import { ConfirmDialog } from '../base/confirm-dialog';
import { Hint } from '../base/hint';
import { cn } from '../lib/utils';
import { Alert, AlertTitle } from '../components/ui/alert';
import { Badge } from '../components/ui/badge';
import { Button, buttonVariants } from '../components/ui/button';
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from '../components/ui/combobox';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../components/ui/dropdown-menu';
import { Field, FieldDescription, FieldError, FieldLabel, FieldTitle } from '../components/ui/field';
import { Input } from '../components/ui/input';
import { RadioGroup, RadioGroupItem } from '../components/ui/radio-group';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Switch } from '../components/ui/switch';
import { DataTable, type DataTableColumn } from '../base/data-table';
import { runCreateFormSchema, type RunFormInput, type RunRowInput } from './run-create-form-schema';

/** 候选池里的一个模型：与 api 的 `listModelOptions` 元素逐字段一致 */
export interface RunModelOption {
  providerId: string;
  providerName: string;
  modelId: string;
  source: 'fetched' | 'manual';
  /** 上下文窗口（token）；缺省 = 未知（显示「未知」，不兜底一个数字） */
  contextWindow?: number;
  /**这一行**可选**的思考强度档位（服务端已把上游档位与本行智能体的档位求过交） */
  efforts?: string[];
  /**上游推荐档（且落在 `efforts` 里时才有值）；只在标签上标「推荐」，不预选 */
  recommendedEffort?: string;
}

/** 两种模式共用的那部分 props（与 `mode` / `initial` 无关的格子） */
interface RunCreatePanelBaseProps {
  /**
   * 用例列表。**`undefined` = 未知**（首帧还没到 / 读失败），与「空数组 = 一个用例都没有」分得很清：
   * 编辑模式下「当前用例不在选项里」有两种完全不同的解释，只有**已知**为空才敢说「原用例已删除」
   * （处置见组件体里 `caseOptions` 那一段；与本页 `judgeAgentConfigured` 的「未知 ≠ 没配」同口径）。
   */
  cases?: TestCase[];
  /** 按智能体取候选池；返回空数组即「该智能体没有可用的模型」 */
  modelOptionsFor: (agentKind: AgentKind) => RunModelOption[];
  /**
   * 「未选档位」时该家实际会用的档（`AgentOptionGroup.defaultEffort` 的投影）。
   *
   * **可选**：不给（老调用方 / 元数据还没到）或返回 `undefined`（这家不声明，如 Claude Code /
   * Codex 由厂商推断）时，占位符只说「未指定」——**不编一个档出来**（那是替厂商承诺）。
   * 给这一格的用处：把「未指定」的后果说清，且厂商名与档位都由
   * `AGENT_LABELS` + 这一格拼装，UI 里不写死「（dsh 用 high）」这种缩写与第二份真源。
   */
  defaultEffortOf?: (agentKind: AgentKind) => string | undefined;
  /**
   * 设置页是否配了默认评分智能体。`false` 且开关打开时给内联 Alert ——
   * 否则要等候选 agent 跑完几分钟之后才在评分步骤炸（与「模型池为空」同一条口径：
   * 不要让人选完到运行时才失败）。不传（`undefined`）时不提示：未知不等于没配。
   */
  judgeAgentConfigured?: boolean;
  saving: boolean;
  /**
   * 提交这张表单。**可以返回在途请求的 promise**：保存前的确认框会等它落定再关
   * （返回 undefined 时它立刻关闭，用户看到的是「点一下没反应」，再点一次就是第二次 PUT）。
   */
  onSubmit: (input: RunFormValues) => void | Promise<unknown>;
  onCancel: () => void;
}

/**
 * 面板 props：`mode` 与 `initial` **同进同出**（判别联合），不是两个各自可选的格子。
 *
 * 为什么必须让「`mode: 'edit'` 却没给 `initial`」在**类型上不可能**：这种组合只能退化成创建形状
 * （一个空白默认行、行上没有 id、没有「原用例已删除」的占位项），而更新端点是**全量替换**语义——
 * 载荷里没有的行就是「要删掉的行」。于是一次误接线就能把这一轮已经跑出来的结果整批销毁，
 * 而界面上没有任何征兆（那张表单长得跟新建一模一样）。联合把它挡在编译期；
 * `as` 断言与 JS 调用方挡不住，故组件体开头还有一层运行期兜底（什么都不渲染）。
 */
export type RunCreatePanelProps = RunCreatePanelBaseProps &
  (
    | {
      /** 创建（缺省）：不预填任何东西，也没有「当前轮次」 */
      mode?: 'new';
      initial?: undefined;
    }
    | {
      /** 编辑已有的一轮：**必须**同时给 `initial`（这一条由编译器保证） */
      mode: 'edit';
      initial: EvalRun;
    }
  );

/** 提交给调用方的形状：与 contracts 的 `RunUpdate` 逐字段一致（`id` 只在编辑时有） */
export interface RunFormValues {
  caseId: string;
  /**
   * 这一轮的用户备注（空串 = 没写）。表单总是显式交出这一格：编辑载荷是**全量替换**，
   * 漏掉它就会把已有备注清空（创建时则是让人填的备注被静默丢弃）。
   */
  note: string;
  executionMode: ExecutionMode;
  useAgentJudge: boolean;
  /** 这一轮开不开应答面（`RunCreate.askUser`）：模型提问时等人回答 */
  askUser: boolean;
  /** 这一轮允不允许人往运行中的智能体发消息（`RunCreate.injectMessages`）：输入区闸门 */
  injectMessages: boolean;
  /**
   * 候选行。`effort` 必须**原样回传**（编辑时）：编辑载荷是行集合的**全量替换**，而
   * contracts 的 `isSameRowTarget` 把 effort 一起比（一侧没给就算改了档位）——
   * 少回传这一格，一次什么都没改的保存也会重置那一行（分数与产物当场消失）。
   */
  rows: { id?: string; agentKind: AgentKind; providerId: string; modelId: string; effort?: string }[];
}

/** (供应商, 模型) → Select 的值 */
function encodeModelKey(providerId: string, modelId: string): string {
  return `${providerId}::${modelId}`;
}

/** Select 的值 → (供应商, 模型)；按第一个 `::` 切，切片缺一段就返回 null（脏值不猜） */
function decodeModelKey(key: string): { providerId: string; modelId: string } | null {
  const pivot = key.indexOf('::');
  if (pivot <= 0) return null;
  return { providerId: key.slice(0, pivot), modelId: key.slice(pivot + 2) };
}

/** 模型菜单里的一组候选（同一供应商） */
interface ModelGroup {
  providerId: string;
  providerName: string;
  options: RunModelOption[];
}

/**
 * 把候选池按供应商分组（保持池子的原顺序）：菜单的组名就是「这个模型来自哪个网关」。
 * 双协议智能体（DSH）的池子是两类协议的并集，同名模型挂在两个网关时，组名是唯一能区分
 * 「选出来是哪一行」的东西。
 */
function groupByProvider(pool: RunModelOption[]): ModelGroup[] {
  const byProvider = new Map<string, ModelGroup>();
  for (const option of pool) {
    const group = byProvider.get(option.providerId);
    if (group === undefined) {
      byProvider.set(option.providerId, {
        providerId: option.providerId,
        providerName: option.providerName,
        options: [option],
      });
      continue;
    }
    group.options.push(option);
  }
  return [...byProvider.values()];
}

/**
 * 候选行三个控件的共同外观：与周边控件同高、当前值靠左、箭头靠右。
 * 用 `buttonVariants` 而不是再包一层 `Button`：`DropdownMenuTrigger` 自己就是一个按钮，
 * 两套按钮原语嵌套会多一层 DOM 与一套焦点语义。
 */
const MENU_TRIGGER_CLASS = cn(
  buttonVariants({ variant: 'outline', size: 'sm' }),
  'w-full justify-between font-normal',
);

/**
 * 用例下拉的文字过滤：**只按标题**匹配。三条细则：
 *   · 大小写不敏感；
 *   · 空格分词后**每个词都要命中**（AND）——「入站 转换」能筛出「多协议入站转换」，
 *     而「入站 校验」一个都不留（两个词没有同时出现在任何标题里）；
 *   · 空串 / 纯空白 = 不过滤（下拉照常列全部用例）。
 *
 * 为什么不交给选择器的默认过滤：它拿的是**整条显示文案**，而本面板拼的是
 * 「标题 · 仓库名 · 短哈希」——输入仓库名或短哈希也会命中，那是另一条口径（用户明确选了只搜标题）。
 * 导出它而不是内联：过滤规则要能被**直接**测到（组件层只能靠「下拉里还剩几行」间接断言）。
 */
export function matchCaseTitle(title: string, query: string): boolean {
  const tokens = query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((token) => token !== '');
  if (tokens.length === 0) return true;
  const haystack = title.toLowerCase();
  return tokens.every((token) => haystack.includes(token));
}

/**
 * 候选表里一行的**派生数据**：把「本行智能体 → 候选池 → 选中的模型」这条链算一次，四列共用。
 * 放在渲染前算而不是每列各算一遍：模型列要池子、强度列要「选中模型的档位」，
 * 各算一遍就得把同一段推导抄两次（两份必然漂移 —— 强度列漏看 `selected` 就会列出一个当前组合
 * 根本不支持的档，提交后被服务端 400 拦下）。
 */
interface CandidateRow {
  /** 这一行在表单值里的下标（字段路径与行的增删都靠它） */
  index: number;
  /** 行身份（`useFieldArray` 给的 id）：删中间一行时按下标复用会把值串行错位 */
  key: string;
  /** 本行的智能体；没选时为 `undefined`（此时池子为空，但**不**提示「没有可选的模型」） */
  agentKind?: AgentKind;
  /** 本行智能体对应的候选池 */
  pool: RunModelOption[];
  /** 本行选中的模型；池子里找不到时为 `undefined`（脏值不猜，强度一个都不列） */
  selected?: RunModelOption;
}

/**
 * 候选表四列的宽度（px），浏览器里量出来的（紧凑密度，右栏 676px 宽）。
 * **模型列刻意不给宽度**：它是唯一需要吃掉剩余宽度的列，实测拿到 362px —— 模型名 + 窗口 Tag
 * 在触发器上一行放得下；写死宽度反而会在分隔条变窄时把模型名挤成省略号。
 *
 * 操作列的 80 = 三个图标按钮各 24px（`size="icon-sm"`）+ 按钮间距 2px×2
 * + 单元格左右内边距各 4px + 余量，实测三个按钮贴右排开、右边距单元格右边 4px。
 * 130 / 120 按最长的内容量给：`Claude Code`，以及触发器上的档位文案 / 有厂商名的占位文案。
 * 菜单里的 `自动拉取` / `手工维护` Tag 与完整档位列表在浮层里，不受列宽约束。
 *
 * ⚠️ jsdom 没有布局引擎，**宽度量不了**：这三条数只能真机冒烟看，
 * 组件用例里没有、也不该有一条假装在量宽度的断言（那会是一条永远不会失败的守卫）。
 */
const CANDIDATE_COLUMN_WIDTH = { agent: 130, model: 306, effort: 120, actions: 80 } as const;

/*
 * 表格宽度 = 四列声明宽度之和（130 + 306 + 120 + 80 = 636）；固定列的偏移只认这些声明值。
 * 右栏更宽时右侧留白——套件不按容器拉伸列宽。
 */

/**
 * 「思考强度」的占位符（清空态的唯一一句话， 禁了预选 ⇒ 它必须把语义说清）。
 *
 * 三档，判据只有两条：
 *   · 这一家**声明了**未选时会落的档（`defaultEffort`，今天只有 DeepSeek Harness 的 `high`）
 * ⇒ 说出厂商名与那个档——厂商名取 `AGENT_LABELS`（**全名**，不是 `dsh` 这种 id）、档位取元数据，
 *     两处都不写死在文案里（写死就是第二份真源：厂商名或缺省档改了，这句会静默说错）；
 *   · 没声明（Claude Code / Codex 不传档位，由厂商推断；或元数据还没到） ⇒ **只说「未指定」**。
 *     **不填一个「厂商默认档」**：那句承诺不是我们作出的（契约明说未选不是「沿用厂商默认档」）。
 *
 * 单独导出成纯函数（同 `matchCaseTitle`）：三档文案都要能**直接**测到，而组件层只能从
 * Select 的 `textContent` 里反推。
 */
export function effortPlaceholder(
  agentKind: AgentKind | undefined,
  defaultEffortOf: ((agentKind: AgentKind) => string | undefined) | undefined,
): string {
  if (agentKind === undefined || defaultEffortOf === undefined) return '未指定';
  const defaultEffort = defaultEffortOf(agentKind);
  if (defaultEffort === undefined) return '未指定';
  return `未指定（${AGENT_LABELS[agentKind]} 用 ${defaultEffort}）`;
}

/**
 * 这次保存会作废哪些行（保存前确认框的内容，也是它「不该弹时不弹」的判据）。
 *
 * 判据是 contracts 的 `isSameRowTarget` —— 与服务端 `planRunUpdate` 决定「重置哪一行」的**同一份**：
 * 两处各写一份必然漂移，而漂移的症状（「确认框说 2 行、实际 1 行」）正好落在用户唯一能核对的地方。
 *
 * 「作废」只算**有东西可丢**的行（跑过或落过终态）：一个从没跑过的 `pending` 行被重置什么都不丢，
 * 拿它去弹确认框是噪音——而噪音会让用户闭眼点确定，安全带的效力就此归零（与「开始」的确认框同一取舍）。
 *
 * 单独导出成纯函数（同 `matchCaseTitle` / `completionPercent`）而不是留在组件里：它必须能被**直接**
 * 测到，而组件层只能靠「弹没弹浮层」间接断言——那对「多算了一行 / 少算了一行」几乎没有区分力。
 */
export function invalidatedRows(run: EvalRun, submit: RunFormValues): EvalRow[] {
  const caseChanged = submit.caseId !== run.caseId;
  const submitted = new Map(submit.rows.flatMap((row) => (row.id === undefined ? [] : [[row.id, row] as const])));
  return run.rows.filter((row) => {
    const lostSomething = row.attempts > 0 || TERMINAL_ROW_STATUSES.includes(row.status);
    if (!lostSomething) return false;
    if (caseChanged) return true;
    const next = submitted.get(row.id);
    if (next === undefined) return true; // 被从表单里删掉的行
    return !isSameRowTarget(row, next);
  });
}

/** 行内的字段路径（下标来自 `useFieldArray` 的序号，不是列序号） */
function rowPath(index: number, field: keyof RunRowInput): FieldPath<RunFormInput> {
  return `rows.${index}.${field}` as FieldPath<RunFormInput>;
}

/** 行级错误（列表级那条 `至少需要一个候选行` 也在 `rows` 上，不在某一行） */
function rowErrorText(errors: unknown): string | undefined {
  const rows = errors as { message?: string; root?: { message?: string } } | undefined;
  return rows?.message ?? rows?.root?.message;
}

export function RunCreatePanel(props: RunCreatePanelProps): ReactNode {
  const {
    cases,
    modelOptionsFor,
    defaultEffortOf,
    judgeAgentConfigured,
    saving,
    onSubmit,
    onCancel,
  } = props;
  // 顺着判别联合收窄成「正在编辑的那一轮 / undefined」：下面所有对它的读取都只判这一格
  // （`mode === 'edit'` 与 `initial` 同进同出，这是联合型给的保证）
  const editingRun: EvalRun | undefined = props.mode === 'edit' ? props.initial : undefined;

  /** 保存前的确认框（作废行的清单）：`null` = 没弹 */
  const [pendingSave, setPendingSave] = useState<{ payload: RunFormValues; doomed: EvalRow[] } | null>(null);

  // 既有那三行原样保留（`label` 是「标题 · 仓库名 · 短哈希」），只把类型显式写出来：
  // 多了 `disabled` 这一格（给「原用例已删除」的占位项用）。`cases` 未知时只是一个空选项表。
  // `title` 是**筛选用**的那一格：可输入模糊查询**只搜标题**（口径见 `matchCaseTitle`），
  // 而显示给用户的 label 还带着仓库名与短哈希——两者不能共用一格。
  const caseOptions: { value: string; label: string; title: string; disabled?: boolean }[] = (cases ?? []).map((item) => ({
    value: item.id,
    title: item.title,
    // 「标题 · 仓库名 · commit 短哈希」。
    // 仓库名走 contracts 的 `displayRepoName`（展示口径，**任何字符串都不抛**）：这里是在渲染期给
    // 落盘数据取名字，一条判定不认的历史来源不该让整页崩掉；判定路径用的是同包的 `repoNameFromSource`，
    // 那条对非法来源响亮地抛错——两者分工见 contracts 的注释。远端 URL 的末段与 `.git` 剥除两份口径一致
    label: `${item.title} · ${displayRepoName(item.repoPath)} · ${
      item.commitHash === null ? '默认分支 HEAD' : shortHash(item.commitHash)
    }`,
  }));

  // 编辑模式下「当前用例不在选项里」有**两种完全不同的解释**，先分清再处置（只写了第二种）：
  //   · 列表**已知**且不含它 ⇒ 另一个标签页把用例删了：补一个**禁用**的占位项并说明「原用例已删除」。
  //     不补的话下拉显示空白，用户只改执行模式、一保存就把 caseId 换成了别的用例。
  //   · 列表**未知**（`cases === undefined`：直开 / 刷新编辑链接时这一轮的快照先到、`/api/cases` 还没回，
  //     或它读失败而错误不在本页展示）⇒ **一个字都不许说**：未知 ≠ 没有（同本页 `judgeAgentConfigured`
  //     的口径）。这里补一个**可用**的当前用例项：下拉因此显示得出这一轮的用例，也保住了「不动这一格直接保存」；
  //     真的已被删除时，保存会被服务端响亮地拒（用例不存在），而不是界面先猜一个。
  if (editingRun !== undefined) {
    const { caseId, caseTitle } = editingRun;
    if (cases === undefined) {
      caseOptions.unshift({ value: caseId, label: caseTitle, title: caseTitle });
    } else if (!cases.some((item) => item.id === caseId)) {
      caseOptions.unshift({
        value: caseId,
        label: `${caseTitle}（原用例已删除，请重新选择）`,
        title: caseTitle,
        disabled: true,
      });
    }
  }

  /**
   * 表单初值：编辑时整张表单取自 `initial`（**尤其是 executionMode** —— 少了它就会被下面的缺省
   * 「串行」盖掉，用户只改了个模型、执行模式却被悄悄改成串行）；新建时给两个缺省值 + 一行默认候选。
   * `rows` 的 `id` 与 `effort` 都原样进表单值：前者是「哪一行」，后者是「这一行怎么跑的」，
   * 少任何一格都会让一次无改动的保存被服务端判成「改了」（见 `RunFormValues` 的注释）。
   */
  const formDefaults: RunFormInput =
    editingRun === undefined
      ? {
        caseId: undefined,
        note: '',
        executionMode: 'serial',
        useAgentJudge: false,
        askUser: false,
        injectMessages: false,
        rows: [{ agentKind: 'cc', modelKey: '' }],
      }
      : {
        caseId: editingRun.caseId,
        // 备注是可选注解：旧轮次由契约默认成空串，这里原样回填（改与不改都由表单显式交出）
        note: editingRun.note,
        executionMode: editingRun.executionMode,
        useAgentJudge: editingRun.useAgentJudge,
        askUser: editingRun.askUser,
        injectMessages: editingRun.injectMessages,
        rows: editingRun.rows.map((row) => ({
          id: row.id,
          agentKind: row.agentKind,
          modelKey: encodeModelKey(row.providerId, row.modelId),
          ...(row.effort === undefined ? {} : { effort: row.effort }),
        })),
      };

  const schema = runCreateFormSchema();
  const form = useForm<z.input<typeof schema>, unknown, z.output<typeof schema>>({
    resolver: zodResolver(schema),
    defaultValues: formDefaults,
  });
  const { control, setValue, handleSubmit, formState } = form;
  const { fields, append, remove, move } = useFieldArray({ control, name: 'rows' });
  /**
   * 行值的**订阅式**读取：模型池跟着本行智能体、强度档位跟着本行模型，两格一变四列都要重画。
   * 订阅整张 `rows`（而不是逐行逐格）：行数变化（加 / 删一个候选）也必须重画，
   * 只逐格比会把「加了一行」判成「什么都没变」，新加的那一行在界面上根本不出现。
   */
  const rows = useWatch({ control, name: 'rows' }) ?? [];
  const useAgentJudge = useWatch({ control, name: 'useAgentJudge' }) ?? false;

  /**
   * 运行期兜底（判别联合挡不住 `as` 断言与 JS 调用方）：`mode="edit"` 却没给 `initial` ⇒
   * **什么都不渲染**，而不是退回创建形状。
   *
   * 为什么宁可空白也不能退回创建形状：那种表单会提交出一份**没有 id、且省略了这一轮现有全部行**
   * 的载荷，而更新端点是全量替换语义（`api/src/runs.ts` 把「没收到某一行」读成「删掉这一行」）——
   * 一次误接线就能静默销毁这一轮跑出来的结果，界面上还看不出任何异常（那张表单长得跟新建一样）。
   * 空白至少是**看得见的失败**，且没有任何可提交的路径。
   *
   * 放在全部 hook **之后**：hook 的调用顺序必须跨渲染稳定，而这个分支会随 props 出现 / 消失
   * （编辑入口刚点开、`initial` 还在加载时抖一下就会撞上「Rendered fewer hooks than expected」）。
   */
  if (props.mode === 'edit' && editingRun === undefined) return null;

  /**
   * 提交路径：**先把表单值收敛成 `RunFormValues`**，再决定要不要弹确认框。
   * 为什么要确认框：编辑是本次唯一会丢数据的动作（重置 / 删行），而它丢的东西用户看不见
   * （卡片上的分数会在保存后消失）。只改执行模式 / 评分方式时什么都不作废 ⇒ **不弹**。
   */
  const submit = handleSubmit((values) => {
    const rowsPayload: RunFormValues['rows'] = [];
    for (const row of values.rows) {
      const decoded = decodeModelKey(row.modelKey);
      // 表单规则已保证两者都有值；这里再挡一次是让「类型上可能缺失」不变成静默的坏数据
      if (decoded === null) continue;
      rowsPayload.push({
        // id 也按需带：只有编辑模式的行才有它（创建路径不接受行身份）
        ...(row.id === undefined ? {} : { id: row.id }),
        agentKind: row.agentKind,
        providerId: decoded.providerId,
        modelId: decoded.modelId,
        // 强度按需带：没选就**不写这个键**（服务端把「没说」与「说了某个档」分得很清）
        ...(row.effort === undefined ? {} : { effort: row.effort }),
      });
    }
    if (rowsPayload.length === 0) return;
    const payload: RunFormValues = {
      caseId: values.caseId,
      // 备注是可选注解：纯空白按「没写」处置（列表标题列不能出现一个尾随的「 ·  」）
      note: values.note.trim(),
      executionMode: values.executionMode,
      useAgentJudge: values.useAgentJudge,
      askUser: values.askUser,
      injectMessages: values.injectMessages,
      rows: rowsPayload,
    };

    // 新建时没有「现有行」，无从作废（也就没有什么要确认的）
    const doomed = editingRun === undefined ? [] : invalidatedRows(editingRun, payload);
    if (doomed.length === 0) {
      // 没有**有东西可丢**的行会被作废（新建；或改的只是执行模式 / 评分方式；或换了用例但这轮一行都没跑过）
      onSubmit(payload);
      return;
    }
    setPendingSave({ payload, doomed });
  });

  return (
    <>
      {/* 面板标题：右栏换内容不弹层，**换的是什么必须写在第一行**（原先第一行直接是「用例」字段，
          用户不知道自己在创建还是在编辑）。副标题交代那条最容易踩的规则：创建不等于开跑。 */}
      <header className="flex flex-wrap items-baseline gap-x-2 gap-y-1 pb-2">
        <h2 className="text-title font-medium">{editingRun === undefined ? '创建评测' : '编辑评测'}</h2>
        <p className="text-sub text-muted-foreground">
          {editingRun === undefined ? '创建后不会自动开跑；在详情里点「开始」' : '保存会整轮替换成这份表单的内容'}
        </p>
      </header>
      <form
        noValidate
        onSubmit={(event) => {
          void submit(event);
        }}
      >
        <Controller
          control={control}
          name="caseId"
          render={({ field, fieldState }) => {
            const selected = caseOptions.find((option) => option.value === field.value) ?? null;
            return (
              <Field data-invalid={fieldState.invalid}>
                <FieldLabel htmlFor="run-case-id">用例</FieldLabel>
                <Combobox
                  items={caseOptions}
                  value={selected}
                  onValueChange={(item) => field.onChange(item?.value)}
                  isItemEqualToValue={(left, right) => left.value === right.value}
                  itemToStringLabel={(item) => item.label}
                  // 过滤口径见 `matchCaseTitle`：**只搜标题**。走默认过滤的话「仓库名 / 短哈希」
                  // 也会命中，与这里的口径不同。
                  filter={(item, query) => matchCaseTitle(item.title, query)}
                >
                  <ComboboxInput
                    id="run-case-id"
                    aria-label="用例"
                    aria-invalid={fieldState.invalid}
                    placeholder="选择要评测的用例"
                  />
                  <ComboboxContent>
                    <ComboboxEmpty>没有匹配的用例</ComboboxEmpty>
                    <ComboboxList>
                      {(item: { value: string; label: string; title: string; disabled?: boolean }) => (
                        <ComboboxItem key={item.value} value={item} disabled={item.disabled}>
                          {item.label}
                        </ComboboxItem>
                      )}
                    </ComboboxList>
                  </ComboboxContent>
                </Combobox>
                {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
              </Field>
            );
          }}
        />

        {/* 备注紧跟在「用例」下面（用户口径）：它回答的是「这一轮为什么这么测」，
            与用例标题一起构成列表「标题」列的显示文本。说明写在 FieldDescription 里：跟着这一格走，
            说清它会出现在哪、不填会怎样 */}
        <Controller
          control={control}
          name="note"
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid}>
              <FieldLabel htmlFor="run-note">备注</FieldLabel>
              <Input {...field} id="run-note" data-testid="run-note" placeholder="例如：对比模型不同版本间的差异" />
              <FieldDescription>
                记录这一次测试的目的，会显示在评测列表的标题列与评测详情顶部；不填时列表只显示用例标题。
              </FieldDescription>
              {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
            </Field>
          )}
        />

        {/* 顺序与默认值是版面口径的一部分：串行在前、并行在后，且默认选中串行。
            默认串行而不是并行，是因为并行不设并发上限——多候选一起开跑时最先撞上的通常是供应商限流。 */}
        <Controller
          control={control}
          name="executionMode"
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid}>
              <FieldTitle>执行模式</FieldTitle>
              <RadioGroup
                value={field.value}
                onValueChange={(value) => field.onChange(value)}
                aria-label="执行模式"
                className="flex flex-wrap gap-4"
              >
                <label className="flex items-center gap-2 text-sm">
                  <RadioGroupItem value="serial" />
                  串行
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <RadioGroupItem value="parallel" />
                  并行
                </label>
              </RadioGroup>
              {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
            </Field>
          )}
        />

        <Controller
          control={control}
          name="useAgentJudge"
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid}>
              <FieldLabel htmlFor="run-use-agent-judge">使用智能体评分</FieldLabel>
              <Switch
                id="run-use-agent-judge"
                checked={field.value}
                onCheckedChange={(checked) => field.onChange(checked)}
                aria-invalid={fieldState.invalid}
              />
              {/* 说明写在 description 里而不是另起一段文字：它解释的是这一格，跟着它走才不会在版式变化时脱节 */}
              <FieldDescription>
                改动很大、diff 塞不进一次请求的上下文时用它：由设置页配置的评分智能体在候选工作区里自行查看代码后打分。默认关闭。
              </FieldDescription>
              {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
            </Field>
          )}
        />

        <Controller
          control={control}
          name="askUser"
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid}>
              <FieldLabel htmlFor="run-ask-user">允许智能体向我提问</FieldLabel>
              <Switch
                id="run-ask-user"
                checked={field.value}
                onCheckedChange={(checked) => field.onChange(checked)}
                aria-invalid={fieldState.invalid}
              />
              {/* 说明同样写在 description 里（跟着这一格走）：它要说清代价——这一次评测会被人工介入，产物与没开过的不可直接比 */}
              <FieldDescription>
                模型中途拿不准时会提问，你从弹出的问答卡片里答复，它拿到答复再继续。代价：评测会为等人停下来，一问最多等十分钟；这一次的产物与没开过这一格的评测不可直接比。默认关闭。
              </FieldDescription>
              {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
            </Field>
          )}
        />

        {/* 与「允许智能体向我提问」同源句式（两格说的是同一件事的两个方向：模型问人 / 人喂模型）：
            代价都必须当场说清——这一轮被人插过话之后，它的产物与没插过话的轮次**不可直接比**。 */}
        <Controller
          control={control}
          name="injectMessages"
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid}>
              <FieldLabel htmlFor="run-inject-messages">允许我向智能体补充消息</FieldLabel>
              <Switch
                id="run-inject-messages"
                checked={field.value}
                onCheckedChange={(checked) => field.onChange(checked)}
                aria-invalid={fieldState.invalid}
              />
              <FieldDescription>
                运行中可以往输入区发一句话：它先排队，等智能体下一次可投递的时机（有的家要等本轮收场）。只在你按下发送、且智能体真的收到时才进执行日志；等太久没投出去的会标成「未送达」。代价：这一次的产物与没被插过话的评测不可直接比。默认关闭。
              </FieldDescription>
              {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
            </Field>
          )}
        />

        {/* 开关打开 + 设置页没配默认评分智能体 = 服务端在**创建时**就拒收（409 CONFLICT）。
            文案必须说「当场创建不出来」：服务端早已改成创建即拦（`api/src/runs.ts` 的 createRun）。 */}
        {useAgentJudge && judgeAgentConfigured === false && (
          <Alert variant="destructive" className="mb-2">
            <AlertTitle>设置页还没有配置默认评分智能体</AlertTitle>
            <p className="text-xs text-muted-foreground">
              这一次评测会创建失败（服务端当场拒绝，不会跑候选）。请先到「设置 → 评分配置」选一个默认评分智能体。
            </p>
          </Alert>
        )}

        <div className="flex flex-col gap-2">
          {(() => {
            // 每行的派生数据只算一次，四列共用（理由见 CandidateRow 的注释）
            const candidates: CandidateRow[] = fields.map((field, index) => {
              const value = rows[index];
              const agentKind = value?.agentKind;
              const pool = agentKind === undefined ? [] : modelOptionsFor(agentKind);
              const modelKey = value?.modelKey;
              const decoded = modelKey === undefined || modelKey === '' ? null : decodeModelKey(modelKey);
              return {
                index,
                key: field.id,
                agentKind,
                pool,
                // 池子里找不到 = 这一格是脏值（换过智能体、或那家供应商被删了）：不猜，
                // 于是一个强度档都不列 —— 交集是「服务端算好的」，本地兜不出第二份
                selected:
                  decoded === null
                    ? undefined
                    : pool.find(
                      (option) =>
                        option.providerId === decoded.providerId && option.modelId === decoded.modelId,
                    ),
              };
            });
            /* 候选行 = DataTable：首列与操作列由 `columnPinning` 钉在两侧，偏移来自声明的宽度；
               表头不吸顶（右栏里这张表没有可滚的纵向高度），滚动由表格自己的容器承担。 */
            const candidateColumns: DataTableColumn<CandidateRow>[] = [
              {
                id: 'agent',
                header: '智能体',
                accessorFn: (candidate) => candidate.agentKind ?? '',
                size: CANDIDATE_COLUMN_WIDTH.agent,
                pinned: 'start',
                cell: ({ row: tableRow }) => {
                  const row = tableRow.original;
                  return (
                    <Controller
                      control={control}
                      name={rowPath(row.index, 'agentKind')}
                      render={({ field, fieldState }) => (
                        <Field data-invalid={fieldState.invalid}>
                          <Select
                            // `rowPath` 返回的是所有行字段的联合路径，故这里按本格的实际类型收窄：
                            // 契约里 `agentKind` 只有那四个值（`AGENT_KINDS`）
                            value={(field.value as AgentKind | undefined) ?? null}
                            onValueChange={(value) => {
                              field.onChange(value);
                              // 换智能体必须作废本行已选的**模型与强度**：前者可能是协议不匹配的组合，
                              // 后者是「模型 × 智能体」的函数 —— 留着它，界面会显示一个当前组合根本不支持的档，
                              // 提交后被服务端 400 拦下。
                              setValue(rowPath(row.index, 'modelKey'), '');
                              setValue(rowPath(row.index, 'effort'), undefined);
                            }}
                          >
                            <SelectTrigger
                              id={`run-row-${row.index}-agent`}
                              // 字段名现在只在**列头**里（`<th>` 不会成为控件的可访问名），
                              // 去掉 label 后必须由控件自己承担，否则三个下拉都成了无名控件
                              aria-label="智能体"
                              aria-invalid={fieldState.invalid}
                              className="w-full"
                            >
                              <SelectValue placeholder="选择智能体" />
                            </SelectTrigger>
                            <SelectContent>
                              {AGENT_KINDS.map((kind) => (
                                <SelectItem key={kind} value={kind}>
                                  {AGENT_LABELS[kind]}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
                        </Field>
                      )}
                    />
                  );
                },
              },
              {
                id: 'model',
                header: '模型',
                accessorFn: (candidate) => candidate.selected?.modelId ?? '',
                size: CANDIDATE_COLUMN_WIDTH.model,
                cell: ({ row: tableRow }) => {
                  const row = tableRow.original;
                  return (
                    <>
                      <Controller
                        control={control}
                        name={rowPath(row.index, 'modelKey')}
                        render={({ field, fieldState }) => {
                          const selectedKey = typeof field.value === 'string' ? field.value : '';
                          return (
                            <Field data-invalid={fieldState.invalid}>
                              <DropdownMenu>
                                <DropdownMenuTrigger
                                  id={`run-row-${row.index}-model`}
                                  // 字段名只在**列头**里（`<th>` 不会成为按钮的可访问名），
                                  // 触发器必须自己承担可访问名
                                  aria-label="模型"
                                  aria-invalid={fieldState.invalid}
                                  // 池子为空 = 这一格一个可选项都没有：禁用触发器，下面的内联 Alert 指出路。
                                  // 不用「点开一个空菜单」表达，那看起来像还没加载完
                                  disabled={row.pool.length === 0}
                                  className={MENU_TRIGGER_CLASS}
                                >
                                  {row.selected === undefined ? (
                                    <span className="min-w-0 truncate text-muted-foreground">
                                      {row.pool.length === 0 ? '没有可选的模型' : '选择模型'}
                                    </span>
                                  ) : (
                                    <>
                                      <span className="min-w-0 truncate">{row.selected.modelId}</span>
                                      {/*
                                       * 窗口是**容量**（`contextWindow`），不是这一轮用掉多少：
                                       * 占用条在事实条上（`contextWindow` 的另一种口径），两者别混。
                                       * 容量放在触发器上，否则「1M 与 1.05M」的差别只在菜单展开时才看得见。
                                       */}
                                      <ContextWindowTag contextWindow={row.selected.contextWindow} />
                                    </>
                                  )}
                                  <ChevronDownIcon aria-hidden className="ml-auto size-3.5 text-muted-foreground" />
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="start">
                                  {/*
                                   * 只列**本行智能体接受的协议**下的模型（池子由 `modelOptionsFor` 注入）：
                                   * 协议不匹配的组合根本不出现在菜单里，而不是选出来再在服务端报错。
                                   */}
                                  <DropdownMenuRadioGroup
                                    value={selectedKey}
                                    // 换模型必须作废已选强度：交集随模型变，留着的脏值会在创建时被服务端 400 拦下
                                    onValueChange={(value) => {
                                      field.onChange(value);
                                      setValue(rowPath(row.index, 'effort'), undefined);
                                    }}
                                  >
                                    {/* 按供应商分组：双协议智能体（DSH）的池子是两类协议的并集，
                                        同名模型挂在两个网关时，组名是唯一能区分「选出来是哪一行」的东西 */}
                                    {groupByProvider(row.pool).map((group) => (
                                      <DropdownMenuGroup key={group.providerId}>
                                        <DropdownMenuLabel>{group.providerName}</DropdownMenuLabel>
                                        {group.options.map((option) => {
                                          const key = encodeModelKey(option.providerId, option.modelId);
                                          return (
                                            <DropdownMenuRadioItem key={key} value={key} closeOnClick>
                                              <span>{option.modelId}</span>
                                              <Badge variant="outline">
                                                {option.source === 'manual' ? '手工维护' : '自动拉取'}
                                              </Badge>
                                              <ContextWindowTag contextWindow={option.contextWindow} />
                                            </DropdownMenuRadioItem>
                                          );
                                        })}
                                      </DropdownMenuGroup>
                                    ))}
                                  </DropdownMenuRadioGroup>
                                </DropdownMenuContent>
                              </DropdownMenu>
                              {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
                            </Field>
                          );
                        }}
                      />
                      {/* 「没有可选的模型」跟着**模型**这一格走：它就是这一格选不出东西的原因 */}
                      {row.agentKind !== undefined && row.pool.length === 0 && (
                        <Alert variant="destructive" className="mt-1">
                          <AlertTitle>
                            {`${AGENT_LABELS[row.agentKind]} 没有可选的模型：请到设置里添加协议匹配的供应商，并为它维护模型清单`}
                          </AlertTitle>
                        </Alert>
                      )}
                    </>

                  );
                },
              },
              {
                id: 'effort',
                header: '思考强度',
                accessorFn: (candidate) => candidate.selected?.recommendedEffort ?? '',
                size: CANDIDATE_COLUMN_WIDTH.effort,
                cell: ({ row: tableRow }) => {
                  const row = tableRow.original;
                  return (
                    <Controller
                      control={control}
                      name={rowPath(row.index, 'effort')}
                      render={({ field, fieldState }) => {
                        const value = typeof field.value === 'string' ? field.value : undefined;
                        /**
                         * 这一行**可选**的档位 = 服务端已经把「上游档位 ∩ 本行智能体的档位域」求过交的
                         * `efforts`。没选模型、或这个模型一个档位都没声明 ⇒ 一个可选项都没有：
                         * 禁用触发器，而不是列一堆档位再置灰（本地兜不出第二份交集，见 `CandidateRow`）。
                         */
                        const efforts = row.selected?.efforts ?? [];
                        const disabled = row.selected === undefined || efforts.length === 0;
                        return (
                          <Field data-invalid={fieldState.invalid}>
                            <DropdownMenu>
                              <DropdownMenuTrigger
                                id={`run-row-${row.index}-effort`}
                                aria-label="思考强度"
                                aria-invalid={fieldState.invalid}
                                disabled={disabled}
                                className={MENU_TRIGGER_CLASS}
                              >
                                {/*
                                 * 不预选推荐档：预选会让「我没选过」与「我选了推荐档」在快照里长得一样。
                                 * 「未指定」是**清空态**，只能由触发器上的占位文案承担（见 `effortPlaceholder`）。
                                 */}
                                <span className={cn('min-w-0 truncate', value === undefined && 'text-muted-foreground')}>
                                  {value ?? effortPlaceholder(row.agentKind, defaultEffortOf)}
                                </span>
                                <ChevronDownIcon aria-hidden className="ml-auto size-3.5 text-muted-foreground" />
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="start" className="min-w-44">
                                <DropdownMenuRadioGroup
                                  value={value ?? ''}
                                  onValueChange={(next) => field.onChange(next)}
                                >
                                  {efforts.map((effort) => (
                                    <DropdownMenuRadioItem key={effort} value={effort} closeOnClick>
                                      {/* 「（推荐）」只加在非关闭档上：关闭档要表达的是「关掉思考」，
                                          上游就算推荐它也印不上「（推荐）」这个后缀 */}
                                      {effort !== EFFORT_OFF && effort === row.selected?.recommendedEffort
                                        ? `${effort}（推荐）`
                                        : effort}
                                    </DropdownMenuRadioItem>
                                  ))}
                                </DropdownMenuRadioGroup>
                                {/* 清空态不是档位域里的一项：它是单独的动作，只在已有值时出现
                                    （与「未选 ≠ 关闭」同一条口径：`off` 是关掉思考，清空是「我没选」） */}
                                {value !== undefined && (
                                  <>
                                    <DropdownMenuSeparator />
                                    <DropdownMenuItem onClick={() => field.onChange(undefined)}>清除档位</DropdownMenuItem>
                                  </>
                                )}
                              </DropdownMenuContent>
                            </DropdownMenu>
                            {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
                          </Field>
                        );
                      }}
                    />
                  );
                },
              },
              {
                id: 'actions',
                header: '',
                size: CANDIDATE_COLUMN_WIDTH.actions,
                pinned: 'end',
                cell: ({ row: tableRow }) => {
                  const row = tableRow.original;
                  return (
                    <>
                      {/* 三个图标按钮（用户口径）：文字进浮层，可访问名走 `aria-label`
                                      （浮层不产生可访问名，不给 aria-label 就是个无名按钮）。
                                      边界行**置灰而不是隐藏**：按钮位置固定，眼睛不用重新找。 */}
                      <div className="flex items-center justify-end gap-0.5">
                        <Hint label="上移">
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            aria-label="上移"
                            disabled={row.index === 0}
                            onClick={() => move(row.index, row.index - 1)}
                          >
                            <ArrowUpIcon aria-hidden />
                          </Button>
                        </Hint>
                        <Hint label="下移">
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            aria-label="下移"
                            disabled={row.index === fields.length - 1}
                            onClick={() => move(row.index, row.index + 1)}
                          >
                            <ArrowDownIcon aria-hidden />
                          </Button>
                        </Hint>
                        <Hint label="删除">
                          <Button
                            size="icon-sm"
                            variant="destructive"
                            aria-label="删除"
                            // 认的是**本行的下标**（表单值里的下标），不是列的序号：
                            // 拿列序号去删会删掉别人那一行 —— 表格里最容易错的一处
                            onClick={() => remove(row.index)}
                          >
                            <Trash2Icon aria-hidden />
                          </Button>
                        </Hint>
                      </div>
                    </>

                  );
                },
              },
            ];
            return (
              <div className="w-full" data-testid="candidate-table">
                <DataTable<CandidateRow>
                  columns={candidateColumns}
                  data={candidates}
                  rowKey={(candidate) => candidate.key}
                  // 行高由内容决定（模型池为空的 Alert 会把这一行撑高）
                  virtualize={false}
                  rowHeight={56}
                  emptyText="还没有候选：点下面的「添加候选」加一行"
                  tableAttributes={{ 'data-testid': 'candidate-table-grid' }}
                  rowAttributes={(candidate) => ({ 'data-testid': `candidate-row-${candidate.index}` })}
                  ariaLabel="评测候选"
                />
              </div>
            );
          })()}

          {/* 列表级错误（「至少需要一个候选行」）：路径在 `rows` 上，不在某一行里 */}
          {rowErrorText(formState.errors.rows) !== undefined && (
            <FieldError errors={[{ message: rowErrorText(formState.errors.rows) }]} />
          )}
          {/* 创建 / 添加类按钮全站同形：前导加号 + 虚线边框 */}
          <Button variant="outline" size="sm" className="self-start" onClick={() => append({ agentKind: 'cc', modelKey: '' })}>
            <PlusIcon aria-hidden className="size-3.5" />
            添加候选
          </Button>
        </div>

        {/* 提交区**吸底**：表单比一屏高时（候选行、开关组、说明文都在上面），
            按钮不能落到视口外——那是「填完找不到保存」的常见形状。
            上边距用密度档的 `pt-roomy`，下边留 0：详情槽自己的 padding 提供那 8px。 */}
        <div className="sticky bottom-0 z-10 mt-4 flex justify-end gap-2 border-t border-border bg-background pt-roomy">
          <Button size="sm" variant="outline" onClick={onCancel}>
            取消
          </Button>
          {/* 提交按钮是「确定」而不是「创建评测」（用户口径）：它只负责提交这张已经写着「创建评测」的右栏表单。 */}
          <Button type="submit" size="sm" disabled={saving}>
            {saving ? <LoaderCircleIcon className="size-3 animate-spin" aria-hidden /> : null}
            确定
          </Button>
        </div>
      </form>

      {/* 保存前的确认框：只列出**有东西可丢**的行（判据见 `invalidatedRows`） */}
      <ConfirmDialog
        open={pendingSave !== null}
        onOpenChange={(next) => {
          if (!next) setPendingSave(null);
        }}
        title="保存后会作废这些候选的已有结果？"
        description="保存后它们会回到「待开始」，已有的分数与产物不再显示。"
        confirmLabel="保存"
        destructive
        onConfirm={() => (pendingSave === null ? undefined : onSubmit(pendingSave.payload))}
        testId="run-edit-confirm"
      >
        <ul className="flex flex-col gap-0.5 text-sm">
          {(pendingSave?.doomed ?? []).map((row) => (
            <li key={row.id} className="text-muted-foreground">
              · {AGENT_LABELS[row.agentKind]} · {row.modelId}（{ROW_STATUS_LABELS[row.status]}）
            </li>
          ))}
        </ul>
      </ConfirmDialog>
    </>
  );
}
