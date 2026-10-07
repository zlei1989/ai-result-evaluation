# 用量里程碑按「归属会话 + 轮次号」归位 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让抽屉时间轴上的「用量 … 轮次 N」这一行落进**它自己那一轮**（按归属会话 + 该会话自己的轮次号），三家（dsh / claude-code / codex）的轮次号与消息同一个口径。

**Architecture:** 契约给 `usage` 事件加一格可选的归属 `turn = { subagentId, round }`；三家适配器各自在自己的投影里填（dsh 改成每会话自己的 `step` 号，claude 恒主会话，codex 两通道合成「只数 `AgentMessage`」一把尺子）；界面把这一格搬到 `RowEvent.turn`，`rowEventsOfTurn` 按「身份 + 号」精确归位，没有归属键的（`error` / `warning`）沿用既有按时刻规则。

**Tech Stack:** TypeScript 5（strict + verbatimModuleSyntax）/ vitest 4（node + jsdom）/ zod 3 / React 19 + antd 6。

**Spec:** `docs/superpowers/specs/2026-10-01-agent-message-spec-design-v3.md` §2.6（归属键）+ `2026-09-30-exec-log-drawer-redesign-design.md` §6.14（界面归位）——本线的过程 spec 已并入这两份文档并从库中删除

## Global Constraints

- 用中文交流；注释用中文 JSDoc，先说「做什么」再说「怎么做」。
- 提交时**逐个显式 `git add <路径>`**，禁止 `git add -A`。`git status` 里出现不属于本计划的文件（**当前工作树里另一会话正在改 `packages/server/agents/src/providers/codex/{transcript.ts,transcript.test.ts}` 与 `claude-code/index.test.ts`，仓库根还有它的 `tmp-inspect*.mjs`**）时**保持原样**，只 add 本任务列出的路径。
- 内循环跑法：`pnpm vitest run <文件路径>`；进入审查阶段前按顺序 `pnpm typecheck` → `pnpm lint` → 修复所有错误。
- **每条新增守卫都要做变异验证**：把它要拦的缺陷人为制造回去 ⇒ 确认该用例**失败** ⇒ 还原并核对文件哈希未变。
- `null` 与 `0` 含义相反，一律不许编数；老日志必须照样解析。
- 契约改动**必须排在适配器之前**（写侧 `core/src/event-log.ts` 会用 `AgentEventSchema` 校验，schema 没这一格时整条 `usage` 会写盘失败）。

---

### Task 1: 契约新增归属格 `usage.turn`

**Files:**
- Modify: `packages/server/contracts/src/agent-event.ts`（`usage` 那个 `z.object` 内，紧跟 `subagentTurns`；文件末尾的推导类型区）
- Modify: `packages/server/contracts/src/index.ts`（导出清单，`type UsageTiming` 那一行旁边）
- Test: `packages/server/contracts/src/agent-event.test.ts`（`usage` 那一组里新增一条）

**Interfaces:**
- Produces: `AgentEvent`（`usage` 成员）新增可选格 `turn?: { subagentId: string | null; round: number } | null`；导出类型 `UsageTurn = NonNullable<Extract<AgentEvent, { type: 'usage' }>['turn']>`。后续任务（2/3/4/5/6）都消费这个名字。

- [ ] **Step 1: 写失败用例**

在 `agent-event.test.ts` 的 `usage` 组（`'usage 的时间格可空、整格可缺…'` 之后）追加：

```ts
  /**
   * 归属格（2026-10-05，spec §2.2）：这一条读数**属于哪一轮**。
   * 三个靶子：① 老日志（没有这一格）必须照样解析；② 带上的值必须原样保留；
   * ③ 号必须是**正整数**——`0` / 小数 / 负数都不是一个轮次，放过去界面就会去找一个不存在的轮次。
   */
  it('usage 的归属格 turn 可缺可空、带上时原样保留（老日志必须照样解析）', () => {
    // ① 整格缺席（历史行）
    expect(AgentEventSchema.safeParse({ ...base, type: 'usage', tokens: null, turns: 3 }).success).toBe(true);
    // ② 显式 null = 这一条算不出归属（读侧与「键缺席」同义：界面按时刻归位）
    const none = AgentEventSchema.safeParse({ ...base, type: 'usage', tokens: null, turns: 3, turn: null });
    expect(none.success).toBe(true);
    expect(none.success ? none.data : null).toMatchObject({ turn: null });
    // ③ 主会话与子会话两种身份都原样保留
    for (const turn of [{ subagentId: null, round: 2 }, { subagentId: 'child-1', round: 5 }]) {
      const parsed = AgentEventSchema.safeParse({ ...base, type: 'usage', tokens: null, turns: 3, turn });
      expect(parsed.success).toBe(true);
      expect(parsed.success ? parsed.data : null).toMatchObject({ turn });
    }
    // ④ 形状不对必须拒
    for (const bad of [{ subagentId: null, round: 0 }, { subagentId: null, round: 1.5 }, { subagentId: 7, round: 1 }]) {
      expect(AgentEventSchema.safeParse({ ...base, type: 'usage', tokens: null, turns: 3, turn: bad }).success).toBe(false);
    }
  });
```

- [ ] **Step 2: 跑用例确认失败**

Run: `pnpm vitest run packages/server/contracts/src/agent-event.test.ts -t "归属格"`
Expected: FAIL —— 断言 ③ 的 `toMatchObject({ turn })` 拿不到 `turn`（zod 把未知键 strip 掉）。

- [ ] **Step 3: 加 schema 与类型**

`agent-event.ts` 的 `usage` 对象里，紧跟 `subagentTurns` 之后插入：

```ts
    /**
     * 这一条读数**属于哪一轮**（2026-10-05 新增，spec `2026-10-05-usage-turn-attribution-design.md`）：
     * `subagentId` = 会话身份（`null` = 主会话，与 `SubagentRecord.subagentId` / `LogTurn.subagentId`
     * 同一套 id），`round` = **该会话自己的**第几次模型往返（每会话各自 1..N）。
     *
     * ⚠️ 与同一对象里那个 `turns`（**必填**、本行累计轮次、服务进度条与 `EvalRow.turns`）
     * **不是一回事**，两者不得互相顶替：`turns` 回答「这一行跑到第几轮了」（行尺度），
     * 这一格回答「这一条读数发生在哪一轮」（会话尺度）。界面按它把「用量 … 轮次 N」放回**它自己那一轮**；
     * 只按 `turns` 放会得到「里程碑全挤在最后一轮」（2026-10-05 真机实测三行都如此）。
     *
     * 为什么整格可选（与 `timing` 同一条处置，**不是** `subagentTokens` 那种三态）：
     *   · 磁盘上已有大量没有这一格的 `usage` 行，写成必填会让老日志在回放 / SSE 续订时成片解析失败；
     *   · 「键缺席」与「显式 `null`」在读侧**是同一件事**（没有归属信息 ⇒ 界面按时刻归位）——
     *     这一格没有 `subagentTokens` 那种「没采到 vs 确实没有」的语义差。
     */
    turn: z
      .object({
        subagentId: z.string().nullable(),
        round: z.number().int().positive(),
      })
      .nullable()
      .optional(),
```

文件末尾（`UsageTiming` 定义之后）加：

```ts
/**
 * `usage` 事件里那格归属信息的推导类型（2026-10-05）。与 `UsageTiming` 同一条处置：
 * `NonNullable` 去掉外层的 `| null`——适配器内部传递时形状恒定（没有归属由草稿层的 `null` 表达）。
 */
export type UsageTurn = NonNullable<Extract<AgentEvent, { type: 'usage' }>['turn']>;
```

