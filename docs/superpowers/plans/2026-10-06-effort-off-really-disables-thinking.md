# 让 claude 与 codex 的显式 `off` 真正关闭思考 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 claude-code 与 codex 两家适配器在用户显式选 `off`（= `EFFORT_OFF`）时**真的**关掉思考 —— claude 注入 `CLAUDE_CODE_EXTRA_BODY` 覆盖层、codex 补一格 `model_reasoning_summary: 'none'`；其余档位与未选**逐字不变**。

**Architecture:** 两处修法都只落在 `packages/server/agents/src/providers/` 下的两家适配器内部，各由一个「只看 `input.effort === EFFORT_OFF`」的判据门住：claude 侧新增一个纯函数 `claudeExtraEnvFor(effort)`，其返回值被条件展开进 `buildSubprocessEnv` 的 `injected`（**空对象 ⇒ 注入键集合逐字不变**）；codex 侧给 `buildCodexConfig` 加一个可选入参，`undefined` ⇒ **键整个不出现**（与既有的 `model_context_window` 同一写法）。契约形状、evaluator 调用点、api / ui / client **零改动**。

**Tech Stack:** TypeScript 5（`strict` + `verbatimModuleSyntax`）、vitest 4（node 环境）、Node 24 内置模块；无新增依赖。

**Spec:** `docs/superpowers/specs/2026-10-01-agent-message-spec-design-v3.md` §3.6 / §8.1 / §8.2 的 `off` 两条（本线的过程 spec 已并入该文档并从库中删除）

## Global Constraints

- **只允许在 `input.effort === EFFORT_OFF` 时生效**：两家的新注入都由这一个判据门住（spec §1.3 约束 1）。
- **其余档位（`low`/`high`/…）与「未选」逐字不变**：注入的键集合、传给 SDK 的 options、CLI argv、请求体都不变（spec §1.3 约束 2）。每个 Task 都要有把这条钉住的断言。
- **不能写 `KEY: off ? VALUE : undefined`**：`packages/server/agents/src/route.ts:94-96` 的语义是「值为 `undefined` 的键被**删掉**」⇒ 那种写法会在非 off 档删掉宿主继承来的同名变量，正好违反上一条（spec §3.1 约束 1）。一律用**条件展开（空对象）**。
- **`CLAUDE_CODE_EXTRA_BODY` 的值必须由 `JSON.stringify` 生成**：CLI 对非法 JSON **静默忽略整条**（不报错、思考照旧，spec §3.3）；不许手写字符串字面量。
- **不改契约形状**：`AgentRunInput.effort` 与 `EvalRow.effort` 的形状与语义一个字不动；`contracts/src/index.ts` 不新增导出（spec §1.3 约束 3）。
- **不改 evaluator 调用点、不改 api / ui / client**（spec §1.3 约束 3）。
- **界面文案不动**：`contracts/src/run.ts:99-101` 的 `effortLabel` 仍是「`off`（要求不思考）」（spec §1.3 约束 4）。
- **前作 spec 不在本线的改动面**：`docs/superpowers/specs/2026-10-06-effort-default-and-explicit-off-design.md` 的四处改写由**控制者**在实现 + 真机复验完成后落笔（spec §5.5 的 blockquote 逐字写着「实现者不要顺手替前作改字」）⇒ 本线任何提交里都不该出现这个文件。
- **WARN 的文案是契约**：spec §5.4-3 那段正文**逐字照抄、不许改写**（`<键名原文>` 是唯一可变 token），并由守卫 9b 的一条**逐字断言**钉住。
- **不动的东西**：dsh 适配器；路径 B（智能生成 / 智能识别 / 文本评分）；`claude-code/index.ts:215-216` 的 `thinking` / `effort` 两格；`codex/index.ts:119` 的 `modelReasoningEffort`（spec §1.4 / §3.1 约束 3 / §3.2 约束 2-3）。
- **注释一律中文 JSDoc**；风格「先说什么、再说怎么做」，并写清**为什么**（本仓惯例）。
- **断言「键不存在」用 `Object.hasOwn`（或 `toStrictEqual`）**，**禁止** `toBeUndefined()` / `toEqual` — 前者放过「键在、值为 `undefined`」，后者在 Vitest 里忽略值为 `undefined` 的属性（spec §4.1 末条）。
- **每条新守卫都要做变异验证**：人为造回它要拦的缺陷 ⇒ 确认它**红** ⇒ 还原并核对文件哈希未变。**没见过失败的守卫不算守卫**。
- **单个 `it()` 只留一个必然失败的断言**：同一用例里前面有必然失败的强断言时，后面的弱断言**永不执行**，等于没有守卫（Task 1 的编写口径）。
- **命令一律用 `pnpm.cmd`**（本机 `pnpm.ps1` / `npm.ps1` 被执行策略拦）：`pnpm.cmd vitest run <路径>`、`pnpm.cmd typecheck`、`pnpm.cmd lint`。
- **禁止跑全量 `pnpm test`**：本机 evaluator 有 19/27 个文件卡在收集阶段（另一条工作线在修）⇒ 验证一律**按文件**跑（spec §4.4）。
- **提交逐个显式 `git add <路径>`，禁止 `git add -A`**；`git status` 里不属于本次的文件保持原样、不要动它。
- **commit message 中文、带 scope**（如 `fix(agents/claude-code): …`）。
- Task 1–3 每个收尾按序 `pnpm.cmd typecheck` → `pnpm.cmd lint` → 本 Task 的相关测试文件。

---

### Task 1: claude-code —— `off` 档注入 `CLAUDE_CODE_EXTRA_BODY`（body 覆盖层）

**Files:**
- Modify: `packages/server/agents/src/providers/claude-code/index.ts`（`:76` 常量之后新增常量与纯函数；`:169-190` 的 `injected` 里条件展开一条）
- Test: `packages/server/agents/src/providers/claude-code/index.test.ts`（「claude-code 的思考强度」组 `:588-626`，在 `:625` 之后追加；`:26-30` 的 `afterEach` 补一行）

**Interfaces:**
- Consumes: `EFFORT_OFF`（`@aieval/contracts`，已在 `packages/server/contracts/src/run.ts:85` 定义）、既有常量 `CLAUDE_OFF_EFFORT`（`claude-code/index.ts:76`）、既有 `buildSubprocessEnv`（`agents/src/route.ts:86`，`injected: Record<string, string | undefined>`）。
- Produces:
  - `export const CLAUDE_CODE_EXTRA_BODY = 'CLAUDE_CODE_EXTRA_BODY';`（键名的唯一真源，测试与实现共用）
  - `export function claudeExtraEnvFor(effort: string | undefined): Record<string, string>` —— `off` ⇒ `{ CLAUDE_CODE_EXTRA_BODY: '{"thinking":{"type":"disabled"}}' }`；其余档位与未选 ⇒ `{}`（**纯函数**，与宿主环境无关）

**为什么必须是纯函数**：`recorder.env` 是「宿主 `process.env` + 注入」合并后的对象，用它断言「键不存在」在宿主设过同名变量时会**假红**（spec §5.4 第 4 条）。

- [ ] **Step 1: 写失败测试**

在 `packages/server/agents/src/providers/claude-code/index.test.ts` 的 import 段把 `index.ts` 的导入改为（`:23` 那一行）：

```ts
import {
  CLAUDE_CODE_EXTRA_BODY,
  claudeCodeProvider,
  claudeExtraEnvFor,
} from './index';
```

同一段 import 里还要把 `vitest` 那一行（`:13`）补上 `beforeEach` —— 下面那组的基线清理要用它：

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
```

把 `afterEach`（`:26-30`）补上环境还原（新用例用 `vi.stubEnv`，不还原会漏给后面的用例）：

```ts
afterEach(() => {
  setAgentRuntimeForTesting(null);
  vi.useRealTimers();
  vi.restoreAllMocks();
  // 环境还原：本文件有 `vi.stubEnv` 的用例（body 覆盖层与 WARN 加固），漏还原会漏给后面的用例
  vi.unstubAllEnvs();
});
```

再在「claude-code 的思考强度」组（`:588` 的 `describe(...)` 之后、第一条用例之前）加一个 `beforeEach`，**先把宿主可能设过的同名变量清掉**：

```ts
  /**
   * 基线：先把宿主可能设过的同名变量清掉。
   * 为什么必须有：本组那条「非 off 档位的注入键集合逐字不变」读的是 `recorder.env`，
   * 而它是 `buildSubprocessEnv` 合并后的对象（以宿主 `process.env` 为底，`route.ts:88-90`）
   * ⇒ 宿主设过 `CLAUDE_CODE_EXTRA_BODY` 时那一条会**假红**（它不是我们的缺陷 ——
   * 真机 A/B 的 B 臂恰恰就是靠宿主设这个变量做到的，所以这台机器上它真有可能在场）。
   * 策略与 spec §5.4 第 4 条一致：「键不存在」的判据落在**纯函数**上；真实运行面那一条
   * 则先把宿主那一格清干净。
   * 用 `vi.stubEnv(name, undefined)` 而不是 `delete process.env.X`：后者在测试里也是写入写法。
   * 还原交给文件级 `afterEach` 的 `vi.unstubAllEnvs()`（上面刚加的那一行）。
   */
  beforeEach(() => {
    vi.stubEnv(CLAUDE_CODE_EXTRA_BODY, undefined);
  });
