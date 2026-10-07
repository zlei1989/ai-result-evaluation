// @vitest-environment node
/**
 * 用例域路由端到端：/api/cases 全套 + R7 的「按仓库路径」结构守卫。
 *
 * 这份用例管三件事：
 *   1. 「zod 校验 → 调 api → 错误映射」这条链真的接通了（用坏值走真实请求：只有 contracts 导出的
 *      那一份 zod 实例才会映射成 400 + issues，复制出来的第二份会落到 500）；
 *   2. R7 的路由形态钉在**文件系统**上：仓库校验与 commit 候选挂在 cases/validate-repo 与
 *      cases/commits，且**不存在**按 caseId 的旧形态；
 *   3. 评分标准项的生成 / 识别整条链路（含 p0 的 callTextApi）用**假 fetch** 跑通——测试绝不打真实网络。
 *
 * 配置目录、仓库、工作区一律是 mkdtempSync 出来的临时目录：绝不碰真实的 ~/.aieval 与真实仓库。
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SETTINGS_DEFAULTS, type Provider, type TestCase } from '@aieval/contracts';
import { loadConfig, saveConfig, setConfigDirForTesting } from '@aieval/core';
import { GET as listCases, POST as createCase } from '@/app/api/cases/route';
import { DELETE as deleteCase, GET as getCase, PUT as updateCase } from '@/app/api/cases/[caseId]/route';
import { POST as listCommits } from '@/app/api/cases/commits/route';
import { POST as generateRubric } from '@/app/api/cases/generate-judge-prompt/route';
import { POST as validateRepo } from '@/app/api/cases/validate-repo/route';
import { listCommitCandidates } from '@aieval/api';
import { removeTreeWithRetry } from './testing/cleanup';

/**
 * `@aieval/api` 只把 `listCommitCandidates` 换成**可注入替身**（其余导出原样透传）：
 * 这一层唯一需要断言的是「路由把服务层需要的入参原样转下去了没有」——而路由自己不产生任何可观察的
 * 副作用（它只是 parse → 调服务 → 序列化），所以断言只能落在调用点上。
 * 用 `importOriginal` 透传而不是手写一份替身：其余路由（validate / create / update / judge）照常走真实服务，
 * 本文件别处的守卫不受影响。
 */
vi.mock('@aieval/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aieval/api')>();
  return { ...actual, listCommitCandidates: vi.fn(actual.listCommitCandidates) };
});

let dir: string;
let repo: string;

/**
 * 夹具模板：`beforeAll` 里建**一次**带 `README.md` 初始提交的仓库，每个用例 `cpSync` 一份到 `{dir}/gateway`。
 *
 * 为什么不是每个用例各建一个：本机的进程创建约 250–400ms（企业杀软在 CreateProcess 上收税，
 * 与跑什么程序无关——实测 `cmd /c exit 0` 250ms、`git --version` 350ms），而
 * 「init / add / commit」是 3 次进程创建 ≈ 1s。本文件 18 个用例各建一个 ⇒ 光夹具就 18s。
 * `cpSync` 一份仓库是纯文件系统操作（实测 ~10ms），复制出来的仍是**独立、可用**的真实仓库。
 *
 * 模板的提交信息必须逐字是 `初始提交`：`/api/cases/commits` 那条用例断言的就是它。
 */
let fixtureRepo: string;

beforeAll(() => {
  // 刻意**不**嵌进任何用例的 dir：模板必须活过每一个 afterEach，清理归下面的 afterAll
  fixtureRepo = mkdtempSync(join(tmpdir(), 'aieval-route-cases-fixture-'));
  execFileSync('git', ['init', '-q'], { cwd: fixtureRepo });
  writeFileSync(join(fixtureRepo, 'README.md'), '# gateway\n', 'utf8');
  const identity = ['-c', 'user.name=t', '-c', 'user.email=t@e.com'];
  execFileSync('git', [...identity, 'add', '.'], { cwd: fixtureRepo });
  execFileSync('git', [...identity, 'commit', '-q', '-m', '初始提交'], { cwd: fixtureRepo });
});

