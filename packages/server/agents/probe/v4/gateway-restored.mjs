/**
 * VPN 恢复后的第一条：**内网网关到底回来了没有、模型清单里有没有 codex 认识的带 profile 名字**。
 *
 * 为什么这两件事必须一起问：「牌 A」的唯一前提是**网关提供 `gpt-6-astra`（或 `-sol` / `-luna`）**，
 * 而上一轮实测网关侧只有 `gt-6-as-a` / `gt-6-sol-a` / `gt-6-lu-a`（codex **不认识**这些名字）。
 * 若这次清单里出现了 codex 认识的名字，那么**走适配器真实路径**就能验 multi-agent + hook，
 * 不必再用本机模型名中转或 DeepSeek 路由。
 *
 * 判据（机械核对，不靠推断）：
 *   ① 两个主机名（prod / test）的 `/v1/models` 各自能不能回 200；
 *   ② 清单里**逐字**有没有 `gpt-6-astra` / `gpt-6-sol` / `gpt-6-luna`；
 *   ③ 顺带把 `gt-6-*` 与 `gpt-5.*` 的存在情况一并登记（排障要用）。
 *
 * 用法：node probe/v4/gateway-restored.mjs
 */
import { existsSync, readFileSync } from 'node:fs';
import { fetchWithTimeout, note, writeDump } from './lib/env.mjs';

const CONFIG_FILE = 'D:\\zhanglei1120\\coding\\proxygateway\\config.json';

/** 取 likecode 那把 key（该文件带 BOM/GBK 残字，JSON.parse 会抛 ⇒ 正则抓那一段）。 */
function loadGatewayKey() {
  if (!existsSync(CONFIG_FILE)) return null;
  const hit = /"likecode"\s*:\s*"([^"]+)"/.exec(readFileSync(CONFIG_FILE, 'utf8'));
  return hit === null ? null : hit[1];
}

const key = loadGatewayKey();
const CODEX_PROFILE_SLUGS = ['gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna'];
const PROBE_NAMES = [...CODEX_PROFILE_SLUGS, 'gt-6-as-a', 'gt-6-sol-a', 'gt-6-lu-a', 'gpt-5.5', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.4'];

/** 端点矩阵：prod https / prod http / test http 都试（上一轮三台的可用性不一致）。 */
const ENDPOINTS = [
  { label: 'prod-https', origin: 'https://likecode-llm-proxy.jd.com' },
  { label: 'prod-http', origin: 'http://likecode-llm-proxy.jd.com' },
  { label: 'test-http', origin: 'http://likecode-llm-proxy-test.jd.com' },
  { label: 'test-https', origin: 'https://likecode-llm-proxy-test.jd.com' },
];

async function probe(endpoint) {
  const url = `${endpoint.origin}/v1/models`;
  const at = Date.now();
  try {
    const response = await fetchWithTimeout(url, { headers: { Authorization: `Bearer ${key ?? ''}` } }, 25_000);
    const text = await response.text();
    let ids = [];
    try {
      const body = JSON.parse(text);
      ids = (body.data ?? []).map((one) => one.id ?? one.name ?? '<无 id>');
    } catch { /* 非 JSON 就留原文 */ }
    return { ...endpoint, status: response.status, ms: Date.now() - at, count: ids.length, ids, bodyHead: ids.length === 0 ? text.slice(0, 200) : null };
  } catch (error) {
    return { ...endpoint, status: null, ms: Date.now() - at, error: String(error?.message ?? error).slice(0, 200) };
  }
}

if (key === null) note('⚠️ 拿不到 likecode key（配置里没有 apiKeys.likecode）——下面一律带空 Bearer');

const results = [];
for (const endpoint of ENDPOINTS) results.push(await probe(endpoint));

for (const one of results) {
  note(one.label.padEnd(11), one.status ?? '✗', `${one.ms}ms`, one.error ?? `${one.count} 个模型`);
}

/** 挑一个可用端点做逐名核对。 */
const usable = results.find((one) => one.status === 200 && Array.isArray(one.ids) && one.ids.length > 0) ?? null;
const nameCheck = usable === null
  ? { skipped: '没有任何端点返回可用清单' }
  : Object.fromEntries(PROBE_NAMES.map((name) => [name, usable.ids.includes(name)]));

note('可用端点：', usable === null ? '【无】' : `${usable.label}（${usable.count} 个模型）`);
note('逐名核对：', JSON.stringify(nameCheck));
const profileHits = CODEX_PROFILE_SLUGS.filter((name) => nameCheck[name] === true);
note('codex 认识的带 profile slug 命中：', profileHits.length === 0 ? '【无】——牌 A 前提仍未满足' : profileHits.join(', '));

if (usable !== null) {
  note('清单里有 codex 相关名字的：', usable.ids.filter((id) => /gpt-6|gt-6|gpt-5/.test(id)).join(', ') || '【无】');
}

const file = writeDump('v4/gateway-restored', {
  at: new Date().toISOString(),
  keyPresent: key !== null,
  endpoints: results,
  usableEndpoint: usable?.label ?? null,
  allModelIds: usable?.ids ?? null,
  nameCheck,
  codexProfileSlugsFound: profileHits,
  verdict: profileHits.length > 0
    ? `牌 A 前提满足：网关提供了 codex 认识且带 profile 的名字（${profileHits.join(', ')}）⇒ 可走适配器真实路径验 multi-agent + hook`
    : '牌 A 前提仍未满足：清单里没有 codex 认识的带 profile slug ⇒ codex 的 profile 仍只能靠本机中转/别的路由',
});
note('落盘：', file);
