/**
 * pi 的 **MCP 注入**：canonical 条目 → `createMcpExtension({ loadConfig })` 读的内存对象（**零文件**）。
 *
 * 三条口径写在这里、别处不许各写一份：
 *   · **自给 `loadConfig`**：不落任何 `mcp.json`，被测仓库的 `.pi/mcp.json` 因此连读都读不到
 *     （SDK 下那个信任开关对 MCP 是死的，`isProjectTrusted()` 恒 `true`）；
 *   · **每台显式 `exposure: 'direct'`**：pi 的缺省档是 `codemode`，那一档下工具**只可调用、不声明**，
 *     模型侧看不到 ⇒ 我们的 L3 判据（payload 工具表里出现 `mcp__<名>__`）永不触发，
 *     且 `codemode` 还依赖一个我们没启用的扩展。`direct` 与另三家「工具直接可见」同口径；
 *   · **坏条目在我们这一层摘**：自给 `loadConfig` 会绕过 pi 自己的校验，而 pi 的姿态是
 *     「让这台失败」而不是「跳过它」——本仓口径是**跳过 + 日志 + 行照跑**（与另三家同源）。
 *     条目交到这里时已经过编排层的 `resolveMcpServers`（形状、停用、`${ENV}` 都处置过），
 *     所以这一层是第二道防线，拦的是手改配置与将来多出来的调用点。
 */
import { MCP_ENV_KEY_PATTERN, MCP_HEADER_KEY_PATTERN, MCP_NAME_PATTERN, MCP_UNRESOLVED_PLACEHOLDER, type McpServers } from '@aieval/contracts';
import type { PiLoadedMcpConfig, PiMcpServerConfig, PiMcpServerEntry } from './sdk';

/**
 * 曝光档：**每台都必须写死这个字面量**。
 *
 * 档位与判据是绑定的（`direct` 档工具进 payload 的 `tools`；`deferred` / `codemode` 只把服务器
 * 写进系统提示词的 `mcp_servers` 段；`hidden` 连段都没有）——档位一改，运行级观测格那条
 * 「表里没有这一台 ⇒ 没起来」的读法就跟着失真。故值域在类型上收成 `'direct'`。
 */
export const PI_MCP_EXPOSURE = 'direct' as const;

/**
 * 第一次 prompt 等 `direct` 档服务器多久（毫秒）。
 *
 * pi 的默认值是 10000，这里显式写同一个数：不写就等于把一本次运行的时间行为交给厂商的缺省
 * （改一次我们不会知道），而这一格决定了「服务器起得慢」是被等还是被记成没起来。
 * 它**不是连接超时**——超时只影响第一次 prompt 的等待，之后照常重连。
 */
export const PI_MCP_STARTUP_WAIT_MS = 10_000;

/** 被我们摘掉的条目：名字 + 中文原因（进 `errors` 与日志，不静默） */
export interface PiMcpDropped {
  name: string;
  reason: string;
}

/**
 * canonical 条目 → pi 的条目。
 *
 * 摘条目的判据逐条对齐本仓口径，且**都在形状层**（不问业务条件、不碰环境变量——`${ENV}` 已经
 * 由编排层解析过）：
 *   · 名字不合 `McpServers` 的键模式 ⇒ 摘（这个名字同时是工具名前缀 `mcp__<名>__` 的那一段）；
 *   · `transport` 不认识 / stdio 缺 `command` / http 缺 `url` ⇒ 摘（半个条目编不出它本来该是什么）；
 *   · `command` / `url` / `args` 里还剩 `${`：这几格**不支持占位**，pi 会把它当字面量去 spawn 或请求；
 *   · `env` / `headers` 的值里还剩 `${`：pi 在连接时解析，解析不出来是**让这一台失败**（不是跳过）——
 *     与本仓「跳过 + 行照跑」相反，故在我们这层就摘掉并说清是哪个键；
 *   · `env` 的键不合 `MCP_ENV_KEY_PATTERN`：pi 一个键都不校验，带 `=` / 空格的键会原样进 `spawn` 的
 *     `env`（Node 侧行为未定义）；
 *   · `headers` 的键为空 / 含空白或冒号：header 名不合法时请求头会被静默拼坏。
 *
 * `enabled === false` 静默跳过：那是「用户关了」，不是「这一台有问题」——两者混进同一份名单，
 * 用户会以为自己漏配了环境变量（与 `resolveMcpServers` 的三个桶同一条口径）。
 */
