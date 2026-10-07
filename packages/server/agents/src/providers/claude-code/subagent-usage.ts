/**
 * claude-code 的**子智能体用量**读取（spec 2026-10-04 §2.3）。
 *
 * 为什么读盘而不是用流里的侧链消息（第一版设计就是那么写的，被实测推翻）：
 * `forwardSubagentText: true` 确实把子智能体的消息转发过来、原始载荷也带 `message.usage`，
 * 但**这个网关下流式快照的 `output_tokens` 恒为 0**（实测主会话 11 条 + 子智能体 4 条全是 0，
 * 主会话的真值只出现在 `result.usage` 上）⇒ 照快照求和会得到「子智能体输出 0 token」这种
 * **静默的假数**，比不显示更糟。
 *
 * 权威源是 CLI 自己写的那份文件（真机实测存在）：
 *   `<CLAUDE_CONFIG_DIR>/projects/<项目目录>/<session_id>/subagents/agent-<agentId>.jsonl`
 *
 * ⚠️ **文件名里是 `agentId`，不是事件流那个 id**（2026-10-05 真机缺陷，产物 `11a5feb5…/0d881bdc…`）：
 * 事件流的 `task_*` 里除了真派发的子智能体（wire id 与 `agentId` 同值，**三个**真机产物实测：
 * `afb636cf844060a29` / `ae63ead9521ee0d28` / `a870138076fead44b`），还混着
 * CLI 给**非 Agent 任务**发的条目——那一条的 `parentToolUseId` 是**子智能体自己那条 Bash 调用**的
 * tool_use id，它 wire 上的「名字」就是那条命令的 `description`（真机：`Check latest Vue version on npm`），
 * 而盘上**永远没有它的转录**。照「每个事件流 id 都要有一份同名文件」判 ⇒ 一个读得到的子智能体被那个
 * 幻影条目拖成「读失败」，卡片两格全空还挂着点名 WARN，可转录就在盘上。
 * ⇒ **聚合读数改成「枚举会话目录」**（会话目录是 per-session 的：同一行不会有别的会话的转录，
 * 详见 `findSubagentsDir`），事件流的 id 只用于**事实核对**（一个转录都没有、可事件流说派过 ⇒ 事实缺失）。
 * ⚠️ **那把核对尺子随后被 R19 收窄过**（2026-10-05）：传进来的 id 必须已经过**形状判据**
 * （`subagent_type` / `spawn_depth` / `prompt` 至少一格 **非 null**），幻影条目不再进名单——见下面
 * `readClaudeSubagentUsage` 的规则③⑦与 `subagentIds` 的注记（登记点在 `index.ts`，判据在 `message.ts`）。
 *
 * 两个读者、两条落点，**读数规则只有同一条**（`readOne`）：
 *   · `readClaudeSubagentUsage`：**全部**子智能体加起来 ⇒ 进结果与行快照（`subagentTokens`）；
 *   · `readClaudeSubagentFile`：**单个**子智能体 ⇒ 进 `SubagentRecord.usage`，也就是抽屉里
 *     子任务条上那一格「用量」（2026-10-04 用户报的缺陷：那一格此前恒「未采集」，
 *     因为 `message.ts` 的 `subagentRecord` 只能把 `task_notification.usage` 记成 `null`——
 *     那个载荷是另一种形状）。
 * 各写一份的症状是「同一份文件在两处算出两个数」，而两处各自看起来都正常。
 *
 * 读数规则两条，缺一条就错：
 *   ① **按 `message.id` 去重、后到覆盖**：同一个 API 往返按内容块出现多次（thinking 一条、
 *      tool_use/text 一条），第一条的 `output_tokens` 是 0 ⇒ 逐条相加会把 input/cached 双计
 *      （实测：29,296 / 27,392 vs 正确的 14,648 / 13,696）；
 *   ② **`turns` = 去重后的 `message.id` 个数**（一次 API 往返 = 一轮，与主循环同口径）。
 *
 * ⚠️ **文件是 CLI 边跑边追加的** ⇒ 收尾那一次读到的是「已经落盘的全部」（真机实测：子智能体收场那一刻
 * 读到 output 89，几秒后收尾再读是 305）。**跑动期不读盘**（2026-10-06 用户裁定：只展示最终用量）：
 * 每个子智能体一次运行只在收尾读一次（`index.ts` 的 `finalize`）。
 *
 * 读不全（嵌套子智能体落在别处、CLI 换布局）⇒ **整格 null 并点名**（spec §2.2 的「全量或 null」）：
 * 部分和会被读成总数，而界面上它与全量合计长得一模一样。
 *
 * **「读不出来」还包含「文件在、但读不出可用记录」**（2026-10-04 评审补，见 `readOne` 的注释）：
 * 空文件、或认得是 `assistant` 却读不出完整三项，与「文件不在」**同一档** ⇒ `null` + 点名 WARN。
 * 取消 / 失败的运行正好落在这一档（收尾在释放之前跑）：那时说 `{0,0,0}` 等于替一个读不出来的数
 * 断言「确实没花」，而它与「没采到」在界面上是两句不同的话。
 *
 * ⚠️ **读法是同步分块**（2026-10-05；实现自 2026-10-06 起在共用的 `../../read-lines`）：
 *   · `readLines` 逐块读（**64 KB 一块**）⇒ 峰值内存从「整份字符串 + `split('\n')` 数组」降到
 *     「**一块 + 当前行**」。**两个读者因此仍是同步的**——这是硬约束：`turn.ts` 的 `project` 与
 *     `finalize` 都是**同步钩子**，把异步引进来要改骨架签名并波及另两家，代价远大于收益；
 *   · 跨块的**行**与跨块的**多字节字符**都在那一层解决（切分点只落在换行字节上），
 *     claude 这边只管解析规则；
 *   · 七条规则逐字未动（尤其「三项读不全 ⇒ 整份作废」——它是「整份作废」，不是「提前收工」）；
 *   · 给「路径 + size + mtimeMs」加一个 **run 作用域**的缓存（`createClaudeSubagentUsageCache`，**显式传入**）：
 *     收尾那一次会被读两遍（`readClaudeSubagentUsage` 的合计读 + `finalSubagents` 的逐个子智能体重读），
 *     两遍读的是同一批文件 ⇒ 同一版本只解析一遍；**文件长长了**（CLI 边跑边追加）时条目不命中，照常重读。
 *     同一个缓存还捎带一格**已解析的会话目录**（`ClaudeSubagentUsageCache.dirs`）⇒ 收尾逐个子智能体
 *     重读那一圈不再反复枚举项目目录。
 *   · **IO 失败不进缓存**（2026-10-05 审查 Important B）：缓存里那个 `null` 只表示「**这个版本的这部分内容**
 *     读不出可用记录」，`statSync` / `openSync` / `readSync` 抛出来的失败**原样抛给 `readOne` 的 catch**，
 *     不写任何条目——见 `ClaudeSubagentUsageCache` 与 `readOne` 的注释。
 */
