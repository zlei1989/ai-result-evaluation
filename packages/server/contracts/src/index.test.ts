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
  SETTINGS_DEFAULTS,
  ScoreResultSchema,
  ServiceError,
  SettingsPatchSchema,
  SettingsSchema,
  TERMINAL_ROW_STATUSES,
  TestCaseSchema,
  ThemeModeSchema,
  composeTotalScore,
  displayRepoName,
  httpStatusFor,
  isRunnableRow,
  isRunningRow,
  maskApiKey,
  normalizeRemoteUrl,
  parseRepoSource,
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
  type Settings,
  type SettingsPatch,
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
      SettingsSchema, SettingsPatchSchema, ThemeModeSchema,
    ]) {
      expect(typeof schema.safeParse).toBe('function');
    }
  });

  it('导出全部常量', () => {
    expect([...AGENT_KINDS]).toEqual(['claude-code', 'codex', 'dsh']);
    expect([...AGENT_EVENT_TYPES]).toHaveLength(7);
    expect(AGENT_LABELS.dsh).toBe('DeepSeek Harness');
    expect(PROTOCOL_LABELS.openai).toBe('OpenAI 兼容');
    expect(ROW_STATUS_LABELS['timed-out']).toBe('已超时');
    expect(TERMINAL_ROW_STATUSES).toContain('judged');
    expect(SETTINGS_DEFAULTS.diffBudgetBytes).toBe(262_144);
    expect(MAX_ITEM_WEIGHT).toBe(10_000);
    // 两份投影（文本 / 结构化）都必须从**包根**可用：Task 6/7 的适配器只 import '@aieval/contracts'
    expect(JUDGE_OUTPUT_CONTRACT).toContain('judgments');
    expect(JUDGE_OUTPUT_JSON_SCHEMA.properties.judgments.type).toBe('array');
    expect(ERROR_CODES).toContain('NOT_A_GIT_REPO');
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
    const patch: SettingsPatch = { theme };
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
      protocol, agent, mode, status, rubricItem, theme, code, settings, patch,
      provider, view, model, modelInput, providerCreate, providerPatch,
      testCase, caseCreate, casePatch, candidate, repoInfo, repoValidateInput, repoCommitsInput,
      generateInput, row, run, runCreate, rowDiffIndex, rowDiffFile,
      score, rubricGroup, event,
    ]).toHaveLength(31);
  });
});
