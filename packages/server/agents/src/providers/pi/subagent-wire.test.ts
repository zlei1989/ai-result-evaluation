// @vitest-environment node
/**
 * pi 子智能体 wire 通道的口径守卫（逐条对着 `subagent-wire.ts` 文件头那份口径写）。
 *
 * 判据一律取**可观测行为**：快照是否拿到、全局槽是否被删、订阅是否建立、排空出的消息
 * （来源 / 归属 / 轮次）。厂商侧只模拟两件事，且都与真实实现对齐：
 *   · **claim 语义**：槽为空才写（`index.ts:751` 的先到先得）；
 *   · **订阅时同步吐排下的事件**（与主会话夹具同一时序，见 `pi-sdk-fixture.ts` 的 `subscribe`）。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createFakePiChildSession } from '../../testing/pi-sdk-fixture';
import {
  PI_SUBAGENTS_MANAGER_KEY,
  PI_SUBAGENT_WIRE_BUFFER_MAX,
  PI_SUBAGENT_WIRE_GIVE_UP_MS,
  PI_SUBAGENT_WIRE_MAX_FRUITLESS_TICKS,
  PI_SUBAGENT_WIRE_POLL_MS,
  PI_SUBAGENT_WIRE_TICK_MS,
  createPiSubagentWire,
  resetPiSubagentWireForTesting,
  setPiSubagentWireTimingsForTesting,
} from './subagent-wire';

afterEach(() => {
  resetPiSubagentWireForTesting();
  setPiSubagentWireTimingsForTesting(null);
});

describe('pi 子智能体 wire：产品默认值钉值', () => {
  it('节拍、放弃上限与缓冲上限（改这三个数就是改订阅密度、放弃窗口与缓冲防线，得是有意的）', () => {
    expect(PI_SUBAGENT_WIRE_POLL_MS).toBe(20);
    // 60 s：子会话创建含 jiti 全量编译，全量测试并行的 CPU 争抢下会超过 10 s（见常量注释）
    expect(PI_SUBAGENT_WIRE_GIVE_UP_MS).toBe(60_000);
    expect(PI_SUBAGENT_WIRE_BUFFER_MAX).toBe(5000);
  });
});

/** 真实语义的厂商 claim：槽为空才写，返回这次有没有写进去（先到先得的观测点） */
function vendorClaim(makeEntry: () => unknown): boolean {
  const slot = (globalThis as Record<symbol, unknown>)[PI_SUBAGENTS_MANAGER_KEY];
  if (slot !== undefined) return false;
  (globalThis as Record<symbol, unknown>)[PI_SUBAGENTS_MANAGER_KEY] = makeEntry();
  return true;
}

function slotValue(): unknown {
  return (globalThis as Record<symbol, unknown>)[PI_SUBAGENTS_MANAGER_KEY];
}

/** 真机形状的助手收尾事件（`message_end.message`，与 `events.test.ts` 的形状同源） */
function childAssistantEnd(text: string, usage = { input: 10, output: 2, cacheRead: 0, totalTokens: 12 }): unknown {
  return {
    type: 'message_end',
    message: { role: 'assistant', content: [{ type: 'text', text }], usage, stopReason: 'stop' },
  };
}

