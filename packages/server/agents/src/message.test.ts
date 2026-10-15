// @vitest-environment node
/**
 * 合并算法：适配器公共层里唯一一份「块怎么归位、快照怎么覆盖、序号怎么分配」的实现。
 *
 * 这一层错了，三家会**同时**错（所以必须有独立用例把这些规则逐条钉住）：
 *   ① `delta` 追加、`snapshot` 覆盖、`snapshot` 之后的 `delta` 丢弃；
 *   ② 块序号按**首次到达**分配，一经分配不再变化；工具块用 `callId` 区分（同轮多次调用互不覆盖）；
 *   ③ 合并键含`载体`（`role` + `parentCallId`）：同一轮里 assistant 消息与工具结果消息各自从 0 起算，
 *      只带块序号会把工具结果盖到正文块上；
 *   ④ `messageId` 是本项目生成的 `<runId>:<seq>`（从 1 递增）；
 *   ⑤ `assembly`：每块都收到过 snapshot 才是 `'snapshot'`，有块停在增量上就是 `'open'`（未收尾）。
 */
import { describe, expect, it } from 'vitest';
import { AgentMessageSchema, type AgentMessage } from '@aieval/contracts';
import { toolCallHint } from './activity';
import {
  createBlockIndexAllocator,
  createMessageAssembler,
  textBlockDraft,
  thinkingBlockDraft,
  toolCallBlockDraft,
  toolResultBlockDraft,
  truncate,
  TOOL_RESULT_MAX_CHARS,
  type MessageDraft,
} from './message';

/** 一条消息草稿的信封默认值：用例只覆盖自己关心的格 */
function draft(overrides: Partial<MessageDraft> & Pick<MessageDraft, 'blocks'>): MessageDraft {
  return {
    vendorId: null,
    role: 'assistant',
    source: 'wire',
    roundTrip: 1,
    turn: null,
    step: null,
    parentCallId: null,
    subagentId: null,
    chunk: 'snapshot',
    // 消息级用量：这一层默认「没有」（用例要显式给才成立）
    usage: null,
    raw: null,
    ...overrides,
  };
}

function run(drafts: readonly MessageDraft[]): AgentMessage[] {
  const assembler = createMessageAssembler({ runId: 'run-1' });
  const out: AgentMessage[] = [];
  for (const item of drafts) assembler.ingest(item, (message) => out.push(message));
  return out;
}

describe('messageAssembler：增量与快照', () => {
  it('delta 追加到累积缓冲区，snapshot 覆盖它（最终块是快照那句）', () => {
    const messages = run([
      draft({ chunk: 'delta', blocks: [textBlockDraft('我先看', 'delta')] }),
      draft({ chunk: 'delta', blocks: [textBlockDraft('一下配置文件。', 'delta')] }),
      draft({ chunk: 'snapshot', blocks: [textBlockDraft('我先看一下配置文件。', 'snapshot')] }),
    ]);
    // 每条投递产出的都是**该合并键到目前为止的完整块**（这正是「只想实现 snapshot 也能正确渲染」
    // 那条契约保证）：所以第二条已经是两段拼起来的结果
    expect(messages.map((message) => (message.blocks[0] as { text: string }).text)).toEqual([
      '我先看',
      '我先看一下配置文件。',
      '我先看一下配置文件。',
    ]);
    // 快照那条是**覆盖**而不是拼接：不会出现「我先看一下配置配置文件。」
    expect(messages.at(-1)?.blocks[0]).toEqual({ type: 'text', text: '我先看一下配置文件。' });
  });

  it('snapshot 之后再到的同键 delta 丢弃（快照已含它之前的内容，追加会写重）', () => {
    const messages = run([
      draft({ chunk: 'snapshot', blocks: [textBlockDraft('完整这句', 'snapshot')] }),
      draft({ chunk: 'delta', blocks: [textBlockDraft('不该被追加', 'delta')] }),
    ]);
    expect((messages.at(-1)?.blocks[0] as { text: string }).text).toBe('完整这句');
  });

  it('快照可以再次覆盖（dsh 的 `block-end` 与 claude 的完整消息都会在流式之后重投同一个块）', () => {
    const messages = run([
      draft({ chunk: 'delta', blocks: [textBlockDraft('半截', 'delta')] }),
      draft({ chunk: 'snapshot', blocks: [textBlockDraft('第一次快照', 'snapshot')] }),
      draft({ chunk: 'snapshot', blocks: [textBlockDraft('第二次快照', 'snapshot')] }),
    ]);
    expect((messages.at(-1)?.blocks[0] as { text: string }).text).toBe('第二次快照');
  });

  it('思考块的增量同样追加，`textKind` 不被增量片段改写', () => {
    const messages = run([
      draft({ chunk: 'delta', blocks: [thinkingBlockDraft('先读', 'full', 'delta')] }),
      draft({ chunk: 'delta', blocks: [thinkingBlockDraft('配置。', 'full', 'delta')] }),
    ]);
    expect(messages.at(-1)?.blocks[0]).toEqual({ type: 'thinking', text: '先读配置。', textKind: 'full', signature: null });
  });
});

