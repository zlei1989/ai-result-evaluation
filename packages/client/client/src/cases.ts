/**
 * 用例数据层：列表 / 详情 / 增删改 + 仓库校验 + commit 候选 + 评分标准项的生成与识别 + 用例同步。
 *
 * 两条约定：
 *   1. **cache key 就是路由 URL**（列表用 `/api/cases`，详情用 `/api/cases/{id}`），
 *      这样「URL 写错」在测试里立刻表现为请求打到了不存在路由，而不是安静地拿旧数据；
 *   2. mutation 的响应形状与列表 key **不同形**（列表是 `{ cases, warnings }`、mutation 返回单条），所以一律
 *      `populateCache: false` + `revalidate: true`：不回写（会把数组换成对象），改为重新拉一次列表。
 *      详情缓存单独用全局 mutate 回写，否则「保存后详情栏还显示旧值」。
 *
 * 三个「动作型」接口（校验仓库 / commit 候选 / 生成评分标准项）都**按仓库来源**走，URL 里不出现 caseId
 *：新建用例时还没有 caseId，而这三件事的输入本来就是来源（远端来源另带分支）。
 */
import useSWR, { useSWRConfig } from 'swr';
import useSWRMutation from 'swr/mutation';
import type {
  CaseCreate,
  CaseList,
  CasePatch,
  CaseSyncAction,
  CaseSyncStatus,
  CommitCandidate,
  GenerateRubricInput,
  GenerateRubricResult,
  RepoInfo,
  TestCase,
} from '@aieval/contracts';
import { delJson, getJson, postJson, putJson } from './http';

const LIST_KEY = '/api/cases';
const VALIDATE_REPO_KEY = '/api/cases/validate-repo';
/** 用例同步状态 / 动作的 cache key（与路由 URL 逐字相同，见上面的约定 1） */
const CASE_SYNC_STATUS_KEY = '/api/cases/sync-status';
const CASE_SYNC_KEY = '/api/cases/sync';
/**
 * 生成 / 识别 / 调整评分标准项的 cache key：**路由路径沿用** `/api/cases/generate-judge-prompt`
 * （spec 的接口口径：三个按钮打同一个接口、由入参的 `mode` 显式分派，不为一次改名新增一条路由），
 * 常量名同样不改——它与路由 URL 是一对，改名只会让「常量名与 URL 各说各话」。
 */
const GENERATE_JUDGE_PROMPT_KEY = '/api/cases/generate-judge-prompt';

/**
 * commit 候选的 cache key 第一段。**由本文件唯一持有**：用例页要用它按前缀重取候选
 * （「重新加载候选」→ `mutate` 的过滤函数），页面里再写一份字面量就会漂移——
 * 漂移的症状是「点了没反应」：过滤器匹配不到任何 cache key，一个请求都不发，也不报错。
 */
export const COMMITS_KEY = '/api/cases/commits';

/**
 * 「这个 cache key 是不是 commit 候选」——把 key 的**形状**（`[COMMITS_KEY, repoPath, repoBranch]`）
 * 也一并收在这里：用例页只需要知道「要不要重取」，不必知道 URL 在数组的第几段。
 * 参数写成可选、类型写成 `unknown`：SWR 的过滤函数可能拿到 undefined，也可能拿到字符串 key。
 */
export function matchesCommitsKey(key?: unknown): boolean {
  return Array.isArray(key) && key[0] === COMMITS_KEY;
}

/**
 * 用例列表。下行形状是 `CaseList`（`{ cases, warnings }`），但**对外仍然只叫 `cases`**——
 * 调用方（用例页）拿到的一直是数组，多出来的那层壳不该泄漏到每个消费点。
 *
 * `warnings` 是「有文件被跳过」的唯一出口：用例一文件一落后，`<casesRoot>` 里出现手改坏的 /
 * 文件名不合法的 json 是很自然的事，读侧是**跳过**（一条坏文件不能让整页列表 500）。
 * 跳过而不说，用户的症状是「我的用例不见了」却查不到原因，故这一格必须一起透出来。
 * 无数据时给 `[]` 而不是 undefined：页面渲染告警时不必再判一次空。
 *
 * refresh 供「外部改了数据」后手动刷新（例如删除后想立刻对齐另一台标签页）。
 */
export function useCases(): {
  cases: TestCase[] | undefined;
  warnings: string[];
  error: unknown;
  isLoading: boolean;
  refresh: () => void;
} {
  const { data, error, isLoading, mutate } = useSWR<CaseList>(LIST_KEY, getJson);
  return {
    cases: data?.cases,
    warnings: data?.warnings ?? [],
    error,
    isLoading,
    // 包一层而不是直接把 mutate 透出去：refresh 是「无参、无返回」的动作，返回的 Promise 无人接
    refresh: (): void => {
      void mutate();
    },
  };
}

