// @vitest-environment node
/**
 * 用例契约：默认值（commitHash / 远端分支可为 null）、部分更新、仓库与 commit 的两个校验入参，
 * 以及**用例上不再有评分模型**（只走设置页的全局默认）。
 * 注意：`commitHash: null` 不是「缺失」而是「用默认分支 HEAD」，故它必须是 nullable 而不是 optional；
 * `repoBranch` 同一口径（null = 用远端默认分支），且旧 config.json 里根本没有这一列，读回来必须落成 null。
 */
import { describe, expect, it } from 'vitest';
import {
  CaseCreateSchema,
  CasePatchSchema,
  CommitCandidateSchema,
  GenerateRubricSchema,
  RepoCommitsInputSchema,
  RepoInfoSchema,
  RepoPathInputSchema,
  RepoValidateInputSchema,
  TestCaseSchema,
} from './case';

const testCase = {
  id: 'c-1',
  title: '实现一个 LRU 缓存',
  repoPath: 'D:/repos/demo',
  commitHash: null,
  taskPrompt: '在这个仓库里实现一个 LRU 缓存',
  rubric: {
    groups: [
      { name: '一、生产代码', items: [{ id: 'A1', goal: '追加 agent 字段', weight: 18 }] },
      { name: '二、测试', items: [{ id: 'D1', goal: '补一条透传用例', weight: 14 }] },
    ],
  },
  createdAt: '2026-09-22T10:30:00.000Z',
  updatedAt: '2026-09-22T10:30:00.000Z',
};

describe('TestCaseSchema', () => {
  it('接受完整记录，且要求必填文本非空', () => {
    expect(TestCaseSchema.safeParse(testCase).success).toBe(true);
    expect(TestCaseSchema.safeParse({ ...testCase, title: '' }).success).toBe(false);
    expect(TestCaseSchema.safeParse({ ...testCase, repoPath: '' }).success).toBe(false);
    expect(TestCaseSchema.safeParse({ ...testCase, taskPrompt: '' }).success).toBe(false);
    // 空表在 schema 层是**合法**的（`{ groups: [] }` 是「新建用例」的初值）：非空要求由
    // `validateRubric` 在提交时给出——契约层设 `.min(1)` 会把「新建用例」这个动作本身判为非法
    expect(TestCaseSchema.safeParse({ ...testCase, rubric: { groups: [] } }).success).toBe(true);
    // 但**整格缺失**不是空表：缺了它这一格就是 undefined，评分阶段没有尺子可用——
    // 若它退化成 `.optional()`，上面那条空表断言与全部夹具照样全绿（守卫必须见过它红）
    expect(TestCaseSchema.safeParse({ ...testCase, rubric: undefined }).success).toBe(false);
  });

  it('commitHash 必须是 null 或非空字符串（空串不是「用 HEAD」的写法）', () => {
    expect(TestCaseSchema.safeParse({ ...testCase, commitHash: 'abc1234' }).success).toBe(true);
    expect(TestCaseSchema.safeParse({ ...testCase, commitHash: '' }).success).toBe(false);
  });

  it('repoBranch 缺字段读成 null（旧 config.json 的用例没有这一列）', () => {
    const parsed = TestCaseSchema.parse({ ...testCase, repoBranch: undefined });
    expect(parsed.repoBranch).toBeNull();
  });

  it('repoPath 走来源判定：ftp:// 被拒、git 地址通过', () => {
    expect(TestCaseSchema.safeParse({ ...testCase, repoPath: 'ftp://host/x.git' }).success).toBe(false);
    expect(TestCaseSchema.safeParse({ ...testCase, repoPath: 'git@host:group/repo.git' }).success).toBe(true);
  });
});

describe('CaseCreateSchema', () => {
  it('两个可空字段缺省为 null（留空 = 用默认分支 HEAD / 远端默认分支）', () => {
    const parsed = CaseCreateSchema.parse({
      title: 't',
      repoPath: 'D:/r',
      taskPrompt: 'p',
      rubric: { groups: [] },
    });
    expect(parsed.commitHash).toBeNull();
    expect(parsed.repoBranch).toBeNull();
    // 与 TestCaseSchema 同一条口径：空表合法，**整格缺失**非法（`rubric` 必填——缺了它这一格是 undefined，
    // 与「表还在、只是空的」是两件事）
    expect(CaseCreateSchema.safeParse({ title: 't', repoPath: 'D:/r', taskPrompt: 'p' }).success).toBe(false);
  });

  it('用例上不存在评分模型字段：多给也要被剥掉（否则「用例覆盖 > 全局默认」会从后门回来）', () => {
    const parsed = CaseCreateSchema.parse({
      title: 't',
      repoPath: 'D:/r',
      taskPrompt: 'p',
      rubric: { groups: [] },
      judgeProviderId: 'p-1',
      judgeModelId: 'm-1',
    });
    expect(parsed).not.toHaveProperty('judgeProviderId');
    expect(parsed).not.toHaveProperty('judgeModelId');
  });

  it('拒绝把可空字段写成 undefined 之外的空串', () => {
    expect(
      CaseCreateSchema.safeParse({
        title: 't', repoPath: 'D:/r', taskPrompt: 'p', rubric: { groups: [] }, commitHash: '',
      }).success,
    ).toBe(false);
  });
});

