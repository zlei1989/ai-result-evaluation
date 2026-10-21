// @vitest-environment node
/**
 * **只读验证探针**（不属于产品代码，也不改产品代码）。
 *
 * 真机读数三组：
 *   A. MCP 条目翻译（真 `toPiMcpServers` / `resolveMcpServers` / `deriveCandidateMcpServers` 逐格矩阵）；
 *   A3+. 真适配器 + 真 SDK + 真 stdio 服务器 + 假网关（读厂商真发出去的请求体）。
 *   B. 提问应答面的注册条件与两格提示词落点。
 * 每条结论都配阴性对照。
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveMcpServers, type McpServers } from '@aieval/contracts';
import { createRunInput } from '../../../testing/agent-fixtures';
import { removeTreeWithRetry } from '../../../testing/cleanup';
import {
  anthropicText,
  anthropicToolUse,
  MCP_PROBE_SERVER_SOURCE,
  runPiConformanceCandidate,
  startPiScriptedGateway,
} from '../../../testing/pi-conformance-fixture';
import { piProvider } from '..';
import { PI_ASK_USER_GUIDELINES, PI_ASK_USER_SNIPPET, PI_ASK_USER_TOOL } from '../ask-user';
import { toPiMcpServers } from '../mcp';

function dump(label: string, value: unknown): void {
  process.stdout.write(`\n[PROBE] ${label} = ${JSON.stringify(value)}\n`);
}

function systemText(body: Record<string, unknown>): string {
  const system = body['system'];
  if (typeof system === 'string') return system;
  if (Array.isArray(system)) return system.map((block) => (block as { text?: string }).text ?? '').join('\n');
  return '';
}

// ─────────────────── A. 翻译层逐格矩阵（每条单独跑，一条抛异常不影响其余） ───────────────────

/** 每条入参单独过一遍 `toPiMcpServers`：keep / drop / throw 三态逐条读数 */
function classifyOne(name: string, entry: unknown): string {
  try {
    const result = toPiMcpServers({ [name]: entry } as unknown as McpServers);
    if (result.entries.length > 0) {
      return `KEEP config=${JSON.stringify(result.entries[0]?.config)}`;
    }
    return `DROP reason=${result.dropped[0]?.reason ?? '(无理由)'}`;
  } catch (error) {
    return `THROW ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`;
  }
}