import { readdirSync, statSync, type Stats } from 'node:fs';
import { join } from 'node:path';
import type { UsageTokens } from '@aieval/contracts';
import { asRecord, readNumber, readString } from '../../json';
import { readLines } from '../../read-lines';
import { sumUsageTokens } from '../../usage';

export interface ClaudeSubagentUsageRead {
  /** 子智能体那一份；`null` = 有子智能体但读不全 */
  usage: UsageTokens | null;
  turns: number | null;
  /**
   * 读不到的子智能体 id（调用方据此落点名 WARN），**按失败的那一档给不同的 id**：
   *   · 转录文件读不动（规则②）⇒ 给**那个文件的 agentId**（它与事件流的 id 是两套命名）；
   *   · 名单里那个 id 在目录里**没有文件**（规则⑦，含「一个转录都没有」那一档）⇒ 给**名单里那个 id**
   *     （这一档里它是唯一能点名的东西）。
   */
  missing: string[];
  /**
   * **只见到收场帧**（`'unjudged'`，无法判定它是不是子智能体）而**盘上没有它的转录**的那些 id
   * （2026-10-05 复核裁定，规则⑤）。⚠️ **它不影响两格**：`usage` / `turns` 照算（一条无法判定的条目
   * **不许**把一个真子智能体的读数拖成 `null`——那正是用户报的那句话的形状），调用方据此落一条
   * **不说它是子智能体**的 WARN（可能少算，但既不编数、也不静默）。
   */
  unjudged: string[];
}

/** 单个子智能体的读数（`readClaudeSubagentFile` 的命中形状） */
export interface ClaudeSubagentFileUsage {
  usage: UsageTokens;
  turns: number;
}

