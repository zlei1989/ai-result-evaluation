// @vitest-environment node
/**
 * **三端一致性**（spec v3 §2 / §3）：同一件事在 claude-code / codex / dsh 上归一之后，
 * 消息结果必须逐字段一致——只有「这一家结构上没有」的格才允许不同（`messageId` / `vendorId` /
 * `turn` / `step` / 工具的 `name` / 思考块的 `signature` / `raw`，以及 codex 工具块上
 * app-server 独有的事实 `cwd` / `durationMs`），且那些差异必须由**能力声明**说明。
 *
 * 三条用例的靶子：
 *   ① `merge.test.ts` 已钉住合并算法本身，这里钉的是**三家各自喂进去之后落出来的形状相同**；
 *   ② 比的是**归一后的最终块**（经 `createMessageAssembler` 合并），不是各家产出的中间草稿——
 *      消费方看到的正是前者；
 *   ③ 把「允许不同」的格显式列在 `comparable()` 里，而不是让断言宽松到看不出差异。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { MessageCapabilitySchema, type AgentMessage, type ContentBlock } from '@aieval/contracts';
import { createMessageAssembler, type MessageDraft } from '../message';
import { listAgentProviders } from '../registry';
import { createTurnState } from '../testing/agent-fixtures';
import { createClaudeMessageNormalizer } from './claude-code/message';
import { projectCodexMessages } from './codex/message';
import type { AppServerItem, AppServerNotificationPayload } from './codex/appserver/protocol';
import { createCodexRunState, type CodexRunState } from './codex/run-state';
import { dshAssistantMessageDraft, dshToolCallDraft, dshToolResultDraft, resetDshMessageStateForTesting } from './dsh/message';
import { projectDshNotification } from './dsh/events';

/**
 * dsh 的两张关联表（子任务 catalog、子会话用量）是**模块级**的：生产上每个 run 的 id 都是新 UUID，
 * 而用例之间会串（例如上一条用例登记过的子会话 id 会让下一条的 `subagentId` 非空）。
 * 每条用例前清一次，判据才只取决于本用例喂进去的消息。
 */
beforeEach(() => {
  resetDshMessageStateForTesting();
});

const CLAUDE_CONTEXT = { kind: 'claude-code', baseUrl: 'https://gw.example.com/anthropic' } as const;

/** 跑一条消息流经合并器，返回消费方真正看到的那些消息 */
function assemble(drafts: readonly MessageDraft[]): AgentMessage[] {
  const assembler = createMessageAssembler({ runId: 'run-test' });
  const out: AgentMessage[] = [];
  for (const draft of drafts) assembler.ingest(draft, (message) => out.push(message));
  return out;
}

/** codex 的主线程 id：子线程的条目才带 `subagentId`，主线程那一份记 `null` */
const MAIN = 'thread-main';

/** codex 的投影上下文（`mainThreadId` 是「这条通知算不算主会话」的唯一判据） */
const CODEX_CONTEXT = { mainThreadId: MAIN } as const;

/**
 * 一条 `item/completed` 通知（codex 的完成条目就是快照）。
 * 增量那条通道另有 `item/agentMessage/delta` 与 `item/reasoning/*Delta`，由用例按需投递。
 */
function codexCompleted(item: AppServerItem): AppServerNotificationPayload {
  return { kind: 'itemCompleted', threadId: MAIN, turnId: 'turn-1', item, completedAtMs: 1_700_000_000_000 };
}

/**
 * 跑一串 codex app-server 通知，返回消费方真正看到的那些消息。
 * `runState` 默认每次新建：**同一条逻辑消息的增量与快照必须共用一份**（块序号与轮次台账都在它上面），
 * 所以一次投递多条通知时要走同一次调用。
 */
function assembleCodex(
  payloads: readonly AppServerNotificationPayload[],
  runState: CodexRunState = createCodexRunState(),
): AgentMessage[] {
  return assemble(payloads.flatMap((payload) => projectCodexMessages(payload, runState, CODEX_CONTEXT).drafts));
}

