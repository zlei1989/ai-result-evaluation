// @vitest-environment node
/**
 * run 级聚合订阅：一次 publish 把同一帧投给**两层**订阅者——候选级（既有通道，签名与语义不变）
 * 与 run 级（新增，`listener` 多一个 `candidateId` 实参）。两条总线是两份并排的实现
 * （`events.ts` 的 `fanOutEvent` 与 `candidate-messages.ts` 的 `fanOut`），两边必须同形，
 * 漏改一处就是「某一条流悄悄不聚合」，故两组用例逐条对应。
 *
 * 四条最容易被写错的地方各有一条**能失败**的守卫：
 *   1. **键空间**：`runId:judge` 在两个键空间里同时有意义（run 级的评分通道 / 候选级里 id 叫
 *      `judge` 那边的候选通道）⇒ 两套键必须分表，靠 id 形状（UUID）回避冲突不算守住；
 *   2. **不串 run**：run 级键按 runId 分，A 轮的订阅者不许收到 B 轮的任何帧；
 *   3. **两族不互串**：候选流与评分流各自一条 run 级通道，`subscribeRunEvents` 收不到评分帧；
 *   4. **坏订阅者不打断**：候选级抛错不能带走 run 级投递，反之亦然（落盘同样不受影响）。
 * 另外钉住「双层都投」本身与投递顺序（先候选级、后 run 级）——只投一层就是本票要拦的缺陷形态。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AgentMessage, CandidateRecord } from '@aieval/contracts';
import { readEvents, candidateEventsFile, readRecords, candidateMessagesFile } from '@aieval/core';
import {
  publishJudgeEvent,
  publishCandidateEvent,
  subscribeCandidateEvents,
  subscribeRunEvents,
  subscribeRunJudgeEvents,
} from './events';
import {
  broadcastJudgeMessage,
  broadcastCandidateMessage,
  publishJudgeMessage,
  publishCandidateMessage,
  subscribeCandidateRecords,
  subscribeRunJudgeRecords,
  subscribeRunRecords,
} from './candidate-messages';
import { saveRun } from './run-store';
import { createTempHome, makeCandidateFixture, makeRunFixture, type TempHome } from './testing/fixtures';

let home: TempHome;

beforeEach(() => {
  home = createTempHome();
});

afterEach(() => {
  home.cleanup();
  vi.restoreAllMocks();
});

/** 落盘一轮带两个候选的评测（run 级订阅要「所有行」，两个候选是能看出「聚合」的最小候选数） */
function seedTwoCandidates(): { runId: string; candidateA: string; candidateB: string } {
  const candidateA = makeCandidateFixture();
  const candidateB = makeCandidateFixture();
  const run = makeRunFixture({ workspaceRoot: home.workspaceRoot, candidates: [candidateA, candidateB] });
  saveRun(run);
  return { runId: run.id, candidateA: candidateA.id, candidateB: candidateB.id };
}

/**
 * 键空间守卫的夹具：轮里有一候选的 id **恰好叫 `judge`**。
 * 于是 `runId:judge` 这个串在两个键空间里同时有意义——既是「这一轮的评分通道」（run 级键），
 * 又是「这一轮里 id 叫 `judge` 那边的候选通道」（候选级键）。生产里 id 是 UUID、撞不上，
 * 但守卫拦的正是「靠 id 形状回避冲突」：两套键共用一张表，这里就会互相误投。
 */
function seedJudgeNamedCandidate(): { runId: string; judgeCandidate: string; otherCandidate: string } {
  const judgeCandidate = makeCandidateFixture({ id: 'judge' });
  const otherCandidate = makeCandidateFixture();
  const run = makeRunFixture({ workspaceRoot: home.workspaceRoot, candidates: [judgeCandidate, otherCandidate] });
  saveRun(run);
  return { runId: run.id, judgeCandidate: judgeCandidate.id, otherCandidate: otherCandidate.id };
}

/** 一条事件的可读标签（断言里只看自己关心的格） */
function textOf(event: AgentEvent): string | null {
  return event.type === 'log' ? event.text : null;
}

/** 一条记录的可读标签（同上；子任务行看 `name`） */
function recordTextOf(record: CandidateRecord): string | null {
  if (record.type === 'subagent') return record.subagent.name;
  const block = record.message.blocks[0];
  return block !== undefined && block.type === 'text' ? block.text : null;
}

