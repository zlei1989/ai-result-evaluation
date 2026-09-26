/**
 * 把一份 dsh JSONL 里的**子任务相关原文**完整打出来（`subagent.started/finished` + `subagent/catalog`），
 * 并统计 `status` / `stopReason` 的**取值分布**。
 *
 * 用法：node probe/v2/dsh-subagent-report.mjs <jsonl 名> [...]
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DUMP_DIR, note, writeDump } from './lib/gateway.mjs';

const names = process.argv.slice(2);
const report = {};
for (const name of names) {
  const rows = readFileSync(join(DUMP_DIR, `${name}.jsonl`), 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
  const entries = [];
  for (const row of rows) {
    const method = row?.method;
    const eventType = row?.params?.event?.type;
    if (method === 'subagent.started' || method === 'subagent.finished') {
      entries.push({ kind: method, params: row.params });
    } else if (eventType === 'subagent/catalog') {
      entries.push({ kind: 'session.event :: subagent/catalog', data: row.params.event.data });
    }
  }
  report[name] = entries;
  note(`===== ${name}（${entries.length} 条子任务原文） =====`);
  for (const entry of entries) {
    if (entry.kind === 'subagent.finished') {
      // 终态字段单独列一行：这两个值是本轮验证的目标
      note('  status =', JSON.stringify(entry.params.status), '；stopReason =', JSON.stringify(entry.params.stopReason));
      note('  params 键 =', Object.keys(entry.params).join(', '));
      const last = entry.params.lastAssistantMessage;
      note('  lastAssistantMessage 块类型 =', Array.isArray(last) ? last.map((b) => b.type).join(',') : String(last));
      note('  全文 =', JSON.stringify(entry.params));
    } else {
      note(' ', entry.kind, '=', JSON.stringify(entry.params ?? entry.data));
    }
  }
}

writeDump('v2/dsh-subagent-report', { at: new Date().toISOString(), report });
