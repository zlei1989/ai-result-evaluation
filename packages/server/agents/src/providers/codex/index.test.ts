// @vitest-environment node
/**
 * codex 适配器的**接线**契约：注入落点、通知贯通、收尾取数、用量与轮次、能力声明。
 *
 * 夹具分工：`appserver-fixtures.ts` 给一个假 app-server 客户端（推通知、答请求，不 spawn），
 * 本文件只钉「适配器有没有把该交的东西交到该去的地方」——协议本身的形状由 `appserver/*.test.ts` 覆盖。
 */
import { EFFORT_OFF, type AgentEvent, type AgentMessage, type SubagentRecord } from '@aieval/contracts';
import { describe, expect, it } from 'vitest';
import { listAgentProviders } from '../../registry';
import { collectEvents, createRunInput, FIXTURE_CWD } from '../../testing/agent-fixtures';
import type { AgentRunResult } from '../../types';
import {
  agentMessageDelta,
  createFakeAppServer,
  errorNotification,
  itemCompleted,
  itemStarted,
  reasoningTextDelta,
  threadItemsPages,
  threadListPages,
  threadStarted,
  tokenUsageUpdated,
  turnCompleted,
  turnPlanUpdated,
  type FakeAppServer,
  type FakeNotification,
} from './appserver-fixtures';
import { buildCodexConfig, codexEffortOf, codexProvider, type CodexRuntimeHooks } from './index';

/**
 * 一次运行要喂的东西：通知序列 + 取数面的应答。
 * `hang` = 不投递 `turn/completed`（用来观察「流还开着」时的行为：终止、运行期事件）。
 */
interface Scenario {
  notifications?: readonly FakeNotification[];
  hang?: boolean;
  threads?: ReadonlyArray<Record<string, unknown> & { id: string }>;
  contents?: Record<
    string,
    { thread: Record<string, unknown> & { id: string }; items?: ReadonlyArray<{ turnId: string; item: Record<string, unknown> }> }
  >;
  threadId?: string;
  threadError?: unknown;
}

/** 把假 app-server 接到 provider 的注入口上（`createClient` 恒返回同一个实例 = 会话与取数共用） */
function wire(scenario: Scenario = {}): FakeAppServer {
  const server = createFakeAppServer({
    ...(scenario.threadId === undefined ? {} : { threadId: scenario.threadId }),
    ...(scenario.notifications === undefined ? {} : { notifications: scenario.notifications }),
    ...(scenario.threadError === undefined ? {} : { threadError: scenario.threadError }),
    hangUntilTerminal: scenario.hang === true,
    respond: {
      'thread/list': threadListPages(scenario.threads ?? [], 100),
      'thread/read': (params) => {
        const content = scenario.contents?.[String(params.threadId)];
        return content === undefined ? { thread: null } : { thread: content.thread };
      },
      'thread/items/list': (params) => {
        const content = scenario.contents?.[String(params.threadId)];
        return threadItemsPages(content?.items ?? [], 100)(params);
      },
    },
  });
  const hooks: CodexRuntimeHooks = {
    createClient: () => server.client,
    resolveBinary: () => 'C:/fake/codex.exe',
  };
  codexProvider.runtimeHooks = hooks;
  return server;
}

interface Collected {
  result: AgentRunResult;
  events: AgentEvent[];
  messages: AgentMessage[];
  subagents: SubagentRecord[];
}

/** 跑一次运行，收齐四条出口（结果 / 事件 / 消息 / 子任务行） */
async function collect(scenario: Scenario, input: Partial<Parameters<typeof createRunInput>[0]> = {}): Promise<Collected> {
  wire(scenario);
  const events: AgentEvent[] = [];
  const messages: AgentMessage[] = [];
  const subagents: SubagentRecord[] = [];
  const result = await codexProvider.run(
    createRunInput({
      permission: 'full',
      onEvent: collectEvents(events),
      onMessage: (message) => {
        messages.push(message);
      },
      onSubagent: (record) => {
        subagents.push(record);
      },
      ...input,
    }),
  );
  return { result, events, messages, subagents };
}

/** 一个合并键下**最后一条**消息（合并器的覆盖语义下它就是该逻辑消息的当前真相） */
function finalOf(messages: readonly AgentMessage[], mergeKey: string): AgentMessage | undefined {
  return messages.filter((one) => one.mergeKey === mergeKey).at(-1);
}

/** 全部块（按到达顺序去重后合并的最终形态） */
function blocksOf(messages: readonly AgentMessage[]): AgentMessage['blocks'] {
  return messages.at(-1)?.blocks ?? [];
}

function answer(id: string, text: string): Record<string, unknown> & { type: string; id: string } {
  return { type: 'agentMessage', id, text, phase: null, memoryCitation: null, delivery: null, questions: null };
}

function reasoning(id: string, content: string[], summary: string[] = []): Record<string, unknown> & { type: string; id: string } {
  return { type: 'reasoning', id, summary, content };
}

const MAIN = 'thread-main';
const CHILD = 'thread-child';

