// @vitest-environment node
/**
 * 应答面的编排接线：**开启闸门 → 实现回调 → 登记挂起 → 答案落盘**。
 *
 * 为什么这几条判据都住在本文件（编排用例很贵：每个文件都要自己写三条 `vi.mock`）：
 * 它们各自钉一件事，且都只能在「跑完一行」之后才看得见：
 *   ① **落盘那一件事**（本票的主判据）：答复落进候选消息账本的 `tool-result` 那一半（逐字），
 *      收场方式与等待时长落进行级事件；
 *   ② **没人答**：到点按「超时」收场并**从挂起表里出表**（不是留在快照里当一条再也答不了的提问），
 *      且行的结论不受影响（「没人答」与「行失败」是两件事）；
 *   ③ **闸门**（零回归判据）：这一轮没开应答面时回调**根本不在入参上**，一次都不被调用，
 *      账本与事件里也没有任何与提问有关的记录；
 *   ④ 子智能体发起的提问落「被拒绝」，同样不进表。
 *
 * 假适配器那一端（`fakeAgents` 的 `askUser` 旋钮）**只负责问**：答复必须由本文件真的走一遍
 * 应答入口（`resolveAskUser`）或等预算到点——夹具替被测代码编一份答复，就等于把
 * 「有人答了」这条判据变成自述。
 *
 * 卡片那一侧的回填（`buildAgentLogModel` 把这两半拼成 `settled`）不在本文件：按分层表
 * evaluator 不许 import `@aieval/ui`，那条判据住在 `packages/client/ui` 的数据层用例里——
 * 两处合起来才是「答案落盘 → 卡片收场」这条完整链路。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AskUserAnswer, AskUserQuestion } from '@aieval/contracts';
import type { AskUserRequest } from '@aieval/agents';
import { readEvents, rowEventsFile } from '@aieval/core';
import { listPendingAskUser, listPendingAskUserEntries, resetAskUserForTesting, resolveAskUser } from './ask-user';
import {
  drainRunningTasks,
  fakeAgents,
  getRun,
  home,
  registerOrchestratorHooks,
  rowRecordsOf,
  rowSettled,
  seedRunnableRun,
  startRun,
  TEST_TIMEOUT_MS,
  until,
} from './testing/orchestrator-harness';

vi.mock('@aieval/agents', async () => (await import('./testing/orchestrator-seams')).agentsMock());
vi.mock('./judge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./judge')>();
  return (await import('./testing/orchestrator-seams')).judgeMock(actual);
});
vi.mock('./run-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./run-store')>();
  return (await import('./testing/orchestrator-seams')).runStoreMock(actual);
});

registerOrchestratorHooks();

const QUESTION: AskUserQuestion = {
  header: '选路径',
  prompt: '这次改哪条路径？',
  options: [
    { label: '原地改', description: '改动小', recommended: true },
    { label: '新开模块', description: null, recommended: false },
  ],
  multiSelect: false,
  allowOther: true,
  secret: false,
};

const ANSWER: AskUserAnswer = { header: '选路径', selected: ['原地改'], custom: null };

/** 假适配器要问的那一问：`callId` 是账本里两半的配对键，故必须与结果块上的一致 */
function askRequest(overrides: Partial<AskUserRequest> = {}): AskUserRequest {
  return {
    questions: [QUESTION],
    toolName: 'ask_user_question',
    callId: 'call_ask_1',
    vendorBudgetMs: null,
    subagentId: null,
    ...overrides,
  };
}

/** 这一行的行级事件（每次都从盘上现读：用例断言的是**落盘事实**，不是内存里的账） */
function rowEventsOf(runId: string, rowId: string) {
  return readEvents(rowEventsFile(home.workspaceRoot, runId, rowId));
}

/** 这一行的提问收场事件（0 条或 1 条；多过一条就是重复落盘） */
function askEventsOf(runId: string, rowId: string) {
  return rowEventsOf(runId, rowId).filter((event) => event.type === 'ask-user');
}

