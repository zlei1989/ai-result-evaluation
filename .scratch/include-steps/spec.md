# 用例「包含步骤」+ 执行过程接入评分

需求原文：在评分标准下面、来源类型上面，增加一个「包含步骤」。评分标准也涉及模型的每一步的推理过程。如果是智能体评分，就在提示词里写清楚查看过程的方法（events.jsonl 要写绝对路径）；如果不使用智能体评测，把 events.jsonl 内容直接贴入上下文（以附件形式）。

经设计访谈（grilling）定稿的共享理解如下，是唯一权威口径。

## 1. 领域决定

- 用例表单在**评分标准项 Card 与来源类型之间**新增 `Switch` 字段「包含步骤」，带 extra 说明；列表/详情不展示。
- 语义：**单一开关**。开启 = 评分阶段把候选的**执行过程记录**纳入评分证据，评分标准可针对每一步推理给分；关闭 = 现状（评分只看最终改动）。只影响评分阶段，不影响考题提示词与执行阶段。
- 契约 `includeSteps: z.boolean()`，创建缺省 `false`；与 rubric 同链**快照进 EvalRun**（rescore 沿用快照）；旧用例/旧 run 文件缺列按 `false`。
- 智能生成 / 智能识别 / 智能调整三按钮行为不变。

## 2. 执行过程记录（证据本身）

- 组成：`events.jsonl` **raw 原文**（行级事件账本）；候选 `agentKind === 'codex'` 时**追加** `messages.jsonl` raw 原文（codex 的思考全文与工具结果正文结构性不进事件流）。
- 「codex 需要补 messages.jsonl」是厂商差异，作为能力声明收在 agents 包（provider 注册表 metadata），evaluator 通过 `getProvider(kind)` 查询，不硬编码厂商名。

## 3. 文本通路（useAgentJudge=false）

- **重构** `buildJudgePrompt` 与 `text-api.ts`：意图消息只留【题面 + 评分标准表】；**diff 成为独立 text 块**（对所有文本评分生效，与开关无关）；开关开启时再追加【执行过程】text 块（codex 候选多一个 messages.jsonl 块）。
- 送达形态是**独立 text 块**（两协议统一：anthropic content 块数组 / openai content parts，块标题 `## <filename>`）。document/file 协议附件在 DeepSeek 系端点不可用（官方端点替换成占位、likecode 网关静默丢弃、openai 显式 400，哨兵词复述判据）——已用探针验证并记录在案；网关将来支持协议附件块后再重跑探针另议。
- 截断：按 `settings.diffBudgetBytes`（字节、`Buffer.byteLength`），逐行裁剪、**头尾保留 + 显著标注**截断位置。
- 结构修复轮沿用同一分块形态重发。
- `api/src/judge.ts` 三按钮（生成/识别/调整）调用路径不变。

## 4. 智能体通路（useAgentJudge=true）

- `AgentRunInput` 加可选字段 `extraReadPaths?: string[]`（绝对路径，read-only 权限下额外放行的只读路径）。
- 三家映射：**claude** → `additionalDirectories`（SDK 官方字段，编译成 `--add-dir`，与 `dontAsk` 兼容；窄壳 `ClaudeQueryOptions` 同步加）；**codex** → 不映射（read-only 沙箱全盘可读）；**dsh** → 不映射（read-only 只拦写、读全放行）。
- `buildAgentJudgePrompt` 既有段落**逐字不动**，仅在开关开启**且证据文件存在**时**追加**一段：执行过程记录在 `<绝对路径>`（codex 候选两个路径），用 Read/cat 读取、文件可能很大、先看结构再按需读。**不截断**。

## 5. 扩展 run 的澄清四问（AGENTS.md 要求）

1. **要加什么**：`AgentRunInput.extraReadPaths?: string[]`——read-only 权限下额外放行的只读路径。
2. **现有形状为什么不够**：三家 read-only 语义不等价；claude `dontAsk` 只放行工作目录内读，`events.jsonl` 在 cwd 父目录被拒，现无注入口。
3. **动到哪几家与哪些消费方**：agents（types.ts、claude-code 的 sdk.ts 窄壳 + index.ts）；codex/dsh 不动；生产侧唯一 read-only 消费方是 evaluator/judge-agent.ts（+ orchestrator 传参）。
4. **旧数据怎么读**：纯可选字段，缺省不传；现有全部 run 调用点（候选执行、case-sync、夹具、探针）不传时行为逐字不变。

## 6. 文档与术语回写

- GLOSSARY.md 已加「包含步骤」「执行过程记录」两条（已提交于 3687d15）。
- `docs/features/case-management.md`（表单字段表 + 契约表）、`docs/features/judging.md`（两条通路的评分上下文 + 快照链 + 截断口径）、`docs/protocols/provider-run.md` 与 agents README 权限表（extraReadPaths 一格）。
- `api/src/judge.ts:160` 「评分模型看不到对话过程」声明改为条件口径（默认看不到；开启「包含步骤」后可见执行过程记录）。
- 终态口径：知识文章只写现时行为，不写改动史。

## 7. 测试与冒烟

- 契约：includeSteps 默认/校验/旧文件兜底；EvalRun 快照链。
- UI：开关渲染、提交映射、编辑回显。
- 文本通路：意图/附件分离、两协议形状、截断标注、codex 双附件、修复轮重发。
- 智能体通路：prompt 追加与 `extraReadPaths` 透传；permission 测试钉「extraReadPaths 不改三档落点」；claude 侧钉 `additionalDirectories` 转发与 read-only 共存。
- 新增回归守卫必须做**变异验证**（造缺陷→看红→还原）。
- 冒烟：建用例开开关 → 文本评分与智能体评分各跑一次 → 磁盘与评分上下文互证，记录落 `.scratch/include-steps/smoke.md`（四要素）。
- 网关附件探针先行：不通过则评分附件形态不得启用。
