// @vitest-environment jsdom
/**
 * `buildAgentLogModel` 的守卫：契约形状 → 界面模型那一步的三件必须有人做的事
 * （按 `subagentId` 分会话、按 `roundTrip` 分轮、把能力声明摊成字典），
 * 以及三条最容易错的判据：
 *
 *   1. **`mergeKey` 覆盖而不是追加**：同一条逻辑消息投递多次时，时间轴上只能出现一次，
 *      且是**最后那一次**（它的 `blocks` 已是全量）。错成追加的症状是「同一段正文出现两遍，
 *      后一遍还是半截的」——看着像内容错，其实是合并错。
 *   2. **`round` 用 `roundTrip`**：`turn` 三家语义不同、明文禁止用于分组。
 *   3. **`running` 不由「有没有后续块」推断**：只有最后一轮可能是「还没结束」的那一轮，
 *      一次被中断的回复停了就是停了（`facts.live === false` ⇒ 全部 `running === false`）。
 */
import { describe, expect, it } from 'vitest';
import type { AgentEvent, AgentMessage, RowRecord } from '@aieval/contracts';
import { buildAgentLogModel, diagnosticsOf, rowEventsOf, type AgentLogFactsInput } from './build-model';
import { contextMeterOf } from './agent-log-facts-bar';
import type { MessageCapabilityMap, RowEvent } from './types';

