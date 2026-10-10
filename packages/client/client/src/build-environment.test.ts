// @vitest-environment node
/**
 * **环境信息的拼装**——四组的分法、缺失原因、以及「谁下发的」这件事。
 *
 * 为什么这一层必须有守卫：四组里每一格都在回答「这条要求是谁下发的」，而**判错的后果不是缺一格**，
 * 而是把厂商下发的说成本仓下发的（或反过来）——使用者据此去改一个根本不存在配置。
 * 而它在界面上长得完全一样：一个 `present: false` + 一句原因，与一个「我们没接」的格子
 * 只差那四个字。故这里逐格钉住**原因**，不只是「有没有」。
 *
 * 夹具里的 `system/init` 行**逐字取自真机**（`D:\.tmp\aieval\runs\…\events.jsonl`）：
 * claude-code 报 `tools` / `slash_commands` / `agents` / `permissionMode` / `output_style`，
 * 而 codex 与 dsh 的事件流里**没有这一类行**（逐份扫过）——那是 `not-exposed` 而不是 `not-observed`。
 */
import { describe, expect, it } from 'vitest';
import {
  CODEX_MCP_DISPATCH_GAP_NOTE,
  EFFORT_OFF,
  type AgentEvent,
  type EnvGroup,
  type EnvItem,
  type EvalRow,
  type RowRecord,
} from '@aieval/contracts';
import { ENV_GROUP_ORDER, buildAgentEnvironment, envItem } from './build-environment';

const ROW = {
  id: 'row-1',
  agentKind: 'claude-code',
  providerId: 'p-1',
  providerName: 'deepseek-anthropic',
  baseUrl: 'https://api.deepseek.com/anthropic',
  modelId: 'deepseek-flash',
  status: 'judged',
  branch: 'test/row-1',
  workspacePath: 'D:/tmp/runs/run-1/rows/row-1/workspace',
  baselineCommit: '1cf3c821116213b69de72df99b39d071639f7159',
  tokens: null,
  turns: 4,
  durationMs: 1000,
  diff: null,
  score: null,
  error: null,
  attempts: 1,
  effort: 'high',
} as unknown as EvalRow;

/** 真机 claude 的 `system/init` 行（裁到与本文件断言相关的字段） */
const CLAUDE_INIT = JSON.stringify({
  type: 'system',
  subtype: 'init',
  cwd: ROW.workspacePath,
  session_id: '46b942f5-2a6f-4dc0-99b4-73d142bff375',
  tools: ['Task', 'Bash', 'Read', 'Write'],
  slash_commands: ['design', 'verify'],
  agents: ['claude', 'Explore'],
  mcp_servers: [],
  model: 'deepseek-flash[1m]',
  permissionMode: 'bypassPermissions',
  claude_code_version: '2.0.1',
  output_style: 'default',
});

function logEvent(text: string, seq = 1): AgentEvent {
  return { seq, at: '2026-10-03T10:00:00.000Z', type: 'log', stream: 'stdout', text };
}

/**
 * **归一后的**厂商系统层事件。
 *
 * 这一格现在由适配器产出（claude 的 `system/init` 在 `providers/claude-code/events.ts` 里归一），
 * 数据层只读它——**不再解析那条原始 JSON 日志**。默认值逐字取自真机那一行。
 */
function vendorSystemEvent(
  facts: Partial<Omit<Extract<AgentEvent, { type: 'vendor-system' }>, 'seq' | 'at' | 'type'>> = {},
  seq = 1,
): AgentEvent {
  return {
    seq,
    at: '2026-10-03T10:00:00.000Z',
    type: 'vendor-system',
    tools: ['Task', 'Bash', 'Read', 'Write'],
    slashCommands: ['design', 'verify'],
    agents: ['claude', 'Explore'],
    mcpServers: [],
    permissionMode: 'bypassPermissions',
    outputStyle: 'default',
    ...facts,
  };
}

