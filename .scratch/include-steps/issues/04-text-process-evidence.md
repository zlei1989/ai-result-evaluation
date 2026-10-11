# 04 文本通路：执行过程记录以附件块接入评分

Status: resolved
Blocked by: 03, 07

## 任务

1. `packages/server/evaluator/src/judge.ts`：`JudgeInput` 加可选证据字段（07 票产出形状：`{files: [{name, content}]}` 已按 diffBudgetBytes 截断）。开关开启时在 diff 附件之后追加证据附件（events.jsonl；codex 候选再加 messages.jsonl），附件名分别为 `events.jsonl` / `messages.jsonl`；缺省（开关关 / 未给）时不追加任何内容，行为与现状逐字一致。
2. 修复轮沿用同一附件形态重发（意图 + diff + 证据全量）。
3. 评分上下文不因证据存在而改动既有意图文本与 `JUDGE_OUTPUT_CONTRACT`。

## 验收

- `pnpm typecheck` → `pnpm lint` 全绿；judge.ts 相关测试绿：开/关两态、codex 双附件、截断标注透传。
- 新守卫做变异验证（把证据附件在开关开启时丢掉看测试红，再还原）。

## Comments

先读 03 票合并后的 `judge.ts` 与 `text-api.ts` 现状，以及 07 票的 `assembleProcessEvidence` 形状。本票不读磁盘、不截断——只消费 07 的产物。
