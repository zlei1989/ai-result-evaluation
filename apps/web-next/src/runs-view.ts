/**
 * 评测页的 URL 状态解析、列表「标题」列拼法与错误文案（纯函数，node 环境可测）。
 * 为什么单独成文件：`apps/web-next` 的 `jsx` 是 `preserve`，该应用里**不能写 .tsx 测试**，
 * 页面里可测的逻辑只能抽成 `.ts`；把「脏 URL 怎么落」「标题列怎么拼」抽出来，这些规则才有守卫。
 */
import { ServiceError, TERMINAL_ROW_STATUSES, type EvalRun } from '@aieval/contracts';

/**右栏的三种内容（/：同一个栏位换内容，不叠加、不弹层） */
export type RunsPanelKind = 'detail' | 'new' | 'edit';

/**
 * 当前打开的是哪个抽屉（`null` = 都关着）。
 *
 * 行级三视图（日志 / 变更 / 评分）住**同一个抽屉**，故它们不是三个 `kind`，而是同一支里的
 * `tab`：`kind: 'row'` + `rowId` + `tab`。这样切页签只改 `tab`，抽屉的挂载与正文状态都不动
 * ——「关一个、开一个」正是会把滚动位置与折叠态丢掉的那条路。
 * 排名读的是**整轮**（候选之间的名次），没有「哪一行」这一维，故仍是独立的一支。
 *
 * 住在这一层（而不是页面里）是因为它是**可分享状态**的一部分：页面的 `?panel=…&id=…` 与它同源，
 * 两边各写一份形态必然漂移（页面那份判别联合不再被这里的类型约束）。
 */
export type OpenDrawer =
  /**
   * `followUp` 只对日志页签有意义（底部槽换成追问输入区）。它跟着行走：
   * 从「追问」进来的人是带着这一行的上下文来的，切到别的页签时只是不渲染那个槽。
   */
  | { kind: 'row'; rowId: string; tab: 'log' | 'diff' | 'score'; followUp?: boolean }
  | { kind: 'rank' };

export interface RunsPanelState {
  /** null = 不显示右栏（列表占满） */
  panel: RunsPanelKind | null;
  id: string | null;
}

/**
 * 解析 `?panel=detail|new|edit&id=…`。
 * 规则：`new` 忽略 id；`detail` / `edit` 必须带非空 id，否则回落到「不显示右栏」；
 * 未知 `panel` 值按「有 id 就是详情」处理（旧链接/手敲 URL 不至于白屏）。
 * `edit` 必须被**显式**认出来：少了它，`?panel=edit&id=…` 会落到最后那条兜底上当详情渲染
 * （右栏显示的是只读详情，用户以为编辑入口坏了），而这类缺陷两端都不报错。
 */
export function parseRunsPanel(search: string | URLSearchParams): RunsPanelState {
  const params = typeof search === 'string' ? new URLSearchParams(search) : search;
  const rawId = params.get('id');
  const id = rawId === null || rawId === '' ? null : rawId;
  const rawPanel = params.get('panel');

  if (rawPanel === 'new') return { panel: 'new', id: null };
  // detail / edit / 未知面板共用同一条回落：没有 id 就不显示右栏
  if (id === null) return { panel: null, id: null };
  return { panel: rawPanel === 'edit' ? 'edit' : 'detail', id };
}

/** 面板 → URL；panel 为 null 时回到不带查询串的 `/runs`（「无右栏」这一态也可分享） */
export function runsPanelHref(panel: RunsPanelKind | null, id: string | null): string {
  if (panel === null) return '/runs';
  if (panel === 'new') return '/runs?panel=new';
  return id === null ? '/runs' : `/runs?panel=${panel}&id=${encodeURIComponent(id)}`;
}

/** 任意抛出物 → 可直接展示的中文文案（ServiceError 的 message 已是中文，其余不透内部细节） */
export function describeError(error: unknown): string {
  return error instanceof ServiceError ? error.message : '操作失败，请稍后重试';
}

