# 功能阶段 p3 实施计划：agents（注册表 + 三家适配器）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把「一个智能体」这件事在 `packages/server/agents` 里落地：一个显式静态注册的 provider 注册表（元数据是协议兼容性 / 终止能力 / 隔离级别的唯一查询点），三家厂商 SDK（Claude Code / Codex / DSH）的薄适配器（注入路由 → 消费事件流 → 归一化成 `AgentEvent` → 按固定顺序释放），以及一次**真实事件探测**把计量字段名钉死。

**Architecture:** 包内三层、依赖单向：`registry.ts`（kind → provider，元数据唯一来源）→ `providers/<kind>/`（每家一个目录：`sdk.ts` 懒加载外壳 + `events.ts` 事件投影 + `index.ts` provider 实现）→ 厂商 SDK。三家的运行骨架（超时两段、释放顺序、判定优先级、结果组装）集中在 `turn.ts` 一份，厂商差异只通过 `start()` 注入；`runtime.ts` 的 `sdkModule` 是唯一的测试注入点（一个「包名 → 模块」的表同时喂饱三家）；`load-once.ts` 保证厂商包只在函数作用域里动态加载、只缓存成功的加载，于是「一家 SDK 故障」不会放大成「整包不可用」。对外只暴露 `getProvider` / `listAgentProviders` 与类型，`providers/*` 与内部工具一律不外露。

**Tech Stack:** TypeScript 5（`strict` + `noUncheckedIndexedAccess` + `verbatimModuleSyntax`）· vitest 4（node 环境，纯函数与假 SDK）· Node 24（探测脚本直接用 node 跑 TS）· pnpm 11 workspaces · 厂商包 `@anthropic-ai/claude-agent-sdk` / `@openai/codex-sdk` / `@deepseek-ai/dsh-sdk-client`（只作运行时依赖）

**Spec:** `docs/superpowers/specs/2026-09-22-features-design.md` §5.6（5.6.1 决策表 A1–A8 / 5.6.2 契约 / 5.6.3 事件归一化与计量 / 5.6.4 路由注入 / 5.6.5 生命周期与释放 / 5.6.6 加载降级与错误码 / 5.6.7 测试口径）· §7.4（`AgentEvent` 形状）· §9（适配器测试行）· §11 第 5 步（先做真实事件探测）· §12

**Interfaces source:** `docs/superpowers/notes/2026-09-22-features-plan-interfaces.md`（§2 契约出口、§4 适配器出口清单、§1 通用口径、§11 实现层修正）

## Global Constraints

- 包名 `@aieval/*`；`agents` **只依赖** `core` / `contracts`（外加 Node 内置与三家厂商包），**不依赖 `evaluator`**；跨包只走包名，禁跨包相对引用（`eslint.shared.ts` 的 `withBoundary('agents')` 硬约束，含动态 `import()` 与 `require()`）。
- 源码一律 ESM（禁 `require`）；`verbatimModuleSyntax` 开着，类型必须 `import type`。
- 包内出口清单（契约 §4）里的名字与签名**逐字实现、不得改名、不得改窄**：`AgentKind`（再导出）/ `AGENT_KINDS`（再导出）/ `ProtocolType` / `AgentExitReason` / `AgentErrorCode` / `AgentRunInput` / `AgentRunResult` / `AgentProviderMetadata` / `AgentProvider` / `AgentRuntime` / `setAgentRuntimeForTesting` / `getAgentRuntime` / `getProvider` / `listAgentProviders` / `createSdkLoader`。
- **单测一律不碰真实 API、不碰真实 CLI**：厂商 SDK 只通过 `setAgentRuntimeForTesting({ sdkModule })` 注入假模块；唯一会碰真实的探测脚本放在 `probe/`（不在 `src/`，不进 `pnpm test`），由人显式运行。
- **测试注入点只有 `sdkModule` 一个字段**（§5.6.6）：形状是「包名 → 模块命名空间」的表，三家共用一个伪造结构，不另起名字、不加第二个注入字段。
- `process.env` **只读不写**：源码里不得出现 `process.env.X = …`、`process.env[…]`、`Object.assign(process.env, …)`（`src/static-assertions.test.ts` 扫源码断言，§5.6.4 不变量 2）。
- 厂商包**只允许动态 `import()`**（函数作用域懒加载，A6）；不得顶层静态导入，不得 `import type` 厂商包（`src/vendor-shims.d.ts` + 静态断言 + 各 `sdk.ts` 内自声明窄结构，§5.6.2 末段）。
- 注册表**显式静态注册，不做目录扫描**（A3）；不得在包内出现 `readdir` / `readdirSync`（静态断言）。
- 注入一律**返回新对象**，输入的 `route` 只读；子进程环境是「替换型」：展开宿主环境补 `PATH`、`HOME` / `USERPROFILE` 指向该行 `configHome`（§5.6.4 不变量 1/3）。
- **每次运行的释放顺序固定**：`interrupt()` → 终结在途 turn → `dispose()`，不可颠倒；`dispose` 幂等；关闭守卫按**对象**绑定（`createDisposer`），不做运行时级一次性闭锁（A7 / §5.6.5）。
- 超时两段：`interrupt()` 后等 **5 秒**（`RELEASE_GRACE_MS = 5_000`），超限落 WARN 到事件日志 + WARN 日志，再强制 `dispose()`（§5.6.5 表）。
- 判定优先级固定：`signal` 已中止 → `canceled`；自身超时 → `timed-out`；其余按实际结果。**`signal` 不得用来推断 `exitReason`**（§5.6.5）。
- **计量采不到一律 `null`，绝不填 0**；只有 `tokens` 与 `turns` 同时在时才发 `usage` 事件（§5.6.3 / §7.4）。
- **未识别事件不得静默丢弃**：一律投影成保留原始负载的日志事件（`{ type: 'log', stream: 'stdout', text: <原始 JSON> }`）；唯一允许丢弃的是重复事件（§5.6.3）。
- `AgentErrorCode` 不进 `contracts` 的 `ERROR_CODES`（§5.6.6 末段）；用户可见文案必须中文，`AUTH_FAILED` 带 host 并指向设置页，`RATE_LIMITED` 提示改用串行，`AGENT_LOAD_FAILED` 点名包名与安装方式。
- 注释 JSDoc 中文，先说「做什么」再说「怎么做」；文件头写职责 + 注意事项；关键分支写「为什么」。
- 日志走 `@aieval/core` 的 `createLogger('agents/<kind>')`，上下文作为第二参数透传，不 `JSON.stringify`。
- 时间字段一律 ISO 8601 带时区（`new Date().toISOString()`）。
- 每个任务结束时 `pnpm --filter @aieval/agents typecheck` 与 `pnpm typecheck` 零错误；收尾任务跑 `pnpm lint` 与 `pnpm test`。
- 真实可跑的命令只有这四条：`pnpm --filter @aieval/agents test`、`pnpm --filter @aieval/agents typecheck`、`pnpm typecheck`、`pnpm lint`。
- 纯函数测试文件首行标 `// @vitest-environment node`。
- **提交用逐个显式 `git add <路径>`，禁 `git add -A`**；提交信息中文，形如 `feat(agents): …`。
- **每条新增的回归守卫都必须做变异验证**：把要拦的缺陷人为制造回去（改实现、不改测试）→ 确认守卫**失败** → 还原 → `Get-FileHash` 核对哈希与变异前一致。**没有见过失败的守卫不算守卫**；报告里要贴出变异体的失败输出与还原后的哈希。

## 本计划对 spec 的实现层修正

以下九条要么是 spec 未明说、要么是需要显式引用的实现口径。**与契约 §4 的签名冲突为零**（名字与签名一律照抄），都是行为层与文件层的决定：

1. **`AGENT_KINDS` / `AgentKind` 的真源在 `contracts`（`run.ts`），`agents` 只再导出**（契约 §11 R1）：contracts 不能反向依赖 agents，而 `EvalRow.agentKind` 与前端下拉必须与注册表同源。本计划**不重复声明**这两个名字，`AGENT_KINDS` 由 `types.ts` 从 `@aieval/contracts` 导入后再导出。
2. **适配器只发三类事件：`log` / `usage` / `error`。** `status` / `diff-summary` / `score` / `end` 由编排层（p4）发——状态机、diff 统计、评分与收尾都不是适配器能知道的事；两边都发会让「同一件事有两个来源」互相覆盖。
3. **事件里的 `seq` 是 run 内自增序号（从 1 开始），`at` 由适配器自己生成。** 理由：`onEvent` 的签名被 spec §5.6.2 钉死为 `(e: AgentEvent) => void`，而 `AgentEvent` 的 `seq` / `at` 是必填字段——不改签名就只能由适配器先给一个本地序号；落盘时的最终 `seq` 由 `core` 的 `appendEvent` 按文件已有最大 seq 重新分配（契约 §3.4），适配器这一层的 seq 不参与持久化语义。
4. **`run()` 永不抛异常**：所有失败都折进 `AgentRunResult.error`（`ok: false` + `exitReason`）。理由：§5.6.6 的错误码需要一个承载处，而抛出去的错误会被编排层当成「编排层自己的 bug」；`runTurn` 的 `finally` 里也保证了「无论如何都释放」。
5. **厂商类型面隔离用 `src/vendor-shims.d.ts`**：三个厂商包声明为裸模块（`declare module '@x'`），各家 `sdk.ts` 内自声明窄结构并 `as unknown as <窄结构>`。于是「厂商包有没有装」「厂商类型有没有破坏性变更」都不会让本仓 `typecheck` 失败——它们只会在运行时被 §5.6.6 的加载降级兜住（若厂商自带类型且 TS 优先采用它，本计划同样成立：我们从不消费厂商类型）。
6. **5 秒常量落在 `src/release.ts` 的 `RELEASE_GRACE_MS = 5_000`**（§5.6.5 表第一段）；`releaseTurn` 额外接受一个**仅供测试**的 `graceMs` 覆盖参数——它不改任何跨计划可见签名，只让「第二段兜底」能在毫秒级被验证。
7. **dsh 的 `usage` 元数据在探测前取保守值 `false`**，`projectDshNotification` 一律返回 `tokens: null`；探测（§11 第 5 步）之后按实测回写这一格与提取逻辑（§5.6.3 明写「不能假设它存在」「探不到就标 `usage: false`」）。两种探测结果都已被本计划覆盖。
8. **三家厂商包加入 `apps/web-next/next.config.ts` 的 `serverExternalPackages`**：`@aieval/agents` 在 `transpilePackages` 里，其动态 `import()` 会被 webpack 一并打包；而这三个包是**运行时依赖**（它们要定位自身的 CLI / 原生二进制），打进 server bundle 会让定位失效。这是 §5.6.2「厂商包只作为运行时依赖」在打包层的落地。
9. **p4 如果要伪造适配器，请 `vi.mock('@aieval/agents')`，不要伸进包内部**：`index.ts` 按契约 §4 只导出 registry + types，`runtime.ts` 与 `providers/*` 不外露（包 `exports` 也只映射 `.`）。这是契约的直接后果，不是遗漏；本计划不为此加第二个出口。

## Review Focus

以下五类输入/条件 spec 没有明说，但坏了会直接伤到使用者。每条都钉在拥有该代码的任务的测试步骤里：

1. **`route.baseUrl` 的形态是用户从设置页粘贴进来的**——带尾斜杠、带或不带 `/v1` 后缀（例：`https://gw/anthropic/`、`https://gw/openai/v1`、`https://gw/deepseek/v1/`）。三家对 `/v1` 的要求**方向相反**（claude 拆、codex 补、dsh 留），写错的表现是 404 或「明明配了网关却打到别处」。→ Task 3 的 `/v1` 表驱动用例（尾斜杠 × `/v1` 后缀各一例）+ Task 7/8/9 的注入参数用例。
2. **同一个进程里并行跑两行、两家不同供应商**——靠 `process.env` 兜底注入的实现在第二行起就再也拿不到自己的凭据（写入是粘性的）。→ Task 3 的 `buildSubprocessEnv` 正反两面用例 + Task 7 的「子进程拿到了 / 宿主 `process.env` 没被改」用例 + Task 3/5/10 的三条静态断言（Review Focus #2）。
3. **适配器不响应停止信号或卡死在网络等待上**（dsh 的 `cancelMidTurn: false` 是设计如此，CLI 挂死则不是）——若释放没有第二段兜底，该行会永远停在 `running`、子进程变成孤儿。→ Task 4 的 `releaseTurn` 用例 + Task 6 的「忽略 `interrupt` → 5 秒 → WARN → 强制释放」用例 + Task 9 的 dsh 终止用例。
4. **厂商包没装 / 装坏了 / 换了镜像拉不到**——顶层静态导入会把「一家故障」放大成「整包不可导入」，一次镜像抖动会毒化长驻服务的后续所有行。→ Task 5 的「懒加载只缓存成功 / 注入不缓存 / 失败后可重试成功」用例 + Task 7/8/9 各自的加载失败用例 + Task 5 的「厂商包不得静态导入」断言。
5. **厂商事件与计量形态和预期不符**（SDK 升级新增消息类型、网关不回 usage、usage 缺字段）——静默丢弃事件等于丢掉「为什么得这个分」的证据；把「没采到」显示成 `0` 会让人得出「这家很省」的错误结论。→ Task 7/8/9 的「未识别事件保留原始负载」用例与「计量缺失得 `null` 而非 `0`」用例（含三条必做的变异验证）。

---

## 文件结构总览

```
packages/server/agents/
├── package.json                       # 改：dependencies 补三家厂商包（版本由 pnpm add 写入，不预先猜）
├── tsconfig.json  eslint.config.ts    # 不改（include: ["src"]；withBoundary('agents')）
├── vitest.config.ts                   # 不改（复用 ../../../vitest.node；只收 src/**/*.test.ts）
├── probe/
│   ├── raw-events.mts                 # 新增：真实事件探测脚本（node 直接跑 TS，人工执行，不在测试范围）
│   └── dumps/                         # 新增（gitignore）：<kind>.json，原始事件流 + 注入对象原文
└── src/
    ├── index.ts                       # 改：只导出 registry + types
    ├── types.ts                       # 新增：§5.6.2 的全部对外类型（AgentKind 再导出）
    ├── runtime.ts                     # 新增：AgentRuntime + setAgentRuntimeForTesting / getAgentRuntime
    ├── registry.ts                    # 新增：getProvider / listAgentProviders（显式静态注册）
    ├── load-once.ts                   # 新增：createSdkLoader（只缓存成功的加载）
    ├── json.ts                        # 新增：unknown 负载的窄读取（asRecord / readString / readNumber）
    ├── emit.ts                        # 新增：事件发射（补 seq/at）+ 未识别负载投影 + safeStringify
    ├── route.ts                       # 新增：base URL 规范化 + 替换型子进程环境
    ├── errors.ts                      # 新增：AgentLoadError + classifyAgentFailure / classifyAgentMessage
    ├── release.ts                     # 新增：RELEASE_GRACE_MS / releaseTurn / createDisposer
    ├── turn.ts                        # 新增：三家共用的运行骨架 runTurn
    ├── vendor-shims.d.ts              # 新增：三家厂商包的裸模块声明
    ├── static-assertions.test.ts      # 新增：源码级不变量（env 写入 / 静态导入厂商包 / 目录扫描）
    ├── testing/agent-fixtures.ts      # 新增：假厂商 SDK + 记录器 + createRunInput + 假定时器推进
    └── providers/
        ├── claude-code/{sdk.ts,events.ts,index.ts,events.test.ts,index.test.ts}
        ├── codex/{sdk.ts,events.ts,index.ts,events.test.ts,index.test.ts}
        └── dsh/{sdk.ts,events.ts,index.ts,events.test.ts,index.test.ts}
```

配套改动（都在本计划范围内，逐条在对应任务里给完整代码）：

- `pnpm-workspace.yaml`：**只有** pnpm 在装包时明确要求时才追加 `allowBuilds` 条目（以它的构建脚本提示为准，不预先猜）。
- `.gitignore`（根）：追加一行 `packages/server/agents/probe/dumps/`（dump 里可能带网关返回的敏感原文，不入库）。
- `apps/web-next/next.config.ts`：补 `serverExternalPackages`（见「实现层修正」第 8 条）。
- `docs/superpowers/notes/2026-09-22-features-p3-agent-probe.md`：探测报告（提交），三家字段名结论与 §5.6.3 表的差异。

---

## Task 1: 对外类型契约与运行时注入点

**Files:**
- Create: `packages/server/agents/src/types.ts`
- Create: `packages/server/agents/src/runtime.ts`
- Create: `packages/server/agents/src/vendor-shims.d.ts`
- Create: `packages/server/agents/src/runtime.test.ts`
- Create: `packages/server/agents/src/contracts-alignment.test.ts`

**Interfaces:**
- Consumes: `@aieval/contracts` 的 `AGENT_KINDS` / `AgentKind` / `AgentEvent`（契约 §2.4 / §2.6）、`ProtocolType`（契约 §2.2）
- Produces:
  - `type AgentKind`（再导出）、`const AGENT_KINDS`（再导出）、`type ProtocolType`、`type AgentExitReason`、`type AgentErrorCode`、`interface AgentRunInput`、`interface AgentRunResult`、`interface AgentProviderMetadata`、`interface AgentProvider`（逐字对应 spec §5.6.2）
  - `interface AgentRuntime { sdkModule?: unknown }`、`setAgentRuntimeForTesting(runtime: AgentRuntime | null): void`、`getAgentRuntime(): AgentRuntime`

- [ ] **Step 1: 写失败测试 `runtime.test.ts`**

```ts
// @vitest-environment node
/**
 * 运行时注入点：默认空、可注入、可复位。
 * 注意：复位必须彻底——残留的假模块会让同一进程里其他用例拿到上一轮的厂商实现。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { getAgentRuntime, setAgentRuntimeForTesting } from './runtime';

afterEach(() => {
  setAgentRuntimeForTesting(null);
});

describe('AgentRuntime', () => {
  it('默认没有 sdkModule（生产路径不注入任何东西）', () => {
    expect(getAgentRuntime().sdkModule).toBeUndefined();
  });

  it('注入后能按包名取到假模块（三家共用一个字段）', () => {
    const fake = { query: (): undefined => undefined };
    setAgentRuntimeForTesting({ sdkModule: { '@aieval/fake-sdk': fake } });
    const modules = getAgentRuntime().sdkModule as Record<string, unknown>;
    expect(modules['@aieval/fake-sdk']).toBe(fake);
  });

  it('传 null 复位，用例之间不残留', () => {
    setAgentRuntimeForTesting({ sdkModule: { '@aieval/fake-sdk': {} } });
    setAgentRuntimeForTesting(null);
    expect(getAgentRuntime().sdkModule).toBeUndefined();
  });
});
```

- [ ] **Step 2: 写失败测试 `contracts-alignment.test.ts`**

```ts
// @vitest-environment node
/**
 * 与 contracts 的取值空间对齐。
 * 为什么需要：`agents` 里的 `AGENT_KINDS` 是再导出、`ProtocolType` 是 spec 明写的重复声明，
 * 两处一旦与 contracts 漂移，前端下拉（读注册表）与行数据（读 contracts）就会给出不同的家数/协议。
 * `ProtocolType` 的对齐用**编译期断言**：任一处的取值被改动，本文件会直接编译不过。
 */
import { AGENT_KINDS, AGENT_LABELS, AgentKindSchema, ProtocolTypeSchema } from '@aieval/contracts';
import type { ProtocolType as ContractsProtocolType } from '@aieval/contracts';
import { describe, expect, it } from 'vitest';
import { AGENT_KINDS as REEXPORTED_AGENT_KINDS, type ProtocolType } from './types';

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

describe('ProtocolType 重复声明', () => {
  it('与 contracts 的同义（编译期断言：两个方向都要能赋值）', () => {
    // 用**函数签名**而不是 `const local: ProtocolType = 'anthropic'` 来断言：后者的写法会被 TS 的
    // 控制流分析窄化成字面量 `'anthropic'`，于是两个方向的赋值都退化成 `'anthropic' → 'anthropic'`，
    // 把本地 `ProtocolType` **加宽**（例如多一个 `'gemini'`）时整个测试与 typecheck 都仍然绿
    // —— 守卫在这一侧是空转的（p3 Task 1 实测：该变异体 SURVIVED）。
    // 函数返回类型的可赋值性不受字面量窄化影响，两侧各一条，缺一则只是一半的守卫。
    const toContracts = (value: ProtocolType): ContractsProtocolType => value; // 本地 → contracts
    const fromContracts = (value: ContractsProtocolType): ProtocolType => value; // contracts → 本地
    expect([toContracts('anthropic'), fromContracts('anthropic')]).toEqual(['anthropic', 'anthropic']);
  });

  it('取值空间与 contracts 的 schema 一致', () => {
    expect([...ProtocolTypeSchema.options]).toEqual(['openai', 'anthropic']);
  });
});
```

- [ ] **Step 3: 运行确认失败**

Run: `pnpm --filter @aieval/agents test`
Expected: FAIL —— `Failed to resolve import "./runtime"` 与 `Failed to resolve import "./types"`。

- [ ] **Step 4: 写 `src/types.ts`**

```ts
/**
 * agents 包对外的全部类型契约（spec §5.6.2）。
 * 三条注意：
 * 1. `AgentKind` / `AGENT_KINDS` 的真源在 `@aieval/contracts`（契约 §11 R1）：contracts 不能反向
 *    依赖 agents，而 `EvalRow.agentKind` 与前端下拉又必须与注册表同源，故这里只做**再导出**；
 * 2. `ProtocolType` 按 spec §5.6.2 明写「此处重复声明」——只为两个字符串引入一条依赖不划算，
 *    它与 contracts 的同义由 `contracts-alignment.test.ts` 的编译期断言钉住；
 * 3. `AgentEvent` 的形状真源同样在 contracts（§7.4），本文件只 import 不重复声明。
 */
import { AGENT_KINDS, type AgentEvent, type AgentKind } from '@aieval/contracts';

export { AGENT_KINDS };
export type { AgentKind };

/** 与 §7.2 的 ProtocolType 同义；此处重复声明避免为两个字符串引入依赖（spec §5.6.2） */
export type ProtocolType = 'openai' | 'anthropic';

/** 与 §5.4 的行状态同名，便于 1:1 映射；刻意用 'timed-out' 而不是 'timeout' */
export type AgentExitReason = 'completed' | 'timed-out' | 'canceled' | 'error';

/**
 * 领域归因码（§5.6.6）：**不是** contracts 的 `ErrorCode`。
 * 它没有对应的 HTTP 状态，落点是该行的事件日志；塞进 `ERROR_CODES` 会逼 `STATUS_BY_CODE`
 * 为它编造状态码。两组只在 `AUTH_FAILED` / `RATE_LIMITED` 上重名，含义各自独立。
 */
export type AgentErrorCode =
  | 'AGENT_LOAD_FAILED' // 厂商包缺失 / 加载失败
  | 'AGENT_FAILED' // CLI 未安装、进程非零退出、模型名不存在
  | 'AGENT_TIMED_OUT' // 超出 timeoutMs（刻意与行状态 timed-out 同名）
  | 'AGENT_CANCELED' // 用户终止
  | 'AUTH_FAILED' // 密钥无效
  | 'RATE_LIMITED'; // 限流

/** 一次运行的全部输入。内部无厂商分支，无 process.env 读取（spec §5.6.2） */
export interface AgentRunInput {
  /** 该行工作区（编排层第 1、2 步已备好）；适配器不做任何 git 操作（§5.6.5 末段） */
  cwd: string;
  /** 该行独立配置目录（第 3 步已备好）：适配器里作为 HOME / USERPROFILE / 厂商配置目录（§5.6.4 不变量 3） */
  configHome: string;
  /** 考题提示词 */
  prompt: string;
  /** 路由：只读输入；适配器只读、不写回、也不写 process.env（§5.6.4 不变量 1） */
  route: {
    protocolType: ProtocolType;
    baseUrl: string;
    apiKey: string;
    modelId: string;
  };
  /** 本次运行的**内层**上限：到点即停并返回 exitReason 'timed-out'；外层兜底在编排层（§5.6.5） */
  timeoutMs: number;
  /** 外部要求停止（用户终止 / 编排层兜底超时）；**不得**用它推断 exitReason（§5.6.5） */
  signal: AbortSignal;
  /** 事件回调：同步、不 await——事件流不能被消费者拖慢（§5.6.2） */
  onEvent: (e: AgentEvent) => void;
}

/** 一次运行的结果（§5.6.2）：计量采不到时一律 null，绝不填 0 */
export interface AgentRunResult {
  ok: boolean;
  exitReason: AgentExitReason;
  /** null = 该次运行未采到计量；绝不填 0 */
  tokens: { input: number; cached: number; output: number } | null;
  turns: number | null;
  durationMs: number;
  error?: { code: AgentErrorCode; message: string; stack?: string };
}

/** 注册表元数据（§5.6.2 的表）：协议兼容性 / 终止能力 / 隔离级别的**唯一**查询点（A3） */
export interface AgentProviderMetadata {
  /** 该智能体唯一能接受的协议类型；表单的候选池过滤读它，不硬编码三家与协议的对应关系 */
  protocolType: ProtocolType;
  capability: {
    /** false ⇒ 「终止」按钮在该行上退化为「关闭运行时」，界面文案必须不同 */
    cancelMidTurn: boolean;
    /** false ⇒ 该适配器采不到 token，界面显示「不支持计量」而不是 0 */
    usage: boolean;
  };
  /** 工具循环跑在哪里；见 §5.6.5 的释放要求 */
  isolation: 'inprocess' | 'subprocess';
}

/** 一次运行的接口是函数而非类实例：编排层只按 kind 解析并调用（§5.6.2） */
export interface AgentProvider {
  readonly kind: AgentKind;
  readonly displayName: string;
  readonly metadata: AgentProviderMetadata;
  run(input: AgentRunInput): Promise<AgentRunResult>;
}
```

- [ ] **Step 5: 写 `src/runtime.ts`**

```ts
/**
 * 运行时上下文：厂商 SDK 的**测试注入点**（§5.6.6「测试注入点统一为运行时上下文的 sdkModule 字段」）。
 * 形状固定为「包名 → 模块命名空间」的一张表：三家共用一个字段、不另起名字，于是一个假模块表就能
 * 同时喂饱三家，单测因此完全不需要真实厂商包。
 * 注意：注入值**不缓存**（见 load-once.ts）——测试要能在同一进程里从「坏模块」换到「好模块」，
 * 以验证「一次加载失败不会毒化后续运行」。
 */
export interface AgentRuntime {
  sdkModule?: unknown;
}

let current: AgentRuntime = {};

/** 设置注入上下文；传 null 复位（用例结束后必须复位，否则会污染同进程的其他用例） */
export function setAgentRuntimeForTesting(runtime: AgentRuntime | null): void {
  current = runtime ?? {};
}

/** 读取当前注入上下文；生产路径上永远是空对象 */
export function getAgentRuntime(): AgentRuntime {
  return current;
}
```

- [ ] **Step 6: 写 `src/vendor-shims.d.ts`**

```ts
/**
 * 三个厂商包只以「运行时依赖」身份存在（spec §5.6.2 末段）：这里把它们声明成裸模块，于是
 * `await import('@x')` 的类型是 any，各家 `sdk.ts` 再 `as unknown as <自声明窄结构>`。
 * 为什么这样做：厂商发一个破坏性类型变更不该让本仓 typecheck 失败——它只应该在运行时被加载
 * 降级（§5.6.6）与错误码兜住；顺带让「包还没装」也不影响 typecheck。
 * 硬性约束：**任何地方都不允许 `import type` 厂商包**（有静态断言守着）。
 * 若某家自带类型且 TS 优先采用它，本文件同样无害：我们从不消费厂商类型，一律显式收窄。
 */
declare module '@anthropic-ai/claude-agent-sdk';
declare module '@openai/codex-sdk';
declare module '@deepseek-ai/dsh-sdk-client';
```

- [ ] **Step 7: 运行确认通过**

Run: `pnpm --filter @aieval/agents test`
Expected: PASS（`runtime.test.ts` 3 例 + `contracts-alignment.test.ts` 4 例）。

Run: `pnpm --filter @aieval/agents typecheck`
Expected: 通过。

- [ ] **Step 8: 变异验证（守卫：运行时复位 + 契约对齐）**

按顺序做，每步都要贴输出：

1. 记下哈希：`Get-FileHash packages/server/agents/src/runtime.ts -Algorithm SHA256`（记为 H1）。
2. 制造变异体：把 `setAgentRuntimeForTesting` 的 `current = runtime ?? {};` 改成 `current = runtime ?? current;`（复位失效，正是「用例间残留假模块」这个缺陷）。
3. Run: `pnpm --filter @aieval/agents test`；Expected: **FAIL**，`runtime.test.ts` 的「传 null 复位，用例之间不残留」报 `expected { sdkModule: {...} } to be undefined`。
4. 还原成 `current = runtime ?? {};`，重跑：Expected: PASS。
5. `Get-FileHash packages/server/agents/src/runtime.ts -Algorithm SHA256`；Expected: 与 H1 完全相同。哈希不一致就不算还原。
6. **契约对齐守卫（`contracts-alignment.test.ts`）的变异体要跑 `typecheck`，不是 `test`**——它们是**编译期**断言（p3 Task 1 的评审实测：类型变宽时 `pnpm --filter @aieval/agents test` 单独跑是全绿的，只有 `tsc` 会红）。两个方向各做一次，各贴 TS2322 原文：
   - ① **变宽**：`types.ts` 把 `ProtocolType` 加一个 `'gemini'`、把 `AgentKind` 写成 `ContractsAgentKind | 'gemini'` ⇒ `pnpm --filter @aieval/agents typecheck` **退出非 0**；
   - ② **丢成员**：`ProtocolType` 去掉 `'anthropic'`、`AgentKind` 用 `Exclude<ContractsAgentKind, 'dsh'>` ⇒ 同样退出非 0。
   - 注意断言的写法：**必须**用「函数签名双向赋值」（`const toContracts = (v: ProtocolType): ContractsProtocolType => v;` 与反向），**不能**用
     `const local: ProtocolType = 'anthropic'` —— 后者会被 TS 控制流分析窄化成字面量，两个方向的赋值都退化成同一件事，「变宽」这个变异体**存活**（实测过一次，见评审 Report 的 M-D）。
   - `AgentKind` 与 `ProtocolType` **两个名字都要有**这两条断言：它们都是「真源在 contracts、本包只再导出/重复声明」的名字，只守一个等于留一个后门。
