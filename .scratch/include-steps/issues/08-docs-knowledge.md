# 08 知识库回写与口径修订

Status: resolved
Blocked by: 04, 06

## 任务

按「关账回写 + 终态口径」修订知识库与代码注释（只写现时行为，不写改动史、日期、哈希）：

1. `docs/features/case-management.md`：表单字段表（32-42 行）与数据契约表（133-145 行）加「包含步骤」字段（语义、默认 false、快照链）。
2. `docs/features/judging.md`：两条评分通路的评分上下文各加执行过程记录一节（文本通路协议附件 + diffBudgetBytes 截断头尾保留；智能体通路绝对路径 + extraReadPaths + claude additionalDirectories 映射）；快照链补 includeSteps。
3. `docs/protocols/provider-run.md`（约 73 行权限表附近）与 `packages/server/agents/README.md`（约 165 行权限表）：补 extraReadPaths 一格（语义、只 claude 消费、codex/dsh 读已放行）。
4. `packages/server/api/src/judge.ts`（约 160 行）：「评分模型只会看到候选的代码改动（diff），看不到任何对话过程」声明改为条件口径——默认如此；用例开启「包含步骤」后评分阶段可见执行过程记录。
5. GLOSSARY.md 两条术语已存在（「包含步骤」「执行过程记录」），检查是否需要与实现对齐微调。

## 验收

- `pnpm typecheck` → `pnpm lint` 全绿；`pnpm vitest run docs`（知识库守卫）绿；`pnpm docs:build` 不红（若改动影响构建）。
- 终态口径自查：新文字里没有日期、票号、变更史、实测叙述。

## Comments

先读 `docs/features/case-management.md` 与 `judging.md` 现状及 04/06 合并后的代码形状。知识文章写使用视角（读者是「要用这个功能的人」）。
