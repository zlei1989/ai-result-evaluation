// @vitest-environment node
/**
 * `message.ts` 的行为契约：app-server 通知 → 契约草稿与子任务行。
 *
 * 逐条钉住计划表的内容级那一格：增量与快照配对、思考全文与摘要分档、密文不回落、
 * 工具四族（命令 / 文件改动 / MCP / 计划）、协作条目的身份与父链、收尾读回的三档终态。
 */
import { describe, expect, it } from 'vitest';
import { createMessageAssembler, type MessageDraft } from '../../message';
import type { AgentMessage } from '@aieval/contracts';
import type { AppServerItem, AppServerItemEntry, AppServerNotificationPayload, AppServerThread } from './appserver/protocol';
import type { AppServerThreadRef } from './appserver/reader';
import { noteThreadStarted, projectCodexMessages, projectSubagentRecord, projectThreadMessages, terminalStatusOf, threadRoundTrips } from './message';
import { createCodexRunState, type CodexRunState } from './run-state';

const MAIN = 'thread-main';
const CHILD = 'thread-child';
const CONTEXT = { mainThreadId: MAIN };

function project(payload: AppServerNotificationPayload, runState: CodexRunState = createCodexRunState()): { drafts: MessageDraft[]; subagents: ReturnType<typeof projectCodexMessages>['subagents'] } {
  const out = projectCodexMessages(payload, runState, CONTEXT);
  return { drafts: out.drafts, subagents: out.subagents };
}

/** 把草稿喂给合并器，取消费方真正看到的消息（块序号与覆盖合并的判据都在那里） */
function assemble(drafts: readonly MessageDraft[]): AgentMessage[] {
  const assembler = createMessageAssembler({ runId: 'run-codex' });
  const out: AgentMessage[] = [];
  for (const draft of drafts) assembler.ingest(draft, (message) => out.push(message));
  return out;
}

/** 最后一条消息（合并器的覆盖语义下，它就是该逻辑消息的当前真相） */
function lastMessage(drafts: readonly MessageDraft[]): AgentMessage {
  const messages = assemble(drafts);
  const message = messages.at(-1);
  if (message === undefined) throw new Error('没有产出任何消息');
  return message;
}

function completed(item: AppServerItem, where: { threadId?: string; turnId?: string } = {}): AppServerNotificationPayload {
  return {
    kind: 'itemCompleted',
    threadId: where.threadId ?? MAIN,
    turnId: where.turnId ?? 'turn-1',
    item,
    completedAtMs: 1_700_000_000_000,
  };
}

function started(item: AppServerItem, where: { threadId?: string; turnId?: string } = {}): AppServerNotificationPayload {
  return {
    kind: 'itemStarted',
    threadId: where.threadId ?? MAIN,
    turnId: where.turnId ?? 'turn-1',
    item,
  };
}