7. 哈希复核同上：还原后逐文件 `git diff --quiet` 退出 0 且 `Get-FileHash` 与变异前相同。

- [ ] **Step 9: 提交**

```bash
git add packages/server/agents/src/types.ts packages/server/agents/src/runtime.ts packages/server/agents/src/vendor-shims.d.ts packages/server/agents/src/runtime.test.ts packages/server/agents/src/contracts-alignment.test.ts
git commit -m "feat(agents): 对外类型契约与厂商 SDK 测试注入点（vendor 类型面隔离）"
```

---

## Task 2: 依赖落位与打包外置

**Files:**
- Modify: `packages/server/agents/package.json`（`dependencies` 追加三家厂商包）
- Modify: `pnpm-workspace.yaml`（**仅当** pnpm 的构建脚本提示要求时追加 `allowBuilds` 条目）
- Modify: `apps/web-next/next.config.ts`（补 `serverExternalPackages`）
- Modify: `.gitignore`（追加探测产物目录）

**Interfaces:**
- Consumes: 无
- Produces: `packages/server/agents` 可解析 `@anthropic-ai/claude-agent-sdk` / `@openai/codex-sdk` / `@deepseek-ai/dsh-sdk-client`（只作运行时依赖，`typecheck` 不依赖它们——Task 1 的 `vendor-shims.d.ts` 已隔离）

- [ ] **Step 1: 让 pnpm 写入依赖（不预先猜版本号）**

```bash
# dsh 走 `next` 线而不是 `latest`：契约 R33 已裁定。实测 `latest`（0.0.1-rc.1）把
# dsh-llm / dsh-session / dsh-invariants / dsh-sdk-protocol / cordis 声明为 peerDependencies，
# pnpm 自动装 peer 时 dsh-session 又 peer 到 `@deepseek-ai/dsh-type-meta`，而该包在
# registry.npm.taobao.org / registry.npmmirror.com / registry.npmjs.org **三家全 404**
# （本机唯一带凭据的内网源 registry.m.jd.com ETIMEDOUT）⇒ 按 `latest` 装在本机不可能完成。
# 三家公开源结果一致 ⇒ 上游发版问题，不是本机网络问题。代价：适配器与真实探测按 0.1.7-rc.1 取证。
pnpm --filter @aieval/agents add @anthropic-ai/claude-agent-sdk @openai/codex-sdk @deepseek-ai/dsh-sdk-client@next
```

- [ ] **Step 2: 核对 `package.json` 与安装结果**

Run: `Get-Content packages/server/agents/package.json -Raw`
Expected: `dependencies` 里出现三行（版本由 pnpm 解析，形如 `"@openai/codex-sdk": "^0.x.y"`；**预发布版本没有 `^`**，dsh 应写成 `"0.1.7-rc.1"` 这样的精确值），且 `@aieval/contracts` / `@aieval/core` 仍在。把这段 JSON 原样贴进报告。

**若某家拉不到**（内网 registry、包名拼写、私有源未配置）：先 `pnpm config get registry` 核对源，再按 spec §5.6.2 给的**三个包名原样**重试；**不要**换别的包名。dsh 若在 `latest` 上失败，按契约 R33 改用 `@next` 并**在报告与提交信息里写明实际版本与原因**；其余仍拉不到就把 pnpm 的原始报错贴进报告，并继续做后面的步骤——`vendor-shims.d.ts` 保证了「包没装」不会挡住其余任务（这也正是 §5.6.6 加载降级要覆盖的真实情形）。

- [ ] **Step 3: 按 pnpm 的构建脚本提示表态（不要预先猜）**

Run: `pnpm install`
Expected: 安装成功或给出「Ignored build scripts」清单。

**判定规则（严格按 pnpm 的输出办）**：若输出里点名了某个依赖的构建脚本被忽略（或直接以 `ERR_PNPM_IGNORED_BUILDS` 退出 1），就把**它点名的那些包**逐个加进 `pnpm-workspace.yaml` 的 `allowBuilds`，值写 `true`：

```yaml
allowBuilds:
  sharp: true
  unrs-resolver: true
  # 下面这些是本次装厂商包时 pnpm 点名要求表态的（以它的输出为准逐行追加，不要预先写）
```

**注意**：pnpm 11 下写进 `onlyBuiltDependencies` **不生效**（实测仍报同一错误，见 `AGENT.md` 的已知坑），必须写 `allowBuilds`。若 pnpm 没有点名任何新包，就**不要**改动 `pnpm-workspace.yaml`——把这条「无需改动」的结论写进报告。

- [ ] **Step 4: 把厂商包声明为运行时依赖（打包层外置）**

先按 `AGENT.md` 的硬约束读本地文档确认键名与取值：

Run: `Select-String -Path apps/web-next/node_modules/next/dist/docs/*.md -Pattern 'serverExternalPackages' -List`

然后改 `apps/web-next/next.config.ts`（只加这一段，其余不动）：

```ts
/**
 * Next 配置：把 workspace 内的 TS 源码包纳入编译。
 * 这些包的 `main` 直接指向 `./src/index.ts`，不预先构建产物——Next 靠 transpilePackages 编译它们。
 * 注意：厂商 SDK 是**运行时依赖**（spec §5.6.2）——它们要定位自身的 CLI / 原生二进制，
 * 被打进 server bundle 后定位会失效；故在 serverExternalPackages 里逐个外置。
 */
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  transpilePackages: ['@aieval/contracts', '@aieval/core', '@aieval/agents', '@aieval/evaluator', '@aieval/api', '@aieval/ui', '@aieval/client'],
  serverExternalPackages: [
    '@anthropic-ai/claude-agent-sdk',
    '@openai/codex-sdk',
    '@deepseek-ai/dsh-sdk-client',
  ],
  reactStrictMode: true,
};

export default nextConfig;
```

若本地文档里该键名或形状与本步不同（Next 版本演进过这个键），**以本地文档为准**并同步报告。

- [ ] **Step 5: 忽略探测产物**

在 `.gitignore` 末尾**追加**（不要重写整个文件）：

```gitignore
# 真实事件探测的 dump：可能含网关返回的敏感原文，不入库（结论写进 docs/superpowers/notes/）
packages/server/agents/probe/dumps/
```

- [ ] **Step 6: 确认全仓仍绿**

Run: `pnpm typecheck`
Expected: 通过（8 个包）。

Run: `pnpm --filter @aieval/agents test`
Expected: 通过（本任务未改任何测试）。

- [ ] **Step 7: 提交**

```bash
git add packages/server/agents/package.json pnpm-lock.yaml apps/web-next/next.config.ts .gitignore
git commit -m "chore(agents): 落位三家厂商 SDK（运行时依赖）并把它们声明为 server 外置依赖"
```

若 Step 3 真的改了 `pnpm-workspace.yaml`，把它一并加进 `git add` 的路径列表；没改就不加（逐个显式路径，禁用 `git add -A`）。

---

## Task 3: 窄读取、事件发射与路由注入

**Files:**
- Create: `packages/server/agents/src/json.ts`
- Create: `packages/server/agents/src/emit.ts`
- Create: `packages/server/agents/src/route.ts`
- Create: `packages/server/agents/src/json.test.ts`
- Create: `packages/server/agents/src/emit.test.ts`
- Create: `packages/server/agents/src/route.test.ts`
- Create: `packages/server/agents/src/static-assertions.test.ts`

**Interfaces:**
- Consumes: `@aieval/contracts` 的 `AgentEvent`（§7.4）
- Produces:
  - `asRecord(value: unknown): Record<string, unknown> | null`、`readString(source: Record<string, unknown> | null, key: string): string | null`、`readNumber(source: Record<string, unknown> | null, key: string): number | null`
  - `type AgentEventDraft`、`interface EventEmitter { emit(draft: AgentEventDraft): void }`、`createEventEmitter(onEvent: (event: AgentEvent) => void): EventEmitter`、`logDraft(stream: 'stdout' | 'stderr', text: string): AgentEventDraft`、`unknownEventDraft(payload: unknown): AgentEventDraft`、`safeStringify(value: unknown): string`
  - `stripV1Suffix(baseUrl: string): string`、`ensureV1Suffix(baseUrl: string): string`、`keepBaseUrl(baseUrl: string): string`、`buildSubprocessEnv(input: { homeDir: string; injected: Record<string, string | undefined> }): Record<string, string>`

- [ ] **Step 1: 写失败测试 `json.test.ts`**

```ts
// @vitest-environment node
/** 窄读取：厂商负载是 unknown，读之前必须先收窄；读不到一律 null，且永不抛。 */
import { describe, expect, it } from 'vitest';
import { asRecord, readNumber, readString } from './json';

describe('asRecord', () => {
  it('只接受普通对象（数组 / null / 基本类型一律 null）', () => {
    expect(asRecord({ a: 1 })).toEqual({ a: 1 });
    expect(asRecord([1, 2])).toBeNull();
    expect(asRecord(null)).toBeNull();
    expect(asRecord('x')).toBeNull();
    expect(asRecord(undefined)).toBeNull();
  });
});

describe('readString / readNumber', () => {
  it('类型不对就是 null（不把数字当字符串、不把字符串当数字）', () => {
    const source = asRecord({ s: 'x', n: 3, nan: Number.NaN, inf: Number.POSITIVE_INFINITY, empty: '' });
    expect(readString(source, 's')).toBe('x');
    expect(readString(source, 'n')).toBeNull();
    expect(readNumber(source, 'n')).toBe(3);
    expect(readNumber(source, 'nan')).toBeNull();
    expect(readNumber(source, 'inf')).toBeNull();
    expect(readString(source, 'empty')).toBe('');
    expect(readString(source, 'missing')).toBeNull();
    expect(readNumber(null, 'n')).toBeNull();
  });
});
```

- [ ] **Step 2: 写失败测试 `emit.test.ts`**

```ts
// @vitest-environment node
/**
 * 事件发射：补 seq（run 内自增，从 1）与 at（ISO 8601）；未识别负载必须**逐字段保留**。
 * 第二条是本计划的关键守卫之一：静默丢弃厂商事件等于丢掉「为什么得这个分」的证据。
 */
import type { AgentEvent } from '@aieval/contracts';
import { describe, expect, it } from 'vitest';
import { createEventEmitter, logDraft, safeStringify, unknownEventDraft } from './emit';

describe('createEventEmitter', () => {
  it('seq 从 1 开始、单调递增；at 是 ISO 8601 带时区', () => {
    const seen: AgentEvent[] = [];
    const emitter = createEventEmitter((event) => {
      seen.push(event);
    });
    emitter.emit(logDraft('stdout', 'a'));
    emitter.emit(logDraft('stderr', 'b'));
    expect(seen.map((event) => event.seq)).toEqual([1, 2]);
    expect(seen[0]?.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(seen[1]?.type).toBe('log');
  });

  it('usage 草稿带上 tokens 与 turns（形状与 §7.4 一致）', () => {
    const seen: AgentEvent[] = [];
    const emitter = createEventEmitter((event) => {
      seen.push(event);
    });
    emitter.emit({ type: 'usage', tokens: { input: 10, cached: 2, output: 5 }, turns: 1 });
    expect(seen[0]).toMatchObject({ seq: 1, type: 'usage', tokens: { input: 10, cached: 2, output: 5 }, turns: 1 });
  });
});

describe('unknownEventDraft', () => {
  it('未识别负载被投影成保留原始负载的日志事件（逐字段保留，Review Focus #5）', () => {
    const payload = { type: 'mystery', nested: { a: [1, 2, 3] }, count: 7 };
    const draft = unknownEventDraft(payload);
    expect(draft).toMatchObject({ type: 'log', stream: 'stdout' });
    const text = draft.type === 'log' ? draft.text : '';
    expect(JSON.parse(text)).toEqual(payload);
  });
});

describe('safeStringify', () => {
  it('循环引用与 BigInt 都不抛（日志器不该有能力打断业务流程）', () => {
    const circular: Record<string, unknown> = { name: 'c' };
    circular.self = circular;
    expect(() => safeStringify(circular)).not.toThrow();
    expect(safeStringify(circular)).toContain('self');
    expect(() => safeStringify({ big: 1n })).not.toThrow();
    expect(safeStringify(undefined)).toBe('undefined');
  });
});
```

- [ ] **Step 3: 写失败测试 `route.test.ts`**

```ts
// @vitest-environment node
/**
 * 路由注入：base URL 规范化的三家差异（表驱动）+ 「替换型」子进程环境。
 * /v1 的处理方向三家相反，且用户粘贴的 URL 形态五花八门（尾斜杠 × /v1 后缀 4 种组合），
 * 所以这里逐组合钉死——写错的表现是 404 或「明明配了网关却打到别处」（Review Focus #1）。
 */
import { describe, expect, it } from 'vitest';
import { buildSubprocessEnv, ensureV1Suffix, keepBaseUrl, stripV1Suffix } from './route';

describe('stripV1Suffix（claude-code：拆掉尾部 /v1）', () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ['https://gw.example.com/anthropic', 'https://gw.example.com/anthropic'],
    ['https://gw.example.com/anthropic/', 'https://gw.example.com/anthropic'],
    ['https://gw.example.com/anthropic/v1', 'https://gw.example.com/anthropic'],
    ['https://gw.example.com/anthropic/v1/', 'https://gw.example.com/anthropic'],
  ];
  it.each(cases)('%s → %s', (input, expected) => {
    expect(stripV1Suffix(input)).toBe(expected);
  });

  it('只拆结尾那一个 /v1（中间出现的 v1 属于路径，不能动）', () => {
    expect(stripV1Suffix('https://gw.example.com/v1/anthropic')).toBe('https://gw.example.com/v1/anthropic');
  });
});

describe('ensureV1Suffix（codex：补上 /v1，只走 Responses wire）', () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ['https://gw.example.com/openai', 'https://gw.example.com/openai/v1'],
    ['https://gw.example.com/openai/', 'https://gw.example.com/openai/v1'],
    ['https://gw.example.com/openai/v1', 'https://gw.example.com/openai/v1'],
    ['https://gw.example.com/openai/v1/', 'https://gw.example.com/openai/v1'],
  ];
  it.each(cases)('%s → %s', (input, expected) => {
    expect(ensureV1Suffix(input)).toBe(expected);
  });
});

describe('keepBaseUrl（dsh：保留尾部 /v1，只去尾斜杠）', () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ['https://gw.example.com/deepseek', 'https://gw.example.com/deepseek'],
    ['https://gw.example.com/deepseek/', 'https://gw.example.com/deepseek'],
    ['https://gw.example.com/deepseek/v1', 'https://gw.example.com/deepseek/v1'],
    ['https://gw.example.com/deepseek/v1/', 'https://gw.example.com/deepseek/v1'],
  ];
  it.each(cases)('%s → %s', (input, expected) => {
    expect(keepBaseUrl(input)).toBe(expected);
  });
});

describe('buildSubprocessEnv', () => {
  it('注入后返回新对象，宿主 process.env 一个字段都不变（§5.6.4 不变量 1，Review Focus #2）', () => {
    const before = { ...process.env };
    const env = buildSubprocessEnv({ homeDir: 'D:/tmp/row/.agenthome', injected: { ANTHROPIC_API_KEY: 'sk-test' } });
    expect(env.ANTHROPIC_API_KEY).toBe('sk-test');
    expect(env).not.toBe(process.env);
    expect({ ...process.env }).toEqual(before);
  });

  it('展开宿主环境（补 PATH：不展开子进程连 node 都找不到）', () => {
    const env = buildSubprocessEnv({ homeDir: 'D:/tmp/row/.agenthome', injected: {} });
    expect(env.PATH).toBe(process.env.PATH);
  });

  it('HOME 与 USERPROFILE 都指向该行独立目录（Windows 上只改 HOME 等于没隔离）', () => {
    const env = buildSubprocessEnv({ homeDir: 'D:/tmp/row/.agenthome', injected: {} });
    expect(env.HOME).toBe('D:/tmp/row/.agenthome');
    expect(env.USERPROFILE).toBe('D:/tmp/row/.agenthome');
  });

  it('值为 undefined 的注入键被删掉（避免子进程看到空串凭据）', () => {
    const env = buildSubprocessEnv({ homeDir: 'D:/tmp/row/.agenthome', injected: { ANTHROPIC_API_KEY: undefined } });
    expect('ANTHROPIC_API_KEY' in env).toBe(false);
  });
});
```

- [ ] **Step 4: 写失败测试 `static-assertions.test.ts`**

```ts
// @vitest-environment node
/**
 * 源码级不变量：没有运行期可观测量，只能扫源码。
 * 「写对了」与「写错了」在注入正确的用例里表现完全一样——一份写 `process.env` 的实现照样能让
 * 单测全绿，差别只在并行跑两行时第二行拿到别人的密钥（Review Focus #2）。
 * 扫描范围是 agents 包自己的 src/**，**排除 *.test.ts**：本文件里的正则字面量会把规则自己判违规。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** 包内全部非测试源码（相对 src），Windows 分隔符统一成正斜杠 */
function sourceFiles(): string[] {
  return readdirSync(import.meta.dirname, { recursive: true })
    .map((entry) => String(entry).replace(/\\/g, '/'))
    .filter((entry) => entry.endsWith('.ts') && !entry.endsWith('.test.ts'));
}

/** 命中即违规的写法：任何形式的宿主环境写入 */
const ENV_WRITE_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bprocess\.env\.[A-Za-z_][A-Za-z0-9_]*\s*=[^=]/g, '点号赋值'],
  [/\bprocess\.env\s*\[/g, '下标读写（本仓只允许点号读取）'],
  [/\bObject\.assign\s*\(\s*process\.env/g, 'Object.assign 批量写入'],
  [/\bprocess\.env\.[A-Za-z_][A-Za-z0-9_]*\s*(\+\+|--|\+=|-=|\*=|\?\?=|\|\|=|&&=)/g, '自更新'],
];

describe('源码级不变量', () => {
  it('源码里不出现任何写入宿主环境的写法（§5.6.4 不变量 2）', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      const text = readFileSync(join(import.meta.dirname, file), 'utf8');
      for (const [pattern, why] of ENV_WRITE_PATTERNS) {
        const hits = text.match(pattern);
        if (hits !== null) offenders.push(`${file}：${why}（${hits.join(' / ')}）`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
```

- [ ] **Step 5: 运行确认失败**

Run: `pnpm --filter @aieval/agents test`
Expected: FAIL —— `Failed to resolve import "./json"` / `"./emit"` / `"./route"`。

- [ ] **Step 6: 写 `src/json.ts`**

```ts
/**
 * 任意负载的窄读取工具。
 * 为什么需要：适配器拿到的事件是 `unknown`（§5.6.2 明确不从厂商包 import type），读之前必须先收窄，
 * 否则整份投影代码都会被 any 与可选链淹没。
 * 注意：这些函数一律**不抛**，读不到就返回 null——事件投影遇到形状意外时必须继续跑完。
 */

/** 收窄成普通对象；数组 / null / 基本类型一律返回 null */
export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** 读字符串字段；不是字符串（含缺失）返回 null */
export function readString(source: Record<string, unknown> | null, key: string): string | null {
  const value = source?.[key];
  return typeof value === 'string' ? value : null;
}

/** 读数值字段；NaN / Infinity / 非数字一律 null（「没采到」靠 null 表达，不靠 0） */
export function readNumber(source: Record<string, unknown> | null, key: string): number | null {
  const value = source?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
```

- [ ] **Step 7: 写 `src/emit.ts`**

```ts
/**
 * 事件发射与「未识别负载」投影：适配器产出的每一条事件都从这里出去。
 * 职责：
 *  1. 补 `seq`（**run 内自增，从 1 开始**）与 `at`（ISO 8601）。为什么由适配器给：`onEvent` 的签名被
 *     spec §5.6.2 钉死为 `(e: AgentEvent) => void`，而 `AgentEvent` 的 seq/at 是必填；落盘的最终 seq
 *     由 core 的 appendEvent 按文件重新分配（契约 §3.4），适配器这一层的序号不参与持久化语义。
 *  2. 提供把任意厂商负载折成日志事件的出口（§5.6.3：未识别事件不得静默丢弃）。
 * 注意：`onEvent` 是同步回调，本模块**不 await**、不做背压（§5.6.2）。
 */
import { inspect } from 'node:util';
import type { AgentEvent } from '@aieval/contracts';

/** 适配器能发的三类事件；status / diff-summary / score / end 由编排层发（见「实现层修正」第 2 条） */
export type AgentEventDraft =
  | { type: 'log'; stream: 'stdout' | 'stderr'; text: string }
  | { type: 'usage'; tokens: { input: number; cached: number; output: number }; turns: number }
  | { type: 'error'; message: string; stack?: string };

export interface EventEmitter {
  emit: (draft: AgentEventDraft) => void;
}

/** 造一个发射器：seq 在同一次 run 内单调递增 */
export function createEventEmitter(onEvent: (event: AgentEvent) => void): EventEmitter {
  let seq = 0;
  return {
    emit: (draft) => {
      seq += 1;
      onEvent(withMeta(draft, seq));
    },
  };
}

/** 日志草稿 */
export function logDraft(stream: 'stdout' | 'stderr', text: string): AgentEventDraft {
  return { type: 'log', stream, text };
}

/** 未识别事件一律落成**保留原始负载**的日志事件（§5.6.3），不要在这里做任何取舍 */
export function unknownEventDraft(payload: unknown): AgentEventDraft {
  return logDraft('stdout', safeStringify(payload));
}

/**
 * 补 seq / at。
 * 为什么用 switch 而不是对象展开：展开联合类型会让 TS 收不到窄化，从而丢掉「事件成员漏了一个没写」
 * 这件事的编译期检查——那正是本层最容易静默出错的地方。
 */
function withMeta(draft: AgentEventDraft, seq: number): AgentEvent {
  const at = new Date().toISOString();
  switch (draft.type) {
    case 'log':
      return { seq, at, type: 'log', stream: draft.stream, text: draft.text };
    case 'usage':
      return { seq, at, type: 'usage', tokens: draft.tokens, turns: draft.turns };
    case 'error':
      return { seq, at, type: 'error', message: draft.message, stack: draft.stack };
  }
}

/**
 * 把任意值序列化成可读文本。
 * 为什么不用裸 JSON.stringify：它遇到循环引用或 BigInt 会抛，而它在实参位置求值——异常会原样冒进
 * 适配器主流程。丢事件比丢格式更糟，所以兜底走 util.inspect（能渲染循环引用与 BigInt，且不抛）。
 */
export function safeStringify(value: unknown): string {
  try {
    const text = JSON.stringify(value);
    // undefined / 函数 / Symbol 会被 stringify 成 undefined，此时同样交给 inspect
    return text === undefined ? inspect(value) : text;
  } catch {
    return inspect(value, { depth: 6, breakLength: 120 });
  }
}
```

- [ ] **Step 8: 写 `src/route.ts`**

```ts
/**
 * 路由注入：base URL 规范化 + 「替换型」子进程环境构造（spec §5.6.4）。
 * 三条硬性不变量：
 *  1. 注入后返回**新对象**，输入的 route 只读，`process.env` 永不写入（有静态断言守着）；
 *  2. 子进程环境以宿主环境为底（不展开就补不上 PATH，子进程连 node 都找不到），再覆盖该行独立 HOME；
 *  3. 每行的 configHome 是独立目录：行与行之间共享配置目录会互相注入 MCP / 插件定义，直接破坏
 *     「同一起点」这个前提。
 */

/**
 * claude-code：拆掉尾部 `/v1`。
 * 为什么：该 SDK 自己追加 `/v1/messages`，留着会变成 `/v1/v1/messages`。
 */
export function stripV1Suffix(baseUrl: string): string {
  return trimTrailingSlash(baseUrl).replace(/\/v1$/, '');
}

/**
 * codex：补上 `/v1`。
 * 为什么：CLI 只走 Responses wire，即 `POST {base}/v1/responses`。
 */
export function ensureV1Suffix(baseUrl: string): string {
  const trimmed = trimTrailingSlash(baseUrl);
  return /\/v1$/.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

/**
 * dsh：保留尾部 `/v1`（只去尾斜杠）。
 * 为什么：它的 adapter 自己追加 `/chat/completions`，拆掉 `/v1` 会打到错误路径。
 */
export function keepBaseUrl(baseUrl: string): string {
  return trimTrailingSlash(baseUrl);
}

/** 去掉结尾的全部斜杠；只处理结尾，中间的路径一个字符都不动 */
function trimTrailingSlash(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

export interface SubprocessEnvInput {
  /** 该行独立配置目录（编排层第 3 步备好的 `.agenthome`） */
  homeDir: string;
  /** 本次要注入的厂商变量；值为 undefined 的键会被删掉，避免子进程看到空串凭据 */
  injected: Record<string, string | undefined>;
}

/**
 * 构造「替换型」子进程环境：宿主环境 → 覆盖 HOME → 覆盖本次注入。
 * 为什么必须是替换型（而不是往 process.env 里塞再让 SDK 自己读）：并行时多行同时驱动不同供应商，
 * 一旦靠读 `process.env` 再兜底写回来注入，第二行起就再也拿不到自己的凭据——写入是粘性的（A5）。
 */
export function buildSubprocessEnv(input: SubprocessEnvInput): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  // HOME 与 USERPROFILE 都要改：Windows 上 Node 与多数 CLI 走 USERPROFILE，只改 HOME 等于没隔离
  env.HOME = input.homeDir;
  env.USERPROFILE = input.homeDir;
  for (const [key, value] of Object.entries(input.injected)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}
```

- [ ] **Step 9: 运行确认通过**

Run: `pnpm --filter @aieval/agents test`
Expected: PASS（`json` 2 例 + `emit` 4 例 + `route` 15 例 + `static-assertions` 1 例）。

Run: `pnpm --filter @aieval/agents typecheck`
Expected: 通过。

- [ ] **Step 10: 变异验证（两条守卫，逐条做）**

**守卫 A —— `/v1` 表驱动（Review Focus #1）**

1. `Get-FileHash packages/server/agents/src/route.ts -Algorithm SHA256`（记为 H-route）。
2. 变异体：把 `stripV1Suffix` 里的 `.replace(/\/v1$/, '')` 删掉，改成 `return trimTrailingSlash(baseUrl);`（即「不拆 /v1」这个缺陷）。
3. Run: `pnpm --filter @aieval/agents test`；Expected: **FAIL**，`route.test.ts` 里 `https://gw.example.com/anthropic/v1 → https://gw.example.com/anthropic` 一例报 `expected 'https://gw.example.com/anthropic/v1' to be 'https://gw.example.com/anthropic'`。
4. 还原，重跑：Expected: PASS；`Get-FileHash` 与 H-route 一致。

**守卫 B —— 宿主环境不得被写入（§5.6.4 不变量 2，Review Focus #2）**

1. `Get-FileHash packages/server/agents/src/static-assertions.test.ts -Algorithm SHA256`（记为 H-static）。
2. 变异体：在 `src/route.ts` 的 `buildSubprocessEnv` 末尾加一行 `process.env.AIEVAL_ENV_PROBE = '1';`（不改测试）。
3. Run: `pnpm --filter @aieval/agents test`；Expected: **FAIL**，`static-assertions.test.ts` 报 `offenders` 里出现 `route.ts：点号赋值（process.env.AIEVAL_ENV_PROBE =）`。
4. 删掉那一行，重跑：Expected: PASS；`Get-FileHash src/static-assertions.test.ts` 与 H-static 一致（同时核对 `route.ts` 的哈希也回到 H-route）。

- [ ] **Step 11: 提交**

```bash
git add packages/server/agents/src/json.ts packages/server/agents/src/emit.ts packages/server/agents/src/route.ts packages/server/agents/src/json.test.ts packages/server/agents/src/emit.test.ts packages/server/agents/src/route.test.ts packages/server/agents/src/static-assertions.test.ts
git commit -m "feat(agents): 窄读取、事件发射（seq/at + 未识别负载保留）与三家路由注入口径"
```

---

## Task 4: 错误归因与释放守卫

**Files:**
- Create: `packages/server/agents/src/errors.ts`
- Create: `packages/server/agents/src/release.ts`
- Create: `packages/server/agents/src/errors.test.ts`
- Create: `packages/server/agents/src/release.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `AgentErrorCode` / `AgentKind`、Task 3 的 `asRecord` / `readNumber`
- Produces:
  - `interface FailureContext { kind: AgentKind; baseUrl: string }`、`interface AgentFailure { code: AgentErrorCode; message: string; stack?: string }`、`class AgentLoadError extends Error`（`code = 'AGENT_LOAD_FAILED'`、`packageName`）、`classifyAgentFailure(error: unknown, context: FailureContext): AgentFailure`、`classifyAgentMessage(message: string, context: FailureContext): AgentFailure`
  - `const RELEASE_GRACE_MS = 5_000`、`interface TurnLifecycle`、`interface ReleaseReport { disposeError: unknown | null }`、`releaseTurn(lifecycle: TurnLifecycle, onGraceExceeded: () => void, graceMs?: number): Promise<ReleaseReport>`、`createDisposer(close: () => Promise<void> | void): () => Promise<void>`

- [ ] **Step 1: 写失败测试 `errors.test.ts`**

```ts
// @vitest-environment node
/**
 * 错误归因：加载失败要点名包名与安装方式；401/429/404 的文案要求见 §5.6.6 的表。
 * 为什么归因必须由适配器做：事件流里拿到的往往只有一句上游文案，编排层无法知道网关是「限流」还是
 * 「模型名拼错」——这两件事给用户的下一步动作完全不同。
 */
import { describe, expect, it } from 'vitest';
import { AgentLoadError, classifyAgentFailure, classifyAgentMessage } from './errors';

