# 行计量含子智能体（subagentTokens）实施计划 — 2026-10-04

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让行卡片上的 `tok` / `缓存命中` / `轮次` 三格统计**候选派发的全部子智能体**（claude `Task` / dsh `subagent` / codex `spawn_agent`），三家口径一致，并在 Tooltip 里把「主会话 / 子智能体」拆开显示。

**Architecture:** 每家适配器在自己的投影里维护「主会话」与「子智能体」两条累加路径，向骨架交出**合计**（`tokens` / `turns`）与**分量**（新增一格 `subagentTokens`）。分量沿 `usage` 事件 → `AgentRunResult` → `EvalRow`（run.json）→ `RowLiveMetrics` → `MetricLine` 一路带到界面。骨架本身**不做加法**（它只搬运与去重），评分智能体的用量照旧被 `candidateEnded` 挡在这三格之外。

**Tech Stack:** TypeScript（strict + `noUncheckedIndexedAccess` + `verbatimModuleSyntax`）、zod 3（契约）、vitest 4（node / jsdom 双配置）、React 19 + antd 6（界面）。

**Spec:** [`docs/superpowers/specs/2026-10-01-agent-message-spec-design-v3.md`](../specs/2026-10-01-agent-message-spec-design-v3.md) §2.4 / §2.5 / §3.3 / §3.4 与 §4 的三家实施路径（口径与取数面）；行卡片的浮层形制见 [`2026-09-30-exec-log-drawer-redesign-design.md`](../specs/2026-09-30-exec-log-drawer-redesign-design.md) §6.12。**本线的过程 spec 已并入这两份文档并从库中删除**，本计划是它的施工图。

## Global Constraints

- **口径（spec §2.1，用户已裁定）**：范围 = 候选自己派发的全部子智能体（含嵌套）；**不含评分智能体**；`tok = input + output`；`缓存命中 = cached / (input + cached)`；`轮次 = 主会话 + 各子之和`；耗时与得分不动。
- **`null ≠ 0`**：采不到一律 `null`，绝不填 0；`{0,0,0}` 只能表示「确实没有子智能体」。
- **「全量或 null」（spec §2.2）**：有子智能体但不全读得到 ⇒ `subagentTokens = null`、`tokens` 退回主会话口径、并落一条**点名那个子智能体**的 WARN。**绝不把部分和当总数。**
- **不变量**：`subagentTokens !== null` ⇒ 逐格 `subagentTokens ≤ tokens`。
- **中文 JSDoc 注释**：先说什么、再说为什么；每个新增分支都要写清业务含义与取舍（本仓的注释密度就是规格的一部分）。
- **每条守卫都要做变异验证**：把缺陷人为造回去、确认该守卫**变红**，再还原并核对文件哈希未变。**没有见过失败的守卫不算守卫。**
- **提交**：逐个显式 `git add <路径>`，**禁止 `git add -A`**（本仓同时有别的会话在工作；`git status` 里不属于本计划的改动一律保持原样）。
- **命令顺序**：`pnpm typecheck` → `pnpm lint` → 修复全部错误 → 再进代码审查。内循环用 `pnpm vitest run <文件路径>`，全量留给门禁。
- **测试环境**：库包（`packages/**`）用 `vitest.node.ts` / `vitest.jsdom.ts`；`packages/client/ui` 与 `packages/client/client` 的组件测试走 jsdom；纯函数测试文件头标 `// @vitest-environment node`。

## File Structure

| 文件 | 职责 | 本计划里怎么变 |
|---|---|---|
| `packages/server/contracts/src/agent-event.ts` | `usage` 事件的形状 | 加可选可空的一格 `subagentTokens` |
| `packages/server/contracts/src/run.ts` | `EvalRow`（run.json 的行） | 加可选可空的一格 `subagentTokens` |
| `packages/server/agents/src/usage.ts`（新） | **一份**用量求和的实现 | 新建：`sumUsageTokens` |
| `packages/server/agents/src/types.ts` | 适配器对外契约 | `AgentRunResult.subagentTokens` |
| `packages/server/agents/src/emit.ts` | 草稿 → 事件 | `usage` 草稿带这一格 |
| `packages/server/agents/src/turn.ts` | 运行骨架（投影循环 / 收尾 / 结果组装） | 累计、发射、`TurnFinalize` 折进结果 |
| `packages/server/agents/src/providers/dsh/{index,events,message}.ts` | dsh 取数 | 本行子会话白名单 → 分量 |
| `packages/server/agents/src/providers/codex/{transcript,index}.ts` | codex 取数 | 子线程用量与轮次进合计 |
| `packages/server/agents/src/providers/claude-code/{subagent-usage,index}.ts`（前者新） | claude 取数 | 读 CLI 落盘的子智能体会话文件、按 `message.id` 去重求和 |
| `packages/server/evaluator/src/orchestrator.ts` | 编排落盘 | 事件回写快照、终态写入各带这一格 |
| `packages/client/client/src/row-live.ts` | 跑动期实时叠加层 | 折叠这一格 |
| `packages/client/ui/src/base/metric-line.tsx` | 三格 + Tooltip | 两行拆分 |
| `packages/client/ui/src/composite/eval-row-card.tsx` | 行卡片 | 透传这一格 |

**顺序**：契约（1）→ 求和实现（2）→ 骨架（3）→ 三家（4/5/6）→ 编排（7）→ 客户端与界面（8）→ 收口（9）。
每个任务自成一次可审查、可测试的交付。

---

### Task 1: 契约加一格 `subagentTokens`

**Files:**
- Modify: `packages/server/contracts/src/agent-event.ts`（`UsageTokensSchema` 之后的 `usage` 事件成员）
- Modify: `packages/server/contracts/src/run.ts:96-97`（`EvalRowSchema` 的 `tokens` / `turns` 旁边）
- Test: `packages/server/contracts/src/agent-event.test.ts`、`packages/server/contracts/src/index.test.ts`

**Interfaces:**
- Consumes: 无（最底层）
- Produces: `AgentEvent` 的 `usage` 成员多一格 `subagentTokens?: UsageTokens | null`；`EvalRow` 多一格 `subagentTokens?: UsageTokens | null`。**两处都必须是可选**（老 `run.json` / 老日志里没有这一格，必填会让 `listRuns()` 静默跳过老记录、让老日志成片解析失败——与 `timing` / `attempts` / `effort` 同一条处置）。

- [ ] **Step 1: 写失败的契约用例**

在 `packages/server/contracts/src/agent-event.test.ts` 末尾追加：

```ts
describe('usage 事件的 subagentTokens（2026-10-04）', () => {
  it('带这一格时原样解析；这一格是子智能体那一份，不是合计', () => {
    const parsed = AgentEventSchema.parse({
      seq: 7,
      at: '2026-10-04T00:00:00.000Z',
      type: 'usage',
      tokens: { input: 100, cached: 20, output: 30 },
      subagentTokens: { input: 40, cached: 10, output: 5 },
      timing: null,
      turns: 3,
    });
    expect(parsed.type === 'usage' && parsed.subagentTokens).toEqual({ input: 40, cached: 10, output: 5 });
  });

  it('缺这一格（老日志）照样解析得动——它是可选格', () => {
    const parsed = AgentEventSchema.parse({
      seq: 8,
      at: '2026-10-04T00:00:00.000Z',
      type: 'usage',
      tokens: null,
      turns: 1,
    });
    expect(parsed.type === 'usage' && parsed.subagentTokens).toBeUndefined();
  });

  it('显式的 null（有子智能体但没采到）与「没有这一格」是两件事，都必须能表达', () => {
    const parsed = AgentEventSchema.parse({
      seq: 9,
      at: '2026-10-04T00:00:00.000Z',
      type: 'usage',
      tokens: null,
      subagentTokens: null,
      timing: null,
      turns: 1,
    });
    expect(parsed.type === 'usage' && parsed.subagentTokens).toBeNull();
  });
});
```

在 `packages/server/contracts/src/index.test.ts` 追加（该文件已有 `EvalRunSchema` 的构造夹具，用同一条 `makeRun` / `makeRow` 辅助函数——先读文件顶部确认名字，沿用同一个）：

```ts
it('EvalRow 的 subagentTokens：可选、可空，老 run.json 不受影响', () => {
  const legacy = makeRow();
  expect('subagentTokens' in legacy).toBe(false); // 老记录：整格不存在
  const withSplit = makeRow({ subagentTokens: { input: 4, cached: 1, output: 2 } });
  expect(EvalRowSchema.parse(withSplit).subagentTokens).toEqual({ input: 4, cached: 1, output: 2 });
  const unknown = makeRow({ subagentTokens: null });
  expect(EvalRowSchema.parse(unknown).subagentTokens).toBeNull();
});
```

- [ ] **Step 2: 跑用例确认它红**

Run: `pnpm vitest run packages/server/contracts/src/agent-event.test.ts packages/server/contracts/src/index.test.ts`
Expected: FAIL —— `subagentTokens` 不在 schema 里，`parse` 会把它**剥掉**（zod 默认剥离未知键），故第一条断言拿到 `undefined`。

- [ ] **Step 3: 实现（契约两处）**

`agent-event.ts` 的 `usage` 成员里，在 `tokens` 之后加：

```ts
    /**
     * **子智能体那一份**用量（2026-10-04 新增）：`tokens` 已是「主会话 + 全部子智能体」的合计，
     * 这一格是其中的分量。界面用它把 Tooltip 拆成两行（主会话 / 子智能体）。
     *
     * 三档语义（**与 `tokens` 的 null 不是同一件事**）：
     *   · 整格缺席 = 这条事件来自还没有这一格的旧版本，或这一条没带这一格（消费方保持上一份）；
     *   · `null` = 有子智能体但**没采到**（含「有任何一个子智能体读失败」，见 spec §2.2）——
     *     此时 `tokens` 退回主会话口径；
     *   · `{0,0,0}` = **确实没有子智能体**。
     *
     * 为什么不并进 `tokens`：合计与分量是两件事实，消费方（卡片 Tooltip）两件都要；
     * 只给合计的话界面就只能显示一个说不清来源的数。**它不是第二份真值**：恒有
     * `subagentTokens ≤ tokens`（逐格），主会话那一行由相减得出。
     */
    subagentTokens: UsageTokensSchema.nullable().optional(),
```

`run.ts` 的 `EvalRowSchema` 里，紧跟 `turns` 之后加：

```ts
  /**
   * **子智能体那一份**用量（2026-10-04 新增）：`tokens` 是「主会话 + 全部子智能体」的合计，
   * 这一格是其中的分量（口径见 spec `2026-10-04-subagent-usage-in-row-metrics-design.md` §2.2）。
   * **可选**：老 `run.json` 里没有这一格，必填会让 `listRuns()` 静默跳过那一轮
   * （与 `attempts` / `effort` / `error.stage` 同一条理由）。
   */
  subagentTokens: z.object({ input: z.number(), cached: z.number(), output: z.number() }).nullable().optional(),
```

- [ ] **Step 4: 跑用例确认它绿**

Run: `pnpm vitest run packages/server/contracts/src/agent-event.test.ts packages/server/contracts/src/index.test.ts`
Expected: PASS

- [ ] **Step 5: 变异验证**

把 `agent-event.ts` 里那一格改成 `subagentTokens: UsageTokensSchema`（去掉 `.nullable().optional()`）。
Run: `pnpm vitest run packages/server/contracts/src/agent-event.test.ts`
Expected: 第二、三条用例变红（缺格 / `null` 解析失败）。**还原后**再跑一次确认绿。

- [ ] **Step 6: 提交**

