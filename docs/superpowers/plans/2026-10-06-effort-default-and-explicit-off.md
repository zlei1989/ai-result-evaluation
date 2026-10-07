# 思考强度：未选不关闭 + 显式关闭（三家口径统一）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 三家的「未选思考强度」不再导致关闭（dsh 走缺省 `high`，claude / codex 不传、由厂商推断），并且「关闭思考」只能由用户**显式选 `off`** 触发（各适配器把统一的 `off` 翻成厂商词汇）。

**Architecture:** 取档逻辑全部落在**适配器内部**（候选评测行与智能体评分都走 `agentProvider.run` ⇒ 一处覆盖两条路径，evaluator 的调用点一个字不动）；契约与界面**统一用档名 `off`**；API 侧把档位候选放宽到「该家完整档位域 ∪ 关闭档」，让 `off` 在界面上真的可选。

**Tech Stack:** TypeScript 5（`strict` + `verbatimModuleSyntax`）、zod 3、vitest 4、React 19 + antd 6。

**Spec:** `docs/superpowers/specs/2026-10-01-agent-message-spec-design-v3.md` §3.6 / §8.1 / §8.2（本线的过程 spec 已并入该文档并从库中删除）

## Global Constraints

- **三家统一档名 `off`**（关注意义：显式关闭思考），由适配器翻成厂商词汇：dsh = `off`（harness 据 `off: null` 不写 reasoning）；claude = `thinking: { type: 'disabled' }`；**codex = `none`**（实测：CLI 的关闭档是 `none`，`off` 会被网关拒 —— spec §1.5）。
- **未选 ≠ 关闭**：dsh 未选 ⇒ 显式传 `high`；claude / codex 未选 ⇒ **不传**（厂商推断）。
- **不改 evaluator 的调用点**：`orchestrator.ts:1215` 的 `...(row.effort === undefined ? {} : { effort: row.effort })` 逐字保留；只修同段那句错注释。
- **不改 contracts 的 schema**：只新增一个常量 `EFFORT_OFF`；`EvalRow.effort` 仍是可选的字符串。
- **不做**：上游推荐档传递链、注册表 `defaultEffort`、路径 B（`callTextApi`：智能生成 / 智能识别 / 文本评分）的任何改动（spec §4）。
- 注释用中文 JSDoc；提交**逐个显式 `git add <路径>`**（禁止 `git add -A`）。
- **改既有用例的判据时，必须在用例注释里点名这次变更**（本仓口径变更的惯例）。
- 每个 Task 收尾：`pnpm typecheck` → `pnpm lint` → 该 Task 的测试文件；全部完成后跑一次全量 `pnpm test`。
- **每条新守卫都要做变异验证**：人为制造它要拦的缺陷、确认它**失败**，再还原并核对文件哈希未变。

---

### Task 1: dsh —— 未选档位时显式用缺省 `high`

**Files:**
- Modify: `packages/server/contracts/src/run.ts`（新增 `EFFORT_OFF` 常量）
- Modify: `packages/server/contracts/src/index.ts`（导出它）
- Modify: `packages/server/agents/src/providers/dsh/index.ts`（`DSH_REASONING_WIRE` 之后加常量；`run` 里那一行传参）
- Modify: `packages/server/agents/src/providers/dsh/sdk.ts:117-123`（修错注释）
- Modify: `packages/server/agents/src/types.ts:108-114`（`AgentRunInput.effort` 的注释改正）
- Test: `packages/server/agents/src/providers/dsh/index.test.ts:613-631`

**Interfaces:**
- Produces: `DSH_DEFAULT_EFFORT = 'high'`（导出，供测试与后续断言引用）
- Consumes: 既有 `DSH_REASONING_WIRE`（`off: null`）、`dshProvider.metadata.reasoningEfforts`

- [ ] **Step 1: 改既有用例判据（并写新用例）**

把 `index.test.ts:613-631` 那一组整体替换为（**这条判据变更是本次口径变更的落点，注释里已点名**）：

```ts
/**
 * 思考强度（spec §6.4 / D13；**2026-10-06 口径变更**：未选不再等于「不传」）。
 *
 * 为什么改：dsh 的「不传」实际是**显式关闭**（pi-ai 不写 reasoning 字段 ⇒ 落
 * `reasoning:{effort:'none'}`，见探测记录与 `sdk.ts` 的口径）。用户口径是「不能默认关闭，
 * 必须显式配置」⇒ 未选时由适配器给一个**会思考**的缺省档；关闭只能靠显式选 `off`。
 */
describe('dsh 的思考强度', () => {
  it('给了 effort ⇒ 原样带上；没给 ⇒ 用缺省档 high（不是「不传」）', async () => {
    const withEffort = createRecorder();
    setAgentRuntimeForTesting({ sdkModule: { [DSH_PACKAGE_NAME]: createFakeDshSdk({ recorder: withEffort, events: [] }) } });
    await dshProvider.run(createRunInput({ effort: 'max' }));
    expect(withEffort.options?.reasoningEffort).toBe('max');

    const bare = createRecorder();
    setAgentRuntimeForTesting({ sdkModule: { [DSH_PACKAGE_NAME]: createFakeDshSdk({ recorder: bare, events: [] }) } });
    await dshProvider.run(createRunInput());
    // 变更前这里是 `Object.hasOwn(...) === false`（「不传」）——那等于关闭
    expect(bare.options?.reasoningEffort).toBe(DSH_DEFAULT_EFFORT);
  });

  it('显式 off ⇒ 原样交给 harness（关闭由 harness 的 `off: null` 实现，适配器不特判）', async () => {
    const recorder = createRecorder();
    setAgentRuntimeForTesting({ sdkModule: { [DSH_PACKAGE_NAME]: createFakeDshSdk({ recorder, events: [] }) } });
    await dshProvider.run(createRunInput({ effort: 'off' }));
    expect(recorder.options?.reasoningEffort).toBe('off');
  });

  it('缺省档必须是「会思考」的档：在该家档位域里，且不是关闭档', () => {
    expect(dshProvider.metadata.reasoningEfforts).toContain(DSH_DEFAULT_EFFORT);
    expect(DSH_DEFAULT_EFFORT).not.toBe(EFFORT_OFF);
  });
});
```

