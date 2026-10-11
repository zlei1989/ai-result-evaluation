// @vitest-environment node
/**
 * **真机**：codex 行的 MCP 注入与厂商侧判据。
 *
 * 判据只有一条是硬的：`mcpServer/startupStatus/updated` 到 **`ready`**（codex）。
 * **不验「工具被调用了」**——本机自定义 Responses 网关下那是**上游能力缺口**
 * （`unsupported call`：codex 按命名空间暴露 MCP 工具，而兼容网关转发时把它拍平了，
 * 见契约的 `CODEX_MCP_DISPATCH_GAP_NOTE` 与 `docs/features/mcp-config.md` 的「已知边界与取舍」），
 * **不当作本仓的缺陷**去修。本文件把那一格**如实打出来**
 * （server 侧调用数 + 模型答复），让「缺口仍在」这件事有据可查，而不是靠记忆。
 *
 * 两臂（同一适配器、同一 provider，只有 server 的 command 不同）：
 *   · A 正常 ⇒ 末条 `vendor-system` 里那一台是 `ready`；
 *   · B `command` 指向不存在的二进制（**负例①**）⇒ `failed` + **厂商原文**（行失败文案的后半句）。
 *
 * 落点同时被钉住：`mcp_servers` 走**线程级 `config`**（app-server 协议），
 * `$CODEX_HOME/config.toml` 里**不写** MCP 表——真机 A 臂能到 `ready` 就是这条落点生效的证据。
 *
 * 开关（默认跳过，绝不进内循环与 CI——它会真的起 codex、真的调模型、真的花钱）：
 * ```
 * AIEVAL_LIVE_MCP=1 [AIEVAL_LIVE_MCP_MODEL=GLM-5.3] [AIEVAL_LIVE_MCP_KEEP=1] \
 *   pnpm vitest run packages/server/agents/src/providers/codex/live-mcp.test.ts
 * ```
 * 供应商读**宿主的** `~/.aieval/config.json` 里第一条 `openai`。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '@aieval/contracts';
import { removeTreeWithRetry } from '../../testing/cleanup';
import { codexProvider } from './index';

const ENABLED = process.env['AIEVAL_LIVE_MCP'] === '1';
/** 保留产物目录（`AIEVAL_LIVE_MCP_KEEP=1`）：让人能用 CLI 复核 `$CODEX_HOME` 里到底落了什么 */
const KEEP_ARTIFACTS = process.env['AIEVAL_LIVE_MCP_KEEP'] === '1';
const TIMEOUT_MS = 300_000;

/** 最小 MCP stdio server（与 claude 那条真机探针同源）：一个回显工具 + **把每次 `tools/call` 落盘** */
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
      // PROBE_DELAY_MS：同步晚回 initialize，把「playwright MCP 走 npx 首次要 5-6 s」这件事
      // 搬进探针（C 臂的自变量）。同步等待是因为这里在非 async 的 data 回调里。
      const delay = Number(process.env.PROBE_DELAY_MS ?? 0);
      if (delay > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
      send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'aieval-live-codex', version: '1.0.0' } } });
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

/** 宿主配置里的第一条 openai 供应商（读不到就整组跳过，不让它变成环境性红） */
function hostOpenaiProvider(): { baseUrl: string; apiKey: string; modelId: string } | null {
  try {
    const config = JSON.parse(readFileSync(join(homedir(), '.aieval', 'config.json'), 'utf8')) as {
      providers?: { protocolType?: string; baseUrl?: string; apiKey?: string; models?: { id?: string }[] }[];
    };
    const provider = (config.providers ?? []).find((item) => item.protocolType === 'openai');
    const modelId = process.env['AIEVAL_LIVE_MCP_MODEL'] ?? provider?.models?.[0]?.id;
    if (provider?.baseUrl === undefined || provider.apiKey === undefined || modelId === undefined) return null;
    return { baseUrl: provider.baseUrl, apiKey: provider.apiKey, modelId };
  } catch {
    return null;
  }
}

/** 一条 `vendor-system` 里的 MCP 清单（末条才是「跑完时世界长什么样」，见编排层那条口径） */
function lastMcpServers(events: readonly AgentEvent[]): { name: string | null; status: string | null; error: string | null }[] | null {
  const vendor = events.filter((event) => event.type === 'vendor-system').at(-1);
  return vendor === undefined || vendor.type !== 'vendor-system' ? null : vendor.mcpServers;
}

/**
 * 记录型中转：把 codex 发出的 `/v1/responses` 请求体里 `tools[]` 的**形状**记下来，再逐块转发。
 *
 * 为什么要它：工具表只在**请求体**里看得见，而适配器的事件流没有这一格。判据取「第一条请求」——
 * 这一条探针问的就是「起轮次那一刻工具表里有没有那台 MCP」。
 * 凭据只在转发头里用，不进任何日志与断言。
 */
