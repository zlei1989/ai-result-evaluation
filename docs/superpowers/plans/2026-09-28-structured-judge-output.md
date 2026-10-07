# 评分通路的结构化输出 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让评分智能体通路用 claude-code / codex 的**原生 schema 开关**约束返回形状，dsh 与文本通路走**有痕降级**，全程零三方依赖。

**Architecture:** 契约里放一份手写的 JSON Schema 字面量（与 `JUDGE_OUTPUT_CONTRACT` 同形、同一处维护），`agents` 层用一个中性入参 `AgentRunInput.outputSchema?` 加一个能力声明 `capability.structuredOutput` 承载它，两家适配器各自翻译成自家方言（cc 的 `outputFormat` / codex 的 `outputSchema`），编排层按能力声明决定带不带并对降级**发一条行日志**，结论记进 `ScoreResult.structuredOutput`。解析与收口（`collectJudgeDimensions` / `finalizeScore`）一个字不改。

**Tech Stack:** TypeScript 5（strict + noUncheckedIndexedAccess）、zod 3、vitest 4（node / jsdom 双配置）、pnpm workspace monorepo（8 包）、antd 6 + React 19。

**Spec:** `docs/superpowers/specs/2026-09-22-scaffold-design.md` §13.2（本线的过程 spec 已并入该文档并从库中删除）

## Global Constraints

- **零三方依赖**：不改 `package.json` 的 `dependencies` / `devDependencies`，不改 `pnpm-lock.yaml`，不安装任何 CLI 插件。测试里需要 JSON Schema 校验时，写本仓自己的最小校验器（Task 1）。
- **既有用例一条不改**：除本计划明确列出的新增断言外，任何既有测试文件里的既有用例都不得修改或删除（`structuredOutput` 变成必填**输出**字段而导致的夹具补字段除外——那是类型要求，不是放松断言）。
- **提交纪律**：`git add <显式路径>`，**禁止 `git add -A`**；工作区里出现不属于本任务的改动时保持原样、不要动它。
- **门禁**：每个任务提交前跑该包测试 + `pnpm typecheck`；进入评审前 `pnpm typecheck` → `pnpm lint` 必须全绿（AGENT.md）。
- **变异验证**：本计划新增的每条守卫都要做变异验证（人为制造它要拦的缺陷 → 看见对应用例失败 → 复原并核对文件哈希未变），记录写进任务报告。
- **注释**：中文 JSDoc，先说「做什么」再说「为什么这么做」；文件头写职责与注意事项（AGENT.md）。
- **不改尺子**：`collectJudgeDimensions`、`parseJudgeResponse`、`validateJudgeResponse`、`JUDGE_REPAIR_ROUNDS = 2`、`composeTotalScore` 的语义一律不动。
- **不改的包**：`packages/server/core`、`packages/server/api`、`apps/web-next`、候选执行阶段（`agents` 的 `permission: 'full'` 那条路）全部不碰。

## Review Focus

这五类输入/条件 spec 隐含、但没有任何任务的测试能直接覆盖，是上线后最可能咬人的地方；每一行都已在下表指名的任务里补了钉住它的用例：

| # | 条件 | 合理预期 | 钉在哪个任务 |
|---|---|---|---|
| 1 | 网关不认 schema（cc 的 Messages / codex 的 Responses 那一格被丢掉） | **不报错**，模型照旧自由生成 ⇒ 评分仍可能落 `JUDGE_PARSE_FAILED`，绝不是 `INTERNAL`，且 `score.structuredOutput` 仍记 `true`（它记的是「我们传了」，不是「上游认了」） | Task 6（假 provider 返回散文 ⇒ 错误码是 `JUDGE_PARSE_FAILED`）；spec §9 第 1 条 |
| 2 | cc 在结构化那一轮 `result` 为空、产出只在 `structured_output` 附件里 | `finalText` 仍拿得到那段 JSON（出口优先 `structured_output`），不是 `null` | Task 3（events 用例造 `result: ''` + `structured_output`） |
| 3 | 磁盘上已有的 `run.json`（评分里没有 `structuredOutput`） | 读得回来且值为 `false`，页面照常渲染 | Task 1（契约默认值）+ Task 6（run-store 往返） |
| 4 | 候选执行阶段（`permission: 'full'`，不传 schema） | 三家的厂商选项里**没有** schema 相关键，行为与今天逐字相同 | Task 3 / Task 4（「不给就不加键」的守卫） |
| 5 | dsh 收到 schema（纵深防御，生产路径不可达） | 抛中文错、**不 spawn**，而不是静默忽略 | Task 5 |

## 计划对 spec 的两处修正（执行时按本计划，评审时按这里的理由）

| # | spec 原文 | 本计划 | 理由 |
|---|---|---|---|
| 1 | §5.3 第 4 条：归因补在 **`errors.ts`** | 落在 `providers/claude-code/events.ts` 的 `projectResult` | `error_max_structured_output_retries` 是 **claude 一家的 subtype**，而 `errors.ts` 是三家共用的中性归因层（它的输入只有 message 文本与 baseUrl）。把厂商子类型塞进去，等于让共享层知道某一家 CLI 的枚举——与「厂商方言留在 `providers/<kind>/`」这条既有边界冲突。归因码仍按要求是 `AGENT_FAILED`。 |
| 2 | §4.3：「一份合格样例同时过 schema 与 `parseJudgeResponse`」 | 合格样例过 schema 这件事，由 Task 1 里**本仓自写的最小 JSON Schema 校验器**（约 40 行，测试文件内）执行 | 零依赖约束下不能引 `ajv` 这类校验库；不校验的话，「合格样例过 schema」只能靠人读字面量，守卫等于没有。校验器遇到未实现的关键字**抛错**，所以 schema 将来用了新关键字会当场红。解析侧那一半仍由 `judge.test.ts` 的既有用例钉。 |

---

## 文件结构（先定边界，再切任务）

| 文件 | 职责 | 本计划 |
|---|---|---|
| `packages/server/contracts/src/score.ts` | 评分契约的唯一真源：维度、总分合成、送模型的输出契约文本 | 加 schema 字面量与记账字段 |
| `packages/server/contracts/src/score.test.ts` | 契约守卫 | 加 5 条一致性守卫 + 测试用最小校验器 |
| `packages/server/agents/src/types.ts` | agents 包对外类型契约（中性事实） | 加 `outputSchema?` 与 `capability.structuredOutput` |
| `packages/server/agents/src/registry.test.ts` | 注册表守卫 | 加能力声明守卫 + 夹具补字段 |
| `packages/server/agents/src/providers/claude-code/{sdk,index,events}.ts` | cc 方言与消息投影 | 加 `outputFormat` 落点、`structured_output` 出口、重试用尽归因 |
| `packages/server/agents/src/providers/codex/{sdk,index}.ts` | codex 方言 | 窄结构放宽 + 调用点按需带 |
| `packages/server/agents/src/providers/dsh/index.ts` | dsh 方言 | 纵深防御守卫 |
| `packages/server/evaluator/src/judge.ts` | 两条评分通路共用的尺子 | `finalizeScore` 加必填入参 |
| `packages/server/evaluator/src/judge-agent.ts` | 智能体评分通路 | 转发 `outputSchema` + 记账 |
| `packages/server/evaluator/src/orchestrator.ts` | 编排状态机 | 能力判断 + 有痕降级 + 按需带 schema |
| `packages/client/ui/src/composite/score-detail-view.tsx` | 评分详情展示 | 加「输出约束」一格 |

---

### Task 1: contracts —— schema 字面量、记账字段与一致性守卫

**Files:**
- Modify: `packages/server/contracts/src/score.ts`
- Test: `packages/server/contracts/src/score.test.ts`
- Modify（夹具补字段，类型要求）: `packages/server/evaluator/src/testing/fixtures.ts:300-330`、`packages/client/ui/src/composite/score-detail-view.test.tsx:30-40`、`packages/client/ui/src/composite/run-detail-panel.test.tsx:40-45`、`packages/client/ui/src/base/metric-line.test.tsx:20-25`、`packages/client/ui/src/composite/log-format.test.ts:38-45`、`packages/client/ui/src/composite/eval-row-card.test.tsx:260-266`、`packages/server/evaluator/src/judge.test.ts:240-258`

