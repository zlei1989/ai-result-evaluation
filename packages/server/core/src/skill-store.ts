/**
 * 技能扫描：把技能根下的**一层**目录读成列表。
 *
 * 识别单位与四条口径：
 *   1. **一条 skill = `<根>/<名称>/SKILL.md`**，只扫第一层、不递归（与 dsh 的第一层扫描同口径）。
 *      不递归不是偷懒：目录树里任何一层都可能是另一条 skill 的附属文件，递归会把 `references/`
 *      当成技能列出来；
 *   2. **准入判据全部来自契约**（`isValidSkillName` / `isValidSkillDescription`，最严的那一条）：
 *      名字必须是目录名与 frontmatter 逐字相同、description 必填非空 ≤1024。「三家都装得上」是
 *      能被启用的前提——不合法时 claude 在启动前抛错、dsh 把整条静默丢弃；
 *      **外加一条**：`disable-model-invocation` 不收，理由见 `DISABLE_MODEL_INVOCATION_REASON`；
 *   3. **不合格的条目照旧入列**（`ok:false` + 中文原因）：它要被显示成一行，用户才知道自己放的东西
 *      哪里不合格。丢进根级 warning 的话界面没有行可挂，用户看到的是「我放的 skill 不见了」；
 *   4. **缺目录 = 空列表 + 一条根级 warning（不是错误），读失败 = 抛含路径的中文 INTERNAL**。
 *      两者必须分开：前者是「还没放东西」（首次使用就是这个状态），后者是权限 / 类型故障，
 *      把它说成「你还没放 skill」是最坏的一种假结论。
 *
 * 只读：本模块不建目录、不写文件、不删任何东西。技能根跟着配置目录走
 * （`getConfigDir()` + `/skills`），故 `setConfigDirForTesting` 一并把它搬进临时目录。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  ServiceError,
  SKILL_FILE_NAME,
  SkillNameSchema,
  isValidSkillDescription,
  isValidSkillName,
  splitSkillMarkdown,
  type SkillEntry,
  type SkillFile,
  type SkillsSettings,
  type SkillWarning,
} from '@aieval/contracts';
import { getConfigDir } from './config-store';
import { createLogger } from './logger';

const log = createLogger('skill-store');

/**
 * 「缺 SKILL.md」的中文原因（一处定义、两处用：没有这个文件，与这个路径压根不是目录）。
 * 三个不合格类型（目录里没入口文件 / 裸 `.md` / 断链的软链接）在这一格上对用户是同一件事。
 */
const MISSING_FILE_REASON = `缺 ${SKILL_FILE_NAME}（技能是一个目录，里面放 ${SKILL_FILE_NAME}；只扫这一层，不递归）`;

/**
 * `disable-model-invocation: true` 的中文原因（**不收**这一条，与上面那条同档）。
 *
 * 为什么它不是一条普通 frontmatter 键：它的语义是「装载进厂商的技能表、但不写进系统提示词」
 * ——于是行级观测格会报「已装上」（厂商清单里确实有它），而模型**根本看不到它**：
 * 一个格子里同时说着「装上了」与「用不上」两句互相拆台的话，且两句都像真的。
 * 本仓的停用语义是**文件级不放**（`installableSkills` 剔掉），不是「藏起来但还能显式调」，
 * 两者混在一处就无法从观测格上区分「用户停用了」与「用户写了这个键」。
 *
 * 值按 YAML 布尔的常见写法认（`true` / `True` / `"true"`——`splitSkillMarkdown` 已经剥掉成对引号），
 * 其余值（`false` / 空）放行：那不是「藏起来」，写了它等于没写。
 */
const DISABLE_MODEL_INVOCATION_REASON =
  'disable-model-invocation 不受支持：本仓的「停用」是不装入这一条，而不是装载后把它从提示词里藏起来';

/** 这一格是不是把技能藏起来（见 `DISABLE_MODEL_INVOCATION_REASON`） */
function hidesFromModel(fields: Record<string, string>): boolean {
  return (fields['disable-model-invocation'] ?? '').trim().toLowerCase() === 'true';
}


/** 扫到的一条：与 `SkillEntry` 同形，但**没有 `disabled`** —— 那一格由 api 拿停用名单合并出来 */
export type ScannedSkill = Omit<SkillEntry, 'disabled'>;

/** 一次扫描的结果：条目 + 根级异常（与 `SkillList` 同形，只差 `disabled`） */
export interface SkillScan {
  skills: ScannedSkill[];
  skillWarnings: SkillWarning[];
}

