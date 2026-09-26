/**
 * claude-code 适配器：注入路由 → 消费消息流 → 按 §5.6.5 释放。
 * 注意：
 *  - `run()` 的骨架由 `runTurn` 提供，本文件只负责厂商特有的三件事：注入、拿停止句柄、投影消息；
 *  - 输入的 `route` 只读，绝不写 `process.env`（§5.6.4 不变量 1/2）；
 *  - 禁用名单**随模型名分档**（2026-09-29）：`modelId` 含 `claude` 时放行 `WebSearch`，其余模型禁用
 *    （判据与理由见 `disallowedToolsFor`）；名单里另六项与模型无关，任何模型都禁；
 *  - `settingSources` 与 `settings` **必须成对给**（2026-09-29 口径变更，原为 `settingSources: []`）：
 *    打开 settings 才能读到被测仓库的 `CLAUDE.md` / 项目配置，而打开之后仓库自带的
 *    `.claude/settings.json` 的 `env` 块就能改写本次路由 ⇒ 用 `settings.env`（flag 档，
 *    优先级高于 project / local）把路由钉回去。两半分开做都会坏（见两个常量的注释）。
 */
import { realpathSync } from 'node:fs';
import { createLogger } from '@aieval/core';
import { CLAUDE_PERMISSION_OPTIONS } from '../../permission';
import { createDisposer } from '../../release';
import { buildSubprocessEnv, stripV1Suffix } from '../../route';
import { runTurn, type TurnContext, type TurnStart } from '../../turn';
import type { AgentProvider, AgentRunInput, AgentRunResult } from '../../types';
import { projectClaudeMessage } from './events';
import { createClaudeMessageNormalizer } from './message';
import { loadClaudeSdk } from './sdk';

const logger = createLogger('agents/claude-code');

/**
 * 与评测无关的旁路工具：**无条件**禁用（用户口径，2026-09-29）。
 *
 * 禁的不是「能力」而是旁路，逐条理由：
 *  - `CronCreate` / `CronDelete` / `CronList` / `ScheduleWakeup`：会话级定时唤醒——本产品的每一行
 *    跑完就 `dispose()`（§5.6.5），没有「以后」；留着只会让 CLI 在无人接续的会话里排定时任务；
 *  - `PushNotification`：向人推通知——评测是无人值守的，没有收件人；
 *  - `DesignSync`：设计与本仓无关的外部同步口（该名字在本机 SDK 2.1.281 的工具表里不存在，
 *    写了不报错也不生效；留着是为了与用户给的名单逐字一致，等厂商版本对上时自动生效）。
 *
 * 落点是 SDK 的 `disallowedTools` ⇄ CLI 的 `--disallowedTools <逗号分隔>`（实测 `sdk.mjs` 的 argv 拼装：
 * 非空数组才追加该参数），语义是「从模型上下文里摘掉、且连 harness 内部直呼也拦住」。厂商对不认识的
 * 名字不报错 ⇒ 名单可以**先于**厂商版本存在（这正是 `DesignSync` 那一格的意义）。
 *
 * ⚠️ 只禁「工具」，不禁网络：`Bash` / `WebFetch` 照旧可用——评测要观察的正是「改完自己跑不跑得起来」
 * （与 codex 用 `danger-full-access` 而非 `workspace-write` 同一条理由，见 `permission.ts`）。
 */
const ALWAYS_DISALLOWED_TOOLS: readonly string[] = [
  'CronCreate',
  'CronDelete',
  'CronList',
  'ScheduleWakeup',
  'PushNotification',
  'DesignSync',
];

/**
 * 只在**非 Claude 模型**上禁用的工具（用户口径，2026-09-29）：
 * `modelId` 里含 `claude`（大小写不敏感）时放行 `WebSearch`，其余模型禁用它。
 *
 * 为什么按模型名分档：`WebSearch` 是厂商**服务端**执行的工具，第三方模型走同一网关时未必实现它
 * ——§5.6.4 就记着「网关对这些命名空间工具回 400」（codex 侧因此无条件关掉 `web_search`，
 * 见 `buildCodexConfig`）。真正的 Claude 模型没这个顾虑，于是把这一格交给模型名决定：
 * 名单里其余六项与模型无关，任何模型都不放行。
 *
 * ⚠️ 判据是 `route.modelId` 的**子串**（大小写不敏感），不是白名单：网关侧形如
 * `anthropic/claude-sonnet-4-6` / `jd/Claude-4.5` 的写法都算「Claude 模型」。
 */
const NON_CLAUDE_DISALLOWED_TOOLS: readonly string[] = ['WebSearch'];

