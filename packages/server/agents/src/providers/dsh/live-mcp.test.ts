// @vitest-environment node
/**
 * **真机**：dsh 行的 MCP 注入与厂商侧判据。
 *
 * 两条判据，缺一不可：
 *   · **硬门槛**：模型**真的调用**了注入的工具，且 **MCP server 侧收到 `tools/call`**
 *     （模型答复不算证据——它可能把预期结果编出来）；
 *   · **唯一判据**：`request/header` 的工具表里有 `mcp__<serverName>__*`。这一家起不来时工具
 *     **静默**从表里消失、会话照常跑完、我们这一侧没有结构化错误
 *     （四臂实测）⇒ 除了工具面没有第二个信号。
 *
 * 两臂：
 *   · A 正常 server ⇒ 工具表里有 `mcp__probe__probe_echo` + server 侧至少一条 `tools/call`；
 *   · B `command` 指向不存在的二进制（**负例①**）⇒ 工具表里**没有**它（行失败归因据此落地）、
 *     而 `turn/end` 照样是 `completed`（「装不上不报错」这件事本身也是证据）。
 *
 * 开关（默认跳过，绝不进内循环与 CI——它会真的起 dsh、真的调模型、真的花钱）：
 * ```
 * AIEVAL_LIVE_MCP=1 [AIEVAL_LIVE_MCP_MODEL=DeepSeek-V4.1-Flash-a] [AIEVAL_LIVE_MCP_KEEP=1] \
 *   pnpm vitest run packages/server/agents/src/providers/dsh/live-mcp.test.ts
 * ```
 * 供应商读**宿主的** `~/.aieval/config.json` 里第一条 `anthropic`（dsh 的 pi-ai 路由走 anthropic-messages）。
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '@aieval/contracts';
import { removeTreeWithRetry } from '../../testing/cleanup';
import { dshProvider } from './index';

const ENABLED = process.env['AIEVAL_LIVE_MCP'] === '1';
/** 保留产物目录（`AIEVAL_LIVE_MCP_KEEP=1`）：让人用 CLI 复核 overlay / 工具表 / 调用记录 */
const KEEP_ARTIFACTS = process.env['AIEVAL_LIVE_MCP_KEEP'] === '1';
const TIMEOUT_MS = 300_000;
const SERVER_NAME = 'probe';

/** 最小 MCP stdio server（与另两家的真机探针同源）：一个回显工具 + **把每次 `tools/call` 落盘** */
const ECHO_SERVER_SOURCE = `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
const TOOL = process.env.PROBE_TOOL ?? 'probe_echo';
const LOG = process.env.PROBE_CALL_LOG;
function send(message) { process.stdout.write(JSON.stringify(message) + '\\n'); }
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  for (let nl; (nl = buffer.indexOf('\\n')) >= 0; ) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (line === '') continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    if (msg.method === 'initialize') {
      send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'aieval-live-dsh', version: '1.0.0' } } });
    } else if (msg.method === 'tools/list') {
      send({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: TOOL, description: '回显给定字符串（真机探针用）', inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] } }] } });
    } else if (msg.method === 'tools/call') {
      if (LOG !== undefined) appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), name: msg.params?.name, args: msg.params?.arguments ?? null }) + '\\n', 'utf8');
      const value = msg.params?.arguments?.value ?? '';
      send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'echo:' + String(value) }], isError: false } });
    } else if (msg.id !== undefined) {
      send({ jsonrpc: '2.0', id: msg.id, result: {} });
    }
  }
});
process.stdin.on('end', () => process.exit(0));
`;

/** 宿主配置里的第一条 anthropic 供应商（读不到就整组跳过，不让它变成环境性红） */
function hostAnthropicProvider(): { baseUrl: string; apiKey: string; modelId: string } | null {
  try {
    const config = JSON.parse(readFileSync(join(homedir(), '.aieval', 'config.json'), 'utf8')) as {
      providers?: { protocolType?: string; baseUrl?: string; apiKey?: string; models?: { id?: string }[] }[];
    };
    const provider = (config.providers ?? []).find((item) => item.protocolType === 'anthropic');
    const modelId = process.env['AIEVAL_LIVE_MCP_MODEL'] ?? provider?.models?.[0]?.id;
    if (provider?.baseUrl === undefined || provider.apiKey === undefined || modelId === undefined) return null;
    return { baseUrl: provider.baseUrl, apiKey: provider.apiKey, modelId };
  } catch {
    return null;
  }
}

/** 工具表里有没有这一台的工具（**唯一判据**）：前缀必须精确到 `mcp__<name>__` */
function toolsShowProbe(events: readonly AgentEvent[]): { seen: string[] | null; hit: boolean } {
  // 取**最后一次**投送的工具表（工具中途出现/消失时以最终态为准；适配器只在变了的时候发）
  const last = events.filter((event) => event.type === 'vendor-system').at(-1);
  const tools = last === undefined || last.type !== 'vendor-system' ? null : last.tools;
  return { seen: tools, hit: tools !== null && tools.some((tool) => tool.startsWith(`mcp__${SERVER_NAME}__`)) };
}

