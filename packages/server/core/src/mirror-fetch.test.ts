// @vitest-environment node
/**
 * fetchMirror
 *
 * 本文件是 `mirror.test.ts` 拆分后的一块：真实 git / 裸仓库 / 静默远端等夹具与 `waitForConnection` 都在 `./testing/mirror-harness`（那里也写明了钩子为什么必须是显式注册的函数）。
 */

import { describe, expect, it } from 'vitest';
import {
  makeTmp,
  git,
  makeOriginRepo,
  unusedPort,
  FAST_FAILURE_PROBE_TIMEOUT_MS,
  caughtOf,
  codeOf,
  messageOf,
  existsSync,
  renameSync,
  rmSync,
  writeFileSync,
  join,
  ServiceError,
  ensureMirror,
  fetchMirror,
  isMirrorReady,
  probeRemote,
  readMirrorRecord,
  registerMirrorHooks,
} from './testing/mirror-harness';



registerMirrorHooks();

describe('fetchMirror', () => {
  it('增量更新拿到来源的新提交，并写镜像记录（url 指向来源 + fetchedAt 前进）', () => {
    const root = makeTmp('aieval-mirror-');
    const workspaceRoot = join(root, 'runs');
    const origin = makeOriginRepo(root);
    const { mirrorDir: dir } = ensureMirror({ workspaceRoot, url: origin.url });
    // 克隆成功后就该有一条记录：克隆本身就是一次从远端取回，记录时间 = 取回时间。
    // 夹具 URL 没有两侧空白与尾斜杠，所以「归一后的串」与原文逐字相同。
    const before = readMirrorRecord(dir);
    expect(before?.url).toBe(origin.url);

    // 来源新增一个提交（直接往裸仓库里推：模拟远端前进）
    const work2 = join(root, 'work2');
    git(root, ['clone', '-q', origin.url, work2]);
    writeFileSync(join(work2, 'b.txt'), 'b\n', 'utf8');
    git(work2, ['add', '.']);
    git(work2, ['commit', '-q', '-m', 'second']);
    const tip = git(work2, ['rev-parse', 'HEAD']).trim();
    git(work2, ['push', '-q', 'origin', 'HEAD:main']);

    const fetched = fetchMirror(dir, origin.url);

    expect(git(dir, ['rev-parse', 'refs/heads/main']).trim()).toBe(tip);
    expect(readMirrorRecord(dir)?.fetchedAt).toBe(fetched.fetchedAt);
    expect(readMirrorRecord(dir)?.fetchedAt).not.toBe(before?.fetchedAt);
  });

  it('来源被移走 → NOT_A_GIT_REPO（「远端不存在」，不是「不可达」）', () => {
    const root = makeTmp('aieval-mirror-');
    const workspaceRoot = join(root, 'runs');
    const origin = makeOriginRepo(root);
    const { mirrorDir: dir } = ensureMirror({ workspaceRoot, url: origin.url });
    renameSync(origin.bareDir, `${origin.bareDir}.moved`);

    // git 对移走的 file:// 路径报 `does not appear to be a git repository`：
    // spec §8.1 把它归成 NOT_A_GIT_REPO，处置是「改地址」而不是「查网络」
    expect(codeOf(() => fetchMirror(dir, origin.url))).toBe('NOT_A_GIT_REPO');
    expect(messageOf(() => fetchMirror(dir, origin.url))).toContain('不是 git 仓库');
  });

  it('镜像记录缺失或损坏不影响就绪判据（按「没有记录」处理，不重建）', () => {
    const root = makeTmp('aieval-mirror-');
    const workspaceRoot = join(root, 'runs');
    const origin = makeOriginRepo(root);
    const { mirrorDir: dir } = ensureMirror({ workspaceRoot, url: origin.url });

    rmSync(join(dir, 'aieval-mirror.json'), { force: true });
    expect(readMirrorRecord(dir)).toBeNull();
    expect(isMirrorReady(dir)).toBe(true);
    expect(ensureMirror({ workspaceRoot, url: origin.url }).created).toBe(false);

    writeFileSync(join(dir, 'aieval-mirror.json'), '{ 不是 JSON', 'utf8');
    expect(readMirrorRecord(dir)).toBeNull();
    expect(isMirrorReady(dir)).toBe(true);
  });
});