afterAll(() => {
  // 与 afterEach 同一条路：刚跑完的 git 进程会短暂捏着目录句柄，`rmSync` 的 `maxRetries`
  // 在本机是 no-op（实测 3ms 就抛），重试必须是自己的（见 `./testing/cleanup`）
  removeTreeWithRetry(fixtureRepo);
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aieval-route-cases-'));
  setConfigDirForTesting(dir);
  saveConfig({
    ...loadConfig(),
    settings: { ...SETTINGS_DEFAULTS, workspaceRoot: join(dir, 'runs') },
  });
  repo = join(dir, 'gateway');
  mkdirSync(repo, { recursive: true });
  cpSync(fixtureRepo, repo, { recursive: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
  setConfigDirForTesting(null);
  removeTreeWithRetry(dir);
});

/** 造一个请求：与 Next 交给路由的入参同形（原生 Request） */
function jsonRequest(url: string, method: string, body: string): Request {
  return new Request(`http://localhost${url}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body,
  });
}

/** 动态段上下文：Next 16 的 params 是 Promise */
function context(caseId: string): { params: Promise<{ caseId: string }> } {
  return { params: Promise.resolve({ caseId }) };
}

const VALID_BODY = JSON.stringify({
  title: '为网关补齐转换回归',
  repoPath: '', // 每个用例自己填真实路径
  commitHash: null,
  taskPrompt: '补一条回归用例',
  rubric: { groups: [{ name: '一、生产代码', items: [{ id: 'A1', goal: '追加 agent 字段', weight: 18 }] }] },
});

/** 建一个用例并返回它的 id（大部分用例都需要一个已存在的对象） */
async function seedCase(): Promise<string> {
  const body = JSON.stringify({ ...JSON.parse(VALID_BODY), repoPath: repo });
  const res = await createCase(jsonRequest('/api/cases', 'POST', body));
  expect(res.status).toBe(201);
  return (await res.json()).id as string;
}

describe('/api/cases', () => {
  it('POST 建用例返回 201，GET 列表能拿到它', async () => {
    const id = await seedCase();

    const res = await listCases();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.map((item: { id: string }) => item.id)).toEqual([id]);
  });

  it('请求体不是合法 JSON → 400 + 「请求体不是合法 JSON」（不是 500）', async () => {
    const res = await createCase(jsonRequest('/api/cases', 'POST', '{坏 JSON'));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('INVALID_QUERY');
    expect(body.error.message).toBe('请求体不是合法 JSON');
  });

  it('缺 title → 400，且 context 是真 zod 的 issues（path 指向 title）', async () => {
    const res = await createCase(jsonRequest('/api/cases', 'POST', JSON.stringify({ repoPath: repo })));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('INVALID_QUERY');
    expect(body.error.context[0].path).toEqual(['title']);
  });

  it('仓库不是 git 仓库 → 400 NOT_A_GIT_REPO（含具体路径）', async () => {
    const plain = join(dir, 'plain-dir');
    mkdirSync(plain, { recursive: true });

    const res = await createCase(jsonRequest('/api/cases', 'POST', JSON.stringify({ ...JSON.parse(VALID_BODY), repoPath: plain })));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('NOT_A_GIT_REPO');
    expect(body.error.message).toContain(plain);
  });
});

describe('/api/cases/[caseId]', () => {
  it('GET 取详情；未知 id → 404 NOT_FOUND', async () => {
    const id = await seedCase();

    const found = await getCase(new Request('http://localhost/api/cases/x'), context(id));
    expect(found.status).toBe(200);
    expect((await found.json()).id).toBe(id);

    const missing = await getCase(new Request('http://localhost/api/cases/x'), context('missing'));
    expect(missing.status).toBe(404);
    expect((await missing.json()).error.code).toBe('NOT_FOUND');
  });

  it('PUT 应用补丁', async () => {
    const id = await seedCase();

    const res = await updateCase(jsonRequest(`/api/cases/${id}`, 'PUT', '{"title":"改过的标题"}'), context(id));

    expect(res.status).toBe(200);
    expect((await res.json()).title).toBe('改过的标题');
  });

  it('DELETE 返回 { affectedRuns }', async () => {
    const id = await seedCase();

    const res = await deleteCase(new Request(`http://localhost/api/cases/${id}`, { method: 'DELETE' }), context(id));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ affectedRuns: 0 });
  });
});

