// @vitest-environment node
/**
 * cc 的**任务台账**：把 `TaskCreate` / `TaskUpdate` 的逐条 patch 累积成整表，作为 `plan` 载荷
 * 挂到工具调用块上——codex（`update_plan`）与 dsh（`todo_write`）的入参本来就是整表，
 * 这一家是**工作项注册表**（`TaskStep` 契约注释里 `id` / `owner` / `blockedBy` 三维「只有 claude 有」
 * 说的就是它），不累积就永远出不了「计划清单」卡片。
 *
 * 本文件守两条：
 *   1. **端到端**：真机那七条帧（`f4e3f5c1` 的 cc 行）走「归一器 → 合并器 → 按 `mergeKey` 折叠」
 *      之后，每个 `Task*` 调用块都带整表载荷，且最后一条是两步全 `completed`；
 *   2. **台账自己的边界**：未知状态串、`deleted`、未见过的 id、认不出的结果形状。
 *
 * 真机逐字（`Task*` 五处取值都取自那一行的 `events.jsonl`）：
 *   · `TaskCreate` 结果只有 `{"task":{"id","subject"}}`——**没有状态**（SDK 的 `TaskCreateOutput` 同形）
 *     ⇒ 「刚建、还没更新过」按 `pending` 起步，依据是同一条 run 里 `TaskUpdate` 结果的
 *     `statusChange.from` 逐字写着 `"pending"`；
 *   · `TaskUpdate` 结果给 `{"taskId","statusChange":{"from","to"}}`。
 */
import { describe, expect, it } from 'vitest';
import type { AgentMessage, TaskStep, ToolCallPayload } from '@aieval/contracts';
import { createMessageAssembler } from '../../message';
import type { TurnState } from '../../turn';
import { createClaudeMessageNormalizer } from './message';
import { createClaudeTaskRegistry } from './task-registry';

/** 空状态；轮次号由 `feed` 按真机那条 `countModelRoundTrip`（去重 `message.id` 计数）推进 */
function state(): TurnState {
  return {
    seen: new Set(),
    turns: 0,
    usageInput: null,
    usageCached: null,
    usageOutput: null,
    usageReasoningOutput: null,
    usageTotal: null,
    timing: null,
    usageByMessageId: new Map(),
    turnKeys: new Set(),
    finalText: null,
  };
}

function assistantFrame(messageId: string, uuid: string, content: unknown[]): unknown {
  return {
    type: 'assistant',
    uuid,
    parent_tool_use_id: null,
    message: { id: messageId, type: 'message', role: 'assistant', content },
  };
}

function resultFrame(uuid: string, callId: string, text: string, toolUseResult: unknown): unknown {
  return {
    type: 'user',
    uuid,
    parent_tool_use_id: null,
    message: { role: 'user', content: [{ tool_use_id: callId, type: 'tool_result', content: text }] },
    tool_use_result: toolUseResult,
  };
}

const CREATE_1 = 'call_00_iJbkK0SnNj8oxJmAfO252643';
const CREATE_2 = 'call_01_aOk6Vt4JHft2Yab1AILv0342';
const UPDATE_1 = 'call_00_rVMZUgrWQ3VKtOFtKooS4115';
const UPDATE_2 = 'call_00_EOIQpk04LvQP144kbwrc0551';
const UPDATE_3 = 'call_01_HC0UCMlPJ9CfJQCy4W9L4562';
const UPDATE_4 = 'call_00_W5Uer2sEoIlbNiUTkfW79085';

const SUBJECT_1 = '采集信息：询问用户工作岗位';
const SUBJECT_2 = '分析能够与 AI 契合的场景';

/** 一条 run 的帧流：与真机逐条对齐（同一个 `message.id` 分多次投递、每条只带一个内容块） */
const FRAMES: readonly unknown[] = [
  assistantFrame('msg_cc_1', 'u1', [
    {
      type: 'tool_use',
      id: CREATE_1,
      name: 'TaskCreate',
      input: { subject: SUBJECT_1, description: '使用 AskUserQuestion 工具询问用户的工作岗位，作为后续 AI 场景分析的基础信息。', activeForm: '正在采集用户工作岗位信息' },
    },
  ]),
  resultFrame('u2', CREATE_1, `Task #1 created successfully: ${SUBJECT_1}`, { task: { id: '1', subject: SUBJECT_1 } }),
  assistantFrame('msg_cc_1', 'u3', [
    {
      type: 'tool_use',
      id: CREATE_2,
      name: 'TaskCreate',
      input: { subject: SUBJECT_2, description: '基于采集到的工作岗位信息，分析该岗位/行业中能够与 AI 契合、可被 AI 增强或自动化的具体场景。', activeForm: '正在分析可契合 AI 的场景' },
    },
  ]),
  resultFrame('u4', CREATE_2, `Task #2 created successfully: ${SUBJECT_2}`, { task: { id: '2', subject: SUBJECT_2 } }),
  assistantFrame('msg_cc_2', 'u5', [{ type: 'tool_use', id: UPDATE_1, name: 'TaskUpdate', input: { taskId: '1', status: 'in_progress' } }]),
  resultFrame('u6', UPDATE_1, 'Updated task #1 status', { success: true, taskId: '1', updatedFields: ['status'], statusChange: { from: 'pending', to: 'in_progress' } }),
  assistantFrame('msg_cc_4', 'u7', [
    { type: 'tool_use', id: UPDATE_2, name: 'TaskUpdate', input: { status: 'completed', taskId: '1' } },
    { type: 'tool_use', id: UPDATE_3, name: 'TaskUpdate', input: { status: 'in_progress', taskId: '2' } },
  ]),
  resultFrame('u8', UPDATE_2, 'Updated task #1 status', { success: true, taskId: '1', updatedFields: ['status'], statusChange: { from: 'in_progress', to: 'completed' } }),
  resultFrame('u9', UPDATE_3, 'Updated task #2 status', { success: true, taskId: '2', updatedFields: ['status'], statusChange: { from: 'pending', to: 'in_progress' } }),
  assistantFrame('msg_cc_5', 'u10', [{ type: 'tool_use', id: UPDATE_4, name: 'TaskUpdate', input: { status: 'completed', taskId: '2' } }]),
  resultFrame('u11', UPDATE_4, 'Updated task #2 status', { success: true, taskId: '2', updatedFields: ['status'], statusChange: { from: 'in_progress', to: 'completed' } }),
];

