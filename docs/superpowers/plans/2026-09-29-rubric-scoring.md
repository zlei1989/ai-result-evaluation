# 评分体系重构（评分标准项表格）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把「固定 5 维、等权、每维 1–5 分」的评分体系换成「**组 → 评分项（ID / 目标 / 权重）**二级表格 + 每项二元判定（达成 / 未达成）」，总分 = 达成项权重之和，满分 = 全部项权重之和；用例表单上直接编辑这张表，并提供「智能生成」（AI 补充已有表格）与「智能识别」（弹窗粘提示词 → 回填表格）两个动作。

**Architecture:** 评分表是**结构化数据**（`Rubric`），存用例（`TestCase.rubric`）并随一轮评测**快照**进 `run.json`（`EvalRun.rubric`）；提示词只是它的**渲染**（`renderRubricForJudge`），用户输入的提示词仅作为一次性生成输入、不落盘。两条评分通路（文本 `judgeRow` / 智能体 `judgeRowByAgent`）继续共用同一把尺子（`validateJudgeResponse` + `finalizeScore`），判据从「5 维」换成「按快照评分表逐项取，缺一项即整行失败」。模型**不给总分**，只给逐项 `achieved`，总分由 `composeTotalScore` 按权重加总。生成 / 识别两个动作都只用设置页的**全局默认评分模型**（`resolveJudgeRoute()`，无参），绝不使用智能体。

**Tech Stack:** TypeScript 5（strict + `noUncheckedIndexedAccess` + `verbatimModuleSyntax`）、zod 3、vitest 4（node / jsdom 双配置）、pnpm workspace monorepo（8 包）、antd 6 + React 19、Next.js App Router。

**Spec:** `docs/superpowers/specs/2026-09-28-rubric-scoring-design.md`（**执行前必读**；另需读它的前置 `docs/superpowers/specs/2026-09-28-structured-judge-output-design.md` §4.4，本计划要**同批替换**它落下的两份契约投影）

**基准 commit：`1d185c1`**（2026-09-29）。开工前先 `git rev-parse HEAD` 核对；不一致时先 `git diff 1d185c1 -- <本计划涉及的文件>` 看有没有冲突再动手。

## Global Constraints

- **包管理命令一律带 `corepack`**：`corepack pnpm test` / `corepack pnpm typecheck` / `corepack pnpm lint`。裸 `pnpm` 在本机是 11.7.0，而 `package.json` 固定 `pnpm@11.18.0`，直跑会以 `[ERROR] This project is configured to use 11.18.0 of pnpm` **退出码 1**。
- **测试跑法**：内循环 `corepack pnpm vitest run <文件路径>`；一个包用 `corepack pnpm vitest run packages/server/<包>`。全量（`corepack pnpm test`，约 6–7 分钟）只留给最后一道门。**基线（开工时实测）是 `2 failed | 1843 passed`（用例）**，两条失败是已知环境抖动、**没有任何断言失败**：`@aieval/api src/run-artifacts.test.ts` 的 `EPERM … config.json.tmp -> config.json` 与 `@aieval/core src/mirror-ensure-b.test.ts` 的 `EPERM … aieval-mirror-*`（Windows 临时目录被刚退出的进程占着）。**这两条红不算回归**；除它们之外的任何红都必须查。Task 9 的 Step 0 对这一族有完整登记与唯一可信判据（`git stash` 回改动前复跑同一文件 + **先抓断言原文再重跑**）。
- **提交纪律**：逐个显式 `git add <路径>`，**禁止 `git add -A`**（本仓可能同时有别的会话在工作；`git status` 里出现不属于本任务的改动时保持原样、不要动它）。
- **门禁顺序**：`corepack pnpm typecheck` → `corepack pnpm lint` → 修复所有错误 → 再进评审；格式修复产生的变更随本次改动一并提交。
- **变异验证**：本计划新增的**每一条守卫**都要做变异验证——把它要拦的缺陷人为造回去 → 看见对应用例失败 → 还原并核对文件哈希未变。**没有见过失败的守卫不算守卫。** 每条任务的报告里要写清：哪条守卫、怎么造缺陷、红在哪。
- **注释**：中文 JSDoc；文件头写职责与注意事项；先说「做什么」再说「为什么这么做」。每个新导出符号上面都要有一行说明它是什么 + 为什么。
- **UI**：样式一律走 antd（主题 token / 紧凑密度 / 语义 `styles`）；**不手写字号**、**不手调行内边距**、不裸写 `div` 做布局（用 `Flex` / `Card` / `Table`）。已核实的 antd 6 改名：`Alert` 用 `title`、`Card` 用 `variant`、`Descriptions` 用 `items`、`Input` 用 `suffix`、`Modal` 用 `destroyOnHidden`、`InputNumber` 的 `addonAfter` 已弃用、`Select.Option` 走 `options`、`Button` 的 `variant` 必须与 `color` **成对**给（单给会被静默降级成实线）。
- **测试环境**：`.test.tsx` **只在库包可写**（`apps/web-next` 的 `jsx: preserve` 会让 Vite 直接报错）；`ui` / `client` 走 jsdom，其余 6 包走 node；挂 antd `Table` / `Select` 的 jsdom 用例必须 `installResizeObserverStub()`（它同时补 `matchMedia`）。
- **不动的边界**：`packages/server/agents` 全部、`permission.ts`、`judge-route.ts`（`resolveJudgeRoute()` 的**无参**形状正是「只用全局默认模型」的代码级保证）、候选执行阶段、`ScoreResult.structuredOutput`（structured-judge-output 已落地的那一格）。
- **本次不做兼容**：旧 `judgePrompt` 文本、旧 `ScoreResult.dimensions`、旧 `run.json` 评分记录一律不支持，代码里**不留任何兼容分支**（`judgePrompt` 字段直接删，不给 `.default()`）。
- **⚠️ 禁止用 PowerShell 读改写 UTF-8 文本**（Task 3 与 Task 6 各踩过一次，控制方自己也踩过一次）：本机控制台码页是 **GBK**，`Get-Content -Raw` 会按 ANSI 解码 UTF-8 文件——**读进来就已经坏了**，写回即把中文固化成乱码。改文件一律用编辑工具；确需脚本时只能用 .NET 显式编码且**不做往返**（`ReadAllLines($p,[Text.Encoding]::UTF8)` + `WriteAllLines($p,$lines,(New-Object Text.UTF8Encoding($false)))`）。踩到之后**不要自己"修"乱码**：从 git 取回原文件、核对 SHA256 与改动前逐字节相同，再重做那一处改动。

## Review Focus

这五类输入/条件 spec 隐含、但很容易在实施时漏掉，是上线后最可能咬人的地方。每一行都在下表指名的任务里补了钉住它的用例：

| # | 条件 | 合理预期 | 钉在哪个任务 |
|---|---|---|---|
| 1 | 某项权重被手滑打成 `1e9`（多按了几个 0） | 提交时**当场被拒**并指出是哪一项；不是静默产出一张荒谬的表（`totalScore` 越过 safe integer 之后界面上的分数会变成什么没人能预测） | Task 1（`MAX_ITEM_WEIGHT` 的边界用例）+ Task 6（表单同一条判据） |
| 2 | 用户把某一项的「目标」清空 | 写侧拒绝并说明「第 N 项的目标不能为空」；不是存下一张有一项无从判定的表 | Task 1（`validateRubric`）+ Task 4（`assertStorable`） |
| 3 | 两个项写了同一个 ID（`A1` 出现两次） | 写侧拒绝并点名那个 ID。若放行，`rubricItemKeys` 会出现两个 `A1`，模型的一次判定会被同时记到两项上——**分数悄悄多出或少掉一块权重** | Task 1 + Task 4 |
| 4 | 评分表某项的「目标」里写了 `\|` 或换行 | 渲染出的 Markdown 表格**列不会错位**（错位会让模型读到一张与界面不同的表） | Task 1（`renderRubricForJudge` 的转义用例） |
| 5 | 模型把 `achieved` 回成字符串 `"true"` / `"是"` | 解析侧**宽容读**成 `true`，不是整行失败（模型很爱这么干，schema 那一关在网关不透传时拦不住） | Task 3（解析用例） |

---

## 文件结构（先定边界，再切任务）

| 文件 | 职责 | 本计划 |
|---|---|---|
| `packages/server/contracts/src/rubric.ts` | **新增**：评分表 schema、满分/引用键/校验/总分、送模型的表格渲染 | 新建 |
| `packages/server/contracts/src/rubric.test.ts` | 上者的守卫 | 新建 |
| `packages/server/contracts/src/score.ts` | 评分结果契约：逐项判定、总分、满分快照、两份契约投影 | 重写（含 `JUDGE_OUTPUT_JSON_SCHEMA`） |
| `packages/server/contracts/src/score.test.ts` | 上者的守卫（含同形/冻结守卫） | 重写 |
| `packages/server/contracts/src/case.ts` | 用例契约：`judgePrompt` → `rubric`；生成入参 | 改 |
| `packages/server/contracts/src/run.ts` | 一轮的契约：加 `rubric` 快照 | 改 |
| `packages/server/contracts/src/index.ts` | 包出口 | 改 |
| `packages/server/api/src/judge.ts` | 生成 / 识别两个分支 + 合并算法 | 重写 |
| `packages/server/api/src/cases.ts` | 用例 CRUD；写侧 `validateRubric` 守卫 | 改 |
| `packages/server/evaluator/src/judge.ts` | **两条通路共用的尺子**：解析 + 收口 + 修复提示 | 重写 |
| `packages/server/evaluator/src/judge-agent.ts` | 智能体评分通路的提示词 | 改 |
| `packages/server/evaluator/src/orchestrator.ts` | 评分阶段：读快照、空表兜底守卫 | 改 |
| `packages/client/client/src/cases.ts` | 数据层：生成的返回类型 | 改 |
| `packages/client/ui/src/composite/rubric-table.tsx` | **新增**：可编辑 / 只读的二级表格 | 新建 |
| `packages/client/ui/src/composite/rubric-recognize-modal.tsx` | **新增**：只有文本域的识别弹窗 | 新建 |
| `packages/client/ui/src/composite/case-form-panel.tsx` | 表单：删掉评分提示词，接入表格与两个按钮 | 改 |
| `packages/client/ui/src/composite/case-detail-panel.tsx` | 用例详情：评分维度行 → 评分标准项卡片 | 改 |
| `packages/client/ui/src/composite/score-detail-view.tsx` | 评分详情：5 维评分条 → 逐项达成/未达成 | 重写 |
| `apps/web-next/app/cases/page.tsx` | 用例页接线：`dimensions` state → `rubric` | 改 |

**删除**：`packages/client/ui/src/base/score-bars.tsx`（+ `.test.tsx`）、`DIMENSIONS` / `DIMENSION_COUNT` / `DimensionKey(Schema)` / `DimensionScore(Schema)` / `MIN_SCORE_PER_DIMENSION` / `MAX_SCORE_PER_DIMENSION` / `composeTotalScore(number[])` / `JUDGE_OUTPUT_CONTRACT`（旧文本）、`TestCase.judgePrompt`、`GenerateJudgePromptSchema` / `GenerateJudgePromptInput` / `GenerateJudgePromptResult`。

---

### Task 1: contracts —— 评分表契约（`rubric.ts` 新建 + `score.ts` 重写）

**Files:**
- Create: `packages/server/contracts/src/rubric.ts`
- Create: `packages/server/contracts/src/rubric.test.ts`
- Modify: `packages/server/contracts/src/score.ts`
- Modify: `packages/server/contracts/src/index.ts:95-109`（`score` 那一段出口）

**Interfaces:**
- Consumes: 无（本任务是链条起点）
- Produces（后续任务全部依赖这些确切名字与签名）：
  - `MAX_ITEM_WEIGHT = 10_000`
  - `RubricItemSchema` / `RubricItem = { id: string; goal: string; weight: number }`
  - `RubricGroupSchema` / `RubricGroup = { name: string; items: RubricItem[] }`
  - `RubricSchema` / `Rubric = { groups: RubricGroup[] }`
  - `rubricMaxScore(rubric: Rubric): number`
  - `rubricItemKeys(rubric: Rubric): string[]`
  - `validateRubric(rubric: Rubric): { ok: true } | { ok: false; message: string }`
  - `composeTotalScore(rubric: Rubric, judgments: readonly RubricJudgment[]): number`
  - `renderRubricForJudge(rubric: Rubric): string`
  - `RubricJudgmentSchema` / `RubricJudgment = { id: string; achieved: boolean; reason: string }`
  - `ScoreResultSchema` / `ScoreResult`（字段：`judgments` / `totalScore` / `maxScore` / `verdict` / `raw` / `judgeProviderId` / `judgeModelId` / `judgeAgentKind` / `structuredOutput` / `judgedAt`）
  - `JUDGE_OUTPUT_JSON_SCHEMA`、`JUDGE_OUTPUT_CONTRACT`（**新文本**）

- [ ] **Step 1: 写 `rubric.ts`（先写实现，再在同一步写测试——本文件是纯数据契约，没有可测试的行为分支需要先红）**

创建 `packages/server/contracts/src/rubric.ts`：

```ts
/**
 * 评分表契约（**评分体系的唯一真源**）：组 → 评分项（id / goal / weight）二级表格，
 * 以及由它派生的四个纯函数：满分、项引用键、校验、总分。
 *
 * 五个必须成立的口径：
 *   1. **组不带权重**，只有项带权重；**满分 = 全部项权重之和**，不强制等于 100
 *      （100 / 120 / 300 分都由表格自己决定，故满分不是一个常量）；
 *   2. `RubricSchema` **刻意不设 `.min(1)`**：空表（`{ groups: [] }`）是一个真实存在的界面状态
 *      （新建用例的初值、刚删完所有组），强行要求至少一组就等于把「新建用例」判为非法。
 *      非空要求由 `validateRubric` 在**提交时**给出；
 *   3. 项 id **允许为空**：空 id 的项在渲染提示词时按**位置**分配引用键 `#k`
 *      （k = 全表顺序号，从 1 开始、跨组连续）。不改动落盘数据——界面表格里不该出现用户没写过的 id；
 *   4. 权重上限 `MAX_ITEM_WEIGHT`：防的不是「用户想给多少分」，而是 `totalScore` / `maxScore`
 *      越过 safe integer、以及手滑多按几个 0 时没有被拦住；
 *   5. 本文件**不碰**提示词组装之外的任何东西：不读文件、不做网络、不关心用例。
 */
import { z } from 'zod';

/**
 * 单项权重上限。10000 对日常配置宽得离谱（300 分 / 1000 分的表离它还很远），
 * 只拦真错的那个量级（多按几个 0）。
 */
export const MAX_ITEM_WEIGHT = 10_000;

export const RubricItemSchema = z.object({
  /** 短 ID（A1 / D5 这种）。允许为空，空 id 的项按位置引用（见口径 3） */
  id: z.string().default(''),
  /** 目标：这一项要达成什么。**自足的判据描述**（既说清改哪里，也说清怎样算达成）。空目标没有意义 */
  goal: z.string().min(1),
  /** 权重：达成即得这么多分。0 分的项没有意义、负权重是错的，故正整数 */
  weight: z.number().int().positive().max(MAX_ITEM_WEIGHT),
});
export type RubricItem = z.infer<typeof RubricItemSchema>;

export const RubricGroupSchema = z.object({
  name: z.string().min(1),
  /** `.min(1)` 只在**提交用例**时由 `validateRubric` 要求：表单上刚点「添加分组」的空组是合法的中间态 */
  items: z.array(RubricItemSchema),
});
export type RubricGroup = z.infer<typeof RubricGroupSchema>;

export const RubricSchema = z.object({
  /** 空数组 = 表是空的（见口径 2） */
  groups: z.array(RubricGroupSchema),
});
export type Rubric = z.infer<typeof RubricSchema>;

/** 满分 = 全部项权重之和。空表返回 0（评分阶段对它有专门的守卫，见 orchestrator） */
export function rubricMaxScore(rubric: Rubric): number {
  let sum = 0;
  for (const group of rubric.groups) {
    for (const item of group.items) sum += item.weight;
  }
  return sum;
}

/**
 * 项的**引用键**：有 id 用它，没 id 用 `#k`（k = 全表顺序号，从 1 开始、跨组连续）。
 * 为什么位置引用是确定性的：`#4` 只可能对上全表第 4 项，不需要任何字符串匹配，
 * 也不会因为用户在别处改了一个字而整体错位。
 */
export function rubricItemKeys(rubric: Rubric): string[] {
  const keys: string[] = [];
  let index = 0;
  for (const group of rubric.groups) {
    for (const item of group.items) {
      index += 1;
      keys.push(item.id === '' ? `#${index}` : item.id);
    }
  }
  return keys;
}

/**
 * 校验（**提交用例与落盘的唯一判据**，界面与服务端共用同一份）：至少一组、每组至少一项、
 * 组名非空、目标非空、权重正整数（schema 已保证上限）、**有值的 id 不重复**（空 id 可以重复）。
 *
 * 为什么 id 重复必须拦：`rubricItemKeys` 会出现两个同名键，模型的一次判定会被同时记到两项上——
 * 分数悄悄多出或少掉一块权重，而界面上一切正常。
 * 返回的是**可直接展示的中文原因**（点名是哪一组 / 哪一项），不是笼统的「表格不合法」。
 */
export function validateRubric(rubric: Rubric): { ok: true } | { ok: false; message: string } {
  if (rubric.groups.length === 0) return { ok: false, message: '评分标准项不能为空：至少需要一组' };
  const seen = new Set<string>();
  for (const [groupIndex, group] of rubric.groups.entries()) {
    const groupLabel = group.name.trim() === '' ? `第 ${groupIndex + 1} 组` : `「${group.name}」`;
    if (group.name.trim() === '') return { ok: false, message: `第 ${groupIndex + 1} 组的组名不能为空` };
    if (group.items.length === 0) return { ok: false, message: `${groupLabel}里至少要有一个评分项` };
    for (const [itemIndex, item] of group.items.entries()) {
      const itemLabel = `${groupLabel}的第 ${itemIndex + 1} 项`;
      if (item.goal.trim() === '') return { ok: false, message: `${itemLabel}的目标不能为空` };
      if (!Number.isInteger(item.weight) || item.weight <= 0) {
        return { ok: false, message: `${itemLabel}的权重必须是正整数` };
      }
      if (item.id !== '') {
        if (seen.has(item.id)) return { ok: false, message: `评分项 ID「${item.id}」重复了：每个 ID 只能用一次` };
        seen.add(item.id);
      }
    }
  }
  return { ok: true };
}

/**
 * 总分 = **达成项权重之和**。判定里认不出的引用键与重复引用键都不参与
 * （解析侧已保证「每一项都有判定、缺一项即失败」，故这里只做加法）。
 */
export function composeTotalScore(rubric: Rubric, judgments: readonly { id: string; achieved: boolean }[]): number {
  const achieved = new Set(judgments.filter((item) => item.achieved).map((item) => item.id));
  const keys = rubricItemKeys(rubric);
  let sum = 0;
  for (const [index, key] of keys.entries()) {
    if (!achieved.has(key)) continue;
    const item = rubric.groups.flatMap((group) => group.items)[index];
    if (item !== undefined) sum += item.weight;
  }
  return sum;
}

/**
 * 把评分表渲染成 Markdown 二级表格（送进评分模型的那一份，**两条评分通路共用**）。
 * 三条口径：
 *   1. 第一列是**引用键**（有 id 用 id，没 id 用 `#k`）——模型据此指认「我评的是哪一项」；
 *   2. `|` 与换行必须转义/替换成空格：目标里带一个竖线就会让整行列错位，
 *      而错位之后模型读到的是一张与界面不同的表；
 *   3. 表尾给汇总（共几项、满分多少），让模型知道权重之和是满分。
 */
export function renderRubricForJudge(rubric: Rubric): string {
  const lines: string[] = [];
  const keys = rubricItemKeys(rubric);
  let cursor = 0;
  for (const group of rubric.groups) {
    lines.push(group.name, '| 引用键 | 目标 | 权重 |', '| --- | --- | --- |');
    for (const item of group.items) {
      const key = keys[cursor] ?? `#${cursor + 1}`;
      cursor += 1;
      lines.push(`| ${key} | ${escapeCell(item.goal)} | ${item.weight} |`);
    }
    lines.push('');
  }
  lines.push(`以上共 ${keys.length} 项，满分 ${rubricMaxScore(rubric)} 分。`);
  return lines.join('\n');
}

/** 单元格转义：竖线换成一个能认出来的替代字符，换行与回车压成空格（否则整行列错位） */
function escapeCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ').trim();
}
```

- [ ] **Step 2: 写 `rubric.test.ts`（守卫）**

创建 `packages/server/contracts/src/rubric.test.ts`：

```ts
// @vitest-environment node
/**
 * 评分表契约：满分 / 引用键 / 校验 / 总分 / 送模型的渲染。
 * 五组口径各自钉住一条：空表合法、空 id 按位置引用、权重上限、id 重复被拒、单元格转义。
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_ITEM_WEIGHT,
  RubricSchema,
  composeTotalScore,
  renderRubricForJudge,
  rubricItemKeys,
  rubricMaxScore,
  validateRubric,
  type Rubric,
} from './rubric';

/** 一份与 spec 示例同形的表：两组共 4 项，满分 45（刻意不是 100，钉「满分由表格决定」） */
function sample(): Rubric {
  return {
    groups: [
      { name: '一、生产代码', items: [{ id: 'A1', goal: '追加 agent 字段', weight: 18 }, { id: 'A2', goal: '补 Javadoc', weight: 4 }] },
      { name: '二、测试', items: [{ id: 'D1', goal: '有值透传用例', weight: 14 }, { id: '', goal: '缺失→null 用例', weight: 9 }] },
    ],
  };
}

describe('RubricSchema', () => {
  it('空表合法（{ groups: [] }）——它是新建用例的真实初值，不能把「新建」判为非法', () => {
    expect(RubricSchema.safeParse({ groups: [] }).success).toBe(true);
  });

  it('组内可以一项都没有（表单上刚点「添加分组」的中间态）', () => {
    expect(RubricSchema.safeParse({ groups: [{ name: '一组', items: [] }] }).success).toBe(true);
  });

  it('空组名 / 空目标 / 非正权重 / 非整数权重 / 超上限权重都被 schema 拒', () => {
    expect(RubricSchema.safeParse({ groups: [{ name: '', items: [{ goal: 'g', weight: 1 }] }] }).success).toBe(false);
    expect(RubricSchema.safeParse({ groups: [{ name: 'g', items: [{ goal: '', weight: 1 }] }] }).success).toBe(false);
    expect(RubricSchema.safeParse({ groups: [{ name: 'g', items: [{ goal: 'g', weight: 0 }] }] }).success).toBe(false);
    expect(RubricSchema.safeParse({ groups: [{ name: 'g', items: [{ goal: 'g', weight: -1 }] }] }).success).toBe(false);
    expect(RubricSchema.safeParse({ groups: [{ name: 'g', items: [{ goal: 'g', weight: 1.5 }] }] }).success).toBe(false);
    expect(
      RubricSchema.safeParse({ groups: [{ name: 'g', items: [{ goal: 'g', weight: MAX_ITEM_WEIGHT }] }] }).success,
    ).toBe(true);
    expect(
      RubricSchema.safeParse({ groups: [{ name: 'g', items: [{ goal: 'g', weight: MAX_ITEM_WEIGHT + 1 }] }] }).success,
    ).toBe(false);
  });

  it('id 缺省为空串（表格里「没写 ID」与「ID 是空串」是同一件事）', () => {
    const parsed = RubricSchema.parse({ groups: [{ name: 'g', items: [{ goal: 'g', weight: 1 }] }] });
    expect(parsed.groups[0]?.items[0]?.id).toBe('');
  });
});

describe('rubricMaxScore', () => {
  it('满分 = 全部项权重之和（不是常量：45 分的表就该是 45）', () => {
    expect(rubricMaxScore(sample())).toBe(18 + 4 + 14 + 9);
  });

  it('空表返回 0（不返回 NaN）', () => {
    expect(rubricMaxScore({ groups: [] })).toBe(0);
  });
});

describe('rubricItemKeys', () => {
  it('有 id 用 id，没 id 用 #k；k 是**全表顺序号**，跨组连续', () => {
    expect(rubricItemKeys(sample())).toEqual(['A1', 'A2', 'D1', '#4']);
  });

  it('空 id 的项与有 id 的项混排时，顺序号仍然只按位置递增', () => {
    const rubric: Rubric = {
      groups: [
        { name: 'g1', items: [{ id: '', goal: 'a', weight: 1 }] },
        { name: 'g2', items: [{ id: 'X', goal: 'b', weight: 1 }, { id: '', goal: 'c', weight: 1 }] },
      ],
    };
    // 第二项有 id 但仍占第 2 个位置 ⇒ 第三项是 #3（不是 #2）
    expect(rubricItemKeys(rubric)).toEqual(['#1', 'X', '#3']);
  });
});

