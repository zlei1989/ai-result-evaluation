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
import type { UsageTokens } from '@aieval/contracts';
import { asRecord } from '../../json';
import { CODEX_PERMISSION_OPTIONS } from '../../permission';
import { createDisposer } from '../../release';
import { buildSubprocessEnv, ensureV1Suffix } from '../../route';
import { runTurn, resolveTiming, type TurnContext, type TurnStart } from '../../turn';
import type { AgentProvider, AgentRunInput, AgentRunResult } from '../../types';
import { projectCodexEvent } from './events';
import { projectCodexMessages } from './message';
import { buildCodexConfig, loadCodexSdk, type CodexEvent } from './sdk';
import {
  noteThreadIds,
  projectTranscriptDrafts,
  readTranscript,
  type CodexTranscriptReader,
  type TranscriptTargets,
} from './transcript';

const logger = createLogger('agents/codex');

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
      config: buildCodexConfig(baseUrl, input.route.contextWindow),
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
      // 思考强度按需带（spec §6.4 / D13）：`undefined` 时一个键都不加，让模型用自己的默认档
      ...(input.effort === undefined ? {} : { modelReasoningEffort: input.effort }),
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
        return projection;
      },
      /**
       * 流跑完、且本次运行没有失败时读会话文件（见 `TurnStart.finalize` 的语义：
       * 只在流正常跑完时调用、抛错只记日志、在 `dispose` 之前跑）。
       *
       * 读的是 `input.configHome`——它就是本行注入给 CLI 的 `CODEX_HOME`（见上面的 `env`），
       * 所以「会话文件在哪」与「我们把 CLI 的 home 指到哪」是同一个值，不需要另开配置项。
       */
      finalize: () => {
        const projected = projectTranscriptDrafts({
          codexHome: input.configHome,
          mainThreadId: targets.mainThreadId,
          childThreadIds: targets.childThreadIds,
          read: transcriptReader.read,
        });
        const drafts = [...projected.drafts];
        /**
         * 计量合并：**只在 `isStrictlyNewer` 为真时**才补一条 `usage` 事件。为什么不是「无条件覆盖」：
         * 同一次运行里 `turn.completed` 与 `token_count` 是同一条账（都是 CLI 自己报的），
         * 无条件覆盖只会把「事件流已经给过的同一个数」再发一遍（而 `liveUsage: 'reported'` 的语义是
         * **逐步回写快照**，重复发同值事件是纯噪声）。
         *
         * `lastTurns === null` 时不补：骨架那条 `usage` 事件的 `turns` 是**必填**，而「一次模型产出
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
         */
        if (projected.usage !== null && lastTurns !== null && isStrictlyNewer(projected.usage, wireTokens)) {
          drafts.push({
            type: 'usage',
            tokens: projected.usage,
            timing: resolveTiming(projected.timing ?? null),
            turns: lastTurns,
          });
        }
        /**
         * 内容级消息与子任务行（spec v3 §2）：**这一家只从会话文件出消息**——事件流缺工具真名、
         * 结构化入参与 `call_id`（工具结果与调用的配对键），两边都出会让每条消息出现两次
         * （身份键不同：事件流 `item_N`、会话文件 `call_id`）。代价如实登记：运行期看不到消息。
         * 与上面的会话文件读取**共用同一次读盘**（`transcriptReader.read` 有进程内缓存，
         * 见 `readByThreadId` 的调用点）。
         */
        const content = projectCodexMessages({
          codexHome: input.configHome,
          mainThreadId: targets.mainThreadId,
          childThreadIds: targets.childThreadIds,
          read: transcriptReader.read,
        });
        return { drafts, messages: content.messages, subagents: content.subagents };
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
    // 档位域 = codex-sdk 的 `ModelReasoningEffort`（比上游网关实际用到的档更宽：多 minimal / ultra / persistent）
    reasoningEfforts: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'persistent'],
    isolation: 'subprocess',
  },
  run: (input: AgentRunInput): Promise<AgentRunResult> =>
    runTurn(input, {
      kind: 'codex',
      start: (context) => startCodex(context, codexProvider.transcriptReader),
    }),
};