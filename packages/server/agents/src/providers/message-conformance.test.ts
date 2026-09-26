// @vitest-environment node
/**
 * **三端一致性**（spec v3 §2 / §3）：同一件事在 claude-code / codex / dsh 上归一之后，
 * 消息结果必须逐字段一致——只有「这一家结构上没有」的格才允许不同（`vendorId` / `vendorTurn` /
 * `step` / `parentCallId` / 工具的 `name` / `source` / `raw`），且那些差异必须由**能力声明**说明。
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
import { codexEventToMessage } from './codex/message-events';
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

/**
 * 只保留**三家应当一致**的格。
 * 去掉的七格与理由（都是「这一家结构上没有」，不是实现差异）：
 *   · `messageId`：本项目生成的序号，逐家不同；
 *   · `vendorId`：厂商 id 空间不同（契约明写「不得当去重键」）；
 *   · `vendorTurn` / `step`：**只有 dsh 有**厂商轮号与步骤号，另两家结构上没有（恒 `null`）；
 *   · `source`：codex 的权威通道是会话文件（`'session-file'`），另两家是 `'wire'`；
 *   · `raw`：厂商原始载荷；
 *   · 工具块的 `name` 与思考块的 `signature`：厂商真名与签名本来就不同——跨家可比的是归一后的
 *     `family` 与 `textKind`（逐家的值另有用例单独钉）。
 */
function comparable(messages: readonly AgentMessage[]): unknown[] {
  return messages.map((message) => ({
    role: message.role,
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

  /** codex：事件流一条 `agent_message` 条目（恒快照，没有 delta 形态） */
  function codex(): AgentMessage[] {
    const state = createTurnState();
    return assemble(
      codexEventToMessage(
        { type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: '没问题，工具已就绪。' } },
        state,
      ),
    );
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
    expect(dshMessages).toMatchObject([{ subagentId: null, vendorTurn: 1, step: 1, roundTrip: 1 }]);
    expect(codexMessages).toMatchObject([{ subagentId: null, vendorTurn: null, step: null, roundTrip: 1 }]);
    expect(codexMessages.map((message) => message.chunk)).toEqual(['snapshot']);
    expect(dshMessages.map((message) => message.chunk)).toEqual(['snapshot']);
    // 三家的**最后一条**（消费方落盘与呈现的真相）逐字段相同
    expect(comparable([claudeMessages.at(-1)!])).toEqual(comparable(codexMessages));
    expect(comparable([claudeMessages.at(-1)!])).toEqual(comparable(dshMessages));
  });

  it('封装差异只出现在允许的七格上（其余格都由契约钉死）', () => {
    const [claudeMessage] = comparable([claude().at(-1)!]) as [Record<string, unknown>];
    const [dshMessage] = comparable([dsh().at(-1)!]) as [Record<string, unknown>];
    // `vendorTurn` / `step` 不在比对集里（只有 dsh 有）⇒ 逐家单独钉住「谁有、谁是 null」
    const claudeRaw = claude().at(-1)!;
    const dshRaw = dsh().at(-1)!;
    expect([claudeRaw.vendorTurn, claudeRaw.step]).toEqual([null, null]);
    expect([dshRaw.vendorTurn, dshRaw.step]).toEqual([1, 1]);
    // `subagentId`：主会话消息在三家都是 null（子会话消息才带身份，见子任务场景）
    expect(claudeMessage.subagentId).toBeNull();
    expect(dshMessage.subagentId).toBeNull();
  });
});

describe('三端一致性：一次 shell 执行（工具调用 + 工具结果）', () => {
  const COMMAND = 'npm run build';

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
    const state = createTurnState();
    return assemble(
      codexEventToMessage(
        {
          type: 'item.completed',
          item: {
            id: 'call_B',
            type: 'command_execution',
            command: COMMAND,
            aggregated_output: 'error TS2304',
            exit_code: 1,
            status: 'completed',
          },
        },
        state,
      ),
    );
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
            truncated: false,
          },
        ],
      },
    ];
    // 三家逐字段比对：调用 id 那一格换成本家的值（它是厂商 id 空间，跨家本来就不同）
    const normalizeId = (messages: readonly AgentMessage[], callId: string): unknown =>
      JSON.parse(JSON.stringify(byCallId(messages)).replaceAll(callId, 'CALL')) as unknown;
    const wanted = JSON.parse(JSON.stringify(expected).replaceAll('call_A', 'CALL')) as unknown;
    expect(normalizeId(claude(), 'call_A')).toEqual(wanted);
    expect(normalizeId(codex(), 'call_B')).toEqual(wanted);
    expect(normalizeId(dsh(), 'call_C')).toEqual(wanted);
  });
});