describe('探针 A：canonical → pi 条目（真函数，逐格）', () => {
  it('A1 保留 / 摘除 / 抛异常三态逐格读数（含阴性对照）', () => {
    const cases: Array<[string, unknown]> = [
      // 阴性对照：全字段合法
      ['ok-stdio', { transport: 'stdio', enabled: true, command: '/bin/echo', args: ['a', 'b b'], env: { FOO: 'bar', LOW_case: '1' } }],
      ['ok-http', { transport: 'http', enabled: true, url: 'https://example.com/mcp', headers: { Authorization: 'Bearer t', 'X-Api-Key': 'k' } }],
      ['ok-dash-name', { transport: 'stdio', enabled: true, command: '/bin/echo' }],
      ['ok-no-enabled', { transport: 'stdio', command: '/bin/echo' }],
      // 停用 + 形状坏
      ['disabled-broken', { transport: 'stdio', enabled: false, command: '' }],
      // 坏条目各形态
      ['bad-args-string', { transport: 'stdio', enabled: true, command: '/bin/echo', args: 'nope' }],
      ['bad-args-object', { transport: 'stdio', enabled: true, command: '/bin/echo', args: { a: 1 } }],
      ['bad-args-number', { transport: 'stdio', enabled: true, command: '/bin/echo', args: 7 }],
      ['bad-args-number-item', { transport: 'stdio', enabled: true, command: '/bin/echo', args: ['ok', 7] }],
      ['bad-env-value-number', { transport: 'stdio', enabled: true, command: '/bin/echo', env: { A: 3 } }],
      ['bad-env-value-object', { transport: 'stdio', enabled: true, command: '/bin/echo', env: { A: { n: 1 } } }],
      ['bad-env-key-space', { transport: 'stdio', enabled: true, command: '/bin/echo', env: { 'A B': 'x' } }],
      ['bad-command-placeholder', { transport: 'stdio', enabled: true, command: '${MISSING_BIN}' }],
      ['bad-url-placeholder', { transport: 'http', enabled: true, url: 'https://x/${TOKEN}' }],
      ['bad-header-value-placeholder', { transport: 'http', enabled: true, url: 'https://x', headers: { Authorization: 'Bearer ${TOKEN}' } }],
      ['bad-header-key-colon', { transport: 'http', enabled: true, url: 'https://x', headers: { 'X: Y': 'v' } }],
      ['bad-header-key-space', { transport: 'http', enabled: true, url: 'https://x', headers: { 'X Y': 'v' } }],
      ['bad-header-key-empty', { transport: 'http', enabled: true, url: 'https://x', headers: { '': 'v' } }],
      ['bad-transport', { transport: 'sse', enabled: true, url: 'https://x' }],
      ['bad-missing-transport', { enabled: true, url: 'https://x' }],
      ['bad-not-object', 42],
      ['bad-array-entry', []],
      ['bad-name!', { transport: 'stdio', enabled: true, command: '/bin/echo' }],
      ['bad-url-number', { transport: 'http', enabled: true, url: 7 }],
      ['bad-stdio-missing-command', { transport: 'stdio', enabled: true }],
      ['bad-http-missing-url', { transport: 'http', enabled: true }],
    ];
    for (const [name, entry] of cases) dump(`A1 ${name}`, classifyOne(name, entry));
    expect(cases.length).toBeGreaterThan(0);
  });

  it('A2 契约层与适配器层的判据分歧（同一条走两遍）', () => {
    const raw = {
      'ok-stdio': { transport: 'stdio', enabled: true, command: '/bin/echo', args: ['x'] },
      'header-space': { transport: 'http', enabled: true, url: 'https://example.com/mcp', headers: { 'X Y': 'v' } },
      'header-colon': { transport: 'http', enabled: true, url: 'https://example.com/mcp', headers: { 'X: Y': 'v' } },
      'bad-args-string': { transport: 'stdio', enabled: true, command: '/bin/echo', args: 'nope' },
      'env-unset': { transport: 'stdio', enabled: true, command: '/bin/echo', env: { TOKEN: '${NOT_SET_ANYWHERE}' } },
      'disabled-broken': { transport: 'stdio', enabled: false, command: '' },
    } as unknown as McpServers;
    const resolved = resolveMcpServers(raw, {});
    dump('A2 resolveMcpServers.injectable', Object.keys(resolved.injectable));
    dump('A2 resolveMcpServers.skipped', resolved.skipped);
    dump('A2 resolveMcpServers.invalid', resolved.invalid);
    let adapted: { entries: unknown[]; dropped: unknown[] } | { thrown: string };
    try {
      adapted = toPiMcpServers(resolved.injectable);
    } catch (error) {
      adapted = { thrown: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
    }
    dump('A2 适配器层结果', adapted);
    expect(resolved.injectable).toBeDefined();
  });

});

// ─────────────────── A4. 真适配器：起得来 / 起不来 / 抛异常 ───────────────────

describe('探针 A4：MCP 真注入（真适配器 + 真 stdio 服务器 + 假网关）', () => {
  it('A4-1 起得来：工具进请求表；名字里的连字符改写成下划线；超长工具名带哈希后缀', async () => {
    const factRoot = mkdtempSync(join(tmpdir(), 'pi-probe-facts-'));
    const factPath = join(factRoot, 'facts.json');
    // 服务器名 32 字符（契约上限）+ 连字符；工具名 40 字符 ⇒ 厂商那条「>64 字符加哈希后缀」的分支
    const longServerName = 'probe-tools-with-a-long-name-42';
    const longTool = 'echo_' + 'x'.repeat(35);
    const source = MCP_PROBE_SERVER_SOURCE
      .replace('name: \'echo\'', `name: ${JSON.stringify(longTool)}`)
      .replace(
        'const readline = require(\'node:readline\');',
        `require('node:fs').writeFileSync(${JSON.stringify(factPath)}, JSON.stringify({ argv: process.argv.slice(1),`
          + ' env: { MARK: process.env.MARK }, cwd: process.cwd() }));\n'
          + 'const readline = require(\'node:readline\');',
      );
    const run = await runPiConformanceCandidate({
      script: [anthropicText('接上了。')],
      prompt: '随便说一句。',
      mcpServers: {
        [longServerName]: {
          transport: 'stdio',
          enabled: true,
          command: process.execPath,
          args: ['-e', source, 'ARG_ONE', 'ARG_TWO'],
          env: { MARK: 'mark-value' },
        },
      },
    });
    dump('A4-1 服务器名长度', longServerName.length);
    dump('A4-1 requestTools 里的 mcp 条目', run.requestTools.filter((name) => name.startsWith('mcp__')));
    dump('A4-1 outcome', { ok: run.outcome.ok, exitReason: run.outcome.exitReason, finalText: run.outcome.finalText });
    dump('A4-1 子进程事实（argv / env / cwd 是否真到了）', JSON.parse(readFileSync(factPath, 'utf8')));
    removeTreeWithRetry(factRoot);
  }, 120_000);

  it('A4-2 起不来（命令不存在）：会话照常跑完，事件里没有任何归因', async () => {
    const run = await runPiConformanceCandidate({
      script: [anthropicText('好。')],
      prompt: '随便说一句。',
      mcpServers: { 'dead-server': { transport: 'stdio', enabled: true, command: '/nonexistent/pi-probe-binary-xyz' } },
    });
    const all = JSON.stringify(run.product.events);
    dump('A4-2 requestTools', run.requestTools);
    dump('A4-2 outcome', { ok: run.outcome.ok, exitReason: run.outcome.exitReason, finalText: run.outcome.finalText });
    dump('A4-2 vendor-system tools', run.product.events.filter((e) => e.type === 'vendor-system').map((e) => (e as { tools?: unknown }).tools));
    dump('A4-2 事件里命中 dead-server / attention / failed 的次数', [
      (all.match(/dead-server/g) ?? []).length,
      (all.match(/attention/g) ?? []).length,
      (all.match(/failed/g) ?? []).length,
    ]);
    dump('A4-2 事件类型（去重）', [...new Set(run.product.events.map((e) => e.type))]);
    expect(run.outcome.finalText).toBe('好。');
  }, 120_000);

  it('A4-3 适配器层抛异常时 run 的姿态（args 不是数组）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-probe-throw-'));
    const gateway = await startPiScriptedGateway([anthropicText('好。')]);
    let posture: unknown;
    try {
      const outcome = await piProvider.run({
        ...createRunInput({ cwd: join(root, 'workspace'), configHome: join(root, '.agenthome') }),
        route: {
          protocolType: 'anthropic',
          baseUrl: `http://127.0.0.1:${gateway.port}/v1`,
          apiKey: 'sk-probe',
          modelId: 'm1',
          contextWindow: 100_000,
          maxOutputTokens: 32_768,
        },
        mcpServers: { 'bad-args': { transport: 'stdio', enabled: true, command: process.execPath, args: 'nope' } } as unknown as McpServers,
        onEvent: () => {},
      });
      posture = { resolved: true, ok: outcome.ok, exitReason: outcome.exitReason, finalText: outcome.finalText };
    } catch (error) {
      posture = { resolved: false, thrown: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
    } finally {
      gateway.close();
      removeTreeWithRetry(root);
    }
    dump('A4-3 run 的姿态', posture);
    dump('A4-3 出站请求数（0 = 装配期就断了）', gateway.requests.length);
    expect(posture).toBeDefined();
  }, 120_000);

  it('A4-4 MCP 服务器的 stderr 日志落到哪（PI_CODING_AGENT_DIR 指向临时目录跑）', async () => {
    const agentDir = mkdtempSync(join(tmpdir(), 'pi-probe-agentdir-'));
    const previous = process.env['PI_CODING_AGENT_DIR'];
    process.env['PI_CODING_AGENT_DIR'] = agentDir;
    const stderrSource = MCP_PROBE_SERVER_SOURCE.replace(
      'const readline = require(\'node:readline\');',
      'process.stderr.write(\'probe-server-stderr-marker\\n\');\nconst readline = require(\'node:readline\');',
    );
    try {
      const run = await runPiConformanceCandidate({
        script: [anthropicText('好。')],
        prompt: '随便说一句。',
        mcpServers: { probe: { transport: 'stdio', enabled: true, command: process.execPath, args: ['-e', stderrSource] } },
      });
      dump('A4-4 工具在不在', run.requestTools.filter((name) => name.startsWith('mcp__')));
      let found: unknown = 'no mcp.log in PI_CODING_AGENT_DIR';
      try {
        found = readFileSync(join(agentDir, 'mcp.log'), 'utf8').slice(0, 300);
      } catch { /* 没有这个文件就是读数本身 */ }
      dump('A4-4 PI_CODING_AGENT_DIR 下的 mcp.log', found);
    } finally {
      if (previous === undefined) delete process.env['PI_CODING_AGENT_DIR'];
      else process.env['PI_CODING_AGENT_DIR'] = previous;
      removeTreeWithRetry(agentDir);
    }
  }, 120_000);
});