/**
 * 一次运行里「**同一版本的文件只解析一遍**」的缓存（spec §2.2 第 3 条，2026-10-05）。
 *
 * **run 作用域、显式传入**（不是模块级全局）：模块级缓存会把上一次运行解析出来的读数留在进程里
 * （长跑的服务端会一直涨），而它的收益只在一次运行之内。
 * 用法：适配器一次运行 `createClaudeSubagentUsageCache()` 建一个，**两个读者共用**它
 * （收场帧按单个读、收尾按合计读的是同一份文件 ⇒ 第二次直接命中）。
 *
 * ## 键与边界
 * 键 = `(路径, size, mtimeMs)`。两个边界刻意写在键里：
 *   · **size**：文件**长长了**就重读（真机形状：收尾比收场读到的多）。只认 `mtimeMs` 会在某些文件系统
 *     （时间戳粒度粗 / 同毫秒内追加）上漏判，只认 `size` 则漏判「重写同样长度」（`mtimeMs` 一起进键就没这问题）；
 *   · **路径**：同一目录下多个子智能体互不串味（`readAt` 拼的是绝对路径）。
 * ⚠️ **命中缓存的前提是「盘上那份没变」**：版本号是**读之前**取的（`statSync`），缓存里存的也是同一格
 * ——所以「读的过程中文件被追加」时，缓存里那份是「读到的那一刻的内容」，下一次读时 size 已变、
 * 条目不命中，照常重读（`readOne` 的注释有完整推导）。
 * ⚠️ 这个键拦不住「文件被换成**同尺寸同 mtime** 的另一份」（内容变了、两格逐字相同）——
 * 真机不可达：CLI 只**追加**，从不原地改写。如实登记，别把它读成「内容哈希」。
 *
 * ⚠️ 值是 `ClaudeSubagentFileUsage | null`，但**只有一种 `null` 进得来**：由**文件内容**决定的那一档
 * （空文件 / 三项读不全 / 拿不到去重键 ⇒ 「这个版本读不出可用记录」是**结论**，版本没变就还是它）。
 * **IO 失败不进缓存**（2026-10-05 审查 Important B）：`statSync` / `openSync` / `readSync` 抛出来的
 * 失败由**时刻**决定，不由内容决定——写进去的话，对一份已经写完（size / mtimeMs 不再变）的转录，
 * 收尾那次「必须真读」会直接复用这次失败（整格 `null` + 点名 WARN），而重试本来很可能读得到
 * （spec §2.2 第 3 条：收尾必须真读）。⇒ 本缓存的不变式收窄成
 * 「**同一版本 + 内容决定的结论** ⇒ 同一结论」。
 */
export interface ClaudeSubagentUsageCache {
  entries: Map<string, { size: number; mtimeMs: number; parsed: ClaudeSubagentFileUsage | null }>;
  /**
   * 已解析过的**会话目录**：键 = `configHome + '\u0000' + sessionId`，值 = `findSubagentsDir` 的结果。
   *
   * 为什么需要它（2026-10-05 审查 M-1，用户点名的「不要多次重复读取」）：收尾那个逐会话循环里
   * **每个**子会话都调一次 `readClaudeSubagentFile`，而它每次都从 `<configHome>/projects` 重新枚举一遍
   * 项目目录、再逐个项目 `readdirSync` 试一次 ⇒ O(子会话数 × 项目目录数) 次目录遍历，而这两个输入
   * （`configHome` / `sessionId`）在一行里是**固定的**：目录解析结果整行复用即可。
   *
   * ⚠️ **只缓存「找到了」的结果**：`null`（此刻还没有那个目录）不缓存——同一行里第一条子智能体的
   * 转录落盘之前，`<session>/subagents/` 本来就可能还不存在，把那个「还没到」固化成「读不到」
   * 是**静默的缺**（与 `readOne` 里「IO 失败不进缓存」同一条道理：时刻决定的结论不许当内容结论存）。
   */
  dirs: Map<string, string>;
}

/** 建一个 **run 作用域**的解析缓存（见 `ClaudeSubagentUsageCache` 的注释；每行一个，两次读取共用） */
export function createClaudeSubagentUsageCache(): ClaudeSubagentUsageCache {
  return { entries: new Map(), dirs: new Map() };
}

/**
 * **本行全部子智能体**的用量与轮次：`{usage, turns, missing, unjudged}`（spec §2.2 的「全量或 null」）。
 *
 * 七条规则，缺一条就会出「看起来正常」的错数。
 * ⚠️ **编号与 spec §3 #19 的 ⑤⑥⑦ 逐条对齐**（2026-10-05 复核 Item 1 的订正）：两处的同一个数必须是同一件事，
 * 否则「规则⑦」这类交叉引用会指到另一条规则上（原文里本文件的 ⑤ 与 #19 的 ⑤ 就是两条不同的规则）。
 *   ① **枚举会话目录**里的 `agent-*.jsonl`（不再拿事件流的 id 拼文件名，见文件头那条教训）；
 *   ② 有**任何一个转录读不动** ⇒ 整格 `null` + 点名那个文件（读到的那些**不进合计**，部分和会冒充总数）；
 *   ③ 一个转录都没有：名单里也**没有形状像派发**的 id ⇒ `{0,0,0}` 与 0（**确实没有**；
 *      R19 之后幻影条目落在这里——它进不了名单）；名单里**有** ⇒ 整格 `null` + 点名那些 id
 *      （事实缺失——绝不写成 `{0,0,0}`）；
 *   ④ **有任何一个进 `missing` ⇒ 两格一起 `null`**（`usage` 与 `turns` 同生共死，读到的那些**不进合计**）：
 *      这就是「全量或 null」在本函数里的落点——部分和会被读成总数，而界面上它与全量合计长得一模一样；
 *   ⑤ **`'unjudged'` 的条目另外记一笔，但不参与①②③④⑥⑦的判决**（2026-10-05 复核裁定；= #19 ⑤）：
 *      只见到收场帧的 id（无法判定是不是子智能体）而盘上没有它的转录 ⇒ 进 `unjudged`，
 *      **两格照算**（不许因为一条判不了的条目把真子智能体的读数拖成 `null`），调用方落一条
 *      「可能少算它（无法判定它是不是子智能体）」的 WARN。⚠️ 反向也不许：**不能**要求它必须有转录
 *      （那是把一条判不了的条目当成「没采到」，会让一条幻影把卡片第二行整行拿走——正是用户报的症状）；
 *   ⑥ **读取集 = 目录里的转录 ∪ `subagentIds`**（= #19 ⑥）：盘上有就必须读（哪怕它的 id 没进过名单——
 *      转录是更硬的事实：`task_started` 没被投送时，盘上那一份就是唯一事实），名单里有就必须读得动（⑦）；
 *   ⑦ **名单里每一个形状合格的派发都必须有一份读得动的转录**（= #19 ⑦，2026-10-05 R19 的裁定）：
 *      目录里没有它的文件 ⇒ 与「读不动」**同一档**（整格 `null` + 点名**那个 id**）。
 *      ⚠️ 这一条正是 R1 那个**已知价码**的关闭口：在此之前，一个真派发的转录缺失、而另一个转录在盘上时，
 *      这里会把**读到的那些**当合计交出去——一个**部分和**。
 */
