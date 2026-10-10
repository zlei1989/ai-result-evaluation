// @vitest-environment node
/**
 * 单行执行与失败面。
 *
 * 智能体用假注册表（`vi.mock('@aieval/agents')`）：编排层对智能体的**唯一**入口就是
 * `getProvider(kind).run()`，换掉这个模块边界就完全控制了「什么时候开始、什么时候结束、
 * 是否响应终止、返回什么计量」，且不会加载任何厂商 SDK（A6 的懒加载根本不会被触发）。
 * 为什么不选 `setAgentRuntimeForTesting({ sdkModule })`：那条路注入的是**厂商 SDK 的假模块**，
 * 真正的执行仍要穿过三家适配器的实现与事件归一化——测出来的是「适配器 + 本层编排」
 * 的耦合体，超时与终止的时序还要绕过适配器自己的释放窗口，用例会又慢又脆。
 * 适配器本身由假实现单独测；本层把适配器当作已被验证过的边界。
 *
 * 评分用假 judgeRow（`vi.mock('./judge')`）：本文件测的是编排时序与落盘，
 * 评分器的行为有它自己的测试。
 * 工作区用**真实** git 小仓库：「每行独立工作区」必须建立在真实目录上。
 *
 * 每个用例显式放宽到 `TEST_TIMEOUT_MS`：真仓库的 `git clone` + 目录复制 + `checkout` 在本机
 * 实测单个用例 2–7 秒（Windows 上 git 进程启动 + 杀软实时扫描），而 vitest 的默认上限是 5 秒——
 * 不显式放宽的话失败信息会是「Test timed out in 5000ms」，把「到底哪条断言不成立」整个盖掉
 * （实测踩过：9 个用例全被误报成超时，真正原因藏在下面）。放宽的是**等待上限**，不是断言强度。
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, expect, vi } from 'vitest';
import type { AgentKind, AgentMessage, EvalRun, McpServers, Provider, SubagentRecord } from '@aieval/contracts';
import {
  caseCacheDir,
  foldMessages,
  foldSubagents,
  readEvents,
  readRowRecords,
  rowAttemptsFile,
  rowEventsFile,
  rowMessagesFile,
} from '@aieval/core';
import { ROW_RETRY } from '../orchestrator';
import { getRun, saveRun } from '../run-store';
import type { TextRoute } from '../text-api';
import {
  createTempHome,
  fakeAgents,
  initFixtureRepo,
  makeCaseFixture,
  makeProviderFixture,
  makeRowFixture,
  makeRunFixture,
  makeScoreFixture,
  resetFakeAgents,
  resetFakeJudge,
  seedConfig,
  type TempHome,
} from './fixtures';
import { removeTreeWithRetry } from './cleanup';

/** 单个用例的等待上限（见文件头：真仓库准备在本机要几秒，默认 5 秒会把断言失败误报成超时） */
export const TEST_TIMEOUT_MS = 60_000;

/** 行的**终态**：落定之后不会再有任何进展，等待只会烧预算（判据见 `until` 的 `impossible`） */
const SETTLED_ROW_STATUS = new Set(['judged', 'failed', 'canceled', 'skipped', 'interrupted', 'timed-out']);

/** 这一行是否已经落终态（给 `until` 的第 4 参用：等一个终态期望时，落成别的终态就是真失败） */
export function rowSettled(runId: string, rowId: string): boolean {
  const row = getRun(runId).rows.find((item) => item.id === rowId);
  return row !== undefined && SETTLED_ROW_STATUS.has(row.status);
}

/**
 * 等一个条件成立（只用于「假适配器已经进入挂起态」这类测试内同步点）。
 * 为什么不用固定 sleep：那是在赌夹具的调度，机器一慢就假红；这里轮询到条件成立为止，
 * 且超时会带标签抛错，排查时一眼看出等的是什么。
 * 上限默认 5 秒，轮级用例按需放宽：真仓库复制在本机要几秒（见文件头），「三行都启动」这类
 * 条件在满载时会超过 5 秒；而「有界时间」判据要的**不是**更短的上限，是「有没有上限」。
 *
 * `impossible`（可选，第 4 参）：**条件已经不可能成立**的判据——每轮先问它，成立就立刻抛错。
 * 为什么需要它：上限是按「宁可超时也不假红」定的（60s / 300s），而真失败时它会把整个预算烧完：
 * 实测一次全量里 12 条红 = 5×300s + 7×60s = **32 分钟**，占那次墙钟的 79%。
 * 上限一并保持不变——要的是「失败得快」，不是「等得久」。
 *
 * 只给**终态期望**的等待接 `impossible`（例如「重评之后该行回到 judged」：它落成别的终态就是真失败）。
 * 「同步点」式的等待（等某行进入 running 再动手）**刻意不接**：行可能比轮询更快地走过那个瞬时状态，
 * 拿「已落定」当「不可能」会把一次错过观察判成产品缺陷（本仓最不能接受的就是假红）。
 */
