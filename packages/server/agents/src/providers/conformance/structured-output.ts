/**
 * 结构化输出（智能体作为评分者）的判据——**独立模块**，供一致性套件接线。
 *
 * 为什么单列成模块而不是直接写进 `kit.ts`：套件是「与厂商无关」的判据集合，而这一组的输入形状
 * 与消息归一无关（它只看运行结果里那几格），独立成模块后，接线只需在套件里加一行，且本模块
 * 能被自测直接调用（每条判据都要见过失败）。
 *
 * 判据源：`docs/protocols/sdk-onboarding.md`（新增 SDK 接入流程）。
 * 评分通路只读 `AgentRunResult.finalText`，并要求它是**可解析的 JSON**；结构化输出把这一步从
 * 「靠模型自觉吐 JSON」变成「厂商保证形状」，而**不支持结构化的那一家必须仍有降级路径**
 * （从文本里提取 JSON）——否则它永远评不了分。
 */
export interface StructuredOutputProbe {
  /** 该家本次运行的能力声明里那一格（`capabilities.structuredOutput`） */
  structuredOutput: boolean;
  /** 本次运行是否真的把 schema 发给了厂商（声明与请求必须一致，这是「传输」在契约层的可判定形态） */
  hasOutputSchema: boolean;
  /** 运行结果里的最终答复；`null` = 没采到 */
  finalText: string | null;
  /** 该场景期望的结构化对象；省略 = 不比对内容，只判「可解析」 */
  expected?: unknown;
  /** 该场景是否以「解析失败」收场 */
  failed?: boolean;
  /** 失败时的可见归因（失败码 / 错误信息）；`null` 或缺席 = 静默失败 */
  failureReason?: string | null;
}

/** 递归按键排序后序列化：只用于比对，避免两边键序不同造成假红 */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

/**
 * 四条判据，缺一不可：
 *  1. **声明与请求互钉**：声明能用结构化 ⇒ 本次运行必须真的把 schema 发给厂商；
 *  2. **产出可解析**：非失败场景下 `finalText` 必须能 `JSON.parse`（结构化或文本降级，两条路都得过）；
 *  3. **内容相符**：给了期望就必须逐字段相等（不许是拼接/改写过的文本）；
 *  4. **失败可见**：失败场景必须带归因，且空串不算答复（`finalText === ''` 是「没采到」的伪装）。
 */
export function checkStructuredOutput(probe: StructuredOutputProbe): void {
  if (probe.structuredOutput && !probe.hasOutputSchema) {
    throw new Error('声明 structuredOutput=true，但本次运行没有把 schema 发给厂商（声明与请求不符）');
  }
  if (probe.finalText === '') {
    throw new Error('最终答复是空串——没采到必须记 null，两者是不同的归因');
  }
  if (probe.failed === true) {
    const reason = probe.failureReason ?? '';
    if (reason.trim() === '') {
      throw new Error('以「解析失败」收场却没有任何归因——失败必须可见，静默的空评分比报错更糟');
    }
    return;
  }
  if (probe.finalText === null) {
    throw new Error('非失败场景却没有最终答复——评分通路拿不到可解析的产出');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(probe.finalText);
  } catch (error) {
    throw new Error(`最终答复不是可解析的 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
  if (probe.expected !== undefined && canonical(parsed) !== canonical(probe.expected)) {
    throw new Error(`结构化产出与期望不符：期望 ${canonical(probe.expected)}，实际 ${canonical(parsed)}`);
  }
}
