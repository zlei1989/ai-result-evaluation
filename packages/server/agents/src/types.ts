/**
 * agents 包对外的全部类型契约。
 * 三条注意：
 * 1. `AgentKind` / `AGENT_KINDS` 的真源在 `@aieval/contracts`：contracts 不能反向
 *    依赖 agents，而 `EvalCandidate.agentKind` 与前端下拉又必须与注册表同源，故这里只做**再导出**；
 * 2. `ProtocolType` 明写「此处重复声明」——只为两个字符串引入一条依赖不划算，
 *    它与 contracts 的同义由 `contracts-alignment.test.ts` 的编译期断言钉住；
 * 3. `AgentEvent` 的形状真源同样在 contracts，本文件只 import 不重复声明。
 */
import {
  AGENT_KINDS,
  type AgentEvent,
  type AgentKind,
  type AgentMessage,
  type AskUserAnswer,
  type AskUserOutcome,
  type AskUserQuestion,
  type InjectionBoundary,
  type InjectionCapability,
  type InteractionCapability,
  type McpServers,
  type MessageCapability,
  type RetractOutcome,
  type SubagentRecord,
  type TurnInjectionCapability,
} from '@aieval/contracts';

export { AGENT_KINDS };
export type { AgentKind };
/**
 * 注入面的两份**词表**（形状真源在 contracts，与 `AskUserChannel` 同一条处置）：
 * 本包内的适配器与端口只认这两个名字，指回 contracts 的那一份不许各写一遍。
 */
export type { InjectionBoundary, RetractOutcome };
/** 交互面声明（形状真源在 contracts）在本包内也要能被引用：`AgentProviderMetadata.interaction` 就是它 */
export type { InteractionCapability };
/** 注入面声明的形状真源在 contracts（与 `InteractionCapability` 同一条处置） */
export type { TurnInjectionCapability };

/** 与路由的 ProtocolType 同义；此处重复声明避免为两个字符串引入依赖 */
export type ProtocolType = 'openai' | 'anthropic';

/** 与本次运行状态同名，便于 1:1 映射；刻意用 'timed-out' 而不是 'timeout' */
export type AgentExitReason = 'completed' | 'timed-out' | 'canceled' | 'error';

/**
 * 一次运行要哪种权限档（用户口径）。**按阶段给，不按厂商给**：
 *   · `'full'`——智能体的执行阶段（本次运行改代码）。它要能装依赖、跑测试、写工作区之外的东西，
 *     所以「工作区可写」不够：codex 的 `workspace-write` 默认**关掉网络**（见 `permission.ts` 的
 *     `CODEX_PERMISSION_OPTIONS`），
 *     而「改完自己跑一遍测试」正是本产品要观察的行为之一 ⇒ 三家用各自的最宽档。
 *   · `'read-only'`——评分阶段。工作区是本次运行的产出，评审者改了它就污染「查看改动」抽屉
 *     （抽屉按需现算 diff）；编排层另有一次改动摘要对照，本档是**执行层**的那一道。
 *
 * **刻意不做成配置项**：它由角色决定，用户没有可选项——「执行时给只读」不是一种用法，
 * 而是一个必须靠类型拦住的错误（该字段必填，就是为了让两处调用点各自表一次态）。
 *
 * 每一家的落点（哪一档给哪个厂商选项，**真源是 `permission.ts`**——几份表放一起才能逐格对照，
 * 也才能让「每一家都实现了同一份档位表」变成一条可执行的守卫）：
 *
 * | permission  | cc                                                       | codex                                            | dsh                    | pi                              |
 * |-------------|----------------------------------------------------------|--------------------------------------------------|------------------------|---------------------------------|
 * | `'full'`    | `permissionMode: 'bypassPermissions'` + `allowDangerouslySkipPermissions: true` | `sandboxMode: 'danger-full-access'` + `approvalPolicy: 'never'` | `DSH_PERMISSION_MODE=danger-full-access` | 工具白名单 = `read` / `bash` / `edit` / `write` |
 * | `'read-only'` | `permissionMode: 'dontAsk'` + `permissionPrompts: 'none'` | `sandboxMode: 'read-only'` + `approvalPolicy: 'never'`（**Windows 上落 `danger-full-access`**，见 `codexPermissionOptions`） | `DSH_PERMISSION_MODE=read-only` | 工具白名单 = `read` / `grep` / `find` / `ls`（**不含 `bash`**） |
 *
 * pi 那一列是**另一条形状**：它没有权限标志位（`.d.ts` 与真机都没有这一面），写能力住在工具集里，
 * 所以两档表达成 `createAgentSession({ tools })` 的白名单。名单里多一件写工具**什么都不会报**，
 * 只是评审者顺手改了本次运行的工作区——`permission.test.ts` 因此专门钉「只读档一件写工具都不许在」。
 *
 * 这张表之外还有一条**只被 claude 消费**的读放行通道：`AgentRunInput.extraReadPaths`（可选）
 * 翻成 SDK 的 `additionalDirectories`（`--add-dir`），只扩大「哪些路径可以读」、不改变
 * 「写仍被拒」。它**刻意不进**这几份权限档表（见 `permission.ts` 的文件头）——codex / dsh 的
 * 只读档本就全盘可读、pi 的只读档由白名单决定读得到什么，把这一格塞进表里会让它们去消费一个
 * 它们不映射的选项。
 *
 * ⚠️ 两家有**必须成对**的选项，少一个就静默失效：
 *   · claude 的 `bypassPermissions` 需要 `allowDangerouslySkipPermissions: true`——SDK 只是把两者
 *     拼成两个独立 argv（`--permission-mode` 与 `--allow-dangerously-skip-permissions`），
 *     少了后者，CLI 侧仍旧逐个工具要批准，而无人值守的评测里没有人能点这个批准；
 *   · dsh 的三档预设里 `danger-full-access` 才把 approval 一起设成 `never`（见 `dsh-base` 的
 *     `permission` 行）。`read-only` 档的 approval 仍是 `ask`——评审者越界时**不会**被自动放行，
 *     它会停在无人应答的批准上。这是「只读」在无交互环境下的正确收场（不是缺陷），但**它会被
 *     看门狗按静止超时收掉**（缺省常亮，见 `AgentRunInput.watchdog`）：dsh 的 wire 上没有
 *     「待批准」这条通知（server→client 请求通道尚未实现，`approval/policy` 只是装配期一次性的
 *     档位事实）⇒ 识别「在等审批」的判据采不到，这一格**未豁免**。边界与代价登记在
 *     《进程生命周期》的「静止超时」一节，豁免面登记在 `turn.ts` 的 `TOOL_IN_FLIGHT_SUSPENDS_WATCHDOG`。
 */