describe('答复：增量先到、完成通知封口', () => {
  it('`item/agentMessage/delta` → 文本块按增量落，`chunk: delta`（这一家**有**流式增量）', () => {
    const { drafts } = project({ kind: 'agentMessageDelta', threadId: MAIN, turnId: 'turn-1', itemId: 'm1', delta: '正在' });
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.chunk).toBe('delta');
    expect(drafts[0]?.source).toBe('wire');
    expect(drafts[0]?.subagentId).toBeNull();
    expect(drafts[0]?.blocks).toEqual([{ phase: 'delta', identity: { kind: 'index', index: 0 }, block: { type: 'text', text: '正在' } }]);
  });

  it('增量 + 完成快照 ⇒ **同一个槽位**，最终文本是完整答复且已收尾（`assembly: snapshot`）', () => {
    const runState = createCodexRunState();
    const first = project({ kind: 'agentMessageDelta', threadId: MAIN, turnId: 'turn-1', itemId: 'm1', delta: '正在' }, runState);
    const second = project(completed({ kind: 'agentMessage', id: 'm1', text: '正在检查仓库。', phase: null }), runState);
    const messages = assemble([...first.drafts, ...second.drafts]);
    // 两条消息（增量一条、快照一条）落在同一个合并键上
    expect(new Set(messages.map((one) => one.mergeKey)).size).toBe(1);
    expect(messages.map((one) => one.chunk)).toEqual(['delta', 'snapshot']);
    const final = lastMessage([...first.drafts, ...second.drafts]);
    expect(final.assembly).toBe('snapshot');
    expect(final.blocks).toEqual([{ type: 'text', text: '正在检查仓库。' }]);
  });

  it('没有增量的完成条目 ⇒ 一条快照（块序号由合并器按到达顺序分配，不由本层编）', () => {
    const final = lastMessage(project(completed({ kind: 'agentMessage', id: 'm1', text: '答复', phase: null })).drafts);
    expect(final.chunk).toBe('snapshot');
    expect(final.blocks).toEqual([{ type: 'text', text: '答复' }]);
  });

  it('空正文不产消息（契约的 `text` 是 string，一块空文本只是界面上的空白）', () => {
    expect(project(completed({ kind: 'agentMessage', id: 'm1', text: '', phase: null })).drafts).toEqual([]);
  });

  it('同一条目的多个块各自占一个槽位（推理 + 正文不会互相覆盖）', () => {
    const runState = createCodexRunState();
    const reasoning = project(completed({ kind: 'reasoning', id: 'r1', summary: [], content: ['先看配置'] }), runState);
    const answer = project(completed({ kind: 'agentMessage', id: 'm1', text: '改完了', phase: null }), runState);
    const final = lastMessage([...reasoning.drafts, ...answer.drafts]);
    expect(final.blocks).toEqual([
      { type: 'thinking', text: '先看配置', textKind: 'full', signature: null },
      { type: 'text', text: '改完了' },
    ]);
  });
});

