// @vitest-environment node
/**
 * 行产物清理：**瞬时占用就地重试** + 失败文案点名成因（2026-10-07）。
 *
 * 这一条链路的真机成因（`docs/faq/codex.md`）：codex 在 `thread/start` 期间 spawn 了一串 `git`
 * 孙进程去同步插件目录，它们**继承父进程的句柄**；父进程一死，句柄继续捏着该行的 `.judgehome`
 * ⇒ 下一轮的行产物清理 `EPERM`。而 `fs.rmSync` 在本机没有可用的重试（见 `remove-tree.ts` 文件头），
 * 于是「一次失败」直接等于「这一行失败」，且锁消失之前**每次重跑都失败**。
 *
 * 本文件钉住两件事（真实重试逻辑的单元判据在 `remove-tree.test.ts`）：
 *   ① `prepareRowWorkspace` 走的是**带重试**的那条路，且三个产物的删除动作逐个发生、顺序固定；
 *   ② 真删不掉时折成**中文 INTERNAL**，并把「常见成因：厂商子进程未退出」写进文案。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * 真实现的落点。为什么需要它：替身里要**代理回真实现**（「重试后成功」那条用例），
 * 而直接调用被 mock 的同名函数会无限递归（本文件第一版就踩了：`Maximum call stack size exceeded`
 * 被折成了「清理失败」，看起来像产品缺陷、实际是测试自己造的）。
 */
const realRemoveTree = vi.hoisted(() => ({
  fn: undefined as undefined | ((target: string, options?: Record<string, unknown>) => unknown),
}));

vi.mock('./remove-tree', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./remove-tree')>();
  realRemoveTree.fn = actual.removeTreeWithRetry as unknown as typeof realRemoveTree.fn;
  return { ...actual, removeTreeWithRetry: vi.fn(actual.removeTreeWithRetry) };
});

import { removeTreeWithRetry } from './remove-tree';
import {
  join,
  makeRepo,
  prepareRowWorkspace,
  registerWorkspaceHooks,
  root,
  type AppConfig,
  type Logger,
  type PendingAgentEvent,
} from './testing/workspace-harness';

registerWorkspaceHooks();

beforeEach(() => {
  // 每个用例都从「真实实现」出发：只有需要造缺陷的那一条才换成替身
  vi.mocked(removeTreeWithRetry).mockClear();
});

/** 造一个带 errno 码的占用错误（形状与真机逐字相同：`EPERM, Permission denied: …`） */
function busyError(target: string): Error {
  return Object.assign(new Error(`EPERM, Permission denied: \\\\?\\${target} '\\\\?\\${target}'`), { code: 'EPERM' });
}

function baseInput(dir: string, commit: string) {
  return {
    workspaceRoot: join(root, 'runs'),
    caseId: 'case-1',
    repoPath: dir,
    runId: 'run-1',
    rowId: 'row-1',
    commitHash: commit,
    branch: 'test/row-1',
  };
}

describe('行产物清理 —— 走带重试的回收', () => {
  it('三个产物逐个删，顺序固定为 workspace → .agenthome → .judgehome', () => {
    const { dir, commit } = makeRepo();
    prepareRowWorkspace(baseInput(dir, commit));
    // 第二轮才是「清理」那条路：第一次调用时行目录还不存在
    prepareRowWorkspace(baseInput(dir, commit));
    const targets = vi.mocked(removeTreeWithRetry).mock.calls.map(([target]) => target.replace(/\\/g, '/').split('/').slice(-1)[0]);
    expect(targets).toEqual(['workspace', '.agenthome', '.judgehome']);
  });

  it('单个产物删不掉 ⇒ 折成中文 INTERNAL，且文案点名「厂商子进程未退出」这一常见成因', () => {
    const { dir, commit } = makeRepo();
    const input = baseInput(dir, commit);
    prepareRowWorkspace(input);

    // 第二轮：只让 `.judgehome` 这一次失败（真机形态：它被 codex 的 git 孙进程捏着）
    vi.mocked(removeTreeWithRetry).mockImplementation((target: string) => {
      if (target.endsWith('.judgehome')) return { removed: false, attempts: 6, lastError: busyError(target) };
      return { removed: true, attempts: 1, lastError: null };
    });

    let caught: unknown = null;
    try {
      prepareRowWorkspace(input);
    } catch (error) {
      caught = error;
    }
    const message = caught instanceof Error ? caught.message : '';
    expect(message).toContain('清理上一轮的行产物失败');
    expect(message).toContain('.judgehome');
    expect(message).toContain('EPERM');
    expect(message).toContain('厂商子进程');
    // 契约错误码仍是 INTERNAL（不是把 errno 直接冒到界面）
    expect((caught as { code?: string }).code).toBe('INTERNAL');
  });

  it('瞬时占用（重试后成功）不算失败：这一行照常准备出来', () => {
    const { dir, commit } = makeRepo();
    const input = baseInput(dir, commit);
    prepareRowWorkspace(input);

    const real = realRemoveTree.fn;
    expect(real).toBeDefined();
    vi.mocked(removeTreeWithRetry).mockImplementation(((target: string, options?: Record<string, unknown>) => {
      // 真机形态：第一次 EPERM、隔 250ms 再删就成功（判据是 `attempts > 1` 时仍算 removed）
      if (target.endsWith('.judgehome')) return { removed: true, attempts: 2, lastError: null };
      return real?.(target, options);
    }) as typeof removeTreeWithRetry);

    const prepared = prepareRowWorkspace(input);
    expect(prepared.workspacePath).toContain('workspace');
  });
});

// 类型出口守卫（与 workspace-misc.test.ts 同一口径）：包根必须导出这三个类型
const typeProbe: [AppConfig | null, Logger | null, PendingAgentEvent | null] = [null, null, null];
void typeProbe;
