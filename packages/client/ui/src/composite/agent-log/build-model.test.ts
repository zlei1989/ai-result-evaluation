// @vitest-environment jsdom
/**
 * `buildAgentLogModel` 的守卫：契约形状 → 界面模型那一步的三件必须有人做的事
 * （按 `subagentId` 分会话、按 `roundTrip` 分轮、把能力声明摊成字典），
 * 以及三条最容易错的判据：
 *
 *   1. **`mergeKey` 覆盖而不是追加**：同一条逻辑消息投递多次时，时间轴上只能出现一次，
 *      且是**最后那一次**（它的 `blocks` 已是全量）。错成追加的症状是「同一段正文出现两遍，
 *      后一遍还是半截的」——看着像内容错，其实是合并错。
 *   2. **`round` 用 `roundTrip`**：`vendorTurn` 三家语义不同、明文禁止用于分组。
 *   3. **`running` 不由「有没有后续块」推断**：只有最后一轮可能是「还没结束」的那一轮，
 *      一次被中断的回复停了就是停了（`facts.live === false` ⇒ 全部 `running === false`）。
 */
import { describe, expect, it } from 'vitest';
import type { AgentEvent, AgentMessage, RowRecord } from '@aieval/contracts';
import { buildAgentLogModel, diagnosticsOf, rowEventsOf, type AgentLogFactsInput } from './build-model';
import type { MessageCapabilityMap, RowEvent } from './types';

function message(input: {
  id: string;
  mergeKey: string;
  roundTrip: number;
  role?: AgentMessage['role'];
  source?: AgentMessage['source'];
  assembly?: AgentMessage['assembly'];
  subagentId?: string | null;
  parentCallId?: string | null;
  usage?: AgentMessage['usage'];
  blocks: AgentMessage['blocks'];
}): RowRecord {
  return {
    type: 'message',
    message: {
      messageId: input.id,
      vendorId: null,
      role: input.role ?? 'assistant',
      source: input.source ?? 'wire',
      roundTrip: input.roundTrip,
      vendorTurn: null,
      step: null,
      parentCallId: input.parentCallId ?? null,
      subagentId: input.subagentId ?? null,
      chunk: 'snapshot',
      assembly: input.assembly ?? 'snapshot',
      mergeKey: input.mergeKey,
      /**
       * 消息级用量（2026-10-06）：**只有显式给才写这一格**——契约里它是可选的（老 `messages.jsonl`
       * 根本没有这个键），工厂若写成 `usage: input.usage ?? null`，那条「老日志 ⇒ UI 侧 null」的用例
       * 就永远考不到「键缺席」这一档（2026-10-06 变异验证实测：它会把变异 B 放过去）。
       */
      ...(input.usage === undefined ? {} : { usage: input.usage }),
      blocks: input.blocks,
      raw: null,
    },
  };
}

function subagent(id: string, overrides: Partial<Extract<RowRecord, { type: 'subagent' }>['subagent']> = {}): RowRecord {
  return {
    type: 'subagent',
    subagent: {
      subagentId: id,
      name: null,
      kind: 'spawn_agent',
      source: 'wire',
      status: 'completed',
      statusMissing: null,
      outcome: null,
      // 派生它的那次工具调用 id；默认 `null`（用例要显式给才成立）
      parentCallId: null,
      parentSubagentId: null,
      usage: null,
      ...overrides,
    },
  };
}

function facts(overrides: Partial<AgentLogFactsInput> = {}): AgentLogFactsInput {
  return {
    status: { tone: 'ok', label: '已评分' },
    startedAt: '2026-10-02T10:00:00.000Z',
    endedAt: '2026-10-02T10:03:00.000Z',
    turns: { current: 0, total: null },
    tokens: null,
    thinking: null,
    domain: [],
    error: null,
    live: false,
    ...overrides,
  };
}

/**
 * 造一条行级事件。
 * **必须过一层 `unknown`**：这里刻意只写用例关心的那几格，而 `AgentEvent` 是判别联合、
 * 每个成员都要求自己的必填格（如 `error.code`）——直接断言会被 TS 判成「两个类型不重叠」。
 */
function event(input: Record<string, unknown> & { seq: number; type: AgentEvent['type'] }): AgentEvent {
  return { at: '2026-10-02T10:00:00.000Z', ...input } as unknown as AgentEvent;
}

