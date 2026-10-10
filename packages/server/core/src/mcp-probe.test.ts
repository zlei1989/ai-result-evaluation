// @vitest-environment node
/**
 * MCP stdio 探活原语：真子进程上验（不 mock `node:child_process`）。
 *
 * 为什么必须真起进程：这一层的全部价值就在「行协议收帧 + 早退检测 + 超时收尾」三件事上，
 * 而这三件事的错法都是**时序**（监听挂晚了漏掉 exit、只挂 exit 不挂 error 时 ENOENT 直接崩、
 * 收尾没罩住时函数永不返回）。用 mock 验等于把自己的假设抄一遍。
 * 夹具是一个真的会说 MCP 行协议的 node 子进程（`fixtures/`），失败路径用真进程的真行为造：
 * ENOENT 用不存在的命令、早退用 `process.exit(1)`、超时用「收到 initialize 也不回」。
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { McpStdioProbeError, probeMcpStdio } from './mcp-probe';
import { removeTreeWithRetry } from './testing/cleanup';

const created: string[] = [];

/** 造一个临时目录（夹具脚本 / cwd） */
function makeTmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'aieval-mcp-probe-'));
  created.push(dir);
  return dir;
}

/**
 * 把一段脚本落成临时 `.mjs` 并给出「用 node 跑它」的命令行。
 * 用 `process.execPath` 而不是裸 `node`：本仓测试可能在 electron / 带自定义 PATH 的环境里跑，
 * 只有 execPath 保证是**同一个** Node。
 */
function nodeScript(source: string): { command: string; args: string[] } {
  const dir = makeTmp();
  const file = join(dir, 'server.mjs');
  writeFileSync(file, source, 'utf8');
  return { command: process.execPath, args: [file] };
}

/**
 * 会说 MCP 行协议的最小服务端：读一行 → 回一条 → 直到 stdin 关闭。
 * 四种行为由环境变量开关（`PROBE_MODE`），于是同一个夹具覆盖成功 / 早退 / 回非 MCP 的 JSON / 只回噪音。
 * 注意 `garbage` 与 `notmcp` 是**两种不同的失败**：前者一个合法响应都没有（只能等到超时），
 * 后者回了合法 JSON 但不是 MCP（该报「响应不是 MCP 协议」而不是超时）。
 */
const SERVER_SOURCE = `
import { createInterface } from 'node:readline';
const mode = process.env.PROBE_MODE ?? 'ok';
const tag = process.env.PROBE_TAG ?? '';
if (mode === 'exit') { process.stderr.write('boom: cannot start\\n'); process.exit(1); }
// 顽固模式：收了 initialize 也不回，而且**忽略 stdin 的 EOF**（只有信号能杀掉它）。
// 收尾守卫（先关 stdin → SIGTERM → SIGKILL）只有在这种子进程上才验得出来：
// 一个「stdin 一关就自己退」的夹具即使完全不发信号也会死，那条断言就成了永远为真的空断言。
if (mode === 'stubborn') { process.stdin.resume(); setInterval(() => {}, 1000); }
const rl = createInterface({ input: process.stdin });
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\\n');
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (mode === 'silent' || mode === 'stubborn') return;
  if (mode === 'garbage') { process.stdout.write('not json at all\\n'); return; }
  if (mode === 'notmcp') { send({ jsonrpc: '2.0', id: msg.id, result: { ok: true } }); return; }
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: {
      protocolVersion: '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'Fixture', version: '9.9.9' + tag },
    } });
  }
  if (msg.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'a' }, { name: 'b' }, { name: 'c' }] } });
  }
  if (msg.method === 'notifications/initialized') process.stderr.write('initialized noted\\n');
});
`;

afterEach(() => {
  for (const dir of created.splice(0)) removeTreeWithRetry(dir);
});

