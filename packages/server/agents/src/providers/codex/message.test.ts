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

/**
 * 消费方的折叠口径（与 `build-model.ts` / `row-messages.ts` 逐字相同）：**同 `mergeKey` 留最后一条**，
 * 顺序按首次出现。界面上「几条消息」判的就是它——合并器每次投递都发一条，那不是条数。
 */
function fold(messages: readonly AgentMessage[]): AgentMessage[] {
  const byKey = new Map<string, AgentMessage>();
  for (const message of messages) byKey.set(message.mergeKey, message);
  return [...byKey.values()];
}

/** 把一串通知走一遍本层的归一，再按消费方口径折叠（断言「界面上看到几条」用这个） */
function renderedOf(payloads: readonly AppServerNotificationPayload[], runState: CodexRunState): AgentMessage[] {
  const drafts: MessageDraft[] = [];
  for (const payload of payloads) drafts.push(...project(payload, runState).drafts);
  return fold(assemble(drafts));
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

/**
 * 往返号源（回归守卫）。
 *
 * 要拦的缺陷：号源按「**答复条目数**」去重时，一次 turn 里所有条目共用一个合并键——因为一次
 * 模型往返里只有收尾那次会发 `agentMessage`，中间那些「想 + 调工具」的往返一条答复都没有
 * ⇒ 整轮的思考、工具调用与最终答复被折叠成一条消息（界面上只剩最后那一条）。
 *
 * 形状全部取自真机：条目的 id 与顺序照抄 `53fa183a` 的 codex 行落盘、探针抓包
 * （`probe/dumps/v11/codex-*-live.jsonl`）与 `f4e3f5c1`（提问那一轮）。
 */
describe('往返号源：一次模型往返一条消息', () => {
  it('「想 → 调工具 → 想 → 答复」⇒ 三条消息，工具调用归**它自己那次**往返', () => {
    const runState = createCodexRunState();
    const rendered = renderedOf(
      [
        completed({ kind: 'reasoning', id: 'rs_23452b0748824e1db984a3ccc73337b9', summary: ['先读技能文件'], content: [] }),
        started({ kind: 'commandExecution', id: 'call_34490b509fdb4e7495168d86', command: 'cat SKILL.md', cwd: null, status: 'inProgress', output: null, exitCode: null, durationMs: null }),
        completed({ kind: 'commandExecution', id: 'call_34490b509fdb4e7495168d86', command: 'cat SKILL.md', cwd: null, status: 'completed', output: 'name: poetry', exitCode: 0, durationMs: 12 }),
        completed({ kind: 'reasoning', id: 'rs_b959754e5ed84827ad41bf7eb79d8e3d', summary: ['挑一首与吃饭相关的唐诗'], content: [] }),
        completed({ kind: 'agentMessage', id: 'msg_b959754e5ed84827ad41bf7eb79d8e3d', text: '《过故人庄》：故人具鸡黍…您吃了吗？', phase: null }),
      ],
      runState,
    );
    // 三条逻辑消息：第一次往返（思考 + 调用）、它的结果、第二次往返（思考 + 正文）
    expect(rendered.map((one) => one.mergeKey)).toEqual(['main|1|assistant|-', 'main|1|tool|-', 'main|2|assistant|-']);
    expect(rendered[0]?.blocks.map((one) => one.type)).toEqual(['thinking', 'tool-call']);
    expect(rendered[1]?.blocks.map((one) => one.type)).toEqual(['tool-result']);
    // 正文与**它自己那次**往返的思考同一条消息（不是与第一条挤在一起）
    expect(rendered[2]?.blocks.map((one) => one.type)).toEqual(['thinking', 'text']);
    expect(rendered.map((one) => one.roundTrip)).toEqual([1, 1, 2]);
  });

  it('同一次往返的推理与答复**共享一个号**（响应 id 相同 ⇒ 不拆成两条）', () => {
    const runState = createCodexRunState();
    const rendered = renderedOf(
      [
        started({ kind: 'reasoning', id: 'rs_afc045d551954c08aec2314b82e669f5', summary: [], content: [] }),
        completed({ kind: 'reasoning', id: 'rs_afc045d551954c08aec2314b82e669f5', summary: ['只回 ok'], content: [] }),
        started({ kind: 'agentMessage', id: 'msg_afc045d551954c08aec2314b82e669f5', text: '', phase: null }),
        completed({ kind: 'agentMessage', id: 'msg_afc045d551954c08aec2314b82e669f5', text: 'ok', phase: null }),
      ],
      runState,
    );
    expect(rendered).toHaveLength(1);
    expect(rendered[0]?.roundTrip).toBe(1);
    expect(rendered[0]?.blocks.map((one) => one.type)).toEqual(['thinking', 'text']);
  });

  it('提问那一轮：答复之间没有工具条目，也要各占一个号（结构判据单独用会漏）', () => {
    const runState = createCodexRunState();
    const rendered = renderedOf(
      [
        completed({ kind: 'reasoning', id: 'rs_554fcac0-144e-4daf-9b30-f8c1b55788ea', summary: [], content: ['先登记计划'] }),
        completed({ kind: 'agentMessage', id: 'msg_554fcac0-144e-4daf-9b30-f8c1b55788ea', text: '我先登记计划，然后向你询问岗位。', phase: null }),
        completed({ kind: 'reasoning', id: 'rs_46616bbb-93cc-416e-a0e4-1d4988f0a9c6', summary: [], content: ['这一轮想想怎么问'] }),
        completed({ kind: 'reasoning', id: 'rs_11b53827-e9c3-4fc9-a946-417447825cee', summary: [], content: ['收到岗位'] }),
        completed({ kind: 'agentMessage', id: 'msg_11b53827-e9c3-4fc9-a946-417447825cee', text: '收到，岗位是软件研发。', phase: null }),
        completed({ kind: 'agentMessage', id: 'msg_c111735e-1417-4378-b8ef-7deee0528a7e', text: '任务已完成。', phase: null }),
      ],
      runState,
    );
    expect(rendered.map((one) => one.mergeKey)).toEqual(['main|1|assistant|-', 'main|2|assistant|-', 'main|3|assistant|-', 'main|4|assistant|-']);
    expect(rendered.map((one) => one.roundTrip)).toEqual([1, 2, 3, 4]);
  });

  it('turn 第一条通知就是命令执行（模型这一次没发推理）⇒ 调用占第 1 次往返，答复是第 2 次', () => {
    const runState = createCodexRunState();
    const rendered = renderedOf(
      [
        completed({ kind: 'commandExecution', id: 'call_2b7d9bd28604424aa791281e', command: 'cat SKILL.md', cwd: null, status: 'completed', output: 'name: poetry', exitCode: 0, durationMs: 9 }),
        completed({ kind: 'reasoning', id: 'rs_001fdfe1f7f84075bd0a1e3d8d4f082a', summary: [], content: ['挑一首'] }),
        completed({ kind: 'agentMessage', id: 'msg_001fdfe1f7f84075bd0a1e3d8d4f082a', text: '为您挑选《过故人庄》。', phase: null }),
      ],
      runState,
    );
    expect(rendered.map((one) => one.mergeKey)).toEqual(['main|1|assistant|-', 'main|1|tool|-', 'main|2|assistant|-']);
    expect(rendered[0]?.blocks.map((one) => one.type)).toEqual(['tool-call']);
    expect(rendered[2]?.blocks.map((one) => one.type)).toEqual(['thinking', 'text']);
  });

  it('增量先到（`item/started` 还没来）也落在它自己那次往返里，快照随后封同一个槽', () => {
    /** 第二次往返的三条通知（增量先到、`item/started` 缺席、快照最后到） */
    const secondTrip = [
      { kind: 'agentMessageDelta', threadId: MAIN, turnId: 'turn-1', itemId: 'msg_bbb222', delta: '半' },
      completed({ kind: 'agentMessage', id: 'msg_bbb222', text: '半截就够了', phase: null }),
    ] as const;
    const before = [
      completed({ kind: 'agentMessage', id: 'msg_aaa111', text: '第一段答复', phase: null }),
      completed({ kind: 'commandExecution', id: 'call_x1', command: 'ls', cwd: null, status: 'completed', output: '', exitCode: 0, durationMs: 1 }),
    ] as const;

    // 增量单独先到：它已经把号开出来（不会被塞进第一次往返的载体）
    const partial = renderedOf([...before, secondTrip[0]], createCodexRunState());
    expect(partial.at(-1)?.mergeKey).toBe('main|2|assistant|-');

    // 快照随后到达：落在**同一个键**上（增量与快照不会各开一条消息）
    const settled = renderedOf([...before, ...secondTrip], createCodexRunState());
    expect(settled.map((one) => one.mergeKey)).toEqual(['main|1|assistant|-', 'main|1|tool|-', 'main|2|assistant|-']);
    expect(settled.at(-1)?.blocks).toEqual([{ type: 'text', text: '半截就够了' }]);
    expect(settled.at(-1)?.assembly).toBe('snapshot');
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
   * 真机序列（`probe/dumps/v5/codex-appserver-reasoning-*.jsonl`）：
   * `item/started` 的推理条目 `summary` 与 `content` **都是空数组**，随后是几十条
   * `item/reasoning/textDelta`，最后 `item/completed` 给出与增量**逐字相同**的全文。
   *
   * 这条用例拦的是一个**在产物里一眼可见**的缺陷：`item/started` 落的那一块空快照
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
  /**
   * **`item/started` 的命令执行只出调用块**。
   *
   * 要拦的缺陷：那一刻就把结果块也发出去。这一家的结果块在 `started` 状态下**不携带任何
   * 「还在跑」的信息**——`exitCode` 与 `durationMs` 都是 `null` ⇒ `structured` 整格 `null`、
   * `output` 是空串、`isError` 是 `false`（契约里 `tool-result` 没有第三态，`false` 就是
   * 「没出错」这条断言）。代价有两层：跑动期界面显示「工具已返回空结果」；而块一旦以 snapshot
   * 落进槽位就 seal，进程在命令中途被杀时，这条「成功、空输出」就是账本里的终态。
   */
  it('`item/started` 的命令执行**只出调用块**（结果要等 completed，不许先发一条「成功、空输出」）', () => {
    const runState = createCodexRunState();
    const inFlight = project(
      started({ kind: 'commandExecution', id: 'c9', command: 'pnpm test', cwd: null, status: 'inProgress', output: null, exitCode: null, durationMs: null }),
      runState,
    );
    expect(inFlight.drafts.map((one) => one.role)).toEqual(['assistant']);

    // 完成那一拍才出结果，并且与调用块落在同一个载体上（增量与快照同槽的那条口径）
    const done = project(
      completed({ kind: 'commandExecution', id: 'c9', command: 'pnpm test', cwd: null, status: 'completed', output: 'ok', exitCode: 0, durationMs: 7 }),
      runState,
    );
    expect(done.drafts.map((one) => one.role)).toEqual(['assistant', 'tool']);
  });

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
        // 摘要主体随块给出：词表真源是 `activity.ts`，浏览器直接读这一格。
        // codex 侧**没有** `description` 这一格（协议里真没有）⇒ 走 `run-shell` 族拼法：给命令原文
        summary: 'npm run build',
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

  it('`mcpToolCall` ⇒ 名字是「`mcp__服务名__工具名`」（与共享约定、另几家同形）、`family: null`、`isError = error != null`', () => {
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
      block: { type: 'tool-call', callId: 'x1', family: null, name: 'mcp__github__list_issues', input: { repo: 'a/b' } },
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

  it('`userMessage` / `toolOutput` 不产消息（输入不是产出、旁路副本不重复）', () => {
    expect(project(completed({ kind: 'userMessage', id: 'u1', text: '把标题改掉' })).drafts).toEqual([]);
    expect(project(completed({ kind: 'toolOutput', id: 'o1', name: 'exec_command', namespace: null, output: 'x' })).drafts).toEqual([]);
  });

  /**
   * `imageView` 是**认识的**条目类型：模型看过的一张图，厂商只给路径。
   * 归一是 `image-view` 块（界面据此画缩略图），**不是** `unrecognized`——后者是留给
   * 我们确实归不了的类型的兜底，混用会让「看了一张图」与「这里有一条看不懂的东西」同形。
   */
  it('`imageView` ⇒ 一条 `image-view` 块（路径照原文，不做相对化）', () => {
    const { drafts } = project(completed({
      kind: 'other',
      id: 'call_img_0',
      type: 'imageView',
      raw: { type: 'imageView', id: 'call_img_0', path: '/w/workspace/pixel.png' },
    }));
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.vendorId).toBe('call_img_0');
    expect(drafts[0]?.blocks[0]).toMatchObject({
      phase: 'snapshot',
      block: { type: 'image-view', path: '/w/workspace/pixel.png' },
    });
  });

  it('`imageView` 拿不到路径 ⇒ 落回 `unrecognized` 且 `reason` 是 `unmapped-shape`（类型认识、形状对不上）', () => {
    const { drafts } = project(completed({ kind: 'other', id: 'call_img_1', type: 'imageView', raw: { type: 'imageView', id: 'call_img_1' } }));
    expect(drafts[0]?.blocks[0]).toMatchObject({
      block: { type: 'unrecognized', reason: 'unmapped-shape', vendorType: 'imageView' },
    });
  });

  /**
   * 未识别的条目类型**必须留痕**（一条 `unrecognized` 块，厂商原文进 `raw`）。
   *
   * 要拦的缺陷：什么都不产。未识别的**方法**有 `unknownEventDraft` 兜底，未识别的**类型**此前
   * 两处投影（本文件的 `projectItem` 与 `events.ts` 的 `activityDrafts`）都没有分支，也没有轮次
   * 留痕 ⇒ 厂商真投了、我们一个字都不留：「厂商没发」与「厂商发了、我们没接」在产物里长得
   * 一模一样。真机读数（`image-view-live.test.ts`）：`imageView` 两帧，命中数 0。
   *
   * 样本取 `sleep`：它是今天仍然没有归一分支的类型之一（`imageView` 已经有自己的块了）。
   */
  it('未识别的条目类型 ⇒ 一条 `unrecognized` 块，`vendorType` 与 `raw` 都留原文', () => {
    const { drafts } = project(completed({
      kind: 'other',
      id: 'z1',
      type: 'sleep',
      raw: { type: 'sleep', id: 'z1', durationMs: 1200 },
    }));
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.vendorId).toBe('z1');
    expect(drafts[0]?.blocks[0]).toMatchObject({
      phase: 'snapshot',
      block: { type: 'unrecognized', reason: 'unrecognized', vendorType: 'sleep', raw: '{"type":"sleep","id":"z1","durationMs":1200}' },
    });
  });

  it('未识别的条目在 `item/started` 上不产块（那一刻内容还没定，与 fileChange / agentMessage 同口径）', () => {
    expect(project(started({ kind: 'other', id: 'z1', type: 'sleep', raw: { type: 'sleep', id: 'z1' } })).drafts).toEqual([]);
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

  /**
   * **派发台账只能由派发动作写，而且先到的赢**。
   *
   * 要拦的缺陷：对每条 `collabToolCall` 无条件覆盖同一个 receiver 的台账。`wait` / `closeAgent`
   * 与 `spawnAgent` **共享 `receiverThreadIds`**，而真机顺序是派发在后（receiver id 要到
   * `item/completed` 才出现，`wait` 在 `item/started` 就带着它）⇒ 覆盖必然让台账停在**等待**
   * 那次调用上，于是子任务行的 `kind` 变成 `wait`、`parentCallId` 指向等待调用，界面按它去
   * 时间轴找「进入子任务」的入口就落到了错的卡片上，收尾 `projectSubagentRecord` 还会把它落盘。
   */
  it('`wait` / `closeAgent` 不许改写派发台账（候选上的 `kind` 与 `parentCallId` 仍指向派发那一次）', () => {
    const runState = createCodexRunState();
    const collab = (id: string, tool: string) =>
      completed({
        kind: 'collabToolCall',
        id,
        tool,
        status: 'completed',
        senderThreadId: MAIN,
        receiverThreadIds: [CHILD],
        prompt: null,
        agentsStates: [{ threadId: CHILD, status: 'running', message: null }],
      });

    project(collab('item_dispatch', 'spawnAgent'), runState);
    // 随后对同一个子线程发起等待（真机的常规形态：派发完就 wait）
    const waited = project(collab('item_wait', 'wait'), runState);

    expect(waited.subagents[0]).toMatchObject({ subagentId: CHILD, kind: 'spawnAgent', parentCallId: 'item_dispatch' });
    expect(runState.dispatches.get(CHILD)).toEqual({ tool: 'spawnAgent', callId: 'item_dispatch', parentThreadId: MAIN });
  });

  /**
   * **真机序列回放**（真模型臂 12 条投递序列）：`wait` / `closeAgent` 的 `item/started` 带
   * `agentsStates: {}`，而它排在**收场之后**到达；折叠是整条覆盖 ⇒ 那一帧会把已经采到的
   * `completed` + `outcome` 打回 `unknown/unverified` + `null`。
   *
   * 两条判据：① 什么也没说的 started 帧**不产记录**；② 已采到的事实不许被后来的帧抹掉
   * （口径与套件 `PRESERVED_SUBAGENT_FIELDS` 同源）。
   */
  it('`wait` / `closeAgent` 的 started（`agentsStates` 为空）不产记录，也不许抹掉已采到的结论', () => {
    const runState = createCodexRunState();
    const collab = (id: string, tool: string, states: Array<{ threadId: string; status: string; message: string | null }>) => ({
      kind: 'collabToolCall' as const,
      id,
      tool,
      status: 'completed',
      senderThreadId: MAIN,
      receiverThreadIds: [CHILD],
      prompt: null,
      agentsStates: states,
    });

    // 1) 派发（completed）：收件线程那一刻才出现 ⇒ 候选上有 kind / parentCallId
    const dispatched = project(completed(collab('item_dispatch', 'spawnAgent', [{ threadId: CHILD, status: 'running', message: null }])), runState);
    expect(dispatched.subagents[0]).toMatchObject({ status: 'running', outcome: null });
    // 2) wait 的 completed：带上子线程的结论
    const settled = project(completed(collab('item_wait', 'wait', [{ threadId: CHILD, status: 'completed', message: '三个文件' }])), runState);
    expect(settled.subagents[0]).toMatchObject({ status: 'completed', outcome: '三个文件' });
    // 3) closeAgent 的 **started**：真机上 `agentsStates` 是空的 ⇒ 一个记录都不该产
    const closing = project(started(collab('item_close', 'closeAgent', [])), runState);
    expect(closing.subagents).toEqual([]);
    // 4) closeAgent 的 completed 仍照旧出记录，且结论还在
    const closed = project(completed(collab('item_close', 'closeAgent', [{ threadId: CHILD, status: 'completed', message: '三个文件' }])), runState);
    expect(closed.subagents[0]).toMatchObject({ status: 'completed', outcome: '三个文件', kind: 'spawnAgent', parentCallId: 'item_dispatch' });
  });

  it('活动条目（`subAgentActivity`）不带结论 ⇒ 保留已采到的那一份（不许抹成 null）', () => {
    const runState = createCodexRunState();
    project(completed({
      kind: 'collabToolCall',
      id: 'item_dispatch',
      tool: 'spawnAgent',
      status: 'completed',
      senderThreadId: MAIN,
      receiverThreadIds: [CHILD],
      prompt: null,
      agentsStates: [{ threadId: CHILD, status: 'completed', message: '三个文件' }],
    }), runState);
    const activity = project(completed({ kind: 'subAgentActivity', id: 'a1', activity: 'interacted', agentThreadId: CHILD, agentPath: '/root' }), runState);
    expect(activity.subagents[0]).toMatchObject({ status: 'running', outcome: '三个文件' });
  });

  /**
   * 真机派发名是 **camelCase**（`spawnAgent`）。族表只登记 snake_case 的话派发块的族是 `null`
   * ——界面丢「派子任务」标签、族维度统计漏算；而用例若按 snake_case 写就恒绿、看不出来。
   */
  it('真机的 camelCase 派发名也归 `spawn-agent` 族', () => {
    const { drafts } = project(
      completed({
        kind: 'collabToolCall',
        id: 'item_c',
        tool: 'spawnAgent',
        status: 'completed',
        senderThreadId: MAIN,
        receiverThreadIds: [CHILD],
        prompt: '去查一下',
        agentsStates: [],
      }),
    );
    expect(drafts[0]?.blocks[0]).toMatchObject({ block: { type: 'tool-call', name: 'spawnAgent', family: 'spawn-agent' } });
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

  it('收尾回读的一批条目**自带开号**：多条往返各成一条消息（这条路上一条运行期通知都没走过）', () => {
    const runState = createCodexRunState();
    // 真机形状：子线程第一轮（想 + 调工具）→ 工具执行 → 第二轮（想 + 答复）
    const entries: AppServerItemEntry[] = [
      { turnId: 'ct1', item: { kind: 'reasoning', id: 'rs_8ebd9f8f-89d3-438d-93d4-c9c1e23211e3', summary: [], content: ['先读文件'] } },
      { turnId: 'ct1', item: { kind: 'agentMessage', id: 'msg_8ebd9f8f-89d3-438d-93d4-c9c1e23211e3', text: '我来看一下这个文件。', phase: null } },
      { turnId: 'ct1', item: { kind: 'commandExecution', id: 'call_00_7RR1CVUye1qqxJCPbnNL2426', command: 'cat index.html', cwd: null, status: 'completed', output: '<html>', exitCode: 0, durationMs: 8 } },
      { turnId: 'ct1', item: { kind: 'reasoning', id: 'rs_49abb8b9-3c1f-4bc9-82eb-f8d72991f9db', summary: [], content: ['结构没问题'] } },
      { turnId: 'ct1', item: { kind: 'agentMessage', id: 'msg_49abb8b9-3c1f-4bc9-82eb-f8d72991f9db', text: '结构完整，可以收尾。', phase: null } },
    ];
    const rendered = fold(assemble(projectThreadMessages(CHILD, entries, runState, CONTEXT)));
    expect(rendered.map((one) => one.mergeKey)).toEqual([`${CHILD}|1|assistant|-`, `${CHILD}|1|tool|-`, `${CHILD}|2|assistant|-`]);
    expect(rendered[0]?.blocks.map((one) => one.type)).toEqual(['thinking', 'text', 'tool-call']);
    expect(rendered[2]?.blocks.map((one) => one.type)).toEqual(['thinking', 'text']);
    // 与收尾求和读的是同一把尺子（`threadRoundTrips` 会把同一批再数一遍，幂等）
    expect(threadRoundTrips({ items: entries }, CHILD, runState)).toBe(2);
  });

  it('终态三档：`completed` / `failed` / `interrupted`（由 `turn.status` 推出）', () => {
    const completedTurn = thread({ turns: [{ id: 'ct', items: [], itemsView: 'full', status: 'completed', error: null, errorCode: null,
      errorStatusCode: null, startedAt: null, completedAt: null, durationMs: null }] });
    expect(terminalStatusOf(ref(), completedTurn)).toEqual({ status: 'completed', statusMissing: null });
    const failedTurn = thread({ turns: [{ id: 'ct', items: [], itemsView: 'full', status: 'failed', error: '炸了', errorCode: null,
      errorStatusCode: null, startedAt: null, completedAt: null, durationMs: null }] });
    expect(terminalStatusOf(ref(), failedTurn)).toEqual({ status: 'failed', statusMissing: null });
    const stoppedTurn = thread({ turns: [{ id: 'ct', items: [], itemsView: 'full', status: 'interrupted', error: null, errorCode: null,
      errorStatusCode: null, startedAt: null, completedAt: null, durationMs: null }] });
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
        { id: 'ct1', items: [{ kind: 'agentMessage', id: 'cm1', text: '前面的答复', phase: null }], itemsView: 'full', status: 'completed', error: null, errorCode: null,
          errorStatusCode: null, startedAt: null, completedAt: null, durationMs: null },
        { id: 'ct2', items: [{ kind: 'agentMessage', id: 'cm2', text: '最终答复', phase: null }], itemsView: 'full', status: 'completed', error: null, errorCode: null,
          errorStatusCode: null, startedAt: null, completedAt: null, durationMs: null },
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