export type AgentPermission = 'full' | 'read-only';

/**
 * 领域归因码：**不是** contracts 的 `ErrorCode`。
 * 它没有对应的 HTTP 状态，落点是本次运行的事件日志；塞进 `ERROR_CODES` 会逼 `STATUS_BY_CODE`
 * 为它编造状态码。两组只在 `AUTH_FAILED` / `RATE_LIMITED` 上重名，含义各自独立。
 */
export type AgentErrorCode =
  | 'AGENT_LOAD_FAILED' // 厂商包缺失 / 加载失败
  | 'AGENT_FAILED' // CLI 未安装、进程非零退出、模型名不存在
  | 'AGENT_TIMED_OUT' // 看门狗判定的**静止**超时（本层没有整运行级时限；上游自己报的超时也归它）
  | 'AGENT_CANCELED' // 用户终止
  | 'AUTH_FAILED' // 密钥无效
  | 'RATE_LIMITED' // 限流
  /**
   * 技能装不进本次运行的配置目录（源目录读不到 / 复制失败 / 目标不可写）。
   *
   * ⚠️ **刻意不进编排层的 `TRANSIENT_CANDIDATE_RETRY_CODES`**：装不进去不是瞬时故障，重试只会把同一个
   * 失败延后 `3s × N`（成因是本次配置的直接后果，不是网关抖动）。
   * 「厂商没认那一条」（`missing`：厂商清单采到了、里面没有它）走**同一个字符串**，但判定在编排层
   * （厂商证据只有它拿得到）⇒ 那条路不经过这个码表，直接写本次运行失败的 `code`。
   */
  | 'AGENT_SKILLS_UNAVAILABLE'
  /**
   * 这一轮的请求**超出模型的上下文窗口**（厂商自己的判定，如 dsh 的 `CONTEXT_WINDOW_EXCEEDED`）。
   *
   * ⚠️ **同样刻意不进 `TRANSIENT_CANDIDATE_RETRY_CODES`**：超窗是**确定性**的——同一份提示词与同一份
   * 随附内容再发一次还是超，重试只会白跑 `3s × N` 与一整轮模型时间。补救动作是「缩短提示词 /
   * 减少随附文件 / 换窗口更大的模型」，那是配置层的动作，不是重试。
   */
  | 'AGENT_CONTEXT_OVERFLOW';

/**
 * 一条要装入的 skill：名字 + **源目录绝对路径**。
 *
 * 与 `core` 的 `SkillSource`（物化函数的入参）是**同一个形状**：文件搬运的本体在 core，
 * 而 core 不能反向 import 本包，故两边各写一次形状声明——字段逐字相同，与同文件 `ProtocolType`
 * 的「此处重复声明」是同一条处置。
 */
export interface SkillRef {
  /** 技能名（= 源目录名 = 运行内落点的目录名） */
  name: string;
  /** 源目录绝对路径（`<技能根>/<名称>`）；物化整目录复制它 */
  sourceDir: string;
}

/**
 * **端口交出来的一条人工消息**：骨架只认这两格。
 *
 * 为什么 `text` 是**编排层拼好的**：适配器只认入参、不自己决定语义——附件清单（绝对路径 + 大小）
 * 由编排层拼进这段文本，适配器原样交给厂商即可；两边各拼一次必然漂，而漂的表现是
 * 「模型看到的清单与账本里记的不是同一份」。
 * `id` 与队列条目的 `messageId` 同值：`markDelivered` / `retract` 按它认人。
 */
export interface UserMessage {
  /** 这一条的身份（由调用方生成，端口只搬运） */
  id: string;
  /** 交给厂商的正文（附件清单已在里面） */
  text: string;
}

