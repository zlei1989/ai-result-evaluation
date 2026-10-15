/**
 * 探针 01：**装载器交出来的技能面**——`getSkills()` 的 `filePath` / `scope` 长什么样，
 * 以及适配器的 `keepRowAndProjectSkills` 过滤在真实路径形态下会发生什么。
 *
 * 要回答的四件事（文档都当成既定事实写着，但没有一条在真机上读过）：
 *   ① 经 `additionalSkillPaths` 装进来的行技能，`filePath` 是**我们给的那条绝对路径**，
 *      还是厂商自己解析/realpath 之后的另一条？（决定 `isUnder(filePath, configHome)` 成不成立）
 *   ② 被测仓库（`cwd`）自带的项目技能会不会被发现、`scope` 报什么；
 *   ③ HOME 锚定的发现结果（`~/.agents/skills` 之类）在 `skillsOverride` 过滤前的**基数**是多少
 *      ——「丢掉 HOME 锚定的那批」这句话要有一个基数才有意义；
 *   ④ `diagnostics` 在同名冲突时到底给什么形状（`index.ts` 的 `skillCollisions` 逐格取
 *      `type/collision.{name,winnerPath,loserPath}`——取不到就静默不报）。
 *
 * 为什么零模型调用就能答：这四件事全部由 `reload()` 决定，与发不发请求无关。
 *
 * 用法（不需要任何凭据）：
 *   node packages/server/agents/probe/v12/01-loader-skills.mjs
 */
import { existsSync, mkdirSync, realpathSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  SDK, dropRoot, isolateAgentDir, makeRoot, makeRow, note, skillFacts, writeDump, writeSkill,
} from './lib/loader-facts.mjs';

const sdk = await import(SDK);

const root = makeRoot('pi-v12-loader-');
const restoreAgentDir = isolateAgentDir(join(root, 'global-agent-dir'));
const readings = { root, rows: [], homeDiscovery: null, notes: [] };

/**
 * 与适配器**逐字同形**的一份行装配（只省掉 createAgentSession）：
 * `providers/pi/index.ts` 的 `createLoader` 是唯一真源，这里抄的是它今天的样子。
 */
function makeLoader({ cwd, configHome, rowSkillsDir, subagentsExtensionPath, withOverride }) {
  const options = {
    cwd,
    agentDir: configHome,
    additionalSkillPaths: [rowSkillsDir],
    noExtensions: true,
    ...(subagentsExtensionPath === null ? {} : { additionalExtensionPaths: [subagentsExtensionPath] }),
    settingsManager: sdk.SettingsManager.inMemory(),
    ...(withOverride
      ? { skillsOverride: (base) => keepRowAndProjectSkills(base, { rowSkillsDir, cwd }) }
      : {}),
  };
  return new sdk.DefaultResourceLoader(options);
}

/** 适配器 `index.ts` 的 `keepRowAndProjectSkills` + `isUnder`（逐字抄，用来做对照臂） */
function keepRowAndProjectSkills(base, roots) {
  const skills = base.skills.filter(
    (skill) => isUnder(skill.filePath, roots.rowSkillsDir) || isUnder(skill.filePath, roots.cwd),
  );
  return { skills, diagnostics: base.diagnostics };
}
function isUnder(path, root) {
  if (path === root) return true;
  const withSeparator = root.endsWith('/') || root.endsWith('\\') ? root : `${root}/`;
  return path.startsWith(withSeparator) || path.startsWith(`${withSeparator.replace(/\//g, '\\')}`);
}

/** 一行：行技能一条 + 项目技能一条，旁开一份「不过滤」的装载器做对照 */
async function probeRow({ label, cwd, configHome }) {
  const rowSkillsDir = join(configHome, 'skills');
  writeSkill(join(rowSkillsDir, 'row-skill'), 'row-skill', '行技能正文');
  writeSkill(join(cwd, '.pi', 'skills', 'project-skill'), 'project-skill', '项目技能正文');
  // 厂商的项目技能发现路径不止一条：`.pi/skills` 与 `.agents/skills` 都试上，看哪条真的被扫到
  writeSkill(join(cwd, '.agents', 'skills', 'agents-skill'), 'agents-skill', '另一条项目路径');
  // 同名冲突：行技能与项目技能同名（厂商的 collision 诊断靠它）
  writeSkill(join(cwd, '.pi', 'skills', 'row-skill'), 'row-skill', '项目侧同名的那一份');

  const withOverride = makeLoader({ cwd, configHome, rowSkillsDir, subagentsExtensionPath: null, withOverride: true });
  const raw = makeLoader({ cwd, configHome, rowSkillsDir, subagentsExtensionPath: null, withOverride: false });
  await withOverride.reload({ resolveProjectTrust: async () => true });
  await raw.reload({ resolveProjectTrust: async () => true });

  const filtered = withOverride.getSkills();
  const unfiltered = raw.getSkills();
  return {
    label,
    cwd,
    configHome,
    rowSkillsDir,
    realpathCwd: realpathOf(cwd),
    rowSkillsDirExists: existsSync(rowSkillsDir),
    filtered: skillFacts(filtered),
    unfiltered: skillFacts(unfiltered),
    keptNames: filtered.skills.map((one) => one.name),
    droppedNames: unfiltered.skills
      .filter((one) => !filtered.skills.some((kept) => kept.name === one.name && kept.filePath === one.filePath))
      .map((one) => `${one.name}@${one.filePath}`),
  };
}

