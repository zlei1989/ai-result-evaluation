/**
 * 行级 **MCP 观测格**的推导：把「我们投送了哪几台」与「厂商事件侧说了什么」
 * 合成一份可落盘、可复盘的清单。
 *
 * 为什么推导只在编排层做一次：这一格的消费方有三个（行详情、环境抽屉、排障时的 `run.json`），
 * 各推一份必然漂移；而推导需要的两半——我们的注入集（含**跳过**名单）与厂商证据——只有编排层同时拿得到。
 *
 * ⚠️ **判据不许是模型答复**（硬要求）：本模块一个字都不读消息流。真机抓到过
 * 「MCP 派发失败、模型却把预期结果编出来」——模型说「我用 X 查到了」在证据等级上是零。
 *
 * 判据优先级：
 *   1. **工具表里有 `mcp__<name>__*`** ⇒ `connected`（比厂商自报的 `status` 更硬：工具真的进了会话）；
 *   2. `status === 'failed'` ⇒ `unavailable`（厂商原文点名到台，行失败归因是后一票的事）；
 *   3. 有状态但不是失败（`pending` / `needs-auth` / …）⇒ `unverified`（**不等待**：init 是一次性事件）；
 *   4. 厂商压根没报这一台 ⇒ `unverified` + `judgedBy: 'none'`。**既不写成「已连上」也不写成「没有」**
 *      （`null`（没投送）与 `[]`（投送了确实是空的）在界面上是两句不同的话）。
 */
import {
  ROW_MCP_SOURCE_UNKNOWN,
  type McpServerEntry,
  type RowMcpChannel,
  type RowMcpServer,
} from '@aieval/contracts';

/**
 * 行级失败的归因码：**「必须装入」的 MCP 没起来**。
 *
 * ⚠️ **刻意不进 `TRANSIENT_ROW_RETRY_CODES`**（编排层那张表）：配置 / 环境类失败重试没有意义，
 * 而重试一次 = 再下一遍 61 MB、再起一遍 MCP 进程。守卫在
 * `orchestrator-mcp.test.ts`（打开重试预算后 attempts 仍停在 1）。
 * 它不是厂商归因（不属于 agents 的 `AgentErrorCode` 词表）：判定由编排层做，厂商原文只进文案。
 */
export const AGENT_MCP_UNAVAILABLE = 'AGENT_MCP_UNAVAILABLE';

/** 推导的输入：我们的注入集 + 厂商侧的证据 */
export interface RowMcpEvidence {
  /** 我们**真的投送出去**的条目名（顺序 = 设置页里的顺序；占位已解析、停用已剔除） */
  injected: readonly string[];
  /** 我们**主动跳过**的条目名（`${ENV}` 未设置 / 用了不支持的占位写法）——它们没到厂商那儿 */
  skipped: readonly string[];
  /**
   * **形状不对**的条目名（`resolveMcpServers` 的 `invalid` 桶）：它们连解析都没进，
   * 自然也没到厂商那儿。与 `skipped` 分开传：两者在观测格上**同档**（都是 `unverified`），
   * 但日志里的处置动作相反（改配置 vs 设环境变量），合成一个数组之后这层就再也分不出来了。
   */
  invalid: readonly string[];
  /**
   * 厂商系统层事件里的证据（`vendor-system`）。**`null` = 厂商没投送这一格**（codex / dsh 今天如此），
   * 与 `{servers: [], tools: []}`（投送了、确实是空的）不是一回事——但两者在结论上同档
   * （都没有能支撑 `connected` 的证据），差别只体现在别的格子里。
   */
  vendor: {
    servers: readonly McpServerEntry[] | null;
    tools: readonly string[] | null;
    /**
     * 这份事实是从**哪条通道**读到的——它决定「读到什么算什么结论」。
     * **缺省 = `'vendor-status'`**（claude 的 `system/init`，也是老事件唯一有过的形状）。
     * 三档读法的差别见 `classify`：同一个「表里没有这一台」在前两档是「判据不足」、在
     * `'vendor-tool-table'` 上是**失败**。
     */
    channel?: RowMcpChannel;
  } | null;
}

