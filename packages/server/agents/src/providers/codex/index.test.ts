// @vitest-environment node
/**
 * codex 适配器的**接线**契约：注入落点、通知贯通、收尾取数、用量与轮次、能力声明。
 *
 * 夹具分工：`appserver-fixtures.ts` 给一个假 app-server 客户端（推通知、答请求，不 spawn），
 * 本文件只钉「适配器有没有把该交的东西交到该去的地方」——协议本身的形状由 `appserver/*.test.ts` 覆盖。
 */
import { EFFORT_OFF, type AgentEvent, type AgentMessage, type SubagentRecord } from '@aieval/contracts';
import { describe, expect, it, vi } from 'vitest';
import { listAgentProviders } from '../../registry';
import { collectEvents, createRunInput, FIXTURE_CWD } from '../../testing/agent-fixtures';
import type { AgentRunResult, AskUserReply, AskUserRequest } from '../../types';
import { createAppServerClient } from './appserver/client';
// ⚠️ 跨文件 import 夹具：那一条是「回帧真的写进 stdin」唯一看得见的地方（见用例注释）
import { FakeChild } from './appserver/client.test';
import {
  agentMessageDelta,
  createFakeAppServer,
  errorNotification,
  itemCompleted,
  itemStarted,
  reasoningTextDelta,
  threadItemsPages,
  threadListPages,
  threadTurnsPages,
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
    {
      // `turns` / `items` 是 `thread/turns/list` 与 `thread/items/list` 两页应答的来源：
      // 声明在这里而不是留在 `Record<string, unknown>` 里，分页夹具才拿得到元素类型
      thread: Record<string, unknown> & {
        id: string;
        turns?: ReadonlyArray<Record<string, unknown> & { id: string }>;
      };
      items?: ReadonlyArray<{ turnId: string; item: Record<string, unknown> }>;
    }
  >;
  threadId?: string;
  threadError?: unknown;
  /** 「某个请求处理到一半时投递这些通知」（见夹具的同名选项）：复现「响应还没回来、通知先到」 */
  emitOnRequest?: Record<string, readonly FakeNotification[]>;
}