describe('思考：全文与摘要分档，密文不回落', () => {
  it('`content[]` 非空 ⇒ 全文（`textKind: full`、`source: wire`）', () => {
    const final = lastMessage(project(completed({ kind: 'reasoning', id: 'r1', summary: [], content: ['第一段', '第二段'] })).drafts);
    expect(final.source).toBe('wire');
    expect(final.blocks).toEqual([{ type: 'thinking', text: '第一段\n第二段', textKind: 'full', signature: null }]);
  });

  it('`content[]` 为空（上游只回密文）⇒ `text: null` + `none`，**绝不**回落 summary 冒充全文', () => {
    const final = lastMessage(project(completed({ kind: 'reasoning', id: 'r1', summary: [], content: [] })).drafts);
    expect(final.blocks).toEqual([{ type: 'thinking', text: null, textKind: 'none', signature: null }]);
  });

  it('密文 + 摘要都有 ⇒ 两块：全文那块 `none`，摘要那块 `summary`（摘要不顶替全文）', () => {
    const final = lastMessage(project(completed({ kind: 'reasoning', id: 'r1', summary: ['厂商摘要'], content: [] })).drafts);
    expect(final.blocks).toEqual([
      { type: 'thinking', text: '厂商摘要', textKind: 'summary', signature: null },
    ]);
  });

  it('两条增量通道落进**不同**槽位：`textDelta` 是全文、`summaryTextDelta` 是摘要', () => {
    const runState = createCodexRunState();
    const full = project({ kind: 'reasoningTextDelta', threadId: MAIN, turnId: 'turn-1', itemId: 'r1', delta: '想' }, runState);
    const summary = project({ kind: 'reasoningSummaryDelta', threadId: MAIN, turnId: 'turn-1', itemId: 'r1', delta: '摘要' }, runState);
    const final = lastMessage([...full.drafts, ...summary.drafts]);
    expect(final.blocks).toEqual([
      { type: 'thinking', text: '想', textKind: 'full', signature: null },
      { type: 'thinking', text: '摘要', textKind: 'summary', signature: null },
    ]);
  });

  it('只回密文但全文已经逐字推完 ⇒ 完成通知补快照封口（那一块不会永远停在 open）', () => {
    const runState = createCodexRunState();
    const first = project({ kind: 'reasoningTextDelta', threadId: MAIN, turnId: 'turn-1', itemId: 'r1', delta: '全文' }, runState);
    const second = project({ kind: 'reasoningTextDelta', threadId: MAIN, turnId: 'turn-1', itemId: 'r1', delta: '接着' }, runState);
    const done = project(completed({ kind: 'reasoning', id: 'r1', summary: [], content: [] }), runState);
    const final = lastMessage([...first.drafts, ...second.drafts, ...done.drafts]);
    expect(final.assembly).toBe('snapshot');
    expect(final.blocks).toEqual([{ type: 'thinking', text: '全文接着', textKind: 'full', signature: null }]);
  });

  it('增量与完成通知逐字相同时**仍要补快照封口**（内容不变，`assembly` 由 open 变 snapshot）', () => {
    const runState = createCodexRunState();
    const delta = project({ kind: 'reasoningTextDelta', threadId: MAIN, turnId: 'turn-1', itemId: 'r1', delta: '全文' }, runState);
    // 只有增量时那一块是「未收尾」——完成通知那一帧的存在意义就是把这一格翻过来
    expect(lastMessage(delta.drafts).assembly).toBe('open');
    const done = project(completed({ kind: 'reasoning', id: 'r1', summary: [], content: ['全文'] }), runState);
    const final = lastMessage([...delta.drafts, ...done.drafts]);
    expect(final.assembly).toBe('snapshot');
    expect(final.blocks).toEqual([{ type: 'thinking', text: '全文', textKind: 'full', signature: null }]);
  });

  /**
   * 真机序列（2026-10-07 实测，`probe/dumps/v5/codex-appserver-reasoning-*.jsonl`）：
   * `item/started` 的推理条目 `summary` 与 `content` **都是空数组**，随后是几十条
   * `item/reasoning/textDelta`，最后 `item/completed` 给出与增量**逐字相同**的全文。
   *
   * 这条用例拦的是一个曾经真实发生、且**在产物里一眼可见**的缺陷：`item/started` 落的那一块空快照
   * 会把槽位 seal，紧随其后的增量全被 `applyBlock` 丢弃（「已 seal + 增量 ⇒ 丢弃」），
   * 而完成通知又因为「逐字相同 ⇒ 不重发」什么都不补 ⇒ 那一块永远停在 `text: null` + `none`，
   * 界面上就是「思考信息没采到」（`messageId: run-codex:N` 的真机产物里 5020/5020 块全是这个形状）。
   */
  it('真机序列：`started` 空占位 → 增量 → 完成 ⇒ 最终块是**全文**且已收尾', () => {
    const runState = createCodexRunState();
    const open = project(started({ kind: 'reasoning', id: 'r1', summary: [], content: [] }), runState);
    // 「开始推理了」不是「这一轮没有文本」：这里产块等于把后面每一个字都丢掉
    expect(open.drafts).toEqual([]);

    const first = project({ kind: 'reasoningTextDelta', threadId: MAIN, turnId: 'turn-1', itemId: 'r1', delta: 'The' }, runState);
    const second = project({ kind: 'reasoningTextDelta', threadId: MAIN, turnId: 'turn-1', itemId: 'r1', delta: ' answer' }, runState);
    const done = project(completed({ kind: 'reasoning', id: 'r1', summary: [], content: ['The answer'] }), runState);

    const final = lastMessage([...open.drafts, ...first.drafts, ...second.drafts, ...done.drafts]);
    expect(final.blocks).toEqual([{ type: 'thinking', text: 'The answer', textKind: 'full', signature: null }]);
    expect(final.assembly).toBe('snapshot');
  });

  it('`started` 的空占位不占用块序号（正文块仍然排在第 0 位）', () => {
    const runState = createCodexRunState();
    const open = project(started({ kind: 'reasoning', id: 'r1', summary: [], content: [] }), runState);
    const answer = project(completed({ kind: 'agentMessage', id: 'm1', text: '改完了', phase: null }), runState);
    const final = lastMessage([...open.drafts, ...answer.drafts]);
    expect(final.blocks).toEqual([{ type: 'text', text: '改完了' }]);
  });
});