/**
 * **注入端口**：这一轮运行中收不收人话、在哪个边界取件、以及怎么把它要回来。
 *
 * 由**编排层实现、经入参传入**（`AgentRunInput.inject`），本包只定义接口、只消费——
 * 与既有 `onAskUser` 同一形状（那边是一个函数，这边是一个对象，因为还要登记反向路径）。
 * 为什么不能由骨架自己造：端口的实现要找到「哪一行」的那份状态，而 `AgentRunInput` 里
 * **没有任何身份格**（只有路径）；把 `runId` / 本次运行 id 加进来等于让这个包知道评测领域，
 * 拿路径当键则是「断的时候没有编译错」的隐式耦合。
 *
 * 四条口径：
 *   · `available === false`（调用方没开闸门）⇒ 适配器**一格都不挂**：这就是「零回归」的判据。
 *     调用方**没传端口**时，替代物是「关闭档」：`available: false`、`drain()` 恒回 `[]`、
 *     `retract()` 恒回 `'unsupported'`（没接端口就是「做不到撤回」，**不是** `'unknown'`——
 *     后者读起来像「我们再查查」）；
 *   · `drain(boundary)` 的取件规则是契约的一部分：`'round'` **只**取要求 `'round'` 的条目，
 *     `'idle'` 取**全部**且要求 `'round'` 的排在前面（它等得更久）；**不抛**；
 *   · `markDelivered` 在**适配器把消息真交给厂商之后**调：拉出去的同时把「怎么要回来」登记回来
 *     （与 `drain` 对称，厂商差异全留在那个闭包里）；
 *   · `retract(id)` **不抛**，结果如实返回（`RetractOutcome` 四值里没有「抛错」这一档）。
 */
export interface InjectionPort {
  /** 这一轮到底开不开（= 调用方开了闸门）。false ⇒ 适配器一格都不挂 */
  readonly available: boolean;
  /** 在某个边界上取走可以投的条目；不抛 */
  drain(boundary: InjectionBoundary): UserMessage[];
  /** 适配器把消息交给厂商之后，把「怎么把它要回来」登记回来 */
  markDelivered(ids: string[], retract: (id: string) => Promise<RetractOutcome>): void;
  /** 编排层发起撤回；不抛，结果如实返回 */
  retract(id: string): Promise<RetractOutcome>;
}

