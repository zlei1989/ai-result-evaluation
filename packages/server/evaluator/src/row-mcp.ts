/**
 * 行级 **MCP 观测格**的推导：把「我们投送了哪几台」与「厂商事件侧说了什么」
 * 合成一份可落盘、可复盘的清单。
 *
 * 为什么推导只在编排层做一次：这一格的消费方有两个（环境抽屉的「本行 MCP」格、排障时的 `run.json`），
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
  collidingMcpServerNames,
  matchMcpToolName,
  normalizeMcpName,
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
 * 按厂商证据给一台下结论（注入过的与仓库自带的**走同一条判据**——工具表里有没有它的工具、
 * 厂商报的状态是什么，与「谁把它装进去的」无关）。
 *
 * **通道决定读法**（四家各一格），四条分支逐条对应：
 *   1. **工具表里有它** ⇒ `connected`（`vendor-tool-table`）：这是最硬的一条证据，任何通道都优先。
 *      名字比对走共享匹配器（`@aieval/contracts` 的 `matchMcpToolName`）：**先精确、再认厂商 sanitize
 *      后的形态**（`-` ⇒ `_`）——带连字符的名字在 pi 与 codex 那边出站就是下划线形态，用原始名拼
 *      精确前缀会把「模型调得动」判成「没起来」；
 *   2. **`ambiguous`（归一化后与别台同形）** ⇒ `unverified`：那时归一化命中归不到这一台，
 *      而 `vendor-tool-table` 通道的「表里没有它」是**失败档**（整行 `AGENT_MCP_UNAVAILABLE`）
 *      ⇒ 证据不足时**只能**如实记「未验证」，并附一句说明（`note`）。精确命中不受影响；
 *   3. **`vendor-tool-table`（dsh / pi）**：工具表就是判据本身——表在、里面没有它 ⇒ **`unavailable`**。
 *      这一家的失败是静默的（工具消失、会话照常跑完、无结构化错误），除工具面之外没有第二个信号；
 *      表**没投送**（`null`）时仍然只记 `unverified`：没有证据就不编一个失败；
 *   4. **`vendor-startup-status`（codex）**：`failed` ⇒ `unavailable`；`ready` ⇒ `connected`
 *      （只到「装上了」这一档，**不暗示工具能调**）；`starting` ⇒ `unverified`；
 *   5. **`vendor-status`（claude）**：`failed` ⇒ `unavailable`；其余有状态 ⇒ `unverified`
 *      （`pending` / `needs-auth` 都不判失败——**不等待**，init 是一次性事件）；
 *   6. 厂商没报这一台 ⇒ `unverified` + `judgedBy: 'none'`（既不说连上、也不说没有）。
 */
function classify(
  serverName: string,
  evidence: RowMcpEvidence,
  ambiguous: boolean,
): Pick<RowMcpServer, 'judgedBy' | 'verdict'> {
  const vendor = evidence.vendor;
  if (vendor === null) return { judgedBy: 'none', verdict: 'unverified' };
  const channel = vendor.channel ?? 'vendor-status';
  if (matchMcpToolName(serverName, vendor.tools, ambiguous) !== null) {
    return { judgedBy: 'vendor-tool-table', verdict: 'connected' };
  }
  // 撞名那一支：表在也不能判它没起来（见上面第 2 条）。判据仍记通道——证据确实是这条通道给的
  if (ambiguous && vendor.tools !== null) return { judgedBy: channel, verdict: 'unverified' };
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
 * 撞名那一台的**说明**（`note`）：两台服务器名归一化后同形时，工具表里那一批工具归不到具体哪一台。
 *
 * 为什么必须说出来而不是悄悄按某一台记账：`my-server` 与 `my_server` 在设置页里是两条合法配置
 * （名字正则允许 `-` 与 `_` 并存），而厂商工具表里它们是**同一个名字**——不说明的话，
 * 「未验证」会被当成「我们没配上」。
 */
function collisionNote(name: string, partners: ReadonlyMap<string, readonly string[]>): string | undefined {
  const sameForm = (partners.get(normalizeMcpName(name)) ?? []).filter((other) => other !== name);
  if (sameForm.length === 0) return undefined;
  const quoted = sameForm.map((other) => `「${other}」`).join('、');
  return `与${quoted}在厂商工具表里同形（厂商把名字里的 - 写成 _）：`
    + `mcp__${normalizeMcpName(name)}__ 那一批工具归不到这一台`;
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
 *
 * **撞名**（两台归一化后同形，如 `my-server` 与 `my_server`）在这一格只作 `note`：那一批工具
 * 归不到具体哪一台，故那几台的归一化回退**失效**（精确命中照旧），结论记 `unverified` 而**不是**
 * `unavailable`——证据不足不能让整行失败（见 `classify` 第 2 条）。
 */
export function deriveRowMcpServers(evidence: RowMcpEvidence): RowMcpServer[] {
  const rows: RowMcpServer[] = [];
  const seen = new Set<string>();
  const sourceOf = (name: string): string =>
    evidence.vendor?.servers?.find((item) => item.name === name)?.source ?? ROW_MCP_SOURCE_UNKNOWN;
  /**
   * 撞名表：把**所有会进这一格的名字**（我们注入的 + 厂商报的）按归一化形态归堆。名字集合取全量，
   * 因为「工具表里那一批归谁」这件事与「谁把它装进去的」无关（仓库自带一台同名服务时同样归不到）。
   *
   * ⚠️ 下面那次 `collidingMcpServerNames([...partners.values()].flat())` **不是多余的重复分组**，
   * 两件事各有理由：① 这里的**去重**是判定的前提——注入集与厂商报的常常是同一个名字，
   * 不去重就会被数成「两台同形」，于是每一台都白得一个撞名说明；② 撞名**谓词**只有
   * `collidingMcpServerNames` 一份，把那份桶扫描内联到这里就是第二份定义（两张口径迟早分家，
   * 而分家的表现是「说明说撞名、结论却按撞名处理」这种半套行为）。服务器数量是个位数，
   * 多走一遍不值得用一份重复的谓词去换。
   */
  const partners = new Map<string, string[]>();
  for (const name of [...evidence.injected, ...(evidence.vendor?.servers ?? []).map((item) => item.name)]) {
    if (name === null) continue;
    const key = normalizeMcpName(name);
    const bucket = partners.get(key) ?? [];
    // 同名去重：注入集与厂商报的常常是**同一个名字**，那不是撞名（撞名要的是两台名字同形）
    if (!bucket.includes(name)) bucket.push(name);
    partners.set(key, bucket);
  }
  const colliding = collidingMcpServerNames([...partners.values()].flat());
  /** 一台的行内容：结论 + 撞名时的说明（没撞名就不写这一格，老 `run.json` 与本格逐字同形） */
  const rowOf = (name: string, source: string): RowMcpServer => {
    const note = colliding.has(name) ? collisionNote(name, partners) : undefined;
    return { name, source, ...classify(name, evidence, colliding.has(name)), ...(note === undefined ? {} : { note }) };
  };

  for (const name of evidence.injected) {
    seen.add(name);
    rows.push(rowOf(name, sourceOf(name)));
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
    rows.push(rowOf(entry.name, entry.source ?? ROW_MCP_SOURCE_UNKNOWN));
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
