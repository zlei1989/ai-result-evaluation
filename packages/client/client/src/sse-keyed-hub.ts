/**
 * 按「键」共享的 SSE 连接原语：**连接管理 + 解帧 + 扇出**三件事，与业务无关。
 *
 * 为什么要有这一层：一条流一旦被多个消费方共用（同一行同一 channel 的事件与消息由两个 hook 各自
 * 折叠），「谁开连接、什么时候关、一帧派给谁」就必须只有一份判据。每个 hook 自己 `new EventSource`
 * 的话，同一份 URL 会开出 N 条连接、各自维护监听器与重连，而症状是「连接数莫名其妙地涨」——
 * 界面上完全看不出来，只有 Network 面板能看见。
 *
 * 三条与浏览器语义对齐的口径：
 *   1. **具名事件必须逐个 `addEventListener`**：SSE 规范里 `onmessage` **只收无名事件**，而本仓的
 *      SSE 帧一律带 `event: <type>` 行 ⇒ 只绑 `onmessage` 等于零交付（历史靠 REST、终态靠轮询兜底，
 *      症状只表现为「实时通道没有」，因而极难发现）。故 `eventNames` 由各条流按自己的帧清单给。
 *   2. **`error` 这个名字有两个来源**：`EventSource` 的连接失败事件，与服务端发的具名 `error` 帧。
 *      两者都落在 `onerror` 属性上 ⇒ 这里按**帧的形状**分流（带 `data` 的是服务端帧、走正常解析；
 *      不带 `data` 的才是连接故障），并把它从 `eventNames` 里排除（再 `addEventListener('error')`
 *      会让同一帧被投递两次）。
 *   3. **无名帧仍留兜底**：`onmessage` 照旧接一帧处理函数——服务端哪天不发 `event:` 行了也照样能用。
 *
 * **解帧只做「SSE 帧 → 业务帧」这一步**：`parse` 由各条流给（抽屉流按 contracts 的信封契约校验），
 * 返回 `null` 即坏帧——坏帧只跳过它自己并通知 sink，**绝不许打断整条流**（一个畸形帧让抽屉
 * 从此不再刷新，是这条链上最难查的故障）。
 *
 * ⚠️ 本文件是「键控 SSE hub」的**第一个实例**（抽屉流）。聚合流落地时应当直接复用这里
 * （`createKeyedSseHub` 再实例化一次即可），不要再写第二份连接管理。
 */

/** 一个订阅者：hub 只认识这几个回调，怎么折叠数据是各 hook 自己的事 */
export interface SseSink<TFrame> {
  /** 一帧到手（已解析成 `TFrame`，且属于这个键） */
  onFrame(frame: TFrame): void;
  /** 连接建立：连接状态点转「实时连接中」，并把上一次的故障原因清掉 */
  onOpen?(): void;
  /** 连接故障（浏览器会自己重连）：参数是各条流自己那句中文 */
  onError?(message: string): void;
  /** 一帧解不动（坏帧只跳过它自己，绝不许打断整条流） */
  onInvalidFrame?(): void;
}

export interface KeyedSseHubOptions<TFrame> {
  /**
   * 键 → 连接 URL。`cursor` 是**开这一条连接的那个订阅者**给出的续订游标
   * （同一键的后来者共用这条连接，游标以先到的为准，见 `subscribe`）。
   */
  url(key: string, cursor: number): string;
  /** 这条流的具名事件清单（`error` 不必列，它由 `onerror` 那条路承载） */
  eventNames: readonly string[];
  /** `data` 文本 → 帧；坏帧返回 `null`（由 `onInvalidFrame` 处置） */
  parse(data: string): TFrame | null;
  /** 连接故障时交给 sink 的那句中文 */
  disconnected: string;
}

export interface KeyedSseHub<TFrame> {
  /**
   * 订阅一个键，返回退订函数。
   *
   * `cursor` 只在**这个键从零到一**那一刻起作用（开连接用）：同一行同一 channel 的事件与消息
   * 由两个 hook 各自订阅，先拿到历史的那一个决定续订起点；后来者共用同一条连接，
   * 多出来的回放由它自己按 seq / mergeKey 去重（少传一段历史才是错的，多传不是）。
   *
   * 退订幂等（React 的 effect 清理可能跑两遍）；最后一个订阅者退订即关连接并摘干净监听器。
   */
  subscribe(key: string, sink: SseSink<TFrame>, cursor?: number): () => void;
  /** 当前开着的连接数（用例断言「两个 sink 一条连接」「归零关连接」；生产代码不读它） */
  openCount(): number;
  /** 关掉全部连接并清空状态（用例之间不串连接） */
  reset(): void;
}

/** 一条连接：浏览器原生 `EventSource` + 它的订阅者 + 它自己挂上去的具名监听器 */
interface Connection<TFrame> {
  source: EventSource;
  sinks: Set<SseSink<TFrame>>;
  /** `close` 要按同一对 (类型, 函数) 摘掉它们，否则替身/浏览器上都留着悬挂引用 */
  named: Array<{ type: string; listener: (event: MessageEvent) => void }>;
}

