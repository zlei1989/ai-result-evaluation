# 智能体评分 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让评分可以不走「把 diff 塞进一次文本请求」，而是由评分智能体在该行工作区里自行查看改动并给出同一份 5 维 JSON；同时给「评分这一步失败/被打断」补一个行级重试出口。

**Architecture:** 评分从「一条通路」变成「两条通路共用一个收口」——`resolveJudgeRoute` 解析出的仍是「默认评分模型那一对」（用例覆盖 > 全局默认），变化的只是**谁来驱动它**：纯文本 API，还是 `agents` 注册表里的某家 CLI。为此给 `AgentRunResult` 补上今天被丢弃的「最终答复」字段，评分结果仍由 `parseJudgeResponse` + `composeTotalScore` + `ScoreResultSchema` 自检这一份唯一真源产出。重新评分复用同一个评分阶段函数，只在既有工作区上重跑，不重跑候选。

**Tech Stack:** TypeScript 5（strict + noUncheckedIndexedAccess + verbatimModuleSyntax）、pnpm monorepo（8 包分层，边界由 eslint `withBoundary()` 硬约束）、Next.js App Router、antd 6 + React 19、SWR 2、zod 3、vitest 4（node / jsdom 双环境）。

**Spec:** `docs/superpowers/specs/2026-09-22-scaffold-design.md` §13.1（本线的过程 spec 已并入该文档并从库中删除）

## Global Constraints

以下每一条对**所有任务**隐式生效。数值与路径逐字来自 `AGENT.md` 与 spec，不要凭印象改写。

- **交流与注释一律中文。** TS/TSX 用 JSDoc：先说「做什么」再说「怎么做」；文件头写明职责与注意事项；嵌套 > 2 层必须注释业务含义；独立功能单元（方法、条件分支、事件处理、数据转换）都要说明业务目的。
- **提交时逐个显式 `git add <路径>`，禁止 `git add -A`。** 本仓可能同时有别的会话在工作；`git status` 里出现不属于本次改动的文件时**保持原样、不要动它**，也**不要**把它卷进你的提交。
- **每个任务收尾必须跑**：`pnpm typecheck` → `pnpm lint` → 修复所有错误。进入代码审查前再跑一次 `pnpm test`。三条命令都是**单进程**聚合（刻意不走 `pnpm -r`）。单包调试用 `pnpm --filter @aieval/<包名> <脚本>`。
- **新增的每条回归守卫都必须做变异验证**：把它要拦的缺陷人为制造回去，确认该守卫**失败**，再还原并核对文件哈希未变。**没有见过失败的守卫不算守卫。**
- **测试不得触碰真实 `~/.aieval`**：用 `setConfigDirForTesting(dir)` 指向临时目录。
- **`.tsx` 测试只在库包可写**（`packages/client/*`、`packages/server/*`）。`apps/web-next` 保留 `jsx: preserve`，**该应用内不能写 `.tsx` 测试**；页面逻辑抽到 `apps/web-next/src/*.ts` 再写 `.test.ts`。
- **样式一律走 antd**：不手写字号（交紧凑密度）、不手调行内边距（交组件默认）、不裸写 `div` 等原始标签；同时适配 `light` 与 `dark`。
- **紧凑密度下绝不显式写 `fontSize`**（`compactAlgorithm` 会覆盖它并反向推导，实效字号掉到 10px）。
- **antd 6 的 `Button`：`variant` 单给不生效**，必须 `color` 与 `variant` 成对给，或改用语法糖 `type`。
- **两个汉字的按钮一律 `autoInsertSpace={false}`**，否则可访问名会变成「确 定」。
- **依赖方向单向**（由 eslint 硬约束，含动态 `import()` 与 `require()`）：`web-next → api/core/ui/client/contracts`；`api → evaluator/agents/core/contracts`；`evaluator → agents/core/contracts`；`agents → core/contracts`；`ui → contracts`；`client → contracts`；`core → 无`。新增跨包依赖必须同时改 `AGENT.md` 的依赖表。
- **厂商 SDK 只允许出现在 `agents`**；`ui` / `client` 不能 import 服务端包。
- **快照 schema 的新字段一律 `.default(...)`**：`run-store.ts` 用 `safeParse` 读盘，必填新字段会让磁盘上已有的 `run.json` 直接读不出来。
- **写盘必须原子**；**绝不填 0 表示「没采到」**（计量一律 `null`）。
- 日志在 `@aieval/core` 的 `createLogger(scope)`；上下文作为 `console` 第二个参数透传，**不要 `JSON.stringify`**。

## Review Focus

以下是 spec 隐含、但最容易在真实使用中咬人的五类输入 / 失败模式。每一条都必须在**拥有该代码的那个任务**里被一条测试钉住（下面各任务的步骤里已就位）。

1. **老 `run.json` 读不出来。** 磁盘上已有的评测快照没有 `useAgentJudge` 与 `judgeAgentKind` 两个字段。若把新字段写成必填，`readSnapshot` 的 `safeParse` 会失败 ⇒ `listRuns()` **静默跳过**（只记 WARN）、`getRun()` 抛 INTERNAL：使用者看到的是「我的评测记录凭空少了几轮」，而且两端都不报错。期望行为：老快照原样可读，新字段取默认值。
2. **开关被 zod 静默 strip。** `RunCreateSchema` 是 `z.object`，默认 strip 未知键。若忘了声明 `useAgentJudge`，POST 不会 400，而是**安静地丢掉它**——使用者以为这一轮在用智能体评分，实际跑的仍是文本 API，两边都不报错。期望行为：路由测试断言提交的 `useAgentJudge` 真的到达了服务端。
3. **评分阶段无界挂住。** `turn.ts` 的 JSDoc 明写 `runTurn` **可能无界返回**（`dispose` 只能尽力让迭代结束）。候选 agent 阶段有外层 `hardDeadline` 兜底；评分阶段若不加，该行会**永远停在 `judging`**，`startRun` 也永远拒绝再启动（`isRunningRow('judging')` 为真）。期望行为：评分阶段超时后该行落到 `timed-out`。
4. **评分智能体改动了工作区。** 「查看改动」抽屉是**按需现算** `collectDiff` 的，而评分发生在 diff 摘要采集之后 ⇒ 它改了文件的话，抽屉显示的就不再是候选的产出，且**没有任何提示**。期望行为：评分后重算摘要做对照，不一致就落一条点名的 WARN。
5. **dsh 的 `reasoning` 块混进答复。** `assistant/message` 的 `data.message.content[]` 里，`{type:'reasoning'}` 块**也带 `text` 字段**。按 `text` 取值会把推理内容拼进评分答复 ⇒ JSON 解析失败，而失败原因看起来像「模型不守契约」。期望行为：只取 `type === 'text'` 的块。

## 文件结构

| 文件 | 责任 | 动作 |
|---|---|---|
| `packages/server/contracts/src/agent.ts` | 智能体 id / 标签的**唯一真源**（从 `run.ts` 拆出，消除 `score.ts` 与 `run.ts` 的互引） | 新建 |
| `packages/server/contracts/src/settings.ts` | 设置契约：加 `defaultJudgeAgent` | 改 |
| `packages/server/contracts/src/run.ts` | 评测契约：加 `useAgentJudge`（两处）+ `canRescoreRow` | 改 |
| `packages/server/contracts/src/score.ts` | 评分契约：加 `judgeAgentKind` | 改 |
| `packages/server/contracts/src/index.ts` | barrel：转出 `agent.ts` 的四个名字与 `canRescoreRow` | 改 |
| `packages/server/agents/src/types.ts` | `AgentRunResult.finalText` | 改 |
| `packages/server/agents/src/turn.ts` | `TurnState.finalText` + `assembleResult` 带出 | 改 |
| `packages/server/agents/src/providers/{claude-code,codex,dsh}/events.ts` | 三家各自的采集点 | 改 |
| `packages/server/core/src/workspace.ts` | `rowJudgeHomeDir()` + 纳入 `clearRowArtifacts` | 改 |
| `packages/server/evaluator/src/judge-agent.ts` | 智能体评分通路：拼词、跑适配器、解析 | 新建 |
| `packages/server/evaluator/src/judge.ts` | 抽 `finalizeScore` 供两路共用 | 改 |
| `packages/server/evaluator/src/judge-route.ts` | 加 `requireJudgeAgent`（未配置 / 协议不兼容） | 改 |
| `packages/server/evaluator/src/orchestrator.ts` | 第 7 步分支 + 评分阶段外层兜底 + `rescoreRow` | 改 |
| `packages/server/api/src/runs.ts` | 创建时校验 + `rescoreRow` 转出 | 改 |
| `packages/client/ui/src/composite/judge-settings-card.tsx` | 「默认评分智能体」下拉 + 协议过滤 | 改 |
| `packages/client/ui/src/composite/run-create-panel.tsx` | 「使用智能体评分」Switch + 内联 Alert | 改 |
| `packages/client/ui/src/composite/eval-row-card.tsx` | 「重新评分」按钮 + Popconfirm | 改 |
| `packages/client/ui/src/composite/run-detail-panel.tsx` | 透传 `onRescoreRow` | 改 |
| `packages/client/ui/src/composite/score-detail-view.tsx` | 显示评分智能体 | 改 |
| `packages/client/client/src/runs.ts` | `useRescoreRow` | 改 |
| `apps/web-next/app/api/runs/[runId]/rows/[rowId]/rescore/route.ts` | 新路由 | 新建 |
| `apps/web-next/app/runs/page.tsx` | 接线 + `useSettings` 派生 `judgeAgentConfigured` | 改 |
| `apps/web-next/app/settings/page.tsx` | 接线 `useRunModelOptions` | 改 |
| `README.md` | 使用手册补两条通路与重新评分 | 改 |

---

### Task 1: 契约层——拆出 `agent.ts`、四个新字段、`canRescoreRow`

**Files:**
- Create: `packages/server/contracts/src/agent.ts`
- Create: `packages/server/contracts/src/agent.test.ts`
- Modify: `packages/server/contracts/src/run.ts`
- Modify: `packages/server/contracts/src/settings.ts`
- Modify: `packages/server/contracts/src/score.ts`
- Modify: `packages/server/contracts/src/index.ts`
- Test: `packages/server/contracts/src/{run,settings,score}.test.ts`（既有文件，追加用例）

**Interfaces:**
- Consumes: 无（本任务是最底层）
- Produces:
  - `AGENT_KINDS: readonly ['claude-code','codex','dsh']`、`AgentKindSchema`、`type AgentKind`、`AGENT_LABELS: Record<AgentKind, string>` —— 全部仍从 `@aieval/contracts` 包根取得（`run.ts` 只做再导出）
  - `Settings.defaultJudgeAgent: AgentKind | null`
  - `RunCreate.useAgentJudge: boolean`、`EvalRun.useAgentJudge: boolean`（都带 `.default(false)`）
  - `ScoreResult.judgeAgentKind: AgentKind | null`（`.default(null)`）
  - `canRescoreRow(row: EvalRow): boolean`

- [ ] **Step 1: 写失败的测试（新建 `agent.test.ts`）**

```ts
// @vitest-environment node
/**
 * 智能体真源（契约 §11 R1）：三个 id、顺序、标签。
 * 顺序不是装饰——它同时是 `agents` 注册表 `listAgentProviders()` 的顺序与前端下拉的顺序，
 * 三者任一漂移，界面上「选中的智能体」与「真正跑的那家」就会错位。
 * 本文件是本次改动新增的唯一真源文件；包根的出口面由同目录的 `index.test.ts` 守着。
 */
import { describe, expect, it } from 'vitest';
import { AGENT_KINDS, AGENT_LABELS, AgentKindSchema } from './agent';

describe('智能体真源', () => {
  it('恰好三家且顺序固定', () => {
    expect([...AGENT_KINDS]).toEqual(['claude-code', 'codex', 'dsh']);
  });

  it('每个 id 都有中文标签', () => {
    expect(AGENT_LABELS['claude-code']).toBe('Claude Code');
    expect(AGENT_LABELS.codex).toBe('Codex');
    expect(AGENT_LABELS.dsh).toBe('DeepSeek Harness');
  });

  it('schema 只认这三个 id', () => {
    expect(AgentKindSchema.safeParse('dsh').success).toBe(true);
    expect(AgentKindSchema.safeParse('gemini').success).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @aieval/contracts test -- agent.test`
Expected: FAIL —— `Failed to resolve import "./agent"`（文件还不存在）

- [ ] **Step 3: 建 `agent.ts` 并把 `run.ts` 的定义换成再导出**

`packages/server/contracts/src/agent.ts`：

```ts
/**
 * 智能体 id 与标签的**唯一真源**（原在 `run.ts`，为解开 `score.ts` ⇄ `run.ts` 的互引而拆出）。
 * 为什么单独一个文件：`ScoreResult` 要记「这一分是哪个智能体打的」，而 `run.ts` 已经 import
 * `score.ts`——把这张表留在 `run.ts` 会逼出一个模块环（zod 层面不一定炸，但依赖方向已经错了）。
 * 契约 §11 R1 的口径不变：真源仍然只有一份，`run.ts` 与包根都只是**再导出**。
 * 注意：清单顺序 = `agents` 注册表的 `listAgentProviders()` 顺序 = 前端下拉顺序，三者必须同序。
 */
import { z } from 'zod';

/** 三家智能体 id 的**唯一真源** */
export const AGENT_KINDS = ['claude-code', 'codex', 'dsh'] as const;
export const AgentKindSchema = z.enum(AGENT_KINDS);
export type AgentKind = (typeof AGENT_KINDS)[number];

/** 智能体中文标签（设置页与候选池共用） */
export const AGENT_LABELS: Record<AgentKind, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  dsh: 'DeepSeek Harness',
};
```

`packages/server/contracts/src/run.ts`：**删掉**第 16–26 行那四个成员（`AGENT_KINDS` / `AgentKindSchema` / `AgentKind` / `AGENT_LABELS` 及其注释），替换为一行再导出（放在 import 之后、`ExecutionModeSchema` 之前）：

```ts
// 智能体真源已拆到 ./agent（见该文件头：score.ts 需要 AgentKindSchema，而 run.ts 已经 import score.ts）。
// 这里**原样再导出**：所有既有消费方都从 `@aieval/contracts` 包根取这四个名字，路径不变。
export { AGENT_KINDS, AGENT_LABELS, AgentKindSchema, type AgentKind } from './agent';
```

- [ ] **Step 4: 跑测试确认通过 + 确认包根出口没漏**

Run: `pnpm --filter @aieval/contracts test -- agent.test index.test`
Expected: 两个文件全 PASS。`index.test.ts` 从包根 import `AGENT_KINDS` / `AGENT_LABELS` / `AgentKindSchema` / `type AgentKind`——它必须**不改一行**就通过，那正是「拆分没动出口」的证据。

- [ ] **Step 5: 写失败的测试——`defaultJudgeAgent`**

追加到 `packages/server/contracts/src/settings.test.ts`：

```ts
  it('defaultJudgeAgent 默认未配置，且只认三家智能体', () => {
    expect(SETTINGS_DEFAULTS.defaultJudgeAgent).toBeNull();
    expect(SettingsSchema.safeParse({ ...SETTINGS_DEFAULTS, defaultJudgeAgent: null }).success).toBe(true);
    expect(SettingsSchema.safeParse({ ...SETTINGS_DEFAULTS, defaultJudgeAgent: 'dsh' }).success).toBe(true);
    // 自造的名字必须被拒：写进配置之后评分阶段才炸，等于让人去设置页反复确认一个填了的字段
    expect(SettingsSchema.safeParse({ ...SETTINGS_DEFAULTS, defaultJudgeAgent: 'gemini' }).success).toBe(false);
  });
```

- [ ] **Step 6: 跑测试确认失败**

Run: `pnpm --filter @aieval/contracts test -- settings.test`
Expected: FAIL —— `expected undefined to be null`（`defaultJudgeAgent` 还不存在）

- [ ] **Step 7: 实现 `defaultJudgeAgent`**

`packages/server/contracts/src/settings.ts` 顶部加 import：

```ts
import { AgentKindSchema } from './agent';
```

`SettingsSchema` 在 `defaultJudge` 之后加一格：

```ts
  /** 默认评分智能体：null = 未配置（此时「使用智能体评分」的评测会在创建时被拦下） */
  defaultJudgeAgent: AgentKindSchema.nullable(),
```

`SETTINGS_DEFAULTS` 加一行：

```ts
  defaultJudgeAgent: null,
```

- [ ] **Step 8: 跑测试确认通过**

Run: `pnpm --filter @aieval/contracts test -- settings.test`
Expected: PASS

- [ ] **Step 9: 写失败的测试——`useAgentJudge`、老快照兼容、`canRescoreRow`**

追加到 `packages/server/contracts/src/run.test.ts`（文件顶部按需补 import：`canRescoreRow`、`RunCreateSchema`、`EvalRunSchema`、`type EvalRow`）：

```ts
  it('useAgentJudge 缺省为 false（老客户端与手工 POST 都不带这个字段）', () => {
    const created = RunCreateSchema.parse({
      caseId: 'c1',
      executionMode: 'parallel',
      rows: [{ agentKind: 'codex', providerId: 'p1', modelId: 'm1' }],
    });
    expect(created.useAgentJudge).toBe(false);
  });

  // D5 / Review Focus 第 1 条：run-store 的 readSnapshot 用 safeParse 读盘，必填新字段会让磁盘上
  // 已有的评测**从列表里静默消失**（只记一条 WARN），而两端都不报错。这条守卫钉住「老快照照读」。
  it('老 run.json（没有 useAgentJudge 与 judgeAgentKind）仍然读得出来，并取到默认值', () => {
    const legacy = {
      id: 'run-1',
      caseId: 'case-1',
      caseTitle: '老用例',
      repoPath: 'C:/repo',
      commitHash: null,
      status: 'done',
      executionMode: 'parallel',
      rows: [
        {
          id: 'row-1',
          agentKind: 'codex',
          providerId: 'p1',
          providerName: '老供应商',
          baseUrl: 'https://fake.invalid/v1',
          modelId: 'm1',
          status: 'judged',
          branch: 'test/row-1',
          workspacePath: 'C:/runs/run-1/rows/row-1/workspace',
          baselineCommit: 'a'.repeat(40),
          tokens: null,
          turns: null,
          durationMs: null,
          diff: null,
          score: {
            dimensions: [],
            totalScore: 0,
            verdict: '老总评',
            raw: '{}',
            judgeProviderId: 'p1',
            judgeModelId: 'm1',
            judgedAt: '2026-01-01T00:00:00.000Z',
          },
          error: null,
        },
      ],
      workspaceBase: 'C:/runs',
      createdAt: '2026-01-01T00:00:00.000Z',
      startedAt: null,
      finishedAt: null,
    };

    const parsed = EvalRunSchema.safeParse(legacy);
    if (!parsed.success) throw new Error(`老快照必须解析成功：${parsed.error.message}`);
    expect(parsed.data.useAgentJudge).toBe(false);
    expect(parsed.data.rows[0]?.score?.judgeAgentKind).toBeNull();
  });

  it('canRescoreRow：跑过的终态行可重评', () => {
    for (const status of ['judged', 'failed', 'timed-out', 'canceled', 'interrupted'] as const) {
      expect(canRescoreRow(makeRow({ status }))).toBe(true);
    }
  });

  it('canRescoreRow：三种在途状态一律不可（正在跑的行有自己的生命周期）', () => {
    for (const status of ['preparing', 'running', 'judging'] as const) {
      expect(canRescoreRow(makeRow({ status }))).toBe(false);
    }
  });

  it('canRescoreRow：没跑过的行不可（没有可比基线或没有产出）', () => {
    expect(canRescoreRow(makeRow({ status: 'pending', baselineCommit: '', diff: null }))).toBe(false);
    expect(canRescoreRow(makeRow({ baselineCommit: '' }))).toBe(false);
    expect(canRescoreRow(makeRow({ diff: null }))).toBe(false);
  });
```

