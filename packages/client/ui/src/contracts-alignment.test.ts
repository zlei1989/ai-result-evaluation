// @vitest-environment node
/**
 * **界面侧答案与收场 ↔ 契约的同义断言**。
 *
 * 为什么需要：界面**故意**持有自己那一份形状（`agent-log/types.ts` 的 `AskUserAnswer` /
 * `AskUserOutcome`）——界面词汇里数组一律 `readonly`，而契约用可变数组；界面渲染也只认
 * 「已配对、已分组的渲染模型」。但两份形状一旦漂移，症状是**静默的**：契约里多出一格答案字段，
 * 界面照旧画它认识的几格，没人会红；契约改了收场取值，界面上那一档就永远不出现。
 *
 * 判据刻意是**编译期**的，与 `packages/server/agents/src/contracts-alignment.test.ts` 同一类守卫：
 * 任一处的取值空间被改动（变宽、变窄、多一格、少一格）时，`pnpm typecheck` 直接不过，
 * 而运行期断言只负责证明这些函数真的被调用过。
 * 手法也同源：用**函数签名**而不是 `const x: T = …` 互相赋值——带类型标注的字面量初始化会被
 * TS 的控制流分析窄化成字面量类型，那种写法对「本地类型变宽」没有区分力。
 */
import { AskUserOutcomeSchema } from '@aieval/contracts';
import type { AskUserAnswer as ContractsAnswer, AskUserOutcome as ContractsOutcome } from '@aieval/contracts';
import { describe, expect, it } from 'vitest';
import type { AskUserAnswer, AskUserOutcome } from './composite/agent-log/types';

/**
 * 剥掉 `readonly`（递归到嵌套数组与对象）：这是界面与契约之间**唯一**允许的差别
 * ——界面把数组声明成只读（渲染层不该改数据层给的东西），契约用可变数组。
 * 其余每一格必须逐字相同，包括可空性：`custom: null` 与 `custom?: string` 是两件事。
 */
type Writable<T> = T extends readonly (infer U)[]
  ? Writable<U>[]
  : T extends object
    ? { -readonly [K in keyof T]: Writable<T[K]> }
    : T;

/**
 * 一份界面侧答案的样本：类型取 `Writable<AskUserAnswer>`，这样它同时能喂给两个方向的断言函数
 * （只读那一层差别由 `Writable` 剥掉，其余每一格仍然是界面侧那份声明说了算）。
 */
const uiAnswer: Writable<AskUserAnswer> = {
  header: '选路径',
  selected: ['选项 A'],
  custom: null,
};

const uiOutcomes: readonly AskUserOutcome[] = [
  'answered',
  'auto-resolved',
  'skipped',
  'timeout',
  'unavailable',
  'rejected',
  'canceled',
];

describe('界面侧答案与收场与契约同义', () => {
  it('一份答案逐字同形（编译期：两个方向都要能赋值）', () => {
    const toContracts = (value: Writable<AskUserAnswer>): ContractsAnswer => value;
    const fromContracts = (value: ContractsAnswer): AskUserAnswer => value;
    expect(toContracts(uiAnswer)).toBe(uiAnswer);
    expect(fromContracts(uiAnswer)).toBe(uiAnswer);
  });

  it('收场七态逐字同形（编译期：两个方向都要能赋值）', () => {
    const toContracts = (value: AskUserOutcome): ContractsOutcome => value;
    const fromContracts = (value: ContractsOutcome): AskUserOutcome => value;
    // 运行期再对一次取值清单：编译期只保证「能互相赋值」，漏掉一整档时两个联合可能仍然相容
    expect([...uiOutcomes]).toEqual([...AskUserOutcomeSchema.options]);
    expect(uiOutcomes.map(toContracts)).toEqual(uiOutcomes.map(fromContracts));
  });
});
