/**
 * 技能扫描：把技能根下的**一层**目录读成列表。
 *
 * 识别单位与四条口径：
 *   1. **一条 skill = `<根>/<名称>/SKILL.md`**，只扫第一层、不递归（与 dsh 的第一层扫描同口径）。
 *      不递归不是偷懒：目录树里任何一层都可能是另一条 skill 的附属文件，递归会把 `references/`
 *      当成技能列出来。**候选单位是目录**（软链也算：跟随后看它指向什么——技能目录常常整条是软链）；
 *      第一层的**普通文件一概不列**：`.DS_Store`、`README.md`、扁平的 `<名称>.md` 都不是技能，
 *      给它们各占一行「缺 SKILL.md」只会让人以为「我放的技能坏了」，而噪声其实是文件本身；
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
import { readdirSync, readFileSync, realpathSync, statSync, type Dirent } from 'node:fs';
import { join } from 'node:path';
import {
  ServiceError,
  SKILL_FILE_NAME,
  SKILL_PREVIEW_MAX_BYTES,
  SKILL_TREE_MAX_DEPTH,
  SKILL_TREE_MAX_NODES,
  SkillFilePathSchema,
  SkillNameSchema,
  isValidSkillDescription,
  isValidSkillName,
  splitSkillMarkdown,
  type SkillEntry,
  type SkillFileText,
  type SkillsSettings,
  type SkillTree,
  type SkillTreeNode,
  type SkillWarning,
} from '@aieval/contracts';
import { getConfigDir } from './config-store';
import { createLogger } from './logger';
import { isInside } from './path-inside';

const log = createLogger('skill-store');

/**
 * 「缺 SKILL.md」的中文原因（一处定义、两处用：没有这个文件，与这个路径压根不是目录）。
 * 两个不合格类型（目录里没入口文件 / 断链的软链接）在这一格上对用户是同一件事；
 * **普通文件不走这一格**——它们不是候选，压根不入列（见文件头第 1 条）。
 */
const MISSING_FILE_REASON = `缺 ${SKILL_FILE_NAME}（技能是一个目录，里面放 ${SKILL_FILE_NAME}；只扫这一层，不递归）`;

/**
 * **不是技能内容、哪一层都不列**的常见噪声条目：OS 元数据、版本库 / 编辑器目录、依赖与缓存。
 *
 * 为什么按名字钉死、而不是「点开头一律不列」：技能里完全可能有 `.env` / `.eslintrc` 这类真内容，
 * 一网打尽会让用户以为「我放的文件不见了」。藏与不藏的边界因此是**这张表**，不是一条通配——
 * 表外的点文件照列（`.hidden` 这类名字仍然看得见）。
 *
 * 目录命中时**连子树一起跳过**，不只是不显示：`node_modules` / `.git` 真进去会白吃掉节点预算
 * （`SKILL_TREE_MAX_NODES`），把整棵树挤成「没列全」。文件与目录同名判据一致（`.git` 在 worktree
 * 里本来就是一个文件）。
 *
 * 顶层扫描（`scanSkills`）用的是同一张表：技能根下偶然出现的 `node_modules` 不该占一行「缺 SKILL.md」，
 * 那看起来像「我放的技能坏了」。
 */
const HIDDEN_ENTRY_NAMES: ReadonlySet<string> = new Set([
  // macOS Finder / Windows 资源管理器自己写的元数据
  '.DS_Store',
  'Thumbs.db',
  'desktop.ini',
  // 版本库与编辑器
  '.git',
  '.hg',
  '.svn',
  '.idea',
  '.vscode',
  // 依赖与语言缓存
  'node_modules',
  '.venv',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
]);

/**
 * `disable-model-invocation: true` 的中文原因（**不收**这一条，与上面那条同档）。
 *
 * 为什么它不是一条普通 frontmatter 键：它的语义是「装载进厂商的技能表、但不写进系统提示词」
 * ——于是候选级观测格会报「已装上」（厂商清单里确实有它），而模型**根本看不到它**：
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

/**
 * 厂商**硬拒收**的三个旧写法键（`dsh-skill-filesystem` 的 `rejectLegacyInvocationKey`：命中即
 * `throw new Error('frontmatter field "<旧名>" is unsupported; use "<正名>"')`，那一份技能文件随后被
 * **静默丢弃**——厂商自己的 `skill file … ignored` 没有任何出口）。
 *
 * 为什么本仓也要拦：判据比厂商宽的下场是假绿——界面上这条技能「合格」、文件也物化到了
 * `<DSH_HOME>/skills/`，而厂商一条都不认领（`vendor-system.skills` 采不到 ⇒ 观测格读成
 * 「未能核验」）。拦在这里，用户看到的是「不合格 + 该用哪个键」，与厂商自己的报错同源。
 *
 * 正名与厂商逐字相同（旧名 → 正名）：`disableModelInvocation` / `modelInvocable` →
 * `disable-model-invocation`；`userInvocable` → `user-invocable`。
 */
