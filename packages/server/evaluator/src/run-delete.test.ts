// @vitest-environment node
/**
 * 删除一轮评测（spec §5.3）：① 删快照 ② 回收整个 `{workspaceBase}/{runId}/` ③ 忘掉根记忆。
 *
 * 为什么单独一个文件而不是塞进 orchestrator.test.ts：本文件要 mock `node:fs` 的 `rmSync`
 * 造「回收失败」那一支（真实成因无法在 CI 上稳定造出：Windows 上需要文件被占用），
 * 而与 run-store.test.ts 一样，模块级 `vi.mock('node:fs')` 的影响面越小越好。
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ServiceError, hasLiveRows } from '@aieval/contracts';
import { rowEventsFile, runDir, runSnapshotFile } from '@aieval/core';
import { ROW_RETRY, assertRunMutable, deleteRun, drainRunningTasks, retryRow } from './orchestrator';
import { recalledRunRoot } from './run-root-memory';
import { getRun, saveRun } from './run-store';
import {
  createTempHome,
  fakeAgents,
  initFixtureRepo,
  makeCaseFixture,
  makeProviderFixture,
  makeRowFixture,
  makeRunFixture,
  seedConfig,
  type TempHome,
} from './testing/fixtures';
import { until } from './testing/orchestrator-harness';

// 只把 rmSync 换成可注入的替身（默认原样透传）：真实文件系统照常走，
// 「回收失败」那一支由用例显式装上一个只在 recursive 调用上抛的实现。
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, rmSync: vi.fn(actual.rmSync) };
});

// 「在途任务未收尾」那一条要真的跑起一次行级任务（假适配器 + 真 git 仓库），故按本仓既有做法
// 换掉 agents 这个唯一边界。`./judge` **不** mock：那一条的行在候选阶段就失败了，评分器一次都不会被调到。
vi.mock('@aieval/agents', async () => (await import('./testing/orchestrator-seams')).agentsMock());

/** 取抛出的错误（断言 code 时必须拿到对象本身） */
function thrownBy(action: () => unknown): unknown {
  try {
    action();
    return undefined;
  } catch (error) {
    return error;
  }
}

let home: TempHome;

/**
 * 需要真 git 仓库的那一条用例的等待上限（其余用例都是毫秒级）。
 * 真仓库的 `git init` + 克隆 + 工作区复制在本机要几秒，满载时按 5–13 倍放大（见 `vitest.node.ts` 的
 * `testTimeout` 注释），默认的 40s 会被吃光——那会把「哪条断言不成立」误报成超时。
 * 为什么比 `testing/orchestrator-harness.ts` 的 `TEST_TIMEOUT_MS`（60s）还宽一倍：那一条除了真仓库
 * 准备，还要**等一次自动重试的退避**（4s）并在收尾时再跑一遍准备（实测满载下这一条已跑到 38s）。
 * 口径与 harness 一致（上限只放宽等待，不放宽断言）；这里另起一个常量而不是从 harness 引：
 * 本文件**不**调 `registerOrchestratorHooks`（它那套临时家目录与 `restoreAllMocks` 会与本文件自己的
 * `node:fs` 替身互相覆盖），只借它的 `until` 等待器。
 */
const SLOW_CASE_TIMEOUT_MS = 120_000;

beforeEach(() => {
  // 上一轮用例可能装了粘性实现；mockReset 还原成 `vi.fn(actual.rmSync)`
  vi.mocked(rmSync).mockReset();
  home = createTempHome();
});

afterEach(() => {
  // 先复位再 cleanup：cleanup 自己也要 rmSync，带着替身会把它拖红
  vi.mocked(rmSync).mockReset();
  home.cleanup();
});

/**
 * 落盘一轮评测，并给它造出「行工作区 + 事件日志」——删除要回收的正是这些。
 * 行 id 由夹具自己生成（`makeRowFixture` 的 branch 与 id 自洽），不用手抄。
 */
function seedRunOnDisk(): { runId: string; runDirPath: string; rowId: string } {
  const row = makeRowFixture();
  const run = makeRunFixture({ workspaceRoot: home.workspaceRoot, rows: [row] });
  saveRun(run);
  const dir = runDir(home.workspaceRoot, run.id);
  mkdirSync(join(dir, 'rows', row.id, 'workspace'), { recursive: true });
  writeFileSync(join(dir, 'rows', row.id, 'workspace', 'README.md'), '# 产物\n', 'utf8');
  writeFileSync(rowEventsFile(home.workspaceRoot, run.id, row.id), '{"type":"log"}\n', 'utf8');
  return { runId: run.id, runDirPath: dir, rowId: row.id };
}