describe('注入落点：线程参数、权限档、结构化输出、档位', () => {
  it('帧序是 initialize → thread/start → turn/start', async () => {
    const server = wire({ notifications: [turnCompleted({ id: 'turn-1' }, { threadId: MAIN })] });
    await codexProvider.run(createRunInput());
    expect(server.stats.requests.map((one) => one.method).slice(0, 3)).toEqual(['initialize', 'thread/start', 'turn/start']);
    expect(server.stats.initializeCount).toBe(1);
  });

  it('`thread/start` 收 model / cwd / sandbox / approvalPolicy / config；`effort` 与 `outputSchema` 只进 `turn/start`', async () => {
    const server = wire({ notifications: [turnCompleted({ id: 'turn-1' }, { threadId: MAIN })] });
    const schema = { type: 'object', properties: { verdict: { type: 'string' } } };
    await codexProvider.run(
      createRunInput({
        effort: 'xhigh',
        outputSchema: schema,
        route: { protocolType: 'openai', baseUrl: 'https://gw.example.com/openai/', apiKey: 'sk-codex', modelId: 'gpt-x', contextWindow: 1_048_576 },
      }),
    );
    const threadParams = server.stats.requests[1]?.params as Record<string, unknown>;
    expect(threadParams).toMatchObject({
      model: 'gpt-x',
      cwd: FIXTURE_CWD,
      sandbox: 'danger-full-access',
      approvalPolicy: 'never',
    });
    expect(threadParams.config).toMatchObject({
      // `model_provider` 与 `model_providers` 是一对：少前者时 CLI 退回内置默认 provider（api.openai.com），
      // 表象是 `Reconnecting... waiting for network`（网络层），不是网关 401 —— 难归因，故钉在这里。
      model_provider: 'aieval',
      model_providers: { aieval: { base_url: 'https://gw.example.com/openai/v1', wire_api: 'responses', env_key: 'OPENAI_API_KEY' } },
      model_context_window: 1_048_576,
      tools: { web_search: false, update_plan: { enabled: true } },
      features: { multi_agent: true },
    });
    expect(threadParams).not.toHaveProperty('effort');
    // 回归守卫：`requires_openai_auth` 会让 CLI 走 ChatGPT 登录态——密钥就在子进程环境里也不附
    // Authorization 头（`api_request` 日志三格同在：401 / header_attached=false / env_key_present=true）。
    // 用 toMatchObject 拦不住「两格并存」，故这一格单独判**不存在**。
    expect(
      (threadParams.config as { model_providers: { aieval: Record<string, unknown> } }).model_providers.aieval,
    ).not.toHaveProperty('requires_openai_auth');
    const turnParams = server.stats.requests[2]?.params as Record<string, unknown>;
    expect(turnParams).toMatchObject({ effort: 'xhigh', outputSchema: schema });
    expect(turnParams.input).toEqual([{ type: 'text', text: '把 README 的标题改成「示例项目」，然后结束。', text_elements: [] }]);
  });

  /**
   * 权限档按阶段分给：候选要能改代码、评审者只能看。
   *
   * ⚠️ **Windows 上的例外**（2026-10-07 真机）：codex 的受限沙箱在该平台起不了任何子进程
   * （`read-only` / `workspace-write` 下连 `echo`、`git status` 都被 policy 拒），而它读文件只能靠
   * shell ⇒ 只读档会变成盲评。故 **Windows 上评分阶段落最宽档**，靠编排层的「评分前后 diff 摘要
   * 对照」兜底（不一致即该行失败）。豁免的逐格判据在 `permission.test.ts`，这里钉的是**接线**
   * ——适配器确实用了 `codexPermissionOptions()` 的那一份，而不是绕过它去索引常量表。
   */
  it('评分阶段的权限档：非 Windows 是 `read-only`、Windows 落最宽档（豁免不许绕过翻译层）', async () => {
    const expected = process.platform === 'win32' ? 'danger-full-access' : 'read-only';
    const server = wire({ notifications: [turnCompleted({ id: 'turn-1' }, { threadId: MAIN })] });
    await codexProvider.run(createRunInput({ permission: 'read-only' }));
    expect(server.stats.requests[1]?.params).toMatchObject({ sandbox: expected, approvalPolicy: 'never' });
  });

  it('没给 `outputSchema` ⇒ `turn/start` 里没有这个键（显式 `null` 与「没给」同义）', async () => {
    const bare = wire({ notifications: [turnCompleted({ id: 'turn-1' }, { threadId: MAIN })] });
    await codexProvider.run(createRunInput());
    expect(bare.stats.requests[2]?.params).not.toHaveProperty('outputSchema');

    const explicitNull = wire({ notifications: [turnCompleted({ id: 'turn-1' }, { threadId: MAIN })] });
    await codexProvider.run(createRunInput({ outputSchema: null as unknown as Record<string, unknown> }));
    expect(explicitNull.stats.requests[2]?.params).not.toHaveProperty('outputSchema');
  });

  it('显式 `off` ⇒ 两格并存：`effort: none` + `config.model_reasoning_summary: none`', async () => {
    const server = wire({ notifications: [turnCompleted({ id: 'turn-1' }, { threadId: MAIN })] });
    await codexProvider.run(createRunInput({ effort: EFFORT_OFF }));
    expect(server.stats.requests[1]?.params).toMatchObject({ config: { model_reasoning_summary: 'none' } });
    expect(server.stats.requests[2]?.params).toMatchObject({ effort: 'none' });
  });

  it('其它档位与未选都不带那两格键（形态判据用 `Object.hasOwn`）', async () => {
    const withEffort = wire({ notifications: [turnCompleted({ id: 'turn-1' }, { threadId: MAIN })] });
    await codexProvider.run(createRunInput({ effort: 'high' }));
    const highConfig = (withEffort.stats.requests[1]?.params as { config: Record<string, unknown> }).config;
    expect(Object.hasOwn(highConfig, 'model_reasoning_summary')).toBe(false);
    expect(Object.hasOwn(highConfig, 'model_context_window')).toBe(false);
    expect(withEffort.stats.requests[2]?.params).toMatchObject({ effort: 'high' });

    const bare = wire({ notifications: [turnCompleted({ id: 'turn-1' }, { threadId: MAIN })] });
    await codexProvider.run(createRunInput());
    // 未选 ⇒ `turn/start` 一个 effort 键都不加（这一家的「不传」由厂商推断）
    expect(bare.stats.requests[2]?.params).not.toHaveProperty('effort');
  });

  it('只有关闭档走映射，其余档位逐字透传', () => {
    expect(codexEffortOf('off')).toBe('none');
    expect(codexEffortOf('high')).toBe('high');
    expect(codexEffortOf('ultra')).toBe('ultra');
  });

  it('线程建不起来（CLI 未安装 / spawn ENOENT）⇒ AGENT_FAILED，run 不抛', async () => {
    const result = (
      await collect({ threadError: new Error('spawn codex ENOENT') })
    ).result;
    expect(result).toMatchObject({ ok: false, exitReason: 'error' });
    expect(result.error?.code).toBe('AGENT_FAILED');
  });

  it('进程提前退出 ⇒ 本轮以失败结算（绝不悬挂）', async () => {
    const server = wire({ hang: true });
    const running = codexProvider.run(createRunInput());
    // 让 start 阶段的三个请求先走完，再模拟进程退出
    await Promise.resolve();
    server.die('codex app-server 进程已退出（code=1）');
    const result = await running;
    expect(result).toMatchObject({ ok: false, exitReason: 'error' });
    expect(result.error?.message).toContain('进程已退出');
  });
});

