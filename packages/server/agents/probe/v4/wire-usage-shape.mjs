/**
 * dsh 行：`assistant/message → data.usage.reasoningTokens` **真机从未观测到**。
 *
 * 本脚本做**两段证据**（缺一不可：任何「厂商不产出 X」的结论，先证明抓取链路没损坏 X）：
 *   ① **链路**：DeepSeek 三条 wire 上，`deepseek-chat` / `deepseek-reasoner` 各自回的 usage 到底有哪些键、
 *      有没有思考 token 那一格（这是**上游能不能给**的问题，与 dsh 无关）；
 *   ② **投影**：dsh 经 pi-ai 把上游 usage 映射成 `TokenUsage` 后，`reasoningTokens` 出不出现
 *      （这是**dsh 会不会给**的问题）——由 `dsh-reasoning-tokens.mjs` 用真实 harness 跑。
 *
 * 用法：node probe/v4/wire-usage-shape.mjs
 */
import { DEEPSEEK_ANTHROPIC_BASE_URL, DEEPSEEK_OPENAI_BASE_URL, fetchWithTimeout, loadDeepSeekKey, note, writeDump } from './lib/env.mjs';

const key = loadDeepSeekKey();
const MODELS = ['deepseek-chat', 'deepseek-reasoner'];
/** 要求模型真的推理一下，否则"思考 token = 0"可能只是没思考。 */
const PROMPT = 'A farmer has 17 sheep and all but 9 run away. How many are left? Think step by step, then answer with just the number.';

async function post(label, url, headers, body) {
  const at = Date.now();
  try {
    const response = await fetchWithTimeout(url, { method: 'POST', headers, body: JSON.stringify(body) }, 180_000);
    const text = await response.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* 非 JSON 就留原文 */ }
    return {
      label,
      status: response.status,
      ms: Date.now() - at,
      usage: parsed?.usage ?? null,
      // 只留结构，不留正文（正文对本题无意义，且可能有敏感回显）
      topLevelKeys: parsed === null ? null : Object.keys(parsed),
      bodyHead: parsed === null ? text.slice(0, 400) : null,
      hasReasoningContent: /"reasoning_content"\s*:/.test(text),
      hasThinkingBlock: /"thinking"/.test(text),
      outputTokensDetails: parsed?.usage?.output_tokens_details ?? null,
      completionTokensDetails: parsed?.usage?.completion_tokens_details ?? null,
    };
  } catch (error) {
    return { label, status: null, ms: Date.now() - at, error: String(error?.message ?? error).slice(0, 300) };
  }
}

const rows = [];
for (const model of MODELS) {
  rows.push(await post(
    `anthropic /v1/messages ${model}`,
    `${DEEPSEEK_ANTHROPIC_BASE_URL}/v1/messages`,
    { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    { model, max_tokens: 1024, messages: [{ role: 'user', content: PROMPT }] },
  ));
  rows.push(await post(
    `openai /v1/responses ${model}`,
    `${DEEPSEEK_OPENAI_BASE_URL}/responses`,
    { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    { model, max_output_tokens: 1024, input: PROMPT },
  ));
  rows.push(await post(
    `openai /chat/completions ${model}`,
    `${DEEPSEEK_OPENAI_BASE_URL}/chat/completions`,
    { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    { model, max_tokens: 1024, messages: [{ role: 'user', content: PROMPT }] },
  ));
}

for (const row of rows) {
  note(row.label, '→', row.status, row.status === null ? row.error : JSON.stringify({
    usage: row.usage,
    outputTokensDetails: row.outputTokensDetails,
    completionTokensDetails: row.completionTokensDetails,
    hasReasoningContent: row.hasReasoningContent,
  }));
}

/** 判据：哪条 wire 的 usage 里**真的带着**思考 token 那一格（字段名逐字记录）。 */
const reasoningFieldHits = rows
  .filter((row) => row.usage !== null && row.usage !== undefined)
  .map((row) => ({
    label: row.label,
    usageKeys: Object.keys(row.usage),
    reasoningKeys: Object.keys(row.usage).filter((one) => /reason/i.test(one)),
    detailKeys: row.outputTokensDetails === null && row.completionTokensDetails === null
      ? []
      : Object.keys({ ...(row.outputTokensDetails ?? {}), ...(row.completionTokensDetails ?? {}) }),
  }));

const dump = writeDump('v4/wire-usage-shape', {
  at: new Date().toISOString(),
  models: MODELS,
  prompt: PROMPT,
  rows,
  reasoningFieldHits,
});
note('落盘：', dump);
