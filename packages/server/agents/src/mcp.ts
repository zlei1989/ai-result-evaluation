/**
 * MCP 的**注入落点**：canonical 条目 → 各家厂商的形状，以及行内
 * `.npmrc` 的 registry 落盘。
 *
 * 两条口径写在这里、别处不许各写一份：
 *   · **适配器只认入参、不读 `loadConfig()`**（控制权在编排层）：本模块的函数收什么译什么，
 *     条目从 `AgentRunInput.mcpServers` 来，由编排层在候选执行那一处填；
 *   · **claude 一律走 SDK 参数**（`Options.mcpServers`），**不落 `<configHome>/.claude.json`**：
 *     参数是编程入口，优先级实测高于磁盘配置，且不落盘就不会与宿主那份混起来。
 *     `strictMcpConfig` **保持关闭**（不压制被测仓库自带的 `.mcp.json`，那是用户口径）。
 *
 * 本模块只有纯函数 + 两处 IO（写行内 npmrc / 读宿主 npmrc），没有厂商对象、没有全局状态：
 * 条目翻译的守卫因此可以逐字断言形状（见 `mcp.test.ts`）。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { McpServerConfig, McpServers } from '@aieval/contracts';

/**
 * claude Agent SDK 的 `Options.mcpServers` 条目（窄结构，**不从厂商包 import type**，
 * 与 `providers/claude-code/sdk.ts` 同一条纪律）。
 *
 * 形状逐字取自安装态 SDK 的类型面（`sdk.d.ts` 的 `McpStdioServerConfig` / `McpHttpServerConfig`）：
 *   · stdio 是 `type:'stdio'` + `command` / `args?` / `env?`，**没有 `cwd`**（子进程继承 CLI 的 cwd）；
 *   · http 是 `type:'http'` + `url` / `headers?`。
 * canonical 侧只有这两种传输（`sse` / `sdk` 那两类本仓不做），故这里也只声明这两种。
 */