`packages/server/contracts/src/index.ts` 的导出清单里，`type UsageTiming,` 那一行旁边加 `type UsageTurn,`。

- [ ] **Step 4: 跑用例确认通过**

Run: `pnpm vitest run packages/server/contracts/src`
Expected: PASS（该包全部用例）。

- [ ] **Step 5: 提交**

```bash
git add packages/server/contracts/src/agent-event.ts packages/server/contracts/src/agent-event.test.ts packages/server/contracts/src/index.ts
git commit -m "feat(contracts): usage 事件新增归属格 turn（会话身份 + 该会话的轮次号）"
```

---

### Task 2: 骨架透传归属（`AgentEventDraft` + `TurnProjection`）

**Files:**
- Modify: `packages/server/agents/src/emit.ts`（`AgentEventDraft` 的 `usage` 成员；`withMeta` 的 `case 'usage'`）
- Modify: `packages/server/agents/src/turn.ts`（`TurnProjection`；循环内的 `emit({type:'usage'…})`；`sameUsage` 与 `emittedUsage`）
- Test: `packages/server/agents/src/emit.test.ts`、`packages/server/agents/src/turn.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `UsageTurn`。
- Produces: `AgentEventDraft` 的 `usage` 成员新增**必填**格 `turn: UsageTurn | null`；`TurnProjection.turn?: UsageTurn | null`（缺省 = 本条没有归属 ⇒ 发出去的 `usage.turn` 是 `null`）。语义：**不结转上一条**。

- [ ] **Step 1: 写失败用例（emit）**

`emit.test.ts` 的 `usage` 那组追加（同时给已有三条 `emitter.emit({type:'usage',…})` 补上 `turn: null`，否则 TS 会报缺格）：

```ts
  /**
   * 归属格（2026-10-05）：草稿层**恒带**这一格（没有归属时写 `null`），读侧因此只有「有值」与
   * 「没有」两态——与 `timing` / `subagentTokens` 同一条处置，少一种形态就少一处漂移。
   */
  it('usage 草稿带上归属格 turn：没有归属是 null，有归属时逐字保留', () => {
    const seen: AgentEvent[] = [];
    const emitter = createEventEmitter((event) => {
      seen.push(event);
    });
    emitter.emit({ type: 'usage', tokens: null, subagentTokens: null, subagentTurns: null, timing: null, turn: null, turns: 1 });
    emitter.emit({
      type: 'usage',
      tokens: null,
      subagentTokens: null,
      subagentTurns: null,
      timing: null,
      turn: { subagentId: 'child-1', round: 2 },
      turns: 4,
    });
    expect(seen[0]).toMatchObject({ turn: null });
    expect(seen[1]).toMatchObject({ turn: { subagentId: 'child-1', round: 2 } });
  });
```

- [ ] **Step 2: 跑用例确认失败**

Run: `pnpm vitest run packages/server/agents/src/emit.test.ts`
Expected: FAIL —— 第二条用例的 `turn` 读不到（`withMeta` 没搬这一格）。

- [ ] **Step 3: 实现（emit.ts）**

`import type { AgentEvent, UsageTiming, UsageTokens } from '@aieval/contracts';` 改成同时引入 `UsageTurn`。`AgentEventDraft` 的 `usage` 成员里，`subagentTurns` 之后加：

```ts
    /**
     * **这一条读数属于哪一轮**（2026-10-05）：与 `timing` / `subagentTokens` 一样**这一层必填**
     * （没有归属时写 `null`），契约那边是可选可空。`null` = 本条没给出归属 ⇒ 界面按时刻归位。
     */
    turn: UsageTurn | null;
```

`withMeta` 的 `case 'usage'` 里，`subagentTurns: draft.subagentTurns,` 之后加：

```ts
        // 归属格恒带（没有归属时是 null）：读侧只有「有值」与「没有」两态
        turn: draft.turn,
```

- [ ] **Step 4: 写失败用例（骨架）**

`turn.test.ts` 里新增一条（放在「轮次的发射门槛」那一组附近，用现成的 `createHarness` + `collectEvents`）：

```ts
  /**
   * 归属格（2026-10-05）：骨架**只搬运**——投影没给就是 `null`（不结转上一条，也不拿 `turns` 顶替）。
   * 第二条判据是去重：同一条读数**换了归属**也要再发一条，否则界面上的落点会停在旧的那个轮次。
   */
  it('usage 事件带上投影交出的归属；归属变了要重发（骨架不做加法、不结转）', async () => {
    const events: AgentEvent[] = [];
    const projections: TurnProjection[] = [
      { drafts: [], tokens: null, turns: 1, failure: null, turn: { subagentId: null, round: 1 } },
      // ② 载荷三格与上一条**逐字段相同**，只有归属不同 ⇒ 必须再发一条
      { drafts: [], tokens: null, turns: 1, failure: null, turn: { subagentId: 'child-1', round: 1 } },
      // ③ 本条不给归属 ⇒ 事件那一格是 null（**不是**沿用上一条的子会话）
      { drafts: [], tokens: null, turns: 2, failure: null },
    ];
    let index = 0;
    const { hooks } = createHarness({
      events: ['a', 'b', 'c'],
      projection: () => projections[index++] ?? { drafts: [], tokens: null, turns: null, failure: null },
    });
    await runTurn(createRunInput({ onEvent: collectEvents(events) }), hooks);
    const usages = events.filter((event): event is Extract<AgentEvent, { type: 'usage' }> => event.type === 'usage');
    expect(usages.map((event) => event.turn)).toEqual([
      { subagentId: null, round: 1 },
      { subagentId: 'child-1', round: 1 },
      null,
    ]);
  });
```

- [ ] **Step 5: 跑用例确认失败**

Run: `pnpm vitest run packages/server/agents/src/turn.test.ts -t "归属"`
Expected: FAIL —— `event.turn` 全是 `undefined`（骨架没搬这一格）。

- [ ] **Step 6: 实现（turn.ts）**

`TurnProjection` 里 `turns: number | null;` 之前插入：

```ts
  /**
   * 这一条读数**属于哪一轮**（2026-10-05，spec §2.2）：`subagentId` = 会话身份（`null` = 主会话），
   * `round` = **该会话自己的**第几次模型往返。缺省/`null` = 本条没有归属 ⇒ 发出去的 `usage.turn` 是 `null`。
   *
   * ⚠️ **刻意不结转上一条**（与 `subagentTokens` 的「保持原值」相反）：归属说的是「**这一条**读数发生在
   * 哪一轮」，结转会把上一条的会话贴到这一条上（dsh 的 `turn/end`、codex 的收尾条都可能换了会话）。
   * 三家的义务因此是一致的：**凡是能触发 `usage` 事件的那条投影，就要带上这一格**。
   */
  turn?: UsageTurn | null;
```

`emittedUsage` 的类型与发射点：

```ts
  let emittedUsage: {
    tokens: AgentRunResult['tokens'];
    subagentTokens: AgentRunResult['subagentTokens'];
    subagentTurns: number | null;
    timing: UsageTiming | null;
    turns: number;
    /** 归属也进去重判据：换了会话或换了轮次就是一次真实变化（界面要重画落点） */
    turn: UsageTurn | null;
  } | null = null;
