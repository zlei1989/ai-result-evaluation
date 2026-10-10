// @vitest-environment node
/**
 * claude-code 的**子任务帧形状判决**。
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

describe('claude-code：task_* 帧的形状判决', () => {
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
