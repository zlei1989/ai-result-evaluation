/**
 * 从已落盘的 claude 消息流里抽取几个**用于核对结论**的字段：
 *  - `subagent_stats`（它"未收编进 SDK 类型面"，本轮要看它是否出现在 SDK 流里、形状如何）；
 *  - `claude_code_version` / `permission_denials` / `terminal_reason` 等信封级字段；
 *  - `Read` 结果里是否出现 `<system-reminder>`（未验证）。
 *
 * 用法：node probe/v2/claude-consolidate.mjs
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DUMP_DIR, note, writeDump } from './lib/gateway.mjs';

const FILES = [
  'v2/claude-tool-results',
  'v2/claude-task-tools',
  'v2/claude-tooltable-off',
];

const out = {};
for (const name of FILES) {
  let rows;
  try {
    rows = readFileSync(join(DUMP_DIR, `${name}.jsonl`), 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line));
  } catch {
    note(`${name}：【无落盘】`);
    continue;
  }
  const entry = { messages: rows.length };
  const init = rows.find((row) => row?.type === 'system' && row?.subtype === 'init');
  entry.claudeCodeVersion = init?.claude_code_version ?? null;
  entry.initModel = init?.model ?? null;
  entry.toolCount = Array.isArray(init?.tools) ? init.tools.length : null;

  const withStats = rows.filter((row) => row?.subagent_stats !== undefined);
  entry.subagentStatsCount = withStats.length;
  entry.subagentStats = withStats[0]?.subagent_stats ?? null;
  entry.subagentStatsOnType = withStats[0]?.type ?? null;

  const results = rows.filter((row) => row?.type === 'result');
  entry.resultEnvelope = results.at(-1) === undefined ? null : {
    subagent_stats: results.at(-1).subagent_stats ?? null,
    permission_denials: results.at(-1).permission_denials ?? null,
    terminal_reason: results.at(-1).terminal_reason ?? null,
    num_turns: results.at(-1).num_turns ?? null,
    usage: results.at(-1).usage ?? null,
  };

  // Read 结果里有没有 system-reminder：看文本结果与结构化结果两处
  const readHits = rows.filter((row) => JSON.stringify(row?.tool_use_result ?? '').includes('system-reminder'));
  entry.readWithSystemReminder = readHits.length;
  out[name] = entry;
  note(`===== ${name} =====`);
  note('  消息数 =', entry.messages, '；claude_code_version =', entry.claudeCodeVersion, '；工具数 =', entry.toolCount);
  note('  带 subagent_stats 的消息数 =', entry.subagentStatsCount, '（首条类型', entry.subagentStatsOnType, '）');
  note('  subagent_stats =', JSON.stringify(entry.subagentStats));
  note('  含 system-reminder 的 tool_use_result 条数 =', entry.readWithSystemReminder);
}

writeDump('v2/claude-consolidated', { at: new Date().toISOString(), files: FILES, out });