export function readClaudeSubagentUsage(input: {
  configHome: string;
  /** `system/init` 回显的 session id；采不到为 null（那时**不猜目录**，见 `findSubagentsDir`） */
  sessionId: string | null;
  /**
   * **形状像一次派发**的子智能体 id（不是「事件流报过的全部 `task_id`」，见下）。⚠️ 这些是 **wire id，
   * 不是文件名**（2026-10-05 教训）：真派发的那个与 `agentId` 同值，而 CLI 的非 Agent task 条目
   * （如某条带 `description` 的 Bash）永远不会出现在文件名里。它们服务**规则③的事实核对**与**规则⑦的
   * 缺失核对**两处。
   *
   * ⚠️ **这份名单必须已经过形状判据**（R19，2026-10-05 收窄）：登记点在 `index.ts` 的 `project`，
   * 判据在 `message.ts` 的 `ClaudeTaskShape`（`subagent_type` / `spawn_depth` / `prompt` 至少一格 **非 null**）。
   * 把幻影条目（CLI 的非 Agent 任务）也传进来，规则⑦ 就会为它喊一句**把 Bash 叫成子智能体**的 WARN
   * ——那正是 R19 关掉的那句话。**本函数不判形状**：它拿不到 wire 帧，只有 id（别在这里造第二个谓词）。
   */
  subagentIds: readonly string[];
  /**
   * **只见到收场帧**的 task id（`'unjudged'`：收场帧不承载形状证据，未知 ≠ 缺失）——它与
   * `subagentIds` 是**两份名单、两种处置**（规则⑤）：这里的不要求有转录、也不会让两格变 `null`，
   * 只在**盘上没有它的转录**时进 `unjudged` ⇒ 调用方落一条「可能少算」的 WARN。
   * 缺省即空（老调用方/老用例不必感知这一格）。
   */
  unjudgedIds?: readonly string[];
  /**
   * **run 作用域**的解析缓存（`createClaudeSubagentUsageCache()`；缺省 = 不缓存，每次都真读）。
   * 与 `readClaudeSubagentFile` 传**同一个**对象时，两个入口共用一次解析（见 `ClaudeSubagentUsageCache`）。
   */
  cache?: ClaudeSubagentUsageCache;
}): ClaudeSubagentUsageRead {
  const unjudgedIds = input.unjudgedIds ?? [];
  const dir = resolveSubagentsDir(input.configHome, input.sessionId, input.cache);
  // 「没有目录」与「目录里没有转录」走**同一个出口**：事件流没报过 ⇒ {0,0,0}，报过 ⇒ null + 点名
  // （所以「采不到 session_id ⇒ 不猜目录」**不等于**「一律 null」——它仍受规则③分流）
  if (dir === null) return readNothing(input.subagentIds, unjudgedIds);
  const files = listSubagentFiles(dir);
  if (files.length === 0) return readNothing(input.subagentIds, unjudgedIds);
  const parts: UsageTokens[] = [];
  const missing: string[] = [];
  let turns = 0;
  // 规则⑥的左半边：**目录里枚举出来的都读**，不管它的 id 在不在名单里（并集规则）
  for (const agentId of files) {
    const read = readAt(dir, agentId, input.cache);
    // 规则②：读不动的那个**不进合计**（也**不进轮次**），整格作废
    if (read === null) {
      missing.push(agentId);
      continue;
    }
    parts.push(read.usage);
    turns += read.turns;
  }
  // 规则⑦：名单里的每一个都**必须**有一份读得动的转录——目录里没有它（读不动的上面已收）
  // 没有这一条，下面那一行走的就是「把读到的那些当合计」= 部分和冒充总数（R1 的价码）
  const present = new Set(files);
  for (const id of input.subagentIds) {
    if (!present.has(id)) missing.push(id);
  }
  // 规则⑤：**判不了的条目另记一笔，且只在这里记**——它既不进 `missing`（那会让两格变 null，
  // 把一条幻影的代价转嫁给真子智能体），也不要求有转录（判不了 ≠ 没采到）
  const unjudged = unjudgedIds.filter((id) => !present.has(id));
  // 规则④：有点名的就整格 null（读到的那些**不进合计**，否则部分和会冒充总数）
  if (missing.length > 0) {
    return { usage: null, turns: null, missing: [...new Set(missing)], unjudged: [...new Set(unjudged)] };
  }
  return { usage: sumUsageTokens(parts), turns, missing: [], unjudged: [...new Set(unjudged)] };
}