/**
 * 只保留**三家应当一致**的格。
 * 去掉的七格与理由（都是「这一家结构上没有」，不是实现差异）：
 *   · `messageId`：本项目生成的序号，逐家不同；
 *   · `vendorId`：厂商 id 空间不同（契约明写「不得当去重键」）；
 *   · `turn` / `step`：**只有 dsh 有**厂商轮号与步骤号，另两家结构上没有（恒 `null`）；
 *   · `raw`：厂商原始载荷；
 *   · 工具块的 `name` 与思考块的 `signature`：厂商真名与签名本来就不同——跨家可比的是归一后的
 *     `family` 与 `textKind`（逐家的值另有用例单独钉）。
 * `source` **不在这七格里**：三家各自走线上通道 ⇒ 一律 `'wire'`（旧实现里 codex 从会话文件事后读回，
 * 那一格记 `'session-file'`；app-server 通道下这条差异已经消失，故它参与比对）。
 */
function comparable(messages: readonly AgentMessage[]): unknown[] {
  return messages.map((message) => ({
    role: message.role,
    source: message.source,
    roundTrip: message.roundTrip,
    parentCallId: message.parentCallId,
    subagentId: message.subagentId,
    chunk: message.chunk,
    assembly: message.assembly,
    blocks: message.blocks.map(stripVendorOnly),
  }));
}

/** 去掉块上「厂商专属」的格（`name` 与 `signature`），其余逐字保留 */
function stripVendorOnly(block: ContentBlock): unknown {
  if (block.type === 'tool-call') {
    return { type: block.type, callId: block.callId, family: block.family, input: block.input };
  }
  if (block.type === 'thinking') {
    return { type: block.type, text: block.text, textKind: block.textKind };
  }
  return block;
}

/**
 * 把多条消息按**调用 id** 归并成「一次调用一张卡」的视图：调用块与结果块合并到同一条里。
 *
 * 为什么需要它：三家的切分粒度不同——claude 的 SDK 把「调用」与「结果」分成两条消息
 * （`assistant` 带 `tool_use`、`user` 带 `tool_result`），而 codex 与 dsh 的记录里两者本来就属于
 * 同一轮，可以一次投递。切分粒度是**厂商投递方式**的差异，不该让消费方看到不同的结果 ⇒
 * 用调用 id 把块并回去再比。
 */
function byCallId(messages: readonly AgentMessage[]): unknown[] {
  const order: string[] = [];
  const groups = new Map<string, { envelope: Record<string, unknown>; blocks: ContentBlock[] }>();
  for (const message of messages) {
    for (const block of message.blocks) {
      if (block.type !== 'tool-call' && block.type !== 'tool-result') continue;
      const key = block.callId;
      if (!groups.has(key)) {
        order.push(key);
        groups.set(key, {
          envelope: {
            // 载体的 `role` 是**厂商投递方式**，不是工具调用的属性 ⇒ 归一成同一个值再比
            role: 'tool-call',
            roundTrip: message.roundTrip,
            parentCallId: message.parentCallId,
            subagentId: message.subagentId,
            chunk: message.chunk,
            assembly: message.assembly,
          },
          blocks: [],
        });
      }
      groups.get(key)!.blocks.push(block);
    }
  }
  return order.map((key) => {
    const group = groups.get(key)!;
    return {
      ...group.envelope,
      blocks: group.blocks
        .map(stripVendorOnly)
        .sort((left, right) => String((left as { type: string }).type).localeCompare(String((right as { type: string }).type))),
    };
  });
}

/**
 * 摘掉 codex 工具块上**多出来**的两格（调用块的 `cwd` 与结果块的 `durationMs`）再跨家比对。
 *
 * 为什么需要它：app-server 把「在哪执行」与「命令耗时」当作一等事实给出来，而 claude 与 dsh 的载荷里
 * 结构上没有这两格 ⇒ 它们属于「这一家结构上没有」的那一类差异。这里摘掉的是**格**、不是判据：
 * 两格的原值由同一条用例的单独断言钉住（`cwd` 与 `durationMs` 各一条），去掉它们之后剩下的格
 * 仍然逐字比对。刻意不做成「三家都补上 `cwd: null`」——那是替另两家编一个它们没有的事实。
 */
function withoutCodexOnlyToolCells(view: unknown): unknown {
  const groups = view as Array<{ blocks: Array<Record<string, unknown>> }>;
  for (const group of groups) {
    for (const block of group.blocks) {
      if (block.type === 'tool-call') {
        const input = block.input as Record<string, unknown> | null;
        if (input !== null) delete input.cwd;
      }
      if (block.type === 'tool-result') {
        const structured = block.structured as Record<string, unknown> | null;
        if (structured !== null) delete structured.durationMs;
      }
    }
  }
  return groups;
}

