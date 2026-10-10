// @vitest-environment node
/**
 * 契约出口汇总：从**包根**导入全部名字，证明 `index.ts` 没漏。
 * 注意：`import type` 那一组由 `pnpm typecheck` 守卫（TS 会报「模块没有导出成员」），
 * 本文件负责运行时值的那一组——两条合起来才是完整的「出口没漏」证据。
 */
import { describe, expect, it } from 'vitest';
import {
  AGENT_EVENT_TYPES,
  AGENT_KINDS,
  AGENT_LABELS,
  AgentEventSchema,
  AgentKindSchema,
  CaseCreateSchema,
  CasePatchSchema,
  CommitCandidateSchema,
  ERROR_CODES,
  EvalRowSchema,
  EvalRowStatusSchema,
  EvalRunSchema,
  ExecutionModeSchema,
  GenerateRubricSchema,
  JUDGE_OUTPUT_CONTRACT,
  JUDGE_OUTPUT_JSON_SCHEMA,
  MAX_ITEM_WEIGHT,
  MCP_ENV_KEY_PATTERN,
  MCP_NAME_PATTERN,
  McpServerConfigSchema,
  McpServersSchema,
  PROTOCOL_LABELS,
  ProviderCreateSchema,
  ProviderModelInputSchema,
  ProviderModelSchema,
  ProviderPatchSchema,
  ProviderSchema,
  ProviderViewSchema,
  ProtocolTypeSchema,
  ROW_STATUS_LABELS,
  RepoCommitsInputSchema,
  RepoInfoSchema,
  RepoPathInputSchema,
  RepoSourceStringSchema,
  RepoValidateInputSchema,
  RowDiffFileSchema,
  RowDiffIndexSchema,
  RubricGroupSchema,
  RubricItemSchema,
  RunCreateSchema,
  SENSITIVE_KEY_PATTERN,
  SETTINGS_DEFAULTS,
  ScoreResultSchema,
  ServiceError,
  SettingsPatchSchema,
  SettingsSchema,
  SettingsViewSchema,
  TERMINAL_ROW_STATUSES,
  TestCaseSchema,
  ThemeModeSchema,
  composeTotalScore,
  displayRepoName,
  endpointText,
  hasSensitiveValue,
  httpStatusFor,
  isRunnableRow,
  isRunningRow,
  isSensitiveKey,
  maskApiKey,
  normalizeRemoteUrl,
  toSettingsView,
  parseRepoSource,
  preserveUnchangedSecrets,
  repoNameFromSource,
  type AgentKind,
  type AgentEvent,
  type RubricItem,
  type EvalRow,
  type EvalRun,
  type EvalRowStatus,
  type ExecutionMode,
  type GenerateRubricInput,
  type ProtocolType,
  type Provider,
  type ProviderCreate,
  type ProviderModel,
  type ProviderModelInput,
  type ProviderPatch,
  type ProviderView,
  type RepoCommitsInput,
  type RepoInfo,
  type RepoValidateInput,
  type RowDiffFile,
  type RowDiffIndex,
  type RunCreate,
  type ScoreResult,
  type TestCase,
  type CaseCreate,
  type CasePatch,
  type CommitCandidate,
  type RubricGroup,
  type McpServerConfig,
  type McpServers,
  type Settings,
  type SettingsPatch,
  type SettingsView,
  type ThemeMode,
  type ErrorCode,
} from './index';