describe('R7：仓库校验与 commit 候选按仓库路径', () => {
  it('POST cases/validate-repo 回显仓库名与分支', async () => {
    const res = await validateRepo(jsonRequest('/api/cases/validate-repo', 'POST', JSON.stringify({ repoPath: repo })));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.repoName).toBe('gateway');
    expect(body.repoPath).toBe(repo);
    expect(typeof body.branch).toBe('string');
    // kind 是 RepoInfo 新增的来源判据（spec §4.3）：路由必须原样透出，界面靠它决定回显哪一套字段
    expect(body.kind).toBe('local');
  });

  /**
   * 分支是**经请求体**进服务层的：路由漏传 `repoBranch` 时，远端用例的分支会被静默忽略
   * （RG9 在路由层的形态——用户以为选中的分支生效了，是最坏的那种失败）。
   * 用「本地来源 + 分支」钉这条转发：本地来源填分支必被拒（INVALID_QUERY），
   * 所以 400 + 「本地目录来源不支持分支」这半句只有真的把分支转下去了才可能出现。
   */
  it('POST cases/validate-repo 把 repoBranch 转给服务层（本地来源填分支 → 400 INVALID_QUERY）', async () => {
    const res = await validateRepo(
      jsonRequest('/api/cases/validate-repo', 'POST', JSON.stringify({ repoPath: repo, repoBranch: 'main' })),
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('INVALID_QUERY');
    expect(body.error.message).toContain('本地目录来源不支持分支');
  });

  it('POST cases/validate-repo 对非仓库 → 400 NOT_A_GIT_REPO', async () => {
    const plain = join(dir, 'plain-dir');
    mkdirSync(plain, { recursive: true });

    const res = await validateRepo(jsonRequest('/api/cases/validate-repo', 'POST', JSON.stringify({ repoPath: plain })));

    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('NOT_A_GIT_REPO');
  });

  it('POST cases/commits 返回候选提交', async () => {
    const res = await listCommits(jsonRequest('/api/cases/commits', 'POST', JSON.stringify({ repoPath: repo })));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].subject).toBe('初始提交');
  });

  /**
   * 与隔壁 `validate-repo` 的「把 repoBranch 转给服务层」**对称**的另一半：`/api/cases/commits` 也必须转。
   *
   * 为什么不能只靠 T11 的数据层守卫：那一层钉的是「客户端请求体里有 repoBranch」，而这里钉的是
   * 「路由 parse 之后有没有把它交给服务层」。中间漏掉一棒，用户选了分支、候选列表却永远是默认分支的历史
   * ——正是 RG9 点名的最坏失败（用户以为生效了，而且没有任何报错）。
   *
   * 本地来源 + 分支必被服务层拒（INVALID_QUERY），所以 400 + 「本地目录来源不支持分支」这半句
   * 只有真的把分支转下去了才可能出现——与 validate-repo 那条同一构造、同一个区分力。
   */
  it('POST cases/commits 把 repoBranch 转给服务层（本地来源填分支 → 400 INVALID_QUERY）', async () => {
    vi.mocked(listCommitCandidates).mockClear();

    const res = await listCommits(
      jsonRequest('/api/cases/commits', 'POST', JSON.stringify({ repoPath: repo, repoBranch: 'main' })),
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('INVALID_QUERY');
    expect(body.error.message).toContain('本地目录来源不支持分支');
    // 正向断言调用点：路由交出去的必须是**服务层的入参形状**（对象），而不是旧版的位置参数
    expect(vi.mocked(listCommitCandidates)).toHaveBeenCalledWith({ repoPath: repo, repoBranch: 'main' });
  });

  it('repoPath 缺失 → 400（zod 校验在路由层，不落到 git）', async () => {
    const res = await listCommits(jsonRequest('/api/cases/commits', 'POST', '{}'));

    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('INVALID_QUERY');
  });

  // R7 的结构守卫：钉的是**文件系统**，因为「路由挂在哪个路径」在单元测试里唯一可观察的面就是文件位置。
  // 变异验证见 Step 5。
  it('路由文件挂在 cases/validate-repo 与 cases/commits，不存在按 caseId 的旧形态', () => {
    const casesApiDir = join(import.meta.dirname, '..', 'app', 'api', 'cases');

    expect(existsSync(join(casesApiDir, 'validate-repo', 'route.ts'))).toBe(true);
    expect(existsSync(join(casesApiDir, 'commits', 'route.ts'))).toBe(true);
    expect(existsSync(join(casesApiDir, 'generate-judge-prompt', 'route.ts'))).toBe(true);
    // 旧形态：创建用例时还没有 caseId，「按 caseId 校验仓库」根本没法在新建流程里调用（契约 §11 R7）
    expect(existsSync(join(casesApiDir, '[caseId]', 'validate-repo'))).toBe(false);
    expect(existsSync(join(casesApiDir, '[caseId]', 'commits'))).toBe(false);
  });
});

