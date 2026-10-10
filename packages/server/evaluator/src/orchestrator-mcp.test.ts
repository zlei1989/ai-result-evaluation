// @vitest-environment node
/**
 * MCP 注入闭环：**编排层**在候选执行那一处把设置页里的条目
 * 解析后填进 `AgentRunInput.mcpServers`，并把「本行 MCP」观测格写进行快照。
 *
 * 为什么这几条守卫必须落在编排层（而不是只测适配器）：
 *   · **填在哪里**是核心裁定——「只候选执行阶段」这条口径由**调用点**保证，
 *     而漏填是静默的：适配器那一侧没有条目就一台都不注入，行照常跑完、分数照出，
 *     界面上只是「本行 MCP」少了几行（`unverified`），没有任何报错；
 *   · **跳过的那几台**（`${ENV}` 未设置）必须**记进观测格**且**行照跑**：跳过本身是正确行为，
 *     但不说出来，用户只会看到「我配的 context7 怎么没生效」；
 *   · **评分那一次不许带**（口径的另一半）：评审者不该拿到候选的工具面，
 *     多传同样是静默的——只有 `fakeAgents.calls` 这一格看得见。
 *
 * 共享夹具、假适配器接缝与 `until` 等待器都在 `./testing/orchestrator-harness`——
 * 那里也写明了**为什么三条 `vi.mock` 必须在每个文件里逐字重复**（vitest 的前置提升只作用于本文件）。
 */
import { vi, describe, expect, it } from 'vitest';
import type { AgentEvent, EvalRow, McpServers } from '@aieval/contracts';
import {
  drainRunningTasks,
  fakeAgents,
  getRun,
  judgeReplyJson,
  PRODUCTION_ROW_RETRIES,
  readEvents,
  registerOrchestratorHooks,
  ROW_RETRY,
  rowEventsFile,
  runRow,
  seedRunnableRun,
  TEST_TIMEOUT_MS,
  until,
} from './testing/orchestrator-harness';

vi.mock('@aieval/agents', async () => (await import('./testing/orchestrator-seams')).agentsMock());
vi.mock('./judge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./judge')>();
  return (await import('./testing/orchestrator-seams')).judgeMock(actual);
});
vi.mock('./run-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./run-store')>();
  return (await import('./testing/orchestrator-seams')).runStoreMock(actual);
});

registerOrchestratorHooks();

/** 这一行的快照（观测格断言的对象） */
function rowOf(runId: string): EvalRow {
  const row = getRun(runId).rows[0];
  if (row === undefined) throw new Error('快照里没有这一行');
  return row;
}

/**
 * 一份四种形态齐备的条目（与 `agents/mcp.test.ts` 那份同形）：
 * 启用的 stdio、占位已设的 http、占位**未设**的 http、用户停用的 http。
 * 变量名刻意用一个谁也不会设的名字——用 `CONTEXT7_API_KEY` 的话，开发机上恰好设过它就会假红。
 */
const ENTRIES: McpServers = {
  playwright: {
    transport: 'stdio',
    enabled: true,
    command: 'npx',
    args: ['-y', '@playwright/mcp@latest'],
  },
  context7: {
    transport: 'http',
    enabled: true,
    url: 'https://mcp.context7.com/mcp',
    headers: { CONTEXT7_API_KEY: '${AIEVAL_MCP_TEST_KEY}' },
  },
  'turn-off': { transport: 'http', enabled: false, url: 'https://mcp.invalid/mcp' },
};