/** 一条最小合法消息（用例只覆盖自己关心的格） */
function makeMessage(overrides: Partial<AgentMessage> = {}): AgentMessage {
  return {
    messageId: 'run-1:1',
    vendorId: null,
    role: 'assistant',
    source: 'wire',
    origin: 'case-prompt',
    roundTrip: 1,
    turn: null,
    step: null,
    parentCallId: null,
    subagentId: null,
    chunk: 'snapshot',
    assembly: 'snapshot',
    mergeKey: 'main|1|assistant|-',
    blocks: [{ type: 'text', text: '答复' }],
    raw: null,
    ...overrides,
  };
}

describe('事件总线：run 级聚合订阅', () => {
  it('run 级订阅者收到该 run 下所有候选的帧，candidateId 实参指向来源行', () => {
    const { runId, candidateA, candidateB } = seedTwoCandidates();
    const seen: Array<{ candidateId: string; text: string | null }> = [];
    subscribeRunEvents(runId, (candidateId, event) => {
      seen.push({ candidateId, text: textOf(event) });
    });

    publishCandidateEvent(runId, candidateA, { type: 'log', stream: 'stdout', text: 'A 的一条' });
    publishCandidateEvent(runId, candidateB, { type: 'log', stream: 'stdout', text: 'B 的一条' });

    // 只有一条流、没有全局顺序：candidateId 是订阅者把帧归到候选上的**唯一**依据，必须逐条正确
    expect(seen).toEqual([
      { candidateId: candidateA, text: 'A 的一条' },
      { candidateId: candidateB, text: 'B 的一条' },
    ]);
  });

  it('双层投递：候选级订阅者先收到、run 级订阅者后收到，两层拿到的是同一帧', () => {
    const { runId, candidateA } = seedTwoCandidates();
    const order: string[] = [];
    const candidateSeen: AgentEvent[] = [];
    const runSeen: AgentEvent[] = [];
    subscribeCandidateEvents(runId, candidateA, (event) => {
      order.push('候选级');
      candidateSeen.push(event);
    });
    subscribeRunEvents(runId, (_candidateId, event) => {
      order.push('run 级');
      runSeen.push(event);
    });

    publishCandidateEvent(runId, candidateA, { type: 'log', stream: 'stdout', text: '同一帧' });

    // 顺序是契约的一半：既有通道先拿到帧，聚合通道不得把它挤到后面
    expect(order).toEqual(['候选级', 'run 级']);
    // 同一帧：run 级那条不是复制出来的第二份 ⇒ 既有候选级通道收到的对象逐字未变
    expect(runSeen[0]).toBe(candidateSeen[0]);
    expect(candidateSeen.map(textOf)).toEqual(['同一帧']);
  });

  it('取消订阅后 run 级订阅者不再收到；重复取消不抛', () => {
    const { runId, candidateA } = seedTwoCandidates();
    const seen: AgentEvent[] = [];
    const unsubscribe = subscribeRunEvents(runId, (_candidateId, event) => seen.push(event));
    publishCandidateEvent(runId, candidateA, { type: 'log', stream: 'stdout', text: '第一条' });
    unsubscribe();
    unsubscribe();
    publishCandidateEvent(runId, candidateA, { type: 'log', stream: 'stdout', text: '第二条' });

    expect(seen.map(textOf)).toEqual(['第一条']);
  });

  it('不串 run：run A 的 run 级订阅者收不到 run B 的任何帧', () => {
    const a = seedTwoCandidates();
    const b = seedTwoCandidates();
    const seenA: AgentEvent[] = [];
    subscribeRunEvents(a.runId, (_candidateId, event) => seenA.push(event));
    const seenB: AgentEvent[] = [];
    subscribeRunEvents(b.runId, (_candidateId, event) => seenB.push(event));

    publishCandidateEvent(b.runId, b.candidateA, { type: 'log', stream: 'stdout', text: 'B 的一条' });

    // 非空判据：B 自己的订阅者收到了它该收的那一条（否则「谁都没投」也能让下一条通过）
    expect(seenB.map(textOf)).toEqual(['B 的一条']);
    expect(seenA).toHaveLength(0);
  });

  it('不串键空间①：往 run 级键投递时，候选级订阅者一条都收不到', () => {
    const { runId, judgeCandidate, otherCandidate } = seedJudgeNamedCandidate();
    // 候选级候选键 `runId:judge`（id 叫 judge 的那一行）
    const candidateSeen: AgentEvent[] = [];
    subscribeCandidateEvents(runId, judgeCandidate, (event) => candidateSeen.push(event));
    // run 级评分键 `runId:judge`（这一轮的评分通道）——与上面逐字相同
    const runSeen: AgentEvent[] = [];
    subscribeRunJudgeEvents(runId, (_candidateId, event) => runSeen.push(event));

    publishJudgeEvent(runId, otherCandidate, { type: 'log', stream: 'stdout', text: '评审者的流水' });

    expect(runSeen.map(textOf)).toEqual(['评审者的流水']);
    expect(candidateSeen).toHaveLength(0);
  });

  it('不串键空间②：往候选级键投递时，run 级订阅者一条都收不到', () => {
    const { runId, judgeCandidate } = seedJudgeNamedCandidate();
    const runSeen: AgentEvent[] = [];
    subscribeRunJudgeEvents(runId, (_candidateId, event) => runSeen.push(event));
    const candidateSeen: AgentEvent[] = [];
    subscribeCandidateEvents(runId, judgeCandidate, (event) => candidateSeen.push(event));

    publishCandidateEvent(runId, judgeCandidate, { type: 'log', stream: 'stdout', text: '候选的日志' });

    expect(candidateSeen.map(textOf)).toEqual(['候选的日志']);
    expect(runSeen).toHaveLength(0);
  });

  it('run 级两族不互串：候选订阅只收候选流，评分订阅只收评分流', () => {
    const { runId, candidateA } = seedTwoCandidates();
    const candidate: AgentEvent[] = [];
    const judge: AgentEvent[] = [];
    subscribeRunEvents(runId, (_candidateId, event) => candidate.push(event));
    subscribeRunJudgeEvents(runId, (_candidateId, event) => judge.push(event));

    publishCandidateEvent(runId, candidateA, { type: 'log', stream: 'stdout', text: '候选' });
    publishJudgeEvent(runId, candidateA, { type: 'log', stream: 'stdout', text: '评分' });

    expect(candidate.map(textOf)).toEqual(['候选']);
    expect(judge.map(textOf)).toEqual(['评分']);
  });

  it('订阅者抛错不影响落盘、也不影响另一层与同一层的其它订阅者', () => {
    const { runId, candidateA } = seedTwoCandidates();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const candidateSeen: AgentEvent[] = [];
    subscribeCandidateEvents(runId, candidateA, (event) => candidateSeen.push(event));
    subscribeCandidateEvents(runId, candidateA, () => {
      throw new Error('坏候选级订阅者');
    });
    subscribeRunEvents(runId, () => {
      throw new Error('坏 run 级订阅者');
    });
    const goodRunSeen: AgentEvent[] = [];
    subscribeRunEvents(runId, (_candidateId, event) => goodRunSeen.push(event));

    expect(() => publishCandidateEvent(runId, candidateA, { type: 'log', stream: 'stdout', text: 'x' })).not.toThrow();

    // 候选级抛错不能带走 run 级投递，run 级抛错不能带走同一层的后一个订阅者
    expect(candidateSeen).toHaveLength(1);
    expect(goodRunSeen).toHaveLength(1);
    expect(readEvents(candidateEventsFile(home.workspaceRoot, runId, candidateA))).toHaveLength(1);
    expect(errorSpy).toHaveBeenCalled();
  });
});