export async function until(
  condition: () => boolean,
  label: string,
  timeoutMs = 5_000,
  impossible?: () => boolean,
): Promise<void> {
  const attempts = Math.max(1, Math.ceil(timeoutMs / 10));
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (condition()) return;
    if (impossible?.() === true) {
      throw new Error(`等待中断（${label}）：条件已不可能成立——被测对象已落终态，等下去只会烧完 ${timeoutMs}ms 预算`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`等待超时（${timeoutMs}ms）：${label}`);
}



/**
 * 注入接缝（落盘失败 / 陈旧列表）与三条 mock 的工厂体都在 `./orchestrator-seams`：
 * 那里写明了为什么它必须是一个**不 import 被 mock 模块**的独立模块——工厂与 harness 互相 import
 * 会构成循环，表现是整个文件 0 个用例且没有任何报错（静默挂死）。
 * 这里只把它 import 进来（`registerOrchestratorHooks` 要复位它）并转发给各测试文件。
 */
import { injected } from './orchestrator-seams';




/**
 * 产品默认的重试预算（`ROW_RETRY` 的初值）。
 * 为什么在 `beforeEach` 里把它关掉：**自动重试会把每一条「失败面」用例都变成 N 倍时长**
 * （每条重试都重跑一次真仓库的准备：`git` 进程 + 目录复制，本机实测 2–7 秒）。
 * 关掉之后既有的失败面用例回到「一次就落终态」的原本时序，而重试本身由
 * 「瞬时失败的自动重试」那一组**显式打开**它来验证——两组各测各的，互不拖慢。
 * 值取产品默认值而不是写死 2：改默认值时这一组跟着变，不会静默失配。
 */
export const PRODUCTION_ROW_RETRIES = ROW_RETRY.maxRetries;
/** 产品默认的退避（与上面同理：会在 `beforeEach` 里被压到 1ms） */
export const PRODUCTION_ROW_RETRY_DELAY_MS = ROW_RETRY.delayMs;

export let home: TempHome;



/**
 * 夹具模板（`beforeAll` 建**一次**，每条用例 `cpSync` 一份）。
 *
 * 为什么不是每个用例各建一个：本机的计价单位是**进程创建**（实测 `git --version` 566ms、
 * `node --version` 530ms、`cmd /c exit 0` 162ms —— 企业 DLP/EDR 在每个新进程上挂钩），
 * 而 `initFixtureRepo`（init + config×2 + add + commit + rev-parse）= **1612ms**、
 * 一次真 `git clone`（用例缓存的首次建立）= **1053ms**。86 条用例照原样各付一次 ⇒ 光夹具就 ~230s，
 * 正是「每跑一个文件都要等好几分钟」的主要来源。`cpSync` 一份仓库实测 ~10ms，且复制出来的
 * 仍是**独立、可用**的真实仓库（`git-repo-cache.test.ts` 的 `copyWorkspace` 用例守的正是这件事）。
 */
let repoTemplate: { repoPath: string; commit: string } | null = null;
/** 预热用的用例缓存：真克隆一次，各用例 `cpSync` 到自己的 `caseCacheDir` */
let cacheTemplate: string | null = null;

/** 模板仓库的一份独立副本（真仓库，带 `.git`，可 checkout） */
function copyRepoTemplate(dest: string): string {
  if (repoTemplate === null) throw new Error('模板仓库还没建出来（registerOrchestratorHooks 的 beforeAll 负责）');
  cpSync(repoTemplate.repoPath, dest, { recursive: true });
  return dest;
}

/**
 * 要一个「**工作仓库**」（而不是裸远端）的用例用它：模板的一份副本 + 它的 commit。
 * 与 `makeBareRemote` 的区别只在最终形态（这个是可提交的工作树）。
 * 存在的意义同样是省掉 `initFixtureRepo` 的 6 个 git 进程（≈1.6s，满载更贵）。
 */
export function makeWorkRepo(name: string): { repoPath: string; commit: string } {
  const repoPath = copyRepoTemplate(join(home.root, name));
  return { repoPath, commit: repoTemplate?.commit ?? '' };
}

/**
 * 预热这一轮的**用例缓存**：把模板缓存复制到 `caseCacheDir(workspaceRoot, caseId)`，
 * 并把来源记录指向**这条用例自己的**仓库路径。
 *
 * 为什么来源记录必须改写：`ensureCaseCache` 拿 `realpathSync(repoPath)` 与记录比对，
 * 记录里留着模板路径就会被判成「来源已变」→ 重新克隆，预热白做（而且还慢）。
 * 为什么只对**钉死 commit** 的轮次预热：`commitHash === null` 的语义是「跟随来源 tip」，
 * 走 `refreshCacheToSourceHead → fetch origin`，而预热出的缓存 `origin` 指向模板而不是本用例的仓库——
 * 语义会漂（`workspace.test.ts` 里有专门守这条语义的用例）。那些轮次继续走真克隆。
 */
function prewarmCaseCache(caseId: string, repoPath: string, commit: string): void {
  if (cacheTemplate === null) throw new Error('模板缓存还没建出来（registerOrchestratorHooks 的 beforeAll 负责）');
  // 来源**不是** git 仓库时不预热：那几条失败面用例（「仓库不是 git 仓库」）要的正是产品在
  // 准备阶段撞上这个坏来源；预热出一份现成的缓存会让它们静默变成绿（实测踩到过一次）。
  if (!existsSync(join(repoPath, '.git'))) return;
  const target = caseCacheDir(home.workspaceRoot, caseId);
  mkdirSync(join(target, '..'), { recursive: true });
  cpSync(cacheTemplate, target, { recursive: true });
  const origin = { repoPath: realpathSync(repoPath), tip: commit, recordedAt: new Date().toISOString() };
  writeFileSync(join(target, '.git', 'aieval-origin.json'), `${JSON.stringify(origin)}\n`, 'utf8');
}

/**
 * 注册本文件集的公共钩子：夹具模板、临时家目录、假适配器/假评分器复位、重试预算复位。
 * 为什么做成函数而不是模块级直接调用：harness 被 10 个测试文件共享，
 * 钩子必须注册在**调用它的那个测试文件**的 suite 上，显式调用才不会依赖 import 时序。
 */
export function registerOrchestratorHooks(): void {
  /**
   * 钩子显式给上限：vitest 的 `hookTimeout` 默认 **10s**，而这里的 `beforeAll` 要建一个真仓库模板
   * （7 次 git 进程）+ 克隆一次缓存——本机满载时超过 10s，表现是**整个文件**以
   * `Hook timed out in 10000ms` 收场（实测一次全量里 10 个文件一起红、80 条用例被标 skip）。
   * 上限口径与用例一致（`TEST_TIMEOUT_MS`）：真正的死循环仍会被挡住，机器慢一点不再变成假红。
   */
  beforeAll(() => {
    // 两个模板刻意**不**走 makeTmp（那是 fixtures 里的私有助手）：它们必须活过每一个 afterEach，
    // 清理归下面的 afterAll —— 与 `git-repo-*.test.ts` / `git-diff-*.test.ts` 同一口径。
    const repo = initFixtureRepo(mkdtempSync(join(tmpdir(), 'aieval-orch-repo-template-')));
    repoTemplate = repo;
    const cache = mkdtempSync(join(tmpdir(), 'aieval-orch-cache-template-'));
    cacheTemplate = cache;
    // `core.autocrlf=false` 同 `gitIn`：这份预热缓存模拟的是产品自己的 `cloneCaseCache`
    //（它走 core 的 `execute`，总是带这个 `-c`）——不带就会产出 CRLF 工作树，
    // 让每一行「一个字节都没改」的准备阶段 diff 变成非空（见 fixtures.ts 的 `runGit`）。
    execFileSync('git', ['-c', 'core.autocrlf=false', 'clone', '--quiet', repo.repoPath, cache], { cwd: tmpdir(), encoding: 'utf8' });
  }, TEST_TIMEOUT_MS);
  afterAll(() => {
    for (const dir of [repoTemplate?.repoPath ?? null, cacheTemplate]) {
      // 模板目录里刚跑过 git（`initFixtureRepo` / `clone`）⇒ 清理同样要走带真实重试的那条路
      if (dir !== null) removeTreeWithRetry(dir);
    }
  }, TEST_TIMEOUT_MS);
  beforeEach(() => {
    home = createTempHome();
    resetFakeAgents();
    resetFakeJudge();
    // 自动重试：默认关（见 PRODUCTION_ROW_RETRIES 的注释），退避压到 1ms
    ROW_RETRY.maxRetries = 0;
    ROW_RETRY.delayMs = 1;
    // 注入接缝是模块级状态：不在这里复位的话会串到下一个用例（同文件共享一个模块实例）
    injected.failRunStatusSaveFor = null;
    injected.runStatusSaveFailed = false;
    injected.staleList = null;
    injected.failRowSaveFor = null;
    injected.rowSaveFailed = false;
  });
  afterEach(() => {
    // 还原成产品默认值：下一个用例（以及同进程的其它文件）不该继承本次的等待时间与预算
    ROW_RETRY.maxRetries = PRODUCTION_ROW_RETRIES;
    ROW_RETRY.delayMs = 3_000;
    home.cleanup();
    vi.restoreAllMocks();
  });
}


/** 造一轮真实可跑的评测：真实 git 小仓库 + 已落盘的供应商 / 用例 / 轮次 */
export function seedRunnableRun(options: {
  rowCount: number;
  executionMode: 'parallel' | 'serial';
  diffBudgetBytes?: number;
  withJudge?: boolean;
  agentKind?: AgentKind;
  repoPath?: string;
  /**
   * 轮快照里钉死的 commit。
   * 默认是**本文件另一个**夹具仓库（`repoPath` 没被覆盖时的那个）的 tip；远端来源的用例必须显式传 `null`：
   * 远端轮次只认镜像里的对象，而「另一个仓库的 hash」在镜像里根本不存在 —— 那会让每一行都以
   * `INVALID_REF`（commit 不存在）失败，测出来的是夹具的自相矛盾而不是被测语义。
   */
  commitHash?: string | null;
  /** 用例 / 轮快照里的分支（`null` = 远端默认分支；本地来源不填） */
  repoBranch?: string | null;
  /** 这一轮是否由评分智能体评分（`EvalRun.useAgentJudge`，第 7 步的分支） */
  useAgentJudge?: boolean;
  /**
   * 全局默认评分智能体（`settings.defaultJudgeAgent`）。
   * `undefined` = 本用例不关心（与 `null` 同路：不配）；显式 `null` 是「开关打开了但没配评分智能体」
   * 那个失败面要用到的取值。给了非 null 的 kind 时，`defaultJudge` 会自动指向一条 **anthropic**
   * 供应商——`claude-code` 只吃 anthropic（`dsh` 两条都吃），
   * 配错协议会让那几条以「协议不匹配」变红，而那是 `judgeAgentKind: 'codex'` 才要测的东西。
   * 评分模型那一对刻意留在 anthropic 上：这样「评分智能体协议不匹配」这条才有靶子。
   */
  judgeAgentKind?: AgentKind | null;
  /**
   * 设置页那份 **MCP 条目**：写进临时配置的 `settings.mcpServers`。
   * 不填 = 用契约的预置两项（与 `seedConfig` 同口径）——要测「一台都没配」的用例显式传 `{}`。
   */
  mcpServers?: McpServers;
}): { run: EvalRun; provider: Provider } {
  // 夹具仓库走模板副本（见 repoTemplate 的说明）：真仓库、独立路径、内容与模板逐字节相同，
  // 因此 commit 也相同 —— 省下每次 7 个 git 进程。
  const fixtureRepo = { repoPath: copyRepoTemplate(join(home.root, `repo-${randomUUID()}`)), commit: repoTemplate?.commit ?? '' };
  const repoPath = options.repoPath ?? fixtureRepo.repoPath;
  // `undefined` 才是「没给」：显式传 null 是远端用例的「不钉 commit」语义，不能被 `??` 兜掉
  const commitHash = options.commitHash === undefined ? fixtureRepo.commit : options.commitHash;
  // 模型清单要同时含假适配器用的 `test-model`（makeRowFixture 的默认）与全局默认评分模型
  // 用的 `judge-model`：`resolveJudgeRoute` 会核对「这个模型在不在这条供应商的清单里」，
  // 少了它每一行都会在评分前落 CONFLICT——那样测出来的就不是编排时序，而是夹具自己的缺口。
  const provider = makeProviderFixture({
    models: [
      { id: 'test-model', source: 'manual' },
      { id: 'judge-model', source: 'manual' },
    ],
  });
  const testCase = makeCaseFixture({
    repoPath,
    commitHash,
    repoBranch: options.repoBranch ?? null,
  });
  // 评分智能体那一格：给了 kind 就另造一条 **anthropic** 供应商来配它（理由见 `judgeAgentKind` 的注释）。
  // 模型 id 仍叫 `judge-model`：本文件的评分用例只关心「谁去驱动这把尺子」，不关心模型叫什么。
  const judgeAgent = options.judgeAgentKind ?? null;
  const judgeProvider =
    judgeAgent === null
      ? provider
      : makeProviderFixture({
        name: '评分智能体专用的评分供应商',
        protocolType: 'anthropic',
        // 与默认那家**不同的 baseUrl**：接缝用例靠「baseUrl + apiKey + modelId 三样联合唯一」
        // 从路由反查供应商（`providerOfRoute`），同址两家会让那类断言「必须唯一命中」直接崩
        baseUrl: 'https://fake.invalid/anthropic',
        models: [{ id: 'judge-model', source: 'manual' }],
      });
  seedConfig({
    workspaceRoot: home.workspaceRoot,
    providers: [provider, ...(judgeProvider === provider ? [] : [judgeProvider])],
    cases: [testCase],
    diffBudgetBytes: options.diffBudgetBytes,
    defaultJudgeAgent: judgeAgent,
    // 评分模型只有这一个来源（用例级覆盖已删除）：`withJudge: false` 造的就是「没配全局默认」那个失败面
    defaultJudge: options.withJudge === false ? null : { providerId: judgeProvider.id, modelId: 'judge-model' },
    ...(options.mcpServers === undefined ? {} : { mcpServers: options.mcpServers }),
  });
  const rows = Array.from({ length: options.rowCount }, () =>
    makeRowFixture({
      agentKind: options.agentKind ?? 'codex',
      providerId: provider.id,
      providerName: provider.name,
      baseUrl: provider.baseUrl,
    }),
  );
  const run = makeRunFixture({
    workspaceRoot: home.workspaceRoot,
    caseId: testCase.id,
    executionMode: options.executionMode,
    useAgentJudge: options.useAgentJudge ?? false,
    rows,
    repoPath,
    commitHash,
    repoBranch: options.repoBranch ?? null,
  });
  // 钉死 commit 的轮次：把用例缓存**预热**好（见 prewarmCaseCache），省掉 `prepareRowWorkspace`
  // 里那次真 `git clone`（实测 1053ms/用例）。`commitHash === null` 的轮次不预热——语义会漂。
  if (commitHash !== null) prewarmCaseCache(testCase.id, repoPath, commitHash);
  saveRun(run);
  return { run, provider };
}

/**
 * 一份合法的评分 JSON 答复：智能体通路的 finalText 用它。
 * 判定形状走 `makeScoreFixture`（与文本通路**同一份夹具、同一张评分表**）：手抄一份引用键，
 * 迟早会与 `RUBRIC_FIXTURE` 漂移，而漂移的表现是「智能体通路莫名其妙缺项失败」。
 * 只取 `judgments` / `verdict` 两格：智能体回的是**模型答复**，不是一份完整的 ScoreResult
 * （总分由我们算，契约第 5 条也要求模型不给总分）。
 */
export function judgeReplyJson(achieved = true): string {
  const { judgments, verdict } = makeScoreFixture(achieved);
  return JSON.stringify({ judgments, verdict });
}



/**
 * 「这一分是哪把尺子打的」的接缝守卫：`resolveJudgeRoute()` 解析出的路由与编排层记在行上的
 * `judgeProviderId` 必须指向**同一家供应商**（`TextRoute` 不带 providerId，
 * 两者只能靠守卫钉住不漂移）。
 * 契约依据：`docs/architecture/contracts.md`（契约体系）。
 *
 * 尺子的来源已经收成**一个**（用例级覆盖于 2026-09 删除）：两处都读 `settings.defaultJudge`。
 * 守卫照旧不能只跟「测试自己的期望值」比——那样两边可能一起错。这里从 `route` **反查**供应商
 * （baseUrl + apiKey + modelId 三样联合唯一，见 `providerOfRoute`），再与编排层记录的值比对——
 * 两个值各自独立算出来，相等才叫恒等。
 */
export function providerOfRoute(route: TextRoute, providers: Provider[]): Provider {
  const matched = providers.filter(
    (item) =>
      item.baseUrl === route.baseUrl &&
      item.apiKey === route.apiKey &&
      item.models.some((model) => model.id === route.modelId),
  );
  expect(matched.map((item) => item.id), '路由反查供应商必须唯一命中').toHaveLength(1);
  return matched[0] as Provider;
}


/** 假适配器记录下来的工作目录列表（顺序即启动顺序） */
export function startedCwds(): string[] {
  return fakeAgents.calls.map((call) => call.cwd);
}

/** 某一行的预期工作目录（prepareRowWorkspace 的布局：{root}/{runId}/rows/{rowId}/workspace） */
export function expectedWorkspace(runId: string, rowId: string): string {
  return join(home.workspaceRoot, runId, 'rows', rowId, 'workspace');
}

/**
 * 尝试账本的**原始行数**（`attempts.jsonl` 里的记录条数）。
 * 为什么数行数而不是读最后一行的 `attempt`：「一行都没被碰过」这件事必须能从磁盘上证否——
 * 单行执行的守卫要的是「别的行连一次 start 记录都没多出来」，而 `getRun` 的快照只给累计的
 * `attempts` 数字（它同样够用，但它读的是快照、不是那一行自己的账本）。
 */
export function attemptRecordCount(runId: string, rowId: string): number {
  return readFileSync(rowAttemptsFile(home.workspaceRoot, runId, rowId), 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '').length;
}

/** 事件日志里的全部 log 文本：日志抽屉是唯一能看到 `[编排]` 这类提示的地方 */
export function logTextOf(runId: string, rowId: string): string {
  return readEvents(rowEventsFile(home.workspaceRoot, runId, rowId))
    .filter((event) => event.type === 'log')
    .map((event) => (event.type === 'log' ? event.text : ''))
    .join('\n');
}

/** 该行记录日志（`messages.jsonl`）的绝对路径：消息与子任务行共用这一个文件 */
export function recordsFileOf(runId: string, rowId: string): string {
  return rowMessagesFile(home.workspaceRoot, runId, rowId);
}

/** 该行的**最终视图**：消息按 `mergeKey`、子任务行按 `subagentId` 覆盖累积之后的那一份 */
export function rowRecordsOf(runId: string, rowId: string): { messages: AgentMessage[]; subagents: SubagentRecord[] } {
  const { messages, subagents } = readRowRecords(recordsFileOf(runId, rowId));
  return { messages: foldMessages(messages), subagents: foldSubagents(subagents) };
}





/* ===================================================================================================
 * 远端来源的行准备
 *
 * 编排层在调用 core 之前先把「远端 URL」物化成**本地镜像路径 + 具体 40 位 hash**：
 * `prepareRowWorkspace` / `ensureCaseCache` / `checkoutRow` / `collectDiff` 一行都不改，
 * 它们只认本地路径。这一组用例钉的就是这个物化结果，而不是某一段 git 命令的写法。
 * =================================================================================================== */

/** 在某个目录里跑一条 git 命令；身份显式给（新克隆出来的仓库没有夹具仓库里的 `user.*` 配置）。
 *  `core.autocrlf=false` 的理由见 `fixtures.ts` 的 `runGit`：产品的唯一 git 入口总是带它，
 *  夹具不带就会在 Git for Windows 上产出 CRLF 工作树，让没改过的文本文件进 diff。 */
export function gitIn(cwd: string, args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=test@example.invalid', '-c', 'user.name=aieval-test', '-c', 'core.autocrlf=false', ...args], {
    cwd,
    encoding: 'utf8',
  });
}

