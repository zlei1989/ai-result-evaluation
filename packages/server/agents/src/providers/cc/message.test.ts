// @vitest-environment node
/**
 * cc 的**子任务帧形状判决**。
 *
 * 这个文件守的是一个真机缺陷：CLI 的 `task_started` / `task_notification` **不只给真派发的 `Task`**，
 * 也给**非 Agent 的后台任务**——真机那一条是子智能体自己跑的 Bash（wire 上的「名字」就是那条命令的
 * `description`）。只认 `task_id` + subtype 时，它会在派发面板里多出一条**幽灵「子任务」**
 * （没有转录、用量恒「未采集」），并让收尾喊一句「读不到子智能体 `<那条 Bash 的 task_id>`」。
 *
 * 判据 = `subagent_type` / `spawn_depth` / `prompt` **至少一格非 `null`**（**不是**「非空串 / 非零」——
 * `''` 与 `0` 都算「给了」，刻度见下面「刻度」那条用例：判严了会把真派发判成幻影，那比幽灵行更坏）。
 * ⚠️ **判据只对 `task_started` 成立**：**收场帧不承载形状证据**——审计投影只在 `start` 相位写那三格
 * （`events.ts` 的 `subagentDraft` 里 `if (isStart)` 那一支），而 CLI 的会话转录里**根本没有** `task_*` 帧
 * ⇒ 厂商的收场帧长什么样**我们从未观测到**（**未知 ≠ 缺失**，别写成「三格缺」）。逐帧判 = 拿一个
 * 不承载证据的帧去判，会把**每一个真派发**的收场帧判成幻影（面板那一行永远停在 `running`、
 * 抽屉那一格用量永远「未采集」）——所以判决按 **id 记账**，收场帧追随同一个 id 的 `start` 帧。
 */
import { describe, expect, it } from 'vitest';
import { TOOL_RESULT_MAX_CHARS, createMessageAssembler } from '../../message';
import { createClaudeMessageNormalizer } from './message';
import type { TurnState } from '../../turn';

/** 一份空状态（本文件只用到 `seen` 之外的默认值；判决的账在归一器自己的闭包里） */
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

/** 真派发的 `task_started`（真机三格齐） */
const DISPATCH_START = {
  type: 'system',
  subtype: 'task_started',
  task_id: 'afb636cf844060a29',
  tool_use_id: 'call_00_IMhfpY0slUImZQz8HdhB9708',
  description: 'Review Vue 3 CDN hello world',
  subagent_type: 'general-purpose',
  spawn_depth: 1,
  prompt: 'Review the file…',
  is_backgrounded: false,
};

/** CLI 给**非 Agent 任务**发的 `task_started`（真机逐字：三格全空、名字就是那条 Bash 的 `description`） */
const PHANTOM_START = {
  type: 'system',
  subtype: 'task_started',
  task_id: 'bey1yc1n7',
  tool_use_id: 'call_01_8LZpHuCgmKv8s15UluBE8153',
  description: 'Check latest Vue version on npm',
  is_backgrounded: false,
};