export type ClaudeMcpServer =
  | { type: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
  | { type: 'http'; url: string; headers?: Record<string, string> };

/**
 * 翻译前的**形状闸**：这一条拿得到自己那一支的必需格吗（stdio 的 `command`、http 的 `url`）。
 *
 * 这是**第二道防线**，不是第一道：第一道在契约层的 `resolveMcpServers`（它的 `invalid` 桶 +
 * 编排层的 WARN），正常路径上畸形条目到不了这里。留这一道是因为翻译器有独立的入口
 * （`toDshMcpPluginLines` 等对 `AgentRunInput.mcpServers` 直接开口，见 `providers/<家>/index.ts`），
 * 而这里的坏法**不是静默**：dsh 那支对 `undefined` 直接抛 `TypeError`（`quoteYaml` 里 `value.replaceAll`），
 * 一整行会以内部错误收口——一个手改坏的配置条目不该有这个后果。
 *
 * 为什么是「跳过这一条」而不是「补一个空串」：空 `command` / 空 `url` 在厂商侧是**另一件事**
 * （一台起不来、或者打到一个空地址），凭我们手里的半个条目编不出它本来该是什么。
 */
function isTranslatableEntry(entry: McpServerConfig | null | undefined): boolean {
  if (entry === null || entry === undefined) return false;
  if (entry.transport === 'stdio') return typeof entry.command === 'string' && entry.command !== '';
  if (entry.transport === 'http') return typeof entry.url === 'string' && entry.url !== '';
  return false;
}

/**
 * canonical 条目 → claude 的 `Options.mcpServers`。
 *
 * 入参必须是**已经过 `resolveMcpServers` 的那一份**（占位已解析、停用条目已剔除）——
 * 「解析」与「翻译」分成两步是因为解析的产物还要被编排层记账（`skipped` 进行级观测格），
 * 而翻译只需要形状。翻译器本身**不再判**任何业务条件（不问 `enabled`、不碰环境变量），
 * 于是「同一份条目 → 什么形状」可以逐字断言；唯一的例外是 `isTranslatableEntry` 那道形状闸，
 * 它判的是「这一条翻不翻得出来」，不是业务条件。
 *
 * 三条形状口径：
 *   · `transport` 直接翻成厂商的判别键 `type`（两个词同义，本仓不做二次映射表）；
 *   · **可选格缺席就不写**：`args` / `env` / `headers` 没给时整个键不出现——给一个空数组或空对象
 *     在厂商侧是「显式声明为空」，与「没声明」不是一件事；
 *   · **不写 `cwd`**（claude 的 stdio 没有这个字段）。
 */
export function toClaudeMcpServers(servers: McpServers): Record<string, ClaudeMcpServer> {
  const translated: Record<string, ClaudeMcpServer> = {};
  for (const [name, entry] of Object.entries(servers)) {
    if (!isTranslatableEntry(entry)) continue;
    translated[name] = translateClaudeEntry(entry);
  }
  return translated;
}

/**
 * 「可选格缺席就不写那个键」的唯一写法（两个**对象**翻译器共用：claude 与 codex；dsh 那侧拼的是
 * YAML 行、用 `if` 判，见 `toDshMcpPluginLines`）。形状口径由 canonical 条目定。
 *
 * `undefined` ⇒ 空对象（展开后**这个键根本不出现**），有值 ⇒ 单键对象。为什么不写
 * `...(x === undefined ? {} : { k: x })`：两个翻译器逐格调本函数（claude 三处、codex 三处），
 * 每一处手写那段三元都要自己把 `x` 收窄一次——漏一次就是「显式声明为空」（空数组 / 空对象）
 * 混进厂商配置，而厂商侧那两件事不是一回事（见 `toClaudeMcpServers` 的三条形状口径）。
 * 值一律由调用方**新建**（`[...args]` / `{ ...env }`）：出口与入参共享引用的话，厂商适配器
 * 顺手改一下出口对象就会改掉契约里那一份。
 */
function optional<K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> {
  return value === undefined ? {} : ({ [key]: value } as Partial<Record<K, V>>);
}

/** 单条翻译（拆出来只为让上面那个循环读起来是一句话） */
function translateClaudeEntry(entry: McpServerConfig): ClaudeMcpServer {
  if (entry.transport === 'stdio') {
    return {
      type: 'stdio',
      command: entry.command,
      ...optional('args', entry.args?.slice()),
      ...optional('env', entry.env === undefined ? undefined : { ...entry.env }),
    };
  }
  return {
    type: 'http',
    url: entry.url,
    ...optional('headers', entry.headers === undefined ? undefined : { ...entry.headers }),
  };
}

/**
 * codex 的 `mcp_servers.<name>` 一台（窄结构，**不从厂商包 import type**）。
 *
 * 形状逐字取自 codex 二进制内嵌的官方文档与 `RawMcpServerConfig`（28 个字段，实测形状见
 * `docs/features/mcp-config.md` 的「三家的逐字形状」）：**snake_case、没有 `type`**
 * （传输靠字段推断）、http 的头叫 **`http_headers`**（不是 claude 的 `headers`）。
 *
 * 刻意不含 `cwd`：canonical 里没有这一格，而 codex 的 stdio 子进程继承
 * app-server 的 cwd（= 行工作区）。
 */
export interface CodexMcpServer {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  http_headers?: Record<string, string>;
  /** 启动预算（秒）：见 `CODEX_MCP_STARTUP_TIMEOUT_SEC` */
  startup_timeout_sec?: number;
}

/**
 * MCP server 的启动超时（秒）。**必须给**：codex 的默认值管不到本仓的场景——
 * 行内首次注入 playwright MCP 要现下载 61 MB（实测 17.2 s），而等待预算是
 * **≥ 20 s**。给一个比预算小的值会把「正在下载」判成启动失败，而那正是这一趟要避免的假红。
 * 取 30 与厂商文档里的默认值同档（`docs/protocols/comparison.md:46`），一分钱不多花。
 */
export const CODEX_MCP_STARTUP_TIMEOUT_SEC = 30;

/**
 * canonical 条目 → codex 线程级 config 的 `mcp_servers`。
 *
 * 落点为什么是**线程级 `config`**（而不是 `$CODEX_HOME/config.toml`）：这一格经 app-server 协议
 * 随 `thread/start` 传入，优先级高于 `~/.codex` 那类文件配置，且与本次运行的路由（`model_providers`）
 * 走同一个入口——**同一份配置、同一个时刻、同一个进程读**，少一个「文件被谁改过」的变量。
 * 判据（同一 server / 同一模型的两条路对照）：
 *   · 只给 `thread/start.config.mcp_servers`、`$CODEX_HOME` 里**不写** config.toml
 *     ⇒ `mcpServer/startupStatus/updated` 走 `starting → ready`；
 *   · 写 config.toml 那条路是已知可达的对照。
 * ⇒ 两条路都能到 `ready`，本仓取前者（少写一份文件、少一处与厂商自身持久化层混在一起的落点）。
 * 若将来这条路失效，退路是 `$CODEX_HOME/config.toml` 的 `[mcp_servers.<name>]`（形状与本函数**逐字相同**，
 * 只是序列化成 TOML）——**换路之前按上面两条判据实测一遍**，别凭表象改。
 *
 * 三条形状口径（与 claude 那侧同源）：可选格缺席就不写那个键；不写 `cwd`；`transport` 不落成
 * `type`（codex 靠字段推断——多一个 `type` 会让整份 config 解析失败）。
 */
export function toCodexMcpServers(servers: McpServers): Record<string, CodexMcpServer> {
  const translated: Record<string, CodexMcpServer> = {};
  for (const [name, entry] of Object.entries(servers)) {
    if (!isTranslatableEntry(entry)) continue;
    // 形状只在这一处按传输分叉，`startup_timeout_sec` 随后统一补上：两个分支各写一遍
    // 迟早出现「一支改了超时、另一支没改」（两支的值必须逐字相同，见上一段）
    const shape: CodexMcpServer = entry.transport === 'stdio'
      ? {
        command: entry.command,
        ...optional('args', entry.args?.slice()),
        ...optional('env', entry.env === undefined ? undefined : { ...entry.env }),
      }
      : {
        url: entry.url,
        ...optional('http_headers', entry.headers === undefined ? undefined : { ...entry.headers }),
      };
    translated[name] = { ...shape, startup_timeout_sec: CODEX_MCP_STARTUP_TIMEOUT_SEC };
  }
  return translated;
}

/** dsh 的插件行（`- id: mcp-<name>`）落进 overlay 时的缩进层级：`insert:` 的下级 */
const DSH_MCP_INSERT_INDENT = '    ';

/**
 * YAML 标量：**一律双引号 + 转义**（值里的 `:` / `"` / `\` 都会破坏行结构，`dsh` 的模型名与
 * 端点地址里三种都出现过）。**导出**是因为 dsh 的 overlay 拼装器（`providers/dsh/index.ts`）也要用：
 * 那份 overlay 是**一份 YAML**，两个拼装点（模型路由 patch 与 MCP 插件行）各留一份转义实现，
 * 迟早出现「一处转了、一处没转」——而 YAML 解析失败的表现是整行起不来。
 */
export function quoteYaml(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

/** 一个 YAML 映射（键与值都引号化）：`env` / `headers` 共用，两份各写一遍必然漂移 */
function yamlMapLines(key: string, entries: Record<string, string>, indent: string): string[] {
  return [
    `${indent}${key}:`,
    ...Object.entries(entries).map(([name, value]) => `${indent}  ${quoteYaml(name)}: ${quoteYaml(value)}`),
  ];
}

/**
 * canonical 条目 → dsh per-launch overlay 里那几行 `insert`。
 *
 * dsh 的注入通道只有插件行一条（封闭方法表 ⇒ 没有「程序化入口」那种东西）：
 * 一台 server = 一行 `@deepseek-ai/dsh-mcp-client`，**新增行必须走 `insert`**
 * （顶层 `- id:` 只能改或禁既有行，见 `dsh/index.ts` 的文件头）。
 *
 * 返回值是**已缩进好的 YAML 行**（4 空格，正好是 `- insert:` 的下级），由
 * `buildDshRoutePatch` 原样拼进 overlay——翻译与拼装分开，形状才可逐字断言。
 *
 * 三条形状口径：
 *   · `serverName` **就是我们的名字**（工具名前缀 `mcp__<serverName>__` 里的那一段，
 *     三家同形）；`id` 另起 `mcp-<name>`（插件行的身份，不是服务名——日志里要对得上）；
 *   · `transport` 是 dsh 的两档 `stdio` / `streamable-http`（**不是** canonical 的 `http`）；
 *   · http 的头在 dsh 侧仍叫 `headers`（与 claude 同、与 codex 的 `http_headers` 不同）。
 *
 * 拿不到必需格的条目（缺 `url` / 缺 `command`）**整条跳过、不抛**：见 `isTranslatableEntry`。
 */
export function toDshMcpPluginLines(servers: McpServers): string[] {
  const lines: string[] = [];
  for (const [name, entry] of Object.entries(servers)) {
    // 第二道形状闸（见 `isTranslatableEntry`）：这一支对 `undefined` **会抛**——`quoteYaml(entry.url)`
    // 里的 `value.replaceAll` 直接 TypeError，整行以内部错误收口。上游（契约层的 invalid 桶）已经拦过一道，
    // 这里是翻译器自己的防线，理由与 claude / codex 两支逐字相同。
    if (!isTranslatableEntry(entry)) continue;
    lines.push(
      `${DSH_MCP_INSERT_INDENT}- id: mcp-${name}`,
      `${DSH_MCP_INSERT_INDENT}  name: "@deepseek-ai/dsh-mcp-client"`,
      `${DSH_MCP_INSERT_INDENT}  config:`,
      `${DSH_MCP_INSERT_INDENT}    serverName: ${quoteYaml(name)}`,
    );
    if (entry.transport === 'stdio') {
      lines.push(
        `${DSH_MCP_INSERT_INDENT}    transport: stdio`,
        `${DSH_MCP_INSERT_INDENT}    command: ${quoteYaml(entry.command)}`,
      );
      if (entry.args !== undefined) {
        lines.push(`${DSH_MCP_INSERT_INDENT}    args:`, ...entry.args.map((arg) => `${DSH_MCP_INSERT_INDENT}      - ${quoteYaml(arg)}`));
      }
      if (entry.env !== undefined) lines.push(...yamlMapLines('env', entry.env, `${DSH_MCP_INSERT_INDENT}    `));
      continue;
    }
    lines.push(
      `${DSH_MCP_INSERT_INDENT}    transport: streamable-http`,
      `${DSH_MCP_INSERT_INDENT}    url: ${quoteYaml(entry.url)}`,
    );
    if (entry.headers !== undefined) lines.push(...yamlMapLines('headers', entry.headers, `${DSH_MCP_INSERT_INDENT}    `));
  }
  return lines;
}

/**
 * 宿主 npm 配置文件的路径。**为什么是 `homedir()` 而不是子进程环境里的 `HOME`**：
 * 行的子进程 `HOME` 已经被 `buildSubprocessEnv` 换成行私有目录（那正是「registry 掉回公网」的
 * 机制来源），而这里要读的是**宿主**那一份 ⇒ 只能取进程自己的家目录（本层从不写 `process.env`）。
 */
export function hostNpmrcPath(): string {
  return join(homedir(), '.npmrc');
}

/**
 * 读一份 npmrc 文本，**读不到就 `null`**（不存在 / 是目录 / 没有权限都归这一档）。
 *
 * 两条容错：
 *   · **绝不抛**：这一步只是「让行内 registry 不掉回公网」的尽力而为，读不到宿主配置不能让整行失败；
 *   · **剥掉 UTF-8 BOM**：PowerShell 5.1 的 `Set-Content` / `ConvertTo-Json` 默认带 BOM，
 *     不剥的话第一行会变成 `\uFEFFregistry=…`、正则匹配不上 ⇒ 宿主明明配了却「什么都不做」（见 AGENTS.md）。
 */
export function readNpmrcText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8').replace(/^\uFEFF/, '');
  } catch {
    return null;
  }
}

