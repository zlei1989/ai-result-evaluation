# claude 子会话自己的用量（逐轮）实现计划 — 2026-10-05

> **执行方式**：subagent-driven-development（每任务一个实现者、逐任务过审、终审一次）。
> **设计**：`docs/superpowers/specs/2026-10-01-agent-message-spec-design-v3.md` §4.1 步骤 5.1 的「读法三条」（本计划的权威；本线的过程 spec 已并入该文档并从库中删除）。
> **上一轮计划**：`docs/superpowers/plans/2026-10-05-usage-turn-attribution.md`（归属机制已交付：契约 `turn`、
> 三家适配器、界面按「会话 + 号」归位）。**本次只补「子会话自己那一份」**，codex 暂缓。

## 0. 全局约定（每个任务都适用）

- **TDD**：先写失败用例 → 跑出红线（贴原文）→ 实现 → 跑绿 → **变异验证**（把要拦的缺陷造回去，确认用例红，
  再还原并核对哈希）→ 提交。没有见过失败的守卫不算守卫。
- **命令**：`pnpm.cmd`（本机 `pnpm.ps1` 被执行策略拦）；**根级聚合 vitest 会卡死**（三次实测）⇒ 一律包级/文件级：
  `pnpm.cmd --filter @aieval/agents exec vitest run src/providers/claude-code/subagent-usage.test.ts`。
  任何命令 >3 分钟无输出就杀掉换更窄的。
- **提交**：逐个显式 `git add <路径>`，**禁止 `-A`**；`git status` 里并发会话的文件原样不动
  （`providers/codex/appserver/**`、`docs/superpowers/specs/2026-10-01-…v3.md`、它的 notes/plan）。
- **门禁顺序**：`pnpm.cmd typecheck` → `pnpm.cmd lint`（仓库级 typecheck 会红在并发会话未跟踪的
  `codex/appserver/client.test.ts` 的 3 条 TS2741 上——**那不是本次的**，只核对本次改动的文件零 error）。

---

## Task 1：读盘层改成「流式 + 逐轮明细 + 同版本不重复解析」

**文件**：`packages/server/agents/src/providers/claude-code/subagent-usage.ts`（+ `.test.ts`）

**要交付**（spec §2.2 三条）：

1. `readOne` 不再 `readFileSync(整份)` + `text.split('\n')`，改成**逐行消费**（`createReadStream` + 行切分），
   峰值内存从「整份 + 行数组」降到「最大单行」；解析规则**逐字保留**：只认 `type === 'assistant'`、
   `message.id` 去重后到覆盖、三项齐全才认、认得却读不全 ⇒ 整份作废、半截行跳过。
2. 返回值扩展 `rounds: { round: number; tokens: UsageTokens }[]`：`round` 按 `message.id` 的**首次出现顺序**编号 1..N，
   `tokens` 是**该轮自己的**三项（累计由调用方按需算）。现有 `usage` / `turns` 的语义与数值**逐字不变**。
3. 「路径 + size + mtime」→ 解析结果的小缓存（**run 作用域**，不是模块级）⇒ 同版本不二次解析；版本变了才重读。

**Step 1（失败用例）** 在 `subagent-usage.test.ts` 加：

- ① **走的是流式**：`vi.spyOn(fs, 'createReadStream')` 断言被调用、`vi.spyOn(fs, 'readFileSync')` 断言**没被调用**
  （这条钉的是「不许整份进内存」，改回 `readFileSync` 必须红）；
- ② **逐轮明细**：同一份夹具（3 个 `message.id`，其中一个出现两次且后到覆盖）⇒ `rounds` 是 3 条、
  `round` 依次 1/2/3、第 3 条的 `tokens` 是**覆盖后**的值；
- ③ **同版本不重复解析**：同一 `(路径, size, mtime)` 连读两次 ⇒ 第二次不再触发读流（spy 计数为 1）；
  把文件追加一行（size/mtime 变）⇒ 第三次**重新**读；