/** 一次运行的全部输入。内部无厂商分支，**不写** `process.env`（宿主环境只读展开，用于补 `PATH` / `HOME`） */
export interface AgentRunInput {
  /** 该运行工作区（编排层第 1、2 步已备好）；适配器不做任何 git 操作 */
  cwd: string;
  /**
   * 本次运行独立配置目录：适配器里作为 HOME / USERPROFILE / 厂商配置目录（不变量 3）。
   *
   * ⚠️ **不许假设它已存在**：契约只保证「本次运行有一个自己的配置目录」，建不建是调用方的事
   * （编排层确实会建，但那是它的实现细节）。适配器要往里面写任何东西之前**自己**
   * `mkdirSync(recursive)`——漏了的表现是 `ENOENT: open '…\.agenthome\…'`，
   * 归因成一个离真因很远的失败。先例：`writeCandidateNpmrc` 与 dsh 的 overlay 两处都自己建。
   */
  configHome: string;
  /**
   * 权限档（见 `AgentPermission`）。**必填**：两个阶段（本次运行执行 / 评分）各表一次态，
   * 少给一个就会在编译期报错，而不是运行时静默用一个「谁也没选过」的默认档。
   */
  permission: AgentPermission;
  /**
   * read-only 权限下**额外放行**的只读绝对路径（目录或文件）。**可选**：缺省不传时三家行为逐字不变。
   *
   * 为什么需要它：三家 read-only 的**读放行范围不等价**——claude 的 `dontAsk` 只预授权
   * 工作目录内的读，而执行过程记录（`events.jsonl` / `messages.jsonl`）落在 cwd 之外，
   * 评审者读不到。这一格是「工作目录之外还有哪些本次可以读」的中性事实，翻译成哪家的什么
   * 选项由各适配器自己决定：
   *   · claude → `additionalDirectories`（SDK 拼成 `--add-dir`，扩进 `dontAsk` 的预授权范围，
   *     与它兼容——写仍被拒）；
   *   · codex → **不映射**（read-only 沙箱官方语义全盘可读，见 `permission.ts`）；
   *   · dsh → **不映射**（read-only 只拦写，读在所有档直通）。
   * 口径与 `mcpServers` / `skills` 同源：适配器只认入参，不自己决定「哪些路径可以放行」。
   */
  extraReadPaths?: string[];
  /** 考题提示词 */
  prompt: string;
  /** 路由：只读输入；适配器只读、不写回、也不写 process.env（不变量 1） */
  route: {
    protocolType: ProtocolType;
    baseUrl: string;
    apiKey: string;
    modelId: string;
    /**
     * 该模型声明的上下文窗口（token）。**可选**：既有夹具与将来的第三方 provider 不该被它挡住，
     * 缺省 = 未知（各家保持自己的默认行为）。它是**事实**，不是方言：cc 读它决定要不要加 `[1m]` 后缀、
     * codex 读它填 `model_context_window`、dsh 读它写 per-run overlay 的 `contextWindow`——三种写法都不出现在这一格里。
     */
    contextWindow?: number;
    /** 单次输出上限；今天只有 dsh 的目录用得上（可选，理由同上） */
    maxOutputTokens?: number;
  };
  /** 外部要求停止（用户终止）；**不得**用它推断 exitReason */
  signal: AbortSignal;
  /**
   * 本次要注入的 **MCP 服务器**（控制权在编排层）。**可选**：不给 = 一台都不注入。
   *
   * 三条口径，缺一条就会长出第二份真源：
   *   · 条目是 **canonical 形状**（`@aieval/contracts` 的 `McpServerConfig`，含 `transport` 判别）——
   *     厂商方言（`Options.mcpServers` / `config.toml` / patch 行）由各适配器自己翻，契约里
   *     不出现任何一家的语法；
   *   · **由编排层填**（本次运行执行那一处，与 provider / route 同一份配置快照），且**只在那里填**：
   *     评分与用例同步两处留空——「只有本次运行执行阶段注入 MCP」这条口径因此由类型 + 调用点共同保证，
   *     而不是靠适配器自己去读全局配置（**适配器只认入参、不读 `loadConfig()`**）；
   *   · 交到这里的那一份**已经解析过 `${ENV}` 占位、也已剔除停用条目**（`resolveMcpServers`）：
   *     解析结果要进密钥、跳过的那几台要进行的级观测格，两件事都只有编排层做得了。
   *     即便如此，适配器**不许**把还带 `${…}` 的条目原样透给厂商（那等于注入一串占位原文）。
   */
  mcpServers?: McpServers;
  /**
   * 本次要**装入**本次运行的 skill 清单（控制权在编排层）。**可选**：不给 = 一条都不装。
   *
   * 三条口径与 `mcpServers` 同源、理由同源：
   *   · 条目是**中性的两格**（名字 + 源目录绝对路径，见 `SkillRef`）——三家落在哪、要不要额外开关
   *     由各适配器自己决定，契约里不出现任何一家的目录语法；
   *   · **由编排层填**（本次运行执行那一处，与 provider / route 同一份配置快照），且**只在那里填**：
   *     评分与用例同步两处留空——「只有本次运行执行阶段装入」这条口径因此由类型 + 调用点共同保证，
   *     而不是靠适配器自己去读全局配置（**适配器只认入参、不读 `loadConfig()`**）；
   *   · 交到这里的那一份**已经剔掉停用条目、也只含扫描合格的条目**（`installableSkills`）：
   *     「停用 = 不放」是三家统一的停用手段，而判定要用扫描结果（适配器读不到技能根）。
   *     即便如此，适配器**不许**自己过滤或补全清单：它只负责把这一份落到 `configHome`。
   *
   * **空集不给这个键**（与 `mcpServers` / `effort` 同一条口径）：给了空数组等于向适配器声明
   * 「本次运行显式要零条」，而「没配」与「配了零条」在落盘侧是两件事（前者一个文件都不写）。
   * 落不下去（源目录读不到 / 复制失败）⇒ 该次运行以 `AGENT_SKILLS_UNAVAILABLE` 失败，**不跳过**。
   */
  skills?: SkillRef[];
  /**
   * 要求模型**按这份 JSON Schema 生成**最终答复（可选）。**语义是「我想要」**：
   * 有原生 schema 通道的家把它翻成厂商方言（claude 的 `outputFormat`、codex 的 `outputSchema`），
   * 没有原生通道的家**在适配器内部填充**（把 schema 写进提示词 + 自校验 + 同会话修正轮）。
   *
   * 两条口径：
   *   · **骨架不替厂商判能力**：这一格一律交给 `start`，摘不摘、怎么用由各适配器自己决定；
   *   · **各家保证强度不同、契约相同**：要么交出一段符合这份 schema 的 JSON，要么在
   *     `applied.structuredOutput` 与最终答复上如实失败——不允许静默给一个坏形状。
   * 为什么是中性事实：翻译成哪一家的什么选项是适配器的事；契约里出现某一家 CLI 的语法，
   * 等于让跨端契约知道厂商方言。
   */
  outputSchema?: unknown;
  /**
   * 要求的思考强度（可选）。**为什么放这里而不是 route**：route 是**连接事实**
   * （协议 / 地址 / 密钥 / 模型名 / 窗口），而强度是**请求参数**——它与 `permission` 同类，
   * 且它的值域由本次运行选的智能体决定，与连接无关。
   * **未选 ≠ 关闭**：未选表示「不指定」——dsh 的适配器给缺省档 `high`，
   * claude / codex 不传、由厂商推断；要关闭必须显式写 `EFFORT_OFF`（契约里的统一档名）。
   * 能不能收由创建时的本次运行校验保证（D10）。
   */
  effort?: string;
  /**
   * 看门狗：两级**静止**上限（毫秒）。**可选、缺省常亮**（空闲 180 s / 单轮 600 s，见 `turn.ts`）。
   *
   * 语义是「本次运行还在动吗」，**不是**工作时长上限——「执行不限时间」这条口径不变：
   *   · `idleTimeoutMs`：连续这段时间**没有任何产品事件**即判静止（「有输出」＝这一条投影交出了
   *     任何东西：运行级事件 / 消息 / 子任务行 / 计量；未识别的厂商负载走兜底投影，一样算）；
   *   · `turnWallClockMs`：**一次模型往返**从起表到收尾超过这段时间即判静止。它兜的是「一直有输出、
   *     但一次往返都不收尾」那一格；套在整本次运行上是错的——codex 的一个厂商 `turn` 内含多次模型往返。
   * 显式给 `0`（或负数）＝关掉那一级（逃生门：用例与调试）。
   *
   * 到点后走与用户点「终止」同一条释放路径（`interrupt` → 终结在途 turn → `dispose`，5 秒交卷窗口），
   * 结论落 `exitReason: 'timed-out'` + `AGENT_TIMED_OUT` ⇒ 本次运行状态 `timed-out`（**不进自动重试**）。
   * 两条豁免的判据都在骨架里（见 `turn.ts` 的 `TOOL_IN_FLIGHT_SUSPENDS_WATCHDOG`）：工具在途只对
   * 能合法静默的家生效；「等待审批」的识别机制按家不同、**今天采不到 ⇒ 如实登记为未豁免**。
   */
  watchdog?: { idleTimeoutMs?: number; turnWallClockMs?: number };
  /**
   * 事件回调：同步、不 await——事件流不能被消费者拖慢。
   *
   * 这里**没有 `timeoutMs`**（用户口径「执行不限时间、评分不限轮次和时间」）：
   * 一次运行只会因为「跑完 / 失败 / 外部要求停止 / 静止超时（看门狗）」结束，
   * 适配器自己不设内层上限。总时长仍不限，唯一的时限是上面那两级**静止**上限。
   */
  onEvent: (e: AgentEvent) => void;
  /**
   * 消息回调（`AgentMessage`）：**与 `onEvent` 并行**的一条流，承载内容级视图
   * （说话者、内容块、工具族、子智能体归属、模型往返序号）。
   *
   * 为什么与事件分两条流而不是塞进 `AgentEvent`：两者的消费方、去重键与生命周期都不同——事件是
   * 运行级的（SSE 去重与续订按 `seq`），消息是内容级的（按合并键累积、会被快照覆盖）。
   * 把消息塞进事件联合会让消费方在两个维度上都拿到用不到的可选格。
   *
   * **可选**：不关心内容视图的调用方（例如评分通路只读 `finalText`）不传即可，此时适配器
   * 一个消息都不产出——合并与序号分配的开销也随之省掉。语义与 `onEvent` 一致：同步、不 await。
   */
  onMessage?: (message: AgentMessage) => void;
  /**
   * 子任务行回调（`SubagentRecord`）：一行一子任务，**同一身份会多次投递**
   * （派发时一条、收场时一条），后者是前者的完整快照 ⇒ 消费方按 `subagentId` 覆盖即可。
   *
   * 为什么不并进消息流：子任务不是消息（没有说话者与内容块），它的字段（名称、类型、父链、用量）
   * 与消息没有交集；并进去只会让两边的形状互相将就。
   */
  onSubagent?: (record: SubagentRecord) => void;
  /**
   * **提问回调**：模型问到用户时把这一问交给调用方，等它的答复再继续。
   *
   * ⚠️ **它与上面三条流不是同一种形状**，四格差别缺一不可说清：
   *   · 上面三条是**同步、不 await**（回调慢一点就拖慢事件流），这一格**必须 await**；
   *   · 上面三条**抛错被吞**（一条投影失败不该毁掉整行），这一格抛错 ⇒ 这一问落「无人应答」，
   *     但仍**不改变**本次运行的 `ok` / 退出原因——「没人答」与「本次运行失败」是两件事；
   *   · 上面三条**不改变本次运行的结论**，这一格会（用户答了什么，模型就照什么干）；
   *   · 它是**唯一一格允许阻塞本次运行**的回调，因此等待语义（超时预算、本次运行终止、
   *     静止超时豁免）全部归骨架，适配器只负责把厂商钩子接上来、把答复按各家形状喂回去。
   *
   * **可选**：不传 = 这次运行没有应答面——适配器一个钩子都不挂、一个开关都不开、
   * 权限档也不改（「默认不介入」这条边界靠它成立，既有行为因此逐字不变）。
   */
  onAskUser?: (request: AskUserRequest) => Promise<AskUserReply>;
  /**
   * **注入端口**：这一轮运行中收不收人话（见 `InjectionPort`）。
   *
   * **可选**：缺席 = 这一轮不进人工消息——适配器一格都不挂、一个开关都不开，
   * 既有行为因此逐字不变（这就是「零回归」的判据）；给了就由适配器按两档边界取件。
   *
   * ⚠️ 与 `resume` **正交**：这一格回答「这一轮运行中收不收人话」，
   * `resume` 回答「从哪条会话接着跑」。两格是两件事，不是「一个功能的两半」。
   */
  inject?: InjectionPort;
  /**
   * 续接到哪条会话。**可选**：缺席 = 开新会话——这就是「没有可续接的会话」的表达，
   * 不需要第二个字段，也刻意**不**引入 `{ mode: 'new' | 'resume' }` 那种判别联合
   * （多出来的那一档没人填，却会逼每一处构造入参的地方写 `mode`）。
   *
   * ⚠️ 不支持续接的家收到它**必须抛错**（中文原因），**不许静默开新会话**：
   * 那是最坏的一种——用户以为在追问、智能体其实什么都不记得，而界面上一切正常。
   */
  resume?: { sessionId: string };
}

