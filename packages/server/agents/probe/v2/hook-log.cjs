/**
 * codex 的 hook 落盘器：读完 stdin 的 JSON 载荷，按事件名追加到日志文件。
 *
 * 为什么这么简单：设计稿 §7.5.5 ⑥ 定的口径是「**我们只用它做只读观测**：
 * 命令读完 stdin、写自己的落盘物、返回 0，不注入、不阻断」。
 * 事件名从载荷自身的 `hook_event_name` 读，免去为每个事件写一个脚本。
 *
 * 用法（由 codex 以 hook 命令拉起）：node hook-log.cjs <日志目录>
 */
const { appendFileSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');

const outDir = process.argv[2] ?? '.';
mkdirSync(outDir, { recursive: true });

let body = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  body += chunk;
});
process.stdin.on('end', () => {
  let name = 'unknown';
  try {
    name = JSON.parse(body).hook_event_name ?? 'unknown';
  } catch {
    /* 载荷不是 JSON 也照样留痕 */
  }
  appendFileSync(join(outDir, 'hooks.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), event: name, raw: body })}\n`, 'utf8');
  // 只读观测：不改写模型上下文、不阻断
  process.stdout.write(JSON.stringify({ continue: true }));
  process.exit(0);
});
