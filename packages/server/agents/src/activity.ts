/**
 * 三家共用的**活动摘要词表**：把一条通知/一次工具调用翻成「此刻在做什么」的一句话。
 * 本模块是这一层的唯一实现（各家「在哪一条通知上发」由各适配器决定）。
 *
 * 为什么要有这一个文件：候选卡片底部那一行只吃 `log` 事件的 `summary`（判定在 `@aieval/client`
 * 的 `activityOf`），而这句话过去由三家各写一份——同一次工具调用于是有三种信息量（claude 只给工具名
 * `调用工具 Bash`，dsh 给参数 `调用工具 pwsh：git status`，codex 什么都不给），子任务摘要那两份还是
 * 逐字复制粘贴（连「名字缺失就回落成字面量『子任务』」这个毛病一起复制）。现在**只有这一份实现**，
 * 跨家同形由 `src/activity-conformance.test.ts` 逐字钉住。
 *
 * ## 一句话怎么拼（用户裁定「description 优先，没有就按每个簇自己拼」）
 *
 * 「参数里第一个非空字符串」那把尺子对三家**都不够**：真机里 `Read` 永远吐一串绝对路径（1495px、
 * 被 CSS 截掉一半），`apply_patch` 吐紧凑 JSON，`exec_command` 永远同一个形。所以现在分三步：
 *
 *   1. **`description` 优先**——它是模型自己为「这一步在干什么」写的一句话
 *      （Claude `Bash` 的说明逐字：「the user reads this description, often without seeing the command」；
 *      DSH 的 `pwsh`/`bash` 更把它设成**必填**并在运行期校验）。只有描述、没有目标
 *      （`command` / `file_path` / `pattern` / `url`）时，那句描述就是答案；**两个都在时给
 *      `描述（目标）`**——描述说明「为什么」，目标说明「哪一个」，而同一行里两次 `exec_command`
 *      的描述可能逐字相同，只留描述会让两次调用在界面上长得一模一样。
 *   2. **没有 `description` 就按族拼**（`targetOf`）：读文件给 `路径:起-止`、搜内容给
 *      `模式（范围）`、跑命令给命令原文、派子任务给任务名……每个族一种拼法。
 *      判据是**族**不是家：同一个工具在三家的名字不同（`Read` / `read`），族是跨家一致的那个轴，
 *      而 `activity-conformance.test.ts` 钉的正是「同一件事三家逐字同一句」。
 *   3. 兜底是既有的四级取法（优先键 → `changes[].path` → 紧凑 JSON → 原样）：**不认识的形状不猜**，
 *      但也不假装没有参数。只对 `family === null`（本仓不认识这个工具）生效——认得的那十族不该
 *      退回这档（那会让 `Read` 又变回一串绝对路径）。
 *
 * ## 三个消费方与两种产物
 *   · **活动行**（卡片底部那一行）取 `toolCallSummary`——**整句**，名字在句子里；
 *   · **工具行**（抽屉里那条摘要行）取 `toolCallHint`——**只有冒号后面那一段**，
 *     因为那一行把工具名渲染成一个独立元素，带前缀就是同一件事说两遍；
 *   · **`tool-call` 块的 `summary`** 落的是后者（见 `message.ts` 的 `toolCallBlockDraft`）。
 *
 * ## 三条口径
 *   1. **只播「正在做什么」**：工具调用（带参数）、工具报错、子任务派发/收场、计划更新。
 *      工具成功返回、推理正文、轮次播报**不给摘要**——它们的落点是结果块、思考块与原始输出面板，
 *      而活动行被它们占据时，最新一句会停在「工具返回：<一长串路径>」或一段英文推理上（真机形态：
 *      run `08b56e95` 的 dsh 行与 claude 行，末尾都停在 `思考：Only one file changed…`）。
 *   2. **不给摘要 ≠ 不落事件**：`text` 照旧是原始负载，抽屉的原始输出面板逐字可见；
 *      拿掉摘要只是让活动行**保留上一句人话**，不是把证据丢掉。
 *   3. **一句话必须是一句话**：单行化 + 截断（卡片底部只有一行，换行会被 CSS 省略号吃掉）。
 *
 * 与服务端其余日志的关系：本模块只产出**字符串**，不碰事件形状——发不发那一条 `log`、
 * 原始负载是什么，仍由各家的 `events.ts` 决定。
 */