describe('通知贯通：内容、流式增量与工具四族', () => {
  it('答复增量与完成条目落在**同一个合并键**上，最终是完整答复且已收尾', async () => {
    const { messages } = await collect({
      notifications: [
        agentMessageDelta('正在', { threadId: MAIN, turnId: 'turn-1', itemId: 'm1' }),
        agentMessageDelta('检查', { threadId: MAIN, turnId: 'turn-1', itemId: 'm1' }),
        itemCompleted(answer('m1', '正在检查仓库。'), { threadId: MAIN, turnId: 'turn-1' }),
        turnCompleted({ id: 'turn-1', items: [answer('m1', '正在检查仓库。')] }, { threadId: MAIN }),
      ],
    });
    // 只看主线程那一份（子线程没有）
    const main = messages.filter((one) => one.subagentId === null);
    expect(main.map((one) => one.chunk)).toEqual(['delta', 'delta', 'snapshot']);
    expect(new Set(main.map((one) => one.mergeKey)).size).toBe(1);
    expect(finalOf(main, main[0]!.mergeKey)?.assembly).toBe('snapshot');
    expect(blocksOf(main)).toEqual([{ type: 'text', text: '正在检查仓库。' }]);
  });

  it('同一条逻辑消息里的不同块各占一个槽位（推理与正文不会互相覆盖）', async () => {
    const { messages } = await collect({
      notifications: [
        itemCompleted(reasoning('r1', ['先看配置']), { threadId: MAIN, turnId: 'turn-1' }),
        itemCompleted(answer('m1', '改完了'), { threadId: MAIN, turnId: 'turn-1' }),
        turnCompleted({ id: 'turn-1', items: [answer('m1', '改完了')] }, { threadId: MAIN }),
      ],
    });
    const main = messages.filter((one) => one.subagentId === null);
    expect(blocksOf(main)).toEqual([
      { type: 'thinking', text: '先看配置', textKind: 'full', signature: null },
      { type: 'text', text: '改完了' },
    ]);
  });

  it('思考全文与摘要各一块；`content[]` 为空（密文）时正文 `null` + `none`，**不回落** summary', async () => {
    const withContent = await collect({
      notifications: [
        itemCompleted(reasoning('r1', ['完整推理'], ['厂商摘要']), { threadId: MAIN, turnId: 'turn-1' }),
        turnCompleted({ id: 'turn-1', items: [] }, { threadId: MAIN }),
      ],
    });
    expect(blocksOf(withContent.messages.filter((one) => one.subagentId === null))).toEqual([
      { type: 'thinking', text: '完整推理', textKind: 'full', signature: null },
      { type: 'thinking', text: '厂商摘要', textKind: 'summary', signature: null },
    ]);

    const encrypted = await collect({
      notifications: [
        itemCompleted(reasoning('r1', []), { threadId: MAIN, turnId: 'turn-1' }),
        turnCompleted({ id: 'turn-1', items: [] }, { threadId: MAIN }),
      ],
    });
    expect(blocksOf(encrypted.messages.filter((one) => one.subagentId === null))).toEqual([
      { type: 'thinking', text: null, textKind: 'none', signature: null },
    ]);
  });

  it('只回密文但全文已经逐字推完 ⇒ 完成通知补快照封口（那一块不会停在 open）', async () => {
    const { messages } = await collect({
      notifications: [
        reasoningTextDelta('推完的全文', { threadId: MAIN, turnId: 'turn-1', itemId: 'r1' }),
        itemCompleted(reasoning('r1', []), { threadId: MAIN, turnId: 'turn-1' }),
        turnCompleted({ id: 'turn-1', items: [] }, { threadId: MAIN }),
      ],
    });
    const main = messages.filter((one) => one.subagentId === null);
    expect(finalOf(main, main[0]!.mergeKey)).toMatchObject({
      assembly: 'snapshot',
      blocks: [{ type: 'thinking', text: '推完的全文', textKind: 'full', signature: null }],
    });
  });

  it('`commandExecution` ⇒ 调用 + 结果两条消息（命令 / 输出 / 退出码 / 耗时）', async () => {
    const { messages } = await collect({
      notifications: [
        itemCompleted(
          { type: 'commandExecution', id: 'c1', command: 'npm test', cwd: 'D:/w', status: 'completed', aggregatedOutput: 'ok', exitCode: 0, durationMs: 12 },
          { threadId: MAIN, turnId: 'turn-1' },
        ),
        turnCompleted({ id: 'turn-1', items: [] }, { threadId: MAIN }),
      ],
    });
    const blocks = messages.filter((one) => one.subagentId === null).flatMap((one) => one.blocks);
    expect(blocks).toEqual([
      { type: 'tool-call', callId: 'c1', family: 'run-shell', name: 'exec_command', input: { command: 'npm test', cwd: 'D:/w' }, payload: null },
      { type: 'tool-result', callId: 'c1', structured: { exitCode: 0, durationMs: 12 }, isError: false, text: 'ok', truncation: { kind: 'unknown' } },
    ]);
  });

  it('`fileChange` ⇒ `apply_patch` 调用 + 结构化结果（这一格此前在消息面上没有）', async () => {
    const { messages } = await collect({
      notifications: [
        itemCompleted(
          { type: 'fileChange', id: 'f1', status: 'completed', changes: [{ path: 'src/a.ts', kind: 'update', diff: '+' }] },
          { threadId: MAIN, turnId: 'turn-1' },
        ),
        turnCompleted({ id: 'turn-1', items: [] }, { threadId: MAIN }),
      ],
    });
    expect(messages.filter((one) => one.subagentId === null).flatMap((one) => one.blocks)).toMatchObject([
      { type: 'tool-call', family: 'edit-file', name: 'apply_patch', input: { changes: [{ path: 'src/a.ts', kind: 'update' }] } },
      { type: 'tool-result', structured: { changes: [{ path: 'src/a.ts', kind: 'update' }], status: 'completed' }, isError: false },
    ]);
  });

  it('`mcpToolCall` ⇒ 「服务名.工具名」+ `family: null` + `isError`（看错误对象）', async () => {
    const { messages } = await collect({
      notifications: [
        itemCompleted(
          { type: 'mcpToolCall', id: 'x1', server: 'fs', tool: 'read', status: 'failed', durationMs: null, arguments: { path: 'a' }, result: null, error: { message: '拒绝访问' } },
          { threadId: MAIN, turnId: 'turn-1' },
        ),
        turnCompleted({ id: 'turn-1', items: [] }, { threadId: MAIN }),
      ],
    });
    expect(messages.filter((one) => one.subagentId === null).flatMap((one) => one.blocks)).toMatchObject([
      { type: 'tool-call', family: null, name: 'fs.read', input: { path: 'a' } },
      { type: 'tool-result', isError: true, text: '拒绝访问', structured: null },
    ]);
  });

  it('`plan` / `turn/plan/updated` ⇒ `task` 族 + `payload.kind: plan`', async () => {
    const { messages } = await collect({
      notifications: [
        itemCompleted({ type: 'plan', id: 'p1', text: '先读配置' }, { threadId: MAIN, turnId: 'turn-1' }),
        turnPlanUpdated([{ step: '读配置', status: 'completed' }], { threadId: MAIN, turnId: 'turn-1' }),
        turnCompleted({ id: 'turn-1', items: [] }, { threadId: MAIN }),
      ],
    });
    const calls = messages
      .filter((one) => one.subagentId === null)
      .flatMap((one) => one.blocks)
      .filter((block) => block.type === 'tool-call');
    expect(calls[0]).toMatchObject({
      family: 'task',
      name: 'update_plan',
      payload: { kind: 'plan', steps: [{ subject: '先读配置', status: 'unknown' }], note: null },
    });
    expect(calls.at(-1)).toMatchObject({
      family: 'task',
      name: 'update_plan',
      payload: { kind: 'plan', steps: [{ subject: '读配置', status: 'completed' }], note: null },
    });
  });

  it('协作条目：派发调用 + 子任务行（顶层父链 null、`parentCallId` = 派发条目 id、昵称来自 `thread/started`）', async () => {
    const { messages, subagents } = await collect({
      notifications: [
        threadStarted({ id: CHILD, agentNickname: '工作区检查', parentThreadId: MAIN }),
        itemCompleted(
          {
            type: 'collabAgentToolCall',
            id: 'item_8',
            tool: 'spawn_agent',
            status: 'completed',
            senderThreadId: MAIN,
            receiverThreadIds: [CHILD],
            prompt: '检查工作区',
            agentsStates: { [CHILD]: { status: 'running', message: null } },
          },
          { threadId: MAIN, turnId: 'turn-1' },
        ),
        turnCompleted({ id: 'turn-1', items: [] }, { threadId: MAIN }),
      ],
      threads: [{ id: CHILD, parentThreadId: MAIN, agentNickname: '工作区检查', status: { type: 'idle' } }],
      contents: { [CHILD]: { thread: { id: CHILD, turns: [] }, items: [] } },
    });
    expect(messages.filter((one) => one.subagentId === null).flatMap((one) => one.blocks)[0]).toMatchObject({
      type: 'tool-call',
      name: 'spawn_agent',
      family: 'spawn-agent',
    });
    expect(subagents[0]).toMatchObject({
      subagentId: CHILD,
      name: '工作区检查',
      kind: 'spawn_agent',
      parentCallId: 'item_8',
      parentSubagentId: null,
      status: 'running',
    });
  });

  it('`subAgentActivity` 刷新子任务状态且不产消息（四档活动逐档映射）', async () => {
    const { messages, subagents } = await collect({
      notifications: [
        itemCompleted(
          {
            type: 'collabAgentToolCall',
            id: 'item_8',
            tool: 'spawn_agent',
            status: 'completed',
            senderThreadId: MAIN,
            receiverThreadIds: [CHILD],
            prompt: '检查',
            agentsStates: { [CHILD]: { status: 'running', message: null } },
          },
          { threadId: MAIN, turnId: 'turn-1' },
        ),
        itemCompleted({ type: 'subAgentActivity', id: 'a1', kind: 'completed', agentThreadId: CHILD, agentPath: '/root' }, { threadId: MAIN, turnId: 'turn-1' }),
        turnCompleted({ id: 'turn-1', items: [] }, { threadId: MAIN }),
      ],
      threads: [{ id: CHILD, parentThreadId: MAIN, status: { type: 'idle' } }],
      contents: { [CHILD]: { thread: { id: CHILD, turns: [] }, items: [] } },
    });
    const callBlocks = messages.filter((one) => one.subagentId === null).flatMap((one) => one.blocks);
    expect(callBlocks).toHaveLength(1); // 活动条目一条消息都不产
    expect(subagents.some((one) => one.subagentId === CHILD && one.status === 'completed')).toBe(true);
  });

  it('订阅前推入的通知不丢：首个订阅者按序补收，补投只发生一次', () => {
    const server = createFakeAppServer({ notifications: [turnCompleted({ id: 'turn-1' }, { threadId: MAIN })] });
    // 订阅建立前推入 ⇒ 缓冲。真实 app-server 的 `turn/completed` 必然晚于 `turn/start` 的响应，
    // 而适配器在响应返回**之后**才订阅，故这条路径就是本轮结算所依赖的那条
    server.emit('thread/started', { thread: { id: MAIN } });

    const replayed: string[] = [];
    const received: string[] = [];
    // 首个订阅者注册 ⇒ 按推入顺序补收之前缓冲的全部
    const first = server.client.subscribe((notification) => {
      replayed.push(notification.method);
    });
    expect(replayed).toEqual(['thread/started']);
    // 补投之后再推入 ⇒ 即时到达；第二个订阅者只见「注册之后」的投递（补投只发生一次）
    const second = server.client.subscribe((notification) => {
      received.push(notification.method);
    });
    server.emit('item/completed', { threadId: MAIN, turnId: 'turn-1', item: answer('m1', '答复') });
    expect(replayed).toEqual(['thread/started', 'item/completed']);
    expect(received).toEqual(['item/completed']);
    first();
    second();
  });

  it('`turn/start` 处理内推入的终态先于订阅到达时，本轮仍要结算（不悬挂）', async () => {
    const { result } = await collect({ notifications: [turnCompleted({ id: 'turn-1' }, { threadId: MAIN })] });
    expect(result).toMatchObject({ ok: true, exitReason: 'completed' });
  });
});