```

```ts
      const liveTokens = estimatedTokens ?? tokens;
      const liveTiming = resolveTiming(state.timing);
      /**
       * 归属（2026-10-05）：**本条投影自带**，缺省即 `null`——不结转、也不拿 `projection.turns` 顶替
       * （那是本行累计轮次，与「这一条属于哪一轮」是两把尺子）。
       */
      const liveTurn = projection.turn ?? null;
      if (
        projection.turns !== null
        && !sameUsage(emittedUsage, liveTokens, subagentTokens, subagentTurns, liveTiming, projection.turns, liveTurn)
      ) {
        emit({
          type: 'usage',
          tokens: liveTokens,
          subagentTokens,
          subagentTurns,
          timing: liveTiming,
          turn: liveTurn,
          turns: projection.turns,
        });
        emittedUsage = {
          tokens: liveTokens,
          subagentTokens,
          subagentTurns,
          turns: projection.turns,
          timing: liveTiming,
          turn: liveTurn,
        };
      }
```

`sameUsage` 加一个参数与一条判据：

```ts
function sameUsage(
  previous: {
    tokens: AgentRunResult['tokens'];
    subagentTokens: AgentRunResult['subagentTokens'];
    subagentTurns: number | null;
    turns: number;
    timing: UsageTiming | null;
    turn: UsageTurn | null;
  } | null,
  tokens: AgentRunResult['tokens'],
  subagentTokens: AgentRunResult['subagentTokens'],
  subagentTurns: number | null,
  timing: UsageTiming | null,
  turns: number,
  turn: UsageTurn | null,
): boolean {
  if (previous === null) return false;
  if (previous.turns !== turns) return false;
  if (!sameTiming(previous.timing, timing)) return false;
  // 归属也在判据里：换了会话/轮次 ⇒ 界面上的落点要跟着动，静默不发就是「停在旧轮次」
  if (!sameTurn(previous.turn, turn)) return false;
  if (!sameTrio(previous.subagentTokens, subagentTokens)) return false;
  return sameTrio(previous.tokens, tokens);
}

/** 归属逐字段相同；`null` 只与 `null` 相同（从「没有归属」变成「有归属」是一次真实变化） */
function sameTurn(left: UsageTurn | null, right: UsageTurn | null): boolean {
  if (left === null || right === null) return left === right;
  return left.subagentId === right.subagentId && left.round === right.round;
}
```

- [ ] **Step 7: 跑用例确认通过**

Run: `pnpm vitest run packages/server/agents/src/emit.test.ts packages/server/agents/src/turn.test.ts`
Expected: PASS。若 `pnpm typecheck` 报「别的调用点少了 `turn`」，按报错逐个补齐（草稿层的 `usage` 只有 `turn.ts` 一个构造点）。

- [ ] **Step 8: 提交**

```bash
git add packages/server/agents/src/emit.ts packages/server/agents/src/emit.test.ts packages/server/agents/src/turn.ts packages/server/agents/src/turn.test.ts
git commit -m "feat(agents): usage 事件透传归属格 turn（骨架只搬运、不结转）"
```

---

### Task 3: dsh —— 轮次号改成「每会话自己的 step」+ 归属

**Files:**
- Modify: `packages/server/agents/src/providers/dsh/message.ts`（新增两个导出：`dshSessionRoundOf` / `dshTurnAttribution`；文件头口径补一段）
- Modify: `packages/server/agents/src/providers/dsh/events.ts`（`roundTripOf` → `roundOf`；三处 `roundTrip` 调用点；三条能发 `usage` 的分支补 `turn`）
- Test: `packages/server/agents/src/providers/dsh/events.test.ts`、`packages/server/agents/src/providers/dsh/index.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `TurnProjection.turn`；`message.ts` 既有的 `sessionTurns`（`noteDshSessionTurn` 维护的按会话 step 计数）与私有的 `sessionIdProfileSubagent`。
- Produces: `dshTurnAttribution(sessionId, data): UsageTurn | null`；`dshSessionRoundOf(sessionId): number | null`。**口径**：消息的 `roundTrip` 与 `usage.turn.round` 是**同一个数**，都由 `dshTurnAttribution` 算出来。

- [ ] **Step 1: 写失败用例（投影层）**

`dsh/events.test.ts` 新增两条（`sessionEvent(type, data, sessionId)` 第三参就是会话身份，`beforeEach` 已有 `resetSubagentCatalogForTesting()`）：

```ts
  /**
   * 每会话自己的轮次号（2026-10-05，spec §2.3）：`data.step` 是厂商给的**每会话**序号
   * （真机：主会话 1,2,3、子会话 1,2,3），消息的 `roundTrip` 与 `usage.turn.round` 都用它。
   * 变异体：改回 `state.turns`（本行全局计数）⇒ 主会话第二条会变成 3（被别的会话推高）。
   */
  it('消息的轮次号是**该会话自己的** step：别的会话插进来也不会把它推高', () => {
    const state = newState();
    const main1 = projectDshNotification(
      sessionEvent(DSH_ASSISTANT_MESSAGE_TYPE, { turn: 1, step: 1, message: { content: [{ type: 'text', text: '一' }] } }),
      state,
      CONTEXT,
    );
    // 子会话插一条（本行累计轮次照样 +1：`state.turns` 是**全树**口径，见下一条用例）
    projectDshNotification(sessionEvent('step/start', { turn: 1, step: 1 }, 'child-1'), state, CONTEXT);
    const main2 = projectDshNotification(
      sessionEvent(DSH_ASSISTANT_MESSAGE_TYPE, { turn: 1, step: 2, message: { content: [{ type: 'text', text: '二' }] } }),
      state,
      CONTEXT,
    );
    expect(main1.messages?.[0]?.roundTrip).toBe(1);
    expect(main2.messages?.[0]?.roundTrip).toBe(2);
    // 归属：主会话（`subagentId: null`）+ 各自的 step
    expect(main1.turn).toEqual({ subagentId: null, round: 1 });
    expect(main2.turn).toEqual({ subagentId: null, round: 2 });
  });

  it('归属带上会话身份：子会话的 step 归到它自己名下；`turn/end` 归到该会话最后一个 step', () => {
    const state = newState();
    projectDshNotification(sessionEvent('step/start', { turn: 1, step: 1 }, 'child-1'), state, CONTEXT);
    const child = projectDshNotification(
      sessionEvent(DSH_ASSISTANT_MESSAGE_TYPE, { turn: 1, step: 1, usage: { inputTokens: 4, cacheReadTokens: 1, outputTokens: 3 } }, 'child-1'),
      state,
      CONTEXT,
    );
    expect(child.turn).toEqual({ subagentId: 'child-1', round: 1 });
    // `turn/end` 的载荷里没有 step ⇒ 退回**该会话**最后一个 step（不是本行累计号）
    const end = projectDshNotification(sessionEvent(DSH_TURN_END_TYPE, { turn: 1, reason: { kind: 'completed' } }, 'child-1'), state, CONTEXT);
    expect(end.turn).toEqual({ subagentId: 'child-1', round: 1 });
    // 一次 step 都没见过的会话 ⇒ 没有归属（不拿本行累计号顶替）
    const stranger = projectDshNotification(sessionEvent(DSH_TURN_END_TYPE, { turn: 1, reason: { kind: 'completed' } }, 'child-2'), newState(), CONTEXT);
    expect(stranger.turn).toBeNull();
  });
```

- [ ] **Step 2: 跑用例确认失败**

Run: `pnpm vitest run packages/server/agents/src/providers/dsh/events.test.ts -t "会话自己的"`
Expected: FAIL —— `projection.turn` 是 `undefined`；`roundTrip` 在第二条里是 3。

- [ ] **Step 3: 实现（message.ts）**

文件头「`roundTrip`：按 `step/start` 边界计数」那一段改成新口径（一句话即可）：**`roundTrip` 取厂商给的每会话 `step` 号**（下方 `dshTurnAttribution` 是唯一实现）。`noteDshSessionTurn` 之后追加：

