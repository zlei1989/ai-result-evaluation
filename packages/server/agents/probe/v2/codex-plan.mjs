/**
 * codex 真机项①：**`update_plan` / `request_user_input` 到底以哪种 `item.type` 出现在事件流里**
 * （设计稿 §7.3.1 与 §11.1 第 23 项的"三个候选，不得推断"）。
 *
 * 设计稿的现状：
 *  - `update_plan` 存在于工具表 ✅ 已证；输入是 `{explanation?, plan:[{step,status}]}` ✅ 已证；
 *  - 但它**以哪种 `item.type` 出现在 `exec --json` 事件流里** ❌ 未验证；
 *  - `todo_list` 与 `update_plan` 是否同一个东西 ❌ 未验证。
 *
 * 本脚本把两个配置开关按设计稿 §7.6.2 的口径打开后跑一条**明确要求先做计划**的任务，
 * 逐条 dump 事件；判据是 `item.type` 的**全集**，不做推断。
 */
import { note, writeDump } from './lib/gateway.mjs';
import { codexConfig, itemShapes, makeCodexWorkspace, runCodexProbe } from './lib/codex.mjs';

const workspace = makeCodexWorkspace('codex-plan');
note('工作区 =', workspace);

const prompt = [
  '这是一个多步任务，请**先制定计划**再执行：',
  '1. 用 update_plan 工具提交一份三步计划（第一步 in_progress，其余 pending）；',
  '2. 然后按计划逐步完成：读取 notes.txt、统计它的行数、把行数写进 answer.txt；',
  '3. 每完成一步就用 update_plan 更新一次计划状态；',
  '4. 最后用一句话汇报。',
].join('\n');

const run = await runCodexProbe({
  label: 'codex-plan',
  prompt,
  workspace,
  config: codexConfig({
    extraTools: { update_plan: { enabled: true }, experimental_request_user_input: { enabled: true } },
    extraFeatures: { default_mode_request_user_input: true },
  }),
});

note('===== item 形状全集 =====');
for (const [key, value] of itemShapes(run.events)) {
  note(`· ${key} × ${value.count}`);
  note(`    字段: ${value.keys.join(', ')}`);
  note(`    样本: ${JSON.stringify(value.sample).slice(0, 500)}`);
}

const allItemTypes = [...new Set(run.events.map((event) => event?.item?.type).filter(Boolean))];
const allEventTypes = [...new Set(run.events.map((event) => event?.type).filter(Boolean))];
note('item.type 全集 =', JSON.stringify(allItemTypes));
note('event.type 全集 =', JSON.stringify(allEventTypes));

const file = writeDump('v2/codex-plan-probe', {
  at: new Date().toISOString(),
  workspace,
  prompt,
  model: run.model,
  error: run.error,
  timedOut: run.timedOut,
  eventTypes: allEventTypes,
  itemTypes: allItemTypes,
  shapes: [...itemShapes(run.events)].map(([key, value]) => ({ key, count: value.count, keys: value.keys, sample: value.sample })),
});
note('→', file);