import 行补：`import { DSH_DEFAULT_EFFORT } from './index';`（与既有的 `dshProvider` 同一条 import 语句里加）与 `import { EFFORT_OFF } from '@aieval/contracts';`（本 Task 的 Step 3 第一步就会创建它）。

- [ ] **Step 2: 跑测试确认它失败**

Run: `pnpm vitest run packages/server/agents/src/providers/dsh/index.test.ts`
Expected: FAIL —— `DSH_DEFAULT_EFFORT` 尚未导出（import 失败），以及缺省档那条断言红。

- [ ] **Step 3: 实现**

**第一步：把统一的关闭档名落进契约**（`contracts/src/run.ts`，放在 `EvalRowSchema` 之前）：

```ts
/**
 * **关闭思考**的档名（2026-10-06 统一）：契约、界面与三家适配器都用这一个值。
 * 各适配器负责把它翻成厂商词汇（dsh = `off`；claude = `thinking: { type: 'disabled' }`；
 * codex = `none`），因为三家的「关闭」在 wire 上根本不是同一个东西。
 */
export const EFFORT_OFF = 'off';
```

并在 `contracts/src/index.ts` 的导出清单里加上 `EFFORT_OFF`（与既有 `EvalRowSchema` 同一段）。

**第二步：dsh 侧的缺省档。** `providers/dsh/index.ts` 在 `DSH_REASONING_WIRE` 之后加：

```ts
/**
 * 未选档位时**显式**使用的缺省档（2026-10-06 用户口径：「不能默认关闭，必须显式配置」）。
 *
 * 为什么 dsh 不能「不传」：这一家的「不传」落到 `reasoning:{effort:'none'}`（= 关闭）。
 * 用户口径要求未选时仍然思考 ⇒ 缺省必须给一个非 `off` 的档。
 * 与 `DSH_REASONING_WIRE` 同源：`index.test.ts` 有一条守卫断言它在档位域里且不是关闭档。
 */
export const DSH_DEFAULT_EFFORT = 'high';
```

把 `run` 里那一行（`index.ts:527-528`）改成：

```ts
    // 思考强度（spec §6.4 / D13；2026-10-06 口径变更）：**恒带**——未选时用缺省档 `high`，
    // 不再有「undefined 时一个键都不加」这条路（那在 dsh 上等于关闭，见 DSH_DEFAULT_EFFORT 的注释）。
    // 显式 `off` 原样交给 harness：它按 `DSH_REASONING_WIRE.off = null` 不写 reasoning 字段 ⇒ 关闭。
    reasoningEffort: input.effort ?? DSH_DEFAULT_EFFORT,
```

`sdk.ts:117-123` 的注释改成：

```ts
  /**
   * 思考强度（`DeepSeekHarnessOptions.reasoningEffort`，值域由适配器插件定：`off/low/high/max`）。
   * 本仓按供应商声明的档位名原样透传。
   * ⚠️ **不给 ≠ 沿用模型默认**（2026-10-06 更正）：实测「不给」落到 `reasoning:{effort:'none'}`，
   * 也就是**显式关闭**。缺省档由适配器显式给（`DSH_DEFAULT_EFFORT`），关闭只有显式 `off` 才发生。
   * ⚠️ 这一格 dsh 侧是**硬校验**的（不支持的档位报 `UNSUPPORTED_REASONING_EFFORT`）。
   */
  reasoningEffort?: string;
```

`agents/src/types.ts:108-114` 的注释改为（同一句错口径的第三处，三处一起改才不会留下自相矛盾的注释）：

```ts
  /**
   * 要求的思考强度（可选，spec §4.4 / D12）。**为什么放这里而不是 route**：route 是**连接事实**
   * （协议 / 地址 / 密钥 / 模型名 / 窗口），而强度是**请求参数**——它与 `permission` 同类，
   * 且它的值域由该行选的智能体决定，与连接无关。
   * **未选 ≠ 关闭**（2026-10-06 更正）：未选表示「不指定」——dsh 的适配器给缺省档 `high`，
   * claude / codex 不传、由厂商推断；要关闭必须显式写 `EFFORT_OFF`（契约里的统一档名）。
   * 能不能收由创建时的候选校验保证（D10）。
   */
  effort?: string;
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm typecheck` → `pnpm vitest run packages/server/agents/src/providers/dsh/index.test.ts`
Expected: PASS

- [ ] **Step 5: 变异验证（两条）**

① 把 `reasoningEffort: input.effort ?? DSH_DEFAULT_EFFORT` 改回 `...(input.effort === undefined ? {} : { reasoningEffort: input.effort })`
⇒ 「没给 ⇒ 用缺省档 high」红；
② 把 `DSH_DEFAULT_EFFORT` 改成 `'off'` ⇒ 「缺省档必须是会思考的档」红。
各自改回后全绿，并核对 `Get-FileHash packages/server/agents/src/providers/dsh/index.ts` 与基线一致。