```ts
/** 该会话到目前为止见过的 step 数（= 它自己的最后一个 step；一次都没见过就是 `null`） */
export function dshSessionRoundOf(sessionId: string | null): number | null {
  if (sessionId === null || sessionId === '') return null;
  return sessionTurns.get(sessionId) ?? null;
}

/**
 * 这一条读数属于**哪个会话的第几次模型往返**（2026-10-05，spec §2.3）。
 *
 * 为什么是**唯一实现**：消息的 `roundTrip` 与 `usage.turn.round` 必须是同一个数——两处各算一遍，
 * 漂移的表现就是「用量那一行落在与它同号的轮次之外」，而那正是本次要修的毛病。
 *
 * 取数顺序：厂商的 `data.step`（真机每条 step 事件都带，每会话各自 1..N）→ 该会话已观察到的 step 数
 * （`turn/end` 这类不带 step 的出口走这一支）→ `null`（**不拿本行累计号顶替**：那会把读数挂到别的
 * 会话同号的轮次上）。
 */
export function dshTurnAttribution(sessionId: string | null, data: Record<string, unknown> | null): UsageTurn | null {
  const round = readNumber(data, 'step') ?? dshSessionRoundOf(sessionId);
  if (round === null) return null;
  return { subagentId: sessionIdProfileSubagent(sessionId), round };
}
```

（`import type { SubagentRecord, UsageTokens } from '@aieval/contracts';` 改成同时引入 `UsageTurn`。）

- [ ] **Step 4: 实现（events.ts）**

`roundTripOf` 换成：

```ts
/**
 * 这条消息属于**哪个会话的第几次模型往返**（spec 2026-10-05 §2.3）。
 * 与 `usage.turn` 同源：`dshTurnAttribution` 是唯一实现（消息这一格是必填正整数，故 `null` 时给 1——
 * 真机每一次往返都带 `step`，这条路径不可达）。
 */
function roundOf(sessionId: string | null, data: Record<string, unknown> | null): number {
  return dshTurnAttribution(sessionId, data)?.round ?? 1;
}
```

三个调用点改成 `roundOf(sessionId, data)`（`assistant/message`、`tool/call`、`tool/result`；`tool/*` 两支的入参就是各自的 `data`）。三条能触发 `usage` 事件的分支补归属：

- `assistant/message`：`turns: state.turns > 0 ? state.turns : null,` 之前加 `turn: dshTurnAttribution(sessionId, data),`
- `step/start`：同样加一行（此时 `noteDshSessionTurn` 已跑过，`data.step` 在真机上一定在）
- `turn/end`：两个分支（成功与失败）的返回对象里各加一行 `turn: dshTurnAttribution(sessionId, data),`

文件头「既成口径：用量与轮次都不按会话分叉」那一段补一句新口径：**合计**（`tokens` / `turns`，服务卡片与快照）仍不分叉；**消息的轮次号与 `usage.turn`** 按各会话自己的 `step` 走（2026-10-05），两者不是一回事。

- [ ] **Step 5: 跑用例确认通过**

Run: `pnpm vitest run packages/server/agents/src/providers/dsh`
Expected: PASS。既有的「端到端」用例里 `usages.map((event) => [event.turns, event.tokens])` 不受影响（`turns` 仍是本行累计）。若有用例断言 `roundTrip` 恒等于 `state.turns`，按新口径改判据（并确认它拦的仍是它原来拦的东西）。

- [ ] **Step 6: 补一条**行级**口径的守卫（index 层）**

`dsh/index.test.ts` 的「子智能体那一份用量」组里追加（用现成的 `runDshWith` / `usageEvents` / `subagentStarted`）：

```ts
  it('归属按每会话自己的 step 走，而 `turns` 仍是全树合计（两把尺子不互相顶替）', async () => {
    const events = await runDshWith([
      STEP_START_EVENT, // 主会话 step 1
      subagentStarted('child-1'),
      sessionEvent('step/start', { turn: 1, step: 1 }, 'child-1'),
      sessionEvent(DSH_ASSISTANT_MESSAGE_TYPE, { turn: 1, step: 2, usage: { inputTokens: 4, cacheReadTokens: 1, outputTokens: 3 } }, undefined),
    ]);
    const last = usageEvents(events).at(-1);
    // 合计：主 2 步 + 子 1 步 = 3（既成口径，本次不动）
    expect(last?.turns).toBe(3);
    // 归属：这一条来自**主会话的第 2 步**
    expect(last?.turn).toEqual({ subagentId: null, round: 2 });
  });
```

（`sessionEvent(..., undefined)` = 用占位会话 id，夹具会对齐到本次 run 的主会话——见该文件 `sessionEvent` 的 JSDoc。）

Run: `pnpm vitest run packages/server/agents/src/providers/dsh/index.test.ts -t "两把尺子"`
Expected: PASS。

- [ ] **Step 7: 提交**

```bash
git add packages/server/agents/src/providers/dsh/message.ts packages/server/agents/src/providers/dsh/events.ts packages/server/agents/src/providers/dsh/events.test.ts packages/server/agents/src/providers/dsh/index.test.ts
git commit -m "feat(agents/dsh): 轮次号改成每会话自己的 step，usage 事件带归属"
```

---

### Task 4: claude-code —— 归属恒为主会话

**Files:**
- Modify: `packages/server/agents/src/providers/claude-code/events.ts`（`assistant` 分支与 `projectResult`）
- Test: `packages/server/agents/src/providers/claude-code/events.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `TurnProjection.turn`。
- Produces: claude 的 `usage` 投影带 `turn: { subagentId: null, round: <主循环计数> }`；侧链（`parent_tool_use_id` 非空）**不发** `usage`（`turns` 为 `null`，既有行为）。

- [ ] **Step 1: 写失败用例**

`claude-code/events.test.ts` 追加：

```ts
  /**
   * 归属（2026-10-05，spec §2.3）：claude 的读数只由**主循环**消息触发（侧链 `parent_tool_use_id`
   * 非空时 `countModelRoundTrip` 返回 `null` ⇒ 骨架根本不发 `usage`）⇒ 归属恒是主会话 + 当前主循环计数。
   */
  it('usage 投影带归属（主会话 + 主循环计数）；侧链消息不带归属也不发 usage', () => {
    const TRIO = { input_tokens: 100, cache_read_input_tokens: 20, output_tokens: 5 };
    const state = newState();
    const first = projectClaudeMessage(assistantMessage({ uuid: 'u1', messageId: 'msg-1', usage: TRIO }), state, CONTEXT);
    expect(first.turns).toBe(1);
    expect(first.turn).toEqual({ subagentId: null, round: 1 });

    const side = projectClaudeMessage(
      assistantMessage({ uuid: 'u2', messageId: 'sub-msg-1', usage: TRIO, parentToolUseId: 'toolu_1' }),
      state,
      CONTEXT,
    );
    // 侧链不占主循环的号（既有口径）⇒ 这一条没有轮次，也就没有归属可言
    expect(side.turns).toBeNull();
    expect(side.turn).toBeUndefined();
  });
