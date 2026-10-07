/**
 * **环境信息的拼装**（设计 §4.3）：把「这一行被下发了什么」拼成一个 `AgentEnvironment`。
 *
 * 为什么是纯函数、放在数据层：页面只做拼装（与 `buildRowFacts` / `buildAgentLogModel` 同一条边界），
 * 而这个函数的每一格都在回答同一个问题——「这条要求是谁下发的」。判错的后果不是缺一格，
 * 而是**把厂商下发的说成本仓下发的**，那会让人去改一个根本不存在的配置。
 *
 * **四组的分法不是装饰**（§4.3 D17）：
 *   | 组 | `source` | 回答 |
 *   |---|---|---|
 *   | 用户层 | `user` | 发起这一轮的人给了什么（附件 / 上下文引用。**不含用户提示词**——那个在时间轴首条） |
 *   | 厂商系统层 | `vendor` | 厂商自己下发了什么（系统提示词 / 已调度的工具 / 斜杠命令或子智能体定义 / 工具模式串） |
 *   | 运行配置 | `project` | **本仓**下发了什么（权限档 / 被禁用的工具 / 模型与思考强度 / 工作区与基线） |
 *   | 实测统计 | `observed` | 这一行**实际**发生了什么（用过的工具及次数） |
 *
 * 「已调度的工具」与「用过的工具」**必须分开**（§4.3 最容易做错的一处）：前者是厂商自报的**工具面**
 * （「它当时手里有什么」），后者是从实际调用统计出来的（「它用了什么」）。混成一个列表就会出现
 * 「列了 30 个工具，其实只用了 2 个」的误读。
 *
 * **拿不到就说拿不到**：每一格给不出时走 `present: false` + 一个**准确的** `MissingReason`。
 * 四种原因互不通用（把「这家没有」说成「我们没接」就是把使用者引到错的方向）：
 *   · `not-supported` 这家结构上不支持；
 *   · `not-exposed` 厂商有数据、但没投送到我们能读的通道；
 *   · `not-observed` 厂商有、我们还没接（**本仓待办**，不是厂商的问题）；
 *   · `unverified` 没验证过。
 *
 * 数据来源逐格核过（2026-10-03 真机产物）：
 *   · 摘要七格 —— `EvalRow` / `EvalRun` 的快照字段，服务端已经存了，**不读事件流**；
 *   · 厂商系统层 —— `vendor-system` **事件**（2026-10-04 起由适配器归一；
 *     归一之前它是 claude-code 的 `system` / `init` 行原文，本层要自己 `JSON.parse` 并逐字认
 *     `subtype === 'init'` / `slash_commands` / `permissionMode`——那是把厂商适配搬进了浏览器）。
 *     真机：只有 claude 投送这一行（`tools` 21 项、`slash_commands` 47 项、`agents` 5 项…），
 *     **codex 与 dsh 没有** ⇒ 那一组整组走 `not-exposed`；
 *   · 实测统计 —— 内容记录（`messages.jsonl`）里的 `tool-call` 块按 `name` 计数。
 *     它不从事件流数：事件流的工具名字在 codex 上是 `exec_command` 这类**入口名**，
 *     与会话文件里的真名不是一回事。
 */
import {
  type AgentEnvironment,
  type AgentEnvironmentSummary,
  type AgentEvent,
  type EnvGroup,
  type EnvItem,
  type EnvSource,
  type EvalRow,
  type MissingReason,
  type RowRecord,
} from '@aieval/contracts';

/**
 * 单格文本的上限（字符）。超过就截断并标 `truncated`——**由数据层判**（UI 不判断大小，§4.3）。
 *
 * 为什么是 64 KiB：真机 claude 的 `system/init` 行 2.5 KB、`slash_commands` 47 项已接近 1 KB，
 * 而厂商系统提示词与工具模式串在别的通道上可能到几十 KB（实测 `probe/dumps/dsh.json` 237 KB）。
 * 上限的作用是**别让一次提交搬几百 KB**（§4.3 的体积理由），不是「省地方」。
 */
const MAX_ITEM_CHARS = 64 * 1024;