- [ ] **Step 6: 提交**

```bash
git add packages/server/agents/src/providers/dsh/index.ts packages/server/agents/src/providers/dsh/sdk.ts packages/server/agents/src/providers/dsh/index.test.ts
git commit -m "fix(agents/dsh): 未选思考档位时用缺省 high，不再静默关闭"
```

---

### Task 2: claude-code —— 新增 `off` 档（`thinking: { type: 'disabled' }`）

**Files:**
- Modify: `packages/server/agents/src/providers/claude-code/sdk.ts`（窄结构加 `thinking`）
- Modify: `packages/server/agents/src/providers/claude-code/index.ts:209-210`（取档 + 映射）与 `:627`（档位域）
- Test: `packages/server/agents/src/providers/claude-code/index.test.ts:581-600`、`packages/server/agents/src/registry.test.ts`

**Interfaces:**
- Consumes: `EFFORT_OFF`（`@aieval/contracts`，Task 4 创建）
- Produces: `CLAUDE_OFF_EFFORT`（本文件内的常量，值 = `EFFORT_OFF`）

- [ ] **Step 1: 写失败测试**

在 `claude-code/index.test.ts` 的「claude-code 的思考强度」组里追加（既有那条「没给 ⇒ 该键不存在」**保持不变** —— claude 的未选本来就是「不传」）：

```ts
  /**
   * 显式关闭（2026-10-06 口径）：契约与界面统一用档名 `off`，**这一家要翻成
   * `thinking: { type: 'disabled' }`**（SDK 的 `EffortLevel` 里没有 off 档，关闭是另一个字段）。
   */
  it('显式 off ⇒ thinking: disabled 且不传 effort', async () => {
    const recorder = createRecorder();
    setAgentRuntimeForTesting({ sdkModule: { [CLAUDE_PACKAGE_NAME]: createFakeClaudeSdk({ recorder, events: [] }) } });
    await claudeCodeProvider.run(createRunInput({ effort: 'off' }));

    expect(recorder.options?.thinking).toEqual({ type: 'disabled' });
    expect(Object.hasOwn(recorder.options ?? {}, 'effort')).toBe(false);
  });

  it('档位域首项是 off（下拉框第一项）', () => {
    expect(claudeCodeProvider.metadata.reasoningEfforts[0]).toBe(EFFORT_OFF);
  });
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `pnpm vitest run packages/server/agents/src/providers/claude-code/index.test.ts`
Expected: FAIL —— `thinking` 是 `undefined`、`effort` 是 `'off'`（现在被原样透传）、档位域首项是 `'low'`。

- [ ] **Step 3: 实现**

① `sdk.ts` 的 `ClaudeOptions`（`effort` 那一格之后）加：

```ts
  /**
   * 思考模式（`sdk.d.ts:1831-1842` 的 `Options.thinking` / `ThinkingConfig`）。
   * 本仓只用**关闭**这一档：`{ type: 'disabled' }`（SDK 的 `EffortLevel` 里没有 off，
   * 「不思考」必须走这个字段；`thinking` 的优先级高于已废弃的 `maxThinkingTokens`）。
   */
  thinking?: { type: 'disabled' };
```

② `index.ts` 的 `options` 构造处（`:209-210`）改为：

```ts
      // 思考强度（spec §6.4 / D13；2026-10-06）：未选 ⇒ 两个键都不加（沿用 SDk/模型默认，
      // 实测这一家的「不传」是会思考的）。显式 `off` ⇒ 走 `thinking` 的关闭档，**effort 不传**
      // （off 不在 SDK 的 `EffortLevel` 值域里，传下去会让 CLI 校验失败）。
      ...(input.effort === undefined || input.effort === CLAUDE_OFF_EFFORT ? {} : { effort: input.effort }),
      ...(input.effort === CLAUDE_OFF_EFFORT ? { thinking: { type: 'disabled' as const } } : {}),
