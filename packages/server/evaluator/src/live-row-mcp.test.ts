// @vitest-environment node
/**
 * **真机整行**：一行 claude 候选跑完，注入的 MCP 工具被模型真的调用，且行快照上的
 * 「本行 MCP」观测格如实落盘（端到端）。
 *
 * 与 `agents` 包里那条 `live-mcp.test.ts` 的分工：那条钉的是**适配器**（真 CLI / 真模型 /
 * 真 MCP server，判据是 server 侧 `tools/call`）；本文件钉的是**编排层**——条目从
 * `settings.mcpServers` 出发，经 `resolveMcpServers` → `runRow` → 真实适配器 → 真实的
 * `vendor-system` 事件，最后落成 `EvalRow.mcpServers`。中间任何一环接错，这一格就变了样
 * （少一台、来源不对、判据不对），而**单测里的假适配器不会产生任何厂商事件**——
 * 那一格在单测里只能验到 `unverified`（见 `orchestrator-mcp.test.ts` 的口径说明）。
 *
 * 开关（默认跳过；它会真的起 CLI、真的调模型）：
 * ```
 * AIEVAL_LIVE_ROW_MCP=1 pnpm vitest run packages/server/evaluator/src/live-row-mcp.test.ts
 * ```
 * 供应商读宿主 `~/.aieval/config.json` 的第一条 `anthropic`；**配置目录与用例目录都指到临时目录**
 * （`createTempHome`），绝不碰宿主那份配置。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { EvalRow } from '@aieval/contracts';
import { saveRun, getRun } from './run-store';
import { ROW_RETRY, runRow } from './orchestrator';
import {
  createTempHome,
  initFixtureRepo,
  makeCaseFixture,
  makeProviderFixture,
  makeRowFixture,
  makeRunFixture,
  seedConfig,
  type TempHome,
} from './testing/fixtures';
import { removeTreeWithRetry } from './testing/cleanup';

const ENABLED = process.env['AIEVAL_LIVE_ROW_MCP'] === '1';
const TIMEOUT_MS = 300_000;

/** 最小 MCP stdio server（与 `agents/.../live-mcp.test.ts` 里那份同源）：回显 + 把调用落盘 */
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
      send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'aieval-live-row', version: '1.0.0' } } });
    } else if (msg.method === 'tools/list') {
      send({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: TOOL, description: '回显给定字符串（真机整行探针用）', inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] } }] } });
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

/** 宿主配置里第一条该协议的供应商（读不到返回 `null` ⇒ 整组如实跳过，不变成环境性红） */
function hostProvider(protocolType: 'anthropic' | 'openai', model?: string): { baseUrl: string; apiKey: string; modelId: string } | null {
  try {
    const config = JSON.parse(readFileSync(join(homedir(), '.aieval', 'config.json'), 'utf8')) as {
      providers?: { protocolType?: string; baseUrl?: string; apiKey?: string; models?: { id?: string }[] }[];
    };
    const provider = (config.providers ?? []).find((item) => item.protocolType === protocolType);
    const modelId = model ?? provider?.models?.[0]?.id;
    if (provider?.baseUrl === undefined || provider.apiKey === undefined || modelId === undefined) return null;
    return { baseUrl: provider.baseUrl, apiKey: provider.apiKey, modelId };
  } catch {
    return null;
  }
}

/** 旧名字的别名（上面的 claude 用例用的就是它） */
function hostAnthropicProvider(): { baseUrl: string; apiKey: string; modelId: string } | null {
  return hostProvider('anthropic');
}

let home: TempHome | null = null;
afterEach(() => {
  home?.cleanup();
  home = null;
});

