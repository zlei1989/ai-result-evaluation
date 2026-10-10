/**
 * claude-code 适配器：注入路由 → 消费消息流 → 按 §5.6.6 释放。
 * 注意：
 *  - `run()` 的骨架由 `runTurn` 提供，本文件只负责厂商特有的三件事：注入、拿停止句柄、投影消息；
 *  - 输入的 `route` 只读，绝不写 `process.env`（§5.6.5 不变量 1/2）；
 *  - 禁用名单**随模型名分档**（2026-09-29）：`modelId` 含 `claude` 时放行 `WebSearch`，其余模型禁用
 *    （判据与理由见 `disallowedToolsFor`）；名单里另六项与模型无关，任何模型都禁；
 *  - `settingSources` 与 `settings` **必须成对给**（2026-09-29 口径变更，原为 `settingSources: []`）：
 *    打开 settings 才能读到被测仓库的 `CLAUDE.md` / 项目配置，而打开之后仓库自带的
 *    `.claude/settings.json` 的 `env` 块就能改写本次路由 ⇒ 用 `settings.env`（flag 档，
 *    优先级高于 project / local）把路由钉回去。两半分开做都会坏（见两个常量的注释）。
 */
import { realpathSync } from 'node:fs';
import { EFFORT_OFF, type SubagentRecord, type UsageTokens } from '@aieval/contracts';
import { createLogger } from '@aieval/core';
import { logDraft, type AgentEventDraft } from '../../emit';
import { asRecord, readString } from '../../json';
import { CLAUDE_PERMISSION_OPTIONS } from '../../permission';
import { createDisposer } from '../../release';
import { buildSubprocessEnv, stripV1Suffix } from '../../route';
import { runTurn, type TurnContext, type TurnStart } from '../../turn';
import type { AgentProvider, AgentRunInput, AgentRunResult } from '../../types';
import { addUsage } from '../../usage';
import { projectClaudeMessage } from './events';
import { createClaudeMessageNormalizer } from './message';
import { loadClaudeSdk } from './sdk';
import {
  createClaudeSubagentUsageCache,
  readClaudeSubagentFile,
  readClaudeSubagentUsage,
} from './subagent-usage';

const logger = createLogger('agents/claude-code');

/**
 * 与评测无关的旁路工具：**无条件**禁用（用户口径，2026-09-29）。
 *
 * 禁的不是「能力」而是旁路，逐条理由：
 *  - `CronCreate` / `CronDelete` / `CronList` / `ScheduleWakeup`：会话级定时唤醒——本产品的每一行
 *    跑完就 `dispose()`（§5.6.6），没有「以后」；留着只会让 CLI 在无人接续的会话里排定时任务；
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
 * ——§5.6.5 就记着「网关对这些命名空间工具回 400」（codex 侧因此无条件关掉 `web_search`，
 * 见 `buildCodexConfig`）。真正的 Claude 模型没这个顾虑，于是把这一格交给模型名决定：
 * 名单里其余六项与模型无关，任何模型都不放行。
 *
 * ⚠️ 判据是 `route.modelId` 的**子串**（大小写不敏感），不是白名单：网关侧形如
 * `anthropic/claude-sonnet-4-6` / `jd/Claude-4.5` 的写法都算「Claude 模型」。
 */
const NON_CLAUDE_DISALLOWED_TOOLS: readonly string[] = ['WebSearch'];

/** 关闭思考的档名（契约与界面统一用 `off`；这一家翻成 `thinking: { type: 'disabled' }`） */
const CLAUDE_OFF_EFFORT = EFFORT_OFF;

/**
 * 关闭档的 **body 覆盖层**（spec §3.1）：CLI 直读 `process.env` 的这个名字，把它的值当作 JSON
 * 摊进请求体，且摊开的位置在 `thinking` **之后** ⇒ 可以覆盖。
 *
 * 为什么需要它（真机 A/B，CLI 2.1.281）：CLI 对「它不认识的模型名」会判定
 * `rejects_disabled_thinking`（stderr：`[claude-code:unrecognized_model] {"model":"deepseek-flash"}`），
 * 于是**故意**不把 `thinking:{type:'disabled'}` 写进请求体 —— 这是有意行为，不是漏读。
 * 而网关本身**认**这个字段（直连同一端点实测：不带 ⇒ 292 字思考块，带 ⇒ 无思考块）。
 *
 * ⚠️ 值**必须**由 `JSON.stringify` 生成（见 `CLAUDE_OFF_EXTRA_BODY`）：CLI 对**非法 JSON 静默忽略
 * 整条**（不报错、思考照旧）。
 */