const CONTEXT = { kind: 'codex', baseUrl: 'https://gw.example.com/openai/v1' } as const;

describe('AgentLoadError', () => {
  it('点名包名 + 安装方式，并保留原始原因', () => {
    const error = new AgentLoadError('@openai/codex-sdk', new Error('Cannot find module'));
    expect(error.code).toBe('AGENT_LOAD_FAILED');
    expect(error.packageName).toBe('@openai/codex-sdk');
    expect(error.message).toContain('@openai/codex-sdk');
    expect(error.message).toContain('pnpm add @openai/codex-sdk');
    expect(error.message).toContain('Cannot find module');
    expect(error).toBeInstanceOf(Error);
  });

  it('原因是任意值时也不抛（事件流里的 cause 可能是字符串或对象）', () => {
    expect(() => new AgentLoadError('@x/y', { weird: true })).not.toThrow();
  });
});

describe('classifyAgentFailure', () => {
  it('401 → AUTH_FAILED，文案带 host 并指向设置页', () => {
    const failure = classifyAgentFailure(Object.assign(new Error('unauthorized'), { status: 401 }), CONTEXT);
    expect(failure.code).toBe('AUTH_FAILED');
    expect(failure.message).toContain('gw.example.com');
    expect(failure.message).toContain('设置');
  });

  it('429 → RATE_LIMITED，文案建议改用串行', () => {
    const failure = classifyAgentFailure(Object.assign(new Error('too many requests'), { statusCode: 429 }), CONTEXT);
    expect(failure.code).toBe('RATE_LIMITED');
    expect(failure.message).toContain('串行');
  });

  it('404 / 400 → AGENT_FAILED，且保留上游响应正文', () => {
    const failure = classifyAgentFailure(Object.assign(new Error('model gpt-x not found'), { status: 404 }), CONTEXT);
    expect(failure.code).toBe('AGENT_FAILED');
    expect(failure.message).toContain('404');
    expect(failure.message).toContain('model gpt-x not found');
  });

  it('宿主没有 status 字段时从文案里认状态码（网关常把它写在正文里）', () => {
    expect(classifyAgentFailure(new Error('gateway replied 429'), CONTEXT).code).toBe('RATE_LIMITED');
  });

  it('spawn ENOENT → AGENT_FAILED，并指向缺失的可执行文件', () => {
    const failure = classifyAgentFailure(new Error('spawn codex ENOENT'), CONTEXT);
    expect(failure.code).toBe('AGENT_FAILED');
    expect(failure.message).toContain('可执行文件');
  });

  it('其它错误 → AGENT_FAILED，原文照传（保留排障线索）', () => {
    const failure = classifyAgentFailure(new Error('进程非零退出：3'), CONTEXT);
    expect(failure.code).toBe('AGENT_FAILED');
    expect(failure.message).toBe('进程非零退出：3');
  });

  it('AgentLoadError 原样透出（加载失败要有自己的码）', () => {
    const failure = classifyAgentFailure(new AgentLoadError('@openai/codex-sdk', new Error('boom')), CONTEXT);
    expect(failure.code).toBe('AGENT_LOAD_FAILED');
  });
});

describe('classifyAgentMessage', () => {
  it('从厂商给的纯文本归因（事件流里没有 Error 对象）', () => {
    expect(classifyAgentMessage('HTTP 401 unauthorized', CONTEXT).code).toBe('AUTH_FAILED');
    expect(classifyAgentMessage('everything is fine', CONTEXT).code).toBe('AGENT_FAILED');
  });
});
```

- [ ] **Step 2: 写失败测试 `release.test.ts`**

```ts
// @vitest-environment node
/**
 * 释放序列（§5.6.5）：interrupt → 终结在途 turn → dispose，顺序不可颠倒；
 * 第一段 5 秒超限落可见信号后强制 dispose；守卫按对象绑定且幂等。
 * 顺序断言用 graceMs 直接压到毫秒级——否则这条用例只能靠真等 5 秒来验证。
 */
import { describe, expect, it, vi } from 'vitest';
import { createDisposer, releaseTurn, type TurnLifecycle } from './release';

interface Harness {
  lifecycle: TurnLifecycle;
  order: string[];
  settle: () => void;
  graceExceeded: () => void;
}

function createLifecycle(options: { cooperative?: boolean; disposeThrows?: boolean; interruptThrows?: boolean } = {}): Harness {
  const order: string[] = [];
  let settle: () => void = () => {};
  const settled = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const graceExceeded = vi.fn();
  return {
    order,
    settle: () => {
      order.push('turn-end');
      settle();
    },
    graceExceeded,
    lifecycle: {
      interrupt: () => {
        order.push('interrupt');
        if (options.interruptThrows === true) throw new Error('停止信号自身失败');
        if (options.cooperative !== false) {
          order.push('turn-end');
          settle();
        }
      },
      settled,
      dispose: async () => {
        order.push('dispose');
        if (options.disposeThrows === true) throw new Error('回收失败');
      },
    },
  };
}

describe('releaseTurn', () => {
  it('合作型适配器：interrupt → turn 终结 → dispose（顺序不可颠倒）', async () => {
    const harness = createLifecycle({ cooperative: true });
    const report = await releaseTurn(harness.lifecycle, harness.graceExceeded, 50);
    expect(harness.order).toEqual(['interrupt', 'turn-end', 'dispose']);
    expect(harness.graceExceeded).not.toHaveBeenCalled();
    expect(report.disposeError).toBeNull();
  });

  it('忽略 interrupt 的适配器：第一段超限 → 落可见信号 → 仍强制 dispose（有限时间内完成）', async () => {
    const harness = createLifecycle({ cooperative: false });
    const startedAt = Date.now();
    const report = await releaseTurn(harness.lifecycle, harness.graceExceeded, 20);
    expect(harness.graceExceeded).toHaveBeenCalledTimes(1);
    expect(harness.order).toEqual(['interrupt', 'dispose']);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(report.disposeError).toBeNull();
  });

  it('interrupt 自己抛错也不挡释放（第二段照走）', async () => {
    const harness = createLifecycle({ cooperative: false, interruptThrows: true });
    const report = await releaseTurn(harness.lifecycle, harness.graceExceeded, 20);
    expect(harness.order).toEqual(['interrupt', 'dispose']);
    expect(report.disposeError).toBeNull();
  });

  it('dispose 抛错不冒给调用方，只记进报告（让调用方决定怎么落日志）', async () => {
    const harness = createLifecycle({ cooperative: true, disposeThrows: true });
    const report = await releaseTurn(harness.lifecycle, harness.graceExceeded, 50);
    expect(report.disposeError).toBeInstanceOf(Error);
  });
});

describe('createDisposer', () => {
  it('同一个对象恰好关一次，重复调用返回同一个 Promise', async () => {
    const close = vi.fn(async () => {});
    const dispose = createDisposer(close);
    const first = dispose();
    const second = dispose();
    expect(first).toBe(second);
    await Promise.all([first, second]);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('守卫绑定对象而不是全局闭锁：「中断 → 新建客户端 → 释放」不会漏关新客户端（A7）', async () => {
    const closed: string[] = [];
    const first = createDisposer(() => {
      closed.push('client-1');
    });
    const second = createDisposer(() => {
      closed.push('client-2');
    });
    await first();
    await second();
    expect(closed).toEqual(['client-1', 'client-2']);
  });
});
```

- [ ] **Step 3: 运行确认失败**

Run: `pnpm --filter @aieval/agents test`
Expected: FAIL —— `Failed to resolve import "./errors"` 与 `Failed to resolve import "./release"`。

- [ ] **Step 4: 写 `src/errors.ts`**

```ts
/**
 * 适配器的错误归因（spec §5.6.6）。
 * 注意：这里的 `AgentErrorCode` **不是** contracts 的 `ErrorCode`——它没有对应的 HTTP 状态，落点是
 * 该行的事件日志；不要塞进 `ERROR_CODES`（那会逼 `STATUS_BY_CODE` 为它编造状态码）。
 * 用户可见文案的要求（§5.6.6 表）：加载失败点名包名与安装方式；密钥无效带 host 指向设置页；
 * 限流提示改用串行；模型名不存在保留上游响应正文（网关的 404 与模型名拼错在正文之外无法区分）。
 */
import { asRecord, readNumber } from './json';
import type { AgentErrorCode, AgentKind } from './types';

export interface FailureContext {
  kind: AgentKind;
  /** 出错那次运行用的网关地址：AUTH_FAILED / RATE_LIMITED 的文案要带 host */
  baseUrl: string;
}

export interface AgentFailure {
  code: AgentErrorCode;
  message: string;
  stack?: string;
}

/**
 * 厂商 SDK 加载失败（§5.6.6：厂商包缺失 / 加载失败）。
 * 文案必须同时回答两件事：「装什么」（包名）与「怎么装」（安装命令）——「未装」与「装了但加载失败」
 * 的处置完全不同，只说「加载失败」等于把排查成本丢给使用者。
 */
export class AgentLoadError extends Error {
  readonly code = 'AGENT_LOAD_FAILED';
  readonly packageName: string;

  constructor(packageName: string, cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(
      `厂商 SDK 加载失败：${packageName}（原因：${reason}）。请在 packages/server/agents 下执行 pnpm add ${packageName}；若已安装，检查网络镜像与 node_modules 完整性`,
      { cause },
    );
    this.name = 'AgentLoadError';
    this.packageName = packageName;
  }
}

/** 从错误对象归因（事件流里通常给的是 Error 实例） */
export function classifyAgentFailure(error: unknown, context: FailureContext): AgentFailure {
  if (error instanceof AgentLoadError) {
    return { code: error.code, message: error.message, stack: error.stack };
  }
  const host = hostOf(context.baseUrl);
  const status = statusOf(error);
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : undefined;

  if (status === 401 || status === 403) {
    return {
      code: 'AUTH_FAILED',
      message: `密钥无效或无权访问（${host}）：请到「设置 → 模型供应商」核对该供应商的密钥后重跑本行`,
      stack,
    };
  }
  if (status === 429) {
    return {
      code: 'RATE_LIMITED',
      message: `上游限流（${host}）：稍后重试，或把本评测的执行模式改为串行以减少并发（${context.kind}）`,
      stack,
    };
  }
  if (status === 400 || status === 404) {
    return {
      code: 'AGENT_FAILED',
      message: `请求被上游拒绝（HTTP ${status}，${host}）：多为模型名不存在或网关不支持该接口；上游响应正文：${message}`,
      stack,
    };
  }
  if (/spawn\s+\S+\s+ENOENT/.test(message) || /ENOENT/.test(message)) {
    return {
      code: 'AGENT_FAILED',
      message: `${context.kind} 的可执行文件不存在或无法启动（${message}）：请确认对应 CLI 已安装并在 PATH 中`,
      stack,
    };
  }
  return { code: 'AGENT_FAILED', message, stack };
}

/** 从厂商给出的**文本**归因：事件流里往往只有 message 字符串，没有 Error 对象 */
export function classifyAgentMessage(message: string, context: FailureContext): AgentFailure {
  return classifyAgentFailure(new Error(message), context);
}

/** 取 host 用于文案；URL 不合法时退回原文（绝不因为「文案里放不下 host」而抛） */
function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

/** 读 HTTP 状态：厂商 SDK 有的挂 status、有的挂 statusCode、有的只写进文案 */
function statusOf(error: unknown): number | null {
  const record = asRecord(error);
  const direct = readNumber(record, 'status') ?? readNumber(record, 'statusCode');
  if (direct !== null) return direct;
  const message = error instanceof Error ? error.message : String(error);
  const match = /\b(400|401|403|404|429)\b/.exec(message);
  return match?.[1] === undefined ? null : Number(match[1]);
}
```

- [ ] **Step 5: 写 `src/release.ts`**

```ts
/**
 * 释放：`interrupt()` → 终结在途 turn → `dispose()`（spec §5.6.5）。
 * 顺序不可颠倒：直接 dispose 会与在途 turn 争抢同一批资源（dsh 的子进程、codex 的临时目录）。
 * 超时分两段：第一段等 5 秒（RELEASE_GRACE_MS），超限先给出可见信号再强制 dispose——非合作的
 * 适配器必须可见，不能静默（否则界面上一行永远停在 running，没人知道是适配器不响应）。
 * 注意：守卫（createDisposer）绑定**被关闭的对象**，不是运行时级一次性闭锁（A7）：
 * 「中断 → 下一轮新建客户端 → 释放」这条路径下，闭锁会让新客户端再也没人关，留下孤儿子进程。
 */

/** 第一段等待上限：发出 interrupt 后等 5 秒（§5.6.5 表） */
export const RELEASE_GRACE_MS = 5_000;

export interface TurnLifecycle {
  /** 发停止信号（不等待）；允许适配器忽略（dsh 不支持中途取消），也允许它抛——抛了不挡释放 */
  interrupt: () => void;
  /** 在途 turn 的终结 Promise：适配器自己的 finally 清理完成时 resolve（约定不 reject） */
  settled: Promise<void>;
  /** 回收子进程 / 删临时目录；**必须幂等**（超时与用户终止可能先后触发） */
  dispose: () => Promise<void>;
}

export interface ReleaseReport {
  /** dispose 抛出的错误（null = 正常）：由调用方决定怎么落日志，这里既不吞也不冒 */
  disposeError: unknown | null;
}

/**
 * 按固定顺序释放一次运行。
 * graceMs 只给测试用（毫秒级验证第二段兜底），生产路径一律用 RELEASE_GRACE_MS。
 */
export async function releaseTurn(
  lifecycle: TurnLifecycle,
  onGraceExceeded: () => void,
  graceMs: number = RELEASE_GRACE_MS,
): Promise<ReleaseReport> {
  try {
    lifecycle.interrupt();
  } catch {
    // 停止信号自身失败不得挡住释放：该走的第二段还是要走
  }
  const settled = await waitForSettled(lifecycle.settled, graceMs);
  if (!settled) {
    // 可见信号自身失败也不得挡住释放（T3/T4 任务评审的 Important F1）：回调抛错就跳过 try/catch 的写法
    // 会让下面的 dispose() 永不执行 ⇒ 子进程/临时目录变孤儿，而这不是假想回调——调用方（runTurn）
    // 传进来的实现内部会 emit 事件，而契约 R26 规定写侧校验不过就抛。
    // 与上面 interrupt() 的保护同一条理由：释放路径上的每一步都必须走完。
    try {
      onGraceExceeded();
    } catch {
      // 刻意吞掉：可见性次于「一定回收」
    }
  }
  try {
    await lifecycle.dispose();
    return { disposeError: null };
  } catch (error) {
    return { disposeError: error };
  }
}

/**
 * 关闭守卫：把「恰好关一次」绑到**被关闭的对象**上（A7）。
 * 重复调用返回同一个 Promise，于是「超时」与「用户终止」先后触发也只关一次（幂等）。
 */
export function createDisposer(close: () => Promise<void> | void): () => Promise<void> {
  let closed: Promise<void> | undefined;
  return () => {
    closed ??= (async () => {
      await close();
    })();
    return closed;
  };
}

/** 等 settled 或超时；settled 约定不 reject，这里仍然兜住 reject，避免异常从释放路径冒出去 */
async function waitForSettled(settled: Promise<void>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      settled.then(
        () => true,
        () => true,
      ),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
```

- [ ] **Step 6: 运行确认通过**

Run: `pnpm --filter @aieval/agents test`
Expected: PASS（`errors` 10 例 + `release` 6 例）。

Run: `pnpm --filter @aieval/agents typecheck`
Expected: 通过。

- [ ] **Step 7: 变异验证（守卫：释放顺序 + dispose 幂等）**

**守卫 A —— 释放顺序（Review Focus #3）**

1. `Get-FileHash packages/server/agents/src/release.ts -Algorithm SHA256`（记为 H-release）。
2. 变异体：把 `releaseTurn` 里 `interrupt()` / 等待 / `dispose()` 的顺序改成「先 dispose 再 interrupt」——即把 `try { lifecycle.interrupt(); } catch { … }` 这一段整块移到 `await lifecycle.dispose()` 之后。
3. Run: `pnpm --filter @aieval/agents test`；Expected: **FAIL**，`release.test.ts` 的「合作型适配器：interrupt → turn 终结 → dispose」报 `expected [ 'dispose', 'interrupt', 'turn-end' ] to deeply equal [ 'interrupt', 'turn-end', 'dispose' ]`。
4. 还原，重跑：Expected: PASS；`Get-FileHash` 与 H-release 一致。

**守卫 B —— dispose 幂等（A7）**

1. `Get-FileHash packages/server/agents/src/release.ts -Algorithm SHA256`（记为 H-release2）。
2. 变异体：把 `createDisposer` 改成每次都真关一次——`return () => (async () => { await close(); })();`（去掉 `closed ??=` 记忆）。
3. Run: `pnpm --filter @aieval/agents test`；Expected: **FAIL**，`release.test.ts` 的「同一个对象恰好关一次」报 `expected "spy" to be called 1 times, but got 2 times`；同时「重复调用返回同一个 Promise」报 `expected Promise to be Promise`。
4. 还原，重跑：Expected: PASS；`Get-FileHash` 与 H-release2 一致。

- [ ] **Step 8: 提交**

```bash
git add packages/server/agents/src/errors.ts packages/server/agents/src/release.ts packages/server/agents/src/errors.test.ts packages/server/agents/src/release.test.ts
git commit -m "feat(agents): 错误归因（§5.6.6）与释放守卫（顺序固定 + 两段超时 + 幂等）"
```

---

## Task 5: 懒加载外壳与「厂商包不得静态导入」断言

**Files:**
- Create: `packages/server/agents/src/load-once.ts`
- Create: `packages/server/agents/src/load-once.test.ts`
- Modify: `packages/server/agents/src/static-assertions.test.ts`（追加一条用例 + 一个常量）

**Interfaces:**
- Consumes: Task 1 的 `getAgentRuntime`、Task 4 的 `AgentLoadError`
- Produces: `createSdkLoader<T>(load: () => Promise<T>, packageName: string): () => Promise<T>`

- [ ] **Step 1: 写失败测试 `load-once.test.ts`**

```ts
// @vitest-environment node
/**
 * 懒加载外壳：只缓存**成功**的加载；注入优先且不缓存。
 * 为什么「不缓存失败」必须有用例：一次镜像抖动（首次 import 失败）如果被缓存，长驻服务的后续所有行
 * 都会直接失败——故障从「一次」变成「永久」，而这正是 A6 选择懒加载要避免的事。
 * 为什么「注入不缓存」必须有用例：测试要在同一进程里从「坏模块」换到「好模块」，验证「后续一轮可
 * 重试成功」；缓存注入值会让这条路径不可测（也就等于没被验证过）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentLoadError } from './errors';
import { createSdkLoader } from './load-once';
import { setAgentRuntimeForTesting } from './runtime';

const PACKAGE = '@aieval/fake-sdk';

afterEach(() => {
  setAgentRuntimeForTesting(null);
});

describe('createSdkLoader', () => {
  it('首次调用加载、之后复用同一个结果（load 只被调一次）', async () => {
    const load = vi.fn(async () => ({ ok: true }));
    const get = createSdkLoader(load, PACKAGE);
    const first = await get();
    const second = await get();
    expect(first).toBe(second);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('加载失败抛 AgentLoadError，文案点名包名与安装方式', async () => {
    const get = createSdkLoader(async () => {
      throw new Error('Cannot find module');
    }, PACKAGE);
    await expect(get()).rejects.toBeInstanceOf(AgentLoadError);
    await expect(get()).rejects.toThrow(PACKAGE);
    await expect(get()).rejects.toThrow('pnpm add');
  });

  it('失败不被缓存：第二次调用会重试，成功后可用（「后续一轮可重试成功」）', async () => {
    let attempt = 0;
    const get = createSdkLoader(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error('第一次抖动');
      return { attempt };
    }, PACKAGE);
    await expect(get()).rejects.toBeInstanceOf(AgentLoadError);
    await expect(get()).resolves.toEqual({ attempt: 2 });
  });

  it('注入的模块优先（不去碰真实包），且每次调用重新读取（可在同一进程里替换）', async () => {
    const load = vi.fn(async () => ({ source: 'real' }));
    const get = createSdkLoader(load, PACKAGE);
    setAgentRuntimeForTesting({ sdkModule: { [PACKAGE]: { source: 'fake-1' } } });
    await expect(get()).resolves.toEqual({ source: 'fake-1' });
    setAgentRuntimeForTesting({ sdkModule: { [PACKAGE]: { source: 'fake-2' } } });
    await expect(get()).resolves.toEqual({ source: 'fake-2' });
    expect(load).not.toHaveBeenCalled();
  });

  it('注入表里没有这个包名时走真实加载（三家互不影响）', async () => {
    const load = vi.fn(async () => ({ source: 'real' }));
    const get = createSdkLoader(load, PACKAGE);
    setAgentRuntimeForTesting({ sdkModule: { '@other/pkg': {} } });
    await expect(get()).resolves.toEqual({ source: 'real' });
    expect(load).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @aieval/agents test`
Expected: FAIL —— `Failed to resolve import "./load-once"`。

- [ ] **Step 3: 写 `src/load-once.ts`**

```ts
/**
 * 厂商 SDK 的懒加载外壳（spec §5.6.6 / A6）。
 * 三条语义，缺一条都不行：
 *  1. **函数作用域懒加载**：厂商包只在第一次真正用到时才 import——顶层静态导入会把「一家 SDK 故障」
 *     放大成「整包不可用」，一个智能体装坏了会导致全部智能体不可用；
 *  2. **只缓存成功的加载**：失败不缓存，一次镜像抖动不该毒化长驻服务的后续所有行；
 *  3. **注入优先**：`sdkModule` 里有该包名就直接用它（单测因此完全不碰真实包）。
 * packageName 是一等参数：它同时是测试注入表的**查表键**与错误文案里的包名。
 * 注意：注入值**不缓存**——测试要能在同一进程里换模块（见 load-once.test.ts 的用例说明）。
 */
import { AgentLoadError } from './errors';
import { getAgentRuntime } from './runtime';

export function createSdkLoader<T>(load: () => Promise<T>, packageName: string): () => Promise<T> {
  let cached: T | undefined;
  let cachedOk = false;

  return async (): Promise<T> => {
    const injected = injectedModule(packageName);
    if (injected !== undefined) return injected as T;
    if (cachedOk) return cached as T;
    try {
      const module = await load();
      cached = module;
      cachedOk = true;
      return module;
    } catch (cause) {
      // 不缓存失败：这里刻意不写 cachedOk = true
      throw new AgentLoadError(packageName, cause);
    }
  };
}

/** 从注入表里按包名取值；sdkModule 不是对象或没有该键时返回 undefined（走真实加载） */
function injectedModule(packageName: string): unknown {
  const { sdkModule } = getAgentRuntime();
  if (typeof sdkModule !== 'object' || sdkModule === null) return undefined;
  return (sdkModule as Record<string, unknown>)[packageName];
}
```

- [ ] **Step 4: 追加「厂商包不得静态导入」断言**

在 `src/static-assertions.test.ts` 的 `ENV_WRITE_PATTERNS` 常量之后追加：

```ts
/** 三家厂商包：只允许出现在动态 import() 与错误文案里 */
const VENDOR_PACKAGES = [
  '@anthropic-ai/claude-agent-sdk',
  '@openai/codex-sdk',
  '@deepseek-ai/dsh-sdk-client',
] as const;

/**
 * 顶层静态导入的写法：`import x from '@pkg'` / `import '@pkg'` / `import type { X } from '@pkg'`，
 * 以及同样会建立静态依赖的 `export … from '@pkg'`。
 * 必须带 `^\s*(import|export)\b` 锚定：否则注释里提到包名也会被误判（本仓注释里到处是包名）。
 */
function staticImportPattern(packageName: string): RegExp {
  return new RegExp(`^\\s*(import|export)\\b[^\\n]*['"]${packageName.replace(/[/@.]/g, '\\$&')}['"]`, 'm');
}
```

再追加一条用例（放在 `describe('源码级不变量', …)` 内）：

```ts
  it('厂商包只能动态 import（顶层静态导入会把「一家故障」放大成「整包不可用」，A6）', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      const text = readFileSync(join(import.meta.dirname, file), 'utf8');
      for (const packageName of VENDOR_PACKAGES) {
        if (staticImportPattern(packageName).test(text)) offenders.push(`${file}：静态导入 ${packageName}`);
      }
    }
    expect(offenders).toEqual([]);
  });
```

- [ ] **Step 5: 运行确认通过**

Run: `pnpm --filter @aieval/agents test`
Expected: PASS（`load-once` 5 例 + 静态断言 2 例）。

Run: `pnpm --filter @aieval/agents typecheck`
Expected: 通过。

- [ ] **Step 6: 变异验证（守卫：失败不缓存 + 厂商包静态导入）**

**守卫 A —— 只缓存成功的加载（Review Focus #4）**

1. `Get-FileHash packages/server/agents/src/load-once.ts -Algorithm SHA256`（记为 H-load）。
2. 变异体：在 `catch` 块里 `throw` 之前加一行 `cachedOk = true;`（把失败也缓存起来）。
3. Run: `pnpm --filter @aieval/agents test`；Expected: **FAIL**，`load-once.test.ts` 的「失败不被缓存」报 `expected undefined to deeply equal { attempt: 2 }`。
4. 删掉那一行，重跑：Expected: PASS；`Get-FileHash` 与 H-load 一致。

**守卫 B —— 厂商包不得顶层静态导入（A6）**

1. `Get-FileHash packages/server/agents/src/static-assertions.test.ts -Algorithm SHA256`（记为 H-static2）。
2. 变异体：在 `src/load-once.ts` 顶部加一行 `import '@openai/codex-sdk';`。
3. Run: `pnpm --filter @aieval/agents test`；Expected: **FAIL**，静态断言用例报 `offenders` 含 `load-once.ts：静态导入 @openai/codex-sdk`。
4. 删掉那一行，重跑：Expected: PASS；`Get-FileHash src/static-assertions.test.ts` 与 H-static2 一致，且 `src/load-once.ts` 回到 H-load。

- [ ] **Step 7: 提交**

```bash
git add packages/server/agents/src/load-once.ts packages/server/agents/src/load-once.test.ts packages/server/agents/src/static-assertions.test.ts
git commit -m "feat(agents): 厂商 SDK 懒加载外壳（只缓存成功的加载）与静态导入断言"
```

---

## Task 6: 三家共用的运行骨架 `runTurn`

**Files:**
- Create: `packages/server/agents/src/turn.ts`
- Create: `packages/server/agents/src/testing/agent-fixtures.ts`
- Create: `packages/server/agents/src/turn.test.ts`

**Interfaces:**
- Consumes: Task 3 的 `createEventEmitter` / `logDraft` / `AgentEventDraft` / `EventEmitter`、Task 4 的 `releaseTurn` / `RELEASE_GRACE_MS` / `classifyAgentFailure` / `AgentFailure`、Task 1 的 `AgentRunInput` / `AgentRunResult` / `AgentKind`
- Produces:
  - `interface TurnContext { input: AgentRunInput; controller: AbortController; emitter: EventEmitter }`
  - `interface TurnStart { stream: AsyncIterable<unknown>; interrupt: () => void; dispose: () => Promise<void>; project: (raw: unknown, state: TurnState) => TurnProjection }`
  - `interface TurnState { seen: Set<string>; turns: number }`
  - `interface TurnProjection { drafts: AgentEventDraft[]; tokens: { input: number; cached: number; output: number } | null; turns: number | null; failure: AgentFailure | null }`
  - `interface TurnHooks { kind: AgentKind; start: (context: TurnContext) => Promise<TurnStart> }`
  - `runTurn(input: AgentRunInput, hooks: TurnHooks): Promise<AgentRunResult>`
  - 测试支撑（只在 `src/testing/` 内）：`FakeVendorRecorder`、`createRecorder`、`FakeStreamOptions`、`FakeStreamHandle`、`createFakeStream`、`createRunInput`、`collectEvents`、`settleWithFakeTimers`

- [ ] **Step 1: 写测试支撑 `src/testing/agent-fixtures.ts`**

```ts
/**
 * 测试用的假厂商件：单测「不碰真实 API、不碰真实 CLI」的全部物质基础。
 * 内容：
 *  1. FakeVendorRecorder：记录注入给厂商的对象、调用顺序与关闭次数；
 *  2. createFakeStream：可控的假事件流（可挂住、可被 stop() 提前结束；结束时记 'turn-end'）；
 *  3. createRunInput / collectEvents：AgentRunInput 工厂与事件收集器；
 *  4. settleWithFakeTimers：假定时器下推进时间直到 promise 落定。
 * 注意：本模块只被 *.test.ts import——里面的 vi 与假对象绝不进 `index.ts`。
 */
import type { AgentEvent } from '@aieval/contracts';
import { vi } from 'vitest';
import type { AgentRunInput } from '../types';

export interface FakeVendorRecorder {
  /** 调用顺序：'interrupt' / 'turn-end' / 'dispose'（释放顺序断言的全部可观测量） */
  order: string[];
  /** 厂商拿到的子进程环境（凭据隔离与注入落点的断言对象） */
  env: Record<string, string> | null;
  /** 厂商拿到的客户端 / 查询选项原文 */
  options: Record<string, unknown> | null;
  /** codex 的线程选项 */
  threadOptions: Record<string, unknown> | null;
  /** 送进去的提示词 */
  prompt: string | null;
  /** 运行时关闭次数（dispose 幂等的断言对象） */
  closeCount: number;
}

export function createRecorder(): FakeVendorRecorder {
  return { order: [], env: null, options: null, threadOptions: null, prompt: null, closeCount: 0 };
}

export interface FakeStreamOptions {
  /** 吐完事件后挂住，直到 stop()：用来测超时、终止与「适配器忽略停止信号」 */
  hang?: boolean;
  /** 吐完事件后抛出（模拟传输中断 / 进程非零退出） */
  throwAfterEvents?: unknown;
}

export interface FakeStreamHandle {
  iterable: AsyncIterable<unknown>;
  stop: () => void;
}

export function createFakeStream(
  events: readonly unknown[],
  recorder: FakeVendorRecorder,
  options: FakeStreamOptions = {},
): FakeStreamHandle {
  let stopped = false;
  let release: (() => void) | null = null;
  const stop = (): void => {
    stopped = true;
    release?.();
  };
  const iterable: AsyncIterable<unknown> = {
    async *[Symbol.asyncIterator]() {
      try {
        for (const event of events) {
          if (stopped) return;
          yield event;
        }
        if (options.throwAfterEvents !== undefined) throw options.throwAfterEvents;
        if (options.hang === true) {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
      } finally {
        // 流结束就是「在途 turn 终结」：释放顺序断言里的中间那一段
        recorder.order.push('turn-end');
      }
    },
  };
  return { iterable, stop };
}

/** AgentRunInput 的默认值工厂：各用例只覆盖自己关心的字段 */
export function createRunInput(overrides: Partial<AgentRunInput> = {}): AgentRunInput {
  return {
    cwd: 'D:/tmp/rows/row-1/workspace',
    configHome: 'D:/tmp/rows/row-1/.agenthome',
    prompt: '把 README 的标题改成「示例项目」，然后结束。',
    route: {
      protocolType: 'anthropic',
      baseUrl: 'https://gw.example.com/anthropic',
      apiKey: 'sk-test-key',
      modelId: 'test-model',
    },
    timeoutMs: 1_000,
    signal: new AbortController().signal,
    onEvent: () => {},
    ...overrides,
  };
}

/** 把事件收集进数组的 onEvent */
export function collectEvents(sink: AgentEvent[]): (event: AgentEvent) => void {
  return (event) => {
    sink.push(event);
  };
}

/**
 * 在假定时器下推进时间直到 promise 落定。
 * 为什么需要：假定时器会把 vitest 自己的超时也一起冻住，用例一旦真的挂住就永远不会失败；
 * 这里把「挂住」变成一次可读的断言失败。
 */
export async function settleWithFakeTimers<T>(
  promise: Promise<T>,
  options: { stepMs?: number; steps?: number } = {},
): Promise<T> {
  const stepMs = options.stepMs ?? 1_000;
  const steps = options.steps ?? 20;
  let done = false;
  void promise.then(
    () => {
      done = true;
    },
    () => {
      done = true;
    },
  );
  for (let index = 0; index < steps && !done; index += 1) {
    await vi.advanceTimersByTimeAsync(stepMs);
  }
  if (!done) throw new Error('假定时器推进后 promise 仍未落定：用例可能是真的挂住了');
  return promise;
}
```

- [ ] **Step 2: 写失败测试 `turn.test.ts`**

```ts
// @vitest-environment node
/**
 * 运行骨架：判定优先级、两段超时、释放顺序、dispose 幂等、永不抛。
 * 用**合成 hooks**（不经过任何厂商消息形状）测骨架：每条断言恰好对应一条规则；厂商特有的注入与
 * 投影由 Task 7–9 的用例覆盖。
 */
import type { AgentEvent } from '@aieval/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentLoadError } from './errors';
import { RELEASE_GRACE_MS } from './release';
import {
  collectEvents,
  createFakeStream,
  createRecorder,
  createRunInput,
  settleWithFakeTimers,
  type FakeVendorRecorder,
} from './testing/agent-fixtures';
import { runTurn, type TurnHooks, type TurnProjection } from './turn';

interface Harness {
  hooks: TurnHooks;
  recorder: FakeVendorRecorder;
  stats: { startCount: number; disposeCount: number };
}

/** 造一套合成 hooks：事件流可挂住、interrupt 可合作也可忽略、start 可直接抛 */
function createHarness(
  options: {
    events?: readonly unknown[];
    /** 'stop'（默认，合作）| 'ignore'（忽略停止信号：dsh 与非合作 CLI 的真实形状） */
    interrupt?: 'stop' | 'ignore';
    hang?: boolean;
    streamError?: unknown;
    startError?: unknown;
    projection?: TurnProjection;
  } = {},
): Harness {
  const recorder = createRecorder();
  const stats = { startCount: 0, disposeCount: 0 };
  const hooks: TurnHooks = {
    kind: 'claude-code',
    start: async (context) => {
      stats.startCount += 1;
      if (options.startError !== undefined) throw options.startError;
      const stream = createFakeStream(options.events ?? [], recorder, {
        hang: options.hang === true,
        throwAfterEvents: options.streamError,
      });
      // 厂商 SDK 的硬中止入口（真实适配器把 controller 交给 SDK，这里用 abort 事件代表它）
      context.controller.signal.addEventListener('abort', () => stream.stop(), { once: true });
      return {
        stream: stream.iterable,
        interrupt: () => {
          recorder.order.push('interrupt');
          if (options.interrupt !== 'ignore') stream.stop();
        },
        dispose: async () => {
          stats.disposeCount += 1;
          recorder.order.push('dispose');
          stream.stop();
        },
        project: () => options.projection ?? { drafts: [], tokens: null, turns: null, failure: null },
      };
    },
  };
  return { hooks, recorder, stats };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('runTurn', () => {
  it('正常完成：ok + completed，tokens 与 turns 同时在才发 usage 事件', async () => {
    const events: AgentEvent[] = [];
    const harness = createHarness({
      events: [{ kind: 'message' }],
      projection: { drafts: [], tokens: { input: 10, cached: 2, output: 5 }, turns: 3, failure: null },
    });
    const result = await runTurn(createRunInput({ onEvent: collectEvents(events) }), harness.hooks);
    expect(result).toMatchObject({
      ok: true,
      exitReason: 'completed',
      tokens: { input: 10, cached: 2, output: 5 },
      turns: 3,
    });
    expect(events.filter((event) => event.type === 'usage')).toHaveLength(1);
    // 正常出口也要释放（§5.6.5：所有出口一个都不能漏）
    expect(harness.stats.disposeCount).toBe(1);
  });

  it('内层超时：顺序为 interrupt → turn 终结 → dispose，结果为 timed-out（§5.6.5）', async () => {
    vi.useFakeTimers();
    const harness = createHarness({ hang: true });
    const promise = runTurn(createRunInput({ timeoutMs: 1_000 }), harness.hooks);
    const result = await settleWithFakeTimers(promise, { stepMs: 500, steps: 10 });
    expect(result.exitReason).toBe('timed-out');
    expect(result.error?.code).toBe('AGENT_TIMED_OUT');
    expect(harness.recorder.order).toEqual(['interrupt', 'turn-end', 'dispose']);
  });

  it('适配器忽略 interrupt：5 秒后落 WARN 并强制释放，运行仍在有限时间内结束（Review Focus #3）', async () => {
    // 常量值本身也要钉住（p3 T3/T4 的实现者上报的缺口）：本用例走的是假定时器 + 默认 graceMs，
    // 若有人把 RELEASE_GRACE_MS 从 5_000 改成别的值，这一格必须红——所以除行为断言外，
    // 再直接断言常量值（`RELEASE_GRACE_MS === 5_000`，见本用例末尾）。只验 `graceMs` 覆盖参数
    // 是**测不到常量本身**的：那一路根本不读常量。
    expect(RELEASE_GRACE_MS).toBe(5_000);
    vi.useFakeTimers();
    const events: AgentEvent[] = [];
    const harness = createHarness({ interrupt: 'ignore', hang: true });
    const promise = runTurn(createRunInput({ timeoutMs: 1_000, onEvent: collectEvents(events) }), harness.hooks);
    const result = await settleWithFakeTimers(promise, { stepMs: 1_000, steps: 10 });
    expect(result.exitReason).toBe('timed-out');
    expect(harness.stats.disposeCount).toBe(1);
    // 非合作适配器的真实形状：interrupt 无人响应 → 第二段强制 dispose → 流这才结束
    expect(harness.recorder.order).toEqual(['interrupt', 'dispose', 'turn-end']);
    const warns = events.filter((event) => event.type === 'log' && event.text.includes('[WARN]'));
    expect(warns).toHaveLength(1);
    expect(warns[0]?.type === 'log' ? warns[0].text : '').toContain(`${RELEASE_GRACE_MS / 1000} 秒`);
  });

  it('signal 已中止优先于自身超时：结果为 canceled（§5.6.5 的判定优先级）', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const harness = createHarness({ interrupt: 'ignore', hang: true });
    const promise = runTurn(createRunInput({ timeoutMs: 1_000, signal: controller.signal }), harness.hooks);
    await vi.advanceTimersByTimeAsync(400);
    controller.abort(); // 用户终止
    const result = await settleWithFakeTimers(promise, { stepMs: 1_000, steps: 10 }); // 其间内层超时也会到期
    expect(result.exitReason).toBe('canceled');
    expect(result.error?.code).toBe('AGENT_CANCELED');
  });

  it('终止与超时先后触发也只 dispose 一次（幂等）', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const harness = createHarness({ interrupt: 'ignore', hang: true });
    const promise = runTurn(createRunInput({ timeoutMs: 1_000, signal: controller.signal }), harness.hooks);
    await vi.advanceTimersByTimeAsync(200);
    controller.abort();
    await settleWithFakeTimers(promise, { stepMs: 1_000, steps: 10 });
    expect(harness.stats.disposeCount).toBe(1);
    expect(harness.recorder.order.filter((entry) => entry === 'dispose')).toHaveLength(1);
  });

  it('启动前已中止：不建任何运行时（start 一次都不调用），结果为 canceled', async () => {
    const controller = new AbortController();
    controller.abort();
    const harness = createHarness();
    const result = await runTurn(createRunInput({ signal: controller.signal }), harness.hooks);
    expect(result.exitReason).toBe('canceled');
    expect(result.error?.code).toBe('AGENT_CANCELED');
    expect(harness.stats.startCount).toBe(0);
    expect(harness.recorder.order).toEqual([]);
  });

  it('加载失败折进结果（AGENT_LOAD_FAILED）且 run 不抛', async () => {
    const harness = createHarness({
      startError: new AgentLoadError('@openai/codex-sdk', new Error('Cannot find module')),
    });
    const result = await runTurn(createRunInput(), harness.hooks);
    expect(result).toMatchObject({ ok: false, exitReason: 'error' });
    expect(result.error?.code).toBe('AGENT_LOAD_FAILED');
    expect(result.error?.message).toContain('@openai/codex-sdk');
    expect(result.error?.message).toContain('pnpm add');
    // start 阶段就失败：没有任何在途 turn 与客户端，因此没有释放顺序可言（也不会产生孤儿）
    expect(harness.stats.startCount).toBe(1);
    expect(harness.recorder.order).toEqual([]);
  });

  it('事件流抛错：exitReason error + AGENT_FAILED，错误事件落到 onEvent，run 不抛', async () => {
    const events: AgentEvent[] = [];
    const harness = createHarness({ events: [], streamError: new Error('spawn codex ENOENT') });
    const result = await runTurn(createRunInput({ onEvent: collectEvents(events) }), harness.hooks);
    expect(result).toMatchObject({ ok: false, exitReason: 'error' });
    expect(result.error?.code).toBe('AGENT_FAILED');
    expect(result.error?.message).toContain('ENOENT');
    expect(events.some((event) => event.type === 'error')).toBe(true);
    expect(harness.stats.disposeCount).toBe(1);
  });
});
```

- [ ] **Step 3: 运行确认失败**

Run: `pnpm --filter @aieval/agents test`
Expected: FAIL —— `Failed to resolve import "./turn"`。

- [ ] **Step 4: 写 `src/turn.ts`**

```ts
/**
 * 三家共用的运行骨架：注入 → 消费事件流 → 释放 → 组装结果。
 * 为什么集中一处：释放顺序（§5.6.5）、两段超时、判定优先级（signal 已中止 → canceled；自身超时 →
 * timed-out；其余按实际结果）三家必须逐字一致——抄三遍必然漂移，而这三件事出错时都表现为
 * 「偶发卡住 / 状态对不上」，是最难查的一类问题。厂商差异全部通过 hooks 注入。
 * 注意：本函数**不抛**——所有失败都折进 AgentRunResult.error（§5.6.6 的错误码需要承载处），
 * 编排层因此不需要给每一行套 try/catch。
 */
import { createLogger } from '@aieval/core';
import { createEventEmitter, logDraft, type AgentEventDraft, type EventEmitter } from './emit';
import { classifyAgentFailure, type AgentFailure } from './errors';
import { releaseTurn, RELEASE_GRACE_MS } from './release';
import type { AgentKind, AgentRunInput, AgentRunResult } from './types';

export interface TurnContext {
  input: AgentRunInput;
  /** 骨架持有的中止入口：厂商 SDK 需要它硬中止（claude 的 abortController / codex 的 signal） */
  controller: AbortController;
  emitter: EventEmitter;
}

/** 一次运行的消费句柄：各家 start() 造出来，骨架负责按固定顺序使用并保证一定会释放 */
export interface TurnStart {
  /** 在途消息流；迭代结束即「在途 turn 终结」 */
  stream: AsyncIterable<unknown>;
  /** 发停止信号；允许空实现（dsh 的 cancelMidTurn 为 false） */
  interrupt: () => void;
  /** 硬回收：必须幂等（用 createDisposer 包一层最省事） */
  dispose: () => Promise<void>;
  /** 投影一条原始消息；state 由骨架维护并传给每一家 */
  project: (raw: unknown, state: TurnState) => TurnProjection;
}

/** 骨架维护的跨消息状态 */
export interface TurnState {
  /** 已见过的厂商消息 id：唯一允许丢弃的事件是**重复事件**（§5.6.3） */
  seen: Set<string>;
  /** 已累计的轮次（codex 数 turn.completed；claude-code 直接用 result.num_turns 覆盖） */
  turns: number;
}

export interface TurnProjection {
  /** 本条消息要发出去的事件（空数组 = 纯重复事件，唯一允许丢弃的一类） */
  drafts: AgentEventDraft[];
  /** 本条消息采到的计量；未采到为 null（**不是 0**） */
  tokens: { input: number; cached: number; output: number } | null;
  /** 本条消息给出的轮次总数；未给出为 null */
  turns: number | null;
  /** 本条消息是否表示失败 */
  failure: AgentFailure | null;
}

export interface TurnHooks {
  kind: AgentKind;
  /** 建运行时并返回消费句柄；抛错由骨架折进结果（加载失败 → AGENT_LOAD_FAILED） */
  start: (context: TurnContext) => Promise<TurnStart>;
}

export async function runTurn(input: AgentRunInput, hooks: TurnHooks): Promise<AgentRunResult> {
  const startedAt = Date.now();
  const emitter = createEventEmitter(input.onEvent);
  const logger = createLogger(`agents/${hooks.kind}`);

  // 进入即已中止：不建任何运行时，直接给 canceled（否则会「起了再杀」，白跑一次冷启动）
  if (input.signal.aborted) {
    emitter.emit(logDraft('stderr', '[WARN] 该行在启动前已被终止，本次运行未启动任何智能体进程'));
    return {
      ok: false,
      exitReason: 'canceled',
      tokens: null,
      turns: null,
      durationMs: 0,
      error: { code: 'AGENT_CANCELED', message: '该行在启动前已被终止' },
    };
  }

  const controller = new AbortController();
  const state: TurnState = { seen: new Set(), turns: 0 };
  let handle: TurnStart | undefined;
  let release: Promise<{ disposeError: unknown | null }> | undefined;
  let stopRequested = false;
  let selfTimedOut = false;
  let failure: AgentFailure | null = null;
  let tokens: AgentRunResult['tokens'] = null;
  let turns: number | null = null;

  let settleTurn: () => void = () => {};
  const turnSettled = new Promise<void>((resolve) => {
    settleTurn = resolve;
  });

  // 第二段兜底的可见信号：既要进服务日志，也要进该行事件日志（界面上的日志抽屉看得到）
  const onGraceExceeded = (): void => {
    const text = `[WARN] ${hooks.kind} 在 ${RELEASE_GRACE_MS / 1000} 秒内未结束在途 turn，已强制释放运行时（该适配器不响应停止信号，属已知能力差异）`;
    logger.warn(text, { kind: hooks.kind });
    emitter.emit(logDraft('stderr', text));
  };

  // 释放只会跑一次：release 记忆化，因此「终止 + 超时同时到达」也只释放一次
  const triggerRelease = (): Promise<{ disposeError: unknown | null }> => {
    release ??= releaseTurn(
      {
        interrupt: () => {
          handle?.interrupt();
        },
        settled: turnSettled,
        dispose: async () => {
          await handle?.dispose();
        },
      },
      onGraceExceeded,
    );
    return release;
  };

  // 停止请求若在 start() 之前到达，只记下来：此时还没有「被关闭的对象」，提前释放会漏关随后建出的
  // 客户端——A7 要防的正是这条路径（守卫必须绑定对象）
  const requestStop = (): void => {
    stopRequested = true;
    if (handle !== undefined) void triggerRelease();
  };
  const onAbort = (): void => requestStop();

  input.signal.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => {
    selfTimedOut = true;
    requestStop();
  }, input.timeoutMs);

  try {
    const started = await hooks.start({ input, controller, emitter });
    handle = started;
    if (stopRequested) requestStop();
    logger.debug('适配器已启动，开始消费事件流', {
      kind: hooks.kind,
      cwd: input.cwd,
      model: input.route.modelId,
    });
    for await (const raw of started.stream) {
      const projection = started.project(raw, state);
      for (const draft of projection.drafts) emitter.emit(draft);
      if (projection.turns !== null) turns = projection.turns;
      if (projection.tokens !== null) {
        tokens = projection.tokens;
        // usage 事件要求 tokens 与 turns 同时在（§7.4）；缺 turns 时只更新结果值，不发明一个 0
        if (turns !== null) emitter.emit({ type: 'usage', tokens: projection.tokens, turns });
      }
      if (projection.failure !== null) failure = projection.failure;
    }
  } catch (cause) {
    if (stopRequested) {
      // 停止请求引发的流中断不是失败：结论由 canceled / timed-out 通路给出（§5.6.5 的判定优先级）
      logger.debug('事件流因停止请求结束', { kind: hooks.kind, error: cause });
    } else {
      failure = classifyAgentFailure(cause, { kind: hooks.kind, baseUrl: input.route.baseUrl });
      logger.error('适配器运行失败', { kind: hooks.kind, code: failure.code, error: cause });
    }
  } finally {
    clearTimeout(timer);
    input.signal.removeEventListener('abort', onAbort);
    // 「终结在途 turn」：释放序列的第二段落在这里（适配器自己的 finally 清理完成）
    settleTurn();
    const report = await triggerRelease();
    if (report.disposeError !== null) {
      logger.error('释放运行时失败（已忽略，避免掩盖本次运行的结论）', { error: report.disposeError });
    }
  }

  const result = assembleResult({
    startedAt,
    timeoutMs: input.timeoutMs,
    canceled: input.signal.aborted,
    selfTimedOut,
    failure,
    tokens,
    turns,
    emitter,
  });
  logger.info('适配器运行结束', {
    kind: hooks.kind,
    exitReason: result.exitReason,
    durationMs: result.durationMs,
    turns: result.turns,
    metered: result.tokens !== null,
  });
  return result;
}

