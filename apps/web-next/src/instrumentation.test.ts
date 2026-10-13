// @vitest-environment node
/**
 * 启动钩子：`register()` 在 node 运行时真的执行恢复（经 @aieval/api 转出到 evaluator），
 * 装停机回收（SIGTERM / SIGINT ⇒ 释放本进程在册的在途会话），在 edge 运行时什么都不做。
 * 这里**不 mock 任何模块**：要证的正是「这条 import 链真的通、api 的转出真的写了」——
 * mock 掉就等于把要证的东西假设掉了。唯一的例外是停机那一条把 `process.kill` 换成观察点：
 * 处理器最后要**重发原信号**，真发就当场杀掉测试进程（那是它的正常行为，不是缺陷）。
 * 注意测试位置：本应用只能写 `.ts` 测试（tsconfig 的 jsx 是 preserve，`.tsx` 测试跑不起来），
 * 且 vitest 的 include 只覆盖 `src/` 下任意深度的 `.test.ts`；`@/` 别名指向应用根目录（vitest.config.ts 已配好）。
 * 本文件也不能 import @aieval/evaluator / @aieval/agents（它们不在本应用的依赖里，这正是走 api 转出的原因），
 * 故 run.json 用手写 JSON 造——顺带把「磁盘上的快照形状」也钉了一遍。
 * 为什么 `setConfigDirForTesting` 能影响 `@aieval/api` 内部的 `loadConfig()`：vitest 按**解析后的
 * 绝对路径**去重模块，本文件 import 的 `@aieval/core` 与 evaluator 内部 import 的是同一个文件，
 * 因此是同一个模块实例、共享同一份 override。若哪天不是同一个实例，这个用例会以
 * 「恢复没发生」失败——那正是要暴露的问题。
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// `SETTINGS_DEFAULTS` 在 contracts（core 只转出 loadConfig / saveConfig / setConfigDirForTesting）：
// 计划里的那一行把它一起从 core import，实测解析不到（core 的出口清单里没有它）。
import { SETTINGS_DEFAULTS } from '@aieval/contracts';
import { saveConfig, setCasesRootForTesting, setConfigDirForTesting } from '@aieval/core';
import { register } from '@/instrumentation';
import { removeTreeWithRetry } from './testing/cleanup';

let root: string;
let workspaceRoot: string;
/** 用例开始前的信号监听器：停机处理器是进程级副作用，用它在 afterEach 里精确摘掉本用例加的那些 */
let listenersBefore: { SIGTERM: Set<Function>; SIGINT: Set<Function> };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'aieval-instrumentation-'));
  workspaceRoot = join(root, 'runs');
  setConfigDirForTesting(join(root, 'config'));
  // 用例目录也指到临时目录：恢复流程会按 caseId 去读用例（core 的 case-store），
  // 少了这一行它读的是真实家目录下的 ~/.aieval-cases
  setCasesRootForTesting(join(root, 'cases'));
  saveConfig({ settings: { ...SETTINGS_DEFAULTS, workspaceRoot }, providers: [] });
  listenersBefore = {
    SIGTERM: new Set(process.listeners('SIGTERM')),
    SIGINT: new Set(process.listeners('SIGINT')),
  };
});

afterEach(() => {
  setConfigDirForTesting(null);
  setCasesRootForTesting(null);
  delete process.env.NEXT_RUNTIME;
  removeTreeWithRetry(root);
  // process.kill 的观察点必须还原：留着它会把后续用例（以及同进程的其它文件）的重发信号一起吞掉
  vi.restoreAllMocks();
  // 摘掉本用例新装的停机处理器（留着会让后续用例看到多出来的监听器，而那个闭包还捏着上一轮的 api 实例）
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    for (const listener of process.listeners(signal)) {
      if (!listenersBefore[signal].has(listener)) process.removeListener(signal, listener);
    }
  }
});

/** 手写一份 run.json，返回它的路径（行状态由调用方给） */
function seedRun(rowStatuses: string[]): string {
  const runId = `run-${rowStatuses.join('-')}`;
  const dir = join(workspaceRoot, runId);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'run.json');
  writeFileSync(
    file,
    JSON.stringify({
      id: runId,
      caseId: 'case-1',
      caseTitle: '用例',
      repoPath: join(root, 'repo'),
      commitHash: null,
      // `rubric` 是快照的**必填**一格（与 caseTitle / repoPath 同口径）：缺了它 `EvalRunSchema.safeParse`
      // 失败、`listRuns()` **静默跳过**这一轮，于是 `recoverInterruptedRuns()` 的循环里根本没有它、
      // 在途行留在 `running`——本用例正是这么红的（手写快照忘了跟随新增的必填字段）。
      rubric: { groups: [{ name: '功能', items: [{ id: 'A1', goal: '转换正确', weight: 100 }] }] },
      status: 'running',
      executionMode: 'parallel',
      rows: rowStatuses.map((status, index) => ({
        id: `row-${index}`,
        agentKind: 'codex',
        providerId: 'provider-1',
        providerName: '测试供应商',
        baseUrl: 'https://fake.invalid/v1',
        modelId: 'test-model',
        status,
        branch: `test/row-${index}`,
        workspacePath: '',
        // 任意字符串都能解析成功（`EvalRowSchema.baselineCommit` 就是 `z.string()`，没有 `.min(1)`，
        // run.test.ts 明确断言「空串 = 尚未准备」合法）；这里用 40 位只是为贴近真实快照
        baselineCommit: 'a'.repeat(40),
        tokens: null,
        turns: null,
        durationMs: null,
        diff: null,
        score: null,
        error: null,
      })),
      workspaceBase: workspaceRoot,
      createdAt: '2026-09-22T10:00:00.000Z',
      startedAt: '2026-09-22T10:00:01.000Z',
      finishedAt: null,
    }),
    'utf8',
  );
  return file;
}