/** 一格里放几项就够看（超出只说明「还有更多」，不逐项列） */
const LIST_LIMIT = 200;

/** 拼装输入：这三样页面都已经拿在手上，**不需要新端点** */
export interface BuildEnvironmentInput {
  /** 这一行（`EvalRow` 的快照字段是真源） */
  row: EvalRow;
  /** 这一轮（只用到 `workspaceBase`） */
  workspaceBase: string;
  /** 行级事件流：厂商系统层的唯一来源 */
  events: readonly AgentEvent[];
  /** 内容记录：实测统计的来源 */
  records: readonly RowRecord[];
}

/** 一格的短名（`id` 用它拼，界面按它做 React key；**不是展示文案**） */
function summaryOf(input: BuildEnvironmentInput): AgentEnvironmentSummary {
  const { row } = input;
  return {
    agentKind: row.agentKind,
    modelId: row.modelId,
    // 记的是**我们要求的**档位，不是实际生效的（厂商可能静默降档，spec §9 第 7 条）
    effort: row.effort ?? null,
    providerName: row.providerName,
    baseUrl: row.baseUrl,
    workspaceBase: input.workspaceBase,
    baselineCommit: row.baselineCommit,
  };
}

/** 一条「拿不到」的格子：**必须**带原因（`present: false` 时 `missing` 必填） */
function missing(id: string, label: string, reason: MissingReason): EnvItem {
  return { present: false, id, label, missing: reason };
}

/**
 * 一条「拿到了」的格子。`text` 超上限就截断并带上**原因与字节数**——
 * 界面据此显示「输出可能不完整」，而不是静默少半段。
 */
export function envItem(id: string, label: string, text: string, at: string | null): EnvItem {
  // 字节数用 `TextEncoder` 而不是 `Buffer`：这一层跑在**浏览器**里（页面直接调它），
  // 而 `Buffer` 在浏览器侧要靠打包器兜底。中文字符一字符三字节，故不能拿 `text.length` 当字节数。
  const bytes = new TextEncoder().encode(text).length;
  if (text.length <= MAX_ITEM_CHARS) return { present: true, id, label, text, truncated: null, at };
  return {
    present: true,
    id,
    label,
    text: text.slice(0, MAX_ITEM_CHARS),
    truncated: { reason: `超过单格上限 ${MAX_ITEM_CHARS} 字符`, bytes },
    at,
  };
}

/** 一个字符串列表 → 一条文本（逐行一项；超过 `LIST_LIMIT` 如实记一句，不悄悄截） */
function listText(values: readonly string[]): string {
  const head = values.slice(0, LIST_LIMIT);
  const more = values.length > LIST_LIMIT ? `\n…（共 ${values.length} 项，只列前 ${LIST_LIMIT} 项）` : '';
  return `${head.join('\n')}${more}`;
}

/** 厂商系统层六格的**归一形状**（取自 `vendor-system` 事件；每格 `null` = 厂商没投送） */
interface VendorInit {
  tools: string[] | null;
  slashCommands: string[] | null;
  agents: string[] | null;
  permissionMode: string | null;
  outputStyle: string | null;
  mcpServers: string[] | null;
  at: string;
}

/**
 * claude-code 的 `system/init` 行 → 厂商系统层那一组。
 *
 * **2026-10-04 收口：本层不再解析厂商原文。** 那一行由适配器归一成 `vendor-system` 事件
 * （`providers/claude-code/events.ts` 的 `vendorSystemDraftOf`），这里只按事件取字段——
 * 于是「厂商改一个字段名」不再等于「浏览器侧静默少一格」，加第四家也不必动这一层。
 *
 * 取**第一条**（`seq` 最小那条）：同一次运行厂商只在开头报一次；重跑时 `seq` 回到 1，
 * 取第一条即「最早知道的那一份」，与旧实现（遍历取首个匹配）口径一致。
 * 时间取那条事件的 `at`——「什么时候知道的」是可追溯的一部分。
 */
