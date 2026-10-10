/**
 * 用例页的「仓库校验」状态（纯函数）：校验成功后记什么、什么时候还算数、递给 commit 候选 hook 什么。
 *
 * 为什么单独成模块：`apps/web-next` 保留 `jsx: preserve`、不能写 `.tsx` 测试，用例页本身没有测试面
 * （与 `case-panel-state.ts` / `judge-gate.ts` 同一条路子）。这三个决策判错的后果都是**静默的错误信息**：
 *   · 记错分支 ⇒ 回显说「分支：feat/x」而输入框里是别的分支，或候选问的是另一条历史；
 *   · 只比路径不比分支 ⇒ 用户改了分支之后回显与候选都还挂在旧的那一对上（这是它真正会咬人的地方）；
 *   · 失效之后还照旧取候选 ⇒ 下拉里列着**用户已经改掉的**那个来源的提交（那些 hash 在新来源上根本不存在）。
 *
 * 两个口径：
 *   1. 记的是**发出去的那一对**（路径按 trim、空白分支归一成 null），与面板上报的「当前输入」同源——
 *      拿服务端回显的归一路径去比会永远不相等（远端 URL 去掉尾斜杠之后与输入框原文不同），
 *      症状是「校验成功了但回显不出现、候选也取不到」；
 *   2. 「还算数」是**条件**而不是事件：路径与分支都回到校验过的那一对时，校验结果依然成立
 *      （与面板里「回显只在当前输入 == 校验通过的那次值时出现」同口径，用户改回去就能再看到）。
 */

/** 一次「来源选择」：路径 + 分支（`null` = 远端默认分支 / 本地来源没有分支） */
export interface RepoSelection {
  repoPath: string;
  repoBranch: string | null;
}

/**
 * 表单原文 → 归一的选择：路径去两侧空白，空白分支按「没有分支」处理（契约 `min(1).nullable()` 不收空串）。
 * 这既是「校验成功时要记下的那一对」，也是「当前输入」的表示——两边同口径，比较才有意义。
 */
export function normalizeSelection(input: { repoPath: string; repoBranch: string | null }): RepoSelection {
  const branch = (input.repoBranch ?? '').trim();
  return { repoPath: input.repoPath.trim(), repoBranch: branch === '' ? null : branch };
}

/**
 * 上一次校验是否仍然对应当前输入：路径与分支**两项都要**一致。
 * 类型谓词（`validated is RepoSelection`）让调用方在判过之后直接用 `validated`，不必再判一次 null。
 */
export function isValidationCurrent(validated: RepoSelection | null, current: RepoSelection): validated is RepoSelection {
  return validated !== null && validated.repoPath === current.repoPath && validated.repoBranch === current.repoBranch;
}

/**
 * 交给 `useCommitCandidates(repoPath, repoBranch)` 的入参：只有当前输入仍等于校验过的那一对时才取候选，
 * 否则两个都给 `null`（SWR 的 null key = 不发请求）——候选是按「来源 + 分支」取的，留着旧的一对
 * 会让下拉列出一个用户已经改掉的来源 / 分支的提交。
 */
export function candidatesQueryFor(
  validated: RepoSelection | null,
  current: RepoSelection,
): { repoPath: string | null; repoBranch: string | null } {
  return isValidationCurrent(validated, current)
    ? { repoPath: validated.repoPath, repoBranch: validated.repoBranch }
    : { repoPath: null, repoBranch: null };
}
