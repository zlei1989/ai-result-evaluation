// @vitest-environment node
/**
 * **真机**：注入的 MCP 工具在这一行里被模型**真的调用**了吗。
 *
 * 判据只有一条是硬的：**MCP server 侧收到了 `tools/call`**（由 echo server 自己落盘）。
 * 模型答复**不算证据**——真机抓到过「MCP 派发失败、模型却把预期结果编出来」
 * （口径见 `docs/features/mcp-config.md` 的「三家的判据通道」）。
 *
 * 与那条**一次性裸 SDK 探针**（`query({options:{mcpServers}})`，不入库）的区别：它证的是
 * 「厂商这条路走得通」；本文件走的是**本仓适配器**
 * （`claudeCodeProvider.run` + `AgentRunInput.mcpServers`），证的是「我们这条链路接对了」——
 * 中间多出来的东西正是这一票要落地的部分：条目翻译（`toClaudeMcpServers`）、
 * 行内 `.npmrc` 的 registry 注入、以及 `vendor-system` 事件里的 `mcp_servers` 归一。
 *
 * 开关（默认跳过，绝不进内循环与 CI——它会真的起 CLI、真的调模型、真的花钱）：
 * ```
 * AIEVAL_LIVE_MCP=1 \
 * [AIEVAL_LIVE_MCP_MODEL=DeepSeek-V4.1-Flash-a] \
 * pnpm vitest run packages/server/agents/src/providers/claude-code/live-mcp.test.ts
 * ```
 * 供应商读**宿主的** `~/.aieval/config.json` 里第一条 `anthropic`（与那两条探针同一个来源）。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '@aieval/contracts';
import { removeTreeWithRetry } from '../../testing/cleanup';
import { claudeCodeProvider } from './index';

const ENABLED = process.env['AIEVAL_LIVE_MCP'] === '1';

/**
 * 保留产物目录（`AIEVAL_LIVE_MCP_KEEP=1`）：让「行 `.agenthome` 里到底落了什么、权限位是多少」
 * 这件事可以用 **CLI** 复核一遍。
 * 默认删掉：探针跑完不留垃圾，而路径会打在日志里供手工复核。
 */
const KEEP_ARTIFACTS = process.env['AIEVAL_LIVE_MCP_KEEP'] === '1';

/**
 * 最小 MCP stdio server：一个回显工具 + **把每一次 `tools/call` 追加落盘**。
 * 为什么内联而不是引一个文件：它要落在临时目录里（CLI 按绝对路径起它），
 * 而 stderr 会被厂商 CLI 吞掉 ⇒ 证据只能写文件。
 */
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
      send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'aieval-live-probe', version: '1.0.0' } } });
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

