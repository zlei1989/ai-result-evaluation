/**
 * 从 cc-switch 的 SQLite 里**只读**抽出可用的 provider 环境（base URL / 认证方式），
 * 密钥值一律打码，只回报"有没有、长度多少"。
 *
 * 为什么要它：本轮 claude / codex 的真机项都要一个讲对应协议、且**带登录态**的端点。
 * 上游 `likecode-llm-proxy.jd.com` 的推理端点对 provider apiKey 回 401（`/v1/models` 却 200）
 * ——说明推理要的是**用户登录 token**，而那份 token 由 cc-switch 托管。
 */
import { readFileSync } from 'node:fs';
import { note, writeDump } from './lib/gateway.mjs';

const DB = 'C:/Users/zhanglei1120/.cc-switch/cc-switch.db';
const raw = readFileSync(DB).toString('latin1');

/** 把 `"key":"value"` 形态的片段抽出来；只保留可读 ASCII。 */
function blocksAround(marker, window = 900, limit = 8) {
  const out = [];
  let i = raw.indexOf(marker);
  while (i >= 0 && out.length < limit) {
    out.push(raw.slice(Math.max(0, i - window), i + window).replace(/[^\x20-\x7e]/g, '.'));
    i = raw.indexOf(marker, i + 1);
  }
  return out;
}

const mask = (value) => (value.length <= 8 ? '***' : `${value.slice(0, 6)}…${value.slice(-4)}（len=${value.length}）`);

const providers = [];
for (const block of blocksAround('ANTHROPIC_AUTH_TOKEN')) {
  const baseUrl = /ANTHROPIC_BASE_URL"\s*:\s*"([^"]+)"/.exec(block)?.[1] ?? null;
  const token = /ANTHROPIC_AUTH_TOKEN"\s*:\s*"([^"]+)"/.exec(block)?.[1] ?? null;
  const model = /ANTHROPIC_MODEL"\s*:\s*"([^"]+)"/.exec(block)?.[1] ?? null;
  const smallModel = /ANTHROPIC_SMALL_FAST_MODEL"\s*:\s*"([^"]+)"/.exec(block)?.[1] ?? null;
  providers.push({ baseUrl, token: token === null ? null : mask(token), tokenLen: token?.length ?? 0, model, smallModel });
}

note('cc-switch 里 ANTHROPIC_* provider 条目数：', providers.length);
for (const p of providers) note('  ·', JSON.stringify(p));

// 另外扫一遍 codex / responses 侧的配置痕迹（只报键名与 base URL，不报密钥）
const codexMarkers = ['CODEX_API_KEY', 'OPENAI_BASE_URL', 'base_url', 'wire_api'];
const codexHits = {};
for (const marker of codexMarkers) codexHits[marker] = blocksAround(marker, 200, 3).length;
note('codex 侧标记命中次数：', JSON.stringify(codexHits));

writeDump('v2/cc-switch-providers', {
  at: new Date().toISOString(),
  providers,
  codexMarkerHits: codexHits,
  note: '密钥只保留前后缀与长度，原文不落盘',
});
