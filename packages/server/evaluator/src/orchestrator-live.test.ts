// @vitest-environment node
/**
 * 跑动期的实时数据（用户口径，2026-09-26）：**行还在跑的时候，快照就要跟上**。
 *
 * 四条判据：
 *   ① `liveUsage: 'reported'` 的适配器一上报用量就**逐步回写**运行快照（tok / 轮次）；
 *   ② `liveUsage: 'estimated'` 的适配器，其跑动期用量**只走事件流、绝不回写**——终态之前快照里
 *      必须一直是 null（快照是唯一落盘真相：把估算写进去会把「没采到」说成「采到了」）；
 *   ③ **未声明** `liveUsage` 时按估算处置（缺省落在安全侧，见 agents 的 types.ts）；
 *   ④ 跑动期每 `ROW_HEARTBEAT_MS` 把**已耗时**回写快照，且行结束之后心跳必须停
 *      （不能回头覆盖终态的结算值）。
 *
 * 为什么单独一个文件：既有 `orchestrator.test.ts` 的假适配器（fixtures 里的 `fakeAgents`）
 * **不产生任何事件**，而这里的判据全在「事件到达的那一刻，磁盘上的快照变了没有」上——
 * 必须有一个能按需发事件、能挂住不结束的假适配器。
 * 工作区 / 配置 / 落盘全部复用 fixtures（真实 git 小仓库），只有适配器与评分器这两层是假的。
 */
import { randomUUID } from 'node:crypto';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Provider } from '@aieval/contracts';
import { readEvents, rowEventsFile, runSnapshotFile } from '@aieval/core';
import { ROW_HEARTBEAT_MS, runRow } from './orchestrator';
import { getRun, saveRun } from './run-store';
import {
  createTempHome,
  initFixtureRepo,
  makeCaseFixture,
  makeProviderFixture,
  makeRowFixture,
  makeRunFixture,
  seedConfig,
  type TempHome,
} from './testing/fixtures';

/**
 * 单个用例的等待上限。
 * 与 orchestrator.test.ts 的口径一致（真仓库的 clone + 复制 + checkout 在本机要几秒，
 * 默认 5 秒会把断言失败误报成超时），只是这里的余量更大：本机同时跑着真实评测（真 agent 子进程）
 * 时，一次仓库准备实测可达 45s，60s 会把「环境慢」误报成断言失败。
 * 放宽的是**等待上限**，不是断言强度。
 */
const TEST_TIMEOUT_MS = 150_000;

/**
 * 假适配器的可控状态。放 `vi.hoisted` 是因为 `vi.mock` 的工厂会被提升到文件顶部——
 * 工厂里只能引用提升过的东西。
 */
const live = vi.hoisted(() => ({
  /** 这一次 run 的用量发射口；假适配器启动时装上（用例靠它决定「什么时候上报多少」） */
  emitUsage: null as null | ((tokens: { input: number; cached: number; output: number }, turns: number) => void),
  /** 放行挂起的假适配器 = 「这一行跑完了」 */
  release: null as null | (() => void),
  /** 结算值（终态写入的那一份），刻意与跑动期上报值不同，便于区分「谁写的」 */
  finalTokens: { input: 7, cached: 1, output: 9 },
  finalTurns: 4,
  finalDurationMs: 5,
  /** 跑动期用量口径；`undefined` = 适配器没有声明（走缺省） */
  liveUsage: 'reported' as 'reported' | 'estimated' | undefined,
}));

/**
 * `importOriginal` 是必须的：`vi.mock` 是**整模块替换**，本文件只打算换掉 `getProvider`，
 * 而模块的其余导出（`acceptsProtocol` / `protocolMismatchMessage`——编排层的协议复检读它们）
 * 缺一个就会在运行时抛 `No "…" export is defined on the "@aieval/agents" mock`，
 * 表现为整行落 `failed`、报错点离真因很远（与 `testing/fixtures.ts` 的 `fakeAgentsModule` 同一口径）。
 */