/**
 * 组装结果。判定优先级固定（§5.6.5）：signal 已中止 → canceled；自身超时 → timed-out；其余按实际结果。
 * 为什么 canceled 排在最前：终止与超时会同时触发，两边都声称是自己导致的就会变成竞态；`signal` 是
 * 唯一能表达「外部要求停止」的输入，故以它为准。`exitReason` 与 `error.code` 刻意不同名（§5.6.6）：
 * 前者是给编排层的分类信号，后者是写给用户看的归因。
 */
function assembleResult(input: {
  startedAt: number;
  timeoutMs: number;
  canceled: boolean;
  selfTimedOut: boolean;
  failure: AgentFailure | null;
  tokens: AgentRunResult['tokens'];
  turns: number | null;
  emitter: EventEmitter;
}): AgentRunResult {
  const durationMs = Date.now() - input.startedAt;
  const base = { tokens: input.tokens, turns: input.turns, durationMs };
  if (input.canceled) {
    input.emitter.emit(logDraft('stderr', '[WARN] 该行已被终止：适配器已停止并释放运行时'));
    return {
      ok: false,
      exitReason: 'canceled',
      ...base,
      error: { code: 'AGENT_CANCELED', message: '该行已被用户终止' },
    };
  }
  if (input.selfTimedOut) {
    // 刻意**不打** `[WARN]` 前缀（p3 Task 5/T6 的实现者实测上报并修正了本计划的自身矛盾）：
    // 本条是「结论摘要」，而这次超时真正的 WARN 是释放路径那条（`onGraceExceeded` 的
    // 「N 秒内未结束在途 turn」）。两条都带 `[WARN]` 会让 Task 6 自己的用例
    // `expect(warns).toHaveLength(1)` 不成立——那串必须唯一的告警文案里含「5 秒」，
    // 只可能来自释放路径。用户可见文案与 logger 级别一字未改（服务侧仍按 WARN 记）。
    input.emitter.emit(logDraft('stderr', `该行超过 ${input.timeoutMs} 毫秒的运行上限，已强制释放运行时`));
    return {
      ok: false,
      exitReason: 'timed-out',
      ...base,
      error: {
        code: 'AGENT_TIMED_OUT',
        message: `超过本次运行的时间上限（${input.timeoutMs} 毫秒），已强制释放`,
      },
    };
  }
  if (input.failure !== null) {
    input.emitter.emit({ type: 'error', message: input.failure.message, stack: input.failure.stack });
    return { ok: false, exitReason: 'error', ...base, error: input.failure };
  }
  return { ok: true, exitReason: 'completed', ...base };
}
```

- [ ] **Step 5: 运行确认通过**

Run: `pnpm --filter @aieval/agents test`
Expected: PASS（`turn.test.ts` 8 例）。

Run: `pnpm --filter @aieval/agents typecheck`
Expected: 通过。

- [ ] **Step 6: 变异验证（守卫：判定优先级 + 第二段兜底）**

**守卫 A —— 判定优先级（§5.6.5）**

1. `Get-FileHash packages/server/agents/src/turn.ts -Algorithm SHA256`（记为 H-turn）。
2. 变异体：把 `assembleResult` 里 `if (input.canceled)` 那一段整块删掉（取消不再优先，用户终止会被判成 `timed-out`）。
3. Run: `pnpm --filter @aieval/agents test`；Expected: **FAIL**，`turn.test.ts` 的「signal 已中止优先于自身超时」报 `expected 'timed-out' to be 'canceled'`。
4. 还原，重跑：Expected: PASS；`Get-FileHash` 与 H-turn 一致。

**守卫 B —— 第二段兜底必须落可见 WARN（Review Focus #3）**

1. `Get-FileHash packages/server/agents/src/turn.ts -Algorithm SHA256`（记为 H-turn2）。
2. 变异体：把 `onGraceExceeded` 的 `emitter.emit(logDraft('stderr', text));` 删掉（只留 logger，界面上看不见）。
3. Run: `pnpm --filter @aieval/agents test`；Expected: **FAIL**，`turn.test.ts` 的「适配器忽略 interrupt」报 `expected [] to have a length of 1`（找不到 `[WARN]` 事件）。
4. 还原，重跑：Expected: PASS；`Get-FileHash` 与 H-turn2 一致。

- [ ] **Step 7: 提交**

```bash
git add packages/server/agents/src/turn.ts packages/server/agents/src/turn.test.ts packages/server/agents/src/testing/agent-fixtures.ts
git commit -m "feat(agents): 三家共用的运行骨架（两段超时、释放顺序、判定优先级、永不抛）"
```

---

## Task 7: `claude-code` 适配器

**Files:**
- Create: `packages/server/agents/src/providers/claude-code/sdk.ts`
- Create: `packages/server/agents/src/providers/claude-code/events.ts`
- Create: `packages/server/agents/src/providers/claude-code/index.ts`
- Create: `packages/server/agents/src/providers/claude-code/events.test.ts`
- Create: `packages/server/agents/src/providers/claude-code/index.test.ts`
- Modify: `packages/server/agents/src/testing/agent-fixtures.ts`（追加 `FakeClaudeSdkOptions` / `createFakeClaudeSdk`）

**Interfaces:**
- Consumes: Task 3 的 `buildSubprocessEnv` / `stripV1Suffix` / `logDraft` / `safeStringify` / `unknownEventDraft`、Task 4 的 `createDisposer` / `classifyAgentMessage`、Task 5 的 `createSdkLoader`、Task 6 的 `runTurn` / `TurnStart` / `TurnProjection` / `TurnState`
- Produces: `CLAUDE_PACKAGE_NAME`、`ClaudeMessage`、`ClaudeQuery`、`ClaudeQueryOptions`、`ClaudeSdkModule`、`loadClaudeSdk`、`projectClaudeMessage`、`claudeCodeProvider: AgentProvider`（`kind: 'claude-code'`、`displayName: 'Claude Code'`、`protocolType: 'anthropic'`、`cancelMidTurn: true`、`usage: true`、`isolation: 'subprocess'`）

- [ ] **Step 1: 追加假 SDK 到 `src/testing/agent-fixtures.ts`**

```ts
export interface FakeClaudeSdkOptions {
  recorder: FakeVendorRecorder;
  /** 本次运行要吐出的消息（按顺序） */
  events: readonly unknown[];
  /** 'stop'（默认，合作）| 'ignore'（忽略停止信号，模拟非合作适配器） */
  interrupt?: 'stop' | 'ignore';
  /** 吐完消息后挂住，直到被停止（测超时与终止） */
  hang?: boolean;
  /** 吐完消息后抛出（模拟进程非零退出） */
  throwAfterEvents?: unknown;
}

/** 假的 `@anthropic-ai/claude-agent-sdk`：形状与 sdk.ts 的自声明窄结构一致 */
export function createFakeClaudeSdk(options: FakeClaudeSdkOptions): unknown {
  const { recorder } = options;
  return {
    query: (params: { prompt: string; options: Record<string, unknown> }): unknown => {
      recorder.prompt = params.prompt;
      recorder.options = params.options;
      recorder.env = params.options.env as Record<string, string>;
      const controller = params.options.abortController as AbortController;
      const stream = createFakeStream(options.events, recorder, {
        hang: options.hang === true,
        throwAfterEvents: options.throwAfterEvents,
      });
      // 真实适配器用 controller.abort() 做 dispose，故 abort 就是「硬回收已经发生」的可观测量
      controller.signal.addEventListener(
        'abort',
        () => {
          recorder.order.push('dispose');
          stream.stop();
        },
        { once: true },
      );
      return {
        [Symbol.asyncIterator]: () => stream.iterable[Symbol.asyncIterator](),
        interrupt: (): void => {
          recorder.order.push('interrupt');
          if (options.interrupt !== 'ignore') stream.stop();
        },
      };
    },
  };
}
```

- [ ] **Step 2: 写失败测试 `providers/claude-code/events.test.ts`**

```ts
// @vitest-environment node
/**
 * claude-code 的消息投影：计量三项齐全才有值、缺项 → null + WARN、重复丢弃、未识别保留。
 * 这里的两条断言（未识别不丢失 / 缺失得 null）是本计划的核心守卫，必须逐字按 spec §5.6.3 的措辞验。
 */
import { describe, expect, it } from 'vitest';
import type { TurnState } from '../../turn';
import { projectClaudeMessage } from './events';

const CONTEXT = { kind: 'claude-code', baseUrl: 'https://gw.example.com/anthropic' } as const;

/** 每个用例一份新状态：seen / turns 是同一次 run 内的累计量 */
function newState(): TurnState {
  return { seen: new Set(), turns: 0 };
}

describe('projectClaudeMessage：result 与计量', () => {
  it('三项齐全时取数值（cached 取 cache_read_input_tokens）', () => {
    const projection = projectClaudeMessage(
      {
        type: 'result',
        subtype: 'success',
        uuid: 'r1',
        result: '任务完成',
        num_turns: 4,
        usage: { input_tokens: 120, cache_read_input_tokens: 30, output_tokens: 45 },
      },
      newState(),
      CONTEXT,
    );
    expect(projection.tokens).toEqual({ input: 120, cached: 30, output: 45 });
    expect(projection.turns).toBe(4);
    expect(projection.failure).toBeNull();
    expect(projection.drafts.some((draft) => draft.type === 'log' && draft.text === '任务完成')).toBe(true);
  });

  it('usage 整个缺失 → tokens null（不是 0）', () => {
    const projection = projectClaudeMessage(
      { type: 'result', subtype: 'success', uuid: 'r2', result: '完成', num_turns: 2 },
      newState(),
      CONTEXT,
    );
    expect(projection.tokens).toBeNull();
    expect(projection.turns).toBe(2);
  });

  it('usage 缺一项 → tokens null，并落一条保留原始负载的 WARN（Review Focus #5）', () => {
    const projection = projectClaudeMessage(
      {
        type: 'result',
        uuid: 'r3',
        result: '完成',
        usage: { input_tokens: 120, output_tokens: 45 }, // 少了 cache_read_input_tokens
      },
      newState(),
      CONTEXT,
    );
    expect(projection.tokens).toBeNull();
    const warn = projection.drafts.find((draft) => draft.type === 'log' && draft.stream === 'stderr');
    const text = warn?.type === 'log' ? warn.text : '';
    expect(text).toContain('不填 0');
    expect(text).toContain('input_tokens'); // 原始负载保留下来了
  });

  it('is_error 的 result → failure，并且按文案归因', () => {
    const projection = projectClaudeMessage(
      { type: 'result', subtype: 'error_max_turns', uuid: 'r4', is_error: true, result: 'HTTP 429 too many requests' },
      newState(),
      CONTEXT,
    );
    expect(projection.failure?.code).toBe('RATE_LIMITED');
    expect(projection.drafts.some((draft) => draft.type === 'error')).toBe(true);
  });
});