/** 本次运行的禁用名单：无条件那六项 + （非 Claude 模型时的）`WebSearch` */
function disallowedToolsFor(modelId: string): string[] {
  const claudeModel = /claude/i.test(modelId);
  return [...ALWAYS_DISALLOWED_TOOLS, ...(claudeModel ? [] : NON_CLAUDE_DISALLOWED_TOOLS)];
}

/**
 * 多大算「1M 变体」（spec D4 / D9）：这是 **cc 的方言阈值**，不是领域概念，故常量留在这里，
 * 不进 contracts —— 放契约里会诱导别的层拿它做窗口判断。
 */
const ONE_M_CONTEXT = 1_000_000;

/**
 * 交给 SDK 的模型名：窗口 ≥ 1M 时写成 `<id>[1m]`（用户口径：非 Claude 名字也加）。
 *
 * 为什么只能靠名字：Agent SDK 里那个正经入口 `betas: ['context-1m-2025-08-07']` 已随 beta 退役
 * （官方 Agent SDK 文档明写 2026-04-30 起对该模型无效），模型名后缀是今天唯一能表达 1M 的通道。
 * 已经带后缀的名字**原样返回**：幂等，免得用户手工把清单里的名字写成 `X[1m]` 时拼成 `X[1m][1m]`。
 */
function modelForClaudeCode(modelId: string, contextWindow: number | undefined): string {
  // 后缀判定**不分大小写**：用户手工维护清单时写成 `X[1M]` 很常见（网关的 displayName 就常是大写），
  // 而只认小写会把它判成「没带后缀」，拼出一个根本不存在的 `X[1M][1m]` —— 那只在真跑时才炸。
  if (modelId.toLowerCase().endsWith('[1m]')) return modelId;
  return contextWindow !== undefined && contextWindow >= ONE_M_CONTEXT ? `${modelId}[1m]` : modelId;
}

/**
 * 加载哪些**文件系统 settings**（SDK 的 `--setting-sources=user,project,local`；`[]` = 隔离模式）。
 *
 * 为什么不再是 `[]`（2026-09-29 口径变更）：`[]` 会把被测仓库的 `CLAUDE.md` 一起挡在门外——
 * SDK 的 JSDoc 逐字写着「Must include `'project'` to load CLAUDE.md files」，于是「这个仓库自己
 * 告诉 agent 该怎么干活」这件事在 cc 侧从来没生效过（codex 侧同样读不到 repo 的 AGENTS.md）。
 *
 * 为什么 `'user'` 这一档**不**会捡到宿主的 `~/.claude/settings.json`（原 `[]` 的理由）：
 * 适配器把 `HOME` / `USERPROFILE` / `CLAUDE_CONFIG_DIR` 全指向本行的 `.agenthome`（§5.6.4 不变量 3），
 * 而 `'user'` 档读的正是 `CLAUDE_CONFIG_DIR/settings.json`——本机实测（SDK 自己的 `resolveSettings`，
 * 隔离环境逐字对齐）：`'user'` 解析到 `<configHome>/settings.json`，宿主真实 `~/.claude` 一个文件都不读。
 *
 * ⚠️ 剩下的风险只来自**被测仓库**（`project` / `local` 两档读 `${cwd}/.claude/settings.json` 与
 * `settings.local.json`），而 candidate 自己就能往工作区里写这个文件：它的 `env` 块会盖掉本次路由
 * （实测：只开本选项时 14 次 `/v1/messages` 全部打到仓库指定的地址、带仓库指定的密钥）。
 * 解药是下面的 `settings` 那一格，两者**必须同时存在**。
 */
const CLAUDE_SETTING_SOURCES: readonly string[] = ['user', 'project', 'local'];