/**
 * 一台服务在工具表里有没有对应工具。
 *
 * 判据是**精确前缀** `mcp__<name>__`（不是 `startsWith('mcp__' + name)`）：少了结尾那两条下划线，
 * `mcp__playwright-extra__x` 会给 `playwright` 记账——「隔壁那台连上了」被读成「这一台连上了」，
 * 而这正是这一格最要不得的假绿。工具名三家同形（`mcp__<server>__<tool>`），故这条判据是跨家的。
 */
function toolsShowServer(serverName: string, tools: readonly string[] | null): boolean {
  if (tools === null) return false;
  const prefix = `mcp__${serverName}__`;
  return tools.some((tool) => tool.startsWith(prefix));
}

/**
 * 按厂商证据给一台下结论（注入过的与仓库自带的**走同一条判据**——工具表里有没有它的工具、
 * 厂商报的状态是什么，与「谁把它装进去的」无关）。
 *
 * **通道决定读法**（三家各一格），三条分支逐条对应：
 *   1. **工具表里有它** ⇒ `connected`（`vendor-tool-table`）：这是三家里最硬的一条证据，任何通道都优先；
 *   2. **`vendor-tool-table`（dsh）**：工具表就是判据本身——表在、里面没有它 ⇒ **`unavailable`**。
 *      这一家的失败是静默的（工具消失、会话照常跑完、无结构化错误），除工具面之外没有第二个信号；
 *      表**没投送**（`null`）时仍然只记 `unverified`：没有证据就不编一个失败；
 *   3. **`vendor-startup-status`（codex）**：`failed` ⇒ `unavailable`；`ready` ⇒ `connected`
 *      （只到「装上了」这一档，**不暗示工具能调**）；`starting` ⇒ `unverified`；
 *   4. **`vendor-status`（claude）**：`failed` ⇒ `unavailable`；其余有状态 ⇒ `unverified`
 *      （`pending` / `needs-auth` 都不判失败——**不等待**，init 是一次性事件）；
 *   5. 厂商没报这一台 ⇒ `unverified` + `judgedBy: 'none'`（既不说连上、也不说没有）。
 */
function classify(serverName: string, evidence: RowMcpEvidence): Pick<RowMcpServer, 'judgedBy' | 'verdict'> {
  const vendor = evidence.vendor;
  if (vendor === null) return { judgedBy: 'none', verdict: 'unverified' };
  if (toolsShowServer(serverName, vendor.tools)) return { judgedBy: 'vendor-tool-table', verdict: 'connected' };
  const channel = vendor.channel ?? 'vendor-status';
  if (channel === 'vendor-tool-table') {
    return vendor.tools === null
      ? { judgedBy: 'none', verdict: 'unverified' }
      : { judgedBy: 'vendor-tool-table', verdict: 'unavailable' };
  }
  const entry = vendor.servers?.find((item) => item.name === serverName) ?? null;
  if (entry?.status === 'failed') return { judgedBy: channel, verdict: 'unavailable' };
  if (channel === 'vendor-startup-status' && entry?.status === 'ready') {
    return { judgedBy: channel, verdict: 'connected' };
  }
  if (entry?.status !== null && entry?.status !== undefined) return { judgedBy: channel, verdict: 'unverified' };
  return { judgedBy: 'none', verdict: 'unverified' };
}

/**
 * 合成行级观测格。顺序：**我们注入的 → 我们跳过的 → 形状不对的 → 厂商多报的（仓库自带那几台）**。
 *
 * 三条边界：
 *   · **来源采信厂商原值**（`dynamic` / `project` / …），厂商没给这一格就记
 *     `ROW_MCP_SOURCE_UNKNOWN`——这一格是证据，翻成我们的词表就是第二个真源；
 *   · **厂商没报名字的那一条不进格**：这一格的主键是名字，没名字就没法与任何东西对上；
 *     它仍在环境抽屉的「已下发的 MCP 服务」里逐字可见（那里按原样渲染，不做配对）；
 *   · **同名只出一条**，且**我们跳过的那个名字以 `skipped` 收场**：这一格回答的是
 *     「**我们的注入**落地了没有」，所以我们的动作优先于厂商对同名服务的读数
 *     （仓库里恰好有一台同名服务时，它是否连上由环境抽屉那条原始清单回答）。
 *
 * **形状不对的那几条记 `unverified` 而不是失败**（「弱判据不装强结论」的反面用法）：
 * 它们压根没被投送，厂商侧没有任何证据可读，而这是**我们**的配置问题——把它记成 `unavailable`
 * 等于让一行因为「配置里有个手改坏的条目」而失败，把一件能在设置页改好的事说成「这台起不来」。
 */