describe('buildAgentLogModel：合并与分组', () => {
  it('同一 `mergeKey` 的多次投递只留最后一条（覆盖，不是追加）', () => {
    const records: RowRecord[] = [
      message({ id: 'm1', mergeKey: 'main|1|assistant|-', roundTrip: 1, blocks: [{ type: 'text', text: '半截' }] }),
      message({ id: 'm2', mergeKey: 'main|1|assistant|-', roundTrip: 1, blocks: [{ type: 'text', text: '完整正文' }] }),
    ];
    const model = buildAgentLogModel({ records, events: [], facts: facts(), startedAt: '2026-10-02T10:00:00.000Z' });
    const main = model.nodes.find((node) => node.kind === 'main');
    if (main?.content.status !== 'ready') throw new Error('主会话内容应就绪');
    expect(main.content.data).toHaveLength(1);
    const first = main.content.data[0]?.blocks[0];
    expect(first?.kind === 'text' ? first.text : null).toBe('完整正文');
  });

  it('按 `roundTrip` 分轮并升序排列；`vendorTurn` 不参与分组', () => {
    const records: RowRecord[] = [
      message({ id: 'm2', mergeKey: 'main|2|assistant|-', roundTrip: 2, blocks: [{ type: 'text', text: '第二轮' }] }),
      message({ id: 'm1', mergeKey: 'main|1|assistant|-', roundTrip: 1, blocks: [{ type: 'text', text: '第一轮' }] }),
    ];
    const model = buildAgentLogModel({ records, events: [], facts: facts(), startedAt: '2026-10-02T10:00:00.000Z' });
    const main = model.nodes.find((node) => node.kind === 'main');
    if (main?.content.status !== 'ready') throw new Error('主会话内容应就绪');
    expect(main.content.data.map((turn) => turn.round)).toEqual([1, 2]);
    // 进度条的轮次与时间轴的轮次数**同源**：都是数据层给的统一 `round`
    expect(model.facts.turns.current).toBe(2);
  });

  it('`facts.turns` 的两个数由时间轴派生：`current` 同源、`total` 恒为 `null`', () => {
    const records: RowRecord[] = [
      message({ id: 'm1', mergeKey: 'main|1|assistant|-', roundTrip: 1, blocks: [{ type: 'text', text: '一' }] }),
      message({ id: 'm2', mergeKey: 'main|2|assistant|-', roundTrip: 2, blocks: [{ type: 'text', text: '二' }] }),
      message({ id: 'm3', mergeKey: 'main|3|assistant|-', roundTrip: 3, blocks: [{ type: 'text', text: '三' }] }),
    ];
    // 传进来的那一份**故意写成会自相矛盾的样子**（`total` 比实际轮次少）：它必须被忽略
    const model = buildAgentLogModel({
      records,
      events: [],
      facts: facts({ turns: { current: 1, total: 3 } }),
      startedAt: '2026-10-02T10:00:00.000Z',
    });
    // 进度条与时间轴护栏不许互相打脸（冒烟实测过 `轮次 4 / 3 轮` 与 `已渲染 4 / 共 4 轮` 同时上屏）
    expect(model.facts.turns).toEqual({ current: 3, total: null });
  });

  /**
   * 这一段**曾经被当成「➀ 的时间回填」**（走到调用消息时补 `messageId` / `at`）。
   *
   * 复核（2026-10-08）结论：它**不可达**，已成死代码——
   * `dispatchOf` 扫的与这里扫的是**同一张 `folded` 主会话表**，判据也一样（`callId` 逐字相同）：
   * `dispatchOf` 找得到 ⇒ 它返回的 `messageId` 就已经是这一条的 `messageId`，轮次也同源；
   * `dispatchOf` 找不到 ⇒ 这里也找不到，两个判据（`messageId === ''` / `at === ''`）都无从成立。
   * 故这里**没有**回归守卫可写——留着它只是因为删改要连带确认四条判据的先后，属另一次整理。
   * ⚠️ 别把这条当成「回填生效」的证据：下面这条用例改成 `at === ''` 判据也一样绿。
   */
  it('（已知死代码）派发调用块与 `dispatchOf` 扫同一张表，回填分支不可达', () => {
    const startedAt = '2026-10-02T10:00:00.000Z';
    const records: RowRecord[] = [
      message({ id: 'm-other', mergeKey: 'main|1|assistant|-', roundTrip: 1, blocks: [{ type: 'text', text: '先说话' }] }),
      message({
        id: 'm-dispatch',
        mergeKey: 'main|2|assistant|-',
        roundTrip: 2,
        blocks: [{ type: 'tool-call', callId: 'call_agent_1', family: 'spawn-agent', name: 'subagent', input: { description: '审查页面' } }],
      }),
      subagent('sub-1', { name: '审查页面', parentCallId: 'call_agent_1' }),
    ];
    const model = buildAgentLogModel({ records, events: [], facts: facts(), startedAt });
    const child = model.nodes.find((node) => node.kind === 'subagent');
    // 两点都是 `dispatchOf` 自己给的，与本用例无关的「回填」一步没有贡献
    expect(child?.spawnedBy?.callId).toBe('call_agent_1');
    expect(child?.spawnedBy?.messageId).toBe('m-dispatch');
    expect(child?.spawnedBy?.at).toBe(new Date(Date.parse(startedAt) + 2000).toISOString());
  });

  it('按 `subagentId` 把消息分给会话节点，子任务节点与主会话**同一份形状**', () => {
    const records: RowRecord[] = [
      message({ id: 'm1', mergeKey: 'main|1|assistant|-', roundTrip: 1, blocks: [{ type: 'text', text: '主会话正文' }] }),
      message({
        id: 'm2',
        mergeKey: 'sub|1|assistant|call_x',
        roundTrip: 1,
        subagentId: 'sub-1',
        parentCallId: 'call_x',
        blocks: [{ type: 'text', text: '子任务正文' }],
      }),
      subagent('sub-1', { name: '修测试', outcome: '修好了' }),
    ];
    const model = buildAgentLogModel({ records, events: [], facts: facts(), startedAt: '2026-10-02T10:00:00.000Z' });
    expect(model.nodes).toHaveLength(2);
    const child = model.nodes.find((node) => node.kind === 'subagent');
    if (child?.content.status !== 'ready') throw new Error('子任务内容应就绪');
    expect(child.content.data).toHaveLength(1);
    // 派发点由 `parentCallId` 派生（subagent 是与消息平级的独立事件，靠它定位）
    expect(child.spawnedBy?.callId).toBe('call_x');
    expect(model.activeNodeId).toBe('main');
  });

  /**
   * **两套 id 的对接**（2026-10-03 真机实测的缺陷）：同一条子任务在**记录**上叫厂商原生 id，
   * 在**消息**上却挂在「派生它的那次工具调用 id」上。不做这层解析时，按 `subagentId` 分桶
   * 会让子任务的消息全部落空——点进去显示「没有逐条对话记录」，而消息就在文件里
   * （真机：20 条消息、0 条被认领）。
   */
  it('消息挂的是「派发调用的 id」、记录挂的是「子任务身份」时，仍归到同一个子任务节点', () => {
    const records: RowRecord[] = [
      // 记录：身份是原生 id，`parentCallId` 是派生它的那次调用
      subagent('task-9f2a', { name: '审查页面', parentCallId: 'call_agent_1' }),
      // 主会话里那次派发调用（派发点要落在这一轮上）
      message({
        id: 'm0',
        mergeKey: 'main|1|assistant|-',
        roundTrip: 1,
        blocks: [{ type: 'tool-call', callId: 'call_agent_1', family: 'spawn-agent', name: 'Agent', input: { description: '审查页面' } }],
      }),
      // 子任务自己的消息：`subagentId` 是**调用 id**（不是 `task-9f2a`）
      message({
        id: 'm1',
        mergeKey: 'call_agent_1|2|assistant|-',
        roundTrip: 2,
        subagentId: 'call_agent_1',
        blocks: [{ type: 'text', text: '子智能体的答复' }],
      }),
    ];
    const model = buildAgentLogModel({ records, events: [], facts: facts(), startedAt: '2026-10-02T10:00:00.000Z' });

    const child = model.nodes.find((node) => node.kind === 'subagent');
    if (child?.content.status !== 'ready') throw new Error('子任务内容应就绪');
    // ① 消息归到了子任务节点上（别名解析），而不是掉进主会话或被丢掉
    expect(child.content.data.flatMap((turn) => turn.blocks)).toHaveLength(1);
    // ② 派发点来自记录自己带的 `parentCallId`，且落在主会话那一轮上
    expect(child.spawnedBy?.callId).toBe('call_agent_1');
    expect(child.spawnedBy?.messageId).toBe('m0');

    const main = model.nodes.find((node) => node.kind === 'main');
    if (main?.content.status !== 'ready') throw new Error('主会话内容应就绪');
    // ③ 子任务的消息**没有**混进主会话
    expect(main.content.data.flatMap((turn) => turn.blocks)).toHaveLength(1);
    expect(main.content.data.flatMap((turn) => turn.blocks)[0]).toMatchObject({ kind: 'tool-call', callId: 'call_agent_1' });
  });

  /**
   * **派发点只认「派发那一次」**（2026-10-03 真机实测的坑）。
   *
   * codex 在同一条子任务上会连续投递**多条**协作调用记录（`spawn_agent` → `wait` → `close_agent`），
   * 每条都带同一个 `subagentId`。若不分动作、先到先得，认领的就可能是 `wait` / `close_agent`
   * ⇒ 时间轴上的「进入子任务」入口挂到「收场」那一步上（点得到，但位置是错的）。
   *
   * ⚠️ 夹具里**消息**的顺序必须是 `spawn` 在前、`close` 在后：`dispatchOf` 找不到那次调用所在的消息时
   * 会退回一个「只有 callId、没有 messageId」的派发点，那样写用例就测不到「谁认领」这件事
   * （认领错了也一样能过）。两侧消息都在，才是在考「认领判据」本身。
   */
  it('多条协作记录时，派发点认的是 `spawn_agent` 而不是 `close_agent`', () => {
    const records: RowRecord[] = [
      message({
        id: 'm-spawn',
        mergeKey: 'main|1|assistant|-',
        roundTrip: 1,
        blocks: [{ type: 'tool-call', callId: 'item_spawn', family: null, name: 'spawn_agent', input: { prompt: '审查页面' } }],
      }),
      message({
        id: 'm-close',
        mergeKey: 'main|2|assistant|-',
        roundTrip: 2,
        blocks: [{ type: 'tool-call', callId: 'item_close', family: null, name: 'close_agent', input: {} }],
      }),
      // 记录**乱序投递**：收场那条排在派发那条前面
      subagent('thread-1', { name: '审查页面', kind: 'close_agent', parentCallId: 'item_close' }),
      subagent('thread-1', { name: '审查页面', kind: 'spawn_agent', parentCallId: 'item_spawn' }),
    ];
    const model = buildAgentLogModel({ records, events: [], facts: facts(), startedAt: '2026-10-02T10:00:00.000Z' });

    const child = model.nodes.find((node) => node.kind === 'subagent');
    // 入口落在派发那一轮上，而不是收场那一轮
    expect(child?.spawnedBy?.callId).toBe('item_spawn');
    expect(child?.spawnedBy?.messageId).toBe('m-spawn');
  });

  it('`running` 只在 `facts.live` 且是**最后一轮**时为真', () => {
    const records: RowRecord[] = [
      message({ id: 'm1', mergeKey: 'main|1|assistant|-', roundTrip: 1, blocks: [{ type: 'text', text: '一' }] }),
      message({ id: 'm2', mergeKey: 'main|2|assistant|-', roundTrip: 2, assembly: 'open', blocks: [{ type: 'text', text: '二' }] }),
    ];
    const live = buildAgentLogModel({ records, events: [], facts: facts({ live: true, endedAt: null }), startedAt: '2026-10-02T10:00:00.000Z' });
    const mainLive = live.nodes.find((node) => node.kind === 'main');
    if (mainLive?.content.status !== 'ready') throw new Error('内容应就绪');
    expect(mainLive.content.data.map((turn) => turn.running)).toEqual([false, true]);

    // 一次**被中断**的回复：`live === false` ⇒ 每一轮都不是「还在流」，动效必须停
    const ended = buildAgentLogModel({ records, events: [], facts: facts({ live: false }), startedAt: '2026-10-02T10:00:00.000Z' });
    const mainEnded = ended.nodes.find((node) => node.kind === 'main');
    if (mainEnded?.content.status !== 'ready') throw new Error('内容应就绪');
    expect(mainEnded.content.data.map((turn) => turn.running)).toEqual([false, false]);
  });

  it('子任务的 `status`/`statusMissing` 分开记（「未收场」不会被说成「运行中」）', () => {    const records: RowRecord[] = [subagent('sub-1', { status: 'unknown', statusMissing: 'not-observed' })];
    const model = buildAgentLogModel({ records, events: [], facts: facts(), startedAt: null });
    const child = model.nodes.find((node) => node.kind === 'subagent');
    expect(child?.status).toBe('unknown');
    expect(child?.statusMissing).toBe('not-observed');
  });

  it('主会话节点的 `sessionFacts` 为 `null`（行级事实不存第二份真值）', () => {
    const model = buildAgentLogModel({ records: [], events: [], facts: facts(), startedAt: null });
    const main = model.nodes.find((node) => node.kind === 'main');
    expect(main?.kind === 'main' ? main.sessionFacts : 'unexpected').toBeNull();
  });

  it('没有任何内容时 `empty === true`（决定显示空态，而不是空时间轴）', () => {
    const model = buildAgentLogModel({ records: [], events: [], facts: facts(), startedAt: null });
    expect(model.empty).toBe(true);
  });
});

