/**
 * 用例服务：CRUD + 仓库 / commit 校验 + 删除时一并清掉用例级缓存仓库。
 *
 * 五条口径：
 *   1. **只校验本次改动到的字段**：仓库临时不可用（网络盘掉线、目录被移走）时，
 *      改标题 / 改评分标准项不该被 NOT_A_GIT_REPO 拦住——与设置域「只改主题不校验工作区根目录」同一口径；
 *      「改动到」按**值**判（与当前值相同 = 没改），因为 UI 发出来的补丁永远是全量的（见 updateCase 内注释）；
 *   2. **commitHash 一律落解析后的完整 40 位 hash**：短哈希会随仓库增长变得有歧义，而候选列表
 *      要能 Tooltip 显全量；null / 空串（表单清空输入框拿到的是空串）都表示「默认分支 HEAD」；
 *   3. **删除时缓存仓库删不掉不阻断删除**：缓存只是磁盘垃圾（首次评测前压根不存在、Windows 上可能被占用），
 *      让它把「删用例」这个用户动作弄失败，是把内部细节泄漏成用户故障；
 *   4. **远端来源只读镜像**：校验 = 快探活（15s 上限）→ 建 / 更新镜像 → 解析要用的分支，全程不 checkout、
 *      不建工作树（那是评测准备的活）；本地来源填了分支一律拒绝，不静默忽略；
 *   5. **写侧拦不合法 / 用之前拒旧版**：落盘前按契约 + `validateRubric` 自检（空表、有组无项、ID 重复
 *      都写不进去），**用**这个用例时（取详情 `getCase` / 编辑 `updateCase`）`rubric` 不是合法表的旧用例
 *      显式抛中文 INTERNAL（见 `asUsableCase` 与 `assertUsableRubric`）。注意这条守卫
 *      **不在列表路径上**：一条旧用例不能让整页列表 500（那样用户连删它的入口都没有），
 *      列表照常返回、详情/编辑/建评测才拒。
 */
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import {
  RubricSchema,
  ServiceError,
  TestCaseSchema,
  parseRepoSource,
  validateRubric,
  type CaseCreate,
  type CaseList,
  type CasePatch,
  type CommitCandidate,
  type RepoInfo,
  type RepoSource,
  type Rubric,
  type TestCase,
} from '@aieval/contracts';
import {
  assertCommit,
  caseCacheDir,
  createLogger,
  defaultBranchName,
  deleteCaseFile,
  ensureMirror,
  ensureRemotesDir,
  fetchMirror,
  listCommits,
  listCases as listStoredCases,
  probeRemote,
  readCase as readStoredCase,
  readMirrorRecord,
  remotesDir,
  resolveRemoteRef,
  resolveRepoInfo,
  writeCase,
} from '@aieval/core';
import { listRunsForCase } from '@aieval/evaluator';
import { enqueueCaseSync } from './case-sync';
import { getSettings } from './settings';

const log = createLogger('cases');

/**
 * 列表：最近改动的用例在最前。
 * 同一毫秒创建的两条按 id 兜底排序——否则顺序依赖 Array.sort 的实现细节，测试会随机飘。
 * `repoBranch` 走一遍读侧归一：旧用例文件里可能根本没有这一列（`?? null` 补 undefined），
 * 而契约声明的是 `string | null`——读出来是 undefined 就是在对一个不存在的第三态做承诺（A10③）。
 *
 * 坏文件（名字不合 id 形状 / 不是合法 JSON）由 core 的存储层**跳过**并把原因带出来，
 * 这里原样透给界面：列表必须能渲染（用户要能从这一页删掉那条坏文件），但**不能不说**。
 */
export function listCases(): CaseList {
  const stored = listStoredCases();
  return {
    cases: stored.cases.map(asStoredCase).sort((a, b) => {
      if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    }),
    warnings: stored.warnings,
  };
}

/**
 * 取单个用例；不存在抛 NOT_FOUND（路由层映射成 404）。
 * **旧版数据**（重构前建的、`rubric` 缺失或形状不对）在这里被拒——这是「用」这个用例的入口
 * （创建评测、换用例编辑都走它），见 `assertUsableRubric`。
 */