```

在「claude-code 的思考强度」组（`:588-626`）的**末尾**、`:625` 的「档位域首项是 off」那条之后、`});` 之前追加六条用例：

```ts
  /**
   * **`off` 的修复（2026-10-06，spec §3.1）**：契约与界面统一用档名 `off`，而 CLI 的**模型能力门**
   * 会**故意**不把 `thinking:{type:'disabled'}` 写进请求体（它不认识 `deepseek-flash` 这类网关模型名，
   * 真机 A/B 逐字证据：不带 env ⇒ 请求体 8 个顶层键、**没有** `thinking`，响应里仍有思考块；
   * 带 env ⇒ 9 个键、多出 `"thinking":{"type":"disabled"}`，响应 `content_block` 只有 `text`）。
   * ⇒ 这一家必须靠**环境变量覆盖层**兜底；`thinking` 选项那一格（`:216`）保留不动，两半各管一批模型。
   *
   * ⚠️ 判据读的是 `recorder.env`（= 真的交给 SDK spawn CLI 的那一份），不是 `process.env`
   * ——注入了但没接进 spawn 的 env 等于没做。
   */
  it('显式 off ⇒ 注入 CLAUDE_CODE_EXTRA_BODY（从交给 SDK 的那份 env 读）', async () => {
    const recorder = createRecorder();
    setAgentRuntimeForTesting({ sdkModule: { [CLAUDE_PACKAGE_NAME]: createFakeClaudeSdk({ recorder, events: [] }) } });
    await claudeCodeProvider.run(createRunInput({ effort: EFFORT_OFF }));

    expect(recorder.env?.[CLAUDE_CODE_EXTRA_BODY]).toBe('{"thinking":{"type":"disabled"}}');
  });

  /**
   * **值的合法性与形状**（spec §3.3）：CLI 对 `CLAUDE_CODE_EXTRA_BODY` 的**非法 JSON 静默忽略整条**
   * ——不报错、`thinking` 仍缺失、思考照旧。真机上就是这么踩的（第一次 A/B 的 B 臂作废：
   * PowerShell 5.1 吃掉了内层双引号，env 变成 `{thinking:{type:disabled}}`）。
   *
   * 这条用例就是「注入值必须是合法 JSON」的守卫，**变异体逐字同形于真机那次作废**：
   * 把实现从 `JSON.stringify(...)` 改成手写常量 `'{thinking:{type:disabled}}'` ⇒ `JSON.parse` 当场抛。
   */
  it('注入的值是合法 JSON，且深等于 { thinking: { type: disabled } }（非法 JSON 会被 CLI 静默整条忽略）', () => {
    const raw = claudeExtraEnvFor(EFFORT_OFF)[CLAUDE_CODE_EXTRA_BODY];
    expect(raw).toBe('{"thinking":{"type":"disabled"}}');
    // 合法性：解析失败会抛（这正是真机上那次作废的形状）
    expect(JSON.parse(raw ?? '')).toStrictEqual({ thinking: { type: 'disabled' } });
    /**
     * **键名逐字**（**T1 实现者实测修正**）：CLI 只认 `CLAUDE_CODE_EXTRA_BODY` 这一个字符串，
     * 名字写错的后果是**整条静默失效**（CLI 读不到 ⇒ 什么都不做，思考照旧，与「没注入」逐字同形）。
     *
     * ⚠️ 这一格**刻意用字面量字符串**、不走上面那个共享常量：常量与实现同源，键名一旦被改错，
     * 走常量的断言会**跟着一起错**（两边同时变成错的键名 ⇒ 谁也发现不了）—— 旧口径把变异体④
     * 记成「两条一起红」，是一条**不可能成立的读数**；能红的只有这里的字面量。
     * 判据取 `Object.keys`：既钉键名逐字，也钉「只注入这一条」（多注一条同样是行为改变）。
     */
    expect(Object.keys(claudeExtraEnvFor(EFFORT_OFF))).toStrictEqual(['CLAUDE_CODE_EXTRA_BODY']);
  });

  /** 其余档位**不注入**：**纯函数**判据，与宿主是否设过同名变量无关（spec §5.4 第 4 条） */
  it('其它档位不注入：claudeExtraEnvFor(max) 里没有这个键', () => {
    expect(Object.hasOwn(claudeExtraEnvFor('max'), CLAUDE_CODE_EXTRA_BODY)).toBe(false);
  });

  /** 未选**不注入**：同上，走纯函数（宿主环境不得影响这条判据） */
  it('未选档位不注入：claudeExtraEnvFor(undefined) 里没有这个键', () => {
    expect(Object.hasOwn(claudeExtraEnvFor(undefined), CLAUDE_CODE_EXTRA_BODY)).toBe(false);
  });

  /**
   * **其它档位与未选在真实运行里也逐字不变**（spec §1.3 约束 2）。
   * 为什么值得单开一条：上面两条走的是纯函数，证明的是「函数会返回空对象」；这一条证明的是
   * **空对象被条件展开进了 `injected` 之后没有留下任何键**（宿主**没设过**该变量时的形状）。
   *
   * ⚠️ **这一条断不了「显式 `undefined`」那个变异体**（**T1 实现者实测修正**）：`route.ts:94-96`
   * 对值为 `undefined` 的键正是**删掉**，删完 `Object.hasOwn` 一样是 `false` ⇒ 变异体照绿。
   * 能红的形态是**下面那条**「宿主设过 ⇒ 非 off 档**原样留着**」——两者成对读，缺一条就记出
   * 不可能成立的读数。
   */
  it('非 off 档位的注入键集合逐字不变：max 与未选都不带 CLAUDE_CODE_EXTRA_BODY', async () => {
    const withMax = createRecorder();
    setAgentRuntimeForTesting({ sdkModule: { [CLAUDE_PACKAGE_NAME]: createFakeClaudeSdk({ recorder: withMax, events: [] }) } });
    await claudeCodeProvider.run(createRunInput({ effort: 'max' }));
    expect(Object.hasOwn(withMax.env ?? {}, CLAUDE_CODE_EXTRA_BODY)).toBe(false);

    const bare = createRecorder();
    setAgentRuntimeForTesting({ sdkModule: { [CLAUDE_PACKAGE_NAME]: createFakeClaudeSdk({ recorder: bare, events: [] }) } });
    await claudeCodeProvider.run(createRunInput());
    expect(Object.hasOwn(bare.env ?? {}, CLAUDE_CODE_EXTRA_BODY)).toBe(false);
  });

  /**
   * **「不许删键」那一半**（spec §3.1 约束 1 的正身；**T1 实现者实测修正补**）：上面那条只证明
   * 「非 off 档**没有新增**这个键」，而它**拦不住** `[KEY]: off ? VALUE : undefined` 那种实现 ——
   * `buildSubprocessEnv`（`route.ts:94-96`）把 `undefined` 解释成「**删键**」，删完之后
   * `Object.hasOwn` 恰好就是 `false`，正好**满足**上面那条断言（实测：把实现改成显式 `undefined`，
   * 上面那条**照绿**）。⇒「其它档位与未选逐字不变」还差**另一半**：宿主**设过**同名变量时，
   * 非 off 档必须把它**原样留着**（既不许覆盖，也不许删掉）—— **这是变异体②唯一能红的形态**。
   *
   * 这一半同时是宿主环境的**反向**守卫：`beforeEach` 把该变量归零是为了让「键不存在」测的是我们的
   * 代码；这一条反过来**显式设上**它，测的正是「我们没碰宿主的环境」。
   *
   * ⚠️ **两臂都要跑**（`max` **与**未选；T1 门审 Minor 补）：`claudeExtraEnvFor` 里是**两个分支**
   * （`effort === off` 与其余/未选），将来只改其中之一时，**单臂的哨兵是看不见的**。
   */
  it('宿主设过同名变量时，非 off 档与未选都把它原样留给子进程（既没覆盖也没被 undefined 删掉）', async () => {
    vi.stubEnv(CLAUDE_CODE_EXTRA_BODY, 'host-value');
    const withMax = createRecorder();
    setAgentRuntimeForTesting({ sdkModule: { [CLAUDE_PACKAGE_NAME]: createFakeClaudeSdk({ recorder: withMax, events: [] }) } });
    await claudeCodeProvider.run(createRunInput({ effort: 'max' }));
    expect(withMax.env?.[CLAUDE_CODE_EXTRA_BODY]).toBe('host-value');

    const bare = createRecorder();
    setAgentRuntimeForTesting({ sdkModule: { [CLAUDE_PACKAGE_NAME]: createFakeClaudeSdk({ recorder: bare, events: [] }) } });
    await claudeCodeProvider.run(createRunInput());
    expect(bare.env?.[CLAUDE_CODE_EXTRA_BODY]).toBe('host-value');
  });
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `pnpm.cmd vitest run packages/server/agents/src/providers/claude-code/index.test.ts`

Expected: **收集阶段就失败**（`claudeExtraEnvFor` / `CLAUDE_CODE_EXTRA_BODY` 尚未导出 ⇒ import 解析不到）。若只跑了「显式 off ⇒ 注入」而它红在 `undefined`，也说明导出已存在但注入没接上 —— 两种都算这一步通过。

- [ ] **Step 3: 实现（两处，都在 `claude-code/index.ts`）**

**第一步：常量 + 纯函数。** 放在 `CLAUDE_OFF_EFFORT`（`:75-76`）之后：

```ts
/**
 * 关闭档的 **body 覆盖层**（spec §3.1）：CLI 直读 `process.env` 的这个名字，把它的值当作 JSON
 * 摊进请求体，且摊开的位置在 `thinking` **之后** ⇒ 可以覆盖。
 *
 * 为什么需要它（真机 A/B，CLI 2.1.281）：CLI 对「它不认识的模型名」会判定
 * `rejects_disabled_thinking`（stderr：`[claude-code:unrecognized_model] {"model":"deepseek-flash"}`），
 * 于是**故意**不把 `thinking:{type:'disabled'}` 写进请求体 —— 这是有意行为，不是漏读。
 * 而网关本身**认**这个字段（直连同一端点实测：不带 ⇒ 292 字思考块，带 ⇒ 无思考块）。
 *
 * ⚠️ 值**必须**由 `JSON.stringify` 生成（见 `CLAUDE_OFF_EXTRA_BODY`）：CLI 对**非法 JSON 静默忽略
 * 整条**（不报错、思考照旧）。
 */
export const CLAUDE_CODE_EXTRA_BODY = 'CLAUDE_CODE_EXTRA_BODY';

/**
 * 关闭档的注入值。用 `JSON.stringify` 而不是手写字面量，两个理由：
 *   1. **由构造保证合法 JSON**：CLI 对非法值静默忽略整条（真机上 PowerShell 5.1 吃掉内层双引号，
 *      env 变成 `{thinking:{type:disabled}}`，那次 A/B 的 B 臂整条作废）；
 *   2. 逐字节等于真机 A/B 已验证过的那一形态 `{"thinking":{"type":"disabled"}}`（无空格、键序一致）。
 */
const CLAUDE_OFF_EXTRA_BODY = JSON.stringify({ thinking: { type: 'disabled' } });

/**
 * 本次要**额外注入**的环境变量：**只有**关闭档给一条，其余档位与未选给**空对象**。
 *
 * ⚠️ 为什么返回空对象而不是 `{ [KEY]: undefined }`（spec §3.1 约束 1）：`route.ts:94-96` 的语义是
 * 「值为 `undefined` 的键会被**删掉**」⇒ 后者会在非 off 档删掉**宿主继承来的**同名变量，
 * 那是「改变其它档位的行为」，与本次改动的硬约束冲突。
 *
 * 抽成导出的**纯函数**是为了可测：`recorder.env` 是「宿主 + 注入」合并后的对象，
 * 拿它断言「键不存在」在宿主设过同名变量时会假红（spec §5.4 第 4 条）。
 */
export function claudeExtraEnvFor(effort: string | undefined): Record<string, string> {
  return effort === CLAUDE_OFF_EFFORT ? { [CLAUDE_CODE_EXTRA_BODY]: CLAUDE_OFF_EXTRA_BODY } : {};
}
```

**第二步：接进 `injected`。** `startClaudeCode` 里 `buildSubprocessEnv`（`:169-190`）的 `injected` 字面量，在 `CLAUDE_CODE_ENABLE_TODO_TOOLS: '1',` 那一行之后加一行条件展开：

```ts
      // 关闭档的覆盖层（spec §3.1）：**条件展开成空对象**，非 off 档注入键集合逐字不变。
      // 为什么不直接在键上写 undefined：`route.ts:94-96` 会把 undefined 的键**删掉**，
      // 于是非 off 档会顺手删掉宿主继承来的同名变量。
      ...claudeExtraEnvFor(input.effort),
```

