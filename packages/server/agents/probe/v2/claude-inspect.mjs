/**
 * 打印一份 claude SDK 消息 jsonl 的**结构摘要**：`system/init` 全文、各消息类型计数、
 * 以及在 jsonl 里出现过的工具名。
 *
 * 用法：node probe/v2/claude-inspect.mjs <jsonl 名> [--init|--tools|--all]
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DUMP_DIR, note } from './lib/gateway.mjs';

const name = process.argv[2];
const rows = readFileSync(join(DUMP_DIR, `${name}.jsonl`), 'utf8')
  .split('\n')
  .filter((line) => line.trim() !== '')
  .map((line) => JSON.parse(line));

const counts = new Map();
for (const row of rows) {
  const key = row?.type === 'system' ? `system/${row.subtype}` : String(row?.type);
  counts.set(key, (counts.get(key) ?? 0) + 1);
}
note('消息类型分布：', JSON.stringify([...counts]));

const init = rows.find((row) => row?.type === 'system' && row?.subtype === 'init');
if (init !== undefined) {
  note('===== system/init 全文 =====');
  note(JSON.stringify(init, null, 1));
}

const needsInspection = process.argv.includes('--all');
if (needsInspection) {
  for (const row of rows) {
    if (row?.type === 'result') {
      note('===== result =====');
      note(JSON.stringify(row).slice(0, 3000));
    }
  }
}
