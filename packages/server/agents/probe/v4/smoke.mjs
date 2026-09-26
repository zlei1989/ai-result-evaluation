/**
 * v4 冒烟：本轮探测的两条外部通路是否可用（**先证明链路，再谈结论**）。
 *
 * 判据（§9.4.1 的教训：任何「厂商不产出 X」的结论，先证明抓取链路没损坏 X）：
 *   ① DeepSeek anthropic wire（`/anthropic/v1/messages`）能否回一个 turn；
 *   ② DeepSeek OpenAI responses wire（`/v1/responses`）能否回一个 turn；
 *   ③ dsh 二进制与 SDK 自带 codex 二进制的解析路径是否找得到。
 *
 * 用法：node probe/v4/smoke.mjs
 */
import { DEEPSEEK_ANTHROPIC_BASE_URL, DEEPSEEK_OPENAI_BASE_URL, fetchWithTimeout, loadDeepSeekKey, note, resolveDshBin, resolveSdkCodexBin, writeDump } from './lib/env.mjs';

const key = loadDeepSeekKey();

async function tryFetch(label, url, options) {
  const at = Date.now();
  try {
    const response = await fetchWithTimeout(url, options, 120_000);
    const text = await response.text();
    const out = { label, url, status: response.status, ms: Date.now() - at, bodyHead: text.slice(0, 400) };
    note(label, '→', response.status, `${out.ms}ms`);
    return out;
  } catch (error) {
    const out = { label, url, status: null, ms: Date.now() - at, error: String(error?.message ?? error).slice(0, 300) };
    note(label, '✗', out.error);
    return out;
  }
}

const anthropic = await tryFetch('anthropic /v1/messages', `${DEEPSEEK_ANTHROPIC_BASE_URL}/v1/messages`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
  body: JSON.stringify({ model: 'deepseek-chat', max_tokens: 32, messages: [{ role: 'user', content: 'reply with the single word: ok' }] }),
});

const responses = await tryFetch('openai /v1/responses', `${DEEPSEEK_OPENAI_BASE_URL}/responses`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
  body: JSON.stringify({ model: 'deepseek-chat', max_output_tokens: 64, input: 'reply with the single word: ok' }),
});

const paths = { dshBin: resolveDshBin(), sdkCodexBin: resolveSdkCodexBin() };
note('dsh 二进制：', paths.dshBin);
note('SDK 自带 codex：', paths.sdkCodexBin);

const dump = writeDump('v4/smoke', { at: new Date().toISOString(), anthropic, responses, paths });
note('落盘：', dump);
