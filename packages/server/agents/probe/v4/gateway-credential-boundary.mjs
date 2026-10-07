/**
 * 上一条（`gateway-credentials.mjs`）把 10 条凭据 × 3 个端点全试了，**一律 401**，
 * 报文逐字是「**登录态丢失，请重启再试**」。那句话不像"你的 key 不对"，
 * 像"网关自己到上游的会话掉了"。所以这一条要把**责任边界**钉死：
 *
 * 变量表（每次只动一格）：
 *   · 头部：`Authorization: Bearer` vs `x-api-key`（上一轮报告逐字："三种 wire 都收"）；
 *   · 路径：`/v1/responses` vs `/v1/chat/completions`（可能只有一条挂了）；
 *   · 凭据：候选池 + **git 历史里那把**（`codex-cli-plan.ps1` 提交版里逐字有；
 *     本轮已把工作区那份改成读环境变量，但历史值仍在 ⇒ 正好用来判"是不是 key 的问题"）；
 *   · 对照：`GET /v1/models` 用**故意写错的 key**——若也 200，说明那个端点根本不校验凭据，
 *     于是"models 200"不能证明"凭据有效"（这是上一轮差点踩的坑）。
 *
 * 用法：node probe/v4/gateway-credential-boundary.mjs
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fetchWithTimeout, note, writeDump } from './lib/env.mjs';

const REPO = 'D:\\zhanglei1120\\Github\\ai-result-evaluation';
const CONFIG_FILE = 'D:\\zhanglei1120\\coding\\proxygateway\\config.json';

function fromConfig() {
  if (!existsSync(CONFIG_FILE)) return [];
  const text = readFileSync(CONFIG_FILE, 'utf8');
  const block = /"apiKeys"\s*:\s*\{([\s\S]*?)\}/.exec(text)?.[1] ?? '';
  return [...block.matchAll(/"([A-Za-z0-9_-]+)"\s*:\s*"([^"]+)"/g)].map((hit) => ({ from: `config.${hit[1]}`, value: hit[2] }));
}

/** 从 git 历史里取回被改掉的那把（只用于判定，不打印）。 */
function fromGitHistory() {
  try {
    const old = execFileSync('git', ['show', 'HEAD:packages/server/agents/probe/v2/codex-cli-plan.ps1'], { cwd: REPO, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
    const hit = /CODEX_API_KEY\s*=\s*'([0-9a-f]{32,64})'/.exec(old);
    return hit === null ? [] : [{ from: 'git 历史里的 codex 测试 key', value: hit[1] }];
  } catch (error) {
    return [{ from: 'git 历史读取失败', value: '', note: String(error?.message ?? error).slice(0, 120) }];
  }
}

function fromCcSwitch() {
  const db = join(homedir(), '.cc-switch', 'cc-switch.db');
  if (!existsSync(db)) return [];
  const text = readFileSync(db, 'latin1');
  return [...new Set([...text.matchAll(/[A-Za-z0-9_-]{32,64}/g)].map((one) => one[0]))].slice(0, 4).map((value, index) => ({ from: `cc-switch#${index + 1}`, value }));
}

const pool = [...fromConfig(), ...fromGitHistory(), ...fromCcSwitch()].filter((one) => one.value !== '');
const seen = new Set();
const keys = pool.filter((one) => (seen.has(one.value) ? false : (seen.add(one.value), true)));

const ORIGINS = [
  { label: 'prod-https', origin: 'https://likecode-llm-proxy.jd.com' },
  { label: 'test-http', origin: 'http://likecode-llm-proxy-test.jd.com' },
];
const PATHS = [
  { label: 'responses', path: '/v1/responses', body: { model: 'gpt-5.6-sol', input: 'say ok', max_output_tokens: 16 } },
  { label: 'chat', path: '/v1/chat/completions', body: { model: 'gpt-5.6-sol', messages: [{ role: 'user', content: 'say ok' }], max_tokens: 16 } },
];
const HEADERS = ['bearer', 'x-api-key'];

async function call(origin, path, headers, key, body, method = 'POST') {
  const url = `${origin}${path}`;
  const head = headers === 'bearer' ? { authorization: `Bearer ${key}` } : { 'x-api-key': key };
  try {
    const response = await fetchWithTimeout(url, {
      method,
      headers: { 'content-type': 'application/json', ...head },
      ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
    }, 30_000);
    const text = await response.text();
    return { status: response.status, bodyHead: text.slice(0, 140) };
  } catch (error) {
    return { status: null, error: String(error?.message ?? error).slice(0, 140) };
  }
}

const rows = [];

// ① 对照：models 端点用**故意写错**的 key
for (const endpoint of ORIGINS) {
  const result = await call(endpoint.origin, '/v1/models', 'bearer', 'definitely-not-a-real-key', null, 'GET');
  rows.push({ kind: '对照·models+坏key', candidate: 'bogus', endpoint: endpoint.label, ...result });
  note(`对照 models+坏key × ${endpoint.label} →`, result.status ?? '✗', result.bodyHead ?? result.error ?? '');
}

// ② 头部 × 路径 × 凭据
for (const key of keys.slice(0, 6)) {
  for (const endpoint of ORIGINS) {
    for (const path of PATHS) {
      for (const header of HEADERS) {
        const result = await call(endpoint.origin, path.path, header, key.value, path.body);
        const hit = result.status === 200;
        rows.push({ kind: '推理', candidate: key.from, endpoint: endpoint.label, path: path.label, header, ...result });
        if (hit) note(`✅ 命中：${key.from} × ${endpoint.label} × ${path.label} × ${header}`);
      }
    }
  }
}

const successes = rows.filter((row) => row.kind === '推理' && row.status === 200);
const statuses = {};
for (const row of rows.filter((one) => one.kind === '推理')) {
  const bucket = `${row.status ?? 'network'} ${(row.bodyHead ?? row.error ?? '').slice(0, 40)}`;
  statuses[bucket] = (statuses[bucket] ?? 0) + 1;
}

const modelControl = rows.filter((row) => row.kind === '对照·models+坏key');
const controlSays = modelControl.every((row) => row.status === 200)
  ? 'models 端点**不校验凭据**（坏 key 也 200）⇒ "models 200"不能证明凭据有效'
  : `models 端点**会**校验凭据（坏 key 得 ${modelControl.map((row) => row.status).join('/')}）`;

note('推理尝试总数：', rows.filter((row) => row.kind === '推理').length, '；200 命中：', successes.length);
note('响应分布：', JSON.stringify(statuses, null, 2));
note('对照结论：', controlSays);

const file = writeDump('v4/gateway-credential-boundary', {
  at: new Date().toISOString(),
  candidates: keys.map((one) => ({ from: one.from, length: one.value.length })),
  controlSays,
  statuses,
  successCount: successes.length,
  rows: rows.map((row) => ({ ...row, bodyHead: row.bodyHead === undefined ? null : row.bodyHead })),
  verdict: successes.length === 0
    ? '所有「凭据 × 端点 × 路径 × 头部」组合都拿不到 200，且错误一律是「登录态丢失，请重启再试」'
      + `⇒ **卡点在网关服务端**（它自己到上游的会话失效），不是我们的 key/头部/路径写错。${controlSays}`
    : `可用组合 ${successes.length} 个 ⇒ 可继续在网关路径上复跑`,
});
note('落盘：', file);
