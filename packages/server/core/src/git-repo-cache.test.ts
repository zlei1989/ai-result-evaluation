// @vitest-environment node
/**
 * ensureCaseCache
 *
 * 本文件是 `git.repo.test.ts` 拆分后的一块：真实临时仓库模板、`git()` 助手与清理钩子都在 `./testing/git-repo-harness`（那里也写明了钩子为什么必须是显式注册的函数）。
 */
import { describe, expect, it } from 'vitest';
import {
  makeTmp,
  git,
  makeRepoWithCommit,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
  join,
  ServiceError,
  copyWorkspace,
  ensureCaseCache,
  registerGitRepoHooks,
} from './testing/git-repo-harness';
import { removeTreeWithRetry } from './testing/cleanup';



registerGitRepoHooks();

describe('ensureCaseCache', () => {
  it('首次调用真的克隆出带 .git 的完整仓库，且工作树文件在', () => {
    const { dir } = makeRepoWithCommit('aieval-git-src-');
    const cache = join(makeTmp('aieval-ws-'), 'cases', 'c-1', 'cache');
    ensureCaseCache(dir, cache);
    expect(existsSync(join(cache, '.git'))).toBe(true);
    expect(readFileSync(join(cache, 'a.txt'), 'utf8')).toBe('hello\n');
    // 来源记录（`.aieval-origin.json`）写在 `.git` 里，绝不能出现在工作树：工作树里的文件会被
    // copyWorkspace 复制进行工作区，再被 `git status` 当成「agent 新建的文件」计入三样 diff
    //（污染评分输入与界面的文件树）。故这条 status 必须是干净的。
    expect(git(cache, 'status', '--porcelain').trim()).toBe('');
  });

  it('第二次调用不重克隆：缓存目录里的未跟踪文件不被清掉（「不存在才克隆」的回归守卫）', () => {
    // `commitHash` 缺省（= null）时会 `git fetch` + `reset --hard` 把缓存刷到来源当前的 tip，
    // 但**不重建**：`reset --hard` 不动未跟踪文件，而重克隆（rmSync + clone）会把它清掉——
    // 这条断言正是「刷新 ≠ 重建」的判据。
    const { dir } = makeRepoWithCommit('aieval-git-src-');
    const cache = join(makeTmp('aieval-ws-'), 'cases', 'c-1', 'cache');
    ensureCaseCache(dir, cache);
    writeFileSync(join(cache, 'local-marker.txt'), 'keep me\n', 'utf8');
    ensureCaseCache(dir, cache);
    expect(existsSync(join(cache, 'local-marker.txt'))).toBe(true);
  });

  it('目标父目录不存在时自动创建', () => {
    const { dir } = makeRepoWithCommit('aieval-git-src-');
    const cache = join(makeTmp('aieval-ws-'), 'deep', 'nested', 'cache');
    ensureCaseCache(dir, cache);
    expect(existsSync(join(cache, '.git'))).toBe(true);
  });

  it('来源仓库变了就重克隆：缓存是**某一个**仓库的克隆，换了来源必须重建', () => {
    const a = makeRepoWithCommit('aieval-git-srcA-');
    const cache = join(makeTmp('aieval-ws-'), 'cases', 'c-1', 'cache');
    ensureCaseCache(a.dir, cache, null);
    // 未跟踪的标记文件：只刷新（fetch + reset）时它留下，重克隆时它必然消失——这是「确实重建过」的判据
    writeFileSync(join(cache, 'local-marker.txt'), 'keep me\n', 'utf8');

    // 用例改填了另一个仓库，而旧来源**已经不存在**（仓库被移走 / 改名是最常见的情形）。
    // 缓存里存着旧的 origin URL：不按来源记录重建的话，后续 fetch / 刷新会一直对着旧来源，
    // 把「来源仓库不可达」报成这一行的失败，而用户明明已经在用例里填了新路径。
    removeTreeWithRetry(a.dir);
    const b = makeRepoWithCommit('aieval-git-srcB-');
    writeFileSync(join(b.dir, 'from-b.txt'), 'b\n', 'utf8');
    git(b.dir, 'add', 'from-b.txt');
    git(b.dir, 'commit', '-q', '-m', 'B 的独有文件');

    ensureCaseCache(b.dir, cache, null);

    // ① 内容是**新来源**的；② 未跟踪标记没了（重建过，不是刷新）；③ origin 指向新来源
    expect(existsSync(join(cache, 'from-b.txt'))).toBe(true);
    expect(existsSync(join(cache, 'local-marker.txt'))).toBe(false);
    expect(git(cache, 'remote', 'get-url', 'origin').trim()).toBe(realpathSync(b.dir));
  });

  it('commitHash 为 null 时把缓存刷新到来源当前的 tip（不冻结在克隆那一刻），且不重克隆', () => {
    const { dir } = makeRepoWithCommit('aieval-git-src-');
    const cache = join(makeTmp('aieval-ws-'), 'cases', 'c-1', 'cache');
    ensureCaseCache(dir, cache, null);
    expect(existsSync(join(cache, 'later.txt'))).toBe(false);
    writeFileSync(join(cache, 'local-marker.txt'), 'keep me\n', 'utf8');

    writeFileSync(join(dir, 'later.txt'), 'later\n', 'utf8');
    git(dir, 'add', 'later.txt');
    git(dir, 'commit', '-q', '-m', '来源前移');
    const tip = git(dir, 'rev-parse', 'HEAD').trim();

    ensureCaseCache(dir, cache, null);

    expect(git(cache, 'rev-parse', 'HEAD').trim()).toBe(tip);
    expect(readFileSync(join(cache, 'later.txt'), 'utf8')).toBe('later\n');
    expect(existsSync(join(cache, 'local-marker.txt'))).toBe(true);
  });

  it('来源在缓存建立之后新增的 commit：fetch 一次补齐即可用（不重克隆）', () => {
    const { dir } = makeRepoWithCommit('aieval-git-src-');
    const cache = join(makeTmp('aieval-ws-'), 'cases', 'c-1', 'cache');
    ensureCaseCache(dir, cache, null);
    writeFileSync(join(dir, 'later.txt'), 'later\n', 'utf8');
    git(dir, 'add', 'later.txt');
    git(dir, 'commit', '-q', '-m', '缓存建立之后的提交');
    const later = git(dir, 'rev-parse', 'HEAD').trim();
    writeFileSync(join(cache, 'local-marker.txt'), 'keep me\n', 'utf8');

    expect(() => ensureCaseCache(dir, cache, later)).not.toThrow();

    // 缓存里现在有这个 commit（checkoutRow 拿得到它），而缓存目录没有被重建
    expect(git(cache, 'rev-parse', `${later}^{commit}`).trim()).toBe(later);
    expect(existsSync(join(cache, 'local-marker.txt'))).toBe(true);
  });

  it('请求的 commit 找不到时先 fetch 一次，仍找不到就抛 INVALID_REF 并点名**来源仓库**', () => {
    const { dir } = makeRepoWithCommit('aieval-git-src-');
    const cache = join(makeTmp('aieval-ws-'), 'cases', 'c-1', 'cache');
    ensureCaseCache(dir, cache, null);
    // 造一个「来源仓库有、缓存没有、fetch 也拿不到」的提交：提交后把来源 reset 回去，
    // 它不再被任何分支指向（本机实测：本地路径 fetch 不会带上它，缓存里 `cat-file -e` 退出码非 0）
    writeFileSync(join(dir, 'orphan.txt'), 'orphan\n', 'utf8');
    git(dir, 'add', 'orphan.txt');
    git(dir, 'commit', '-q', '-m', '孤儿提交');
    const orphan = git(dir, 'rev-parse', 'HEAD').trim();
    git(dir, 'reset', '-q', '--hard', 'HEAD~1');

    let caught: unknown;
    try {
      ensureCaseCache(dir, cache, orphan);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ServiceError);
    expect((caught as ServiceError).code).toBe('INVALID_REF');
    // 消息点名**来源仓库路径**（用例就是拿它校验 hash 的，行工作区路径会把人指错方向），并说清试过什么。
    // 注意比的是 realpath：来源记录与错误文案里的路径都归一成真实路径（同一个仓库的不同写法要判等）
    const source = realpathSync(dir);
    expect((caught as Error).message).toContain(source);
    expect((caught as Error).message).toContain('git fetch');
    expect((caught as ServiceError).context).toMatchObject({ repoPath: source, cacheDir: cache, commitHash: orphan });
  });
});