function realpathOf(path) {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// 格 A：常规（临时根、无软链）——这是生产上最常见的形状
// ---------------------------------------------------------------------------------------------
const rowA = makeRow('pi-v12-row-a-');
readings.rows.push(await probeRow({ label: 'A 常规临时根', ...rowA }));

// ---------------------------------------------------------------------------------------------
// 格 B：软链伪装——`configHome` 的**父目录**是软链，`cwd` 走真实路径。
// 这一格问的是：厂商交出来的 `filePath` 是「我们给的那条」还是 realpath 之后的那条。
// 两者的差别只在「有没有软链」时显形，而 macOS 的 `/tmp`→`/private/tmp` 正是这种形状。
// ---------------------------------------------------------------------------------------------
const realRoot = makeRoot('pi-v12-real-');
const linkParent = makeRoot('pi-v12-link-');
const linkRoot = join(linkParent, 'linked');
try {
  symlinkSync(realRoot, linkRoot, 'dir');
  const cwdB = join(realRoot, 'workspace');
  mkdirSync(cwdB, { recursive: true });
  const configHomeB = join(linkRoot, '.agenthome');
  readings.rows.push(await probeRow({
    label: 'B configHome 走软链、cwd 走真实路径',
    cwd: cwdB,
    configHome: configHomeB,
  }));
} catch (error) {
  readings.notes.push(`格 B 建软链失败（这一格没跑）：${String(error)}`);
}

// ---------------------------------------------------------------------------------------------
// 格 C：`/tmp` 与 `/private/tmp`（macOS 上 tmpdir 的两种写法）——同一棵树、两条字符串。
// ---------------------------------------------------------------------------------------------
const tmpRoot = makeRoot('pi-v12-tmp-');
try {
  const viaTmp = `/tmp/${tmpRoot.split('/').slice(3).join('/')}`;
  const cwdC = viaTmp;
  const configHomeC = join(tmpRoot, '.agenthome-c');
  writeSkill(join(configHomeC, 'skills', 'tmp-skill'), 'tmp-skill', '正文');
  const loader = makeLoader({
    cwd: cwdC,
    configHome: configHomeC,
    rowSkillsDir: join(configHomeC, 'skills'),
    subagentsExtensionPath: null,
    withOverride: true,
  });
  await loader.reload({ resolveProjectTrust: async () => true });
  readings.rows.push({
    label: 'C cwd 走 /tmp 别名、configHome 走 /private/var 真实路径',
    cwd: cwdC,
    configHome: configHomeC,
    cwdExists: existsSync(cwdC),
    kept: skillFacts(loader.getSkills()),
  });
} catch (error) {
  readings.notes.push(`格 C 失败（这一格没跑）：${String(error)}`);
}

// ---------------------------------------------------------------------------------------------
// 格 D：宿主 HOME 锚定的技能面——「过滤前有多少条」这个基数
// ---------------------------------------------------------------------------------------------
const homeCandidates = [
  join(homedir(), '.agents', 'skills'),
  join(homedir(), '.pi', 'skills'),
  join(homedir(), '.pi', 'agent', 'skills'),
  join(homedir(), '.claude', 'skills'),
];
readings.homeDiscovery = {
  homedir: homedir(),
  candidates: homeCandidates.map((path) => ({ path, exists: existsSync(path) })),
  note: '本格只报「宿主上这些目录在不在」，不读它们的内容',
};

note('读数：', JSON.stringify({
  rows: readings.rows.map((row) => ({
    label: row.label,
    kept: row.keptNames ?? row.kept?.skills?.map((one) => one.name) ?? null,
    dropped: row.droppedNames ?? null,
  })),
}, null, 2));

const file = writeDump('01-loader-skills', readings);
note('落盘', file);
restoreAgentDir();
dropRoot(root);
dropRoot(realRoot);
dropRoot(linkParent);
dropRoot(tmpRoot);