> ⚠️ **`index.ts:215-216` 的 `effort` / `thinking` 两格一个字都不要动**（spec §3.1 约束 3）：
> CLI 能力门**放行**的模型由 CLI 自己按 SDK 选项写 `thinking`，**不放行**的（本机网关的
> `deepseek-flash`）由这次新增的 env 覆盖层兜底；删掉任何一半都会让另一半的适用面变窄。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm.cmd typecheck` → `pnpm.cmd vitest run packages/server/agents/src/providers/claude-code/index.test.ts`

Expected: `typecheck` 本次改动引入 0 错；该文件**全绿**（含既有的「显式 off ⇒ thinking: disabled 且不传 effort」与「给了 effort / 没给」两条 —— 它们的判据**一个字都不改**）。

- [ ] **Step 5: 变异验证（四条，逐条「造缺陷 ⇒ 确认红 ⇒ 还原」）**

前置：先记下基线哈希 `Get-FileHash packages/server/agents/src/providers/claude-code/index.ts`。

① **非法 JSON（真机真实发生过的那次作废）**：把 `CLAUDE_OFF_EXTRA_BODY` 改成手写常量
`const CLAUDE_OFF_EXTRA_BODY = '{thinking:{type:disabled}}';`
⇒ **先红的是「显式 off ⇒ 注入」那条的逐字节断言**（`expect(recorder.env?.[…]).toBe('{"thinking":{"type":"disabled"}}')`）。
⚠️ **「注入的值是合法 JSON」那条（`JSON.parse`）够不到**（**T1 门审实测修正**）：它排在第 2 条用例里、
在 `raw` 的逐字节断言**之后**，前一句已经先红 ⇒ 别把 `JSON.parse` 那次抛记成这一格的红的见证
（想让 `JSON.parse` 那条真见过红，得单独把第一句摘掉再变异一次）。
② **条件展开改成显式 `undefined`**：把 `...claudeExtraEnvFor(input.effort),` 改成
`CLAUDE_CODE_EXTRA_BODY: input.effort === CLAUDE_OFF_EFFORT ? CLAUDE_OFF_EXTRA_BODY : undefined,`
⇒ **必须看到**「宿主设过同名变量时，非 off 档**与未选**都把它原样留给子进程（既没覆盖也没被 undefined 删掉）」
那条**红**（该用例自己就 `vi.stubEnv(CLAUDE_CODE_EXTRA_BODY, 'host-value')`；变异下那一格被
`route.ts:94-96` **删掉**，哨兵值取不到）。
⚠️ **T1 实现者实测修正**：「非 off 档位的注入键集合逐字不变」（断 `Object.hasOwn === false`）在这个
变异下**照绿** —— 删键正是 `route.ts:94-96` 对 `undefined` 的处置，删完 `hasOwn` 同样是 `false`
⇒ 旧口径记的是一条**不可能成立的读数**；能红的只有「**值还在不在**」。
③ **无条件注入**：把 `claudeExtraEnvFor` 的返回改成恒返回那一条（删掉 `off` 判断）
⇒ 「其它档位不注入」「未选档位不注入」「非 off 档位的注入键集合逐字不变」**三条一起红**，
外加「宿主设过 ⇒ 非 off 档原样留着」那条也红（我们的值顶掉了宿主的哨兵值）。
④ **键名写错**：把 `CLAUDE_CODE_EXTRA_BODY` 的**值**改成 `'CLAUDE_CODE_EXTRA_BODIES'`
⇒ **必须看到**「注入的值是合法 JSON…」那条里追加的**字面量**判据
（`Object.keys(claudeExtraEnvFor(EFFORT_OFF))` 深等于 `['CLAUDE_CODE_EXTRA_BODY']`）**红**。
⚠️ **T1 实现者实测修正**：经**共享常量**读键的那些断言（「显式 off ⇒ 注入」的取值断言、上面那条
`raw` 与 `JSON.parse`）在这个变异下**都不红** —— 实现与判据读的是同一个常量，写错键名时两边**一起**错
⇒ **字面量判据是这一格唯一有区分力的守卫**（旧口径记「两条一起红」也是一条不可能成立的读数）。

每条改回后重跑该文件全绿，并核对 `Get-FileHash` 与基线一致。

- [ ] **Step 6: 提交**

```bash
git add packages/server/agents/src/providers/claude-code/index.ts packages/server/agents/src/providers/claude-code/index.test.ts
git commit -m "fix(agents/claude-code): off 档注入 CLAUDE_CODE_EXTRA_BODY 覆盖层，真正关掉思考"
```

---

### Task 2: codex —— `off` 档多一格 CLI config `model_reasoning_summary: 'none'`

**Files:**
- Modify: `packages/server/agents/src/providers/codex/sdk.ts`（`CodexConfig`:97-105 加可选键；`buildCodexConfig`:171-187 加可选入参）
- Modify: `packages/server/agents/src/providers/codex/index.ts`（`:63` 常量之后加常量；`:106` 调用点补**第三**实参 —— 它排在 `input.route.contextWindow` **之后**；**别挤掉 `contextWindow` 那一格**，它不在本次改动面里）
- Test: `packages/server/agents/src/providers/codex/index.test.ts`（`RecordedCodexConfig`:29-38 补一格；「codex 的思考强度」组 `:489-524` 末尾追加）
- Test: `packages/server/agents/src/providers/codex/sdk.test.ts`（`:12-31` 的组里追加）

**Interfaces:**
- Consumes: `EFFORT_OFF`（`@aieval/contracts`）、既有常量 `CODEX_OFF_EFFORT`（`codex/index.ts:63`）、既有 `codexEffortOf`（`codex/index.ts:70`）、既有 `buildCodexConfig(baseUrl, contextWindow?)`。
- Produces:
  - `CodexConfig.model_reasoning_summary?: string`（**可选**：`undefined` ⇒ 键整个不出现）
  - `buildCodexConfig(baseUrl: string, contextWindow?: number, reasoningSummary?: string): CodexConfig`
  - `const CODEX_OFF_REASONING_SUMMARY = 'none';`（`codex/index.ts` 文件内常量，不导出）

**为什么是「两格一起」（spec §2.3）**：探针 D-C/E1/stepF 证明触发条件是 **(CLI 硬编码的 `include` ∧ 请求体里的 `summary`) 的合取** —— 只给 `effort:'none'` 单独无效（D-B：`"reasoning":{"effort":"none","summary":"auto"}` + `include` ⇒ 网关仍产出 137 个 reasoning token）；**不给 `summary` 这一格** ⇒ CLI 不往请求体里写 `summary`（上游 `build_reasoning`：`supports_reasoning_summary_parameter && summary != None`）⇒ stepF 实测 `reasoning_tokens: 0`、rollout **0 条 reasoning**（A/B 对照 2 条）。

- [ ] **Step 1: 写失败测试**

**① `codex/sdk.test.ts`** —— 在 `describe('buildCodexConfig 的窗口', …)`（`:12-31`）的末尾、`});` 之前追加两条：

```ts
  /**
   * 关闭档的第二格（spec §3.2 / 探针 stepF）：触发条件是 **(CLI 硬编码的 `include` ∧ `summary`) 的合取**
   * —— 只给 `model_reasoning_effort:"none"` 单独无效（探针 D-B：同批请求体里两格都在，网关照样产出
   * 137 个 reasoning token）。**不给这一格** ⇒ CLI 不往请求体里写 `summary` ⇒ 网关不再推理。
   */
  it('给 summary ⇒ 写 model_reasoning_summary', () => {
    expect(buildCodexConfig('https://gw.example.com/v1', undefined, 'none').model_reasoning_summary).toBe('none');
  });

  /**
   * 不给 summary ⇒ **键整个不出现**，且其余四格逐字不变。
   * 判据用 `Object.hasOwn`（与上面 `model_context_window` 那条是同一形态判据，理由见那里的注释）：
   * 它钉的是「键不存在」这个**形态**本身，而「键不存在」正是「我们没意见」——这一格的后果是
   * CLI 照它自己的默认（`summary: "auto"`）跑，其它档位与未选沿用这个行为。
   * ⚠️ **T2 门审实测修正**：早先这里写「SDK 把 config 摊成 `--config key=value`，一个显式的 `undefined`
   * 会被序列化成字符串交给 CLI」—— **那是错的**：本仓装的 `@openai/codex-sdk`（`dist/index.js:343-345`）
   * 对值为 `undefined` 的键 `if (child === void 0) continue;` ⇒ **不产出任何 `--config` 参数**，
   * 两种形态今天**行为等价**（订正的完整版见 `sdk.ts` 的 `model_reasoning_summary` 那段 JSDoc）。
   */
  it('不给 summary ⇒ 该键不存在，其余键逐字不变（不是 undefined 值）', () => {
    const config = buildCodexConfig('https://gw.example.com/v1');
    expect(Object.hasOwn(config, 'model_reasoning_summary')).toBe(false);
    // 其余键逐字不变（spec §1.3 约束 2 的纯函数面）
    expect(config.model_provider).toBe('aieval');
    expect(config.model_providers.aieval?.base_url).toBe('https://gw.example.com/v1');
    expect(config.model_providers.aieval?.wire_api).toBe('responses');
    expect(config.model_providers.aieval?.requires_openai_auth).toBe(true);
    expect(config.model_providers.aieval?.request_max_retries).toBe(1);
    expect(config.tools).toStrictEqual({ web_search: false, update_plan: { enabled: true } });
    expect(config.features).toStrictEqual({ multi_agent: true });
    expect(Object.hasOwn(config, 'model_context_window')).toBe(false);
  });
```

**② `codex/index.test.ts`** —— 第一步给 `RecordedCodexConfig`（`:29-38`）补一格（不改任何既有断言的判据）：

```ts
interface RecordedCodexConfig {
  model_provider: string;
  model_providers: Record<string, { base_url: string; wire_api: string; requires_openai_auth: boolean }>;
  /** 工具开关：只放这个 CLI 版本认的键（`tools.multi_agent` 会被忽略，见 `buildCodexConfig`） */
  tools: { web_search: boolean; update_plan: { enabled: boolean } };
  /** 特性开关（`multi_agent` 在 CLI 0.156.1 里归这里） */
  features: { multi_agent: boolean };
  /** 上下文窗口：只在供应商清单里声明过时出现（spec §6.2 / D8） */
  model_context_window?: number;
  /**
   * **关闭档的第二格**（本设计 §3.2）：只在 `off` 时出现，值为 `'none'`。
   * 类型是**可选**、且下面用 `Object.hasOwn` 断言 —— 钉的是「键**不存在**」这个形态本身。
   * ⚠️ **T2 门审实测修正**：它与「键在、值为 `undefined`」在本仓的 SDK 下**行为等价** ——
   * `dist/index.js:343-345` 对 `undefined` 值直接 `continue`、**不产出任何 `--config` 参数**
   * （早先「会被 SDK 摊成字符串交给 CLI」的说法是错的）；形态判据的价值在逐键对账与抗 SDK 漂移。
   */
  model_reasoning_summary?: string;
}
```

第二步在「codex 的思考强度」组（`:489-524`）的末尾（`:523` 的「档位域首项是 off」之后、`});` 之前）追加两条：

```ts
  /**
   * **显式 `off` 的两格并存**（spec §3.2 / §4.1 守卫 5）：
   *   · `modelReasoningEffort`（`:119`，**本次不动**）= 关闭档的前半（`off` ⇒ CLI 的 `none`）；
   *   · `model_reasoning_summary`（本次新增，进 `config`）= 后半。
   * 缺任何一半都退回今天：探针 D-B 实测「只有 `effort:'none'`」时网关照样推理；而
   * `model_reasoning_summary` 是**新增的**，所以这一条同时钉住「它真的接进了 client 的 config」。
   */
  it('显式 off ⇒ config.model_reasoning_summary = none，且 modelReasoningEffort 仍是 none（两格并存）', async () => {
    const recorder = createRecorder();
    setAgentRuntimeForTesting({ sdkModule: { [CODEX_PACKAGE_NAME]: createFakeCodexSdk({ recorder, events: [] }) } });
    await codexProvider.run(createRunInput({ effort: EFFORT_OFF }));

    const config = recorder.options?.config as RecordedCodexConfig;
    expect(config.model_reasoning_summary).toBe('none');
    // 后半不能顶掉前半：`modelReasoningEffort` 那一格按 spec §3.2 约束 2 **照旧**给
    expect(recorder.threadOptions?.modelReasoningEffort).toBe('none');
  });

  /**
   * **其余档位与未选逐字不变**（spec §1.3 约束 2、§4.1 守卫 6 / 7）：这一格**键不存在**，
   * 且既有的 `modelReasoningEffort` 语义照旧（`xhigh` 透传、未选一个键都不加）。
   * 判据用 `Object.hasOwn`：`toBeUndefined()` 会放过「键在、值为 undefined」这一形态。
   */
  it('其它档位与未选都不带 model_reasoning_summary 键（逐字不变）', async () => {
    const withEffort = createRecorder();
    setAgentRuntimeForTesting({ sdkModule: { [CODEX_PACKAGE_NAME]: createFakeCodexSdk({ recorder: withEffort, events: [] }) } });
    await codexProvider.run(createRunInput({ effort: 'xhigh' }));
    expect(Object.hasOwn(withEffort.options?.config ?? {}, 'model_reasoning_summary')).toBe(false);
    expect(withEffort.threadOptions?.modelReasoningEffort).toBe('xhigh');

    const bare = createRecorder();
    setAgentRuntimeForTesting({ sdkModule: { [CODEX_PACKAGE_NAME]: createFakeCodexSdk({ recorder: bare, events: [] }) } });
    await codexProvider.run(createRunInput());
    expect(Object.hasOwn(bare.options?.config ?? {}, 'model_reasoning_summary')).toBe(false);
    expect(Object.hasOwn(bare.threadOptions ?? {}, 'modelReasoningEffort')).toBe(false);
  });
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `pnpm.cmd vitest run packages/server/agents/src/providers/codex/sdk.test.ts packages/server/agents/src/providers/codex/index.test.ts`

