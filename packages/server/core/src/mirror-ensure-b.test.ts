// @vitest-environment node
/**
 * mirrorDir（切分后的第二块）
 *
 * 本文件是 `mirror.test.ts` 拆分后的一块：真实 git / 裸仓库 / 静默远端等夹具与 `waitForConnection` 都在 `./testing/mirror-harness`（那里也写明了钩子为什么必须是显式注册的函数）。
 */

import { describe, expect, it } from 'vitest';
import {
  makeTmp,
  makeOriginRepo,
  silentRemote,
  waitForConnection,
  existsSync,
  mkdirSync,
  readdirSync,
  writeFileSync,
  join,
  ServiceError,
  ensureMirror,
  isMirrorReady,
  mirrorDir,
  remotesDir,
  registerMirrorHooks,
} from './testing/mirror-harness';



registerMirrorHooks();

describe('ensureMirror', () => {
  it('半成品目录（有目录没有 objects）被重建', () => {
    const root = makeTmp('aieval-mirror-');
    const workspaceRoot = join(root, 'runs');
    const origin = makeOriginRepo(root);
    const dir = mirrorDir(workspaceRoot, origin.url);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'README'), '半成品\n', 'utf8');

    expect(isMirrorReady(dir)).toBe(false);
    const built = ensureMirror({ workspaceRoot, url: origin.url });
    expect(built.created).toBe(true);
    expect(isMirrorReady(built.mirrorDir)).toBe(true);
  });
  it('克隆被墙钟杀掉（远端接了连接却永不回话）→ REPO_UNREACHABLE，且不留 tmp 残留', async () => {
    const root = makeTmp('aieval-mirror-');
    const workspaceRoot = join(root, 'runs');
    const remote = await silentRemote();
    let caught: unknown = null;
    const startedAt = Date.now();
    try {
      ensureMirror({ workspaceRoot, url: remote.url, timeoutMs: 3000 });
    } catch (error) {
      caught = error;
    }
    const elapsed = Date.now() - startedAt;
    const accepted = await waitForConnection(remote);
    await remote.close();

    // 这一次必须真的连上过：否则「不留残骸」可能只是空过——本机的进程创建停顿能超过 3s 墙钟，
    // 那样 git 还没跑到 init_db（建目标目录）就被杀，磁盘上本来就没东西可清。
    expect(accepted).toBeGreaterThan(0);
    expect(elapsed).toBeGreaterThanOrEqual(2500);
    expect(caught).toBeInstanceOf(ServiceError);
    expect((caught as ServiceError).code).toBe('REPO_UNREACHABLE');
    // 文案要说出**生效的**上限（注入的 3s 按秒说，不能拿默认的「10 分钟」糊弄）与正确的动词（拉取）
    expect((caught as Error).message).toBe(`远端仓库拉取超时（超过 3 秒）：${remote.url}（已终止 git 进程）`);

    // 这条断言在 Windows 上有区分力：连上之后 git 一定已经跑过 init_db（目标目录在传输之前建好），
    // 而 TerminateProcess 不跑 git 的清理，所以留着残骸还是清掉残骸全看 catch 里那句 rmSync。
    // 上面的 accepted 断言就是防「空过」的那一半：真出现「还没建目录就被杀」时它会先红。
    // POSIX 上 git 自己注册了 SIGTERM 处理器（clone 的 remove_junk_on_signal）会先清掉，
    // 这条断言退化为空过——不会假红。
    const remotes = remotesDir(workspaceRoot);
    expect(existsSync(remotes) ? readdirSync(remotes).filter((name) => name.includes('.tmp-')) : []).toEqual([]);
  });
  it('上一次中断留下的同名 tmp 残留挡住重建：先清 tmp 才建得起来', () => {
    const root = makeTmp('aieval-mirror-');
    const workspaceRoot = join(root, 'runs');
    const origin = makeOriginRepo(root);
    const dir = mirrorDir(workspaceRoot, origin.url);
    // 硬杀（SIGKILL / 掉电）时 catch 里的清理跑不到，残余就停在 tmp 路径上；
    // 这里按实现的命名（含**当前** pid）把它摆出来：非空目录会让 clone 直接以
    // 「destination path already exists and is not an empty directory」失败。
    const leftover = `${dir}.tmp-${process.pid}`;
    mkdirSync(leftover, { recursive: true });
    writeFileSync(join(leftover, 'README'), '上一次中断的残骸\n', 'utf8');

    const built = ensureMirror({ workspaceRoot, url: origin.url });

    expect(built.created).toBe(true);
    expect(isMirrorReady(built.mirrorDir)).toBe(true);
    expect(existsSync(leftover)).toBe(false);
  });
});