/**
 * 最终答复出口：`AgentRunResult.finalText`。
 *
 * 为什么单独一个 describe：**评分通路只读这一格**（`judge-agent.ts` 拿不到就报「该适配器未回传
 * 最终消息」），而 codex 在协议上没有另两家那种显式的收尾消息（claude 的 `result` / dsh 的
 * `assistant/message`）——它的答复就是 `item/completed` 上的 `agentMessage` 条目。
 * 结构化输出（`turn/start.outputSchema`）约束的正是这条条目的正文，所以这一格是 schema 的**唯一落点**：
 * 它拿不到，`capability.structuredOutput: true` 就只是一张空头支票。
 */
describe('最终答复出口：finalText', () => {
  it('主线程已完成的答复条目进 finalText（两条 ⇒ 取后者，与另两家的覆盖口径一致）', async () => {
    const { result } = await collect({
      notifications: [
        itemCompleted(answer('m1', '先看一眼仓库结构'), { threadId: MAIN, turnId: 'turn-1' }),
        itemCompleted(answer('m2', '{"judgments":[],"verdict":"还行"}'), { threadId: MAIN, turnId: 'turn-1' }),
        turnCompleted({ id: 'turn-1' }, { threadId: MAIN }),
      ],
    });
    expect(result.finalText).toBe('{"judgments":[],"verdict":"还行"}');
  });

  it('`item/started` 的半截正文不写 finalText（未完成的正文不许当答复）', async () => {
    const { result } = await collect({
      notifications: [
        itemStarted(answer('m1', '{"judgments":'), { threadId: MAIN, turnId: 'turn-1' }),
        turnCompleted({ id: 'turn-1' }, { threadId: MAIN }),
      ],
    });
    expect(result.finalText).toBeNull();
  });

  it('流式增量的片段不写 finalText（它的落点是内容块的增量槽位）', async () => {
    const { result } = await collect({
      notifications: [
        agentMessageDelta('{"judgments":', { threadId: MAIN, turnId: 'turn-1', itemId: 'm1' }),
        turnCompleted({ id: 'turn-1' }, { threadId: MAIN }),
      ],
    });
    expect(result.finalText).toBeNull();
  });

  it('子线程的答复不覆盖主线程那一格（评分读的是主会话的产出）', async () => {
    const { result } = await collect({
      notifications: [
        itemCompleted(answer('m1', '主线程结论'), { threadId: MAIN, turnId: 'turn-1' }),
        itemCompleted(answer('cm1', '子线程结论'), { threadId: CHILD, turnId: 'ct1' }),
        turnCompleted({ id: 'turn-1' }, { threadId: MAIN }),
      ],
      threads: [{ id: CHILD, parentThreadId: MAIN, status: { type: 'idle' } }],
      contents: { [CHILD]: { thread: { id: CHILD, turns: [] }, items: [] } },
    });
    expect(result.finalText).toBe('主线程结论');
  });

  it('空正文不写 finalText（空块在界面上只是一行空白，不是答复）', async () => {
    const { result } = await collect({
      notifications: [
        itemCompleted(answer('m1', ''), { threadId: MAIN, turnId: 'turn-1' }),
        turnCompleted({ id: 'turn-1' }, { threadId: MAIN }),
      ],
    });
    expect(result.finalText).toBeNull();
  });
});