import type { ToolFamily } from '@aieval/contracts';
import { safeStringify } from './emit';
import { classifyTool } from './tool-family';

/**
 * 摘要主体的长度上限（`调用工具 pwsh：` 这样的前缀不计入）。
 * 沿用 dsh 的口径：这一行的用途是「一眼看出在干什么」，
 * 完整参数与输出都在抽屉的原始负载里 ⇒ 超长一律截断带省略号。
 */
export const ACTIVITY_SUMMARY_MAX_LENGTH = 120;

/**
 * **描述优先那一档的边界**：只有这一个键名算「模型自己写的一句话」，逐字。
 *
 * 为什么不把近义词一起收进来（协议核查过的三个名字都不收）：
 *   · `reason`（DSH `job_kill`）与 `justification`（Codex `exec_command`）是**审批语义**
 *     （"User-facing approval question for require_escalated"），拿它当「这一步在干什么」是语义挪用；
 *   · `explanation`（Codex `update_plan`）才是同一件事，但它**不进摘要**——它属于计划卡片那一格
 *     结构化事实（`ToolCallPayload.note`），而 `summary` 是一句话，两格各司其职。
 */
const DESCRIPTION_KEY = 'description';

/**
 * 通用兜底的优先键，**按优先级**排。只有「本仓不认识的工具」（`family === null`）才走到这里：
 * 认识的那十族各有自己的拼法（`targetOf`），而这张表是「不假装认识那个形状，但也不假装没有参数」
 * 的最后一档。
 *
 * 顺序沿用既有口径：`command` 仍排在 `file_path` / `path` 之前（一个陌生工具若同时给了命令与路径，
 * 命令才是它在干什么）。`description` **不在这张表里**——它在两条路之前单独判，见 `DESCRIPTION_KEY`。
 */
const PREFERRED_ARGUMENT_KEYS = ['command', 'file_path', 'path', 'job_id', 'query', 'pattern', 'url', 'prompt'] as const;

/** 计划类入参的键名：命中**任意一个**数组就按「更新计划：N 步」说（claude 的 `todos` / dsh 的 `steps` / codex 的 `plan`） */
const PLAN_ARGUMENT_KEYS = ['todos', 'plan', 'steps'] as const;

/** 十族全表（与契约的 `TOOL_FAMILIES` 同集）；用来区分「这家我们认识」与「完全不认识」 */
const KNOWN_FAMILIES = new Set<ToolFamily>([
  'read-file',
  'write-file',
  'edit-file',
  'search-content',
  'list-files',
  'run-shell',
  'web-search',
  'spawn-agent',
  'task',
  'ask-user',
]);

/** 子任务收场的中文档位；表里没有的状态折成「已结束」——**不假装认识**（原文仍在原始负载里） */
const SUBAGENT_STATUS_LABELS: Record<string, string> = {
  completed: '已完成',
  failed: '失败',
  stopped: '已停止',
};

/** 单行化：换行与连续空白压成一个空格（摘要要能塞进卡片底部那一行） */
export function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** 截断到上限（带省略号）；完整内容在原始负载里，不进摘要字段 */
export function clipSummary(text: string): string {
  return text.length <= ACTIVITY_SUMMARY_MAX_LENGTH ? text : `${text.slice(0, ACTIVITY_SUMMARY_MAX_LENGTH)}…`;
}

/** 把摘要算出来需要的那三格装成一个对象（两个入口 `toolCallSummary` / `toolCallHint` 共用） */
interface FamilyContext {
  /** 已 trim 的工具名；空串 = 没采到 */
  name: string;
  /** 厂商原文（对象 / JSON 字符串 / 标量都可能有） */
  input: unknown;
  /** 名查表判出来的族；`null` = 本仓不认识这个工具 */
  family: ToolFamily | null;
}

