/**
 * 逐 wire 找出**正确的鉴权头**（本轮全部真机项的入口口径）。
 *
 * 为什么必须单独测：上一轮实测出现「同一个 token，`/v1/models` 200 而 `/v1/messages` 401」——
 * 差异只在鉴权头（`x-api-key` vs `Authorization: Bearer`）。头选错的表现是 401「登录态丢失」，
 * 极易被误读成「没有凭据 / 网关不可用」，直接决定整轮验证能不能跑。
 */
import { fetchWithTimeout, note, writeDump } from './lib/gateway.mjs';

const TOKEN = '96c7851a09d2618659786746e124a8f02b3f3a0f';
const CASES = [
  ['127.0.0.1-test-http', 'http://likecode-llm-proxy-test.jd.com'],
];

/** 按 header 变体发一次 POST，只回状态码与响应头 120 字。 */
async function attempt(base, path, headers, body) {
  try {
    const response = await fetchWithTimeout(
      `${base}${path}`,
      { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) },
      90000,
    );
    const text = (await response.text()).slice(0, 220).replaceAll('\n', ' ');
    return { path, headers: Object.keys(headers), status: response.status, head: text };
  } catch (error) {
    return { path, headers: Object.keys(headers), status: null, error: String(error?.cause?.code ?? error?.message ?? error).slice(0, 160) };
  }
}

const results = [];
for (const [label, base] of CASES) {
  const headerVariants = [
    ['x-api-key', { 'x-api-key': TOKEN }],
    ['bearer', { authorization: `Bearer ${TOKEN}` }],
    ['both', { 'x-api-key': TOKEN, authorization: `Bearer ${TOKEN}` }],
  ];
  const bodies = [
    ['/v1/messages', { model: 'Claude-Sonnet-4.6', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }],
    ['/v1/responses', { model: 'GPT-5.5', input: 'hi', stream: false }],
    ['/v1/chat/completions', { model: 'GPT-5.5', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }],
  ];
  for (const [path, body] of bodies) {
    for (const [name, headers] of headerVariants) {
      const row = await attempt(base, path, headers, body);
      results.push({ label, ...row, headerName: name });
      note(`${label} ${path} [${name}] → ${row.status === null ? `ERR ${row.error}` : `HTTP ${row.status} ${row.head.slice(0, 140)}`}`);
    }
  }
}

writeDump('v2/auth-headers', { at: new Date().toISOString(), results });