/**
 * 某一层配置目录下的技能目录（`<配置目录>/skills`）：**源侧与行侧同一个名字**。
 * 源侧是 `getSkillsRoot()`（技能根 = 配置目录 + 它），行侧是「装入这一行的落点」
 * （`materializeSkills` 收到 `configHome` 后 + 它）——两处各写一个字符串字面量迟早漂成两个落点。
 */
export function skillsDirOf(configDir: string): string {
  return join(configDir, 'skills');
}

/**
 * 技能根：`<配置目录>/skills`。
 * **不设 `settings.skillsRoot` 键**：改根就是改配置目录，一个杠杆；副作用是测试的
 * `setConfigDirForTesting()` 自动把技能根一起搬走，不需要第二个 override（对比 `casesRoot`）。
 */
export function getSkillsRoot(): string {
  return skillsDirOf(getConfigDir());
}

/**
 * 停用名单的读法（**唯一**一处：「缺省 = 开启」这条规则不许在接口层、编排层、界面各写一遍）。
 *
 * 判据是 `entries[name]?.disabled === true` 而不是「键在不在」：`loadConfig` 故意不做 schema 校验，
 * 手改坏的 `config.json` 里那个键可能挂着别的值——把「键在」当成「关着」会让一条手改坏的记录
 * **静默关掉**用户的技能，而这个结论在界面上看不出任何异常。
 */
export function isSkillDisabled(entries: SkillsSettings['entries'] | undefined, name: string): boolean {
  return entries?.[name]?.disabled === true;
}

/**
 * 名字按**码位**升序比较（`<` / `>` 而不是 `localeCompare`）。
 * 名字域是 `[a-z0-9-]`，码位序确定、不随 locale / ICU 变；`localeCompare` 是本地化排序，
 * 在混入大写或连字符的名字上给出的顺序与码位序**不同**，而界面**不再排**——顺序就是这里的输出。
 */
export function compareSkillNames(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/**
 * 技能名的形状校验（读单个技能时用）：不合法一律 `INVALID_QUERY`。
 * 这一道门同时是**路径穿越**的边界：名字要拼进文件路径，带 `/` 或 `..` 的名字必须在这里被挡下。
 */
export function assertSkillName(name: string): string {
  const parsed = SkillNameSchema.safeParse(name);
  if (!parsed.success) {
    throw new ServiceError('INVALID_QUERY', `技能名不合法（只允许小写字母、数字与单个连字符，最长 64）：${name}`, {
      context: { name },
    });
  }
  return parsed.data;
}

/** 是不是「路径不存在」这类 errno（目录 / 文件不存在都不是错误，只是「还没有」） */
function isMissingPath(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'ENOENT';
}

/** 取错误的人类可读原因（error 不一定是 Error） */
function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 一条 skill 的字节数：**整目录**（装入是整目录复制，只报入口文件会低报）。
 * 两条边界都是刻意的：
 *   · **不跟随符号链接**（既避免环，也不把技能目录外的文件算进来）；
 *   · **算不出就返回 undefined**（`null ≠ 0` 同纪律）——半个和是个错数字，比缺席更坏。
 * 它就是「不设体积上限」那条决定的缓解手段：上限会造出「装了一半」的第三种状态，界面改为显示体积。
 */
function skillSize(dir: string): number | undefined {
  let total = 0;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    try {
      if (entry.isDirectory()) {
        const nested = skillSize(path);
        if (nested === undefined) return undefined;
        total += nested;
        continue;
      }
      // 符号链接与其它特殊文件不参与统计（跟随它会读到技能目录之外，也成不了环）
      if (!entry.isFile()) continue;
      total += statSync(path).size;
    } catch {
      return undefined;
    }
  }
  return total;
}

/** 一个路径是不是目录（**跟随符号链接**：技能目录常常是软链，不跟随会把它误判成「缺 SKILL.md」） */
function isDirectory(path: string, fromDirent: boolean): boolean {
  if (fromDirent) return true;
  try {
    return statSync(path).isDirectory();
  } catch {
    // 断链的软链接与读不到权限的条目都落到这里：按「不是目录」处置，它会以「缺 SKILL.md」入列
    return false;
  }
}

/**
 * 扫一条：产出**恒有一行**的结果（合格 ⇒ `ok:true`，不合格 ⇒ `ok:false` + 中文原因）。
 *
 * 判定顺序固定为「有没有 SKILL.md → 名字 → 目录名一致性 → description」：
 * 前面一条不过就没有必要读后面的信息（名字不合法时，名字与目录名一致与否都不改变结论）。
 */