export function toPiMcpServers(servers: McpServers): { entries: PiMcpServerEntry[]; dropped: PiMcpDropped[] } {
  const entries: PiMcpServerEntry[] = [];
  const dropped: PiMcpDropped[] = [];
  for (const [name, entry] of Object.entries(servers)) {
    /**
     * **停用先判**：`enabled === false` 是「用户关了」，不是「这一台有问题」。
     * 形状判据若排在它前面，一台「关了且形状也不全」的服务器会进 `dropped`、被日志与厂商的
     * 启动报告点名，用户会去查一台自己关掉的服务器（与编排层 `resolveMcpServers` 的三个桶同口径）。
     * 非对象条目取不到 `enabled`，交给下面的形状判据处置。
     */
    if (typeof entry === 'object' && entry !== null && (entry as { enabled?: unknown }).enabled === false) continue;
    const reason = untranslatableReason(name, entry);
    if (reason !== null) {
      dropped.push({ name, reason });
      continue;
    }
    const common = { exposure: PI_MCP_EXPOSURE };
    if (entry.transport === 'stdio') {
      entries.push({
        name,
        config: {
          type: 'stdio',
          command: entry.command,
          // 可选格缺席就不写这个键：给一个空数组在厂商侧是「显式声明没有参数」，与「没声明」不是一件事
          ...(entry.args === undefined ? {} : { args: [...entry.args] }),
          ...(entry.env === undefined ? {} : { env: { ...entry.env } }),
          ...common,
        },
      });
      continue;
    }
    entries.push({
      name,
      config: {
        type: 'http',
        url: entry.url,
        ...(entry.headers === undefined ? {} : { headers: { ...entry.headers } }),
        ...common,
      },
    });
  }
  return { entries, dropped };
}

/**
 * 这一条**为什么翻不出来**；翻得出来返回 `null`。
 *
 * 与 claude / codex 那两个翻译器里的形状闸同一条纪律：入参在类型上可信、在运行期不可信
 * （`loadConfig` 故意不做 schema 校验，手改的配置能一路读到这里）。
 *
 * ⚠️ **这里判的每一条都必须在契约层也能拦**（`resolveMcpServers` 的 `invalid` 桶），否则
 * 「契约说合法、我们摘掉」的那一条会被运行级观测格读成「厂商没起来」——整行假失败，且文案指着一台
 * 从没起过的服务器。两层的判据**同源**（名字 / env 键 / headers 键的模式都从 `@aieval/contracts` 取），
 * 这一层只是手改配置的第二道防线。唯一的例外是**容器格不是数组**（见下面 `args` 那一条）：
 * 契约用 zod 判形状，这一层只能自己判，判不出来就摘掉——**绝不抛**（抛会让整行以一句与真因
 * 无关的 TypeError 收场，连一条出站请求都没有）。
 */