```bash
git add packages/server/contracts/src/agent-event.ts packages/server/contracts/src/run.ts packages/server/contracts/src/agent-event.test.ts packages/server/contracts/src/index.test.ts
git commit -m "feat(contracts): usage 事件与 EvalRow 新增 subagentTokens（子智能体那一份用量）"
```

---

### Task 2: 一份用量求和实现 `sumUsageTokens`

**Files:**
- Create: `packages/server/agents/src/usage.ts`
- Test: `packages/server/agents/src/usage.test.ts`（新，文件头标 `// @vitest-environment node`）

**Interfaces:**
- Consumes: `UsageTokens`（`@aieval/contracts`）
- Produces: `sumUsageTokens(parts: readonly UsageTokens[]): UsageTokens` —— 三家求「子智能体那一份」都调它（抄三遍必然漂移）。

- [ ] **Step 1: 写失败的用例**

```ts
// @vitest-environment node
/**
 * 用量求和：**一份实现**，三家（dsh 的子会话 / codex 的子线程 / claude 的子智能体文件）都用它。
 * 两条口径必须钉住：可选格「一格都没采到才是 null」，`total` **不相加**。
 */
import { describe, expect, it } from 'vitest';
import { sumUsageTokens } from './usage';

describe('sumUsageTokens', () => {
  it('三格逐格相加', () => {
    expect(sumUsageTokens([
      { input: 10, cached: 2, output: 3 },
      { input: 1, cached: 20, output: 0 },
    ])).toEqual({ input: 11, cached: 22, output: 3, reasoningOutput: null, total: null });
  });

  it('空数组 ⇒ 全 0（「确实没有子智能体」的那一档，不是 null）', () => {
    expect(sumUsageTokens([])).toEqual({ input: 0, cached: 0, output: 0, reasoningOutput: null, total: null });
  });

  it('reasoningOutput：都采到才相加，一格都没采到就是 null（绝不填 0）', () => {
    expect(sumUsageTokens([
      { input: 1, cached: 0, output: 1, reasoningOutput: 5 },
      { input: 1, cached: 0, output: 1, reasoningOutput: 7 },
    ]).reasoningOutput).toBe(12);
    expect(sumUsageTokens([
      { input: 1, cached: 0, output: 1, reasoningOutput: 5 },
      { input: 1, cached: 0, output: 1 },
    ]).reasoningOutput).toBe(5);
    expect(sumUsageTokens([{ input: 1, cached: 0, output: 1 }]).reasoningOutput).toBeNull();
  });

  it('total（厂商自报总量）**不相加**：它是单个会话的累计快照，加出来是我们的算术不是厂商的数', () => {
    expect(sumUsageTokens([
      { input: 1, cached: 0, output: 1, total: 100 },
      { input: 1, cached: 0, output: 1, total: 200 },
    ]).total).toBeNull();
  });
});
```

- [ ] **Step 2: 跑用例确认它红**

Run: `pnpm vitest run packages/server/agents/src/usage.test.ts`
Expected: FAIL —— `Failed to resolve import "./usage"`。

- [ ] **Step 3: 实现**

```ts
/**
 * 用量求和：**子智能体那一份**的唯一实现（2026-10-04）。
 *
 * 为什么单独一个文件：三家都要把「若干个会话 / 线程 / 文件的用量」加起来
 * （dsh 按子会话、codex 按子线程、claude 按子智能体文件），三处各写一遍必然漂移，
 * 而漂移的表现是「同样的子智能体在三家算出的 tok 不一样」——最难查的一类。
 *
 * 两条口径：
 *   1. **可选格（`reasoningOutput`）一格都没采到才是 `null`**：与 `UsageTokens` 的
 *      「缺项即 null」同源，绝不填 0（`reasoningOutput: 0` 会让人得出「这家不思考」）；
 *   2. **`total` 不相加**：它是厂商自报的**单个会话/线程的累计快照**，把两个会话的快照加起来
 *      得到的是我们的算术，而契约里那一格的语义是「厂商原文」（见 `UsageTokensSchema` 注释）
 *      ⇒ 子智能体这一份恒为 `null`。
 */
import type { UsageTokens } from '@aieval/contracts';

export function sumUsageTokens(parts: readonly UsageTokens[]): UsageTokens {
  let input = 0;
  let cached = 0;
  let output = 0;
  let reasoningOutput = 0;
  let sawReasoning = false;
  for (const part of parts) {
    input += part.input;
    cached += part.cached;
    output += part.output;
    if (part.reasoningOutput != null) {
      reasoningOutput += part.reasoningOutput;
      sawReasoning = true;
    }
  }
  return { input, cached, output, reasoningOutput: sawReasoning ? reasoningOutput : null, total: null };
}
```

- [ ] **Step 4: 跑用例确认它绿**

Run: `pnpm vitest run packages/server/agents/src/usage.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/server/agents/src/usage.ts packages/server/agents/src/usage.test.ts
git commit -m "feat(agents): 新增 sumUsageTokens——子智能体那一份用量的唯一求和实现"
```

---

### Task 3: 骨架贯通（投影 → 事件 → 结果 → 收尾）

**Files:**
- Modify: `packages/server/agents/src/types.ts:151`（`AgentRunResult.tokens` 之后）
- Modify: `packages/server/agents/src/emit.ts:32`（`usage` 草稿）与 `:109-112`（`withMeta`）
- Modify: `packages/server/agents/src/turn.ts`（`TurnProjection`、`TurnFinalize`、投影循环、收尾折入、`sameUsage`、`assembleResult`，以及**三处早退的 `AgentRunResult` 字面量**：`:326-338` 的「启动前已中止」与 `assembleResult` 的两条分支——类型是必填格，这三处都要补 `subagentTokens: null`，`tsc` 会点名）
- Test: `packages/server/agents/src/turn.test.ts`、`packages/server/agents/src/emit.test.ts`（`emit.test.ts:30` 那条用例构造了一个 `usage` 草稿，草稿层这一格是必填 ⇒ 要补 `subagentTokens: null`）

**Interfaces:**
- Consumes: Task 1 的契约、Task 2 的 `sumUsageTokens`（本任务暂不用它）
- Produces:
  - `TurnProjection.subagentTokens?: UsageTokens | null`（缺省 = 本条不带这一格；`null` = 明确没采到）
  - `TurnFinalize.tokens?: UsageTokens | null`、`TurnFinalize.subagentTokens?: UsageTokens | null`、`TurnFinalize.turns?: number | null`
  - `AgentRunResult.subagentTokens: UsageTokens | null`（**必填**，与 `tokens` 同一条「采不到就是 null」）
  - `usage` 事件草稿的 `subagentTokens: UsageTokens | null`（草稿层必填、契约层可选——与 `timing` 同一条处置）

**为什么 `TurnFinalize` 必须带计量**（这是本任务最容易被做错的一格）：codex 的子线程用量**只在收尾读盘时才知道**，而编排层第 6 步会用 `result.tokens` 覆盖快照（`orchestrator.ts:1267` 的 `measured`）。收尾只发一条 `usage` 事件的话，那个数会在几毫秒后被 `result.tokens`（不含子线程）盖掉——界面在终态那一下「掉下去」。

- [ ] **Step 1: 写失败的用例**

在 `packages/server/agents/src/turn.test.ts` 里追加（该文件已有把 `start` 钩子做成假适配器的夹具与 `runTurn` 直调路径，沿用同一个）：

```ts
describe('subagentTokens（2026-10-04）：骨架只搬运，不做加法', () => {
  it('投影带这一格 ⇒ 下一条 usage 事件与结果都带上原样值（骨架不加到 tokens 上）', async () => {
    const events: AgentEvent[] = [];
    const result = await runTurn(fakeInput(events), {
      kind: 'codex',
      start: async () => ({
        stream: (async function* () {
          yield { kind: 'one' };
        })(),
        interrupt: () => {},
        dispose: async () => {},
        project: () => ({
          drafts: [],
          tokens: { input: 100, cached: 20, output: 30 },
          subagentTokens: { input: 40, cached: 10, output: 5 },
          turns: 2,
          failure: null,
        }),
      }),
    });
    const usage = events.find((event) => event.type === 'usage');
    expect(usage?.type === 'usage' ? usage.subagentTokens : null).toEqual({ input: 40, cached: 10, output: 5 });
    expect(usage?.type === 'usage' ? usage.tokens : null).toEqual({ input: 100, cached: 20, output: 30 });
    expect(result.subagentTokens).toEqual({ input: 40, cached: 10, output: 5 });
    expect(result.tokens).toEqual({ input: 100, cached: 20, output: 30 });
  });

  it('收尾（finalize）交回的计量折进结果——这是 codex 子线程用量唯一的落地路径', async () => {
    const result = await runTurn(fakeInput([]), {
      kind: 'codex',
      start: async () => ({
        stream: (async function* () {
          yield { kind: 'one' };
        })(),
        interrupt: () => {},
        dispose: async () => {},
        project: () => ({ drafts: [], tokens: { input: 10, cached: 0, output: 1 }, turns: 1, failure: null }),
        finalize: () => ({
          drafts: [],
          tokens: { input: 15, cached: 0, output: 4 },
          subagentTokens: { input: 5, cached: 0, output: 3 },
          turns: 3,
        }),
      }),
    });
    expect(result.tokens).toEqual({ input: 15, cached: 0, output: 4 });
    expect(result.subagentTokens).toEqual({ input: 5, cached: 0, output: 3 });
    expect(result.turns).toBe(3);
  });

  it('收尾交回 null：tokens/turns 保持不变，但 subagentTokens 被清成 null（两者的 null 语义刻意不同）', async () => {
    const result = await runTurn(fakeInput([]), {
      kind: 'codex',
      start: async () => ({
        stream: (async function* () {
          yield { kind: 'one' };
        })(),
        interrupt: () => {},
        dispose: async () => {},
        project: () => ({
          drafts: [],
          tokens: { input: 10, cached: 0, output: 1 },
          subagentTokens: { input: 2, cached: 0, output: 1 },
          turns: 1,
          failure: null,
        }),
        finalize: () => ({ drafts: [], tokens: null, subagentTokens: null, turns: null }),
      }),
    });
    // `tokens` 的 null = 「本条不带」⇒ 保持
    expect(result.tokens).toEqual({ input: 10, cached: 0, output: 1 });
    // `subagentTokens` 的 null = 「明确没采到」⇒ 清空（读失败时必须能清，否则旧分量会大于退回主会话口径的合计）
    expect(result.subagentTokens).toBeNull();
  });

  it('收尾**不带**这一格（缺省）时保持原值——与显式 null 是两件事', async () => {
    const result = await runTurn(fakeInput([]), {
      kind: 'codex',
      start: async () => ({
        stream: (async function* () {
          yield { kind: 'one' };
        })(),
        interrupt: () => {},
        dispose: async () => {},
        project: () => ({
          drafts: [],
          tokens: { input: 10, cached: 0, output: 1 },
          subagentTokens: { input: 2, cached: 0, output: 1 },
          turns: 1,
          failure: null,
        }),
        finalize: () => ({ drafts: [] }),
      }),
    });
    expect(result.subagentTokens).toEqual({ input: 2, cached: 0, output: 1 });
  });

  it('只变了子智能体那一份也要发事件（去重判据必须包含它）', async () => {
    const events: AgentEvent[] = [];
    const tokens = { input: 100, cached: 0, output: 10 };
    await runTurn(fakeInput(events), {
      kind: 'codex',
      start: async () => ({
        stream: (async function* () {
          yield { kind: 'a' };
          yield { kind: 'b' };
        })(),
        interrupt: () => {},
        dispose: async () => {},
        project: (raw) => ({
          drafts: [],
          tokens,
          subagentTokens: (raw as { kind: string }).kind === 'a' ? { input: 0, cached: 0, output: 0 } : { input: 7, cached: 0, output: 1 },
          turns: 1,
          failure: null,
        }),
      }),
    });
    const usages = events.filter((event) => event.type === 'usage');
    expect(usages).toHaveLength(2);
    expect(usages[1]?.type === 'usage' ? usages[1].subagentTokens : null).toEqual({ input: 7, cached: 0, output: 1 });
  });
});
```

