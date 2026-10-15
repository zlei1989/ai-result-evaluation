/**
 * v11 探针（cc 提问通道）的共享外壳：假上游 + SDK 跑一次 + 原始帧落盘。
 *
 * 三个不变量：
 *  1. **凭据只从环境变量读**（`AIEVAL_PROBE_GATEWAY_API_KEY` / `AIEVAL_PROBE_GATEWAY_BASE_URL`）——
 *     源码里不出现任何明文 key；脚本式上游（默认）用一个占位串，连真 key 都不需要。
 *  2. **脚本式上游**：本机起一个假 `/v1/messages`，主动回一帧 `AskUserQuestion` 的 `tool_use`，
 *     于是「模型会不会问」不再是自变量——被问的机制本身变成确定性的。
 *     它还让我们**逐字看到模型看到了什么**：工具结果是下一条入站请求体里 `messages[]` 的
 *     `tool_result`，那是本探针最硬的一份原文。
 *  3. **原始控制帧**（可选 `--tee`）：把 SDK 拉起的 CLI 包一层透明转发，stdin/stdout 各落一份
 *     NDJSON ⇒ 看到 `can_use_tool` / `request_user_dialog` 的**线级原文**，不靠回调反推。
 *
 * 口径：只记录、不做产品判断；落盘前 redact；dump 一律写 `probe/dumps/v11/`（整个 dumps 已 gitignore）。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));
/** 包根（`packages/server/agents`）：lib → v11 → probe → agents。 */
const PACKAGE_ROOT = join(HERE, '..', '..', '..');
/** dump 根：`probe/dumps/v11/`（已 gitignore）。 */
export const DUMP_DIR = join(PACKAGE_ROOT, 'probe', 'dumps', 'v11');

/** 统一进度前缀（几支探针共用 v11 目录，前缀里带 cc 便于分辨）。 */
export function note(...parts) {
  console.log('[v11/cc]', ...parts);
}

const SECRETS = [process.env.AIEVAL_PROBE_GATEWAY_API_KEY].filter(
  (one) => typeof one === 'string' && one.length >= 8,
);

/** 把已知凭据从产物里抹掉（脚本式上游用的是占位串，这条只在 live 档起作用）。 */
export function redact(value) {
  let out = typeof value === 'string' ? value : JSON.stringify(value);
  for (const secret of SECRETS) out = out.split(secret).join('***');
  return out;
}

/** 写一份 JSON dump，返回路径。 */
export function writeDump(name, payload) {
  const file = join(DUMP_DIR, `${name}.json`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, redact(JSON.stringify(payload, null, 2)), 'utf8');
  return file;
}

/**
 * 原始消息流按条落盘（一行一条），**每次运行覆盖**：同一个 label 重跑时不该把上一轮的读数混进来
 * （混进来会让「控制帧 2 条」这种计数看起来像厂商发了两帧，实际是两轮各一帧）。
 */
export function writeJsonl(name, rows) {
  const file = join(DUMP_DIR, `${name}.jsonl`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, rows.map((row) => `${redact(row)}\n`).join(''), 'utf8');
  return file;
}

/** `--key=value` 形式的命令行开关（缺省值由调用方给）。 */
export function parseFlags(argv, defaults) {
  const flags = { ...defaults };
  for (const arg of argv) {
    if (!arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    if (eq === -1) flags[arg.slice(2)] = true;
    else flags[arg.slice(2, eq)] = arg.slice(eq + 1);
  }
  return flags;
}

/** 造一个最小工作区（`Read` / `Bash` 需要一个 cwd；`.claude` 也隔离在临时目录里）。 */
export function makeWorkspace(prefix = 'aieval-v11-cc-') {
  const root = mkdtempSync(join(tmpdir(), prefix));
  writeFileSync(join(root, 'notes.txt'), 'alpha\nbeta\ngamma\nNEEDLE-one\ndelta\n', 'utf8');
  const configHome = join(root, '.agenthome');
  mkdirSync(configHome, { recursive: true });
  return { root, configHome };
}

/** 脚本式上游要的凭据：占位串即可（请求根本不出本机）。 */
export const PLACEHOLDER_KEY = 'probe-placeholder-not-a-secret';

/**
 * live 档要的凭据：**只从环境变量读**。
 * 缺哪一个就打印哪一个的名字并退出——不要回落到读宿主配置文件，那会让「跑不起来」看起来像「探测失败」。
 */
export function requireGatewayCredential() {
  const key = process.env.AIEVAL_PROBE_GATEWAY_API_KEY;
  const baseUrl = process.env.AIEVAL_PROBE_GATEWAY_BASE_URL;
  const missing = [];
  if (typeof key !== 'string' || key === '') missing.push('AIEVAL_PROBE_GATEWAY_API_KEY');
  if (typeof baseUrl !== 'string' || baseUrl === '') missing.push('AIEVAL_PROBE_GATEWAY_BASE_URL');
  if (missing.length > 0) {
    note(`缺环境变量：${missing.join(' / ')} ⇒ live 档退出（脚本式档不需要 key）。`);
    process.exit(2);
  }
  return { key, baseUrl };
}

// ───────────────────────────── 假上游 ─────────────────────────────

function sse(events) {
  return events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');
}

/** 一轮纯文本收尾（`end_turn`）。 */
export function textReply(model, text) {
  return {
    stopReason: 'end_turn',
    content: [{ type: 'text', text }],
    sse: sse([
      ['message_start', { type: 'message_start', message: { id: 'msg_p', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } }],
      ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }],
      ['message_stop', { type: 'message_stop' }],
    ]),
  };
}

