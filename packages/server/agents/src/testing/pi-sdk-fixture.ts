/**
 * pi SDK 的**假件**：按真实入口的形状重写，供适配器用例在没有厂商包的前提下跑完整装配序列。
 *
 * 四条保真要求（比真实实现弱的地方就是守卫假绿的地方）：
 *  1. **方法名与选项名逐字对齐**厂商的 `.d.ts`（`DefaultResourceLoader` / `createAgentSession` /
 *     `SessionManager.{create,open,continueRecent}` / `SettingsManager.inMemory` / `ModelRuntime`）：
 *     假件用错名字时，适配器那边的拼写错误就再也测不出来；
 *  2. **`prompt()` 永不抛**（真实 pi 的失败只体现在 `stopReason` / `errorMessage` 上）；
 *  3. **订阅的取消函数真的断开投递**（真实 `subscribe` 返回的就是取消函数）——收尾有没有注销监听
 *     全靠这一格才可观测；
 *  4. **装配顺序可观测**：每一步都往 `assemblyOrder` 里记一笔，顺序错了当场看得见。
 *
 * `ModelRuntime` 那一格刻意**不模拟出站**：它记录「本次运行注册了哪个 provider、密钥进了哪一份内存表」，
 * 而真正的出站隔离由 `index.test.ts` 的并发用例拿**真包 + 本地假网关**证明
 * （假件证明不了「请求打到哪台」，那是夹具的性质而不是产品代码的性质）。
 */
import { join } from 'node:path';
import type { PiSkills } from '../providers/pi/sdk';
import { piSubagentsExtensionPath } from '../providers/pi/subagents';
import { PI_SUBAGENTS_MANAGER_KEY } from '../providers/pi/subagent-wire';

/**
 * 可推送事件的**假子会话**（`subagent-wire` 通道与子任务投影的用例共用）。
 *
 * 三条保真要求——比真实 `AgentSession` 弱的地方就是守卫假绿的地方：
 *  1. `subscribe` **真用 `this`**（监听者收在实例字段上，与 `_eventListeners` 同构）：
 *     调用方若把方法摘进新对象再调，`this` 丢失当场炸——不碰 `this` 的假件对这一类
 *     绑定缺陷永远绿；
 *  2. 订阅那一刻**同步吐出** `preloaded` 里排下的事件（与真实「提示词前已有排队的帧」同时序）；
 *  3. 退订函数**真的断开**投递（终态 / 收尾有没有注销监听靠它才可观测）。
 */
export function createFakePiChildSession(preloaded: unknown[] = [], messages: unknown[] = []) {
  const session = {
    /** 轮次基数：订阅时已完成的助手消息数（真实形态是 `session.messages` getter） */
    messages,
    subscribe(
      this: { listeners: Array<(event: unknown) => void>; queued: unknown[] },
      listener: (event: unknown) => void,
    ): () => void {
      this.listeners.push(listener);
      for (const event of this.queued) listener(event);
      return () => {
        const index = this.listeners.indexOf(listener);
        if (index >= 0) this.listeners.splice(index, 1);
      };
    },
    listeners: [] as Array<(event: unknown) => void>,
    queued: preloaded,
    emit(event: unknown): void {
      for (const listener of [...this.listeners]) listener(event);
    },
    get listenerCount(): number {
      return session.listeners.length;
    },
  };
  return session;
}