function untranslatableReason(name: string, entry: McpServers[string]): string | null {
  if (!MCP_NAME_PATTERN.test(name)) return '名字不合法：只能是字母、数字、下划线或连字符，长度 1–32';
  if (entry === null || typeof entry !== 'object') return '不是一个对象（配置里这一条不是 JSON 对象）';
  if (entry.transport === 'stdio') {
    if (typeof entry.command !== 'string' || entry.command === '') return 'stdio 条目缺 command（要一个非空字符串）';
    if (MCP_UNRESOLVED_PLACEHOLDER.test(entry.command)) return 'command 里出现了 ${…}——这一格不支持占位，整条跳过';
    // 手改配置可以把 `args` 写成字符串 / 对象：不是数组就没有「第几个参数」可言，整条摘掉
    if (entry.args !== undefined && !Array.isArray(entry.args)) {
      return `args 不是数组（是 ${JSON.stringify(entry.args)}）——这一格要一个字符串数组，整条跳过`;
    }
    const strayArg = (entry.args ?? []).findIndex((arg) => typeof arg !== 'string' || MCP_UNRESOLVED_PLACEHOLDER.test(arg));
    if (strayArg >= 0) return `args[${strayArg}] 不是可用的字符串（这一格不支持 \${…} 占位），整条跳过`;
    for (const [key, value] of Object.entries(entry.env ?? {})) {
      if (!MCP_ENV_KEY_PATTERN.test(key)) return `env 的键 ${key} 不合法（只能是字母、数字与下划线，且不以数字开头）`;
      if (typeof value !== 'string' || MCP_UNRESOLVED_PLACEHOLDER.test(value)) {
        return `env.${key} 的占位没解析出来（还剩 \${…}）——pi 遇到这一格是让整台失败，本仓口径是跳过`;
      }
    }
    return null;
  }
  if (entry.transport !== 'http') return '缺 transport 这一格（只能是 stdio 或 http）';
  if (typeof entry.url !== 'string' || entry.url === '') return 'http 条目缺 url（要一个非空字符串）';
  if (MCP_UNRESOLVED_PLACEHOLDER.test(entry.url)) return 'url 里出现了 ${…}——这一格不支持占位，整条跳过';
  for (const [key, value] of Object.entries(entry.headers ?? {})) {
    if (!MCP_HEADER_KEY_PATTERN.test(key)) {
      return `headers 的键 ${JSON.stringify(key)} 不合法（HTTP 头名不能含空白或冒号）——整条跳过`;
    }
    if (typeof value !== 'string' || MCP_UNRESOLVED_PLACEHOLDER.test(value)) {
      return `headers.${key} 的占位没解析出来（还剩 \${…}）——pi 遇到这一格是让整台失败，本仓口径是跳过`;
    }
  }
  return null;
}

/**
 * 造 `createMcpExtension` 要的 `loadConfig` 回调：**每次调用现造一份返回值**。
 *
 * 为什么不是闭包里那份对象的引用：厂商侧会按自己的生命周期读它（会话启动时一次、重连时可能再来），
 * 出口与入参共享引用的话，那边顺手改一下条目就改掉了我们这份（与 `providerModel` 逐行复制同一条处置）。
 * ⚠️ **顶层展开不够**：`args` / `env` / `headers` 是容器格，只 `{...config}` 会让它们与 `plan`
 * 里的那一份**跨调用共享**（厂商往 `env` 里补一个默认值、往 `args` 里 push 一项，都会留在我们这份
 * plan 上并被下一次 `loadConfig()` 带出去）⇒ 三个容器逐格复制。
 *
 * `errors` 装的是被摘掉的那几条（`<名>: <原因>`）。它的消费方**只有一个**：厂商的
 * `reportProblems` → `ctx.ui.notify`，而装配面没给 UI 上下文 ⇒ `ExtensionRunner` 的缺省
 * `noOpUIContext`（`runner.js`）把它吃掉，**事件里一个字都不会出现**。
 * 故「配了但没注入」必须由装配面自己落成一条可见的 `log`（`index.ts` 的 MCP 那一段），
 * 不能指望这一格：它只是照厂商的形状把错误交出去，不代表有人会念出来。
 * `autoEnableCodemode` 显式关：我们不产生非 `direct` 档的条目，那个自动启用只会多挂一个工具。
 */
export function createPiMcpLoadConfig(plan: { entries: PiMcpServerEntry[]; dropped: PiMcpDropped[] }): () => PiLoadedMcpConfig {
  return () => ({
    servers: plan.entries.map((entry) => ({ name: entry.name, config: copyServerConfig(entry.config) })),
    errors: plan.dropped.map((item) => `${item.name}: ${item.reason}`),
    autoEnableCodemode: false,
  });
}

/** 一份条目的**独立副本**（三个容器格逐格复制，见 `createPiMcpLoadConfig` 的第二条口径） */
function copyServerConfig(config: PiMcpServerConfig): PiMcpServerConfig {
  return {
    type: config.type,
    ...(config.command === undefined ? {} : { command: config.command }),
    ...(config.args === undefined ? {} : { args: [...config.args] }),
    ...(config.env === undefined ? {} : { env: { ...config.env } }),
    ...(config.url === undefined ? {} : { url: config.url }),
    ...(config.headers === undefined ? {} : { headers: { ...config.headers } }),
    exposure: config.exposure,
  };
}
