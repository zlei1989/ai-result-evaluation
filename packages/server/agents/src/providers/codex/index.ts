/**
 * codex 适配器：注入客户端选项与完整 model_providers 条目 → 消费事件流 → 按 §5.6.5 释放。
 * 注意：
 *  - 环境里已有的 `~/.codex` 配置（model_provider / 插件 / MCP）会**赢过**我们注入的 base URL，
 *    解药是把该行的 CODEX_HOME / HOME 指向 configHome（§5.6.4）；
 *  - 本次运行的 SDK 临时目录由本适配器创建，`dispose()` 负责删掉它（§5.6.5）；
 *  - codex 没有「优雅停止」这种能力：`interrupt()` 就是中止响应流。中止**不保证**收掉 CLI
 *    （平台语义与真实 SDK 的能力边界见 `closeRunStream` 的 JSDoc）。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '@aieval/core';
import { EFFORT_OFF, type SubagentRecord, type UsageTokens } from '@aieval/contracts';
import { asRecord } from '../../json';
import type { MessageDraft } from '../../message';
import { carrierKeyOf } from '../../message';
import { CODEX_PERMISSION_OPTIONS } from '../../permission';
import { createDisposer } from '../../release';
import { buildSubprocessEnv, ensureV1Suffix } from '../../route';
import { runTurn, resolveTiming, type TurnContext, type TurnStart } from '../../turn';
import type { AgentProvider, AgentRunInput, AgentRunResult } from '../../types';
import { addUsage } from '../../usage';
import { projectCodexEvent } from './events';
import { projectCodexMessages } from './message';
import { buildCodexConfig, loadCodexSdk, type CodexEvent } from './sdk';
import {
  createCachedTranscriptReader,
  createCodexTranscriptCache,
  discoverChildThreads,
  noteThreadIds,
  projectChildThreadUsage,
  projectTranscriptDrafts,
  readTranscript,
  type ChildThreadDiscovery,
  type CodexTranscriptReader,
  type TranscriptTargets,
} from './transcript';

const logger = createLogger('agents/codex');

/**
 * 运行期读会话文件的最小间隔（毫秒）。
 *
 * 取值理由：这份文件是唯一的内容来源，读一次 = 全量 `readFileSync` + 逐行 `JSON.parse`，
 * 而事件流在长运行里会到几千条。500 ms 意味着「界面上的内容最多滞后半秒」，
 * 同时把读盘次数钉在「每秒最多两次」——与界面的刷新观感同量级，不会成为新的热点。
 */
const CONTENT_READ_MIN_INTERVAL_MS = 500;

/**
 * **同一块还在长**时的最小重交间隔（毫秒）。
 *
 * 与 `CONTENT_READ_MIN_INTERVAL_MS` 分开的两档：读盘可以每 500 ms 一次（判据是「条数变了没」），
 * 但「块数没变、只是同一块的内容又长了一点」不值得每次都落盘——一条正文从开始到写完会经过
 * 几十次这样的中间态，而读侧只取最后一条。3 秒是「看得出它在长」与「写得别太勤」之间的取舍：
 * 真机实测同一条逻辑消息从 **171 次**降到个位数。
 * **块数一变立刻交**（那是结构性进度），所以这一档不会让界面显得迟钝。
 */
const SAME_SHAPE_REEMIT_MS = 3000;

/** 本仓统一的关闭档名（契约与界面都用它；这一家要翻成 CLI 的 `none`） */
const CODEX_OFF_EFFORT = EFFORT_OFF;

/**
 * 关闭档的**第二格**取值（spec §3.2）：CLI 的 `model_reasoning_summary`。
 *
 * 为什么不复用 `codexEffortOf`：那是 `model_reasoning_effort` 那一格的映射（`off` ⇒ `none`），
 * 而这一格是**另一个配置键**——两格一起才生效（见 `CodexConfig.model_reasoning_summary` 的注释）。
 */
const CODEX_OFF_REASONING_SUMMARY = 'none';

/**
 * 档位名 → CLI 的 `model_reasoning_effort` 取值。
 * **只有关闭档不同名**（2026-10-06 本机实测：CLI 的关闭档是 `none`，而 `off` 会被网关拒——
 * 请求体 `"reasoning":{"effort":"off"}` 让 CLI 重连 5 次后失败）。其余档位逐字透传。
 */
export function codexEffortOf(effort: string): string {
  return effort === CODEX_OFF_EFFORT ? 'none' : effort;
}