export function getCase(caseId: string): TestCase {
  const found = readStoredCase(caseId);
  if (found === null) {
    throw new ServiceError('NOT_FOUND', `用例不存在：${caseId}`, { context: { caseId } });
  }
  return asUsableCase(found);
}

/**
 * 「**用**这个用例」：归一（`asStoredCase`）+ 判评分表（`assertUsableRubric`）。
 * **两条入口共用这一份**：`getCase`（详情 / 创建评测 / 换用例）与 `updateCase`（编辑时的当前行）。
 * 各写一遍必然漂移，而漂移的症状正是「详情给的是那句中文、编辑给的是一串 schema issues」——
 * 编辑一条旧用例若直接落到 `assertStorable` 的 `TestCaseSchema.parse`，
 * 抛出裸 `ZodError`，路由层折成技术性的 `INVALID_QUERY`。
 */
function asUsableCase(record: TestCase): TestCase {
  return { ...asStoredCase(record), rubric: assertUsableRubric(record) };
}

/**
 * 「**用**这个用例」之前的守卫：旧用例（重构前建的）只有一段 `judgePrompt`、
 * 没有 `rubric`，读出来就是一份已经失去意义的旧口径。**详情、创建评测、换用例、编辑**都经过它，
 * 用户拿到的是能照做的那句话（点名 caseId）。
 *
 * 为什么**不放在 `asStoredCase`**：`listCases` 用的是同一个
 * 归一函数，于是**一条**旧用例就让 `GET /api/cases` 变成 500——而那句话让用户「删除它」，
 * 偏偏能删它的那个页面渲染不出来（出路只剩手改 config.json 或直接打 DELETE）。
 * 守卫落在**用**的路径上，不是**列**的路径上：列表照常把这条用例返回给界面，用户能把它删掉。
 *
 * 判据用 `safeParse` 而不是判 `=== undefined`：config.json 是手可编辑的，`rubric` 可能是
 * **存在但形状不对**的（半截对象、`items` 写成字符串）。两种坏数据对用户的处置是同一句话，
 * 用同一个分支处理才不会漏掉后一种。返回的是**解析后的表**（默认值已补齐）。
 *
 * **空表（`{ groups: [] }`）故意放行**，这不是漏判：它是一张**合法的 `Rubric`**（契约刻意不设
 * `.min(1)`——空表是新建用例的真实初态，见 `rubric.ts` 口径 2），本函数只拒**过不了 schema** 的形状。
 * 于是「手改 `config.json` 留下一张空表」的用例照样能被取详情、被用来建轮次，而「这一轮没法评分」
 * 由评分阶段的守卫（`orchestrator.ts` 的 `runJudgeStage`，满分 ≤ 0 ⇒ 中文 `CONFLICT`）接住——
 * 那是它该在的层。**别在这里加「空表也算旧版数据」的第二套判据**：界面正在编辑的空表、
 * 与旧版数据是两件事，混成一句会让「新建用例的中途状态」也被拒。
 */
function assertUsableRubric(testCase: TestCase): Rubric {
  const rubric = RubricSchema.safeParse((testCase as { rubric?: unknown }).rubric);
  if (!rubric.success) {
    throw new ServiceError('INTERNAL', `这个用例是旧版数据（没有评分标准项），请删除它或重新创建：${testCase.id}`);
  }
  return rubric.data;
}

