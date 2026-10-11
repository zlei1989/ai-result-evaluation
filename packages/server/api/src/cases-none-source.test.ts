// @vitest-environment node
/**
 * 「无来源」哨兵（`none://`）的写侧行为。
 *
 * 三条容易写错的地方（每条都对应一条守卫）：
 *   1. 无来源的保存**一次 git 进程都不该起**（没有仓库可校验、可镜像、可判 commit）——
 *      起了 git 就是有人在某个分支里忘了拦 none（判据：`gitCommands()` 的增量必须为 0）；
 *   2. 「无 + 分支 / commit」必须响亮拒绝，与「本地 + 分支」同口径——不静默忽略；
 *   3. 已有用例可以在编辑时**改填**成无来源（类型今天本就可改），再改回来也走同一条归一侧。
 */
import { vi, describe, expect, it } from 'vitest';
import { NONE_SOURCE } from '@aieval/contracts';
import {
  ServiceError,
  caseInput,
  createCase,
  getCase,
  gitCommands,
  listCommitCandidates,
  registerCasesHooks,
  uiPatchOf,
  updateCase,
  validateRepo,
} from './testing/cases-harness';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, rmSync: vi.fn(actual.rmSync) };
});

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) };
});

registerCasesHooks();

/** 期待一次 INVALID_QUERY：code 与 message 两样都验，message 用子串（文案细节可以演化，语义不能漂） */
function expectRejected(action: () => unknown, messagePart: string): void {
  let caught: unknown;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ServiceError);
  expect((caught as ServiceError).code).toBe('INVALID_QUERY');
  expect((caught as ServiceError).message).toContain(messagePart);
}

describe('无来源用例（none://）的写侧', () => {
  it('创建：repoPath 落哨兵值，分支与 commit 恒为 null，且全程零 git 进程', () => {
    const before = gitCommands().length;
    const created = createCase(caseInput({ repoPath: NONE_SOURCE, commitHash: null, repoBranch: null }));

    expect(created.repoPath).toBe(NONE_SOURCE);
    expect(created.commitHash).toBeNull();
    expect(created.repoBranch).toBeNull();
    // 判据是**增量**：无来源没有仓库，任何一次 git 进程都说明有分支忘了拦 none
    expect(gitCommands().length - before).toBe(0);

    // 落盘读回也是同一份（写侧自检之后原文可读）
    expect(getCase(created.id).repoPath).toBe(NONE_SOURCE);
  });

  it('创建：带分支被响亮拒绝（与「本地 + 分支」同口径，不静默忽略）', () => {
    expectRejected(() => createCase(caseInput({ repoPath: NONE_SOURCE, repoBranch: 'feat/x' })), '无来源用例不支持分支');
  });

  it('创建：带 commit 被响亮拒绝', () => {
    expectRejected(() => createCase(caseInput({ repoPath: NONE_SOURCE, commitHash: 'abc123' })), '无来源用例不能指定 commit');
  });

  it('校验与候选：都没有仓库可读，拒绝而不是给空回显', () => {
    expectRejected(() => validateRepo({ repoPath: NONE_SOURCE, repoBranch: null }), '无需校验');
    expectRejected(() => listCommitCandidates({ repoPath: NONE_SOURCE, repoBranch: null }), '没有提交候选');
  });

  it('编辑：本地用例可改填成无来源（类型可改），再改回本地照常', () => {
    const local = createCase(caseInput());
    const none = updateCase(local.id, uiPatchOf(local, { repoPath: NONE_SOURCE, commitHash: null, repoBranch: null }));
    expect(none.repoPath).toBe(NONE_SOURCE);
    expect(none.commitHash).toBeNull();
    expect(none.repoBranch).toBeNull();

    // 改回来：归一侧与「来源到底改没改」的判据都照常工作
    const back = updateCase(none.id, uiPatchOf(none, { repoPath: local.repoPath, commitHash: local.commitHash, repoBranch: null }));
    expect(back.repoPath).toBe(local.repoPath);
    expect(back.commitHash).toBe(local.commitHash);
  });

  it('编辑：只改标题不动来源时，无来源用例照常保存（不解析、不联网、零 git 进程）', () => {
    const created = createCase(caseInput({ repoPath: NONE_SOURCE, title: '无来源一' }));
    const before = gitCommands().length;
    const updated = updateCase(created.id, uiPatchOf(created, { title: '无来源二' }));
    expect(updated.title).toBe('无来源二');
    expect(updated.repoPath).toBe(NONE_SOURCE);
    expect(gitCommands().length - before).toBe(0);
  });

  it('编辑：给无来源用例补 commit 被响亮拒绝（commitTouched 那条路也要拦）', () => {
    const created = createCase(caseInput({ repoPath: NONE_SOURCE }));
    expectRejected(() => updateCase(created.id, uiPatchOf(created, { commitHash: 'abc123' })), '无来源用例不能指定 commit');
  });
});
