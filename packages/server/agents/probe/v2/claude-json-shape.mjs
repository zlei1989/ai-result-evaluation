/**
 * 只读检查 `~/.claude.json` 的**顶层键与敏感格**（不打印任何密钥原文）。
 *
 * 为什么需要：真机探测里一旦 `settingSources` 非空，请求就转到 **Bedrock** 并失败
 * （`InvokeModelWithResponseStream … ValidationException`），而 `~/.claude/settings.json` 并不存在。
 * `~/.claude.json` 是 CLI 自己的配置存储，很可能就是那个把 provider 改掉的来源。
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { note, writeDump } from './lib/gateway.mjs';

const file = join(homedir(), '.claude.json');
const raw = readFileSync(file, 'utf8');
const parsed = JSON.parse(raw);

/** 只保留"形状"：字符串打码，对象只留键名。 */
function shape(value, depth = 0) {
  if (depth > 2) return '…';
  if (value === null) return 'null';
  if (Array.isArray(value)) return `[${value.length} 项]`;
  if (typeof value === 'object') return `{ ${Object.keys(value).slice(0, 20).join(', ')}${Object.keys(value).length > 20 ? ', …' : ''} }`;
  if (typeof value === 'string') return value.length <= 40 ? JSON.stringify(value) : `"${value.slice(0, 12)}…"（len=${value.length}）`;
  return String(value);
}

note('文件大小 =', raw.length);
note('顶层键：');
for (const key of Object.keys(parsed)) note('  ·', key, '=', shape(parsed[key]));

// 与 provider 选择有关的格单独列出
const interesting = ['env', 'model', 'forceLoginMethod', 'hasCompletedOnboarding', 'primaryApiKey', 'customApiKeyResponses'];
for (const key of interesting) {
  if (parsed[key] !== undefined) note('【关注】', key, '=', shape(parsed[key]));
}

writeDump('v2/claude-json-shape', {
  at: new Date().toISOString(),
  file,
  size: raw.length,
  topLevelKeys: Object.keys(parsed),
  shapes: Object.fromEntries(Object.keys(parsed).map((key) => [key, shape(parsed[key])])),
});