describe('工具：命令、文件改动、MCP、计划', () => {
  it('`commandExecution` ⇒ 调用 + 结果两条：命令 / 输出 / 退出码 / 耗时', () => {
    const { drafts } = project(
      completed({
        kind: 'commandExecution',
        id: 'c1',
        command: 'npm run build',
        cwd: 'D:/repo',
        status: 'completed',
        output: 'error TS2304',
        exitCode: 1,
        durationMs: 1234,
      }),
    );
    expect(drafts.map((one) => one.role)).toEqual(['assistant', 'tool']);
    expect(drafts[0]?.blocks[0]).toEqual({
      phase: 'snapshot',
      // 块标识是**块序号**（本层按「载体 + 条目 + 块种」分配，增量与快照因此能合到一块）
      identity: { kind: 'index', index: 0 },
      block: {
        type: 'tool-call',
        callId: 'c1',
        family: 'run-shell',
        name: 'exec_command',
        input: { command: 'npm run build', cwd: 'D:/repo' },
        payload: null,
      },
    });
    expect(drafts[1]?.blocks[0]).toMatchObject({
      phase: 'snapshot',
      // 结果与调用是**两条消息**（载体不同）⇒ 块序号各自从 0 起算
      identity: { kind: 'index', index: 0 },
      block: {
        type: 'tool-result',
        callId: 'c1',
        structured: { exitCode: 1, durationMs: 1234 },
        isError: true,
        text: 'error TS2304',
      },
    });
  });

  it('运行中的命令（没有退出码与耗时）⇒ 结构化格 `null`、**不断言成功**', () => {
    const { drafts } = project(
      completed({ kind: 'commandExecution', id: 'c1', command: 'npm test', cwd: null, status: 'inProgress', output: null, exitCode: null, durationMs: null }),
    );
    expect(drafts[1]?.blocks[0]).toMatchObject({ block: { structured: null, isError: false, text: '' } });
  });

  it('`fileChange` ⇒ `apply_patch` 调用 + 结构化结果（**这一格此前在消息面上没有**）', () => {
    const { drafts } = project(
      completed({
        kind: 'fileChange',
        id: 'f1',
        status: 'completed',
        changes: [{ path: 'src/a.ts', kind: 'update' }],
      }),
    );
    expect(drafts.map((one) => one.role)).toEqual(['assistant', 'tool']);
    expect(drafts[0]?.blocks[0]).toMatchObject({
      block: { type: 'tool-call', family: 'edit-file', name: 'apply_patch', input: { changes: [{ path: 'src/a.ts', kind: 'update' }] } },
    });
    expect(drafts[1]?.blocks[0]).toMatchObject({
      block: { type: 'tool-result', structured: { changes: [{ path: 'src/a.ts', kind: 'update' }], status: 'completed' }, isError: false },
    });
  });

  it('`fileChange` 的 `failed` / `declined` 都算错误（被拒的补丁与失败的补丁都该显眼）', () => {
    const failed = project(completed({ kind: 'fileChange', id: 'f1', status: 'failed', changes: [] })).drafts;
    expect(failed[1]?.blocks[0]).toMatchObject({ block: { isError: true } });
    const declined = project(completed({ kind: 'fileChange', id: 'f2', status: 'declined', changes: [] })).drafts;
    expect(declined[1]?.blocks[0]).toMatchObject({ block: { isError: true } });
  });

  it('`mcpToolCall` ⇒ 名字是「服务名.工具名」、`family: null`、`isError = error != null`', () => {
    const ok = project(
      completed({
        kind: 'mcpToolCall',
        id: 'x1',
        server: 'github',
        tool: 'list_issues',
        status: 'completed',
        durationMs: 12,
        arguments: { repo: 'a/b' },
        result: { content: [{ type: 'text', text: '3 个 issue' }], structuredContent: null, _meta: null },
        error: null,
      }),
    );
    expect(ok.drafts[0]?.blocks[0]).toMatchObject({
      block: { type: 'tool-call', callId: 'x1', family: null, name: 'github.list_issues', input: { repo: 'a/b' } },
    });
    expect(ok.drafts[1]?.blocks[0]).toMatchObject({ block: { type: 'tool-result', isError: false, text: '3 个 issue' } });

    const bad = project(
      completed({ kind: 'mcpToolCall', id: 'x2', server: 'github', tool: 'list_issues', status: 'failed', durationMs: null, arguments: null, result: null, error: { message: '401' } }),
    );
    expect(bad.drafts[1]?.blocks[0]).toMatchObject({ block: { type: 'tool-result', isError: true, text: '401', structured: null } });
  });

  it('`plan` 条目 ⇒ `family: task` + `payload.kind: plan`（这一格此前生产不投影）', () => {
    const { drafts } = project(completed({ kind: 'plan', id: 'p1', text: '先读配置' }));
    expect(drafts[0]?.blocks[0]).toMatchObject({
      block: {
        type: 'tool-call',
        family: 'task',
        name: 'update_plan',
        payload: { kind: 'plan', steps: [{ id: null, subject: '先读配置', status: 'unknown', owner: null, blockedBy: null }], note: null },
      },
    });
  });

  it('`turn/plan/updated` ⇒ 整表清单，状态四态归一（`inProgress` 是厂商拼法）', () => {
    const { drafts } = project({
      kind: 'turnPlanUpdated',
      threadId: MAIN,
      turnId: 'turn-1',
      steps: [
        { step: 'a', status: 'pending' },
        { step: 'b', status: 'inProgress' },
        { step: 'c', status: 'completed' },
        { step: 'd', status: '未知档' },
      ],
    });
    expect(drafts[0]?.blocks[0]).toMatchObject({
      block: {
        type: 'tool-call',
        family: 'task',
        name: 'update_plan',
        payload: {
          kind: 'plan',
          steps: [
            { subject: 'a', status: 'pending' },
            { subject: 'b', status: 'inProgress' },
            { subject: 'c', status: 'completed' },
            { subject: 'd', status: 'unknown' },
          ],
          note: null,
        },
      },
    });
  });

  it('`webSearch` ⇒ `query` 即入参（结果那一半结构化出口拿不到 ⇒ `null`）', () => {
    const { drafts } = project(completed({ kind: 'webSearch', id: 'w1', query: 'codex app-server' }));
    expect(drafts[0]?.blocks[0]).toMatchObject({ block: { type: 'tool-call', name: 'web_search', family: 'web-search', input: { query: 'codex app-server' } } });
    expect(drafts[1]?.blocks[0]).toMatchObject({ block: { type: 'tool-result', structured: null, isError: false } });
  });

  it('`userMessage` / `toolOutput` / 未知条目都不产消息（输入不是产出、旁路副本不重复）', () => {
    expect(project(completed({ kind: 'userMessage', id: 'u1', text: '把标题改掉' })).drafts).toEqual([]);
    expect(project(completed({ kind: 'toolOutput', id: 'o1', name: 'exec_command', namespace: null, output: 'x' })).drafts).toEqual([]);
    expect(project(completed({ kind: 'other', id: 'z1', type: 'enteredReviewMode' })).drafts).toEqual([]);
  });
});