Expected: **两条**新用例红 —— `sdk.test.ts` 的「**给** summary ⇒ 写 `model_reasoning_summary`」（第三实参尚无效果：`buildCodexConfig` 目前只收两个参数，多传的那个被忽略）与 `index.test.ts` 的「显式 off」那条（`config.model_reasoning_summary` 是 `undefined`）。
「其它档位与未选」那条与 `sdk.test.ts` 的「**不给** summary ⇒ 该键不存在」那条**此时都应当已经绿**（两条断的都是「键不存在」，而现状正是键不存在）—— 那是对的：它们是**回归钉**，靠 Step 5 的变异体⑥/⑧证明有区分力。

> ⚠️ **订正（T2 实测修正）**：原文写「三条新用例红 —— `sdk.test.ts` 的两条 …」，**计数与归因都不对**：本轮新增 4 条里只有 2 条该红，`sdk.test.ts` 的第二条（`Object.hasOwn` 那条）与 index 的哨兵一样是**实现前即绿**的回归钉。⇒ **Task 4 Step 2 的守卫表**不要把这条记成 Step 2 的红，它的红记在**变异体⑥/⑧**名下（T2 两次实测到）。

- [ ] **Step 3: 实现（三处）**

**① `codex/sdk.ts` —— `CodexConfig` 加可选键。** 放在 `model_context_window?: number;`（`:104`）之后、`}` 之前：

```ts
  /**
   * 推理摘要档（CLI 的 `model_reasoning_summary`）。**只在关闭档出现**，值为 `'none'`。
   *
   * 为什么需要它（spec §2.3，探针 D-C / E1 / stepF）：CLI **无条件**在请求体里塞
   * `include:["reasoning.encrypted_content"]`（上游 `client.rs:946`，不可配），而它与
   * `reasoning.summary` **同时存在**时，网关会无视 `reasoning.effort:"none"` 照样推理
   * ——触发条件是两者的**合取**：只有 `include` ⇒ 0 个 reasoning token，`effort:'none'` +
   * `summary:'auto'` + `include` ⇒ 137 个。**不给这一格**，CLI 就不往请求体里写 `summary`
   * （上游 `build_reasoning`：`supports_reasoning_summary_parameter && summary != None`）。
   *
   * ⚠️ 未知时**整个键都不给**（调用方传 `undefined`），与 `model_context_window` 同一写法：
   * 「键不存在」才是「我们没意见」的**形态**。为什么要钉形态而不看值：配置对象是我们与 CLI 之间
   * 唯一的对账面（逐键等于「我们注入了什么」），而**值为 `undefined`** 这一形态会让对账多一层解释。
   * ⚠️ **不要**沿用早先那句「显式 `undefined` 会被摊成字符串交给 CLI」—— 那是**错的**
   * （**T2 门审实测修正**）：本仓装的 SDK 对值为 `undefined` 的键直接跳过（`dist/index.js:343-345` 的
   * `if (child === void 0) continue;` ⇒ **不产出任何 `--config` 参数**），两种形态今天**行为等价**。
   * 保留形态判据是为了对账与**抗 SDK 漂移**（升级后若把 `undefined` 改成写空值或报错，形态判据仍然
   * 拦得住）。
   */
  model_reasoning_summary?: string;
```

**② `codex/sdk.ts` —— `buildCodexConfig` 加可选入参。** 整个函数替换为：

```ts
export function buildCodexConfig(
  baseUrl: string,
  contextWindow?: number,
  /** 关闭档的第二格（spec §3.2）。`undefined` ⇒ 键整个不出现，CLI 照它自己的默认 `summary:"auto"` 跑 */
  reasoningSummary?: string,
): CodexConfig {
  return {
    model_provider: CODEX_PROVIDER_ID,
    model_providers: {
      [CODEX_PROVIDER_ID]: {
        name: 'aieval gateway',
        base_url: baseUrl,
        wire_api: 'responses',
        requires_openai_auth: true,
        request_max_retries: 1,
      },
    },
    tools: { web_search: false, update_plan: { enabled: true } },
    features: { multi_agent: true },
    ...(contextWindow === undefined ? {} : { model_context_window: contextWindow }),
    // 与上面同一判据形态：`undefined` ⇒ **键整个不出现**（不是「值为 undefined」）
    ...(reasoningSummary === undefined ? {} : { model_reasoning_summary: reasoningSummary }),
  };
}
```

**③ `codex/index.ts` —— 常量 + 调用点。** 常量放在 `CODEX_OFF_EFFORT`（`:62-63`）之后：

```ts
/**
 * 关闭档的**第二格**取值（spec §3.2）：CLI 的 `model_reasoning_summary`。
 *
 * 为什么不复用 `codexEffortOf`：那是 `model_reasoning_effort` 那一格的映射（`off` ⇒ `none`），
 * 而这一格是**另一个配置键**——两格一起才生效（见 `CodexConfig.model_reasoning_summary` 的注释）。
 */
const CODEX_OFF_REASONING_SUMMARY = 'none';
```

把 `:105-106` 那两行改为（`:105` 的注释保留并补一句）：

```ts
      // 窗口交给 CLI 的 config（`--config model_context_window=…`）；未知时不写该键（见 buildCodexConfig 的注释）
      // 关闭档的第二格（spec §3.2）：**只在 `off` 时**给 `model_reasoning_summary:'none'`——
      // 它与下面 `modelReasoningEffort` 的 `none` 是**两格一起**才生效的前后半（只给后半时，
      // 网关因 `include ∧ summary` 的组合照旧推理）。其余档位与未选传 `undefined` ⇒ config 里没有这个键。
      config: buildCodexConfig(
        baseUrl,
        input.route.contextWindow,
        input.effort === CODEX_OFF_EFFORT ? CODEX_OFF_REASONING_SUMMARY : undefined,
      ),
```

> ⚠️ **`codex/index.ts:119` 的 `modelReasoningEffort` 一个字都不要动**（spec §3.2 约束 2）：
> `off ⇒ 'none'` 仍是关闭的前半，去掉它会退回「网关默认」。也不要改 `codexEffortOf`（约束 3）。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm.cmd typecheck` → `pnpm.cmd vitest run packages/server/agents/src/providers/codex/sdk.test.ts packages/server/agents/src/providers/codex/index.test.ts`

Expected: 两个文件全绿（既有用例判据**一个字都不改**）。

- [ ] **Step 5: 变异验证（四条）**

前置：记录两个文件的基线哈希（`codex/sdk.ts`、`codex/index.ts`）。

⑤ **`off` 时不传 `'none'`（保持现状）**：把调用点第三实参换成恒 `undefined`
⇒ 「显式 off ⇒ config.model_reasoning_summary = none」**红**。
⑥ **无条件带 `summary: 'auto'`**：把 `buildCodexConfig` 的末行条件展开改成
`...(reasoningSummary === undefined ? { model_reasoning_summary: 'auto' } : { model_reasoning_summary: reasoningSummary }),`
⇒ `sdk.test.ts` 的「不给 summary ⇒ 该键不存在」**红**，`index.test.ts` 的「其它档位与未选都不带…」**红**（**这就是那条回归钉的区分力证据**）。
⑦ **键名拼成 CLI 不认的写法**：把 `model_reasoning_summary` 改成 `model_reasoning_summaries`（两处）
⇒ 「给 summary ⇒ 写 model_reasoning_summary」**红**、「显式 off ⇒ config.model_reasoning_summary = none」**红**。
（真机上这一格的后果是 CLI 回一句「unrecognized configuration settings」后**照默认值跑** ⇒ 退回今天。）
⑧ **「键缺席」改成显式 `undefined`**：把末行改成 `model_reasoning_summary: reasoningSummary,`
⇒ 「不给 summary ⇒ 该键不存在」**红**、`index.test.ts` 的「其它档位与未选都不带…」**红**
（`Object.hasOwn` 为真）。**注意**：这正是判据**不能**写成 `toBeUndefined()` 的理由 —— 那种写法在这一变异下**不红**。

> ⚠️ **订正（T2 门审实测修正）**：⑧ 是**结构性变异体**、**不是缺陷** —— 它今日与正确实现**行为等价**：
> 本仓装的 `@openai/codex-sdk`（`dist/index.js:344`）有 `if (child === void 0) { continue; }` ⇒
> **值为 `undefined` 的键不外发任何 `--config` 参数**。早先把 ⑧ 记成「抓到缺陷」**是错的**（那两条红只证明
> **形态判据有区分力**，不证明有行为差异）。它仍然**值得保留**：钉的是「键**不存在**」这个**形态**本身 ⇒
> 便于逐键对账，且 SDK 升级后若把 `undefined` 改成写空值 / 报错，这条判据仍然挡得住（**抗 SDK 漂移**）。
> ⇒ **Task 4 Step 2 的守卫表**里别把 ⑧ 记成「抓到缺陷」。

每条改回后重跑两个文件全绿，并核对 `Get-FileHash` 与基线一致。

- [ ] **Step 6: 提交**

```bash
git add packages/server/agents/src/providers/codex/sdk.ts packages/server/agents/src/providers/codex/index.ts packages/server/agents/src/providers/codex/sdk.test.ts packages/server/agents/src/providers/codex/index.test.ts
git commit -m "fix(agents/codex): off 档补 model_reasoning_summary=none，绕开 include∧summary 的组合触发"
```

---

### Task 3: claude-code —— `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` 的 WARN 加固

**Files:**
- Modify: `packages/server/agents/src/providers/claude-code/index.ts`（`startClaudeCode` 之前新增常量 + 纯函数；`buildSubprocessEnv` 之后调用一次）
- Test: `packages/server/agents/src/providers/claude-code/index.test.ts`（Task 1 新增的那组用例之后追加；`beforeEach` 先清同名变量）

**Interfaces:**
- Consumes: `claudeExtraEnvFor` / `CLAUDE_CODE_EXTRA_BODY`（Task 1 已产出）、既有 `logger`（`claude-code/index.ts:33` 的 `createLogger('agents/claude-code')`；`warn` 走 `console.warn`，见 `core/src/logger.ts:43`）、既有 `buildSubprocessEnv` 的返回值（`route.ts:86-99`，宿主 `process.env` 为底，**键名形态逐项保留**——`route.ts:76-84`）。
- Produces:
  - `export const HOST_DISABLE_BETAS_ENV = 'CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS';`
  - `export function hostDisablesBetas(hostEnv: Record<string, string | undefined>, effort: string | undefined): string | null` —— **两参**：`effort` 也是判据的一部分（**只在 `off` 档看**，其余档位与未选一律 `null`，见 Step 3 的实现）；键名**大小写不敏感**查找：命中 ⇒ 返回**宿主用的那个拼写原文**；没命中 ⇒ `null`（纯函数）
  - `const CLAUDE_OFF_DISABLED_WARNING`（文件内常量，**spec §5.4-3 的逐字文案**，`<键名原文>` 是唯一可变 token）
  - `export const CLAUDE_OFF_DISABLED_WARNING_TEXT`（同一段文案的**只读**导出，**只为测试能逐字比对**；测试自己再抄一份正文等于两份必然漂移）

**为什么要有这一格（spec §5.4-3，控制者已裁定）**：`CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` 是 `off` 修复的**前置条件**（它一旦被设，CLI 的 body 覆盖层就不再生效），而它由**宿主环境继承**（`route.ts:88-90` 以 `process.env` 为底）⇒ 宿主设过就是「修复**静默**失效」，正是本设计要消灭的那类静默。

**四条必须照做的口径（spec §5.4-3 的五条，逐条落到下面）：**

1. **判据 = 三件套**：① 只看**存在**（`!== undefined`）而不是真值（宿主可能写 `true` / `1` / 空串）；② 键名**大小写不敏感**查找、并**回报原拼写**（`route.ts:76-84`：Windows 的环境块常写 `Path`）；③ **只在 `off` 档看**（其余档位与未选**连一条日志都不多**，守 §1.3 约束 2）。
2. **文案逐字**（spec §5.4-3 原文，实现者**照抄、不许改写**）：全句唯一可变 token 是 `<键名原文>`；句式是**确定性陈述**，不许改写成疑问句、不许出现「可能」。
3. **它是观测，不是拦截**：不许抛错、不许跳过这一行、不许改动注入（**WARN 出现时 `CLAUDE_CODE_EXTRA_BODY` 照旧逐字注入**）、不许删改宿主那个变量。WARN 之后的行为与没有它时**逐字相同**。
4. **一次运行至多一条 WARN**（判据就地判一次，`startClaudeCode` 每次运行只跑一次 ⇒ 不刷屏）。

> ⚠️ 测试侧**必须**用 `vi.stubEnv(name, value)` / `vi.stubEnv(name, undefined)`，**禁止** `process.env.X = …`：产品源的任何宿主环境写入都被全仓静态断言拦住（`static-assertions.test.ts:24-37/78-89`），而那个扫描面**排除 `*.test.ts`**（`:18-22`）⇒ 测试侧用 `vi.stubEnv` 合法且文本上不触发该断言。

- [ ] **Step 1: 写失败测试**

在 `packages/server/agents/src/providers/claude-code/index.test.ts` 的 import 段（Task 1 已改成多行形式）再补两个名字：

```ts
import {
  CLAUDE_CODE_EXTRA_BODY,
  CLAUDE_OFF_DISABLED_WARNING_TEXT,
  claudeCodeProvider,
  claudeExtraEnvFor,
  HOST_DISABLE_BETAS_ENV,
  hostDisablesBetas,
} from './index';
```

**钩子放哪，按 `describe` 边界判**（**判据**，不是禁令）——`beforeEach` 只在它所在的 `describe` 内生效，
跨组覆盖不到，所以先看本 Task 这六条用例落在哪：

- 与 Task 1 新增那六条**在同一个 `describe`**（「claude-code 的思考强度」）内 ⇒ **并进 Task 1 那个
  `beforeEach`**（同一处清理；两份理由必然漂移）。补完那一处长这样（**基线必须先把宿主可能设过的
  同名变量清掉**，否则「不出现」那一条会因宿主而假红）：
- 若另起一个 `describe`（或写到别的组里）⇒ **在那个组里另开一个 `beforeEach`**，把下面这段（含注释）
  搬进那个 `describe`，**只留本组要清的那一格**（各管各的更清晰：钩子的作用域就是它所在的 describe）。

```ts
  // Task 1 那段基线注（`recorder.env` 是宿主 + 注入的合并对象 ⇒ 宿主设过就假红）在这里同样成立，
  // 所以只在**同一个**钩子里补这一行，理由不复述（免两处漂移）。
  beforeEach(() => {
    vi.stubEnv(CLAUDE_CODE_EXTRA_BODY, undefined);
    vi.stubEnv(HOST_DISABLE_BETAS_ENV, undefined);
  });