/**
 * 跑一遍真机帧流，回吐**按 `mergeKey` 折叠**后的消息（与界面读侧同一条口径：同键 last-wins）。
 * 轮次号照 `events.ts` 的 `countModelRoundTrip` 推进（去重 `message.id` 计数）——它是
 * 「同一个载体」的判据之一，不推进就会把六个轮次挤成一个载体。
 */
function foldFrames(frames: readonly unknown[]): AgentMessage[] {
  const st = state();
  const normalizer = createClaudeMessageNormalizer();
  const assembler = createMessageAssembler({ runId: 'run-cc' });
  const folded = new Map<string, AgentMessage>();
  for (const frame of frames) {
    const raw = frame as { type?: string; message?: { id?: string } };
    if (raw.type === 'assistant' && typeof raw.message?.id === 'string') {
      st.turnKeys.add(raw.message.id);
      st.turns = st.turnKeys.size;
    }
    for (const draft of normalizer.normalize(frame, st).messages) {
      assembler.ingest(draft, (message) => folded.set(message.mergeKey, message));
    }
  }
  return [...folded.values()];
}

/** 折叠后每一条 `Task*` 调用块（按 `callId` 索引）的载荷 */
function planByCallId(messages: readonly AgentMessage[]): Map<string, ToolCallPayload | null> {
  const out = new Map<string, ToolCallPayload | null>();
  for (const message of messages) {
    for (const block of message.blocks) {
      if (block.type === 'tool-call' && block.family === 'task') out.set(block.callId, block.payload ?? null);
    }
  }
  return out;
}

function stepsOf(payload: ToolCallPayload | null | undefined): readonly TaskStep[] {
  if (payload === null || payload === undefined || payload.kind !== 'plan') throw new Error(`不是 plan 载荷：${JSON.stringify(payload)}`);
  return payload.steps;
}

describe('cc：Task* 逐条 patch 累积成整表（真机帧）', () => {
  it('每个 Task* 调用块都带整表载荷（今天恒 null ⇒ 界面只出通用工具行、没有「计划清单」卡片）', () => {
    const plans = planByCallId(foldFrames(FRAMES));
    expect([...plans.keys()].sort()).toEqual([CREATE_1, CREATE_2, UPDATE_1, UPDATE_2, UPDATE_3, UPDATE_4].sort());
    for (const [callId, payload] of plans) {
      expect(payload, `${callId} 没有 plan 载荷`).not.toBeNull();
      expect(payload?.kind).toBe('plan');
    }
  });

  it('第一条 TaskCreate 的载荷 = 此刻已入账的那一步（id 由随后的结果回填）', () => {
    const plans = planByCallId(foldFrames(FRAMES));
    expect(stepsOf(plans.get(CREATE_1))).toEqual<TaskStep[]>([
      // `owner: ''` = 有「指派」这个概念、当前无人认领；`blockedBy: []` = 有依赖概念、当前没有依赖
      // （契约：`id` / `owner` / `blockedBy` 三维只有 claude 的 `Task*` 有）
      { id: '1', subject: SUBJECT_1, status: 'pending', owner: '', blockedBy: [] },
    ]);
    expect(stepsOf(plans.get(CREATE_2))).toEqual<TaskStep[]>([
      { id: '1', subject: SUBJECT_1, status: 'pending', owner: '', blockedBy: [] },
      { id: '2', subject: SUBJECT_2, status: 'pending', owner: '', blockedBy: [] },
    ]);
  });

  it('TaskUpdate 的载荷是**此刻的整张表**：轮 2 一步进行中，轮 5 两步全完成', () => {
    const plans = planByCallId(foldFrames(FRAMES));
    expect(stepsOf(plans.get(UPDATE_1)).map((step) => step.status)).toEqual(['inProgress', 'pending']);
    // 轮 4 的两条更新在**同一条消息**里：`UPDATE_2` 的结果到达时 `UPDATE_3` 也已入账
    // ⇒ 它那份刷新载荷是「此刻」的表（面板只画本轮最后那条调用，这一条不参与渲染）
    expect(stepsOf(plans.get(UPDATE_2)).map((step) => step.status)).toEqual(['completed', 'inProgress']);
    expect(stepsOf(plans.get(UPDATE_3)).map((step) => step.status)).toEqual(['completed', 'inProgress']);
    expect(stepsOf(plans.get(UPDATE_4))).toEqual<TaskStep[]>([
      { id: '1', subject: SUBJECT_1, status: 'completed', owner: '', blockedBy: [] },
      { id: '2', subject: SUBJECT_2, status: 'completed', owner: '', blockedBy: [] },
    ]);
  });

  it('刷新落在**同一条逻辑消息**上（重投快照，不新增合并键）', () => {
    // 四个不同的 `message.id` ⇒ 四条 `main|<n>|assistant` 载体；刷新若自开一个键，这里会多出来
    const keys = foldFrames(FRAMES)
      .map((message) => message.mergeKey)
      .filter((key) => key.startsWith('main|') && key.endsWith('|assistant|-'));
    expect(keys).toEqual(['main|1|assistant|-', 'main|2|assistant|-', 'main|3|assistant|-', 'main|4|assistant|-']);
  });
});