describe('协作条目：子任务行、身份与父链', () => {
  it('`collabAgentToolCall` ⇒ 派发调用 + 每个收件线程一条子任务行（`parentCallId` = 条目 id）', () => {
    const { drafts, subagents } = project(
      completed({
        kind: 'collabToolCall',
        id: 'item_8',
        tool: 'spawn_agent',
        status: 'completed',
        senderThreadId: MAIN,
        receiverThreadIds: [CHILD],
        prompt: '检查工作区\n第二行',
        agentsStates: [{ threadId: CHILD, status: 'running', message: null }],
      }),
    );
    expect(drafts[0]?.blocks[0]).toMatchObject({
      block: { type: 'tool-call', callId: 'item_8', name: 'spawn_agent', input: { prompt: '检查工作区\n第二行' }, family: 'spawn-agent' },
    });
    expect(subagents).toEqual([
      {
        subagentId: CHILD,
        name: null,
        kind: 'spawn_agent',
        source: 'wire',
        status: 'running',
        statusMissing: null,
        outcome: null,
        parentCallId: 'item_8',
        // 顶层子任务（派发者是主线程）⇒ 父链记 null（照抄主线程 id 会指向一个不存在的节点）
        parentSubagentId: null,
        usage: null,
      },
    ]);
  });

  it('`agentsStates` 的四档状态逐档映射（`errored` → failed、`interrupted` → stopped、未知档记 unverified）', () => {
    const states = (status: string) =>
      project(
        completed({
          kind: 'collabToolCall',
          id: 'item_9',
          tool: 'spawn_agent',
          status: 'completed',
          senderThreadId: MAIN,
          receiverThreadIds: [CHILD],
          prompt: null,
          agentsStates: [{ threadId: CHILD, status, message: '结果摘要' }],
        }),
      ).subagents[0];
    expect(states('completed')).toMatchObject({ status: 'completed', statusMissing: null, outcome: '结果摘要' });
    expect(states('errored')).toMatchObject({ status: 'failed', statusMissing: null });
    expect(states('notFound')).toMatchObject({ status: 'failed' });
    expect(states('interrupted')).toMatchObject({ status: 'stopped' });
    expect(states('shutdown')).toMatchObject({ status: 'stopped' });
    expect(states('pendingInit')).toMatchObject({ status: 'running' });
    expect(states('某个新档')).toMatchObject({ status: 'unknown', statusMissing: 'unverified' });
  });

  it('嵌套派发（派发者是子线程）⇒ `parentSubagentId` 记那条子线程', () => {
    const runState = createCodexRunState();
    const { subagents } = project(
      completed(
        {
          kind: 'collabToolCall',
          id: 'item_11',
          tool: 'spawn_agent',
          status: 'completed',
          senderThreadId: CHILD,
          receiverThreadIds: ['thread-grandchild'],
          prompt: null,
          agentsStates: [],
        },
        { threadId: CHILD },
      ),
      runState,
    );
    expect(subagents[0]?.parentSubagentId).toBe(CHILD);
  });

  it('`subAgentActivity` ⇒ 只刷新状态、不产消息（它是活动条目，不是内容）', () => {
    const runState = createCodexRunState();
    project(
      completed({
        kind: 'collabToolCall',
        id: 'item_8',
        tool: 'spawn_agent',
        status: 'completed',
        senderThreadId: MAIN,
        receiverThreadIds: [CHILD],
        prompt: '任务',
        agentsStates: [{ threadId: CHILD, status: 'running', message: null }],
      }),
      runState,
    );
    const activity = project(completed({ kind: 'subAgentActivity', id: 'a1', activity: 'completed', agentThreadId: CHILD, agentPath: '/root' }), runState);
    expect(activity.drafts).toEqual([]);
    expect(activity.subagents[0]).toMatchObject({ subagentId: CHILD, status: 'completed', parentCallId: 'item_8', kind: 'spawn_agent' });
    const interrupted = project(completed({ kind: 'subAgentActivity', id: 'a2', activity: 'interrupted', agentThreadId: CHILD, agentPath: '/root' }), runState);
    expect(interrupted.subagents[0]).toMatchObject({ status: 'stopped' });
  });

  it('昵称来自 `thread/started`（`Thread.agentNickname`），子任务行读它', () => {
    const runState = createCodexRunState();
    noteThreadStarted(CHILD, '工作区检查', runState);
    const { subagents } = project(
      completed({
        kind: 'collabToolCall',
        id: 'item_8',
        tool: 'spawn_agent',
        status: 'completed',
        senderThreadId: MAIN,
        receiverThreadIds: [CHILD],
        prompt: '任务',
        agentsStates: [],
      }),
      runState,
    );
    expect(subagents[0]?.name).toBe('工作区检查');
  });
});

