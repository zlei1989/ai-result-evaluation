/**
 * 结构化输出（智能体作为评分者）的判据——**独立模块**，供一致性套件接线。
 *
 * 为什么单列成模块而不是直接写进 `kit.ts`：套件是「与厂商无关」的判据集合，而这一组的输入形状
 * 与消息归一无关（它只看运行结果里那几格），独立成模块后，接线只需在套件里加一行，且本模块
 * 能被自测直接调用（每条判据都要见过失败）。
 *
 * 判据源：`docs/protocols/sdk-onboarding.md`（新增 SDK 接入流程）。评分通路只读
 * `AgentRunResult.finalText`，并要求它是**可解析的 JSON**。三家对齐的口径不是「人人都有原生通道」，
 * 而是「要了 schema 就按它交付，交不出来就如实失败」：有原生 schema 通道的家由厂商保证形状，
 * 没有的家在适配器内部用**填充层**（首轮提示词交代约束 + 同会话修正轮）对齐。本模块判的就是
 * 这两条路各自的可判定形态：
 *   1. **上报与请求互钉**：上报走了原生通道（`applied.structuredOutput`）⇒ 本次运行必须真的把
 *      schema 发给了厂商（`hasOutputSchema`，夹具在**请求侧**观测到的事实）；上报没走原生通道是
 *      **允许**的——走填充层的家本来就没有那一步，但它们的答复仍要过第 2 条。
 *   2. **产出可解析 + 内容相符**：判据与运行时**共用同一份实现**——
 *      `inspectStructuredOutput(planStructuredOutput(true), text)`（`true` 是 JSON Schema 的「无约束」写法
 *      ⇒ 只判可解析，同样会剥「整段以 ``` 开头」的围栏）。这里**不再自己写一份 `JSON.parse`**：
 *      两份判据必然漂移，而漂移的表现是「套件绿、运行时红」。
 */
import { inspectStructuredOutput, planStructuredOutput } from '../../structured-output';

export interface StructuredOutputProbe {
  /** 本次运行**上报**的通道事实（= `AgentRunResult.applied.structuredOutput`）：有没有走原生 schema 通道 */
  nativeChannel: boolean;
  /**
   * **请求侧**观测到的事实：本次运行真的把 schema 发给了厂商吗。
   * 有原生通道的家从「发出去的那份请求」上读（cc 的 `options.outputFormat`、codex 的 `turn/start.outputSchema`）；
   * 没有原生通道的家恒 `false`——它只能把约束写进提示词，那不是「发给厂商的 schema」。
   */
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
 * 「只判可解析」的计划：`true` 是 JSON Schema 的布尔 schema（什么都可以），编译器把它翻成
 * `z.unknown()` ⇒ `inspectStructuredOutput` 只做剥围栏 + `JSON.parse`。
 * 计划是常量，编译一次即可（每次检查都要用它）。
 */
const UNCONSTRAINED_PLAN = planStructuredOutput(true);

/**
 * 四条判据，缺一不可：
 *  1. **上报与请求互钉**：上报走了原生通道 ⇒ 本次运行必须真的把 schema 发给了厂商；没走原生通道是允许的；
 *  2. **产出可解析**：非失败场景下 `finalText` 必须过 `structured-output.ts` 的判据（剥围栏 + `JSON.parse`）——
 *     原生通道与填充层两条路都得过；
 *  3. **内容相符**：给了期望就必须逐字段相等（不许是拼接/改写过的文本）；
 *  4. **失败可见**：失败场景必须带归因，且空串不算答复（`finalText === ''` 是「没采到」的伪装）。
 */
export function checkStructuredOutput(probe: StructuredOutputProbe): void {
  if (probe.nativeChannel && !probe.hasOutputSchema) {
    throw new Error(
      '上报走了原生 schema 通道（applied.structuredOutput=true），但本次运行没有把 schema 发给厂商（声明与请求不符）',
    );
  }
  if (probe.finalText === '') {
    throw new Error('最终答复是空串——没采到必须记 null，两者是不同的归因');
  }
  if (probe.failed === true) {
    const reason = probe.failureReason ?? '';
    if (reason.trim() === '') {
      throw new Error('以「解析失败」收场却没有任何归因——失败必须可见，静默的空产出比报错更糟');
    }
    return;
  }
  if (probe.finalText === null) {
    throw new Error('非失败场景却没有最终答复——需要结构化产出的调用方拿不到可解析的答复');
  }
  const inspection = inspectStructuredOutput(UNCONSTRAINED_PLAN, probe.finalText);
  if (!inspection.ok) {
    const problems = inspection.problems.map((problem) => `${problem.path}：${problem.message}`).join('；');
    throw new Error(`最终答复不是可解析的 JSON（${problems}）`);
  }
  if (probe.expected !== undefined && canonical(inspection.value) !== canonical(probe.expected)) {
    throw new Error(`结构化产出与期望不符：期望 ${canonical(probe.expected)}，实际 ${canonical(inspection.value)}`);
  }
}
