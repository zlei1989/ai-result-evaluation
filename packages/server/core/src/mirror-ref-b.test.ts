// @vitest-environment node
/**
 * resolveRemoteRef（切分后的第二块）
 *
 * 本文件是 `mirror.test.ts` 拆分后的一块：真实 git / 裸仓库 / 静默远端等夹具与 `waitForConnection` 都在 `./testing/mirror-harness`（那里也写明了钩子为什么必须是显式注册的函数）。
 */

import { describe, expect, it } from 'vitest';
import {
  makeTmp,
  git,
  makeOriginRepo,
  hashOf,
  caughtOf,
  codeOf,
  messageOf,
  renameSync,
  join,
  ServiceError,
  ensureMirror,
  resolveRemoteRef,
  registerMirrorHooks,
} from './testing/mirror-harness';



registerMirrorHooks();

describe('resolveRemoteRef', () => {
  it('commit 不存在（fetch 后仍无）→ INVALID_REF，文案说明已 fetch', () => {
    const root = makeTmp('aieval-mirror-');
    const workspaceRoot = join(root, 'runs');
    const origin = makeOriginRepo(root);
    const { mirrorDir: dir } = ensureMirror({ workspaceRoot, url: origin.url });
    const orphan = '0'.repeat(40);

    expect(codeOf(() => resolveRemoteRef(dir, origin.url, { branch: null, commitHash: orphan }))).toBe('INVALID_REF');
    expect(messageOf(() => resolveRemoteRef(dir, origin.url, { branch: null, commitHash: orphan }))).toContain('git fetch');
  });
  it('给的 hash 不是 commit（树对象）→ INVALID_REF，不能把裸 git 报错漏出去', () => {
    const root = makeTmp('aieval-mirror-');
    const workspaceRoot = join(root, 'runs');
    const origin = makeOriginRepo(root);
    const { mirrorDir: dir } = ensureMirror({ workspaceRoot, url: origin.url });
    // 树对象确实**在**镜像里：判据里少了 `^{commit}` 就会把「存在」判成通过，
    // 接着 rev-parse 抛出的裸错会一路漏到调用方（assertCommit 用同一口径拦这件事）
    const tree = git(dir, ['rev-parse', `${hashOf(origin, 'main')}^{tree}`]).trim();

    expect(codeOf(() => resolveRemoteRef(dir, origin.url, { branch: null, commitHash: tree }))).toBe('INVALID_REF');
  });
  it('钉死的 commit 已在镜像里 → 不联网（把来源移走也能解析出基线）', () => {
    const root = makeTmp('aieval-mirror-');
    const workspaceRoot = join(root, 'runs');
    const origin = makeOriginRepo(root);
    const { mirrorDir: dir } = ensureMirror({ workspaceRoot, url: origin.url });
    renameSync(origin.bareDir, `${origin.bareDir}.moved`);

    // 与 ensureCaseCache「缓存里有就不 fetch」同口径：已经能确定起点的一轮不该因为远端临时不可达而失败
    expect(resolveRemoteRef(dir, origin.url, { branch: null, commitHash: hashOf(origin, 'main') })).toBe(hashOf(origin, 'main'));
    // 但「跟随分支 / 默认分支」要求新鲜度，来源不可达时必须抛（RG10：绝不静默沿用旧镜像）。
    // 码是 NOT_A_GIT_REPO 而不是 REPO_UNREACHABLE：移走的 file:// 路径在 git 原文里是
    // `does not appear to be a git repository`，spec §8.1 把它归成「远端不存在」，
    // 处置是改地址而不是查网络（REPO_UNREACHABLE 的覆盖在 fetchMirror / classifyRemoteFailure 那两处）
    expect(codeOf(() => resolveRemoteRef(dir, origin.url, { branch: null, commitHash: null }))).toBe('NOT_A_GIT_REPO');
    expect(codeOf(() => resolveRemoteRef(dir, origin.url, { branch: 'feat/x', commitHash: null }))).toBe('NOT_A_GIT_REPO');
  });
  it('注入的 timeoutMs 落在抓取上（1ms 上限 → 抓取被墙钟杀掉）', () => {
    const root = makeTmp('aieval-mirror-');
    const workspaceRoot = join(root, 'runs');
    const origin = makeOriginRepo(root);
    const { mirrorDir: dir } = ensureMirror({ workspaceRoot, url: origin.url });

    // 1ms：起一个 git 进程都不止这点时间，与机器快慢无关。分支/默认分支这条路要求新鲜度 → 必先 fetch，
    // 所以「上限有没有真的转给 fetch」只有这里看得见：不转发时这次抓取会正常成功并回一个 hash。
    expect(codeOf(() => resolveRemoteRef(dir, origin.url, { branch: null, commitHash: null, timeoutMs: 1 }))).toBe('REPO_UNREACHABLE');
  });
  it('注入的 timeoutMs 也落在 commit 那条路的抓取上（抓取被杀 → 不可达，不是「commit 不存在」）', () => {
    const root = makeTmp('aieval-mirror-');
    const workspaceRoot = join(root, 'runs');
    const origin = makeOriginRepo(root);
    const { mirrorDir: dir } = ensureMirror({ workspaceRoot, url: origin.url });

    // 镜像里没有这个 commit → 抓一次再判。抓取被墙钟杀掉时必须报「不可达」：
    // 拿「没抓到」去说「commit 不存在」是把用户指向错误的处置方向（RG10）
    const caught = caughtOf(() =>
      resolveRemoteRef(dir, origin.url, { branch: null, commitHash: '0'.repeat(40), timeoutMs: 1 }),
    );
    expect(caught).toBeInstanceOf(ServiceError);
    expect((caught as ServiceError).code).toBe('REPO_UNREACHABLE');
  });
});
