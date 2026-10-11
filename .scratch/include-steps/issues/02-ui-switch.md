# 02 用例表单：评分标准项与来源类型之间加「包含步骤」Switch

Status: resolved
Blocked by: 01

## 任务

1. `packages/client/ui/src/composite/case-form-panel.tsx`：在评分标准项 Card（约 453 行结束）之后、来源类型 Form.Item（约 473 行）之前插入 `Form.Item label="包含步骤"`，内容为 antd `Switch`（Form.Item + Switch 需要 `valuePropName="checked"`），`extra` 写说明：「开启后评分阶段会读到候选的执行过程记录，评分标准可针对每一步推理给分；关闭时评分只看最终改动」。
2. `CaseFormValues`（91-101 行）加 `includeSteps: boolean`；`initialValues`（338-349 行）加 `includeSteps: false`；`handleFinish`（321-332 行）归一透传。
3. 编辑模式回显该字段（initialValues 来源里带上）。

## 验收

- `pnpm typecheck` → `pnpm lint` 全绿；ui 包相关测试绿（开关渲染、提交值、编辑回显 false/true）。
- antd 用法符合 AGENTS.md 约束（不手写字号/边距，不裸写 div）。
- 新守卫做变异验证（把 valuePropName 去掉看测试红，再还原）。

## Comments

先读 `packages/client/ui/src/composite/case-form-panel.tsx` 的 71-101 行（SourceKind 与 CaseFormValues）与 320-360 行（handleFinish/Form 结构），照现有字段风格写。写 UI 前按 AGENTS.md 用 context7 查 antd 6 Switch/Form.Item 用法。
