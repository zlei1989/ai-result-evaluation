/**
 * evaluator 测试夹具：临时家目录、评测/行/供应商/用例工厂。
 * 为什么所有夹具都落在 mkdtempSync 出来的临时根目录里：本计划跑的每一步都写盘
 * （run.json / events.jsonl / 工作区复制），把 config-store 指到临时目录 + 把 workspaceRoot
 * 指到临时目录，是唯一能保证「绝不触碰真实 ~/.aieval 与 ~/.aieval-runs」的写法。
 * 注意：本文件只造数据与临时目录，不造行为；假适配器 / 假评分器 / 假文本 API 在 Task 4、Task 5
 * 追加（它们要配合 vi.mock，放在同一模块里才能被 mock 工厂动态 import 到同一个实例）。
 */
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import {
  AGENT_KINDS,
  SETTINGS_DEFAULTS,
  ServiceError,
  composeTotalScore,
  rubricItemKeys,
  rubricMaxScore,
  type AgentEvent,
  type EvalRow,
  type EvalRun,
  type ExecutionMode,
  type Provider,
  type Rubric,
  type ScoreResult,
  type Settings,
  type SubagentRecord,
  type TestCase,
} from '@aieval/contracts';
import { saveConfig, setConfigDirForTesting } from '@aieval/core';
/**
 * ⚠️ **这一条必须是类型专用的（2026-10-06）**：`@aieval/agents` 是被 `vi.mock` 的模块之一，
 * 而本文件落在工厂的**动态 import 闭包**上（`orchestrator-seams.ts:36`（T3 前 `:22`）静态 import 本文件，
 * 而各测试文件的工厂又 `await import('./testing/orchestrator-seams')`）⇒ 只要 import 里多出
 * **一个值成员**，就构成「工厂 → seams → fixtures → **正在求值中**的 `@aieval/agents`」这条
 * vite ModuleRunner 解不开的 await 环：整个文件 **0 个用例、无报错、无超时、零 CPU**（本包实测
 * 19/27 个文件如此 ⇒ `pnpm test` 整个不可用；根因见 spec §2）。
 * `tsconfig.base.json:5` 的 `verbatimModuleSyntax: true` 会把整条类型专用的 import **擦除**，
 * 运行时边随之消失 —— 这就是修复的全部机制。
 * 换来的那一格（`makeFakeProvider` 的 `messageCapability`）改用逐字字面量，见下面那里的注释。
 * 守卫：`static-assertions.test.ts` 的 `describe('工厂动态 import 的闭包不得运行时 import
 * 被 mock 的模块（防收集期静默挂死）')`。
 */
import type {
  AgentErrorCode,
  AgentExitReason,
  AgentKind,
  AgentPermission,
  AgentProvider,
  AgentProviderMetadata,
  AgentRunInput,
  AgentRunResult,
} from '@aieval/agents';
import type { JudgeInput } from '../judge';
// 同样是**类型专用**：`text-api` 是被 `vi.mock` 的模块，值 import 会在这里造出第二条环
import type { TextUsage } from '../text-api';
import { removeTreeWithRetry } from './cleanup';

/** 一个用完即删的临时家目录 */
export interface TempHome {
  /** 临时根目录（仓库、产物都在它下面） */
  root: string;
  /** 临时配置目录（相当于测试期的 ~/.aieval） */
  configDir: string;
  /** 临时工作区根目录（相当于测试期的 ~/.aieval-runs） */
  workspaceRoot: string;
  cleanup: () => void;
}

/**
 * 建临时家目录并把 config-store 指过去。
 * **立刻写一份指向临时目录的配置**：不写的话 `settings.workspaceRoot` 会回落到默认的 `~/.aieval-runs`，
 * `listRuns()` / `getRun()` 就会去读真实目录——「测试不碰真实 ~/.aieval-runs」必须由夹具本身保证，
 * 不能指望每个用例都记得先 seedConfig。
 * `cleanup` 会把 override 复位成 null：不复位的话，同文件后续用例（或忘记 cleanup 的用例）
 * 会继续往已删除的目录里写，症状是莫名其妙的 ENOENT。
 */
export function createTempHome(): TempHome {
  const root = mkdtempSync(join(tmpdir(), 'aieval-evaluator-'));
  const configDir = join(root, 'config');
  const workspaceRoot = join(root, 'runs');
  setConfigDirForTesting(configDir);
  seedConfig({ workspaceRoot });
  return {
    root,
    configDir,
    workspaceRoot,
    cleanup: () => {
      setConfigDirForTesting(null);
      /**
       * 清理必须带重试：Windows 上**刚退出的 git 进程还会短暂捏着它自己的 cwd 句柄**
       * （用例里最后一次 git 调用与这里的删除之间没有任何同步点），现象是一次全量里随机一条用例红在
       * 清理阶段，报 `EPERM, Permission denied: …\aieval-evaluator-xxxx`，而它要测的东西早就跑完了。
       *
       * 为什么不是 `rmSync(root, { …, maxRetries: 40, retryDelay: 100 })`（2026-10-07 修正）：
       * 那句「口径与 `mirror-harness.ts` 一致」是**错的**——`fs.rmSync` 不走白名单（见 `./cleanup`），
       * 实测 3ms 就抛、一次都没重试。重试只能是自己的（同 `mirror-harness.ts` 的自写 10×200ms）。
       */
      removeTreeWithRetry(root);
    },
  };
}

/**
 * 造一条供应商记录（默认 **openai** 协议：够 `codex` 行用，也够 **`dsh` 行**用——见下）。
 *
 * 协议在**供应商**上是单值（`Provider.protocolType`），在**智能体**上是集合
 * （`AgentProviderMetadata.protocolTypes`，计划 D4/D5）。所以判据不是「相等」，而是
 * `acceptsProtocol(agentProvider.metadata, providerRecord.protocolType)`（`orchestrator.ts`）。
 *
 * 历史（阶段评审 Medium-2）：R37 时期 `dsh` 的元数据是单值 `anthropic`，本夹具因此要求「dsh 行必须显式配一条
 * `protocolType: 'anthropic'` 的供应商」，否则那两条 dsh 用例的绿色就建立在**被 mock 的假元数据**上。
 * 2026-09-30 的双协议落地（`2026-09-30-dsh-dual-protocol.md` Task 7）把 dsh 放开成
 * `['openai', 'anthropic']` ⇒ 这条刻意夹具**不再需要**，默认的 openai 记录即可；
 * `makeFakeProvider` 的元数据仍逐格照真值填，那才是防止假绿的那一道。
 */