describe('deleteRun', () => {
  it('删掉快照与整个运行目录，并把这一轮从根记忆里忘掉', () => {
    const { runId, runDirPath, rowId } = seedRunOnDisk();
    // 写盘时登记过记忆（saveRun 的职责），删除的正是它
    expect(recalledRunRoot(runId)).toBe(home.workspaceRoot);
    expect(existsSync(runSnapshotFile(home.workspaceRoot, runId))).toBe(true);
    expect(existsSync(join(runDirPath, 'rows', rowId, 'workspace', 'README.md'))).toBe(true);

    const result = deleteRun(runId);

    expect(result.workspaceRemoved).toBe(true);
    expect(existsSync(runDirPath)).toBe(false);
    // 删干净之后 getRun 必须抛 NOT_FOUND（列表 / 详情都不该再看到它）
    const error = thrownBy(() => getRun(runId));
    expect(error).toBeInstanceOf(ServiceError);
    expect((error as ServiceError).code).toBe('NOT_FOUND');
    // 记忆必须一起失效：否则 getRunForWrite 的兜底会把「找不到」答成一条旧根路径
    expect(recalledRunRoot(runId)).toBeUndefined();
  });

  it('有行在跑 ⇒ CONFLICT，且一个字节都不删', () => {
    const { runId, runDirPath } = seedRunOnDisk();
    const running = { ...getRun(runId), status: 'running' as const };
    saveRun(running);

    const error = thrownBy(() => deleteRun(runId));

    expect((error as ServiceError).code).toBe('CONFLICT');
    expect((error as ServiceError).message).toContain('运行');
    expect(existsSync(runSnapshotFile(home.workspaceRoot, runId))).toBe(true);
    expect(existsSync(runDirPath)).toBe(true);
  });

  /**
   * 「上一轮还没收尾」那一档（`assertRunMutable` 的**唯一**生产者）。
   *
   * 为什么它必须真的跑起一次行级任务：`hasLiveRows` 之外还有一条「快照看着没活、任务还在收尾」的缝——
   * 行刚落 `failed`（终态）、而 `runRow` 还在**自动重试的退避**里等着再跑一遍。这一拍上删除会与
   * 那个正在收尾的任务抢同一行，`assertRunMutable` 就是为此存在的。造法：假适配器报 `AGENT_FAILED`
   * （瞬时面 ⇒ 进退避），把退避拉宽到秒级，于是那一拍可以被稳定观察到。
   */
  it('在途任务还没收尾（行已落终态）⇒ 改 / 删都 CONFLICT，且一个字节都不删', { timeout: SLOW_CASE_TIMEOUT_MS }, async () => {
    const repo = initFixtureRepo(join(home.root, 'repo'));
    const provider = makeProviderFixture();
    const testCase = makeCaseFixture({ repoPath: repo.repoPath, commitHash: repo.commit });
    seedConfig({ workspaceRoot: home.workspaceRoot, providers: [provider], cases: [testCase] });
    // 「跑过一次且有产出」的终态行：`canRetryRow` 要求基线已解析 + 有 diff 摘要
    const row = makeRowFixture({
      agentKind: 'codex',
      providerId: provider.id,
      providerName: provider.name,
      baseUrl: provider.baseUrl,
      status: 'judged',
      baselineCommit: repo.commit,
      diff: { filesChanged: 1, insertions: 1, deletions: 0, truncated: false },
    });
    const run = makeRunFixture({
      workspaceRoot: home.workspaceRoot,
      caseId: testCase.id,
      status: 'partial',
      rows: [row],
      repoPath: repo.repoPath,
      commitHash: repo.commit,
    });
    saveRun(run);
    const dir = runDir(home.workspaceRoot, run.id);

    fakeAgents.scripts.set('codex', { mode: 'error' });
    const productionMaxRetries = ROW_RETRY.maxRetries;
    const productionDelayMs = ROW_RETRY.delayMs;
    ROW_RETRY.maxRetries = 1;
    ROW_RETRY.delayMs = 4_000;
    try {
      retryRow(run.id, row.id);
      await until(
        () => getRun(run.id).rows[0]?.status === 'failed',
        '该行落 failed（自动重试的退避窗口）',
        SLOW_CASE_TIMEOUT_MS,
      );
      // 前提自证：快照上确实「没有活」——下面两条 CONFLICT 只可能来自 `assertRunMutable`，
      // 而不是 `hasLiveRows` 那一档（否则这条用例会退化成第二条「有行在跑」）
      expect(hasLiveRows(getRun(run.id))).toBe(false);

      const guardError = thrownBy(() => assertRunMutable(run.id));
      expect(guardError).toBeInstanceOf(ServiceError);
      expect((guardError as ServiceError).code).toBe('CONFLICT');
      expect((guardError as ServiceError).message).toContain('收尾');

      // 删除走的是同一条守卫：删掉 `deleteRun` 里那行 `assertRunMutable` 调用，这一条就红
      const deleteError = thrownBy(() => deleteRun(run.id));
      expect(deleteError).toBeInstanceOf(ServiceError);
      expect((deleteError as ServiceError).code).toBe('CONFLICT');
      expect((deleteError as ServiceError).message).toContain('收尾');
      // 拒绝必须是「什么都没发生」
      expect(existsSync(runSnapshotFile(home.workspaceRoot, run.id))).toBe(true);
      expect(existsSync(dir)).toBe(true);
    } finally {
      // 把还在退避的任务收干净，别漏给下一个用例：预算压到 0 ⇒ 退避结束后那一次尝试直接收场
      ROW_RETRY.maxRetries = 0;
      await drainRunningTasks();
      // 还原产品默认值（同进程的后续用例不该继承这里的等待时间与预算）
      ROW_RETRY.maxRetries = productionMaxRetries;
      ROW_RETRY.delayMs = productionDelayMs;
    }
  });

  it('不存在的轮次 ⇒ NOT_FOUND（脏 URL 不能删到别的目录）', () => {
    const error = thrownBy(() => deleteRun('nope'));
    expect((error as ServiceError).code).toBe('NOT_FOUND');
    // 「脏 URL」不只是「找不到」：带 `..` / 分隔符的 id 必须在**拼路径之前**被拦下——
    // 删除是本功能唯一具破坏性的端点，让它拿一个非法 id 拼出别人的目录是不可接受的
    const shapeError = thrownBy(() => deleteRun('../x'));
    expect(shapeError).toBeInstanceOf(ServiceError);
    expect((shapeError as ServiceError).code).toBe('INVALID_QUERY');
  });

  it('回收失败：快照照样删掉，结果里如实说 workspaceRemoved: false', async () => {
    const { runId, runDirPath } = seedRunOnDisk();
    const real = await vi.importActual<typeof import('node:fs')>('node:fs');
    // 只让「回收整目录」那一次失败（`recursive: true`）：删快照那一笔必须照常成功
    vi.mocked(rmSync).mockImplementation(((target: Parameters<typeof rmSync>[0], options?: Parameters<typeof rmSync>[1]) => {
      if (options?.recursive === true) throw new Error('EPERM: 行工作区被占用');
      return real.rmSync(target, options);
    }) as typeof rmSync);

    const result = deleteRun(runId);

    expect(result.workspaceRemoved).toBe(false);
    // 替身只按 `recursive` 区分、不看目标，于是「先删快照」这一步只被间接钉住——
    // 这一条把顺序**真的**钉死：`toHaveBeenCalledWith` 不保证顺序（任何一次调用命中就算过，
    // 把两步对调它照样绿），故读第一笔调用的实参（口径同 run-store.test.ts 的写法）：
    // 第一笔删的必须是 run.json，第二笔才是整目录回收。
    const [firstCall] = vi.mocked(rmSync).mock.calls;
    expect(firstCall?.[0]).toBe(runSnapshotFile(home.workspaceRoot, runId));
    expect(firstCall?.[1]).toEqual({ force: true });
    // 用户要的那件事（这一轮消失）已经达成：快照没了、列表干净
    expect(existsSync(runSnapshotFile(home.workspaceRoot, runId))).toBe(false);
    // 回收失败不等于删除失败：目录残留是磁盘问题，不是「删除没生效」
    expect(existsSync(runDirPath)).toBe(true);
  });
});
