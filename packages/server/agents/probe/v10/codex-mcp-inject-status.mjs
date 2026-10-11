#!/usr/bin/env node
/**
 * 探针：codex 侧的 MCP **注入落点**到底成没成 —— 不调模型，只问 codex 自己。
 *
 * 判据三层，一层比一层硬：
 *   ① 原始通知里有 `mcpServer/startupStatus/updated`（含 `warning` 的**完整 params**，产品日志只留 method）；
 *   ② `mcpServerStatus/list` 的响应里那一台在不在、状态是不是 ready；
 *   ③ 那一台**发现的工具**（名字逐字）—— 这一格才是「工具真进了 codex 的工具表」的证据。
 *
 * 用法：
 *   node packages/server/agents/probe/v10/codex-mcp-inject-status.mjs [--server=echo|playwright] [--wait=15000]
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveCodexBinary } from './codex-binary.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ARGS = Object.fromEntries(
  process.argv.slice(2).map((raw) => {
    const [key, ...rest] = raw.replace(/^--/, '').split('=');
    return [key, rest.join('=') || 'true'];
  }),
);
const WHICH = ARGS['server'] ?? 'echo';
const WAIT_MS = Number(ARGS['wait'] ?? 15_000);
const BINARY = ARGS['binary'] ?? resolveCodexBinary();

/** 读数落 `probe/dumps/v10/`（整个 `dumps/` 已 gitignore） */
const DUMP_DIR = join(HERE, '..', 'dumps', 'v10');

const root = mkdtempSync(join(tmpdir(), 'aieval-codex-mcp-status-'));
const configHome = join(root, 'codex-home');
const cwd = join(root, 'workspace');
mkdirSync(configHome, { recursive: true });
mkdirSync(cwd, { recursive: true });

/** 最小 MCP stdio server：把每次 tools/call 落盘（server 侧硬证据） */
const ECHO = `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
function send(m){process.stdout.write(JSON.stringify(m)+'\\n');}
let buf='';
process.stdin.setEncoding('utf8');
process.stdin.on('data',(c)=>{buf+=c;for(let nl;(nl=buf.indexOf('\\n'))>=0;){const line=buf.slice(0,nl).trim();buf=buf.slice(nl+1);if(!line)continue;let m;try{m=JSON.parse(line)}catch{continue}
if(m.method==='initialize')send({jsonrpc:'2.0',id:m.id,result:{protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'aieval-probe',version:'1.0.0'}}});
else if(m.method==='tools/list')send({jsonrpc:'2.0',id:m.id,result:{tools:[{name:'probe_echo',description:'回显',inputSchema:{type:'object',properties:{value:{type:'string'}},required:['value']}}]}});
else if(m.method==='tools/call'){appendFileSync(process.env.PROBE_CALL_LOG,JSON.stringify({at:new Date().toISOString(),name:m.params?.name})+ '\\n');send({jsonrpc:'2.0',id:m.id,result:{content:[{type:'text',text:'echo:'+String(m.params?.arguments?.value??'')}],isError:false}});}
else if(m.id!==undefined)send({jsonrpc:'2.0',id:m.id,result:{}});}});
process.stdin.on('end',()=>process.exit(0));
`;
const echoPath = join(root, 'echo.mjs');
writeFileSync(echoPath, ECHO, 'utf8');
const callLog = join(root, 'calls.jsonl');
writeFileSync(callLog, '', 'utf8');

const mcpServers =
  WHICH === 'playwright'
    ? { playwright: { command: 'npx', args: ['-y', '@playwright/mcp@latest', '--browser=chrome', '--isolated'], startup_timeout_sec: 30 } }
    : { probe: { command: process.execPath, args: [echoPath], env: { PROBE_CALL_LOG: callLog }, startup_timeout_sec: 30 } };

const child = spawn(BINARY, ['app-server'], {
  cwd,
  env: { ...process.env, HOME: configHome, CODEX_HOME: configHome },
  stdio: ['pipe', 'pipe', 'pipe'],
});

const notifications = [];
const responses = new Map();
let buf = '';
child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  buf += chunk;
  for (let nl; (nl = buf.indexOf('\n')) >= 0; ) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (line === '') continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      notifications.push({ unparsed: line.slice(0, 200) });
      continue;
    }
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) responses.set(msg.id, msg);
    else notifications.push(msg);
  }
});
child.stderr.setEncoding('utf8');
const stderr = [];
child.stderr.on('data', (chunk) => stderr.push(String(chunk)));

let nextId = 1;
function request(method, params) {
  const id = nextId++;
  const done = new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      if (responses.has(id)) {
        clearInterval(timer);
        const msg = responses.get(id);
        if (msg.error === undefined) resolve(msg.result);
        else reject(new Error(method + ': ' + JSON.stringify(msg.error)));
      }
    }, 50);
    setTimeout(() => {
      clearInterval(timer);
      reject(new Error(`${method} 超时`));
    }, 120_000);
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  return done;
}

const out = { which: WHICH, root, notifications: [], statusList: null, warnings: [], stderrTail: '' };
try {
  await request('initialize', { clientInfo: { name: 'probe', title: 'probe', version: '0.0.1' }, capabilities: { experimentalApi: true } });
  out.threadStart = await request('thread/start', {
    model: 'GLM-5.3',
    cwd,
    sandbox: 'danger-full-access',
    approvalPolicy: 'never',
    config: {
      model_provider: 'aieval',
      model_providers: { aieval: { name: 'aieval', base_url: 'http://127.0.0.1:9/v1', wire_api: 'responses', env_key: 'OPENAI_API_KEY' } },
      mcp_servers: mcpServers,
    },
  });
  await new Promise((resolve) => setTimeout(resolve, WAIT_MS));
  const threadId = out.threadStart?.thread?.id ?? null;
  out.statusVariants = {};
  for (const [label, params] of [
    ['empty', {}],
    ['threadId', { threadId }],
    ['threadIds', { threadIds: [threadId] }],
  ]) {
    try {
      out.statusVariants[label] = await request('mcpServerStatus/list', params);
    } catch (error) {
      out.statusVariants[label] = { error: String(error?.message ?? error) };
    }
  }
  out.statusList = out.statusVariants['threadId'] ?? null;
} catch (error) {
  out.error = String(error?.message ?? error);
} finally {
  out.notifications = notifications.map((n) => ({ method: n.method, params: n.params }));
  out.warnings = notifications.filter((n) => /warning|deprecat|error/i.test(String(n.method)));
  out.stderrTail = stderr.join('').slice(-3000);
  const file = join(DUMP_DIR, `codex-mcp-inject-status-${WHICH}.json`);
  mkdirSync(DUMP_DIR, { recursive: true });
  writeFileSync(file, JSON.stringify(out, null, 2), 'utf8');
  console.log(`[probe] 产物：${file}`);
  child.kill('SIGKILL');
}

// 打印判据
for (const n of out.notifications) {
  if (/mcp|warning/i.test(String(n.method))) console.log('[notify]', n.method, JSON.stringify(n.params)?.slice(0, 600));
}
console.log('[status/list]', JSON.stringify(out.statusList)?.slice(0, 2000));
if (out.error) console.log('[error]', out.error);
