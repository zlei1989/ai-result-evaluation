/**
 * agents 包公共出口：**只**导出注册表与类型。
 * `providers/*`、`runtime.ts`、`turn.ts`、`testing/*` 一律不外露：编排层只认 `getProvider`，
 * 三家差异全部被挡在包内（A1）。
 * `acceptsProtocol` 与 `protocolMismatchMessage` 是**判据与文案**，属「注册表投影」的一部分：
 * api 与 evaluator 两处必须读同一份，故必须出现在这个白名单里（否则消费点会各写一份）。
 * 注意：编排层若要伪造适配器，请 `vi.mock('@aieval/agents')`，不要伸进包内部——包 exports 也只映射 `.`。
 */
export { getProvider, listAgentProviders } from './registry';
export { acceptsProtocol, protocolMismatchMessage, type ProtocolMismatchInput } from './protocol';
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
} from './types';
