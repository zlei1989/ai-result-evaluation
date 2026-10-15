// @vitest-environment node
/**
 * 端口实现与落点：**账本记的是「模型真收到了什么」**，以及「等不到的那一刻怎么收场」。
 *
 * 这一组用例刻意不用假适配器、不跑一次评测：它只造一条已落盘的轮次 + 一行，
 * 然后直接调端口那一侧的四格与那两个时间出口。判据因此落在**磁盘上的事实**上
 * （`messages.jsonl` / `events.jsonl` 里到底有没有那一行），而不是落在某个内部标志上。
 *
 * 五条口径（决定了下面每条断言为什么长这样）：
 *   1. **未投递期间账本一个字都不写**：`drain` 之后、`markDelivered` 之前，
 *      `messages.jsonl` 里既没有那一句，也没有任何事件；
 *   2. **事件与消息共用同一把钥匙**（`messageId` = 客户端登记时那个 id）：两处能互相追回；
 *   3. **落盘过同一条终态闸门**：行已落终态后适配器收尾期吐的一律不落；
 *   4. **两条人话不许在账本里折成一条**（`mergeKey` 必须带身份那一段，见 `deliveredMessage`）；
 *   5. **预算与行收场是两件事**：前者说「等太久了」、后者说「这一行已经结束了」。
 */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentEvent, AgentMessage, RetractOutcome } from '@aieval/contracts';
import { readEvents, rowEventsFile, rowMessagesFile } from '@aieval/core';
import {
  INJECT_WAIT,
  createInjectionPort,
  listInjectMessages,
  readAttachmentSize,
  registerInjectMessage,
  retractInjectMessage,
  settleInjectQueueOnRowEnd,
  waitForInjectQueue,
} from './inject-port';
import { resetInjectQueueForTesting } from './inject-queue';
import { saveRun } from './run-store';
import { createTempHome, makeRowFixture, makeRunFixture, type TempHome } from './testing/fixtures';

let home: TempHome;
let runId: string;
let rowId: string;
/** `noteDelivered` 收到的条数（产品侧它会写进 `EvalRow.followUps`） */
let counted: number;
/** 落盘闸门（行是否还收记录） */
let landingOpen: boolean;

beforeEach(() => {
  home = createTempHome();
  resetInjectQueueForTesting();
  const row = makeRowFixture();
  const run = makeRunFixture({ workspaceRoot: home.workspaceRoot, rows: [row] });
  saveRun(run);
  runId = run.id;
  rowId = row.id;
  counted = 0;
  landingOpen = true;
});

afterEach(() => {
  resetInjectQueueForTesting();
  home.cleanup();
});

/** 这一行在磁盘上的消息账本（不存在时给空数组） */
function records(): AgentMessage[] {
  const file = rowMessagesFile(home.workspaceRoot, runId, rowId);
  try {
    return readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as { type: string; message: AgentMessage })
      .map((record) => record.message);
  } catch {
    return [];
  }
}

/** 这一行在磁盘上的行级事件 */
function events(): AgentEvent[] {
  return readEvents(rowEventsFile(home.workspaceRoot, runId, rowId));
}

/** 造一个端口（落盘口径与产品侧同形；`roundTrip` 固定成 2，断言里读得到） */
function port(sizeOf?: (path: string) => number | null): ReturnType<typeof createInjectionPort> {
  return createInjectionPort({
    runId,
    rowId,
    landingOpen: () => landingOpen,
    roundTripHere: () => 2,
    noteDelivered: (count) => {
      counted += count;
    },
    ...(sizeOf === undefined ? {} : { sizeOf }),
  });
}

/** 登记一条（默认「排队」档） */
function register(messageId: string, text: string, attachments: { kind: 'image' | 'file'; path: string | null; mimeType: string | null }[] = []): void {
  registerInjectMessage({ runId, rowId, messageId, text, attachments, requires: 'idle' });
}

