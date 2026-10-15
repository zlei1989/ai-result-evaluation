// @vitest-environment node
/**
 * 骨架入参 / 结果 / 元数据上的**注入面**：`AgentRunInput.inject` 与 `resume`、
 * `AgentRunResult.sessionId`、`AgentProviderMetadata.turnInjection`。
 *
 * 这一面的判据大多是**编译期**的（形状对不对只有 `tsc` 看得见），故本文件里同时放两种断言：
 *   · 类型面判据：可选 / 必填的**方向**（用函数签名与条件类型，不用带标注的字面量——那会被 TS
 *     的控制流窄化，对「本地类型变宽」完全没有区分力）；
 *   · 运行时判据：词表取值（从 contracts 再导出的那一份必须与真源同一个值域）。
 *
 * 三条口径（写在这里因为它们决定了下面每条断言为什么长这样）：
 *   1. `inject` / `resume` **必须可选**：缺席就是「这一轮不进人工消息」/「开新会话」，
 *      既有调用方一个字都不改就能编译——这就是零回归在类型面上的形态；
 *   2. `sessionId` **必须恒有**（`| null`，不是可选键）：与 `tokens` / `subagentTurns` 同形，
 *      「没采到」要能被消费方看见；
 *   3. 端口只依赖入参：`agents` 不知道「哪一行 / 哪一轮」，所以端口上没有任何身份格。
 */
import { InjectionBoundarySchema, RetractOutcomeSchema } from '@aieval/contracts';
import type {
  InjectionBoundary as ContractsBoundary,
  RetractOutcome as ContractsOutcome,
} from '@aieval/contracts';
import { describe, expect, it } from 'vitest';
import type { AgentRunInput, AgentRunResult, InjectionPort, InjectionBoundary, RetractOutcome } from './types';

/**
 * 类型面判据的载体：`required` / `optional` 两个方向各一条。
 * 用条件类型而不是 `const value: T = ...`：后者会被字面量窄化，见 `contracts-alignment.test.ts`
 * 里那条实测结论。
 */
type IsOptional<T, K extends keyof T> = undefined extends T[K] ? true : false;
type IsRequired<T, K extends keyof T> = undefined extends T[K] ? false : true;

const injectIsOptional: IsOptional<AgentRunInput, 'inject'> = true;
const resumeIsOptional: IsOptional<AgentRunInput, 'resume'> = true;
const sessionIdIsRequired: IsRequired<AgentRunResult, 'sessionId'> = true;

/** 端口的四格：少一格、或改成一格可选，都在 `tsc` 上见红 */
const portCells: ReadonlyArray<keyof InjectionPort> = ['available', 'drain', 'markDelivered', 'retract'];

/** 一份最小实现：四格的签名合不合契约，编译期说了算（`tsc` 报缺格 / 参数对不上） */
const port: InjectionPort = {
  available: false,
  drain: (boundary) => (boundary === 'round' ? [] : []),
  markDelivered: (ids, retract) => {
    void ids;
    void retract;
  },
  retract: async () => 'unsupported',
};

describe('端口形状', () => {
  it('四格齐备：available / drain / markDelivered / retract', () => {
    expect(portCells).toEqual(['available', 'drain', 'markDelivered', 'retract']);
    expect(port.available).toBe(false);
  });

  it('`drain` 交出来的是「身份 + 交给厂商的正文」，不是队列条目', () => {
    // 端口不认「队列」这个概念（业务无关）：取件规则由它自己按边界实现，
    // 交出来的每一条只带 id 与**编排层已经拼好**的正文（附件清单在那段文本里）
    const drained = port.drain('idle');
    expect(drained).toEqual([]);
  });

  it('`markDelivered` 与 `retract` 成对：撤不回来的那一家如实回 `unsupported`', async () => {
    port.markDelivered(['m-1'], async () => 'already-consumed');
    await expect(port.retract('m-1')).resolves.toBe('unsupported');
  });
});

describe('可选的入参格 / 恒有的结果格（类型面）', () => {
  it('`inject` 与 `resume` 可选、`sessionId` 恒有', () => {
    // 运行时影子：真判据是上面的三行类型断言（`tsc` 见红即守卫生效）
    expect([injectIsOptional, resumeIsOptional, sessionIdIsRequired]).toEqual([true, true, true]);
  });
});

describe('词表：本包再导出的一份与 contracts 同义', () => {
  it('两档边界（编译期两向可赋值 + 取值空间与 schema 一致）', () => {
    const toContracts = (value: InjectionBoundary): ContractsBoundary => value; // 本地变宽即编译失败
    const fromContracts = (value: ContractsBoundary): InjectionBoundary => value; // 本地变窄即编译失败
    expect([toContracts('round'), fromContracts('idle')]).toEqual(['round', 'idle']);
    expect([...InjectionBoundarySchema.options]).toEqual(['round', 'idle']);
  });

  it('撤回结果四值（同上）', () => {
    const toContracts = (value: RetractOutcome): ContractsOutcome => value;
    const fromContracts = (value: ContractsOutcome): RetractOutcome => value;
    expect([toContracts('retracted'), fromContracts('unknown')]).toEqual(['retracted', 'unknown']);
    expect([...RetractOutcomeSchema.options]).toEqual(['retracted', 'already-consumed', 'unsupported', 'unknown']);
  });
});