/**
 * 「远端」= 本地真仓库的**裸克隆** + `file://` URL：远端链路的每一段（镜像 / fetch / 基线解析）
 * 都要能离线跑到，而只有真 git 才能让「core 只拿到本地路径」这条守卫不建立在夹具自己的假设上。
 */
/** 裸远端模板：首次调用时建一次（仓库模板的一份副本 + `clone --bare`），之后每次 `cpSync` */
let bareTemplate: { dir: string; commit: string } | null = null;

export function makeBareRemote(name: string): { url: string; commit: string; bare: string } {
  /**
   * 为什么要有模板：原来每次调用都走 `initFixtureRepo`（6 个 git 进程）+ `clone --bare`（1 个），
   * 本机 ≈2.5s/次，而远端那几条用例每条都要一个远端 ⇒ 夹具比被测逻辑还贵。
   * 模板与副本**逐字节同内容**（连同 commit hash）：裸仓库的配置里没有绝对路径，复制到新路径照样能用
   * （`core/src/git-repo-cache.test.ts` 的 `copyWorkspace` 用例守着「复制出来的仍是可用真仓库」这件事）。
   */
  if (bareTemplate === null) {
    const work = copyRepoTemplate(mkdtempSync(join(tmpdir(), 'aieval-bare-template-work-')));
    const bare = mkdtempSync(join(tmpdir(), 'aieval-bare-template-'));
    gitIn(tmpdir(), ['clone', '-q', '--bare', work, bare]);
    bareTemplate = { dir: bare, commit: repoTemplate?.commit ?? '' };
  }
  const bare = join(home.root, `${name}.git`);
  cpSync(bareTemplate.dir, bare, { recursive: true });
  return { url: `file:///${bare.replace(/\\/g, '/')}`, commit: bareTemplate.commit, bare };
}