export function makeProviderFixture(overrides: Partial<Provider> = {}): Provider {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    name: '测试供应商',
    protocolType: 'openai',
    baseUrl: 'https://fake.invalid/v1',
    // 假凭据：测试里不存在任何真实网络调用（text-api 被 vi.mock 掉、适配器是假的）
    apiKey: 'sk-test-not-a-real-key',
    models: [{ id: 'test-model', source: 'manual' }],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/**
 * 全测试共用的**评分表夹具**：一张最小的表——一组、两项，满分 30（20 + 10）。
 * 为什么满分刻意不是 100：旧体系的总分是「5 维均分映射成百分制」，30 这个数一眼就能看出
 * 分数来自**权重加总**而不是任何百分比公式——夹具若取 100，两种算法在断言里长得一模一样。
 * 用例 / 一轮 / 一次评分三处共用同一张表：`makeScoreFixture` 的逐项判定按它的引用键生成，
 * 而编排层把 `run.rubric` 快照交给评分器——两边必须是同一张表，引用键才对得上。
 */
export const RUBRIC_FIXTURE: Rubric = {
  groups: [
    {
      name: '一、生产代码',
      items: [
        { id: 'A1', goal: '追加 agent 字段', weight: 20 },
        { id: 'A2', goal: '补 Javadoc', weight: 10 },
      ],
    },
  ],
};

/** 造一条用例记录；需要真实仓库的用例自己覆盖 repoPath */
export function makeCaseFixture(overrides: Partial<TestCase> = {}): TestCase {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    title: '测试用例',
    repoPath: join(tmpdir(), 'aieval-not-a-real-repo'),
    commitHash: null,
    repoBranch: null,
    taskPrompt: '把 README 的标题改成中文',
    rubric: RUBRIC_FIXTURE,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/** 造一个候选行（字段齐全，避免每个用例各写一遍；id 与 branch 自洽） */
export function makeRowFixture(overrides: Partial<EvalRow> = {}): EvalRow {
  const id = overrides.id ?? randomUUID();
  return {
    id,
    agentKind: 'codex',
    providerId: 'provider-placeholder',
    providerName: '测试供应商',
    baseUrl: 'https://fake.invalid/v1',
    modelId: 'test-model',
    status: 'pending',
    branch: `test/${id}`,
    workspacePath: '',
    // 占位基线：真实基线是 40 位具体 hash（R2），要等准备阶段由 prepareRowWorkspace 解析出来。
    // 这里用 ''（= 尚未准备）：契约 §2.4 的 EvalRowSchema 就是 `z.string()`，p0 的 run.test.ts 明确断言
    // 「空串必须解析成功」，所以夹具无需伪造一个假的 40 位 hash（实现层修正第 14 条已据此改写）。
    baselineCommit: '',
    tokens: null,
    turns: null,
    durationMs: null,
    diff: null,
    score: null,
    error: null,
    // 缺省「还没跑过」= 0 次尝试（与契约里这一格的缺省值一致）
    attempts: 0,
    ...overrides,
  };
}

/** 造一轮评测（不落盘：要不要 saveRun 由用例决定） */
export function makeRunFixture(input: {
  workspaceRoot: string;
  id?: string;
  caseId?: string;
  caseTitle?: string;
  repoPath?: string;
  commitHash?: string | null;
  /** 这一轮跟的分支（`null` = 远端默认分支）；不填即 `null` */
  repoBranch?: string | null;
  /**
   * 这一轮用的**评分表快照**；不填即 `RUBRIC_FIXTURE`。
   * 为什么它是快照而不是从用例现取：评分阶段读的是 `run.rubric`（Task 2 的契约），改了用例的评分表
   * 之后重评，用的仍是当初那把尺子。夹具的缺省必须给出一张**与 `makeScoreFixture` 同一张**的表，
   * 否则假评分器生成的引用键与编排层交给评分器的表对不上。
   */
  rubric?: Rubric;
  executionMode?: ExecutionMode;
  /** 这一轮是否由评分智能体评分；不填即 `false`（与 `RunCreate.useAgentJudge` 的缺省一致） */
  useAgentJudge?: boolean;
  rows?: EvalRow[];
  status?: EvalRun['status'];
}): EvalRun {
  return {
    id: input.id ?? randomUUID(),
    caseId: input.caseId ?? randomUUID(),
    caseTitle: input.caseTitle ?? '测试用例',
    repoPath: input.repoPath ?? join(tmpdir(), 'aieval-not-a-real-repo'),
    commitHash: input.commitHash ?? null,
    repoBranch: input.repoBranch ?? null,
    rubric: input.rubric ?? RUBRIC_FIXTURE,
    status: input.status ?? 'idle',
    executionMode: input.executionMode ?? 'parallel',
    useAgentJudge: input.useAgentJudge ?? false,
    rows: input.rows ?? [makeRowFixture()],
    workspaceBase: input.workspaceRoot,
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
  };
}

/** 写一份临时配置（settings + 供应商 + 用例）：默认评分模型为 null，需要评分的用例自己给 */
export function seedConfig(input: {
  workspaceRoot: string;
  providers?: Provider[];
  cases?: TestCase[];
  diffBudgetBytes?: number;
  defaultJudge?: Settings['defaultJudge'];
  /** 默认评分智能体；不填即 `null`（= 未配置，与 `SETTINGS_DEFAULTS` 一致） */
  defaultJudgeAgent?: Settings['defaultJudgeAgent'];
}): void {
  saveConfig({
    settings: {
      ...SETTINGS_DEFAULTS,
      workspaceRoot: input.workspaceRoot,
      diffBudgetBytes: input.diffBudgetBytes ?? SETTINGS_DEFAULTS.diffBudgetBytes,
      defaultJudge: input.defaultJudge ?? null,
      defaultJudgeAgent: input.defaultJudgeAgent ?? null,
    },
    providers: input.providers ?? [],
    cases: input.cases ?? [],
  });
}

/** 假文本 API 的一次调用记录：单轮与多轮共用同一个入口（多轮的 messages 长度会大于 1） */
export interface FakeTextCall {
  route: unknown;
  /** 完整对话（单轮就是一条 user 消息；修复轮是 `user / assistant / user`） */
  messages: { role: string; content: string }[];
  system?: string;
  /**
   * 实际交给文本 API 的**思考强度**（未给则 `undefined`）。
   * 为什么必须记录：它是「这一分用什么强度打的」在**评分器这一层**的唯一观测点——漏传是静默的
   * （评分照出，只是模型按网关的缺省档跑），而记账那一格写 `null` 与写真实档名在契约上都合法。
   */
  effort?: string;
}

/** 假文本 API 的状态：返回值 / 失败方式 / 收到的入参 */
export const fakeTextApi = {
  reply: '',
  /**
   * 按调用序号给不同答复（第 N 次调用用第 N 条；用完之后一律用**最后一条**）。
   * 为什么需要它（2026-09-27）：结构修复是**多轮**的，而「第一轮答错、第二轮答对」这条主路径
   * 必须能被真的走一遍——只有 `reply` 一个槽位时，用例只能造出「每轮都答错」。
   * `calls` 仍记录 mode；这里**不**在 mode 里加第四个值，是为了让既有用例的断言一字不改。
   */
  replies: [] as string[],
  /**
   * 每一次调用**上游自报的用量**（2026-10-08）。与 `replies` 同一套序号：第 N 次调用用第 N 条，
   * 越界取最后一条；`usages` 为空时一律用 `usage`。
   * 为什么要按序号给：结构修复是**多轮**的，而「用量跨轮累计」这条口径只有在两轮拿到
   * **不同的数**时才测得出来（两轮同值时，「累计」与「只记最后一轮」长得一模一样）。
   */
  usages: [] as (TextUsage | null)[],
  /** 每一次调用的默认用量；`null` = 上游没报（与真实外壳同一条口径，**绝不填 0**） */
  usage: { input: 10, cached: 0, output: 2 } as TextUsage | null,
  failure: null as Error | null,
  calls: [] as FakeTextCall[],
};

/** 每个用例开头调它：模块级状态在同一测试文件里是共享的 */
export function resetFakeTextApi(): void {
  fakeTextApi.reply = '';
  fakeTextApi.replies.length = 0;
  fakeTextApi.usages.length = 0;
  fakeTextApi.usage = { input: 10, cached: 0, output: 2 };
  fakeTextApi.failure = null;
  fakeTextApi.calls.length = 0;
}

/** 这一轮该回什么：`replies` 有值就按序号取（越界取最后一条），否则用 `reply` */
function replyForCall(): string {
  if (fakeTextApi.replies.length === 0) return fakeTextApi.reply;
  const index = Math.min(fakeTextApi.calls.length - 1, fakeTextApi.replies.length - 1);
  return fakeTextApi.replies[index] ?? fakeTextApi.reply;
}

/** 这一轮该报多少用量：与 `replyForCall` 同一套序号规则 */
function usageForCall(): TextUsage | null {
  if (fakeTextApi.usages.length === 0) return fakeTextApi.usage;
  const index = Math.min(fakeTextApi.calls.length - 1, fakeTextApi.usages.length - 1);
  return fakeTextApi.usages[index] ?? fakeTextApi.usage;
}

/**
 * 供 `vi.mock('./text-api', …)` 用作替代模块：`callTextApi` 与 `callTextApiConversation`
 * **都要给**——`judgeRow` 现在走多轮入口，只给单轮那一支会让整个评分域在测试里 import 到 undefined。
 * 两者记进同一个 `calls`（同一个边界、同一套断言），单轮被展开成一条 user 消息。
 */
export function fakeTextApiModule(): {
  callTextApi: (route: unknown, input: { system?: string; prompt: string; effort?: string }) => Promise<string>;
  callTextApiConversation: (
  route: unknown,
  input: { system?: string; messages: { role: string; content: string }[]; effort?: string },
  ) => Promise<{ text: string; usage: TextUsage | null }>;
} {
  const run = async (
    route: unknown,
    input: { system?: string; messages: { role: string; content: string }[]; effort?: string },
  ): Promise<{ text: string; usage: TextUsage | null }> => {
    fakeTextApi.calls.push({
      route,
      messages: input.messages,
      ...(input.system === undefined ? {} : { system: input.system }),
      effort: input.effort,
    });
    if (fakeTextApi.failure !== null) throw fakeTextApi.failure;
    return { text: replyForCall(), usage: usageForCall() };
  };
  return {
    // 单轮也是一条真的转发：真实 `callTextApi` 把 `effort` 一起交给 `buildBody`，
    // 夹具漏转的话「生成 / 识别那条路带没带强度」在测试里会永远看不见（假绿）
    callTextApi: (route, input) => run(route, {
      messages: [{ role: 'user', content: input.prompt }],
      ...(input.system === undefined ? {} : { system: input.system }),
      effort: input.effort,
    }).then((result) => result.text),
    callTextApiConversation: (route, input) => run(route, input),
  };
}

/**
 * 造一个**真实**的小 git 仓库（真 git，不是 mock）。
 * 为什么工作区相关的用例必须用真仓库：本计划最重要的一条守卫是「每行工作目录互不相同」，
 * 而假造复制/checkout 等于把守卫建立在自己的假设上——真仓库能让 prepareRowWorkspace 真的
 * 复制目录、真的 checkout、真的建分支，共用目录的实现在它面前藏不住。
 */
export function initFixtureRepo(dir: string): { repoPath: string; commit: string } {
  mkdirSync(dir, { recursive: true });
  runGit(dir, ['init', '-q', '-b', 'main']);
  runGit(dir, ['config', 'user.email', 'test@example.invalid']);
  runGit(dir, ['config', 'user.name', 'aieval-test']);
  writeFileSync(join(dir, 'README.md'), '# 测试仓库\n', 'utf8');
  writeFileSync(join(dir, 'src.txt'), 'hello\n', 'utf8');
  runGit(dir, ['add', '.']);
  runGit(dir, ['commit', '-q', '-m', 'init']);
  return { repoPath: dir, commit: runGit(dir, ['rev-parse', 'HEAD']).trim() };
}

/**
 * 跑一条 git 命令；失败时把 stderr 一起抛出来（静默失败的夹具会把排查成本抬得很高）。
 *
 * `-c core.autocrlf=false` 不是可选的（2026-09-30 实测）：Git for Windows 的**系统级** gitconfig
 * 就带 `core.autocrlf=true`，而产品的唯一 git 入口（core 的 `execute`，`git-exec.ts:26`）**总是**
 * 带这个 `-c`——口径是「工作树字节与仓库一致」。夹具不带它的话，`git clone` 检出的工作树是 CRLF
 * 而 blob 是 LF，于是 `collectDiff`（同样走 `execute`）把 README.md / src.txt 这类**一个字节都没被
 * 改过**的文本文件算成改动：实测 `orchestrator-run-row` 的「改动前」diff 从 0 个文件变成
 * `+3 −2`，用例红在 `filesChanged` 上，而真因与协议、与适配器都无关。
 * core 侧的三份 harness（`git-diff-harness` / `git-repo-harness` / `workspace-harness`）早就带着它，
 * evaluator 这边是漏了。
 */
function runGit(cwd: string, args: string[]): string {
  try {
    return execFileSync('git', ['-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8' });
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr ?? '';
    throw new Error(`git ${args.join(' ')} 失败：${stderr || String(error)}`);
  }
}

/** 造一个合法的 ScoreResult（总分按 contracts 的 composeTotalScore 算，夹具里不另写一份公式） */
export function makeScoreFixture(
  achieved = true,
  judgeProviderId = 'judge-provider',
  judgeModelId = 'judge-model',
  judgeAgentKind: AgentKind | null = null,
): ScoreResult {
  const rubric = RUBRIC_FIXTURE;
  const keys = rubricItemKeys(rubric);
  const items = rubric.groups.flatMap((group) => group.items);
  const judgments = keys.map((key, index) => ({
    id: key,
    // 第一个参数改成布尔之后，`makeScoreFixture(false)` = 一项都没达成 = 0 分
    achieved,
    reason: `${items[index]?.goal ?? key}：假评分器给 ${achieved ? '达成' : '未达成'}`,
  }));
  return {
    judgments,
    totalScore: composeTotalScore(rubric, judgments),
    maxScore: rubricMaxScore(rubric),
    verdict: '假评分器的总评',
    raw: '{"fake":true}',
    judgeProviderId,
    judgeModelId,
    judgedAt: new Date().toISOString(),
    judgeAgentKind,
    judgeEffort: null,
    // 夹具一律走提示词契约（老记录读盘后同样是 false）：要造「被 schema 约束的那一份」，
    // 先给本夹具加一个可选入参，别在用例里手抄整个 ScoreResult
    structuredOutput: false,
    // 评分自己的花销（2026-10-08）：假评分器不记账，两格给 null（真实通路各有专门用例钉住）。
    // 需要「有用量那一份」的用例同样走「给夹具加可选入参」这条路，不要手抄整个 ScoreResult
    judgeTokens: null,
    judgeDurationMs: null,
  };
}

/** 一次假适配器调用的记录：编排层的用例靠它断言「谁在什么时候跑、并发峰值多少、拿到的路由是什么」 */
export interface FakeAgentCall {
  kind: AgentKind;
  cwd: string;
  configHome: string;
  baseUrl: string;
  modelId: string;
  /**
   * 实际交给适配器的**模型能力**两格（窗口 / 输出上限，原样记下）。
   * 为什么必须记录：route 是「事实 → 方言」的唯一通道（spec D1），而编排层少填这一格的后果是
   * **静默**的——cc 不加后缀、codex 不写 `model_context_window`、dsh 不写 settings.yaml，
   * 三家的运行都照常成功，只是模型跑在另一个窗口上。没有这一格就没有任何用例能看见它。
   */
  contextWindow?: number;
  maxOutputTokens?: number;
  /** 实际交给适配器的思考强度（未选则 undefined）：与窗口同理，漏传是静默的（模型按默认档跑） */
  effort?: string;
  /**
   * 实际交给适配器的提示词（原样记下）。
   * 为什么必须记录：「拼出提示词」与「拼出来的那一份真的被送进 `run()`」是两件事，
   * 而智能体评分通路的全部理由（基线、按需读、只读）都只在这份文本里——不记录它，
   * 把 `prompt` 传空或把题面与评分标准项表格传反的改动能让所有用例保持全绿。
   */
  prompt: string;
  /**
   * 这次运行拿到的**权限档**（原样记下）。
   * 为什么必须记录：它是「候选能改、评审者不能改」这条例在**执行层**的唯一落点——
   * 编排层把两处都传成 `'full'`（或都传成 `'read-only'`）时，行照样跑完、分数照样出得来，
   * 没有任何别的可观测差异（提示词里那句「只读评审」只是要求，不是强制）。
   */
  permission: AgentPermission;
  /**
   * 实际交给适配器的结构化输出 schema（原样记下；`undefined` = 这一格根本没传）。
   *
   * 为什么必须记录：A1 之后**编排层总是传**这一格（`outputSchema` 表达「我想要」），能不能给由
   * **骨架**按 `hooks.capability.structuredOutput` 决定（spec D4：谁知道能力、谁决定，答案在
   * `runTurn` 里算一次），降级结论再经 `applied.structuredOutput` 报回来。于是这一格是「骨架到底
   * 有没有把它交给适配器」的唯一观测点：若改成「无脑交给适配器」，别处没有任何可观测差异——
   * 行照样跑完、分数照样出得来；而按 spec D11，不支持这一格的那一家（dsh）要么直接报错、
   * 要么把提示词契约静默当成「已经强约束」。判据在 `judge-agent.test.ts` 的降级那条：
   * dsh 那一次收到的必须是 `undefined`。
   * 取值刻意保留 `undefined`（而不是缺省成 `false` / `null`）：「这一格被摘掉了」正是要被钉住的事实。
   */
  outputSchema?: Record<string, unknown>;
  startedAt: number;
  finishedAt: number | null;
  exitReason: AgentExitReason | null;
  aborted: boolean;
}

/** 假适配器的行为脚本（按 kind 设置） */
export interface FakeAgentScript {
  /**
   * ok=正常返回；error=返回 ok:false；gate=挂起等测试放行（被终止时按协作适配器返回 canceled）；
   * hang=永不返回且无视 signal（模拟非合作适配器，只有编排层的硬停能收场）；
   * throw=run() 直接抛异常（模拟契约违例：契约说 run() 返回 ok:false，不抛）；
   * late=睡到**编排层已经按超时收尾之后**才投递日志并成功返回（终审 ADD-1 的闸门守卫要用它）
   */
  mode?: 'ok' | 'error' | 'gate' | 'hang' | 'throw' | 'late';
  /** `mode: 'late'` 睡多久（毫秒）：要比外层硬停更长，才落在「已经收尾」之后 */
  lateMs?: number;
  /** `mode: 'late'` 迟到投递的那条日志文本 */
  lateText?: string;
  /** 适配器**自报**超时（`exitReason: 'timed-out'`）；没有内层 `timeoutMs` 了，这里直接收场 */
  selfTimeout?: boolean;
  /** 返回前写进工作区的文件（内容里建议带上 cwd，便于把调用对回具体行） */
  files?: { path: string; content: string }[];
  /** `mode: 'error'` 时**不带** error 字段：复现「ok:false 却没有原因」的契约违例 */
  omitError?: boolean;
  /**
   * `mode: 'error'` 时返回的归因码（缺省 `AGENT_FAILED`）。
   * 为什么需要这一格：评分通路要把上游归因（`AUTH_FAILED` / `RATE_LIMITED`）**原样**带出来，
   * 而归因码写死的话，「透传 `result.error.code`」与「写死 `'AGENT_FAILED'`」两种实现在用例面前没有区别
   *（与 `omitError` 同一类旋钮：都是为了让契约违例 / 各归因分支能被真的走一遍）。
   */
  errorCode?: AgentErrorCode;
  tokens?: { input: number; cached: number; output: number } | null;
  /**
   * 适配器自报的耗时（毫秒）。不写就按夹具自己的墙钟算（真实适配器也是自报值，见
   * `AgentRunResult.durationMs`）。
   * 为什么需要这一格（2026-10-08）：评分详情要显示**评分那一段**的耗时，而假适配器的墙钟是
   * 「几毫秒」——不钉住一个具体数字的话，「取适配器自报值」与「写死 0」「取我们的掐表」
   * 三种实现在用例面前一模一样（假绿）。
   */
  durationMs?: number;
  /**
   * **子智能体那一份**用量（2026-10-04，`AgentRunResult.subagentTokens` 必填之后新增）。
   * 与 `tokens` 同一格口径：脚本没写这一项就是「没采到」（`null`），写了就原样透传（含显式的 `null`）。
   */
  subagentTokens?: { input: number; cached: number; output: number } | null;
  /**
   * **子智能体那一份**轮次（2026-10-04，`AgentRunResult.subagentTurns` 必填之后新增）。
   * 与上面那一格同一条口径：脚本没写这一项就是「没采到」（`null`），写了就原样透传（含显式的 `null`）。
   * 数值上必须 ≤ `turns`（spec §2.4 的不变量）——夹具给出违反它的组合，等于把一份不可能落盘的快照
   * 当成正常输入。
   */
  subagentTurns?: number | null;
  turns?: number | null;
  /**
   * 最终答复（Task 2 的 `AgentRunResult.finalText`）。
   * 不填即 `null`（= 没采到），`''` 是「明确回了空答复」——两者含义相反，与 tokens/turns 同一格口径。
   */
  finalText?: string | null;
  /**
   * `finish()` 之前逐条投给 `input.onEvent` 的脚本事件：模拟适配器在跑动期发出的日志行
   * （评分通路的用例靠它验证 `[评分智能体]` 前缀确实加在了转发出去的日志上）。
   * `seq` 由 core 的事件写入器分配（`events.ts` 的口径：调用方传进来的会被覆盖），这里给 0 即可。
   */
  events?: { stream: 'stdout' | 'stderr'; text: string }[];
  /**
   * `finish()` 之前**原样**投递的事件（不经任何加工）：用来钉住「只有 `log` 加前缀、其余类型逐字段透传」
   * 这类透传口径。
   * 与 `events` 分开而不是合并成一格：后者是「日志行」的便捷写法（绝大多数用例只需要它），
   * 合并会变成「按 type 变形的联合」，用例读起来还得先解类型。
   */
  rawEvents?: AgentEvent[];
  /**
   * `finish()` 之前逐条投给 `input.onMessage` 的消息（spec v3 §2）：用来验证编排层把
   * 「消息 → `messages.jsonl`」这条接线接上了（**只给消息内容，信封由夹具补全**，
   * 用例因此不必手写 `messageId` / `mergeKey` 这些与断言无关的格）。
   */
  messages?: { text: string; roundTrip?: number; subagentId?: string | null }[];
  /**
   * `finish()` 之前逐条投给 `input.onSubagent` 的子任务行：验证「派发视图 → 同一个记录文件」这条接线。
   * 只给身份与状态，其余格由夹具补成合法形状。
   */
  subagents?: { subagentId: string; status?: SubagentRecord['status']; name?: string | null }[];
}

export const fakeAgents = {
  calls: [] as FakeAgentCall[],
  concurrent: 0,
  maxConcurrent: 0,
  /** gate 模式下挂起的 run：cwd → 放行函数 */
  gates: new Map<string, () => void>(),
  scripts: new Map<AgentKind, FakeAgentScript>(),
  /**
   * 「这一批假运行属于哪一代」的计数器（见 `resetFakeAgents`）。
   * 假适配器在 `run()` 入口把它抄一份，`finish()` / 抛异常两条出口只在**抄到的那一代还成立**时
   * 才动 `concurrent` / `maxConcurrent`。
   */
  generation: 0,
};

/**
 * 每个用例开头调它：模块级状态在同一测试文件里是共享的。
 *
 * `generation += 1` 是**载重**的，不是记账：`concurrent` 是模块级计数器，而 `resetFakeAgents()`
 * 只能把它清零、**没法让一个已经在 gate 里挂着的 `run()` 落定**。于是用例超时（本机上的
 * 环境性超时，实测有 60s 以上才建完夹具的）把一行丢在 gate 里之后，那一行唯一的终结者是
 * **编排层的行兜底定时器**（默认配置下约 33 分钟后才响）；它迟到的那一次 `concurrent -= 1`
 * 会落进**后面某个用例**的断言窗口里，让「三行同时在跑」这条断言以 `expected 3, received 2`
 * 随机变红——已经真实发生过一次，且那种红不可复现、只能靠重跑碰运气。
 * 代际守卫把「上一代的出口」整条作废：它不再改任何计数，也不再改 `calls` / `gates`。
 * 注意它**只**管跨用例的迟到出口：同一代内部的并发计数一个字节都没动（那些峰值断言照旧）。
 */
export function resetFakeAgents(): void {
  fakeAgents.generation += 1;
  fakeAgents.calls.length = 0;
  fakeAgents.concurrent = 0;
  fakeAgents.maxConcurrent = 0;
  fakeAgents.gates.clear();
  fakeAgents.scripts.clear();
}

/** 放行某一行的 gate（按 cwd）；没有等待者时是空操作 */
export function releaseAgent(cwd: string): void {
  fakeAgents.gates.get(cwd)?.();
}

/** 放行当前所有 gate */
export function releaseAllAgents(): void {
  for (const release of [...fakeAgents.gates.values()]) release();
}

/**
 * 假 provider：元数据与**真实注册表**逐格一致 —— claude-code `['anthropic']` / codex `['openai']` /
 * dsh `['openai','anthropic']`（两条 wire 都能收，计划 Task 7）。
 * 为什么不能随手写个「默认值」：编排层的协议校验读的就是这份元数据
 *（`orchestrator.ts`：`acceptsProtocol(agentProvider.metadata, providerRecord.protocolType)`），
 * 夹具里写错一格，对应那几条用例的绿色就建立在**被 mock 的假元数据**上（阶段评审 Medium-2 的变异 E8：
 * 把这一行改回真值，两条 dsh 用例立刻以 `CONFLICT` 变红）。`run()` 的行为完全由脚本决定。
 */
function makeFakeProvider(kind: AgentKind): AgentProvider {
  const metadata: AgentProviderMetadata = {
    protocolTypes: kind === 'dsh' ? ['openai', 'anthropic'] : kind === 'codex' ? ['openai'] : ['anthropic'],
    // structuredOutput 也照真值填：claude-code / codex 有原生 schema 开关，dsh 的 SDK 客户端没有
    capability: { cancelMidTurn: kind !== 'dsh', usage: true, structuredOutput: kind !== 'dsh' },
    // 档位域照**真值**填（spec D11；2026-10-06 起三家首项都是 `off`，claude 的关闭走
    // `thinking: { type: 'disabled' }`、codex 的走 `none`）。编排层不读它（交集在 api 层算），
    // 但填成一份万能表会让「假 provider 与真注册表逐格一致」这条前提在审计时看不出破绽。
    reasoningEfforts:
      kind === 'claude-code'
        ? ['off', 'low', 'medium', 'high', 'xhigh', 'max']
        : kind === 'codex'
          ? ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'persistent']
          : ['off', 'low', 'high', 'max'],
    // `defaultEffort` 同真值：只有 dsh 有（2026-10-06；API 侧要用它拦「未选 + 模型不支持缺省档」）
    ...(kind === 'dsh' ? { defaultEffort: 'high' } : {}),
    /**
     * 消息能力声明：编排层不读它（它服务内容级视图），故这里用最宽松的一份形状桩；
     * 三家的真值在各自的 `providers/<kind>/index.ts` 里，由 agents 包的一致性用例钉住。
     *
     * **为什么是逐字字面量、而不是 `permissiveMessageCapability()`（2026-10-06）**：那个函数要用就得从
     * `@aieval/agents` **运行时** import 进来，而它正是被 `vi.mock` 的模块之一 ⇒ 夹具会被卷进
     * 「工厂 → seams → fixtures → 在飞模块」那条环（见本文件 `:34` 那条 import 的注释）。
     * 字面量把这条运行时边**彻底去掉**，且不需要任何运行时读——**不要**改用
     * `vi.importActual('@aieval/agents')` 现取（那只是把边挪到执行期，风险面不明，spec §3.3），
     * 也**不要**在夹具里另写一个同名复制函数（那是第二份真源，spec §3.3）。
     * （2026-10-07 起那个函数已从包出口收回、只服务 `agents` 包内测试，用不着再权衡。）
     *
     * 等价性：与 `agents/src/types.ts` 的 `permissiveMessageCapability()` 返回值**逐格等价**（17 格
     * = 6 个能力位 + 5 对 `Source`/`Reason` + `notes`）；将来 `MessageCapability`（`contracts/src/agent-message.ts:401-463`）
     * 新增必填格时 `tsc` 会**直接点名**，故这份字面量不会静默过期。
     */
    messageCapability: {
      thinkingText: 'yes',
      thinkingTextKind: 'full',
      toolInput: 'yes',
      toolResult: 'yes',
      subagent: 'yes',
      streamingDelta: 'yes',
      thinkingTextSource: 'wire',
      thinkingTextReason: null,
      toolInputSource: 'wire',
      toolInputReason: null,
      toolResultSource: 'wire',
      toolResultReason: null,
      subagentSource: 'wire',
      subagentReason: null,
      streamingDeltaSource: 'wire',
      streamingDeltaReason: null,
      notes: [],
    },
  };
  return {
    kind,
    displayName: `假 ${kind}`,
    metadata,
    async run(input: AgentRunInput): Promise<AgentRunResult> {
      const script = fakeAgents.scripts.get(kind) ?? {};
      const mode = script.mode ?? 'ok';
      // 抄下「我属于哪一代」（见 resetFakeAgents 的注释）：这一次运行如果在用例结束之后才落定，
      // 它的收尾就属于上一代，不许再碰计数与记录
      const generation = fakeAgents.generation;
      const call: FakeAgentCall = {
        kind,
        cwd: input.cwd,
        configHome: input.configHome,
        permission: input.permission,
        outputSchema: input.outputSchema,
        baseUrl: input.route.baseUrl,
        modelId: input.route.modelId,
        contextWindow: input.route.contextWindow,
        maxOutputTokens: input.route.maxOutputTokens,
        effort: input.effort,
        prompt: input.prompt,
        startedAt: Date.now(),
        finishedAt: null,
        exitReason: null,
        aborted: false,
      };
      fakeAgents.calls.push(call);
      fakeAgents.concurrent += 1;
      fakeAgents.maxConcurrent = Math.max(fakeAgents.maxConcurrent, fakeAgents.concurrent);
      /** 这一代还成立吗：不成立就整条出口作废（跨用例的迟到收尾不该改任何共享状态） */
      const currentGeneration = (): boolean => fakeAgents.generation === generation;
      const finish = (exitReason: AgentExitReason, ok: boolean, error?: AgentRunResult['error']): AgentRunResult => {
        call.finishedAt = Date.now();
        call.exitReason = exitReason;
        if (currentGeneration()) fakeAgents.concurrent -= 1;
        const durationMs = script.durationMs ?? (call.finishedAt ?? Date.now()) - call.startedAt;
        // 计量**必须原样透传脚本里的 null**（「没采到」与「0」在横向对比里含义相反，§5.6.3）。
        // 这里刻意不写 `script.tokens ?? 默认值`：`??` 会把 `null` **一并**兜掉（它只在左侧为
        // `null` / `undefined` 时取右侧，`null ?? 9 === 9` 是规范语义、不是运行时缺陷），
        // 而这一项只应兜 `undefined`（脚本没写这一项）——`null` 是「没采到」，必须原样透传。
        // 显式判 `undefined` 才与这里的意图等价（评审 M3：旧注释把「算子的语义」误读成了「环境退化」）。
        const tokens = script.tokens === undefined ? { input: 10, cached: 0, output: 20 } : script.tokens;
        // 子智能体那一份（2026-10-04）：**同一格口径**——脚本没写这一项就是「没采到」（`null`），
        // 写了就原样透传。这里同样**必须显式判 `undefined`**（理由与上面 tokens 逐字相同）：
        // `script.subagentTokens ?? null` 会把显式的 `null`（= 明确没采到，且要覆盖掉旧分量）一并兜住，
        // 两者在消费侧是「保持」与「清空」的区别。
        const subagentTokens = script.subagentTokens === undefined ? null : script.subagentTokens;
        // 轮次那一格的分量同一格口径（2026-10-04）：脚本没写 = 「没采到」（`null`），写了就原样透传，
        // 显式 `null` 因此不会被 `??` 一并兜掉（那是「保持」与「清空」的区别）
        const subagentTurns = script.subagentTurns === undefined ? null : script.subagentTurns;
        /**
         * `applied`（A1，必填格）。真 `run` 由骨架现算（`runTurn` 里
         * `wantsSchema && capability.structuredOutput`），而假 provider **不走骨架** ⇒ 这里照同一条式子
         * 现算，两个操作数都取真值：能力读自己的 `metadata`（上面那一格与真注册表逐格一致），
         * 「要没要 schema」读这一格有没有真被传进来。
         *
         * 为什么不写死 `false`：claude-code / codex 走 `run` 时**真的**会下发 schema，写死会让夹具的
         * 绿色建立在「与真行为相反」的假值上——正是本文件顶部那条「元数据与真实注册表逐格一致」要防的
         * 事。`dsh` 那一格因此如实报 `false`，调用方那两条分支（降级留痕 / 记账）也才都能被走到。
         */
        const schemaWanted = input.outputSchema !== undefined && input.outputSchema !== null;
        const applied = { structuredOutput: schemaWanted && metadata.capability.structuredOutput };
        return {
          ok,
          exitReason,
          tokens,
          subagentTokens,
          subagentTurns,
          turns: script.turns === undefined ? 1 : script.turns,
          durationMs,
          // 最终答复：脚本没写这一项就是「没采到」（null），写了就原样透传（含显式的 `null` 与空串）。
          // 这里**必须显式判 `undefined`**，不能写 `script.finalText ?? null`：`??` 会把显式的 `null`
          // 一并兜掉，而 `null` 是「没采到」这个有意义的取值——判据上它与 `''`（空答复）相反。
          // 与上面 tokens/turns 的写法同一格口径（评审 M3：那是算子的规范语义，不是环境退化）。
          finalText: script.finalText === undefined ? null : script.finalText,
          applied,
          ...(error === undefined ? {} : { error }),
        };
      };
      const writeFiles = (): void => {
        for (const file of script.files ?? []) writeFileSync(join(input.cwd, file.path), file.content, 'utf8');
      };
      /**
       * 投递消息与子任务行（spec v3 §2）。
       *
       * 两条刻意如此：① 与事件同一条**代际守卫**——上一代的运行往本代用例的消息流里灌内容，
       * 会把别人的断言搅红；② 信封里与断言无关的格（`messageId` / `mergeKey` / `assembly` …）
       * 由夹具补成**合法形状**，用例只写自己关心的那几格——否则每条用例都要手抄一遍信封，
       * 而抄错的那一格恰好是「契约校验失败」这种离断言很远的红。
       */
      const emitMessages = (current: NonNullable<typeof script>): void => {
        if (!currentGeneration()) return;
        if (!current.messages && !current.subagents) return;
        const emit = (): void => {
          for (const [index, item] of (current.messages ?? []).entries()) {
            const roundTrip = item.roundTrip ?? 1;
            input.onMessage?.({
              messageId: `${generation}:${index + 1}`,
              vendorId: null,
              role: 'assistant',
              source: 'wire',
              roundTrip,
              vendorTurn: null,
              step: null,
              parentCallId: null,
              subagentId: item.subagentId ?? null,
              chunk: 'snapshot',
              assembly: 'snapshot',
              mergeKey: `${item.subagentId ?? 'main'}|${roundTrip}|assistant|-`,
              blocks: [{ type: 'text', text: item.text }],
              raw: null,
            });
          }
          for (const item of current.subagents ?? []) {
            input.onSubagent?.({
              subagentId: item.subagentId,
              name: item.name ?? null,
              kind: null,
              source: 'wire',
              status: item.status ?? 'running',
              statusMissing: null,
              outcome: null,
              parentCallId: null,
              parentSubagentId: null,
              usage: null,
            });
          }
        };
        emit();
      };
      input.signal.addEventListener('abort', () => { call.aborted = true; }, { once: true });

      if (mode === 'hang') {
        // 非合作适配器：无视 signal、永不返回。孤儿 promise 无法回收（JS 没有取消异步的机制），
        // 这正是 §5.6.6 要求适配器自带 interrupt → dispose 有界清理的原因。
        // ⚠️ 2026-09-28 起**没有兜底超时**能收这一行了（用户口径「执行不限时间」）：用它造的用例
        // 必须自己把行终止掉（abortRow / abortRun），否则会一直挂在 running 上。
        await new Promise<never>(() => {});
      }
      if (mode === 'throw') {
        // 契约违例：run() 直接抛，而不是返回 ok:false。并发计数要还原，否则会污染后续用例的峰值断言
        call.finishedAt = Date.now();
        // ⚠️ 这一处的代际守卫今天**恒真**（前面唯一的 await 在 mode==='hang' 那一支，两者互斥 ⇒
        // 走到这里还没让出过事件循环）。留着是为了「将来有人在前半段插入 await」时仍然成立，
        // 但**不能**拿它当守卫覆盖的证据：R31 的可达落点只有两处，逐处说明见 orchestrator.test.ts
        // 那个 describe 的头注（终审 FIX-5 把原报告里的 3/4 纠正成 2/4）
        if (currentGeneration()) fakeAgents.concurrent -= 1;
        throw new Error('假适配器：run() 直接抛了异常（契约违例）');
      }
      if (mode === 'late') {
        // 编排层**已经按超时收尾之后**才吐事件的那一档（终审 ADD-1）：无视 signal、睡够硬停的时长，
        // 然后投递一条日志并成功返回。真实形状就是「适配器收尾很慢」——dispose 之后才把最后几条日志
        // 交出来，而那时这一行早已落了终态。闸门失效时它会静默追加进 events.jsonl（日志抽屉被拖长）。
        await new Promise((resolve) => setTimeout(resolve, script.lateMs ?? 4_000));
        if (currentGeneration()) {
          input.onEvent({
            seq: 0,
            at: new Date().toISOString(),
            type: 'log',
            stream: 'stdout',
            text: script.lateText ?? '迟到的日志：编排层已经收尾了',
          });
          // 消息与子任务行走**同一条迟到路径**（终态之后才投）：闸门必须是同一个 `settled`，
          // 否则「日志被拦住了、对话却还在长」——那是最难解释的一种半截行为。
          emitMessages(script);
        }
        return finish('completed', true);
      }
      if (mode === 'error') {
        // omitError 用来复现契约违例（ok:false 却不带 error）：编排层必须仍给出可读归因。
        // errorCode 让**各个**归因分支都能被真的走一遍（缺省仍是 AGENT_FAILED）。
        return finish(
          'error',
          false,
          script.omitError === true
            ? undefined
            : { code: script.errorCode ?? 'AGENT_FAILED', message: '假适配器：进程非零退出' },
        );
      }
      if (script.selfTimeout === true) {
        // 适配器**自报**超时（2026-09-28 起没有内层 `timeoutMs` 可依了）：直接按 timed-out 收场。
        // 这一档的存在意义是让 `classifyStop` 的「适配器自报 timed-out」那一支仍有生产者与守卫——
        // 那一支现在是行状态 `timed-out` 的**唯一**来源（编排层自己的兜底超时已删除）。
        return finish('timed-out', false, { code: 'AGENT_TIMED_OUT', message: '假适配器：自报超时' });
      }
      if (mode === 'gate') {
        const outcome = await new Promise<'released' | 'canceled'>((resolve) => {
          // 登记 gate 是**跨调用**可见的共享状态（`releaseAllAgents` 会遍历它），故与计数同一道代际守卫：
          // 上一代的挂起运行不许再把自己的放行函数插进来（同代的登记照旧，gate 的语义一个字没变）。
          // ⚠️ 与上面 `mode==='throw'` 那处同理：executor 是**同步**执行的 ⇒ 这一处今天恒真，
          // 不是「R31 可达的守卫落点」（用例里 `gates.size === 0` 成立是因为 reset 清空过它）
          if (currentGeneration()) fakeAgents.gates.set(input.cwd, () => resolve('released'));
          input.signal.addEventListener('abort', () => resolve('canceled'), { once: true });
        });
        if (outcome === 'canceled') return finish('canceled', false, { code: 'AGENT_CANCELED', message: '假适配器：被终止' });
      }
      writeFiles();
      // 成功路径的脚本事件在 `finish()` **之前**逐条投出：与真适配器一致（日志先于运行结论），
      // 也保证用例在 `run()` resolve 时已经收到全部日志（不需要等下一个宏任务）。
      // 这一投递同样受代际守卫约束：上一代的运行往**本代用例**的事件流里灌日志，会把别人的断言搅红。
      if (currentGeneration()) {
        for (const item of script.events ?? []) {
          input.onEvent({ seq: 0, at: new Date().toISOString(), type: 'log', stream: item.stream, text: item.text });
        }
        // rawEvents 原样投递（连 seq / at 都不动）：用例据此断言非 log 类型被逐字段透传、没有被加上前缀
        for (const event of script.rawEvents ?? []) input.onEvent(event);
        emitMessages(script);
      }
      return finish('completed', true);
    },
  };
}

/**
 * 供测试里的 `vi.mock('@aieval/agents', …)` 用作替代模块：**只换注册表**（`getProvider` /
 * `listAgentProviders`），模块的其余导出**原样取自真模块**。
 *
 * 为什么必须带上真模块的其余导出（2026-09-30 修）：`@aieval/agents` 的公共面在协议集合化时
 * 多了 `acceptsProtocol` / `protocolMismatchMessage`，而 `vi.mock` 是**整模块替换**——
 * 工厂没给的导出在消费点上是 `undefined`，症状不是「mock 失效」，而是
 * `[vitest] No "acceptsProtocol" export is defined on the "@aieval/agents" mock`：编排层的协议复检
 * 当场抛 `INTERNAL`，整行落 `failed`（实测：evaluator 16 个文件、83 条用例一起红，而报错点离真因很远）。
 *
 * 为什么用 `vi.importActual` 而不是在夹具里再写一遍那个判据与文案：`acceptsProtocol` 是**四个消费点
 * 唯一的判据**（A3），`protocolMismatchMessage` 是**唯一文案**；夹具里复制一份就是第五、第六份真源，
 * 而它漂移的表现恰好是「测试全绿、生产报错」。真模块这里**只被拉到仓库内的注册表与三个适配器模块**，
 * 厂商 SDK 全是 `createSdkLoader(async () => import(...))` 懒加载 ⇒ 不会因此加载任何厂商包。
 *
 * 返回 Promise 是刻意的：`vi.importActual` 是异步的，而**每个**调用点都写在
 * `vi.mock(…, async () => …)` 的工厂里（async 箭头会把嵌套 promise 摊平）⇒ 调用点一个都不用改。
 */
export async function fakeAgentsModule() {
  const actual = await vi.importActual<typeof import('@aieval/agents')>('@aieval/agents');
  return {
    // 真模块的一切（`acceptsProtocol` / `protocolMismatchMessage` 这两格**必须**同源，
    // 将来新增的导出也自动跟上）——只把注册表换成假的
    ...actual,
    getProvider: (kind: AgentKind) => makeFakeProvider(kind),
    listAgentProviders: () => AGENT_KINDS.map((kind) => makeFakeProvider(kind)),
  };
}

/** 假评分器的状态 */
export const fakeJudge = {
  calls: [] as JudgeInput[],
  /**
   * ok=返回固定判定；fail=抛 JUDGE_PARSE_FAILED（带 raw）；conflict=抛未配置评分模型；
   * gate=挂起等放行（**无视 signal**：比真实的滴流响应还恶劣）；abort=挂起但**如实响应 signal**
   * （模拟真实 `fetch`：abort 会让它立刻以「已中止」拒绝）。
   */
  mode: 'ok' as 'ok' | 'fail' | 'conflict' | 'gate' | 'abort',
  /**
   * 假评分器返回的读数：`true` = 评分表里每一项都达成（满分），`false` = 一项都没达成（0 分）。
   * 为什么是布尔而不是旧体系的分数：判据已经换成**逐项二元判定**，中间分不存在——
   * 留一个数字旋钮会让用例继续按「5 维各 4 分 ⇒ 80」那套算术写断言，而那个尺度早就不存在了。
   */
  achieved: true,
  gates: [] as (() => void)[],
  /**
   * 每次 `judgeRow` 调用若为 `true`：**这一次调用**先抛一次 `JUDGE_PARSE_FAILED`
   * 并报一轮「修复进度」，再成功返回分数（2026-09-27）。
   *
   * 为什么需要它（而不是再加一个 mode）：真实评分器内部有一套**结构检查 + 回问模型**的修复循环，
   * 而「第一轮答错、第二轮答对」正是那条循环的主路径。用 `mode: 'fail'` 只能造出「每次都失败」，
   * 于是「修复循环在最外层看来就是一次成功的评分」这条不变量在编排层完全没有观测点。
   *
   * **为什么是 boolean 而不是「前 N 次调用」**：修复循环、行级自动重试、手动重试三层都会调
   * `judgeRow`，一个**跨调用**的计数器会让「第 2 次调用」的含义随上下文漂移——实测踩过：
   * 行级自动重试的第二个 attempt 因为「已经失败过一次」而连第一次评分都直接失败，
   * 用例再也造不出「重试之后成功」这条主路径。语义收窄成「这一次调用先失败一次、再成功」之后，
   * 三个层次的行为都可预期。
   */
  failOnceThenSucceed: false,
  /** 前 `N` 次 `judgeRow` 调用抛结构失败，之后成功（计数由 `onAttemptStart` 在每次尝试开始时复位） */
  failFirstNCalls: 0,
  /**
   * 当前**尝试**内已经发生的 `judgeRow` 调用次数。
   *
   * 复位点是生产代码里的那个接缝：编排层每次进入评分阶段都会调 `input.onAttemptStart?.()`
   * （真实评分器把它当 no-op）。为什么需要这个边界：`failFirstNCalls = 1` 要表达的是
   * 「这一次跑起来时评分第一次失败、第二次成功」——把计数做成跨 attempt 累加的话，
   * 行级自动重试的第二个 attempt 会看到「已经失败过一次」，于是它连第一次评分都直接失败，
   * 用例再也造不出「重试之后成功」这条主路径（实测踩过）。
   * 同一 attempt 内的多次调用不触发复位 ⇒ 计数继续累加（那正是「这一次尝试里第一次失败」的语义）。
   */
  callCount: 0,
};

/** 每个用例开头调它 */
export function resetFakeJudge(): void {
  fakeJudge.calls.length = 0;
  fakeJudge.mode = 'ok';
  fakeJudge.achieved = true;
  fakeJudge.gates.length = 0;
  fakeJudge.failOnceThenSucceed = false;
  fakeJudge.failFirstNCalls = 0;
  fakeJudge.callCount = 0;
}

/** 放行当前所有评分 gate */
export function releaseJudge(): void {
  for (const release of fakeJudge.gates.splice(0)) release();
}

/** 供 `vi.mock('./judge', …)` 用作替代模块 */
export function fakeJudgeModule(): { judgeRow: (input: JudgeInput) => Promise<ScoreResult> } {
  return {
    judgeRow: async (input) => {
      fakeJudge.calls.push(input);
      // 编排层在每次尝试开始时通过这个接缝复位计数（见 `callCount` 的注释）
      input.onAttemptStart?.();
      fakeJudge.callCount += 1;
      // 两种失败脚本（可以叠加）：
      //   · `failOnceThenSucceed` —— **这一次调用**先失败一次再成功（模拟评分器内部的修复循环）；
      //   · `failFirstNCalls`     —— 跨调用的真计数（模拟「整个 attempt 都失败」，用于行级重试）
      if (fakeJudge.failOnceThenSucceed) {
        // 「这一次调用先失败一次」：报一轮修复进度（真实评分器的 onProgress 就是这个形状），
        // 再把这一次调用标记成已失败——**下一次调用**（真实实现里是修复后的第二轮）返回分数
        input.onProgress?.({ round: 1, message: '缺少对 D1（补透传用例）的判定：评分表里的每一项都必须恰好给出一条判定' });
      }
      const scriptedFailure = fakeJudge.failOnceThenSucceed || fakeJudge.callCount <= fakeJudge.failFirstNCalls;
      if (fakeJudge.mode === 'fail' || scriptedFailure) {
        throw new ServiceError('JUDGE_PARSE_FAILED', '评分解析失败：缺少对 D1（补透传用例）的判定', {
          context: { raw: '{"judgments":[]}' },
        });
      }
      if (fakeJudge.mode === 'conflict') {
        throw new ServiceError('CONFLICT', '未配置评分模型：请先到「设置 → 评分配置」里选择默认评分模型');
      }
      if (fakeJudge.mode === 'gate') {
        await new Promise<void>((resolve) => { fakeJudge.gates.push(resolve); });
      }
      if (fakeJudge.mode === 'abort') {
        // 如实响应 signal 的那一档（终审 FIX-1 的守卫要用它）：真实 `fetch` 在 signal 被 abort 时
        // **立刻**以 AbortError 拒绝，而 `gate` 那一档连 signal 都不看——两者测的是两件不同的事：
        // 「我们有没有把 signal 递下去并正确归因」（这一档）与「就算对方无视 signal，我们也有上界」（gate）。
        await new Promise<void>((_resolve, reject) => {
          const signal = input.signal;
          if (signal === undefined) {
            reject(new ServiceError('INTERNAL', '假评分器：这一路没有拿到 signal（调用方必须把它递下来）'));
            return;
          }
          const abort = (): void => reject(new ServiceError('INTERNAL', '调用文本 API 已中止（假评分器：如实响应了 signal）'));
          if (signal.aborted) { abort(); return; }
          signal.addEventListener('abort', abort, { once: true });
        });
      }
      return makeScoreFixture(fakeJudge.achieved, input.judgeProviderId, input.route.modelId);
    },
  };
}