async function startCodex(
  context: TurnContext,
  /**
   * 会话文件读取面的**注入点**（可选）。缺省 = 生产行为（真的读 `$CODEX_HOME/sessions/**`）。
   *
   * 为什么留这一格：单测里 `configHome` 是 `D:/tmp/rows/…` 这类**不存在的路径**，
   * 真实读取在那里本来就只会返回「找不到」（不碰任何真实文件）；但 `thread_id` 若恰好撞上
   * 开发机 `$CODEX_HOME` 里的某个真实会话（测试夹具用的是 `t1` 这类短 id，概率低但不是零），
   * 用例就会读到真实产物 → 观测点漂移。注入之后，「index 层的接线」与「读盘」两件事各自可测，
   * 互不牵连（读盘的用例在 `transcript.test.ts` 里用合成 fixture 覆盖）。
   */
  transcriptReader: CodexTranscriptReader = { read: readTranscript },
): Promise<TurnStart> {
  const { input } = context;
  const sdk = await loadCodexSdk();
  // 该 SDK 会在 CLI 侧落临时文件：给本次运行一个独占目录，dispose 时一并回收（§5.6.5）
  const scratchDir = mkdtempSync(join(tmpdir(), 'aieval-codex-'));
  try {
    const env = buildSubprocessEnv({
      homeDir: input.configHome,
      injected: {
        CODEX_HOME: input.configHome,
        TMPDIR: scratchDir,
        TEMP: scratchDir,
        TMP: scratchDir,
      },
    });
    const baseUrl = ensureV1Suffix(input.route.baseUrl); // CLI 只走 Responses wire（§5.6.4）
    const client = new sdk.Codex({
      apiKey: input.route.apiKey,
      baseUrl,
      // 窗口交给 CLI 的 config（`--config model_context_window=…`）；未知时不写该键（见 buildCodexConfig 的注释）
      // 关闭档的第二格（spec §3.2）：**只在 `off` 时**给 `model_reasoning_summary:'none'`——
      // 它与下面 `modelReasoningEffort` 的 `none` 是**两格一起**才生效的前后半。两半各缺一次都会
      // 退回今天：缺**这一格** ⇒ 请求体里仍有 `summary:'auto'` ⇒ `include ∧ summary` 的组合让网关照旧
      // 推理（探针 D-B）；缺 **`effort:'none'`** ⇒ 网关退回它自己的默认强度 ⇒ 同样照旧推理。
      // 其余档位与未选传 `undefined` ⇒ config 里没有这个键（形态判据见 `CodexConfig` 的注释）。
      config: buildCodexConfig(
        baseUrl,
        input.route.contextWindow,
        input.effort === CODEX_OFF_EFFORT ? CODEX_OFF_REASONING_SUMMARY : undefined,
      ),
      env,
    });
    const thread = client.startThread({
      model: input.route.modelId,
      workingDirectory: input.cwd,
      // 权限档（见 `permission.ts`）：执行阶段 `danger-full-access`（`workspace-write` 默认**关掉网络**，
      // 装依赖 / 跑测试会因此失败），评分阶段 `read-only`；批准策略两档都是 `never`——
      // 评测是非交互的，任何走人工批准的路径都只会让该行走到超时。
      ...CODEX_PERMISSION_OPTIONS[input.permission],
      skipGitRepoCheck: true,
      // 思考强度（spec §6.4 / D13；2026-10-06）：未选 ⇒ 一个键都不加（实测这一家的「不传」
      // **不是关闭**：请求体里没有 effort 字段，落网关默认）。显式关闭档翻成 CLI 的 `none`。
      ...(input.effort === undefined ? {} : { modelReasoningEffort: codexEffortOf(input.effort) }),
    });
    // 响应流的中止入口：真实 SDK 把它交给 `spawn(exe, args, { signal })`（`dist/index.js:263-266`）。
    // 措辞按平台语义收敛（评审 N1）：中止**不保证**收掉 CLI——win32 上 `child.kill()` 走
    // `TerminateProcess`、子进程无法忽略；POSIX 上要成立得 CLI 自己装 SIGTERM handler。
    // 这里能观测到的只是「这次中止有没有终结迭代」。
    // 注意：骨架的 `controller` 在这里**不**参与（它只由 claude 的 dispose abort；本适配器的终止一律走
    // `streamAbort` 与下面的 `closeRunStream`）——原先那条 controller → streamAbort 的转发是死代码（评审 N1）。
    const streamAbort = new AbortController();
    /**
     * 结构化输出按需带：`outputSchema` 为 `undefined` / `null` 时**一个字段都不加**
     * （候选阶段与文本评分的行为逐字不变）。
     * 为什么把 `null` 与「没给」归为同一格：`null` 在这条路径上就是「没给」——
     * 在入口把两者同义化，不把判据交给厂商 SDK 的报错（它会在自己边界上先校验：
     * `null` 不是 plain object ⇒ 抛 `outputSchema must be a plain JSON object`，
     * `dist/index.js:10-12`，早于 CLI 启动）。本层的口径是「有没有一份可用的 schema」。
     */
    const run = await thread.runStreamed(input.prompt, {
      signal: streamAbort.signal,
      ...(input.outputSchema === undefined || input.outputSchema === null
        ? {}
        : { outputSchema: input.outputSchema }),
    });
    const events = run.events as AsyncIterable<CodexEvent> & { return?: () => Promise<unknown> };
    /**
     * 第二个中止入口：关闭 SDK 的事件迭代（评审 C1）。
     * 真实 SDK 的 `events` 是 async generator（`Thread.runStreamedInternal`，`dist/index.js:52-54`），
     * 它的 `return()` 带**排队**语义：迭代挂在 `await` 上时（`:297` 的 `for await (const line of rl)`）
     * 调用只是入队，直到生成器的下一个挂起点（yield / 结束）才生效 ⇒
     *  - **能保证的**（可达且可钉，复评 I1 之后收窄到这个范围）：被放弃的迭代只要之后落定一次
     *    （CLI 又写了一行 / 进程退出），排队的 return 就在那个挂起点生效——正在产出的那一个值仍会交付，
     *    随后迭代结束、SDK 的 `finally`（`:307-314`：`rl.close()` + `child.kill()`）才真的跑起来，
     *    而不是把后续事件无限消费下去（钉它的用例：`index.test.ts` 的「第二段兜底：被放弃的迭代
     *    再次落定」）；
     *  - **不能保证的**（已登记的适配器能力边界）：迭代若**永远**挂在等待上，本层无法让它结束 ⇒
     *    `runTurn` 的 `for await`（`turn.ts:181`）可能无界返回。真实 SDK 只有 `spawn(signal)` 一条
     *    停止通道（`dist/index.d.ts:169-174` 的 `TurnOptions` 只有 `signal` 与 `outputSchema`——后者是
     *    结构化输出、不是停止通道；`:200-212` 的 `Thread`
     *    只有 `run`/`runStreamed`/`id`，没有第二个 kill/close/cancel，也没有 SIGKILL 升级），
     *    所以这不是本适配器能补的缺陷。**行级有界由 p4 编排层的 `hardDeadline` 兜底**
     *    （`docs/superpowers/plans/2026-09-22-features-p4-evaluator.md:2607-2610,2622-2638,2648`）。
     */
    const closeRunStream = (): void => {
      // 刻意不 await：return 可能挂在永不落定的 await 上，dispose 不能被它拖住（必须幂等且有界）。
      // 吞掉 rejection（复评 I2）：`void` 不挂 handler，而全仓没有 unhandledRejection 处理器 ⇒
      // SDK 一旦拒绝就是打崩进程。release.ts 的 dispose 已有 try/catch 兜显式抛错，这里兜的是
      // **没人 await 的 promise**（今天不可达：cleanup 是 no-op、kill() 被 try/catch，见 I2 的三条证据）。
      void events.return?.().catch(() => {
        // 为什么可以吞：这是释放路径的最后一步，失败不该改变本次运行的结论，也不该升级成进程级事故。
      });
    };
    logger.debug('codex 已注入路由并启动线程', {
      model: input.route.modelId,
      contextWindow: input.route.contextWindow,
      effort: input.effort,
      baseUrl,
    });
    const seenTexts = new Map<string, string>();
    /**
     * 会话文件读取的目标（主线程 + 子线程）。线程 id **只能从事件流里拿**：
     * `thread.started.thread_id` 给主线程，`collab_tool_call.receiver_thread_ids` 给子线程。
     */
    const targets: TranscriptTargets = { mainThreadId: null, childThreadIds: [] };
    /**
     * 事件流交出的**最近一条权威计量**。
     * 为什么记在闭包里（而不是读 `state.usage*`）：codex 的口径是「整段任务一条 `turn.completed`」，
     * 而 `state.usage*` 是骨架给 dsh 那种「用量与轮次不同消息」准备的分段累加位，codex 从不写它。
     * 这里要回答的问题是「会话文件里的累计值比事件流给的更新吗」——只有跟事件流**原样交出的那份**比才有意义。
     * 刻意**不往 `state` 里塞新字段**：那会动到三家共用的结构，而本改造不需要。
     */
    let wireTokens: UsageTokens | null = null;
    /**
     * 事件流交出的**最近一个轮次数**（`TurnProjection.turns`）。
     * 为什么也要记：骨架那条 `usage` 事件的 `turns` 是**必填**，而 `finalize` 在**投影循环之外**，
     * 拿不到当轮投影。记下最后一次看到的值，才能让补发的那条 `usage` 事件与事件流里的**同一口径**。
     */
    let lastTurns: number | null = null;

    /**
     * 上一次读盘的时刻（毫秒）。**唯一**的运行期节流判据（见 `refreshContent`：
     * 不能拿「内容条数变了没」当闸门——那会把子线程刚出现的那一段整段跳过）。
     */
    let lastContentReadAt = 0;
    /**
     * **已经交出去过的消息**：`mergeKey → 上一次交出去时的 { 块数, 指纹, 时刻 }`。
     *
     * 为什么要这一层（不然落盘会膨胀）：投影器每次交出的是「到目前为止的完整折叠视图」，
     * 而运行期刷新要跑几十上百次 ⇒ 把整份视图每次都交给合并器，`messages.jsonl` 会被写成
     * 「第 1 次全量 + 第 2 次全量 + …」。真机实测：一条三分钟的 codex 行写出 **17.9 MB / 3805 条**，
     * 同一条逻辑消息最多被写 **171 次**。
     *
     * 三条判据（缺一条都会让某一类消息刷屏）：
     *   · **块数变了 ⇒ 立刻交**：块数增加是**结构性进度**（思考→正文→工具调用），
     *     界面上就是「又长出一块」，这一档必须实时；
     *   · **块数没变、但内容变了 ⇒ 至多每 `SAME_SHAPE_REEMIT_MS` 交一次**：这是**同一块还在长**
     *     （正文在流式累积、工具结果在追加输出）。它每 500 ms 都会变一点点，
     *     但读侧只看最后一条 ⇒ 中间那些只值得偶尔同步一次，否则一条消息就能写出几百条记录；
     *   · **逐字段相同 ⇒ 不交**（去重）。
     */
    const sentContent = new Map<string, { blocks: number; fingerprint: string; at: number }>();

    /**
     * 本行的**读盘面**：run 作用域的转录缓存 + **增量读**（2026-10-06）。
     *
     * 为什么必须有这一层：内容面每 500 ms 读一次会话文件（见 `CONTENT_READ_MIN_INTERVAL_MS`），
     * 而同一个文件在一行里还要被用量面、收尾各读一遍——一份只增不减的 jsonl 因此会被**整份**
     * 重复解析几十上百次。包一层之后：**没长 ⇒ 零 IO**；**长了 ⇒ 只读新增的那一段**（合并进同一份
     * 解析态）；文件变短 / 换过 ⇒ 整份重读（防御）。读盘本身也走共用的分块读，不再整份进内存。
     * ⚠️ **每行一个**（`startCodex` 之内）、**不跨 run**：模块级会把整份转录留在进程里。
     */
    const transcriptCache = createCodexTranscriptCache();
    const readTranscriptCached = createCachedTranscriptReader(transcriptCache, transcriptReader.read);

    /**
     * **一次递归发现**（含嵌套子线程）：内容面与用量面共用同一份（2026-10-06）。
     * 判据只有一处（`transcript.ts` 的 `discoverChildThreads`）——这里只负责把本行的三个输入凑齐，
     * 也**只在这里**决定「什么时候发现」（节流之内、收尾一次）。
     */
    const discover = (): ChildThreadDiscovery =>
      discoverChildThreads({
        codexHome: input.configHome,
        childThreadIds: targets.childThreadIds,
        mainThreadId: targets.mainThreadId,
        read: readTranscriptCached,
      });

    /**
     * 读会话文件 → 内容级消息与子任务行（**运行期与收尾共用同一份实现**）。
     *
     * 为什么运行期也要读（2026-10-03 修正）：codex 是**唯一**一家内容只走会话文件的适配器，
     * 而原来只在 `finalize` 里读 ⇒ 一整段 2–10 分钟的运行里抽屉**一个字都没有**
     * （用户口径：「Codex 执行日志看不到内容」），失败或被终止时更是一条都拿不到。
     * 而那份 `rollout-*.jsonl` 是 CLI **边跑边追加**的：每完成一个条目就多一行，
     * 随时都读得到已经发生的部分。
     *
     * 三条边界：
     *   · **只读盘、不编造**：文件还没建 / 还读不出条目时返回空数组（`readTranscript` 对半截行
     *     本来就跳过并计数，`findTranscript` 找不到就返回 `null`）；
     *   · **只交变化**：见 `sentContent` 的注释；
     *   · **节流**：条数没变不读；距上次读盘不足 `CONTENT_READ_MIN_INTERVAL_MS` 也不读。
     *
     * ⚠️ **发现由调用方给**（2026-10-06）：`discovery` 是同一个读周期里**只算一次**的那份递归发现，
     * 内容面与用量面共用它（`discoverChildThreads` 每个线程要扫一遍 `sessions/` 目录 + 读一份文件，
     * 一次刷新里算两遍是白付的）。
     */
    const readContent = (discovery: ChildThreadDiscovery): { messages: MessageDraft[]; subagents: SubagentRecord[] } => {
      const projected = projectCodexMessages({
        codexHome: input.configHome,
        mainThreadId: targets.mainThreadId,
        childThreadIds: targets.childThreadIds,
        read: readTranscriptCached,
        discovery,
      });
      return { messages: projected.messages, subagents: projected.subagents };
    };

    /**
     * 只留**值得再交一次**的那几条消息（判据见 `sentContent` 的注释）。
     * 子任务行不参与这一层：它们本身就很少，且读侧按 `subagentId` 覆盖。
     */
    const changedMessages = (messages: readonly MessageDraft[], now: number): MessageDraft[] => {
      const changed: MessageDraft[] = [];
      for (const message of messages) {
        const key = carrierKeyOf(message);
        const fingerprint = JSON.stringify(message);
        const previous = sentContent.get(key);
        if (previous !== undefined && previous.fingerprint === fingerprint) continue;
        const sameShape = previous !== undefined && previous.blocks === message.blocks.length;
        if (sameShape && now - previous.at < SAME_SHAPE_REEMIT_MS) continue;
        sentContent.set(key, { blocks: message.blocks.length, fingerprint, at: now });
        changed.push(message);
      }
      return changed;
    };

    /**
     * 运行期刷新：节流 + 只交变化。这次没有新东西时返回 `null`
     * （= **这一次不交内容**，调用方保持原投影；**不是**「采到了空」）。
     *
     * ⚠️ **不能再按「内容条数变了没」提前返回**（2026-10-03 真机实测的缺陷，
     * 用户口径「codex 子任务里面没有日志」）：那道闸门看起来是省一次读盘，实际会把
     * **子线程刚出现的那一段**整段跳过——判定发生在**读之前**，而「子线程出现了」这件事
     * 恰恰只能**读完之后**才知道（`childThreadIds` 来自事件流，子会话文件此前不存在）。
     * 真机形状：主线程的消息数在派发那一刻就稳定了 ⇒ 闸门一直说「没变」⇒ 子会话的内容
     * 一次都没被读出来，直到收尾那一次才可能补上（而收尾在中断/重试的行上根本不会跑）。
     * 现在只留**时间闸门**（每 `CONTENT_READ_MIN_INTERVAL_MS` 读一次，量级可控），
     * 去重交给 `changedMessages`（它按合并键比内容，没变就一条都不交）。
     */
    const refreshContent = (): { messages: MessageDraft[]; subagents: SubagentRecord[]; discovery: ChildThreadDiscovery } | null => {
      const now = Date.now();
      if (now - lastContentReadAt < CONTENT_READ_MIN_INTERVAL_MS) return null;
      lastContentReadAt = now;
      /**
       * **一个读周期只发现一次**（2026-10-06）：内容面与用量面共用这一份
       * （发现 = 每个线程扫一遍 `sessions/` + 读一份文件，而两处本来各算一遍）。
       * 闸门之内才算：节流掉的那些消息不该付这份账。
       */
      const discovery = discover();
      const content = readContent(discovery);
      const messages = changedMessages(content.messages, now);
      if (messages.length === 0 && content.subagents.length === 0) return null;
      return { messages, subagents: content.subagents, discovery };
    };

    return {
      stream: events,
      interrupt: () => {
        streamAbort.abort();
      },
      dispose: createDisposer(() => {
        streamAbort.abort();
        closeRunStream();
        rmSync(scratchDir, { recursive: true, force: true });
      }),
      project: (raw, state) => {
        noteThreadIds(targets, asRecord(raw));
        const projection = projectCodexEvent(raw, state, seenTexts, {
          kind: 'codex',
          baseUrl: input.route.baseUrl,
        });
        if (projection.tokens !== null) wireTokens = projection.tokens;
        if (projection.turns !== null) lastTurns = projection.turns;
        /**
         * 运行期的内容侧投影（节流，见 `refreshContent`）。`null` = 这一次不交内容
         * （还没到时间闸门 / 没读到新条目），保持原投影不变——**不是**「采到了空」。
         */
        if (targets.mainThreadId === null) return projection;
        const content = refreshContent();
        if (content === null) return projection;
        const base = { ...projection, messages: content.messages, subagents: content.subagents };
        /**
         * 子线程那一份（与收尾**同一份判据**：`transcript.ts` 的 `projectChildThreadUsage`）。
         *
         * 为什么运行期也要算它：只在收尾那一下才更新的话，一段几分钟的运行里界面上的 tok 一直是
         * 「只有主线程」的口径——而子会话文件是 CLI 边跑边追加的，随时都读得到已经发生的部分。
         *
         * 为什么折的是 `wireTokens` 而不是本条消息的 `projection.tokens`：`wireTokens` 是事件流交给
         * 我们的**主线程最新**计量（本条消息不带计量时也在），而这一格要回答的是「到目前为止的合计」
         * ——只看本条消息的话，`item.completed` 与协作条目那些消息永远补不上分量（它们的 tokens 是
         * `null`），分量要等到下一条 `turn.completed` 才可能出现。
         */
        /**
         * ⚠️ `mainThreadId` 也要交出去（spec §4 R7 起）：取数面在那一份实现里**沿 spawn 链递归**
         * （嵌套子线程只写在派发者自己的文件里），而递归必须挡住「某个线程的文件里点名了主线程」
         * 这一形状——否则主线程会被当成一个子线程再读一遍、算进分量，而「全量或 null」抓不住它
         * （那条规则只挡「读不到」，不挡「重复」）。
         */
        const sub = projectChildThreadUsage({
          codexHome: input.configHome,
          mainThreadId: targets.mainThreadId,
          childThreadIds: targets.childThreadIds,
          read: readTranscriptCached,
          // 与内容面**共用同一个周期的**发现（同一次刷新里只发现一次）
          discovery: content.discovery,
        }).usage;
        const combined = combine(wireTokens, sub);
        /**
         * 三条分支（没有第四条）：
         *   · **合计拿得出来** ⇒ 合计与分量**一起**交出去（理由见 `combine` 的注释）；
         *   · **合计拿不出来、但分量算得出来**（事件流还没交过计量）⇒ 这一条**不设计量**
         *     （缺省 = 保持上一份）；
         *   · **分量本身读不出来**（`sub === null`：新登记的子线程还没有可用的累计用量、或文件读不到）
         *     ⇒ 分量交**显式 `null`**（= 「明确没采到」，R2 里它**覆盖**旧值）。
         *     为什么最省事的「什么都不带」在这里是错的（2026-10-04 评审 Important 1）：`base.tokens`
         *     在本条消息是 `turn.completed` 时就是**主线程口径**那个数，而键缺省会让**上一版那个非零
         *     分量**留在骨架里 ⇒ 事件上出现「主线程口径的合计 + 非零分量」，界面据此算出的主会话偏小
         *     （真机形状：派了 c1、它跑完后又派 c2，而 c2 的会话文件还没写出可用的累计用量）。
         *     运行期能下的结论只到这一档：这一轮读不出来就是「没采到」；下一轮刷新若读到了，
         *     合计与分量会一起再交一次。
         *
         * ⚠️ 轮次（2026-10-04 评审 Minor 2）：运行期这一格仍是**事件流口径**（主线程的近似轮次），
         * 子线程的轮次要到收尾才补齐（`finalTurns = lastTurns + subagentTurns`）⇒ 运行期的 轮次
         * **不要与另两家横向比**：dsh 的运行期轮次天生含子会话（`step/start` 不区分会话）。
         *
         * ⚠️ **因此运行期这里也刻意不交 `subagentTurns`**（2026-10-04）：分量必须与它所属的合计同刻，
         * 而运行期的合计只有主线程那一份 ⇒ 交出去就会出现「主线程口径的合计 + 可能更大的子线程分量」
         * （真机形状：主线程 1 轮派活、子线程跑 5 轮），界面按「主会话 = 合计 − 分量」算出的主会话是
         * **负数**，`subagentTurns ≤ turns` 这条硬口径当场被破坏。收尾那一条把两格一起给
         * （见 `finalize`）——与用量那一对的分支结构刻意不同：用量在运行期有**同口径的合计**
         * （事件流的 `turn.completed` 就是全树的厂商自报值），轮次没有。
         */
        if (combined !== null) return { ...base, tokens: combined, subagentTokens: sub };
        return sub === null ? { ...base, subagentTokens: null } : base;
      },
      /**
       * 流跑完、且本次运行没有失败时读会话文件（见 `TurnStart.finalize` 的语义：
       * 只在流正常跑完时调用、抛错只记日志、在 `dispose` 之前跑）。
       *
       * 读的是 `input.configHome`——它就是本行注入给 CLI 的 `CODEX_HOME`（见上面的 `env`），
       * 所以「会话文件在哪」与「我们把 CLI 的 home 指到哪」是同一个值，不需要另开配置项。
       */
      finalize: () => {
        /**
         * **收尾这一轮只发现一次**（2026-10-06）：用量面（`projectTranscriptDrafts`）与内容面
         * （`readContent`）共用同一份——此前两处各发现一遍，一个周期的目录扫描与读盘都是双份。
         */
        const discovery = discover();
        const projected = projectTranscriptDrafts({
          codexHome: input.configHome,
          mainThreadId: targets.mainThreadId,
          childThreadIds: targets.childThreadIds,
          read: readTranscriptCached,
          discovery,
        });
        const drafts = [...projected.drafts];
        /**
         * 计量合并：**只在 `isStrictlyNewer` 为真时**才补一条 `usage` 事件。为什么不是「无条件覆盖」：
         * 同一次运行里 `turn.completed` 与 `token_count` 是同一条账（都是 CLI 自己报的），
         * 无条件覆盖只会把「事件流已经给过的同一个数」再发一遍（而 `liveUsage: 'reported'` 的语义是
         * **逐步回写快照**，重复发同值事件是纯噪声）。
         *
         * `lastTurns === null` 时不补：骨架那条 `usage` 事件的 `turns` 是**必填**，而「一次**答复**
         * 条目都没数到」时没有任何诚实的数可填（填 0 就是「计量绝不填 0」那条硬口径要防的东西）。
         * 代价如实登记：那一格下会话文件的计量只出现在 `kind: 'transcript'` 的日志载荷里，
         * 不进 `usage` 事件——**不编一个 0**。
         *
         * `timing`（2026-10-XX）：**这一条路是 codex 唯一能给出时长的通路**——事件流一个时间字段
         * 都没有（实测），只有会话文件的每行 `timestamp` 有。所以这里连同 `projected.timing`
         * 一起带上（`source: 'events'`，含工具执行的墙钟）。会话文件读不到、或里面一行时间戳都没有时
         * `projected.timing` 是 `undefined` ⇒ 这条事件**不带时间**，绝不用我们自己的 `at` 冒充。
         * 为什么要在这里把 `TimingSpan` 换算成事件那一格、而不是像循环内那样交给骨架：`finalize`
         * **在投影循环之外**（流已经跑完），它的返回值是**成品草稿**、不再经过骨架的合并
         * ⇒ 这一处必须自己调 `resolveTiming`。同一份换算只有一个实现（`turn.ts` 里那个），
         * 所以这里 import 它、而不是就地再写一遍「lastMs - firstMs」。
         * ⚠️ 只有 `projected.usage !== null` 才进得来 ⇒ 计时与计量是**绑在一起**的：
         * 会话文件里有时间戳但没有可用的累计用量时，这一格不会单独发出去（`turns` 必填，
         * 而 `usage` 事件本来就是计量事件——为一个「只有时长」的事件另造一条通路，
         * 收益只是让界面早几秒看到耗时，代价是多一个跨三家的形状）。
         *
         * ⚠️ `combined` 就是 `projected.usage`：那一格的语义**已经是主 + 子**的合计
         * （见 `TranscriptProjection.usage`）⇒ **不要再加一次 `subagentUsage`**，
         * 那会把子线程算两遍（两处都是「算得出来的数」，界面上看不出错）。
         * 子那一份没读全时 `projected.usage` 已经退回主线程口径，合计与分量的口径始终一致。
         */
        const combined = projected.usage;
        /**
         * 终态的轮次 = 事件流数出来的（主线程的近似轮次）+ 子线程的轮次（各线程 `turnIds` 去重后的个数之和）。
         * `lastTurns === null`（一次答复条目都没数到）时保持 `null`——**不编一个 0**；
         * 子那一份没读全时 `subagentTurns` 是 `null` ⇒ 只加 0（与用量同一条口径：退回主线程那份）。
         * 这不是「拿 0 冒充」：`subagentUsage` 那一格同时是 `null`，界面因此不会把总量说成含了子线程。
         *
         * ⚠️ **这里的两半是两把尺子**（已知残留，见 `TranscriptProjection.subagentTurns` 的注记）：
         * 前一半是**答复条目**口径、后一半（`subagentTurns`）是**会话文件 `turnIds`** 口径
         * ⇒ 行卡片这个合计**不等于**两个会话节点各自显示的轮次之和（真机 21 ≠ 18 + 13）。
         * 本次（2026-10-05）**不改计算**（`EvalRow.turns` 是 spec §2.5 明文不动的东西），只登记。
         */
        const finalTurns = lastTurns === null ? null : lastTurns + (projected.subagentTurns ?? 0);
        /**
         * 轮次那一格的**分量**（2026-10-04）：与 `turns` **成对**交出去。
         *
         * 为什么 `finalTurns === null` 时分量也必须是 `null`：那一刻「这一行跑了几轮」根本没有诚实的值
         * （合计拿不出来），而一个**孤儿分量**会让界面按「主会话 = 合计 − 分量」算出一个不存在的主会话
         * ——与 `subagentTokens` 在 `combined === null` 时的处置逐字相同。
         * 截断（`projected.subagentTurns === null`）自然落进 `null` 那一档：不拿部分和冒充总数，
         * 且那条点名整行的 WARN（`projectTranscriptDrafts` 里）已经把「轮次也不含未读到的子线程」说清。
         */
        const subagentTurns = finalTurns === null ? null : projected.subagentTurns;
        if (combined !== null && finalTurns !== null && isStrictlyNewer(combined, wireTokens)) {
          drafts.push({
            type: 'usage',
            tokens: combined,
            /**
             * 子线程那一份：与上面的 `tokens` **同时**交出——只给分量不给合计时，界面按
             * 「主会话 = 合计 − 分量」会算出负数。读不到就是 `null`（= 「没采到」），
             * 而 `{0,0,0}` 是「确实没有子智能体」——两者在界面上是两种不同的呈现。
             */
            subagentTokens: projected.subagentUsage,
            /** 轮次那一格的分量：与 `turns`（全树合计）同一条事件，界面据此画两行 */
            subagentTurns,
            /**
             * 归属（2026-10-05）：**主线程**的 wire 轮次（`lastTurns`）——这条读数就是事件流上数出来的
             * 那个号（事件流只有主线程条目，子线程不产 `usage` 事件），与会话文件统一之后的编号同一把
             * 尺子（只数答复条目，见 `events.ts` 的 `TURN_ITEM_TYPES`）。刻意**不拿 `finalTurns` 顶替**：
             * 那是「主 + 子」的**本行合计**，拿它当会话轮次号会把这条读数挂到别的会话同号的轮次上——
             * 正是本次归属设计要消灭的错位（spec §1.2/§2.3）。`lastTurns` 为 `null`（一次答复条目都没
             * 数到）时保持 `null`：那一刻没有诚实的号可填，按时刻归位（与加这一格之前的行为一致），
             * 且这种情形下 `finalTurns` 也是 `null`、这一条根本发不出去。
             */
            turn: lastTurns === null ? null : { subagentId: null, round: lastTurns },
            timing: resolveTiming(projected.timing ?? null),
            turns: finalTurns,
          });
        }
        /**
         * 内容级消息与子任务行（spec v3 §2）：**这一家只从会话文件出消息**——事件流缺工具真名、
         * 结构化入参与 `call_id`（工具结果与调用的配对键），两边都出会让每条消息出现两次
         * （身份键不同：事件流 `item_N`、会话文件 `call_id`）。
         *
         * 同一份投影运行期也在读（见 `readContent` 的注释）：收尾这一次的价值是**补齐最后一段**
         * ——流关闭之后 CLI 可能还写了一两行，而那几行里就可能有最后的答复。
         */
        const content = readContent(discovery);
        return {
          drafts,
          messages: content.messages,
          subagents: content.subagents,
          // 终态结果也带上（否则编排层第 6 步会用不含子线程的 result.tokens 覆盖快照）
          ...(combined === null ? {} : { tokens: combined }),
          /**
           * 子那一份**也进结果**：编排层第 6 步的 `patchRow` 用 `result.tokens` 覆盖快照，
           * 只在事件里给数的话，这一格会在几毫秒后被骨架里那个旧值盖掉。
           *
           * 合计拿不出来（`combined === null`：主线程文件读不到）时这一格必须是**显式 `null`**
           * ——「明确没采到」⇒ 覆盖。只给分量不给合计会让界面上的「主会话 = 合计 − 分量」算出负数，
           * 而那条不变量（`subagentTokens ≤ tokens`）正是这一格的 `null` 语义要守的东西（R2）。
           */
          subagentTokens: combined === null ? null : projected.subagentUsage,
          /**
           * 轮次那一格的分量**也进结果**：编排层第 6 步的终态 `patchRow` 用 `result.turns` 覆盖快照，
           * 只在事件里给数的话这一格会被随后那次写入清掉。`finalTurns === null`（合计拿不出来）时
           * 它是**显式 `null`**（= 明确没采到 ⇒ 覆盖），与上面那一格的处置同源。
           */
          subagentTurns,
          ...(finalTurns === null ? {} : { turns: finalTurns }),
        };
      },
    };
  } catch (cause) {
    // start 阶段失败（CLI 未安装 / 线程建不起来）时还没交出释放句柄：临时目录必须在这里清掉，
    // 否则「装不上 CLI」会变成「每跑一次留一个临时目录」
    rmSync(scratchDir, { recursive: true, force: true });
    throw cause;
  }
}

