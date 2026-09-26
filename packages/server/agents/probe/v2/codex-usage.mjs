/**
 * 补扫 codex 的 `turn.completed.usage`（上一轮漏了：那些 jsonl 是 **PowerShell 重定向**写出来的，
 * 默认编码是 **UTF-16LE**，按 UTF-8 读会整行解析失败）。
 *
 * 为什么值得单跑：设计稿 §7.7.2 说 `reasoning_output_tokens` "只在类型面上、没有真机取值样本"，
 * 而本轮 codex 的每一次成功 turn 都带这一格——只要按正确编码读出来就能当场登记。
 *
 * 用法：node probe/v2/codex-usage.mjs
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DUMP_DIR, note, writeDump } from './lib/gateway.mjs';

const dir = join(DUMP_DIR, 'v2');
const files = readdirSync(dir).filter((name) => name.startsWith('codex') && name.endsWith('.jsonl'));

/** 按 BOM 判定编码：PowerShell 重定向默认写 UTF-16LE（`FF FE`）。 */
function decode(buffer) {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.toString('utf16le');
  return buffer.toString('utf8');
}

const samples = [];
for (const name of files) {
  const text = decode(readFileSync(join(dir, name)));
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (row?.type === 'turn.completed' && row?.usage !== undefined) {
      samples.push({
        file: name,
        usage: row.usage,
        reasoning_output_tokens: row.usage.reasoning_output_tokens ?? null,
        output_tokens: row.usage.output_tokens ?? null,
      });
    }
    // 顺带把 item 类型也统计出来（codex 的事件全集是另一处待核）
    if (typeof row?.item?.type === 'string') samples.push({ file: name, itemType: row.item.type, eventType: row.type });
  }
}

const usages = samples.filter((item) => item.usage !== undefined);
const itemTypes = [...new Set(samples.filter((item) => item.itemType !== undefined).map((item) => `${item.eventType}/${item.itemType}`))];

note('turn.completed 样本数 =', usages.length);
for (const one of usages) {
  note(`· ${one.file} reasoning_output_tokens=${one.reasoning_output_tokens} output_tokens=${one.output_tokens} keys=${Object.keys(one.usage).join(',')}`);
}
note('codex 见过的 event/item 组合：', JSON.stringify(itemTypes));

writeDump('v2/codex-usage', {
  at: new Date().toISOString(),
  files,
  turnCompletedSamples: usages.length,
  reasoningOutputTokensDistinct: [...new Set(usages.map((one) => one.reasoning_output_tokens))],
  outputTokensDistinct: [...new Set(usages.map((one) => one.output_tokens))],
  usageKeys: [...new Set(usages.flatMap((one) => Object.keys(one.usage)))],
  eventItemTypes: itemTypes,
});