/**
 * 从 npmrc 文本里取 **registry 那一行**（原文照抄，含它自己的空白与大小写）。
 *
 * 三条判定：
 *   · 行首（可有空白）是 `registry` + `=` 才算——注释行里的 registry 不算（`#` 开头）；
 *   · **多条同名键取最后一条**：npm 的 ini 解析是「后者覆盖前者」，取第一条会与
 *     `npm config get registry` 的实际生效值不一致（那种不一致的表现是「明明写进去了还是慢」）；
 *   · 没有这一行 ⇒ `null` ⇒ 调用方**什么都不做**（凭空写一个公网 registry 进去比不写更糟）。
 */
export function hostRegistryLine(npmrcText: string | null): string | null {
  if (npmrcText === null) return null;
  let found: string | null = null;
  for (const line of npmrcText.split(/\r?\n/)) {
    if (/^\s*registry\s*=/i.test(line)) found = line.trim();
  }
  return found === null || found === '' ? null : found;
}

/**
 * 把宿主的 registry 那一行写进行 `configHome` 的 `.npmrc`；宿主没有 ⇒ **什么都不做**（返回 `null`，
 * 连目录都不建）。返回写进去的那一行（或 `null`），供调用方记日志。
 *
 * 为什么需要它：行的 `HOME` 一换，npm 的 `userconfig` 就从
 * `~/.npmrc` 变成 `<行HOME>/.npmrc`（不存在）⇒ registry 从内网镜像掉回公网，行内首次注入
 * playwright MCP 从 ~4 s 变成 **17.2 s / 61 MB**——≥ 20 s 的等待预算就是被这件事撑起来的。
 *
 * 三条边界：
 *   · **只写那一行**：宿主 `.npmrc` 里其余内容（含认证 token）一个字节都不进行内；
 *   · **不碰宿主**：只读宿主那一份，写的是行内路径；
 *   · 权限位 `0600`（与 dsh 的 overlay 同口径）。这里不套「临时文件 + rename」的原子写：
 *     这份文件丢了只会让下一次注入慢十几秒，不会像配置那样「写坏就再也读不回来」。
 */
export function writeRowNpmrc(input: { configHome: string; hostNpmrc: string | null }): string | null {
  const line = hostRegistryLine(input.hostNpmrc);
  if (line === null) return null;
  mkdirSync(input.configHome, { recursive: true });
  writeFileSync(join(input.configHome, '.npmrc'), `${line}\n`, { encoding: 'utf8', mode: 0o600 });
  return line;
}
