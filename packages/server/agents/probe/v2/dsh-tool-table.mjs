/**
 * dsh 真机项②：`request/header.tools[]` 的**工具名单**与 `assistant/message.data.stream[]` 的
 * **块协议明细**（含是否存在 `reasoning-delta`）。
 *
 * 为什么要这一条：
 *  - `ask_user_question` 是否真的挂进本行 profile（登记为已确认，但工具表要从本条运行的**原文**里读）；
 *  - `data.stream[]` 是 `chunk: 'delta'` 映射的**唯一**依据（既定口径是「dsh 不发 `reasoning-delta`
 *    （实测 0 次）：推理只能整块从 `block-end`/`assistant/message` 取」）——必须复核，
 *    因为那条结论的上一版曾被中继破坏 SSE 分块的假象误导过一次。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DUMP_DIR, note, writeDump } from './lib/gateway.mjs';

const rows = readFileSync(join(DUMP_DIR, 'v2/dsh-tools.jsonl'), 'utf8')
  .split('\n')
  .filter((line) => line.trim() !== '')
  .map((line) => JSON.parse(line));

let toolNames = [];
let toolDescriptions = {};
for (const row of rows) {
  const header = row?.params?.event?.data?.header;
  if (header?.tools === undefined) continue;
  toolNames = header.tools.map((tool) => tool.name);
  toolDescriptions = Object.fromEntries(header.tools.map((tool) => [tool.name, tool.description ?? null]));
}
note('工具表（', toolNames.length, '项）：');
for (const name of toolNames) note('  ·', name);

const chunkKinds = new Map();
const streamSamples = [];
const contentBlockKinds = new Map();
let reasoningTexts = [];
for (const row of rows) {
  const event = row?.params?.event;
  if (event?.type !== 'assistant/message') continue;
  for (const block of event.data?.message?.content ?? []) {
    contentBlockKinds.set(block.type, (contentBlockKinds.get(block.type) ?? 0) + 1);
    if (block.type === 'reasoning') reasoningTexts.push(block.text ?? null);
  }
  for (const entry of event.data?.stream ?? []) {
    const key = entry?.type === 'chunk' ? `chunk:${entry.chunk?.type}` : String(entry?.type);
    chunkKinds.set(key, (chunkKinds.get(key) ?? 0) + 1);
    if (streamSamples.length < 60) streamSamples.push(entry);
  }
}

note('assistant/message 的 content 块类型：', JSON.stringify([...contentBlockKinds]));
note('reasoning 文本长度：', JSON.stringify(reasoningTexts.map((t) => (t === null ? null : t.length))));
note('stream 条目类型：', JSON.stringify([...chunkKinds]));
note('是否存在任何 *-delta：', [...chunkKinds.keys()].some((key) => key.includes('delta')) ? '【是】' : '【否】');

const file = writeDump('v2/dsh-tool-table-and-stream', {
  at: new Date().toISOString(),
  toolNames,
  toolDescriptions,
  contentBlockKinds: [...contentBlockKinds],
  reasoningTextLens: reasoningTexts.map((t) => (t === null ? null : t.length)),
  chunkKinds: [...chunkKinds],
  hasDelta: [...chunkKinds.keys()].some((key) => key.includes('delta')),
  streamSamples,
});
note('→', file);
