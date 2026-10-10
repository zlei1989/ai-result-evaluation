// @vitest-environment node
/**
 * updateCase
 *
 * 本文件是 `cases.test.ts` 拆分后的一块：共享夹具、真实 git 助手与两条 `vi.mock`（node:fs / node:child_process 的计数探针）都在 `./testing/cases-harness`，那里写明了为什么前导块必须在每个文件里逐字重复（vitest 的前置提升只作用于本文件）。
 */

import { vi, describe, expect, it } from 'vitest';
import {
  dir,
  repo,
  git,
  makeRepo,
  caseInput,
  legacyCaseShapes,
  seedLegacyCase,
  seedLegacyJudgeOverrideCase,
  uiPatchOf,
  mkdirSync,
  join,
  ServiceError,
  listStoredCases,
  readCase,
  writeCase,
  createCase,
  getCase,
  listCases,
  updateCase,
  type CasePatch,
  type TestCase,
  registerCasesHooks,
} from './testing/cases-harness';
import { removeTreeWithRetry } from './testing/cleanup';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, rmSync: vi.fn(actual.rmSync) };
});

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) };
});

registerCasesHooks();

describe('updateCase', () => {
  it('只改传入的字段，其余保持原值，并刷新 updatedAt', async () => {
    const created = createCase(caseInput());
    // 时间戳分辨率是毫秒：等一格再改，否则 updatedAt 与 createdAt 相同会让「刷新了没有」无从判断
    await new Promise((resolve) => setTimeout(resolve, 5));

    const next = updateCase(created.id, { title: '改了标题' });

    expect(next.title).toBe('改了标题');
    expect(next.taskPrompt).toBe(created.taskPrompt);
    expect(next.rubric).toEqual(created.rubric);
    expect(next.updatedAt >= created.updatedAt).toBe(true);
  });

  // 仓库临时不可用（网络盘掉线、目录被移走）时，改标题不该被 NOT_A_GIT_REPO 拦住。
  it('只改标题时不做仓库校验（仓库已被移走也照样保存）', () => {
    const created = createCase(caseInput());
    removeTreeWithRetry(repo);

    const next = updateCase(created.id, { title: '仓库掉线时改标题' });

    expect(next.title).toBe('仓库掉线时改标题');
    expect(listStoredCases().cases[0]?.title).toBe('仓库掉线时改标题');
  });

  /**
   * UI 发补丁**永远是全量的**——面板 `handleFinish` 无条件带上预填的
   * `repoPath` / `commitHash`（`case-form-panel.tsx` 的注册字段），页面 `update(id, values)` 把它当整份补丁发出去。
   *
   * 所以判定必须是「**值**变了没有」，而不是「字段出现没有」：`patch.repoPath !== undefined` 在真实提交形状下
   * 等价于「每次保存都校验仓库」，仓库临时不可用（网络盘掉线 / 目录被移走）时用户改标题一律拿到 NOT_A_GIT_REPO，
   * 改不动——正是本组承诺不会被拦住的那件事。
   */
  it('照 UI 的真实形状发全量补丁：仓库已被移走时改标题仍然成功', () => {
    const created = createCase(caseInput());
    removeTreeWithRetry(repo);

    // 这里必须发**全部 7 个字段**（`uiPatchOf`），不是「title + 两个承重字段」
    const next = updateCase(created.id, uiPatchOf(created, { title: '仓库掉线时改标题（全量补丁）' }));

    expect(next.title).toBe('仓库掉线时改标题（全量补丁）');
    expect(listStoredCases().cases[0]?.title).toBe('仓库掉线时改标题（全量补丁）');
  });

  // 反向对照：同一个全量形状里 repoPath 真的变了、而新路径不是可用仓库 → 仍然必须拦下。
  // 少了这条，「什么都不校验」的实现也能让上面那条通过。
  it('全量补丁里 repoPath 真变了且新路径不可用 → 仍然抛 NOT_A_GIT_REPO，且原值不变', () => {
    const created = createCase(caseInput());
    const movedAway = join(dir, 'moved-away');
    mkdirSync(movedAway, { recursive: true });
    removeTreeWithRetry(movedAway);

    let caught: unknown;
    try {
      updateCase(created.id, uiPatchOf(created, { title: 'x', repoPath: movedAway }));
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ServiceError);
    expect((caught as ServiceError).code).toBe('NOT_A_GIT_REPO');
    expect(listStoredCases().cases[0]?.repoPath).toBe(repo);
  });

  /**
   * **commit 半边**的守卫：把 `commitTouched` 改回旧写法会让这条红。
   * 夹具的差别就是承重的那一点：这里的用例**钉了具体 commit**，旧写法下 `patch.commitHash !== undefined`
   * 会走 `resolveCommitInput → assertCommit`（`git cat-file -e`），于是「钉了 commit 的用例 + 仓库掉线 + 改标题」
   * 会被仓库可用性拦住——正是这条口径的另一半。
   */
  it('钉了 commit 的用例照 UI 形状发全量补丁：仓库被移走后改标题仍然成功', () => {
    const created = createCase(caseInput({ commitHash: git(['rev-parse', 'HEAD'], repo).trim() }));
    expect(created.commitHash).toHaveLength(40);
    removeTreeWithRetry(repo);

    const next = updateCase(created.id, uiPatchOf(created, { title: '仓库掉线时改标题（钉了 commit）' }));

    expect(next.title).toBe('仓库掉线时改标题（钉了 commit）');
    expect(next.commitHash).toBe(created.commitHash);
    expect(listStoredCases().cases[0]?.commitHash).toBe(created.commitHash);
  });

  // N2 的反向对照：commit 的**值真的变了**（换成一个不存在的 hash）⇒ 仍然必须重新解析并拦下，
  // 不能因为「仓库还可用就跳过校验」。少了这条，「commit 半边一律不校验」的实现也能让上面那条通过。
  it('全量补丁里 commitHash 真变了且那个提交不存在 → 仍然抛 INVALID_REF，且原值不变', () => {
    const created = createCase(caseInput({ commitHash: git(['rev-parse', 'HEAD'], repo).trim() }));

    let caught: unknown;
    try {
      updateCase(created.id, uiPatchOf(created, { title: 'x', commitHash: 'f'.repeat(40) }));
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ServiceError);
    expect((caught as ServiceError).code).toBe('INVALID_REF');
    expect(listStoredCases().cases[0]?.commitHash).toBe(created.commitHash);
  });

  it('改动 repoPath 时校验新路径（不是 git 仓库则拒绝且不落盘）', () => {
    const created = createCase(caseInput());
    const notRepo = join(dir, 'plain-dir');
    mkdirSync(notRepo, { recursive: true });

    expect(() => updateCase(created.id, { repoPath: notRepo })).toThrow(ServiceError);
    expect(listStoredCases().cases[0]?.repoPath).toBe(repo);
  });

  it('换仓库且未显式给 commit 时，把旧 commit 拿到新仓库里再确认一次（不存在则 INVALID_REF）', () => {
    // 另一个独立仓库：它的对象库里没有旧仓库的提交，所以旧 commit 在它里面必然不存在
    const { dir: otherRepo } = makeRepo('other-repo', 1);
    const created = createCase(caseInput({ commitHash: git(['rev-parse', 'HEAD'], repo).trim() }));

    let caught: unknown;
    try {
      updateCase(created.id, { repoPath: otherRepo });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ServiceError);
    expect((caught as ServiceError).code).toBe('INVALID_REF');
    expect(listStoredCases().cases[0]?.repoPath).toBe(repo);
  });

  it('可以显式把 commitHash 改回 null（= 回到默认分支 HEAD）', () => {
    const created = createCase(caseInput({ commitHash: git(['rev-parse', 'HEAD'], repo).trim() }));

    const next = updateCase(created.id, { commitHash: null });

    expect(next.commitHash).toBeNull();
  });

  /**
   * 写路径顺手把历史残留的用例级评分模型清掉：`updateCase` 的 `next` 是从**盘上那一行**展开的
   * （`loadConfig()` 不过 schema），残留的两列会跟着 `...current` 一起进 `next`；
   * 而 `assertStorable` 的 `TestCaseSchema.parse` 把它们剥掉，于是保存一次就等于做了一次迁移。
   * 这条守卫钉的正是这个「顺手清掉」：一旦有人把这两列加回契约，落盘里就会长期留着两份真假难辨的尺子。
   */
  it('保存一次就把历史残留的用例级评分模型从盘上清掉（照 UI 的全量补丁形状）', () => {
    const created = createCase(caseInput());
    seedLegacyJudgeOverrideCase(created.id, { providerId: 'provider-legacy', modelId: 'legacy-model' });

    updateCase(created.id, uiPatchOf(getCase(created.id), { title: '改个标题' }));

    const stored = listStoredCases().cases[0] as unknown as Record<string, unknown>;
    expect(stored).not.toHaveProperty('judgeProviderId');
    expect(stored).not.toHaveProperty('judgeModelId');
    // 无关编辑照常生效（别为了清理把这次编辑一起吞掉）
    expect(stored.title).toBe('改个标题');
  });

  /**
   * 反向对照：全量补丁里**多给了**评分字段也不许写进盘。
   * 少了这条，「把这两列加回契约」的实现仍能让上面那条通过——上面只证明残留会被清掉，
   * 不证明新值进不来。
   */
  it('全量补丁里多给评分字段 → 落盘里没有它们，且无关编辑照常生效', () => {
    const created = createCase(caseInput());
    const patched = uiPatchOf(getCase(created.id), {
      title: '带评分字段的全量补丁',
      judgeProviderId: 'provider-1',
      judgeModelId: 'deepseek-chat',
    } as Partial<CasePatch>);

    const next = updateCase(created.id, patched);

    expect(next).not.toHaveProperty('judgeProviderId');
    expect(next).not.toHaveProperty('judgeModelId');
    const stored = listStoredCases().cases[0] as unknown as Record<string, unknown>;
    expect(stored).not.toHaveProperty('judgeProviderId');
    expect(stored).not.toHaveProperty('judgeModelId');
    expect(stored.title).toBe('带评分字段的全量补丁');
  });

  /**
   * A10③ 的守卫：旧版本写下的用例文件里**根本没有 `repoBranch` 这个键**（这一列是后加的），
   * 而存储层读文件不过 schema，所以读路径拿到的是 `undefined`——契约声明的却是 `string | null`。
   * 不归一的话，`GET /api/cases` 会把「没有这一列」当成第三种状态发出去，前端与评测快照都要自己防一次。
   * 夹具按历史数据的真实来路造：先落盘一条合法用例，再把那把键从文件里删掉。
   */
  it('旧用例文件里缺 repoBranch 的读出来是 null（不是 undefined）', () => {
    const created = createCase(caseInput({ commitHash: git(['rev-parse', 'HEAD'], repo).trim() }));
    // 模拟旧版本写下的那一行：整把键不存在（`delete` 而不是置 null——两者的区别正是这条守卫要钉的）
    const row = readCase(created.id)!;
    delete (row as Partial<TestCase>).repoBranch;
    writeCase(row);

    expect(getCase(created.id).repoBranch).toBeNull();
    expect(listCases().cases[0]?.repoBranch).toBeNull();
    // 反向对照：同一份读数里其余字段照常（归一不是「把整行换掉」）
    expect(getCase(created.id).commitHash).toBe(created.commitHash);
  });

  /**
   * 写侧业务守卫（`assertStorable` 里的 `validateRubric`）：`RubricSchema` 刻意不设 `.min(1)`
   * （空表是新建用例的真实初态），于是**只靠 schema 拦不住**一张空表 / 一张有组无项的表 /
   * 一张 ID 重复的表。下面这三条走的正是 `createCase` / `updateCase`——HTTP 路由调的就是它们，
   * 所以这里断言的是「HTTP 写入路径真的被这道业务判据拦下」，而不是「schema 会拦」。
   * 那样的用例在评分阶段没法评（满分 0），或者让一次判定被同时记到两项上，而错误会推迟到
   * 评测时才暴露，离出错点已经很远。
   *
   * 夹具为什么**不是**权重 0：那一格由 `RubricSchema` 的 `.positive()` 拦下（抛的是裸 `ZodError`，
   * 路由层再折成 400），根本走不到这条业务守卫——拿它当探针，删掉 `validateRubric` 之后这条用例
   * **照样红**（红的理由却换了一个），守卫会在错误的地方「通过」。下面这三种坏形状都是
   * schema 放行、只有业务判据拦得住的。
   *
   * 为什么**新建与编辑**都要走一遍：两处各写一份判据必然漂移，而漂移的症状正是「创建时拦得住、
   * 编辑时拦不住」——把两条保存路径钉在同一份判据上，「只删一处」才拦得住。
   */
  it('写入 schema 放行、业务判据不许的评分表被拒：新建与编辑两条路共用同一份判据，且不留半份改动', () => {
    const badShapes = [
      { label: '空表', rubric: { groups: [] }, reason: /评分标准项不能为空/ },
      { label: '有组无项', rubric: { groups: [{ name: '一、生产代码', items: [] }] }, reason: /至少要有一个评分项/ },
      {
        label: 'ID 重复',
        rubric: {
          groups: [
            { name: '一、生产代码', items: [{ id: 'A1', goal: '第一项', weight: 1 }, { id: 'A1', goal: '第二项', weight: 2 }] },
          ],
        },
        reason: /重复/,
      },
    ];
    const created = createCase(caseInput());

    for (const shape of badShapes) {
      let fromCreate: unknown;
      try {
        createCase(caseInput({ title: `坏表：${shape.label}`, rubric: shape.rubric }));
      } catch (error) {
        fromCreate = error;
      }
      let fromUpdate: unknown;
      try {
        updateCase(created.id, { rubric: shape.rubric });
      } catch (error) {
        fromUpdate = error;
      }

      // message 必须能直接展示：点名是哪一格错了（「评分标准项不合法：…」）
      expect(fromCreate, shape.label).toBeInstanceOf(ServiceError);
      expect((fromCreate as ServiceError).code, shape.label).toBe('INVALID_QUERY');
      expect((fromCreate as ServiceError).message, shape.label).toMatch(shape.reason);
      expect((fromUpdate as ServiceError).code, shape.label).toBe('INVALID_QUERY');
      expect((fromUpdate as ServiceError).message, shape.label).toMatch(shape.reason);
    }

    // 被拒绝的保存不留半份改动：盘上仍然只有那一条、内容逐字未变
    expect(listStoredCases().cases).toHaveLength(1);
    expect(getCase(created.id).rubric).toEqual(created.rubric);
  });

  /**
   * 编辑也是**用**这个用例：当前行必须过与 `getCase` 同一份判据。
   * 少了它，`updateCase` 会把盘上那一行裸 spread 进 `next`，再落到 `assertStorable` 的
   * `TestCaseSchema.parse`——抛的是**裸 `ZodError`**（一串 JSON issues），路由层折成技术性的
   * `INVALID_QUERY`；而用户真正需要的是那句能照做的「旧版数据，请删除它或重新创建：<caseId>」。
   */
  it('编辑一条旧用例：抛的是点名 caseId 的中文 INTERNAL，不是裸 ZodError（与 getCase 同一句话）', () => {
    const legacy = seedLegacyCase('没有 rubric 这一格', legacyCaseShapes[0]!.mangle);

    let caught: unknown;
    try {
      updateCase(legacy.id, { title: '给旧用例改个标题' });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ServiceError);
    expect((caught as ServiceError).code).toBe('INTERNAL');
    expect((caught as ServiceError).message).toContain('旧版数据');
    expect((caught as ServiceError).message).toContain(legacy.id);
    // 不是 schema dump：裸 ZodError 的 message 是一串 JSON issues（路由层只会折成「查询参数不合法」）
    expect((caught as ServiceError).message).not.toContain('invalid_type');
    expect((caught as ServiceError).message).not.toContain('"code"');
    // 被拒绝的编辑不留半份改动
    expect(listStoredCases().cases.find((item) => item.id === legacy.id)?.title).toBe(legacy.title);
  });

  it('updateCase 对不存在的 id 抛 NOT_FOUND', () => {
    expect(() => updateCase('missing', { title: 'x' })).toThrow(ServiceError);
  });

  /**
   * 来源的**解析**必须是懒的。
   *
   * 一条手改坏的 legacy 行（`repoPath` 写成不支持的协议）在修复前连改标题都保存不了：`resolved` 无条件
   * 算一次、`normalizeSourceString` 又无条件解析补丁里那一份，两处都走 `parseRepoSource`——
   * 它对 `ftp://…` 直接抛 `INVALID_QUERY`，而这次保存**根本没碰来源**。口径 1
   *（「只校验本次改动到的字段」）说的是：没碰到的字段不该让这次保存失败。
   *
   * 逐字读下面那条断言：它验的是**报错点**。解析来源抛的是 `ServiceError('INVALID_QUERY')`；
   * 而修复后解析根本不发生，真正拦下这一行坏数据的是**写入口**的 `TestCaseSchema`
   * （`assertStorable`，见 case.ts 的 RepoSourceStringSchema）——那才是口径 3 要求拦下坏值的地方。
   * 注：这条坏行在这两种实现下都**写不进去**（schema 与解析用的是同一份判定），差别只在「谁拦的、
   * 报的是哪件事」；把懒改回每次都解析，这里立刻变回 `ServiceError`。
   */
  it('手改坏的 legacy 行只改标题：拦下它的是写入口的 schema，不是来源解析（解析是懒的）', () => {
    const created = createCase(caseInput());
    // 按手改用例文件的真实来路造：直接覆盖那个文件（绕过写侧自检）
    writeCase({ ...readCase(created.id)!, repoPath: 'ftp://host/x.git' });

    let caught: unknown;
    try {
      // 照 UI 的真实形状发全量补丁：那一条坏来源原样交回（值没变 ⇒ 本次没改到来源）
      updateCase(created.id, uiPatchOf(getCase(created.id), { title: '坏来源也能改标题' }));
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(ServiceError);
    // 被拒绝的保存不留半份改动
    expect(getCase(created.id).title).toBe(created.title);
  });
});
