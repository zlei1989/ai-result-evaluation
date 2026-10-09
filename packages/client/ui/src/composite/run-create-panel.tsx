'use client';

/**
 * 创建评测表单：用例 + 执行模式 + 使用智能体评分 + 候选行（`Form.List`）。
 * 四条口径：
 *   1. 模型候选池按**行内的智能体**过滤（spec §5.1 F2）——池子由 `modelOptionsFor` 注入，
 *      本组件里没有「哪家智能体配哪种协议」这张表（那是 agents 注册表的事，A3）；
 *   2. 池子为空时**当场**给内联 Alert 与出路，而不是等人点了创建才在服务端炸；
 *   3. 模型的 Select 值编码成 `providerId::modelId`：两个不同供应商可能有同名模型，
 *      只存 modelId 会让提交的 providerId 无解。分隔符用 `::`——UUID 不含冒号，
 *      模型名里常见的是单个 `:` 与 `/`；解析时按**第一个** `::` 切，模型名里即使含 `::` 也能还原；
 *   4. 「使用智能体评分」默认**关闭**（用户口径），且开关打开而设置页没配默认评分智能体时
 *      同样当场给内联 Alert——判据由 `judgeAgentConfigured` 注入，本组件不知道设置页长什么样；
 *   5. 执行模式的顺序与默认值也是用户口径（2026-09-28）：**串行在前、并行在后，默认串行**。
 *   6. **编辑模式**（2026-09-28，spec §6.2）：`mode="edit"` + `initial` 预填，**不新写一个
 *      `RunEditPanel`**——两处字段表必然漂移。两个坑写在 `initialValues` 与 `caseOptions` 那两处：
 *      执行模式必须取自 `initial`（不能被表单缺省的「串行」盖掉），原用例被删掉时必须补一个禁用
 *      占位项（否则下拉空白，用户只改执行模式、一保存就换了个用例）——注意「用例列表未知」是
 *      **另一回事**，那时一个字都不许说（`cases` 可选，判据只认「已知且不含它」）。
 *      `mode` 与 `initial` 是**判别联合**（不是两个各自可选的格子）：`mode="edit"` 却没给 `initial`
 *      会让编译器当场拒绝，运行期还有一层 `return null` 兜底——理由见 `RunCreatePanelProps` 的注释。
 *   7. **候选行是一张 small Table**（用户口径 2026-09-29，与设置页「模型清单」同一形态）：一行一个候选，
 *      列序 智能体 ｜ 模型 ｜ 思考强度 ｜ （无标题的）操作列。竖排标签在多候选时是最贵的高度（右栏只有
 *      ~545px 宽，每个候选白多一行标签），故字段名交给**列头**承担，控件的可访问名改由各自的
 *      `aria-label` 承担（列头 `<th>` 不会成为输入框的可访问名）；操作列**右对齐**、三个图标按钮
 *      按 **上移 / 下移 / 删除** 排（用户口径），把「删除」「操作」这些字面宽度还给内容。
 *   8. **窄栏时首列与操作列钉在两侧**（用户口径 2026-10-02）：右栏窄到装不下四列时，表格内部横向
 *      滚动，`智能体` 留在左边、三个图标按钮留在右边，中间两列从下面滑过。判据是
 *      `CANDIDATE_TABLE_MIN_WIDTH`（表格最小宽度，见该常量的注释：它就是「装得下」的分界）。
 *      三处**必须同时在场**，少一处就静默退回「溢出到容器外面、够不到」的老样子：
 *      ① `scroll={{ x: 数值 }}`、② 首列 `fixed: 'left'`、③ 操作列 `fixed: 'right'`。
 */
