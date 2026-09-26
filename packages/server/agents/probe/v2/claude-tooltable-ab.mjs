/**
 * claude 真机项①：**工具表的 A/B**（`CLAUDE_CODE_ENABLE_TODO_TOOLS` 开关的精确增量），
 * 一次拿到设计稿里好几个未决格：
 *  - §11 开放问题 16 / 第 11 项：`AskUserQuestion` 是否受**同一个开关**影响（"仍未确认"）；
 *  - §11 开放问题 11：`AskUserQuestion` 为何不在 27 项工具表里（feature-gated 还是 preset 未启用）；
 *  - §11 开放问题 7：`Workflow` 是否会被本仓配置触发（是否默认可用）；
 *  - §11 开放问题 6：`ReportFindings` 的语义（拿它的**工具描述原文**）。
 *
 * 判据：**同一次运行、同一个模型**，只切那一个环境变量，比较 `system/init` 的 `tools[]` 差集。
 * 设计稿 §7.6.2.1b 明确要求过这条判据（"两次采集的 preset 不同；判据以『同一次 A/B 的增量』为准"）。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { note, writeDump } from './lib/gateway.mjs';
import { makeClaudeWorkspace, runClaudeProbe } from './lib/claude.mjs';

const workspace = makeClaudeWorkspace();
note('工作区 =', workspace);

const prompt = '回答一个字：好。不要调用任何工具，不要写文件。';

const off = await runClaudeProbe({ label: 'tooltable-off', prompt, workspace });
const on = await runClaudeProbe({
  label: 'tooltable-on',
  prompt,
  workspace,
  extraEnv: { CLAUDE_CODE_ENABLE_TODO_TOOLS: '1' },
});

const listOf = (run) => run.init?.tools ?? [];
const offTools = listOf(off);
const onTools = listOf(on);
const added = onTools.filter((name) => !offTools.includes(name));
const removed = offTools.filter((name) => !onTools.includes(name));

note('默认         toolCount =', offTools.length);
note('开 TODO 开关 toolCount =', onTools.length);
note('新增 =', JSON.stringify(added));
note('移除 =', JSON.stringify(removed));
note('默认工具表：', offTools.join(', '));
note('开关打开后：', onTools.join(', '));
note('模型 =', off.model, '/', on.model, '；init.model =', off.init?.model ?? null);

const file = writeDump('v2/claude-tooltable-ab', {
  at: new Date().toISOString(),
  workspace,
  prompt,
  model: off.model,
  off: { tools: offTools, init: off.init },
  on: { tools: onTools, init: on.init },
  added,
  removed,
  errors: { off: off.error, on: on.error },
});
note('→', file);