/** 真机形状的工具收尾事件 */
function childToolEnd(callId: string, text: string): unknown {
  return {
    type: 'tool_execution_end',
    toolCallId: callId,
    toolName: 'read',
    isError: false,
    durationMs: 3,
    result: { content: [{ type: 'text', text }] },
  };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 把轮询节拍拨到测试档（毫秒级放弃），用例结束由 afterEach 复原 */
function fastTimings(): void {
  setPiSubagentWireTimingsForTesting({ pollMs: 1, giveUpMs: 25 });
}

describe('pi 子智能体 wire：reload 的快照与删槽', () => {
  it('reload 落定后快照进行的、随即删槽（下一候选的 claim 因此能成立）', async () => {
    const wire = createPiSubagentWire();
    expect(wire.available).toBe(false);
    await wire.reload(async () => {
      expect(vendorClaim(() => ({ getRecord: () => undefined }))).toBe(true);
    });
    expect(wire.available).toBe(true);
    // 槽被删：紧接着的第二个厂商 claim 能写进去
    expect(slotValue()).toBeUndefined();
    expect(vendorClaim(() => ({ getRecord: () => undefined }))).toBe(true);
  });

  it('reload 里没有 claim（扩展没装载那档）＝ 快照落空，删槽是空操作', async () => {
    const wire = createPiSubagentWire();
    await wire.reload(async () => undefined);
    expect(wire.available).toBe(false);
    expect(slotValue()).toBeUndefined();
  });

  it('并发两行各自拿到自己的 manager：reload + 快照 + 删槽整段互斥串行', async () => {
    const first = createPiSubagentWire();
    const second = createPiSubagentWire();
    const claims: boolean[] = [];
    /**
     * 贴真机的竞态形状：**claim 在 reload 的前段**（扩展工厂在 pre-trust 装载那一步就执行），
     * reload 其余部分还有一段异步尾巴——「claim 到删槽」之间隔着整段 reload。没有互斥时
     * 后一候选的工厂会立刻跑、见槽非空、claim 失败（`[true, false]`）；互斥成立时后一候选的
     * reload 要等前一候选的快照 + 删槽全部落定才开始，两次都成功。
     */
    const run = (wire: ReturnType<typeof createPiSubagentWire>, tag: string): Promise<void> =>
      wire.reload(async () => {
        claims.push(vendorClaim(() => ({ tag, getRecord: () => undefined })));
        await sleep(5);
      });
    await Promise.all([run(first, 'A'), run(second, 'B')]);
    expect(claims).toEqual([true, true]);
    expect(first.available && second.available).toBe(true);
    expect(slotValue()).toBeUndefined();
  });

  it('reload 抛错也照删槽：失败的那一行不挡下一行 claim', async () => {
    const first = createPiSubagentWire();
    await first
      .reload(async () => {
        vendorClaim(() => ({ getRecord: () => undefined }));
        throw new Error('装配失败');
      })
      .catch(() => undefined);
    const second = createPiSubagentWire();
    await second.reload(async () => {
      expect(vendorClaim(() => ({ getRecord: () => undefined }))).toBe(true);
    });
    expect(second.available).toBe(true);
  });
});

describe('pi 子智能体 wire：订阅的建立与放弃', () => {
  /** 造一份带单个子会话记录的 registry 条目（`records` 可后置改，模拟「会话晚一点才出现」） */
  function entryWith(records: Record<string, unknown>): { getRecord: (id: string) => unknown } {
    return { getRecord: (id: string) => records[id] };
  }

  it('subagents:started 同步那一发就订上：会话已存在时不等轮询', async () => {
    const session = createFakePiChildSession();
    const wire = createPiSubagentWire();
    await wire.reload(async () => {
      vendorClaim(() => entryWith({ 'agent-1': { session } }));
    });
    wire.onStarted('agent-1');
    expect(session.listenerCount).toBe(1);
  });

  it('会话还没出现时按节拍重试，出现即订上', async () => {
    fastTimings();
    const records: Record<string, unknown> = {};
    const wire = createPiSubagentWire();
    await wire.reload(async () => {
      vendorClaim(() => entryWith(records));
    });
    wire.onStarted('agent-1');
    const session = createFakePiChildSession();
    records['agent-1'] = { session };
    await sleep(20);
    expect(session.listenerCount).toBe(1);
  });

  it('到放弃上限还没出现 ⇒ 静默放弃（转写文件兜底），且不再重试', async () => {
    fastTimings();
    const records: Record<string, unknown> = { 'agent-1': {} };
    const wire = createPiSubagentWire();
    await wire.reload(async () => {
      vendorClaim(() => entryWith(records));
    });
    wire.onStarted('agent-1');
    await sleep(40);
    // 会话在放弃之后才出现也不回头（giveUp 是单向闸，不会复活轮询）
    records['agent-1'] = { session: createFakePiChildSession() };
    await sleep(10);
    wire.onStarted('agent-1');
    await sleep(10);
    const drained = wire.drain(['agent-1']);
    expect(drained.messages).toHaveLength(0);
  });

  it('session.messages 不是数组 ⇒ 放弃订阅（轮次基数对不齐比拿不到更坏）', async () => {
    const wire = createPiSubagentWire();
    await wire.reload(async () => {
      vendorClaim(() => entryWith({ 'agent-1': { session: { subscribe: () => () => {}, messages: '不是数组' } } }));
    });
    wire.onStarted('agent-1');
    const drained = wire.drain(['agent-1']);
    expect(drained.messages).toHaveLength(0);
  });

  it('快照落空的行：onStarted 什么都不做（整行退回转写通道）', async () => {
    const wire = createPiSubagentWire();
    await wire.reload(async () => undefined);
    wire.onStarted('agent-1');
    expect(wire.drain(['agent-1']).messages).toHaveLength(0);
  });

  it('订阅时同步吐出的排下事件一条不丢（先登记后订阅那一序）', async () => {
    const session = createFakePiChildSession([childAssistantEnd('订阅前就在的第一步')]);
    const wire = createPiSubagentWire();
    await wire.reload(async () => {
      vendorClaim(() => entryWith({ 'agent-1': { session } }));
    });
    wire.onStarted('agent-1');
    const drained = wire.drain(['agent-1']);
    expect(drained.messages.map((message) => message.blocks[0]?.block)).toMatchObject([
      { type: 'text', text: '订阅前就在的第一步' },
    ]);
  });

});

describe('pi 子智能体 wire：事件到消息的折算', () => {
  /** 走产品路径把一个已订阅的 wire 造出来（reload 里挂带会话的条目 + started 同步命中） */
  async function subscribedWire(
    messages: unknown[] = [],
  ): Promise<{ wire: ReturnType<typeof createPiSubagentWire>; session: ReturnType<typeof createFakePiChildSession> }> {
    const session = createFakePiChildSession([], messages);
    const wire = createPiSubagentWire();
    await wire.reload(async () => {
      vendorClaim(() => ({ getRecord: (id: string) => (id === 'agent-1' ? { session } : undefined) }));
    });
    wire.onStarted('agent-1');
    return { wire, session };
  }

  it('助手收尾与工具收尾折成 wire 消息：盖 subagentId、来源是 wire、raw 带排障身份', async () => {
    const { wire, session } = await subscribedWire();
    session.emit(childAssistantEnd('第一步'));
    session.emit(childToolEnd('call_x', '读到了'));
    session.emit(childAssistantEnd('第二步'));
    const drained = wire.drain(['agent-1']);
    expect(drained.messages.map((message) => [message.role, message.source, message.subagentId, message.roundTrip]))
      .toEqual([
        ['assistant', 'wire', 'agent-1', 1],
        ['tool', 'wire', 'agent-1', 1],
        ['assistant', 'wire', 'agent-1', 2],
      ]);
    expect(drained.messages[0]?.raw).toMatchObject({ type: 'pi-subagent-wire', agentId: 'agent-1' });
  });

  /**
   * **订阅前的缺口由 `session.messages` 补进来**（这一格此前只能等扩展把转写文件 flush 出来）。
   *
   * `subscribe()` 只收订阅之后的事件，而「总线报 started」到「我们真的拿到会话句柄」之间有一段
   * 窗口（句柄要轮询、快网关可能已经跑完一轮）：那一段的助手 / 工具结果事件**不会重放**。
   * 不补的后果有两层：子任务正文整批来自旁路文件（`source: 'session-file'`、带「补录」角标、
   * 实时性与 wire 不可比）；而窗口宽度随机器负载变化 ⇒ 真机守卫会在满载时偶发假红。
   * 判据取三格：来源仍是 wire、轮次取**绝对序**（与转写路径的助手行序对齐 ⇒ 载体键相同、去重收敛）、
   * 订阅之后的新事件接在补账之后继续数。
   */
  it('订阅前已完成的消息由 session.messages 补账：来源 wire、轮次绝对序、后续事件接着数', async () => {
    const history = [
      { role: 'user', content: '题目' },
      { role: 'assistant', content: [{ type: 'text', text: '第一步' }] },
      { role: 'toolResult', toolCallId: 'call_x', toolName: 'read', content: [{ type: 'text', text: '读到了' }] },
      { role: 'assistant', content: [{ type: 'text', text: '第二步' }] },
    ];
    const { wire, session } = await subscribedWire(history);
    // 订阅之后又来了一条：它必须接在补账的绝对序之后（第三条助手 = 第 3 轮）
    session.emit(childAssistantEnd('第三步'));
    const drained = wire.drain(['agent-1']);
    expect(drained.messages.map((message) => [message.role, message.source, message.roundTrip])).toEqual([
      ['assistant', 'wire', 1],
      ['tool', 'wire', 1],
      ['assistant', 'wire', 2],
      ['assistant', 'wire', 3],
    ]);
    expect(drained.messages[0]?.blocks[0]?.block).toMatchObject({ type: 'text', text: '第一步' });
    expect(drained.messages[1]?.blocks[0]?.block).toMatchObject({ type: 'tool-result', callId: 'call_x' });
  });

  it('轮次基数取 session.messages 的助手数：跳过前两轮订阅，新收尾从 3 数起', async () => {
    const { wire, session } = await subscribedWire([
      { role: 'assistant', content: [] },
      { role: 'assistant', content: [] },
    ]);
    session.emit(childAssistantEnd('第三轮的答复'));
    const drained = wire.drain(['agent-1']);
    expect(drained.messages.map((message) => message.roundTrip)).toEqual([3]);
  });

  it('非助手收尾不入缓冲；空内容的助手行照样占一轮；增量按「下一轮」归属', async () => {
    const { wire, session } = await subscribedWire();
    session.emit({ type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: '任务' }] } });
    // 第 1 轮还没收尾时的增量：归属**下一轮**（1），不是「当前轮」（0 ⇒ 会挂到上一条已收尾的消息上）
    session.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: '流式' } });
    session.emit(childAssistantEnd(''));
    session.emit(childToolEnd('call_y', '工具结果'));
    session.emit(childAssistantEnd('第二步'));
    const drained = wire.drain(['agent-1']);
    /**
     * 逐字增量先出（`chunk: 'delta'`、轮次 1，与随后那条空助手行同一个载体），
     * 空内容助手行本身不产消息但**占轮**（工具结果沿用它的第 1 轮，下一条助手从 2 起）。
     */
    expect(drained.messages.map((message) => [message.role, message.chunk, message.roundTrip])).toEqual([
      ['assistant', 'delta', 1],
      ['tool', 'snapshot', 1],
      ['assistant', 'snapshot', 2],
    ]);
  });

  it('只认 text_delta / thinking_delta：别的增量形状与空片段都不产消息（归一层的闸）', async () => {
    const { wire, session } = await subscribedWire();
    session.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: '' } });
    session.emit({ type: 'message_update', assistantMessageEvent: { type: 'signature_delta', contentIndex: 0, delta: 'sig' } });
    session.emit({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', contentIndex: 1, delta: '在想' } });
    const drained = wire.drain(['agent-1']);
    expect(drained.messages).toHaveLength(1);
    expect(drained.messages[0]?.blocks[0]?.block).toMatchObject({ type: 'thinking', text: '在想' });
  });

  it('排空是选择性的：未放行的身份留在缓冲，下一批照常取走（事件一次性、不重放）', async () => {
    const sessionA = createFakePiChildSession();
    const sessionB = createFakePiChildSession();
    const wire = createPiSubagentWire();
    await wire.reload(async () => {
      vendorClaim(() => ({
        getRecord: (id: string) => (id === 'agent-a' ? { session: sessionA } : { session: sessionB }),
      }));
    });
    wire.onStarted('agent-a');
    wire.onStarted('agent-b');
    sessionA.emit(childAssistantEnd('A 的第一步'));
    sessionB.emit(childAssistantEnd('B 的第一步'));
    // 只放行 agent-a：B 的事件留在缓冲
    const first = wire.drain(new Set(['agent-a']));
    expect(first.messages.map((message) => message.subagentId)).toEqual(['agent-a']);
    const second = wire.drain(new Set(['agent-b']));
    expect(second.messages.map((message) => message.subagentId)).toEqual(['agent-b']);
    // 都排空之后再排是空的（排空即消费）
    expect(wire.drain(new Set(['agent-a', 'agent-b'])).messages).toHaveLength(0);
  });

  it('缓冲越界只留最近的，并在排空时点名（静默丢半段与「本来就这些」长得一样）', async () => {
    const { wire, session } = await subscribedWire();
    for (let index = 0; index < PI_SUBAGENT_WIRE_BUFFER_MAX + 2; index += 1) {
      session.emit(childAssistantEnd(`第 ${index} 条`));
    }
    const drained = wire.drain(['agent-1']);
    expect(drained.messages).toHaveLength(PI_SUBAGENT_WIRE_BUFFER_MAX);
    expect(drained.warnings).toHaveLength(1);
    expect(drained.warnings[0]).toContain('丢掉了最早的 2 条');
    // 点名只出现一次：再排不再重复
    expect(wire.drain(['agent-1']).warnings).toHaveLength(0);
  });

  /**
   * **越界时优先丢增量**：快照是权威正文（丢了就真的没有了），而增量只是实时预告
   * ——它一不落盘（编排层只扇出 delta），二**自愈**（同一块的收尾快照会整块覆盖掉
   * 累积值）。于是「增量把快照挤出缓冲」是必须挡住的那一档：子任务话痨 + 行迟迟不落账时，
   * 按到达序淘汰会先吃掉第 1 轮的那条快照，而界面上「少了一整轮」与「本来就没说」长得一样。
   */
  it('越界优先淘汰增量：权威快照留在缓冲里，不被逐字片段挤掉', async () => {
    const { wire, session } = await subscribedWire();
    // 第 1 轮的权威快照先进缓冲（它是这一组里唯一不可替代的那条）
    session.emit(childAssistantEnd('第一轮的权威正文'));
    // 随后灌满一缓冲的逐字增量（真机形态：几千 token 的答复就是几千帧）
    for (let index = 0; index < PI_SUBAGENT_WIRE_BUFFER_MAX + 50; index += 1) {
      session.emit({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: `${index}` },
      });
    }
    const drained = wire.drain(['agent-1']);
    const snapshots = drained.messages.filter((message) => message.chunk === 'snapshot');
    expect(
      snapshots.map((message) => (message.blocks[0]?.block as { text?: string } | undefined)?.text),
      '权威快照被增量挤出了缓冲——淘汰策略没有按块形态分档',
    ).toEqual(['第一轮的权威正文']);
    // 增量被截到上限之内（丢的是最早那批片段，收尾快照一到就整块覆盖 ⇒ 自愈）
    expect(drained.messages.length).toBeLessThanOrEqual(PI_SUBAGENT_WIRE_BUFFER_MAX);
  });

  it('只丢增量时点名说清「只是实时预告」；真丢了快照才按权威正文点名', async () => {
    const { wire, session } = await subscribedWire();
    for (let index = 0; index < PI_SUBAGENT_WIRE_BUFFER_MAX + 3; index += 1) {
      session.emit({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: `${index}` },
      });
    }
    const onlyDeltas = wire.drain(['agent-1']);
    expect(onlyDeltas.warnings).toHaveLength(1);
    expect(onlyDeltas.warnings[0]).toContain('逐字增量');
    // 这一档**不是**丢正文：措辞里要说清它自愈，否则排障的人会去找不存在的丢数
    expect(onlyDeltas.warnings[0]).toContain('收尾快照会覆盖');
  });
});