describe('编排层填 MCP 入参', { timeout: TEST_TIMEOUT_MS }, () => {
  it('只有「启用 + 占位解析得出」的条目进 run() 入参，且占位已换成真值（停用的整条不进）', async () => {
    const previous = process.env['AIEVAL_MCP_TEST_KEY'];
    process.env['AIEVAL_MCP_TEST_KEY'] = 'sk-live';
    try {
      const { run } = seedRunnableRun({
        rowCount: 1,
        executionMode: 'parallel',
        mcpServers: ENTRIES,
      });
      await runRow(run.id, run.rows[0]?.id ?? '');

      const call = fakeAgents.calls[0];
      expect(call?.kind).toBe('codex');
      // 逐字：停用的 `turn-off` 不在、占位换成了真值（密钥**只在注入时**解析，落盘那份仍是 `${…}`）
      expect(call?.mcpServers).toEqual({
        playwright: {
          transport: 'stdio',
          enabled: true,
          command: 'npx',
          args: ['-y', '@playwright/mcp@latest'],
        },
        context7: {
          transport: 'http',
          enabled: true,
          url: 'https://mcp.context7.com/mcp',
          headers: { CONTEXT7_API_KEY: 'sk-live' },
        },
      });
    } finally {
      if (previous === undefined) delete process.env['AIEVAL_MCP_TEST_KEY'];
      else process.env['AIEVAL_MCP_TEST_KEY'] = previous;
    }
  });

  it('占位未设置的条目**跳过**：不进 run() 入参、行照跑完、观测格逐台记 skipped 与 unverified', async () => {
    const previous = process.env['AIEVAL_MCP_TEST_KEY'];
    delete process.env['AIEVAL_MCP_TEST_KEY'];
    try {
      const { run } = seedRunnableRun({
        rowCount: 1,
        executionMode: 'parallel',
        mcpServers: ENTRIES,
      });
      const rowId = run.rows[0]?.id ?? '';
      await runRow(run.id, rowId);
      await drainRunningTasks();
      await until(() => rowOf(run.id).status === 'judged', '这一行照跑完', TEST_TIMEOUT_MS);

      // 跳过的只有 context7：它没进注入集（半条注入比不注入更糟）
      expect(Object.keys(fakeAgents.calls[0]?.mcpServers ?? {})).toEqual(['playwright']);
      /**
       * 观测格逐台：注入的那台**厂商没报** ⇒ `unverified` + `judgedBy: 'none'`
       * （**不写成 connected**——这一行的假适配器不产生任何厂商事件，
       * 「没有证据」与「连上了」在这一格上是两句不同的话）；跳过的那台记 `skipped`。
       */
      expect(rowOf(run.id).mcpServers).toEqual([
        { name: 'playwright', source: 'unknown', judgedBy: 'none', verdict: 'unverified' },
        { name: 'context7', source: 'unknown', judgedBy: 'none', verdict: 'skipped' },
      ]);
      // 行照跑（跳过不等于失败）
      expect(rowOf(run.id).status).toBe('judged');
    } finally {
      if (previous === undefined) delete process.env['AIEVAL_MCP_TEST_KEY'];
      else process.env['AIEVAL_MCP_TEST_KEY'] = previous;
    }
  });

  /**
   * **跳过必须说出来**（跳过 + WARN，行照跑）。
   *
   * 为什么值得单独一条：跳过本身是**正确行为**，但不说出来，用户只会看到「我配的那台怎么没生效」——
   * 而这条线索（哪个键的哪个变量没设）只存在于候选执行那一刻，事后在 `run.json` 里查不到。
   * 观测格的 `skipped` 是给界面的，WARN 是给排障的，两处**都要**。
   */
  it('占位未设置的条目**必须落一条 WARN**（点名哪一台、哪个键的哪个变量没设）', async () => {
    const previous = process.env['AIEVAL_MCP_TEST_KEY'];
    delete process.env['AIEVAL_MCP_TEST_KEY'];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const { run } = seedRunnableRun({ rowCount: 1, executionMode: 'parallel', mcpServers: ENTRIES });
      await runRow(run.id, run.rows[0]?.id ?? '');

      const line = warn.mock.calls.map((call) => String(call[0])).find((text) => text.includes('MCP 条目未注入'));
      expect(line, `没有落 WARN；实际：${warn.mock.calls.map((call) => String(call[0])).join(' | ')}`).toBeDefined();
      // 上下文是 console 的第二个参数（不 JSON.stringify，见日志口径）：reason 里点名到键与变量
      const context = warn.mock.calls.find((call) => String(call[0]).includes('MCP 条目未注入'))?.[1] as
        | { name?: string; reason?: string }
        | undefined;
      expect(context?.name).toBe('context7');
      expect(context?.reason).toContain('AIEVAL_MCP_TEST_KEY');
    } finally {
      warn.mockRestore();
      if (previous === undefined) delete process.env['AIEVAL_MCP_TEST_KEY'];
      else process.env['AIEVAL_MCP_TEST_KEY'] = previous;
    }
  });

  /**
   * **形状不对的条目**：`loadConfig` 故意不做 schema 校验，手改
   * `config.json` 写进去的畸形条目（这里用「缺 `transport`」这一种）必须在**唯一那个消费点**被摘出来。
   *
   * 三件事缺一不可，逐条钉：
   *   ① **不进注入集**——修前它会走 else 支被当 http 注入成 `{type:'http', url: undefined}`，
   *      而厂商侧与日志里都没有任何痕迹；
   *   ② **落一条 WARN**——只记观测格的话，用户在界面上看到的是一个 `unverified`，
   *      与「厂商没报它」长得一模一样，没有任何线索指向「回设置页改哪一条」；
   *   ③ **记 `unverified` 而不是行失败**——一条手改坏的配置不该让整行失败（`invalid` 不进
   *      `mcpUnavailableMessage` 的取材范围）。
   */
  it('形状不对的条目：不进 run() 入参 + 落 WARN + 观测格记 unverified（行照跑，不是行失败）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const { run } = seedRunnableRun({
        rowCount: 1,
        executionMode: 'parallel',
        // 手改配置文件那条路：类型上它是 `McpServers`（`loadConfig` 不校验），运行期缺 `transport`
        mcpServers: {
          good: { transport: 'stdio', enabled: true, command: 'npx' },
          broken: { enabled: true, url: 'https://mcp.invalid/mcp' },
        } as unknown as McpServers,
      });
      const rowId = run.rows[0]?.id ?? '';
      await runRow(run.id, rowId);
      await drainRunningTasks();
      await until(() => rowOf(run.id).status === 'judged', '这一行照跑完', TEST_TIMEOUT_MS);

      // ① 畸形那条一个字节都没进注入集（合法那条照旧）
      expect(Object.keys(fakeAgents.calls[0]?.mcpServers ?? {})).toEqual(['good']);
      // ② WARN 点名到台，且原因指回**缺的那一格**
      const warned = warn.mock.calls.find((call) => String(call[0]).includes('MCP 条目形状不对'));
      expect(
        warned,
        `没有落 WARN；实际：${warn.mock.calls.map((call) => String(call[0])).join(' | ')}`,
      ).toBeDefined();
      expect(warned?.[1]).toMatchObject({ name: 'broken' });
      expect((warned?.[1] as { reason?: string } | undefined)?.reason).toContain('transport');
      // ③ 观测格：合法那条 unverified（厂商没报）、畸形那条同样 unverified——**没有一台报 unavailable**
      expect(rowOf(run.id).mcpServers).toEqual([
        { name: 'good', source: 'unknown', judgedBy: 'none', verdict: 'unverified' },
        { name: 'broken', source: 'unknown', judgedBy: 'none', verdict: 'unverified' },
      ]);
      expect(rowOf(run.id).status, '形状不对不是行失败').toBe('judged');
      expect(rowOf(run.id).error).toBeNull();
    } finally {
      warn.mockRestore();
    }
  });

  it('一台都没配 ⇒ 观测格是空数组（`[]` = 观测了、确实一台都没有，与「没观测」不是一回事）', async () => {
    const { run } = seedRunnableRun({ rowCount: 1, executionMode: 'parallel', mcpServers: {} });
    await runRow(run.id, run.rows[0]?.id ?? '');

    expect(fakeAgents.calls[0]?.mcpServers).toBeUndefined();
    expect(rowOf(run.id).mcpServers).toEqual([]);
  });

  it('评分那一次**不带** MCP（口径的另一半：只有候选执行阶段注入）', async () => {
    // 候选那一行走默认的 codex（夹具的默认供应商是 openai；claude-code 行会被协议复检挡下——
    // 那条口径由 `orchestrator-failure-modes.test.ts` 钉）。**评审者**用 claude-code，
    // 于是「同一次 runRow 里的两次 run，只有候选那一次带 MCP」在一个用例里就能对上。
    // 假适配器要回一份能解析的评分答复，否则评审那一段会以解析失败收场（与本题无关的噪声）。
    fakeAgents.scripts.set('claude-code', { finalText: judgeReplyJson() });
    const { run } = seedRunnableRun({
      rowCount: 1,
      executionMode: 'parallel',
      useAgentJudge: true,
      judgeAgentKind: 'claude-code',
      mcpServers: { playwright: { transport: 'stdio', enabled: true, command: 'npx' } },
    });
    await runRow(run.id, run.rows[0]?.id ?? '');

    // 两次 run：候选一次、评审一次（同一格入参，只有这一处能分开它们）
    expect(fakeAgents.calls.length).toBe(2);
    expect(fakeAgents.calls.map((call) => call.mcpServers === undefined)).toEqual([false, true]);
  });
});