describe('cc：task_* 帧的形状判决', () => {
  it('三格全空的 task 帧**不产**子任务行（面板里那条幽灵「子任务」就是它）', () => {
    const output = createClaudeMessageNormalizer().normalize(PHANTOM_START, state());
    expect(output.taskShape).toBe('phantom');
    // 关键：**没有** `SubagentRecord` ⇒ `messages.jsonl` / 派发面板里一条都不会有
    expect(output.subagent).toBeNull();
  });

  it('幻影的收场帧同样不产行（否则幽灵行会从收场那一侧回来）', () => {
    const normalizer = createClaudeMessageNormalizer();
    normalizer.normalize(PHANTOM_START, state());
    const end = normalizer.normalize(
      { type: 'system', subtype: 'task_notification', task_id: 'bey1yc1n7', tool_use_id: 'call_01_8LZpHuCgmKv8s15UluBE8153', status: 'completed', summary: 'Check latest Vue version on npm' },
      state(),
    );
    expect(end.taskShape).toBe('phantom');
    expect(end.subagent).toBeNull();
  });

  it('真派发：start 帧判 dispatch，收场帧按**同一个 id** 追随（收场帧上没有那三格）', () => {
    const normalizer = createClaudeMessageNormalizer();
    const start = normalizer.normalize(DISPATCH_START, state());
    expect(start.taskShape).toBe('dispatch');
    expect(start.subagent?.subagentId).toBe('afb636cf844060a29');
    expect(start.subagent?.status).toBe('running');

    // 收场帧**不承载**形状证据（未知 ≠ 缺失）——逐帧判会把它判成幻影（真派发就没有终态了）
    const end = normalizer.normalize(
      { type: 'system', subtype: 'task_notification', task_id: 'afb636cf844060a29', tool_use_id: 'call_00_IMhfpY0slUImZQz8HdhB9708', status: 'completed', summary: '看完了' },
      state(),
    );
    expect(end.taskShape).toBe('dispatch');
    expect(end.subagent?.status).toBe('completed');
  });

  /**
   * **收尾那条完整快照必须带上 `kind`**（`subagent_type` 只在派发帧上，真机键集见 `message.ts`）。
   * 覆盖不许丢事实：收尾帧那一格缺席时若不回填，同一个子任务的第二条投递就把派发时采到的
   * `general-purpose` 换成 `null`，面板上那条子任务行在收尾那一拍退回半截
   * （同一帧上的 `name` 一直在回填，两条投递的口径必须一致）。
   */
  it('派发帧带 `subagent_type`、收尾帧不带 ⇒ 两条投递的 `kind` 一致且非空', () => {
    const normalizer = createClaudeMessageNormalizer();
    const start = normalizer.normalize(DISPATCH_START, state());
    const end = normalizer.normalize(
      { type: 'system', subtype: 'task_notification', task_id: 'afb636cf844060a29', tool_use_id: 'call_00_IMhfpY0slUImZQz8HdhB9708', status: 'completed', summary: '看完了' },
      state(),
    );
    expect(start.subagent?.kind).toBe('general-purpose');
    // 后到的那条不许比先到的那条更瘦：`kind` 逐字相同、且都不是 `null`
    expect(end.subagent?.kind).toBe(start.subagent?.kind);
    // 名字走同一条回填路（收尾帧同样没有 `description`）
    expect(end.subagent?.name).toBe(start.subagent?.name);
  });

  /**
   * **嵌套派发的层级**（`parent_task_id`）：真机读数（CLI 2.1.301，子智能体再派一个子智能体）——
   * 内层那条 `task_started` 带 `parent_task_id`（值 = 外层那条的 `task_id`）、`spawn_depth: 2`，
   * 而**收场帧不带**这一格 ⇒ 与 `kind` 同一处置：派发帧记账、收尾按同一 id 回填。
   *
   * 这一格决定界面上的**层级**（`packages/client/ui` 的 `build-model.ts` 按它把子任务挂到
   * `subagent:<父 id>` 下）⇒ 恒填 `null` 会让嵌套子任务全部平铺在主会话那一条下面。
   */
  it('嵌套派发：内层带 `parent_task_id` ⇒ 两条投递都指向外层（收场帧靠账回填）', () => {
    const normalizer = createClaudeMessageNormalizer();
    const outer = normalizer.normalize({ ...DISPATCH_START, task_id: 'a35e01a6937e02049' }, state());
    const innerStart = normalizer.normalize(
      {
        type: 'system',
        subtype: 'task_started',
        task_id: 'a44df30fc84460765',
        tool_use_id: 'toolu_inner',
        description: '内层数行数',
        subagent_type: 'Explore',
        spawn_depth: 2,
        parent_task_id: 'a35e01a6937e02049',
        task_type: 'local_agent',
        prompt: '数行数',
      },
      state(),
    );
    const innerEnd = normalizer.normalize(
      { type: 'system', subtype: 'task_notification', task_id: 'a44df30fc84460765', tool_use_id: 'toolu_inner', status: 'completed', summary: '数完了' },
      state(),
    );

    // 顶层派发本来就没有这一格 ⇒ `null` 是「没有父」，不是「没采到」
    expect(outer.subagent?.parentSubagentId).toBeNull();
    expect(innerStart.subagent?.parentSubagentId).toBe('a35e01a6937e02049');
    // 收场帧不带这一格：不回填的话，层级在收尾那一拍整棵挂回主会话
    expect(innerEnd.subagent?.parentSubagentId).toBe('a35e01a6937e02049');
  });

  it('只见到收场帧（没有 start 可判形状）⇒ 照产行，但判决是 unjudged（不冒充实派发的证据）', () => {
    const output = createClaudeMessageNormalizer().normalize(
      { type: 'system', subtype: 'task_notification', task_id: 'task-x', tool_use_id: 'call_x', status: 'completed', summary: '跑完了' },
      state(),
    );
    // 丢一个真派发比多一条幽灵行更坏（用户裁定）⇒ 行照发；但它不是「形状像派发」的证据
    // （`index.ts` 据此不让它进事实核对名单 ⇒ 不会为它喊「读不到」；盘上没有它的转录时另落一条
    //  「可能少算它（无法判定它是不是子智能体）」的 WARN，见 index.test.ts 的两条用例）
    expect(output.taskShape).toBe('unjudged');
    expect(output.subagent?.subagentId).toBe('task-x');
  });

  /**
   * **判据的松紧刻度**：裁定逐字是「至少一格**非 `null`**」，
   * **不是**「非空串 / 非零」。这条刻度偏向**保**——判严了会把一个真派发判成幻影（丢行、丢终态、
   * 抽屉里那一格永远「未采集」），而那比多一条幽灵行更坏（同一条取舍见 `'unjudged'` 那一档）。
   * 反向的代价（`subagent_type: ''` 这种畸形帧留住一行）是有意接受的。
   */
  it('刻度：`subagent_type: \'\'` 与 `spawn_depth: 0` 都算「给了」⇒ 仍判 dispatch（判严了会丢真派发）', () => {
    const emptyKind = createClaudeMessageNormalizer().normalize(
      { ...DISPATCH_START, task_id: 'task-empty-kind', subagent_type: '', spawn_depth: undefined, prompt: undefined },
      state(),
    );
    expect(emptyKind.taskShape).toBe('dispatch');
    expect(emptyKind.subagent?.subagentId).toBe('task-empty-kind');

    // `0` 是**采到了 0**，不是「没采到」：`spawn_depth: 0` 同样算一格证据
    const zeroDepth = createClaudeMessageNormalizer().normalize(
      { ...DISPATCH_START, task_id: 'task-zero-depth', subagent_type: undefined, spawn_depth: 0, prompt: undefined },
      state(),
    );
    expect(zeroDepth.taskShape).toBe('dispatch');
    expect(zeroDepth.subagent?.subagentId).toBe('task-zero-depth');
  });
});