const LEGACY_INVOCATION_KEYS: ReadonlyArray<readonly [string, string]> = [
  ['disableModelInvocation', 'disable-model-invocation'],
  ['modelInvocable', 'disable-model-invocation'],
  ['userInvocable', 'user-invocable'],
];

/** 命中旧写法键就给出中文原因（含正名）；都没有给 `null` */
function legacyInvocationReason(fields: Record<string, string>): string | null {
  for (const [legacy, canonical] of LEGACY_INVOCATION_KEYS) {
    if (Object.hasOwn(fields, legacy)) {
      return `${legacy} 不受支持（厂商会直接丢弃这份技能）：请改用 ${canonical}`;
    }
  }
  return null;
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
 * 源侧是 `getSkillsRoot()`（技能根 = 配置目录 + 它），行侧是「装入这个候选的落点」
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

  if (!isDirectory(path, directory)) {
    return {
      name,
      dir: path,
      description: '',
      ok: false,
      reason: MISSING_FILE_REASON,
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
    };
  }

  const { fields } = splitSkillMarkdown(raw);
  const declared = fields['name'] ?? '';
  const description = fields['description'] ?? '';
  const base = { name, dir: path, description };

  if (declared === '') {
    return { ...base, ok: false, reason: '名称不合法：frontmatter 里没有 name' };
  }
  if (!isValidSkillName(declared)) {
    return {
      ...base,
      ok: false,
      reason: `名称不合法：${declared}（只允许小写字母、数字与单个连字符，最长 64）`,
    };
  }
  if (declared !== name) {
    return {
      ...base,
      ok: false,
      reason: `目录名 ${name} 与 frontmatter 的 name ${declared} 不一致`,
    };
  }
  if (!isValidSkillDescription(description)) {
    const reasonText =
      description.trim() === ''
        ? '缺 description（frontmatter 里必填，且不能只有空白）'
        : `description 超长（${description.length} 字符，上限 1024）`;
    return { ...base, ok: false, reason: reasonText };
  }
  if (hidesFromModel(fields)) {
    return { ...base, ok: false, reason: DISABLE_MODEL_INVOCATION_REASON };
  }
  const legacy = legacyInvocationReason(fields);
  if (legacy !== null) {
    return { ...base, ok: false, reason: legacy };
  }
  return { ...base, ok: true };
}

/**
 * 扫技能根：缺目录 ⇒ 空列表 + 一条根级 warning；读失败 ⇒ 抛 INTERNAL。
 *
 * 第一层只留**目录与软链**（软链跟随后按它的目标判定，技能目录常常整条是软链）；
 * 普通文件（`README.md` / 扁平的 `.md`）与其余特殊类型不是技能，忽略并留一条 DEBUG；
 * `HIDDEN_ENTRY_NAMES` 里的噪声名字（`.DS_Store` / `.git` / `node_modules` …）**连候选都不进**。
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

  // `isSymbolicLink()` 是给软链留的门：`isDirectory()` 对软链恒为 false，用它过滤会把整条软链形态的技能滤掉
  const candidates: Dirent[] = [];
  const ignored: string[] = [];
  for (const dirent of dirents) {
    // 噪声条目先按名字挡掉：`node_modules` 这种目录进了候选就会变成一行「缺 SKILL.md」
    if (HIDDEN_ENTRY_NAMES.has(dirent.name)) {
      ignored.push(dirent.name);
      continue;
    }
    if (dirent.isDirectory() || dirent.isSymbolicLink()) candidates.push(dirent);
    else ignored.push(dirent.name);
  }
  if (ignored.length > 0) {
    log.debug('技能根下的条目不是技能，已忽略', { root, ignored });
  }

  const skills = candidates
    .map((dirent) => scanEntry(root, dirent.name, dirent.isDirectory()))
    .sort((left, right) => compareSkillNames(left.name, right.name));
  return { skills, skillWarnings: [] };
}

/**
 * 走过一棵树时的共享状态：节点计数、「这棵树没列全」标记，以及被 `HIDDEN_ENTRY_NAMES` 挡下的名字。
 * `hidden` 只进 DEBUG 日志（按名字挡下的噪声不是「没列全」，不置 `truncated`）。
 */
interface TreeWalkState {
  count: number;
  truncated: boolean;
  hidden: string[];
}

/** 单个文件的字节数；读不出（权限 / 坏链）返回 `null`——`null ≠ 0` 同纪律，不拿 0 顶替 */function fileSize(path: string): number | null {
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
}

