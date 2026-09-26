// @vitest-environment node
/**
 * 生成评分标准项：两个分支（智能生成 / 智能识别）、合并算法，以及「生成是只读操作」。
 *
 * 上游文本调用被整模块替身（只替换 callTextApi，其余导出原样透传）。
 * 两条**绊线**保留（与上一版同口径）：
 *   - `vi.stubGlobal('fetch', …)`：预校验的顺序一旦被改坏（先调模型、后校验仓库），真 `callTextApi`
 *     就会跑起来——有它可以保证本机离线也稳定失败；
 *   - `node:fs.writeFileSync` 探针：「只读」若只比较 config.json 的字节，看不见
 *     `saveConfig(loadConfig())` 这种**原样重写**（往返逐字节等价）。
 */
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync as readFileRaw, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ServiceError, type Provider, type Rubric } from '@aieval/contracts';
import { getConfigDir, loadConfig, saveConfig, setConfigDirForTesting } from '@aieval/core';
import { callTextApi } from '@aieval/evaluator';
import { generateRubric, mergeRubric, resolveJudgeRoute as resolveJudgeRouteFromApi } from './judge';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, writeFileSync: vi.fn(actual.writeFileSync) };
});

vi.mock('@aieval/evaluator', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aieval/evaluator')>();
  return { ...actual, callTextApi: vi.fn() };
});

let dir: string;
let repo: string;
let fixtureRepo: string;

beforeAll(() => {
  fixtureRepo = mkdtempSync(join(tmpdir(), 'aieval-judge-fixture-'));
  execFileSync('git', ['init', '-q'], { cwd: fixtureRepo });
  writeFileSync(join(fixtureRepo, 'README.md'), '# gateway\n', 'utf8');
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e.com', 'add', '.'], { cwd: fixtureRepo });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e.com', 'commit', '-q', '-m', 'init'], { cwd: fixtureRepo });
});

