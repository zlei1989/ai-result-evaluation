/**
 * 在 claude CLI 二进制里精确找**沙箱开关**与 `<TEMP>/claude/<slug>` 落点的相关串。
 *
 * 上一轮已确认 `CLAUDE_CODE_BASH_SANDBOX_SHOW_INDICATOR` 存在（说明确有一层 bash 沙箱）。
 * 本脚本把范围收窄到 SANDBOX / 沙箱实现串，并把 slug 生成与 mkdir 附近的原文打出来。
 */
import { readFileSync } from 'node:fs';
import { note, writeDump } from './lib/gateway.mjs';

const CLI = 'D:/.nvm4w/nodejs/node_modules/@anthropic-ai/claude-code/bin/claude.exe';
const text = readFileSync(CLI).toString('latin1');

/** 所有含 SANDBOX 的大写下划线标识符。 */
const ids = new Set();
for (const match of text.matchAll(/[A-Z][A-Z0-9_]{5,60}/g)) {
  if (/SANDBOX/.test(match[0])) ids.add(match[0]);
}
note('含 SANDBOX 的标识符：');
for (const id of [...ids].sort()) note('  ·', id);

/** 含 sandbox 的小写串（配置键名、错误文案）。 */
const lower = new Set();
for (const match of text.matchAll(/[a-z][a-z0-9_.-]{4,60}sandbox[a-z0-9_.-]{0,40}/gi)) lower.add(match[0]);
note('含 sandbox 的小写串（前 40 个）：');
for (const id of [...lower].sort().slice(0, 40)) note('  ·', id);

/** mkdir 失败附近：找出 slug 生成与目录拼装。 */
const hits = [];
for (const needle of ['mkdtemp', 'bash-sandbox', 'sandbox-exec', 'windows-sandbox', 'AppContainer', 'restricted token']) {
  const at = text.indexOf(needle);
  hits.push({
    needle,
    found: at >= 0,
    context: at < 0 ? null : text.slice(Math.max(0, at - 300), at + 300).replace(/[^\x20-\x7e]/g, '.'),
  });
}
for (const hit of hits) note('needle', JSON.stringify(hit.needle), '→', hit.found ? '有' : '无');

writeDump('v2/claude-cli-sandbox-strings', {
  at: new Date().toISOString(),
  sandboxIdentifiers: [...ids].sort(),
  sandboxLowerStrings: [...lower].sort(),
  hits,
});