/**
 * **厂商标了「这不是活动」的 task 帧**（`ambient` / `skip_transcript`）。
 *
 * 厂商 JSDoc 逐字：*"True for tasks that are not activity (every skip_transcript task, plus every
 * live-update watcher, requested or auto-started); **hosts should exclude them from activity
 * indicators**."* 这正是三格形状判据想推断的同一件事，而厂商已经直接给了答案
 * ⇒ **显式标记优先于形状推断**。没有这一条，一个三格齐全的 live-update watcher 会被判成真派发，
 * 在派发面板里多出一行（而它压根不是一次子智能体派发）。
 */
describe('cc：厂商标了 ambient 的 task 帧不产子任务行', () => {
  for (const flag of ['ambient', 'skip_transcript'] as const) {
    it(`${flag} 为真 ⇒ 判 phantom、不产行（哪怕三格形状全齐）`, () => {
      const output = createClaudeMessageNormalizer().normalize({ ...DISPATCH_START, [flag]: true }, state());

      expect(output.taskShape).toBe('phantom');
      expect(output.subagent).toBeNull();
    });
  }

  /** 反向判据：没标这两格的真派发照旧产行（修正不许把真派发一起挡掉） */
  it('没有这两格的真派发照旧判 dispatch 并产行', () => {
    const output = createClaudeMessageNormalizer().normalize(DISPATCH_START, state());

    expect(output.taskShape).toBe('dispatch');
    expect(output.subagent?.subagentId).toBe('afb636cf844060a29');
  });
});

