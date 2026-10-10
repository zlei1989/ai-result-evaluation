/**
 * codex 真机项①（CLI 路径）：`update_plan` / `request_user_input` 落到哪个 `item.type`。
 *
 * 硬要求：「三个候选，**不得推断**」——
 *   ① `item.type === 'todo_list'`；② 某个 plan 专用 item 类型；③ 只以 `agent_message` 文本留痕
 *   （若属实则"工具面重建面板"方案**不成立**）。
 *
 * 做法：把 `tools.update_plan.enabled` 与 `tools.experimental_request_user_input.enabled`
 * 按既定口径打开，跑一条**明确要求先提交计划**的任务，把 `--json` 的每一行原样落盘。
 * 判据是 `item.type` 的**全集**——不做映射、不做解释。
 */
import { note, writeDump } from './lib/gateway.mjs';
import { itemShapes, makeCodexWorkspace, runCodexCli } from './lib/codex.mjs';

const workspace = makeCodexWorkspace('codex-cli-plan');
note('工作区 =', workspace);

const prompt = [
  '这是一个多步任务：请**先**调用 update_plan 工具提交一份三步计划（第一步 in_progress、其余 pending），',
  '然后读取 notes.txt、统计行数、把行数写进 answer.txt，每完成一步用 update_plan 更新状态，最后汇报一句。',
].join('\n');

const run = runCodexCli({
  label: 'codex-cli-plan',
  prompt,
  workspace,
  extraConfig: {
    'tools.update_plan.enabled': 'true',
    'tools.experimental_request_user_input.enabled': 'true',
    'features.default_mode_request_user_input': 'true',
  },
});

note('===== item 形状全集 =====');
const shapes = itemShapes(run.events);
for (const [key, value] of shapes) {
  note(`· ${key} × ${value.count}`);
  note(`    字段: ${value.keys.join(', ')}`);
  note(`    样本: ${JSON.stringify(value.sample).slice(0, 700)}`);
}

const allItemTypes = [...new Set(run.events.map((event) => event?.item?.type).filter(Boolean))];
const allEventTypes = [...new Set(run.events.map((event) => event?.type).filter(Boolean))];
note('item.type 全集 =', JSON.stringify(allItemTypes));
note('event.type 全集 =', JSON.stringify(allEventTypes));

const file = writeDump('v2/codex-cli-plan', {
  at: new Date().toISOString(),
  workspace,
  prompt,
  failure: run.failure,
  stderr: run.stderr.slice(0, 2000),
  eventTypes: allEventTypes,
  itemTypes: allItemTypes,
  shapes: [...shapes].map(([key, value]) => ({ key, count: value.count, keys: value.keys, sample: value.sample })),
  rawEvents: run.events,
});
note('→', file);