describe('/api/cases/generate-judge-prompt', () => {
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

  /**
   * 配置一个全局默认评分模型。
   * 假响应按 OpenAI Chat Completions 的形状给（`choices[0].message.content`），正文是**评分表**的 JSON
   * ——若 p0 的 callTextApi 取的是别的字段，要改的是**这里的假响应**，不是被测行为。
   */
  function configureJudge(): void {
    saveConfig({
      ...loadConfig(),
      providers: [PROVIDER],
      // 保留已有设置（含工作区根目录）：测试只该改它关心的字段
      settings: { ...loadConfig().settings, defaultJudge: { providerId: PROVIDER.id, modelId: 'deepseek-chat' } },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    groups: [{ name: '一、生产代码', items: [{ id: 'A1', goal: '让 agent 进入对外契约', weight: 18 }] }],
                  }),
                },
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );
  }

  it('返回 { rubric, addedItems }（走真实的 callTextApi + 假 fetch）', async () => {
    configureJudge();

    const res = await generateRubric(
      jsonRequest(
        '/api/cases/generate-judge-prompt',
        'POST',
        JSON.stringify({ rubric: { groups: [] }, repoPath: repo, taskPrompt: '补一条回归' }),
      ),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rubric.groups[0].name).toBe('一、生产代码');
    expect(body.rubric.groups[0].items[0].weight).toBe(18);
    expect(body.addedItems).toBe(1);
    // 上游调用只打假 fetch，永远没有真实网络；顺带钉住地址来自配置里的 baseUrl
    const [url] = vi.mocked(fetch).mock.calls[0]!;
    expect(String(url)).toContain('api.deepseek.com');
  });

  it('未配置评分模型 → 409 CONFLICT，message 指向设置页，且不打上游', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const res = await generateRubric(
      jsonRequest(
        '/api/cases/generate-judge-prompt',
        'POST',
        JSON.stringify({ rubric: { groups: [] }, repoPath: repo, taskPrompt: '补一条回归' }),
      ),
    );

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('CONFLICT');
    expect(body.error.message).toContain('设置');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('模型返回的不是 JSON → 500 JUDGE_PARSE_FAILED，并在 context 里保留原文', async () => {
    configureJudge();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: '这段代码写得不错。' } }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );

    const res = await generateRubric(
      jsonRequest(
        '/api/cases/generate-judge-prompt',
        'POST',
        JSON.stringify({ rubric: { groups: [] }, repoPath: repo, taskPrompt: '补一条回归' }),
      ),
    );

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe('JUDGE_PARSE_FAILED');
    expect(JSON.stringify(body.error.context)).toContain('这段代码写得不错');
  });
});

/**
 * **真实 payload 形状**的路由级守卫（收口复审追加）。
 *
 * 为什么要单独有这么一层：服务函数级的守卫（`packages/server/api/src/cases.test.ts`）证的是**判定逻辑**，
 * 而收口复审 N1 的成因恰恰是「真实形状到了路由、判定却按『字段出现与否』」的错配——那一层只有当 body
 * 真的以 HTTP 形状喂进 `PUT /api/cases/{id}` 时才看得见（路由只做 `CasePatchSchema.parse` 后转出，
 * 见 `app/api/cases/[caseId]/route.ts:24-32`）。
 *
 * 这里的 body 一律按面板 `handleFinish`（`case-form-panel.tsx`）交出来的 **6 字段全量形状** 构造：
 * 面板不做任何 diff，PUT 收到的就是这 6 个字段（用例级评分模型那一格已删除，故它不再出现——
 * 夹具的字段表一旦不跟着面板走，这层守卫的全部价值就没了）。
 */