/**
 * **历史形态**的厂商系统层事件（更早落盘的 `events.jsonl`）：`mcpServers` 是字符串数组。
 *
 * `as unknown as AgentEvent` 是刻意的：契约的读侧归一（`normalizeMcpServers`）会把它读成对象，
 * 而客户端的 `/log` 是 `getJson<AgentEvent[]>`——**没有运行时校验**，所以这一层真会拿到这个形状。
 * 用类型系统挡住它就等于把「历史事件仍能渲染」这条守卫测不到。
 */
function legacyMcpEvent(mcpServers: string[]): AgentEvent {
  return { ...vendorSystemEvent(), mcpServers } as unknown as AgentEvent;
}

/** 取「已下发的 MCP 服务」那一格（格子不存在或本该在场却缺席时抛，免得静默通过） */
function mcpItemOf(environment: ReturnType<typeof buildAgentEnvironment>): Extract<EnvItem, { present: true }> {
  const item = groupOf(environment.groups, 'vendor').items.find((entry) => entry.id === 'vendor-mcp-servers');
  if (item === undefined) throw new Error('厂商系统层里没有 vendor-mcp-servers');
  if (!item.present) throw new Error(`vendor-mcp-servers 本该在场，实际是缺失格（${item.missing}）`);
  return item;
}

/**
 * 一条工具调用记录。**`mergeKey` 必须逐条不同**：同一个键的后一条会在折叠时覆盖前一条
 * （那是合并器的正确行为），于是「用了三次」会被压成一次。
 */
function toolCall(name: string, id: string): RowRecord {
  return {
    type: 'message',
    message: {
      messageId: `m-${id}`,
      vendorId: null,
      role: 'assistant',
      source: 'wire',
      roundTrip: 1,
      turn: null,
      step: null,
      parentCallId: null,
      subagentId: null,
      chunk: 'snapshot',
      assembly: 'snapshot',
      mergeKey: `main|1|assistant|${id}`,
      blocks: [{ type: 'tool-call', callId: id, family: null, name, input: null }],
      raw: null,
    },
  } as unknown as RowRecord;
}

function build(events: AgentEvent[], records: RowRecord[] = []): ReturnType<typeof buildAgentEnvironment> {
  return buildAgentEnvironment({ row: ROW, workspaceBase: 'D:/tmp/runs/run-1', events, records });
}

/** 按 `source` 取组（组的顺序是另一条断言的事，这里只看内容） */
function groupOf(groups: readonly EnvGroup[], source: string): EnvGroup {
  const group = groups.find((entry) => entry.source === source);
  if (group === undefined) throw new Error(`没有 ${source} 这一组`);
  return group;
}

/** 取一格的 `missing`（格子不存在时抛，免得静默通过） */
function missingOf(group: EnvGroup, id: string): string {
  const item = group.items.find((entry) => entry.id === id);
  if (item === undefined) throw new Error(`${group.id} 里没有 ${id}`);
  if (item.present) throw new Error(`${id} 本该是缺失格，实际有内容`);
  return item.missing;
}