describe('收尾：子线程内容、终态与用量', () => {
  it('用 `thread/list{ancestorThreadId}` 枚举后代，并用**同一个客户端**读回内容', async () => {
    const server = wire({
      notifications: [turnCompleted({ id: 'turn-1' }, { threadId: MAIN })],
      threads: [{ id: CHILD, parentThreadId: MAIN, status: { type: 'idle' } }],
      contents: { [CHILD]: { thread: { id: CHILD, turns: [] }, items: [] } },
    });
    await codexProvider.run(createRunInput());
    expect(server.stats.requests.find((one) => one.method === 'thread/list')?.params).toMatchObject({ ancestorThreadId: MAIN });
    expect(server.stats.requests.find((one) => one.method === 'thread/read')?.params).toMatchObject({ threadId: CHILD, includeTurns: true });
  });

  it('子线程的条目进消息流（带 `subagentId`），终态由 `turn.status` 推出（`failed` 那一档）', async () => {
    const { messages, subagents } = await collect({
      notifications: [turnCompleted({ id: 'turn-1', items: [answer('m1', '主线程答复')] }, { threadId: MAIN })],
      threads: [{ id: CHILD, parentThreadId: MAIN, agentNickname: '检查', status: { type: 'idle' } }],
      contents: {
        [CHILD]: {
          thread: {
            id: CHILD,
            turns: [{ id: 'ct1', items: [answer('cm1', '子线程答复')], itemsView: 'full', status: 'failed', error: '子线程炸了', startedAt: null, completedAt: null, durationMs: null }],
          },
          items: [{ turnId: 'ct1', item: answer('cm1', '子线程答复') }],
        },
      },
    });
    const child = messages.filter((one) => one.subagentId === CHILD);
    expect(child.flatMap((one) => one.blocks)).toEqual([{ type: 'text', text: '子线程答复' }]);
    expect(subagents.find((one) => one.subagentId === CHILD)).toMatchObject({ status: 'failed', outcome: '子线程答复', name: '检查' });
  });

  it('子线程树枚举失败 ⇒ 分量与轮次分量**同时** `null`，并落一条点名 WARN', async () => {
    const server = createFakeAppServer({
      notifications: [turnCompleted({ id: 'turn-1', items: [answer('m1', '答复')] }, { threadId: MAIN })],
      respond: {
        'thread/list': () => {
          throw new Error('thread/list 失败');
        },
      },
    });
    codexProvider.runtimeHooks = { createClient: () => server.client, resolveBinary: () => 'C:/fake/codex.exe' };
    const events: AgentEvent[] = [];
    const result = await codexProvider.run(createRunInput({ onEvent: collectEvents(events) }));
    expect(result.subagentTokens).toBeNull();
    expect(result.subagentTurns).toBeNull();
    const logs = events.filter((event) => event.type === 'log').map((event) => (event.type === 'log' ? event.text : ''));
    expect(logs.some((text) => text.includes('子线程树不是全量'))).toBe(true);
  });

  it('没有子线程 ⇒ 分量是 `{0,0,0}` / `0`（「确实没有」与「没采到」是两件事）', async () => {
    const { result } = await collect({
      notifications: [turnCompleted({ id: 'turn-1', items: [answer('m1', '答复')] }, { threadId: MAIN })],
    });
    expect(result.subagentTokens).toEqual({ input: 0, cached: 0, output: 0, reasoningOutput: null, total: null });
    expect(result.subagentTurns).toBe(0);
  });

  it('子线程没报用量 ⇒ 两格都为 `null`，WARN 点名那条线程', async () => {
    const { result, events } = await collect({
      notifications: [turnCompleted({ id: 'turn-1', items: [answer('m1', '答复')] }, { threadId: MAIN })],
      threads: [{ id: CHILD, parentThreadId: MAIN, status: { type: 'idle' } }],
      contents: { [CHILD]: { thread: { id: CHILD, turns: [] }, items: [] } },
    });
    expect(result.subagentTokens).toBeNull();
    expect(result.subagentTurns).toBeNull();
    const logs = events.filter((event) => event.type === 'log').map((event) => (event.type === 'log' ? event.text : ''));
    expect(logs.some((text) => text.includes(CHILD) && text.includes('没有用量通知'))).toBe(true);
  });

  it('用量「全量或 null」：任一子线程缺用量 ⇒ 分量整格 `null`（不拿部分和冒充总数）', async () => {
    const { result } = await collect({
      notifications: [
        tokenUsageUpdated({ inputTokens: 30, cachedInputTokens: 10, outputTokens: 5 }, { threadId: CHILD }),
        turnCompleted({ id: 'turn-1', items: [answer('m1', '答复')] }, { threadId: MAIN }),
      ],
      threads: [
        { id: CHILD, parentThreadId: MAIN, status: { type: 'idle' } },
        { id: 'thread-second', parentThreadId: MAIN, status: { type: 'idle' } },
      ],
      contents: {
        [CHILD]: { thread: { id: CHILD, turns: [] }, items: [] },
        'thread-second': { thread: { id: 'thread-second', turns: [] }, items: [] },
      },
    });
    // 主线程自己有用量通知、第二个子线程没有 ⇒ 两格一起 null
    expect(result.subagentTokens).toBeNull();
    expect(result.subagentTurns).toBeNull();
  });

  it('主 + 子都有用量 ⇒ 合计与分量成对交出；轮次同一把尺（`subagentTurns ≤ turns`）', async () => {
    const notifications: FakeNotification[] = [
      tokenUsageUpdated({ inputTokens: 1000, cachedInputTokens: 900, outputTokens: 50 }, { threadId: MAIN }),
      tokenUsageUpdated({ inputTokens: 30, cachedInputTokens: 10, outputTokens: 5 }, { threadId: CHILD }),
      itemCompleted(answer('m1', '主线程答复'), { threadId: MAIN, turnId: 'turn-1' }),
      turnCompleted({ id: 'turn-1', items: [answer('m1', '主线程答复')] }, { threadId: MAIN }),
    ];
    const { result, events } = await collect({
      notifications,
      threads: [{ id: CHILD, parentThreadId: MAIN, status: { type: 'idle' } }],
      contents: {
        [CHILD]: {
          thread: { id: CHILD, turns: [] },
          items: [
            { turnId: 'ct1', item: answer('cm1', '子线程第一轮') },
            { turnId: 'ct2', item: answer('cm2', '子线程第二轮') },
          ],
        },
      },
    });
    // 主线程归一后 input = 1000 − 900 = 100；子线程归一后 input = 30 − 10 = 20
    // `total` 记 `null`：分量非零 ⇒ 合计是**我们的**算术，不再是任何一个线程的厂商累计快照
    // （`sumUsageTokens` 的口径，守卫在 `usage.test.ts`）
    expect(result.tokens).toEqual({ input: 120, cached: 910, output: 55, reasoningOutput: 0, total: null });
    // 分量那一份的 `total` 恒 `null`：它是**多个**子线程的相加结果，没有哪一个厂商快照配得上这一格
    expect(result.subagentTokens).toEqual({ input: 20, cached: 10, output: 5, reasoningOutput: 0, total: null });
    // 轮次：主 1 + 子 2 = 3；分量 2 ⇒ 分子分母同源
    expect(result.turns).toBe(3);
    expect(result.subagentTurns).toBe(2);

    const last = events.filter((event) => event.type === 'usage').at(-1);
    expect(last?.type === 'usage' ? last.turns : null).toBe(3);
    expect(last?.type === 'usage' ? last.subagentTurns : 'not-usage').toBe(2);
    expect(last?.type === 'usage' ? last.subagentTokens?.input : null).toBe(20);
    // 归属是**主线程**的轮次（不是合计 3），会话恒为 `null`
    expect(last?.type === 'usage' ? last.turn : 'not-usage').toEqual({ subagentId: null, round: 1 });
  });

  it('主线程用量在 `turn/completed` 交出，并带厂商时刻换算的时长；`apiMs`/`ttftMs` 恒 `null`', async () => {
    const { events } = await collect({
      notifications: [
        tokenUsageUpdated({ inputTokens: 8152, cachedInputTokens: 6656, outputTokens: 30 }, { threadId: MAIN }),
        itemCompleted(answer('m1', '答复'), { threadId: MAIN, turnId: 'turn-1' }),
        turnCompleted(
          { id: 'turn-1', items: [answer('m1', '答复')], startedAt: 1_700_000_000, completedAt: 1_700_000_011, durationMs: 11_000 },
          { threadId: MAIN },
        ),
      ],
    });
    /**
     * 取**带时长的**那一条：收尾在流结束后还会补一条 `usage`（它只交计量与轮次，`timing` 是 `null`
     * ——那一刻没有新的厂商时刻可报），故 `.at(-1)` 拿到的是那一条，钉不住「`turn/completed` 交出时长」。
     */
    const expensive = events.filter((event) => event.type === 'usage' && event.tokens !== null && event.timing !== null).at(-1);
    // `input` 减 cached：8152 − 6656 = 1496（与另两家同一口径）
    // `total` 是厂商自报的那一格，原样透传（夹具给的就是 8152 + 30）；`breakdownToTokens` 不替厂商算
    expect(expensive?.type === 'usage' ? expensive.tokens : null).toEqual({
      input: 1496,
      cached: 6656,
      output: 30,
      reasoningOutput: 0,
      total: 8182,
    });
    /**
     * 时长由厂商的**绝对时刻**换算而来：`startedAt` / `completedAt` 是秒（app-server 的 `Turn`），
     * 二者相差 11 秒 ⇒ `totalMs: 11000`；`apiMs` / `ttftMs` 恒 `null`——codex 没有这两个测量，
     * 不拿 `totalMs` 冒充（与另两家同一口径的缺省）。
     */
    expect(expensive?.type === 'usage' ? expensive.timing : 'not-usage').toEqual({
      totalMs: 11_000,
      apiMs: null,
      ttftMs: null,
      source: 'events',
    });
  });

  it('`turn/completed` 失败 ⇒ 该行失败，归因取厂商原文（401 ⇒ AUTH_FAILED）', async () => {
    const { result, events } = await collect({
      notifications: [turnCompleted({ id: 'turn-1', status: 'failed', error: { message: 'unexpected status 401: 密钥无效' } }, { threadId: MAIN })],
    });
    expect(result).toMatchObject({ ok: false, exitReason: 'error' });
    expect(result.error?.code).toBe('AUTH_FAILED');
    expect(events.some((event) => event.type === 'error')).toBe(true);
  });

  it('`error` 通知只落 WARN，不改结论（过路报错不代表这一轮的结论）', async () => {
    const { result, events } = await collect({
      notifications: [
        errorNotification('Reconnecting… 5/5'),
        itemCompleted(answer('m1', '答复'), { threadId: MAIN, turnId: 'turn-1' }),
        turnCompleted({ id: 'turn-1', items: [answer('m1', '答复')] }, { threadId: MAIN }),
      ],
    });
    expect(result.ok).toBe(true);
    const logs = events.filter((event) => event.type === 'log').map((event) => (event.type === 'log' ? event.text : ''));
    expect(logs.some((text) => text.includes('Reconnecting… 5/5'))).toBe(true);
  });

  it('用户终止：发 `turn/interrupt`，结论是 canceled 而不是失败', async () => {
    const controller = new AbortController();
    const server = wire({ hang: true });
    const running = codexProvider.run(createRunInput({ signal: controller.signal }));
    await Promise.resolve();
    controller.abort();
    const result = await running;
    expect(result.exitReason).toBe('canceled');
    expect(server.stats.requests.some((one) => one.method === 'turn/interrupt')).toBe(true);
  });

  it('终止不等收尾取数：上游那一轮不再产终态时，取消**立刻**收场（不拖满释放宽限期）', async () => {
    const controller = new AbortController();
    wire({ hang: true });
    const startedAt = Date.now();
    const running = codexProvider.run(createRunInput({ signal: controller.signal }));
    // 让 `initialize` → `thread/start` → `turn/start` 走完，此刻收尾取数还卡在 `settled` 上
    for (let tick = 0; tick < 10; tick += 1) await Promise.resolve();
    controller.abort();
    const result = await running;
    /**
     * 判据是**墙钟**而不是终态：终态两条路都是 `canceled`，区别只在「等不等」。
     * `hangUntilTerminal` 下上游不再产终态 ⇒ 通知流停在 await 上，若不与 `signal.aborted`
     * 竞速，这一次取消要等 `releaseTurn` 的释放宽限期（`RELEASE_GRACE_MS` = 5s）才收场。
     * 门槛取 4s：远高于正常路径的毫秒级，又稳稳低于那条宽限期。
     */
    expect(Date.now() - startedAt).toBeLessThan(4_000);
    expect(result.exitReason).toBe('canceled');
    // 取数没落定**不是**失败：终止给的归因是 `AGENT_CANCELED`，不是取数缺失造出来的错
    expect(result.error?.code).toBe('AGENT_CANCELED');
  });
});

