# 11 文本通路降级：全 text 块分块输入（删除 document/file 协议附件）

Status: resolved
Blocked by: （无）

## 背景（终态事实，已真机验证）

DeepSeek 系端点（官方 api.deepseek.com 与 likecode 网关）**不实现协议附件**：anthropic `document` 块被官方替换成 `[Unsupported Document]` 占位、被 likecode 静默丢弃；openai `file` part 被显式 400（`content.type 取值范围 ['text']`）。而**独立 text 块**在两协议三端点全部真机 PASS（哨兵词复述判据，证据在 `.scratch/include-steps/probe/DIAGNOSIS.md`）。用户已拍板**方案 1：全分块**——意图块 / diff 块 / 证据块全部用独立 text 块分开输入，删除 document/file 翻译。

## 任务

1. `packages/server/evaluator/src/text-api.ts` 的 `wireContent`（附件块唯一翻译点）：
   - `{type:'attachment', text, filename}` 两协议统一翻成 `{type:'text', text: '## ' + filename + '\n\n' + text}`（块标题用 filename；如需中文语义名可在块上扩展 label 字段，但改动要最小）。
   - **删除** anthropic `document`/`PlainTextSource` 分支与 openai `file`/`file_data` base64 分支（含 base64 编码逻辑与相关注释）。
   - `{type:'text'}` 块与字符串 content 的向后兼容路径**逐字保留**（api/src/judge.ts 三按钮与既有调用依赖字符串形态）。
2. `packages/server/evaluator/src/judge.ts` 与 `process-evidence.ts`：块结构（意图 + diff 附件 + 证据附件）不用改，只确认标题/顺序语义与 wireContent 新翻译配套。
3. `packages/server/evaluator/src/text-api.test.ts`：附件形状用例从 document/file 期望改为 text 块期望（含标题行）；删除 base64 相关断言；字符串形态与混合用例保留。
4. `packages/server/evaluator/src/judge.test.ts`：协议中立断言保持；如有针对 document/file 的断言同步改。
5. 文档回写（终态口径，只写现时行为）：
   - `docs/features/judging.md`（票 08 写了「anthropic document / openai file part 翻译点」与探针守卫句子）：改为「意图/diff/证据以独立 text 块分开输入（两协议三端点真机可用）；document/file 协议附件在 DeepSeek 系端点不支持（探针记录在 .scratch，判据=哨兵复述）——网关将来支持后重跑探针再议」。
   - 检查 docs/ 其他位置是否有 document/file 附件描述（grep document、file part、PlainTextSource、base64），有则同步。
6. 截断口径维持现状：文本通路证据内容已由票 07 按 `diffBudgetBytes` 截断；智能体通路读原文不截断。

## 验收

- `pnpm typecheck` → `pnpm lint` 全绿；evaluator 包相关测试全绿；`pnpm vitest run docs` 绿；`pnpm docs:build` 不红。
- 新守卫变异验证（如：attachment 块被翻成 document 的旧分支残留 → 测试红；文本标题行丢失 → 测试红）。
- grep 全仓确认生产代码无 document/file 附件残留（探针脚本 .scratch 里的是诊断记录，不算）。

## Comments

先读集成 tip 上票 03/04/07/08 的现状与 `.scratch/include-steps/probe/DIAGNOSIS.md` 的三端点矩阵。gateway 探针脚本（attachment-gateway.mjs / diagnose-endpoint.mjs）保留原样，作为网关升级后的复验工具。
