/**
 * `agent-log` 的**夹具**：三家智能体各一份「真实形状」的记录序列。
 *
 * 为什么需要它：抽屉的输入（`AgentLogModel`）在真实评测落地前拿不到全部形态——
 * `task` 面板、`ask-user` 问答、附件、未识别载荷、子任务轨迹这些**只有跑过才有**，
 * 而它们恰恰是这一轮重构的主要目标。夹具让「每一类消息都画得出来」这件事
 * 在浏览器里可验、在单测里可回归。
 *
 * 三条口径：
 *   1. **夹具走真实链路**：这里是 `messages.jsonl` 的行（`RowRecord`）+ 行级事件，
 *      不是「已建好的 `AgentLogModel`」——它必须经过 `buildAgentLogModel`
 *      与 `buildRenderBlocks` 才能上屏，否则夹具能过而真实数据过不了。
 *   2. **认不出来的字段照给**：`unrecognized` 那一类必须有一条，
 *      否则「不认识的厂商载荷有没有出口」这件事永远验不到。
 *   3. **`null` 就是 `null`**：拿不到的量一律留空，不用 0 或空串冒充
 *      （夹具要是自己就不守这条，界面上的「未采集」就永远测不出来）。
 */
import type { AgentEvent, AgentMessage, RowRecord } from '@aieval/contracts';
import { buildAgentLogModel, type AgentLogFactsInput } from './build-model';
import type { AgentEnvironment, AgentLogModel, MessageCapabilityMap } from './types';

/** 夹具的时间基准（固定的，免得每次生成的模型都不同） */
const T0 = Date.parse('2026-10-02T10:44:31.000Z');

/** 第 n 秒的时刻（ISO） */
function at(seconds: number): string {
  return new Date(T0 + seconds * 1000).toISOString();
}

/** 一条消息信封的公共部分 */
interface MessageInput {
  /** 第几个模型往返（= 统一轮次号 `round`） */
  roundTrip: number;
  role: AgentMessage['role'];
  source?: AgentMessage['source'];
  assembly?: AgentMessage['assembly'];
  subagentId?: string | null;
  parentCallId?: string | null;
  blocks: AgentMessage['blocks'];
  /** 同一条逻辑消息的后续投递（块追加 / 快照覆盖）：`mergeKey` 相同、`messageId` 不同 */
  update?: boolean;
}

let seq = 0;

/** 造一条 `messages.jsonl` 的记录（`mergeKey` 的拼法与适配器逐字相同） */
function message(input: MessageInput): RowRecord {
  seq += 1;
  const subagentId = input.subagentId ?? null;
  const parentCallId = input.parentCallId ?? null;
  const mergeKey = `${subagentId ?? 'main'}|${input.roundTrip}|${input.role}|${parentCallId ?? '-'}`;
  return {
    type: 'message',
    message: {
      messageId: `fixture:${input.update === true ? 'u' : 'm'}${seq}`,
      vendorId: null,
      role: input.role,
      source: input.source ?? 'wire',
      roundTrip: input.roundTrip,
      turn: null,
      step: null,
      parentCallId,
      subagentId,
      chunk: 'snapshot',
      assembly: input.assembly ?? 'snapshot',
      mergeKey,
      blocks: input.blocks,
      raw: null,
    },
  };
}

function subagentRecord(input: {
  subagentId: string;
  name: string | null;
  kind: string | null;
  source?: 'wire' | 'hook' | 'session-file' | 'aggregate';
  status: 'running' | 'completed' | 'failed' | 'stopped' | 'unknown';
  statusMissing?: 'not-supported' | 'not-exposed' | 'not-observed' | 'unverified' | null;
  outcome: string | null;
  /**派生它的那次工具调用 id；界面据此把「进入子任务」入口挂到那次调用上 */
  parentCallId?: string | null;
  parentSubagentId?: string | null;
  usage?: { input: number; cached: number; output: number } | null;
}): RowRecord {
  return {
    type: 'subagent',
    subagent: {
      subagentId: input.subagentId,
      name: input.name,
      kind: input.kind,
      source: input.source ?? 'wire',
      status: input.status,
      statusMissing: input.statusMissing ?? null,
      outcome: input.outcome,
      /** 派生它的那次工具调用 id；夹具显式给（界面据此画「进入子任务」入口） */
      parentCallId: input.parentCallId ?? null,
      parentSubagentId: input.parentSubagentId ?? null,
      usage: input.usage ?? null,
    },
  };
}

