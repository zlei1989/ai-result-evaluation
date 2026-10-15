/**
 * dsh 的厂商 SDK 懒加载外壳：**按真实探测回写后的入口形态**。
 * 这份窄结构不再是「探测前的假设」——它逐条对应安装态 `@deepseek-ai/dsh-sdk-client@0.2.1-alpha.3` 的
 * `lib/types/{index,api,client,types,launch}.d.ts` 与 `lib/index.js`，实测记录见
 * "docs/protocols/dsh.md"（DSH 接入）与探测 dump。
 * 版本是 **0.2.1-alpha.3**（该包从未发过非预发布版本，「稳定版」即 tag 线上最新的那一个预发布）：
 * 它相对 `0.2.0-rc.2` 是**只加不改**（`types.d.ts` 与 `launch.d.ts` 零 diff，构造选项与默认值逐字未变），
 * 新增的 `resumeSession` / `getWorkingDirectory` / `validatedSessionEvent` 都不影响本文件的窄结构：
 *
 *  - **值出口是 8 个**（`Object.keys` 排序后逐字）：
 *    `DeepSeekHarness` / `HarnessClient` / `HarnessSession` / `JsonRpcResponseError` /
 *    `RequestTimeoutError` / `SdkProtocolError` / `TransportClosedError` / `validatedSessionEvent`
 *    —— **没有 `createRuntime`**；
 *  - 真实入口是 `new DeepSeekHarness(options)` → `start()`（幂等的 spawn + initialize 握手）→
 *    `client.subscribeSessionTree(sessionId)` 拿通知流 → `run(prompt, { sessionId })` 交提示词，
 *    它在**下一次 idle** 时落定（`lib/index.js` 的 `HarnessSession.run`，0.2.1-alpha.3 在 800-839 行）；
 *  - 通知的外形是 `{ method, params }`（**不是** `{ type, message }`），method 只有四种：
 *    `session.event` / `session.status` / `subagent.started` / `subagent.finished`；
 *  - 停止只能靠 `harness.close()`（`HarnessClient.close()` 的 JSDoc 逐字：「There is no wire-level
 *    cancel: a timed-out request stays running server-side until the runtime is closed」）⇒
 *    `cancelMidTurn: false` 是实测结论，`close()` 是**必需**的释放出口（A7）。
 *
 * 注入落点（实测，与探测报告的口径有差异）：
 *  - 配置根是 `dshHome`（SDK 把它写成子进程的 `DSH_HOME`，`lib/index.js:161-190`），**不是 `HOME`**；
 *  - `env` 是**整体替换父进程环境**语义（`lib/types/types.d.ts` 的 `HarnessClientOptions.env`）⇒
 *    调用方必须自己展开宿主环境（本仓走 `buildSubprocessEnv`）；
 *  - **空 `configHome` 下凭据只能靠 `DEEPSEEK_API_KEY` 环境变量**：四格对照实测——
 *    `dshHome` 指向空目录且环境里没有这个变量时，运行必然以 `turn/end(kind:'error')` 收场
 *    （`llm-deepseek: no API key for provider route "deepseek-official"`）；补上变量即可跑通。
 */
import { AgentLoadError, exportedNames } from '../../errors';
import { createSdkLoader } from '../../load-once';

// 包名字面量不直接 export：静态导入断言区分不出 `export const X = '@pkg'`（字符串常量）与
// `export … from '@pkg'`（真静态导入），收窄前后都靠「先落成非 export 常量再转出」避开误报
// （T7 实测上报 + 控制方裁决）。包名仍是唯一真源。
const DSH_PACKAGE_NAME_LITERAL = '@deepseek-ai/dsh-sdk-client';
export const DSH_PACKAGE_NAME = DSH_PACKAGE_NAME_LITERAL;

/** 一条服务端通知的原始外形（`HarnessNotification`）：`method` + `params`，没有 `type`。 */
export interface DshNotification {
  method: string;
  params: Record<string, unknown>;
}

/** 通知过滤器（`NotificationFilter`）：省略即「全部通知」。 */
export type DshNotificationFilter = (notification: DshNotification) => boolean;

/**
 * 通知订阅（`NotificationSubscription`）。
 * 终止通道只有 `close()`：它**丢弃队列并 reject 挂起的等待者**（实测 `lib/index.js:256-279`），
 * `[Symbol.asyncIterator]` 是 `for (;;) yield await this.next()` 形状 ⇒ 关闭运行时可观地终结在途消费。
 */
export interface DshNotificationSubscription extends AsyncIterable<DshNotification> {
  next(): Promise<DshNotification>;
  tryNext(): DshNotification | undefined;
  close(): void;
}

