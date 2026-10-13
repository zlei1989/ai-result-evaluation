// @vitest-environment node
/**
 * cc 接入一致性套件（判据源见 `../conformance/kit.ts`）。
 *
 * 与 codex 那份 fixture 的差别：claude 的归一走**运行路径**（`provider.run` + 假 SDK），
 * 因为它的 `SubagentRecord` 不在消息归一里产出（`events.ts:145` 点名的：面板与 `messages.jsonl`
 * 走 `message.ts` 的 `SubagentRecord`，收集点是 `onSubagent`）。
 *
 * **异步与同步的接缝**：`provider.run` 是异步的，而套件的 `scenarios` 是同步取值器。
 * 这里在模块加载期把各场景各跑一次建好产物，再把同步取值器交给套件——
 * 既不用改套件签名，也保证每个场景的**真实运行只跑一次**（套件对每个场景会多次取值）。
 */
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentEvent, AgentMessage, McpServers, SubagentRecord } from '@aieval/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setAgentRuntimeForTesting } from '../../runtime';
import {
  collectEvents,
  createFakeClaudeSdk,
  createRecorder,
  createRunInput,
  settleWithFakeTimers,
} from '../../testing/agent-fixtures';
import { removeTreeWithRetry } from '../../testing/cleanup';
import { describeProviderConformance, type ConformanceProduct, type LifecycleEvidence } from '../conformance/kit';
import { claudeCodeProvider } from './index';
import { CLAUDE_PACKAGE_NAME } from './sdk';

afterEach(() => {
  setAgentRuntimeForTesting(null);
});

const WIRE_USAGE = { input_tokens: 100, cache_read_input_tokens: 40, output_tokens: 10 };

/** 收尾消息：`finalText` 与用量都从它来（形状逐字取自 message-conformance.test.ts） */
const result = (text: string): unknown => ({ type: 'result', subtype: 'success', result: text, usage: WIRE_USAGE });

const assistant = (content: unknown[], uuid: string): unknown => ({
  type: 'assistant',
  uuid,
  parent_tool_use_id: null,
  message: { role: 'assistant', content },
});

const userMessage = (content: unknown[], uuid: string): unknown => ({
  type: 'user',
  uuid,
  message: { role: 'user', content },
});

const textDelta = (uuid: string, text: string): unknown => ({
  type: 'stream_event',
  uuid,
  event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
});

const TASK_CALL = 'call_e086fd6fde2f4f1ab029fce9';
const TASK_ID = 'ac9fca27ed014a4ea';

/**
 * 结构化输出场景的期望对象与其 JSON Schema（形状照评分通路的可移植子集）。
 * `JUDGE_JSON` 由同一个对象序列化而来 ⇒ 收尾消息的 `result` 文本与 `structured_output` 逐字相同，
 * 不会触发「两个来源不一致」那条 WARN（那会多出一条事件日志）。
 */
const JUDGE_OUTPUT = { judgments: [{ id: 'a', achieved: true }], verdict: '还行' };
const JUDGE_JSON = JSON.stringify(JUDGE_OUTPUT);
const JUDGE_SCHEMA = {
  type: 'object',
  properties: {
    judgments: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'string' }, achieved: { type: 'boolean' } },
        required: ['id', 'achieved'],
        additionalProperties: false,
      },
    },
    verdict: { type: 'string' },
  },
  required: ['judgments', 'verdict'],
  additionalProperties: false,
};

interface Scenario {
  /** 本次运行要吐出的消息（按顺序） */
  events: readonly unknown[];
  /**
   * 本次运行交给适配器的 JSON Schema。**只有给它的场景才挂结构化输出探针**——
   * 「有没有走原生通道」必须对着「这次到底要没要 schema」判，不然探针是空转的。
   */
  outputSchema?: unknown;
  /** 探针里与答复逐字段比对的期望对象（键序不同不算不符） */
  expected?: unknown;
  /**
   * 本次运行假 SDK 的**控制请求**返回（`getContextUsage()`）——技能面的采集通道。
   * 只有给了它的场景才挂，没给的场景走「采不到」那条路（少一格技能面、落一条 WARN）。
   */
  contextUsage?: unknown;
  /**
   * 本次运行是否**真的装一份技能**（物化到行配置目录）。
   * 技能面的两条事实缺一不可：落盘的那份与控制请求报回的那份——而适配器在
   * `input.skills` 缺席时**一次都不采**（那是刻意的：评分与用例同步不该付这条控制请求的钱）。
   */
  withSkills?: boolean;
  /**
   * 本次运行要下发的 MCP 服务器（canonical 形状）。**请求侧判据靠它**：不给输入就没有
   * 「我们发出去什么」可判——那种场景只能证明厂商侧，是半条判据。
   */
  mcpServers?: McpServers;
}