/**
 * 运行期那一对：子线程那一份折进合计。`main === null`（事件流还没交过计量）或 `sub === null`
 * （还没有子线程可算、或某个子线程读不到）时返回 `null` —— 调用方据此**不把这两格当成一对**
 * 交出去（见 `project` 里那三条分支）。
 *
 * 为什么这一步非有不可、且只在**一处**算：`TurnProjection` 的 `tokens` 与 `subagentTokens`
 * 是**一对**——界面按「主会话 = 合计 − 分量」推主会话那一行，只给分量不给合计会让那个减法算出
 * **负数**（而减法本身看起来完全正常）。求和一律走 `addUsage`（`usage.ts`，与收尾那条路、
 * 与另两家同一份实现）：这里手写加法会与终态漂移，也会踩到「加一个零不是恒等」那个坑。
 *
 * ⚠️ 与 `addUsage` **唯一的差别**在 `sub === null` 这一格：`addUsage(main, null)` 返回 `main`
 * （「合计退回主会话口径」，收尾那条路要的正是它），而运行期**不能**把「主线程口径的合计 +
 * 旧的非零分量」当一对交出去 ⇒ 这里自己把它挡成 `null`。（`main === null` 两处同义：
 * `addUsage` 的口径 2 也是 `null`——拿不出合计。）
 */
