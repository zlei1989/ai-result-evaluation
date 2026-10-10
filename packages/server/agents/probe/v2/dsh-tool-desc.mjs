/**
 * 打印 dsh 某几个工具的**完整描述原文**（来自 `request/header.tools[]`）。
 *
 * 为什么要它：`ask_user_question` / `interrupt_agent` / `subagent` 的失败路径与副语言都在描述里
 * （dsh 的逐字文案就出自这里）。要设计"能让子任务失败"的提示词，
 * 先得看厂商自己怎么描述这些工具的收场方式。
 *
 * 用法：node probe/v2/dsh-tool-desc.mjs <jsonl 名> <工具名> [...]
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DUMP_DIR, note } from './lib/gateway.mjs';

const [name, ...wanted] = process.argv.slice(2);
const rows = readFileSync(join(DUMP_DIR, `${name}.jsonl`), 'utf8')
  .split('\n')
  .filter((line) => line.trim() !== '')
  .map((line) => JSON.parse(line));

const tools = new Map();
for (const row of rows) {
  const list = row?.params?.event?.data?.header?.tools;
  if (!Array.isArray(list)) continue;
  for (const tool of list) tools.set(tool.name, tool);
}

for (const toolName of wanted) {
  const tool = tools.get(toolName);
  if (tool === undefined) {
    note(`${toolName}：【工具表里没有】`);
    continue;
  }
  note(`===== ${toolName} =====`);
  note(String(tool.description ?? '<无描述>'));
  note('-- parameters --');
  note(JSON.stringify(tool.parameters).slice(0, 1800));
  note('');
}