describe('projectClaudeMessage：重复与未识别', () => {
  it('同一 uuid 只投影一次（唯一允许丢弃的一类）', () => {
    const state = newState();
    const message = { type: 'assistant', uuid: 'a1', message: { content: [{ type: 'text', text: 'hello' }] } };
    const first = projectClaudeMessage(message, state, CONTEXT);
    const second = projectClaudeMessage(message, state, CONTEXT);
    expect(first.drafts).toHaveLength(1);
    expect(second.drafts).toEqual([]);
  });

  it('未识别的 type 被投影成保留原始负载的日志事件（逐字段保留，不丢失）', () => {
    const payload = { type: 'future_thing', uuid: 'f1', payload: { nested: [1, 2], deep: { a: true } } };
    const projection = projectClaudeMessage(payload, newState(), CONTEXT);
    expect(projection.drafts).toHaveLength(1);
    const draft = projection.drafts[0];
    expect(JSON.parse(draft?.type === 'log' ? draft.text : '')).toEqual(payload);
  });

  it('assistant 的文本块与工具块都落盘（工具调用是候选行为的一部分）', () => {
    const projection = projectClaudeMessage(
      {
        type: 'assistant',
        uuid: 'a2',
        message: {
          content: [
            { type: 'text', text: '我来改文件' },
            { type: 'tool_use', id: 't1', name: 'Edit', input: { path: 'README.md' } },
          ],
        },
      },
      newState(),
      CONTEXT,
    );
    const texts = projection.drafts
      .filter((draft) => draft.type === 'log')
      .map((draft) => (draft.type === 'log' ? draft.text : ''));
    expect(texts[0]).toBe('我来改文件');
    expect(texts[1]).toContain('tool_use');
  });

  it('assistant 没有可读内容块时也保留原始负载（不产生空投影）', () => {
    const projection = projectClaudeMessage({ type: 'assistant', uuid: 'a3' }, newState(), CONTEXT);
    expect(projection.drafts).toHaveLength(1);
  });
});
```

- [ ] **Step 3: 写失败测试 `providers/claude-code/index.test.ts`**

```ts
// @vitest-environment node
/**
 * claude-code 适配器：注入落点、凭据隔离正反两面、事件贯通、超时释放顺序、加载降级。
 * 全部走假 SDK 注入 —— 单测不碰真实 CLI、不碰真实 API、不产生费用。
 */
import type { AgentEvent } from '@aieval/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setAgentRuntimeForTesting } from '../../runtime';
import {
  collectEvents,
  createFakeClaudeSdk,
  createRecorder,
  createRunInput,
  settleWithFakeTimers,
} from '../../testing/agent-fixtures';
import { claudeCodeProvider } from './index';
import { CLAUDE_PACKAGE_NAME } from './sdk';

afterEach(() => {
  setAgentRuntimeForTesting(null);
  vi.useRealTimers();
});

describe('claudeCodeProvider', () => {
  it('注入落点：baseUrl 拆掉尾部 /v1 进 ANTHROPIC_BASE_URL、模型进 options.model、cwd 与 settingSources 到位', async () => {
    const recorder = createRecorder();
    setAgentRuntimeForTesting({ sdkModule: { [CLAUDE_PACKAGE_NAME]: createFakeClaudeSdk({ recorder, events: [] }) } });
    await claudeCodeProvider.run(
      createRunInput({
        route: {
          protocolType: 'anthropic',
          baseUrl: 'https://gw.example.com/anthropic/v1/',
          apiKey: 'sk-claude',
          modelId: 'claude-x',
        },
      }),
    );
    expect(recorder.env?.ANTHROPIC_BASE_URL).toBe('https://gw.example.com/anthropic');
    expect(recorder.env?.ANTHROPIC_API_KEY).toBe('sk-claude');
    expect(recorder.env?.ANTHROPIC_AUTH_TOKEN).toBe('sk-claude');
    expect(recorder.env?.CLAUDE_CONFIG_DIR).toBe('D:/tmp/rows/row-1/.agenthome');
    expect(recorder.env?.HOME).toBe('D:/tmp/rows/row-1/.agenthome');
    expect(recorder.options?.model).toBe('claude-x');
    expect(recorder.options?.cwd).toBe('D:/tmp/rows/row-1/workspace');
    // 空数组不是可选优化：否则宿主 ~/.claude/settings.json 的 env 块会盖掉本次路由
    expect(recorder.options?.settingSources).toEqual([]);
  });

  it('凭据隔离：子进程拿到了密钥，宿主 process.env 一个字段都没变（Review Focus #2）', async () => {
    const before = { ...process.env };
    const recorder = createRecorder();
    setAgentRuntimeForTesting({ sdkModule: { [CLAUDE_PACKAGE_NAME]: createFakeClaudeSdk({ recorder, events: [] }) } });
    await claudeCodeProvider.run(createRunInput());
    expect(recorder.env?.ANTHROPIC_API_KEY).toBe('sk-test-key'); // 正面：子进程拿到了
    expect({ ...process.env }).toEqual(before); // 反面：宿主一个字段都没被写
  });

  it('事件贯通：消息流被投影成日志与 usage 事件，结果带回计量', async () => {
    const events: AgentEvent[] = [];
    const recorder = createRecorder();
    setAgentRuntimeForTesting({
      sdkModule: {
        [CLAUDE_PACKAGE_NAME]: createFakeClaudeSdk({
          recorder,
          events: [
            { type: 'system', subtype: 'init', uuid: 's1' },
            { type: 'assistant', uuid: 'a1', message: { content: [{ type: 'text', text: '改好了' }] } },
            {
              type: 'result',
              uuid: 'r1',
              result: '任务完成',
              num_turns: 2,
              usage: { input_tokens: 100, cache_read_input_tokens: 10, output_tokens: 20 },
            },
          ],
        }),
      },
    });
    const result = await claudeCodeProvider.run(createRunInput({ onEvent: collectEvents(events) }));
    expect(result).toMatchObject({
      ok: true,
      exitReason: 'completed',
      tokens: { input: 100, cached: 10, output: 20 },
      turns: 2,
    });
    expect(events.filter((event) => event.type === 'usage')).toHaveLength(1);
    expect(events.some((event) => event.type === 'log' && event.text.includes('改好了'))).toBe(true);
    expect(events[0]?.seq).toBe(1); // run 内 seq 从 1 开始
  });

  it('内层超时：顺序为 interrupt → turn 终结 → dispose（§5.6.5）', async () => {
    vi.useFakeTimers();
    const recorder = createRecorder();
    setAgentRuntimeForTesting({
      sdkModule: { [CLAUDE_PACKAGE_NAME]: createFakeClaudeSdk({ recorder, events: [], hang: true }) },
    });
    const promise = claudeCodeProvider.run(createRunInput({ timeoutMs: 1_000 }));
    const result = await settleWithFakeTimers(promise, { stepMs: 500, steps: 10 });
    expect(result.exitReason).toBe('timed-out');
    expect(recorder.order).toEqual(['interrupt', 'turn-end', 'dispose']);
  });

  it('厂商包缺失或形状不对：AGENT_LOAD_FAILED 且文案含包名与安装方式；同一进程内后续一轮可重试成功（Review Focus #4）', async () => {
    setAgentRuntimeForTesting({ sdkModule: { [CLAUDE_PACKAGE_NAME]: {} } });
    const first = await claudeCodeProvider.run(createRunInput());
    expect(first).toMatchObject({ ok: false, exitReason: 'error' });
    expect(first.error?.code).toBe('AGENT_LOAD_FAILED');
    expect(first.error?.message).toContain(CLAUDE_PACKAGE_NAME);
    expect(first.error?.message).toContain('pnpm add');

    const recorder = createRecorder();
    setAgentRuntimeForTesting({ sdkModule: { [CLAUDE_PACKAGE_NAME]: createFakeClaudeSdk({ recorder, events: [] }) } });
    const second = await claudeCodeProvider.run(createRunInput());
    expect(second.ok).toBe(true);
  });
});
```

（「只有该家失败、其余两家不受影响」这条跨家断言放在 Task 10 的注册表用例里——那时三家 provider 都在了。）

- [ ] **Step 4: 运行确认失败**

Run: `pnpm --filter @aieval/agents test`
Expected: FAIL —— `Failed to resolve import "./events"` / `"./index"` / `"./sdk"`。

- [ ] **Step 5: 写 `providers/claude-code/sdk.ts`**

```ts
/**
 * claude-code 的厂商 SDK 懒加载外壳。
 * 本文件是**唯一**知道 `@anthropic-ai/claude-agent-sdk` 入口形状的地方：窄结构在这里自定义、
 * 不从厂商包 import type（§5.6.2 末段），于是厂商的类型变更打不到本仓的 typecheck。
 * 注意：`import()` 必须是动态的——顶层静态导入会把「一家 SDK 故障」放大成「整包不可用」（A6）；
 * 字段名以真实事件探测的 dump 为准（§5.6.3，探测回写任务按实测修正本文件）。
 */
import { AgentLoadError } from '../../errors';
import { createSdkLoader } from '../../load-once';

export const CLAUDE_PACKAGE_NAME = '@anthropic-ai/claude-agent-sdk';

export interface ClaudeQueryOptions {
  cwd: string;
  env: Record<string, string>;
  model: string;
  /** 必须是空数组：否则 ~/.claude/settings.json 的 env 块会盖掉本次路由（§5.6.4） */
  settingSources: string[];
  /** 硬中止入口：dispose 时 abort，SDK 据此杀掉仍在跑的子进程 */
  abortController: AbortController;
  maxTurns: number;
}

export interface ClaudeQuery extends AsyncIterable<ClaudeMessage> {
  /** 优雅停止：结束在途 turn（不是 kill 进程） */
  interrupt?: () => unknown;
}

export interface ClaudeMessage {
  type: string;
  [key: string]: unknown;
}

export interface ClaudeSdkModule {
  query: (params: { prompt: string; options: ClaudeQueryOptions }) => ClaudeQuery;
}

const loadRaw = createSdkLoader<unknown>(
  async () => import('@anthropic-ai/claude-agent-sdk'),
  CLAUDE_PACKAGE_NAME,
);

/** 懒加载 + 形状校验：形状不对与「包没装」归为同一类（AGENT_LOAD_FAILED），文案点名包名 */
export async function loadClaudeSdk(): Promise<ClaudeSdkModule> {
  const raw = await loadRaw();
  if (typeof (raw as { query?: unknown }).query !== 'function') {
    throw new AgentLoadError(CLAUDE_PACKAGE_NAME, new Error('模块缺少 query 导出'));
  }
  return raw as ClaudeSdkModule;
}
```

- [ ] **Step 6: 写 `providers/claude-code/events.ts`**

```ts
/**
 * claude-code 的消息投影（§5.6.3）。
 * 规则：
 *  1. 唯一允许丢弃的是**重复消息**：同一 `uuid` 只投影一次（SDK 重放 / 续传会给重复）；
 *  2. 其余任何消息（含未识别的 type）都必须落成**保留原始负载**的日志事件，不得静默丢弃；
 *  3. 计量只在 `result` 消息上取（§5.6.3 表）：`usage.input_tokens` /
 *     `usage.cache_read_input_tokens` / `usage.output_tokens` **三项齐了才有值**；缺一项就是
 *     「没采到」→ null 并落一条 WARN，绝不填 0（0 会让人得出「这家很省」的错误结论）。
 * 注意：字段名以真实事件探测的 dump 为准；探测回写任务按实测修正本文件。
 */
import { logDraft, safeStringify, unknownEventDraft, type AgentEventDraft } from '../../emit';
import { classifyAgentMessage, type FailureContext } from '../../errors';
import { asRecord, readNumber, readString } from '../../json';
import type { TurnProjection, TurnState } from '../../turn';

export function projectClaudeMessage(raw: unknown, state: TurnState, context: FailureContext): TurnProjection {
  const message = asRecord(raw);
  const uuid = readString(message, 'uuid');
  // 重复消息：唯一允许丢弃的一类
  if (uuid !== null) {
    if (state.seen.has(uuid)) return emptyProjection();
    state.seen.add(uuid);
  }
  const type = readString(message, 'type') ?? 'unknown';
  if (type === 'result') return projectResult(message, context);
  if (type === 'assistant') {
    return { drafts: assistantDrafts(message, raw), tokens: null, turns: null, failure: null };
  }
  // system / user / 未来新增的类型：一律保留原始负载（§5.6.3）
  return { drafts: [unknownEventDraft(raw)], tokens: null, turns: null, failure: null };
}

/** `result` 消息：最终答复进日志、计量与轮次取数值、is_error 归因成失败 */
function projectResult(message: Record<string, unknown> | null, context: FailureContext): TurnProjection {
  const drafts: AgentEventDraft[] = [];
  const text = readString(message, 'result');
  if (text !== null && text !== '') drafts.push(logDraft('stdout', text));
  const tokens = readTokens(message?.usage, drafts);
  const turns = readNumber(message, 'num_turns');
  if (message?.is_error !== true) {
    return { drafts, tokens, turns, failure: null };
  }
  const failureText = text ?? `claude-code 返回失败结果（subtype: ${readString(message, 'subtype') ?? 'unknown'}）`;
  drafts.push({ type: 'error', message: failureText });
  return { drafts, tokens, turns, failure: classifyAgentMessage(failureText, context) };
}

/** assistant 消息：文本块进日志、工具与推理块原样落盘（落盘但不必解析，§5.6.3） */
function assistantDrafts(message: Record<string, unknown> | null, raw: unknown): AgentEventDraft[] {
  const drafts: AgentEventDraft[] = [];
  const blocks = readContentBlocks(message);
  const texts = blocks.map(textOfBlock).filter((text): text is string => text !== null);
  if (texts.length > 0) drafts.push(logDraft('stdout', texts.join('\n')));
  const others = blocks.filter((block) => textOfBlock(block) === null);
  if (others.length > 0) drafts.push(logDraft('stdout', safeStringify(others)));
  // 没有任何内容块（纯 metadata 消息）：也要保留原始负载，不能产生空投影
  if (drafts.length === 0) drafts.push(unknownEventDraft(raw));
  return drafts;
}

/** 取 assistant 消息的内容块数组；形状不对时给空数组（后续会把原始负载整段落盘） */
function readContentBlocks(message: Record<string, unknown> | null): unknown[] {
  const payload = asRecord(message?.message);
  const content = payload?.content;
  return Array.isArray(content) ? content : [];
}

/** 文本块 → 文本；非文本块返回 null（工具调用 / 推理块） */
function textOfBlock(block: unknown): string | null {
  const record = asRecord(block);
  if (record === null) return null;
  return record.type === 'text' && typeof record.text === 'string' ? record.text : null;
}

/**
 * 取用量三元组：三项齐了才认。
 * cached 的语义是**缓存读**（`cache_read_input_tokens`）：缓存写（`cache_creation_input_tokens`）
 * 不计入——spec §5.6.3 的表写的是「输入 / 缓存读 / 输出」。
 */
function readTokens(
  usage: unknown,
  drafts: AgentEventDraft[],
): { input: number; cached: number; output: number } | null {
  const record = asRecord(usage);
  if (record === null) return null;
  const input = readNumber(record, 'input_tokens');
  const cached = readNumber(record, 'cache_read_input_tokens');
  const output = readNumber(record, 'output_tokens');
  if (input === null || cached === null || output === null) {
    drafts.push(
      logDraft('stderr', `[WARN] 用量负载不完整，本次运行按「未采集计量」处理（不填 0）：${safeStringify(usage)}`),
    );
    return null;
  }
  return { input, cached, output };
}

/** 空投影：本条消息不产出任何事件（纯重复事件，唯一允许丢弃的一类） */
function emptyProjection(): TurnProjection {
  return { drafts: [], tokens: null, turns: null, failure: null };
}
```

- [ ] **Step 7: 写 `providers/claude-code/index.ts`**

```ts
/**
 * claude-code 适配器：注入路由 → 消费消息流 → 按 §5.6.5 释放。
 * 注意：
 *  - `run()` 的骨架由 `runTurn` 提供，本文件只负责厂商特有的三件事：注入、拿停止句柄、投影消息；
 *  - 输入的 `route` 只读，绝不写 `process.env`（§5.6.4 不变量 1/2）；
 *  - `settingSources: []` 不是可选优化：宿主的 ~/.claude/settings.json 会盖掉本次路由。
 */
import { createLogger } from '@aieval/core';
import { createDisposer } from '../../release';
import { buildSubprocessEnv, stripV1Suffix } from '../../route';
import { runTurn, type TurnContext, type TurnStart } from '../../turn';
import type { AgentProvider, AgentRunInput, AgentRunResult } from '../../types';
import { projectClaudeMessage } from './events';
import { loadClaudeSdk } from './sdk';

/** 单次运行的轮次上限：评测是单轮任务，给一个防失控的上限而不是无限轮 */
const MAX_TURNS = 60;

const logger = createLogger('agents/claude-code');

async function startClaudeCode(context: TurnContext): Promise<TurnStart> {
  const { input, controller } = context;
  const sdk = await loadClaudeSdk();
  const env = buildSubprocessEnv({
    homeDir: input.configHome,
    injected: {
      // 该 SDK 自己追加 /v1/messages：留着尾部 /v1 会变成 /v1/v1/messages（§5.6.4）
      ANTHROPIC_BASE_URL: stripV1Suffix(input.route.baseUrl),
      ANTHROPIC_API_KEY: input.route.apiKey,
      // 部分网关只认 AUTH_TOKEN：两个都给，避免「密钥明明对却 401」
      ANTHROPIC_AUTH_TOKEN: input.route.apiKey,
      CLAUDE_CONFIG_DIR: input.configHome,
    },
  });
  const query = sdk.query({
    prompt: input.prompt,
    options: {
      cwd: input.cwd,
      env,
      model: input.route.modelId,
      settingSources: [],
      abortController: controller,
      maxTurns: MAX_TURNS,
    },
  });
  logger.debug('claude-code 已注入路由并启动查询', {
    model: input.route.modelId,
    baseUrl: env.ANTHROPIC_BASE_URL,
  });
  return {
    stream: query,
    interrupt: () => {
      void query.interrupt?.();
    },
    // dispose 是硬回收：abort 让 SDK 杀掉仍在跑的子进程；interrupt 已被尊重时这一步是空操作
    dispose: createDisposer(() => {
      controller.abort();
    }),
    project: (raw, state) =>
      projectClaudeMessage(raw, state, { kind: 'claude-code', baseUrl: input.route.baseUrl }),
  };
}

export const claudeCodeProvider: AgentProvider = {
  kind: 'claude-code',
  displayName: 'Claude Code',
  metadata: {
    protocolType: 'anthropic',
    capability: { cancelMidTurn: true, usage: true },
    isolation: 'subprocess',
  },
  run: (input: AgentRunInput): Promise<AgentRunResult> =>
    runTurn(input, { kind: 'claude-code', start: startClaudeCode }),
};
```

- [ ] **Step 8: 运行确认通过**

Run: `pnpm --filter @aieval/agents test`
Expected: PASS（`claude-code` 的 events 11 例 + index 10 例；**计数已按 p3 收尾实测订正**——初稿写的 7 / 5 是 Task 7 当时的快照，后续评审修复轮又加了用例）。

Run: `pnpm --filter @aieval/agents typecheck`
Expected: 通过。

- [ ] **Step 9: 变异验证（两条必做守卫，逐条做）**

**守卫 A —— 未识别事件不丢失（§5.6.3）**

1. `Get-FileHash packages/server/agents/src/providers/claude-code/events.ts -Algorithm SHA256`（记为 H-ev）。
2. 变异体：把 `projectClaudeMessage` 末尾的 `return { drafts: [unknownEventDraft(raw)], tokens: null, turns: null, failure: null };` 改成 `return { drafts: [], tokens: null, turns: null, failure: null };`（未识别事件被静默丢弃）。
3. Run: `pnpm --filter @aieval/agents test`；Expected: **FAIL**，`events.test.ts` 的「未识别的 type 被投影成保留原始负载的日志事件」报 `expected [] to have a length of 1`。
4. 还原，重跑：Expected: PASS；`Get-FileHash` 与 H-ev 一致。

**守卫 B —— 计量缺失得 `null` 而非 `0`（§5.6.3 / Review Focus #5）**

1. `Get-FileHash packages/server/agents/src/providers/claude-code/events.ts -Algorithm SHA256`（记为 H-ev2）。
2. 变异体：把 `readTokens` 里缺项分支的 `return null;` 改成
   `return { input: input ?? 0, cached: cached ?? 0, output: output ?? 0 };`（缺项补 0）。
3. Run: `pnpm --filter @aieval/agents test`；Expected: **FAIL**，`events.test.ts` 的「usage 缺一项 → tokens null」报 `expected { input: 120, cached: 0, output: 45 } to be null`。
4. 还原，重跑：Expected: PASS；`Get-FileHash` 与 H-ev2 一致。

- [ ] **Step 10: 提交**

```bash
git add packages/server/agents/src/providers/claude-code/sdk.ts packages/server/agents/src/providers/claude-code/events.ts packages/server/agents/src/providers/claude-code/index.ts packages/server/agents/src/providers/claude-code/events.test.ts packages/server/agents/src/providers/claude-code/index.test.ts packages/server/agents/src/testing/agent-fixtures.ts
git commit -m "feat(agents): claude-code 适配器（路由注入 /v1 拆解、消息投影、计量缺失得 null、释放顺序）"
```

---

## Task 8: `codex` 适配器

**Files:**
- Create: `packages/server/agents/src/providers/codex/sdk.ts`
- Create: `packages/server/agents/src/providers/codex/events.ts`
- Create: `packages/server/agents/src/providers/codex/index.ts`
- Create: `packages/server/agents/src/providers/codex/events.test.ts`
- Create: `packages/server/agents/src/providers/codex/index.test.ts`
- Modify: `packages/server/agents/src/testing/agent-fixtures.ts`（追加 `FakeCodexSdkOptions` / `createFakeCodexSdk`）

**Interfaces:**
- Consumes: Task 3 的 `buildSubprocessEnv` / `ensureV1Suffix`、Task 4 的 `createDisposer` / `classifyAgentMessage`、Task 5 的 `createSdkLoader`、Task 6 的 `runTurn`
- Produces: `CODEX_PACKAGE_NAME`、`CODEX_PROVIDER_ID`、`CodexProviderEntry`、`CodexConfig`、`CodexClientOptions`、`CodexThreadOptions`、`CodexEvent`、`CodexRun`、`CodexThread`、`CodexClient`、`CodexSdkModule`、`buildCodexConfig(baseUrl: string): CodexConfig`、`loadCodexSdk`、`projectCodexEvent`、`codexProvider: AgentProvider`（`kind: 'codex'`、`displayName: 'Codex'`、`protocolType: 'openai'`、`cancelMidTurn: true`、`usage: true`、`isolation: 'subprocess'`）

- [ ] **Step 1: 追加假 SDK 到 `src/testing/agent-fixtures.ts`**

```ts
export interface FakeCodexSdkOptions {
  recorder: FakeVendorRecorder;
  events: readonly unknown[];
  /** 吐完事件后挂住，直到被停止 */
  hang?: boolean;
  /** 吐完事件后抛出（模拟进程非零退出） */
  throwAfterEvents?: unknown;
  /** `runStreamed` 之前抛出（模拟 CLI 未安装 / 线程建不起来） */
  threadError?: unknown;
  /** 运行中回调：用来断言「临时目录在运行期间确实存在」 */
  onRunStreamed?: () => void;
}

/** 假的 `@openai/codex-sdk`：`new Codex(options)` → `startThread(options)` → `runStreamed(prompt, { signal })` */
export function createFakeCodexSdk(options: FakeCodexSdkOptions): unknown {
  const { recorder } = options;
  class FakeCodex {
    constructor(clientOptions: Record<string, unknown>) {
      recorder.options = clientOptions;
      recorder.env = clientOptions.env as Record<string, string>;
    }

    startThread(threadOptions: Record<string, unknown>): unknown {
      recorder.threadOptions = threadOptions;
      return {
        runStreamed: async (prompt: string, runOptions: { signal: AbortSignal }): Promise<unknown> => {
          if (options.threadError !== undefined) throw options.threadError;
          recorder.prompt = prompt;
          options.onRunStreamed?.();
          const stream = createFakeStream(options.events, recorder, {
            hang: options.hang === true,
            throwAfterEvents: options.throwAfterEvents,
          });
          // codex 的 interrupt 与 dispose 都走这个中止入口，故这里只记一次 'interrupt'；
          // dispose 的可观测量是临时目录被删（见 index.test.ts）
          runOptions.signal.addEventListener(
            'abort',
            () => {
              recorder.order.push('interrupt');
              stream.stop();
            },
            { once: true },
          );
          return { events: stream.iterable };
        },
      };
    }
  }
  return { Codex: FakeCodex };
}
```

- [ ] **Step 2: 写失败测试 `providers/codex/events.test.ts`**

```ts
// @vitest-environment node
/**
 * codex 的事件投影：turn.completed 计量与轮次、item 累积文本只发增量、未识别保留。
 * codex 的 `item.updated` 是**累积**文本，全量重发会让日志抽屉里同一段话出现 N 次——这正是 spec
 * 给「唯一允许丢弃的事件是重复事件」举的例子。
 */
import { describe, expect, it } from 'vitest';
import type { TurnState } from '../../turn';
import { projectCodexEvent } from './events';

const CONTEXT = { kind: 'codex', baseUrl: 'https://gw.example.com/openai/v1' } as const;

function newState(): TurnState {
  return { seen: new Set(), turns: 0 };
}

describe('projectCodexEvent：计量与轮次', () => {
  it('turn.completed：轮次 +1，usage 取 input/cached/output 三键', () => {
    const state = newState();
    const projection = projectCodexEvent(
      { type: 'turn.completed', usage: { input_tokens: 11, cached_input_tokens: 3, output_tokens: 7 } },
      state,
      new Map(),
      CONTEXT,
    );
    expect(projection.turns).toBe(1);
    expect(projection.tokens).toEqual({ input: 11, cached: 3, output: 7 });
  });

  it('usage 缺项 → tokens null 且落 WARN（不是 0）', () => {
    const projection = projectCodexEvent(
      { type: 'turn.completed', usage: { input_tokens: 11, output_tokens: 7 } },
      newState(),
      new Map(),
      CONTEXT,
    );
    expect(projection.tokens).toBeNull();
    const warn = projection.drafts.find((draft) => draft.type === 'log' && draft.stream === 'stderr');
    expect(warn?.type === 'log' ? warn.text : '').toContain('不填 0');
  });

  it('没有 usage 的 turn.completed 仍然计一次轮次（turns 与 tokens 各自独立）', () => {
    const projection = projectCodexEvent({ type: 'turn.completed' }, newState(), new Map(), CONTEXT);
    expect(projection.turns).toBe(1);
    expect(projection.tokens).toBeNull();
  });
});

describe('projectCodexEvent：累积文本与未识别事件', () => {
  it('item 的累积文本只发新增部分', () => {
    const seenTexts = new Map<string, string>();
    const state = newState();
    const first = projectCodexEvent(
      { type: 'item.completed', item: { id: 'i1', text: '第一步' } },
      state,
      seenTexts,
      CONTEXT,
    );
    const second = projectCodexEvent(
      { type: 'item.updated', item: { id: 'i1', text: '第一步，第二步' } },
      state,
      seenTexts,
      CONTEXT,
    );
    expect(first.drafts[0]?.type === 'log' ? first.drafts[0].text : '').toBe('第一步');
    expect(second.drafts[0]?.type === 'log' ? second.drafts[0].text : '').toBe('，第二步');
  });

  it('完全重复的累积更新被丢弃（唯一允许丢弃的一类）', () => {
    const seenTexts = new Map<string, string>();
    const state = newState();
    const event = { type: 'item.updated', item: { id: 'i1', text: '同一段' } };
    projectCodexEvent(event, state, seenTexts, CONTEXT);
    const repeated = projectCodexEvent(event, state, seenTexts, CONTEXT);
    expect(repeated.drafts).toEqual([]);
  });

  it('没有可读文本的 item（命令执行等）保留原始负载', () => {
    const payload = { type: 'item.completed', item: { id: 'c1', type: 'command_execution', command: 'npm test' } };
    const projection = projectCodexEvent(payload, newState(), new Map(), CONTEXT);
    expect(projection.drafts).toHaveLength(1);
    expect(JSON.parse(projection.drafts[0]?.type === 'log' ? projection.drafts[0].text : '')).toEqual(payload);
  });

  it('未识别的 type（thread.started 与未来新增类型）保留原始负载', () => {
    const payload = { type: 'thread.started', thread_id: 't1' };
    const projection = projectCodexEvent(payload, newState(), new Map(), CONTEXT);
    expect(projection.drafts).toHaveLength(1);
    expect(JSON.parse(projection.drafts[0]?.type === 'log' ? projection.drafts[0].text : '')).toEqual(payload);
  });

  it('turn.failed 按文案归因（401 → AUTH_FAILED）', () => {
    const projection = projectCodexEvent(
      { type: 'turn.failed', error: { message: 'HTTP 401 unauthorized' } },
      newState(),
      new Map(),
      CONTEXT,
    );
    expect(projection.failure?.code).toBe('AUTH_FAILED');
    expect(projection.drafts.some((draft) => draft.type === 'error')).toBe(true);
  });
});
```

- [ ] **Step 3: 写失败测试 `providers/codex/index.test.ts`**

```ts
// @vitest-environment node
/**
 * codex 适配器：注入落点（客户端选项 + 完整 model_providers 条目 + 独立 CODEX_HOME/TMPDIR）、
 * 事件贯通、临时目录回收、加载降级。
 */
import type { AgentEvent } from '@aieval/contracts';
import { existsSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setAgentRuntimeForTesting } from '../../runtime';
import {
  collectEvents,
  createFakeCodexSdk,
  createRecorder,
  createRunInput,
  settleWithFakeTimers,
} from '../../testing/agent-fixtures';
import { codexProvider } from './index';
import { CODEX_PACKAGE_NAME } from './sdk';

afterEach(() => {
  setAgentRuntimeForTesting(null);
  vi.useRealTimers();
});

interface RecordedCodexConfig {
  model_provider: string;
  model_providers: Record<string, { base_url: string; wire_api: string; requires_openai_auth: boolean }>;
  disable_response_storage: boolean;
  tools: { multi_agent: boolean; web_search: boolean };
}