/**
 * 挂起表挂 `globalThis`（跨用例、跨文件活着），故每条用例开工前清一次。
 *
 * 清理前先**把还挂着的等待方收场**：上一条用例若中途失败（断言红、超时），它那一问的回调
 * 会永远悬着，而悬着的回调让那条行任务永不结束——下一条用例的 `drainRunningTasks()` 于是
 * 等在一个与自己无关的运行上（本文件实测踩过：四条用例一起红成超时，而单跑每一条都是绿的）。
 */
beforeEach(() => {
  for (const entry of listPendingAskUserEntries()) entry.resolve('canceled', null);
  resetAskUserForTesting();
});

describe('应答面：编排层接线与落盘', { timeout: TEST_TIMEOUT_MS }, () => {
  it('开启应答面：答复逐字落进 `tool-result` 那一半，收场方式与耗时落进行级事件', async () => {
    const { run } = seedRunnableRun({ rowCount: 1, executionMode: 'serial', agentKind: 'pi', askUser: true });
    const rowId = getRun(run.id).rows[0]!.id;
    const request = askRequest();
    fakeAgents.scripts.set('pi', {
      messages: [{ text: '先问一句再动手。' }],
      askUser: { request },
    });

    startRun(run.id);
    // 等到这一问真的登记进挂起表（界面在这一刻才会看到待答卡片），再从应答入口回答它
    await until(() => listPendingAskUser().length === 1, '这一问已登记进挂起表');
    const askId = listPendingAskUser()[0]?.askId ?? '';
    expect(askId).not.toBe('');
    resolveAskUser(askId, [ANSWER]);
    await drainRunningTasks();

    // ① 回调真的挂上了、也被调用了，且答复原样回到了适配器手里（模型据此继续干活）
    const call = fakeAgents.calls[0];
    expect(call?.askUserAttached).toBe(true);
    expect(call?.askUserCalls).toBe(1);
    expect(call?.askUserReplies).toEqual([{ outcome: 'answered', answers: [ANSWER] }]);

    // ② 账本 `tool-result` 那一半：`callId` 配对、答案是逐字的那一份
    const resultBlock = rowRecordsOf(run.id, rowId)
      .messages.flatMap((message) => message.blocks)
      .find((block) => block.type === 'tool-result' && block.callId === request.callId);
    expect(resultBlock?.type === 'tool-result' ? resultBlock.structured : null).toEqual({
      outcome: 'answered',
      answers: [ANSWER],
    });
    // 「没人答」不是错误结果：`isError` 只表示「这次工具调用失败了」
    expect(resultBlock?.type === 'tool-result' ? resultBlock.isError : true).toBe(false);

    // ③ 行级观测事件：收场方式 + 等待时长 + 提问来源通道（这一家声明的是宿主工具）
    const askEvents = askEventsOf(run.id, rowId);
    expect(askEvents).toHaveLength(1);
    expect(askEvents[0]).toMatchObject({
      askId,
      callId: request.callId,
      toolName: 'ask_user_question',
      channel: 'host-tool',
      outcome: 'answered',
      // 等待时长是**实打实的毫秒数**（不是 0、不是缺格）：它是「人介入的代价」唯一出处
      waitedMs: expect.any(Number),
    });

    // ④ 收场之后挂起表里不留痕（快照是唯一读侧，留一条就是留一个再也答不了的弹层）
    expect(listPendingAskUser()).toEqual([]);
  });

  it('没人答：到点按「超时」收场、从挂起表出表，行的结论不受影响', async () => {
    const { run } = seedRunnableRun({ rowCount: 1, executionMode: 'serial', agentKind: 'pi', askUser: true });
    const rowId = getRun(run.id).rows[0]!.id;
    // 厂商给的预算只有 1.2 s：编排层因此比端口自己那条兜底（同一预算）早一步到点
    const request = askRequest({ vendorBudgetMs: 1_200 });
    fakeAgents.scripts.set('pi', { askUser: { request } });

    startRun(run.id);
    await until(() => listPendingAskUser().length === 1, '这一问已登记进挂起表');
    await drainRunningTasks();

    // 模型拿到的是「超时」——不是「无人应答」（那说的是这一轮根本没有应答面），也不是失败
    expect(fakeAgents.calls[0]?.askUserReplies).toEqual([{ outcome: 'timeout', answers: null }]);
    // 挂起表里出表了（留在里面就是一条再也答不了的提问，快照会一直显示它）
    expect(listPendingAskUser()).toEqual([]);
    const askEvents = askEventsOf(run.id, rowId);
    expect(askEvents).toHaveLength(1);
    expect(askEvents[0]?.type === 'ask-user' ? askEvents[0].outcome : null).toBe('timeout');
    // 「没人答」与「行失败」是两件事：这一行照常跑完并拿到分
    expect(getRun(run.id).rows[0]?.status).toBe('judged');
  });

  it('闸门：这一轮没开应答面时不传回调，一次都不被调用，产物里没有提问的痕迹', async () => {
    const { run } = seedRunnableRun({ rowCount: 1, executionMode: 'serial', agentKind: 'pi' });
    const rowId = getRun(run.id).rows[0]!.id;
    fakeAgents.scripts.set('pi', {
      messages: [{ text: '先问一句再动手。' }],
      // 厂商那一侧照常问（脚本里有这一格）——闸门关着，没有人接
      askUser: { request: askRequest() },
    });

    startRun(run.id);
    /**
     * 闸门关着 ⇒ 这一行**不等人**：等它落定即可。
     * 上限刻意短、且接上「已经有人被问了」这条不可能判据：闸门一旦失效，这一行会挂在等人上
     * 直到预算烧完（十分钟），而那时红出来的是一句「测试超时」——离真因很远。
     */
    await until(
      () => rowSettled(run.id, rowId),
      '这一行落定（闸门关着 ⇒ 不该有人在等用户回答）',
      5_000,
      () => (fakeAgents.calls[0]?.askUserCalls ?? 0) > 0,
    );
    await drainRunningTasks();

    // 入参上**根本没有这一格**（适配器据此连厂商钩子都不挂）+ 被调用 0 次（问过 1 次）
    const call = fakeAgents.calls[0];
    expect(call?.askUserAttached).toBe(false);
    expect(call?.askUserAttempts).toBe(1);
    expect(call?.askUserCalls).toBe(0);
    expect(call?.askUserReplies).toEqual([]);

    // 产物与今天逐字相同：账本里只有适配器自己投的那一条消息，事件里没有一条提问事件
    const { messages } = rowRecordsOf(run.id, rowId);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.blocks).toEqual([{ type: 'text', text: '先问一句再动手。' }]);
    expect(askEventsOf(run.id, rowId)).toEqual([]);
    expect(listPendingAskUser()).toEqual([]);
  });

  it('子智能体发起的提问：落「被拒绝」，不进挂起表（子智能体不能向用户提问）', async () => {
    const { run } = seedRunnableRun({ rowCount: 1, executionMode: 'serial', agentKind: 'pi', askUser: true });
    const rowId = getRun(run.id).rows[0]!.id;
    const request = askRequest({ callId: 'call_ask_sub', subagentId: 'sub-1' });
    fakeAgents.scripts.set('pi', { askUser: { request } });

    startRun(run.id);
    await drainRunningTasks();

    expect(fakeAgents.calls[0]?.askUserReplies).toEqual([{ outcome: 'rejected', answers: null }]);
    expect(listPendingAskUser()).toEqual([]);
    const askEvents = askEventsOf(run.id, rowId);
    expect(askEvents[0]?.type === 'ask-user' ? askEvents[0].outcome : null).toBe('rejected');
  });
});