/**
 * 工具块的**摘要主体**：随块给出，供抽屉的工具行直接渲染。
 *
 * 为什么钉在这里：这句话的词表真源是 `activity.ts`，而消费方（浏览器）按分层表不许 import `agents`
 * ——摘要必须**随块落进消息**。它一旦漏填，工具行的摘要行会静默回落到参数原文首行
 * （`{command, description}` 那种形状就是一整串 JSON），看起来「只是不那么好看」，没有任何报错。
 *
 * **口径**：这一格是 `toolCallHint` 的产物——**只有冒号后面那一段**，
 * 不带 `调用工具 <名>：` 前缀。工具行把工具名渲染成独立元素，带前缀就是同一件事说两遍；
 * 活动行另有 `toolCallSummary`（同词表加前缀，见 `activity.test.ts`）。
 */
describe('toolCallBlockDraft：块自带摘要主体', () => {
  it('摘要与 `activity.ts` 的词表逐字一致（描述优先、每族拼法、计划类特判）', () => {
    const read = toolCallBlockDraft('call_1', 'Read', { file_path: 'a.ts' }, 'cc');
    expect(read.block).toMatchObject({ summary: toolCallHint('Read', { file_path: 'a.ts' }) });
    expect((read.block as { summary?: string }).summary).toBe('a.ts');

    // 描述优先：两个键都在时给 `描述（目标）`
    const described = toolCallBlockDraft('call_desc', 'Bash', { command: 'ls -la', description: 'List files' }, 'cc');
    expect((described.block as { summary?: string }).summary).toBe('List files（ls -la）');

    // 计划类入参只说几步（「更新计划」那四个字是活动行的句式，工具行不复述）
    const plan = toolCallBlockDraft('call_2', 'TodoWrite', { todos: [{ subject: 'a' }, { subject: 'b' }] }, 'cc');
    expect((plan.block as { summary?: string }).summary).toBe('2 步');
  });

  it('没名字 / 没参数时摘要主体是空串（界面据此说「参数未采集」），不编一句话', () => {
    const bare = toolCallBlockDraft('call_3', '', null, 'cc');
    expect((bare.block as { summary?: string }).summary).toBe('');
  });
});