/** 行配置目录下真的落了哪些技能副本（落点：`<configHome>/skills/<名称>/`） */
function readInstalledSkills(configHome: string): string[] {
  try {
    return readdirSync(join(configHome, 'skills'));
  } catch {
    return [];
  }
}

/** 一条最小可用的 `system/init`（会话已建的判据）；两个注入场景都在它上面改 */
const INIT = {
  type: 'system',
  subtype: 'init',
  uuid: 'init-1',
  session_id: 'session-1',
  tools: ['Task', 'Bash', 'Skill'],
  slash_commands: [],
  agents: [],
  mcp_servers: [],
  permissionMode: 'bypassPermissions',
  output_style: 'default',
};

/** 厂商控制请求返回的那一格（形状取自真机 dump，只留本仓消费的字段）——技能面的唯一采集通道 */
function contextUsage(skills: { name: string; source: string }[]): unknown {
  return {
    categories: [],
    totalTokens: 100,
    maxTokens: 200_000,
    skills: { totalSkills: skills.length, includedSkills: skills.length, tokens: 42, skillFrontmatter: skills },
  };
}

/**
 * 七个场景覆盖 claude 声明为 `yes` 的全部格：
 * 消息面 `plain-reply` → streamingDelta、`thinking-full` → thinkingText、
 * `tool-shell` → toolInput + toolResult、`subagent` → subagent；
 * 注入面 `mcp-injection` / `skill-injection` → MCP 与技能两条下发通路；
 * `structured-output` 是评分通路：本次要了 schema（落成 SDK 的 `options.outputFormat`）、
 * 收尾消息带原生 `structured_output` ⇒ 探针两份事实都能观测到。
 */