/**
 * 读侧归一：把配置里那一行补成契约声明的形状——
 *   · `repoBranch` 的第三态 undefined → null；
 *   · **丢掉契约上已经不存在的三列**：用例级评分模型那两列（`judgeProviderId` / `judgeModelId`）
 *     与旧口径的 `judgePrompt`。三者是同一件事：`loadConfig()` 不校验、旧 config.json 里还留着它们，
 *     而裸 spread 会把它们原样交给下游——下游拿到的是一份「类型上没有、运行时却有」的数据，
 *     只能靠猜它算不算数。`judgePrompt` 尤其不能漏：契约上 `TestCase` 已经没有这一格，
 *     它却是一整段**看起来还能用**的评分口径，留着它就是在给「按旧口径评分」留一扇暗门
 *     （实测：前两列被删掉了，这一列照样从 `GET /api/cases` 流出去）；
 *   · `rubric` 过一遍**不抛**的 `safeParse`：靠 schema 缺省值的合法记录（例如某一项没写 `id`，
 *     由 `RubricItemSchema.id` 的 `.default('')` 补齐）也必须以 `id: ''` 流出去，而不是
 *     `id: undefined`——契约声明的是 `id: string`，第三态要留给下游猜（A10③ 的口径）。
 *     解析不过就把这一格**删掉**（`delete`，与上面那三列同一形状）：`stale` 是整行的 spread，
 *     `rubric` 本来就在里面——在失败分支里 spread 一个空对象**删不掉**任何东西，一个非 `Rubric`
 *     的值就这么从列表流出去了（`{ groups: '这不是数组' }` 会原样透传）。
 *     这条路径（`listCases`）必须能渲染，该用例会在 `asUsableCase` 里被明确拒绝。
 * 除此之外一律原样——`TestCaseSchema` 的读路径**刻意不加**业务 refine，
 * 这里也不能变成第二份校验器；**旧用例的拒绝也不在这里**（`listCases` 与本函数共用同一个归一，
 * 放这儿会让列表整页 500，见 `assertUsableRubric`）。
 */
function asStoredCase(record: TestCase): TestCase {
  const stale = { ...record } as TestCase & {
    judgeProviderId?: unknown;
    judgeModelId?: unknown;
    judgePrompt?: unknown;
  };
  delete stale.judgeProviderId;
  delete stale.judgeModelId;
  delete stale.judgePrompt;
  const rubric = RubricSchema.safeParse((record as { rubric?: unknown }).rubric);
  // 失败时**删键**（不是「不覆盖」）：断言里那个非法值已经在 `stale` 上了，只有 delete 能把它拿掉
  if (!rubric.success) delete (stale as { rubric?: unknown }).rubric;
  return {
    ...stale,
    repoBranch: normalizeBranch(record.repoBranch),
    ...(rubric.success ? { rubric: rubric.data } : {}),
  };
}

/** 新建用例：先校验仓库与 commit（这两个场景要在写入前被拦下），再落盘 */
export function createCase(input: CaseCreate): TestCase {
  // 来源与分支一次判定成型（本地来源走 resolveRepoInfo，远端走镜像），落盘的就是这里的三个值
  const { source, repoPath, repoBranch } = resolveCaseSource(input.repoPath, input.repoBranch);
  // 仓库名与**日志里的分支**都从 `source` 这一侧派生，不从补丁/入参原文派生：
  //   · 仓库名：远端从 URL 本身取（不联网，与评分标准项的生成那条同口径），本地仍需 git 回显（软链接 / 盘根等情形它更准）；
  //   · 分支：本地来源拿 `resolveRepoInfo` 回显的**实际检出分支**（对本地来说「分支」就是它的 HEAD，
  //     写死一句「默认分支」等于在日志里丢掉唯一有用的那条信息）；远端来源记请求的分支，没指定才写「默认分支」。
  // **远端不能走 `resolveRepoInfo`**：远端来源只有 `url`、没有 `path`（也不该为一个日志字段去联网校验）。
  const localInfo = source.kind === 'local' ? resolveRepoInfo(source.path) : null;
  const repoName = source.kind === 'local' ? localInfo!.repoName : source.repoName;
  const loggedBranch = source.kind === 'local' ? localInfo!.branch : repoBranch ?? '默认分支';
  const now = new Date().toISOString();
  const created: TestCase = {
    id: randomUUID(),
    title: input.title.trim(),
    repoPath,
    commitHash: resolveCommitInput(source, input.commitHash),
    repoBranch,
    taskPrompt: input.taskPrompt,
    rubric: input.rubric,
    createdAt: now,
    updatedAt: now,
  };
  const stored = assertStorable(created);
  writeCase(stored);
  // 成功日志必须在**落盘之后**打（`updateCase` 同口径）：校验不过或写盘失败时留下一条「创建用例」的 INFO，
  // 会让排障的人把一次被拒绝的保存读成成功——日志是这一刻唯一的旁证。
  log.info('创建用例', { caseId: stored.id, repoName, branch: loggedBranch });
  scheduleSync('创建用例');
  return stored;
}