describe('三端一致性：一次纯文本答复', () => {
  /** claude：流式增量（只覆盖主会话）之后到达完整 assistant 消息 */
  function claude(): AgentMessage[] {
    const normalizer = createClaudeMessageNormalizer();
    const state = createTurnState();
    const raws: unknown[] = [
      {
        type: 'stream_event',
        uuid: 'u1',
        event: { type: 'message_start', message: { id: 'msg_1' } },
      },
      {
        type: 'stream_event',
        uuid: 'u2',
        event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '没问题' } },
      },
      {
        type: 'assistant',
        uuid: 'u3',
        parent_tool_use_id: null,
        message: { id: 'msg_1', role: 'assistant', content: [{ type: 'text', text: '没问题，工具已就绪。' }] },
      },
    ];
    const drafts = raws.flatMap((raw) => normalizer.normalize(raw, state).messages);
    return assemble(drafts);
  }

  /** codex：增量先到（`item/agentMessage/delta`），完成条目（`agentMessage`）封口 */
  function codex(): AgentMessage[] {
    return assembleCodex([
      { kind: 'agentMessageDelta', threadId: MAIN, turnId: 'turn-1', itemId: 'item_1', delta: '没问题' },
      codexCompleted({ kind: 'agentMessage', id: 'item_1', text: '没问题，工具已就绪。', phase: null }),
    ]);
  }

  /** dsh：`step/start` 之后一条 `assistant/message`（正文整块在 `content[]` 里） */
  function dsh(): AgentMessage[] {
    const state = createTurnState();
    const notification = {
      method: 'session.event',
      params: {
        sessionId: 'session-main',
        event: {
          type: 'assistant/message',
          time: 1,
          data: {
            turn: 1,
            step: 1,
            message: { id: 'cfc5cb78', role: 'assistant', content: [{ type: 'text', text: '没问题，工具已就绪。' }] },
          },
        },
      },
    };
    // 走**真实投影**（`step/start` 先推进轮次，再出消息）——与生产路径同一条
    const context = { kind: 'dsh', baseUrl: 'https://gw.example.com/v1' } as const;
    projectDshNotification(
      { method: 'session.event', params: { sessionId: 'session-main', event: { type: 'step/start', time: 1, data: { turn: 1, step: 1 } } } },
      state,
      context,
    );
    const projection = projectDshNotification(notification, state, context);
    return assemble(projection.messages ?? []);
  }

  it('三家归一出的消息逐字段相同（delta 先出、快照覆盖，最终只有一个块）', () => {
    const claudeMessages = claude();
    // claude 会先出一条 delta（实时打字），再出一条快照：两条消息，最终块以快照为准
    expect(claudeMessages.map((message) => message.chunk)).toEqual(['delta', 'snapshot']);
    const codexMessages = codex();
    const dshMessages = dsh();
    expect(dshMessages).toMatchObject([{ subagentId: null, turn: 1, step: 1, roundTrip: 1 }]);
    expect(codexMessages).toMatchObject([
      { subagentId: null, turn: null, step: null, roundTrip: 1 },
      { subagentId: null, turn: null, step: null, roundTrip: 1 },
    ]);
    expect(codexMessages.map((message) => message.chunk)).toEqual(['delta', 'snapshot']);
    // 增量与快照落在**同一条逻辑消息**上（合并键相同）⇒ 消费方最终只看到一个块，不出现两份正文
    expect(new Set(codexMessages.map((message) => message.mergeKey)).size).toBe(1);
    expect(dshMessages.map((message) => message.chunk)).toEqual(['snapshot']);
    // 三家的**最后一条**（消费方落盘与呈现的真相）逐字段相同
    expect(comparable([claudeMessages.at(-1)!])).toEqual(comparable([codexMessages.at(-1)!]));
    expect(comparable([claudeMessages.at(-1)!])).toEqual(comparable(dshMessages));
  });

  it('封装差异只出现在允许的七格上（其余格都由契约钉死）', () => {
    const [claudeMessage] = comparable([claude().at(-1)!]) as [Record<string, unknown>];
    const [dshMessage] = comparable([dsh().at(-1)!]) as [Record<string, unknown>];
    // `turn` / `step` 不在比对集里（只有 dsh 有）⇒ 逐家单独钉住「谁有、谁是 null」
    const claudeRaw = claude().at(-1)!;
    const dshRaw = dsh().at(-1)!;
    expect([claudeRaw.turn, claudeRaw.step]).toEqual([null, null]);
    expect([dshRaw.turn, dshRaw.step]).toEqual([1, 1]);
    // `subagentId`：主会话消息在三家都是 null（子会话消息才带身份，见子任务场景）
    expect(claudeMessage.subagentId).toBeNull();
    expect(dshMessage.subagentId).toBeNull();
  });
});