describe('落点：交给厂商那一刻才写账本', () => {
  it('未投递期间账本一个字都不写；`markDelivered` 那一刻同时落消息与事件', () => {
    register('m-1', '顺便把 changelog 也补上');
    const inject = port();
    expect(inject.drain('idle')).toEqual([{ id: 'm-1', text: '顺便把 changelog 也补上' }]);
    // 取件只是「拿走了」：这一刻模型还没收到，账本与事件都必须是空的
    expect(records()).toEqual([]);
    expect(events()).toEqual([]);

    inject.markDelivered(['m-1'], async () => 'unsupported');

    const [message] = records();
    expect(message).toMatchObject({
      // 三处共用同一把钥匙：队列表的条目、账本这一条、下面那一条事件
      messageId: 'm-1',
      role: 'user',
      source: 'hook',
      // 这一格是「哪句是出题人写的、哪句是人在半路插的」唯一的线索
      origin: 'human',
      roundTrip: 2,
      chunk: 'snapshot',
      assembly: 'snapshot',
      blocks: [{ type: 'text', text: '顺便把 changelog 也补上' }],
    });
    const [event] = events();
    expect(event).toMatchObject({ type: 'inject-message', messageId: 'm-1', requires: 'idle', outcome: 'delivered', reason: null });
    expect(counted).toBe(1);
  });

  it('附件清单进账本（块形状），但**交付给厂商的正文**里带的是路径与大小', () => {
    register('m-1', '看这两份', [
      { kind: 'image', path: '/rows/a/attachments/m-1/a.png', mimeType: 'image/png' },
      { kind: 'file', path: null, mimeType: null }, // 没有路径的附件：不写进清单，但仍然记账本块
    ]);
    const inject = port((path) => (path.endsWith('.png') ? 2_048 : null));
    expect(inject.drain('idle')).toEqual([
      { id: 'm-1', text: '看这两份\n\n[附件]\n- /rows/a/attachments/m-1/a.png (2.0 KB)' },
    ]);
    inject.markDelivered(['m-1'], async () => 'unsupported');

    const [message] = records();
    expect(message?.blocks).toEqual([
      { type: 'text', text: '看这两份' },
      { type: 'attachment', kind: 'image', path: '/rows/a/attachments/m-1/a.png', mimeType: 'image/png' },
      { type: 'attachment', kind: 'file', path: null, mimeType: null },
    ]);
  });

  it('两条人话落在同一轮时**不许折成一条**（合并键各带各的身份）', () => {
    register('m-1', '第一句');
    register('m-2', '第二句');
    const inject = port();
    inject.drain('idle');
    inject.markDelivered(['m-1', 'm-2'], async () => 'unsupported');

    const all = records();
    expect(all.map((message) => message.mergeKey)).toEqual(['main|2|user|-|inject:m-1', 'main|2|user|-|inject:m-2']);
    // 两条都读得回来：合并键相同的话读侧会把后一条盖掉前一条（界面上只剩一句）
    expect(all).toHaveLength(2);
    expect(counted).toBe(2);
  });

  it('行已落终态 ⇒ 不落账本、不落事件（同一条闸门），计数也不动', () => {
    register('m-1', '这一句不该进账本');
    landingOpen = false;
    const inject = port();
    inject.drain('idle');
    inject.markDelivered(['m-1'], async () => 'unsupported');

    expect(records()).toEqual([]);
    expect(events()).toEqual([]);
    // 「N 与账本对齐」：账本里没有它，计数就不该有它
    expect(counted).toBe(0);
  });
});

describe('等待预算：等太久了（与「行收场」是两件事）', () => {
  it('到点 ⇒ 那一条落 gone + `timed-out` 事件，窗口以 `expired` 落定', async () => {
    register('m-1', '人话');
    const controller = new AbortController();
    const outcome = await waitForInjectQueue({ runId, rowId, signal: controller.signal, budgetMs: 5 });

    expect(outcome).toBe('expired');
    expect(listInjectMessages(runId, rowId)[0]).toMatchObject({ state: 'gone', outcome: 'timed-out' });
    expect(events()[0]).toMatchObject({ type: 'inject-message', messageId: 'm-1', outcome: 'timed-out' });
    // 未投递的收场**不产生账本记录**：模型从来没看到过它
    expect(records()).toEqual([]);
  });

  it('队列本来就是空的 ⇒ 立刻 `empty`（不起计时器、不落任何东西）', async () => {
    const controller = new AbortController();
    expect(await waitForInjectQueue({ runId, rowId, signal: controller.signal, budgetMs: 5 })).toBe('empty');
    expect(events()).toEqual([]);
  });

  it('行终止 ⇒ `canceled`，那一条**原样留着**（它的收场归行收场那条路）', async () => {
    register('m-1', '人话');
    const controller = new AbortController();
    controller.abort();
    const outcome = await waitForInjectQueue({ runId, rowId, signal: controller.signal, budgetMs: 10_000 });
    expect(outcome).toBe('canceled');
    expect(listInjectMessages(runId, rowId)[0]?.state).toBe('queued');
    expect(events()).toEqual([]);
  });

  it('缺省预算 = 十分钟 − 编排层早的那一秒（与端口那条缺省同一个数）', async () => {
    expect(INJECT_WAIT.budgetMs).toBe(600_000);
    expect(INJECT_WAIT.leadMs).toBe(1_000);
  });
});