describe('codexProvider', () => {
  it('注入落点：baseUrl 补 /v1、apiKey 进客户端选项、model_providers 条目完整、CODEX_HOME 指向该行目录', async () => {
    const recorder = createRecorder();
    setAgentRuntimeForTesting({ sdkModule: { [CODEX_PACKAGE_NAME]: createFakeCodexSdk({ recorder, events: [] }) } });
    await codexProvider.run(
      createRunInput({
        route: {
          protocolType: 'openai',
          baseUrl: 'https://gw.example.com/openai/',
          apiKey: 'sk-codex',
          modelId: 'gpt-x',
        },
      }),
    );
    expect(recorder.options?.baseUrl).toBe('https://gw.example.com/openai/v1');
    expect(recorder.options?.apiKey).toBe('sk-codex');
    // 环境里已有的 ~/.codex 配置会赢过注入的 base URL：解药是把 HOME / CODEX_HOME 指向该行目录
    expect(recorder.env?.CODEX_HOME).toBe('D:/tmp/rows/row-1/.agenthome');
    expect(recorder.env?.HOME).toBe('D:/tmp/rows/row-1/.agenthome');
    const config = recorder.options?.config as RecordedCodexConfig;
    expect(config.model_provider).toBe('aieval');
    expect(config.model_providers.aieval?.base_url).toBe('https://gw.example.com/openai/v1');
    expect(config.model_providers.aieval?.wire_api).toBe('responses');
    expect(config.model_providers.aieval?.requires_openai_auth).toBe(true);
    expect(config.disable_response_storage).toBe(true);
    expect(config.tools).toEqual({ multi_agent: false, web_search: false });
    expect(recorder.threadOptions?.model).toBe('gpt-x');
    expect(recorder.threadOptions?.workingDirectory).toBe('D:/tmp/rows/row-1/workspace');
    // 评测是非交互的：任何走人工批准的路径都只会让该行走到超时
    expect(recorder.threadOptions?.approvalPolicy).toBe('never');
  });

  it('本次运行的临时目录：运行中存在、跑完被删（dispose 的回收对象，§5.6.5）', async () => {
    const recorder = createRecorder();
    const existedDuringRun: boolean[] = [];
    setAgentRuntimeForTesting({
      sdkModule: {
        [CODEX_PACKAGE_NAME]: createFakeCodexSdk({
          recorder,
          events: [],
          onRunStreamed: () => {
            existedDuringRun.push(existsSync(String(recorder.env?.TMPDIR)));
          },
        }),
      },
    });
    await codexProvider.run(createRunInput());
    const scratchDir = String(recorder.env?.TMPDIR);
    expect(scratchDir).toContain('aieval-codex-');
    expect(existedDuringRun).toEqual([true]);
    expect(existsSync(scratchDir)).toBe(false);
  });

  it('事件贯通：两次 turn.completed → 两条 usage 事件、turns 累加、item 文本进日志、未识别事件保留', async () => {
    const events: AgentEvent[] = [];
    const recorder = createRecorder();
    setAgentRuntimeForTesting({
      sdkModule: {
        [CODEX_PACKAGE_NAME]: createFakeCodexSdk({
          recorder,
          events: [
            { type: 'thread.started', thread_id: 't1' },
            { type: 'item.completed', item: { id: 'i1', text: '第一步' } },
            { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 1, output_tokens: 2 } },
            { type: 'turn.completed', usage: { input_tokens: 20, cached_input_tokens: 2, output_tokens: 4 } },
          ],
        }),
      },
    });
    const result = await codexProvider.run(createRunInput({ onEvent: collectEvents(events) }));
    expect(result).toMatchObject({
      ok: true,
      exitReason: 'completed',
      turns: 2,
      tokens: { input: 20, cached: 2, output: 4 },
    });
    expect(events.filter((event) => event.type === 'usage')).toHaveLength(2);
    const logs = events.filter((event) => event.type === 'log').map((event) => (event.type === 'log' ? event.text : ''));
    expect(logs).toContain('第一步');
    expect(logs.some((text) => text.includes('thread.started'))).toBe(true);
  });

  it('CLI 未安装（spawn ENOENT）：AGENT_FAILED，文案指向缺失的可执行文件，且不留临时目录', async () => {
    const recorder = createRecorder();
    setAgentRuntimeForTesting({
      sdkModule: {
        [CODEX_PACKAGE_NAME]: createFakeCodexSdk({ recorder, events: [], threadError: new Error('spawn codex ENOENT') }),
      },
    });
    const result = await codexProvider.run(createRunInput());
    expect(result).toMatchObject({ ok: false, exitReason: 'error' });
    expect(result.error?.code).toBe('AGENT_FAILED');
    expect(result.error?.message).toContain('可执行文件');
    // start 阶段失败也要清掉临时目录：否则「CLI 装不上」会变成「每跑一次留一个目录」
    expect(existsSync(String(recorder.env?.TMPDIR))).toBe(false);
  });

  it('厂商包缺失或形状不对：AGENT_LOAD_FAILED 且文案含包名；后续一轮可重试成功', async () => {
    setAgentRuntimeForTesting({ sdkModule: { [CODEX_PACKAGE_NAME]: {} } });
    const first = await codexProvider.run(createRunInput());
    expect(first.error?.code).toBe('AGENT_LOAD_FAILED');
    expect(first.error?.message).toContain(CODEX_PACKAGE_NAME);
    expect(first.error?.message).toContain('pnpm add');

    const recorder = createRecorder();
    setAgentRuntimeForTesting({ sdkModule: { [CODEX_PACKAGE_NAME]: createFakeCodexSdk({ recorder, events: [] }) } });
    const second = await codexProvider.run(createRunInput());
    expect(second.ok).toBe(true);
  });

  it('内层超时：中止响应流后仍然释放（dispose 会删掉临时目录）', async () => {
    vi.useFakeTimers();
    const recorder = createRecorder();
    setAgentRuntimeForTesting({
      sdkModule: { [CODEX_PACKAGE_NAME]: createFakeCodexSdk({ recorder, events: [], hang: true }) },
    });
    const promise = codexProvider.run(createRunInput({ timeoutMs: 1_000 }));
    const result = await settleWithFakeTimers(promise, { stepMs: 500, steps: 10 });
    expect(result.exitReason).toBe('timed-out');
    expect(existsSync(String(recorder.env?.TMPDIR))).toBe(false);
  });
});
```

- [ ] **Step 4: 运行确认失败**

Run: `pnpm --filter @aieval/agents test`
Expected: FAIL —— `Failed to resolve import "./events"` / `"./index"` / `"./sdk"`。

- [ ] **Step 5: 写 `providers/codex/sdk.ts`**

```ts
/**
 * codex 的厂商 SDK 懒加载外壳 + 一份**完整的** model_providers 条目构造。
 * 本文件是唯一知道 `@openai/codex-sdk` 入口形状的地方（窄结构自声明，不从厂商包 import type）。
 * 注意：
 *  - `requires_openai_auth` 不是可选优化——缺它 CLI 不发 Bearer，全部 401（§5.6.4）；
 *  - 显式 model_providers 条目同样必需：环境里已有的 ~/.codex 配置会赢过我们注入的 base URL；
 *  - config 的键名与层级以真实探测运行的 dump 为准（探测脚本会把注入对象原文一起 dump）。
 */
import { AgentLoadError } from '../../errors';
import { createSdkLoader } from '../../load-once';

export const CODEX_PACKAGE_NAME = '@openai/codex-sdk';

/** 注入的 provider id：与宿主 ~/.codex 里可能存在的同名条目互不冲突 */
export const CODEX_PROVIDER_ID = 'aieval';

export interface CodexProviderEntry {
  name: string;
  /** Responses wire 的完整根：`{base}/v1`（CLI 只走 `POST {base}/v1/responses`） */
  base_url: string;
  wire_api: 'responses';
  /** 缺它不发 Bearer，全部 401（§5.6.4） */
  requires_openai_auth: true;
  request_max_retries: number;
}

export interface CodexConfig {
  model_provider: string;
  model_providers: Record<string, CodexProviderEntry>;
  /** 网关侧不留响应体：评测只消费事件流，留档反而可能被网关拒绝 */
  disable_response_storage: true;
  /** 命名空间工具在网关侧常回 400，一律关掉（§5.6.4） */
  tools: { multi_agent: false; web_search: false };
}

export interface CodexClientOptions {
  apiKey: string;
  baseUrl: string;
  config: CodexConfig;
  env: Record<string, string>;
}

export interface CodexThreadOptions {
  model: string;
  workingDirectory: string;
  /** 建线程时固定：改了必须重建线程（§5.6.5），本适配器每次运行新建一个 */
  sandboxMode: string;
  /** 评测是非交互的：任何走人工批准的路径都只会让该行走到超时 */
  approvalPolicy: string;
  skipGitRepoCheck: boolean;
}

export interface CodexEvent {
  type: string;
  [key: string]: unknown;
}

export interface CodexRun {
  events: AsyncIterable<CodexEvent>;
}

export interface CodexThread {
  runStreamed: (prompt: string, options: { signal: AbortSignal }) => Promise<CodexRun>;
}

export interface CodexClient {
  startThread: (options: CodexThreadOptions) => CodexThread;
}

export interface CodexSdkModule {
  Codex: new (options: CodexClientOptions) => CodexClient;
}

/** 一份完整的 model_providers 条目：环境里已有的 ~/.codex 配置会赢过我们注入的 base URL（§5.6.4） */
export function buildCodexConfig(baseUrl: string): CodexConfig {
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
    disable_response_storage: true,
    tools: { multi_agent: false, web_search: false },
  };
}

const loadRaw = createSdkLoader<unknown>(async () => import('@openai/codex-sdk'), CODEX_PACKAGE_NAME);

/** 懒加载 + 形状校验：形状不对与「包没装」归为同一类（AGENT_LOAD_FAILED），文案点名包名 */
export async function loadCodexSdk(): Promise<CodexSdkModule> {
  const raw = await loadRaw();
  if (typeof (raw as { Codex?: unknown }).Codex !== 'function') {
    throw new AgentLoadError(CODEX_PACKAGE_NAME, new Error('模块缺少 Codex 导出'));
  }
  return raw as CodexSdkModule;
}
```

- [ ] **Step 6: 写 `providers/codex/events.ts`**

```ts
/**
 * codex 的事件投影（§5.6.3）。
 * 规则：
 *  1. `turn.completed` → 轮次 +1，并取 `usage.input_tokens` / `usage.cached_input_tokens` /
 *     `usage.output_tokens`（三项齐了才认，缺项 → null + WARN，绝不填 0）；
 *  2. `item.updated` / `item.completed` 携带**同一 item 的累积文本**：只投影新增部分，完全重复
 *     （没有新增）则丢弃——这是「唯一允许丢弃的事件是重复事件」在 codex 上的具体形状；
 *  3. `turn.failed` / `error` → 失败，并按文案归因（401 → AUTH_FAILED 等）；
 *  4. 其余（thread.started / turn.started / item.started / 未来新增类型）一律落保留原始负载的日志事件。
 * 注意：字段名以真实事件探测的 dump 为准；探测回写任务按实测修正本文件。
 */
import { logDraft, safeStringify, unknownEventDraft, type AgentEventDraft } from '../../emit';
import { classifyAgentMessage, type FailureContext } from '../../errors';
import { asRecord, readNumber, readString } from '../../json';
import type { TurnProjection, TurnState } from '../../turn';

export function projectCodexEvent(
  raw: unknown,
  state: TurnState,
  seenTexts: Map<string, string>,
  context: FailureContext,
): TurnProjection {
  const event = asRecord(raw);
  const type = readString(event, 'type') ?? 'unknown';

  if (type === 'turn.completed') {
    state.turns += 1;
    const drafts: AgentEventDraft[] = [];
    const tokens = readTokens(event?.usage, drafts);
    return { drafts, tokens, turns: state.turns, failure: null };
  }

  if (type === 'item.updated' || type === 'item.completed') {
    const item = asRecord(event?.item);
    const id = readString(item, 'id');
    const text = readString(item, 'text');
    if (id === null || text === null) {
      // 没有可读文本的 item（命令执行、文件改动、MCP 调用）：保留原始负载，不解析语义
      return { drafts: [unknownEventDraft(raw)], tokens: null, turns: null, failure: null };
    }
    const previous = seenTexts.get(id) ?? '';
    seenTexts.set(id, text);
    // 累积文本：startsWith 说明是「上次 + 新增」；否则视为整体替换（中间被改写），整段重发
    const delta = text.startsWith(previous) ? text.slice(previous.length) : text;
    if (delta === '') return emptyProjection(); // 纯重复更新：唯一允许丢弃的一类
    return { drafts: [logDraft('stdout', delta)], tokens: null, turns: null, failure: null };
  }

  if (type === 'turn.failed' || type === 'error') {
    const message =
      readString(asRecord(event?.error), 'message') ?? readString(event, 'message') ?? safeStringify(raw);
    return {
      drafts: [{ type: 'error', message }],
      tokens: null,
      turns: null,
      failure: classifyAgentMessage(message, context),
    };
  }

  return { drafts: [unknownEventDraft(raw)], tokens: null, turns: null, failure: null };
}

/** 三项齐了才认；缺项时落一条 WARN 并保留原始负载——「没采到」与「0」必须能区分（§5.6.3） */
function readTokens(
  usage: unknown,
  drafts: AgentEventDraft[],
): { input: number; cached: number; output: number } | null {
  const record = asRecord(usage);
  if (record === null) return null;
  const input = readNumber(record, 'input_tokens');
  // cached 的语义是**缓存读**：codex 的字段名是 cached_input_tokens（以探测 dump 为准）
  const cached = readNumber(record, 'cached_input_tokens');
  const output = readNumber(record, 'output_tokens');
  if (input === null || cached === null || output === null) {
    drafts.push(
      logDraft('stderr', `[WARN] 用量负载不完整，本次运行按「未采集计量」处理（不填 0）：${safeStringify(usage)}`),
    );
    return null;
  }
  return { input, cached, output };
}

/** 空投影：本条消息不产出任何事件（纯重复事件，唯一允许丢弃的一类） */
function emptyProjection(): TurnProjection {
  return { drafts: [], tokens: null, turns: null, failure: null };
}
```

- [ ] **Step 7: 写 `providers/codex/index.ts`**

```ts
/**
 * codex 适配器：注入客户端选项与完整 model_providers 条目 → 消费事件流 → 按 §5.6.5 释放。
 * 注意：
 *  - 环境里已有的 `~/.codex` 配置（model_provider / 插件 / MCP）会**赢过**我们注入的 base URL，
 *    解药是把该行的 CODEX_HOME / HOME 指向 configHome（§5.6.4）；
 *  - 本次运行的 SDK 临时目录由本适配器创建，`dispose()` 负责删掉它（§5.6.5）；
 *  - codex 没有「优雅停止」这种能力：`interrupt()` 就是中止响应流（CLI 随之收掉子进程）。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '@aieval/core';
import { createDisposer } from '../../release';
import { buildSubprocessEnv, ensureV1Suffix } from '../../route';
import { runTurn, type TurnContext, type TurnStart } from '../../turn';
import type { AgentProvider, AgentRunInput, AgentRunResult } from '../../types';
import { projectCodexEvent } from './events';
import { buildCodexConfig, loadCodexSdk } from './sdk';

const logger = createLogger('agents/codex');

async function startCodex(context: TurnContext): Promise<TurnStart> {
  const { input, controller } = context;
  const sdk = await loadCodexSdk();
  // 该 SDK 会在 CLI 侧落临时文件：给本次运行一个独占目录，dispose 时一并回收（§5.6.5）
  const scratchDir = mkdtempSync(join(tmpdir(), 'aieval-codex-'));
  try {
    const env = buildSubprocessEnv({
      homeDir: input.configHome,
      injected: {
        CODEX_HOME: input.configHome,
        TMPDIR: scratchDir,
        TEMP: scratchDir,
        TMP: scratchDir,
      },
    });
    const baseUrl = ensureV1Suffix(input.route.baseUrl); // CLI 只走 Responses wire（§5.6.4）
    const client = new sdk.Codex({
      apiKey: input.route.apiKey,
      baseUrl,
      config: buildCodexConfig(baseUrl),
      env,
    });
    const thread = client.startThread({
      model: input.route.modelId,
      workingDirectory: input.cwd,
      sandboxMode: 'workspace-write',
      approvalPolicy: 'never',
      skipGitRepoCheck: true,
    });
    // 响应流的中止入口：interrupt 与 dispose 都走它
    const streamAbort = new AbortController();
    controller.signal.addEventListener(
      'abort',
      () => {
        streamAbort.abort();
      },
      { once: true },
    );
    const run = await thread.runStreamed(input.prompt, { signal: streamAbort.signal });
    logger.debug('codex 已注入路由并启动线程', { model: input.route.modelId, baseUrl });
    const seenTexts = new Map<string, string>();
    return {
      stream: run.events,
      interrupt: () => {
        streamAbort.abort();
      },
      dispose: createDisposer(() => {
        streamAbort.abort();
        rmSync(scratchDir, { recursive: true, force: true });
      }),
      project: (raw, state) =>
        projectCodexEvent(raw, state, seenTexts, { kind: 'codex', baseUrl: input.route.baseUrl }),
    };
  } catch (cause) {
    // start 阶段失败（CLI 未安装 / 线程建不起来）时还没交出释放句柄：临时目录必须在这里清掉，
    // 否则「装不上 CLI」会变成「每跑一次留一个临时目录」
    rmSync(scratchDir, { recursive: true, force: true });
    throw cause;
  }
}

export const codexProvider: AgentProvider = {
  kind: 'codex',
  displayName: 'Codex',
  metadata: {
    protocolType: 'openai',
    capability: { cancelMidTurn: true, usage: true },
    isolation: 'subprocess',
  },
  run: (input: AgentRunInput): Promise<AgentRunResult> => runTurn(input, { kind: 'codex', start: startCodex }),
};
```

- [ ] **Step 8: 运行确认通过**

Run: `pnpm --filter @aieval/agents test`
Expected: PASS（`codex` 的 events 9 例 + index 12 例；**计数已按 p3 收尾实测订正**——初稿写的 7 / 6 是 Task 8 当时的快照）。

Run: `pnpm --filter @aieval/agents typecheck`
Expected: 通过。

- [ ] **Step 9: 变异验证（守卫：累积重复丢弃 + usage 字段名）**

**守卫 A —— 累积重复必须丢弃（§5.6.3）**

1. `Get-FileHash packages/server/agents/src/providers/codex/events.ts -Algorithm SHA256`（记为 H-cev）。
2. 变异体：删掉 `if (delta === '') return emptyProjection();` 这一行（重复更新也照发）。
3. Run: `pnpm --filter @aieval/agents test`；Expected: **FAIL**，`events.test.ts` 的「完全重复的累积更新被丢弃」报 `expected [ { type: 'log', … } ] to deeply equal []`。
4. 还原，重跑：Expected: PASS；`Get-FileHash` 与 H-cev 一致。

**守卫 B —— usage 字段名（`cached_input_tokens`）**

1. `Get-FileHash packages/server/agents/src/providers/codex/events.ts -Algorithm SHA256`（记为 H-cev2）。
2. 变异体：把 `readNumber(record, 'cached_input_tokens')` 改成 `readNumber(record, 'cache_read_input_tokens')`（抄成 anthropic 的字段名）。
3. Run: `pnpm --filter @aieval/agents test`；Expected: **FAIL**，`events.test.ts` 的「turn.completed：轮次 +1」报 `expected { input: 11, cached: null, … } to deeply equal { input: 11, cached: 3, output: 7 }`。
4. 还原，重跑：Expected: PASS；`Get-FileHash` 与 H-cev2 一致。

- [ ] **Step 10: 提交**

```bash
git add packages/server/agents/src/providers/codex/sdk.ts packages/server/agents/src/providers/codex/events.ts packages/server/agents/src/providers/codex/index.ts packages/server/agents/src/providers/codex/events.test.ts packages/server/agents/src/providers/codex/index.test.ts packages/server/agents/src/testing/agent-fixtures.ts
git commit -m "feat(agents): codex 适配器（/v1 补齐、model_providers 注入、累积文本增量投影、临时目录回收）"
```

---

## Task 9: `dsh` 适配器

**Files:**
- Create: `packages/server/agents/src/providers/dsh/sdk.ts`
- Create: `packages/server/agents/src/providers/dsh/events.ts`
- Create: `packages/server/agents/src/providers/dsh/index.ts`
- Create: `packages/server/agents/src/providers/dsh/events.test.ts`
- Create: `packages/server/agents/src/providers/dsh/index.test.ts`
- Modify: `packages/server/agents/src/testing/agent-fixtures.ts`（追加 `FakeDshSdkOptions` / `createFakeDshSdk`）

**Interfaces:**
- Consumes: Task 3 的 `buildSubprocessEnv` / `keepBaseUrl`、Task 4 的 `createDisposer` / `classifyAgentMessage`、Task 5 的 `createSdkLoader`、Task 6 的 `runTurn`
- Produces: `DSH_PACKAGE_NAME`、`DshRuntimeOptions`、`DshRuntime`、`DshSdkModule`、`loadDshSdk`、`projectDshNotification`、`dshProvider: AgentProvider`（`kind: 'dsh'`、`displayName: 'DeepSeek Harness'`、`protocolType: 'openai'`、`cancelMidTurn: false`、`usage: false`（探测前保守值）、`isolation: 'subprocess'`）

- [ ] **Step 1: 追加假 SDK 到 `src/testing/agent-fixtures.ts`**

```ts
export interface FakeDshSdkOptions {
  recorder: FakeVendorRecorder;
  events: readonly unknown[];
  /** 吐完通知后挂住，直到被 close()（测终止与超时） */
  hang?: boolean;
  /** 吐完通知后抛出 */
  throwAfterEvents?: unknown;
  /** `createRuntime` 之前抛出（模拟运行时起不来） */
  createError?: unknown;
}

/** 假的 `@deepseek-ai/dsh-sdk-client`：`createRuntime(options)` → `{ notifications, close }` */
export function createFakeDshSdk(options: FakeDshSdkOptions): unknown {
  const { recorder } = options;
  return {
    createRuntime: async (runtimeOptions: Record<string, unknown>): Promise<unknown> => {
      if (options.createError !== undefined) throw options.createError;
      recorder.options = runtimeOptions;
      recorder.env = runtimeOptions.env as Record<string, string>;
      recorder.prompt = String(runtimeOptions.prompt);
      const stream = createFakeStream(options.events, recorder, {
        hang: options.hang === true,
        throwAfterEvents: options.throwAfterEvents,
      });
      return {
        notifications: stream.iterable,
        close: (): void => {
          recorder.closeCount += 1;
          recorder.order.push('dispose');
          stream.stop();
        },
      };
    },
  };
}
```

- [ ] **Step 2: 写失败测试 `providers/dsh/events.test.ts`**

```ts
// @vitest-environment node
/**
 * dsh 的通知投影（**探测前口径**）：不猜字段名、不丢事件、计量一律 null。
 * 为什么探测前必须一律 null：该 SDK 的文档里没有 usage 通知的字段说明，猜一个字段名会把「没采到」
 * 显示成 0，进而让人得出「这家很省」的错误结论（§5.6.3）。
 */
import { describe, expect, it } from 'vitest';
import type { TurnState } from '../../turn';
import { projectDshNotification } from './events';

const CONTEXT = { kind: 'dsh', baseUrl: 'https://gw.example.com/deepseek/v1' } as const;

function newState(): TurnState {
  return { seen: new Set(), turns: 0 };
}

describe('projectDshNotification（探测前口径）', () => {
  it('任何通知都落成保留原始负载的日志事件（一条都不丢）', () => {
    const payload = { type: 'session.update', payload: { text: 'hello', nested: [1, 2] } };
    const projection = projectDshNotification(payload, newState(), CONTEXT);
    expect(projection.drafts).toHaveLength(1);
    expect(JSON.parse(projection.drafts[0]?.type === 'log' ? projection.drafts[0].text : '')).toEqual(payload);
  });

  it('没有 type 的通知同样保留原始负载（形状未知不等于可以丢）', () => {
    const projection = projectDshNotification({ anything: true }, newState(), CONTEXT);
    expect(projection.drafts).toHaveLength(1);
  });

  it('计量一律 null（不是 0）：usage 字段名未知，探测前不做任何假设（Review Focus #5）', () => {
    const projection = projectDshNotification(
      { type: 'session.update', usage: { prompt_tokens: 12, completion_tokens: 3 } },
      newState(),
      CONTEXT,
    );
    expect(projection.tokens).toBeNull();
    expect(projection.turns).toBeNull();
  });

  it('type 为 error 的通知 → failure，并按文案归因（401 → AUTH_FAILED）', () => {
    const projection = projectDshNotification(
      { type: 'error', message: 'HTTP 401 unauthorized' },
      newState(),
      CONTEXT,
    );
    expect(projection.failure?.code).toBe('AUTH_FAILED');
    expect(projection.drafts.some((draft) => draft.type === 'error')).toBe(true);
  });
});
```

- [ ] **Step 3: 写失败测试 `providers/dsh/index.test.ts`**

```ts
// @vitest-environment node
/**
 * dsh 适配器：环境变量注入（保留尾部 /v1）、终止必然走第二段（5 秒 → WARN → 关闭运行时）、加载降级。
 * dsh 是「非合作适配器」的真实样本：cancelMidTurn 为 false、interrupt() 是刻意空实现，所以它的终止
 * 路径 100% 会经过 §5.6.5 的第二段——这条用例同时是那段兜底逻辑的真实性证明。
 */
import type { AgentEvent } from '@aieval/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RELEASE_GRACE_MS } from '../../release';
import { setAgentRuntimeForTesting } from '../../runtime';
import {
  collectEvents,
  createFakeDshSdk,
  createRecorder,
  createRunInput,
  settleWithFakeTimers,
} from '../../testing/agent-fixtures';
import { dshProvider } from './index';
import { DSH_PACKAGE_NAME } from './sdk';

afterEach(() => {
  setAgentRuntimeForTesting(null);
  vi.useRealTimers();
});

describe('dshProvider', () => {
  it('注入落点：DEEPSEEK_BASE_URL 保留尾部 /v1（其 adapter 自己追加 /chat/completions）、DSH_HOME 指向该行目录', async () => {
    const recorder = createRecorder();
    setAgentRuntimeForTesting({ sdkModule: { [DSH_PACKAGE_NAME]: createFakeDshSdk({ recorder, events: [] }) } });
    await dshProvider.run(
      createRunInput({
        route: {
          protocolType: 'openai',
          baseUrl: 'https://gw.example.com/deepseek/v1/',
          apiKey: 'sk-dsh',
          modelId: 'deepseek-x',
        },
      }),
    );
    expect(recorder.env?.DEEPSEEK_BASE_URL).toBe('https://gw.example.com/deepseek/v1');
    expect(recorder.env?.DEEPSEEK_API_KEY).toBe('sk-dsh');
    expect(recorder.env?.DSH_HOME).toBe('D:/tmp/rows/row-1/.agenthome');
    expect(recorder.env?.HOME).toBe('D:/tmp/rows/row-1/.agenthome');
    expect(recorder.options?.model).toBe('deepseek-x');
    expect(recorder.options?.cwd).toBe('D:/tmp/rows/row-1/workspace');
    expect(recorder.prompt).toBe('把 README 的标题改成「示例项目」，然后结束。');
  });

  it('终止：interrupt 不被响应 → 5 秒后落 WARN → 关闭运行时恰好一次，结果为 canceled（Review Focus #3）', async () => {
    vi.useFakeTimers();
    const events: AgentEvent[] = [];
    const recorder = createRecorder();
    setAgentRuntimeForTesting({
      sdkModule: { [DSH_PACKAGE_NAME]: createFakeDshSdk({ recorder, events: [], hang: true }) },
    });
    const controller = new AbortController();
    const promise = dshProvider.run(createRunInput({ signal: controller.signal, onEvent: collectEvents(events) }));
    await vi.advanceTimersByTimeAsync(100);
    controller.abort();
    const result = await settleWithFakeTimers(promise, { stepMs: 1_000, steps: 10 });
    expect(result.exitReason).toBe('canceled');
    expect(result.error?.code).toBe('AGENT_CANCELED');
    expect(recorder.closeCount).toBe(1); // dispose 幂等：终止与第二段只关一次
    const warn = events.find((event) => event.type === 'log' && event.text.includes('[WARN]'));
    expect(warn?.type === 'log' ? warn.text : '').toContain(`${RELEASE_GRACE_MS / 1000} 秒`);
  });

  it('运行中事件贯通：通知进日志、结果 ok、没有计量就不发 usage 事件', async () => {
    const events: AgentEvent[] = [];
    const recorder = createRecorder();
    setAgentRuntimeForTesting({
      sdkModule: {
        [DSH_PACKAGE_NAME]: createFakeDshSdk({ recorder, events: [{ type: 'session.update', text: '做完了' }] }),
      },
    });
    const result = await dshProvider.run(createRunInput({ onEvent: collectEvents(events) }));
    expect(result).toMatchObject({ ok: true, exitReason: 'completed', tokens: null, turns: null });
    expect(events.some((event) => event.type === 'log' && event.text.includes('做完了'))).toBe(true);
    expect(events.some((event) => event.type === 'usage')).toBe(false); // 不发明 0
    expect(recorder.closeCount).toBe(1); // 正常出口也要释放
  });

  it('厂商包缺失或形状不对：AGENT_LOAD_FAILED 且文案含包名；后续一轮可重试成功', async () => {
    setAgentRuntimeForTesting({ sdkModule: { [DSH_PACKAGE_NAME]: {} } });
    const first = await dshProvider.run(createRunInput());
    expect(first.error?.code).toBe('AGENT_LOAD_FAILED');
    expect(first.error?.message).toContain(DSH_PACKAGE_NAME);
    expect(first.error?.message).toContain('pnpm add');

    const recorder = createRecorder();
    setAgentRuntimeForTesting({ sdkModule: { [DSH_PACKAGE_NAME]: createFakeDshSdk({ recorder, events: [] }) } });
    const second = await dshProvider.run(createRunInput());
    expect(second.ok).toBe(true);
  });
});
```

- [ ] **Step 4: 运行确认失败**

Run: `pnpm --filter @aieval/agents test`
Expected: FAIL —— `Failed to resolve import "./events"` / `"./index"` / `"./sdk"`。

- [ ] **Step 5: 写 `providers/dsh/sdk.ts`**

```ts
/**
 * dsh 的厂商 SDK 懒加载外壳。
 * 本文件与 events.ts 是**探测结果的第一落点**：该 SDK 的公开文档里没有通知流的字段说明，所以下面
 * 这些窄结构是按「§5.6.4 的注入口径 + 最小可用假设」声明的——**字段名以真实探测的 dump 为准**
 * （§5.6.3）；探测回写任务按实测修正这两个文件。
 * 注意：`cancelMidTurn: false` 是元数据里的一等结论——停止只能靠关闭运行时，故 `close()` 是必需的
 * 释放出口（A7：只实现 interrupt 会给项目留下孤儿子进程）。
 */