function scanEntry(root: string, name: string, directory: boolean): ScannedSkill {
  const path = join(root, name);
  const size = directory ? skillSize(path) : statSync(path, { throwIfNoEntry: false })?.size;
  const withSize = size === undefined ? {} : { sizeBytes: size };

  if (!isDirectory(path, directory)) {
    return {
      name,
      dir: path,
      description: '',
      ok: false,
      reason: MISSING_FILE_REASON,
      ...withSize,
    };
  }

  const file = join(path, SKILL_FILE_NAME);
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (error) {
    const missing = isMissingPath(error);
    return {
      name,
      dir: path,
      description: '',
      ok: false,
      reason: missing ? MISSING_FILE_REASON : `读不出 ${SKILL_FILE_NAME}：${file}（${reason(error)}）`,
      ...withSize,
    };
  }

  const { fields } = splitSkillMarkdown(raw);
  const declared = fields['name'] ?? '';
  const description = fields['description'] ?? '';
  const base = { name, dir: path, description };

  if (declared === '') {
    return { ...base, ok: false, reason: '名称不合法：frontmatter 里没有 name', ...withSize };
  }
  if (!isValidSkillName(declared)) {
    return {
      ...base,
      ok: false,
      reason: `名称不合法：${declared}（只允许小写字母、数字与单个连字符，最长 64）`,
      ...withSize,
    };
  }
  if (declared !== name) {
    return {
      ...base,
      ok: false,
      reason: `目录名 ${name} 与 frontmatter 的 name ${declared} 不一致`,
      ...withSize,
    };
  }
  if (!isValidSkillDescription(description)) {
    const reasonText =
      description.trim() === ''
        ? '缺 description（frontmatter 里必填，且不能只有空白）'
        : `description 超长（${description.length} 字符，上限 1024）`;
    return { ...base, ok: false, reason: reasonText, ...withSize };
  }
  if (hidesFromModel(fields)) {
    return { ...base, ok: false, reason: DISABLE_MODEL_INVOCATION_REASON, ...withSize };
  }
  return { ...base, ok: true, ...withSize };
}

/**
 * 扫技能根：缺目录 ⇒ 空列表 + 一条根级 warning；读失败 ⇒ 抛 INTERNAL。
 * 输出按 `name` 码位升序（见 `compareSkillNames`）；**不建目录、不删文件**。
 */
export function scanSkills(): SkillScan {
  const root = getSkillsRoot();
  let dirents;
  try {
    dirents = readdirSync(root, { withFileTypes: true });
  } catch (error) {
    if (isMissingPath(error)) {
      // 还没放过 skill（首次使用就是这一态）：不是错误，界面给的是「目录还不存在」而不是一片红
      log.warn('技能目录还不存在', { root });
      return { skills: [], skillWarnings: [{ path: root, reason: '技能目录还不存在' }] };
    }
    throw new ServiceError('INTERNAL', `读取技能目录失败：${root}（${reason(error)}）`, {
      cause: error,
      context: { root },
    });
  }

  const skills = dirents
    .map((dirent) => scanEntry(root, dirent.name, dirent.isDirectory()))
    .sort((left, right) => compareSkillNames(left.name, right.name));
  return { skills, skillWarnings: [] };
}

/**
 * 读一条 skill 的正文（界面抽屉用）：`frontmatter` 逐字、`body` 原文。
 * 名字先过 `assertSkillName`（路径穿越的唯一一道门）；文件不在 ⇒ `NOT_FOUND`（不是 INTERNAL：
 * 「这条技能没有 SKILL.md」是一个可解释的状态，与「读盘坏了」不同）。
 */
export function readSkillFile(name: string): SkillFile {
  const file = join(getSkillsRoot(), assertSkillName(name), SKILL_FILE_NAME);
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (error) {
    if (isMissingPath(error)) {
      throw new ServiceError('NOT_FOUND', `这条技能里没有 ${SKILL_FILE_NAME}：${file}`, { context: { file, name } });
    }
    throw new ServiceError('INTERNAL', `读不出 ${SKILL_FILE_NAME}：${file}（${reason(error)}）`, {
      cause: error,
      context: { file, name },
    });
  }
  const { frontmatter, body } = splitSkillMarkdown(raw);
  return { frontmatter, body };
}
