// @vitest-environment node
/**
 * 远端来源的行准备（core 只见本地路径）（切分后的第二块）
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
  gitIn,
  makeBareRemote,
  REMOTE_FIXTURE_TIMEOUT_MS,
  existsSync,
  writeFileSync,
  join,
  drainRunningTasks,
  startRun,
  getRun,
  listRuns,
  makeWorkRepo,
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
  it('钉死 commit 时分支不参与解析（§6.7：commit 优先于分支）', async () => {
    // 远端要有**两个**提交：钉死第一个、分支指向第二个。两者相同时这条用例没有区分力
    //（「分支赢过 commit」的错误实现会拿到同一个 hash，照样绿）。
    const origin = makeWorkRepo('remote-pinned-work');
    const pinned = origin.commit;
    writeFileSync(join(origin.repoPath, 'second.txt'), 'second\n', 'utf8');
    gitIn(origin.repoPath, ['add', '.']);
    gitIn(origin.repoPath, ['commit', '-q', '-m', 'second']);
    const tip = gitIn(origin.repoPath, ['rev-parse', 'HEAD']).trim();
    const bare = join(home.root, 'remote-pinned.git');
    gitIn(home.root, ['clone', '-q', '--bare', origin.repoPath, bare]);
    const url = `file:///${bare.replace(/\\/g, '/')}`;
    expect(pinned).not.toBe(tip);

    const { run } = seedRunnableRun({
      rowCount: 1,
      executionMode: 'parallel',
      repoPath: url,
      commitHash: pinned,
      repoBranch: 'main',
    });
    startRun(run.id);
    await drainRunningTasks();

    const row = getRun(run.id).rows[0]!;
    expect(row.status).toBe('judged');
    expect(row.baselineCommit).toBe(pinned);
    expect(row.baselineCommit).not.toBe(tip);
  });
  it('镜像目录不会被评测列表当成一轮评测', async () => {
    const origin = makeBareRemote('remote-listrun');

    const { run } = seedRunnableRun({
      rowCount: 1,
      executionMode: 'parallel',
      repoPath: origin.url,
      commitHash: null,
    });
    startRun(run.id);
    await drainRunningTasks();

    // remotes/ 与 cases/ 一样是工作区根下的兄弟目录：listRuns 只认「目录下有合法 run.json」的那些
    expect(existsSync(join(home.workspaceRoot, 'remotes'))).toBe(true);
    expect(listRuns().map((item) => item.id)).toEqual([run.id]);
  });
});
