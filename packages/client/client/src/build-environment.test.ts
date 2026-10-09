// @vitest-environment node
/**
 * **环境信息的拼装**（设计 §4.3）——四组的分法、缺失原因、以及「谁下发的」这件事。
 *
 * 为什么这一层必须有守卫：四组里每一格都在回答「这条要求是谁下发的」，而**判错的后果不是缺一格**，
 * 而是把厂商下发的说成本仓下发的（或反过来）——使用者据此去改一个根本不存在的配置。
 * 而它在界面上长得完全一样：一个 `present: false` + 一句原因，与一个「我们没接」的格子
 * 只差那四个字。故这里逐格钉住**原因**，不只是「有没有」。
 *
 * 夹具里的 `system/init` 行**逐字取自真机**（`D:\.tmp\aieval\runs\…\events.jsonl`，2026-10-03）：
 * claude-code 报 `tools` / `slash_commands` / `agents` / `permissionMode` / `output_style`，
 * 而 codex 与 dsh 的事件流里**没有这一类行**（逐份扫过）——那是 `not-exposed` 而不是 `not-observed`。
 */
import { describe, expect, it } from 'vitest';
import { EFFORT_OFF, type AgentEvent, type EnvGroup, type EvalRow, type RowRecord } from '@aieval/contracts';
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
 * **归一后的**厂商系统层事件（2026-10-04 收口）。
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
      vendorTurn: null,
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
   * 摘要第一格给的是**显示名**（用户 2026-10-08 口径：页面展示不用缩写）。
   *
   * 为什么映射必须在数据层：L0 渲染件里查 `AGENT_LABELS` 就是「UI 判厂商」，
   * `agent-log-layering.test.ts` 的 (e) 条会当场红（实测）——所以这一格必须在这里就换好，
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
   * 环境抽屉里「模型与思考强度」那一格的**未指定文案**（2026-10-06；2026-10-08 改成按元数据拼）。
   *
   * 为什么这句话值一条用例：契约明说未选档位**不是**「沿用厂商默认档」（DSH 会落到自家缺省
   * `high`，Claude Code / Codex 不传、由厂商推断），而这一格此前写的正是「未指定（沿用厂商默认档）」
   * ——**与契约相反的读法**。文字错了不会有任何功能报错，只会让人按错误的口径去解释一次跑分
   *（「没指定就是厂商默认嘛」），所以靶子必须是这串文案本身。
   *
   * **2026-10-08**：厂商名与档位不再写死（原先逐字写「dsh 走 high」——即使看的是别家的环境也印这句，
   * 且写的是 kind 缩写）⇒ 现在由 `defaultEffort` 入参 + `AGENT_LABELS` 拼，**不给就只说「未指定」**。
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
    // 阴性面：kind 缩写与旧口径的读法一个都不许留（否则同一格里有两种说法）
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
   * 关闭档那一格（2026-10-07 口径）：档位照上游词汇原样写，`off` 就是 `off`。
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
    // 真机核过：`system/init` 只报工具**名字**，没有提示词正文、也没有 JSON Schema
    expect(missingOf(vendor, 'vendor-system-prompt')).toBe('not-observed');
    expect(missingOf(vendor, 'vendor-tool-schemas')).toBe('not-observed');
  });

  /**
   * **本层不再认厂商形状**（2026-10-04 收口的那条边界）。
   *
   * 这是本节最重要的一条：喂进**逐字真机**的 `system/init` 原始 JSON，而**不给**归一事件 ⇒
   * 厂商系统层必须整组 `not-exposed`。旧实现会在这里认出 `subtype === 'init'` 并把工具面填上，
   * 于是「厂商改一个字段名」就等于「浏览器侧静默少一格」——回归的方式是把解析搬回数据层，
   * 那时这条断言会当场变红。
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
    const item = observed.items[0];
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
    const item = observed.items[0];
    if (item?.present !== true) throw new Error('实测统计应当在场');
    expect(item.text).toContain('(未采到工具名) × 1');
    expect(item.text).toContain('Read × 1');
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
