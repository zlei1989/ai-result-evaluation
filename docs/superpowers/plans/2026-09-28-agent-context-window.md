# 模型上下文窗口与思考强度 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 从供应商 `/models` 取到每个模型的上下文窗口与受支持的思考强度档位，存进供应商模型清单，并在创建评测时逐行选强度；三家智能体各自把它翻译成本方言（cc `[1m]` 后缀 / codex `model_context_window` / dsh `settings.yaml`）。

**Architecture:** 分层沿用本仓既有的「事实 → 方言」切法。api 层负责取数与存储（`ProviderModel` 多三格 + 逐字段来源），候选池投影处把上游档位与智能体档位求交；`agents` 的 `AgentRunInput` 只携带中性事实（`contextWindow` / `effort`），三家适配器各自决定怎么写进自己 CLI 的参数。契约只加**可选**字段，磁盘上已有的 `config.json` / `run.json` 无需迁移。

**Tech Stack:** TypeScript 5（strict + noUncheckedIndexedAccess + verbatimModuleSyntax）、zod 3、vitest 4（node / jsdom 双配置）、antd 6 + React 19、SWR 2、Next.js App Router、pnpm workspace。

**Spec:** `docs/superpowers/specs/2026-09-22-scaffold-design.md` §13.5（计划里引用的 D1–D14 已按最终口径并入该节；本线的过程 spec 已删除）

## Global Constraints

- **工作树里有别的会话的在途改动**：开工前与每次提交前都跑 `git status --porcelain`。你只碰本计划列出的文件；`git add` **逐个显式给路径，禁止 `git add -A`**（AGENT.md 硬约束）。实测依据：本计划调研期间 `packages/server/agents/src/types.ts` 被并发改过（`capability.structuredOutput` 是那次加的）。
- **每个任务开工前先重读目标文件**：本计划里的行号是 2026-09-28 的快照，`Interfaces` 段给的是**签名**不是行号——以文件现状为准，签名不一致就停下报告，不要猜。
- **检查顺序**：`pnpm typecheck` → `pnpm lint` → `pnpm test`（三个聚合命令，不要退回 `pnpm -r`）。单包用 `pnpm --filter @aieval/<包名> test -- <关键字>`。
- **每条新守卫都要做变异验证**：把它要拦的缺陷人为造回去，确认守卫**变红**，再还原并核对文件哈希未变。没有见过失败的守卫不算守卫（AGENT.md「约束」）。
- **注释与日志**：中文 JSDoc，先说「做什么」再说「为什么」；日志走 `createLogger(scope)`，上下文作为 `console` 第二参数透传，**不 `JSON.stringify`**。
- **契约新字段一律 `.optional()`**：磁盘上已有的 `config.json` / `run.json` 必须照常能读（`loadConfig` 不做 zod 校验，但 `run.json` 走 `EvalRunSchema.safeParse`，必填新字段会让老评测被 `listRuns()` 静默跳过）。
- **不手写字号、不手调行内边距**；写 UI 前用 context7 查 antd 组件用法（AGENT.md「已知坑」：紧凑密度下显式 `fontSize` 会让实效字号掉到 10px）。
- **`.tsx` 测试只能写在库包**（`packages/client/*`），`apps/web-next` 内不能写（Vite 的 import-analysis 会报 `jsx: preserve`）。
- 纯函数测试文件顶部标 `// @vitest-environment node`。
- **未知就是未知**：任何一格取不到值时，不注入、不兜底、不猜（spec D8 / D13）。

## Review Focus

这五类输入/失败面，spec 没逐条写、但实现时最容易被打崩。每一条都在下面标注了它落在哪个任务的哪一步：

1. **网关用了一个优先级表里没有的字段名**（换供应商就会遇到）：期望窗口显示「未知」、其余功能全部照常，**不抛错、不写 0**。（Task 2 Step 1）
2. **`data` 形状异常**：不是数组 / `[]` / 条目是 `null` / 数字 / `{id: 123}`：期望跳过脏条目、`[]` 时**不落盘**（保留用户既有清单），响应不是合法 JSON 时报中文原因。（Task 2 Step 1、Task 3 Step 1）
3. **窗口字段是脏值**（`'0'` / `-1` / `1.5` / `'abc'` / `null` / `{}`）：期望跳过这一个字段、继续看下一个候选字段，最终未知；**绝不**写进配置一个 0 或负数。（Task 2 Step 1）
4. **上游档位与三家值域完全不相交**（如某网关给了 `perspective`）：期望交集为空 ⇒ 下拉只有「默认」，创建评测**不报错**（因为没传 effort）。（Task 10 Step 1）
5. **模型名里本来就带 `[1m]`**（用户手工把清单里的名字写成 `GLM-5.3[1m]`）或窗口恰好等于阈值：期望**不重复拼接**成 `GLM-5.3[1m][1m]`。（Task 6 Step 1）

---

### Task 1: 契约——`ProviderModel` 带上窗口三格

**Files:**
- Modify: `packages/server/contracts/src/provider.ts:27-31`
- Test: `packages/server/contracts/src/provider.test.ts`

**Interfaces:**
- Consumes: 无（本仓第一个任务）
- Produces: `ProviderModel` 新增可选字段 `contextWindow?: number`、`maxOutputTokens?: number`、`contextWindowSource?: 'fetched' | 'manual'`；`ProviderModelSchema` 同形

- [ ] **Step 1: 写失败的测试**

追加到 `packages/server/contracts/src/provider.test.ts` 的 `describe('ProviderModelSchema')` 里（文件里已有同名的 describe 就并进去）：

```ts
  it('窗口三格全部可选：老形态（只有 id + source）照常解析，缺字段就是未知', () => {
    const parsed = ProviderModelSchema.parse({ id: 'jd/GLM-5.3', source: 'fetched' });
    expect(parsed.contextWindow).toBeUndefined();
    expect(parsed.maxOutputTokens).toBeUndefined();
    expect(parsed.contextWindowSource).toBeUndefined();
  });

  it('窗口与来源往返不丢，且拒绝非正整数的窗口', () => {
    const model = { id: 'm', source: 'fetched' as const, contextWindow: 1_048_576, contextWindowSource: 'manual' as const };
    expect(ProviderModelSchema.parse(model)).toEqual(model);
    // 0 / 负数 / 小数 都不是窗口：契约层就挡下，别让它们流到适配器再被当成「已知」
    expect(ProviderModelSchema.safeParse({ id: 'm', source: 'fetched', contextWindow: 0 }).success).toBe(false);
    expect(ProviderModelSchema.safeParse({ id: 'm', source: 'fetched', contextWindow: -1 }).success).toBe(false);
    expect(ProviderModelSchema.safeParse({ id: 'm', source: 'fetched', contextWindow: 1.5 }).success).toBe(false);
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @aieval/contracts test -- provider`
Expected: FAIL —— `ProviderModelSchema.parse` 会把未知键 **strip 掉**（zod 3 的默认行为），于是 `toEqual(model)` 那条会红（`contextWindow` 不在解析结果里）。

- [ ] **Step 3: 加字段**

`packages/server/contracts/src/provider.ts` 里把 `ProviderModelSchema` 换成：

```ts
/**
 * 模型清单条目：source 区分自动拉取与手工维护（拉取是合并，不能冲掉手工项，见 spec §6.1）。
 *
 * 后三格是「模型能力」，全部可选 —— **缺省 = 未知**，绝不兜底成 0 或某个默认窗口：
 *   · `contextWindow`：上下文窗口（token）。原生 anthropic / openai 的 /models 不带它，
 *     自建网关也未必给（实测 likecode 47 条里 46 条有、gpt-image-2 没有）；
 *   · `maxOutputTokens`：单次输出上限。今天只有 dsh 的目录用得上；
 *   · `contextWindowSource`：**逐字段**来源。'manual' = 用户在设置页改过（或清空过），
 *     拉取不得覆盖。它与条目自身的 `source` 是两件事：fetched 条目一样可以被手工改窗口。
 */
export const ProviderModelSchema = z.object({
  id: z.string().min(1),
  source: z.enum(['fetched', 'manual']),
  contextWindow: z.number().int().positive().optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  contextWindowSource: z.enum(['fetched', 'manual']).optional(),
});
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @aieval/contracts test -- provider`
Expected: PASS

- [ ] **Step 5: 类型与全量检查**

Run: `pnpm typecheck && pnpm lint`
Expected: 两条都干净（这一步会暴露别处对 `ProviderModel` 做**全等比较**的地方——本仓有若干 `toEqual({ id, source })` 形态的断言，若变红，按「实际落盘多了可选字段」更新那些期望，不要改契约）

- [ ] **Step 6: 提交**

```bash
git add packages/server/contracts/src/provider.ts packages/server/contracts/src/provider.test.ts
git commit -m "feat(contracts): ProviderModel 带上窗口与逐字段来源（全部可选，老配置无需迁移）"
```

---

### Task 2: 取数——`extractModels` 解析窗口并落盘