- ④ **等价性**：`usage` / `turns` 与该文件既有夹具的期望**逐字相同**（改前改后一个数都不许变）。

**Step 2** 跑出红线：`pnpm.cmd --filter @aieval/agents exec vitest run src/providers/claude-code/subagent-usage.test.ts`
（① 会因为还在用 `readFileSync` 而红；② 会因为 `rounds` 不存在而红/编译失败）。**贴原文进报告。**

**Step 3** 实现（流式 + `rounds` + 缓存）。**注意**：`readClaudeSubagentUsage`（全量、收尾用）与
`readClaudeSubagentFile`（单个、收场帧用）两个读者的**读数规则仍只有 `readOne` 一条**——不许各写一份。

**Step 4** 跑绿：上面那条命令 + `pnpm.cmd --filter @aieval/agents exec vitest run src/providers/claude-code`
（整个 claude 适配器目录，确认 7 条规则与既有的 `missing` / `unjudged` 语义都没动）。

**Step 5 变异验证（3 个变异体，逐个见红后还原并核对哈希）**：

- M1 `readOne` 改回 `readFileSync` + `split('\n')` ⇒ 守卫 ① 红；
- M2 去掉缓存 ⇒ 守卫 ③ 红；
- M3 `rounds` 只返回一条合计 ⇒ 守卫 ② 红。

**Step 6** 提交（`git add` 那两个文件）。

---

## Task 2：claude 收尾发出「子会话逐轮读数」事件

**文件**：`packages/server/agents/src/providers/claude-code/index.ts`（+ `.test.ts`）
**依赖**：Task 1 的 `rounds`。

**要交付**（spec §2.1）：

- 收尾（`finalize`）里，对**每个**子会话、**每一轮**发一条 `usage` 草稿：
  `turn = { subagentId: <该子会话身份（agentId/Wire id 同值）>, round: k }`，
  `tokens` = 该子会话**到此为止的累计**（前 k 轮之和，单调不减）；
  `turns` 仍填**本行合计**（契约语义：这一行跑到第几轮），`subagentTokens` / `subagentTurns` 照旧；
- **不污染结果**：`result.tokens` / `subagentTokens` / `subagentTurns` 与改前逐字相同（这些草稿只是事件）；
- 读不全（`usage === null`）⇒ **一条都不发**（与「全量或 null」同一条口径，绝不发部分和）。

**Step 1（失败用例）** 在 `index.test.ts` 加：

- ① 收尾后事件流里有 N 条 `type: 'usage'` 带 `turn.subagentId === <子会话 id>`、`round` 依次 1..N、`tokens` 单调不减；
- ② 同一次收尾的 `result.tokens` / `subagentTokens` / `subagentTurns` 与既有期望**逐字相同**（不许被草稿影响）；
- ③ 读不全（夹具：文件空/三项不全）⇒ 该子会话**一条读数都不发**（且仍走既有的点名 WARN 路径）。

**Step 2** 跑红：`pnpm.cmd --filter @aieval/agents exec vitest run src/providers/claude-code/index.test.ts`。

**Step 3** 实现（在收尾已有的那次读取结果上造草稿；**不再多读一次盘**）。

**Step 4** 跑绿：上面那条 + 整个 `src/providers/claude-code` 目录。

**Step 5 变异验证**：M1 只发一条合计（不发逐轮）⇒ ① 红；M2 把子会话读数写进 `result.tokens` ⇒ ② 红；
M3 读不全时照发部分和 ⇒ ③ 红。

**Step 6** 提交。

---

## Task 3：界面里程碑水位**按会话拆开**（+ 端到端）

**文件**：`packages/client/ui/src/composite/agent-log/build-model.ts`（+ `build-model.test.ts`、
`agent-message-timeline.test.tsx`）
**独立于 Task 1/2**（可并行）。

