/**
 * **厂商工具表里的 MCP 工具名**：判「这一台在不在表里」的共享匹配器。
 *
 * 为什么单独一格而不是各家自己拼前缀：厂商把服务器名写进工具名的方式**不完全一致**——
 * 差别只在名字里的**非 `[A-Za-z0-9_]` 字符**（我们的名字正则允许 `-`，`github-mcp` /
 * `chrome-devtools` 这类命名很常见）：
 *   · **pi** 把整条工具名里的非 `[A-Za-z0-9_]` 改写成 `_`（`mcp__my-server__echo` ⇒
 *     `mcp__my_server__echo`）；
 *   · **codex** 同样把 `-` 改写成 `_`（它按命名空间暴露，命名空间是 `mcp__my_server`）；
 *   · **cc** 与 **dsh** 原样保留（cc 的 `system/init.tools`、dsh 的 `request/header` 里都是
 *     `mcp__my-server__echo`）。
 * ⇒ 判据必须**两种形态都认**，否则带连字符的名字会被判成「表里没有它」——在
 * `vendor-tool-table` 通道下那就是**整候选失败**，而模型侧其实调得动。
 *
 * 两条不变量：
 *   1. **先精确、再归一化**：原始名命中就不再看归一化形态。少了这一条，「两台归一化后同形」
 *      时会把 A 的工具记到 B 头上（`my-server` 与 `my_server` 在归一化那一层是同一个名字）；
 *   2. **撞名要如实呈现**：两台归一化后同形时，归一化命中**归不到具体哪一台**——调用方用
 *      `matchMcpToolName(name, tools, true)` 把它判成「证据不足」，既不写成连上、也不写成没有
 *      （见 `collidingMcpServerNames`）。
 *
 * 前缀必须是**完整的一段**（`mcp__<name>__`，不是 `mcp__<name>`）：少了结尾那两条下划线，
 * `mcp__playwright-extra__x` 会给 `playwright` 记账——「隔壁那台连上了」被读成「这一台连上了」。
 */
/** 工具名的固定前缀（`mcp__<服务器名>__<工具名>`） */
export const MCP_TOOL_NAME_PREFIX = 'mcp__';

/**
 * 厂商 sanitize 后的名字形态：非 `[A-Za-z0-9_]` 一律写成 `_`。
 *
 * 注意这是**幂等**的（`a-b` 与 `a_b` 归一化后同形）——正因为不单射，才需要「先精确、再回退」
 * 与撞名判定两件事一起做。
 */
export function normalizeMcpName(name: string): string {
  return name.replace(/[^A-Za-z0-9_]/g, '_');
}

/** 一次命中的结果：命中的是**哪一条工具名**、命中的是**哪一种形态** */
export interface McpToolMatch {
  /** 命中的那一条工具名（逐字，供日志与如实呈现引用） */
  tool: string;
  /** `exact` = 原始名逐字命中；`normalized` = 厂商把名字里的字符改写成了 `_` */
  form: 'exact' | 'normalized';
}

/**
 * 这一台在工具表里有没有工具。先按原始名找精确前缀，找不到再试归一化形态。
 *
 * @param ambiguousNormalized 归一化形态**已知撞名**时置真：那时归一化命中归不到这一台，
 *   一律返回 `null`（调用方据此给「证据不足」而不是「已连上」或「没有」）。
 */
export function matchMcpToolName(
  serverName: string,
  tools: readonly string[] | null,
  ambiguousNormalized = false,
): McpToolMatch | null {
  if (tools === null) return null;
  const exact = `${MCP_TOOL_NAME_PREFIX}${serverName}__`;
  const hit = tools.find((tool) => tool.startsWith(exact));
  if (hit !== undefined) return { tool: hit, form: 'exact' };
  if (ambiguousNormalized) return null;
  const normalized = `${MCP_TOOL_NAME_PREFIX}${normalizeMcpName(serverName)}__`;
  if (normalized === exact) return null;
  const fallback = tools.find((tool) => tool.startsWith(normalized));
  return fallback === undefined ? null : { tool: fallback, form: 'normalized' };
}

/**
 * 归一化后互相撞名的服务器名（两台及以上同形，如 `my-server` 与 `my_server`）。
 *
 * 用途只有一个：把这些名字排除在**归一化回退**之外。名字本身仍然合法（`MCP_NAME_PATTERN`
 * 允许 `-` 与 `_` 并存），所以这是**如实呈现**的问题、不是配置错误——精确命中照样算数。
 */
export function collidingMcpServerNames(names: readonly string[]): Set<string> {
  const byNormalized = new Map<string, string[]>();
  for (const name of names) {
    const key = normalizeMcpName(name);
    const bucket = byNormalized.get(key);
    if (bucket === undefined) byNormalized.set(key, [name]);
    else bucket.push(name);
  }
  const colliding = new Set<string>();
  for (const bucket of byNormalized.values()) {
    if (bucket.length < 2) continue;
    for (const name of bucket) colliding.add(name);
  }
  return colliding;
}