同文件顶部加一个本地行工厂（**不要**从 `evaluator` 的夹具 import——contracts 不能依赖 evaluator）：

```ts
/** 一个字段齐全的候选行；只覆盖要测的那一格 */
function makeRow(overrides: Partial<EvalRow> = {}): EvalRow {
  return {
    id: 'row-1',
    agentKind: 'codex',
    providerId: 'p1',
    providerName: '测试供应商',
    baseUrl: 'https://fake.invalid/v1',
    modelId: 'm1',
    status: 'judged',
    branch: 'test/row-1',
    workspacePath: 'C:/runs/run-1/rows/row-1/workspace',
    baselineCommit: 'a'.repeat(40),
    tokens: null,
    turns: null,
    durationMs: null,
    diff: { filesChanged: 1, insertions: 2, deletions: 3, truncated: false },
    score: null,
    error: null,
    ...overrides,
  };
}
```

- [ ] **Step 10: 跑测试确认失败**

Run: `pnpm --filter @aieval/contracts test -- run.test`
Expected: FAIL —— `canRescoreRow is not a function`，且老快照那条因 `useAgentJudge` 缺失而 `safeParse` 失败（`useAgentJudge` 尚不存在时它其实会通过，因为未知键被 strip——**这一条要等 Step 11 加上 `.default(false)` 之后才有区分力**，Step 13 的变异验证会确认这一点）

- [ ] **Step 11: 实现 `useAgentJudge` 与 `canRescoreRow`**

`packages/server/contracts/src/run.ts`：

`RunCreateSchema` 加一格（放在 `executionMode` 之后）：

```ts
  /** 这一轮是否由评分智能体评分；缺省 false（老客户端与手工 POST 不带这个字段时仍然合法） */
  useAgentJudge: z.boolean().default(false),
```

`EvalRunSchema` 加一格（放在 `executionMode` 之后）：

```ts
  /**
   * 创建时的评分方式快照。`.default(false)` 是**载重**的：磁盘上已有的 `run.json` 没有这个字段，
   * 没有默认值就会 `safeParse` 失败 ⇒ `listRuns()` 静默跳过那一轮、`getRun()` 抛 INTERNAL
   * （使用者看到的是「我的评测记录凭空少了几轮」，两端都不报错）。
   */
  useAgentJudge: z.boolean().default(false),
```

文件末尾（`isRunningRow` 之后）加：

```ts
/**
 * 该行能否「重新评分」：不重跑候选 agent，只在既有工作区上重跑评分步骤。
 * 三个条件缺一不可：
 *   · 不在运行中——正在跑的行有自己的生命周期，终止它是另一件事；
 *   · `baselineCommit !== ''`——prepare 阶段成功过，diff 才有可比基线（§11 R2）；
 *   · `diff !== null`——第 6 步（collectDiff）跑过，说明候选 agent 阶段已经结束。
 * 于是 judged / failed / timed-out / canceled / interrupted 可重评，pending / skipped 不可。
 *
 * 判据放 contracts 而不是服务端独有：界面要靠它决定按钮的 `disabled`，而服务端要拿同一份判据
 * 抛 CONFLICT。两处各写一份必然漂移，漂移的表现是「按钮可点、点下去 409」——与
 * `isRunnableRow` / `isRunningRow` 同一个落点、同一条理由。
 */
export function canRescoreRow(row: EvalRow): boolean {
  return !isRunningRow(row.status) && row.baselineCommit !== '' && row.diff !== null;
}
```

- [ ] **Step 12: 跑测试确认通过**

Run: `pnpm --filter @aieval/contracts test`
Expected: 全 PASS

- [ ] **Step 13: 变异验证（Global Constraints 的硬要求）**

1. 把 `EvalRunSchema.useAgentJudge` 的 `.default(false)` 删掉 → 跑 `pnpm --filter @aieval/contracts test -- run.test` → 「老 run.json 仍然读得出来」这条**必须变红**。
2. 把 `canRescoreRow` 的 `!isRunningRow(row.status) &&` 删掉 → 「三种在途状态一律不可」**必须变红**。
3. 两次都还原，并用 `git diff --stat packages/server/contracts/src/run.ts` 核对改动回到原样。

- [ ] **Step 14: 写失败的测试——`judgeAgentKind`**

追加到 `packages/server/contracts/src/score.test.ts`：

```ts
  it('judgeAgentKind 缺省为 null（= 纯文本 API；磁盘上已有的评分记录也落在 null）', () => {
    const legacy = {
      dimensions: [],
      totalScore: 0,
      verdict: 'v',
      raw: '{}',
      judgeProviderId: 'p1',
      judgeModelId: 'm1',
      judgedAt: '2026-01-01T00:00:00.000Z',
    };
    const parsed = ScoreResultSchema.safeParse(legacy);
    if (!parsed.success) throw new Error(`老评分记录必须解析成功：${parsed.error.message}`);
    expect(parsed.data.judgeAgentKind).toBeNull();
    expect(ScoreResultSchema.safeParse({ ...legacy, judgeAgentKind: 'dsh' }).success).toBe(true);
    expect(ScoreResultSchema.safeParse({ ...legacy, judgeAgentKind: 'gemini' }).success).toBe(false);
  });
```

- [ ] **Step 15: 跑测试确认失败**

Run: `pnpm --filter @aieval/contracts test -- score.test`
Expected: FAIL —— `expected undefined to be null`

- [ ] **Step 16: 实现 `judgeAgentKind`**

`packages/server/contracts/src/score.ts` 顶部加 import：

```ts
import { AgentKindSchema } from './agent';
```

`ScoreResultSchema` 末尾（`judgedAt` 之后）加：

```ts
  /**
   * 这一分是哪个智能体打的；null ⇔ 走纯文本 API。
   * 与 `judgeProviderId` / `judgeModelId` 并列，是「尺子」的一部分（§7.2 冗余快照的同一理由）：
   * 光有模型名回答不了「这个分是文本请求打的还是智能体会话打的」。
   * `.default(null)` 同 `EvalRunSchema.useAgentJudge`：老评分记录随 run.json 一起读盘。
   */
  judgeAgentKind: AgentKindSchema.nullable().default(null),
```

- [ ] **Step 17: 包根补 `canRescoreRow`**

`packages/server/contracts/src/index.ts` 的 `'./run'` 导出块里，`RunCreateSchema` 之后加 `canRescoreRow`（**按字母序**，该块目前是字母序）：

```ts
  RunCreateSchema,
  TERMINAL_ROW_STATUSES,
  canRescoreRow,
  isRunnableRow,
  isRunningRow,
```

- [ ] **Step 18: 跑全链验证并提交**

```bash
pnpm typecheck
pnpm lint
pnpm test
git add packages/server/contracts/src/agent.ts packages/server/contracts/src/agent.test.ts packages/server/contracts/src/run.ts packages/server/contracts/src/run.test.ts packages/server/contracts/src/settings.ts packages/server/contracts/src/settings.test.ts packages/server/contracts/src/score.ts packages/server/contracts/src/score.test.ts packages/server/contracts/src/index.ts
git commit -m "feat(contracts): 智能体评分契约——defaultJudgeAgent / useAgentJudge / judgeAgentKind / canRescoreRow"
```

预期：`pnpm test` 里**其它包会有编译错误红**（`EvalRun` / `ScoreResult` 多了必填的输出字段，`makeRunFixture` / `makeScoreFixture` 等夹具还没补）。这是刻意的——它们由 Task 3 的夹具更新收口。若不想让 Task 1 结束时全链是红的，**把夹具补齐合并进本任务的 Step 18 之前**：改 `packages/server/evaluator/src/testing/fixtures.ts` 的 `makeRunFixture`（返回对象加 `useAgentJudge: input.useAgentJudge ?? false`，入参类型加 `useAgentJudge?: boolean`）、`makeScoreFixture`（加第 4 个可选参数 `judgeAgentKind: AgentKind | null = null` 并写进返回值）、`seedConfig`（入参加 `defaultJudgeAgent?: Settings['defaultJudgeAgent']` 并写进 settings）、`makeFakeProvider` 的 `finish()`（加 `finalText`）。这四处一并 add 进来。

---

### Task 2: `agents` 包——最终答复出口 `finalText`

