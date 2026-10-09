/**
 * 用例 hooks：路由 URL 就是 SWR 的 cache key、mutation 后列表被刷新、详情缓存被回写、
 * 以及「校验仓库 / commit 候选 / 生成评分标准项按**仓库路径**走，URL 里不出现 caseId」（接口契约 §11 R7）。
 *
 * 每个用例挂一份全新的 SWR 缓存：默认 cache 是模块级单例，用例之间沿用会让第二个用例
 * 直接命中上一个用例的数据与在飞去重项，一次请求都不发，断言随之失真。
 */
import { createElement, type ReactNode } from 'react';
import { SWRConfig, useSWRConfig } from 'swr';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, renderHook, waitFor } from '@testing-library/react';
import { ServiceError, type RepoInfo, type TestCase } from '@aieval/contracts';
import {
  COMMITS_KEY,
  matchesCommitsKey,
  useCases,
  useCommitCandidates,
  useCreateCase,
  useDeleteCase,
  useGenerateRubric,
  useTestCase,
  useUpdateCase,
  useValidateRepo,
} from './cases';

const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(SWRConfig, { value: { provider: () => new Map() } }, children);

afterEach(() => {
  vi.unstubAllGlobals();
});

/** 一个最小的用例对象：字段按契约给全 */
function makeCase(overrides: Partial<TestCase> = {}): TestCase {
  return {
    id: 'case-1',
    title: '为网关补齐转换回归',
    repoPath: 'D:\\projects\\gateway',
    commitHash: null,
    repoBranch: null,
    taskPrompt: '补一条回归用例',
    rubric: { groups: [{ name: '一、生产代码', items: [{ id: 'A1', goal: '追加 agent 字段', weight: 18 }] }] },
    createdAt: '2026-09-22T10:00:00.000Z',
    updatedAt: '2026-09-22T10:00:00.000Z',
    ...overrides,
  };
}