describe('PUT 的真实 payload 形状（路由级守卫）', () => {
  /** 面板 `handleFinish` 交出去的 6 个字段；PUT body 就是它，没有增量 */
  type UiCaseBody = Pick<TestCase, 'title' | 'repoPath' | 'commitHash' | 'repoBranch' | 'taskPrompt' | 'rubric'>;

  /** 照 UI 的字段表造 PUT body：默认原样回交当前值，各用例只覆盖自己关心的字段 */
  function uiBody(current: TestCase, overrides: Partial<UiCaseBody> = {}): string {
    return JSON.stringify({
      title: current.title,
      repoPath: current.repoPath,
      commitHash: current.commitHash,
      repoBranch: current.repoBranch,
      taskPrompt: current.taskPrompt,
      rubric: current.rubric,
      ...overrides,
    } satisfies UiCaseBody);
  }

  /** 经路由读回当前用例：PUT 的 body 照它原样回交，「落盘没变」的断言也用它 */
  async function readCase(id: string): Promise<TestCase> {
    const res = await getCase(new Request(`http://localhost/api/cases/${id}`), context(id));
    expect(res.status).toBe(200);
    return (await res.json()) as TestCase;
  }

  /** 经路由 POST 建用例，body 是 UI 的 6 字段全量形状 */
  async function createViaRoute(): Promise<TestCase> {
    const res = await createCase(
      jsonRequest(
        '/api/cases',
        'POST',
        JSON.stringify({
          title: '路由层夹具',
          repoPath: repo,
          commitHash: null,
          taskPrompt: '补一条回归',
          rubric: { groups: [{ name: '一、生产代码', items: [{ id: 'A1', goal: '追加 agent 字段', weight: 18 }] }] },
        }),
      ),
    );
    expect(res.status).toBe(201);
    return (await res.json()) as TestCase;
  }

  /**
   * 旧版本留下的用例级评分模型（那一版会把它写进配置）**经路由造不出来**——
   * 契约上这两列已经不存在、路由的 `CasePatchSchema.parse` 会把它们剥掉。所以按它的真实来路造：
   * 先经路由 POST 一条合法的，再把那两列直接写进配置。
   */
  async function seedLegacyJudgeOverrideCase(): Promise<TestCase> {
    const created = await createViaRoute();
    const config = loadConfig();
    config.cases = config.cases.map((item) =>
      item.id === created.id
        ? ({ ...item, judgeProviderId: 'provider-1', judgeModelId: 'deepseek-chat' } as unknown as TestCase)
        : item,
    );
    saveConfig(config);
    return readCase(created.id);
  }

  it('PUT 收到 UI 的真实全量 body（只改标题）→ 200，历史残留的评分字段在响应体与盘上一起消失', async () => {
    const current = await seedLegacyJudgeOverrideCase();
    // 先确认这份「历史数据」真的在盘上（否则下面几条断言测的是空气）
    expect((loadConfig().cases[0] as unknown as Record<string, unknown>).judgeProviderId).toBe('provider-1');

    const body = uiBody(current, { title: '路由层：历史残留用例改标题' });
    // 形状本身也是被钉的一部分：真的是 6 个字段，不是手写的片段，也**不再含**评分模型两列
    expect(Object.keys(JSON.parse(body) as object)).toHaveLength(6);

    const res = await updateCase(jsonRequest(`/api/cases/${current.id}`, 'PUT', body), context(current.id));

    expect(res.status).toBe(200);
    const updated = (await res.json()) as TestCase;
    expect(updated.title).toBe('路由层：历史残留用例改标题');
    expect(updated).not.toHaveProperty('judgeProviderId');
    expect(updated).not.toHaveProperty('judgeModelId');
    // 响应体是内存对象，证明不了持久化：再经路由读一次
    const stored = await readCase(current.id);
    expect(stored.title).toBe('路由层：历史残留用例改标题');
    expect(stored).not.toHaveProperty('judgeProviderId');
    expect(stored).not.toHaveProperty('judgeModelId');
    // 盘上也真的清掉了（这条才是「保存一次顺手迁移」的实质）
    const after = loadConfig().cases[0] as unknown as Record<string, unknown>;
    expect(after).not.toHaveProperty('judgeProviderId');
    expect(after).not.toHaveProperty('judgeModelId');
  });

  it('PUT body 里多给评分模型两列 → 200，但它们进不了盘（路由层就把它们剥掉）', async () => {
    const current = await createViaRoute();
    const body = JSON.stringify({
      ...(JSON.parse(uiBody(current, { title: '带评分字段的全量补丁' })) as object),
      judgeProviderId: 'provider-1',
      judgeModelId: 'deepseek-chat',
    });

    const res = await updateCase(jsonRequest(`/api/cases/${current.id}`, 'PUT', body), context(current.id));

    expect(res.status).toBe(200);
    const stored = await readCase(current.id);
    expect(stored.title).toBe('带评分字段的全量补丁');
    expect(stored).not.toHaveProperty('judgeProviderId');
    expect(stored).not.toHaveProperty('judgeModelId');
    // 落盘的那一份同样不许有（读侧归一能挡住泄漏，挡不住真写进去）
    expect(loadConfig().cases[0]).not.toHaveProperty('judgeProviderId');
    expect(loadConfig().cases[0]).not.toHaveProperty('judgeModelId');
  });
});