describe('buildAgentEnvironment：摘要与四组', () => {
  /**
   * 摘要第一格给的是**显示名**（页面展示不用缩写）。
   *
   * 为什么映射必须在数据层：L0 渲染件里查 `AGENT_LABELS` 就是「UI 判厂商」，
   * `agent-log-layering.test.ts` 的 (e) 条会当场红——所以这一格必须在这里就换好，
   * 抽屉只负责画。取不到就**原样回落**（kind 是字符串：老快照与将来第四家都不许编名字）。
   */
  it('摘要的「智能体」是显示名，认不出的 kind 原样回落', () => {
    expect(build([], []).summary.agentLabel).toBe('Claude Code');
    // 认不出的那一档：`row.agentKind` 在契约里是联合类型，但老快照 / 坏数据会是别的串
    expect(
      buildAgentEnvironment({
        row: { ...ROW, agentKind: 'cursor' } as unknown as EvalRow,
        workspaceBase: 'D:/tmp/runs/run-1',
        events: [],
        records: [],
      }).summary.agentLabel,
    ).toBe('cursor');
  });

  it('摘要七格全部来自行与轮的快照字段（不读事件流）', () => {
    const environment = build([], []);
    expect(environment.summary).toEqual({
      agentLabel: 'Claude Code',
      modelId: 'deepseek-flash',
      // 记的是**我们要求的**档位，不是实际生效的（厂商可能静默降档）
      effort: 'high',
      providerName: 'deepseek-anthropic',
      baseUrl: 'https://api.deepseek.com/anthropic',
      workspaceBase: 'D:/tmp/runs/run-1',
      baselineCommit: '1cf3c821116213b69de72df99b39d071639f7159',
    });
  });

  it('四组永远都在，且顺序是 用户层 / 厂商 / 运行配置 / 实测统计', () => {
    const environment = build([], []);
    // 少一整组会让人以为「这一家没有这件事」，而真相常常是「我们没接」
    expect(environment.groups.map((group) => group.source)).toEqual([...ENV_GROUP_ORDER]);
    expect(environment.groups.map((group) => group.title)).toEqual([
      '用户层',
      '系统层（厂商下发）',
      '运行配置（本仓下发）',
      '实测统计',
    ]);
    /**
     * `source` 与 `title` 的**配对**也要钉住（不只是各自那一列）：
     * 组的身份由 `source` 决定，而它是判据的一部分——「已调度的工具」（厂商说它手里有什么）
     * 与「用过的工具」（我们数出来它用了什么）一旦被标成同一个 `source`，
     * 界面就会把两组当同一类来源渲染，而两个列表本身看起来都很正常。
     * 只断言 `sources` 数组的话，把某一组的 `source` 改掉只会让查找落空、不会红。
     */
    expect(environment.groups.map((group) => [group.source, group.title])).toEqual([
      ['user', '用户层'],
      ['vendor', '系统层（厂商下发）'],
      ['project', '运行配置（本仓下发）'],
      ['observed', '实测统计'],
    ]);
    // 组 id 与 source 各自独立：`id` 只用于 React key，界面上看不见
    expect(environment.groups.map((group) => group.id)).toEqual(['user', 'vendor', 'project', 'observed']);
  });

  it('`effort` 没给 ⇒ `null`（未指定 ≠ 某个默认档）', () => {
    const environment = buildAgentEnvironment({
      row: { ...ROW, effort: undefined } as unknown as EvalRow,
      workspaceBase: 'D:/tmp/runs/run-1',
      events: [],
      records: [],
    });
    expect(environment.summary.effort).toBeNull();
  });

  /**
   * 环境抽屉里「模型与思考强度」那一格的**未指定文案**。
   *
   * 为什么这句话值一条用例：契约明说未选档位**不是**「沿用厂商默认档」（DSH 会落到自家缺省
   * `high`，Claude Code / Codex 不传、由厂商推断），而这一格若写成「未指定（沿用厂商默认档）」
   * 就是**与契约相反的读法**。文字错了不会有任何功能报错，只会让人按错误的口径去解释一次跑分
   * （「没指定就是厂商默认嘛」），所以靶子必须是这串文案本身。
   *
   * 厂商名与档位**都不写死**（写死的话即使看的是别家的环境也会印「dsh 走 high」，且写的是 kind
   * 缩写）⇒ 由 `defaultEffort` 入参 + `AGENT_LABELS` 拼，**不给就只说「未指定」**。
   */
  it('`effort` 没给且这一家声明了缺省档 ⇒ 写全名与该档，不是「沿用厂商默认」', () => {
    const project = groupOf(
      buildAgentEnvironment({
        // 真值形状：ROW 是 claude-code，而**只有 dsh** 声明了缺省档 ⇒ 夹具按 dsh 那一家给
        row: { ...ROW, agentKind: 'dsh', effort: undefined } as unknown as EvalRow,
        workspaceBase: 'D:/tmp/runs/run-1',
        events: [],
        records: [],
        defaultEffort: 'high',
      }).groups,
      'project',
    );
    const model = project.items.find((item) => item.id === 'project-model');
    if (model?.present !== true) throw new Error('「模型与思考强度」应当在场');

    expect(model.text).toContain('未指定（由该家适配器决定：DeepSeek Harness 走 high）');
    // 阴性面：kind 缩写与「沿用厂商默认」的读法一个都不许留（否则同一格里有两种说法）
    expect(model.text).not.toContain('dsh');
    expect(model.text).not.toContain('沿用厂商默认');
  });

  /**
   * 这一家**没声明**缺省档（Claude Code / Codex 由厂商推断，或元数据还没到）⇒ 只说「未指定」。
   * 判据是**不许出现括号**：编一个档出来就是替那一家承诺（与创建表单占位符同一条口径）。
   */
  it('`effort` 没给且这一家没声明缺省档 ⇒ 只说「未指定」，不编一个档', () => {
    const project = groupOf(
      buildAgentEnvironment({
        row: { ...ROW, effort: undefined } as unknown as EvalRow,
        workspaceBase: 'D:/tmp/runs/run-1',
        events: [],
        records: [],
      }).groups,
      'project',
    );
    const model = project.items.find((item) => item.id === 'project-model');
    if (model?.present !== true) throw new Error('「模型与思考强度」应当在场');

    expect(model.text.split('\n')[1]).toBe('思考强度：未指定');
  });

  it('`effort` 给了 ⇒ 那一格写的是这一行实际要求的档位', () => {
    const project = groupOf(build([], []).groups, 'project');
    const model = project.items.find((item) => item.id === 'project-model');
    if (model?.present !== true) throw new Error('「模型与思考强度」应当在场');

    expect(model.text).toContain('思考强度：high');
  });

  /**
   * 关闭档那一格：档位照上游词汇原样写，`off` 就是 `off`。
   * 靶子是**这一格的文本**：把关闭档并进「未指定」那一支（`=== undefined || === EFFORT_OFF`
   * 这类写法）这条用例就红——「我要求关掉思考」与「我没选」是两件事。
   */
  it('`effort` 是关闭档 ⇒ 那一格逐字写 `off`（不是「未指定」）', () => {
    const project = groupOf(
      buildAgentEnvironment({
        row: { ...ROW, effort: EFFORT_OFF } as unknown as EvalRow,
        workspaceBase: 'D:/tmp/runs/run-1',
        events: [],
        records: [],
      }).groups,
      'project',
    );
    const model = project.items.find((item) => item.id === 'project-model');
    if (model?.present !== true) throw new Error('「模型与思考强度」应当在场');

    // 整行逐字断言（比 toContain 强）：多一个括号、或写成「未指定」都会让这一条当场红
    expect(model.text.split('\n')[1]).toBe(`思考强度：${EFFORT_OFF}`);
  });
});