**Files:**
- Modify: `packages/server/agents/src/types.ts`
- Modify: `packages/server/agents/src/turn.ts`
- Modify: `packages/server/agents/src/providers/claude-code/events.ts`
- Modify: `packages/server/agents/src/providers/codex/events.ts`
- Modify: `packages/server/agents/src/providers/dsh/events.ts`
- Test: 上面三个 `events.ts` 各自的 `events.test.ts` + `packages/server/agents/src/turn.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `AgentKind`（无行为依赖，仅类型）
- Produces: `AgentRunResult.finalText: string | null`；`TurnState.finalText: string | null`（三家适配器与 Task 3 的 `judge-agent.ts` 都读它）

**背景（为什么必须先做这个）：** 今天 `AgentRunResult`（`types.ts:58-66`）**没有任何「模型最终说了什么」的字段**，三家的最终答复都只作为 `log` 事件流走。要从事件流里重建答复是不可靠的：codex 发的是**增量 delta**、dsh 的 `assistant/message` 文本**根本没被投影**（`providers/dsh/events.ts` 那个分支只取用量）。

- [ ] **Step 1: 写失败的测试——claude-code**

追加到 `packages/server/agents/src/providers/claude-code/events.test.ts`：

```ts
  it('result 消息的 result 字段被记为最终答复（AgentRunResult.finalText 的来源）', () => {
    const state = newState();
    projectClaudeMessage({ type: 'result', uuid: 'r-final', result: '{"dimensions":[]}' }, state, CONTEXT);
    expect(state.finalText).toBe('{"dimensions":[]}');
  });

  it('assistant 消息不写最终答复（收尾以 result 为准，中间轮次的文本不算）', () => {
    const state = newState();
    projectClaudeMessage(
      { type: 'assistant', uuid: 'a-final', message: { content: [{ type: 'text', text: '我先看看' }] } },
      state,
      CONTEXT,
    );
    expect(state.finalText).toBeNull();
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @aieval/agents test -- claude-code/events`
Expected: FAIL —— `state.finalText` 不存在（`newState()` 也还没这个字段，`pnpm typecheck` 同样会报）

- [ ] **Step 3: 实现 `finalText` 的骨架与 claude-code 采集点**

`packages/server/agents/src/types.ts` 的 `AgentRunResult` 末尾加：

```ts
  /**
   * 智能体的最终答复文本；null = 未采到。
   * 「未采到」与空串是两件事：前者是这一家没回传可读的最终消息、或本次运行没跑到那一步，
   * 后者是它明确回了一个空答复——与 tokens/turns 同一条「绝不填 0」的口径，不要互相兜底。
   * 用途：需要**结构化答复**的调用方（评分智能体）从这里取文本，而不是从事件流里重建
   * （codex 发增量 delta、dsh 的 assistant 文本不进事件流，重建三家各不相同且不可靠）。
   * 失败与终止的结论也带它：排障时要能回答「它到底说了什么」。
   */
  finalText: string | null;
```

`packages/server/agents/src/turn.ts` 的 `TurnState` 末尾加：

```ts
  /**
   * 智能体的最终答复（供 `AgentRunResult.finalText` 带出）。
   * 由各家的 `project` 在**已识别的那条收尾消息**上写入；没见到就保持 null（不猜）。
   * 为什么放在跨消息状态里、而不是让 `project` 直接返回：`project` 的返回值是**事件**，
   * 而答复不是事件——它已经作为 log 事件落过盘了，再发一条就是重复。
   */
  finalText: string | null;
```

`runTurn` 里 `state` 的初始化补一格（`usageOutput: null` 之后）：

```ts
    finalText: null,
```

`runTurn` 末尾调 `assembleResult` 时多传一个参数（放在 `turns,` 之后）：

```ts
    finalText: state.finalText,
```

`assembleResult` 的入参类型加一格，并把它放进 `base`：

```ts
function assembleResult(input: {
  startedAt: number;
  timeoutMs: number;
  canceled: boolean;
  selfTimedOut: boolean;
  failure: AgentFailure | null;
  tokens: AgentRunResult['tokens'];
  turns: number | null;
  finalText: AgentRunResult['finalText'];
  emit: (draft: AgentEventDraft) => void;
}): AgentRunResult {
  const durationMs = Date.now() - input.startedAt;
  // finalText 与 tokens/turns 同路：三种结论（canceled / timed-out / error）都要带出去，
  // 排障时「它超时前到底说了什么」是唯一能回答「跑到哪一步了」的证据
  const base = { tokens: input.tokens, turns: input.turns, durationMs, finalText: input.finalText };
```

`providers/claude-code/events.ts`：`projectResult` 的签名改成接 `state`，并在写日志的同一处记答复：

```ts
  if (type === 'result') return projectResult(message, state, context);
```

```ts
/** `result` 消息：最终答复进日志与结果、计量与轮次取数值、is_error 归因成失败 */
function projectResult(
  message: Record<string, unknown> | null,
  state: TurnState,
  context: FailureContext,
): TurnProjection {
  const drafts: AgentEventDraft[] = [];
  const text = readString(message, 'result');
  if (text !== null && text !== '') {
    drafts.push(logDraft('stdout', text));
    // 最终答复：`result` 是这一家的收尾消息，它的 `result` 字段就是整段答复（实测形状）。
    // 空串不写——`''` 既落不成日志，也不该被当成「采到了答复」（与文件头 N3 的处置同一条原则）。
    state.finalText = text;
  }
```

- [ ] **Step 4: 跑测试确认 claude-code 通过**

Run: `pnpm --filter @aieval/agents test -- claude-code/events`
Expected: PASS

- [ ] **Step 5: 写失败的测试——codex**

追加到 `packages/server/agents/src/providers/codex/events.test.ts`（沿用该文件既有的 `seenTexts` / `newState()` / `CONTEXT` 用法）：

```ts
  it('agent 消息被记为最终答复，且取累积文本的最后一次', () => {
    const state = newState();
    const seen = new Map<string, string>();
    projectCodexEvent({ type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: '{"dim' } }, state, seen, CONTEXT);
    projectCodexEvent({ type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: '{"dimensions":[]}' } }, state, seen, CONTEXT);
    expect(state.finalText).toBe('{"dimensions":[]}');
  });

  it('工具输出的 text 不算最终答复（错误项也带 text，不能一并算）', () => {
    const state = newState();
    const seen = new Map<string, string>();
    projectCodexEvent(
      { type: 'item.completed', item: { id: 'i2', type: 'error', text: 'Codex is ignoring 2 settings' } },
      state,
      seen,
      CONTEXT,
    );
    expect(state.finalText).toBeNull();
  });
```

- [ ] **Step 6: 跑测试确认失败**

Run: `pnpm --filter @aieval/agents test -- codex/events`
Expected: FAIL —— `expected null to be '{"dimensions":[]}'`

- [ ] **Step 7: 实现 codex 采集点**

`providers/codex/events.ts` 的 `item.updated / item.completed` 分支里，在算完 `delta` **之前**插入：

```ts
    const previous = seenTexts.get(id) ?? '';
    seenTexts.set(id, text);
    // 最终答复：只认 agent 消息这一种 item。工具输出与错误项**也带 `text` 字段**（实测：
    // `{type:'error', message:…}` 与 `{type:'agent_message', text:…}` 混在同一个 item 通道里），
    // 不按 `item.type` 过滤就会把告警当答复。注意这是**累积**文本，每见一次覆盖一次 ⇒ 最后一次即最终。
    if (readString(item, 'type') === 'agent_message') state.finalText = text;
    // 累积文本：startsWith 说明是「上次 + 新增」；否则视为整体替换（中间被改写），整段重发
    const delta = text.startsWith(previous) ? text.slice(previous.length) : text;
```

- [ ] **Step 8: 跑测试确认 codex 通过**

Run: `pnpm --filter @aieval/agents test -- codex/events`
Expected: PASS

- [ ] **Step 9: 写失败的测试——dsh（Review Focus 第 5 条）**

追加到 `packages/server/agents/src/providers/dsh/events.test.ts`：

```ts
  it('assistant/message 的 text 块被记为最终答复', () => {
    const state = newState();
    projectDshNotification(
      {
        method: 'session.event',
        params: {
          sessionId: 's1',
          event: {
            type: 'assistant/message',
            data: {
              turn: 1,
              message: { role: 'assistant', content: [{ type: 'text', text: '{"dimensions":[]}' }] },
            },
          },
        },
      },
      state,
      CONTEXT,
    );
    expect(state.finalText).toBe('{"dimensions":[]}');
  });

  // Review Focus 第 5 条：同一个 content 数组里的 reasoning 块**也带 text 字段**（实测 dump）。
  // 不过滤就会把推理内容拼进答复 ⇒ JSON 解析失败，而表象像「模型不守契约」。
  it('reasoning 块不算答复（它也带 text 字段，必须按 type 过滤）', () => {
    const state = newState();
    projectDshNotification(
      {
        method: 'session.event',
        params: {
          sessionId: 's1',
          event: {
            type: 'assistant/message',
            data: {
              turn: 1,
              message: {
                role: 'assistant',
                content: [
                  { type: 'reasoning', text: '让我先想想这道题该怎么打分' },
                  { type: 'text', text: '{"verdict":"还行"}' },
                ],
              },
            },
          },
        },
      },
      state,
      CONTEXT,
    );
    expect(state.finalText).toBe('{"verdict":"还行"}');
  });
```

- [ ] **Step 10: 跑测试确认失败**

Run: `pnpm --filter @aieval/agents test -- dsh/events`
Expected: FAIL —— `expected null to be ...`

- [ ] **Step 11: 实现 dsh 采集点**

`providers/dsh/events.ts` 的 `DSH_ASSISTANT_MESSAGE_TYPE` 分支，在 `readTokens` 之后插入：

```ts
    // 最终答复：只取 `type === 'text'` 的非空块。实测（probe/dumps/dsh.json 的 assistant/message）：
    // 同一个 content 数组里同时有 `{type:'reasoning', text:''}` 与 `{type:'text', text:'好'}`，
    // 而 reasoning 块**也带 text 字段** —— 按 text 取值会把推理内容混进答复。
    const reply = readAssistantText(data);
    if (reply !== '') state.finalText = reply;
```

同文件加这个私有 helper（放在 `readTurnFailure` 之前）：

```ts
/**
 * 从 `assistant/message` 的 `data.message.content[]` 里取可读答复：只认 `type === 'text'` 的非空块，
 * 多个块按顺序用换行拼接。形状不对时返回空串（调用方据此保持 `finalText` 不动，不写空串）。
 */
function readAssistantText(data: Record<string, unknown> | null): string {
  const blocks = asRecord(data?.message)?.content;
  if (!Array.isArray(blocks)) return '';
  return blocks
    .map((block) => {
      const record = asRecord(block);
      return record?.type === 'text' && typeof record.text === 'string' ? record.text : '';
    })
    .filter((text) => text !== '')
    .join('\n');
}
```

- [ ] **Step 12: 写失败的测试——`turn.ts` 的透传**

追加到 `packages/server/agents/src/turn.test.ts`：

```ts
  it('finalText 在成功与失败两种结论下都被带出', async () => {
    // 造一个在流里写 state.finalText 的假适配器：骨架只负责把它带进结果，不负责解释它
    const hooks: TurnHooks = {
      kind: 'codex',
      start: async () => ({
        stream: (async function* () {
          yield { type: 'x' };
        })(),
        interrupt: () => {},
        dispose: async () => {},
        project: (_raw, state) => {
          state.finalText = '最终答复';
          return { drafts: [], tokens: null, turns: null, failure: null };
        },
      }),
    };
    const ok = await runTurn(createRunInput(), hooks);
    expect(ok.finalText).toBe('最终答复');
  });

  it('没采到答复时 finalText 是 null（不猜、不填空串）', async () => {
    const hooks: TurnHooks = {
      kind: 'codex',
      start: async () => ({
        stream: (async function* () {})(),
        interrupt: () => {},
        dispose: async () => {},
        project: () => ({ drafts: [], tokens: null, turns: null, failure: null }),
      }),
    };
    const result = await runTurn(createRunInput(), hooks);
    expect(result.finalText).toBeNull();
  });
```

- [ ] **Step 13: 跑测试确认通过**

Run: `pnpm --filter @aieval/agents test`
Expected: 全 PASS（`turn.test.ts` 里既有的 `toMatchObject` 断言不受影响——它是部分匹配）

- [ ] **Step 14: 变异验证**

1. 把 `providers/dsh/events.ts` 的 `readAssistantText` 过滤条件从 `record?.type === 'text'` 改成 `typeof record?.text === 'string'` → 「reasoning 块不算答复」**必须变红**。
2. 把 `providers/codex/events.ts` 的 `if (readString(item, 'type') === 'agent_message')` 整行删掉，改成无条件 `state.finalText = text;` → 「工具输出的 text 不算最终答复」**必须变红**。
3. 还原两处，`git diff --stat` 核对。

- [ ] **Step 15: 全链验证并提交**

```bash
pnpm typecheck
pnpm lint
pnpm --filter @aieval/agents test
git add packages/server/agents/src/types.ts packages/server/agents/src/turn.ts packages/server/agents/src/turn.test.ts packages/server/agents/src/providers/claude-code/events.ts packages/server/agents/src/providers/claude-code/events.test.ts packages/server/agents/src/providers/codex/events.ts packages/server/agents/src/providers/codex/events.test.ts packages/server/agents/src/providers/dsh/events.ts packages/server/agents/src/providers/dsh/events.test.ts
git commit -m "feat(agents): 补最终答复出口 finalText——三家各自的采集点"
```

---

### Task 3: `finalizeScore` 收口 + 智能体评分通路 + `requireJudgeAgent`

**Files:**
- Modify: `packages/server/evaluator/src/judge.ts`
- Create: `packages/server/evaluator/src/judge-agent.ts`
- Create: `packages/server/evaluator/src/judge-agent.test.ts`
- Modify: `packages/server/evaluator/src/judge-route.ts`
- Modify: `packages/server/evaluator/src/judge-route.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `ScoreResult.judgeAgentKind`、`Settings.defaultJudgeAgent`；Task 2 的 `AgentRunResult.finalText`
- Produces:
  - `finalizeScore(input: { parsed; raw; judgeProviderId; judgeModelId; judgeAgentKind }): ScoreResult`（`judge.ts` 导出）
  - `class JudgeAgentError extends Error { readonly agentCode: AgentErrorCode }`（`judge-agent.ts` 导出）
  - `judgeRowByAgent(input: AgentJudgeInput): Promise<ScoreResult>`（`judge-agent.ts` 导出）
  - `requireJudgeAgent(input: { defaultJudgeAgent: AgentKind | null; route: TextRoute }): AgentKind`（`judge-route.ts` 导出）

**关键约束（先读这一条再动手）：** `AGENT_FAILED` / `AGENT_TIMED_OUT` 等**不是** contracts 的 `ErrorCode`（`errors.ts:7-19` 只有 11 个，且 `STATUS_BY_CODE` 是 `Record<ErrorCode, number>`），agents 的 `types.ts:21-25` 明写「塞进 `ERROR_CODES` 会逼 `STATUS_BY_CODE` 为它编造状态码」。所以**不要**把评分智能体的失败码折成 `ServiceError`——那会让「超时」与「答错了」在界面上长得一样。用 `JudgeAgentError` 承载，由 Task 4 的编排层翻译成行终态。

- [ ] **Step 1: 写失败的测试——`finalizeScore` 两路共用**

追加到 `packages/server/evaluator/src/judge.test.ts`：

```ts
  it('finalizeScore：文本通路的 judgeAgentKind 是 null，智能体通路是具体 kind', () => {
    const dimensions = DIMENSIONS.map(({ key, label }) => ({ key, label, score: 5, reason: '理由' }));
    const parsed = Object.assign(dimensions, { verdict: '总评' });

    const text = finalizeScore({
      parsed,
      raw: '{}',
      judgeProviderId: 'p1',
      judgeModelId: 'm1',
      judgeAgentKind: null,
    });
    expect(text.judgeAgentKind).toBeNull();
    // 总分一律由 5 维重算（不采信模型自报）——两条通路共用同一条口径
    expect(text.totalScore).toBe(100);

    const byAgent = finalizeScore({
      parsed,
      raw: '{}',
      judgeProviderId: 'p1',
      judgeModelId: 'm1',
      judgeAgentKind: 'dsh',
    });
    expect(byAgent.judgeAgentKind).toBe('dsh');
    expect(byAgent.totalScore).toBe(text.totalScore);
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @aieval/evaluator test -- judge.test`
Expected: FAIL —— `finalizeScore is not a function`

- [ ] **Step 3: 抽 `finalizeScore` 并从 `judgeRow` 调用**

`packages/server/evaluator/src/judge.ts`：把 `judgeRow` 里「造 `result` → 自检 → 返回 `checked.data`」整段（原第 211–239 行）剪出来，改成新函数：

```ts
/**
 * 把「已解析的维度 + 原文」收口成契约认可的 `ScoreResult`。
 * 为什么**必须**是一个函数：文本通路与智能体通路共用同一把尺子的全部口径——5 维等权、
 * 总分一律由 5 维重算（不采信模型自报）、raw 的截断上限、以及「形状漂移在这里就炸」的自检。
 * 两条通路各写一份必然在某一处漂移，而漂移的表现是「两条通路的分数不可比」——最不该静默发生的一类。
 */
export function finalizeScore(input: {
  parsed: ScoreResult['dimensions'] & { verdict: string };
  raw: string;
  judgeProviderId: string;
  judgeModelId: string;
  /** null ⇔ 走纯文本 API（见 contracts 的 ScoreResult.judgeAgentKind） */
  judgeAgentKind: AgentKind | null;
}): ScoreResult {
  const result: ScoreResult = {
    dimensions: [...input.parsed],
    // 总分一律重算：模型自报的总分可能算错，而界面必须与 5 维分自洽（§9 第 6 项冒烟）
    totalScore: composeTotalScore(input.parsed.map((item) => item.score)),
    verdict: input.parsed.verdict,
    raw: truncateRaw(input.raw, RAW_MAX_CHARS),
    judgeProviderId: input.judgeProviderId,
    judgeModelId: input.judgeModelId,
    judgeAgentKind: input.judgeAgentKind,
    judgedAt: new Date().toISOString(),
  };
  // 契约自检：形状漂移在这里就炸，而不是把脏数据写进 run.json 等读的时候才发现。
  // 抛的必须是中文 ServiceError（code 用 INTERNAL：这不是模型答错，而是我们自己的形状漂移）
  const checked = ScoreResultSchema.safeParse(result);
  if (!checked.success) {
    const issues = checked.error.issues;
    const detail = issues
      .slice(0, 3)
      .map((issue) => `${issue.path.length === 0 ? '（根对象）' : issue.path.join('.')}：${issue.message}`)
      .join('；');
    const more = issues.length > 3 ? `；另有 ${issues.length - 3} 处` : '';
    throw new ServiceError('INTERNAL', `评分结果不符合契约（本包形状漂移，本不该发生）：${detail}${more}`, {
      cause: checked.error,
      context: {
        judgeModelId: input.judgeModelId,
        issues: issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
      },
    });
  }
  return checked.data;
}
```

`judgeRow` 的尾段改成：

```ts
  return finalizeScore({
    parsed,
    raw,
    judgeProviderId: input.judgeProviderId,
    judgeModelId: input.route.modelId,
    judgeAgentKind: null,
  });
```

文件顶部 import 补 `type AgentKind`（与既有的 `type DimensionKey` 同一个 import 块）。

- [ ] **Step 4: 跑测试确认通过 + 既有评分用例全绿**

Run: `pnpm --filter @aieval/evaluator test -- judge.test`
Expected: 全 PASS（`judgeRow` 的行为一个字没变，只是把收口挪进了一个函数）

- [ ] **Step 5: 写失败的测试——`requireJudgeAgent`**

追加到 `packages/server/evaluator/src/judge-route.test.ts`：

```ts
  it('requireJudgeAgent：没配置默认评分智能体 → CONFLICT，且指出两条出路', () => {
    expect(() =>
      requireJudgeAgent({ defaultJudgeAgent: null, route: { protocolType: 'anthropic', baseUrl: 'x', apiKey: 'k', modelId: 'm' } }),
    ).toThrowError(/没有配置默认评分智能体/);
  });

  it('requireJudgeAgent：协议不匹配 → CONFLICT，并点名两家', () => {
    // codex 只吃 openai 协议（注册表元数据），拿 anthropic 的路由喂它必然在运行时才炸
    expect(() =>
      requireJudgeAgent({ defaultJudgeAgent: 'codex', route: { protocolType: 'anthropic', baseUrl: 'x', apiKey: 'k', modelId: 'm' } }),
    ).toThrowError(/Codex 只接受OpenAI 兼容协议的模型/);
  });

  it('requireJudgeAgent：匹配时原样返回那个 kind', () => {
    expect(
      requireJudgeAgent({ defaultJudgeAgent: 'codex', route: { protocolType: 'openai', baseUrl: 'x', apiKey: 'k', modelId: 'm' } }),
    ).toBe('codex');
    expect(
      requireJudgeAgent({ defaultJudgeAgent: 'dsh', route: { protocolType: 'anthropic', baseUrl: 'x', apiKey: 'k', modelId: 'm' } }),
    ).toBe('dsh');
  });
```

- [ ] **Step 6: 跑测试确认失败**

Run: `pnpm --filter @aieval/evaluator test -- judge-route.test`
Expected: FAIL —— `requireJudgeAgent is not a function`

- [ ] **Step 7: 实现 `requireJudgeAgent`**

`packages/server/evaluator/src/judge-route.ts` 顶部 import 补：

```ts
import { AGENT_LABELS, PROTOCOL_LABELS, ServiceError, type AgentKind, type ProtocolType } from '@aieval/contracts';
import { getProvider } from '@aieval/agents';
```

（原 `import { ServiceError, type ProtocolType } from '@aieval/contracts';` 整行替换掉。）

文件末尾加：

```ts
/**
 * 解析「这一轮该用哪家智能体评分」，并把两种配置问题折成可直接展示的中文 CONFLICT。
 *
 * 为什么放在本文件：它与 `resolveJudgeRoute` 是同一件事的两半——尺子落在哪个模型上、谁来驱动它。
 * 为什么 api 层也要用它：创建评测时要**提前**拦一次（不要让人选完到评分阶段才失败）。
 *
 * 协议兼容不是可选项：智能体的元数据里只有一个 `protocolType`（agents 注册表 A3），而评分模型那一对
 * 可能来自另一种协议的供应商——两者不匹配时那家 CLI 根本驱动不了它（Codex 走 chat-completions，
 * Claude Code / DSH 走 Messages）。
 */
export function requireJudgeAgent(input: { defaultJudgeAgent: AgentKind | null; route: TextRoute }): AgentKind {
  const kind = input.defaultJudgeAgent;
  if (kind === null) {
    throw new ServiceError(
      'CONFLICT',
      `这一轮启用了智能体评分，但没有配置默认评分智能体：${GO_SETTINGS}，或新建评测时关闭「使用智能体评分」`,
      { context: { protocolType: input.route.protocolType, modelId: input.route.modelId } },
    );
  }
  const { metadata } = getProvider(kind);
  if (metadata.protocolType !== input.route.protocolType) {
    throw new ServiceError(
      'CONFLICT',
      `${AGENT_LABELS[kind]} 只接受${PROTOCOL_LABELS[metadata.protocolType]}协议的模型，` +
        `而本次评分用的 ${input.route.modelId} 属于${PROTOCOL_LABELS[input.route.protocolType]}协议：` +
        '请到「设置 → 评分配置」换一个与所选评分模型协议匹配的默认评分智能体',
      { context: { kind, expected: metadata.protocolType, actual: input.route.protocolType } },
    );
  }
  return kind;
}
```

- [ ] **Step 8: 跑测试确认通过**

Run: `pnpm --filter @aieval/evaluator test -- judge-route.test`
Expected: PASS

- [ ] **Step 9: 写失败的测试——`judgeRowByAgent` 的失败面**

新建 `packages/server/evaluator/src/judge-agent.test.ts`：

```ts
// @vitest-environment node
/**
 * 智能体评分通路：拼词、日志前缀、失败面。
 * 适配器被 mock 成 `fakeAgentsModule()`（`testing/fixtures.ts`），它的行为由 `fakeAgents.scripts` 驱动。
 * 注意 `vi.mock` 的工厂**会被提升**：里面不能引用顶层的 import，只能动态 import（与 orchestrator.test.ts 同形）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DIMENSIONS, JUDGE_OUTPUT_CONTRACT, type AgentEvent } from '@aieval/contracts';
import { fakeAgents, resetFakeAgents } from './testing/fixtures';
import { JudgeAgentError, buildAgentJudgePrompt, judgeRowByAgent } from './judge-agent';

vi.mock('@aieval/agents', async () => {
  const { fakeAgentsModule } = await import('./testing/fixtures');
  return fakeAgentsModule();
});

const ROUTE = { protocolType: 'openai' as const, baseUrl: 'https://fake.invalid/v1', apiKey: 'k', modelId: 'm1' };

/** 一次最小调用；`finalText` 由各用例通过 `fakeAgents.scripts` 设定 */
function callJudge(): ReturnType<typeof judgeRowByAgent> {
  return judgeRowByAgent({
    kind: 'codex',
    cwd: process.cwd(),
    configHome: process.cwd(),
    route: ROUTE,
    baselineCommit: 'a'.repeat(40),
    judgePrompt: '按 5 个维度打分',
    taskPrompt: '把 README 改成中文',
    dimensions: DIMENSIONS,
    timeoutMs: 1_000,
    signal: new AbortController().signal,
    onEvent: () => {},
  });
}

beforeEach(() => {
  resetFakeAgents();
});

describe('judgeRowByAgent', () => {
  it('提示词带上基线 commit、只读要求与输出契约（本通路存在的理由都在这几行里）', () => {
    const prompt = buildAgentJudgePrompt({
      taskPrompt: '把 README 改成中文',
      judgePrompt: '按 5 个维度打分',
      dimensions: DIMENSIONS,
      baselineCommit: 'a'.repeat(40),
    });
    // ① 基线：不说基线，智能体就不知道该跟什么比
    expect(prompt).toContain('a'.repeat(40));
    // ② 按需读、不要整段打印 —— 这正是本通路能处理大 diff 的原因
    expect(prompt).toContain('不要试图把它整段打印出来');
    // ③ 只读要求：工作区是候选的产出（spec §7.4 的处置）
    expect(prompt).toContain('只读评审');
    // ④ 输出契约与文本通路**逐字同一份**（单一真源；抄一份必然漂移）
    expect(prompt).toContain(JUDGE_OUTPUT_CONTRACT);
    // ⑤ 题面与用例的评分提示词都要在
    expect(prompt).toContain('把 README 改成中文');
    expect(prompt).toContain('按 5 个维度打分');
  });

  it('finalText 是合法评分 JSON 时出分，judgeAgentKind 记为实际 kind', async () => {
    fakeAgents.scripts.set('codex', { mode: 'ok', finalText: JSON.stringify({
      dimensions: DIMENSIONS.map(({ key, label }) => ({ key, label, score: 5, reason: '好' })),
      verdict: '不错',
    }) });
    const score = await callJudge();
    expect(score.judgeAgentKind).toBe('codex');
    expect(score.totalScore).toBe(100);
  });

  it('finalText 为 null → JUDGE_PARSE_FAILED（该家没回传最终消息）', async () => {
    fakeAgents.scripts.set('codex', { mode: 'ok', finalText: null });
    await expect(callJudge()).rejects.toThrowError(/没有给出可读的最终答复/);
  });

  it('答复是散文 → JUDGE_PARSE_FAILED，并把原文留在 context.raw', async () => {
    fakeAgents.scripts.set('codex', { mode: 'ok', finalText: '我觉得这个改动还不错' });
    await expect(callJudge()).rejects.toMatchObject({
      code: 'JUDGE_PARSE_FAILED',
      context: { raw: '我觉得这个改动还不错' },
    });
  });

  it('适配器自报失败 → JudgeAgentError（不是 ServiceError：AGENT_* 不是契约的错误码）', async () => {
    fakeAgents.scripts.set('codex', { mode: 'error' });
    await expect(callJudge()).rejects.toBeInstanceOf(JudgeAgentError);
    await expect(callJudge()).rejects.toMatchObject({ agentCode: 'AGENT_FAILED' });
  });

  it('AUTH_FAILED / RATE_LIMITED 原样带出（不折成解析失败——「没问到」与「答错了」是两回事）', async () => {
    fakeAgents.scripts.set('codex', {
      mode: 'error',
    });
    // 假适配器的 error 脚本固定给 AGENT_FAILED；两类上游归因由下面的断言直接构造
    expect(new JudgeAgentError('AUTH_FAILED', '密钥无效').agentCode).toBe('AUTH_FAILED');
    expect(new JudgeAgentError('RATE_LIMITED', '限流').agentCode).toBe('RATE_LIMITED');
  });

  it('日志事件加 [评分智能体] 前缀后转发（日志抽屉里能区分候选与评审者的输出）', async () => {
    const collected: AgentEvent[] = [];
    fakeAgents.scripts.set('codex', {
      mode: 'ok',
      finalText: judgeReplyJson(4),
      // 需要先给夹具的 FakeAgentScript 加 `events?: { stream: 'stdout' | 'stderr'; text: string }[]`
      // （见 Step 11 末尾的夹具改动）：假适配器在 finish() 之前把它们逐条投给 input.onEvent
      events: [
        { stream: 'stdout', text: '我先看看 git diff' },
        { stream: 'stderr', text: '警告：改动很大' },
      ],
    });

    await judgeRowByAgent({
      kind: 'codex',
      cwd: process.cwd(),
      configHome: process.cwd(),
      route: ROUTE,
      baselineCommit: 'a'.repeat(40),
      judgePrompt: 'j',
      taskPrompt: 't',
      dimensions: DIMENSIONS,
      timeoutMs: 1_000,
      signal: new AbortController().signal,
      judgeProviderId: 'p1',
      onEvent: (event) => collected.push(event),
    });

    const logs = collected.filter((event) => event.type === 'log').map((event) => (event.type === 'log' ? event.text : ''));
    expect(logs).toEqual(['[评分智能体] 我先看看 git diff', '[评分智能体] 警告：改动很大']);
  });

  it('空答复（finalText 是空串）与「没采到」（null）的文案必须能区分', async () => {
    fakeAgents.scripts.set('codex', { mode: 'ok', finalText: '' });
    await expect(callJudge()).rejects.toThrowError(/返回了空答复/);

    fakeAgents.scripts.set('codex', { mode: 'ok', finalText: null });
    await expect(callJudge()).rejects.toThrowError(/没有给出可读的最终答复/);
  });
});
```

`judgeReplyJson` 是本文件内的私有小助手（放在 `callJudge` 旁边）：

```ts
/** 一份合法的评分 JSON 答复 */
function judgeReplyJson(score: number): string {
  return JSON.stringify({
    dimensions: DIMENSIONS.map(({ key, label }) => ({ key, label, score, reason: `${label}：假评分智能体给 ${score} 分` })),
    verdict: '假评分智能体的总评',
  });
}
```

> **Step 11 末尾还要顺带改夹具**：`packages/server/evaluator/src/testing/fixtures.ts` 的
> `FakeAgentScript` 加 `events?: { stream: 'stdout' | 'stderr'; text: string }[]`，并在 `finish()` 之前
> `for (const item of script.events ?? []) input.onEvent({ seq: 0, at: new Date().toISOString(), type: 'log', stream: item.stream, text: item.text });`
> （`seq` 会被 core 的写入器重新分配，测试里给 0 即可）。同时给 `FakeAgentScript` 加
> `finalText?: string | null`，并在 `finish()` 的返回对象里加 `finalText: script.finalText === undefined ? null : script.finalText`
> （**显式判 `undefined`**，不要用 `??`——它会把显式的 `null` 一并兜掉，而 `null` 是「没采到」这个有意义的取值，
> 与同文件里 tokens 那一段的既有口径一致）。

- [ ] **Step 10: 跑测试确认失败**

Run: `pnpm --filter @aieval/evaluator test -- judge-agent.test`
Expected: FAIL —— `Failed to resolve import "./judge-agent"`

- [ ] **Step 11: 实现 `judge-agent.ts`**

```ts
/**
 * 智能体评分通路：把评分交给一个**在该行工作区里跑的智能体会话**，而不是一次文本请求。
 *
 * 为什么需要它（spec §1 第 1 条）：纯文本通路要把「评分提示词 + 代码改动 + 维度定义」一次性塞进一次
 * 请求。改动超过上下文窗口时只有两条路——请求失败，或按 `diffBudgetBytes` 裁掉一部分文件。后者更危险：
 * **分数照样出得来，只是在残缺输入上得出**，与正常分数在界面上一模一样。
 * 智能体通路的解法是让评审者自己去仓库里看：它按文件读、按需读，输入不再是一段文本。
 *
 * 四条口径：
 *   1. **解析与收口与文本通路共用**（`parseJudgeResponse` + `finalizeScore`）：围栏剥离、越界夹紧、
 *      维度缺失直接失败、总分一律重算——一个字都不改。两条通路给的必须是同一把尺子；
 *   2. **只读要求写进提示词**：工作区是候选的产出，评分智能体改了它就污染「查看改动」抽屉
 *      （抽屉按需现算 diff）。要求只读之外，编排层还会做一次摘要对照（spec §7.4）；
 *   3. **失败面分两类**：适配器自己失败 → `JudgeAgentError`（带 agents 的原始归因码）；
 *      「拿到了答复但解析不了」→ `ServiceError('JUDGE_PARSE_FAILED')` + `context.raw`。
 *      **绝不把 AGENT_* 折成 ServiceError**：它们不是 contracts 的 `ErrorCode`（errors.ts 只有 11 个，
 *      `STATUS_BY_CODE` 是 `Record<ErrorCode, number>`），硬折会逼着为它编造 HTTP 状态，
 *      而且会让「超时」与「答错了」在界面上长得一样；
 *   4. **`finalText === null` 不等于空答复**：前者是这一家没回传最终消息（比如适配器违约），
 *      后者是它明确回了空串——两种都要失败，但文案要能区分。
 */
import {
  JUDGE_OUTPUT_CONTRACT,
  ServiceError,
  type AgentEvent,
  type AgentKind,
  type DimensionKey,
  type ScoreResult,
} from '@aieval/contracts';
import { getProvider, type AgentErrorCode } from '@aieval/agents';
import { finalizeScore, parseJudgeResponse } from './judge';
import type { TextRoute } from './text-api';

/** 转发进该行事件日志时的前缀：日志抽屉里必须能区分候选的输出与评审者的输出 */
const AGENT_LOG_PREFIX = '[评分智能体] ';

/** 解析失败时随错误一起保留的原文上限（与文本通路同一个数量级：够看清，又不撑爆事件日志） */
const RAW_KEEP_CHARS = 2_000;

/**
 * 评分智能体**自身**的停止 / 失败：不是契约的 `ErrorCode`，故不能折成 `ServiceError`。
 * 携带 agents 的原始归因码（`AgentErrorCode`），由编排层翻译成行的终态：
 * `AGENT_CANCELED` → canceled、`AGENT_TIMED_OUT` → timed-out、其余 → failed。
 */
export class JudgeAgentError extends Error {
  readonly agentCode: AgentErrorCode;

  constructor(agentCode: AgentErrorCode, message: string) {
    super(message);
    this.name = 'JudgeAgentError';
    this.agentCode = agentCode;
  }
}

export interface AgentJudgeInput {
  /** 评分智能体（来自 `settings.defaultJudgeAgent`，由 `requireJudgeAgent` 校验过协议） */
  kind: AgentKind;
  /** 该行工作区（候选改完的状态）—— 评分智能体的 cwd */
  cwd: string;
  /** 评分智能体自己的独立配置目录（`.judgehome`，见 core 的 `rowJudgeHomeDir`） */
  configHome: string;
  /** 复用「默认评分模型」那一对：模型与凭据都在这里 */
  route: TextRoute;
  /** 让评分智能体知道拿什么当基线看改动 */
  baselineCommit: string;
  judgePrompt: string;
  taskPrompt: string;
  dimensions: readonly { key: DimensionKey; label: string }[];
  timeoutMs: number;
  signal: AbortSignal;
  onEvent: (event: AgentEvent) => void;
}

/**
 * 拼评分提示词。顺序与文本通路的 `buildJudgePrompt` 对齐，但多一段「改动怎么看」——
 * 那一段正是本通路存在的理由：不让模型把改动整段打印出来，而是让它按文件读。
 * 「只读」必须显式写：工作区是候选的产出，被评审者改动之后「查看改动」抽屉显示的就不再是候选的产出。
 */
export function buildAgentJudgePrompt(input: {
  taskPrompt: string;
  judgePrompt: string;
  dimensions: readonly { key: DimensionKey; label: string }[];
  baselineCommit: string;
}): string {
  const dimensions = input.dimensions.map(({ key, label }) => `- ${label}（${key}）：1–5 分整数`).join('\n');
  return [
    '你是一名资深代码评审专家。你要评的是下面这道考题的候选实现，评分依据是**工作区里的真实改动**。',
    '',
    '## 考题（候选拿到的任务）',
    input.taskPrompt,
    '',
    '## 评分维度（各 1–5 分，等权）',
    dimensions,
    '',
    '## 本用例的评分提示词',
    input.judgePrompt,
    '',
    '## 改动在哪、怎么看',
    `当前目录就是候选的工作区，改动相对基线 commit \`${input.baselineCommit}\`：`,
    `- 已跟踪文件的改动：\`git diff ${input.baselineCommit}\`；`,
    `- 新增但未跟踪的文件：\`git status --porcelain\` 里 \`??\` 的那些，自己按需读取；`,
    '- **改动可能很大，不要试图把它整段打印出来**：按文件读、按需读，先看文件清单再决定读哪些。',
    '',
    '## 硬性要求',
    '1. **只读评审**：不要修改、创建、删除工作区里的任何文件，也不要执行会写文件的命令',
    '   （格式化、安装依赖、跑测试、改配置都不行）。你的产出只有下面这个 JSON。',
    '2. 只依据你在工作区里**真实看到**的代码打分；看不到的部分不要臆测。',
    '3. 把最终答复**作为你最后一条消息的正文**直接给出，不要写进任何文件。',
    '',
    JUDGE_OUTPUT_CONTRACT,
  ].join('\n');
}