/** 把假 app-server 接到 provider 的注入口上（`createClient` 恒返回同一个实例 = 会话与取数共用） */
function wire(scenario: Scenario = {}): FakeAppServer {
  const server = createFakeAppServer({
    ...(scenario.threadId === undefined ? {} : { threadId: scenario.threadId }),
    ...(scenario.notifications === undefined ? {} : { notifications: scenario.notifications }),
    ...(scenario.threadError === undefined ? {} : { threadError: scenario.threadError }),
    ...(scenario.emitOnRequest === undefined ? {} : { emitOnRequest: scenario.emitOnRequest }),
    hangUntilTerminal: scenario.hang === true,
    respond: {
      'thread/list': threadListPages(scenario.threads ?? [], 100),
      // 元数据（不带 includeTurns）与轮次分两次取：轮次走 `thread/turns/list`（见 reader.ts）
      'thread/read': (params) => {
        const content = scenario.contents?.[String(params.threadId)];
        return content === undefined ? { thread: null } : { thread: { ...content.thread, turns: undefined } };
      },
      'thread/turns/list': (params) => {
        const content = scenario.contents?.[String(params.threadId)];
        return threadTurnsPages(content?.thread.turns ?? [], 100)(params);
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
      /**
       * 内置联网工具的开关在**顶层** `web_search`：真机五臂（`arms/arm-websearch.mjs`）里
       * `tools.web_search=false` 那一格给不给，出站请求体的工具表**逐字相同**（`type:"web_search"` 一直在），
       * 而 `web_search:"disabled"` 一给就消失。故这一格钉在顶层，`tools` 只管参数容器与计划工具。
       */
      web_search: 'disabled',
      tools: { update_plan: { enabled: true } },
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
   * ⚠️ **Windows 上的例外**：codex 的受限沙箱在该平台起不了任何子进程
   * （`read-only` / `workspace-write` 下连 `echo`、`git status` 都被 policy 拒），而它读文件只能靠
   * shell ⇒ 只读档会变成盲评。故 **Windows 上评分阶段落最宽档**，靠编排层的「评分前后 diff 摘要
   * 对照」兜底（不一致即该候选失败）。豁免的逐格判据在 `permission.test.ts`，这里钉的是**接线**
   * ——适配器确实用了 `codexPermissionOptions()` 的那一份，而不是绕过它去索引常量表。
   */
  it('评分阶段的权限档：非 Windows 是 `read-only`、Windows 落最宽档（豁免不许绕过翻译层）', async () => {
    const expected = process.platform === 'win32' ? 'danger-full-access' : 'read-only';
    const server = wire({ notifications: [turnCompleted({ id: 'turn-1' }, { threadId: MAIN })] });
    await codexProvider.run(createRunInput({ permission: 'read-only' }));
    expect(server.stats.requests[1]?.params).toMatchObject({ sandbox: expected, approvalPolicy: 'never' });
  });

  /**
   * 那两格提问开关**只在挂了应答面时**并进 `thread/start` 的线程级 config。
   *
   * 为什么必须落到**请求侧**（而不是只测纯函数）：开关是在 `thread/start` 里交给厂商的，
   * 而「有没有真的交出去」只有假 app-server 的 RPC 台账看得见；纯函数那条守卫管不到「调用方有没有
   * 把那一位传对」。两件事都错了才叫漏：开关本身编码错（纯函数那条）或这一位没接上（这一条）。
   *
   * 不挂应答面时要求**逐字不变**：开了开关却没人答时厂商会一直等那一帧（`isBlocking: false` 与
   * `autoResolutionMs: null` 都不让它自己收场），⇒ 「不问就不动」是安全边界。
   */
  it('提问工具开关：挂了应答面才开这两格；不挂时 `tools` / `features` 逐字不变', async () => {
    const withCallback = wire({ notifications: [turnCompleted({ id: 'turn-1' }, { threadId: MAIN })] });
    await codexProvider.run(
      createRunInput({
        onAskUser: async (): Promise<AskUserReply> => ({ outcome: 'answered', answers: null }),
      }),
    );
    const askedConfig = (withCallback.stats.requests[1]?.params as { config: Record<string, unknown> }).config;
    expect(askedConfig['web_search']).toBe('disabled');
    expect(askedConfig['tools']).toEqual({
      update_plan: { enabled: true },
      experimental_request_user_input: { enabled: true },
    });
    expect(askedConfig['features']).toEqual({ multi_agent: true, default_mode_request_user_input: true });

    const control = wire({ notifications: [turnCompleted({ id: 'turn-1' }, { threadId: MAIN })] });
    await codexProvider.run(createRunInput());
    const bareConfig = (control.stats.requests[1]?.params as { config: Record<string, unknown> }).config;
    expect(bareConfig['web_search']).toBe('disabled');
    expect(bareConfig['tools']).toEqual({ update_plan: { enabled: true } });
    expect(bareConfig['features']).toEqual({ multi_agent: true });
  });

  /**
   * **回帧那条链路的接线**：厂商下发服务端请求 → 真客户端分类 → 应答者 → 真写进 stdin。
   *
   * 为什么这条不并进 `ask-user.test.ts`（那里有更细的形状判据）：那一条验的是应答者本身，
   * 而「这一次运行到底有没有把应答者交给客户端」只有这里看得见——漏接的表现是**静默**的
   * （请求照旧到达、厂商照旧一直等那一帧，不报错、不产事件）。两条用例分工：
   * 这条判「接没接上」，那条判「接上之后回的是什么」。
   */
  it('厂商的服务端请求：审批类不回帧、提问类回帧并写回 stdin', async () => {
    const child = new FakeChild();
    const server = createFakeAppServer({
      // 取数面的最小应答（收尾会问这三个方法）
      respond: {
        'thread/list': () => ({ data: [], nextCursor: null }),
        'thread/read': () => ({ thread: { id: 'thread-main', turns: [] } }),
        'thread/items/list': () => ({ data: [], nextCursor: null }),
      },
    });
    /**
     * 真客户端 + 假子进程：**应答者必须由注入口原样交下来**（产品那条链路上它是
     * `defaultCodexRuntimeHooks.createClient` 收到的那个入参）。写成 `createClient: () => client`
     * 会把这一格吃掉——那时回帧通道整条是空的，而用例只会看到「没有人被问过」。
     */
    codexProvider.runtimeHooks = {
      resolveBinary: () => 'C:/fake/codex.exe',
      createClient: (clientInput) => createAppServerClient({
        binary: clientInput.binary,
        env: clientInput.env,
        spawnFn: () => child,
        ...(clientInput.onServerRequest === undefined ? {} : { onServerRequest: clientInput.onServerRequest }),
      }),
    };
    const asked: AskUserRequest[] = [];
    const running = codexProvider.run(
      createRunInput({
        onAskUser: (request) => {
          asked.push(request);
          return Promise.resolve({ outcome: 'answered', answers: [{ header: '选路径', selected: ['选项 A'], custom: null }] });
        },
      }),
    );
    // 起手三步走完（订阅是在 `thread/start` / `turn/start` 之后建立的），再投两条服务端请求
    await new Promise((resolve) => setTimeout(resolve, 0));
    /** 此刻已经写过几帧（`initialize` 那一条）：判据只看**这一条提问带来的**写回 */
    const writtenBeforeAsk = child.written.length;
    child.emit(
      { jsonrpc: '2.0', id: 41, method: 'item/commandExecution/requestApproval', params: { threadId: server.threadId } },
      {
        jsonrpc: '2.0',
        id: 42,
        method: 'item/tool/requestUserInput',
        params: {
          itemId: 'call_ask_1',
          threadId: server.threadId,
          turnId: 'turn-1',
          isBlocking: false,
          autoResolutionMs: null,
          questions: [{ id: 'q1', header: '选路径', question: '用哪条路径？' }],
        },
      },
    );
    await vi.waitFor(() => {
      // 等到**端口被问过**：回帧比回调晚一步（应答帧要等答复），故不能拿它当「这一问到没到」的判据
      expect(asked).toHaveLength(1);
    });
    await vi.waitFor(() => {
      // 提问那一帧写回去了（审批那一帧**不写**：这一场里带 result 的服务端请求帧只有它一条）
      expect(child.written).toHaveLength(writtenBeforeAsk + 1);
    });
    expect(asked[0]?.callId).toBe('call_ask_1');
    expect(JSON.parse(child.written.at(-1) ?? '')).toEqual({
      jsonrpc: '2.0',
      id: 42,
      result: { answers: { q1: { answers: ['选项 A'] } } },
    });
    // 收尾：投终态让这一轮结束，免得用例挂在默认超时上
    server.emit('turn/completed', { threadId: server.threadId, turn: { id: server.turnId, items: [], status: 'completed' } });
    await running;
  });

  /**
   * **提问那一半进账本**：厂商的提问是 server→client 请求，而它的线程条目里**没有这一格**
   * （`ThreadItem` 的变体逐个核对过）⇒ 账本里那条 assistant `tool-call` 没有第二个来源，
   * 只能由观察到请求的适配器补。不补的症状是界面上只剩一条**没有题目**的答复行——
   * `ask-user` 卡片唯一由 `payload.kind === 'ask-user'` 驱动（`build-model.ts`）。
   *
   * 三格判据：
   *   · `callId` 取厂商的 `itemId`，且**与端口收到的那次请求逐字相同**——卡片靠 `callId` 跨账本配对，
   *     编排层写的答复那一半用的也是它，错开就是「有卡片没答案」或反过来；
   *   · 形状与另三家 wire 上那条逐字同形（`family` 按工具名归族、`payload` 由公共层归一）：
   *     展示侧因此不必知道这一家的提问不走条目流；
   *   · **审批类请求一条消息都不产**（它连帧都不回，见上一条用例）：同一场里两件事一起判，
   *     否则「顺手给所有服务端请求都投一条」这种改法不会被拦住。
   *
   * 入参用**真机 `item/tool/requestUserInput` 的逐字形状**（10 号真机 run 的 codex 行）：
   * 两题、各三个候选项、`isOther` / `isSecret` 都在。
   */
  it('提问请求 → 账本补出那条 assistant `tool-call`；审批类请求不产消息', async () => {
    const child = new FakeChild();
    /**
     * 真客户端 + 假子进程这一条路上，**握手与取数面的请求要人工答**：假 app-server 只投通知，
     * 而这条用例验的正是「服务端请求」那条只有真客户端走得通的通道 ⇒ 不能换夹具。
     * 应答器按「还没答过的 id」逐帧答（幂等，可以在收尾期间反复调）。
     */
    const answered = new Set<number>();
    const answerChild = (): void => {
      for (const line of child.written) {
        const frame = JSON.parse(line) as { id?: unknown; method?: unknown };
        if (typeof frame.id !== 'number' || typeof frame.method !== 'string' || answered.has(frame.id)) continue;
        answered.add(frame.id);
        const byMethod: Record<string, unknown> = {
          'thread/start': { thread: { id: MAIN } },
          'turn/start': { turn: { id: 'turn-1', items: [], status: 'inProgress' } },
          // 收尾取数：空线程树（内容那一格恒 `null` 不影响本用例的判据）
          'thread/list': { data: [], nextCursor: null },
          'thread/read': { thread: null },
          'thread/items/list': { data: [], nextCursor: null },
        };
        child.emit({ jsonrpc: '2.0', id: frame.id, result: byMethod[frame.method] ?? {} });
      }
    };
    const messages: AgentMessage[] = [];
    const asked: AskUserRequest[] = [];
    codexProvider.runtimeHooks = {
      resolveBinary: () => 'C:/fake/codex.exe',
      createClient: (clientInput) => createAppServerClient({
        binary: clientInput.binary,
        env: clientInput.env,
        spawnFn: () => child,
        ...(clientInput.onServerRequest === undefined ? {} : { onServerRequest: clientInput.onServerRequest }),
      }),
    };
    const running = codexProvider.run(
      createRunInput({
        onMessage: (message) => {
          messages.push(message);
        },
        onAskUser: (request) => {
          asked.push(request);
          return Promise.resolve({
            outcome: 'answered',
            answers: [
              { header: '动物单选', selected: [], custom: '兔' },
              { header: '植物多选', selected: [], custom: '月季、杜鹃' },
            ],
          });
        },
      }),
    );
    // 心跳式应答：握手 → 提问 → 终态 → 收尾取数，每一步的请求都要有人回
    const pump = setInterval(answerChild, 5);
    try {
      await vi.waitFor(() => {
        // 等到 `turn/start` 写出去：它排在 `thread/start` 的响应之后 ⇒ 主线程 id 已落定。
        // 这一条要走的正是**正常那一支**（「请求早于 thread/start」是另一条带 WARN 的分支）
        expect(child.written.some((line) => line.includes('"turn/start"'))).toBe(true);
      });
      // 审批类先来：它与提问走同一条服务端请求通道，判据是「没在账本里留下任何东西」
      child.emit(
        { jsonrpc: '2.0', id: 41, method: 'item/commandExecution/requestApproval', params: { threadId: MAIN } },
        {
          jsonrpc: '2.0',
          id: 42,
          method: 'item/tool/requestUserInput',
          params: {
            itemId: 'call_00_jhIII03ANulkj1Hw1TVC8940',
            threadId: MAIN,
            turnId: 'turn-1',
            isBlocking: false,
            autoResolutionMs: null,
            questions: [
              {
                id: 'favorite_animal',
                header: '动物单选',
                question: '第 1 题（单选）：下面三种动物你最喜欢哪一种？',
                options: [
                  { label: '猫 (Recommended)', description: '独立、安静，适合室内饲养。' },
                  { label: '狗', description: '热情、忠诚，需要较多陪伴与运动。' },
                  { label: '海豚', description: '聪明、社会性强的海洋哺乳动物。' },
                ],
                isOther: false,
                isSecret: false,
              },
              {
                id: 'favorite_plants',
                header: '植物多选',
                question: '第 2 题（多选，可勾选多个）：下面三种植物中，你感兴趣的有哪些？',
                options: [
                  { label: '多肉植物 (Recommended)', description: '耐旱好养，适合阳台和办公桌。' },
                  { label: '蕨类植物', description: '喜阴喜湿，能提升室内湿度感。' },
                  { label: '香草植物', description: '如罗勒、薄荷，可观赏也可入菜。' },
                ],
                isOther: false,
                isSecret: false,
              },
            ],
          },
        },
      );
      await vi.waitFor(() => {
        expect(asked).toHaveLength(1);
      });

      const calls = messages.flatMap((message) => message.blocks.filter((block) => block.type === 'tool-call'));
      expect(calls).toHaveLength(1);
      const [call] = calls;
      expect(call).toMatchObject({
        callId: 'call_00_jhIII03ANulkj1Hw1TVC8940',
        family: 'ask-user',
        name: 'request_user_input',
      });
      // 配对键：卡片的 `callId` 必须与端口那次请求、以及编排层答复那一半用的是同一个
      expect(call?.callId).toBe(asked[0]?.callId);
      expect(call?.type === 'tool-call' ? call.payload : null).toEqual({
        kind: 'ask-user',
        questions: [
          {
            header: '动物单选',
            prompt: '第 1 题（单选）：下面三种动物你最喜欢哪一种？',
            options: [
              { label: '猫 (Recommended)', description: '独立、安静，适合室内饲养。', recommended: false },
              { label: '狗', description: '热情、忠诚，需要较多陪伴与运动。', recommended: false },
              { label: '海豚', description: '聪明、社会性强的海洋哺乳动物。', recommended: false },
            ],
            // 厂商没有这两格 ⇒ 如实落 `false`（编个默认值会让族载荷与判据一起说谎）
            multiSelect: false,
            allowOther: false,
            secret: false,
          },
          {
            header: '植物多选',
            prompt: '第 2 题（多选，可勾选多个）：下面三种植物中，你感兴趣的有哪些？',
            options: [
              { label: '多肉植物 (Recommended)', description: '耐旱好养，适合阳台和办公桌。', recommended: false },
              { label: '蕨类植物', description: '喜阴喜湿，能提升室内湿度感。', recommended: false },
              { label: '香草植物', description: '如罗勒、薄荷，可观赏也可入菜。', recommended: false },
            ],
            multiSelect: false,
            allowOther: false,
            secret: false,
          },
        ],
      });

      // 收尾：本轮终态由**这一条真客户端的通道**投下去（假 app-server 的 `emit` 在这条路上没有订阅者，
      // 投给它等于没投——那样这一轮只能等客户端的 30 s 请求超时，用例白等半分钟）
      child.emit({
        jsonrpc: '2.0',
        method: 'turn/completed',
        params: { threadId: MAIN, turn: { id: 'turn-1', items: [], status: 'completed' } },
      });
      await running;
    } finally {
      clearInterval(pump);
    }
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

  /**
   * **档位同时写进线程级 config**（`model_reasoning_effort`）。
   *
   * 要拦的缺陷：只把档位给 `turn/start`。那一格只管它起的那一轮，而人话续跑起的那一轮走
   * `thread/queue/start`——那个请求的参数**只有** `threadId` 与 `queuedSubmissionId`（探针 dump
   * `v2/ThreadQueueStartParams.json` 的 `required`），带不了档位 ⇒ 不给线程级这一格，续跑那一轮
   * 会按线程默认档跑，而候选快照上写着用户选的那一档（一句半真话）。
   */
  it('档位同时进线程级 `config.model_reasoning_effort`（续跑那一轮带不了 effort 参数，只能靠它）', async () => {
    const server = wire({ notifications: [turnCompleted({ id: 'turn-1' }, { threadId: MAIN })] });
    await codexProvider.run(createRunInput({ effort: 'high' }));
    expect(server.stats.requests[1]?.params).toMatchObject({ config: { model_reasoning_effort: 'high' } });

    // 关闭档同样要翻名：契约/界面用 `off`，CLI 那一侧只认 `none`
    const off = wire({ notifications: [turnCompleted({ id: 'turn-1' }, { threadId: MAIN })] });
    await codexProvider.run(createRunInput({ effort: EFFORT_OFF }));
    expect(off.stats.requests[1]?.params).toMatchObject({ config: { model_reasoning_effort: 'none' } });

    // 未选档 ⇒ 整个键都不给（「我们没意见」的形态，与另外两格同一条口径）
    const bare = wire({ notifications: [turnCompleted({ id: 'turn-1' }, { threadId: MAIN })] });
    await codexProvider.run(createRunInput());
    const bareConfig = (bare.stats.requests[1]?.params as { config: Record<string, unknown> }).config;
    expect(Object.hasOwn(bareConfig, 'model_reasoning_effort')).toBe(false);
  });

  it('其它档位与未选都不带那两格键（形态判据用 `Object.hasOwn`）', async () => {    const withEffort = wire({ notifications: [turnCompleted({ id: 'turn-1' }, { threadId: MAIN })] });
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
      {
        type: 'tool-call',
        callId: 'c1',
        family: 'run-shell',
        name: 'exec_command',
        input: { command: 'npm test', cwd: 'D:/w' },
        payload: null,
        // 摘要主体随块给出（唯一构造点 `toolCallBlockDraft` 里算）；
        // 活动行那一句（带 `调用工具 exec_command：` 前缀）由 `events.ts` 另算，见 events.test.ts
        summary: 'npm test',
      },
      { type: 'tool-result', callId: 'c1', structured: { exitCode: 0, durationMs: 12 }, isError: false, text: 'ok', truncation: { kind: 'unknown' } },
    ]);
  });

  it('`fileChange` ⇒ `apply_patch` 调用 + 结构化结果（这一格此前在消息面上没有）', async () => {
    /**
     * ⚠️ 这一格喂的是**厂商线面的形状**（它要过 `readItem`）：`changes[].kind` 是**带标签的对象**
     * `{type:'update'}`，不是字符串。写成字符串这一条会**假绿**——`readString` 恰好在那个形状上读得出值，
     * 而真机上厂商给的是对象 ⇒ 真机 `kind` 恒 `null`（真机判据见 `file-change-live.test.ts`）。
     */
    const { messages } = await collect({
      notifications: [
        itemCompleted(
          { type: 'fileChange', id: 'f1', status: 'completed', changes: [{ path: 'src/a.ts', kind: { type: 'update' }, diff: '+' }] },
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

  it('`mcpToolCall` ⇒ 「`mcp__服务名__工具名`」+ `family: null` + `isError`（看错误对象）', async () => {
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
      { type: 'tool-call', family: null, name: 'mcp__fs__read', input: { path: 'a' } },
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

  /**
   * 夹具的投递语义**与真实客户端逐字相同**：没有订阅者时通知进历史列表、但**不投递给任何人**。
   *
   * 为什么这条值得一条守卫：夹具原来是「缓冲到首个订阅者再补投」——比真实**更宽容**，
   * 而它正好盖住了「适配器订阅晚于 `thread/start` ⇒ MCP 启动状态全丢」那条真机缺陷（
   * 行照旧出分）。夹具一旦比真实宽容，这类缺陷在单测里就永远看不见。
   */
  it('没有订阅者时通知不投递（历史列表照留），订阅之后才即时到达', () => {
    const server = createFakeAppServer({});
    server.emit('thread/started', { thread: { id: MAIN } });

    const received: string[] = [];
    const off = server.client.subscribe((notification) => {
      received.push(notification.method);
    });
    // 订阅之前那条**没有**补投（与真实客户端一致）
    expect(received).toEqual([]);
    // 历史列表仍留着它（`notifications()` 是排障用的那一份）
    expect(server.client.notifications().map((one) => one.method)).toEqual(['thread/started']);

    server.emit('item/completed', { threadId: MAIN, turnId: 'turn-1', item: answer('m1', '答复') });
    expect(received).toEqual(['item/completed']);
    off();
  });

  /**
   * **订阅必须早于 `thread/start`**（codex 判据）。
   *
   * 真机时序（探针实测）：`thread/start` +119 ms 返回，MCP 的 `starting` 与 `failed` 两条在
   * `turn/start` 返回（+135 ms）之前**全部到齐** ⇒ 订阅若挂在 `turn/start` 之后，这两条一条都收不到。
   * 症状是「MCP 明明没起来，行照旧出分」，而且**只在失败时**才看得见（`ready` 往往晚到一步，
   * 于是成功路径看起来一切正常）。这条守卫就是那颗钉子：把订阅挪回 `turn/start` 之后 ⇒ 当场红。
   */
  it('`thread/start` 期间投递的 MCP 启动状态必须进流（订阅早于建线程）', async () => {
    const { events } = await collect({
      // 「响应还没回来、通知先到」的真实时序（真机：`thread/start` +119 ms 返回，两条启动状态 +135 ms 前到齐）
      emitOnRequest: {
        'thread/start': [
          {
            method: 'mcpServer/startupStatus/updated',
            params: {
              threadId: MAIN,
              name: 'probe',
              status: 'failed',
              error: 'MCP client for `probe` failed to start: MCP startup failed: No such file or directory (os error 2)',
              failureReason: null,
            },
          },
        ],
      },
      notifications: [turnCompleted({ id: 'turn-1' }, { threadId: MAIN })],
    });

    expect(events.filter((event) => event.type === 'vendor-system')).toMatchObject([
      {
        mcpChannel: 'vendor-startup-status',
        mcpServers: [
          {
            name: 'probe',
            status: 'failed',
            error: 'MCP client for `probe` failed to start: MCP startup failed: No such file or directory (os error 2)',
          },
        ],
      },
    ]);
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
    /**
     * 收尾取数**两步走**：元数据 `thread/read`（**不带** `includeTurns`——带着它就是厂商已弃用的
     * 全量水合，真机会投 `deprecationNotice`），轮次 `thread/turns/list`。
     * 两处都用**同一个客户端**（线程树是那个进程的内存态，换个客户端读不到）。
     */
    const readParams = server.stats.requests.find((one) => one.method === 'thread/read')?.params as Record<string, unknown>;
    expect(readParams).toMatchObject({ threadId: CHILD });
    expect(readParams).not.toHaveProperty('includeTurns');
    expect(server.stats.requests.find((one) => one.method === 'thread/turns/list')?.params).toMatchObject({ threadId: CHILD });
  });

  it('子线程的条目进消息流（带 `subagentId`），终态由 `turn.status` 推出（`failed` 那一档）', async () => {
    const { messages, subagents } = await collect({
      notifications: [turnCompleted({ id: 'turn-1', items: [answer('m1', '主线程答复')] }, { threadId: MAIN })],
      threads: [{ id: CHILD, parentThreadId: MAIN, agentNickname: '检查', status: { type: 'idle' } }],
      contents: {
        [CHILD]: {
          thread: {
            id: CHILD,
            turns: [{ id: 'ct1', items: [answer('cm1', '子线程答复')], itemsView: 'full', status: 'failed', error: { message: '子线程炸了' }, startedAt: null, completedAt: null, durationMs: null }],
          },
          items: [{ turnId: 'ct1', item: answer('cm1', '子线程答复') }],
        },
      },
    });
    const child = messages.filter((one) => one.subagentId === CHILD);
    expect(child.flatMap((one) => one.blocks)).toEqual([{ type: 'text', text: '子线程答复' }]);
    expect(subagents.find((one) => one.subagentId === CHILD)).toMatchObject({ status: 'failed', outcome: '子线程炸了', name: '检查' });
  });

  /**
   * **两条入口的同一条条目必须落在同一个载体上**（混合通道：上游把子线程的 `item/*` 推给了本连接，
   * 收尾又把同一批条目全量回读一遍）。
   *
   * 要拦的缺陷：载体键里的轮次号按「该线程此刻累计几轮」现算。运行期是逐条推进的（当下值恰好是
   * 本条的号），而收尾那一批**已经数过**（`countRoundTrips` 按身份去重、不再推进）⇒ 整批读到
   * **最终号**，于是第 1 轮那条条目在收尾拿到第 N 轮的载体键 ⇒ 同一句话出两份、且补齐的那份
   * 按到达顺序追加在最后一轮的块之后（第 1 轮的内容排在第 N 轮后面）。按 `mergeKey` 折叠**去不掉**
   * ——键本身就是被打破的那一格。
   *
   * 判据取「每条正文在折叠后的账本里恰好出现一次」，而不是消息条数：同一个载体收到两次投递
   * （运行期 + 收尾）是合法的幂等重发，合并器按键归位即可；不合法的是**键不同**。
   */
  it('混合通道：子线程条目既走运行期通知、又被收尾回读 ⇒ 每条正文只出一份，且各归自己那一轮', async () => {
    const childItems = [
      { turnId: 'ct1', item: answer('msg_aaa', '子答复甲') },
      { turnId: 'ct1', item: answer('msg_bbb', '子答复乙') },
    ];
    const { messages } = await collect({
      notifications: [
        // 真机形状：子线程的条目**推不推给本连接由上游决定**，这里是「推了」的那一档
        itemCompleted(answer('msg_aaa', '子答复甲'), { threadId: CHILD, turnId: 'ct1' }),
        itemCompleted(answer('msg_bbb', '子答复乙'), { threadId: CHILD, turnId: 'ct1' }),
        turnCompleted({ id: 'turn-1', items: [answer('msg_main', '主答复')] }, { threadId: MAIN }),
      ],
      threads: [{ id: CHILD, parentThreadId: MAIN, status: { type: 'idle' } }],
      contents: {
        [CHILD]: {
          thread: {
            id: CHILD,
            turns: [{ id: 'ct1', items: childItems.map((one) => one.item), itemsView: 'full', status: 'completed', error: null, startedAt: null, completedAt: null, durationMs: null }],
          },
          items: childItems,
        },
      },
    });

    const child = messages.filter((one) => one.subagentId === CHILD);
    // 按载体键折叠（后到的覆盖先到的）＝ 账本里那条逻辑消息的最终形态
    const folded = new Map<string, AgentMessage>();
    for (const one of child) folded.set(one.mergeKey, one);
    const texts = [...folded.values()].flatMap((one) => one.blocks).map((one) => (one.type === 'text' ? one.text : null));
    expect(texts.filter((one) => one === '子答复甲')).toHaveLength(1);
    expect(texts.filter((one) => one === '子答复乙')).toHaveLength(1);
    // 两条各归自己那一轮（甲在第 1 轮、乙在第 2 轮）——不是两条都挤在最终号上
    expect([...folded.values()].map((one) => ({ round: one.roundTrip, text: one.blocks[0]?.type === 'text' ? one.blocks[0].text : null }))).toEqual([
      { round: 1, text: '子答复甲' },
      { round: 2, text: '子答复乙' },
    ]);
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
    expect(logs.some((text) => text.includes(CHILD) && text.includes('用量没有采到'))).toBe(true);
  });

  /**
   * 用量通知**形状不全就整条不算**（归一化层的判据：六项齐全才认，见 `readTokenUsage`）。
   *
   * 这一条钉的是**两层判据的接缝**：归一化层挡掉残缺载荷 ⇒ `usageByThread` 里压根不会有它
   * ⇒ 收尾那一处「这条线程有没有用量」的判断与「求和时读不读出来」必然同向。接缝一旦松动
   * （归一化层将来放宽成「三项齐就认」），`usageOfRun` 里判据与求和同源这件事就是最后一道闸。
   */
  it('用量通知缺字段 ⇒ 整条不算，分量两格 `null` 并点名那条线程', async () => {
    const { result, events } = await collect({
      notifications: [
        /**
         * 缺 `outputTokens` 等格：`readTokenUsage` 要求六项齐全 ⇒ 这条通知整条落 `other`。
         * 刻意不用 `tokenUsageUpdated` 夹具：它总会把六项填齐，造不出这个形状。
         */
        {
          method: 'thread/tokenUsage/updated',
          params: {
            threadId: CHILD,
            turnId: 'ct1',
            tokenUsage: { total: { inputTokens: 10, cachedInputTokens: 1 }, last: null, modelContextWindow: null },
          },
        },
        turnCompleted({ id: 'turn-1', items: [answer('m1', '答复')] }, { threadId: MAIN }),
      ],
      threads: [{ id: CHILD, parentThreadId: MAIN, status: { type: 'idle' } }],
      contents: { [CHILD]: { thread: { id: CHILD, turns: [] }, items: [] } },
    });
    expect(result.subagentTokens).toBeNull();
    expect(result.subagentTurns).toBeNull();
    const logs = events.filter((event) => event.type === 'log').map((event) => (event.type === 'log' ? event.text : ''));
    expect(logs.some((text) => text.includes(CHILD) && text.includes('用量没有采到'))).toBe(true);
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
      itemCompleted(answer('msg_0a1b2c3d', '主线程答复'), { threadId: MAIN, turnId: 'turn-1' }),
      turnCompleted({ id: 'turn-1', items: [answer('msg_0a1b2c3d', '主线程答复')] }, { threadId: MAIN }),
    ];
    const { result, events } = await collect({
      notifications,
      threads: [{ id: CHILD, parentThreadId: MAIN, status: { type: 'idle' } }],
      contents: {
        [CHILD]: {
          thread: { id: CHILD, turns: [] },
          items: [
            { turnId: 'ct1', item: answer('msg_c11a22b3', '子线程第一轮') },
            { turnId: 'ct2', item: answer('msg_d44e55f6', '子线程第二轮') },
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

  it('`turn/completed` 失败 ⇒ 该候选失败，归因取厂商原文（401 ⇒ AUTH_FAILED）', async () => {
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

  /**
   * 取消那一轮**压根没做收尾取数**（见上一条：不等取数），所以分量缺失的归因必须说「没落定」，
   * 不许说「枚举失败」——后者会把「我们主动不采」读成「厂商枚举坏了」，方向正好相反。
   * 两条文案各有各的落点：枚举失败那一条由「子线程树枚举失败」那组用例钉住。
   */
  it('取消那一轮的缺失归因说「收尾取数没有落定」，不冒称「枚举失败」', async () => {
    const controller = new AbortController();
    const server = wire({ hang: true });
    const events: AgentEvent[] = [];
    const running = codexProvider.run(createRunInput({ signal: controller.signal, onEvent: (event) => events.push(event) }));
    for (let tick = 0; tick < 10; tick += 1) await Promise.resolve();
    controller.abort();
    await running;
    const logs = events.filter((event) => event.type === 'log').map((event) => (event.type === 'log' ? event.text : ''));
    expect(logs.some((text) => text.includes('收尾取数在终止之后没有拿到全量（这一轮被终止）'))).toBe(true);
    expect(logs.some((text) => text.includes('枚举失败'))).toBe(false);
    /**
     * 收尾取数**仍会尝试**枚举（它是后台任务，闸门是「流停下来」而不是「这一轮成功」），
     * 只是取消之后那一次多半拿到「客户端已关闭」⇒ 归因必须落在「终止」上——这正是上面两条钉的事。
     * 这一格不假设它跑没跑（跑与不跑都合法），只要求措辞不甩锅给厂商。
     */
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
     *     ⇒ 记 `yes` + `wire`；dsh 经 stream-tap 兑现（挂进厂商进程的插件采集
     *     `agent/assistant-stream`、旁路文件进适配器——stdio 通知流本身仍不投送，判例
     *     `docs/faq/deepseek-harness.md`）⇒ 记 `yes` + `hook`。
     *   任一侧被改都会让这条红——要改就连同依据一起改。
     */
    for (const cell of ['thinkingText', 'toolInput', 'toolResult', 'subagent'] as const) {
      expect(codex?.[cell], `能力格 ${cell} 与 dsh 不一致`).toEqual(dsh?.[cell]);
    }
    /**
     * **`thinkingTextKind` 是第二格「已知不同」**（按上面那条规矩：改它要连同依据一起改）。
     *
     * codex 这一格报 `summary` 是**按实测**：真网关 2 条路由 × 103 个路由-模型 × **153 格**往返里
     * `content[]` **非空 0 格**、`summary[]` 非空 40 格；协议上全文那条路确实存在（脚本式上游投
     * `reasoning_text` 时厂商会落在 `content[]`），但本仓拿不到 ⇒ 这一格描述的是「实测拿得到哪一档」。
     * dsh 仍报 `full`，**它没有做同类读数** —— 所以这是「一侧已按实测改正、另一侧未核」的差异，
     * 不是两家能力面天生不同。dsh 何时做同样的读数，就把这一格收回严格循环。
     */
    expect(codex?.thinkingTextKind, 'codex 按实测报 summary').toBe('summary');
    expect(dsh?.thinkingTextKind, 'dsh 未核，仍报 full').toBe('full');
    for (const cell of ['thinkingTextSource', 'toolInputSource', 'toolResultSource', 'subagentSource'] as const) {
      expect(codex?.[cell], `取数通道 ${cell} 与 dsh 不一致`).toEqual(dsh?.[cell]);
    }
    expect(codex?.streamingDelta).toBe('yes');
    expect(codex?.streamingDeltaSource).toBe('wire');
    expect(dsh?.streamingDelta).toBe('yes');
    expect(dsh?.streamingDeltaSource).toBe('hook');
    expect(dsh?.streamingDeltaReason).toBeNull();
  });

  it('`reasoningOutput` / `total` / `cancelMidTurn` 不降级', () => {
    const codex = listAgentProviders().find((one) => one.kind === 'codex');
    // 结构化输出没有能力位：走没走原生通道由适配器在 `TurnFinalize.applied` 里**按本次运行**上报
    // （守卫见 `registry.test.ts` 的「capability 只有两格」与 `turn.test.ts` 的 applied 搬运）
    expect(codex?.metadata.capability).toEqual({ cancelMidTurn: true, usage: true });
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
    const both = buildCodexConfig('https://gw/v1', { contextWindow: 1_048_576, reasoningSummary: 'none' });
    expect(both).toMatchObject({ model_context_window: 1_048_576, model_reasoning_summary: 'none' });
  });

  /**
   * MCP 的**落点**：`mcp_servers` 进同一格线程级 `config`。
   *
   * 为什么这条是「落点」而不是「形状」的守卫：形状由 `mcp.test.ts` 逐字钉住，而这里要钉的是
   * 「它到底有没有被放进协议参数」——漏放的失败方式是**静默**的（一台 MCP 都没注入，模型照样
   * 把任务跑完，只有「候选 MCP」那一格少一行，没有任何报错）。
   */
  it('MCP：`mcp_servers` 进线程级 config；空集**整个键都不给**（与 effort 同一条口径）', () => {
    const empty = buildCodexConfig('https://gw/v1', { mcpServers: {} });
    expect(Object.hasOwn(empty, 'mcp_servers')).toBe(false);
    const bare = buildCodexConfig('https://gw/v1');
    expect(Object.hasOwn(bare, 'mcp_servers')).toBe(false);

    const withMcp = buildCodexConfig('https://gw/v1', {
      mcpServers: { probe: { command: 'node', args: ['/x.mjs'], startup_timeout_sec: 30 } },
    });
    expect(withMcp['mcp_servers']).toEqual({ probe: { command: 'node', args: ['/x.mjs'], startup_timeout_sec: 30 } });
  });

  /**
   * 自定义请求头的**落点与方言**：进 `model_providers.aieval.http_headers`（**不是** `headers`）。
   *
   * 为什么这条必须逐字钉方言名：CLI 的 ModelProviderInfo 只认 `http_headers` / `env_http_headers`，
   * 写成 `headers` 是**未知字段**——codex 对未知字段的处理是「配置照解析、那一格静默不存在」
   * （或者直接整份 config 解析失败），两种都不是「少带一条头」这么小的代价。
   * 空集 / 缺省 ⇒ 整个键都不出现（与 `mcp_servers` 同一条口径）。
   */
  it('自定义请求头：进 `model_providers.aieval.http_headers`；空集 / 缺省时整个键都不出现', () => {
    const bare = buildCodexConfig('https://gw/v1');
    const providerOf = (config: Record<string, unknown>): Record<string, unknown> =>
      (config['model_providers'] as Record<string, Record<string, unknown>>)['aieval'] ?? {};
    expect(Object.hasOwn(providerOf(bare), 'http_headers')).toBe(false);
    expect(Object.hasOwn(providerOf(buildCodexConfig('https://gw/v1', { headers: {} })), 'http_headers')).toBe(false);

    const withHeaders = buildCodexConfig('https://gw/v1', { headers: { 'X-Trace-Id': 'abc', 'X-Team': 'evaluation' } });
    expect(providerOf(withHeaders)['http_headers']).toEqual({ 'X-Trace-Id': 'abc', 'X-Team': 'evaluation' });
    // 反面：方言名写错的那个键**不许**同时出现（两条键并存时 CLI 只认自己那一条，多出来的没人读）
    expect(Object.hasOwn(providerOf(withHeaders), 'headers')).toBe(false);
  });

  /**
   * 提问工具的两格开关与应答面**同生同灭**：`askUser` 不给（= 本次运行没有应答面）⇒ 两格逐字不变。
   *
   * 为什么这一条必须逐字比：开了开关却没人答时厂商会一直等那一帧（`isBlocking: false` 与
   * `autoResolutionMs: null` 都不让它自己收场）⇒ 「不问就不动」在这里是安全边界，不是洁癖。
   */
  it('提问开关：`askUser` 不给 ⇒ `tools` / `features` 逐字不变；给了 ⇒ 两格都开', () => {
    const bare = buildCodexConfig('https://gw/v1');
    expect(bare['web_search']).toBe('disabled');
    expect(bare['tools']).toEqual({ update_plan: { enabled: true } });
    expect(bare['features']).toEqual({ multi_agent: true });
    // 显式 `false` 与不给同义：两格都不动
    const off = buildCodexConfig('https://gw/v1', { askUser: false });
    expect(off).toEqual(bare);

    const on = buildCodexConfig('https://gw/v1', { askUser: true });
    expect(on['web_search']).toBe('disabled');
    expect(on['tools']).toEqual({
      update_plan: { enabled: true },
      experimental_request_user_input: { enabled: true },
    });
    expect(on['features']).toEqual({ multi_agent: true, default_mode_request_user_input: true });
  });

});

/**
 * MCP 的**厂商侧判据**（codex）：`mcpServer/startupStatus/updated`
 * → 一条 `vendor-system` 事件（通道 `vendor-startup-status`）。
 *
 * 三条口径都在下面钉住：
 *   · **判据只到「装上了」**——`ready` 的结论是 `connected`（启动状态这一档），
 *     而「工具能不能调」是另一回事（上游命名空间缺口，见 `CODEX_MCP_DISPATCH_GAP_NOTE`）；
 *   · **每条通知交全量**：codex 只报**变化的那一台**，而推导要按名字对全表 ⇒ 适配器累积；
 *   · **`error` 原文照抄**（候选失败文案的后半句就是它）。
 */
describe('MCP 启动状态 → vendor-system', () => {
  /** `mcpServer/startupStatus/updated` 的逐字形状（真机样本） */
  const startup = (name: string, status: string, error: string | null = null): FakeNotification => ({
    method: 'mcpServer/startupStatus/updated',
    params: { threadId: MAIN, name, status, error, failureReason: null },
  });

  it('两条通知累积成**一份全量**厂商事实（最后一条自带全部服务器）', async () => {
    const { events } = await collect({
      notifications: [
        startup('probe', 'starting'),
        startup('probe', 'ready'),
        startup('context7', 'failed', 'MCP client for `context7` failed to start: No such file or directory (os error 2)'),
        turnCompleted({ id: 'turn-1' }, { threadId: MAIN }),
      ],
    });

    const vendor = events.filter((event) => event.type === 'vendor-system');
    expect(vendor.length).toBe(3);
    // 通道自报（推导据此决定「没有工具」该怎么读）
    expect(vendor.every((event) => event.type === 'vendor-system' && event.mcpChannel === 'vendor-startup-status')).toBe(true);
    // 第一条：只有 probe、还是 starting
    expect(vendor[0]).toMatchObject({ mcpServers: [{ name: 'probe', status: 'starting', source: null, error: null }] });
    // 最后一条：两台都在，且 probe 已是 ready（**不是**只报变化的那一台）
    expect(vendor[2]).toMatchObject({
      mcpServers: [
        { name: 'probe', status: 'ready', source: null, error: null },
        {
          name: 'context7',
          status: 'failed',
          source: null,
          error: 'MCP client for `context7` failed to start: No such file or directory (os error 2)',
        },
      ],
    });
    // 这一家的工具表**结构性拿不到**（没有 `system/init` 那种事件）⇒ 如实记 null，不编一个空数组
    expect(vendor[2]).toMatchObject({ tools: null });
  });

  it('没有启动状态通知 ⇒ 一条 vendor-system 都不发（「没投送」与「投送了是空的」必须分得开）', async () => {
    const { events } = await collect({ notifications: [turnCompleted({ id: 'turn-1' }, { threadId: MAIN })] });

    expect(events.some((event) => event.type === 'vendor-system')).toBe(false);
  });
});