export function deriveRowMcpServers(evidence: RowMcpEvidence): RowMcpServer[] {
  const rows: RowMcpServer[] = [];
  const seen = new Set<string>();
  const sourceOf = (name: string): string =>
    evidence.vendor?.servers?.find((item) => item.name === name)?.source ?? ROW_MCP_SOURCE_UNKNOWN;

  for (const name of evidence.injected) {
    seen.add(name);
    rows.push({ name, source: sourceOf(name), ...classify(name, evidence) });
  }
  for (const name of evidence.skipped) {
    // 同一条只出现一次：注入集与跳过名单理论上互斥，重名时以「我们真的投送了」为准
    if (seen.has(name)) continue;
    seen.add(name);
    rows.push({ name, source: ROW_MCP_SOURCE_UNKNOWN, judgedBy: 'none', verdict: 'skipped' });
  }
  for (const name of evidence.invalid) {
    // 与 `skipped` 同一条去重口径：三条名单理论上两两互斥，重名时以更靠前的那一档为准
    if (seen.has(name)) continue;
    seen.add(name);
    rows.push({ name, source: ROW_MCP_SOURCE_UNKNOWN, judgedBy: 'none', verdict: 'unverified' });
  }
  for (const entry of evidence.vendor?.servers ?? []) {
    if (entry.name === null || seen.has(entry.name)) continue;
    seen.add(entry.name);
    rows.push({
      name: entry.name,
      source: entry.source ?? ROW_MCP_SOURCE_UNKNOWN,
      ...classify(entry.name, evidence),
    });
  }
  return rows;
}

/**
 * 行失败的那一条文案（模板）：只给**结论为 `unavailable`** 的那几台。
 *
 * 做什么：拿同一份证据跑一遍 `deriveRowMcpServers`（**结论的推导只有那一处**），把其中
 * `unavailable` 的逐台拼成 `MCP「<name>」未能启动：<详情>`；一台都没有 ⇒ `null`（**不编**一条
 * 「总得说点什么」的失败）。
 *
 * `<详情>` 取**厂商原文首行**（多行原文只留第一行：堆栈细节会把界面那一格撑成一段），
 * 厂商没给原文时如实说清「凭什么这么判」——今天只有 dsh 走这一支（它起不来时**不投结构化错误**，
 * 规格里那句「厂商原文照抄」在这一家没有原文可抄，那就说工具表这一条判据本身）。
 *
 * 多台同时没起来时用 `；` 串起来：**每一段都逐字符合模板**（这样 FAQ 按报错原文 grep 仍然命中），
 * 顺序跟注入集一致（用户配的顺序）。
 */
export function mcpUnavailableMessage(evidence: RowMcpEvidence): string | null {
  const unavailable = deriveRowMcpServers(evidence).filter((row) => row.verdict === 'unavailable');
  if (unavailable.length === 0) return null;
  const channel = evidence.vendor?.channel ?? 'vendor-status';
  const clauses = unavailable.map((row) => {
    const entry = evidence.vendor?.servers?.find((item) => item.name === row.name) ?? null;
    return `MCP「${row.name}」未能启动：${unavailableDetail(entry, channel)}`;
  });
  return clauses.join('；');
}

/** 厂商原文首行；没给原文时按通道说清判据（见 `mcpUnavailableMessage` 的 JSDoc） */
function unavailableDetail(entry: McpServerEntry | null, channel: RowMcpChannel): string {
  const first = (entry?.error ?? '').split(/\r?\n/).map((line) => line.trim()).find((line) => line !== '');
  if (first !== undefined) return first;
  if (channel === 'vendor-tool-table') return '工具表里没有它的工具（这一家起不来时不投结构化错误）';
  if (channel === 'vendor-startup-status') return '厂商报启动失败，但没有给出原文';
  return '厂商报连接失败，但没有给出原文';
}