/**
 * 用例同步状态（`GET /api/cases/sync-status`）。**刻意不轮询**：状态里唯一会自己变的两格
 * （`running` / `pendingCount`）都由用户动作驱动——要更新时页面自己 `refresh`（动作成功后回写、
 * 或用户重新进页面），比固定间隔拉一个「多数时候没变」的快照省事得多；
 * 定时轮询还会让「正在同步」这段 loading 与真实进度各说各话。
 *
 * 读失败（error 非 undefined）必须由页面说出来：`status === undefined` 单独一个状态既可能是
 * 「还在读」也可能是「读失败」，把后者说成前者，用户会一直等一个不会自己出现的骨架屏。
 */
export function useCaseSyncStatus(): {
  status: CaseSyncStatus | undefined;
  error: unknown;
  isLoading: boolean;
  refresh: () => void;
} {
  const { data, error, isLoading, mutate } = useSWR<CaseSyncStatus>(CASE_SYNC_STATUS_KEY, getJson);
  return {
    status: data,
    error,
    isLoading,
    refresh: (): void => {
      void mutate();
    },
  };
}

/**
 * 用例同步的人工动作（提交 / 拉取）。`run` 的 Promise **等到服务端跑完**才 settle：
 * 服务端就是这么设计的（`runCaseSync` 把本次动作排进队列、动作跑完才答复），
 * 页面据此决定按钮的 loading 何时结束与结果提示说什么。
 *
 * `populateCache: false, revalidate: false`：该路由只有 POST，SWR 默认的 revalidate 会对它发 GET（405）；
 * 而 `sync-status` 的缓存**回写**成这次的响应——响应本身就是最新快照，
 * 与 `useUpdateCase` 回写详情缓存同源（revalidate:false：再拉一次既多余、又可能被慢响应覆盖成旧值）。
 * 不回写的话，按钮跑完到下一次 GET 之间，界面显示的仍是动作前那一份状态（「点了没反应」的观感）。
 */
export function useCaseSyncAction(): {
  run: (action: CaseSyncAction) => Promise<CaseSyncStatus>;
  isRunning: boolean;
} {
  const { mutate } = useSWRConfig();
  const { trigger, isMutating } = useSWRMutation(
    CASE_SYNC_KEY,
    (key: string, { arg }: { arg: CaseSyncAction }) => postJson<CaseSyncStatus>(key, { action: arg }),
    { populateCache: false, revalidate: false },
  );
  const run = async (action: CaseSyncAction): Promise<CaseSyncStatus> => {
    const result = await trigger(action);
    await mutate(CASE_SYNC_STATUS_KEY, result, { revalidate: false });
    return result;
  };
  return { run, isRunning: isMutating };
}

/**
 * 用例详情。`id` 为 null 时**不发请求**（SWR 的 null key 语义）——
 * 右栏打开「新建」表单时没有 id，传 null 比传空串安全（空串会打出 `/api/cases/`）。
 */
export function useTestCase(id: string | null): {
  testCase: TestCase | undefined;
  error: unknown;
  isLoading: boolean;
} {
  const { data, error, isLoading } = useSWR<TestCase>(id === null ? null : `${LIST_KEY}/${id}`, getJson);
  return { testCase: data, error, isLoading };
}

/** 新建用例：成功后刷新列表（返回创建好的用例，页面用它跳到详情栏） */
export function useCreateCase(): { create: (input: CaseCreate) => Promise<TestCase>; isCreating: boolean } {
  const { trigger, isMutating } = useSWRMutation(
    LIST_KEY,
    (key: string, { arg }: { arg: CaseCreate }) => postJson<TestCase>(key, arg),
    { populateCache: false, revalidate: true },
  );
  return { create: trigger, isCreating: isMutating };
}

/** 更新用例：刷新列表 + 回写详情缓存（两处都要，缺一处就会出现「列表新、详情旧」） */
export function useUpdateCase(): { update: (id: string, patch: CasePatch) => Promise<TestCase>; isUpdating: boolean } {
  const { mutate } = useSWRConfig();
  const { trigger, isMutating } = useSWRMutation(
    LIST_KEY,
    (_key: string, { arg }: { arg: { id: string; patch: CasePatch } }) =>
      putJson<TestCase>(`${LIST_KEY}/${arg.id}`, arg.patch),
    { populateCache: false, revalidate: true },
  );
  const update = async (id: string, patch: CasePatch): Promise<TestCase> => {
    const updated = await trigger({ id, patch });
    // revalidate:false —— 响应就是最新值，再拉一次只会多一次请求，还可能被慢响应覆盖成旧值
    await mutate(`${LIST_KEY}/${id}`, updated, { revalidate: false });
    return updated;
  };
  return { update, isUpdating: isMutating };
}