describe('messageAssembler：块序号与合并键', () => {
  it('新块追加到末尾（claude 把同一条消息按内容块分多条投递：每条都是新块）', () => {
    const messages = run([
      draft({ blocks: [thinkingBlockDraft('想一下', 'full', 'snapshot', null, { kind: 'index', index: 0 })] }),
      draft({ blocks: [textBlockDraft('答复', 'snapshot', { kind: 'index', index: 1 })] }),
      draft({ blocks: [toolCallBlockDraft('call_1', 'Read', { file_path: 'a.ts' }, 'cc')] }),
    ]);
    // 最后一条消息带齐三块，且顺序 = 首次到达顺序
    expect(messages.at(-1)?.blocks.map((block) => block.type)).toEqual(['thinking', 'text', 'tool-call']);
  });

  it('工具块按 `callId` 区分：同轮两次调用互不覆盖，结果按 `callId` 落回同一条', () => {    const messages = run([
    draft({ blocks: [toolCallBlockDraft('call_1', 'Read', { file_path: 'a.ts' }, 'cc')] }),
    draft({ blocks: [toolCallBlockDraft('call_2', 'Read', { file_path: 'b.ts' }, 'cc')] }),
    // 工具结果的载体是 `role: 'tool'`（与调用那条不同）⇒ 它是一条**独立**的逻辑消息，
    // 靠 `callId` 这个块标识与调用配对（只看块序号会把两次调用的结果互相盖掉）
    draft({ role: 'tool', blocks: [toolResultBlockDraft('call_1', '内容 A')] }),
  ]);
    /** 收集所有承载某个 `callId` 的槽位：`[载体 role, 该槽位的块类型]` */
  const carriersOf = (callId: string): string[] =>
    messages
      .filter((message) => message.blocks.some((block) => 'callId' in block && block.callId === callId))
      .map((message) => `${message.role}:${message.blocks.map((block) => block.type).join('+')}`);
    // 两条调用消息的块**同时存在**（第二次没有覆盖第一次）
  expect(carriersOf('call_1')).toContain('assistant:tool-call+tool-call');
  expect(carriersOf('call_2')).toContain('assistant:tool-call+tool-call');
  // 结果按同一个 `callId` 配对：它落在 `role: 'tool'` 的那条消息里，且与 `call_2` 无关
  expect(carriersOf('call_1')).toContain('tool:tool-result');
  expect(carriersOf('call_2')).not.toContain('tool:tool-result');
  });

  it('合并键含载体：同一轮里工具结果消息的块不会盖到正文块上', () => {
    const messages = run([
      // 正文：role assistant + parentCallId null，块序号 0
      draft({ blocks: [textBlockDraft('我先读文件。', 'snapshot', { kind: 'index', index: 0 })] }),
      // 工具结果：role tool（载体不同）⇒ 两条消息各自持有自己的块
      draft({ role: 'tool', blocks: [toolResultBlockDraft('call_1', '文件内容')] }),
    ]);
    expect(messages[0]?.blocks).toHaveLength(1);
    expect(messages[1]?.blocks).toHaveLength(1);
    // 第二条消息**不含**第一条的正文块（否则就是把工具结果盖到正文块上）
    expect(messages[1]?.blocks[0]).toMatchObject({ type: 'tool-result' });
  });

  it('`parentCallId` 进载体：子智能体消息与主线程消息互不干扰', () => {
    const messages = run([
      draft({ blocks: [textBlockDraft('主线程', 'snapshot', { kind: 'index', index: 0 })] }),
      draft({
        parentCallId: 'call_Task',
        subagentId: 'call_Task',
        blocks: [textBlockDraft('子智能体', 'snapshot', { kind: 'index', index: 0 })],
      }),
    ]);
    expect((messages[0]?.blocks[0] as { text: string }).text).toBe('主线程');
    expect((messages[1]?.blocks[0] as { text: string }).text).toBe('子智能体');
    expect(messages[1]?.subagentId).toBe('call_Task');
  });

  it('`messageId` 是本项目生成的 `<runId>:<seq>`，从 1 递增（与厂商 id 解耦）', () => {
    const messages = run([
      draft({ vendorId: 'msg_a', blocks: [textBlockDraft('一', 'snapshot')] }),
      draft({ vendorId: 'msg_b', blocks: [textBlockDraft('二', 'snapshot')] }),
    ]);
    expect(messages.map((message) => message.messageId)).toEqual(['run-1:1', 'run-1:2']);
    expect(messages.map((message) => message.vendorId)).toEqual(['msg_a', 'msg_b']);
  });
});

