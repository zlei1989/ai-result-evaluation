// @vitest-environment node
/**
 * 用例仓库的 git 原语：仓库根判定、状态分类、**逐文件提交**、远端对齐与推送。
 *
 * 两条最要紧的守卫：
 *   1. **不是仓库根就不认**（`isRepoRoot`）：只判「在某个仓库里」会把用户家目录下的大仓库当成用例仓库；
 *   2. **绝不 force push**——一条行为守卫（分叉时 push 必须被远端拒绝、远端历史一个提交都不许变）
 *      加一条源码守卫（剥掉注释后，源码里不存在任何 force 写法）。行为守卫挡的是「真推上去了」，
 *      源码守卫挡的是「有人把 force 加回来」。
 *
 * 一律用 mkdtemp 出来的**真实 git 仓库**（本地裸仓库当远端，不联网）：git 原语不许 mock——
 * mock 掉的正是最容易错的地方。
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ServiceError } from '@aieval/contracts';
import {
  aheadBehind,
  commitFile,
  currentBranch,
  fastForwardToUpstream,
  fetchRemote,
  headCommit,
  isRepoRoot,
  listCommitsSince,
  pathStatusCode,
  pushRemote,
  readWorktreeState,
  remoteNames,
  upstreamRef,
} from './case-git';
import { removeTreeWithRetry } from './testing/cleanup';

/** 跑一条 git 命令：身份用 -c 显式给，不依赖宿主机的 user.name / user.email */
function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args], {
    cwd,
    encoding: 'utf8',
  });
}

let dir: string;
/** 用例仓库（本地，带 origin 指向下面的裸仓库） */
let root: string;
/** 裸远端 */
let bare: string;

/** 造一个用例文件（内容不重要，git 只关心路径与变更） */
function writeCaseFile(path: string, title: string): void {
  writeFileSync(path, `${JSON.stringify({ id: title, title }, null, 2)}\n`, 'utf8');
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aieval-case-git-'));
  root = join(dir, 'cases');
  bare = join(dir, 'origin.git');
  mkdirSync(root, { recursive: true });
  git(root, ['init', '-q', '-b', 'main']);
  writeFileSync(join(root, 'README.md'), '# 用例仓库\n', 'utf8');
  git(root, ['add', '.']);
  git(root, ['commit', '-q', '-m', '初始提交']);
  git(dir, ['init', '-q', '--bare', '-b', 'main', bare]);
  git(root, ['remote', 'add', 'origin', bare]);
  git(root, ['push', '-q', '-u', 'origin', 'main']);
});

afterEach(() => {
  removeTreeWithRetry(dir);
});