describe('buildAgentLogModel：能力声明与载荷', () => {
  it('契约的扁平能力声明被摊成三元组字典（`toCapabilityMap` 的唯一搬运点）', () => {
    const records: RowRecord[] = [message({ id: 'm1', mergeKey: 'main|1|assistant|-', roundTrip: 1, blocks: [{ type: 'text', text: 'x' }] })];
    const model = buildAgentLogModel({
      records,
      events: [],
      facts: facts(),
      startedAt: null,
      capability: {
        thinkingText: { level: 'not-projected-by-vendor', source: null, reason: 'not-exposed' },
        toolInput: { level: 'yes', source: 'wire', reason: null },
      },
      capabilityNotes: ['多智能体随路由变化'],
    });
    const main = model.nodes.find((node) => node.kind === 'main');
    expect(main?.capability.thinkingText).toEqual({ level: 'not-projected-by-vendor', source: null, reason: 'not-exposed' });
    expect(main?.capability.toolInput).toEqual({ level: 'yes', source: 'wire', reason: null });
    expect(main?.capabilityNotes).toEqual(['多智能体随路由变化']);
  });

  it('不给能力声明时全套记「没验证过」——**不替厂商下结论**', () => {
    const model = buildAgentLogModel({ records: [], events: [], facts: facts(), startedAt: null });
    const main = model.nodes.find((node) => node.kind === 'main');
    expect(main?.capability.toolResult?.level).toBe('unverified');
    expect(main?.capability.toolResult?.reason).toBe('unverified');
  });

  /**
   * 族载荷**直接来自契约的 `payload`**（2026-10-04 收口）。
   *
   * 这一条盯的是「界面只搬运、不归一」：块的 `input` 里照旧带着**厂商原文**（排障用），
   * 而界面要画的那张卡片完全由 `payload` 决定。旧实现是反过来——它读 `input.todos` /
   * `input.questions` 自己拼，于是「厂商改一个字段名」等于界面上静默少一张卡片。
   */
  it('`task` / `ask-user` 载荷取自契约的 `payload`（不再读厂商原文）；`running` 由轮次给', () => {
    const records: RowRecord[] = [
      message({
        id: 'm1',
        mergeKey: 'main|1|assistant|-',
        roundTrip: 1,
        blocks: [
          {
            type: 'tool-call',
            callId: 'c1',
            family: 'task',
            name: 'todo_write',
            // 厂商原文照旧带着：它是排障证据，但**不是**界面据以渲染的东西
            input: { todos: [{ content: 'a', status: 'completed' }, { content: 'b' }] },
            payload: {
              kind: 'plan',
              note: '按依赖顺序',
              steps: [
                { id: null, subject: 'a', status: 'completed', owner: null, blockedBy: null },
                { id: null, subject: 'b', status: 'unknown', owner: null, blockedBy: null },
              ],
            },
          },
          {
            type: 'tool-call',
            callId: 'c2',
            family: 'ask-user',
            name: 'ask_user_question',
            input: { questions: [{ question: '发哪？' }] },
            payload: {
              kind: 'ask-user',
              questions: [
                {
                  header: '范围',
                  prompt: '发哪？',
                  options: [{ label: '预发', description: null, recommended: true }],
                  multiSelect: false,
                  allowOther: true,
                  secret: false,
                },
              ],
            },
          },
        ],
      }),
    ];
    const model = buildAgentLogModel({ records, events: [], facts: facts({ live: true, endedAt: null }), startedAt: null });
    const main = model.nodes.find((node) => node.kind === 'main');
    if (main?.content.status !== 'ready') throw new Error('内容应就绪');
    const blocks = main.content.data[0]?.blocks ?? [];
    const task = blocks[0];
    const ask = blocks[1];
    if (task?.kind !== 'tool-call' || task.tool === null || task.tool.family !== 'task') throw new Error('应为 task 载荷');
    // 计数四格齐全（`unknown` 是第四格）：它是**从 steps 数出来的**，不是厂商给的
    expect(task.tool.panel.counts).toEqual({ pending: 0, inProgress: 0, completed: 1, unknown: 1 });
    // `note` 原样透出（codex 的 explanation）
    expect(task.tool.panel.note).toBe('按依赖顺序');
    expect(task.tool.panel.running).toBe(true);
    if (ask?.kind !== 'tool-call' || ask.tool === null || ask.tool.family !== 'ask-user') throw new Error('应为 ask-user 载荷');
    expect(ask.tool.interaction).toMatchObject({ state: 'pending', running: true });
    /**
     * 这个用例**没有** `startedAt`，故 `atOfRound` 按设计给空串（见它的实现）。
     * 「有 `startedAt` 时 `at` 必须是真实时刻」那条守卫落在下一个用例里——
     * 那里才是它要防的场景（空串会让「等待了多久」塌成 `0s`）。
     */
    expect(ask.tool.interaction.at).toBe('');
    // 问题的正文与选项逐格来自 `payload`（`question` → `prompt` 的换算已经在上游做完）
    expect(ask.tool.interaction.questions).toEqual([
      {
        header: '范围',
        prompt: '发哪？',
        options: [{ label: '预发', description: null, recommended: true }],
        multiSelect: false,
        allowOther: true,
        secret: false,
      },
    ]);
  });

  /**
   * 回归守卫（2026-10-08 修）：「等了多久」这一格必须是**真实时刻**。
   *
   * 两处读同一个 `interaction.at`：卡片标题上的「等待答复中… 12m」与固定区那枚「等待答复」徽标
   * （`agent-log-layout.tsx` 的 `waitingSinceOf` 扫的正是 `LogTurn.blocks[].tool.interaction.at`）。
   * 装配层一度把它写死成空串 ⇒ `Date.parse('')` 得 NaN、`formatDuration` 回落 `'0s'`，
   * 固定区恒显「等待答复 0s」且永不涨：一次**长等待被读成「刚问完」**。
   * 判据落在装配层（`familyPayloadOf` 收下块的时刻），所以卡片与徽标**同时**修好——
   * 只在渲染层补会漏掉徽标那一半。
   */
  it('`ask-user` / `task` 的 `at` 取块的时刻（不是空串）——「等待了多久」两处共用这一格', () => {
    const startedAt = '2026-10-02T10:00:00.000Z';
    const ask = (callId: string): RowRecord =>
      message({
        id: `m-${callId}`,
        mergeKey: 'main|1|assistant|-',
        roundTrip: 1,
        blocks: [
          {
            type: 'tool-call',
            callId,
            family: 'ask-user',
            name: 'ask_user_question',
            input: { questions: [{ question: '发哪？' }] },
            payload: { kind: 'ask-user', questions: [{ header: '', prompt: '发哪？', options: [], multiSelect: false, allowOther: false, secret: false }] },
          },
        ],
      });
    const model = buildAgentLogModel({ records: [ask('c1')], events: [], facts: facts({ live: true, endedAt: null }), startedAt });
    const main = model.nodes.find((node) => node.kind === 'main');
    if (main?.content.status !== 'ready') throw new Error('内容应就绪');
    const block = main.content.data[0]?.blocks[0];
    if (block?.kind !== 'tool-call' || block.tool === null || block.tool.family !== 'ask-user') {
      throw new Error('应为 ask-user 载荷');
    }
    expect(block.tool.interaction.at).not.toBe('');
    expect(Number.isFinite(Date.parse(block.tool.interaction.at))).toBe(true);
    // 与块的时刻同源（`roundTrip: 1` ⇒ base + 1s）
    expect(block.tool.interaction.at).toBe(new Date(Date.parse(startedAt) + 1000).toISOString());
  });

  /**
   * **界面不认厂商形状**（2026-10-04 收口的那条边界）。
   *
   * 喂一份**逐字真机**的厂商入参（`todos[]` / `questions[]` 都在），而 `payload` 为 `null` ⇒
   * 必须**不出卡片**、回退成通用工具行。旧实现会在这里认出 `todos` 并把面板画出来——
   * 于是「归一」这件事就有了两份实现（agents 一份、界面一份），而漂移的表现是
   * 「同一族的卡片在某一家上是空的」。回归的方式是把嗅探搬回 `build-model.ts`，那时这条会红。
   *
   * 同时钉住另一半：**族名照给**（`payload: null` ≠ 「不认识的族」），调用不会从界面上消失。
   */
  it('只有厂商原文、`payload` 为 null ⇒ 不出卡片（族名照给，回退通用工具行）', () => {
    const records: RowRecord[] = [
      message({
        id: 'm1',
        mergeKey: 'main|1|assistant|-',
        roundTrip: 1,
        blocks: [
          { type: 'tool-call', callId: 'c1', family: 'task', name: 'todo_write', input: { todos: [{ content: 'a', status: 'completed' }] }, payload: null },
          { type: 'tool-call', callId: 'c2', family: 'ask-user', name: 'ask_user_question', input: { questions: [{ question: '发哪？' }] }, payload: null },
        ],
      }),
    ];
    const model = buildAgentLogModel({ records, events: [], facts: facts(), startedAt: null });
    const main = model.nodes.find((node) => node.kind === 'main');
    if (main?.content.status !== 'ready') throw new Error('内容应就绪');
    const blocks = main.content.data[0]?.blocks ?? [];

    for (const block of blocks) {
      if (block.kind !== 'tool-call') throw new Error('应为工具调用');
      // 族名原样透传（界面据它做过滤），而载荷为 null ⇒ `render-blocks` 会把它并进工具组
      expect(block.family === 'task' || block.family === 'ask-user').toBe(true);
      expect(block.tool).toBeNull();
    }
  });

  it('工具结果为错误时 `status` 是 `error`；截断三态**照契约带出**', () => {
    const records: RowRecord[] = [
      message({
        id: 'm1',
        mergeKey: 'main|1|assistant|-',
        roundTrip: 1,
        blocks: [
          { type: 'tool-result', callId: 'c1', structured: null, isError: true, text: 'boom', truncation: { kind: 'unknown' } },
          { type: 'tool-result', callId: 'c2', structured: null, isError: false, text: 'ok', truncation: { kind: 'truncated', reason: '超过 256 KB' } },
        ],
      }),
    ];
    const model = buildAgentLogModel({ records, events: [], facts: facts(), startedAt: null });
    const main = model.nodes.find((node) => node.kind === 'main');
    if (main?.content.status !== 'ready') throw new Error('内容应就绪');
    const blocks = main.content.data[0]?.blocks ?? [];
    const failed = blocks[0];
    const clipped = blocks[1];
    expect(failed?.kind === 'tool-result' ? failed.status : null).toBe('error');
    // 「没采到截断标记」原样保留 —— 它**不等于**「确认完整」
    expect(failed?.kind === 'tool-result' ? failed.truncation : null).toEqual({ kind: 'unknown' });
    expect(clipped?.kind === 'tool-result' ? clipped.truncation : null).toEqual({ kind: 'truncated', reason: '超过 256 KB' });
  });
});

