/**
 * 上游网关的**协议面**探测：`/v1/messages`（Anthropic）与 `/v1/responses`（OpenAI Responses）
 * 是否直接可用。
 *
 * 为什么必须先测这一条：本轮所有 claude / codex 的真机项都依赖一个"讲对应协议"的端点。
 * `likecode-llm-proxy-test.jd.com`（测试环境）曾被记录为**不可达**——先确认生产环境
 * 到底支持哪几种 wire，再决定是直连还是经本地 proxygateway 转换。
 */
import { GATEWAY_API_KEY, GATEWAY_BASE_URL, fetchWithTimeout, note, writeDump } from './lib/gateway.mjs';

const headers = {
  Authorization: `Bearer ${GATEWAY_API_KEY}`,
  'content-type': 'application/json',
};

/** 只报「状态码 + 前 400 字」：探测脚本不该把整段模型回复打进终端。 */
async function attempt(label, path, body) {
  const url = path.startsWith('http') ? path : `https://likecode-llm-proxy.jd.com${path}`;
  try {
    const response = await fetchWithTimeout(url, { method: 'POST', headers, body: JSON.stringify(body) }, 120000);
    const text = await response.text();
    note(label, '→', url, 'HTTP', response.status);
    note('   ', text.slice(0, 400).replaceAll('\n', ' '));
    return { label, url, status: response.status, bodyHead: text.slice(0, 2000) };
  } catch (error) {
    note(label, '→', url, 'ERR', String(error?.message ?? error).slice(0, 200));
    return { label, url, status: null, error: String(error?.message ?? error).slice(0, 400) };
  }
}

const results = [];
// Anthropic Messages：claude 适配器走的就是这条
results.push(await attempt('anthropic /v1/messages', '/v1/messages', {
  model: 'Claude-Sonnet-4.6',
  max_tokens: 16,
  messages: [{ role: 'user', content: '回答一个字：好' }],
}));
// OpenAI Responses：codex 适配器走的就是这条
results.push(await attempt('openai /v1/responses', '/v1/responses', {
  model: 'GPT-5.5',
  input: [{ role: 'user', content: [{ type: 'input_text', text: '回答一个字：好' }] }],
  stream: false,
}));
// chat/completions：作为对照（proxygateway 会把前两者转成它）
results.push(await attempt('openai /v1/chat/completions', '/v1/chat/completions', {
  model: 'GPT-5.5',
  max_tokens: 16,
  messages: [{ role: 'user', content: '回答一个字：好' }],
}));

note('baseUrl =', GATEWAY_BASE_URL);
writeDump('v2/protocol-face', { at: new Date().toISOString(), baseUrl: GATEWAY_BASE_URL, results });
