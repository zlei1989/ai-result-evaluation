/**
 * 检查 claude 的 SDK 消息里**是否带结构化工具输出**（`tool_use_result` / `structuredContent` 一类）。
 *
 * 为什么要它：`sdk-tools.d.ts` 里每个工具都有 `*Output` 接口（例如 `BashOutput` 有
 * `stdout`/`stderr` 但**没有** `exitCode`；`FileEditOutput` 有 `structuredPatch`）。
 * 那些是**面向客户端**的结构化输出——若它们真的出现在 SDK 流里，本仓的族结构就有了权威来源；
 * 若不在，就只能退回解析给模型看的文本。
 *
 * 用法：node probe/v2/claude-structured.mjs <jsonl 名>
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DUMP_DIR, note, writeDump } from './lib/gateway.mjs';

const name = process.argv[2];
const rows = readFileSync(join(DUMP_DIR, `${name}.jsonl`), 'utf8')
  .split('\n')
  .filter((line) => line.trim() !== '')
  .map((line) => JSON.parse(line));

/** 收集所有顶层键名，找出「非 message/content」的旁路字段。 */
const topKeys = new Map();
for (const row of rows) {
  for (const key of Object.keys(row)) topKeys.set(key, (topKeys.get(key) ?? 0) + 1);
}
note('消息顶层键：', JSON.stringify([...topKeys]));

const structured = [];
for (const row of rows) {
  if (row?.tool_use_result === undefined) continue;
  structured.push({ tool: row?.message?.content?.find?.((b) => b?.type === 'tool_use')?.name ?? null, toolUseResult: row.tool_use_result });
}

note('带 tool_use_result 的消息数 =', structured.length);
for (const one of structured.slice(0, 8)) {
  note('--- 工具 =', one.tool, '---');
  note(JSON.stringify(one.toolUseResult).slice(0, 900));
}

const file = writeDump('v2/claude-structured-tool-output', {
  at: new Date().toISOString(),
  source: name,
  topKeys: [...topKeys],
  structuredCount: structured.length,
  samples: structured.slice(0, 20),
});
note('→', file);