/** 人类可读的字节数，只在错误文案里用（core 不引界面的格式化工具，那是另一个包的事） */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  return kb < 1024 ? `${kb.toFixed(1)} KB` : `${(kb / 1024).toFixed(1)} MB`;
}

/**
 * 列一层目录，产出按「目录在前、同类按名字码位升序」排好的节点。
 *
 * `realRoot` 是**已解析**的技能目录真实路径，专门用来复核符号链接不越界（见 `readSkillTree`）。
 * 三条不静默的处置：这一层读不出来、深度到上限、节点数到上限——任一发生都把 `truncated` 置真，
 * 让界面说出「没列全」，而不是让人把「树里没有」当成「磁盘上没有」。
 *
 * 与上面三条不同，`HIDDEN_ENTRY_NAMES` 里的名字是**有意不列**（见那张表的说明）：它不置
 * `truncated`、只在 DEBUG 里留一笔，因为那不是「我们没列全」，而是「这一类东西不是技能内容」。
 */
function walkDirectory(
  realRoot: string,
  currentDir: string,
  depth: number,
  state: TreeWalkState,
): SkillTreeNode[] {
  if (depth > SKILL_TREE_MAX_DEPTH) {
    state.truncated = true;
    return [];
  }

  let dirents: Dirent[];
  try {
    dirents = readdirSync(currentDir, { withFileTypes: true });
  } catch (error) {
    // 不抛：树的其他分支还有内容。但也不能装作这一层是空目录，所以只置 truncated
    state.truncated = true;
    log.warn('技能目录里有一层读不出来', { dir: currentDir, reason: reason(error) });
    return [];
  }

  const nodes: SkillTreeNode[] = [];
  for (const dirent of dirents) {
    if (state.count >= SKILL_TREE_MAX_NODES) {
      state.truncated = true;
      break;
    }
    // 噪声条目在这里就跳过：不计数、不递归（`node_modules` 进来会白吃节点预算）
    if (HIDDEN_ENTRY_NAMES.has(dirent.name)) {
      state.hidden.push(dirent.name);
      continue;
    }
    const fullPath = join(currentDir, dirent.name);
    let isDirectory = dirent.isDirectory();
    let isFile = dirent.isFile();

    if (dirent.isSymbolicLink()) {
      let realEntry: string;
      try {
        realEntry = realpathSync(fullPath);
      } catch {
        // 断链：它是磁盘上的一个名字，但我们跟不到任何东西 ⇒ 照列、不给大小（`null`）
        state.count += 1;
        nodes.push({ title: dirent.name, path: dirent.name, isDirectory: false, children: [], sizeBytes: null });
        continue;
      }
      if (!isInside(realRoot, realEntry)) {
        // 指向技能目录之外：不跟。跟了就是把别处的内容当成本技能的一部分
        state.truncated = true;
        continue;
      }
      const resolved = statSync(realEntry, { throwIfNoEntry: false });
      isDirectory = resolved?.isDirectory() ?? false;
      isFile = resolved?.isFile() ?? false;
      if (!isDirectory && !isFile) continue;
    }

    state.count += 1;
    nodes.push({
      title: dirent.name,
      path: dirent.name,
      isDirectory,
      children: isDirectory ? walkDirectory(realRoot, fullPath, depth + 1, state) : [],
      sizeBytes: isFile ? fileSize(fullPath) : null,
    });
  }

  // 目录在前、同类按名字码位升序（`<` / `>` 而不是 `localeCompare`：顺序不随 locale / ICU 变）
  return nodes.sort((left, right) => {
    if (left.isDirectory !== right.isDirectory) return left.isDirectory ? -1 : 1;
    return left.title < right.title ? -1 : left.title > right.title ? 1 : 0;
  });
}

/**
 * 列一条技能的**目录树**（左树那一栏）：`<技能根>/<名称>` 之下递归全列，
 * `HIDDEN_ENTRY_NAMES` 里的噪声条目除外。
 *
 * 与列表那条「只扫第一层、不递归」不是一回事，别互相套用：列表回答的是「哪几条技能」，
 * 树回答的是「这一条技能里有什么」——`references/` 在列表里是附属文件、在树里正是要展开的东西。
 *
 * 名字先过 `assertSkillName`（路径穿越的第一道门，与读文件同一道）；目录不在 ⇒ `NOT_FOUND`。
 */