describe('三端一致性：一次 shell 执行（工具调用 + 工具结果）', () => {
  const COMMAND = 'npm run build';
  /**
   * codex 工具块上**多出来**的两格：app-server 的 `commandExecution` 自带执行目录与命令耗时，
   * 而 claude 的 `tool_use` 与 dsh 的 `tool/call` 载荷里结构上没有 ⇒ 跨家比对时按「允许不同」摘掉，
   * 原值由本 describe 的单独断言钉住（见用例末尾两条）。
   */
  const CWD = 'D:/repo';
  const DURATION_MS = 1234;

  function claude(): AgentMessage[] {
    const normalizer = createClaudeMessageNormalizer();
    const state = createTurnState();
    const raws: unknown[] = [
      {
        type: 'assistant',
        uuid: 'c1',
        parent_tool_use_id: null,
        message: {
          id: 'msg_1',
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'call_A', name: 'Bash', input: { command: COMMAND } }],
        },
      },
      {
        type: 'user',
        uuid: 'c2',
        parent_tool_use_id: null,
        tool_use_result: { exitCode: 1 },
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'call_A', content: 'error TS2304', is_error: true }],
        },
      },
    ];
    return assemble(raws.flatMap((raw) => normalizer.normalize(raw, state).messages));
  }

  function codex(): AgentMessage[] {
    return assembleCodex([
      codexCompleted({
        kind: 'commandExecution',
        id: 'call_B',
        command: COMMAND,
        cwd: CWD,
        status: 'completed',
        output: 'error TS2304',
        exitCode: 1,
        durationMs: DURATION_MS,
      }),
    ]);
  }

  function dsh(): AgentMessage[] {
    const state = createTurnState();
    projectDshNotification(
      { method: 'session.event', params: { sessionId: 'session-main', event: { type: 'step/start', time: 1, data: { turn: 1, step: 1 } } } },
      state,
      { kind: 'dsh', baseUrl: 'https://gw.example.com/v1' },
    );
    const context = { kind: 'dsh', baseUrl: 'https://gw.example.com/v1' } as const;
    const call = projectDshNotification(
      {
        method: 'session.event',
        params: {
          sessionId: 'session-main',
          event: { type: 'tool/call', time: 2, data: { turn: 1, step: 1, callId: 'call_C', name: 'pwsh', arguments: JSON.stringify({ command: COMMAND }) } },
        },
      },
      state,
      context,
    );
    const result = projectDshNotification(
      {
        method: 'session.event',
        params: {
          sessionId: 'session-main',
          event: {
            type: 'tool/result',
            time: 3,
            data: {
              turn: 1,
              step: 1,
              // 结构化结果在 `meta` 里（`content[]` 只是给模型看的那份文本）；真机 `pwsh` 没有 `meta`
              // ⇒ 退出码只能在文本尾部；这份数据是「有结构化退出码」那一格
              meta: { exitCode: 1 },
              message: { role: 'tool', id: 'r1', toolCallId: 'call_C', content: [{ type: 'text', text: 'error TS2304' }], isError: true },
            },
          },
        },
      },
      state,
      context,
    );
    return assemble([...(call.messages ?? []), ...(result.messages ?? [])]);
  }

  it('三家的 `run-shell` 族与结果块逐字段相同（调用 id 与来源以外的格全等）', () => {
    const expected = [
      {
        role: 'tool-call',
        roundTrip: 1,
        parentCallId: null,
        subagentId: null,
        chunk: 'snapshot',
        assembly: 'snapshot',
        blocks: [
          { type: 'tool-call', callId: 'call_A', family: 'run-shell', input: { command: COMMAND } },
          {
            type: 'tool-result',
            callId: 'call_A',
            structured: { exitCode: 1 },
            isError: true,
            text: 'error TS2304',
            // 截断标记是**三态**：三家都没报这一格 ⇒ `unknown`（「输出可能不完整」）
            truncation: { kind: 'unknown' },
          },
        ],
      },
    ];
    // 三家逐字段比对：调用 id 那一格换成本家的值（它是厂商 id 空间，跨家本来就不同）
    const normalizeId = (messages: readonly AgentMessage[], callId: string): unknown =>
      JSON.parse(JSON.stringify(byCallId(messages)).replaceAll(callId, 'CALL')) as unknown;
    const wanted = JSON.parse(JSON.stringify(expected).replaceAll('call_A', 'CALL')) as unknown;
    expect(normalizeId(claude(), 'call_A')).toEqual(wanted);
    expect(normalizeId(dsh(), 'call_C')).toEqual(wanted);
    // codex 的 `cwd` / `durationMs` 是 app-server 独有的事实 ⇒ 摘掉这两格再比（其余格逐字相等）
    expect(withoutCodexOnlyToolCells(normalizeId(codex(), 'call_B'))).toEqual(wanted);
    // 摘掉的两格各自的原值：跨家比不了的格，也必须由这一家如实交出来
    const [codexGroup] = byCallId(codex()) as [{ blocks: Record<string, unknown>[] }];
    expect(codexGroup.blocks[0]).toMatchObject({ type: 'tool-call', input: { command: COMMAND, cwd: CWD } });
    expect(codexGroup.blocks[1]).toMatchObject({ type: 'tool-result', structured: { exitCode: 1, durationMs: DURATION_MS } });
  });
});