/** 读回快照里的行（本应用不为 run.json 再声明一套类型，故断言成最小形状即可） */
function readRows(file: string): { status: string }[] {
  const payload = JSON.parse(readFileSync(file, 'utf8')) as { rows: { status: string }[] };
  return payload.rows;
}

describe('instrumentation.register', () => {
  it('nodejs 运行时：把在途的行标成 interrupted，终态行原样（经 @aieval/api 转出调用）', async () => {
    process.env.NEXT_RUNTIME = 'nodejs';
    const file = seedRun(['judged', 'running', 'preparing', 'judging', 'failed']);

    await register();

    expect(readRows(file).map((row) => row.status)).toEqual([
      'judged',
      'interrupted',
      'interrupted',
      'interrupted',
      'failed',
    ]);
  });

  it('NEXT_RUNTIME 未设置时也执行恢复（排除 edge 而不是只认 nodejs：漏跑恢复是静默故障）', async () => {
    delete process.env.NEXT_RUNTIME;
    const file = seedRun(['running']);

    await register();

    expect(readRows(file)[0]?.status).toBe('interrupted');
  });

  it('edge 运行时什么都不做（恢复要读写磁盘，边缘运行时没有文件系统）', async () => {
    process.env.NEXT_RUNTIME = 'edge';
    const file = seedRun(['running']);

    await register();

    expect(readRows(file)[0]?.status).toBe('running');
  });

  it('没有需要恢复的行时不抛（工作区目录都还不存在）', async () => {
    process.env.NEXT_RUNTIME = 'nodejs';
    await expect(register()).resolves.toBeUndefined();
  });

  it('快照损坏也不把服务启动拖垮：register 正常返回', async () => {
    process.env.NEXT_RUNTIME = 'nodejs';
    const file = seedRun(['running']);
    writeFileSync(file, '{ 半截', 'utf8');

    await expect(register()).resolves.toBeUndefined();
  });
});

describe('instrumentation 停机回收', () => {
  it('SIGTERM / SIGINT 上各装一条：收到信号先释放在册会话，再按原信号退出', async () => {
    process.env.NEXT_RUNTIME = 'nodejs';
    // 换一个**全新的模块实例**（模块级那句「只装一次」随之复位）：这样「装了几条」是可断言的事实，
    // 而不是「本文件里之前有没有人调过 register」的运气
    vi.resetModules();
    const { register: freshRegister } = await import('@/instrumentation');
    // 重发信号会真的杀掉测试进程 ⇒ 换成观察点，只断言「重发的是哪个信号、在什么时候」
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
    // 转出口径本身也是判据：disposeLiveSessions 必须能从 api 包根取到（web-next 不许直连 agents）
    const api = await import('@aieval/api');
    expect(typeof api.disposeLiveSessions).toBe('function');

    const termBefore = new Set(process.listeners('SIGTERM'));
    const intBefore = new Set(process.listeners('SIGINT'));
    await freshRegister();
    const addedTerm = process.listeners('SIGTERM').filter((listener) => !termBefore.has(listener));
    const addedInt = process.listeners('SIGINT').filter((listener) => !intBefore.has(listener));
    expect(addedTerm).toHaveLength(1);
    expect(addedInt).toHaveLength(1);

    // 重复 register 不再加第二条（一个信号上只该有一条回收路径）
    await freshRegister();
    expect(process.listeners('SIGTERM').filter((listener) => !termBefore.has(listener))).toHaveLength(1);

    const handler = addedTerm[0];
    expect(handler).toBeTypeOf('function');
    (handler as () => void)();
    // 回收是异步的（要等在册会话走完释放）：同步这一刻还不许重发
    expect(kill).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(kill).toHaveBeenCalledWith(process.pid, 'SIGTERM');
    });
    // 自己摘掉：重发那一刻信号上只剩别人（缺省动作或宿主自己的处理器）
    expect(process.listeners('SIGTERM').filter((listener) => !termBefore.has(listener))).toHaveLength(0);
  });

  it('restore：被替掉的 process.kill 立刻还给进程', async () => {
    // 上一条用例把 process.kill 换成了观察点：它必须在本文件内还原，否则后续用例的重发信号会被吞掉
    expect(vi.isMockFunction(process.kill)).toBe(false);
  });
});
