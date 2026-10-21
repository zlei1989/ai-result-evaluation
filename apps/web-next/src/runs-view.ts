/**
 * 评测页的 URL 状态解析、列表「标题」列拼法与错误文案（纯函数，node 环境可测）。
 * 为什么单独成文件：`apps/web-next` 的 `jsx` 是 `preserve`，该应用里**不能写 .tsx 测试**，
 * 页面里可测的逻辑只能抽成 `.ts`；把「脏 URL 怎么落」「标题列怎么拼」抽出来，这些规则才有守卫。
 */
import { ServiceError, type EvalRun } from '@aieval/contracts';

/**右栏的三种内容（/：同一个栏位换内容，不叠加、不弹层） */
export type RunsPanelKind = 'detail' | 'new' | 'edit';

/**
 * 当前打开的是哪个抽屉（`null` = 都关着）。
 * **判别联合**（不是「kind + 恒有 candidateId」）：三个抽屉读的是**某一行**的产物，而排名读的是**整轮**
 * ——它比的是候选之间的名次，没有「哪一行」这一维。硬塞一个 `candidateId: ''` 会让「按行取快照」凭空
 * 多出一个「空 id 时怎么办」的分支，而那个分支没有意义。
 *
 * 住在这一层（而不是页面里）是因为它是**可分享状态**的一部分：页面的 `?panel=…&id=…` 与它同源，
 * 两边各写一份形态必然漂移（页面那份判别联合不再被这里的类型约束）。
 */
export type OpenDrawer =
  /**
   * `kind: 'log'` 的两支：普通打开（只读执行日志）与**追问**打开（底部槽换成追问输入区）。
   * 用同一支抽屉是因为追问要看着这个候选的上下文写那句话；`followUp` 只影响底部槽渲染哪一块。
   */
  | { kind: 'log'; candidateId: string; followUp?: boolean }
  | { kind: 'diff' | 'score'; candidateId: string }
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