function message(input: {
  id: string;
  mergeKey: string;
  roundTrip: number;
  role?: AgentMessage['role'];
  source?: AgentMessage['source'];
  /** 谁带进来的；缺省与契约缺省一致（题面那一档）。人在半路插的那句要显式给 `'human'` */
  origin?: AgentMessage['origin'];
  /** 第几段；缺省缺席 = 第一次跑那一段（契约里那一格是可选的） */
  segment?: number;
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
      origin: input.origin ?? ('case-prompt' as const),
      ...(input.segment === undefined ? {} : { segment: input.segment }),
      roundTrip: input.roundTrip,
      turn: null,
      step: null,
      parentCallId: input.parentCallId ?? null,
      subagentId: input.subagentId ?? null,
      chunk: 'snapshot',
      assembly: input.assembly ?? 'snapshot',
      mergeKey: input.mergeKey,
      /**
       * 消息级用量：**只有显式给才写这一格**——契约里它是可选的（老 `messages.jsonl`
       * 根本没有这个键），工厂若写成 `usage: input.usage ?? null`，那条「老日志 ⇒ UI 侧 null」的用例
       * 就永远考不到「键缺席」这一档。
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
    contextWindow: null,
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

  it('按 `roundTrip` 分轮并升序排列；`turn` 不参与分组', () => {
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
    // 进度条与时间轴护栏不许互相打脸（两者会同时上屏：`轮次 4 / 3 轮` 与 `已渲染 4 / 共 4 轮`）
    expect(model.facts.turns).toEqual({ current: 3, total: null });
  });

  /**
   * 这一段自称「➀ 的时间回填」（走到调用消息时补 `messageId` / `at`），但它**不可达**，是死代码——
   * `dispatchOf` 扫的与这里扫的是**同一张 `folded` 主会话表**，判据也一样（`callId` 逐字相同）：
   * `dispatchOf` 找得到 ⇒ 它返回的 `messageId` 就已经是这一条的 `messageId`，轮次也同源；
   * `dispatchOf` 找不到 ⇒ 这里也找不到，两个判据（`messageId === ''` / `at === ''`）都无从成立。
   * 故这里**没有**回归守卫可写——留着它只是因为删改要连带确认四条判据的先后，属另一次整理。
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
   * **两套 id 的对接**：同一条子任务在**记录**上叫厂商原生 id，
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
   * **派发点只认「派发那一次」**。
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
   * 族载荷**直接来自契约的 `payload`**。
   *
   * 这一条盯的是「界面只搬运、不归一」：块的 `input` 里照旧带着**厂商原文**（排障用），
   * 而界面要画的那张卡片完全由 `payload` 决定。反过来读 `input.todos` /
   * `input.questions` 自己拼，「厂商改一个字段名」就等于界面上静默少一张卡片。
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
   * **答案那一半的回填**（本仓只读卡片 `settled` 一支的产出方就在这一格）。
   *
   * 喂一条真实链路会产出的账本：适配器投的调用那一半（`tool-call` + `ask-user` 载荷）
   * 与编排层在答复到手后落的**结果那一半**（`tool-result`，`structured` 是契约的
   * `AskUserResultSchema`）。判据是**逐字回填**：收场方式、答案、以及结果块的原文都要到位。
   *
   * 两处刻意如此：① 结果块与调用块**不在同一条消息、也不一定在同一轮**——配对按 `callId`
   * 跨整条账本做，卡片自己只看得到本轮；② 没有结果块时必须是 `pending`（下一条用例守着
   * 「没有产出方时不许假装收场」）——两种情形混成一种，卡片就会把「还在等」画成「已经答了」。
   */
  it('`tool-result` 那一半里的答复回填成 `settled`（答案逐字、原文可查）', () => {
    const records: RowRecord[] = [
      message({
        id: 'm1',
        mergeKey: 'main|1|assistant|-',
        roundTrip: 1,
        blocks: [
          {
            type: 'tool-call',
            callId: 'call_ask_1',
            family: 'ask-user',
            name: 'ask_user_question',
            input: { questions: [{ question: '发哪？' }] },
            payload: {
              kind: 'ask-user',
              questions: [{ header: '范围', prompt: '发哪？', options: [], multiSelect: false, allowOther: true, secret: false }],
            },
          },
        ],
      }),
      // 编排层那一条：`mergeKey` 与适配器自己的工具结果同形（同一次调用的结果只应有一条）
      message({
        id: 'm2',
        mergeKey: 'main|1|tool|call_ask_1',
        roundTrip: 1,
        role: 'tool',
        source: 'hook',
        parentCallId: 'call_ask_1',
        blocks: [
          {
            type: 'tool-result',
            callId: 'call_ask_1',
            structured: { outcome: 'answered', answers: [{ header: '范围', selected: ['预发'], custom: null }] },
            isError: false,
            text: '这一问的答案（收场方式：answered）：\n- 范围：预发',
            truncation: { kind: 'none' },
          },
        ],
      }),
    ];
    const model = buildAgentLogModel({ records, events: [], facts: facts(), startedAt: null });
    const main = model.nodes.find((node) => node.kind === 'main');
    if (main?.content.status !== 'ready') throw new Error('内容应就绪');
    const block = main.content.data[0]?.blocks[0];
    if (block?.kind !== 'tool-call' || block.tool === null || block.tool.family !== 'ask-user') {
      throw new Error('应为 ask-user 载荷');
    }
    expect(block.tool.interaction).toMatchObject({
      state: 'settled',
      outcome: 'answered',
      answers: [{ header: '范围', selected: ['预发'], custom: null }],
    });
    // 原文与截断态一起带上：卡片底部那个「原始结果」抽屉读的就是它
    expect(block.tool.interaction.state === 'settled' ? block.tool.interaction.result : null).toEqual({
      ok: true,
      raw: '这一问的答案（收场方式：answered）：\n- 范围：预发',
      truncation: { kind: 'none' },
    });
  });

  /**
   * **codex 那一行的账本**（真机读数逐字）：这一家的提问是 server→client 请求、**不进线程条目**
   * （`ThreadItem` 里没有这一格），提问那一半由适配器补进账本（`askUserCallDraft`）。
   * 补出来的形状与另三家 wire 上那条**逐字同形**，因此这一段折叠逻辑对四家是同一条——
   * 本用例的判据就是「四家的形状在这里混不出差别」。
   *
   * 逐字取真机：两题（`favorite_animal` / `favorite_plants`）、每题三个候选项，答案两份都是
   * 自由输入（`selected: []` + `custom`）——这正是 codex 只有单选、用户走「其它」通道的样子。
   * 断言的落点是**配对**：每题的答案要落在**它自己那个 `header`** 上（契约里唯一的配对键），
   * 配错的表现就是「题目与答案对不上」。
   */
  it('codex 真机形状：补出的 `tool-call` 与答复那一半折成一张卡片，题目与答案按 `header` 逐字对上', () => {
    const questions = [
      {
        header: '动物单选',
        prompt: '第 1 题（单选）：下面三种动物你最喜欢哪一种？',
        options: [
          { label: '猫 (Recommended)', description: '独立、安静，适合室内饲养。', recommended: false },
          { label: '狗', description: '热情、忠诚，需要较多陪伴与运动。', recommended: false },
          { label: '海豚', description: '聪明、社会性强的海洋哺乳动物。', recommended: false },
        ],
        multiSelect: false,
        allowOther: false,
        secret: false,
      },
      {
        header: '植物多选',
        prompt: '第 2 题（多选，可勾选多个）：下面三种植物中，你感兴趣的有哪些？',
        options: [
          { label: '多肉植物 (Recommended)', description: '耐旱好养，适合阳台和办公桌。', recommended: false },
          { label: '蕨类植物', description: '喜阴喜湿，能提升室内湿度感。', recommended: false },
          { label: '香草植物', description: '如罗勒、薄荷，可观赏也可入菜。', recommended: false },
        ],
        multiSelect: false,
        allowOther: false,
        secret: false,
      },
    ];
    const records: RowRecord[] = [
      // 适配器补出来的那一半：`callId` 取厂商的 `itemId`
      message({
        id: 'run-codex:426',
        mergeKey: 'main|1|assistant|-',
        roundTrip: 1,
        blocks: [
          {
            type: 'tool-call',
            callId: 'call_00_jhIII03ANulkj1Hw1TVC8940',
            family: 'ask-user',
            name: 'request_user_input',
            input: { questions: [{ id: 'favorite_animal' }, { id: 'favorite_plants' }] },
            payload: { kind: 'ask-user', questions },
          },
        ],
      }),
      // 编排层落的那一半：答复与收场方式
      message({
        id: 'cad20840:ask-user:06c7e871',
        mergeKey: 'main|1|tool|call_00_jhIII03ANulkj1Hw1TVC8940',
        roundTrip: 1,
        role: 'tool',
        source: 'hook',
        parentCallId: 'call_00_jhIII03ANulkj1Hw1TVC8940',
        blocks: [
          {
            type: 'tool-result',
            callId: 'call_00_jhIII03ANulkj1Hw1TVC8940',
            structured: {
              outcome: 'answered',
              answers: [
                { header: '动物单选', selected: [], custom: '兔' },
                { header: '植物多选', selected: [], custom: '月季、杜鹃' },
              ],
            },
            isError: false,
            text: '这一问的答案（收场方式：answered）：\n- 动物单选：兔\n- 植物多选：月季、杜鹃',
            truncation: { kind: 'none' },
          },
        ],
      }),
    ];
    const model = buildAgentLogModel({ records, events: [], facts: facts(), startedAt: null });
    const main = model.nodes.find((node) => node.kind === 'main');
    if (main?.content.status !== 'ready') throw new Error('内容应就绪');
    const block = main.content.data[0]?.blocks[0];
    if (block?.kind !== 'tool-call' || block.tool === null || block.tool.family !== 'ask-user') {
      throw new Error('应为 ask-user 载荷');
    }
    const interaction = block.tool.interaction;
    expect(interaction.state).toBe('settled');
    if (interaction.state !== 'settled') throw new Error('应已收场');
    // 题目与选项逐字都在（这一格缺了就是「界面上只剩一条没有题目的答复行」）
    expect(interaction.questions).toEqual(questions);
    expect(interaction.outcome).toBe('answered');
    // 逐题配对：契约里唯一的配对键是 `header`
    const expected: Record<string, string> = { 动物单选: '兔', 植物多选: '月季、杜鹃' };
    for (const question of interaction.questions) {
      const answer = interaction.answers?.find((one) => one.header === question.header);
      expect(answer?.custom).toBe(expected[question.header]);
    }
  });

  it('没有结果那一半时保持 `pending`：别的工具的 `structured` 不许冒充答案', () => {
    const call: RowRecord = message({
      id: 'm1',
      mergeKey: 'main|1|assistant|-',
      roundTrip: 1,
      blocks: [
        {
          type: 'tool-call',
          callId: 'call_ask_1',
          family: 'ask-user',
          name: 'ask_user_question',
          input: { questions: [{ question: '发哪？' }] },
          payload: { kind: 'ask-user', questions: [{ header: '范围', prompt: '发哪？', options: [], multiSelect: false, allowOther: false, secret: false }] },
        },
      ],
    });
    const otherResult: RowRecord = message({
      id: 'm2',
      mergeKey: 'main|1|tool|-',
      roundTrip: 1,
      role: 'tool',
      blocks: [
        // 别的工具的结构化结果：形状对不上（缺 `answers`）⇒ 不许当成答案
        { type: 'tool-result', callId: 'call_ask_1', structured: { outcome: 'answered' }, isError: false, text: '{}', truncation: { kind: 'unknown' } },
      ],
    });
    const model = buildAgentLogModel({ records: [call, otherResult], events: [], facts: facts({ live: true, endedAt: null }), startedAt: null });
    const main = model.nodes.find((node) => node.kind === 'main');
    if (main?.content.status !== 'ready') throw new Error('内容应就绪');
    const block = main.content.data[0]?.blocks[0];
    if (block?.kind !== 'tool-call' || block.tool === null || block.tool.family !== 'ask-user') {
      throw new Error('应为 ask-user 载荷');
    }
    expect(block.tool.interaction).toMatchObject({ state: 'pending' });
  });

  /**
   * 回归守卫：「等了多久」这一格必须是**真实时刻**。
   *
   * 两处读同一个 `interaction.at`：卡片标题上的「等待答复中… 12m」与固定区那枚「等待答复」徽标
   * （`agent-log-layout.tsx` 的 `waitingSinceOf` 扫的正是 `LogTurn.blocks[].tool.interaction.at`）。
   * 装配层若把它写死成空串 ⇒ `Date.parse('')` 得 NaN、`formatDuration` 回落 `'0s'`，
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
   * **界面不认厂商形状**。
   *
   * 喂一份**逐字真机**的厂商入参（`todos[]` / `questions[]` 都在），而 `payload` 为 `null` ⇒
   * 必须**不出卡片**、回退成通用工具行。在这里认出 `todos` 并把面板画出来，
   * 「归一」这件事就有了两份实现（agents 一份、界面一份），而漂移的表现是
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

/**
 * **上下文占用**（`contextUsed`）：候选阶段**最后一条主会话** usage 的 `input + cached`。
 *
 * 它与 `facts.tokens` 是两笔账：`tokens` 是整行累计（这一行一共花了多少），
 * 占用是**这一刻窗口里有多少**。把累计求和当成占用，长跑行的百分比会一路涨过 100%，
 * 而读者会把「账单」读成「占用」——这正是这一组用例要钉住的分界。
 */
describe('上下文占用（contextUsed）：只取最后一轮，不是整行累计', () => {
  /** 一条主会话 usage（`turn` 缺省 = 主会话读数） */
  function usage(seq: number, input: number, cached: number, turn?: { subagentId: string | null; round: number } | null): AgentEvent {
    return event({
      seq,
      type: 'usage',
      tokens: { input, cached, output: 0, reasoningOutput: null, total: null },
      turns: seq,
      timing: null,
      ...(turn === undefined ? {} : { turn }),
    });
  }

  it('多轮行只取最后一轮：input 10 / 5 / 30 ⇒ 占用是 30 + 它的 cached（不是累计 45）', () => {
    const model = buildAgentLogModel({
      records: [],
      events: [usage(1, 10, 0), usage(2, 5, 0), usage(3, 30, 7)],
      facts: facts({ tokens: { input: 45, cached: 7, output: 0 } }),
    });

    // 30 + 7 = 37（最后一条）；整行累计 45 + 7 = 52 是另一笔账
    expect(model.facts.contextUsed).toBe(37);
    expect(model.facts.contextUsed).not.toBe(52);
  });

  it('子会话自己的 usage 不影响这一格（那是那张子任务卡片的读数）', () => {
    const model = buildAgentLogModel({
      records: [],
      events: [
        usage(1, 10, 0),
        usage(2, 30, 7),
        // 子会话的读数是**会话尺度**的累计，不是这一行的上下文占用
        usage(3, 999, 999, { subagentId: 's-1', round: 1 }),
      ],
      facts: facts({ tokens: { input: 1_039, cached: 1_006, output: 0 } }),
    });

    expect(model.facts.contextUsed).toBe(37);
  });

  it('`row.tokens`（累计账单）与占用不相等时，事实条读的是占用（防旧写法复发）', () => {
    const model = buildAgentLogModel({
      records: [],
      events: [usage(1, 10, 0), usage(2, 5, 0), usage(3, 30, 7)],
      // 数据层给的是**整行累计**（账单），它与占用不是同一个数
      facts: facts({ tokens: { input: 45, cached: 7, output: 0 }, contextWindow: 100 }),
    });

    expect(model.facts.tokens?.input).toBe(45);
    const meter = contextMeterOf(model.facts);
    expect(meter.state).toBe('ready');
    // 读的是 37/100 = 37%，不是 52/100
    expect(meter.state === 'ready' ? meter.used : null).toBe(37);
    expect(meter.state === 'ready' ? meter.percent : null).toBe(37);
  });
});

describe('行级事件的去向', () => {
  /**
   * 三条去向判据：`error` **逐条**进（失败归因不能只剩一条）；
   * `usage` **整行只出最后一条候选读数**；`log` 不进时间轴（它走 `diagnosticsOf` 的原文面板）。
   *
   * 「只出最后一条」是要钉的靶子：逐条成行会出三条（10 / 30 / 40 各一条），而真机症状正是
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
   * 归属（整行只剩这一条）：那一条带上归属键，文案里的轮次号用
   * **归属号**（不再是本行累计号——否则文字与它所在分组对不上）；归属轮次整行都不存在时抹成 `null`
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
   * **整链接线**：上面那条纯函数用例把 `homes` 直接喂给了 `rowEventsOf`，
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
   * **可达的子会话节点同样不出行**（这一格守的是「不出行与可达性无关」）。
   *
   * dsh / codex 的子会话用量里程碑带的是**非空** `subagentId`（真机里子节点 round 1/2 就是这类节点），
   * 若按「节点可达就认」处置，它们会成行。用户裁定「子智能体用量只在派发点那张子任务卡片里展示」
   * 之后，折行这一层对子会话读数的处置是**一条都不出**：不出行**不是因为**节点不可达
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
   * **子会话的用量读数不成行**（用户裁定：子智能体用量只在派发点那张子任务卡片里展示）。
   *
   * 「不可达子节点算不算有家」那一套判据已随口径退役：四条派发判据都没命中的子任务节点
   * （`spawnedBy === null`）认不认作有家，对这里已经无关——子会话读数**根本不进折行**。
   * 这里钉两件事：① 子会话的读数一条都不出；② 子任务卡片那一格的数据源**没被顺手删掉**
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
 * 用量里程碑：**整行一条**（用户裁定）。
 *
 * `usage` 事件是**每次模型往返**一条、带的是「到目前为止」的累计值：按「累计创新高就出一条」折行，
 * 同一行会出 5 条（轮次 1/2/3/4/4），其中同一轮先出跑动期估算（`输出 0`）、一秒后再出厂商结算值，
 * 屏幕上就是两条几乎一样的「用量 … 轮次 4」。现在的口径是**只取候选阶段里最后一条主会话读数**。
 *
 * 按会话分桶的那一套「水位」判据已整体退役——它服务的就是「逐轮各出一条」；
 * 子会话那一条现在**根本不进折行**（用户口径：子智能体用量只在派发点那张子任务卡片里展示）。
 */
describe('用量里程碑：整行一条', () => {
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
   * **真机形状的回归钉**：同一轮先来跑动期估算（`输出 0`——wire 上的
   * `output_tokens` 在流式期恒 0）、一秒后再来厂商结算值（`input` / `cached` 逐字相同、`output` 才补上）。
   * 逐条成行时这一对会在同一轮画两行；现在**整行只剩最后那一条**（结算值）。
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
   * **候选阶段之后的读数不属于这一行**（历史数据形状：评分事件曾与候选同一条流的时期落盘的
   * `events.jsonl`，候选跑完 → 评审者接着报用量，轮次从 1 重新数、token 只有候选的零头）。
   * 只看「最后一条」会把这一行的读数换成评审者的。
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
   * **多段（追问）之后：里程碑必须取最后那一段的读数**。
   *
   * 一次追问是又开一次 `run()`：那一段先 `preparing` / `running`，跑完再 `judging` / `judged`。
   * 「候选阶段」这道闸门若只认**第一条** `judging` 就一关到底，那一段的读数（以及它自己那条终态帧）
   * 全被当成「评审者的用量」丢掉 ⇒ 里程碑冻在首段的最后一条读数上：数字是旧的，位置也落在中间那一轮
   * （真机 `ce008414` 的行 `673cd5f8`：里程碑停在段 1 的轮次 2，而最后一条消息是段 1 的轮次 3）。
   *
   * 判据：**新的候选阶段会重新开始**（`preparing` / `running` 把闸门打开），`judging` / 终态帧关上。
   */
  it('追问那一段的读数照样算数：里程碑落在**最后一个**读数上（不被第一次 judging 锁死）', () => {
    const rows = rowEventsOf(
      [
        status(1, 'running'),
        usage(2, { input: 100, cached: 10 }, { turn: { subagentId: null, round: 1 } }),
        usage(3, { input: 200, cached: 20, output: 5 }, { turn: { subagentId: null, round: 2 } }),
        status(4, 'judging'),
        status(5, 'judged'),
        // —— 追问那一段：候选阶段重新开始 ——
        status(6, 'running'),
        usage(7, { input: 30, cached: 4 }, { turn: { subagentId: null, round: 1 } }),
        usage(8, { input: 40, cached: 6, output: 9 }, { turn: { subagentId: null, round: 3 } }),
        status(9, 'judging'),
        status(10, 'judged'),
      ],
      new Set(['main#1', 'main#2', 'main#3']),
    );

    expect(rows.map((row) => row.text)).toEqual(['用量 输入 40 tok · 缓存 6 tok · 输出 9 tok · 轮次 3']);
    expect(rows[0]?.turn).toEqual({ subagentId: null, round: 3 });
  });

  it('多段之后仍不吃评审者的读数：最后一段跑完的那条 `judging` 之后关闸', () => {
    const rows = rowEventsOf(
      [
        status(1, 'running'),
        usage(2, { input: 40, cached: 6, output: 9 }, { turn: { subagentId: null, round: 3 } }),
        status(3, 'judging'),
        usage(4, { input: 1280, cached: 7424, output: 125 }, { turn: { subagentId: null, round: 1 } }),
      ],
      new Set(['main#1', 'main#3']),
    );
    expect(rows.map((row) => row.text)).toEqual(['用量 输入 40 tok · 缓存 6 tok · 输出 9 tok · 轮次 3']);
  });

  /**
   * **老日志照样出一条**（这里刻意连状态帧都不给：历史行可能既没有归属格、也没有终态帧）。
   *
   * 递增进、与上一条相等、比上一条低——三种形状现在**都无所谓**（水位判据已退役），取的是最后那一条；
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
   * **整格缺省与显式 `subagentId: null` 混在同一条序列**（判据随口径简化）。
   *
   * 两种写法都表示「主会话的读数」：**整格缺省**是早期落盘的老事件、以及所有算不出归属的
   * 读数；**显式 `{ subagentId: null, round: k }`** 是这一轮交付的归属键。它们必须**在同一条时间线上
   * 比先后**（谁最后谁上），而不是各算一份——各算一份时，同一条序列会多出一条里程碑。
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
   * 这一格的坑：给「水位」之类的缺省值写 `?? 0` 时，某会话**第一条**读数恰好是三项全零，
   * 它会被 `0 <= 0` 当场丢掉。判据要钉住的是——不许顺手加一道
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
 * 消息级用量摊到块上。两条判据：
 *   · 同一条消息的每个块都带**同一个**`usage` 与 `mergeKey`（页脚靠 `mergeKey` 去重、靠 `usage` 取值）；
 *   · 契约缺这一格（老日志）时 UI 侧是 `null`（不是 `undefined`）——页脚「没有就不画」的判据要能吃它。
 */
describe('消息级用量与逻辑消息身份摊到块上', () => {
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
 * 没有正文的思考块**整块隐藏**（用户口径）。
 *
 * 数据层仍然如实记着「有思考、无文本」这条事实（`text: null` + `textKind: 'none'`：codex 在只回密文
 * 的路由上、或上游这一轮没给文本时就是这个形状），但那句话在界面上只能变成一句占位文案——
 * **不是用户要看的思考** ⇒ 没有就不显示。过滤放在**模型层**而不是某个组件里：
 * 时间轴、面包屑、以及任何一个消费方拿到的模型里都不该再有它。
 *
 * 这一格不能把 `text === null` 一律说成 `'not-observed'`（「厂商有、我们还没接」）：
 * codex 的思考文本**来自我们接了的**通道（真机 `item/completed` 有全文）——
 * 把「这一轮没采到」说成「我们没做」是最忌讳的那类误读。
 */
describe('没有正文的思考块整块隐藏', () => {
  function blocksOfFirstMessage(
    blocks: AgentMessage['blocks'],
    capability?: MessageCapabilityMap,
    /** 信封上的收尾态：`open` = 还在流（块的 `assembly` 跟着信封走） */
    assembly?: AgentMessage['assembly'],
  ) {
    const model = buildAgentLogModel({
      records: [message({ id: 'm1', mergeKey: 'main|1|assistant|-', roundTrip: 1, blocks, ...(assembly === undefined ? {} : { assembly }) })],
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

  /**
   * **空白正文与没有正文是同一档**：`text: ''`（或只有空白）的思考块在界面上只能画出一个**空面板**
   * ——标题「思考」/「思考中…」带着一片空白，看起来像「思考了但什么也没想」。
   *
   * 它从哪来：codex 与 pi 的**思考增量帧**不过滤空 delta（cc 与 dsh 都有 `if (text === '') return`），
   * 于是「这一段思考刚开始、正文还没到」那一拍会投出一条 `text: ''` 的思考块。用户口径：
   * **等第一条有正文的思考流消息到了再画那一个面板**，在此之前连标题都不出现。
   */
  it('空白正文（`text: \'\'` / 只有空白）同样整块隐藏——空面板会画出一行空白', () => {
    const blocks = blocksOfFirstMessage([
      { type: 'thinking', text: '', textKind: 'full', signature: null },
      { type: 'thinking', text: '   \n\t ', textKind: 'summary', signature: null },
      { type: 'text', text: '正文' },
    ]);
    expect(blocks.map((block) => block.kind)).toEqual(['text']);
  });

  it('空白正文的思考块在**流式中**（信封 `assembly: open`）也不出现：第一条有正文的增量到了才画', () => {
    const blocks = blocksOfFirstMessage(
      [{ type: 'thinking', text: '', textKind: 'full', signature: null }],
      undefined,
      'open',
    );
    expect(blocks).toEqual([]);
  });
});

/**
 * 工具入参：**原文两份 + 模型自己写的一句话**。
 *
 * `description` 的用处是工具行摘要行的标题（收起态唯一可见的一行）：照原文首行渲染就是
 * 一整串 JSON。它由**数据层**抽出来（`serializeInput`），组件不自己反解原文——
 * 故这一层必须钉住「抽得出来 / 抽不出来时如实 `null`」，否则组件那边会拿一个恒 `null` 的格子
 * 静默回落到老行为（字都还在，只是又没法读了）。
 *
 * 抽不出就 `null`，**不拿别的字段凑**：这一格同时是派发调用的任务名（claude 的 `Task`、
 * dsh 的 `subagent`），凑出来的名字配不上任何子任务。
 */
describe('工具入参：原文与 `description`', () => {
  /** 走一遍真实链路（契约块 → 界面模型），取第一条 `tool-call` 的入参形状 */
  function inputOf(raw: unknown) {
    const model = buildAgentLogModel({
      records: [
        message({
          id: 'm1',
          mergeKey: 'main|1|assistant|-',
          roundTrip: 1,
          blocks: [{ type: 'tool-call', callId: 'call_1', name: 'pwsh', family: 'run-shell', input: raw }],
        }),
      ],
      events: [],
      facts: facts(),
      startedAt: '2026-10-02T10:00:00.000Z',
    });
    const main = model.nodes.find((node) => node.kind === 'main');
    if (main?.content.status !== 'ready') throw new Error('主会话内容应就绪');
    const block = main.content.data.flatMap((turn) => turn.blocks).find((one) => one.kind === 'tool-call');
    if (block?.kind !== 'tool-call') throw new Error('应有工具调用块');
    return block.input;
  }

  it('`tool-call.summary`（数据层算好的那一句）原样搬到界面块上；老记录缺格 ⇒ `undefined`', () => {
    // 这一格是摘要行的**第一档**：词表真源在 `@aieval/agents` 的
    // `activity.ts`，界面按分层表不许 import 它 ⇒ 只能读这一格。它一旦在搬运路上丢了，
    // 界面会**静默**退回下面那两档（描述 → 原文首行），症状是「每族拼法全丢」而用例不红。
    const model = buildAgentLogModel({
      records: [
        message({
          id: 'm1',
          mergeKey: 'main|1|assistant|-',
          roundTrip: 1,
          blocks: [
            { type: 'tool-call', callId: 'call_1', name: 'Read', family: 'read-file', input: { file_path: 'a.ts' }, summary: 'a.ts:10-120' },
            { type: 'tool-call', callId: 'call_2', name: 'Read', family: 'read-file', input: { file_path: 'b.ts' } },
          ],
        }),
      ],
      events: [],
      facts: facts(),
      startedAt: '2026-10-02T10:00:00.000Z',
    });
    const main = model.nodes.find((node) => node.kind === 'main');
    if (main?.content.status !== 'ready') throw new Error('主会话内容应就绪');
    const calls = main.content.data.flatMap((turn) => turn.blocks).filter((one) => one.kind === 'tool-call');
    expect(calls[0]?.summary).toBe('a.ts:10-120');
    // 老记录：`messages.jsonl` 里没有这一格 ⇒ 如实 `undefined`（界面据此回落到 `description`）
    expect(calls[1]?.summary).toBeUndefined();
  });

  it('对象入参：`description` 进那一格，原文照旧逐字两份', () => {
    const input = inputOf({ command: 'git --no-pager diff', description: '看生产改动与状态' });

    expect(input.description).toBe('看生产改动与状态');
    expect(input.value).toBe('{"command":"git --no-pager diff","description":"看生产改动与状态"}');
    expect(input.text).toBe(input.value);
  });

  it('JSON 字符串入参（`arguments` 还没被解析那一档）也抽得出来；不是 JSON 就只留原文', () => {
    expect(inputOf('{"command":"ls","description":"列目录"}').description).toBe('列目录');
    // 纯文本入参（如 `Read` 的路径直接是字符串）：原文照留，`description` 如实 `null`
    expect(inputOf('Get-ChildItem env:').description).toBeNull();
  });

  it('没有这一格 / 只有空白 / 不是字符串 ⇒ `null`（**不拿别的字段凑**）', () => {
    expect(inputOf({ command: 'ls' }).description).toBeNull();
    expect(inputOf({ description: '   ' }).description).toBeNull();
    expect(inputOf({ description: 7 }).description).toBeNull();
    expect(inputOf({ command: 'ls' }).value).toBe('{"command":"ls"}');
  });

  it('`description` 前后的空白去掉（它直接进标题那一行）', () => {
    expect(inputOf({ description: '  看改动  ' }).description).toBe('看改动');
  });

  it('入参整个没采到：四格一起是 `null`（不是空串、不是 0）', () => {
    expect(inputOf(null)).toEqual({ value: null, text: null, bytes: null, description: null });
  });
});

/**
 * **题面与段**：人给智能体说的话在执行日志里怎么落位。
 *
 * 两件事各有各的坑：
 *   · 题面（`origin: 'case-prompt'` 的 user 消息）**只由首条卡片呈现**——它也进轮次的话，
 *     同一句话在同一个抽屉里画两遍；
 *   · 一次追问是又开一次 `run()`，那一段的厂商轮次从 1 重新数 ⇒ 两段的 `mergeKey` 逐字相同。
 *     折叠键不带段号会让后一段把前一段**整条吃掉**（真机症状：追问之后首段的工具调用凭空消失）。
 */
describe('题面：首条卡片与轮次里的「不重复画」', () => {
  /** 题面那条消息（编排层在把 `run()` 交出去之前落的账） */
  function casePrompt(text: string): RowRecord {
    return message({
      id: 'case-prompt:row-1',
      mergeKey: 'main|1|user|-|case-prompt',
      roundTrip: 1,
      role: 'user',
      origin: 'case-prompt',
      source: 'hook',
      blocks: [{ type: 'text', text }],
    });
  }

  it('账本里那一条推成首条卡片的两格（正文逐字、时刻取派生的基准）', () => {
    const model = buildAgentLogModel({
      records: [casePrompt('把 README 的标题改成中文')],
      events: [],
      facts: facts(),
      startedAt: '2026-10-02T10:00:00.000Z',
    });
    const main = model.nodes.find((node) => node.kind === 'main');
    expect(main?.kind === 'main' ? main.userPrompt : null).toEqual({
      text: '把 README 的标题改成中文',
      at: '2026-10-02T10:00:00.000Z',
    });
  });

  it('它**不进轮次**（同一句话只画一遍：首条卡片那一处）', () => {
    const model = buildAgentLogModel({
      records: [casePrompt('把 README 的标题改成中文'), message({ id: 'm1', mergeKey: 'main|1|assistant|-', roundTrip: 1, blocks: [{ type: 'text', text: '好的' }] })],
      events: [],
      facts: facts(),
      startedAt: '2026-10-02T10:00:00.000Z',
    });
    const main = model.nodes.find((node) => node.kind === 'main');
    if (main?.content.status !== 'ready') throw new Error('主会话内容应就绪');
    const texts = main.content.data.flatMap((turn) => turn.blocks).map((block) => (block.kind === 'text' ? block.text : ''));
    expect(texts).toEqual(['好的']);
  });

  /**
   * 一行跑了却一条内容都没产出：界面上仍该说出「它被要求做什么」。
   * `empty` 判的是「**有没有得画**」——题面那张卡片也是要画的东西。
   */
  it('只有题面一条时不是空态（`empty === false`），轮次里一条内容都没有', () => {
    const model = buildAgentLogModel({
      records: [casePrompt('把 README 的标题改成中文')],
      events: [],
      facts: facts(),
      startedAt: '2026-10-02T10:00:00.000Z',
    });
    expect(model.empty).toBe(false);
    const main = model.nodes.find((node) => node.kind === 'main');
    if (main?.content.status !== 'ready') throw new Error('主会话内容应就绪');
    expect(main.content.data).toEqual([]);
  });

  it('旧运行（账本里没有题面那条）⇒ 首条不渲染、且仍是空态（不编一句题面）', () => {
    const model = buildAgentLogModel({
      records: [message({ id: 'm1', mergeKey: 'main|1|assistant|-', roundTrip: 1, blocks: [{ type: 'text', text: '好的' }] })],
      events: [],
      facts: facts(),
      startedAt: '2026-10-02T10:00:00.000Z',
    });
    const main = model.nodes.find((node) => node.kind === 'main');
    expect(main?.kind === 'main' ? main.userPrompt : 'unexpected').toBeNull();
    expect(model.empty).toBe(false);
  });

  it('调用方显式给的 `userPrompt` 覆盖推导（夹具与非评测场景的逃生口）', () => {
    const model = buildAgentLogModel({
      records: [],
      events: [],
      facts: facts(),
      userPrompt: { text: '外部给的题面', at: '2026-10-02T09:00:00.000Z' },
    });
    const main = model.nodes.find((node) => node.kind === 'main');
    expect(main?.kind === 'main' ? main.userPrompt?.text : null).toBe('外部给的题面');
  });
});

describe('段：追问那一段与首段各归各的', () => {
  /** 适配器投的一条消息（段号只在追问那一段给）；`id` 不给则由段号与正文派生一个稳定值 */
  function adapter(segment: number | undefined, text: string, id?: string): RowRecord {
    return message({
      id: id ?? `m-${segment ?? 0}-${text}`,
      mergeKey: 'main|1|assistant|-',
      roundTrip: 1,
      ...(segment === undefined ? {} : { segment }),
      blocks: [{ type: 'text', text }],
    });
  }

  const records: RowRecord[] = [
    adapter(undefined, '首段的第 1 轮'),
    message({ id: 'f1', mergeKey: 'main|1|user|-|followup:f1', roundTrip: 1, role: 'user', origin: 'human', source: 'hook', segment: 1, blocks: [{ type: 'text', text: '再说一句' }] }),
    adapter(1, '追问那一段的第 1 轮'),
  ];

  it('两段同号同键的消息**都在**，顺序按段（不让后一段把前一段吃掉）', () => {
    const model = buildAgentLogModel({ records, events: [], facts: facts(), startedAt: null });
    const main = model.nodes.find((node) => node.kind === 'main');
    if (main?.content.status !== 'ready') throw new Error('主会话内容应就绪');
    const texts = main.content.data.flatMap((turn) => turn.blocks).map((block) => (block.kind === 'text' ? block.text : ''));
    // 段 1 的那句人话**不在轮次的展示块里**——它由那一段的标题呈现（见下面那条用例）
    expect(texts).toEqual(['首段的第 1 轮', '追问那一段的第 1 轮']);
    expect(main.content.data.map((turn) => [turn.segment, turn.round])).toEqual([[0, 1], [1, 1]]);
    // 两段的顺序按段号：段标题读 `model.segments`，它也必须按段号升序
    expect(model.segments.map((one) => [one.segment, one.text])).toEqual([[1, '再说一句']]);
  });

  it('轮次的键带段号（两个「轮次 1」不能是同一个 key）', () => {
    const model = buildAgentLogModel({ records, events: [], facts: facts(), startedAt: null });
    const main = model.nodes.find((node) => node.kind === 'main');
    if (main?.content.status !== 'ready') throw new Error('主会话内容应就绪');
    const blocks = main.content.data.flatMap((turn) => turn.blocks);
    // 块 id 是 React key：段不同 ⇒ 即使载体键与块下标都一样也不能撞
    expect(new Set(blocks.map((block) => block.id)).size).toBe(blocks.length);
    expect(blocks.map((block) => block.segment)).toEqual([0, 1]);
  });

  it('追问那句落在**它自己那一段**（段标题里），不在首段、也不在轮次的展示块里', () => {
    const model = buildAgentLogModel({ records, events: [], facts: facts(), startedAt: null });
    const main = model.nodes.find((node) => node.kind === 'main');
    if (main?.content.status !== 'ready') throw new Error('主会话内容应就绪');
    const second = main.content.data.filter((turn) => turn.segment === 1);
    // 段首那一轮的块只剩模型答的话（那句人话整组进了段标题）
    expect(second.map((turn) => turn.blocks.map((block) => block.role))).toEqual([['assistant']]);
    expect(model.segments).toEqual([{ segment: 1, at: '', text: '再说一句' }]);
  });

  it('首段不进段标题（它的分界是题面那张卡片）：`segments` 里没有段 0', () => {
    const model = buildAgentLogModel({ records, events: [], facts: facts(), startedAt: null });
    expect(model.segments.map((one) => one.segment)).toEqual([1]);
  });

  /**
   * **真机的投递顺序**：一次追问是又开一次 `run()`，而发起它的那一段代码先让出事件循环、再等
   * `run()` 收尾 ⇒ 那一段的**第一条适配器消息可以在那句追问自己落账本之前就落地**。
   * 于是同一轮桶里助手块按投递顺序排在用户块前面，界面上「我追问的那句话」被画到了这一段的**末尾**
   * （它该是这一段的标题）。本组钉的就是「那句人话不看投递顺序，只看段号」。
   */
  describe('轮内顺序：人说的话排在模型答复之前（投递顺序不保证这一点）', () => {
    it('追问那句后到 ⇒ 它照样是这一段的标题（真机 run 4812ed11 的形状）', () => {
      const model = buildAgentLogModel({
        records: [
          // 首段：题面那一轮
          adapter(undefined, '首段的第 1 轮'),
          // 追问那一段：**答复先落账本，那句人话后到**（真机就是这个先后）
          adapter(1, '追问那一段的答复', 'a1'),
          message({ id: 'f1', mergeKey: 'main|1|user|-|followup:f1', roundTrip: 1, role: 'user', origin: 'human', source: 'hook', segment: 1, blocks: [{ type: 'text', text: '逐句用普通话解释诗意' }] }),
        ],
        events: [],
        facts: facts(),
        startedAt: null,
      });
      const main = model.nodes.find((node) => node.kind === 'main');
      if (main?.content.status !== 'ready') throw new Error('主会话内容应就绪');

      // 那句人话是这一段的**标题**：它进 `segments`，不进轮次的展示块（同一句话不许画两遍）
      expect(model.segments).toEqual([{ segment: 1, at: '', text: '逐句用普通话解释诗意' }]);
      const second = main.content.data.find((turn) => turn.segment === 1);
      expect(second?.blocks.map((block) => (block.kind === 'text' ? block.text : ''))).toEqual(['追问那一段的答复']);
      // 换序**不改变轮次归属**：那两条仍是同一个 `(段 1, 轮次 1)`，不多出一个轮次
      expect(main.content.data.filter((turn) => turn.segment === 1).map((turn) => [turn.segment, turn.round])).toEqual([[1, 1]]);
      /**
       * 兜底定位键跟着**投递顺序**走：这一段投递的第一条是那句答复（`id: 'a1'`），
       * 它才是 `buildRenderBlocks` 规则 3 该拿到的 `messageId`——若把这一格改读展示块的第一条，
       * 值会落到别处，派发点的兜底判据从此认错消息。
       */
      expect(second?.fallbackMessageId).toBe('a1');
    });

    it('同一段里的两句人话：凑成一个段标题，且保持投递顺序', () => {
      const human = (id: string, text: string, segment?: number): RowRecord =>
        message({ id, mergeKey: `main|1|user|-|inject:${id}`, roundTrip: 1, role: 'user', origin: 'human', source: 'hook', ...(segment === undefined ? {} : { segment }), blocks: [{ type: 'text', text }] });
      const model = buildAgentLogModel({
        records: [
          adapter(undefined, '首段的答复'),
          // 首段里运行中插进去的一句（段 0）：它不属于任何段标题，照旧留在轮次里
          human('h0', '首段里插的一句话'),
          human('h1', '第一句追问里的话', 1),
          human('h2', '第二句话', 1),
        ],
        events: [],
        facts: facts(),
        startedAt: null,
      });
      const main = model.nodes.find((node) => node.kind === 'main');
      if (main?.content.status !== 'ready') throw new Error('主会话内容应就绪');

      // 段 0 的注入话在轮次里、且排在答复之前
      expect(main.content.data[0]?.blocks.map((block) => (block.kind === 'text' ? block.text : ''))).toEqual([
        '首段里插的一句话',
        '首段的答复',
      ]);
      // 段 1 的两句话合成一个段标题，顺序按投递（写反了就是「我说的话顺序变了」）
      expect(model.segments.map((one) => one.text)).toEqual(['第一句追问里的话\n第二句话']);
    });

    it('同一轮两条人话：都排在全部助手块之前，且两条人话之间保持投递顺序', () => {
      const human = (id: string, text: string): RowRecord =>
        message({ id, mergeKey: `main|1|user|-|inject:${id}`, roundTrip: 1, role: 'user', origin: 'human', source: 'hook', blocks: [{ type: 'text', text }] });
      const model = buildAgentLogModel({
        records: [
          adapter(undefined, '答复'),
          human('h1', '第一句人话'),
          human('h2', '第二句人话'),
        ],
        events: [],
        facts: facts(),
        startedAt: null,
      });
      const main = model.nodes.find((node) => node.kind === 'main');
      if (main?.content.status !== 'ready') throw new Error('主会话内容应就绪');

      // 稳定分区：人话在前、人话之间不重排（写反了就是「我说的话顺序变了」）
      expect(main.content.data[0]?.blocks.map((block) => (block.kind === 'text' ? block.text : ''))).toEqual([
        '第一句人话',
        '第二句人话',
        '答复',
      ]);
      // 段 0 的一句人话**不进段标题**（首段的分界是题面那张卡片）
      expect(model.segments).toEqual([]);
    });
  });
});