describe('messageAssembler：收尾标记', () => {
  it('每块都收到过 snapshot ⇒ `assembly: "snapshot"`；停在增量上 ⇒ `"open"`', () => {
    const open = run([draft({ chunk: 'delta', blocks: [textBlockDraft('还在打字', 'delta')] })]);
    expect(open[0]?.assembly).toBe('open');
    const sealed = run([
      draft({ chunk: 'delta', blocks: [textBlockDraft('还在打字', 'delta')] }),
      draft({ chunk: 'snapshot', blocks: [textBlockDraft('打完了', 'snapshot')] }),
    ]);
    expect(sealed.at(-1)?.assembly).toBe('snapshot');
  });

  it('同一载体里只要有一个块没收尾，整条消息就是 `"open"`', () => {
    const messages = run([
      draft({ chunk: 'snapshot', blocks: [textBlockDraft('正文', 'snapshot', { kind: 'index', index: 0 })] }),
      draft({ chunk: 'delta', blocks: [thinkingBlockDraft('还在想', 'full', 'delta', null, { kind: 'index', index: 1 })] }),
    ]);
    expect(messages.at(-1)?.assembly).toBe('open');
  });
});

describe('messageAssembler：收口（sealOpen）', () => {
  /** 跑一遍投递，**最后收口**（与 `turn.ts` 会话收尾那一步同形） */
  function runSealed(drafts: readonly MessageDraft[]): AgentMessage[] {
    const assembler = createMessageAssembler({ runId: 'run-1' });
    const out: AgentMessage[] = [];
    const sink = (message: AgentMessage): void => void out.push(message);
    for (const item of drafts) assembler.ingest(item, sink);
    assembler.sealOpen(sink);
    return out;
  }

  it('停在增量上的槽按**累积值**封口，补发的那条是 `snapshot`', () => {
    const messages = runSealed([draft({ chunk: 'delta', blocks: [textBlockDraft('半截话', 'delta')] })]);
    expect(messages.map((message) => message.assembly)).toEqual(['open', 'snapshot']);
    expect((messages.at(-1)?.blocks[0] as { text: string }).text).toBe('半截话');
  });

  /**
   * `chunk` 这一格不能沿用载体的最后一封（那多半是增量）：编排层按 `chunk === 'delta'`
   * 决定「只广播、不落盘」——沿用增量会让收口的内容留在内存里、刷新后消失，
   * 而它带着 `assembly: 'snapshot'` 又自称是收尾，两格自相矛盾。
   */
  it('收口产出的那条 `chunk` 恒为 `snapshot`（不沿用载体的最后一封增量）', () => {
    const messages = runSealed([draft({ chunk: 'delta', blocks: [textBlockDraft('半截话', 'delta')] })]);
    expect(messages.at(-1)?.chunk).toBe('snapshot');
  });

  it('全都收过尾的载体不再补发（同一份内容不说两遍）', () => {
    const assembler = createMessageAssembler({ runId: 'run-1' });
    const out: AgentMessage[] = [];
    const sink = (message: AgentMessage): void => void out.push(message);
    assembler.ingest(draft({ blocks: [textBlockDraft('写完这句', 'snapshot')] }), sink);
    const before = out.length;
    expect(assembler.sealOpen(sink)).toBe(0);
    expect(out.length).toBe(before);
  });

  /**
   * 靶子（cc 真机形态，见 `docs/faq/claude-code.md`）：**厂商不保证为每个块投递完整快照**——
   * 有些轮次只投 `tool_use` 的完整消息，正文只以流式增量到达。那个正文槽永远等不到自己的快照，
   * 载体就停在 `open`，界面据此显示「正在思考」，而整行早已结束。
   */
  it('正文只以增量到达、同轮只投了工具快照 ⇒ 收口把它封上（否则永远「正在思考」）', () => {
    const messages = runSealed([
      draft({ chunk: 'delta', blocks: [textBlockDraft('我来看一下。', 'delta')] }),
      draft({ chunk: 'snapshot', blocks: [toolCallBlockDraft('call_1', 'Bash', { command: 'ls' }, 'cc')] }),
    ]);
    // 工具快照到达时正文槽仍未收尾（这一条就是真机上「正在思考」的来源）
    expect(messages.at(-2)?.assembly).toBe('open');
    // 收口之后整条载体翻成 snapshot，且正文按累积值保留
    expect(messages.at(-1)?.assembly).toBe('snapshot');
    expect(messages.at(-1)?.blocks.map((block) => block.type)).toEqual(['text', 'tool-call']);
  });

  /**
   * 收口**只动 `sealed` 标志**，不碰块的类型与内容——思考块收口后仍是思考块。
   * 这一条是给「收口会不会把思考内容当成正文展示」这个疑问的判据：
   * 块的 `type` 由进槽的那条草稿决定（`applyBlock`），收口路径一个字都不改它。
   */
  it('收口对思考块同样成立：类型与内容都原样保留（思考不会被当成正文）', () => {
    const messages = runSealed([
      draft({
        chunk: 'delta',
        blocks: [thinkingBlockDraft('我先想想。', 'full', 'delta', null, { kind: 'index', index: 0 })],
      }),
      draft({ chunk: 'delta', blocks: [textBlockDraft('想好了。', 'delta', { kind: 'index', index: 1 })] }),
    ]);
    const last = messages.at(-1);
    expect(last?.assembly).toBe('snapshot');
    expect(last?.blocks.map((block) => block.type)).toEqual(['thinking', 'text']);
    expect((last?.blocks[0] as { text: string }).text).toBe('我先想想。');
    expect((last?.blocks[1] as { text: string }).text).toBe('想好了。');
  });

  it('收口就是封口：之后同键的增量不再追加（补写会把已结束的那段说长）', () => {
    const assembler = createMessageAssembler({ runId: 'run-1' });
    const out: AgentMessage[] = [];
    const sink = (message: AgentMessage): void => void out.push(message);
    assembler.ingest(draft({ chunk: 'delta', blocks: [textBlockDraft('结尾', 'delta')] }), sink);
    assembler.sealOpen(sink);
    assembler.ingest(draft({ chunk: 'delta', blocks: [textBlockDraft('补充', 'delta')] }), sink);
    expect((out.at(-1)?.blocks[0] as { text: string }).text).toBe('结尾');
  });
});

