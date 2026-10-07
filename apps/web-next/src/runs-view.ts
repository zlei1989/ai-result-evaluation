/**
 * 评测页的 URL 状态解析与错误文案（纯函数，node 环境可测）。
 * 为什么单独成文件：`apps/web-next` 的 `jsx` 是 `preserve`，该应用里**不能写 .tsx 测试**，
 * 页面里可测的逻辑只能抽成 `.ts`；把「脏 URL 怎么落」抽出来，这条规则才有守卫。
 */
import { ServiceError } from '@aieval/contracts';

/** 右栏的三种内容（spec §5.3 / §6.3：同一个栏位换内容，不叠加、不弹层） */
export type RunsPanelKind = 'detail' | 'new' | 'edit';

/** 三个产物抽屉 */
export type DrawerKind = 'log' | 'diff' | 'score';

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
