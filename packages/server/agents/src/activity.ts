/**
 * 三家共用的**活动行词表**：把一条通知翻成「此刻在做什么」的一句话（`log.summary`）。
 * 本模块是这一层的唯一实现，口径见 features-design §5.6.9（各家「在哪一条通知上发」也列在那里）。
 *
 * 为什么要有这一个文件：候选卡片底部那一行只吃 `log` 事件的 `summary`（判定在 `@aieval/client`
 * 的 `activityOf`），而这句话过去由三家各写一份——同一次工具调用于是有三种信息量（claude 只给工具名
 * `调用工具 Bash`，dsh 给参数 `调用工具 pwsh：git status`，codex 什么都不给），子任务摘要那两份还是
 * 逐字复制粘贴（连「名字缺失就回落成字面量『子任务』」这个毛病一起复制）。现在**只有这一份实现**，
 * 跨家同形由 `src/activity-conformance.test.ts` 逐字钉住。
 *
 * 三条口径：
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
import { safeStringify } from './emit';

/**
 * 摘要主体的长度上限（`调用工具 pwsh：` 这样的前缀不计入）。
 * 沿用 dsh 自 2026-09-29 起的口径：这一行的用途是「一眼看出在干什么」，
 * 完整参数与输出都在抽屉的原始负载里 ⇒ 超长一律截断带省略号。
 */
export const ACTIVITY_SUMMARY_MAX_LENGTH = 120;

/**
 * 参数里最值得当摘要的字段，**按优先级**排：都是「说明了在干什么」的那一格（三家实测都见过）。
 * `job_id` 不能漏：它是 dsh 的 `job_output` / `job_kill` **唯一**的入参（真机样本
 * `{"job_id": "pwsh-16", "timeout_ms": 420000, "wait": true}`）——漏了它，那两条摘要就退化成整串 JSON。
 */
const PREFERRED_ARGUMENT_KEYS = ['command', 'file_path', 'path', 'job_id', 'query', 'pattern', 'description', 'url', 'prompt'] as const;

/** 计划类入参的键名：命中**任意一个**数组就按「更新计划：N 步」说（claude 的 `todos` / dsh 的 `steps` / codex 的 `plan`） */
const PLAN_ARGUMENT_KEYS = ['todos', 'plan', 'steps'] as const;

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

/**
 * 工具调用的一句话：`调用工具 <名>：<参数摘要>`。
 *
 * 名字或参数**只有一个**时句子照样成立：`调用工具 Bash`（参数没给）/ `调用工具：ls`（名字没给）。
 * 两者都没有就给 `调用工具`——不编一个名字（编出来的名字会让排障的人去找一个不存在的工具），
 * 也不留一个空冒号。
 *
 * 计划类入参**先判**：`todos` / `plan` / `steps` 命中时整体换成 `更新计划：N 步`——
 * 那三个键的值是一整张清单，转成 JSON 只是把一坨结构塞进一行，而「几张表、第几版」才是使用者要的。
 */
export function toolCallSummary(name: string | null, input: unknown): string {
  const trimmed = name === null ? '' : name.trim();
  const title = trimmed === '' ? '调用工具' : `调用工具 ${trimmed}`;
  const steps = planStepsOf(input);
  if (steps !== null) return planSummary(steps);
  const hint = argumentHint(input);
  return hint === '' ? title : `${title}：${hint}`;
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
function planStepsOf(input: unknown): number | null {
  const record = asRecord(input);
  if (record === null) return null;
  for (const key of PLAN_ARGUMENT_KEYS) {
    const value = record[key];
    if (Array.isArray(value)) return value.length;
  }
  return null;
}

/**
 * 参数摘要：**一句话**，不是参数的完整转储。
 *
 * 四级取法，顺序不能换：
 *   ① 优先字段里第一个非空字符串（`command` → `file_path` → …）；
 *   ② 改动清单（`changes[].path`）→ 列路径，超过两个说「等 N 个」——补丁工具的入参里没有 command，
 *      而「改了哪些文件」正是它在干什么；
 *   ③ 都取不到 ⇒ 紧凑 JSON（**不假装认识那个形状**，但也不假装没有参数）；
 *   ④ 整串解析不动（被截断 / 本来就是纯文本）⇒ 原样用。
 * 产物会进事件日志，故一路单行化 + 截断。
 */
function argumentHint(input: unknown): string {
  if (input === null || input === undefined) return '';
  const record = asRecord(input);
  if (record === null) return typeof input === 'string' ? clipSummary(oneLine(input)) : '';
  for (const key of PREFERRED_ARGUMENT_KEYS) {
    const value = record[key];
    if (typeof value === 'string' && value !== '') return clipSummary(oneLine(value));
  }
  const paths = changedPathsOf(record);
  if (paths.length > 0) return clipSummary(pathsOf(paths));
  const json = safeStringify(record);
  return json === '' ? '' : clipSummary(oneLine(json));
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
