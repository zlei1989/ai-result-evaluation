# 06 智能体通路：执行过程路径写进评委提示词 + extraReadPaths 透传

Status: resolved
Blocked by: 05, 07

## 任务

1. `packages/server/evaluator/src/judge-agent.ts`：`AgentJudgeInput`（63-111 行）加可选证据字段（07 票产出：`{paths: [{path, label}]}`，label 如「执行过程记录 events.jsonl」「候选消息记录 messages.jsonl」）。
2. `buildAgentJudgePrompt`（118-146 行）：既有段落**逐字不动**，仅当证据非空时**追加**一段「## 候选的执行过程」：列出每个绝对路径与它是什么，并给读取指引——用 Read/cat 读文件、文件可能很大先看结构再按需读、评分标准涉及过程时结合记录判定。**不做截断**。
3. run 调用（180-210 行）：把证据路径透传进 `extraReadPaths`（`input.extraReadPaths: evidence.paths.map(p => p.path)`），与 `permission:'read-only'`、cwd、configHome 并列。

## 验收

- `pnpm typecheck` → `pnpm lint` 全绿；`judge-agent.test.ts` 相关测试绿：开/关两态、路径段落与读取指引、extraReadPaths 透传。
- 新守卫做变异验证（把 extraReadPaths 透传删掉看测试红，再还原）。

## Comments

先读 05 票合并后的 `types.ts` 与 `judge-agent.ts` 现状、07 票的产物形状。评委 cwd 是行工作区，events.jsonl 在 cwd 父目录（core/src/workspace.ts 口径），claude 靠 additionalDirectories 放行、codex/dsh 本身可读——提示词里统一给绝对路径即可，不区分评委厂商。
