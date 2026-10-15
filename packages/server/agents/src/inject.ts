/**
 * 注入端口的**等待语义**那一格：骨架提供给端口那一侧的登记口，以及「一段等待最多多久」的缺省预算。
 *
 * 与既有 `ask-user.ts` 的关系是**同一条口径的镜像**（那边是「模型问人」，这边是「人喂模型」）：
 * 骨架不认识「队列」这个词（`@aieval/agents` 业务无关），它只认**端口说现在在等**
 * ——`InjectionWaitSink.enter` / `leave` 由包装层在端口那一侧调用，骨架据此在静止超时判据里
 * 多认一格（见 `turn.ts` 的 `INJECTION_WAIT_SUSPENDS_WATCHDOG`）。
 *
 * 三条口径：
 *
 *   1. **豁免窗口要窄**：只在「适配器已收工、只剩队列」时为真，判据是**适配器自己说的**
 *      ——它在 `'idle'` 边界取件（契约里 `'idle'` 的定义就是「这一整轮没活可干了」）。
 *      适配器还在跑时事件照来，那一段不需要豁免；宽了就会把真挂死藏起来
 *      （与「等待审批」那格刻意不豁免同一条理由：不许拿事件名凑判据）。
 *   2. **`leave` 必须做满三件事**（推墙钟 / `noteActivity` / 重排看门狗）：少做一件，
 *      「挂起之后看门狗再也不排」。三件事都由骨架的 sink 实现，本模块只负责**什么时候**调它。
 *   3. **`drain` 交出条目之后要离开窗口**：那说明适配器手上又有活了。
 *      一次「取件为空 ⇒ 进入」与一次「取件非空 ⇒ 离开」是配对的两个时刻。
 *
 * 为什么包装而不是让适配器自己登记：适配器只该认「取件」这一件事（两档边界归它认、
 * 等待语义归骨架）；四处各写一遍「什么时候算在等」必然漂，而漂的表现是同一件事在两家
 * 一个豁免、一个被自己的看门狗掐掉。
 */
import type { InjectionPort, UserMessage } from './types';
import type { InjectionBoundary } from '@aieval/contracts';

/**
 * 一段等待的**缺省预算**（毫秒）：端口这一侧只回答「最多等多久」，
 * 真正的收场（把等太久的那条落 `gone`）由**编排层**做——表在它那一侧。
 *
 * 取值理由与提问应答面同源：这一格按轮显式开启，等的是「有人正在看着界面」的那一轮；
 * 十分钟够一个人把手上的事告一段落，又不会让一行永远挂在一条投不出去的消息上。
 */
export const DEFAULT_INJECT_WAIT_BUDGET_MS = 600_000;

/**
 * 等待期的登记口：骨架用它把「在等人工消息」登记进**静止超时豁免**判据表
 * （前两格是「工具在途」与「在等人回答」）。
 *
 * 为什么必须登记：这一段里厂商一个事件都不会产出（适配器已经没活可干了），
 * 不登记就会被自己的看门狗按静止超时收掉。
 */
export interface InjectionWaitSink {
  /** 进入等待（可重入：包装层保证至多一次在飞，计数器仍按可重入写） */
  enter: () => void;
  /** 离开等待（与 `enter` 配对；最后一次离开会重新起表并重排看门狗） */
  leave: () => void;
}

/** 包装层交给骨架的两半：给适配器的那份端口，与收尾时的闭合入口 */
export interface InjectWaitHandle {
  /** 交给适配器的那一份端口（四格逐字透传，只有「现在在等」这一格由包装层登记） */
  port: InjectionPort;
  /** 收尾：离开这一格（run 结束时调，此后不再登记）。幂等。 */
  close: () => void;
}

/**
 * 把端口包一层，替骨架登记「现在在等」。
 *
 * 只有一格被改写（`drain` 的结果决定进 / 出窗口），`markDelivered` / `retract` / `available`
 * 逐字透传——端口那一侧的实现（编排层）不该知道骨架的看门狗存在。
 */
export function withInjectionWait(port: InjectionPort, wait: InjectionWaitSink | undefined): InjectWaitHandle {
  /** 窗口开着没有。**至多一次在飞**：重复 `enter` 会把「等了多久」算成从最后一次进入起算 */
  let waiting = false;

  const leave = (): void => {
    if (!waiting) return;
    waiting = false;
    wait?.leave();
  };

  const enter = (): void => {
    if (waiting) return;
    waiting = true;
    wait?.enter();
  };

  return {
    port: {
      available: port.available,
      drain: (boundary: InjectionBoundary): UserMessage[] => {
        const messages = port.drain(boundary);
        // 取到东西 ⇒ 适配器又有活干了（无论哪一档）；在 `'idle'` 边界空手而归 ⇒ 它已收工
        if (messages.length > 0) leave();
        else if (boundary === 'idle') enter();
        return messages;
      },
      // 确认交付是「这一批投完了」的时刻：窗口照旧由下一次取件重新决定（`leave` 幂等）
      markDelivered: (ids, retract): void => {
        leave();
        port.markDelivered(ids, retract);
      },
      retract: (id) => port.retract(id),
    },
    close: leave,
  };
}