describe('仓库根判定与基础读取', () => {
  it('只认「目录本身就是仓库根」：子目录不是（否则家目录下的大仓库会被认领）', () => {
    expect(isRepoRoot(root)).toBe(true);

    const sub = join(root, 'nested');
    mkdirSync(sub, { recursive: true });
    expect(isRepoRoot(sub)).toBe(false);

    const plain = join(dir, 'plain');
    mkdirSync(plain, { recursive: true });
    expect(isRepoRoot(plain)).toBe(false);
    expect(isRepoRoot(join(dir, 'not-exist'))).toBe(false);
  });

  it('远端名 / 上游 / 分支 / HEAD 都读得出来', () => {
    expect(remoteNames(root)).toEqual(['origin']);
    expect(upstreamRef(root)).toBe('origin/main');
    expect(currentBranch(root)).toBe('main');
    expect(headCommit(root)).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe('工作区状态分类', () => {
  it('根目录下的 <合法 id>.json 才算用例文件，其余算无关变更', () => {
    writeCaseFile(join(root, 'c-1.json'), '用例一');
    // 无关变更四类：已跟踪文件被改、普通未跟踪文件、子目录、文件名不合 id 形状
    writeFileSync(join(root, 'README.md'), '# 改过\n', 'utf8');
    writeFileSync(join(root, 'note.txt'), '笔记\n', 'utf8');
    mkdirSync(join(root, 'sub'), { recursive: true });
    writeCaseFile(join(root, 'sub', 'c-2.json'), '子目录里的');
    writeCaseFile(join(root, 'bad name.json'), '名字带空格');

    const state = readWorktreeState(root);

    expect(state.caseFiles).toEqual(['c-1.json']);
    // 计数只要求「都数进来了」：未跟踪目录在 porcelain 里可能合成一条，故不钉精确值
    expect(state.ignoredCount).toBeGreaterThanOrEqual(4);
  });

  it('路径状态码分得出新增 / 更新 / 已删，干净时是 null', () => {
    writeCaseFile(join(root, 'c-1.json'), '用例一');
    expect(pathStatusCode(root, 'c-1.json')).toBe('??');

    commitFile(root, 'c-1.json', '新增用例「用例一」');
    expect(pathStatusCode(root, 'c-1.json')).toBeNull();

    rmSync(join(root, 'c-1.json'));
    expect(pathStatusCode(root, 'c-1.json')).toContain('D');
  });
});

describe('逐文件提交', () => {
  it('一次只提交一个文件，且提交只碰这一个文件', () => {
    const base = headCommit(root)!;
    writeCaseFile(join(root, 'c-1.json'), '用例一');
    writeCaseFile(join(root, 'c-2.json'), '用例二');

    expect(commitFile(root, 'c-1.json', '新增用例「用例一」')).toBe(true);
    expect(commitFile(root, 'c-2.json', '新增用例「用例二」')).toBe(true);

    const commits = listCommitsSince(root, base);
    expect(commits).toHaveLength(2);
    for (const commit of commits) expect(commit.files).toHaveLength(1);
    // 两条提交各碰一个文件：顺序与内容都对得上
    expect(commits.map((commit) => commit.files[0]).sort()).toEqual(['c-1.json', 'c-2.json']);
    expect(git(root, ['log', '--format=%s', '-2']).trim().split('\n')).toEqual([
      '新增用例「用例二」',
      '新增用例「用例一」',
    ]);
  });

  it('文件没有变更时什么都不做（不产生空提交）', () => {
    const base = headCommit(root)!;
    writeCaseFile(join(root, 'c-1.json'), '用例一');
    expect(commitFile(root, 'c-1.json', '新增用例「用例一」')).toBe(true);

    expect(commitFile(root, 'c-1.json', '再来一次')).toBe(false);
    expect(headCommit(root)).toBe(git(root, ['rev-parse', 'HEAD']).trim());
    expect(listCommitsSince(root, base)).toHaveLength(1);
  });

  it('删除用例文件也进历史（工作区里不再有它）', () => {
    const base = headCommit(root)!;
    writeCaseFile(join(root, 'c-1.json'), '用例一');
    commitFile(root, 'c-1.json', '新增用例「用例一」');
    const afterAdd = headCommit(root)!;

    rmSync(join(root, 'c-1.json'));
    expect(commitFile(root, 'c-1.json', '删除用例「用例一」')).toBe(true);

    const commits = listCommitsSince(root, afterAdd);
    expect(commits).toHaveLength(1);
    expect(commits[0]?.files).toEqual(['c-1.json']);
    expect(listCommitsSince(root, base)).toHaveLength(2);
  });

  it('只提交点名的文件：同时改过的无关文件不进历史', () => {
    writeFileSync(join(root, 'README.md'), '# 改过\n', 'utf8');
    writeCaseFile(join(root, 'c-1.json'), '用例一');

    commitFile(root, 'c-1.json', '新增用例「用例一」');

    const latest = listCommitsSince(root, null)[0];
    expect(latest?.files).toEqual(['c-1.json']);
    // README 的改动还在工作区里（没被顺手卷进提交）
    expect(pathStatusCode(root, 'README.md')).not.toBeNull();
  });
});

describe('远端：推送、快进与「绝不 force push」', () => {
  it('推送把本地提交送到远端，推完不再领先', () => {
    expect(aheadBehind(root)).toEqual({ ahead: 0, behind: 0 });

    writeCaseFile(join(root, 'c-1.json'), '用例一');
    commitFile(root, 'c-1.json', '新增用例「用例一」');
    expect(aheadBehind(root)).toEqual({ ahead: 1, behind: 0 });

    pushRemote(root);

    expect(aheadBehind(root)).toEqual({ ahead: 0, behind: 0 });
    expect(git(bare, ['log', '--format=%s', '-1']).trim()).toBe('新增用例「用例一」');
  });

  it('落后时快进到远端', () => {
    // 另一个克隆推一个提交到远端（模拟「同事改了用例」）
    const other = join(dir, 'other');
    git(dir, ['clone', '-q', bare, other]);
    writeCaseFile(join(other, 'c-2.json'), '别人加的');
    git(other, ['add', '.']);
    git(other, ['commit', '-q', '-m', '别人加的用例']);
    git(other, ['push', '-q', 'origin', 'main']);

    fetchRemote(root);
    expect(aheadBehind(root)).toEqual({ ahead: 0, behind: 1 });

    fastForwardToUpstream(root);

    expect(aheadBehind(root)).toEqual({ ahead: 0, behind: 0 });
    expect(readWorktreeState(root).caseFiles).toEqual([]);
  });

  /**
   * **这一条是「绝不 force push」的行为守卫**：远端有别人的提交、本地也有未推送的提交（分叉）时，
   * `pushRemote` 必须被远端**拒绝**（non-fast-forward），并且远端历史一个字节都不变。
   * 把 `--force` 加回 `pushRemote`（变异体）之后，这条会以「远端那个提交被抹掉了」失败。
   */
  it('分叉时 push 被拒绝，远端历史与本地提交都不动（绝不 force push）', () => {
    const other = join(dir, 'other');
    git(dir, ['clone', '-q', bare, other]);
    writeCaseFile(join(other, 'c-2.json'), '别人的');
    git(other, ['add', '.']);
    git(other, ['commit', '-q', '-m', '别人的用例']);
    git(other, ['push', '-q', 'origin', 'main']);
    const remoteHead = git(bare, ['rev-parse', 'HEAD']).trim();

    writeCaseFile(join(root, 'c-1.json'), '我的');
    commitFile(root, 'c-1.json', '我的用例');
    const localHead = headCommit(root)!;

    fetchRemote(root);
    expect(aheadBehind(root)).toEqual({ ahead: 1, behind: 1 });

    let caught: unknown;
    try {
      pushRemote(root);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ServiceError);
    expect((caught as ServiceError).code).toBe('INTERNAL');
    // 远端没动（别人的提交还在），本地那个提交也还在（不是回滚、是保留等下一次）
    expect(git(bare, ['rev-parse', 'HEAD']).trim()).toBe(remoteHead);
    expect(headCommit(root)).toBe(localHead);
  });

  /**
   * 源码守卫：`case-git.ts` 剥掉注释后不许出现任何 force 写法。
   * 为什么要剥注释：文件头**正文明说**「本文件不出现 `--force`」，不剥就永远红。
   * 判据是「调用参数里有没有 force 变体」，故只盯 `--force*`、作为独立参数的 `-f`、以及 `+refs` 形式的 refspec。
   */
  it('源码里不存在任何 force push 写法（--force / -f / +refs）', () => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'case-git.ts'), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

    expect(code).not.toMatch(/--force/);
    expect(code).not.toMatch(/['"]-f['"]/);
    expect(code).not.toMatch(/['"]\+[^'"]*refs/);
    // 反向对照：文件确实被读到了（不是读了个空串让上面三条恒真）
    expect(code).toContain('pushRemote');
    expect(code).toMatch(/\[['"]push['"]\]/);
  });
});