describe('blockIndexAllocator：块序号只能追加、不能重排', () => {
  it('`forSource` 对同一个厂商序号只分配一次（增量与它的快照落进同一槽位）', () => {
    const allocator = createBlockIndexAllocator();
    expect(allocator.forSource(0)).toBe(0);
    expect(allocator.forSource(0)).toBe(0);
    expect(allocator.forSource(1)).toBe(1);
    // `next()` 与 `forSource` 共用一个号源：混用时不会撞号
    expect(allocator.next()).toBe(2);
  });
});

describe('产出的每条消息都符合契约（含 `mergeKey`）', () => {
  it('信封逐格合法，且 `mergeKey` 就是合并键的字符串形式', () => {
    const messages = run([
      draft({ blocks: [textBlockDraft('主线程', 'snapshot')] }),
      draft({
        subagentId: 'call_Task',
        parentCallId: 'call_Task',
        roundTrip: 2,
        blocks: [toolCallBlockDraft('call_1', 'Read', { file_path: 'a.ts' }, 'cc')],
      }),
    ]);
    for (const message of messages) {
      expect(AgentMessageSchema.safeParse(message).success, JSON.stringify(message)).toBe(true);
    }
    expect(messages[0]?.mergeKey).toBe('main|1|assistant|-');
    expect(messages[1]?.mergeKey).toBe('call_Task|2|assistant|call_Task');
  });
});