**要交付**（spec §2.3）：`rowEventsOf` 的 `highWater` 从「整行一个」改成 `Map<sessionKey, highWater>`
（`sessionKey = turn?.subagentId ?? 'main'`；没有 `turn` 的老事件落 `main` 桶）。

**Step 1（失败用例）**：

- ① **子会话读数不被主会话水位丢掉**：主会话先抬到高位（例如 50k 累计），随后子会话从 1k 涨到 3k ⇒
  子会话那两条**都要成为里程碑**（现有实现会全丢）；
- ② **老日志逐字不变**：一份没有 `turn` 格的 `usage` 序列（递增 + 重复）⇒ 里程碑集合与今天**逐字相同**；
- ③ **端到端**（`agent-message-timeline.test.tsx`）：子会话节点（`sub-1`）显示它自己的逐轮用量行、
  主会话节点**不**显示子会话那几条（正反两面都要断言）。

**Step 2** 跑红：`pnpm.cmd --filter @aieval/ui exec vitest run src/composite/agent-log/build-model.test.ts`。

**Step 3** 实现（水位按会话拆）。**注意**：孤儿回落、`homes` 可达性、文案用归属号**都不动**。

**Step 4** 跑绿：上面那条 + `pnpm.cmd --filter @aieval/ui exec vitest run src/composite/agent-log`。

**Step 5 变异验证**：M1 水位改回整行一个 ⇒ ① 红；M2 把 `sessionKey` 恒取 `'main'` ⇒ ① 红（且 ③ 的反面红）。

**Step 6** 提交。

---

## Task 4：门禁 + 真机冒烟 + 记录

**Step 1 门禁**：`pnpm.cmd typecheck`（只有并发会话那 3 条 TS2741 才能红）、`pnpm.cmd lint`（exit 0）、
包级测试：`@aieval/agents`（claude-code 目录）+ `@aieval/ui`（agent-log 目录）+ `@aieval/contracts`。
**根级聚合与 evaluator 不跑**（已知卡死：`vi.mock` 工厂 + 静态 import 成环，22 个文件从未跑完——如实登记，不写成通过）。

**Step 2 真机冒烟**（一轮，真实用户路径）：

- 在 `http://localhost:3083` 上跑一轮「简单测试」（提示词要求派子智能体），三行里**重点看 claude 行**；
- 判据：① claude 行的**子会话节点**出现**它自己的**逐轮用量行（`round-1…N`，与它自己的轮次号一致）；
  ② 主会话节点**不出现**子会话那几条；③ 子会话读数的**数值**与磁盘 `<configHome>/projects/…/subagents/agent-<id>.jsonl`
  逐轮求和互证；④ 主会话那几条与改前同形（不受影响）。
- 用 `browser_evaluate` 读 `[data-turn-row]` + `.ant-tag`（**虚拟滚动要步进合并**，见上一轮冒烟记录 §3）；
- **浏览器是共享的**：只新开自己的标签页，不动别人的。

**Step 3 记录**：`docs/superpowers/notes/2026-10-05-claude-subagent-own-usage-smoke.md`，按 AGENT.md 的四要素写
（① 范围清单 ② 操作路径 ③ 证据（DOM 原文 + CLI 互证）④ 未覆盖项）。**未覆盖项**至少写：
codex 未做（用户明示暂缓）、子会话读数只在收尾出现、跑动期仍无估算（流里 `output` 恒 0）、
`evaluator` 那 22 个文件未跑完的原因。

**Step 4** 提交记录文件。

---

## 收尾

- 逐任务过审（每任务一个审查者：spec ✅ / 任务质量 Approved|Needs fixes）；终审一次全分支范围；
- 终审后按 SDD 删工作区（`.superpowers/sdd/2026-10-05-claude-subagent-own-usage/`），判据与裁定进最终回复；
- **不做**：codex（暂缓）、抽屉事实条的按会话拆分（行级口径，另议）、契约改动。