afterAll(() => {
  rmSync(fixtureRepo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aieval-judge-'));
  setConfigDirForTesting(dir);
  vi.stubGlobal('fetch', () => {
    throw new Error('测试不得发网络请求：callTextApi 应当仍是替身');
  });
  repo = join(dir, 'gateway');
  mkdirSync(repo, { recursive: true });
  cpSync(fixtureRepo, repo, { recursive: true });
  vi.mocked(callTextApi).mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  setConfigDirForTesting(null);
  rmSync(dir, { recursive: true, force: true, maxRetries: 40, retryDelay: 100 });
});

const PROVIDER: Provider = {
  id: 'provider-1',
  name: 'DeepSeek 官方',
  protocolType: 'openai',
  baseUrl: 'https://api.deepseek.com/v1',
  apiKey: 'sk-test',
  models: [{ id: 'deepseek-chat', source: 'manual' }],
  createdAt: '2026-09-22T10:00:00.000Z',
  updatedAt: '2026-09-22T10:00:00.000Z',
};

function configureGlobalJudge(): void {
  saveConfig({
    ...loadConfig(),
    providers: [PROVIDER],
    settings: { ...loadConfig().settings, defaultJudge: { providerId: PROVIDER.id, modelId: 'deepseek-chat' } },
  });
}

function modelReplies(text: string): void {
  vi.mocked(callTextApi).mockResolvedValue(text);
}

/** 当前表格：一组一项（A1 / 18 分），用于「智能生成」的输入 */
function currentRubric(): Rubric {
  return { groups: [{ name: '一、生产代码', items: [{ id: 'A1', goal: '追加 agent 字段', weight: 18 }] }] };
}

/** 用户粘贴的评分要求（与 spec 的示例同形） */
const USER_PROMPT = [
  '评估代码开发质量，满分 100 分。',
  '',
  '## 一、生产代码 48 分',
  '',
  '| ID | 评分项 | 目标 | 权重 |',
  '| --- | --- | --- | --- |',
  '| A1 | `FileChangeLogItemDTO` 追加 `agent` 字段 | 让 `agent` 进入对外契约 | **18** |',
  '| B1 | `GitCommitServiceImpl.toDTO()` 补 `m.agent()` | 让 ES 数据真正流到响应 | **20** |',
  '',
  '## 二、测试 52 分',
  '',
  '| ID | 评分项 | 目标 | 权重 |',
  '| --- | --- | --- | --- |',
  '| D1 | `GitCommitServiceImplTest` 新增「有值透传」用例 | 锁死映射不丢字段 | **14** |',
].join('\n');

describe('mergeRubric：按组名归位', () => {
  it('同名组的新项追加到该组末尾；新组名按模型给的顺序追加到表尾', () => {
    const current = currentRubric();
    const added: Rubric = {
      groups: [
        { name: '一、生产代码', items: [{ id: 'A2', goal: '补 Javadoc', weight: 4 }] },
        { name: '二、测试', items: [{ id: 'D1', goal: '补透传用例', weight: 14 }] },
      ],
    };
    const merged = mergeRubric(current, added);
    expect(merged.addedItems).toBe(2);
    expect(merged.rubric.groups.map((group) => group.name)).toEqual(['一、生产代码', '二、测试']);
    expect(merged.rubric.groups[0]?.items.map((item) => item.id)).toEqual(['A1', 'A2']);
  });

  /**
   * 空表 + 一个「新组名」的**多项**组 —— 这正是「智能生成」在**新建用例**上的形状（当前表格是空的，
   * 模型整表返回）。这一条钉的是**新组只能建一次**：组的解析/创建若写在 item 循环里，每一项都会
   * 新建一个同名组，于是「一、生产代码」的两项变成两个「一、生产代码」——而 `validateRubric`
   * 不查组名重复、评分只按项 ID 记账，一张被切碎的表格能一路绿到落库。
   * 上面那条同名组用例只有一项，看不见这个形状（Task 5 评审实测的 Critical）。
   */
  it('空表 + 新组名带多项 ⇒ 只建一个组，两项按模型给的顺序都在里面', () => {
    const added: Rubric = {
      groups: [
        { name: '一、生产代码', items: [{ id: 'A1', goal: '第一项', weight: 18 }, { id: 'B1', goal: '第二项', weight: 20 }] },
        { name: '二、测试', items: [{ id: 'D1', goal: '第三项', weight: 14 }, { id: 'D2', goal: '第四项', weight: 6 }] },
      ],
    };

    const merged = mergeRubric({ groups: [] }, added);

    expect(merged.addedItems).toBe(4);
    expect(merged.rubric.groups).toHaveLength(2);
    expect(merged.rubric.groups.map((group) => group.name)).toEqual(['一、生产代码', '二、测试']);
    expect(merged.rubric.groups[0]?.items.map((item) => item.id)).toEqual(['A1', 'B1']);
    expect(merged.rubric.groups[1]?.items.map((item) => item.id)).toEqual(['D1', 'D2']);
    // 最强的一条：结果必须与模型给的那张表**逐字相同**（切碎 / 重排 / 丢项都会在这里现形）
    expect(merged.rubric).toEqual(added);
  });

  it('模型返回空 groups ⇒ 原表原样返回、新增 0 项（允许它说「已经完备」）', () => {
    const current = currentRubric();
    const merged = mergeRubric(current, { groups: [] });
    expect(merged).toEqual({ rubric: current, addedItems: 0 });
  });

  /**
   * 「空表 + 什么都没补」这条路的**归因**必须准：`{ groups: [] }` 是模型按契约给出的**合法**答复，
   * 说成「模型返回的表格不合法」是把调用方自己的问题（当前表格是空的）扣在模型头上。
   * 真条件是「当前表是空的、模型也没补上」，message 就照这个说，并给一条能照做的出路。
   */
  it('空表 + 模型也没补 ⇒ 如实说「当前表格是空的」，不赖模型（也不是「已经完备」）', () => {
    let caught: unknown;
    try {
      mergeRubric({ groups: [] }, { groups: [] });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ServiceError);
    expect((caught as ServiceError).code).toBe('INVALID_QUERY');
    expect((caught as ServiceError).message).toContain('当前评分标准项是空的');
    expect((caught as ServiceError).message).not.toContain('模型返回的表格不合法');
  });

  /**
   * 这一条要钉的是**合并侧那条判据本身**，不只是「最后抛了 JUDGE_PARSE_FAILED」：
   * 下游的 `validateRubric` 也会报出同一把撞车键（「评分项引用键「A1」重复了」），于是只断言
   * `/A1/` 的话，把 `mergeRubric` 里的 ID 冲突分支删掉这条用例照样绿（变异验证实测：整份 15 条全绿）。
   * 故显式断言文案点名的是**模型违约**（复用了已有 ID），而不是通用的「表格不合法」。
   * **这条用例唯一钉住的就是「文案归属」**：错误码与涉事 ID 两条判据都一样（都抛 JUDGE_PARSE_FAILED、
   * 都点 A1），差别只在「这句话是合并侧说的、还是下游表格校验说的」——别再往它身上读别的强度。
   */
  it('新增项的 id 与已有 id 冲突 ⇒ JUDGE_PARSE_FAILED（模型违约，不是我们的形状漂移）', () => {
    const added: Rubric = { groups: [{ name: '一、生产代码', items: [{ id: 'A1', goal: '重复', weight: 5 }] }] };
    expect(() => mergeRubric(currentRubric(), added)).toThrow(ServiceError);
    expect(() => mergeRubric(currentRubric(), added)).toThrow(/A1/);
    expect(() => mergeRubric(currentRubric(), added)).toThrow(/复用了已有的 ID/);
  });

  it('合并结果本身必须过 validateRubric（权重非正的新项被拒）', () => {
    const added = { groups: [{ name: 'x', items: [{ id: 'B', goal: 'g', weight: 0 }] }] } as unknown as Rubric;
    expect(() => mergeRubric(currentRubric(), added)).toThrow(ServiceError);
  });
});

describe('generateRubric：智能生成分支（prompt 为空）', () => {
  it('把当前表格与已有 ID 清单送进提示词，并返回合并后的完整表格', async () => {
    configureGlobalJudge();
    modelReplies(JSON.stringify({ groups: [{ name: '二、测试', items: [{ id: 'D1', goal: '补透传用例', weight: 14 }] }] }));

    const result = await generateRubric({ rubric: currentRubric(), taskPrompt: '为网关补一条回归', prompt: '', repoPath: repo });

    const [, request] = vi.mocked(callTextApi).mock.calls[0]!;
    expect(request.prompt).toContain('为网关补一条回归');
    expect(request.prompt).toContain('gateway');
    // 当前表格与已有 ID 清单都要在：AI 必须知道已有什么才能只增不改
    expect(request.prompt).toContain('追加 agent 字段');
    expect(request.prompt).toContain('A1');
    expect(result.addedItems).toBe(1);
    expect(result.rubric.groups.map((group) => group.name)).toEqual(['一、生产代码', '二、测试']);
  });

  it('模型返回空 groups ⇒ 原表不变，并给出「未新增条目」的说明', async () => {
    configureGlobalJudge();
    modelReplies(JSON.stringify({ groups: [] }));
    const result = await generateRubric({ rubric: currentRubric(), taskPrompt: 't', prompt: '', repoPath: repo });
    expect(result.addedItems).toBe(0);
    expect(result.note).toContain('未新增');
    expect(result.rubric).toEqual(currentRubric());
  });

  it('仓库路径无效时抛 NOT_A_GIT_REPO（而不是先花掉一次模型调用）', async () => {
    configureGlobalJudge();
    const notRepo = join(dir, 'plain-dir');
    mkdirSync(notRepo, { recursive: true });
    await expect(generateRubric({ rubric: currentRubric(), taskPrompt: 't', prompt: '', repoPath: notRepo })).rejects.toThrow(
      /不是 git 仓库|NOT_A_GIT_REPO/,
    );
    expect(callTextApi).not.toHaveBeenCalled();
  });
});

describe('generateRubric：智能识别分支（prompt 非空）', () => {
  /**
   * 这条路**不碰仓库**（spec D10）：用户粘进来的那段文本里已经有全部信息。
   * 于是 `repoPath` 为空也必须成功——「填了提示词却因为仓库路径没填而识别不了」这个组合被这条规则消灭。
   */
  it('repoPath 为空也能识别成功，且不调用仓库解析', async () => {
    configureGlobalJudge();
    modelReplies(
      JSON.stringify({
        groups: [
          { name: '一、生产代码', items: [{ id: 'A1', goal: '让 agent 进入对外契约', weight: 18 }, { id: 'B1', goal: '让 ES 数据流到响应', weight: 20 }] },
          { name: '二、测试', items: [{ id: 'D1', goal: '锁死映射不丢字段', weight: 14 }] },
        ],
      }),
    );

    const result = await generateRubric({ rubric: { groups: [] }, taskPrompt: '', prompt: USER_PROMPT, repoPath: '' });

    expect(result.rubric.groups).toHaveLength(2);
    expect(result.rubric.groups[0]?.items.map((item) => item.weight)).toEqual([18, 20]);
    expect(result.addedItems).toBe(0);
    // 用户原文必须原样进提示词（并要求原样抽取）
    const [, request] = vi.mocked(callTextApi).mock.calls[0]!;
    expect(request.prompt).toContain('评估代码开发质量');
    expect(request.prompt).toContain('原样');
  });

  it('识别分支不带仓库名进提示词（不解析 repoPath）', async () => {
    configureGlobalJudge();
    modelReplies(JSON.stringify({ groups: [{ name: 'g', items: [{ id: 'A', goal: 'a', weight: 1 }] }] }));
    await generateRubric({ rubric: { groups: [] }, taskPrompt: '', prompt: USER_PROMPT, repoPath: 'git@host:group/never-touched.git' });
    const [, request] = vi.mocked(callTextApi).mock.calls[0]!;
    expect(request.prompt).not.toContain('never-touched');
  });

  /**
   * **空表在两支里的含义正好相反**（这一条钉识别侧，生成侧的对偶在「智能生成分支」里的
   * 「模型返回空 groups ⇒ 原表不变，并给出『未新增条目』的说明」）。
   * 识别是**整表替换**：模型回空表 ⇒ 调用方会把用户的表格替换成一张空表，
   * 也就是「用户粘了一段评分要求，我们把它静默丢掉，再回一个 200」——必须当成失败。
   */
  it('识别分支模型返回空 groups ⇒ JUDGE_PARSE_FAILED（用户的要求不能被静默丢成空表）', async () => {
    configureGlobalJudge();
    modelReplies(JSON.stringify({ groups: [] }));

    const error = await generateRubric({ rubric: currentRubric(), taskPrompt: '', prompt: USER_PROMPT, repoPath: '' }).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(ServiceError);
    expect((error as ServiceError).code).toBe('JUDGE_PARSE_FAILED');
    // message 要能直接展示：说清是「没识别出条目」，并给出重试 / 换模型的出路
    expect((error as ServiceError).message).toContain('没有从这段评分要求里识别出任何条目');
    expect((error as ServiceError).message).toContain('重试');
  });
});

describe('generateRubric：失败面与只读', () => {
  it('未配置评分模型时抛 CONFLICT（指向设置页），且不产生任何上游调用', async () => {
    const error = await generateRubric({ rubric: currentRubric(), taskPrompt: 't', prompt: '', repoPath: repo }).catch((caught: unknown) => caught);
    expect((error as ServiceError).code).toBe('CONFLICT');
    expect(callTextApi).not.toHaveBeenCalled();
  });

  it('模型返回非法 JSON / 形状不合契约的表格 → JUDGE_PARSE_FAILED 且 message 可直接展示', async () => {
    configureGlobalJudge();
    modelReplies('这段代码改得不错。');
    await expect(generateRubric({ rubric: currentRubric(), taskPrompt: 't', prompt: USER_PROMPT, repoPath: '' })).rejects.toThrow(
      /不是合法 JSON/,
    );

    modelReplies(JSON.stringify({ groups: [{ name: 'g', items: [{ id: 'A', goal: 'a', weight: 0 }] }] }));
    await expect(generateRubric({ rubric: currentRubric(), taskPrompt: 't', prompt: USER_PROMPT, repoPath: '' })).rejects.toThrow(
      /权重/,
    );
  });

  /**
   * 中文兜底**不能编原因**（Task 5 评审的 Addendum A）：只按字段名给提示时，`weight: "18"`
   * （模型最常见的滑法：数字被引号包住）会被说成「权重必须是正整数，不能是 0 / 负数 / 小数」——
   * 指对了格子、却说错了原因，用户照着改数字仍然过不了。
   * 故这一条钉：类型错给**类型**提示 + 附上 zod 原文，而不是范围提示。
   */
  it('模型把 weight 写成字符串 ⇒ 中文说的是「类型」，并附上 zod 原文（不编成范围错）', async () => {
    configureGlobalJudge();
    modelReplies(JSON.stringify({ groups: [{ name: 'g', items: [{ id: 'A', goal: 'a', weight: '18' }] }] }));

    const error = await generateRubric({ rubric: currentRubric(), taskPrompt: 't', prompt: USER_PROMPT, repoPath: '' }).catch(
      (caught: unknown) => caught,
    );

    const message = (error as ServiceError).message;
    // 定位不变（哪一组第几项）——这一条不能因为换了提示就丢掉
    expect(message).toContain('groups.0.items.0');
    expect(message).toContain('权重必须是整数');
    // zod 的原文要在（它说的才是「收到的是字符串」这句事实）
    expect(message).toContain('Expected number, received string');
    // 范围那半句不该出现：它不是这一格的错
    expect(message).not.toContain('不能是 0、负数或小数');
    // `missing` 那一半（模型**忘了**给权重）也要认得出：中文说缺了什么（zod 原文不在这一条里断言）
    modelReplies(JSON.stringify({ groups: [{ name: 'g', items: [{ id: 'A', goal: 'a' }] }] }));
    await expect(generateRubric({ rubric: currentRubric(), taskPrompt: 't', prompt: USER_PROMPT, repoPath: '' })).rejects.toThrow(/缺少权重/);
  });

  it('生成成功不改配置文件（前后逐字节一致，且全程没有写盘调用）', async () => {
    configureGlobalJudge();
    const configFile = join(getConfigDir(), 'config.json');
    const before = readFileRaw(configFile, 'utf8');
    modelReplies(JSON.stringify({ groups: [{ name: '二、测试', items: [{ id: 'D1', goal: 'g', weight: 1 }] }] }));
    vi.mocked(writeFileSync).mockClear();

    await generateRubric({ rubric: currentRubric(), taskPrompt: 't', prompt: '', repoPath: repo });

    expect(readFileRaw(configFile, 'utf8')).toBe(before);
    expect(writeFileSync).not.toHaveBeenCalled();
  });

  it('生成失败同样不改配置文件', async () => {
    configureGlobalJudge();
    const configFile = join(getConfigDir(), 'config.json');
    const before = readFileRaw(configFile, 'utf8');
    modelReplies('不是 JSON');
    vi.mocked(writeFileSync).mockClear();
    await expect(generateRubric({ rubric: currentRubric(), taskPrompt: 't', prompt: '', repoPath: repo })).rejects.toBeInstanceOf(ServiceError);
    expect(readFileRaw(configFile, 'utf8')).toBe(before);
    expect(writeFileSync).not.toHaveBeenCalled();
  });
});

describe('只用全局默认评分模型（D14）', () => {
  it('api 导出的 resolveJudgeRoute 与 evaluator 是同一个函数（转出而不是重新实现）', async () => {
    expect(resolveJudgeRouteFromApi).toBe(await import('@aieval/evaluator').then((module) => module.resolveJudgeRoute));
  });

  it('两个分支的路由都等于全局默认那一把尺子（入参里没有模型，故换不掉）', async () => {
    configureGlobalJudge();
    modelReplies(JSON.stringify({ groups: [] }));
    await generateRubric({ rubric: currentRubric(), taskPrompt: 't', prompt: '', repoPath: repo });
    const [route] = vi.mocked(callTextApi).mock.calls[0]!;
    expect(route.modelId).toBe('deepseek-chat');
    expect(route.baseUrl).toBe(PROVIDER.baseUrl);
  });
});