```

在 Task 1 新增的那组用例之后追加六条：

```ts
  /**
   * **守卫 9a（纯判据四例）**（spec §4.1 守卫 9a / §5.4-3 的判据三件套）：
   * ① env 无该键 ⇒ `null`；② 设 `'1'` ⇒ 返回命中（**键名原文**）；③ 设**小写拼写** ⇒ 同样命中、
   * 且回报的是**原拼写**（`route.ts:76-84`：逐项保留宿主的键名形态，Windows 常写 `Path`）；
   * ④ `'high'` 与未选 ⇒ 一律 `null`（**非 off 档不看**）。
   */
  it('判据（纯函数）四例：无键 ⇒ null；设 1 ⇒ 命中；小写拼写 ⇒ 命中且回报原拼写；非 off 档 ⇒ null', () => {
    /**
     * ⚠️ **每一例都要显式给第二个实参 `effort`**：它是判据的一部分（只在 `off` 档看），
     * 少给一个就等于「未选」⇒ 前三例会全部返回 `null`（连「命中」那两例也拿不到键名），
     * 而 `effort` 在签名里是**必需**参数 —— 漏给还会让 `pnpm.cmd typecheck` 报 TS2554。
     */
    expect(hostDisablesBetas({}, EFFORT_OFF)).toBeNull();
    expect(hostDisablesBetas({ [HOST_DISABLE_BETAS_ENV]: '1' }, EFFORT_OFF)).toBe(HOST_DISABLE_BETAS_ENV);

    // ③ 大小写不敏感、回报原拼写（变异体⑨的靶子：大小写敏感的精确键查找会在这里漏报）
    const lower = 'claude_code_disable_experimental_betas';
    expect(hostDisablesBetas({ [lower]: '1' }, EFFORT_OFF)).toBe(lower);

    // ④ 非 off 档不看：`off` 门就在这个函数里，所以「档位」也得是它的入参
    expect(hostDisablesBetas({ [HOST_DISABLE_BETAS_ENV]: '1' }, 'high')).toBeNull();
    expect(hostDisablesBetas({ [HOST_DISABLE_BETAS_ENV]: '1' }, undefined)).toBeNull();
  });

  /**
   * **守卫 9b 的第一、二半**（spec §4.1 守卫 9b）：`off` 档 + 宿主设过 ⇒ `console.warn` 收到 WARN，
   * **且 message 逐字等于 §5.4-3 那段**（`<键名原文>` 处替换成实际拼写）。
   *
   * ⚠️ 第二半是**「不许改写」的守卫**：文案既然是契约，就得有断言钉住，否则必然漂。
   * 逐字的那一份正文由实现导出（`CLAUDE_OFF_DISABLED_WARNING_TEXT`）——测试自己再抄一份，
   * 改口径时必然漏掉一处，那正是本仓最忌讳的「两份必然漂移」。
   *
   * ⚠️ 取值用 `'true'`（宿主的常见写法）而**不是** `'1'`：判据是「变量在不在」，
   * 窄成 `=== '1'` 会在这一形态下不告警（变异体⑩）。
   */
  it('off 档 + 宿主设过 ⇒ 落一条 WARN，message 逐字等于 spec §5.4-3 那段', async () => {
    vi.stubEnv(HOST_DISABLE_BETAS_ENV, 'true');
    /** `console.warn(message, context)` 的原文（两个参数都收下：下面分别比对 message 与 context） */
    const calls: unknown[][] = [];
    vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      calls.push(args);
    });
    const recorder = createRecorder();
    setAgentRuntimeForTesting({ sdkModule: { [CLAUDE_PACKAGE_NAME]: createFakeClaudeSdk({ recorder, events: [] }) } });

    await claudeCodeProvider.run(createRunInput({ effort: EFFORT_OFF }));

    /**
     * ① message **逐字**：日志器的前缀 `[WARN] [agents/claude-code] ` 由 `core/src/logger.ts:25-27`
     * 的 `format` 拼出，**不在** message 里 ⇒ 这里比的是去掉前缀之后的那一段。
     */
    const expected = CLAUDE_OFF_DISABLED_WARNING_TEXT.replace('<键名原文>', HOST_DISABLE_BETAS_ENV);
    expect(calls.length).toBeGreaterThan(0);
    const hit = calls.find((args) => String(args[0]).endsWith(expected));
    expect(hit).toBeDefined();
    // 顺带钉住「没有第二个参数混进 message」：参数 0 必须**以那段文案结尾**（前缀之外一字不多）
    expect(String(hit?.[0])).toBe(`[WARN] [agents/claude-code] ${expected}`);
    // ② context 固定为 `{ variable: '<键名原文>', effort: 'off' }`（作为第二个参数透传，不 JSON.stringify）
    expect(hit?.[1]).toStrictEqual({ variable: HOST_DISABLE_BETAS_ENV, effort: EFFORT_OFF });
  });

  /**
   * **守卫 9b 的第三半 + 变异体⑪的靶子**（spec §5.4-3「它是观测，不是拦截」）：
   * WARN 出现时 `CLAUDE_CODE_EXTRA_BODY` **照旧逐字注入**，本行也**照常跑完**（不抛、不跳过）。
   */
  it('观测不拦截：WARN 出现时覆盖层仍逐字注入，本行照常跑完', async () => {
    vi.stubEnv(HOST_DISABLE_BETAS_ENV, 'true');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const recorder = createRecorder();
    setAgentRuntimeForTesting({ sdkModule: { [CLAUDE_PACKAGE_NAME]: createFakeClaudeSdk({ recorder, events: [] }) } });

    const result = await claudeCodeProvider.run(createRunInput({ effort: EFFORT_OFF }));

    expect(recorder.env?.[CLAUDE_CODE_EXTRA_BODY]).toBe('{"thinking":{"type":"disabled"}}');
    expect(result.ok).toBe(true);
  });

  /** **守卫 9b 的第四半**：`vi.stubEnv(name, undefined)`（= 宿主没设）⇒ 跑 `off` **不出现** WARN */
  it('宿主没设 ⇒ off 档不出现 WARN', async () => {
    const warnings: string[] = [];
    vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warnings.push(args.map((arg) => String(arg)).join(' '));
    });
    const recorder = createRecorder();
    setAgentRuntimeForTesting({ sdkModule: { [CLAUDE_PACKAGE_NAME]: createFakeClaudeSdk({ recorder, events: [] }) } });

    await claudeCodeProvider.run(createRunInput({ effort: EFFORT_OFF }));

    expect(warnings.filter((line) => line.includes(HOST_DISABLE_BETAS_ENV))).toStrictEqual([]);
  });

  /**
   * **其余档位连一条日志都不多**（spec §1.3 约束 2 / §5.4-3 判据③：这是**新增的输出**，
   * 不能漏到别的档位上）。与上一条分成两个用例：一个是「它不说话」、一个是「它乱说话」，
   * 失败原因完全不同。
   */
  it('非 off 档位即使宿主设过该变量也不告警（新增输出不外溢）', async () => {
    vi.stubEnv(HOST_DISABLE_BETAS_ENV, 'true');
    const warnings: string[] = [];
    vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warnings.push(args.map((arg) => String(arg)).join(' '));
    });
    const recorder = createRecorder();
    setAgentRuntimeForTesting({ sdkModule: { [CLAUDE_PACKAGE_NAME]: createFakeClaudeSdk({ recorder, events: [] }) } });

    await claudeCodeProvider.run(createRunInput({ effort: 'high' }));

    expect(warnings.filter((line) => line.includes(HOST_DISABLE_BETAS_ENV))).toStrictEqual([]);
  });

  /**
   * **导出给测试的那段文案必须与 spec §5.4-3 逐字一致**（含唯一可变 token 的位置）。
   * 这条用例是**最后一道**防漂移：上面那条比的是「运行时 message = 实现导出的常量」，
   * 这一条比的是「那个常量 = spec 的原文」——两半合起来才等价于「message = spec 原文」。
   */
  it('WARN 文案模板与 spec §5.4-3 逐字一致（<键名原文> 是唯一可变 token）', () => {
    expect(CLAUDE_OFF_DISABLED_WARNING_TEXT).toBe(
      'off 档的关闭被静默忽略：子进程环境里存在 <键名原文>，它使 CLAUDE_CODE_EXTRA_BODY 的 body 覆盖失效，本次运行的 off 档读数作废；处置：从运行环境里去掉该变量后重跑，或改用别的方式关闭思考。',
    );
  });
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `pnpm.cmd vitest run packages/server/agents/src/providers/claude-code/index.test.ts`

Expected: **4 条用例失败**（**T3 实测修正**：原文写「收集阶段失败」**不成立** —— Vite 的 SSR 转换
**不强制**命名导出存在，缺失的 `HOST_DISABLE_BETAS_ENV` / `hostDisablesBetas` /
`CLAUDE_OFF_DISABLED_WARNING_TEXT` 在运行期是 `undefined`）：3 条缺实现
（`hostDisablesBetas is not a function`、`Cannot read properties of undefined (reading 'replace')`、
`expected undefined to be 'off 档的关闭被静默忽略：…'`）**外加 1 条既存环境假红**（`cwd 做 realpath 归一`，
改动前后读数相同）。**TDD 的红门照常成立**，只是红的形状不同。