vi.mock('@aieval/agents', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aieval/agents')>();
  return {
    ...actual,
    getProvider: () => ({
      kind: 'codex',
      displayName: '实时假适配器',
      metadata: {
        // 集合形状（Task 1）：这一格是「智能体能接受哪些协议」，不是供应商的单值属性
        protocolTypes: ['openai'],
        // R16：`structuredOutput` 是 `capability` 的**必填**格，这里必须照真值填（这个假 provider 声称
        // 自己是 codex，真 codex 就是 `true`）。漏掉它 `pnpm typecheck` 一个字都不会报——vitest 的
        // mock 工厂返回值不与模块类型比对——而编排层读到的是 `undefined`（falsy）⇒ **静默**走降级分支，
        // 于是「支持的适配器不该发降级日志」这类断言就建立在一个不合法的元数据字面量上
        //（判据本身还是对的，但它之所以是绿，靠的是这一格恰好缺失，而不是被测行为）。
        capability: { cancelMidTurn: true, usage: true, liveUsage: live.liveUsage, structuredOutput: true },
        isolation: 'subprocess',
      },
      // 挂住不返回：让用例在「行还在跑」的时刻自己决定发什么用量、什么时候结束
      run: async (input: { onEvent: (event: unknown) => void }) => {
        live.emitUsage = (tokens, turns) => {
          input.onEvent({ seq: 1, at: new Date().toISOString(), type: 'usage', tokens, turns });
        };
        await new Promise<void>((resolve) => {
          live.release = resolve;
        });
        return {
          ok: true,
          exitReason: 'completed',
          tokens: live.finalTokens,
          turns: live.finalTurns,
          durationMs: live.finalDurationMs,
        };
      },
    }),
    listAgentProviders: () => [],
  };
});

/**
 * 评分器换成假实现：本文件测的是「跑动期快照」，评分的正确性有它自己的用例。
 * `makeScore` 的第一个参数是**是否全达成**（布尔），不是旧体系的分数：判据换成逐项二元判定之后，
 * 中间分不存在了（全达成 ⇒ 满分 30）。
 */
vi.mock('./judge', async () => {
  const { makeScoreFixture: makeScore } = await import('./testing/fixtures');
  return {
    judgeRow: async (input: { judgeProviderId: string; route: { modelId: string } }) =>
      makeScore(true, input.judgeProviderId, input.route.modelId),
  };
});

let home: TempHome;

/**
 * 夹具仓库模板：`beforeAll` 建一次，每条用例 `cpSync` 一份。
 *
 * 为什么不是每条用例各建：`initFixtureRepo` 要付 7 个 git 进程（init / config×2 / add / commit / rev-parse），
 * 本机实测 ≈1.6s、满载更贵。本文件 5 条用例各建一次 ⇒ 光夹具就 8s 上下，而本文件墙钟在 40–90s 之间，
 * 这笔开销全落在关键路径上（口径与 `orchestrator-harness.ts` 的 `repoTemplate` 一致）。
 * 复制出来的是**独立、可用**的真仓库（带 `.git`），这一点由 `git.repo.test.ts` 的 `copyWorkspace` 用例守着。
 */
let repoTemplate: { repoPath: string; commit: string } | null = null;

beforeAll(() => {
  repoTemplate = initFixtureRepo(mkdtempSync(join(tmpdir(), 'aieval-live-template-')));
});