describe('记录总线：run 级聚合订阅', () => {
  it('run 级订阅者收到该 run 下所有候选的记录，candidateId 实参指向来源行', () => {
    const { runId, candidateA, candidateB } = seedTwoCandidates();
    const seen: Array<{ candidateId: string; text: string | null }> = [];
    subscribeRunRecords(runId, (candidateId, record) => {
      seen.push({ candidateId, text: recordTextOf(record) });
    });

    publishCandidateMessage(runId, candidateA, makeMessage({ messageId: 'a:1', blocks: [{ type: 'text', text: 'A 的一条' }] }));
    publishCandidateMessage(runId, candidateB, makeMessage({ messageId: 'b:1', blocks: [{ type: 'text', text: 'B 的一条' }] }));

    expect(seen).toEqual([
      { candidateId: candidateA, text: 'A 的一条' },
      { candidateId: candidateB, text: 'B 的一条' },
    ]);
  });

  it('双层投递：候选级订阅者先收到、run 级订阅者后收到，两层拿到的是同一条记录', () => {
    const { runId, candidateA } = seedTwoCandidates();
    const order: string[] = [];
    const candidateSeen: CandidateRecord[] = [];
    const runSeen: CandidateRecord[] = [];
    subscribeCandidateRecords(runId, candidateA, (record) => {
      order.push('候选级');
      candidateSeen.push(record);
    });
    subscribeRunRecords(runId, (_candidateId, record) => {
      order.push('run 级');
      runSeen.push(record);
    });

    publishCandidateMessage(runId, candidateA, makeMessage({ blocks: [{ type: 'text', text: '同一条' }] }));

    expect(order).toEqual(['候选级', 'run 级']);
    expect(runSeen[0]).toBe(candidateSeen[0]);
    expect(candidateSeen.map(recordTextOf)).toEqual(['同一条']);
  });

  it('delta 广播（只扇出、不落盘）同样双层投递，两个 channel 都是', () => {
    const { runId, candidateA } = seedTwoCandidates();
    const candidate: CandidateRecord[] = [];
    const judge: CandidateRecord[] = [];
    subscribeRunRecords(runId, (_candidateId, record) => candidate.push(record));
    subscribeRunJudgeRecords(runId, (_candidateId, record) => judge.push(record));

    broadcastCandidateMessage(runId, candidateA, makeMessage({ chunk: 'delta', assembly: 'open', blocks: [{ type: 'text', text: '逐字增量' }] }));
    broadcastJudgeMessage(runId, candidateA, makeMessage({ chunk: 'delta', assembly: 'open', blocks: [{ type: 'text', text: '评审者的增量' }] }));

    // 打字机效果走的正是这一路：聚合通道漏掉广播，卡片上的正文就只在块结束时跳一下
    expect(candidate.map(recordTextOf)).toEqual(['逐字增量']);
    expect(judge.map(recordTextOf)).toEqual(['评审者的增量']);
  });

  it('取消订阅后 run 级订阅者不再收到；重复取消不抛', () => {
    const { runId, candidateA } = seedTwoCandidates();
    const seen: CandidateRecord[] = [];
    const unsubscribe = subscribeRunRecords(runId, (_candidateId, record) => seen.push(record));
    publishCandidateMessage(runId, candidateA, makeMessage({ messageId: 'a:1' }));
    unsubscribe();
    unsubscribe();
    publishCandidateMessage(runId, candidateA, makeMessage({ messageId: 'a:2' }));

    expect(seen.map(recordTextOf)).toEqual(['答复']);
  });

  it('不串 run：run A 的 run 级订阅者收不到 run B 的任何记录', () => {
    const a = seedTwoCandidates();
    const b = seedTwoCandidates();
    const seenA: CandidateRecord[] = [];
    subscribeRunRecords(a.runId, (_candidateId, record) => seenA.push(record));
    const seenB: CandidateRecord[] = [];
    subscribeRunRecords(b.runId, (_candidateId, record) => seenB.push(record));

    publishCandidateMessage(b.runId, b.candidateA, makeMessage({ blocks: [{ type: 'text', text: 'B 的一条' }] }));

    expect(seenB.map(recordTextOf)).toEqual(['B 的一条']);
    expect(seenA).toHaveLength(0);
  });

  it('不串键空间①：往 run 级键投递时，候选级订阅者一条都收不到', () => {
    const { runId, judgeCandidate, otherCandidate } = seedJudgeNamedCandidate();
    // 候选级候选键 `runId:judge`（id 叫 judge 的那一行）
    const candidateSeen: CandidateRecord[] = [];
    subscribeCandidateRecords(runId, judgeCandidate, (record) => candidateSeen.push(record));
    // run 级评分键 `runId:judge`（这一轮的评分通道）——与上面逐字相同
    const runSeen: CandidateRecord[] = [];
    subscribeRunJudgeRecords(runId, (_candidateId, record) => runSeen.push(record));

    publishJudgeMessage(runId, otherCandidate, makeMessage({ blocks: [{ type: 'text', text: '评审者的一条' }] }));

    expect(runSeen.map(recordTextOf)).toEqual(['评审者的一条']);
    expect(candidateSeen).toHaveLength(0);
  });

  it('不串键空间②：往候选级键投递时，run 级订阅者一条都收不到', () => {
    const { runId, judgeCandidate } = seedJudgeNamedCandidate();
    const runSeen: CandidateRecord[] = [];
    subscribeRunJudgeRecords(runId, (_candidateId, record) => runSeen.push(record));
    const candidateSeen: CandidateRecord[] = [];
    subscribeCandidateRecords(runId, judgeCandidate, (record) => candidateSeen.push(record));

    publishCandidateMessage(runId, judgeCandidate, makeMessage({ blocks: [{ type: 'text', text: '候选的一条' }] }));

    expect(candidateSeen.map(recordTextOf)).toEqual(['候选的一条']);
    expect(runSeen).toHaveLength(0);
  });

  it('run 级两族不互串：候选订阅只收候选流，评分订阅只收评分流', () => {
    const { runId, candidateA } = seedTwoCandidates();
    const candidate: CandidateRecord[] = [];
    const judge: CandidateRecord[] = [];
    subscribeRunRecords(runId, (_candidateId, record) => candidate.push(record));
    subscribeRunJudgeRecords(runId, (_candidateId, record) => judge.push(record));

    publishCandidateMessage(runId, candidateA, makeMessage({ blocks: [{ type: 'text', text: '候选' }] }));
    publishJudgeMessage(runId, candidateA, makeMessage({ blocks: [{ type: 'text', text: '评分' }] }));

    expect(candidate.map(recordTextOf)).toEqual(['候选']);
    expect(judge.map(recordTextOf)).toEqual(['评分']);
  });

  it('订阅者抛错不影响落盘、也不影响另一层与同一层的其它订阅者', () => {
    const { runId, candidateA } = seedTwoCandidates();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const candidateSeen: CandidateRecord[] = [];
    subscribeCandidateRecords(runId, candidateA, (record) => candidateSeen.push(record));
    subscribeCandidateRecords(runId, candidateA, () => {
      throw new Error('坏候选级订阅者');
    });
    subscribeRunRecords(runId, () => {
      throw new Error('坏 run 级订阅者');
    });
    const goodRunSeen: CandidateRecord[] = [];
    subscribeRunRecords(runId, (_candidateId, record) => goodRunSeen.push(record));

    expect(() => publishCandidateMessage(runId, candidateA, makeMessage())).not.toThrow();

    expect(candidateSeen).toHaveLength(1);
    expect(goodRunSeen).toHaveLength(1);
    expect(readRecords(candidateMessagesFile(home.workspaceRoot, runId, candidateA))).toHaveLength(1);
    expect(errorSpy).toHaveBeenCalled();
  });
});