```

（`assistantMessage({ uuid, messageId, usage, parentToolUseId })` / `newState` / `CONTEXT` 都是该文件里既有的夹具，别新造一套。）

- [ ] **Step 2: 跑用例确认失败**

Run: `pnpm vitest run packages/server/agents/src/providers/claude-code/events.test.ts -t "归属"`
Expected: FAIL —— `first.turn` 是 `undefined`。

- [ ] **Step 3: 实现**

`assistant` 分支：

```ts
    const turns = countModelRoundTrip(message, state);
    return {
      drafts,
      tokens: estimateTokens(message, state),
      tokensEstimated: true,
      turns,
      // 归属：读数只由主循环触发 ⇒ 会话恒为主会话，轮次就是刚数出来的那个（spec 2026-10-05 §2.3）
      turn: turns === null ? null : { subagentId: null, round: turns },
      failure: null,
    };
```

`projectResult` 的两个返回点（结构化输出重试那一条与正常那一条）各加 `turn: turns === null ? null : { subagentId: null, round: turns },`。

- [ ] **Step 4: 跑用例确认通过**

Run: `pnpm vitest run packages/server/agents/src/providers/claude-code`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/server/agents/src/providers/claude-code/events.ts packages/server/agents/src/providers/claude-code/events.test.ts
git commit -m "feat(agents/claude-code): usage 事件带上归属（主会话 + 主循环轮次）"
```

---

### Task 5: codex —— 两把尺子合成一把（只数 `AgentMessage`）

> ⚠️ **开工前先重读文件**：另一会话正在改 `providers/codex/transcript.ts` 与 `transcript.test.ts`（R7 复核）。
> 本任务**不改** `transcript.ts` 的实现，只改 `message.ts` / `events.ts` / `message-events.ts` 的注释与计数键；
> `transcript.test.ts` 里断言 `roundTrip` 的那几条要跟着改（若它已被别人改过，先 `git diff` 看清再动手）。

**Files:**
- Modify: `packages/server/agents/src/providers/codex/events.ts`（`MODEL_OUTPUT_ITEM_TYPES` **改名**成 `TURN_ITEM_TYPES` 并收窄取值；`countModelOutputItem` 的注释；`turn.completed` 与 `item.*` 两条分支的 `turn`）
- Modify: `packages/server/agents/src/providers/codex/message.ts`（`MODEL_ITEM_TYPES` **改名**成 `TURN_ITEM_TYPES` 并只留 `AgentMessage`；`threadMessages` 按 `itemId` 去重）
- Modify: `packages/server/agents/src/providers/codex/message-events.ts`（文件头那句计数口径）
- Test: `packages/server/agents/src/providers/codex/events.test.ts`、`packages/server/agents/src/providers/codex/transcript.test.ts`、`packages/server/agents/src/providers/codex/index.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `TurnProjection.turn`。
- Produces: codex 的轮次号（事件流与会话文件**两侧同一条规则**）= 「模型**答复**条目（`agent_message` / `AgentMessage`）按 `id` 去重后的个数」；`usage` 投影带 `turn: { subagentId: null, round }`。

- [ ] **Step 1: 写失败用例（事件流侧）**

`codex/events.test.ts` 既有的第一条用例（`'模型产出条目（reasoning / agent_message）→ 轮次按 item.id 去重计数'`）改成新口径：

```ts
  /**
   * 轮次口径（2026-10-05 修正，spec §2.3）：只数**模型答复条目**（`agent_message`）。
   * 为什么把 `reasoning` 拿掉：它会话文件里看得见、事件流在 DeepSeek 路由上**一条都看不见**
   * （实测 37 条 item 里 0 条）⇒ 两侧各数一遍就是两套号（真机：文件 42 / 事件流 18），
   * 而用量里程碑带的是事件流那一套 ⇒ 抽屉按 42 分组、里程碑说 18，根本对不上。
   */
  it('轮次只数 agent_message（按 item.id 去重）；reasoning 条目不再推高轮次', () => {
    const state = newState();
    const seen = new Map<string, string>();
    const reasoning = projectCodexEvent(
      { type: 'item.completed', item: { id: 'rs-1', type: 'reasoning', text: '想一下' } },
      state,
      seen,
      CONTEXT,
    );
    expect(reasoning.turns).toBeNull();
    const message = projectCodexEvent(
      { type: 'item.completed', item: { id: 'msg-1', type: 'agent_message', text: '答复' } },
      state,
      seen,
      CONTEXT,
    );
    expect(message.turns).toBe(1);
    // 归属：事件流只有主线程 ⇒ 会话恒为 null，号就是刚数出来的那个
    expect(message.turn).toEqual({ subagentId: null, round: 1 });

    // 同一条目的后续快照（item.updated / item.completed 共享 id）**不**再算一次
    const again = projectCodexEvent(
      { type: 'item.updated', item: { id: 'msg-1', type: 'agent_message', text: '答复，补一句' } },
      state,
      seen,
      CONTEXT,
    );
    expect(again.turns).toBeNull();
    expect(state.turns).toBe(1);
  });
```

- [ ] **Step 2: 跑用例确认失败**

Run: `pnpm vitest run packages/server/agents/src/providers/codex/events.test.ts`
Expected: FAIL —— `reasoning.turns` 是 1（旧口径）、`message.turn` 是 `undefined`。

- [ ] **Step 3: 写失败用例（会话文件侧）**

在 `codex/transcript.test.ts` 里新增（用该文件已有的帮手与夹具）：

```ts
  /**
   * 会话文件的轮次号与事件流同一把尺子（2026-10-05，spec §2.3）：`Reasoning` 条目**不**推高轮次。
   * 真机形状：主线程文件里 24 条 `Reasoning` + 18 条 `AgentMessage` ⇒ 旧口径数到 42、事件流只有 18。
   * 去重靶子：同一条目重复落行（`item_completed` 两次同一个 `id`）时号不许被推高。
   */
  it('会话文件的轮次只数 AgentMessage：推理条目不推高号，重复 itemId 不重复计数', () => {
    const home = makeCodexHome({
      [rolloutPath(MAIN_THREAD_ID)]: [
        MAIN_META,
        itemCompletedLine({ type: 'Reasoning', id: 'rs-1', summary_text: [], raw_content: ['先想一下'] }),
        itemCompletedLine({ type: 'AgentMessage', id: 'msg-1', content: [{ type: 'Text', text: '答复一' }] }),
        // 第一次答复之后的推理：旧口径会把它数成第 3 轮
        itemCompletedLine({ type: 'Reasoning', id: 'rs-2', summary_text: [], raw_content: ['再想一下'] }),
        // 同一条目重复落行：不许再推高（与事件流的 `turnKeys` 去重同构）
        itemCompletedLine({ type: 'AgentMessage', id: 'msg-1', content: [{ type: 'Text', text: '答复一' }] }),
      ],
    });
    const projected = projectCodexMessages({ codexHome: home, mainThreadId: MAIN_THREAD_ID, childThreadIds: [] });
    expect(projected.messages.map((draft) => draft.roundTrip)).toEqual([1, 1, 2, 2]);
  });
```

（`makeCodexHome` / `rolloutPath` / `MAIN_META` / `MAIN_THREAD_ID` / `itemCompletedLine` / `projectCodexMessages` 都是该文件已有的帮手与夹具，别新造一套。）

Run: `pnpm vitest run packages/server/agents/src/providers/codex/transcript.test.ts -t "只数 AgentMessage"`
Expected: FAIL —— 旧实现把 `rs-2` 数成第 3 轮、重复的 `msg-1` 数成第 4 轮。

- [ ] **Step 4: 实现（events.ts）**

```ts
/**
 * 算作「一次模型往返」的条目类型（2026-10-05 收窄，spec §2.3）：**只有模型答复条目**。
 * ⚠️ 原来这里还有 `reasoning`，两侧（事件流 / 会话文件）都数它。实测证明那会让两条通道各得一套号：
 * DeepSeek 路由上 codex **不投影** reasoning item（37 条 item 里 0 条），事件流只数到 18，而会话文件
 * 里有 24 条 Reasoning ⇒ 文件侧数到 42。用量里程碑带的是事件流那一套 ⇒ 抽屉按 42 分组、里程碑说
 * 「轮次 18」，两者对不上（2026-10-05 真机）。收窄成「答复条目」之后两侧同源，且比旧口径更低
 * （旧口径被推理条目系统性抬高，见文件头）。
 */
