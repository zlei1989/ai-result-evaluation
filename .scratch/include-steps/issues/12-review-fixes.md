# 12 代码审查修复

Status: resolved
Blocked by: （无）

## 任务（按审查报告逐条处理）

**硬违规（必改）**：
1. 票号进注释，违反 AGENTS.md 终态口径——三处删票号、改终态表述：
   - `packages/server/evaluator/src/process-evidence.ts:2,13`（「票 07 的产物，04/06 按此消费」）
   - `packages/server/evaluator/src/judge-agent.ts:235`（「（05 的 extraReadPaths）」）
   - `packages/server/evaluator/src/judge-agent.test.ts:55`（「口径来自规格 §4 与票 06」）

**判断性意见（修或给出书面理由）**：
2. `ProcessEvidenceFile.truncated` 生产只写不读（Speculative Generality）→ 在截断发生时用它打一条 DEBUG 日志（`createLogger` 口径：上下文作第二参数透传，不 JSON.stringify），让它有生产消费方；或删字段+删测试。倾向前者。
3. `judge-agent.ts` 的 `evidenceFileLabel` if-链与 `assembleProcessEvidence` 的元数据判定重复（Repeated Switches，轻）→ 合并成一张「协议文件名 → 中文标签」映射表，两处共用。
4. `.scratch/include-steps/probe/attachment-gateway.mjs` 头注释写「附件经 wireContent 翻成 document/file_data」已与终态漂移 → 补一句探针结论与终态（text 块降级），注明探针留作网关升级后的复验工具。
5. `truncateRawLines`（evaluator 按行头尾保留）与 `core/git.ts` 的 `truncateDiff`（按文件段）重复 → **不改 core**（稳定且已测，保留策略本就不同）；在 process-evidence.ts 该函数处补一段注释说明「与 truncateDiff 同预算口径、保留策略不同（行级头尾 vs 文件段），刻意不复用」——判定性意见的书面理由。

**Spec 缺口（必改）**：
6. 规格 §4 措辞与实现对齐：`.scratch/include-steps/spec.md` 的「仅在开关开启时追加一段」改为「开关开启**且证据文件存在**时追加一段」（实现以证据非空为条件，指向不存在文件没意义）。注意 docs 守卫禁止产品代码/知识库引用 .scratch，但 spec.md 是过程档案不受限。
7. **重跑终态形态的真机冒烟（文本通路）**：票 11 之后文本通路已改全 text 块，票 09 的冒烟是降级前的 document/file 形态。请在 `.worktrees/` 里起新实例（3083 被并行会话占用时用 `pnpm --filter @aieval/web-next exec next dev -p 3084`），建用例开「包含步骤」跑一次**文本评分** run，验证证据 text 块真的到达评委：判据 = judge 侧 usage 输入 token 显著大于关闭开关的对照（或评委输出里能对上证据内容/哨兵）。结果**追加**到 `.scratch/include-steps/smoke.md`（四要素，含日期）。若真机条件不足（网关/供应商不可用），按「跳过+理由」记录，不得伪造。codex 双附件真机若条件具备也顺手覆盖，不具备照实记录。
8. 绊线计数 19→20 那笔提交（0c329a5/08d6dd3）是基线上既有错位的关账修补，与特性无关但必要——**不改代码**，仅在结案报告里说明（本票无需动作）。

## 验收

- `pnpm typecheck` → `pnpm lint` 全绿；受影响包测试绿；`pnpm vitest run docs` 绿。
- 硬违规 1 清零：grep 全仓确认票号（票 07/05/06、`04 文本通路` 这类）不再出现在产品代码注释与测试注释里。
- 冒烟追加记录完整。

## Comments

先读 `.scratch/include-steps/probe/REPORT.md`、`DIAGNOSIS.md` 与现有 `smoke.md`，理解真机判据。提交逐个显式 `git add <路径>`；.scratch 用 `git add -f`；禁止 -A。收尾 `git merge feat/include-steps --no-edit`。