/** 工具名与入参 → 算摘要要的那三格。`family` 省略时按名字现判（判据只有 `tool-family.ts` 一份） */
function contextOf(name: string | null, input: unknown, family?: ToolFamily | null): FamilyContext {
  const trimmed = name === null ? '' : name.trim();
  return { name: trimmed, input, family: family ?? classifyTool(trimmed) };
}

/**
 * 工具调用那一句的**前半句**：`调用工具 <名>`（名字没给就是 `调用工具`）。
 * 导出来给**工具行**用：那一行把工具名渲染成一个独立元素，摘要不该再复述一遍名字
 * （`Bash` 后面跟着「调用工具 Bash：…」是同一件事说两遍），所以工具行取 `toolCallHint` +
 * 名字由界面自己排。活动行相反——它只有一行，名字必须在句子里（`toolCallSummary`）。
 */
export function toolCallTitle(name: string | null): string {
  const trimmed = name === null ? '' : name.trim();
  return trimmed === '' ? '调用工具' : `调用工具 ${trimmed}`;
}

/**
 * **活动行**的那一句话：`调用工具 <名>：<摘要主体>`。
 *
 * 名字或主体**只有一个**时句子照样成立：`调用工具 Bash`（什么参数都没给）/
 * `调用工具：ls`（名字没给）。两者都没有就给 `调用工具`——不编一个名字（编出来的名字会让排障的人
 * 去找一个不存在的工具），也不留一个空冒号。
 *
 * 计划类调用在这里**整体换句**（`更新计划：2 步`，不再带 `调用工具` 前缀）：那三个键的值是一整张
 * 清单，而「几张表、第几版」才是使用者要的——而工具行拿到的仍是 `2 步`（见 `detailOf`）。
 *
 * @param name 厂商原始工具名（`null` = 拿不到）
 * @param input 厂商原文：对象，或 dsh 那种**未解析的 JSON 字符串**（本模块自己解析）
 * @param family 适配器已判定的族；省略时按 `name` 现判
 */
export function toolCallSummary(name: string | null, input: unknown, family?: ToolFamily | null): string {
  const context = contextOf(name, input, family);
  const steps = planStepsOf(asRecord(input));
  // 计划类**整体换句**：`更新计划：N 步`（`task` 族；codex 的原生计划通知也走这一句）
  if (steps !== null && context.family === 'task') return planSummary(steps);
  const hint = detailOf(context);
  const title = toolCallTitle(name);
  return hint === '' ? title : `${title}：${hint}`;
}

/**
 * **工具行**的摘要主体：只有冒号后面那一段（没有名字、没有 `调用工具` 前缀）。
 * 界面把它渲染在工具名那一格旁边（`ToolItemDetail` 的 `inputSummary`）。
 */
export function toolCallHint(name: string | null, input: unknown, family?: ToolFamily | null): string {
  return detailOf(contextOf(name, input, family));
}

/**
 * 摘要主体（冒号后面那一段），三档按序：
 *   ① 计划类入参 → `N 步`（先判：它的值是一整张清单，不是「第一个非空字符串」能表达的）；
 *   ② **描述**（有目标就拼成 `描述（目标）`）；
 *   ③ 族自己的拼法（`targetOf`），族不认或拼不出再回落到通用参数摘要。
 */
function detailOf(context: FamilyContext): string {
  const record = asRecord(context.input);
  const steps = planStepsOf(record);
  // 计划类的值是**一整张清单**：转成 JSON 只是把一坨结构塞进一行，而「几步」才是使用者要的
  if (steps !== null) return `${steps} 步`;

  const description = descriptionOf(record);
  const target = targetOf(context, record);
  if (description !== null) {
    // 同一句话（厂商把描述同时写进 `command` 与 `description`）⇒ 不重复一遍
    return target === null || target === description ? description : `${description}（${target}）`;
  }
  if (target !== null) return target;
  // 目标取不到：**认得的族**给一句同义的话（派发子任务 / 提问），
  // **不认识的族**才退回紧凑 JSON——那种情况下我们唯一能诚实给的就是原文
  return familyOf(context.family) ? (familyHint(context) ?? '') : (genericHint(record) ?? '');
}