- [ ] **Step 3: 实现（两处，都在 `claude-code/index.ts`）**

**第一步：常量 + 纯函数。** 放在 Task 1 新增的 `claudeExtraEnvFor` 之后：

```ts
/**
 * 会让 `off` 的修复**静默失效**的宿主环境变量（spec §5.3 / §5.4-3）。
 *
 * 它是 CLI 侧那道闸门的**条件位**：一旦被设，body 覆盖层不再生效 —— 而它由宿主环境继承
 * （`route.ts:88-90` 以 `process.env` 为底）。我们不能替宿主清掉它（那要动 `route.ts` 的合并语义，
 * 属于「改变其它档位的行为」），能做的是**不要静默**：见 `hostDisablesBetas`。
 */
export const HOST_DISABLE_BETAS_ENV = 'CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS';

/**
 * `off` 档那条 WARN 的**文案模板**（spec §5.4-3，**逐字照抄、不许改写**）。
 * 全句唯一可变 token 是 `<键名原文>`（= `hostDisablesBetas` 回报的那个拼写），其余字符逐字；
 * 句式是**确定性陈述**：不许改写成疑问句、不许出现「可能」。
 *
 * ⚠️ 导出（只读）是**为了测试能逐字比对**：让用例自己再抄一份正文，改口径时必然漏掉一处
 * ——那正是本仓最忌讳的「两份必然漂移」。
 */
export const CLAUDE_OFF_DISABLED_WARNING_TEXT =
  'off 档的关闭被静默忽略：子进程环境里存在 <键名原文>，它使 CLAUDE_CODE_EXTRA_BODY 的 body 覆盖失效，本次运行的 off 档读数作废；处置：从运行环境里去掉该变量后重跑，或改用别的方式关闭思考。';

/**
 * 拼出本次要落的那条 WARN（模板 + **实际命中的那个拼写**；`logger.warn` 的第一个参数，不 `JSON.stringify`）。
 * 做成函数而不是常量：`<键名原文>` 要换的是 `hostDisablesBetas` 回报的**原拼写**，
 * 而在模块加载期把它写死成 `HOST_DISABLE_BETAS_ENV` 会在宿主写成小写时**报错名字**（正是 §5.4-3 ② 要防的）。
 */
function claudeOffDisabledWarning(variable: string): string {
  return CLAUDE_OFF_DISABLED_WARNING_TEXT.replace('<键名原文>', variable);
}

/**
 * `off` 档的前置条件判据（**纯函数**，spec §5.4-3 的判据三件套）：`off` 档且合并后的宿主 / 子进程
 * 环境里**存在** `HOST_DISABLE_BETAS_ENV` ⇒ 返回**宿主用的那个键名原文**；否则 `null`。
 *
 * 三个细节都是判据的一部分（每条都有一个具体的失败形状）：
 *   ① `effort` 也必须进判据（**只在 `off` 档看**）：其余档位与未选**连一条日志都不多**，
 *      否则就违反了「其余档位逐字不变」（§1.3 约束 2）——那是**新增的输出**，同样算改变行为；
 *   ② 看的是**存在**（`!== undefined`）而不是真值：宿主可能写 `true` / `1` / 空串，三种都会让
 *      覆盖层失效；窄成 `=== '1'` 就会出现「宿主设了、我们一声不吭」（变异体⑩）；
 *   ③ 键名**大小写不敏感**查找、并**回报原拼写**：`route.ts:76-84` 记着「逐项保留宿主的键名形态」
 *      （Windows 的环境块常写 `Path`），只认一种拼写会漏报（变异体⑨）。
 *
 * 抽成导出的纯函数是为了可测：直接读 `process.env` 的判据没法在用例里确定性地摆出这几种形态
 * （`recorder.env` 是「宿主 + 注入」的合并对象，拿它断言在宿主设过时必然假红，见 §5.4 第 3 条）。
 */
export function hostDisablesBetas(
  hostEnv: Record<string, string | undefined>,
  effort: string | undefined,
): string | null {
  // ① 只在关闭档看
  if (effort !== CLAUDE_OFF_EFFORT) return null;
  // ②③ 大小写不敏感地找第一个命中的键名，并**原样**返回它
  for (const key of Object.keys(hostEnv)) {
    if (key.toLowerCase() !== HOST_DISABLE_BETAS_ENV.toLowerCase()) continue;
    if (hostEnv[key] !== undefined) return key;
  }
  return null;
}
```

**第二步：在 `startClaudeCode` 里调用一次。** 放在 `const env = buildSubprocessEnv({ … });`（`:169-190`）之后、`const cwd = canonicalCwd(input.cwd);`（`:191`）之前：

```ts
  /**
   * `off` 档的前置条件核对（spec §5.4-3，控制者裁定加）：宿主若设过 `HOST_DISABLE_BETAS_ENV`，
   * 上面那条 body 覆盖层**不会生效**（CLI 侧闸门的条件位），而这件事在结果里看不出来
   * （思考照旧、不报错）⇒ 至少要在日志里点一句名：**本次运行的 `off` 档读数作废**。
   *
   * 判据用**合并后**的 `env`（= 真的交给 CLI 的那一份），不是裸 `process.env`：覆盖层与这个变量
   * 都只在子进程环境里起作用，读同一份才不会有第二次翻译。
   *
   * ⚠️ **它是观测，不是拦截**：不许抛错、不许跳过这一行、不许因此改动注入、不许删改宿主那个变量
   * ——WARN 之后的行为与没有它时**逐字相同**（`injected` 在上面已经构造完，这里只读不写）。
   * 就地判一次 ⇒ 一次运行至多一条 WARN（`startClaudeCode` 每次运行只跑一次），不刷屏。
   */
  const betasVariable = hostDisablesBetas(env, input.effort);
  if (betasVariable !== null) {
    // 文案逐字来自 CLAUDE_OFF_DISABLED_WARNING_TEXT（spec §5.4-3：唯一可变 token 是键名原文）；
    // context 固定为 `{ variable, effort }`，作为 console 的**第二个参数**透传（不 JSON.stringify）
    logger.warn(claudeOffDisabledWarning(betasVariable), { variable: betasVariable, effort: input.effort });
  }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm.cmd typecheck` → `pnpm.cmd vitest run packages/server/agents/src/providers/claude-code/index.test.ts`

Expected: 全绿（Task 1 的五条 + 本 Task 的六条 + 既有各条）。

- [ ] **Step 5: 变异验证（三条，对应 spec §4.2 ⑨⑩⑪）**

前置：记录 `claude-code/index.ts` 的基线哈希。

⑨ **判据改成大小写敏感的精确键**：把 `hostDisablesBetas` 里那个循环换成
`const value = hostEnv[HOST_DISABLE_BETAS_ENV]; return value === undefined ? null : HOST_DISABLE_BETAS_ENV;`
⇒ 守卫 9a 的**小写拼写**那一例**红**（`route.ts:76-84` 的键名形态逐项保留，只认一种拼写会漏报）。
⑩ **判据窄成真值判断 / 删掉 `off` 门**（**两条子变异各做一次**）：
· 把存在判据改成 `if (hostEnv[key] !== '1') continue;` ⇒ 守卫 9b 的接线用例**红**（桩的是 `'true'`）；
· 把开头的 `if (effort !== CLAUDE_OFF_EFFORT) return null;` 删掉 ⇒ 守卫 9a 的**非 off 两例**红、且「非 off 档位…不告警」**红**。
⑪ **把 WARN 做成拦截**（**两条子变异**）：
· 在 WARN 之后加一句 `throw new Error('…');` ⇒ 「观测不拦截」那条**红**（`await` 当场抛，运行没跑完、`result.ok` 拿不到）；
· 把 WARN 的注入改掉（例如 `const injected = betasVariable === null ? claudeExtraEnvFor(input.effort) : {}`，即「出现 WARN 时不再注入」）⇒ 同一条**红**（`recorder.env.CLAUDE_CODE_EXTRA_BODY` 不再是那段逐字值）。
  说明结构上的保证：`claudeExtraEnvFor` 在 `injected` 字面量里展开、WARN 在其**之后**且只读 `env`，
  所以「观测不拦截」不是靠自觉——但守卫仍要留着，因为**注入点被挪到 WARN 之后的写法照样能编译通过**。

每条改回后重跑该文件全绿，并核对 `Get-FileHash` 与基线一致。

- [ ] **Step 6: 提交**

```bash
git add packages/server/agents/src/providers/claude-code/index.ts packages/server/agents/src/providers/claude-code/index.test.ts
git commit -m "fix(agents/claude-code): off 档若宿主设过 DISABLE_EXPERIMENTAL_BETAS 则落逐字 WARN，不静默失效"
```

---

### Task 4: 门禁与变异矩阵核对（逐条对齐 spec §4.1 / §4.2）

**Files:** 无（只跑命令与核对；**本 Task 不产生任何文件改动**，故无提交步骤）

**Interfaces:**
- Consumes: Task 1 / 2 / 3 的全部产出。
- Produces: 一份可写进交付报告的对照表（守卫编号 → 用例名 → 变异体 → 见过的那次红）。

- [ ] **Step 1: 三条门禁（按文件口径）**

Run: `pnpm.cmd typecheck` → `pnpm.cmd lint` → `pnpm.cmd vitest run packages/server/agents/src/providers/claude-code/index.test.ts packages/server/agents/src/providers/codex/index.test.ts packages/server/agents/src/providers/codex/sdk.test.ts`

判据（本仓是共享工作区，按此读）：

- `typecheck`：判据是「**本次改动引入 0 错**」。`git status` 里**不属于本次**的文件（如别人未提交的 `codex/appserver/*`、`claude-code/subagent-usage*`）若有错，逐条列明并归因到别人，不算本次的红；
- `lint`：全绿（根命令一个进程覆盖 8 个包）；
- 三个测试文件：全绿。

⚠️ **不要跑全量 `pnpm test`**（本机 evaluator 19/27 个文件卡在收集阶段，另一条工作线在修）。本线的测试证据口径 = **这三个文件单跑 + 逐条变异**（spec §4.4）。

- [ ] **Step 2: 逐条核对 spec §4.1 的 9 条断言**

对着 spec §4.1 的表逐行核对，缺哪条补哪条（下表已经指明每条落在哪个文件；**守卫 4 是既有用例、判据不改**）：

| # | 断言 | 落在 |
|---|---|---|
| 1 | claude `off` ⇒ 注入 `CLAUDE_CODE_EXTRA_BODY`，键名逐字 + 值 `JSON.parse` 后深等于 `{thinking:{type:'disabled'}}`（从 `recorder.env` 读） | Task 1 Step 1 的第 1、2 条（键名「逐字」由第 2 条里那句**字面量** `Object.keys` 判据承担 —— 经共享常量读键的断言看不见键名写错，**T1 实现者实测修正**） |
| 2 | claude `max` ⇒ 不注入（纯函数 `Object.hasOwn` 为假） | Task 1 Step 1 的第 3、5 条 + **第 6 条**（宿主设过时「原样留着」—— 变异体②**唯一**能红的形态） |
| 3 | claude 未选 ⇒ 不注入（同上） | Task 1 Step 1 的第 4、5 条 + **第 6 条**（同上，它的哨兵值是宿主设的，非 off 档一律适用） |
| 4 | claude 既有两条判据逐字不变（`off` ⇒ `thinking:{type:'disabled'}` 且无 `effort` 键；未选 ⇒ 两格都不出现） | 既有用例（`index.test.ts:589-621`）**不改判据**，Task 1 Step 4 复跑确认仍绿 |
| 5 | codex `off` ⇒ `config.model_reasoning_summary === 'none'` **且** `threadOptions.modelReasoningEffort === 'none'` | Task 2 Step 1 的第 1 条 |
| 6 | codex `xhigh` ⇒ `Object.hasOwn(config, 'model_reasoning_summary') === false` | Task 2 Step 1 的第 2 条 |
| 7 | codex 未选 ⇒ 同上，且 `modelReasoningEffort` 键也不存在 | Task 2 Step 1 的第 2 条 |
| 8 | `buildCodexConfig` 纯函数两端（传 `'none'` ⇒ 键在；不传 ⇒ 键不存在；其余键逐字不变） | Task 2 Step 1 的 `sdk.test.ts` 两条 |
| 9a | claude WARN 的**纯判据四例**：无键 ⇒ `null`；设 `'1'` ⇒ 命中；**小写拼写** ⇒ 命中且回报原拼写；`'high'` / 未选 ⇒ `null` | Task 3 Step 1 的第 1 条 |
| 9b | claude WARN 的**接线**：`vi.stubEnv(name,'true')` 跑 `off` ⇒ `console.warn` 收到 WARN、message **逐字**等于 §5.4-3 那段、context 等于 `{variable, effort:'off'}`、`recorder.env.CLAUDE_CODE_EXTRA_BODY` **仍逐字注入**、本行照常跑完；`vi.stubEnv(name, undefined)` ⇒ **不出现** | Task 3 Step 1 的第 2–5 条 + 文案模板逐字那条 |

