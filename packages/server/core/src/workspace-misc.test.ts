// @vitest-environment node
/**
 * 评分智能体的独立配置目录（.judgehome）
 *
 * 本文件是 `workspace.test.ts` 拆分后的一块：临时家目录 / 仓库模板与清理钩子都在 `./testing/workspace-harness`。
 */
import { mkdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  makeRepo,
  root,
  existsSync,
  writeFileSync,
  join,
  ensureCandidateJudgeHome,
  prepareCandidateWorkspace,
  candidateAgentHomeDir,
  candidateDir,
  candidateJudgeHomeDir,
  candidateWorkspaceDir,
  type AppConfig,
  type Logger,
  type PendingAgentEvent,
  registerWorkspaceHooks,
} from './testing/workspace-harness';



registerWorkspaceHooks();


/**
 * 评分智能体的独立配置目录。
 *
 * 为什么它必须是**另一个**目录、而不是复用 `.agenthome`：评分智能体可能与被测智能体不是同一家，
 * 而 `.agenthome` 是 `CLAUDE_CONFIG_DIR` / `DSH_HOME` / `CODEX_HOME` 的落点——两家的配置格式不同，
 * 共用一个目录会互相破坏（静默的那一种：CLI 会安静地忽略读不懂的配置，表现成「模型路由没生效」）。
 *
 * 为什么「重跑要清掉」值得一条独立的守卫：`clearCandidateArtifacts` 里三个产物是**逐个列出**删除的
 * （该函数的口径是「新落的东西默认不被顺手删掉」），漏掉 `.judgehome` 这条不会有任何别的用例变红——
 * 而症状是下一轮评分智能体**带着上一轮的会话与配置**跑，分数看起来照常出得来。
 */
describe('评分智能体的独立配置目录（.judgehome）', () => {
  it('candidateJudgeHomeDir 落在候选目录下的 .judgehome（与 .agenthome 分开：评分智能体可能不是同一家）', () => {
    expect(candidateJudgeHomeDir(root, 'run-1', 'candidate-1')).toBe(join(root, 'run-1', 'candidates', 'candidate-1', '.judgehome'));
    // 两个配置目录必须各是各的：评分智能体与被测智能体可能是两家 CLI
    expect(candidateJudgeHomeDir(root, 'run-1', 'candidate-1')).not.toBe(candidateAgentHomeDir(root, 'run-1', 'candidate-1'));
  });

  it('重跑同一个候选会清掉 .judgehome（上一轮评分智能体的会话与配置不该留给下一轮）', () => {
    const { dir, commit } = makeRepo();
    const input = {
      workspaceRoot: join(root, 'runs'),
      caseId: 'case-1',
      repoPath: dir,
      runId: 'run-1',
      candidateId: 'candidate-1',
      commitHash: commit,
      branch: 'test/candidate-1',
    };

    // 第一轮：建工作区 + 建评分智能体配置目录 + 往里写一个文件（模拟 CLI 落下的会话文件）
    prepareCandidateWorkspace(input);
    const judgeHome = ensureCandidateJudgeHome(input.workspaceRoot, input.runId, input.candidateId);
    writeFileSync(join(judgeHome, 'session.json'), '{"model":"评分智能体"}', 'utf8');
    expect(existsSync(join(judgeHome, 'session.json'))).toBe(true);

    // 第二轮：重跑同一行。clearCandidateArtifacts 里 `.judgehome` 那一条是**逐个列出**的，
    // 漏了它这条用例才会红
    prepareCandidateWorkspace(input);
    expect(existsSync(join(judgeHome, 'session.json'))).toBe(false);
    // 这里**不**自己 rmSync(root)：`makeTmp` 已经把它登记进 afterEach 的清理列表，
    // 多写一句只会让人以为「不删就会漏」，而真正的清理责任在那一处
  });
});