/**
 * 交给 SDK 的工作目录（终审 H1 的必修项之一）。
 *
 * 为什么必须归一：Windows 上 NTFS 为每个长目录名都保留一个 **8.3 短名**（本机 `%TEMP%` 的
 * `ZHANGL~1`），而 claude 的 harness 有一道**路径模式安全门**——它把「含 8.3 短名 / ADS /
 * 长路径前缀 / 连续三个点」的路径判为「需要人工确认」。p6 冒烟实测（`04-runA.md:93-109`）：
 * 该门连 `Read` 都拦，CLI 自己写下「Every read and write path to the target file is gated by
 * the harness」，于是 7 行 claude-code **全部 0 改动**、评分在「无改动」输入上打出 20 分。
 *
 * ⚠️ **这里必须用 `realpathSync.native`，不能用 JS 版 `realpathSync`**（本机实测，Node 24）：
 * ```
 * fs.realpathSync('C:\Users\ZHANGL~1\AppData\Local\Temp\x')        → 'C:\Users\ZHANGL~1\...\x'   ← 仍是短名
 * fs.realpathSync.native('C:\Users\ZHANGL~1\AppData\Local\Temp\x')  → 'C:\Users\zhanglei1120\...\x' ← 长名
 * ```
 * JS 版在 Windows 上**不做**短名归一（它按组件拼回原样），照它写等于没修。全仓另一半
 * （`core/src/git.ts` 的 repoPath 归一）用的是 JS 版，那是另一条路径、不受本门影响。
 *
 * 取不到时**回落原值**，绝不因此让整行失败：`realpathSync.native` 在路径不存在时抛 ENOENT（实测），
 * 而归一只是「让 CLI 的安全门放行」这一件事的**尽力而为**——真正的工作区存在性由工作区准备阶段负责
 * （不存在时它会先抛带中文原因的错，这里抢着报只会把真正的原因顶掉）。
 *
 * ⚠️ 这一支刻意记 **DEBUG 而不是 WARN**（口径见 `core/src/logger.ts`：WARN 留给「降级、重试、超时、
 * 配置缺失但可继续」）：拿不到 cwd 的真实原因是「目录还不存在 / 测试里的假路径」，那不是本层能处置的
 * 事，也不该出现在生产 WARN 流里；而它一旦走 WARN，还会**污染**那些故意让 `console.warn` 抛错的用例
 * （实测：`index.test.ts` 的「第二段兜底的回调自身抛错」正是靠 WARN 抛错来验证释放顺序的，
 * 这一支先响就会把该用例的判据整个顶掉）。
 */
function canonicalCwd(cwd: string): string {
  try {
    return realpathSync.native(cwd);
  } catch (error) {
    logger.debug('工作目录 realpath 归一失败，按原值传给 SDK（8.3 短名路径可能被 CLI 的安全门拦下）', {
      cwd,
      error,
    });
    return cwd;
  }
}