/** 这个族我们认不认识（`null` = 认不出工具名 ⇒ 走通用兜底，不给族专属的句子） */
function familyOf(family: ToolFamily | null): family is ToolFamily {
  return family !== null && KNOWN_FAMILIES.has(family);
}

/**
 * **描述**：模型自己写的那句话。解析后是字符串且去掉首尾空白非空才算——**不拿别的字段凑**
 * （凑出来的句子会让「哪次调用干了什么」变成一个看起来成立、实际是错答案的描述）。
 */
function descriptionOf(record: Record<string, unknown> | null): string | null {
  if (record === null) return null;
  const value = record[DESCRIPTION_KEY];
  if (typeof value !== 'string') return null;
  const text = oneLine(value);
  return text === '' ? null : clipSummary(text);
}

/**
 * **目标**：这次调用作用在什么上——「哪一个」的那一格，与描述（「为什么」）互补。
 *
 * 逐族取值，**每族一种拼法**（用户口径「没有 description 就按每个簇自己拼」）：
 *   · `run-shell`  → `command`
 *   · `read-file`  → `file_path`（给了 `offset` / `limit` 就补 `:起-止`，只给一个端点也算）
 *   · `write-file` → `file_path`
 *   · `edit-file`  → `file_path`，或 codex `apply_patch` 的 `changes[].path` 清单
 *   · `search-content` → `模式（路径）`、`模式（include）` 或 `模式`（dsh `grep` 只有 `pattern`）
 *   · `list-files` → `pattern`
 *   · `web-search` → `query` / `url`
 *   · `spawn-agent` → **`prompt`**——派发工具的 `description` 按厂商定义就是子任务名，
 *     它已经进了描述那一档，同一个值出现两遍没有信息量，故这里补任务正文
 *   · `ask-user`   → 第一个问题的正文（正文空但清单在就说「N 问」）
 *   · `task`       → `null`（步数在 `detailOf` 的①档就返回了）
 *   · `null`（不认识）→ 通用优先键那一档
 *
 * 拿不到就给 `null`——**不编一个目标**（编出来的目标会让排障的人去找一个不存在的文件）。
 */
function targetOf(context: FamilyContext, record: Record<string, unknown> | null): string | null {
  // 入参不是对象（解析不动的字符串 / 标量）：族那套键名一个都取不到，原样用是唯一诚实的答案
  if (record === null) return rawHint(context.input);
  switch (context.family) {
    case 'run-shell':
      return stringValue(record.command);
    case 'read-file':
      return readTarget(record);
    case 'write-file':
      return filePathOf(record);
    case 'edit-file':
      return editTarget(record);
    case 'search-content':
      return searchTarget(record);
    case 'list-files':
      return stringValue(record.pattern);
    case 'web-search':
      return stringValue(record.query) ?? stringValue(record.url);
    case 'spawn-agent':
      return stringValue(record.prompt);
    case 'ask-user':
      return askTarget(record);
    case 'task':
      return null;
    default:
      return genericHint(record);
  }
}

/**
 * 路径那一格：`file_path` 是三家正名，`path` 是同义的旧写法（老夹具与 MCP 工具都用它）。
 * 两个都认——**只认一个会让另一个静默退化成紧凑 JSON**，而「同一族的卡片在某一家上是空的」
 * 正是最难查的一类缺陷（真机 `Edit` 给 `file_path`，而历史夹具给 `path`）。
 */
function filePathOf(record: Record<string, unknown>): string | null {
  return stringValue(record.file_path) ?? stringValue(record.path);
}

/**
 * 读文件：路径 +（可选）行区间。
 * 区间**只给到手的那个端点**：`offset` 有、`limit` 无 ⇒ `:10-`；`limit` 有、`offset` 无 ⇒ `:1-120`
 * （`offset` 缺省就是 1，这不是编造，是工具的既有语义）。两个都没有就给纯路径。
 */
