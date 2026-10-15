/**
 * 探针 04：**HOME 锚定的技能到底从哪条路径被发现**——把「我们以为会泄漏进来的那批」量清楚。
 *
 * 为什么需要单独一格：`index.ts` 的注释说过滤是为了挡住 HOME 锚定的 `~/.agents/skills`
 * （「`trust: false` 也砍不掉它」）。这句话要在真机上量三件事才算成立：
 *   ① 那条路径**在不设任何配置**时真的会被扫到吗（基数是多少）；
 *   ② 它扫到之后进不进「交给模型的技能段」；
 *   ③ `agentDir`（= 行配置目录）在**不设 `PI_CODING_AGENT_DIR`** 时是不是也被扫
 *      （探针 03 的子进程设了这个变量，读数里一条 HOME 技能都没有 ⇒ 两者必有一个在起作用）。
 *
 * 三格各跑一次 `DefaultResourceLoader`，只读 `getSkills()`：
 *   · 格 A：`HOME` = 临时目录（里面布金丝雀），`PI_CODING_AGENT_DIR` **不设**；
 *   · 格 B：`HOME` = 真实家目录，`PI_CODING_AGENT_DIR` **不设**（对照：真实宿主有什么）；
 *   · 格 C：`HOME` = 临时目录 + `PI_CODING_AGENT_DIR` = 临时目录（探针 03 的那一档）。
 *
 * 三格必须在**各自的新进程**里跑（`os.homedir()` 启动即定），故由本驱动器用
 * `--case=` 递归拉起自己。
 *
 * 用法：
 *   node packages/server/agents/probe/v12/04-home-skill-roots.mjs
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const selfPath = fileURLToPath(import.meta.url);
const SDK = '@earendil-works/pi-coding-agent';
const CANARY = 'home-canary-skill';

const caseFlag = process.argv.find((one) => one.startsWith('--case='));
const which = caseFlag === undefined ? null : caseFlag.slice('--case='.length);

/** 布一棵「假 HOME」：金丝雀放在厂商的 HOME 锚定发现路径上 */
function seedFakeHome(home) {
  for (const dir of ['.agents', '.pi']) {
    const target = join(home, dir, 'skills', CANARY);
    mkdirSync(target, { recursive: true });
    writeFileSync(
      join(target, 'SKILL.md'),
      `---\nname: ${CANARY}\ndescription: 宿主家目录里的金丝雀技能\n---\n\n这一段只该留在宿主家目录。\n`,
      'utf8',
    );
  }
  // `~/.pi/agent` 也布一份（SDK 的 agentDir 缺省值就是这里）
  const agentSkill = join(home, '.pi', 'agent', 'skills', `${CANARY}-agent`);
  mkdirSync(agentSkill, { recursive: true });
  writeFileSync(
    join(agentSkill, 'SKILL.md'),
    `---\nname: ${CANARY}-agent\ndescription: 缺省 agentDir 下的金丝雀\n---\n\n正文。\n`,
    'utf8',
  );
}

/** 一格读数：装载器报出来的技能清单（名字 + 落点 + scope） */
async function readLoader({ cwd, agentDir }) {
  const sdk = await import(SDK);
  const loader = new sdk.DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager: sdk.SettingsManager.inMemory(),
    noExtensions: true,
  });
  await loader.reload({ resolveProjectTrust: async () => true });
  const skills = loader.getSkills();
  return {
    cwd,
    agentDir,
    homedir: homedir(),
    envHome: process.env.HOME ?? null,
    envAgentDir: process.env.PI_CODING_AGENT_DIR ?? null,
    discovered: skills.skills.map((skill) => ({
      name: skill.name,
      filePath: skill.filePath,
      scope: skill.sourceInfo?.scope ?? null,
    })),
    diagnostics: skills.diagnostics,
  };
}

if (which === null) {
  // 驱动器：三格各起一个自己的进程（HOME 只能在启动时定）
  const fakeHome = mkdtempSync(join(tmpdir(), 'pi-v12-home-'));
  const fakeAgent = mkdtempSync(join(tmpdir(), 'pi-v12-agentdir-'));
  seedFakeHome(fakeHome);
  const cases = [
    { name: 'A-fake-home', env: { HOME: fakeHome, PI_CODING_AGENT_DIR: undefined } },
    { name: 'B-real-home', env: { HOME: undefined, PI_CODING_AGENT_DIR: undefined } },
    { name: 'C-fake-home-and-agentdir', env: { HOME: fakeHome, PI_CODING_AGENT_DIR: fakeAgent } },
  ];
  const readings = {};
  for (const entry of cases) {
    const env = { ...process.env };
    if (entry.env.HOME === undefined) delete env.HOME;
    else env.HOME = entry.env.HOME;
    if (entry.env.PI_CODING_AGENT_DIR === undefined) delete env.PI_CODING_AGENT_DIR;
    else env.PI_CODING_AGENT_DIR = entry.env.PI_CODING_AGENT_DIR;
    const out = spawnSync(process.execPath, [selfPath, `--case=${entry.name}`], {
      cwd: dirname(selfPath),
      env,
      encoding: 'utf8',
    });
    const line = (out.stdout ?? '').split('\n').find((one) => one.startsWith('{'));
    readings[entry.name] = line === undefined
      ? { parseError: true, stdout: out.stdout, stderr: out.stderr, status: out.status }
      : JSON.parse(line);
  }
  readings.__layout = {
    fakeHome,
    fakeAgent,
    realHome: homedir(),
    realHomeCandidates: [join(homedir(), '.agents', 'skills'), join(homedir(), '.pi', 'skills'), join(homedir(), '.pi', 'agent', 'skills')]
      .map((path) => ({ path, exists: existsSync(path) })),
  };
  const dumpDir = join(dirname(selfPath), '..', 'dumps', 'v12');
  mkdirSync(dumpDir, { recursive: true });
  writeFileSync(join(dumpDir, '04-home-skill-roots.json'), `${JSON.stringify(readings, null, 2)}\n`, 'utf8');
  for (const [name, reading] of Object.entries(readings)) {
    if (name.startsWith('__')) continue;
    console.log(`[v12] ${name}: homedir=${reading.homedir} agentDir=${reading.agentDir} 技能 ${reading.discovered?.length ?? '?'} 条`);
    for (const skill of reading.discovered ?? []) console.log(`        ${skill.name}  [${skill.scope}]  ${skill.filePath}`);
  }
  console.log('[v12] 真实家目录候选:', JSON.stringify(readings.__layout.realHomeCandidates));
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(fakeAgent, { recursive: true, force: true });
} else {
  // 单格：这一格只回答「这个环境下装载器扫到了什么」
  const cwd = mkdtempSync(join(tmpdir(), 'pi-v12-cwd-'));
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(realHomeOf(), '.pi', 'agent');
  const reading = await readLoader({ cwd, agentDir });
  process.stdout.write(`${JSON.stringify(reading)}\n`);
  rmSync(cwd, { recursive: true, force: true });
}

function realHomeOf() {
  // 单格进程里 homedir() 就是本格的 HOME（驱动器已经把 env 设好）
  try {
    return realpathSync(homedir());
  } catch {
    return homedir();
  }
}