async function startToolRecorder(upstreamBaseUrl: string): Promise<{
  baseUrl: string;
  requests: { atMs: number; tools: { type: string | null; name: string | null }[] }[];
  close: () => void;
}> {
  const requests: { atMs: number; tools: { type: string | null; name: string | null }[] }[] = [];
  const at0 = Date.now();
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      void (async () => {
        const raw = Buffer.concat(chunks);
        if (raw.length > 0 && String(request.url).includes('/responses')) {
          const body = JSON.parse(raw.toString('utf8')) as { tools?: { type?: string; name?: string }[] };
          requests.push({
            atMs: Date.now() - at0,
            tools: (body.tools ?? []).map((tool) => ({ type: tool.type ?? null, name: tool.name ?? null })),
          });
        }
        const headers = { ...request.headers } as Record<string, string | string[] | undefined>;
        delete headers['host'];
        delete headers['content-length'];
        delete headers['transfer-encoding'];
        // 与 product relay 同一条教训：逐块转发 + 强制不压缩，否则整条流转成一个 blob
        headers['accept-encoding'] = 'identity';
        headers['content-length'] = String(raw.length);
        const upstream = await fetch(`${upstreamBaseUrl.replace(/\/+$/, '')}${String(request.url)}`, {
          method: request.method,
          headers: headers as Record<string, string>,
          body: request.method === 'GET' ? undefined : raw,
        });
        if (upstream.status >= 400) {
          response.writeHead(upstream.status, { 'content-type': 'application/json' });
          response.end(await upstream.text());
          return;
        }
        const outHeaders: Record<string, string> = {};
        upstream.headers.forEach((value, key) => {
          if (key === 'content-encoding' || key === 'content-length' || key === 'transfer-encoding') return;
          outHeaders[key] = value;
        });
        response.writeHead(upstream.status, outHeaders);
        const reader = upstream.body?.getReader();
        if (reader === undefined) {
          response.end();
          return;
        }
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          response.write(value);
        }
        response.end();
      })();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return { baseUrl: `http://127.0.0.1:${port}`, requests, close: () => server.close() };
}

/** 跑一次 codex 候选（两臂共用），返回事件、答复与 server 侧调用数 */
async function runOnce(input: {
  command: string;
  serverPath: string;
  callLog: string;
  route: { baseUrl: string; apiKey: string; modelId: string };
  root: string;
  /** server 的 initialize 晚这么久才回（毫秒）：C 臂用它模拟慢启动 */
  delayMs?: number;
}): Promise<{ events: AgentEvent[]; finalText: string | null; calls: string[] }> {
  const cwd = join(input.root, 'workspace');
  const configHome = join(input.root, '.agenthome');
  mkdirSync(cwd, { recursive: true });
  mkdirSync(configHome, { recursive: true });
  const events: AgentEvent[] = [];
  const controller = new AbortController();
  const result = await codexProvider.run({
    cwd,
    configHome,
    permission: 'full',
    prompt:
      '请调用名为 mcp__probe__probe_echo 的工具，参数 value 传 "hello"，然后只回复工具返回的原文，不要加任何其它字。',
    route: { protocolType: 'openai', ...input.route },
    signal: controller.signal,
    mcpServers: {
      probe: {
        transport: 'stdio',
        enabled: true,
        command: input.command,
        args: [input.serverPath],
        env: {
          PROBE_TOOL: 'probe_echo',
          PROBE_CALL_LOG: input.callLog,
          ...(input.delayMs === undefined ? {} : { PROBE_DELAY_MS: String(input.delayMs) }),
        },
      },
    },
    onEvent: (event) => events.push(event),
  });
  const calls = readFileSync(input.callLog, 'utf8').trim().split('\n').filter(Boolean);
  return { events, finalText: result.finalText, calls };
}

