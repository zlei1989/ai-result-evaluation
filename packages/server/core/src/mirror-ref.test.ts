// @vitest-environment node
/**
 * resolveRemoteRef
 *
 * 本文件是 `mirror.test.ts` 拆分后的一块：真实 git / 裸仓库 / 静默远端等夹具与 `waitForConnection` 都在 `./testing/mirror-harness`（那里也写明了钩子为什么必须是显式注册的函数）。
 */

import { describe, expect, it } from 'vitest';
import {
  makeTmp,
  git,
  makeOriginRepo,
  hashOf,
  renameOriginDefaultBranch,
  REMOTE_FIXTURE_TIMEOUT_MS,
  FAST_FAILURE_PROBE_TIMEOUT_MS,
  renameSync,
  writeFileSync,
  join,
  defaultBranchName,
  ensureMirror,
  fetchMirror,
  probeRemote,
  resolveRemoteRef,
  registerMirrorHooks,
} from './testing/mirror-harness';



registerMirrorHooks();

describe('resolveRemoteRef', () => {
  it('三条路都回 40 位具体 hash：指定分支 / 默认分支 / 指定 commit', () => {
    const root = makeTmp('aieval-mirror-');
    const workspaceRoot = join(root, 'runs');
    const origin = makeOriginRepo(root, ['feat/x']);
    const { mirrorDir: dir } = ensureMirror({ workspaceRoot, url: origin.url });

    expect(resolveRemoteRef(dir, origin.url, { branch: null, commitHash: null })).toBe(hashOf(origin, 'main'));
    expect(resolveRemoteRef(dir, origin.url, { branch: 'feat/x', commitHash: null })).toBe(hashOf(origin, 'feat/x'));
    // commit 优先于分支
    expect(resolveRemoteRef(dir, origin.url, { branch: 'feat/x', commitHash: hashOf(origin, 'main') })).toBe(hashOf(origin, 'main'));
    expect(defaultBranchName(dir)).toBe('main');
  });

  it('默认分支跟随远端前进（fetch 后重新解析到新 tip；fetch:false 读镜像现状且不联网）', () => {
    const root = makeTmp('aieval-mirror-');
    const workspaceRoot = join(root, 'runs');
    const origin = makeOriginRepo(root);
    const { mirrorDir: dir } = ensureMirror({ workspaceRoot, url: origin.url });

    const work2 = join(root, 'work2');
    git(root, ['clone', '-q', origin.url, work2]);
    writeFileSync(join(work2, 'b.txt'), 'b\n', 'utf8');
    git(work2, ['add', '.']);
    git(work2, ['commit', '-q', '-m', 'second']);
    const tip = git(work2, ['rev-parse', 'HEAD']).trim();
    git(work2, ['push', '-q', 'origin', 'HEAD:main']);

    // 先问 fetch:false：此刻镜像还是克隆那一刻的旧值——候选列表那条路要的就是「不联网、读现状」。
    // 这一步必须在默认那条路**之前**：默认那条会 fetch，一问过镜像就前进到 tip，旧值再也读不到了。
    expect(resolveRemoteRef(dir, origin.url, { branch: null, commitHash: null, fetch: false })).toBe(hashOf(origin, 'main'));
    expect(resolveRemoteRef(dir, origin.url, { branch: null, commitHash: null })).toBe(tip);

    // 「fetch:false 不联网」的直接证据：来源被移走也照样回镜像现状（默认那条路此时必抛 NOT_A_GIT_REPO，
    // 见「钉死的 commit 已在镜像里」那条用例）——这正是候选列表要的语义
    renameSync(origin.bareDir, `${origin.bareDir}.moved`);
    expect(resolveRemoteRef(dir, origin.url, { branch: null, commitHash: null, fetch: false })).toBe(tip);
  });








});


/**
 * 最终整支复审 Important 1：**远端默认分支改名**（main → trunk）之后镜像要能自愈。
 *
 * 为什么这是一条独立的守卫：本机 git 2.47 实测 `git -C <mirror> fetch --prune origin` **不会**刷新
 * 镜像的 HEAD 符号引用（被删的 ref 它倒是会剪掉）。于是远端改名 + 删旧分支之后，镜像 HEAD 停在
 * 一个**已经不存在的**分支上，而 `defaultBranchName` 读出来的还是旧名字：校验 / 候选 /
 * 每一轮 `repoBranch: null` 的评测都以「无法解析远端默认分支：main」失败——一份完好的仓库被判成
 * 不可用，产品里也没有任何出路（没有人会想到去手工删镜像目录，也没有文案提这件事）。
 * 旧分支若还活着则更隐蔽：不报错，只是**静默**一直跟着旧默认分支，而界面与 README 都声称跟随远端默认分支。
 */
describe('默认分支改名后的自愈（fetch 不刷新镜像 HEAD）', () => {
  it('远端 main → trunk 且旧分支被删：探活给出新名字，抓取把镜像 HEAD 对齐过去，两条读路径都拿到 trunk tip', () => {
    const root = makeTmp('aieval-mirror-');
    const workspaceRoot = join(root, 'runs');
    const origin = makeOriginRepo(root);
    const { mirrorDir: dir } = ensureMirror({ workspaceRoot, url: origin.url });
    // 前置对照：此刻镜像跟着 main（少了它，下面的断言可能只是「本来就没跟着」）
    expect(defaultBranchName(dir)).toBe('main');

    const trunkTip = renameOriginDefaultBranch(root, origin.bareDir, 'trunk');

    // ① 探活给出的就是新名字：`validateRepo` 消费的正是这一个值（它现在有消费者了）
    expect(probeRemote(origin.url, { cwd: root, timeoutMs: FAST_FAILURE_PROBE_TIMEOUT_MS }).defaultBranch).toBe('trunk');

    // ② 走校验那条路：探活拿到的名字交给抓取去对齐镜像 HEAD（已知值 → 不再多问一次远端）
    fetchMirror(dir, origin.url, { defaultBranch: 'trunk' });
    expect(defaultBranchName(dir)).toBe('trunk');
    expect(git(dir, ['rev-parse', 'refs/heads/trunk']).trim()).toBe(trunkTip);
    // fetch --prune 确实把旧分支剪掉了：所以「HEAD 还指着 main」不是无关紧要的陈旧，
    // 而是一条**指向不存在分支**的 HEAD（下面两条断言才是修复前真正会红的那两条）
    expect(() => git(dir, ['rev-parse', 'refs/heads/main'])).toThrow();

    // ③ 每一轮 `repoBranch: null` 的评测拿到的基线 = **新**默认分支的 tip
    //（orchestrator.ts 里那一行调用：branch: run.repoBranch ?? null、commitHash: run.commitHash）。
    // 这条路上没人给它探活结果——镜像得自己问出远端当前的默认分支，这正是 fetchMirror 里那次对齐
    expect(resolveRemoteRef(dir, origin.url, { branch: null, commitHash: null })).toBe(trunkTip);
    // ④ 候选列表那条**离线**读路径读到的是同一个名字（不再对着一个死分支报「无法解析远端默认分支」）
    expect(resolveRemoteRef(dir, origin.url, { branch: null, commitHash: null, fetch: false })).toBe(trunkTip);
  }, REMOTE_FIXTURE_TIMEOUT_MS);
});