describe('probeMcpStdio', () => {
  it('三步握手拿回 serverInfo 与工具数，收尾走 stdin-eof（不升级信号）', async () => {
    const server = nodeScript(SERVER_SOURCE);
    const outcome = await probeMcpStdio({ ...server, timeoutMs: 20_000 });

    expect(outcome.serverName).toBe('Fixture');
    expect(outcome.serverVersion).toBe('9.9.9');
    expect(outcome.protocolVersion).toBe('2025-06-18');
    expect(outcome.toolCount).toBe(3);
    // 收尾方式可观察：能自己退的子进程不该被信号打过（打信号会把「服务端自己收尾」这件事抹掉）
    expect(outcome.teardown).toBe('stdin-eof');
    expect(outcome.stderr).toContain('initialized noted');
  });

  it('条目里的 env 追加进子进程环境（合并而不是替换 process.env）', async () => {
    const server = nodeScript(SERVER_SOURCE);
    const outcome = await probeMcpStdio({ ...server, env: { PROBE_TAG: '-tagged' }, timeoutMs: 20_000 });

    expect(outcome.serverVersion).toBe('9.9.9-tagged');
  });

  it('命令不存在 ⇒ spawn 失败（错误里带 ENOENT，不带 stderr）', async () => {
    const error = await probeMcpStdio({ command: 'aieval-definitely-not-a-command', timeoutMs: 5_000 }).catch(
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(McpStdioProbeError);
    expect((error as McpStdioProbeError).kind).toBe('spawn');
    expect((error as McpStdioProbeError).code).toBe('ENOENT');
  });

  it('握手前就退出 ⇒ exited，带上退出码与 stderr 原文（这是「依赖拉取失败」的原始信号）', async () => {
    const server = nodeScript(SERVER_SOURCE);
    const error = await probeMcpStdio({ ...server, env: { PROBE_MODE: 'exit' }, timeoutMs: 20_000 }).catch(
      (thrown: unknown) => thrown,
    );

    expect((error as McpStdioProbeError).kind).toBe('exited');
    expect((error as McpStdioProbeError).code).toBe(1);
    expect((error as McpStdioProbeError).stderr).toContain('boom: cannot start');
  });

  it('回了合法 JSON 但不是 MCP ⇒ protocol（不是超时：有回话，但那不是 MCP）', async () => {
    const server = nodeScript(SERVER_SOURCE);
    const error = await probeMcpStdio({ ...server, env: { PROBE_MODE: 'notmcp' }, timeoutMs: 20_000 }).catch(
      (thrown: unknown) => thrown,
    );

    expect((error as McpStdioProbeError).kind).toBe('protocol');
  });

  it('只回噪音行 ⇒ 噪音被跳过，最终走超时（一行日志不该毁掉整次探活，也不该被当成有效响应）', async () => {
    const server = nodeScript(SERVER_SOURCE);
    const error = await probeMcpStdio({
      ...server,
      env: { PROBE_MODE: 'garbage' },
      timeoutMs: 1_500,
      teardownBudgetMs: 500,
    }).catch((thrown: unknown) => thrown);

    expect((error as McpStdioProbeError).kind).toBe('timeout');
  });

  it('服务端收了 initialize 却不回 ⇒ timeout，且**在超时预算内连收尾一起做完**（顽固子进程也被收掉）', async () => {
    const server = nodeScript(SERVER_SOURCE);
    const started = Date.now();
    const error = await probeMcpStdio({
      ...server,
      // 顽固模式：不回话 + 忽略 stdin EOF ⇒ 只有 SIGTERM / SIGKILL 能收掉它
      env: { PROBE_MODE: 'stubborn' },
      timeoutMs: 1_500,
      // 预算 1.5 s 留给收尾的只有 0.5 s：收尾必须被超时罩住，否则函数会永远挂着
      teardownBudgetMs: 500,
    }).catch((thrown: unknown) => thrown);
    const elapsed = Date.now() - started;

    expect((error as McpStdioProbeError).kind).toBe('timeout');
    expect(elapsed).toBeLessThan(4_000);
    // pid 必须先真的在手上：少了这一条，下面那句会对着 `undefined` 判 —— 一条永远为真的空断言
    const pid = (error as McpStdioProbeError).pid;
    expect(pid).toBeGreaterThan(0);
    // 到点之后进程必须已经被收掉（残留的探活进程会一直占着 npx 与 profile）
    expect(processAlive(pid)).toBe(false);
  });

  it('子进程自己退出得比超时早时走 exited 而不是空等到超时（监听必须挂在 spawn 当刻）', async () => {
    const server = nodeScript('process.stdin.resume(); setTimeout(() => process.exit(7), 120);\n');
    const started = Date.now();
    const error = await probeMcpStdio({ ...server, timeoutMs: 20_000 }).catch((thrown: unknown) => thrown);

    expect((error as McpStdioProbeError).kind).toBe('exited');
    expect((error as McpStdioProbeError).code).toBe(7);
    // 20 s 的预算里 120 ms 就该有结论：空等会把「早退」误报成「超时」
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

/** 进程还在不在：`process.kill(pid, 0)` 不发信号，只做存在性检查 */
function processAlive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