/**
 * 总线对象挂在 `globalThis` 上，于是它可能**先于 run 级表**存在：dev 的 HMR 重建模块时，
 * 旧实例建出来的对象留在 `globalThis` 上、没有 `runSubscribers` 这一格，新实例直接读会拿到
 * `undefined`（订阅时 `Map.get` 抛 TypeError，整条实时通道崩在接线那一刻）。
 * 两条总线各一条：这里删掉那一格再造一次「新实例」，订阅与发布都必须照常工作。
 */
describe('总线挂 globalThis：run 级表按需补齐', () => {
  /** 从 `globalThis` 上取总线对象并删掉 run 级表（HMR 的另一种形状） */
  function dropRunSubscribersTable(key: string): void {
    const holder = globalThis as unknown as Record<string, { runSubscribers?: unknown } | undefined>;
    const bus = holder[key];
    expect(bus).toBeDefined();
    delete bus?.runSubscribers;
  }

  it('事件总线：对象上没有 run 级表时，新实例补齐它并正常投递', async () => {
    const { runId, candidateA } = seedTwoCandidates();
    dropRunSubscribersTable('__aievalCandidateEventBus');

    vi.resetModules();
    // `resetModules` 会重建 core 的「配置目录」记忆 ⇒ 在**新实例**上指回临时目录（同 events.test.ts）
    const freshCore = await import('@aieval/core');
    freshCore.setConfigDirForTesting(home.configDir);
    const reloaded = await import('./events');
    const seen: AgentEvent[] = [];
    reloaded.subscribeRunEvents(runId, (_candidateId: string, event: AgentEvent) => seen.push(event));
    reloaded.publishCandidateEvent(runId, candidateA, { type: 'log', stream: 'stdout', text: '补齐之后的一条' });

    expect(seen.map(textOf)).toEqual(['补齐之后的一条']);
  });

  it('记录总线：对象上没有 run 级表时，新实例补齐它并正常投递', async () => {
    const { runId, candidateA } = seedTwoCandidates();
    dropRunSubscribersTable('__aievalCandidateMessageBus');

    vi.resetModules();
    const freshCore = await import('@aieval/core');
    freshCore.setConfigDirForTesting(home.configDir);
    const reloaded = await import('./candidate-messages');
    const seen: CandidateRecord[] = [];
    reloaded.subscribeRunRecords(runId, (_candidateId: string, record: CandidateRecord) => seen.push(record));
    reloaded.publishCandidateMessage(runId, candidateA, makeMessage({ blocks: [{ type: 'text', text: '补齐之后的一条' }] }));

    expect(seen.map(recordTextOf)).toEqual(['补齐之后的一条']);
  });
});
