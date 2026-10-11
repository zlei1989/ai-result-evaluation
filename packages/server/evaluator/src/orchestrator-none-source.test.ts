// @vitest-environment node
/**
 * 无来源（`none://`）的行准备：空仓库初始化 + 行分支 + 基线。
 *
 * 本文件是 orchestrator 测试的一块，覆盖：无来源轮次的准备阶段**绕过镜像 / 用例缓存整条克隆链**，
 * 现场 `git init -b main` + 空提交（带显式提交者身份）+ `checkout -B test/{rowId}`。
 * 共享夹具、假适配器接缝与 `until` 等待器都在 `./testing/orchestrator-harness`——
 * 那里也写明了**为什么三条 `vi.mock` 必须在每个文件里逐字重复**（vitest 的前置提升只作用于本文件）。
 */
import { vi, describe, expect, it } from 'vitest';
import { NONE_SOURCE } from '@aieval/contracts';
import { caseCacheDir } from '@aieval/core';
import {
  registerOrchestratorHooks,
  home,
  seedRunnableRun,
  expectedWorkspace,
  gitIn,
  existsSync,
  join,
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

describe('无来源（none://）的行准备：空仓库初始化', () => {
  it('准备阶段现场建空仓库：main + 空提交 + test/{rowId} 行分支，基线就是那次空提交', async () => {
    const { run } = seedRunnableRun({
      rowCount: 1,
      executionMode: 'parallel',
      repoPath: NONE_SOURCE,
      commitHash: null,
    });
    startRun(run.id);
    await drainRunningTasks();

    const row = getRun(run.id).rows[0]!;
    expect(row.status).toBe('judged');
    expect(row.error).toBeNull();

    const workspace = expectedWorkspace(run.id, row.id);
    // 工作区是一个真实 git 仓库，且绕过了整条克隆链：用例缓存目录从未被建出来
    expect(existsSync(join(workspace, '.git'))).toBe(true);
    expect(existsSync(caseCacheDir(home.workspaceRoot, run.caseId))).toBe(false);

    // 默认分支显式 main；行分支是 checkoutRow 的惯例 test/{rowId}
    expect(gitIn(workspace, ['symbolic-ref', '--short', 'HEAD']).trim()).toBe(`test/${row.id}`);

    // 历史只有一次空提交，信息逐字「initial commit」，提交者是**显式身份**（机器全局身份不可靠）
    expect(gitIn(workspace, ['log', '--format=%s']).trim()).toBe('initial commit');
    expect(gitIn(workspace, ['log', '--format=%an <%ae>']).trim()).toBe('Aieval Bot <bot@aieval.local>');
    // 基线就是那次空提交的 40 位 hash，且与工作区 HEAD 一致（空仓库没有别的提交）
    const head = gitIn(workspace, ['rev-parse', 'HEAD']).trim();
    expect(row.baselineCommit).toBe(head);
    expect(row.baselineCommit).toHaveLength(40);

    // 工作树是空的：agent 拿到的是「一个干净的空目录」（git 内部文件除外）
    expect(gitIn(workspace, ['ls-files']).trim()).toBe('');
    // 行独立配置目录照常建好（与其它来源同一份布局）
    expect(existsSync(join(expectedWorkspace(run.id, row.id), '..', '.agenthome'))).toBe(true);
  });
});