/** 删除用例：返回受影响评测数（页面用它提示「N 个评测记录仍可查看」）；同时清掉详情缓存 */
export function useDeleteCase(): { remove: (id: string) => Promise<{ affectedRuns: number }>; isDeleting: boolean } {
  const { mutate } = useSWRConfig();
  const { trigger, isMutating } = useSWRMutation(
    LIST_KEY,
    (_key: string, { arg }: { arg: { id: string } }) => delJson<{ affectedRuns: number }>(`${LIST_KEY}/${arg.id}`),
    { populateCache: false, revalidate: true },
  );
  const remove = async (id: string): Promise<{ affectedRuns: number }> => {
    const result = await trigger({ id });
    // 删掉的详情缓存必须清掉：留着它，改回同一个 URL 时会先渲染一条已经不存在的用例
    await mutate(`${LIST_KEY}/${id}`, undefined, { revalidate: false });
    return result;
  };
  return { remove, isDeleting: isMutating };
}

/**
 * 校验仓库（本地路径或远端 git 地址）。**不挂缓存**：校验是「动作」不是「数据」——
 * 缓存住的结果会在仓库被移动 / U 盘拔掉 / 远端改了分支之后继续骗人。
 * 也因此必须 `revalidate: false`：该路由只有 POST，SWR 的默认 revalidate 会对它发 GET（405）。
 *
 * 入参是对象而不是字符串：分支必须一起送上去（服务端按「来源 + 分支」解析回显什么），
 * 本地来源交 `null`。归一（trim、本地路径的形态）全部由服务端做，客户端原样传。
 */
export function useValidateRepo(): {
  validate: (input: { repoPath: string; repoBranch: string | null }) => Promise<RepoInfo>;
  isValidating: boolean;
} {
  const { trigger, isMutating } = useSWRMutation(
    VALIDATE_REPO_KEY,
    (key: string, { arg }: { arg: { repoPath: string; repoBranch: string | null } }) => postJson<RepoInfo>(key, arg),
    { populateCache: false, revalidate: false },
  );
  return { validate: (input) => trigger(input), isValidating: isMutating };
}

/**
 * commit 候选：按「仓库路径 + 分支」现取（POST 当读用——路径可能很长，放 URL query 里既难看又有长度上限）。
 *
 * **key 里必须带分支**：同一仓库的不同分支是两份不同的历史，共用一条缓存会让用户切了分支却看见上一个分支的
 * 候选（那些 hash 在该分支上根本不存在）。key 的第三段用 `''` 表示「没有分支」而不是 `null`，
 * 因为 key 会被序列化成缓存标识，空串是**唯一的**「没有分支」写法；转回请求体时再还原成 `null`
 * （契约里 `repoBranch` 是 `min(1).nullable()`，空串会被拒）。
 *
 * `revalidateOnFocus: false`：这个 fetcher 是**写请求**（POST /api/cases/commits），而 SWR 默认会在
 * 窗口重新获得焦点时重跑它——每切回一次页面就多跑一次 `git log`（大仓库是实打实的秒级卡顿），
 * 还可能把用户正在挑选的候选列表换掉。候选只是便利功能，不需要「回到页面自动刷新」。
 */
export function useCommitCandidates(repoPath: string | null, repoBranch: string | null): {
  commits: CommitCandidate[] | undefined;
  isLoading: boolean;
} {
  const key = repoPath === null || repoPath === '' ? null : ([COMMITS_KEY, repoPath, repoBranch ?? ''] as const);
  const { data, isLoading } = useSWR<CommitCandidate[]>(
    key,
    ([url, path, branch]) => postJson<CommitCandidate[]>(url, { repoPath: path, repoBranch: branch === '' ? null : branch }),
    { revalidateOnFocus: false },
  );
  return { commits: data, isLoading };
}

/**
 * 生成 / 识别 / 调整评分标准项（非流式）。不挂缓存：它是一次会花钱的模型调用，不是可复用的数据。
 * 三个动作打**同一个接口**，由 `input.mode` 显式分派（见服务端 `generateRubric`）。
 *
 * `addedItems` **只在生成分支有意义**（识别 / 调整分支恒为 0，它不代表「什么都没识别出来」）；
 * `changes` **只在调整分支有意义**（另两支没有它）。调用方判成败要看请求的结果，不要看这两格。
 */
export function useGenerateRubric(): {
  generate: (input: GenerateRubricInput) => Promise<GenerateRubricResult>;
  isGenerating: boolean;
} {
  const { trigger, isMutating } = useSWRMutation(
    GENERATE_JUDGE_PROMPT_KEY,
    (key: string, { arg }: { arg: GenerateRubricInput }) => postJson<GenerateRubricResult>(key, arg),
    { populateCache: false, revalidate: false },
  );
  return { generate: trigger, isGenerating: isMutating };
}
