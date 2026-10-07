# dsh 逐条消息用量（消息级）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** dsh 行的抽屉里，每条 assistant 消息都显示它**自己那一次模型调用**的用量（输入/缓存/输出），主会话与子会话消息同样。

**Architecture:** 契约的消息信封加一格**可选** `usage`；三家共用的合并器按「带值覆盖、缺省保留」把它带上；dsh 适配器从 wire 的 `assistant/message.data.usage` 填值（读函数落在 `protocol.ts`，避免与 `events.ts` 成环）；界面把它摊到块上，时间轴在每轮渲染块之后按 `mergeKey` 去重，每条 assistant 消息渲染一行页脚。

**Tech Stack:** TypeScript 5（`strict` + `verbatimModuleSyntax`）、zod 3、vitest 4、React 19 + antd 6。

**Spec:** `docs/superpowers/specs/2026-10-01-agent-message-spec-design-v3.md` §2.2 / §3.1 / §3.2 + `2026-09-30-exec-log-drawer-redesign-design.md` §6.11 / §6.13（本线的过程 spec 已并入这两份文档并从库中删除）

## Global Constraints

- **只做 dsh**：claude-code（wire 的 `output_tokens` 恒 0）与 codex（wire 没有消息级 usage）本次**不接真值**，只把 `MessageDraft.usage` 补 `null`。
- **行级口径一个字节都不动**：`state.usage*` 的累加、`usage` 事件的累计里程碑、`EvalRow.tokens`、`subagentTokens` / `subagentTurns`。
- **契约层 `usage` 必须 `.optional()`**（磁盘上已有大量没有这一格的 `messages.jsonl`），**草稿层 `MessageDraft.usage` 必填可空**（`tsc` 负责列出全部构造点）。
- **不填 0**：三项（`input` / `cached` / `output`）缺一 ⇒ 整格 `null`；可选两格（`reasoningOutput` / `total`）读不到就是 `null`。
- **UI 侧判断**：`usage === null`（含整格缺键）⇒ 页脚整行**不渲染**（不是 0、不是「未采集」）。
- **页脚文案是「本条 输入 … · 缓存 … · 输出 …」**（不是「用量 …」）：同屏已有行级事实条与轮末里程碑 Tag 两处同形数字。
- 数字格式化**复用** `formatCount`（`packages/client/ui/src/base/metric-line.tsx`）；不新写千分位实现。
- 样式一律走 antd（`Typography.Text type="secondary"`），**不手写字号**、不手调行内边距。
- 源码一律 ESM；注释用中文 JSDoc（先说做什么、再说怎么做）。
- 提交**逐个显式 `git add <路径>`**，禁止 `git add -A`；`git status` 里不属于本次的文件保持原样。
- 每个 Task 收尾跑：`pnpm typecheck` → `pnpm lint` → 该 Task 的测试文件；全部完成后跑一次全量 `pnpm test`。
- **每条新守卫都要做变异验证**：把它要拦的缺陷人为制造回去、确认该守卫**失败**，再还原并核对文件哈希未变。

---

### Task 1: contracts —— 消息信封加一格 `usage`

**Files:**
- Modify: `packages/server/contracts/src/agent-message.ts:300-305`
- Test: `packages/server/contracts/src/agent-event.test.ts`

**Interfaces:**
- Produces: `AgentMessage.usage?: UsageTokens | null`（Task 2 的合并器输出这一格，Task 4 读它）
- Consumes: 既有 `UsageTokensSchema`（`packages/server/contracts/src/agent-event.ts:63`，`agent-message.ts:19` 已 import）

- [ ] **Step 1: 写失败测试**

在 `packages/server/contracts/src/agent-event.test.ts` 里加这一组（文件顶部第 11 行的 import 补 `AgentMessageSchema`：`import { AGENT_EVENT_TYPES, AgentEventSchema, AgentMessageSchema } from './agent-event';` 之外，`AgentMessageSchema` 来自 `./agent-message`，写成单独一行 `import { AgentMessageSchema } from './agent-message';`）：