/**
 * 消息级用量的合并。
 * 三条判据各自的靶子：
 *   · 带值 ⇒ 落到信封上（否则界面上永远没有这一格）；
 *   · 后到不带值 ⇒ **保留**（同一条逻辑消息会多次投递：增量块 / block-end 快照，usage 只在完整
 *     assistant/message 那一次到达；错成「后到覆盖」会把已采到的用量抹掉）；
 *   · 后到带新值 ⇒ 覆盖（它是「这一次调用」的值，不是累加）。
 */
describe('消息级 usage 的合并', () => {
  const tokens = { input: 295, cached: 7424, output: 841, reasoningOutput: null, total: null };
  const next = { input: 210, cached: 8448, output: 562, reasoningOutput: null, total: null };

  it('投递带 usage ⇒ 原样落到信封上', () => {
    const messages = run([draft({ usage: tokens, blocks: [textBlockDraft('正文', 'snapshot')] })]);
    expect(messages.at(-1)?.usage).toEqual(tokens);
  });

  it('后到的投递不带 usage ⇒ 保留已采到的值（快照覆盖内容但不抹掉计量）', () => {
    const messages = run([
      draft({ usage: tokens, blocks: [textBlockDraft('半截', 'delta')] }),
      draft({ usage: null, blocks: [textBlockDraft('完整这句', 'snapshot')] }),
    ]);
    expect((messages.at(-1)?.blocks[0] as { text: string }).text).toBe('完整这句');
    expect(messages.at(-1)?.usage).toEqual(tokens);
  });

  it('后到的投递带新 usage ⇒ 覆盖（不是相加）', () => {
    const messages = run([
      draft({ usage: tokens, blocks: [textBlockDraft('第一版', 'snapshot')] }),
      draft({ usage: next, blocks: [textBlockDraft('第二版', 'snapshot')] }),
    ]);
    expect(messages.at(-1)?.usage).toEqual(next);
  });

  it('从没带过 ⇒ 是 null（草稿层的 null 原样进信封，不是 undefined）', () => {
    const messages = run([draft({ usage: null, blocks: [textBlockDraft('正文', 'snapshot')] })]);
    expect(messages.at(-1)?.usage).toBeNull();
  });
});

/**
 * **截断的两条硬口径**（真机读数各一条）：
 *   ① 切点回退到**码点边界**——`slice` 按 UTF-16 码元切，切在代理对中间会留下孤立代理
 *      （真机：19 999 个 `A` + 😀 + 1 000 个 `B` ⇒ 切完末尾码元是 `0xD83D`）；JSON 里那是非法
 *      序列、界面渲染成 `�`，而同一份内容在 `structured` 那一格里还是完整的；
 *   ② 「截过」这件事只由 `truncate` 的返回值表达——调用方**不许先截一次再把文本交下来**
 *      （那样下游的 `truncated` 恒 `false`，`truncation` 那格会说「没截过」）。
 */
describe('truncate：码点边界与截断标志', () => {
  it('切点落在代理对中间 ⇒ 少切一个码元，不留孤立代理', () => {
    const text = 'A'.repeat(19_999) + '😀' + 'B'.repeat(1_000);
    const clipped = truncate(text, 20_000);
    expect(clipped.truncated).toBe(true);
    expect(clipped.text).toBe('A'.repeat(19_999));
    const last = clipped.text.charCodeAt(clipped.text.length - 1);
    expect(last >= 0xd800 && last <= 0xdbff, '末位是孤立高位代理').toBe(false);
  });

  it('切点不在代理对上 ⇒ 就切在上限处（不为「可能劈开」白丢一个字符）', () => {
    const text = 'L'.repeat(25_000);
    expect(truncate(text, 20_000).text).toBe('L'.repeat(20_000));
  });

  it('没超上限 ⇒ 原样返回且 `truncated` 为假', () => {
    expect(truncate('short', 20_000)).toEqual({ text: 'short', truncated: false });
  });

  it('上限常量与判据同源（改动上限时这条会提醒你把真机读数一起更新）', () => {
    expect(TOOL_RESULT_MAX_CHARS).toBe(20_000);
  });
});