export const CLAUDE_CODE_EXTRA_BODY = 'CLAUDE_CODE_EXTRA_BODY';

/**
 * 关闭档的注入值。用 `JSON.stringify` 而不是手写字面量，两个理由：
 *   1. **由构造保证合法 JSON**：CLI 对非法值静默忽略整条（真机上 PowerShell 5.1 吃掉内层双引号，
 *      env 变成 `{thinking:{type:disabled}}`，那次 A/B 的 B 臂整条作废）；
 *   2. 逐字节等于真机 A/B 已验证过的那一形态 `{"thinking":{"type":"disabled"}}`（无空格、键序一致）。
 */
const CLAUDE_OFF_EXTRA_BODY = JSON.stringify({ thinking: { type: 'disabled' } });

/**
 * 本次要**额外注入**的环境变量：**只有**关闭档给一条，其余档位与未选给**空对象**。
 *
 * ⚠️ 为什么返回空对象而不是 `{ [KEY]: undefined }`（spec §3.1 约束 1）：`route.ts:94-96` 的语义是
 * 「值为 `undefined` 的键会被**删掉**」⇒ 后者会在非 off 档删掉**宿主继承来的**同名变量，
 * 那是「改变其它档位的行为」，与本次改动的硬约束冲突。
 *
 * 抽成导出的**纯函数**是为了可测：`recorder.env` 是「宿主 + 注入」合并后的对象，
 * 拿它断言「键不存在」在宿主设过同名变量时会假红（spec §5.1.1）。
 */
export function claudeExtraEnvFor(effort: string | undefined): Record<string, string> {
  return effort === CLAUDE_OFF_EFFORT ? { [CLAUDE_CODE_EXTRA_BODY]: CLAUDE_OFF_EXTRA_BODY } : {};
}

/**
 * 会让 `off` 的修复**静默失效**的宿主环境变量（spec §5.1.1）。
 *
 * 它是 CLI 侧那道闸门的**条件位**：一旦被设，body 覆盖层不再生效 —— 而它由宿主环境继承
 * （`route.ts:88-90` 以 `process.env` 为底）。我们不能替宿主清掉它（那要动 `route.ts` 的合并语义，
 * 属于「改变其它档位的行为」），能做的是**不要静默**：见 `hostDisablesBetas`。
 */
export const HOST_DISABLE_BETAS_ENV = 'CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS';

/**
 * `off` 档那条 WARN 的**文案模板**（spec §5.1.1，**逐字照抄、不许改写**）。
 * 全句唯一可变 token 是 `<键名原文>`（= `hostDisablesBetas` 回报的那个拼写），其余字符逐字；
 * 句式是**确定性陈述**：不许改写成疑问句、不许出现「可能」。
 *
 * ⚠️ 导出（只读）是**为了测试能逐字比对**：让用例自己再抄一份正文，改口径时必然漏掉一处
 * ——那正是本仓最忌讳的「两份必然漂移」。
 */
export const CLAUDE_OFF_DISABLED_WARNING_TEXT =
  'off 档的关闭被静默忽略：子进程环境里存在 <键名原文>，它使 CLAUDE_CODE_EXTRA_BODY 的 body 覆盖失效，本次运行的 off 档读数作废；处置：从运行环境里去掉该变量后重跑，或改用别的方式关闭思考。';

/**
 * 拼出本次要落的那条 WARN（模板 + **实际命中的那个拼写**；`logger.warn` 的第一个参数，不 `JSON.stringify`）。
 * 做成函数而不是常量：`<键名原文>` 要换的是 `hostDisablesBetas` 回报的**原拼写**，
 * 而在模块加载期把它写死成 `HOST_DISABLE_BETAS_ENV` 会在宿主写成小写时**报错名字**（正是 §5.1.1 ② 要防的）。
 */
function claudeOffDisabledWarning(variable: string): string {
  return CLAUDE_OFF_DISABLED_WARNING_TEXT.replace('<键名原文>', variable);
}

