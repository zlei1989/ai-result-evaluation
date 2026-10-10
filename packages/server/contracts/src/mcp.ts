/**
 * MCP 服务器契约：**canonical 形状**（三家厂商共用的内部真源）。
 *
 * 形状为什么是这两层：
 *   1. 容器是 **name-keyed map**（名字住在键上，条目里没有 `name` 字段）——与厂商 JSON 同形、
 *      便于贴入，也天然去重（同名就是同一条）；
 *   2. 条目是**传输判别联合**：stdio 与 http 的字段集不重叠（codex 甚至靠字段推断传输），
 *      用 `transport` 判别比「一堆可选字段 + 运行期猜」早一步把跨传输字段挡在门外。
 *
 * 注意两件事：
 *   - 这里是**纯形状**，没有 IO、没有默认条目。落盘键位与播种（`{}` 之外的预置两项）在
 *     `settings.ts` 里；贴入解析是另一个纯函数（`mcp-paste.ts`）。
 *   - 未知字段由 zod 对象的默认 strip 语义丢掉（`alwaysAllow` / `timeout` 这类厂商私有字段），
 *     导入预览负责点名「丢了哪些」，别在这里加 `.passthrough()`。
 */
import { z } from 'zod';

/**
 * codex 的 **MCP 能力缺口**文案（根因、证据矩阵与三条出路见
 * `docs/features/mcp-config.md` 的「已知边界与取舍」与 Codex FAQ 的 `unsupported call` 条目）。
 *
 * 做什么：把「注入成功、启动 `ready`，但工具**调不动**」这件事用一句能直接展示的中文说清，
 * 并明说**不是本仓的缺陷**（否则下一个人会去硬修一个上游问题）。
 *
 * 为什么放契约里：它是**一份文案**，三个消费方——界面的行卡片浮层、环境抽屉的「本行 MCP」、
 * 知识库 / FAQ——而 `@aieval/client` 只依赖 contracts（拿不到 agents）。放 agents 会被迫在界面侧
 * 抄第二份，漂移的表现是「界面上说能用、文档说调不动」。
 *
 * 事实：codex 自 0.156 起按「命名空间」暴露 MCP 工具，
 * 自定义 OpenAI 兼容 Responses 网关转发时把它拍平 ⇒ 注册表解析不了扁平函数名，回
 * `unsupported call: <tool>`，MCP server 侧零 `tools/call`；同轮内置 shell 工具正常。
 * 上游同型 issue：#26977 / #20652 / #26234。
 */
export const CODEX_MCP_DISPATCH_GAP_NOTE =
  '已知缺口：Codex 的 MCP 工具在本机网关下「看得见、调不动」——配置注入与启动都成功'
  + '（启动状态 ready），但模型发起的调用会被上游拍平命名空间后拒掉（unsupported call），'
  + 'MCP 服务端收不到调用。这是 codex 与自定义 Responses 网关之间的上游缺口'
  + '（#26977 / #20652 / #26234），不是本仓的缺陷，也不影响其它两家。';

/**
 * 服务器名模式：取三家交集的**最严**一份（dsh 的 `serverName` 就是这个形状）。
 * 一处拦、三家都安全——放到运行期再让某一家静默失灵是最坏的失败方式。
 */
export const MCP_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

/** `env` 的键名模式：子进程环境变量里带 `=` / 空格 / 点号的行为不可控，早报比晚报好 */
export const MCP_ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * 一条 MCP 服务器。公共两格：
 *   - `transport`：`stdio`（本地命令）| `http`（远端端点）；
 *   - `enabled`：**缺省 true**（`.default(true)`），但落盘时显式写出——不让「没写」与「写了 false」
 *     在文件里长得一样。
 * 刻意不含：`cwd`（claude 的 stdio 没有这个字段，子进程继承行工作区的 cwd）、各类超时
 * （三家名字与语义都不同，用厂商默认）、时间戳（没有消费方）。
 */
export const McpServerConfigSchema = z.discriminatedUnion('transport', [
  z.object({
    transport: z.literal('stdio'),
    enabled: z.boolean().default(true),
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    env: z.record(z.string().regex(MCP_ENV_KEY_PATTERN, 'env 的键只能是字母、数字与下划线，且不以数字开头'), z.string()).optional(),
  }),
  z.object({
    transport: z.literal('http'),
    enabled: z.boolean().default(true),
    url: z.string().min(1),
    headers: z.record(z.string().min(1), z.string()).optional(),
  }),
]);
export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;