**Interfaces:**
- Consumes: 无（本任务是链条起点）
- Produces: `MIN_SCORE_PER_DIMENSION: 1`、`MAX_SCORE_PER_DIMENSION: 5`（由模块内私有改为导出）、`JUDGE_OUTPUT_JSON_SCHEMA`（`as const` 字面量）、`ScoreResultSchema` 新增 `structuredOutput: z.boolean().default(false)`

- [ ] **Step 1: 写失败用例**

在 `packages/server/contracts/src/score.test.ts` 的 import 列表里补 `JUDGE_OUTPUT_JSON_SCHEMA`、`MAX_SCORE_PER_DIMENSION`、`MIN_SCORE_PER_DIMENSION`（既有 import 保留），在文件末尾追加：

```ts
/**
 * 最小 JSON Schema 校验器（**仅测试用**，只实现本仓 schema 用到的那几个关键字）。
 * 为什么不引三方校验库：本期硬约束是零依赖（spec §2）。它的唯一用途是让
 * 「合格样例过 schema / 越界样例被 schema 拒」成为**可执行**断言，而不是靠人读字面量。
 * 遇到没实现的关键字**必须抛**（不静默放过）：本仓 schema 一旦用了新关键字，这条守卫要当场红。
 */
type JsonSchemaNode = Record<string, unknown>;

const SUPPORTED_KEYWORDS = new Set([
  'type', 'enum', 'minimum', 'maximum', 'minItems', 'maxItems', 'items', 'properties', 'required', 'additionalProperties',
]);

function validateJsonSchema(schema: JsonSchemaNode, value: unknown, path = '$'): string[] {
  for (const keyword of Object.keys(schema)) {
    if (!SUPPORTED_KEYWORDS.has(keyword)) {
      throw new Error(`测试用校验器不支持关键字「${keyword}」：请实现它，或改 schema（不许静默放过）`);
    }
  }
  const errors: string[] = [];
  const type = schema.type;
  const typeOk =
    type === undefined ||
    (type === 'object' && typeof value === 'object' && value !== null && !Array.isArray(value)) ||
    (type === 'array' && Array.isArray(value)) ||
    (type === 'string' && typeof value === 'string') ||
    (type === 'integer' && typeof value === 'number' && Number.isInteger(value));
  if (!typeOk) return [`${path}: 期望 ${String(type)}，实际是 ${JSON.stringify(value)}`];

  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) errors.push(`${path}: 取值不在枚举内`);
  if (typeof schema.minimum === 'number' && typeof value === 'number' && value < schema.minimum) errors.push(`${path}: 小于 minimum`);
  if (typeof schema.maximum === 'number' && typeof value === 'number' && value > schema.maximum) errors.push(`${path}: 大于 maximum`);

  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) errors.push(`${path}: 少于 minItems`);
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) errors.push(`${path}: 多于 maxItems`);
    if (schema.items !== undefined) {
      value.forEach((item, index) => {
        errors.push(...validateJsonSchema(schema.items as JsonSchemaNode, item, `${path}[${index}]`));
      });
    }
  }

  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const properties = (schema.properties ?? {}) as Record<string, JsonSchemaNode>;
    for (const key of (schema.required ?? []) as string[]) {
      if (!(key in record)) errors.push(`${path}.${key}: 缺少必填字段`);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(record)) {
        if (!(key in properties)) errors.push(`${path}.${key}: 不在 properties 里（additionalProperties=false）`);
      }
    }
    for (const [key, child] of Object.entries(properties)) {
      if (key in record) errors.push(...validateJsonSchema(child, record[key], `${path}.${key}`));
    }
  }
  return errors;
}

/** 一份合格样例：5 维齐全、score 合法（多处用例共用，避免各写一份形状） */
function goodJudgeOutput(): Record<string, unknown> {
  return {
    dimensions: DIMENSIONS.map((dimension) => ({
      key: dimension.key, label: dimension.label, score: 3, reason: '还行',
    })),
    totalScore: 60,
    verdict: '一般',
  };
}

describe('JUDGE_OUTPUT_JSON_SCHEMA：结构化输出的单一真源', () => {
  const schema = JUDGE_OUTPUT_JSON_SCHEMA;
  const item = schema.properties.dimensions.items;

  it('维度 key 的枚举与 DIMENSIONS 逐项、按序相等', () => {
    expect([...item.properties.key.enum]).toEqual(DIMENSIONS.map((dimension) => dimension.key));
  });

  it('维度条数上下限就是 DIMENSION_COUNT；score 取值就是导出的两个常量', () => {
    expect(schema.properties.dimensions.minItems).toBe(DIMENSION_COUNT);
    expect(schema.properties.dimensions.maxItems).toBe(DIMENSION_COUNT);
    expect(item.properties.score.minimum).toBe(MIN_SCORE_PER_DIMENSION);
    expect(item.properties.score.maximum).toBe(MAX_SCORE_PER_DIMENSION);
  });

  it('顶层 required 与 properties 同集合，且不允许多余字段', () => {
    expect([...schema.required].sort()).toEqual(Object.keys(schema.properties).sort());
    expect(schema.additionalProperties).toBe(false);
  });

  it('合格样例过 schema；少一维 / key 不认识 / score 越界 / 顶层多字段都被拒', () => {
    const good = goodJudgeOutput();
    expect(validateJsonSchema(schema, good)).toEqual([]);

    const dimensions = good.dimensions as Record<string, unknown>[];
    expect(validateJsonSchema(schema, { ...good, dimensions: dimensions.slice(0, DIMENSION_COUNT - 1) })).not.toEqual([]);
    expect(validateJsonSchema(schema, {
      ...good,
      dimensions: dimensions.map((entry, index) => (index === 0 ? { ...entry, key: 'made_up' } : entry)),
    })).not.toEqual([]);
    expect(validateJsonSchema(schema, {
      ...good,
      dimensions: dimensions.map((entry, index) => (index === 0 ? { ...entry, score: MAX_SCORE_PER_DIMENSION + 1 } : entry)),
    })).not.toEqual([]);
    expect(validateJsonSchema(schema, { ...good, extra: 1 })).not.toEqual([]);
  });

  it('schema 拒绝越界分数（严档）——解析侧的「夹紧」由 evaluator 包自己的用例外钉（spec D7）', () => {
    const dimensions = (goodJudgeOutput().dimensions as Record<string, unknown>[]);
    const outOfRange = {
      ...goodJudgeOutput(),
      dimensions: dimensions.map((entry, index) => (index === 0 ? { ...entry, score: 6 } : entry)),
    };
    expect(validateJsonSchema(schema, outOfRange).join('；')).toContain('大于 maximum');
  });
});

describe('ScoreResultSchema.structuredOutput', () => {
  it('老记录（没有这一格）读盘后补 false', () => {
    const parsed = ScoreResultSchema.parse({
      dimensions: DIMENSIONS.map((dimension) => ({ key: dimension.key, label: dimension.label, score: 3, reason: '还行' })),
      totalScore: 60,
      verdict: '一般',
      raw: '{}',
      judgeProviderId: 'p',
      judgeModelId: 'm',
      judgedAt: '2026-09-01T00:00:00.000Z',
    });
    expect(parsed.structuredOutput).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @aieval/contracts test -- score.test`
Expected: FAIL —— `JUDGE_OUTPUT_JSON_SCHEMA is not exported`（或 `undefined` 上的属性读取抛错），以及 `structuredOutput` 为 `undefined`。

- [ ] **Step 3: 实现契约**

`packages/server/contracts/src/score.ts` 三处改动。

① 把单维分值常量改为导出（原 `const MAX_SCORE_PER_DIMENSION = 5;`）：

```ts
/** 单维分数下限（与 `DimensionScoreSchema.score` 的 `min(1)` 同一条口径；导出供 JSON Schema 复用） */
export const MIN_SCORE_PER_DIMENSION = 1;
/** 单维满分（spec §7.3；导出供 JSON Schema 复用，避免两处魔数漂移） */
export const MAX_SCORE_PER_DIMENSION = 5;
```

