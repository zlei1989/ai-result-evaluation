// @vitest-environment node
/**
 * 远端来源的行准备（core 只见本地路径）
 *
 * 本文件是 `orchestrator.test.ts` 拆分后的一块，覆盖：远端来源的行准备（core 只见本地路径）。
 * 共享夹具、假适配器接缝与 `until` 等待器都在 `./testing/orchestrator-harness`——
 * 那里也写明了**为什么三条 `vi.mock` 必须在每个文件里逐字重复**（vitest 的前置提升只作用于本文件）。
 */
import { vi, describe, expect, it } from 'vitest';
import {
  registerOrchestratorHooks,
  home,
  seedRunnableRun,
  expectedWorkspace,
  gitIn,
  makeBareRemote,
  cacheOriginOf,
  REMOTE_FIXTURE_TIMEOUT_MS,
  existsSync,
  realpathSync,
  renameSync,
  writeFileSync,
  join,
  mirrorDir,
  drainRunningTasks,
  startRun,
  getRun,
} from './testing/orchestrator-harness';

vi.mock('@aieval/agents', async () => (await import('./testing/orchestrator-seams')).agentsMock());
vi.mock('./judge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./judge')>();
  return (await import('./testing/orchestrator-seams')).judgeMock(actual);
});
vi.mock('./run-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./run-store')>();
  return (await import('./testing/orchestrator-seams')).runStoreMock(actual);
});

registerOrchestratorHooks();

describe('远端来源的行准备（core 只见本地路径）', { timeout: REMOTE_FIXTURE_TIMEOUT_MS }, () => {
  it('远端来源：准备阶段落具体基线 hash，行工作区来自镜像', async () => {
    const origin = makeBareRemote('remote-origin');

    const { run } = seedRunnableRun({
      rowCount: 1,
      executionMode: 'parallel',
      repoPath: origin.url,
      commitHash: null,
    });
    startRun(run.id);
    await drainRunningTasks();

    const row = getRun(run.id).rows[0]!;
    expect(row.status).toBe('judged');
    // R2：远端轮次的基线是**解析后的 40 位具体 hash**，且与来源逐字相同（不是镜像 HEAD 之类的代理）
    expect(row.baselineCommit).toBe(origin.commit);
    expect(existsSync(join(row.workspacePath, '.git'))).toBe(true);
    // 镜像落在工作区根下（与 cases/ 平级），而**不在行工作区里**（RG12：镜像不进任何行工作区）
    expect(existsSync(mirrorDir(home.workspaceRoot, origin.url))).toBe(true);
    expect(existsSync(join(home.workspaceRoot, 'remotes'))).toBe(true);
    expect(existsSync(join(row.workspacePath, 'remotes'))).toBe(false);
    // RG7 的**直接指纹**：用例缓存的来源记录里写的是镜像路径，core 从没见过那个 URL。
    // 为什么必须有这一条：git 把 `file://` URL 当路径用也能克隆（本机实测），
    // 故「基线 hash 对不对」根本区分不出「走了镜像」与「URL 被当成路径直接塞给 core」——
    // 来源记录（core 的 ensureCaseCache 落盘，见 core/src/git.ts）才是这条接缝的观测点。
    expect(cacheOriginOf(run.caseId)).toBe(realpathSync(mirrorDir(home.workspaceRoot, origin.url)));
    expect(cacheOriginOf(run.caseId)).not.toContain('file://');
  });

  it('远端来源 + 分支：重复一轮会重新解析分支 tip（跟随语义）', async () => {
    const origin = makeBareRemote('remote-branch');

    const first = seedRunnableRun({
      rowCount: 1,
      executionMode: 'parallel',
      repoPath: origin.url,
      commitHash: null,
      repoBranch: 'main',
    });
    startRun(first.run.id);
    await drainRunningTasks();
    expect(getRun(first.run.id).rows[0]!.baselineCommit).toBe(origin.commit);

    // 远端前进一个提交（别人往这条分支推了一次）
    const work = join(home.root, 'advance');
    gitIn(home.root, ['clone', '-q', origin.url, work]);
    writeFileSync(join(work, 'next.txt'), 'next\n', 'utf8');
    gitIn(work, ['add', '.']);
    gitIn(work, ['commit', '-q', '-m', 'next']);
    const advanced = gitIn(work, ['rev-parse', 'HEAD']).trim();
    gitIn(work, ['push', '-q', 'origin', 'HEAD:main']);

    const second = seedRunnableRun({
      rowCount: 1,
      executionMode: 'parallel',
      repoPath: origin.url,
      commitHash: null,
      repoBranch: 'main',
    });
    startRun(second.run.id);
    await drainRunningTasks();

    // 「跟随分支」的定义就是这一条：第二轮不沿用第一轮解析出的 tip，而是重新解析
    expect(getRun(second.run.id).rows[0]!.baselineCommit).toBe(advanced);
    // 重新解析发生在**镜像**上（RG7 的落点）：它自己的 main 也跟着前进了
    expect(existsSync(mirrorDir(home.workspaceRoot, origin.url))).toBe(true);
    expect(gitIn(mirrorDir(home.workspaceRoot, origin.url), ['rev-parse', 'refs/heads/main']).trim()).toBe(advanced);
  });

  it('来源被移走（远端不存在）：该行 failed 且错误码是 NOT_A_GIT_REPO（绝不静默沿用旧镜像）', async () => {
    const origin = makeBareRemote('remote-down');

    // 先把镜像建出来（这一轮正常跑完），再把「远端」整体移走：此后盘上的镜像仍然是完好的
    const warmup = seedRunnableRun({
      rowCount: 1,
      executionMode: 'parallel',
      repoPath: origin.url,
      commitHash: null,
    });
    startRun(warmup.run.id);
    await drainRunningTasks();
    expect(getRun(warmup.run.id).rows[0]!.status).toBe('judged');
    renameSync(origin.bare, `${origin.bare}.moved`);

    const { run } = seedRunnableRun({
      rowCount: 1,
      executionMode: 'parallel',
      repoPath: origin.url,
      commitHash: null,
    });
    startRun(run.id);
    await drainRunningTasks();

    const row = getRun(run.id).rows[0]!;
    expect(row.status).toBe('failed');
    // A7 的裁定：被改名/移走的是**远端不存在**（git 原文 does not appear to be a git repository），
    // 按 spec §4.5 归到 NOT_A_GIT_REPO，而不是 REPO_UNREACHABLE —— 后者会把用户指向「查网络」，
    // 而这里该做的是改地址。本机 git 2.47 实测该原文确实落进这条分支（探针见任务报告）。
    expect(row.error?.code).toBe('NOT_A_GIT_REPO');
    // 「绝不静默沿用旧镜像」的正面证据：镜像在盘上、内容完好，但这一行的工作区从没被准备出来
    expect(existsSync(mirrorDir(home.workspaceRoot, origin.url))).toBe(true);
    expect(existsSync(join(expectedWorkspace(run.id, row.id), '.git'))).toBe(false);
  });


});
