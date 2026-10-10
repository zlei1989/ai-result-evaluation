// @vitest-environment node
/**
 * 与 contracts 的取值空间对齐。
 * 为什么需要：`agents` 里的 `AGENT_KINDS` 是再导出、`ProtocolType` 是 spec 明写的重复声明，
 * 两处一旦与 contracts 漂移，前端下拉（读注册表）与行数据（读 contracts）就会给出不同的家数/协议。
 * `AgentKind` 与 `ProtocolType` 的对齐都用**编译期断言**：任一处的取值空间被改动（变宽或变窄），本文件会直接编译不过。
 * 注意：这类守卫的变异证据是 **`pnpm --filter @aieval/agents typecheck` 退出非 0**，不是 `test` 变红——
 * 单跑 `test` 对「类型变宽」是全绿的（`tsc` 才看得见）。
 */
import { AGENT_KINDS, AGENT_LABELS, AgentKindSchema, ProtocolTypeSchema } from '@aieval/contracts';
import type { AgentKind as ContractsAgentKind, ProtocolType as ContractsProtocolType } from '@aieval/contracts';
import { describe, expect, it } from 'vitest';
import { AGENT_KINDS as REEXPORTED_AGENT_KINDS, type AgentKind, type ProtocolType } from './types';

describe('AGENT_KINDS 再导出', () => {
  it('与 contracts 的 schema 选项逐项同序', () => {
    expect([...REEXPORTED_AGENT_KINDS]).toEqual([...AgentKindSchema.options]);
  });

  it('三家都有中文标签（前端下拉文案与注册表 displayName 各自有源，不互相偷）', () => {
    for (const kind of AGENT_KINDS) {
      expect(AGENT_LABELS[kind]).toBeTruthy();
    }
  });
});

describe('AgentKind 类型面（真源在 contracts）', () => {
  it('与 contracts 的同义（编译期断言：两个方向都要能赋值）', () => {
    /**
     * 与下面 `ProtocolType` 那条同源的手法：用**函数签名**而不是 `const kind: AgentKind = 'dsh'` 再互相赋值——
     * TS 的控制流分析会把带类型标注的字面量初始化 `const` 窄化成字面量类型，那种写法对「本地类型**变宽**」
     * （例如多出 `'gemini'`）完全没有区分力（已实测：变异体在 `test` 与 `typecheck` 上双双存活）。
     * 为什么值得单独守：`AGENT_KINDS`（值）有运行时断言，但 `AgentKind`（类型面）一旦变宽，
     * 前端下拉（读注册表）与行数据（读 contracts）就能给出不同的家数，而两侧测试都不会红。
     */
    const kindToContracts = (value: AgentKind): ContractsAgentKind => value; // 本地 → contracts（变宽即编译失败）
    const kindFromContracts = (value: ContractsAgentKind): AgentKind => value; // contracts → 本地（变窄即编译失败）
    expect([kindToContracts('dsh'), kindFromContracts('dsh')]).toEqual(['dsh', 'dsh']);
  });
});

describe('ProtocolType 重复声明', () => {
  it('与 contracts 的同义（编译期断言：两个方向都要能赋值）', () => {
    /**
     * 为什么用**函数签名**而不是 `const local: ProtocolType = 'anthropic'` 再互相赋值：
     * TS 的控制流分析会把带类型标注的字面量初始化 `const` 窄化成字面量类型，于是那个写法实际只校验了
     * `'anthropic' → 'anthropic'` ——本地 `ProtocolType` **变宽**（例如多出 `'gemini'`）时两个方向都不报错
     * （已实测：该变异体全绿存活）。函数返回值与参数的类型可赋值性不受字面量窄化影响，两个方向才真正被钉住。
     */
    const toContracts = (value: ProtocolType): ContractsProtocolType => value; // 本地 → contracts（变宽即编译失败）
    const fromContracts = (value: ContractsProtocolType): ProtocolType => value; // contracts → 本地（变窄即编译失败）
    expect([toContracts('anthropic'), fromContracts('anthropic')]).toEqual(['anthropic', 'anthropic']);
  });

  it('取值空间与 contracts 的 schema 一致', () => {
    expect([...ProtocolTypeSchema.options]).toEqual(['openai', 'anthropic']);
  });
});
