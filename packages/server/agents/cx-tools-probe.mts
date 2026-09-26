/**
 * 临时探针：抓 codex 入站请求里的 `tools[]`（找 spawn_agent 的声明与参数 schema）
 * 与出站 tool call 载荷。用本地中继记录，不依赖网关。
 * 关键：`features.multi_agent = true` 时 spawn_agent 是否出现在工具表里。
 * 跑完即删。
 */
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const KEY = process.env.PROBE_KEY;
const LOG = join(tmpdir(), 'cx-tools.log');
writeFileSync(LOG, '');

const relay = http.createServer((cReq, cRes) => {
  let body = '';
  cReq.on('data', (c) => { body += c; });
  cReq.on('end', async () => {
    appendFileSync(LOG, `\n===== REQUEST ${cReq.method} ${cReq.url} =====\n${body}\n`);
    cRes.writeHead(400, { 'content-type': 'application/json' });
    cRes.end(JSON.stringify({ error: { message: 'probe: captured', type: 'invalid_request_error' } }));
  });
});
await new Promise((r) => relay.listen(7998, '127.0.0.1', r));
console.log('relay on 7998 (只记录，不转发)');

const home = join(tmpdir(), 'aieval-cxtools');
mkdirSync(join(home, 'ws'), { recursive: true });
writeFileSync(join(home, 'ws', 'notes.txt'), 'alpha\nbeta\ngamma\n');

const multiAgent = process.argv[2] === 'on';
writeFileSync(
  join(home, 'config.toml'),
  [
    'model = "GLM-5.3"',
    'model_provider = "aieval"',
    '',
    '[model_providers.aieval]',
    'name = "aieval"',
    'base_url = "http://127.0.0.1:7998/v1"',
    'wire_api = "responses"',
    'requires_openai_auth = true',
    '',
    '[features]',
    `multi_agent = ${multiAgent}`,
    '',
  ].join('\n'),
);

const exe = process.env.CX_EXE;
const env = { ...process.env, CODEX_HOME: home, CODEX_API_KEY: KEY, OPENAI_API_KEY: KEY, HOME: home, USERPROFILE: home };
try {
  execFileSync(exe, ['exec', '--skip-git-repo-check', 'say hi'], { encoding: 'utf8', env, timeout: 120000, cwd: join(home, 'ws'), stdio: 'pipe' });
} catch (e) {
  // 400 是预期的（中继不转发）
}

relay.close();
console.log(`\n===== multi_agent = ${multiAgent} =====`);
const log = (await import('node:fs')).readFileSync(LOG, 'utf8');
console.log('日志长度:', log.length);

// 找出工具声明
const names = [...log.matchAll(/"name"\s*:\s*"(spawn_agent|send_input|wait|close_agent|exec_command|apply_patch|update_plan|request_user_input|view_image|write_stdin|shell)"/g)].map((m) => m[1]);
console.log('工具名命中:', JSON.stringify([...new Set(names)]));

// 抓 "tools" 数组里的所有 name
const allTools = [...log.matchAll(/"type"\s*:\s*"(function|web_search|local_shell|computer_use_preview|mcp)"/g)].map((m) => m[1]);
console.log('tool type 分布:', JSON.stringify(allTools.reduce((a, b) => ((a[b] = (a[b] ?? 0) + 1), a), {})));

// spawn_agent 的完整声明
const i = log.indexOf('spawn_agent');
if (i >= 0) {
  console.log('\n=== spawn_agent 声明（前后 1400 字符）===');
  console.log(log.slice(Math.max(0, i - 300), i + 1400));
} else {
  console.log('\n（请求里没有 spawn_agent）');
}