```

文件内加常量（放在 `ALWAYS_DISALLOWED_TOOLS` 一类常量旁）：

```ts
/** 关闭思考的档名（契约与界面统一用 `off`；这一家翻成 `thinking: { type: 'disabled' }`） */
const CLAUDE_OFF_EFFORT = EFFORT_OFF;
```

③ `index.ts:627` 的档位域改为（**首项 `off`**）：

```ts
    // 档位域 = Agent SDK 的 `EffortLevel`（`Options.effort`）**加上**本仓统一的关闭档
    // `off`（它走 `thinking: { type: 'disabled' }`，不是 `effort` 的取值）；`max` 是
    // 「select models only」，但那由模型侧决定，智能体这一层能收的就是这些
    reasoningEfforts: [EFFORT_OFF, 'low', 'medium', 'high', 'xhigh', 'max'],
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm typecheck` → `pnpm vitest run packages/server/agents/src/providers/claude-code/index.test.ts packages/server/agents/src/registry.test.ts`
Expected: PASS（`registry.test.ts` 里若有 claude 档位域的期望值，按新值改并在注释里点名这次变更）

- [ ] **Step 5: 变异验证**

① 把 `thinking` 那一格删掉（`off` 只做到「不传 effort」）⇒ 第一条新用例红；
② 把档位域首项改回 `'low'` ⇒ 第二条红。

- [ ] **Step 6: 提交**

```bash
git add packages/server/agents/src/providers/claude-code/sdk.ts packages/server/agents/src/providers/claude-code/index.ts packages/server/agents/src/providers/claude-code/index.test.ts packages/server/agents/src/registry.test.ts
git commit -m "feat(agents/claude-code): 新增显式关闭档 off（thinking disabled）"
```

---

### Task 3: codex —— `off` 映射成 CLI 的 `none`

**Files:**
- Modify: `packages/server/agents/src/providers/codex/index.ts:101-102`（取档 + 映射）与 `:590`（档位域）
- Modify: `packages/server/agents/src/providers/codex/sdk.ts:123`（注释：SDK 类型面落后于 CLI）
- Test: `packages/server/agents/src/providers/codex/index.test.ts:482-499`、`packages/server/agents/src/registry.test.ts`

**Interfaces:**
- Consumes: `EFFORT_OFF`
- Produces: `codexEffortOf(effort: string): string`（导出的纯函数，供测试直接钉映射）

- [ ] **Step 1: 写失败测试**

在「codex 的思考强度」组里追加（既有那条「没给 ⇒ 该键不存在」**保持不变**）：

```ts
  /**
   * 显式关闭（2026-10-06，**本机实测**）：契约与界面统一用 `off`，而 CLI 的关闭档名是 **`none`**
   * （`--config model_reasoning_effort="none"` ⇒ 请求体 `"reasoning":{"effort":"none"}`，网关接受）。
   * `off` **不能**直传：实测该网关拒绝它（CLI 重连 5 次后失败）。见 spec §1.5。
   */
  it('显式 off ⇒ 翻成 none 传给 CLI（不是 off）', async () => {
    const recorder = createRecorder();
    setAgentRuntimeForTesting({ sdkModule: { [CODEX_PACKAGE_NAME]: createFakeCodexSdk({ recorder, events: [] }) } });
    await codexProvider.run(createRunInput({ effort: 'off' }));
    expect(recorder.threadOptions?.modelReasoningEffort).toBe('none');
  });

  it('只有关闭档走映射：其余档位逐字透传', () => {
    expect(codexEffortOf('off')).toBe('none');
    expect(codexEffortOf('high')).toBe('high');
    expect(codexEffortOf('xhigh')).toBe('xhigh');
  });

  it('档位域首项是 off（下拉框第一项）', () => {
    expect(codexProvider.metadata.reasoningEfforts[0]).toBe(EFFORT_OFF);
  });
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `pnpm vitest run packages/server/agents/src/providers/codex/index.test.ts`
Expected: FAIL —— `modelReasoningEffort` 是 `'off'`、`codexEffortOf` 未导出、档位域首项是 `'minimal'`。

- [ ] **Step 3: 实现**

`providers/codex/index.ts` 加：

```ts
/** 本仓统一的关闭档名（契约与界面都用它；这一家要翻成 CLI 的 `none`） */
const CODEX_OFF_EFFORT = EFFORT_OFF;

/**
 * 档位名 → CLI 的 `model_reasoning_effort` 取值。
 * **只有关闭档不同名**（2026-10-06 本机实测：CLI 的关闭档是 `none`，而 `off` 会被网关拒——
 * 请求体 `"reasoning":{"effort":"off"}` 让 CLI 重连 5 次后失败）。其余档位逐字透传。
 */
export function codexEffortOf(effort: string): string {
  return effort === CODEX_OFF_EFFORT ? 'none' : effort;
}
```

`startThread` 那一行（`:101-102`）改为：

```ts
      // 思考强度（spec §6.4 / D13；2026-10-06）：未选 ⇒ 一个键都不加（实测这一家的「不传」
      // **不是关闭**：请求体里没有 effort 字段，落网关默认）。显式关闭档翻成 CLI 的 `none`。
      ...(input.effort === undefined ? {} : { modelReasoningEffort: codexEffortOf(input.effort) }),
```

`:590` 的档位域改为（**首项 `off`**）：

```ts
    // 档位域 = SDK 的 `ModelReasoningEffort` 八档 **加上**本仓统一的关闭档 `off`
    // （它翻成 CLI 的 `none`——SDK 的类型面落后于 CLI，实测 CLI 接受 `none`，见 `codexEffortOf`）
    reasoningEfforts: [EFFORT_OFF, 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'persistent'],
```

`sdk.ts:123` 的注释补一句：

```ts
   * 思考强度（codex-sdk 的 `ModelReasoningEffort`：minimal/low/medium/high/xhigh/max/ultra/persistent）。
   * ⚠️ **类型面落后于 CLI**（2026-10-06 实测）：CLI 还接受 `none`（= 关闭思考），而类型面里没有它；
   * 本仓这一格是 `string`，所以能用——但**别**把「类型面没有」当成「这家做不到」。
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm typecheck` → `pnpm vitest run packages/server/agents/src/providers/codex/index.test.ts packages/server/agents/src/registry.test.ts`
Expected: PASS（`registry.test.ts` 里 codex 档位域的期望值按新值改，注释点名这次变更）

- [ ] **Step 5: 变异验证**

① `codexEffortOf` 改成恒等函数（`off` 直传）⇒ 第一条新用例红（**真机上这一条会让请求被网关拒**）；
② 把 `high` 也映射成 `none` ⇒ 第二条红。

- [ ] **Step 6: 提交**

```bash
git add packages/server/agents/src/providers/codex/index.ts packages/server/agents/src/providers/codex/sdk.ts packages/server/agents/src/providers/codex/index.test.ts packages/server/agents/src/registry.test.ts
git commit -m "feat(agents/codex): 显式关闭档 off 翻成 CLI 的 none（实测 off 被网关拒）"
```

---

### Task 4: contracts + api —— 统一的关闭档名，与「点得到关闭」的候选