/** 能力声明：五格齐全（`yes` 带 `source`，其余带 `reason`） */
function capability(overrides: Partial<MessageCapabilityMap> = {}): MessageCapabilityMap {
  return {
    thinkingText: { level: 'yes', source: 'wire', reason: null },
    toolInput: { level: 'yes', source: 'wire', reason: null },
    toolResult: { level: 'yes', source: 'wire', reason: null },
    subagent: { level: 'yes', source: 'wire', reason: null },
    streamingDelta: { level: 'yes', source: 'wire', reason: null },
    ...overrides,
  };
}

/** 行级事实的默认值（各夹具按需覆盖） */
function facts(overrides: Partial<AgentLogFactsInput> = {}): AgentLogFactsInput {
  return {
    status: { tone: 'ok', label: '已评分' },
    startedAt: at(0),
    endedAt: at(180),
    /**
     * 夹具的轮次与真实数据层同口径：`current` = 已经观察到几轮、`total` 在真实链路里恒为 `null`（codex / claude 两份夹具写了具体值，但**上不了屏**——组装层会把 `turns` 整格重写成 `total: null`）
     * （不是「一共几轮」）。模型组装会用时间轴自己的轮次数覆盖 `current`，故这里写什么都不会
     * 影响上屏的读数——但夹具要是写成一个会走动的 `total`，读的人会以为界面能显示「一共几轮」。
     */
    turns: { current: 3, total: null },
    tokens: { input: 218, cached: 8832, output: 1420 },
    thinking: { tokens: 640, basis: 'subset-of-output' },
    domain: [
      // 与数据层同形：**智能体 · 模型 · 思考强度 · 改动 · 评分**五格、顺序即渲染顺序
      // （前三格是「谁在跑」，后两格是「改了多少 / 得了多少分」）；评分那一格**只给分**
      // （「评分模型：…」那句提示不在事实条上，见 `log-drawer-state.ts`）
      {
        id: 'agent',
        label: '智能体',
        value: 'Claude Code',
        segments: [{ text: 'Claude Code', tag: true, tagTone: 'blue' }],
      },
      {
        id: 'model',
        label: '模型',
        value: 'claude-opus-4-6',
        segments: [{ text: 'claude-opus-4-6', tag: true, tagTone: 'geekblue' }],
      },
      {
        id: 'effort',
        label: '思考强度',
        value: 'max',
        segments: [{ text: 'max', tag: true, tagTone: 'purple' }],
      },
      {
        id: 'diff',
        label: '改动',
        value: '3 个文件 +12 −3',
        segments: [
          { text: '3 个文件 ' },
          { text: '+12', tone: 'insertion' },
          { text: ' −3', tone: 'deletion' },
        ],
      },
      {
        id: 'score',
        label: '评分',
        value: '8/10',
        tone: 'success',
      },
    ],
    error: null,
    live: false,
    ...overrides,
  };
}

/** 一条 `log` 事件的原文（原始输出面板的输入） */function logEvent(seconds: number, stream: 'stdout' | 'stderr', text: string, summary?: string): AgentEvent {
  seq += 1;
  return {
    seq,
    at: at(seconds),
    type: 'log',
    stream,
    text,
    ...(summary === undefined ? {} : { summary }),
  } as AgentEvent;
}