- [ ] **Step 2: 跑用例确认它红**

Run: `pnpm vitest run packages/server/agents/src/turn.test.ts -t subagentTokens`
Expected: FAIL —— 类型上是 `subagentTokens` 不存在（tsc 报错）、运行时是 `undefined`。

- [ ] **Step 3: 实现**

`types.ts` 的 `AgentRunResult`，紧跟 `tokens` 之后：

```ts
  /**
   * **子智能体那一份**用量（2026-10-04）：`tokens` 是「主会话 + 全部子智能体」的合计，
   * 这一格是其中的分量（口径见 spec `2026-10-04-subagent-usage-in-row-metrics-design.md`）。
   * `null` = 这一行没有子智能体、或**没采到**（含「有任何一个子智能体读失败」⇒ 合计退回主会话口径）。
   * 为什么与 `tokens` 一样必填：它决定界面画不画拆分那一行，缺格与 `null` 在消费侧是同一件事，
   * 少一种形态就少一处漂移（与 `usage` 事件的 `timing` 同一条处置）。
   */
  subagentTokens: { input: number; cached: number; output: number } | null;
```

`emit.ts` 的草稿联合里，`usage` 那一支改成：

```ts
  | {
    type: 'usage';
    tokens: UsageTokens | null;
    /**
     * **子智能体那一份**（2026-10-04）：与 `timing` 一样**这一层必填**（没有时写 `null`），
     * 契约那边是可选可空——读侧只有「有」「明确的 null」「老日志缺格」三态，
     * 而草稿层不必区分后两者（见 `withMeta`）。
     */
    subagentTokens: UsageTokens | null;
    timing: UsageTiming | null;
    turns: number;
  }
```

`withMeta` 的 `usage` 分支：

```ts
    case 'usage':
      return {
        seq,
        at,
        type: 'usage',
        tokens: draft.tokens,
        // 这一格**恒带**（没有子智能体时是 null）：与 `timing` 同一条处置，
        // 读侧因此只有「有值」与「未采集」两态，不必区分「键不存在」与「键是 null」
        subagentTokens: draft.subagentTokens,
        timing: draft.timing,
        turns: draft.turns,
      };
```

`turn.ts` 四处：

```ts
// ① TurnProjection（紧跟 tokens 之后）
  /**
   * **子智能体那一份**用量（2026-10-04）。三档：
   *   · 缺省（undefined）= 本条不带这一格（保持骨架里已有的那一份）；
   *   · `{…}` = 「主会话之外、到目前为止」的读数（仍在跑的子智能体算「到目前为止」）；
   *   · `null` = **明确没采到**（有子智能体但读失败）⇒ 骨架把它记成 null，界面据此退回单行 Tooltip。
   * 与 `tokens` 的 null 语义不同：`tokens: null` 是「本条没带」，这里是「本条说了：没有这个数」。
   */
  subagentTokens?: UsageTokens | null;

// ② TurnFinalize
export interface TurnFinalize {
  drafts: AgentEventDraft[];
  messages?: MessageDraft[];
  subagents?: SubagentRecord[];
  /**
   * 收尾交回的**计量**（2026-10-04 新增）。为什么必须能交回结果值：
   * codex 的子线程用量**只在收尾读盘时才知道**，而编排层第 6 步会用 `result.tokens` 覆盖快照
   * ⇒ 只发一条 `usage` 事件的话，那个数会在几毫秒后被不含子线程的 `result.tokens` 盖掉
   * （界面在终态那一下「掉下去」）。
   * `tokens` / `turns` 的 `null` 与缺省都表示「本条不带这一格」（**不是清空**）——
   * 与 `TurnProjection.tokens` 的处置逐字相同。
   */
  tokens?: UsageTokens | null;
  /**
   * **子智能体那一份**。⚠️ **这一格的 `null` 语义与 `tokens` 刻意不同**（预检裁定，见账本 R2）：
   * `null` = **明确没采到** ⇒ 覆盖成 `null`（否则读失败时旧的偏大分量会留在那儿，
   * 而合计已退回主会话口径 ⇒ 破坏 `subagentTokens ≤ tokens` 这条不变量）；
   * 只有**缺省（undefined）**才是「本条不带这一格、保持原值」。
   * 为什么不让两者同语义：`tokens` 的 null = 「这一条没带计量」（在 dsh 上轮次单独到达是常态），
   * 而子智能体那一份只有「读到了」与「读失败了」两种，没有「这一条不谈它」这种中间态。
   */
  subagentTokens?: UsageTokens | null;
  turns?: number | null;
}

// ③ runTurn 里新增一个累计变量（与 tokens / turns 并列声明）
  let subagentTokens: UsageTokens | null = null;

// ④ 投影循环：紧跟 `if (projection.turns !== null) turns = projection.turns;` 之后
      /**
       * 子智能体那一份：**照原样搬运，骨架不做加法**——合计由各家自己算好（spec §2.3），
       * 骨架加一次就成了双计。缺省（undefined）= 本条不带这一格（保持原值）；
       * **显式 `null` = 明确没采到 ⇒ 覆盖成 null**（见 `TurnFinalize.subagentTokens` 的注释）。
       */
      if (projection.subagentTokens !== undefined) subagentTokens = projection.subagentTokens;

// ⑤ 发射那一条（去重判据与草稿都要带它）
      if (
        projection.turns !== null
        && !sameUsage(emittedUsage, liveTokens, subagentTokens, liveTiming, projection.turns)
      ) {
        emit({ type: 'usage', tokens: liveTokens, subagentTokens, timing: liveTiming, turns: projection.turns });
        emittedUsage = { tokens: liveTokens, subagentTokens, turns: projection.turns, timing: liveTiming };
      }

// ⑥ 收尾折入（在 `for (const record of finalized.subagents ?? []) emitSubagent(record);` 之后）
        // 收尾交回的计量折进结果（见 `TurnFinalize` 的注释）：null 与缺省都表示「本条不带」
        if (finalized.tokens != null) tokens = finalized.tokens;
        if (finalized.subagentTokens !== undefined) subagentTokens = finalized.subagentTokens;
        if (finalized.turns != null) turns = finalized.turns;

// ⑦ assembleResult 的入参与返回
  // 入参多一格 subagentTokens: AgentRunResult['subagentTokens'];
  // base 多一格：const base = { tokens: input.tokens, turns: input.turns, subagentTokens: input.subagentTokens, durationMs, finalText };
```

`sameUsage` 改成五参并比较新格：

```ts
function sameUsage(
  previous: {
    tokens: AgentRunResult['tokens'];
    subagentTokens: AgentRunResult['subagentTokens'];
    turns: number;
    timing: UsageTiming | null;
  } | null,
  tokens: AgentRunResult['tokens'],
  subagentTokens: AgentRunResult['subagentTokens'],
  timing: UsageTiming | null,
  turns: number,
): boolean {
  if (previous === null) return false;
  if (previous.turns !== turns) return false;
  if (!sameTiming(previous.timing, timing)) return false;
  // 子智能体那一份也在判据里：它变了界面就要重画 Tooltip（否则那两行永远停在第一次的读数上）
  if (!sameTrio(previous.subagentTokens, subagentTokens)) return false;
  return sameTrio(previous.tokens, tokens);
}

/** 三元组逐字段相同；`null` 只与 `null` 相同（「没采到」→「采到 0」是一次真实变化） */
function sameTrio(
  left: AgentRunResult['tokens'],
  right: AgentRunResult['tokens'],
): boolean {
  if (left === null || right === null) return left === right;
  return left.input === right.input && left.cached === right.cached && left.output === right.output;
}
```

同时把 `emittedUsage` 的声明类型（约 `turn.ts:369`）与 `assembleResult` 的调用点补上新格。

- [ ] **Step 4: 跑用例确认它绿**

Run: `pnpm vitest run packages/server/agents/src/turn.test.ts`
Expected: PASS（含既有的全部骨架用例——它们必须一条都不红）

- [ ] **Step 5: 变异验证（两条）**

1. 把 `sameUsage` 里新加的那一行 `if (!sameTrio(previous.subagentTokens, subagentTokens)) return false;` 删掉
   ⇒ `只变了子智能体那一份也要发事件` 必须变红。
2. 把收尾折入改成只在 `finalized.tokens !== undefined` 时赋值（即漏掉 `subagentTokens`）
   ⇒ `收尾（finalize）交回的计量折进结果` 必须变红。

每次还原后重跑确认绿。

- [ ] **Step 6: 提交**

```bash
git add packages/server/agents/src/types.ts packages/server/agents/src/emit.ts packages/server/agents/src/turn.ts packages/server/agents/src/turn.test.ts packages/server/agents/src/emit.test.ts
git commit -m "feat(agents): 骨架贯通 subagentTokens（投影 → usage 事件 → 结果 → 收尾）"
```

---

### Task 4: dsh —— 交出子会话那一份