/**
 * **「必须装入」失败的行级收口**。
 *
 * 四件事缺一不可，本组逐条钉：
 *   ① 行**失败**（归因码 `AGENT_MCP_UNAVAILABLE`）——MCP 没起来时这一行的评测环境是残缺的，
 *      产出的分数不能当数；
 *   ② 文案**点名到台**（`MCP「<name>」未能启动：<厂商原文首行>`）：厂商原文照抄，FAQ 按它索引；
 *   ③ **不自动重试**（归因码刻意不进 `TRANSIENT_ROW_RETRY_CODES`）：配置 / 环境类失败重试没有意义，
 *      而重试一次 = 再下一遍 61 MB、再起一遍 MCP 进程；
 *   ④ 观测格**照写**（失败的那一行也要能复盘「当时到底装上了谁」）。
 */
describe('MCP 未启动 ⇒ 行失败且不自动重试', () => {
  /** 一条 `vendor-system`（codex 的启动状态通道）：`probe` 报 failed，厂商原文逐字 */
  const startupFailed = (name: string, error: string, seq: number): AgentEvent => ({
    seq,
    at: new Date().toISOString(),
    type: 'vendor-system',
    tools: null,
    slashCommands: null,
    agents: null,
    mcpServers: [{ name, status: 'failed', source: null, error }],
    mcpChannel: 'vendor-startup-status',
    permissionMode: null,
    outputStyle: null,
  });

  const VENDOR_ERROR =
    'MCP client for `probe` failed to start: MCP startup failed: No such file or directory (os error 2)';

  it('厂商报 failed ⇒ 行 failed + 文案点名 + `AGENT_MCP_UNAVAILABLE` + 观测格记 unavailable', async () => {
    const retries = ROW_RETRY.maxRetries;
    const delay = ROW_RETRY.delayMs;
    // 打开产品默认的重试预算（harness 的 beforeEach 把它关成 0）：这一条要同时证「判定失败」与
    // 「失败之后**没有被**自动重跑」——不打开预算的话，重试表里有没有这个码在用例面前没有区别。
    ROW_RETRY.maxRetries = PRODUCTION_ROW_RETRIES;
    ROW_RETRY.delayMs = 1;
    try {
      fakeAgents.scripts.set('codex', { rawEvents: [startupFailed('probe', VENDOR_ERROR, 1)] });
      const { run } = seedRunnableRun({
        rowCount: 1,
        executionMode: 'parallel',
        mcpServers: { probe: { transport: 'stdio', enabled: true, command: '/nonexistent/probe' } },
      });
      const rowId = run.rows[0]?.id ?? '';
      await runRow(run.id, rowId);
      await drainRunningTasks();

      const row = getRun(run.id).rows[0];
      expect(row?.status).toBe('failed');
      expect(row?.error?.code).toBe('AGENT_MCP_UNAVAILABLE');
      expect(row?.error?.stage).toBe('agent');
      // ② 文案逐字（厂商原文照抄，不带我们的话）
      expect(row?.error?.message).toBe(`MCP「probe」未能启动：${VENDOR_ERROR}`);
      // ④ 观测格照写：失败的行同样要能复盘「当时装上了谁、凭什么这么说」
      expect(row?.mcpServers).toEqual([
        { name: 'probe', source: 'unknown', judgedBy: 'vendor-startup-status', verdict: 'unavailable' },
      ]);
      // ③ 没有第二次尝试（候选只跑了一次、attempts 停在 1）
      expect(fakeAgents.calls).toHaveLength(1);
      expect(row?.attempts).toBe(1);
      // 失败也落一条 error 事件（日志抽屉是唯一回答「为什么」的地方）
      const events = readEvents(rowEventsFile(run.workspaceBase, run.id, rowId));
      expect(events.some((event) => event.type === 'error' && event.message.includes('AGENT_MCP_UNAVAILABLE'))).toBe(true);
      // 评分那一段**没有跑**（候选环境残缺时不该再花一次评分）：没有 score 事件
      expect(events.some((event) => event.type === 'score')).toBe(false);
    } finally {
      ROW_RETRY.maxRetries = retries;
      ROW_RETRY.delayMs = delay;
    }
  });

  it('厂商报 ready ⇒ 行**照常**评分（判据只到「装上了」，不拿它当失败）', async () => {
    fakeAgents.scripts.set('codex', {
      rawEvents: [
        {
          seq: 1,
          at: new Date().toISOString(),
          type: 'vendor-system',
          tools: null,
          slashCommands: null,
          agents: null,
          mcpServers: [{ name: 'probe', status: 'ready', source: null, error: null }],
          mcpChannel: 'vendor-startup-status',
          permissionMode: null,
          outputStyle: null,
        },
      ],
    });
    const { run } = seedRunnableRun({
      rowCount: 1,
      executionMode: 'parallel',
      mcpServers: { probe: { transport: 'stdio', enabled: true, command: 'node' } },
    });
    await runRow(run.id, run.rows[0]?.id ?? '');
    await drainRunningTasks();
    await until(() => rowOf(run.id).status === 'judged', '这一行照跑完', TEST_TIMEOUT_MS);

    expect(getRun(run.id).rows[0]?.mcpServers).toEqual([
      { name: 'probe', source: 'unknown', judgedBy: 'vendor-startup-status', verdict: 'connected' },
    ]);
  });

  /**
   * dsh 的通道（`vendor-tool-table`）：工具表**在**、里面没有它 ⇒ 失败。
   * 这一条同时是「同一份推导按通道分读法」的接线守卫——把它接到 claude 那条通道上，
   * 结论会变成 `unverified`（而那正是 dsh 最要不得的假绿：起不来时它什么都不报）。
   */
  it('dsh 的工具表里没有它 ⇒ 行失败，文案用「工具表」这一条判据说清凭什么', async () => {
    fakeAgents.scripts.set('dsh', {
      rawEvents: [
        {
          seq: 1,
          at: new Date().toISOString(),
          type: 'vendor-system',
          tools: ['bash', 'edit'],
          slashCommands: null,
          agents: null,
          mcpServers: null,
          mcpChannel: 'vendor-tool-table',
          permissionMode: null,
          outputStyle: null,
        },
      ],
    });
    const { run } = seedRunnableRun({
      rowCount: 1,
      executionMode: 'parallel',
      agentKind: 'dsh',
      mcpServers: { probe: { transport: 'stdio', enabled: true, command: 'node' } },
    });
    await runRow(run.id, run.rows[0]?.id ?? '');

    const row = getRun(run.id).rows[0];
    expect(row?.status).toBe('failed');
    expect(row?.error?.code).toBe('AGENT_MCP_UNAVAILABLE');
    expect(row?.error?.message).toContain('MCP「probe」未能启动：');
    expect(row?.error?.message).toContain('工具表');
  });
});