/**
 * 列表「标题」列的显示文本：`用例标题 · 备注`。
 *
 * 三条细则：
 *   · 备注为空 / 纯空白 ⇒ **只显示用例标题**，不留一个尾随的「 · 」（那是肉眼可见的坏形状）；
 *   · 备注首尾空白在显示层也 trim 一次：旧轮次 / 手改过的 `run.json` 不保证经过写侧归一；
 *   · 用例标题为空（手改过的 `run.json`，契约只要求 `z.string()`）⇒ 退回备注，避免显示成「 · 备注」。
 *
 * 为什么抽成纯函数：`apps/web-next` 不能写 `.tsx` 测试（`jsx: preserve`），列表这一格的渲染只能靠
 * 这个函数拿到行为守卫；页面里的显示与排序必须**共用同一份拼法**，否则「看到的」与「排的」会分叉。
 */
export function runListTitle(run: Pick<EvalRun, 'caseTitle' | 'note'>): string {
  const note = run.note.trim();
  if (note === '') return run.caseTitle;
  return run.caseTitle.trim() === '' ? note : `${run.caseTitle} · ${note}`;
}

export interface RunScoreSummary {
  best: number;
  max: number;
  scored: number;
  /** 这一轮的候选总数（含还没跑完的） */
  total: number;
  /** 已经收场却没有分的候选数（失败 / 超时 / 取消 / 跳过 / 中断） */
  unscored: number;
}

/**
 * 列表「得分」列的数据：这一轮里**最高的一行**与它自己的满分。
 *
 * 列表是这个产品做决定的地方（「换不换模型」看的就是这一格），而分数原本只在详情里；
 * 抽成纯函数是为了让「取最高分、满分读快照」这条口径可测——满分不固定 100，
 * 且每一行带的是**评分那一刻**的满分快照（`score.maxScore`），不能拿当前用例的评分表重算。
 *
 * **最高分不是结论**：一轮里两个候选满分、一个超时，最高分仍是 100 —— 故同时给出
 * `scored` / `total` / `unscored`，让列表能如实说「3 个候选里 1 个没出分」。
 * `unscored` 只数**已经收场**的行：还在排队/运行的行没有分是正常态，不是失败。
 *
 * 没有任何一行出分时返回 `null`（列表显示「—」，不显示 0 分：0 分是「评过且全没达成」）。
 */
export function runScoreSummary(run: Pick<EvalRun, 'rows'>): RunScoreSummary | null {
  let best: number | null = null;
  let max = 0;
  let scored = 0;
  for (const row of run.rows) {
    const score = row.score;
    if (score === null || score === undefined) continue;
    scored += 1;
    max = Math.max(max, score.maxScore);
    best = best === null ? score.totalScore : Math.max(best, score.totalScore);
  }
  if (best === null) return null;
  return {
    best,
    max,
    scored,
    total: run.rows.length,
    unscored: run.rows.filter((row) => row.score === null && TERMINAL_ROW_STATUSES.includes(row.status)).length,
  };
}

/**
 * 列表「得分」列的第二个读数：**出分候选的分布**，按分降序，最多列 4 个（其余折成 `+N`）。
 *
 * 为什么不是只给最高分：最高分盖得住失败——`100 / 100` 与「3 个候选里 1 个超时」可以同时成立。
 * 未出分与还在跑的候选**不在这一行重复**：第一行已经用 `2/3 出分` 说了这件事，
 * 这一行只回答「出了分的那些差多少」。
 * 返回 `null` 表示一个候选都没出分（列表整格退回「—」，不拿「…」冒充结论）。
 */
export function runScoreDistribution(run: Pick<EvalRun, 'rows'>): string | null {
  const scored = run.rows.flatMap((row) => (row.score === null ? [] : [row.score.totalScore]));
  if (scored.length === 0) return null;
  scored.sort((left, right) => right - left);
  const shown = scored.slice(0, 4).map(String);
  if (scored.length > 4) shown.push(`+${scored.length - 4}`);
  return shown.join(' · ');
}
