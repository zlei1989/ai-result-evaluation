// @vitest-environment node
/**
 * 探活契约：请求二选一、失败分档的中文结论、成功文案模板与**措辞守卫**。
 *
 * 文案断言刻意对**字面量**（模板），不从实现里推算期望值：
 * 从实现推算出来的期望值永远与实现一致，那种用例证明不了「文案对不对」，只能证明「代码没变」。
 * 「配置可用 / 配置正常」那条是**越界措辞守卫**：这两个词是本功能唯一不能说的话
 * （握手成功证明不了 key、浏览器、行内下载任何一条）。
 */
import { describe, expect, it } from 'vitest';
import {
  MCP_PROBE_FAILURE_LABELS,
  MCP_PROBE_FAILURE_TIERS,
  MCP_PROBE_NOTES,
  MCP_PROBE_TIMEOUT_MS,
  McpProbeRequestSchema,
  McpProbeResultSchema,
  probeSuccessText,
} from './mcp-probe';
import { McpServerConfigSchema } from './mcp';

describe('McpProbeRequestSchema（二选一）', () => {
  it('{name} 走已保存那份；{entry} 走表单当前值', () => {
    expect(McpProbeRequestSchema.parse({ name: 'context7' })).toEqual({ name: 'context7' });
    const parsed = McpProbeRequestSchema.parse({
      entry: { transport: 'stdio', command: 'npx', args: ['-y', '@playwright/mcp@latest'] },
    });
    // `enabled` 缺省 true 由条目 schema 补齐（form 那条路传进来的就是契约形状）
    expect(parsed).toEqual({
      entry: { transport: 'stdio', command: 'npx', args: ['-y', '@playwright/mcp@latest'], enabled: true },
    });
  });

  it('两个都不给、或名字不合规都拒绝', () => {
    expect(McpProbeRequestSchema.safeParse({}).success).toBe(false);
    expect(McpProbeRequestSchema.safeParse({ name: 'my.server' }).success).toBe(false);
    expect(McpProbeRequestSchema.safeParse({ entry: { transport: 'http' } }).success).toBe(false);
  });

  it('同时给两个时以 name 为准（union 的顺序就是优先级，且 zod 默认 strip 掉多余键）', () => {
    const parsed = McpProbeRequestSchema.parse({
      name: 'context7',
      entry: { transport: 'http', url: 'https://example.invalid/mcp' },
    });
    expect(parsed).toEqual({ name: 'context7' });
  });
});

describe('失败分档', () => {
  it('表格的十档逐条在场，中文结论逐字一致', () => {
    // 前十档与表格**逐行**对应（顺序也一致）：判据在 api 层，结论文案在这里。
    // 表外另有两档兜底（非 2xx 的其它状态码、只读调用返回认不出的错误）——没有它们，
    // 那些失败只能塞进一个不准确的档位里，比多两档更坏；这两档单独断言在下面。
    expect([...MCP_PROBE_FAILURE_TIERS].slice(0, 10)).toEqual([
      'spawn',
      'dependency',
      'network',
      'not-found',
      'not-mcp-endpoint',
      'auth',
      'rate-limited',
      'not-mcp',
      'invalid-key',
      'timeout',
    ]);
    expect(MCP_PROBE_FAILURE_LABELS.spawn).toBe('命令无法启动');
    expect(MCP_PROBE_FAILURE_LABELS.dependency).toBe('依赖拉取失败');
    expect(MCP_PROBE_FAILURE_LABELS.network).toBe('域名解析或网络不可达');
    expect(MCP_PROBE_FAILURE_LABELS['not-found']).toBe('端点不存在');
    expect(MCP_PROBE_FAILURE_LABELS['not-mcp-endpoint']).toBe('该地址不是 MCP 端点');
    expect(MCP_PROBE_FAILURE_LABELS.auth).toBe('需要鉴权');
    expect(MCP_PROBE_FAILURE_LABELS['rate-limited']).toBe('被上游限流');
    expect(MCP_PROBE_FAILURE_LABELS['not-mcp']).toBe('响应不是 MCP 协议');
    expect(MCP_PROBE_FAILURE_LABELS['invalid-key']).toBe('API key 无效');
    expect(MCP_PROBE_FAILURE_LABELS.timeout).toBe('超时');
    // 表外的两档：兜底也必须是一句中文结论，不许退回厂商英文原文
    expect(MCP_PROBE_FAILURE_LABELS['http-error']).toBe('端点返回了 HTTP 错误');
    expect(MCP_PROBE_FAILURE_LABELS['tool-call-failed']).toBe('只读调用返回了错误');
  });

  it('每一档都有非空中文结论（表里漏一档时按钮就只剩厂商英文原文）', () => {
    for (const tier of MCP_PROBE_FAILURE_TIERS) {
      expect(MCP_PROBE_FAILURE_LABELS[tier].trim(), tier).not.toBe('');
    }
  });
});

