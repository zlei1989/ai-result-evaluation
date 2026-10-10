// @vitest-environment node
/**
 * claude-code 接入一致性套件（判据源见 `../conformance/kit.ts`）。
 *
 * 与 codex 那份 fixture 的差别：claude 的归一走**运行路径**（`provider.run` + 假 SDK），
 * 因为它的 `SubagentRecord` 不在消息归一里产出（`events.ts:145` 点名的：面板与 `messages.jsonl`
 * 走 `message.ts` 的 `SubagentRecord`，收集点是 `onSubagent`）。
 *
 * **异步与同步的接缝**：`provider.run` 是异步的，而套件的 `scenarios` 是同步取值器。
 * 这里在模块加载期把四个场景各跑一次建好产物，再把同步取值器交给套件——
 * 既不用改套件签名，也保证每个场景的**真实运行只跑一次**（套件对每个场景会多次取值）。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentEvent, AgentMessage, SubagentRecord } from '@aieval/contracts';
import { afterEach } from 'vitest';
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
 * 四个场景恰好覆盖 claude 能力声明里全部为 `yes` 的格：
 * `plain-reply` → streamingDelta、`thinking-full` → thinkingText、
 * `tool-shell` → toolInput + toolResult、`subagent` → subagent。
 */
const SCENARIOS: Readonly<Record<string, readonly unknown[]>> = {
  'plain-reply': [
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
  'thinking-full': [
    assistant([{ type: 'thinking', thinking: '先看配置，再看入口。', signature: '' }], 'u1'),
    assistant([{ type: 'text', text: '看完了。' }], 'u2'),
    result('看完了。'),
  ],
  'tool-shell': [
    assistant([{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }], 'u1'),
    userMessage([{ type: 'tool_result', tool_use_id: 't1', content: 'a.txt' }], 'u2'),
    assistant([{ type: 'text', text: '列完了。' }], 'u3'),
    result('列完了。'),
  ],
  // 派发工具调用与 `task_started.tool_use_id` 必须同值——子任务桥靠它把两套 id 连起来
  subagent: [
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
};

/** 跑一个场景：注入假 SDK → 跑一次真实运行路径 → 收三个回调的产物 */
async function runScenario(events: readonly unknown[]): Promise<ConformanceProduct> {
  const configHome = mkdtempSync(join(tmpdir(), 'claude-conformance-'));
  const recorder = createRecorder();
  setAgentRuntimeForTesting({ sdkModule: { [CLAUDE_PACKAGE_NAME]: createFakeClaudeSdk({ recorder, events }) } });
  const messages: AgentMessage[] = [];
  const subagents: SubagentRecord[] = [];
  const agentEvents: AgentEvent[] = [];
  try {
    const outcome = await claudeCodeProvider.run(
      createRunInput({
        configHome,
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
    };
  } finally {
    removeTreeWithRetry(configHome);
  }
}

const products: Record<string, ConformanceProduct> = {};
for (const [name, events] of Object.entries(SCENARIOS)) {
  products[name] = await runScenario(events);
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
  },
  expectedEventCounts: { 'plain-reply': 2 },
});