describe('copyWorkspace', () => {
  it('文件系统级复制带上了 .git（否则复制出来的目录没法 checkout）', () => {
    const { dir, commit } = makeRepoWithCommit('aieval-git-src-');
    const dest = join(makeTmp('aieval-ws-'), 'rows', 'row-1', 'workspace');
    copyWorkspace(dir, dest);
    expect(existsSync(join(dest, '.git'))).toBe(true);
    expect(git(dest, 'rev-parse', 'HEAD').trim()).toBe(commit);
  });

  it('复制出的目录是独立仓库：在副本里提交不影响源仓库', () => {
    const { dir } = makeRepoWithCommit('aieval-git-src-');
    const dest = join(makeTmp('aieval-ws-'), 'workspace');
    copyWorkspace(dir, dest);
    writeFileSync(join(dest, 'b.txt'), 'b\n', 'utf8');
    git(dest, 'add', 'b.txt');
    git(dest, 'commit', '-q', '-m', '副本里的提交');
    expect(git(dir, 'status', '--porcelain').trim()).toBe('');
  });

  it('目标父目录不存在时自动创建', () => {
    const { dir } = makeRepoWithCommit('aieval-git-src-');
    const dest = join(makeTmp('aieval-ws-'), 'a', 'b', 'workspace');
    copyWorkspace(dir, dest);
    expect(existsSync(join(dest, 'a.txt'))).toBe(true);
  });

  it('缓存状态损坏（目录在但没有 .git）时报 INTERNAL：NOT_A_GIT_REPO 留给用户填的仓库路径', () => {
    // srcDir 是**我们自己**建的用例缓存（被手工删了 .git / 克隆中途失败），不是用户在用例里填的仓库路径。
    // 报 NOT_A_GIT_REPO 会让用户去改用例里的仓库路径——方向完全错（该删的是这个缓存目录）。
    const broken = join(makeTmp('aieval-git-broken-'), 'cache');
    mkdirSync(broken, { recursive: true });
    let caught: unknown;
    try {
      copyWorkspace(broken, join(makeTmp('aieval-ws-'), 'workspace'));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ServiceError);
    expect((caught as ServiceError).code).toBe('INTERNAL');
    expect((caught as Error).message).toContain('缓存');
  });
});