/** 记下每次请求的 (url, method)，并按 url 返回预设响应 */
function stubFetch(routes: Record<string, unknown>): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${url}`;
    if (!(key in routes)) return new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: '没有这个路由' } }), { status: 404 });
    return new Response(JSON.stringify(routes[key]), { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('useCases / useTestCase', () => {
  it('列表的 cache key 就是 /api/cases', async () => {
    const fetchMock = stubFetch({ 'GET /api/cases': [makeCase()] });

    const { result } = renderHook(() => useCases(), { wrapper });

    await waitFor(() => expect(result.current.cases).toBeDefined());
    expect(result.current.cases).toHaveLength(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/cases');
  });

  it('id 为 null 时不发详情请求（打开「新建」栏不该去打一个不存在的详情）', async () => {
    const fetchMock = stubFetch({});

    const { result } = renderHook(() => useTestCase(null), { wrapper });

    expect(result.current.testCase).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('id 给定时按 /api/cases/{id} 取详情', async () => {
    const fetchMock = stubFetch({ 'GET /api/cases/case-1': makeCase() });

    const { result } = renderHook(() => useTestCase('case-1'), { wrapper });

    await waitFor(() => expect(result.current.testCase).toBeDefined());
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/cases/case-1');
  });
});

describe('useCreateCase / useUpdateCase / useDeleteCase', () => {
  it('create 发 POST /api/cases，并在之后刷新列表', async () => {
    const created = makeCase({ id: 'case-new' });
    const fetchMock = stubFetch({ 'GET /api/cases': [], 'POST /api/cases': created });

    const { result } = renderHook(() => ({ list: useCases(), create: useCreateCase() }), { wrapper });
    await waitFor(() => expect(result.current.list.cases).toBeDefined());
    const getCountBefore = fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === undefined).length;

    await result.current.create.create({ title: 'x', repoPath: 'D:\\r', commitHash: null, repoBranch: null, taskPrompt: 't', rubric: { groups: [] } });

    const calls = fetchMock.mock.calls.map(([url, init]) => `${(init as RequestInit | undefined)?.method ?? 'GET'} ${url}`);
    expect(calls).toContain('POST /api/cases');
    // 新建的用例不在旧数组里：不重新拉一次列表，用户要等下次进页面才看得到它
    await waitFor(() => {
      const getCountAfter = fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === undefined).length;
      expect(getCountAfter).toBeGreaterThan(getCountBefore);
    });
  });

  it('update 发 PUT /api/cases/{id}，并把响应回写到详情缓存（详情栏不刷新就能看到新值）', async () => {
    const updated = makeCase({ title: '改过的标题' });
    stubFetch({ 'GET /api/cases/case-1': makeCase(), 'PUT /api/cases/case-1': updated });

    const { result } = renderHook(() => ({ detail: useTestCase('case-1'), update: useUpdateCase() }), { wrapper });
    await waitFor(() => expect(result.current.detail.testCase?.title).toBe('为网关补齐转换回归'));

    await result.current.update.update('case-1', { title: '改过的标题' });

    await waitFor(() => expect(result.current.detail.testCase?.title).toBe('改过的标题'));
  });

  it('remove 发 DELETE /api/cases/{id} 并返回受影响评测数', async () => {
    const fetchMock = stubFetch({ 'GET /api/cases/case-1': makeCase(), 'DELETE /api/cases/case-1': { affectedRuns: 2 } });

    const { result } = renderHook(() => useDeleteCase(), { wrapper });

    await expect(result.current.remove('case-1')).resolves.toEqual({ affectedRuns: 2 });
    expect(fetchMock.mock.calls.map(([url, init]) => `${(init as RequestInit | undefined)?.method ?? 'GET'} ${url}`)).toContain('DELETE /api/cases/case-1');
  });

  // 删除后必须清掉详情缓存（§4.4 的反面）：留着它，右栏会在删除之后继续渲染一条已经不存在的用例，
  // 用户再点「编辑」就会拿着一个 404 的 id 去 PUT。
  // 断言落在**已挂载的详情 hook 的 data** 上而不是内部 cache 对象：页面看到的就是这个 data。
  it('remove 之后详情缓存被清掉（已挂载的详情 hook 不再给出这条用例）', async () => {
    const fetchMock = stubFetch({ 'GET /api/cases/case-1': makeCase(), 'DELETE /api/cases/case-1': { affectedRuns: 1 } });

    const { result } = renderHook(() => ({ detail: useTestCase('case-1'), remove: useDeleteCase() }), { wrapper });
    await waitFor(() => expect(result.current.detail.testCase?.id).toBe('case-1'));

    await result.current.remove.remove('case-1');

    await waitFor(() => expect(result.current.detail.testCase).toBeUndefined());
    expect(fetchMock.mock.calls.map(([url, init]) => `${(init as RequestInit | undefined)?.method ?? 'GET'} ${url}`)).toContain('DELETE /api/cases/case-1');
  });
});

describe('仓库相关的三个动作（R7：按仓库路径，不带 caseId）', () => {
  it('validate 发 POST /api/cases/validate-repo，且不发任何 GET（该路由只有 POST）', async () => {
    const info: RepoInfo = {
      repoPath: 'D:\\projects\\gateway',
      repoName: 'gateway',
      branch: 'main',
      kind: 'local',
      mirrorPath: null,
      mirrorReady: false,
      mirrorFetchedAt: null,
      tip: null,
    };
    const fetchMock = stubFetch({ 'POST /api/cases/validate-repo': info });

    const { result } = renderHook(() => useValidateRepo(), { wrapper });

    await expect(result.current.validate({ repoPath: 'D:\\projects\\gateway', repoBranch: null })).resolves.toEqual(info);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/cases/validate-repo');
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).body).toBe(
      JSON.stringify({ repoPath: 'D:\\projects\\gateway', repoBranch: null }),
    );
    expect(fetchMock.mock.calls.every(([, init]) => (init as RequestInit | undefined)?.method === 'POST')).toBe(true);
  });

  /**
   * 守卫：校验请求必须把**分支**一起送上去。
   *
   * 服务端按「来源 + 分支」解析要回显什么（`RepoValidateInputSchema` 的 repoBranch 缺字段落成 null）：
   * 远端填了分支却送上去 null，用户看到的是**默认分支**的仓库名与 tip——回显与实际将被评测的起点不是同一条，
   * 而这正是「校验过了」这句话的全部价值所在。
   */
  it('校验请求带上分支（远端来源必填，本地传 null）', async () => {
    const info: RepoInfo = {
      repoPath: 'git@host:g/r.git',
      repoName: 'r',
      branch: 'feat/x',
      kind: 'remote',
      mirrorPath: 'C:/runs/remotes/r-1a2b3c4d',
      mirrorReady: true,
      mirrorFetchedAt: '2026-09-26T04:00:00.000Z',
      tip: 'abc1234',
    };
    const fetchMock = stubFetch({ 'POST /api/cases/validate-repo': info });

    const { result } = renderHook(() => useValidateRepo(), { wrapper });

    await expect(result.current.validate({ repoPath: 'git@host:g/r.git', repoBranch: 'feat/x' })).resolves.toEqual(info);
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).body).toBe(
      JSON.stringify({ repoPath: 'git@host:g/r.git', repoBranch: 'feat/x' }),
    );
  });

  it('repoPath 为 null 时不取候选提交', () => {
    const fetchMock = stubFetch({});

    const { result } = renderHook(() => useCommitCandidates(null, null), { wrapper });

    expect(result.current.commits).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('repoPath 给定时 POST /api/cases/commits', async () => {
    const fetchMock = stubFetch({ 'POST /api/cases/commits': [{ hash: 'abc1234', subject: '初始提交' }] });

    const { result } = renderHook(() => useCommitCandidates('D:\\projects\\gateway', null), { wrapper });

    await waitFor(() => expect(result.current.commits).toHaveLength(1));
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/cases/commits');
    // 本地来源 / 远端留空分支时交上去的必须是 null：空串会被 `RepoCommitsInputSchema` 的 min(1) 拒掉
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).body).toBe(
      JSON.stringify({ repoPath: 'D:\\projects\\gateway', repoBranch: null }),
    );
  });

  /**
   * 守卫：候选的 cache key 必须含分支——**同一仓库的不同分支是两份不同的历史**，
   * 共用一条缓存会让用户切了分支却看见上一个分支的候选（列出来的 hash 在该分支上根本不存在）。
   *
   * 断言落在「切分支真的重新发了一次请求、且两次请求各带各的分支」上，而不是只看 key 的形状：
   * `matchesCommitsKey` 对任何以 COMMITS_KEY 开头的数组都返回 true，形状断言对「key 少一段」没有区分力。
   */
  it('同一仓库切分支会换一条缓存（两条分支各发一次请求）', async () => {
    const fetchMock = stubFetch({ 'POST /api/cases/commits': [{ hash: 'abc1234', subject: '初始提交' }] });

    const { result, rerender } = renderHook(
      ({ branch }: { branch: string | null }) => useCommitCandidates('D:\\projects\\gateway', branch),
      { wrapper, initialProps: { branch: 'feat/x' as string | null } },
    );
    await waitFor(() => expect(result.current.commits).toHaveLength(1));

    rerender({ branch: 'main' });

    await waitFor(() =>
      expect(fetchMock.mock.calls.filter(([url]) => url === '/api/cases/commits')).toHaveLength(2),
    );
    const bodies = fetchMock.mock.calls.map(([, init]) => (init as RequestInit).body);
    expect(bodies).toContain(JSON.stringify({ repoPath: 'D:\\projects\\gateway', repoBranch: 'feat/x' }));
    expect(bodies).toContain(JSON.stringify({ repoPath: 'D:\\projects\\gateway', repoBranch: 'main' }));
  });

  /**
   * 焦点重验在这个 hook 上是**有害**的：fetcher 是 POST（服务端要跑 `git log`），
   * 每切回一次页面就重跑一次。SWR 默认开着 revalidateOnFocus，所以这里钉住它被关掉。
   *
   * 专用 wrapper：默认的 `focusThrottleInterval`（5s）与 `dedupingInterval`（2s）会把焦点事件静默吞掉，
   * 于是「没发请求」既可能是真的关掉了、也可能是被节流了——两个窗口都置 0，断言才有区分力。
   */
  const focusWrapper = ({ children }: { children: ReactNode }) =>
    createElement(
      SWRConfig,
      { value: { provider: () => new Map(), focusThrottleInterval: 0, dedupingInterval: 0 } },
      children,
    );

  it('窗口重新获得焦点不会重跑 git log（候选是 POST 读，不允许焦点重验）', async () => {
    const fetchMock = stubFetch({ 'POST /api/cases/commits': [{ hash: 'abc1234', subject: '初始提交' }] });

    const { result } = renderHook(() => useCommitCandidates('D:\\projects\\gateway', null), { wrapper: focusWrapper });
    await waitFor(() => expect(result.current.commits).toHaveLength(1));
    const callsBeforeFocus = fetchMock.mock.calls.length;

    fireEvent.focus(window);
    // 焦点事件是异步派发的：等一拍；重验若开着，这一拍内必然多出一次 POST
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(fetchMock.mock.calls.length).toBe(callsBeforeFocus);
  });

  it('generate 发 POST /api/cases/generate-judge-prompt 并返回评分标准项', async () => {
    const fetchMock = stubFetch({
      'POST /api/cases/generate-judge-prompt': {
        rubric: { groups: [{ name: '一、生产代码', items: [{ id: 'A1', goal: '追加 agent 字段', weight: 18 }] }] },
        addedItems: 1,
      },
    });

    const { result } = renderHook(() => useGenerateRubric(), { wrapper });

    const generated = await result.current.generate({
      mode: 'generate',
      rubric: { groups: [] },
      taskPrompt: '补回归',
      prompt: '',
      repoPath: 'D:\\projects\\gateway',
    });

    expect(generated.rubric.groups[0]?.items[0]?.id).toBe('A1');
    expect(generated.addedItems).toBe(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/cases/generate-judge-prompt');
    // 请求体就是 `GenerateRubricInput` 的五个字段（服务端按 `mode` 显式分派三个动作）
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).body).toBe(
      JSON.stringify({
        mode: 'generate',
        rubric: { groups: [] },
        taskPrompt: '补回归',
        prompt: '',
        repoPath: 'D:\\projects\\gateway',
      }),
    );
  });

  it('服务端错误折叠成 ServiceError（错误码与中文原因都要保留，页面才能直接 message.error）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ error: { code: 'NOT_A_GIT_REPO', message: '不是 git 仓库：D:\\tmp' } }), { status: 400 }),
      ),
    );

    const { result } = renderHook(() => useValidateRepo(), { wrapper });

    let caught: unknown;
    try {
      await result.current.validate({ repoPath: 'D:\\tmp', repoBranch: null });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ServiceError);
    expect((caught as ServiceError).code).toBe('NOT_A_GIT_REPO');
    expect((caught as ServiceError).message).toContain('不是 git 仓库');
  });
});

/**
 * fix wave Item 4：候选的 cache key 由 `cases.ts` **唯一持有**，用例页只消费它。
 *
 * 守的是「漂移 = 静默空操作」：用例页的「重新加载候选」用过滤函数按 key 前缀重取，
 * 过滤函数一旦匹配不到 `useCommitCandidates` 真正用的那个 key，点击就一个请求都不发、也不报错——
 * 用户看到的是「点了没反应」，而不是一条能排查的错误。
 * 所以这里不止钉「常量等于路由 URL」，还**照着页面的用法跑一遍**：用 `matchesCommitsKey` 做 SWR 的
 * mutate 过滤器，断言候选真的被重取、而列表没被顺带刷新。
 * （SWR 把 cache 里原始 key 交给过滤器——`cache.get(key)._k`，见 config-context 的 internalMutate，
 * 所以这里能直接借用页面那条路径，不必自己复刻 key 的序列化形状。）
 */
describe('commit 候选的 cache key 与过滤函数', () => {
  it('COMMITS_KEY 就是路由 URL /api/cases/commits', () => {
    expect(COMMITS_KEY).toBe('/api/cases/commits');
  });

  it('用 matchesCommitsKey 过滤重取：候选被重新拉取，列表不受影响', async () => {
    const fetchMock = stubFetch({
      'POST /api/cases/commits': [{ hash: 'abc1234', subject: '初始提交' }],
      'GET /api/cases': [makeCase()],
    });

    const { result } = renderHook(
      () => {
        // 带分支取候选：页面的过滤器必须照样命中这条**三段** key（漏掉分支这一段就会「点了没反应」）
        const candidates = useCommitCandidates('D:\\projects\\gateway', 'feat/x');
        const list = useCases();
        const { mutate } = useSWRConfig();
        return { candidates, list, mutateCache: mutate };
      },
      { wrapper },
    );
    await waitFor(() => expect(result.current.candidates.commits).toHaveLength(1));
    await waitFor(() => expect(result.current.list.cases).toHaveLength(1));

    const countOf = (url: string): number => fetchMock.mock.calls.filter(([called]) => called === url).length;
    const commitsBefore = countOf('/api/cases/commits');
    const listBefore = countOf('/api/cases');

    // 页面里的一行就是这个调用（「重新加载候选」）：过滤器命中 → 该 key 重新取数
    await result.current.mutateCache(matchesCommitsKey, undefined, { revalidate: true });

    await waitFor(() => expect(countOf('/api/cases/commits')).toBe(commitsBefore + 1));
    // 只重取候选：列表的 key 第一段不同，不该被这次过滤带上（否则「重新加载候选」会顺带刷新整页数据）
    expect(countOf('/api/cases')).toBe(listBefore);
  });

  it('别的 key 不会被当成候选（列表 key / 字符串 key / undefined / 漂移过的 URL）', () => {
    // 带分支的真实 key 形状（`[COMMITS_KEY, repoPath, repoBranch]`）必须匹配得到——
    // 候选 key 从两段变成三段之后，这条是「过滤器还认不认它」的最小钉子
    expect(matchesCommitsKey([COMMITS_KEY, 'D:\\projects\\gateway', 'feat/x'])).toBe(true);
    // 用例列表的 key 也是数组，第一段不同 → 不能重取它
    expect(matchesCommitsKey(['/api/cases', 'D:\\projects\\gateway'])).toBe(false);
    // 字符串 key（例如列表用的是字符串）：形状不对，不能当成候选
    expect(matchesCommitsKey('/api/cases/commits')).toBe(false);
    expect(matchesCommitsKey(undefined)).toBe(false);
    // 反向对照：**漂移后的字面量**（页面自带一份副本时最可能写出的东西）必须匹配不到——
    // 它演示的正是「点了没反应」的成因
    expect(matchesCommitsKey(['/api/cases/commit-candidates', 'D:\\projects\\gateway'])).toBe(false);
  });
});
