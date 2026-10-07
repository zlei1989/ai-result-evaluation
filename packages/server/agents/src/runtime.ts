/**
 * 运行时上下文：厂商 SDK 的**测试注入点**（§5.6.6「测试注入点统一为运行时上下文的 sdkModule 字段」）。
 * 形状固定为「包名 → 模块命名空间」的一张表：三家共用一个字段、不另起名字，于是一个假模块表就能
 * 同时喂饱三家，单测因此完全不需要真实厂商包。
 * 注意：注入值**不缓存**（见 load-once.ts）——测试要能在同一进程里从「坏模块」换到「好模块」，
 * 以验证「一次加载失败不会毒化后续运行」。
 */
export interface AgentRuntime {
  sdkModule?: unknown;
}

let current: AgentRuntime = {};

/** 设置注入上下文；传 null 复位（用例结束后必须复位，否则会污染同进程的其他用例） */
export function setAgentRuntimeForTesting(runtime: AgentRuntime | null): void {
  current = runtime ?? {};
}

/** 读取当前注入上下文；生产路径上永远是空对象 */
export function getAgentRuntime(): AgentRuntime {
  return current;
}
