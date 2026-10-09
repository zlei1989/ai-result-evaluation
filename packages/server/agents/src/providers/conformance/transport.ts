/**
 * C 类（协议时序）判据——**独立模块**，供一致性套件接线。
 *
 * 为什么判据建在「传输层事件序列」上，而不是让 fixture 自述：C 类的真实缺陷是
 * **夹具时序比真实更宽松/更苛刻**，于是单测绿、真机红。让 fixture 声明「我缓冲了通知」
 * 是无区分力的假判据（谁都可以声明）；能判的只有**事件发生的先后**这一事实本身。
 * 所以本模块吃一份**传输层笔迹**（谁先谁后 + 消费方实际收到什么），四条判据全部是可机械核对的。
 *
 * 三条真实故障形态（都发生在本次改造期间）：
 *   1. **订阅前产生的通知丢失**：厂商在提示词发出后立刻推送，而消费方还没订阅 ⇒ 必须缓冲后补投；
 *   2. **终态早于响应**：终态通知与「请求返回」写在同一 tick ⇒ 收尾看到的是半截状态（本次单测
 *      40 秒超时的真因就是这类时序假设）；
 *   3. **重复投递 / 凭空冒出**：补投与直投各来一次，或消费方收到了厂商从未发过的条目。
 */
export interface TransportStep {
  /** `subscribe` 订阅；`push` 厂商推送（通知）；`response` 请求响应；`terminal` 终态通知 */
  kind: 'subscribe' | 'push' | 'response' | 'terminal';
  /** 该事件的标识（推送与终态用它比对「到底有没有到达」）；`subscribe`/`response` 可省 */
  id?: string;
}

export interface TransportTranscript {
  /** 按**真实发生顺序**记录的传输事件 */
  steps: readonly TransportStep[];
  /** 消费方**实际收到**的通知 id（按到达顺序） */
  observed: readonly string[];
}

/** 同类事件的下标（`id` 相同才算同一个；无 id 时取第一条） */
function indexOfStep(steps: readonly TransportStep[], kind: TransportStep['kind'], id?: string): number {
  return steps.findIndex((step) => step.kind === kind && (id === undefined || step.id === id));
}

/**
 * 四条判据，缺一不可：
 *  1. **订阅前的推送不得丢失**：凡在 `subscribe` 之前产生的 `push`，消费方都必须最终收到（缓冲补投）；
 *  2. **终态不得早于响应**：同一轮的 `terminal` 必须排在它的 `response` 之后（否则收尾看到半截状态）；
 *  3. **不得重复投递**：同一条通知只许到达一次（补投与直投都来一次是最常见的写法错）；
 *  4. **不得凭空冒出**：`observed` 里的每条都必须在笔迹里出现过（消费方不能收到厂商没发过的东西）。
 */
export function checkTransportDelivery(transcript: TransportTranscript): void {
  const { steps, observed } = transcript;
  const subscribeAt = indexOfStep(steps, 'subscribe');

  if (subscribeAt >= 0) {
    for (const [index, step] of steps.entries()) {
      if (step.kind !== 'push' || index > subscribeAt || step.id === undefined) continue;
      if (!observed.includes(step.id)) {
        throw new Error(`订阅前推送的 ${step.id} 没被消费方收到——必须先缓冲、订阅后补投，不许丢`);
      }
    }
  }

  for (const step of steps) {
    if (step.kind !== 'terminal') continue;
    const responseAt = indexOfStep(steps, 'response');
    const terminalAt = indexOfStep(steps, 'terminal', step.id);
    if (responseAt >= 0 && terminalAt >= 0 && terminalAt < responseAt) {
      throw new Error(`终态 ${step.id ?? ''} 早于请求响应——收尾会看到半截状态（时序假设与真实相反）`);
    }
  }

  const seen = new Set<string>();
  for (const id of observed) {
    if (seen.has(id)) throw new Error(`${id} 被投递了两次——补投与直投只能留一条`);
    seen.add(id);
  }

  // 「厂商发过」= 推送**与终态**（终态也是一条会到达消费方的通知，漏算它就会把合法的终态 id 判成冒出）
  const produced = new Set(
    steps.filter((step) => step.kind === 'push' || step.kind === 'terminal').map((step) => step.id),
  );
  for (const id of observed) {
    if (!produced.has(id)) throw new Error(`${id} 在消费方出现了，但笔迹里厂商从未推送过它`);
  }
}