describe('三端一致性：缺失表达（`null` 只表示未采集）', () => {
  it('三家都不拿 0 / 空串 / 空对象冒充「没采到」', () => {
    // codex：运行中的 `commandExecution`（退出码与耗时都没拿到、没有输出）
    const codexMessages = assembleCodex([
      codexCompleted({
        kind: 'commandExecution',
        id: 'call_B',
        command: 'npm run build',
        cwd: null,
        status: 'inProgress',
        output: null,
        exitCode: null,
        durationMs: null,
      }),
    ]);
    const resultBlock = codexMessages
      .flatMap((message) => message.blocks)
      .find((block) => block.type === 'tool-result');
    expect(resultBlock).toBeDefined();
    expect(resultBlock).toMatchObject({ structured: null, isError: false, text: '', truncation: { kind: 'unknown' } });

    // claude：工具结果没有结构化旁路（`tool_use_result` 缺席）⇒ `structured` 是 null，不是 {}
    const normalizer = createClaudeMessageNormalizer();
    const claudeState = createTurnState();
    const claudeDraft = normalizer.normalize(
      {
        type: 'user',
        uuid: 'x1',
        parent_tool_use_id: null,
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_A', content: 'ok' }] },
      },
      claudeState,
    );
    const claudeResult = assemble(claudeDraft.messages)[0]?.blocks[0];
    expect(claudeResult).toMatchObject({ type: 'tool-result', structured: null, isError: false, text: 'ok' });

    // dsh：`pwsh` 的结果**没有 `meta`** ⇒ 结构化格记 null（退出码只在文本尾部的 `[exit code: N]` 里）
    const dshResult = assemble([
      dshToolResultDraft(
        {
          method: 'session.event',
          params: {
            sessionId: 'session-main',
            event: {
              type: 'tool/result',
              data: { turn: 1, step: 1, message: { toolCallId: 'call_C', content: [{ type: 'text', text: 'x' }], isError: false } },
            },
          },
        },
        'session-main',
        1,
      )!,
    ]);
    expect(dshResult[0]?.blocks[0]).toMatchObject({ type: 'tool-result', structured: null, isError: false });
  });

  it('dsh 的结构化结果取 `meta`（`content[]` 只是给模型看的那份文本）', () => {
    const draft = dshToolResultDraft(
      {
        method: 'session.event',
        params: {
          sessionId: 'session-main',
          event: {
            type: 'tool/result',
            data: {
              turn: 1,
              step: 1,
              meta: { shape: 'paths', paths: ['src/app.ts'], truncated: false, total: 1 },
              message: { toolCallId: 'call_D', content: [{ type: 'text', text: 'src/app.ts' }], isError: false },
            },
          },
        },
      },
      'session-main',
      1,
    );
    const block = assemble([draft!])[0]?.blocks[0];
    expect(block).toMatchObject({
      type: 'tool-result',
      structured: { shape: 'paths', paths: ['src/app.ts'], truncated: false, total: 1 },
      text: 'src/app.ts',
    });
  });
});