/** 服务器集合：名字（键）过了 `MCP_NAME_PATTERN` 才认 */
export const McpServersSchema = z.record(
  z.string().regex(MCP_NAME_PATTERN, '服务器名只能是字母、数字、下划线或连字符，长度 1–32'),
  McpServerConfigSchema,
);
export type McpServers = z.infer<typeof McpServersSchema>;

/**
 * 环境变量占位：**只认** `${NAME}` 这一种。
 * 刻意不实现 `${VAR:-default}` 那类 shell 写法——它不是「写错了」，而是一种**没实现**的语法，
 * 把它当变量名的一部分会让注入集里出现一串谁也不认识的键。
 *
 * 两个消费方（注入侧的 `resolveMcpServers`、探活侧的 `api/src/mcp.ts`）共用这一份：
 * 各抄一份正则时漂移的表现是「探活认、注入不认」（或反过来）——而两边判的是同一段配置文本。
 *
 * ⚠️ 它**带 `g`**（`replace` 与 `matchAll` 都要这个标志）：只在 `replace` / `matchAll` 里用，
 * 不要拿它做 `.test()`——带 `g` 的正则 `.test()` 会把 `lastIndex` 留在上一次命中的位置，
 * 下一次调用从那里接着找（偶发漏判，且只在「上一次恰好命中」时现形）。只要「有没有」用下面两条。
 */
export const MCP_PLACEHOLDER_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/**
 * **注入侧**的残留判据：任何还留着的 `${` 都算「没解析出来」（未设置的变量与不支持的写法最终都落在它上面）。
 * 比探活那条**更宽**——`${` 之后就算没闭合也一律按「不解析」处置：这一份要交给厂商，
 * 宁可少注入一台，也不许把一串来路不明的 `${…` 送过去。
 */
export const MCP_UNRESOLVED_PLACEHOLDER = /\$\{/;

/**
 * **探活侧**的残留判据：一个**闭合**的 `${…}`（`${VAR:-default}` 这类 shell 写法）。
 * 探活只把这一格从请求里丢掉并记一条说明（`MCP_PROBE_NOTES.envUnsupported`），不像注入那样整条判死，
 * 所以它问的是「是不是用了没实现的写法」，而不是「有没有残留」——两条判据语义不同，别合并成一条。
 */
export const MCP_UNSUPPORTED_PLACEHOLDER = /\$\{[^}]*\}/;

/** 一条**被跳过**的条目：名字 + 中文原因（日志与行级观测格都照它说，不许各写一句） */
export interface McpSkippedServer {
  name: string;
  /**
   * 为什么没进注入集。**中文一句**而不是枚举码：它只被日志消费，而日志要一眼看出
   * 「哪一台的哪个键」；枚举码还得再配一份词表，词表一漂移两处说法就不一致了。
   */
  reason: string;
}

/**
 * 一条**形状不对**的条目：名字 + 中文原因（与 `McpSkippedServer` 同形）。
 *
 * 为什么与 `skipped` **分两个桶**而不是合一个：两者的处置动作相反——
 * `skipped` 是「条目没毛病、这一趟不投送」（去设那个环境变量就好了），
 * `invalid` 是「这一条压根不合形状」（得去改配置）。混在一起，日志就把两件事说成一件。
 */
export interface McpInvalidServer {
  name: string;
  /** 不合形状的那一处（中文一句，写给日志看：先点格子、再说为什么） */
  reason: string;
}

/**
 * 「端点或命令」那一列的一行文本：http 显 URL、stdio 显 `command args…`（超长由调用方截断）。
 *
 * 为什么放在契约层：两个消费方在**相反的两层**——`ui` 的表格与贴入预览（给人看）、
 * `api` 的探活日志（给排障看）——而 `ui` 与 `api` 之间没有依赖边（依赖表里没这条）。
 * 各拼一份 `[command, ...args].join(' ')` 的漂移表现是「日志里的端点与表格里那一行对不上」。
 */
export function endpointText(config: McpServerConfig): string {
  // 判别联合在这里收窄：http 只有 url，stdio 只有 command/args，跨传输字段在契约层就被 strip 掉了
  return config.transport === 'http' ? config.url : [config.command, ...(config.args ?? [])].join(' ');
}