/**
 * **一个转录都没读到**时的出口（规则③）：两处入口共用——**会话目录不存在**（含「采不到 `session_id`
 * ⇒ 压根没去找」，见 `findSubagentsDir`）、或**目录里一个 `agent-*.jsonl` 都没有**。
 *
 * ⚠️ **「确实没有」有前提，别把它读成对事实的证明**：它只在「本行**形状像一次派发**的 `task_*`
 * 真的一条都没出现过」这条判据下成立——`subagentIds` **全部**来自那条判据（`index.ts` 的 `project`，
 * 判据在 `message.ts` 的 `ClaudeTaskShape`）。CLI 换形状 / 不再投送 `task_started` 时，这里的意思是
 * 「**本次没观察到**」，而不是「这一行确实没有子智能体」；要下后一个结论，得先确认事件流真的没给。
 * 与 codex 为同一格写下的告诫逐字同源（`providers/codex/transcript.ts` 的 `childUsageOf`）。
 *
 * 反过来，名单里**形状像派发**的子智能体而盘上一份转录都没有 ⇒ 事实缺失：`null` + 点名那些 id
 * （绝不写成 `{0,0,0}`——那是「它一分钱没花」，而这里我们**没有依据**这么说）。
 * ⚠️ 名单里**只有**形状像派发的那一些（R19 收窄，见 `subagentIds` 的注记）：CLI 的非 Agent task
 * 条目（真机那条带 `description` 的 Bash）**不进名单**，于是这里不再为它喊一句错的 WARN
 * ——那一行的正解是 `{0,0,0}`（「确实没有子智能体」那一支）。
 * ⚠️ 这条出口上**照样**要带规则⑤的 `unjudged`（这一档里一个转录都没有 ⇒ 判不了的那些**都**没有转录）：
 * 少了它，「只见到收场帧」的行就完全静默——而静默的少算正是本仓最不接受的那一类。
 */
function readNothing(subagentIds: readonly string[], unjudgedIds: readonly string[]): ClaudeSubagentUsageRead {
  const unjudged = [...new Set(unjudgedIds)];
  if (subagentIds.length === 0) return { usage: sumUsageTokens([]), turns: 0, missing: [], unjudged };
  return { usage: null, turns: null, missing: [...subagentIds], unjudged };
}

/**
 * 会话目录里的转录文件：`agent-<agentId>.jsonl` 的 `agentId`（**按名字排序** ⇒ `missing` 的顺序确定，
 * 点名 WARN 的文案不会因文件系统的枚举顺序而变）。
 *
 * `agent-*.meta.json` 不是转录（`.jsonl` 这一条把它挡住了）：它是 CLI 写的派发元数据
 * （`agentType` / `toolUseId` / `spawnDepth`），没有 `message.id`，读它只会白白走一趟「读不出可用记录」。
 */
function listSubagentFiles(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.startsWith('agent-') && name.endsWith('.jsonl'))
    .sort()
    .map((name) => name.slice('agent-'.length, -'.jsonl'.length));
}

/**
 * **单个**子智能体自己的用量：`<configHome>/projects/<项目>/<sessionId>/subagents/agent-<agentId>.jsonl`
 * 里那份读数（**只在读全时命中**，见 `readOne` 的三种读不出）。
 *
 * 为什么它与 `readClaudeSubagentUsage` 分开、却共用同一条读数规则（2026-10-04 用户报的缺陷）：
 * 上面那个回答的是「**这一次运行的全部子智能体**加起来的全量或 null」（进行快照），
 * 而这一个回答的是「**这一个**子智能体花了多少」（进 `SubagentRecord.usage` ⇒ 抽屉里子任务条上那一格）。
 * 两个读者、两条落点，但读数规则只有一条：`readOne`。各写一份的症状正是本仓最不接受的那一类
 * ——**同一份文件在两处算出两个数**，而两处各自看起来都正常。
 *
 * ⚠️ **它仍然按 id 找单个文件（与上面那个的「枚举目录」不同），而且这个 id 是对的**（2026-10-05 复核）：
 * 传进来的 `taskId` 是**真派发那条 wire id**，真机三个 claude 产物实测它**与文件名里的 `agentId` 同值**
 * （`afb636cf844060a29` / `ae63ead9521ee0d28` / `a870138076fead44b`），三处旁证互证同一件事：
 * ① 文件名；② 转录里每条记录的 `agentId`；③ 主会话那条 `tool_result` 的 `toolUseResult.agentId`，
 * 而它的 `tool_use_id` 正是 wire 的 `parentToolUseId`、也等于同目录 `<id>.meta.json` 的 `toolUseId`。
 * ⇒ 这一格**不需要**（也不该）改成枚举：它回答的是「这一个」，而抽屉里每一个子任务条都有一个 wire id。
 * 幻影条目（CLI 的非 Agent task）在这里查到 `null`——那是**对的**，它本来就没有转录。
 * ⚠️ 2026-10-05（R19）起它**压根走不到这里**：面板那一层已经用形状判据把幻影挡在外面，
 * 不会再有子任务行来为它查这一格（`message.ts` 的 `ClaudeTaskShape`）；这一句保留作语义说明。
 */