- [ ] **Step 3: 逐条核对 spec §4.2 的 11 个变异体**

对着 spec §4.2 的表逐行核对「这个变异体**真的见过失败**」，把「变异体 → 红的用例 → 还原后哈希未变」记进实现报告。缺一条就现场做一次（造缺陷 ⇒ 跑该文件 ⇒ 确认红 ⇒ 还原 ⇒ 核对哈希）：

| 变异体 | 应红的守卫 | 本计划里的落点 |
|---|---|---|
| ① 手写常量 `'{thinking:{type:disabled}}'` | 守卫 1 | Task 1 Step 5 ① |
| ② `KEY: off ? VALUE : undefined`（**须配合宿主设过该变量**） | 「宿主设过同名变量时，非 off 档**与未选**都把它原样留给子进程」（Task 1 Step 1 第 6 条，两臂都跑、用例自带 `vi.stubEnv(…, 'host-value')`）。**T1 实现者实测修正**：断「键不存在」（`Object.hasOwn === false`）的那条**不红** —— `route.ts:94-96` 的删键语义恰好也让它为 `false` ⇒ 别把那条记成红 | Task 1 Step 5 ② |
| ③ 无条件注入 | 守卫 2 / 3（第 3、4、5、6 条） | Task 1 Step 5 ③ |
| ④ 键名写错 `CLAUDE_CODE_EXTRA_BODIES` | 「注入的值是合法 JSON…」那条里追加的**字面量** `Object.keys` 判据（Task 1 Step 1 第 2 条的末句）。**T1 实现者实测修正**：经**共享常量**读键的断言**都不红**（实现与判据一起错 ⇒ 唯一有区分力的是字面量） | Task 1 Step 5 ④ |
| ⑤ codex `off` 时不传 `'none'` | 守卫 5 | Task 2 Step 5 ⑤ |
| ⑥ `buildCodexConfig` 无条件带 `summary: 'auto'` | 守卫 6 / 7 | Task 2 Step 5 ⑥ |
| ⑦ 键名写成 `model_reasoning_summaries` | 守卫 5 / 8 | Task 2 Step 5 ⑦ |
| ⑧ 显式 `model_reasoning_summary: undefined` | 守卫 6 / 7 | Task 2 Step 5 ⑧ |
| ⑨ WARN 判据改成**大小写敏感**的精确键 | 守卫 9a（小写拼写那一例） | Task 3 Step 5 ⑨ |
| ⑩ WARN 判据改成**真值判断**（`=== '1'`）**或**删掉 `off` 门 | 守卫 9a / 9b | Task 3 Step 5 ⑩（两条子变异） |
| ⑪ 把 WARN 做成**拦截**（抛错 / 出现 WARN 时不再注入） | 守卫 9b（「仍逐字注入」那半） | Task 3 Step 5 ⑪（两条子变异） |

- [ ] **Step 4: 确认「零改动」的两处事实**

Run: `git diff --stat HEAD -- packages/server/contracts packages/server/evaluator packages/server/api packages/client`

> ⚠️ **基线用运行时的 `HEAD`，不要写死一个更早的提交号**：本仓是共享分支，别人的提交会一起进 diff。
> 实测：`08bd269..HEAD` 里就有另一条线的 `6dc9f8a`（evaluator 终态耗时冻结）动了
> `packages/server/evaluator`，拿它当基线一跑就是 `2 files changed, +132/-8` —— 「空输出」当场假红，
> 而那不是本次的错，只会把实现者引去查一个并不存在的越界。

Expected: **空输出**（这四个目录里没有本次**未提交**的改动；若列出文件，先按 `git log -1 -- <路径>` 归因是不是别人的在途改动，同 Step 1 的 typecheck 口径）。

`HEAD` 那一条断不了「**已经提交**的改动」，所以再补一条只看本线提交的核对：

Run: `git log --oneline <Task 1 的提交>^..HEAD --name-only -- packages/server/contracts packages/server/evaluator packages/server/api packages/client`

Expected: **空输出**（本线的提交一个都没碰这四个目录）；列出来的若是别人的提交，逐条归因、不算本次的红。

再确认 `packages/server/agents/src/providers/claude-code/index.ts:215-216`（`effort` / `thinking` 两格）与
`packages/server/agents/src/providers/codex/index.ts:119`（`modelReasoningEffort`）**没有被改**：

> ⚠️ claude 那两格的行号是**Task 1 落地之前**的提交态；Task 1 / Task 3 都在它们**之前**插了行
> ⇒ 这一步按**内容**定位（`...(input.effort === … ? {} : { effort: input.effort })` 与紧邻其后的
> `...(input.effort === CLAUDE_OFF_EFFORT ? { thinking: { type: 'disabled' } } : {})`），别按旧行号找。

Run: `git diff 7a8bf89 -- packages/server/agents/src/providers/codex/index.ts`

Expected: 差异只有 `:63` 附近新增的常量与 `:105-106` 的调用点，`:119` 不在差异里。

---

### Task 5: 真机复验（独立任务：同一 run 里两家各一行 `off` + 各一行「未选」对照）

**Files:**
- Create（**临时件，不入 repo**）：`$env:TEMP\off-verify\count-thinking.mjs`、`$env:TEMP\off-verify\count-reasoning.mjs`
- Create: `docs/superpowers/notes/2026-10-06-effort-off-really-disables-thinking-smoke.md`（冒烟记录，**本 Task 唯一进仓的文件**）

**Interfaces:**
- Consumes: Task 1–4 已完成并提交；`workspaceRoot`（本机协议默认 `~/.runs`，本机真机实测配置是 `D:\.tmp\aieval\runs`，见 `contracts/src/settings.ts:45`）；已跑着的 web（`http://localhost:3083`）。
- Produces: 三条判据（A / B / C）的读数与结论。

**为什么必须真机、且必须与「未选」对照行同读**：单测证明「我们注入了什么」，真机证明「它生效了」；而「0 个思考块」这个读数**在整条链路坏掉时也会得到**（思考读数没采到、CLI 根本没跑起来、模型被换掉）⇒ 判据 C（对照行必须 > 0）是 A / B 的**前提**，缺了它 A / B 是自证（spec §4.3 判据 C）。

**跑几次（写死，不许「多跑几次试试」）**：

- **跑 1 次**（一个 run、4 行、`executionMode: 'serial'`）。
- 只有在**判据 C 不成立**（对照行没有思考）时才允许**补跑 1 次**，且补跑前必须先查清 C 为什么不成立（那是链路问题，不是本改动的问题）；**最多补跑 1 次**，仍不成立就按「无法判读」如实登记，不得继续重跑。
- 判据 A / B 红（`off` 行仍有思考）时**不补跑**：那就是这次改动没生效，直接走下面的归因流程。

- [ ] **Step 1: 前置核对（缺了这一条，整次复验就是自证）**

在**将要跑评测的那个 shell** 里执行：

```powershell
Get-ChildItem Env:CLAUDE_CODE_* | Select-Object Name, Value
```

Expected: **两条都必须不出现**：`CLAUDE_CODE_EXTRA_BODY` 与 `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS`（Task 3 的 WARN 已经说明后者会毁掉修复）。

⚠️ **`CLAUDE_CODE_EXTRA_BODY` 这一条比看上去更重**（**T1 门审登记**，spec §4.3 前置段 / §5.3 第三条）：
它一旦在场，被静默关掉思考的不是 `off` 那一行，而是**所有 claude 行** —— 含 `max` / 未选的**对照行**。
本线按硬约束**刻意保留**宿主继承值（spec §5.4 第 2 条；Task 1 那条「宿主设过 ⇒ 非 off 档原样留着」的
哨兵用例钉的正是这一点）⇒ 对照行也会读到 0，**判据 C 直接不成立**，于是 A / B 也失去对照、整轮读数
无从判读（真机 A/B 的 B 臂就是靠宿主设它做到：零代码改动）。⇒ 它**没有**日志自证（本线刻意不为它加
WARN，避免扩范围）—— 只能靠这里的手工核对，别指望下面 Step 5 的日志能发现它。

这条前置在**实现之后会自证**（spec §4.3）：若宿主设过 `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS`，claude 的 `off` 档那一行会带 Task 3 的那条 WARN ⇒ **那次真机读数作废**。
⚠️ **T5 实测修正**：那条 WARN 走 `logger.warn` ⇒ 落在**跑评测那个 dev server 的控制台**上（谁起的服务就看谁的输出），**不在**该行的 `events.jsonl` 里 —— 该文件的事件类型只有 `log/usage/status/score/end/vendor-system/diff-summary`，**没有 warn 通道**。⇒ 下面 Step 5 要读的是**服务进程的控制台输出**；对着行的 `events.jsonl` 去 `grep` **恒为 0 命中**（本轮实测：那条 WARN 的文案在控制台里，行文件里查不到），**0 命中不构成「前置干净」的证据**。前置是否干净只能靠 Step 1 的人工核对判定（本轮实测加做了**直接读服务进程的环境块**，见冒烟记录 §3.1(b)）。

不满足就先把它们清掉再继续：

```powershell
Remove-Item Env:CLAUDE_CODE_EXTRA_BODY -ErrorAction SilentlyContinue
Remove-Item Env:CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS -ErrorAction SilentlyContinue
```

- [ ] **Step 2: 起 run（4 行）**

先拿用例 id（若沿用既有用例「简单测试」可跳过）：

```powershell
(Invoke-RestMethod 'http://localhost:3083/api/cases').cases | Select-Object id, name, repoPath
```

再建 run 并启动（**4 行**：claude / codex 各一行 `off` + 各一行「未选」；`rows[].effort` 只在这两行上写 `"off"`，对照行**不写这个键**）：

```powershell
$body = @{
  caseId        = '<上一步拿到的 caseId>'
  executionMode = 'serial'
  useAgentJudge = $false
  rows = @(
    @{ agentKind = 'claude-code'; providerId = '<anthropic 供应商 id>'; modelId = '<claude 那行的模型 id>'; effort = 'off' },
    @{ agentKind = 'claude-code'; providerId = '<anthropic 供应商 id>'; modelId = '<claude 那行的模型 id>' },
    @{ agentKind = 'codex';       providerId = '<openai 供应商 id>';   modelId = '<codex 那行的模型 id>';  effort = 'off' },
    @{ agentKind = 'codex';       providerId = '<openai 供应商 id>';   modelId = '<codex 那行的模型 id>' }
  )
} | ConvertTo-Json -Depth 6
$run = Invoke-RestMethod -Method Post -Uri 'http://localhost:3083/api/runs' -ContentType 'application/json' -Body $body
$runId = $run.id
Invoke-RestMethod -Method Post -Uri "http://localhost:3083/api/runs/$runId/start" | Out-Null
$runId
```

供应商与模型 id 从 `http://localhost:3083/api/runs/model-options` 读（上一轮冒烟记录 §3.2 的读法；`effortLabel` 是「`off`（要求不思考）」那一条即关闭档）。