/**
 * 解析一格的文本：`${NAME}` → 环境里的真值。
 * 返回 `null` = 这一格解析不出来（变量未设置 / 空串 / 不支持的写法）⇒ 调用方**整条**跳过。
 *
 * 为什么空串按「未设置」处置：`FOO=` 与没有这个变量在子进程里是同一件事（都拿不到密钥），
 * 而把空串当有效值会让厂商侧只报一句「认证失败」——真因离现场很远。
 */
function resolveValue(value: string, env: Readonly<Record<string, string | undefined>>): string | null {
  const replaced = value.replace(MCP_PLACEHOLDER_PATTERN, (whole, variableName: string) => {
    const found = env[variableName];
    // 拿不到就把**原文**放回去，由下面那句残留判据统一处置（`replace` 的回调没法中途放弃整条）
    return found === undefined || found === '' ? whole : found;
  });
  return MCP_UNRESOLVED_PLACEHOLDER.test(replaced) ? null : replaced;
}

/**
 * 形状闸：这一条到底合不合 `McpServerConfigSchema`。合 ⇒ `null`，不合 ⇒ 一句中文原因。
 *
 * 为什么非有不可（「手改配置文件能被读到」那一面）：`loadConfig` **故意**不做 schema 校验
 * （一条手改坏的值不该让整页打不开），于是 `settings.mcpServers` 里的值在类型上可信、在运行期不可信。
 * 缺 `transport` 的条目会被一路当成 http 翻成 `{type:'http', url: undefined}`，**厂商之前没有任何一层会拦**——
 * 表现是「界面上明明配了，行里静默少一台」，而这一格正是唯一能当场说清「哪一条、缺什么」的地方。
 *
 * 诊断顺序按「最像人话」排：先说名字/`transport` 这两处一眼可见的，再点缺的那个必填格，
 * 其余（`env` 键名、`args` 类型这类）退回 zod 的首条 issue（`env` 键名那条本来就是本仓的中文文案）。
 * 名字也在这里判（`McpServersSchema` 的名字模式是整份 map 的一部分）：名字不合法时三家各有各的失灵方式，
 * 早一步摘出来比让 dsh 侧静默拒掉好。
 */
function invalidEntryReason(name: string, raw: unknown): string | null {
  if (!MCP_NAME_PATTERN.test(name)) return '名字不合法：只能是字母、数字、下划线或连字符，长度 1–32';
  const parsed = McpServerConfigSchema.safeParse(raw);
  if (parsed.success) return null;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return '不是一个对象（配置里这一条不是 JSON 对象）';
  const transport = (raw as { transport?: unknown }).transport;
  if (transport === undefined) return '缺 transport 这一格（只能是 stdio 或 http）';
  if (transport !== 'stdio' && transport !== 'http') {
    return `transport 不认识（是 ${JSON.stringify(transport)}，只能是 stdio 或 http）`;
  }
  if (transport === 'stdio') {
    const command = (raw as { command?: unknown }).command;
    if (typeof command !== 'string' || command === '') return 'stdio 条目缺 command（要一个非空字符串）';
  } else {
    const url = (raw as { url?: unknown }).url;
    if (typeof url !== 'string' || url === '') return 'http 条目缺 url（要一个非空字符串）';
  }
  const issue = parsed.error.issues[0];
  if (issue === undefined) return '形状不对（schema 拒了但没给出原因）';
  const where = issue.path.join('.');
  return `${where === '' ? '条目' : where} 不合法：${issue.message}`;
}

/**
 * 占位闸：**不支持占位的那几格**里第一处带 `${` 的，返回格子名（`command` / `url` / `args[i]`）。
 *
 * 为什么要有它：贴入层拦得住界面这条路，手改 `config.json` 拦不住。
 * `env` / `headers` 的值由 `resolveValue` 逐格处置（未设置或不支持的写法 ⇒ 整条跳过），
 * 而这四格里的 `${…}` **既没人解析、也不会报错**——它会原样注入厂商，于是厂商侧回一句
 * 「找不到命令 `/bin/${TOOL}`」或「主机名不合法」，真因（占位写错了地方）离现场很远。
 * `$HOME` 这种不带花括号的写法不算：它不是本仓的占位语法，本来就按字面透传。
 */