const SCENARIOS: Readonly<Record<string, Scenario>> = {
  'plain-reply': {
    events: [
      textDelta('u1', '没问题'),
      /**
       * 思考进度帧（`system/thinking_tokens`，真机每个思考 token 一条）：它必须**零事件产出**，
       * 摆进这个场景就是为了让一致性套件的条数判据连这条通道一起钉住——只挡 `stream_event`
       * 挡不住真机上真正刷屏的那一种（run `7f05c765` 的 claude 行里 11,629 条都是它）。
       * 声明的事件条数（2）不变：这一条要么被丢掉、要么让条数当场变 3。
       */
      {
        type: 'system',
        subtype: 'thinking_tokens',
        estimated_tokens: 1,
        estimated_tokens_delta: 1,
        session_id: '8a23d018-0dec-4c5c-b67f-8d98ac31d970',
        uuid: 'thinking-tokens-1',
      },
      assistant([{ type: 'text', text: '没问题，工具已就绪。' }], 'u2'),
      result('没问题，工具已就绪。'),
    ],
  },
  'thinking-full': {
    events: [
      assistant([{ type: 'thinking', thinking: '先看配置，再看入口。', signature: '' }], 'u1'),
      assistant([{ type: 'text', text: '看完了。' }], 'u2'),
      result('看完了。'),
    ],
  },
  'tool-shell': {
    events: [
      assistant([{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }], 'u1'),
      userMessage([{ type: 'tool_result', tool_use_id: 't1', content: 'a.txt' }], 'u2'),
      assistant([{ type: 'text', text: '列完了。' }], 'u3'),
      result('列完了。'),
    ],
  },
  // 派发工具调用与 `task_started.tool_use_id` 必须同值——子任务桥靠它把两套 id 连起来
  subagent: {
    events: [
      assistant([{ type: 'tool_use', id: TASK_CALL, name: 'Task', input: { description: 'Count lines in notes.txt' } }], 'u1'),
      {
        type: 'system',
        subtype: 'task_started',
        uuid: 'u2',
        task_id: TASK_ID,
        tool_use_id: TASK_CALL,
        description: 'Count lines in notes.txt',
        subagent_type: 'general-purpose',
        spawn_depth: 1,
        prompt: 'Count the lines in notes.txt…',
      },
      /**
       * **子智能体自己的那条消息**：真机上它带 `parent_tool_use_id`，而那正是归属键的来源
       * （`message.ts` 把这一格读成消息的 `subagentId`）。少了它，这个场景只能证明「有一条子任务行」，
       * 证明不了「子任务里有逐条对话」——子任务的正文挂在哪个会话节点上才是那条判据要问的。
       */
      {
        type: 'assistant',
        uuid: 'u2b',
        parent_tool_use_id: TASK_CALL,
        message: { id: 'side-m-1', role: 'assistant', content: [{ type: 'text', text: '3 lines' }] },
      },
      {
        type: 'system',
        subtype: 'task_notification',
        uuid: 'u3',
        task_id: TASK_ID,
        tool_use_id: TASK_CALL,
        status: 'completed',
        summary: '3 lines',
      },
      assistant([{ type: 'text', text: '数完了。' }], 'u4'),
      result('数完了。'),
    ],
  },
  /**
   * 评分通路的形状：assistant 快照与收尾消息都给同一份 JSON（`finalText` 的通则要求它出自
   * 产物里某条主会话答复正文），而原生通道的那一格在收尾消息的 `structured_output` 上。
   * `result` 文本与它逐字相同 ⇒ 不落「两个来源不一致」的 WARN。
   */
  'structured-output': {
    outputSchema: JUDGE_SCHEMA,
    expected: JUDGE_OUTPUT,
    events: [
      assistant([{ type: 'text', text: JUDGE_JSON }], 'u1'),
      { type: 'result', subtype: 'success', result: JUDGE_JSON, structured_output: JUDGE_OUTPUT, usage: WIRE_USAGE },
    ],
  },
  /**
   * 注入面两景。MCP 的两条事实一次给全：`mcp_servers` 是状态表、工具表里那一项是更硬的那条
   * （判据 `hasMcpFact` 两台通道合读，因为 dsh 只有后者）。技能面走控制请求，
   * 采集点在收尾 ⇒ 清单出现在最后那条 `vendor-system` 上。
   */
  'mcp-injection': {
    mcpServers: { probe: { transport: 'stdio', enabled: true, command: 'node', args: ['echo.mjs'] } },
    events: [
      {
        ...INIT,
        mcp_servers: [{ name: 'probe', status: 'connected' }],
        tools: ['Task', 'Bash', 'Skill', 'mcp__probe__echo'],
      },
      assistant([{ type: 'text', text: 'MCP 接上了。' }], 'u1'),
      result('MCP 接上了。'),
    ],
  },
  'skill-injection': {
    withSkills: true,
    contextUsage: contextUsage([{ name: 'alpha', source: 'userSettings' }]),
    events: [INIT, assistant([{ type: 'text', text: '技能已就位。' }], 'u1'), result('技能已就位。')],
  },
};