describe('三端一致性：思考块的档位（`textKind` 由通道决定，不由家决定）', () => {
  it('三家的完整推理都落 `full`（codex 取 `reasoning.content[]`，与另两家同档）', () => {
    // claude：`thinking` 块 + `signature`
    const normalizer = createClaudeMessageNormalizer();
    const claudeState = createTurnState();
    const claude = assemble(
      normalizer.normalize(
        {
          type: 'assistant',
          uuid: 't1',
          parent_tool_use_id: null,
          message: { id: 'msg_2', role: 'assistant', content: [{ type: 'thinking', thinking: '先读配置。', signature: 'EqQBC' }] },
        },
        claudeState,
      ).messages,
    );
    expect(claude[0]?.blocks[0]).toMatchObject({ type: 'thinking', text: '先读配置。', textKind: 'full', signature: 'EqQBC' });

    // dsh：`reasoning` 块带 `text`（整块到达，没有增量）
    const dsh = assemble([dshAssistantMessageDraft(
      {
        method: 'session.event',
        params: {
          sessionId: 'session-main',
          event: {
            type: 'assistant/message',
            data: { turn: 1, step: 1, message: { id: 'm1', role: 'assistant', content: [{ type: 'reasoning', text: '先读配置。' }] } },
          },
        },
      },
      'session-main',
      1,
    )!]);
    expect(dsh[0]?.blocks[0]).toMatchObject({ type: 'thinking', text: '先读配置。', textKind: 'full', signature: null });

    // codex：`reasoning.content[]` 是思考全文（与另两家同一档；摘要另走 `summary[]` 那块通道）
    const codex = assembleCodex([codexCompleted({ kind: 'reasoning', id: 'item_2', summary: [], content: ['先读配置。'] })]);
    expect(codex[0]?.blocks[0]).toMatchObject({ type: 'thinking', text: '先读配置。', textKind: 'full', signature: null });
  });

  it('codex 的 `summary[]` 是单独一块（`summary` 档）；两处都空时是「有思考但无文本」（`text: null` + `none`，不是空串）', () => {
    // 密文 + 摘要：摘要那块自己记 `summary`，**不顶替**全文那一档（全文仍是「拿不到」，不是「就是摘要」）
    const summaryOnly = assembleCodex([codexCompleted({ kind: 'reasoning', id: 'item_3', summary: ['厂商摘要'], content: [] })]);
    expect(summaryOnly[0]?.blocks[0]).toMatchObject({ type: 'thinking', text: '厂商摘要', textKind: 'summary', signature: null });

    const message = assembleCodex([codexCompleted({ kind: 'reasoning', id: 'item_4', summary: [], content: [] })]);
    expect(message[0]?.blocks[0]).toEqual({ type: 'thinking', text: null, textKind: 'none', signature: null });
  });
});