function parseVendorInit(events: readonly AgentEvent[]): VendorInit | null {
  for (const event of events) {
    if (event.type !== 'vendor-system') continue;
    return {
      tools: event.tools,
      slashCommands: event.slashCommands,
      agents: event.agents,
      permissionMode: event.permissionMode,
      outputStyle: event.outputStyle,
      mcpServers: event.mcpServers,
      at: event.at,
    };
  }
  return null;
}

/** 厂商系统层。**这一组整组取决于 init 行在不在**，故一次判完 */
function vendorGroup(events: readonly AgentEvent[]): EnvGroup {
  const init = parseVendorInit(events);
  const items: EnvItem[] = [];
  if (init === null) {
    /**
     * 没有 init 行 = **厂商有工具面、但没投送到我们能读的通道**（`not-exposed`），
     * **不是** `not-observed`：后者会把责任写到本仓头上，让人去接一个根本不存在的事件。
     * 真机逐份扫过：codex 与 dsh 的事件流里没有 `system`/`init` 这一类行。
     */
    items.push(
      missing('vendor-tools', '已调度的工具', 'not-exposed'),
      missing('vendor-system-prompt', '系统提示词', 'not-exposed'),
      missing('vendor-slash-commands', '斜杠命令 / 子智能体定义', 'not-exposed'),
      missing('vendor-tool-schemas', '工具模式串', 'not-exposed'),
    );
    return { id: 'vendor', title: '系统层（厂商下发）', source: 'vendor', items };
  }
  items.push(
    init.tools === null
      ? missing('vendor-tools', '已调度的工具', 'not-exposed')
      : envItem('vendor-tools', '已调度的工具', listText(init.tools), init.at),
    /**
     * **系统提示词不在这一行里**（真机核过：`system/init` 只报工具面、模型、权限档，
     * 没有 `base_instructions` 那一类字段；那是 codex 会话文件的形状，不是这个通道的）。
     * 故它是 `not-observed`——厂商有、我们还没接——而不是 `not-exposed`。
     */
    missing('vendor-system-prompt', '系统提示词', 'not-observed'),
    init.slashCommands === null && init.agents === null
      ? missing('vendor-slash-commands', '斜杠命令 / 子智能体定义', 'not-exposed')
      : envItem(
        'vendor-slash-commands',
        '斜杠命令 / 子智能体定义',
        [
          init.slashCommands === null ? '斜杠命令：没投送' : `斜杠命令（${init.slashCommands.length}）：\n${listText(init.slashCommands)}`,
          init.agents === null ? '子智能体定义：没投送' : `子智能体定义（${init.agents.length}）：\n${listText(init.agents)}`,
        ].join('\n\n'),
        init.at,
      ),
    // 工具模式串（JSON Schema）从来不在这条通道上——真机 init 行只有工具**名字**
    missing('vendor-tool-schemas', '工具模式串', 'not-observed'),
  );
  return { id: 'vendor', title: '系统层（厂商下发）', source: 'vendor', items };
}

/**
 * 用户层。**不含用户提示词**（§4.3 的要求方口径修正）：对模型说的话属于**对话**、
 * 在时间轴首条，环境抽屉回答的是「系统与运行配置给了它什么」，两处不重复。
 * 故这一组的常规构成是附件与上下文引用——本仓目前没有采集，如实记 `not-observed`。
 */
function userGroup(): EnvGroup {
  return {
    id: 'user',
    title: '用户层',
    source: 'user',
    items: [
      missing('user-attachments', '附件或上下文引用', 'not-observed'),
      missing('user-continuation', '会话续接', 'not-observed'),
    ],
  };
}

/**
 * 运行配置。**这一组是本仓自己下发的**，故取值全部来自编排层的快照字段，
 * 不从事件流里反推（反推出来的东西分不清「我们下发的」与「厂商回显的」）。
 */
