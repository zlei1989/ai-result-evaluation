#!/usr/bin/env node
/**
 * 探针：codex 把 MCP 工具交给模型的**那一跳**到底通不通。
 *
 * 与 `mcp-status.mjs` 的分工：那一条证明「codex 自己把 server 起起来了、工具也发现了」；
 * 这一条回答下一跳——**发给模型（`/v1/responses`）的请求体里 `tools[]` 有没有那些工具**。
 *
 * 做法：本机放一个记录型中转（逐块转发、不改语义），codex 的 base_url 指向它；
 * 请求体在转发前落盘（`tools` 只留 `type` / `name` / 是否命名空间），凭据一律不入产物。
 *
 * 用法：
 *   node packages/server/agents/probe/v10/codex-mcp-tools-capture.mjs [--server=echo|playwright] [--model=GLM-5.3]
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
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
const BINARY = ARGS['binary'] ?? resolveCodexBinary();

/** 宿主配置里的 openai 供应商（凭据只用于转发，不进产物） */
const hostConfig = JSON.parse(readFileSync(join(homedir(), '.aieval', 'config.json'), 'utf8'));
const provider = (hostConfig.providers ?? []).find((item) => item.protocolType === 'openai');
if (provider === undefined) throw new Error('宿主配置里没有 openai 供应商');
const UPSTREAM = String(provider.baseUrl).replace(/\/+$/, '');
const API_KEY = String(provider.apiKey);
const MODEL = ARGS['model'] ?? provider.models?.[0]?.id ?? 'GLM-5.3';
const redact = (text) => String(text).split(API_KEY).join('***');

/** 读数落 `probe/dumps/v10/`（整个 `dumps/` 已 gitignore） */
const DUMP_DIR = join(HERE, '..', 'dumps', 'v10');

const root = mkdtempSync(join(tmpdir(), 'aieval-codex-tools-'));
const configHome = join(root, 'codex-home');
const cwd = join(root, 'workspace');
mkdirSync(configHome, { recursive: true });
mkdirSync(cwd, { recursive: true });

/**
 * 行内 `.npmrc`：与适配器同一条口径——把宿主 npm 配置里**registry 那一行**抄进行私有 HOME。
 * 少了它，npx 会从公网 registry 现下 61 MB（行内 HOME 一换，npm 的 userconfig 就换了文件）。
 * **只抄那一行**：宿主 `.npmrc` 里的认证 token 一个字节都不写进临时目录。
 */
const hostNpmrc = existsSync(join(homedir(), '.npmrc')) ? readFileSync(join(homedir(), '.npmrc'), 'utf8') : '';
const registryLine = hostNpmrc.split('\n').find((line) => /^\s*registry\s*=/.test(line));
if (registryLine !== undefined) writeFileSync(join(configHome, '.npmrc'), `${registryLine.trim()}\n`, 'utf8');

/** 独立文件的 echo server（见同目录 echo-server.mjs）；`PROBE_DELAY_MS` 是本轮 A/B 的自变量 */
const echoPath = join(HERE, 'echo-server.mjs');
const callLog = join(root, 'calls.jsonl');
writeFileSync(callLog, '', 'utf8');

const mcpServers =
  WHICH === 'playwright'
    ? { playwright: { command: 'npx', args: ['-y', '@playwright/mcp@latest', '--browser=chrome', '--isolated'], startup_timeout_sec: 30 } }
    : { probe: { command: process.execPath, args: [echoPath], env: { PROBE_CALL_LOG: callLog, ...(ARGS['delay'] ? { PROBE_DELAY_MS: ARGS['delay'] } : {}) }, startup_timeout_sec: 30 } };

/**
 * 回程改名表：`裸工具名 → mcp__<server>__<tool>`。
 *
 * codex 按「命名空间 + 工具名」解析模型发起的调用（`ToolName{namespace,name}`），而自定义网关
 * 转发回来的是**拍平后的裸名**（`browser_navigate`）⇒ 注册表查不到，回 `unsupported call`。
 * 上游 PR #17556 登记过它接受的另一种形态：**拍平的限定名** `mcp__<ns>__<tool>`。
 */
const renameMap = new Map();
/** 回程名字的目标形态模板（改名模式用） */
const RENAME_TEMPLATE = ARGS['rewrite-template'] ?? '{ns}__{tool}';
/** 回程改写模式：`rename`（改名字，缺省）| `namespace-field`（补 `namespace` 字段） */
const MODE = ARGS['rewrite-mode'] ?? 'rename';