/** 给日志事件加前缀：`error` 事件不加（它是结论，界面上单独一条更醒目） */
function prefixEvent(event: AgentEvent): AgentEvent {
  if (event.type !== 'log') return event;
  return { ...event, text: `${AGENT_LOG_PREFIX}${event.text}` };
}

/** 截断原文并留明确标记（与文本通路同一口径：要能区分「模型只说了这么多」与「我们截了」） */
function truncateRaw(text: string, max = RAW_KEEP_CHARS): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…（原始返回共 ${text.length} 字符，此处截断）`;
}

/**
 * 跑一次智能体评分：启动适配器 → 取最终答复 → 解析 → 收口。
 * 已中止的 signal 也要走一次 `run()`：适配器自己知道「进入即已中止」该怎么收场
 * （`turn.ts` 的对应分支会给 canceled 且不建任何运行时），在这里另写一份判断只会造出第二条真相。
 */
export async function judgeRowByAgent(input: AgentJudgeInput): Promise<ScoreResult> {
  const provider = getProvider(input.kind);
  const prompt = buildAgentJudgePrompt({
    taskPrompt: input.taskPrompt,
    judgePrompt: input.judgePrompt,
    dimensions: input.dimensions,
    baselineCommit: input.baselineCommit,
  });

  const result = await provider.run({
    cwd: input.cwd,
    configHome: input.configHome,
    prompt,
    route: input.route,
    timeoutMs: input.timeoutMs,
    signal: input.signal,
    onEvent: (event) => {
      input.onEvent(prefixEvent(event));
    },
  });

  if (!result.ok) {
    // 适配器违约（ok:false 却不给 error）也要给出可读归因，不能让界面显示空白原因
    const code = result.error?.code ?? 'AGENT_FAILED';
    const message = result.error?.message ?? '评分智能体执行失败（适配器未给出原因）';
    throw new JudgeAgentError(code, message);
  }

  const raw = result.finalText;
  if (raw === null || raw.trim() === '') {
    throw new ServiceError(
      'JUDGE_PARSE_FAILED',
      // 两种成因文案必须能分开：null 是适配器没回传，空串是它回了个空答复
      raw === null
        ? '评分智能体没有给出可读的最终答复（该适配器未回传最终消息）：请确认它能在最后一条消息里输出 JSON'
        : '评分智能体返回了空答复：请检查评分提示词，或在设置页换一家评分智能体',
      { context: { kind: input.kind, modelId: input.route.modelId, finalText: raw } },
    );
  }

  let parsed: ReturnType<typeof parseJudgeResponse>;
  try {
    parsed = parseJudgeResponse(raw);
  } catch (error) {
    const detail = error instanceof ServiceError ? error.message : error instanceof Error ? error.message : String(error);
    throw new ServiceError('JUDGE_PARSE_FAILED', `评分解析失败：${detail}`, {
      context: { raw: truncateRaw(raw) },
      cause: error,
    });
  }

  return finalizeScore({
    parsed,
    raw,
    judgeProviderId: input.route.providerId ?? '',
    judgeModelId: input.route.modelId,
    judgeAgentKind: input.kind,
  });
}
```

> **注意 `judgeProviderId`**：`TextRoute` 里**没有** `providerId`（见 `text-api.ts` 的接口）。所以 `AgentJudgeInput` 要**再加一格** `judgeProviderId: string`，并用它而不是 `input.route.providerId ?? ''`（后者编译不过）。改完的调用处由 Task 4 提供：它拿的是 `testCase.judgeProviderId ?? settings.defaultJudge?.providerId ?? ''`，与文本通路那一处**同一个表达式**（R14 的恒等口径）。

- [ ] **Step 12: 跑测试确认通过**

Run: `pnpm --filter @aieval/evaluator test -- judge-agent.test`
Expected: PASS

- [ ] **Step 13: 变异验证**

1. 把 `judge-agent.ts` 里 `raw === null || raw.trim() === ''` 的 `|| raw.trim() === ''` 删掉 → 「答复是散文」那条仍红，但空串那条会变成「解析空内容」——确认没有测试能区分两种文案时，**补一条** `finalText: ''` 的用例并确认它命中「返回了空答复」。
2. 把 `prefixEvent` 改成原样返回 `event` → 「日志前缀」那条**必须变红**。
3. 还原，`git diff --stat` 核对。

- [ ] **Step 14: 全链验证并提交**

```bash
pnpm typecheck
pnpm lint
pnpm --filter @aieval/evaluator test
git add packages/server/evaluator/src/judge.ts packages/server/evaluator/src/judge.test.ts packages/server/evaluator/src/judge-agent.ts packages/server/evaluator/src/judge-agent.test.ts packages/server/evaluator/src/judge-route.ts packages/server/evaluator/src/judge-route.test.ts packages/server/evaluator/src/testing/fixtures.ts
git commit -m "feat(evaluator): 智能体评分通路——finalizeScore 收口与 judgeRowByAgent"
```

---

### Task 4: 编排层接线——`.judgehome`、第 7 步分支、评分阶段外层兜底、污染对照

**Files:**
- Modify: `packages/server/core/src/workspace.ts`
- Modify: `packages/server/core/src/index.ts`
- Modify: `packages/server/evaluator/src/orchestrator.ts`
- Test: `packages/server/core/src/workspace.test.ts`、`packages/server/evaluator/src/orchestrator.test.ts`

**Interfaces:**
- Consumes: Task 3 的 `judgeRowByAgent` / `JudgeAgentError` / `requireJudgeAgent`；Task 1 的 `EvalRun.useAgentJudge`、`Settings.defaultJudgeAgent`
- Produces: `rowJudgeHomeDir(workspaceRoot, runId, rowId): string`、`ensureRowJudgeHome(workspaceRoot, runId, rowId): string`（core 包根）；编排层内部的 `runJudgeStage(ctx)`（Task 7 复用）

- [ ] **Step 1: 写失败的测试——`.judgehome` 的路径与清理**

追加到 `packages/server/core/src/workspace.test.ts`：

```ts
  it('rowJudgeHomeDir 落在行目录下的 .judgehome（与 .agenthome 分开：评分智能体可能不是同一家）', () => {
    const root = mkdtempSync(join(tmpdir(), 'aieval-core-judgehome-'));
    expect(rowJudgeHomeDir(root, 'run-1', 'row-1')).toBe(join(root, 'run-1', 'rows', 'row-1', '.judgehome'));
    rmSync(root, { recursive: true, force: true });
  });

  it('重跑同一行会清掉 .judgehome（上一轮评分智能体的会话与配置不该留给下一轮）', () => {
    const root = mkdtempSync(join(tmpdir(), 'aieval-core-judgehome-'));
    const { repoPath, commit } = initFixtureRepo(join(root, 'repo'));
    const input = {
      workspaceRoot: join(root, 'runs'),
      caseId: 'case-1',
      repoPath,
      runId: 'run-1',
      rowId: 'row-1',
      commitHash: commit,
      branch: 'test/row-1',
    };

    // 第一轮：建工作区 + 建评分智能体配置目录 + 往里写一个文件（模拟 CLI 落下的会话文件）
    prepareRowWorkspace(input);
    const judgeHome = ensureRowJudgeHome(input.workspaceRoot, input.runId, input.rowId);
    writeFileSync(join(judgeHome, 'session.json'), '{"model":"评分智能体"}', 'utf8');
    expect(existsSync(join(judgeHome, 'session.json'))).toBe(true);

    // 第二轮：重跑同一行。clearRowArtifacts 里那条 .judgehome 的 rmSync 是**分开写的**，
    // 漏了它这条用例才会红（变异验证见 Step 9）
    prepareRowWorkspace(input);
    expect(existsSync(join(judgeHome, 'session.json'))).toBe(false);

    rmSync(root, { recursive: true, force: true });
  });
```

