/**
 * 提问应答的判据——**独立模块**，供一致性套件接线。
 *
 * 为什么单列成模块而不是直接写进 `kit.ts`：套件那一份是「与厂商无关」的判据集合，而这一组的输入形状
 * 与消息归一无关（它只看 `AskUserProbe` 那几格），独立成模块后接线只需在套件里加一行，且本模块能被
 * 自测直接调用（每条判据都要见过失败）。与 `structured-output.ts` / `transport.ts` 同源。
 *
 * **这一组判的是什么、不判什么**（边界必须写在这里，别让读者以为它证了接线）：
 *   · 判：**端口那一半**——回调真被调用一次且入参形状对、问答两端拿到的答复是同一份、
 *     **提问那一半真的进了内容账本**（`checkAskUserLedger`，卡片唯一的驱动）、
 *     不传回调时一次都不调用且产物逐字不变；
 *   · 不判：**适配器那一半**——「厂商的提问请求真的到了我们手里」「答复真的从适配器的钩子回到了厂商」。
 *     那两条要厂商自己的通道（权限回调 / 服务端请求 / 宿主工具 / 插件），由各家的接线票接上。
 *     因此**声明 `askUser: yes` 之前，这一组还不构成证明**；接上之后本模块的判据一条都不用改：
 *     场景改由真钩子驱动，探针的三格事实照旧。
 *
 * 事实来源是**这一次运行**（不是夹具自述）：`calls` / `requests` / `replies` 由端口产生，
 * `answerFrame` 由端口交回的答复装帧而来，`control` 那三格来自**真的又跑了一遍**的对照运行。
 *
 * **「不传回调 ⇒ 产物逐字相同」那一格按 `askUserChannel` 分两档**（通道是 `metadata.interaction`
 * 上的一等字段，这里不按家名分支）：
 *
 *   · **`vendor-tool`**（模型看到的提问工具由厂商提供）：对照运行与带回调那一次的产物指纹**逐字相同**，
 *     不放宽。厂商那一端的提问行为由它自己的开关或钩子决定，撤掉应答面不会让同一条剧本多出任何东西。
 *   · **`host-tool`**（工具由我们自己注册）：这一档**结构上做不到指纹相等**——装配面与「有没有应答面」
 *     绑在一起（不传回调就不注册那件工具，这是「不问就不动」在宿主工具这条通道上的落点），于是同一条
 *     剧本里的那一问在对照运行里必然落成一条「工具不存在」的错误结果。这是这一档**自带**的差异，
 *     不是回归。判据因此换成两条**等价强度**的事实：把那一件工具（调用块与结果块、带它的行级事件、
 *     厂商载荷里的提示词分段与工具清单、厂商工具表里的同名条目）归一到同一形态之后两臂指纹仍要逐字
 *     相同，外加「对照臂的出站工具表里没有那个名字」与「那一问拿到工具不存在类错误原文」。
 *     归一**只**抹掉那件工具本身，其余每一个字节照旧参与比对——放宽的是那一格，不是整份判据。
 */
import type { AskUserChannel, AskUserQuestion } from '@aieval/contracts';
import type { AskUserReply, AskUserRequest } from '../../types';
import type { ConformanceProduct } from './kit';

/** 一次提问里那一份「按该家应答形状装帧」的结果（形状各家自定，判据只查答复有没有真的进去） */
export interface AskUserProbe {
  /** 带回调那一次：回调真被调用了几次（必须恰好一次：重复问人＝同一个问题问两遍） */
  calls: number;
  /** 回调收到的入参（按调用顺序）；形状由 `ask-user-types.test.ts` 在类型层钉住，这里判运行期的值 */
  requests: AskUserRequest[];
  /** 端口交回给调用方的那一份答复（按调用顺序） */
  replies: AskUserReply[];
  /**
   * 端口交回的答复按**该家应答形状**装帧之后的样子（各家一份字面量，见该家用例的「应答帧挂载守卫」）。
   * 产者按家不同：接了真钩子的家由**适配器**产出（夹具从 side channel 或工具结果里读它），
   * 还没接的由夹具装——判据只看「答复有没有真的进到帧里」，两种产者一视同仁。
   */
  answerFrame: unknown;
  /**
   * **不传回调的对照运行**：同一条夹具、同一份载荷，只去掉回调。
   * 三格缺一不可——「不问就不动」这条边界要能被断言成「一次都没调用 + 立即无人应答 + 产物逐字不变」。
   * ⚠️ 最后那一格只在 `vendor-tool` 通道上成立（`host-tool` 的控制臂少一件工具，见文件头那条边界）。
   */
  control: {
    calls: number;
    reply: AskUserReply | null;
    /**
     * 两次运行的产物指纹，两份都由 `askUserProductDigest` 从**真产物**算出来。
     * 为什么是指纹而不是夹具算好的布尔：夹具自述的「一样」没有区分力，判据自己比对才有。
     */
    digestWithCallback: string;
    digestWithoutCallback: string;
    /**
     * 两臂各自的产物指纹，但**跳过那一件提问工具**（调用块与结果块、带它的行级事件、以及厂商载荷里
     * 提到它的字符串）。`host-tool` 档比这一对——那一档的对照运行里工具按定义不存在，同一条剧本的
     * 那一问必然落成一条错误结果（见模块头）。两格都由 `askUserProductDigestExcludingTool` 从真产物
     * 算出来：归一函数是**臂无关**的，两臂同一份口径，判据才谈得上「除那一件工具之外逐字相同」。
     */
    digestWithCallbackExcludingAskTool?: string;
    digestWithoutCallbackExcludingAskTool?: string;
    /**
     * 对照运行里那一问拿到的工具结果原文（`host-tool` 档必填：判据要能读出「这一档自带的差异长什么样」，
     * 供人核对它不是别的故障）。`vendor-tool` 档没有这一格——那里的对照运行里那一问根本不该发生。
     */
    missingToolError?: string | null;
    /**
     * 对照运行的**出站工具表**（请求侧事实，读法与注入面那两格同一处）；`host-tool` 档必填。
     *
     * 为什么必须由请求侧给：白名单是成员匹配器，名字没拼进去时厂商**静默**少一件——「我们没注册」
     * 与「注册了但没声明出去」在产物里长得一样。`host-tool` 档靠它判「对照臂确实没有那件工具」。
     */
    requestTools?: string[];
    /**
     * 两臂各自从**出站请求**读到的厂商工具表（带回调 / 不传回调）。给了就多两条判据：那一件工具在
     * 带回调那一臂的表里、且在对照臂的表里没有——「厂商真的把它给了模型」这条事实只有请求侧看得见。
     */
    outboundToolsWithCallback?: string[];
    outboundToolsWithoutCallback?: string[];
    /**
     * **挂上应答面会让厂商工具表多出（或少了）哪几件工具**：声明后，两臂指纹的比对把这些条目
     * 归一到同一形态再逐字比，**其余每一个字节照旧参与**。
     *
     * 为什么需要这一格：厂商把「有没有应答面」与「这些工具提不提供给模型」绑在一起，于是两臂的
     * 厂商载荷天然差一截——**那不是回归**，是这一档自带的差异。而不归一就比不了：工具表那几行
     * 整段躺在产物里（`vendor-system` 事件的 `tools`）。归一的范围只到点名的这几件，
     * 「我们少声明了一件」的表现是两臂指纹仍然不同（红），不是被静默放过。
     */
    askSurfaceTools?: string[];
    /**
     * **两臂的厂商工具表相同、变的是那一次调用的结果**的那几件（`vendor-tool` 档的第二种形状）。
     *
     * 为什么需要这一格：有的家把提问工具**无条件**挂进装配（工具由谁提供不由应答面决定），
     * 撤掉应答面之后同一件工具还在表里、同一句剧本还是调它一次，只是那一问的结果从「答案批次」
     * 变成厂商自己的「无人应答」收场。与 `askSurfaceTools` 同一套口径：实测 + 逐件点名，
     * 归一之后两臂指纹仍要逐字相同；**登记错形状会报红并点名该换哪一格**。
     */
    askResultTools?: string[];
    /**
     * **厂商自己投的、与提问无关的那几条通知**在两臂里的出入（方法名逐条点名 + 它的档）。
     *
     * 为什么需要这一格：本仓对未识别通知的落点是「把厂商原文抄成一条日志」（各家 `other` 分支）
     * ——那是**故意**的（静默丢弃会让「上游换了方法名」表现成「什么都没发生」），代价是厂商自己的
     * 通知节奏进了产物。两臂对比因此必须点名哪些方法允许出入，否则指纹会红在一些与提问无关的地方：
     *
     *   · `'switch-only'`——**提问开关本身**带来的差异。开关与应答面同生同灭（开了没人答，厂商会一直
     *     等那一帧），于是开了开关那一臂会多出一条厂商通知（codex 0.156.1 在
     *     `features.default_mode_request_user_input` 打开时投一条 `warning`，正文是
     *     「Under-development features enabled: …」）。判据要求它在**恰好一臂**里出现过。
     *   · `'volatile'`——厂商按自己的节奏投的（限流状态、收束回执一类），条数两臂都可能不同。
     *     判据只要求它在两臂里**出现过**；它在两臂逐字相同时也照样合法。
     *
     * 两种档都只把点名的那几条整条去掉，**其余每一个字节照旧参与比对**；原始指纹还必须不同
     * （否则这一格没有区分力）。判据逐条写在 `checkVendorSwitchNotices`。
     * ⚠️ **不许**拿这一格去盖住「产品少发了一条事件」：点名的必须是厂商自己的通知方法名。
     */
    askSwitchNotices?: Record<string, 'switch-only' | 'volatile'>;
    /**
     * 点名的那几条**各臂出现过没有**（请求侧事实：只有真跑过两次的人知道，指纹里读不出来）。
     * 键与 `askSwitchNotices` 同集；判据靠它核对「档写得对不对」（见 `checkVendorSwitchNotices`）。
     */
    noticeArms?: Record<string, { withCallback: boolean; withoutCallback: boolean }>;
  };
}