/** 低层 JSON-RPC 客户端：只要我们要用的那几格（入队、订阅与关闭）。 */
export interface DshClient {
  subscribeSessionTree(sessionId: string): DshNotificationSubscription;
  subscribe(filter?: DshNotificationFilter): DshNotificationSubscription;
  /**
   * `session/prompt`：**入队并返回那条消息的身份**（wire 结果是 `{messageId}`，客户端把它解成
   * 一个字符串交出来）。身份就是撤回时要的句柄——`inbox.remove(messageId)` 按它配对。
   * 未知 id 会新建一条会话（`client.d.ts` 逐字「an unknown id creates it」），而在本仓的用法里
   * 会话必然已由首轮建好：这一格只用于 `'idle'` 档的**在途投递**。
   */
  prompt(sessionId: string, contentBlocks: readonly unknown[]): Promise<string>;
  /**
   * 任意 JSON-RPC 请求（门面没包的那些方法）。本仓只用它调 **`session/wait`**：等**整棵子树**
   * 收场——厂商实现是「先等这条会话 idle，再 `subagents.waitForChildren`，两者都干净才返回」
   * （`dsh-sdk-jsonrpc-server` 的 `wait()` 逐行），未知会话 id 报 `unknown SDK session`。
   *
   * 为什么不能省：根会话 idle 时 `run()` 就落定了，而后台子智能体可能还在跑——那时我们释放运行时
   * 等于把它们**连根拔掉**（`subagent.finished` 永远不来、子智能体分量只到一半）。
   * `timeoutMs` 是每调一次的覆盖（门面默认值见厂商的 `HarnessClientOptions`）。
   */
  request(method: string, params?: object, timeoutMs?: number): Promise<unknown>;
  close(): Promise<void>;
}

/** `RunResult`：一次运行的全部通知 + 会话事件 + 最终答复（探测 dump 里逐字核过）。 */
export interface DshRunResult {
  sessionId: string;
  finalResponse: string;
  events: unknown[];
  notifications: DshNotification[];
}

/**
 * **一条已 adopt 的会话**（`session/resume` 的产物）：续接之后由它跑后续的每一轮。
 * 与 `DshHarness.run` 逐格同形（同样的 `RunResult`），只是不再带 `sessionId` 选项——
 * 身份在 adopt 那一刻就定了。
 */
export interface DshSessionHandle {
  run(input: string): Promise<DshRunResult>;
  /** 这条会话**记录里的** cwd（`session/resume` 不带 `meta.cwd` ⇒ 启动参数那一格不参与，见 FAQ） */
  getWorkingDirectory?(): Promise<string>;
}

/**
 * 高层入口 `DeepSeekHarness` 的窄结构（只声明用到的方法与字段；厂商类型面一律不 import）。
 * `start()` 的幂等性来自实现（`this.initialized ??= …`），适配器因此可以在 `run()` 之前先把
 * 通知订阅挂上——否则「订阅之前到达的通知」会丢，而 `session.event` 是唯一的事件通道。
 * ⚠️ 那个前提只对**握手成功过**的 client 成立：失败的 `start()` 会换一个新实例（见 `client` 那格）。
 */
export interface DshHarness {
  /**
   * 当前持有运行时子进程的客户端。**取用点现读**，不要缓存到局部变量里跨 `start()` 复用：
   * 真件是访问器，而 `start()` **失败**时会先清理、再换上一个新实例（旧的那个 `close()` 过后永久失效）
   * ⇒ 缓存值可能是已经关掉的旧实例，用它 `subscribe` 只会拿到一个「出生即失败」的订阅。
   * 适配器的顺序因此是「先 `await start()`，再建通知流，`prompt` 现读 `client`」。
   */
  readonly client: DshClient;
  start(): Promise<void>;
  run(input: string, options?: { sessionId?: string }): Promise<DshRunResult>;
  /**
   * `session/resume`：**adopt 一条已持久化的会话**（`dsh-sdk-jsonrpc-server@0.2.1-alpha.3`
   * 起才有这条 wire 方法与这个门面；装到更旧的客户端就没有这一格）。
   *
   * 三条已实测的围栏（见 `docs/faq/deepseek-harness.md`）：
   *   · 未知 id ⇒ 报 `not found`（**不是**静默新建一条空会话）；
   *   · 同进程重复 resume / 对已 open 的 id resume ⇒ `already open or opening`
   *     ⇒ **adopt 必须在该 id 的第一条 `prompt` 之前**；
   *   · 这条 wire 上**没有 cwd 闸**：换 cwd 不报错，会话用记录里的 cwd。
   *   · resume 之后通知流**不回放历史** ⇒ 恢复判据只能是暗号回读 + 磁盘转录。
   *
   * **可选**：缺这一格 = 当前安装的客户端没有这条能力 ⇒ 收到 `resume` 的适配器如实抛错，
   * 绝不换代成「开一条新会话」（那会让用户以为在追问、而智能体什么都不记得）。
   */
  resumeSession?: (sessionId: string) => Promise<DshSessionHandle>;
  close(): Promise<void>;
}