export function readClaudeSubagentFile(input: {
  configHome: string;
  sessionId: string | null;
  taskId: string;
  /** 与 `readClaudeSubagentUsage` 传**同一个**对象时共用一次解析（见 `ClaudeSubagentUsageCache`） */
  cache?: ClaudeSubagentUsageCache;
}): ClaudeSubagentFileUsage | null {
  const dir = resolveSubagentsDir(input.configHome, input.sessionId, input.cache);
  return dir === null ? null : readAt(dir, input.taskId, input.cache);
}

/**
 * 在一个已经定位好的 `subagents/` 目录里读一个子智能体（两个入口共用，见上）；`agentId` = 文件名里那一段。
 *
 * ⚠️ **它是两个入口的唯一交汇点**：读数规则只有 `readOne` 一条，缓存也只有一处（`readOne` 里的那次查表）
 * ——所以「收场帧按单个读、收尾按合计读」两次调用**共用同一份解析结果**（同一版本时）。
 */
function readAt(dir: string, agentId: string, cache?: ClaudeSubagentUsageCache): ClaudeSubagentFileUsage | null {
  return readOne(join(dir, `agent-${agentId}.jsonl`), cache);
}

/**
 * 同一份文件里按 `message.id` 去重后的用量与往返数；**读不出可用记录返回 `null`**。
 *
 * 三种「读不出」合流到**同一条路**（调用方把它们一起记进 `missing` ⇒ 整格 `null` + 点名 WARN），
 * 因为它们在界面上是同一句话：**这个子智能体花了多少，我们读不出来**（事实缺失），
 * 而不是「它一分钱没花」——`{0,0,0}` 断言的是后者，那是我们**没有依据**去下的结论：
 *   · 文件不在 / 读不动（IO）；
 *   · **文件在，但一条可识别的用量记录都没有**（空文件：CLI 还没写、或被中断在半截）——
 *     被取消 / 失败的运行正好落在这里（收尾在释放之前跑，见 `turn.ts` 的收尾投影）；
 *   · **认得是 `assistant`，却读不出可用记录**：三项（`input` / `cached` / `output`）读不全，
 *     或拿不到去重键（`message.id`）——两种形状**都不许 `continue`**：跳过会让那一次往返从
 *     **合计与轮次里一起消失**，而外面看到的仍是一次「成功」的读数。
 *     与另两家同一口径：dsh「子会话已收场却一条用量都没报」⇒ `null`（Task 4）、
 *     codex「子线程的累计用量读不出」⇒ 分量 `null`（Task 5）。
 *
 * ⚠️ **怎么读**（2026-10-05；实现自 2026-10-06 起在共用的 `../../read-lines`）：分块（64 KB）读、
 * 只在换行字节处切分 ⇒ 峰值内存是「**一块 + 当前行**」，不是「整份文本 + `split('\n')` 数组」
 * （改前 `readFileSync` + `split` 是 2–3× 文件大小，而这份文件会随子智能体跑动一直长）。
 * ⚠️ **同步**是刻意的：`turn.ts` 的 `project` / `finalize` 都是同步钩子（见文件头），
 * 这一层把异步引进来要改骨架并波及另两家。
 * ⚠️ 半截行仍然只是跳过（`JSON.parse` 抛 ⇒ 看下一行）：CLI 边跑边写，半截行是常态，
 * 而它**不冒充**任何一次往返；「认得是 assistant 却读不全」才是**整份作废**。
 */
