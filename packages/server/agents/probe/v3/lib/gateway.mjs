/**
 * v3 探测的共享外壳：网关地址、凭据加载、redact、落盘、有界 fetch。
 *
 * 为什么**不**复用 `probe/v2/lib/gateway.mjs`：那份是另一个会话的**未提交**产物
 * （`git status` 里是 `?? probe/v2/`），本目录要进提交，依赖别人的未跟踪文件会让
 * 「另一次检出」直接跑不起来。两份各自自洽，代价是几十行重复——如实登记。
 *
 * 凭据口径：**绝不把密钥写进仓库**。来源顺序：
 *   1. 环境变量 `AIEVAL_PROBE_GATEWAY_API_KEY`；
 *   2. `D:\zhanglei1120\coding\proxygateway\config.json` 的 `apiKeys.likecode`
 *      （该文件带 BOM 且含 GBK 残字，`JSON.parse` 会抛，故用正则取那一段）。
 * 落盘前一律 redact（dump 可能被贴进报告）。
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
/** dump 根：`probe/dumps/`（整个目录已 gitignore——可能含网关返回的敏感原文）。 */
export const DUMP_DIR = join(HERE, '..', '..', 'dumps');

/** 2026-09-30 实测**不可达**的内部网关（内网/VPN 不通；同一天 09:55 的 v2 探测还是 200）。 */
export const GATEWAY_ORIGIN = 'https://likecode-llm-proxy.jd.com';
export const GATEWAY_BASE_URL = `${GATEWAY_ORIGIN}/v1`;

/**
 * 2026-09-30 实测**可达**的 DeepSeek 官方 API —— 本计划 Task 0 的真机靶子。
 * 三条 wire 全通（16 token 最小推理）：`/v1/responses`、`/anthropic/v1/messages`、`/chat/completions`。
 * 凭据来自 `~/.dsh/.credentials.yaml` 的 `DEEPSEEK_API_KEY`（**不落进仓库**）。
 */
export const DEEPSEEK_ORIGIN = 'https://api.deepseek.com';
/** Responses / Chat Completions 的根（pi-ai 的 openai-responses 会追加 `/responses`）。 */
export const DEEPSEEK_OPENAI_BASE_URL = `${DEEPSEEK_ORIGIN}/v1`;
/** Messages 的根（pi-ai 的 anthropic-messages 会追加 `/v1/messages` ⇒ 这里**不带** `/v1`）。 */
export const DEEPSEEK_ANTHROPIC_BASE_URL = `${DEEPSEEK_ORIGIN}/anthropic`;
/** 默认模型：官方 API 认这个 id（实测 200）。 */
export const DEEPSEEK_MODEL = 'deepseek-chat';

const CONFIG_FILE = 'D:\\zhanglei1120\\coding\\proxygateway\\config.json';
const CREDENTIALS_FILE = join(homedir(), '.dsh', '.credentials.yaml');
/** **产品自己的**配置文件：供应商记录（协议 / 地址 / 密钥 / 模型清单）的真源。 */
const AIEVAL_CONFIG_FILE = join(homedir(), '.aieval', 'config.json');

/**
 * 读产品配置里的某条供应商记录——**探测要跟生产用同一份事实**，自己另编一份必然漂移。
 * 该文件的正文含 GBK 残字（历史原因），故先试 `JSON.parse`，失败再用正则从
 * `"providers"` 段里逐字段抓——**不因为解析失败就放弃这一格**。
 * @param {'openai'|'anthropic'} protocolType
 * @returns {{name: string, baseUrl: string, apiKey: string, model: string, contextWindow?: number, maxOutputTokens?: number}}
 */
export function loadProductProvider(protocolType) {
  const text = readFileSync(AIEVAL_CONFIG_FILE, 'utf8');
  let providers = [];
  try {
    providers = JSON.parse(text)?.providers ?? [];
  } catch {
    // 逐条抓 `{ ... "protocolType": "<x>" ... }`：够用即可，不做通用 JSON 修复
    for (const hit of text.matchAll(/\{[^{}]*"protocolType"\s*:\s*"([a-z]+)"[^{}]*\}/g)) {
      const block = hit[0];
      const grab = (key) => new RegExp(`"${key}"\\s*:\\s*"([^"]*)"`).exec(block)?.[1];
      providers.push({ protocolType: hit[1], name: grab('name'), baseUrl: grab('baseUrl'), apiKey: grab('apiKey') });
    }
  }
  const provider = providers.find((one) => one?.protocolType === protocolType);
  if (provider === undefined) throw new Error(`${AIEVAL_CONFIG_FILE} 里没有 ${protocolType} 协议的供应商`);
  const first = Array.isArray(provider.models) ? provider.models[0] : undefined;
  return {
    name: provider.name,
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    model: first?.id,
    contextWindow: first?.contextWindow,
    maxOutputTokens: first?.maxOutputTokens,
  };
}