/** 一帧 `tool_use`（`stop_reason: 'tool_use'`）——用来逼客户端真的去执行那个工具。 */
export function toolReply(model, { id, name, input }) {
  const partial = JSON.stringify(input);
  return {
    stopReason: 'tool_use',
    content: [{ type: 'tool_use', id, name, input }],
    sse: sse([
      ['message_start', { type: 'message_start', message: { id: `msg_${id}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } }],
      ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name, input: {} } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: partial } }],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 5 } }],
      ['message_stop', { type: 'message_stop' }],
    ]),
  };
}

/**
 * 起假上游。`decide(record, state)` 收到每条入站请求的摘要，返回
 * `{ kind: 'text' | 'tool', text?, id?, name?, input? }`。
 *
 * 记录里存**完整请求体**（`body`）——本探针最关键的判据「模型看到的工具结果」就在后一条请求体的
 * `messages[]` 里，靠 `toolResultsFrom()` 抽出来。
 */
export async function startUpstream({ decide }) {
  const records = [];
  const state = { mainSeen: 0, childSeen: 0 };
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body = null;
      try {
        body = JSON.parse(raw);
      } catch {
        body = null;
      }
      const tools = Array.isArray(body?.tools) ? body.tools : [];
      const isCountTokens = String(request.url ?? '').includes('count_tokens');
      const record = {
        index: records.length,
        path: String(request.url ?? ''),
        model: body?.model ?? null,
        stream: body?.stream ?? null,
        toolCount: tools.length,
        toolNames: tools.map((one) => one?.name),
        hasAskUserQuestion: tools.some((one) => one?.name === 'AskUserQuestion'),
        // 主循环与子智能体都会打到这里：`system` 的第一段里带 subagent 标记的是子会话
        isChild: JSON.stringify(body?.system ?? '').includes('sidechain') || JSON.stringify(body?.system ?? '').includes('subagent'),
        messages: body?.messages ?? [],
        body,
        reply: null,
      };
      records.push(record);
      if (isCountTokens) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ input_tokens: 1 }));
        return;
      }
      if (tools.length > 0) {
        if (record.isChild) state.childSeen += 1;
        else state.mainSeen += 1;
      }
      const decision = decide(record, state) ?? { kind: 'text', text: 'ok' };
      record.holdMs = Number(decision.holdMs ?? 0);
      /** 响应正文的收尾：普通档立即回；`holdMs > 0` 的档延后回。 */
      const respond = () => {
        record.respondedAt = Date.now();
        if (body?.stream === true) {
          const payload = decision.kind === 'tool'
            ? toolReply(record.model ?? 'probe', decision)
            : textReply(record.model ?? 'probe', decision.text ?? 'ok');
          record.reply = { kind: decision.kind, content: payload.content };
          response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
          response.end(payload.sse);
          return;
        }
        const payload = decision.kind === 'tool'
          ? { id: `msg_${decision.id}`, type: 'message', role: 'assistant', model: record.model ?? 'probe', content: [{ type: 'tool_use', id: decision.id, name: decision.name, input: decision.input }], stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }
          : { id: 'msg_p', type: 'message', role: 'assistant', model: record.model ?? 'probe', content: [{ type: 'text', text: decision.text ?? 'ok' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };
        record.reply = { kind: decision.kind, content: payload.content };
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(payload));
      };
      /**
       * **客户端在响应写完之前就断开** = 这一条在途请求被它自己撤了（`priority: 'now'` 的一格要读它）。
       * 判据放在 `respondedAt` 上而不是监听 `request.aborted`：后者在 node 的新版本里已废弃，
       * 且连接正常收尾时也会触发一次。
       */
      response.on('close', () => {
        if (record.respondedAt === undefined) {
          record.aborted = true;
          record.abortedAt = Date.now();
        }
      });
      if (record.holdMs > 0) {
        const timer = setTimeout(respond, record.holdMs);
        response.on('close', () => {
          if (record.respondedAt === undefined) clearTimeout(timer);
        });
        return;
      }
      respond();
    });
  });
  const url = await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve(`http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}`);
    });
  });
  return { url, records, state, close: () => server.close() };
}

// ───────────────────────────── 跑一次 SDK ─────────────────────────────

/**
 * 与适配器对齐的启动口径（`src/providers/cc/index.ts`）：`permissionMode` 按参数给，
 * `bypassPermissions` **必须**配 `allowDangerouslySkipPermissions: true`（少了后者整档静默失效）。
 *
 * `settingSources: []` + 临时 `CLAUDE_CONFIG_DIR`/`HOME`：本机 `~/.claude.json` 会把 provider
 * 切到别的后端、把工具表从 30 撑到 45（v2 实测），不隔离的话探测读数会被宿主配置污染。
 *
 * ⚠️ `extraOptions.env` 是**并入**而不是替换：tee 那一层要往子进程加三个 `PROBE_*` 变量，
 * 若整格替换掉，凭据就没了 —— CLI 会以 `apiKeySource: "none"` 起、在第一次 API 调用上以
 * `Not logged in · Please run /login` 收场，看起来像「厂商没下发请求」，其实是自己把 env 抹了。
 */
export function claudeOptions({ workspace, env, model, mode, extraOptions = {} }) {
  const { env: extraEnv, ...restOptions } = extraOptions;
  return {
    cwd: workspace.root,
    env: {
      ...process.env,
      HOME: workspace.configHome,
      USERPROFILE: workspace.configHome,
      CLAUDE_CONFIG_DIR: workspace.configHome,
      ...env,
      ...extraEnv,
    },
    model,
    // 与 v2 同格：把本次路由钉在 settings 档，防被测目录的 .claude/settings.json 抢走 base URL。
    settings: { env: { ANTHROPIC_BASE_URL: env.ANTHROPIC_BASE_URL } },
    settingSources: [],
    permissionMode: mode,
    ...(mode === 'bypassPermissions' ? { allowDangerouslySkipPermissions: true } : {}),
    ...restOptions,
  };
}

/** 脚本式上游的 env：base URL 指本机假上游，凭据用占位串。 */
export function scriptedEnv({ upstreamUrl, model }) {
  return {
    ANTHROPIC_BASE_URL: upstreamUrl,
    ANTHROPIC_API_KEY: PLACEHOLDER_KEY,
    ANTHROPIC_AUTH_TOKEN: PLACEHOLDER_KEY,
    ANTHROPIC_MODEL: model,
  };
}

/**
 * 跑一次 `sdk.query`，原始消息逐条落盘。超时用 `abortController` 收场——
 * 「挂住」这一档必须靠我们自己的墙钟上限收场（厂商侧没有 park deadline），
 * 所以**超时本身就是读数**：`timedOut: true` = 在预算内没有任何新消息。
 */
export async function runQuery({ label, prompt, options, timeoutMs }) {
  const sdk = await import('@anthropic-ai/claude-agent-sdk');
  const messages = [];
  const stderr = [];
  const abortController = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    abortController.abort();
  }, timeoutMs);
  let error = null;
  try {
    const query = sdk.query({
      prompt,
      options: {
        ...options,
        abortController,
        stderr: (data) => stderr.push(String(data)),
      },
    });
    for await (const message of query) {
      messages.push(message);
      if (messages.length >= 4000) break;
    }
  } catch (caught) {
    error = { name: caught?.constructor?.name ?? typeof caught, message: String(caught?.message ?? caught).slice(0, 2000) };
  } finally {
    clearTimeout(timer);
  }
  const file = writeJsonl(label, messages);
  const init = messages.find((one) => one?.type === 'system' && one?.subtype === 'init') ?? null;
  const result = messages.find((one) => one?.type === 'result') ?? null;
  note(`${label}：SDK 消息 ${messages.length} 条 → ${file}${timedOut ? `（到 ${timeoutMs}ms 上限被 abort）` : ''}`);
  if (error !== null) note(`${label} 抛错：`, error.name, error.message.slice(0, 300));
  return { messages, error, init, result, stderr: stderr.join(''), timedOut, file };
}

// ───────────────────────────── 原始控制帧（tee） ─────────────────────────────

/**
 * 解析 SDK **实际会 spawn 的那份** CLI：平台包里的原生二进制。
 * 为什么不用 `which claude`：SDK 走的是自带二进制（本机 2.1.281），全局装的那份可能是另一个版本
 * （本机 2.1.170）——版本不同会让读数对不上。
 *
 * `.pnpm` 虚拟store 在 **workspace 根** 而不是包根，所以要向上找；也允许用
 * `AIEVAL_PROBE_CLAUDE_BIN` 直接钉死（换版本对照时用）。
 */
export function resolveClaudeBinary() {
  const override = process.env.AIEVAL_PROBE_CLAUDE_BIN;
  if (typeof override === 'string' && override !== '' && existsSync(override)) return override;
  const pnpmDir = findPnpmStore();
  if (pnpmDir === null) return null;
  const sdkKey = '@anthropic-ai+claude-agent-sdk-';
  const hits = readdirSync(pnpmDir).filter((one) => one.startsWith(sdkKey) && !one.includes('@anthropic-ai+sdk'));
  for (const hit of hits) {
    const inner = join(pnpmDir, hit, 'node_modules', '@anthropic-ai');
    if (!existsSync(inner)) continue;
    for (const pkg of readdirSync(inner)) {
      if (!pkg.startsWith('claude-agent-sdk-')) continue;
      const bin = join(inner, pkg, 'claude');
      if (existsSync(bin)) return bin;
    }
  }
  return null;
}

/** 从包根向上找 pnpm 的虚拟 store（`node_modules/.pnpm`）；workspace 布局下它在仓根。 */
function findPnpmStore() {
  let dir = PACKAGE_ROOT;
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = join(dir, 'node_modules', '.pnpm');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** tee 包装脚本的路径（`.mjs` ⇒ SDK 用 `node <包装> <CLI 参数…>` 拉起，不需要可执行位）。 */
export const TEE_WRAPPER = join(HERE, 'cc-ask-tee.mjs');

/**
 * 预检：先单独跑一次 `--version`，确认这层包装真的能把 CLI 拉起来。
 * 为什么必须预检：包装挂了会让整轮 probe 读起来像「厂商没有下发请求」——那是**假绿**。
 * 预检失败就**大声**退回不 tee 的模式（并把原因写进产物）。
 */
export async function preflightTee(realBinary, timeoutMs = 20_000) {
  if (realBinary === null) return { ok: false, reason: '没找到 SDK 自带的那份 claude 二进制（不改用全局 claude）' };
  if (!existsSync(TEE_WRAPPER)) return { ok: false, reason: `包装脚本不在：${TEE_WRAPPER}` };
  return await new Promise((resolve) => {
    const child = spawn(process.execPath, [TEE_WRAPPER, '--version'], {
      env: { ...process.env, PROBE_REAL_CLAUDE: realBinary },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ ok: false, reason: `包装脚本 ${timeoutMs}ms 没回版本号` });
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      out += chunk;
    });
    child.stderr.on('data', (chunk) => {
      err += chunk;
    });
    child.on('error', (caught) => {
      clearTimeout(timer);
      resolve({ ok: false, reason: `包装脚本起不来：${String(caught?.message ?? caught)}` });
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      const ok = out.includes('Claude Code');
      resolve({ ok, version: out.trim(), code, reason: ok ? null : `包装脚本退出码 ${code}；stdout=${out.trim().slice(0, 200)}；stderr=${err.trim().slice(0, 200)}` });
    });
  });
}

/**
 * tee 的接线：告诉 SDK「CLI 就是这个包装脚本」，并把真实二进制与两份帧文件的路径交给它。
 * 帧文件写在 dump 目录里（gitignore），`--no-tee` 时两格都不加。
 */
export function teeOptions({ label, realBinary }) {
  return {
    executable: process.execPath,
    pathToClaudeCodeExecutable: TEE_WRAPPER,
    env: {
      PROBE_REAL_CLAUDE: realBinary,
      PROBE_FRAME_IN: join(DUMP_DIR, `${label}.frames-in.ndjson`),
      PROBE_FRAME_OUT: join(DUMP_DIR, `${label}.frames-out.ndjson`),
    },
  };
}

/** 读回原始帧（CLI 的出站帧在 `-out` 里：`control_request` 就是它向宿主要求的东西）。 */
export function readFrames(label) {
  const read = (suffix) => {
    const file = join(DUMP_DIR, `${label}.${suffix}.ndjson`);
    if (!existsSync(file)) return { file, frames: [], unparsed: 0 };
    const frames = [];
    let unparsed = 0;
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (line.trim() === '') continue;
      try {
        frames.push(JSON.parse(line));
      } catch {
        unparsed += 1;
      }
    }
    return { file, frames, unparsed };
  };
  return { incoming: read('frames-in'), outgoing: read('frames-out') };
}

/** 一帧控制请求的要点（谁在问、问什么、带没带子智能体身份）。 */
export function summarizeControlFrames(outgoing) {
  const rows = [];
  for (const frame of outgoing.frames) {
    if (frame?.type !== 'control_request') continue;
    const request = frame.request ?? {};
    rows.push({
      subtype: request.subtype ?? null,
      requestId: frame.request_id ?? null,
      toolName: request.tool_name ?? null,
      toolUseId: request.tool_use_id ?? null,
      agentId: request.agent_id ?? null,
      requiresUserInteraction: request.requires_user_interaction ?? null,
      dialogKind: request.dialog_kind ?? null,
      inputKeys: request.input === undefined || request.input === null ? null : Object.keys(request.input),
      input: request.input ?? null,
      payload: request.payload ?? null,
      message: request.message ?? null,
      fieldNames: Object.keys(request),
    });
  }
  return rows;
}

// ───────────────────────────── 读数抽取 ─────────────────────────────

/**
 * 「模型看到了什么」：把后续入站请求体里 `messages[]` 的 `tool_result` 块按 `tool_use_id` 抽出来。
 * 这是本探针最硬的一条判据——它不经过任何回调、不经过我们的投影，是**厂商自己写进上下文的那一份**。
 */
export function toolResultsFrom(records) {
  const found = new Map();
  for (const record of records) {
    for (const message of record.messages ?? []) {
      const content = message?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (block?.type !== 'tool_result') continue;
        const previous = found.get(block.tool_use_id);
        found.set(block.tool_use_id, {
          requestIndex: record.index,
          role: message.role ?? null,
          toolUseId: block.tool_use_id,
          isError: block.is_error ?? false,
          content: block.content ?? null,
          seenTimes: (previous?.seenTimes ?? 0) + 1,
        });
      }
    }
  }
  return [...found.values()];
}

/**
 * 「模型看到了什么」的另一条来源：**SDK 消息流**里的 `tool_result` 块。
 * 为什么留两条来源：脚本式上游能拿到**下一条请求体**（最硬），live 档没有上游可读，
 * 只能从消息流取；两条都在时互为交叉验证（不一致就说明中间还有一层投影）。
 */
export function toolResultsFromMessages(messages) {
  const found = new Map();
  for (const message of messages) {
    const content = message?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type !== 'tool_result') continue;
      found.set(block.tool_use_id, {
        toolUseId: block.tool_use_id,
        isError: block.is_error ?? false,
        content: block.content ?? null,
      });
    }
  }
  return [...found.values()];
}

/** 回调收到了什么：**字段名与值全部**打出来（Q3 的判据就是这一格）。 */
export function reportCallback(label, toolName, input, options) {
  const optionFields = {};
  for (const [key, value] of Object.entries(options ?? {})) {
    optionFields[key] = key === 'signal'
      ? `AbortSignal{aborted:${value?.aborted === true}}`
      : value;
  }
  note(`【${label}】回调被调用：toolName=${toolName}`);
  note(`  入参字段：${JSON.stringify(Object.keys(input ?? {}))}`);
  note(`  入参原文：${JSON.stringify(input)}`);
  note(`  回调选项字段：${JSON.stringify(Object.keys(optionFields))}`);
  note(`  回调选项值：${JSON.stringify(optionFields, (key, value) => (value instanceof AbortSignal ? `AbortSignal{aborted:${value.aborted}}` : value))}`);
  return { toolName, input, optionFields };
}

/** 把一段文字按固定宽度折行（报告里贴原文时用，避免一行刷屏）。 */
export function wrap(text, width = 100) {
  const out = [];
  for (const line of String(text).split('\n')) {
    let rest = line;
    while (rest.length > width) {
      out.push(rest.slice(0, width));
      rest = rest.slice(width);
    }
    out.push(rest);
  }
  return out.join('\n');
}