async function startClaudeCode(context: TurnContext): Promise<TurnStart> {
  const { input, controller } = context;
  const sdk = await loadClaudeSdk();
  /** 消息归一器（spec v3 §2）：一份 run 一个——流式块序号要跨消息存活（见 `message.ts`） */
  const messages = createClaudeMessageNormalizer();
  // 该 SDK 自己追加 /v1/messages：留着尾部 /v1 会变成 /v1/v1/messages（§5.6.4）
  const baseUrl = stripV1Suffix(input.route.baseUrl);
  const env = buildSubprocessEnv({
    homeDir: input.configHome,
    injected: {
      ANTHROPIC_BASE_URL: baseUrl,
      ANTHROPIC_API_KEY: input.route.apiKey,
      // 部分网关只认 AUTH_TOKEN：两个都给，避免「密钥明明对却 401」
      ANTHROPIC_AUTH_TOKEN: input.route.apiKey,
      CLAUDE_CONFIG_DIR: input.configHome,
      /**
       * 任务跟踪工具（`TaskCreate`/`TaskUpdate`/`TaskGet`/`TaskList`）在**新模型上默认不装**——
       * 官方口径（用户提供，2026-09-30）：自 SDK 0.3.142 / CC 2.1.142 起默认任务工具从 `TodoWrite`
       * 换成 `Task*`，而在 Opus 4.8 / Sonnet 5 等新模型上**任务跟踪工具不再默认包含**
       * （理由是「新模型没有显式清单也能很好地跟踪多步工作」且「工具定义占用上下文」）。
       *
       * 为什么**常开**：评测口径要求三家一致（codex 走 `tools.update_plan.enabled`、dsh 默认就开）。
       * 缺了它 `task` 族在 claude 侧恒为空，「有没有规划」会变成**配置差异而非能力差异**。
       * A/B 实测（本机 claude 2.1.281，同一二进制）：不开 26 项工具、开了 30 项，
       * **精确新增** `TaskCreate`/`TaskGet`/`TaskList`/`TaskUpdate` 四项（`TodoWrite` 并未回来）。
       */
      CLAUDE_CODE_ENABLE_TODO_TOOLS: '1',
    },
  });
  const cwd = canonicalCwd(input.cwd);
  // 权限档（见 `permission.ts`）：执行阶段要真能改代码、评分阶段只读。
  // ⚠️ `full` 的两项**必须成对**给：`permissionMode: 'bypassPermissions'` 少了
  // `allowDangerouslySkipPermissions: true` 就静默失效（SDK 把两者拼成两个独立 argv，
  // 类型面也写着「Must be set to true when using …」）——那正是 p6 冒烟里 claude 全部 0 改动的形状。
  const permission = CLAUDE_PERMISSION_OPTIONS[input.permission];
  const model = modelForClaudeCode(input.route.modelId, input.route.contextWindow);
  const query = sdk.query({
    prompt: input.prompt,
    options: {
      cwd,
      env,
      model,
      ...permission,
      // 结构化输出按需带：`undefined` / `null` 时**一个字段都不加**（候选阶段与文本评分的行为逐字不变）。
      // 为什么把 `null` 与「没给」归为同一格（R27，与 codex `providers/codex/index.ts` 的口径逐字同一）：
      // `null` 在这条路径上就是「没给」，而 `schema: null` 会把一个**假值**当成有效值透给 SDK 的
      // `outputFormat`——在本侧封住它，而不是等它在 CLI 侧变成一次难查的失败。
      ...(input.outputSchema === undefined || input.outputSchema === null
        ? {}
        : { outputFormat: { type: 'json_schema' as const, schema: input.outputSchema } }),
      // 思考强度按需带（spec §6.4 / D13）：`undefined` 时一个字段都不加，让模型用自己的默认档
      ...(input.effort === undefined ? {} : { effort: input.effort }),
      settingSources: [...CLAUDE_SETTING_SOURCES],
      disallowedTools: disallowedToolsFor(input.route.modelId),
      /**
       * **子智能体的文本与思考也要拿到**（spec §6.4.2，2026-09-30 真机 A/B）。
       *
       * 官方逐字："Forward subagent text and thinking blocks as assistant/user messages with
       * `parent_tool_use_id` set. **By default, only tool_use/tool_result blocks from subagents
       * are emitted (enough for a heartbeat counter).**"
       *
       * 真机差集（同一提示词各跑一次）：不开时子智能体消息 5 条、块类型只有 `text:1` +
       * `tool_use/tool_result`；开了之后 10 条、**多出 `thinking:3` 与 `text:3`**。
       * ⇒ 不开的话，"子智能体说了什么/想了什么"**全都看不到**，派发面板只能显示工具流水。
       *
       * 与 `parent_tool_use_id` 的分工：那一格（我们自己按 `parent_tool_use_id` 分侧链）
       * 决定**归属**，这一格决定**内容**。两者都要，缺一不可。
       */
      forwardSubagentText: true,
      /**
       * 本次路由的**第二道落点**：flag 档（等价 CLI 的 `--settings`），合并优先级高于 project / local。
       *
       * 为什么必需：上面打开了 `settingSources`，而被测仓库自带的 `.claude/settings.json` 就在
       * `project` 档里——它的 `env` 块会盖掉子进程环境注入的 base URL 与密钥。本机实测
       * （CLI 2.1.281，三档回环对照，判据是 TCP 命中 + 请求体）：
       *   · 只开 `settingSources`：14 次 `/v1/messages` **全部**打到仓库指定的地址、带仓库指定的密钥；
       *   · 补上本格：14 次全部回到本次路由；`settingSources: []`（旧口径）同样回到本次路由。
       * 层级（低→高）实测为 user < project < local < flag ⇒ 这一格管得住仓库那两个档，且不影响
       * `CLAUDE.md` 与仓库其余配置照常加载。
       *
       * 为什么只钉这三个键：它们才是「本次路由」（§5.6.4）。`model` 不必钉——实测仓库 settings 里的
       * `model` 键抢不过 `options.model`（请求体里的 model 始终是本次选的）。
       */
      settings: {
        env: {
          ANTHROPIC_BASE_URL: baseUrl,
          ANTHROPIC_API_KEY: input.route.apiKey,
          ANTHROPIC_AUTH_TOKEN: input.route.apiKey,
        },
      },
      abortController: controller,
      // **刻意不给 `maxTurns`**（用户口径，2026-09-28「执行不限时间、评分不限轮次和时间」）：
      // 这个选项是「最大 API 往返次数」，不给就是不限。原来写死 60，实测把一次 60 次往返的
      // 评测正好截在 60 上（`error_max_turns` 收场）——那是本仓自己的上限，不是模型跑飞了。
      // 唯一能停下这一行的仍是 `signal`（用户点「终止」）与模型自己收场。
    },
  });
  logger.debug('claude-code 已注入路由并启动查询', {
    // `model` 是**真正传给 CLI 的名字**（可能带 `[1m]` 后缀），排障要看的就是它；
    // `declaredModel` 是业务身份（供应商清单里的那一条）——两者不同时才说明后缀生效了。
    model,
    declaredModel: input.route.modelId,
    contextWindow: input.route.contextWindow,
    effort: input.effort,
    baseUrl: env.ANTHROPIC_BASE_URL,
    cwd,
  });
  return {
    stream: query,
    interrupt: () => {
      // 吞掉 rejection（p6 实测 14 次 `unhandledRejection: Query closed before response received`）：
      // `void` 不挂 handler，而全仓没有 unhandledRejection 处理器 ⇒ SDK 一旦拒绝就是打崩进程
      // （Node 默认 `--unhandled-rejections=throw`）。这与 codex 的 `closeRunStream` 同形修法：
      // 这是释放路径的第一步，失败不该改变本次运行的结论，也不该升级成进程级事故——
      // 后面的 `dispose()`（controller.abort）才是硬回收，它照常执行。
      void Promise.resolve(query.interrupt?.()).catch(() => {});
    },
    // dispose 是硬回收：abort 让 SDK 杀掉仍在跑的子进程；interrupt 已被尊重时这一步是空操作
    dispose: createDisposer(() => {
      controller.abort();
    }),
    /**
     * 投影一条 SDK 消息：**事件**（行级审计与活动行）与**消息**（内容级视图，spec v3 §2）并行产出。
     *
     * 两条通道**各自**判定是否认得这条消息：事件侧认不出时落一条保留原始负载的日志，
     * 消息侧认不出时一条都不产出。共享的只有 `state.seen` 的去重意图——但**去重键不同**
     * （事件侧按 `uuid` 去重、消息侧按内容块归并），所以两处各自维护，互不代劳。
     */
    project: (raw, state) => {
      const projection = projectClaudeMessage(raw, state, { kind: 'claude-code', baseUrl: input.route.baseUrl });
      const normalized = messages.normalize(raw, state);
      return {
        ...projection,
        messages: normalized.messages,
        subagents: normalized.subagent === null ? [] : [normalized.subagent],
      };
    },
  };
}