```ts
/**
 * 消息级用量（2026-10-06，spec `2026-10-06-dsh-per-message-usage-design.md` §3.1）。
 * 两条判据的靶子：① 老 `messages.jsonl` 里**没有这一格**，写必填会让回放成片失败；
 * ② 这一格进的是「该次模型调用的用量」，三项必填、可选两格可缺可空，但绝不接受非数字。
 */
describe('AgentMessageSchema 的消息级 usage（2026-10-06）', () => {
  const messageBase = {
    messageId: 'run-1:1',
    vendorId: null,
    role: 'assistant' as const,
    source: 'wire' as const,
    roundTrip: 1,
    vendorTurn: null,
    step: null,
    parentCallId: null,
    subagentId: null,
    chunk: 'snapshot' as const,
    assembly: 'snapshot' as const,
    mergeKey: 'main|1|assistant|-',
    blocks: [{ type: 'text' as const, text: '正文' }],
    raw: null,
  };

  it('老消息（没有 usage 键）照样解析成功', () => {
    expect(AgentMessageSchema.safeParse(messageBase).success).toBe(true);
  });

  it('带 usage 时逐字保留；显式 null 合法', () => {
    const parsed = AgentMessageSchema.parse({
      ...messageBase,
      usage: { input: 295, cached: 7424, output: 841 },
    });
    expect(parsed.usage).toEqual({ input: 295, cached: 7424, output: 841 });
    expect(AgentMessageSchema.safeParse({ ...messageBase, usage: null }).success).toBe(true);
  });

  it('三项必填、可选两格可缺可空，但不接受非数字', () => {
    expect(AgentMessageSchema.safeParse({ ...messageBase, usage: { input: 1, cached: 2 } }).success).toBe(false);
    expect(
      AgentMessageSchema.safeParse({ ...messageBase, usage: { input: '1', cached: 2, output: 3 } }).success,
    ).toBe(false);
    expect(
      AgentMessageSchema.parse({ ...messageBase, usage: { input: 1, cached: 2, output: 3, reasoningOutput: null, total: 7 } })
        .usage,
    ).toEqual({ input: 1, cached: 2, output: 3, reasoningOutput: null, total: 7 });
  });
});
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `pnpm vitest run packages/server/contracts/src/agent-event.test.ts`
Expected: FAIL —— 第 2/3 条在 `usage` 被 strip 后 `parsed.usage` 是 `undefined`（`toEqual({...})` 红）。

- [ ] **Step 3: 实现（最小改动）**

在 `packages/server/contracts/src/agent-message.ts` 的 `AgentMessageSchema` 里，`blocks` 与 `raw` 之间插入：

```ts
  /** 内容块，按到达顺序；数组下标就是块序号 */
  blocks: z.array(ContentBlockSchema),
  /**
   * 这条消息所属的**那一次模型调用**的用量（2026-10-06 新增；本仓只有 dsh 交）。
   *
   * 不是累计、**不进任何合计** —— 与 `roundTrip` / `step` 各自独立：那两格回答「这是第几次往返」，
   * 这一格回答「这一次往返花了多少」。三条口径：
   *   · **整格可选**：磁盘上已有大量没有这一格的 `messages.jsonl`，写成必填会让回放 / SSE 续订成片失败；
   *   · **键缺席与显式 `null` 同义**（都是「这条消息没有消息级用量」）——这一格不像
   *     `subagentTokens` 那样有三态语义；
   *   · **不填 0**：三项缺一时整格是 `null`（`{0,0,0}` 会被读成「确实没花」）。
   */
  usage: UsageTokensSchema.nullable().optional(),
  /** 该条消息的原始载荷（未归类字段原样保留，供排障） */
  raw: z.unknown(),
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run packages/server/contracts/src/agent-event.test.ts`
Expected: PASS

- [ ] **Step 5: 变异验证**

把 `usage: UsageTokensSchema.nullable().optional(),` 临时改成 `usage: UsageTokensSchema.nullable(),`（去掉 `.optional()`），
跑同一条命令，期望**「老消息（没有 usage 键）照样解析成功」红**；改回后再跑一次，期望全绿。
核对文件哈希：`Get-FileHash packages/server/contracts/src/agent-message.ts`（变异前后除这一次改动外应完全一致）。

- [ ] **Step 6: 提交**

```bash
git add packages/server/contracts/src/agent-message.ts packages/server/contracts/src/agent-event.test.ts
git commit -m "feat(contracts): 消息信封新增可选的逐条用量 usage"
```

---

### Task 2: agents 合并器 —— 草稿层带 `usage`，按「带值覆盖、缺省保留」合并

**Files:**
- Modify: `packages/server/agents/src/message.ts`（`MessageDraft`、`Carrier`、`createMessageAssembler` 的 `ingest`）
- Test: `packages/server/agents/src/message.test.ts`
- Modify（补 `usage: null`，共 25 处生产点 + 全部测试夹具）：见 Step 4 的清单

**Interfaces:**
- Consumes: `UsageTokens`（`@aieval/contracts`，`message.ts` 已 import）
- Produces: `MessageDraft.usage: UsageTokens | null`（必填可空）、`AgentMessage.usage`（Task 3 的 dsh 适配器填值，Task 4 的界面读它）

- [ ] **Step 1: 写失败测试**

在 `packages/server/agents/src/message.test.ts` 的 `draft()` 工厂里补默认值（`MessageDraft` 变必填后会先撞类型错误）：

```ts
function draft(overrides: Partial<MessageDraft> & Pick<MessageDraft, 'blocks'>): MessageDraft {
  return {
    vendorId: null,
    role: 'assistant',
    source: 'wire',
    roundTrip: 1,
    vendorTurn: null,
    step: null,
    parentCallId: null,
    subagentId: null,
    chunk: 'snapshot',
    // 消息级用量：这一层默认「没有」（用例要显式给才成立）
    usage: null,
    raw: null,
    ...overrides,
  };
}
```

再加一组用例：

```ts
/**
 * 消息级用量的合并（2026-10-06，spec §3.2）。三条判据各自的靶子：
 *   · 带值 ⇒ 落到信封上（否则界面上永远没有这一格）；
 *   · 后到不带值 ⇒ **保留**（同一条逻辑消息会多次投递：增量块 / block-end 快照，usage 只在完整
 *     assistant/message 那一次到达；错成「后到覆盖」会把已采到的用量抹掉）；
 *   · 后到带新值 ⇒ 覆盖（它是「这一次调用」的值，不是累加）。
 */