function combine(main: UsageTokens | null, sub: UsageTokens | null): UsageTokens | null {
  return sub === null ? null : addUsage(main, sub);
}

/**
 * `next` 是否比 `previous` **严格更新**。
 * 判据是「**至少一格更大、且没有一格更小**」：
 *   · `previous === null`（事件流一次都没交过计量）⇒ 真——「从没采到」→「采到了」是一次真实变化；
 *   · 三个必填格逐字段相同、且两个可选格也没变多 ⇒ **假**——同一笔账再说一遍是纯噪声
 *     （`turn.completed` 与 `token_count` 都是 CLI 自己报的同一个数）；
 *   · 任一必填格更小 ⇒ 假——那个数来自另一个口径（例如 `last_token_usage` 之于 `total_token_usage`），
 *     把小的发出去会让界面上的数**往回流**。
 *
 * ⚠️ **两个可选格（`reasoningOutput` / `total`）只能把结论推向「更新」，不能推向「更旧」**：
 * 它们只在会话文件里有（事件流那条 `turn.completed` 一般不带），所以拿它们比大小时，
 * 「事件流有、文件没有」这种组合会**误判成回退**，把一条本该发出去的刷新事件吞掉。
 * 于是这里的判据是「两个可选格里**有一个真的变多了**」⇒ 也算更新（`auxiliaryGrew`），
 * 而它们的**变小忽略不计**——那更可能是「这一份文件没写全」，不是「这笔账变小了」。
 */
