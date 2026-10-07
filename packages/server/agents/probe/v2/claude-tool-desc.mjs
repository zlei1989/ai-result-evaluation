/**
 * 从 `v2/claude-inbound-tools.json` 里打印指定工具的 **description + input_schema 原文**。
 *
 * 用法：node probe/v2/claude-tool-desc.mjs <模型> <工具名> [...]
 *   例：node probe/v2/claude-tool-desc.mjs Claude-Sonnet-4.6 ReportFindings TaskCreate
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DUMP_DIR, note } from './lib/gateway.mjs';

const [model, ...wanted] = process.argv.slice(2);
const dump = JSON.parse(readFileSync(join(DUMP_DIR, 'v2/claude-inbound-tools.json'), 'utf8'));
const entry = dump.perModel?.[model];
if (entry === undefined) {
  note('可用模型：', Object.keys(dump.perModel ?? {}).join(' / '));
  process.exit(2);
}
const tools = new Map((entry.off.tools ?? []).map((tool) => [tool.name, tool]));
note(`模型 ${model}：默认工具表 ${entry.off.toolNames.length} 项`);

for (const name of wanted) {
  const tool = tools.get(name);
  if (tool === undefined) {
    note(`===== ${name}：【不在工具表里】=====`);
    continue;
  }
  note(`===== ${name} =====`);
  note('description:', String(tool.description ?? '<无>'));
  note('input_schema:', JSON.stringify(tool.input_schema ?? null));
  note('');
}
