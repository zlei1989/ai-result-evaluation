# 03 文本通路重构：diff 与证据以协议附件形态分开输入

Status: resolved
Blocked by: （无）

## 任务

把文本 API 通路从「三段拼一条 user 消息」重构为「意图消息 + 附件」，附件机制本身与「包含步骤」开关无关：

1. `packages/server/evaluator/src/text-api.ts`：
   - `ChatMessage.content` 从纯字符串扩展为「字符串 | 内容块数组」的判别形状（保持字符串形态向后兼容——`api/src/judge.ts` 三按钮与既有调用不走附件）。
   - `buildBody`（212-232 行，全仓唯一构造点）两协议分支拼附件：
     - anthropic：user 消息 content 数组 = `[{type:'text',text:意图}, {type:'document',source:{type:'text',media_type:'text/plain',data:全文}}]`（`@anthropic-ai/sdk@0.124.0` 类型证据：messages.d.ts 1748/1772-1782/2089-2093 行；cache_control 暂不做）。
     - openai：content parts = `[{type:'text',text:意图}, {type:'file',file:{file_data:base64全文, filename}}]`（openai 6.40.0 类型证据：completions.d.ts 559-589/1167-1175 行）。
2. `packages/server/evaluator/src/judge.ts`：`buildJudgePrompt`（348-360 行）改为产出「意图文本（题面+评分标准表）+ diff 附件（filename 形如 `candidate-diff.txt`）」，消息组装与修复轮沿用新形状；`JUDGE_OUTPUT_CONTRACT` 与解析逻辑不动。
3. 附件内容不做截断逻辑（diff 已按 diffBudgetBytes 裁剪好传进来）；截断留给 04/07。

## 验收

- `pnpm typecheck` → `pnpm lint` 全绿；`packages/server/evaluator/src` 相关测试绿（buildBody 两协议形状、字符串形态不变、judge.ts 组装）。
- 现有依赖该通路的测试（judge-route 等）全部更新后仍绿；`api/src/judge.ts` 三按钮调用路径行为不变（有用例钉住）。
- 新守卫做变异验证（把附件块从 body 里去掉看测试红，再还原）。

## Comments

先读 `text-api.ts` 文件头 6 条注释（请求体唯一构造点的防漂移判据）与 182-196 行（DeepSeek 网关未实测口径）。不动 `max_tokens` 与 `parseOpenAI/parseAnthropic`。网关对附件形态的支持验证在 09 票做探针，本票只落机制。