/**
 * **一次提问**（骨架交给回调的那一份）：模型刚调了提问工具，问题与厂商上下文原样带过来。
 *
 * 五格各自回答一个「消费方不然就得自己猜」的问题：
 *   · `questions` 是**归一后**的问题数组（契约形状，不是厂商方言）——回调侧不用认四家的字段名；
 *   · `toolName` 是**厂商原始工具名**（如 `AskUserQuestion`）：提示与排障要能报出模型实际调的是谁；
 *   · `callId` 是这次工具调用的 id：答案要按它回填进消息账本的 `tool-result` 那一半；
 *   · `vendorBudgetMs` 是**厂商侧**自己的等待预算（厂商到点会自己收场）；`null` = 这一家没有
 *     （宿主工具那两档吃我们的预算）或没采到——不填 `0`，那会被读成「立刻超时」；
 *   · `subagentId` 是**子智能体身份**（`null` = 主线程）：子智能体发起的提问按「子智能体不能向用户
 *     提问」收场，回调侧靠它区分，而不是靠自己去猜调用栈。
 */
export interface AskUserRequest {
  questions: AskUserQuestion[];
  toolName: string;
  callId: string;
  vendorBudgetMs: number | null;
  subagentId: string | null;
}

/**
 * **一次提问的答复**：收场方式 + 答案。
 *
 * 两格成对出现（与界面侧那份「已收场」形状同义）：`answers` 为 `null` = 收场了但没有答案可回填
 * （等超时、通道不可用、随行取消…），与「答了但一个选项都没选」（空数组 + 可能只有自由输入）
 * 是两件事——合成一个空数组，落盘的收场标记就再也说不清到底有没有人答过。
 * 七态词表与只读复盘卡片上的那一套同名同义，本包不新造。
 */
