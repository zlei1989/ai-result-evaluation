/**
 * 候选端点的**连通性 + 鉴权**矩阵（一次跑完，避免逐条手敲）。
 *
 * 候选与它们的来历：
 *  - `likecode-llm-proxy-test.jd.com`：cc-switch 里 8 条 provider 用的 base URL（**测试环境**）；
 *  - `likecode-llm-proxy.jd.com`：proxygateway 日志里 codex 实际打过的生产地址；
 *  - `127.0.0.1:15721`：cc-switch 本地中继（2026-09-22 探测用过）。
 *
 * 每个候选同时试 `/v1/models`（只读）与 `/v1/messages`（Anthropic 推理），
 * 用 40 字符的 likecode token 与 35 字符的 sk- token 各试一次——**分开报**，
 * 因为「端点通不通」与「这个 key 能不能推理」是两件事。
 */
import { fetchWithTimeout, note, writeDump } from './lib/gateway.mjs';

const LIKE_CODE_TOKEN = '96c7851a09d2618659786746e124a8f02b3f3a0f';
const SK_TOKEN = 'sk-721000000000000000000000000000202f'; // 只用于判"是否被端点接受"，非真实密钥

const ENDPOINTS = [
  'http://likecode-llm-proxy-test.jd.com',
  'https://likecode-llm-proxy-test.jd.com',
  'https://likecode-llm-proxy.jd.com',
  'http://127.0.0.1:15721',
  'http://127.0.0.1:7999',
];

const TOKENS = [
  ['likecode-40', LIKE_CODE_TOKEN, 'x-api-key'],
  ['likecode-40-bearer', LIKE_CODE_TOKEN, 'authorization'],
];

/** 单个组合：返回一句可读结论；异常一律收敛成字符串，不让探测脚本在这里挂掉。 */
async function probe(label, url, token, headerName) {
  const headers = token === null ? {} : { [headerName]: headerName === 'authorization' ? `Bearer ${token}` : token };
  try {
    const response = await fetchWithTimeout(url, { headers }, 12000);
    const text = (await response.text()).slice(0, 300).replaceAll('\n', ' ');
    return { label, url, status: response.status, head: text };
  } catch (error) {
    return { label, url, status: null, error: String(error?.cause?.code ?? error?.message ?? error).slice(0, 200) };
  }
}

const results = [];
for (const base of ENDPOINTS) {
  for (const [tokenLabel, token, headerName] of TOKENS) {
    const row = await probe(`${base} /v1/models [${tokenLabel}]`, `${base}/v1/models`, token, headerName);
    results.push(row);
    note(row.status === null ? `${row.label} → ERR ${row.error}` : `${row.label} → HTTP ${row.status} ${row.head.slice(0, 120)}`);
  }
}

// 对"能通"的端点再试一次 Anthropic 推理路径：能列出模型 ≠ 能推理（上游 401 就是这种）
const alive = [...new Set(results.filter((r) => r.status !== null && r.status !== 404).map((r) => new URL(r.url).origin))];
note('可连通端点：', alive.join(' , ') || '【无】');
for (const origin of alive) {
  const row = await probe(
    `${origin} /v1/messages`,
    `${origin}/v1/messages`,
    LIKE_CODE_TOKEN,
    'x-api-key',
  ).catch(() => null);
  // 上面 probe 只发 GET；推理路径要 POST，这里单独发一次
  try {
    const response = await fetchWithTimeout(`${origin}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': LIKE_CODE_TOKEN, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'Claude-Sonnet-4.6', max_tokens: 16, messages: [{ role: 'user', content: '回答一个字：好' }] }),
    }, 60000);
    const text = (await response.text()).slice(0, 300).replaceAll('\n', ' ');
    results.push({ label: `${origin} POST /v1/messages`, url: origin, status: response.status, head: text });
    note(`${origin} POST /v1/messages → HTTP ${response.status} ${text.slice(0, 160)}`);
  } catch (error) {
    results.push({ label: `${origin} POST /v1/messages`, url: origin, status: null, error: String(error?.message ?? error).slice(0, 200) });
    note(`${origin} POST /v1/messages → ERR ${String(error?.message ?? error).slice(0, 160)}`);
  }
  void row;
}

writeDump('v2/endpoint-matrix', { at: new Date().toISOString(), results });