export interface FakePiRecorder {
  /** 装配顺序：`resource-loader` → `reload` → `runtime` → `create-session` → `bind-extensions` */
  assemblyOrder: string[];
  /** `DefaultResourceLoader` 拿到的选项原文 */
  loaderOptions: Record<string, unknown> | null;
  /** 每次 `reload` 拿到的选项（判「信任开关显式给」，以及兜底那一次） */
  reloadOptions: Array<Record<string, unknown> | undefined>;
  /** `createAgentSession` 拿到的选项原文 */
  sessionOptions: Record<string, unknown> | null;
  /** `bindExtensions` 拿到的选项原文（`mode` 必须是 `'rpc'`） */
  bindings: Record<string, unknown> | null;
  /** `ModelRuntime.create` 拿到的选项原文（凭据通道与 `modelsPath` 的判据） */
  runtimeOptions: Record<string, unknown> | null;
  /** 本次运行注册的 provider id 与配置 */
  registered: Array<{ providerId: string; config: Record<string, unknown> }>;
  /** 已注销的 provider id */
  unregistered: string[];
  /** **哪一份凭据存储**收到了哪个 provider 的密钥（并发隔离的最小判据） */
  runtimeKeys: Array<{ store: unknown; providerId: string; apiKey: string }>;
  /** 送进 `prompt()` 的提示词 */
  prompts: string[];
  /** 被请求的模型（`getModel` 的入参） */
  askedModels: Array<{ providerId: string; modelId: string }>;
  /** 释放次数（`dispose()` 幂等的判据） */
  disposeCount: number;
  /** 取消次数（`abort()`） */
  abortCount: number;
  /** 等在 `waitForIdle()` 上的次数 */
  waitForIdleCount: number;
  /** 订阅注册 / 取消的次数（判「订阅先于提示词、且收尾时取消了」） */
  subscribeCount: number;
  unsubscribeCount: number;
  /** 待投递的事件（`emit()` 未调用时，订阅一建立就把它们**同步**吐完） */
  events: unknown[];
  /** 手动投递一条（订阅已建立时立即交给它；否则排队等订阅） */
  emit: (event: unknown) => void;
  /** 释放挂住的 `prompt()`（`abort()` 与 `dispose()` 都会调，模拟「关掉运行时让在途轮次结束」） */
  releaseStream: (() => void) | null;
  /** 装载器返回的技能表（`skillsOverride` 应用之后的结果） */
  skills: PiSkills;
  /** 装载器返回的扩展表（运行期断言的判据） */
  extensions: Array<{ path: string }>;
  /**
   * 我们经 `extensionFactories` 装进去的那些工厂收到的注册面：事件名 → 处理器。
   * 真实 pi 在**扩展绑定时**调用工厂（`(pi) => void`），故这里也只在 `bindExtensions` 那一刻填。
   */
  extensionHandlers: Record<string, Array<(event: unknown) => void>>;
  /** `createMcpExtension` 拿到的选项原文（判据：`loadConfig` 自给、`startupWaitMs` 显式） */
  mcpExtensionOptions: Record<string, unknown> | null;
  /** 装过 MCP 扩展吗（`input.mcpServers` 不给时必须是 false） */
  mcpExtensionInstalled: boolean;
  /**
   * 本会话的身份（厂商 `AgentSession.sessionId`）。
   *
   * 可写：它是**转写文件路径**的一格（派发扩展按父会话的这个 id 分目录），
   * 用例要能把它指到一份自己造的转写上，才验得了「收尾读转写」这条路。
   */
  sessionId: string;
  /**
   * 本会话的落盘路径（厂商 `AgentSession.sessionFile`）；`undefined` = 这条会话不落盘。
   *
   * 由会话管理器的两条构造路径按厂商的命名规则写：`create` 在给定目录下现拼一个
   * `<ISO 时间戳>_<会话 id>.jsonl`（时间戳固定成一个定值，好让用例拿它当**独立字面量**判据），
   * `open` 原样记下传进来的路径。可写：用例要造「会话文件不存在」的姿态。
   */
  sessionFile: string | undefined;
  /**
   * 会话管理器的构造调用，顺序即调用顺序（`{kind:'create'|'open'|'continueRecent', …}`）。
   * 判据取它：**续接必须走 `open(会话文件)`，不许走 `continueRecent`**（后者取目录里 mtime 最新）。
   */
  sessionManagerCalls: Array<Record<string, string | undefined>>;
  /** 真被投出去的两档（`steer` = `'round'`、`followUp` = `'idle'`）；空数组 = 一次都没投 */
  steering: string[];
  followUps: string[];
  /**
   * 假件往 `globalThis[Symbol.for("pi-subagents:manager")]` 挂注册表条目的次数。
   *
   * 真实 pi 在 `loader.reload()` 里执行扩展工厂（claim 点就在那里）；假件在同一位置挂
   * **可配置的**假条目（`FakePiSdkOptions.registryEntryFactory`），产品侧的
   * 「reload 后快照 + 删槽」由此可在假件上观测。
   */
  registryClaims: number;
  /**
   * 释放序列里**扩展侧**收到过什么（本次运行装了会听 `session_shutdown` 的扩展时才有内容）：
   * 元素形如 `session_shutdown:quit`。与 `releaseOrder` 一起用，才判得出「发在 dispose 之前」。
   */
  extensionShutdowns: string[];
  /** 释放序列的到达序（`session_shutdown:…` / `dispose`），判「按厂商那条顺序」 */
  releaseOrder: string[];
}