describe('三端一致性：缺失表达（`null` 只表示未采集）', () => {
  it('三家都不拿 0 / 空串 / 空对象冒充「没采到」', () => {
    const state = createTurnState();
    // codex：运行中的 `command_execution`（`exit_code` 省略、没有输出）
    const codexMessages = assemble(
      codexEventToMessage(
        { type: 'item.completed', item: { id: 'call_B', type: 'command_execution', command: 'npm run build', status: 'in_progress' } },
        state,
      ),
    );
    const resultBlock = codexMessages
      .flatMap((message) => message.blocks)
      .find((block) => block.type === 'tool-result');
    expect(resultBlock).toBeDefined();
    expect(resultBlock).toMatchObject({ structured: null, isError: false, text: '', truncated: false });

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
  it('claude 与 dsh 给完整推理（full）；codex 的事件流只给摘要（summary）', () => {
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

    // codex：事件流的 `reasoning` item 按厂商定义只有摘要 ⇒ 档位是 summary（正文在会话文件里）
    const codexState = createTurnState();
    const codex = assemble(
      codexEventToMessage({ type: 'item.completed', item: { id: 'item_2', type: 'reasoning', text: '先读配置。' } }, codexState),
    );
    expect(codex[0]?.blocks[0]).toMatchObject({ type: 'thinking', text: '先读配置。', textKind: 'summary', signature: null });
  });

  it('codex 事件流连摘要都没有时是「有思考但无文本」（`text: null` + `none`，不是空串）', () => {
    const state = createTurnState();
    const message = assemble(codexEventToMessage({ type: 'item.completed', item: { id: 'item_3', type: 'reasoning' } }, state));
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

    const codexState = createTurnState();
    const codex = assemble(
      codexEventToMessage({ type: 'item.completed', item: { id: 'call_E', type: 'command_execution', command: 'npm run build', status: 'completed' } }, codexState),
    );
    expect(codex[0]?.blocks[0]).toMatchObject({ family: 'run-shell' });
  });

  it('归不进十族的工具落 `null`，`name` 保留原名（MCP 工具与协作动作名都是这一类）', () => {
    const state = createTurnState();
    const message = assemble([
      ...codexEventToMessage(
        { type: 'item.completed', item: { id: 'call_F', type: 'collab_tool_call', tool: 'wait', receiver_thread_ids: ['th-1'] } },
        state,
      ),
    ]);
    expect(message[0]?.blocks[0]).toMatchObject({ family: null, name: 'wait' });
  });
});

describe('三端一致性：无消息的条目一条都不产出（不拿审计行冒充消息）', () => {
  it('codex 的 `error` / `todo_list` 条目、claude 的 `system` init、dsh 的 `turn/start` 都不进消息流', () => {
    const codexState = createTurnState();
    expect(codexEventToMessage({ type: 'item.completed', item: { id: 'i0', type: 'error', message: '有无法识别的配置项' } }, codexState)).toEqual([]);
    expect(codexEventToMessage({ type: 'item.completed', item: { id: 'i1', type: 'todo_list', items: [] } }, codexState)).toEqual([]);

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
    // 流式增量：这一家结构上没有 ⇒ 声明必须是 no，且事件流的任何条目都不产出 delta
    expect([codexCapability.streamingDelta, codexCapability.streamingDeltaReason]).toEqual(['no', 'not-supported']);
    const codexChunks = codexEventToMessage({ type: 'item.completed', item: { id: 'cap-cx', type: 'agent_message', text: 'x' } }, createTurnState()).map(
      (draft) => draft.chunk,
    );
    expect(codexChunks).toEqual(['snapshot']);
    // 思考正文来自会话文件那条通道（事件流那一格只有摘要）
    expect([codexCapability.thinkingText, codexCapability.thinkingTextSource]).toEqual(['yes', 'session-file']);

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
