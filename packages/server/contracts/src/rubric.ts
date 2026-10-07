/**
 * 评分表契约（**评分体系的唯一真源**）：组 → 评分项（id / goal / weight）二级表格，
 * 以及由它派生的五个纯函数：满分、项引用键、校验、总分、送模型的渲染。
 *
 * 五个必须成立的口径：
 *   1. **组不带权重**，只有项带权重；**满分 = 全部项权重之和**，不强制等于 100
 *      （100 / 120 / 300 分都由表格自己决定，故满分不是一个常量）；
 *   2. `RubricSchema` **刻意不设 `.min(1)`**：空表（`{ groups: [] }`）是一个真实存在的界面状态
 *      （新建用例的初值、刚删完所有组），强行要求至少一组就等于把「新建用例」判为非法。
 *      非空要求由 `validateRubric` 在**提交时**给出；
 *   3. 项 id **允许为空**：空 id 的项在渲染提示词时按**位置**分配引用键 `#k`
 *      （k = 全表顺序号，从 1 开始、跨组连续）。不改动落盘数据——界面表格里不该出现用户没写过的 id；
 *   4. 权重上限 `MAX_ITEM_WEIGHT`：防的不是「用户想给多少分」，而是 `totalScore` / `maxScore`
 *      越过 safe integer、以及手滑多按几个 0 时没有被拦住；
 *   5. 本文件**不碰**提示词组装之外的任何东西：不读文件、不做网络、不关心用例。
 */
import { z } from 'zod';
// 只借类型：`composeTotalScore` 的判定入参就是 `score.ts` 的 `RubricJudgment`（`import type` 不产生运行期依赖）
import type { RubricJudgment } from './score';

/**
 * 单项权重上限。10000 对日常配置宽得离谱（300 分 / 1000 分的表离它还很远），
 * 只拦真错的那个量级（多按几个 0）。
 */
export const MAX_ITEM_WEIGHT = 10_000;

/** 单个评分项：短 ID（可空）+ 自足的目标描述 + 权重。**权重只挂在项上，组不带权重**（口径 1） */
export const RubricItemSchema = z.object({
  /** 短 ID（A1 / D5 这种）。允许为空，空 id 的项按位置引用（见口径 3） */
  id: z.string().default(''),
  /** 目标：这一项要达成什么。**自足的判据描述**（既说清改哪里，也说清怎样算达成）。空目标没有意义 */
  goal: z.string().min(1),
  /** 权重：达成即得这么多分。0 分的项没有意义、负权重是错的，故正整数 */
  weight: z.number().int().positive().max(MAX_ITEM_WEIGHT),
});
/** 单个评分项的类型（schema 的输出类型：`id` 已经被 `.default('')` 补齐，故是必填字符串） */
export type RubricItem = z.infer<typeof RubricItemSchema>;

/** 一组评分项：组名 + 项列表。空组在这里合法（口径 2 的中间态），由 `validateRubric` 在提交时拒绝 */
export const RubricGroupSchema = z.object({
  name: z.string().min(1),
  /** `.min(1)` 只在**提交用例**时由 `validateRubric` 要求：表单上刚点「添加分组」的空组是合法的中间态 */
  items: z.array(RubricItemSchema),
});
/** 一组评分项的类型（用例与 run 快照存的就是这个形状） */
export type RubricGroup = z.infer<typeof RubricGroupSchema>;

/** 一整张评分表 = 组的数组。**空表合法**（口径 2：新建用例的初值），非空要求由 `validateRubric` 给 */
export const RubricSchema = z.object({
  /** 空数组 = 表是空的（见口径 2） */
  groups: z.array(RubricGroupSchema),
});
/** 一整张评分表的类型：它是「尺子」的唯一真源，渲染、校验、算分都从它出发 */
export type Rubric = z.infer<typeof RubricSchema>;

