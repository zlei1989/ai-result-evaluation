// @vitest-environment node
/**
 * 工作区目录结构与行工作区准备：真实 git CLI + 真实目录复制。
 * 四条最关键的守卫：
 *   ① 目录布局逐字等于 spec §6.3（缓存 / workspace / .agenthome / events.jsonl 四者的位置）；
 *   ② 重跑同一行必须**清掉旧工作区**——否则第二个候选是在第一个候选的改动之上继续写，
 *      分数无意义、整轮作废（spec §3 F6 否决的正是这件事）；
 *   ③ `commitHash: null` 时 `baselineCommit` 必须是 40 位具体 hash（R2），**且跟随来源仓库当前
 *      的默认分支 tip**（R28）：克隆一次就把 tip 冻结住的话，来源新增的提交永远不会被评测；
 *   ④ 重跑同一行**不得**动 `events.jsonl`（R27）：它的清空归 `resetEvents`，这里顺手删会让
 *      p4 刚写下的 `preparing`（seq 1）消失、下一次追加从 seq 1 重号，p5 按 seq 去重时吞掉事件。
 */
import { cpSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterAll, afterEach, beforeAll, beforeEach } from 'vitest';
import { setConfigDirForTesting } from '../config-store';
import { removeTreeWithRetry } from './cleanup';
// 类型出口的守卫（见文件末尾「core 公共出口」的第二个用例）：包根必须导出这三个类型。
// 用 import type 逐字引入而不是 `import * as core`——类型断言无法作用于命名空间上的类型成员。




export const created: string[] = [];

export function makeTmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}

/**
 * 在临时目录里跑一条 git 命令并返回 stdout。
 * `-c user.email / user.name` 是**必需**的：跑测试的机器不一定配了全局身份，缺它时 `git commit`
 * 直接以 `Author identity unknown` 失败。
 * 另两个 `-c` 是**隔离跑测试那台机器的配置**（与 `git-repo-*.test.ts` / `git-diff-*.test.ts` 同一先例）：
 *   · `core.autocrlf=false`——Git for Windows 的**系统级** gitconfig 就带 `core.autocrlf=true`，
 *     夹具写下的 `hello\n` 会在检出时变成 `hello\r\n`，断言逐字比内容就会红；
 *   · `commit.gpgsign=false`——全局开了签名而机器上没有密钥时，夹具的每一次 commit 都失败。
 * 命令行 `-c` 优先级最高，能同时盖住系统级与全局配置，测试才不依赖跑它的机器。
 * 身份之外不加别的：`core.abbrev` 之类的隔离只有断言短哈希的用例才需要。
 */
export function git(dir: string, ...args: string[]): string {
  return execFileSync(
    'git',
    [
      '-c',
      'user.email=test@aieval.local',
      '-c',
      'user.name=aieval-test',
      '-c',
      'core.autocrlf=false',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    { cwd: dir, encoding: 'utf8' },
  );
}

/**
 * 夹具模板：`beforeAll` 里建**一次**带 `a.txt`（内容 `hello\n`）初始提交的仓库，每个用例 `cpSync` 一份。
 *
 * 为什么不是每个用例各建一个：本机的进程创建约 250–400ms（企业杀软在 CreateProcess 上收税，
 * 与跑什么程序无关——实测 `cmd /c exit 0` 250ms、`git --version` 350ms），而
 * 「init / add / commit / rev-parse」是 4 次进程创建 ≈ 1.2s。本文件 7 个用例各建一个 ⇒
 * 光夹具就 8s。`cpSync` 一份仓库是纯文件系统操作（实测 ~10ms），复制出来的仍是
 * **独立、可用**的真实仓库；用例要往来源仓库里追加提交时改的也是自己那份副本。
 *
 * 刻意**不**走 makeTmp：模板必须活过每一个 afterEach（makeTmp 会把目录登记进 `created`，
 * 而 afterEach 会清空那份清单），它的清理归下面的 afterAll。
 */
export let fixtureRepo: string;
export let fixtureCommit: string;

export function makeRepo(): { dir: string; commit: string } {
  const dir = makeTmp('aieval-ws-src-');
  cpSync(fixtureRepo, dir, { recursive: true });
  return { dir, commit: fixtureCommit };
}

export let root: string;
export let configDir: string;

/**
 * 注册本文件集的公共钩子（4 个）。
 * 为什么做成函数：harness 被多个测试文件共享，钩子必须注册在**调用它的那个文件**的 suite 上。
 */
export function registerWorkspaceHooks(): void {
  beforeAll(() => {
    fixtureRepo = mkdtempSync(join(tmpdir(), 'aieval-ws-fixture-'));
    git(fixtureRepo, 'init', '-q');
    writeFileSync(join(fixtureRepo, 'a.txt'), 'hello\n', 'utf8');
    git(fixtureRepo, 'add', 'a.txt');
    git(fixtureRepo, 'commit', '-q', '-m', '初始提交');
    fixtureCommit = git(fixtureRepo, 'rev-parse', 'HEAD').trim();
  });
  afterAll(() => {
    // 刚跑完的 git 进程可能还占着句柄，重试口径见 `./cleanup`（`maxRetries` 在本机是 no-op）
    removeTreeWithRetry(fixtureRepo);
  });
  beforeEach(() => {
    root = makeTmp('aieval-runs-');
    configDir = makeTmp('aieval-ws-cfg-');
    setConfigDirForTesting(configDir);
  });
  afterEach(() => {
    setConfigDirForTesting(null);
    // 重试口径见 `./cleanup`：刚跑完的 git 进程（克隆/检出的句柄）可能还没释放，
    // 而 `force: true` 只吞 ENOENT，`EPERM`/`EBUSY` 会直接让 afterEach 抛错并把用例判红
    for (const dir of created.splice(0)) removeTreeWithRetry(dir);
  });
}
export { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
export { tmpdir } from 'node:os';
export { join } from 'node:path';
export { execFileSync } from 'node:child_process';
export { getConfigDir, setConfigDirForTesting } from '../config-store';
export type { AppConfig, Logger, PendingAgentEvent } from '../index';
export { appendEvent, readEvents } from '../event-log';
export { caseCacheDir, ensureRowJudgeHome, prepareRowWorkspace, rowAgentHomeDir, rowAttemptsFile, rowDir, rowEventsFile, rowJudgeHomeDir, rowWorkspaceDir, runDir, runSnapshotFile } from '../workspace';