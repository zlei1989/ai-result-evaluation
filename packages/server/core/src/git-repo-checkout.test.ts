// @vitest-environment node
/**
 * checkoutRow
 *
 * 本文件是 `git.repo.test.ts` 拆分后的一块：真实临时仓库模板、`git()` 助手与清理钩子都在 `./testing/git-repo-harness`（那里也写明了钩子为什么必须是显式注册的函数）。
 */
import { describe, expect, it } from 'vitest';
import {
  makeTmp,
  git,
  makeRepo,
  makeRepoWithCommit,
  existsSync,
  writeFileSync,
  join,
  ServiceError,
  checkoutRow,
  copyWorkspace,
  registerGitRepoHooks,
} from './testing/git-repo-harness';



registerGitRepoHooks();

describe('checkoutRow', () => {
  it('建出 test/{rowId} 分支并切换过去，baselineCommit 是 40 位具体 hash（R2）', () => {
    const { dir } = makeRepoWithCommit('aieval-git-src-');
    const workspace = join(makeTmp('aieval-ws-'), 'workspace');
    copyWorkspace(dir, workspace);

    const { baselineCommit } = checkoutRow(workspace, null, 'test/row-1');
    expect(baselineCommit).toHaveLength(40);
    expect(baselineCommit).toBe(git(workspace, 'rev-parse', 'HEAD').trim());
    expect(git(workspace, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('test/row-1');
  });

  it('给定 commit 时落到那个 commit 上（而不是默认分支 HEAD）', () => {
    const dir = makeRepo('aieval-git-two-');
    writeFileSync(join(dir, 'first.txt'), '1\n', 'utf8');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', '第一次');
    const firstCommit = git(dir, 'rev-parse', 'HEAD').trim();
    writeFileSync(join(dir, 'second.txt'), '2\n', 'utf8');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', '第二次');

    const workspace = join(makeTmp('aieval-ws-'), 'workspace');
    copyWorkspace(dir, workspace);

    const { baselineCommit } = checkoutRow(workspace, firstCommit, 'test/row-2');
    expect(baselineCommit).toBe(firstCommit);
    expect(existsSync(join(workspace, 'second.txt'))).toBe(false);
  });

  it('分支已存在时重置而不是报错（重跑同一行，spec §10「仍冲突则先删旧分支再建」）', () => {
    const { dir } = makeRepoWithCommit('aieval-git-src-');
    const workspace = join(makeTmp('aieval-ws-'), 'workspace');
    copyWorkspace(dir, workspace);

    checkoutRow(workspace, null, 'test/row-3');
    writeFileSync(join(workspace, 'dirty.txt'), 'x\n', 'utf8');
    git(workspace, 'add', '.');
    git(workspace, 'commit', '-q', '-m', '第一轮 agent 的提交');

    // 第二次：分支已存在且已前移；`-B` 必须把它拉回基线，而不是抛「分支已存在」
    const { baselineCommit, ...rest } = checkoutRow(workspace, null, 'test/row-3');
    expect(rest).toEqual({});
    expect(baselineCommit).toBe(git(dir, 'rev-parse', 'HEAD').trim());
    expect(existsSync(join(workspace, 'dirty.txt'))).toBe(false);
    expect(git(workspace, 'branch', '--list', 'test/row-3').trim().split('\n')).toHaveLength(1);
  });

  it('commit 不存在时报 INVALID_REF，且不留下半成品分支', () => {
    const { dir } = makeRepoWithCommit('aieval-git-src-');
    const workspace = join(makeTmp('aieval-ws-'), 'workspace');
    copyWorkspace(dir, workspace);
    let caught: unknown;
    try {
      checkoutRow(workspace, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', 'test/row-4');
    } catch (error) {
      caught = error;
    }
    expect((caught as ServiceError).code).toBe('INVALID_REF');
    expect(git(workspace, 'branch', '--list', 'test/row-4').trim()).toBe('');
  });
});


/**
 * R20 的两条模糊路径：默认分支唯一这个前提不成立时报 INTERNAL，绝不猜一个。
 * 为什么值得单独守：这是生产流程**走不到**的两条路（p4 的 prepareRowWorkspace 每次都清掉行目录
 * 再复制缓存，副本必然是「一个本地分支 + 行分支」），但也正因为没人走，一旦有人改了
 * 「猜一个候选」的写法，代价是 diff 悄悄变成空、评分模型给出错误的高分——必须由测试钉住。
 */
describe('checkoutRow —— 默认分支不唯一时报错而不是猜（R20）', () => {
  it('除行分支外还有两个本地分支时报 INTERNAL，且 message 逐个列出候选', () => {
    const { dir } = makeRepoWithCommit('aieval-git-ambig-');
    const defaultBranch = git(dir, 'rev-parse', '--abbrev-ref', 'HEAD').trim();
    git(dir, 'branch', 'another');

    const workspace = join(makeTmp('aieval-ws-'), 'workspace');
    copyWorkspace(dir, workspace);
    checkoutRow(workspace, null, 'test/row-ambig');
    writeFileSync(join(workspace, 'dirty.txt'), 'x\n', 'utf8');
    git(workspace, 'add', '.');
    git(workspace, 'commit', '-q', '-m', '第一轮 agent 的提交');

    let caught: unknown;
    try {
      checkoutRow(workspace, null, 'test/row-ambig');
    } catch (error) {
      caught = error;
    }
    expect((caught as ServiceError).code).toBe('INTERNAL');
    // 候选名字要出现在文案里：排查的人得知道是哪几个分支把默认分支弄得不唯一的
    expect((caught as Error).message).toContain(defaultBranch);
    expect((caught as Error).message).toContain('another');
  });

  it('行分支就是唯一的本地分支时报 INTERNAL，而不是把 agent 的提交当成基线', () => {
    const { dir } = makeRepoWithCommit('aieval-git-solo-');
    const workspace = join(makeTmp('aieval-ws-'), 'workspace');
    copyWorkspace(dir, workspace);
    // 传入默认分支自己的名字：HEAD 与行分支同名，排除之后一个候选都不剩
    const onlyBranch = git(dir, 'rev-parse', '--abbrev-ref', 'HEAD').trim();

    let caught: unknown;
    try {
      checkoutRow(workspace, null, onlyBranch);
    } catch (error) {
      caught = error;
    }
    expect((caught as ServiceError).code).toBe('INTERNAL');
    expect((caught as Error).message).toContain(onlyBranch);
  });

  it('别的行分支（同一个 `test/*` 命名空间）不算默认分支候选：重跑不因为它们在而报「不唯一」', () => {
    const { dir } = makeRepoWithCommit('aieval-git-foreign-');
    const workspace = join(makeTmp('aieval-ws-'), 'workspace');
    copyWorkspace(dir, workspace);

    checkoutRow(workspace, null, 'test/row-9');
    // 同一用例下的另一行也建了自己的分支——多候选并行时工作区里就是这个样子
    git(workspace, 'branch', 'test/row-8');
    writeFileSync(join(workspace, 'dirty.txt'), 'x\n', 'utf8');
    git(workspace, 'add', '.');
    git(workspace, 'commit', '-q', '-m', '第一轮 agent 的提交');

    // 重跑：候选里只有默认分支（两个 test/* 都要被排除），故不该抛 INTERNAL，
    // 且必须把分支拉回默认分支 tip（只排自己那一个的实现会在这里报「不唯一」）
    const { baselineCommit } = checkoutRow(workspace, null, 'test/row-9');
    expect(baselineCommit).toBe(git(dir, 'rev-parse', 'HEAD').trim());
    expect(existsSync(join(workspace, 'dirty.txt'))).toBe(false);
  });
});