/**
 * 更新用例：只校验本次改动到的字段（见文件头口径 1）。
 * 两个容易写错的点：
 *   - 只换仓库、没给新 commit 时，旧 commit 必须拿到**新仓库**里再确认一次：留着它只会让这一轮评测
 *     在准备阶段失败，宁可在保存时以 INVALID_REF 拦下；
 *   - 编辑也是**用**这个用例：当前行要过 `asUsableCase`（与 `getCase` 同一份判据）。少了它，一条旧用例
 *     会落到下面 `assertStorable` 的 `TestCaseSchema.parse`，抛出裸 `ZodError`（路由层折成技术性的
 *     `INVALID_QUERY`），用户拿不到那句能照做的「旧版数据，请删除它或重新创建：<caseId>」。
 */
export function updateCase(caseId: string, patch: CasePatch): TestCase {
  const found = readStoredCase(caseId);
  if (found === null) {
    throw new ServiceError('NOT_FOUND', `用例不存在：${caseId}`, { context: { caseId } });
  }
  const current = asUsableCase(found);

  // 「与当前值相同」就当作**本次没改**，不触发任何仓库 / commit 校验。
  // 为什么必须按**值**判而不是按 `!== undefined` 判：UI 发出来的补丁永远是全量的——面板 `handleFinish`
  // 无条件带上预填的 `repoPath` / `commitHash` / `repoBranch`，页面把它当整份补丁发出去（`page.tsx` 的 `update(id, values)`）。
  // 按「字段出现没有」判，在真实提交形状下等于「每次保存都校验仓库」，于是仓库临时不可用
  // （网络盘掉线 / 目录被移走）时用户改标题一律拿到 NOT_A_GIT_REPO，改不动——与文件头口径 1 的承诺相反。
  const nextRepoPathPatch = patch.repoPath;
  // 「改没改」先按**原文**短路：逐字相同 ⇒ 本次没改到来源，**连归一都不做**。
  // 归一是要过 `parseRepoSource` 的，而它对一条手改坏的 legacy 行（`ftp://…` 之类）直接抛
  // INVALID_QUERY——按 UI 的真实形状补丁里永远带着那一份原样的来源（见 uiPatchOf），
  // 于是「只改标题」也会被它拦住，与文件头口径 1 相反。
  let nextRepoPath = current.repoPath;
  let repoChanged = false;
  if (nextRepoPathPatch !== undefined && nextRepoPathPatch !== current.repoPath) {
    // 归一后相等仍算「没改」：用户把 `https://host/x.git/` 原样存两次不该算两次改动
    nextRepoPath = normalizeSourceString(nextRepoPathPatch);
    repoChanged = nextRepoPath !== current.repoPath;
  }
  const nextBranch =
    patch.repoBranch === undefined ? (current.repoBranch ?? null) : normalizeBranch(patch.repoBranch);
  const branchTouched = nextBranch !== (current.repoBranch ?? null);

  // 来源 / 分支真的变了才判定成型；没变时**连解析都不做**（`resolved` 是 null）。
  // 为什么解析必须懒：`parseRepoSource` 对一条手改坏的 legacy 行会抛 INVALID_QUERY，
  // 而无条件算一次 `resolved` 就等于「每次保存都解析当前来源」——只改标题也保存不了，
  // 正是文件头口径 1 承诺不会发生的事（比「仓库掉线」更硬的一种坏数据：重试多少次都一样）。
  const resolved = repoChanged || branchTouched ? resolveCaseSource(nextRepoPath, nextBranch) : null;

  const commitTouched = patch.commitHash !== undefined && patch.commitHash !== current.commitHash;
  // 什么时候才需要判定 commit，以及拿哪一份来源去判：
  //   · 来源 / 分支变了 → 拿**新来源**（`resolved.source`）；
  //   · 只有 commit 变了、来源没变 → 这是**唯一**必须解析「当前来源」的一格；
  //   · 两者都没变 → 什么都不做（`commitSource` 保持 null，一个字符都不解析）。
  let commitSource: RepoSource | null = null;
  if (resolved !== null) {
    commitSource = resolved.source;
  } else if (commitTouched) {
    commitSource = parseRepoSource(current.repoPath);
  }
  const commitHash =
    commitSource === null
      ? current.commitHash
      : resolveCommitInput(commitSource, patch.commitHash === undefined ? current.commitHash : patch.commitHash);

  const next: TestCase = {
    ...current,
    ...(patch.title === undefined ? {} : { title: patch.title.trim() }),
    repoPath: resolved?.repoPath ?? current.repoPath,
    commitHash,
    // 必须**合并** patch.repoBranch：漏了这一行，用户切分支保存会拿到 200、界面显示成功、落盘还是旧分支
    // （最坏的失败：用户以为生效了）
    repoBranch: resolved?.repoBranch ?? current.repoBranch ?? null,
    ...(patch.taskPrompt === undefined ? {} : { taskPrompt: patch.taskPrompt }),
    ...(patch.rubric === undefined ? {} : { rubric: patch.rubric }),
    updatedAt: new Date().toISOString(),
  };
  const stored = assertStorable(next);
  writeCase(stored);
  log.info('用例已更新', { caseId });
  scheduleSync('更新用例');
  return stored;
}