/**
 * 这两个事件名由 `on<name>` 属性处理器承载，**不许**再 `addEventListener`：
 *   · `error`：`onerror` 既收连接失败、又收服务端发的具名 `error` 帧（按帧形状分流）；
 *   · `message`：SSE 的**默认事件类型**，`onmessage` 属性就是它的处理器——下面那行
 *     `onmessage = handleFrame` 已经把它接住了（无名帧也走它）。再挂一条监听器会让每一帧
 *     投递两次：真实浏览器里具名 `message` 事件**同时**派发给 `onmessage` 与
 *     `addEventListener('message')` 的监听器，而重复投递对事件流是「日志里两遍同一行」。
 */
const PROPERTY_HANDLED_EVENTS: ReadonlySet<string> = new Set(['error', 'message']);

export function createKeyedSseHub<TFrame>(options: KeyedSseHubOptions<TFrame>): KeyedSseHub<TFrame> {
  const connections = new Map<string, Connection<TFrame>>();

  /**
   * 逐个 sink 地投递：一个 sink 抛错不该让同一条连接上的另一个 sink 收不到这一帧
   * （与浏览器 `EventTarget.dispatchEvent` 的既有语义一致：一个监听器抛错不打断其余监听器）。
   */
  const fanOut = (connection: Connection<TFrame>, deliver: (sink: SseSink<TFrame>) => void): void => {
    for (const sink of [...connection.sinks]) {
      try {
        deliver(sink);
      } catch (error) {
        // 报错但吞掉：消费方是 React 的 setState 与折叠函数，它们的异常不该让这条连接上的
        // 另一个消费方（另一个抽屉数据）跟着断流
        console.error('SSE 帧的消费方抛错（其余订阅者照常收到）', error);
      }
    }
  };

  /** 关掉某一条连接（幂等）：先摘监听器再关——「连接已关、监听器还挂着」在真实浏览器里是纯泄漏 */
  const close = (key: string, target: Connection<TFrame>): void => {
    if (connections.get(key) !== target) return;
    connections.delete(key);
    for (const { type, listener } of target.named) target.source.removeEventListener(type, listener);
    target.named.length = 0;
    target.source.close();
  };

  /** 开一条连接：建 source、挂监听器（订阅者随后加入） */
  const open = (key: string, cursor: number): Connection<TFrame> | null => {
    // 环境没有 EventSource（老浏览器 / 测试替身缺失）时不能抛：调用方的 REST 通路照旧，
    // 只是没有实时增量——各 hook 自己决定要不要因此给一句人话
    if (typeof EventSource === 'undefined') return null;

    const connection: Connection<TFrame> = { source: new EventSource(options.url(key, cursor)), sinks: new Set(), named: [] };
    connections.set(key, connection);

    /** 一帧的解析与派发：坏帧只通知，不打断 */
    const handleFrame = (event: MessageEvent): void => {
      const frame = options.parse(String(event.data));
      if (frame === null) {
        fanOut(connection, (sink) => sink.onInvalidFrame?.());
        return;
      }
      fanOut(connection, (sink) => sink.onFrame(frame));
    };

    connection.source.onopen = () => fanOut(connection, (sink) => sink.onOpen?.());
    connection.source.onerror = (event: Event) => {
      // 带 `data` 的是服务端发的具名 `error` 帧（`type: 'error'` 的 AgentEvent 确实会被发布）；
      // 不带 `data` 的才是连接故障——判据用 `typeof data === 'string'`，与真实 `MessageEvent` 同形
      const data = (event as MessageEvent).data;
      if (typeof data === 'string') {
        handleFrame(event as MessageEvent);
        return;
      }
      fanOut(connection, (sink) => sink.onError?.(options.disconnected));
    };

    for (const type of options.eventNames) {
      if (PROPERTY_HANDLED_EVENTS.has(type)) continue;
      const listener = (event: MessageEvent): void => handleFrame(event);
      connection.named.push({ type, listener });
      connection.source.addEventListener(type, listener);
    }
    // 默认事件类型（无名帧 + 具名 `message` 帧）的处理器：它同时是上面那张表的例外，见常量注释
    connection.source.onmessage = handleFrame;
    return connection;
  };

  return {
    subscribe(key, sink, cursor = 0) {
      const connection = connections.get(key) ?? open(key, cursor);
      connection?.sinks.add(sink);

      let done = false;
      return () => {
        if (done) return;
        done = true;
        if (connection === null) return;
        connection.sinks.delete(sink);
        // 归零即关：抽屉关掉之后不该留一条只发心跳的长连接
        if (connection.sinks.size === 0) close(key, connection);
      };
    },
    openCount() {
      return connections.size;
    },
    reset() {
      for (const [key, connection] of [...connections]) close(key, connection);
    },
  };
}