function statusEvent(seconds: number, status: 'running' | 'judged'): AgentEvent {
  seq += 1;
  return { seq, at: at(seconds), type: 'status', status } as AgentEvent;
}

function usageEvent(seconds: number, input: number, cached: number, output: number, turns: number): AgentEvent {
  seq += 1;
  return {
    seq,
    at: at(seconds),
    type: 'usage',
    tokens: { input, cached, output, reasoningOutput: null, total: null },
    turns,
    timing: null,
  } as AgentEvent;
}

function errorEvent(seconds: number, message: string): AgentEvent {
  seq += 1;
  return { seq, at: at(seconds), type: 'error', code: 'AGENT_FAILED', message } as AgentEvent;
}

/**
 * 环境抽屉的夹具：**四组齐全**（提示词栈的四层），并且**每一层都有 `present: false` 的条目**——
 * 「这一格没有」必须带原因，而原因不许被隐藏。
 *
 * 两处刻意安排：
 *   · 「已调度的工具」（`vendor`）与「用过的工具」（`observed`）**分列两组**：混成一组就会出现
 *     「列了 30 个工具，其实只用了 2 个」；
 *   · **没有「用户提示词」这一条**——它是对话、不是环境配置（它在时间轴的首条消息里）。
 *
 * 第一参是**显示名**（`agentLabel`，如「DeepSeek Harness」）而不是 kind：真机上这一格由
 * `client/build-environment.ts` 的 `summaryOf` 映射好（口径：页面展示不用缩写），
 * 夹具照真形状给 ⇒ 把 kind 传进来就不再是「真机上会出现的形态」。
 */
export function environmentFixture(agentLabel: string, modelId: string): AgentEnvironment {
  return {
    summary: {
      agentLabel,
      modelId,
      effort: null,
      providerName: '本地网关',
      baseUrl: 'https://gateway.internal/v1',
      workspaceBase: 'D:\\aieval\\runs\\run-7\\rows\\row-2\\workspace',
      baselineCommit: '4f1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c',
    },
    groups: [
      {
        id: 'user',
        title: '用户层',
        source: 'user',
        items: [
          { present: true, id: 'context', label: '上下文引用', text: '@packages/client/ui/src/composite/agent-log/render-blocks.ts', truncated: null, at: at(0) },
          { present: false, id: 'resume', label: '会话续接', missing: 'not-supported' },
        ],
      },
      {
        id: 'vendor',
        title: '系统层（厂商）',
        source: 'vendor',
        items: [
          { present: true, id: 'system', label: '系统提示词', text: 'You are a coding agent. Follow the repository conventions.', truncated: { reason: '超过 8 KB', bytes: 12_288 }, at: null },
          { present: true, id: 'tools', label: '已调度的工具', text: 'read_file · apply_patch · pwsh · spawn_agent · todo_write · ask_user_question', truncated: null, at: null },
          { present: false, id: 'slash', label: '斜杠命令 / 子智能体定义', missing: 'not-exposed' },
        ],
      },
      {
        id: 'project',
        title: '运行配置',
        source: 'project',
        items: [
          { present: true, id: 'permission', label: '权限档', text: 'never（无人值守：审批一律拒绝）', truncated: null, at: null },
          { present: true, id: 'workspace', label: '工作区与基线', text: 'D:\\aieval\\runs\\run-7\\rows\\row-2\\workspace @ 4f1a2b3c', truncated: null, copyPath: 'D:\\aieval\\runs\\run-7\\rows\\row-2\\workspace', at: null },
          { present: false, id: 'disallowed', label: '被禁用的工具', missing: 'unverified' },
        ],
      },
      {
        id: 'observed',
        title: '实测统计',
        source: 'observed',
        items: [{ present: true, id: 'used-tools', label: '用过的工具及次数', text: 'read_file ×1 · pwsh ×1 · todo_write ×1 · spawn_agent ×1', truncated: null, at: null }],
      },
    ],
  };
}