describe.skipIf(!ENABLED)('真机整行：注入的 MCP 工具被调用，观测格如实落盘', () => {
  it('一行 claude 候选：server 侧收到 tools/call，行快照记 connected / dynamic / 厂商工具表', async () => {
    const live = hostAnthropicProvider();
    if (live === null) {
      console.warn('宿主配置里没有 anthropic 供应商，跳过真机整行探针');
      return;
    }
    home = createTempHome();
    const repo = initFixtureRepo(join(home.root, 'repo'));
    const probeDir = mkdtempSync(join(tmpdir(), 'aieval-live-row-mcp-'));
    const serverPath = join(probeDir, 'echo-server.mjs');
    const callLog = join(probeDir, 'mcp-calls.jsonl');
    mkdirSync(probeDir, { recursive: true });
    writeFileSync(serverPath, ECHO_SERVER_SOURCE, 'utf8');
    writeFileSync(callLog, '', 'utf8');

    const provider = makeProviderFixture({
      protocolType: 'anthropic',
      baseUrl: live.baseUrl,
      apiKey: live.apiKey,
      models: [{ id: live.modelId, source: 'manual' }],
    });
    const testCase = makeCaseFixture({
      repoPath: repo.repoPath,
      commitHash: repo.commit,
      // 题面要求**两件事**：把工具返回的原文写进文件（产出 diff，评分才有东西可看）+ 真的调用工具
      taskPrompt:
        '请调用名为 mcp__probe__probe_echo 的工具，参数 value 传 "hello"，然后把它返回的原文写进仓库根目录的 mcp-result.txt。',
    });
    seedConfig({
      workspaceRoot: home.workspaceRoot,
      providers: [provider],
      cases: [testCase],
      // 评分走**真实文本通路**（同一条供应商）：不配评分模型那一行会以「未配置评分模型」收场，
      // 而那是与本题无关的失败面——本探针要看的是候选那一段的观测格
      defaultJudge: { providerId: provider.id, modelId: live.modelId },
      // 注入集：一台 stdio 的 echo server（占位不涉及，故不受宿主环境变量影响）
      mcpServers: {
        probe: {
          transport: 'stdio',
          enabled: true,
          command: process.execPath,
          args: [serverPath],
          env: { PROBE_TOOL: 'probe_echo', PROBE_CALL_LOG: callLog },
        },
      },
    });
    // `modelId` 必须显式给：`makeRowFixture` 的默认值是夹具用的 `test-model`，
    // 真机下它会被网关拒（`There's an issue with the selected model`）——那是夹具的默认值在真机上的形状，
    // 与被测的那条链路无关。
    const row = makeRowFixture({
      agentKind: 'claude-code',
      providerId: provider.id,
      providerName: provider.name,
      baseUrl: provider.baseUrl,
      modelId: live.modelId,
    });
    const run = makeRunFixture({
      workspaceRoot: home.workspaceRoot,
      caseId: testCase.id,
      executionMode: 'parallel',
      rows: [row],
      repoPath: repo.repoPath,
      commitHash: repo.commit,
    });
    saveRun(run);

    // 真机探针**不重试**：瞬时失败重试一次就是再起一遍 CLI、再花一次配额，
    // 而本探针要的是「跑通一次」的证据，重试只会让失败信息变长（默认值见 orchestrator 的 ROW_RETRY）
    const productionRetries = ROW_RETRY.maxRetries;
    ROW_RETRY.maxRetries = 0;
    try {
      await runRow(run.id, row.id);
      const settled = getRun(run.id).rows[0];
      /**
       * ① 硬判据：MCP server 侧真的收到了 `tools/call`（模型答复不算证据）。
       * ② 观测格：`connected` + `vendor-tool-table`（工具表里有 `mcp__probe__*` —— 比厂商自报的
       *    `status` 更硬），来源采信厂商原值 `dynamic`（= 本仓程序化注入，不是仓库自带）。
       */
      const calls = readFileSync(callLog, 'utf8').trim().split('\n').filter(Boolean);
      console.log('[live-row-mcp] 行状态：', settled?.status, '| server 侧调用：', calls.join(' | ') || '(无)');
      console.log('[live-row-mcp] 观测格：', JSON.stringify(settled?.mcpServers ?? null));
      expect(calls.length).toBeGreaterThan(0);
      expect(settled?.mcpServers).toEqual([
        { name: 'probe', source: 'dynamic', judgedBy: 'vendor-tool-table', verdict: 'connected' },
      ]);
    } finally {
      ROW_RETRY.maxRetries = productionRetries;
      removeTreeWithRetry(probeDir);
    }
  }, TIMEOUT_MS);
});

/**
 * **真机整行：三家各一行**。
 *
 * 判据逐家不同，本组把它们放在**同一次运行**里对照：
 *   · **claude**：`system/init` 的 status + **工具表**里有 `mcp__probe__` ⇒ `connected` / 厂商工具表；
 *   · **dsh**：`request/header` 的工具表（唯一判据）⇒ `connected` / 厂商工具表；
 *   · **codex**：`mcpServer/startupStatus: ready` ⇒ `connected` / **厂商启动状态**
 *     ——它的工具**调不动**（上游命名空间缺口），**不当作本仓缺陷**，故对它的硬门槛只到 `ready`。
 * 前两家的硬门槛是**MCP server 侧的 `tools/call` 记录**（模型答复不算证据：它可能把结果编出来）。
 */