describe('McpProbeResultSchema', () => {
  it('成功形状：档位、服务器自述、工具数、耗时、notes', () => {
    const parsed = McpProbeResultSchema.parse({
      ok: true,
      tier: 'http+call',
      serverName: 'Context7',
      serverVersion: '4.3.0',
      toolCount: 2,
      elapsedMs: 1610,
      notes: [MCP_PROBE_NOTES.npxFirstRun],
    });
    expect(parsed.ok).toBe(true);
    expect(parsed.toolCount).toBe(2);
    expect(parsed.failure).toBeUndefined();
  });

  it('失败形状：failure 三段（档位 / 中文结论 / 厂商原文），成功那几格缺席', () => {
    const parsed = McpProbeResultSchema.parse({
      ok: false,
      tier: 'A',
      elapsedMs: 404,
      failure: {
        tier: 'not-found',
        message: '端点不存在（HTTP 404）',
        vendorText: '{"error":"not_found","message":"Endpoint not found. Use /mcp for MCP protocol communication."}',
      },
      notes: [],
    });
    expect(parsed.failure?.tier).toBe('not-found');
    expect(parsed.failure?.vendorText).toContain('Endpoint not found');
  });

  it('档位只有 A 与 http+call 两种，failure.tier 必须是十档之一', () => {
    expect(McpProbeResultSchema.safeParse({ ok: true, tier: 'B', elapsedMs: 1, notes: [] }).success).toBe(false);
    expect(
      McpProbeResultSchema.safeParse({
        ok: false,
        tier: 'A',
        elapsedMs: 1,
        failure: { tier: 'whatever', message: 'x', vendorText: 'y' },
        notes: [],
      }).success,
    ).toBe(false);
  });
});

describe('超时预算', () => {
  it('http 15 s / stdio 30 s（改它要有新证据）', () => {
    expect(MCP_PROBE_TIMEOUT_MS.http).toBe(15_000);
    expect(MCP_PROBE_TIMEOUT_MS.stdio).toBe(30_000);
  });
});

describe('probeSuccessText', () => {
  it('模板逐字一致：连通：<server> <version>，声明 N 个工具（耗时 X s）', () => {
    expect(
      probeSuccessText({ serverName: 'Context7', serverVersion: '4.3.0', toolCount: 2, elapsedMs: 1610 }),
    ).toBe('连通：Context7 4.3.0，声明 2 个工具（耗时 1.6 s）');
    expect(
      probeSuccessText({ serverName: 'Playwright', serverVersion: '1.64.0', toolCount: 25, elapsedMs: 2807 }),
    ).toBe('连通：Playwright 1.64.0，声明 25 个工具（耗时 2.8 s）');
  });

  it('服务器没自述版本 / 没声明工具数时不留一个空洞（也不编一个数出来）', () => {
    expect(probeSuccessText({ serverName: 'Mystery', toolCount: 0, elapsedMs: 300 })).toBe(
      '连通：Mystery，声明 0 个工具（耗时 0.3 s）',
    );
    expect(probeSuccessText({ elapsedMs: 300 })).toBe('连通：未自述名称，未声明工具数（耗时 0.3 s）');
  });

  /**
   * 措辞守卫：成功文案**永不**出现越界措辞。
   * 覆盖所有分支的组合，而不是只钉一条示例——文案是按分支拼的，只测一条等于只守住一条路径。
   */
  it('永不出现「配置可用 / 配置正常 / 一切正常」这类越界措辞', () => {
    const forbidden = ['配置可用', '配置正常', '一切正常', '可以使用'];
    const cases = [
      probeSuccessText({ serverName: 'Context7', serverVersion: '4.3.0', toolCount: 2, elapsedMs: 1610 }),
      probeSuccessText({ serverName: 'Playwright', serverVersion: '1.64.0', toolCount: 25, elapsedMs: 2807 }),
      probeSuccessText({ serverName: 'Mystery', toolCount: 0, elapsedMs: 300 }),
      probeSuccessText({ elapsedMs: 300 }),
      ...Object.values(MCP_PROBE_NOTES),
    ];
    for (const text of cases) {
      for (const word of forbidden) {
        expect(text, `「${text}」里出现了越界措辞「${word}」`).not.toContain(word);
      }
    }
  });

  it('notes 是「有限判据」的补充说明，不是第二份结论（stdio 那条要点明浏览器通道未校验）', () => {
    expect(MCP_PROBE_NOTES.stdioHandshakeOnly).toContain('只做握手');
    expect(MCP_PROBE_NOTES.npxFirstRun).toBe('候选执行时首次启动还要在本行环境里下载依赖');
    expect(MCP_PROBE_NOTES.disabled).toBe('已停用，不会注入');
  });
});

describe('条目契约与探活契约对得上', () => {
  it('探活请求的 entry 就是设置页存的那份形状（同一把尺，不另起一份）', () => {
    const entry = McpServerConfigSchema.parse({
      transport: 'http',
      url: 'https://mcp.context7.com/mcp',
      headers: { CONTEXT7_API_KEY: '${CONTEXT7_API_KEY}' },
    });
    expect(McpProbeRequestSchema.parse({ entry })).toEqual({ entry });
  });
});