/**
 * `off` 档的前置条件判据（**纯函数**，spec §5.1.1 的判据三件套）：`off` 档且合并后的宿主 / 子进程
 * 环境里**存在** `HOST_DISABLE_BETAS_ENV` ⇒ 返回**宿主用的那个键名原文**；否则 `null`。
 *
 * 三个细节都是判据的一部分（每条都有一个具体的失败形状）：
 *   ① `effort` 也必须进判据（**只在 `off` 档看**）：其余档位与未选**连一条日志都不多**，
 *      否则就违反了「其余档位逐字不变」（§1.3 约束 2）——那是**新增的输出**，同样算改变行为；
 *   ② 看的是**存在**（`!== undefined`）而不是真值：宿主可能写 `true` / `1` / 空串，三种都会让
 *      覆盖层失效；窄成 `=== '1'` 就会出现「宿主设了、我们一声不吭」（变异体⑩）；
 *   ③ 键名**大小写不敏感**查找、并**回报原拼写**：`route.ts:76-84` 记着「逐项保留宿主的键名形态」
 *      （Windows 的环境块常写 `Path`），只认一种拼写会漏报（变异体⑨）。
 *
 * 抽成导出的纯函数是为了可测：直接读 `process.env` 的判据没法在用例里确定性地摆出这几种形态
 * （`recorder.env` 是「宿主 + 注入」的合并对象，拿它断言在宿主设过时必然假红，见 §5.4 第 3 条）。
 */