describe.skipIf(!ENABLED)('真机：codex 的 MCP 注入与启动状态判据', () => {
  it('A 臂：正常 server ⇒ 末条厂商事实是 `ready`；B 臂：二进制不存在 ⇒ `failed` + 厂商原文', async () => {
    const live = hostOpenaiProvider();
    if (live === null) {
      // 环境里没有可用的 openai 供应商：如实跳过，而不是用一个假凭据把这条用例跑成红
      console.warn('宿主配置里没有 openai 供应商，跳过真机 codex MCP 探针');
      return;
    }
    const root = mkdtempSync(join(tmpdir(), 'aieval-live-codex-mcp-'));
    const serverPath = join(root, 'echo-server.mjs');
    const callLog = join(root, 'mcp-calls.jsonl');
    writeFileSync(serverPath, ECHO_SERVER_SOURCE, 'utf8');
    writeFileSync(callLog, '', 'utf8');
    try {
      // ── A 臂：正常 server。落点走线程级 config、`$CODEX_HOME/config.toml` 里**不写** MCP 表
      const ok = await runOnce({ command: process.execPath, serverPath, callLog, route: live, root: join(root, 'a') });
      const statuses = ok.events
        .filter((event) => event.type === 'vendor-system')
        .map((event) => (event.type === 'vendor-system' ? event.mcpServers : null));
      console.log('[live-codex-mcp] A 臂启动状态序列：', JSON.stringify(statuses));
      console.log('[live-codex-mcp] A 臂 server 侧调用：', ok.calls.join(' | ') || '(零)');
      console.log('[live-codex-mcp] A 臂模型答复：', String(ok.finalText).slice(0, 200));
      console.log('[live-codex-mcp] A 臂 CODEX_HOME：', existsSync(join(root, 'a', '.agenthome', 'config.toml')) ? '有 config.toml' : '无 config.toml');

      expect(statuses.length).toBeGreaterThan(0);
      // 通道自报（推导据此把 ready 读成「已就绪」），且**末条**才是权威的一份
      const last = ok.events.filter((event) => event.type === 'vendor-system').at(-1);
      expect(last?.type === 'vendor-system' ? last.mcpChannel : null).toBe('vendor-startup-status');
      expect(lastMcpServers(ok.events)).toEqual([
        { name: 'probe', status: 'ready', source: null, error: null },
      ]);

      // ── B 臂（负例①）：`command` 指向不存在的二进制 ⇒ failed + 厂商原文
      const broken = await runOnce({
        command: '/nonexistent/aieval-codex-mcp-missing-binary',
        serverPath,
        callLog,
        route: live,
        root: join(root, 'b'),
      });
      const failed = lastMcpServers(broken.events);
      console.log('[live-codex-mcp] B 臂末条厂商事实：', JSON.stringify(failed));
      console.log('[live-codex-mcp] B 臂答复：', String(broken.finalText).slice(0, 200));
      expect(failed?.[0]?.name).toBe('probe');
      expect(failed?.[0]?.status).toBe('failed');
      // **厂商原文照抄**（行失败文案 `MCP「probe」未能启动：<原文首行>` 的后半句就是它）
      expect(failed?.[0]?.error ?? '').toContain('failed to start');
      expect(failed?.[0]?.error ?? '').toContain('No such file or directory');
    } finally {
      if (KEEP_ARTIFACTS) console.log('[live-codex-mcp] 产物目录（保留，供 CLI 复核）：', root);
      else removeTreeWithRetry(root);
    }
  }, TIMEOUT_MS);

  /**
   * C 臂：server **慢启动**（initialize 晚 4 s）时，第一条模型请求的工具表里也要有它。
   *
   * 为什么这条必须有：工具表随每条请求重算，而 MCP 工具要 server `ready` 之后才进表 ⇒
   * `thread/start` 一回来就 `turn/start` 的话，开局那几轮的请求里没有 `mcp__<name>`，
   * 模型据此断言「当前会话没有暴露 MCP 工具」并整轮退化成 shell（现象与探针见 Codex FAQ
   * 的「当前会话没有暴露 Playwright MCP 工具或资源」条）。单元守卫钉的是**顺序**，
   * 这一条钉的是**真机上工具表真的长出了那一格**。
   */
  it('C 臂：慢启动的 server 也进**第一条**模型请求的工具表', async () => {
    const live = hostOpenaiProvider();
    if (live === null) {
      console.warn('宿主配置里没有 openai 供应商，跳过真机 codex MCP 探针');
      return;
    }
    const root = mkdtempSync(join(tmpdir(), 'aieval-live-codex-mcp-slow-'));
    const serverPath = join(root, 'echo-server.mjs');
    const callLog = join(root, 'mcp-calls.jsonl');
    writeFileSync(serverPath, ECHO_SERVER_SOURCE, 'utf8');
    writeFileSync(callLog, '', 'utf8');
    const recorder = await startToolRecorder(live.baseUrl);
    try {
      await runOnce({
        command: process.execPath,
        serverPath,
        callLog,
        route: { ...live, baseUrl: `${recorder.baseUrl}/v1` },
        root: join(root, 'c'),
        delayMs: 4_000,
      });
      const first = recorder.requests[0];
      console.log('[live-codex-mcp] C 臂请求数：', recorder.requests.length);
      for (const one of recorder.requests) {
        console.log(`[live-codex-mcp] C 臂 @${one.atMs}ms tools=${one.tools.length}`,
          JSON.stringify(one.tools.filter((tool) => tool.type === 'namespace').map((tool) => tool.name)));
      }
      expect(first?.tools.some((tool) => tool.type === 'namespace' && tool.name === 'mcp__probe')).toBe(true);
    } finally {
      recorder.close();
      if (KEEP_ARTIFACTS) console.log('[live-codex-mcp] C 臂产物目录（保留，供 CLI 复核）：', root);
      else removeTreeWithRetry(root);
    }
  }, TIMEOUT_MS);
});
