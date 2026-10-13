// @vitest-environment node
/**
 * 工具白名单的判据是**出站请求本身**——真包 + 本地假网关 + 真 stdio MCP 服务器。
 *
 * 为什么这几条不能交给假 SDK 判：白名单的裁决完全发生在厂商内部（会话装配时把 `tools` 解析成
 * 「哪些工具可以被声明」，连接之后再把 MCP 工具注册进来，两条路的交集才是请求里那份工具表）。
 * 假 SDK 只看得见我们**传进去**的参数，看不见厂商拿它做了什么，于是「传了名单」与「名单生效」
 * 被混为一谈——产品把 MCP 工具滤掉时，假件用例照样绿。
 *
 * 这里因此走完整条真链路：真包起会话 → 真 spawn 一台 stdio MCP 服务器（换行分隔的 JSON-RPC）
 * → 真打一份请求到本地网关 → 直接读那份请求体的工具表。三条不变量逐档钉住：
 *   · 该档该有的工具**在**（`full` 的四件 / `read-only` 的四件）；
 *   · 该档**不该有的**（只读档的 `bash` / `edit` / `write`）**可证不在**；
 *   · MCP 派生名（`mcp__<服务器>__<工具>`）**在**——工具名连接之后才拿得到，故白名单只能给通配。
 *
 * MCP 服务器自己写一份握手日志（`initialize` / `tools/list` 各记一行）：它把「夹具坏了」与
 * 「白名单把工具滤掉了」两种失败分开——前者连 `tools/list` 都不会出现，后者出现了但工具表里没有。
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { McpServers } from '@aieval/contracts';
import { createRunInput } from '../../testing/agent-fixtures';
import { removeTreeWithRetry } from '../../testing/cleanup';
import { startPiGateway, type CapturedPiRequest } from '../../testing/pi-gateway-fixture';
import { piProvider } from '.';

let tempRoot: string;

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'pi-allowlist-'));
});

afterEach(() => {
  removeTreeWithRetry(tempRoot);
});

/**
 * 最小 MCP stdio 服务器：只实现这条链路上会走到的四个方法。
 *
 * 协议形状取自 `@earendil-works/pi-mcp`：一条消息一行 JSON、`initialize` 的结果必须带
 * `protocolVersion` / `capabilities` / `serverInfo`，工具只需 `name` + `inputSchema`。
 * 第 1 个参数是握手日志的路径（用来把夹具故障与白名单故障分开）。
 */
const PROBE_MCP_SERVER = `
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const logPath = process.argv[2];
const mark = (line) => { try { appendFileSync(logPath, line + '\\n'); } catch {} };
const send = (message) => { process.stdout.write(JSON.stringify(message) + '\\n'); };
const TOOLS = [
  { name: 'echo', description: '原样回显', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
];

createInterface({ input: process.stdin }).on('line', (line) => {
  const text = line.trim();
  if (text === '') return;
  let message;
  try { message = JSON.parse(text); } catch { return; }
  if (message.method === 'initialize') {
    mark('initialize');
    const params = message.params ?? {};
    send({ jsonrpc: '2.0', id: message.id, result: {
      protocolVersion: params.protocolVersion ?? '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'probe', version: '1.0.0' },
    } });
    return;
  }
  if (message.method === 'notifications/initialized') { mark('initialized'); return; }
  if (message.method === 'tools/list') {
    mark('tools/list');
    send({ jsonrpc: '2.0', id: message.id, result: { tools: TOOLS } });
    return;
  }
  if (message.method === 'tools/call') {
    mark('tools/call');
    send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'echo' }] } });
    return;
  }
  if (message.id !== undefined) {
    send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'method not found: ' + String(message.method) } });
  }
});
`;

/** 一条出站请求的工具表 + 握手日志（日志用来区分「夹具没起来」与「白名单滤掉了」） */
interface ProbeRow {
  tools: string[];
  handshake: string;
}

/**
 * 跑一行真包：真网关 + 真 stdio MCP 服务器，返回**出站请求体**里的工具表。
 *
 * `maxOutputTokens` 与假网关夹具取同一个数：这里不判档位预算，但要避开「预算塌缩」那条已知边界。
 * 每行一棵自己的行目录——服务器脚本与握手日志都落在里面，共用会让上一行的事实泄漏到下一行。
 */