describe('cc：任务台账自己的边界', () => {
  it('`TaskUpdate` 的 status 认不出时落 `unknown`（不猜成待办，也不猜成完成）', () => {
    const registry = createClaudeTaskRegistry();
    registry.onCall({ callId: 'c1', name: 'TaskCreate', input: { subject: '甲' }, envelope: ENVELOPE });
    registry.onResult('c1', { task: { id: '1', subject: '甲' } });
    registry.onCall({ callId: 'c2', name: 'TaskUpdate', input: { taskId: '1', status: 'frobnicated' }, envelope: ENVELOPE });
    const steps = stepsOf(registry.payload());
    expect(steps[0]?.status).toBe('unknown');
  });

  it('`deleted` 按**移除**处置（它是这个指令的语义；面板画的是清单当前状态，不是历史）', () => {
    const registry = createClaudeTaskRegistry();
    registry.onCall({ callId: 'c1', name: 'TaskCreate', input: { subject: '甲' }, envelope: ENVELOPE });
    registry.onResult('c1', { task: { id: '1', subject: '甲' } });
    registry.onCall({ callId: 'c2', name: 'TaskCreate', input: { subject: '乙' }, envelope: ENVELOPE });
    registry.onResult('c2', { task: { id: '2', subject: '乙' } });
    registry.onCall({ callId: 'c3', name: 'TaskUpdate', input: { taskId: '1', status: 'deleted' }, envelope: ENVELOPE });
    expect(stepsOf(registry.payload()).map((step) => step.subject)).toEqual(['乙']);
  });

  it('没见过的 id：先记下状态，等它的创建结果到了再合并（不凭空造一行）', () => {
    const registry = createClaudeTaskRegistry();
    registry.onCall({ callId: 'c1', name: 'TaskUpdate', input: { taskId: '9', status: 'in_progress' }, envelope: ENVELOPE });
    expect(stepsOf(registry.payload())).toEqual([]);
    registry.onCall({ callId: 'c2', name: 'TaskCreate', input: { subject: '丙' }, envelope: ENVELOPE });
    registry.onResult('c2', { task: { id: '9', subject: '丙' } });
    expect(stepsOf(registry.payload())).toEqual<TaskStep[]>([
      { id: '9', subject: '丙', status: 'inProgress', owner: '', blockedBy: [] },
    ]);
  });

  it('结果形状认不出 ⇒ 台账一个字节都不动（宁可停在入参给的那一步）', () => {
    const registry = createClaudeTaskRegistry();
    registry.onCall({ callId: 'c1', name: 'TaskCreate', input: { subject: '甲' }, envelope: ENVELOPE });
    expect(registry.onResult('c1', { unexpected: true })).toBe(false);
    expect(stepsOf(registry.payload())).toEqual<TaskStep[]>([
      { id: null, subject: '甲', status: 'pending', owner: '', blockedBy: [] },
    ]);
  });

  it('非本族的工具名不入账（`onCall` 给 `null` ⇒ 调用方照旧按族载荷归一算）', () => {
    const registry = createClaudeTaskRegistry();
    expect(registry.onCall({ callId: 'c1', name: 'Bash', input: { command: 'ls' }, envelope: ENVELOPE })).toBeNull();
    expect(registry.callFor('c1')).toBeNull();
    expect(stepsOf(registry.payload())).toEqual([]);
  });
});

/** 台账单元用例用的信封（重投时要用它的四格拼合并键） */
const ENVELOPE = { roundTrip: 1, parentCallId: null, subagentId: null, vendorId: 'msg_x' };
