// @vitest-environment node
/**
 * validateRepo / listCommitCandidates
 *
 * 本文件是 `cases.test.ts` 拆分后的一块：共享夹具、真实 git 助手与两条 `vi.mock`（node:fs / node:child_process 的计数探针）都在 `./testing/cases-harness`，那里写明了为什么前导块必须在每个文件里逐字重复（vitest 的前置提升只作用于本文件）。
 */

import { vi, describe, expect, it } from 'vitest';
import {
  dir,
  repo,
  makeRepo,
  makeRemoteOrigin,
  REMOTE_FIXTURE_TIMEOUT_MS,
  mkdirSync,
  renameSync,
  join,
  ServiceError,
  listCommitCandidates,
  validateRepo,
  registerCasesHooks,
} from './testing/cases-harness';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, rmSync: vi.fn(actual.rmSync) };
});

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) };
});

registerCasesHooks();

describe('validateRepo / listCommitCandidates', () => {
  it('validateRepo 回显仓库名与当前分支', () => {
    const info = validateRepo({ repoPath: repo, repoBranch: null });

    expect(info.repoPath).toBe(repo);
    expect(info.repoName).toBe('repo');
    expect(info.branch.length).toBeGreaterThan(0);
  });

  it('validateRepo 对非 git 目录抛 NOT_A_GIT_REPO（含原因）', () => {
    const notRepo = join(dir, 'plain-dir');
    mkdirSync(notRepo, { recursive: true });

    let caught: unknown;
    try {
      validateRepo({ repoPath: notRepo, repoBranch: null });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ServiceError);
    expect((caught as ServiceError).code).toBe('NOT_A_GIT_REPO');
  });

  it('listCommitCandidates 返回短哈希 + 提交说明（默认最近 20 条）', () => {
    const commits = listCommitCandidates({ repoPath: repo, repoBranch: null });

    expect(commits).toHaveLength(1);
    expect(commits[0]?.hash).toHaveLength(7);
    expect(commits[0]?.subject).toBe('第 1 次提交');
  });

  it('路径两侧带空白时先 trim（从资源管理器复制路径常带尾部空格）', () => {
    expect(validateRepo({ repoPath: ` ${repo} `, repoBranch: null }).repoName).toBe('repo');
  });
});


/**
 * commit 候选的远端那一半：候选只是**便利**，所以这一步刻意不联网——
 * 镜像在校验时已经更新过，候选列表直接读它。第一条用例把「远端」整体改名就是这个口径的证明：
 * 任何一次真实的联网（fetch / clone / ls-remote）都会在那里失败。
 */
describe('listCommitCandidates（远端来源）', () => {
  it('候选来自镜像：来源被移走后仍列得出来（证明这一步不联网）', () => {
    const origin = makeRemoteOrigin('remote-candidates');
    const expected = listCommitCandidates({ repoPath: origin.url, repoBranch: null });
    expect(expected.length).toBeGreaterThan(0);
    expect(expected[0]?.subject).toBe('第 1 次提交');

    // 把「远端」整体改名：任何联网行为都会在这里失败
    renameSync(join(dir, 'remote-candidates.git'), join(dir, 'remote-candidates.git.moved'));
    expect(listCommitCandidates({ repoPath: origin.url, repoBranch: null })).toEqual(expected);
  }, REMOTE_FIXTURE_TIMEOUT_MS);

  it('填了分支：候选是该分支的历史；分支不存在 → INVALID_REF', () => {
    const origin = makeRemoteOrigin('remote-candidates-branch', ['feat/x']);
    const commits = listCommitCandidates({ repoPath: origin.url, repoBranch: 'feat/x' });
    // 断言两条而不是只看 `[0]`，并且先在夹具里放一个与分支同名的 **tag**（指向更早的提交）：
    // 这两件事合起来才让「`ref` 位置到底交了什么」可观察——把分支名而不是它的 tip hash 传下去时，
    // git 的 ref 解析顺序会命中同名 tag，首条立刻变成那次更早的提交。
    // 「分支名只能出现在 `refs/heads/<branch>` 里」这条口径就钉在这里。
    expect(commits[0]?.hash).toBe(origin.hashes['feat/x']!.slice(0, 7));
    expect(commits[0]?.subject).toBe('feat/x 的提交');
    expect(commits[1]?.subject).toBe('第 1 次提交');
    expect(() => listCommitCandidates({ repoPath: origin.url, repoBranch: 'feat/nope' })).toThrow(/分支不存在/);
  }, REMOTE_FIXTURE_TIMEOUT_MS);

  it('本地来源照旧（不传分支读 HEAD；传分支被拒）', () => {
    const local = makeRepo('local-candidates', 2);
    expect(listCommitCandidates({ repoPath: local.dir, repoBranch: null }).length).toBe(2);
    expect(() => listCommitCandidates({ repoPath: local.dir, repoBranch: 'main' })).toThrow(/不支持分支/);
  });
});