async function runProbeRow(permission: 'full' | 'read-only'): Promise<ProbeRow> {
  const root = mkdtempSync(join(tempRoot, 'row-'));
  const cwd = join(root, 'workspace');
  const configHome = join(root, '.agenthome');
  mkdirSync(cwd, { recursive: true });
  const serverPath = join(root, 'probe-mcp-server.mjs');
  const handshakePath = join(root, 'handshake.log');
  writeFileSync(serverPath, PROBE_MCP_SERVER, 'utf8');
  writeFileSync(handshakePath, '', 'utf8');

  const seen: CapturedPiRequest[] = [];
  const { server, port } = await startPiGateway(seen);
  try {
    const result = await piProvider.run({
      ...createRunInput({ cwd, configHome }),
      permission,
      prompt: 'say done',
      route: {
        protocolType: 'openai',
        baseUrl: `http://127.0.0.1:${port}/v1`,
        apiKey: 'sk-gateway',
        modelId: 'm1',
        contextWindow: 100_000,
        maxOutputTokens: 32_768,
      },
      mcpServers: {
        probe: { transport: 'stdio', enabled: true, command: process.execPath, args: [serverPath, handshakePath] },
      } satisfies McpServers,
      onEvent: () => {},
    });
    expect(result.ok, result.error?.message).toBe(true);

    const body = seen.at(-1)?.body;
    expect(body, '网关一条请求都没收到').toBeDefined();
    return {
      tools: openaiRequestToolNames(body ?? {}),
      handshake: readFileSync(handshakePath, 'utf8'),
    };
  } finally {
    server.close();
  }
}

/** openai wire 的请求体里声明的工具名（系统段在 `messages[]`、工具名在 `tools[].function.name`） */
function openaiRequestToolNames(body: Record<string, unknown>): string[] {
  const tools = body['tools'];
  if (!Array.isArray(tools)) return [];
  return tools.flatMap((tool) => {
    const fn = (tool as { function?: { name?: unknown } }).function;
    return typeof fn?.name === 'string' ? [fn.name] : [];
  });
}

describe('工具白名单：MCP 派生名进请求，且名单外的工具可证不在', () => {
  it('full 档：默认四件 + MCP 工具都在请求里', async () => {
    const row = await runProbeRow('full');
    // 先证夹具健康：握手走到 tools/list 才说明「MCP 工具进没进请求」是个真问题
    expect(row.handshake, 'probe 服务器没被连上或没列工具，这一条的结论不成立').toContain('tools/list');
    for (const name of ['read', 'bash', 'edit', 'write']) {
      expect(row.tools, `${name} 该在这一档`).toContain(name);
    }
    expect(row.tools, 'MCP 派生名必须进请求（工具名连接后才知道，白名单只能给通配）').toContain('mcp__probe__echo');
    // 通配本身是**选择器**不是工具名：它出现在工具表里就说明厂商把它当成了真工具
    expect(row.tools, '通配是选择器，不是可声明的工具').not.toContain('mcp__*');
  });

  it('read-only 档：四件只读工具 + MCP 工具在，写能力可证不在', async () => {
    const row = await runProbeRow('read-only');
    expect(row.handshake, 'probe 服务器没被连上或没列工具，这一条的结论不成立').toContain('tools/list');
    for (const name of ['read', 'grep', 'find', 'ls']) {
      expect(row.tools, `${name} 该在这一档`).toContain(name);
    }
    // 这一条是「不放宽权限」的守卫：pi 的默认工具集固定含 bash / edit / write，
    // 任何「往默认集里加」的写法都会把它们留在请求里——执行层那道只读闸就没了
    for (const name of ['bash', 'edit', 'write']) {
      expect(row.tools, `${name} 是写能力，只读档不得出现在请求里`).not.toContain(name);
    }
    expect(row.tools).toContain('mcp__probe__echo');
    expect(row.tools, '通配是选择器，不是可声明的工具').not.toContain('mcp__*');
  });
});