/** 跑一个场景：注入假 SDK → 跑一次真实运行路径 → 收三个回调的产物 */
async function runScenario(scenario: Scenario): Promise<ConformanceProduct> {
  const configHome = mkdtempSync(join(tmpdir(), 'claude-conformance-'));
  /** 技能源目录另起一个临时根（与行配置目录分开，物化是「读源、写目标」两处） */
  const skillRoot = scenario.withSkills === true ? mkdtempSync(join(tmpdir(), 'claude-conformance-skill-')) : null;
  let skills: { name: string; sourceDir: string }[] | undefined;
  if (skillRoot !== null) {
    const sourceDir = join(skillRoot, 'alpha');
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, 'SKILL.md'), '---\nname: alpha\ndescription: 示例\n---\n\n正文\n', 'utf8');
    skills = [{ name: 'alpha', sourceDir }];
  }
  const recorder = createRecorder();
  setAgentRuntimeForTesting({
    sdkModule: {
      [CLAUDE_PACKAGE_NAME]: createFakeClaudeSdk({
        recorder,
        events: scenario.events,
        ...(scenario.contextUsage === undefined ? {} : { contextUsage: scenario.contextUsage }),
      }),
    },
  });
  const messages: AgentMessage[] = [];
  const subagents: SubagentRecord[] = [];
  const agentEvents: AgentEvent[] = [];
  try {
    const outcome = await claudeCodeProvider.run(
      createRunInput({
        configHome,
        ...(skills === undefined ? {} : { skills }),
        ...(scenario.mcpServers === undefined ? {} : { mcpServers: scenario.mcpServers }),
        ...(scenario.outputSchema === undefined ? {} : { outputSchema: scenario.outputSchema }),
        onMessage: (message) => messages.push(message),
        onSubagent: (record) => subagents.push(record),
        onEvent: collectEvents(agentEvents),
      }),
    );
    return {
      messages,
      subagents,
      /**
       * 行级事件**如实收**：写死 `[]` 会让套件的增量隔离判据在 claude 身上**永远不可能红**
       * ——喂了增量帧、事件却恒为空数组，把 `events.ts` 的排除分支删回去这条守卫照样绿。
       * claude 的 `stream_event` 正是最容易掉进「未识别兜底」的一家。收真事件之后，条数变化才有判据。
       */
      events: agentEvents,
      usage: {
        tokens: {
          input: WIRE_USAGE.input_tokens - WIRE_USAGE.cache_read_input_tokens,
          cached: WIRE_USAGE.cache_read_input_tokens,
          output: WIRE_USAGE.output_tokens,
          reasoningOutput: null,
          total: null,
        },
        turns: outcome.turns,
        subagentTokens: outcome.subagentTokens ?? null,
        subagentTurns: outcome.subagentTurns ?? null,
      },
      result: { ok: outcome.ok, finalText: outcome.finalText },
      ...(scenario.outputSchema === undefined
        ? {}
        : {
          /**
           * 结构化输出探针：两份事实都来自**本次运行**
           * —— `nativeChannel` 是适配器上报的通道事实（`applied.structuredOutput`），
           * `hasOutputSchema` 是假 SDK 记下的请求侧事实（`options.outputFormat`）。
           * 判据用 `'outputFormat' in options` 而不是 `!== undefined`：后者对「键存在但值 undefined」
           * 与「键不存在」给出同一个结论，正好把要钉的那件事放过（与 `index.test.ts` 同口径）。
           */
          structuredOutput: {
            nativeChannel: outcome.applied.structuredOutput,
            hasOutputSchema: recorder.options !== null && 'outputFormat' in recorder.options,
            finalText: outcome.finalText,
            ...(scenario.expected === undefined ? {} : { expected: scenario.expected }),
          },
        }),
      /**
       * 注入面探针（**请求侧**）：两份事实都由本次运行的实际动作产生，不是夹具自述——
       * MCP 是假 SDK 记下的 `options.mcpServers`，技能是行配置目录下真的落了哪几个副本。
       * 缺了它，「适配器压根没把入参交给厂商」这一整类缺陷不会被任何判据发现。
       */
      injectionProbe: {
        mcpSent: recorder.options?.['mcpServers'] ?? null,
        skillsInstalled: readInstalledSkills(configHome),
      },
    };
  } finally {
    removeTreeWithRetry(configHome);
    if (skillRoot !== null) removeTreeWithRetry(skillRoot);
  }
}

/**
 * 生命周期观测：真跑**两次**运行（一次正常收尾、一次中途取消），数释放次数与取消有没有终结在途轮次。
 *
 * 为什么不复用 `SCENARIOS` 的产物：产物里没有「释放了几次」这种事实——那是运行期行为，
 * 只能在那一次运行里数。取消那一次要**假定时器**（在途轮次靠计时推进），
 * 故这一格不能建在模块加载期，由套件在用例里 `await`（见 `checkLifecycle`）。
 */