**Files:**
- Modify: `packages/server/agents/src/providers/dsh/message.ts`（`noteDshSessionUsage` 附近）
- Modify: `packages/server/agents/src/providers/dsh/events.ts:154-232`（`assistant/message` 分支）
- Modify: `packages/server/agents/src/providers/dsh/index.ts:218-226`（`childSessions` 提到 run 作用域）与 `:471`（project 接线）
- Test: `packages/server/agents/src/providers/dsh/index.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `sumUsageTokens`、Task 3 的 `TurnProjection.subagentTokens`
- Produces:
  - `DshRunState = { childSessions: Set<string>; finishedSessions: Set<string> }`（`index.ts` 内，run 作用域）
  - `dshSubagentUsage(input: { childSessions: ReadonlySet<string>; finishedSessions: ReadonlySet<string> }): UsageTokens | null`（`message.ts` 导出）
  - `projectDshNotification(raw, state, context, runState?)`——第 4 参可选，缺省即空集合（既有直调用例不必改）

**今天的事实**（spec §1）：dsh 的 `tokens` 与 `turns` **已经**含子会话（投影不按会话分叉）。本任务**不改**这两格的行为，只补出「子那一份」，并把既成事实用守卫钉住。

- [ ] **Step 1: 写失败的用例**

在 `packages/server/agents/src/providers/dsh/index.test.ts` 追加（该文件已有 `sessionEvent` / `USAGE_EVENT` / `STEP_START_EVENT` / `usageEvents` 与假 harness 夹具）。用例要用的 `runDshWith` 也在这个文件里，**照既有 `dshProvider` 组的写法**把它加成一个小夹具（新增代码，不是既有的）：

```ts
/** 把一串通知喂给 dshProvider，返回收集到的事件（既有 `dshProvider` 组就是这么接线的，这里只包一层） */
async function runDshWith(notifications: readonly unknown[]): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  const fake = createFakeDshRuntime({ notifications }); // 该文件既有的假运行时夹具；先读它确认名字与形状
  await dshProvider.run(createRunInput({ onEvent: (event) => events.push(event) }));
  void fake;
  return events;
}
```

（若该文件里的假运行时工厂叫别的名字，用它——**先读文件顶部**。关键是：通知按给的顺序投递、`subagent.started` 的 `subagentId` 就是子会话 id。）

```ts
describe('子智能体那一份用量（spec 2026-10-04 §2.3）', () => {
  it('子会话的 assistant/message 用量进合计，并单独交回子那一份', async () => {
    const events = await runDshWith([
      STEP_START_EVENT,
      USAGE_EVENT, // 主会话：input 10 / cached 0 / output 2
      sessionEvent('subagent.started', { subagentId: 'child-1', parentSessionId: 'session-fake' }),
      sessionEvent(DSH_ASSISTANT_MESSAGE_TYPE, { usage: { inputTokens: 4, cacheReadTokens: 1, outputTokens: 3 } }, 'child-1'),
    ]);
    const last = usageEvents(events).at(-1);
    expect(last?.tokens).toEqual({ input: 14, cached: 1, output: 5 });
    expect(last?.subagentTokens).toEqual({ input: 4, cached: 1, output: 3 });
  });

  it('没有子会话 ⇒ 子那一份是 {0,0,0}（「确实没有」，不是 null）', async () => {
    const events = await runDshWith([STEP_START_EVENT, USAGE_EVENT]);
    expect(usageEvents(events).at(-1)?.subagentTokens).toEqual({ input: 0, cached: 0, output: 0 });
  });

  it('别的行的会话（不在本行子会话白名单里）绝不算进来', async () => {
    const events = await runDshWith([
      STEP_START_EVENT,
      USAGE_EVENT,
      sessionEvent(DSH_ASSISTANT_MESSAGE_TYPE, { usage: { inputTokens: 999, cacheReadTokens: 0, outputTokens: 999 } }, 'other-row-session'),
    ]);
    // 合计仍会含它（dsh 的既成口径：投影不按会话分叉），但**子那一份必须只算白名单**
    expect(usageEvents(events).at(-1)?.subagentTokens).toEqual({ input: 0, cached: 0, output: 0 });
  });

  it('子会话已收场却一条用量都没有 ⇒ 子那一份 null（宁可不出数），合计仍含主会话', async () => {
    const events = await runDshWith([
      STEP_START_EVENT,
      USAGE_EVENT,
      sessionEvent('subagent.started', { subagentId: 'child-2', parentSessionId: 'session-fake' }),
      sessionEvent('subagent.finished', { subagentId: 'child-2', status: 'ok', stopReason: 'completed' }),
    ]);
    const last = usageEvents(events).at(-1);
    expect(last?.subagentTokens).toBeNull();
    expect(last?.tokens).toEqual({ input: 10, cached: 0, output: 2 });
  });

  it('轮次继续含子会话的 step（既成事实的守卫）', async () => {
    const events = await runDshWith([
      STEP_START_EVENT,
      sessionEvent('subagent.started', { subagentId: 'child-1', parentSessionId: 'session-fake' }),
      sessionEvent('step/start', { turn: 1, step: 1 }, 'child-1'),
    ]);
    expect(usageEvents(events).at(-1)?.turns).toBe(2);
  });
});
```

（`runDshWith(notifications)` 就是上面那个小夹具：把通知喂给 `dshProvider.run` 并收集 `onEvent`。）

- [ ] **Step 2: 跑用例确认它红**

Run: `pnpm vitest run packages/server/agents/src/providers/dsh/index.test.ts -t 子智能体那一份`
Expected: FAIL —— `subagentTokens` 是 `undefined`。

- [ ] **Step 3: 实现**

`message.ts` 追加：

```ts
/**
 * 本行的**子智能体那一份**用量（spec 2026-10-04 §2.3）。
 *
 * 为什么按白名单（`childSessions`）求和、而不是「主会话之外的全部」：`sessionUsage` 是**模块级**的
 * （同一个 Node 进程里并行跑着好几行），主会话之外还有**别的行**的会话 ⇒ 只有白名单能把这一行圈出来。
 *
 * 三档（spec §2.2 的「全量或 null」）：
 *   · 没有子会话 ⇒ `{0,0,0}`（确实没有，不是 null）；
 *   · 子会话**已收场**却一条用量都没有 ⇒ `null`（事实缺失，宁可不出数）；
 *   · 仍在跑的子会话 ⇒ 按「到目前为止」计入（还没有用量就先当 0，它还会报）。
 */
export function dshSubagentUsage(input: {
  childSessions: ReadonlySet<string>;
  finishedSessions: ReadonlySet<string>;
}): UsageTokens | null {
  if (input.childSessions.size === 0) return sumUsageTokens([]);
  const parts: UsageTokens[] = [];
  for (const sessionId of input.childSessions) {
    const usage = sessionUsage.get(sessionId);
    if (usage === undefined) {
      if (input.finishedSessions.has(sessionId)) return null;
      continue;
    }
    parts.push(usage);
  }
  return sumUsageTokens(parts);
}
```

`index.ts`：把 `childSessions` 提到 `startDsh` 的 run 作用域，并加一个已收场集合：

```ts
  /**
   * 本行的**子会话白名单**与**已收场集合**（2026-10-04）：两处共用——通知流的放行判据要在
   * 收到 `subagent.started` 时登记，投影要按同一份白名单算「子智能体那一份」用量。
   * 提到 run 作用域之前它是一个藏在 `notificationStream` 里的局部变量，投影看不到它。
   */
  const childSessions = new Set<string>();
  const finishedSessions = new Set<string>();
```

`notificationStream(harness, sessionId, prompt, runState)` 里把 `const childSessions = new Set<string>()` 换成 `runState.childSessions`，并在 `noteChildSession` 之外登记收场：

```ts
      const subscription = harness.client.subscribe((notification: DshNotification) => {
        noteChildSession(notification, sessionId, runState.childSessions);
        noteFinishedChildSession(notification, runState.finishedSessions);
        return acceptsRunNotification(notification, sessionId, runState.childSessions);
      });
```

```ts
/** `subagent.finished` 的身份登记：投影据此区分「已经收场却没报用量」（事实缺失）与「还在跑」 */
function noteFinishedChildSession(notification: DshNotification, finished: Set<string>): void {
  if (notification.method !== DSH_SUBAGENT_FINISHED_METHOD) return;
  const identity = readString(asRecord(notification.params), 'subagentId');
  if (identity !== null && identity !== '') finished.add(identity);
}
```

project 接线：

```ts
    project: (raw, state) =>
      projectDshNotification(raw, state, { kind: 'dsh', baseUrl: input.route.baseUrl }, {
        childSessions,
        finishedSessions,
      }),