afterAll(() => {
  if (repoTemplate !== null) rmSync(repoTemplate.repoPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

beforeEach(() => {
  home = createTempHome();
  live.emitUsage = null;
  live.release = null;
  live.liveUsage = 'reported';
});

afterEach(() => {
  // 心跳用例会装假定时器（只假 setInterval）：无论用例怎么结束都要还原，否则会串到后面
  vi.useRealTimers();
  home.cleanup();
  vi.restoreAllMocks();
});

/** 等一个条件成立（同 orchestrator.test.ts：轮询到成立为止，超时带标签抛错） */
async function until(condition: () => boolean, label: string, timeoutMs = 10_000): Promise<void> {
  const attempts = Math.max(1, Math.ceil(timeoutMs / 10));
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`等待超时（${timeoutMs}ms）：${label}`);
}

/** 造一轮真实可跑的单行评测（真实 git 小仓库 + 已落盘的供应商 / 用例 / 轮次） */
function seedRun(): { runId: string; rowId: string } {
  // 模板副本（见 repoTemplate）：真仓库、独立路径、内容与模板逐字节相同，省下 7 个 git 进程
  const repoPath = join(home.root, `repo-${randomUUID()}`);
  if (repoTemplate === null) throw new Error('模板仓库还没建出来（见本文件的 beforeAll）');
  cpSync(repoTemplate.repoPath, repoPath, { recursive: true });
  const fixtureRepo = { repoPath, commit: repoTemplate.commit };
  const provider: Provider = makeProviderFixture({
    models: [
      { id: 'test-model', source: 'manual' },
      { id: 'judge-model', source: 'manual' },
    ],
  });
  const testCase = makeCaseFixture({ repoPath: fixtureRepo.repoPath, commitHash: fixtureRepo.commit });
  seedConfig({
    workspaceRoot: home.workspaceRoot,
    providers: [provider],
    cases: [testCase],
    defaultJudge: { providerId: provider.id, modelId: 'judge-model' },
  });
  const row = makeRowFixture({
    agentKind: 'codex',
    providerId: provider.id,
    providerName: provider.name,
    baseUrl: provider.baseUrl,
  });
  const run = makeRunFixture({
    workspaceRoot: home.workspaceRoot,
    caseId: testCase.id,
    repoPath: fixtureRepo.repoPath,
    commitHash: fixtureRepo.commit,
    rows: [row],
  });
  saveRun(run);
  return { runId: run.id, rowId: row.id };
}

describe('跑动期的实时数据', { timeout: TEST_TIMEOUT_MS }, () => {
  it('权威用量（reported）一到就写进快照：行还在跑时就能看到 tok / 轮次', async () => {
    live.liveUsage = 'reported';
    const { runId, rowId } = seedRun();

    const pending = runRow(runId, rowId);
    await until(() => live.emitUsage !== null, '假适配器已启动');
    // 前提：这一行确实还在跑，且此刻快照里没有任何用量（否则下面的断言无法区分「谁写的」）
    const before = getRun(runId).rows[0];
    expect(before?.status).toBe('running');
    expect(before?.tokens).toBeNull();

    live.emitUsage?.({ input: 11, cached: 2, output: 3 }, 2);

    // 同步落库：事件到达的那一刻快照就该是新的（不需要等下一次轮询）
    const mid = getRun(runId).rows[0];
    expect(mid?.status).toBe('running');
    expect(mid?.tokens).toEqual({ input: 11, cached: 2, output: 3 });
    expect(mid?.turns).toBe(2);

    live.release?.();
    await pending;
    // 终态仍以**结算值**为准（逐步回写只是让中途可见，不改变最终口径）
    expect(getRun(runId).rows[0]?.tokens).toEqual(live.finalTokens);
    expect(getRun(runId).rows[0]?.turns).toBe(live.finalTurns);
  });

  it('实时估算（estimated）只走事件流、绝不回写快照：终态之前一直是 null', async () => {
    live.liveUsage = 'estimated';
    const { runId, rowId } = seedRun();

    const pending = runRow(runId, rowId);
    await until(() => live.emitUsage !== null, '假适配器已启动');

    live.emitUsage?.({ input: 11, cached: 2, output: 3 }, 2);
    // 事件流里有它（界面靠 SSE 实时显示）
    const events = readEvents(rowEventsFile(home.workspaceRoot, runId, rowId));
    expect(events.some((event) => event.type === 'usage' && event.turns === 2)).toBe(true);

    // 快照里没有它——这里是「写侧」的判据：给异步实现留一拍，仍然必须是 null
    await new Promise((resolve) => setTimeout(resolve, 50));
    const mid = getRun(runId).rows[0];
    expect(mid?.status).toBe('running');
    expect(mid?.tokens).toBeNull();
    expect(mid?.turns).toBeNull();

    live.release?.();
    await pending;
    // 结算值照写：不回写估算 ≠ 终态也不写
    expect(getRun(runId).rows[0]?.tokens).toEqual(live.finalTokens);
  });

  it('适配器没有声明 liveUsage 时按估算处置（缺省落在安全侧：不回写）', async () => {
    live.liveUsage = undefined;
    const { runId, rowId } = seedRun();

    const pending = runRow(runId, rowId);
    await until(() => live.emitUsage !== null, '假适配器已启动');

    live.emitUsage?.({ input: 11, cached: 2, output: 3 }, 2);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(getRun(runId).rows[0]?.tokens).toBeNull();

    live.release?.();
    await pending;
  });

  it('跑动期每 ROW_HEARTBEAT_MS 回写已耗时；终态之后心跳必须停（不覆盖结算值）', async () => {
    // 只假 setInterval：仓库准备与 promise 调度走的仍是真实定时器（否则这个用例会卡在 git 上）
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    // 顺带钉一条：心跳**只**写耗时，不把估算顺手带进快照（估算那条路径见上一条用例）
    live.liveUsage = 'estimated';
    const { runId, rowId } = seedRun();

    const pending = runRow(runId, rowId);
    await until(() => live.emitUsage !== null, '假适配器已启动');
    expect(getRun(runId).rows[0]?.durationMs).toBeNull();

    live.emitUsage?.({ input: 11, cached: 2, output: 3 }, 2);
    vi.advanceTimersByTime(ROW_HEARTBEAT_MS);

    // 行还在跑：耗时已经被心跳写进去了（「跑了多久」是客观事实，不是估算），而计量仍是 null
    const mid = getRun(runId).rows[0];
    expect(mid?.status).toBe('running');
    expect(mid?.durationMs).not.toBeNull();
    expect(mid?.tokens).toBeNull();
    expect(mid?.turns).toBeNull();

    live.release?.();
    await pending;
    // 终态写的是结算值（夹具给的 5ms），覆盖心跳的最后一次写入
    expect(getRun(runId).rows[0]?.durationMs).toBe(live.finalDurationMs);

    // 心跳若没被清掉，下面这几拍会拿「真实经过时间」再覆盖一次结算值
    vi.advanceTimersByTime(ROW_HEARTBEAT_MS * 4);
    expect(getRun(runId).rows[0]?.durationMs).toBe(live.finalDurationMs);
  });

  /**
   * 心跳写入失败时**自停**，绝不把异常冒到定时器外。
   *
   * 为什么必须有这一条：心跳是「锦上添花」的写入（终态那一次才是权威值），而它跑在 `setInterval`
   * 回调里——那里抛出的异常**没有任何调用方能接住**，会变成进程级未捕获异常
   * （实测：全量测试里 573 条 `ServiceError: 评测不存在`，vitest 直接警告「可能造成假阳/假阴」；
   * 生产上则可能打崩 dev server）。触发条件真实存在：快照被清掉、根目录被改走、磁盘满。
   */
  it('心跳写入失败（快照已不存在）时自停，不把异常抛到定时器外', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const { runId, rowId } = seedRun();

    const pending = runRow(runId, rowId);
    await until(() => live.emitUsage !== null, '假适配器已启动');

    vi.advanceTimersByTime(ROW_HEARTBEAT_MS);
    expect(getRun(runId).rows[0]?.durationMs).not.toBeNull();

    // 把快照从磁盘上拿掉：等价于「这一轮被清理 / 根目录被改走」（patchRow 会抛 NOT_FOUND）
    rmSync(runSnapshotFile(home.workspaceRoot, runId), { force: true });

    // 旧实现：这个异常直接从定时器回调里冒出来（`advanceTimersByTime` 会把它抛给本行）
    expect(() => vi.advanceTimersByTime(ROW_HEARTBEAT_MS)).not.toThrow();
    // 自停之后就算再推进几拍也什么都不做（不会反复抛）
    expect(() => vi.advanceTimersByTime(ROW_HEARTBEAT_MS * 3)).not.toThrow();

    live.release?.();
    // 快照没了 ⇒ 编排层收尾也会失败，但那是它自己的失败面（记 ERROR、绝不上抛），这里照常返回
    await pending;
  });
});