export function createFakePiRecorder(): FakePiRecorder {
  return {
    assemblyOrder: [],
    loaderOptions: null,
    reloadOptions: [],
    sessionOptions: null,
    bindings: null,
    runtimeOptions: null,
    registered: [],
    unregistered: [],
    runtimeKeys: [],
    prompts: [],
    askedModels: [],
    disposeCount: 0,
    abortCount: 0,
    waitForIdleCount: 0,
    subscribeCount: 0,
    unsubscribeCount: 0,
    events: [],
    emit: () => {},
    releaseStream: null,
    skills: { skills: [], diagnostics: [] },
    extensions: [],
    extensionHandlers: {},
    mcpExtensionOptions: null,
    mcpExtensionInstalled: false,
    sessionId: 'fake-pi-session',
    sessionFile: undefined,
    sessionManagerCalls: [],
    steering: [],
    followUps: [],
    registryClaims: 0,
    extensionShutdowns: [],
    releaseOrder: [],
  };
}

export interface FakePiSdkOptions {
  recorder: FakePiRecorder;
  /**
   * 每次 `reload` 往 `globalThis[Symbol.for("pi-subagents:manager")]` 挂的**假注册表条目**。
   *
   * 真实 pi 在 reload 里执行子智能体扩展的工厂（claim 点），假件在同一位置挂这一份——
   * 缺省 `{ getRecord: () => undefined }`（扩展在表里、但没有任何子会话记录，绝大多数用例
   * 的姿态）；给 `null` 模拟「claim 没发生」（快照落空 ⇒ wire 通道降级那一条通路）。
   * **每次 reload 现造一份**：真机上每次工厂执行都 `new AgentManager`，并发两本次运行的隔离判据
   * （两行各自快照到不同的条目）靠这一份新实例成立。
   */
  registryEntryFactory?: (() => unknown) | null;
  /**
   * `reload` 之后装载器报告的扩展（**运行期断言的输入**），**含我们白名单的那一条**。
   *
   * 缺省 = 只有子智能体扩展那一条（生产上就是它）：适配器对「白名单那一条真的在表里」有一条断言，
   * 假件不给它就会让每一条走装配的用例都以「扩展没装载」失败——那是夹具失真，不是被测对象的问题。
   * 想造「白名单没装上」的姿态就显式给一份不含它的表。
   *
   * 给一条**发现来的**路径（不是 `<inline:`、不在 `configHome` 之下、也不在白名单里）就能造出
   * 「`noExtensions` 失效」，兜底分支因此可被测试到。第 N 次 `reload` 取数组第 N 项（兜底会再
   * `reload` 一次）。
   */
  extensionsAfterReload?: Array<Array<{ path: string }>>;
  /**
   * `reload` 之后装载器报告**技能发现的原始结果**（`skillsOverride` 的入参）。
   * 用它造「HOME 锚定的个人技能」与「项目技能」两档，判谓词只留后者。
   */
  discoveredSkills?: Array<{ name: string; filePath: string }>;
  /** `createAgentSession` 抛错（判「装配失败」的姿态） */
  createError?: unknown;
  /** `prompt()` 之后挂住不 resolve（测取消与看门狗） */
  hangPrompt?: boolean;
  /**
   * 模拟「本次运行装了会听 `session_shutdown` 的扩展」——生产中就是 MCP 扩展那一档
   * （它把连接清理挂在那个事件上）。开了之后假件的 `hasHandlers('session_shutdown')` 为真、
   * `emit` 会把事件派给这个处理器并记进 `releaseOrder`：释放序列有没有按厂商顺序补上那一发，
   * 因此是一条可断言的事实而不是注释里的承诺。
   */
  shutdownListener?: boolean;
  /**
   * 一次模型往返发出去**之前**，`before_provider_request` 依次拿到的 payload。
   * 真实 pi 在这一刻调扩展（观察者的取证点就是它）；不给 = 这个钩子一次都不发。
   */
  requestPayloads?: unknown[];
  /**
   * 装载器报告的技能**诊断**（`skillsOverride` 的入参里那份）。
   * 同名冲突（`type: 'collision'`）只有从这里进得来。
   */
  skillDiagnostics?: unknown[];
}