import { ArrowDownOutlined, ArrowUpOutlined, DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import { Alert, Button, Flex, Form, Input, Modal, Radio, Select, Switch, Table, Tag, Tooltip, Typography } from 'antd';
import type { FormListFieldData } from 'antd';
import type { ReactNode } from 'react';
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

/** 候选池里的一个模型：与 api 的 `listModelOptions` 元素逐字段一致 */
export interface RunModelOption {
  providerId: string;
  providerName: string;
  modelId: string;
  source: 'fetched' | 'manual';
  /** 上下文窗口（token）；缺省 = 未知（显示「未知」，不兜底一个数字） */
  contextWindow?: number;
  /** 这一行**可选**的思考强度档位（服务端已把上游档位与本行智能体的档位求过交，spec D10） */
  efforts?: string[];
  /** 上游推荐档（且落在 `efforts` 里时才有值）；只在标签上标「推荐」，不预选（spec D14） */
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
   * 给这一格的用处：把「未指定」的后果说清（用户 2026-10-06 口径），且厂商名与档位都由
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
   * 提交这张表单。**可以返回在途请求的 promise**：保存前的确认框把它交回给 antd 的
   * `ActionButton`，让确认框等保存落定再关（返回 undefined 时它立刻关闭，用户看到的是
   * 「点一下没反应」，再点一次就是第二次 PUT——`run-detail-panel.tsx` 的 `onDelete` 同此口径）。
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
  executionMode: ExecutionMode;
  useAgentJudge: boolean;
  /**
   * 候选行。`effort` 必须**原样回传**（编辑时）：编辑载荷是行集合的**全量替换**，而
   * contracts 的 `isSameRowTarget` 把 effort 一起比（一侧没给就算改了档位）——
   * 少回传这一格，一次什么都没改的保存也会重置那一行（分数与产物当场消失）。
   */
  rows: { id?: string; agentKind: AgentKind; providerId: string; modelId: string; effort?: string }[];
}

/** 表单内部的行值：模型用编码值承载 (providerId, modelId)，编辑时另带原行 id */
interface RowFormValue {
  /** 编辑时的原行 id（由行内那个 `hidden` 的 `Form.Item` 注册、随 `initialValues` 带进表单值） */
  id?: string;
  agentKind?: AgentKind;
  modelKey?: string;
  /** 思考强度：裸字符串（档位名里没有 `::` 那种分隔符风险，不编码） */
  effort?: string;
}

interface FormValues {
  caseId?: string;
  executionMode?: 'parallel' | 'serial';
  useAgentJudge?: boolean;
  rows?: RowFormValue[];
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

/**
 * 用例下拉的文字过滤：**只按标题**匹配（用户口径，2026-09-26）。三条细则：
 *   · 大小写不敏感；
 *   · 空格分词后**每个词都要命中**（AND）——「入站 转换」能筛出「多协议入站转换」，
 *     而「入站 校验」一个都不留（两个词没有同时出现在任何标题里）；
 *   · 空串 / 纯空白 = 不过滤（下拉照常列全部用例）。
 *
 * 为什么不交给 antd 的默认过滤：它拿的是**整条 option.label**，而本面板拼的是
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

/** 「至少一行」（spec §5.1 的提交校验）：antd 的自定义校验器以抛错表示不通过 */
async function requireAtLeastOneRow(_rule: unknown, value: unknown): Promise<void> {
  if (Array.isArray(value) && value.length > 0) return;
  throw new Error('至少需要一个候选行');
}

/**
 * 候选行里两格下拉的**依赖签名**：模型池看本行的智能体，强度档位看本行选中的模型（spec D10），
 * 于是这两格一变，引用它们的列都要重画 —— 签名就是给表格那个 `shouldUpdate` 用的判据。
 *
 * 为什么用签名而不是逐格比 `prev.rows?.[i]?.agentKind !== next.rows?.[i]?.agentKind`：
 * 表格的 `dataSource` 是由 `fields` **派生**的（每行的池子与选中模型都算在渲染里），
 * 行数变化（加 / 删一个候选）也必须重画 —— 只逐格比会把「加了一行」判成「什么都没变」，
 * 新加的那一行在界面上根本不出现。签名里带上行数，这一类漏渲染就不可能出现。
 */
function poolSignature(rows: FormValues['rows']): string {
  return JSON.stringify((rows ?? []).map((row) => [row.agentKind, row.modelKey]));
}

/**
 * 候选表里一行的**派生数据**：把「本行智能体 → 候选池 → 选中的模型」这条链算一次，四列共用。
 * 放在渲染前算而不是每列各算一遍：模型列要池子、强度列要「选中模型的档位」，
 * 各算一遍就得把同一段推导抄两次（两份必然漂移 —— 强度列漏看 `selected` 就会列出一个当前组合
 * 根本不支持的档，提交后被服务端 400 拦下）。
 */
interface CandidateRow {
  /** `Form.List` 的那一格（`name` 是这一行在表单值里的下标，行的增删与字段路径都靠它） */
  field: FormListFieldData;
  /** 本行的智能体；没选时为 `undefined`（此时池子为空，但**不**提示「没有可选的模型」） */
  agentKind?: AgentKind;
  /** 本行智能体对应的候选池 */
  pool: RunModelOption[];
  /** 本行选中的模型；池子里找不到时为 `undefined`（脏值不猜，强度一个都不列） */
  selected?: RunModelOption;
}

/**
 * 候选表三列的宽度（px），浏览器里量出来的（2026-09-29，紧凑密度，右栏 676px 宽）。
 * **模型列刻意不给宽度**：它是唯一需要吃掉剩余宽度的列，实测拿到 362px —— 长模型名 + 来源 Tag +
 * 窗口 Tag 一行放得下，不省略；写死宽度反而会在分隔条变窄时把模型名挤成省略号。
 *
 * 操作列的 80 = 三个图标按钮各 21px（紧凑密度下的 `ant-btn-sm` 图标按钮）+ 按钮间距 2px×2
 * + 单元格左右内边距各 4px + 余量，实测三个按钮贴右排开、右边距单元格右边 4px。
 * 130 / 120 按最长的内容量给：`Claude Code`、`自动拉取` / `手工维护` 的 Tag、`high（推荐）` 的档位标签。
 *
 * ⚠️ jsdom 没有布局引擎，**宽度量不了**：这三条数只由真机冒烟记录看着（本轮 `2026-09-29-candidate-table-smoke.md`），
 * 组件用例里没有、也不该有一条假装在量宽度的断言（那会是一条永远不会失败的守卫）。
 */
const CANDIDATE_COLUMN_WIDTH = { agent: 130, effort: 120, actions: 80 } as const;

/**
 * 候选表的最小宽度（px）：右栏窄于它时**才**横向滚动，并把首列 / 操作列钉在两侧
 * （用户口径 2026-10-02，见下面 Table 的 `scroll` 与两处 `fixed`）。
 *
 * 为什么必须有这个数，而不是继续靠「列宽之和」自然撑开：不给 `scroll.x` 时 rc-table 不设
 * 任何宽度，`table-layout` 停在 `auto`，表格会**溢出到容器外面**——实测右栏内容宽 404px、
 * 表格 594px，`思考强度` 与操作列整体落在右栏之外（`ListDetailLayout` 的右栏是
 * `overflow: auto`，横向没有滚动条可滚，被挤出去的列**根本够不到**）。给了数字后 rc-table 把
 * `width` + `minWidth: 100%` 落到表格上、并把 `table-layout` 切成 `fixed`，溢出变成**表格内部**
 * 的横向滚动，`position: sticky` 的固定列也才有意义。
 *
 * 636 = 三列宽（130 / 120 / 80，见上）+ 模型列 306（**差值即模型列在最小表宽下的可用宽度**）。
 * **模型列是唯一不给宽度的列**（它吃剩余宽度），而 306 已经盖住它在真机上「模型名 + 供应商名 +
 * 来源 Tag + 窗口 Tag」所需的宽度（实测这三个片段在默认密度下约 302px，差的那一点由供应商名 /
 * 模型名自己的省略号吸收）。也就是说 636 是**坏掉与没坏掉的分界**：≥636 时四列全都看得见、不滚
 * （表格按 `minWidth: 100%` 铺满容器，多出来的宽度按比例分给各列），<636 时横向滚动、首列与操作列
 * 留在两侧。这个数只由真机冒烟记录看着（同下条 ⚠️）。
 */
const CANDIDATE_TABLE_MIN_WIDTH = 636;

/**
 * 表格单元格里的 `Form.Item` 一律贴底（`marginBottom: 0`）。
 * antd 的表单项自带一截下外边距（`itemMarginBottom` = `marginLG`，默认 **24px**），那是给
 * 「竖排标签 + 多个表单项」之间留空用的；在表格单元格里它只是把每一行都撑高一截——
 * 本表靠单元格自己的内边距分隔，不靠这个外边距。
 */
const CELL_ITEM_STYLE = { marginBottom: 0 } as const;

/**
 * 「思考强度」的占位符（清空态的唯一一句话，spec D14 禁了预选 ⇒ 它必须把语义说清，2026-10-06 口径）。
 *
 * 三档，判据只有两条：
 *   · 这一家**声明了**未选时会落的档（`defaultEffort`，今天只有 DeepSeek Harness 的 `high`）
 *     ⇒ 说出厂商名与那个档——厂商名取 `AGENT_LABELS`（**全名**，不是 `dsh` 这种 id）、档位取元数据，
 *     两处都不写死在文案里（写死就是第二份真源：厂商名或缺省档改了，这句会静默说错）；
 *   · 没声明（Claude Code / Codex 不传档位，由厂商推断；或元数据还没到）⇒ **只说「未指定」**。
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

  const [form] = Form.useForm<FormValues>();
  const [modal, contextHolder] = Modal.useModal();

  /**
   * 运行期兜底（判别联合挡不住 `as` 断言与 JS 调用方）：`mode="edit"` 却没给 `initial` ⇒
   * **什么都不渲染**，而不是退回创建形状。
   *
   * 为什么宁可空白也不能退回创建形状：那种表单会提交出一份**没有 id、且省略了这一轮现有全部行**
   * 的载荷，而更新端点是全量替换语义（`api/src/runs.ts` 把「没收到某一行」读成「删掉这一行」）——
   * 一次误接线就能静默销毁这一轮跑出来的结果，界面上还看不出任何异常（那张表单长得跟新建一样）。
   * 空白至少是**看得见的失败**，且没有任何可提交的路径。
   *
   * 放在两个 hook **之后**：hook 的调用顺序必须跨渲染稳定，而这个分支会随 props 出现 / 消失
   * （编辑入口刚点开、`initial` 还在加载时抖一下就会撞上「Rendered fewer hooks than expected」）。
   */
  if (props.mode === 'edit' && editingRun === undefined) return null;

  // 既有那三行原样保留（`label` 是「标题 · 仓库名 · 短哈希」），只把类型显式写出来：
  // 多了 `disabled` 这一格（给「原用例已删除」的占位项用）。`cases` 未知时只是一个空选项表。
  const caseOptions: { value: string; label: string; disabled?: boolean }[] = (cases ?? []).map((item) => ({
    value: item.id,
    // 「标题 · 仓库名 · commit 短哈希」（spec §5.1）。
    // 仓库名走 contracts 的 `displayRepoName`（展示口径，**任何字符串都不抛**）：这里是在渲染期给
    // 落盘数据取名字，一条判定不认的历史来源不该让整页崩掉；判定路径用的是同包的 `repoNameFromSource`，
    // 那条对非法来源响亮地抛错——两者分工见 contracts 的注释。远端 URL 的末段与 `.git` 剥除两份口径一致
    label: `${item.title} · ${displayRepoName(item.repoPath)} · ${
      item.commitHash === null ? '默认分支 HEAD' : shortHash(item.commitHash)
    }`,
  }));

  // 编辑模式下「当前用例不在选项里」有**两种完全不同的解释**，先分清再处置（spec §6.2 只写了第二种）：
  //   · 列表**已知**且不含它 ⇒ 另一个标签页把用例删了：补一个**禁用**的占位项并说明「原用例已删除」。
  //     不补的话 `Select` 显示空白，用户只改执行模式、一保存就把 caseId 换成了别的用例。
  //   · 列表**未知**（`cases === undefined`：直开 / 刷新编辑链接时这一轮的快照先到、`/api/cases` 还没回，
  //     或它读失败而错误不在本页展示）⇒ **一个字都不许说**：未知 ≠ 没有（同本页 `judgeAgentConfigured`
  //     的口径）。此前一律按「已删除」处置，于是这一格会显示一句**假话**并且选项被禁用——用例根本换不了。
  //     这里补一个**可用**的当前用例项：下拉因此显示得出这一轮的用例，也保住了「不动这一格直接保存」；
  //     真的已被删除时，保存会被服务端响亮地拒（用例不存在），而不是界面先猜一个。
  if (editingRun !== undefined) {
    // 先解构出来：闭包（`some` 的回调）里读的是局部常量，不依赖外层的收窄是否被带进去
    const { caseId, caseTitle } = editingRun;
    if (cases === undefined) {
      caseOptions.unshift({ value: caseId, label: caseTitle });
    } else if (!cases.some((item) => item.id === caseId)) {
      caseOptions.unshift({
        value: caseId,
        label: `${caseTitle}（原用例已删除，请重新选择）`,
        disabled: true,
      });
    }
  }

  // 过滤只认标题，而 options 的 value 是用例 id（提交要用它）⇒ 这里留一份 id → 标题的映射，
  // 免得把标题塞进 option 的自定义字段（antd 的 `title` 字段有它自己的语义：原生 tooltip）
  const titleById = new Map((cases ?? []).map((item) => [item.id, item.title]));
  // 未知态补的那一项也要进映射（上面的 `caseOptions.unshift`）：它的标题来自这一轮的快照、不在
  // `cases` 里，不补的话用户一打字，**当前用例**（这一格此刻的值）反而成了唯一搜不到的选项。
  // 已知态不补：那一项是禁用的占位，本就不该被搜出来当成可选项。
  if (cases === undefined && editingRun !== undefined) titleById.set(editingRun.caseId, editingRun.caseTitle);

  /**
   * 提交路径：**先把表单值收敛成 `RunFormValues`**，再决定要不要弹确认框。
   * 为什么要确认框：编辑是本次唯一会丢数据的动作（重置 / 删行），而它丢的东西用户看不见
   * （卡片上的分数会在保存后消失）。只改执行模式 / 评分方式时什么都不作废 ⇒ **不弹**。
   */
  const handleFinish = (values: FormValues): void => {
    const rows: RunFormValues['rows'] = [];
    for (const row of values.rows ?? []) {
      const decoded = row.modelKey === undefined ? null : decodeModelKey(row.modelKey);
      // 表单规则已保证三者都有值；这里再挡一次是让「类型上可能缺失」不变成静默的坏数据
      if (row.agentKind === undefined || decoded === null) continue;
      rows.push({
        // id 也按需带：只有编辑模式的行才有它（创建路径不接受行身份）
        ...(row.id === undefined ? {} : { id: row.id }),
        agentKind: row.agentKind,
        providerId: decoded.providerId,
        modelId: decoded.modelId,
        // 强度按需带：没选就**不写这个键**（服务端把「没说」与「说了某个档」分得很清，spec D12）
        ...(row.effort === undefined ? {} : { effort: row.effort }),
      });
    }
    if (values.caseId === undefined || rows.length === 0) return;
    const submit: RunFormValues = {
      caseId: values.caseId,
      executionMode: values.executionMode ?? 'serial',
      // 缺省 false：开关没被碰过时 antd 给的是 `initialValues` 那一份，这里兜的是「值确实缺失」的极端情况
      useAgentJudge: values.useAgentJudge ?? false,
      rows,
    };

    // 新建时没有「现有行」，无从作废（也就没有什么要确认的）
    const doomed = editingRun === undefined ? [] : invalidatedRows(editingRun, submit);
    if (doomed.length === 0) {
      // 没有**有东西可丢**的行会被作废（新建；或改的只是执行模式 / 评分方式；或换了用例但这轮一行都没跑过）
      onSubmit(submit);
      return;
    }
    modal.confirm({
      title: '保存后会作废这些行的已有结果？',
      width: 520,
      // 浮层根节点带类名：调用方与用例要能收窄到「这一个浮层」（页面上确认框不止一处）
      rootClassName: 'run-edit-confirm',
      content: (
        <Flex vertical gap={4}>
          <Typography.Text>保存后它们会回到「待开始」，已有的分数与产物不再显示：</Typography.Text>
          {doomed.map((row) => (
            <Typography.Text key={row.id} type="secondary">
              · {AGENT_LABELS[row.agentKind]} · {row.modelId}（{ROW_STATUS_LABELS[row.status]}）
            </Typography.Text>
          ))}
        </Flex>
      ),
      okText: '保存',
      cancelText: '取消',
      // `okButtonProps` 里**一个 `loading` 键都不能有**（多写一个 `loading: undefined` 都不行）：
      // antd 的 `ActionButton` 把 `buttonProps` 展开在自己的 `loading` **之后**，键只要在场就会盖掉
      // 它内部的转圈状态——于是保存期间按钮不再转圈（`run-detail-panel.tsx` 的 `Popconfirm` 同此口径）。
      okButtonProps: { danger: true, autoInsertSpace: false },
      cancelButtonProps: { autoInsertSpace: false },
      // 交回 onSubmit 的 promise：antd 只在 onOk 返回 thenable 时才等它（否则确认框立刻关闭）
      onOk: () => onSubmit(submit),
    });
  };

  return (
    <Form<FormValues>
      form={form}
      layout="vertical"
      size="small"
      // 编辑：整张表单取自 `initial`（**尤其是 executionMode** —— 少了它就会被下面的缺省「串行」盖掉，
      // 用户只改了个模型、执行模式却被悄悄改成串行）；新建：只给两个缺省值，行由 Form.List 自带
      initialValues={
        editingRun === undefined
          ? { executionMode: 'serial', useAgentJudge: false }
          : {
            caseId: editingRun.caseId,
            executionMode: editingRun.executionMode,
            useAgentJudge: editingRun.useAgentJudge,
            rows: editingRun.rows.map((row) => ({
              // id 与 effort 都原样进表单值：前者是「哪一行」，后者是「这一行怎么跑的」，
              // 少任何一格都会让一次无改动的保存被服务端判成「改了」（见 RunFormValues 的注释）
              id: row.id,
              agentKind: row.agentKind,
              modelKey: encodeModelKey(row.providerId, row.modelId),
              ...(row.effort === undefined ? {} : { effort: row.effort }),
            })),
          }
      }
      onFinish={handleFinish}
    >
      {/* `Modal.useModal()` 的 contextHolder 必须真的渲染出来，否则 `modal.confirm` 的浮层不出现。
          它渲染的浮层走 portal 挂到 `document.body`（不在这个 `<form>` 的 DOM 里，也不参与表单提交），
          故放在表单内部与放在外层等价。 */}
      {contextHolder}
      <Form.Item name="caseId" label="用例" rules={[{ required: true, message: '请选择用例' }]}>
        <Select
          options={caseOptions}
          placeholder="选择要评测的用例"
          // 可输入文字模糊查询（用户口径）：过滤口径见 matchCaseTitle —— **只搜标题**，
          // 走默认过滤的话「仓库名 / 短哈希」也会命中，与这里的口径不同
          showSearch
          filterOption={(input, option) => matchCaseTitle(titleById.get(String(option?.value ?? '')) ?? '', input)}
          // 应用没配 antd locale（见 case-form-panel 的同一条注释）：不给 notFoundContent，
          // 搜不到时下拉会渲染英文的 "No data"
          notFoundContent="没有匹配的用例"
        />
      </Form.Item>

      <Form.Item name="executionMode" label="执行模式" rules={[{ required: true, message: '请选择执行模式' }]}>
        {/* 顺序与默认值都是用户口径（2026-09-28）：串行在前、并行在后，且默认选中串行。
            默认串行而不是并行，是因为并行不设并发上限——多候选一起开跑时最先撞上的通常是供应商限流。 */}
        <Radio.Group
          options={[
            { value: 'serial', label: '串行' },
            { value: 'parallel', label: '并行' },
          ]}
        />
      </Form.Item>

      <Form.Item
        name="useAgentJudge"
        label="使用智能体评分"
        valuePropName="checked"
        // 说明写在 extra 里而不是另起一段文字：它解释的是这一格，跟着它走才不会在版式变化时脱节
        extra="改动很大、diff 塞不进一次请求的上下文时用它：由设置页配置的评分智能体在候选工作区里自行查看代码后打分。默认关闭。"
        style={{ marginBottom: 8 }}
      >
        <Switch />
      </Form.Item>

      {/* 开关打开 + 设置页没配默认评分智能体 = 服务端在**创建时**就拒收（409 CONFLICT）。
          文案必须说「当场创建不出来」：原来写的是「先去跑候选、到评分那一步才失败」，
          而服务端早已改成创建即拦（`api/src/runs.ts` 的 createRun）——一轮都不会跑起来。 */}
      <Form.Item noStyle shouldUpdate={(prev: FormValues, next: FormValues) => prev.useAgentJudge !== next.useAgentJudge}>
        {({ getFieldValue }) =>
          getFieldValue('useAgentJudge') === true && judgeAgentConfigured === false ? (
            <Alert
              type="warning"
              showIcon
              title="设置页还没有配置默认评分智能体"
              description="这一轮会创建失败（服务端当场拒绝，不会跑候选）。请先到「设置 → 评分配置」选一个默认评分智能体。"
              style={{ marginBottom: 8 }}
            />
          ) : null
        }
      </Form.Item>

      {/* `initialValue` 只在**新建**时给：编辑的行来自 `initialValues.rows`，两边都给会让
          antd 的「已有值优先」在这里变成「谁赢看不出」的不确定状态。 */}
      <Form.List
        name="rows"
        {...(editingRun === undefined ? { initialValue: [{ agentKind: 'claude-code' as const }] } : {})}
        rules={[{ validator: requireAtLeastOneRow }]}
      >
        {(fields, { add, remove, move }, { errors }) => (
          <Flex vertical gap={8}>
            {/* 候选行 = small Table（用户口径 2026-09-29）：整张表订阅「智能体 / 模型」这一对键
                （模型池跟着本行智能体、强度档位跟着本行模型）。原来这一层订阅挂在**每一行**上，
                改成表格后列渲染全在同一个闭包里，逐行订阅反而要多挂一层 —— 判据见 `poolSignature`。 */}
            <Form.Item
              noStyle
              shouldUpdate={(prev: FormValues, next: FormValues) =>
                poolSignature(prev.rows) !== poolSignature(next.rows)
              }
            >
              {({ getFieldValue }) => {
                // 每行的派生数据只算一次，四列共用（理由见 CandidateRow 的注释）
                const candidates: CandidateRow[] = fields.map((field) => {
                  const agentKind = getFieldValue(['rows', field.name, 'agentKind']) as AgentKind | undefined;
                  const pool = agentKind === undefined ? [] : modelOptionsFor(agentKind);
                  const modelKey = getFieldValue(['rows', field.name, 'modelKey']) as string | undefined;
                  const decoded = modelKey === undefined ? null : decodeModelKey(modelKey);
                  return {
                    field,
                    agentKind,
                    pool,
                    // 池子里找不到 = 这一格是脏值（换过智能体、或那家供应商被删了）：不猜，
                    // 于是一个强度档都不列 —— 交集是「服务端算好的」，本地兜不出第二份（spec D10）
                    selected:
                      decoded === null
                        ? undefined
                        : pool.find(
                          (option) =>
                            option.providerId === decoded.providerId && option.modelId === decoded.modelId,
                        ),
                  };
                });
                return (
                  <Table<CandidateRow>
                    size="small"
                    // 候选行没有「第几页」这回事：每一行都是这次评测要跑的东西，藏起来等于少跑
                    pagination={false}
                    // **必须给 `x`，且必须是数值**：这一格就是「宽度不足」的判据本身 —— 表格拿到
                    // `width: 636px` + `min-width: 100%`，于是右栏窄于 636 时它在容器内部横向滚动
                    // （首列与操作列钉在两侧），宽于 636 时按 100% 铺满、一条滚动条都不出现。
                    // 给 `true` 等于没有下限（rc-table 把宽度写成 `auto`、`table-layout` 落回 `auto`，
                    // 表格照样溢出到容器外面）；给 `'max-content'` 则按最宽内容撑开 —— 两者都让固定列失效。
                    scroll={{ x: CANDIDATE_TABLE_MIN_WIDTH }}
                    rowKey={(row) => row.field.key}
                    dataSource={candidates}
                    // 全删光时是**可达状态**（用户点删最后一行）：不给这句就会渲染 antd 默认的英文
                    // "No data"（应用没配 locale）。措辞刻意与校验错误「至少需要一个候选行」不同：
                    // 提交失败时两句会同时在场，同一句话出现两遍会让 `getByText` 与用户都分不清
                    locale={{ emptyText: '还没有候选：点下面的「添加候选」加一行' }}
                    columns={[
                      {
                        title: '智能体',
                        width: CANDIDATE_COLUMN_WIDTH.agent,
                        // 钉在左边（用户口径 2026-10-02）：横向滚动时中间两列从它下面滑过，
                        // 「这一行是哪个智能体」始终看得见。定位是 rc-table 的 `getCellFixedInfo`
                        // 按**实测列宽**算出的 `position: sticky; left: …`，故宽度那一格必须留着。
                        fixed: 'left',
                        render: (_value, row) => (
                          <>
                            {/* 原行 id 必须**注册成一个表单字段**才会出现在 `onFinish` 的 `values` 里。
                                实测（rc-field-form 的 `getFieldsValue` 走 `cloneByNamePathList`：按**已注册
                                字段的路径**从 store 里克隆值）：只放进 `initialValues.rows[i]` 而没有任何
                                `Form.Item` 的 `id` 会被静默丢掉，`values.rows` 只剩 agentKind / modelKey /
                                effort —— 后果是保存时所有行都被当成新行，已经跑出来的结果静默清零
                                （正是编辑模式最贵的那个错）。它不给用户看也不参与校验，故 `hidden`
                                （antd 只为它加 `display: none`：不占位、也不会在单元格里顶出一行）；
                                `Input` 是 rc-field-form 要的「唯一子元素」（没有子元素会当场打开发警告）。 */}
                            <Form.Item name={[row.field.name, 'id']} hidden>
                              <Input />
                            </Form.Item>
                            <Form.Item
                              name={[row.field.name, 'agentKind']}
                              rules={[{ required: true, message: '请选择智能体' }]}
                              style={CELL_ITEM_STYLE}
                            >
                              <Select
                                // 可访问名：字段名现在只在**列头**里（`<th>` 不会成为输入框的可访问名），
                                // 去掉 `label` 后必须由控件自己承担，否则三个下拉都成了无名控件
                                aria-label="智能体"
                                options={AGENT_KINDS.map((kind) => ({ value: kind, label: AGENT_LABELS[kind] }))}
                                // 换智能体必须作废本行已选的**模型与强度**：前者可能是协议不匹配的组合，
                                // 后者是「模型 × 智能体」的函数 —— 留着它，界面会显示一个当前组合根本不支持的档，
                                // 提交后被服务端 400 拦下（响是响，但对用户是一次莫名其妙的失败）。
                                onChange={() => {
                                  form.setFieldValue(['rows', row.field.name, 'modelKey'], undefined);
                                  form.setFieldValue(['rows', row.field.name, 'effort'], undefined);
                                }}
                              />
                            </Form.Item>
                          </>
                        ),
                      },
                      {
                        title: '模型',
                        // 唯一不给宽度的列：剩余宽度全给它（长模型名 + 两个 Tag 最吃宽度）
                        render: (_value, row) => (
                          <Flex vertical gap={4}>
                            <Form.Item
                              name={[row.field.name, 'modelKey']}
                              rules={[{ required: true, message: '请选择模型' }]}
                              style={CELL_ITEM_STYLE}
                            >
                              <Select
                                aria-label="模型"
                                placeholder={row.pool.length === 0 ? '没有可选的模型' : '选择模型'}
                                // 换模型必须作废已选强度：交集随模型变，留着的脏值会在创建时被服务端 400 拦下
                                onChange={() => {
                                  form.setFieldValue(['rows', row.field.name, 'effort'], undefined);
                                }}
                                options={row.pool.map((option) => ({
                                  value: encodeModelKey(option.providerId, option.modelId),
                                  // 来源与窗口各一个 Tag（spec §5.1 / D4）；Select 默认不开启搜索，ReactNode 标签安全
                                  label: (
                                    <Flex align="center" gap={4}>
                                      <span>{option.modelId}</span>
                                      {/**
                                       * 供应商名（2026-09-30）：双协议智能体（DSH）的池子是**两类协议的并集**，
                                       * 而 `providerId` 不同 ⇒ 选出来的是**不同的行**。只给模型名的话，
                                       * 「同一个模型名挂在两个网关」（`jd/GLM-5.2` 这类跨网关同名的模型很常见）
                                       * 两个选项会长得一模一样——用户无从判断自己选的是哪一个。
                                       * 用 `Typography.Text type="secondary"` 而不是自定义样式：字号交主题 token。
                                       */}
                                      <Typography.Text type="secondary">{option.providerName}</Typography.Text>
                                      <Tag>{option.source === 'manual' ? '手工维护' : '自动拉取'}</Tag>
                                      <ContextWindowTag contextWindow={option.contextWindow} />
                                    </Flex>
                                  ),
                                }))}
                              />
                            </Form.Item>
                            {/* 「没有可选的模型」跟着**模型**这一格走：它就是这一格选不出东西的原因 */}
                            {row.agentKind !== undefined && row.pool.length === 0 && (
                              <Alert
                                type="warning"
                                showIcon
                                title={`${AGENT_LABELS[row.agentKind]} 没有可选的模型：请到设置里添加协议匹配的供应商，并为它维护模型清单`}
                              />
                            )}
                          </Flex>
                        ),
                      },
                      {
                        title: '思考强度',
                        width: CANDIDATE_COLUMN_WIDTH.effort,
                        render: (_value, row) => (
                          <Form.Item name={[row.field.name, 'effort']} style={CELL_ITEM_STYLE}>
                            <Select
                              aria-label="思考强度"
                              allowClear
                              // 不预选推荐档（spec D14）：预选会让「我没选过」与「我选了推荐档」在快照里长得一样。
                              // 「未指定」是**清空态**，所以它只能由 placeholder 承担；2026-10-06：这句话要说清
                              // 未选**不是**「沿用厂商默认档」——哪一家会落到自家的哪个缺省档由元数据给
                              // （`effortPlaceholder`），其余家不传档位、由厂商推断；要关闭必须显式选
                              // 下面那个 `off`。
                              placeholder={effortPlaceholder(row.agentKind, defaultEffortOf)}
                              // 强度选项**只列服务端算好的候选**（spec D10）：上游档位原样列出来会让
                              // 不支持的组合到运行时才炸（dsh 侧是硬报错），而就近取整是静默改语义。
                              // 2026-10-06：该候选恒含关闭档 `off` 且保证它排第一；档位文案一律照上游
                              // 的词汇原样写（改口径 2026-10-07：关闭档也不再加工，与行卡片上那个
                              // `off` 标签是同一个词）。
                              options={(row.selected?.efforts ?? []).map((effort) => ({
                                value: effort,
                                // 「（推荐）」只加在非关闭档上：关闭档要表达的是「关掉思考」，
                                // 上游就算推荐它也印不上「（推荐）」这个后缀
                                label:
                                  effort !== EFFORT_OFF && effort === row.selected?.recommendedEffort
                                    ? `${effort}（推荐）`
                                    : effort,
                              }))}
                            />
                          </Form.Item>
                        ),
                      },
                      {
                        // 列名留空（用户口径 2026-09-29 二稿）：三个按钮各自带 Tooltip 与 `aria-label`，
                        // 表头再写一遍「操作」只是白占这一列的宽度（这一列只装得下三个图标）
                        title: '',
                        width: CANDIDATE_COLUMN_WIDTH.actions,
                        // 右对齐（用户口径）：三个动作贴在本列靠右的边上，列宽才压得下来 ——
                        // 在此之前「删除」是文字按钮，光它自己就占掉这一列近一半宽度
                        align: 'right',
                        // 钉在右边（用户口径 2026-10-02）：横向滚动时三个按钮不被滚走 ——
                        // 它们是**行上的唯一操作**，滚出去就等于这一行删不掉、也换不了顺序
                        fixed: 'right',
                        render: (_value, row) => (
                          // 三个图标按钮（用户口径）：文字进 Tooltip，可访问名走 `aria-label`
                          //（Tooltip 不产生可访问名，不给 aria-label 就是个无名按钮）
                          <Flex align="center" justify="flex-end" gap={2}>
                            {/* 上移 / 下移（用户口径）：候选顺序就是**串行执行顺序**，所以顺序本身要能改。
                                边界行**置灰而不是隐藏**：按钮位置固定，眼睛不用重新找；隐藏会让
                                「第一行没有上移」变成一件要靠猜的事。 */}
                            <Tooltip title="上移">
                              <Button
                                size="small"
                                color="default"
                                variant="link"
                                icon={<ArrowUpOutlined aria-hidden />}
                                aria-label="上移"
                                disabled={row.field.name === 0}
                                onClick={() => move(row.field.name, row.field.name - 1)}
                              />
                            </Tooltip>
                            <Tooltip title="下移">
                              <Button
                                size="small"
                                color="default"
                                variant="link"
                                icon={<ArrowDownOutlined aria-hidden />}
                                aria-label="下移"
                                disabled={row.field.name === fields.length - 1}
                                onClick={() => move(row.field.name, row.field.name + 1)}
                              />
                            </Tooltip>
                            <Tooltip title="删除">
                              <Button
                                size="small"
                                // 危险色 + link 形态（两个一起给：antd 6 的 `variant` 单给会静默降级成实线）
                                color="danger"
                                variant="link"
                                icon={<DeleteOutlined aria-hidden />}
                                aria-label="删除"
                                // 认的是**本行的 `field.name`**（表单值里的下标），不是列的序号：
                                // 拿 index 去删会删掉别人那一行 —— 表格里最容易错的一处
                                onClick={() => remove(row.field.name)}
                              />
                            </Tooltip>
                          </Flex>
                        ),
                      },
                    ]}
                  />
                );
              }}
            </Form.Item>

            <Form.ErrorList errors={errors} />
            {/* 创建 / 添加类按钮全站同形：前导加号 + 虚线边框。两个细节都不能省：
                ① `color="default"` 与 `variant="dashed"` 必须成对给——antd 6 的 `variant` 单给会静默
                降级成实线（`Button.js` 只在 `color && variant` 时用它们）；② 图标 `aria-hidden` 是必需的：
                `@ant-design/icons` 自带 `role="img" aria-label="plus"`，不藏起来可访问名会变成
                「plus 添加候选」，屏读器与按名字定位按钮的用例都会失配 */}
            <Button
              color="default"
              variant="dashed"
              size="small"
              icon={<PlusOutlined aria-hidden />}
              onClick={() => add({ agentKind: 'claude-code' })}
            >
              添加候选
            </Button>
          </Flex>
        )}
      </Form.List>

      <Flex gap={8} style={{ marginTop: 16 }} justify="flex-end">
        <Button size="small" onClick={onCancel}>
          取消
        </Button>
        {/* 提交按钮是「确定」而不是「创建评测」（用户口径）：它只负责提交这张已经写着「创建评测」的右栏表单，
            按钮再重复一遍标题没有新信息；形态回到实心主按钮——它推进的是流程（取消 / 确定这一组），
            虚线加号那一套只留给「新建一条记录」的入口（见本文件「添加候选」与各页工具条）。 */}
        <Button type="primary" size="small" htmlType="submit" loading={saving}>
          确定
        </Button>
      </Flex>
    </Form>
  );
}