const TURN_ITEM_TYPES: readonly string[] = ['agent_message'];
```

`countModelOutputItem` 里的 `MODEL_OUTPUT_ITEM_TYPES.includes(itemType)` 换成 `TURN_ITEM_TYPES.includes(itemType)`，注释同步。

`turn.completed` 分支：

```ts
    const turns = observedTurns(state);
    return {
      drafts,
      tokens,
      turns,
      // 归属：事件流只有主线程（子线程的条目不在这一条流里）⇒ 会话恒为 null
      turn: turns === null ? null : { subagentId: null, round: turns },
      failure: null,
    };
```

`item.updated` / `item.completed` 分支：`const turns = countModelOutputItem(item, id, state);` 之后定义

```ts
    const turn = turns === null ? null : { subagentId: null, round: turns };
```

并把该分支里**每一个**返回对象的 `turns` 旁边加上 `turn,`（`collab_tool_call` 那一支、无文本 item 那一支、纯重复那一支、正常那一支，共四处）。

- [ ] **Step 5: 实现（message.ts 的计数键与去重；message-events.ts 的注释）**

```ts
/**
 * 算作「一次模型往返」的条目类型（2026-10-05 收窄，spec §2.3）：**与会话文件之外那条通道同一把尺子**
 * （`events.ts` 的 `TURN_ITEM_TYPES`）。⚠️ 会话文件里看得见 `Reasoning` 而事件流看不见它
 * （DeepSeek 路由上 codex 不投影 reasoning item）⇒ 数它就会得到两套轮次号（真机：42 vs 18）。
 */
const TURN_ITEM_TYPES = new Set(['AgentMessage']);
```

`threadMessages` 的计数部分：

```ts
  let roundTrip = 0;
  /** 已经算过一轮的条目 id：文件里同一个条目重复落行时不重复推高轮次（与事件流的 `turnKeys` 同构） */
  const countedItems = new Set<string>();
  for (const [index, item] of transcript.completedItems.entries()) {
    if (item.itemType !== null && TURN_ITEM_TYPES.has(item.itemType)) {
      const key = item.itemId ?? `#${index}`;
      if (!countedItems.has(key)) {
        countedItems.add(key);
        roundTrip += 1;
      }
    }
    drafts.push(...itemMessages(item, { roundTrip: Math.max(roundTrip, 1), subagentId, transcript, blockIndices }));
  }
```

`message-events.ts` 文件头「`roundTrip`：按**模型产出条目**（`reasoning` / `agent_message`）…」那一句改成「按**模型答复条目**（`agent_message`）…，**唯一**的尺子见 `events.ts` 的 `TURN_ITEM_TYPES`」。

- [ ] **Step 6: 跑整个 codex 包 + 提交**

Run: `pnpm vitest run packages/server/agents/src/providers/codex`
Expected: PASS（`index.test.ts` 里若有断言「reasoning 也数轮次」的用例，按新口径改判据并在注释里点名这次变更）。

```bash
git add packages/server/agents/src/providers/codex/events.ts packages/server/agents/src/providers/codex/events.test.ts packages/server/agents/src/providers/codex/message.ts packages/server/agents/src/providers/codex/message-events.ts packages/server/agents/src/providers/codex/transcript.test.ts packages/server/agents/src/providers/codex/index.test.ts
git commit -m "feat(agents/codex): 轮次两通道合成一把尺子（只数 AgentMessage），usage 带归属"
```

---

### Task 6: 界面数据层 —— `RowEvent.turn` 与「孤儿」回落

**Files:**
- Modify: `packages/client/ui/src/composite/agent-log/types.ts`（新增 `TurnRef`；`RowEvent.turn`）
- Modify: `packages/client/ui/src/composite/agent-log/build-model.ts`（`rowEventsOf` 收 `homes`；`turnHomeKey` / `turnHomesOf`；`buildAgentLogModel` 的调用点）
- Test: `packages/client/ui/src/composite/agent-log/build-model.test.ts`

**Interfaces:**
- Produces: `TurnRef = { subagentId: string | null; round: number }`；`RowEvent.turn: TurnRef | null`；`rowEventsOf(events, homes?)`（`homes` 是 `${subagentId ?? 'main'}#${round}` 的集合，**不给时一律当作孤儿** ⇒ `turn: null`，与老行为逐字一致）。

- [ ] **Step 1: 写失败用例**

`build-model.test.ts` 的「行级事件的去向」组里追加：

```ts
  /**
   * 归属（2026-10-05，spec §2.4）：用量里程碑带上归属键，文案里的轮次号改用**归属号**
   * （不再是本行累计号——否则文字与它所在的分组对不上）。
   */
  it('用量里程碑带归属键，文案用归属号；没有归属与孤儿都抹成 null（⇒ 按时刻，不丢）', () => {
    const rows = rowEventsOf(
      [
        event({ seq: 1, type: 'usage', tokens: { input: 10, cached: 0, output: 0, reasoningOutput: null, total: null }, turns: 4, timing: null, turn: { subagentId: null, round: 2 } }),
        // 老日志：没有归属格
        event({ seq: 2, type: 'usage', tokens: { input: 30, cached: 0, output: 0, reasoningOutput: null, total: null }, turns: 5, timing: null }),
        // 孤儿：引用了一个整行都没有的轮次（第 9 轮）
        event({ seq: 3, type: 'usage', tokens: { input: 60, cached: 0, output: 0, reasoningOutput: null, total: null }, turns: 6, timing: null, turn: { subagentId: null, round: 9 } }),
      ],
      new Set(['main#2']),
    );
    expect(rows.map((row) => row.turn)).toEqual([{ subagentId: null, round: 2 }, null, null]);
    // 文案：第一条用**归属号 2**（它的 `turns` 是 4），后两条退回本行累计号
    expect(rows[0]?.text).toContain('轮次 2');
    expect(rows[1]?.text).toContain('轮次 5');
    expect(rows[2]?.text).toContain('轮次 6');
  });
```

- [ ] **Step 2: 跑用例确认失败**

Run: `pnpm vitest run packages/client/ui/src/composite/agent-log/build-model.test.ts -t "归属键"`
Expected: FAIL —— `row.turn` 是 `undefined`，且文案用的是 `turns`。

- [ ] **Step 3: 实现**

`types.ts`：`RowEvent` 之前加

```ts
/**
 * 行级事件的**归属键**：这一条属于哪个会话的哪一轮（`subagentId: null` = 主会话）。
 * 形状与契约 `usage.turn` 一致，但界面用**自己的名字**（"UI 永远看不到传输层"那条边界的同一条处置）。
 */
export interface TurnRef {
  subagentId: string | null;
  round: number;
}
```

`RowEvent` 里加

```ts
  /**
   * 归属键（2026-10-05）：有时间轴的落点由它决定——**有键按「身份 + 号」精确归位，无键按时刻**
   * （见 `rowEventsOfTurn`）。`null` = 没有归属信息（`error` / `warning`，以及算不出归属的里程碑）。
   */
  turn: TurnRef | null;
```

`build-model.ts`：

