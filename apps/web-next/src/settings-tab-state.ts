/**
 * 设置页 Tab 的 URL 状态：`?tab=basic|judge|mcp|skills` 的解析与反向构造（纯函数，node 环境可测）。
 *
 * 为什么单独成文件：`apps/web-next` 的 `jsx` 是 `preserve`，该应用里**不能写 .tsx 测试**，
 * 页面里可测的逻辑只能抽成 `.ts`；把「脏 URL 怎么落」抽出来，这条规则才有守卫。
 *
 * Tab 的**唯一真源是 URL**：页面不留本地 Tab 状态（受控 `activeKey` 直接从解析结果来），
 * 于是「刷新后停在同一 Tab」「把某个 Tab 的地址发给别人」都天然成立，也不存在
 * 「界面显示的 Tab 与 URL 各说各话」这一类漂移。
 */
/** 四个 Tab 的 key（与页面 `<Tabs items>` 里的 `key` 一一对应；顺序即导航路径） */
export type SettingsTabKey = 'basic' | 'judge' | 'mcp' | 'skills';

/** 把一个裸字符串（Tab 的 key）收窄成合法的 TabKey；不认识的一律 null */
export function normalizeSettingsTab(raw: string | null): SettingsTabKey | null {
  // 只认小写字面量：URL 查询串区分大小写，宽松匹配会让同一个地址出现两种写法
  if (raw === 'basic' || raw === 'judge' || raw === 'mcp' || raw === 'skills') return raw;
  return null;
}

/**
 * 解析 `?tab=…`：不认识的一律回落 null（= 默认激活第一个 Tab「基础」）。
 *
 * 脏 URL（旧链接、手敲错值、别人发来时 Tab 改过名）不许白屏也不许报错——
 * 回落到默认 Tab 与 antd `Tabs` 不给 `activeKey` 时的行为一致，界面与 URL 各自都有确定含义。
 */
export function parseSettingsTab(search: string | URLSearchParams): SettingsTabKey | null {
  const params = typeof search === 'string' ? new URLSearchParams(search) : search;
  return normalizeSettingsTab(params.get('tab'));
}

/**
 * Tab → URL：null 与 `basic` 都给裸 `/settings`（默认态的规范写法，不保留 `?tab=basic`）。
 *
 * 与《用例》/《评测》两页「无右栏回到裸路径」同一条口径：地址栏里同一个状态只有一种写法，
 * 分享出去才不会出现「?tab=basic 与 ?tab=mcp 之外的第三种默认态」。
 */
export function settingsTabHref(tab: SettingsTabKey | null): string {
  return tab === null || tab === 'basic' ? '/settings' : `/settings?tab=${tab}`;
}