/**
 * **历史重放帧**（`SDKUserMessageReplay.isReplay`）在消息侧的处置。
 *
 * 续接（`resume`）时 CLI 把这条会话**已经发生过**的用户侧消息再投一遍，而重放帧带的是**自己的**
 * `uuid` ⇒ 本侧那张去重表挡不住它。收下的代价有两层：`messages.jsonl` 里多出一份上一轮的工具结果
 * （追问是**追加到同一行**上的，那些内容本行已经有了），以及**任务台账的 patch 被再放一遍**
 * ——后者会让计划清单按历史又走一遍状态机。
 */
describe('cc：续接时的历史重放帧（消息侧）', () => {
  const REPLAYED_RESULT = {
    type: 'user',
    uuid: 'replay-1',
    isReplay: true,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: '上一轮的结果' }] },
  };

  it('重放的工具结果不产消息（不把上一轮的内容在本行再写一遍）', () => {
    expect(createClaudeMessageNormalizer().normalize(REPLAYED_RESULT, state()).messages).toEqual([]);
  });

  /**
   * **台账不被重放的结果推一遍**：这是本条守卫的要害。
   * 先建一项任务（`TaskCreate` 的结果给 id），再喂一条**重放的** `TaskUpdate` 结果——
   * 它若被收下，台账会按历史把那一项推成 `completed`，面板上的计划清单当场倒带。
   */
  it('重放的工具结果不推任务台账（计划清单不按历史倒带）', () => {
    const normalizer = createClaudeMessageNormalizer();
    const turn = state();
    normalizer.normalize(
      {
        type: 'assistant',
        uuid: 'u-1',
        message: { id: 'msg_1', role: 'assistant', content: [{ type: 'tool_use', id: 'call_c1', name: 'TaskCreate', input: { subject: '甲' } }] },
      },
      turn,
    );
    normalizer.normalize(
      {
        type: 'user',
        uuid: 'u-2',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_c1', content: 'created' }] },
        tool_use_result: { task: { id: '1', subject: '甲' } },
      },
      turn,
    );
    normalizer.normalize(
      {
        type: 'assistant',
        uuid: 'u-3',
        message: { id: 'msg_2', role: 'assistant', content: [{ type: 'tool_use', id: 'call_u1', name: 'TaskUpdate', input: { taskId: '1', status: 'in_progress' } }] },
      },
      turn,
    );

    // 一条**重放的** TaskUpdate 结果（上一轮那次把它推到了 completed）
    const replayed = normalizer.normalize(
      {
        type: 'user',
        uuid: 'replay-2',
        isReplay: true,
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_u1', content: 'updated' }] },
        tool_use_result: { success: true, taskId: '1', statusChange: { from: 'in_progress', to: 'completed' } },
      },
      turn,
    );

    // 被丢弃 ⇒ 既不产消息，也不产「台账刷新」那条重投快照
    expect(replayed.messages).toEqual([]);
  });

  /** 反向判据：不带这一格的同形帧照旧产消息 */
  it('不带 isReplay 的同形工具结果照旧产消息', () => {
    const { isReplay: _dropped, ...live } = REPLAYED_RESULT;
    const output = createClaudeMessageNormalizer().normalize({ ...live, uuid: 'live-1' }, state());

    expect(output.messages).toHaveLength(1);
    expect(output.messages[0]?.role).toBe('tool');
  });
});

/**
 * 同一条厂商消息的**多次投递**（覆盖合并）。
 *
 * 真机形状（claude 行 `ceec6cb1`，transcript `[22]` / `[23]`）：CLI 对**同一个**
 * `assistant.message.id` 分两次投递，**每次只带一个内容块**（先 `thinking`、后 `text`）。
 * 契约要求每次投递都带「该消息到目前为止的完整块」，但块序号**必须按投递顺序继续分配**——
 * 每次投递都新建分配器的话，第二次的 `text` 会拿到 `i:0`，把第一次的 `thinking` 从槽里盖掉。
 * 症状：**原始输出里有思考、执行日志里没有**（用户报的就是这个）。
 *
 * 为什么第 1 轮（`thinking` + `tool_use`）没暴露：工具调用按 `c:<callId>` 分槽，撞不上 `i:0`。
 */