describe('pi 子智能体 wire：退订与收尾', () => {
  it('终态（subagents:completed）后退订：会话再产流也不进缓冲，已缓冲的尾巴留给排空', async () => {
    const session = createFakePiChildSession();
    const wire = createPiSubagentWire();
    await wire.reload(async () => {
      vendorClaim(() => ({ getRecord: (id: string) => (id === 'agent-1' ? { session } : undefined) }));
    });
    wire.onStarted('agent-1');
    session.emit(childAssistantEnd('收场前的最后一步'));
    wire.onSettled('agent-1');
    expect(session.listenerCount).toBe(0);
    session.emit(childAssistantEnd('收场后的尾巴不该进来'));
    const drained = wire.drain(['agent-1']);
    expect(drained.messages.map((message) => (message.blocks[0]?.block as { text?: string } | undefined)?.text))
      .toEqual(['收场前的最后一步']);
  });

  it('dispose 全部退订并清缓冲：后台档子智能体不随候选续命', async () => {
    const session = createFakePiChildSession();
    const wire = createPiSubagentWire();
    await wire.reload(async () => {
      vendorClaim(() => ({ getRecord: (id: string) => (id === 'agent-1' ? { session } : undefined) }));
    });
    wire.onStarted('agent-1');
    session.emit(childAssistantEnd('还没消费的正文'));
    wire.dispose();
    expect(session.listenerCount).toBe(0);
    expect(wire.drain(['agent-1']).messages).toHaveLength(0);
  });
});

