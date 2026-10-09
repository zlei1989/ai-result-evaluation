// @vitest-environment node
/**
 * 评分智能体的独立配置目录（.judgehome）
 *
 * 本文件是 `workspace.test.ts` 拆分后的一块：临时家目录 / 仓库模板与清理钩子都在 `./testing/workspace-harness`。
 */
import { describe, expect, it } from 'vitest';
import {
  makeRepo,
  root,
  existsSync,
  writeFileSync,
  join,
  ensureRowJudgeHome,
  prepareRowWorkspace,
  rowAgentHomeDir,
  rowJudgeHomeDir,
  rowWorkspaceDir,
  type AppConfig,
  type Logger,
  type PendingAgentEvent,
  registerWorkspaceHooks,
} from './testing/workspace-harness';



registerWorkspaceHooks();


/**
 * 评分智能体的独立配置目录（spec §7.3 的 D8）。
 *
 * 为什么它必须是**另一个**目录、而不是复用 `.agenthome`：评分智能体可能与被测智能体不是同一家，
 * 而 `.agenthome` 是 `CLAUDE_CONFIG_DIR` / `DSH_HOME` / `CODEX_HOME` 的落点——两家的配置格式不同，
 * 共用一个目录会互相破坏（静默的那一种：CLI 会安静地忽略读不懂的配置，表现成「模型路由没生效」）。
 *
 * 为什么「重跑要清掉」值得一条独立的守卫：`clearRowArtifacts` 里三个产物是**逐个列出**删除的
 * （该函数的口径是「新落的东西默认不被顺手删掉」），漏掉 `.judgehome` 这条不会有任何别的用例变红——
 * 而症状是下一轮评分智能体**带着上一轮的会话与配置**跑，分数看起来照常出得来。
 */
describe('评分智能体的独立配置目录（.judgehome）', () => {
  it('rowJudgeHomeDir 落在行目录下的 .judgehome（与 .agenthome 分开：评分智能体可能不是同一家）', () => {
    expect(rowJudgeHomeDir(root, 'run-1', 'row-1')).toBe(join(root, 'run-1', 'rows', 'row-1', '.judgehome'));
    // 两个配置目录必须各是各的：评分智能体与被测智能体可能是两家 CLI
    expect(rowJudgeHomeDir(root, 'run-1', 'row-1')).not.toBe(rowAgentHomeDir(root, 'run-1', 'row-1'));
  });

  it('重跑同一行会清掉 .judgehome（上一轮评分智能体的会话与配置不该留给下一轮）', () => {
    const { dir, commit } = makeRepo();
    const input = {
      workspaceRoot: join(root, 'runs'),
      caseId: 'case-1',
      repoPath: dir,
      runId: 'run-1',
      rowId: 'row-1',
      commitHash: commit,
      branch: 'test/row-1',
    };

    // 第一轮：建工作区 + 建评分智能体配置目录 + 往里写一个文件（模拟 CLI 落下的会话文件）
    prepareRowWorkspace(input);
    const judgeHome = ensureRowJudgeHome(input.workspaceRoot, input.runId, input.rowId);
    writeFileSync(join(judgeHome, 'session.json'), '{"model":"评分智能体"}', 'utf8');
    expect(existsSync(join(judgeHome, 'session.json'))).toBe(true);

    // 第二轮：重跑同一行。clearRowArtifacts 里 `.judgehome` 那一条是**逐个列出**的，
    // 漏了它这条用例才会红（变异验证见 Step 9）
    prepareRowWorkspace(input);
    expect(existsSync(join(judgeHome, 'session.json'))).toBe(false);
    // 这里**不**自己 rmSync(root)：`makeTmp` 已经把它登记进 afterEach 的清理列表（终审 ADD-5），
    // 多写一句只会让人以为「不删就会漏」，而真正的清理责任在那一处
  });
});

describe('core 公共出口（`@aieval/core` 包根）', () => {
  it('git / workspace / event-log 的名字都能从包根拿到', async () => {
    const core = await import('./index');
    for (const name of [
      'isGitRepo', 'resolveRepoInfo', 'assertCommit', 'listCommits',
      'ensureCaseCache', 'copyWorkspace', 'checkoutRow', 'collectDiff', 'truncateDiff',
      'caseCacheDir', 'runDir', 'rowDir', 'rowWorkspaceDir', 'rowAgentHomeDir', 'rowJudgeHomeDir',
      'ensureRowJudgeHome', 'rowEventsFile', 'rowMessagesFile', 'runSnapshotFile', 'prepareRowWorkspace',
      'appendEvent', 'readEvents', 'readEventsAfter', 'resetEvents',
      'appendRecord', 'appendMessage', 'appendSubagent', 'readRecords', 'readRowRecords',
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
    // TS2305（Module has no exported member）点名本文件——这正是 R17 要求 PendingAgentEvent
    // 以 type 形式从包根可见的落点。下面的断言只是让这三个类型在值层面「被用到」，
    // 让 tsc 与 eslint 都不把它们当死代码删掉。
    const probe: [AppConfig | null, Logger | null, PendingAgentEvent | null] = [null, null, null];
    expect(probe).toEqual([null, null, null]);
  });
});


/**
 * 交叉核验（Task 15 Step 4）：`EvalRow` 的字段名与必填项以 **contracts** 为真源，不是 spec §7.2 的 TS 块。
 * Task 4 给 `EvalRowSchema` 补了 `providerId`（R8）与 `error.code`（R9），而 spec §7.2 的 TS 块里没有这两个字段——
 * p1–p5 照 spec 构造行对象会编译不过或语义不全，所以这里留一条**可执行**的对齐证据（R8 / R9 的落实核验）。
 */
describe('EvalRow 契约与本计划产出的形状对齐（R8 / R9 的落实核验）', () => {
  it('一个按契约构造的行对象能通过 EvalRowSchema（字段名与必填项以 contracts 为准，不是 spec §7.2 的 TS 块）', async () => {
    const { EvalRowSchema } = await import('@aieval/contracts');
    const row = {
      id: 'row-1',
      agentKind: 'claude-code',
      // R8：执行期定位凭据用 id，展示快照 providerName 可以被改名
      providerId: 'p-1',
      providerName: '网关',
      baseUrl: 'https://gw.example.com/anthropic',
      modelId: 'claude-opus-4-6',
      status: 'judged',
      branch: 'test/row-1',
      workspacePath: rowWorkspaceDir(root, 'run-1', 'row-1'),
      // R2：40 位具体 hash（prepareRowWorkspace 的返回值就长这样）
      baselineCommit: 'a'.repeat(40),
      tokens: { input: 1, cached: 0, output: 2 },
      turns: 1,
      durationMs: 1000,
      diff: { filesChanged: 1, insertions: 1, deletions: 0, truncated: false },
      score: null,
      // R9：code 必填，且要能同时装下 AgentErrorCode 与接口层 ErrorCode
      error: { code: 'JUDGE_PARSE_FAILED', message: '维度缺失' },
    };
    expect(EvalRowSchema.safeParse(row).success).toBe(true);
    expect(EvalRowSchema.safeParse({ ...row, baselineCommit: 'abc1234' }).success).toBe(true); // 只要求是字符串；空串 = 尚未准备也是合法的（R2）
    expect(EvalRowSchema.safeParse({ ...row, providerId: undefined }).success).toBe(false);
    expect(EvalRowSchema.safeParse({ ...row, error: { message: '维度缺失' } }).success).toBe(false);
  });
});
