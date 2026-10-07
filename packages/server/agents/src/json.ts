/**
 * 任意负载的窄读取工具。
 * 为什么需要：适配器拿到的事件是 `unknown`（§5.6.2 明确不从厂商包 import type），读之前必须先收窄，
 * 否则整份投影代码都会被 any 与可选链淹没。
 * 注意：这些函数一律**不抛**，读不到就返回 null——事件投影遇到形状意外时必须继续跑完。
 * 「一律」是字面意思：`typeof` 会走 Proxy 的 getPrototypeOf 陷阱、`source[key]` 会触发 getter，
 * 两者都能把异常从这一层冒进适配器主流程，所以探测与取值都包在 try/catch 里（评审 F5）。
 */

/**
 * 收窄成任何**非数组对象**（含 `Date` / `Error` / `Map` 这类类实例）。
 * 为什么不是「只收普通对象」：`errors.ts` 的 `statusOf` 正要在 `Error` 实例上读 `status`，
 * 只认字面量对象会把最常见的形态（错误实例）判成「读不到」。
 */
export function asRecord(value: unknown): Record<string, unknown> | null {
  try {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    // 代理在类型探测上抛错（getPrototypeOf 陷阱）时当「不是对象」，绝不冒给调用方
    return null;
  }
}

/** 读字符串字段；不是字符串（含缺失、含取值抛错）返回 null */
export function readString(source: Record<string, unknown> | null, key: string): string | null {
  const value = readField(source, key);
  return typeof value === 'string' ? value : null;
}

/** 读数值字段；NaN / Infinity / 非数字一律 null（「没采到」靠 null 表达，不靠 0） */
export function readNumber(source: Record<string, unknown> | null, key: string): number | null {
  const value = readField(source, key);
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** 取字段值；getter / Proxy 抛错时当作「没有这个字段」（返回 undefined），不抛 */
function readField(source: Record<string, unknown> | null, key: string): unknown {
  try {
    return source?.[key];
  } catch {
    return undefined;
  }
}
