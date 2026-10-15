/**
 * run 焦点：**此刻用户在看着哪一轮**，模块级单例，无需 React 就能设。
 *
 * 为什么需要它：提问浮层挂在应用根（页面壳之外），而「哪一轮正在被看」只存在于 `/runs` 页的
 * 查询参数里——浮层够不着那份状态。焦点因此落成一个不依赖 React 的模块级事实：
 * 页面在右栏选中某一轮时写它，浮层订阅式地读它，于是「切走的 run 的未答提问」可以被**暂缓**
 * （不弹、不取消、仍在挂起表计时）。
 *
 * 两条口径：
 *   · **焦点是「看着哪一轮」，不是「哪一轮在跑」**：离开详情页（列表、别的页面）时复位 `null`，
 *     判据是「有没有在看某一轮」——`null` 表示没有，于是全部提问都可弹（暂缓不是丢弃）；
 *   · **同一个值重复设不通知**：列表页每帧都会用当前选中项调一次，值没变就不该让订阅方重渲染。
 */
import { useSyncExternalStore } from 'react';

/** 当前焦点轮 id；`null` = 没在看某一轮（列表页、别的页面） */
let focusedRunId: string | null = null;

/** 订阅方（`useFocusedRun` 的每个 hook 实例一条）；`Set`：同一个订阅者注册两次只算一次 */
const listeners = new Set<() => void>();

/** 设置焦点轮；`null` 表示离开详情页 */
export function setFocusedRun(runId: string | null): void {
  if (focusedRunId === runId) return;
  focusedRunId = runId;
  // 先复制再遍历：订阅者在回调里退订（组件卸载与本次变更同一拍）是合法用法
  for (const listener of [...listeners]) listener();
}

/** 读当前焦点（`useSyncExternalStore` 的快照函数；服务端渲染时给 `null`，见下面的 getServerSnapshot） */
function getFocusedRun(): string | null {
  return focusedRunId;
}

/** 订阅焦点变更，返回退订函数（`useSyncExternalStore` 的 subscribe） */
function subscribeFocusedRun(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * 订阅式读焦点：供全局提问浮层用（焦点一变就重渲染，于是暂缓 / 重现当场生效）。
 * 服务端渲染没有「用户在看着哪一轮」这回事，快照恒 `null`（与客户端首帧一致，不留水合缺口）。
 */
export function useFocusedRun(): string | null {
  return useSyncExternalStore(subscribeFocusedRun, getFocusedRun, () => null);
}

/** 测试复位：焦点与订阅者清回初始（用例之间不串焦点） */
export function resetRunFocusForTesting(): void {
  focusedRunId = null;
  listeners.clear();
}
