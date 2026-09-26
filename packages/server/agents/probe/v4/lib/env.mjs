/**
 * v4 探测（未验证项收尾轮）的共享外壳：凭据、落盘、dsh 二进制解析。
 *
 * 为什么新开 v4 而不用 v2/v3：本轮的打法与上两轮不同（**不依赖内网网关**）——
 * 2026-10-01 实测内网 `likecode-llm-proxy.jd.com` 已不可达（Test-NetConnection 443 False、
 * HTTP 20s 超时），故本轮一律走 **DeepSeek 官方 API**（`api.deepseek.com`，实测可达）。
 * 上两轮的脚本把内网网关写死成常量，直接复用会让「跑不起来」看起来像「探测失败」。
 *
 * 约定（与 v2/v3 同）：
 *  - 不进 `src/`，故不参与 typecheck / test；
 *  - dump 一律写 `probe/dumps/v4/`（`dumps/` 整个目录已 gitignore）；
 *  - 落盘前 redact；**密钥绝不打印、绝不写进仓库**。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
/** dump 根：`probe/dumps/`（已 gitignore）。 */
export const DUMP_DIR = join(HERE, '..', '..', 'dumps');

/** DeepSeek 官方 API（2026-10-01 实测可达；三条 wire 全通，见 v3 的 lib/gateway.mjs）。 */
export const DEEPSEEK_ORIGIN = 'https://api.deepseek.com';
export const DEEPSEEK_OPENAI_BASE_URL = `${DEEPSEEK_ORIGIN}/v1`;
/** anthropic wire 的根：pi-ai 会追加 `/v1/messages`，故这里**不带** `/v1`。 */
export const DEEPSEEK_ANTHROPIC_BASE_URL = `${DEEPSEEK_ORIGIN}/anthropic`;

const CREDENTIALS_FILE = join(homedir(), '.dsh', '.credentials.yaml');

/** 读 DeepSeek 密钥（不打印）。与 v3 同一真源：dsh 自己的凭据库。 */
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

const SECRETS = (() => {
  const found = new Set();
  const push = (value) => {
    if (typeof value === 'string' && value.length >= 8) found.add(value);
  };
  push(process.env.AIEVAL_PROBE_DEEPSEEK_API_KEY);
  try {
    if (existsSync(CREDENTIALS_FILE)) {
      for (const hit of readFileSync(CREDENTIALS_FILE, 'utf8').matchAll(/:\s*(\S{8,})\s*$/gm)) push(hit[1]);
    }
  } catch { /* 读不到就少一格 redact */ }
  return [...found];
})();

/** 把已知密钥从产物里抹掉。 */
export function redact(value) {
  let out = typeof value === 'string' ? value : JSON.stringify(value);
  for (const secret of SECRETS) if (secret !== '') out = out.split(secret).join('***');
  return out;
}

/** 写一份 JSON dump 到 `probe/dumps/<name>.json`。 */
export function writeDump(name, payload) {
  const file = join(DUMP_DIR, `${name}.json`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, redact(JSON.stringify(payload, null, 2)), 'utf8');
  return file;
}

/** 追加 JSONL（原始事件按条落盘）。 */
export function appendJsonl(name, rows) {
  const file = join(DUMP_DIR, `${name}.jsonl`);
  mkdirSync(dirname(file), { recursive: true });
  for (const row of rows) appendFileSync(file, `${redact(row)}\n`, 'utf8');
  return file;
}

/** 有界 fetch：连不上/不回头必须有上界，否则探测变挂死。 */
export async function fetchWithTimeout(url, options = {}, timeoutMs = 180_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** 统一进度前缀。 */
export function note(...parts) {
  console.log('[v4]', ...parts);
}

/**
 * 解析真实 dsh 二进制。绕 `dsh-sdk-client`：`@deepseek-ai/dsh` 不是本包直接依赖，
 * pnpm 隔离布局下直接 resolve 会 MODULE_NOT_FOUND，而两者在 .pnpm 里是兄弟目录。
 */
export function resolveDshBin() {
  const require = createRequire(import.meta.url);
  const sdkPkg = require.resolve('@deepseek-ai/dsh-sdk-client/package.json');
  const bin = join(dirname(sdkPkg), '..', 'dsh', 'lib', 'bin.js');
  if (!existsSync(bin)) throw new Error(`推不出 dsh 二进制（找过 ${bin}）`);
  return bin;
}

/** 解析**适配器实际 spawn 的那份** codex 二进制（codex-sdk 0.156.1 自带的那份）。 */
export function resolveSdkCodexBin() {
  // `@openai/codex-sdk` 的 exports 既没有 `./package.json` 也没有 main（实测两次 ERR_PACKAGE_PATH_NOT_EXPORTED），
  // 故直接按**本包 node_modules 的相对路径**定位（HERE = probe/v4/lib ⇒ 上三级是包根）。
  const sdkRoot = join(HERE, '..', '..', '..', 'node_modules', '@openai', 'codex-sdk');
  const candidates = [
    join(sdkRoot, 'node_modules', '@openai', 'codex', 'bin', 'codex.exe'),
    join(sdkRoot, 'node_modules', '@openai', 'codex', 'bin', 'codex.js'),
    join(sdkRoot, 'vendor', 'codex.exe'),
  ];
  for (const one of candidates) if (existsSync(one)) return one;
  return `未找到（找过 ${candidates.join(' | ')}）`;
}