/** 把一行 SSE 里 `function_call` 条目的名字改写成限定名（其余字节原样） */
function rewriteLine(line) {
  if (!line.startsWith('data:')) return line;
  const payload = line.slice(5).trim();
  if (payload === '' || payload === '[DONE]') return line;
  let event;
  try {
    event = JSON.parse(payload);
  } catch {
    return line;
  }
  const items = [];
  if (event.item !== undefined) items.push(event.item);
  if (Array.isArray(event.response?.output)) items.push(...event.response.output);
  let touched = false;
  for (const item of items) {
    if (item?.type !== 'function_call' || typeof item.name !== 'string') continue;
    const target = renameMap.get(item.name);
    if (target === undefined) continue;
    if (MODE === 'namespace-field') {
      /**
       * codex 的入站 `ResponseItem::FunctionCall` 有一格 **`namespace`**（`protocol/src/models.rs`）：
       * 命名空间是**独立字段**，不是名字前缀。补上它，名字保持裸名。
       */
      console.log(`[relay] 回程补 namespace：name=${item.name} namespace=${target.namespace}`);
      item.namespace = target.namespace;
    } else {
      console.log(`[relay] 回程改名：${item.name} → ${target.qualified}`);
      item.name = target.qualified;
    }
    touched = true;
  }
  if (!touched) return line;
  return `data: ${JSON.stringify(event)}\n`;
}

/** 逐行改写 SSE：只在完整的行上动手，跨块的半行留在 `pending` 里等下一块 */
function makeSseRewriter() {
  let pending = '';
  return {
    push(text) {
      pending += text;
      let out = '';
      for (;;) {
        const index = pending.indexOf('\n');
        if (index < 0) break;
        out += rewriteLine(pending.slice(0, index + 1));
        pending = pending.slice(index + 1);
      }
      return out;
    },
    flush() {
      const rest = pending;
      pending = '';
      return rest;
    },
  };
}

/** 记录型中转：请求体落盘，再逐块转发（`accept-encoding: identity`，见 v2 relay 的教训） */
const T0 = Date.now();
const at = () => Date.now() - T0;
const timeline = [];
const captured = [];
const relay = createServer((request, response) => {
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => {
    void (async () => {
      const raw = Buffer.concat(chunks);
      let summary = { path: request.url, method: request.method, note: '非 JSON' };
      if (raw.length > 0) {
        try {
          const body = JSON.parse(raw.toString('utf8'));
          summary = {
            atMs: at(),
            path: request.url,
            method: request.method,
            model: body.model,
            toolCount: Array.isArray(body.tools) ? body.tools.length : null,
            tools: Array.isArray(body.tools)
              ? body.tools.map((tool) => ({
                  type: tool.type ?? null,
                  name: tool.name ?? null,
                  nested: Array.isArray(tool.tools) ? tool.tools.map((one) => one.name ?? one.type ?? null) : null,
                  keys: Object.keys(tool),
                }))
              : null,
            inputKinds: Array.isArray(body.input) ? body.input.map((one) => one.type ?? one.role ?? null) : null,
          };
          captured.push(summary);
          /**
           * 回程改名表：`裸工具名 → 目标形态`。模板可用 `{ns}`（namespace 原名，如 `mcp__probe`）、
           * `{short}`（去掉 `mcp__` 前缀，如 `probe`）、`{tool}`（嵌套工具名）。
           * 缺省 `{ns}__{tool}` —— 上游 PR #17556 登记的「拍平限定名」形态。
           */
          for (const tool of body.tools ?? []) {
            if (tool.type !== 'namespace' || typeof tool.name !== 'string') continue;
            const short = tool.name.replace(/^mcp__/, '');
            for (const nested of tool.tools ?? []) {
              if (typeof nested.name !== 'string') continue;
              renameMap.set(nested.name, {
                namespace: tool.name,
                qualified: RENAME_TEMPLATE.replaceAll('{ns}', tool.name).replaceAll('{short}', short).replaceAll('{tool}', nested.name),
              });
            }
          }
        } catch {
          captured.push(summary);
        }
      }
      const headers = { ...request.headers };
      delete headers.host;
      delete headers['content-length'];
      delete headers['transfer-encoding'];
      headers['accept-encoding'] = 'identity';
      headers['content-length'] = String(raw.length);
      try {
        const upstream = await fetch(`${UPSTREAM}${request.url}`, {
          method: request.method,
          headers,
          body: request.method === 'GET' ? undefined : raw,
        });
        if (upstream.status >= 400) {
          const text = await upstream.text();
          console.log('[relay] 上游', upstream.status, redact(text).slice(0, 300));
          response.writeHead(upstream.status, { 'content-type': 'application/json' });
          response.end(text);
          return;
        }
        const outHeaders = {};
        upstream.headers.forEach((value, key) => {
          if (key === 'content-encoding' || key === 'content-length' || key === 'transfer-encoding') return;
          outHeaders[key] = value;
        });
        response.writeHead(upstream.status, outHeaders);
        if (upstream.body === null) {
          response.end();
          return;
        }
        const rewriter = ARGS['rewrite'] === 'true' ? makeSseRewriter() : null;
        const reader = upstream.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (rewriter === null) response.write(value);
          else response.write(rewriter.push(Buffer.from(value).toString('utf8')));
        }
        if (rewriter !== null) response.write(rewriter.flush());
        response.end();
      } catch (error) {
        console.log('[relay] 失败', redact(String(error?.message ?? error)).slice(0, 200));
        response.writeHead(502, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'relay failed' } }));
      }
    })();
  });
});
await new Promise((resolve) => relay.listen(0, '127.0.0.1', resolve));
const port = relay.address().port;

