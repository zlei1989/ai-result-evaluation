/**
 * 探针 03 的驱动器：把 `HOME` 与 `PI_CODING_AGENT_DIR` 都指到临时目录，再拉起
 * `src/providers/pi/probe/03-skills-home.test.ts`。
 *
 * 为什么要单独一支驱动器：`os.homedir()` 在 Node 启动时就定下来了，**只能靠新进程的 env** 改
 * （同进程 `process.env.HOME = …` 是无效写法，见那份用例的文件头）。
 *
 * 三条硬口径：
 *   · 两棵临时目录都由本进程造，跑完删（`rmSync(force)`，不吞别的错）；
 *   · 金丝雀由**驱动器**布（子进程只读），布完打印一遍，读数是「布了什么 vs 进来什么」两截；
 *   · 子进程的退出码原样透传（0 = 四条判据全过，非 0 = 探针报红），本进程不解释它——
 *     读数在 `probe/dumps/v12/03-skills-home-subprocess.json` 里，判据在用例里。
 *
 * 用法（不需要任何凭据）：
 *   node packages/server/agents/probe/v12/03-skills-home-subprocess.mjs
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const agentsPackage = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const repoRoot = join(agentsPackage, '..', '..', '..');
const testFile = join('packages', 'server', 'agents', 'src', 'providers', 'pi', 'probe', '03-skills-home.test.ts');

const home = mkdtempSync(join(tmpdir(), 'pi-v12-home-'));
const agentDir = mkdtempSync(join(tmpdir(), 'pi-v12-agentdir-'));

for (const [dir, name] of [['.agents', 'home-canary-skill'], ['.pi', 'home-canary-skill-pi']]) {
  const target = join(home, dir, 'skills', name);
  mkdirSync(target, { recursive: true });
  writeFileSync(
    join(target, 'SKILL.md'),
    `---\nname: ${name}\ndescription: 宿主家目录里的金丝雀技能\n---\n\n这一段只该留在宿主家目录，不许进模型上下文。\n`,
    'utf8',
  );
}
console.log('[v12] 假 HOME 布好金丝雀：', home);

const result = spawnSync(
  process.execPath,
  [join(repoRoot, 'node_modules', 'vitest', 'vitest.mjs'), 'run', testFile, '--reporter=default'],
  {
    cwd: repoRoot,
    env: { ...process.env, HOME: home, PI_CODING_AGENT_DIR: agentDir },
    stdio: 'inherit',
  },
);

console.log('[v12] 子进程退出码：', result.status);
rmSync(home, { recursive: true, force: true });
rmSync(agentDir, { recursive: true, force: true });
process.exit(result.status ?? 1);