export const claudeCodeProvider: AgentProvider = {
  kind: 'claude-code',
  displayName: 'Claude Code',
  metadata: {
    // 只讲一条 wire（Agent SDK 打 Anthropic Messages）⇒ 集合只有一个元素
    protocolTypes: ['anthropic'],
    // liveUsage: 'estimated' —— 跑动期的 usage 事件是按 assistant 消息累加出来的**估算**
    // （SDK 只在 result 消息上给结算值，见 events.ts 的 liveUsageDraft）：界面看得到，但不回写快照
    // structuredOutput: true —— SDK 的 `outputFormat` 能带 JSON Schema（原生 schema 开关），
    // 返回形状由 CLI 侧约束，而不是靠提示词里写「请只输出 JSON」；落点在 Task 3
    capability: { cancelMidTurn: true, usage: true, liveUsage: 'estimated', structuredOutput: true },
    /**
     * 消息能力声明（spec v3 §3.5）：这一家六格全 `'yes'`，唯一的代价是**子智能体轨迹的完整度**
     * 取决于 `forwardSubagentText`——默认只投送子智能体的 `tool_use` / `tool_result` 块，
     * 不开时子任务视图只剩工具流水（看不到「子智能体说了什么、想了什么」）。
     */
    messageCapability: {
      thinkingText: 'yes',
      thinkingTextKind: 'full',
      toolInput: 'yes',
      toolResult: 'yes',
      subagent: 'yes',
      streamingDelta: 'yes',
      thinkingTextSource: 'wire',
      thinkingTextReason: null,
      toolInputSource: 'wire',
      toolInputReason: null,
      toolResultSource: 'wire',
      toolResultReason: null,
      subagentSource: 'wire',
      subagentReason: null,
      streamingDeltaSource: 'wire',
      streamingDeltaReason: null,
      notes: [
        '流式增量只覆盖主会话（`stream_event` 的 `parent_tool_use_id` 恒为 null）：子智能体没有 token 级增量，子任务视图不做逐字动画',
        '子智能体的文本与思考块默认不转发（只投 `tool_use` / `tool_result`）⇒ 需要完整嵌套轨迹时开 `forwardSubagentText`',
        '`thinking_tokens` 这一格在第三方 anthropic 兼容后端上可能恒为 0：0 不得读成「这家不思考」',
      ],
    },
    // 档位域 = Agent SDK 的 `EffortLevel`（`Options.effort`）；`max` 是「select models only」，
    // 但那由模型侧决定，智能体这一层能收的就是这五档
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    isolation: 'subprocess',
  },
  run: (input: AgentRunInput): Promise<AgentRunResult> =>
    runTurn(input, { kind: 'claude-code', start: startClaudeCode }),
};