```ts
/** 归属键 → 集合里的字符串（`subagentId: null` 写 `main`，与 `LogTurn.subagentId` 同一套 id） */
function turnHomeKey(turn: TurnRef): string {
  return `${turn.subagentId ?? 'main'}#${turn.round}`;
}

/**
 * 整行**存在**的轮次集合（全部会话节点）。为什么需要它：里程碑的归属键指向的那一轮可能整行都不存在
 * （异常形状）——那种「孤儿」要在**数据层**就抹成 `turn: null`，落到时间轴上按时刻归位（**不丢**）。
 */
function turnHomesOf(nodes: readonly LogNode[]): Set<string> {
  const homes = new Set<string>();
  for (const node of nodes) {
    if (node.content.status !== 'ready') continue;
    for (const turn of node.content.data) {
      if (turn.round === null) continue;
      homes.add(turnHomeKey({ subagentId: turn.subagentId, round: turn.round }));
    }
  }
  return homes;
}
```

`rowEventsOf` 改成：

```ts
export function rowEventsOf(events: readonly AgentEvent[], homes?: ReadonlySet<string>): RowEvent[] {
  const out: RowEvent[] = [];
  let highWater = -1;
  for (const event of events) {
    if (event.type === 'error') {
      out.push({ at: event.at, level: 'error', text: `错误 ${event.message}`, turn: null });
      continue;
    }
    if (event.type !== 'usage' || event.tokens === null) continue;
    const total = event.tokens.input + event.tokens.cached + event.tokens.output;
    if (total <= highWater) continue;
    highWater = total;
    /**
     * 归属：**只有整行真的有那一轮**才认（`homes` 不给时一律当孤儿 ⇒ 与老行为逐字一致）。
     * 文案里的号也用归属号——它必须与这一行最终落在的那个分组同值，否则文字与位置互相打脸。
     */
    const attributed = event.turn ?? null;
    const turn = attributed !== null && homes?.has(turnHomeKey(attributed)) === true ? attributed : null;
    out.push({
      at: event.at,
      level: 'milestone',
      text: `用量 输入 ${event.tokens.input} · 缓存 ${event.tokens.cached} · 输出 ${event.tokens.output} · 轮次 ${turn?.round ?? event.turns}`,
      turn,
    });
  }
  return out;
}
```

`buildAgentLogModel` 返回处的 `rowEvents: rowEventsOf(input.events),` 改成：

```ts
    // `allNodes` 已经建好（含每个会话节点的轮次）⇒ 归属的「有没有那一轮」在这一刻就能判
    rowEvents: rowEventsOf(input.events, turnHomesOf(allNodes)),
```

文件头第 9 行的「把行级事件按去向表折成 `facts` / `rowEvents` / `diagnostics`」后面补半句：**行级事件的归属在这一层解析**（有键按号、无键/孤儿按时刻）。

- [ ] **Step 4: 跑用例确认通过**

Run: `pnpm vitest run packages/client/ui/src/composite/agent-log/build-model.test.ts`
Expected: PASS（含既有的「`error` 恒进时间轴；`usage` 只在令牌数创新高时进」那条——它调 `rowEventsOf(events)` 不给 `homes`，因此 `turn` 全是 `null`，行为不变）。

- [ ] **Step 5: 提交**

```bash
git add packages/client/ui/src/composite/agent-log/types.ts packages/client/ui/src/composite/agent-log/build-model.ts packages/client/ui/src/composite/agent-log/build-model.test.ts
git commit -m "feat(ui): 用量里程碑带上归属键，孤儿回落按时刻（数据层）"
```

---

### Task 7: 界面时间轴 —— 有键按号、无键按时刻

**Files:**
- Modify: `packages/client/ui/src/composite/agent-log/agent-message-timeline.tsx`（`rowEventsOfTurn`）
- Test: `packages/client/ui/src/composite/agent-log/agent-message-timeline.test.tsx`

**Interfaces:**
- Consumes: Task 6 的 `RowEvent.turn`。
- Produces: `rowEventsOfTurn(turns, events, index)` 的两条规则（有键按「身份 + 号」、无键按时刻）。

- [ ] **Step 1: 写失败用例**

`agent-message-timeline.test.tsx` 追加（`turn()` 帮手已支持 `subagentId` 覆盖，`nodeIndex([])` 现成）：

```tsx
  /**
   * 归属规则（2026-10-05，spec §2.4）：**有归属键的只按号**（身份也必须对上），**无键的仍按时刻**。
   * 三个靶子：① 号对得上就落在那一轮（哪怕它的 `at` 与那一轮的时刻对不上）；② 身份对不上 ⇒ 本节点不显示
   * （子会话同号的轮次不许认领主会话的里程碑）；③ `error` 这类没有键的，行为与今天逐字相同。
   */
  it('有归属键的里程碑按「会话 + 号」归位；对不上本节点的不显示；无键的仍按时刻', () => {
    const turns = [
      turn({ round: 1, at: AT, blocks: [textBlock('t1', '第一轮')] }),
      turn({ round: 2, at: AT2, blocks: [textBlock('t2', '第二轮')] }),
    ];

    render(
      <AgentMessageTimeline
        turns={turns}
        nodes={nodeIndex([])}
        rowEvents={[
          // ① `at` 是 AT（第一轮的时刻），但归属说它是第 2 轮 ⇒ 必须落在第 2 轮
          { at: AT, level: 'milestone', text: '主会话第 2 轮的用量', turn: { subagentId: null, round: 2 } },
          // ② 别的会话的同号轮次：本节点（主会话）没有这一轮 ⇒ 不显示
          { at: AT2, level: 'milestone', text: '别的会话的用量', turn: { subagentId: 'child-2', round: 2 } },
          // ③ 没有归属键：按时刻（AT2 ⇒ 挂在最后一轮）
          { at: AT2, level: 'error', text: '一条错误', turn: null },
        ]}
      />,
    );

    const rows = [...document.querySelectorAll('[data-turn-row]')];
    const textOf = (row: Element): string => row.textContent ?? '';
    expect(rows).toHaveLength(2);
    expect(textOf(rows[0]!)).not.toContain('主会话第 2 轮的用量');
    expect(textOf(rows[1]!)).toContain('主会话第 2 轮的用量');
    expect(screen.queryByText('别的会话的用量')).toBeNull();
    expect(textOf(rows[1]!)).toContain('一条错误');
  });
```

- [ ] **Step 2: 跑用例确认失败**

Run: `pnpm vitest run packages/client/ui/src/composite/agent-log/agent-message-timeline.test.tsx -t "归位"`
Expected: FAIL —— 「主会话第 2 轮的用量」按 `at` 落进了第 1 轮；「别的会话的用量」也在 DOM 里。

- [ ] **Step 3: 实现**

```ts
/**
 * 挂在第 `index` 轮之后的行级事件。**两条规则，不留洞**（2026-10-05，spec §2.4）：
 *   ① **有归属键**（`event.turn !== null`）：本轮的 `(subagentId, round)` 与它**逐字相同**才归本轮。
 *      本节点没有这一轮 ⇒ **本节点不显示它**（它属于别的会话节点，在那里显示）——回落按时刻会把
 *      「不属于这一轮的读数」混进最后一轮，那正是这次要修的毛病。
 *   ② **没有归属键**（`error` / `warning` / 算不出归属的里程碑）：沿用按时刻的老规则
 *      ——「该事件的 `at` <= 该轮 `at` 的**最后一轮**」。写成「本轮的 `at` 不晚于事件、且下一轮的
 *      `at` 晚于事件」是因为列表按项渲染时只看得到相邻两项；早于**所有**轮次的事件挂到第一轮
 *      （不丢），最后一轮兜住它之后的全部事件。
 * 比较用字符串字面序（两侧都是数据层给的 ISO 串，字面序即时间序；不解析成 `Date` 也就没有 NaN 这类分支）。
 */