import { AgentLoadError } from '../../errors';
import { createSdkLoader } from '../../load-once';

export const DSH_PACKAGE_NAME = '@deepseek-ai/dsh-sdk-client';

export interface DshRuntimeOptions {
  cwd: string;
  env: Record<string, string>;
  model: string;
  /** 考题提示词：该 SDK 的运行入口自带这一项（探测脚本会 dump 实际传参原文） */
  prompt: string;
  /** 权限档在启动 profile 里烘进去：变更必须重建运行时（§5.6.5），本适配器每次运行新建一个 */
  permissionProfile: string;
}

export interface DshRuntime {
  /** 通知流：每项一条原始通知（形状未知，投影层按 unknown 处理） */
  notifications: AsyncIterable<unknown>;
  /** 关闭运行时：回收子进程（这是 dsh 唯一的停止手段） */
  close: () => Promise<void> | void;
}

export interface DshSdkModule {
  createRuntime: (options: DshRuntimeOptions) => Promise<DshRuntime> | DshRuntime;
}

const loadRaw = createSdkLoader<unknown>(async () => import('@deepseek-ai/dsh-sdk-client'), DSH_PACKAGE_NAME);

// ⚠️ 本代码块是**修复波 M1 之前的形态**，不要拿它逐字比对今天的实现（复评 Low-1）：
// 落地后的 `loadDshSdk()` 已按 M1 拆成两种文案（`AgentLoadError` 新增 `variant: 'missing' | 'shape-mismatch'`
// 与 `expected` / `actual`），并多了一个 `exportedNames()` 辅助函数把**实测导出面**写进文案。
// 真实入口形态（`DeepSeekHarness` / `harness.run` / `client.subscribe` / `harness.close`）见本计划 Task 11 的 Step 0。
/** 懒加载 + 形状校验：形状不对与「包没装」归为同一类（AGENT_LOAD_FAILED），文案点名包名 */
export async function loadDshSdk(): Promise<DshSdkModule> {
  const raw = await loadRaw();
  if (typeof (raw as { createRuntime?: unknown }).createRuntime !== 'function') {
    throw new AgentLoadError(DSH_PACKAGE_NAME, new Error('模块缺少 createRuntime 导出'));
  }
  return raw as DshSdkModule;
}
```

- [ ] **Step 6: 写 `providers/dsh/events.ts`**

```ts
/**
 * dsh 的通知投影（§5.6.3）：**探测结果的第一落点**。
 * 探测前的口径（保守，不猜字段名）：
 *  - 只有明确写着 `type: 'error'` 的通知被当作失败；
 *  - 其余通知（含所有未识别类型）一律投影成**保留原始负载**的日志事件，一条都不丢；
 *  - 计量一律返回 null —— 该 SDK 的文档里没有 usage 通知的字段说明，**不能假设它存在**；
 *    探到之后按 dump 里的字段名打开提取，并把元数据里的 usage 改成 true（探测回写任务）。
 * 注意：`state` 目前只做签名一致性（探测前不识别任何轮次通知）；探到轮次通知后在这里累加。
 */
import { safeStringify, unknownEventDraft } from '../../emit';
import { classifyAgentMessage, type FailureContext } from '../../errors';
import { asRecord, readString } from '../../json';
import type { TurnProjection, TurnState } from '../../turn';

export function projectDshNotification(raw: unknown, state: TurnState, context: FailureContext): TurnProjection {
  const payload = asRecord(raw);
  if (readString(payload, 'type') === 'error') {
    const message = readString(payload, 'message') ?? safeStringify(raw);
    return {
      drafts: [{ type: 'error', message }],
      tokens: null,
      turns: null,
      failure: classifyAgentMessage(message, context),
    };
  }
  return { drafts: [unknownEventDraft(raw)], tokens: null, turns: null, failure: null };
}
```

- [ ] **Step 7: 写 `providers/dsh/index.ts`**

```ts
/**
 * dsh 适配器：环境变量注入 + 关闭式释放（§5.6.4 / §5.6.5）。
 * 两条关键差异都来自 `cancelMidTurn: false` 这一格元数据：
 *  - 不支持中途取消：`interrupt()` 是**刻意**的空实现，停止只能靠关闭运行时，因此终止与超时一定走
 *    §5.6.5 的第二段——等 5 秒、落一条 WARN、再强制关闭（界面上会看到这行晚 5 秒变 canceled）；
 *  - 权限档烘在启动 profile 里：改了必须重建运行时（A4 的「一行一次运行一次释放」正好满足）。
 * 注意：`DEEPSEEK_BASE_URL` **保留尾部 /v1**（其 adapter 自己追加 /chat/completions）。
 */
import { createLogger } from '@aieval/core';
import { createDisposer } from '../../release';
import { buildSubprocessEnv, keepBaseUrl } from '../../route';
import { runTurn, type TurnContext, type TurnStart } from '../../turn';
import type { AgentProvider, AgentRunInput, AgentRunResult } from '../../types';
import { projectDshNotification } from './events';
import { loadDshSdk } from './sdk';

const logger = createLogger('agents/dsh');

async function startDsh(context: TurnContext): Promise<TurnStart> {
  const { input } = context;
  const sdk = await loadDshSdk();
  const env = buildSubprocessEnv({
    homeDir: input.configHome,
    injected: {
      DEEPSEEK_BASE_URL: keepBaseUrl(input.route.baseUrl),
      DEEPSEEK_API_KEY: input.route.apiKey,
      DSH_HOME: input.configHome,
    },
  });
  const runtime = await sdk.createRuntime({
    cwd: input.cwd,
    env,
    model: input.route.modelId,
    prompt: input.prompt,
    permissionProfile: 'workspace-write',
  });
  logger.debug('dsh 已注入路由并启动运行时', {
    model: input.route.modelId,
    baseUrl: env.DEEPSEEK_BASE_URL,
  });
  return {
    stream: runtime.notifications,
    // 刻意空实现：dsh 不支持中途取消（元数据 cancelMidTurn: false，§5.6.2），
    // 停止请求会由第二段兜底成「关闭运行时」
    interrupt: () => {
      logger.debug('dsh 不支持中途取消，停止请求交由第二段强制关闭处理');
    },
    dispose: createDisposer(() => runtime.close()),
    project: (raw, state) => projectDshNotification(raw, state, { kind: 'dsh', baseUrl: input.route.baseUrl }),
  };
}

export const dshProvider: AgentProvider = {
  kind: 'dsh',
  displayName: 'DeepSeek Harness',
  metadata: {
    protocolType: 'openai',
    capability: {
      cancelMidTurn: false, // 界面上的「终止」在该行退化为「关闭运行时」，文案必须不同
      // 探测前取保守值 false：该 SDK 的 usage 通知字段名未知，探不到就不该让界面显示 0（§5.6.3）
      // 探测若采到 usage，这一格与 providers/dsh/events.ts 必须**同一次提交**改成 true（回写任务）
      usage: false,
    },
    isolation: 'subprocess',
  },
  run: (input: AgentRunInput): Promise<AgentRunResult> => runTurn(input, { kind: 'dsh', start: startDsh }),
};
```

- [ ] **Step 8: 运行确认通过**

Run: `pnpm --filter @aieval/agents test`
Expected: PASS（`dsh` 的 events 4 例 + index 5 例；**index 已按实测订正**——初稿写的 4 例是旧快照；Task 12 路径 A 若追加 dsh 用例，本行数字要同步）。

Run: `pnpm --filter @aieval/agents typecheck`
Expected: 通过。

- [ ] **Step 9: 变异验证（守卫：终止走第二段 + 不猜计量）**

**守卫 A —— 终止必须落 WARN 且关闭恰好一次（Review Focus #3）**

1. `Get-FileHash packages/server/agents/src/providers/dsh/index.ts -Algorithm SHA256`（记为 H-dsh）。
2. 变异体：把 dsh 的 `interrupt` 从空实现改成直接关闭运行时——`interrupt: () => { void runtime.close(); }`。这会让「第二段」不再被执行（interrupt 一出手流就结束了）。
3. Run: `pnpm --filter @aieval/agents test`；Expected: **FAIL**，`index.test.ts` 的「终止：interrupt 不被响应 → 5 秒后落 WARN」报找不到 `[WARN]` 事件（`expected undefined to contain '5 秒'`）。
4. 还原，重跑：Expected: PASS；`Get-FileHash` 与 H-dsh 一致。

**守卫 B —— 探测前不得发明计量（§5.6.3）**

1. `Get-FileHash packages/server/agents/src/providers/dsh/events.ts -Algorithm SHA256`（记为 H-dev）。
2. 变异体：在 `projectDshNotification` 的默认分支里把 `tokens: null` 改成 `tokens: { input: 0, cached: 0, output: 0 }`（用 0 冒充「没采到」）。
3. Run: `pnpm --filter @aieval/agents test`；Expected: **FAIL**，`events.test.ts` 的「计量一律 null（不是 0）」报 `expected { input: 0, cached: 0, output: 0 } to be null`。
4. 还原，重跑：Expected: PASS；`Get-FileHash` 与 H-dev 一致。

- [ ] **Step 10: 提交**

```bash
git add packages/server/agents/src/providers/dsh/sdk.ts packages/server/agents/src/providers/dsh/events.ts packages/server/agents/src/providers/dsh/index.ts packages/server/agents/src/providers/dsh/events.test.ts packages/server/agents/src/providers/dsh/index.test.ts packages/server/agents/src/testing/agent-fixtures.ts
git commit -m "feat(agents): dsh 适配器（/v1 保留、关闭式释放、探测前不猜计量）"
```

---

## Task 10: 注册表、公共出口与 F2 元数据回归网

**Files:**
- Create: `packages/server/agents/src/registry.ts`
- Create: `packages/server/agents/src/registry.test.ts`
- Modify: `packages/server/agents/src/index.ts`（把 `export {};` 换成真实出口）
- Modify: `packages/server/agents/src/static-assertions.test.ts`（追加「不做目录扫描」用例）

**Interfaces:**
- Consumes: Task 7/8/9 的三个 provider、Task 1 的 `AgentKind` / `AgentProvider` / `AgentProviderMetadata`、Task 6 的测试支撑
- Produces: `getProvider(kind: AgentKind): AgentProvider`、`listAgentProviders(): AgentProvider[]`；包出口 `@aieval/agents` → `getProvider` / `listAgentProviders` / 全部对外类型

- [ ] **Step 1: 写失败测试 `registry.test.ts`**

```ts
// @vitest-environment node
/**
 * 注册表：三家齐备、元数据与 spec §5.6.2 的表逐格一致、未注册 id 抛错且信息含可用清单。
 * 元数据那条是 F2（候选池按协议过滤）的**回归网**：表单读的是这里，不是另一份独立的对应关系表，
 * 所以任何一格改动（哪怕只是 usage 从 false 翻成 true）都必须与 provider 实现同一次提交里改掉期望。
 */
import { AGENT_KINDS, ProtocolTypeSchema } from '@aieval/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { CLAUDE_PACKAGE_NAME } from './providers/claude-code/sdk';
import { CODEX_PACKAGE_NAME } from './providers/codex/sdk';
import { DSH_PACKAGE_NAME } from './providers/dsh/sdk';
import { getProvider, listAgentProviders } from './registry';
import { setAgentRuntimeForTesting } from './runtime';
import {
  createFakeCodexSdk,
  createFakeDshSdk,
  createRecorder,
  createRunInput,
} from './testing/agent-fixtures';
import type { AgentKind, AgentProviderMetadata } from './types';

afterEach(() => {
  setAgentRuntimeForTesting(null);
});

/** spec §5.6.2 的表：dsh 的 usage 是唯一随探测结果变化的格子（见「实现层修正」第 7 条） */
const EXPECTED_METADATA: Record<AgentKind, AgentProviderMetadata> = {
  'claude-code': {
    protocolType: 'anthropic',
    capability: { cancelMidTurn: true, usage: true },
    isolation: 'subprocess',
  },
  codex: {
    protocolType: 'openai',
    capability: { cancelMidTurn: true, usage: true },
    isolation: 'subprocess',
  },
  dsh: {
    protocolType: 'openai',
    capability: { cancelMidTurn: false, usage: false },
    isolation: 'subprocess',
  },
};

describe('listAgentProviders', () => {
  it('三家齐备且与 contracts 的 AGENT_KINDS 同序', () => {
    expect(listAgentProviders().map((provider) => provider.kind)).toEqual([...AGENT_KINDS]);
  });

  it('返回副本：调用方改不到注册表本身', () => {
    const first = listAgentProviders();
    first.pop();
    expect(listAgentProviders()).toHaveLength(3);
  });

  it('displayName 非空且互不相同（界面上要能区分）', () => {
    const names = listAgentProviders().map((provider) => provider.displayName);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name.length).toBeGreaterThan(0);
  });
});

describe('元数据投影（F2 的回归网）', () => {
  it('三家与 spec §5.6.2 的表逐格一致', () => {
    for (const provider of listAgentProviders()) {
      expect(provider.metadata).toEqual(EXPECTED_METADATA[provider.kind]);
    }
  });

  it('protocolType 取值落在 contracts 的协议类型里（前端过滤不会拿到悬空值）', () => {
    for (const provider of listAgentProviders()) {
      expect(ProtocolTypeSchema.options).toContain(provider.metadata.protocolType);
    }
  });
});

describe('getProvider', () => {
  it('按 kind 解析到同一个实例（编排层只按 kind 查，不持有运行时对象）', () => {
    expect(getProvider('codex')).toBe(getProvider('codex'));
  });

  it('未注册的 id 抛错，且错误信息含可用清单（§5.6.7）', () => {
    const call = (): unknown => getProvider('gemini' as AgentKind);
    expect(call).toThrow(/未注册的智能体/);
    expect(call).toThrow(/claude-code/);
    expect(call).toThrow(/codex/);
    expect(call).toThrow(/dsh/);
  });
});

