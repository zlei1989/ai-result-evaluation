/**
 * 技能**物化**：把一份清单里的每条 skill 整目录复制进某一**行**自己的配置目录
 * （`<configHome>/skills/<名称>/SKILL.md`），使该候选的智能体起来时能发现它。
 *
 * 四条约定的口径（每一条都对应一种「静默失效」，故都写在这里、别处不许各写一份）：
 *   1. **整目录复制**（含 `scripts/`、`references/` 等附属文件）、**不设体积上限**：
 *      上限会造出「装了一半」的第三种状态，而只抄入口文件时正文里的相对路径全指向不存在；
 *   2. **清单内逐条覆盖、清单外一个名字都不碰**——`skills/` 这一层还住着**厂商内置**的
 *      `.system/`（codex 的 6 个内置 skill），整目录清空会把它们静默抹掉。本模块**不删任何东西**：
 *      覆盖靠 `cpSync` 的同名覆盖，于是「清单外不碰」是结构性的，不依赖调用方记得传全；
 *   3. **源目录读不到 / 落不下去 ⇒ 抛 `SkillMaterializeError`**（点名哪一条）：那一候选的评测环境是残缺的，
 *      照跑只会产出一个「看起来正常」的分数——那是本仓最忌讳的假绿。单条不采用「跳过 + WARN」；
 *   4. **软链不用**：候选内那份必须自足，链回源目录会把「源目录那时还在不在」变成判据的一部分。
 *      技能这一层不做软链；源目录**内部**原有的软链按原样复制（跟随会把技能目录之外的文件吸进行的内副本）。
 *
 * `configHome` 由**本模块自己** `mkdirSync(recursive)`：契约只说「该候选独立配置目录」，
 * **没说它一定存在**（既有写盘先例 `writeCandidateNpmrc` 在宿主没配 registry 时连目录都不建）。
 *
 * 名字的准入门与扫描器共用同一条（`isValidSkillName`，最严规则）：它同时是**路径穿越**的边界——
 * `..`、分隔符、绝对路径三种形状都过不了那条规则，落点再按 `<configHome>/skills` 之下一路回验。
 */
