/**
 * 网关回来之后的**凭据矩阵**：`/v1/models` 收的 key 不等于推理端点收的 key（实测踩到）。
 *
 * 现象（2026-10-01）：用 `proxygateway/config.json` 的 `apiKeys.likecode` 打
 * `POST /v1/responses` 得到 **401**，报文是 GBK 残字（解码后是「登录态丢失，请重启再试」），
 * 而同一个 key 打 `GET /v1/models` 是 **200**。⇒ 必须先找出**能推理**的那把凭据，再谈复跑。
 *
 * 候选来源（只枚举**名字**与长度，不打印值）：
 *   ① `proxygateway/config.json` 的**每一个** `apiKeys.*`；
 *   ② `probe/v2/lib/gateway.mjs` 里逐字记着的那把 prod key（上一轮真机跑通过的那把）；
 *   ③ `~/.cc-switch/cc-switch.db` 的 `ANTHROPIC_AUTH_TOKEN`（上一轮报告记的凭据来源）。
 *
 * 判据：每条 × 每个端点，`POST /v1/responses` 的状态码；命中 200 即"能推理"。
 *
 * 用法：node probe/v4/gateway-credentials.mjs
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fetchWithTimeout, note, writeDump } from './lib/env.mjs';

const CONFIG_FILE = 'D:\\zhanglei1120\\coding\\proxygateway\\config.json';

/** 候选凭据：{来源标签, 值}。值**不打印**。 */
function candidates() {
  const out = [];
  if (existsSync(CONFIG_FILE)) {
    const text = readFileSync(CONFIG_FILE, 'utf8');
    // apiKeys 段里的每一个 `"name": "value"`（该文件含 GBK 残字，不用 JSON.parse）
    const block = /"apiKeys"\s*:\s*\{([\s\S]*?)\}/.exec(text)?.[1] ?? '';
    for (const hit of block.matchAll(/"([A-Za-z0-9_-]+)"\s*:\s*"([^"]+)"/g)) {
      out.push({ from: `proxygateway.apiKeys.${hit[1]}`, value: hit[2] });
    }
  }
  // 上一轮 v2 的 lib/gateway.mjs 里逐字记着的那把（prod）
  out.push({ from: 'probe/v2/lib/gateway.mjs 常量', value: '26503ecc0f4f4c748ba7239af0d76eff' });
  // cc-switch 库里的 anthropic token（上一轮报告的凭据来源）
  const db = join(homedir(), '.cc-switch', 'cc-switch.db');
  if (existsSync(db)) {
    const text = readFileSync(db, 'latin1');
    const hits = [...new Set([...text.matchAll(/[A-Za-z0-9_-]{32,64}/g)].map((one) => one[0]))].slice(0, 6);
    for (const [index, value] of hits.entries()) out.push({ from: `cc-switch.db 第 ${index + 1} 段候选`, value });
  }
  // 去重（同值只留第一个来源）
  const seen = new Set();
  return out.filter((one) => (seen.has(one.value) ? false : (seen.add(one.value), true)));
}

const ENDPOINTS = [
  { label: 'prod-https', origin: 'https://likecode-llm-proxy.jd.com' },
  { label: 'prod-http', origin: 'http://likecode-llm-proxy.jd.com' },
  { label: 'test-http', origin: 'http://likecode-llm-proxy-test.jd.com' },
];

const BODY = JSON.stringify({ model: 'gpt-5.6-sol', input: 'say ok', max_output_tokens: 16 });

async function tryInference(origin, key) {
  const at = Date.now();
  try {
    const response = await fetchWithTimeout(`${origin}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: BODY,
    }, 45_000);
    const text = await response.text();
    return { status: response.status, ms: Date.now() - at, bodyHead: text.slice(0, 160) };
  } catch (error) {
    return { status: null, ms: Date.now() - at, error: String(error?.message ?? error).slice(0, 160) };
  }
}

const list = candidates();
note(`候选凭据 ${list.length} 条：`, JSON.stringify(list.map((one) => `${one.from}(len=${one.value.length})`)));

const matrix = [];
for (const candidate of list) {
  for (const endpoint of ENDPOINTS) {
    const result = await tryInference(endpoint.origin, candidate.value);
    matrix.push({ from: candidate.from, endpoint: endpoint.label, ...result });
    note(`${candidate.from} × ${endpoint.label} →`, result.status ?? '✗', result.status === 200 ? '✅ 能推理' : (result.bodyHead ?? result.error ?? ''));
  }
}

const winners = [...new Set(matrix.filter((row) => row.status === 200).map((row) => `${row.from} × ${row.endpoint}`))];
note('能用（200）的组合：', winners.length === 0 ? '【无】' : winners.join(' | '));

const file = writeDump('v4/gateway-credentials', {
  at: new Date().toISOString(),
  candidates: list.map((one) => ({ from: one.from, length: one.value.length })),
  matrix: matrix.map((row) => ({ ...row, bodyHead: row.bodyHead === undefined ? null : row.bodyHead.replace(/[0-9a-f]{32,}/gi, '<redacted>') })),
  winners,
  verdict: winners.length === 0
    ? '没有任何候选能通过 /v1/responses ⇒ 网关虽可达但**推理路径不可用**，复跑仍被挡（要拿到能推理的凭据）'
    : `可用凭据：${winners.join(' | ')} ⇒ 可继续在网关路径上复跑`,
});
note('落盘：', file);
