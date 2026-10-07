// @vitest-environment node
/**
 * git 原语（仓库侧）：真实 git CLI，禁 mock（spec §9）。
 * 为什么禁 mock：mock 掉的正是最容易错的地方——`cat-file -e` 的 `^{commit}` 语法、
 * `rev-parse --show-toplevel` 的返回形态、克隆后 `.git` 是否真的存在、复制是否带上 `.git`。
 * 三个环境上的注意点：
 *   1. `git commit` 一律带 `-c user.email=... -c user.name=...`（写在 init 里），
 *      否则 CI / 新机器上没有全局身份会直接 commit 失败；
 *   2. 所有仓库都建在 `os.tmpdir()` 下的临时目录里，结束即删；
 *   3. 每个用例前 `setConfigDirForTesting(tmp)` 并断言指向它——本模块不该读配置，
 *      这条断言是「将来有人顺手 loadConfig() 时会红」的护栏（Review Focus 5）。
 */
import { cpSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterAll, afterEach, beforeAll, beforeEach } from 'vitest';

import { setConfigDirForTesting } from '../config-store';
import { removeTreeWithRetry } from './cleanup';


export const created: string[] = [];

/** 建一个隔离的临时目录（每个仓库一个，互不嵌套） */
export function makeTmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}

/**
 * 在临时目录里跑一条 git 命令并返回 stdout。
 * `-c user.email / user.name` 是**必需**的：本仓的测试机与 CI 上不一定配了全局身份，
 * 缺它时 `git commit` 直接以 `Author identity unknown` 失败。
 * 另外三个 `-c` 是**隔离跑测试那台机器的配置**（review 重要 #3，本机实测）：
 *   · `core.autocrlf=false`——Git for Windows 的**系统级** gitconfig 就带 `core.autocrlf=true`
 *     （`D:/…/Git/etc/gitconfig`），全局配置一旦没覆盖它，克隆出来的工作树就是 CRLF；
 *   · `commit.gpgsign=false`——全局开了签名而机器上没有密钥时，每一次 commit 都失败；
 *   · `core.abbrev=7`——用户改过 abbrev 会让短哈希长度变。命令行 `-c` 优先级最高，
 *     同时盖住系统级与全局配置，测试才不依赖跑它的机器。
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
 * 夹具模板（两份，各 `beforeAll` 建一次，每个用例 `cpSync` 一份）：
 *   · `fixtureEmpty`——已 `git init`、还没有任何提交的仓库（`makeRepo` 用）；
 *   · `fixtureCommit`——在上面基础上提交了 `a.txt`（内容 `hello\n`）的仓库（`makeRepoWithCommit` 用）。
 *
 * 为什么不是每个用例各建一个：本机的进程创建约 250–400ms（企业杀软在 CreateProcess 上收税，
 * 与跑什么程序无关——实测 `cmd /c exit 0` 250ms、`git --version` 350ms），而
 * `makeRepoWithCommit` 要走 4 次（init / add / commit / rev-parse）≈ 1.2s。本文件 19 处调用 ⇒
 * 光夹具就 23s，是 core 包单文件耗时的大头。`cpSync` 一份仓库是纯文件系统操作（实测 ~10ms），
 * 复制出来的仍是**独立、可用**的真实仓库——本文件下面的 `copyWorkspace` 用例守的正是这件事。
 *
 * 需要「多个提交」或「空仓库」的用例仍然自己建（见各用例里的 `makeRepo` + 逐次 commit）：
 * 模板只覆盖「一个初始提交」这个绝大多数用例要的形状。
 */
export let fixtureEmpty: string;
export let fixtureCommit: string;
export let fixtureCommitHash: string;

/** 建一个已 `git init` 的临时仓库（模板副本，无提交），返回其路径 */
export function makeRepo(prefix: string): string {
  const dir = makeTmp(prefix);
  cpSync(fixtureEmpty, dir, { recursive: true });
  return dir;
}

/** 建仓库并提交一个 `a.txt`（模板副本），返回 { dir, commit } */
export function makeRepoWithCommit(prefix: string): { dir: string; commit: string } {
  const dir = makeTmp(prefix);
  cpSync(fixtureCommit, dir, { recursive: true });
  return { dir, commit: fixtureCommitHash };
}

export let configDir: string;

/**
 * 注册本文件集的公共钩子（4 个）。
 * 为什么做成函数：harness 被多个测试文件共享，钩子必须注册在**调用它的那个文件**的 suite 上。
 */
export function registerGitRepoHooks(): void {
  beforeAll(() => {
    // 刻意**不**走 makeTmp：模板必须活过每一个 afterEach（makeTmp 会把目录登记进 `created`，
    // 而 afterEach 会清空那份清单），它们的清理归下面的 afterAll。两个模板互不嵌套。
    fixtureEmpty = mkdtempSync(join(tmpdir(), 'aieval-git-fixture-empty-'));
    git(fixtureEmpty, 'init', '-q');
    fixtureCommit = mkdtempSync(join(tmpdir(), 'aieval-git-fixture-commit-'));
    git(fixtureCommit, 'init', '-q');
    writeFileSync(join(fixtureCommit, 'a.txt'), 'hello\n', 'utf8');
    git(fixtureCommit, 'add', 'a.txt');
    git(fixtureCommit, 'commit', '-q', '-m', '初始提交');
    fixtureCommitHash = git(fixtureCommit, 'rev-parse', 'HEAD').trim();
  });
  afterAll(() => {
    // 刚跑完的 git 进程可能还占着句柄，重试口径见 `./cleanup`（`maxRetries` 在本机是 no-op）
    for (const dir of [fixtureEmpty, fixtureCommit]) {
      removeTreeWithRetry(dir);
    }
  });
  beforeEach(() => {
    // 本模块不读配置，但这条断言保证任何「顺手读一下配置」的实现改动都会在真实家目录之外发生
    configDir = makeTmp('aieval-git-cfg-');
    setConfigDirForTesting(configDir);
  });
  afterEach(() => {
    setConfigDirForTesting(null);
    // 重试口径见 `./cleanup`：刚跑完的 git 进程（克隆/检出的句柄）可能还没释放，
    // 而 `force: true` 只吞 ENOENT，`EPERM`/`EBUSY` 会直接让 afterEach 抛错并把用例判红
    // （本机实测：全包并行时 `EPERM, Permission denied` 落在 ensureCaseCache 的那条用例上，
    // 而用例本体是绿的）。
    for (const dir of created.splice(0)) removeTreeWithRetry(dir);
  });
}
export { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
export { tmpdir } from 'node:os';
export { basename, join } from 'node:path';
export { execFileSync } from 'node:child_process';
export { ServiceError } from '@aieval/contracts';
export { setConfigDirForTesting } from '../config-store';
export { assertCommit, checkoutRow, copyWorkspace, ensureCaseCache, isGitRepo, listCommits, resolveRepoInfo } from '../git';