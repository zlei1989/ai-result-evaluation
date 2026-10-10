// @vitest-environment node
/**
 * isGitRepo
 *
 * 本文件是 `git.repo.test.ts` 拆分后的一块：真实临时仓库模板、`git()` 助手与清理钩子都在 `./testing/git-repo-harness`（那里也写明了钩子为什么必须是显式注册的函数）。
 */
import { describe, expect, it } from 'vitest';
import {
  makeTmp,
  git,
  makeRepo,
  makeRepoWithCommit,
  mkdirSync,
  writeFileSync,
  tmpdir,
  basename,
  join,
  ServiceError,
  assertCommit,
  isGitRepo,
  listCommits,
  resolveRepoInfo,
  registerGitRepoHooks,
} from './testing/git-repo-harness';



registerGitRepoHooks();

describe('isGitRepo', () => {
  it('仓库内为 true、普通目录为 false、不存在的路径为 false（抛错一律折成 false）', () => {
    const repo = makeRepoWithCommit('aieval-git-');
    expect(isGitRepo(repo.dir)).toBe(true);
    expect(isGitRepo(makeTmp('aieval-git-plain-'))).toBe(false);
    expect(isGitRepo(join(tmpdir(), 'aieval-does-not-exist-9f3a'))).toBe(false);
  });

  it('仓库的子目录也算在仓库内（`--is-inside-work-tree` 的语义）', () => {
    const { dir } = makeRepoWithCommit('aieval-git-');
    const sub = join(dir, 'src');
    mkdirSync(sub);
    expect(isGitRepo(sub)).toBe(true);
  });

  it('裸仓库不算工作树（本工具的每行工作区必须能 checkout）', () => {
    const bare = makeTmp('aieval-bare-');
    git(bare, 'init', '-q', '--bare');
    expect(isGitRepo(bare)).toBe(false);
  });
});