**Files:**
- Modify: `packages/server/contracts/src/run.ts`（`EvalRowSchema.effort` 的注释：**未选 = 走该家适配器的缺省**）
- Modify: `packages/server/agents/src/types.ts`（`AgentProviderMetadata` 加可选 `defaultEffort`）
- Modify: `packages/server/evaluator/src/testing/fixtures.ts`（夹具元数据与真值同步：档位域补 `off`、dsh 补 `defaultEffort`，并修那句已失真的注释）
- Modify: `packages/server/agents/src/providers/dsh/index.ts`（metadata 声明 `defaultEffort`）
- Modify: `packages/server/agents/src/registry.test.ts`（守卫 14：声明的 `defaultEffort` 必须在自家档位域里且不是关闭档）
- Modify: `packages/server/api/src/runs.ts:424-436`（`intersectEfforts`）+ `:173-184`（校验与文案）
- Modify: `packages/server/evaluator/src/orchestrator.ts:1213-1214`（**只改注释**，`:1215` 那一行逐字不动）
- Test: `packages/server/api/src/runs.test.ts:687-760`

**Interfaces:**
- Consumes: `EFFORT_OFF = 'off'`（`@aieval/contracts`，Task 1 已创建并导出）、三家的 `reasoningEfforts`（Task 2/3 已把 `'off'` 加进首项）
- Produces: `intersectEfforts(model, agentEfforts): string[] | undefined` 的新语义（上游未声明 ⇒ 完整域；关闭档恒在候选里）
- Produces: `AgentProviderMetadata.defaultEffort?: string`（只有 dsh 声明；API 用它校验「未选时实际会用的档」）

- [ ] **Step 1: 写失败测试**

在 `runs.test.ts` 的「思考强度：候选池交集与创建校验」组里追加：

```ts
  /**
   * 候选构成（2026-10-06 口径变更）：上游**没声明** `supportedEfforts` ⇒ 给该家**完整档位域**
   * （本机两个 provider 都是这种形态，旧写法让界面连档位都没有）；声明过 ⇒ 交集 **∪ 关闭档**
   * （关闭档表达的是「我们这一侧关掉思考」，不受交集裁剪）。
   */
  it('上游未声明档位 ⇒ 候选 = 该家完整档位域；且关闭档恒在其中', () => {
    const provider = makeAnthropicProvider({ models: [{ id: 'unknown', source: 'manual' }] });
    seedConfig({ providers: [provider] });

    const cc = listModelOptions('claude-code').find((option) => option.modelId === 'unknown');
    expect(cc?.efforts).toEqual(getProvider('claude-code').metadata.reasoningEfforts);
    expect(cc?.efforts?.[0]).toBe(EFFORT_OFF);
  });

  it('上游声明过但不含关闭档 ⇒ 关闭档仍在候选里、且排第一', () => {
    const provider = makeAnthropicProvider({
      models: [{ id: 'three', source: 'manual', supportedEfforts: ['low', 'high', 'max'], recommendedEffort: 'high' }],
    });
    seedConfig({ providers: [provider] });

    const cc = listModelOptions('claude-code').find((option) => option.modelId === 'three');
    expect(cc?.efforts).toEqual([EFFORT_OFF, 'low', 'high', 'max']);
  });
```

> ⚠️ 同组里**既有**的三条断言要按新语义改（并在注释里点名这次变更）：
> `three ⇒ ['off','low','high','max']`、`narrow ⇒ ['off','low','medium','xhigh']`、
> `unknown ⇒` 该家完整档位域（不再是 `undefined`）；dsh 的 `narrow` 那条 ⇒ `['off','low']`。

还要加两条**未选也要校验**的用例（Task 1 的评审查出的缺口：`runs.ts:176` 原先只在显式给了 effort 时校验）：

```ts
  /**
   * **未选也要校验**（2026-10-06，Task 1 评审查出的缺口）：dsh 的「未选」不是「什么都没要求」，
   * 它会真的落到缺省档 `high` ⇒ 该档不在候选里时必须**建行就拒**，否则要跑到 dsh 的硬校验处
   * 才失败（`UNSUPPORTED_REASONING_EFFORT`，正是本计划要避免的「症状离真因很远」）。
   */
  it('未选档位也校验：dsh 的缺省档 high 不在候选里 ⇒ 建行即拒并点名', () => {
    // dsh 的档位域是 off/low/high/max；上游只声明 low ⇒ 候选 = [off, low]，而未选时 dsh 会用 high
    const provider = makeAnthropicProvider({
      models: [{ id: 'only-low', source: 'manual', supportedEfforts: ['low'] }],
    });
    seedConfig({ providers: [provider], cases: [makeCase()] });

    const create = (): EvalRun =>
      createRun({
        caseId: 'c-1',
        executionMode: 'serial',
        useAgentJudge: false,
        rows: [{ agentKind: 'dsh', providerId: provider.id, modelId: 'only-low' }],
      });
    expect(create).toThrow(ServiceError);
    expect(create).toThrow(/未选档位时/);
    expect(create).toThrow(/high/);
  });

  it('未选 + 该家没声明 defaultEffort（claude / codex）⇒ 不校验，快照里照样留空', () => {
    const provider = makeAnthropicProvider({
      models: [{ id: 'only-low', source: 'manual', supportedEfforts: ['low'] }],
    });
    seedConfig({ providers: [provider], cases: [makeCase()] });

    const run = createRun({
      caseId: 'c-1',
      executionMode: 'serial',
      useAgentJudge: false,
      rows: [{ agentKind: 'claude-code', providerId: provider.id, modelId: 'only-low' }],
    });
    expect(run.rows[0]?.effort).toBeUndefined();
  });
```