export function rowEventsOfTurn(
  turns: readonly LogTurn[],
  events: readonly RowEvent[],
  index: number,
): readonly RowEvent[] {
  const turn = turns[index];
  if (turn === undefined) return [];
  const next = turns[index + 1];
  return events.filter((event) => {
    if (event.turn !== null) {
      return event.turn.subagentId === turn.subagentId && event.turn.round === turn.round;
    }
    return (index === 0 || turn.at <= event.at) && (next === undefined || next.at > event.at);
  });
}
```

- [ ] **Step 4: 跑用例确认通过**

Run: `pnpm vitest run packages/client/ui/src/composite/agent-log/agent-message-timeline.test.tsx`
Expected: PASS（既有的「行级事件按 at 落在轮次之间，三档各用自己的标签色」那条用的是**不带 `turn` 键**的字面量 ⇒ TS 会报缺格，给它三条各补 `turn: null`；行为不变）。

再跑一遍布局层（过滤器走同一个函数）：

Run: `pnpm vitest run packages/client/ui/src/composite/agent-log/agent-log-layout.test.tsx packages/client/ui/src/composite/agent-log/use-agent-log-view.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/client/ui/src/composite/agent-log/agent-message-timeline.tsx packages/client/ui/src/composite/agent-log/agent-message-timeline.test.tsx
git commit -m "feat(ui): 时间轴按「会话 + 轮次号」归位用量里程碑（无键的仍按时刻）"
```

---

### Task 8: 门禁 + 变异验证

**Files:**
- Modify:（只在门禁报错时改；格式修复的变更随本次改动一并提交）

- [ ] **Step 1: 门禁三条**

```bash
pnpm typecheck
pnpm lint
pnpm test
```

Expected: 全绿。`pnpm test` 是分钟级的；若机器同时跑着开发服务器 + 浏览器自动化，按 AGENT.md 放宽：`pnpm vitest run --maxWorkers=6 --testTimeout=150000 --hookTimeout=150000`，并先看 `tests` 累积是否比上次大 2 倍以上（那不是回归）。

- [ ] **Step 2: 变异验证（逐条：制造缺陷 → 确认那条用例红 → 还原 → 核对哈希）**

| # | 变异体 | 必须变红的用例 |
|---|---|---|
| M1 | `dsh/events.ts` 的 `roundOf` 改回 `state.turns`（本行全局号） | `dsh/events.test.ts` 的「消息的轮次号是**该会话自己的** step」 |
| M2 | `dsh/events.ts` 的 `step/start` 分支去掉 `noteDshSessionTurn(sessionId)`（每会话计数不再维护） | `dsh/index.test.ts` 的「归属按每会话自己的 step 走…」或既有的 `subagentTurns` 组 |
| M3 | `codex/message.ts` 的 `TURN_ITEM_TYPES` 加回 `'Reasoning'` | `codex/transcript.test.ts` 的「会话文件的轮次只数 AgentMessage」 |
| M4 | `agent-message-timeline.tsx` 把有键但对不上本节点的事件**回落成按时刻** | `agent-message-timeline.test.tsx` 的「有归属键的里程碑按「会话 + 号」归位…」 |
| M5 | `contracts/src/agent-event.ts` 把 `turn` 改成必填（去掉 `.optional()`） | `agent-event.test.ts` 的「usage 的归属格 turn 可缺可空…」 |
| M6 | `turn.ts` 的 `sameUsage` 去掉 `sameTurn` 那一条判据 | `turn.test.ts` 的「归属变了要重发」 |

每条变异体做完都要 `git diff --stat` 确认只动了那一处，并用 `Get-FileHash`（或 `git diff` 为空）核对还原后文件未变。把每条的证据（用例名 + 失败断言原文）记进 Task 9 的冒烟/关账记录。

- [ ] **Step 3: 提交（若有格式修复）**

```bash
git add <本计划涉及的文件>
git commit -m "chore: 门禁与变异验证后的格式修复"
```

（无变更则跳过这一步。）

---

### Task 9: 真机冒烟 + 记录

**Files:**
- Create: `docs/superpowers/notes/2026-10-05-usage-turn-attribution-smoke.md`

- [ ] **Step 1: 起服务与一轮真机评测**

`pnpm dev`（端口被占时先 kill 占用进程）。在 `http://localhost:3083` 用**同一个用例**（`简单测试`，提示词要求派子智能体）跑一轮，三家都选上（claude-code / codex / dsh），等三行落终态。

- [ ] **Step 2: 页面侧逐行核对（读 DOM，不靠截图）**

对每一行打开「执行日志」抽屉，用 `browser_evaluate` 读 `[data-turn-row]`：

```js
() => [...document.querySelectorAll('[data-turn-row]')].map((row) => ({
  key: row.getAttribute('data-turn-row'),
  usage: [...row.querySelectorAll('.ant-tag')].map((tag) => tag.textContent).filter((text) => text?.startsWith('用量')),
}))
```

判据（三行都要满足）：**每一条「用量 … 轮次 N」都出现在 `data-turn-row="round-N"` 那一行里**；没有一条落在别的轮次；没有一条消失。

- [ ] **Step 3: CLI 侧互证**

```powershell
$run = '<新的 run id>'
$row = '<某一行的 id>'
Get-Content "D:\.tmp\aieval\runs\$run\rows\$row\events.jsonl" -Encoding UTF8 |
  Select-String '"type":"usage"' | ForEach-Object { $_.Line }
Get-Content "D:\.tmp\aieval\runs\$run\rows\$row\messages.jsonl" -Encoding UTF8 |
  Select-String '"roundTrip"' | Select-Object -First 5
```

判据：`usage` 行的 `turn.round` 落在该行消息 `roundTrip` 的取值集合里；codex 那一行**主线程消息的最大 `roundTrip` == 最后一个 `usage.turn.round`**（两把尺子合一）。

- [ ] **Step 4: 写记录（四要素）**

`docs/superpowers/notes/2026-10-05-usage-turn-attribution-smoke.md` 按 AGENT.md 的冒烟格式写：① 范围清单（逐项 ✅/❌/跳过+理由）；② 操作路径（点击/输入序列）；③ 证据（浏览器读出的 DOM 结构 + CLI 输出互证）；④ 未覆盖项与后续计划。把 Task 8 的变异验证证据也附在这一节。

- [ ] **Step 5: 提交**

```bash
git add docs/superpowers/notes/2026-10-05-usage-turn-attribution-smoke.md
git commit -m "docs: 用量里程碑归位的真机冒烟记录（含变异验证证据）"
```

---

## 自查（写完计划后对着 spec 逐条核）

- spec §2.2 契约格 → Task 1；草稿层恒带 → Task 2；§2.3 三家取数 → Task 3/4/5；§2.4 界面两条规则 + 孤儿 → Task 6/7；§2.5 不动的清单 → 全计划没有一处改 `EvalRow.turns` / 卡片 / 快照；§3.1 守卫 15 条 → Task 1（1/2）、3（3/4/5/6）、4（7）、5（8/9/10）、6（11/12）、7（13/14/15）；§3.2 变异验证 → Task 8。
- 命名一致：契约 `UsageTurn` / `turn`；骨架 `TurnProjection.turn`；界面 `TurnRef` / `RowEvent.turn`；dsh 的 `dshTurnAttribution` / `dshSessionRoundOf`；codex 的 `TURN_ITEM_TYPES`。