/**
 * 该轮用例缓存的**来源记录**里记着的来源路径（`ensureCaseCache` 落盘）。
 * 它是「core 到底把什么当成了来源」的唯一磁盘证据：镜像路径 = 走了物化，URL = 没走。
 */
export function cacheOriginOf(caseId: string): string {
  const file = join(home.workspaceRoot, 'cases', caseId, 'cache', '.git', 'aieval-origin.json');
  return (JSON.parse(readFileSync(file, 'utf8')) as { repoPath: string }).repoPath;
}

/**
 * 远端重型用例自己的超时预算：这些用例的夹具本身要做**首次真实克隆**，而本机首次进程创建
 * 实测能停顿 113–117s（更坏的一次 230s；同一份夹具脱离 vitest 只要 0.5s——纯环境税，与断言无关）。
 * 取 300s 给这类停顿留一倍余量，且**只作用于显式声明它的用例**：
 * `vitest.config.ts` 的 `testTimeout` 一字不动（它是套件其余部分的诚实信号）。
 */
export const REMOTE_FIXTURE_TIMEOUT_MS = 300_000;






export { execFileSync } from 'node:child_process';
export { randomUUID } from 'node:crypto';
export { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
export { join } from 'node:path';
export type { AgentKind, EvalRun, Provider } from '@aieval/contracts';
export { ServiceError, canRescoreRow, canRetryRow, canRunRow } from '@aieval/contracts';
export { loadConfig, mirrorDir, readEvents, rowAttemptsFile, rowEventsFile, runSnapshotFile, saveConfig } from '@aieval/core';
export { abortRow, abortRun, drainRunningTasks, recoverInterruptedRuns, rescoreRow, retryRow, ROW_RETRY, runRow, startRun } from '../orchestrator';
export { getRun, listRuns, saveRun } from '../run-store';
export type { TextRoute } from '../text-api';
export { clearCases, createTempHome, fakeAgents, fakeAgentsModule, fakeJudge, initFixtureRepo, makeCaseFixture, makeProviderFixture, makeRowFixture, makeRunFixture, makeScoreFixture, overwriteCase, releaseAgent, releaseAllAgents, releaseJudge, resetFakeAgents, resetFakeJudge, seedConfig } from './fixtures';
export type { TempHome } from './fixtures';