describe('buildAgentEnvironment：厂商系统层', () => {
  it('有归一事件 ⇒ 已调度的工具与斜杠命令按原文给（真机形状）', () => {
    const vendor = groupOf(build([vendorSystemEvent()]).groups, 'vendor');
    const tools = vendor.items.find((item) => item.id === 'vendor-tools');
    expect(tools?.present).toBe(true);
    if (tools?.present !== true) throw new Error('工具面应当在场');
    expect(tools.text).toBe('Task\nBash\nRead\nWrite');
    // 时间取那一条事件的 `at`（「什么时候知道的」是可追溯的一部分）
    expect(tools.at).toBe('2026-10-03T10:00:00.000Z');

    const slash = vendor.items.find((item) => item.id === 'vendor-slash-commands');
    if (slash?.present !== true) throw new Error('斜杠命令应当在场');
    expect(slash.text).toContain('design');
    expect(slash.text).toContain('子智能体定义（2）');
  });

  it('没有归一事件（codex / dsh 真机如此）⇒ `not-exposed`，不是 `not-observed`', () => {
    const vendor = groupOf(build([logEvent('{"type":"thread.started","thread_id":"t-1"}')]).groups, 'vendor');
    // 「厂商有、没投送到我们能读的通道」——写成 `not-observed` 会把责任记到本仓头上，
    // 让人去接一个这一家根本不发的事件
    expect(missingOf(vendor, 'vendor-tools')).toBe('not-exposed');
    expect(missingOf(vendor, 'vendor-slash-commands')).toBe('not-exposed');
  });

  it('系统提示词与工具模式串**不在**归一事件里 ⇒ `not-observed`（我们没接，不是这家没有）', () => {
    const vendor = groupOf(build([vendorSystemEvent()]).groups, 'vendor');
    // `system/init` 只报工具**名字**，没有提示词正文、也没有 JSON Schema
    expect(missingOf(vendor, 'vendor-system-prompt')).toBe('not-observed');
    expect(missingOf(vendor, 'vendor-tool-schemas')).toBe('not-observed');
  });

  /**
   * **本层不再认厂商形状**。
   *
   * 这是本节最重要的一条：喂进**逐字真机**的 `system/init` 原始 JSON，而**不给**归一事件 ⇒
   * 厂商系统层必须整组 `not-exposed`。若把解析搬回数据层（认出 `subtype === 'init'` 并把工具面填上），
   * 「厂商改一个字段名」就等于「浏览器侧静默少一格」——那时这条断言会当场变红。
   */
  it('只给原始 `system/init` 日志、不给归一事件 ⇒ 整组不认（数据层不解析厂商原文）', () => {
    const vendor = groupOf(build([logEvent(CLAUDE_INIT)]).groups, 'vendor');

    expect(missingOf(vendor, 'vendor-tools')).toBe('not-exposed');
    expect(missingOf(vendor, 'vendor-slash-commands')).toBe('not-exposed');
    // 权限档同理：它也必须走归一事件，而不是从原文里认 `permissionMode`
    const project = groupOf(build([logEvent(CLAUDE_INIT)]).groups, 'project');
    expect(missingOf(project, 'project-permission')).toBe('not-exposed');
  });

  it('半截 JSON 的日志行不会让本层抛错（它已经与厂商系统层无关）', () => {
    const vendor = groupOf(build([logEvent('{"type":"system","subtype":"ini')]).groups, 'vendor');

    expect(missingOf(vendor, 'vendor-tools')).toBe('not-exposed');
  });

  /**
   * **这一行被下发了哪几台 MCP**。
   *
   * 为什么这一格必须在：`mcpServers` 若是字符串数组、真机对象数组又被折成 `[]`
   * ⇒ 环境抽屉里**一个字都没有**，而「装没装上」「实际生效了哪几台」
   * 是用户要看的第二件事（第一件在设置页：我配了什么）。
   *
   * 两种形态都必须列得出来：对象形态（真机）逐台给名字 + 厂商原值 `status` / `source`；
   * 历史 `events.jsonl` 里只有名字串，那就只写名字——另两格真的没给，**不编**。
   */
  it('MCP 服务：对象数组逐台列出（名字 + 厂商原值 status / 来源），历史字符串形态照样列得出来', () => {
    const real = [
      { name: 'context7', status: 'pending', source: 'project', error: null },
      { name: 'find', status: 'connected', source: 'project', error: null },
    ];
    // `status` / `source` 照抄厂商原值（`dynamic` = 本仓注入 / `project` = 仓库自带），不翻译：
    // 抄一份中文词表就是第二个真源（这两个原值可直接采信）
    expect(mcpItemOf(build([vendorSystemEvent({ mcpServers: real })])).text).toBe(
      ['2 台：', 'context7（status pending · 来源 project）', 'find（status connected · 来源 project）'].join('\n'),
    );
    // 历史形态（更早落盘的字符串数组）：名字在，另两格厂商没给 ⇒ 只写名字
    expect(mcpItemOf(build([legacyMcpEvent(['context7', 'find'])])).text).toBe(['2 台：', 'context7', 'find'].join('\n'));
  });

  /**
   * 两态不许互相顶替（本仓反复强调的那两句）：`null` = 厂商没投送 ⇒ `not-exposed`；
   * `[]` = 投送了、确实一台都没有 ⇒ 一条**在场**的格子，如实写「0 台」。
   * 把 `[]` 写成 `not-exposed` 就是把「厂商说没有」说成「我们没接」。
   */
  it('MCP 服务：`null` 走 not-exposed（没投送），`[]` 走「0 台」（投送了，确实是空的）', () => {
    const vendor = groupOf(build([vendorSystemEvent({ mcpServers: null })]).groups, 'vendor');
    expect(missingOf(vendor, 'vendor-mcp-servers')).toBe('not-exposed');

    const empty = mcpItemOf(build([vendorSystemEvent({ mcpServers: [] })]));
    expect(empty.text).toContain('0 台');
  });

  /**
 * 口径守卫：厂商事实**逐拍长**时取最后一条。
 *
 * 为什么：claude 只在开头报一次（取最后 = 取唯一），而 codex / dsh 的 MCP 事实是逐拍长出来的
 * （`starting → ready`、工具表逐拍补全，每条交全量）。取第一条会让环境抽屉显示最早那一拍，
 * 与行详情、行级观测格（都取最后）对**同一行**给出两种状态。
 */
  it('厂商事实逐拍长时取最后一条（与行级观测格同口径），时间也取那一条', () => {
    const environment = build([
      vendorSystemEvent({ mcpServers: [{ name: 'probe', status: 'starting', source: 'dynamic', error: null }] }, 1),
      {
        ...vendorSystemEvent({ mcpServers: [{ name: 'probe', status: 'ready', source: 'dynamic', error: null }] }, 2),
        at: '2026-10-03T10:00:05.000Z',
      },
    ]);

    const item = mcpItemOf(environment);
    expect(item.text).toContain('ready');
    expect(item.text).not.toContain('starting');
    // 时间跟着最后那条走：它才是「这份事实什么时候知道的」
    expect(item.at).toBe('2026-10-03T10:00:05.000Z');
  });
});