describe('消息级 usage 的合并（2026-10-06）', () => {
  const tokens = { input: 295, cached: 7424, output: 841, reasoningOutput: null, total: null };
  const next = { input: 210, cached: 8448, output: 562, reasoningOutput: null, total: null };

  it('投递带 usage ⇒ 原样落到信封上', () => {
    const messages = run([draft({ usage: tokens, blocks: [textBlockDraft('正文', 'snapshot')] })]);
    expect(messages.at(-1)?.usage).toEqual(tokens);
  });

  it('后到的投递不带 usage ⇒ 保留已采到的值（快照覆盖内容但不抹掉计量）', () => {
    const messages = run([
      draft({ usage: tokens, blocks: [textBlockDraft('半截', 'delta')] }),
      draft({ usage: null, blocks: [textBlockDraft('完整这句', 'snapshot')] }),
    ]);
    expect((messages.at(-1)?.blocks[0] as { text: string }).text).toBe('完整这句');
    expect(messages.at(-1)?.usage).toEqual(tokens);
  });

  it('后到的投递带新 usage ⇒ 覆盖（不是相加）', () => {
    const messages = run([
      draft({ usage: tokens, blocks: [textBlockDraft('第一版', 'snapshot')] }),
      draft({ usage: next, blocks: [textBlockDraft('第二版', 'snapshot')] }),
    ]);
    expect(messages.at(-1)?.usage).toEqual(next);
  });

  it('从没带过 ⇒ 是 null（草稿层的 null 原样进信封，不是 undefined）', () => {
    const messages = run([draft({ usage: null, blocks: [textBlockDraft('正文', 'snapshot')] })]);
    expect(messages.at(-1)?.usage).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `pnpm vitest run packages/server/agents/src/message.test.ts`
Expected: FAIL —— `pnpm typecheck` 先报一批 `usage` 缺失的类型错误；补完接口后这一组里 `messages.at(-1)?.usage` 是 `undefined`。

- [ ] **Step 3: 实现（`message.ts` 三处）**

① `MessageDraft` 加一格：

```ts
export interface MessageDraft {
  // …既有字段（vendorId / role / source / roundTrip / vendorTurn / step / parentCallId / subagentId / chunk / blocks / raw）
  /**
   * 这条消息**自己那一次模型调用**的用量。**草稿层必填**（没有就写 `null`）：
   * 三家都必须显式交这一格 ⇒ `tsc` 会把全部构造点列出来，不会出现「某家 `undefined`、某家 `null`」的漂移
   * （与 `timing` / `subagentTokens` 同一条处置）。它与行级累计口径无关：不是累计、不进任何合计。
   */
  usage: UsageTokens | null;
}
```

② `Carrier` 加一格：

```ts
interface Carrier {
  key: string;
  /** 块标识 → 槽位（保持插入顺序 = 首次到达顺序） */
  slots: Map<string, BlockSlot>;
  /** 已分配出去的文本/思考块序号：新块只能追加到末尾 */
  nextIndex: number;
  /** 这条逻辑消息到目前为止采到的用量（带值覆盖、缺省保留，见 `ingest`） */
  usage: UsageTokens | null;
}
```

③ `createMessageAssembler` 的 `ingest` 里：建 carrier 时初始化为 `usage: null`；在 `applyBlock` 循环**之前**更新它；产出消息时带上：

```ts
    ingest(draft, onMessage) {
      if (draft.blocks.length === 0) return;
      const carrierKey = carrierKeyOf(draft);
      let carrier = carriers.get(carrierKey);
      if (carrier === undefined) {
        carrier = { key: carrierKey, slots: new Map(), nextIndex: 0, usage: null };
        carriers.set(carrierKey, carrier);
      }
      /**
       * 带值覆盖、缺省保留：同一条逻辑消息会多次投递（增量块 / `block-end` 快照），
       * 而用量只在完整 `assistant/message` 那一次到达 ⇒ 后到的投递不带它时**必须保留**已采到的值
       * （改成「后到覆盖」会把已经采到的计量抹掉，界面上表现为页脚自己消失）。
       * 也不累加：它是「这一次调用」的值，累加是行级 `tokens` 那一格的事。
       */
      if (draft.usage !== null) carrier.usage = draft.usage;
      for (const blockDraft of draft.blocks) {
        applyBlock(carrier, blockDraft);
      }
      seq += 1;
      const slots = [...carrier.slots.values()];
      onMessage({
        messageId: `${options.runId}:${seq}`,
        // …既有字段原样
        usage: carrier.usage,
        blocks: slots.map((slot) => slot.block),
        raw: draft.raw,
      });
    },
```

- [ ] **Step 4: 补全部构造点（`tsc` 兜底列出）**

Run: `pnpm typecheck`
Expected: 报出一批「`usage` 缺失」的类型错误。**已知的生产落点**（本计划写定时逐一核对过）：

| 文件 | 行 |
|---|---|
| `packages/server/agents/src/providers/dsh/message.ts` | 161、190、224 |
| `packages/server/agents/src/providers/codex/events.ts` | 214 |
| `packages/server/agents/src/providers/codex/message.ts` | 194、205、227、255、282 |
| `packages/server/agents/src/providers/codex/message-events.ts` | 115、126、170、176、208、215、235、242、265、268、289 |
| `packages/server/agents/src/providers/claude-code/message.ts` | 297、350、407 |

处置：在这 25 处各补一行 `usage: null,`（**只有 Task 3 的 `dshAssistantMessageDraft` 例外**——它这一步先补 `null`，Task 3 再改成真值；`codex/message-events.ts:268` 那处是对象展开的字面量，补法与其它处相同）。

测试夹具同样会报错（`turn.test.ts`、`providers/message-conformance.test.ts`、`providers/claude-code/message*.test.ts`、`providers/codex/*.test.ts`、`providers/dsh/events.test.ts` 等）：
- 有 `draft()` / `message()` 之类工厂的文件：**只改工厂一处**（加 `usage: null`）；
- 直接写 `MessageDraft` 字面量的文件：逐个补（同样以 `pnpm typecheck` 的输出为完整清单）。

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm typecheck` → `pnpm vitest run packages/server/agents/src/message.test.ts`
Expected: 类型错误清零；新用例全绿；既有用例**一条都不改判据**。

- [ ] **Step 6: 变异验证**

把 `if (draft.usage !== null) carrier.usage = draft.usage;` 临时改成无条件赋值 `carrier.usage = draft.usage;`，
跑 `pnpm vitest run packages/server/agents/src/message.test.ts`，期望**「后到的投递不带 usage ⇒ 保留已采到的值」红**；改回后全绿。

- [ ] **Step 7: 提交**

```bash
git add packages/server/agents/src/message.ts packages/server/agents/src/message.test.ts packages/server/agents/src/providers
git commit -m "feat(agents): 归一草稿与合并器带上消息级 usage（三家构造点补 null）"
```

---

### Task 3: dsh 适配器 —— wire 的 `data.usage` 进这条消息

**Files:**
- Modify: `packages/server/agents/src/providers/dsh/protocol.ts`（新增 `DSH_USAGE_FIELDS` + `readUsageTokens`）
- Modify: `packages/server/agents/src/providers/dsh/events.ts:129-141`（删本地字段名定义，改为 re-export）与 `:752-770`（`readTokens` 复用纯读函数）
- Modify: `packages/server/agents/src/providers/dsh/message.ts:109-165`（`dshAssistantMessageDraft` 填 `usage`）
- Test: `packages/server/agents/src/providers/dsh/events.test.ts`

**Interfaces:**
- Consumes: `MessageDraft.usage`（Task 2）
- Produces: `DSH_USAGE_FIELDS`（仍在 `protocol.ts` 导出，并从 `events.ts` re-export）、`readUsageTokens(usage: unknown): UsageTokens | null`（纯函数）

- [ ] **Step 1: 写失败测试**

在 `packages/server/agents/src/providers/dsh/events.test.ts` 的 `describe('projectDshNotification（按实测回写）')` 之后加一组：

```ts
/**
 * 消息级用量（2026-10-06，spec §3.3）。三条判据：
 *   · wire 上的 `data.usage` **逐字**进这条消息的 `usage`（不是累计快照、不是行级 tokens）；
 *   · 三项缺一 ⇒ 消息级与行级**同时**是「未采集」（都不填 0）；
 *   · 子会话的消息同样带它自己的用量（与主会话共用同一个归一函数）。
 */
describe('assistant/message 的消息级 usage（2026-10-06）', () => {
  it('wire 的 data.usage 逐字进这条消息的 usage', () => {
    const projection = projectDshNotification(
      sessionEvent(DSH_ASSISTANT_MESSAGE_TYPE, {
        turn: 1,
        step: 1,
        usage: { [DSH_USAGE_FIELDS.input]: 295, [DSH_USAGE_FIELDS.cached]: 7424, [DSH_USAGE_FIELDS.output]: 841 },
        message: { role: 'assistant', content: [{ type: 'text', text: '好' }] },
      }),
      newState(),
      CONTEXT,
    );

    expect(projection.messages?.[0]?.usage).toEqual({
      input: 295,
      cached: 7424,
      output: 841,
      reasoningOutput: null,
      total: null,
    });
  });

  it('三项缺一 ⇒ 消息级是 null（不填 0），行级同样是「未采集」', () => {
    const state = newState();
    const projection = projectDshNotification(
      sessionEvent(DSH_ASSISTANT_MESSAGE_TYPE, {
        turn: 1,
        step: 1,
        // 没有 cacheReadTokens：dsh 的缓存命中是**独立一格**，缺它就不算读全（不填 0）
        usage: { [DSH_USAGE_FIELDS.input]: 12, [DSH_USAGE_FIELDS.output]: 5 },
        message: { role: 'assistant', content: [{ type: 'text', text: '好' }] },
      }),
      state,
      CONTEXT,
    );

    expect(projection.messages?.[0]?.usage).toBeNull();
    expect(projection.tokens).toBeNull();
  });

  it('子会话的消息同样带它自己的用量', () => {
    // 先按真机外形登记子会话（`sessionIdProfileSubagent` 只认登记过的 id）
    projectDshNotification(
      { method: 'subagent.started', params: { parentSessionId: 'session-1', childSessionId: 'child-1' } },
      newState(),
      CONTEXT,
    );
    const projection = projectDshNotification(
      sessionEvent(
        DSH_ASSISTANT_MESSAGE_TYPE,
        {
          turn: 1,
          step: 2,
          usage: { [DSH_USAGE_FIELDS.input]: 1002, [DSH_USAGE_FIELDS.cached]: 8320, [DSH_USAGE_FIELDS.output]: 1531 },
          message: { role: 'assistant', content: [{ type: 'text', text: '子会话答复' }] },
        },
        'child-1',
      ),
      newState(),
      CONTEXT,
    );

    expect(projection.messages?.[0]?.subagentId).toBe('child-1');
    expect(projection.messages?.[0]?.usage).toEqual({
      input: 1002,
      cached: 8320,
      output: 1531,
      reasoningOutput: null,
      total: null,
    });
  });
});
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `pnpm vitest run packages/server/agents/src/providers/dsh/events.test.ts`
Expected: FAIL —— `projection.messages?.[0]?.usage` 是 `undefined`。

- [ ] **Step 3: 把字段名表与纯读函数搬进 `protocol.ts`**

在 `packages/server/agents/src/providers/dsh/protocol.ts` 末尾追加（文件头注释补一句「本文件同时是 dsh 用量字段名与读法的唯一真源」）：

```ts
import type { UsageTokens } from '@aieval/contracts';
import { asRecord, readNumber } from '../../json';
```

> ⚠️ import 必须放在文件顶部（与既有常量声明同层，ESLint 的 `import/first` 会拦）。

```ts
/**
 * 用量三元组的字段名，**逐字来自真实探测**（`assistant/message → data.usage`）：
 * `{"inputTokens":218,"outputTokens":2,"cacheReadTokens":8832,…}`。
 *
 * ⚠️ 2026-10-06 从 `events.ts` 搬来这里：`message.ts`（消息归一）也要按同一份字段名读，
 * 而 `events.ts` 已经 import `message.ts` ⇒ 留在那边就是**循环依赖**。
 * `events.ts` 继续 re-export 这个名字，既有 import 路径不动。
 */
export const DSH_USAGE_FIELDS = {
  input: 'inputTokens',
  cached: 'cacheReadTokens',
  output: 'outputTokens',
  /** 思考 token（`TokenUsage.reasoningTokens`，类型上可选）：**采不到就是 null，不填 0** */
  reasoning: 'reasoningTokens',
  /** 厂商自报的总量（`TokenUsage.totalTokens`）：**只是证据**，不参与归一后的恒等式（见契约注释） */
  total: 'totalTokens',
} as const;

/**
 * 读一次模型调用的用量：三项（非缓存输入 / 缓存读 / 输出）缺一 ⇒ `null`（**不填 0**）；
 * 可选两格（思考 token、厂商总量）读不到就是 `null`。
 *
 * **纯函数**：不落日志、不改状态——落 WARN 是调用方（`events.ts` 的 `readTokens`）的事，
 * 因为消息归一那一层没有 drafts 收集器（这是我们把它抽出来的直接原因）。
 */
export function readUsageTokens(usage: unknown): UsageTokens | null {
  const record = asRecord(usage);
  const input = readNumber(record, DSH_USAGE_FIELDS.input);
  const cached = readNumber(record, DSH_USAGE_FIELDS.cached);
  const output = readNumber(record, DSH_USAGE_FIELDS.output);
  if (input === null || cached === null || output === null) return null;
  return {
    input,
    cached,
    output,
    reasoningOutput: readNumber(record, DSH_USAGE_FIELDS.reasoning),
    total: readNumber(record, DSH_USAGE_FIELDS.total),
  };
}
```

- [ ] **Step 4: `events.ts` 改为复用（行为逐字不变）**

① 删掉 `events.ts:129-141` 那一段 `DSH_USAGE_FIELDS` 定义，改成 re-export（放在既有 import 之后）：

```ts
/**
 * 字段名表已搬到 `protocol.ts`（2026-10-06：`message.ts` 也要按同一份字段名读，
 * 留在本文件会与 `message.ts` 形成循环依赖）。这里 re-export 保持既有 import 路径不动
 * （`events.test.ts` 从 `./events` import 它）。
 */
export { DSH_USAGE_FIELDS } from './protocol';
```

② `events.ts` 的 import 行补 `readUsageTokens`（`from './protocol'`）。

③ `events.ts:752-770` 的 `readTokens` 改成：

```ts
function readTokens(usage: unknown, drafts: AgentEventDraft[]): UsageTokens | null {
  const tokens = readUsageTokens(usage);
  if (tokens === null) {
    drafts.push(
      logDraft('stderr', `[WARN] 用量负载不完整，本次运行按「未采集计量」处理（不填 0）：${safeStringify(usage)}`),
    );
  }
  return tokens;
}
```

- [ ] **Step 5: `message.ts` 的 `dshAssistantMessageDraft` 填值**

import 行补 `readUsageTokens`（`from './protocol'`），然后在该函数的返回对象里（`chunk: 'snapshot',` 之前）加：

```ts
    chunk: 'snapshot',
    /**
     * 这条消息**自己那一次调用**的用量（2026-10-06）：wire 上每条 `assistant/message` 的
     * `data.usage` 就是它。**不参与行级累计**（那是 `events.ts` 的 `state.usage*` 与 `cumulativeTokens` 的事），
     * 也不是「到这一步为止」的快照。子会话消息走同一个函数 ⇒ 同样带上。
     */
    usage: readUsageTokens(data?.usage),
    blocks,
```

- [ ] **Step 6: 跑测试确认通过**

Run: `pnpm typecheck` → `pnpm vitest run packages/server/agents/src/providers/dsh`
Expected: 全绿；**既有用例一条都不改判据**（尤其 `events.test.ts` 里那些行级 `tokens` / `turns` / 子份两格的用例）。

- [ ] **Step 7: 行级不变钉（守卫 4）**

在 `events.test.ts` 里加一条**同时**断言两处口径的用例（这是本次改动的回归钉）：

```ts
it('消息级用量与行级累计并存且互不影响（2026-10-06）', () => {
  const state = newState();
  const first = projectDshNotification(
    sessionEvent(DSH_ASSISTANT_MESSAGE_TYPE, {
      turn: 1,
      step: 1,
      usage: { [DSH_USAGE_FIELDS.input]: 295, [DSH_USAGE_FIELDS.cached]: 7424, [DSH_USAGE_FIELDS.output]: 841 },
      message: { role: 'assistant', content: [{ type: 'text', text: '第一条' }] },
    }),
    state,
    CONTEXT,
  );
  const second = projectDshNotification(
    sessionEvent(DSH_ASSISTANT_MESSAGE_TYPE, {
      turn: 1,
      step: 2,
      usage: { [DSH_USAGE_FIELDS.input]: 210, [DSH_USAGE_FIELDS.cached]: 8448, [DSH_USAGE_FIELDS.output]: 562 },
      message: { role: 'assistant', content: [{ type: 'text', text: '第二条' }] },
    }),
    state,
    CONTEXT,
  );

  // 消息级：每条各是它自己那一次调用的值（不是累计）
  expect(first.messages?.[0]?.usage?.input).toBe(295);
  expect(second.messages?.[0]?.usage?.input).toBe(210);
  // 行级：两次之和（既有口径一个字不动）
  expect(second.tokens).toEqual({ input: 505, cached: 15872, output: 1403, reasoningOutput: null, total: null });
});
```

- [ ] **Step 8: 变异验证（两条）**

① 把 `usage: readUsageTokens(data?.usage),` 改成 `usage: null,` ⇒ 新用例红、`subagentId` 那条也红；
② 把 `readTokens` 里的 `readUsageTokens(usage)` 换成 `null` ⇒ **既有行级用例**红（这条钉的是「搬家没有偷偷改行级读法」）。
各自改回后跑 `pnpm vitest run packages/server/agents/src/providers/dsh` 全绿。

- [ ] **Step 9: 提交**

```bash
git add packages/server/agents/src/providers/dsh/protocol.ts packages/server/agents/src/providers/dsh/events.ts packages/server/agents/src/providers/dsh/message.ts packages/server/agents/src/providers/dsh/events.test.ts
git commit -m "feat(agents/dsh): assistant/message 的用量进这条消息（纯读函数落 protocol）"
```

---

### Task 4: 界面模型 —— 把 `usage` / `mergeKey` 摊到块上

**Files:**
- Modify: `packages/client/ui/src/composite/agent-log/types.ts:114-127`（`ContentBlockBase`）
- Modify: `packages/client/ui/src/composite/agent-log/build-model.ts:115-125`（`toContentBlock` 的 `base`）
- Test: `packages/client/ui/src/composite/agent-log/build-model.test.ts`
- Modify（夹具补两格）：`agent-message-timeline.test.tsx`、`build-model.test.ts`、`agent-log-layout.test.tsx`、`virtual-turn-list.test.tsx`、`fixtures.ts`、`render-blocks.test.ts`、`agent-log-drawer.test.tsx` 等（`pnpm typecheck` 输出为完整清单）

**Interfaces:**
- Consumes: `AgentMessage.usage` / `AgentMessage.mergeKey`（Task 1 / Task 2）
- Produces: `ContentBlockBase.usage: AgentTokens | null`、`ContentBlockBase.mergeKey: string`（Task 5 的时间轴页脚读它们）

- [ ] **Step 1: 写失败测试**

在 `build-model.test.ts` 的 `message()` 工厂里给默认值补 `usage: null`（必填格），并加一组用例：

```ts
/**
 * 消息级用量摊到块上（2026-10-06，spec §3.4）。两条判据：
 *   · 同一条消息的每个块都带**同一个** `usage` 与 `mergeKey`（页脚靠 mergeKey 去重，靠 usage 取值）；
 *   · 契约缺这一格（老日志）时 UI 侧是 `null`（不是 `undefined`）——页脚的「没有就不画」判据要能吃它。
 */
describe('消息级用量与逻辑消息身份摊到块上（2026-10-06）', () => {
  /** 取主会话节点上摊平的块（`content` 未就绪就抛——与文件里其余用例同一条写法） */
  function mainBlocks(model: ReturnType<typeof buildAgentLogModel>) {
    const main = model.nodes.find((node) => node.kind === 'main');
    if (main?.content.status !== 'ready') throw new Error('主会话内容应就绪');
    return main.content.data.flatMap((turn) => turn.blocks);
  }

  it('同一条消息的每个块都带同一个 usage 与 mergeKey', () => {
    const usage = { input: 295, cached: 7424, output: 841, reasoningOutput: null, total: null };
    const model = buildAgentLogModel({
      records: [
        message({
          id: 'm1',
          mergeKey: 'main|1|assistant|-',
          roundTrip: 1,
          usage,
          blocks: [
            { type: 'text', text: '正文一' },
            { type: 'text', text: '正文二' },
          ],
        }),
      ],
      events: [],
      facts: facts(),
      startedAt: '2026-10-02T10:00:00.000Z',
    });

    const blocks = mainBlocks(model);
    expect(blocks).toHaveLength(2);
    for (const block of blocks) {
      expect(block.mergeKey).toBe('main|1|assistant|-');
      expect(block.usage).toEqual({ input: 295, cached: 7424, output: 841 });
    }
  });

  it('契约没有 usage 时 UI 侧是 null（不是 undefined）', () => {
    const model = buildAgentLogModel({
      records: [message({ id: 'm2', mergeKey: 'main|1|assistant|-', roundTrip: 1, blocks: [{ type: 'text', text: '正文' }] })],
      events: [],
      facts: facts(),
      startedAt: '2026-10-02T10:00:00.000Z',
    });

    expect(mainBlocks(model)[0]?.usage).toBeNull();
  });
});
```

> `message()` 工厂新增一格参数：`usage?: AgentMessage['usage']`，并在返回对象里写 `usage: input.usage ?? null,`。
> `facts()` 与 `startedAt` 用文件里既有的写法（`buildAgentLogModel({ records, events: [], facts: facts(), startedAt: … })`）。

- [ ] **Step 2: 跑测试确认它失败**

Run: `pnpm vitest run packages/client/ui/src/composite/agent-log/build-model.test.ts`
Expected: FAIL —— `block.mergeKey` / `block.usage` 都不存在（类型错误 + 断言红）。

- [ ] **Step 3: 实现**

① `types.ts` 的 `ContentBlockBase` 加两格：

```ts
  /** 块形态。`open` = 还没收到过快照（进程被中断的块停在这里），**动效的唯一判据** */
  assembly: 'snapshot' | 'open';
  /**
   * 这条块所属的**逻辑消息**身份（= 契约的 `mergeKey`）。
   * 时间轴按它把「同一条消息的多个块」归成一条，**不得**改用 `messageId`：
   * 那是**每次投递**新分配的（同一条逻辑消息的 delta 与 snapshot 是两个不同 id）。
   */
  mergeKey: string;
  /** 这条消息自己那一次调用的用量；`null` = 没有这一格（页脚不渲染） */
  usage: AgentTokens | null;
```

② `build-model.ts` 的 `toContentBlock` 的 `base` 里加：

```ts
  const base = {
    id,
    // 契约的块没有自己的时刻，故整体用**派生的**基准时刻（见 `BuildAgentLogModelInput.startedAt`）
    at,
    messageId: message.messageId,
    subagentId: message.subagentId,
    role: message.role,
    source: message.source,
    assembly: message.assembly,
    // 逻辑消息身份与消息级用量都跟着块走：块是时间轴唯一拿得到的东西
    mergeKey: message.mergeKey,
    // 契约那一格是可选的（老日志没有）；UI 侧统一成 `null`，页脚只认「非 null」这一档
    usage:
      message.usage === undefined || message.usage === null
        ? null
        : { input: message.usage.input, cached: message.usage.cached, output: message.usage.output },
  };
```

- [ ] **Step 4: 补 UI 测试夹具**

Run: `pnpm typecheck`
Expected: 报出一批「`mergeKey` / `usage` 缺失」的类型错误。逐个补：
- 有块工厂的文件（如 `agent-message-timeline.test.tsx` 的 `textBlock` / `thinkingBlock` / `toolCall` / `toolResult` 四个工厂）：**每个工厂各补一次** `mergeKey: 'main|1|assistant|-', usage: null,`；
- 直接写块字面量的文件：逐个补（以 `pnpm typecheck` 输出为完整清单）。

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm typecheck` → `pnpm vitest run packages/client/ui/src/composite/agent-log`
Expected: 类型错误清零，全绿。

- [ ] **Step 6: 变异验证**

把 `usage` 那一处的 `null` 分支删掉（直接 `message.usage`）⇒ 第二条用例红（`undefined` ≠ `null`）；改回后全绿。

- [ ] **Step 7: 提交**

```bash
git add packages/client/ui/src/composite/agent-log/types.ts packages/client/ui/src/composite/agent-log/build-model.ts packages/client/ui/src/composite/agent-log
git commit -m "feat(ui): 消息级用量与逻辑消息身份摊到块上"
```

---

### Task 5: 时间轴 —— 每条消息一行「本条」用量页脚

**Files:**
- Modify: `packages/client/ui/src/composite/agent-log/agent-message-timeline.tsx:233-255`
- Test: `packages/client/ui/src/composite/agent-log/agent-message-timeline.test.tsx`

**Interfaces:**
- Consumes: `ContentBlockBase.usage` / `.mergeKey`（Task 4）、`formatCount`（`packages/client/ui/src/base/metric-line.tsx:140`）
- Produces: 页脚元素带 `data-usage-footer` 锚点（守卫与 L2 计数用）

- [ ] **Step 1: 写失败测试**

在 `agent-message-timeline.test.tsx` 里加一组（`textBlock` 等工厂已在 Task 4 补过 `mergeKey` / `usage` 默认值；这一组用例显式传 usage）：

```ts
/**
 * 消息级用量页脚（2026-10-06，spec §3.4 / 用户裁定「消息级没有 usage 就不展示，避免口径混乱」）。
 * 四条判据：① 一条消息一行（多个块只出一行）；② `usage === null` 一行都不出；
 * ③ 文案是「本条 …」而不是「用量 …」（同屏已有行级事实条与轮末里程碑 Tag 两处同形数字）；
 * ④ 子会话节点的消息同样渲染。
 */
describe('消息级用量页脚（2026-10-06）', () => {
  const usage = { input: 295, cached: 7424, output: 841 };
  const footers = (container: HTMLElement): string[] =>
    [...container.querySelectorAll('[data-usage-footer]')].map((node) => node.textContent ?? '');

  it('一条消息的多个块只出一行页脚，数字按 formatCount 千分位', () => {
    const turns = [
      turn({
        blocks: [
          { ...textBlock('t1', '正文'), usage },
          { ...toolCall('c1', 'call_1', 'pwsh'), usage },
        ],
      }),
    ];
    const { container } = render(<AgentMessageTimeline turns={turns} nodes={nodeIndex([])} />);

    expect(footers(container)).toEqual(['本条 输入 295 · 缓存 7,424 · 输出 841']);
    // 形制与轮末里程碑 Tag 必须两两可分（用户 2026-10-06 追加口径）：
    // 页脚是纯文本行，不许被 Tag / Badge 包成第「用量 … · 轮次 N」那种色块
    expect(container.querySelectorAll('[data-usage-footer].ant-tag')).toHaveLength(0);
  });

  it('usage 为 null 时一行都不出', () => {
    const turns = [turn({ blocks: [{ ...textBlock('t1', '正文'), usage: null }] })];
    const { container } = render(<AgentMessageTimeline turns={turns} nodes={nodeIndex([])} />);

    expect(footers(container)).toEqual([]);
  });

  it('子会话节点的消息同样出页脚', () => {
    const turns = [
      turn({ subagentId: 'sub-1', blocks: [{ ...textBlock('t1', '子会话正文'), subagentId: 'sub-1', usage }] }),
    ];
    const { container } = render(<AgentMessageTimeline turns={turns} nodes={nodeIndex([])} />);

    expect(footers(container)).toEqual(['本条 输入 295 · 缓存 7,424 · 输出 841']);
  });
});
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `pnpm vitest run packages/client/ui/src/composite/agent-log/agent-message-timeline.test.tsx`
Expected: FAIL —— `[data-usage-footer]` 一个都查不到。

- [ ] **Step 3: 实现**

在 `agent-message-timeline.tsx` 顶部补 import：`import { formatCount } from '../../base/metric-line';`。

在文件内加纯函数（放在 `TurnRow` 之前）：

```tsx
/**
 * 这一轮里**每条 assistant 消息**自己的用量（2026-10-06）。
 *
 * 为什么按 `mergeKey` 去重而不是按块渲染：同一条消息的正文块与工具调用块带的是**同一个** usage
 * ⇒ 逐块渲染会把同一行数字画两遍。`messageId` 不能用（每次投递都换新 id，见 `ContentBlockBase.mergeKey`）。
 * 为什么在轮末渲染而不是插进渲染块之间：渲染块是判别联合、相邻工具条目会并成一个 `tool-group`
 * ⇒ 渲染块的下标与 `turn.blocks` 不对齐，按块下标插入会把页脚插到错的块后面。
 */
function usageFootersOf(turn: LogTurn): { mergeKey: string; usage: AgentTokens }[] {
  const seen = new Map<string, AgentTokens>();
  for (const block of turn.blocks) {
    // 只有 assistant 消息才可能有消息级用量（工具结果消息恒 null，`null` 一档整行不画）
    if (block.role !== 'assistant' || block.usage === null) continue;
    if (!seen.has(block.mergeKey)) seen.set(block.mergeKey, block.usage);
  }
  return [...seen].map(([mergeKey, usage]) => ({ mergeKey, usage }));
}
```

在 `TurnRow` 的返回里，`blocks.map(...)` 之后、`<RowEventLines … />` 之前插入：

```tsx
        {usageFootersOf(turn).map((footer) => (
          // 锚点照 `data-turn-row` / `data-row-event` 的既有习惯：断言数自己标的属性，不数 antd 内部类名
          // `italic` 是刻意的（用户 2026-10-06 口径）：顶部事实条是正体灰字、轮末里程碑是 Tag 色块，
          // 这一行只有斜体才与前两者两两可分；antd 没有比 secondary 更弱的档，所以不引入手写样式
          <Typography.Text key={footer.mergeKey} type="secondary" italic data-usage-footer>
            本条 输入 {formatCount(footer.usage.input)} · 缓存 {formatCount(footer.usage.cached)} · 输出{' '}
            {formatCount(footer.usage.output)}
          </Typography.Text>
        ))}
```

> `AgentTokens` 类型从 `./types` 的既有 import 里补进来。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run packages/client/ui/src/composite/agent-log/agent-message-timeline.test.tsx`
Expected: PASS

- [ ] **Step 5: 变异验证（三条）**

① 把 `block.mergeKey` 去重键改成 `block.messageId`（同一消息的多块会出两行）⇒ 第 1 条用例红；
② 把 `block.usage === null` 的 `continue` 删掉、改成渲染 `0` ⇒ 第 2 条用例红；
③ 把文案「本条」改回「用量」⇒ 第 1/3 条用例红（与轮末里程碑 Tag 撞形的靶子）；
④ 把页脚改成 `<Tag>` 包裹（形制退化成里程碑那种色块）⇒ `[data-usage-footer].ant-tag` 那条断言红。
各自改回后全绿。

- [ ] **Step 6: 提交**

```bash
git add packages/client/ui/src/composite/agent-log/agent-message-timeline.tsx packages/client/ui/src/composite/agent-log/agent-message-timeline.test.tsx
git commit -m "feat(ui): 时间轴按消息渲染「本条」用量页脚"
```

---

### Task 6: 门禁与收尾

**Files:**
- 无新增/修改（只跑命令与核对）

- [ ] **Step 1: 三条门禁**

Run: `pnpm typecheck` → `pnpm lint` → `pnpm test`
Expected: 全绿。`lint` 若报格式问题，跑 `pnpm format` 后把格式修复的变更**随本次改动一并提交**。

- [ ] **Step 2: 逐条核对 spec §5 的守卫与变异**

对着 spec `2026-10-06-dsh-per-message-usage-design.md` §5 的表逐行核对：6 条守卫都有对应用例、8 个变异体都**真的见过失败**。
把每条的「变异体 → 红的用例 → 还原后哈希未变」记进实现报告。

- [ ] **Step 3: 真机冒烟（一条 dsh 行）**

跑一次真实评测（dsh 行、开一个思考档位以便同时看思考与用量），在抽屉里逐条核对：
- 每个轮次的 assistant 消息下面出现一行「本条 输入 … · 缓存 … · 输出 …」；
- 数字与 `messages.jsonl` 里那条消息的 `raw` → `params.event.data.usage` **逐字相符**；
- 子会话节点（进入子任务）里同样有它自己的页脚；
- `usage` 为 `null` 的消息**没有**页脚（不显示 0、不显示「未采集」）。

把范围清单 / 操作路径 / 证据 / 未覆盖项写进对应的冒烟记录（`docs/superpowers/notes/`）。