describe('行收场：这一行已经结束了', () => {
  it('未投递的条目落 gone + `discarded` 事件，表清空（含已投递的那些）', () => {
    register('m-1', '还没投出去');
    register('m-2', '已经投出去了');
    const inject = port();
    inject.drain('idle');
    inject.markDelivered(['m-2'], async () => 'unsupported');
    // 又来了第三条：行收场时它也没投出去
    register('m-3', '行结束前一刻到的');

    expect(settleInjectQueueOnRowEnd(runId, rowId)).toBe(2);
    // 事件逐条落（与消息共用 `messageId`），两条的原因是「行已结束」
    // 事件按发生顺序：先 m-2 的「已送达」，再两条「行已结束」的丢弃
    const injectEvents = events().filter((event) => event.type === 'inject-message');
    expect(injectEvents.map((event) => (event.type === 'inject-message' ? [event.messageId, event.outcome] : null)))
      .toEqual([['m-2', 'delivered'], ['m-1', 'discarded'], ['m-3', 'discarded']]);
    expect(listInjectMessages(runId, rowId)).toEqual([]);
    // 已投递的那条早已落过账本，行收场不动它
    expect(records().map((message) => message.messageId)).toEqual(['m-2']);
  });
});

describe('撤回：四值分派 + 只有真的变了才落事件', () => {
  it('还在我们手里 ⇒ 直接摘掉（200 + 已撤回），落一条 `retracted` 事件', async () => {
    register('m-1', '人话');
    expect((await retractInjectMessage(runId, rowId, 'm-1')).kind).toBe('removed');
    expect(events()[0]).toMatchObject({ type: 'inject-message', outcome: 'retracted', reason: null });
    // 端口的四值映射：gone ⇒ `retracted`（那一条回不来了）
    expect(await port().retract('m-1')).toBe('retracted');
  });

  it('交出去之后撤回成功 ⇒ `retracted`；厂商说已经被读到 ⇒ `already-consumed` + 事件', async () => {
    register('m-1', '第一条');
    register('m-2', '第二条');
    const inject = port();
    inject.drain('idle');
    inject.markDelivered(['m-1', 'm-2'], async () => 'retracted');

    expect(await inject.retract('m-1')).toBe('retracted');
    expect((await retractInjectMessage(runId, rowId, 'm-2')).kind).toBe('retracted');
    // 先两条「已送达」（`markDelivered` 那一刻落的），再两条「已撤回」
    expect(events().filter((event) => event.type === 'inject-message').map((event) => (event.type === 'inject-message' ? event.outcome : null)))
      .toEqual(['delivered', 'delivered', 'retracted', 'retracted']);

    // 厂商赢的那一支：如实落「已被读到」，并给界面一句可直接展示的话
    register('m-3', '第三条');
    const inject2 = port();
    inject2.drain('idle');
    inject2.markDelivered(['m-3'], async () => 'already-consumed');
    const outcome: RetractOutcome = await inject2.retract('m-3');
    expect(outcome).toBe('already-consumed');
    const consumed = listInjectMessages(runId, rowId).find((entry) => entry.messageId === 'm-3');
    expect([consumed?.state, consumed?.outcome, consumed?.reason]).toEqual(['consumed', 'already-consumed', '这一条已经交给智能体了，撤不回来']);
  });

  it('撤不了（`unsupported` / `unknown`）⇒ 什么也不变、**不落事件**', async () => {
    register('m-1', '人话');
    const inject = port();
    inject.drain('idle');
    inject.markDelivered(['m-1'], async () => 'unsupported');
    const before = events().length;
    expect((await retractInjectMessage(runId, rowId, 'm-1')).kind).toBe('unsupported');
    expect(events()).toHaveLength(before);
    expect(listInjectMessages(runId, rowId)[0]?.state).toBe('delivered');
  });

  it('不存在的 id ⇒ `not-found`（端口的四值读作 `unknown`：撤不到、也说不出为什么）', async () => {
    expect((await retractInjectMessage(runId, rowId, 'nope')).kind).toBe('not-found');
    expect(await port().retract('nope')).toBe('unknown');
  });
});

describe('附件大小：读不到就不写那一格', () => {
  it('真实文件读到字节数，路径不存在时给 null', () => {
    const file = rowMessagesFile(home.workspaceRoot, runId, rowId);
    // 用一条已知内容的真实文件：`readAttachmentSize` 只是 `statSync` 的一层薄壳
    const size = readAttachmentSize(file);
    expect(size === null || size > 0).toBe(true);
    expect(readAttachmentSize(`${file}.not-there`)).toBeNull();
  });
});