（`initFixtureRepo` 由本文件既有的 import 提供；若该文件用的是别的建仓夹具，照它现有的写法改一行即可，**不要**新造第二个建仓夹具。）

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @aieval/core test -- workspace.test`
Expected: FAIL —— `rowJudgeHomeDir is not a function`

- [ ] **Step 3: 实现 core 的两个路径助手与清理**

`packages/server/core/src/workspace.ts`，在 `rowAgentHomeDir` 之后加：

```ts
/**
 * 该行的**评分智能体**独立配置目录。
 * 为什么不能复用 `.agenthome`：评分智能体可能与被测智能体不是同一家，而 `.agenthome` 是
 * `CLAUDE_CONFIG_DIR` / `DSH_HOME` / `CODEX_HOME` 的落点——两家的配置文件格式不同，共用一个目录
 * 会互相破坏，而且破坏是**静默的**（CLI 会安静地忽略读不懂的配置，表现成「模型路由没生效」）。
 */
export function rowJudgeHomeDir(workspaceRoot: string, runId: string, rowId: string): string {
  return join(rowDir(workspaceRoot, runId, rowId), '.judgehome');
}

/** 建该行的评分智能体配置目录并返回路径（只有启用智能体评分的轮次才会调它） */
export function ensureRowJudgeHome(workspaceRoot: string, runId: string, rowId: string): string {
  const dir = rowJudgeHomeDir(workspaceRoot, runId, rowId);
  mkdirSync(dir, { recursive: true });
  return dir;
}
```

`clearRowArtifacts` 补第三条（**分开写**，与该函数「新落的东西默认不被顺手删掉」的口径一致）：

```ts
function clearRowArtifacts(dir: string): void {
  rmSync(join(dir, 'workspace'), { recursive: true, force: true });
  rmSync(join(dir, '.agenthome'), { recursive: true, force: true });
  rmSync(join(dir, '.judgehome'), { recursive: true, force: true });
}
```

同函数的 JSDoc 那句「两份产物」改成「三份产物」，并把新增的那一份写进去。

`packages/server/core/src/index.ts` 的 `'./workspace'` 导出块加两个名字（按字母序）：

```ts
export {
  caseCacheDir,
  ensureRowJudgeHome,
  prepareRowWorkspace,
  rowAgentHomeDir,
  rowDir,
  rowEventsFile,
  rowJudgeHomeDir,
  rowWorkspaceDir,
  runDir,
  runSnapshotFile,
} from './workspace';
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @aieval/core test -- workspace.test`
Expected: PASS

- [ ] **Step 5: 先修两处会直接让测试跑不起来的夹具问题，再写用例**

**(a) `vi.mock('./judge')` 会把整个模块换掉，`judge-agent.ts` 也 import 它。**
`fakeJudgeModule()` 只给了 `judgeRow`，于是 `judge-agent.ts` 里的 `parseJudgeResponse` 与
`finalizeScore` 会变成 `undefined` ⇒ 智能体通路一跑就崩，而且崩的形状是 `TypeError: … is not a function`，
看起来像「新代码写错了」。把该文件的 mock 改成**透传真实模块、只替换 `judgeRow`**：

```ts
vi.mock('./judge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./judge')>();
  const { fakeJudgeModule } = await import('./testing/fixtures');
  // 只替换 judgeRow：parseJudgeResponse 与 finalizeScore 必须是真的——judge-agent.ts 也 import 它们，
  // 整模块替换会让智能体通路拿到 undefined（崩成 TypeError，指向完全错误的方向）
  return { ...actual, ...fakeJudgeModule() };
});
```

（`vi.mock('./run-store', …)` 那处已经用了 `importOriginal` 透传，照它的写法。）

**(b) 假适配器的脚本按 `kind` 索引，候选与评分智能体同 kind 时无法分阶段驱动。**
所以本节所有用例统一用**候选 = `codex`（openai）+ 评分智能体 = `claude-code`（anthropic）**，
评分模型那一对来自一条 anthropic 供应商。这样 `fakeAgents.scripts.set('codex', …)` 只影响候选，
`fakeAgents.scripts.set('claude-code', …)` 只影响评分智能体——**不需要给夹具加「按调用序号切脚本」的能力**。

追加到 `packages/server/evaluator/src/orchestrator.test.ts`：

```ts
describe('runRow：评分通路（开关决定谁去驱动那把尺子）', () => {
  it('开关关闭 → 走纯文本通路（既有行为零改动）', async () => {
    const { run } = seedRunnableRun({ rowCount: 1, withJudge: true });
    await runRow(run.id, run.rows[0]?.id ?? '');
    expect(fakeJudge.calls).toHaveLength(1);
    expect(fakeAgents.calls).toHaveLength(1); // 只有候选那一次，评分没有再起一次 agent
    expect(getRun(run.id).rows[0]?.score?.judgeAgentKind).toBeNull();
  });

  it('开关打开 → 走智能体通路，评分智能体在该行工作区里跑，judgeAgentKind 落库', async () => {
    const { run } = seedRunnableRun({ rowCount: 1, useAgentJudge: true, judgeAgentKind: 'claude-code' });
    const rowId = run.rows[0]?.id ?? '';
    fakeAgents.scripts.set('claude-code', { finalText: judgeReplyJson(5) });

    await runRow(run.id, rowId);

    const row = getRun(run.id).rows[0];
    expect(row?.status).toBe('judged');
    expect(row?.score?.judgeAgentKind).toBe('claude-code');
    expect(row?.score?.totalScore).toBe(100);
    expect(fakeJudge.calls).toHaveLength(0); // 纯文本通路一次都没走
    // 两次适配器调用：候选（codex）一次、评分（claude-code）一次
    expect(fakeAgents.calls.map((call) => call.kind)).toEqual(['codex', 'claude-code']);
    expect(fakeAgents.calls[1]?.cwd).toBe(row?.workspacePath);
    expect(fakeAgents.calls[1]?.configHome).toContain('.judgehome');
    expect(fakeAgents.calls[0]?.configHome).toContain('.agenthome');
  });

  it('开关打开但没配默认评分智能体 → 该行 failed + CONFLICT，且评分智能体一次都没起', async () => {
    const { run } = seedRunnableRun({ rowCount: 1, useAgentJudge: true, judgeAgentKind: null });
    await runRow(run.id, run.rows[0]?.id ?? '');
    const row = getRun(run.id).rows[0];
    expect(row?.status).toBe('failed');
    expect(row?.error?.code).toBe('CONFLICT');
    expect(row?.error?.message).toContain('没有配置默认评分智能体');
    expect(fakeAgents.calls).toHaveLength(1); // 只有候选那一次
  });

  it('评分智能体的协议与评分模型不匹配 → 该行 failed + CONFLICT，点名两家', async () => {
    // 候选仍是 codex/openai；评分模型那一对来自 anthropic 供应商 ⇒ codex（只吃 openai）驱动不了它
    const { run } = seedRunnableRun({ rowCount: 1, useAgentJudge: true, judgeAgentKind: 'codex' });
    await runRow(run.id, run.rows[0]?.id ?? '');
    const row = getRun(run.id).rows[0];
    expect(row?.status).toBe('failed');
    expect(row?.error?.message).toMatch(/Codex 只接受OpenAI 兼容协议的模型/);
  });

  // Review Focus 第 3 条：turn.ts 明写 runTurn 可能无界返回，评分阶段没有外层兜底就会永远停在 judging
  it('评分智能体永不返回 → 该行落到 timed-out，而不是永远停在 judging', async () => {
    const { run } = seedRunnableRun({
      rowCount: 1,
      useAgentJudge: true,
      judgeAgentKind: 'claude-code',
      rowTimeoutMs: 20,
    });
    const rowId = run.rows[0]?.id ?? '';
    // 候选（codex）照默认脚本正常完成；评分（claude-code）挂住且无视 signal ⇒ 只有外层硬停能收场
    fakeAgents.scripts.set('claude-code', { mode: 'hang' });

    await runRow(run.id, rowId);

    const row = getRun(run.id).rows[0];
    expect(row?.status).toBe('timed-out');
    expect(row?.error?.code).toBe('AGENT_TIMED_OUT');
    expect(row?.error?.message).toContain('评分智能体');
  });

  // Review Focus 第 4 条：抽屉按需现算 diff，评审者改过工作区就会显示成候选的产出
  it('评分智能体改了工作区 → 落一条点名的 WARN，且不静默', async () => {
    const { run } = seedRunnableRun({ rowCount: 1, useAgentJudge: true, judgeAgentKind: 'claude-code' });
    const rowId = run.rows[0]?.id ?? '';
    // 只有评分智能体（claude-code）写文件；候选（codex）不写 —— 这样「评分前/后摘要不一致」
    // 唯一的成因就是评审者动了工作区
    fakeAgents.scripts.set('claude-code', {
      files: [{ path: 'judge-touched.txt', content: '评审者写的\n' }],
      finalText: judgeReplyJson(4),
    });

    await runRow(run.id, rowId);

    const events = readEvents(rowEventsFile(run.workspaceBase, run.id, rowId));
    expect(events.some((event) => event.type === 'log' && event.text.includes('工作区被改动'))).toBe(true);
  });
});
```

`judgeReplyJson` 是本文件内的私有小助手（放在 `seedRunnableRun` 旁边）：

```ts
/** 一份合法的评分 JSON 答复：智能体通路的 finalText 用它 */
function judgeReplyJson(score: number): string {
  return JSON.stringify({
    dimensions: DIMENSIONS.map(({ key, label }) => ({ key, label, score, reason: `${label}：假评分智能体给 ${score} 分` })),
    verdict: '假评分智能体的总评',
  });
}
```

> **`seedRunnableRun` 要扩三个入参**（本任务的前置改动，写在 `orchestrator.test.ts` 里）：
> `useAgentJudge?: boolean`、`judgeAgentKind?: AgentKind | null`、`rowTimeoutMs?: number`。
> 实现方式：第一个传给 `makeRunFixture`；后两个传给 `seedConfig`。并且 `judgeAgentKind !== null` 时
> **`defaultJudge` 必须指向一条 `protocolType: 'anthropic'` 的供应商**（`makeProviderFixture({ protocolType: 'anthropic', models: [{ id: 'judge-model', source: 'manual' }] })`），
> 否则 `claude-code` / `dsh` 那几条会以「协议不匹配」变红——而那是另一条用例要测的东西。
> **`seedConfig` 与 `makeRunFixture` 的入参扩展见 Task 1 Step 18 的说明。**

- [ ] **Step 6: 跑测试确认失败**

Run: `pnpm --filter @aieval/evaluator test -- orchestrator.test`
Expected: FAIL —— 开关打开的那几条走的是文本通路（`fakeJudge.calls` 为 1、`judgeAgentKind` 为 `null`）

- [ ] **Step 7: 实现编排层的评分阶段**

`packages/server/evaluator/src/orchestrator.ts`：

顶部 import 补：

```ts
import { DIMENSIONS, /* …既有… */ type AgentKind, type EvalRow, type ScoreResult, type TestCase } from '@aieval/contracts';
import { collectDiff, ensureRowJudgeHome, /* …既有… */ truncateDiff } from '@aieval/core';
import { judgeRowByAgent, JudgeAgentError } from './judge-agent';
import { requireJudgeAgent, resolveJudgeRoute } from './judge-route';
import type { TextRoute } from './text-api';
```

在 `rawFromContext` 之后加评分阶段（**放在轮级状态机之前**，它属于行级）：

```ts
/** 评分阶段的可复用输入：完整跑一行与重新评分走**同一条**路径（两处各写一遍必然漂移） */
interface JudgeStageContext {
  runId: string;
  rowId: string;
  run: EvalRun;
  testCase: TestCase;
  workspacePath: string;
  baselineCommit: string;
  /** 第 6 步已算好的裁剪后正文；重新评分传 null（自己现算） */
  diffText: string | null;
  /** 第 6 步已算好的改动摘要（污染对照的「评分前」那一份）；重新评分传 null（自己现算） */
  diffSummary: NonNullable<EvalRow['diff']> | null;
  controller: AbortController;
}

/** 改动摘要（与 `EvalRow.diff` 同形）：污染对照用，只看计数、不需要正文与裁剪 */
function diffSummaryOf(workspacePath: string, baselineCommit: string): NonNullable<EvalRow['diff']> {
  const collected = collectDiff(workspacePath, baselineCommit);
  return {
    filesChanged: collected.filesChanged,
    insertions: collected.insertions,
    deletions: collected.deletions,
    truncated: false,
  };
}

/** 按 `diffBudgetBytes` 裁剪后的改动正文：完整跑一行与重新评分共用同一个算法 */
function clippedDiffText(workspacePath: string, baselineCommit: string, budgetBytes: number): string {
  return truncateDiff(collectDiff(workspacePath, baselineCommit).text, budgetBytes).text;
}

/**
 * 智能体评分的有界执行：内层超时交给适配器，外层另有兜底。
 * 为什么外层兜底不能省（D9 / Review Focus 第 3 条）：`turn.ts` 的 JSDoc 明写 `runTurn` **可能无界返回**
 * （`dispose` 只能尽力让迭代结束），而候选 agent 阶段那个 backstop 早已 `clearTimeout`。没有它，
 * 该行会永远停在 `judging`——而 `isRunningRow('judging')` 为真 ⇒「开始」永远被拒，只能重启服务。
 * 硬停用 **resolve 哨兵值**而不是 reject：`Promise.race` 里那条永不落定的分支若以 reject 收场，
 * 正常跑完时它会在后台变成 unhandled rejection（与候选 agent 阶段的 hardDeadline 同一处置）。
 */
async function judgeByAgentBounded(input: {
  ctx: JudgeStageContext;
  kind: AgentKind;
  judgeHome: string;
  route: TextRoute;
  judgeProviderId: string;
  timeoutMs: number;
}): Promise<ScoreResult> {
  const { ctx } = input;
  const key = rowKey(ctx.runId, ctx.rowId);
  const margin = backstopMarginMs(input.timeoutMs);
  const hardMs = input.timeoutMs + margin + HARD_STOP_MARGIN_MS;

  const backstop = setTimeout(() => {
    timedOutRows.add(key);
    ctx.controller.abort();
    publishRowEvent(ctx.runId, ctx.rowId, {
      type: 'log',
      stream: 'stderr',
      text: `[编排] 评分智能体已超过 ${input.timeoutMs} ms，发出停止信号`,
    });
  }, input.timeoutMs + margin);

  let hardStop: ReturnType<typeof setTimeout> | undefined;
  const hardDeadline = new Promise<'hard-stop'>((resolve) => {
    hardStop = setTimeout(() => resolve('hard-stop'), hardMs);
  });

  // 污染对照（spec §7.4）：评分前后的改动摘要必须一致。不一致说明评审者动了工作区，而
  // 「查看改动」抽屉是按需现算的 ⇒ 它显示的不再是候选的产出。不自动回滚（没有干净基线可退），
  // 但绝不静默——那正是最容易让人误判分数的一个坑。
  const before = ctx.diffSummary ?? diffSummaryOf(ctx.workspacePath, ctx.baselineCommit);

  try {
    const outcome = await Promise.race([
      judgeRowByAgent({
        kind: input.kind,
        cwd: ctx.workspacePath,
        configHome: input.judgeHome,
        route: input.route,
        baselineCommit: ctx.baselineCommit,
        judgePrompt: ctx.testCase.judgePrompt,
        taskPrompt: ctx.testCase.taskPrompt,
        dimensions: DIMENSIONS,
        timeoutMs: input.timeoutMs,
        signal: ctx.controller.signal,
        judgeProviderId: input.judgeProviderId,
        onEvent: (event) => {
          publishRowEvent(ctx.runId, ctx.rowId, event);
        },
      }),
      hardDeadline,
    ]);
    if (outcome === 'hard-stop') {
      publishRowEvent(ctx.runId, ctx.rowId, {
        type: 'log',
        stream: 'stderr',
        text: `[编排] 评分智能体未在 ${hardMs} ms 内返回，按超时收尾（可能有残留子进程）`,
      });
      throw new JudgeAgentError('AGENT_TIMED_OUT', `评分智能体超过 ${input.timeoutMs} 毫秒未返回，已强制释放`);
    }
    return outcome;
  } finally {
    clearTimeout(backstop);
    if (hardStop !== undefined) clearTimeout(hardStop);
    try {
      const after = diffSummaryOf(ctx.workspacePath, ctx.baselineCommit);
      if (
        after.filesChanged !== before.filesChanged ||
        after.insertions !== before.insertions ||
        after.deletions !== before.deletions
      ) {
        publishRowEvent(ctx.runId, ctx.rowId, {
          type: 'log',
          stream: 'stderr',
          text:
            '[WARN] 评分智能体执行期间工作区被改动' +
            `（改动前 ${before.filesChanged} 个文件 +${before.insertions} −${before.deletions}，` +
            `改动后 ${after.filesChanged} 个文件 +${after.insertions} −${after.deletions}）：` +
            '「查看改动」抽屉显示的是当前状态，可能已不是候选 agent 的产出',
        });
      }
    } catch (error) {
      // 对照失败（工作区被删、git 不可用）不该顶替评分本身的结论，只记 WARN
      log.warn('评分后的改动对照失败（不影响本次结论）', {
        runId: ctx.runId,
        rowId: ctx.rowId,
        reason: toServiceError(error).message,
      });
    }
  }
}

/**
 * 评分阶段：解析尺子 → 按 `run.useAgentJudge` 选通路 → 出分。
 * **两条口径一个字都没变**：尺子仍是「用例覆盖 > 全局默认」（`resolveJudgeRoute`），
 * 「这一分是哪把尺子打的」仍取自**同一份配置快照**（R14：两次同步读之间没有 `await`，
 * 等于同一瞬间的快照）。变的只是谁去驱动那把尺子。
 *
 * 抛出的两类错误由调用方分别处置：`ServiceError`（配置缺失 / 解析失败）→ `settleFailed`；
 * `JudgeAgentError`（智能体自身的终止 / 失败）→ `settleAgentJudgeStop`。
 * **绝不把 `AGENT_*` 折成 `ServiceError`**：它们不是 contracts 的 `ErrorCode`。
 */