describe('cc：同一条消息的多次投递（覆盖合并）', () => {
  /** 走完整链路：归一器 → 装配器，取**最终视图**（读侧就是它） */
  function finalView(frames: unknown[]): { blocks: { type: string }[] } | undefined {
    const normalizer = createClaudeMessageNormalizer();
    const turnState = state();
    const assembler = createMessageAssembler({ runId: 'run-test' });
    const out: { blocks: { type: string }[] }[] = [];
    for (const frame of frames) {
      for (const draft of normalizer.normalize(frame, turnState).messages) {
        assembler.ingest(draft, (message) => out.push(message as { blocks: { type: string }[] }));
      }
    }
    return out.at(-1);
  }

  it('先 thinking 后 text 的两次投递：最终视图里两块都在，且 thinking 在前', () => {
    const final = finalView([
      { type: 'assistant', uuid: 'u-think', message: { id: 'msg_A', content: [{ type: 'thinking', thinking: '想了半天', signature: '' }] } },
      { type: 'assistant', uuid: 'u-text', message: { id: 'msg_A', content: [{ type: 'text', text: '正文' }] } },
    ]);
    expect(final?.blocks.map((block) => block.type)).toEqual(['thinking', 'text']);
  });

  it('反向顺序（先 text 后 thinking）同样两块都在——序号按投递顺序走，不按块类型', () => {
    const final = finalView([
      { type: 'assistant', uuid: 'u-text2', message: { id: 'msg_B', content: [{ type: 'text', text: '正文' }] } },
      { type: 'assistant', uuid: 'u-think2', message: { id: 'msg_B', content: [{ type: 'thinking', thinking: '补想的', signature: '' }] } },
    ]);
    expect(final?.blocks.map((block) => block.type)).toEqual(['text', 'thinking']);
  });

  it('判据不误伤：第二条投递里 tool_use 仍与 thinking 并存（第 1 轮那种真机形状）', () => {
    const final = finalView([
      { type: 'assistant', uuid: 'u-think3', message: { id: 'msg_C', content: [{ type: 'thinking', thinking: '先想', signature: '' }] } },
      { type: 'assistant', uuid: 'u-tool3', message: { id: 'msg_C', content: [{ type: 'tool_use', id: 'call_1', name: 'Skill', input: {} }] } },
    ]);
    expect(final?.blocks.map((block) => block.type)).toEqual(['thinking', 'tool-call']);
  });
});

/**
 * **超长工具结果的截断标志**（真机：22 001 字符的结果被切成 20 000）。
 *
 * 这一家的坑很具体：`resultText()` 曾经**先截一次**再把文本交给 `toolResultBlockDraft`，
 * 于是下游那句 `clipped.truncated` 恒 `false` ⇒ `truncation.kind` 恒 `unknown`——**截了也不说**，
 * 界面永远不显示「输出已被截断」，而 codex / dsh / pi 三家都说得出来。
 * 判据落在 `truncation` 那一格上：超限必须是 `truncated`，没超限才是 `unknown`（厂商没给标记）。
 */
describe('cc：超长工具结果的截断标志', () => {
  function toolResult(content: string): Record<string, unknown> {
    return {
      type: 'user',
      uuid: `u-${content.length}`,
      parent_tool_use_id: null,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-long', content, is_error: false }] },
    };
  }

  function truncationOf(frame: Record<string, unknown>): unknown {
    const output = createClaudeMessageNormalizer().normalize(frame, state());
    const draft = output.messages.flatMap((message) => message.blocks).find((one) => one.block.type === 'tool-result');
    return draft?.block.type === 'tool-result' ? draft.block.truncation : null;
  }

  it('超过上限 ⇒ `truncated`（标志不许被预截断吃掉）', () => {
    expect(truncationOf(toolResult('A'.repeat(TOOL_RESULT_MAX_CHARS + 1)))).toEqual({
      kind: 'truncated',
      reason: `超过 ${TOOL_RESULT_MAX_CHARS} 字符`,
    });
  });

  it('没超上限 ⇒ `unknown`（厂商没给标记时不许写成「确认完整」）', () => {
    expect(truncationOf(toolResult('短结果'))).toEqual({ kind: 'unknown' });
  });
});