export interface AgentLogFixture {
  name: string;
  /** 这一份夹具要证明的那件事（冒烟清单里逐条核对） */
  proves: string;
  model: AgentLogModel;
  events: AgentEvent[];
  capability: MessageCapabilityMap;
  capabilityNotes: readonly string[];
  /** 环境抽屉的内容（`present: false` 的条目也要有一条：缺失原因不许被隐藏） */
  environment: AgentEnvironment;
}

/**
 * `dsh`：**覆盖得最全的一份**——计划清单、等待答复、子任务、附件、未识别载荷、孤立工具结果。
 * 它同时是「块角色与来源标注」的载体（用户消息与系统消息各一条）。
 */
export function dshFixture(): AgentLogFixture {
  seq = 0;
  /** 计划清单：**故意让状态值五花八门**——`unknown` 那一档很常见，不许被显示成成功 */
  const todos = [
    { id: '1', subject: '修好 build 脚本', status: 'completed' },
    { id: '2', subject: '跑一遍测试', status: 'in_progress', owner: 'me' },
    { id: '3', subject: '更新 README', status: 'pending' },
    { id: '4', subject: '打 tag', status: 'whatever-this-is' },
  ];
  const records: RowRecord[] = [
    // ① 第 1 轮：用户消息（一次会话可以有多个用户轮）+ 思考 + 工具调用（结果随后到达）
    message({
      roundTrip: 1,
      role: 'user',
      blocks: [{ type: 'text', text: '帮我把 `build` 脚本修好，然后跑一遍测试。' }],
    }),
    message({
      roundTrip: 1,
      role: 'assistant',
      blocks: [
        { type: 'thinking', text: '先看看 package.json 里的脚本长什么样。', textKind: 'full', signature: null },
        { type: 'tool-call', callId: 'call_1', family: 'read-file', name: 'read_file', input: { path: 'package.json' } },
      ],
    }),
    // 同一条逻辑消息的第二次投递：块追加（`mergeKey` 相同 ⇒ **覆盖**，不是追加两遍）
    message({
      roundTrip: 1,
      role: 'assistant',
      update: true,
      blocks: [
        { type: 'thinking', text: '先看看 package.json 里的脚本长什么样。', textKind: 'full', signature: null },
        { type: 'tool-call', callId: 'call_1', family: 'read-file', name: 'read_file', input: { path: 'package.json' } },
        {
          type: 'tool-result',
          callId: 'call_1',
          structured: null,
          isError: false,
          text: '{\n  "scripts": {\n    "build": "next build"\n  }\n}',
          truncation: { kind: 'none' },
        },
      ],
    }),

    // ② 第 2 轮：计划清单（族载荷）+ 一次失败的命令 + 一条**配不上调用**的结果
    message({
      roundTrip: 2,
      role: 'assistant',
      blocks: [
        /**
         * 清单载荷：**归一后的 `payload` 由适配器给**，
         * `input` 里留的是厂商原文（排障证据，界面不再读它）。
         * 两条都给，才既测到「卡片画得出来」又测到「界面没在偷看原文」。
         *
         * 四档状态**逐条写死**（不从上方的 `todos` 推）：`whatever-this-is` 那一档必须落
         * `unknown`，而推导式的映射很容易把它顺手归进 `pending`——那正是这条夹具要拦的误读。
         */
        {
          type: 'tool-call',
          callId: 'call_task',
          family: 'task',
          name: 'todo_write',
          input: { todos },
          payload: {
            kind: 'plan',
            note: '先修红的那条',
            steps: [
              { id: '1', subject: '修好 build 脚本', status: 'completed', owner: null, blockedBy: null },
              { id: '2', subject: '跑一遍测试', status: 'inProgress', owner: 'me', blockedBy: null },
              { id: '3', subject: '更新 README', status: 'pending', owner: null, blockedBy: null },
              { id: '4', subject: '打 tag', status: 'unknown', owner: null, blockedBy: null },
            ],
          },
        },
        { type: 'tool-call', callId: 'call_9', family: 'run-shell', name: 'pwsh', input: { command: 'pnpm vitest run' } },
        {
          type: 'tool-result',
          callId: 'call_9',
          structured: null,
          isError: true,
          text: 'FAIL packages/client/ui/src/composite/agent-log/render-blocks.test.ts',
          truncation: { kind: 'truncated', reason: '超过 256 KB' },
        },
        // 这条结果的 `callId` 在本轮找不到调用 ⇒ 降级成独立条目（**不丢弃、不认领给别人**）
        {
          type: 'tool-result',
          callId: 'call_lost',
          structured: null,
          isError: false,
          text: '这条结果配不上任何调用——它仍然要出现在时间轴上',
          truncation: { kind: 'unknown' },
        },
      ],
    }),

    // ③ 第 3 轮：派子任务 + 附件两条（一条有路径、一条内联）+ 一条未识别载荷
    message({
      roundTrip: 3,
      role: 'assistant',
      blocks: [
        { type: 'tool-call', callId: 'call_spawn', family: 'spawn-agent', name: 'spawn_agent', input: { name: 'fix-tests', prompt: '把红的那条修好' } },
        { type: 'tool-result', callId: 'call_spawn', structured: null, isError: false, text: '子任务已启动', truncation: { kind: 'none' } },
        { type: 'attachment', kind: 'image', path: '/tmp/screenshots/red-test.png', mimeType: 'image/png' },
        { type: 'attachment', kind: 'file', path: null, mimeType: 'application/pdf' },
      ],
    }),
    // 未识别载荷：我们认不出这个东西 ⇒ 兜底原文（默认折叠），**不与附件走同一条路**
    message({
      roundTrip: 3,
      role: 'system',
      source: 'aggregate',
      blocks: [
        { type: 'unrecognized', reason: 'unrecognized', vendorType: 'session/title', raw: '{"title":"修 build 脚本"}' },
      ],
    }),

    // ④ 第 4 轮：等待答复（无人值守时会一直等到轮次被取消）
    message({
      roundTrip: 4,
      role: 'assistant',
      assembly: 'open',
      blocks: [
        {
          type: 'tool-call',
          callId: 'call_ask',
          family: 'ask-user',
          name: 'ask_user_question',
          input: {
            questions: [
              {
                header: '发布范围',
                question: '这次要发到哪个环境？',
                options: [
                  { label: '预发', description: '先验证一遍', recommended: true },
                  { label: '生产', description: '直接上生产' },
                ],
                multiSelect: false,
                allowOther: true,
              },
              {
                header: '凭据',
                question: '粘贴发布用的 token',
                options: [],
                multiSelect: false,
                allowOther: false,
                secret: true,
              },
            ],
          },
          /**
           * 归一后的载荷（适配器给）：`question` → `prompt` 的改名、缺省布尔补全都在上游做完。
           * 第二个问题刻意留 `header: ''`（dsh 的 `header` 可选）——卡片对空 `header` 不画空 Tag。
           */
          payload: {
            kind: 'ask-user',
            questions: [
              {
                header: '发布范围',
                prompt: '这次要发到哪个环境？',
                options: [
                  { label: '预发', description: '先验证一遍', recommended: true },
                  { label: '生产', description: '直接上生产', recommended: false },
                ],
                multiSelect: false,
                allowOther: true,
                secret: false,
              },
              {
                header: '',
                prompt: '粘贴发布用的 token',
                options: [],
                multiSelect: false,
                allowOther: false,
                secret: true,
              },
            ],
          },
        },
        { type: 'text', text: '在等你选发布环境——**这一步在无人值守的运行里会一直等到轮次被取消**。' },
      ],
    }),

    // ⑤ 子任务：自己的轨迹（与主会话**同一份渲染**）
    message({
      roundTrip: 1,
      role: 'user',
      subagentId: 'sub-7f3a91c2',
      parentCallId: 'call_spawn',
      blocks: [{ type: 'text', text: '把红的那条修好' }],
    }),
    message({
      roundTrip: 1,
      role: 'assistant',
      subagentId: 'sub-7f3a91c2',
      parentCallId: 'call_spawn',
      source: 'session-file',
      blocks: [
        { type: 'thinking', text: null, textKind: 'none', signature: null },
        { type: 'tool-call', callId: 'sub_call_1', family: 'edit-file', name: 'apply_patch', input: { patch: '*** Update File: render-blocks.ts' } },
        { type: 'tool-result', callId: 'sub_call_1', structured: null, isError: false, text: 'Done!', truncation: { kind: 'none' } },
        { type: 'text', text: '修好了：`callId` 为 `null` 的结果不再被丢弃。' },
      ],
    }),
    subagentRecord({
      subagentId: 'sub-7f3a91c2',
      name: null,
      kind: 'spawn_agent',
      status: 'completed',
      outcome: '修好了：callId 为 null 的结果不再被丢弃。',
      usage: { input: 120, cached: 2048, output: 300 },
    }),
    // 第二个子任务：**未收场**（被强杀，收场事件永远没到）——不许显示成「运行中」
    subagentRecord({
      subagentId: 'sub-deadbeef',
      name: '跑全量测试',
      kind: 'spawn_agent',
      status: 'unknown',
      statusMissing: 'not-observed',
      outcome: null,
      parentSubagentId: 'sub-7f3a91c2',
    }),
  ];

  const events: AgentEvent[] = [
    statusEvent(0, 'running'),
    logEvent(1, 'stdout', '[dsh] session.event {"method":"session.event","params":{"type":"turn/start"}}', '收到一条未识别的厂商事件'),
    usageEvent(40, 218, 8832, 640, 2),
    logEvent(60, 'stderr', '[WARN] 用量负载不完整：timing 缺失'),
    errorEvent(150, '有一条工具调用返回了非零退出码'),
    usageEvent(160, 418, 9000, 1420, 4),
    statusEvent(180, 'judged'),
  ];

  return {
    name: 'dsh',
    proves: '全部块类型 + 计划清单 + 等待答复 + 子任务（含未收场）+ 附件 + 孤立结果 + 原始输出',
    events,
    capability: capability(),
    capabilityNotes: ['deepseek-v4 路由下多智能体不可用'],
    environment: environmentFixture('DeepSeek Harness', 'deepseek-v4'),
    model: buildAgentLogModel({
      records,
      events,
      facts: facts(),
      startedAt: at(0),
      userPrompt: { text: '帮我把 `build` 脚本修好，然后跑一遍测试。', at: at(0) },
      capability: capability(),
      capabilityNotes: ['deepseek-v4 路由下多智能体不可用'],
    }),
  };
}

