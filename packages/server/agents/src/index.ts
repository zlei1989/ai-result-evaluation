/**
 * agents 包公共出口：**只**导出注册表、判据与类型（白名单很窄，下面逐条写明为什么每一格必须在）。
 * `providers/*`、`runtime.ts`、`turn.ts`、`testing/*` 一律不外露：编排层只认 `getProvider`，
 * 三家差异全部被挡在包内（A1）。
 * `acceptsProtocol` 与 `protocolMismatchMessage` 是**判据与文案**，属「注册表投影」的一部分：
 * api 与 evaluator 两处必须读同一份，故必须出现在这个白名单里（否则消费点会各写一份）。
 * `disposeLiveSessions` 是**宿主侧**的停机回收入口（进程收信号时释放本进程在册的在途会话）：
 * 它的消费方在 `apps/web-next/instrumentation.ts`，而 web-next 只到 api 这一层 ⇒ 经 api 转出。
 * 它必须从包出口走：停机那一刻拿不到任何一次 `run()` 的返回值，只有包内那张在册表能找到在途会话。
 * `DEFAULT_ASK_USER_BUDGET_MS` 同理是一条**判据**（提问等待的缺省预算）：端口那一侧（`turn.ts` 建的
 * `AskUserPort`）与实现回调那一侧（编排层）必须用同一个数——两处各写一份必然漂，而漂的表现是
 * 「界面还在等人，端口已经不等了」，两边都不报错。
 * `carrierKeyOf` 是一条**判据**（消息账本的合并键公式）：编排层要往账本里补写一条不是适配器投递的
 * 记录（人工应答的 tool-result），它必须与适配器投递的那些落进同一个键空间——两处各拼一遍必然漂，
 * 而漂的表现是「同一条逻辑消息在账本里出现两份、子任务归属错乱」，不报错也不失败。
 * `ensureV1Suffix` 是一条**判据**（base URL 的 `/v1` 归一化）：智能体侧与 evaluator 的文本通路
 * 必须用同一把尺——两处各拼一遍，同一个供应商地址在「跑智能体」与「评分」上会落到两个端点，
 * 而两边各自自洽、只报上游 404。
 * 注意：编排层若要伪造适配器，请 `vi.mock('@aieval/agents')`，不要伸进包内部——包 exports 也只映射 `.`。
 */
export { getProvider, listAgentProviders } from './registry';
export { acceptsProtocol, protocolMismatchMessage, type ProtocolMismatchInput } from './protocol';
export { ensureV1Suffix } from './route';
export { disposeLiveSessions } from './turn';
export { DEFAULT_ASK_USER_BUDGET_MS } from './ask-user';
/**
 * 人工消息那一面的**等待判据**：缺省预算（`DEFAULT_INJECT_WAIT_BUDGET_MS`）与等待登记口的形状
 * （`InjectionWaitSink`，骨架提供、端口那一侧登记）。与提问哪一条同一条理由必须从包出口走：
 * 编排层要比它**早一秒**把表里等太久的那条收掉（表在编排层），两处各写一个数必然漂。
 */
export { DEFAULT_INJECT_WAIT_BUDGET_MS } from './inject';
export type { InjectionWaitSink } from './inject';
export { carrierKeyOf } from './message';
export {
  AGENT_KINDS,
  type AgentErrorCode,
  type AgentExitReason,
  type AgentKind,
  type AgentPermission,
  type AgentProvider,
  type AgentFork,
  type AgentProviderMetadata,
  type AgentRunInput,
  type AgentRunResult,
  type AskUserReply,
  type AskUserRequest,
  /** 注入面：端口由**编排层实现**、经入参传进来，故它的形状必须出得来（见 `InjectionPort` 的注释） */
  type InjectionPort,
  type ProtocolType,
  type SkillRef,
  /** 端口交出来的那一条消息：实现端口的调用方要按这个形状造它 */
  type UserMessage,
} from './types';