function strayPlaceholderField(entry: McpServerConfig): string | null {
  if (entry.transport === 'stdio') {
    if (MCP_UNRESOLVED_PLACEHOLDER.test(entry.command)) return 'command';
    const index = (entry.args ?? []).findIndex((arg) => MCP_UNRESOLVED_PLACEHOLDER.test(arg));
    return index < 0 ? null : `args[${index}]`;
  }
  return MCP_UNRESOLVED_PLACEHOLDER.test(entry.url) ? 'url' : null;
}

/**
 * 条目 → **真正要注入的那一份**（唯一实现）。
 *
 * 做什么，逐条：
 *   1. **形状闸**：这一条没通过 `McpServerConfigSchema` ⇒ 摘进 `invalid` 并止步于此
 *      （畸形条目当 http 注入的下场是 `{type:'http', url: undefined}`，详见 `invalidEntryReason`）；
 *   2. `enabled === false` ⇒ **整条跳过**（不进注入集，也**不进 `skipped`**）：它不是「跳过」，
 *      而是「用户关了」——两者混在一起，用户会以为是自己漏配了环境变量；
 *   3. **占位闸**：`command` / `url` / `args` 里出现 `${` ⇒ 整条跳过并进 `skipped`（这几格不支持占位，
 *      详见 `strayPlaceholderField`）；
 *   4. 每条 `env` / `headers` 里的 `${NAME}` 换成环境里的真值；
 *   5. **任何一格解析不出来 ⇒ 整条跳过**并进 `skipped`：半条注入（一个 header 有了、另一个
 *      还是占位原文）只会让厂商侧报一句离真因很远的认证失败；
 *   6. 没有占位符的条目原样通过（`env` / `headers` 缺席时也不凭空补一个空对象——
 *      「没写这一格」与「写了个空对象」在厂商侧是两件事）。
 *
 * 三个桶为什么是这样分的：`injectable` = 真的投送出去的、`skipped` = 条目没问题但这一趟不投送
 * （去设环境变量 / 改占位写法）、`invalid` = 条目压根不合形状（去改配置）。三者两两之间的**处置动作**
 * 都不同，混桶等于把三句不同的话说成一句。
 *
 * 为什么解析**只发生在注入时**（而不是保存时把真值写回配置）：密钥永不落盘。
 * 因此本函数**不改写入参**：它读原 map、构造新对象，原 map 一个字节都不动
 * （调用方随后落盘的仍是那份原文）。
 *
 * 纯函数：读 `env` 参数而不是 `process.env`——调用方给什么就是什么，测试不必改全局环境，
 * 也不会被宿主里的同名变量搞出假绿。
 */
export function resolveMcpServers(
  servers: McpServers,
  env: Readonly<Record<string, string | undefined>>,
): { injectable: McpServers; skipped: McpSkippedServer[]; invalid: McpInvalidServer[] } {
  const injectable: McpServers = {};
  const skipped: McpSkippedServer[] = [];
  const invalid: McpInvalidServer[] = [];
  for (const [name, entry] of Object.entries(servers)) {
    const shapeIssue = invalidEntryReason(name, entry);
    if (shapeIssue !== null) {
      invalid.push({ name, reason: shapeIssue });
      continue;
    }
    if (entry.enabled === false) continue;
    const strayPlaceholder = strayPlaceholderField(entry);
    if (strayPlaceholder !== null) {
      skipped.push({
        name,
        reason: `${strayPlaceholder} 里出现了 \${…}——只有 env / headers 的值支持占位，整条跳过`,
      });
      continue;
    }
    const values = entry.transport === 'stdio' ? entry.env : entry.headers;
    if (values === undefined) {
      injectable[name] = entry;
      continue;
    }
    const resolved: Record<string, string> = {};
    let skipReason: string | null = null;
    for (const [key, value] of Object.entries(values)) {
      const replaced = resolveValue(value, env);
      if (replaced === null) {
        const variables = [...value.matchAll(MCP_PLACEHOLDER_PATTERN)].map((match) => match[1]);
        const field = entry.transport === 'stdio' ? `env.${key}` : `headers.${key}`;
        skipReason = variables.length === 0
          ? `${field} 用了不支持的占位写法（只支持 \${环境变量名}）`
          : `${field} 引用的环境变量 ${variables.join('、')} 未设置`;
        break;
      }
      resolved[key] = replaced;
    }
    if (skipReason !== null) {
      skipped.push({ name, reason: skipReason });
      continue;
    }
    injectable[name] = entry.transport === 'stdio'
      ? { ...entry, env: resolved }
      : { ...entry, headers: resolved };
  }
  return { injectable, skipped, invalid };
}