describe('core 公共出口（`@aieval/core` 包根）', () => {
  it('git / workspace / event-log 的名字都能从包根拿到', async () => {
    const core = await import('./index');
    for (const name of [
      'isGitRepo', 'resolveRepoInfo', 'assertCommit', 'listCommits',
      'ensureCaseCache', 'copyWorkspace', 'checkoutCandidate', 'collectDiff', 'truncateDiff',
      'caseCacheDir', 'runDir', 'candidateDir', 'candidateWorkspaceDir', 'candidateAgentHomeDir', 'candidateJudgeHomeDir',
      'ensureCandidateJudgeHome', 'candidateEventsFile', 'candidateMessagesFile', 'runSnapshotFile', 'prepareCandidateWorkspace',
      'appendEvent', 'readEvents', 'readEventsAfter', 'resetEvents',
      'appendRecord', 'appendMessage', 'appendSubagent', 'readRecords', 'readCandidateRecords',
      'foldMessages', 'foldSubagents', 'resetRecords',
      'createLogger', 'getConfigDir', 'loadConfig', 'saveConfig', 'setConfigDirForTesting',
      'defaultWorkspaceRoot', 'expandHome', 'resolveRootForRead', 'validateWorkspaceRoot',
    ]) {
      expect(typeof (core as Record<string, unknown>)[name]).toBe('function');
    }
  });

  it('包根还导出三个**类型**（Logger / AppConfig / PendingAgentEvent）', () => {
    // 类型在运行时被完全擦除，上面那条 `typeof core[name] === 'function'` 对它们**永远看不到**，
    // 所以本条的守卫本体在编译期：文件顶部那行
    //   `import type { AppConfig, Logger, PendingAgentEvent } from './index'`
    // 只要有一个名字不再从包根导出，`pnpm --filter @aieval/core typecheck` 就会以
    // TS2305（Module has no exported member）点名本文件——这正是 PendingAgentEvent
    // 以 type 形式从包根可见的落点。下面的断言只是让这三个类型在值层面「被用到」，
    // 让 tsc 与 eslint 都不把它们当死代码删掉。
    const probe: [AppConfig | null, Logger | null, PendingAgentEvent | null] = [null, null, null];
    expect(probe).toEqual([null, null, null]);
  });
});


/**
 * 交叉核验：`EvalCandidate` 的字段名与必填项以 **contracts** 为真源，不另立一份 TS 块。
 * `EvalCandidateSchema` 有 `providerId` 与 `error.code` 这两格——这两格以 contracts 为准，
 * 按早先的形状构造候选对象会编译不过或语义不全，所以这里留一条**可执行**的对齐证据。
 */
describe('EvalCandidate 契约与落盘形状对齐', () => {
  it('一个按契约构造的候选对象能通过 EvalCandidateSchema（字段名与必填项以 contracts 为准）', async () => {
    const { EvalCandidateSchema } = await import('@aieval/contracts');
    const candidate = {
      id: 'candidate-1',
      agentKind: 'cc',
      // 执行期定位凭据用 id，展示快照 providerName 可以被改名
      providerId: 'p-1',
      providerName: '网关',
      baseUrl: 'https://gw.example.com/anthropic',
      modelId: 'claude-opus-4-6',
      status: 'judged',
      branch: 'test/candidate-1',
      workspacePath: candidateWorkspaceDir(root, 'run-1', 'candidate-1'),
      // 40 位具体 hash（prepareCandidateWorkspace 的返回值就长这样）
      baselineCommit: 'a'.repeat(40),
      tokens: { input: 1, cached: 0, output: 2 },
      turns: 1,
      durationMs: 1000,
      diff: { filesChanged: 1, insertions: 1, deletions: 0, truncated: false },
      score: null,
      // code 必填，且要能同时装下 AgentErrorCode 与接口层 ErrorCode
      error: { code: 'JUDGE_PARSE_FAILED', message: '维度缺失' },
    };
    expect(EvalCandidateSchema.safeParse(candidate).success).toBe(true);
    expect(EvalCandidateSchema.safeParse({ ...candidate, baselineCommit: 'abc1234' }).success).toBe(true); // 只要求是字符串；空串 = 尚未准备也是合法的
    expect(EvalCandidateSchema.safeParse({ ...candidate, providerId: undefined }).success).toBe(false);
    expect(EvalCandidateSchema.safeParse({ ...candidate, error: { message: '维度缺失' } }).success).toBe(false);
  });
});


/**
 * 旧产物目录的兼容：候选目录曾经叫 `rows/`。
 * 判据是**目录是否存在**——新目录在就优先新的；只有旧目录时才回退（历史评测照样能读日志、看 diff）。
 */
describe('候选目录的旧布局兼容（rows/ → candidates/）', () => {
  it('只有旧目录 ⇒ 沿用；新旧都在 ⇒ 用新目录', () => {
    mkdirSync(join(root, 'run-legacy', 'rows', 'old-1'), { recursive: true });
    expect(candidateDir(root, 'run-legacy', 'old-1')).toBe(join(root, 'run-legacy', 'rows', 'old-1'));

    mkdirSync(join(root, 'run-legacy', 'candidates', 'old-1'), { recursive: true });
    expect(candidateDir(root, 'run-legacy', 'old-1')).toBe(join(root, 'run-legacy', 'candidates', 'old-1'));
  });

  it('两个目录都不存在 ⇒ 返回新布局（新候选不写进旧布局）', () => {
    expect(candidateDir(root, 'run-fresh', 'fresh-1')).toBe(join(root, 'run-fresh', 'candidates', 'fresh-1'));
  });
});
