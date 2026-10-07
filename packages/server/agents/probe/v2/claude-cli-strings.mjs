/**
 * 在 claude CLI 的**二进制**里按字符串定位与「bash 沙箱 / 临时目录」相关的环境变量名。
 *
 * 为什么要它：真机上 claude 的 `Bash` 工具持续失败于
 * `EPERM: operation not permitted, mkdir '<TEMP>\claude\<slug>'`，
 * 而同一个目录从普通 node 进程里 mkdir 成功 ⇒ 限制来自 CLI 自己的沙箱层。
 * 要判断这是"本机环境限制"还是"我们少配了一个开关"，先得知道厂商暴露了哪些开关名。
 */
import { readFileSync } from 'node:fs';
import { note, writeDump } from './lib/gateway.mjs';

const CLI = 'D:/.nvm4w/nodejs/node_modules/@anthropic-ai/claude-code/bin/claude.exe';
const text = readFileSync(CLI).toString('latin1');

/** 抽出所有形如 `CLAUDE_CODE_XXX` 的大写标识符（长度 ≥8），去重排序。 */
const identifiers = new Set();
for (const match of text.matchAll(/CLAUDE_CODE_[A-Z0-9_]{3,60}/g)) identifiers.add(match[0]);

const sandboxish = [...identifiers].filter((name) => /SANDBOX|BASH|TEMP|TMP|PERMISSION|DISABLE/i.test(name)).sort();
note('CLAUDE_CODE_* 标识符总数 =', identifiers.size);
note('与沙箱/临时目录相关的：');
for (const name of sandboxish) note('  ·', name);

/** 再找与 `<TEMP>/claude/<slug>` 这个落点有关的片段（含 slug 生成方式）。 */
const slugHits = [];
for (const needle of ['C--', 'replace(/[^a-zA-Z0-9]/', 'EPERM', 'operation not permitted']) {
  const at = text.indexOf(needle);
  slugHits.push({ needle, found: at >= 0, context: at < 0 ? null : text.slice(Math.max(0, at - 260), at + 260).replace(/[^\x20-\x7e]/g, '.') });
}
for (const hit of slugHits) note('needle', JSON.stringify(hit.needle), '→', hit.found ? '有' : '无');

writeDump('v2/claude-cli-strings', {
  at: new Date().toISOString(),
  cli: CLI,
  identifierCount: identifiers.size,
  sandboxish,
  slugHits,
});