const child = spawn(BINARY, ['app-server'], {
  cwd,
  env: { ...process.env, HOME: configHome, CODEX_HOME: configHome, OPENAI_API_KEY: API_KEY },
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
      continue;
    }
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) responses.set(msg.id, msg);
    else {
      notifications.push(msg);
      // MCP 启动状态与 warning 进时间线：这一条探针要回答的是「请求发出时它到哪一档了」
      if (/mcpServer\/startupStatus|warning/.test(String(msg.method))) {
        timeline.push({ atMs: at(), method: msg.method, params: msg.params });
      }
    }
  }
});
const stderr = [];
child.stderr.setEncoding('utf8');
child.stderr.on('data', (chunk) => stderr.push(String(chunk)));

let nextId = 1;
function request(method, params) {
  const id = nextId++;
  const done = new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      if (!responses.has(id)) return;
      clearInterval(timer);
      const msg = responses.get(id);
      if (msg.error === undefined) resolve(msg.result);
      else reject(new Error(method + ': ' + JSON.stringify(msg.error)));
    }, 50);
    setTimeout(() => {
      clearInterval(timer);
      reject(new Error(method + ' 超时'));
    }, 180_000);
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  return done;
}

const out = { which: WHICH, model: MODEL, upstream: UPSTREAM, root, notifications: [], captured, statusList: null, stderrTail: '' };
try {
  await request('initialize', { clientInfo: { name: 'probe', title: 'probe', version: '0.0.1' }, capabilities: { experimentalApi: true } });
  const threadStart = await request('thread/start', {
    model: MODEL,
    cwd,
    sandbox: 'danger-full-access',
    approvalPolicy: 'never',
    config: {
      model_provider: 'aieval',
      model_providers: {
        aieval: { name: 'aieval', base_url: `http://127.0.0.1:${port}/v1`, wire_api: 'responses', env_key: 'OPENAI_API_KEY' },
      },
      mcp_servers: mcpServers,
      ...(ARGS['nonprefixed'] === undefined
        ? {}
        : { features: { non_prefixed_mcp_tool_names: { server_names: ARGS['nonprefixed'].split(',') } } }),
    },
  });
  const threadId = threadStart?.thread?.id ?? null;
  out.threadId = threadId;
  timeline.push({ atMs: at(), method: '(thread/start 响应)' });
  /**
   * `--status=before` 才在这里查启动状态；默认 `after`。
   *
   * 为什么默认挪到轮次之后：`mcpServerStatus/list` **会阻塞到 server connected**（它要交工具表），
   * 提前查就把 `turn/start` 顶到了 ready 之后——上一轮的读数因此被污染成「codex 自己会等 MCP」。
   * 这条探针要问的是「**不等**的时候工具进没进请求体」，查询必须放在轮次后面。
   */
  if (ARGS['status'] === 'before') {
    await request('mcpServerStatus/list', { threadId }).then((one) => {
      out.statusList = one;
    }).catch(() => {});
  }
  // `--nowait` 缺省：与适配器同序——thread/start 之后立刻 turn/start
  if (ARGS['waitready'] === 'true') {
    for (let i = 0; i < 60; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      if (notifications.some((n) => n.method === 'mcpServer/startupStatus/updated' && n.params?.status === 'ready')) break;
    }
  }
  const turnStart = await request('turn/start', {
    threadId,
    input: [{
      type: 'text',
      text: ARGS['prompt'] ?? '请把你当前可用的工具名字**原样列出来**（用逗号分隔），不要调用任何工具，不要解释。',
      text_elements: [],
    }],
  }).catch((error) => ({ error: String(error?.message ?? error) }));
  out.turnStart = turnStart;
  timeline.push({ atMs: at(), method: '(turn/start 请求，waitready=' + String(ARGS['waitready'] ?? 'false') + ')' });
  for (let i = 0; i < 120; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const done = notifications.find(
      (n) => n.method === 'turn/completed' && n.params?.threadId === threadId,
    );
    if (done !== undefined) {
      out.turnCompleted = done.params?.turn?.status ?? null;
      break;
    }
  }
  if (ARGS['status'] !== 'before') {
    await request('mcpServerStatus/list', { threadId }).then((one) => {
      out.statusList = one;
    }).catch(() => {});
  }
} catch (error) {
  out.error = String(error?.message ?? error);
} finally {
  out.timeline = timeline;
  out.notifications = notifications.map((n) => ({ method: n.method, params: n.params }));
  // 模型答复（agentMessage 条目）：这一格才是「模型到底看见了什么」的读数
  out.finalText = (() => {
    const items = notifications
      .filter((n) => n.method === 'item/completed' && n.params?.item?.type === 'agentMessage')
      .map((n) => n.params.item.text ?? (n.params.item.content ?? []).map((part) => part.text ?? '').join(''));
    return items.at(-1) ?? null;
  })();
  // MCP 工具调用的**厂商侧结论**：codex 拒收时这一格才有 error 原文（`unsupported call: <tool>`）
  out.mcpCalls = notifications
    .filter((n) => n.method === 'item/completed' && n.params?.item?.type === 'mcpToolCall')
    .map((n) => ({
      server: n.params.item.server ?? null,
      tool: n.params.item.tool ?? null,
      status: n.params.item.status ?? null,
      error: n.params.item.error?.message ?? n.params.item.error ?? null,
    }));
  out.stderrTail = redact(stderr.join('')).slice(-3000);
  out.callLog = readFileSync(callLog, 'utf8').trim();
  const file = join(DUMP_DIR, `codex-mcp-tools-capture-${WHICH}.json`);
  mkdirSync(DUMP_DIR, { recursive: true });
  writeFileSync(file, redact(JSON.stringify(out, null, 2)), 'utf8');
  console.log(`[probe] 产物：${file}`);
  child.kill('SIGKILL');
  relay.close();
}

