/**
 * 缓存命中率的分母口径：**`inputTokens` 到底含不含 `cacheReadTokens`？**
 *
 * 为什么这一格必须先钉死：三家的 `input` 语义不同——
 *   · Anthropic 语义：`input_tokens` **不含** cache read（三个格分开报）；
 *   · OpenAI/codex 语义：`input_tokens` **含** cached（`cached_input_tokens` 是它的子集，真机 6656 < 8152）；
 *   · dsh（pi-ai）：`inputTokens` 与 `cacheReadTokens` 并列，**大概率**不含——但**没用非零样本验证过**。
 * ⇒ 若按同一公式算命中率，会得到两种不同的东西。
 *
 * 判据：**跑两次同样的提示词**（第二次谈得上命中），然后看 `totalTokens` 的算术恒等式：
 *   · 若 `total = input + output`（忽略 cache 两格）⇒ `input` **含** cache（因为总量没把 cache 再加一遍）；
 *   · 若 `total = input + cacheRead + cacheWrite + output` ⇒ `input` **不含** cache。
 *
 * 用法：node probe/v4/dsh-cache-arithmetic.mjs
 */
import { DEEPSEEK_ANTHROPIC_BASE_URL, note, writeDump } from './lib/env.mjs';
import { runDshTurn } from './lib/dsh-harness.mjs';

/** 够长的前缀：DeepSeek 的缓存有最小长度门槛，太短不会命中。 */
const PREFIX = Array.from({ length: 40 }, (_, index) => `第 ${index + 1} 行：这是一段用于触发上游提示缓存的填充文本，请忽略它的内容。`).join('\n');
const PROMPT = `${PREFIX}\n\n请只回复一个词：ok`;

function usagesOf(notifications) {
  const rows = [];
  for (const one of notifications) {
    const event = one?.params?.event;
    if (event?.type === 'assistant/message' && event?.data?.usage !== undefined) rows.push(event.data.usage);
  }
  return rows;
}

const runs = [];
for (const label of ['第一次（应无命中）', '第二次（应命中）']) {
  const run = await runDshTurn({
    label: `cache-${label === '第一次（应无命中）' ? 'first' : 'second'}`,
    protocolType: 'openai',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    prompt: PROMPT,
    timeoutMs: 300_000,
  });
  const usages = usagesOf(run.notifications);
  runs.push({ label, error: run.error, usages });
  note(`【${label}】usage 样本 ${usages.length} 条：${JSON.stringify(usages.slice(-2))}`);
}

/** 逐条样本套两个候选恒等式，看哪个成立。 */
const checks = [];
for (const run of runs) {
  for (const usage of run.usages) {
    const input = Number(usage.inputTokens ?? 0);
    const output = Number(usage.outputTokens ?? 0);
    const read = Number(usage.cacheReadTokens ?? 0);
    const write = Number(usage.cacheWriteTokens ?? 0);
    const total = Number(usage.totalTokens ?? NaN);
    checks.push({
      run: run.label,
      input, output, read, write, total,
      '_total = input + output（⇒ input 含 cache）': total === input + output,
      '_total = input + read + write + output（⇒ input 不含 cache）': total === input + read + write + output,
      '_cacheRead 非零（这条样本谈得上命中）': read > 0,
    });
  }
}
note('逐条恒等式核对：');
for (const one of checks) note('  ', JSON.stringify(one));

const hitSamples = checks.filter((one) => one['_cacheRead 非零（这条样本谈得上命中）']);
const inclusive = hitSamples.filter((one) => one['_total = input + output（⇒ input 含 cache）']).length;
const exclusive = hitSamples.filter((one) => one['_total = input + read + write + output（⇒ input 不含 cache）']).length;
const verdict = hitSamples.length === 0
  ? '⚠️ 没跑出非零 cacheRead ⇒ **本轮无法判定**（缓存没命中，恒等式对两种解释都成立）'
  : (exclusive > inclusive
    ? '✅ 判定：`inputTokens` **不含** cache ⇒ 命中率 = cacheRead / (input + cacheRead)'
    : '✅ 判定：`inputTokens` **含** cache ⇒ 命中率 = cacheRead / input');

const file = writeDump('v4/dsh-cache-arithmetic', {
  at: new Date().toISOString(),
  promptPrefixLines: 40,
  runs: runs.map((one) => ({ label: one.label, error: one.error, usages: one.usages })),
  checks,
  hitSampleCount: hitSamples.length,
  verdict,
});
note('判定：', verdict);
note('落盘：', file);