/**
 * `codex`：**补录与摘要**那一档——思考正文来自会话文件（运行结束后才有），
 * 事件流那一格只有「推理摘要」。界面上两者必须长得不一样（「补录」角标 + 「摘要」标签）。
 */
export function codexFixture(): AgentLogFixture {
  seq = 0;
  const records: RowRecord[] = [
    message({
      roundTrip: 1,
      role: 'assistant',
      source: 'session-file',
      blocks: [
        { type: 'thinking', text: '先复现一次，再看命令输出的最后 20 行。', textKind: 'summary', signature: null },
        { type: 'tool-call', callId: 'cc_1', family: 'run-shell', name: 'shell', input: { command: '["bash","-lc","pnpm test"]' } },
        { type: 'tool-result', callId: 'cc_1', structured: null, isError: false, text: 'Tests  12 passed (12)', truncation: { kind: 'none' } },
      ],
    }),
    message({
      roundTrip: 2,
      role: 'assistant',
      blocks: [{ type: 'text', text: '12 条用例全绿。\n\n```\nTests  12 passed (12)\n```' }],
    }),
    // 行级汇总节点的那一档：厂商只给计数、没有逐条身份
    subagentRecord({
      subagentId: 'aggregate-1',
      name: null,
      kind: null,
      source: 'aggregate',
      status: 'completed',
      outcome: null,
    }),
  ];

  const events: AgentEvent[] = [statusEvent(0, 'running'), usageEvent(30, 90, 0, 240, 2), statusEvent(60, 'judged')];

  return {
    name: 'codex',
    proves: '「补录」角标 + 「摘要」标签 + 只用汇总计数的那一档（`kind: \'row\'` 的说明行）',
    events,
    capability: capability({
      thinkingText: { level: 'not-projected-by-vendor', source: null, reason: 'not-exposed' },
      streamingDelta: { level: 'no', source: null, reason: 'not-supported' },
    }),
    capabilityNotes: [],
    environment: environmentFixture('Codex', 'gpt-5-codex'),
    model: buildAgentLogModel({
      records,
      events,
      facts: facts({ turns: { current: 2, total: 2 }, thinking: null }),
      startedAt: at(0),
      capability: capability({ streamingDelta: { level: 'no', source: null, reason: 'not-supported' } }),
    }),
  };
}