async function runJudgeStage(ctx: JudgeStageContext): Promise<ScoreResult> {
  setRowStatus(ctx.runId, ctx.rowId, 'judging');

  const config = loadConfig();
  const route = resolveJudgeRoute({
    judgeProviderId: ctx.testCase.judgeProviderId,
    judgeModelId: ctx.testCase.judgeModelId,
  });
  const judgeProviderId = ctx.testCase.judgeProviderId ?? config.settings.defaultJudge?.providerId ?? '';

  if (!ctx.run.useAgentJudge) {
    return judgeRow({
      judgePrompt: ctx.testCase.judgePrompt,
      diffText: ctx.diffText ?? clippedDiffText(ctx.workspacePath, ctx.baselineCommit, config.settings.diffBudgetBytes),
      taskPrompt: ctx.testCase.taskPrompt,
      dimensions: DIMENSIONS,
      route,
      judgeProviderId,
    });
  }

  const kind = requireJudgeAgent({ defaultJudgeAgent: config.settings.defaultJudgeAgent, route });
  return judgeByAgentBounded({
    ctx,
    kind,
    judgeHome: ensureRowJudgeHome(ctx.run.workspaceBase, ctx.runId, ctx.rowId),
    route,
    judgeProviderId,
    timeoutMs: config.settings.rowTimeoutMs,
  });
}

/**
 * 把评分智能体的终止 / 失败折成行终态。映射是**规定动作**，不是随手兜底：
 *   · `AGENT_CANCELED` → `canceled`（用户意图优先，与候选 agent 阶段同一口径）；
 *   · `AGENT_TIMED_OUT` → `timed-out`（`error.code` 保留 `AGENT_TIMED_OUT`，与候选超时同码，
 *     但文案里写明是**评分智能体**——两者的处置不同：一个调「单行超时」，一个该看评分提示词）；
 *   · 其余（`AGENT_FAILED` / `AGENT_LOAD_FAILED` / `AUTH_FAILED` / `RATE_LIMITED`）→ `failed`，
 *     `error.code` **原样保留 agents 的归因码**（`EvalRow.error.code` 是自由字符串，正是为它留的）。
 */
function settleAgentJudgeStop(runId: string, rowId: string, error: JudgeAgentError): void {
  if (error.agentCode === 'AGENT_CANCELED') {
    settleStopped(runId, rowId, { status: 'canceled', error: null, exitReason: 'canceled' });
    return;
  }
  if (error.agentCode === 'AGENT_TIMED_OUT') {
    settleStopped(runId, rowId, {
      status: 'timed-out',
      error: { code: 'AGENT_TIMED_OUT', message: error.message },
      exitReason: 'timed-out',
    });
    return;
  }
  settleStopped(runId, rowId, {
    status: 'failed',
    error: { code: error.agentCode, message: error.message },
    exitReason: 'error',
  });
}
```

`runRowAttempt` 的第 7 步整段（原第 525–553 行）替换为：

```ts
  // 第 7 步：评分（§5.7）。通路的选择、尺子的解析、配置快照的取法全部收在 runJudgeStage 里——
  // 完整跑一行与「重新评分」共用它，两处各写一遍必然漂移。
  const { row: beforeJudging } = requireRow(runId, rowId);
  if (TERMINAL_ROW_STATUSES.includes(beforeJudging.status)) {
    log.debug('行已被同步终止，跳过评分', { runId, rowId, status: beforeJudging.status });
    return;
  }

  let score: ScoreResult;
  try {
    score = await runJudgeStage({
      runId,
      rowId,
      run,
      testCase,
      workspacePath: prepared.workspacePath,
      baselineCommit: prepared.baselineCommit,
      diffText: clipped.text,
      diffSummary: {
        filesChanged: collected.filesChanged,
        insertions: collected.insertions,
        deletions: collected.deletions,
        truncated: clipped.truncated,
      },
      controller,
    });
  } catch (error) {
    if (error instanceof JudgeAgentError) {
      // 智能体自身的终止 / 失败：AGENT_* 不是契约的 ErrorCode，走这条专用映射
      settleAgentJudgeStop(runId, rowId, error);
      return;
    }
    // 配置缺失（未配评分模型 / 未配评分智能体 / 协议不兼容）与解析失败：交给 runRow 的兜底落 failed
    throw error;
  }
```

> 原来写在 `runRowAttempt` 里的 `setRowStatus(runId, rowId, 'judging')` 与那两段 R14 注释**整段删掉**——它们已经搬进 `runJudgeStage`，留在原地会变成第二处状态写入点（`static-assertions.test.ts` 会盯这个）。

- [ ] **Step 8: 跑测试确认通过**

Run: `pnpm --filter @aieval/evaluator test -- orchestrator.test`
Expected: 全 PASS，**包括既有的 R14 接缝用例与「开关关闭」的既有评分用例**（它们一个字都不该改）

- [ ] **Step 9: 变异验证**

1. 把 `clearRowArtifacts` 里新增的 `.judgehome` 那条 `rmSync` 删掉 → 「重跑会清掉 .judgehome」**必须变红**。
2. 把 `judgeByAgentBounded` 的 `hardDeadline` 从 race 里移除 → 「永不返回 → timed-out」**必须变红**（该行会停在 `judging`）。
3. 把污染对照那段 `if` 整体删掉 → 「评分智能体改了工作区」**必须变红**。
4. 三处还原，`git diff --stat` 核对。

- [ ] **Step 10: 全链验证并提交**

```bash
pnpm typecheck
pnpm lint
pnpm test
git add packages/server/core/src/workspace.ts packages/server/core/src/workspace.test.ts packages/server/core/src/index.ts packages/server/evaluator/src/orchestrator.ts packages/server/evaluator/src/orchestrator.test.ts
git commit -m "feat(evaluator): 编排层接入智能体评分——judgehome / 外层兜底 / 工作区污染对照"
```

---

### Task 5: 设置页「默认评分智能体」

**Files:**
- Modify: `packages/client/ui/src/composite/judge-settings-card.tsx`
- Test: `packages/client/ui/src/composite/judge-settings-card.test.tsx`
- Modify: `apps/web-next/app/settings/page.tsx`

**Interfaces:**
- Consumes: Task 1 的 `Settings.defaultJudgeAgent`、`AGENT_KINDS` / `AGENT_LABELS`；现有 `useRunModelOptions()`（`@aieval/client`）的 `options: AgentOptionGroup[]`
- Produces: `JudgeSettingsCardProps.agentProtocols?: { agentKind: AgentKind; protocolType: ProtocolType }[]`

- [ ] **Step 1: 写失败的测试**

追加到 `packages/client/ui/src/composite/judge-settings-card.test.tsx`：

```tsx
describe('JudgeSettingsCard 的默认评分智能体', () => {
  const protocols = [
    { agentKind: 'claude-code' as const, protocolType: 'anthropic' as const },
    { agentKind: 'codex' as const, protocolType: 'openai' as const },
    { agentKind: 'dsh' as const, protocolType: 'anthropic' as const },
  ];

  it('未配置默认评分模型时三个智能体都能选（还没得判协议，不拦）', async () => {
    const onChange = vi.fn();
    render(
      <JudgeSettingsCard
        settings={settings()}
        providers={[openai, anthropic]}
        agentProtocols={protocols}
        onChange={onChange}
        saving={false}
      />,
    );

    fireEvent.mouseDown(screen.getByLabelText('默认评分智能体'));
    fireEvent.click(await screen.findByText('DeepSeek Harness'));

    expect(onChange).toHaveBeenCalledWith({ defaultJudgeAgent: 'dsh' });
  });

  it('默认评分模型是 anthropic 协议时，Codex 选项被禁用（它只吃 openai）', async () => {
    render(
      <JudgeSettingsCard
        settings={settings({ defaultJudge: { providerId: 'p-2', modelId: 'claude-sonnet-5' } })}
        providers={[anthropic]}
        agentProtocols={protocols}
        onChange={noop}
        saving={false}
      />,
    );

    fireEvent.mouseDown(screen.getByLabelText('默认评分智能体'));
    const codex = await screen.findByText('Codex（与当前默认评分模型协议不匹配）');
    // antd 把 disabled 的选项渲染成 aria-disabled 的 .ant-select-item-option-disabled
    expect(codex.closest('.ant-select-item-option')).toHaveClass('ant-select-item-option-disabled');
  });

  it('已存的值变成不兼容时给红色告警（与「悬空」同一套模式）', () => {
    render(
      <JudgeSettingsCard
        settings={settings({
          defaultJudge: { providerId: 'p-2', modelId: 'claude-sonnet-5' },
          defaultJudgeAgent: 'codex',
        })}
        providers={[anthropic]}
        agentProtocols={protocols}
        onChange={noop}
        saving={false}
      />,
    );

    expect(screen.getByText('当前的默认评分智能体与评分模型协议不匹配')).toBeInTheDocument();
  });

  it('清空回写 null（契约里 null 才是「未配置」，不是空串）', async () => {
    const onChange = vi.fn();
    render(
      <JudgeSettingsCard
        settings={settings({ defaultJudgeAgent: 'dsh' })}
        providers={[]}
        agentProtocols={protocols}
        onChange={onChange}
        saving={false}
      />,
    );

    // antd 的 allowClear 图标没有可访问名，按 class 取（本仓既有用例也是这么点它的）
    const clear = document.querySelector('.ant-select-clear');
    expect(clear).not.toBeNull();
    fireEvent.mouseDown(clear as Element);

    expect(onChange).toHaveBeenCalledWith({ defaultJudgeAgent: null });
  });
});
```

**同时必须改既有用例**：卡片里现在有**两个** `combobox`，原先那句 `screen.getByRole('combobox')` 会因「匹配到多个」而抛错。把既有那两处改成 `screen.getByLabelText('默认评分模型')`。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @aieval/ui test -- judge-settings-card`
Expected: FAIL —— 既有用例先因 `getByRole('combobox')` 匹配到多个而红（这正是要暴露的破坏面），新用例因 `agentProtocols` 未声明而报 TS 错

- [ ] **Step 3: 实现**

`packages/client/ui/src/composite/judge-settings-card.tsx`：

import 补：

```ts
import {
  AGENT_KINDS,
  AGENT_LABELS,
  DIMENSIONS,
  DIMENSION_COUNT,
  PROTOCOL_LABELS,
  type AgentKind,
  type ProviderView,
  type ProtocolType,
  type Settings,
  type SettingsPatch,
} from '@aieval/contracts';
```

props 加一格：

```ts
export interface JudgeSettingsCardProps {
  settings: Settings;
  providers: ProviderView[];
  /**
   * 每家的协议元数据（来自 `GET /api/runs/model-options` 的注册表投影）。
   * 不传时**不拦**（列出全部）——注册表才是协议表的唯一真源，界面拿不到数据时不该自己编一份；
   * 服务端在创建与评分两处各有一道校验。
   */
  agentProtocols?: { agentKind: AgentKind; protocolType: ProtocolType }[];
  onChange: (patch: SettingsPatch) => void;
  saving: boolean;
}
```

组件体内、`pick` 之前加：

```ts
  // 默认评分智能体与默认评分模型的协议必须匹配（Codex 只吃 OpenAI 兼容，Claude Code / DSH 只吃
  // Anthropic 兼容）：智能体驱动不了另一种协议的模型。协议取自注册表投影，本组件不写那张表。
  const judgeProtocol =
    current === null
      ? undefined
      : providers.find((provider) => provider.id === current.providerId)?.protocolType;
  const protocolOf = (kind: AgentKind): ProtocolType | undefined =>
    agentProtocols?.find((item) => item.agentKind === kind)?.protocolType;
  const incompatible = (kind: AgentKind): boolean =>
    judgeProtocol !== undefined && protocolOf(kind) !== undefined && protocolOf(kind) !== judgeProtocol;
  const currentAgentDangling = settings.defaultJudgeAgent !== null && incompatible(settings.defaultJudgeAgent);
```

在「默认评分模型」的 `Form.Item` **之后**插一个同形的 `Form.Item`：

```tsx
          <Form.Item label="默认评分智能体" style={{ marginBottom: 8 }}>
            <Select
              aria-label="默认评分智能体"
              placeholder="未配置"
              disabled={saving}
              allowClear
              value={settings.defaultJudgeAgent ?? undefined}
              options={AGENT_KINDS.map((kind) => ({
                value: kind,
                label: incompatible(kind) ? `${AGENT_LABELS[kind]}（与当前默认评分模型协议不匹配）` : AGENT_LABELS[kind],
                // 不兼容的直接禁用而不是选完再报错：这一格没有「先选了再说」的中间态可用
                disabled: incompatible(kind),
              }))}
              // 清空 = 回到「未配置」（契约里 defaultJudgeAgent 的 null 就是未配置）
              onChange={(value: AgentKind | undefined) => {
                onChange({ defaultJudgeAgent: value ?? null });
              }}
            />
          </Form.Item>
```

在「悬空」那条 `Alert` 之后加一条：

```tsx
        {currentAgentDangling && (
          <Alert
            type="error"
            showIcon
            title="当前的默认评分智能体与评分模型协议不匹配"
            description={`${AGENT_LABELS[settings.defaultJudgeAgent as AgentKind]} 只能驱动${
              PROTOCOL_LABELS[protocolOf(settings.defaultJudgeAgent as AgentKind) ?? 'openai']
            }协议的模型，而当前的默认评分模型属于${PROTOCOL_LABELS[judgeProtocol ?? 'openai']}协议。请重新选择其中一个。`}
          />
        )}
```

（用 `as AgentKind` 前先确认 TS 收窄：`settings.defaultJudgeAgent !== null` 已在 `currentAgentDangling` 里判过，但布尔变量不带窄化，故这里保留断言并在注释里写明原因。）

文件头第 1 条口径（「两种协议的模型都列，不做协议过滤」）**保持不变**——被过滤的是智能体，不是模型；在那条注释后面补一句说清两者的区别。

`apps/web-next/app/settings/page.tsx`：

- 取数处加 `const { options: agentOptions } = useRunModelOptions();`（`@aieval/client`）；
- 评分卡的接线处加一个 prop：

```tsx
<JudgeSettingsCard
  settings={settings}
  providers={providers}
  agentProtocols={(agentOptions ?? []).map((group) => ({
    agentKind: group.agentKind,
    protocolType: group.protocolType,
  }))}
  saving={isUpdating}
  onChange={changeSettings}
/>
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @aieval/ui test -- judge-settings-card`
Expected: 全 PASS

- [ ] **Step 5: 变异验证**

1. 把 `disabled: incompatible(kind)` 改成 `disabled: false` → 「Codex 选项被禁用」**必须变红**。
2. 把 `onChange({ defaultJudgeAgent: value ?? null })` 改成 `onChange({ defaultJudgeAgent: value })`（值可能是 `undefined`）→ 清空那条**必须变红**。
3. 还原。

- [ ] **Step 6: 全链验证并提交**

```bash
pnpm typecheck
pnpm lint
pnpm --filter @aieval/ui test
git add packages/client/ui/src/composite/judge-settings-card.tsx packages/client/ui/src/composite/judge-settings-card.test.tsx apps/web-next/app/settings/page.tsx
git commit -m "feat(ui): 评分配置增加默认评分智能体（按注册表协议过滤）"
```

---

### Task 6: 创建评测「使用智能体评分」+ 创建时服务端校验

**Files:**
- Modify: `packages/client/ui/src/composite/run-create-panel.tsx`
- Test: `packages/client/ui/src/composite/run-create-panel.test.tsx`
- Modify: `packages/server/api/src/runs.ts`
- Test: `packages/server/api/src/runs.test.ts`
- Test: `apps/web-next/src/route-runs.test.ts`（**防 zod strip 静默丢字段**，Review Focus 第 2 条）
- Modify: `apps/web-next/app/runs/page.tsx`

**Interfaces:**
- Consumes: Task 1 的 `RunCreate.useAgentJudge`；Task 3 的 `resolveJudgeRoute` / `requireJudgeAgent`
- Produces: `RunCreatePanelProps.judgeAgentConfigured?: boolean`

- [ ] **Step 1: 写失败的测试——表单**

追加到 `packages/client/ui/src/composite/run-create-panel.test.tsx`：

```tsx
  it('「使用智能体评分」默认关闭，提交时进 payload', async () => {
    const onSubmit = vi.fn();
    render(
      <RunCreatePanel
        cases={[testCase]}
        modelOptionsFor={() => [modelOption]}
        saving={false}
        onSubmit={onSubmit}
        onCancel={noop}
      />,
    );

    // 默认关闭（用户口径）
    expect(screen.getByRole('switch', { name: '使用智能体评分' })).not.toBeChecked();

    fireEvent.mouseDown(screen.getByLabelText('用例'));
    fireEvent.click(await screen.findByText(/测试用例/));
    fireEvent.mouseDown(screen.getByLabelText('智能体'));
    fireEvent.click(await screen.findByText('Codex'));
    fireEvent.mouseDown(screen.getByLabelText('模型'));
    fireEvent.click(await screen.findByText(/test-model/));
    fireEvent.click(screen.getByRole('switch', { name: '使用智能体评分' }));
    fireEvent.click(screen.getByRole('button', { name: '确定' }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalled();
    });
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({ useAgentJudge: true });
  });

  it('开关打开但设置页没配默认评分智能体 → 内联 Alert 指出路（不要等跑完才炸）', () => {
    render(
      <RunCreatePanel
        cases={[testCase]}
        modelOptionsFor={() => [modelOption]}
        judgeAgentConfigured={false}
        saving={false}
        onSubmit={noop}
        onCancel={noop}
      />,
    );

    fireEvent.click(screen.getByRole('switch', { name: '使用智能体评分' }));
    expect(screen.getByText(/没有配置默认评分智能体/)).toBeInTheDocument();
  });
```

- [ ] **Step 2: 写失败的测试——服务端创建时校验**

追加到 `packages/server/api/src/runs.test.ts`：

