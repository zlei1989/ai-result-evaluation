// @vitest-environment node
/**
 * cc 的**每会话自己的轮次号**（`message.ts` 的 `roundTripOfSession`）。
 *
 * 它回答的是「进子会话节点之后时间轴按什么分轮」：主会话锚在**主循环那本账**上
 * （`events.ts` 的 `countModelRoundTrip` 按到达顺序记完整 assistant 消息 id，取号见 `mainRoundTrip`
 * ——增量先到时占「下一个号」，于是它与随后的快照同键），而 `parent_tool_use_id` 非空的侧链消息
 * 按**该子会话自己的** 1..N 编号 ⇒ 子会话节点的消息按它自己的轮次分行，而不是全挤在
 * 父会话派发的那一轮里。与 codex 的 `threadMessages`（一线程一套号）同形。
 *
 * ⚠️ 这条编号的用途是**子会话节点好不好读**（按会话各数各的轮次）：它不依赖 `subagent-usage.ts`
 * 的逐轮读数——那批读数已经没有了（用户裁定：只展示最终用量），所以本文件没有「与 `rounds`
 * 逐个 `message.id` 对齐」那条跨模块对照（③）。
 *
 * ⚠️ **两条不许被下面这几条用例误伤的既有口径**（它们各有自己的守卫，这里只声明）：
 *   · 主会话的号仍由**主循环计数**维护（`events.ts` 的 `countModelRoundTrip` 只在主循环上加），
 *     侧链消息**不进**那个计数 ⇒ 行级轮次仍是「主 + 子」；
 *   · `turn` / `step` 仍恒 `null`（这家没有这两格）。
 */
import { describe, expect, it } from 'vitest';
import { carrierKeyOf, type MessageDraft } from '../../message';
import { createTurnState } from '../../testing/agent-fixtures';
import { projectClaudeMessage } from './events';
import { createClaudeMessageNormalizer, type ClaudeMessageNormalizer } from './message';
import type { TurnState } from '../../turn';

/** 一条主会话 assistant 消息（`parent_tool_use_id` 为 `null` = 主循环） */
function mainAssistant(uuid: string, messageId: string): unknown {
  return {
    type: 'assistant',
    uuid,
    parent_tool_use_id: null,
    message: { id: messageId, role: 'assistant', content: [{ type: 'text', text: '干活' }] },
  };
}

/**
 * 一条**侧链** assistant 消息（真机形状：顶层 `parent_tool_use_id` = 派生它的那次调用 id，
 * 与 `task_started.tool_use_id`、`messages.jsonl` 里的 `subagentId` 三者同值）。
 * `messageId` 就是读数那把尺子的去重键（同一轮会按内容块多次到达、共享同一个 id）。
 */
function sideAssistant(uuid: string, parentCallId: string, messageId: string): unknown {
  return {
    type: 'assistant',
    uuid,
    parent_tool_use_id: parentCallId,
    message: { id: messageId, role: 'assistant', content: [{ type: 'text', text: '子智能体的话' }] },
  };
}

/** 归一后一条消息的 `(会话身份, 轮次号)`（`subagentId` 为 `null` 即主会话） */
function pairOf(draft: MessageDraft): [session: string | null, roundTrip: number] {
  return [draft.subagentId, draft.roundTrip];
}

/**
 * 喂一条原始消息，返回消息侧的归一草稿。
 *
 * ⚠️ 顺序与 `index.ts` 的 `project()` **逐字相同**：**先事件投影、再消息归一**——
 * 主循环的 `state.turns` 是事件投影推进的，少了前半步主会话的号恒为 1，
 * 用例会以「主会话也只有 1」的形式自我说服（那是假绿）。
 */
function feed(normalizer: ClaudeMessageNormalizer, state: TurnState, raw: unknown): MessageDraft[] {
  projectClaudeMessage(raw, state, { kind: 'cc', baseUrl: 'http://gw.test' });
  return normalizer.normalize(raw, state).messages;
}

