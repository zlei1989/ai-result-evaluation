/**
 * provider 注册表：kind → AgentProvider（A3 的落地点）。
 * 为什么显式静态注册而不是目录扫描：打包后 `readdirSync` 不可靠；注册表同时承载「协议兼容性 /
 * 终止能力 / 隔离级别」元数据，是前端候选池过滤与编排层判断的**唯一**查询点（包内有静态断言
 * 禁止出现目录扫描）。
 * 注意：清单顺序 = `listAgentProviders()` 的顺序 = 前端下拉顺序，必须与 contracts 的 AGENT_KINDS 同序。
 */
import { claudeCodeProvider } from './providers/claude-code';
import { codexProvider } from './providers/codex';
import { dshProvider } from './providers/dsh';
import type { AgentKind, AgentProvider } from './types';

/** 显式静态注册表：加第四家 = 加一个 `providers/<id>/` 目录 + 这里一行，编排层与表单不改（A3） */
const PROVIDERS: readonly AgentProvider[] = [claudeCodeProvider, codexProvider, dshProvider];

const BY_KIND: ReadonlyMap<AgentKind, AgentProvider> = new Map(
  PROVIDERS.map((provider) => [provider.kind, provider] as const),
);

/** 按 kind 解析 provider；未注册的 kind 抛错，错误信息必须含可用清单（§5.6.7） */
export function getProvider(kind: AgentKind): AgentProvider {
  const provider = BY_KIND.get(kind);
  if (provider === undefined) {
    const available = listAgentProviders()
      .map((item) => item.kind)
      .join(' / ');
    throw new Error(`[agents] 未注册的智能体：${String(kind)}；可用清单：${available}`);
  }
  return provider;
}

/** 全部 provider（返回副本：调用方改不到注册表本身） */
export function listAgentProviders(): AgentProvider[] {
  return [...PROVIDERS];
}