describe.skipIf(!ENABLED)('真机：注入的 MCP 工具被模型真的调用', () => {
  it('server 侧收到 tools/call + 厂商报 source=dynamic + 行内 .npmrc 落了宿主的 registry', async () => {
    const provider = hostAnthropicProvider();
    if (provider === null) {
      // 环境里没有可用的 anthropic 供应商：如实跳过，而不是用一个假凭据把这条用例跑成红
      console.warn('宿主配置里没有 anthropic 供应商，跳过真机 MCP 探针');
      return;
    }
    const root = mkdtempSync(join(tmpdir(), 'aieval-live-mcp-'));
    const cwd = join(root, 'workspace');
    const configHome = join(root, '.agenthome');
    const serverPath = join(root, 'echo-server.mjs');
    const callLog = join(root, 'mcp-calls.jsonl');
    mkdirSync(cwd, { recursive: true });
    mkdirSync(configHome, { recursive: true });
    writeFileSync(serverPath, ECHO_SERVER_SOURCE, 'utf8');
    writeFileSync(callLog, '', 'utf8');

    const events: AgentEvent[] = [];
    const messages: string[] = [];
    const controller = new AbortController();
    try {
      const result = await claudeCodeProvider.run({
        cwd,
        configHome,
        permission: 'full',
        prompt:
          '请调用名为 mcp__probe__probe_echo 的工具，参数 value 传 "hello"，然后只回复工具返回的原文，不要加任何其它字。',
        route: {
          protocolType: 'anthropic',
          baseUrl: provider.baseUrl,
          apiKey: provider.apiKey,
          modelId: provider.modelId,
        },
        signal: controller.signal,
        mcpServers: {
          probe: {
            transport: 'stdio',
            enabled: true,
            command: process.execPath,
            args: [serverPath],
            env: { PROBE_TOOL: 'probe_echo', PROBE_CALL_LOG: callLog },
          },
        },
        onEvent: (event) => events.push(event),
        onMessage: (message) => messages.push(message.chunk),
      });

      // ① **硬判据**：MCP server 侧真的收到了 tools/call（模型答复一个字都不算证据）
      const calls = readFileSync(callLog, 'utf8').trim().split('\n').filter(Boolean);
      expect(calls.length, `server 侧零调用；finalText=${String(result.finalText).slice(0, 200)}`).toBeGreaterThan(0);
      expect(calls.some((line) => line.includes('probe_echo'))).toBe(true);
      // ② 厂商事件侧：这一台被报成 `source: 'dynamic'`（= 本仓程序化注入，而不是仓库自带）
      const vendor = events.find((event) => event.type === 'vendor-system');
      expect(vendor?.mcpServers?.some((item) => item.name === 'probe' && item.source === 'dynamic')).toBe(true);
      // ③ 工具表里真的出现了它的工具（`connected` 那一档的判据来源）
      expect(vendor?.tools?.some((tool) => tool.startsWith('mcp__probe__'))).toBe(true);
      // ④ 落盘事实：行内 `.npmrc` 复刻了宿主那一行（宿主有 registry 配置时）
      const hostNpmrc = join(homedir(), '.npmrc');
      if (existsSync(hostNpmrc) && /^\s*registry\s*=/im.test(readFileSync(hostNpmrc, 'utf8'))) {
        expect(existsSync(join(configHome, '.npmrc'))).toBe(true);
        expect(readFileSync(join(configHome, '.npmrc'), 'utf8')).toMatch(/^\s*registry\s*=/i);
      }
      // 落盘证据留给报告：调用条数、权限位、厂商原文（排障要看的就是这三样）
      console.log('[live-mcp] server 侧调用记录：', calls.join(' | '));
      console.log('[live-mcp] vendor mcp_servers：', JSON.stringify(vendor?.mcpServers ?? null));
      console.log('[live-mcp] finalText：', String(result.finalText).slice(0, 200));
      if (existsSync(join(configHome, '.npmrc'))) {
        console.log(
          '[live-mcp] 行内 .npmrc：',
          readFileSync(join(configHome, '.npmrc'), 'utf8').trim(),
          '| mode',
          (statSync(join(configHome, '.npmrc')).mode & 0o777).toString(8),
        );
      }
    } finally {
      if (KEEP_ARTIFACTS) console.log('[live-mcp] 产物目录（保留，供 CLI 复核）：', root);
      else removeTreeWithRetry(root);
    }
  }, 300_000);

  /**
   * **对照行**：工作区里**保留仓库自带的 `.mcp.json`**，同时程序化注入一台。
   *
   * 为什么必须有这一行：「不压制仓库自带的 MCP」这条口径，只有在一行**同时**有「我们注入的」
   * 与「仓库自带的」时才证明得了——两支并存、各按自己的来源被厂商报出来（`dynamic` vs
   * `project`），且**仓库那台真的还能被调用**。只测注入那一支（上一条用例）证明不了「没被挤掉」。
   *
   * `.claude/settings.local.json` 里的 `enableAllProjectMcpServers` 是**仓库侧的正常做法**：
   * claude 的项目级 MCP 默认要批准，非交互运行下不批准就不加载——那是 claude 的既有行为，
   * 与本仓「压不压制」无关。不写它，这条用例会红在「项目级根本没加载」上，测不到本仓的口径。
   */
  it('仓库自带 `.mcp.json` 的对照行：注入的（dynamic）与项目级的（project）并存且都能被调用', async () => {
    const provider = hostAnthropicProvider();
    if (provider === null) {
      console.warn('宿主配置里没有 anthropic 供应商，跳过真机 MCP 对照行');
      return;
    }
    const root = mkdtempSync(join(tmpdir(), 'aieval-live-mcp-project-'));
    const cwd = join(root, 'workspace');
    const configHome = join(root, '.agenthome');
    const injectedServer = join(root, 'echo-injected.mjs');
    const projectServer = join(root, 'echo-project.mjs');
    const injectedLog = join(root, 'injected-calls.jsonl');
    const projectLog = join(root, 'project-calls.jsonl');
    mkdirSync(join(cwd, '.claude'), { recursive: true });
    mkdirSync(configHome, { recursive: true });
    writeFileSync(injectedServer, ECHO_SERVER_SOURCE, 'utf8');
    writeFileSync(projectServer, ECHO_SERVER_SOURCE, 'utf8');
    writeFileSync(injectedLog, '', 'utf8');
    writeFileSync(projectLog, '', 'utf8');
    // 仓库自带的项目级 MCP，照 `.mcp.json` 的官方形状落在工作区根
    writeFileSync(
      join(cwd, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          projected: {
            command: process.execPath,
            args: [projectServer],
            env: { PROBE_TOOL: 'project_echo', PROBE_CALL_LOG: projectLog },
          },
        },
      }),
      'utf8',
    );
    writeFileSync(
      join(cwd, '.claude', 'settings.local.json'),
      JSON.stringify({ enableAllProjectMcpServers: true }),
      'utf8',
    );

    const events: AgentEvent[] = [];
    const controller = new AbortController();
    try {
      const result = await claudeCodeProvider.run({
        cwd,
        configHome,
        permission: 'full',
        prompt:
          '请调用名为 mcp__projected__project_echo 的工具，参数 value 传 "project"，然后只回复工具返回的原文，不要加任何其它字。',
        route: {
          protocolType: 'anthropic',
          baseUrl: provider.baseUrl,
          apiKey: provider.apiKey,
          modelId: provider.modelId,
        },
        signal: controller.signal,
        mcpServers: {
          probe: {
            transport: 'stdio',
            enabled: true,
            command: process.execPath,
            args: [injectedServer],
            env: { PROBE_TOOL: 'probe_echo', PROBE_CALL_LOG: injectedLog },
          },
        },
        onEvent: (event) => events.push(event),
        onMessage: () => undefined,
      });

      // ① **硬判据**：仓库那台的 server 侧真的收到了 tools/call（它没被我们挤掉，且真能用）
      const projectCalls = readFileSync(projectLog, 'utf8').trim().split('\n').filter(Boolean);
      expect(
        projectCalls.length,
        `项目级 MCP 零调用；finalText=${String(result.finalText).slice(0, 200)}`,
      ).toBeGreaterThan(0);
      expect(projectCalls.some((line) => line.includes('project_echo'))).toBe(true);
      // ② 厂商侧：两支**并存**，来源各按事实报（我们注入的 `dynamic` / 仓库自带的 `project`）
      const vendor = events.find((event) => event.type === 'vendor-system');
      const servers = vendor?.mcpServers ?? [];
      expect(servers.some((item) => item.name === 'probe' && item.source === 'dynamic')).toBe(true);
      expect(servers.some((item) => item.name === 'projected' && item.source === 'project')).toBe(true);
      // ③ 工具表里两支的工具都在 ⇒ 注入那支没被项目级顶掉（同名才替换，不同名并存）
      expect(vendor?.tools?.some((tool) => tool.startsWith('mcp__probe__'))).toBe(true);
      expect(vendor?.tools?.some((tool) => tool.startsWith('mcp__projected__'))).toBe(true);
      console.log('[live-mcp-project] 项目级 server 侧调用：', projectCalls.join(' | '));
      console.log('[live-mcp-project] vendor mcp_servers：', JSON.stringify(servers));
      console.log('[live-mcp-project] finalText：', String(result.finalText).slice(0, 200));
    } finally {
      if (KEEP_ARTIFACTS) console.log('[live-mcp-project] 产物目录（保留，供 CLI 复核）：', root);
      else removeTreeWithRetry(root);
    }
  }, 300_000);
});