/** 满分 = 全部项权重之和。空表返回 0（评分阶段对它有专门的守卫，见 orchestrator） */
export function rubricMaxScore(rubric: Rubric): number {
  let sum = 0;
  for (const group of rubric.groups) {
    for (const item of group.items) sum += item.weight;
  }
  return sum;
}

/**
 * 表里每一项摊平成「(引用键, 项)」对：**引用键生成的唯一实现**，`rubricItemKeys` /
 * `composeTotalScore` / `renderRubricForJudge` 三处都从这里取，`#k` 规则不会写成几份后各自漂移。
 * id **按 `trim()` 后是否为空**判定「写没写」：`'   '` 与 `''` 同档，都按位置分配 `#k`
 * ——否则空白 ID 会变成一把用户与模型都想不到的隐形引用键。
 */
function rubricEntries(rubric: Rubric): { key: string; item: RubricItem }[] {
  const entries: { key: string; item: RubricItem }[] = [];
  let index = 0;
  for (const group of rubric.groups) {
    for (const item of group.items) {
      index += 1;
      const id = item.id.trim();
      entries.push({ key: id === '' ? `#${index}` : id, item });
    }
  }
  return entries;
}

/**
 * 项的**引用键**：有 id 用它（`trim()` 之后），没 id 用 `#k`（k = 全表顺序号，从 1 开始、跨组连续）。
 * 为什么位置引用是确定性的：`#4` 只可能对上全表第 4 项，不需要任何字符串匹配，
 * 也不会因为用户在别处改了一个字而整体错位。
 * **两两不同由 `validateRubric` 断言**：模型的一次判定按引用键记账，两把相同的键会记到两项上。
 */
export function rubricItemKeys(rubric: Rubric): string[] {
  return rubricEntries(rubric).map((entry) => entry.key);
}

/**
 * 校验（**提交用例与落盘的唯一判据**，界面与服务端共用同一份）：至少一组、每组至少一项、
 * 组名非空、目标非空、权重正整数（schema 已保证上限）、**有值的 id 不重复**（空 id 可以重复）、
 * 以及**生成的引用键两两不同**。
 *
 * id 一律 **`trim()` 之后**比较：`'   '` 与 `''` 同档（都算「没写 ID」，按位置引用）。
 * 为什么 id 重复必须拦：`rubricItemKeys` 会出现两个同名键，模型的一次判定会被同时记到两项上——
 * 分数悄悄多出或少掉一块权重，而界面上一切正常。
 * 返回的是**可直接展示的中文原因**（点名是哪一组 / 哪一项），不是笼统的「表格不合法」。
 */
export function validateRubric(rubric: Rubric): { ok: true } | { ok: false; message: string } {
  if (rubric.groups.length === 0) return { ok: false, message: '评分标准项不能为空：至少需要一组' };
  const seenIds = new Set<string>();
  for (const [groupIndex, group] of rubric.groups.entries()) {
    const name = group.name.trim();
    if (name === '') return { ok: false, message: `第 ${groupIndex + 1} 组的组名不能为空` };
    const groupLabel = `「${name}」`;
    if (group.items.length === 0) return { ok: false, message: `${groupLabel}里至少要有一个评分项` };
    for (const [itemIndex, item] of group.items.entries()) {
      const itemLabel = `${groupLabel}的第 ${itemIndex + 1} 项`;
      if (item.goal.trim() === '') return { ok: false, message: `${itemLabel}的目标不能为空` };
      if (!Number.isInteger(item.weight) || item.weight <= 0) {
        return { ok: false, message: `${itemLabel}的权重必须是正整数` };
      }
      const id = item.id.trim();
      if (id !== '') {
        if (seenIds.has(id)) return { ok: false, message: `评分项 ID「${id}」重复了：每个 ID 只能用一次` };
        seenIds.add(id);
      }
    }
  }
  // 逐项 ID 不重复还不够：**引用键**（有 ID 用 ID、没写 ID 用位置 `#k`）也必须两两不同——
  // 两把相同的键会让模型的一次判定被同时算进两项的权重（分数悄悄多出一块，界面上却一切正常）。
  // 断言的是**生成结果**而不是「ID 不许长得像 #1」：前者正是解析侧与 `composeTotalScore` 依赖的不变式，
  // 键的生成规则以后怎么改，这条断言都仍然成立。
  const seenKeys = new Set<string>();
  for (const [index, key] of rubricItemKeys(rubric).entries()) {
    if (seenKeys.has(key)) {
      return {
        ok: false,
        message: `评分项引用键「${key}」重复了：第 ${index + 1} 项与前面某一项算出了同一把键（有 ID 用 ID，没写 ID 的项按全表位置分配 \`#k\`）——一次判定会被同时记到两项上，请给第 ${index + 1} 项换一个 ID`,
      };
    }
    seenKeys.add(key);
  }
  return { ok: true };
}