function readOne(file: string, cache?: ClaudeSubagentUsageCache): ClaudeSubagentFileUsage | null {
  // 版本号先取：`statSync` 抛（文件不在 / 读不动）⇒ 与「读不出可用记录」同一档（`null`），且**不缓存**
  // ——版本号都取不到，没有一个能当键的东西；而且那个失败由**时刻**决定（见 `ClaudeSubagentUsageCache`）
  let stats: Stats;
  try {
    stats = statSync(file);
  } catch {
    return null;
  }
  // 缓存命中：**路径 + size + mtimeMs** 三格全同 ⇒ 复用（`parsed === null` 也是有效命中：
  // 「这个版本读不出可用记录」是结论，不是缺失，见 `ClaudeSubagentUsageCache`）
  const hit = cache?.entries.get(file);
  if (hit !== undefined && hit.size === stats.size && hit.mtimeMs === stats.mtimeMs) return hit.parsed;
  let read: ClaudeSubagentFileUsage | null;
  try {
    read = streamUsage(file);
  } catch {
    /**
     * 打不开 / 读不动（文件被删 / 权限 / 磁盘错）⇒ 与「读不出可用记录」**同一档**（调用方走 `missing` + 点名），
     * 但**绝不写进缓存**（2026-10-05 审查 Important B）。
     *
     * 为什么这条边界必须在这里画：写进去的话，对一份**已经写完**（size / mtimeMs 不再变）的转录，
     * 收尾那次「必须真读」会直接命中这条失败 ⇒ 行级分量整格 `null` + 点名 WARN，而**下一次读本来
     * 很可能读得到**（瞬时占用 / 权限刚放开 / 磁盘抖动）。缓存的不变式因此是
     * 「**同一版本 + 内容决定的结论** ⇒ 同一结论」——IO 失败由时刻决定，不是这个版本的结论。
     * ⚠️ 同一个 `catch` 也接住 `consume` 里任何意外异常（编程错）：那一档同样**只是这一次**读不出，
     * 下一读照常真读（把一次编程错固化成「这份文件永远读不出来」比让它每次响亮地失败坏得多）。
     */
    return null;
  }
  // 缓存写的是**这一次读到的内容**，版本号用**读之前**取的那一格（与上面查表用的是同一个判据）。
  // ⚠️ 刻意**不**在读完后再 `stat` 一次去复核版本：那个窗口里唯一可能发生的是「读的过程中文件被追加」
  // （CLI 边跑边追加），而我们的读本来就停在当时的 EOF ⇒ 缓存里存的就是「读到的那一刻的内容」，
  // 下一次读时 size 已经变了、条目不命中，照常重读。多一次 `stat` 既不改结论、也无从构造用例
  // （2026-10-05 实测：那条「同尺寸改写」的靶子在 size+mtime 这个键上**没有区分力**），
  // 所以不留一个我举不出反例的「复核」。真的换了文件（size 与 mtime 都逐字相同）这个键本就拦不住，
  // 而那一档在真机上不可达：CLI 只**追加**，从不原地改写。
  cache?.entries.set(file, { size: stats.size, mtimeMs: stats.mtimeMs, parsed: read });
  return read;
}

/**
 * 真的把一份转录**逐行**读出来（`readOne` 的唯一取数路径，也是「读数规则只有一条」的落点）。
 *
 * 逐行那一层（含跨块拼行与跨块多字节字符）在共用的 `../../read-lines` 里（2026-10-06 从本文件
 * 搬出去，codex 也用同一份），本函数只管**解析规则**。
 *
 * 两条与改前逐字对齐的语义：
 *   · **半截行跳过**（`JSON.parse` 抛 ⇒ 看下一行）：CLI 边跑边写，半截行是常态，而它不冒充任何往返；
 *   · **认得是 `assistant` 却读不全 ⇒ 整份作废**（返回 `null`）：跳过会让那一次往返从合计与轮次里
 *     一起消失，而外面看到的仍是一次「成功」的读数。用 `failed` 标记 + 让回调返回 `true` 收工
 *     而不是就地 `return null`：语义是「作废」（看清了这一段就够），提前收工只是顺带省掉剩下的 IO。
 *
 * ⚠️ **不吞异常**（2026-10-05 审查 Important B）：读盘失败由 `readOne` 的 `catch` 记账（那条路径
 * **不写缓存**）。吞在这里就等于把「这一次 IO 失败」和「这个版本读不出可用记录」混成同一个结果——
 * 而前者会被缓存固化（见 `ClaudeSubagentUsageCache`）。
 */