export interface AskUserReply {
  outcome: AskUserOutcome;
  answers: AskUserAnswer[] | null;
}

/** 一次运行的结果：计量采不到时一律 null，绝不填 0 */
export interface AgentRunResult {
  ok: boolean;
  exitReason: AgentExitReason;
  /**
   * null = 该次运行未采到计量；绝不填 0。
   *
   * ⚠️ **这一格是「全树」合计**（主会话 + 我们数到的每一个子智能体）。
   * 分量单列在 `subagentTokens`。
   * 为什么必须在本次运行写明：只读 `tokens` 的消费方（对比表、历史数据）**无法从数值上**
   * 分辨一本次运行是哪一版落的盘，而两版口径不同 ⇒ 跨期比较会把口径差异读成能力差异。
   */
  tokens: { input: number; cached: number; output: number } | null;
  /**
   * **子智能体那一份**用量：`tokens` 是「主会话 + 全部子智能体」的合计，
   * 这一格是其中的分量。
   * `null` = 本次运行没有子智能体、或**没采到**（含「有任何一个子智能体读失败」⇒ 合计退回主会话口径）。
   * 为什么与 `tokens` 一样必填：它决定界面画不画拆分那一行，缺格与 `null` 在消费侧是同一件事，
   * 少一种形态就少一处漂移（与 `usage` 事件的 `timing` 同一条处置）。
   */
  subagentTokens: { input: number; cached: number; output: number } | null;
  /**
   * **子智能体那一份**轮次：`turns` 是「主会话 + 全部子智能体」的合计，
   * 这一格是其中的分量。
   * `null` = 本次运行没有子智能体、或**没采到**（含「有任何一个子智能体读失败」⇒ 合计退回主会话口径）；
   * `0` = 确实没有子智能体（子智能体一次模型往返都没跑）。
   * 为什么与 `subagentTokens` 一样必填：它决定界面画不画「轮次」那一格的拆分行，
   * 缺格与 `null` 在消费侧是同一件事，少一种形态就少一处漂移。
   * 恒有 `subagentTurns ≤ turns`（分量关系，逐格）——**轮次仍是全树合计**，它的语义不改。
   */
  subagentTurns: number | null;
  /**
   * **轮次 = 一次模型 API 往返**（用户口径）：一次请求带着 role=user 的上下文、
   * 模型回一条 role=assistant 的答复，算一次。三家各自从自己的事件流里数（口径见各家的
   * `providers/<kind>/events.ts`），不混用「CLI 自己的 turn」——codex 的 `turn.completed` 与
   * dsh 的 `turn/end` 都是**整段任务**一条，照它们数出来永远是 1。
   * null = 一次都没观察到；绝不填 0。
   */
  turns: number | null;
  durationMs: number;
  /**
   * 这次跑在哪条**会话**上；`null` = 这次没拿到。
   *
   * **恒有这一格**，与 `tokens` / `subagentTokens` / `subagentTurns` 同形（本包结果里那几个
   * 「可能采不到」的格子全是 `| null`、没有一个是可选键）。
   * 「这家有没有会话这个概念」由**能力声明**回答，不进结果 ⇒「没采到」（值得 WARN）与
   * 「这家没这个概念」（什么也不用说）在消费方分得开。
   * 消费方是运行快照的 `sessionId`：它落盘之后，跨进程续接才有键可指。
   */
  sessionId: string | null;
  error?: { code: AgentErrorCode; message: string; stack?: string };
  /**
   * 智能体的最终答复文本；null = 未采到。
   * 「未采到」与空串是两件事：前者是这一家没回传可读的最终消息、或本次运行没跑到那一步，
   * 后者是它明确回了一个空答复——与 tokens/turns 同一条「绝不填 0」的口径，不要互相兜底。
   * 用途：需要**结构化答复**的调用方（评分智能体）从这里取文本，而不是从事件流里重建
   * （codex 发增量 delta、dsh 的 assistant 文本不进事件流，重建三家各不相同且不可靠）。
   * 失败与终止的结论也带它：排障时要能回答「它到底说了什么」。
   *
   * ⚠️ **这是跨家契约，不是各家的实现细节**：一致性套件的「最终答复口径」按产物逐家钉住
   * 「有主会话答复就必须交得出」——漏写这一格的家会在套件上红（codex 在 app-server 重构里漏过一次，
   * 各家自己的用例全绿而真机评分永远拿不到答复，见 `docs/faq/codex.md`）。
   */
  finalText: string | null;
  /**
   * 这一次运行**实际**走的是哪条通道（由**适配器**上报，骨架只搬运）。必填：调用方据此记账
   * （`ScoreResult.structuredOutput` 就是它），缺格会让「真的用上了吗」变成「没采到」。
   */
  applied: {
    /**
     * **本次运行有没有把答复落到原生 schema 通道上**：`true` = 厂商按 schema 约束了形状
     * （claude 的 `structured_output` / codex 的 `outputSchema` 真的生效），
     * `false` = 没有（该家没有原生通道、本次没要求 schema、或厂商这一轮没照做）。
     *
     * 它是**每-run 的事实**而不是「这家有没有这个能力」的声明：谁走哪条通道只有适配器知道，
     * 故由适配器在 `TurnFinalize.applied` 里上报，骨架取缺省 `false`。
     * 与「答复是否合格」是两件事：没有原生通道的家走填充层（提示词约束 + 自校验 + 修正轮），
     * 可能交出一份完全合格的 JSON 而这一格仍是 `false`——那一格回答的是**方法**，不是**结果**。
     */
    structuredOutput: boolean;
  };
}