function isStrictlyNewer(next: UsageTokens, previous: UsageTokens | null): boolean {
  if (previous === null) return true;
  if (next.input < previous.input || next.cached < previous.cached || next.output < previous.output) return false;
  if (next.input > previous.input || next.cached > previous.cached || next.output > previous.output) return true;
  return auxiliaryGrew(next.reasoningOutput, previous.reasoningOutput) || auxiliaryGrew(next.total, previous.total);
}

/** 可选格「变多了」：缺席（`null` / `undefined`）按 0 比——从「没有」到「有 30」是一次真实的补充 */
function auxiliaryGrew(next: number | null | undefined, previous: number | null | undefined): boolean {
  return (next ?? 0) > (previous ?? 0);
}

/**
 * 为什么类型是 `AgentProvider & { transcriptReader: … }` 而不是裸 `AgentProvider`：
 * `AgentProvider`（`types.ts`）是三家共用的契约，**刻意不动它**——多出来的一格是本家自己的
 * 可注入面（见下面那段注释）。写成交叉类型而不是 `as`，是为了让「这一格到底存不存在」
 * 在编译期就成立（`as AgentProvider` 会把 `codexProvider.transcriptReader` 一起擦掉）。
 */
export const codexProvider: AgentProvider & { transcriptReader: CodexTranscriptReader } = {
  kind: 'codex',
  displayName: 'Codex',
  /**
   * 会话文件读取面的注入点。
   *
   * 为什么挂在**注册表对象自己**身上（而不是模块级的 `setXForTesting`）：注册表是「按 kind 解析出
   * provider 再调 run」的唯一入口（`registry.ts`），而注入必须**跟着这一个对象**走，才能保证
   * 「并行跑两行、一行用假读取器」这件事的边界是清楚的——模块级可变状态做不到这一点
   * （本仓已经在 dsh 的 `subagentCatalog` 上登记过那种做法的代价）。
   * 缺省 = 生产行为（真的读 `$CODEX_HOME/sessions/**`）；测试把它换成合成 transcript：
   * 于是「接线」与「读盘」两件事各自可测，互不牵连。
   */
  transcriptReader: { read: readTranscript },
  metadata: {
    // 只讲一条 wire（codex CLI 走 Responses）⇒ 集合只有一个元素
    protocolTypes: ['openai'],
    // liveUsage: 'reported' —— 每轮 `turn.completed` 自带用量（适配器上报值，与终值同口径）
    // ⇒ 跑动期可以逐步回写快照（见 types.ts 的 liveUsage 注释）
    // structuredOutput: true —— codex CLI 有 `outputSchema` 入参（原生 schema 开关），
    // 返回形状由 CLI 侧约束；落点在 Task 4
    capability: { cancelMidTurn: true, usage: true, liveUsage: 'reported', structuredOutput: true },
    /**
     * 消息能力声明（spec v3 §3.5）：两条通道各有一格**结构性**拿不到——
     *   · 思考正文只在**会话文件**里（事件流的 `reasoning` item 按厂商定义只给摘要）；
     *   · 工具真名与结构化入参也只在**会话文件**里（事件流只有命令文本与协作动作名）。
     * 适配器把两条通道合成一份结果（正文取会话文件、增量取事件流），故两格记 `'yes'`，
     * 并在这里写清前提。
     */
    messageCapability: {
      thinkingText: 'yes',
      thinkingTextKind: 'full',
      toolInput: 'yes',
      toolResult: 'yes',
      subagent: 'yes',
      streamingDelta: 'no',
      thinkingTextSource: 'session-file',
      thinkingTextReason: null,
      toolInputSource: 'session-file',
      toolInputReason: null,
      toolResultSource: 'wire',
      toolResultReason: null,
      subagentSource: 'session-file',
      subagentReason: null,
      streamingDeltaSource: null,
      streamingDeltaReason: 'not-supported',
      notes: [
        '事件流没有 delta 形态（`item.started` / `item.updated` / `item.completed` 都是快照）⇒ 不做逐字动画',
        '消息只在**运行结束**时从会话文件投递一次：运行期只有派发事件与 `agents_states` 状态，没有实时轨迹',
        '多智能体随**路由**翻转：会拒绝命名空间工具的路由上 `spawn_agent` 被判 `unsupported call`，子任务面为空',
        '文件类五族与 `web_search` 取不到值取决于当前模型预设与本仓配置（`tools.web_search=false`）：按工具名归族，不写死「这家没有」',
        '子任务终态没有原生字段（hook 载荷里没有 `status`）⇒ 只能用会话文件里的证据推，缺失记 `unknown` + `statusMissing`',
      ],
    },
    // 档位域 = SDK 的 `ModelReasoningEffort` 八档 **加上**本仓统一的关闭档 `off`
    // （它翻成 CLI 的 `none`——SDK 的类型面落后于 CLI，实测 CLI 接受 `none`，见 `codexEffortOf`）
    reasoningEfforts: [EFFORT_OFF, 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'persistent'],
    isolation: 'subprocess',
  },
  run: (input: AgentRunInput): Promise<AgentRunResult> =>
    runTurn(input, {
      kind: 'codex',
      start: (context) => startCodex(context, codexProvider.transcriptReader),
    }),
};