describe('行级事件的去向', () => {
  /**
   * 三条去向判据（2026-10-07 口径变更后）：`error` **逐条**进（失败归因不能只剩一条）；
   * `usage` **整行只出最后一条候选读数**；`log` 不进时间轴（它走 `diagnosticsOf` 的原文面板）。
   *
   * 「只出最后一条」是要钉的靶子：水位那一版会出三条（10 / 30 / 40 各一条），而真机症状正是
   * 「同一行串出一长串几乎一样的用量行」。位置也要对：用量那一行落在**它自己那一条事件**的位置上，
   * 不许被挤到末尾（`error` 行之后）。
   */
  it('`error` 逐条进时间轴；`usage` 整行只出最后一条候选读数；`log` 不进时间轴', () => {
    const events: AgentEvent[] = [
      event({ seq: 1, type: 'log', stream: 'stdout', text: '一条原文' }),
      event({ seq: 2, type: 'usage', tokens: { input: 10, cached: 0, output: 0, reasoningOutput: null, total: null }, turns: 1, timing: null }),
      event({ seq: 3, type: 'usage', tokens: { input: 5, cached: 0, output: 0, reasoningOutput: null, total: null }, turns: 1, timing: null }),
      event({ seq: 4, type: 'usage', tokens: { input: 30, cached: 0, output: 0, reasoningOutput: null, total: null }, turns: 2, timing: null }),
      event({ seq: 5, type: 'error', code: 'AGENT_FAILED', message: '失败了' }),
      // 候选阶段里最后一条读数（它排在错误之后 ⇒ 它那一行也必须排在错误行之后）
      event({ seq: 6, type: 'usage', tokens: { input: 40, cached: 0, output: 0, reasoningOutput: null, total: null }, turns: 3, timing: null }),
    ];
    const rows = rowEventsOf(events);
    expect(rows.map((row) => row.level)).toEqual(['error', 'milestone']);
    expect(rows[1]?.text).toBe('用量 输入 40 tok · 缓存 0 tok · 输出 0 tok · 轮次 3');

    // 反向：那一条用量**排在错误之前**时同样不许被挪到末尾（按事件次序，不是「一律追加」）
    const earlier = rowEventsOf([
      event({ seq: 1, type: 'usage', tokens: { input: 40, cached: 0, output: 0, reasoningOutput: null, total: null }, turns: 1, timing: null }),
      event({ seq: 2, type: 'error', code: 'AGENT_FAILED', message: '之后报的失败' }),
    ]);
    expect(earlier.map((row) => row.level)).toEqual(['milestone', 'error']);
  });

  it('`diagnosticsOf` 逐字保留原文，并把 `summary` 与 `text` **两格都给**', () => {
    const diagnostics = diagnosticsOf([
      event({ seq: 1, type: 'log', stream: 'stdout', text: '{"raw":1}', summary: '收到一条未识别的厂商事件' }),
      event({ seq: 2, type: 'log', stream: 'stderr', text: '[WARN] 用量负载不完整' }),
    ]);
    expect(diagnostics.lines).toHaveLength(2);
    // 有 `summary` 时它优先渲染，但 `text` 原文**仍然在**（不许拿一个顶替另一个）
    expect(diagnostics.lines[0]).toEqual({ at: '2026-10-02T10:00:00.000Z', source: 'stdout', text: '{"raw":1}', summary: '收到一条未识别的厂商事件' });
    expect(diagnostics.lines[1]?.summary).toBeNull();
    expect(diagnostics.truncatedReason).toBeNull();
  });

  /**
   * 归属（2026-10-05，spec §2.4；2026-10-07 起整行只剩这一条）：那一条带上归属键，文案里的轮次号用
   * **归属号**（不再是本行累计号——否则文字与它所在的分组对不上）；归属轮次整行都不存在时抹成 `null`
   * （落到时间轴上按时刻归位，**不丢**）。
   */
  it('那一条带归属键、文案用归属号；归属轮次整行不存在时抹成 `null`', () => {
    /** 归属轮次真有 ⇒ 原样带出，文案用归属号（它的 `turns` 是 4，文案给的是归属的 2） */
    const attributed = rowEventsOf(
      [
        event({ seq: 1, type: 'usage', tokens: { input: 10, cached: 0, output: 0, reasoningOutput: null, total: null }, turns: 4, timing: null, turn: { subagentId: null, round: 2 } }),
      ],
      new Set(['main#2']),
    );
    expect(attributed).toHaveLength(1);
    expect(attributed[0]?.turn).toEqual({ subagentId: null, round: 2 });
    expect(attributed[0]?.text).toContain('轮次 2');

    /** 孤儿：最后那一条引用了一个整行都没有的轮次（第 9 轮）⇒ 归属抹成 `null`、文案退回本行累计号 */
    const orphan = rowEventsOf(
      [
        event({ seq: 1, type: 'usage', tokens: { input: 10, cached: 0, output: 0, reasoningOutput: null, total: null }, turns: 4, timing: null, turn: { subagentId: null, round: 2 } }),
        // 老日志：没有归属格
        event({ seq: 2, type: 'usage', tokens: { input: 30, cached: 0, output: 0, reasoningOutput: null, total: null }, turns: 5, timing: null }),
        event({ seq: 3, type: 'usage', tokens: { input: 60, cached: 0, output: 0, reasoningOutput: null, total: null }, turns: 6, timing: null, turn: { subagentId: null, round: 9 } }),
      ],
      new Set(['main#2']),
    );
    expect(orphan).toHaveLength(1);
    expect(orphan[0]?.turn).toBeNull();
    expect(orphan[0]?.text).toContain('轮次 6');
  });

  /**
   * **整链接线**（2026-10-05）：上面那条纯函数用例把 `homes` 直接喂给了 `rowEventsOf`，
   * 于是它拦不住接线的两处静默降级——
   *   · `build-model.ts` 的调用点是否真的把 `turnHomesOf(allNodes)` 传了进去
   *     （退回 `rowEventsOf(input.events)` ⇒ 整行里程碑全变孤儿，界面退回「按时刻」，本需求的可观测效果归零）；
   *   · `turnHomesOf` 本身是否真的从节点轮次里收出了那一格（`return new Set()` 同样让归属全灭）。
   * 两处都**不会**让任何别的用例变红，所以这条必须走 `buildAgentLogModel` 的真入口：
   * `records` 给一条主会话第 1 轮（`roundTrip: 1`）的消息 ⇒ `(null, 1)` 真的有归属，
   * 那条 `usage` 的归属键必须被**原样认下**，而不是抹成 `null`。
   */
  it('整链接线：主会话真有那一轮时，`usage` 的归属键被认下并原样带出（不是孤儿）', () => {
    const model = buildAgentLogModel({
      records: [
        message({ id: 'm1', mergeKey: 'main|1|assistant|-', roundTrip: 1, blocks: [{ type: 'text', text: '第一轮' }] }),
      ],
      events: [
        event({
          seq: 1,
          type: 'usage',
          tokens: { input: 10, cached: 0, output: 0, reasoningOutput: null, total: null },
          turns: 1,
          timing: null,
          turn: { subagentId: null, round: 1 },
        }),
      ],
      facts: facts(),
      startedAt: '2026-10-02T10:00:00.000Z',
    });

    // 前提：主会话节点真有第 1 轮——否则这条用例会因为「夹具造错了」而红，看起来却像接线坏了
    const main = model.nodes.find((node) => node.kind === 'main');
    if (main?.content.status !== 'ready') throw new Error('主会话内容应就绪');
    expect(main.content.data.map((turn) => turn.round)).toEqual([1]);

    expect(model.rowEvents).toHaveLength(1);
    expect(model.rowEvents[0]?.turn).toEqual({ subagentId: null, round: 1 });
  });

  /**
   * **可达的子会话节点同样不出行**（2026-10-07 口径变更后，这一格守的是「不出行与可达性无关」）。
   *
   * 这条用例原来的判据是反过来的：dsh / codex 的子会话用量里程碑当时是**真实且可见的主路径**
   * （真机 run 里子节点 round 1/2 就渲染出来了），归属键带的是**非空** `subagentId`，所以它专门盯
   * 「子会话的身份能不能被认下」。用户裁定「子智能体用量只在派发点那张子任务卡片里展示」之后，
   * 折行这一层对子会话读数的处置变成**一条都不出**；于是这一格要守的是：不出行**不是因为**节点不可达
   * （那会让人以为「把节点接通就好了」），而是这一类读数根本不进折行。
   */
  it('可达的子会话节点（真有那一轮、读数带 `subagentId`）照样一条都不出', () => {
    const model = buildAgentLogModel({
      records: [
        // 主会话里那次派发调用：子节点靠它才有「子任务占位条」这个入口（`spawnedBy` 因此非空）
        message({
          id: 'm0',
          mergeKey: 'main|1|assistant|-',
          roundTrip: 1,
          blocks: [{ type: 'tool-call', callId: 'call_sub', family: 'spawn-agent', name: 'spawn_agent', input: { description: '审查页面' } }],
        }),
        message({
          id: 'm1',
          mergeKey: 'sub-1|1|assistant|-',
          roundTrip: 1,
          subagentId: 'sub-1',
          blocks: [{ type: 'text', text: '子会话第一轮' }],
        }),
        subagent('sub-1', { name: '审查页面', parentCallId: 'call_sub' }),
      ],
      events: [
        event({
          seq: 1,
          type: 'usage',
          // `tokens` 必须非 `null`：`rowEventsOf` 对「没有计量」的 usage 直接跳过（拿不到数就不出里程碑），
          // 那样这条用例就不是在考「子会话读数出不出行」了
          tokens: { input: 10, cached: 0, output: 0, reasoningOutput: null, total: null },
          turns: 1,
          timing: null,
          turn: { subagentId: 'sub-1', round: 1 },
        }),
      ],
      facts: facts(),
      startedAt: '2026-10-02T10:00:00.000Z',
    });

    // 前提①：子会话节点真有第 1 轮；前提②：它真的可达——两条不成立就是夹具造错了，
    // 而不是接线坏了（否则这条用例会以「像接线坏了」的样子红）
    const child = model.nodes.find((node) => node.kind === 'subagent');
    if (child?.content.status !== 'ready') throw new Error('子会话内容应就绪');
    expect(child.content.data.map((turn) => turn.round)).toEqual([1]);
    expect(child.spawnedBy?.callId).toBe('call_sub');

    expect(model.rowEvents).toEqual([]);
  });

  /**
   * **子会话的用量读数不成行**（2026-10-07 用户裁定：子智能体用量只在派发点那张子任务卡片里展示）。
   *
   * 这条用例原来钉的是「不可达子节点不算有家」（2026-10-05 终审 Important 1）——那是为**子会话里程碑**
   * 服务的：四条派发判据都没命中的子任务节点进不去（`spawnedBy === null`），若仍认它作有家，那一条读数
   * 两处都落空。口径改成「子会话读数一条都不出」之后，那一类读数**根本不进折行**，那条判据随之退役；
   * 这里改钉两件事：① 子会话的读数一条都不出；② 子任务卡片那一格的数据源**没被顺手删掉**
   * （`SessionNode.usage` 来自 `SubagentRecord.usage`，与事件流无关）。
   */
  it('子会话的用量读数不成行（一条都不出）；子任务卡片自己的用量格仍有值', () => {
    const model = buildAgentLogModel({
      records: [
        // 子任务记录没有 `parentCallId`，主会话里也没有任何派发调用 ⇒ 四条判据都命不中
        subagent('sub-1', { name: '审查页面', usage: { input: 40, cached: 10, output: 5 } }),
        message({
          id: 'm1',
          mergeKey: 'sub-1|1|assistant|-',
          roundTrip: 1,
          subagentId: 'sub-1',
          blocks: [{ type: 'text', text: '子会话第一轮' }],
        }),
      ],
      events: [
        event({
          seq: 1,
          type: 'usage',
          tokens: { input: 10, cached: 0, output: 0, reasoningOutput: null, total: null },
          turns: 7,
          timing: null,
          turn: { subagentId: 'sub-1', round: 1 },
        }),
      ],
      facts: facts(),
      startedAt: '2026-10-02T10:00:00.000Z',
    });

    // 前提：那一条读数**确实指向一个真实存在的轮次**（否则「不出行」可能只是因为整行没有那一轮）
    const child = model.nodes.find((node) => node.kind === 'subagent');
    // `kind` 是判别格：判它一次，`child` 才收窄到 `SessionNode`（`usage` 只在那个成员上）
    if (child?.kind !== 'subagent' || child.content.status !== 'ready') throw new Error('子会话内容应就绪');
    expect(child.content.data.map((turn) => turn.round)).toEqual([1]);

    expect(model.rowEvents).toEqual([]);
    // 子任务卡片那一格原样还在：折行口径改了，卡片的数据源一格都不许跟着动
    expect(child.usage).toEqual({ input: 40, cached: 10, output: 5 });
  });
});

