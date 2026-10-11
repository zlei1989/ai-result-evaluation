# 07 编排组装：评分阶段读快照、拼执行过程证据（含截断）

Status: resolved
Blocked by: 01, 05

## 任务

在 `packages/server/evaluator/src/orchestrator.ts` 评分阶段组装执行过程证据，产出 `assembleProcessEvidence(ctx)`（或等价函数），供 04（文本通路消费 content）与 06（智能体通路消费 path）使用：

1. 读 `EvalRun.includeSteps` 快照：false → 返回空证据。
2. true → 读 `events.jsonl` raw 原文：路径 `rowEventsFile(run.workspaceBase, runId, rowId)`（core/src/workspace.ts:83-85，orchestrator 已 import）；读文件用 core 的读取函数（core/src/event-log.ts 的 readEvents 或按行读原文——**要 raw 原文**，不做事件解析）。
3. 候选为 codex（用 `getProvider(row.agentKind).metadata.needsMessagesForReasoningEvidence` 判定，勿硬编码）→ 追加 `messages.jsonl` raw 原文（行级 messages 文件，路径参照 core/src/workspace.ts:95 的 rowMessagesFile 一类函数；读 raw）。
4. 截断：按 `settings.diffBudgetBytes`（字节、`Buffer.byteLength`），**逐行裁剪、头尾保留、中间截断处显著标注**（如「…（中间 N 行已截断，预算 X 字节）…」）；截断在内容进入评分上下文前完成，两通路共用同一份截断产物。
5. 传参：文本通路 `JudgeInput` 与智能体通路 `AgentJudgeInput` 的字段名/形状由本票定义（04、06 按此消费）。

## 验收

- `pnpm typecheck` → `pnpm lint` 全绿；orchestrator 相关测试绿：开关关=空证据、开关开=events 原文、codex 双文件、截断标注与预算单位（字节）、非 codex 只有 events。
- 新守卫做变异验证（把 codex 判定换成硬编码字符串看测试红；把截断标注删掉看测试红，再还原）。

## Comments

先读 01、05 票合并后的契约与 metadata 形状；评分上下文组装位置参考 JudgeStageContext（orchestrator.ts:357-378）与 runJudgeStage（631-759）。**不在本票改 judge.ts / judge-agent.ts 的消费逻辑**（那是 04/06）。settings 读取沿用 evaluator 现有取法。