`registry.test.ts` 里再加一条元数据守卫（与既有的 `reasoningEfforts` 守卫同组）：

```ts
  it('声明了 defaultEffort 的家：该值必须在自己的档位域里，且不是关闭档', () => {
    for (const kind of AGENT_KINDS) {
      const { metadata } = getProvider(kind);
      if (metadata.defaultEffort === undefined) continue;
      expect(metadata.reasoningEfforts).toContain(metadata.defaultEffort);
      expect(metadata.defaultEffort).not.toBe(EFFORT_OFF);
    }
  });
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `pnpm vitest run packages/server/api/src/runs.test.ts`
Expected: FAIL —— 未声明档位时 `efforts` 是 `undefined`（界面只给「默认」）；声明过时候选里没有 `off`。

- [ ] **Step 3: 实现**

① `EvalRowSchema` 里 `effort` 的注释补一句（常量 `EFFORT_OFF` 与它的导出**已由 Task 1 创建**，本 Task 不再重复）：

```ts
   * **未选 = 走该家适配器的缺省**（dsh 是 `high`；claude / codex 是不传、由厂商推断），
   * **不是**「沿用厂商默认」也不是「关闭」；要关闭必须显式写 `EFFORT_OFF`（2026-10-06）。
```

② `agents/src/types.ts` 的 `AgentProviderMetadata` 加可选 `defaultEffort`：

```ts
  /**
   * 该家「**未选档位**时实际会用的档」（可选）。只有 dsh 声明它（`DSH_DEFAULT_EFFORT`）——
   * 它的「未选」会真的落到一个具体档上；claude / codex 不声明（未选由厂商推断，我们无从预知）。
   *
   * 为什么需要这一格：API 侧要拦「未选 + 该模型不支持那个缺省档」这种组合，否则要跑到
   * dsh 的硬校验处才失败（`UNSUPPORTED_REASONING_EFFORT`，症状离真因很远）。
   */
  defaultEffort?: string;
```

③ `providers/dsh/index.ts` 的 metadata 声明（放在 `reasoningEfforts: DSH_REASONING_EFFORTS,` 之后）：

```ts
    defaultEffort: DSH_DEFAULT_EFFORT,
```

④ `api/src/runs.ts` 的 `intersectEfforts` 改为：

```ts
/**
 * 候选档位（spec D10；2026-10-06 放宽）。
 *
 * 两个变化，各自都有靶子：
 *   · **上游没声明 ⇒ 给该家完整档位域**：本机两个 provider 都是 `source: fetched` 且不带
 *     `supportedEfforts` ⇒ 旧写法让候选为空、界面只给「默认」，用户**连档位都点不到**
 *     （更别说点「关闭」）；
 *   · **关闭档不受交集裁剪**：它表达的是「我们这一侧关掉思考」，不是模型声明的能力
 *     ⇒ 上游即使声明过、且不含它，也照样出现在候选里。
 *
 * 返回 `undefined` 仍表示「一个档位都没有」（该家档位域为空——正常不会发生）。
 */
function intersectEfforts(
  model: { supportedEfforts?: string[] },
  agentEfforts: readonly string[],
): string[] | undefined {
  const supported = model.supportedEfforts ?? [];
  const base = supported.length === 0
    ? [...agentEfforts]
    : supported.filter((effort) => agentEfforts.includes(effort));
  const off = agentEfforts.includes(EFFORT_OFF) && !base.includes(EFFORT_OFF) ? [EFFORT_OFF] : [];
  const allowed = [...off, ...base];
  return allowed.length === 0 ? undefined : allowed;
}
```

⑤ 同文件的校验（`:173-184`）改为（**未选也校验**，并在文案里点名关闭档）：

```ts
    // 强度校验（spec D10 的第二道闸）：表单只列候选，这里拦的是**绕过表单直接打接口**。
    // 2026-10-06：**未选也要校验**——dsh 的「未选」会真的落到缺省档（`metadata.defaultEffort`），
    // 那个档不在候选里时必须**建行就拒**，否则要跑到 dsh 的硬校验处才失败
    // （`UNSUPPORTED_REASONING_EFFORT`，症状离真因很远）。
    const allowed = intersectEfforts(model, metadata.reasoningEfforts) ?? [];
    const declared = row.effort ?? metadata.defaultEffort;
    if (declared !== undefined && !allowed.includes(declared)) {
      const implicit = row.effort === undefined ? `（未选档位时 ${displayName} 会用 ${declared}）` : '';
      throw new ServiceError(
        'INVALID_QUERY',
        `${displayName} 不能按 ${declared} 跑 ${row.modelId}${implicit}：该模型支持的档位是 ` +
          `${model.supportedEfforts?.join(' / ') ?? '（上游未声明）'}，${displayName} 能收的是 ` +
          `${metadata.reasoningEfforts.join(' / ')}，可选的是 ${allowed.join(' / ') || '（只有默认）'}` +
          `（其中 ${EFFORT_OFF} = 显式关闭思考）`,
        {
          context: {
            effort: declared,
            explicit: row.effort !== undefined,
            modelSupported: model.supportedEfforts,
            agentSupported: metadata.reasoningEfforts,
          },
        },
      );
    }
```

⑥ `evaluator/src/orchestrator.ts:1213-1214` 只改注释（**`:1215` 那一行逐字不动**）：

```ts
    // 强度按需带（spec §4.4 / D13）：行上没选就**不加这个键** —— 三家的实际语义各不相同
    // （2026-10-06 更正）：dsh 的适配器会给缺省档 `high`；claude / codex 不传、由厂商推断。
    // 传一个 undefined 会让某些 SDK 自己拼参数时出错，所以「没选」在这里就是**没有这个键**。
