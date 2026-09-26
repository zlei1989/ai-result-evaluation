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
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
/** dump 根：`probe/dumps/`（gitignore 覆盖整个目录）。 */
export const DUMP_DIR = join(HERE, '..', '..', 'dumps');

/**
 * 可用上游网关（2026-09-30 实测）：
 *  - 测试环境 `likecode-llm-proxy-test.jd.com` **不可达**（Test-NetConnection 为 False）；
 *  - 生产环境 `likecode-llm-proxy.jd.com` 可达，且三个 key 都能列出模型。
 * 凭据取自 `D:\zhanglei1120\coding\proxygateway\config.json` 的 `apiKeys`（该网关自己的上游凭据）。
 */
export const GATEWAY_BASE_URL = 'https://likecode-llm-proxy.jd.com/v1';
export const GATEWAY_API_KEY = '26503ecc0f4f4c748ba7239af0d76eff';

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