import { cpSync, mkdirSync, statSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import {
  SKILL_FILE_NAME,
  SKILL_NAME_MAX_LENGTH,
  isValidSkillName,
  type SkillsSettings,
} from '@aieval/contracts';
import { createLogger } from './logger';
import { isSkillDisabled, scanSkills, skillsDirOf } from './skill-store';

const log = createLogger('skill-materialize');

/**
 * 要装入的一条：名字 + **源目录绝对路径**。
 * 与 `agents` 包 `SkillRef`（`run` 入参里那一格）是**同一个形状**：物化本体在 core，
 * 而 core 不能反向 import agents，故两边各写一次形状声明——字段逐字相同，
 * 与 `agents/src/types.ts` 里 `ProtocolType` 的「此处重复声明」是同一条处置。
 */
export interface SkillSource {
  /** 技能名（= 目录名 = 落点的目录名；扫描器已保证它与 frontmatter 的 `name` 逐字一致） */
  name: string;
  /** 源目录（绝对路径）：`<技能根>/<名称>` */
  sourceDir: string;
}

/**
 * 物化失败：**点名哪一条** + 中文原因。
 *
 * 它**不是**契约层的 `ServiceError`：那个的码是给 HTTP 用的（`INTERNAL` 还在自动重试表里，
 * 用它会让「装不进去」被当成瞬时故障重跑一遍）。适配器侧把它归成 `AGENT_SKILLS_UNAVAILABLE`，
 * 而那个码刻意不进 `TRANSIENT_CANDIDATE_RETRY_CODES`（装不进去不是瞬时故障）。
 */
export class SkillMaterializeError extends Error {
  /** 哪一条没装上（候选失败文案要点名到它） */
  readonly skillName: string;
  /** 那一条的源目录（排障要看的路径） */
  readonly sourceDir: string;

  constructor(skillName: string, sourceDir: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SkillMaterializeError';
    this.skillName = skillName;
    this.sourceDir = sourceDir;
  }
}

/** 物化的输入：写到哪个候选配置目录、写哪几条 */
export interface SkillMaterializeInput {
  /** 该候选的独立配置目录（本模块负责建它） */
  configHome: string;
  /** 要装入的清单；空数组 = 只建目录、一条都不写 */
  skills: readonly SkillSource[];
}

/** 取错误的人类可读原因（error 不一定是 Error） */
function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 候选**要装入的清单**：扫技能根 → 只留合格条目 → 剔掉停用名单里的名字。
 *
 * 三条判据与界面同源（`scanSkills` 与 `isSkillDisabled`）：不合格的条目（名字不合法 / 缺 description /
 * 缺 `SKILL.md`）在设置页里显示成「不可用」的一行，而它们**装不了**——厂商侧那一档的表现是
 * claude 启动前抛错、dsh 把整条静默丢弃；停用的根本不进清单（「停用 = 文件级不放」是三家统一的手段，
 * 没有任何一家有「按名字关」的配置键）。顺序沿用扫描输出的**码位升序**。
 */
export function installableSkills(entries: SkillsSettings['entries'] | undefined): SkillSource[] {
  return scanSkills()
    .skills.filter((skill) => skill.ok && !isSkillDisabled(entries, skill.name))
    .map((skill) => ({ name: skill.name, sourceDir: skill.dir }));
}

/**
 * 把清单物化进行配置目录：**幂等重放**（同一份输入两次调用逐字相同），每次 `run` 前调一次。
 *
 * 重跑同一行时不需要自己清理：`prepareCandidateWorkspace` 起手就把整个 `.agenthome/` 删掉重建
 * （`clearCandidateArtifacts`），故这里只做「有则覆盖」。
 */
export function materializeSkills(input: SkillMaterializeInput): void {
  const root = skillsDirOf(input.configHome);
  // 无条件建：宿主没配 registry 时 `writeCandidateNpmrc` 连目录都不建，不能指望别人顺带建好
  mkdirSync(root, { recursive: true });
  for (const skill of input.skills) materializeOne(root, skill);
  log.debug('技能已物化进行配置目录', {
    configHome: input.configHome,
    skills: input.skills.map((skill) => skill.name),
  });
}

/** 落盘一条：过名字那一道门 → 回验落点 → 验源目录 → 整目录复制 */
function materializeOne(root: string, skill: SkillSource): void {
  const { name, sourceDir } = skill;
  if (!isValidSkillName(name)) {
    throw new SkillMaterializeError(
      name,
      sourceDir,
      `装入技能失败：名字不合法（${name}）——只允许小写字母、数字与单个连字符，最长 ${SKILL_NAME_MAX_LENGTH}`,
    );
  }
  const dest = join(root, name);
  /**
   * 落点的**第二道**回验（第一道是上面那条名字规则）：拼出来的路径必须真的在 `skills/` 之下。
   * `..` 这类形状过不了名字规则，但这条断言是「无论名字从哪来，写入点都在候选配置目录里」的判据本身
   * ——守卫也正是按它写断言的。
   */
  const inside = relative(root, dest);
  if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) {
    throw new SkillMaterializeError(name, sourceDir, `装入技能失败：落点不在候选配置目录之下（${dest}）`);
  }
  assertSource(skill);
  try {
    cpSync(sourceDir, dest, { recursive: true, force: true });
  } catch (error) {
    throw new SkillMaterializeError(
      name,
      sourceDir,
      `装入技能「${name}」失败：把 ${sourceDir} 复制到 ${dest} 时出错（${reason(error)}）`,
      { cause: error },
    );
  }
}

/**
 * 源目录这一侧的前提：**存在、是目录、里面有 `SKILL.md`**。
 *
 * 第三条不是多余：清单来自扫描器（它已经查过一遍），但从「扫过」到「物化」之间源目录可能被改过
 * （用户删了 / 改名了），而「复制了一个没有入口文件的目录」在厂商侧的表现是**这条 skill 不存在**
 * ——我们这边看起来一切正常。三条都归同一个码，文案都点名到条。
 */
function assertSource(skill: SkillSource): void {
  const { name, sourceDir } = skill;
  let entry;
  try {
    entry = statSync(sourceDir);
  } catch (error) {
    throw new SkillMaterializeError(name, sourceDir, `装入技能「${name}」失败：源目录读不到 ${sourceDir}（${reason(error)}）`, {
      cause: error,
    });
  }
  if (!entry.isDirectory()) {
    throw new SkillMaterializeError(name, sourceDir, `装入技能「${name}」失败：源路径不是一个目录（${sourceDir}）`);
  }
  let skillFile;
  try {
    skillFile = statSync(join(sourceDir, SKILL_FILE_NAME), { throwIfNoEntry: false });
  } catch (error) {
    throw new SkillMaterializeError(name, sourceDir, `装入技能「${name}」失败：读不到 ${sourceDir} 下的 ${SKILL_FILE_NAME}（${reason(error)}）`, {
      cause: error,
    });
  }
  if (skillFile?.isFile() !== true) {
    throw new SkillMaterializeError(
      name,
      sourceDir,
      `装入技能「${name}」失败：源目录里没有 ${SKILL_FILE_NAME}（${sourceDir}）`,
    );
  }
}