/**
 * 造一份假 pi SDK：`sdkModule` 注入表的两个包名各给一份。
 * `pi-ai` 那一格的凭据存储是**每个 runtime 一份新实例**（真实实现就是纯内存对象），
 * 于是「两行有没有共用一份凭据表」在假件上也可观测。
 */
export function createFakePiSdk(options: FakePiSdkOptions): Record<string, unknown> {
  const { recorder } = options;
  let reloadCount = 0;
  let listener: ((event: unknown) => void) | null = null;

  // 订阅没建立时先排队：真实 pi 的 `prompt()` 一进去才开始产事件，而适配器**先订阅再交提示词**
  recorder.emit = (event) => {
    if (listener === null) recorder.events.push(event);
    else listener(event);
  };

  /**
   * 凭据存储：**每一份记住自己收到了谁的密钥**。
   *
   * 为什么这一格必须记在实例上而不是 recorder 上：判据是「两行有没有共用一个凭据存储」，
   * 而共用与各一份在 recorder 那一层长得一样（都只是一串写入）。记在实例上之后，
   * 「两次运行写进了同一个对象」成为一条可断言的事实。
   */
  class FakeCredentialStore {
    readonly kind = 'InMemoryCredentialStore';

    readonly writes: string[] = [];
  }

  class FakeResourceLoader {
    constructor(readonly options: Record<string, unknown>) {
      recorder.loaderOptions = options;
      recorder.assemblyOrder.push('resource-loader');
    }

    getSkills(): PiSkills {
      return recorder.skills;
    }

    getExtensions(): { extensions: Array<{ path: string }>; errors: unknown[] } {
      return { extensions: recorder.extensions, errors: [] };
    }

    async reload(reloadOptions?: Record<string, unknown>): Promise<void> {
      recorder.assemblyOrder.push('reload');
      recorder.reloadOptions.push(reloadOptions);
      const override = this.options.skillsOverride as ((base: PiSkills) => PiSkills) | undefined;
      const discovered = options.discoveredSkills ?? [];
      const diagnostics = options.skillDiagnostics ?? [];
      recorder.skills = override === undefined
        ? { skills: discovered, diagnostics }
        : override({ skills: discovered, diagnostics });
      recorder.extensions = options.extensionsAfterReload?.[reloadCount]
        ?? [{ path: piSubagentsExtensionPath() }];
      reloadCount += 1;
      /**
       * 厂商侧的 claim：真实 pi 的扩展工厂在 reload 里执行并按「槽为空才写」挂 manager 注册表
       * （先到先得）。假件照抄这条语义——产品侧若忘了「快照后删槽」，第二本次运行的 claim 就会
       * 落空、整行退回转写通道，`index.test.ts` 的按 run 划界用例当场红。
       */
      if (options.registryEntryFactory !== null) {
        const slot = (globalThis as Record<symbol, unknown>)[PI_SUBAGENTS_MANAGER_KEY];
        if (slot === undefined) {
          recorder.registryClaims += 1;
          (globalThis as Record<symbol, unknown>)[PI_SUBAGENTS_MANAGER_KEY] =
            (options.registryEntryFactory ?? (() => ({ getRecord: () => undefined })))();
        }
      }
    }
  }

  class FakeModelRuntime {
    static async create(runtimeOptions: Record<string, unknown>): Promise<FakeModelRuntime> {
      recorder.runtimeOptions = runtimeOptions;
      recorder.assemblyOrder.push('runtime');
      return new FakeModelRuntime(runtimeOptions);
    }

    constructor(readonly options: Record<string, unknown>) {}

    registerProvider(providerId: string, config: Record<string, unknown>): void {
      recorder.registered.push({ providerId, config });
    }

    async setRuntimeApiKey(providerId: string, apiKey: string): Promise<void> {
      const store = this.options.credentials as FakeCredentialStore;
      store.writes.push(`${providerId}=${apiKey}`);
      recorder.runtimeKeys.push({ store, providerId, apiKey });
    }

    unregisterProvider(providerId: string): void {
      recorder.unregistered.push(providerId);
    }

    getModel(providerId: string, modelId: string): unknown {
      recorder.askedModels.push({ providerId, modelId });
      return { provider: providerId, id: modelId };
    }
  }

  /**
   * 扩展绑定的收尾：真实 pi 在这里把 `extensionFactories` 逐个调起来（`(pi) => void`），
   * 扩展的注册面（`pi.on(...)` / `pi.registerTool(...)`）只有这一刻之后才存在。
   * 假件只实现我们真正用到的那一格（`on`），其余方法一律不给——多实现一格就多一处「产品代码
   * 用了假件支持、真机不支持」的假绿。
   */
  const fireProviderRequest = (payload: unknown): void => {
    for (const handler of recorder.extensionHandlers['before_provider_request'] ?? []) handler({ payload });
  };

  const session = {
    subscribe: (next: (event: unknown) => void): (() => void) => {
      recorder.subscribeCount += 1;
      listener = next;
      // 订阅建立之前排下的事件在这里**同步**吐完（与真实时序同构：提示词发出后事件才到）
      while (recorder.events.length > 0) next(recorder.events.shift());
      return () => {
        recorder.unsubscribeCount += 1;
        listener = null;
      };
    },
    prompt: async (text: string): Promise<void> => {
      recorder.prompts.push(text);
      // 请求侧钩子在「提示词发出、事件回来之前」：观察者的取证点就是它
      for (const payload of options.requestPayloads ?? []) fireProviderRequest(payload);
      if (options.hangPrompt !== true) return;
      await new Promise<void>((resolve) => {
        recorder.releaseStream = resolve;
      });
    },
    abort: async (): Promise<void> => {
      recorder.abortCount += 1;
      recorder.releaseStream?.();
    },
    waitForIdle: async (): Promise<void> => {
      recorder.waitForIdleCount += 1;
    },
    dispose: (): void => {
      recorder.disposeCount += 1;
      recorder.releaseOrder.push('dispose');
    },
    /**
     * 厂商 `AgentSession.extensionRunner` 的公开面（只有我们用到的那两格）。
     * `hasHandlers` 读的是**真注册过**的那些（与真件同义）；`emit` 把事件派给它们。
     */
    extensionRunner: {
      hasHandlers: (eventType: string): boolean => (recorder.extensionHandlers[eventType]?.length ?? 0) > 0,
      emit: async (event: unknown): Promise<unknown> => {
        for (const handler of recorder.extensionHandlers[(event as { type?: string } | null)?.type ?? ''] ?? []) {
          handler(event);
        }
        return undefined;
      },
    },
    bindExtensions: async (bindings: Record<string, unknown>): Promise<void> => {
      recorder.bindings = bindings;
      recorder.assemblyOrder.push('bind-extensions');
      const factories = (recorder.loaderOptions?.['extensionFactories'] as Array<(pi: unknown) => void> | undefined) ?? [];
      const pi = {
        on: (event: string, handler: (payload: unknown) => void): void => {
          (recorder.extensionHandlers[event] ??= []).push(handler);
        },
        /**
         * **跨扩展事件总线**（真实形状：`pi.events` 是 EventEmitter2 实例，`pi.events.on(channel, handler)`）。
         * 与上面的 `pi.on` 是**两张面**：那一张是扩展自己的生命周期钩子，这一张是扩展之间互相通信的频道
         * （子智能体扩展在它上面发 `subagents:started/completed/failed`）。两张都要给，
         * 否则「装上了取数器却收不到任何子任务事件」这种缺陷在夹具里永远看不见。
         */
        events: {
          on: (channel: string, handler: (payload: unknown) => void): void => {
            (recorder.extensionHandlers[channel] ??= []).push(handler);
          },
        },
      };
      for (const factory of factories) factory(pi);
      if (options.shutdownListener === true) {
        pi.on('session_shutdown', (event: unknown) => {
          const reason = (event as { reason?: unknown } | null)?.reason;
          recorder.extensionShutdowns.push(`session_shutdown:${typeof reason === 'string' ? reason : 'unknown'}`);
          recorder.releaseOrder.push(`session_shutdown:${typeof reason === 'string' ? reason : 'unknown'}`);
        });
      }
    },
    getLastAssistantText: (): string | undefined => 'fake-final-text',
    // 取值走 getter：用例改了 `recorder.sessionId` 之后，适配器下一次读到的是新值
    get sessionId(): string {
      return recorder.sessionId;
    },
    /** 落盘路径同一条处置：管理器那两条构造路径写它，适配器收尾读它 */
    get sessionFile(): string | undefined {
      return recorder.sessionFile;
    },
    /**
     * 投递的两档：假件只记「谁在什么时候说了什么」，返回值照厂商的三态给 `'queued'`。
     * 真实实现的语义（`'handled'` = 被扩展当场吃掉、空闲时也照收不误）见 `PiSession.steer` 的注释；
     * 本仓今天还没接投递面，故这一格只用来钉「声明里那两件真的在会话上」。
     */
    steer: async (text: string): Promise<'handled' | 'queued'> => {
      recorder.steering.push(text);
      return 'queued';
    },
    followUp: async (text: string): Promise<'handled' | 'queued'> => {
      recorder.followUps.push(text);
      return 'queued';
    },
  };

  return {
    '@earendil-works/pi-coding-agent': {
      DefaultResourceLoader: FakeResourceLoader,
      ModelRuntime: FakeModelRuntime,
      /**
       * 文件型会话管理器的三条构造路径（`inMemory` **刻意不给**：适配器已经不用它了，
       * 假件留着它等于给「悄悄退回内存」留一条永远绿的路）。
       *
       * `create` 按厂商的命名规则现拼一个落盘路径（时间戳固定成定值 ⇒ 用例可以拿一个字面量判据），
       * `open` 原样记下路径；`continueRecent` 在**调用时**就往 recorder 里记一笔，
       * 于是「适配器改回 continueRecent」是一条可断言的事实，而不是一段注释里的承诺。
       */
      SessionManager: {
        create: (cwd: string, sessionDir?: string): Record<string, unknown> => {
          recorder.sessionManagerCalls.push({ kind: 'create', cwd, sessionDir });
          recorder.sessionFile = join(sessionDir ?? cwd, `2000-01-01T00-00-00-000Z_${recorder.sessionId}.jsonl`);
          return { kind: 'file-session', cwd, sessionDir };
        },
        open: (path: string): Record<string, unknown> => {
          recorder.sessionManagerCalls.push({ kind: 'open', path });
          recorder.sessionFile = path;
          return { kind: 'file-session', path };
        },
        continueRecent: (cwd: string, sessionDir?: string): Record<string, unknown> => {
          recorder.sessionManagerCalls.push({ kind: 'continueRecent', cwd, sessionDir });
          return { kind: 'file-session', cwd, sessionDir };
        },
      },
      SettingsManager: { inMemory: (settings?: unknown) => ({ kind: 'memory-settings', settings }) },
      /**
       * MCP 扩展工厂：真实实现返回 `(pi) => void`（在 `bindExtensions` 时被调）。
       * 假件只把选项原文记下来——本仓要判的两件事（`loadConfig` 自给、`exposure` 逐台 `direct`）
       * 都在**选项**里，不在它的运行期行为里。
       */
      createMcpExtension: (extensionOptions: Record<string, unknown>): ((pi: unknown) => void) => {
        recorder.mcpExtensionOptions = extensionOptions;
        recorder.mcpExtensionInstalled = true;
        return () => {};
      },
      createAgentSession: async (sessionOptions: Record<string, unknown>): Promise<{ session: unknown }> => {
        recorder.sessionOptions = sessionOptions;
        recorder.assemblyOrder.push('create-session');
        if (options.createError !== undefined) throw options.createError;
        return { session };
      },
    },
    '@earendil-works/pi-ai': { InMemoryCredentialStore: FakeCredentialStore },
  };
}
