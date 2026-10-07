// @vitest-environment node
/**
 * mirrorDir
 *
 * 本文件是 `mirror.test.ts` 拆分后的一块：真实 git / 裸仓库 / 静默远端等夹具与 `waitForConnection` 都在 `./testing/mirror-harness`（那里也写明了钩子为什么必须是显式注册的函数）。
 */

import { describe, expect, it } from 'vitest';
import {
  makeTmp,
  git,
  makeOriginRepo,
  existsSync,
  mkdirSync,
  renameSync,
  join,
  ServiceError,
  ensureMirror,
  isMirrorReady,
  mirrorDir,
  promoteMirror,
  remotesDir,
  registerMirrorHooks,
} from './testing/mirror-harness';



registerMirrorHooks();

describe('mirrorDir', () => {
  it('同一 URL（两侧空白 / 尾斜杠差异）映射同一目录；不同形态映射不同目录', () => {
    const root = 'C:/runs';
    expect(mirrorDir(root, ' https://host/x.git/ ')).toBe(mirrorDir(root, 'https://host/x.git'));
    expect(mirrorDir(root, 'https://host/x.git')).not.toBe(mirrorDir(root, 'git@host:x.git'));
    expect(mirrorDir(root, 'https://host/x.git')).toContain(join(remotesDir(root), 'x-'));
  });
});

describe('ensureMirror', () => {
  it('首次建镜像：目录满足就绪判据，且来源的全部分支都在（含非默认分支）', () => {
    const root = makeTmp('aieval-mirror-');
    const workspaceRoot = join(root, 'runs');
    const origin = makeOriginRepo(root, ['feat/x']);

    const first = ensureMirror({ workspaceRoot, url: origin.url });

    expect(first.created).toBe(true);
    expect(isMirrorReady(first.mirrorDir)).toBe(true);
    const refs = git(first.mirrorDir, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']).split('\n').map((l) => l.trim());
    expect(refs).toContain('main');
    expect(refs).toContain('feat/x');
  });

  it('幂等且不联网：第二次 created=false，且来源仓库**被移走**也照样成功', () => {
    const root = makeTmp('aieval-mirror-');
    const workspaceRoot = join(root, 'runs');
    const origin = makeOriginRepo(root);
    const first = ensureMirror({ workspaceRoot, url: origin.url });

    // 把来源整体改名：任何联网/读取来源的行为都会在这里失败（这就是「不联网」的证据）
    renameSync(origin.bareDir, `${origin.bareDir}.moved`);

    const second = ensureMirror({ workspaceRoot, url: origin.url });
    expect(second.created).toBe(false);
    expect(second.mirrorDir).toBe(first.mirrorDir);
  });



});

describe('promoteMirror', () => {
  it('目标已存在且就绪时复用既有目录并清掉 tmp（rename 撞车的可达路径）', () => {
    const root = makeTmp('aieval-mirror-');
    const workspaceRoot = join(root, 'runs');
    const origin = makeOriginRepo(root);
    const target = ensureMirror({ workspaceRoot, url: origin.url }).mirrorDir;
    const tmp = `${target}.tmp-999`;
    git(remotesDir(workspaceRoot), ['clone', '-q', '--mirror', origin.url, tmp]);

    expect(promoteMirror(tmp, target)).toBe('reused-existing');
    expect(existsSync(tmp)).toBe(false);
    expect(isMirrorReady(target)).toBe(true);
  });

  it('目标不存在时把 tmp 改名过去', () => {
    const root = makeTmp('aieval-mirror-');
    const workspaceRoot = join(root, 'runs');
    const origin = makeOriginRepo(root);
    const target = mirrorDir(workspaceRoot, origin.url);
    mkdirSync(remotesDir(workspaceRoot), { recursive: true });
    const tmp = `${target}.tmp-999`;
    git(remotesDir(workspaceRoot), ['clone', '-q', '--mirror', origin.url, tmp]);

    expect(promoteMirror(tmp, target)).toBe('created');
    expect(isMirrorReady(target)).toBe(true);
  });

  /**
   * 瞬时占用必须重试到成功：Windows 上刚退出的 git 进程 / 杀软 / 索引器会短暂捏着 tmp 目录的
   * 句柄，`renameSync` 抛 EPERM/EBUSY——2026-09-28 全量并发下 `resolveRemoteRef` 那条用例
   * 就红在这里（同样代码独占跑全绿）。
   * 「前两次 EPERM、第三次成功」这个窗口在真实机器上不可稳定复现，故用 `promoteMirror` 的
   * `rename` 注入点造出来（生产调用方不传它）。
   * 变异验证：把重试去掉（只 try 一次）后这条**确实红**。
   */
  it('改名被瞬时占用（EPERM）时重试到成功，不把可恢复的占用报成失败', () => {
    const root = makeTmp('aieval-mirror-');
    const workspaceRoot = join(root, 'runs');
    const origin = makeOriginRepo(root);
    const target = mirrorDir(workspaceRoot, origin.url);
    mkdirSync(remotesDir(workspaceRoot), { recursive: true });
    const tmp = `${target}.tmp-999`;
    // tmp 要是个**就绪镜像**，成功那条路才会被认（`isMirrorReady(target)` 在目标侧判，tmp 侧只要搬得动）
    git(remotesDir(workspaceRoot), ['clone', '-q', '--mirror', origin.url, tmp]);

    let attempts = 0;
    const flaky = ((from: string, to: string) => {
      attempts += 1;
      if (attempts <= 2) {
        const error = new Error('EPERM: operation not permitted, rename') as NodeJS.ErrnoException;
        error.code = 'EPERM';
        throw error;
      }
      renameSync(from, to);
    }) as typeof renameSync;

    expect(promoteMirror(tmp, target, flaky)).toBe('created');
    expect(attempts).toBe(3);
    expect(isMirrorReady(target)).toBe(true);
    expect(existsSync(tmp)).toBe(false);
  });

  it('改名失败且目标不是就绪镜像时抛 INTERNAL，并且不把 tmp 留在 remotes 里', () => {
    const root = makeTmp('aieval-mirror-');
    const workspaceRoot = join(root, 'runs');
    const origin = makeOriginRepo(root);
    const target = mirrorDir(workspaceRoot, origin.url);
    // 目标是「存在但不是镜像」的非空目录：rename 覆盖不了它（Windows EPERM / POSIX ENOTEMPTY），
    // 就绪判据也不认它——两个条件同时成立才走到抛错分支（复用分支的用例见上一条）。
    mkdirSync(join(target, 'not-a-mirror'), { recursive: true });
    const tmp = `${target}.tmp-999`;
    git(remotesDir(workspaceRoot), ['clone', '-q', '--mirror', origin.url, tmp]);

    let caught: unknown = null;
    try {
      promoteMirror(tmp, target);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ServiceError);
    expect((caught as ServiceError).code).toBe('INTERNAL');
    expect(existsSync(tmp)).toBe(false);
    expect(isMirrorReady(target)).toBe(false);
  });
});
