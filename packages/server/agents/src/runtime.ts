/**
 * 运行时上下文：厂商 SDK 的**测试注入点**（§5.6.7「假体注入走运行时上下文」）。
 * 形状固定为「包名 → 模块命名空间」的一张表：**claude / dsh 用它**（两家都懒加载厂商 SDK）；codex
 * 不走这条路——它不加载厂商 SDK 模块（解析自带可执行文件 + spawn `codex app-server`），假体是
 * `codexProvider.runtimeHooks`（见 `providers/codex/index.ts`）。
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