export function hostDisablesBetas(
  hostEnv: Record<string, string | undefined>,
  effort: string | undefined,
): string | null {
  // ① 只在关闭档看
  if (effort !== CLAUDE_OFF_EFFORT) return null;
  // ②③ 大小写不敏感地找第一个命中的键名，并**原样**返回它
  for (const key of Object.keys(hostEnv)) {
    if (key.toLowerCase() !== HOST_DISABLE_BETAS_ENV.toLowerCase()) continue;
    if (hostEnv[key] !== undefined) return key;
  }
  return null;
}

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
 * 适配器把 `HOME` / `USERPROFILE` / `CLAUDE_CONFIG_DIR` 全指向本行的 `.agenthome`（§5.6.5 不变量 3），
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
  // 该 SDK 自己追加 /v1/messages：留着尾部 /v1 会变成 /v1/v1/messages（§5.6.5）
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
      // 关闭档的覆盖层（spec §3.1）：**条件展开成空对象**，非 off 档注入键集合逐字不变。
      // 为什么不直接在键上写 undefined：`route.ts:94-96` 会把 undefined 的键**删掉**，
      // 于是非 off 档会顺手删掉宿主继承来的同名变量。
      ...claudeExtraEnvFor(input.effort),
    },
  });
  /**
   * `off` 档的前置条件核对（spec §5.1.1，控制者裁定加）：宿主若设过 `HOST_DISABLE_BETAS_ENV`，
   * 上面那条 body 覆盖层**不会生效**（CLI 侧闸门的条件位），而这件事在结果里看不出来
   * （思考照旧、不报错）⇒ 至少要在日志里点一句名：**本次运行的 `off` 档读数作废**。
   *
   * 判据用**合并后**的 `env`（= 真的交给 CLI 的那一份），不是裸 `process.env`：覆盖层与这个变量
   * 都只在子进程环境里起作用，读同一份才不会有第二次翻译。
   *
   * ⚠️ **它是观测，不是拦截**：不许抛错、不许跳过这一行、不许因此改动注入、不许删改宿主那个变量
   * ——WARN 之后的行为与没有它时**逐字相同**（`injected` 在上面已经构造完，这里只读不写）。
   * 就地判一次 ⇒ 一次运行至多一条 WARN（`startClaudeCode` 每次运行只跑一次），不刷屏。
   */
  const betasVariable = hostDisablesBetas(env, input.effort);
  if (betasVariable !== null) {
    // 文案逐字来自 CLAUDE_OFF_DISABLED_WARNING_TEXT（spec §5.1.1：唯一可变 token 是键名原文）；
    // context 固定为 `{ variable, effort }`，作为 console 的**第二个参数**透传（不 JSON.stringify）
    logger.warn(claudeOffDisabledWarning(betasVariable), { variable: betasVariable, effort: input.effort });
  }
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
      // 思考强度（spec §6.4 / D13；2026-10-06）：未选 ⇒ 两个键都不加（沿用 SDK/模型默认，
      // 实测这一家的「不传」是会思考的）。显式 `off` ⇒ 走 `thinking` 的关闭档，**effort 不传**
      // （off 不在 SDK 的 `EffortLevel` 值域里，传下去会让 CLI 校验失败）。
      ...(input.effort === undefined || input.effort === CLAUDE_OFF_EFFORT ? {} : { effort: input.effort }),
      ...(input.effort === CLAUDE_OFF_EFFORT ? { thinking: { type: 'disabled' as const } } : {}),
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
       * 流式增量（2026-10-09，spec v3 §3.5 兑现「`streamingDelta: 'yes'`」的声明）：
       * 开了它 wire 上才会出 `stream_event`（text/thinking/signature 三种 delta），`streamEvent`
       * 把它们投影成 `chunk: 'delta'` 的消息——编排层**只广播不落盘**（`messages.jsonl` 仍由快照独占）。
       * 只覆盖主会话（`parent_tool_use_id` 恒 null）；真机探针见 `probe/v4/claude-official-remedies.mjs` ②。
       */
      includePartialMessages: true,
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
       * 为什么只钉这三个键：它们才是「本次路由」（§5.6.5）。`model` 不必钉——实测仓库 settings 里的
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
  /**
   * 本行**形状像一次派发**的子智能体 id（R19：不是「见过 `task_id` 就算」，见 `project` 里的登记点）
   * 与 `system/init` 回显的 **session id**：收尾读子智能体会话文件时，这两个是定位它所需的全部信息。
   */
  const subagentIds = new Set<string>();
  /**
   * 本行**只见到收场帧**的 task id（`'unjudged'`，2026-10-05 复核裁定）——与 `subagentIds` 是**两份名单**：
   * 这一份**不要求有转录**（判不了 ≠ 没采到），只在收尾落一条「可能少算它」的 WARN（见 `finalize`）。
   */
  const unjudgedTaskIds = new Set<string>();
  let sessionId: string | null = null;
  /**
   * 子任务行的**账**：本行每一个子智能体**最后一次交出去的那一条**（`taskId` → 记录），
   * 由 `project` 每收到一条子任务记录就登记一次；收尾把它们连**最终用量**重新交一次
   * （覆盖累积按 `subagentId`，读侧只留最后一条）。
   *
   * 为什么要按 id 各存一条、而不是留一个累计值：收尾那次重交是**逐条**的，而「全部子智能体加起来」
   * 那个和在收尾会整格变成 `null`（有一个读不到就不给部分和）⇒ 拿它当单条的读数会把别的子智能体的
   * 花费算到这一条头上。
   *
   * ⚠️ **`running`（派发）帧也要登记**（2026-10-06 修）：改前那一档**提前返回、什么都不记** ⇒
   * **没有终态通知**的子智能体（CLI 没投送 `task_notification` / 运行被中断）在收尾那一批里
   * 根本不存在，于是它的 `SubagentRecord.usage` 永远是 `null`（子任务条显示「用量未采集」），
   * 哪怕转录就在盘上、读得动。改动前这一档被「子会话逐轮读数」那批事件**顺带**盖住了，
   * 而那批事件本次已删除 ⇒ 这个缺口必须在这里补上。
   * **终态优先**：已收场的记录不被后到的 `running` 帧盖回「运行中」（真机顺序是 started → notification，
   * 这里只是不让乱序把一条带用量的记录盖掉）。
   */
  const lastSubagentRecordById = new Map<string, SubagentRecord>();
  /**
   * 本行「**同一版本的文件只解析一遍**」的缓存
   * （spec `2026-10-01-agent-message-spec-design-v3.md` §4.1 步骤 5.1 的「读法四条」）。
   *
   * 一次运行里每份转录会读两次：① `finalize` 的**合计读**（`readClaudeSubagentUsage`，枚举会话目录）
   * 与 ② 同一处的**逐个子智能体读**（`finalSubagents`）。②要的是**收尾那一刻的全量**（CLI 边跑边追加），
   * 而两份读的是同一批文件 ⇒ 用同一个缓存：**版本没变就直接复用（这就够了，内容与真读完全一致）；
   * size / mtimeMs 一变就重读**，所以「要全量」这条不会被缓存破坏。
   * ⚠️ 刻意**不是模块级**：那会把上一次运行解析出来的读数留在进程里（见 `ClaudeSubagentUsageCache`）。
   */
  const subagentUsageCache = createClaudeSubagentUsageCache();
  /**
   * 单个子智能体的读数（**只在收尾**的那一批里用）。
   *
   * ⚠️ **只读盘、不编造**：读不出来就返回 `null`，调用方原样留着那一格的 `null`（＝如实说「没采到」），
   * 绝不退回 `task_notification.usage`——官方那一格是**另一种形状**（`total_tokens` / `tool_uses` /
   * `duration_ms`），凑不出契约的三项（见 `message.ts` 的 `subagentRecord`）。
   */
  const usageOfSubagent = (taskId: string): SubagentRecord['usage'] =>
    readClaudeSubagentFile({ configHome: input.configHome, sessionId, taskId, cache: subagentUsageCache })?.usage
    ?? null;
  /** 主会话的**权威结算值**（`result.usage`）：收尾把子智能体那一份加在它上面 */
  let mainTokens: UsageTokens | null = null;
  /** 主会话的轮次（同一理由：收尾在投影循环之外，只能自己镜像一份） */
  let mainTurns: number | null = null;

  /**
   * 登记一条子任务记录（**原样交出去**，收尾那批再连最终用量重交一次）。
   *
   * ⚠️ **这里不读盘**（2026-10-06 用户裁定）。改动前会在**终态通知**到达时读一次，好让界面早一点有数；
   * 而收尾本来就会重读一遍、最终值完全一致 ⇒ 那一读只是把「用量未采集」提前几分钟结束，
   * 代价却是每个子智能体多一次全量读盘（CLI 那份转录会随运行一直长）。
   * **代价如实登记**：子智能体收场到收尾之间，子任务条那一格显示「用量未采集」——
   * 终态值由收尾那条路保证（`turn.ts` 的 `finally`，正常 / 失败 / 被终止都会跑）。
   */
  const rememberSubagent = (record: SubagentRecord): SubagentRecord => {
    const previous = lastSubagentRecordById.get(record.subagentId);
    // 终态优先：`running` 帧只在该 id 还没有任何记录时登记（不让后到的派发帧盖掉一条带用量的记录）
    if (previous === undefined || record.status !== 'running') lastSubagentRecordById.set(record.subagentId, record);
    return record;
  };

  /**
   * 收尾重交子任务行：**每一条都用「现在这一次读盘」的读数**。
   *
   * 那是每一个子智能体**唯一**的一次读盘（改动前在终态通知上还读过一次），也是
   * 「每个 subagent 的最终用量」这一格的全部来源：
   *   · 名单 = 本行登记过的**全部**子任务（含只见到派发帧的——它们的终态通知没来，改前会被漏掉）；
   *   · 现读失败时回落到记下的那一条（它至少是「当时」的真实读数），仍没有就交 `null`——不猜。
   */
  const finalSubagents = (): SubagentRecord[] =>
    [...lastSubagentRecordById.values()].map((record) => {
      const usage = usageOfSubagent(record.subagentId);
      // 现读不出来 ⇒ 保留记下的那一条（连同它当时的 `usage` 与 `source`）
      if (usage === null) return record;
      return { ...record, usage, source: 'session-file' };
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
    /**
     * dispose 是硬回收：abort 让 SDK 杀掉仍在跑的子进程；interrupt 已被尊重时这一步是空操作。
     *
     * ⚠️ **这一类是「SDK 代 spawn」**：CLI 子进程由厂商 SDK 自己拉起，公开面**不暴露它的 pid**
     * （`sdk.d.ts` 里那个 `pid` 属于 MCP stdio transport，不是 CLI），本仓因此拿不到整棵树，
     * 只能走 SDK 自己的硬停止通道 ⇒ 进程树回收是**尽力**，不是保证。归属与残留风险登记在
     * 《厂商进程生命周期规范》的归属表里；行产物清理不假设它一定干净（core 的 `removeTreeWithRetry`）。
     * 对照：codex 由本仓自己 spawn（`appserver/client.ts`），那一家的 `close()` 必须**整棵回收 + 等退出**。
     */
    dispose: createDisposer(() => {
      controller.abort();
    }),
    /**
     * **收尾交一次子智能体那一份**（2026-10-04，spec §2.3 / §2.4）。
     *
     * 为什么读盘、且为什么放在收尾：子智能体的权威用量只存在于 CLI 自己写的
     * `<configHome>/projects/<项目>/<sessionId>/subagents/agent-<agentId>.jsonl` 里
     * （流式侧链快照的 `output_tokens` 在这个网关下恒为 0，见 `subagent-usage.ts` 的文件头），
     * 而那份文件是 CLI **边跑边追加**的 ⇒ 收尾这次读到的才是「已经落盘的全部」。
     * 收尾每次运行都跑（正常 / 失败 / 被终止都在 `turn.ts` 的 `finally` 里），
     * 于是**终态值必定齐**（§2.4：终态不齐就是缺陷）。
     *
     * 三条口径：
     *   · **「全量或 null」**（§2.2）：**有一个转录文件读不动**（2026-10-05 起：判据是「目录里枚举出来的
     *     转录都得读得动」，不再是「事件流的每个 id 都要有同名文件」——事件流里混着 CLI 的非 Agent
     *     task 条目，它们本来就没有转录）⇒ 分量交 `null`，合计**退回主会话口径**（`addUsage(main, null)`
     *     = `main`），并落一条**点名**读不动那些的 WARN——绝不把部分和冒充总数；
     *   · **R2**：这一格是**显式 `null`**（不是键缺省）⇒ 覆盖。读失败时必须能清掉上一版那个
     *     偏大的分量，否则它与「已退回主会话口径」的合计一起破坏 `subagentTokens ≤ tokens`；
     *   · **合计与分量同生共死**（2026-10-04 收尾评审 Important 2）：拿不出合计时（`mainTokens === null`
     *     —— 这一行**一条 `result` 消息都没等到**就被中断 / 失败，而 `result` 正是 CLI 的收尾消息）
     *     分量交**显式 `null`**，绝不单独交出一个「有分量、没合计」的形状：消费方按
     *     「主会话 = 合计 − 分量」推导，缺了合计那一格这个减法**没有被减数**，
     *     而两格各自看起来都正常（codex 为同一形状做了同一个选择，见 `providers/codex/index.ts` 的 finalize）；
     *   · **轮次**（§2.1）= 主会话轮次 + 各子智能体轮次之和。与 `tokens` 同一条「加零是恒等」：
     *     没有子智能体、或子智能体一次往返都没有时，交回的仍是主会话那个数（**同一个值**）；
     *     而**主会话一次往返都没数到**时这一格**不交**（保持骨架里的 `null`）——
     *     交一个 `0` 就是「采到了 0 轮」，正是「计量绝不填 0」那条硬口径要防的
     *     （与 codex 的 `lastTurns === null ? null : …` 同一判据）。
     *   · **轮次那一格的分量**（`subagentTurns`，2026-10-04 / T1b）：子轮次 = **各子智能体文件里
     *     `message.id` 去重后的个数之和**（`readClaudeSubagentUsage` 的 `turns`——与用量同一次
     *     读盘、同一个「全量或 null」判据）。它与合计**成对**交出去（见下面 `subagentTurns` 的注释）。
     *   · **只交最终用量**（2026-10-06 用户裁定）：这里**不再**发任何带会话身份（`turn.subagentId`
     *     非空）的逐轮 `usage` 事件——那批读数要按轮拆转录文件，成本与收益不成比例，而界面要的只是
     *     「主会话 + 每个子智能体各花了多少」的**最终值**：主会话走事件流、每个子智能体走
     *     `SubagentRecord.usage`（`finalSubagents()` 在收尾把它们连最终用量重交一次）。
     *     ⇒ claude 这一家的事件流里 `turn.subagentId` **恒为 `null`**（与 codex 同形）。
     */
    finalize: () => {
      const read = readClaudeSubagentUsage({
        configHome: input.configHome,
        sessionId,
        subagentIds: [...subagentIds],
        unjudgedIds: [...unjudgedTaskIds],
        cache: subagentUsageCache,
      });
      const drafts: AgentEventDraft[] = [];
      if (read.missing.length > 0) {
        drafts.push(logDraft('stderr', `[WARN] 读不到子智能体 ${read.missing.join('、')} 的会话文件，这一行的 tok / 缓存命中 / 轮次**不含**它们（不编造）`));
      }
      /**
       * **判不了的条目点一句名，但不改两格**（2026-10-05 复核裁定，`subagent-usage.ts` 的**规则⑤**）。
       *
       * 只见到收场帧的 task 条目（`'unjudged'`）而盘上没有它的转录：我们**无法判定**它是不是子智能体
       * ——说它是（`null` + 「读不到子智能体」）会把一条幻影的代价转嫁给真子智能体，
       * 说它不是（`{0,0,0}` 且一声不吭）则可能在**静默少算**。取第三条：**照算，并说清楚可能少算了谁**。
       * ⚠️ 文案**刻意不叫它子智能体**（R19 的教训：那条真机条目就是子智能体里跑的一条 Bash）。
       * ⚠️ 编号与 spec §3 **#19** ⑤ 是同一条规则（2026-10-05 复核 Item 1：规则表已按 #19 的 ⑤⑥⑦ 对齐）。
       */
      if (read.unjudged.length > 0) {
        drafts.push(
          logDraft(
            'stderr',
            `[WARN] 只见到收场帧的 task 条目 ${read.unjudged.join('、')} 没有转录：这一行的 tok / 缓存命中 / 轮次可能少算它（无法判定它是不是子智能体）`,
          ),
        );
      }
      // 「全量或 null」：子那一份没读全 ⇒ 合计退回主会话口径（spec §2.2）
      const combined = addUsage(mainTokens, read.usage);
      const turns = read.turns === null || mainTurns === null ? null : mainTurns + read.turns;
      /**
       * 轮次那一格的**分量**：与合计 `turns` **成对**交出去，判据逐字同构于 `subagentTokens`。
       *
       *   · **全量或 null**：`read.turns` 是各子智能体文件去重后的个数之和，有任何一个读不到就是
       *     `null`（all-or-null 在 `readClaudeSubagentUsage` 里）⇒ 分量 `null`，绝不拿读到的那些的
       *     **部分和**冒充总数（它与全部读完的和在界面上长得一模一样）；
       *   · **合计与分量同生共死**：`turns === null`（主会话一次往返都没数到、或子那一份读失败）时
       *     分量也必须是 `null`——那一刻消费方按「主会话 = 合计 − 分量」推导，这个减法**没有被减数**，
       *     而两格各自看起来都正常（codex 为同一形状做了同一个选择，见 `providers/codex/index.ts`）；
       *   · 判据**复用已经算好的 `turns`**，不另造第二个谓词：否则会出现「结果是 `null`、日志里
       *     点不出人」这种漂移。顺带让这一条与合计口径的未来变更解耦——合计将来若在「子那一份
       *     读失败」时改成退回主会话口径，`read.turns` 自己仍是 `null`，分量照旧 `null`。
       *
       * ⚠️ **运行期不交这一格**（与用量那一格同一个落点：整个 claude 适配器只在收尾读盘）：
       * 跑动期的 `turns` 是**主会话口径**（`events.ts` 的 `countModelRoundTrip` 按
       * `parent_tool_use_id` 直接退出），交一个子那一份出去，界面按「主会话 = 合计 − 分量」算出的
       * 是**负数**（真机形状：主会话 1 轮派活、子智能体跑 2 轮）⇒ `subagentTurns ≤ turns` 当场被破坏。
       * 收尾这一条把两格一起给（spec §4 R17，与 codex 同一档）。
       */
      const subagentTurns = turns === null ? null : read.turns;
      /**
       * 行级**用量分量**：**先取出来**再进返回对象——就地写两遍判据必然漂移，
       * 而漂移的表现是「事件里的分量与结果里的分量不一样」，界面与 run.json 各说各话。
       * 判据与改动前**逐字相同**（`combined === null ? null : read.usage`）：合计拿不出来时分量也是显式
       * `null`，绝不单独交出一个「有分量、没合计」的形状（见上面那条口径与 `TurnFinalize` 的注释）。
       */
      const rowSubagentTokens = combined === null ? null : read.usage;
      return {
        drafts,
        ...(combined === null ? {} : { tokens: combined }),
        // 分量与合计**同生共死**：合计拿不出来（没有任何 result）时分量也是 null，绝不单独交分量
        subagentTokens: rowSubagentTokens,
        ...(turns === null ? {} : { turns }),
        /**
         * 轮次那一格的分量：这里是**显式** `null`（不是键缺省）⇒ 读失败 / 合计拿不出来时覆盖成
         * `null`，清掉任何一版偏大的分量（R2 的不对称见 `TurnFinalize.subagentTurns` 的注释）。
         */
        subagentTurns,
        subagents: finalSubagents(),
      };
    },
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
      const rawRecord = asRecord(raw);
      if (sessionId === null && readString(rawRecord, 'subtype') === 'init') {
        sessionId = readString(rawRecord, 'session_id');
      }
      const subagent = normalized.subagent === null ? null : rememberSubagent(normalized.subagent);
      /**
       * **只有「形状像一次派发」的 id 进这份事实核对名单**（spec §4 **R19**，2026-10-05 裁定）。
       *
       * 为什么不能像原先那样「见到 `task_id` 就登记」：CLI 给**非 Agent 的后台任务**也发 `task_started`
       * （真机：子智能体自己跑的那条带 `description` 的 Bash），那一条**永远没有转录**。登记进来之后，
       * 收尾就会多喊一句「读不到子智能体 `bey1yc1n7`」——把一条 Bash 命令叫成子智能体；而那一行的正解是
       * `{0,0,0}`（同一个 `readNothing` 的另一个出口：**事件流没报过形状像派发的东西** ⇒ 确实没有子智能体，
       * 一句 WARN 都不该有）。
       *
       * 判据与记账只有一处：`message.ts` 的 `ClaudeTaskShape` / `classifyTask`。读的是**那一帧的判决**
       * （收场帧按同一个 id 的 `start` 帧追随），不是这一帧自己的字段。
       */
      if (subagent !== null && normalized.taskShape === 'dispatch') subagentIds.add(subagent.subagentId);
      // 另一份名单：**判不了**的那些（只见到收场帧）——它们只在收尾点一句「可能少算」（见 `finalize`）
      if (subagent !== null && normalized.taskShape === 'unjudged') unjudgedTaskIds.add(subagent.subagentId);
      // 只记**权威值**（非估算）：`tokensEstimated` 为真的是跑动期估算，与骨架 `tokens` 的判据同源
      if (projection.tokens !== null && projection.tokensEstimated !== true) mainTokens = projection.tokens;
      if (projection.turns !== null) mainTurns = projection.turns;
      return {
        ...projection,
        messages: normalized.messages,
        subagents: subagent === null ? [] : [subagent],
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
    // structuredOutput: true —— SDK 的 `outputFormat` 能带 JSON Schema（原生 schema 开关），
    // 返回形状由 CLI 侧约束，而不是靠提示词里写「请只输出 JSON」
    capability: { cancelMidTurn: true, usage: true, structuredOutput: true },
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
        '子智能体的文本与思考块**厂商默认 `false`**（默认只投 `tool_use` / `tool_result`）；**本适配器已置 `true`**（`query()` 的 `forwardSubagentText`）⇒ 嵌套轨迹是完整的，别按厂商默认反推成「我们没开」',
        '`thinking_tokens` 这一格在第三方 anthropic 兼容后端上可能恒为 0：0 不得读成「这家不思考」',
      ],
    },
    // 档位域 = Agent SDK 的 `EffortLevel`（`Options.effort`）**加上**本仓统一的关闭档
    // `off`（它走 `thinking: { type: 'disabled' }`，不是 `effort` 的取值）；`max` 是
    // 「select models only」，但那由模型侧决定，智能体这一层能收的就是这些
    reasoningEfforts: [EFFORT_OFF, 'low', 'medium', 'high', 'xhigh', 'max'],
  },
  run: (input: AgentRunInput): Promise<AgentRunResult> =>
    runTurn(input, {
      kind: 'claude-code',
      // 能力从自己的 metadata 转发（骨架不反查注册表）：改 metadata 就是改这里的行为，两处同源
      capability: { structuredOutput: claudeCodeProvider.metadata.capability.structuredOutput },
      start: startClaudeCode,
    }),
};