/**
 * **合成帧泵**：实时性那一格的守卫（口径见 `subagent-wire.ts` 文件头「合成帧泵」）。
 *
 * 为什么这一组必须存在：排空挂在父事件上，而派发期（`Agent` 阻塞）父会话一个事件都不产
 * ——没有泵，子任务正文会攒到工具收尾才一次性涌出（界面在整段派发期是空态）。
 * 判据一律取**泵被推了几次**，那正是「谁来触发排空」这件事的唯一可观测面。
 */
describe('pi 子智能体 wire：合成帧泵', () => {
  /** 泵节拍也拨到测试档：节流窗口压到 1 ms，用例不必按产品的 25 ms 等 */
  function fastPump(): void {
    setPiSubagentWireTimingsForTesting({ pollMs: 1, giveUpMs: 25, tickMs: 1 });
  }

  /** 走产品路径造一个已订阅的 wire，并接上一个计数泵 */
  async function pumpedWire(): Promise<{
    wire: ReturnType<typeof createPiSubagentWire>;
    session: ReturnType<typeof createFakePiChildSession>;
    ticks: () => number;
    detach: () => void;
  }> {
    const session = createFakePiChildSession();
    const wire = createPiSubagentWire();
    await wire.reload(async () => {
      vendorClaim(() => ({ getRecord: (id: string) => (id === 'agent-1' ? { session } : undefined) }));
    });
    wire.onStarted('agent-1');
    let count = 0;
    const detach = wire.attachPump(() => {
      count += 1;
    });
    return { wire, session, ticks: () => count, detach };
  }

  it('产品默认节拍钉值（改它就是改子任务正文的实时性与投影密度）', () => {
    expect(PI_SUBAGENT_WIRE_TICK_MS).toBe(25);
    // 一次正常投递要两帧（第一帧让子任务行落账，第二帧才排空）⇒ 封顶下限是 2
    expect(PI_SUBAGENT_WIRE_MAX_FRUITLESS_TICKS).toBe(3);
    expect(PI_SUBAGENT_WIRE_MAX_FRUITLESS_TICKS).toBeGreaterThan(2);
  });

  it('缓冲进账即推一帧：父会话一个事件都没有也能换到一次排空', async () => {
    fastPump();
    const { session, ticks } = await pumpedWire();
    expect(ticks()).toBe(0);
    session.emit(childAssistantEnd('派发期的第一步'));
    // 同步那一发就推出去：实时性不等下一个宏任务
    expect(ticks()).toBe(1);
  });

  /**
   * **节流压的是投影次数，不是正文的新鲜度**——这是「25 ms 对几千帧增量也够用」的成立前提：
   * 一拍之内攒下的增量由同一次 `drain` **整批**取走，帧再密也不会被丢、不会被推迟到下一轮。
   * 没有这条性质，节流就等于丢帧，调大节拍会变成「正文变慢」而不是「投影变省」。
   */
  it('一拍只推一帧，但那一帧把这一拍攒下的增量整批取走（节流不丢帧、不压新鲜度）', async () => {
    fastPump();
    const { wire, session, ticks } = await pumpedWire();
    for (let index = 0; index < 60; index += 1) {
      session.emit({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: `${index}` },
      });
    }
    // 60 帧增量只换到一帧合成帧（投影次数被压住了）
    expect(ticks()).toBe(1);
    // 而那一次排空把 60 帧**全部**取走（新鲜度没被压：一帧都没留到下一拍）
    const drained = wire.drain(['agent-1']);
    expect(drained.messages).toHaveLength(60);
    expect(drained.messages.every((message) => message.chunk === 'delta')).toBe(true);
  });

  it('至多一帧在飞：同一轮的十几条收尾只换一帧，排空后才再换下一帧', async () => {
    fastPump();
    const { wire, session, ticks } = await pumpedWire();
    for (let index = 0; index < 12; index += 1) session.emit(childAssistantEnd(`第 ${index} 步`));
    expect(ticks()).toBe(1);
    // 排空消旗 ⇒ 新内容能再换一帧（节流窗口过后）
    wire.drain(['agent-1']);
    await sleep(5);
    session.emit(childAssistantEnd('下一轮的第一步'));
    await sleep(5);
    expect(ticks()).toBe(2);
  });

  it('续泵：一发只取走已落账的身份时自己再约一帧（否则第二帧要等父会话，而派发期没有事件）', async () => {
    fastPump();
    const { wire, session, ticks } = await pumpedWire();
    session.emit(childAssistantEnd('正文'));
    expect(ticks()).toBe(1);
    /**
     * 真机形状：第一次排空时子任务行还没落账（`deliveredEarlier` 是投影前的快照）⇒
     * 放行集合是空的，一条消息都取不出来。缓冲仍非空 ⇒ 必须自己再约一帧。
     */
    expect(wire.drain([]).messages).toHaveLength(0);
    await sleep(5);
    expect(ticks()).toBe(2);
    // 这一帧上行已落账，正文真的出去了
    expect(wire.drain(['agent-1']).messages).toHaveLength(1);
  });

  it('空转封顶：永远不会落账的身份不把泵拖成按节拍的永久空转', async () => {
    fastPump();
    const { wire, session, ticks } = await pumpedWire();
    session.emit(childAssistantEnd('永远等不到它的子任务行'));
    // 一直不放行（派发认领失败那一档）：空转几发之后就该停下
    for (let index = 0; index < 10; index += 1) {
      wire.drain([]);
      await sleep(3);
    }
    expect(ticks()).toBeLessThanOrEqual(PI_SUBAGENT_WIRE_MAX_FRUITLESS_TICKS + 1);
    /**
     * 停下不等于瘸掉：**有新内容就归零**（活着的子会话永远泵得动），
     * 而缓冲里那批老的也随这一帧一起出去。
     */
    const before = ticks();
    session.emit(childAssistantEnd('新内容来了'));
    expect(ticks()).toBe(before + 1);
    expect(wire.drain(['agent-1']).messages).toHaveLength(2);
  });

  it('接泵的那一刻缓冲非空就补一帧：区间缝隙里进来的正文不等父会话的下一个事件', async () => {
    fastPump();
    const session = createFakePiChildSession();
    const wire = createPiSubagentWire();
    await wire.reload(async () => {
      vendorClaim(() => ({ getRecord: (id: string) => (id === 'agent-1' ? { session } : undefined) }));
    });
    wire.onStarted('agent-1');
    // 还没接泵（上一条区间已终、下一条还没起）：只写缓冲，没人能取
    session.emit(childAssistantEnd('缝隙里进来的正文'));
    let count = 0;
    wire.attachPump(() => {
      count += 1;
    });
    expect(count).toBe(1);
  });

  it('摘泵与 dispose 之后不再推帧：流已经不在了，推出去的帧没人接', async () => {
    fastPump();
    const { wire, session, ticks, detach } = await pumpedWire();
    detach();
    session.emit(childAssistantEnd('摘泵之后的正文'));
    await sleep(5);
    expect(ticks()).toBe(0);
    // 正文本身没丢：它还在缓冲里，收尾排空照常取（dispose 之后也不推帧）
    expect(wire.drain(['agent-1']).messages).toHaveLength(1);
    wire.dispose();
    await sleep(5);
    expect(ticks()).toBe(0);
  });
});
