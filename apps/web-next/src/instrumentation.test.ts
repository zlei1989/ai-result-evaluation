// @vitest-environment node
/**
 * 启动钩子：`register()` 在 node 运行时真的执行恢复（经 @aieval/api 转出到 evaluator），
 * 在 edge 运行时什么都不做。
 * 这里**不 mock 任何模块**：要证的正是「这条 import 链真的通、api 的转出真的写了」——
 * mock 掉就等于把要证的东西假设掉了。
 * 注意测试位置：本应用只能写 `.ts` 测试（tsconfig 的 jsx 是 preserve，`.tsx` 测试跑不起来），
 * 且 vitest 的 include 只覆盖 `src/` 下任意深度的 `.test.ts`；`@/` 别名指向应用根目录（vitest.config.ts 已配好）。
 * 本文件也不能 import @aieval/evaluator（它不在本应用的依赖里，这正是走 api 转出的原因），
 * 故 run.json 用手写 JSON 造——顺带把「磁盘上的快照形状」也钉了一遍。
 * 为什么 `setConfigDirForTesting` 能影响 `@aieval/api` 内部的 `loadConfig()`：vitest 按**解析后的
 * 绝对路径**去重模块，本文件 import 的 `@aieval/core` 与 evaluator 内部 import 的是同一个文件，
 * 因此是同一个模块实例、共享同一份 override。若哪天不是同一个实例，这个用例会以
 * 「恢复没发生」失败——那正是要暴露的问题。
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// `SETTINGS_DEFAULTS` 在 contracts（core 只转出 loadConfig / saveConfig / setConfigDirForTesting）：
// 计划里的那一行把它一起从 core import，实测解析不到（core 的出口清单里没有它）。
import { SETTINGS_DEFAULTS } from '@aieval/contracts';
import { saveConfig, setConfigDirForTesting } from '@aieval/core';
import { register } from '@/instrumentation';
import { removeTreeWithRetry } from './testing/cleanup';

let root: string;
let workspaceRoot: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'aieval-instrumentation-'));
  workspaceRoot = join(root, 'runs');
  setConfigDirForTesting(join(root, 'config'));
  saveConfig({ settings: { ...SETTINGS_DEFAULTS, workspaceRoot }, providers: [], cases: [] });
});

afterEach(() => {
  setConfigDirForTesting(null);
  delete process.env.NEXT_RUNTIME;
  removeTreeWithRetry(root);
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
        // p0 的 run.test.ts 明确断言「空串 = 尚未准备」合法）；这里用 40 位只是为贴近真实快照
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
