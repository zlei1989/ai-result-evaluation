# 01 契约与快照：includeSteps 落进用例与 EvalRun

Status: resolved
Blocked by: （无）

## 任务

把「包含步骤」字段接进契约与落盘链：

1. `packages/server/contracts/src/case.ts`：`TestCaseSchema`（21-39 行）加 `includeSteps: z.boolean()`（放 rubric 附近）；`CaseCreateSchema`（73-80 行）加 `includeSteps: z.boolean().default(false)`。`CasePatchSchema` 由 partial 自动覆盖。
2. `packages/server/api/src/cases.ts`：`createCase` 组装（约 187-197 行）与 `updateCase`（约 266-277 行）透传该字段；`asStoredCase`（约 155-172 行）**旧文件缺列兜底 `?? false`**。
3. EvalRun 快照：`packages/server/contracts/src/run.ts` 的 EvalRun schema 加 `includeSteps: z.boolean()`；run 创建侧（`packages/server/api/src/runs.ts`，rubric 快照链同处，参考 docs/features/judging.md 的「TestCase.rubric → EvalRun.rubric」口径）把用例值快照进 EvalRun。rescore 沿用快照值。
4. 读侧：`apps/web-next` 路由与 client hooks 由 zod 契约自动覆盖，无需改。

## 验收

- `pnpm typecheck` → `pnpm lint` 全绿；`pnpm vitest run packages/server/contracts/src/case.test.ts packages/server/contracts/src/run.test.ts packages/server/api/src` 相关用例绿（run 测试量不小，先跑单文件再跑包）。
- 用例钉住：旧用例文件缺 `includeSteps` 键 → 读作 false；创建缺省 false；EvalRun 快照值来自开跑时用例、之后改用例不影响。
- 新守卫做变异验证（缺列兜底守卫：把 `?? false` 去掉看测试红，再还原）。

## Comments

先读 `docs/features/case-management.md`（数据与契约表 133-145 行）与 `docs/features/judging.md`（快照链 20-24 行）对齐既有口径。
