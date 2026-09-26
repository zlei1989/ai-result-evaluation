/**
 * 右栏（详情 / 编辑）该渲染什么：把「URL 里的 panel + 详情取数的四种状态」收成一个纯函数。
 *
 * 为什么要抽出来：`apps/web-next` 保留 `jsx: preserve`、不能写 `.tsx` 测试，用例页本身没有测试面，
 * 而这段分支里最容易写错的一条恰恰是「**取数失败 ≠ 用例不存在**」——
 * 详情请求会因为一次 500 / 网络抖动 / SWR 重验失败而报错，此时手上**还有上一次成功读到的用例**。
 * 把它当成「用例不存在」，既会把一次瞬时故障说成用户操作（「它可能已经被删除」），
 * 又会把正在编辑的表单整个卸载掉——用户敲了几分钟的内容一起没，而页面连一句「你的输入还在」都不给。
 * 所以这里的规则是：**只要还有数据就照旧渲染**（另加一条非破坏性提示），只有真的没有数据时才说「不存在」。
 *
 * 状态机（`panel` 来自 `?panel=`，`testCase` / `caseError` 来自详情请求）：
 *   panel=null               → none（不显示右栏）
 *   panel=new                → new（固定空表单，从不读详情）
 *   其余 panel 但没有 id      → no-selection（链接被手改 / 少了 id 参数）
 *   有 id + 没有数据 + 无错   → loading（首次取数中）
 *   有 id + 没有数据 + 有错   → not-found（确实没有可渲染的数据）
 *   有 id + 有数据 + 有错     → stale（渲染旧数据 + 非破坏性提示）
 *   有 id + 有数据 + 无错     → edit / detail
 */
import type { TestCase } from '@aieval/contracts';

/** 右栏的三种内容（`?panel=` 的合法值） */
export type PanelKind = 'detail' | 'new' | 'edit';

/** 右栏该渲染什么；`stale` / `edit` / `detail` 直接带上要渲染的那条用例，页面不必再判一次 null */
export type CasePanelView =
  | { kind: 'none' }
  | { kind: 'new' }
  | { kind: 'no-selection' }
  | { kind: 'loading' }
  | { kind: 'not-found' }
  /** 详情刷新失败，但上一次的数据还在：按原样渲染（表单不卸载），另加一条非破坏性提示 */
  | { kind: 'stale'; panel: 'detail' | 'edit'; testCase: TestCase }
  | { kind: 'edit'; testCase: TestCase }
  | { kind: 'detail'; testCase: TestCase };

export function resolveCasePanel(input: {
  panel: PanelKind | null;
  id: string | null;
  testCase: TestCase | undefined;
  caseError: unknown;
}): CasePanelView {
  const { panel, id, testCase, caseError } = input;

  if (panel === null) return { kind: 'none' };
  if (panel === 'new') return { kind: 'new' };
  // 有 panel 没有 id：链接可能被人手改过，给一句指路而不是空白右栏
  if (id === null) return { kind: 'no-selection' };

  if (testCase === undefined) {
    // 一次都没取到数据：这时「有错」才等于「不存在」；没拿到错只是请求还在路上
    return caseError != null ? { kind: 'not-found' } : { kind: 'loading' };
  }
  // 数据在手：无论这一轮的取数是不是失败了，都渲染手上这一条（stale 只是多一条提示）
  if (caseError != null) return { kind: 'stale', panel, testCase };
  return panel === 'edit' ? { kind: 'edit', testCase } : { kind: 'detail', testCase };
}