/**
 * 删除用例：返回受影响的评测数，并清掉用例级缓存仓库。
 * **评测记录本身不删**——它带着 caseTitle / repoPath / commitHash 的冗余快照，删了用例照样可读。
 */
export function deleteCase(caseId: string): { affectedRuns: number } {
  const target = readStoredCase(caseId);
  if (target === null) {
    throw new ServiceError('NOT_FOUND', `用例不存在：${caseId}`, { context: { caseId } });
  }

  // 引用数在删除前数：返回值要能回答「这次删除影响了多少评测」
  const affectedRuns = listRunsForCase(caseId).length;

  deleteCaseFile(caseId);
  log.info('用例已删除', { caseId, affectedRuns });

  removeCaseCache(caseId);
  scheduleSync('删除用例');
  return { affectedRuns };
}

/**
 * 仓库校验：本地走既有 git 口径；远端先快探活、再确保镜像并增量更新，最后解析要用的分支。
 * 顺序有意如此：探活（15s 上限）先把「不可达 / 认证失败 / 不存在 / 空仓库」分开，
 * 再让用户为一次真实克隆等待——两者失败时的处置完全不同。
 * 来源形态由**字符串本身**判定（parseRepoSource），不看界面当时处于哪个输入模式：URL 填进「本地路径」
 * 那一栏同样按远端走，否则同一个串在保存与准备两处会得到两种解释。
 */