/**
 * 某条行级事件是不是「厂商投了一条本仓没有专门投影的通知」那一格，是的话给出方法名。
 *
 * 判据是**严格形状**：事件正文是一个 JSON 对象、键集**只能是** `method`（必填，字符串）与
 * `params`（可选，厂商原载荷）——各家对未识别通知的落点就是这个形状（见
 * `providers/<家>/events.ts` 的 `other` 分支：方法名必留，`params` 原样抄过来，不抄就分不清
 * 「上游换了载荷结构」与「上游没发」）。
 *
 * 为什么不放宽到「只认字符串包含 method」：这一格是用来**放宽**两臂指纹判据的，放宽错地方比
 * 不放宽更坏——别处的文案一旦能冒充厂商通知，就能把「产品少发了一条事件」盖过去。
 */
export function vendorNoticeMethodOf(event: unknown): string | null {
  if (typeof event !== 'object' || event === null) return null;
  const text = (event as { text?: unknown }).text;
  if (typeof text !== 'string' || !text.startsWith('{')) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const keys = Object.keys(parsed);
  if (keys.length === 0 || keys.some((key) => key !== 'method' && key !== 'params')) return null;
  if (!keys.includes('method')) return null;
  const method = (parsed as { method?: unknown }).method;
  return typeof method === 'string' && method !== '' ? method : null;
}

/**
 * 同一份指纹，但做两处归一再算：把点名的**厂商通知**那几条整条丢掉，并把点名的**那几件工具**
 * 归一到同一形态（用途与判据见 `AskUserProbe.control.askSwitchNotices`）。
 *
 * 丢掉的是整条事件（含它在两臂里的**条数**差异）——这正是要点：这一档的全部主张就是
 * 「那一条通知的进出是开关带来的，除它之外两臂逐字相同」。别处每一个字节照旧参与比对。
 *
 * 两处归一**必须同一个函数**：挂上应答面的那一臂既会多出厂商通知（开关带来的）、也会多出**提问那一半**
 * 在账本里的那条调用（对照臂压根没问）。只抹其中一处，两臂就永远不可能逐字相同——而那是**误红**，
 * 它会把「这一档真的成立」读成「这一档不成立」。
 *
 * ⚠️ **`seq` 按剩下的事件重编**：它由适配器按产出顺序现分配，而那几条厂商通知**照样占过号**
 * ——不重编的话两臂的序号会整体错位（`seq` 是行为的一部分：事件条数与顺序正是要比的）。
 */
export function askUserProductDigestExcludingNotices(
  product: ConformanceProduct,
  methods: readonly string[],
  /**
   * 随应答面进出的那几件工具（与 `control.askSurfaceTools` / `askResultTools` 同一份名单）。
   *
   * 为什么这一格不能省：提问走**服务端请求**的家（codex）在账本里补出来的那条调用是**一条自己的
   * 消息**，对照臂里不存在 ⇒ 只抹厂商通知的话两臂永远不可能逐字相同。而这一格**抹不掉「漏了物化」**：
   * 漏了的时候 `checkAskUserLedger` 当场红（它才是那一格的判据），指纹这一层只管「除那一问本身之外
   * 两臂是否逐字相同」。
   */
  toolNames: readonly string[] = [],
): string {
  /**
   * **零条点名 = 与原始指纹逐字相同**（这一档一个字都不该动）：`seq` 的重编只在真有东西被拿掉时
   * 发生——`dropToolOnly` 那一格为空时 `askUserProductDigest` 原样保留 `seq`，正好是这一支要的。
   */
  if (methods.length === 0) return askUserProductDigest(product, toolNames);
  const dropped = new Set(methods);
  const kept = product.events.filter((event) => {
    const method = vendorNoticeMethodOf(event);
    return method === null || !dropped.has(method);
  });
  return askUserProductDigest(
    // `seq` 先压成 0：按剩下的事件重编之后的号才是这一档要比的那一份（被丢掉的通知照样占过号）
    { ...product, events: kept.map((event) => ({ ...event, seq: 0 })) },
    toolNames,
    true,
  );
}