/** 按会话把一串消息的号收成 `{ 'main': [...], '<subagentId>': [...] }`（顺序 = 投递顺序） */
function roundsBySession(normalizer: ClaudeMessageNormalizer, state: TurnState, raws: readonly unknown[]): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  for (const raw of raws) {
    for (const [session, roundTrip] of feed(normalizer, state, raw).map(pairOf)) {
      const key = session ?? 'main';
      out[key] = [...(out[key] ?? []), roundTrip];
    }
  }
  return out;
}

describe('cc：侧链消息按「每会话自己的」轮次号编号（与读数同一把尺子）', () => {
  /**
   * 靶子：**两个子会话交错投递**时，各自的号必须各自从 1 起、互不吃对方的号，
   * 也不能吃主会话的号（改前的形状：所有侧链消息一律带主会话当前的号）。
   * 同时钉住「同一个 `message.id` 的多次投递拿到**同一个**号」——合并键
   * （`subagentId | roundTrip | role | parentCallId`）里有轮次号，号一变同一条逻辑消息就被劈成两条。
   */
  it('① 两个子会话交错出现消息 ⇒ 各自 1..N 独立（同一个 id 的重复投递仍占原号）', () => {
    const state = createTurnState();
    const normalizer = createClaudeMessageNormalizer();
    const rounds = roundsBySession(normalizer, state, [
      mainAssistant('u-m1', 'main-m-1'),
      sideAssistant('u-a1', 'call_a', 'a-m-1'),
      sideAssistant('u-b1', 'call_b', 'b-m-1'),
      mainAssistant('u-m2', 'main-m-2'),
      sideAssistant('u-a2', 'call_a', 'a-m-2'),
      sideAssistant('u-b2', 'call_b', 'b-m-2'),
      // 同一条逻辑消息的第二次投递（真机：每个完成的内容块一条）⇒ 仍占第 1 轮
      sideAssistant('u-a1-again', 'call_a', 'a-m-1'),
      sideAssistant('u-b3', 'call_b', 'b-m-3'),
      sideAssistant('u-a3', 'call_a', 'a-m-3'),
    ]);

    expect(rounds).toEqual({
      main: [1, 2],
      // 交错的 B 会话没有把 A 的号往前推，反之亦然
      call_a: [1, 2, 1, 3],
      call_b: [1, 2, 3],
    });
  });

  /**
   * 靶子：**主会话的号不受侧链影响**（本次改动最容易被顺手改坏的一格）。
   *
   * ⚠️ **对照那一半是刻意的**：只断言「主会话 = 1,2,3」时，改前的实现（侧链沿用主会话号）
   * 与「侧链号恒为 1」都**照样绿**——主会话的号本来就只由 `events.ts` 的主循环计数给出。
   * 所以这里同时断言侧链**有自己的 1..3**：这一半才让「不受影响」这句话可被证伪
   */
  it('② 主会话的号不受侧链影响：中间插了侧链消息，主会话仍是 1,2,3（侧链另起一套）', () => {
    const state = createTurnState();
    const normalizer = createClaudeMessageNormalizer();
    const rounds = roundsBySession(normalizer, state, [
      mainAssistant('u-m1', 'main-m-1'),
      sideAssistant('u-a1', 'call_a', 'a-m-1'),
      sideAssistant('u-a2', 'call_a', 'a-m-2'),
      sideAssistant('u-a3', 'call_a', 'a-m-3'),
      mainAssistant('u-m2', 'main-m-2'),
      sideAssistant('u-a1-again', 'call_a', 'a-m-1'),
      mainAssistant('u-m3', 'main-m-3'),
    ]);

    // 主会话：三条消息就是主循环的三次往返，侧链一条都没数进去（行级轮次仍是「主 + 子」）
    expect(rounds.main).toEqual([1, 2, 3]);
    // 对照：侧链那 4 条投递里，前三条是自己的 1/2/3，最后那条回到原号 1
    expect(rounds.call_a).toEqual([1, 2, 3, 1]);
  });

  /**
   * 靶子：**流式增量那条路**也得拿到同一条号（合并键 `subagentId | roundTrip | role | parentCallId`
   * 把这两格都算进去了）。
   *
   * 改前增量无条件用主会话的号、身份恒 `null` ⇒ 一条侧链增量会与**主会话同一轮**的块挤进同一个载体，
   * 而它随后的快照带着自己的身份与号落在**另一个**载体里 ⇒ 增量那一份永远收不了尾（`assembly: 'open'`）。
   * 这一条因此同时断言两件事：① 增量的号是**它那个会话自己的**（这里主会话已经到第 2 轮，
   * 「掉进主会话的号」会是一个可辨认的错值 2）；② 增量与它随后的快照**落在同一个载体**上。
   */
  it('④ 流式增量也按会话取号：侧链增量与它随后的快照落在同一个载体上', () => {
    const state = createTurnState();
    const normalizer = createClaudeMessageNormalizer();
    // 主会话先走两轮 ⇒ 主会话当前的号是 2（增量若掉进主会话的号，拿到的就是这个 2）
    feed(normalizer, state, mainAssistant('u-m1', 'main-m-1'));
    feed(normalizer, state, mainAssistant('u-m2', 'main-m-2'));

    /** 一条侧链的流式事件（真机里流式只覆盖主会话，这一档是「拿得到归属就照实归位」那一支） */
    const streamEvent = (uuid: string, event: unknown): unknown => ({
      type: 'stream_event',
      uuid,
      parent_tool_use_id: 'call_sub',
      event,
    });

    const started = feed(normalizer, state, streamEvent('u-s1', { type: 'message_start', message: { id: 'sub-m-1' } }));
    const delta = feed(
      normalizer,
      state,
      streamEvent('u-s2', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '半句' } }),
    );
    const snapshot = feed(normalizer, state, sideAssistant('u-s3', 'call_sub', 'sub-m-1'));

    // `message_start` 自己不产消息（它只重建块序号分配器）
    expect(started).toEqual([]);
    // ① 号是**它那个会话自己的**第 1 轮（不是主会话当前的 2），身份也跟着归位
    expect(delta.map(pairOf)).toEqual([['call_sub', 1]]);
    expect(snapshot.map(pairOf)).toEqual([['call_sub', 1]]);
    // ② 载体同一性：生产上合并键由 `../../message` 的 `carrierKeyOf` 算，增量与快照必须逐字相同
    //    （不同 ⇒ 增量的那一份永远收不了尾：没有快照来 seal 它）
    expect(delta.map(carrierKeyOf)).toEqual(snapshot.map(carrierKeyOf));

    /**
     * **主会话那一档**：增量占的是「主会话账里的**下一个号**」（`mainRoundTrip`：id 不在账里 ⇒
     * `turnKeys.size + 1`），不是「已经数到几条」。两者的差在多轮时才现形，而后果很硬：
     * 已经数到的那个号属于**上一轮**，而上一轮的文本槽已被它自己的快照 `sealed` ⇒
     * 增量按「已 seal + 增量 ⇒ 丢弃」被静默吃掉，界面直到快照到达才整段出现。
     *
     * 本条覆盖的是其中一种形状：这条主会话增量**没有**自己的 `message_start`
     * （`streamingMessageId` 还停在上面那条侧链消息上）⇒ 它查不到主会话账 ⇒ 占「账里条数 + 1」。
     * 带自己 `message_start` 的常规形状由 `stream-alignment.test.ts` 钉住。
     */
    const mainDelta = feed(
      normalizer,
      state,
      {
        type: 'stream_event',
        uuid: 'u-m3',
        parent_tool_use_id: null,
        event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '主会话的半句' } },
      },
    );
    // 主会话已经完整到达两轮 ⇒ 这条增量属于**第 3 轮**（拿 2 就会落进已 seal 的第 2 轮载体）
    expect(mainDelta.map(pairOf)).toEqual([[null, 3]]);

    // 载体同一性（与 ② 同一条判据）：它随后的快照必须落在同一个载体上，否则这份增量永远收不了尾
    const mainSnapshot = feed(normalizer, state, mainAssistant('u-m4', 'main-m-3'));
    expect(mainSnapshot.map(pairOf)).toEqual([[null, 3]]);
    expect(mainDelta.map(carrierKeyOf)).toEqual(mainSnapshot.map(carrierKeyOf));
  });
});