describe('resolveRepoInfo', () => {
  it('回显仓库名与当前分支', () => {
    const { dir } = makeRepoWithCommit('aieval-git-');
    const info = resolveRepoInfo(dir);
    expect(info.repoName).toBe(basename(dir));
    expect(info.repoPath).toBe(dir);
    // 分支名取的就是 git 自己报的那个：不断言 master / main——
    // 默认分支名受 `init.defaultBranch` 影响，写死会让测试在不同机器上红
    expect(info.branch).toBe(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD').trim());
    expect(info.branch.length).toBeGreaterThan(0);
  });

  it('仓库名取的是仓库根目录名，而不是传入路径的最后一段（传子目录也得到同一个仓库名）', () => {
    const { dir } = makeRepoWithCommit('aieval-git-');
    const sub = join(dir, 'packages');
    mkdirSync(sub);
    expect(resolveRepoInfo(sub).repoName).toBe(basename(dir));
  });

  it('resolveRepoInfo 回显本地来源的常量字段（RepoInfo 契约要求齐全）', () => {
    const { dir } = makeRepoWithCommit('aieval-git-');
    expect(resolveRepoInfo(dir)).toMatchObject({
      kind: 'local',
      mirrorPath: null,
      mirrorReady: false,
      mirrorFetchedAt: null,
      tip: null,
    });
  });

  it('路径不存在时报 NOT_A_GIT_REPO 且不代表 git 去猜（含路径与中文原因）', () => {
    const missing = join(tmpdir(), 'aieval-missing-7c1e');
    let caught: unknown;
    try {
      resolveRepoInfo(missing);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ServiceError);
    expect((caught as ServiceError).code).toBe('NOT_A_GIT_REPO');
    expect((caught as Error).message).toContain(missing);
    expect((caught as Error).message).toContain('不存在');
  });

  it('普通目录报 NOT_A_GIT_REPO 并带上 git 的原文（排查要靠它区分「不是仓库」与「git 坏了」）', () => {
    const plain = makeTmp('aieval-git-plain-');
    // 先把 git 自己对这条命令的原文抓下来：断言必须比对一个**真实的** git 输出。
    // 既不能写死英文串（git 的文案随语言环境变），也不能只断言中文前缀——
    // 那样「reason 用一句恒定中文」的实现会照样变绿，这条用例就守不住 gitMessage（review 重要 #2d）。
    let gitStderr = '';
    try {
      git(plain, 'rev-parse', '--is-inside-work-tree');
    } catch (error) {
      gitStderr = String((error as { stderr?: unknown }).stderr ?? '').trim();
    }
    expect(gitStderr).not.toBe('');

    let caught: unknown;
    try {
      resolveRepoInfo(plain);
    } catch (error) {
      caught = error;
    }
    expect((caught as ServiceError).code).toBe('NOT_A_GIT_REPO');
    expect((caught as Error).message).toContain(plain);
    expect((caught as Error).message).toContain('不是 git 仓库');
    expect((caught as Error).message).toContain(gitStderr);
  });
});

describe('assertCommit', () => {
  it('返回完整 40 位 hash（短 hash 也能被解析成全量）', () => {
    const { dir, commit } = makeRepoWithCommit('aieval-git-');
    expect(assertCommit(dir, commit)).toBe(commit);
    expect(assertCommit(dir, commit.slice(0, 7))).toBe(commit);
    expect(assertCommit(dir, commit)).toHaveLength(40);
  });

  it('不存在的 hash 报 INVALID_REF，且 message 同时含 hash 与仓库路径', () => {
    const { dir } = makeRepoWithCommit('aieval-git-');
    let caught: unknown;
    try {
      assertCommit(dir, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef');
    } catch (error) {
      caught = error;
    }
    expect((caught as ServiceError).code).toBe('INVALID_REF');
    expect((caught as Error).message).toContain('deadbeef');
    expect((caught as Error).message).toContain(dir);
  });

  it('空 hash 报 INVALID_REF（空串不是「用 HEAD」，那是 null 的语义）', () => {
    const { dir } = makeRepoWithCommit('aieval-git-');
    let caught: unknown;
    try {
      assertCommit(dir, '');
    } catch (error) {
      caught = error;
    }
    expect((caught as ServiceError).code).toBe('INVALID_REF');
  });

  /**
   * `^{commit}` 的判据：**blob / tree 的 hash 不算「存在」**。
   * 这条守卫钉的是 `rev-parse --verify <hash>^{commit}` 里那个后缀（早先是 `cat-file -e` 的同一后缀）——
   * 去掉它，一个文件的 hash 也会被当成可 checkout 的 commit，失败点被推到 checkout 那一步，
   * 错误码与中文原因都指向完全无关的方向。
   */
  it('blob 的 hash 不算「存在」：报 INVALID_REF，且中文原因与 git 原文都可读', () => {
    const { dir } = makeRepoWithCommit('aieval-git-');
    const blob = git(dir, 'rev-parse', 'HEAD:a.txt').trim();
    expect(blob).toHaveLength(40);
    let caught: unknown;
    try {
      assertCommit(dir, blob);
    } catch (error) {
      caught = error;
    }
    const error = caught as ServiceError;
    expect(error.code).toBe('INVALID_REF');
    expect(error.message).toContain('commit 不存在');
    // `context.gitMessage` 必须非空：`rev-parse --quiet` 会把 stderr 一起吃掉，
    // 那样「hash 不存在」与「仓库坏了 / index.lock 被占」就再也分不开了
    expect(String((error.context as { gitMessage?: string } | undefined)?.gitMessage ?? '')).not.toBe('');
  });
});

describe('listCommits', () => {
  it('默认 20 条、按时间倒序、hash 是短哈希且 subject 逐字来自提交信息', () => {
    const dir = makeRepo('aieval-git-log-');
    for (let index = 1; index <= 3; index += 1) {
      writeFileSync(join(dir, `f${index}.txt`), `${index}\n`, 'utf8');
      git(dir, 'add', '.');
      git(dir, 'commit', '-q', '-m', `第 ${index} 次提交`);
    }
    const commits = listCommits(dir);
    expect(commits).toHaveLength(3);
    expect(commits[0]?.subject).toBe('第 3 次提交');
    // 短哈希：断言「是 HEAD 的前缀且比全量短」，**不**断言长度 7——实现刻意不钉 `core.abbrev`
    // （git 的 auto 会在超出 7 位才唯一的大仓库里自动加长，钉死 7 会让界面上的短哈希变歧义、
    // 用户拿它当 commitHash 反而解析不了），所以长度由机器的 git 配置决定（review 重要 #3：
    // 用户设了 `core.abbrev=12` 时，`toHaveLength(7)` 这条必红而实现并没有错）。
    const fullHash = git(dir, 'rev-parse', 'HEAD').trim();
    expect(fullHash.startsWith(commits[0]?.hash ?? '')).toBe(true);
    expect((commits[0]?.hash ?? '').length).toBeLessThan(fullHash.length);
    expect(commits[2]?.subject).toBe('第 1 次提交');
  });

  it('limit 生效（最近 20 条）', () => {
    const dir = makeRepo('aieval-git-log-');
    for (let index = 1; index <= 3; index += 1) {
      writeFileSync(join(dir, `f${index}.txt`), `${index}\n`, 'utf8');
      git(dir, 'add', '.');
      git(dir, 'commit', '-q', '-m', `第 ${index} 次提交`);
    }
    expect(listCommits(dir, 2).map((c) => c.subject)).toEqual(['第 3 次提交', '第 2 次提交']);
  });

  it('空仓库返回空数组而不是抛错（首次提交前也能打开用例表单）', () => {
    const dir = makeRepo('aieval-git-empty-');
    expect(listCommits(dir)).toEqual([]);
  });

  it('listCommits 不给 ref 时行为不变（读 HEAD），给了 ref 时读该 ref 的历史', () => {
    const dir = makeRepo('aieval-git-log-');
    for (let index = 1; index <= 2; index += 1) {
      writeFileSync(join(dir, `f${index}.txt`), `${index}\n`, 'utf8');
      git(dir, 'add', '.');
      git(dir, 'commit', '-q', '-m', `第 ${index} 次提交`);
    }
    expect(listCommits(dir, 20).length).toBe(2);
    expect(listCommits(dir, 1, 'HEAD~1')[0]?.subject).toBe('第 1 次提交');
  });
});
