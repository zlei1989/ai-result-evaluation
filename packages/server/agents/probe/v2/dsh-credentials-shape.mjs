/**
 * 报告 dsh 凭据库的**结构**（有哪些键、值的长度与前后缀），不打印任何完整密钥。
 *
 * 为什么要它：本轮 dsh 的每条真机探测都要一个能跑的凭据通道。2026-09-22 的四格对照实测结论是
 * 「`dshHome` 指向空目录时**只有** `DEEPSEEK_API_KEY` 环境变量能救」⇒ 探测必须能自动取到它。
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { note } from './lib/gateway.mjs';

const file = join(homedir(), '.dsh', '.credentials.yaml');
const text = readFileSync(file, 'utf8');

const mask = (value) => (value.length <= 8 ? '***' : `${value.slice(0, 4)}…${value.slice(-3)}（len=${value.length}）`);

note('凭据文件：', file);
for (const line of text.split(/\r?\n/)) {
  if (!line.includes(':')) continue;
  const [key, ...rest] = line.split(':');
  const value = rest.join(':').trim().replace(/^["']|["']$/g, '');
  if (value === '') {
    note('  ·', key.trim(), '= <容器>');
  } else {
    note('  ·', key.trim(), '=', mask(value));
  }
}