/**
 * 两个指纹共用的两格口径：**哪些键不算行为**、以及**怎么序列化**。
 *
 * 抽出来是为了让 `askUserProductDigest` 与 `askUserProductDigestExcludingTool` 逐字同一套口径——
 * 两份各写一遍的话，「跳过那件工具」那一档与原始那一档会各自漂移，而漂移的表现是两臂莫名其妙不同。
 */
const SKIPPED_KEYS: ReadonlySet<string> = new Set(['at', 'timing', 'totalMs', 'apiMs', 'ttftMs', 'durationMs']);

/** 厂商在载荷里写的**身份格**：换一次运行就换一个值，不是行为（见 `maskedIdentityInText`） */
const VENDOR_IDENTITY_KEYS: ReadonlySet<string> = new Set(['threadId', 'turnId']);
const MASKED_IDENTITY = '<厂商现生成的身份：不进指纹>';

/**
 * 把行级事件正文里那个 JSON 载荷的**身份格**归一掉（`threadId` / `turnId` → 常量）。
 *
 * 为什么这一格必须抹：**厂商投的每条通知都带本次运行自己的线程 id**（UUID，每跑一次都不同），而
 * 未识别通知的落点是「把原始负载抄进事件正文」（各家的 `other` 分支）⇒ 同一条通知在两次运行里
 * 逐字不同，任何两臂指纹比对都会恒红。这与消息那一侧丢掉 `raw` / `vendorId` 是同一条口径：
 * 描述运行身份的东西不是行为。
 *
 * 两条边界：**只**动这两个键的值，别处的每一个字节照旧参与比对；**只**认「整段正文是一个 JSON
 * 对象」这一种形状（认不出就原样返回——宁可让它进指纹，也不静默改写看不懂的正文）。
 */
function maskedIdentityInText(text: string): string {
  if (!text.startsWith('{')) return text;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return text;
  }
  const masked = maskIdentity(parsed);
  // 掩码之后要**变回字符串**（下游拿它跟别处的字符串逐字比）：序列化失败就原样交回
  try {
    return JSON.stringify(masked) ?? text;
  } catch {
    return text;
  }
}

/** 递归把身份格换成常量（形状保持不变：数组照旧是数组，键照旧在） */
function maskIdentity(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(maskIdentity);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      VENDOR_IDENTITY_KEYS.has(key) ? MASKED_IDENTITY : maskIdentity(item),
    ]),
  );
}

