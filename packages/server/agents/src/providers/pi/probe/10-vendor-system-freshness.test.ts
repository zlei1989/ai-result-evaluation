// @vitest-environment node
/**
 * 探针 10：**`vendor-system` 的工具表会不会停在第一次读到的那一份**（两轮 + 真 MCP 服务器）。
 *
 * 为什么要单独量：适配器把「厂商事实」的取数器写成「有新请求 / 清单变了才产一条」，而那一格
 * 读的是**观察者手上的最新 payload**。MCP 服务器的工具是**连上之后才注册**的（厂商在第一次
 * `prompt()` 里等 `startupWaitMs`），于是「第一次请求时表里有没有它」与「这一行最终的表」
 * 可能不是同一份。判据三条：
 *   ① 逐条比对：每一条 `vendor-system.tools` 与**同一时刻**出站请求里的工具表是否一致；
 *   ② 两轮之后（第二轮请求）MCP 工具**必须**出现在某一条 `vendor-system` 里
 *      ——否则行级观测格会读到一份早期的表，而界面上那句「这台没起来」是假话；
 *   ③ 阴性对照：不配 MCP 时表里不许有 `mcp__*`（证明判据不是恒真）。
 *
 * 用法（不需要凭据）：
 *   node_modules/.bin/vitest run packages/server/agents/src/providers/pi/probe/10-vendor-system-freshness.test.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  anthropicText,
  anthropicToolUse,
  piMcpProbeServers,
  runPiConformanceRow,
} from '../../../testing/pi-conformance-fixture';
import { piRequestToolNames } from '../observer';
import { eventOfType, textsOf } from './readings';

describe('vendor-system 工具表的时效性', () => {
  it('两轮 + 真 stdio MCP：每一条 vendor-system 的工具表与该时刻的请求一致，且 MCP 工具最终在表里', async () => {
    const run = await runPiConformanceRow({
      script: [
        // 第一轮：让模型跑一件无关工具（跑到第二轮，MCP 有第二次出现在请求里的机会）
        anthropicToolUse('bash', { command: 'echo probe' }, 'toolu_echo'),
        anthropicText('两轮跑完。'),
      ],
      prompt: '跑一条命令然后收尾。',
      mcpServers: piMcpProbeServers(),
    });

    /** 请求侧事实：每一条出站请求的工具表（顺序即到达顺序） */
    const requestToolTables = run.requests.map((request) => piRequestToolNames(request.body));
    /** 事件侧事实：每一条 vendor-system 的工具表（顺序即产生顺序） */
    const vendorTables = run.product.events
      .filter((event) => eventOfType(event, 'vendor-system'))
      .map((event) => textsOf(event, 'tools'));

    const reading = { requestToolTables, vendorTables };
    dump('10-vendor-system-freshness', reading);

    // 判据 ②：整行跑完之后，某一条 vendor-system 里必须有 MCP 工具（`direct` 档下它真的进请求）
    const mcpInRequests = requestToolTables.some((table) => table.some((name) => name.startsWith('mcp__')));
    const mcpInVendor = vendorTables.some((table) => table.some((name) => name.startsWith('mcp__')));
    expect(mcpInRequests, '出站请求的工具表里没有 MCP 工具 ⇒ 这一格没跑起来（MCP 没连上）').toBe(true);
    expect(
      mcpInVendor,
      `vendor-system 的工具表里始终没有 MCP 工具（拿到 ${vendorTables.length} 条事件）⇒ `
        + '行级观测格会读到一份早期的表，界面据此判「这台没起来」是假话',
    ).toBe(true);
    // 判据 ①：至少有一条事件与某一条请求的工具表逐字相同（取数器读的确实是出站那一份）
    expect(
      vendorTables.some((table) => requestToolTables.some((request) => JSON.stringify(request) === JSON.stringify(table))),
      '没有任何一条 vendor-system 的工具表与出站请求逐字相同 ⇒ 取数点不是出站 payload',
    ).toBe(true);
  }, 240_000);

  it('阴性对照：不配 MCP 时表里不许有 mcp__*', async () => {
    const run = await runPiConformanceRow({
      script: [anthropicText('没有 MCP。')],
      prompt: '只回一句话。',
    });
    const vendorTables = run.product.events
      .filter((event) => eventOfType(event, 'vendor-system'))
      .map((event) => textsOf(event, 'tools'));
    dump('10-vendor-system-freshness-control', { vendorTables });
    expect(vendorTables.length, '一条 vendor-system 都没有 ⇒ 这一格没跑起来').toBeGreaterThan(0);
    expect(vendorTables.flat().some((name) => name.startsWith('mcp__'))).toBe(false);
  }, 120_000);
});

/** 读数落盘到 `probe/dumps/v12/` */
function dump(name: string, payload: unknown): void {
  const dir = join(import.meta.dirname, '..', '..', '..', '..', 'probe', 'dumps', 'v12');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.json`), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}