```

`events.ts`：`projectDshNotification` 加第 4 参（缺省空集合），并在 `assistant/message` 分支的返回里带上分量：

```ts
export function projectDshNotification(
  raw: unknown,
  state: TurnState,
  context: FailureContext,
  /**
   * 本行的子会话白名单与已收场集合（可选，缺省 = 空）。
   * 为什么走参数而不是塞进 `TurnState`：那是**骨架**的状态形状（三家共用），
   * 而这两个集合是 dsh 自己的取数面（spec 2026-10-04 §2.3）。
   */
  runState: { childSessions: ReadonlySet<string>; finishedSessions: ReadonlySet<string> } = {
    childSessions: new Set(),
    finishedSessions: new Set(),
  },
): TurnProjection {
```

在 `assistant/message` 分支的返回对象里（`tokens: cumulativeTokens(state)` 那一处）加：

```ts
      // 子智能体那一份：**主会话之外**的读数（合计仍由 cumulativeTokens 给，两边同源同刻）
      subagentTokens: dshSubagentUsage(runState),
```

- [ ] **Step 4: 跑用例确认它绿**

Run: `pnpm vitest run packages/server/agents/src/providers/dsh`
Expected: PASS（既有 dsh 用例一条不红）

- [ ] **Step 5: 变异验证（两条）**

1. `dshSubagentUsage` 里去掉白名单（改成遍历 `sessionUsage` 的全部键）⇒ `别的行的会话…绝不算进来` 变红。
2. 去掉 `finishedSessions` 那一支（`if (usage === undefined) continue;`）⇒ `子会话已收场却一条用量都没有` 变红。

- [ ] **Step 6: 提交**

```bash
git add packages/server/agents/src/providers/dsh/message.ts packages/server/agents/src/providers/dsh/events.ts packages/server/agents/src/providers/dsh/index.ts packages/server/agents/src/providers/dsh/index.test.ts
git commit -m "feat(agents/dsh): 交出子会话那一份用量（白名单求和），轮次口径加守卫"
```

---

### Task 5: codex —— 子线程用量与轮次并进合计

**Files:**
- Modify: `packages/server/agents/src/providers/codex/transcript.ts`（`projectTranscriptDrafts`，约 `:671-746`）
- Modify: `packages/server/agents/src/providers/codex/index.ts`（`project` 与 `finalize`，约 `:278-351`）
- Test: `packages/server/agents/src/providers/codex/transcript.test.ts`、`.../codex/index.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `sumUsageTokens`、Task 3 的 `TurnProjection` / `TurnFinalize`
- Produces: `projectTranscriptDrafts` 的返回值多两格 `subagentUsage: UsageTokens | null` 与 `subagentTurns: number | null`；`TranscriptProjection.usage` 的语义变成**主 + 子**的合计。

- [ ] **Step 1: 写失败的用例**

在 `transcript.test.ts` 追加。用例里的 `projectWith` 是本任务新增的小夹具，**先读该文件既有的合成 transcript 夹具**（它已经把「会话文件写进临时 `codexHome`、`read` 注入点」这套做好了），然后包一层：

```ts
/**
 * 合成「主线程 + 若干子线程」的读取面，跑一次 `projectTranscriptDrafts`。
 * 三格输入：主线程（用量 + turnIds）、子线程数组（同上）、`missing`（**只登记 id、不写文件**的线程
 * ⇒ 用来钉「读不到」那一档）。`codexHome` 用 `mkdtempSync`，`read` 用该文件既有的注入写法。
 */
function projectWith(input: {
  main: { totalTokenUsage: Record<string, number>; turnIds: string[] };
  children: { id: string; totalTokenUsage: Record<string, number>; turnIds: string[] }[];
  missing?: string[];
}): TranscriptProjection
```

```ts
describe('子线程并进合计（spec 2026-10-04 §2.3）', () => {
  it('主线程与子线程的用量相加；子那一份单独给出；轮次取两边的 turnIds 之和', () => {
    const projected = projectWith({
      main: { totalTokenUsage: { input: 100, cached: 900, output: 50 }, turnIds: ['t1', 't2'] },
      children: [
        { id: 'c1', totalTokenUsage: { input: 10, cached: 20, output: 5 }, turnIds: ['u1'] },
        { id: 'c2', totalTokenUsage: { input: 1, cached: 2, output: 3 }, turnIds: ['v1', 'v2'] },
      ],
    });
    expect(projected.usage).toMatchObject({ input: 111, cached: 922, output: 58 });
    expect(projected.subagentUsage).toMatchObject({ input: 11, cached: 22, output: 8 });
    expect(projected.subagentTurns).toBe(3);
  });

  it('没有子线程 ⇒ 子那一份 {0,0,0}、轮次 0（确实没有，不是 null）', () => {
    const projected = projectWith({ main: { totalTokenUsage: { input: 5, cached: 0, output: 1 }, turnIds: ['t1'] }, children: [] });
    expect(projected.subagentUsage).toEqual({ input: 0, cached: 0, output: 0, reasoningOutput: null, total: null });
    expect(projected.subagentTurns).toBe(0);
  });

  it('某个子线程文件读不到 ⇒ 子那一份 null、合计退回主线程口径（全量或 null）', () => {
    const projected = projectWith({
      main: { totalTokenUsage: { input: 5, cached: 0, output: 1 }, turnIds: ['t1'] },
      children: [{ id: 'c1', totalTokenUsage: { input: 10, cached: 0, output: 1 }, turnIds: ['u1'] }],
      missing: ['c2'],
    });
    expect(projected.subagentUsage).toBeNull();
    expect(projected.subagentTurns).toBeNull();
    expect(projected.usage).toMatchObject({ input: 5, cached: 0, output: 1 });
  });
});
```

在 `codex/index.test.ts` 追加（该文件已有假 codex SDK 夹具与「喂事件 → 收结果」的接线；先读文件顶部确认夹具名，本节记作 `runCodexWithChildThread()`——它要做的只是：主线程事件流跑完、临时 `codexHome` 下同时存在主线程与一个子线程的会话文件）：

```ts
it('终态结果带子线程那一份（收尾折进 result，不只是发一条事件）', async () => {
  const result = await runCodexWithChildThread();
  // 主线程 100/900/50 + 子线程 10/20/5
  expect(result.tokens).toEqual({ input: 110, cached: 920, output: 55, reasoningOutput: null, total: null });
  expect(result.subagentTokens).toEqual({ input: 10, cached: 20, output: 5, reasoningOutput: null, total: null });
  expect(result.turns).toBe(3); // 主 2 轮 + 子 1 轮
});
```

- [ ] **Step 2: 跑用例确认它红**

Run: `pnpm vitest run packages/server/agents/src/providers/codex`
Expected: FAIL —— `subagentUsage` / `subagentTurns` 不存在。

- [ ] **Step 3: 实现**

`transcript.ts`：`TranscriptProjection` 加两格，并在 `projectTranscriptDrafts` 的子线程循环里累计：

```ts
export interface TranscriptProjection {
  drafts: AgentEventDraft[];
  /** **主 + 子**的合计用量（spec 2026-10-04 §2.3） */
  usage: UsageTokens | null;
  /** 子线程那一份；`null` = 有子线程但读不全（全量或 null），无子线程时是 `{0,0,0}` */
  subagentUsage: UsageTokens | null;
  /** 子线程的轮次数之和（`turnIds` 去重后的个数）；`null` 的口径与 `subagentUsage` 相同 */
  subagentTurns: number | null;
  timing?: TimingSpan;
}
```

```ts
  /** 子线程的用量与轮次：**读不全都算没读到**（spec §2.2 的「全量或 null」） */
  const childUsages: UsageTokens[] = [];
  let childTurns = 0;
  let childComplete = true;

  for (const threadId of input.childThreadIds) {
    const child = readByThreadId(input.codexHome, threadId, read);
    if (child === null) {
      // 既有行为不变：读不到就落一条点名的 WARN，且**不给数**
      childComplete = false;
      drafts.push(logDraft('stderr', `[WARN] 未找到子线程 ${threadId} 的 codex 会话文件…`));
      continue;
    }
    const childUsage = normalizedTotalUsage(child);
    if (childUsage === null) childComplete = false;
    else childUsages.push(childUsage);
    childTurns += child.turnIds.length;
    // …既有的推理正文与 subagentPayload 两条 draft 保持原样
  }

  const subagentUsage = childComplete
    ? sumUsageTokens(childUsages)
    : null;
  const subagentTurns = childComplete ? childTurns : null;
  // 合计 = 主 + 子；子那一份没读全时退回主线程口径（`usage` 保持原样）
  const usage = subagentUsage === null || usage0 === null ? usage0 : sumUsageTokens([usage0, subagentUsage]);
  return { drafts, usage, subagentUsage, subagentTurns, ...(timing === undefined ? {} : { timing }) };
```

（`usage0` = 既有的 `normalizedTotalUsage(main)`，也就是现在的 `usage` 变量——改名时保留原有注释。）

`index.ts` 的 `project`（运行期）与 `finalize`（收尾）两处：

```ts
      project: (raw, state) => {
        // …既有的 noteThreadIds / projectCodexEvent / refreshContent 一字不动
        const content = refreshContent();
        const sub = content === null ? null : subagentUsageOf(content);
        const base = content === null ? projection : { ...projection, messages: content.messages, subagents: content.subagents };
        // 子线程那一份与合计**必须同时给**：只给分量不给合计，界面上的「主会话 = 合计 − 分量」会算出负数
        return sub === null ? base : { ...base, tokens: combine(base.tokens, sub), subagentTokens: sub };
      },
```

```ts
      finalize: () => {
        // …既有的 projectTranscriptDrafts 调用与 WARN 一字不动
        const combined = projected.subagentUsage === null || projected.usage === null
          ? projected.usage
          : sumUsageTokens([projected.usage, projected.subagentUsage]);
        if (combined !== null && lastTurns !== null && isStrictlyNewer(combined, wireTokens)) {
          drafts.push({ type: 'usage', tokens: combined, subagentTokens: projected.subagentUsage, timing: resolveTiming(projected.timing ?? null), turns: finalTurns });
        }
        const content = readContent();
        return {
          drafts,
          messages: content.messages,
          subagents: content.subagents,
          // 终态结果也带上（否则编排层第 6 步会用不含子线程的 result.tokens 覆盖快照）
          ...(combined === null ? {} : { tokens: combined }),
          subagentTokens: projected.subagentUsage ?? null,
          ...(finalTurns === null ? {} : { turns: finalTurns }),
        };
      },
```

其中 `finalTurns = lastTurns === null ? null : lastTurns + (projected.subagentTurns ?? 0)`；`combine(main, sub)` 是本文件里的小纯函数（`main === null ? null : sumUsageTokens([main, sub])`），并写一句注释说明「只给分量不给合计会让界面算出负数」。

- [ ] **Step 4: 跑用例确认它绿**

Run: `pnpm vitest run packages/server/agents/src/providers/codex`
Expected: PASS

- [ ] **Step 5: 变异验证（两条）**

1. 把 `subagentUsage = childComplete ? … : null` 改成无条件求和 ⇒ 「某个子线程文件读不到」变红。
2. 把 `finalize` 返回值里的 `tokens` / `subagentTokens` 删掉（只留事件）⇒ `终态结果带子线程那一份` 变红。

- [ ] **Step 6: 提交**

```bash
git add packages/server/agents/src/providers/codex/transcript.ts packages/server/agents/src/providers/codex/index.ts packages/server/agents/src/providers/codex/transcript.test.ts packages/server/agents/src/providers/codex/index.test.ts
git commit -m "feat(agents/codex): 子线程用量与轮次并进合计，终态结果带上子那一份"
```

---

### Task 6: claude-code —— 读 CLI 落盘的子智能体会话文件

> **勘误（2026-10-04，Task 9 补记）**：本任务漏登记了一条**源码级守卫**——`findSubagentsDir` 必须列举
> CLI 的**运行期数据目录**（`<configHome>/projects/*/<session>/subagents/`），而
> `packages/server/agents/src/static-assertions.test.ts` 明令 `src/**` 里不出现 `readdir(Sync)`
> （A3：打包后扫不到**模块**，与运行期数据无关）。控制器裁定 **R11**：那条守卫加**显式钉住的白名单**
> `READDIR_ALLOWED = ['providers/claude-code/subagent-usage.ts']`——豁免是**数据**不是放宽的正则
> （正则一字未改），另有一条「逐字等于这一项 + 每项真的在扫盘」的断言防它静默变长；Task 6 的实现
> 即按此落地。下面的代码块与文末自查表（只列「§3 守卫 1–9」）保留原样不改；spec 侧的登记见
> `docs/superpowers/specs/2026-10-04-subagent-usage-in-row-metrics-design.md` 的 §3 末段与 §4 的 R6。

**Files:**
- Create: `packages/server/agents/src/providers/claude-code/subagent-usage.ts`
- Test: `packages/server/agents/src/providers/claude-code/subagent-usage.test.ts`（新）
- Modify: `packages/server/agents/src/providers/claude-code/index.ts`（`start` 的闭包与新增 `finalize`）
- Test: `packages/server/agents/src/providers/claude-code/index.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `sumUsageTokens`、Task 3 的 `TurnFinalize`
- Produces:
  - `readClaudeSubagentUsage(input: { configHome: string; sessionId: string | null; subagentIds: readonly string[] }): { usage: UsageTokens | null; turns: number | null; missing: string[] }`
  - claude 的 `finalize()`（本任务新增）

**为什么不用侧链消息流**（spec §2.3，第一版设计被实测推翻）：`forwardSubagentText: true` 确实把子智能体消息转发过来了、原始载荷也带 `message.usage`，但**这个网关下流式快照的 `output_tokens` 恒为 0**（主会话 11 条、子智能体 4 条全是 0）⇒ 照快照求和会得出「子智能体输出 0 token」这种**静默的假数**。权威源是 CLI 自己写的那份文件。

- [ ] **Step 1: 写失败的用例（纯函数，TDD 最舒服的一条）**

```ts
// @vitest-environment node
/**
 * 读 claude 的子智能体会话文件（`<CLAUDE_CONFIG_DIR>/projects/<项目>/<session>/subagents/agent-<taskId>.jsonl`）。
 * 两条必须钉住的读数规则（都是真机实测的靶子）：
 *   ① 按 `message.id` 去重、后到覆盖——同一个 API 往返按内容块出现多次，逐条相加会把 input/cached 双计；
 *   ② 读不到文件 ⇒ 整格 null 并点名（「全量或 null」，绝不把部分和当总数）。
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readClaudeSubagentUsage } from './subagent-usage';

function writeAgentFile(configHome: string, sessionId: string, taskId: string, lines: unknown[]): void {
  const dir = join(configHome, 'projects', 'D---tmp-proj', sessionId, 'subagents');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `agent-${taskId}.jsonl`), lines.map((line) => JSON.stringify(line)).join('\n'), 'utf8');
}

function assistant(messageId: string, usage: Record<string, number>): unknown {
  return { type: 'assistant', isSidechain: true, uuid: `${messageId}-${Math.random()}`, message: { id: messageId, usage } };
}

describe('readClaudeSubagentUsage', () => {
  it('按 message.id 去重、后到覆盖（逐条相加会双计 input/cached）', () => {
    const configHome = mkdtempSync(join(tmpdir(), 'claude-sub-'));
    writeAgentFile(configHome, 's-1', 'task-1', [
      assistant('m-1', { input_tokens: 13596, cache_read_input_tokens: 0, output_tokens: 0 }),
      assistant('m-1', { input_tokens: 13596, cache_read_input_tokens: 0, output_tokens: 106 }),
      assistant('m-2', { input_tokens: 1052, cache_read_input_tokens: 13696, output_tokens: 0 }),
      assistant('m-2', { input_tokens: 1052, cache_read_input_tokens: 13696, output_tokens: 2433 }),
    ]);
    const read = readClaudeSubagentUsage({ configHome, sessionId: 's-1', subagentIds: ['task-1'] });
    expect(read.usage).toEqual({ input: 14648, cached: 13696, output: 2539, reasoningOutput: null, total: null });
    expect(read.turns).toBe(2);
    expect(read.missing).toEqual([]);
  });

  it('多个子智能体各自去重后再相加', () => {
    const configHome = mkdtempSync(join(tmpdir(), 'claude-sub-'));
    writeAgentFile(configHome, 's-2', 'task-1', [assistant('m-1', { input_tokens: 10, cache_read_input_tokens: 1, output_tokens: 2 })]);
    writeAgentFile(configHome, 's-2', 'task-2', [assistant('m-9', { input_tokens: 3, cache_read_input_tokens: 0, output_tokens: 4 })]);
    const read = readClaudeSubagentUsage({ configHome, sessionId: 's-2', subagentIds: ['task-1', 'task-2'] });
    expect(read.usage).toMatchObject({ input: 13, cached: 1, output: 6 });
    expect(read.turns).toBe(2);
  });

  it('没有子智能体 ⇒ {0,0,0} 与 turns 0（确实没有，不是 null）', () => {
    const configHome = mkdtempSync(join(tmpdir(), 'claude-sub-'));
    const read = readClaudeSubagentUsage({ configHome, sessionId: null, subagentIds: [] });
    expect(read.usage).toEqual({ input: 0, cached: 0, output: 0, reasoningOutput: null, total: null });
    expect(read.turns).toBe(0);
  });

  it('有一个子智能体读不到 ⇒ 整格 null 并点名它（不把部分和当总数）', () => {
    const configHome = mkdtempSync(join(tmpdir(), 'claude-sub-'));
    writeAgentFile(configHome, 's-3', 'task-1', [assistant('m-1', { input_tokens: 10, cache_read_input_tokens: 0, output_tokens: 1 })]);
    const read = readClaudeSubagentUsage({ configHome, sessionId: 's-3', subagentIds: ['task-1', 'task-missing'] });
    expect(read.usage).toBeNull();
    expect(read.turns).toBeNull();
    expect(read.missing).toEqual(['task-missing']);
  });

  it('坏行（半截 JSON）跳过而不是整份作废——CLI 边跑边写，半截行是常态', () => {
    const configHome = mkdtempSync(join(tmpdir(), 'claude-sub-'));
    const dir = join(configHome, 'projects', 'D---tmp-proj', 's-4', 'subagents');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'agent-task-1.jsonl'),
      `${JSON.stringify(assistant('m-1', { input_tokens: 10, cache_read_input_tokens: 0, output_tokens: 1 }))}\n{"type":"assist`,
      'utf8',
    );
    const read = readClaudeSubagentUsage({ configHome, sessionId: 's-4', subagentIds: ['task-1'] });
    expect(read.usage).toMatchObject({ input: 10, output: 1 });
  });
});
```

- [ ] **Step 2: 跑用例确认它红**

Run: `pnpm vitest run packages/server/agents/src/providers/claude-code/subagent-usage.test.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现 `subagent-usage.ts`**

```ts
/**
 * claude-code 的**子智能体用量**读取（spec 2026-10-04 §2.3）。
 *
 * 为什么读盘而不是用流里的侧链消息（第一版设计就是那么写的，被实测推翻）：
 * `forwardSubagentText: true` 确实把子智能体的消息转发过来、原始载荷也带 `message.usage`，
 * 但**这个网关下流式快照的 `output_tokens` 恒为 0**（实测主会话 11 条 + 子智能体 4 条全是 0，
 * 主会话的真值只出现在 `result.usage` 上）⇒ 照快照求和会得到「子智能体输出 0 token」这种
 * **静默的假数**，比不显示更糟。
 *
 * 权威源是 CLI 自己写的那份文件（真机实测存在，文件名里的 taskId 与 `task_started.task_id` 同值）：
 *   `<CLAUDE_CONFIG_DIR>/projects/<项目目录>/<session_id>/subagents/agent-<taskId>.jsonl`
 *
 * 两条读数规则，缺一条就错：
 *   ① **按 `message.id` 去重、后到覆盖**：同一个 API 往返按内容块出现多次（thinking 一条、
 *      tool_use/text 一条），第一条的 `output_tokens` 是 0 ⇒ 逐条相加会把 input/cached 双计
 *      （实测：29,296 / 27,392 vs 正确的 14,648 / 13,696）；
 *   ② **`turns` = 去重后的 `message.id` 个数**（一次 API 往返 = 一轮，与主循环同口径）。
 *
 * 读不全（嵌套子智能体落在别处、CLI 换布局）⇒ **整格 null 并点名**（spec §2.2 的「全量或 null」）：
 * 部分和会被读成总数，而界面上它与全量合计长得一模一样。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { UsageTokens } from '@aieval/contracts';
import { asRecord, readNumber, readString } from '../../json';
import { sumUsageTokens } from '../../usage';

export interface ClaudeSubagentUsageRead {
  /** 子智能体那一份；`null` = 有子智能体但读不全 */
  usage: UsageTokens | null;
  turns: number | null;
  /** 读不到的子智能体 id（调用方据此落点名 WARN） */
  missing: string[];
}