/** 跑一次 dsh 候选（两臂共用） */
async function runOnce(input: {
  command: string;
  serverPath: string;
  callLog: string;
  route: { baseUrl: string; apiKey: string; modelId: string };
  root: string;
}): Promise<{ events: AgentEvent[]; finalText: string | null; calls: string[]; ok: boolean; exitReason: string }> {
  const cwd = join(input.root, 'workspace');
  const configHome = join(input.root, '.agenthome');
  mkdirSync(cwd, { recursive: true });
  mkdirSync(configHome, { recursive: true });
  const events: AgentEvent[] = [];
  const result = await dshProvider.run({
    cwd,
    configHome,
    permission: 'full',
    prompt:
      '请调用名为 mcp__probe__probe_echo 的工具，参数 value 传 "hello"，然后只回复工具返回的原文，不要加任何其它字。',
    route: { protocolType: 'anthropic', ...input.route },
    signal: new AbortController().signal,
    mcpServers: {
      [SERVER_NAME]: {
        transport: 'stdio',
        enabled: true,
        command: input.command,
        args: [input.serverPath],
        env: { PROBE_TOOL: 'probe_echo', PROBE_CALL_LOG: input.callLog },
      },
    },
    onEvent: (event) => events.push(event),
  });
  const calls = readFileSync(input.callLog, 'utf8').trim().split('\n').filter(Boolean);
  return { events, finalText: result.finalText, calls, ok: result.ok, exitReason: result.exitReason };
}

describe.skipIf(!ENABLED)('真机：dsh 的 MCP 注入与工具表判据', () => {
  it('A 臂：工具进表 + 模型真调一次（server 侧有记录）；B 臂：二进制不存在 ⇒ 工具静默消失', async () => {
    const live = hostAnthropicProvider();
    if (live === null) {
      // 环境里没有可用的 anthropic 供应商：如实跳过，而不是用一个假凭据把这条用例跑成红
      console.warn('宿主配置里没有 anthropic 供应商，跳过真机 dsh MCP 探针');
      return;
    }
    const root = mkdtempSync(join(tmpdir(), 'aieval-live-dsh-mcp-'));
    const serverPath = join(root, 'echo-server.mjs');
    const callLog = join(root, 'mcp-calls.jsonl');
    writeFileSync(serverPath, ECHO_SERVER_SOURCE, 'utf8');
    writeFileSync(callLog, '', 'utf8');
    try {
      // ── A 臂：正常 server
      const ok = await runOnce({ command: process.execPath, serverPath, callLog, route: live, root: join(root, 'a') });
      const table = toolsShowProbe(ok.events);
      console.log('[live-dsh-mcp] A 臂工具表（含 mcp__ 的那几项）：', JSON.stringify((table.seen ?? []).filter((t) => t.startsWith('mcp__'))));
      console.log('[live-dsh-mcp] A 臂 server 侧调用：', ok.calls.join(' | ') || '(零)');
      console.log('[live-dsh-mcp] A 臂答复：', String(ok.finalText).slice(0, 200));
      // 通道自报（推导据此把「表里没有它」读成失败）
      const vendor = ok.events.filter((event) => event.type === 'vendor-system');
      expect(vendor.every((event) => event.type === 'vendor-system' && event.mcpChannel === 'vendor-tool-table')).toBe(true);
      // ① 判据：工具进了模型的能力面
      expect(table.seen, 'dsh 没有投送 request/header 的工具表').not.toBeNull();
      expect(table.hit).toBe(true);
      // ② **硬门槛**：MCP server 侧真的收到了 tools/call
      expect(ok.calls.length, `server 侧零调用；回复=${String(ok.finalText).slice(0, 200)}`).toBeGreaterThan(0);
      expect(ok.calls.some((line) => line.includes('probe_echo'))).toBe(true);

      // ── B 臂（负例①）：`command` 指向不存在的二进制
      const broken = await runOnce({
        command: '/nonexistent/aieval-dsh-mcp-missing-binary',
        serverPath,
        callLog,
        route: live,
        root: join(root, 'b'),
      });
      const brokenTable = toolsShowProbe(broken.events);
      console.log('[live-dsh-mcp] B 臂工具表（含 mcp__ 的那几项）：', JSON.stringify((brokenTable.seen ?? []).filter((t) => t.startsWith('mcp__'))));
      console.log('[live-dsh-mcp] B 臂答复：', String(broken.finalText).slice(0, 200));
      console.log('[live-dsh-mcp] B 臂结局：', broken.ok, broken.exitReason);
      // 工具**静默消失**：这正是「表里没有 ⇒ 行失败」这条判据的全部依据
      expect(brokenTable.seen).not.toBeNull();
      expect(brokenTable.hit).toBe(false);
      // 而这一次运行本身**照常跑完**（适配器侧没有结构化错误、`run` 报 ok）——「装不上不报错」也是证据
      //（`end` 事件是编排层发的，不在适配器这一层；行级失败由 `AGENT_MCP_UNAVAILABLE` 收口）
      expect(broken.events.some((event) => event.type === 'error')).toBe(false);
      expect(broken.ok).toBe(true);
      expect(broken.exitReason).toBe('completed');
    } finally {
      if (KEEP_ARTIFACTS) console.log('[live-dsh-mcp] 产物目录（保留，供 CLI 复核）：', root);
      else removeTreeWithRetry(root);
    }
  }, TIMEOUT_MS);
});
