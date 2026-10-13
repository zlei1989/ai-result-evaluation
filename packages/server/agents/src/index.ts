/**
 * agents 包公共出口：**只**导出注册表与类型。
 * `providers/*`、`runtime.ts`、`turn.ts`、`testing/*` 一律不外露：编排层只认 `getProvider`，
 * 三家差异全部被挡在包内（A1）。
 * `acceptsProtocol` 与 `protocolMismatchMessage` 是**判据与文案**，属「注册表投影」的一部分：
 * api 与 evaluator 两处必须读同一份，故必须出现在这个白名单里（否则消费点会各写一份）。
 * `disposeLiveSessions` 是**宿主侧**的停机回收入口（进程收信号时释放本进程在册的在途会话）：
 * 它的消费方在 `apps/web-next/instrumentation.ts`，而 web-next 只到 api 这一层 ⇒ 经 api 转出。
 * 它必须从包出口走：停机那一刻拿不到任何一次 `run()` 的返回值，只有包内那张在册表能找到在途会话。
 * 注意：编排层若要伪造适配器，请 `vi.mock('@aieval/agents')`，不要伸进包内部——包 exports 也只映射 `.`。
 */
export { getProvider, listAgentProviders } from './registry';
export { acceptsProtocol, protocolMismatchMessage, type ProtocolMismatchInput } from './protocol';
export { disposeLiveSessions } from './turn';
export {
  AGENT_KINDS,
  type AgentErrorCode,
  type AgentExitReason,
  type AgentKind,
  type AgentPermission,
  type AgentProvider,
  type AgentProviderMetadata,
  type AgentRunInput,
  type AgentRunResult,
  type ProtocolType,
  type SkillRef,
} from './types';