function readTarget(record: Record<string, unknown>): string | null {
  const path = filePathOf(record);
  if (path === null) return null;
  const offset = numberOf(record.offset);
  const limit = numberOf(record.limit);
  if (offset === null && limit === null) return path;
  const from = offset ?? 1;
  return limit === null ? `${path}:${from}-` : `${path}:${from}-${from + limit - 1}`;
}

/**
 * 改文件：两条形状各一种拼法。
 * `file_path` / `path`（claude `Edit` / dsh `edit`）直接给路径；
 * codex 的 `apply_patch` 没有路径那一格，只有 `changes[].path` ⇒ 走清单（>2 条给「等 N 个」）。
 */
function editTarget(record: Record<string, unknown>): string | null {
  const path = filePathOf(record);
  if (path !== null) return path;
  const paths = changedPathsOf(record);
  return paths.length === 0 ? null : clipSummary(pathsOf(paths));
}

/**
 * 搜内容：三家的键名不同、给的信息量也不同。
 * `pattern` 必有（三家的 schema 都把它设成必填），范围那两格（`path` / `include`）给哪个用哪个；
 * 两个都没有就只给模式——**不补一个默认范围**（那会让人以为搜索被限制了）。
 */
function searchTarget(record: Record<string, unknown>): string | null {
  const pattern = stringValue(record.pattern);
  if (pattern === null) return null;
  const scope = stringValue(record.path) ?? stringValue(record.include);
  return scope === null ? pattern : `${pattern}（${scope}）`;
}

/** 提问：第一个问题的正文；问题清单在但正文空 ⇒ 说清楚「几问」（不写「提问：」这样的空冒号） */
function askTarget(record: Record<string, unknown>): string | null {
  const questions = record.questions;
  if (!Array.isArray(questions)) return null;
  for (const one of questions) {
    const prompt = asRecord(one)?.question;
    const text = typeof prompt === 'string' ? oneLine(prompt) : '';
    if (text !== '') return clipSummary(text);
  }
  return questions.length === 0 ? null : `${questions.length} 问`;
}

/**
 * **族自己的拼法**（`targetOf` 的镜像）：族认得但目标那一格取不到时的最后一档。
 * 只有 `spawn-agent` 与 `ask-user` 需要它——它们的「目标」不在参数里而在**这次调用自身**
 * （派发了一个子任务、问了一个问题），拿不到任务名/问题正文时给一句同义的话，好过给一串 JSON。
 */
function familyHint(context: FamilyContext): string | null {
  if (context.family === 'spawn-agent') return '派发子任务';
  if (context.family === 'ask-user') return '提问';
  return null;
}

/**
 * 通用参数摘要：**一句话**，不是参数的完整转储。
 *
 * 四级取法，顺序不能换：
 *   ① 优先字段里第一个非空字符串（`command` → `file_path` → `job_id` → …）；
 *   ② 改动清单（`changes[].path`）→ 列路径，超过两个说「等 N 个」——补丁工具的入参里没有 command，
 *      而「改了哪些文件」正是它在干什么；
 *   ③ 都取不到 ⇒ 紧凑 JSON（**不假装认识那个形状**，但也不假装没有参数）；
 *   ④ 整串解析不动（被截断 / 本来就是纯文本）⇒ 原样用。
 * 产物会进事件日志，故一路单行化 + 截断。
 */
function genericHint(record: Record<string, unknown> | null): string | null {
  if (record === null) return null;
  for (const key of PREFERRED_ARGUMENT_KEYS) {
    const value = stringValue(record[key]);
    if (value !== null) return value;
  }
  const paths = changedPathsOf(record);
  if (paths.length > 0) return clipSummary(pathsOf(paths));
  const json = safeStringify(record);
  return json === '' ? null : clipSummary(oneLine(json));
}

/**
 * 入参**根本不是对象**时的那一档（原样用）。
 *
 * 走到这里的只有两种形态：整串解析不动（被截断 / 本来就是纯文本，真机 dsh 的 `arguments` 是
 * 未解析的 JSON 字符串，解析失败就落这里）与标量。两者的归宿都是「原样用」——
 * 数组与标量**不算对象**，但不等于「没有参数」。
 */
