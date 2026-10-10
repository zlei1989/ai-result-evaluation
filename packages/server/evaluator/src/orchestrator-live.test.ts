// @vitest-environment node
/**
 * 跑动期的实时数据（用户口径）：**行还在跑的时候，快照就要跟上**。
 *
 * 四条判据（A2 起回写口径**按每一条事件自己的性质**，不再按适配器在注册表里的静态声明）：
 *   ① 事件带 `tokensBasis: 'reported'` 一上报用量就**逐步回写**运行快照（tok / 轮次 / 分量）；
 *   ② 带 `'estimated'` 时**只有 `tokens` 不回写**——轮次与子智能体两格照写（它们只有权威形态）。
 *      估算的 tokens 进快照会把「没采到」说成「采到了」（快照是唯一落盘真相）；
 *   ③ **整格缺** `tokensBasis`（老适配器 / 第三方 provider 直接发事件）时按 `'estimated'` 处置：
 *      缺省落在安全侧（见 contracts 的 `tokensBasis` 注释）；
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
import { ROW_HEARTBEAT_MS, abortRow, runRow } from './orchestrator';
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
import { removeTreeWithRetry } from './testing/cleanup';

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
  /**
   * 这一次 run 的用量发射口；假适配器启动时装上（用例靠它决定「什么时候上报多少」）。
   * 第三格是**子智能体那一份**（与 `usage` 事件那一格同名）：`undefined` = 这一条
   * **没带这一格**（老版本事件），与显式的 `null`（= 明确没采到）在消费侧是**两件事**（三档）
   * ——回写快照时前者「保持旧值」、后者「清空」，所以夹具必须能把两者分别发出来。
   */
  emitUsage: null as null | ((
    tokens: { input: number; cached: number; output: number },
    turns: number,
    subagentTokens?: { input: number; cached: number; output: number } | null,
    subagentTurns?: number | null,
    /**
     * 这一条事件的 `tokensBasis`（A2）：**缺省**走 `live.emitEstimated` 开关（默认 `'reported'`），
     * 显式给值就按给的，`null` = **整格缺席**——那是「老适配器 / 第三方 provider 直接发事件」的形状
     * （本仓三家的骨架出口一律带这一格），读侧缺省的判据见下面那一条用例。
     */
    basis?: 'reported' | 'estimated' | null,
  ) => void),
  /** 放行挂起的假适配器 = 「这一行跑完了」 */
  release: null as null | (() => void),
  /** 结算值（终态写入的那一份），刻意与跑动期上报值不同，便于区分「谁写的」 */
  finalTokens: { input: 7, cached: 1, output: 9 },
  finalTurns: 4,
  /**
   * 结算值里的**子智能体那一份**（终态写入的那一份），同样刻意与跑动期上报值不同。
   * 为什么不是占位 `null`：终态与跑动期写的是**同一格**，默认取 `null` 时
   * 「跑动期写了、终态漏写」的实现照样绿——而「收尾才拿到数」正是这一格最可能的真实形状。
   * `beforeEach` 会把它复位成这个初值（有一条用例要把它改成 `null` 来钉「终态清空」）。
   *
   * ⚠️ **必须逐格 ≤ `finalTokens`**（不变量：`{6,1,1} ≤ {7,1,9}`）：这两格会被写进
   * **同一行快照**，夹具给出一个违反它的组合，就等于把一份**不可能落盘的快照**当成正常输入。
   * 同时它与跑动期上报的 `{5,1,2}` 仍**刻意不同**（输入 6≠5、输出 1≠2）——否则下面那条
   * 「终态到底写没写这一格」的断言就分不出是谁写的。
   */
  finalSubagentTokens: { input: 6, cached: 1, output: 1 } as { input: number; cached: number; output: number } | null,
  /**
   * 结算值里的**子智能体那一份轮次**：与 `finalTurns` 刻意不同（2 ≠ 4），
   * 判据是「跑动期写了、终态漏写」时断言能分得开。⚠️ 必须 ≤ `finalTurns`（同一行快照上的不变量）。
   */
  finalSubagentTurns: 2 as number | null,
  finalDurationMs: 5,
  /**
   * 这台假适配器发出去的 usage 事件**默认**带哪一种 `tokensBasis`（A2）：`false` = 厂商上报的
   * 权威值（初值，也是绝大多数用例的形状）。口径挂在**事件**上而不是 provider 的 metadata 上
   * ——回写段今天只读事件，不再反查 `capability.liveUsage`。
   */
  emitEstimated: false,
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
        // 集合形状：这一格是「智能体能接受哪些协议」，不是供应商的单值属性
        protocolTypes: ['openai'],
        // `structuredOutput` 是 `capability` 的**必填**格，这里必须照真值填（这个假 provider 声称
        // 自己是 codex，真 codex 就是 `true`）。漏掉它 `pnpm typecheck` 一个字都不会报——vitest 的
        // mock 工厂返回值不与模块类型比对——而编排层读到的是 `undefined`（falsy）⇒ **静默**走降级分支，
        // 于是「支持的适配器不该发降级日志」这类断言就建立在一个不合法的元数据字面量上
        //（判据本身还是对的，但它之所以是绿，靠的是这一格恰好缺失，而不是被测行为）。
        capability: { cancelMidTurn: true, usage: true, structuredOutput: true },
      },
      // 挂住不返回：让用例在「行还在跑」的时刻自己决定发什么用量、什么时候结束
      run: async (input: { onEvent: (event: unknown) => void }) => {
        live.emitUsage = (
          tokens,
          turns,
          subagentTokens,
          subagentTurns,
          basis = live.emitEstimated ? 'estimated' : 'reported',
        ) => {
          input.onEvent({
            seq: 1,
            at: new Date().toISOString(),
            type: 'usage',
            tokens,
            // 第 5 参显式传 `null` ⇒ 整格缺席（老适配器 / 第三方 provider 的形状，见它的类型注释）
            ...(basis === null ? {} : { tokensBasis: basis }),
            turns,
            // 这一格**按需带**：`undefined`（老事件 / 这一条不谈它）时整格缺席，而不是写成
            // `subagentTokens: undefined`——两者在 JS 里等价，但夹具的形状该与契约的三档逐格对上，
            // 读的人不必自己推「缺席与 undefined 是不是同一件事」。
            ...(subagentTokens === undefined ? {} : { subagentTokens }),
            // 轮次那一格的分量同一条处置：缺席 / 显式 null 是**两件事**（保持 / 清空）
            ...(subagentTurns === undefined ? {} : { subagentTurns }),
          });
        };
        await new Promise<void>((resolve) => {
          live.release = resolve;
        });
        return {
          ok: true,
          exitReason: 'completed',
          tokens: live.finalTokens,
          // `subagentTokens` 是 `AgentRunResult` 的**必填**格：这里交给 `live.finalSubagentTokens`
          // 驱动真值（不是占位 `null`）。为什么必须写出来（与上面那一格同一类陷阱）：
          // 本对象在 `vi.mock` 工厂里，`pnpm.cmd typecheck` 看不见它 ⇒ 漏掉这一格时编排层读到的是
          // `undefined`，既不是「有值」也不是契约里的「未采集」；而写死 `null` 会让终态漏写分量的实现照样绿。
          subagentTokens: live.finalSubagentTokens,
          // 轮次那一格的分量同样是**必填**格：漏掉它编排层读到的是 `undefined`，
          // 既不是「有值」也不是契约里的「未采集」（与上面那一格同一类陷阱）
          subagentTurns: live.finalSubagentTurns,
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
 * 为什么不是每条用例各建：`initFixtureRepo` 要付 6 个 git 进程（init / config×2 / add / commit / rev-parse），
 * 本机实测 ≈1.6s、满载更贵。本文件 5 条用例各建一次 ⇒ 光夹具就 8s 上下，而本文件墙钟在 40–90s 之间，
 * 这笔开销全落在关键路径上（口径与 `orchestrator-harness.ts` 的 `repoTemplate` 一致）。
 * 复制出来的是**独立、可用**的真仓库（带 `.git`），这一点由 `git-repo-cache.test.ts` 的 `copyWorkspace` 用例守着。
 */
let repoTemplate: { repoPath: string; commit: string } | null = null;

beforeAll(() => {
  repoTemplate = initFixtureRepo(mkdtempSync(join(tmpdir(), 'aieval-live-template-')));
});

afterAll(() => {
  if (repoTemplate !== null) removeTreeWithRetry(repoTemplate.repoPath);
});

beforeEach(() => {
  home = createTempHome();
  live.emitUsage = null;
  live.release = null;
  live.emitEstimated = false;
  // 有一条用例把它改成 `null`（钉「终态清空跑动期那个分量」）⇒ 逐用例复位成上面的初值，否则会串到后面
  // （初值逐格 ≤ `finalTokens`：`{6,1,1} ≤ {7,1,9}`，见它自己的注释）
  live.finalSubagentTokens = { input: 6, cached: 1, output: 1 };
  // 同上：「终态清空跑动期那个分量」的用例会把它改成 `null` ⇒ 逐用例复位（初值 ≤ `finalTurns`）
  live.finalSubagentTurns = 2;
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

  /**
   * 子智能体那一份在**跑动期**的回写。三条判据：
   *   · 事件带值 ⇒ 快照跟着变（与 `tokens` 同一条闸门、同一条落盘路径）；
   *   · 事件带**显式 `null`** ⇒ **清空**（读失败时同一条事件的 `tokens` 已退回主会话口径，
   *     留着旧的偏大分量会让快照满足不了 `subagentTokens ≤ tokens`）；
   *   · 事件**整格缺席**（`undefined`，老事件）⇒ **保持**已采到的那一份。
   */
  it('跑动期的 usage 事件把 subagentTokens 一并回写快照（事件带 reported）', async () => {
    const { runId, rowId } = seedRun();

    const pending = runRow(runId, rowId);
    await until(() => live.emitUsage !== null, '假适配器已启动');
    // 前提：这一格此刻是「没采到」（夹具不写它）——否则下面的断言分不清「谁写的」
    expect(getRun(runId).rows[0]?.subagentTokens ?? null).toBeNull();

    live.emitUsage?.({ input: 11, cached: 2, output: 3 }, 2, { input: 5, cached: 1, output: 2 });

    // 同步落库：事件到达的那一刻快照就该是新的（不需要等下一次轮询）
    const mid = getRun(runId).rows[0];
    expect(mid?.status).toBe('running');
    expect(mid?.subagentTokens).toEqual({ input: 5, cached: 1, output: 2 });

    live.release?.();
    await pending;
    // 终态仍以**结算值**为准（跑动期回写只是让中途可见）：这一格由 `live.finalSubagentTokens` 驱动，
    // 与跑动期上报的那一份**刻意不同**——写成同一个数就看不出终态到底写没写这一格
    expect(getRun(runId).rows[0]?.subagentTokens).toEqual(live.finalSubagentTokens);
  });

  it('显式 null 的 usage 事件把分量清成 null（读失败时合计已退回主会话口径，留着旧分量会破坏「分量 ≤ 合计」）', async () => {
    const { runId, rowId } = seedRun();

    const pending = runRow(runId, rowId);
    await until(() => live.emitUsage !== null, '假适配器已启动');

    live.emitUsage?.({ input: 11, cached: 2, output: 3 }, 2, { input: 5, cached: 1, output: 2 });
    live.emitUsage?.({ input: 11, cached: 2, output: 3 }, 3, null);

    expect(getRun(runId).rows[0]?.subagentTokens).toBeNull();

    live.release?.();
    await pending;
  });

  it('**缺这一格**（老事件 / undefined）时保持已采到的分量——与显式 null 是两件事', async () => {
    const { runId, rowId } = seedRun();

    const pending = runRow(runId, rowId);
    await until(() => live.emitUsage !== null, '假适配器已启动');

    live.emitUsage?.({ input: 11, cached: 2, output: 3 }, 2, { input: 5, cached: 1, output: 2 });
    live.emitUsage?.({ input: 11, cached: 2, output: 3 }, 3, undefined);

    expect(getRun(runId).rows[0]?.subagentTokens).toEqual({ input: 5, cached: 1, output: 2 });

    live.release?.();
    await pending;
  });

  /**
   * 终态**必须**写这一格。
   *
   * 为什么这一条比 `orchestrator-run-row` 里那条同名判据更能钉住它：这里跑动期**已经**把分量写进快照了，
   * 删掉 `measured` 里那一行之后快照会停在跑动期那个值上（`{5,1,2}`），而断言要的是 `null`
   * ——两者分得开。收尾那条 `usage` 事件会在几毫秒后被终态的 `patchRow` 覆盖（见 `TurnFinalize` 的注释），
   * 所以「只在事件里给数」的实现拿不到这个 `null`。
   */
  it('终态以适配器结果的这一格为准：结果是 null ⇒ 清掉跑动期已回写的分量', async () => {
    live.finalSubagentTokens = null;
    const { runId, rowId } = seedRun();

    const pending = runRow(runId, rowId);
    await until(() => live.emitUsage !== null, '假适配器已启动');
    live.emitUsage?.({ input: 11, cached: 2, output: 3 }, 2, { input: 5, cached: 1, output: 2 });
    expect(getRun(runId).rows[0]?.subagentTokens).toEqual({ input: 5, cached: 1, output: 2 });

    live.release?.();
    await pending;

    expect(getRun(runId).rows[0]?.subagentTokens).toBeNull();
  });

  /**
   * 轮次那一格的分量在**跑动期**的回写：三条判据与 `subagentTokens` **逐字相同**
   * （三档）——带值 ⇒ 跟着变；显式 `null` ⇒ 清空；整格缺席 ⇒ 保持。
   *
   * 为什么这一格也要单独钉：它是**另一格**，而两格的写法在同一处（`onEvent` 的 `patchRow`）——
   * 只钉用量那一格的话，「顺手复制了用量那一行、忘了轮次这一行」的实现照样全绿，
   * 而界面上「轮次」那一格的拆分行永远画不出来。
   */
  it('跑动期的 usage 事件把 subagentTurns 一并回写快照（事件带 reported）', async () => {
    const { runId, rowId } = seedRun();

    const pending = runRow(runId, rowId);
    await until(() => live.emitUsage !== null, '假适配器已启动');
    // 前提：这一格此刻是「没采到」——否则下面的断言分不清「谁写的」
    expect(getRun(runId).rows[0]?.subagentTurns ?? null).toBeNull();

    live.emitUsage?.({ input: 11, cached: 2, output: 3 }, 5, { input: 5, cached: 1, output: 2 }, 3);

    const mid = getRun(runId).rows[0];
    expect(mid?.status).toBe('running');
    expect(mid?.subagentTurns).toBe(3);
    // 与合计同刻：分量 ≤ 合计（同一行快照上的不变量）
    expect(mid?.turns).toBe(5);

    live.release?.();
    await pending;
    // 终态以**结算值**为准：`live.finalSubagentTurns`（2）与跑动期上报的 3 刻意不同
    expect(getRun(runId).rows[0]?.subagentTurns).toBe(live.finalSubagentTurns);
  });

  it('显式 null 的 usage 事件把轮次分量清成 null——与用量那一格同一条规则', async () => {
    const { runId, rowId } = seedRun();

    const pending = runRow(runId, rowId);
    await until(() => live.emitUsage !== null, '假适配器已启动');

    live.emitUsage?.({ input: 11, cached: 2, output: 3 }, 5, { input: 5, cached: 1, output: 2 }, 3);
    live.emitUsage?.({ input: 11, cached: 2, output: 3 }, 5, { input: 5, cached: 1, output: 2 }, null);

    expect(getRun(runId).rows[0]?.subagentTurns).toBeNull();

    live.release?.();
    await pending;
  });

  it('**缺这一格**（老事件 / undefined）时保持已采到的轮次分量——与显式 null 是两件事', async () => {
    const { runId, rowId } = seedRun();

    const pending = runRow(runId, rowId);
    await until(() => live.emitUsage !== null, '假适配器已启动');

    live.emitUsage?.({ input: 11, cached: 2, output: 3 }, 5, { input: 5, cached: 1, output: 2 }, 3);
    live.emitUsage?.({ input: 11, cached: 2, output: 3 }, 5, { input: 5, cached: 1, output: 2 }, undefined);

    expect(getRun(runId).rows[0]?.subagentTurns).toBe(3);

    live.release?.();
    await pending;
  });

  it('终态以适配器结果的这一格为准：结果是 null ⇒ 清掉跑动期已回写的轮次分量', async () => {
    live.finalSubagentTurns = null;
    const { runId, rowId } = seedRun();

    const pending = runRow(runId, rowId);
    await until(() => live.emitUsage !== null, '假适配器已启动');
    live.emitUsage?.({ input: 11, cached: 2, output: 3 }, 5, { input: 5, cached: 1, output: 2 }, 3);
    expect(getRun(runId).rows[0]?.subagentTurns).toBe(3);

    live.release?.();
    await pending;

    // 停在上面的 3 就说明终态漏写了这一格（跑动期那个值是旧的，而结果是「明确没采到」）
    expect(getRun(runId).rows[0]?.subagentTurns).toBeNull();
  });

  /**
   * 回写口径按每一条事件自己的 `tokensBasis`，不再按整家的
   * 静态声明。于是「估算的家」（claude-code 的跑动期读数按 assistant 消息累加）也**实时回写轮次**了
   * ——旧口径把轮次与 tokens 一起挡掉，界面因此在整个跑动期都看不到「轮到第几轮」。
   * 唯一不许进快照的仍然只有**估算的 `tokens`**：快照是唯一落盘真相，写进去会让崩溃 / 被杀的行
   * 看起来像「采到了计量」。
   */
  it('跑动期：轮次实时回写，估算的 tokens 绝不回写（A2 的新口径）', async () => {
    live.emitEstimated = true;
    const { runId, rowId } = seedRun();

    const pending = runRow(runId, rowId);
    await until(() => live.emitUsage !== null, '假适配器已启动');

    live.emitUsage?.({ input: 11, cached: 2, output: 3 }, 2);
    // 事件流里有它（界面靠 SSE 实时显示估算值），且**落盘那一格也在**（契约真的收了这一格——
    // zod 默认会把 schema 里没有的键悄悄剥掉，只在内存里拼事件的话这条断言才通不过）
    const events = readEvents(rowEventsFile(home.workspaceRoot, runId, rowId));
    const usage = events.find((event) => event.type === 'usage');
    expect(usage?.type === 'usage' ? usage.turns : null).toBe(2);
    expect(usage?.type === 'usage' ? usage.tokensBasis : null).toBe('estimated');

    // 快照里**只有轮次**——这里是「写侧」的判据：给异步实现留一拍（旧实现下两格都是 null）
    await new Promise((resolve) => setTimeout(resolve, 50));
    const mid = getRun(runId).rows[0];
    expect(mid?.status).toBe('running');
    expect(mid?.turns).toBe(2);
    expect(mid?.tokens).toBeNull();

    live.release?.();
    await pending;
    // 结算值照写：不回写估算 ≠ 终态也不写
    expect(getRun(runId).rows[0]?.tokens).toEqual(live.finalTokens);
  });

  /**
   * 读侧缺省（A2）：`tokensBasis` 在契约里是 `.optional()`，而**整格缺席**只可能来自没过骨架的
   * 老适配器 / 第三方 provider（本仓三家的出口一律带这一格）。缺省按 `'estimated'` 处置——
   * 安全侧：宁可不落盘，也不把一份「可能是估算」的数写进唯一落盘真相。
   * 轮次照旧回写：它只有权威形态（骨架里只有 `tokensEstimated` 一个标记）。
   */
  it('事件整格缺 tokensBasis（老适配器 / 第三方 provider）时按估算处置：轮次回写、tokens 不回写', async () => {
    const { runId, rowId } = seedRun();

    const pending = runRow(runId, rowId);
    await until(() => live.emitUsage !== null, '假适配器已启动');

    live.emitUsage?.({ input: 11, cached: 2, output: 3 }, 2, undefined, undefined, null);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const mid = getRun(runId).rows[0];
    expect(mid?.turns).toBe(2);
    expect(mid?.tokens).toBeNull();

    live.release?.();
    await pending;
  });

  it('跑动期每 ROW_HEARTBEAT_MS 回写已耗时；终态之后心跳必须停（不覆盖结算值）', async () => {
    // 只假 setInterval：仓库准备与 promise 调度走的仍是真实定时器（否则这个用例会卡在 git 上）
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    // 顺带钉一条：心跳**只**写耗时，不把估算顺手带进快照（估算那条路径见上一条用例）
    live.emitEstimated = true;
    const { runId, rowId } = seedRun();

    const pending = runRow(runId, rowId);
    await until(() => live.emitUsage !== null, '假适配器已启动');
    expect(getRun(runId).rows[0]?.durationMs).toBeNull();

    live.emitUsage?.({ input: 11, cached: 2, output: 3 }, 2);
    vi.advanceTimersByTime(ROW_HEARTBEAT_MS);

    // 行还在跑：耗时已经被心跳写进去了（「跑了多久」是客观事实，不是估算）。
    // 轮次是**事件**回写的（A2 起恒回写，与心跳无关），估算的 tokens 两条路径都不写
    const mid = getRun(runId).rows[0];
    expect(mid?.status).toBe('running');
    expect(mid?.durationMs).not.toBeNull();
    expect(mid?.turns).toBe(2);
    expect(mid?.tokens).toBeNull();

    live.release?.();
    await pending;
    // 终态写的是结算值（夹具给的 5ms），覆盖心跳的最后一次写入
    expect(getRun(runId).rows[0]?.durationMs).toBe(live.finalDurationMs);

    // 心跳若没被清掉，下面这几拍会拿「真实经过时间」再覆盖一次结算值
    vi.advanceTimersByTime(ROW_HEARTBEAT_MS * 4);
    expect(getRun(runId).rows[0]?.durationMs).toBe(live.finalDurationMs);
  });

  /**
   * 用户终止之后，耗时必须**冻结在终止那一刻**（用户口径）。
   *
   * 实测现场（run `8df6ff65` 的 codex 行）：`canceled` 落在 18:25:31，而快照里的 `durationMs`
   * 到 18:27:33 还在每 5 秒涨一次（`1712966 → 1722983 → 1728000`）；界面在终态读的正是快照值
   * （`MetricLine` 的实时叠加层只在 `running` 时生效）⇒ 使用者看到的是「已经点了终止，耗时还在涨」。
   *
   * 判据三条，缺一条都会留下可见的错读数：
   *   ① 结算值是**终止那一刻**（不是心跳的最后一拍）；
   *   ② 心跳**随终态当场拆掉**（不能等 `runRowAttempt` 的 `finally`——那条路要等适配器交卷）；
   *   ③ 收尾那一次写入也不许覆盖冻结值（它算的是「终止 + 收尾延迟」的墙钟）。
   *
   * 为什么用假 `Date`：只假 `setInterval` 的话，心跳每拍写出的 `Date.now() - startedAt` 都是
   * 同样几毫秒的真实时间 ⇒「心跳停了」与「心跳还在写」两种实现的读数**长得一模一样**，用例失去区分力。
   */
  it('用户终止后耗时冻结在终止那一刻：心跳当场停，收尾也不覆盖', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    const { runId, rowId } = seedRun();

    const pending = runRow(runId, rowId);
    await until(() => live.emitUsage !== null, '假适配器已启动');

    vi.advanceTimersByTime(ROW_HEARTBEAT_MS * 2);
    const beforeAbort = getRun(runId).rows[0]?.durationMs ?? null;
    expect(beforeAbort).not.toBeNull();

    // 再走 1 秒但不跨过心跳那一拍：终止时刻与「心跳最后一拍」因此有一个可辨识的差
    vi.advanceTimersByTime(1_000);
    // 假适配器不响应停止信号（它一直挂到 `live.release()`）⇒ 行任务仍等在 await 上，
    // 这正是现场的形状：状态当场落终态，而任务还远远没到收尾
    abortRow(runId, rowId);
    expect(getRun(runId).rows[0]?.status).toBe('canceled');
    const atAbort = getRun(runId).rows[0]?.durationMs ?? null;
    expect(atAbort).not.toBeNull();
    // ① 结算在「终止那一刻」，不是沿用心跳的最后一拍
    expect(atAbort).toBeGreaterThan(beforeAbort ?? 0);

    // ② 心跳必须已经停了：旧实现下这几拍会把读数一路推上去（每拍 +ROW_HEARTBEAT_MS）
    vi.advanceTimersByTime(ROW_HEARTBEAT_MS * 6);
    expect(getRun(runId).rows[0]?.durationMs).toBe(atAbort);

    // ③ 适配器终于交卷，收尾那一次写入同样不许覆盖冻结值（它算的是「终止 + 收尾延迟」的墙钟，
    //    拿它顶上去等于把使用者按终止之后又涨的那一段再演一遍）
    live.release?.();
    await pending;
    expect(getRun(runId).rows[0]?.durationMs).toBe(atAbort);
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
