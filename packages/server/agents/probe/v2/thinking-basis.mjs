/**
 * 思考 token 与 `output_tokens` 的**大小关系**（这一条决定 `basis` 能否从 `'unknown'` 升级）。
 *
 * 判据：若 `thinking_tokens < output_tokens` 恒成立，则思考 token **计入** output（inclusive）；
 * 若两者互不包含（存在 thinking > output 的样本），则是 exclusive。
 *
 * 用法：node probe/v2/thinking-basis.mjs
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DUMP_DIR, note, writeDump } from './lib/gateway.mjs';

const dir = join(DUMP_DIR, 'v2');
const rows = [];
for (const name of readdirSync(dir).filter((file) => file.startsWith('claude') && file.endsWith('.jsonl'))) {
  for (const line of readFileSync(join(dir, name), 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    try {
      const row = JSON.parse(line);
      if (row?.type === 'result' && row?.usage !== undefined) rows.push({ file: name, usage: row.usage });
    } catch {
      /* 坏行跳过 */
    }
  }
}

const pairs = rows.map((row) => ({
  file: row.file,
  thinking: row.usage.output_tokens_details?.thinking_tokens ?? null,
  output: row.usage.output_tokens ?? null,
}));
const usable = pairs.filter((pair) => pair.thinking !== null && pair.output !== null && pair.output > 0);
const violations = usable.filter((pair) => pair.thinking > pair.output);
const equalZero = usable.filter((pair) => pair.thinking === 0);
const maxRatio = Math.max(...usable.map((pair) => pair.thinking / pair.output));

note('可用样本 =', usable.length, '；thinking > output 的样本 =', violations.length);
note('thinking == 0 的样本 =', equalZero.length);
note('thinking/output 最大比值 =', maxRatio.toFixed(3));
note('逐条：', JSON.stringify(usable.map((pair) => `${pair.thinking}/${pair.output}`)));
if (violations.length > 0) note('⚠️ 存在 thinking > output 的样本：', JSON.stringify(violations));

writeDump('v2/thinking-basis', {
  at: new Date().toISOString(),
  usable: usable.length,
  violations,
  maxRatio,
  pairs: usable,
  verdict: violations.length === 0 ? 'inclusive：thinking 计入 output' : 'exclusive：thinking 与 output 互不包含',
});
