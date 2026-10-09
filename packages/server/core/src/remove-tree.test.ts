// @vitest-environment node
/**
 * 子树回收的**有界重试**契约（2026-10-07）。
 *
 * 为什么这一层值得独立守卫：行产物清理（`workspace.ts` 的 `clearRowArtifacts`）过去是「一次
 * `rmSync` 不成就折成 INTERNAL」，而 Windows 上的占用常常只持续几百毫秒——一次瞬时占用就能把一行
 * 判死，且在锁消失之前**每次重跑都失败**（真机：同一条报错在 7 次尝试里逐字重复）。
 *
 * 这里一律用注入的 `remove` / `wait`：**不碰真文件系统、不真等**，把「重试几次、什么时候放弃、
 * 什么错误值得重试」这三件事变成可判定的断言。真实删除能力另有一条真文件系统的兜底用例。
 */
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  REMOVE_TREE_ATTEMPTS,
  REMOVE_TREE_RETRY_DELAY_MS,
  isRetryableRemoveError,
  removeTreeWithRetry,
} from './remove-tree';

/** 造一个带 errno 码的错误（真实成因：目录被活进程的句柄捏着） */
function errnoError(code: string, message = 'EPERM: Permission denied, rm X'): Error {
  return Object.assign(new Error(message), { code });
}

describe('removeTreeWithRetry —— 瞬时占用就地重试', () => {
  it('前两次 EPERM、第三次成功 ⇒ 删掉，且如实记 3 次尝试', () => {
    let calls = 0;
    const waits: number[] = [];
    const outcome = removeTreeWithRetry('X', {
      remove: () => {
        calls += 1;
        if (calls < 3) throw errnoError('EPERM');
      },
      wait: (ms) => waits.push(ms),
    });
    expect(outcome).toEqual({ removed: true, attempts: 3, lastError: null });
    // 两次失败各等一次；成功后不再等（多等一次就是白花时间）
    expect(waits).toEqual([REMOVE_TREE_RETRY_DELAY_MS, REMOVE_TREE_RETRY_DELAY_MS]);
  });

  it('不值得重试的错误一次就返回，不做无谓等待', () => {
    let calls = 0;
    const waits: number[] = [];
    const outcome = removeTreeWithRetry('X', {
      remove: () => {
        calls += 1;
        throw new Error('代码写错了');
      },
      wait: (ms) => waits.push(ms),
    });
    expect(calls).toBe(1);
    expect(waits).toEqual([]);
    expect(outcome.removed).toBe(false);
    expect(outcome.attempts).toBe(1);
  });

  it('一直占用 ⇒ 到上限就放弃，把**最后一次**错误原样交出去（不在这里抛）', () => {
    const waits: number[] = [];
    const outcome = removeTreeWithRetry('X', {
      attempts: 3,
      remove: () => {
        throw errnoError('EBUSY', 'EBUSY: resource busy or locked');
      },
      wait: (ms) => waits.push(ms),
    });
    expect(outcome.removed).toBe(false);
    expect(outcome.attempts).toBe(3);
    expect((outcome.lastError as NodeJS.ErrnoException).code).toBe('EBUSY');
    // 三次尝试只有两次等待：最后一次失败之后没有「再等一次」的意义
    expect(waits).toHaveLength(2);
  });

  it('默认预算就是文件头承诺的那个（6 次 × 250ms）', () => {
    expect(REMOVE_TREE_ATTEMPTS).toBe(6);
    expect(REMOVE_TREE_RETRY_DELAY_MS).toBe(250);
  });

  it('重试白名单与 Node 异步 rimraf 同表；无 code 的错误不重试', () => {
    for (const code of ['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY', 'EMFILE', 'ENFILE']) {
      expect(isRetryableRemoveError(errnoError(code))).toBe(true);
    }
    expect(isRetryableRemoveError(errnoError('ENOENT'))).toBe(false);
    expect(isRetryableRemoveError(new Error('没有 code'))).toBe(false);
    expect(isRetryableRemoveError(null)).toBe(false);
  });
});

describe('removeTreeWithRetry —— 真实文件系统的兜底', () => {
  it('默认实现真的能删掉一棵带内容的子树（注入点没把默认值换坏）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aieval-remove-tree-'));
    try {
      expect(existsSync(dir)).toBe(true);
      const outcome = removeTreeWithRetry(dir, { attempts: 1 });
      expect(outcome).toEqual({ removed: true, attempts: 1, lastError: null });
      expect(existsSync(dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('目标本来就不存在也算成功（`force: true` 的语义，别把它报成占用）', () => {
    const missing = join(tmpdir(), `aieval-remove-tree-missing-${Date.now()}`);
    expect(removeTreeWithRetry(missing, { attempts: 1 }).removed).toBe(true);
  });
});
