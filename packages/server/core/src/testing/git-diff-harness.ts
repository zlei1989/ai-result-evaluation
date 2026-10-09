// @vitest-environment node
/**
 * 三样 diff 合并与裁剪：真实 git CLI，禁 mock（spec §9）。
 * 本文件是整个 p0 最关键的回归网，覆盖 spec §9 要求的五种组合与三条专门用例：
 *   · 只有已提交改动 / 只有未提交改动 / 只有未跟踪新文件 / 三者都有 / 全空；
 *   · 「只取 commit..HEAD 会漏掉未提交改动」的专门用例；
 *   · 「未跟踪文件的**正文**必须出现在 diff 文本里」的专门用例（R3 的核心）；
 *   · 「未跟踪清单必须在 `git add --intent-to-add` **之前**读」的专门用例（实测校准）。
 * 注意：每个用例都拿到一个**独立的**临时仓库（`beforeAll` 建的模板的副本，见下方 `fixtureRepo`），
 * 临时仓库的 `git commit` 一律带身份（见 git()）。
 */
import { cpSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterAll, afterEach, beforeAll, beforeEach } from 'vitest';

import { setConfigDirForTesting } from '../config-store';
import { removeTreeWithRetry } from './cleanup';


export const created: string[] = [];

export function makeTmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}

/**
 * 在临时目录里跑一条 git 命令并返回 stdout。
 * 三个 `-c` 用来隔离跑测试那台机器的配置（review 重要 #3，本机实测）：
 * `core.autocrlf=false`（Git for Windows 的**系统级** gitconfig 就带 `core.autocrlf=true`）、
 * `commit.gpgsign=false`（全局开了签名而机器上没有密钥时，每一次 commit 都失败）、
 * `core.abbrev=7`（用户改过 abbrev 会让短哈希长度变）。命令行 `-c` 优先级最高。
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
      '-c',
      'core.abbrev=7',
      ...args,
    ],
    { cwd: dir, encoding: 'utf8' },
  );
}

/**
 * 夹具模板：`beforeAll` 里建**一次**带 `a.txt` 初始提交的仓库，每个用例 `cpSync` 一份。
 *
 * 为什么不是每个用例各建一个：本机的进程创建约 250–400ms（企业杀软在 CreateProcess 上收税，
 * 与跑什么程序无关——实测 `cmd /c exit 0` 250ms、`git --version` 350ms），而
 * 「init / add / commit / rev-parse」是 4 次进程创建 ≈ 1.2s。本文件 17 个用例各建一个 ⇒
 * 光夹具就 20s。`cpSync` 一份仓库是纯文件系统操作（实测 ~10ms），复制出来的仍是
 * **独立、可用**的真实仓库——这一点由 `git-repo-cache.test.ts` 的 copyWorkspace 用例守着。
 *
 * 复制后 git 会重新按内容判定工作树是否干净（复制改了 mtime，git 退回比内容），
 * 所以「全空」那条用例的 `filesChanged === 0` 断言不受影响。
 */
export let fixtureRepo: string;
export let fixtureBase: string;

/** 建一个已有 `a.txt` 提交的临时仓库（模板的副本），返回 { dir, base }（base 是 40 位 hash） */
export function makeRepo(prefix: string): { dir: string; base: string } {
  const dir = makeTmp(prefix);
  cpSync(fixtureRepo, dir, { recursive: true });
  return { dir, base: fixtureBase };
}

/** 从合并文本里截出某一段的正文（段标题之间的内容） */
export function section(text: string, title: string): string {
  const start = text.indexOf(title);
  if (start < 0) return '';
  const from = start + title.length;
  const nextHeader = text.indexOf('\n### ', from);
  return nextHeader < 0 ? text.slice(from) : text.slice(from, nextHeader);
}

export const COMMITTED = '### 已提交改动';
export const UNCOMMITTED = '### 未提交改动';
export const UNTRACKED = '### 未跟踪文件';

export let configDir: string;

/**
 * 注册本文件集的公共钩子（4 个）。
 * 为什么做成函数：harness 被多个测试文件共享，钩子必须注册在**调用它的那个文件**的 suite 上。
 */
export function registerGitDiffHooks(): void {
  beforeAll(() => {
    // 刻意**不**走 makeTmp：模板必须活过每一个 afterEach（makeTmp 会把目录登记进 `created`，
    // 而 afterEach 会清空那份清单），它的清理归下面的 afterAll。
    fixtureRepo = mkdtempSync(join(tmpdir(), 'aieval-diff-fixture-'));
    git(fixtureRepo, 'init', '-q');
    writeFileSync(join(fixtureRepo, 'a.txt'), 'hello\n', 'utf8');
    git(fixtureRepo, 'add', 'a.txt');
    git(fixtureRepo, 'commit', '-q', '-m', '初始提交');
    fixtureBase = git(fixtureRepo, 'rev-parse', 'HEAD').trim();
  });
  afterAll(() => {
    // 刚跑完的 git 进程可能还占着句柄，重试口径见 `./cleanup`（`maxRetries` 在本机是 no-op）
    removeTreeWithRetry(fixtureRepo);
  });
  beforeEach(() => {
    // Review Focus 5：本模块不读配置，但这条指针保证任何「顺手 loadConfig()」都在临时目录外发生
    configDir = makeTmp('aieval-diff-cfg-');
    setConfigDirForTesting(configDir);
  });
  afterEach(() => {
    setConfigDirForTesting(null);
    // 重试口径见 `./cleanup`：Windows 上刚跑完的 git 进程可能还占着句柄，
    // 不真重试的话 `force: true` 挡不住 EPERM/EBUSY，afterEach 会把本来绿的用例判红
    for (const dir of created.splice(0)) removeTreeWithRetry(dir);
  });
}
export { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
export { tmpdir } from 'node:os';
export { join } from 'node:path';
export { execFileSync } from 'node:child_process';
export { ServiceError } from '@aieval/contracts';
export { setConfigDirForTesting } from '../config-store';
export { collectDiff, truncateDiff } from '../git';