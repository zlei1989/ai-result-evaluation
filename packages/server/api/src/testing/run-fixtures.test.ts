// @vitest-environment node
/**
 * 评测夹具自己的回归网（2026-10-09）。
 *
 * 为什么单开一条：夹具的 `workspaceBase` / `workspacePath` 会被用例**真的**拿去 mkdir / 写盘
 * （`run-artifacts.test.ts` 的 `seedRun(..., { createWorkspace: true })`、`messages-stream.test.ts`
 * 的 `resetRecords(...)`）。这两个格子一旦写回盘符字面量（`D:\runs`），在 POSIX 上就是**相对路径**：
 * 产物落进进程 cwd，仓库根长出名为 `D:\runs` 的目录——实测原文
 * `D:\runs\run-1\rows\r-1\workspace`（以及 `rowWorkspaceDir('D:\runs', …)` 拼出的
 * `D:\runs/run-1/rows/r-1` 那棵混合分隔符的树）。
 *
 * 判据刻意问「是不是平台绝对路径 + 在不在临时目录」，而不是「等于某个常量」：后者在常量本身改错时
 * 照样绿（夹具的常量就是缺陷现场）。变异验证：把 `makeRun` 的 `workspaceBase` 改回 `'D:\\runs'`，
 * 本文件当场红。
 */
import { tmpdir } from 'node:os';
import { isAbsolute } from 'node:path';
import { describe, expect, it } from 'vitest';
import { rowWorkspaceDir } from '@aieval/core';
import { fixtureWorkspaceRoot, makeRow, makeRun } from './run-fixtures';

describe('评测夹具里的磁盘地址按当前平台拼（不许盘符字面量）', () => {
  it('workspaceBase / workspacePath 是绝对路径、落在系统临时目录下，且不在仓库工作目录里', () => {
    const root = fixtureWorkspaceRoot();
    const run = makeRun();
    const row = makeRow();

    // 两格的形状关系也要钉住：行的工作区必须挂在这一轮自己的根下（否则「按 run.workspaceBase 找产物」
    // 那条口径在夹具层面就不成立）
    expect(run.workspaceBase).toBe(root);
    expect(row.workspacePath).toBe(rowWorkspaceDir(root, 'run-1', 'r-1'));

    const paths: ReadonlyArray<readonly [string, string]> = [
      ['workspaceBase', run.workspaceBase],
      ['workspacePath', row.workspacePath],
    ];
    for (const [label, value] of paths) {
      expect(isAbsolute(value), `${label} 必须是平台绝对路径：${value}`).toBe(true);
      expect(value.startsWith(tmpdir()), `${label} 必须落在系统临时目录下：${value}`).toBe(true);
      // 盘符字面量在 POSIX 上等于「相对 cwd」——落进仓库就是这次事故的形状
      expect(value.startsWith(process.cwd()), `${label} 不许落在仓库工作目录里：${value}`).toBe(false);
    }
  });
});