describe('buildAgentEnvironment：运行配置与实测统计', () => {
  it('权限档取**厂商回显**的那一档（不抄一份本仓常量当第二个真源）', () => {
    const project = groupOf(build([vendorSystemEvent()]).groups, 'project');
    const permission = project.items.find((item) => item.id === 'project-permission');
    if (permission?.present !== true) throw new Error('权限档应当在场');
    expect(permission.text).toBe('bypassPermissions');
  });

  it('没有归一事件 ⇒ 权限档 `not-exposed`（codex / dsh 真机没有这一格）', () => {
    const project = groupOf(build([]).groups, 'project');
    expect(missingOf(project, 'project-permission')).toBe('not-exposed');
  });

  it('用过的工具按名字计数、按次数降序，且**与「已调度的工具」分属两组**', () => {
    const records = [toolCall('Read', 'c1'), toolCall('Read', 'c2'), toolCall('Bash', 'c3')];
    const environment = build([vendorSystemEvent()], records);
    const observed = groupOf(environment.groups, 'observed');
    // 按 id 取格：这一组里有好几格，按下标取会随新增格静默取错对象
    const item = observed.items.find((entry) => entry.id === 'observed-tools');
    if (item?.present !== true) throw new Error('实测统计应当在场');
    expect(item.text).toBe('Read × 2\nBash × 1');
    expect(item.label).toContain('2 种 / 共 3 次');

    // 两个事实必须能分开看：工具面（手里有什么）与统计（用了什么）
    const vendor = groupOf(environment.groups, 'vendor');
    const tools = vendor.items.find((entry) => entry.id === 'vendor-tools');
    if (tools?.present !== true) throw new Error('工具面应当在场');
    expect(tools.text).toContain('Task');
    expect(item.text).not.toContain('Task');
  });

  it('一条工具调用都没有 ⇒ `not-observed`（不是「用了 0 次」）', () => {
    const observed = groupOf(build([], []).groups, 'observed');
    expect(missingOf(observed, 'observed-tools')).toBe('not-observed');
  });

  it('工具名为空时归到显式桶里，**不并进任何一个真名**', () => {
    const observed = groupOf(build([], [toolCall('', 'c1'), toolCall('Read', 'c2')]).groups, 'observed');
    const item = observed.items.find((entry) => entry.id === 'observed-tools');
    if (item?.present !== true) throw new Error('实测统计应当在场');
    expect(item.text).toContain('(未采到工具名) × 1');
    expect(item.text).toContain('Read × 1');
  });

  /**
 * 「**本行 MCP**」那一格。它读的是**行快照**上那一格观测
 * （`EvalRow.mcpServers`），而不是从事件流里现推：事件流回答「厂商当时说了什么」，
 * 而这一格要回答「这一行实际装上了哪几台、凭什么这么说」——含**环境变量未设置而被我们跳过**的那几台
 * （厂商事件里根本没有它们，只有我们这边的账）。
 *
 * 三态与 `streamingDelta` 逐条同构，故各自一条守卫：缺席 / `null` = 没观测；
 * `[]` = 观测了、确实一台都没有；非空 = 逐台来源 + 判据 + 结论。
 */
  describe('本行 MCP 观测格（行快照那一格）', () => {
    const envWith = (mcpServers: EvalRow['mcpServers']): EnvGroup =>
      groupOf(
        buildAgentEnvironment({ row: { ...ROW, mcpServers }, workspaceBase: '', events: [], records: [] }).groups,
        'observed',
      );
    const itemOf = (group: EnvGroup): EnvItem => {
      const item = group.items.find((entry) => entry.id === 'observed-mcp-servers');
      if (item === undefined) throw new Error('没有 observed-mcp-servers 这一格');
      return item;
    };

    it('格缺席 / 显式 `null` ⇒ `not-observed`（老 run.json 不是坏记录）', () => {
      expect(missingOf(envWith(undefined), 'observed-mcp-servers')).toBe('not-observed');
      expect(missingOf(envWith(null), 'observed-mcp-servers')).toBe('not-observed');
    });

    it('`[]` ⇒ **在场**且写明「观测到 0 台」，不得与「没观测」合并', () => {
      const item = itemOf(envWith([]));
      if (!item.present) throw new Error('观测到零台也是一条观测，必须在场');
      expect(item.label).toBe('本行 MCP');
      expect(item.text).toContain('0 台');
    });

    /**
 * **codex 的能力缺口必须摆在看得见的地方**（验收口径：「写进界面提示与文档，不藏起来」）。
 *
 * 为什么这一条落在这一格：`connected` 在 codex 上只到「启动状态 ready」——工具**调不动**
 * （上游网关拍平命名空间）。不写出这句话，用户看到「probe 已连上」会以为工具能用，
 * 而模型发起的调用其实被上游拒掉。文案取契约里那份共用常量（界面与知识库同一份）。
 */
    it('codex 行 + 有 MCP ⇒ 末尾附上能力缺口说明（`connected` 不等于「调得动」）', () => {
      const item = itemOf(
        groupOf(
          buildAgentEnvironment({
            row: {
              ...ROW,
              agentKind: 'codex',
              mcpServers: [{ name: 'probe', source: 'unknown', judgedBy: 'vendor-startup-status', verdict: 'connected' }],
            },
            workspaceBase: '',
            events: [],
            records: [],
          }).groups,
          'observed',
        ),
      );
      if (!item.present) throw new Error('这一格应当在场');
      expect(item.text).toContain(CODEX_MCP_DISPATCH_GAP_NOTE);

      // 另两家**不许**带上这句话（它是 codex 一家的缺口；跟着所有人显示会把提示读成噪声）
      for (const agentKind of ['claude-code', 'dsh'] as const) {
        const other = itemOf(
          groupOf(
            buildAgentEnvironment({
              row: {
                ...ROW,
                agentKind,
                mcpServers: [{ name: 'probe', source: 'unknown', judgedBy: 'vendor-tool-table', verdict: 'connected' }],
              },
              workspaceBase: '',
              events: [],
              records: [],
            }).groups,
            'observed',
          ),
        );
        expect(other.present && other.text.includes(CODEX_MCP_DISPATCH_GAP_NOTE)).toBe(false);
      }

      // codex 但**一台 MCP 都没观测到** ⇒ 也不附（没有可误解的结论要解释）
      const empty = itemOf(envWith([]));
      expect(empty.present && empty.text.includes(CODEX_MCP_DISPATCH_GAP_NOTE)).toBe(false);
    });

    it('逐台给 来源 + 判据 + 结论（含仓库自带那几台与跳过的那台）', () => {
      const item = itemOf(
        envWith([
          { name: 'playwright', source: 'dynamic', judgedBy: 'vendor-tool-table', verdict: 'connected' },
          { name: 'find', source: 'project', judgedBy: 'vendor-status', verdict: 'connected' },
          { name: 'context7', source: 'unknown', judgedBy: 'none', verdict: 'skipped' },
        ]),
      );
      if (!item.present) throw new Error('这一格应当在场');
      expect(item.text).toBe(
        [
          '3 台：',
          // 来源采信厂商原值（`dynamic` = 本行注入、`project` = 仓库自带），不翻译成中文词表
          'playwright：来源 dynamic · 判据 厂商工具表 · 结论 已连上',
          'find：来源 project · 判据 厂商连接状态 · 结论 已连上',
          'context7：来源 unknown · 判据 无厂商证据 · 结论 已跳过',
        ].join('\n'),
      );
    });
  });

  /**
   * 流式增量的**运行期观测**（`EvalRow.streamingDelta`）：三态必须各自可辨。
   * 这一组的靶子是「厂商声明 yes、实际一条都没投」这档异常——它在界面上与「这家本来就没有」
   * 完全同形（都是不打字），而增量帧不落盘 ⇒ 事后没有第二个地方能看出区别。
   */
  describe('流式增量观测（增量帧只广播不落盘，事后唯一痕迹）', () => {
    const envWith = (streamingDelta: EvalRow['streamingDelta']): EnvGroup =>
      groupOf(
        buildAgentEnvironment({ row: { ...ROW, streamingDelta }, workspaceBase: '', events: [], records: [] }).groups,
        'observed',
      );
    const itemOf = (group: EnvGroup): EnvItem => {
      const item = group.items.find((entry) => entry.id === 'observed-streaming-delta');
      if (item === undefined) throw new Error('没有 observed-streaming-delta 这一格');
      return item;
    };

    it('格缺席 ⇒ `not-observed`（老数据 / 这一行没跑到统计那一步）', () => {
      expect(missingOf(envWith(undefined), 'observed-streaming-delta')).toBe('not-observed');
    });

    it('显式 `null` 与缺席**同义**（契约新增可选格的老口径）', () => {
      expect(missingOf(envWith(null), 'observed-streaming-delta')).toBe('not-observed');
    });

    it('`frameCount === 0` ⇒ **在场**且写明「观测到 0 条」，不得与「没观测」合并', () => {
      const item = itemOf(envWith({ frameCount: 0, lastFrameChars: 0 }));
      if (!item.present) throw new Error('观测到零帧也是一条观测，必须在场');
      expect(item.text).toContain('0 条增量帧');
      expect(item.text).toContain('开关未生效');
    });

    it('有增量 ⇒ 帧数与**末帧累积字数**都给（正文不落盘，这一格回答「写到哪」）', () => {
      const item = itemOf(envWith({ frameCount: 12_345, lastFrameChars: 1_240 }));
      if (!item.present) throw new Error('有增量时必须在场');
      expect(item.text).toContain('增量帧 12345 条');
      expect(item.text).toContain('末帧累积 1240 字');
      expect(item.text).toContain('正文不落盘');
    });
  });
});

describe('buildAgentEnvironment：单格的截断与字节数', () => {
  it('短文本原样给，`truncated` 为 `null`（「完整」与「可能不完整」必须分得开）', () => {
    expect(envItem('x', 'X', '短', null)).toEqual({ present: true, id: 'x', label: 'X', text: '短', truncated: null, at: null });
  });

  it('超上限就截断，并带上**原因与字节数**（字节数按 UTF-8 算，不是字符数）', () => {
    const item = envItem('x', 'X', '中'.repeat(70_000), '2026-10-03T10:00:00.000Z');
    if (!item.present) throw new Error('应当是 present');
    expect(item.text).toHaveLength(64 * 1024);
    expect(item.truncated?.reason).toContain('上限');
    // 一个汉字三字节 ⇒ 70000 字符 = 210000 字节；拿 `text.length` 当字节数会得到 70000
    expect(item.truncated?.bytes).toBe(210_000);
  });
});