```ts
  it('开关打开但未配默认评分智能体 → CONFLICT（不要等人跑完才在评分阶段炸）', () => {
    seedConfig({ workspaceRoot: home.workspaceRoot, providers: [provider], cases: [testCase] });
    expect(() =>
      createRun({
        caseId: testCase.id,
        executionMode: 'parallel',
        useAgentJudge: true,
        rows: [{ agentKind: 'codex', providerId: provider.id, modelId: 'test-model' }],
      }),
    ).toThrowError(/没有配置默认评分智能体/);
  });

  it('评分智能体与用例覆盖的评分模型协议不匹配 → CONFLICT，点名两家', () => {
    const anthropicProvider = makeProviderFixture({ protocolType: 'anthropic', models: [{ id: 'claude-sonnet-5', source: 'manual' }] });
    const overrideCase = makeCaseFixture({
      judgeProviderId: anthropicProvider.id,
      judgeModelId: 'claude-sonnet-5',
    });
    seedConfig({
      workspaceRoot: home.workspaceRoot,
      providers: [provider, anthropicProvider],
      cases: [overrideCase],
      defaultJudgeAgent: 'codex',
    });
    expect(() =>
      createRun({
        caseId: overrideCase.id,
        executionMode: 'parallel',
        useAgentJudge: true,
        rows: [{ agentKind: 'codex', providerId: provider.id, modelId: 'test-model' }],
      }),
    ).toThrowError(/Codex 只接受OpenAI 兼容协议的模型/);
  });
```

- [ ] **Step 3: 写失败的测试——路由不丢字段（Review Focus 第 2 条）**

追加到 `apps/web-next/src/route-runs.test.ts`：

```ts
  it('POST /api/runs 把 useAgentJudge 真的交给了服务端（zod 默认 strip 未知键，漏声明就是静默丢弃）', async () => {
    const { POST } = await import('../app/api/runs/route');
    const response = await POST(
      new Request('http://localhost/api/runs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          caseId: CASE.id,
          executionMode: 'parallel',
          useAgentJudge: true,
          rows: [{ agentKind: 'codex', providerId: PROVIDER.id, modelId: 'deepseek-chat' }],
        }),
      }),
    );

    expect(response.status).toBe(201);
    const created = (await response.json()) as EvalRun;
    // 这一条钉的**不是**「服务端能用它」，而是「它没在解析那一层被丢掉」——
    // 丢掉的表现是 POST 仍然 201、界面照样显示在用智能体评分，两边都不报错
    expect(created.useAgentJudge).toBe(true);
  });
```

（按该文件既有的 seed 写法补 `CASE` / `PROVIDER` / 配置落盘；**不要**改它与 agent 选项键集合有关的那条断言。）

- [ ] **Step 4: 跑测试确认失败**

Run: `pnpm --filter @aieval/ui test -- run-create-panel` 与 `pnpm --filter @aieval/api test -- runs.test` 与 `pnpm --filter web-next test -- route-runs`
Expected: 三条都 FAIL

- [ ] **Step 5: 实现——表单**

`packages/client/ui/src/composite/run-create-panel.tsx`：

- import 补 `Switch`（antd）与 `useEffect`（react）；
- `FormValues` 加 `useAgentJudge?: boolean;`
- props 加：

```ts
  /**
   * 设置页是否配了默认评分智能体。`false` 且开关打开时给内联 Alert ——
   * 否则要等候选 agent 跑完几分钟之后才在评分步骤炸（与「模型池为空」同一条口径：
   * 不要让人选完到运行时才失败）。不传（`undefined`）时不提示：未知不等于没配。
   */
  judgeAgentConfigured?: boolean;
```

- `initialValues` 改成 `{ executionMode: 'parallel', useAgentJudge: false }`
- `handleFinish` 的 `onSubmit` 补字段：

```ts
    onSubmit({
      caseId: values.caseId,
      executionMode: values.executionMode ?? 'parallel',
      useAgentJudge: values.useAgentJudge ?? false,
      rows,
    });
```

- 在「执行模式」的 `Form.Item` 之后插：

```tsx
      <Form.Item
        name="useAgentJudge"
        label="使用智能体评分"
        valuePropName="checked"
        // 说明写在 extra 里而不是另起一段文字：它解释的是这一格，跟着它走才不会在版式变化时脱节
        extra="改动很大、diff 塞不进一次请求的上下文时用它：由设置页配置的评分智能体在候选工作区里自行查看代码后打分。默认关闭。"
        style={{ marginBottom: 8 }}
      >
        <Switch />
      </Form.Item>

      {/* 开关打开 + 设置页没配默认评分智能体 = 必然在评分阶段失败。当场说出来，不要等人跑完 */}
      <Form.Item noStyle shouldUpdate={(prev: FormValues, next: FormValues) => prev.useAgentJudge !== next.useAgentJudge}>
        {({ getFieldValue }) =>
          getFieldValue('useAgentJudge') === true && judgeAgentConfigured === false ? (
            <Alert
              type="warning"
              showIcon
              title="设置页还没有配置默认评分智能体"
              description="这一轮会先去跑候选，到评分那一步才失败。请先到「设置 → 评分配置」选一个默认评分智能体。"
              style={{ marginBottom: 8 }}
            />
          ) : null
        }
      </Form.Item>
```

> `Switch` 需要可访问名「使用智能体评分」：`Form.Item` 的 `label` 会关联到控件，antd 的 `Switch` 会带上 `aria-label`。若 RTL 的 `getByRole('switch', { name })` 取不到，改用 `getByLabelText('使用智能体评分')`——两种写法都在本仓有先例。

- [ ] **Step 6: 实现——服务端创建时校验**

`packages/server/api/src/runs.ts` 的 `createRun`：在 `const settings = getSettings();` 之后、`rows` 映射之前插：

```ts
  if (input.useAgentJudge) {
    // 「不要让人选完到运行时才失败」：智能体评分需要设置页那一格，而**用例级覆盖**可能把评分模型
    // 换到另一种协议（表单一句话说不清这件事，所以判定只能在服务端做）。评分阶段还会再校验一次
    // （配置可能被改过），两处都留——与 F2 的协议过滤「创建时拦一次、编排层再拦一次」同一模式。
    const route = resolveJudgeRoute({
      judgeProviderId: testCase.judgeProviderId,
      judgeModelId: testCase.judgeModelId,
    });
    requireJudgeAgent({ defaultJudgeAgent: settings.defaultJudgeAgent, route });
  }
```

import 补：`import { requireJudgeAgent, resolveJudgeRoute } from '@aieval/evaluator';`（`api → evaluator` 是允许的方向 ✓）。

- [ ] **Step 7: 实现——runs 页接线**

`apps/web-next/app/runs/page.tsx`：

```tsx
  const { settings } = useSettings();
  …
        <RunCreatePanel
          cases={cases ?? []}
          modelOptionsFor={optionsFor}
          judgeAgentConfigured={settings === undefined ? undefined : settings.defaultJudgeAgent !== null}
          saving={isCreating}
          onSubmit={(input) => void handleCreate(input)}
          onCancel={closePanel}
        />
```

- [ ] **Step 8: 跑测试确认通过**

Run: `pnpm --filter @aieval/ui test -- run-create-panel`；`pnpm --filter @aieval/api test -- runs.test`；`pnpm --filter web-next test -- route-runs`
Expected: 全 PASS

- [ ] **Step 9: 变异验证**

1. 把 `RunCreateSchema` 里的 `useAgentJudge` 那一行删掉 → 路由那条用例**必须变红**（POST 仍 201，但 `created.useAgentJudge` 是 `false`）。**这一条是本任务最重要的变异**：它证明那条守卫真的能抓到「静默 strip」。
2. 把 `createRun` 里的 `if (input.useAgentJudge) { … }` 整段删掉 → 服务端两条用例**必须变红**。
3. 还原。

- [ ] **Step 10: 全链验证并提交**

```bash
pnpm typecheck
pnpm lint
pnpm test
git add packages/client/ui/src/composite/run-create-panel.tsx packages/client/ui/src/composite/run-create-panel.test.tsx packages/server/api/src/runs.ts packages/server/api/src/runs.test.ts apps/web-next/src/route-runs.test.ts apps/web-next/app/runs/page.tsx
git commit -m "feat: 创建评测支持使用智能体评分（Switch 默认关闭 + 创建时校验）"
```

---

### Task 7: 行级「重新评分」

**Files:**
- Modify: `packages/server/evaluator/src/orchestrator.ts`（`rescoreRow` + `rescoreAttempt` + `rescoreRefusal`）
- Modify: `packages/server/evaluator/src/index.ts` + `packages/server/evaluator/src/index.test.ts`（**出口是精确集合断言，必须显式改**）
- Modify: `packages/server/api/src/runs.ts` + `packages/server/api/src/index.ts`
- Create: `apps/web-next/app/api/runs/[runId]/rows/[rowId]/rescore/route.ts`
- Modify: `packages/client/client/src/runs.ts`（`useRescoreRow`）
- Modify: `packages/client/ui/src/composite/eval-row-card.tsx` + `run-detail-panel.tsx`
- Modify: `apps/web-next/app/runs/page.tsx`
- Test: `packages/server/evaluator/src/orchestrator.test.ts`、`packages/server/api/src/runs.test.ts`、`apps/web-next/src/route-runs.test.ts`、`packages/client/ui/src/composite/eval-row-card.test.tsx`

**Interfaces:**
- Consumes: Task 1 的 `canRescoreRow`；Task 4 的 `runJudgeStage` / `settleAgentJudgeStop`；Task 3 的 `JudgeAgentError`
- Produces: `rescoreRow(runId: string, rowId: string): EvalRun`（evaluator 与 api 包根都转出）；`POST /api/runs/{runId}/rows/{rowId}/rescore`；`useRescoreRow(): { rescoreRow: (runId, rowId) => Promise<EvalRun>; isRescoring: boolean }`；`EvalRowCardProps.onRescore` / `rescorePending`；`RunDetailPanelProps.onRescoreRow` / `rescoring`

- [ ] **Step 1: 写失败的测试——`rescoreRow` 的三条拒绝 + 一条正例**

追加到 `packages/server/evaluator/src/orchestrator.test.ts`：

```ts
describe('rescoreRow：只重跑评分，不重跑候选', () => {
  it('把「未跑过」的行挡下来，并说清该先做什么', async () => {
    const { run } = seedRunnableRun({ rowCount: 1 }); // 行是 pending、diff 为 null、baselineCommit 为 ''
    expect(() => rescoreRow(run.id, run.rows[0]?.id ?? '')).toThrowError(/还没有跑过/);
  });

  it('把「正在运行中」的行挡下来，并指向终止', async () => {
    const { run } = seedRunnableRun({ rowCount: 1 });
    const rowId = run.rows[0]?.id ?? '';
    fakeAgents.scripts.set('codex', { mode: 'gate' });
    const running = runRow(run.id, rowId);
    await until(() => getRun(run.id).rows[0]?.status === 'running', '行进入 running');
    expect(() => rescoreRow(run.id, rowId)).toThrowError(/正在运行中/);
    releaseAllAgents();
    await running;
  });

  it('正例：分数被替换、状态回到 judged、候选 agent 没有再跑一次、日志追加而不是清空', async () => {
    const { run } = seedRunnableRun({ rowCount: 1, withJudge: true });
    const rowId = run.rows[0]?.id ?? '';
    await runRow(run.id, rowId);
    const agentCallsAfterRun = fakeAgents.calls.length;
    const eventsAfterRun = readEvents(rowEventsFile(run.workspaceBase, run.id, rowId)).length;

    fakeJudge.score = 5; // 换一把尺子的读数
    rescoreRow(run.id, rowId);
    await until(() => getRun(run.id).rows[0]?.score?.totalScore === 100, '重新评分落盘');

    const row = getRun(run.id).rows[0];
    expect(row?.status).toBe('judged');
    expect(row?.score?.totalScore).toBe(100);
    // 候选 agent 一次都没再跑（这是本功能的全部意义：分钟级的成本不该被一次重评带上）
    expect(fakeAgents.calls).toHaveLength(agentCallsAfterRun);
    // 事件日志**追加**：两条 score 事件都在，且有一条 [重新评分] 标记
    const events = readEvents(rowEventsFile(run.workspaceBase, run.id, rowId));
    expect(events.length).toBeGreaterThan(eventsAfterRun);
    expect(events.filter((event) => event.type === 'score')).toHaveLength(2);
    expect(events.some((event) => event.type === 'log' && event.text.includes('[重新评分]'))).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: 'end', exitReason: 'rescored' });
  });

  it('用例被删之后不能重评（题面与评分提示词没有快照进 run.json）', async () => {
    const { run } = seedRunnableRun({ rowCount: 1, withJudge: true });
    const rowId = run.rows[0]?.id ?? '';
    await runRow(run.id, rowId);
    seedConfig({ workspaceRoot: home.workspaceRoot }); // 用例没了
    expect(() => rescoreRow(run.id, rowId)).toThrowError(/用例已删除/);
  });

  it('重评失败会落 failed 并给出原因（重试出口必须自己也不静默）', async () => {
    const { run } = seedRunnableRun({ rowCount: 1, withJudge: true });
    const rowId = run.rows[0]?.id ?? '';
    await runRow(run.id, rowId);
    fakeJudge.mode = 'fail';
    rescoreRow(run.id, rowId);
    await until(() => getRun(run.id).rows[0]?.status === 'failed', '重评失败落 failed');
    expect(getRun(run.id).rows[0]?.error?.code).toBe('JUDGE_PARSE_FAILED');
  });

  it('补完最后一个失败行后 partial 翻回 done', async () => {
    const { run } = seedRunnableRun({ rowCount: 1, withJudge: true });
    const rowId = run.rows[0]?.id ?? '';
    fakeJudge.mode = 'fail';
    await runRow(run.id, rowId);
    setRunStatusForTesting(run.id, { status: 'partial' }); // 或按本文件既有写法直接 saveRun

    fakeJudge.mode = 'ok';
    rescoreRow(run.id, rowId);
    await until(() => getRun(run.id).status === 'done', '轮状态翻回 done');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @aieval/evaluator test -- orchestrator.test`
Expected: FAIL —— `rescoreRow is not a function`

- [ ] **Step 3: 实现 `rescoreRow`**

`packages/server/evaluator/src/orchestrator.ts`，在轮级状态机之前（`runRowAttempt` 之后）加：

```ts
/** 在途的重新评分任务（键是 `runId:rowId`）：`drainRunningTasks` 也要等它们 */
const rescoreTasks = new Map<string, Promise<void>>();

/**
 * 不可重评的**具体**原因（分三种点名，不要笼统地说「不能重评」——使用者要知道下一步做什么）。
 * 判据本身与界面共用 `canRescoreRow`（contracts），这里只负责把「为什么不行」翻译成人话。
 */
function rescoreRefusal(row: EvalRow): string | null {
  if (isRunningRow(row.status)) {
    return `该行正在运行中（${ROW_STATUS_LABELS[row.status]}）：请先终止它，再重新评分`;
  }
  if (row.status === 'pending' || row.status === 'skipped') {
    return '该行还没有跑过：请先点「开始」跑一次，再重新评分';
  }
  if (row.baselineCommit === '') {
    return '该行的工作区未就绪（准备阶段没有成功过）：请先点「开始」重跑该行';
  }
  if (row.diff === null) {
    return '该行没有可复评的改动（候选 agent 阶段没有跑完）：请先点「开始」重跑该行';
  }
  return null;
}

/**
 * 重新评分：在**该行现有工作区**上重跑评分步骤，不重跑候选 agent、不重建工作区、不改分支、不动 diff 摘要。
 *
 * 三条口径：
 *   1. **模式沿用 `run.useAgentJudge`**（spec D11）：一轮里只有一把尺子，行间分数才可比。
 *      评分模型走 `resolveJudgeRoute` 的**当前配置**（用例覆盖 > 全局默认），于是「到设置页换个评分模型
 *      再点重新评分」天然生效，不需要新的选择器；
 *   2. **先清空该行的分数与失败归因再重算**（与 `runRowAttempt` 的 `preparing` 重置同口径）：
 *      界面停在「评分中」却还挂着上一次的分数，会让人以为已经出分了。代价见 spec §14 第 6 条
 *      （重评失败会丢掉上一次的分数，历史仍在事件日志的 `score` 事件里）；
 *   3. **同步落状态、异步跑任务**（与 `startRun` 同一形状）：HTTP 立刻拿到「已经在评分中」的快照，
 *      界面靠 SSE 与轮询追进度。
 */
export function rescoreRow(runId: string, rowId: string): EvalRun {
  const { run, row } = requireRow(runId, rowId);
  const refusal = rescoreRefusal(row);
  if (refusal !== null) throw new ServiceError('CONFLICT', refusal);

  const config = loadConfig();
  const testCase = config.cases.find((item) => item.id === run.caseId);
  if (testCase === undefined) {
    // 题面与评分提示词没有快照进 run.json（§7.2 只冗余了 caseTitle / repoPath / commitHash）
    throw new ServiceError('CONFLICT', `用例已删除（${run.caseId}），无法重新评分；历史记录仍可查看`);
  }

  const key = rowKey(runId, rowId);
  const controller = new AbortController();
  // 与 runRowAttempt 同一把钥匙：于是「终止」按钮（abortRow）在重评期间天然有效，不需要新入口
  rowAborts.set(key, controller);

  const mode = run.useAgentJudge ? '评分智能体' : '评分模型';
  publishRowEvent(runId, rowId, {
    type: 'log',
    stream: 'stdout',
    text: `[重新评分] 用户请求重新评分（模式：${mode}），本次不重跑候选智能体`,
  });
  setRowStatus(runId, rowId, 'judging', { error: null, score: null });
  log.info('重新评分', { runId, rowId, mode });

  const task = rescoreAttempt({ runId, rowId, run, testCase, row, controller })
    .catch((error: unknown) => {
      // 行级已兜底，走到这里说明是编排自身的 bug：记下来，但不能把行留在非终态
      log.error('重新评分任务异常退出（行级已兜底，不应发生）', {
        runId,
        rowId,
        reason: toServiceError(error).message,
      });
    })
    .finally(() => {
      clearRowRuntime(runId, rowId);
      // 补一次轮收尾：补完最后一个失败行之后 partial 该翻回 done（`finalizeRun` 自己有「还有行在跑就
      // 什么都不做」的守卫，正在跑别的行时调它是安全的）
      try {
        finalizeRun(runId);
      } catch (error) {
        log.error('重新评分后的轮收尾失败（该轮可能停在 partial）', {
          runId,
          reason: toServiceError(error).message,
        });
      } finally {
        rescoreTasks.delete(key);
      }
    });
  rescoreTasks.set(key, task);

  // 重新读一次快照再返回：POST /rescore 拿到的必须是「已经在评分中」的状态
  return getRunForWrite(runId);
}

/** 重评的执行体：跑评分 → 终态复检 → 落盘（失败面与完整跑一行**逐条同形**） */
async function rescoreAttempt(input: {
  runId: string;
  rowId: string;
  run: EvalRun;
  testCase: TestCase;
  row: EvalRow;
  controller: AbortController;
}): Promise<void> {
  try {
    const score = await runJudgeStage({
      runId: input.runId,
      rowId: input.rowId,
      run: input.run,
      testCase: input.testCase,
      workspacePath: input.row.workspacePath,
      baselineCommit: input.row.baselineCommit,
      // 第 6 步那一份没有落在快照里（快照只存计数摘要）：这里传 null，由评分阶段自己现算
      diffText: null,
      diffSummary: null,
      controller: input.controller,
    });

    const { row: afterJudging } = requireRow(input.runId, input.rowId);
    if (TERMINAL_ROW_STATUSES.includes(afterJudging.status)) {
      // 用户终止之后评分才返回：状态保持 canceled（用户意图优先），分数只记进日志
      publishRowEvent(input.runId, input.rowId, { type: 'score', score });
      log.warn('行已被终止，重新评分的结果只记入事件日志', { runId: input.runId, rowId: input.rowId });
      return;
    }

    patchRow(input.runId, input.rowId, { score });
    publishRowEvent(input.runId, input.rowId, { type: 'score', score });
    setRowStatus(input.runId, input.rowId, 'judged');
    // `exitReason` 用 'rescored' 而不是 'completed'：日志里两次 `end` 必须能区分是哪一次
    publishRowEvent(input.runId, input.rowId, { type: 'end', exitReason: 'rescored' });
  } catch (error) {
    if (error instanceof JudgeAgentError) {
      settleAgentJudgeStop(input.runId, input.rowId, error);
      return;
    }
    settleFailed(input.runId, input.rowId, toServiceError(error), null);
  }
}
```