function rawHint(input: unknown): string | null {
  if (input === null || input === undefined) return null;
  if (typeof input === 'string') return stringValue(input);
  if (typeof input === 'number' || typeof input === 'boolean') return String(input);
  return null;
}

/** 工具报错的一句话：`工具报错：<内容>`；内容缺失时只留前半句（不留空冒号） */
export function toolErrorSummary(text: string | null): string {
  const detail = text === null ? '' : clipSummary(oneLine(text));
  return detail === '' ? '工具报错' : `工具报错：${detail}`;
}

/** 计划更新的一句话：`更新计划：N 步`（codex 的原生 `turn/plan/updated` 与另两家的清单工具同形） */
export function planSummary(steps: number): string {
  return `更新计划：${steps} 步`;
}

/** 子任务派发的一句话：`已派发子任务：<任务名>` */
export function subagentDispatchSummary(name: string | null): string {
  return withSubagentName('已派发子任务', name);
}

/**
 * 子任务收场的一句话：`子任务<档位>：<任务名>`。
 * 状态取契约的五态（`completed` / `failed` / `stopped` / 其余折成「已结束」）——
 * 厂商的原始状态串照旧留在日志的 `text` 里，不往这句中文里塞英文。
 */
export function subagentSettledSummary(name: string | null, status: string | null): string {
  const label = status === null || status === '' ? '已结束' : (SUBAGENT_STATUS_LABELS[status] ?? '已结束');
  return withSubagentName(`子任务${label}`, name);
}

/**
 * 拼接任务名。
 * **名字缺失时不留冒号、也不编占位名**：旧实现两家都写成 `已派发子任务：子任务`——
 * 一句同义反复，读的人只会以为界面坏了（真机形态见 `activity-conformance.test.ts` 的登记）。
 */
function withSubagentName(title: string, name: string | null): string {
  const who = name === null ? '' : clipSummary(oneLine(name));
  return who === '' ? title : `${title}：${who}`;
}

/** 计划步数：入参对象里有那三个键中的任意一个数组就认（空数组也算——「0 步」是事实，不是「没采到」） */
function planStepsOf(record: Record<string, unknown> | null): number | null {
  if (record === null) return null;
  for (const key of PLAN_ARGUMENT_KEYS) {
    const value = record[key];
    if (Array.isArray(value)) return value.length;
  }
  return null;
}

/** 一个「一句话」的字符串格：非字符串与空白串都记「没有」（摘要里不留空冒号） */
function stringValue(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = oneLine(value);
  return text === '' ? null : clipSummary(text);
}

/** 一个数字格：非有限数记「没有」（`offset: null` 与「没给这一格」同义） */
function numberOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** `changes[].path`（补丁 / 文件改动工具的入参形状），按出现顺序去重 */
function changedPathsOf(record: Record<string, unknown>): string[] {
  const changes = record.changes;
  if (!Array.isArray(changes)) return [];
  const out: string[] = [];
  for (const one of changes) {
    const path = asRecord(one)?.path;
    if (typeof path === 'string' && path !== '' && !out.includes(path)) out.push(path);
  }
  return out;
}

/** 路径列表：两个以内全列，更多则前两个 + 「等 N 个」（一行里塞不下一条补丁的全部路径） */
function pathsOf(paths: string[]): string {
  if (paths.length <= 2) return paths.join('、');
  return `${paths[0] ?? ''}、${paths[1] ?? ''} 等 ${paths.length} 个`;
}

/**
 * 收窄成对象。
 * 字符串先当 JSON 解析（dsh 的 `arguments` 是字符串、claude 与 codex 已是对象，三家共用这一条）；
 * 数组与标量**不算对象**——它们的归宿是「原样用」那一支，不是被当成没有参数。
 */
function asRecord(input: unknown): Record<string, unknown> | null {
  if (typeof input === 'string') {
    try {
      return asRecord(JSON.parse(input));
    } catch {
      // 不是合法 JSON（被截断 / 本来就是纯文本）：当「解析不了」，由调用方原样用
      return null;
    }
  }
  return typeof input === 'object' && input !== null && !Array.isArray(input) ? (input as Record<string, unknown>) : null;
}
