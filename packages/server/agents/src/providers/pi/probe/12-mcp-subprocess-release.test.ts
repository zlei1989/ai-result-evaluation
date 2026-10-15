// @vitest-environment node
/**
 * 探针 12：**跑完一行之后，MCP 的 stdio 子进程还在不在**——释放序列的孤儿进程判据。
 *
 * 为什么值得单开：适配器在释放链里**自己补发**了一次 `session_shutdown`，理由写的是
 * 「厂商把扩展的连接清理挂在这个事件上，而 `AgentSession.dispose()` 不 emit 它」。这一发成不成立，
 * 只有两种结局，而且**都不报错**：成立 ⇒ 子进程被回收；不成立 ⇒ 长驻服务下每跑一行留一个孤儿进程。
 *
 * 与前一支探针（`08-mcp-release`）的差别：那一支手工装配、没有 `prompt()`，MCP 服务器因此
 * **压根没起来**（厂商挂在 `before_agent_start` 上的等待/连接点没被触发）——那次读数是空的。
 * 这一支走**真适配器 + 真 prompt + 真 MCP 扩展**：厂商自己把服务器拉起来，我们只看进程表的结局。
 *
 * 判据三步（缺一步都不算数）：
 *   ① 跑动期：MCP 子进程**起来了**（探针服务器自己把 pid 写进文件）；
 *   ② 收尾后：同一个 pid **不在**了；
 *   ③ 这一行的产物里真有 `mcp__<名>__` 工具（证明那台服务器是被厂商真的接进会话的，
 *      而不是「起都没起所以没有可回收的」）。
 *
 * 用法（不需要凭据）：
 *   node_modules/.bin/vitest run packages/server/agents/src/providers/pi/probe/12-mcp-subprocess-release.test.ts
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { anthropicText, runPiConformanceRow } from '../../../testing/pi-conformance-fixture';
import type { McpServers } from '@aieval/contracts';
import { eventOfType, textsOf } from './readings';

/** 「会写身份证」的 stdio MCP 服务器：启动即把 pid 追加进文件，退出时再写一行 */
function pidServerSource(pidFile: string): string {
  return `
const readline = require('node:readline');
const fs = require('node:fs');
const pidFile = ${JSON.stringify(pidFile)};
const note = (event, extra) => fs.appendFileSync(pidFile, JSON.stringify({ pid: process.pid, event, ...extra }) + '\\n');
note('start', {});
process.on('SIGTERM', () => { note('sigterm', {}); process.exit(0); });
process.on('exit', (code) => note('exit', { code }));
const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  if (line.trim() === '') return;
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    send(message.id, { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'pid-probe', version: '1' } });
    return;
  }
  if (message.method === 'tools/list') {
    send(message.id, { tools: [{ name: 'echo', description: 'echo back', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }] });
    return;
  }
  if (message.id !== undefined) send(message.id, { result: {} });
});
`;
}

/** 进程还在不在（`kill(pid, 0)`；`ESRCH` = 不在了） */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return predicate();
}

/** 读 pid 文件里第一条 `start` 的 pid */
function startedPid(pidFile: string): number | null {
  if (!existsSync(pidFile)) return null;
  for (const line of readFileSync(pidFile, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    const record = JSON.parse(line) as { pid?: number; event?: string };
    if (record.event === 'start' && typeof record.pid === 'number') return record.pid;
  }
  return null;
}

describe('真适配器跑完一行之后：MCP stdio 子进程的结局', () => {
  it('子进程跑动期活着、收尾之后被回收（且这一行真的拿到了它的工具）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-v12-mcprelease-'));
    const pidFile = join(root, 'pids.jsonl');
    let pid: number | null = null;
    try {
      const run = await runPiConformanceRow({
        script: [anthropicText('跑完了。')],
        prompt: '只回一句话。',
        mcpServers: {
          pidprobe: {
            transport: 'stdio',
            enabled: true,
            command: process.execPath,
            args: ['-e', pidServerSource(pidFile)],
          },
        } satisfies McpServers,
      });

      // ③ 这一行真的把那一台接进了会话（工具表里有它）
      const tools = run.requestTools;
      const vendorTools = run.product.events
        .filter((event) => eventOfType(event, 'vendor-system'))
        .flatMap((event) => textsOf(event, 'tools'));
      const sawMcpTool = tools.some((name) => name.startsWith('mcp__pidprobe__'))
        || vendorTools.some((name) => name.startsWith('mcp__pidprobe__'));

      // ① 子进程起来过
      pid = startedPid(pidFile);
      const lines = existsSync(pidFile) ? readFileSync(pidFile, 'utf8').trim().split('\n') : [];
      // ② 收尾之后不在进程表里（给厂商一点收尾时间：dispose 已经跑过，这里只等信号生效）
      const reaped = pid !== null ? await waitFor(() => !alive(pid as number), 10_000) : null;

      dump('12-mcp-subprocess-release', { sawMcpTool, pid, reaped, pidFileLines: lines, tools });
      expect(pid, `MCP 探针服务器没有写 pid 文件（${pidFile}）⇒ 这一格没跑起来`).not.toBeNull();
      expect(sawMcpTool, '这一行的工具表里没有 mcp__pidprobe__* ⇒ 那台没被接进会话').toBe(true);
      expect(reaped, `收尾之后 MCP 子进程 ${pid} 还在进程表里（孤儿进程）`).toBe(true);
    } finally {
      if (pid !== null && alive(pid)) process.kill(pid, 'SIGKILL');
      rmSync(root, { recursive: true, force: true });
    }
  }, 240_000);
});

/** 读数落盘到 `probe/dumps/v12/` */
function dump(name: string, payload: unknown): void {
  const dir = join(import.meta.dirname, '..', '..', '..', '..', 'probe', 'dumps', 'v12');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.json`), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}