export function readSkillTree(name: string): SkillTree {
  const dir = join(getSkillsRoot(), assertSkillName(name));
  let realDir: string;
  try {
    realDir = realpathSync(dir);
  } catch (error) {
    if (isMissingPath(error)) {
      throw new ServiceError('NOT_FOUND', `这条技能不在磁盘上：${dir}`, { context: { dir, name } });
    }
    throw new ServiceError('INTERNAL', `读不出技能目录：${dir}（${reason(error)}）`, {
      cause: error,
      context: { dir, name },
    });
  }

  const state: TreeWalkState = { count: 0, truncated: false, hidden: [] };
  const children = walkDirectory(realDir, realDir, 1, state);
  if (state.hidden.length > 0) {
    log.debug('技能目录里的噪声条目未列出', { name, dir, hidden: [...new Set(state.hidden)] });
  }
  return {
    name,
    dir,
    root: { title: name, path: name, isDirectory: true, children, sizeBytes: null },
    truncated: state.truncated,
  };
}

/**
 * `readFileSync(..., 'utf8')` 之后出现替换字符 `\uFFFD` ⇒ 这不是 UTF-8 文本。
 * Node 的解码器把非法字节序列换成它，所以它的出现**就是**「二进制」的痕迹。
 * 已知边界：一份合法文本里本来也可能有人写了 U+FFFD，那一档会被误判成二进制——
 * 代价是一句「不预览」，比把乱码铺满界面好。
 */
function looksBinary(text: string): boolean {
  return text.includes('\uFFFD');
}

/**
 * 读技能里任意一个文件（预览那一栏）：技能内相对路径 + **原文**。
 *
 * 四道处置，逐一对应一种「读不出来」：
 *   · 路径本身不合法（绝对 / `..` / 空段 / 太深）⇒ `INVALID_QUERY`，在契约层就挡下；
 *   · 拼出来的真实路径越出技能目录（软链指到外面）⇒ `INVALID_QUERY`（`realpath` 复核，第二道门）；
 *   · 文件不在 ⇒ `NOT_FOUND`；是目录或不是普通文件 ⇒ `INVALID_QUERY`；
 *   · 二进制、或超过预览上限 ⇒ `INVALID_QUERY` + 中文原因，**不给半个正文**：
 *     乱码铺满界面比一句「这一类不预览」坏得多。
 */
export function readSkillFileText(name: string, path: string): SkillFileText {
  const parsed = SkillFilePathSchema.safeParse(path);
  if (!parsed.success) {
    throw new ServiceError('INVALID_QUERY', `技能内路径不合法：${path}`, { context: { name, path } });
  }
  const relative = parsed.data;
  const dir = join(getSkillsRoot(), assertSkillName(name));
  const target = join(dir, relative);

  let realDir: string;
  let realTarget: string;
  try {
    realDir = realpathSync(dir);
    realTarget = realpathSync(target);
  } catch (error) {
    if (isMissingPath(error)) {
      throw new ServiceError('NOT_FOUND', `这条技能里没有这个文件：${target}`, { context: { name, path: relative } });
    }
    throw new ServiceError('INTERNAL', `读不出这个文件：${target}（${reason(error)}）`, {
      cause: error,
      context: { name, path: relative },
    });
  }

  if (!isInside(realDir, realTarget)) {
    throw new ServiceError('INVALID_QUERY', `技能内路径越出了技能目录：${relative}`, {
      context: { name, path: relative, dir: realDir },
    });
  }

  const status = statSync(realTarget, { throwIfNoEntry: false });
  if (status === undefined) {
    throw new ServiceError('NOT_FOUND', `这条技能里没有这个文件：${target}`, { context: { name, path: relative } });
  }
  if (status.isDirectory()) {
    throw new ServiceError('INVALID_QUERY', `这是一个目录，不是文件：${relative}`, {
      context: { name, path: relative },
    });
  }
  if (!status.isFile()) {
    throw new ServiceError('INVALID_QUERY', `这不是一个普通文件：${relative}`, {
      context: { name, path: relative },
    });
  }
  if (status.size > SKILL_PREVIEW_MAX_BYTES) {
    throw new ServiceError(
      'INVALID_QUERY',
      `这个文件 ${formatSize(status.size)}，超过预览上限 ${formatSize(SKILL_PREVIEW_MAX_BYTES)}：${relative}`,
      { context: { name, path: relative, bytes: status.size } },
    );
  }

  let text: string;
  try {
    text = readFileSync(realTarget, 'utf8');
  } catch (error) {
    throw new ServiceError('INTERNAL', `读不出这个文件：${target}（${reason(error)}）`, {
      cause: error,
      context: { name, path: relative },
    });
  }
  if (looksBinary(text)) {
    throw new ServiceError(
      'INVALID_QUERY',
      `这一类文件不预览（二进制 / 非 UTF-8，${formatSize(status.size)}）：${relative}`,
      { context: { name, path: relative, bytes: status.size } },
    );
  }
  return { path: relative, text };
}
