/**
 * 把一份 dsh 原始 JSONL 里**指定类型的负载形状**摘要打印出来（键名 + 值类型 + 小样本），
 * 不打印整段原文——原始文件已经落盘，摘要只是为了在终端里对形状。
 *
 * 用法：node probe/v2/dsh-inspect.mjs <jsonl 名> <event.type> [更多 type…]
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DUMP_DIR, note } from './lib/gateway.mjs';

const [name, ...types] = process.argv.slice(2);
if (name === undefined) {
  console.error('用法：node probe/v2/dsh-inspect.mjs <jsonl 名> <event.type> [...]');
  process.exit(2);
}
const wanted = new Set(types);
const rows = readFileSync(join(DUMP_DIR, `${name}.jsonl`), 'utf8')
  .split('\n')
  .filter((line) => line.trim() !== '')
  .map((line) => JSON.parse(line));

/** 递归描述形状：只到 3 层，数组只描述首元素。 */
function shape(value, depth = 0) {
  if (depth > 3) return '…';
  if (value === null) return 'null';
  if (Array.isArray(value)) return value.length === 0 ? '[]' : `[${shape(value[0], depth + 1)} ×${value.length}]`;
  if (typeof value === 'object') {
    const keys = Object.keys(value);
    const head = keys.slice(0, 14).map((key) => `${key}: ${shape(value[key], depth + 1)}`);
    return `{ ${head.join(', ')}${keys.length > 14 ? `, …+${keys.length - 14}` : ''} }`;
  }
  if (typeof value === 'string') return value.length <= 60 ? JSON.stringify(value) : `"${value.slice(0, 57)}…"`;
  return String(value);
}

let shown = 0;
for (const row of rows) {
  const event = row?.params?.event;
  const type = event?.type ?? row?.method;
  if (!wanted.has(type)) continue;
  shown += 1;
  note(`#${shown} ${type}`);
  note('  data =', shape(event?.data));
}
note(`共 ${shown} 条匹配 / 全文件 ${rows.length} 条`);