describe('收尾读回：子线程消息与三档终态', () => {
  function ref(overrides: Partial<AppServerThreadRef> = {}): AppServerThreadRef {
    return {
      threadId: CHILD,
      parentThreadId: MAIN,
      depth: 1,
      nickname: '工作区检查',
      role: 'worker',
      status: { type: 'idle' },
      ...overrides,
    };
  }

  function thread(overrides: Partial<AppServerThread> = {}): AppServerThread {
    return {
      id: CHILD,
      parentThreadId: MAIN,
      agentNickname: '工作区检查',
      agentRole: 'worker',
      status: { type: 'idle' },
      sourceKind: 'subAgent',
      subAgentSpawn: null,
      cwd: null,
      cliVersion: null,
      model: null,
      preview: null,
      turns: [],
      ...overrides,
    };
  }

  it('子线程的条目按 `subagentId` 归属，块与主线程同形（同一个归一函数）', () => {
    const runState = createCodexRunState();
    const entries: AppServerItemEntry[] = [
      { turnId: 'ct1', item: { kind: 'agentMessage', id: 'cm1', text: '子线程答复', phase: null } },
    ];
    const final = lastMessage(projectThreadMessages(CHILD, entries, runState, CONTEXT));
    expect(final.subagentId).toBe(CHILD);
    expect(final.blocks).toEqual([{ type: 'text', text: '子线程答复' }]);
    // 轮次那一份数在子线程自己名下
    expect(threadRoundTrips({ items: entries }, CHILD, runState)).toBe(1);
  });

  it('终态三档：`completed` / `failed` / `interrupted`（由 `turn.status` 推出）', () => {
    const completedTurn = thread({ turns: [{ id: 'ct', items: [], itemsView: 'full', status: 'completed', error: null, startedAt: null, completedAt: null, durationMs: null }] });
    expect(terminalStatusOf(ref(), completedTurn)).toEqual({ status: 'completed', statusMissing: null });
    const failedTurn = thread({ turns: [{ id: 'ct', items: [], itemsView: 'full', status: 'failed', error: '炸了', startedAt: null, completedAt: null, durationMs: null }] });
    expect(terminalStatusOf(ref(), failedTurn)).toEqual({ status: 'failed', statusMissing: null });
    const stoppedTurn = thread({ turns: [{ id: 'ct', items: [], itemsView: 'full', status: 'interrupted', error: null, startedAt: null, completedAt: null, durationMs: null }] });
    expect(terminalStatusOf(ref(), stoppedTurn)).toEqual({ status: 'stopped', statusMissing: null });
  });

  it('一条 turn 都读不到时看线程状态；`idle` **不算完成**（记 unknown + 点名原因）', () => {
    expect(terminalStatusOf(ref({ status: { type: 'systemError' } }), thread())).toEqual({ status: 'failed', statusMissing: null });
    expect(terminalStatusOf(ref({ status: { type: 'active', activeFlags: [] } }), thread())).toEqual({ status: 'running', statusMissing: null });
    expect(terminalStatusOf(ref({ status: { type: 'idle' } }), thread())).toEqual({ status: 'unknown', statusMissing: 'not-observed' });
    expect(terminalStatusOf(ref({ status: { type: 'notLoaded' } }), thread())).toEqual({ status: 'unknown', statusMissing: 'not-observed' });
  });

  it('子任务行取 `reader` 的昵称与最后一条答复作结果摘要；用量只认运行期的通知', () => {
    const runState = createCodexRunState();
    const content = thread({
      turns: [
        { id: 'ct1', items: [{ kind: 'agentMessage', id: 'cm1', text: '前面的答复', phase: null }], itemsView: 'full', status: 'completed', error: null, startedAt: null, completedAt: null, durationMs: null },
        { id: 'ct2', items: [{ kind: 'agentMessage', id: 'cm2', text: '最终答复', phase: null }], itemsView: 'full', status: 'completed', error: null, startedAt: null, completedAt: null, durationMs: null },
      ],
    });
    const record = projectSubagentRecord(ref(), content, runState, CONTEXT);
    expect(record).toMatchObject({ subagentId: CHILD, name: '工作区检查', outcome: '最终答复', status: 'completed', parentSubagentId: null, parentCallId: null, usage: null });
  });

  it('嵌套子线程的父链记它的父那条子线程（不是主线程）', () => {
    const runState = createCodexRunState();
    const nested = projectSubagentRecord(ref({ threadId: 'thread-grandchild', parentThreadId: CHILD }), null, runState, CONTEXT);
    expect(nested.parentSubagentId).toBe(CHILD);
  });
});