// ─────────────────── B. 提问应答面 ───────────────────

const ASK_SCRIPT = [
  anthropicToolUse(PI_ASK_USER_TOOL, { questions: [{ header: '选路径', question: '用哪条？', options: [{ label: 'A' }] }] }, 'toolu_ask'),
  anthropicText('按 A 继续。'),
];

describe('探针 B：提问应答面的注册条件与提示词落点', () => {
  it('B1 有应答面 + 全权限：工具进请求表，两格提示词进系统提示词，答复回填', async () => {
    const calls: unknown[] = [];
    const run = await runPiConformanceCandidate({
      script: ASK_SCRIPT,
      prompt: '随便说一句。',
      permission: 'full',
      onAskUser: async (request) => {
        calls.push(request);
        return { outcome: 'answered', answers: [{ header: '选路径', selected: ['A'], custom: null }] };
      },
    });
    const system = systemText(run.requests.at(-1)?.body ?? {});
    dump('B1 requestTools', run.requestTools);
    dump('B1 snippet 在系统提示词里', system.includes(PI_ASK_USER_SNIPPET));
    dump('B1 guidelines 在系统提示词里', PI_ASK_USER_GUIDELINES.map((line) => system.includes(line)));
    dump('B1 端口收到', calls);
    const askDecl = (run.requests.at(-1)?.body['tools'] as Array<{ name: string; input_schema?: unknown }> | undefined)
      ?.find((tool) => tool.name === PI_ASK_USER_TOOL);
    dump('B1 ask_user_question 在出站请求里的 input_schema', askDecl?.input_schema);
    dump('B1 工具结果原文', run.product.messages.flatMap((m) => m.blocks).filter((b) => b.type === 'tool-result').map((b) => (b as { text?: string }).text));
    expect(run.requestTools).toContain(PI_ASK_USER_TOOL);
  }, 120_000);

  it('B2 无应答面（不传 onAskUser）：工具与两格提示词都不在', async () => {
    const run = await runPiConformanceCandidate({ script: [anthropicText('直接答。')], prompt: '随便说一句。', permission: 'full' });
    const system = systemText(run.requests.at(-1)?.body ?? {});
    dump('B2 requestTools', run.requestTools);
    dump('B2 snippet 在系统提示词里', system.includes(PI_ASK_USER_SNIPPET));
    dump('B2 系统提示词里出现 ask_user_question 的次数', (system.match(/ask_user_question/g) ?? []).length);
    expect(run.requestTools).not.toContain(PI_ASK_USER_TOOL);
  }, 120_000);

  it('B3 有应答面 + 只读档：工具不在、端口不被调用', async () => {
    const calls: unknown[] = [];
    const run = await runPiConformanceCandidate({
      script: [anthropicText('只读。')],
      prompt: '随便说一句。',
      permission: 'read-only',
      onAskUser: async (request) => {
        calls.push(request);
        return { outcome: 'answered', answers: null };
      },
    });
    dump('B3 requestTools', run.requestTools);
    dump('B3 端口被调用次数', calls.length);
    dump('B3 snippet 在系统提示词里', systemText(run.requests.at(-1)?.body ?? {}).includes(PI_ASK_USER_SNIPPET));
    expect(run.requestTools).not.toContain(PI_ASK_USER_TOOL);
  }, 120_000);
});
