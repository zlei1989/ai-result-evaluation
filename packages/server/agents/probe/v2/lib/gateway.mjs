/**
 * v2 真机验证的共享入口：网关地址、凭据、日志落盘。
 *
 * 为什么单独一个文件：本轮要跑 claude / codex / dsh 三家**多条**互不相同的探测，
 * 每家都要「同一份凭据 + 同一份落盘约定」；抄在每条脚本里必然漂移。
 *
 * 注意：
 *  - 本目录在 `probe/` 下，**不在** `src/`，故不进 `pnpm typecheck` / `pnpm test`；
 *  - dump 一律写到 `probe/dumps/`（整个目录已 gitignore——可能含网关返回的敏感原文）；
 *  - 写盘前必须 redact：dump 会被人打开看，也可能被贴进报告。
 */
import { mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
/** dump 根：`probe/dumps/`（gitignore 覆盖整个目录）。 */
export const DUMP_DIR = join(HERE, '..', '..', 'dumps');

/**
 * 可用上游网关（2026-09-30 实测）：
 *  - 测试环境 `likecode-llm-proxy-test.jd.com` **不可达**（Test-NetConnection 为 False）；
 *  - 生产环境 `likecode-llm-proxy.jd.com` 可达，且三个 key 都能列出模型。
 *
 * ⚠️ **凭据绝不写进源码**：明文进过 git 历史就再也拿不回来，轮换一次还得改一处代码。
 * **来源顺序**（与 `probe/v2/codex-cli-plan.ps1`、`probe/v3/lib/gateway.mjs` 同一条口径）：
 *   1. 环境变量 `AIEVAL_PROBE_GATEWAY_API_KEY`；
 *   2. 凭据文件里 `apiKeys.likecode` 那一格（候选位置见下面的 `GATEWAY_KEY_FILES`）：
 *      `AIEVAL_PROBE_GATEWAY_KEY_FILE` 指过去，或开发机既存的那一处绝对路径。这一格**也是一个外部输入、
 *      不是兜底默认**——key 只在你的机器上那份文件里，源码里一个字都没有（路径本身是源码里的一格，
 *      换机器就该用环境变量覆盖它）。该文件带 BOM 与 GBK 残字，`JSON.parse` 会抛 ⇒ 用正则取那一段。
 * 两处都拿不到时是空串：需要它的探测会自己失败在 401 上，而不是用一个来源不明的 key 静默跑。
 */
export const GATEWAY_BASE_URL = 'https://likecode-llm-proxy.jd.com/v1';

/** 本机凭据文件的候选位置（按序试；都没有就只认环境变量） */
const GATEWAY_KEY_FILES = [process.env.AIEVAL_PROBE_GATEWAY_KEY_FILE, 'D:\\zhanglei1120\\coding\\proxygateway\\config.json']
  .filter((one) => typeof one === 'string' && one !== '');

/** 取网关 key：环境变量优先，其次本机凭据文件；读不到返回空串（不抛——本文件被多个探测共用）。 */
function readGatewayKey() {
  const fromEnv = process.env.AIEVAL_PROBE_GATEWAY_API_KEY;
  if (typeof fromEnv === 'string' && fromEnv !== '') return fromEnv;
  for (const file of GATEWAY_KEY_FILES) {
    try {
      const hit = /"likecode"\s*:\s*"([^"]+)"/.exec(readFileSync(file, 'utf8'));
      if (hit !== null) return hit[1];
    } catch {
      // 换下一个候选；一个都没有就是空串
    }
  }
  return '';
}

export const GATEWAY_API_KEY = readGatewayKey();

const SECRETS = [GATEWAY_API_KEY];

/** 把已知密钥从产物里抹掉。 */
export function redact(text) {
  let out = text;
  for (const secret of SECRETS) {
    if (secret !== '') out = out.split(secret).join('***');
  }
  return out;
}

/** 写一份 JSON dump 到 `probe/dumps/<name>.json`，返回落盘路径。 */
export function writeDump(name, payload) {
  const file = join(DUMP_DIR, `${name}.json`);
  // 名字里可能带子目录（`v2/models`）⇒ 必须按**文件所在目录**建，而不是按 DUMP_DIR 建
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, redact(JSON.stringify(payload, null, 2)), 'utf8');
  return file;
}

/** 追加一行 JSONL（raw 事件流按条落盘，便于后续 grep 而不必读整个大文件）。 */
export function appendJsonl(name, rows) {
  const file = join(DUMP_DIR, `${name}.jsonl`);
  mkdirSync(dirname(file), { recursive: true });
  for (const row of rows) appendFileSync(file, `${redact(JSON.stringify(row))}\n`, 'utf8');
  return file;
}

/** 有界的 fetch：所有对外调用都必须带时限，否则网关卡住会把探测变成挂死。 */
export async function fetchWithTimeout(url, options = {}, timeoutMs = 180000) {
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
  console.log('[v2]', ...parts);
}