describe('能力声明与 dsh 的逐格对齐', () => {
  it('六格与五条取数通道逐格同形，唯一差异是已登记的适配器缺口（`source` / `reason` 与实际取值一致）', () => {
    const providers = listAgentProviders();
    const codex = providers.find((one) => one.kind === 'codex')?.metadata.messageCapability;
    const dsh = providers.find((one) => one.kind === 'dsh')?.metadata.messageCapability;
    expect(codex).toBeDefined();
    expect(dsh).toBeDefined();
    /**
     * 两个方向都要钉住，别把这条写成「除了 `streamingDelta` 随便」：
     *   · 其余五格 + 四条取数通道必须逐格同形（原本的设计意图：两家能力面同形）；
     *   · `streamingDelta` 这一格**已知不同**，且差异有据：codex 的 app-server 有 `agentMessageDelta`
     *     ⇒ 记 `yes` + `wire`；dsh 的通知流不投送增量（2026-10-07 真机实测：一次往返 20 条通知、
     *     增量类 0 条、正文只有整块 `assistant/message`）⇒ 记 `not-projected-by-vendor` + `not-exposed`。
     *     依据：`docs/faq/deepseek-harness.md` 首条、`dsh/index.ts` 的 `notes` 第一条。
     *   任一侧被改都会让这条红——要改就连同依据一起改。
     */
    for (const cell of ['thinkingText', 'thinkingTextKind', 'toolInput', 'toolResult', 'subagent'] as const) {
      expect(codex?.[cell], `能力格 ${cell} 与 dsh 不一致`).toEqual(dsh?.[cell]);
    }
    for (const cell of ['thinkingTextSource', 'toolInputSource', 'toolResultSource', 'subagentSource'] as const) {
      expect(codex?.[cell], `取数通道 ${cell} 与 dsh 不一致`).toEqual(dsh?.[cell]);
    }
    expect(codex?.streamingDelta).toBe('yes');
    expect(codex?.streamingDeltaSource).toBe('wire');
    expect(dsh?.streamingDelta).toBe('not-projected-by-vendor');
    expect(dsh?.streamingDeltaSource).toBeNull();
    expect(dsh?.streamingDeltaReason).toBe('not-exposed');
  });

  it('`reasoningOutput` / `total` / `cancelMidTurn` / `structuredOutput` 不降级', () => {
    const codex = listAgentProviders().find((one) => one.kind === 'codex');
    expect(codex?.metadata.capability).toEqual({ cancelMidTurn: true, usage: true, structuredOutput: true });
  });

  it('说明面不留与实际不符的话（运行期**是**实时投递的，不是「只在结束投一次」）', () => {
    const notes = listAgentProviders().find((one) => one.kind === 'codex')?.metadata.messageCapability.notes ?? [];
    expect(notes.some((note) => note.includes('只在**运行结束**时'))).toBe(false);
    expect(notes.length).toBeGreaterThan(0);
  });
});

describe('纯函数：配置构造', () => {
  it('两格只在已知时出现（`undefined` ⇒ 键整个不存在）', () => {
    const bare = buildCodexConfig('https://gw/v1');
    expect(Object.hasOwn(bare, 'model_context_window')).toBe(false);
    expect(Object.hasOwn(bare, 'model_reasoning_summary')).toBe(false);
    const both = buildCodexConfig('https://gw/v1', 1_048_576, 'none');
    expect(both).toMatchObject({ model_context_window: 1_048_576, model_reasoning_summary: 'none' });
  });
});