/** 递归按键排序后序列化（键序差异不该冒充行为差异；时刻格按 `SKIPPED_KEYS` 跳过） */
function canonicalOf(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalOf).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !SKIPPED_KEYS.has(key))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalOf(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

/**
 * 消息那一格的**公共归一**（两份指纹共用一套口径）：厂商原文与厂商现生成的消息 id 不进指纹、
 * 整条只有点名工具的产物消息按定义拿掉、`messageId` 随之按位置重编。
 *
 * 抽出来是为了让 `askUserProductDigest` 与 `askUserProductDigestExcludingTool` 逐字同一套——
 * 两份各写一遍的话，「跳过那件工具」那一档与原始那一档会各自漂移，而漂移的表现是两臂莫名不同。
 */
function isToolCallNamed(block: { type: string; name?: string }, names: ReadonlySet<string>): boolean {
  return block.type === TOOL_CALL_BLOCK_TYPE && block.name !== undefined && names.has(block.name);
}

/**
 * 工具调用块的判别串。写成常量而不是就地在块里写字面量：`providers/**` 里手写那个类型字面量由
 * `static-assertions.test.ts` 拦下（手搓那种块会静默少掉族载荷）——本模块只**读**块、从不构造它们，
 * 构造一律走 `toolCallBlockDraft`。
 */
const TOOL_CALL_BLOCK_TYPE = 'tool-call';

function comparableMessages(
  messages: ConformanceProduct['messages'],
  dropToolOnly: ReadonlySet<string>,
): Array<Record<string, unknown>> {
  return messages
    .map(({ raw: _raw, vendorId: _vendorId, ...message }) => ({
      ...message,
      blocks: (message.blocks ?? []).filter((block) => !isToolCallNamed(block, dropToolOnly)),
    }))
    /**
     * 只有**原本有块、过滤之后一块不剩**的消息才拿掉；本来就没给 `blocks` 的合成产物（套件自测里
     * 那些最小对象）照旧留着——把「没给这一格」读成「这一格空了」会让它们整条消失。
     */
    .filter((message, index) => message.blocks.length > 0 || (messages[index]?.blocks?.length ?? 0) === 0)
    /**
     * `messageId` 是本仓合成的 `<runId>:<seq>`，`seq` 是**全局产出序**：掉了两条消息之后两臂的号
     * 必然错位，故按位置重编（条目数与内容仍逐条参与比对）。没有消息被拿掉时这一支恒等。
     */
    .map((message, index) => ({ ...message, messageId: `<产物消息 ${index + 1}>` }));
}

/**
 * 产物指纹：只比**归一产物**（消息 / 子任务 / 行级事件 / 计量 / 结果），不比厂商原文与时钟读数。
 *
 * 三处刻意不进指纹，各有各的理由（不进就是「不算行为」，不是「放它一马」）：
 *   · **消息上的 `raw`**（厂商原文）与**「原始输出」那条 `log` 的正文**：它们逐字抄的是厂商载荷，
 *     里面带着**本行身份与时钟读数**——pi 的 provider id 由 `configHome` 派生（每行一份临时目录
 *     ⇒ 每次运行都不同）、dsh 的会话号现生成、各家载荷里都有 epoch 毫秒。把两处算进去，
 *     任何两次运行都不可能相同，判据就成了永远红的摆设。⚠️ 只丢**正文**：`log` 的**条数与通道**
 *     照旧比——「不传回调时多出一条日志」这类回归仍然拦得住；
 *   · **时刻**（行级事件的 `at`、计量的 `timing` / `totalMs` / `apiMs` / `ttftMs` / `durationMs`）：
 *     同一件事在两次运行里量到的时间按定义不同；
 *   · **厂商现生成的消息 id**（消息信封的 `vendorId`，dsh 每条消息一个 UUID）：它按定义在两次
 *     运行里不同（契约也明写「不得把它当去重键」⇒ 它不是行为）；本仓合成的 `messageId` 照旧参与；
 *   · **厂商载荷里的身份格**（`threadId` / `turnId`，各家的线程号每跑一次都是新的 UUID）：它们躺在
 *     `summary` 那段抄来的 JSON 里 ⇒ 按 `maskedIdentityInText` 换成常量。只换这两个键的值，
 *     键本身与别处的每一个字节照旧参与比对；
 *   · **提问探针本身**（两次运行的那一格按定义就不同）。
 *
 * 键排序是为了让两边的键序差异不冒充行为差异。
 *
 * `dropToolOnly` 是**随应答面才存在**的那几件工具（codex 的提问工具）：账本里那条提问调用整条只有
 * 它一件，对照臂压根没有——不拿掉的话两臂永远不可能逐字相同，而那是**误红**。
 * 判定用**过滤之后还剩不剩东西**（不是「消息里有没有它」）：另有一半正文的消息照旧参与比对。
 * 该给谁、以及为什么这一格不能把「漏了物化」也一起抹掉，见 `askUserProductDigestExcludingNotices`。
 */
export function askUserProductDigest(
  product: ConformanceProduct,
  dropToolOnly: readonly string[] = [],
  /** 见 `askUserProductDigestExcludingNotices`：`seq` 是否按剩下的事件重编（调用方先把它压成 0） */
  renumberEvents = false,
): string {
  const { askUser: _probe, messages, events, ...rest } = product;
  const comparable = {
    ...rest,
    messages: comparableMessages(messages, new Set(dropToolOnly)),
    /**
     * `text` 整格丢掉；`summary` 留着（见上面那条口径）。⚠️ **`summary` 里可能抄着厂商载荷的
     * 身份格**（未识别通知那一条的摘要就是它的 JSON）⇒ 一并抹掉 `threadId` / `turnId`，
     * 否则同一条通知在两次运行里逐字不同、指纹恒红（见 `maskedIdentityInText`）。
     */
    events: events.map(({ text: _text, ...event }) => ({
      ...event,
      ...(typeof event['summary'] === 'string'
        ? { summary: maskedIdentityInText(event['summary']) }
        : {}),
    })),
  };
  if (!renumberEvents) return canonicalOf(comparable);
  /**
   * `seq` 按剩下的事件重编：它是全局产出序，被拿掉的那几条照样占过号（调用方已把它压成 0）。
   */
  return canonicalOf({
    ...comparable,
    events: comparable.events.map((event, index) => ({ ...event, seq: index + 1 })),
  });
}

/**
 * 同一份指纹，但把**点名的那几件工具**归一到固定形态之后再算。
 *
 * 用途只有一个（见模块头）：两臂的厂商载荷天然差一截——`host-tool` 档对照臂里那件工具按定义不
 * 存在，`vendor-tool` 档挂上应答面会让厂商的工具表多出几件。归一覆盖它出现的**四处落点**：
 *   · 消息里的 `tool-call` / `tool-result` 块（`tool-result` 不带工具名，按调用 id 配对）；
 *   · 行级事件里带 `toolName` 的那几条（工具执行起止、厂商的工具结果信封）；
 *   · **厂商载荷里提到这个名字的字符串**——最要紧的一处是默认系统提示词的工具段与 `## Guidelines` 段：
 *     工具注册与否直接决定那两段里有没有它的那几行，而那两段整段躺在行级事件的载荷里；
 *   · **厂商工具表**（`vendor-system` 事件的 `tools` 数组，或厂商载荷里的同名条目）。
 *
 * **只碰点名的那几件**：别处的每一个字节照旧比对。为什么归一到「同一个常量」而不是把那一格删掉：
 * 删掉之后「消息条数 / 事件条数」也会跟着变，而条数正是两臂最该保持一致的那一格。
 *
 * ⚠️ **不许把「含它的容器整块抹平」**：从产物顶层往下传的每一层容器都含它，那样整份产物会被抹成一个
 * 常量，判据随之变成恒真（空转）。故只处理**直接**提到它的字符串，容器一律继续往下走；
 * `sections` / `toolsAdded` 两格按**用途**归一（不看有没有提到它）——按名字判会漏掉另一半：
 * 对照臂的系统提示词里没有那个名字，它那一格原样留下，两臂照样差一格。
 */
export function askUserProductDigestExcludingTool(
  product: ConformanceProduct,
  toolNames: string | readonly string[],
): string {
  const { askUser: _probe, ...rest } = product;
  const names = new Set(typeof toolNames === 'string' ? [toolNames] : toolNames);
  /**
   * 那一件工具的调用 id 全集：`tool-result` 块与消息都不带工具名，配对只能靠 `callId`。
   * 从助手块的 `tool-call.name` 上收——那正是厂商载荷里模型实际调的那个名字。
   */
  const callIds = new Set(
    product.messages.flatMap((message) =>
      message.blocks.flatMap((block) =>
        block.type === TOOL_CALL_BLOCK_TYPE && names.has(block.name) ? [block.callId] : [],
      ),
    ),
  );
  /**
   * 那一件工具的**结果正文**：工具结果那一行日志只抄结果本身（形如「工具报错：<正文>」，
   * 成功的那一支没有摘要），**它不带工具名** ⇒ 按名字抹不掉，而两臂的结果正文按定义不同
   * （一边是答案批次、另一边是厂商自己的「无人应答」收场）。判据因此把「摘要里抄了被点名工具
   * 结果正文」的那些也归一到同一形态：那一段正是这一件工具的产出，不是别处的行为。
   */
  const resultTexts = product.messages.flatMap((message) =>
    message.blocks.flatMap((block) =>
      block.type === 'tool-result' && callIds.has(block.callId) && typeof block.text === 'string' && block.text !== ''
        ? [block.text]
        : [],
    ),
  );
  /**
   * 归一用的常量**是臂无关的**（两臂同一份），且它的**字面量里不许出现被点名的工具名**：
   * 抹出来的字符串还要再被当成普通字符串走一遍归一，含名字就会被替换两次——第二次之后与第一次
   * 的结果不同，两臂于是莫名地不同（一个天然的坑：用自己的输出当下一次的输入）。
   */
  const normalized = '<这一格在另一臂里不可比>';
  const mask = (value: string): string => ([...names].some((name) => value.includes(name)) ? normalized : value);
  const maskDeep = (key: string, value: unknown): unknown => {
    if (key === 'raw') return '<厂商原始载荷：不进指纹>';
    if (key === 'sections' || key === 'toolsAdded') return normalized;
    // 厂商工具表里的那几件：别的工具名一字不动（厂商载荷里的 `tools` 与产品事件的同名条目都在这一支上）
    if (key === 'tools' && Array.isArray(value)) return value.filter((name) => !names.has(String(name)));
    /**
     * 厂商的**命令面**（`vendor-system` 的 `slashCommands`）：它随同一个开关进出（挂上应答面时
     * 厂商多报几条命令，读数里多出的那几条与提问工具无关，却与它同源）。整列归一到同一形态——
     * 它是**厂商报出来的环境事实**，不是我们这一次运行的行为。
     */
    if (key === 'slashCommands' && Array.isArray(value)) return normalized;
    if (typeof value === 'string') return mask(value);
    if (Array.isArray(value)) return value.map((item) => maskDeep('', item));
    if (value !== null && typeof value === 'object') {
      const source = value as Record<string, unknown>;
      /**
       * 行级事件：判据取信封的两格（`seq` + `type`）。这一层多做两件事——抹掉厂商载荷那一格
       * （与 `askUserProductDigest` 同一条口径）；把「摘要」归一到同一形态（两臂的差异只是
       * 「谁是那一件工具的首行」，一边有摘要、另一边没有）。
       */
      if (key === '' && 'seq' in source && 'type' in source) {
        return {
          ...Object.fromEntries(
            Object.entries(source)
              .filter(([childKey]) => childKey !== 'text' && childKey !== 'raw')
              .map(([childKey, item]) => [childKey, maskDeep(childKey, item)]),
          ),
          text: '<厂商原始载荷：不进指纹>',
          /**
           * 摘要照旧参与比对，抹两类：**含那几件工具名**的，以及**抄了那一件工具结果正文**的
           * （见上面 `resultTexts` 的 JSDoc）。没有摘要与有摘要且已归一，是同一件事。
           */
          summary: typeof source['summary'] === 'string'
            ? (resultTexts.some((text) => (source['summary'] as string).includes(text)) ? normalized : mask(source['summary']))
            : normalized,
        };
      }
      return Object.fromEntries(
        Object.entries(source).map(([childKey, item]) => [childKey, maskDeep(childKey, item)]),
      );
    }
    return value;
  };
  return canonicalOf(maskDeep('', {
    ...rest,
    messages: comparableMessages(product.messages, new Set()).map((message) => ({
      ...message,
      blocks: (message['blocks'] as ConformanceProduct['messages'][number]['blocks']).map((block) => {
        if (block.type === TOOL_CALL_BLOCK_TYPE && names.has(block.name)) {
          return { ...block, input: normalized, payload: null };
        }
        if (block.type === 'tool-result' && callIds.has(block.callId)) {
          // `isError` 也在这一格里：对照臂里它恒为真（那一问落成「工具不存在」），带回调那臂是正常结果
          return {
            ...block,
            text: normalized,
            structured: null,
            truncation: null,
            isError: false,
          };
        }
        return block;
      }),
    })),
    events: product.events.map((event) =>
      event['toolName'] !== undefined && names.has(String(event['toolName']))
        // 带工具名的那几条（工具执行起止、厂商的工具结果信封）整条归一：它们的内容就是那一件工具的产出
        ? { type: event['type'], 归一: normalized }
        : event,
    ),
  }));
}

/** 请求的五格在**运行期**也必须是这个形状（类型层那份守卫管不到夹具填进来的值） */
function checkRequestShape(request: AskUserRequest): string | null {
  if (request.questions.length === 0) return '请求里的问题数组是空的——问题清单是这一格的载荷本身';
  if (request.toolName.trim() === '') return '`toolName` 是空串：排障时要能报出模型实际调的是谁';
  if (request.callId.trim() === '') return '`callId` 是空串：答案要按它回填进消息账本';
  if (request.vendorBudgetMs !== null && !(typeof request.vendorBudgetMs === 'number' && request.vendorBudgetMs > 0)) {
    return `厂商预算只能是 null 或正数，收到 ${JSON.stringify(request.vendorBudgetMs)}（0 会被读成「立刻超时」）`;
  }
  if (request.subagentId !== null && request.subagentId.trim() === '') return '`subagentId` 只能是 null 或非空身份';
  return null;
}

/**
 * 答复里的每一条答案有没有真的进到那一帧里（装帧把答案丢了，是这一格最该拦的形态）。
 *
 * 两条按档读的口径：
 *   · **自由输入要说得出是「哪一侧声明」的**：只要有任一一题声明了 `allowOther`（弹层因此会给出
 *     自由输入那一行），答复里就必须真有一条写了字。声明了却没人写 ⇒ 这一格是**无区分力的空转**
 *     ——`allowOther` 那一格最容易写成「只读提问形状」而恒 `false`（两家把自由输入写在**答复面**上），
 *     那时的表现正是「声明看着对、弹层永远没有输入框」，而所有断言照旧全绿；
 *   · **单选 + 自由输入 = 覆盖**：该题没选任何选项（`selected` 为空数组）时，帧里找不到**任何**被
 *     选中的选项不算缺陷——那正是「自己写的那句话取代了选项」这一档。
 */
function checkAnswersInFrame(request: AskUserRequest, reply: AskUserReply, frame: unknown): string | null {
  if (reply.answers === null || reply.answers.length === 0) {
    return `答案那一格必须是「真答了」的形态，收到 ${JSON.stringify(reply.answers)}——空答复证明不了答案进得了帧`;
  }
  const rendered = JSON.stringify(frame ?? null);
  for (const answer of reply.answers) {
    /**
     * **单选那一档不查「被覆盖的选项」**：`selected` 为空数组 + `custom` 有值 = 用户自己写的那句话
     * 就是全部答案（契约里单选 = 覆盖）。此时帧里出现的选项标签不是「答复没进去」，而是那一题的
     * 候选项原文（答卷与题面同字，判据照查就会把对的判成错的）。
     */
    if (answer.selected.length === 0) {
      if (answer.custom === null || answer.custom === '') {
        return `答案「${JSON.stringify(answer)}」既没选也没写——空答复证明不了答案进得了帧`;
      }
      if (!rendered.includes(answer.custom)) {
        return `应答帧里找不到自由输入的答案「${answer.custom}」：答复没进到帧里`;
      }
      continue;
    }
    for (const label of answer.selected) {
      if (!rendered.includes(label)) return `应答帧里找不到被选中的选项「${label}」：答复没进到帧里`;
    }
    if (answer.custom !== null && !rendered.includes(answer.custom)) {
      return `应答帧里找不到自由输入的答案「${answer.custom}」：答复没进到帧里`;
    }
  }
  /**
   * 自由输入那一格**要说得出是「哪一侧声明」的**：只要有任一一题声明了 `allowOther`（弹层因此会给出
   * 自由输入那一行），答复里就必须真有一条写了字。声明了却没人写 ⇒ 这一格是**无区分力的空转**
   * ——`allowOther` 最容易写成「只读提问形状」而恒 `false`（两家把自由输入写在**答复面**上），
   * 那时的表现正是「声明看着对、弹层永远没有输入框」，而别的断言照旧全绿。放在逐条检查**之后**：
   * 「空选又空写」是更具体的病因，不该被这一条盖住。
   */
  if (reply.answers.every((answer) => answer.custom === null) && request.questions.some((one) => one.allowOther)) {
    return '提问里有一题声明了「允许自由输入」（`allowOther`），答复里却没有一条写下自己的答案'
      + '——弹层给了输入框而这一格从不验它，等于把「自由输入到不到得了厂商」整条留空';
  }
  return null;
}

/**
 * **提问那一半必须进账本**：适配器把模型问到人的那一次调用物化进内容账本了吗。
 *
 * 为什么这一条是跨家判据：卡片（`build-model.ts` 的 `ask-user` 那一种）唯一的驱动是**账本里**
 * 那一条 `tool-call`（`family: 'ask-user'`）——厂商把提问放在哪条通道上，界面读不到，它只认账本。
 * 而通道按家分三类，**只有一类会自己进账本**：
 *   · 提问是一件**工具**（cc 的厂商工具、pi 的宿主工具）⇒ 调用落在厂商的条目流 / 我们自己的工具流里，
 *     投影顺带就把它记下了；
 *   · 提问是**服务端请求**（codex 的 `item/tool/requestUserInput`）⇒ 它**不进通知流**，
 *     厂商的线程条目里没有这一格，账本里那一半没有第二个来源，只能由观察到这次请求的适配器补出来。
 *     不补的症状是界面上只剩一条**没有题目**的答复行：模型答了什么看得见，问的什么一个字都没有。
 *
 * 判据因此挂在**运行事实**上而不是声明上：这一家的探针里「端口真被问过」（`calls > 0`）⇒
 * 账本里必须有一条对应的 `ask-user` 调用，且它的题目与端口收到的那一份**逐字相同**（两处同源而
 * 不同通道，漂移的表现正是「卡片上的题与模型问的题不是同一道」）。
 *
 * **不判**答案那一半（`tool-result`）：它在产品里由编排层写（`ask-user-settlement.ts`），
 * 各家的一致性夹具跑的是 provider 那一层，拿不到它——那一半的判据在产品侧（`orchestrator-ask-user`）。
 */
export function checkAskUserLedger(where: string, product: ConformanceProduct): void {
  const probe = product.askUser;
  if (probe === undefined || probe.calls === 0) return;
  const request = probe.requests[0];
  if (request === undefined) return;
  const calls = product.messages.flatMap((message) =>
    message.blocks.filter(
      (block): block is Extract<typeof block, { type: typeof TOOL_CALL_BLOCK_TYPE }> =>
        block.type === TOOL_CALL_BLOCK_TYPE && block.family === 'ask-user',
    ),
  );
  if (calls.length === 0) {
    throw new Error(
      `${where}：提问端口真被问过（${probe.calls} 次），内容账本里却没有一条 \`ask-user\` 族的工具调用`
      + '——卡片由账本里那一条 `tool-call` 驱动，界面上只会剩一条没有题目的答复行。'
      + '厂商把提问放在通知流之外时（服务端请求），适配器必须替它把提问那一半物化进账本',
    );
  }
  /**
   * **按调用 id 收口**：同一次调用在账本里可以出现多条（增量的半截与快照各一条，
   * 它们的合并键不同但说的是同一件事）。判据因此看**不同的 id 有几个**——
   * 用块条数判会把「同一条消息分两帧」读成「问了两遍」，那是误红。
   */
  const byCallId = new Map(calls.map((call) => [call.callId, call]));
  if (byCallId.size > 1) {
    throw new Error(
      `${where}：这一问在账本里出现了 ${byCallId.size} 条不同的调用（${[...byCallId.keys()].join('、')}）`
      + '，必须恰好一条——同一次提问记两个 id 会让界面画出两张卡片，而其中一张永远等不到答案',
    );
  }
  const call = byCallId.get(request.callId);
  if (call === undefined) {
    throw new Error(
      `${where}：账本里那条 \`ask-user\` 调用的 id 是 ${[...byCallId.keys()].join('、')}，`
      + `端口收到的是 ${request.callId}——两处不同源就是「有卡片没答案」（答复那一半按端口的 id 回填）`,
    );
  }
  const payload = call.payload;
  if (payload?.kind !== 'ask-user') {
    throw new Error(
      `${where}：账本里那条 \`ask-user\` 调用没有族载荷（\`payload\` 是 ${JSON.stringify(payload ?? null)}）`
      + '——没有题目就没有卡片，那一行只剩工具名与通用工具行',
    );
  }
  const ledgerQuestions: AskUserQuestion[] = payload.questions;
  if (canonicalQuestions(ledgerQuestions) !== canonicalQuestions(request.questions)) {
    throw new Error(
      `${where}：账本里的题面与端口收到的那一份不同（账本 ${JSON.stringify(ledgerQuestions)}、`
      + `端口 ${JSON.stringify(request.questions)}）——两处同源而不同通道，漂移的表现是卡片上问的`
      + '与模型实际问的不是同一道题',
    );
  }
  if (!ledgerQuestions.some((question) => question.allowOther)) {
    throw new Error(
      `${where}：账本里那一问没有任何一题声明「允许自由输入」（\`allowOther\` 全是 \`false\`）`
      + '——弹层据此决定加不加「其它（自由输入）」那一行，恒 false 时用户永远只能从给出的选项里挑。'
      + '这一格要按**答案面**取证（有的家把自由输入写在答复形状上，提问形状里根本没有这一格）',
    );
  }
}

/**
 * 题面的可比形态：只留两处**必须一致**的语义（题面文本与候选项），把「两处各自怎么拼出这一份」
 * 的差异排除在外。
 *
 * 两处同源而不同通道——账本那条走「厂商工具入参 → 族载荷归一」，端口那份走「厂商提问请求 → 归一」——
 * 于是同一道题在两处的**原始**字段名可能不同（pi 的数组入参给 `question`、工具 schema 给的是同一格，
 * 归一后一处有 `prompt` 一处没有）。判据要比的是「卡片上问的那道题与模型实际问的是不是同一道」，
 * 因此比 **header + 题面 + 候选项**：`prompt` 缺席按空串归一；候选项按标签排序（顺序不是语义，
 * 厂商与两处通道都不保证同序）。
 */
function canonicalQuestions(questions: readonly AskUserQuestion[]): string {
  return JSON.stringify(
    questions.map((question) => ({
      header: question.header,
      prompt: question.prompt ?? '',
      options: [...question.options]
        .map((option) => ({ label: option.label, description: option.description ?? null }))
        .sort((left, right) => (left.label < right.label ? -1 : left.label > right.label ? 1 : 0)),
    })),
  );
}

/**
 * 提问应答的一组判据，不通过就抛（红的时候组名之外还要给出可读的原因）。
 *
 * 带回调那一臂四格：① 回调恰好一次；② 入参形状对；③ 答复真的进了该家的应答帧；④ 对照运行干净。
 * ④ 按通道分两档（见模块头）：`vendor-tool` 要求两臂指纹逐字相同；`host-tool` 要求「对照臂的工具表里
 * 没有那个名字」+「拿到工具不存在类错误原文」+「把那一件工具归一之后两臂指纹逐字相同」。
 *
 * `channel` 取声明上的那一格（`metadata.interaction.askUserChannel`），不按家名分支——通道一变，
 * 判据跟着变，而「哪家是哪档」只写在声明里一处。
 */
export function checkAskUserProbe(
  where: string,
  probe: AskUserProbe,
  channel: AskUserChannel | null,
  /** 宿主工具的名字：只有 `host-tool` 档用得到（`vendor-tool` 档传 `null`） */
  hostToolName: string | null,
): void {
  if (probe.calls !== 1) {
    throw new Error(`${where}：回调被调用了 ${probe.calls} 次，必须恰好一次（重复问人＝同一个问题问两遍）`);
  }
  const request = probe.requests[0];
  if (probe.requests.length !== 1 || request === undefined) {
    throw new Error(`${where}：回调收到 ${probe.requests.length} 份入参，必须恰好一份`);
  }
  const shapeProblem = checkRequestShape(request);
  if (shapeProblem !== null) throw new Error(`${where}：${shapeProblem}`);
  const reply = probe.replies[0];
  if (probe.replies.length !== 1 || reply === undefined) {
    throw new Error(`${where}：端口交回 ${probe.replies.length} 份答复，必须恰好一份`);
  }
  const frameProblem = checkAnswersInFrame(request, reply, probe.answerFrame);
  if (frameProblem !== null) throw new Error(`${where}：${frameProblem}`);
  if (probe.control.calls !== 0) {
    throw new Error(`${where}：没传回调的那次运行里回调被调用了 ${probe.control.calls} 次——「默认不介入」不成立`);
  }
  const control = probe.control.reply;
  if (control === null || control.outcome !== 'unavailable' || control.answers !== null) {
    throw new Error(
      `${where}：没传回调时端口必须立即给「无人应答」（unavailable + answers: null），收到 ${JSON.stringify(control)}`,
    );
  }
  if (channel === 'host-tool') {
    checkHostToolControl(where, probe, hostToolName);
    return;
  }
  /**
   * `vendor-tool` 档：两臂的产物指纹**逐字相同**，不放宽。厂商那一端的提问行为由它自己的开关或钩子
   * 决定，撤掉应答面不会让同一条剧本多出任何东西。
   *
   * 例外只有一处，即**厂商那一端自己变的那一截**——由驱动器**实测 + 逐件点名**登记，两种形状：
   * 工具**随应答面进出工具表**（`control.askSurfaceTools`），或工具**两臂都在表里、变的是那一次
   * 调用的结果**（`control.askResultTools`）。两种形状都只把点名的那几件归一到同一形态再比——
   * **其余每一个字节照旧参与**，少登记一件（或登记错形状）就仍然红。
   */
  const surface = probe.control.askSurfaceTools ?? [];
  const resultOnly = probe.control.askResultTools ?? [];
  const notices = Object.keys(probe.control.askSwitchNotices ?? {});
  /**
   * 登记了「厂商通知随开关进出」⇒ 先按它判，再比归一之后的两臂指纹（两条都要：见
   * `AskUserProbe.control.askSwitchNotices`）。
   */
  if (notices.length > 0) {
    checkVendorSwitchNotices(where, probe, notices);
    return;
  }
  if (surface.length === 0 && resultOnly.length === 0) {
    checkDigestsUnchanged(where, probe.control.digestWithCallback, probe.control.digestWithoutCallback);
    return;
  }
  if (surface.length > 0) checkVendorSurfaceTools(where, probe, surface);
  if (resultOnly.length > 0) checkVendorResultTools(where, probe, resultOnly);
  const registered = [...surface, ...resultOnly];
  const withCallback = probe.control.digestWithCallbackExcludingAskTool;
  const withoutCallback = probe.control.digestWithoutCallbackExcludingAskTool;
  if (withCallback === undefined || withoutCallback === undefined) {
    throw new Error(
      `${where}：登记了要归一的那几件（${registered.join(' / ')}），却没交出「归一之后」的两臂指纹——`
      + '这一档的对照臂判据就是靠它们把那一件之外的部分逐字比一遍',
    );
  }
  checkDigestsUnchanged(
    where,
    withCallback,
    withoutCallback,
    `（两臂各自把 ${registered.join(' / ')} 归一到同一形态之后再比）`,
  );
}

/**
 * `askSwitchNotices` 那一档的核对（四条，缺一条这一格就退回自述）：
 *
 *   ① 两臂的**原始**指纹必须不同——登记这一格的全部主张是「差异就落在点名的那几条上」，
 *      原始指纹相同说明这一格没有区分力，登记等于把判据放宽到空转；
 *   ② 点名的方法必须真的**在两臂里出现过**（两臂都没有 ⇒ 名字写错了，这一格什么也没抹掉）；
 *      档为 `switch-only` 的还要求它**只在恰好一臂**里出现（两臂都有 ⇒ 它与提问开关无关）；
 *   ③ 归一之后的两臂指纹不能与原始指纹逐字相同——那说明点名一条都没命中，
 *      这一格名义上生效、实际上什么都没抹掉；
 *   ④ 归一之后两臂指纹必须**逐字相同**——除点名的那几条之外每一个字节照旧参与比对。
 */
function checkVendorSwitchNotices(where: string, probe: AskUserProbe, methods: readonly string[]): void {
  const { digestWithCallback, digestWithoutCallback } = probe.control;
  const declared = probe.control.askSwitchNotices ?? {};
  if (digestWithCallback === digestWithoutCallback) {
    throw new Error(
      `${where}：登记了「askSwitchNotices」（${methods.join(' / ')}），两臂的**原始**指纹却逐字相同——`
      + '这一格的存在前提就是「点名的那几条让两臂不同」，相同说明登记错了对象（或那几条根本没发出来）',
    );
  }
  for (const method of methods) {
    const arms = probe.control.noticeArms?.[method];
    if (arms === undefined || (!arms.withCallback && !arms.withoutCallback)) {
      throw new Error(
        `${where}：「askSwitchNotices」点名的 ${method} 在两臂里都没出现过——`
        + '这一格登记的是「厂商真的投过、只是两臂不同」的通知，名字写错等于什么都没抹掉',
      );
    }
    if (declared[method] === 'switch-only' && arms.withCallback === arms.withoutCallback) {
      throw new Error(
        `${where}：「askSwitchNotices」把 ${method} 记成「switch-only」，它却在两臂里出现情况相同`
        + `（带回调 ${String(arms.withCallback)}、对照臂 ${String(arms.withoutCallback)}）——`
        + '两臂都发或都没发说明它与提问开关无关：按 `volatile` 记（厂商自己的节奏），或干脆不登记',
      );
    }
  }
  const withCallback = probe.control.digestWithCallbackExcludingAskTool;
  const withoutCallback = probe.control.digestWithoutCallbackExcludingAskTool;
  if (withCallback === undefined || withoutCallback === undefined) {
    throw new Error(
      `${where}：登记了「askSwitchNotices」（${methods.join(' / ')}），却没交出「把那几条归一之后」的两臂指纹`
      + '——这一档的判据就是靠它们把其余部分逐字比一遍',
    );
  }
  if (withCallback === digestWithCallback && withoutCallback === digestWithoutCallback) {
    throw new Error(
      `${where}：归一之后的两臂指纹与原始指纹一模一样——点名的 ${methods.join(' / ')} 一条都没被抹掉，`
      + '这一格没有生效（方法名要与厂商实际投的那一条逐字相同）',
    );
  }
  checkDigestsUnchanged(
    where,
    withCallback,
    withoutCallback,
    `（两臂各自把厂商通知 ${methods.join(' / ')} 整条去掉之后再比）`,
  );
}

/**
 * `askResultTools` 那一档的核对（三条，缺一条这一格就退回自述）：
 *
 *   ① 两臂的**出站工具表**都交出来了——那是请求侧事实；
 *   ② 点名的那几件在**两臂**的表里都在：这一档的全部主张就是「工具表没变、变的是结果」，
 *      只在一臂里说明差异落在工具表上 ⇒ 报红并点名该换 `askSurfaceTools`；
 *   ③ 两臂工具表**逐字相同**（排序后比——表里的顺序不是语义）：有别的成员进出说明还有一件没登记，
 *      这里给出差在哪一件，排障不必去比对两串长指纹。
 */
function checkVendorResultTools(where: string, probe: AskUserProbe, names: readonly string[]): void {
  const withCallback = probe.control.outboundToolsWithCallback;
  const withoutCallback = probe.control.outboundToolsWithoutCallback;
  if (withCallback === undefined || withoutCallback === undefined) {
    throw new Error(
      `${where}：登记了 \`askResultTools\`（${names.join(' / ')}），却没交出两臂的**出站工具表**——`
      + '这一档的第一句话就是「工具表两臂相同」，只有请求侧看得见',
    );
  }
  for (const name of names) {
    const inWith = withCallback.includes(name);
    const inWithout = withoutCallback.includes(name);
    if (inWith && inWithout) continue;
    throw new Error(
      `${where}：\`askResultTools\` 点名的 ${name} 在两臂的工具表里不是都在（带回调 ${inWith ? '有' : '没有'}、`
      + `对照臂 ${inWithout ? '有' : '没有'}）——「工具表没变、变的是那一次调用的结果」不成立，`
      + '这一件该登记在 `askSurfaceTools` 里',
    );
  }
  const sortedWith = [...withCallback].sort();
  const sortedWithout = [...withoutCallback].sort();
  if (sortedWith.join('|') !== sortedWithout.join('|')) {
    const moved = [
      ...sortedWith.filter((name) => !sortedWithout.includes(name)).map((name) => `只在带回调那臂：${name}`),
      ...sortedWithout.filter((name) => !sortedWith.includes(name)).map((name) => `只在对照臂：${name}`),
    ];
    throw new Error(
      `${where}：两臂的厂商工具表并不相同（${moved.join('；')}）——这一档只覆盖「工具表没变、`
      + '变的是那一次调用的结果」，进出的那几件要登记在 `askSurfaceTools` 里',
    );
  }
}

/**
 * `vendor-tool` 档里「厂商工具表随应答面变化」那几件的核对（三条，缺一条这一格就退回自述）：
 *
 *   ① 两臂的**出站工具表**都交出来了——那是请求侧事实，产物里看不出来（挂不上应答面时厂商是
 *      **静默**少几件，模型与提示词都不会说）；
 *   ② 点名的那几件在带回调那一臂的表里**至少出现一件**，且在对照臂的表里一件都没有
 *      ——「挂上应答面厂商才把它给模型」这条事实要能被读到，否则归一就成了无区分力的空转；
 *   ③ 两臂工具表的**差集不许有点名之外的成员**——漏登记一件的表现是「指纹仍然不同」（红），
 *      而这里给出的是差在哪一件，排障不必去比对两串长指纹。
 */
function checkVendorSurfaceTools(where: string, probe: AskUserProbe, surface: readonly string[]): void {
  const withCallback = probe.control.outboundToolsWithCallback;
  const withoutCallback = probe.control.outboundToolsWithoutCallback;
  if (withCallback === undefined || withoutCallback === undefined) {
    throw new Error(
      `${where}：登记了 \`askSurfaceTools\`（${surface.join(' / ')}），却没交出两臂的**出站工具表**——`
      + '「厂商真的把它给了模型」只有请求侧看得见，产物里只能看到模型没调它',
    );
  }
  if (!surface.some((name) => withCallback.includes(name))) {
    throw new Error(
      `${where}：点名的那几件工具（${surface.join(' / ')}）在带回调那一臂的出站工具表里一件都没有——`
      + '归一的那几件根本没参与，指纹比对随之失去区分力',
    );
  }
  const leaked = surface.filter((name) => withoutCallback.includes(name));
  if (leaked.length > 0) {
    throw new Error(
      `${where}：没传回调的那次运行里出站工具表仍带着 ${leaked.join(' / ')}——`
      + '这几件工具的存在与否正是应答面那一格，不是可以两边都有的东西',
    );
  }
  const undeclared = withCallback.filter((name) => !withoutCallback.includes(name) && !surface.includes(name));
  if (undeclared.length > 0) {
    throw new Error(
      `${where}：带回调那一臂的出站工具表比对照臂多出 ${undeclared.join(' / ')} 却没登记在 `
      + `\`askSurfaceTools\`（${surface.join(' / ')}）里——这几件会让两臂指纹不同，`
      + '而归一只覆盖点名的那几件',
    );
  }
}

/**
 * `host-tool` 档的对照臂判据（见模块头为什么这一档做不到指纹逐字相等）：
 *
 *   ① 对照运行的**出站工具表**里没有那件工具——这是请求侧事实，产物里看不出来
 *      （「没注册」与「注册了但没声明出去」在产物里长得一样）；
 *   ② 对照运行里那一问拿到的是**工具不存在**类的错误原文（这一档自带的差异，抄出来供人核对）；
 *   ③ 把那一件工具归一之后，两臂指纹仍要逐字相同——除它以外的每一格都没被放宽。
 */
function checkHostToolControl(where: string, probe: AskUserProbe, hostToolName: string | null): void {
  if (hostToolName === null || hostToolName.trim() === '') {
    throw new Error(
      `${where}：声明走 \`host-tool\` 通道，却没有交出那件工具的名字——`
      + '判据拿不到它就没法判「对照臂里没有它」，也没法把那一格归一',
    );
  }
  const requestTools = probe.control.requestTools;
  if (requestTools === undefined) {
    throw new Error(
      `${where}：声明走 \`host-tool\` 通道，却没交出对照运行的**出站工具表**——`
      + '这一档的对照臂判据第一条就是「那一件工具没被声明出去」，产物里看不出来（白名单静默少一件）',
    );
  }
  if (requestTools.includes(hostToolName)) {
    throw new Error(
      `${where}：没传回调的那次运行里出站工具表仍带着 ${hostToolName}——`
      + '「不问就不动」在这一档上的落点正是「不注册那件工具」',
    );
  }
  const missing = probe.control.missingToolError;
  if (missing === undefined || missing === null || missing.trim() === '') {
    throw new Error(
      `${where}：对照运行里那一问没有落成「工具不存在」类错误（收到 ${JSON.stringify(missing)}）——`
      + '同一条剧本在对照臂里必然问不出来，拿不到这条原文说明两臂跑的不是同一件事',
    );
  }
  const withCallback = probe.control.digestWithCallbackExcludingAskTool;
  const withoutCallback = probe.control.digestWithoutCallbackExcludingAskTool;
  if (withCallback === undefined || withoutCallback === undefined) {
    throw new Error(
      `${where}：声明走 \`host-tool\` 通道，却没交出「归一之后」的两臂指纹——`
      + '这一档的对照臂判据就是靠它们把那一件工具之外的部分逐字比一遍',
    );
  }
  checkDigestsUnchanged(
    where,
    withCallback,
    withoutCallback,
    `（两臂各自把 ${hostToolName} 那一件归一到同一形态之后再比）`,
  );
}

/** 「两臂产物逐字相同」这一格的唯一判据口：红的时候把两串指纹都打出来，便于直接看出差在哪 */
function checkDigestsUnchanged(where: string, withCallback: string, withoutCallback: string, note = ''): void {
  if (withCallback === withoutCallback) return;
  throw new Error(
    `${where}：不传回调的对照运行产物与带回调那次不同——「不问就不动」不成立${note}\n`
    + `带回调：${withCallback}\n没传回调：${withoutCallback}`,
  );
}