describe.skipIf(!ENABLED)('真机整行：三家各一行', () => {
  it('claude / dsh 达硬门槛（server 侧有调用），codex 只验 ready；观测格逐家记对判据来源', async () => {
    const anthropic = hostProvider('anthropic');
    const openai = hostProvider('openai');
    if (anthropic === null || openai === null) {
      console.warn('宿主配置里缺 anthropic / openai 供应商，跳过三家真机整行探针');
      return;
    }
    home = createTempHome();
    const repo = initFixtureRepo(join(home.root, 'repo'));
    const probeDir = mkdtempSync(join(tmpdir(), 'aieval-live-row-3-'));
    const serverPath = join(probeDir, 'echo-server.mjs');
    const callLog = join(probeDir, 'mcp-calls.jsonl');
    mkdirSync(probeDir, { recursive: true });
    writeFileSync(serverPath, ECHO_SERVER_SOURCE, 'utf8');
    writeFileSync(callLog, '', 'utf8');

    const anthropicProvider = makeProviderFixture({
      protocolType: 'anthropic',
      baseUrl: anthropic.baseUrl,
      apiKey: anthropic.apiKey,
      models: [{ id: anthropic.modelId, source: 'manual' }],
    });
    const openaiProvider = makeProviderFixture({
      protocolType: 'openai',
      baseUrl: openai.baseUrl,
      apiKey: openai.apiKey,
      models: [{ id: openai.modelId, source: 'manual' }],
    });
    const testCase = makeCaseFixture({
      repoPath: repo.repoPath,
      commitHash: repo.commit,
      // 题面要求「调用工具 + 把返回原文写进文件」：写文件才有 diff，评分才有东西可看
      taskPrompt:
        '请调用名为 mcp__probe__probe_echo 的工具，参数 value 传 "hello"，然后把它返回的原文写进仓库根目录的 mcp-result.txt。',
    });
    seedConfig({
      workspaceRoot: home.workspaceRoot,
      providers: [anthropicProvider, openaiProvider],
      cases: [testCase],
      defaultJudge: { providerId: anthropicProvider.id, modelId: anthropic.modelId },
      /**
        * 三台，正好覆盖三种形态（负例②与③**在同一次运行里**一起验）：
       *   · `probe`：启用的 stdio，占位不涉及 ⇒ **真的注入**（硬门槛看它）；
       *   · `needs-key`：header 引用了**没有设置**的环境变量 ⇒ **跳过该条 + WARN，行照跑**，
       *     观测格记 `skipped`（它压根没到厂商那儿，只有我们这边的账）；
       *   · `turn-off`：**停用** ⇒ 三家都不写、观测格里连一行都没有（它不是「跳过」）。
       */
      mcpServers: {
        probe: {
          transport: 'stdio',
          enabled: true,
          command: process.execPath,
          args: [serverPath],
          env: { PROBE_TOOL: 'probe_echo', PROBE_CALL_LOG: callLog },
        },
        'needs-key': {
          transport: 'http',
          enabled: true,
          url: 'https://mcp.invalid/mcp',
          headers: { Authorization: 'Bearer ${AIEVAL_MCP_LIVE_MISSING_KEY}' },
        },
        'turn-off': {
          transport: 'http',
          enabled: false,
          url: 'https://mcp.turned-off.invalid/mcp',
        },
      },
    });
    // 每行的 `modelId` 必须显式给（夹具默认的 `test-model` 在真机上会被网关拒，与本题无关）
    const rows = [
      makeRowFixture({
        agentKind: 'claude-code',
        providerId: anthropicProvider.id,
        providerName: anthropicProvider.name,
        baseUrl: anthropicProvider.baseUrl,
        modelId: anthropic.modelId,
      }),
      makeRowFixture({
        agentKind: 'codex',
        providerId: openaiProvider.id,
        providerName: openaiProvider.name,
        baseUrl: openaiProvider.baseUrl,
        modelId: openai.modelId,
      }),
      makeRowFixture({
        agentKind: 'dsh',
        providerId: anthropicProvider.id,
        providerName: anthropicProvider.name,
        baseUrl: anthropicProvider.baseUrl,
        modelId: anthropic.modelId,
      }),
    ];
    const run = makeRunFixture({
      workspaceRoot: home.workspaceRoot,
      caseId: testCase.id,
      executionMode: 'parallel',
      rows,
      repoPath: repo.repoPath,
      commitHash: repo.commit,
    });
    saveRun(run);

    // 逐个跑（一行一次真 CLI + 一次评分）：真机探针**不重试**（重试一次就是再起一遍 CLI、再花一次配额）
    const productionRetries = ROW_RETRY.maxRetries;
    ROW_RETRY.maxRetries = 0;
    try {
      for (const row of rows) {
        await runRow(run.id, row.id);
      }
      const settled = getRun(run.id).rows;
      const calls = readFileSync(callLog, 'utf8').trim().split('\n').filter(Boolean);
      for (const row of settled) {
        console.log(`[live-row-3] ${row.agentKind}：status=${row.status} mcp=${JSON.stringify(row.mcpServers)}`);
      }
      console.log('[live-row-3] server 侧调用：', calls.join(' | ') || '(无)');

      const of = (kind: string): EvalRow['mcpServers'] => settled.find((row) => row.agentKind === kind)?.mcpServers;
      /**
       * **负例②（真机）**：环境变量没设的那一台在三家都记 `skipped`，而**行照跑**（上面三行全是 `judged`）。
       * **负例③（真机）**：停用的那一台在观测格里**一行都没有**——它不是「跳过」，是「用户关了」。
       */
      for (const row of settled) {
        expect(row.mcpServers?.map((entry) => entry.name), `${row.agentKind} 那一行的观测格台数`).toEqual([
          'probe',
          'needs-key',
        ]);
        expect(row.mcpServers?.[1]).toMatchObject({ name: 'needs-key', judgedBy: 'none', verdict: 'skipped' });
        expect(row.status).toBe('judged');
      }
      /**
       * **负例③的落盘证据**（dsh 是三家唯一真写注入文件的那一家）：
       * overlay 里有启用那台的插件行，**没有**停用那台的——`insert` 是整份重建的，别把停用的也写进去。
       * 另两家**没有注入文件**可查：claude 走 SDK 参数、codex 走线程级 `config`（都在进程内），
       * 它们的「没注入」由 `mcp.test.ts` 的翻译器守卫与 `orchestrator-mcp.test.ts` 的入参守卫钉住。
       */
      const dshRow = settled.find((row) => row.agentKind === 'dsh');
      const overlayPath = join(run.workspaceBase, run.id, 'rows', dshRow?.id ?? '', '.agenthome', 'aieval-route.patch.yml');
      if (existsSync(overlayPath)) {
        const overlay = readFileSync(overlayPath, 'utf8');
        expect(overlay).toContain('- id: mcp-probe');
        expect(overlay).not.toContain('mcp-turn-off');
        expect(overlay).not.toContain('turn-off');
      }
      // claude 与 dsh：判据取**厂商工具表**（工具真的进了会话）。
      // 来源那一格两家不同，而且**必须不同**：claude 的 `system/init` 真的给了 `source`（`dynamic`
      // = 本仓程序化注入），dsh 的事件里没有这一格 ⇒ 如实记 `unknown`（**不编**一个来源）。
      const SKIPPED = { name: 'needs-key', source: 'unknown', judgedBy: 'none', verdict: 'skipped' } as const;
      expect(of('claude-code'), 'claude-code 那一行的观测格').toEqual([
        { name: 'probe', source: 'dynamic', judgedBy: 'vendor-tool-table', verdict: 'connected' },
        SKIPPED,
      ]);
      expect(of('dsh'), 'dsh 那一行的观测格').toEqual([
        { name: 'probe', source: 'unknown', judgedBy: 'vendor-tool-table', verdict: 'connected' },
        SKIPPED,
      ]);
      // codex：判据取**启动状态**（它拿不到工具表；`ready` 就是这一家的硬门槛）
      expect(of('codex')).toEqual([
        { name: 'probe', source: 'unknown', judgedBy: 'vendor-startup-status', verdict: 'connected' },
        SKIPPED,
      ]);
      // 硬门槛：**至少两家**在 server 侧留下了 `tools/call`（codex 因上游缺口不在其列）
      expect(calls.some((line) => line.includes('probe_echo'))).toBe(true);
      expect(calls.length).toBeGreaterThanOrEqual(2);
    } finally {
      ROW_RETRY.maxRetries = productionRetries;
      removeTreeWithRetry(probeDir);
    }
  }, TIMEOUT_MS);
});