```

⑦ `evaluator/src/testing/fixtures.ts:562-579` 的 `makeFakeProvider` 与真值同步
（Task 2 的评审查出：claude 的档位域仍是五档、且 `:567` 那句「档位域照真值填」已失真）：

```ts
    // 档位域照**真值**填（spec D11；2026-10-06 起三家首项都是 `off`，claude 的关闭走
    // `thinking: { type: 'disabled' }`、codex 的走 `none`）。编排层不读它（交集在 api 层算），
    // 但填成一份万能表会让「假 provider 与真注册表逐格一致」这条前提在审计时看不出破绽。
    reasoningEfforts:
      kind === 'claude-code'
        ? ['off', 'low', 'medium', 'high', 'xhigh', 'max']
        : kind === 'codex'
          ? ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'persistent']
          : ['off', 'low', 'high', 'max'],
    // `defaultEffort` 同真值：只有 dsh 有（2026-10-06；API 侧要用它拦「未选 + 模型不支持缺省档」）
    ...(kind === 'dsh' ? { defaultEffort: 'high' } : {}),
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm typecheck` → `pnpm vitest run packages/server/api/src/runs.test.ts`
Expected: PASS。**既有那条「上游未声明 ⇒ 只有默认」的用例要按新语义改判据**，并在用例注释里点名这次变更。

- [ ] **Step 5: 变异验证**

① `intersectEfforts` 里去掉 `off` 的并入（改回纯交集）⇒ 两条新用例各红一条；
② 上游未声明时返回 `undefined`（改回旧写法）⇒ 第一条红；
③ 校验改回「只看 `row.effort !== undefined`」⇒「未选档位也校验」那条红；
④ 把 dsh 的 `defaultEffort` 临时改成 `'off'` ⇒ `registry.test.ts` 的元数据守卫红。

- [ ] **Step 6: 提交**

```bash
git add packages/server/contracts/src/run.ts packages/server/agents/src/types.ts packages/server/agents/src/providers/dsh/index.ts packages/server/agents/src/registry.test.ts packages/server/api/src/runs.ts packages/server/api/src/runs.test.ts packages/server/evaluator/src/orchestrator.ts
git commit -m "feat(api): 未选档位也校验缺省档；候选在上游未声明时给完整域并恒含关闭档"
```

---

### Task 5: ui / client —— 下拉框第一项 `off`，与「未指定」分开说

**Files:**
- Modify: `packages/client/ui/src/composite/run-create-panel.tsx:651-671`
- Modify: `packages/client/ui/src/composite/eval-row-card.tsx:168-174`
- Modify: `packages/client/client/src/build-environment.ts:243`
- Test: `packages/client/ui/src/composite/run-create-panel.test.tsx:836-915`、`packages/client/ui/src/composite/eval-row-card.test.tsx:669-680`

**Interfaces:**
- Consumes: `EFFORT_OFF`（`@aieval/contracts`）、服务端给的 `option.efforts`（Task 4 保证首项是 `off`）

- [ ] **Step 1: 写失败测试**

`run-create-panel.test.tsx` 的「思考强度」组里追加：

```ts
  /**
   * 关闭档与「未指定」是**两件事**（用户口径 2026-10-06）：
   *   · `off` = **显式关闭思考**，是第一项，文案要说明它关掉思考；
   *   · 「未指定」= Select 的**清空态**（`allowClear`），不是候选里的一项。
   */
  it('候选第一项是 off，文案说明它是关闭思考', () => {
    // 用既有的 `pickOption` 辅助：它按选项文案点选
    pickOption('思考强度', 'off（不思考）');
    expect(screen.getAllByLabelText('思考强度')[0]).toHaveTextContent('off');
  });
```

`eval-row-card.test.tsx` 的档位标签那一组里追加：

```ts
  it('显式 off 的行：标签看得懂（「不思考」）', () => {
    render(<EvalRowCard row={{ ...row, effort: 'off' }} {...handlers} />);
    expect(screen.getByText('off（不思考）')).toBeInTheDocument();
  });
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `pnpm vitest run packages/client/ui/src/composite/run-create-panel.test.tsx packages/client/ui/src/composite/eval-row-card.test.tsx`
Expected: FAIL —— 选项文案是裸 `'off'`、卡片标签也是裸 `'off'`。

- [ ] **Step 3: 实现**

① `run-create-panel.tsx` 的 Select：

```tsx
                            <Select
                              aria-label="思考强度"
                              allowClear
                              // 不预选推荐档（spec D14）：预选会让「我没选过」与「我选了推荐档」在快照里长得一样。
                              // 2026-10-06：placeholder 说明「未指定」到底会发生什么（dsh 走缺省 high）
                              placeholder="未指定（dsh 用 high）"
                              // 强度选项**只列服务端算好的候选**（spec D10；2026-10-06 起该候选必含关闭档
                              // 并保证它排第一）。`off` 的文案必须点明「关闭思考」，否则用户不知道它是什么意思。
                              options={(row.selected?.efforts ?? []).map((effort) => ({
                                value: effort,
                                label: effort === EFFORT_OFF
                                  ? `${effort}（不思考）`
                                  : effort === row.selected?.recommendedEffort ? `${effort}（推荐）` : effort,
                              }))}
                            />
```

② `eval-row-card.tsx` 的标签：