async function observeLifecycle(): Promise<LifecycleEvidence> {
  const configHome = mkdtempSync(join(tmpdir(), 'claude-lifecycle-'));
  /**
   * 释放次数取自假 SDK 的 `order`（abort ⇒ `'dispose'`）而不是 `closeCount`：
   * claude 的硬回收走 `controller.abort()`，假件在那条路上记的是顺序表。
   */
  const disposals = (recorder: ReturnType<typeof createRecorder>): number =>
    recorder.order.filter((one) => one === 'dispose').length;
  try {
    // ① 正常收尾：释放恰好一次
    const runRecorder = createRecorder();
    setAgentRuntimeForTesting({
      sdkModule: {
        [CLAUDE_PACKAGE_NAME]: createFakeClaudeSdk({ recorder: runRecorder, events: [INIT, result('收尾。')] }),
      },
    });
    await claudeCodeProvider.run(createRunInput({ configHome }));
    const disposeAfterRun = disposals(runRecorder);

    // ② 中途取消：在途轮次被终结，且释放仍然恰好一次
    vi.useFakeTimers();
    const cancelRecorder = createRecorder();
    const controller = new AbortController();
    setAgentRuntimeForTesting({
      sdkModule: { [CLAUDE_PACKAGE_NAME]: createFakeClaudeSdk({ recorder: cancelRecorder, events: [], hang: true }) },
    });
    const running = claudeCodeProvider.run(createRunInput({ configHome, signal: controller.signal }));
    await vi.advanceTimersByTimeAsync(100);
    controller.abort();
    await settleWithFakeTimers(running, { stepMs: 500, steps: 10 });
    return {
      disposeAfterRun,
      disposeAfterCancel: disposals(cancelRecorder),
      // 判据是「在途轮次被终结」而不是「interrupt 被调过」：只调 interrupt 不算数，
      // 要走到 `turn-end`（那正是「取消真的生效」与「只是关掉运行时」的分界）
      canceledMidTurn: cancelRecorder.order.includes('turn-end'),
    };
  } finally {
    vi.useRealTimers();
    setAgentRuntimeForTesting(null);
    removeTreeWithRetry(configHome);
  }
}

const products: Record<string, ConformanceProduct> = {};
for (const [name, scenario] of Object.entries(SCENARIOS)) {
  products[name] = await runScenario(scenario);
}
setAgentRuntimeForTesting(null);

describeProviderConformance({
  kind: claudeCodeProvider.kind,
  capability: claudeCodeProvider.metadata.messageCapability,
  injection: claudeCodeProvider.metadata.injection,
  /**
   * **真出站证据：两格都缺**（如实登记，不硬凑）。这一家的假件把 SDK 整段换掉，看得见我们传进去的
   * `options`，看不见 CLI 真正发出去的那一份请求；而 `outputFormat` 是**入参**，`strict` 有没有生效
   * 只有请求体知道。缺的那两条在真机侧由下面点名的文件守（判据强度弱一档：`live-mcp` 证的是
   * MCP server 侧收到调用，不是请求体的工具表；结构化输出只有入参那一格）。
   */
  realOutboundEvidence: [],
  realOutboundGaps: {
    mcp: 'packages/server/agents/src/providers/cc/live-mcp.test.ts',
    'structured-output': 'packages/server/agents/src/providers/cc/index.test.ts',
  },
  injectionProof: { mcp: 'mcp-injection', skills: 'skill-injection' },
  cancelMidTurn: claudeCodeProvider.metadata.capability.cancelMidTurn,
  lifecycle: observeLifecycle,
  scenarios: {
    'plain-reply': () => products['plain-reply']!,
    'thinking-full': () => products['thinking-full']!,
    'tool-shell': () => products['tool-shell']!,
    subagent: () => products['subagent']!,
    'structured-output': () => products['structured-output']!,
    'mcp-injection': () => products['mcp-injection']!,
    'skill-injection': () => products['skill-injection']!,
  },
  expectedEventCounts: { 'plain-reply': 2 },
});

/**
 * 探针挂载守卫：这一家能观测请求（假 SDK 把 `query` 的 `options` 交回），所以那份探针必须真的挂上、
 * 且两份事实都对得上。**没有这条，把探针从场景里删掉只会让套件那一组变成空转——谁都不会红**。
 */
describe('结构化输出探针挂载（cc）', () => {
  it('要了 schema ⇒ SDK 拿到 outputFormat，且本次收尾消息带 structured_output（原生通道如实上报）', () => {
    const probe = products['structured-output']?.structuredOutput;
    expect(probe).toBeDefined();
    expect(probe?.hasOutputSchema, '假 SDK 没记到 options.outputFormat：这一次的 schema 没有发给厂商').toBe(true);
    expect(probe?.nativeChannel, 'cc 本次收尾消息带 structured_output，applied.structuredOutput 必须是 true').toBe(true);
    expect(probe?.finalText).toBe(JUDGE_JSON);
  });
});