function projectGroup(input: BuildEnvironmentInput, events: readonly AgentEvent[]): EnvGroup {
  const { row } = input;
  const init = parseVendorInit(events);
  const items: EnvItem[] = [
    /**
     * 权限档：**取厂商回显的那一档**（`vendor-system` 事件的 `permissionMode`，实测 `bypassPermissions` 逐字）。
     * 为什么不用本仓的 `CLAUDE_PERMISSION_MODES` 当文案：那一格在浏览器侧拿不到，
     * 抄一份常量进来就成了第二个真源——厂商改了档名，这里会静默说错。
     * 拿不到就如实记 `not-exposed`（codex / dsh 都不投送这一格）。
     */
    init?.permissionMode == null
      ? missing('project-permission', '权限档', 'not-exposed')
      : envItem('project-permission', '权限档', init.permissionMode, init.at),
    // 被禁用的工具名单是**适配器里按模型算的**，不会投送到浏览器；要看得从工具面反推，
    // 而反推分不清「被禁」与「这家本来就没有」⇒ 不猜
    missing('project-disallowed', '被禁用的工具', 'not-observed'),
    // 未选档位的语义随家而变（2026-10-06）：dsh 走自家缺省 `high`，claude / codex 不传、由厂商推断。
    // 契约明说它**不是**「沿用厂商默认档」也不是「关闭」——写成「沿用厂商默认」会让这一格的读法
    // 与契约相反（要关闭必须显式写 `EFFORT_OFF`）。改口径 2026-10-07：档位照上游词汇原样写，
    // 关闭档就是 `off` 本身（不再加「要求不思考」那类解释）。
    envItem(
      'project-model',
      '模型与思考强度',
      [
        `模型：${row.modelId}`,
        `思考强度：${row.effort === undefined ? '未指定（由该家适配器决定：dsh 走 high）' : row.effort}`,
      ].join('\n'),
      null,
    ),
    envItem(
      'project-workspace',
      '工作区与基线',
      [`工作区：${row.workspacePath}`, `运行根目录：${input.workspaceBase}`, `基线提交：${row.baselineCommit}`].join('\n'),
      null,
    ),
    envItem('project-route', '路由', [`供应商：${row.providerName}`, `baseUrl：${row.baseUrl}`].join('\n'), null),
  ];
  return { id: 'project', title: '运行配置（本仓下发）', source: 'project', items };
}

/** 用过的工具及次数。**这是统计，不是事实声明**，故单列一组、标 `observed`（§4.3） */
function observedGroup(records: readonly RowRecord[]): EnvGroup {
  const counts = new Map<string, number>();
  for (const record of records) {
    if (record.type !== 'message') continue;
    // `AgentMessage.blocks` 直接就是内容块（没有中间那层包装）——按 `type` 判别后取 `name`
    for (const block of record.message.blocks) {
      if (block.type !== 'tool-call') continue;
      // 名字为空 = 适配器拿不到真名；归到一个显式桶里，**不并进任何一个真名**
      const name = block.name === '' ? '(未采到工具名)' : block.name;
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }
  if (counts.size === 0) {
    return {
      id: 'observed',
      title: '实测统计',
      source: 'observed',
      items: [missing('observed-tools', '用过的工具及次数', 'not-observed')],
    };
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const total = sorted.reduce((sum, [, count]) => sum + count, 0);
  return {
    id: 'observed',
    title: '实测统计',
    source: 'observed',
    items: [
      envItem(
        'observed-tools',
        `用过的工具及次数（${sorted.length} 种 / 共 ${total} 次）`,
        listText(sorted.map(([name, count]) => `${name} × ${count}`)),
        null,
      ),
    ],
  };
}

/**
 * 拼出一行的环境信息。**四组永远都在**（拿不到的那几格在组内如实说原因）——
 * 少一整组会让人以为「这一家没有这件事」，而真相常常是「我们没接」。
 */
export function buildAgentEnvironment(input: BuildEnvironmentInput): AgentEnvironment {
  return {
    summary: summaryOf(input),
    groups: [userGroup(), vendorGroup(input.events), projectGroup(input, input.events), observedGroup(input.records)],
  };
}

/** 组的顺序（界面按它渲染；测试与页面共用一份，免得两边各记一个顺序） */
export const ENV_GROUP_ORDER: readonly EnvSource[] = ['user', 'vendor', 'project', 'observed'];