export function readClaudeSubagentUsage(input: {
  configHome: string;
  /** `system/init` 回显的 session id；采不到为 null（那时按目录名兜底扫描） */
  sessionId: string | null;
  subagentIds: readonly string[];
}): ClaudeSubagentUsageRead {
  if (input.subagentIds.length === 0) return { usage: sumUsageTokens([]), turns: 0, missing: [] };
  const dir = findSubagentsDir(input.configHome, input.sessionId);
  if (dir === null) return { usage: null, turns: null, missing: [...input.subagentIds] };
  const parts: UsageTokens[] = [];
  const missing: string[] = [];
  let turns = 0;
  for (const taskId of input.subagentIds) {
    const file = join(dir, `agent-${taskId}.jsonl`);
    const read = readOne(file);
    if (read === null) {
      missing.push(taskId);
      continue;
    }
    parts.push(read.usage);
    turns += read.turns;
  }
  // 有点名的就整格 null（读到的那些**不进合计**，否则部分和会冒充总数）
  if (missing.length > 0) return { usage: null, turns: null, missing };
  return { usage: sumUsageTokens(parts), turns, missing: [] };
}

/** 同一份文件里按 `message.id` 去重后的用量与往返数；文件不存在返回 null */
function readOne(file: string): { usage: UsageTokens; turns: number } | null {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  /** `message.id` → 那一次往返的用量（**后到覆盖**：同一条消息会按内容块多次到达） */
  const byMessageId = new Map<string, UsageTokens>();
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    let record: Record<string, unknown> | null;
    try {
      record = asRecord(JSON.parse(line));
    } catch {
      // 半截行是常态（CLI 边跑边写）：跳过，不让它作废整份文件
      continue;
    }
    if (readString(record, 'type') !== 'assistant') continue;
    const message = asRecord(record?.message);
    const messageId = readString(message, 'id');
    if (messageId === null) continue;
    const usage = readTrio(asRecord(message?.usage));
    if (usage === null) continue;
    byMessageId.set(messageId, usage);
  }
  return { usage: sumUsageTokens([...byMessageId.values()]), turns: byMessageId.size };
}

/** 三项齐了才认（缺项即整格不认，绝不填 0——与适配器主路径同一条硬口径） */
function readTrio(usage: Record<string, unknown> | null): UsageTokens | null {
  const input = readNumber(usage, 'input_tokens');
  const cached = readNumber(usage, 'cache_read_input_tokens');
  const output = readNumber(usage, 'output_tokens');
  if (input === null || cached === null || output === null) return null;
  return { input, cached, output, reasoningOutput: null, total: null };
}

/**
 * 找 `<configHome>/projects/<项目目录>/<sessionId>/subagents`。
 * 会话 id 已知就按它匹配（目录名是 CLI 自己按 cwd 拼的，**我们不重算那条规则**——
 * 算错会静默读到空目录，而按 id 匹配是「事实」）；id 未知时退回「唯一一个带 subagents 的会话目录」。
 */
function findSubagentsDir(configHome: string, sessionId: string | null): string | null {
  const projects = join(configHome, 'projects');
  let projectDirs: string[];
  try {
    projectDirs = readdirSync(projects);
  } catch {
    return null;
  }
  const candidates: string[] = [];
  for (const project of projectDirs) {
    if (sessionId !== null) {
      candidates.push(join(projects, project, sessionId, 'subagents'));
      continue;
    }
    let sessions: string[];
    try {
      sessions = readdirSync(join(projects, project));
    } catch {
      continue;
    }
    for (const session of sessions) candidates.push(join(projects, project, session, 'subagents'));
  }
  for (const candidate of candidates) {
    try {
      if (readdirSync(candidate).length >= 0) return candidate;
    } catch {
      continue;
    }
  }
  return null;
}
```

（`asRecord` / `readNumber` / `readString` 来自 `../../json`——claude 侧的既有取数工具，先确认导出名与签名。）

- [ ] **Step 4: 跑用例确认它绿**

Run: `pnpm vitest run packages/server/agents/src/providers/claude-code/subagent-usage.test.ts`
Expected: PASS

- [ ] **Step 5: 接到 `index.ts`（`start` 闭包 + 新增 `finalize`）**

```ts
  /**
   * 本行见过的**子智能体 id**（`task_started` / `task_notification` 的 `task_id`）与
   * `system/init` 回显的 **session id**：收尾读子智能体会话文件时，这两个是定位它所需的全部信息。
   */
  const subagentIds = new Set<string>();
  let sessionId: string | null = null;
  /** 主会话的**权威结算值**（`result.usage`）：收尾把子智能体那一份加在它上面 */
  let mainTokens: { input: number; cached: number; output: number } | null = null;
  /** 主会话的轮次（同一理由：收尾在投影循环之外，只能自己镜像一份） */
  let mainTurns: number | null = null;

  // project 里（既有的 projection / normalized 之后）：
    if (normalized.subagent !== null) subagentIds.add(normalized.subagent.subagentId);
    const rawRecord = asRecord(raw);
    if (sessionId === null && readString(rawRecord, 'subtype') === 'init') {
      sessionId = readString(rawRecord, 'session_id');
    }
    // 只记**权威值**（非估算）：`tokensEstimated` 为真的是跑动期估算，与骨架 `tokens` 的判据同源
    if (projection.tokens !== null && projection.tokensEstimated !== true) mainTokens = projection.tokens;
    if (projection.turns !== null) mainTurns = projection.turns;

  // 返回值里新增（在 project 之后）：
    finalize: () => {
      const read = readClaudeSubagentUsage({ configHome: input.configHome, sessionId, subagentIds: [...subagentIds] });
      const drafts: AgentEventDraft[] = [];
      if (read.missing.length > 0) {
        drafts.push(logDraft('stderr', `[WARN] 读不到子智能体 ${read.missing.join('、')} 的会话文件，这一行的 tok / 缓存命中 / 轮次**不含**它们（不编造）`));
      }
      // 「全量或 null」：子那一份没读全 ⇒ 合计退回主会话口径（spec §2.2）
      const combined = read.usage === null || mainTokens === null ? mainTokens : sumUsageTokens([mainTokens, read.usage]);
      const turns = read.turns === null ? null : (mainTurns ?? 0) + read.turns;
      return {
        drafts,
        ...(combined === null ? {} : { tokens: combined }),
        subagentTokens: read.usage,
        ...(turns === null ? {} : { turns }),
      };
    },
```

在 `index.test.ts` 追加（该文件已有 `createRecorder()` / `createFakeClaudeSdk({ recorder, events })` / `createRunInput()` 与 `setAgentRuntimeForTesting` 这一整套，照第 41-57 行那条用例的写法接线）：

```ts
it('finalize 把子智能体那一份加进结果，taskId 与 sessionId 都用对', async () => {
  // configHome 必须指向**真的临时目录**（收尾要按它去读子智能体会话文件）；
  // createRunInput 接受 overrides —— 见第 57 行那条断言过的默认值 'D:/tmp/rows/row-1/.agenthome'
  const configHome = mkdtempSync(join(tmpdir(), 'claude-row-'));
  writeAgentFile(configHome, 's-1', 'task-1', [
    assistant('m-1', { input_tokens: 4, cache_read_input_tokens: 0, output_tokens: 0 }),
    assistant('m-1', { input_tokens: 4, cache_read_input_tokens: 0, output_tokens: 2 }),
  ]);
  const recorder = createRecorder();
  setAgentRuntimeForTesting({
    sdkModule: {
      [CLAUDE_PACKAGE_NAME]: createFakeClaudeSdk({
        recorder,
        events: [
          { type: 'system', subtype: 'init', session_id: 's-1' },
          { type: 'system', subtype: 'task_started', task_id: 'task-1', tool_use_id: 'call_1' },
          { type: 'result', subtype: 'success', usage: { input_tokens: 100, cache_read_input_tokens: 0, output_tokens: 10 } },
        ],
      }),
    },
  });
  const result = await claudeCodeProvider.run(createRunInput({ configHome }));
  expect(result.subagentTokens).toEqual({ input: 4, cached: 0, output: 2, reasoningOutput: null, total: null });
  expect(result.tokens).toEqual({ input: 104, cached: 0, output: 12, reasoningOutput: null, total: null });
  expect(result.turns).toBe(2); // 主 1 轮 + 子 1 轮
});