/**
 * 总分 = **达成项权重之和**（一趟遍历、一趟加法：引用键与项来自 `rubricEntries` 的同一次生成）。
 * 判定里认不出的引用键不参与（解析侧已保证「每一项都有判定、缺一项即失败」，故这里只做加法）；
 * 引用键撞车的表由 `validateRubric` 在写侧拦下，本函数不重复设防。
 */
export function composeTotalScore(rubric: Rubric, judgments: readonly RubricJudgment[]): number {
  const achieved = new Set(judgments.filter((judgment) => judgment.achieved).map((judgment) => judgment.id));
  let sum = 0;
  for (const entry of rubricEntries(rubric)) {
    if (achieved.has(entry.key)) sum += entry.item.weight;
  }
  return sum;
}

/**
 * 把评分表渲染成 Markdown 二级表格（送进评分模型的那一份，**两条评分通路共用**）。
 * 三条口径：
 *   1. 第一列是**引用键**（有 id 用 id，没 id 用 `#k`）——模型据此指认「我评的是哪一项」；
 *   2. **组名、引用键与目标走同一份转义**：它们里带一个竖线或换行就会让整行列错位，
 *      而错位之后模型读到的是一张与界面不同的表。引用键与目标、组名**同为自由文本**：
 *      键来自用户填的 `item.id`，`RubricSchema` 与 `validateRubric` 只 `trim()` 与查重、
 *      不限定字符（`|` / 换行都合法），所以它也必须过 `escapeCell`——整支复审 Finding 1 实测：
 *      键漏转义时 `A|B` 排出来的行有 5 个真分隔符，模型会按错位后的列去认权重；
 *   3. 表尾给汇总（共几项、满分多少），让模型知道权重之和是满分。
 */
export function renderRubricForJudge(rubric: Rubric): string {
  const lines: string[] = [];
  // 逐组的行数就是组的项数 ⇒ 按组切片取「(引用键, 项)」对，不需要按索引取值再兜 undefined
  const entries = rubricEntries(rubric);
  let cursor = 0;
  for (const group of rubric.groups) {
    lines.push(escapeCell(group.name), '| 引用键 | 目标 | 权重 |', '| --- | --- | --- |');
    for (const { key, item } of entries.slice(cursor, cursor + group.items.length)) {
      lines.push(`| ${escapeCell(key)} | ${escapeCell(item.goal)} | ${item.weight} |`);
    }
    cursor += group.items.length;
    lines.push('');
  }
  lines.push(`以上共 ${entries.length} 项，满分 ${rubricMaxScore(rubric)} 分。`);
  return lines.join('\n');
}

/**
 * 单元格转义：**先转义反斜杠、再转义竖线**（顺序不能反——反过来会把 `\|` 里那个反斜杠也转掉，
 * 于是竖线重新变成真分隔符，列照旧错位），换行与回车压成空格（否则整行列错位）。
 */
function escapeCell(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ').trim();
}