② `ScoreResultSchema` 在 `judgeAgentKind` 之后加一格：

```ts
  /**
   * 这一分是不是在 **schema 约束**下拿到的（false = 只靠提示词契约）。
   * 为什么必须记：dsh 没有这个入口、文本通路本期也没开（spec §2），于是同一次评测里
   * 「被约束的候选」与「没被约束的候选」会同时存在——不记下来，两者的分数就被当成同一口径比较。
   * ⚠️ 它记的是**我们传了 schema**，不是「上游认了」（网关可能把这格丢掉，见 spec §9 第 1 条）。
   * `.default(false)` 同 `judgeAgentKind`：磁盘上已有的评分记录要能读回。
   */
  structuredOutput: z.boolean().default(false),
```

③ 在 `JUDGE_OUTPUT_CONTRACT` **之前**插入 schema 字面量：

```ts
/**
 * 评分输出的 JSON Schema（结构化输出用）：给 claude-code 的 `outputFormat` 与 codex 的 `outputSchema` 用。
 * 五条口径：
 *   1. **只用可移植子集**（spec D9）：不出现 `oneOf` / `const` / `prefixItems` / `uniqueItems`——
 *      写进去的每一格都要在两家 CLI 上分别真机验证；
 *   2. **与 `JUDGE_OUTPUT_CONTRACT` 同形**（spec D5）：三个顶层字段一个不少。**改一份必须同批改另一份**
 *      ——两份契约指向不同形状，正是本设计要消灭的那类漂移；
 *   3. 维度 key 的枚举**由 `DIMENSIONS` 求值**（不是手抄 5 个字符串）——手抄就会在加维度时漏改；
 *   4. 它**不是判据**（spec D6）：合格与否仍由 `collectJudgeDimensions` 判，这里只是请求侧约束；
 *   5. `score` 取**严档**（1–5）：能在上游阻止「6 分」这种输出，就不该先让它生成、再在解析侧悄悄夹成 5。
 *      代价是两条通路在「越界」这一格上表现不同（spec §9 第 2 条，已登记）。
 */
export const JUDGE_OUTPUT_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['dimensions', 'totalScore', 'verdict'],
  properties: {
    dimensions: {
      type: 'array',
      minItems: DIMENSION_COUNT,
      maxItems: DIMENSION_COUNT,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['key', 'label', 'score', 'reason'],
        properties: {
          key: { type: 'string', enum: DIMENSIONS.map((dimension) => dimension.key) },
          label: { type: 'string' },
          score: { type: 'integer', minimum: MIN_SCORE_PER_DIMENSION, maximum: MAX_SCORE_PER_DIMENSION },
          reason: { type: 'string' },
        },
      },
    },
    totalScore: { type: 'integer', minimum: 0, maximum: 100 },
    verdict: { type: 'string' },
  },
} as const;
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @aieval/contracts test -- score.test`
Expected: PASS（既有用例全绿 + 新增 6 条绿）

- [ ] **Step 5: 补全仓夹具（`structuredOutput` 是必填输出字段）**

Run: `pnpm typecheck`
Expected: 报错清单 = 所有字面量构造 `ScoreResult` 的地方。逐个补齐（**只补字段，不改断言**）：

- `packages/server/evaluator/src/testing/fixtures.ts`：`makeScoreFixture` 的返回对象加 `structuredOutput: input.structuredOutput ?? false`，入参类型加 `structuredOutput?: boolean`（照该文件既有的可选入参写法）
- `packages/server/evaluator/src/judge.test.ts`、`packages/client/ui/src/composite/{score-detail-view,run-detail-panel}.test.tsx`、`packages/client/ui/src/base/metric-line.test.tsx`、`packages/client/ui/src/composite/{log-format.test.ts,eval-row-card.test.tsx}` 的评分夹具各加 `structuredOutput: false`

再跑一次 `pnpm typecheck`，Expected: 全绿（漏一个文件就会红，**不许**用 `as` 断言绕过）。

- [ ] **Step 6: 变异验证（两条）**

- 把 `JUDGE_OUTPUT_JSON_SCHEMA.properties.dimensions.items.properties.key.enum` 删掉一维 → `pnpm --filter @aieval/contracts test -- score.test` 必须红在「枚举与 DIMENSIONS 逐项相等」；复原。
- 把 `structuredOutput: z.boolean().default(false)` 的 `.default(false)` 去掉 → 老记录那条用例必须红；复原。

复原后核对文件哈希未变（`Get-FileHash`），把两条记录写进任务报告。

- [ ] **Step 7: 提交**

```bash
git add packages/server/contracts/src/score.ts packages/server/contracts/src/score.test.ts packages/server/evaluator/src/testing/fixtures.ts packages/server/evaluator/src/judge.test.ts packages/client/ui/src/composite/score-detail-view.test.tsx packages/client/ui/src/composite/run-detail-panel.test.tsx packages/client/ui/src/base/metric-line.test.tsx packages/client/ui/src/composite/log-format.test.ts packages/client/ui/src/composite/eval-row-card.test.tsx
git commit -m "feat(contracts): 评分输出的 JSON Schema 与 structuredOutput 记账（零依赖字面量 + 一致性守卫）"
```

---

### Task 2: agents —— `outputSchema` 入参、能力声明与三家声明