/**
 * **耗时量级**：这一家跑完一行典型任务要多久。
 *
 * 为什么是**量级**而不是精确数字：耗时由机器、模型、路由与任务规模共同决定，写一个精确值必然
 * 很快过期或变成假话；而量级有两个真实消费方——**真机冒烟的等待预算按它派生**（声明小了，
 * 这一轮会被自己的预算掐掉，红在产物格而不是红在一句注释里），以及将来编排层若要给超时定档。
 *
 * 为什么必须有这一格：新家接入时「这家要跑多久」从来没有人回答过，而它直接决定等待预算与用户
 * 预期；漏了它，一个比另两家慢一个数量级的接入不会被任何判据发现。
 */
export interface ProviderTiming {
  /** 一行典型任务跑完的量级；实测超出这一档的上限就是声明与事实不符 */
  runScale: 'seconds' | 'minutes';
  /** 这一格成立的**前提**（机器 / 模型 / 路由 / 任务规模）；空数组 = 无条件成立 */
  notes: readonly string[];
}

/** 注册表元数据：协议兼容性 / 运行级能力 / 消息能力 / 档位域的**唯一**查询点（A3） */
export interface AgentProviderMetadata {
  /**
   * 该智能体**能接受**的协议集合（非空、去重）：表单的本次运行池过滤、创建校验、评分智能体校验与
   * 编排层复检**四处都读它**，判据用 `acceptsProtocol()`，不许各写一份。
   *
   * 为什么是集合而不是单值：dsh 侧存在**两条 wire**（pi-ai 路由同时讲 `anthropic-messages` 与
   * `openai-responses`，两条都跑通含计量），单值字段装不下；再出现多 wire 的家也不必再改形状。
   * 判据与结论见 `docs/protocols/dsh.md`。
   *
   * cc / codex 仍是单元素（它们各自只讲一条 wire），集合形状对它们只是多一层数组。
   */
  protocolTypes: readonly ProtocolType[];
  /** **运行级**能力：这一家在「跑本次运行」这件事上能做什么（内容级能力见下面的 `messageCapability`） */
  capability: {
    /** false ⇒ 「终止」按钮在本次运行上退化为「关闭运行时」，界面文案必须不同 */
    cancelMidTurn: boolean;
    /**
     * false ⇒ 该适配器采不到 token，界面显示「不支持计量」而不是 0。
     * 跑动期那一条 `usage` 事件是**上报值还是估算**由事件自带的 `tokensBasis` 说明——
     * 那是每一条事件的性质，不是这一家的静态属性，故这里没有对应的能力格。
     */
    usage: boolean;
  };
  /**
   * **消息能力声明**：这一家在**消息层**到底能拿到什么，逐格给出取值、
   * 取数通道与缺失原因，并带上「这一族能力成立的前提」（路由 / 模型 / 开关）。
   *
   * 为什么与上面的 `capability` 分开：那一组说的是**运行级**能力（能不能中止、能不能计量、
   * 能不能约束结构化输出），这一组说的是**内容级**能力（思考正文、工具入参、工具结果、子任务、
   * 流式增量）。两组的问题、消费方与变化原因都不同，合成一组会让「计量采不到」与「思考正文
   * 拿不到」挤进同一格。
   */
  messageCapability: MessageCapability;
  /**
   * **注入面能力**：我们下发给厂商进程的东西（MCP server、skill 副本），这一家收不收得到。
   *
   * 为什么单列一组：`capability` 说的是**运行级**（能不能中止、能不能计量），`messageCapability`
   * 说的是**内容级**（拿得到哪些块），而这一组说的是**下发级**——三条通路的问题、消费方与
   * 变化原因都不同。少了它，「这家装不上 MCP」没有任何地方说得出口：只能等真跑一次、
   * 去 `vendor-system` 事件里事后翻，而「没声明」与「声明了不支持」对使用者是两件事。
   *
   * 声明与产物**互钉**：声明 `yes` 的家，一致性套件的 fixture 必须给出对应场景，
   * 且该场景产物里必须真的有那件事（判据在 `providers/conformance/` 的套件与接入守卫里）。
   */
  injection: InjectionCapability;
  /**
   * **交互面能力**：模型问出来的时候，这一家有没有人能答、提问工具是谁提供的、不能时为什么。
   *
   * 为什么单列一组：前四组回答「跑本次运行能做什么」「拿得到哪些块」「我们下发的东西认不认」，
   * 这一组回答「模型向用户提问时这条路通不通」——变化原因（厂商通道的有无与投送）、消费方
   * （应答面与弹层）与判据通道都不同。少了它，三种「没有」只能混成一句「不支持」：
   * 结构上没有（`no`）、厂商有但我们没接（`off-by-adapter`）、厂商有但不投送到我们拿得到的
   * 通道（`not-projected-by-vendor`）——排查时前一种是「白写代码」，后一种是「能写代码解决」。
   *
   * 声明与产物**互钉**：把哪一格改成 `yes` 就要同时给出对应的一致性场景（否则接入守卫红）。
   */
  interaction: InteractionCapability;
  /**
   * **注入面能力声明（第五组）**：人往运行中的一轮送话时，这一家在**两档边界**上各能做什么
   * ——投递与撤回**分开**声明，每格带通道 / 版本门 / 实验性（形状真源在 contracts 的
   * `TurnInjectionCapabilitySchema`）。
   *
   * 为什么单列一组：前面几组回答「跑本次运行能做什么」「拿得到哪些块」「我们下发的东西认不认」
   * 「模型问出来有没有人能答」；这一组回答「**人说话它收不收**」——消费方（界面与编排层两边都要读）
   * 与形状（家 × 档(2) × 两件事的矩阵）都不同。
   *
   * **可选**：缺席 = 这家还没声明。消费方按「不知道」处置，**不编一份都支持的**——
   * 猜错会让界面说谎（说「能投」而实际投不进去）。声明与夹具**同一次提交**落地：
   * 把哪一格改成 `yes` 就要同时给出该格的真实场景。
   */
  turnInjection?: TurnInjectionCapability;
  /**
   * **耗时量级**：真机冒烟的等待预算按它派生，实测超出这一档的上限即判声明与事实不符。
   * 见 `ProviderTiming`。
   */
  timing: ProviderTiming;
  /**
   * 要拿**推理证据**时，除了 events.jsonl 是否还必须补 messages.jsonl（**必填**）。
   *
   * 为什么需要它：codex 的思考全文与工具结果正文**结构性不进** events.jsonl
   * （事件流只有摘要与结构件，唯一落点是消息账本 messages.jsonl），而另两家的执行过程记录
   * 事件流即齐。调用方据此决定「要推理证据」时要不要多拼一份文件——厂商差异吸收在本包，
   * 调用方按 kind 查询，**不硬编码厂商名**。逐格取值与理由见各家的 `providers/<kind>/index.ts`；
   * 它讲的是**厂商事实**（哪家的推理证据不在事件流里），与调用方拿证据去做什么无关。
   */
  needsMessagesForReasoningEvidence: boolean;
  /**
   * 该家能表达的思考强度档位（**完整值域**）。**必填**并由 `registry.test.ts` 守卫：
   * 本次运行池的「上游档位 ∩ 智能体档位」交集（D10）全靠它，缺一格就是静默少一批可选档。
   * 值域依据：cc = Agent SDK 的 `EffortLevel`；codex = `codex app-server` 的 `ReasoningEffort`
   * （另加本仓统一的关闭档 `off`，适配器翻成 CLI 的 `none`）；
   * dsh = `llm-deepseek` 的 `reasoningEffort` schema（只认四档）。
   */
  reasoningEfforts: readonly string[];
  /**
   * 该家「**未选档位**时实际会用的档」（可选）。只有 dsh 声明它（`DSH_DEFAULT_EFFORT`）——
   * 它的「未选」会真的落到一个具体档上；claude / codex 不声明（未选由厂商推断，我们无从预知）。
   *
   * 为什么需要这一格：API 侧要拦「未选 + 该模型不支持那个缺省档」这种组合，否则要跑到
   * dsh 的硬校验处才失败（`UNSUPPORTED_REASONING_EFFORT`，症状离真因很远）。
   */
  defaultEffort?: string;
}

/** 一次运行的接口是函数而非类实例：编排层只按 kind 解析并调用 */
export interface AgentProvider {
  readonly kind: AgentKind;
  readonly displayName: string;
  readonly metadata: AgentProviderMetadata;
  run(input: AgentRunInput): Promise<AgentRunResult>;
}

/**
 * 一份**最宽松**的消息能力声明（六格全 `'yes'`、取数通道 `'wire'`）：给**包内测试夹具**用的默认值。
 * 为什么测试用「全 yes」而不是「全 unverified」：这些用例关心的是协议集合、档位域与运行骨架，
 * 一份 `unverified` 会反复断言同一件事而看不出差别；而**生产适配器必须各自显式声明**。
 * **不从包出口转出**（它今天只有包内消费方，出口面只该放跨包契约）。
 */
export function permissiveMessageCapability(): MessageCapability {
  return {
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
    notes: [],
  };
}