/**
 * **真机整行：负例①**——`command` 指向不存在的二进制 ⇒ **这一行失败并点名到台**。
 *
 * 为什么这条必须在整行层面跑一次：适配器层面只能证明「厂商报了 `failed` 与原文」（`codex/live-mcp.test.ts`
 * 的 B 臂），而「那两样东西真的把这一行按 `AGENT_MCP_UNAVAILABLE` 收口、文案逐字进了快照」是编排层的事
 * ——中间任何一环接错（判据通道没传、文案没拼、失败被吞）都只在整行上才看得见。
 *
 * 为什么用 codex：它的失败原文是**厂商逐字给的**（`MCP client for \`probe\` failed to start: …`），
 * 正好验「厂商原文照抄」；dsh 起不来时没有原文（那一档的文案由判据侧自己说清，见单测）。
 */
describe.skipIf(!ENABLED)('真机整行：MCP 起不来 ⇒ 行失败 + 文案点名（负例①）', () => {
  it('codex 行的 command 指向不存在的二进制：行落 failed + AGENT_MCP_UNAVAILABLE + 厂商原文', async () => {
    const openai = hostProvider('openai');
    if (openai === null) {
      console.warn('宿主配置里缺 openai 供应商，跳过负例①的真机整行探针');
      return;
    }
    home = createTempHome();
    const repo = initFixtureRepo(join(home.root, 'repo'));
    const probeDir = mkdtempSync(join(tmpdir(), 'aieval-live-row-broken-'));
    const serverPath = join(probeDir, 'echo-server.mjs');
    const callLog = join(probeDir, 'mcp-calls.jsonl');
    mkdirSync(probeDir, { recursive: true });
    writeFileSync(serverPath, ECHO_SERVER_SOURCE, 'utf8');
    writeFileSync(callLog, '', 'utf8');

    const provider = makeProviderFixture({
      protocolType: 'openai',
      baseUrl: openai.baseUrl,
      apiKey: openai.apiKey,
      models: [{ id: openai.modelId, source: 'manual' }],
    });
    const testCase = makeCaseFixture({ repoPath: repo.repoPath, commitHash: repo.commit });
    seedConfig({
      workspaceRoot: home.workspaceRoot,
      providers: [provider],
      cases: [testCase],
      defaultJudge: { providerId: provider.id, modelId: openai.modelId },
      mcpServers: {
        probe: {
          transport: 'stdio',
          enabled: true,
          // **负例①**：这个二进制不存在
          command: '/nonexistent/aieval-live-missing-binary',
          args: [serverPath],
          env: { PROBE_TOOL: 'probe_echo', PROBE_CALL_LOG: callLog },
        },
      },
    });
    const row = makeRowFixture({
      agentKind: 'codex',
      providerId: provider.id,
      providerName: provider.name,
      baseUrl: provider.baseUrl,
      modelId: openai.modelId,
    });
    const run = makeRunFixture({
      workspaceRoot: home.workspaceRoot,
      caseId: testCase.id,
      executionMode: 'parallel',
      rows: [row],
      repoPath: repo.repoPath,
      commitHash: repo.commit,
    });
    saveRun(run);

    const productionRetries = ROW_RETRY.maxRetries;
    ROW_RETRY.maxRetries = 0;
    try {
      await runRow(run.id, row.id);
      const settled = getRun(run.id).rows[0];
      console.log('[live-row-broken] 行状态：', settled?.status, '| 归因：', settled?.error?.code);
      console.log('[live-row-broken] 文案：', settled?.error?.message);
      console.log('[live-row-broken] 观测格：', JSON.stringify(settled?.mcpServers ?? null));

      expect(settled?.status).toBe('failed');
      expect(settled?.error?.code).toBe('AGENT_MCP_UNAVAILABLE');
      expect(settled?.error?.stage).toBe('agent');
      // 文案模板逐字：`MCP「<name>」未能启动：<厂商原文首行>`
      expect(settled?.error?.message).toMatch(/^MCP「probe」未能启动：/);
      expect(settled?.error?.message).toContain('failed to start');
      expect(settled?.error?.message).toContain('No such file or directory');
      // 观测格照写（失败的行也要能复盘「当时装上了谁」）
      expect(settled?.mcpServers).toEqual([
        { name: 'probe', source: 'unknown', judgedBy: 'vendor-startup-status', verdict: 'unavailable' },
      ]);
      // **不自动重试**（配置 / 环境类失败；重试一次 = 再下一遍 61 MB）：候选只跑了一次
      expect(settled?.attempts).toBe(1);
      // 评分那一段**没跑**（环境残缺时不该出分）
      expect(settled?.score).toBeNull();
    } finally {
      ROW_RETRY.maxRetries = productionRetries;
      removeTreeWithRetry(probeDir);
    }
  }, TIMEOUT_MS);
});