describe('contracts 公共出口', () => {
  it('导出全部 schema 对象', () => {
    for (const schema of [
      ProtocolTypeSchema, ProviderModelSchema, ProviderSchema, ProviderViewSchema,
      ProviderCreateSchema, ProviderPatchSchema, ProviderModelInputSchema,
      TestCaseSchema, CaseCreateSchema, CasePatchSchema, RepoInfoSchema, CommitCandidateSchema,
      RepoPathInputSchema, GenerateRubricSchema, RepoValidateInputSchema, RepoCommitsInputSchema,
      RepoSourceStringSchema,
      AgentKindSchema, ExecutionModeSchema, EvalRowStatusSchema, EvalRowSchema, EvalRunSchema,
      RunCreateSchema, RowDiffIndexSchema, RowDiffFileSchema,
      RubricGroupSchema, RubricItemSchema, ScoreResultSchema,
      AgentEventSchema,
      SettingsSchema, SettingsPatchSchema, SettingsViewSchema, ThemeModeSchema,
      McpServerConfigSchema, McpServersSchema,
    ]) {
      expect(typeof schema.safeParse).toBe('function');
    }
  });

  it('导出全部常量', () => {
    expect([...AGENT_KINDS]).toEqual(['claude-code', 'codex', 'dsh']);
    // 八个（含 `vendor-system`）：清单与联合成员的一一对应另有一条专测，
    // 这里只钉「包根确实把这份清单导出成了一个可枚举的值」
    expect([...AGENT_EVENT_TYPES]).toHaveLength(8);
    expect(AGENT_LABELS.dsh).toBe('DeepSeek Harness');
    expect(PROTOCOL_LABELS.openai).toBe('OpenAI 兼容');
    expect(ROW_STATUS_LABELS['timed-out']).toBe('已超时');
    expect(TERMINAL_ROW_STATUSES).toContain('judged');
    expect(SETTINGS_DEFAULTS.diffBudgetBytes).toBe(262_144);
    expect(MAX_ITEM_WEIGHT).toBe(10_000);
    // 两份投影（文本 / 结构化）都必须从**包根**可用：适配器只 import '@aieval/contracts'
    expect(JUDGE_OUTPUT_CONTRACT).toContain('judgments');
    expect(JUDGE_OUTPUT_JSON_SCHEMA.properties.judgments.type).toBe('array');
    expect(ERROR_CODES).toContain('NOT_A_GIT_REPO');
    // MCP 的三份模式串也在包根上：名字与 env 键名是「一处拦、三家都安全」的那一处，
    // 敏感键名模式则是出口掩码的判据——任一取不到都意味着某个消费方要自己抄一份
    expect(MCP_NAME_PATTERN.test('my-server_1')).toBe(true);
    expect(MCP_NAME_PATTERN.test('my.server')).toBe(false);
    expect(MCP_ENV_KEY_PATTERN.test('CONTEXT7_API_KEY')).toBe(true);
    expect(SENSITIVE_KEY_PATTERN.test('GITHUB_TOKEN')).toBe(true);
    expect(SENSITIVE_KEY_PATTERN.test('NODE_ENV')).toBe(false);
    // 敏感键的**唯一判据**与「有没有已配置的密钥」也要从包根可用：`api`（探活的匿名说明）与
    // `ui`（「已配置密钥」小标）各自只能引 contracts，取不到就会各抄一份正则
    expect(isSensitiveKey('GITHUB_TOKEN')).toBe(true);
    expect(isSensitiveKey('NODE_ENV')).toBe(false);
    expect(hasSensitiveValue({ CONTEXT7_API_KEY: 'sk-live' })).toBe(true);
    expect(hasSensitiveValue({ CONTEXT7_API_KEY: '' })).toBe(false);
    expect(hasSensitiveValue(undefined)).toBe(false);
    // 「端点或命令」那一列的口径同源：`api` 的探活日志与 `ui` 的表格/预览读同一份实现
    expect(endpointText({ transport: 'stdio', enabled: true, command: 'npx', args: ['-y', 'pkg'] })).toBe('npx -y pkg');
    expect(endpointText({ transport: 'http', enabled: true, url: 'https://mcp.invalid/mcp' })).toBe(
      'https://mcp.invalid/mcp',
    );
  });

  it('导出全部函数，且函数在包根上可用（不只是名字存在）', () => {
    expect(maskApiKey('sk-abcdefghijklmn')).toBe('sk-**********klmn');
    // 总分仍由 `composeTotalScore` 算，但它现在的入参是「评分表 + 逐项判定」（判定与模型回的同形）
    const rubric = { groups: [{ name: 'g', items: [{ id: 'A', goal: 'g', weight: 100 }] }] };
    expect(composeTotalScore(rubric, [{ id: 'A', achieved: true, reason: '达成' }])).toBe(100);
    expect(isRunnableRow('failed')).toBe(true);
    expect(isRunningRow('running')).toBe(true);
    expect(httpStatusFor('JUDGE_PARSE_FAILED')).toBe(500);
    expect(new ServiceError('CONFLICT', '冲突').code).toBe('CONFLICT');
    expect(normalizeRemoteUrl('https://host/x.git/')).toBe('https://host/x.git');
    expect(parseRepoSource('git@host:group/repo.git')).toEqual({
      kind: 'remote',
      url: 'git@host:group/repo.git',
      host: 'host',
      repoName: 'repo',
    });
    expect(repoNameFromSource('https://host/group/repo.git')).toBe('repo');
    // 展示用取名走包根同样可用：它在渲染期取名字，坏数据不能让调用方抛
    expect(displayRepoName('ftp://host/x.git')).toBe('x');
    // 出口掩码与「未改动」消解同源可用：两者是 MCP 密钥的两个方向，任一在包根上取不到都是漏出口
    const oneServer = { transport: 'http', enabled: true, url: 'https://mcp.invalid/mcp' } as const;
    const stored = { ...SETTINGS_DEFAULTS, mcpServers: { 'example-server': oneServer } };
    expect(toSettingsView(stored).mcpServers['example-server']).toBeDefined();
    expect(preserveUnchangedSecrets(SETTINGS_DEFAULTS, { mcpServers: stored.mcpServers }).mcpServers).toBeDefined();
  });

  it('类型出口存在（编译期守卫：这里只做一次赋值，真正的检查是 typecheck）', () => {
    const protocol: ProtocolType = 'openai';
    const agent: AgentKind = 'codex';
    const mode: ExecutionMode = 'parallel';
    const status: EvalRowStatus = 'judged';
    const rubricItem: RubricItem = { id: 'A1', goal: '追加 agent 字段', weight: 18 };
    const theme: ThemeMode = 'auto';
    const code: ErrorCode = 'INVALID_REF';
    const settings: Settings = SETTINGS_DEFAULTS;
    const settingsView: SettingsView = toSettingsView(settings);
    const patch: SettingsPatch = { theme };
    const entry: McpServerConfig = { transport: 'http', enabled: true, url: 'https://mcp.invalid/mcp' };
    const servers: McpServers = { 'example-server': entry };
    const provider: Provider | null = null;
    const view: ProviderView | null = null;
    const model: ProviderModel | null = null;
    const modelInput: ProviderModelInput | null = null;
    const providerCreate: ProviderCreate | null = null;
    const providerPatch: ProviderPatch | null = null;
    const testCase: TestCase | null = null;
    const caseCreate: CaseCreate | null = null;
    const casePatch: CasePatch | null = null;
    const candidate: CommitCandidate | null = null;
    const repoInfo: RepoInfo | null = null;
    const repoValidateInput: RepoValidateInput | null = null;
    const repoCommitsInput: RepoCommitsInput | null = null;
    const generateInput: GenerateRubricInput | null = null;
    const row: EvalRow | null = null;
    const run: EvalRun | null = null;
    const runCreate: RunCreate | null = null;
    const rowDiffIndex: RowDiffIndex | null = null;
    const rowDiffFile: RowDiffFile | null = null;
    const score: ScoreResult | null = null;
    const rubricGroup: RubricGroup | null = null;
    const event: AgentEvent | null = null;

    expect([
      protocol, agent, mode, status, rubricItem, theme, code, settings, settingsView, patch, servers,
      provider, view, model, modelInput, providerCreate, providerPatch,
      testCase, caseCreate, casePatch, candidate, repoInfo, repoValidateInput, repoCommitsInput,
      generateInput, row, run, runCreate, rowDiffIndex, rowDiffFile,
      score, rubricGroup, event,
    ]).toHaveLength(33);
  });

  /**
   * 老 `run.json` 里那一行的构造夹具（最小一份；
   * `run.test.ts` 那份同名夹具在另一个模块作用域里，跨文件取不到）。
   * 刻意返回**字面量**而不是 `EvalRowSchema.parse` 的结果：这一条要验的正是「磁盘上已有的
   * 那一行**没有** `subagentTokens` 这一格时还能不能解析」——先 parse 再断言，就变成拿 schema
   * 自己的输出去问 schema（zod 会把未声明的键 strip 掉，那个问题恒为假，守卫也就永远不响）。
   */
  function makeRow(overrides: Partial<EvalRow> = {}): EvalRow {
    return {
      id: 'row-1',
      agentKind: 'codex',
      providerId: 'p1',
      providerName: '测试供应商',
      baseUrl: 'https://fake.invalid/v1',
      modelId: 'm1',
      status: 'judged',
      branch: 'test/row-1',
      workspacePath: 'C:/runs/run-1/rows/row-1/workspace',
      baselineCommit: 'a'.repeat(40),
      tokens: null,
      turns: null,
      durationMs: null,
      diff: null,
      score: null,
      error: null,
      attempts: 1,
      ...overrides,
    };
  }

  /**
   * `EvalRow.subagentTokens`。
   * 两个方向都要钉住，与 `EvalRow.error.stage` / `EvalRow.attempts` 同一组理由：
   *   ① **老 run.json 必须照样解析**——它整格不存在，写成必填会让 `listRuns()` 静默跳过那一轮
   *      （使用者看到的是「我的评测记录凭空少了几轮」，两端都不报错）；
   *   ② 带上它（数字或显式 `null`）时**原样保留**——被 strip 掉的话适配器写的分量永远到不了界面，
   *      而所有直接构造行对象的用例照样全绿。
   */
  it('EvalRow 的 subagentTokens：可选、可空，老 run.json 不受影响', () => {
    const legacy = makeRow();
    expect('subagentTokens' in legacy).toBe(false); // 老记录：整格不存在
    // 上一句只证明夹具没写这一格；「写成必填就会让 listRuns() 静默跳过那一轮」由这里拦
    expect(EvalRowSchema.safeParse(legacy).success).toBe(true);
    const withSplit = makeRow({ subagentTokens: { input: 4, cached: 1, output: 2 } });
    expect(EvalRowSchema.parse(withSplit).subagentTokens).toEqual({ input: 4, cached: 1, output: 2 });
    const unknown = makeRow({ subagentTokens: null });
    expect(EvalRowSchema.parse(unknown).subagentTokens).toBeNull();
  });

  /**
   * `EvalRow.subagentTurns`（与 `subagentTokens` 逐格同一条处置）：
   * 同一组两个方向——老 `run.json` 整格不存在时要照样解析（必填会让 `listRuns()` 静默跳过那一轮），
   * 而带上它（数字或显式 `null`）时必须原样保留（被 strip 掉的话适配器写的分量永远到不了界面）。
   * 与上面那一条分开写而不是合并：两格是**两个**可选键，合并之后只要有一格漏进 schema，
   * 另一格的断言会替它把整条用例撑绿。
   */
  it('EvalRow 的 subagentTurns：可选、可空，老 run.json 不受影响', () => {
    const legacy = makeRow();
    expect('subagentTurns' in legacy).toBe(false); // 老记录：整格不存在
    expect(EvalRowSchema.safeParse(legacy).success).toBe(true);
    const withSplit = makeRow({ subagentTurns: 4 });
    expect(EvalRowSchema.parse(withSplit).subagentTurns).toBe(4);
    // 显式 null = 「明确没采到」（有子智能体但轮次读不到），与缺格的「保持原值」是两件事
    const unknown = makeRow({ subagentTurns: null });
    expect(EvalRowSchema.parse(unknown).subagentTurns).toBeNull();
  });

  /**
   * `EvalRow.streamingDelta`：同一组两个方向 + **三态不许互相顶替**。
   *
   * 这一格是「本次到底有没有收到逐字流」的唯一事后痕迹（增量帧只广播不落盘），
   * 而它的三态在语义上是三件事：**缺格 = 没观测**、`frameCount: 0` = 观测到零帧、
   * `> 0` = 有增量。所以除了「老 run.json 照样解析」之外，还要钉住**数字原样保留**——
   * 被 strip 掉的话适配器写的观测永远到不了环境抽屉，界面继续把「没挂上」显示成「没观测」。
   */
  it('EvalRow 的 streamingDelta：可选、可空，三态各自可辨', () => {
    const legacy = makeRow();
    expect('streamingDelta' in legacy).toBe(false); // 老记录：整格不存在 = 没观测
    expect(EvalRowSchema.safeParse(legacy).success).toBe(true);

    const withDelta = makeRow({ streamingDelta: { frameCount: 12, lastFrameChars: 340 } });
    expect(EvalRowSchema.parse(withDelta).streamingDelta).toEqual({ frameCount: 12, lastFrameChars: 340 });

    // `0` 是**观测到的值**（不是「没采到」）：显式 null 才是「没观测」，两者必须都能表达
    const zero = makeRow({ streamingDelta: { frameCount: 0, lastFrameChars: 0 } });
    expect(EvalRowSchema.parse(zero).streamingDelta).toEqual({ frameCount: 0, lastFrameChars: 0 });
    expect(EvalRowSchema.parse(makeRow({ streamingDelta: null })).streamingDelta).toBeNull();

    // 负数帧数不是「没观测」的近义词，而是坏数据：schema 层就拒（免得界面画出负的条数）
    expect(EvalRowSchema.safeParse(makeRow({ streamingDelta: { frameCount: -1, lastFrameChars: 0 } })).success).toBe(false);
  });
});