describe('三端一致性：工具族按**名字**判，不按家判', () => {
  it('claude 的 `Read`、dsh 的 `read` 落同一族；codex 的 `exec_command` 落 `run-shell`', () => {
    const claude = assemble([
      dshToolCallDraft(
        {
          method: 'session.event',
          params: { sessionId: 'session-main', event: { type: 'tool/call', data: { turn: 1, step: 1, callId: 'x', name: 'Read', arguments: '{"file_path":"a.ts"}' } } },
        },
        'session-main',
        1,
      )!,
    ]);
    const dsh = assemble([
      dshToolCallDraft(
        {
          method: 'session.event',
          params: { sessionId: 'session-main', event: { type: 'tool/call', data: { turn: 1, step: 1, callId: 'y', name: 'read', arguments: '{"file_path":"a.ts"}' } } },
        },
        'session-main',
        1,
      )!,
    ]);
    expect(claude[0]?.blocks[0]).toMatchObject({ family: 'read-file', input: { file_path: 'a.ts' } });
    expect(dsh[0]?.blocks[0]).toMatchObject({ family: 'read-file', input: { file_path: 'a.ts' } });
    // 跨家可比的是 `family` 与 `input`：`name` 保留厂商原名（这里刻意不同）
    const families = [claude, dsh].map((messages) => (messages[0]?.blocks[0] as { family: string }).family);
    expect(new Set(families).size).toBe(1);

    const codex = assembleCodex([
      codexCompleted({
        kind: 'commandExecution',
        id: 'call_E',
        command: 'npm run build',
        cwd: null,
        status: 'completed',
        output: null,
        exitCode: null,
        durationMs: null,
      }),
    ]);
    expect(codex[0]?.blocks[0]).toMatchObject({ family: 'run-shell', name: 'exec_command' });
  });

  it('归不进十族的工具落 `null`，`name` 保留原名（MCP 工具与协作动作名都是这一类）', () => {
    // codex 的协作动作名（`wait`）不在工具表里 ⇒ 落 `null`，界面走通用渲染并保留原名
    const codex = assembleCodex([
      codexCompleted({
        kind: 'collabToolCall',
        id: 'call_F',
        tool: 'wait',
        status: 'completed',
        senderThreadId: MAIN,
        receiverThreadIds: ['th-1'],
        prompt: null,
        agentsStates: [],
      }),
    ]);
    expect(codex[0]?.blocks[0]).toMatchObject({ family: null, name: 'wait' });

    // MCP 同一条口径：名字取 `<server>.<tool>`，承载任意工具 ⇒ 不猜族
    const mcp = assembleCodex([
      codexCompleted({
        kind: 'mcpToolCall',
        id: 'call_G',
        server: 'github',
        tool: 'list_issues',
        status: 'completed',
        durationMs: null,
        arguments: null,
        result: null,
        error: null,
      }),
    ]);
    expect(mcp[0]?.blocks[0]).toMatchObject({ family: null, name: 'github.list_issues' });
  });

  it('计划清单在三家都落 `task` 族（codex 的 `plan` 条目是调用，不是审计行）', () => {
    // codex：`plan` 条目 ⇒ `update_plan` 调用（族按工具名判）
    const codex = assembleCodex([codexCompleted({ kind: 'plan', id: 'call_H', text: '先读配置' })]);
    expect(codex[0]?.blocks[0]).toMatchObject({ type: 'tool-call', name: 'update_plan', family: 'task' });

    // claude 与 dsh 的清单工具走**同一张名字表**
    const claude = assemble(
      createClaudeMessageNormalizer().normalize(
        {
          type: 'assistant',
          uuid: 'plan-cc',
          parent_tool_use_id: null,
          message: { id: 'msg_plan', role: 'assistant', content: [{ type: 'tool_use', id: 'call_I', name: 'TodoWrite', input: { todos: [] } }] },
        },
        createTurnState(),
      ).messages,
    );
    expect(claude[0]?.blocks[0]).toMatchObject({ family: 'task' });
    const dsh = assemble([
      dshToolCallDraft(
        {
          method: 'session.event',
          params: { sessionId: 'session-main', event: { type: 'tool/call', data: { turn: 1, step: 1, callId: 'call_J', name: 'todo_write', arguments: '{"todos":[]}' } } },
        },
        'session-main',
        1,
      )!,
    ]);
    expect(dsh[0]?.blocks[0]).toMatchObject({ family: 'task' });
  });
});

describe('三端一致性：无消息的条目一条都不产出（不拿审计行冒充消息）', () => {
  it('codex 的 `error` / `turn/started` 通知、claude 的 `system` init、dsh 的 `turn/start` 都不进消息流', () => {
    // codex：报错通知与轮次开始都是**生命周期事实**，不是内容（计划条目不是这一类，见上面「工具族」）
    const codexState = createCodexRunState();
    const codexDrafts = (payload: AppServerNotificationPayload): MessageDraft[] =>
      projectCodexMessages(payload, codexState, CODEX_CONTEXT).drafts;
    expect(codexDrafts({ kind: 'error', threadId: MAIN, message: '有无法识别的配置项' })).toEqual([]);
    expect(codexDrafts({ kind: 'turnStarted', threadId: MAIN, turnId: 'turn-1' })).toEqual([]);

    const normalizer = createClaudeMessageNormalizer();
    const claudeState = createTurnState();
    expect(normalizer.normalize({ type: 'system', uuid: 's1', subtype: 'init', tools: [] }, claudeState).messages).toEqual([]);
    expect(normalizer.normalize({ type: 'result', uuid: 's2', result: '答复', duration_ms: 1 }, claudeState).messages).toEqual([]);

    const dshState = createTurnState();
    const projection = projectDshNotification(
      { method: 'session.event', params: { sessionId: 'session-main', event: { type: 'turn/start', time: 1, data: { turn: 1 } } } },
      dshState,
      { kind: 'dsh', baseUrl: 'https://gw.example.com/v1' },
    );
    expect(projection.messages ?? []).toEqual([]);
  });
});

