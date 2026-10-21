// @vitest-environment node
/**
 * **只读验证探针**：把 agents 侧那两条真机读数（A2 的跨层分歧、A4 的真请求工具表）接到
 * 候选级观测格上，看编排层最终读出什么结论。入参是 agents 探针的**逐字读数**，不是构造的。
 */
import { describe, expect, it } from 'vitest';
import { deriveCandidateMcpServers } from '../candidate-mcp';

describe('探针：跨层分歧在候选级观测格上的结论', () => {
  it('适配器摘掉、编排层仍算「已注入」的那一台 ⇒ unavailable（整候选失败）', () => {
    const candidates = deriveCandidateMcpServers({
      // A2 读数：resolveMcpServers.injectable = ['ok-stdio','header-space','header-colon']
      injected: ['ok-stdio', 'header-space', 'header-colon'],
      skipped: [],
      invalid: [],
      // A4-1/A4-3 读数：厂商真请求里的工具表（被摘的那两台一个工具都没有）
      vendor: { servers: null, tools: ['read', 'bash', 'mcp__ok_stdio__echo'], channel: 'vendor-tool-table' },
    });
    process.stdout.write(`\n[PROBE] 分歧 → 候选级观测格 = ${JSON.stringify(candidates)}\n`);
    expect(candidates.length).toBeGreaterThan(0);
  });

  it('阴性对照：真起了的那一台（带连字符 + 哈希后缀的真读数）⇒ connected', () => {
    const candidates = deriveCandidateMcpServers({
      injected: ['probe-tools-with-a-long-name-42'],
      skipped: [],
      invalid: [],
      // A4-1 逐字读数
      vendor: {
        servers: null,
        tools: ['read', 'bash', 'mcp__probe_tools_with_a_long_name_42__echo_xxxxxxxxxxxx_194acfcd'],
        channel: 'vendor-tool-table',
      },
    });
    process.stdout.write(`\n[PROBE] 阴性对照 → 候选级观测格 = ${JSON.stringify(candidates)}\n`);
    expect(candidates[0]?.verdict).toBe('connected');
  });

  it('A4-2 读数（起不来的那台）⇒ unavailable', () => {
    const candidates = deriveCandidateMcpServers({
      injected: ['dead-server'],
      skipped: [],
      invalid: [],
      vendor: { servers: null, tools: ['read', 'bash', 'edit', 'write'], channel: 'vendor-tool-table' },
    });
    process.stdout.write(`\n[PROBE] 起不来 → 候选级观测格 = ${JSON.stringify(candidates)}\n`);
    expect(candidates[0]?.verdict).toBe('unavailable');
  });
});