- [ ] **Step 3: 等到 `done`（每 20s 轮询）**

```powershell
do { Start-Sleep -Seconds 20; $r = Invoke-RestMethod "http://localhost:3083/api/runs/$runId" } while ($r.status -notin @('done','failed'))
$r.status; $r.rows | Select-Object id, agentKind, effort, status, tokens, turns, durationMs
```

参考：上一次 6 行的 run 约 26 分钟；本 Task 4 行，**先按 40 分钟预算**（超时不算失败，只是还没跑完）。
失败时怎么判读：`status='failed'` 或某行 `status='error'` ⇒ 先读该行 `attempts.jsonl` 与 `events.jsonl` 里的 error 事件，按「是链路问题（认证 / 网关 / 超时）还是本改动的问题」分类；**不许**把它当成判据 A / B 的红或绿。

- [ ] **Step 4: 写两个读数脚本（临时件，放 `%TEMP%`，不入 repo）**

```powershell
$probeDir = Join-Path $env:TEMP 'off-verify'
New-Item -ItemType Directory -Force -Path $probeDir | Out-Null
$probeDir
```

`$probeDir\count-thinking.mjs`（claude / dsh 的思考块计数）：

```js
/**
 * 统计一行的 messages.jsonl 里「含 thinking 块」的逻辑消息条数，并按主线程 / 子智能体拆开。
 *
 * 三条口径（与 `core/src/message-log.ts` 的 `foldMessages` 逐字一致）：
 *   ① 一行一条**信封记录**：`{type:'message', message:{…}}` 或 `{type:'subagent', subagent:{…}}`
 *      ——**消息在 `record.message` 里**，不是记录本身；
 *   ② 按 `message.mergeKey` **覆盖累积**（同一条逻辑消息会以多行落盘，后到的 `blocks` 已是全量，
 *      不折叠会重复计数）；
 *   ③ 主线程 / 子智能体按 `message.subagentId` 拆（`null` = 主线程）。
 * 用法：node count-thinking.mjs <rowDir>
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const rowDir = process.argv[2];
const file = join(rowDir, 'messages.jsonl');
if (!existsSync(file)) {
  console.log(JSON.stringify({ rowDir, error: 'messages.jsonl 不存在' }));
  process.exit(0);
}
// 容忍 UTF-8 BOM（外部工具编辑过的文件首行会带 U+FEFF，JSON.parse 直接抛）
const text = readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
const latest = new Map();
for (const line of text.split('\n')) {
  if (line.trim() === '') continue;
  let record;
  try { record = JSON.parse(line); } catch { continue; }
  if (record.type !== 'message' || record.message === undefined) continue;
  latest.set(record.message.mergeKey, record.message); // 后到覆盖先到（blocks 已是全量）
}
let main = 0;
let sub = 0;
for (const message of latest.values()) {
  if (!message.blocks.some((block) => block?.type === 'thinking')) continue;
  if (message.subagentId === null) main += 1;
  else sub += 1;
}
console.log(JSON.stringify({ rowDir, logicalMessages: latest.size, thinkingMain: main, thinkingSubagent: sub }));
```

`$probeDir\count-reasoning.mjs`（codex 的 rollout 计数）：

```js
/**
 * 递归数一个 codex 行的 `.agenthome/sessions/**/rollout-*.jsonl` 里的 reasoning 条目数，
 * 并打印每个 rollout 的 turn_context 里 settings 的 effort / summary 两格。
 *
 * ⚠️ 键路径是 `payload.collaboration_mode.settings.reasoning_effort`（**对的**）；
 * 少一层的 `payload.reasoning_effort` 是**错路径**（本仓踩过一次）。
 * 用法：node count-reasoning.mjs <rowDir>
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const rowDir = process.argv[2];
const root = join(rowDir, '.agenthome', 'sessions');
if (!existsSync(root)) {
  console.log(JSON.stringify({ rowDir, error: 'sessions 目录不存在' }));
  process.exit(0);
}
const walk = (dir, out = []) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else if (entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) out.push(path);
  }
  return out;
};
const files = walk(root);
const perFile = [];
let total = 0;
for (const file of files) {
  let reasoning = 0;
  const contexts = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    const payload = record.payload ?? null;
    // 类型在两处都可能：外层 `type` 或内层 `payload.type`（transcript.ts 的判据）
    if (record.type === 'reasoning' || payload?.type === 'reasoning') reasoning += 1;
    if (payload?.type === 'turn_context') contexts.push(payload.collaboration_mode?.settings ?? null);
  }
  total += reasoning;
  perFile.push({ file, reasoning, contexts });
}
console.log(JSON.stringify({ rowDir, rollouts: files.length, reasoningTotal: total, perFile }, null, 2));
```

- [ ] **Step 5: 逐行读数（判据 A / B / C）**

```powershell
$r = Invoke-RestMethod "http://localhost:3083/api/runs/$runId"
$root = $r.workspaceRoot   # 若接口不回这一格，用本机真机的值：D:\.tmp\aieval\runs
foreach ($row in $r.rows) {
  $rowDir = Join-Path (Join-Path (Join-Path $root $runId) 'rows') $row.id
  "[$($row.agentKind) / effort=$($row.effort)] $rowDir"
  if ($row.agentKind -eq 'codex') { node "$env:TEMP\off-verify\count-reasoning.mjs" $rowDir | Select-String 'reasoningTotal' }
  else { node "$env:TEMP\off-verify\count-thinking.mjs" $rowDir }
}
```

**期望值（逐条写死）**：

| 判据 | 行 | 读哪个文件的哪个字段 | 期望 |
|---|---|---|---|
| **A** | claude / `off` | `<rowDir>\messages.jsonl` → 按 `mergeKey` 折叠后含 `{"type":"thinking"}` 块的消息数 | **`thinkingMain === 0` 且 `thinkingSubagent === 0`**（两列都要 0；上一轮真机是 1 + 1） |
| **B** | codex / `off` | `<rowDir>\.agenthome\sessions\**\rollout-*.jsonl` 的 `reasoningTotal`（主 + 子 rollout 都数） | **`reasoningTotal === 0`**（上一轮真机是 3 + 10 = 13） |
| **C** | claude / 未选 **与** codex / 未选 | 同上两列 | **claude `thinkingMain > 0` 且 codex `reasoningTotal > 0`**（上一轮真机是 1 与 6+1） |

**判读的坑（照抄前车之鉴，spec §4.3 末条）**：

- claude 侧**不要**在 body / 日志文本里**子串搜** `thinking`：真机上一次命中 4 次，全是无关命中（探测目录名 ×3 + system prompt 里的 "visible thinking" ×1）⇒ 判据必须是**解析后的块类型**；
- CLI 的 `--output-format json` 自述的 `thinking_tokens` **没有区分力**（A/B 两次都报 0），不能当判据；
- codex 的 `turn_context` 只读 `payload.collaboration_mode.settings.reasoning_effort` / `.reasoning_summary`；`payload.reasoning_effort` 是**错路径**（本仓踩过一次）。

**失败时怎么判读（顺序固定，不许跳到重跑）**：

- **A 红 / B 红（`off` 行仍有思考）且 C 绿** ⇒ 本次改动没生效。走二级归因器（spec §5.2 第 2 条）：抓 CLI 出网请求体，
  · claude：看**解析后的顶层键**里有没有 `thinking` —— 没有 ⇒ `CLAUDE_CODE_EXTRA_BODY` 覆盖层失效（CLI 侧又变了）；有 `thinking` 却仍思考 ⇒ 网关侧变了，**必须重查，不得沿用本设计**；
  · codex：看 `reasoning` 里还有没有 `summary`（`include` 仍在是**预期**）—— `summary` 没消失 ⇒ 我们这一格没到 CLI（键被改名 / 被忽略）；`summary` 消失了却仍有 reasoning ⇒ 网关侧的组合行为变了。
- **C 红（对照行没有思考）** ⇒ 这一轮**无法判读** A / B（「0」没有对照）。先查链路（认证 / 网关 / 模型名 / 事件是否采到），再决定是否补跑那 1 次。
- **读到 `off` 行有思考、但 WARN 里出现了 `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS`** ⇒ 前置被破坏（Step 1 没清干净或服务进程另有一份环境），清理后重跑**属于 Step 1 的返工**，不计入「补跑 1 次」。

- [ ] **Step 6: 登记未验项（不得据此改写判据）**

真机复验时**一并记下**这两格；读到非 0 时按「未覆盖边界」登记，**不许**把它当成判据 A / B 的红或绿（spec §4.3 未验项 / §6）：

① claude 的 `CLAUDE_CODE_EXTRA_BODY` 是否对**子智能体**生效（真机 A/B 是单轮 33 字节 prompt、**没有子智能体**；本轮若派了子智能体就有读数，读到了就记下，没读到就写「未覆盖」）；
② codex **子线程**的 `summary` 取值（stepF 是单轮、未派子智能体；子线程的 `effort` 有正面证据，`summary` 没有）。

同一份记录里还要登记（照实，不修饰）：③ claude 的 hipaa 策略位我们不可观测（只能从「0 思考块」反推）；④ 备选开关 `CLAUDE_CODE_MODEL_CAPABILITIES='<model>=-rejects_disabled_thinking'` **未真机验**，本设计不采用。

- [ ] **Step 7: 写冒烟记录并提交**

按本仓口径写四要素（① 范围清单逐项 ✅/❌/跳过+理由；② 操作路径；③ 证据（浏览器/接口状态 + CLI 读数互证）；④ 未覆盖项与后续计划），落到：

`docs/superpowers/notes/2026-10-06-effort-off-really-disables-thinking-smoke.md`

内容至少含：前置核对的输出、`$runId`、四行的（`agentKind` / `effort` / `thinkingMain` / `thinkingSubagent` / `reasoningTotal` / `tokens` / `turns` / `durationMs`）、判据 A / B / C 的逐条结论、Step 6 的四条未验项。

```bash
git add docs/superpowers/notes/2026-10-06-effort-off-really-disables-thinking-smoke.md
git commit -m "docs(notes): off 真关闭的真机复验（claude 0 思考块 / codex 0 条 reasoning + 未选对照）"
```

---

> **前作 spec 的四处改写由控制者在实现完成后落，不属于本 plan 的任务序列。**
> 目标措辞只登记在 spec `§5.5`（那里有一条 blockquote 明写「实现者不要替前作改字」）：前作
> `docs/superpowers/specs/2026-10-06-effort-default-and-explicit-off-design.md` 的 `:66-69` / `:136-144` / `:152` /
> `:193-195` 四处要改成「已修 + 依赖哪个开关 + 前置条件」，而实现与真机复验完成前落笔只会写成
> 「计划要修」⇒ **执行者不要碰那个文件**（它不是本线的改动面，`git status` 里不要出现它）。

---

## 附：Task 边界与依赖

```text
Task 1 (claude 注入) ──┐
                       ├─→ Task 4 (门禁 + 变异矩阵核对)
Task 2 (codex summary) ┤
                       │
Task 3 (WARN 加固) ────┘
                              └─→ Task 5 (真机复验)
```

- **文件重叠与顺序**：Task 1 与 Task 3 都改 `claude-code/index.ts` 与它的测试 ⇒ **必须按 1 → 3 顺序执行**（3 依赖 1 已导出 `claudeExtraEnvFor` / `CLAUDE_CODE_EXTRA_BODY`）；Task 2 只碰 `providers/codex/*`，与 Task 1 / 3 **无文件重叠**，可并行或任意顺序。三者各自可独立评审。
- Task 4 是**只读的核对任务**（无提交）；它的变异矩阵引用的是 Task 1 / 2 / 3 各自已经做过的那些变异，漏做的在这里补。
- Task 5 是本线唯一花钱花时间的 Task（4 行、预算 40 分钟）。
- **前作 spec 不在本 plan 的任务序列里**（见 Task 5 之后那一段说明：由控制者实现完成后落笔）。