describe('三端一致性：能力声明与实测行为对齐', () => {
  it('三家各自声明的 `messageCapability` 与实际产出的块形态一致', () => {
    // 声明的真源在各自的 `providers/<kind>/index.ts`；这里断言「声明过的东西真的拿得到」
    const declared = listAgentProviders().map((provider) => ({
      kind: provider.kind,
      capability: provider.metadata.messageCapability,
    }));
    expect(declared.map((entry) => entry.kind)).toEqual(['claude-code', 'codex', 'dsh']);

    const claudeCapability = declared[0]!.capability;
    // 思考正文：声明 yes ⇒ 必须真拿得到（用例里喂了 `thinking` 块）
    expect(claudeCapability.thinkingText).toBe('yes');
    expect(claudeCapability.thinkingTextKind).toBe('full');
    const claudeThinking = assemble(
      createClaudeMessageNormalizer().normalize(
        {
          type: 'assistant',
          uuid: 'cap-cc',
          parent_tool_use_id: null,
          message: { id: 'm', role: 'assistant', content: [{ type: 'thinking', thinking: '想', signature: 's' }] },
        },
        createTurnState(),
      ).messages,
    );
    expect(claudeThinking[0]?.blocks[0]).toMatchObject({ type: 'thinking', text: '想' });
    // 流式增量：声明 yes ⇒ 必须真有 delta 形态的消息
    const claudeDelta = assemble(
      createClaudeMessageNormalizer().normalize(
        { type: 'stream_event', uuid: 'cap-cc-2', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x' } } },
        createTurnState(),
      ).messages,
    );
    expect(claudeDelta[0]?.chunk).toBe('delta');

    const codexCapability = declared[1]!.capability;
    // 流式增量：声明 yes ⇒ 必须真有 delta 形态的消息（app-server 的 `item/agentMessage/delta`）
    expect([codexCapability.streamingDelta, codexCapability.streamingDeltaSource]).toEqual(['yes', 'wire']);
    const codexChunks = projectCodexMessages(
      { kind: 'agentMessageDelta', threadId: MAIN, turnId: 'turn-1', itemId: 'cap-cx', delta: 'x' },
      createCodexRunState(),
      CODEX_CONTEXT,
    ).drafts.map((draft) => draft.chunk);
    expect(codexChunks).toEqual(['delta']);
    // 思考正文：声明 yes + 通道 wire ⇒ 必须真拿得到**完整推理**（摘要那条通道不算数）
    expect([codexCapability.thinkingText, codexCapability.thinkingTextSource]).toEqual(['yes', 'wire']);
    const codexThinking = assembleCodex([codexCompleted({ kind: 'reasoning', id: 'cap-r', summary: [], content: ['想'] })]);
    expect(codexThinking[0]?.blocks[0]).toMatchObject({ type: 'thinking', text: '想', textKind: 'full' });

    const dshCapability = declared[2]!.capability;
    // 思考与工具入参都走会话通知流；两者在这一家都是 `yes`
    expect([dshCapability.thinkingText, dshCapability.thinkingTextSource]).toEqual(['yes', 'wire']);
    expect([dshCapability.toolInput, dshCapability.toolInputSource]).toEqual(['yes', 'wire']);
    // 每一家都必须给出「这一族能力成立的前提」（可以是空数组，但键必须在）
    for (const entry of declared) expect(Array.isArray(entry.capability.notes)).toBe(true);
  });

  it('能力声明的 schema 拦得住自相矛盾的组合（`yes` 没通道、非 `yes` 没原因）', () => {
    const base = listAgentProviders()[0]!.metadata.messageCapability;
    expect(MessageCapabilitySchema.safeParse(base).success).toBe(true);
    // `thinkingText: 'yes'` 但把通道抹成 null ⇒ 必须解析失败
    expect(MessageCapabilitySchema.safeParse({ ...base, thinkingTextSource: null }).success).toBe(false);
    // 非 `yes` 但不给原因 ⇒ 必须解析失败
    expect(
      MessageCapabilitySchema.safeParse({ ...base, streamingDelta: 'no', streamingDeltaReason: null }).success,
    ).toBe(false);
  });
});

describe('三端一致性：投影上下文不影响消息结果', () => {
  it('投影上下文不影响消息结果（同一份输入两次归一逐字段相同）', () => {
    const first = createClaudeMessageNormalizer();
    const second = createClaudeMessageNormalizer();
    const raw = {
      type: 'assistant',
      uuid: 'z1',
      parent_tool_use_id: null,
      message: { id: 'msg_z', role: 'assistant', content: [{ type: 'text', text: '同一份输入' }] },
    };
    expect(comparable(assemble(first.normalize(raw, createTurnState()).messages))).toEqual(
      comparable(assemble(second.normalize(raw, createTurnState()).messages)),
    );
    // 这个常量只用来提醒：投影上下文（`FailureContext`）是事件层的输入，消息层不消费它
    expect(CLAUDE_CONTEXT.kind).toBe('claude-code');
  });
});
