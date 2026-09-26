/**
 * 协议兼容性：**判据**与**文案**的唯一出处。
 *
 * 为什么单独一个文件而不是塞进 `registry.ts`：注册表那份文件的职责是「kind → AgentProvider」，
 * 而这里两件东西是**跨包的公共面**——api（创建/编辑校验、候选池过滤）与 evaluator（评分智能体校验、
 * 编排层复检）都要用，且必须是**同一份**。放进注册表文件会让「注册表」这个词同时承担两件事。
 *
 * 三条口径：
 *   1. 判据是 `acceptsProtocol()`，四个消费点一个都不许自己写 `includes`；
 *   2. 文案是 `protocolMismatchMessage()`。它统一之前，api 那处说「协议的**供应商**」、evaluator
 *      两处说「协议的**模型**」，同一条规则在界面上有三种说法——多协议之后第一种说法还会直接说谎
 *      （「只接受 Anthropic 协议」对 DSH 已不成立）；
 *   3. 集合里只有一家时文案保持单数（不写「两种协议」），因为 claude-code / codex 确实只吃一条 wire。
 */
import { PROTOCOL_LABELS, type ProtocolType } from '@aieval/contracts';
import type { AgentProviderMetadata } from './types';

/**
 * 该智能体能不能驱动这个协议的模型。
 *
 * **四个消费点唯一的判据**（A3 的「唯一查询点」）：api 的创建/编辑校验与候选池过滤、
 * evaluator 的评分智能体校验与编排层复检。各自写一遍 `includes` 就是四份会漂移的真源——
 * 而漂移的表现是「界面能选、服务端拒绝」或反过来的假放行，两边都难查。
 */
export function acceptsProtocol(metadata: AgentProviderMetadata, protocolType: ProtocolType): boolean {
  return metadata.protocolTypes.includes(protocolType);
}

/** `protocolMismatchMessage` 的入参：四处的差异只在「被拒绝的对象」与「后续动作」上 */
export interface ProtocolMismatchInput {
  /** 智能体的中文名（`AGENT_LABELS[kind]` / 注册表 `displayName`） */
  agentLabel: string;
  /** 它接受的协议集合（**取自注册表元数据**，不是调用方另写的常量） */
  accepted: readonly ProtocolType[];
  /**
   * 被拒绝的**模型**的一句话描述（必须是名词短语，因为它后面直接接「属于…协议」）：
   * 供应商侧传「供应商「X」的模型」，评分侧传「本次评分用的 <modelId>」。
   */
  subject: string;
  /** 该模型实际所属的协议 */
  actual: ProtocolType;
}

/**
 * 协议不匹配的**统一前缀**文案；调用方只在自己末尾追加「该怎么办」（设置页去向 / 换一个智能体）。
 * 为什么前缀与动作分开：四处的前缀必须逐字一致（否则用户看到的是四种规则），
 * 而「去哪改」本来就不同——api 指供应商配置，评分指「设置 → 评分配置」。
 */
export function protocolMismatchMessage(input: ProtocolMismatchInput): string {
  const labels = input.accepted.map((one) => PROTOCOL_LABELS[one]).join(' / ');
  const scope = input.accepted.length > 1 ? `${labels}两种协议` : `${labels}协议`;
  return `${input.agentLabel} 只接受 ${scope}，而${input.subject}属于${PROTOCOL_LABELS[input.actual]}协议`;
}