/**
 * 读 DeepSeek 官方 API 的密钥（**不打印**）。
 * 从 `~/.dsh/.credentials.yaml` 里按正则取——该文件是 dsh 自己的凭据库，
 * 本机的 dsh 就是用它跑通的，故它也是探测最省事的真源。
 */
export function loadDeepSeekKey() {
  const fromEnv = process.env.AIEVAL_PROBE_DEEPSEEK_API_KEY;
  if (typeof fromEnv === 'string' && fromEnv !== '') return fromEnv;
  if (!existsSync(CREDENTIALS_FILE)) {
    throw new Error(`拿不到 DeepSeek 凭据：设 AIEVAL_PROBE_DEEPSEEK_API_KEY，或提供 ${CREDENTIALS_FILE}`);
  }
  const hit = /DEEPSEEK_API_KEY:\s*(\S+)/.exec(readFileSync(CREDENTIALS_FILE, 'utf8'));
  if (hit === null) throw new Error(`${CREDENTIALS_FILE} 里没有 DEEPSEEK_API_KEY`);
  return hit[1];
}

/** 加载网关凭据；两处都没有时抛错并说清去哪配，不静默返回空串。 */
export function loadGatewayKey() {
  const fromEnv = process.env.AIEVAL_PROBE_GATEWAY_API_KEY;
  if (typeof fromEnv === 'string' && fromEnv !== '') return fromEnv;
  if (!existsSync(CONFIG_FILE)) {
    throw new Error(`拿不到网关凭据：设 AIEVAL_PROBE_GATEWAY_API_KEY，或提供 ${CONFIG_FILE}`);
  }
  // 该文件含 GBK 残字，JSON.parse 会抛 ⇒ 只在 apiKeys 段里按正则抓 likecode 那一格
  const text = readFileSync(CONFIG_FILE, 'utf8');
  const hit = /"likecode"\s*:\s*"([^"]+)"/.exec(text);
  if (hit === null) throw new Error(`${CONFIG_FILE} 里没有 apiKeys.likecode`);
  return hit[1];
}

/**
 * redact 用的密钥集合：**两处凭据都收**（内部网关的 likecode + DeepSeek 官方），
 * 且凭据库里出现的每个值都收——dump 会被人打开看，也可能被贴进报告。
 * 读不到就跳过（redact 不该成为新的崩溃点）。
 */
function collectSecrets() {
  const found = new Set();
  const push = (value) => {
    if (typeof value === 'string' && value.length >= 8) found.add(value);
  };
  push(process.env.AIEVAL_PROBE_GATEWAY_API_KEY);
  push(process.env.AIEVAL_PROBE_DEEPSEEK_API_KEY);
  try {
    if (existsSync(CONFIG_FILE)) {
      const text = readFileSync(CONFIG_FILE, 'utf8');
      for (const hit of text.matchAll(/"[A-Za-z0-9_-]+"\s*:\s*"([^"]{8,})"/g)) push(hit[1]);
    }
  } catch { /* 读不到就少一格 redact，不影响探测 */ }
  try {
    if (existsSync(CREDENTIALS_FILE)) {
      for (const hit of readFileSync(CREDENTIALS_FILE, 'utf8').matchAll(/:\s*(\S{8,})\s*$/gm)) push(hit[1]);
    }
  } catch { /* 同上 */ }
  try {
    if (existsSync(AIEVAL_CONFIG_FILE)) {
      for (const hit of readFileSync(AIEVAL_CONFIG_FILE, 'utf8').matchAll(/"apiKey"\s*:\s*"([^"]{8,})"/g)) push(hit[1]);
    }
  } catch { /* 同上 */ }
  return [...found];
}

const SECRETS = collectSecrets();

/** 把已知密钥从产物里抹掉。 */
export function redact(value) {
  let out = typeof value === 'string' ? value : JSON.stringify(value);
  for (const secret of SECRETS) {
    if (secret !== '') out = out.split(secret).join('***');
  }
  return out;
}

/** 写一份 JSON dump 到 `probe/dumps/<name>.json`，返回落盘路径。 */
export function writeDump(name, payload) {
  const file = join(DUMP_DIR, `${name}.json`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, redact(JSON.stringify(payload, null, 2)), 'utf8');
  return file;
}

/** 追加 JSONL（原始事件流按条落盘，便于 grep 而不必读整个大文件）。 */
export function appendJsonl(name, rows) {
  const file = join(DUMP_DIR, `${name}.jsonl`);
  mkdirSync(dirname(file), { recursive: true });
  for (const row of rows) appendFileSync(file, `${redact(row)}\n`, 'utf8');
  return file;
}

/**
 * 有界 fetch：所有对外调用都必须带时限，否则网关卡住会把探测变成挂死。
 * 判据用 `AbortController` 而不是 `AbortSignal.timeout`：后者在长流式响应上
 * 会把「还在滴流」的正常请求也砍掉，而我们要的是「连不上/不回头」的上界。
 */
export async function fetchWithTimeout(url, options = {}, timeoutMs = 180_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** 打印一行进度（统一前缀，便于在长日志里 grep）。 */
export function note(...parts) {
  console.log('[v3]', ...parts);
}