describe('加载降级：失败面收窄到单家（Review Focus #4）', () => {
  it('只有坏掉的那家失败，其余两家照常运行（整包仍可导入）', async () => {
    const dshRecorder = createRecorder();
    setAgentRuntimeForTesting({
      sdkModule: {
        [CLAUDE_PACKAGE_NAME]: {}, // 装坏了：形状不对
        [CODEX_PACKAGE_NAME]: createFakeCodexSdk({ recorder: createRecorder(), events: [] }),
        [DSH_PACKAGE_NAME]: createFakeDshSdk({ recorder: dshRecorder, events: [] }),
      },
    });
    const claudeResult = await getProvider('claude-code').run(createRunInput());
    expect(claudeResult.error?.code).toBe('AGENT_LOAD_FAILED');
    const codexResult = await getProvider('codex').run(createRunInput());
    expect(codexResult.ok).toBe(true);
    const dshResult = await getProvider('dsh').run(createRunInput());
    expect(dshResult.ok).toBe(true);
    expect(dshRecorder.closeCount).toBe(1);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @aieval/agents test`
Expected: FAIL —— `Failed to resolve import "./registry"`。

- [ ] **Step 3: 写 `src/registry.ts`**

```ts
/**
 * provider 注册表：kind → AgentProvider（A3 的落地点）。
 * 为什么显式静态注册而不是目录扫描：打包后 `readdirSync` 不可靠；注册表同时承载「协议兼容性 /
 * 终止能力 / 隔离级别」元数据，是前端候选池过滤与编排层判断的**唯一**查询点（包内有静态断言
 * 禁止出现目录扫描）。
 * 注意：清单顺序 = `listAgentProviders()` 的顺序 = 前端下拉顺序，必须与 contracts 的 AGENT_KINDS 同序。
 */
import { claudeCodeProvider } from './providers/claude-code';
import { codexProvider } from './providers/codex';
import { dshProvider } from './providers/dsh';
import type { AgentKind, AgentProvider } from './types';

/** 显式静态注册表：加第四家 = 加一个 `providers/<id>/` 目录 + 这里一行，编排层与表单不改（A3） */
const PROVIDERS: readonly AgentProvider[] = [claudeCodeProvider, codexProvider, dshProvider];

const BY_KIND: ReadonlyMap<AgentKind, AgentProvider> = new Map(
  PROVIDERS.map((provider) => [provider.kind, provider] as const),
);

/** 按 kind 解析 provider；未注册的 kind 抛错，错误信息必须含可用清单（§5.6.7） */
export function getProvider(kind: AgentKind): AgentProvider {
  const provider = BY_KIND.get(kind);
  if (provider === undefined) {
    const available = listAgentProviders()
      .map((item) => item.kind)
      .join(' / ');
    throw new Error(`[agents] 未注册的智能体：${String(kind)}；可用清单：${available}`);
  }
  return provider;
}

/** 全部 provider（返回副本：调用方改不到注册表本身） */
export function listAgentProviders(): AgentProvider[] {
  return [...PROVIDERS];
}
```

- [ ] **Step 4: 改写 `src/index.ts`**

```ts
/**
 * agents 包公共出口：**只**导出注册表与类型（契约 §4）。
 * `providers/*`、`runtime.ts`、`turn.ts`、`testing/*` 一律不外露：编排层只认 `getProvider`，
 * 三家差异全部被挡在包内（A1）。
 * 注意：p4 若要伪造适配器，请 `vi.mock('@aieval/agents')`，不要伸进包内部——包 exports 也只映射 `.`。
 */
export { getProvider, listAgentProviders } from './registry';
export {
  AGENT_KINDS,
  type AgentErrorCode,
  type AgentExitReason,
  type AgentKind,
  type AgentProvider,
  type AgentProviderMetadata,
  type AgentRunInput,
  type AgentRunResult,
  type ProtocolType,
} from './types';
```

- [ ] **Step 5: 追加「不做目录扫描」断言**

在 `src/static-assertions.test.ts` 里追加一条用例（仍放在 `describe('源码级不变量', …)` 内）：

```ts
  it('注册表是显式静态注册，包内不出现目录扫描（A3：打包后 readdirSync 不可靠）', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      const text = readFileSync(join(import.meta.dirname, file), 'utf8');
      if (/\breaddir(Sync)?\s*\(/.test(text)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
```

> **两条必须沿用的口径（p3 T3/T4 的实现者实测上报，别自己另发明一套）**：
> 1. **必须复用文件里已有的 `sourceFiles()`**，不要另写一个遍历：`sourceFiles()` 自己就用了 `readdirSync(..., { recursive: true })`，
>    它与本断言要禁的模式**同形**，全靠「排除 `*.test.ts`」这个过滤器才不自我违规（`static-assertions.test.ts` 是本包唯一允许出现 `readdirSync` 的文件）。
>    自己新写一个遍历（尤其是忘了排除测试文件的那种）会让这条断言要么永远红、要么扫不到源码。
> 2. **扫描面 = `src/**` 下扩展名白名单里的文件，排除 `*.test.ts`**。白名单**已由 T3/T4 评审的 F2 修复扩到
>    `.ts | .mts | .cts | .js | .mjs | .cjs`**（原先只认 `.ts`，往 `src/` 放一个 `.mjs` 就能整份绕开扫描）。
>    仍**不覆盖**：`probe/`（在 `src/` 之外，是人工探测脚本的地盘）与任何 `.test.ts`（本文件自己的正则字面量与
>    变异体样本会把规则判成违规）。⇒ 你在 T10 追加断言时**必须**沿用同一个 `sourceFiles()`；
>    若将来有人再动白名单，T5 与 T10 的断言要一起复核。
>    知道边界在哪，比以为「全包都扫了」安全。

- [ ] **Step 6: 运行确认通过**

Run: `pnpm --filter @aieval/agents test`
Expected: PASS（`registry.test.ts` 8 例 + 静态断言 7 例全绿；**计数已按实测订正**——初稿写的「静态断言 3 例 / 整包 60+ 例」是旧快照；p3 收尾实测 18 个测试文件 155 例，见 `phase-fix-report.md`）。

Run: `pnpm --filter @aieval/agents typecheck`
Expected: 通过。

Run: `pnpm typecheck`
Expected: 8 个包全部通过（`agents` 的出口已被 `evaluator`/`api` 的现有空壳容忍——它们还没 import 这些名字）。

- [ ] **Step 7: 变异验证（三条守卫，逐条做）**

**守卫 A —— 协议元数据投影（F2 的回归网，必做）**

1. `Get-FileHash packages/server/agents/src/providers/codex/index.ts -Algorithm SHA256`（记为 H-cx）。
2. 变异体：把 codex 的 `metadata.protocolType` 从 `'openai'` 改成 `'anthropic'`。
3. Run: `pnpm --filter @aieval/agents test`；Expected: **FAIL**，`registry.test.ts` 的「三家与 spec §5.6.2 的表逐格一致」报 `expected { protocolType: 'anthropic', … } to deeply equal { protocolType: 'openai', … }`（失败信息里能直接看出是 codex 那一行）。
4. 还原，重跑：Expected: PASS；`Get-FileHash` 与 H-cx 一致。

**守卫 B —— 未注册 id 的错误信息必须含可用清单**

1. `Get-FileHash packages/server/agents/src/registry.ts -Algorithm SHA256`（记为 H-reg）。
2. 变异体：把 `const available = …` 那段删掉，错误信息改成 `` `[agents] 未注册的智能体：${String(kind)}` ``。
3. Run: `pnpm --filter @aieval/agents test`；Expected: **FAIL**，`getProvider` 的「未注册的 id 抛错」报 `expected [Function] to throw error matching /claude-code/`。
4. 还原，重跑：Expected: PASS；`Get-FileHash` 与 H-reg 一致。

**守卫 C —— 不做目录扫描**

1. `Get-FileHash packages/server/agents/src/static-assertions.test.ts -Algorithm SHA256`（记为 H-static3）。
2. 变异体：在 `src/registry.ts` 里加一行 `readdirSync('.');`（并为了通过编译把它从 `node:fs` import 进来）。
3. Run: `pnpm --filter @aieval/agents test`；Expected: **FAIL**，静态断言报 `offenders` 含 `registry.ts`。
4. 还原（把那一行与 import 一起删掉），重跑：Expected: PASS；`Get-FileHash src/static-assertions.test.ts` 与 H-static3 一致，`registry.ts` 回到 H-reg。

- [ ] **Step 8: 提交**

```bash
git add packages/server/agents/src/registry.ts packages/server/agents/src/registry.test.ts packages/server/agents/src/index.ts packages/server/agents/src/static-assertions.test.ts
git commit -m "feat(agents): provider 注册表与公共出口（显式静态注册 + F2 元数据回归网）"
```

---

## Task 11: 真实事件探测（人工任务，不阻塞任何实现任务）

> **本任务不阻塞 Task 1–10 与 Task 12 的代码工作**：适配器已按「探测前口径」写死（未识别一律保留、
> 计量一律不猜）。**但初稿那句「探测只影响两处（dsh 的 `usage` 一格 + dsh 的用量字段名）」已被实测证伪**
> （阶段评审 H1，三处行号逐行复核）：真实差异是 **dsh 入口 API 的整体形态**。
> 已安装的 `@deepseek-ai/dsh-sdk-client@0.1.7-rc.1` 的**值出口**是
> `["DeepSeekHarness","HarnessClient","HarnessSession","JsonRpcResponseError","RequestTimeoutError","SdkProtocolError","TransportClosedError"]`
> —— **没有 `createRuntime`**（本仓 `providers/dsh/sdk.ts` 里的 `createRuntime` 是**探测前的假设入口**；
> 安装态包里 grep `createRuntime` 命中 **0** 次）。真实入口形态是：
> `new DeepSeekHarness(options)` → `harness.run(prompt, { onNotification })` → `RunResult`
> （`sessionId` / `finalResponse` / `events` / `notifications`）、通知走
> `client.subscribe(filter)` → `NotificationSubscription`（`next` / `tryNext` / `close`）、
> 停止只能靠 `harness.close()` 的 EOF→SIGTERM→SIGKILL 阶梯（`lib/types/api.d.ts`、`lib/types/client.d.ts`）。
> ⇒ 探测的落点至少包含：**入口形态**（`providers/dsh/sdk.ts`）＋**通知订阅形态**（`providers/dsh/index.ts`
> 的 `stream` / `interrupt` / `dispose`）＋**夹具的假 SDK 形状**（`src/testing/agent-fixtures.ts` 与
> 它的回归网 `agent-fixtures.test.ts`）＋两个 dsh 测试文件＋`§5.6.2` 元数据表里 dsh 的 `usage` 一格
> 与用量字段名。**Task 12 的 `Files:` 清单已按此补全**，下面 **Step 0** 是「先 dump 真实入口形态、
> 再据实测写探测脚本」。
> 建议在 Task 7 一结束就尽早启动（它需要人工准备真实网关与密钥、并会产生真实费用），跑完再进 Task 12。

**Files:**
- Create: `packages/server/agents/probe/raw-events.mts`
- Create: `docs/superpowers/notes/2026-09-22-features-p3-agent-probe.md`（探测报告，**要提交**）
- 产物（**不提交**，已 gitignore）：`packages/server/agents/probe/dumps/<kind>.json`

**Interfaces:**
- Consumes: 无（脚本刻意不 import 本包的实现：探测要看到**原始**事件流，不能经过我们自己的投影）
- Produces: 三家的事件类型清单与计量字段名结论，**以及 dsh 的真实入口形态**（导出面 / `run`·`subscribe`·`close` 签名 / 通知外形 / 失败通道，见 Step 0）→ 供 Task 12 回写元数据、投影与 dsh 适配器入口

- [ ] **Step 0: 先 dump 真实入口形态（写探测脚本之前，先让真实包自己说话）**

**为什么排在第一步**（阶段评审 H1）：初稿的 `probeDsh` 直接断言并调用 `sdk.createRuntime(...)`，而真实包
**没有这个导出** ⇒ 探测脚本第一步就 `TypeError`，dsh 这条线根本跑不起来。探测脚本刻意不 import 本包的实现，
所以它**不会**继承 `sdk.ts` 的形状校验，只会自己崩。⇒ **先 dump，再按实测写脚本**：

```powershell
cd packages/server/agents
# ① 值出口面（真实运行时导出，逐字贴进探测报告的 §2 / §3）
node -e "import('@deepseek-ai/dsh-sdk-client').then((m) => console.log(JSON.stringify(Object.keys(m).sort(), null, 2)))"
# ② 入口签名与事件形态：api=DeepSeekHarness.run / client=HarnessClient.subscribe+close / types=通知与 RunResult / launch=子进程与环境选项
Get-Content node_modules\@deepseek-ai\dsh-sdk-client\lib\types\index.d.ts
Get-Content node_modules\@deepseek-ai\dsh-sdk-client\lib\types\api.d.ts, node_modules\@deepseek-ai\dsh-sdk-client\lib\types\client.d.ts, node_modules\@deepseek-ai\dsh-sdk-client\lib\types\types.d.ts, node_modules\@deepseek-ai\dsh-sdk-client\lib\types\launch.d.ts
# ③ 落点确认：本仓假设的入口在真实包里不存在（期望 0 命中）
Select-String -Path node_modules\@deepseek-ai\dsh-sdk-client\lib\*.js -Pattern "createRuntime"
```

**Step 0 必须回答的五件事**（逐条写进 `docs/superpowers/notes/2026-09-22-features-p3-agent-probe.md`，Task 12 按它回写）：

1. **真实值出口清单**（逐字，含顺序无关的排序结果）——「本仓假设的入口在不在里面」；
2. **三个真实签名**：`new DeepSeekHarness(options)` / `harness.run(input, options)`（含 `onNotification`
   的回调参数类型）/ `harness.close()`，以及低层 `client.subscribe(filter)` 与 `client.close()`；
3. **通知的外形**：`HarnessNotification` 是 `{ method, params }`——**不是** `{ type, message }`。
   本仓 `providers/dsh/events.ts` 今天按 `type` 读，这是 Task 12 要回写的第一处（「未知 type 一律保留原始负载」
   这条口径不变，变的只是「哪条通知是什么」的判定依据）；
4. **失败怎么表达**（**先于用量**，见 Step 2 判定标准第 5 条）：一条失败的通知？还是 `RunResult` 上的标记？
5. **注入落点**：`DeepSeekHarnessOptions`（`cwd` / `provider` / `model` / `env` / `dshHome` / `processCwd`）
   与 §5.6.4 的表逐格对照。**注意 `env` 是「整体替换父进程环境」语义**（`lib/types/types.d.ts` 的
   `HarnessClientOptions.env`：传对象就在 spawn 时替换父环境）——与 §5.6.4 的「替换型子进程环境」同向，
   但字段名与落点以 dump 为准。

实测结果与本清单不符（SDK 升级）⇒ **以 Step 0 的 dump 为准**，并在探测报告里写明差异。

- [ ] **Step 1: 前置条件（逐条确认后再跑）**

1. 有一个可用的网关与密钥，且**三家模型都能通**（同一网关也可以，只要它分别兼容 Anthropic / Responses / OpenAI 兼容协议）。
2. 三家 CLI 可用：`claude --version`、`codex --version`、dsh 对应的可执行文件（探测脚本的报错会点名缺失的可执行文件）。
3. 一个**最小**仓库目录当作 `cwd`（几个文件的示例项目即可；探测只跑一条最短提示词，遵守 §9 的成本护栏）。
4. 环境变量（**不入库、不写进任何文件**）：

   | 变量 | 含义 |
   |---|---|
   | `AIEVAL_PROBE_BASE_URL` | 网关根地址（三家用同一个也可以，脚本按各家规则规范化） |
   | `AIEVAL_PROBE_API_KEY` | 密钥 |
   | `AIEVAL_PROBE_MODEL` | 该家要用的模型名 |
   | `AIEVAL_PROBE_CWD` | 最小仓库目录的绝对路径 |
   | `AIEVAL_PROBE_PROMPT` | 可选；不给就用脚本里的默认最小提示词 |

- [ ] **Step 2: 写探测脚本 `probe/raw-events.mts`**

```ts
/**
 * 真实事件探测（spec §5.6.3 的实施前置 / §11 第 5 步）。
 * 做什么：对指定的一家智能体跑一条最小任务，把**原始事件流**与**注入对象原文** dump 到 probe/dumps/。
 * 怎么跑（人工，需要真实网关与密钥，会产生真实费用，每家只跑一次）：
 *   node packages/server/agents/probe/raw-events.mts --kind=claude-code
 *   node packages/server/agents/probe/raw-events.mts --kind=codex
 *   node packages/server/agents/probe/raw-events.mts --kind=dsh
 * 注意：
 *  - 本文件**不在** `src/` 下，因此不进 `pnpm typecheck` / `pnpm test`（单测一律不碰真实 API）；
 *  - 它刻意不 import 本包的实现：探测要看到未经我们投影的原始事件（字段名以它为准，§5.6.3）；
 *  - dump 里可能混进密钥：写盘前一律 redact（把密钥替换成 ***）；
 *  - Node 24 直接跑 .mts（类型剥离），不需要额外工具链。
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DUMP_DIR = join(HERE, 'dumps');
const MAX_EVENTS = 500;

interface ProbeEnv {
  baseUrl: string;
  apiKey: string;
  modelId: string;
  cwd: string;
  prompt: string;
  configHome: string;
}

interface ProbeResult {
  injected: unknown;
  events: unknown[];
}

// 三家的 base URL 口径（与 §5.6.4 的表一致；这里独立实现，避免探测依赖被测代码）
const trimSlash = (url: string): string => url.replace(/\/+$/, '');
const stripV1 = (url: string): string => trimSlash(url).replace(/\/v1$/, '');
const ensureV1 = (url: string): string => (/\/v1$/.test(trimSlash(url)) ? trimSlash(url) : `${trimSlash(url)}/v1`);
const keepV1 = (url: string): string => trimSlash(url);

function readArg(name: string): string | null {
  const prefix = `--${name}=`;
  const hit = process.argv.slice(2).find((raw) => raw.startsWith(prefix));
  return hit === undefined ? null : hit.slice(prefix.length);
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    console.error(`[probe] 缺少环境变量 ${name}（见本文件头部的运行说明）`);
    process.exit(2);
  }
  return value;
}

/** 把密钥从产物里抹掉：dump 会被人打开看，也可能被贴进报告 */
function redact(text: string, secrets: readonly string[]): string {
  let output = text;
  for (const secret of secrets) {
    if (secret !== '') output = output.split(secret).join('***');
  }
  return output;
}

function writeDump(kind: string, payload: unknown, secrets: readonly string[]): string {
  mkdirSync(DUMP_DIR, { recursive: true });
  const file = join(DUMP_DIR, `${kind}.json`);
  writeFileSync(file, redact(JSON.stringify(payload, null, 2), secrets), 'utf8');
  return file;
}

async function probeClaudeCode(env: ProbeEnv): Promise<ProbeResult> {
  const sdk = (await import('@anthropic-ai/claude-agent-sdk')) as {
    query: (params: { prompt: string; options: Record<string, unknown> }) => AsyncIterable<unknown> & {
      interrupt?: () => unknown;
    };
  };
  const injected = {
    env: {
      HOME: env.configHome,
      USERPROFILE: env.configHome,
      CLAUDE_CONFIG_DIR: env.configHome,
      ANTHROPIC_BASE_URL: stripV1(env.baseUrl),
      ANTHROPIC_API_KEY: env.apiKey,
      ANTHROPIC_AUTH_TOKEN: env.apiKey,
    },
    options: { cwd: env.cwd, model: env.modelId, settingSources: [], maxTurns: 8 },
  };
  const query = sdk.query({
    prompt: env.prompt,
    options: { ...injected.options, env: { ...process.env, ...injected.env }, abortController: new AbortController() },
  });
  const events: unknown[] = [];
  for await (const message of query) {
    events.push(message);
    if (events.length >= MAX_EVENTS) {
      await query.interrupt?.();
      break;
    }
  }
  return { injected, events };
}

async function probeCodex(env: ProbeEnv): Promise<ProbeResult> {
  const sdk = (await import('@openai/codex-sdk')) as {
    Codex: new (options: Record<string, unknown>) => {
      startThread: (options: Record<string, unknown>) => {
        runStreamed: (
          prompt: string,
          options: { signal: AbortSignal },
        ) => Promise<{ events: AsyncIterable<unknown> }>;
      };
    };
  };
  const baseUrl = ensureV1(env.baseUrl);
  const config = {
    model_provider: 'aieval',
    model_providers: {
      aieval: {
        name: 'aieval gateway',
        base_url: baseUrl,
        wire_api: 'responses',
        requires_openai_auth: true,
        request_max_retries: 1,
      },
    },
    disable_response_storage: true,
    tools: { multi_agent: false, web_search: false },
  };
  const threadOptions = {
    model: env.modelId,
    workingDirectory: env.cwd,
    sandboxMode: 'workspace-write',
    approvalPolicy: 'never',
    skipGitRepoCheck: true,
  };
  const injected = {
    client: { baseUrl, config },
    env: { HOME: env.configHome, USERPROFILE: env.configHome, CODEX_HOME: env.configHome },
    thread: threadOptions,
  };
  const client = new sdk.Codex({
    apiKey: env.apiKey,
    baseUrl,
    config,
    env: { ...process.env, ...injected.env },
  });
  const thread = client.startThread(threadOptions);
  const abort = new AbortController();
  const { events: stream } = await thread.runStreamed(env.prompt, { signal: abort.signal });
  const events: unknown[] = [];
  for await (const event of stream) {
    events.push(event);
    if (events.length >= MAX_EVENTS) {
      abort.abort();
      break;
    }
  }
  return { injected, events };
}

async function probeDsh(env: ProbeEnv): Promise<ProbeResult> {
  const sdk = (await import('@deepseek-ai/dsh-sdk-client')) as Record<string, unknown>;
  // 第一件事：dump 真实出口面。探测脚本刻意不 import 本包的实现，所以「形状对不对」只能由它自己当场说清楚；
  // 初稿在这里断言 `sdk.createRuntime` 并调用它 —— 真实包没有这个导出，第一步就 TypeError（评审 H1）。
  const exportNames = Object.keys(sdk).sort();
  const Harness = sdk.DeepSeekHarness;
  if (typeof Harness !== 'function') {
    throw new Error(`[probe] dsh 出口面与 Step 0 的 dump 不符，实测导出：${exportNames.join(' / ')}`);
  }
  const injected = {
    env: {
      HOME: env.configHome,
      USERPROFILE: env.configHome,
      DSH_HOME: env.configHome,
      DEEPSEEK_BASE_URL: keepV1(env.baseUrl),
      DEEPSEEK_API_KEY: env.apiKey,
    },
    options: { cwd: env.cwd, model: env.modelId, dshHome: env.configHome },
  };
  const events: unknown[] = [];
  const harness = new (Harness as new (options: Record<string, unknown>) => {
    run: (input: string, options: Record<string, unknown>) => Promise<unknown>;
    close: () => Promise<void>;
  })({
    ...injected.options,
    // `env` 是「整体替换父进程环境」语义（lib/types/types.d.ts）⇒ 展开宿主环境后覆盖注入项
    env: { ...process.env, ...injected.env },
  });
  let runResult: unknown = null;
  try {
    // 高层入口一次拿到「这一次运行」的全部通知；若 dump 显示 onNotification 漏掉了空闲期的通知，
    // 改用低层 `harness.client.subscribe()`（Step 0 的第 2 条已 dump 它的签名）
    runResult = await harness.run(env.prompt, {
      onNotification: (notification: unknown) => {
        if (events.length < MAX_EVENTS) events.push(notification);
      },
    });
  } finally {
    // dsh 没有中途取消（`cancelMidTurn: false`，SDK 的 close JSDoc 写着没有 wire-level cancel）：
    // 结束探测靠关闭运行时（否则会留下孤儿子进程）
    await harness.close();
  }
  // RunResult 本身也要 dump：失败可能写在它上面（例如 `finalResponse` 为空、`events` 里有失败态），
  // 而不是一条失败通知——这正是 Step 2 判定标准第 5 条要核的事（评审 L2）
  events.push({ __runResult: runResult, __exportNames: exportNames });
  return { injected, events };
}

const PROBES: Record<string, (env: ProbeEnv) => Promise<ProbeResult>> = {
  'claude-code': probeClaudeCode,
  codex: probeCodex,
  dsh: probeDsh,
};

const kind = readArg('kind') ?? 'claude-code';
const probe = PROBES[kind];
if (probe === undefined) {
  console.error(`[probe] 未知的 --kind=${kind}；可选：${Object.keys(PROBES).join(' / ')}`);
  process.exit(2);
}

const env: ProbeEnv = {
  baseUrl: requireEnv('AIEVAL_PROBE_BASE_URL'),
  apiKey: requireEnv('AIEVAL_PROBE_API_KEY'),
  modelId: requireEnv('AIEVAL_PROBE_MODEL'),
  cwd: requireEnv('AIEVAL_PROBE_CWD'),
  prompt: process.env.AIEVAL_PROBE_PROMPT ?? '在这个仓库里新建文件 PROBE.txt，内容写一行 probe，然后结束。',
  configHome: mkdtempSync(join(tmpdir(), 'aieval-probe-')),
};

const result = await probe(env);
const file = writeDump(
  kind,
  {
    kind,
    at: new Date().toISOString(),
    baseUrl: env.baseUrl,
    modelId: env.modelId,
    cwd: env.cwd,
    injected: result.injected,
    eventCount: result.events.length,
    events: result.events,
  },
  [env.apiKey],
);

const counts = new Map<string, number>();
for (const event of result.events) {
  const type = typeof (event as { type?: unknown }).type === 'string' ? String((event as { type: string }).type) : '<无 type>';
  counts.set(type, (counts.get(type) ?? 0) + 1);
}
const rawText = JSON.stringify(result.events);
console.log(`[probe] ${kind}：${result.events.length} 条事件 → ${file}`);
console.log('[probe] 事件类型分布（原样粘进探测报告的「实测事件类型」一节）：');
for (const [type, count] of counts) console.log(`  ${type} × ${count}`);
console.log(`[probe] 事件流里出现 "usage"：${rawText.includes('usage')}；出现 "token"：${rawText.includes('token')}`);
```

- [ ] **Step 3: 跑探测（每家一次，别复跑）**

```powershell
$env:AIEVAL_PROBE_BASE_URL = '<网关根地址>'
$env:AIEVAL_PROBE_API_KEY  = '<密钥>'
$env:AIEVAL_PROBE_MODEL    = '<模型名>'
$env:AIEVAL_PROBE_CWD      = '<最小仓库目录>'
node packages/server/agents/probe/raw-events.mts --kind=claude-code
node packages/server/agents/probe/raw-events.mts --kind=codex
node packages/server/agents/probe/raw-events.mts --kind=dsh
```

**期望产物**：`packages/server/agents/probe/dumps/` 下出现三个文件，每个都含 `injected`（注入对象原文）与 `events`（原始事件流）；stdout 打出每家的「事件类型分布」与两句 `usage` / `token` 出现性判断。

**判定标准（逐条核对，任何一条不满足都要在报告里写明并停下来讨论）**：

1. 三家各拿到 `eventCount ≥ 1`；只要某家一条事件都没有，说明探测前置条件（CLI / 网关）没配好，先修前置条件再重跑，**不要**据此回写元数据。
2. `injected` 里的 base URL 与 §5.6.4 的表逐条对上（claude 无 `/v1` 结尾、codex 有 `/v1`、dsh 保留 `/v1`）。
3. claude 的 `result` 消息里确实有 `usage`（记录 `input_tokens` / `cache_read_input_tokens` / `output_tokens` 的真实键名）与 `num_turns`。
4. codex 的 `turn.completed` 里确实有 usage 负载（记录真实键名，重点核对缓存读那个键到底叫什么）。
5. **dsh 的失败通道形状必须显式给出（先于用量核对，评审 L2）**：写清楚「一次失败的运行在 dump 里长什么样」
   ——是哪条通知的哪个 `method` + `params` 路径，还是 `RunResult` 上的标记（`finalResponse` 为空 /
   `events` 里有失败态）。本仓 `providers/dsh/events.ts` 今天**只假设了一处形状**：`type: 'error'` + `message`
   ——而真实通知的外形是 `{ method, params }`。若失败根本不长这样，一次失败的运行会被投影成普通日志、
   骨架返回 `ok: true, completed`（「界面显示成功、实际没干活」）⇒ 这一格的结论直接决定 Task 12 怎么改投影。
6. **dsh 的 usage 结论必须显式给出**：要么写出「哪条通知的哪个字段路径下有什么字段」，要么明确写「整条流里没有任何 usage 载荷」——两者都能落地（前者 → Task 12 打开提取并把元数据改成 `true`；后者 → 保持 `usage: false`）。
7. 密钥复核（dump 已被脚本 redact，再人工确认一次）：

   ```powershell
   Select-String -Path packages/server/agents/probe/dumps/*.json -Pattern $env:AIEVAL_PROBE_API_KEY -SimpleMatch
   ```

   Expected: **无任何匹配**。有匹配说明 redact 没覆盖到（例如密钥被网关以其他编码回显），把该 dump 删掉、修脚本再跑。

- [ ] **Step 4: 写探测报告 `docs/superpowers/notes/2026-09-22-features-p3-agent-probe.md`**

```markdown
# p3 适配器真实事件探测报告（2026-09-22）

上位文档：`docs/superpowers/specs/2026-09-22-features-design.md` §5.6.3 / §11 第 5 步
计划：`docs/superpowers/plans/2026-09-22-features-p3-agents.md` Task 11

**结论一句话**：<三家计量字段名是否与 §5.6.3 的表一致；dsh 是否有 usage>

## 1. 环境与命令

| 项 | 值 |
|---|---|
| 网关 host | <host，**不要写密钥**> |
| 模型 | claude-code: <> / codex: <> / dsh: <> |
| cwd | <最小仓库路径> |
| 提示词 | <脚本默认 或 自定义> |
| 命令 | `node packages/server/agents/probe/raw-events.mts --kind=<kind>`（三家各一次） |

dump 位置：`packages/server/agents/probe/dumps/<kind>.json`（已 gitignore，未提交）

## 2. 实测事件类型（把三家的 stdout 分布原样粘进来）

### claude-code
<粘贴>

### codex
<粘贴>

### dsh
<粘贴>

## 3. 计量字段名对照表

| kind | §5.6.3 的说法 | 实测 | 结论 |
|---|---|---|---|
| claude-code | `result` 的 `usage`（输入 / 缓存读 / 输出）+ `num_turns` | <实测键名> | <一致 / 需改 `providers/claude-code/events.ts` 的哪一行> |
| codex | `turn.completed` 携带的 usage 负载 | <实测键名> | <一致 / 需改 `providers/codex/events.ts` 的哪一行> |
| dsh | 待探测 | <有：字段路径与键名 / 无> | <usage: true / usage: false> |

## 4. 与 §5.6.2 元数据表的差异

<只有 dsh 的 usage 一格允许与计划不同；其余格子若与实测冲突，写明冲突点与建议>

## 5. 注入对象核对（§5.6.4）

| kind | 注入点 | dump 里的实际值 | 与 §5.6.4 一致？ |
|---|---|---|---|
| claude-code | `ANTHROPIC_BASE_URL` | <值> | <> |
| codex | `model_providers.<id>.base_url` / `wire_api` / `requires_openai_auth` | <值> | <> |
| dsh | `DEEPSEEK_BASE_URL` | <值> | <> |

## 6. 未覆盖与后续

<例如某家的 CLI 版本、某类事件没被触发、需要 p6 冒烟再确认的点>
```

- [ ] **Step 5: 提交报告（dump 不入库）**

```bash
git add packages/server/agents/probe/raw-events.mts docs/superpowers/notes/2026-09-22-features-p3-agent-probe.md
git commit -m "feat(agents): 真实事件探测脚本与三家计量字段名探测报告"
```

`.gitignore` 里的 `packages/server/agents/probe/dumps/` 已确保 dump 不会被 `git add` 带进来；提交前用 `git status --short` 复核一遍，出现 `probe/dumps/` 就是 ignore 没生效，先修再提交。

---

## Task 12: 按探测结果回写与收尾

**Files:**
- Modify: `packages/server/agents/src/providers/dsh/sdk.ts`（**入口形态重写**：`createRuntime` 是探测前的假设入口，
  真实包没有它 ⇒ 按 Step 0/探测 dump 的真实入口（`DeepSeekHarness` 等）重写窄结构与形状校验；
  `shape-mismatch` 的文案与「期望入口」参数在这一文件里）
- Modify: `packages/server/agents/src/providers/dsh/index.ts`（调用形态随之改：`startDsh` 的建运行时、事件流、
  停止通道都按真实入口写；`usage: false → true` 仅当探测到 usage）
- Modify: `packages/server/agents/src/providers/dsh/index.test.ts`（注入的假 SDK 形状与断言随 `sdk.ts` /
  `index.ts` 变，含加载失败文案那条；失败通道的用例按 Step 2 判定标准第 5 条的实测结论补）
- Modify: `packages/server/agents/src/testing/agent-fixtures.ts`（`createFakeDshSdk` 的假入口形状必须与
  真实入口**同形**——照旧形状建模就是复评 I1 的假绿）
- Modify: `packages/server/agents/src/testing/agent-fixtures.test.ts`（夹具回归网：假入口换形后，里面按
  `createRuntime` 写的格子要跟着改；**只改形状，不删格子**）
- Modify: `packages/server/agents/src/providers/dsh/events.ts`（**仅当**探测到 usage 时：按实测的通知
  `method` / `params` 路径与用量字段名打开提取；失败通道的形状若与今天假设的不同，也在这一处改）
- Modify: `packages/server/agents/src/providers/dsh/events.test.ts`（**仅当**探测到 usage 或失败形状变化时：追加/调整用例）
- Modify: `packages/server/agents/src/registry.test.ts`（**仅当**探测到 usage 时：同步 `EXPECTED_METADATA.dsh`）
- Modify: `packages/server/agents/src/providers/{claude-code,codex}/events.ts` 与它们的测试（**仅当**字段名与 §5.6.3 不一致时）
- Modify: `docs/superpowers/notes/2026-09-22-features-p3-agent-probe.md`（补「回写记录」小节）

**Interfaces:**
- Consumes: Task 11 的探测报告、Task 9 的 `projectDshNotification`、Task 7/8 的 `projectClaudeMessage` / `projectCodexEvent`
- Produces: 与实测一致的元数据表与用量提取；`pnpm --filter @aieval/agents test` / `pnpm typecheck` / `pnpm lint` / `pnpm test` 全绿

- [ ] **Step 1: 按真实入口重写 dsh，再按探测结论二选一改 usage（两条路径都要走完，不允许「先放着」）**

**第 0 步（无条件做，与「探没探到 usage」无关）——入口形态回写**：`providers/dsh/sdk.ts` 的
`createRuntime` 是**探测前的假设入口**，真实包没有这个导出（Step 0 的 dump 为证）⇒ 按 dump 里的真实入口
（`DeepSeekHarness` / `HarnessClient` / `HarnessSession`，含 `RunOptions.onNotification` 与通知的
`{ method, params }` 外形）重写 `sdk.ts` 的窄结构与形状校验，随之改 `index.ts`（建运行时 / 事件流 /
停止通道）与 `agent-fixtures.ts` 的**假入口**（必须与真实入口同形，否则就是复评 I1 的假绿），
`index.test.ts` 与 `agent-fixtures.test.ts` 跟着改形状。
**不做这一步，dsh 在真机上只有一条 `AGENT_LOAD_FAILED`**（文案已经是「已安装但不匹配」那一队，
见 `errors.ts` 的两种语义）。改完先跑 `pnpm --filter @aieval/agents test` 全绿，再进下面的路径 A / B。

**路径 A —— 探到了 usage**：把 dsh 的用量提取按 dump 里的**真实字段名**打开。**下面四处尖括号是探测产物，不是待补的脑补值**：从 `probe/dumps/dsh.json` 里逐字抄进来，抄完新增的用例必须通过。三个字段名只在 `events.ts` 里填一次，测试跟着走（这正是「字段名以探测结果为准」的执行方式）。

在 `providers/dsh/events.ts` 里加常量并改投影：

```ts
/**
 * dsh 的用量字段名与轮次结束通知类型：**逐字来自真实探测**
 * （docs/superpowers/notes/2026-09-22-features-p3-agent-probe.md §3）。
 * 抄写口径：dump 里 usage 载荷所在的通知 type 抄进 DSH_TURN_END_TYPE，
 * 该载荷下三个数值字段的名字抄进 DSH_USAGE_FIELDS；字段路径有多层时用 `DSH_USAGE_PATH` 逐层取。
 */
export const DSH_TURN_END_TYPE = '<dump 里的通知 type>';
export const DSH_USAGE_PATH = ['<usage 字段名>'] as const;
export const DSH_USAGE_FIELDS = {
  input: '<dump 里的输入字段名>',
  cached: '<dump 里的缓存读字段名>',
  output: '<dump 里的输出字段名>',
} as const;
```

```ts
  // 轮次结束通知：探到用量就提取，并累加轮次（tokens 与 turns 各自独立，缺一项不填 0）
  if (readString(payload, 'type') === DSH_TURN_END_TYPE) {
    state.turns += 1;
    const drafts: AgentEventDraft[] = [];
    const tokens = readTokens(usageOf(payload), drafts);
    return { drafts, tokens, turns: state.turns, failure: null };
  }
```

```ts
/** 按探测得到的路径取 usage 载荷 */
function usageOf(payload: Record<string, unknown> | null): unknown {
  let current: unknown = payload;
  for (const key of DSH_USAGE_PATH) current = asRecord(current)?.[key];
  return current;
}

/** 三项齐了才认；缺项时落一条 WARN 并保留原始负载——「没采到」与「0」必须能区分（§5.6.3） */
function readTokens(
  usage: unknown,
  drafts: AgentEventDraft[],
): { input: number; cached: number; output: number } | null {
  const record = asRecord(usage);
  if (record === null) return null;
  const input = readNumber(record, DSH_USAGE_FIELDS.input);
  const cached = readNumber(record, DSH_USAGE_FIELDS.cached);
  const output = readNumber(record, DSH_USAGE_FIELDS.output);
  if (input === null || cached === null || output === null) {
    drafts.push(
      logDraft('stderr', `[WARN] 用量负载不完整，本次运行按「未采集计量」处理（不填 0）：${safeStringify(usage)}`),
    );
    return null;
  }
  return { input, cached, output };
}
```

同时把 `import` 一行补齐（`AgentEventDraft` / `logDraft`）：`import { logDraft, safeStringify, unknownEventDraft, type AgentEventDraft } from '../../emit';`，并补 `readNumber` 到 json 的 import。

在 `providers/dsh/index.ts` 把元数据那一格改成：

```ts
      // 已按真实探测确认：该 SDK 的轮次结束通知携带 usage（见探测报告 §3）
      usage: true,
```

在 `events.test.ts` 追加：

```ts
  it('实测确认：轮次结束通知的用量被提取（字段名来自探测 dump）', () => {
    const projection = projectDshNotification(
      {
        type: DSH_TURN_END_TYPE,
        [DSH_USAGE_PATH[0]]: {
          [DSH_USAGE_FIELDS.input]: 12,
          [DSH_USAGE_FIELDS.cached]: 3,
          [DSH_USAGE_FIELDS.output]: 5,
        },
      },
      newState(),
      CONTEXT,
    );
    expect(projection.tokens).toEqual({ input: 12, cached: 3, output: 5 });
    expect(projection.turns).toBe(1);
  });
```

并在 `registry.test.ts` 里把 `EXPECTED_METADATA.dsh.capability.usage` 改成 `true`（**必须与上一处同一次提交**，否则 F2 的回归网会红——那正是它该做的事）。

**路径 B —— 探不到 usage**：保持 `usage: false` 与 `tokens: null` 不变，只做两件事：
1. 把 `providers/dsh/events.ts` 文件头「探测前口径」那段改写成实测结论，例如：`* 实测（2026-09-22 探测报告 §3）：整条通知流里没有任何 usage 载荷，故本文件不提取计量，元数据 usage 为 false（界面显示「不支持计量」）。`
2. 在 `events.test.ts` 的「计量一律 null」用例里补一句注释指向探测报告的行号，说明这条不是「还没做」而是「实测结论」。

- [ ] **Step 2: 若 claude / codex 的字段名与 §5.6.3 不一致，按 dump 改（逐条对照报告 §3）**

| 若报告里实测到 | 改哪里 | 同时要改的测试期望 |
|---|---|---|
| claude 的输入 / 缓存读 / 输出字段名不同 | `providers/claude-code/events.ts` 的 `readTokens` 三个 `readNumber(record, '…')` | `providers/claude-code/events.test.ts` 的「三项齐全」「usage 缺一项」两条用例的构造数据 |
| claude 的轮次字段名不同 | `providers/claude-code/events.ts` 的 `readNumber(message, 'num_turns')` | `providers/claude-code/events.test.ts` 的 `num_turns` 与断言 |
| codex 的 usage 挂在别的通知上（不是 `turn.completed`） | `providers/codex/events.ts` 里 `type === 'turn.completed'` 的分支条件 | `providers/codex/events.test.ts` 的三条 `turn.completed` 用例 |
| codex 的缓存读 / 输出字段名不同 | `providers/codex/events.ts` 的 `readTokens` | `providers/codex/events.test.ts` 的断言 |
| 三家出现计划里没有的事件类型 | 不改代码（默认分支已经把它们保留成日志事件），只在报告 §2 里记一笔 | —— |

**顺手抽掉第三份 `readTokens`（评审 L5，行为保持重构）**：`providers/claude-code/events.ts` 与
`providers/codex/events.ts` 已各有一份 `readTokens`，路径 A 会在 `providers/dsh/events.ts` 落成**第三份**
——三份连 WARN 文案都逐字相同（`[WARN] 用量负载不完整，本次运行按「未采集计量」处理（不填 0）：…`），
只有字段名三元组不同。既然这一波本来就要动它们，把提取提到 `json.ts` / `emit.ts` 旁的共享 helper
（三家只传字段名三元组）。**约束**：这是行为保持重构——三家 `events.test.ts` 的断言**一条都不改**且全绿；
若当场发现三家的缺项文案其实有差异，以现有测试钉住的文案为准，**不要顺手统一**（那会把一次重构变成一次口径变更）。

改完在探测报告里追加一小节：

```markdown
## 7. 回写记录（Task 12）

| 回写项 | 文件:行 | 改动 | 依据 |
|---|---|---|---|
| <例：dsh usage> | `src/providers/dsh/events.ts:NN` | <改成什么> | 报告 §3 |
```

- [ ] **Step 3: 全仓收尾检查（顺序照 `AGENT.md`：typecheck → lint → 修复 → 再审查）**

Run: `pnpm --filter @aieval/agents test`
Expected: PASS，全绿（含 `claude-code` / `codex` / `dsh` / `registry` / `turn` / `release` / `load-once` / `route` / `emit` / `json` / 静态断言 7 条；计数已按 p3 收尾实测订正——初稿写的 4 条是旧快照，见 `phase-fix-report.md`）。

Run: `pnpm --filter @aieval/agents typecheck`
Expected: 通过。

Run: `pnpm typecheck`
Expected: 8 个包全部通过。

Run: `pnpm lint`
Expected: 8 个包全部通过。若报 `probe/raw-events.mts` 「no matching configuration」，在 `packages/server/agents/eslint.config.ts` 里加一行 ignore（`.mts` 不在任何 `files` 模式里，ESLint 默认扩展名也不含它）：

```ts
import { withBoundary } from '../../../eslint.shared';

export default [
  ...withBoundary('agents'),
  // 探测脚本刻意不参与 lint：它是人工运行的一次性诊断工具，且不进 typecheck / test
  { ignores: ['probe/**'] },
];
```

Run: `pnpm test`
Expected: 全仓测试通过（`agents` 之外没有回归）。

- [ ] **Step 4: 提交**

```bash
git add packages/server/agents/src/providers/dsh/events.ts packages/server/agents/src/providers/dsh/index.ts packages/server/agents/src/providers/dsh/events.test.ts packages/server/agents/src/registry.test.ts docs/superpowers/notes/2026-09-22-features-p3-agent-probe.md
git commit -m "feat(agents): 按真实探测结果回写 dsh 用量口径与元数据（spec §5.6.3 / §11 第 5 步）"
```

只加了实际改动的路径：路径 A 与「字段名不一致」两条分支没触发的文件**不要**放进 `git add`（逐个显式路径的用意正在这里）。

- [ ] **Step 5: 交接给 p4 / p5（把这三句话写进提交说明或对应的接缝记录）**

1. **适配器只发 `log` / `usage` / `error` 三类事件**；`status` / `diff-summary` / `score` / `end` 由编排层发（见本计划「实现层修正」第 2 条）。
2. **事件里的 `seq` 是 run 内自增序号**，落盘时的最终 `seq` 由 `core` 的 `appendEvent` 重新分配（契约 §3.4）；`at` 可以直接用。
3. **`run()` 永不抛**，失败一律读 `AgentRunResult.error`；候选池过滤只读 `listAgentProviders()[i].metadata.protocolType`，不要另写一份「智能体 ↔ 协议」的对应表（A3 / F2）。

