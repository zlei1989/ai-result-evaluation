/**
 * 真机项⑤：**思考 token 的结算值**（设计稿 §7.7.2 / §7.7.7 / §9.3 新登记的一格）。
 *
 * 设计稿原文：「claude 的 `output_tokens_details.thinking_tokens`、codex 的 `reasoning_output_tokens`、
 * dsh 的 `reasoningTokens` **全部只在类型面上**，**没有一家有真机取值样本** ⇒ 三家的
 * `usageCapability.thinkingTokens` 一律先声明 `'unverified'`；首个实现必须各跑一次登记
 * （含"它与 `output_tokens` 的大小关系"，那决定 `basis` 能否从 `'unknown'` 升级）。」
 *
 * 本脚本**不重新跑**，而是把本轮已经落盘的原始事件全部扫一遍，把三家的这一格掏出来
 * （能掏到就当场登记；掏不到再决定要不要补跑）。
 *
 * 用法：node probe/v2/thinking-tokens.mjs
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DUMP_DIR, note, writeDump } from './lib/gateway.mjs';

const dir = join(DUMP_DIR, 'v2');
const files = readdirSync(dir).filter((name) => name.endsWith('.jsonl'));

/** 逐条 JSON 读一个 jsonl（坏行跳过）。 */
function rowsOf(name) {
  return readFileSync(join(dir, name), 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

const found = { claude: [], codex: [], dsh: [] };

for (const name of files) {
  const rows = rowsOf(name);
  for (const row of rows) {
    // ── claude：result 的 usage.output_tokens_details.thinking_tokens ──
    const claudeUsage = row?.usage;
    if (claudeUsage !== undefined && row?.type === 'result') {
      found.claude.push({
        file: name,
        thinking_tokens: claudeUsage.output_tokens_details?.thinking_tokens ?? null,
        output_tokens: claudeUsage.output_tokens ?? null,
        modelUsage: Object.fromEntries(
          Object.entries(row.modelUsage ?? {}).map(([model, value]) => [model, { thinkingTokens: value?.thinkingTokens ?? null, outputTokens: value?.outputTokens ?? null }]),
        ),
      });
    }
    // ── codex：turn.completed.usage.reasoning_output_tokens ──
    if (row?.type === 'turn.completed' && row?.usage !== undefined) {
      found.codex.push({
        file: name,
        reasoning_output_tokens: row.usage.reasoning_output_tokens ?? null,
        output_tokens: row.usage.output_tokens ?? null,
      });
    }
    // ── dsh：assistant/message.data.usage.reasoningTokens ──
    const dshEvent = row?.params?.event;
    if (dshEvent?.type === 'assistant/message' && dshEvent?.data?.usage !== undefined) {
      found.dsh.push({
        file: name,
        reasoningTokens: dshEvent.data.usage.reasoningTokens ?? null,
        outputTokens: dshEvent.data.usage.outputTokens ?? null,
        usageKeys: Object.keys(dshEvent.data.usage),
      });
    }
  }
}

/** 汇总：字段出现过几次、非 null 几次、取值集合。 */
function summarize(list, field, outputField) {
  const present = list.filter((item) => item[field] !== null && item[field] !== undefined);
  return {
    samples: list.length,
    fieldPresent: present.length,
    distinctValues: [...new Set(present.map((item) => item[field]))].slice(0, 20),
    outputTokensDistinct: [...new Set(list.map((item) => item[outputField]).filter((value) => value !== null))].slice(0, 20),
  };
}

const summary = {
  claude: summarize(found.claude, 'thinking_tokens', 'output_tokens'),
  codex: summarize(found.codex, 'reasoning_output_tokens', 'output_tokens'),
  dsh: summarize(found.dsh, 'reasoningTokens', 'outputTokens'),
};

note('===== claude：result.usage.output_tokens_details.thinking_tokens =====');
note(JSON.stringify(summary.claude));
note('样本（前 6）：', JSON.stringify(found.claude.slice(0, 6)));
note('===== codex：turn.completed.usage.reasoning_output_tokens =====');
note(JSON.stringify(summary.codex));
note('样本（前 6）：', JSON.stringify(found.codex.slice(0, 6)));
note('===== dsh：assistant/message.data.usage.reasoningTokens =====');
note(JSON.stringify(summary.dsh));
note('usage 键名样本（去重）：', JSON.stringify([...new Set(found.dsh.flatMap((item) => item.usageKeys))]));
note('样本（前 4）：', JSON.stringify(found.dsh.slice(0, 4)));

writeDump('v2/thinking-tokens', { at: new Date().toISOString(), filesScanned: files.length, summary, found });
