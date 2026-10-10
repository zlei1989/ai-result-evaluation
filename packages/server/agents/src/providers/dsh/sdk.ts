/**
 * dsh 的厂商 SDK 懒加载外壳：**按真实探测回写后的入口形态**（Task 12 第 0 步）。
 * 这份窄结构不再是「探测前的假设」——它逐条对应安装态 `@deepseek-ai/dsh-sdk-client@0.2.0-rc.2` 的
 * `lib/types/{index,api,client,types,launch}.d.ts` 与 `lib/index.js`，实测记录见
 * "docs/protocols/dsh.md"（DSH 接入）与探测 dump。
 * 2026-10-09 从 0.1.7-rc.1 升到 **0.2.0-rc.2**（next 线最新非 alpha；该包从未发过非预发布版本）：
 * 客户端 `lib/` 两版**逐字节相同**（md5 一致，仅锁定的 runtime `@deepseek-ai/dsh` 0.1.7→0.2.0），
 * 真机双协议探针（`probe/v3/dsh-pi-ai-both.mjs`）升级后跑通含计量——本文件的窄结构无需任何改动：
 *
 *  - **值出口是 7 个**（`Object.keys` 排序后逐字）：
 *    `DeepSeekHarness` / `HarnessClient` / `HarnessSession` / `JsonRpcResponseError` /
 *    `RequestTimeoutError` / `SdkProtocolError` / `TransportClosedError` —— **没有 `createRuntime`**；
 *  - 真实入口是 `new DeepSeekHarness(options)` → `start()`（幂等的 spawn + initialize 握手）→
 *    `client.subscribeSessionTree(sessionId)` 拿通知流 → `run(prompt, { sessionId })` 交提示词，
 *    它在**下一次 idle** 落定（`lib/index.js:740-772`）；
 *  - 通知的外形是 `{ method, params }`（**不是** `{ type, message }`），method 只有四种：
 *    `session.event` / `session.status` / `subagent.started` / `subagent.finished`；
 *  - 停止只能靠 `harness.close()`（`HarnessClient.close()` 的 JSDoc 逐字：「There is no wire-level
 *    cancel: a timed-out request stays running server-side until the runtime is closed」）⇒
 *    `cancelMidTurn: false` 是实测结论，`close()` 是**必需**的释放出口（A7）。
 *
 * 注入落点（实测，与 spec §5.6.5 的口径有差异，见探测报告 §4/§5）：
 *  - 配置根是 `dshHome`（SDK 把它写成子进程的 `DSH_HOME`，`lib/index.js:161-190`），**不是 `HOME`**；
 *  - `env` 是**整体替换父进程环境**语义（`lib/types/types.d.ts` 的 `HarnessClientOptions.env`）⇒
 *    调用方必须自己展开宿主环境（本仓走 `buildSubprocessEnv`）；
 *  - **空 `configHome` 下凭据只能靠 `DEEPSEEK_API_KEY` 环境变量**：四格对照实测——
 *    `dshHome` 指向空目录且环境里没有这个变量时，运行必然以 `turn/end(kind:'error')` 收场
 *    （`llm-deepseek: no API key for provider route "deepseek-official"`）；补上变量即可跑通。
 */
import { AgentLoadError } from '../../errors';
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

/** 低层 JSON-RPC 客户端：只要我们要用的两格（订阅与关闭）。 */
export interface DshClient {
  subscribeSessionTree(sessionId: string): DshNotificationSubscription;
  subscribe(filter?: DshNotificationFilter): DshNotificationSubscription;
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
 * 高层入口 `DeepSeekHarness` 的窄结构（只声明用到的方法与字段；厂商类型面一律不 import，§5.6.2）。
 * `start()` 的幂等性来自实现（`this.initialized ??= …`），适配器因此可以在 `run()` 之前先把
 * 通知订阅挂上——否则「订阅之前到达的通知」会丢，而 `session.event` 是唯一的事件通道。
 */
export interface DshHarness {
  readonly client: DshClient;
  start(): Promise<void>;
  run(input: string, options?: { sessionId?: string }): Promise<DshRunResult>;
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
   * 为什么必须由我们显式给：这一行**每次都跑在一个全新的 `configHome` 上**（§5.6.5 不变量 3：
   * 每行独立配置目录），也就是说**每一次运行都是冷启动**——dsh 要把整棵插件树解析完才回 initialize。
   * 真机实测（Task 9，`probe/v3/dsh-adapter-dual-protocol.mts`）：在 SDK 默认的 10s 下，
   * **两条协议双双**以 `initialize timed out after 10000ms waiting for dsh profile "sdk"` 收场，
   * 适配器把它折成 `AGENT_FAILED`——界面上只看到「这一行失败了」，而真实原因与协议、与凭据、
   * 与 overlay 内容都无关，正是本仓最忌讳的那类「症状离真因很远」的失败。
   */
  initializeTimeoutMs?: number;
  /**
   * 思考强度（`DeepSeekHarnessOptions.reasoningEffort`，值域由适配器插件定：`off/low/high/max`）。
   * 本仓按供应商声明的档位名原样透传。
   * ⚠️ **不给 ≠ 沿用模型默认**（2026-10-06 更正）：实测「不给」落到 `reasoning:{effort:'none'}`，
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

/** 懒加载 + 形状校验：形状不对与「包没装」都归 AGENT_LOAD_FAILED，但**文案必须分开**（评审 M1）。
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

/**
 * 实测导出面（`Object.keys`），只用于 shape-mismatch 文案里的「实测有 …」。
 * 为什么先做形状检查：读导出面的动作本身不能成为新的崩溃点（`Object.keys(null)` 会抛）。
 */
function exportedNames(raw: unknown): string[] {
  return typeof raw === 'object' && raw !== null ? Object.keys(raw).sort() : [];
}