/**
 * 用量里程碑：**整行一条**（2026-10-07 用户裁定）。
 *
 * 口径变更的由来（真机 run `8df6ff65` 的 claude-code 行）：`usage` 事件是**每次模型往返**一条、带的是
 * 「到目前为止」的累计值，而界面按「累计创新高就出一条」折行 ⇒ 同一行出 5 条（轮次 1/2/3/4/4），
 * 其中同一轮先出跑动期估算（`输出 0`）、一秒后再出厂商结算值，屏幕上就是两条几乎一样的
 * 「用量 … 轮次 4」。新口径：**只取候选阶段里最后一条主会话读数**，整行一条。
 *
 * 2026-10-05 那一套「水位」判据（整行一个 → 按会话分桶）随之整体退役——它服务的就是「逐轮各出一条」；
 * 子会话那一条现在**根本不进折行**（用户口径：子智能体用量只在派发点那张子任务卡片里展示）。
 */
describe('用量里程碑：整行一条（2026-10-07）', () => {
  /** 造一条用量事件；`turn` 不给就是**老日志**（改动前落盘的事件没有这一格） */
  const usage = (
    seq: number,
    tokens: { input: number; cached?: number; output?: number },
    options: { turns?: number; turn?: { subagentId: string | null; round: number } } = {},
  ): AgentEvent =>
    event({
      seq,
      at: `2026-10-02T10:00:${String(seq).padStart(2, '0')}.000Z`,
      type: 'usage',
      tokens: { input: tokens.input, cached: tokens.cached ?? 0, output: tokens.output ?? 0, reasoningOutput: null, total: null },
      turns: options.turns ?? seq,
      timing: null,
      ...(options.turn === undefined ? {} : { turn: options.turn }),
    });

  /** 造一条行状态帧（候选阶段的边界只认 `judging` 与终态，与 `row-live.ts` 的 `candidateEnded` 同一条判据） */
  const status = (seq: number, value: 'running' | 'judging' | 'judged' | 'failed'): AgentEvent =>
    event({ seq, at: `2026-10-02T10:00:${String(seq).padStart(2, '0')}.000Z`, type: 'status', status: value });

  /**
   * **真机形状的回归钉**（run `8df6ff65` 的 claude-code 行）：同一轮先来跑动期估算（`输出 0`——wire 上的
   * `output_tokens` 在流式期恒 0）、一秒后再来厂商结算值（`input` / `cached` 逐字相同、`output` 才补上）。
   * 旧口径下这一对会在同一轮画两行；新口径下**整行只剩最后那一条**（结算值）。
   */
  it('候选阶段多条读数 ⇒ 恰一条，取最后那条（值、归属、文案都用它）', () => {
    const rows = rowEventsOf(
      [
        usage(1, { input: 14308 }, { turn: { subagentId: null, round: 1 } }),
        usage(2, { input: 14449, cached: 14464 }, { turn: { subagentId: null, round: 2 } }),
        usage(3, { input: 15763, cached: 45824 }, { turn: { subagentId: null, round: 4 } }),
        usage(4, { input: 15763, cached: 45824, output: 2164 }, { turn: { subagentId: null, round: 4 } }),
      ],
      new Set(['main#1', 'main#2', 'main#4']),
    );

    expect(rows.map((row) => row.text)).toEqual(['用量 输入 15,763 tok · 缓存 45,824 tok · 输出 2,164 tok · 轮次 4']);
    expect(rows[0]?.turn).toEqual({ subagentId: null, round: 4 });
  });

  it('子会话的读数一条都不出（子智能体用量只在派发点那张子任务卡片里）', () => {
    const mixed = rowEventsOf(
      [
        usage(1, { input: 50000 }, { turn: { subagentId: null, round: 1 } }),
        usage(2, { input: 1000 }, { turn: { subagentId: 'sub-1', round: 1 } }),
        usage(3, { input: 3000 }, { turn: { subagentId: 'sub-1', round: 2 } }),
      ],
      new Set(['main#1', 'sub-1#1', 'sub-1#2']),
    );
    // 子会话那两条读数更高也不许顶替主会话那一条：它们不属于这一行
    expect(mixed.map((row) => row.text)).toEqual(['用量 输入 50,000 tok · 缓存 0 tok · 输出 0 tok · 轮次 1']);

    // 整行只有子会话报过读数 ⇒ **一条都不出**（不是退回空值、更不是编一条 0）
    expect(rowEventsOf([usage(1, { input: 10 }, { turn: { subagentId: 'sub-1', round: 1 } })], new Set(['sub-1#1']))).toEqual([]);
  });

  /**
   * **候选阶段之后的读数不属于这一行**（真机形状：候选跑完 → 评分智能体在同一条流里接着报用量，
   * 轮次从 1 重新数、token 只有候选的零头）。只看「最后一条」会把这一行的读数换成评审者的。
   */
  it('`judging` 与终态帧之后报的读数一条都不出（那是评分智能体的用量）', () => {
    const afterJudging = rowEventsOf(
      [
        usage(1, { input: 42315, cached: 165376, output: 13607 }, { turn: { subagentId: null, round: 4 } }),
        status(2, 'judging'),
        usage(3, { input: 1280, cached: 7424, output: 125 }, { turn: { subagentId: null, round: 1 } }),
      ],
      new Set(['main#1', 'main#4']),
    );
    expect(afterJudging.map((row) => row.text)).toEqual(['用量 输入 42,315 tok · 缓存 165,376 tok · 输出 13,607 tok · 轮次 4']);

    // 终态帧同样关闸（候选失败、几十分钟后又被「重新评分」那种形状：第一条 `judging` 来得很晚）
    const afterTerminal = rowEventsOf(
      [
        usage(1, { input: 100 }, { turn: { subagentId: null, round: 1 } }),
        status(2, 'failed'),
        usage(3, { input: 999 }, { turn: { subagentId: null, round: 1 } }),
      ],
      new Set(['main#1']),
    );
    expect(afterTerminal.map((row) => row.text)).toEqual(['用量 输入 100 tok · 缓存 0 tok · 输出 0 tok · 轮次 1']);
  });

  /**
   * **老日志照样出一条**（这里刻意连状态帧都不给：历史行可能既没有归属格、也没有终态帧）。
   *
   * 递增进、与上一条相等、比上一条低——三种形状现在**都无所谓**（水位已退役），取的是最后那一条；
   * 夹在中间的 `error` **恒进**，且顺序按事件次序（用量那一行落在它自己那一条的位置上）。
   */
  const legacyEvents = (): AgentEvent[] => [
    usage(1, { input: 10 }),
    usage(2, { input: 10 }),
    usage(3, { input: 5 }),
    usage(4, { input: 30 }),
    usage(5, { input: 20, cached: 10 }),
    event({ seq: 6, at: '2026-10-02T10:00:06.000Z', type: 'error', code: 'AGENT_FAILED', message: '失败了' }),
    usage(7, { input: 40, cached: 20 }),
  ];
  const legacyRows: RowEvent[] = [
    { at: '2026-10-02T10:00:06.000Z', level: 'error', text: '错误 失败了', turn: null },
    { at: '2026-10-02T10:00:07.000Z', level: 'milestone', text: '用量 输入 40 tok · 缓存 20 tok · 输出 0 tok · 轮次 7', turn: null },
  ];

  it('老日志（没有 `turn` 格、也没有状态帧）：出一条，归属 `null` ⇒ 按时刻落最后一轮', () => {
    expect(rowEventsOf(legacyEvents())).toEqual(legacyRows);
    // 给了 `homes` 也一字不差：无归属的事件根本不走归属那一支
    expect(rowEventsOf(legacyEvents(), new Set(['main#1']))).toEqual(legacyRows);
  });

  it('老日志走真入口（`homes` 非空、整行真有 `main#1`）仍是那一条', () => {
    const model = buildAgentLogModel({
      records: [message({ id: 'm1', mergeKey: 'main|1|assistant|-', roundTrip: 1, blocks: [{ type: 'text', text: '第一轮' }] })],
      events: legacyEvents(),
      facts: facts(),
      startedAt: '2026-10-02T10:00:00.000Z',
    });
    // 前提：整行真的有 `main#1`——否则「老事件照样参与」这件事在本用例里没被考到
    const main = model.nodes.find((node) => node.kind === 'main');
    if (main?.content.status !== 'ready') throw new Error('主会话内容应就绪');
    expect(main.content.data.map((turn) => turn.round)).toEqual([1]);
    expect(model.rowEvents).toEqual(legacyRows);
  });

  /**
   * **整格缺省与显式 `subagentId: null` 混在同一条序列**（2026-10-05 审查 M-4 ①，判据随口径简化）。
   *
   * 两种写法都表示「主会话的读数」：**整格缺省**是 2026-10-05 之前落盘的老事件、以及所有算不出归属的
   * 读数；**显式 `{ subagentId: null, round: k }`** 是这一轮交付的归属键。它们必须**在同一条时间线上
   * 比先后**（谁最后谁上），而不是各算一份——当年各算一份时，同一条序列会多出一条里程碑。
   */
  it('整格缺省与显式 `subagentId: null` 混在同一条序列：仍只有一条，取时间上最后那条', () => {
    const rows = rowEventsOf(
      [
        usage(1, { input: 30 }, { turns: 1, turn: { subagentId: null, round: 1 } }),
        // 老写法（整格缺省）排在后面 ⇒ 它才是那一条；归属算不出 ⇒ `null`（按时刻归位）
        usage(2, { input: 10 }, { turns: 2 }),
      ],
      new Set(['main#1']),
    );

    expect(rows.map((row) => row.text)).toEqual(['用量 输入 10 tok · 缓存 0 tok · 输出 0 tok · 轮次 2']);
    expect(rows.map((row) => row.turn)).toEqual([null]);
  });

  /**
   * **零读数不许被吞掉**（`null` 与 `0` 含义相反）。
   *
   * 旧口径在这一格上有一个真实的坑：水位缺省值写成 `?? 0` 时，某会话**第一条**读数恰好是三项全零，
   * 它会被 `0 <= 0` 当场丢掉。水位退役之后这个坑没了，判据仍要钉住——防的是「顺手加一道
   * `total > 0` 才算数」的闸门：`0` 是**采到了且为零**，它照样是这一行的读数。
   */
  it('最后一条读数是 0（三项全零）也照样出', () => {
    const rows = rowEventsOf(
      [
        usage(1, { input: 5 }, { turns: 1, turn: { subagentId: null, round: 1 } }),
        usage(2, { input: 0 }, { turns: 2, turn: { subagentId: null, round: 2 } }),
      ],
      new Set(['main#1', 'main#2']),
    );

    expect(rows.map((row) => row.text)).toEqual(['用量 输入 0 tok · 缓存 0 tok · 输出 0 tok · 轮次 2']);
  });
});