describe('validateRubric', () => {
  it('合格的表格返回 ok', () => {
    expect(validateRubric(sample())).toEqual({ ok: true });
  });

  it('空表被拒，且原因是可直接展示的中文', () => {
    const result = validateRubric({ groups: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('至少需要一组');
  });

  it('空组被拒并点名是哪一组', () => {
    const result = validateRubric({ groups: [{ name: '一、生产代码', items: [] }] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('一、生产代码');
  });

  it('空目标被拒并点名是第几项', () => {
    const result = validateRubric({
      groups: [{ name: 'g', items: [{ id: '', goal: 'ok', weight: 1 }, { id: '', goal: '   ', weight: 2 }] }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('第 2 项');
  });

  it('有值的 id 重复被拒并点名那个 id（放行会让一次判定同时记到两项上）', () => {
    const result = validateRubric({
      groups: [
        { name: 'g1', items: [{ id: 'A1', goal: 'a', weight: 1 }] },
        { name: 'g2', items: [{ id: 'A1', goal: 'b', weight: 2 }] },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('A1');
  });

  it('空 id 重复是合法的（它们没有身份）', () => {
    // ⚠️ 字面量必须显式写 `id: ''`：`Rubric` 是 schema 的**输出**类型（`id: string`），
    // `.default('')` 只在 `.parse()` 时生效——直接构造对象时漏掉 id，运行期 `undefined !== ''` 为真，
    // 第二项会被当成「重复的 id」拦下（而那正是这条用例要证明不会发生的事）
    expect(
      validateRubric({
        groups: [
          { name: 'g', items: [{ id: '', goal: 'a', weight: 1 }, { id: '', goal: 'b', weight: 2 }] },
        ],
      }),
    ).toEqual({ ok: true });
  });
});

describe('composeTotalScore', () => {
  it('总分 = 达成项权重之和（含两个端点：一项没达成 = 0、全达成 = 满分）', () => {
    const rubric = sample();
    expect(
      composeTotalScore(rubric, [
        { id: 'A1', achieved: true },
        { id: 'A2', achieved: false },
        { id: 'D1', achieved: true },
        { id: '#4', achieved: false },
      ]),
    ).toBe(32);
    expect(composeTotalScore(rubric, [])).toBe(0);
    expect(
      composeTotalScore(rubric, [
        { id: 'A1', achieved: true },
        { id: 'A2', achieved: true },
        { id: 'D1', achieved: true },
        { id: '#4', achieved: true },
      ]),
    ).toBe(rubricMaxScore(rubric));
  });

  it('总分可以大于 100（300 分的表全达成就是 300）', () => {
    const rubric: Rubric = { groups: [{ name: 'g', items: [{ id: 'A', goal: 'a', weight: 200 }, { id: 'B', goal: 'b', weight: 100 }] }] };
    expect(composeTotalScore(rubric, [{ id: 'A', achieved: true }, { id: 'B', achieved: true }])).toBe(300);
  });
});

describe('renderRubricForJudge', () => {
  it('含组名、每条引用键、权重与表尾汇总', () => {
    const text = renderRubricForJudge(sample());
    expect(text).toContain('一、生产代码');
    expect(text).toContain('二、测试');
    for (const key of ['A1', 'A2', 'D1', '#4']) expect(text).toContain(key);
    expect(text).toContain('| 18 |');
    expect(text).toContain('以上共 4 项，满分 45 分。');
  });

  /**
   * 守卫（Review Focus 4）：目标里带竖线或换行时**列不能错位**。
   * 错位的后果不是报错，而是模型读到一张与界面不同的表——它会按错位后的列去理解权重。
   */
  it('目标里的竖线被转义、换行被压成空格（列不错位）', () => {
    const text = renderRubricForJudge({
      groups: [{ name: 'g', items: [{ id: 'A', goal: '第一行\n第二行|带竖线', weight: 7 }] }],
    });
    const row = text.split('\n').find((line) => line.startsWith('| A |')) ?? '';
    expect(row).not.toContain('\n');
    // 竖线被转义成 `\|` ⇒ 按**未转义**的竖线切分，这一行的段数是 5：
    // 三列 Markdown 行有 4 个竖线，切分产生的段数 = 竖线数 + 1，且首尾各有一个空段
    expect(row.split(/(?<!\\)\|/)).toHaveLength(5);
    expect(row).toContain('第一行 第二行');
  });
});
```

- [ ] **Step 3: 跑 Task 1 的第一半，确认 `rubric.ts` 全绿**

Run: `corepack pnpm vitest run packages/server/contracts/src/rubric.test.ts`
Expected: PASS（全部用例通过）

- [ ] **Step 4: 重写 `score.ts`（两份契约投影同批替换）**

用下面这份内容**整体替换** `packages/server/contracts/src/score.ts`：

```ts
/**
 * 评分结果契约：逐项判定、总分合成口径、以及**送模型的输出契约的两个投影**。
 * 四条必须成立的口径：
 *   1. 模型**不给总分**，只给逐项 `achieved`（布尔）+ 一句理由。总分由 `composeTotalScore` 按权重加总
 *      —— 于是「模型算错总分」这一整类问题从根上消失（旧体系要专门防御「不采信自报的 totalScore」）；
 *   2. `maxScore` 是**满分快照**：生成这一分时评分表的权重之和。评分表改了之后，这一分
 *      与它自己的满分仍然自洽（与 `EvalRun.caseTitle` 同一套冗余快照口径）；
 *   3. `JUDGE_OUTPUT_CONTRACT`（文本）与 `JUDGE_OUTPUT_JSON_SCHEMA`（结构化输出）是
 *      **同一条契约的两个投影**，必须**同批修改**——只动一侧就会让「模型按 schema 回的」与
 *      「解析器按提示词认的」分叉，而那种分叉在界面上表现为「模型回得挺好、解析就是失败」；
 *   4. 两份投影里**都没有 `totalScore`**（口径 1）。`judgments` **不设 minItems/maxItems**：
 *      项数由每个用例的评分表决定，而 schema 是编译期字面量，表达不了「恰好等于这张表的项数」
 *      ——那一条只能由结构检查判（缺一项即整行失败）。
 */
import { z } from 'zod';
import { AgentKindSchema } from './agent';

export const RubricJudgmentSchema = z.object({
  /** 评分表里那一项的**引用键**（有 id 用 id，没 id 用 `#k`），模型原样照抄 */
  id: z.string().min(1),
  /** 达成 = 拿到该项全部权重；未达成 = 0。**二元判定，没有部分分** */
  achieved: z.boolean(),
  reason: z.string(),
});
export type RubricJudgment = z.infer<typeof RubricJudgmentSchema>;

export const ScoreResultSchema = z.object({
  /** 逐项判定。**必须与快照评分表逐项对齐**：少一项即整行失败（缺项 = 判不了，不等于没达成） */
  judgments: z.array(RubricJudgmentSchema),
  /** 达成项权重之和 */
  totalScore: z.number().int().min(0),
  /** 满分快照 = 生成这一分时评分表的权重之和。**必须为正**：空表的分数不该存在 */
  maxScore: z.number().int().positive(),
  /** 一句话总评 */
  verdict: z.string(),
  /** 模型原始返回，排障用（判断是提示词问题还是模型问题） */
  raw: z.string(),
  judgeProviderId: z.string(),
  judgeModelId: z.string(),
  judgedAt: z.string(),
  /**
   * 这一分是哪个智能体打的；null ⇔ 走纯文本 API。
   * 与 `judgeProviderId` / `judgeModelId` 并列，是「尺子」的一部分：光有模型名回答不了
   * 「这个分是文本请求打的还是智能体会话打的」。`.default(null)` 同 `EvalRunSchema.useAgentJudge`。
   */
  judgeAgentKind: AgentKindSchema.nullable().default(null),
  /**
   * 这一分是不是在 **schema 约束**下拿到的（false = 只靠提示词契约）。
   * ⚠️ 它记的是**我们传了 schema**，不是「上游认了」（网关可能把这格丢掉）。
   * `.default(false)` 同 `judgeAgentKind`：磁盘上已有的评分记录要能读回。
   */
  structuredOutput: z.boolean().default(false),
});
export type ScoreResult = z.infer<typeof ScoreResultSchema>;

/**
 * 评分输出的 JSON Schema（结构化输出用）：给 claude-code 的 `outputFormat` 与 codex 的 `outputSchema` 用。
 * 四条口径：
 *   1. **只用可移植子集**：不出现 `oneOf` / `const` / `prefixItems` / `uniqueItems`；
 *   2. **与 `JUDGE_OUTPUT_CONTRACT` 同形**：改一份必须同批改另一份；
 *   3. **没有 `minItems` / `maxItems`**：项数由每张评分表决定，编译期字面量表达不了（见文件头口径 4）；
 *   4. `achieved` 取 `boolean` **严档**：请求侧阻止字符串，代价是网关不透传时模型仍可能回 `"true"`
 *      —— 解析侧对此**宽容读**（`collectJudgeJudgments`），这是一处**有意登记的差异**，
 *      与旧体系「schema 拒 6 分、解析器夹紧到 5」同一形状。
 */
export const JUDGE_OUTPUT_JSON_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['judgments', 'verdict'],
  properties: {
    judgments: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'achieved', 'reason'],
        properties: {
          id: { type: 'string' },
          achieved: { type: 'boolean' },
          reason: { type: 'string' },
        },
      },
    },
    verdict: { type: 'string' },
  },
} as const);

/**
 * 生成的提示词必须自带的输出契约文本：**单一真源**，生成侧与解析侧共用同一份字段名。
 * 写死「只输出 JSON」是必需的——否则模型回一段散文，解析侧就翻车。
 * 第 5 条（不要给总分）不是修辞：模型一旦自报总分，界面上就可能出现两个互相矛盾的数。
 */
export const JUDGE_OUTPUT_CONTRACT = [
  '输出要求（务必严格遵守）：',
  '1. 只输出一个 JSON 对象，不要输出 JSON 以外的任何文字，不要使用 markdown 代码围栏；',
  '2. 字段结构固定为：',
  '   {',
  '     "judgments": [',
  '       { "id": "评分表里的引用键，原样照抄", "achieved": true, "reason": "一句中文说明" }',
  '     ],',
  '     "verdict": "一句话中文总评"',
  '   }',
  '3. 评分表里的**每一项**都必须恰好给出一条判定：不许多、不许少、不许合并、不许改 id；',
  '4. "achieved" 只允许 true / false 两个值：目标达成给 true，未达成给 false；',
  '5. 你的回复里**不要**给总分——总分由系统按「达成项的权重之和」计算。',
].join('\n');
```

- [ ] **Step 5: 重写 `score.test.ts`（含两条跨投影守卫）**

用下面这份内容**整体替换** `packages/server/contracts/src/score.test.ts`：

```ts
// @vitest-environment node
/**
 * 评分结果契约：逐项判定、满分快照，以及**两份契约投影的同形守卫**。
 *
 * 本文件最重要的一组断言是「schema 与契约文本同形」：`JUDGE_OUTPUT_CONTRACT` 是模型真正读到的
 * 那份提示词，`JUDGE_OUTPUT_JSON_SCHEMA` 是我们真正传给 CLI 的那份约束——它们是同一条契约的两个
 * 投影，任一侧多一个或少一个字段，模型看到的形状与解析器认的形状就会分叉。
 * 手抄一份字段名只能证明「我抄的与 schema 一致」，证明不了**契约文本**与 schema 一致，
 * 所以这里直接从文本里正则抽字段名。
 */
import { describe, expect, it } from 'vitest';
import {
  JUDGE_OUTPUT_CONTRACT,
  JUDGE_OUTPUT_JSON_SCHEMA,
  RubricJudgmentSchema,
  ScoreResultSchema,
} from './score';

const judgments = [
  { id: 'A1', achieved: true, reason: '字段进了契约' },
  { id: '#2', achieved: false, reason: '没补 Javadoc' },
];

/** 一份合格的评分结果（多处用例共用，避免各写一份形状） */
function goodScore(): Record<string, unknown> {
  return {
    judgments,
    totalScore: 18,
    maxScore: 22,
    verdict: '大体完成',
    raw: '{"judgments":[]}',
    judgeProviderId: 'p-1',
    judgeModelId: 'deepseek-chat',
    judgedAt: '2026-09-29T10:30:00.000Z',
  };
}

describe('RubricJudgmentSchema', () => {
  it('接受 id / achieved / reason，且 achieved 必须是布尔', () => {
    expect(RubricJudgmentSchema.safeParse({ id: 'A1', achieved: true, reason: '好' }).success).toBe(true);
    expect(RubricJudgmentSchema.safeParse({ id: 'A1', achieved: 'true', reason: '好' }).success).toBe(false);
    expect(RubricJudgmentSchema.safeParse({ id: '', achieved: true, reason: '好' }).success).toBe(false);
  });
});

describe('ScoreResultSchema', () => {
  it('接受完整结果；totalScore 可以为 0 且**可以大于 100**（300 分的表）', () => {
    expect(ScoreResultSchema.safeParse(goodScore()).success).toBe(true);
    expect(ScoreResultSchema.safeParse({ ...goodScore(), totalScore: 0 }).success).toBe(true);
    expect(ScoreResultSchema.safeParse({ ...goodScore(), totalScore: 300, maxScore: 300 }).success).toBe(true);
  });

  it('maxScore 必须存在且为正（空表的分数不该存在：满分 0 意味着无从判定）', () => {
    const { maxScore: _drop, ...withoutMax } = goodScore();
    expect(ScoreResultSchema.safeParse(withoutMax).success).toBe(false);
    expect(ScoreResultSchema.safeParse({ ...goodScore(), maxScore: 0 }).success).toBe(false);
    expect(ScoreResultSchema.safeParse({ ...goodScore(), maxScore: -1 }).success).toBe(false);
  });

  it('raw 必须保留（排障用：判断是提示词问题还是模型问题）', () => {
    expect(ScoreResultSchema.safeParse({ ...goodScore(), raw: undefined }).success).toBe(false);
  });

  it('judgeAgentKind 缺省为 null、structuredOutput 缺省为 false（老记录读盘要能过）', () => {
    const parsed = ScoreResultSchema.safeParse(goodScore());
    if (!parsed.success) throw new Error(`合格结果必须解析成功：${parsed.error.message}`);
    expect(parsed.data.judgeAgentKind).toBeNull();
    expect(parsed.data.structuredOutput).toBe(false);
    expect(ScoreResultSchema.safeParse({ ...goodScore(), judgeAgentKind: 'dsh' }).success).toBe(true);
    expect(ScoreResultSchema.safeParse({ ...goodScore(), judgeAgentKind: 'gemini' }).success).toBe(false);
  });
});

describe('JUDGE_OUTPUT_CONTRACT（新文本）', () => {
  it('含解析器读的每个字段名，且明确要求「不要输出 JSON 以外的任何文字」', () => {
    for (const field of ['judgments', 'id', 'achieved', 'reason', 'verdict']) {
      expect(JUDGE_OUTPUT_CONTRACT).toContain(field);
    }
    expect(JUDGE_OUTPUT_CONTRACT).toContain('不要输出');
  });

  it('明确要求「每一项都必须恰好给出一条判定」与「不要给总分」', () => {
    expect(JUDGE_OUTPUT_CONTRACT).toContain('每一项');
    expect(JUDGE_OUTPUT_CONTRACT).toContain('不要');
    expect(JUDGE_OUTPUT_CONTRACT).toContain('总分');
  });
});

describe('JUDGE_OUTPUT_JSON_SCHEMA：结构化输出的单一真源', () => {
  const schema = JUDGE_OUTPUT_JSON_SCHEMA;

  it('顶层 required 与 properties 同集合，且不允许多余字段', () => {
    expect([...schema.required].sort()).toEqual(Object.keys(schema.properties).sort());
    expect(schema.additionalProperties).toBe(false);
  });

  it('judgments 项的形状：id / achieved / reason 三个必填，achieved 是布尔', () => {
    const item = schema.properties.judgments.items;
    expect([...item.required].sort()).toEqual(['achieved', 'id', 'reason']);
    expect(item.properties.achieved.type).toBe('boolean');
    expect(item.additionalProperties).toBe(false);
  });

  /**
   * 守卫：`judgments` **不许**出现 minItems / maxItems。
   * 项数由每个用例的评分表决定，而 schema 是编译期字面量——写死任何一个数字都是错的
   * （旧体系能写 `minItems: DIMENSION_COUNT` 是因为 5 维是常量）。
   * 缺了这条，后人会「顺手补回来」，而补回来的那一刻 schema 就开始拒绝合法的表。
   */
  it('judgments 没有 minItems / maxItems（项数由每张评分表决定）', () => {
    expect(Object.keys(schema.properties.judgments)).not.toContain('minItems');
    expect(Object.keys(schema.properties.judgments)).not.toContain('maxItems');
  });

  it('顶层被冻结（共享全局值：谁都不能在运行期往上加一格或改一格）', () => {
    expect(Object.isFrozen(JUDGE_OUTPUT_JSON_SCHEMA)).toBe(true);
  });

  /**
   * 同形守卫（本文件最重要的一条）：schema 的字段名与契约文本里列的完全一致，多一个少一个都红。
   * 正则命中的是契约里那段 JSON 骨架的键名（去掉重复后是 judgments / id / achieved / reason / verdict）。
   */
  it('字段名与 JUDGE_OUTPUT_CONTRACT 文本里列的完全一致（多一个少一个都红）', () => {
    const names = new Set([...JUDGE_OUTPUT_CONTRACT.matchAll(/"([A-Za-z][A-Za-z0-9]*)"/g)].map((match) => match[1]));
    const schemaNames = new Set([
      ...Object.keys(schema.properties),
      ...Object.keys(schema.properties.judgments.items.properties),
    ]);
    const missingInContract = [...schemaNames].filter((name) => !names.has(name));
    const extraInContract = [...names].filter((name) => name !== undefined && !schemaNames.has(name));
    expect(missingInContract).toEqual([]);
    expect(extraInContract).toEqual([]);
    // 钉住抽取本身没抽空（两侧都空集也会「相等」，那是假绿）
    expect(names.size).toBeGreaterThanOrEqual(schemaNames.size);
  });

  it('两份投影里都不出现 totalScore（模型不给总分，这是本次重构的核心口径之一）', () => {
    expect(JUDGE_OUTPUT_CONTRACT).not.toContain('totalScore');
    expect(Object.keys(schema.properties)).not.toContain('totalScore');
  });
});
```

- [ ] **Step 6: 改 `index.ts` 的出口（**本任务做，Task 2 不再重复**）**

`packages/server/contracts/src/index.ts` 里把**旧的 `./score` 出口块**（`DIMENSIONS` / `DIMENSION_COUNT` / `DimensionKeySchema` / `DimensionScoreSchema` / `JUDGE_OUTPUT_CONTRACT` / `JUDGE_OUTPUT_JSON_SCHEMA` / `MAX_SCORE_PER_DIMENSION` / `MIN_SCORE_PER_DIMENSION` / `ScoreResultSchema` / `composeTotalScore` / `type DimensionKey` / `type DimensionScore` / `type ScoreResult`）整体替换为：

```ts
export { JUDGE_OUTPUT_CONTRACT, JUDGE_OUTPUT_JSON_SCHEMA, RubricJudgmentSchema, ScoreResultSchema, type RubricJudgment, type ScoreResult } from './score';
export {
  MAX_ITEM_WEIGHT,
  RubricGroupSchema,
  RubricItemSchema,
  RubricSchema,
  composeTotalScore,
  renderRubricForJudge,
  rubricItemKeys,
  rubricMaxScore,
  validateRubric,
  type Rubric,
  type RubricGroup,
  type RubricItem,
} from './rubric';
```

**`./case` / `./run` / `./agent-event` 三个块一个字都不动**——它们引用的 `GenerateJudgePromptSchema` 等名字由 Task 2 改名。于是本任务之后包根会短暂「导出的是一个 Task 2 才会出现的名字」，那是预期的（`index.test.ts` 从此刻起是红的，属于 Task 2 的范围）。

- [ ] **Step 7: 跑 contracts 包，确认 `score.test.ts` 与 `rubric.test.ts` 全绿**

Run: `corepack pnpm vitest run packages/server/contracts`
Expected: 有**失败**——`case.test.ts` / `run.test.ts` / `index.test.ts` / `agent-event.test.ts` 会因为旧符号没了而红（这是 Task 2 的工作），但 `rubric.test.ts` 与 `score.test.ts` 必须全绿。

Run（只跑这两份，确认 Task 1 的产出本身是对的）：`corepack pnpm vitest run packages/server/contracts/src/rubric.test.ts packages/server/contracts/src/score.test.ts`
Expected: PASS

- [ ] **Step 8: 变异验证（三条守卫）**

逐条做，每条都记录「怎么造缺陷、红在哪条用例」，然后**还原并核对文件哈希未变**（`git hash-object <文件>` 前后对比）：

1. 把 `rubricItemKeys` 里 `item.id === '' ? \`#${index}\` : item.id` 改成永远返回 `item.id` ⇒ `rubricItemKeys` 与 `renderRubricForJudge` 的用例必须红。
2. 把 `validateRubric` 里 `if (seen.has(item.id))` 那个分支删掉 ⇒「id 重复被拒」必须红。
3. 把 `JUDGE_OUTPUT_JSON_SCHEMA` 的 `Object.freeze` 去掉 ⇒「顶层被冻结」必须红。

- [ ] **Step 9: 提交**

```bash
git add packages/server/contracts/src/rubric.ts packages/server/contracts/src/rubric.test.ts packages/server/contracts/src/score.ts packages/server/contracts/src/score.test.ts packages/server/contracts/src/index.ts
git commit -m "feat(contracts): 评分表契约（组/目标/权重）与逐项判定的评分结果契约

- 新增 rubric.ts：Rubric schema、满分/引用键/校验/总分/送模型渲染
- score.ts 重写：judgments（二元判定）+ maxScore 快照，两份契约投影同批替换
- index.ts 的 score 出口块换成 score + rubric 两块（case/run 两块留给 Task 2）
- judgeAgentKind / structuredOutput 两格原样保留"
```

---

### Task 2: contracts 收尾 —— `case.ts` / `run.ts` 与全部夹具改字段

**Files:**
- Modify: `packages/server/contracts/src/case.ts`
- Modify: `packages/server/contracts/src/run.ts:153-176`（`EvalRunSchema`）
- Modify: `packages/server/contracts/src/index.ts`（**只改 `./case` 那一段**：`GenerateJudgePromptSchema` → `GenerateRubricSchema`；`./score` / `./rubric` 两块已在 Task 1 改完，**不要再动**）
- Modify: `packages/server/contracts/src/case.test.ts`、`run.test.ts`、`index.test.ts`、`agent-event.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `RubricSchema` / `Rubric` / `ScoreResultSchema`
- Produces：
  - `TestCase.rubric: Rubric`（`judgePrompt` 删除）
  - `CaseCreate.rubric: Rubric`
  - `GenerateRubricSchema` / `GenerateRubricInput = { rubric: Rubric; taskPrompt: string; prompt: string; repoPath: string }`
  - `EvalRun.rubric: Rubric`

- [ ] **Step 1: 改 `case.ts`**

对 `packages/server/contracts/src/case.ts` 做四处改动（文件头那段「用例不再持有评分模型」的注释**保留**，它仍然是事实）：

1. import 补 `RubricSchema`：

```ts
import { z } from 'zod';
import { RubricSchema } from './rubric';
import { RepoSourceStringSchema } from './repo-source';
```

2. `TestCaseSchema` 里把 `judgePrompt: z.string().min(1),` 换成：

```ts
  /**
   * 评分标准项（组 → 评分表）。**必填**，空表是 `{ groups: [] }` 而不是 undefined：
   * 契约层刻意不设 `.min(1)`（那会让「新建用例」这个动作本身非法），非空要求由 `validateRubric`
   * 在提交时给出。`judgePrompt`（一段自由文本）已随本次重构删除——评分口径现在只有这一份真源。
   */
  rubric: RubricSchema,
```

3. `CaseCreateSchema` 里同样把 `judgePrompt: z.string().min(1),` 换成 `rubric: RubricSchema,`。

4. 把文件末尾的 `GenerateJudgePromptSchema` 那一整段换成：

```ts
/**
 * 生成评分标准项入参：两个动作共用一个入口，由 `prompt` 是否为空分派。
 *   · `prompt` 为空  ⇒ 「智能生成」：按题面 + 当前表格让 AI **补充**条目（用 `repoPath` 取仓库名）；
 *   · `prompt` 非空  ⇒ 「智能识别」：把用户粘贴的评分要求解析成表格，**不碰仓库**
 *     （故 `repoPath` 可空——「填了提示词却因为仓库路径没填而识别不了」这个组合被这条规则消灭）。
 * **不带评分模型**：两个动作都只用设置页「评分配置」的全局默认（`resolveJudgeRoute()` 无参），
 * 入参里再带一对 id 就等于让调用方能绕开设置页那一格。
 */
export const GenerateRubricSchema = z.object({
  /** 当前表格（「智能生成」的输入；识别分支忽略它）。空表就是 `{ groups: [] }` */
  rubric: RubricSchema,
  /** 题面：生成分支必填，识别分支可空（填了会作为识别上下文） */
  taskPrompt: z.string().default(''),
  /** 用户粘贴的评分要求：非空 ⇒ 走识别分支 */
  prompt: z.string().default(''),
  /** 仓库来源：生成分支用它取仓库名，识别分支可空 */
  repoPath: z.string().default(''),
});
export type GenerateRubricInput = z.infer<typeof GenerateRubricSchema>;
```

- [ ] **Step 2: 改 `run.ts` 的 `EvalRunSchema`**

在 `packages/server/contracts/src/run.ts` 里：import 补 `RubricSchema`（与 `ScoreResultSchema` 同一处 import 段），并在 `EvalRunSchema` 的 `repoBranch` 之后插入：

```ts
  /**
   * 冗余快照：**这一轮用的是哪张评分表**（与 caseTitle / repoPath / repoBranch 同一条口径）。
   * 为什么必须快照：评分阶段读的是它而不是 `testCase.rubric`——改了用例的评分表之后，
   * 历史记录里的分数与它自己的满分仍然自洽，「重新评分」用的也仍是当初那把尺子。
   * **必填**：旧 run.json 没有这一格会 `safeParse` 失败 ⇒ `listRuns()` 静默跳过那一轮
   * （这正是本次升级要求清掉旧评测记录的原因，见计划 §兼容性）。
   */
  rubric: RubricSchema,
```

- [ ] **Step 3: 改 `index.ts` 的 `./case` 段**

`packages/server/contracts/src/index.ts` 里 `./case` 那一段：`GenerateJudgePromptSchema` → `GenerateRubricSchema`、`type GenerateJudgePromptInput` → `type GenerateRubricInput`（保持字母序）。
**`./score` 与 `./rubric` 两块不要动**——它们在 Task 1 已经改完；再改一次就会把两份真源写歪。

- [ ] **Step 4: 修四份测试夹具**

1. `packages/server/contracts/src/case.test.ts`：
   - 文件级 `testCase` 夹具里的 `judgePrompt: '请按 5 个维度打分',` 换成：

```ts
  rubric: {
    groups: [
      { name: '一、生产代码', items: [{ id: 'A1', goal: '追加 agent 字段', weight: 18 }] },
      { name: '二、测试', items: [{ id: 'D1', goal: '补一条透传用例', weight: 14 }] },
    ],
  },
```

   - `'接受完整记录，且要求必填文本非空'` 里 `expect(TestCaseSchema.safeParse({ ...testCase, judgePrompt: '' }).success).toBe(false);` 换成 `expect(TestCaseSchema.safeParse({ ...testCase, rubric: { groups: [] } }).success).toBe(true);`（空表在**schema**层是合法的）。
   - `CaseCreateSchema` 三条用例里的 `judgePrompt: 'j'` / `judgePrompt: 'j',` 一律换成 `rubric: { groups: [] },`。
   - `'生成评分提示词在仓库路径之上叠加考题；评分模型不在入参里'` 换成：

```ts
  it('生成评分标准项：题面与提示词都可缺省，且评分模型不在入参里', () => {
    const parsed = GenerateRubricSchema.parse({ rubric: { groups: [] }, taskPrompt: '写个 LRU' });
    expect(parsed.taskPrompt).toBe('写个 LRU');
    expect(parsed.prompt).toBe('');
    expect(parsed.repoPath).toBe('');
    expect(parsed).not.toHaveProperty('judgeProviderId');
    expect(parsed).not.toHaveProperty('judgeModelId');
  });
```

2. `packages/server/contracts/src/run.test.ts`：`import { DIMENSIONS } from './score';` 删除；两处 `score` 夹具里的 `dimensions: DIMENSIONS.map(...)` / `dimensions: []` 换成 `judgments: [...]` + `maxScore`，例如：

```ts
    const score = {
      judgments: [
        { id: 'A1', achieved: true, reason: '字段进了契约' },
        { id: 'D1', achieved: false, reason: '没补用例' },
      ],
      totalScore: 18,
      maxScore: 32,
      verdict: '完成度高',
      raw: '{}',
      judgeProviderId: 'p-1',
      judgeModelId: 'deepseek-chat',
      judgedAt: '2026-09-22T10:30:00.000Z',
    };
```

   `'EvalRow.score 直接消费 ScoreResultSchema（总分越界当场红）'` 这条**用例名要改**——判据已从「总分上限 100」变成「满分必须为正」，名字不改就成了名不副实的守卫（后人按名字找覆盖会找错）。改成 `'EvalRow.score 直接消费 ScoreResultSchema（满分必须为正，0 当场红）'`；`agent-event.test.ts` 里同形的 `'score 成员直接消费 Task 5 的 ScoreResultSchema（总分越界当场红）'` 一并改成 `'score 成员直接消费 ScoreResultSchema（满分必须为正，0 当场红）'`。判据本身（`maxScore: 0` 被拒）不变。

```ts
    expect(EvalRowSchema.safeParse({ ...row, score }).success).toBe(true);
    // 满分必须为正：0 分满分意味着「无从判定」，那种分数不该存在
    expect(EvalRowSchema.safeParse({ ...row, score: { ...score, maxScore: 0 } }).success).toBe(false);
```

   同时给每个 `EvalRun` 夹具补上 `rubric: { groups: [{ name: 'g', items: [{ id: 'A', goal: '目标', weight: 10 }] }] },`。

3. `packages/server/contracts/src/agent-event.test.ts`：删掉 `import { DIMENSIONS } from './score';`，**两处** `score` 夹具（`'接受 spec §7.4 的七个成员'` 与 `'score 成员直接消费 ScoreResultSchema（总分越界当场红）'`）里的 `dimensions: DIMENSIONS.map(...)` 一律换成：

```ts
        score: {
          judgments: [
            { id: 'A1', achieved: true, reason: '字段进了契约' },
            { id: 'D1', achieved: false, reason: '没补用例' },
          ],
          totalScore: 18,
          maxScore: 32,
          verdict: '完成度高',
          raw: '{}',
          judgeProviderId: 'p-1',
          judgeModelId: 'deepseek-chat',
          judgedAt: '2026-09-22T10:30:00.000Z',
        },
```

并把第二条里 `expect(AgentEventSchema.safeParse({ ...base, type: 'score', score: { ...score, totalScore: 101 } }).success).toBe(false);` 换成：

```ts
    // 满分必须为正：`maxScore: 0` 意味着「无从判定」，那种评分结果不该存在
    expect(AgentEventSchema.safeParse({ ...base, type: 'score', score: { ...score, maxScore: 0 } }).success).toBe(false);
```

4. `packages/server/contracts/src/index.test.ts`：import 与断言清单按新出口改——`DIMENSION_COUNT` / `DIMENSIONS` / `DimensionKeySchema` / `DimensionScoreSchema` / `MIN_SCORE_PER_DIMENSION` / `MAX_SCORE_PER_DIMENSION` / `composeTotalScore` / `GenerateJudgePromptSchema` / `type DimensionKey` / `type DimensionScore` / `type GenerateJudgePromptInput` 全部换成新名字；`'导出全部常量'` 里那几条断言换成：

```ts
    expect(MAX_ITEM_WEIGHT).toBe(10_000);
    expect(JUDGE_OUTPUT_CONTRACT).toContain('judgments');
    expect(JUDGE_OUTPUT_JSON_SCHEMA.properties.judgments.type).toBe('array');
```

   （`composeTotalScore` 仍在出口上，但签名变了，`'导出全部函数'` 里那条 `expect(composeTotalScore([5, 5, 5, 5, 5])).toBe(100)` 换成：）

```ts
    const rubric = { groups: [{ name: 'g', items: [{ id: 'A', goal: 'g', weight: 100 }] }] };
    expect(composeTotalScore(rubric, [{ id: 'A', achieved: true }])).toBe(100);
```

- [ ] **Step 5: 跑 contracts 包，必须全绿**

Run: `corepack pnpm vitest run packages/server/contracts`
Expected: PASS（10 个文件全绿，0 失败）

- [ ] **Step 6: 提交**

```bash
git add packages/server/contracts/src/case.ts packages/server/contracts/src/run.ts packages/server/contracts/src/index.ts packages/server/contracts/src/case.test.ts packages/server/contracts/src/run.test.ts packages/server/contracts/src/index.test.ts packages/server/contracts/src/agent-event.test.ts
git commit -m "feat(contracts): 用例与一轮的契约改用评分表（judgePrompt → rubric，EvalRun 加快照）"
```

---

### Task 3: evaluator —— 两条评分通路换判据

**Files:**
- Modify: `packages/server/evaluator/src/judge.ts`（重写解析与收口）
- Modify: `packages/server/evaluator/src/judge-agent.ts`（提示词）
- Modify: `packages/server/evaluator/src/judge.test.ts`、`judge-agent.test.ts`
- Modify: `packages/server/evaluator/src/testing/fixtures.ts:311-332`（`makeScoreFixture`）、`:719-725`（`fakeJudge` 的失败文案）
- Modify: `packages/server/evaluator/src/testing/orchestrator-harness.ts:29`、`:324`、`:456`

**Interfaces:**
- Consumes: Task 1 的 `Rubric` / `RubricJudgment` / `composeTotalScore` / `rubricMaxScore` / `rubricItemKeys` / 新 `JUDGE_OUTPUT_CONTRACT`；Task 2 的 `TestCase.rubric`
- Produces：
  - `validateJudgeResponse(raw: string, rubric: Rubric): JudgeValidation`
  - `parseJudgeResponse(raw: string, rubric: Rubric): { judgments: RubricJudgment[]; verdict: string }`
  - `finalizeScore(input: { parsed; rubric: Rubric; raw; judgeProviderId; judgeModelId; judgeAgentKind; structuredOutput }): ScoreResult`
  - `buildJudgeFeedback(input: { message: string; raw: string; rubric: Rubric }): string`
  - `JudgeInput.rubric: Rubric`（`judgePrompt` / `dimensions` 删除）
  - `AgentJudgeInput.rubric: Rubric`（同上）
  - `buildAgentJudgePrompt({ taskPrompt, rubric, baselineCommit }): string`

- [ ] **Step 1: 写失败用例（`judge.test.ts` 的解析部分整体替换）**

用下面这份内容**整体替换** `packages/server/evaluator/src/judge.test.ts`（它同时是 Step 2 的规格：解析、收口、修复循环、失败面）：

```ts
// @vitest-environment node
/**
 * 评分解析（纯函数）+ 一次评分调用（judgeRow，文本 API 用假实现）。
 * 判据已从「固定 5 维」换成「按用例的评分表逐项取」，四类处置各归其位：
 *   宽容（achieved 的字符串写法）、忽略（多余的判定 / 重复引用键取第一条）、
 *   占位（缺总评、缺理由）、失败（不是数字/布尔、缺项、顶层不是对象、非法 JSON）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { JUDGE_OUTPUT_CONTRACT, ServiceError, composeTotalScore, type Rubric } from '@aieval/contracts';
import {
  JUDGE_REPAIR_ROUNDS,
  RAW_KEEP_CHARS,
  buildJudgeFeedback,
  finalizeScore,
  judgeRow,
  parseJudgeResponse,
  validateJudgeResponse,
  type JudgeInput,
} from './judge';
import { fakeTextApi, resetFakeTextApi } from './testing/fixtures';

vi.mock('./text-api', async () => {
  const { fakeTextApiModule } = await import('./testing/fixtures');
  return fakeTextApiModule();
});

beforeEach(() => {
  resetFakeTextApi();
});

/** 用例的评分表：两组三项，满分 45（刻意不是 100） */
function rubric(): Rubric {
  return {
    groups: [
      {
        name: '一、生产代码',
        items: [
          { id: 'A1', goal: '追加 agent 字段', weight: 18 },
          { id: 'A2', goal: '补 Javadoc', weight: 4 },
        ],
      },
      { name: '二、测试', items: [{ id: 'D1', goal: '补透传用例', weight: 23 }] },
    ],
  };
}

/** 一份完全合法的模型返回（刻意让总分与权重之和不相等，便于看出是重算还是照抄） */
const VALID = {
  judgments: [
    { id: 'A1', achieved: true, reason: '字段进了契约' },
    { id: 'A2', achieved: false, reason: 'Javadoc 没补' },
    { id: 'D1', achieved: true, reason: '用例到位' },
  ],
  verdict: '大体完成',
};

/** 造一份「某一项不见」的返回：这是本任务最重要的一条守卫的输入 */
function withoutJudgment(id: string): string {
  return JSON.stringify({ ...VALID, judgments: VALID.judgments.filter((item) => item.id !== id) });
}

describe('parseJudgeResponse：合法输入', () => {
  it('按评分表的顺序返回逐项判定与总评', () => {
    const parsed = parseJudgeResponse(JSON.stringify(VALID), rubric());
    expect(parsed.judgments.map((item) => item.id)).toEqual(['A1', 'A2', 'D1']);
    expect(parsed.judgments.map((item) => item.achieved)).toEqual([true, false, true]);
    expect(parsed.verdict).toBe('大体完成');
  });

  it('空 id 的项用 #k 引用（模型照抄引用键即可，不需要我们改落盘数据）', () => {
    // ⚠️ `Rubric` 是 schema 的**输出**类型（`id: string` 必填），`.default('')` 只在 `.parse()` 生效：
    // 直接构造的对象**必须显式写 `id: ''`**，否则运行期 `item.id` 是 undefined，`rubricItemKeys`
    // 会在 `.trim()` 上抛 TypeError（Task 1 与 Task 3 各踩过一次同一个坑）
    const table: Rubric = { groups: [{ name: 'g', items: [{ id: '', goal: 'a', weight: 5 }, { id: '', goal: 'b', weight: 5 }] }] };
    const raw = JSON.stringify({ judgments: [{ id: '#1', achieved: true }, { id: '#2', achieved: false }], verdict: 'v' });
    expect(parseJudgeResponse(raw, table).judgments.map((item) => item.id)).toEqual(['#1', '#2']);
  });
});

describe('parseJudgeResponse：第 1 类翻车点（不合法 JSON）', () => {
  it('散文返回 / 空返回 / 顶层不是对象 / 没有 judgments 数组 → JUDGE_PARSE_FAILED', () => {
    expect(() => parseJudgeResponse('这份代码整体不错，我给 4 分。', rubric())).toThrow(/不是合法 JSON/);
    expect(() => parseJudgeResponse('   \n  ', rubric())).toThrow(/空内容/);
    expect(() => parseJudgeResponse('[1,2,3]', rubric())).toThrow(/顶层不是对象/);
    expect(() => parseJudgeResponse(JSON.stringify({ verdict: '还行' }), rubric())).toThrow(/没有 judgments 数组/);
  });
});

describe('parseJudgeResponse：第 2 类翻车点（markdown 围栏）', () => {
  it('```json 围栏包裹 → 先剥围栏再解析；中间夹散文 → 失败（不从散文里抠 JSON）', () => {
    expect(parseJudgeResponse(`\`\`\`json\n${JSON.stringify(VALID)}\n\`\`\``, rubric()).judgments).toHaveLength(3);
    expect(() => parseJudgeResponse(`我的结论是：\`\`\`json\n${JSON.stringify(VALID)}\n\`\`\``, rubric())).toThrow(
      /不是合法 JSON/,
    );
  });
});

describe('parseJudgeResponse：第 3 类翻车点（缺项 / 多余 / 重复）', () => {
  /**
   * 本任务最承重的一条守卫：**缺一项就整行失败**，绝不把「模型没提」当成「未达成」。
   * 当成未达成看起来无害，实际是「模型漏答」与「确实没做」在分数上完全同形；
   * 而当送分更糟——白送一整项权重，分数看起来完全正常。
   */
  it('缺任何一项都失败，且报错点名是哪一项（引用键 + 目标）', () => {
    for (const id of ['A1', 'A2', 'D1']) {
      const error = (() => {
        try {
          parseJudgeResponse(withoutJudgment(id), rubric());
        } catch (caught) {
          return caught;
        }
        return null;
      })();
      expect(error).toBeInstanceOf(ServiceError);
      expect((error as Error).message).toContain(id);
      expect((error as Error).message).toContain('缺少');
    }
  });

  it('多余的判定被忽略（模型自造的第 4 项不影响结果）', () => {
    const raw = JSON.stringify({ ...VALID, judgments: [...VALID.judgments, { id: 'ZZ', achieved: true, reason: '自造' }] });
    expect(parseJudgeResponse(raw, rubric()).judgments).toHaveLength(3);
  });

  it('重复引用键取第一条（模型偶尔会把同一项说两遍）', () => {
    const raw = JSON.stringify({
      ...VALID,
      judgments: [{ id: 'A1', achieved: true, reason: '第一条' }, ...VALID.judgments.slice(1), { id: 'A1', achieved: false, reason: '重复的' }],
    });
    const parsed = parseJudgeResponse(raw, rubric());
    expect(parsed.judgments[0]?.achieved).toBe(true);
    expect(parsed.judgments[0]?.reason).toBe('第一条');
  });
});

describe('parseJudgeResponse：achieved 的宽容读（Review Focus 5）', () => {
  /**
   * 模型很爱把布尔写成字符串或中文。schema 那一关只在**上游认了**的时候才拦得住
   * （网关不透传时它形同虚设，见 structured-judge-output spec §9 第 1 条），
   * 故解析侧必须宽容——否则一次「格式小毛病」会让整行失败。
   */
  it('接受 true/false、"true"/"false"、"是"/"否"；认不出的值才失败', () => {
    const cases: { given: unknown; expected: boolean }[] = [
      { given: true, expected: true },
      { given: false, expected: false },
      { given: 'true', expected: true },
      { given: 'false', expected: false },
      { given: '是', expected: true },
      { given: '否', expected: false },
    ];
    for (const { given, expected } of cases) {
      const raw = JSON.stringify({
        ...VALID,
        judgments: VALID.judgments.map((item) => (item.id === 'A1' ? { ...item, achieved: given } : item)),
      });
      expect(parseJudgeResponse(raw, rubric()).judgments[0]?.achieved).toBe(expected);
    }

    for (const given of ['优秀', 1, null, {}]) {
      const raw = JSON.stringify({
        ...VALID,
        judgments: VALID.judgments.map((item) => (item.id === 'A1' ? { ...item, achieved: given } : item)),
      });
      expect(() => parseJudgeResponse(raw, rubric())).toThrow(/achieved/);
    }
  });
});

describe('parseJudgeResponse：可容忍的缺失（占位而不是失败）', () => {
  it('缺总评 / 总评为空 → 占位文案（总评不是判据）', () => {
    expect(parseJudgeResponse(JSON.stringify({ ...VALID, verdict: undefined }), rubric()).verdict).toBe('（模型未给出总评）');
    expect(parseJudgeResponse(JSON.stringify({ ...VALID, verdict: '   ' }), rubric()).verdict).toBe('（模型未给出总评）');
  });

  it('某一项缺理由 → 占位文案（理由是展示项）', () => {
    const raw = JSON.stringify({
      ...VALID,
      judgments: VALID.judgments.map((item) => (item.id === 'A1' ? { id: 'A1', achieved: true } : item)),
    });
    expect(parseJudgeResponse(raw, rubric()).judgments[0]?.reason).toBe('（模型未给出理由）');
  });
});

describe('与 contracts 的输出契约对齐（跨包接缝）', () => {
  it('JUDGE_OUTPUT_CONTRACT 里出现解析器读的每个字段名', () => {
    for (const field of ['judgments', 'id', 'achieved', 'reason', 'verdict']) {
      expect(JUDGE_OUTPUT_CONTRACT).toContain(field);
    }
  });
});

/** 一次评分调用的标准输入（route 是假的，请求根本不会发出去） */
function judgeInput(overrides: Partial<JudgeInput> = {}): JudgeInput {
  return {
    rubric: rubric(),
    diffText: '### 未提交改动（工作区 vs HEAD）\n+ 中文标题\n',
    taskPrompt: '把 README 的标题改成中文',
    route: { protocolType: 'openai', baseUrl: 'https://fake.invalid/v1', apiKey: 'sk-test', modelId: 'judge-model' },
    judgeProviderId: 'judge-provider',
    ...overrides,
  };
}

describe('finalizeScore：两条通路共用的收口', () => {
  it('总分 = 达成项权重之和；maxScore = 评分表满分（两条通路同一把尺子）', () => {
    const parsed = { judgments: parseJudgeResponse(JSON.stringify(VALID), rubric()).judgments, verdict: '总评' };
    const result = finalizeScore({
      parsed,
      rubric: rubric(),
      raw: '{}',
      judgeProviderId: 'p1',
      judgeModelId: 'm1',
      judgeAgentKind: null,
      structuredOutput: false,
    });
    expect(result.totalScore).toBe(composeTotalScore(rubric(), parsed.judgments));
    expect(result.totalScore).toBe(41); // 18 + 23
    expect(result.maxScore).toBe(45);
    expect(result.judgeAgentKind).toBeNull();
  });

  it('structuredOutput 原样进结果（只记「我们传了 schema」，不是「上游认了」）', () => {
    const parsed = { judgments: parseJudgeResponse(JSON.stringify(VALID), rubric()).judgments, verdict: '总评' };
    const base = { parsed, rubric: rubric(), raw: '{}', judgeProviderId: 'p1', judgeModelId: 'm1', judgeAgentKind: null } as const;
    expect(finalizeScore({ ...base, structuredOutput: true }).structuredOutput).toBe(true);
    expect(finalizeScore({ ...base, structuredOutput: false }).structuredOutput).toBe(false);
  });

  it('形状漂移 → 中文 INTERNAL，不是裸 ZodError', () => {
    const parsed = { judgments: parseJudgeResponse(JSON.stringify(VALID), rubric()).judgments, verdict: '总评' };
    const error = (() => {
      try {
        finalizeScore({
          parsed,
          rubric: rubric(),
          raw: '{}',
          judgeProviderId: undefined as unknown as string,
          judgeModelId: 'm1',
          judgeAgentKind: null,
          structuredOutput: false,
        });
      } catch (caught) {
        return caught;
      }
      return null;
    })();
    expect(error).toBeInstanceOf(ServiceError);
    expect((error as ServiceError).code).toBe('INTERNAL');
    expect((error as Error).message).toContain('评分结果不符合契约');
    expect((error as Error).message).toContain('judgeProviderId');
  });
});

describe('judgeRow：成功路径', () => {
  it('把模型返回解析成 ScoreResult，总分按权重加总而不是照抄模型（模型根本不给总分）', async () => {
    fakeTextApi.reply = JSON.stringify(VALID);
    const score = await judgeRow(judgeInput());
    expect(score.judgments.map((item) => item.achieved)).toEqual([true, false, true]);
    expect(score.totalScore).toBe(41);
    expect(score.maxScore).toBe(45);
    expect(score.judgeProviderId).toBe('judge-provider');
    expect(score.judgeModelId).toBe('judge-model');
  });

  it('system 用 contracts 的输出契约，prompt 里带题面、评分表（组名/引用键/权重）与 diff', async () => {
    fakeTextApi.reply = JSON.stringify(VALID);
    await judgeRow(judgeInput());
    expect(fakeTextApi.calls[0]?.system).toBe(JUDGE_OUTPUT_CONTRACT);
    const prompt = fakeTextApi.calls[0]?.messages[0]?.content ?? '';
    expect(prompt).toContain('把 README 的标题改成中文');
    expect(prompt).toContain('一、生产代码');
    expect(prompt).toContain('A1');
    expect(prompt).toContain('| 18 |');
    expect(prompt).toContain('满分 45 分');
    expect(prompt).toContain('+ 中文标题');

    await judgeRow(judgeInput({ diffText: '   ' }));
    expect(fakeTextApi.calls[1]?.messages[0]?.content).toContain('（无改动）');
  });

  it('文本通路本期不开 schema：structuredOutput 记 false', async () => {
    fakeTextApi.reply = JSON.stringify(VALID);
    expect((await judgeRow(judgeInput())).structuredOutput).toBe(false);
  });
});

describe('judgeRow：失败面与修复循环', () => {
  it('每一轮都缺项 → JUDGE_PARSE_FAILED，文案带回问轮数，context.raw 是最后一轮的原文', async () => {
    const missing = withoutJudgment('D1');
    fakeTextApi.reply = missing;
    const error = await judgeRow(judgeInput()).catch((caught: unknown) => caught);
    expect((error as ServiceError).code).toBe('JUDGE_PARSE_FAILED');
    expect((error as Error).message).toContain('缺少');
    expect((error as Error).message).toContain(`回问模型 ${JUDGE_REPAIR_ROUNDS} 轮`);
    expect((error as ServiceError).context).toMatchObject({ raw: missing, repairs: JUDGE_REPAIR_ROUNDS });
    expect(fakeTextApi.calls).toHaveLength(1 + JUDGE_REPAIR_ROUNDS);
  });

  it('第一次回散文、第二次回合法 JSON → 正常出分，且第二轮带上了原文与纠错要求', async () => {
    fakeTextApi.replies = ['这份改动整体不错。', JSON.stringify(VALID)];
    const progress: { round: number; message: string }[] = [];
    const score = await judgeRow(judgeInput({ onProgress: (item) => progress.push(item) }));
    expect(score.totalScore).toBe(41);
    expect(fakeTextApi.calls).toHaveLength(2);
    const second = fakeTextApi.calls[1]?.messages ?? [];
    expect(second.map((message) => message.role)).toEqual(['user', 'assistant', 'user']);
    expect(second[2]?.content).toContain('不是合法 JSON');
    expect(progress).toHaveLength(1);
    expect(progress[0]?.round).toBe(1);
  });

  it('调用失败（鉴权）透传原错误码，且一次都不回问（密钥错了，再问一百次也一样）', async () => {
    fakeTextApi.failure = new ServiceError('AUTH_FAILED', '供应商密钥无效：去设置页检查');
    const error = await judgeRow(judgeInput()).catch((caught: unknown) => caught);
    expect((error as ServiceError).code).toBe('AUTH_FAILED');
    expect(fakeTextApi.calls).toHaveLength(1);
  });

  it('超长坏返回：context.raw 被截断并带「此处截断」标记', async () => {
    fakeTextApi.reply = 'x'.repeat(5_000);
    const error = await judgeRow(judgeInput()).catch((caught: unknown) => caught);
    const context = (error as ServiceError).context as { raw: string };
    expect(context.raw).toContain('此处截断');
    expect(context.raw).toContain('5000 字符');
  });
});

describe('validateJudgeResponse 与 parseJudgeResponse 是同一个判据', () => {
  it('合格时两者给出的解析结果逐字段一致；不合格时原因同源', () => {
    const good = JSON.stringify(VALID);
    const checked = validateJudgeResponse(good, rubric());
    expect(checked.ok).toBe(true);
    if (checked.ok) expect(checked.parsed).toEqual(parseJudgeResponse(good, rubric()));

    const bad = '这份代码不错，我给 4 分。';
    const failed = validateJudgeResponse(bad, rubric());
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(() => parseJudgeResponse(bad, rubric())).toThrow(failed.message);
  });
});

describe('buildJudgeFeedback：纠错提示（纯函数）', () => {
  it('点名原因、附上它自己的原文、并把评分表的引用键与目标再列一遍', () => {
    const feedback = buildJudgeFeedback({
      message: '缺少对 A2（补 Javadoc）的判定',
      raw: '{"judgments":[{"id":"A1","achieved":true}]}',
      rubric: rubric(),
    });
    expect(feedback).toContain('缺少对 A2（补 Javadoc）的判定');
    expect(feedback).toContain('{"judgments":[{"id":"A1","achieved":true}]}');
    expect(feedback).toContain('不要输出 JSON 以外的任何文字');
    for (const key of ['A1', 'A2', 'D1']) expect(feedback).toContain(key);
    expect(feedback).toContain('补 Javadoc');
  });

  it('原文超长时按 RAW_KEEP_CHARS 截断（与失败路径的 context.raw 同一个上限）', () => {
    const feedback = buildJudgeFeedback({
      message: '不是合法 JSON',
      raw: 'y'.repeat(RAW_KEEP_CHARS + 500),
      rubric: rubric(),
    });
    expect(feedback).toContain('此处截断');
    expect(feedback).toContain(String(RAW_KEEP_CHARS + 500));
  });
});
```

- [ ] **Step 2: 跑它，确认失败**

Run: `corepack pnpm vitest run packages/server/evaluator/src/judge.test.ts`
Expected: FAIL（`judge.ts` 还没改：`parseJudgeResponse` 不收 `rubric` 参数、`JudgeInput` 没有 `rubric` 字段）

- [ ] **Step 3: 重写 `judge.ts`**

用下面这份内容**整体替换** `packages/server/evaluator/src/judge.ts`：

```ts
/**
 * 评分器（**文本评分通路**）：把用例的**评分标准项表格** + 裁剪后的 diff 交给评分模型（纯文本 API），
 * 解析出逐项判定（达成 / 未达成）。另一条通路是智能体评分（`judge-agent.ts`），它复用本文件的解析与收口。
 *
 * 判据（2026-09-29 重构后）：**按评分表逐项取，缺一项即整行失败**。
 * 为什么缺项不能算「未达成」：那会让「模型漏答」与「确实没做」在分数上完全同形；
 * 当送分更糟——白送一整项权重，而分数看起来完全正常。
 *
 * 另一条不许动的口径：**总分一律按权重加总**（contracts 的 `composeTotalScore`，在 `finalizeScore` 里调用），
 * 模型**根本不给总分**（输出契约第 5 条），故「模型算错总分」这一整类问题不存在。
 *
 * 本文件里的 `parseJudgeResponse` 与 `finalizeScore` 是**两条评分通路共用的尺子**：
 * 文本通路（`judgeRow`）与智能体通路（`judge-agent.ts` 的 `judgeRowByAgent`）解析完都必须过这两个函数。
 * 各写一份必然在某处漂移，而漂移的表现是「两条通路的分数不可比」——最不该静默发生的一类。
 *
 * 结构检查不合格时回问模型（多轮修复）保留：修复只**修形状**，不改尺子——各项都取、缺一项失败、
 * 总分由权重加总这三条一个字都没动（`validateJudgeResponse` 就是 `parseJudgeResponse` 的判据本身，
 * 不存在「宽松版解析器」）。每一轮都留痕（`onProgress` → 该行事件日志）。
 *
 * 注意：本文件不碰工作区、不碰 git、不写 run.json；调用文本 API 的是 judgeRow，解析与收口是纯函数。
 */
import {
  JUDGE_OUTPUT_CONTRACT,
  ScoreResultSchema,
  ServiceError,
  composeTotalScore,
  renderRubricForJudge,
  rubricItemKeys,
  rubricMaxScore,
  type AgentKind,
  type Rubric,
  type RubricJudgment,
  type ScoreResult,
} from '@aieval/contracts';
import { callTextApiConversation, type ChatMessage, type TextRoute } from './text-api';

/** 解析失败时随错误一起保留的原文上限（字符）：够看清模型回了什么，又不至于把事件日志撑爆 */
export const RAW_KEEP_CHARS = 2_000;
/** 成功时写进 `ScoreResult.raw` 的上限：要能当「原始返回」展示，也要防模型跑飞写出几 MB */
const RAW_MAX_CHARS = 20_000;
/** 模型没给总评时的占位文案 */
const VERDICT_FALLBACK = '（模型未给出总评）';
/** 模型没给某一项理由时的占位文案 */
const REASON_FALLBACK = '（模型未给出理由）';
/**
 * 结构检查不合格后**回问模型的轮数上限**（不含首次回答）。
 * 2 轮 = 最多 3 次请求。新体系下这条机制更承重：漏一项 = 白送那一项的权重。
 */
export const JUDGE_REPAIR_ROUNDS = 2;

/** 解析失败一律 JUDGE_PARSE_FAILED：该行落 failed；raw 原文由 judgeRow 补进 context */
function parseFailed(message: string): ServiceError {
  return new ServiceError('JUDGE_PARSE_FAILED', message);
}

/**
 * 错误对象 → 可读原因。
 * 为什么 `export`：两条评分通路的错误折叠共用它，各写一份的坏处与尺子一样——漂移了没人看得出来。
 */
export function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 剥掉 markdown 围栏。
 * 只在「整段回答以 ``` 开头」时剥：中间夹散文的情况故意不救——契约要求只输出 JSON，
 * 从散文里抠 JSON 会把「模型没守契约」静默变成「成功」，而暴露它正是解析器的职责。
 */
function stripCodeFence(raw: string): string {
  const text = raw.trim();
  if (!text.startsWith('```')) return text;
  const fenced = /^```[a-zA-Z]*[ \t]*\r?\n?([\s\S]*?)```/.exec(text);
  return (fenced?.[1] ?? text).trim();
}

/**
 * `achieved` 的**宽容读**：接受布尔与它最常见的字符串写法（`"true"` / `"false"` / `"是"` / `"否"`）。
 * 为什么宽容：模型很爱把布尔写成字符串，而 schema 那一关只在**上游认了**的时候才拦得住
 * （网关不透传时形同虚设）；此处不宽容会让一次格式小毛病变成整行失败。
 * 认不出就返回 null（调用方按「这一项的判定不合法」处理）。
 */
function coerceAchieved(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return null;
  const text = value.trim().toLowerCase();
  if (text === 'true' || text === '是' || text === '达成') return true;
  if (text === 'false' || text === '否' || text === '未达成') return false;
  return null;
}

/** 理由：缺了就给占位文案，不让界面出现空白（理由是展示项，不是判据） */
function coerceReason(value: unknown): string {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : REASON_FALLBACK;
}

/**
 * 结构检查的**单一真源**：把模型的原文收成契约的逐项判定 + 总评。
 * 返回「合格 / 不合格 + 可直接展示的中文原因」，**不抛**——调用方要拿这条原因去回问模型，
 * 而异常是给「已经决定失败」的那条路用的。`parseJudgeResponse` 与 `validateJudgeResponse`
 * 都只是它的一层皮：**同一个判据**，不存在「宽松版解析器」这种第二把尺子。
 *
 * 四条口径：
 *   1. 不合法 JSON / 空内容 / 顶层不是对象 / 没有 judgments 数组 → 不合格；
 *   2. markdown 围栏先剥（只剥「整段以 ``` 开头」的），中间夹散文故意不救；
 *   3. 按评分表的引用键**逐个**取：缺一项不合格（点名引用键与目标）、多余判定忽略、
 *      重复引用键取第一条、`achieved` 宽容读、理由缺失给占位文案；
 *   4. 总评缺失给占位文案（总评不是判据）。
 */
function collectJudgeJudgments(
  raw: string,
  rubric: Rubric,
): { ok: true; parsed: { judgments: RubricJudgment[]; verdict: string } } | { ok: false; message: string } {
  const text = stripCodeFence(raw);
  if (text === '') return { ok: false, message: '评分模型返回了空内容' };

  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch (error) {
    return { ok: false, message: `评分模型返回的不是合法 JSON（${reason(error)}）` };
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return { ok: false, message: '评分模型返回的 JSON 顶层不是对象' };
  }

  const list = (payload as { judgments?: unknown }).judgments;
  if (!Array.isArray(list)) return { ok: false, message: '评分模型返回的 JSON 里没有 judgments 数组' };

  // 先按引用键归并：重复的键以第一条为准（模型偶尔会把同一项说两遍）
  const byId = new Map<string, Record<string, unknown>>();
  for (const item of list) {
    if (typeof item !== 'object' || item === null) continue;
    const record = item as Record<string, unknown>;
    const id = record.id;
    if (typeof id !== 'string' || byId.has(id)) continue;
    byId.set(id, record);
  }

  // 按评分表的引用键**逐个**取。刻意写成 for 循环而不是 map/filter：
  // 「缺一项就不合格」必须是**一行**可被变异验证的分支（把它改成 continue 就是那个缺陷本身）
  const keys = rubricItemKeys(rubric);
  const items = rubric.groups.flatMap((group) => group.items);
  const judgments: RubricJudgment[] = [];
  for (const [index, key] of keys.entries()) {
    const goal = items[index]?.goal ?? '';
    const found = byId.get(key);
    if (found === undefined) {
      return { ok: false, message: `缺少对 ${key}（${goal}）的判定：评分表里的每一项都必须恰好给出一条判定` };
    }
    const achieved = coerceAchieved(found.achieved);
    if (achieved === null) {
      return { ok: false, message: `${key}（${goal}）的 achieved 不是布尔值（收到 ${JSON.stringify(found.achieved) ?? 'undefined'}）` };
    }
    judgments.push({ id: key, achieved, reason: coerceReason(found.reason) });
  }

  const rawVerdict = (payload as { verdict?: unknown }).verdict;
  const verdict = typeof rawVerdict === 'string' && rawVerdict.trim() !== '' ? rawVerdict.trim() : VERDICT_FALLBACK;
  return { ok: true, parsed: { judgments, verdict } };
}

/** 结构检查的结果：合格带解析结果，不合格带**可直接写进纠错提示**的中文原因 */
export type JudgeValidation =
  | { ok: true; parsed: { judgments: RubricJudgment[]; verdict: string } }
  | { ok: false; message: string };

/** 结构检查（**不抛**）：模型的原文合不合契约。`judgeRow` 的修复循环靠它决定要不要再问一轮 */
export function validateJudgeResponse(raw: string, rubric: Rubric): JudgeValidation {
  return collectJudgeJudgments(raw, rubric);
}

/**
 * 解析评分模型的返回（纯函数）。**仍是抛异常的那一层皮**：判据全部来自 `collectJudgeJudgments`，
 * 这里只负责把「不合格」翻成 `JUDGE_PARSE_FAILED`。
 */
export function parseJudgeResponse(raw: string, rubric: Rubric): { judgments: RubricJudgment[]; verdict: string } {
  const checked = collectJudgeJudgments(raw, rubric);
  if (!checked.ok) throw parseFailed(checked.message);
  return checked.parsed;
}

/**
 * 把「已解析的判定 + 原文」收口成契约认可的 `ScoreResult`。
 * 为什么**必须**是一个函数：文本通路与智能体通路共用同一把尺子的全部口径——逐项取、缺一项失败在先、
 * 总分一律按权重加总、满分取评分表、raw 的截断上限、以及「形状漂移在这里就炸」的自检。
 *
 * `structuredOutput` 也走同一条口径（**必填**）：两条通路各自表一次态，而不是让收口函数吃一个
 * 「谁也没选过」的默认值。
 */
export function finalizeScore(input: {
  parsed: { judgments: RubricJudgment[]; verdict: string };
  /** 这一分用的评分表（**快照**：改了用例的评分表不该影响已有分数与它的满分） */
  rubric: Rubric;
  raw: string;
  judgeProviderId: string;
  judgeModelId: string;
  /** null ⇔ 走纯文本 API（见 contracts 的 ScoreResult.judgeAgentKind） */
  judgeAgentKind: AgentKind | null;
  /** 这一分是不是在 schema 约束下拿到的（必填；文本通路传 false） */
  structuredOutput: boolean;
}): ScoreResult {
  const result: ScoreResult = {
    judgments: [...input.parsed.judgments],
    // 总分一律按权重加总：模型根本不给总分，故这里不存在「采信 / 不采信」的取舍
    totalScore: composeTotalScore(input.rubric, input.parsed.judgments),
    // 满分取**快照**而不是当前用例：评分表改了之后，这一分与它自己的满分仍自洽
    maxScore: rubricMaxScore(input.rubric),
    verdict: input.parsed.verdict,
    raw: truncateRaw(input.raw, RAW_MAX_CHARS),
    judgeProviderId: input.judgeProviderId,
    judgeModelId: input.judgeModelId,
    judgeAgentKind: input.judgeAgentKind,
    structuredOutput: input.structuredOutput,
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

/**
 * 拼「你上一次的输出不合格」那一轮用户消息（**纯函数**，可单独断言）。
 * 三样缺一不可：点名具体原因、附上它自己的原文（截断）、**把评分表的引用键与目标再列一遍**
 * ——「缺项」这一类错误靠散文描述纠正不了，模型需要的是照抄一份清单。
 */
export function buildJudgeFeedback(input: { message: string; raw: string; rubric: Rubric }): string {
  const keys = rubricItemKeys(input.rubric);
  const items = input.rubric.groups.flatMap((group) => group.items);
  const fields = keys.map((key, index) => `   - ${key}：${items[index]?.goal ?? ''}（权重 ${items[index]?.weight ?? 0}）`).join('\n');
  return [
    '你上一次的输出没有通过结构检查，**不能**作为评分结果使用。',
    '',
    `具体问题：${input.message}`,
    '',
    '你上一次的输出是（可能被截断）：',
    '```',
    truncateRaw(input.raw, RAW_KEEP_CHARS),
    '```',
    '',
    '请重新给出**修正后**的评分结果。硬性要求：',
    '1. 只输出一个 JSON 对象：不要解释、不要道歉、不要 markdown 代码围栏、不要输出 JSON 以外的任何文字；',
    '2. judgments 必须**恰好**含下面这些引用键，一个都不能少、名字不能改、顺序照抄：',
    fields,
    '3. 每一项的 achieved 只能是 true 或 false（达成 / 未达成），reason 用一句中文说明；',
    '4. 顶部给出 verdict（一句话中文总评）；**不要**给总分。',
  ].join('\n');
}

/**
 * 一次结构修复的进度事件：由调用方（编排层）写进该行的日志抽屉。
 * 为什么必须有它：修复是**额外请求**，使用者在日志里必须能看到「为什么这一行多花了十几秒」。
 */
export interface JudgeProgress {
  /** 已经失败的轮次序号（第 1 次回答不合格 ⇒ 1） */
  round: number;
  /** 结构检查给出的中文原因 */
  message: string;
}

/**
 * 一次评分请求的全部输入。
 * `rubric` 是**这一轮的快照**（由编排层从 `run.rubric` 传入，不是从用例现取）：改了用例的评分表
 * 之后重评，用的仍应是当初那把尺子。
 */
export interface JudgeInput {
  rubric: Rubric;
  diffText: string;
  taskPrompt: string;
  route: TextRoute;
  judgeProviderId: string;
  /** 这一行的停止信号（可选：不传即「不可中止」） */
  signal?: AbortSignal;
  /** 结构修复的进度回调（可选；编排层把它接到该行的事件日志上） */
  onProgress?: (progress: JudgeProgress) => void;
  /** 「编排层开始了一次新的行尝试」的接缝（可选；生产代码里它是一个 no-op） */
  onAttemptStart?: () => void;
}

/**
 * 截断原文并留明确标记：要能区分「模型只说了这么多」与「我们截了」。
 * **两条评分通路共用**：截断标记一旦在某一侧漂移，另一侧的 `context.raw` 就会缺标记。
 */
export function truncateRaw(text: string, max = RAW_KEEP_CHARS): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…（原始返回共 ${text.length} 字符，此处截断）`;
}

/**
 * 拼评分请求：题面 → **评分标准项表格** → 待评的改动。
 * 为什么把改动放最后：长输入里尾部内容最不容易被忽略；空 diff 显式写「（无改动）」，
 * 否则模型会把「看不到改动」当成「没改」。
 */
function buildJudgePrompt(input: JudgeInput): string {
  const diff = input.diffText.trim() === '' ? '（无改动）' : input.diffText;
  return [
    '## 考题（候选拿到的任务）',
    input.taskPrompt,
    '',
    '## 评分标准项（逐项判定：达成给 true，未达成给 false）',
    renderRubricForJudge(input.rubric),
    '',
    '## 候选的代码改动',
    diff,
  ].join('\n');
}

/**
 * 跑一次评分：调用文本 API → **结构检查** → 不合格就把原因发回给模型再问一轮 → 收口（`finalizeScore`）。
 *
 * 失败面分三类，处置不同：
 *   - 调用失败（网络 / 鉴权 / 限流）→ **透传原错误码**（「没问到」与「答错了」是两回事）；
 *   - 结构检查不合格 → 回问模型，最多 `JUDGE_REPAIR_ROUNDS` 轮；仍不合格才折成 `JUDGE_PARSE_FAILED`，
 *     并把**最后一轮**的原文放进 `context.raw`；
 *   - 形状不合契约 → 由 `finalizeScore` 里的 `ScoreResultSchema` 兜住，并折成中文 `ServiceError`。
 */
export async function judgeRow(input: JudgeInput): Promise<ScoreResult> {
  const prompt = buildJudgePrompt(input);
  // system 用 contracts 的输出契约文本：生成侧与解析侧共用同一份字段名
  const system = JUDGE_OUTPUT_CONTRACT;
  const messages: ChatMessage[] = [{ role: 'user', content: prompt }];

  let raw: string;
  let parsed: { judgments: RubricJudgment[]; verdict: string };
  let repairs = 0;
  try {
    for (;;) {
      raw = await callTextApiConversation(input.route, {
        system,
        messages,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });

      const checked = validateJudgeResponse(raw, input.rubric);
      if (checked.ok) {
        parsed = checked.parsed;
        break;
      }
      if (repairs >= JUDGE_REPAIR_ROUNDS) {
        throw new ServiceError(
          'JUDGE_PARSE_FAILED',
          `评分解析失败：${checked.message}（结构检查已回问模型 ${repairs} 轮，仍未得到合格输出）`,
          { context: { raw: truncateRaw(raw), repairs, reason: checked.message } },
        );
      }

      repairs += 1;
      input.onProgress?.({ round: repairs, message: checked.message });
      messages.push({ role: 'assistant', content: raw });
      messages.push({ role: 'user', content: buildJudgeFeedback({ message: checked.message, raw, rubric: input.rubric }) });
    }
  } catch (error) {
    if (error instanceof ServiceError) throw error;
    throw new ServiceError('INTERNAL', `调用评分模型失败：${reason(error)}`, { cause: error });
  }

  return finalizeScore({
    parsed,
    rubric: input.rubric,
    raw,
    judgeProviderId: input.judgeProviderId,
    judgeModelId: input.route.modelId,
    judgeAgentKind: null,
    // 文本通路本期不开 schema：它有自己的回问机制
    structuredOutput: false,
  });
}
```

- [ ] **Step 4: 恢复 schema 的**值域**守卫（Task 1 延后项，见台账 minor (deferred)）**

Task 1 重写 `score.test.ts` 时删掉了旧的 `validateJsonSchema` 最小校验器与「合格样例过 schema / 越界被拒」那组用例；现行同形守卫只比字段**名**，于是 `JUDGE_OUTPUT_JSON_SCHEMA` 的**值域**约束无人守。在 `packages/server/contracts/src/score.test.ts` 末尾补回一个最小校验器（**仅测试用**，只实现本仓 schema 用到的关键字：`type` / `required` / `properties` / `additionalProperties` / `items`；遇到未实现的关键字**必须抛**，不许静默放过），并加断言：

- 根是 `type: 'object'`；`judgments` 是 `type: 'array'`；项内 `id` / `reason` 是 `type: 'string'`、`achieved` 是 `type: 'boolean'`；
- 一份合格的 `{ judgments: [{ id, achieved, reason }], verdict }` **能过**这个校验器（当前没有任何一条断言「合格样例能过」）；
- **登记本次重构已知的一处不对称**（与 `achieved` 的严档/宽档同一处置）：解析侧 `RubricJudgmentSchema.id` 是 `z.string().min(1)`（空串非法），而请求侧 `JUDGE_OUTPUT_JSON_SCHEMA` 的 `id` 只有 `type: 'string'`（无 `minLength`）——写一条用例把这个差异**钉住并写明理由**（请求侧拦住的是形状、解析侧拦住的是身份；两边各自的作用域不同），别让后人「顺手对齐」掉其中一侧。

- [ ] **Step 5: 跑 `judge.test.ts`，确认全绿**

Run: `corepack pnpm vitest run packages/server/evaluator/src/judge.test.ts`
Expected: PASS

- [ ] **Step 6: 改 `judge-agent.ts`（提示词换表格）**

在 `packages/server/evaluator/src/judge-agent.ts` 里做四处改动：

1. import：把 `JUDGE_OUTPUT_CONTRACT` 那一段补上 `renderRubricForJudge`、`type Rubric`，删掉 `type DimensionKey`。

2. `AgentJudgeInput` 里 `judgePrompt: string;` 与 `dimensions: readonly { key: DimensionKey; label: string }[];` 两行换成：

```ts
  /** 这一轮用的评分表（**快照**，由编排层从 `run.rubric` 传入） */
  rubric: Rubric;
```

3. `buildAgentJudgePrompt` 的签名与两段内容换成：

```ts
export function buildAgentJudgePrompt(input: {
  taskPrompt: string;
  rubric: Rubric;
  baselineCommit: string;
}): string {
  return [
    '你是一名资深代码评审专家。你要评的是下面这道考题的候选实现，评分依据是**工作区里的真实改动**。',
    '',
    '## 考题（候选拿到的任务）',
    input.taskPrompt,
    '',
    '## 评分标准项（逐项判定：达成给 true，未达成给 false）',
    renderRubricForJudge(input.rubric),
    '',
    '## 改动在哪、怎么看',
    `当前目录就是候选的工作区，改动相对基线 commit \`${input.baselineCommit}\`：`,
    `- 已跟踪文件的改动：\`git diff ${input.baselineCommit}\`；`,
    '- 新增但未跟踪的文件：`git status --porcelain` 里 `??` 的那些，自己按需读取；',
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
```

（「## 本用例的评分提示词」那一节**整段删除**——它已经不存在了。）

4. `judgeRowByAgent` 里 `buildAgentJudgePrompt({...})` 的调用与 `parseJudgeResponse(raw)` / `finalizeScore({...})` 三处：调用改成传 `rubric: input.rubric`；`parseJudgeResponse(raw, input.rubric)`；`finalizeScore` 多传 `rubric: input.rubric`。

- [ ] **Step 7: 改 `judge-agent.test.ts`**

把文件里所有 `dimensions: DIMENSIONS` 换成 `rubric: RUBRIC`，`judgePrompt: '按 5 个维度打分'` 删掉，`judgePrompt: 'j'` 删掉。在文件顶部加一份夹具与 import：

```ts
import { JUDGE_OUTPUT_CONTRACT, ServiceError, type AgentEvent, type Rubric } from '@aieval/contracts';

/** 评分表夹具：两项，满分 30 */
const RUBRIC: Rubric = {
  groups: [{ name: '一、生产代码', items: [{ id: 'A1', goal: '追加 agent 字段', weight: 20 }, { id: 'A2', goal: '补 Javadoc', weight: 10 }] }],
};
```

`'提示词带上基线 commit、只读要求与输出契约'` 这条的断言改成：`expect(prompt).toContain(RUBRIC.groups[0]!.name)`、`expect(prompt).toContain('A1')`、`expect(prompt).toContain('满分 30 分')`，并把「⑤ 题面与用例的评分提示词都要在」那两条换成 `expect(prompt).toContain('把 README 改成中文')`。

`'finalText 是合法评分 JSON 时出分'` 那条的 `finalText` 夹具与 `buildAgentJudgePrompt({...})` 的逐字相等断言同步改（模型回复改成 `judgments` 形状、`verdict`）。

- [ ] **Step 8: 改夹具（`fixtures.ts` 与 `orchestrator-harness.ts`）**

1. `packages/server/evaluator/src/testing/fixtures.ts`：
   - import 段：`DIMENSIONS` / `composeTotalScore` 换成 `type Rubric`；
   - 第 120 行附近的用例夹具 `judgePrompt: '按 5 个维度打分，只看代码改动',` 换成 `rubric: RUBRIC_FIXTURE,`（在同文件定义一份 `RUBRIC_FIXTURE`，两项满分 30）；
   - `makeScoreFixture` 整体换成：

```ts
/** 造一个合法的 ScoreResult（总分按 contracts 的 composeTotalScore 算，夹具里不另写一份公式） */
export function makeScoreFixture(
  achieved = true,
  judgeProviderId = 'judge-provider',
  judgeModelId = 'judge-model',
  judgeAgentKind: AgentKind | null = null,
): ScoreResult {
  const rubric = RUBRIC_FIXTURE;
  const keys = rubricItemKeys(rubric);
  const items = rubric.groups.flatMap((group) => group.items);
  const judgments = keys.map((key, index) => ({
    id: key,
    // 第二个参数改成布尔之后，`makeScoreFixture(false)` = 一项都没达成 = 0 分
    achieved,
    reason: `${items[index]?.goal ?? key}：假评分器给 ${achieved ? '达成' : '未达成'}`,
  }));
  return {
    judgments,
    totalScore: composeTotalScore(rubric, judgments),
    maxScore: rubricMaxScore(rubric),
    verdict: '假评分器的总评',
    raw: '{"fake":true}',
    judgeProviderId,
    judgeModelId,
    judgedAt: new Date().toISOString(),
    judgeAgentKind,
    structuredOutput: false,
  };
}
```

   > ⚠️ 注意：`makeScoreFixture` 的第一个参数语义从「分数」变成了「是否达成」。全仓有 4 个调用点
   > （`orchestrator-recover.test.ts:68`、`:175`、`orchestrator-live.test.ts:103`、`run-store.test.ts:241`），
   > 它们传的都是 4 或 5 —— 一律改成 `true`（含义是「全达成」）。`orchestrator-live.test.ts:103` 的
   > `makeScore(4, input.judgeProviderId, input.route.modelId)` 改成 `makeScore(true, input.judgeProviderId, input.route.modelId)`。

   - `fakeJudge` 里两处中文文案（`输入.onProgress?.({ round: 1, message: \`维度缺失：…\` })` 与它下面的 `ServiceError`）换成：

```ts
        input.onProgress?.({ round: 1, message: '缺少对 D1（补透传用例）的判定：评分表里的每一项都必须恰好给出一条判定' });
```

```ts
        throw new ServiceError('JUDGE_PARSE_FAILED', '评分解析失败：缺少对 D1（补透传用例）的判定', {
          context: { raw: '{"judgments":[]}' },
        });
```

2. `packages/server/evaluator/src/testing/orchestrator-harness.ts`：`:29` 的 `import { DIMENSIONS }` 改成 `type Rubric`（若不需要就删掉）；`:324` 那份用 `DIMENSIONS` 构造的分数夹具换成调用 `makeScoreFixture(...)`；`:456` 的再导出里去掉 `DIMENSIONS`。

- [ ] **Step 9: 跑 evaluator 包，把剩下的红逐个修到绿**

**先看这份实测清单**（控制方在 Task 2 期间对 `packages/server/evaluator/src` 全量 grep 的结果）——**9 个文件**会被本任务的判据变更波及，其中 4 个**只用了夹具**。按清单先改，别等跑出成片红再逐个查：

| 文件 | 引用点 | 怎么改 |
|---|---|---|
| `testing/fixtures.ts` | `:16` `DIMENSIONS` import、`:120` `judgePrompt: '按 5 个维度打分…'`、`:312-321` `makeScoreFixture` 用 `dimensions` + `composeTotalScore(number[])`、`:719`/`:723`/`:724` `fakeJudge` 的两处中文文案与 `raw` | 本任务 Step 8 已覆盖 |
| `testing/orchestrator-harness.ts` | `:29` `import { DIMENSIONS }`、`:324` 自建 `dimensions` 夹具、`:456` 的再导出里带 `DIMENSIONS` | 本任务 Step 8 已覆盖 |
| `judge.ts` / `judge-agent.ts` | 全部旧判据 | 本任务 Step 3 / Step 6 已覆盖 |
| `judge.test.ts` | 整个解析域 | 本任务 Step 1 已覆盖 |
| `judge-agent.test.ts` | `:28` 自建 `dimensions` 夹具、`:48`/`:65`/`:99`/`:259`/`:302` 的 `judgePrompt` / `dimensions` 入参、`:84` `finalText` 夹具 | 本任务 Step 7 已覆盖 |
| `orchestrator-recover.test.ts` | `:32` import、`:68`、`:175` `makeScoreFixture(5)` | **改 `makeScoreFixture(true)`**（首参语义从「分数」变成「是否达成」，`5` 是旧分数） |
| `orchestrator-live.test.ts` | `:100` 动态 import 重命名成 `makeScore`、`:103` `makeScore(4, providerId, modelId)` | **改 `makeScore(true, providerId, modelId)`**——`4` 是旧分数，当布尔用会被 TS 拒 |
| `run-store.test.ts` | `:16` import、`:241` `makeScoreFixture(4)` | **改 `makeScoreFixture(true)`** |
| `orchestrator-failure-modes.test.ts` | `:176` `expect(logText).toContain('{"dimensions":[]}')` | 改成新的 `raw` 文案（夹具里 `context.raw` 换了形状） |
| `orchestrator-judge-route.test.ts` | `:10` import `JUDGE_OUTPUT_JSON_SCHEMA`、`:168` 断言 `outputSchema` 等于它 | **不用改**——schema 换了形状但这行断言仍然成立（它断言的是「传下去的就是契约那一份」） |

`orchestrator-rescore.test.ts:232` 的 `'用例被删之后不能重评（题面与评分提示词没有快照进 run.json）'`：**用例名要改**（题面仍没快照，但评分表**有**快照了），改成 `'用例被删之后不能重评（题面没有快照进 run.json）'`，断言不变。

> **⚠️ 本表在实施期被证明不完整（2026-09-30，Task 3 实测）**：实跑发现该包 **22 文件 / 179 用例红**，本表漏了四类：
> 1. **`testing/fixtures.ts` 的 `makeRunFixture` 不返回 `rubric`**——Task 2 让 `EvalRun.rubric` 变必填后，`saveRun` 的写侧自检拒绝每一份快照 ⇒ **16 个 orchestrator 拆分文件 + `events.test.ts` + `run-store.test.ts` 全红**。修法是**加可选字段** `rubric?: Rubric`（默认一份夹具常量），不改任何既有调用点。
>    *教训*：波及分析要同时查「旧符号的引用」**和**「新必填字段的供给」——本表只做了前者。
> 2. **`orchestrator.ts` 的接线**（本属 Task 4 Step 3 第 2–4 项）：它仍在传已删除的 `DIMENSIONS` ⇒ 智能体通路走到 `renderRubricForJudge(undefined)` 而崩。**Task 3 的「本包全绿」在物理上要求先接线**，故控制方授权 Task 3 只做那三项。
> 3. **旧 5×4 量纲的数值期望**：`orchestrator-run-row.test.ts`（80→30）、`orchestrator-judge-route.test.ts`（100→30）、`orchestrator-rescore.test.ts`（80/60/100/40 → 30/0）、`orchestrator-recover.test.ts`、`orchestrator-judge-route-b.test.ts`。按新语义重算，**不要机械地把旧数字减半**——若某条断言的意图是「中等分数」，它现在必须表达成「部分项达成」。
> 4. **`orchestrator-auto-retry.test.ts` 的一条日志文案断言**（「维度缺失」→「缺少对 D1」），以及 `fakeJudge.score: number` → `fakeJudge.achieved: boolean`（二元判定没有「中间档」，留着数字旋钮会让用例静默断言旧语义）。
> **强制附带**：改完 grep 全包，确认没有残留读取旧旋钮（`.score` off `fakeJudge`、遗留的数字 `makeScoreFixture(<number>)`）——一个仍能通过类型检查的陈旧数值读取正是本次一路在猎的静默错配类缺陷。

Run: `corepack pnpm vitest run packages/server/evaluator`
Expected: 按上表改完之后全绿（实施期实测终态：**26 文件 / 235 用例全绿**）。注意 `text-api.test.ts:422`/`:431` 里的 `'{"dimensions":[]}'` 只是**对话内容字符串**，与评分契约无关，**不要动**。

- [ ] **Step 10: 变异验证（两条守卫）**

1. 把 `collectJudgeJudgments` 里缺项那一段的 `return { ok: false, ... }` 改成 `continue;` ⇒「缺任何一项都失败」必须红。
2. 把 `coerceAchieved` 的字符串分支删掉（只留 `typeof value === 'boolean'`）⇒「achieved 的宽容读」必须红。

- [ ] **Step 11: 提交**

```bash
git add packages/server/evaluator/src/judge.ts packages/server/evaluator/src/judge.test.ts packages/server/evaluator/src/judge-agent.ts packages/server/evaluator/src/judge-agent.test.ts packages/server/evaluator/src/testing/fixtures.ts packages/server/evaluator/src/testing/orchestrator-harness.ts packages/server/evaluator/src/orchestrator-judge-route.test.ts packages/server/evaluator/src/orchestrator-rescore.test.ts packages/server/evaluator/src/orchestrator-recover.test.ts packages/server/evaluator/src/orchestrator-live.test.ts packages/server/evaluator/src/run-store.test.ts packages/server/evaluator/src/orchestrator-failure-modes.test.ts
git commit -m "feat(evaluator): 两条评分通路换判据——按评分表逐项判定，缺一项即失败"
```

（`git add` 列表包含 Step 9 清单里**所有**被波及的文件——夹具首参语义变更会连带 4 个拆分测试文件，
逐个显式 `add` 是唯一能保证它们一起进这个提交的方式。）

---

### Task 4: 编排层 —— 读评分表快照 + 空表兜底

**Files:**
- Modify: `packages/server/evaluator/src/orchestrator.ts:410-495`（`runJudgeStage`）
- Modify: `packages/server/api/src/runs.ts:270-288`（`createRun` 的 `EvalRun` 字面量）
- Modify: `packages/server/api/src/runs.ts:626-632`（改评测换用例的那条路）

**Interfaces:**
- Consumes: Task 2 的 `EvalRun.rubric`；Task 3 的 `JudgeInput.rubric` / `AgentJudgeInput.rubric`
- Produces: `runJudgeStage` 读 `ctx.run.rubric`；空表行落 `failed` + 中文原因

- [ ] **Step 1: 写失败用例（空表兜底）**

在 `packages/server/evaluator/src/orchestrator-failure-modes.test.ts` 末尾追加一条用例（该文件已有 `createTempHome` 与三条 `vi.mock`）：

```ts
  /**
   * 兜底守卫：评分表为空（满分 0）时**不许**走到 `finalizeScore`。
   * 为什么需要它：`RubricSchema` 刻意不设 `.min(1)`（空表是新建用例的真实初态），
   * 而 API 直调可以写入一张空表（表单拦得住，HTTP 拦不住）。空表的 `maxScore` 是 0，
   * 而 `ScoreResultSchema.maxScore` 要求正数 ⇒ 放它进去会抛 `INTERNAL`（一条本不该发生的形状漂移），
   * 使用者看到的是一句「本不该发生」——而这明明是一个可以讲清楚的状态。
   */
  it('评分表为空的用例不评分：该行 failed + 中文原因，评分器一次都没被调用', async () => {
    const home = createTempHome();
    try {
      const testCase = makeCase({ rubric: { groups: [] } });
      seedConfig({ workspaceRoot: home.workspaceRoot, cases: [testCase] });
      const run = makeRun({ caseId: testCase.id, rubric: { groups: [] }, rows: [makeRow({ status: 'judged' })] });
      saveRun(run);
      resetFakeJudge();

      rescoreRow(run.id, run.rows[0]!.id);

      const row = getRun(run.id).rows[0]!;
      await until(() => getRun(run.id).rows[0]!.status === 'failed');
      expect(getRun(run.id).rows[0]!.error?.message).toContain('评分标准项');
      expect(fakeJudge.calls).toHaveLength(0);
      void row;
    } finally {
      home.cleanup();
    }
  });
```

> 实施时按该文件**已有**的用例形状调整（`until`、`makeCase`、`makeRun`、`makeRow` 的确切签名以文件内既有用法为准——本步骤的断言与意图不变）。

- [ ] **Step 2: 跑它，确认失败**

Run: `corepack pnpm vitest run packages/server/evaluator/src/orchestrator-failure-modes.test.ts`
Expected: FAIL（空表走到了 `finalizeScore`，拿到 `INTERNAL` 而不是那句中文原因）

- [ ] **Step 3: 改 `runJudgeStage`**

`packages/server/evaluator/src/orchestrator.ts` 的 `runJudgeStage` 里：

1. 函数开头（`setRowStatus(ctx.runId, ctx.rowId, 'judging')` 之后、`resolveJudgeRoute()` 之前）插入空表守卫：

```ts
  // 兜底守卫：评分表为空（满分 0）时这一行**没法评**。`RubricSchema` 刻意不设 `.min(1)`
  // （空表是新建用例的真实初态），而 API 直调可以写入一张空表——表单拦得住，HTTP 拦不住。
  // 放它走下去的话 `maxScore` 会是 0，而契约要求它为正，于是抛出一句「本不该发生」的 INTERNAL；
  // 这里把它变成一个能讲清楚的状态，且**评分器一次都不调用**（没有表就没有判定依据）。
  if (rubricMaxScore(ctx.run.rubric) <= 0) {
    throw new ServiceError('CONFLICT', '这个用例的评分标准项是空的，无法评分：请先在用例里补上至少一个评分项');
  }
```

（import 补 `rubricMaxScore`；`ServiceError` 若未 import 也补上。）

2. 文本通路那一支：把 `judgePrompt: ctx.testCase.judgePrompt,` 与 `dimensions: DIMENSIONS,` 两行换成 `rubric: ctx.run.rubric,`。

3. 智能体通路那一支：同样把 `judgePrompt: ctx.testCase.judgePrompt,` 与 `dimensions: DIMENSIONS,` 换成 `rubric: ctx.run.rubric,`。

4. import 段删掉 `DIMENSIONS`（如果没有别的用处）。

> **⚠️ 第 2–4 项可能已经由 Task 3 完成（实施期事实，2026-09-30）**：Task 3 开工前发现
> `orchestrator.ts:425/:428`（文本通路）与 `:485/:487`（智能体通路）仍在使用已删除的 `DIMENSIONS`
> ⇒ 智能体通路会走到 `renderRubricForJudge(undefined)` 而崩，**Task 3 的「evaluator 包全绿」在物理上
> 要求先接线**。控制方已授权 Task 3 只做这三项（第 2–4 项），并明确禁止它顺手做本任务的第 1 项
> （空表守卫）与 Step 4（`api/runs.ts` 的快照）。
> **执行本任务时先看现状**：若 `runJudgeStage` 的两支已经传 `rubric: ctx.run.rubric`、且 `DIMENSIONS`
> 已从 import 里删掉，则第 2–4 项是 no-op，**只做第 1 项空表守卫 + Step 4**；不要因为它们已存在就跳过
> 本步的其他内容。
> 同一期间还修掉了 Task 2 的一处漏改（`evaluator/src/testing/fixtures.ts` 的 `makeRunFixture` 缺
> 必填的 `EvalRun.rubric` ⇒ `saveRun` 拒绝 ⇒ 16 个 orchestrator 拆分文件全红）；它在 Task 3 内以
> **加可选字段**的方式修掉，本任务不需要再动夹具。

- [ ] **Step 4: 在 `createRun` 里写入快照**

`packages/server/api/src/runs.ts` 的 `createRun` 里，`EvalRun` 字面量的 `repoBranch` 之后插入：

```ts
    // 与 caseTitle / repoPath 同一套冗余快照：这一轮用的是哪张评分表。
    // 评分阶段读的是它而不是 testCase.rubric——改了用例的评分表之后，历史记录与「重新评分」仍按当初那把尺子
    rubric: testCase.rubric,
```

改评测换用例的那条路（`runs.ts:626-632`）**不能只补一行**（实施期修正，2026-09-30）：那个对象是 `RunTargetCase`（5 个必填字段），多给一个 `rubric:` 会 TS2353。要真正把快照换过去，必须：

1. `RunTargetCase` 加**必填** `rubric: Rubric`，并用 JSDoc 写明那条不变式：*换用例时重取、`caseId` 没变时逐字保留——「改了用例的评分表不许改写历史」在换用例这条路上同样成立，而换过去的那张表必须跟着走（否则新用例的行会拿旧用例的尺子评分）*；
2. `planRunUpdate` 的 `caseChanged` 分支写 `rubric: target.rubric`；
3. 注释里的「五格」改「六格」；
4. `packages/api/src/runs.test.ts` 里三处 `RunTargetCase` 字面量跟着补该字段（**因此 Step 8 的 `git add` 要多这一个文件**），并补两条守卫：**换用例 ⇒ `next.rubric` 跟着换**、**没换用例 ⇒ `caseSnapshotOf` 里 rubric 逐字保留**。

> **为什么第 4 条的两条守卫是必须的**：只改 `createRun` 的话，「编辑一轮评测去换用例」会让新用例的行拿着**旧用例的评分表**打分——
> 分数照样出得来、界面照样正常，而尺子是错的。这正是本次重构要消灭的那类静默错配，所以这条路上必须有守卫见过它红。

- [ ] **Step 5: 跑 api 与 evaluator 两个包**

Run: `corepack pnpm vitest run packages/server/evaluator packages/server/api`
Expected: **evaluator 全绿；`api/src/runs.test.ts` 全绿**。api 包**其余失败必须与改动前基线完全相同**（实测基线：`5 failed | 7 passed` 文件、`45 failed | 191 passed` 用例，5 个红文件全属 Task 5 的清单——`judge.test.ts` / `cases-crud.test.ts` / `cases-update.test.ts` / `cases-crud-b.test.ts` / `cases-remote-save.test.ts`），且**不新增任何红**。
> **不要为了让 api 全绿而提前做 Task 5 的活**：那会与 Task 5 自己的评审面撞车。本步的可测判据是「基线不恶化」，不是「api 全绿」。

- [ ] **Step 6: 变异验证**

把空表守卫那个 `if` 整段删掉 ⇒ Step 1 的用例必须红（错误信息变成「本不该发生」的 INTERNAL）。

- [ ] **Step 7: 清掉「评分提示词」这个已删除概念的残留文案（Task 3 评审 Minor 2 路由至此）**

评分提示词（一段自由文本）已被评分表取代，但**生产代码里还有几处指着它**。其中一条**不是注释问题、是给用户的错误排障方向**，必须改：

| 位置 | 现状 | 改成 |
|---|---|---|
| `packages/server/evaluator/src/judge-agent.ts:214` | 用户可见的失败提示写「**请检查评分提示词**，或在设置页换一家评分智能体」 | 「请检查这个用例的**评分标准项**，或在设置页换一家评分智能体」——那个字段在界面上已经不存在了，照原样说会把用户指向一个找不到的地方 |
| `packages/server/evaluator/src/judge-agent.ts:4` | 文件头仍说文本通路送「评分提示词 + …维度定义」 | 改成「评分标准项表格 + diff」 |
| `packages/server/evaluator/src/orchestrator.ts:974` / `:1484` / `:1643` / `:1819` | 注释说「题面与评分提示词没有快照进 run.json（§7.2 只冗余了 caseTitle / repoPath / commitHash）」 | **评分表已经快照了**（`EvalRunSchema.rubric`，见 `run.ts`）——把句子里「（评分表/评分提示词）没有快照」这半截改对，只说**题面**没有快照。其余关于「用例被删后不能重评」的论证**不变**（那仍然成立） |

> **为什么这几处值得一个显式步骤**：`judge-agent.ts:214` 是**面向用户**的文案，一句话就能把人引到错误的排查方向；
> 而 `orchestrator.ts` 那四处注释是「为什么这条守卫存在」的论据——论据里引用了错误的快照事实，会让后人以为评分表也没快照，
> 从而在别处做出错误的判断（比如以为改了用例的评分表会影响历史记录）。
> **只改文案，不改任何逻辑与断言**；若发现某处改动会牵动行为，停下报告。

**实施期补充（2026-09-30，Task 4 实测）——上表原先漏了 6 处**，实现者按要求只改表内行、把表外的留着待路由；控制方复核后**一并路由进本步**（同类、便宜，留着只会让最终评审再提一次并为 6 条注释再付一次派单）：

| 位置 | 改成 |
|---|---|
| `packages/server/evaluator/src/judge-agent.ts:95` / `:205` | 同上面第一行的口径；**`:205` 若对用户可见且在让人去检查一个已不存在的字段，按第一行那样改** |
| `packages/server/evaluator/src/text-api.ts:2` | 文件头说这条路供「AI 生成评分提示词」用 ⇒ 改成「AI 生成评分标准项」 |
| `packages/server/evaluator/src/judge-route.test.ts:264`、`packages/server/evaluator/src/testing/fixtures.ts:393`、`packages/server/evaluator/src/orchestrator-rescore.test.ts:154` | 仅改文案，**断言一律不动** |

- [ ] **Step 8: 提交**

```bash
git add packages/server/evaluator/src/orchestrator.ts packages/server/evaluator/src/orchestrator-failure-modes.test.ts packages/server/evaluator/src/judge-agent.ts packages/server/evaluator/src/text-api.ts packages/server/evaluator/src/judge-route.test.ts packages/server/evaluator/src/testing/fixtures.ts packages/server/evaluator/src/orchestrator-rescore.test.ts packages/server/api/src/runs.ts packages/server/api/src/runs.test.ts
git commit -m "feat(evaluator,api): 评分阶段读评分表快照 + 空表兜底守卫；清掉已删除概念的残留文案"
```

（`git add` 列表含 Step 7 两张表涉及的**全部**文件——表述里那句「只改文案」最容易漏掉的就是测试文件里的一行注释，而漏 add 会让它留成未提交改动、被后续任务误以为是别人的改动。）

---

### Task 5: api —— 生成 / 识别两个分支与合并算法

**Files:**
- Modify: `packages/server/api/src/judge.ts`（重写）
- Modify: `packages/server/api/src/judge.test.ts`（重写）
- Modify: `packages/server/api/src/cases.ts`（`assertStorable` 加 `validateRubric`；`createCase` / `updateCase` 的 `judgePrompt` → `rubric`）
- Modify: `packages/server/api/src/index.ts`（出口改名）
- Modify: `packages/server/api/src/testing/run-fixtures.ts:47`、`packages/server/api/src/testing/cases-harness.ts:186,226`
- Modify: `packages/server/api/src/cases-update.test.ts:54`
- Modify: `apps/web-next/app/api/cases/generate-judge-prompt/route.ts`

**Interfaces:**
- Consumes: Task 2 的 `GenerateRubricSchema` / `GenerateRubricInput`；Task 1 的 `Rubric` / `validateRubric` / `renderRubricForJudge`
- Produces：
  - `generateRubric(input: GenerateRubricInput): Promise<GenerateRubricResult>`
  - `GenerateRubricResult = { rubric: Rubric; addedItems: number; note?: string }`
  - `mergeRubric(current: Rubric, added: Rubric): { rubric: Rubric; addedItems: number }`（**导出以便单测**）

- [ ] **Step 1: 写失败用例（合并算法 + 两个分支）**

用下面这份内容**整体替换** `packages/server/api/src/judge.test.ts`：

```ts
// @vitest-environment node
/**
 * 生成评分标准项：两个分支（智能生成 / 智能识别）、合并算法，以及「生成是只读操作」。
 *
 * 上游文本调用被整模块替身（只替换 callTextApi，其余导出原样透传）。
 * 两条**绊线**保留（与上一版同口径）：
 *   - `vi.stubGlobal('fetch', …)`：预校验的顺序一旦被改坏（先调模型、后校验仓库），真 `callTextApi`
 *     就会跑起来——有它可以保证本机离线也稳定失败；
 *   - `node:fs.writeFileSync` 探针：「只读」若只比较 config.json 的字节，看不见
 *     `saveConfig(loadConfig())` 这种**原样重写**（往返逐字节等价）。
 */
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync as readFileRaw, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ServiceError, renderRubricForJudge, type Provider, type Rubric } from '@aieval/contracts';
import { getConfigDir, loadConfig, saveConfig, setConfigDirForTesting } from '@aieval/core';
import { callTextApi } from '@aieval/evaluator';
import { generateRubric, mergeRubric, resolveJudgeRoute as resolveJudgeRouteFromApi } from './judge';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, writeFileSync: vi.fn(actual.writeFileSync) };
});

vi.mock('@aieval/evaluator', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aieval/evaluator')>();
  return { ...actual, callTextApi: vi.fn() };
});

let dir: string;
let repo: string;
let fixtureRepo: string;

beforeAll(() => {
  fixtureRepo = mkdtempSync(join(tmpdir(), 'aieval-judge-fixture-'));
  execFileSync('git', ['init', '-q'], { cwd: fixtureRepo });
  writeFileSync(join(fixtureRepo, 'README.md'), '# gateway\n', 'utf8');
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e.com', 'add', '.'], { cwd: fixtureRepo });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e.com', 'commit', '-q', '-m', 'init'], { cwd: fixtureRepo });
});

afterAll(() => {
  rmSync(fixtureRepo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aieval-judge-'));
  setConfigDirForTesting(dir);
  vi.stubGlobal('fetch', () => {
    throw new Error('测试不得发网络请求：callTextApi 应当仍是替身');
  });
  repo = join(dir, 'gateway');
  mkdirSync(repo, { recursive: true });
  cpSync(fixtureRepo, repo, { recursive: true });
  vi.mocked(callTextApi).mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  setConfigDirForTesting(null);
  rmSync(dir, { recursive: true, force: true, maxRetries: 40, retryDelay: 100 });
});

const PROVIDER: Provider = {
  id: 'provider-1',
  name: 'DeepSeek 官方',
  protocolType: 'openai',
  baseUrl: 'https://api.deepseek.com/v1',
  apiKey: 'sk-test',
  models: [{ id: 'deepseek-chat', source: 'manual' }],
  createdAt: '2026-09-22T10:00:00.000Z',
  updatedAt: '2026-09-22T10:00:00.000Z',
};

function configureGlobalJudge(): void {
  saveConfig({
    ...loadConfig(),
    providers: [PROVIDER],
    settings: { ...loadConfig().settings, defaultJudge: { providerId: PROVIDER.id, modelId: 'deepseek-chat' } },
  });
}

function modelReplies(text: string): void {
  vi.mocked(callTextApi).mockResolvedValue(text);
}

/** 当前表格：一组一项（A1 / 18 分），用于「智能生成」的输入 */
function currentRubric(): Rubric {
  return { groups: [{ name: '一、生产代码', items: [{ id: 'A1', goal: '追加 agent 字段', weight: 18 }] }] };
}

/** 用户粘贴的评分要求（与 spec 的示例同形） */
const USER_PROMPT = [
  '评估代码开发质量，满分 100 分。',
  '',
  '## 一、生产代码 48 分',
  '',
  '| ID | 评分项 | 目标 | 权重 |',
  '| --- | --- | --- | --- |',
  '| A1 | `FileChangeLogItemDTO` 追加 `agent` 字段 | 让 `agent` 进入对外契约 | **18** |',
  '| B1 | `GitCommitServiceImpl.toDTO()` 补 `m.agent()` | 让 ES 数据真正流到响应 | **20** |',
  '',
  '## 二、测试 52 分',
  '',
  '| ID | 评分项 | 目标 | 权重 |',
  '| --- | --- | --- | --- |',
  '| D1 | `GitCommitServiceImplTest` 新增「有值透传」用例 | 锁死映射不丢字段 | **14** |',
].join('\n');

describe('mergeRubric：按组名归位', () => {
  it('同名组的新项追加到该组末尾；新组名按模型给的顺序追加到表尾', () => {
    const current = currentRubric();
    const added: Rubric = {
      groups: [
        { name: '一、生产代码', items: [{ id: 'A2', goal: '补 Javadoc', weight: 4 }] },
        { name: '二、测试', items: [{ id: 'D1', goal: '补透传用例', weight: 14 }] },
      ],
    };
    const merged = mergeRubric(current, added);
    expect(merged.addedItems).toBe(2);
    expect(merged.rubric.groups.map((group) => group.name)).toEqual(['一、生产代码', '二、测试']);
    expect(merged.rubric.groups[0]?.items.map((item) => item.id)).toEqual(['A1', 'A2']);
  });

  it('模型返回空 groups ⇒ 原表原样返回、新增 0 项（允许它说「已经完备」）', () => {
    const current = currentRubric();
    const merged = mergeRubric(current, { groups: [] });
    expect(merged).toEqual({ rubric: current, addedItems: 0 });
  });

  it('新增项的 id 与已有 id 冲突 ⇒ JUDGE_PARSE_FAILED（模型违约，不是我们的形状漂移）', () => {
    const added: Rubric = { groups: [{ name: '一、生产代码', items: [{ id: 'A1', goal: '重复', weight: 5 }] }] };
    expect(() => mergeRubric(currentRubric(), added)).toThrow(ServiceError);
    expect(() => mergeRubric(currentRubric(), added)).toThrow(/A1/);
  });

  it('合并结果本身必须过 validateRubric（权重非正的新项被拒）', () => {
    const added = { groups: [{ name: 'x', items: [{ id: 'B', goal: 'g', weight: 0 }] }] } as unknown as Rubric;
    expect(() => mergeRubric(currentRubric(), added)).toThrow(ServiceError);
  });
});

describe('generateRubric：智能生成分支（prompt 为空）', () => {
  it('把当前表格与已有 ID 清单送进提示词，并返回合并后的完整表格', async () => {
    configureGlobalJudge();
    modelReplies(JSON.stringify({ groups: [{ name: '二、测试', items: [{ id: 'D1', goal: '补透传用例', weight: 14 }] }] }));

    const result = await generateRubric({ rubric: currentRubric(), taskPrompt: '为网关补一条回归', prompt: '', repoPath: repo });

    const [, request] = vi.mocked(callTextApi).mock.calls[0]!;
    expect(request.prompt).toContain('为网关补一条回归');
    expect(request.prompt).toContain('gateway');
    // 当前表格与已有 ID 清单都要在：AI 必须知道已有什么才能只增不改
    expect(request.prompt).toContain('追加 agent 字段');
    expect(request.prompt).toContain('A1');
    expect(result.addedItems).toBe(1);
    expect(result.rubric.groups.map((group) => group.name)).toEqual(['一、生产代码', '二、测试']);
  });

  it('模型返回空 groups ⇒ 原表不变，并给出「未新增条目」的说明', async () => {
    configureGlobalJudge();
    modelReplies(JSON.stringify({ groups: [] }));
    const result = await generateRubric({ rubric: currentRubric(), taskPrompt: 't', prompt: '', repoPath: repo });
    expect(result.addedItems).toBe(0);
    expect(result.note).toContain('未新增');
    expect(result.rubric).toEqual(currentRubric());
  });

  it('仓库路径无效时抛 NOT_A_GIT_REPO（而不是先花掉一次模型调用）', async () => {
    configureGlobalJudge();
    const notRepo = join(dir, 'plain-dir');
    mkdirSync(notRepo, { recursive: true });
    await expect(generateRubric({ rubric: currentRubric(), taskPrompt: 't', prompt: '', repoPath: notRepo })).rejects.toThrow(
      /不是 git 仓库|NOT_A_GIT_REPO/,
    );
    expect(callTextApi).not.toHaveBeenCalled();
  });
});

describe('generateRubric：智能识别分支（prompt 非空）', () => {
  /**
   * 这条路**不碰仓库**（spec D10）：用户粘进来的那段文本里已经有全部信息。
   * 于是 `repoPath` 为空也必须成功——「填了提示词却因为仓库路径没填而识别不了」这个组合被这条规则消灭。
   */
  it('repoPath 为空也能识别成功，且不调用仓库解析', async () => {
    configureGlobalJudge();
    modelReplies(
      JSON.stringify({
        groups: [
          { name: '一、生产代码', items: [{ id: 'A1', goal: '让 agent 进入对外契约', weight: 18 }, { id: 'B1', goal: '让 ES 数据流到响应', weight: 20 }] },
          { name: '二、测试', items: [{ id: 'D1', goal: '锁死映射不丢字段', weight: 14 }] },
        ],
      }),
    );

    const result = await generateRubric({ rubric: { groups: [] }, taskPrompt: '', prompt: USER_PROMPT, repoPath: '' });

    expect(result.rubric.groups).toHaveLength(2);
    expect(result.rubric.groups[0]?.items.map((item) => item.weight)).toEqual([18, 20]);
    expect(result.addedItems).toBe(0);
    // 用户原文必须原样进提示词（并要求原样抽取）
    const [, request] = vi.mocked(callTextApi).mock.calls[0]!;
    expect(request.prompt).toContain('评估代码开发质量');
    expect(request.prompt).toContain('原样');
  });

  it('识别分支不带仓库名进提示词（不解析 repoPath）', async () => {
    configureGlobalJudge();
    modelReplies(JSON.stringify({ groups: [{ name: 'g', items: [{ id: 'A', goal: 'a', weight: 1 }] }] }));
    await generateRubric({ rubric: { groups: [] }, taskPrompt: '', prompt: USER_PROMPT, repoPath: 'git@host:group/never-touched.git' });
    const [, request] = vi.mocked(callTextApi).mock.calls[0]!;
    expect(request.prompt).not.toContain('never-touched');
  });
});

describe('generateRubric：失败面与只读', () => {
  it('未配置评分模型时抛 CONFLICT（指向设置页），且不产生任何上游调用', async () => {
    const error = await generateRubric({ rubric: currentRubric(), taskPrompt: 't', prompt: '', repoPath: repo }).catch((caught: unknown) => caught);
    expect((error as ServiceError).code).toBe('CONFLICT');
    expect(callTextApi).not.toHaveBeenCalled();
  });

  it('模型返回非法 JSON / 形状不合契约的表格 → JUDGE_PARSE_FAILED 且 message 可直接展示', async () => {
    configureGlobalJudge();
    modelReplies('这段代码改得不错。');
    await expect(generateRubric({ rubric: currentRubric(), taskPrompt: 't', prompt: USER_PROMPT, repoPath: '' })).rejects.toThrow(
      /不是合法 JSON/,
    );

    modelReplies(JSON.stringify({ groups: [{ name: 'g', items: [{ id: 'A', goal: 'a', weight: 0 }] }] }));
    await expect(generateRubric({ rubric: currentRubric(), taskPrompt: 't', prompt: USER_PROMPT, repoPath: '' })).rejects.toThrow(
      /权重/,
    );
  });

  it('生成成功不改配置文件（前后逐字节一致，且全程没有写盘调用）', async () => {
    configureGlobalJudge();
    const configFile = join(getConfigDir(), 'config.json');
    const before = readFileRaw(configFile, 'utf8');
    modelReplies(JSON.stringify({ groups: [{ name: '二、测试', items: [{ id: 'D1', goal: 'g', weight: 1 }] }] }));
    vi.mocked(writeFileSync).mockClear();

    await generateRubric({ rubric: currentRubric(), taskPrompt: 't', prompt: '', repoPath: repo });

    expect(readFileRaw(configFile, 'utf8')).toBe(before);
    expect(writeFileSync).not.toHaveBeenCalled();
  });

  it('生成失败同样不改配置文件', async () => {
    configureGlobalJudge();
    const configFile = join(getConfigDir(), 'config.json');
    const before = readFileRaw(configFile, 'utf8');
    modelReplies('不是 JSON');
    vi.mocked(writeFileSync).mockClear();
    await expect(generateRubric({ rubric: currentRubric(), taskPrompt: 't', prompt: '', repoPath: repo })).rejects.toBeInstanceOf(ServiceError);
    expect(readFileRaw(configFile, 'utf8')).toBe(before);
    expect(writeFileSync).not.toHaveBeenCalled();
  });
});

describe('只用全局默认评分模型（D14）', () => {
  it('api 导出的 resolveJudgeRoute 与 evaluator 是同一个函数（转出而不是重新实现）', () => {
    expect(resolveJudgeRouteFromApi).toBe(await import('@aieval/evaluator').then((module) => module.resolveJudgeRoute));
  });

  it('两个分支的路由都等于全局默认那一把尺子（入参里没有模型，故换不掉）', async () => {
    configureGlobalJudge();
    modelReplies(JSON.stringify({ groups: [] }));
    await generateRubric({ rubric: currentRubric(), taskPrompt: 't', prompt: '', repoPath: repo });
    const [route] = vi.mocked(callTextApi).mock.calls[0]!;
    expect(route.modelId).toBe('deepseek-chat');
    expect(route.baseUrl).toBe(PROVIDER.baseUrl);
  });
});
```

- [ ] **Step 2: 跑它，确认失败**

Run: `corepack pnpm vitest run packages/server/api/src/judge.test.ts`
Expected: FAIL（`generateRubric` / `mergeRubric` 还不存在）

- [ ] **Step 3: 重写 `api/src/judge.ts`**

用下面这份内容**整体替换** `packages/server/api/src/judge.ts`：

```ts
/**
 * 评分标准项的生成与识别（两个动作共用一个入口）。
 *
 * 三条必须守住的口径：
 *   1. **只读**：本模块不写任何落盘内容。失败时调用方手里已有的表格与文本必须原样保留
 *      ——失败只抛可展示的中文错误，绝不顺手改配置或清空状态；
 *   2. **只用设置页的全局默认评分模型**（`resolveJudgeRoute()`，**无参**）：这里**没有**智能体通路，
 *      也不接受任何模型 id 入参——入参里带一对 id 就等于让调用方能绕开设置页那一格；
 *   3. **两个分支的差别只有输入**：
 *      · `prompt` 为空 ⇒ 「智能生成」：校验仓库（取仓库名）→ 解析路由 → 调模型 → **合并**；
 *      · `prompt` 非空 ⇒ 「智能识别」：**不碰仓库**（那段文本里已有全部信息）→ 解析路由 → 调模型 → 整表替换。
 *      两分支都是**非流式**文本调用，都不落盘。
 */
import {
  RubricSchema,
  ServiceError,
  parseRepoSource,
  renderRubricForJudge,
  rubricItemKeys,
  validateRubric,
  type GenerateRubricInput,
  type Rubric,
} from '@aieval/contracts';
import { resolveRepoInfo } from '@aieval/core';
import { callTextApi, resolveJudgeRoute } from '@aieval/evaluator';

/** 转出评分模型路由解析：HTTP 层要用它做「未配置评分模型」的即时报错（契约 §6） */
export { resolveJudgeRoute } from '@aieval/evaluator';

/** 原文片段保留长度：够定位问题，又不会把几百 KB 的回复塞进错误响应 */
const RAW_EXCERPT_LENGTH = 500;

/** 生成结果：`rubric` 回填表格；`addedItems` 给界面文案用；`note` 只在需要解释时出现 */
export interface GenerateRubricResult {
  rubric: Rubric;
  addedItems: number;
  note?: string;
}

/**
 * 生成 / 识别评分标准项（非流式）。
 * 顺序有意如此：**识别分支先解析路由**，**生成分支先校验仓库再解析路由**——
 * 前面两步失败时一次模型调用都不该花掉（限额是真的钱）。
 */
export async function generateRubric(input: GenerateRubricInput): Promise<GenerateRubricResult> {
  const recognizing = input.prompt.trim() !== '';
  // 未配置评分模型时这里抛 CONFLICT，message 指向设置页（不下传任何模型 id：这一次走哪把尺子只有一个来源）
  const route = resolveJudgeRoute();

  if (recognizing) {
    const raw = await callTextApi(route, {
      system: buildSystemPrompt('识别'),
      prompt: buildRecognizePrompt({ userPrompt: input.prompt, taskPrompt: input.taskPrompt, current: input.rubric }),
    });
    const parsed = parseGenerated(raw);
    return { rubric: parsed, addedItems: 0 };
  }

  // ── 智能生成：先校验仓库（顺带把「路径早就不可用」挡在模型调用之前），再调模型，最后合并 ──
  const source = parseRepoSource(input.repoPath);
  const repoName = source.kind === 'local' ? resolveRepoInfo(source.path).repoName : source.repoName;
  const raw = await callTextApi(route, {
    system: buildSystemPrompt('生成'),
    prompt: buildGeneratePrompt({ current: input.rubric, taskPrompt: input.taskPrompt, repoName }),
  });
  const added = parseGenerated(raw);
  const merged = mergeRubric(input.rubric, added);
  return {
    rubric: merged.rubric,
    addedItems: merged.addedItems,
    ...(merged.addedItems === 0 ? { note: '当前评分标准项已覆盖本题，未新增条目' } : {}),
  };
}

/** 系统提示词：只约束「怎么回」，业务约束全在用户提示词与输出契约里 */
function buildSystemPrompt(mode: '生成' | '识别'): string {
  return [
    '你是一名资深代码评审专家，负责为「AI 生成代码评测」撰写**评分标准项**。',
    mode === '生成'
      ? '你会拿到一份**已有的**评分标准项表格：你的任务是**只补充缺的条目**，不要重复已有的条目。'
      : '用户会给你一段他自己的评分要求：你的任务是把它**原样抽取**成结构化表格。',
    '评分模型只会看到候选的代码改动（diff），看不到任何对话过程，也看不到原始仓库。',
    '你的回复必须是一个 JSON 对象，不要输出解释、不要使用 markdown 代码围栏。',
  ].join('\n');
}

/**
 * 生成分支的用户提示词：仓库名 + 题面 + **当前表格（含已有 ID 清单）** + 输出契约 + 四条硬约束。
 * 为什么必须回显当前表格：AI 要能**只增不改**，它必须先知道已有什么。
 */
function buildGeneratePrompt(context: { current: Rubric; taskPrompt: string; repoName: string }): string {
  const keys = rubricItemKeys(context.current);
  const existing = context.current.groups.length === 0
    ? '（当前表格是空的，请从零起草）'
    : renderRubricForJudge(context.current);
  return [
    `【仓库】${context.repoName}`,
    `【考题提示词】\n${context.taskPrompt}`,
    `【已有的评分标准项】\n${existing}`,
    `【已被占用的 ID】${keys.length === 0 ? '（无）' : keys.join('、')}`,
    `【输出契约】\n${GENERATE_OUTPUT_CONTRACT}`,
    [
      '【你的任务】',
      '只补充**当前表格里还没有的**条目，放进 JSON 的 groups 字段；',
      '硬性要求：',
      '1. **只新增**：已存在的条目一条都不许重复、不许改写、不许删除；',
      '2. **禁止复用上面【已被占用的 ID】里的任何 ID**；',
      '3. 同一个主题要**复用已有的组名**（例如给「二、测试」补条目就写 name: "二、测试"），新主题才用新组名；',
      '4. 如果当前表格已经足够覆盖这道考题，groups 返回**空数组**——不要为了凑数硬加条目。',
    ].join('\n'),
  ].join('\n\n');
}

/** 识别分支的用户提示词：用户原文（逐字放入）+ 可选题面 + 输出契约 + 三条硬约束 */
function buildRecognizePrompt(context: { userPrompt: string; taskPrompt: string; current: Rubric }): string {
  return [
    context.taskPrompt.trim() === '' ? '' : `【考题提示词（供你理解上下文）】\n${context.taskPrompt}`,
    `【用户给出的评分要求（原样）】\n${context.userPrompt}`,
    `【输出契约】\n${GENERATE_OUTPUT_CONTRACT}`,
    [
      '【你的任务】',
      '把上面这段评分要求**原样抽取**成结构化表格，放进 JSON 的 groups 字段；',
      '硬性要求：',
      '1. **原样抽取**：用户写了几组就几组、几个条目就几个条目，**权重数字一个都不许改**、不合并不拆分、不改写措辞；',
      '2. 忽略与条目无关的内容（标题里的「满分 100 分」、组名里的「48 分」都**不进权重**——组不带权重）；',
      '3. 用户没给 ID 时 id 留空串，**不要自己编号**。',
    ].join('\n'),
  ]
    .filter((section) => section !== '')
    .join('\n\n');
}

/**
 * 生成 / 识别分支共用的输出契约：与评分侧那份（`JUDGE_OUTPUT_CONTRACT`）**不同**——
 * 这边要求的是「表格的形状」，那边要求的是「判定的形状」。
 */
const GENERATE_OUTPUT_CONTRACT = [
  '输出要求（务必严格遵守）：',
  '1. 只输出一个 JSON 对象，不要输出 JSON 以外的任何文字，不要使用 markdown 代码围栏；',
  '2. 字段结构固定为：',
  '   {',
  '     "groups": [',
  '       {',
  '         "name": "组名（如「一、生产代码」）",',
  '         "items": [',
  '           { "id": "短 ID（可留空串）", "goal": "目标：这一项要达成什么", "weight": 正整数 }',
  '         ]',
  '       }',
  '     ]',
  '   }',
  '3. weight 必须是**正整数**（不能是 0、负数或小数）；goal 不能为空；',
  '4. 组**不带权重**：满分由所有条目的 weight 相加得出，不需要你给总分。',
].join('\n');

/**
 * 按组名归位地合并：`added` 里的每个组，若 `current` 已有同名组则把它的项**追加到该组末尾**；
 * 否则按 `added` 给的顺序**新建组并追加到表尾**。
 * 为什么服务端做合并（而不是把「仅新增」交给前端拼）：合并规则与「新项 ID 不得与已有 ID 冲突」
 * 这两条校验必须与落库用的是同一份判据；放客户端等于同一套规则写两遍。
 */
export function mergeRubric(current: Rubric, added: Rubric): { rubric: Rubric; addedItems: number } {
  const groups = current.groups.map((group) => ({ name: group.name, items: [...group.items] }));
  const taken = new Set(groups.flatMap((group) => group.items.map((item) => item.id)).filter((id) => id !== ''));
  let addedItems = 0;

  for (const group of added.groups) {
    const known = groups.find((candidate) => candidate.name === group.name);
    for (const item of group.items) {
      if (item.id !== '') {
        if (taken.has(item.id)) {
          throw new ServiceError('JUDGE_PARSE_FAILED', `评分模型新增的条目复用了已有的 ID「${item.id}」：请重试或换一个模型`, {
            context: { id: item.id },
          });
        }
        taken.add(item.id);
      }
      if (known === undefined) {
        groups.push({ name: group.name, items: [item] });
      } else {
        known.items.push(item);
      }
      addedItems += 1;
    }
  }

  const rubric: Rubric = { groups };
  const checked = validateRubric(rubric);
  if (!checked.ok) {
    // 模型给的形状越过了业务边界（典型是权重 0）——折成可展示的中文，而不是把一张坏表交给调用方
    throw new ServiceError('JUDGE_PARSE_FAILED', `评分模型返回的表格不合法：${checked.message}`, { context: { message: checked.message } });
  }
  return { rubric, addedItems };
}

/**
 * 解析模型回复：剥围栏 → JSON.parse → 形状校验 → 业务校验（`validateRubric`）。
 * 全部失败路径都折成 JUDGE_PARSE_FAILED（HTTP 500），message 必须是能直接给用户看的中文。
 */
function parseGenerated(raw: string): Rubric {
  const jsonText = stripCodeFence(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new ServiceError('JUDGE_PARSE_FAILED', `评分模型返回的不是合法 JSON，请重试或换一个模型：${excerpt(raw)}`, {
      context: { raw: excerpt(raw) },
    });
  }

  const checked = RubricSchema.safeParse(parsed);
  if (!checked.success) {
    const detail = checked.error.issues
      .slice(0, 3)
      .map((issue) => `${issue.path.join('.') || '（根对象）'}：${issue.message}`)
      .join('；');
    throw new ServiceError('JUDGE_PARSE_FAILED', `评分模型返回的表格形状不合法（${detail}）：请重试或换一个模型`, {
      context: { raw: excerpt(raw) },
    });
  }
  // 生成分支允许 groups 为空（「已经完备」）；但**识别分支不允许**——用户给了要求却识别出空表，
  // 那一定是我们或模型错了，而不是「这道题不需要评分项」
  const business = validateRubric(checked.data);
  if (!business.ok && checked.data.groups.length > 0) {
    throw new ServiceError('JUDGE_PARSE_FAILED', `评分模型返回的表格不合法：${business.message}`, {
      context: { raw: excerpt(raw), message: business.message },
    });
  }
  return checked.data;
}

/**
 * 剥掉 markdown 代码围栏：模型即使被要求「只输出 JSON」也常常包一层 ```json。
 * 只处理开头/结尾的围栏，不动正文。
 */
function stripCodeFence(raw: string): string {
  const trimmed = raw.trim();
  const fenceMatch = /^```[a-zA-Z]*\s*\n([\s\S]*?)\n?```$/.exec(trimmed);
  return fenceMatch?.[1] ?? trimmed;
}

/** 原文片段：截断到合理长度（排障够用，又不会把整个回复塞进错误上下文） */
function excerpt(raw: string): string {
  return raw.length <= RAW_EXCERPT_LENGTH ? raw : `${raw.slice(0, RAW_EXCERPT_LENGTH)}…（已截断）`;
}
```

- [ ] **Step 5: 跑 `judge.test.ts`，确认全绿**

Run: `corepack pnpm vitest run packages/server/api/src/judge.test.ts`
Expected: PASS

- [ ] **Step 5: 用例服务加写侧校验**

`packages/server/api/src/cases.ts`：

1. import 补 `validateRubric`。
2. `createCase` 里 `judgePrompt: input.judgePrompt,` 换成 `rubric: input.rubric,`。
3. `updateCase` 里 `...(patch.judgePrompt === undefined ? {} : { judgePrompt: patch.judgePrompt }),` 换成 `...(patch.rubric === undefined ? {} : { rubric: patch.rubric }),`。
4. `assertStorable` 换成：

```ts
/**
 * 落盘前按契约自检：配置文件是所有人共享的真相，写进去的每个用例都必须满足 `TestCaseSchema`
 * **且**评分表通过了业务校验。
 *
 * 为什么业务校验也放在**这里**（而不是 createCase / updateCase 各写一遍）：两处各写一遍必然漂移，
 * 而漂移的症状是「创建时拦得住、编辑时拦不住」。表单那一侧用的是同一份 `validateRubric`，
 * 故界面与后端的判据也只有一份。
 *
 * 为什么必须拦：`RubricSchema` 刻意不设 `.min(1)`（空表是新建用例的真实初态），
 * 于是 API 直调可以写入一张空表或一张权重为 0 的表——那样的用例在评分阶段没法评（满分 0），
 * 而错误会推迟到评测时才暴露，离出错点已经很远。
 */
function assertStorable(testCase: TestCase): TestCase {
  const parsed = TestCaseSchema.parse(testCase);
  const checked = validateRubric(parsed.rubric);
  if (!checked.ok) {
    throw new ServiceError('INVALID_QUERY', `评分标准项不合法：${checked.message}`, { context: { message: checked.message } });
  }
  return parsed;
}
```

- [ ] **Step 6: 改 api 层其余引用**

- `packages/server/api/src/index.ts`：`generateJudgePrompt` → `generateRubric`，`type GenerateJudgePromptResult` → `type GenerateRubricResult`。
- `packages/server/api/src/testing/run-fixtures.ts:47` 的 `judgePrompt: '按 5 维打分',` 换成 `rubric: { groups: [{ name: '一、生产代码', items: [{ id: 'A1', goal: '追加 agent 字段', weight: 20 }] }] },`。
- `packages/server/api/src/testing/cases-harness.ts:186` 的 `judgePrompt: '按五维评分，重点看是否真的补了用例',` 换成同样的 `rubric` 字面量；`:226` 的 `judgePrompt: current.judgePrompt,` 换成 `rubric: current.rubric,`。
- `packages/server/api/src/cases-update.test.ts:54` 的 `expect(next.judgePrompt).toBe(created.judgePrompt);` 换成 `expect(next.rubric).toEqual(created.rubric);`。
- `packages/server/core/src/config-store.test.ts:338` 的 `judgePrompt: '按 5 维打分',` 换成 `rubric: { groups: [{ name: 'g', items: [{ id: 'A', goal: '目标', weight: 10 }] }] },`。

- [ ] **Step 7: 改 HTTP 路由**

`apps/web-next/app/api/cases/generate-judge-prompt/route.ts` 里 `generateJudgePrompt` → `generateRubric`、`GenerateJudgePromptSchema` → `GenerateRubricSchema`（路径**不变**：两个按钮打同一个接口，由 `prompt` 是否为空分派）。

- [ ] **Step 8: 跑三个包**

Run: `corepack pnpm vitest run packages/server/api packages/server/core apps/web-next`
Expected: PASS（`route-cases.test.ts` 里 `/api/cases/generate-judge-prompt` 那一段会需要按新响应形状改：`{ prompt, dimensions }` → `{ rubric, addedItems }`）

- [ ] **Step 10: 变异验证（两条守卫）**

1. 把 `assertStorable` 里 `validateRubric` 那一段删掉 ⇒ 新加一条「写入权重 0 的表格被拒」用例必须红（先写这条用例，再变异）。
2. 把 `mergeRubric` 里 `if (taken.has(item.id))` 那个分支删掉 ⇒「新增项 ID 冲突」必须红。

- [ ] **Step 12: 收尾——清掉四处「评分提示词」遗留（Task 4 路由来的，无任务认领）**

评分提示词这个概念已整体删除，但还有四处提到它。**其中第一处是 Task 2 的返工**：`e3e4517` 改了 `run.ts` 的契约却没顺手改同行注释，而 `run.ts` 不在任何后续任务的清单里 ⇒ 不修就永久遗留。另三处是历史遗留。

| 位置 | 现状 | 改成 |
|---|---|---|
| `packages/server/contracts/src/run.ts:371` | 「换了评分模型、**改了评分提示词**、或者只是想要一次可复现的重算，都要走它」 | 「换了评分模型、**改了评分标准项**、…」——评分表改动**不会**影响已有记录（它是快照），但这句讲的是「什么时候该重新评分」，措辞换成新概念即可 |
| `packages/server/core/src/git.ts:527` | 「把 `.env` 的正文送进**评分提示词**是密钥泄漏」 | 「送进**评分**是密钥泄漏」或「送进评分标准项的判定依据」——保持原意（敏感内容不该进评分输入） |
| `packages/server/core/src/git-diff-collect-b.test.ts:44` | 同上那句的用例注释 | 同步口径 |
| `packages/server/agents/README.md:138` | `\| prompt \| string \| ✅ \| 考题 / 评分提示词 \|` | 「考题」即可（`prompt` 这一格就是候选任务的题面） |

**只改文案，不动断言与行为。**

- [ ] **Step 13: 提交**

```bash
git add packages/server/api/src/judge.ts packages/server/api/src/judge.test.ts packages/server/api/src/cases.ts packages/server/api/src/index.ts packages/server/api/src/testing/run-fixtures.ts packages/server/api/src/testing/cases-harness.ts packages/server/api/src/cases-update.test.ts apps/web-next/app/api/cases/generate-judge-prompt/route.ts apps/web-next/src/route-cases.test.ts packages/server/contracts/src/run.ts packages/server/core/src/git.ts packages/server/core/src/git-diff-collect-b.test.ts packages/server/agents/README.md
git commit -m "feat(api): 评分标准项的智能生成与识别（两个分支 + 服务端合并 + 写侧校验）"
```

> **⚠️ `packages/server/core/src/config-store.test.ts` 已不由本任务处理**（2026-09-30 实施期裁定）：该文件是 Task 2 改名漏下的涟漪，原本排在本步，但 Task 3 期间实测它是**红灯**（`1 failed | 15 passed`，夹具 `:338` 仍造 `judgePrompt`），带着一个红包跑四个任务会让 Task 9 的全量门禁被它挡住、还容易被后续实现者误判成自己的回归 ⇒ 控制方已把它**并进 Task 3 的修复轮**修掉（1 行夹具，实测 core 转 `16 passed`）。执行本任务时若发现该文件仍是旧的，说明 Task 3 的修复轮没落地——**停下报告**，不要自己改。

- [ ] **Step 14: 补旧用例的读侧守卫（Task 4 评审路由的 Important——**本计划此前与 spec 矛盾**）**

**这是一处计划缺陷，不是新增需求。** spec `docs/superpowers/specs/2026-09-28-rubric-scoring-design.md` §10 的要求是：旧用例（重构前建的、只有 `judgePrompt` 而没有 `rubric`）在读侧**显式抛中文 `INTERNAL`**，message 明写「这个用例是旧版数据，请删除它或重新创建：<caseId>」。而本计划 §「已知的旧数据处置」把它降级成了「读回来是 undefined，用户自己删用例」——**执行者照计划做就会漏掉这条守卫**，而 `api/src/cases.ts` 的读路径又不在任何任务的清单里。

**后果（Task 4 评审实测的路径）**：对重构前建的用例做「创建评测」或「换用例编辑」时，`createRun` 无条件读 `testCase.rubric`，最终在 `run-store.ts` 的写侧自检抛出一句「运行快照不符合契约…rubric」——**用户拿到的是一句指向我们内部形状的报错，而不是能指导他行动的那句**。

**实现**：`packages/server/api/src/cases.ts` 的读侧归一 `asStoredCase`（现在只归一 `repoBranch` 与丢掉旧的两列）里补一次 rubric 校验：

```ts
  // 旧用例（重构前建的）只有一段 judgePrompt、没有 rubric。读侧**显式拒绝**而不是把它当成空表：
  // 空表会被下游当成「还没配评分项」，而那份 judgePrompt 其实是一份已经失去意义的旧口径——
  // 让用户以为「补两格就能用」比直接告诉他「请重建」更费时间（spec §10 的处置）。
  const rubric = RubricSchema.safeParse((record as { rubric?: unknown }).rubric);
  if (!rubric.success) {
    throw new ServiceError('INTERNAL', `这个用例是旧版数据（没有评分标准项），请删除它或重新创建：${record.id}`);
  }
```

把它接进返回对象（`rubric: rubric.data`），并加**一条**用例钉住：喂一条只有 `judgePrompt` 的记录 ⇒ 抛 `INTERNAL` 且 message 含「旧版数据」。

> **为什么用 `safeParse` 而不是判 `=== undefined`**：config.json 是手可编辑的，`rubric` 可能是**存在但形状不对**的（半截对象、`items` 写成字符串）。
> 两种坏数据对用户的处置是同一句话，用同一个分支处理才不会漏掉后一种。

- [ ] **Step 15: 根部 README 与测试夹具的两处收尾（Task 4 评审路由）**

1. **`README.md`（仓库根）**：`:236` **逐字引用了本轮改过的那句空表守卫文案**（引用的是旧文本），`:110`/`:199`/`:232`/`:273`/`:319`/`:346` 仍在描述「评分提示词」。Task 9 的 grep 只扫 `packages/**` 与 `apps/**` 的**符号名**，Task 5 Step 12 只覆盖 `agents/README.md:138` ⇒ **这份根 README 能穿过全部 9 个任务活下来**。改口径（评分提示词 → 评分标准项），`:236` 的逐字引用同步成本轮的新文案。
2. **`packages/server/api/src/runs.test.ts` 的那条「保留 rubric」守卫**（约 `:848-862`）：它保留侧的值现在是 `undefined`（`api/src/testing/run-fixtures.ts` 的 `makeRun` 没给 rubric），所以它只能拦住「被改成了别的表」，**拦不住「被丢掉/清空」**。给那条用例的 run 一个**具体的 rubric**，让两侧都有值——否则「换用例才重取」这条不变式的一半是空的。

- [ ] **Step 16: 提交**

```bash
git add packages/server/api/src/judge.ts packages/server/api/src/judge.test.ts packages/server/api/src/cases.ts packages/server/api/src/cases.test.ts packages/server/api/src/index.ts packages/server/api/src/testing/run-fixtures.ts packages/server/api/src/testing/cases-harness.ts packages/server/api/src/cases-update.test.ts packages/server/api/src/runs.test.ts apps/web-next/app/api/cases/generate-judge-prompt/route.ts apps/web-next/src/route-cases.test.ts packages/server/contracts/src/run.ts packages/server/core/src/git.ts packages/server/core/src/git-diff-collect-b.test.ts packages/server/agents/README.md README.md
git commit -m "feat(api): 评分标准项的智能生成与识别（两个分支 + 服务端合并 + 写侧校验 + 旧用例读侧守卫）"
```

---

### Task 6: UI —— 可编辑的「评分标准项」表格（新组件）

**Files:**
- Create: `packages/client/ui/src/composite/rubric-table.tsx`
- Create: `packages/client/ui/src/composite/rubric-table.test.tsx`
- Modify: `packages/client/ui/src/index.ts`（出口）

**Interfaces:**
- Consumes: `Rubric` / `RubricGroup` / `RubricItem` / `rubricMaxScore`（contracts）
- Produces：
  - `RubricTable`（受控：`value: Rubric` / `onChange: (next: Rubric) => void`；`readOnly?: boolean`）
  - `RubricSummaryText({ rubric }): ReactNode`（表尾那句「满分 N 分 · 共 M 项」）

- [ ] **Step 1: 写失败用例**

创建 `packages/client/ui/src/composite/rubric-table.test.tsx`：

```tsx
/**
 * RubricTable：可编辑的二级表格（组 → 评分项）。
 * 三条守卫：
 *   1. 表尾汇总实时跟着数据走（它是用户自查权重配置的唯一手段——满分不强制是 100）；
 *   2. 有 id 的项重复时表格**自己把它们标红**（写侧会拒，但用户不该等到提交才知道）；
 *   3. readOnly 时不渲染任何增删改控件（用例详情复用同一个组件）。
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { Rubric } from '@aieval/contracts';
import { RubricSummaryText, RubricTable } from './rubric-table';

function sample(): Rubric {
  return {
    groups: [
      { name: '一、生产代码', items: [{ id: 'A1', goal: '追加 agent 字段', weight: 18 }, { id: 'A2', goal: '补 Javadoc', weight: 4 }] },
      { name: '二、测试', items: [{ id: 'D1', goal: '补透传用例', weight: 14 }] },
    ],
  };
}

describe('RubricTable', () => {
  it('渲染组名、每项的 id / 目标 / 权重', () => {
    render(<RubricTable value={sample()} onChange={vi.fn()} />);
    expect(screen.getByDisplayValue('一、生产代码')).toBeInTheDocument();
    expect(screen.getByDisplayValue('A1')).toBeInTheDocument();
    expect(screen.getByDisplayValue('追加 agent 字段')).toBeInTheDocument();
    expect(screen.getByDisplayValue('18')).toBeInTheDocument();
  });

  it('改目标时把**整张新表**交给 onChange（受控组件，不自己改 value）', () => {
    const onChange = vi.fn();
    render(<RubricTable value={sample()} onChange={onChange} />);
    fireEvent.change(screen.getByDisplayValue('追加 agent 字段'), { target: { value: '改过的目标' } });
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0]?.[0] as Rubric;
    expect(next.groups[0]?.items[0]?.goal).toBe('改过的目标');
    // 其余部分必须原样保留（漏了就是「改一格清掉别的」）
    expect(next.groups[1]?.items[0]?.id).toBe('D1');
  });

  it('「添加评分项」往该组末尾加一个空项（权重给一个正数默认值，schema 不接受 0）', () => {
    const onChange = vi.fn();
    render(<RubricTable value={sample()} onChange={onChange} />);
    fireEvent.click(screen.getByTestId('rubric-add-item-0'));
    const next = onChange.mock.calls[0]?.[0] as Rubric;
    expect(next.groups[0]?.items).toHaveLength(3);
    expect(next.groups[0]?.items[2]).toEqual({ id: '', goal: '', weight: 1 });
  });

  it('「删除项」「删除组」「添加分组」各自改对位置', () => {
    const onChange = vi.fn();
    const view = render(<RubricTable value={sample()} onChange={onChange} />);
    fireEvent.click(screen.getByTestId('rubric-remove-item-0-1'));
    expect((onChange.mock.calls.at(-1)?.[0] as Rubric).groups[0]?.items.map((item) => item.id)).toEqual(['A1']);

    view.unmount();
    const onChange2 = vi.fn();
    render(<RubricTable value={sample()} onChange={onChange2} />);
    fireEvent.click(screen.getByTestId('rubric-remove-group-1'));
    expect((onChange2.mock.calls.at(-1)?.[0] as Rubric).groups.map((group) => group.name)).toEqual(['一、生产代码']);

    fireEvent.click(screen.getByTestId('rubric-add-group'));
    expect((onChange2.mock.calls.at(-1)?.[0] as Rubric).groups).toHaveLength(2);
  });

  /**
   * 守卫：**两项内容完全相同**时改第二项不能改到第一项。
   * 这是本组件实现上最容易踩的坑（用 `items.includes(item)` 反查组索引时，
   * 两个 `{ id: '', goal: '', weight: 1 }` 的默认项会永远命中的是第一项），
   * 而连点两次「添加评分项」正好造出这个形状。
   */
  it('两项完全相同时只改被点的那一项', () => {
    const sameTwice: Rubric = { groups: [{ name: 'g', items: [{ id: '', goal: '', weight: 1 }, { id: '', goal: '', weight: 1 }] }] };
    const onChange = vi.fn();
    render(<RubricTable value={sameTwice} onChange={onChange} />);

    // 第二个空目标框：`getAllByDisplayValue('')` 拿不到（空值不算 display value），故按测试 id 取
    fireEvent.change(screen.getByTestId('rubric-item-goal-0-1'), { target: { value: '第二项的目标' } });

    const next = onChange.mock.calls.at(-1)?.[0] as Rubric;
    expect(next.groups[0]?.items[0]?.goal).toBe('');
    expect(next.groups[0]?.items[1]?.goal).toBe('第二项的目标');
  });

  it('表格上方直接显示校验原因（用户不该等到点「确定」才知道哪一格有问题）', () => {
    render(<RubricTable value={{ groups: [] }} onChange={vi.fn()} />);
    expect(screen.getByTestId('rubric-validation-error')).toHaveTextContent('至少需要一组');
  });

  it('有 id 的项重复时标红（写侧会拒，但用户不该等到提交才知道）', () => {
    const duplicated: Rubric = {
      groups: [
        { name: 'g1', items: [{ id: 'A1', goal: 'a', weight: 1 }] },
        { name: 'g2', items: [{ id: 'A1', goal: 'b', weight: 1 }] },
      ],
    };
    render(<RubricTable value={duplicated} onChange={vi.fn()} />);
    // 两个输入框都进 error 态（antd 的 error 类名是 `ant-input-status-error`）
    const inputs = screen.getAllByDisplayValue('A1');
    expect(inputs).toHaveLength(2);
    for (const input of inputs) expect(input.className).toContain('ant-input-status-error');
  });

  it('readOnly 时不渲染任何增删控件（用例详情复用同一个组件）', () => {
    render(<RubricTable value={sample()} onChange={vi.fn()} readOnly />);
    expect(screen.queryByTestId('rubric-add-group')).toBeNull();
    expect(screen.queryByTestId('rubric-add-item-0')).toBeNull();
    expect(screen.queryByTestId('rubric-remove-group-0')).toBeNull();
    // 只读态也不能是可编辑输入框
    expect(screen.queryByDisplayValue('追加 agent 字段')).toBeNull();
    expect(screen.getByText('追加 agent 字段')).toBeInTheDocument();
  });
});

describe('RubricSummaryText', () => {
  it('实时汇总满分与项数（满分由表格决定，用户必须能看见）', () => {
    render(<RubricSummaryText rubric={sample()} />);
    expect(screen.getByText(/满分 36 分/)).toBeInTheDocument();
    expect(screen.getByText(/共 3 项/)).toBeInTheDocument();
  });

  it('空表显示 0 分 0 项（不显示 NaN）', () => {
    render(<RubricSummaryText rubric={{ groups: [] }} />);
    expect(screen.getByText(/满分 0 分/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: 跑它，确认失败**

Run: `corepack pnpm vitest run packages/client/ui/src/composite/rubric-table.test.tsx`
Expected: FAIL（`./rubric-table` 不存在）

- [ ] **Step 3: 写 `rubric-table.tsx`**

创建 `packages/client/ui/src/composite/rubric-table.tsx`：

```tsx
'use client';

/**
 * 评分标准项：可编辑的二级表格（组 → 评分项），用例表单与用例详情共用。
 *
 * 四条口径：
 *   1. **受控**：`value` / `onChange(next)`，本组件不持有状态。每次改动交给调用方**整张新表**
 *      （不做「改一格清掉别的」那种就地改写——那会让 React 看不出变化）；
 *   2. **权重默认给 1**：schema 与 `validateRubric` 都拒绝 0，故新项的初值必须是一个正数，
 *      否则用户点「添加评分项」之后立刻拿到一个非法状态；
 *   3. **重复 ID 当场标红**：写侧会拒，但用户不该等到提交才知道。空 id 不算重复（它们没有身份）；
 *   4. `readOnly` 供用例详情复用：不渲染任何增删控件，也不渲染输入框。
 *
 * 样式一律走 antd（主题 token / 紧凑密度），不手写字号、不裸写 div 做布局。
 */
import { rubricMaxScore, validateRubric, type Rubric, type RubricGroup, type RubricItem } from '@aieval/contracts';
import { Button, Card, Flex, Input, InputNumber, Table, Tag, Typography } from 'antd';
import type { TableColumnsType } from 'antd';
import type { ReactNode } from 'react';

export interface RubricTableProps {
  value: Rubric;
  onChange: (next: Rubric) => void;
  /** 只读形态（用例详情）：不渲染任何增删控件 */
  readOnly?: boolean;
}

/** 新评分项的初值：权重给 1（0 会被 schema 与 validateRubric 拒掉） */
const NEW_ITEM: RubricItem = { id: '', goal: '', weight: 1 };

/** 表尾汇总：满分 = 全部项权重之和。它同时是用户自查权重配置的唯一手段（满分不强制是 100） */
export function RubricSummaryText({ rubric }: { rubric: Rubric }): ReactNode {
  const count = rubric.groups.reduce((total, group) => total + group.items.length, 0);
  return (
    <Typography.Text type="secondary">
      满分 {rubricMaxScore(rubric)} 分 · 共 {count} 项
    </Typography.Text>
  );
}

export function RubricTable({ value, onChange, readOnly = false }: RubricTableProps): ReactNode {
  /** 校验结果：表格上方直接显示原因（用户不该等到点「确定」才知道哪一格有问题） */
  const validation = validateRubric(value);
  /** 有值的 id 出现次数：> 1 的那些进 error 态（空 id 不参与，它们没有身份） */
  const duplicatedIds = ((): Set<string> => {
    const seen = new Set<string>();
    const duplicated = new Set<string>();
    for (const group of value.groups) {
      for (const item of group.items) {
        if (item.id === '') continue;
        if (seen.has(item.id)) duplicated.add(item.id);
        seen.add(item.id);
      }
    }
    return duplicated;
  })();

  /** 整表替换某一组（其余组原样）。**按 groupIndex 定位，不按对象引用反查**——两项内容完全相同时反查会永远命中的是第一组 */
  const replaceGroup = (groupIndex: number, items: RubricItem[]): void => {
    onChange({ groups: value.groups.map((group, index) => (index === groupIndex ? { ...group, items } : group)) });
  };

  /** 改一项的某个字段（其余原样） */
  const patchItem = (groupIndex: number, itemIndex: number, patch: Partial<RubricItem>): void => {
    const items = value.groups[groupIndex]?.items ?? [];
    replaceGroup(
      groupIndex,
      items.map((item, index) => (index === itemIndex ? { ...item, ...patch } : item)),
    );
  };

  /**
   * 某一组的列定义。**必须按组生成**（闭包捕获 groupIndex），不能用一份共享的 columns
   * 再去数据里反查组索引——那在「两项内容完全相同」时会改错项（典型场景：连点两次「添加评分项」）。
   */
  const columnsFor = (groupIndex: number, group: RubricGroup): TableColumnsType<{ item: RubricItem; index: number }> => [
    {
      title: 'ID',
      width: 96,
      render: (_, { item, index }) =>
        readOnly ? (
          <Typography.Text>{item.id === '' ? '—' : item.id}</Typography.Text>
        ) : (
          <Input
            size="small"
            value={item.id}
            status={duplicatedIds.has(item.id) ? 'error' : undefined}
            data-testid={`rubric-item-id-${groupIndex}-${index}`}
            onChange={(event) => patchItem(groupIndex, index, { id: event.target.value })}
          />
        ),
    },
    {
      title: '目标',
      render: (_, { item, index }) =>
        readOnly ? (
          <Typography.Text>{item.goal}</Typography.Text>
        ) : (
          <Input
            size="small"
            value={item.goal}
            placeholder="既说清改哪里，也说清怎样算达成"
            data-testid={`rubric-item-goal-${groupIndex}-${index}`}
            onChange={(event) => patchItem(groupIndex, index, { goal: event.target.value })}
          />
        ),
    },
    {
      title: '权重',
      width: 96,
      render: (_, { item, index }) =>
        readOnly ? (
          <Typography.Text>{item.weight}</Typography.Text>
        ) : (
          <InputNumber
            size="small"
            min={1}
            value={item.weight}
            data-testid={`rubric-item-weight-${groupIndex}-${index}`}
            // `null`（清空输入框）落回 1：权重 0 会被 schema 与 validateRubric 拒掉，
            // 让用户点着点着就进一个非法状态是可用性问题
            onChange={(next) => patchItem(groupIndex, index, { weight: next ?? 1 })}
          />
        ),
    },
    ...(readOnly
      ? []
      : [
        {
          title: '',
          width: 72,
          render: (_: unknown, { index }: { item: RubricItem; index: number }) => (
            <Button
              size="small"
              type="text"
              autoInsertSpace={false}
              data-testid={`rubric-remove-item-${groupIndex}-${index}`}
              onClick={() => replaceGroup(groupIndex, group.items.filter((_, itemIndex) => itemIndex !== index))}
            >
              删除
            </Button>
          ),
        },
      ]),
  ];

  return (
    <Flex vertical gap={8}>
      {/* 校验原因直接显示在表格上方：用户不该等到点「确定」才知道哪一格有问题。
          判据与写侧、与表单提交时用的是**同一份** `validateRubric`（三处同一份，不存在第二套规则）。 */}
      {!readOnly && !validation.ok && (
        <Typography.Text type="danger" data-testid="rubric-validation-error">
          {validation.message}
        </Typography.Text>
      )}
      {value.groups.map((group, groupIndex) => (
        <Card
          key={`rubric-group-${groupIndex}`}
          size="small"
          data-testid={`rubric-group-${groupIndex}`}
          title={
            readOnly ? (
              <Typography.Text strong>{group.name}</Typography.Text>
            ) : (
              <Flex align="center" gap={8}>
                <Input
                  size="small"
                  value={group.name}
                  placeholder="组名，例如：一、生产代码"
                  data-testid={`rubric-group-name-${groupIndex}`}
                  onChange={(event) =>
                    onChange({
                      groups: value.groups.map((candidate, index) =>
                        index === groupIndex ? { ...candidate, name: event.target.value } : candidate,
                      ),
                    })
                  }
                />
                {duplicatedIds.size > 0 && <Tag color="error">ID 有重复</Tag>}
              </Flex>
            )
          }
          extra={
            readOnly ? undefined : (
              <Button
                size="small"
                danger
                autoInsertSpace={false}
                data-testid={`rubric-remove-group-${groupIndex}`}
                onClick={() => onChange({ groups: value.groups.filter((_, index) => index !== groupIndex) })}
              >
                删除组
              </Button>
            )
          }
        >
          <Table
            size="small"
            rowKey={(record) => `${groupIndex}-${record.index}`}
            pagination={false}
            dataSource={group.items.map((item, index) => ({ item, index }))}
            columns={columnsFor(groupIndex, group)}
          />
          {!readOnly && (
            <Button
              size="small"
              type="dashed"
              autoInsertSpace={false}
              data-testid={`rubric-add-item-${groupIndex}`}
              onClick={() => replaceGroup(groupIndex, [...group.items, { ...NEW_ITEM }])}
            >
              添加评分项
            </Button>
          )}
        </Card>
      ))}
      {!readOnly && (
        <Button
          size="small"
          color="default"
          variant="dashed"
          autoInsertSpace={false}
          data-testid="rubric-add-group"
          onClick={() => onChange({ groups: [...value.groups, { name: '', items: [{ ...NEW_ITEM }] }] })}
        >
          添加分组
        </Button>
      )}
      <RubricSummaryText rubric={value} />
    </Flex>
  );
}
```

> **测试 id 契约（固定，实现时不许改）**：`rubric-group-{groupIndex}` / `rubric-group-name-{groupIndex}` /
> `rubric-remove-group-{groupIndex}` / `rubric-add-item-{groupIndex}` / `rubric-add-group` /
> `rubric-item-id-{groupIndex}-{itemIndex}` / `rubric-item-goal-{groupIndex}-{itemIndex}` /
> `rubric-item-weight-{groupIndex}-{itemIndex}` / `rubric-remove-item-{groupIndex}-{itemIndex}`。
> 测试文件里用的正是这一套（Task 6 Step 1 的用例里那几处 `rubric-remove-item-0-1` 等即按此形状）。

- [ ] **Step 4: 跑测试，全绿**

Run: `corepack pnpm vitest run packages/client/ui/src/composite/rubric-table.test.tsx`
Expected: PASS

- [ ] **Step 5: 加出口**

`packages/client/ui/src/index.ts` 里 `score-bars` 那一行替换为：

```ts
export { RubricSummaryText, RubricTable, type RubricTableProps } from './composite/rubric-table';
```

> **⚠️ 本步原写「同时 `git rm` 掉 `base/score-bars.{tsx,test.tsx}`」——实施期改由 Task 8 删除（2026-09-30 裁定）**：删掉它会让 `src/index.test.ts`（**包根出口面守卫**）整套加载失败，因为 Task 8 才重写的 `score-detail-view.tsx:24` 仍 import 这个已删模块。
> 后果不是「一个用例红」，而是**在 Task 6 到 Task 8 这段窗口里，包根出口守卫彻底失明**——而这段窗口正是两个 UI 任务新增/消费出口的时候。**一个因为错误原因而红的守卫，等于没有人读的守卫。**
> 故：本步**只留 `ScoreBars` 的出口行**（与 `RubricTable` 并存），删除动作连同出口行一并交给 Task 8（它的 brief 已经要改掉 `score-detail-view.tsx` 里那处 `ScoreBars` 用法）。
> **副作用**：`base/score-bars.tsx` 的一条 typecheck 错（它自己就是旧维度的遗留）会多留到 Task 8——已登记，不影响本任务的「ui 错数不增加」判据。

- [ ] **Step 6: 变异验证**

把重复 ID 的 `status={duplicatedIds.has(item.id) ? 'error' : undefined}` 改成 `status={undefined}` ⇒「重复时标红」必须红。
**变异要打在 trim 后的比较上**（判重必须与 `validateRubric` / `rubricItemKeys` 同一口径：**trim 后比较**）——`'A1'` 与 `' A1 '` 必须被判为重复，而两个 `'   '`（都是空 id）**不得**被判为重复。

- [ ] **Step 7: 提交**

```bash
git add packages/client/ui/src/composite/rubric-table.tsx packages/client/ui/src/composite/rubric-table.test.tsx packages/client/ui/src/index.ts
git commit -m "feat(ui): 评分标准项表格（可编辑 + 只读两种形态）"
```

---

### Task 7: UI —— 识别弹窗 + 表单接线

**Files:**
- Create: `packages/client/ui/src/composite/rubric-recognize-modal.tsx`
- Create: `packages/client/ui/src/composite/rubric-recognize-modal.test.tsx`
- Modify: `packages/client/ui/src/composite/case-form-panel.tsx`（删评分提示词字段、接表格与两个按钮）
- Modify: `packages/client/ui/src/composite/case-form-panel.test.tsx`
- Modify: `packages/client/ui/src/index.ts`
- Modify: `packages/client/client/src/cases.ts`、`packages/client/client/src/cases.test.tsx`
- Modify: `apps/web-next/app/cases/page.tsx`

**Interfaces:**
- Consumes: Task 6 的 `RubricTable`；Task 5 的 `generateRubric` 的返回形状 `{ rubric, addedItems, note? }`
- Produces：
  - `RubricRecognizeModal({ open, recognizing, onCancel, onRecognize }): ReactNode`
  - `CaseFormPanelProps.onGenerate(input: GenerateRubricInput): Promise<{ rubric: Rubric; addedItems: number; note?: string }>`

- [ ] **Step 1: 写识别弹窗的失败用例**

创建 `packages/client/ui/src/composite/rubric-recognize-modal.test.tsx`：

```tsx
/**
 * RubricRecognizeModal：**框内只有一个多行文本域** + 取消 / 识别两个按钮。
 * 守卫（本组件的全部价值都在这两条上）：
 *   1. 识别失败时**弹窗不关、文本原样保留**——反例是「先清空再请求」：一次网络抖动就清掉用户刚粘进来的长文；
 *   2. 成功不回填（回填由调用方做）、关闭不写回（`onCancel` 只关窗）。
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RubricRecognizeModal } from './rubric-recognize-modal';

describe('RubricRecognizeModal', () => {
  it('只有一个多行文本域（没有表格、没有其他控件）', () => {
    render(<RubricRecognizeModal open recognizing={false} onCancel={vi.fn()} onRecognize={vi.fn()} />);
    expect(screen.getAllByRole('textbox')).toHaveLength(1);
    expect(screen.getByTestId('rubric-recognize-text')).toBeInTheDocument();
  });

  it('点「识别」把文本原样交给 onRecognize', async () => {
    const onRecognize = vi.fn(async () => undefined);
    render(<RubricRecognizeModal open recognizing={false} onCancel={vi.fn()} onRecognize={onRecognize} />);
    fireEvent.change(screen.getByTestId('rubric-recognize-text'), { target: { value: '## 一、生产代码 48 分' } });
    fireEvent.click(screen.getByTestId('rubric-recognize-submit'));
    await waitFor(() => expect(onRecognize).toHaveBeenCalledWith('## 一、生产代码 48 分'));
  });

  it('识别失败：弹窗不关、文本原样保留', async () => {
    const onRecognize = vi.fn(async () => {
      throw new Error('评分模型返回的不是合法 JSON');
    });
    const onCancel = vi.fn();
    render(<RubricRecognizeModal open recognizing={false} onCancel={onCancel} onRecognize={onRecognize} />);
    fireEvent.change(screen.getByTestId('rubric-recognize-text'), { target: { value: '很长的一段评分要求' } });
    fireEvent.click(screen.getByTestId('rubric-recognize-submit'));

    await waitFor(() => expect(onRecognize).toHaveBeenCalledTimes(1));
    // 等一拍，确保「先清空再请求」那种实现也有机会把文本清掉，断言才有区分力
    await waitFor(() => expect(screen.getByTestId('rubric-recognize-text')).toHaveValue('很长的一段评分要求'));
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('识别中时按钮转圈且不可再点（避免连点两次花两次钱）', () => {
    render(<RubricRecognizeModal open recognizing onCancel={vi.fn()} onRecognize={vi.fn()} />);
    expect(screen.getByTestId('rubric-recognize-submit')).toBeDisabled();
  });

  it('点「取消」只调 onCancel（不写回任何东西）', () => {
    const onCancel = vi.fn();
    render(<RubricRecognizeModal open recognizing={false} onCancel={onCancel} onRecognize={vi.fn()} />);
    fireEvent.click(screen.getByTestId('rubric-recognize-cancel'));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: 跑它，确认失败**

Run: `corepack pnpm vitest run packages/client/ui/src/composite/rubric-recognize-modal.test.tsx`
Expected: FAIL（文件不存在）

- [ ] **Step 3: 写识别弹窗**

创建 `packages/client/ui/src/composite/rubric-recognize-modal.tsx`：

```tsx
'use client';

/**
 * 「智能识别」弹窗：**框内只有一个多行文本域**——用户把评分要求粘进来，识别结果由调用方回填到表单表格。
 *
 * 三条口径：
 *   1. **失败不清空、不关窗**：反面写法是「先清空再请求」——一次网络抖动就会清掉用户刚粘进来的长文，
 *      而用户看到的只是一句报错。本组件因此把文本放在**自己的 state** 里，只有成功或用户主动关闭才动它；
 *   2. **本组件不调接口**（纯展示）：`onRecognize` 由调用方实现，错误也由调用方提示（与 CaseFormPanel 同一条分工）；
 *   3. 关闭（取消 / 遮罩）只调 `onCancel`，**不写回**任何东西。
 */
import { Button, Flex, Input, Modal, Typography } from 'antd';
import { useState, type ReactNode } from 'react';

export interface RubricRecognizeModalProps {
  open: boolean;
  /** 识别请求在途：按钮转圈并禁用（避免连点两次花两次钱） */
  recognizing: boolean;
  onCancel: () => void;
  /** 把文本交给调用方去识别；抛错即失败（本组件据此保留文本） */
  onRecognize: (prompt: string) => Promise<void>;
}

export function RubricRecognizeModal({ open, recognizing, onCancel, onRecognize }: RubricRecognizeModalProps): ReactNode {
  const [text, setText] = useState('');

  return (
    <Modal
      open={open}
      title="智能识别评分标准项"
      // 关闭即丢弃文本：留着下次打开又看到上次那份，用户会以为「已经识别过了」
      destroyOnHidden
      onCancel={onCancel}
      afterClose={() => setText('')}
      footer={
        <Flex justify="end" gap={8}>
          <Button size="small" autoInsertSpace={false} data-testid="rubric-recognize-cancel" onClick={onCancel}>
            取消
          </Button>
          <Button
            size="small"
            type="primary"
            autoInsertSpace={false}
            loading={recognizing}
            disabled={recognizing}
            data-testid="rubric-recognize-submit"
            onClick={() => void onRecognize(text)}
          >
            识别
          </Button>
        </Flex>
      }
    >
      <Flex vertical gap={8}>
        <Typography.Text type="secondary">
          把你的评分要求粘贴进来，识别结果会回填到表单里的评分标准项表格
        </Typography.Text>
        <Input.TextArea
          rows={10}
          value={text}
          data-testid="rubric-recognize-text"
          onChange={(event) => setText(event.target.value)}
        />
      </Flex>
    </Modal>
  );
}
```

- [ ] **Step 4: 跑测试，全绿**

Run: `corepack pnpm vitest run packages/client/ui/src/composite/rubric-recognize-modal.test.tsx`
Expected: PASS

- [ ] **Step 5: 改 `case-form-panel.tsx`**

在 `packages/client/ui/src/composite/case-form-panel.tsx` 里做六处改动：

1. import：删 `DIMENSIONS` / `type DimensionKey` / `type GenerateJudgePromptInput`，补 `type GenerateRubricInput` / `type Rubric`；组件 import 补 `RubricTable` 与 `RubricRecognizeModal`。

2. `CaseFormValues` 里 `judgePrompt: string;` 换成 `rubric: Rubric;`。

3. `CaseFormPanelProps` 里 `dimensions: DimensionKey[];` 换成 `rubric: Rubric;`；`onGenerate` 的签名换成：

```ts
  /**
   * 生成 / 识别评分标准项。**成功才写回表格**（失败时面板什么都不做，错误由页面提示）——
   * 反面写法是「先清空再请求」：一次抖动就清掉用户刚调好的表。
   */
  onGenerate: (input: GenerateRubricInput) => Promise<{ rubric: Rubric; addedItems: number; note?: string }>;
```

4. 删掉 `previewDimensions` 那一段与 `Form.Item` 里的「评分提示词」整块（含 `Input.TextArea data-testid="case-judge-prompt"` 与生成按钮），换成：

```tsx
      {/* 评分标准项：表格常驻可见（不藏在弹窗里）——它才是主角，两个按钮只是帮它起草 */}
      <Card
        size="small"
        title="评分标准项"
        data-testid="case-rubric"
        extra={
          <Flex gap={8}>
            {judgeConfigured ? (
              <Flex gap={8}>
                <Button
                  size="small"
                  autoInsertSpace={false}
                  loading={generating}
                  data-testid="case-generate-rubric"
                  onClick={() => void handleGenerate()}
                >
                  智能生成
                </Button>
                <Button
                  size="small"
                  autoInsertSpace={false}
                  disabled={generating}
                  data-testid="case-recognize-rubric"
                  onClick={() => setRecognizeOpen(true)}
                >
                  智能识别
                </Button>
              </Flex>
            ) : (
              // 禁用按钮不触发鼠标事件：Tooltip 必须挂在 span 上
              <Tooltip title={GLOBAL_JUDGE_TOOLTIP}>
                <span data-testid="case-generate-wrapper">
                  <Button size="small" disabled autoInsertSpace={false} data-testid="case-generate-rubric">
                    智能生成
                  </Button>
                </span>
              </Tooltip>
            )}
          </Flex>
        }
      >
        <Form.Item
          name="rubric"
          noStyle
          rules={[
            {
              // 与后端 `validateRubric` 同一份判据：空表能存在、不能提交
              validator: (_, value: Rubric | undefined) => {
                const checked = validateRubric(value ?? { groups: [] });
                return checked.ok ? Promise.resolve() : Promise.reject(new Error(checked.message));
              },
            },
          ]}
        >
          <RubricTable value={rubricValue} onChange={(next) => form.setFieldValue('rubric', next)} />
        </Form.Item>
      </Card>

      <RubricRecognizeModal
        open={recognizeOpen}
        recognizing={generating}
        onCancel={() => setRecognizeOpen(false)}
        onRecognize={handleRecognize}
      />
```

（`rubricValue` 用 `Form.useWatch('rubric', form) ?? { groups: [] }` 取；`recognizeOpen` 是一个 `useState<boolean>(false)`；`handleGenerate` / `handleRecognize` 见下。）

5. 两个处理函数：

```tsx
  /** 智能生成：把**当前表格**一起交出去（AI 要靠它做「只增不改」） */
  const handleGenerate = async (): Promise<void> => {
    const values = await form.validateFields(['taskPrompt', 'repoPath']).catch(() => null);
    if (values === null) return;
    try {
      const generated = await onGenerate({
        rubric: form.getFieldValue('rubric') ?? { groups: [] },
        taskPrompt: values.taskPrompt ?? '',
        prompt: '',
        repoPath: (values.repoPath ?? '').trim(),
      });
      form.setFieldValue('rubric', generated.rubric);
    } catch {
      // 刻意什么都不做：不清空、不回填——用户已有的表格必须原样保留（错误由页面提示）
    }
  };

  /**
   * 智能识别：**只带用户粘的文本**（服务端不碰仓库，故不需要 repoPath），成功后整表替换。
   * 抛错时**不关弹窗、不清文本**——那是本弹窗存在的理由。
   */
  const handleRecognize = async (prompt: string): Promise<void> => {
    const generated = await onGenerate({ rubric: { groups: [] }, taskPrompt: '', prompt, repoPath: '' });
    form.setFieldValue('rubric', generated.rubric);
    setRecognizeOpen(false);
  };
```

6. `handleFinish` 与 `initialValues` 里的 `judgePrompt` 换成 `rubric`：

```tsx
      rubric: values.rubric,
```

```tsx
        rubric: initial.rubric,
```

（`initialValues` 里若 `initial === null`，用 `{ groups: [] }` 作为 `rubric` 初值。）

- [ ] **Step 6: 改 `case-form-panel.test.tsx`**

- 文件级 `INITIAL` 夹具的 `judgePrompt: '已有的评分提示词',` 换成 `rubric: { groups: [{ name: '一、生产代码', items: [{ id: 'A1', goal: '追加 agent 字段', weight: 18 }] }] },`。
- `defaultProps()` 里 `dimensions: [...]` 换成 `rubric: { groups: [] }`，`onGenerate` 的替身换成返回 `{ rubric: { groups: [{ name: 'g', items: [{ id: 'A1', goal: '生成出来的目标', weight: 10 }] }] }, addedItems: 1 }`。
- `fillRequired()` 除了四个字段，**还要填一项合法的评分标准项**（否则 `rubric` 是空表，会被 `Form.Item` 的校验拦下，下面所有提交类用例都会红）：

```tsx
/** 填满必填字段（标题 / 考题提示词 / 仓库路径）+ 一项合法的评分标准项 */
function fillRequired(): void {
  fireEvent.change(screen.getByTestId('case-title'), { target: { value: '新用例' } });
  fireEvent.change(screen.getByTestId('case-task-prompt'), { target: { value: '补一条回归' } });
  fireEvent.change(screen.getByTestId('case-repo-path'), { target: { value: 'D:\\projects\\gateway' } });
  // 空表能存在、不能提交（与写侧同一份 validateRubric）：这一项让表单过校验
  fireEvent.click(screen.getByTestId('rubric-add-group'));
  fireEvent.change(screen.getByTestId('rubric-group-name-0'), { target: { value: '一、生产代码' } });
  fireEvent.change(screen.getByTestId('rubric-item-goal-0-0'), { target: { value: '追加 agent 字段' } });
}
```

- 提交类用例里凡是 `judgePrompt: '按五维评分',` 的期望值，换成那一项表格：

```ts
      rubric: { groups: [{ name: '一、生产代码', items: [{ id: '', goal: '追加 agent 字段', weight: 1 }] }] },
```

- `'编辑模式：预填已有用例的值'` 里 `expect(screen.getByTestId('case-judge-prompt')).toHaveValue(INITIAL.judgePrompt);` 换成 `expect(screen.getByTestId('rubric-item-goal-0-0')).toHaveValue('追加 agent 字段');`。
- `Describe('CaseFormPanel 的 AI 生成')` 整段替换成：

```tsx
describe('CaseFormPanel 的评分标准项', () => {
  it('「智能生成」把当前表格一起交出去（AI 靠它做只增不改）', async () => {
    const onGenerate = vi.fn(async () => ({
      rubric: { groups: [{ name: '一、生产代码', items: [{ id: 'A1', goal: '追加 agent 字段', weight: 18 }, { id: 'A2', goal: '补 Javadoc', weight: 4 }] }] },
      addedItems: 1,
    }));
    setup({ mode: 'edit', initial: INITIAL, onGenerate });

    fireEvent.click(screen.getByTestId('case-generate-rubric'));

    await waitFor(() => expect(onGenerate).toHaveBeenCalledTimes(1));
    expect(onGenerate.mock.calls[0]?.[0]).toMatchObject({ prompt: '', repoPath: 'D:\\projects\\gateway' });
    expect((onGenerate.mock.calls[0]?.[0] as { rubric: Rubric }).rubric.groups[0]?.items).toHaveLength(1);
    // 成功后表格被替换成返回的那一份。**用 testid 而不是 getByDisplayValue**：
    // 识别弹窗打开时页面上会有两个含同一段文本的输入框，`getByDisplayValue` 会命中多个而报错
    await waitFor(() => expect(screen.getByTestId('rubric-item-goal-0-1')).toHaveValue('补 Javadoc'));
  });

  it('生成失败不动已有的表格（一次失败的点击不能清掉用户刚调好的表）', async () => {
    const onGenerate = vi.fn(async () => {
      throw new Error('评分模型返回的不是合法 JSON');
    });
    setup({ mode: 'edit', initial: INITIAL, onGenerate });

    fireEvent.click(screen.getByTestId('case-generate-rubric'));

    await waitFor(() => expect(onGenerate).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByTestId('rubric-item-goal-0-0')).toHaveValue('追加 agent 字段'));
  });

  it('「智能识别」开的弹窗里只有文本域，识别成功后整表替换并关窗', async () => {
    const onGenerate = vi.fn(async () => ({
      rubric: { groups: [{ name: '二、测试', items: [{ id: 'D1', goal: '补透传用例', weight: 14 }] }] },
      addedItems: 0,
    }));
    setup({ mode: 'edit', initial: INITIAL, onGenerate });

    fireEvent.click(screen.getByTestId('case-recognize-rubric'));
    fireEvent.change(await screen.findByTestId('rubric-recognize-text'), { target: { value: '## 一、生产代码 48 分' } });
    fireEvent.click(screen.getByTestId('rubric-recognize-submit'));

    await waitFor(() => expect(onGenerate).toHaveBeenCalledWith({ rubric: { groups: [] }, taskPrompt: '', prompt: '## 一、生产代码 48 分', repoPath: '' }));
    await waitFor(() => expect(screen.queryByTestId('rubric-recognize-text')).toBeNull());
    expect(screen.getByTestId('rubric-item-goal-0-0')).toHaveValue('补透传用例');
  });

  it('识别失败时弹窗不关、文本原样保留', async () => {
    const onGenerate = vi.fn(async () => {
      throw new Error('识别失败');
    });
    setup({ mode: 'edit', initial: INITIAL, onGenerate });

    fireEvent.click(screen.getByTestId('case-recognize-rubric'));
    fireEvent.change(await screen.findByTestId('rubric-recognize-text'), { target: { value: '很长的一段要求' } });
    fireEvent.click(screen.getByTestId('rubric-recognize-submit'));

    await waitFor(() => expect(onGenerate).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('rubric-recognize-text')).toHaveValue('很长的一段要求');
  });

  it('未配置评分模型时两个按钮都禁用，悬停给出「去设置页」的指引', async () => {
    setup({ judgeConfigured: false });
    expect(screen.getByTestId('case-generate-rubric')).toBeDisabled();
    expect(screen.getByTestId('case-recognize-rubric')).toBeDisabled();
    fireEvent.mouseOver(screen.getByTestId('case-generate-wrapper'));
    expect(await screen.findByText('请先到设置里配置默认评分模型')).toBeInTheDocument();
  });

  it('未配置评分模型时点两个按钮都不会触发生成', () => {
    const onGenerate = vi.fn();
    setup({ judgeConfigured: false, onGenerate });
    fireEvent.click(screen.getByTestId('case-generate-rubric'));
    fireEvent.click(screen.getByTestId('case-recognize-rubric'));
    expect(onGenerate).not.toHaveBeenCalled();
  });

  it('空表提交被拦下并给出中文原因（空表能存在、不能提交）', async () => {
    const onSubmit = vi.fn();
    setup({ mode: 'new', initial: null, onSubmit });
    fillRequired();
    fireEvent.click(screen.getByTestId('case-submit'));
    expect(await screen.findByText(/评分标准项不能为空/)).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
```

（文件头 import 补 `type Rubric`。）

- [ ] **Step 7: 改 client 数据层**

`packages/client/client/src/cases.ts` 里 `useGenerateJudgePrompt` 换成：

```ts
/**
 * 生成 / 识别评分标准项（非流式）。不挂缓存：它是一次会花钱的模型调用，不是可复用的数据。
 * 两个动作打**同一个接口**，由 `input.prompt` 是否为空分派（见服务端 `generateRubric`）。
 */
export function useGenerateRubric(): {
  generate: (input: GenerateRubricInput) => Promise<{ rubric: Rubric; addedItems: number; note?: string }>;
  isGenerating: boolean;
} {
  const { trigger, isMutating } = useSWRMutation(
    GENERATE_JUDGE_PROMPT_KEY,
    (key: string, { arg }: { arg: GenerateRubricInput }) =>
      postJson<{ rubric: Rubric; addedItems: number; note?: string }>(key, arg),
    { populateCache: false, revalidate: false },
  );
  return { generate: trigger, isGenerating: isMutating };
}
```

（import 补 `type GenerateRubricInput` / `type Rubric`；`cases.test.tsx` 里对应的断言按新返回形状改。）

- [ ] **Step 8: 改用例页**

`apps/web-next/app/cases/page.tsx`：

1. import：`useGenerateJudgePrompt` → `useGenerateRubric`；删 `DIMENSIONS` / `type DimensionKey` / `type GenerateJudgePromptInput`，补 `type GenerateRubricInput` / `type Rubric`。
2. 删掉 `FIXED_DIMENSIONS` 常量。
3. `const { generate, isGenerating } = useGenerateJudgePrompt();` → `const { generate, isGenerating } = useGenerateRubric();`
4. `const [dimensions, setDimensions] = useState<DimensionKey[]>(FIXED_DIMENSIONS);` → `const [rubric, setRubric] = useState<Rubric>({ groups: [] });`
5. `go()` 里 `setDimensions(FIXED_DIMENSIONS);` → `setRubric({ groups: [] });`
6. `handleGenerate` 换成：

```tsx
  /** 生成 / 识别评分标准项：成功才更新表格；失败提示原因并把错误抛回面板（面板据此不改表格） */
  const handleGenerate = async (input: GenerateRubricInput): Promise<{ rubric: Rubric; addedItems: number; note?: string }> => {
    try {
      const generated = await generate(input);
      setRubric(generated.rubric);
      if (generated.note !== undefined) void message.info(generated.note);
      else if (generated.addedItems > 0) void message.success(`已新增 ${generated.addedItems} 项`);
      return generated;
    } catch (error) {
      void message.error(errorMessage(error));
      throw error;
    }
  };
```

7. `sharedFormProps` 里 `dimensions,` → `rubric,`。

- [ ] **Step 9: 跑 ui / client / web-next 三个包**

Run: `corepack pnpm vitest run packages/client/ui packages/client/client apps/web-next`
Expected: PASS

- [ ] **Step 10: 变异验证**

把 `case-form-panel` 的 `handleRecognize` 里 `form.setFieldValue('rubric', generated.rubric)` 挪到 `await` **之前**（模拟「先清空再请求」）⇒「识别失败时文本/表格保留」必须红。

- [ ] **Step 11: 提交**

```bash
git add packages/client/ui/src/composite/rubric-recognize-modal.tsx packages/client/ui/src/composite/rubric-recognize-modal.test.tsx packages/client/ui/src/composite/case-form-panel.tsx packages/client/ui/src/composite/case-form-panel.test.tsx packages/client/ui/src/index.ts packages/client/client/src/cases.ts packages/client/client/src/cases.test.tsx apps/web-next/app/cases/page.tsx
git commit -m "feat(ui): 用例表单接入评分标准项表格与「智能生成 / 智能识别」两个动作"
```

---

### Task 8: UI —— 用例详情与评分详情

**Files:**
- Modify: `packages/client/ui/src/composite/case-detail-panel.tsx`（删「评分维度」行，加评分标准项卡片）
- Modify: `packages/client/ui/src/composite/case-detail-panel.test.tsx`
- Modify: `packages/client/ui/src/composite/score-detail-view.tsx`（重写）
- Modify: `packages/client/ui/src/composite/score-detail-view.test.tsx`（重写）
- Modify: `packages/client/ui/src/composite/judge-settings-card.tsx:174-184`（输出契约文案）
- Modify: `packages/client/ui/src/index.ts`（删掉 `ScoreBars` 那一行出口）
- Delete: `packages/client/ui/src/base/score-bars.tsx`、`packages/client/ui/src/base/score-bars.test.tsx`

**Interfaces:**
- Consumes: Task 6 的 `RubricTable`（`readOnly`）
- Produces: 无新导出

> **⚠️ `ScoreBars` 的删除是 Task 6 转交给本任务的（2026-09-30 裁定）**：Task 6 原本要删它，但删掉会让 `src/index.test.ts`（**包根出口面守卫**）整套加载失败——因为本任务才重写的 `score-detail-view.tsx` 当时仍 import 它。那会让守卫在「Task 6 → 本任务」这段窗口里失明，而这段窗口正是两个 UI 任务新增/消费出口的时候。
> 故本任务**必须**：①重写 `score-detail-view.tsx` 时去掉 `ScoreBars` 的 import 与用法（本任务本来就要做）；②删掉 `src/index.ts` 里 `ScoreBars` 那一行出口；③`git rm` 掉 `base/score-bars.tsx` 与 `score-bars.test.tsx`（它们此刻**已恢复**在原位，未随 Task 6 一起删除）；④确认 `src/index.test.ts` 由红转绿——它现在正是**因为这段悬空引用而红**，是你判断「删除做干净了没有」的现成判据。
> **附带**：`base/score-bars.tsx` 自己带 1 条 typecheck 错（它是旧维度的遗留），删掉它之后 ui 的错数应再降 1。

- [ ] **Step 1: 写评分详情的失败用例（重写测试）**

用下面这份内容**整体替换** `packages/client/ui/src/composite/score-detail-view.test.tsx`：

```tsx
/**
 * ScoreDetailView：总分 + 逐项达成 / 未达成 + 理由 + 总评 + 评分者 + 原始返回。
 * 四条守卫：
 *   1. **总分原样显示 `score.totalScore`，前端不重算**（它是服务端按权重加总出来的权威值）；
 *   2. **未达成的项要能被看出来**（它们才是使用者要看的重点，不能与达成项长得一样）；
 *   3. **判定按引用键与评分表对齐**：缺一项说明数据不一致，此时**不静默跳过**；
 *   4. 满分来自 `maxScore`（不是常量 100）。
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { Rubric, ScoreResult } from '@aieval/contracts';
import { ScoreDetailView } from './score-detail-view';

const RUBRIC: Rubric = {
  groups: [
    {
      name: '一、生产代码',
      items: [
        { id: 'A1', goal: '追加 agent 字段', weight: 18 },
        { id: 'D1', goal: '补透传用例', weight: 14 },
      ],
    },
  ],
};

function score(overrides: Partial<ScoreResult> = {}): ScoreResult {
  return {
    judgments: [
      { id: 'A1', achieved: true, reason: '字段进了契约' },
      { id: 'D1', achieved: false, reason: '没补用例' },
    ],
    totalScore: 18,
    maxScore: 32,
    verdict: '生产代码到位，测试缺失',
    raw: '{"judgments":[]}',
    judgeProviderId: 'p-1',
    judgeModelId: 'deepseek-chat',
    judgedAt: '2026-09-29T08:10:00.000Z',
    judgeAgentKind: null,
    structuredOutput: false,
    ...overrides,
  };
}

describe('ScoreDetailView', () => {
  it('总分、满分、逐项目标与理由、总评、评分者都在', () => {
    render(<ScoreDetailView score={score()} rubric={RUBRIC} />);
    expect(screen.getByText('18')).toBeInTheDocument();
    expect(screen.getByText(/满分 32 分/)).toBeInTheDocument();
    expect(screen.getByText('追加 agent 字段')).toBeInTheDocument();
    expect(screen.getByText('字段进了契约')).toBeInTheDocument();
    expect(screen.getByText('生产代码到位，测试缺失')).toBeInTheDocument();
    expect(screen.getByText(/deepseek-chat/)).toBeInTheDocument();
  });

  it('总分原样显示权威值，**不在前端重算**（18 分就是 18，不是按权重现场算出来的别的数）', () => {
    // 若有人在这里「按评分表重算」，会得到 18（这一份恰好相同）——所以刻意再给一个不同的权威值
    render(<ScoreDetailView score={score({ totalScore: 7 })} rubric={RUBRIC} />);
    expect(screen.getByText('7')).toBeInTheDocument();
    expect(screen.queryByText('18')).toBeNull();
  });

  it('未达成的项与达成的项长得不一样（它是使用者要看的重点）', () => {
    render(<ScoreDetailView score={score()} rubric={RUBRIC} />);
    const achievedRow = screen.getByTestId('score-judgment-A1');
    const missedRow = screen.getByTestId('score-judgment-D1');
    expect(achievedRow).toHaveAttribute('data-achieved', 'yes');
    expect(missedRow).toHaveAttribute('data-achieved', 'no');
    expect(achievedRow.textContent).toContain('达成');
    expect(missedRow.textContent).toContain('未达成');
  });

  /**
   * 判定与评分表按**引用键**对齐。找不到说明数据不一致——那种「看起来正常」的表格比报错危险得多，
   * 故本组件只在**渲染期**跳过（不抛），但把缺席的项显式画出来。
   */
  it('评分表里有、判定里没有的项被显式标出（不静默跳过）', () => {
    render(<ScoreDetailView score={score({ judgments: [{ id: 'A1', achieved: true, reason: '好' }] })} rubric={RUBRIC} />);
    expect(screen.getByText(/缺少判定/)).toBeInTheDocument();
  });

  it('原始返回原样可见（解析失败时它是唯一线索）', () => {
    render(<ScoreDetailView score={score({ raw: '这不是 JSON，模型回了一段散文' })} rubric={RUBRIC} />);
    expect(screen.getByTestId('score-raw')).toHaveTextContent('这不是 JSON，模型回了一段散文');
  });

  it('满分来自 maxScore（不是常量 100）', () => {
    render(<ScoreDetailView score={score({ totalScore: 300, maxScore: 300 })} rubric={RUBRIC} />);
    expect(screen.getByText(/满分 300 分/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: 跑它，确认失败**

Run: `corepack pnpm vitest run packages/client/ui/src/composite/score-detail-view.test.tsx`
Expected: FAIL（`ScoreDetailView` 还没有 `rubric` prop）

- [ ] **Step 3: 重写 `score-detail-view.tsx`**

用下面这份内容**整体替换** `packages/client/ui/src/composite/score-detail-view.tsx`：

```tsx
'use client';

/**
 * 评分详情：总分 + 满分 + 逐项达成 / 未达成 + 每项理由 + 总评 + 评分者 + 模型原始返回。
 * 五条口径：
 *   1. **总分原样显示 `score.totalScore`，前端不重算**——它是服务端按权重加总出来的权威值
 *      （缺一项即整行判失败），在这里「按评分表现场加一遍」会把数据不一致静默改写成另一个数；
 *   2. **满分来自 `score.maxScore`**（不是常量 100，也不现算）——它是这一分生成时那张表的权重之和；
 *   3. **未达成的项必须与达成项区分开**：它们才是使用者要看的重点；
 *   4. 判定与评分表按**引用键**对齐；评分表里有而判定里没有的项**显式标出**（不静默跳过）
 *      ——那种「看起来正常」的表格比报错危险得多；
 *   5. 原始返回必须可见：解析失败时它是判断「提示词问题还是模型问题」的唯一线索。
 */
import { Flex, Tag, Typography, theme } from 'antd';
import type { ReactNode } from 'react';
import { AGENT_LABELS, rubricItemKeys, type Rubric, type ScoreResult } from '@aieval/contracts';
import { MonoText } from '../base/mono-text';
import { formatDateTime } from '../base/format';

export interface ScoreDetailViewProps {
  score: ScoreResult;
  /** 这一轮用的评分表（**快照**，与 `score` 来自同一份 run.json） */
  rubric: Rubric;
}

export function ScoreDetailView({ score, rubric }: ScoreDetailViewProps): ReactNode {
  // 未达成项的语义色取 antd token（不写 `var(--ant-color-error)` 字面量：换主题时这里跟着走）
  const { token } = theme.useToken();
  const items = rubric.groups.flatMap((group) => group.items);
  const keys = rubricItemKeys(rubric);
  const byId = new Map(score.judgments.map((judgment) => [judgment.id, judgment]));

  return (
    <Flex vertical gap={16} style={{ padding: 16 }}>
      <Flex align="baseline" gap={8} wrap>
        {/* 总分原样显示（见文件头口径 1） */}
        <Typography.Title level={4}>{score.totalScore}</Typography.Title>
        <Typography.Text type="secondary">
          满分 {score.maxScore} 分 · 共 {keys.length} 项
        </Typography.Text>
      </Flex>

      <Flex vertical gap={8}>
        {rubric.groups.map((group) => (
          <Flex vertical gap={4} key={group.name}>
            <Typography.Text strong>{group.name}</Typography.Text>
            {group.items.map((item) => {
              const index = items.indexOf(item);
              const key = keys[index] ?? '';
              const judgment = byId.get(key);
              return (
                <Flex
                  key={key}
                  data-testid={`score-judgment-${key}`}
                  // 「达成 / 未达成」的**数据属性**判据：比断言 class 稳（antd 换 token 不会让它红），
                  // 也正是测试用的那一条
                  data-achieved={judgment?.achieved === true ? 'yes' : 'no'}
                  gap={8}
                  align="baseline"
                  // 未达成的项用 antd 的语义色标出来——它才是使用者要看的重点。
                  // 取 token 而不是写 `var(--ant-color-error)` 字面量：主题换色时这里跟着走
                  style={judgment?.achieved === true ? undefined : { color: token.colorError }}
                >
                  <Typography.Text code style={{ minWidth: 48 }}>
                    {key}
                  </Typography.Text>
                  <Typography.Text style={{ flex: 1 }}>{item.goal}</Typography.Text>
                  <Typography.Text strong>{item.weight} 分</Typography.Text>
                  {judgment === undefined ? (
                    <Tag color="warning">缺少判定</Tag>
                  ) : (
                    <Tag color={judgment.achieved ? 'success' : 'error'}>{judgment.achieved ? '达成' : '未达成'}</Tag>
                  )}
                  <Typography.Text type="secondary" style={{ flex: 2 }}>
                    {judgment?.reason ?? ''}
                  </Typography.Text>
                </Flex>
              );
            })}
          </Flex>
        ))}
      </Flex>

      <Flex vertical gap={4}>
        <Typography.Text strong>总评</Typography.Text>
        <Typography.Paragraph style={{ marginBottom: 0 }}>{score.verdict}</Typography.Paragraph>
      </Flex>

      <Typography.Text type="secondary">
        {score.judgeAgentKind === null
          ? `评分模型：${score.judgeModelId}`
          : `评分智能体：${AGENT_LABELS[score.judgeAgentKind]} · 模型：${score.judgeModelId}`}
        {' · '}
        输出约束：{score.structuredOutput ? 'schema 约束' : '提示词约束'}
        {' · '}
        评分时间：{formatDateTime(score.judgedAt)}
      </Typography.Text>

      <Flex vertical gap={4}>
        <Typography.Text strong>模型原始返回</Typography.Text>
        <MonoText text={score.raw} maxHeight={240} dataTestId="score-raw" />
      </Flex>
    </Flex>
  );
}
```

- [ ] **Step 4: 跑评分详情测试，全绿**

Run: `corepack pnpm vitest run packages/client/ui/src/composite/score-detail-view.test.tsx`
Expected: PASS

- [ ] **Step 5: 改用例详情（评分维度行 → 评分标准项卡片）**

`packages/client/ui/src/composite/case-detail-panel.tsx`：

1. import 删 `DIMENSIONS`，补 `RubricTable`（从 `./rubric-table`）。
2. `fields` 里 `{ key: 'dimensions', label: '评分维度', children: ... }` 那一整项**删除**（一条 Descriptions 行塞不下二级表格）。
3. 在「考题提示词」那张 `Card` **之后**插入：

```tsx
      <Card size="small" title="评分标准项">
        <RubricTable value={testCase.rubric} onChange={() => {}} readOnly />
      </Card>
```

（`case-detail-panel.test.tsx` 里断言「评分维度」文案的用例改成断言「评分标准项」卡片里有某个目标文案。）

- [ ] **Step 6: 改设置页的输出契约文案**

`packages/client/ui/src/composite/judge-settings-card.tsx:174-184` 那个 `Form.Item label="输出契约（只读）"` 里的两段文案换成：

```tsx
              <Typography.Text type="secondary">
                评分模型只输出一个 JSON：对评分标准项里**每一项**给出「达成 / 未达成 + 一句理由」，不给总分。
              </Typography.Text>
              <Typography.Text type="secondary">
                总分 = 达成项的权重之和；满分 = 全部项权重之和（由每个用例的「评分标准项」决定）。
              </Typography.Text>
```

（import 里删 `DIMENSIONS` / `DIMENSION_COUNT`；`judge-settings-card.test.tsx:140` 那条遍历 `DIMENSIONS` 的断言改成断言这两句文案里含「达成」「总分」等关键词。）

> **⚠️ 这一格现在是「手册已改、界面没改」的不一致（Task 5 评审 Minor 11 路由至此）**：Task 5 按控制方路由把根 `README.md` 改成了新口径，其中 `README.md:88` 已经写「评分模型只输出每一项的达成 + 理由，不给总分」——**但设置页这一格此刻仍渲染已删除的 5 维文案与 `round(sum(score) / (5 × 5) × 100)`**。
> 也就是说手册描述了一个还不存在的界面。本步落地后两者才一致；**执行时若发现这一格已经是新文案**（说明别处已经改过），核对它与 `README.md:88` 的口径逐字相符即可，不要重复改。
> 另外同一条评审 Minor 还指出 `README.md:171` 描述的是「5 维评分条 + 每维理由」的评分详情，而那是本任务 Step 3 要改的界面 ⇒ **一并顺手改掉那半句**（改成逐项达成/未达成的描述），它属于本任务的交付物。

- [ ] **Step 7: 跑 ui 包**

Run: `corepack pnpm vitest run packages/client/ui`
Expected: PASS

- [ ] **Step 8: 变异验证**

把 `score-detail-view.tsx` 里 `judgment?.achieved === true ? undefined : 'var(--ant-color-error)'` 改成恒为 `undefined` ⇒「未达成的项与达成项长得不一样」必须红。

- [ ] **Step 9: 提交**

```bash
git add packages/client/ui/src/composite/score-detail-view.tsx packages/client/ui/src/composite/score-detail-view.test.tsx packages/client/ui/src/composite/case-detail-panel.tsx packages/client/ui/src/composite/case-detail-panel.test.tsx packages/client/ui/src/composite/judge-settings-card.tsx packages/client/ui/src/composite/judge-settings-card.test.tsx README.md packages/client/ui/src/index.ts
git rm packages/client/ui/src/base/score-bars.tsx packages/client/ui/src/base/score-bars.test.tsx
```

---

### Task 9: 全链收口 —— 旧符号清零、门禁三关、端到端冒烟

**Files:**
- Modify: 任何仍有旧符号引用的文件（由 Step 1 的 grep 决定）
- Create: `docs/superpowers/notes/2026-09-29-rubric-scoring-smoke.md`

- [ ] **Step 0: 先认下这类红（**不是回归**）：Windows 原子写的 EPERM**

全量门禁的**第一件事**是知道哪些红不属于本次改动。本机（Windows）有两类**环境性**失败，从基线就存在，**Task 3/4/5 期间各实测到一次**：

| 症状 | 根因 | 处置 |
|---|---|---|
| `EPERM: operation not permitted, rename …config.json.tmp -> …config.json`（也可能出现在任何写 `config.json` 的用例里，如 `runs.test.ts` 的 `seedConfig`） | `core/src/config-store.ts:148-163` 的原子写：非只读目标上的瞬时占用（杀软 / 索引器 / 并发）会让 `renameSync` 抛 EPERM，而它**只重试一次**（`evaluator/src/run-store.ts:248-264` 同形）。两处注释都说「重试 rename 就过去了」，但**都没有重试循环**——那是可见性主张，不是实现 | **不是回归**。两处同形、属既有设计（早于本次重构），本计划不改。记下它、重跑；**第二次仍红**才当回归查 |
| `EPERM, Permission denied: …\aieval-mirror-*` / `…\aieval-*`（夹具清理） | 刚退出的 git 进程仍捏着自己的 cwd 句柄，`rmSync` 删除竞态（`core/src/testing/mirror-harness.ts` 已带重试，仍偶发） | **不是回归**（基线跑里就有 2 条） |

> **为什么必须在门禁里写明**：这两类红的症状是「随便一条用例失败」，与真回归**长得一模一样**。
> 若不预先登记，执行者会把时间花在追一条环境抖动上；更糟的是，他可能**顺手放松断言**来「修」它——那会把真守卫拆掉。
> **判据（唯一可信的）**：`git stash` 回到本次改动之前的提交，复跑同一个文件；基线也红 ⇒ 环境；基线绿 ⇒ 回归。
> **并且：先抓断言原文再重跑**。「重跑就绿了」正是真回归藏身的方式——Task 3 的 flake 就是因为没抓到文案而无法定论。

> **反例（2026-09-30 实测）**：Task 5 抓到完整栈——`config-store.ts:162:5` 的**第二次** `renameSync` 也抛了 EPERM（`config-store.ts:148` 一次 + `:162` 无条件第二次，只有**删除**受 `isReadOnly` 门控；`run-store.ts:247-273` 同形）。
> 也就是说两处注释里那句「重试 rename 就过去了」**已有反例在手**：重试确实发生了，但没有过去。
> 这不改变上面的处置（仍不是回归、仍不在本计划内改），但它把这条红的性质说清了：**不是「没有重试」，而是「重试不够」**。

> **第三条同族证据（2026-09-30，Task 5 修复轮 2）**：`core/src/testing/mirror-harness.ts:228` 的**夹具清理** `rmSync` 也抛 `EPERM, Permission denied: …\Temp\aieval-mirror-*`，而 `:226-227` 的注释正写着「给足重试窗口」——
> 即**带重试的清理**在并发压力下同样会 EPERM。三条证据（`config-store` 的 rename 两次、`mirror-harness` 的清理一次）**全部出现在机器被并发占满时**。
> 结论：这一族的判据是**机器负载**，不是代码路径；门禁遇到它们时先看「同一命令干净复跑是否全绿」，而不是去读被测代码。

- [ ] **Step 0.5: 先修两处「不是环境红」的既有红（它们在别的任务清单里没人认领）**
这两条是**真红**、不是环境抖动，且不属于任何任务的 Files 清单 ⇒ 不显式处理就会卡住本步的全量门禁。

**（一）`apps/web-next/src/instrumentation.test.ts` 的 2 条红——这是本次重构的涟漪，必须修。**
症状：`expected 'running' to be 'interrupted'`（在途行没被标成 `interrupted`）。
根因（2026-09-30 控制方定位）：该测试**手写 `run.json`**（`instrumentation.test.ts:48-63`，文件头注释明说「故 run.json 用手写 JSON 造」），而那份 JSON **没有 `rubric` 字段**；Task 2 让 `EvalRun.rubric` 变必填后，`listRuns()` 对**解析不过的快照静默跳过** ⇒ `recoverInterruptedRuns()`（`evaluator/src/orchestrator.ts:2049`）的循环里根本没有这一轮 ⇒ 行留在 `running`。
**修法**：给那份手写 JSON 补 `rubric`（形状用别的夹具同款：一组一项、`id` 显式给出）。
> **教训（与 Task 3 的 `makeRunFixture` 同一类）**：本次波及分析只扫了「**谁引用了被删的符号**」，没扫「**谁供给新增的必填字段**」——因此漏到很晚才发现。
> 故本步**顺带扫一遍全仓**：找出手写 `run.json` / `config.json` 的地方（测试文件里的 `JSON.stringify(` 与 `writeFileSync(....json`），逐个确认带 `rubric`。

**（二）`apps/web-next/src/drawer-geometry.test.ts` 的套件级红——与本次重构无关（既有红）。**
症状：`ENOENT` 读 `process.cwd()/app/runs/page.tsx`。该路径**只在 CWD=`apps/web-next` 时成立**；从仓库根跑 vitest 时 CWD 是根目录，套件在收集期即死。
**处置**：**修**（按 `import.meta.url` / `__dirname` 定位，而不是 `process.cwd()`）。理由：它是本步全量门禁的一部分，而「与本次重构无关」不等于「可以留着让门禁永远红」——**一个永远有红的门禁等于没有门禁**。Step 0 那两类环境红可接受，是因为它们**偶发**；这条是**必然**。
> 若判定不该在本计划里修（例如另有任务在做 Next.js instrumentation 收尾），**必须在报告里写明并给出归属**，不许静默留着。

- [ ] **Step 0.6: 清掉实施期积攒的「注释/文案与代码不符」（各任务评审登记，逐条在此结清）**

这一族缺陷的共同形态是：**代码是对的，但描述代码的那句话是错的**。它比缺失更坏——下一个读代码的人会按错的说法做判断。逐条如下（每条都给了位置与正确说法，改完**只动注释/文案，不动行为**）：

| 位置 | 现状（错） | 改成 |
|---|---|---|
| `apps/web-next/app/cases/page.tsx:8`（文件头） | 把「生成 / 识别出的评分标准项」列进「切换面板要复位的临时状态」 | 复位**已不由页面做**：`validatedRepo`/`currentRepo`/`repoInfo` 才在页面上复位，表格靠 `key` 重挂载 + 面板 `initialValues` 复位（`:148-150` 已写明）⇒ 把它从那份清单里去掉，并指向 `:148` |
| `packages/client/ui/src/composite/case-form-panel.test.tsx:351`、`testing/fixtures.ts` 同类 | 注释说「四个文本字段」，而 `fillTextFields()` 只填**三个** | 改成三个（若那第四个指 `rubric`，说清「表格由 `fillRequired()` 另填」） |
| `packages/client/ui/src/composite/case-form-panel.test.tsx:91`（既有 docstring） | 同样说「四个」却只列三个 | 同步 |
| `packages/client/ui/src/index.test.ts` 相关表述 | 曾被控制方称作「包根出口面守卫」，实际它断言的是 `completionPercent` 从包根可用 + 其行为 + 与深路径导入同一性（**不是**出口面枚举器） | 若文件头有类似表述，改成它真正断言的东西 |
| `packages/server/api/src/judge.ts` 的 ID 冲突用例注释 | 曾需要说明「唯一钉住的是**文案归属**」 | 已在 Task 5 补，核对仍在 |
| Task 6 登记的 Tag 文案 | `#k` 撞车时写「ID 有重复」，而实际没有 ID 重复（是**引用键**重复） | 改成与表格上方那句精确文案同口径（如「引用键有重复」），并确认用例断言随之更新 |

> **为什么集中做而不是各任务随手做**：这些散在六个文件里、每条都是几个字，单看都不值得一次派单；但攒到最后评审时，它们会让「注释可信度」整体变差——而本次重构一路依赖「注释写的就是代码做的」（多处守卫的**理由**就写在注释里）。**一次结清，比让它们各自留在原地更有价值。**
> **判据**：改完后，抽查任意一条：读注释 → 去代码里验证 → 两者一致。若发现某条「改成正确说法」需要改行为，**停下报告**（说明那条不是文案问题）。

- [ ] **Step 1: 旧符号清零（**只查代码引用**，不是「零命中」）**

> **⚠️ 本步原先要求 `packages/` 与 `apps/` 下「必须为零」——实施期证明该判据不可达（2026-09-30，Task 8 上报，控制方实测确认）。**
> 三个理由：①**负向守卫与注释必须点名已删除的概念**（`case-detail-panel.tsx:15` 就写着「旧的『评分维度』行与『评分提示词』卡片已随本次重构删除」，`case-detail-panel.test.tsx:7/:184` 同理——这正是防止它们长回来的守卫，删掉注释就把守卫的**理由**删了）；②**对话内容是数据**（`agents`/`client` 的用例里 `'{"dimensions":[]}'` 是模拟模型回复的字符串，与契约无关）；③HEAD 上本就有一批既有命中（见下表）。

**判据改为：不存在对已删符号的\*\*代码引用\*\*。** 允许出现的地方只有四类，且每类都必须能在下面这张豁免表里找到：

| 允许的类别 | 例子 | 为什么不能删 |
|---|---|---|
| 负向守卫的注释与用例名 | `case-detail-panel.tsx:15`、`case-detail-panel.test.tsx:7/:184` | 它们的作用就是「这两个概念已被删除，不许再长回来」——注释即守卫的理由 |
| 对话/模拟数据字符串 | `row-live.test.tsx:259-260`、`agents/**/events.test.ts` 里的 `'{"dimensions":[]}'` | 那是**模型回复的原文**，不是本仓的契约类型 |
| 历史文档 | `docs/superpowers/**` | 历史记录，不改 |
| 本计划自己 | `docs/superpowers/plans/2026-09-29-rubric-scoring.md` | 它按设计要记录旧符号 |

Run（只看代码引用：类型/值导入、属性读取、JSX、`new`/调用）：

```powershell
Get-ChildItem -Recurse -Include *.ts,*.tsx -Path packages,apps |
  Where-Object { $_.FullName -notmatch 'node_modules' } |
  Select-String -Pattern "DIMENSIONS|DIMENSION_COUNT|DimensionKey|DimensionScore|MIN_SCORE_PER_DIMENSION|MAX_SCORE_PER_DIMENSION|judgePrompt|GenerateJudgePrompt|ScoreBars|score-bars|case-judge-prompt|case-dimensions" |
  ForEach-Object { "$($_.Path):$($_.LineNumber): $($_.Line.Trim())" }
```

Expected: 逐条落在上表四类**之一**（把每条归到某一类，写进报告）。**任何一条「读一个已删字段/调用一个已删函数」都是真问题**——它的症状多半是类型错或运行期 `undefined`。已知的既有命中（实施期实测，供对照）：

- `packages/client/ui/src/composite/run-create-panel.test.tsx:49/60/258/284/644` —— **不是豁免类别，是真陈旧夹具**，由 Step 1.5 修掉。
- `packages/client/client/src/row-live.test.tsx:259-260` —— 对话数据，豁免。
- `packages/client/ui/src/base/metric-line.test.tsx:14`、`composite/eval-row-card.test.tsx:265`、`composite/log-format.test.ts:34`、`composite/run-detail-panel.test.tsx:35` —— `dimensions: []` 的**陈旧评分夹具**，由 Step 1.5 修掉。
- `packages/server/agents/src/providers/*/events.test.ts` —— 对话数据，豁免。

- [ ] **Step 1.5: 修掉 13 条陈旧夹具的类型错（实施期实测清单，全部属本步）**

`corepack pnpm typecheck` 当前 **13 条错**，逐条都是「夹具还在用旧形状」——`judgePrompt`（已从 `TestCase` 删除）或 `dimensions`（已从 `ScoreResult` 删除）。修法是**换成新形状**（`rubric` / `judgments` + `maxScore`），不是加 `as` 断言绕过：

| 文件 | 条数 | 修法 |
|---|---|---|
| `packages/client/ui/src/composite/run-create-panel.test.tsx` | 6（`:49/:60/:258/:284/:644` 的 `judgePrompt` + `:89` 的 `EvalRun` 缺 `rubric`） | 用例夹具的 `judgePrompt: '按 5 维打分'` → 一份 `rubric`（一组一项、显式 `id`）；`:89` 的 run 字面量补 `rubric` |
| `packages/client/ui/src/composite/run-detail-panel.test.tsx` | 2（`:35` 的 `dimensions` + `:73` 的 run 缺 `rubric`） | 同上 |
| `packages/client/client/src/testing/run-fixtures.ts` | 1（`:35` 造的 run 没有 `rubric`） | 给共享夹具补 `rubric`（**这一处修好会连带消掉别的包的红**，优先做） |
| `packages/client/ui/src/base/metric-line.test.tsx` | 1（`:47` 的 `ScoreResult` 字面量缺 `judgments`/`maxScore`） | 换新形状 |
| `packages/client/ui/src/composite/eval-row-card.test.tsx` | 1（`:265` 的 `dimensions`） | 同上 |
| `packages/client/ui/src/composite/log-format.test.ts` | 1（`:34` 的 `dimensions`） | 同上 |
| `apps/web-next/src/case-panel-state.test.ts` | 1（`:20` 的 `judgePrompt`） | 同上 |

> **为什么这些留到最后**：它们**不影响任何用例的绿/红**（用 `as` 或宽松断言绕过了类型），所以每个任务的「本包测试全绿」都发现不了；只有全仓 `typecheck` 和这次 grep 兜底能把它们揪出来。**这正是本步存在的意义**——Step 2 要求 exit 0，不修它们就达不到。

- [ ] **Step 2: 类型检查**

Run: `corepack pnpm typecheck`
Expected: **exit 0**（修完 Step 1.5 的 13 条之后）

- [ ] **Step 3: Lint**

Run: `corepack pnpm lint`
Expected: exit 0

- [ ] **Step 4: 全量测试**

Run: `corepack pnpm test`
Expected: **`Test Files 2 failed | 159 passed` / `Tests 2 failed | 1889 passed`**（2026-09-30 实施期实测，Task 8 之后、Task 9 之前）。两条红都是 web-next 的**既知红**，由 Step 0.5 修掉：`src/drawer-geometry.test.ts`（套件级，CWD 依赖的 ENOENT）与 `src/instrumentation.test.ts`（2 条，缺 `rubric` 的涟漪）。**除此之外的任何红都要查。**
> 对照**开工基线**：`3 failed | 156 passed` 文件 / `2 failed | 1843 passed` 用例（那两条环境红是 `api/run-artifacts` 的 EPERM 与 `core/mirror-ensure-b` 的 EPERM，均偶发——本次实测**未出现**，正说明它们是负载相关的抖动而非必然红）。**用例数 1843 → 1889**：本次重构净增覆盖。
- [ ] **Step 5: 端到端冒烟（按 AGENT.md 的四要素记录）**

1. 起服务：`corepack pnpm dev`（web-next，http://localhost:3083）；端口被占用先 kill。
2. 浏览器（mcp）走一遍真实路径：
   - 用例页 → 新建 → 点「智能识别」→ 粘贴 spec §2 的示例提示词 → 识别 → **表格回填出两组共 11 项**，表尾「满分 100 分 · 共 11 项」；
   - 点「智能生成」→ 新增项落在**同名组末尾**（或提示「未新增条目」）；
   - 手工改一格权重 → 表尾汇总实时变；
   - 保存用例 → 重新打开详情 → 「评分标准项」卡片显示同一张表；
3. CLI 复核落盘事实：`~/.aieval/config.json` 里该用例的 `rubric` 与界面一致（`Get-Content ~/.aieval/config.json | ConvertFrom-Json`）；
4. 跑一轮评测 → 评分详情逐项达成/未达成、总分 = 达成项权重之和（用 CLI 读 `run.json` 的 `score` 与 `rubric` 互证）；
5. 改用例的评分表 → 历史记录**不变**（`run.json` 的 `rubric` 快照仍是旧的）。
6. 把范围清单（逐项 ✅/❌/跳过+理由）、操作路径、证据（浏览器 + CLI 互证）、未覆盖项写进 `docs/superpowers/notes/2026-09-29-rubric-scoring-smoke.md`。

- [ ] **Step 6: 提交（分两个提交：先代码收口，再冒烟记录）**

**提交 1——Step 0.5 / 0.6 / 1.5 的代码与文案收口。** 路径按你实际改到的写，预期覆盖：

```bash
git add apps/web-next/src/instrumentation.test.ts apps/web-next/src/drawer-geometry.test.ts \
        apps/web-next/src/case-panel-state.test.ts \
        packages/client/client/src/testing/run-fixtures.ts \
        packages/client/ui/src/composite/run-create-panel.test.tsx \
        packages/client/ui/src/composite/run-detail-panel.test.tsx \
        packages/client/ui/src/composite/eval-row-card.test.tsx \
        packages/client/ui/src/composite/log-format.test.ts \
        packages/client/ui/src/composite/case-form-panel.test.tsx \
        packages/client/ui/src/base/metric-line.test.tsx \
        apps/web-next/app/cases/page.tsx \
        packages/server/api/src/judge.ts packages/client/ui/src/index.test.ts \
        packages/client/ui/src/composite/rubric-table.tsx
git commit -m "chore: 收口——两处无人认领的真红、13 条陈旧夹具、注释与代码对齐"
```

> 上面这份是**预期**清单：**以 `git status` 实际改到的为准**（多退少补），但**不许 `git add -A`**——本仓长期有并发会话的改动（含 feature 提交）混在工作树里（如 `.gitignore`），加错会把别人的工作卷进你的提交。
> 第 0.6 步的「Tag 文案」与第 1.5 步可能触及同一批文件，重复出现是正常的。

**提交 2——冒烟记录：**

```bash
git add docs/superpowers/notes/2026-09-29-rubric-scoring-smoke.md
git commit -m "docs: 评分体系重构的端到端冒烟记录"
```

---

## 计划对 spec 的两处修正（执行时按本计划，评审时按这里的理由）

| # | spec 原文 | 本计划 | 理由 |
|---|---|---|---|
| 1 | §11 第 4 条：空表的处置写了「写侧拦 + 评分阶段兜底」两条 | 加上**第三条**：表单提交前用同一份 `validateRubric` 拦一次（Task 7 Step 6），且三道守卫的**判据同一份** | 用户在表单上点「确定」却拿到一次往返才回来的「评分标准项不能为空」，是可用性问题；而表单判据若另写一份，就会与写侧漂移（症状：界面放行、后端 400） |
| 2 | §5.1.1「两个按钮都是非流式文本调用」 | 补充一条可执行守卫：`api/src/judge.ts` **不 import** `@aieval/agents`，且入参里没有任何模型 id（Task 5 的两条用例） | 「不用智能体」这句话在代码里必须有一个能被断言的事实，否则日后有人为了「顺便支持智能体生成」加一条分支时没有任何东西会红 |

---

## 已知的旧数据处置（不在本计划内，执行前先做）

`config.json` 里旧用例的 `judgePrompt` 与 `run.json` 里带 `dimensions` 的评分记录**不再兼容**（用户口径：代码必须最干净整洁，不做兼容、不写清理脚本）。
（**终审修复轮按当时的代码重写了这一节**：原稿写的「旧用例在表单里会渲染成空表 / 可以手工把 `judgePrompt` 转成 `rubric` 再保存」两条都已经不成立——`assertUsableRubric` 在**用**这个用例时就把旧用例拒了，编辑保存根本走不到写入。）

> **⚠️ 处置口径（2026-09-30 使用者明确要求，覆盖本节原稿的「删掉这些用例重建」）：旧记录一律原样保留。**
> 本工具**不删除任何历史**——不删旧用例、不删旧轮次目录、不写迁移/清理脚本。下面两条说的都是「你会看到什么」，
> **不是「你该删什么」**：要对旧数据做什么（删旧用例、删旧轮次目录）是**使用者手动决定**的动作，工具既不替你做、也不催你做。
> 读取侧的归一只发生在**内存里**：`loadConfig()` 不校验也不 strip，旧行在盘上仍原样带着 `judgePrompt`；
> `saveConfig` 写回的就是内存里那份对象（重新序列化会归一空白与键序，但**不丢字段**），所以旧行不会被顺手改写成新形状。

- 旧 `run.json` 的 `EvalRunSchema.safeParse` 会失败 ⇒ `readSnapshot` 记一条 per-file WARN 并返回 `null` ⇒ `listRuns` **跳过**那一轮。跳过不再是无声的：`listRuns` 在同一趟扫描的最后再记**一条汇总 WARN**（「有运行快照因评分口径升级不再兼容，已从列表跳过（列表显示的轮次会比磁盘上的少）」+ 条数），使「评测记录凭空少了几轮」与「产物真的没了 / 工作区根目录改错了」在日志里分得开。列表变短本身仍是预期行为；**旧轮次的目录留在盘上不动**（只占磁盘、不影响新评测），要不要清理是使用者手动决定的事，工具不会自动删。
- 旧用例缺 `rubric` ⇒ 它**在「用」的路径上被拒**：`getCase`（详情 / 建评测 / 换用例）与 `updateCase`（编辑）都过 `assertUsableRubric`，抛中文 `INTERNAL`「这个用例是旧版数据（没有评分标准项），请删除它或重新创建：<caseId>」（spec §10 要求的文案；两个出路里「重新创建」不需要动旧记录）。列表路径**故意不拒**（`asStoredCase` 只丢掉契约上已删除的列、对 `rubric` 做一次不抛的 `safeParse`），否则一条旧用例会让整页列表 500、连删掉它的入口都没有——**列表照常列出它，就是为了让使用者能自己决定怎么处置**。**处置：要用它就得新建一份**（旧的那条留在 `config.json` 里不动，工具不会自动删；要清理请手动删）——它不会「在表单里渲染成空表」（详情与编辑都拿不到它），也没法把 `judgePrompt` 手工转成一张 `rubric` 再保存（编辑保存同样先过 `assertUsableRubric`，在写入之前就被拒）。真要在盘上救一条，只能直接改 `config.json`，那是工具之外的手工操作、不由本工具负责。