function streamUsage(file: string): ClaudeSubagentFileUsage | null {
  /** `message.id` → 那一次往返的用量（**后到覆盖**：同一条消息会按内容块多次到达；插入顺序 = 首次出现） */
  const byMessageId = new Map<string, UsageTokens>();
  /** 认得是 `assistant` 却读不出可用记录 ⇒ 整份作废（`true` 之后不再消费任何行） */
  let failed = false;
  readLines(file, (line) => {
    // 已经判定作废：剩下的内容不用再读（`readLines` 收到 `true` 就收工）
    if (failed) return true;
    if (line.trim() === '') return false;
    let record: Record<string, unknown> | null;
    try {
      record = asRecord(JSON.parse(line));
    } catch {
      // 半截行是常态（CLI 边跑边写）：跳过，不让它作废整份文件
      return false;
    }
    if (readString(record, 'type') !== 'assistant') return false;
    const message = asRecord(record?.message);
    const messageId = readString(message, 'id');
    // 认得是 assistant 却拿不到去重键 ⇒ 与「三项读不全」**同一档**：整份作废（走 missing）。
    // 跳过它同样是从合计与轮次里静默抹掉一次往返——归不到任何一次往返上的记录，是事实缺失
    if (messageId === null) {
      failed = true;
      return true;
    }
    const usage = readTrio(asRecord(message?.usage));
    // 认得是 assistant 却读不出三项 ⇒ **整份作废**（走 missing），不跳过：跳过是静默丢一次往返
    if (usage === null) {
      failed = true;
      return true;
    }
    byMessageId.set(messageId, usage);
    return false;
  });
  if (failed) return null;
  // 一条可用记录都没有 ⇒ 事实缺失（空文件不是「确实没花」），与「文件读不到」同一档
  if (byMessageId.size === 0) return null;
  return { usage: sumUsageTokens([...byMessageId.values()]), turns: byMessageId.size };
}

/** 三项齐了才认（缺项即整格不认，绝不填 0——与适配器主路径同一条硬口径） */
function readTrio(usage: Record<string, unknown> | null): UsageTokens | null {
  const input = readNumber(usage, 'input_tokens');
  const cached = readNumber(usage, 'cache_read_input_tokens');
  const output = readNumber(usage, 'output_tokens');
  if (input === null || cached === null || output === null) return null;
  return { input, cached, output, reasoningOutput: null, total: null };
}

/**
 * 找 `<configHome>/projects/<项目目录>/<sessionId>/subagents`。
 * 会话 id 已知就按它匹配（项目目录名是 CLI 自己按 cwd 拼的，**我们不重算那条规则**——
 * 算错会静默读到空目录，而按 id 匹配是「事实」）。
 *
 * ⚠️ **采不到 session id 时不再猜目录**（2026-10-05，随「按目录枚举」一起来的收紧）。
 * 旧写法会扫 `<projects>/<项目>/<会话>/subagents/` 取第一个读得动的目录，理由是「那时判据是按 id
 * 找文件，猜错目录多半只是找不到文件 ⇒ 点名 WARN」。**改成枚举之后这条理由不成立了**：猜错目录
 * 会把**别的会话**（同一个 `configHome` 下的另一次尝试 / 评分那一次）的转录整份算到这一行上——
 * 一个看起来完全正常的错数，比「没采到」坏得多。⇒ 返回 `null`，上层走 `readNothing`：
 * **事件流报过**子智能体 ⇒ `null` + 点名 WARN；**没报过** ⇒ `{0,0,0}`（「没有目录」不等于「一律 null」）。
 * ⚠️ 两个读者共用本函数 ⇒ 抽屉那一格（`readClaudeSubagentFile`）在同一个分支上也从「猜」变成 `null`。
 */
function findSubagentsDir(configHome: string, sessionId: string | null): string | null {
  // 会话 id 未知 ⇒ 没有「这一行的会话目录」这个东西可言（不猜）
  if (sessionId === null) return null;
  const projects = join(configHome, 'projects');
  let projectDirs: string[];
  try {
    projectDirs = readdirSync(projects);
  } catch {
    return null;
  }
  for (const project of projectDirs) {
    const candidate = join(projects, project, sessionId, 'subagents');
    try {
      // 判据是「这个目录读得动」——`readdirSync` 不抛就成立（原来写成 `.length >= 0` 是恒真式）
      readdirSync(candidate);
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * 解析会话目录，`cache` 给定时**整行只枚举一次**（2026-10-05 审查 M-1）。
 *
 * 为什么需要这一层：收尾那个逐会话循环里每个子会话都调一次 `readClaudeSubagentFile`，而它每次都从
 * `<configHome>/projects` 重新枚举项目目录、再逐个项目 `readdirSync` 试一次
 * ⇒ O(子会话数 × 项目目录数) 次目录遍历（用户点名的「不要多次重复读取」）。一行里 `configHome` 与
 * `sessionId` 都是固定的 ⇒ 解析结果整行复用；缓存命中时连 `<projects>` 都不再打开。
 *
 * ⚠️ **只记「找到了」的结果**：`null` 不缓存——目录可能在第一条子智能体落盘时**才出现**，
 * 把它固化成「读不到」是静默的缺（与 `ClaudeSubagentUsageCache` 的注释同一条道理）。
 */
function resolveSubagentsDir(
  configHome: string,
  sessionId: string | null,
  cache?: ClaudeSubagentUsageCache,
): string | null {
  // 会话 id 未知 ⇒ 没有「这一行的会话目录」可言（不猜），也就没有可缓存的键
  if (sessionId === null) return null;
  const key = `${configHome}\u0000${sessionId}`;
  const hit = cache?.dirs.get(key);
  if (hit !== undefined) return hit;
  const dir = findSubagentsDir(configHome, sessionId);
  if (dir !== null) cache?.dirs.set(key, dir);
  return dir;
}