**Files:**
- Modify: `packages/server/agents/src/types.ts`
- Modify: `packages/server/agents/src/providers/claude-code/index.ts:218`、`packages/server/agents/src/providers/codex/index.ts:120`、`packages/server/agents/src/providers/dsh/index.ts:179-187`
- Test: `packages/server/agents/src/registry.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `JUDGE_OUTPUT_JSON_SCHEMA`（本任务不 import 它——agents 只收中性 `Record<string, unknown>`）
- Produces: `AgentRunInput.outputSchema?: Record<string, unknown>`；`AgentProviderMetadata.capability.structuredOutput: boolean`（**必填**）

- [ ] **Step 1: 写失败用例**

在 `packages/server/agents/src/registry.test.ts` 的文件级夹具（第 26/33/42 行那三处 `capability: { … }`）各补 `structuredOutput: false`，然后在既有 `liveUsage` 守卫附近追加：

```ts
  it('每家都显式声明 structuredOutput（能力只有一个查询点，不许靠默认值）', () => {
    for (const provider of listAgentProviders()) {
      // 类型上它是必填（spec D3）；这一条是运行期复核——夹具/provider 走 any 或断言时仍会红
      expect(typeof provider.metadata.capability.structuredOutput, `${provider.kind} 的 structuredOutput`).toBe('boolean');
    }
  });

  it('支持结构化输出的只有 claude-code 与 codex（dsh 的 SDK 客户端没有这一格）', () => {
    const supported = listAgentProviders()
      .filter((provider) => provider.metadata.capability.structuredOutput)
      .map((provider) => provider.kind)
      .sort();
    expect(supported).toEqual(['claude-code', 'codex']);
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @aieval/agents test -- registry.test`
Expected: FAIL —— `structuredOutput` 为 `undefined`（第一条 `typeof` 报 `'undefined'`）。

- [ ] **Step 3: 实现类型与三家声明**

`packages/server/agents/src/types.ts`：

① `AgentRunInput` 在 `onEvent` **之前**加一格：

```ts
  /**
   * 要求模型**按这份 JSON Schema 生成**最终答复（可选）。缺省 = 不约束，行为与今天逐字相同。
   * 为什么是中性事实（spec D2）：翻译成 claude 的 `outputFormat` 还是 codex 的 `outputSchema`
   * 是适配器的事；契约里出现某一家 CLI 的语法，等于让跨端契约知道厂商方言。
   * **不支持的适配器必须报错**（spec D11）：悄悄忽略会让调用方以为「已经强约束」，而实际什么都没发生。
   */
  outputSchema?: Record<string, unknown>;
```

② `AgentProviderMetadata.capability` 在 `liveUsage` 之后加：

```ts
    /**
     * 该适配器能不能把 `AgentRunInput.outputSchema` 落到实处（**必填**，spec D3）。
     * 为什么必填而不是「可选 + 守卫」：可选会被默认成 false 而无人验证；`cancelMidTurn` / `usage`
     * 已经是必填，这里保持 `capability` 内部同一形状。
     * `false` 的处置在编排层：不发 schema，但**发一条行日志**说明降级（spec D4）。
     */
    structuredOutput: boolean;
```

③ 三家 metadata（**值的唯一真源就在这里**，spec §5.2 的表就是它）：

- `providers/claude-code/index.ts:218` → `capability: { cancelMidTurn: true, usage: true, liveUsage: 'estimated', structuredOutput: true },`
- `providers/codex/index.ts:120` → `capability: { cancelMidTurn: true, usage: true, liveUsage: 'reported', structuredOutput: true },`
- `providers/dsh/index.ts:179` 的 `capability: { … }` 块内加：

```ts
      // SDK 客户端没有 schema 入参（`DeepSeekHarnessOptions` 只有 cwd/provider/model/reasoningEffort/
      // maxTokens，argv 只有 --profile/--patch）⇒ 顶层会话拿不到结构化输出。降级由编排层留痕（spec D4）。
      structuredOutput: false,
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @aieval/agents test -- registry.test`
Expected: PASS

- [ ] **Step 5: 变异验证**

把 dsh 的 `structuredOutput: false` 删掉 → `pnpm typecheck` 必须红（必填字段缺失）；`pnpm --filter @aieval/agents test -- registry.test` 在夹具绕开类型时也必须红。复原并核对哈希。

- [ ] **Step 6: 提交**

```bash
git add packages/server/agents/src/types.ts packages/server/agents/src/registry.test.ts packages/server/agents/src/providers/claude-code/index.ts packages/server/agents/src/providers/codex/index.ts packages/server/agents/src/providers/dsh/index.ts
git commit -m "feat(agents): 中性 outputSchema 入参与 capability.structuredOutput（三家显式声明）"
```

---

### Task 3: claude-code —— `outputFormat` 落点、`structured_output` 出口、重试用尽归因

**Files:**
- Modify: `packages/server/agents/src/providers/claude-code/sdk.ts:25-61`（`ClaudeQueryOptions`）
- Modify: `packages/server/agents/src/providers/claude-code/index.ts:79-93`（调用点）
- Modify: `packages/server/agents/src/providers/claude-code/events.ts:72-107`（`projectResult`）
- Test: `packages/server/agents/src/providers/claude-code/index.test.ts`、`packages/server/agents/src/providers/claude-code/events.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `AgentRunInput.outputSchema?`
- Produces: 无新导出（窄结构内部变化）；行为契约：`finalText` 在 `structured_output` 存在时是它的 `JSON.stringify`

- [ ] **Step 1: 写失败用例（events：出口优先级）**

在 `packages/server/agents/src/providers/claude-code/events.test.ts` 末尾追加（照该文件既有的 `projectClaudeMessage(raw, state, context)` 桩法建 `state`）：

```ts
describe('projectClaudeMessage：结构化输出的最终答复出口', () => {
  it('structured_output 存在 ⇒ finalText 是它的序列化（即使 result 是空串）', () => {
    const state = newState();
    const raw = { type: 'result', subtype: 'success', result: '', structured_output: { verdict: '还行' } };
    projectClaudeMessage(raw, state, CONTEXT);
    expect(state.finalText).toBe('{"verdict":"还行"}');
  });

  it('两个来源同时存在且内容不同 ⇒ 落一条 WARN，且以 structured_output 为准', () => {
    const state = newState();
    const raw = {
      type: 'result', result: '我给了个散文',
      structured_output: { dimensions: [], totalScore: 0, verdict: '还行' },
    };
    const projection = projectClaudeMessage(raw, state, CONTEXT);
    expect(state.finalText).toBe('{"dimensions":[],"totalScore":0,"verdict":"还行"}');
    expect(projection.drafts.some((draft) => draft.type === 'log' && draft.text.includes('[WARN]'))).toBe(true);
  });

  it('没有 structured_output ⇒ 仍取 result（既有路径逐字不变）', () => {
    const state = newState();
    projectClaudeMessage({ type: 'result', result: '{"verdict":"还行"}' }, state, CONTEXT);
    expect(state.finalText).toBe('{"verdict":"还行"}');
  });
});
```

（`newState()` 与 `CONTEXT` 是该文件既有的顶层夹具，见 `events.test.ts:10-20`；直接用，别新造一套。）

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @aieval/agents test -- providers/claude-code/events.test`
Expected: FAIL —— 第一条 `finalText` 是 `null`（空串不写），第二条 `finalText` 是 `'我给了个散文'` 且没有 WARN。

- [ ] **Step 3: 实现 events 出口**

`packages/server/agents/src/providers/claude-code/events.ts` 的 `projectResult`，把原来那段「取 `result` 文本 → 写 `state.finalText`」换成：

```ts
  const text = readString(message, 'result');
  if (text !== null && text !== '') {
    drafts.push(logDraft('stdout', text));
  }
  // 最终答复：**结构化输出优先**——`structured_output` 是 CLI 按 schema 校验过的产出，而结构化那一轮
  // 可能以 tool_result 载体收尾、没有尾随 assistant 消息（sdk.d.ts:2054-2065），`result` 因此可能为空。
  // 两个来源**同时存在且内容不同**时落一条 WARN（与 num_turns 不一致那条同一处置：
  // 同一件事有两个来源，我们不静默挑一个）；只有一个来源或两者一致时不发任何东西（不制造噪声）。
  // 本函数仍是纯函数：出口选择只改 state 与 drafts，不引 logger（投影必须可断言）。
  const structured = message?.structured_output;
  if (structured !== undefined) {
    const serialized = safeStringify(structured);
    if (text !== null && text !== '' && text !== serialized) {
      drafts.push(
        logDraft(
          'stderr',
          '[WARN] claude-code 的 structured_output 与 result 文本不一致；本行的最终答复以 structured_output 为准'
            + '（结构化输出是 CLI 按 schema 校验过的产出）',
        ),
      );
    }
    state.finalText = serialized;
  } else if (text !== null && text !== '') {
    state.finalText = text; // 既有路径，一个字不改
  }
```

同时把该文件头注的「3. 计量只在 result 消息上取」一节后面补一条：「4. 最终答复优先取 `structured_output`（结构化输出），缺失才回落到 `result` 文本」。

- [ ] **Step 4: 跑 events 测试确认通过**

Run: `pnpm --filter @aieval/agents test -- providers/claude-code/events.test`
Expected: PASS

- [ ] **Step 5: 写失败用例（events：重试用尽的中文归因）**

```ts
  it('subtype=error_max_structured_output_retries ⇒ 中文归因，不是把 CLI 的英文 subtype 冒到界面', () => {
    const state = newState();
    const projection = projectClaudeMessage(
      { type: 'result', subtype: 'error_max_structured_output_retries', is_error: true, result: '' },
      state,
      CONTEXT,
    );
    expect(projection.failure?.code).toBe('AGENT_FAILED');
    expect(projection.failure?.message).toContain('结构化输出');
    expect(projection.failure?.message).not.toContain('error_max_structured_output_retries');
  });
```

- [ ] **Step 6: 实现归因**

`projectResult` 里、`is_error` 的通用分支**之前**插入：

```ts
  // 结构化输出重试用尽：这是**评分通路**才会遇到的收场（候选阶段不传 schema）。CLI 的 subtype 是英文，
  // 直接冒到界面等于让使用者去猜；这里折成一句能直接展示的中文，并保留 subtype 供排障。
  if (message?.is_error === true && readString(message, 'subtype') === 'error_max_structured_output_retries') {
    const friendly =
      'claude-code 的结构化输出重试用尽：模型在多次重试内没有给出符合评分 schema 的 JSON。'
      + '请检查用例的评分提示词，或把评分智能体换成另一家（subtype: error_max_structured_output_retries）';
    drafts.push({ type: 'error', message: friendly });
    return { drafts, tokens, turns, failure: { code: 'AGENT_FAILED', message: friendly } };
  }
```

- [ ] **Step 7: 写失败用例（index：厂商选项落点）**

在 `packages/server/agents/src/providers/claude-code/index.test.ts` 里追加两条（该文件已 import `createRecorder` / `createFakeClaudeSdk` / `createRunInput` / `setAgentRuntimeForTesting` / `CLAUDE_PACKAGE_NAME`，直接用）：

```ts
  it('给了 outputSchema ⇒ options.outputFormat 是 json_schema 且 schema 原样带上', async () => {
    const recorder = createRecorder();
    setAgentRuntimeForTesting({ sdkModule: { [CLAUDE_PACKAGE_NAME]: createFakeClaudeSdk({ recorder, events: [] }) } });
    const schema = { type: 'object', properties: { verdict: { type: 'string' } } };

    await claudeCodeProvider.run(createRunInput({ outputSchema: schema }));

    expect(recorder.options?.outputFormat).toEqual({ type: 'json_schema', schema });
  });

  it('没给 outputSchema ⇒ options 里没有 outputFormat 这个键（候选阶段与文本评分逐字不变）', async () => {
    const recorder = createRecorder();
    setAgentRuntimeForTesting({ sdkModule: { [CLAUDE_PACKAGE_NAME]: createFakeClaudeSdk({ recorder, events: [] }) } });

    await claudeCodeProvider.run(createRunInput());

    const options = recorder.options;
    expect(options !== null && 'outputFormat' in options).toBe(false);
  });
```

- [ ] **Step 8: 跑测试确认失败**

Run: `pnpm --filter @aieval/agents test -- providers/claude-code/index.test`
Expected: FAIL —— `options.outputFormat` 是 `undefined`。

- [ ] **Step 9: 实现窄结构与调用点**

`sdk.ts` 的 `ClaudeQueryOptions` 在 `permissionMode` 之后加：

```ts
  /**
   * 结构化输出（`sdk.d.ts:1905-1917` 的 `Options.outputFormat` / `JsonSchemaOutputFormat`）。
   * 不给 ⇒ 与今天逐字相同；给了 ⇒ CLI 负责让模型按 schema 生成，并在形状不符时**自己重问**
   * （用尽后以 `error_max_structured_output_retries` 收场，见 `events.ts` 的中文归因）。
   * ⚠️ 这一格**不是**权限项：它不影响能不能写工作区，故不进 `permission.ts` 那张表。
   */
  outputFormat?: { type: 'json_schema'; schema: Record<string, unknown> };
```

`index.ts:79-93` 的 `sdk.query({ options: { … } })` 里，在 `...permission` 之后加：

```ts
      // 结构化输出按需带（`undefined` 时**一个字段都不加**：候选阶段与文本评分的行为逐字不变）
      ...(input.outputSchema === undefined
        ? {}
        : { outputFormat: { type: 'json_schema' as const, schema: input.outputSchema } }),
```

- [ ] **Step 10: 跑测试确认通过 + 包门禁**

Run: `pnpm --filter @aieval/agents test -- providers/claude-code`
Expected: PASS
Run: `pnpm typecheck`
Expected: 全绿

- [ ] **Step 11: 变异验证（两条）**

- 把 `projectResult` 里的优先级反过来（先看 `text`）→ events 第 1、2 条必须红；复原。
- 把 `index.ts` 的 `outputFormat` 展开删掉 → index 第 1 条必须红；复原。

核对哈希后把记录写进任务报告。

- [ ] **Step 12: 提交**

```bash
git add packages/server/agents/src/providers/claude-code/sdk.ts packages/server/agents/src/providers/claude-code/index.ts packages/server/agents/src/providers/claude-code/events.ts packages/server/agents/src/providers/claude-code/index.test.ts packages/server/agents/src/providers/claude-code/events.test.ts
git commit -m "feat(agents): claude-code 结构化输出——outputFormat 落点、structured_output 出口与重试用尽归因"
```

---

### Task 4: codex —— `outputSchema` 落点

**Files:**
- Modify: `packages/server/agents/src/providers/codex/sdk.ts:81-83`（`CodexThread.runStreamed` 窄结构）
- Modify: `packages/server/agents/src/providers/codex/index.ts:62`（调用点）
- Test: `packages/server/agents/src/providers/codex/index.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `AgentRunInput.outputSchema?`
- Produces: 无新导出；行为契约：`outputSchema` 原样进 `runStreamed` 的第二参

- [ ] **Step 1: 写失败用例**

**先给夹具补一格观测量**（现在 codex 假 SDK 的 `runStreamed` **不记录**第二参，不改就无从断言）：

- `packages/server/agents/src/testing/agent-fixtures.ts:14-41` 的 `FakeVendorRecorder` 加一格：

```ts
  /** codex 夹具：`runStreamed(prompt, turnOptions)` 的第二参（结构化输出与中止信号的断言对象） */
  turnOptions: { signal: AbortSignal; outputSchema?: Record<string, unknown> } | null;
```

- `createRecorder()`（同文件 `:43-55`）补 `turnOptions: null,`
- `createFakeCodexSdk` 里的 `runStreamed`（同文件 `:355`）在 `recorder.prompt = prompt;` 之后补 `recorder.turnOptions = runOptions;`，并把它的形参类型放宽成 `{ signal: AbortSignal; outputSchema?: Record<string, unknown> }`

然后在 `packages/server/agents/src/providers/codex/index.test.ts` 追加两条（该文件已 import `createRecorder` / `createFakeCodexSdk` / `createRunInput` / `setAgentRuntimeForTesting` / `CODEX_PACKAGE_NAME` / `codexProvider`）：

```ts
  it('给了 outputSchema ⇒ runStreamed 第二参带上它', async () => {
    const recorder = createRecorder();
    setAgentRuntimeForTesting({ sdkModule: { [CODEX_PACKAGE_NAME]: createFakeCodexSdk({ recorder, events: [] }) } });
    const schema = { type: 'object', properties: { verdict: { type: 'string' } } };

    await codexProvider.run(createRunInput({ outputSchema: schema }));

    expect(recorder.turnOptions?.outputSchema).toEqual(schema);
  });

  it('没给 outputSchema ⇒ 第二参里没有这个键（候选阶段与文本评分逐字不变）', async () => {
    const recorder = createRecorder();
    setAgentRuntimeForTesting({ sdkModule: { [CODEX_PACKAGE_NAME]: createFakeCodexSdk({ recorder, events: [] }) } });

    await codexProvider.run(createRunInput());

    const turnOptions = recorder.turnOptions;
    expect(turnOptions !== null && 'outputSchema' in turnOptions).toBe(false);
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @aieval/agents test -- providers/codex/index.test`
Expected: FAIL —— `outputSchema` 为 `undefined` / 第二参里没有 `outputSchema`。

- [ ] **Step 3: 实现**

`sdk.ts` 把窄结构放宽成与厂商同形（`@openai/codex-sdk` 的 `dist/index.d.ts:169-174`）：

```ts
export interface CodexThread {
  /**
   * `options` 与厂商的 `TurnOptions` 同形：`signal` 之外新增可选的 `outputSchema`
   * （SDK 把它落成 `--output-schema <FILE>`，见该包 README 的 "Structured output"）。
   * 刻意**不**在这里收窄成「只有 signal」：外壳比厂商窄，就等于把厂商的能力关在门外。
   */
  runStreamed: (
    prompt: string,
    options: { signal: AbortSignal; outputSchema?: Record<string, unknown> },
  ) => Promise<CodexRun>;
}
```

`index.ts:62`：

```ts
    const run = await thread.runStreamed(input.prompt, {
      signal: streamAbort.signal,
      // 按需带：`undefined` 时**一个字段都不加**（候选阶段的行为逐字不变）
      ...(input.outputSchema === undefined ? {} : { outputSchema: input.outputSchema }),
    });
```

- [ ] **Step 4: 跑测试确认通过 + 门禁**

Run: `pnpm --filter @aieval/agents test -- providers/codex`
Expected: PASS
Run: `pnpm typecheck`
Expected: 全绿

- [ ] **Step 5: 变异验证**

删掉 `index.ts` 里的 `outputSchema` 展开 → 第 1 条必须红；复原并核对哈希。

- [ ] **Step 6: 提交**

```bash
git add packages/server/agents/src/providers/codex/sdk.ts packages/server/agents/src/providers/codex/index.ts packages/server/agents/src/providers/codex/index.test.ts
git commit -m "feat(agents): codex 结构化输出——runStreamed 按需带 outputSchema"
```

---

### Task 5: dsh —— 纵深防御守卫

**Files:**
- Modify: `packages/server/agents/src/providers/dsh/index.ts:122-153`（`startDsh` 开头）
- Test: `packages/server/agents/src/providers/dsh/index.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `AgentRunInput.outputSchema?`
- Produces: 行为契约：dsh 收到 `outputSchema` ⇒ 抛中文 `Error`，且**不**构造运行时

- [ ] **Step 1: 写失败用例**

在 `packages/server/agents/src/providers/dsh/index.test.ts` 追加（该文件已 import `createRecorder` / `createFakeDshSdk` / `createRunInput` / `setAgentRuntimeForTesting` / `DSH_PACKAGE_NAME` / `dshProvider`）：

```ts
  it('收到 outputSchema ⇒ 抛中文错且不构造运行时（纵深防御：悄悄忽略才是缺陷）', async () => {
    const recorder = createRecorder();
    setAgentRuntimeForTesting({ sdkModule: { [DSH_PACKAGE_NAME]: createFakeDshSdk({ recorder, events: [] }) } });

    const error = await dshProvider
      .run(createRunInput({ outputSchema: { type: 'object' } }))
      .catch((caught: unknown) => caught);

    expect((error as Error).message).toContain('不支持结构化输出');
    // `recorder.options` 是 `new DeepSeekHarness(options)` 的记录点（夹具 `:518`）：null = 构造函数没被调用
    expect(recorder.options).toBeNull();
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @aieval/agents test -- providers/dsh/index.test`
Expected: FAIL —— 没有抛错，运行时装起来了。

- [ ] **Step 3: 实现守卫**

`startDsh` 函数体**第一行**（`const { input } = context;` 之后、`loadDshSdk()` 之前——报错不该顺手把 SDK 也加载了）：

```ts
  // 第二道守卫（第一道在编排层：它按注册表能力决定不传）。dsh 的 SDK 客户端没有结构化输出通道
  // （`DeepSeekHarnessOptions` 没有 schema 格、argv 只有 --profile/--patch），而 `AgentRunInput`
  // 是公开类型、谁都能构造：悄悄忽略这个入参会让调用方以为「已经强约束」，实际什么都没发生。
  if (input.outputSchema !== undefined) {
    throw new Error(
      'deepseek harness 的 SDK 客户端不支持结构化输出（没有 schema 入参）：这一行只能用提示词契约约束返回形状，'
      + '需要 schema 约束请把评分智能体换成 claude-code 或 codex',
    );
  }
```

- [ ] **Step 4: 跑测试确认通过 + 门禁**

Run: `pnpm --filter @aieval/agents test -- providers/dsh`
Expected: PASS
Run: `pnpm typecheck`
Expected: 全绿

- [ ] **Step 5: 变异验证**

删掉守卫 → 那条用例必须红；复原并核对哈希。

- [ ] **Step 6: 提交**

```bash
git add packages/server/agents/src/providers/dsh/index.ts packages/server/agents/src/providers/dsh/index.test.ts
git commit -m "feat(agents): dsh 收到 outputSchema 时明确报错（纵深防御，不静默忽略）"
```

---

### Task 6: evaluator —— 转发、记账与 `finalizeScore` 必填入参

**Files:**
- Modify: `packages/server/evaluator/src/judge.ts:208-246`（`finalizeScore`）、`:437-443`（文本通路调用处）
- Modify: `packages/server/evaluator/src/judge-agent.ts:58-85`（`AgentJudgeInput`）、`:214-220`（收口调用）
- Test: `packages/server/evaluator/src/judge.test.ts`、`packages/server/evaluator/src/judge-agent.test.ts`、`packages/server/evaluator/src/run-store.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `ScoreResult.structuredOutput`、Task 2 的 `AgentRunInput.outputSchema?`
- Produces:
  - `finalizeScore(input: { …; structuredOutput: boolean })`（**必填**）
  - `AgentJudgeInput.outputSchema?: Record<string, unknown>`
  - `judgeRowByAgent` 把 `outputSchema` 原样传给 `provider.run`，并把 `structuredOutput: input.outputSchema !== undefined` 记进 `ScoreResult`

- [ ] **Step 1: 写失败用例（记账 + 转发）**

`packages/server/evaluator/src/judge.test.ts`（沿用该文件 `:233-257` 那条既有用例的 `parsed` 构造，只加 `structuredOutput`）：

```ts
  it('structuredOutput 原样进结果（这只记「我们传了 schema」，不是「上游认了」）', () => {
    const dimensions = DIMENSIONS.map(({ key, label }) => ({ key, label, score: 5, reason: '理由' }));
    const parsed = Object.assign(dimensions, { verdict: '总评' });
    const base = { parsed, raw: '{}', judgeProviderId: 'p1', judgeModelId: 'm1', judgeAgentKind: null } as const;

    expect(finalizeScore({ ...base, structuredOutput: true }).structuredOutput).toBe(true);
    expect(finalizeScore({ ...base, structuredOutput: false }).structuredOutput).toBe(false);
  });
```

`packages/server/evaluator/src/judge-agent.test.ts`：先给 `callJudge` 加一个可选覆盖参（该文件 `:34-48` 那个工厂函数）：

```ts
/** 一次最小调用；`finalText` 由各用例通过 `fakeAgents.scripts` 设定；`signal` 只在测「已停止」时传 */
function callJudge(
  signal: AbortSignal = new AbortController().signal,
  overrides: Partial<AgentJudgeInput> = {},
): ReturnType<typeof judgeRowByAgent> {
  return judgeRowByAgent({
    kind: 'codex',
    cwd: process.cwd(),
    configHome: process.cwd(),
    route: ROUTE,
    judgeProviderId: 'judge-provider',
    baselineCommit: 'a'.repeat(40),
    judgePrompt: '按 5 个维度打分',
    taskPrompt: '把 README 改成中文',
    dimensions: DIMENSIONS,
    signal,
    onEvent: () => {},
    ...overrides,
  });
}
```

（import 补 `type AgentJudgeInput`；`AgentJudgeInput` 已是 `judge-agent.ts` 的导出。）**再给假适配器补一格记录**：`packages/server/evaluator/src/testing/fixtures.ts:332-360` 的 `FakeAgentCall` 加 `outputSchema?: Record<string, unknown>;`，并在 `:480` 附近与 `permission: input.permission,` 并排补 `outputSchema: input.outputSchema,`。然后追加三条：

```ts
  it('带 outputSchema ⇒ 原样传给适配器，且 ScoreResult 记 structuredOutput=true', async () => {
    const schema = { type: 'object', properties: { verdict: { type: 'string' } } };
    fakeAgents.scripts.set('codex', { finalText: judgeReplyJson(5) });

    const score = await callJudge(new AbortController().signal, { outputSchema: schema });

    expect(fakeAgents.calls[0]?.outputSchema).toEqual(schema);
    expect(score.structuredOutput).toBe(true);
  });

  it('不带 outputSchema ⇒ 不传该格，记 structuredOutput=false（dsh 与文本通路今天的口径）', async () => {
    fakeAgents.scripts.set('codex', { finalText: judgeReplyJson(5) });

    const score = await callJudge();

    expect(fakeAgents.calls[0]?.outputSchema).toBeUndefined();
    expect(score.structuredOutput).toBe(false);
  });

  /**
   * 网关把 schema 那一格丢掉时的形状：模型照旧回散文。判据必须是 JUDGE_PARSE_FAILED（答错了），
   * **不是** INTERNAL（我们自己坏了）——「没问到」与「答错了」在界面上长得一样是既有 spec 明禁的。
   */
  it('模型回了散文（网关没透传 schema）⇒ 仍是 JUDGE_PARSE_FAILED，不是 INTERNAL', async () => {
    fakeAgents.scripts.set('codex', { finalText: '我觉得这个实现还不错' });

    const error = await callJudge(new AbortController().signal, { outputSchema: { type: 'object' } })
      .catch((caught: unknown) => caught);

    expect((error as ServiceError).code).toBe('JUDGE_PARSE_FAILED');
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @aieval/evaluator test -- judge.test judge-agent.test`
Expected: FAIL —— `structuredOutput` 为 `undefined`；`provider.run` 收到的入参里没有 `outputSchema`。

- [ ] **Step 3: 实现 judge.ts**

`finalizeScore` 的入参加一格（注释说明为什么必填）：

```ts
  /**
   * 这一分是不是在 schema 约束下拿到的（**必填**）。
   * 为什么必填：两个调用点（文本通路 / 智能体通路）各自表一次态，而不是吃一个「谁也没选过」的默认值
   * ——与 `AgentRunInput.permission` 必填同一条口径。文本通路本期没开，传 `false`。
   */
  structuredOutput: boolean;
```

返回对象里加 `structuredOutput: input.structuredOutput,`（放在 `judgeAgentKind` 之后）。

`judgeRow` 的收口调用（约 `:437-443`）加 `structuredOutput: false,`，并在该行补一句注释：`// 文本通路本期不开 schema（spec §2 非目标）：它有自己的回问机制`。

- [ ] **Step 4: 实现 judge-agent.ts**

`AgentJudgeInput` 加：

```ts
  /**
   * 结构化输出：由**编排层**按注册表能力决定给不给（`capability.structuredOutput`，spec D4）。
   * 本模块只转发与记账，不做能力判断——「谁知道能力、谁决定」只有一个答案，写在编排层。
   */
  outputSchema?: Record<string, unknown>;
```

`provider.run({ … })` 的入参加：

```ts
      // 按需带：`undefined` 时适配器一个字段都不加（三家各自的守卫见 spec §5）
      ...(input.outputSchema === undefined ? {} : { outputSchema: input.outputSchema }),
```

`finalizeScore({ … })` 的入参加：

```ts
    // 记账口径：记「我们传了 schema」，不假装知道上游有没有照做（spec §9 第 1 条）
    structuredOutput: input.outputSchema !== undefined,
```

- [ ] **Step 5: 写失败用例（老快照读盘）**

`packages/server/evaluator/src/run-store.test.ts`（`getRun` 是读入口，见 `run-store.ts:145`；照同文件既有的「直接写盘」用例，**绕过 `saveRun`** 才能真正模拟磁盘上的老文件）：

```ts
  it('磁盘上已有的评分（score 里没有 structuredOutput）读盘后是 false', () => {
    const run = makeRun({ id: 'run-legacy-score', caseId: 'case-1' });
    const dir = join(run.workspaceBase, run.id);
    mkdirSync(dir, { recursive: true });
    const legacy = structuredClone(run);
    // 老快照的形状：那一行已经有分，但 score 里**没有** structuredOutput 这一格
    for (const row of legacy.rows) {
      if (row.score !== null) delete (row.score as { structuredOutput?: boolean }).structuredOutput;
    }
    writeFileSync(join(dir, 'run.json'), JSON.stringify(legacy), 'utf8');

    const loaded = getRun(run.id);

    expect(loaded.rows[0]?.score?.structuredOutput).toBe(false);
  });
```

（`makeRun` / `join` / `mkdirSync` / `writeFileSync` / `getRun` 都在该文件既有 import 与夹具里；若 `getRun` 要求 `run.json` 之外还有别的文件，照同文件里已有的直接写盘用例补齐。）

- [ ] **Step 6: 跑测试确认通过 + 门禁**

Run: `pnpm --filter @aieval/evaluator test -- judge.test judge-agent.test run-store.test`
Expected: PASS
Run: `pnpm typecheck`
Expected: 全绿（`finalizeScore` 必填后，漏传的调用点会红——这正是必填的目的）

- [ ] **Step 7: 变异验证（两条）**

- `judge-agent.ts` 的 `structuredOutput: input.outputSchema !== undefined` 改成写死 `false` → 带 schema 那条必须红；复原。
- `judge.ts` 文本通路传 `true` → 文本通路的 `structuredOutput === false` 断言（既有用例或新增一条）必须红；复原。

- [ ] **Step 8: 提交**

```bash
git add packages/server/evaluator/src/judge.ts packages/server/evaluator/src/judge-agent.ts packages/server/evaluator/src/judge.test.ts packages/server/evaluator/src/judge-agent.test.ts packages/server/evaluator/src/run-store.test.ts
git commit -m "feat(evaluator): 评分通路转发 outputSchema 并记账 structuredOutput（finalizeScore 必填）"
```

---

### Task 7: 编排层 —— 能力判断、有痕降级与按需带 schema

**Files:**
- Modify: `packages/server/evaluator/src/orchestrator.ts:416-441`（`runJudgeStage` 的智能体分支）
- Test: `packages/server/evaluator/src/orchestrator-judge-route.test.ts`（智能体评分通路的既有用例所在文件）

**Interfaces:**
- Consumes: Task 2 的 `capability.structuredOutput`、Task 1 的 `JUDGE_OUTPUT_JSON_SCHEMA`、Task 6 的 `AgentJudgeInput.outputSchema?`
- Produces: 行为契约——支持的家：无降级日志、`score.structuredOutput === true`；不支持的家：**该行事件日志有一条降级说明**、`score.structuredOutput === false`

- [ ] **Step 1: 写失败用例**

在 `orchestrator-judge-route.test.ts` 的 `describe('runRow：评分通路（开关决定谁去驱动那把尺子）')` 里追加两条（该文件已 import `runRow` / `readEvents` / `rowEventsFile` / `getRun` / `seedRunnableRun` / `fakeAgents` / `judgeReplyJson`，夹具写法照 `:114-143` 那条既有用例）：

```ts
  it('评分智能体支持结构化输出 ⇒ 没有降级日志，且这一分记 structuredOutput=true', async () => {
    const { run } = seedRunnableRun({ rowCount: 1, executionMode: 'parallel', useAgentJudge: true, judgeAgentKind: 'claude-code' });
    const rowId = run.rows[0]?.id ?? '';
    fakeAgents.scripts.set('claude-code', { finalText: judgeReplyJson(5) });

    await runRow(run.id, rowId);

    expect(getRun(run.id).rows[0]?.score?.structuredOutput).toBe(true);
    const events = readEvents(rowEventsFile(run.workspaceBase, run.id, rowId));
    expect(events.some((event) => event.type === 'log' && event.text.includes('不支持结构化输出'))).toBe(false);
  });

  it('评分智能体不支持（dsh）⇒ 一条降级日志，且这一分记 structuredOutput=false', async () => {
    // 候选仍是 codex/openai；`judgeAgentKind: 'dsh'` 会把评分模型接上一条 anthropic 供应商（dsh 只吃它）
    const { run } = seedRunnableRun({ rowCount: 1, executionMode: 'parallel', useAgentJudge: true, judgeAgentKind: 'dsh' });
    const rowId = run.rows[0]?.id ?? '';
    fakeAgents.scripts.set('dsh', { finalText: judgeReplyJson(5) });

    await runRow(run.id, rowId);

    expect(getRun(run.id).rows[0]?.score?.structuredOutput).toBe(false);
    const events = readEvents(rowEventsFile(run.workspaceBase, run.id, rowId));
    expect(events.some((event) => event.type === 'log' && event.text.includes('不支持结构化输出'))).toBe(true);
  });
```

（若 dsh 那一条因假适配器注册表里没有 `dsh` 脚本而跑不起来，就在 `testing/fixtures.ts` 的假适配器注册表里补上它——与既有三家同形；**不要**因此把这条用例降级成只测 claude-code 一处。）

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @aieval/evaluator test -- orchestrator-judge-route`
Expected: FAIL —— 没有降级日志；`score.structuredOutput` 是 `false`（claude-code 那条）。

- [ ] **Step 3: 实现**

`orchestrator.ts` 的 `runJudgeStage`，把 `const kind = requireJudgeAgent(...)` 之后到 `judgeRowByAgent` 之前改成：

```ts
  const kind = requireJudgeAgent({ defaultJudgeAgent: config.settings.defaultJudgeAgent, route });
  // 能力决定带不带 schema。**不支持必须留痕**（spec D4）：降级是允许的，静默降级不是——
  // 同一次评测里「被约束的候选」与「没被约束的候选」会被横向比较，这件事必须能从日志看出来。
  const provider = getProvider(kind);
  const structuredOutput = provider.metadata.capability.structuredOutput;
  if (!structuredOutput) {
    publishRowEvent(ctx.runId, ctx.rowId, {
      type: 'log',
      stream: 'stderr',
      text:
        `[评分] ${provider.displayName} 不支持结构化输出（SDK 没有 schema 入参），`
        + '本行回落到提示词契约：返回形状由结构检查兜底，不合格会落 JUDGE_PARSE_FAILED',
    });
  }
```

并在 `judgeRowByAgent({ … })` 的入参里加：

```ts
        // 只有能力支持时才带（不支持的家拿到它会抛错，见 dsh 适配器的纵深防御）
        ...(structuredOutput ? { outputSchema: JUDGE_OUTPUT_JSON_SCHEMA } : {}),
```

同时把 `JUDGE_OUTPUT_JSON_SCHEMA` 加进该文件从 `@aieval/contracts` 的 import 列表（`getProvider` 已在 `./judge-agent` 那一带 import 过——确认 import 源是 `@aieval/agents`，没有就补）。

- [ ] **Step 4: 跑测试确认通过 + 门禁**

Run: `pnpm --filter @aieval/evaluator test -- orchestrator-judge-route`
Expected: PASS
Run: `pnpm typecheck`
Expected: 全绿

- [ ] **Step 5: 变异验证（两条）**

- 把 `publishRowEvent` 那条降级日志删掉 → dsh 那条用例必须红；复原。
- 把 `structuredOutput` 写死 `false` → claude-code 那条用例必须红；复原。

- [ ] **Step 6: 提交**

```bash
git add packages/server/evaluator/src/orchestrator.ts packages/server/evaluator/src/orchestrator-judge-route.test.ts
git commit -m "feat(evaluator): 编排层按能力带 schema，并对降级发一条行日志"
```

---

### Task 8: 界面 —— 评分详情「输出约束」一格

**Files:**
- Modify: `packages/client/ui/src/composite/score-detail-view.tsx:12-15`（头注）、`:43-49`（评分者一行）
- Test: `packages/client/ui/src/composite/score-detail-view.test.tsx`

**Interfaces:**
- Consumes: Task 1 的 `ScoreResult.structuredOutput`
- Produces: 无导出变化；展示契约——true 显示「schema 约束」，false 显示「提示词约束」

- [ ] **Step 1: 写失败用例**

```tsx
  it('structuredOutput=true ⇒ 显示「输出约束：schema 约束」', () => {
    render(<ScoreDetailView score={fullScore({ structuredOutput: true })} />);
    expect(screen.getByText(/输出约束：schema 约束/)).toBeInTheDocument();
  });

  it('structuredOutput=false ⇒ 显示「提示词约束」（不是错误，只是事实，不给告警样式）', () => {
    render(<ScoreDetailView score={fullScore({ structuredOutput: false })} />);
    expect(screen.getByText(/输出约束：提示词约束/)).toBeInTheDocument();
  });
```

（`fullScore` 是该文件既有的夹具，Task 1 已给它补了 `structuredOutput` 字段；这里只覆盖入参。）

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @aieval/ui test -- score-detail-view`
Expected: FAIL —— 找不到「输出约束」文案。

- [ ] **Step 3: 实现**

`score-detail-view.tsx` 第 43-49 行改成：

```tsx
      <Typography.Text type="secondary">
        {score.judgeAgentKind === null
          ? `评分模型：${score.judgeModelId}`
          : `评分智能体：${AGENT_LABELS[score.judgeAgentKind]} · 模型：${score.judgeModelId}`}
        {' · '}
        {/* 「这一分被约束到什么程度」必须能回答：同一次评测里两种约束强度会同时存在（spec §1 第 3 条）。
            false 不是错误，只是事实（与「文本 API 评分」同一处置），故不给任何告警样式。 */}
        输出约束：{score.structuredOutput ? 'schema 约束' : '提示词约束'}
        {' · '}
        评分时间：{formatDateTime(score.judgedAt)}
      </Typography.Text>
```

头注补第 5 条口径：

```
 *   5. `structuredOutput` 是**这一分的属性**（spec D10）：true = 提交给模型的是 schema 约束，
 *      false = 只有提示词契约（文本通路与 dsh 通路）。它不表示上游一定照做了（spec §9 第 1 条）。
```

- [ ] **Step 4: 跑测试确认通过 + 门禁**

Run: `pnpm --filter @aieval/ui test -- score-detail-view`
Expected: PASS
Run: `pnpm typecheck` / `pnpm lint`
Expected: 全绿

- [ ] **Step 5: 变异验证**

把条件反过来（`score.structuredOutput ? '提示词约束' : 'schema 约束'`）→ 两条用例必须红；复原并核对哈希。

- [ ] **Step 6: 提交**

```bash
git add packages/client/ui/src/composite/score-detail-view.tsx packages/client/ui/src/composite/score-detail-view.test.tsx
git commit -m "feat(ui): 评分详情显示输出约束（schema / 提示词）"
```

---

### Task 9: 全量门禁、文档回写与冒烟待办

**Files:**
- Modify: `docs/superpowers/specs/2026-09-22-scaffold-design.md` §13.2（本线的落点；原过程 spec 已并入该文档并从库中删除）
- Create: `docs/superpowers/notes/2026-09-28-structured-judge-output-progress.md`

**Interfaces:**
- Consumes: Task 1-8 的全部产出
- Produces: 一份可交接的完成记录（含每条的变异验证证据与待人工执行的真机冒烟清单）

- [ ] **Step 1: 跑全量门禁**

```bash
pnpm typecheck
pnpm lint
pnpm test
```

Expected: 三条全绿；`pnpm test` 的用例总数比开工前**多**（把开工前的基线数与结束数都写进记录）。

- [ ] **Step 2: 写完成记录**

新建 `docs/superpowers/notes/2026-09-28-structured-judge-output-progress.md`，内容至少包含：

- 任务清单（Task 1-9）与各自 commit 短哈希；
- **变异验证台账**：每条守卫一行（守卫名 / 怎么制造的缺陷 / 哪条用例红了 / 复原后的文件哈希）；
- 未做与待人工执行：spec §11 的四项真机冒烟（cc 的 `result` vs `structured_output` 形状、网关透传对照、codex 非法 schema 的失败面、页面互证）；
- 已知边界：spec §9 的六条（照抄，不改写）。

- [ ] **Step 3: 回写 spec 状态**

在 spec 的 §11 冒烟计划表上方加一行状态说明：`> 状态（<填写日期>）：Task 1-9 已完成并入库；上表四项**待人工真机执行**，执行后把结论写回 §1.2。`
在 §1.2 标题下加一行：`> 状态：第 1、3 条仍待真机确认（必须用真机结论替换，不许用推断）。`

- [ ] **Step 4: 提交**

```bash
git add docs/superpowers/notes/2026-09-28-structured-judge-output-progress.md docs/superpowers/specs/2026-09-22-scaffold-design.md
git commit -m "docs: 结构化输出实施记录（变异验证台账）与 spec 状态回写"
```

---

## 收口口径（给执行者）

- **不新增依赖**：整个计划的 diff 里 `package.json` 与 `pnpm-lock.yaml` 必须为空（Task 9 Step 1 后用 `git diff --stat HEAD~9 -- package.json pnpm-lock.yaml` 自查，输出空即通过）。
- **既有用例零修改**：`git diff HEAD~9 -- '*test*'` 里除新增断言与夹具补字段外，不允许出现被删改的既有断言。逐条目视核对，把核对结果写进 Task 9 的完成记录。
- **真机冒烟不由 subagent 执行**：需要真实网关与密钥，属于人工步骤（spec §11），实施阶段只登记待办。