console.log('[target]', `${UPSTREAM}/v1/responses`, 'model=', MODEL, 'server=', WHICH);
console.log('[mcp status]', JSON.stringify(out.statusList)?.slice(0, 400));
console.log('[notify] 非 lifecycle 的通知：');
for (const n of out.notifications) {
  if (/mcp|warning|error|deprecat/i.test(String(n.method))) console.log('   ', n.method, JSON.stringify(n.params)?.slice(0, 400));
}
console.log('[时间线]');
for (const one of out.timeline) console.log('   ', String(one.atMs).padStart(6), 'ms', one.method, one.params === undefined ? '' : JSON.stringify(one.params).slice(0, 120));
for (const one of out.captured) console.log('   ', String(one.atMs).padStart(6), 'ms (模型请求) tools=' + String(one.toolCount));
console.log('[tools 数] 每次请求：', out.captured.map((one) => `toolCount=${one.toolCount}`).join(' , ') || '(零次请求)');
for (const one of out.captured) {
  if (one.tools == null) continue;
  console.log(`   请求 tools（${one.tools.length}）：`);
  for (const tool of one.tools) {
    console.log('     -', tool.type, tool.name, tool.nested === null ? '' : `嵌套=${JSON.stringify(tool.nested)}`);
  }
}
console.log('[turn]', out.turnCompleted ?? out.turnStart?.error ?? '(未结算)');
console.log('[模型最终答复]', out.finalText ?? '(无)');
console.log('[厂商侧 mcpToolCall]', JSON.stringify(out.mcpCalls ?? []));
console.log('[server 侧调用]', out.callLog === '' ? '(零)' : out.callLog);
