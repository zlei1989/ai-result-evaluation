/**
 * 人工消息的**词表**：可投递边界（两档）、一条消息在队列表里的四态、以及它收场时的落点（五值）。
 *
 * 为什么单独一格而不是留在 `agent-message.ts`（边界词表原来的落点）：这三份词表**行级事件与队列表都要用**
 * ——「这一条最后怎么收场的」进 `events.jsonl`，「它现在在哪一态」进队列快照。若把定义留在
 * `agent-message`，`agent-event` 引它就会与既有那条「`agent-message` 引 `agent-event` 的
 * `UsageTokensSchema`」构成环：环上先求值的那个模块拿到的是 `undefined`，而 zod 在模块求值期就会读这些
 * 枚举（不是等到解析时才读），表现为导入即崩。本模块不 import 任何其它契约模块，两个方向都只 import 它，
 * 环因此不存在（与 `ask-user-vocab.ts` 同一条理由、同一处置）。
 */
import { z } from 'zod';

/**
 * **注入边界**：人往运行中的一轮送话时，适配器**在哪个可观察事件上取件投出去**。词表刻意避开厂商词汇
 * （`turn` 在四家之间两头撞：一家的「本轮」是另一家的「下一轮」），只留两档：
 *   · `'round'`——一次模型往返 + 它请求的**整批**工具全部结束、下一次模型往返之前（「立即发送」要这一档）；
 *   · `'idle'`——这一整轮**没活可干了**，另起一轮再投（「排队」是这一档）。
 *
 * ⚠️ **这两档说的是「我们什么时候交出去」，不是「厂商一定怎么处置」**：交出去之后由厂商决定
 * 是折进当前那次请求，还是另起一轮。claude 的真机实测（CLI 2.1.281）两档落点都是**另起一轮**
 * ——折入发生在厂商**构造那条请求之前**，而这两档的取件点都在构造之后；
 * 折入本身存在（工具在途时推的那条会被折进带工具结果的请求）⇒ 别把 `'round'` 读成
 * 「本轮一定只有一个 `result`」。各家实测写进各自的能力声明（见 `TurnInjectionCapability`）。
 *
 * 「等**一次**工具调用跑完」那一档刻意不存在：四家在那一刻都没有可观察的投递面
 * （`item/completed` 能**观察**一次工具调用的结束，但可观察 ≠ 投得进去），而绕过它去包装工具调用
 * 只会静默失效——claude 由我们自己在流循环里认边界，同样只认上面这两个可观察事件。
 */
export const InjectionBoundarySchema = z.enum(['round', 'idle']);
export type InjectionBoundary = z.infer<typeof InjectionBoundarySchema>;

/**
 * **一条人工消息在队列表里的四态**（真相源是服务端进程内那张表）。
 *
 * 四态回答的是「它现在还能不能要回来」，因此每一态的处置都不同：
 *   · `queued`——还在我们的表里、没投出去 ⇒ 摘掉即可；
 *   · `delivered`——已交给厂商、厂商还没交给模型 ⇒ 走这一家这一档的撤回面；
 *   · `consumed`——厂商已经交给模型了 ⇒ 撤不回来，如实说；
 *   · `gone`——已撤回 / 已丢弃（终态，**留在表里**：幂等要看得出「这一条已经处理过」）。
 *
 * `consumed` 是**惰性判定**：我们不为每一条已投递消息养一个厂商侧观察者（有的家根本没有队列快照），
 * 只在撤回尝试那一刻读一次厂商侧、拿到「已经交出去了」才知道。
 *
 * ⚠️ **界面上写「排队中」的那一格必须容得下一段延迟**：取件的节拍是**适配器的通知边界**
 * （端口只有取件一格、没有「有新消息」的信号）⇒ 两次通知之间到达的那句话要等到下一格才被取走，
 * 而 `'idle'` 档更要等「这一整轮没活可干了」。所以 `queued` 不等于「马上就到」，
 * 文案与动效都不许把它渲染成「已送达」。
 */
export const INJECT_MESSAGE_STATES = ['queued', 'delivered', 'consumed', 'gone'] as const;
export const InjectMessageStateSchema = z.enum(INJECT_MESSAGE_STATES);
export type InjectMessageState = z.infer<typeof InjectMessageStateSchema>;

/**
 * **没有投出去的那两种收场**（终态，条目落 `gone`）：行收场时还没投递的条目走 `discarded`，
 * 等待预算到点的那一批走 `timed-out`。两者分开是因为处置动作完全不同——前者是「这一行结束了」，
 * 后者是「这一行还在，但这一条等太久了」。
 */
export const INJECT_DROP_REASONS = ['discarded', 'timed-out'] as const;

/**
 * **一条人工消息的收场**（行级事件的载荷）：投递两值 + 上面那两种丢弃 + 撤回的两个结果。
 *
 * 与 `RetractOutcome` 的关系是**刻意重叠而不是相等**：`retracted` / `already-consumed` 逐字复用它的
 * 两个取值（同一次撤回在两处说的是同一件事），而 `unsupported` / `unknown` 不进这里——那两种撤回
 * 结果**什么也没改变**，那一条仍在 `delivered` 上等下一次机会，落一条「已撤回」的事件会说假话。
 */
export const INJECT_MESSAGE_OUTCOMES = ['delivered', 'retracted', 'already-consumed', ...INJECT_DROP_REASONS] as const;
export const InjectMessageOutcomeSchema = z.enum(INJECT_MESSAGE_OUTCOMES);
export type InjectMessageOutcome = z.infer<typeof InjectMessageOutcomeSchema>;