/**
 * `claude-code`：**「有内容但这一类没被转发」**那一档。
 * 子任务只投送了工具调用与结果、没有一句 assistant 正文 —— 界面必须如实说明
 * 「该子任务的对话未转发」，而**不能**渲染成「它什么都没说」。
 */
export function claudeFixture(): AgentLogFixture {
  seq = 0;
  const records: RowRecord[] = [
    message({
      roundTrip: 1,
      role: 'assistant',
      blocks: [
        { type: 'tool-call', callId: 'cl_1', family: 'spawn-agent', name: 'Task', input: { description: '整理变更清单', subagent_type: 'general-purpose' } },
        { type: 'tool-result', callId: 'cl_1', structured: null, isError: false, text: '子智能体已完成', truncation: { kind: 'none' } },
      ],
    }),
    message({
      roundTrip: 1,
      role: 'assistant',
      subagentId: 'agent-9c1f',
      parentCallId: 'cl_1',
      source: 'session-file',
      blocks: [
        { type: 'tool-call', callId: 'cl_sub_1', family: 'list-files', name: 'Glob', input: { pattern: '**/*.ts' } },
        { type: 'tool-result', callId: 'cl_sub_1', structured: null, isError: false, text: 'src/index.ts\nsrc/app.ts', truncation: { kind: 'none' } },
      ],
    }),
    subagentRecord({
      subagentId: 'agent-9c1f',
      name: '整理变更清单',
      kind: 'Task',
      source: 'aggregate',
      status: 'completed',
      outcome: null,
      usage: { input: 40, cached: 0, output: 0 },
    }),
  ];

  const events: AgentEvent[] = [statusEvent(0, 'running'), statusEvent(45, 'judged')];

  return {
    name: 'claude-code',
    proves: '「该子任务的对话未转发」这一档（有工具块、无 assistant 正文，不写成「它什么都没说」）',
    events,
    capability: capability({ subagent: { level: 'yes', source: 'aggregate', reason: null } }),
    capabilityNotes: ['forwardSubagentText 未开启'],
    environment: environmentFixture('Claude Code', 'claude-sonnet-4-5'),
    model: buildAgentLogModel({
      records,
      events,
      facts: facts({ turns: { current: 1, total: 1 }, thinking: null, tokens: { input: 40, cached: 0, output: 0 } }),
      startedAt: at(0),
      capability: capability({ subagent: { level: 'yes', source: 'aggregate', reason: null } }),
      capabilityNotes: ['forwardSubagentText 未开启'],
    }),
  };
}

/** 三份夹具（冒烟页与单测共用同一份清单） */
export function allFixtures(): AgentLogFixture[] {
  return [dshFixture(), codexFixture(), claudeFixture()];
}