describe('CasePatchSchema', () => {
  it('允许空补丁与单字段补丁（改标题不该被迫重填仓库路径）', () => {
    expect(CasePatchSchema.safeParse({}).success).toBe(true);
    expect(CasePatchSchema.parse({ title: '新标题' })).toEqual({ title: '新标题' });
  });
});

describe('RepoInfoSchema / CommitCandidateSchema', () => {
  it('回显仓库名与当前分支（通过后回显仓库名与当前分支）', () => {
    const info = RepoInfoSchema.parse({
      repoPath: 'D:/repos/demo',
      repoName: 'demo',
      branch: 'main',
      kind: 'local',
      mirrorPath: null,
      mirrorReady: false,
      mirrorFetchedAt: null,
      tip: null,
    });
    expect(info.repoName).toBe('demo');
    expect(info.branch).toBe('main');
    expect(RepoInfoSchema.safeParse({ repoPath: 'D:/repos/demo', repoName: 'demo' }).success).toBe(false);
  });

  it('RepoInfo 的远端字段是必填（界面靠 kind 决定回显哪一套）', () => {
    const remote = {
      repoPath: 'git@host:group/repo.git',
      repoName: 'repo',
      branch: 'main',
      kind: 'remote',
      mirrorPath: 'C:/runs/remotes/repo-1a2b3c4d',
      mirrorReady: true,
      mirrorFetchedAt: '2026-09-26T04:00:00.000Z',
      tip: 'abc1234',
    };
    expect(RepoInfoSchema.parse(remote).kind).toBe('remote');
    expect(RepoInfoSchema.safeParse({ repoPath: 'D:/r', repoName: 'r', branch: 'main' }).success).toBe(false);
  });

  it('commit 候选是 hash + subject 两个字段', () => {
    expect(CommitCandidateSchema.safeParse({ hash: 'abc1234', subject: '初始提交' }).success).toBe(true);
    expect(CommitCandidateSchema.safeParse({ hash: 'abc1234' }).success).toBe(false);
  });
});

describe('校验入参', () => {
  it('仓库校验只按仓库路径，不按 caseId（新建时还没有 caseId）', () => {
    expect(RepoPathInputSchema.safeParse({ repoPath: 'D:/repos/demo' }).success).toBe(true);
    expect(RepoPathInputSchema.safeParse({ repoPath: '' }).success).toBe(false);
    expect(RepoPathInputSchema.safeParse({ caseId: 'c-1' }).success).toBe(false);
  });

  it('生成评分标准项：题面与提示词都可缺省，且评分模型不在入参里', () => {
    const parsed = GenerateRubricSchema.parse({ mode: 'generate', rubric: { groups: [] }, taskPrompt: '写个 LRU' });
    expect(parsed.taskPrompt).toBe('写个 LRU');
    expect(parsed.prompt).toBe('');
    expect(parsed.repoPath).toBe('');
    expect(parsed).not.toHaveProperty('judgeProviderId');
    expect(parsed).not.toHaveProperty('judgeModelId');
  });

  /**
   * 三支的**显式分派**：`mode` 必填且只认三个值。
   * 为什么值得一条守卫：三支里有两支的 `prompt` 都是必填，靠它分不出意图——
   * 少了这条，把 `mode` 改回可选、再按 `prompt` 空不空猜分支的写法会一路绿到运行期，
   * 症状是「智能调整」被当成「智能识别」跑（整表替换掉用户的标准，而界面上一切正常）。
   */
  it('mode 必填、只认三支（缺省或乱填一律拒）', () => {
    expect(GenerateRubricSchema.safeParse({ rubric: { groups: [] }, taskPrompt: 't' }).success).toBe(false);
    expect(GenerateRubricSchema.safeParse({ mode: 'guess', rubric: { groups: [] } }).success).toBe(false);
    for (const mode of ['generate', 'recognize', 'adjust'] as const) {
      expect(GenerateRubricSchema.parse({ mode, rubric: { groups: [] } }).mode).toBe(mode);
    }
  });

  it('校验 / 候选入参带可选分支，缺省为 null', () => {
    expect(RepoValidateInputSchema.parse({ repoPath: 'D:/r' }).repoBranch).toBeNull();
    expect(RepoCommitsInputSchema.parse({ repoPath: 'D:/r', repoBranch: 'feat/x' }).repoBranch).toBe('feat/x');
  });
});
