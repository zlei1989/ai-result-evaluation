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
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentEvent, AgentMessage, SubagentRecord } from '@aieval/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { setAgentRuntimeForTesting } from '../../runtime';
import { collectEvents, createFakeClaudeSdk, createRecorder, createRunInput } from '../../testing/agent-fixtures';
import { removeTreeWithRetry } from '../../testing/cleanup';
import { describeProviderConformance, type ConformanceProduct } from '../conformance/kit';
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
}

/**
 * 五个场景恰好覆盖 claude 能力声明里全部为 `yes` 的格：
 * `plain-reply` → streamingDelta、`thinking-full` → thinkingText、
 * `tool-shell` → toolInput + toolResult、`subagent` → subagent；
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
};

/** 跑一个场景：注入假 SDK → 跑一次真实运行路径 → 收三个回调的产物 */
async function runScenario(scenario: Scenario): Promise<ConformanceProduct> {
  const configHome = mkdtempSync(join(tmpdir(), 'claude-conformance-'));
  const recorder = createRecorder();
  setAgentRuntimeForTesting({
    sdkModule: { [CLAUDE_PACKAGE_NAME]: createFakeClaudeSdk({ recorder, events: scenario.events }) },
  });
  const messages: AgentMessage[] = [];
  const subagents: SubagentRecord[] = [];
  const agentEvents: AgentEvent[] = [];
  try {
    const outcome = await claudeCodeProvider.run(
      createRunInput({
        configHome,
        ...(scenario.outputSchema === undefined ? {} : { outputSchema: scenario.outputSchema }),
        onMessage: (message) => messages.push(message),
        onSubagent: (record) => subagents.push(record),
        onEvent: collectEvents(agentEvents),
      }),
    );
    return {
      messages,
      subagents,
      // claude 没有 `vendor-system` 通道（系统提示词不投送），故这一组整组 not-exposed
      environment: null,
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
    };
  } finally {
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
  scenarios: {
    'plain-reply': () => products['plain-reply']!,
    'thinking-full': () => products['thinking-full']!,
    'tool-shell': () => products['tool-shell']!,
    subagent: () => products['subagent']!,
    'structured-output': () => products['structured-output']!,
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