**Files:**
- Modify: `packages/server/api/src/providers.ts`（`extractModelIds` → `extractModels`；`fetchModelIds` 返回类型；`fetchProviderModels` 的合并段）
- Test: `packages/server/api/src/providers.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `ProviderModel.contextWindow` / `maxOutputTokens`
- Produces: 私有 `extractModels(payload: unknown): ExtractedModel[]`（`ExtractedModel = { id: string; contextWindow?: number; maxOutputTokens?: number }`）；`fetchProviderModels` 现在会把窗口写进 `provider.models[]`

- [ ] **Step 1: 写失败的测试**

追加到 `packages/server/api/src/providers.test.ts`（复用文件里既有的 `seedConfig` / `stubUpstream` / `makeProvider` 夹具；`stubUpstream` 的签名以文件现状为准）：

```ts
describe('拉取时解析上下文窗口', () => {
  it('按字段优先级取第一个正整数，并落盘到对应模型条目', async () => {
    const provider = makeProvider(); // 文件里既有的夹具，models 先清空
    seedConfig({ providers: [{ ...provider, models: [] }] });
    // 六个同义字段同时出现（likecode 实测形状）：优先级最高的是 max_input_tokens
    stubUpstream({
      data: [
        { id: 'low', max_input_tokens: 1000, contextWindow: 2000, max_tokens: 7 },
        { id: 'mid', contextWindow: 2_000_000, max_output_tokens: 64 },
        { id: 'nested', limit: { context: 3_000_000, output: 128 } },
        { id: 'caps', capabilities: { contextWindow: 4_000_000 } },
        { id: 'str', context_window: '5000000' },
      ],
    });
    const view = await fetchProviderModels(provider.id);
    const byId = new Map(view.models.map((model) => [model.id, model]));
    expect(byId.get('low')?.contextWindow).toBe(1000);
    expect(byId.get('low')?.maxOutputTokens).toBe(7);
    expect(byId.get('mid')?.contextWindow).toBe(2_000_000);
    expect(byId.get('nested')?.contextWindow).toBe(3_000_000);
    expect(byId.get('nested')?.maxOutputTokens).toBe(128);
    expect(byId.get('caps')?.contextWindow).toBe(4_000_000);
    expect(byId.get('str')?.contextWindow).toBe(5_000_000);
  });

  it('脏值一律跳过并继续看下一个候选字段；全都取不到就是未知（不写 0、不猜）', async () => {
    const provider = makeProvider();
    seedConfig({ providers: [{ ...provider, models: [] }] });
    stubUpstream({
      data: [
        { id: 'dirty', max_input_tokens: 0, contextWindow: -1, context_window: 1.5, context_length: 'abc' },
        { id: 'nullish', max_input_tokens: null, contextWindow: {}, context_window: '' },
        { id: 'unknown-field', context_size: 999 }, // Review Focus #1：换了网关、字段名不在表里
      ],
    });
    const view = await fetchProviderModels(provider.id);
    for (const id of ['dirty', 'nullish', 'unknown-field']) {
      expect(view.models.find((model) => model.id === id)?.contextWindow).toBeUndefined();
    }
  });

  it('脏条目跳过、空清单不落盘（既有口径的回归）', async () => {
    const provider = makeProvider();
    seedConfig({ providers: [{ ...provider, models: [{ id: 'keep', source: 'manual' }] }] });
    stubUpstream({ data: [null, 42, { id: '' }, { id: 'ok', max_input_tokens: 8192 }] });
    const view = await fetchProviderModels(provider.id);
    expect(view.models.map((model) => model.id)).toEqual(['keep', 'ok']);
    expect(view.models.find((model) => model.id === 'ok')?.contextWindow).toBe(8192);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @aieval/api test -- providers`
Expected: FAIL —— `contextWindow` 全是 `undefined`（今天的 `extractModelIds` 只取 id）。

- [ ] **Step 3: 实现取数与落盘**

`packages/server/api/src/providers.ts` 里，把 `extractModelIds` 整段替换为下面三个函数 + 一个类型（JSDoc 保留原有的「为什么容忍两种形态 / 为什么 trim」两条理由，逐字搬进 `extractModels`）：

```ts
/** 一个模型条目：id 必有；窗口与输出上限取不到就是 undefined（未知，不是 0） */
interface ExtractedModel {
  id: string;
  contextWindow?: number;
  maxOutputTokens?: number;
}

/**
 * 窗口 / 输出上限的字段优先级（spec D2）：按顺序取第一个能解析成正整数的。
 * 点号表示嵌套路径 —— 这两组字段实测同时出现在 likecode 的响应里，
 * 只认一个就会在别的网关上瞎；而深遍历会把 top_provider.context_length 这类字段混进来。
 */
const CONTEXT_WINDOW_KEYS = [
  'max_input_tokens',
  'contextWindow',
  'context_window',
  'context_length',
  'limit.context',
  'capabilities.contextWindow',
] as const;

const OUTPUT_TOKENS_KEYS = ['max_tokens', 'max_output_tokens', 'maxTokens', 'maxOutputTokens', 'limit.output'] as const;

/** 按点号路径取值；中途不是对象就返回 undefined（不抛） */
function readPath(entry: unknown, path: string): unknown {
  let cursor: unknown = entry;
  for (const key of path.split('.')) {
    if (typeof cursor !== 'object' || cursor === null) return undefined;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return cursor;
}

/** 正整数才认（接受 '5000000' 这种数字字符串：有网关就是这么给的）；其余一律 undefined */
function positiveInteger(value: unknown): number | undefined {
  if (typeof value !== 'number' && typeof value !== 'string') return undefined;
  if (typeof value === 'string' && value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/** 按优先级取第一个正整数 */
function firstPositive(entry: unknown, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const parsed = positiveInteger(readPath(entry, key));
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

/**
 * 从 /models 响应里抽出模型条目。
 * 三条口径（前两条逐字来自原 extractModelIds 的 JSDoc，第三条是本次新增）：
 *   ① 容忍两种形态（spec §6.1 第 1 点）：`{ data: [{ id }] }` 与 `{ data: ['a'] }`；
 *   ② 判空用 trim，**入库的也是 trim 后的串**（清单的四个入口都按 trim 后的形态比对）；
 *   ③ 窗口取不到就是 undefined —— 绝不兜底成 0 或某个「常见值」（spec D8）。
 */
function extractModels(payload: unknown): ExtractedModel[] {
  if (typeof payload !== 'object' || payload === null) return [];
  const data = (payload as ModelsPayload).data;
  if (!Array.isArray(data)) return [];
  return data.flatMap((entry): ExtractedModel[] => {
    if (typeof entry === 'string') return entry.trim() === '' ? [] : [{ id: entry.trim() }];
    if (typeof entry === 'object' && entry !== null) {
      const id = (entry as { id?: unknown }).id;
      if (typeof id !== 'string' || id.trim() === '') return [];
      const contextWindow = firstPositive(entry, CONTEXT_WINDOW_KEYS);
      const maxOutputTokens = firstPositive(entry, OUTPUT_TOKENS_KEYS);
      return [
        {
          id: id.trim(),
          ...(contextWindow === undefined ? {} : { contextWindow }),
          ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
        },
      ];
    }
    // 既不是字符串、也没有可用的 id（null / 数字 / {}）：跳过。
    // 关键是**不能**兜底成 String(entry)，那会把 'null' / '[object Object]' 当成模型名存进去。
    return [];
  });
}
```

接着：
1. `fetchModelIds` 的返回类型 `Promise<string[]>` → `Promise<ExtractedModel[]>`（两处 `extractModelIds(...)` → `extractModels(...)`）；
2. `fetchProviderModels` 里的 `let ids: string[]` → `let extracted: ExtractedModel[]`，`if (ids.length === 0)` → `if (extracted.length === 0)`，`[...new Set(ids)]` 换成下面的合并段：

```ts
  // 写回用的是**重新读到的最新配置**（既有理由见原注释：跨了两次 await，拿快照整份写回会丢并发改动）
  const fresh = loadConfig();
  const current = requireProvider(fresh, providerId);
  const manual = current.models.filter((model) => model.source === 'manual');
  const manualIds = new Set(manual.map((model) => model.id));
  const byId = new Map(extracted.map((model) => [model.id, model]));
  const fetchedIds = [...byId.keys()].filter((id) => !manualIds.has(id));
  const next: Provider = {
    ...current,
    models: [...manual, ...fetchedIds.map((id) => ({ id, source: 'fetched' as const, ...pickContext(byId.get(id)) }))],
    updatedAt: new Date().toISOString(),
  };
```

并在 `fetchProviderModels` 上方加这个小工具（Task 3 会用到它的第二个参数）：

```ts
/**
 * 只挑「能力」那三格，缺席的键**不写 undefined**（落盘物要干净：`JSON.stringify` 会把 undefined 丢掉，
 * 但内存里的对象留着 `{ contextWindow: undefined }` 会让 `toEqual` 断言与调试输出都变吵）。
 */
function pickContext(source: { contextWindow?: number; maxOutputTokens?: number; contextWindowSource?: 'fetched' | 'manual' } | undefined): {
  contextWindow?: number;
  maxOutputTokens?: number;
  contextWindowSource?: 'fetched' | 'manual';
} {
  if (source === undefined) return {};
  return {
    ...(source.contextWindow === undefined ? {} : { contextWindow: source.contextWindow }),
    ...(source.maxOutputTokens === undefined ? {} : { maxOutputTokens: source.maxOutputTokens }),
    ...(source.contextWindowSource === undefined ? {} : { contextWindowSource: source.contextWindowSource }),
  };
}
```

最后给那条 `模型清单已更新` 的 INFO 日志加一格 `withWindow`：

```ts
  log.info('模型清单已更新', {
    providerId,
    manual: manual.length,
    fetched: fetchedIds.length,
    // 「这次补齐了多少条窗口」在服务端要可观测：用户报「窗口还是未知」时，第一个要看的数就是它
    withWindow: next.models.filter((model) => model.contextWindow !== undefined).length,
  });
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @aieval/api test -- providers`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/server/api/src/providers.ts packages/server/api/src/providers.test.ts
git commit -m "feat(api): 拉取时解析上下文窗口与输出上限并落盘"
```

---

### Task 3: 合并——手工覆盖不被拉取打回，上游没给就清掉

**Files:**
- Modify: `packages/server/api/src/providers.ts`（`fetchProviderModels` 的 fetched 重建分支）
- Test: `packages/server/api/src/providers.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `pickContext` 与合并段
- Produces: 合并规则完整版：`contextWindowSource === 'manual'` 的条目，其窗口三格由 `current` 保留；其余 fetched 条目以上游本次结果为准

- [ ] **Step 1: 写失败的测试**

```ts
describe('窗口的合并规则', () => {
  it('用户手工改过的窗口不被拉取打回（逐字段来源 = manual）', async () => {
    const provider = makeProvider();
    seedConfig({
      providers: [
        {
          ...provider,
          models: [{ id: 'm', source: 'fetched', contextWindow: 123_456, contextWindowSource: 'manual' }],
        },
      ],
    });
    stubUpstream({ data: [{ id: 'm', max_input_tokens: 1_000_000 }] });
    const view = await fetchProviderModels(provider.id);
    const model = view.models.find((item) => item.id === 'm');
    expect(model?.contextWindow).toBe(123_456); // 上游说 1M，用户说 123456 ⇒ 听用户的
    expect(model?.contextWindowSource).toBe('manual');
  });

  it('上游这次没给窗口 ⇒ 窗口三格一起清掉（不保留上一轮的旧值）；manual 条目始终原样保留', async () => {
    const provider = makeProvider();
    seedConfig({
      providers: [
        {
          ...provider,
          models: [
            { id: 'stale', source: 'fetched', contextWindow: 999, contextWindowSource: 'fetched' },
            { id: 'hand', source: 'manual', contextWindow: 2048 },
          ],
        },
      ],
    });
    stubUpstream({ data: [{ id: 'stale' }] });
    const view = await fetchProviderModels(provider.id);
    expect(view.models.find((item) => item.id === 'stale')?.contextWindow).toBeUndefined();
    expect(view.models.find((item) => item.id === 'hand')?.contextWindow).toBe(2048);
  });

  it('用户清空过窗口（manual 且没有值）⇒ 拉取也不会把它填回来', async () => {
    const provider = makeProvider();
    seedConfig({ providers: [{ ...provider, models: [{ id: 'm', source: 'fetched', contextWindowSource: 'manual' }] }] });
    stubUpstream({ data: [{ id: 'm', max_input_tokens: 1_000_000 }] });
    const view = await fetchProviderModels(provider.id);
    expect(view.models.find((item) => item.id === 'm')?.contextWindow).toBeUndefined();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @aieval/api test -- providers`
Expected: FAIL —— 第一条拿到 1_000_000（上游值覆盖了用户值），第三条拿到 1_000_000（被填回来了）。

- [ ] **Step 3: 实现保护**

`fetchProviderModels` 的合并段里，把 fetched 重建那一行换成：

```ts
  const previousById = new Map(current.models.map((model) => [model.id, model]));
  const next: Provider = {
    ...current,
    models: [
      ...manual,
      ...fetchedIds.map((id) => {
        const previous = previousById.get(id);
        // 「用户改过（或清空过）这一格就别动它」——没有这条，用户修好的窗口会在下一次拉取时**静默打回**，
        // 而他以为改生效了（本仓最忌讳的静默丢用户数据，与 manualModels 的注释同一条口径）。
        // 注意只保护窗口那一格：档位（Task 8）没有手工来源，上游给了就以上游为准。
        const keep = previous?.contextWindowSource === 'manual';
        return { id, source: 'fetched' as const, ...pickContext(keep ? previous : byId.get(id)) };
      }),
    ],
    updatedAt: new Date().toISOString(),
  };
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @aieval/api test -- providers`
Expected: PASS

- [ ] **Step 5: 变异验证**

把 `const keep = previous?.contextWindowSource === 'manual'` 改成 `const keep = false`，重跑 Step 4 的命令，确认第一条用例**变红**；还原并 `git hash-object packages/server/api/src/providers.ts` 核对哈希与变异前一致。

- [ ] **Step 6: 提交**

```bash
git add packages/server/api/src/providers.ts packages/server/api/src/providers.test.ts
git commit -m "feat(api): 手工覆盖的窗口不被拉取打回，上游未给则清空"
```

---

### Task 4: 手工维护——`setProviderModelContext` + PATCH 路由

**Files:**
- Modify: `packages/server/contracts/src/provider.ts`（新增入参 schema）、`packages/server/api/src/providers.ts`、`packages/server/api/src/index.ts`（若该 barrel 显式列出口）、`apps/web-next/app/api/providers/[providerId]/models/route.ts`
- Test: `packages/server/api/src/providers.test.ts`、`apps/web-next/src/route-providers.test.ts`（文件名以目录现状为准，没有就新建）

**Interfaces:**
- Consumes: Task 1 的三格、Task 2 的 `pickContext`
- Produces: `ProviderModelContextSchema = z.object({ id: z.string().min(1), contextWindow: z.number().int().positive().nullable(), maxOutputTokens: z.number().int().positive().nullable().optional() })`；`setProviderModelContext(providerId: string, input: ProviderModelContextInput): ProviderView`；`PUT /api/providers/[providerId]/models`

- [ ] **Step 1: 写失败的测试**

`packages/server/api/src/providers.test.ts`：

```ts
describe('设置模型窗口（手工覆盖）', () => {
  it('写入窗口时把来源标成 manual；清空时只清值、来源仍是 manual', () => {
    const provider = makeProvider();
    seedConfig({ providers: [{ ...provider, models: [{ id: 'm', source: 'fetched', contextWindow: 1 }] }] });

    const written = setProviderModelContext(provider.id, { id: 'm', contextWindow: 262_144 });
    expect(written.models[0]).toEqual({ id: 'm', source: 'fetched', contextWindow: 262_144, contextWindowSource: 'manual' });

    const cleared = setProviderModelContext(provider.id, { id: 'm', contextWindow: null });
    expect(cleared.models[0]?.contextWindow).toBeUndefined();
    // 「清空」也是一次明确的表态：来源留着，下一次拉取才不会把上游的值填回来
    expect(cleared.models[0]?.contextWindowSource).toBe('manual');
  });

  it('清单里没有这条模型 ⇒ NOT_FOUND（与删除同口径）', () => {
    const provider = makeProvider();
    seedConfig({ providers: [{ ...provider, models: [{ id: 'm', source: 'fetched' }] }] });
    expect(() => setProviderModelContext(provider.id, { id: 'ghost', contextWindow: 1 })).toThrow(/ghost/);
  });
});
```

`apps/web-next/src/route-providers.test.ts`（照该目录既有 route 测试的写法——`vi.mock('@aieval/api')` + 直接 import 路由的 `PUT`）：

```ts
  it('PUT /api/providers/{id}/models 把体透给 setProviderModelContext 并回 ProviderView', async () => {
    const view = { id: 'p-1', models: [] };
    setProviderModelContext.mockReturnValue(view);
    const res = await PUT(
      new Request('http://localhost/api/providers/p-1/models', {
        method: 'PUT',
        body: JSON.stringify({ id: 'm', contextWindow: 262144 }),
      }),
      { params: Promise.resolve({ providerId: 'p-1' }) },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(view);
    expect(setProviderModelContext).toHaveBeenCalledWith('p-1', { id: 'm', contextWindow: 262144 });
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @aieval/api test -- providers` 与 `pnpm --filter web-next test -- route-providers`
Expected: FAIL —— `setProviderModelContext is not a function`。

- [ ] **Step 3: 实现**

`packages/server/contracts/src/provider.ts` 末尾追加：

```ts
/**
 * 单条模型的窗口入参（设置页的行内编辑器）：`contextWindow: null` = **明确清空**。
 * 为什么用 null 而不是「字段缺席」：缺席与「不改」在语义上不可区分，而清空是一次真实意图
 * （它同样要把 contextWindowSource 置成 manual，见 spec D3）。
 */
export const ProviderModelContextSchema = z.object({
  id: z.string().min(1),
  contextWindow: z.number().int().positive().nullable(),
  maxOutputTokens: z.number().int().positive().nullable().optional(),
});
export type ProviderModelContextInput = z.infer<typeof ProviderModelContextSchema>;
```

`packages/server/api/src/providers.ts` 在 `removeProviderModel` 之后追加：

```ts
/**
 * 设置某条模型的窗口 / 输出上限（设置页的行内编辑器）。三条口径：
 *   ① 只动 `contextWindow` / `maxOutputTokens` / `contextWindowSource` 三格，别的一律原样；
 *   ② 一律把 `contextWindowSource` 置成 `'manual'` —— **清空也算**（spec D3：语义是「别用上游那个数」）；
 *   ③ 清单里没有这条 ⇒ NOT_FOUND（与 removeProviderModel 同口径，不静默新建条目）。
 */
export function setProviderModelContext(providerId: string, input: ProviderModelContextInput): ProviderView {
  const config = loadConfig();
  const provider = requireProvider(config, providerId);
  const target = input.id.trim();
  if (!provider.models.some((model) => model.id === target)) {
    throw new ServiceError('NOT_FOUND', `供应商「${provider.name}」的模型清单里没有 ${input.id}`);
  }
  const models = provider.models.map((model) => {
    if (model.id !== target) return model;
    const { contextWindow: _dropWindow, maxOutputTokens: _dropOutput, contextWindowSource: _dropSource, ...rest } = model;
    return {
      ...rest,
      ...(input.contextWindow === null ? {} : { contextWindow: input.contextWindow }),
      ...(input.maxOutputTokens === undefined || input.maxOutputTokens === null ? {} : { maxOutputTokens: input.maxOutputTokens }),
      contextWindowSource: 'manual' as const,
    };
  });
  const next: Provider = { ...provider, models, updatedAt: new Date().toISOString() };
  replaceProvider(config, next);
  log.info('模型窗口已手工设置', { providerId, modelId: target, contextWindow: input.contextWindow });
  return toView(next);
}
```

（`pickContext` 在这里不适用：它不做「保留哪些旧键」的判断，故上面用了解构丢弃 + 显式重建。别把它硬塞进来。）

`apps/web-next/app/api/providers/[providerId]/models/route.ts` 追加一个 `PUT`（并把它加进文件头那段「POST 加一条 / DELETE 删一条」的说明）：

```ts
/** PUT：设置单条模型的窗口（设置页的行内编辑器）。响应体同样是 ProviderView（理由见文件头第 2 条） */
export async function PUT(req: Request, ctx: ProviderRouteContext): Promise<Response> {
  try {
    const { providerId } = await ctx.params;
    const input = ProviderModelContextSchema.parse(await readJsonBody(req));
    return Response.json(setProviderModelContext(providerId, input));
  } catch (error) {
    return handleApiError(error);
  }
}
```

（import 行同时补 `setProviderModelContext` 与 `ProviderModelContextSchema`。）

**同时确认两个 barrel**：`packages/server/contracts/src/index.ts` 与 `packages/server/api/src/index.ts` 都要能取到新名字（多数情况是 `export *`，若它们是显式清单就补一行）——漏了表现为 web 路由 import 到 `undefined`、测试在 mock 处静默通过。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @aieval/api test -- providers` 与 `pnpm --filter web-next test -- route-providers`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/server/contracts/src/provider.ts packages/server/api/src/providers.ts packages/server/api/src/providers.test.ts apps/web-next/app/api/providers/\[providerId\]/models/route.ts apps/web-next/src/route-providers.test.ts
git commit -m "feat(api): 模型窗口的手工设置入口（PUT /models，清空也是一次表态）"
```

---

### Task 5: 客户端数据层——`setContext`

**Files:**
- Modify: `packages/client/client/src/providers.ts`（`useProviderModels` 增加 `setContext`）
- Test: `packages/client/client/src/providers.test.tsx`

**Interfaces:**
- Consumes: Task 4 的 `PUT /api/providers/{id}/models`
- Produces: `useProviderModels()` 的返回增加 `setContext: (id: string, modelId: string, contextWindow: number | null) => Promise<ProviderView>`

- [ ] **Step 1: 写失败的测试**

追加到 `packages/client/client/src/providers.test.tsx`（照该文件既有的 `add` / `remove` 用例写法）：

```tsx
  it('setContext 发 PUT /api/providers/{id}/models，体里是 { id, contextWindow }', async () => {
    const { result } = renderHook(() => useProviderModels());
    await act(async () => {
      await result.current.setContext('p-1', 'vendor/model+x', 262_144);
    });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/providers/p-1/models',
      expect.objectContaining({ method: 'PUT', body: JSON.stringify({ id: 'vendor/model+x', contextWindow: 262_144 }) }),
    );
  });

  it('setContext 传 null 表示清空', async () => {
    const { result } = renderHook(() => useProviderModels());
    await act(async () => {
      await result.current.setContext('p-1', 'm', null);
    });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/providers/p-1/models',
      expect.objectContaining({ body: JSON.stringify({ id: 'm', contextWindow: null }) }),
    );
  });
```

（`fetchMock` 与 `renderHook` 的引入以文件现状为准——该文件已有这些夹具。）

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @aieval/client test -- providers`
Expected: FAIL —— `result.current.setContext is not a function`。

- [ ] **Step 3: 实现**

`packages/client/client/src/providers.ts` 的 `useProviderModels` 里加第三个 mutation：

```ts
  const setContextMutation = useSWRMutation(
    LIST_KEY,
    (_key: string, { arg }: { arg: { id: string; modelId: string; contextWindow: number | null } }) =>
      putJson<ProviderView>(modelsUrl(arg.id), { id: arg.modelId, contextWindow: arg.contextWindow }),
    { revalidate: false },
  );
  const setContext = async (id: string, modelId: string, contextWindow: number | null): Promise<ProviderView> => {
    const view = await setContextMutation.trigger({ id, modelId, contextWindow });
    await mutate(LIST_KEY);
    return view;
  };
```

返回类型与 `return` 一并加上 `setContext`，`isMutating` 的表达式补 `|| setContextMutation.isMutating`。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @aieval/client test -- providers`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/client/client/src/providers.ts packages/client/client/src/providers.test.tsx
git commit -m "feat(client): 供应商数据层补 setContext（PUT /models）"
```

---

### Task 6: 路由携带窗口 + 编排层填充 + claude-code 的 `[1m]`

**Files:**
- Modify: `packages/server/agents/src/types.ts`（`AgentRunInput.route`）、`packages/server/evaluator/src/orchestrator.ts:1083-1088`、`packages/server/agents/src/providers/claude-code/index.ts:84`
- Test: `packages/server/agents/src/providers/claude-code/index.test.ts`、`packages/server/evaluator/src/orchestrator.test.ts`

**Interfaces:**
- Consumes: Task 1/2 落盘的 `contextWindow`
- Produces: `AgentRunInput.route.contextWindow?: number`、`route.maxOutputTokens?: number`（本次只用到前者）；cc 适配器把 `contextWindow >= 1_000_000` 的模型写成 `${modelId}[1m]`

- [ ] **Step 1: 写失败的测试**

`packages/server/agents/src/providers/claude-code/index.test.ts`（该文件已有「用假 SDK 断言 query 参数」的用例，照它加一组）：

```ts
  it.each([
    [1_000_000, 'GLM-5.3[1m]'],
    [1_048_576, 'GLM-5.3[1m]'],
    [999_999, 'GLM-5.3'],
    [undefined, 'GLM-5.3'],
  ])('窗口 %s ⇒ 传给 SDK 的模型名是 %s', async (contextWindow, expected) => {
    const recorder = createRecorder();
    setAgentRuntimeForTesting({ sdkModule: createFakeClaudeSdk({ recorder, events: [] }) });
    await getProvider('claude-code').run(createRunInput({ route: { contextWindow } }));
    expect(recorder.queryOptions?.model).toBe(expected);
  });

  it('模型名里本来就带 [1m] 时不重复拼接', async () => {
    const recorder = createRecorder();
    setAgentRuntimeForTesting({ sdkModule: createFakeClaudeSdk({ recorder, events: [] }) });
    await getProvider('claude-code').run(createRunInput({ modelId: 'GLM-5.3[1m]', route: { contextWindow: 1_048_576 } }));
    expect(recorder.queryOptions?.model).toBe('GLM-5.3[1m]');
  });
```

（`createRunInput` / `createFakeClaudeSdk` / `recorder.queryOptions` 的现状以 `packages/server/agents/src/testing/agent-fixtures.ts` 为准；若夹具还没有 `queryOptions` 记录点，先在该夹具里补一个（这也是本任务的一部分）。）

`packages/server/evaluator/src/orchestrator.test.ts` 追加：

```ts
  it('组装给适配器的 route 带上供应商清单里那条模型的窗口', async () => {
    const { run } = seedRunnableRun({ rowCount: 1 });
    // 种子夹具里的供应商模型条目补上窗口（字段名以 fixtures.ts 现状为准）
    const config = loadConfig();
    saveConfig({
      ...config,
      providers: config.providers.map((provider) => ({
        ...provider,
        models: provider.models.map((model) => ({ ...model, contextWindow: 1_048_576 })),
      })),
    });
    await startRun(run.id);
    expect(fakeAgents.calls[0]?.input.route.contextWindow).toBe(1_048_576);
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @aieval/agents test -- claude-code` 与 `pnpm --filter @aieval/evaluator test -- orchestrator`
Expected: FAIL —— cc 那条拿到 `'GLM-5.3'`（没有后缀），evaluator 那条 `route.contextWindow` 是 `undefined`。

- [ ] **Step 3: 实现**

`packages/server/agents/src/types.ts` 的 `route` 里，在 `modelId` 之后加两格：

```ts
    modelId: string;
    /**
     * 该模型声明的上下文窗口（token）。**可选**：既有夹具与将来的第三方 provider 不该被它挡住，
     * 缺省 = 未知（各家保持自己的默认行为）。它是**事实**，不是方言：
     * cc 读它决定要不要加 [1m] 后缀、codex 读它填 model_context_window、dsh 读它写 settings.yaml ——
     * 三种写法都不出现在这一格里（spec D1）。
     */
    contextWindow?: number;
    /** 单次输出上限；今天只有 dsh 的目录用得上（可选，理由同上） */
    maxOutputTokens?: number;
```

`packages/server/evaluator/src/orchestrator.ts` 的 `agentProvider.run({...})` 里，`route` 换成：

```ts
      route: {
        protocolType: providerRecord.protocolType,
        baseUrl: providerRecord.baseUrl,
        apiKey: providerRecord.apiKey,
        modelId: row.modelId,
        // 窗口从**供应商清单里当次读到的那一条**取（与 baseUrl 同口径：模型属性在运行时现读，不进快照）。
        // 条目不存在时是 undefined ⇒ 三家都不注入（spec D8），绝不兜底一个数字。
        ...contextOf(providerRecord, row.modelId),
      },
```

并在本文件里加一个小工具（放在 `runRowAttempt` 之前）：

```ts
/** 从供应商清单里取该模型的窗口两格；条目缺失或没声明就是空对象（不是 { contextWindow: undefined }） */
function contextOf(provider: Provider, modelId: string): { contextWindow?: number; maxOutputTokens?: number } {
  const model = provider.models.find((item) => item.id === modelId);
  if (model === undefined) return {};
  return {
    ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
    ...(model.maxOutputTokens === undefined ? {} : { maxOutputTokens: model.maxOutputTokens }),
  };
}
```

（`Provider` 类型从 `@aieval/contracts` import。本仓 `providerRecord` 的静态类型以文件现状为准。）

`packages/server/agents/src/providers/claude-code/index.ts`：

```ts
/**
 * 多大算「1M 变体」：**cc 的方言阈值**，不是领域概念（spec D9）。
 * 为什么放在这里而不是 contracts：它是 cc 的模型名语法，别处拿它做判断只会误导。
 */
const ONE_M_CONTEXT = 1_000_000;

/**
 * cc 的模型名：窗口 ≥ 1M 时要写成 `<id>[1m]`（spec D4，用户口径）。
 * 已经带后缀的名字原样返回——幂等，免得用户手工把清单里的名字写成 `X[1m]` 时拼成 `X[1m][1m]`（Review Focus #5）。
 */
function modelForClaudeCode(modelId: string, contextWindow: number | undefined): string {
  if (modelId.endsWith('[1m]')) return modelId;
  return contextWindow !== undefined && contextWindow >= ONE_M_CONTEXT ? `${modelId}[1m]` : modelId;
}
```

`startClaudeCode` 里 `const query = sdk.query({ ... model: input.route.modelId, ...})` 改成先算 `const model = modelForClaudeCode(input.route.modelId, input.route.contextWindow);` 再 `model,`；日志改成：

```ts
  logger.debug('claude-code 已注入路由并启动查询', {
    model, // ← 真正传给 CLI 的名字（排障要看的就是这个）
    declaredModel: input.route.modelId, // ← 业务身份；两者不同时才与上面那格不一致
    contextWindow: input.route.contextWindow,
    baseUrl: env.ANTHROPIC_BASE_URL,
    cwd,
  });
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @aieval/agents test -- claude-code` 与 `pnpm --filter @aieval/evaluator test -- orchestrator`
Expected: PASS

- [ ] **Step 5: 变异验证**

把 `contextWindow >= ONE_M_CONTEXT` 改成 `contextWindow > ONE_M_CONTEXT`，重跑 Step 4，确认 `1_000_000` 那条**变红**；还原并核对哈希。

- [ ] **Step 6: 提交**

```bash
git add packages/server/agents/src/types.ts packages/server/agents/src/providers/claude-code/index.ts packages/server/agents/src/providers/claude-code/index.test.ts packages/server/agents/src/testing/agent-fixtures.ts packages/server/evaluator/src/orchestrator.ts packages/server/evaluator/src/orchestrator.test.ts
git commit -m "feat(agents): route 携带窗口，claude-code 按 1M 阈值写 [1m] 后缀"
```

---

### Task 7: codex 的 `model_context_window`

**Files:**
- Modify: `packages/server/agents/src/providers/codex/sdk.ts`（`CodexConfig` + `buildCodexConfig`）、`packages/server/agents/src/providers/codex/index.ts:43`
- Test: `packages/server/agents/src/providers/codex/index.test.ts`、`packages/server/agents/src/providers/codex/sdk.test.ts`（没有就新建）

**Interfaces:**
- Consumes: Task 6 的 `route.contextWindow`
- Produces: `buildCodexConfig(baseUrl: string, contextWindow?: number): CodexConfig`，未知窗口时 `model_context_window` **键不存在**

- [ ] **Step 1: 写失败的测试**

`sdk.test.ts`（纯函数，标 `// @vitest-environment node`）：

```ts
  it('给窗口就写 model_context_window，不给就整个键都不出现', () => {
    expect(buildCodexConfig('https://gw.example.com/v1', 1_048_576).model_context_window).toBe(1_048_576);
    // 关键：不是 undefined 值，而是**没有这个键** —— SDK 会把它摊成 --config key=value，
    // 一个 undefined 会被序列化成字符串 'undefined' 交给 CLI（本机 0.154.0 会当成未知值）
    expect(Object.hasOwn(buildCodexConfig('https://gw.example.com/v1'), 'model_context_window')).toBe(false);
  });
```

`index.test.ts` 追加（照该文件既有的假 codex SDK 记录点）：

```ts
  it('route 带窗口时，交给 SDK 的 config 里有 model_context_window', async () => {
    const recorder = createRecorder();
    setAgentRuntimeForTesting({ sdkModule: createFakeCodexSdk({ recorder, events: [] }) });
    await getProvider('codex').run(createRunInput({ route: { contextWindow: 262_144 } }));
    expect(recorder.clientOptions?.config).toMatchObject({ model_context_window: 262_144 });
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @aieval/agents test -- codex`
Expected: FAIL —— `model_context_window` 不存在（`buildCodexConfig` 还没有第二个参数）。

- [ ] **Step 3: 实现**

`codex/sdk.ts` 的 `CodexConfig` 加一格（JSDoc 说明它与窗口的关系），`buildCodexConfig` 改签名：

```ts
export interface CodexConfig {
  model_provider: string;
  model_providers: Record<string, CodexProviderEntry>;
  tools: { web_search: false };
  features: { multi_agent: false };
  /**
   * 模型的上下文窗口（token）。**只在已知时出现**：CLI 内置目录里没有我们网关的模型名
   * （实测 `codex debug models` 的 11 条全是 GPT 系），所以这个数只能由我们告诉它。
   * 不给时 CLI 按自己的兜底走 —— 与我们替它编一个数字相比，那是更诚实的行为（spec D8）。
   */
  model_context_window?: number;
}

export function buildCodexConfig(baseUrl: string, contextWindow?: number): CodexConfig {
  return {
    model_provider: CODEX_PROVIDER_ID,
    model_providers: { /* …原样不动… */ },
    tools: { web_search: false },
    features: { multi_agent: false },
    ...(contextWindow === undefined ? {} : { model_context_window: contextWindow }),
  };
}
```

`codex/index.ts` 的 `config: buildCodexConfig(baseUrl)` → `config: buildCodexConfig(baseUrl, input.route.contextWindow)`；logger 那行补 `contextWindow: input.route.contextWindow`。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @aieval/agents test -- codex`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/server/agents/src/providers/codex/sdk.ts packages/server/agents/src/providers/codex/index.ts packages/server/agents/src/providers/codex/index.test.ts packages/server/agents/src/providers/codex/sdk.test.ts
git commit -m "feat(agents): codex 按窗口注入 model_context_window（未知时不写该键）"
```

---

### Task 8: dsh 的 `settings.yaml`

**Files:**
- Modify: `packages/server/agents/src/providers/dsh/index.ts`（`startDsh` 里、`await runtime.start()` 之前）
- Test: `packages/server/agents/src/providers/dsh/index.test.ts`

**Interfaces:**
- Consumes: Task 6 的 `route.contextWindow` / `route.maxOutputTokens`
- Produces: 每行 `<configHome>/settings.yaml`（内容见下）；窗口未知时该文件**不存在**

- [ ] **Step 1: 写失败的测试**

```ts
  it('给窗口 ⇒ 写出 llm-deepseek 分节；未知 ⇒ 不写文件（且删掉可能残留的旧文件）', async () => {
    const home = mkdtempSync(join(tmpdir(), 'aieval-dsh-home-'));
    const recorder = createRecorder();
    setAgentRuntimeForTesting({ sdkModule: createFakeDshSdk({ recorder, events: [] }) });

    await getProvider('dsh').run(createRunInput({ configHome: home, route: { contextWindow: 1_048_576, maxOutputTokens: 131_072 } }));
    const written = readFileSync(join(home, 'settings.yaml'), 'utf8');
    expect(written).toContain('llm-deepseek:');
    expect(written).toContain('contextWindow: 1048576');
    expect(written).toContain('maxTokens: 131072');

    // 第二次：窗口未知 ⇒ 上次那份必须被清掉，否则它会继续冒充「这次也这么算」
    await getProvider('dsh').run(createRunInput({ configHome: home, route: {} }));
    expect(existsSync(join(home, 'settings.yaml'))).toBe(false);
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @aieval/agents test -- dsh`
Expected: FAIL —— `settings.yaml` 不存在（读文件抛 ENOENT）。

- [ ] **Step 3: 实现**

`packages/server/agents/src/providers/dsh/index.ts` 顶部 import 补 `existsSync/rmSync/writeFileSync`、`join`，并加：

```ts
/**
 * 把窗口写进本次运行的 DSH 设置文档（`<configHome>/settings.yaml`）。
 *
 * 为什么写文件：`llm-deepseek` 的窗口只在设置文档里（`models[].contextWindow` / `defaultContextWindow`），
 * 没有对应的环境变量——`DEEPSEEK_*` 那几个是地址与凭据（spec D5）。
 * 为什么写 per-row 的 configHome：那正是本行的 DSH_HOME（`core/src/workspace.ts` 的 `.agenthome` 落点），
 * 目录由本仓独占创建，不会踩到用户的全局 DSH 配置。
 * 为什么未知时**删文件**：不删的话，上一次运行留下的窗口会继续生效，看起来像「这次也声明了」。
 * 已知边界：`models` 列表是整份替换（插件 README 明写），所以我们只声明这一条模型。
 */
export function writeDshSettings(
  configHome: string,
  model: string,
  contextWindow?: number,
  maxOutputTokens?: number,
): void {
  const file = join(configHome, 'settings.yaml');
  if (contextWindow === undefined) {
    rmSync(file, { force: true });
    return;
  }
  // YAML 里的字符串一律加双引号并转义：模型名可能含 `:`（`jd/GLM-5.3` 这类含 `/` 也照引不误），
  // 裸写会在下一次出现 `key: value` 形状时被解析成嵌套结构
  const quoted = `"${model.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
  writeFileSync(
    file,
    [
      '# 由 ai-result-evaluation 写入：声明本次运行所用模型的上下文窗口',
      'llm-deepseek:',
      '  models:',
      `    - id: ${quoted}`,
      `      contextWindow: ${contextWindow}`,
      ...(maxOutputTokens === undefined ? [] : [`      maxTokens: ${maxOutputTokens}`]),
      '',
    ].join('\n'),
    { encoding: 'utf8', mode: 0o600 },
  );
}
```

`startDsh` 里，`await runtime.start();` 之前插一行：

```ts
  // 窗口必须在运行时启动**之前**落盘：设置文档是启动时读的（`dsh-settings-file` 的 load 语义）
  writeDshSettings(input.configHome, input.route.modelId, input.route.contextWindow, input.route.maxOutputTokens);
```

logger 那行补 `contextWindow: input.route.contextWindow`。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @aieval/agents test -- dsh`
Expected: PASS

- [ ] **Step 5: 变异验证**

把 `writeDshSettings` 的第一行 `if (contextWindow === undefined)` 改成 `if (false)`，重跑 Step 4，确认第二条断言（`existsSync === false`）**变红**；还原并核对哈希。

- [ ] **Step 6: 提交**

```bash
git add packages/server/agents/src/providers/dsh/index.ts packages/server/agents/src/providers/dsh/index.test.ts
git commit -m "feat(agents): dsh 按窗口写 settings.yaml（未知时清掉残留）"
```

---

### Task 9: 强度——契约取数、合并、注册表元数据

**Files:**
- Modify: `packages/server/contracts/src/provider.ts`（`supportedEfforts` / `recommendedEffort`）、`packages/server/api/src/providers.ts`（`extractModels` + 合并）、`packages/server/agents/src/types.ts`（`AgentProviderMetadata.reasoningEfforts` + `AgentRunInput.effort`）、三家 provider 的 `metadata`、`packages/server/agents/src/registry.test.ts`
- Test: `packages/server/api/src/providers.test.ts`、`packages/server/agents/src/registry.test.ts`

**Interfaces:**
- Consumes: Task 1–3 的取数与合并骨架
- Produces: `ProviderModel.supportedEfforts?: string[]` / `recommendedEffort?: string`；`AgentProviderMetadata.reasoningEfforts: readonly string[]`；`AgentRunInput.effort?: string`（本任务只到「声明 + 落盘」，三家适配器的参数透传在 Task 10）

- [ ] **Step 1: 写失败的测试**

`providers.test.ts`：

```ts
describe('拉取时解析思考强度档位', () => {
  it('三种形态：supportedEffortLevels / reasoning.supported_efforts / capabilities.effort 逐档对象', async () => {
    const provider = makeProvider();
    seedConfig({ providers: [{ ...provider, models: [] }] });
    stubUpstream({
      data: [
        { id: 'a', supportedEffortLevels: ['low', 'high', 'max'], recommendEffortLevel: 'high' },
        { id: 'b', reasoning: { supported_efforts: ['high', 'max'], default_effort: 'max' } },
        {
          id: 'c',
          capabilities: { effort: { supported: true, low: { supported: true }, high: { supported: true, recommend: true } } },
        },
      ],
    });
    const view = await fetchProviderModels(provider.id);
    const byId = new Map(view.models.map((model) => [model.id, model]));
    // 数组形态优先于逐档对象：三种形态是「按优先级取第一个像档位表的」（spec D2）
    expect(byId.get('a')).toMatchObject({ supportedEfforts: ['low', 'high', 'max'], recommendedEffort: 'high' });
    expect(byId.get('b')).toMatchObject({ supportedEfforts: ['high', 'max'], recommendedEffort: 'max' });
    expect(byId.get('c')).toMatchObject({ supportedEfforts: ['low', 'high'], recommendedEffort: 'high' });
  });

  it('推荐档不在档位表里 ⇒ 两个都不写；档位表为空 ⇒ 三个字段都不写', async () => {
    const provider = makeProvider();
    seedConfig({ providers: [{ ...provider, models: [] }] });
    stubUpstream({
      data: [
        { id: 'mismatch', supportedEffortLevels: ['low'], recommendEffortLevel: 'max' },
        { id: 'none', supportedEffortLevels: [] },
        { id: 'silent' },
      ],
    });
    const view = await fetchProviderModels(provider.id);
    for (const id of ['mismatch', 'none', 'silent']) {
      const model = view.models.find((item) => item.id === id);
      expect(model?.supportedEfforts).toBeUndefined();
      expect(model?.recommendedEffort).toBeUndefined();
    }
  });
});
```

`registry.test.ts`：`EXPECTED_METADATA` 三家各加 `reasoningEfforts`（cc `['low','medium','high','xhigh','max']`、codex `['minimal','low','medium','high','xhigh','max','ultra','persistent']`、dsh `['off','low','high','max']`），并加一条守卫：

```ts
  it('每家都显式声明 reasoningEfforts（交集规则靠它，缺一格就是静默少一批档位）', () => {
    for (const provider of listAgentProviders()) {
      expect(provider.metadata.reasoningEfforts.length, `${provider.kind} 的 reasoningEfforts`).toBeGreaterThan(0);
    }
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @aieval/api test -- providers` 与 `pnpm --filter @aieval/agents test -- registry`
Expected: FAIL（两个文件都红：字段不存在 / 类型不存在）。

- [ ] **Step 3: 实现**

`contracts/src/provider.ts`：`ProviderModelSchema` 再加两格（JSDoc 写清「上游词汇原样保留、不做归一化」）：

```ts
  /** 上游声明的思考强度档位，保持上游顺序与拼写；空/缺省 = 上游没说（界面只有「默认」） */
  supportedEfforts: z.array(z.string().min(1)).optional(),
  /** 上游推荐的档位；不在 supportedEfforts 里时按「没有推荐」处置（不猜） */
  recommendedEffort: z.string().min(1).optional(),
```

`api/src/providers.ts` 的 `ExtractedModel` 加两格，`extractModels` 里补第三、四种形态的解析：

```ts
const EFFORT_LIST_KEYS = ['supportedEffortLevels', 'reasoning.supported_efforts'] as const;
const RECOMMENDED_EFFORT_KEYS = ['recommendEffortLevel', 'reasoning.default_effort'] as const;

/** 档位表：数组形态优先；都没有就看 `capabilities.effort` 的逐档对象（`supported === true` 的键，保持上游顺序） */
function effortLevels(entry: unknown): { efforts: string[]; recommended?: string } {
  for (const key of EFFORT_LIST_KEYS) {
    const value = readPath(entry, key);
    if (Array.isArray(value)) {
      const efforts = cleanEfforts(value);
      if (efforts.length > 0) return { efforts, recommended: recommendedEffort(entry, efforts) };
    }
  }
  const table = readPath(entry, 'capabilities.effort');
  if (typeof table === 'object' && table !== null) {
    const efforts: string[] = [];
    let flagged: string | undefined;
    for (const [level, detail] of Object.entries(table as Record<string, unknown>)) {
      if (typeof detail !== 'object' || detail === null) continue;
      if ((detail as { supported?: unknown }).supported !== true) continue;
      efforts.push(level);
      if ((detail as { recommend?: unknown }).recommend === true) flagged ??= level;
    }
    if (efforts.length > 0) return { efforts, recommended: recommendedEffort(entry, efforts) ?? flagged };
  }
  return { efforts: [] };
}

/** 非空字符串、按首次出现去重（上游偶尔给重复项） */
function cleanEfforts(value: unknown[]): string[] {
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string' || item.trim() === '') continue;
    seen.add(item);
  }
  return [...seen];
}

/** 推荐档：按优先级取；**必须落在档位表里**，否则当作没有推荐（spec：不猜、不补） */
function recommendedEffort(entry: unknown, efforts: readonly string[]): string | undefined {
  for (const key of RECOMMENDED_EFFORT_KEYS) {
    const value = readPath(entry, key);
    if (typeof value === 'string' && efforts.includes(value)) return value;
  }
  return undefined;
}
```

在 `extractModels` 的条目分支里接上（与窗口两格并列写进返回对象）：

```ts
      const { efforts, recommended } = effortLevels(entry);
      return [
        {
          id: id.trim(),
          ...(contextWindow === undefined ? {} : { contextWindow }),
          ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
          ...(efforts.length === 0 ? {} : { supportedEfforts: efforts }),
          ...(recommended === undefined ? {} : { recommendedEffort: recommended }),
        },
      ];
```

`ExtractedModel` 与 `pickContext` 同步加这两格（`pickContext` 的入参/返回类型都用 `Pick<ProviderModel, …>` 形态声明，别再手抄一遍字段名——抄一遍必然漂移）。合并规则：这两个字段**没有手工来源**，上游给了就换、没给就清（与窗口的 `contextWindowSource === 'manual'` 保护无关）。

`agents/src/types.ts`：`AgentProviderMetadata` 加

```ts
  /**
   * 该家能表达的思考强度档位（完整值域，spec D11）。**必填**并由 `registry.test.ts` 守卫：
   * 候选池的「上游档位 ∩ 智能体档位」交集全靠它，缺一格就是静默少一批档位。
   * 值域依据：cc = Agent SDK 的 `EffortLevel`；codex = `ModelReasoningEffort`；dsh = `llm-deepseek` 的 `reasoningEffort`。
   */
  reasoningEfforts: readonly string[];
```

`AgentRunInput` 加 `effort?: string`（JSDoc 写明「为什么不放 route」：route 是连接事实，强度是请求参数，值与连接无关）。

三家 provider 的 `metadata` 各补一格；`capability` 不动。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @aieval/api test -- providers` 与 `pnpm --filter @aieval/agents test -- registry` 与 `pnpm typecheck`
Expected: PASS / 干净

- [ ] **Step 5: 提交**

```bash
git add packages/server/contracts/src/provider.ts packages/server/api/src/providers.ts packages/server/api/src/providers.test.ts packages/server/agents/src/types.ts packages/server/agents/src/providers/claude-code/index.ts packages/server/agents/src/providers/codex/index.ts packages/server/agents/src/providers/dsh/index.ts packages/server/agents/src/registry.test.ts
git commit -m "feat: 取数并声明思考强度档位（契约 + 注册表元数据）"
```

---

### Task 10: 强度——三家适配器的参数透传

**Files:**
- Modify: `packages/server/agents/src/providers/claude-code/index.ts`、`packages/server/agents/src/providers/codex/{index.ts,sdk.ts}`、`packages/server/agents/src/providers/dsh/index.ts`
- Test: 三家各自的 `index.test.ts`

**Interfaces:**
- Consumes: Task 9 的 `AgentRunInput.effort`
- Produces: cc → `sdk.query({ options: { effort } })`；codex → `startThread({ modelReasoningEffort })`；dsh → `new DeepSeekHarness({ reasoningEffort })`；未给 ⇒ 三家都**没有该键**

- [ ] **Step 1: 写失败的测试**（三家的写法同构，逐家加一条）

```ts
  it('给了 effort 就透传，没给就整个键都不出现', async () => {
    const recorder = createRecorder();
    setAgentRuntimeForTesting({ sdkModule: createFakeClaudeSdk({ recorder, events: [] }) });
    await getProvider('claude-code').run(createRunInput({ effort: 'max' }));
    expect(recorder.queryOptions?.effort).toBe('max');

    const bare = createRecorder();
    setAgentRuntimeForTesting({ sdkModule: createFakeClaudeSdk({ recorder: bare, events: [] }) });
    await getProvider('claude-code').run(createRunInput());
    expect(Object.hasOwn(bare.queryOptions ?? {}, 'effort')).toBe(false);
  });
```

codex 断 `recorder.threadOptions?.modelReasoningEffort`、dsh 断 `recorder.harnessOptions?.reasoningEffort`（**不是** `undefined` 值，而是键不存在）。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @aieval/agents test -- claude-code codex dsh`
Expected: FAIL —— 三处都没有该键。

- [ ] **Step 3: 实现**

三家都是同一个形状（`undefined` 时不写键——SDK 会把 `undefined` 序列化成字符串或当默认值处理，两种都不是我们要的）：

```ts
// claude-code/index.ts：options 里
      ...(input.effort === undefined ? {} : { effort: input.effort }),
// codex/index.ts：startThread 参数里
      ...(input.effort === undefined ? {} : { modelReasoningEffort: input.effort }),
// dsh/index.ts：new sdk.DeepSeekHarness 参数里
      ...(input.effort === undefined ? {} : { reasoningEffort: input.effort }),
```

`codex/sdk.ts` 的 `CodexThreadOptions` 加 `modelReasoningEffort?: string`；`dsh/sdk.ts` 的 `DshHarnessOptions` 加 `reasoningEffort?: string`（**窄结构自己声明，不从厂商包 import type**——本包既有铁律）。

三家 logger 的 debug 行各补 `effort: input.effort`。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @aieval/agents test -- claude-code codex dsh`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/server/agents/src/providers/claude-code/index.ts packages/server/agents/src/providers/codex/index.ts packages/server/agents/src/providers/codex/sdk.ts packages/server/agents/src/providers/dsh/index.ts packages/server/agents/src/providers/claude-code/index.test.ts packages/server/agents/src/providers/codex/index.test.ts packages/server/agents/src/providers/dsh/index.test.ts packages/server/agents/src/testing/agent-fixtures.ts
git commit -m "feat(agents): 三家按自己的方言透传思考强度（未选则不传）"
```

---

### Task 11: 行快照 + 候选池交集 + 创建时校验 + 编排层透传

**Files:**
- Modify: `packages/server/contracts/src/run.ts`（`RunCreateSchema.rows[].effort`、`EvalRowSchema.effort`）、`packages/server/api/src/runs.ts`（投影 + 校验 + 落库）、`packages/server/evaluator/src/orchestrator.ts`（把 `row.effort` 传给适配器）
- Test: `packages/server/contracts/src/run.test.ts`、`packages/server/api/src/runs.test.ts`、`packages/server/evaluator/src/orchestrator.test.ts`

**Interfaces:**
- Consumes: Task 9 的 `reasoningEfforts` 与 `ProviderModel.supportedEfforts`；Task 10 的适配器入口
- Produces: `AgentModelOption` 增加 `contextWindow?: number`、`efforts: string[]`、`recommendedEffort?: string`；`AgentOptionGroup` 增加 `efforts: readonly string[]`；`RunCreate.rows[].effort?: string`；`EvalRow.effort?: string`；`createRun` 的强度校验

- [ ] **Step 1: 写失败的测试**

`runs.test.ts`（表驱动，覆盖 Review Focus #4）：

```ts
describe('候选池的强度交集与创建校验', () => {
  it('交集 = 上游档位 ∩ 该智能体档位；上游没说就是空数组', () => {
    const provider = makeAnthropicProvider({
      models: [
        { id: 'three', source: 'manual', supportedEfforts: ['low', 'high', 'max'], recommendedEffort: 'high' },
        { id: 'narrow', source: 'manual', supportedEfforts: ['low', 'medium', 'xhigh'], recommendedEffort: 'medium' },
        { id: 'unknown', source: 'manual' },
      ],
    });
    seedConfig({ providers: [provider] });

    const cc = listModelOptions('claude-code');
    expect(cc.find((o) => o.modelId === 'three')?.efforts).toEqual(['low', 'high', 'max']);
    expect(cc.find((o) => o.modelId === 'narrow')?.efforts).toEqual(['low', 'medium', 'xhigh']);
    expect(cc.find((o) => o.modelId === 'unknown')?.efforts).toEqual([]);
    expect(cc.find((o) => o.modelId === 'unknown')?.recommendedEffort).toBeUndefined();

    // dsh 只认 off/low/high/max ⇒ narrow 的三档里只剩 low；推荐档 medium 不在交集里 ⇒ 不给推荐
    const dsh = listModelOptions('dsh');
    expect(dsh.find((o) => o.modelId === 'narrow')?.efforts).toEqual(['low']);
    expect(dsh.find((o) => o.modelId === 'narrow')?.recommendedEffort).toBeUndefined();
    expect(dsh.find((o) => o.modelId === 'three')?.recommendedEffort).toBe('high');
  });

  it('创建时校验强度：不在交集里 ⇒ INVALID_QUERY 且点名两个值域；在交集里 ⇒ 落进快照', () => {
    const provider = makeAnthropicProvider({
      models: [{ id: 'm', source: 'manual', supportedEfforts: ['low', 'high', 'max'] }],
    });
    seedConfig({ providers: [provider], cases: [makeCase()] });

    const bad = () => createRun({ caseId: 'c-1', executionMode: 'serial', rows: [{ agentKind: 'dsh', providerId: provider.id, modelId: 'm', effort: 'medium' }] });
    expect(bad).toThrow(/medium/);
    expect(bad).toThrow(/off\/low\/high\/max|off, low, high, max/);

    const run = createRun({ caseId: 'c-1', executionMode: 'serial', rows: [{ agentKind: 'dsh', providerId: provider.id, modelId: 'm', effort: 'high' }] });
    expect(run.rows[0]?.effort).toBe('high');

    const bare = createRun({ caseId: 'c-1', executionMode: 'serial', rows: [{ agentKind: 'dsh', providerId: provider.id, modelId: 'm' }] });
    expect(bare.rows[0]?.effort).toBeUndefined();
  });
});
```

`orchestrator.test.ts` 追加一条「行的 effort 到达适配器输入」的断言（用 `fakeAgents.calls[0]?.input.effort`）。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @aieval/api test -- runs` 与 `pnpm --filter @aieval/evaluator test -- orchestrator`
Expected: FAIL —— `efforts` 不存在 / `effort` 被 zod strip 掉 / 校验不拦。

- [ ] **Step 3: 实现**

`contracts/src/run.ts`：`EvalRowSchema` 加

```ts
  /**
   * 这一行要求的思考强度（spec D12）。**可选**：老 run.json 没有这一格，必填会让 `listRuns()` 静默跳过。
   * 记的是**我们要求的**档位，不是**实际生效的**档位（cc 可能静默降档，见 spec §9 第 7 条）。
   */
  effort: z.string().min(1).optional(),
```

`RunCreateSchema.rows` 的元素加 `effort: z.string().min(1).optional()`（**必须显式声明**：zod 3 默认 strip 未知键，不写的话表单提交的强度会被静默丢弃）。

`api/src/runs.ts`：

```ts
/**
 * 上游档位 ∩ 该智能体能收的档位（spec D10）。
 * 为什么求交而不是原样列上游：dsh 侧对不支持的档位是**硬报错**（`UNSUPPORTED_REASONING_EFFORT`），
 * 原样列等于让人选完到运行时才炸；而「就近取整」是静默改语义（选 medium 实跑 high）。
 * 顺序按上游给的顺序（推荐档也一样），交集为空就是「只有默认」。
 */
function intersectEfforts(model: ProviderView['models'][number], agentEfforts: readonly string[]): string[] {
  return (model.supportedEfforts ?? []).filter((effort) => agentEfforts.includes(effort));
}
```

`listModelOptions` 的 map 里补三格（`contextWindow` 直传；`efforts` 用交集；`recommendedEffort` 只在交集里才有值）；`listAgentModelOptions` 的每个 group 补 `efforts: metadata.reasoningEfforts`。

`createRun` 逐行的校验链在协议判定之后追加：

```ts
    const supported = model.supportedEfforts ?? [];
    const allowed = intersectEfforts(model, metadata.reasoningEfforts);
    if (row.effort !== undefined && !allowed.includes(row.effort)) {
      // 两个值域都点名：用户才知道是「模型不支持」还是「这家智能体不支持」
      throw new ServiceError(
        'INVALID_QUERY',
        `${displayName} 不能按 ${row.effort} 跑 ${row.modelId}：该模型支持的档位是 ${supported.join(' / ') || '（上游未声明）'}，` +
          `${displayName} 能收的是 ${metadata.reasoningEfforts.join(' / ')}，可选的是 ${allowed.join(' / ') || '（只有默认）'}`,
      );
    }
```

（`model` 就是上面 `provider.models.some(...)` 那一步已经取到的那条；没取到就把 `find` 的结果提出来复用，别 find 两次。）落库时 `effort: row.effort`（`undefined` 时不写键）。

`evaluator/src/orchestrator.ts`：`agentProvider.run({...})` 的入参加 `...(row.effort === undefined ? {} : { effort: row.effort })`。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @aieval/contracts test -- run` 与 `pnpm --filter @aieval/api test -- runs` 与 `pnpm --filter @aieval/evaluator test -- orchestrator`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/server/contracts/src/run.ts packages/server/contracts/src/run.test.ts packages/server/api/src/runs.ts packages/server/api/src/runs.test.ts packages/server/evaluator/src/orchestrator.ts packages/server/evaluator/src/orchestrator.test.ts
git commit -m "feat: 强度交集投影 + 创建时校验 + 行快照与编排层透传"
```

---

### Task 12: UI 组件——窗口标签与格式化

**Files:**
- Create: `packages/client/ui/src/base/context-window-tag.tsx`
- Test: `packages/client/ui/src/base/context-window-tag.test.tsx`

**Interfaces:**
- Consumes: `ProviderModel.contextWindow`（Task 1）
- Produces: `formatContextWindow(contextWindow?: number): string`（`1M` / `1.05M` / `400K` / `未知`）与 `<ContextWindowTag contextWindow={…} />`；Task 13、14 都用它

- [ ] **Step 1: 写失败的测试**（先查 context7 的 antd `Tag` 用法）

```tsx
  it('格式：≥1M 保留两位再去尾零，其余按 K 取整；未知显示「未知」', () => {
    expect(formatContextWindow(1_000_000)).toBe('1M');
    expect(formatContextWindow(1_048_576)).toBe('1.05M');
    expect(formatContextWindow(400_000)).toBe('400K');
    expect(formatContextWindow(262_144)).toBe('262K');
    expect(formatContextWindow(undefined)).toBe('未知');
  });

  it('未知不加颜色（Tag 的 color 只在有值时给）', () => {
    const { container } = render(<ContextWindowTag contextWindow={undefined} />);
    expect(container.textContent).toContain('未知');
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @aieval/ui test -- context-window-tag`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现**

```tsx
'use client';

/**
 * 上下文窗口的展示：一个纯函数 + 一个 Tag（设置页的模型清单与创建评测的模型下拉共用）。
 * 为什么不做四舍五入到整数档：`1048576`（1.05M）与 `1000000`（1M）在后缀阈值（spec D4）上**恰好分处两侧**，
 * 都显示成「1M」会把那个差别抹掉 —— 而这正是用户排障时第一个要看的东西。
 */
import type { ReactNode } from 'react';
import { Tag } from 'antd';

export function formatContextWindow(contextWindow?: number): string {
  if (contextWindow === undefined) return '未知';
  if (contextWindow >= 1_000_000) return `${(contextWindow / 1_000_000).toFixed(2).replace(/\.?0+$/, '')}M`;
  return `${Math.round(contextWindow / 1000)}K`;
}

export function ContextWindowTag({ contextWindow }: { contextWindow?: number }): ReactNode {
  return <Tag color={contextWindow === undefined ? undefined : 'geekblue'}>{formatContextWindow(contextWindow)}</Tag>;
}
```

- [ ] **Step 4: 跑测试确认通过并提交**

Run: `pnpm --filter @aieval/ui test -- context-window-tag`

```bash
git add packages/client/ui/src/base/context-window-tag.tsx packages/client/ui/src/base/context-window-tag.test.tsx
git commit -m "feat(ui): 上下文窗口的格式化与标签组件"
```

---

### Task 13: UI——设置页的窗口显示与行内编辑

**Files:**
- Modify: `packages/client/ui/src/composite/provider-form-modal.tsx`（模型行）、`apps/web-next/app/settings/page.tsx:253-263`（接 `setContext`）
- Test: `packages/client/ui/src/composite/provider-form-modal.test.tsx`、`apps/web-next/src/...`（若设置页有集成测试就补一条，没有就只靠组件测试）

**Interfaces:**
- Consumes: Task 5 的 `setContext`、Task 12 的 `ContextWindowTag`
- Produces: `ProviderFormModalProps` 增加 `onSetModelContext: (modelId: string, contextWindow: number | null) => void`

- [ ] **Step 1: 写失败的测试**

```tsx
  it('模型行显示窗口标签；改窗口后点保存回调 (modelId, 数字)；清空回调 null', async () => {
    const onSetModelContext = vi.fn();
    render(
      <ProviderFormModal
        open
        initial={{ ...providerViewFixture, models: [{ id: 'm', source: 'manual', contextWindow: 262_144, contextWindowSource: 'manual' }] }}
        saving={false}
        fetchingModels={false}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
        onFetchModels={vi.fn()}
        onAddModel={vi.fn()}
        onRemoveModel={vi.fn()}
        onSetModelContext={onSetModelContext}
      />,
    );
    expect(screen.getByText('262K')).toBeTruthy();
    // 手工来源要有可见标记（「下次拉取不会打回」这件事必须看得见）
    expect(screen.getByText('手工')).toBeTruthy();

    await userEvent.clear(screen.getByLabelText('m 的上下文窗口'));
    await userEvent.type(screen.getByLabelText('m 的上下文窗口'), '1000000');
    await userEvent.click(screen.getByRole('button', { name: '保存窗口' }));
    expect(onSetModelContext).toHaveBeenCalledWith('m', 1_000_000);
  });
```

（`providerViewFixture` / `userEvent` 的引入以该测试文件现状为准。）

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @aieval/ui test -- provider-form-modal`
Expected: FAIL —— 没有窗口标签 / 没有 `onSetModelContext`。

- [ ] **Step 3: 实现**

`provider-form-modal.tsx`：props 加 `onSetModelContext`，组件里加一行状态（`const [windowDrafts, setWindowDrafts] = useState<Record<string, number | null>>({})`，初值从 `initial.models` 派生、`open`/`initialId` 变化时重置——沿用文件头第 4 条的既有取舍，**不要**把 `initial` 放进依赖）。模型行改成：

```tsx
                {initial.models.map((model) => (
                  <Flex key={model.id} align="center" justify="space-between" gap={8}>
                    <Flex align="center" gap={8}>
                      <Typography.Text code>{model.id}</Typography.Text>
                      <Tag color={SOURCE_COLORS[model.source]}>{SOURCE_LABELS[model.source]}</Tag>
                      <ContextWindowTag contextWindow={model.contextWindow} />
                      {/* 手工来源必须可见：它意味着「下一次拉取不会覆盖这一格」（spec D3） */}
                      {model.contextWindowSource === 'manual' && <Tag color="gold">手工</Tag>}
                    </Flex>
                    <Flex align="center" gap={4}>
                      <InputNumber
                        size="small"
                        min={1}
                        style={{ width: 120 }}
                        aria-label={`${model.id} 的上下文窗口`}
                        placeholder="窗口 token 数"
                        value={windowDrafts[model.id] ?? model.contextWindow ?? null}
                        onChange={(value) => setWindowDrafts((draft) => ({ ...draft, [model.id]: value ?? null }))}
                      />
                      <Button
                        size="small"
                        autoInsertSpace={false}
                        onClick={() => onSetModelContext(model.id, windowDrafts[model.id] ?? model.contextWindow ?? null)}
                      >
                        保存窗口
                      </Button>
                      <Button size="small" type="text" danger autoInsertSpace={false} onClick={() => onRemoveModel(model.id)}>
                        移除
                      </Button>
                    </Flex>
                  </Flex>
                ))}
```

`apps/web-next/app/settings/page.tsx`：`useProviderModels()` 解构出 `setContext`，`<ProviderFormModal … onSetModelContext={setContext} />`；失败提示沿用该页既有的 `onError` 口径（一次失败的 PUT 要说清是哪个模型——`onSetModelContext` 用 `(modelId, contextWindow) => void setContext(providerId, modelId, contextWindow).catch(onError)` 形态包一层，`providerId` 取 `editing?.id`）。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @aieval/ui test -- provider-form-modal` 与 `pnpm --filter web-next test`

- [ ] **Step 5: 提交**

```bash
git add packages/client/ui/src/composite/provider-form-modal.tsx packages/client/ui/src/composite/provider-form-modal.test.tsx apps/web-next/app/settings/page.tsx
git commit -m "feat(ui): 设置页显示并可就地修改模型窗口"
```

---

### Task 14: UI——创建评测的窗口标签、强度下拉、行档位展示

**Files:**
- Modify: `packages/client/ui/src/composite/run-create-panel.tsx`（`RunModelOption` + 行渲染 + `handleFinish`）、`apps/web-next/app/runs/page.tsx`（把 group 的 `efforts` 与 option 的两个新字段透给面板）、`packages/client/ui/src/composite/run-detail-panel.tsx`（行上显示档位）
- Test: `packages/client/ui/src/composite/run-create-panel.test.tsx`、`packages/client/ui/src/composite/run-detail-panel.test.tsx`

**Interfaces:**
- Consumes: Task 11 的 `AgentModelOption.{contextWindow,efforts,recommendedEffort}` 与 `AgentOptionGroup.efforts`
- Produces: 行内第三个下拉（强度），提交进 `RunCreate.rows[].effort`

- [ ] **Step 1: 写失败的测试**

```tsx
  it('强度下拉只列交集，默认选中项是「默认」而不是推荐档；换模型清空已选强度', async () => {
    const options = [
      { providerId: 'p', providerName: 'P', modelId: 'three', source: 'manual' as const, contextWindow: 1_048_576, efforts: ['low', 'high', 'max'], recommendedEffort: 'high' },
      { providerId: 'p', providerName: 'P', modelId: 'none', source: 'manual' as const, efforts: [] },
    ];
    render(<RunCreatePanel cases={[caseFixture]} modelOptionsFor={() => options} saving={false} onSubmit={onSubmit} onCancel={vi.fn()} />);

    await userEvent.click(screen.getByLabelText('模型'));
    await userEvent.click(screen.getByText('three'));
    expect(screen.getByText('1.05M')).toBeTruthy(); // 模型下拉里的窗口标签

    await userEvent.click(screen.getByLabelText('思考强度'));
    expect(screen.getByText('high（推荐）')).toBeTruthy();
    expect(screen.queryByText('xhigh')).toBeNull(); // 交集之外的档位一个都不出现

    await userEvent.click(screen.getByText('high（推荐）'));
    // 换模型必须作废强度（与「换智能体作废模型」同一口径）
    await userEvent.click(screen.getByLabelText('模型'));
    await userEvent.click(screen.getByText('none'));
    expect(screen.queryByText('high（推荐）')).toBeNull();
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @aieval/ui test -- run-create-panel`
Expected: FAIL —— 没有强度下拉。

- [ ] **Step 3: 实现**

`run-create-panel.tsx`：

```tsx
export interface RunModelOption {
  // …既有四格…
  contextWindow?: number;
  /** 上游档位 ∩ 该智能体档位（服务端已求交，spec D10）；空数组 = 只有「默认」 */
  efforts: string[];
  recommendedEffort?: string;
}

interface RowFormValue {
  agentKind?: AgentKind;
  modelKey?: string;
  /** 强度是裸字符串（档位名里没有 `::` 那种分隔符风险），不编码 */
  effort?: string;
}
```

模型下拉的 label 里在既有 Tag 旁边加 `<ContextWindowTag contextWindow={option.contextWindow} />`；行内**模型之后**加第三个 `Form.Item`（`label="思考强度"`），选项：

```tsx
                          <Select
                            allowClear
                            placeholder="默认"
                            aria-label="思考强度"
                            options={selectedEfforts.map((effort) => ({
                              value: effort,
                              label: effort === selectedRecommended ? `${effort}（推荐）` : effort,
                            }))}
                            // 换模型必须作废已选强度：交集随模型变，留着就是一个可能不在交集里的脏值
                            onChange={() => undefined}
                          />
```

其中 `selectedEfforts` / `selectedRecommended` 与模型同源：模型下拉的值是 `providerId::modelId`，用 `decodeModelKey` 解出后到该 agentKind 的候选池里找那一条（`pool.find(...)`），找不到就是 `[]`。模型的 `onChange` 里**同时**清 `effort`：

```tsx
                              onChange={() => {
                                form.setFieldValue(['rows', field.name, 'effort'], undefined);
                              }}
```

`handleFinish` 的 `rows.push` 补 `...(row.effort === undefined ? {} : { effort: row.effort })`。

`apps/web-next/app/runs/page.tsx`：把 `listModelOptions` / 分组数据原样透传（字段是同一份对象，通常不用改；若该页对 option 做了字段挑选，补上三格）。

`run-detail-panel.tsx`：行标题旁显示 `row.effort`（有值才显示，形态如 `GLM-5.3 · high`）——「没说」与「说了 high」必须分得开。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @aieval/ui test -- run-create-panel run-detail-panel` 与 `pnpm --filter web-next test`

- [ ] **Step 5: 提交**

```bash
git add packages/client/ui/src/composite/run-create-panel.tsx packages/client/ui/src/composite/run-create-panel.test.tsx packages/client/ui/src/composite/run-detail-panel.tsx packages/client/ui/src/composite/run-detail-panel.test.tsx apps/web-next/app/runs/page.tsx
git commit -m "feat(ui): 创建评测逐行选思考强度，行上显示档位"
```

---

### Task 15: 全量检查、冒烟与关账

**Files:**
- Create: `docs/superpowers/notes/2026-09-28-agent-context-window-smoke.md`

**Interfaces:**
- Consumes: Task 1–14 的全部产出
- Produces: 冒烟记录（四要素：范围清单 / 操作路径 / 证据 / 未覆盖项），spec §10 的十条验收逐条落证据

- [ ] **Step 1: 三条聚合命令**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: 三绿。**记录用例总数**（`pnpm test` 的输出里逐包统计），与改动前对比只增不减——漏收集一整个包是静默漏测。

- [ ] **Step 2: 起服务并拉取模型清单**

Run: `pnpm dev`（端口被占用时先 kill 占用进程），浏览器打开 `http://localhost:3083/settings`。
在 likecode 供应商上点「拉取模型」，然后逐条核对：46 条显示窗口、`gpt-image-2` 显示「未知」；
用 CLI 复核落盘事实：

```bash
node -e "const c=require(process.env.USERPROFILE+'/.aieval/config.json');const m=c.providers.find(p=>p.name==='likecode').models;console.log(m.length, m.filter(x=>x.contextWindow).length, m.find(x=>x.id==='Claude-Sonnet-4.6')?.contextWindow, m.find(x=>x.id==='jd/glm-5.2')?.contextWindow)"
```

Expected: `47 46 1000000 1048576`（窗口条数与 §1.1 实测分布一致）。

- [ ] **Step 3: 手工覆盖的往返**

在设置页把 `Claude-Sonnet-4.6` 的窗口改成 `200000` 并保存 → 标签出现「手工」→ 再点一次「拉取模型」→ 断言窗口仍是 `200000`（CLI 复核同上，把 id 换掉）。

- [ ] **Step 4: 真实跑一轮（含 Review Focus 与 spec §10 的硬验收）**

创建一轮评测，至少三行：cc + `GLM-5.3`（1,048,576，**非 Claude 名字 + ≥1M，这是 spec §9 第 1 条那条硬验收**）、codex + `GLM-5.3`（强度选 `high`）、dsh + `GLM-5.3`（强度选 `high`）。开始跑，等三行都进终态。
证据：
- cc 行的服务端 DEBUG 日志（`AIEVAL_DEBUG=1`）里 `model` 是 `GLM-5.3[1m]` 且该行**没有**因模型名报 404/AUTH 类错误；
- codex 行的 `--config model_context_window=1048576` 出现在 CLI 实参（DEBUG 日志或 `codex` 的 stdout 事件）；
- dsh 行的 `<workspaceRoot>/<runId>/rows/<rowId>/.agenthome/settings.yaml` 内容正确，且该行事件流里 `request/context` 报出 `1048576`；
- 评测详情里三行分别显示 `· high`、`· high`、`· high`（cc 行没选强度则不显示）。

**若 cc 行在非 Claude 名字上失败**（`[1m]` 被网关当成模型名）：立刻停下，把症状与日志记进 notes，**不要**就地改成「只对 Claude 加后缀」——那是 spec §9 第 1 条规定的另开一条需求。

- [ ] **Step 5: 写冒烟记录**

`docs/superpowers/notes/2026-09-28-agent-context-window-smoke.md`，按 AGENT.md 的四要素写：① 范围清单（spec §10 十条逐条 ✅/❌/跳过+理由）；② 操作路径（点击/输入序列）；③ 证据（浏览器状态 + CLI 输出互证，粘贴命令与原始输出）；④ 未覆盖项与后续计划（例如：原生 anthropic 官方的 `/models` 不带窗口，走的是手工填路径，本轮未覆盖）。

- [ ] **Step 6: 提交**

```bash
git add docs/superpowers/notes/2026-09-28-agent-context-window-smoke.md
git commit -m "docs(notes): 上下文窗口与强度冒烟记录"
```

---

## 计划自审（写完即做）

**Spec 覆盖**：§4.1 契约 → Task 1/9；§4.2 route → Task 6；§4.3 投影与校验 → Task 11；§4.4 行快照与 `effort` 位置 → Task 11；§5.1/5.4 取数 → Task 2/9；§5.2/5.5 合并 → Task 3/9；§5.3 手工维护 → Task 4/5；§6.1 cc → Task 6；§6.2 codex → Task 7；§6.3 dsh → Task 8；§6.4 强度三家 → Task 10；§7 界面 → Task 12/13/14；§8 测试 → 每个任务的 Step 1；§9 风险 → Review Focus + Task 15 Step 4；§10 验收 → Task 15。无遗漏。

**类型一致性**：`contextWindow` / `maxOutputTokens` / `contextWindowSource` / `supportedEfforts` / `recommendedEffort` / `efforts` / `reasoningEfforts` / `effort` 八个名字自始至终只有一种拼写；`buildCodexConfig(baseUrl, contextWindow?)`、`setProviderModelContext(providerId, input)`、`useProviderModels().setContext(id, modelId, contextWindow)`、`intersectEfforts(model, agentEfforts)`、`formatContextWindow(contextWindow?)` 五个新签名在产出它们的任务与消费它们的任务里逐字一致。

**占位符扫描**：无 TBD / TODO / 「类似 Task N」；每个代码步骤都给了可直接粘贴的代码或精确的文件锚点。

**Review Focus 落点**：五条分别落在 Task 2 Step 1（#1 #3）、Task 2/3 Step 1（#2）、Task 11 Step 1（#4）、Task 6 Step 1（#5）。