describe('probeRemote', () => {
  it('正常：回默认分支与 40 位 tip', () => {
    const root = makeTmp('aieval-mirror-');
    const origin = makeOriginRepo(root, ['feat/x']);
    const probe = probeRemote(origin.url, { cwd: root, timeoutMs: FAST_FAILURE_PROBE_TIMEOUT_MS });
    expect(probe.defaultBranch).toBe('main');
    expect(probe.tip).toBe(origin.hashes.main);
    expect(probe.tip).toHaveLength(40);
  });

  it('空仓库 → NOT_A_GIT_REPO，文案说明「还没有任何提交」且带 context', () => {
    const root = makeTmp('aieval-mirror-');
    const empty = join(root, 'empty.git');
    git(root, ['init', '-q', '--bare', empty]);
    const url = `file:///${empty.replace(/\\/g, '/')}`;
    const caught = caughtOf(() => probeRemote(url, { cwd: root, timeoutMs: FAST_FAILURE_PROBE_TIMEOUT_MS }));
    expect(caught).toBeInstanceOf(ServiceError);
    expect((caught as ServiceError).code).toBe('NOT_A_GIT_REPO');
    expect((caught as Error).message).toContain('还没有任何提交');
    // 其余远端失败都带 context（RG11 的原文落点），这条不能例外——否则排查时只有一句中文
    expect((caught as ServiceError).context).toMatchObject({ url, what: '读取远端仓库' });
  });

  it('不存在的路径 → NOT_A_GIT_REPO（远端报 does not appear to be a git repository）', () => {
    const root = makeTmp('aieval-mirror-');
    const url = `file:///${join(root, 'nope.git').replace(/\\/g, '/')}`;
    expect(codeOf(() => probeRemote(url, { cwd: root, timeoutMs: FAST_FAILURE_PROBE_TIMEOUT_MS }))).toBe('NOT_A_GIT_REPO');
  });

  it('cwd 还不存在时自己建出来（否则会以 spawnSync ENOENT 冒充远端失败）', () => {
    const root = makeTmp('aieval-mirror-');
    const origin = makeOriginRepo(root);
    const cwd = join(root, 'runs', 'remotes');

    const probe = probeRemote(origin.url, { cwd, timeoutMs: FAST_FAILURE_PROBE_TIMEOUT_MS });

    expect(probe.tip).toBe(origin.hashes.main);
    expect(existsSync(cwd)).toBe(true);
  });

  it('没人监听的端口 → REPO_UNREACHABLE，且文案说「无法连接」而不是「超时」', async () => {
    const root = makeTmp('aieval-mirror-');
    const port = await unusedPort();
    const url = `http://127.0.0.1:${port}/x.git`;
    // 「连接被拒」与「我们杀的那次」都给 REPO_UNREACHABLE：只看 code，机器一慢（停顿吃掉墙钟）这条也会绿
    const caught = caughtOf(() => probeRemote(url, { cwd: root, timeoutMs: FAST_FAILURE_PROBE_TIMEOUT_MS }));
    expect(caught).toBeInstanceOf(ServiceError);
    expect((caught as ServiceError).code).toBe('REPO_UNREACHABLE');
    expect((caught as Error).message).toContain('无法连接远端仓库');
    expect((caught as Error).message).not.toContain('超时');
  });

  it('超时被杀 → REPO_UNREACHABLE，文案是「探活超时（超过 N 秒）」而不是「拉取超时（超过 0 分钟）」', async () => {
    const root = makeTmp('aieval-mirror-');
    const port = await unusedPort();
    const url = `http://127.0.0.1:${port}/x.git`;
    // 1ms 上限：git 来不及连上就被杀，与机器快慢、网络环境无关
    const caught = caughtOf(() => probeRemote(url, { cwd: root, timeoutMs: 1 }));

    expect(caught).toBeInstanceOf(ServiceError);
    expect((caught as ServiceError).code).toBe('REPO_UNREACHABLE');
    const message = (caught as Error).message;
    // 三件事：动词（探活不是拉取）、时长（15s 不是「0 分钟」）、以及用户要处置的那个地址
    expect(message).toContain('探活超时');
    expect(message).toContain('秒');
    expect(message).not.toContain('0 分钟');
    expect(message).toContain(url);
  });
});