/**
 * 消息级用量摊到块上（2026-10-06，spec `2026-10-01-agent-message-spec-design-v3.md` §3.2）。两条判据：
 *   · 同一条消息的每个块都带**同一个** `usage` 与 `mergeKey`（页脚靠 `mergeKey` 去重、靠 `usage` 取值）；
 *   · 契约缺这一格（老日志）时 UI 侧是 `null`（不是 `undefined`）——页脚「没有就不画」的判据要能吃它。
 */
describe('消息级用量与逻辑消息身份摊到块上（2026-10-06）', () => {
  /** 取主会话节点上摊平的块（`content` 未就绪就抛——与文件里其余用例同一条写法） */
  function mainBlocks(model: ReturnType<typeof buildAgentLogModel>) {
    const main = model.nodes.find((node) => node.kind === 'main');
    if (main?.content.status !== 'ready') throw new Error('主会话内容应就绪');
    return main.content.data.flatMap((turn) => turn.blocks);
  }

  it('同一条消息的每个块都带同一个 usage 与 mergeKey（且 UI 只取三项）', () => {
    const model = buildAgentLogModel({
      records: [
        message({
          id: 'm1',
          mergeKey: 'main|1|assistant|-',
          roundTrip: 1,
          /**
           * 给**完整的契约用量**（含可选两格）：UI 侧只取三项 ⇒ 逐格投影那一段才有区分力
           * （直接透传的话这里会多出 `reasoningOutput` / `total`，页脚以外的消费方就得自己忽略它们）。
           */
          usage: { input: 295, cached: 7424, output: 841, reasoningOutput: 12, total: 8560 },
          blocks: [
            { type: 'text', text: '正文' },
            { type: 'thinking', text: '想了想', textKind: 'full', signature: null },
            { type: 'tool-call', callId: 'call_1', name: 'pwsh', input: { cmd: 'ls' }, family: null },
          ],
        }),
      ],
      events: [],
      facts: facts(),
      startedAt: '2026-10-02T10:00:00.000Z',
    });

    const blocks = mainBlocks(model);
    expect(blocks).toHaveLength(3);
    for (const block of blocks) {
      // `toEqual` 连多出来的键一起比 ⇒ 「只取三项」这条在这里是**承重**的
      expect(block.usage).toEqual({ input: 295, cached: 7424, output: 841 });
      expect(block.mergeKey).toBe('main|1|assistant|-');
    }
  });

  it('契约没有 usage 时 UI 侧是 null（不是 undefined）', () => {
    const model = buildAgentLogModel({
      records: [message({ id: 'm2', mergeKey: 'main|1|assistant|-', roundTrip: 1, blocks: [{ type: 'text', text: '正文' }] })],
      events: [],
      facts: facts(),
      startedAt: '2026-10-02T10:00:00.000Z',
    });

    expect(mainBlocks(model)[0]?.usage).toBeNull();
  });
});