/** 构造选项（`DeepSeekHarnessOptions` 的窄结构）。 */
export interface DshHarnessOptions {
  /** 该行工作区（记录在 SDK 创建的会话头上） */
  cwd: string;
  /** 该行独立配置目录：SDK 把它落成子进程的 `DSH_HOME` */
  dshHome: string;
  /** dsh 进程自己的工作目录（默认 = 父进程 cwd） */
  processCwd: string;
  /** 该行的模型名 */
  model: string;
  /**
   * 该行走哪条 **provider 路由**（`GenerateOptions.provider`，默认 `deepseek-official`）。
   * 本仓传自己的路由键（`DSH_ROUTE_KEY`）：`initialize` 会先用 `llm.listProviders()` 校验它存在
   * （不认就抛 `no adapter registered for provider "…"`），再用 `resolveCallConfig` 校验
   * provider/model 可解析 ⇒ 路由与模型都必须在 boot 时就已注册（见 `patches`）。
   */
  provider?: string;
  /**
   * per-launch profile overlay（SDK 拼成 `--patch <path>`，**相对路径按宿主进程 cwd 解析**，
   * 故调用方必须给绝对路径）。它是最高层（bundle → profile → home → CLI），
   * 我们的路由与工具挂载都写在这里。
   */
  patches?: string[];
  /**
   * 初始 profile 握手的墙钟上限（`HarnessClientOptions.initializeTimeoutMs`，**SDK 默认 10000**）。
   *
   * 为什么必须由我们显式给：这一行**每次都跑在一个全新的 `configHome` 上**（不变量 3：
   * 每行独立配置目录），也就是说**每一次运行都是冷启动**——dsh 要把整棵插件树解析完才回 initialize。
   * 实测（`probe/v3/dsh-adapter-dual-protocol.mts`）：在 SDK 默认的 10s 下，
   * **两条协议双双**以 `initialize timed out after 10000ms waiting for dsh profile "sdk"` 收场，
   * 适配器把它折成 `AGENT_FAILED`——界面上只看到「这一行失败了」，而真实原因与协议、与凭据、
   * 与 overlay 内容都无关，正是本仓最忌讳的那类「症状离真因很远」的失败。
   */
  initializeTimeoutMs?: number;
  /**
   * 思考强度（`DeepSeekHarnessOptions.reasoningEffort`，值域由适配器插件定：`off/low/high/max`）。
   * 本仓按供应商声明的档位名原样透传。
   * ⚠️ **不给 ≠ 沿用模型默认**：实测「不给」落到 `reasoning:{effort:'none'}`，
   * 也就是**显式关闭**。缺省档由适配器显式给（`DSH_DEFAULT_EFFORT`），关闭只有显式 `off` 才发生。
   * ⚠️ 这一格 dsh 侧是**硬校验**的（不支持的档位报 `UNSUPPORTED_REASONING_EFFORT`）。
   */
  reasoningEffort?: string;
  /**
   * **完整的**子进程环境（替换型语义，调用方负责展开宿主环境）。
   * 类型用 `Record<string, string>` 而不是 `NodeJS.ProcessEnv`：本仓的 `buildSubprocessEnv` 返回前者，
   * 而真实 SDK 只把它透传给 `spawn`（两边的可赋值性在 spawn 处天然成立）。
   */
  env: Record<string, string>;
}

export interface DshSdkModule {
  DeepSeekHarness: new (options: DshHarnessOptions) => DshHarness;
}

/**
 * 适配器眼里「一个 dsh 运行时」的最小面：一条通知流 + 关闭。
 * 与 claude 的 `query` 句柄、codex 的 `Thread` 同一个抽象层级（`TurnStart.dispose` 消费它）。
 */
export type DshRuntime = DshHarness;

const loadRaw = createSdkLoader<unknown>(async () => import('@deepseek-ai/dsh-sdk-client'), DSH_PACKAGE_NAME);

/** 形状校验：认 `DeepSeekHarness` 是不是构造函数。 */
function hasHarnessCtor(raw: unknown): boolean {
  return typeof (raw as { DeepSeekHarness?: unknown } | null)?.DeepSeekHarness === 'function';
}

/** 懒加载 + 形状校验：形状不对与「包没装」都归 AGENT_LOAD_FAILED，但**文案必须分开**。
 * 期望入口从 `createRuntime`（探测前的假设）换成 `DeepSeekHarness`（实测），
 * 实测导出面一并写进文案，省掉一轮「你装的是哪个版本」。
 */
export async function loadDshSdk(): Promise<DshSdkModule> {
  const raw = await loadRaw();
  if (!hasHarnessCtor(raw)) {
    throw new AgentLoadError(DSH_PACKAGE_NAME, new Error('模块缺少 DeepSeekHarness 导出'), {
      variant: 'shape-mismatch',
      expected: 'DeepSeekHarness',
      actual: exportedNames(raw),
    });
  }
  return raw as DshSdkModule;
}