`drainRunningTasks` 改成同时等两处：

```ts
export async function drainRunningTasks(): Promise<void> {
  while (runTasks.size > 0 || rescoreTasks.size > 0) {
    await Promise.allSettled([...runTasks.values(), ...rescoreTasks.values()]);
  }
}
```

- [ ] **Step 4: 补 evaluator 的出口与它的精确集合守卫**

`packages/server/evaluator/src/index.ts` 的编排那一行加 `rescoreRow`（**按字母序**）：

```ts
export { abortRow, abortRun, drainRunningTasks, recoverInterruptedRuns, rescoreRow, startRun } from './orchestrator';
```

`packages/server/evaluator/src/index.test.ts` 的期望数组里加 `'rescoreRow'`（在 `'recoverInterruptedRuns'` 与 `'startRun'` 之间，保持 `.sort()` 前的一致顺序）。该文件明写「断言的是**完整集合**，新增出口也要显式改这里」——**这一步不能省**。

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm --filter @aieval/evaluator test`
Expected: 全 PASS

- [ ] **Step 6: 写失败的测试——api 与路由**

`packages/server/api/src/runs.test.ts` 加：

```ts
  it('rescoreRow 转出：不可重评的行抛 CONFLICT，可重评的行落 judging 并返回快照', async () => {
    // 造一个跑完的行（用 evaluator 的夹具直接落一份快照即可：api 层不负责执行）
    expect(() => rescoreRow(run.id, pendingRowId)).toThrowError(/还没有跑过/);
  });
```

`apps/web-next/src/route-runs.test.ts` 加（按该文件既有的 seed + `vi.mock('@aieval/evaluator')` 写法）：

```ts
  it('POST /api/runs/{runId}/rows/{rowId}/rescore 转发到服务层并回快照', async () => {
    const { POST } = await import('../app/api/runs/[runId]/rows/[rowId]/rescore/route');
    const response = await POST(new Request('http://localhost/', { method: 'POST' }), {
      params: Promise.resolve({ runId: 'run-1', rowId: 'row-1' }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: 'run-1' });
  });
```

- [ ] **Step 7: 实现 api 层与路由**

`packages/server/api/src/runs.ts` 末尾加：

```ts
/**
 * 重新评分：只重跑评分步骤（spec §9）。
 * 判据（`canRescoreRow`）与拒绝原因是编排层的活——api 层只做存在性检查与转出，
 * 与 `abortRow` 同一条分工（界面不该给它按钮，真调到了要明确报出来，而不是静默成功）。
 */
export function rescoreRow(runId: string, rowId: string): EvalRun {
  const before = getRunSnapshot(runId);
  if (!before.rows.some((row) => row.id === rowId)) {
    throw new ServiceError('NOT_FOUND', `该评测里没有这一行（${rowId}）`);
  }

  const run = rescoreRowInOrchestrator(runId, rowId);
  log.info('重新评分', { runId, rowId });
  return run;
}
```

import 补 `rescoreRow as rescoreRowInOrchestrator`（与既有的四个别名同一处）。

`packages/server/api/src/index.ts` 的评测域导出块加 `rescoreRow`（按字母序）。

`apps/web-next/app/api/runs/[runId]/rows/[rowId]/rescore/route.ts`（照 `abort/route.ts` 逐字改）：

```ts
/** 重新评分：POST。只重跑评分步骤，不重跑候选 agent（spec §9）。 */
import { rescoreRow } from '@aieval/api';
import { handleApiError } from '@/src/server-context';

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ runId: string; rowId: string }> },
): Promise<Response> {
  try {
    const { runId, rowId } = await params;
    return Response.json(rescoreRow(runId, rowId));
  } catch (error) {
    return handleApiError(error);
  }
}
```

- [ ] **Step 8: 实现客户端 hook 与界面按钮**

`packages/client/client/src/runs.ts` 末尾加（照 `useAbortRow` 逐字改）：

```ts
/**
 * 重新评分：只重跑评分步骤（spec §9）。回写两个键与另外四个写操作同形——
 * 「状态立刻变成 judging」这件事必须同时被详情与列表看到。
 */
export function useRescoreRow(): {
  rescoreRow: (runId: string, rowId: string) => Promise<EvalRun>;
  isRescoring: boolean;
} {
  const { mutate } = useSWRConfig();
  const [isRescoring, setRescoring] = useState(false);

  const rescoreRow = useCallback(
    async (runId: string, rowId: string): Promise<EvalRun> => {
      setRescoring(true);
      try {
        const run = await postJson<EvalRun>(`${runKey(runId)}/rows/${rowId}/rescore`, {});
        await mutate(runKey(runId), run, { revalidate: false });
        await mutate(RUNS_KEY);
        return run;
      } finally {
        setRescoring(false);
      }
    },
    [mutate],
  );

  return { rescoreRow, isRescoring };
}
```

`packages/client/ui/src/composite/eval-row-card.tsx`：

- import 补 `canRescoreRow`；
- props 加：

```ts
  onRescore: () => void;
  /** 重评请求在途：按钮转圈并禁用（避免连点两次） */
  rescorePending?: boolean;
```

- 组件体加：

```ts
  // 「重新评分」的可用判据与**服务端同一份**（contracts 的 canRescoreRow）：两处各写一份必然漂移，
  // 而漂移的表现是「按钮可点、点下去 409」。原因文案与 rescoreRefusal 一一对应。
  const rescorable = canRescoreRow(row);
  const rescoreHint = running
    ? '正在运行中：请先终止它，再重新评分'
    : row.diff === null
      ? '这一行还没有跑过，没有可复评的改动'
      : row.baselineCommit === ''
        ? '这一行的工作区未就绪，请先点「开始」跑一次'
        : undefined;
```

- 按钮组里、「评分详情」之后加：

```tsx
            {/* 重新评分只重跑评分步骤、不重跑候选 agent，但它会**替换掉现有的分数**：
                故与「终止」同一套语义，先 Popconfirm 再动手（spec §9 的用户口径）。 */}
            <Tooltip title={rescoreHint}>
              <Popconfirm
                title="重新评分这一行？"
                description="只重跑评分步骤，候选 agent 不会再跑；现有的分数会被新的评分结果替换。"
                okText="确定"
                cancelText="取消"
                okButtonProps={{ autoInsertSpace: false }}
                cancelButtonProps={{ autoInsertSpace: false }}
                onConfirm={onRescore}
                disabled={!rescorable}
              >
                <Button size="small" autoInsertSpace={false} disabled={!rescorable} loading={rescorePending === true}>
                  重新评分
                </Button>
              </Popconfirm>
            </Tooltip>
```

`packages/client/ui/src/composite/run-detail-panel.tsx`：

- props 加 `onRescoreRow: (rowId: string) => void; rescoring: boolean;`
- 渲染 `EvalRowCard` 处补 `onRescore={() => onRescoreRow(row.id)}` 与 `rescorePending={rescoring}`。

`apps/web-next/app/runs/page.tsx`：

- `const { rescoreRow, isRescoring } = useRescoreRow();`
- `RunDetailPanel` 补 `onRescoreRow={(rowId) => void guard(() => rescoreRow(run.id, rowId))}` 与 `rescoring={isRescoring}`。

- [ ] **Step 9: 跑测试确认通过**

Run: `pnpm --filter @aieval/ui test -- eval-row-card`；`pnpm --filter @aieval/api test -- runs.test`；`pnpm --filter web-next test -- route-runs`
Expected: 全 PASS

- [ ] **Step 10: 变异验证**

1. 把 `rescoreAttempt` 里的 `publishRowEvent(… '[重新评分] …')` 那一段删掉 → 「日志追加」那条用例里的标记断言**必须变红**。
2. 把 `rescoreRow` 的 `setRowStatus(… 'judging', { error: null, score: null })` 改成 `{ error: null }`（不清旧分）→ **补一条**断言「重评开始时快照里的 score 是 null」的用例并确认它能红。
3. 把 `evaluator/src/index.test.ts` 的 `'rescoreRow'` 从期望数组里删掉 → 出口面守卫**必须变红**（若不变红，说明那条断言没在守）。
4. 还原。

- [ ] **Step 11: 全链验证并提交**

```bash
pnpm typecheck
pnpm lint
pnpm test
git add packages/server/evaluator/src/orchestrator.ts packages/server/evaluator/src/orchestrator.test.ts packages/server/evaluator/src/index.ts packages/server/evaluator/src/index.test.ts packages/server/api/src/runs.ts packages/server/api/src/runs.test.ts packages/server/api/src/index.ts "apps/web-next/app/api/runs/[runId]/rows/[rowId]/rescore/route.ts" packages/client/client/src/runs.ts packages/client/ui/src/composite/eval-row-card.tsx packages/client/ui/src/composite/eval-row-card.test.tsx packages/client/ui/src/composite/run-detail-panel.tsx apps/web-next/src/route-runs.test.ts apps/web-next/app/runs/page.tsx
git commit -m "feat: 行级重新评分——只重跑评分步骤，带二次确认"
```

---

### Task 8: 展示、文档与全链收尾

**Files:**
- Modify: `packages/client/ui/src/composite/score-detail-view.tsx` + 其 `.test.tsx`
- Modify: `packages/client/ui/src/composite/log-format.ts` + 其 `.test.ts`
- Modify: `README.md`
- Test: 冒烟（真实浏览器 + CLI 互证）

**Interfaces:**
- Consumes: Task 1 的 `ScoreResult.judgeAgentKind`、`AGENT_LABELS`
- Produces: 无新接口

- [ ] **Step 1: 写失败的测试——评分详情显示智能体**

追加到 `packages/client/ui/src/composite/score-detail-view.test.tsx`：

```tsx
  it('智能体评分时显示评分智能体与模型（光有模型名回答不了「谁打的这一分」）', () => {
    render(<ScoreDetailView score={{ ...makeScore(), judgeAgentKind: 'dsh' }} />);
    expect(screen.getByText(/评分智能体：DeepSeek Harness/)).toBeInTheDocument();
  });

  it('文本 API 评分时保持原文案（老数据与另一条通路都不该长出新字样）', () => {
    render(<ScoreDetailView score={{ ...makeScore(), judgeAgentKind: null }} />);
    expect(screen.getByText(/评分模型：/)).toBeInTheDocument();
    expect(screen.queryByText(/评分智能体：/)).not.toBeInTheDocument();
  });
```

`makeScore()` 用该文件既有的夹具写法（没有就照 `makeScoreFixture` 的形状在文件内造一个）。

- [ ] **Step 2: 写失败的测试——日志行**

追加到 `packages/client/ui/src/composite/log-format.test.ts`：

```ts
  it('评分事件行在智能体评分时带上智能体名，两次评分才区分得开', () => {
    const line = formatEventLine({
      seq: 1,
      at: '2026-09-26T10:00:00.000Z',
      type: 'score',
      score: { ...scoreFixture(), judgeAgentKind: 'claude-code' },
    });
    expect(line).toContain('Claude Code');
  });
```

- [ ] **Step 3: 跑测试确认失败**

Run: `pnpm --filter @aieval/ui test -- score-detail-view log-format`
Expected: 两条都 FAIL

- [ ] **Step 4: 实现**

`score-detail-view.tsx`，把那一行元数据改成（import 补 `AGENT_LABELS`）：

```tsx
        <Typography.Text type="secondary">
          {score.judgeAgentKind === null
            ? `评分模型：${score.judgeModelId}`
            : `评分智能体：${AGENT_LABELS[score.judgeAgentKind]} · 模型：${score.judgeModelId}`}
          {' · '}
          评分时间：{formatDateTime(score.judgedAt)}
        </Typography.Text>
```

`log-format.ts` 的 `score` 分支：

```ts
    case 'score':
      return `[${time}] 评分 总分 ${event.score.totalScore} · ${
        event.score.judgeAgentKind === null
          ? event.score.judgeModelId
          : `${AGENT_LABELS[event.score.judgeAgentKind]}（智能体）· ${event.score.judgeModelId}`
      }`;
```

（import 补 `AGENT_LABELS`；`log-format.ts` 已经 import 自 `@aieval/contracts` ✓。）

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm --filter @aieval/ui test`
Expected: 全 PASS

- [ ] **Step 6: 更新 README**

在 `README.md` 的「使用手册」里补四处，**逐条对着实现核过再写**：

1. **①配置** 的「评分配置」小节加一条：默认评分智能体（三选一，可留空；与默认评分模型的协议必须匹配，不匹配的选项在下拉里是禁用的）；
2. **③建评测** 的字段表加一条：使用智能体评分（Switch，默认关闭）。并写清「开关是轮级的，创建后不可改」；
3. **⑤看产物** 与「分数怎么来的」两节：说明两条通路、`rowTimeoutMs` 同时约束候选 agent 与评分智能体两段（spec §14 第 4 条），以及**不同轮次之间分数不可比**（一条智能体评分、一条文本 API 评分时尤其）；
4. **排障表**加四行：未配置默认评分智能体 / 协议不匹配 / 评分智能体没给出可读答复 / 工作区被评分智能体改动（那条 WARN 的含义）。

同时在「界面用到的接口」表里加一行：`/api/runs/{runId}/rows/{rowId}/rescore` —— 重新评分。

- [ ] **Step 7: 全链验证**

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

四条都必须通过。`pnpm test` 的用例总数应比开工前明显增加（记录改前/改后的数字，写进 Step 8 的冒烟记录）。若出现 `Test timed out`，按 README 的既有说明逐条隔离复跑确认是满载噪声而不是真失败。

- [ ] **Step 8: 真实浏览器冒烟（AGENT.md 的「冒烟测试」一节）**

按该节的四要素记录（范围清单 / 操作路径 / 证据 / 未覆盖项），写进 `docs/superpowers/notes/` 下的本轮冒烟记录。必须走的路径：

1. 设置页 → 评分配置 → 选一个默认评分模型（Anthropic 兼容）→ 观察「默认评分智能体」下拉里 **Codex 的选项是禁用的**；
2. 选上 DSH → 用 CLI 复核 `~/.aieval/config.json` 里 `settings.defaultJudgeAgent === "dsh"`；
3. 评测页 → 创建评测 → 「使用智能体评分」**默认是关闭的** → 打开 → 确定 → CLI 复核 `run.json` 的 `useAgentJudge === true`；
4. 未配置评分智能体时打开开关 → 观察到内联 Alert；
5. 对一个已评分的行点「重新评分」→ 观察到 Popconfirm → 确定 → 行状态跳到「评分中」→ CLI 复核 `events.jsonl` 里出现 `[重新评分]` 且**旧的 `score` 事件仍在**；
6. 几何断言别靠眼睛：按钮对齐等若涉及版式，用 `browser_evaluate` 读 `getBoundingClientRect()`。

**真机跑一轮智能体评分**（需要一个可用的 CLI + 网关）若本机不具备，**如实登记为未覆盖**并写明缺什么；不要用「看起来没问题」代替证据。

- [ ] **Step 9: 提交**

```bash
git add packages/client/ui/src/composite/score-detail-view.tsx packages/client/ui/src/composite/score-detail-view.test.tsx packages/client/ui/src/composite/log-format.ts packages/client/ui/src/composite/log-format.test.ts README.md docs/superpowers/notes/<本轮冒烟记录>.md
git commit -m "docs+feat: 展示评分智能体、补 README 与冒烟记录"
```

---

## 收尾检查（全部任务完成后逐条核对）

- [ ] `pnpm typecheck` / `pnpm lint` / `pnpm test` / `pnpm build` 四条全绿，且**用例总数已记录**。
- [ ] 每个任务新增的守卫都**见过它失败**（变异验证记录散在各任务的 Step 里）。
- [ ] `git status` 干净；`git log` 里本次改动是**若干个按任务分的提交**，且没有夹带别的会话的文件。
- [ ] **spec 的 §16 六条澄清结论**在代码里逐条落实（D1–D12 的决策表同样逐条核对）。
- [ ] spec 的 **§14 七条已知边界**在 README 或代码注释里都有对应的如实登记。
- [ ] **Review Focus 五条**各自有测试钉住：老快照可读（Task 1）、开关不被 strip（Task 6）、评分阶段有界（Task 4）、工作区污染有 WARN（Task 4）、dsh 的 reasoning 不混入（Task 2）。
- [ ] 本仓的**并发会话风险**已确认：`docs/superpowers/plans/2026-09-26-remote-git-source.md` 与 `packages/server/core/src/{index,mirror,mirror.test}.ts` 属于另一个会话，**本次一律没有动它们**；若它们在我方改动期间落了新提交，合并冲突按「两边都保留」处理。