it('子智能体文件不在 ⇒ 子那一份 null、合计退回主会话，并落一条点名 WARN', async () => {
  const configHome = mkdtempSync(join(tmpdir(), 'claude-row-'));
  const recorder = createRecorder();
  setAgentRuntimeForTesting({
    sdkModule: {
      [CLAUDE_PACKAGE_NAME]: createFakeClaudeSdk({
        recorder,
        events: [
          { type: 'system', subtype: 'init', session_id: 's-nope' },
          { type: 'system', subtype: 'task_started', task_id: 'task-missing', tool_use_id: 'call_1' },
          { type: 'result', subtype: 'success', usage: { input_tokens: 100, cache_read_input_tokens: 0, output_tokens: 10 } },
        ],
      }),
    },
  });
  const events: AgentEvent[] = [];
  const result = await claudeCodeProvider.run(createRunInput({ configHome, onEvent: (event) => events.push(event) }));
  expect(result.subagentTokens).toBeNull();
  expect(result.tokens).toEqual({ input: 100, cached: 0, output: 10, reasoningOutput: null, total: null });
  expect(events.some((event) => event.type === 'log' && event.text.includes('task-missing'))).toBe(true);
});
```

（`writeAgentFile` / `assistant` 两个小夹具从 `subagent-usage.test.ts` 复制过来——它们只是「按 CLI 的目录布局写一份 jsonl」。）

- [ ] **Step 6: 跑用例确认它绿**

Run: `pnpm vitest run packages/server/agents/src/providers/claude-code`
Expected: PASS

- [ ] **Step 7: 变异验证（两条）**

1. 把 `readOne` 的 `byMessageId.set(messageId, usage)` 改成 `parts.push(usage)`（即去掉按 id 去重）
   ⇒ 「按 message.id 去重」那条用例变红（input/cached 双计）。
2. 把 `readClaudeSubagentUsage` 里 `if (missing.length > 0) return { usage: null, … }` 删掉
   ⇒ 「有一个子智能体读不到」变红。

- [ ] **Step 8: 提交**

```bash
git add packages/server/agents/src/providers/claude-code/subagent-usage.ts packages/server/agents/src/providers/claude-code/subagent-usage.test.ts packages/server/agents/src/providers/claude-code/index.ts packages/server/agents/src/providers/claude-code/index.test.ts
git commit -m "feat(agents/claude-code): 读 CLI 落盘的子智能体会话文件，交出子智能体那一份"
```

---

### Task 7: 编排落盘（事件回写快照 + 终态写入）

**Files:**
- Modify: `packages/server/evaluator/src/orchestrator.ts:1177-1182`（`onEvent` 的 usage 分支）
- Modify: `packages/server/evaluator/src/orchestrator.ts:1267`（`measured`）
- Test: `packages/server/evaluator/src/orchestrator-live.test.ts`、`.../orchestrator-run-row.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `EvalRow.subagentTokens`、Task 3 的 `AgentRunResult.subagentTokens` 与 `usage` 事件那一格
- Produces: `run.json` 的 `rows[].subagentTokens` 在跑动期（`liveUsage: 'reported'`）与终态两条路上都写对。

- [ ] **Step 1: 写失败的用例**

`orchestrator-live.test.ts`（该文件已有 `live.emitUsage` 夹具，把它的签名扩一格）：

```ts
it('跑动期的 usage 事件把 subagentTokens 一并回写快照（reported 家）', async () => {
  // 夹具：liveUsage: 'reported' 的假适配器
  live.emitUsage?.({ input: 11, cached: 2, output: 3 }, 2, { input: 5, cached: 1, output: 2 });
  expect(getRun(runId).rows[0]?.subagentTokens).toEqual({ input: 5, cached: 1, output: 2 });
});

it('显式 null 的 usage 事件把分量清成 null（读失败时合计已退回主会话口径，留着旧分量会破坏「分量 ≤ 合计」）', async () => {
  live.emitUsage?.({ input: 11, cached: 2, output: 3 }, 2, { input: 5, cached: 1, output: 2 });
  live.emitUsage?.({ input: 11, cached: 2, output: 3 }, 3, null);
  expect(getRun(runId).rows[0]?.subagentTokens).toBeNull();
});

it('**缺这一格**（老事件 / undefined）时保持已采到的分量——与显式 null 是两件事', async () => {
  live.emitUsage?.({ input: 11, cached: 2, output: 3 }, 2, { input: 5, cached: 1, output: 2 });
  live.emitUsage?.({ input: 11, cached: 2, output: 3 }, 3, undefined);
  expect(getRun(runId).rows[0]?.subagentTokens).toEqual({ input: 5, cached: 1, output: 2 });
});
```

`orchestrator-run-row.test.ts`：

```ts
it('终态把适配器结果的 subagentTokens 写进 run.json', async () => {
  fakeAgents.scripts.set('codex', { tokens: { input: 10, cached: 0, output: 20 }, turns: 1, subagentTokens: { input: 4, cached: 1, output: 2 } });
  // …跑完一行
  expect(getRun(run.id).rows[0]?.subagentTokens).toEqual({ input: 4, cached: 1, output: 2 });
});
```

（假适配器夹具 `evaluator/src/testing/fixtures.ts` 的 `script` 形状要同步加一格 `subagentTokens`，缺省 `null`——与既有 `tokens` / `turns` 的 `?? 默认值` 写法同一条口径，注意**不要**用 `??` 兜掉显式的 `null`。）

- [ ] **Step 2: 跑用例确认它红**

Run: `pnpm vitest run packages/server/evaluator/src/orchestrator-live.test.ts packages/server/evaluator/src/orchestrator-run-row.test.ts`
Expected: FAIL —— 快照里没有 `subagentTokens`。

- [ ] **Step 3: 实现**

```ts
    if (event.type === 'usage' && liveUsageAuthoritative) {
      patchRow(runId, rowId, {
        turns: event.turns,
        ...(event.tokens === null ? {} : { tokens: event.tokens }),
        /**
         * 子智能体那一份：**显式 `null` 要清**（`undefined` = 老事件缺这一格 ⇒ 保持原值）。
         * 为什么与 `tokens` 的处置不同：读失败时同一条事件的 `tokens` 已退回主会话口径，
         * 留着旧的偏大分量会让快照满足不了 `subagentTokens ≤ tokens`（spec §2.4 的不变量）。
         */
        ...(event.subagentTokens === undefined ? {} : { subagentTokens: event.subagentTokens }),
      });
    }
```

```ts
  const measured = {
    tokens: result?.tokens ?? null,
    turns: result?.turns ?? null,
    // 终态**必须**写这一格：codex 的子线程用量与 claude 的子智能体用量都只在收尾才知道，
    // 而收尾那条 usage 事件会在几毫秒后被这里的 patchRow 覆盖（见 TurnFinalize 的注释）
    subagentTokens: result?.subagentTokens ?? null,
  };
```

- [ ] **Step 4: 跑用例确认它绿**

Run: `pnpm vitest run packages/server/evaluator/src/orchestrator-live.test.ts packages/server/evaluator/src/orchestrator-run-row.test.ts`
Expected: PASS

- [ ] **Step 5: 变异验证**

把 `measured` 里的 `subagentTokens` 那一行删掉 ⇒ `终态把适配器结果的 subagentTokens 写进 run.json` 变红（这正是「收尾只在事件里给数」会踩的坑）。

- [ ] **Step 6: 提交**

```bash
git add packages/server/evaluator/src/orchestrator.ts packages/server/evaluator/src/orchestrator-live.test.ts packages/server/evaluator/src/orchestrator-run-row.test.ts packages/server/evaluator/src/testing/fixtures.ts
git commit -m "feat(evaluator): subagentTokens 在跑动期与终态两条路上都落盘"
```

---

### Task 8: 客户端折叠 + 卡片 Tooltip 两行

**Files:**
- Modify: `packages/client/client/src/row-live.ts`（`RowLiveMetrics`、`LIVE_STATE_INIT`、`stepLiveState`、`sameMetrics`、`toMetrics`）
- Modify: `packages/client/ui/src/base/metric-line.tsx`（props、Tooltip）
- Modify: `packages/client/ui/src/composite/eval-row-card.tsx:194-202`（透传）
- Test: `packages/client/client/src/row-live.test.tsx`、`packages/client/ui/src/base/metric-line.test.tsx`

**Interfaces:**
- Consumes: Task 1/3/7 的四格
- Produces: `RowLiveMetrics.subagentTokens: { input: number; cached: number; output: number } | null`；`LiveMetricsView.subagentTokens`；`MetricLineProps.subagentTokens?: …`

- [ ] **Step 1: 写失败的用例（界面口径最全的一组）**

`metric-line.test.tsx` 追加：

```tsx
describe('子智能体那一份：Tooltip 拆两行（spec 2026-10-04 §2.5）', () => {
  it('有子智能体时两行：主会话是相减算出来的，不是第二份真值', async () => {
    render(
      <MetricLine
        tokens={{ input: 100, cached: 20, output: 30 }}
        subagentTokens={{ input: 40, cached: 10, output: 5 }}
        turns={3}
        durationMs={1000}
        score={null}
      />,
    );
    await userEvent.hover(screen.getByText(/^tok /));
    expect(await screen.findByText(/主会话 输入 60 · 缓存 10 · 输出 25/)).toBeInTheDocument();
    expect(await screen.findByText(/子智能体 输入 40 · 缓存 10 · 输出 5/)).toBeInTheDocument();
  });

  it('没有子智能体（{0,0,0}）时**只有一行**，逐字与改动前相同', async () => {
    render(<MetricLine tokens={{ input: 100, cached: 20, output: 30 }} subagentTokens={{ input: 0, cached: 0, output: 0 }} turns={3} durationMs={1000} score={null} />);
    await userEvent.hover(screen.getByText(/^tok /));
    expect(await screen.findByText('输入 100 · 缓存 20 · 输出 30')).toBeInTheDocument();
    expect(screen.queryByText(/主会话/)).toBeNull();
  });

  it('分量没采到（null）与缺这一格（老数据）都退回一行', async () => {
    render(<MetricLine tokens={{ input: 100, cached: 20, output: 30 }} subagentTokens={null} turns={3} durationMs={1000} score={null} />);
    await userEvent.hover(screen.getByText(/^tok /));
    expect(await screen.findByText('输入 100 · 缓存 20 · 输出 30')).toBeInTheDocument();
  });

  it('分量与合计对不上（主会话算出负数）时不画拆分——宁可少一行，也不显示 -12', async () => {
    render(<MetricLine tokens={{ input: 10, cached: 0, output: 1 }} subagentTokens={{ input: 40, cached: 0, output: 5 }} turns={1} durationMs={1000} score={null} />);
    await userEvent.hover(screen.getByText(/^tok /));
    expect(await screen.findByText('输入 10 · 缓存 0 · 输出 1')).toBeInTheDocument();
    expect(screen.queryByText(/主会话/)).toBeNull();
  });

  it('跑动期用叠加层的那一对（合计与分量必须同源同刻）', async () => {
    render(
      <MetricLine
        tokens={{ input: 1, cached: 0, output: 1 }}
        subagentTokens={{ input: 0, cached: 0, output: 0 }}
        turns={1}
        durationMs={null}
        score={null}
        running
        live={{ startedAtMs: Date.now(), tokens: { input: 100, cached: 20, output: 30 }, subagentTokens: { input: 40, cached: 10, output: 5 }, turns: 2, candidateEnded: false, candidateEndedAtMs: null }}
      />,
    );
    await userEvent.hover(screen.getByText(/^tok /));
    expect(await screen.findByText(/子智能体 输入 40 · 缓存 10 · 输出 5/)).toBeInTheDocument();
  });
});
```

