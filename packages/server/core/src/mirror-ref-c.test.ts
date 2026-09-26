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
  join,
  ServiceError,
  ensureMirror,
  resolveRemoteRef,
  registerMirrorHooks,
} from './testing/mirror-harness';



registerMirrorHooks();

describe('resolveRemoteRef', () => {
  it('分支不存在 → INVALID_REF，文案点名分支与远端', () => {
    const root = makeTmp('aieval-mirror-');
    const workspaceRoot = join(root, 'runs');
    const origin = makeOriginRepo(root);
    const { mirrorDir: dir } = ensureMirror({ workspaceRoot, url: origin.url });

    expect(codeOf(() => resolveRemoteRef(dir, origin.url, { branch: 'feat/nope', commitHash: null }))).toBe('INVALID_REF');
    const message = messageOf(() => resolveRemoteRef(dir, origin.url, { branch: 'feat/nope', commitHash: null }));
    expect(message).toContain('feat/nope');
    expect(message).toContain(origin.url);
  });
  it('同名 tag 在镜像里 → 仍然 INVALID_REF（分支判据只认 refs/heads/，不落到别的命名空间）', () => {
    const root = makeTmp('aieval-mirror-');
    const workspaceRoot = join(root, 'runs');
    const origin = makeOriginRepo(root);
    // 镜像里有一个与「请求的分支」同名的 tag（clone --mirror 会把 tag 一起搬过来）：
    // 裸名 `feat/nope` 会按 git 的 ref 解析顺序命中 refs/tags/feat/nope，把「远端没这个分支」判成有
    git(origin.bareDir, ['tag', 'feat/nope', hashOf(origin, 'main')]);
    const { mirrorDir: dir } = ensureMirror({ workspaceRoot, url: origin.url });
    expect(git(dir, ['tag']).trim()).toBe('feat/nope');

    expect(codeOf(() => resolveRemoteRef(dir, origin.url, { branch: 'feat/nope', commitHash: null }))).toBe('INVALID_REF');
  });
  it('默认分支是个还没有提交的分支（HEAD 指过去但 refs/heads/ 下没有）→ NOT_A_GIT_REPO，点名分支与远端', () => {
    const root = makeTmp('aieval-mirror-');
    const workspaceRoot = join(root, 'runs');
    const origin = makeOriginRepo(root);
    const { mirrorDir: dir } = ensureMirror({ workspaceRoot, url: origin.url });
    // 镜像 HEAD 被改成指向一个不存在的分支：名字读得出来（ghost），tip 解析不出来
    git(dir, ['symbolic-ref', 'HEAD', 'refs/heads/ghost']);

    // `fetch: false` 是承重的：联网那条路现在会把这份 HEAD **自愈**回去（远端说的是 main，
    // 抓取之后对齐过去，见下面「远端 main → trunk」那条用例），所以「HEAD 指着一个不存在的分支」
    // 只在这条**离线**读路径上还可达；而离线读必须是诚实的：读不出 tip 就说读不出，
    // 不能悄悄换一个分支去解析（那会把「镜像坏了」说成一条正常的基线）
    const caught = caughtOf(() => resolveRemoteRef(dir, origin.url, { branch: null, commitHash: null, fetch: false }));
    expect(caught).toBeInstanceOf(ServiceError);
    expect((caught as ServiceError).code).toBe('NOT_A_GIT_REPO');
    expect((caught as Error).message).toContain('ghost');
    expect((caught as Error).message).toContain(origin.url);
    expect((caught as ServiceError).context).toMatchObject({ mirrorDir: dir, url: origin.url, name: 'ghost' });
  });
});