```tsx
          {/* 思考强度：**只在行上真的写了档位时显示**（`row.effort`，spec D12）——
              「没说」与「说了 high」必须分得开（前者跟随适配器缺省，后者是这一行锁死的档）；
              2026-10-06：显式关闭档要写成「不思考」，否则 `off` 是个读不懂的词 */}
          {row.effort === undefined ? null : (
            <Tooltip title={row.effort === EFFORT_OFF ? '这一行显式关闭了思考' : `这一行要求的思考强度：${row.effort}`}>
              <Tag color="purple">
                {row.effort === EFFORT_OFF ? `${row.effort}（不思考）` : row.effort}
              </Tag>
            </Tooltip>
          )}
```

③ `build-environment.ts:243`：

```ts
      [`模型：${row.modelId}`, `思考强度：${row.effort ?? '未指定（由该家适配器决定：dsh 走 high）'}`].join('\n'),
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm typecheck` → `pnpm vitest run packages/client/ui/src/composite/run-create-panel.test.tsx packages/client/ui/src/composite/eval-row-card.test.tsx`
Expected: PASS

- [ ] **Step 5: 变异验证**

① 把 `off` 的文案改回裸值 ⇒ 两条新用例红；
② 把 placeholder 改回 `'默认'` ⇒ 若有用例钉 placeholder 则红（没有就补一条）。

- [ ] **Step 6: 提交**

```bash
git add packages/client/ui/src/composite/run-create-panel.tsx packages/client/ui/src/composite/eval-row-card.tsx packages/client/client/src/build-environment.ts packages/client/ui/src/composite/run-create-panel.test.tsx packages/client/ui/src/composite/eval-row-card.test.tsx
git commit -m "feat(ui/client): 思考强度下拉第一项 off（不思考），未指定文案说明缺省"
```

---

### Task 6: 门禁、变异核对与真机冒烟

**Files:** 无新增/修改（只跑命令与核对；Step 2 的变异验证是**临时改 + 还原**，不留改动 —— 唯一例外是其中第 2 条要先补一条断言，那属于本次交付、要提交）

- [ ] **Step 1: 三条门禁**

Run: `pnpm typecheck` → `pnpm lint` → `pnpm test`

**判据（本仓是共享工作区，必须按此读）**：

- `typecheck`：判据是「**本次改动引入 0 错**」。工作区里有**别的会话未提交**的文件（`codex/appserver/*`、
  `claude-code/subagent-usage*` 等），它们的错要逐条列明并归因到别人，不算本次的红；
- `lint`：全绿（根命令一个进程覆盖 8 个包）；
- `test`：跑**全量**（`pnpm test`）。基线里已知的红只有 `claude-code/index.test.ts:189-191` 那条
  「本机 tmpdir 不含 8.3 短名」的环境断言（它用 `expect.soft(...).toContain('~')` 当跳过用 ⇒ 在无短名的机器上必然红），
  如实登记即可；**本次改动引入的红一条都不许留**。

- [ ] **Step 2: 逐条核对 spec §5 的守卫与 10 个变异体**

对着 spec `2026-10-06-effort-default-and-explicit-off-design.md` §5 逐行核对：**14 条守卫**都有对应用例、
**10 个变异体**都**真的见过失败**；把「变异体 → 红的用例 → 还原后哈希未变」记进实现报告。

⚠️ **前三轮任务评审登记了 3 处「变异记录缺口」，本步一并补做**（各自做完还原并核对哈希）：

1. `providers/dsh/index.test.ts:635-640`（「显式 `off` 原样交给 harness」那条守卫）没有变异记录：
   把 `dsh/index.ts` 的 `reasoningEffort: input.effort ?? DSH_DEFAULT_EFFORT` 临时改成
   `input.effort === 'off' ? undefined : (input.effort ?? DSH_DEFAULT_EFFORT)` ⇒ 该用例应红，还原后全绿
   （Task 1 评审 Minor 2）。
2. `providers/claude-code/index.test.ts:586-599` 不断言「非 `off` 时**没有** `thinking`」⇒ 把
   `claude-code/index.ts` 的 `thinking` 展开改成**无条件**加 `{ type: 'disabled' }` 时全部用例仍绿。
   **先补这条断言**（Task 2 评审 Minor 1）：
   `expect(Object.hasOwn(withEffort.options ?? {}, 'thinking')).toBe(false);`（加在该用例「给了 effort」那一段），
   再重跑该变异确认这次会红。**这一步改了测试文件 ⇒ 属于本次交付，改完要提交**。
3. `agents/src/registry.test.ts` 的 `defaultEffort` 守卫（守卫 14）只有 `!== EFFORT_OFF` 半支见过失败：
   把 dsh 的 `defaultEffort` 临时改成**域外值**（如 `'medium'`）⇒ 确认 `toContain` 那半支会红
   （Task 4 评审 Minor 4）。

- [ ] **Step 3: 真机冒烟（两条路径 × 两个档位）**

跑一次真实评测，同一 run 里放 **dsh 与 claude 各一行**（codex 可选）：

- **都不选档位** ⇒ dsh 与 claude **都在思考**（`messages.jsonl` 里出现 `{"type":"thinking"}` 块）；
  codex 那行的 rollout 里 `turn_context` 仍是 `reasoning_effort: null`；
- **都选 `off`** ⇒ 两家都确实没思考（没有 thinking 块）；
- 有 codex 行时，用本次探测留下的 `%TEMP%\codex-probe\proxy.mjs` 复验一次请求体：不选档位时
  **没有 `effort` 字段**、选 `off` 时是 **`"effort":"none"`**（把这两条请求体片段贴进 notes）。

把范围清单 / 操作路径 / 证据 / 未覆盖项写进 `docs/superpowers/notes/` 的冒烟记录。