`row-live.test.tsx` 追加：

```tsx
it('usage 事件带回 subagentTokens：折叠到实时值上（覆盖语义）', () => {
  const folded = foldLiveMetrics([
    { seq: 1, at: AT, type: 'usage', tokens: { input: 10, cached: 0, output: 2 }, subagentTokens: { input: 4, cached: 1, output: 1 }, turns: 1 },
    { seq: 2, at: AT, type: 'usage', tokens: { input: 12, cached: 0, output: 3 }, subagentTokens: { input: 6, cached: 1, output: 2 }, turns: 2 },
  ]);
  expect(folded.subagentTokens).toEqual({ input: 6, cached: 1, output: 2 });
});

it('候选阶段冻结之后，子智能体那一份也不再更新（评分智能体不许进这三格）', () => {
  const folded = foldLiveMetrics([
    { seq: 1, at: AT, type: 'usage', tokens: { input: 10, cached: 0, output: 2 }, subagentTokens: { input: 4, cached: 1, output: 1 }, turns: 1 },
    { seq: 2, at: AT, type: 'status', status: 'judging' },
    { seq: 3, at: AT, type: 'usage', tokens: { input: 999, cached: 0, output: 999 }, subagentTokens: { input: 999, cached: 0, output: 999 }, turns: 1 },
  ]);
  expect(folded.subagentTokens).toEqual({ input: 4, cached: 1, output: 1 });
});
```

- [ ] **Step 2: 跑用例确认它红**

Run: `pnpm vitest run packages/client/ui/src/base/metric-line.test.tsx packages/client/client/src/row-live.test.tsx`
Expected: FAIL —— props / 字段不存在。

- [ ] **Step 3: 实现**

`row-live.ts`：

```ts
  /**
   * **子智能体那一份**用量（2026-10-04）：`tokens` 是「主会话 + 全部子智能体」的合计，
   * 这一格是分量（卡片 Tooltip 据此拆两行）。`null` = 没有子智能体或没采到。
   * 冻结口径与 `tokens` **逐字相同**（口径 5）：候选阶段一结束就不再接受任何 `usage`。
   */
  subagentTokens: { input: number; cached: number; output: number } | null;
```

- `LIVE_STATE_INIT` 加 `subagentTokens: null`；
- `stepLiveState` 的 `usage` 分支：`subagentTokens: event.subagentTokens === undefined ? base.subagentTokens : event.subagentTokens`——**显式 `null` 要清空**（与编排层 `patchRow` 同一条规则，理由见那里：读失败时合计已退回主会话口径）；`undefined`（老事件缺这一格）才保持上一份。与 `tokens` 的 `?? base.tokens` **刻意不同**，注释里要写清这一点；
- `sameMetrics` 加一格比较（否则只变了分量的帧不会发布，Tooltip 永远停在第一次的读数上）；
- `toMetrics` 透传。

`metric-line.tsx`：

```tsx
export interface MetricLineProps {
  tokens: { input: number; cached: number; output: number } | null;
  /**
   * **子智能体那一份**（2026-10-04）：`tokens` 是合计，这一格是分量。
   * 三档与契约一致：缺省 / `null` / `{0,0,0}` **都不画拆分那一行**（退回改动前逐字相同的那一行）；
   * 只有「有分量且逐格不大于合计」时才拆成两行。可选是为了老调用方不必改。
   */
  subagentTokens?: { input: number; cached: number; output: number } | null;
  …
}

// 组件内：合计与分量**必须同源同刻**（跑动期用叠加层那一对，终态用快照那一对）
const overlayTokens = overlay?.tokens ?? null;
const shownTokens = overlayTokens ?? tokens;
const shownSubagentTokens = overlayTokens !== null ? (overlay?.subagentTokens ?? null) : (subagentTokens ?? null);
/**
 * 拆分只在**分量真的小于合计**时画（逐格）：分量比合计大只可能来自口径错位的脏数据，
 * 那时「主会话 = 合计 − 分量」会算出负数——宁可少一行，也不显示一个负的输入量。
 */
const split =
  shownTokens !== null
  && shownSubagentTokens !== null
  && shownTokens.input >= shownSubagentTokens.input
  && shownTokens.cached >= shownSubagentTokens.cached
  && shownTokens.output >= shownSubagentTokens.output
  && shownSubagentTokens.input + shownSubagentTokens.cached + shownSubagentTokens.output > 0
    ? {
      main: {
        input: shownTokens.input - shownSubagentTokens.input,
        cached: shownTokens.cached - shownSubagentTokens.cached,
        output: shownTokens.output - shownSubagentTokens.output,
      },
      sub: shownSubagentTokens,
    }
    : null;
const tokenDetail =
  shownTokens === null
    ? undefined
    : split === null
      ? `输入 ${formatCount(shownTokens.input)} · 缓存 ${formatCount(shownTokens.cached)} · 输出 ${formatCount(shownTokens.output)}`
      : (
        <Flex vertical>
          <span>{`主会话 输入 ${formatCount(split.main.input)} · 缓存 ${formatCount(split.main.cached)} · 输出 ${formatCount(split.main.output)}`}</span>
          <span>{`子智能体 输入 ${formatCount(split.sub.input)} · 缓存 ${formatCount(split.sub.cached)} · 输出 ${formatCount(split.sub.output)}`}</span>
        </Flex>
      );
```

`LiveMetricsView` 同步加 `subagentTokens`（形状与 `RowLiveMetrics` 逐字段一致——两边脱钩时 web-next 的接线处 tsc 会报错）。

`eval-row-card.tsx` 的 `<MetricLine …>` 加一行 `subagentTokens={row.subagentTokens}`（`row` 来自契约，可选格）。

- [ ] **Step 4: 跑用例确认它绿**

Run: `pnpm vitest run packages/client/ui/src/base/metric-line.test.tsx packages/client/client/src/row-live.test.tsx`
Expected: PASS

- [ ] **Step 5: 变异验证（两条）**

1. 把 `split` 的四个条件删到只剩 `shownSubagentTokens !== null` ⇒「对不上时不画拆分」与「{0,0,0} 只有一行」两条变红。
2. 把 `sameMetrics` 里新加的那一格比较（`subagentTokens` 的三项）删掉 ⇒ 在 Step 1 里补一条断言后变红：同一行连收两条 `usage`，**只**改分量，断言第二次之后界面上读到的是新的分量（把两条帧折进 `foldLiveMetrics` 后直接断言 `subagentTokens`，再补一条「发布判据」的用例：`ingest` 两次后 `publish` 的份数）。

- [ ] **Step 6: 提交**

```bash
git add packages/client/client/src/row-live.ts packages/client/client/src/row-live.test.tsx packages/client/ui/src/base/metric-line.tsx packages/client/ui/src/base/metric-line.test.tsx packages/client/ui/src/composite/eval-row-card.tsx
git commit -m "feat(ui): 卡片 Tooltip 把用量拆成主会话 / 子智能体两行"
```

---

### Task 9: 口径收口（注释、全量门禁、冒烟）

**Files:**
- Modify: `packages/client/ui/src/base/metric-line.tsx`（文件头口径段）
- Modify: `packages/client/client/src/row-live.ts`（文件头口径 5 那一段）
- Modify: `packages/server/agents/src/providers/dsh/events.ts`（文件头：把「不按会话分叉」这件既成事实写进口径）

**Interfaces:** 无新接口（纯文档与验证）

- [ ] **Step 1: 补三处口径注释**

- `metric-line.tsx` 文件头：加一段「三格 = 候选 + 它派发的全部子智能体；评分智能体永远不在内；拆分只在分量 ≤ 合计且非全 0 时画」；
- `row-live.ts` 文件头口径 5：补一句「`subagentTokens` 与 `tokens` **同一条冻结口径**：候选阶段一结束就都不再更新——评分智能体的用量既不在合计里，也不在分量里」；
- `dsh/events.ts` 文件头：把「用量与轮次**不按会话分叉**（子会话的 `assistant/message` 与 `step/start` 也进本行累计）⇒ dsh 的三格天然含子智能体」写成**明确的既成口径**，并指向 spec。

- [ ] **Step 2: 全量门禁**

```bash
pnpm typecheck
pnpm lint
pnpm vitest run packages/server/contracts packages/server/agents packages/server/evaluator packages/client
```

Expected: 三条都干净（`typecheck` / `lint` 零错误；用例除既有红之外全绿——**跑之前先记下基线红数**，本仓的墙钟与红数受机器负载影响，见 AGENT.md「机器带负载时的跑法」）。

- [ ] **Step 3: 真实冒烟（本仓的规矩：浏览器 + CLI 互证）**

1. 起服务：`pnpm dev`（端口被占用先 kill 占用进程）；
2. 在 http://localhost:3083 跑一轮**带子智能体**的用例（提示词里明确要求「完成后使用 subagent 审查」，与 `run 2921fee3` 同形），三家都选上；
3. 每行卡片：悬停 tok，确认 Tooltip 出现「主会话 / 子智能体」两行；用 `read_picked_element` 读 `getBoundingClientRect()` 而非凭截图判断；
4. CLI 互证：读该行 `run.json` 的 `rows[].tokens` 与 `rows[].subagentTokens`，与 `messages.jsonl` 里子任务记录的 `usage` 对账（dsh/codex 逐字段可对；claude 与 `subagents/agent-*.jsonl` 的去重和对比）；
5. 把四要素（范围清单 / 操作路径 / 证据 / 未覆盖项）写进 `docs/superpowers/notes/2026-10-04-subagent-usage-smoke.md`。

- [ ] **Step 4: 提交**

```bash
git add packages/client/ui/src/base/metric-line.tsx packages/client/client/src/row-live.ts packages/server/agents/src/providers/dsh/events.ts docs/superpowers/notes/2026-10-04-subagent-usage-smoke.md
git commit -m "docs: 子智能体计量口径收口（注释 + 冒烟记录）"
```

---

## 自查（写完计划后对 spec 逐条核对）

| spec 章节 | 落在哪个任务 |
|---|---|
| §2.1 口径（范围 / 轮次 / 耗时不动） | Task 3（骨架不加法）、Task 4/5/6（三家取数）、Task 8（拆分只在分量≤合计时画） |
| §2.2 数据形状与三档 | Task 1（契约三态）、Task 3（投影三态）、Task 5/6（全量或 null）、Task 8（界面三态） |
| §2.3 三家取数 | Task 4（dsh 白名单）、Task 5（codex 子线程）、Task 6（claude 文件 + 按 id 去重） |
| §2.4 实时与终态 | Task 3（`TurnFinalize` 折进结果）、Task 5/6（收尾读盘）、Task 7（两条落盘路）、Task 8（同源同刻） |
| §2.5 界面 | Task 8 |
| §3 守卫 1–9 | Task 3（#6）、Task 4（#4/#5）、Task 5（#3）、Task 6（#1/#2）、Task 7（#7）、Task 8（#8/#9） |
| §4 风险 R1–R5 | R1/R4 → Task 6 的 `missing` 通道 + WARN；R2 → Task 5 沿用既有节流读盘；R3 → Task 4 的守卫；R5 → Global Constraints 的提交纪律 |
| §5 影响面 | File Structure 表逐行对得上 |

**已知不含**：嵌套子智能体（子智能体再派一个）的文件布局未实测——按 R1 记 `null` + WARN，不猜；
`subagentTurns` 不单独落盘（spec §2.2 的裁定）。