export function validateRepo(input: { repoPath: string; repoBranch: string | null }): RepoInfo {
  const source = parseRepoSource(input.repoPath);
  const branch = normalizeBranch(input.repoBranch);
  if (source.kind === 'local') {
    // 本地来源的分支一律拒绝（不静默忽略）：用户以为生效了才是最坏的
    if (branch !== null) throw new ServiceError('INVALID_QUERY', `本地目录来源不支持分支：${source.path}`);
    return resolveRepoInfo(source.path);
  }

  const workspaceRoot = getSettings().workspaceRoot;
  const cwd = remotesDir(workspaceRoot);
  // remotes 目录是探活的工作目录、也是镜像的父目录（probeRemote 与 ensureMirror 各自也会建），
  // 这里显式建一次：让「远端操作都落在工作区根的 remotes 下」在入口处就成立。
  // 建不出来（工作区根不可写）由 core 折成 NOT_WRITABLE：裸 errno 到路由层只剩一句「服务端内部错误」
  ensureRemotesDir(cwd);

  // 先探活再克隆：探活只问「连不连得上、有没有 HEAD」，失败分类与一次真实克隆等待的处置不同。
  // 它回的那个默认分支名**是有消费者的**：下面交给 fetchMirror 去对齐镜像 HEAD
  // （远端改了默认分支时 fetch 不刷新 HEAD，见 core 的 alignDefaultBranch）——别把它当成一句可有可无的回显
  const probe = probeRemote(source.url, { cwd });
  const mirror = ensureMirror({ workspaceRoot, url: source.url });
  // 刚克隆出来的镜像**不再抓一次**：克隆本身就是这一次从远端取回（HEAD 由 clone 按远端 HEAD 写好、
  // 镜像记录也是那一刻写的），紧接着再 fetch 一次是白等一个往返——大仓库首次校验是分钟级的。
  // 既有镜像必须更新：「跟随分支 / 默认分支」的语义要求新鲜度，绝不静默沿用旧镜像。
  if (!mirror.created) {
    fetchMirror(mirror.mirrorDir, source.url, { defaultBranch: probe.defaultBranch });
  }
  // 镜像刚更新过，这里不再联网；分支不存在在 resolveRemoteRef 里被拦成 INVALID_REF
  const tip = resolveRemoteRef(mirror.mirrorDir, source.url, { branch, commitHash: null, fetch: false });
  // 分支名取镜像的 HEAD（不联网）而不是探活的 symref：探活那一路在服务端不发 symref 时回空串，
  // 而镜像是已落盘的事实，回显与后续评测准备必须指向同一个名字
  // （镜像 HEAD 的新鲜度由上面那次 fetchMirror 负责，两条读法在远端肯说的时候是同一个名字）
  const resolvedBranch = branch ?? defaultBranchName(mirror.mirrorDir);
  // 「更新于」一律取**镜像记录**里的那一个：克隆与抓取都会写它，而写失败时的既定后果就是
  // 「回显少一行更新时间」（见 core 的 writeMirrorRecord）——在这一层凭空造一个时间戳会让回显
  // 说出一个谁都没记过的时间
  const fetchedAt = readMirrorRecord(mirror.mirrorDir)?.fetchedAt ?? null;

  log.info('远端仓库校验通过', { url: source.url, branch: resolvedBranch, mirrorDir: mirror.mirrorDir });
  return {
    repoPath: source.url,
    repoName: source.repoName,
    branch: resolvedBranch,
    kind: 'remote',
    mirrorPath: mirror.mirrorDir,
    mirrorReady: true,
    mirrorFetchedAt: fetchedAt,
    tip: tip.slice(0, 7),
  };
}