/**
 * 没有正文的思考块**整块隐藏**（2026-10-07 用户口径）。
 *
 * 数据层仍然如实记着「有思考、无文本」这条事实（`text: null` + `textKind: 'none'`：codex 在只回密文
 * 的路由上、或上游这一轮没给文本时就是这个形状），但那句话在界面上只能变成一句占位文案——
 * **不是用户要看的思考** ⇒ 没有就不显示。过滤放在**模型层**而不是某个组件里：
 * 时间轴、面包屑、以及任何一个消费方拿到的模型里都不该再有它。
 *
 * 这一条同时废掉了此前那个错误归因：这里曾把 `text === null` 一律说成 `'not-observed'`
 * （「厂商有、我们还没接」），而 codex 的思考文本恰恰**来自我们接了的**通道
 * （真机 `item/completed` 有全文）——把「这一轮没采到」说成「我们没做」是最忌讳的那类误读。
 */
describe('没有正文的思考块整块隐藏（2026-10-07）', () => {
  function blocksOfFirstMessage(blocks: AgentMessage['blocks'], capability?: MessageCapabilityMap) {
    const model = buildAgentLogModel({
      records: [message({ id: 'm1', mergeKey: 'main|1|assistant|-', roundTrip: 1, blocks })],
      events: [],
      facts: facts(),
      ...(capability === undefined ? {} : { capability }),
    });
    const main = model.nodes.find((node) => node.kind === 'main');
    if (main?.content.status !== 'ready') throw new Error('主会话内容应就绪');
    return main.content.data.flatMap((turn) => turn.blocks);
  }

  it('`text === null` 的思考块不进界面模型（与能力声明无关）', () => {
    const blocks = blocksOfFirstMessage([{ type: 'thinking', text: null, textKind: 'none', signature: null }], {
      thinkingText: { level: 'yes', source: 'wire', reason: null },
    });
    expect(blocks).toEqual([]);
  });

  it('无正文的思考块被隐藏，同一条消息里的正文块照常保留', () => {
    const blocks = blocksOfFirstMessage([
      { type: 'thinking', text: null, textKind: 'none', signature: null },
      { type: 'text', text: '正文' },
    ]);
    expect(blocks.map((block) => block.kind)).toEqual(['text']);
  });

  it('有正文的思考块照常出现（`summary` 那一档也在），且 `textMissing` 恒 `null`', () => {
    const blocks = blocksOfFirstMessage([
      { type: 'thinking', text: '想了', textKind: 'full', signature: null },
      { type: 'thinking', text: '厂商摘要', textKind: 'summary', signature: null },
    ]);
    expect(blocks.map((block) => block.kind)).toEqual(['thinking', 'thinking']);
    for (const block of blocks) expect(block.kind === 'thinking' ? block.textMissing : 'n/a').toBeNull();
  });
});