/** 分支归一：null / undefined / 空串（表单清空拿到的是空串）都表示「不指定分支」 */
export function normalizeBranch(repoBranch: string | null | undefined): string | null {
  if (repoBranch === null || repoBranch === undefined) return null;
  const trimmed = repoBranch.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * 确保远端镜像存在（就绪即复用，**不联网**），回镜像路径。
 * 三个消费方（校验 / 候选 / 保存）共用一处口径。
 * 注意「不联网」是**有条件的**：镜像已就绪时它只做一次本地检查；镜像不存在（或没就绪）时它会
 * `git clone --mirror`——那一步是真的联网、也是真的慢（界面上的 loading 就来自这里）。
 * 所以「候选列表不联网」那条承诺成立的前提是镜像已由校验建好，而不是这个函数本身不上网。
 */
function ensureRemoteMirror(url: string): string {
  return ensureMirror({ workspaceRoot: getSettings().workspaceRoot, url }).mirrorDir;
}

/**
 * commit 候选：本地来源照旧读 HEAD；远端来源从**镜像**读，拿到 tip 之后这一步不联网
 * （`fetch: false`）——镜像在校验仓库时已经更新过。为什么不该联网：候选只是输入框旁边的便利，
 * 为它付一次远端往返不值当，而镜像里已经有一份事实。
 * 唯一的例外是首访：镜像还没建时 `ensureRemoteMirror` 会克隆一次（见它的注释）——那次慢是不可避免的，
 * 但它是**建镜像**，不是为候选列表做的额外往返。
 *
 * 传 `commitHash: null` 是承重的：`fetch: false` 只挡得住「分支 / 默认分支」那两条路，
 * 钉死的 commit 不在镜像里时 `resolveRemoteRef` 仍会抓一次（要判出「确实没有」就只能先抓）。
 * 候选这条路没有「钉死的 commit」这回事，所以固定传 null，`fetch: false` 才等于除首访克隆外不联网。
 *
 * `listCommits` 的 ref 位置拿的是 `resolveRemoteRef` 解析出的 40 位 hash，不是用户填的分支名：
 * 分支名只出现在 `refs/heads/<branch>` 里，裸名会按 git 的 ref 解析顺序命中同名 tag 等别的命名空间。
 */
export function listCommitCandidates(input: { repoPath: string; repoBranch: string | null }): CommitCandidate[] {
  const source = parseRepoSource(input.repoPath);
  const branch = normalizeBranch(input.repoBranch);
  if (source.kind === 'local') {
    // 本地来源的分支一律拒绝（不静默忽略）：用户以为生效了才是最坏的，与 validateRepo 同口径
    if (branch !== null) throw new ServiceError('INVALID_QUERY', `本地目录来源不支持分支：${source.path}`);
    return listCommits(source.path);
  }
  const mirrorDir = ensureRemoteMirror(source.url);
  const tip = resolveRemoteRef(mirrorDir, source.url, { branch, commitHash: null, fetch: false });
  return listCommits(mirrorDir, 20, tip);
}

/**
 * 删掉用例级缓存仓库。**尽力而为**：失败只记 WARN。
 * 缓存目录常常压根不存在（首次评测前），也可能因为 Windows 上文件被占用而删不掉——
 * 两种情形都不该让「删除用例」这个用户动作失败。
 */
function removeCaseCache(caseId: string): void {
  const cacheDir = caseCacheDir(getSettings().workspaceRoot, caseId);
  try {
    rmSync(cacheDir, { recursive: true, force: true });
  } catch (error) {
    log.warn('用例级缓存仓库删除失败（用例已删除，缓存残留）', {
      cacheDir,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * 来源串的归一侧（本地 = 路径、远端 = 去尾斜杠的 URL），它就是「来源到底改没改」的判据。
 * 为什么不直接比 `patch.repoPath.trim() !== current.repoPath`：落盘的来源**已经是归一形态**
 * （见 resolveCaseSource），用户把 `https://host/x.git/` 原样存两次不该算两次改动。
 */
function normalizeSourceString(repoPath: string): string {
  const source = parseRepoSource(repoPath);
  return source.kind === 'local' ? source.path : source.url;
}

/**
 * 落盘前把来源与分支判定成型：本地来源不允许分支；远端来源先确保镜像，
 * 分支判不过时**只 fetch 一次**再判——远端刚推上来的分支不该因为镜像还没更新而被拒
 * （与 ensureCaseCache「先本地判、失败只抓一次」同口径）。
 * 返回的 `repoPath` / `repoBranch` 就是**要落盘的那两个值**：来源去尾斜杠、分支 trim 后为空即 null。
 */
function resolveCaseSource(
  repoPath: string,
  repoBranch: string | null,
): { source: RepoSource; repoPath: string; repoBranch: string | null } {
  const source = parseRepoSource(repoPath);
  const branch = normalizeBranch(repoBranch);
  if (source.kind === 'local') {
    // 本地来源的分支一律拒绝（不静默忽略）：用户以为生效了才是最坏的
    if (branch !== null) throw new ServiceError('INVALID_QUERY', `本地目录来源不支持分支：${source.path}`);
    resolveRepoInfo(source.path);
    return { source, repoPath: source.path, repoBranch: null };
  }
  const mirrorDir = ensureRemoteMirror(source.url);
  try {
    resolveRemoteRef(mirrorDir, source.url, { branch, commitHash: null, fetch: false });
  } catch (error) {
    // 只对「判不过」重试一次：「分支不存在」在镜像没更新与远端真没有之间是同一句话，
    // 判别的唯一办法就是抓一次。其它失败（镜像坏了、远端不可达）保持原样抛，重试只会把同一句话再说一遍。
    if (!(error instanceof ServiceError) || error.code !== 'INVALID_REF') throw error;
    resolveRemoteRef(mirrorDir, source.url, { branch, commitHash: null, fetch: true });
  }
  return { source, repoPath: source.url, repoBranch: branch };
}

/**
 * commit 输入归一化：null / undefined / 空串都表示「默认分支 HEAD」；
 * 其余一律交给 core.assertCommit 判定（不存在 → INVALID_REF），并把短哈希解析成完整 40 位。
 * **不在这里比对候选列表**：候选只是便利，拿它当白名单会把「钉一个更早的提交」变成不可能。
 *
 * 远端来源的 commit 在**镜像**里判（不碰工作区）：镜像里没有时只 fetch 一次再判，
 * 与 resolveCaseSource 处理「刚推上来的分支」同一口径。失败文案点名**远端 URL**——
 * assertCommit 原本的 message 里是镜像路径，会把用户指向一个他从没听说过的目录。
 */
function resolveCommitInput(source: RepoSource, commitHash: string | null | undefined): string | null {
  if (commitHash === null || commitHash === undefined) return null;
  const trimmed = commitHash.trim();
  if (trimmed === '') return null;
  if (source.kind === 'local') return assertCommit(source.path, trimmed);

  const mirrorDir = ensureRemoteMirror(source.url);
  try {
    return assertCommit(mirrorDir, trimmed);
  } catch (error) {
    if (!(error instanceof ServiceError) || error.code !== 'INVALID_REF') throw error;
    fetchMirror(mirrorDir, source.url);
    try {
      return assertCommit(mirrorDir, trimmed);
    } catch {
      // 文案点名**远端 URL**：assertCommit 原本的 message 里是镜像路径，会把用户指向无关的地方
      throw new ServiceError(
        'INVALID_REF',
        `commit 不存在：${trimmed}（远端：${source.url}，已在镜像中执行 git fetch，仍找不到该 commit）`,
        { context: { url: source.url, commit: trimmed, mirrorDir } },
      );
    }
  }
}

/**
 * 落盘前按契约自检：配置文件是所有人共享的真相，写进去的每个用例都必须满足 `TestCaseSchema`
 * **且**评分表通过了业务校验。
 *
 * 为什么业务校验也放在**这里**（而不是 createCase / updateCase 各写一遍）：两处各写一遍必然漂移，
 * 而漂移的症状是「创建时拦得住、编辑时拦不住」。表单那一侧用的是同一份 `validateRubric`，
 * 故界面与后端的判据也只有一份。
 *
 * 为什么必须拦：`RubricSchema` 刻意不设 `.min(1)`（空表是新建用例的真实初态），于是**只靠 schema
 * 拦不住**一张空表 / 一张有组无项的表 / 一张 ID 重复的表——它们全都过得了 `RubricSchema`。
 * 表单那一侧本来就有同一份 `validateRubric`（它拦得住），漏掉的是**不走表单的调用方**：
 * API 直调、脚本、测试夹具。没有这一道，这样的用例在评分阶段才没法评（满分 0），
 * 或者让一次判定被同时记到两项上，而错误会推迟到评测时才暴露，离出错点已经很远。
 * （权重 0 / 负数 / 小数**不在这一层**：那一格由 `RubricSchema` 的 `.positive()` 直接拦下。）
 */
function assertStorable(testCase: TestCase): TestCase {
  const parsed = TestCaseSchema.parse(testCase);
  const checked = validateRubric(parsed.rubric);
  if (!checked.ok) {
    throw new ServiceError('INVALID_QUERY', `评分标准项不合法：${checked.message}`, { context: { message: checked.message } });
  }
  return parsed;
}

/**
 * 用例落盘**之后**：按设置页的「用例变更时自动提交」决定要不要排一次后台同步。
 *
 * 三条刻意的口径：
 *   1. **绝不 await**：保存用例的响应必须立刻返回（用户口径「不阻塞文件保存流程」）。
 *      同步快慢取决于智能体与远端，把它挂在 HTTP 响应上等于让一次保存等几分钟；
 *   2. **开关关掉就什么都不做**：此时变更只在磁盘上，用户到设置页点「提交」才进 git——
 *      状态接口会显示「待提交 N 个」，两态都看得见；
 *   3. 排队的合并与串行由 `case-sync` 内部负责（连续保存只产出一轮同步），这里不判「有没有在跑」。
 */
function scheduleSync(reason: string): void {
  if (!getSettings().casesAutoCommit) return;
  enqueueCaseSync(reason);
}
