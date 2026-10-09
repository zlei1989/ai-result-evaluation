/**
 * v4 Q5：`turn/start` 的 `outputSchema` 在**真机**上到底成不成立。
 *
 * 四问（缺任一条结论都不成立）：
 *   ① 字段是否被 app-server 接受 —— `generate-json-schema` 的 `TurnStartParams.outputSchema` 只说
 *      「端口上有这一格」，不等于「这一版 CLI 跑得过」；
 *   ② wire 上它变成了什么 —— `text.format`（Responses 的结构化输出落点）还是被丢掉？
 *      上游是 200 还是 4xx？这一步靠 `lib/wire-relay.mjs` 的入站请求体分辨，通知流看不出来；
 *   ③ 最终 assistant 条目是不是**符合 schema 的裸 JSON**（散文 / ```json 围栏都算没生效）；
 *   ④ 提示词**对抗**时还灵不灵 —— 题面明确要求「用中文散文回答，不要 JSON」，却带 schema：
 *      这一组才分得清「schema 被执行」与「模型本来就爱回 JSON」；
 *   ⑤ **读权限**（评分通路的前提）—— 评分阶段固定用 `read-only` 沙箱，而它在 Windows 上到底
 *      读不读得到工作区里的文件，只能由真机分辨（`readonly-read` vs `full-read` 两档对照）。
 *
 * 口径：
 *  - 通知与 wire 记录都按原文落盘（不 parse 再序列化：那会把「字段不存在」与「字段为 null」抹平）；
 *  - 题面就是本仓评分提示词的形态（评分表 + 输出契约），schema 逐字抄 `JUDGE_OUTPUT_JSON_SCHEMA`；
 *  - 密钥只从 `~/.aieval/config.json` / 环境读，**绝不打印**，落盘前 redact。
 *
 * 用法：node probe/v4/codex-structured-output.mjs [only=control,schema,adversarial] [timeoutMs=420000]
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendJsonl, note, writeDump } from './lib/env.mjs';
import { startWireRelay } from './lib/wire-relay.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
/** 仓根：本文件在 `packages/server/agents/probe/v4/` 下（上溯五级）。 */
const REPO = join(HERE, '..', '..', '..', '..', '..');
const ARGS = new Map(process.argv.slice(2).map((one) => one.split('=')));
const ONLY = (ARGS.get('only') ?? 'schema,adversarial').split(',').filter((one) => one !== '');
const TIMEOUT_MS = Number(ARGS.get('timeoutMs') ?? 420_000);

/** 评分输出的 JSON Schema：逐字抄 `packages/server/contracts/src/score.ts` 的 `JUDGE_OUTPUT_JSON_SCHEMA`。 */
const JUDGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['judgments', 'verdict'],
  properties: {
    judgments: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'achieved', 'reason'],
        properties: {
          id: { type: 'string' },
          achieved: { type: 'boolean' },
          reason: { type: 'string' },
        },
      },
    },
    verdict: { type: 'string' },
  },
};

const CONTRACT = [
  '输出要求（务必严格遵守）：',
  '1. 只输出一个 JSON 对象，不要输出 JSON 以外的任何文字，不要使用 markdown 代码围栏；',
  '2. 字段结构固定为：',
  '   {',
  '     "judgments": [',
  '       { "id": "评分表里的引用键，原样照抄", "achieved": true, "reason": "一句中文说明" }',
  '     ],',
  '     "verdict": "一句话中文总评"',
  '   }',
  '3. 评分表里的**每一项**都必须恰好给出一条判定。',
].join('\n');

const SCORING_TABLE = [
  '1. id=cdn-vue3：页面通过 CDN 引入了 Vue 3（而不是 Vue 2 或本地打包产物）。',
  '2. id=hello-world：页面最终显示 Hello World 文本。',
].join('\n');

/** 提示词三态：`contract` = 本仓真实形态；`adversarial` = 明确要求散文（用来验 schema 是否被执行） */
const PROMPTS = {
  contract: `你在给一次编码任务的产出打分。工作区是空的（没有任何产物）。评分表：\n${SCORING_TABLE}\n${CONTRACT}`,
  adversarial: `你在给一次编码任务的产出打分。工作区是空的（没有任何产物）。评分表：\n${SCORING_TABLE}\n请用**中文散文**回答，不要输出 JSON、不要输出代码块，逐条说明你的判断理由。`,
  /**
   * 读权限探针（评分通路的**前提**）：评分智能体必须能读到工作区里的文件。
   * 题面把判据说死（原样报告那一行 / 读不到就明说），于是答复本身就是证据。
   */
  'read-file':
    '当前目录是一个 git 仓库。请读取当前目录下的 `secret.txt`，把它里面的字符串**原样**报告出来（只报告那一行）。'
    + '如果你因为沙箱/权限限制读不到文件，就明确回答「读不到」，不要猜测、不要编造内容。',
  /**
   * 读 + 写探针：评分阶段要的是「读得到、写不脏」，而 Windows 上 codex 只有三档沙箱，
   * 中间那档（`workspace-write`）到底能不能读、会不会写，只能实测（落盘事实由探针自己查）。
   */
  'read-write':
    '当前目录是一个 git 仓库。请读取当前目录下的 `secret.txt`，把它里面的字符串原样写入同目录下的 `out.txt`，'
    + '然后报告你写入的内容。如果因为沙箱限制做不到，就明确说明哪一步被拒。',
};

/** 从配置目录取一条 openai 协议的路由（本仓 `~/.aieval/config.json` 的形状）。 */
function loadRoute() {
  const dir = process.env.AIEVAL_CONFIG_DIR ?? join(homedir(), '.aieval');
  const file = join(dir, 'config.json');
  if (!existsSync(file)) throw new Error(`读不到配置：${file}`);
  const config = JSON.parse(readFileSync(file, 'utf8'));
  const provider = (config.providers ?? []).find((one) => one.protocolType === 'openai');
  if (provider === undefined) throw new Error('配置里没有 openai 协议的 provider');
  const modelId = provider.models?.[0]?.id;
  if (typeof modelId !== 'string') throw new Error('该 provider 没有模型 id');
  return { baseUrl: String(provider.baseUrl), apiKey: String(provider.apiKey), modelId, providerName: provider.name };
}

/** 解析本仓实际 spawn 的那份 codex.exe（`node_modules/.pnpm/@openai+codex@<ver>-win32-x64`）。 */
function resolveCodexBin() {
  const pnpmDir = join(REPO, 'node_modules', '.pnpm');
  const hit = readdirSync(pnpmDir).find((name) => name.startsWith('@openai+codex@') && name.endsWith('-win32-x64'));
  if (hit === undefined) throw new Error(`.pnpm 里没有 codex 平台包（${pnpmDir}）`);
  const exe = join(pnpmDir, hit, 'node_modules', '@openai', 'codex', 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe');
  if (!existsSync(exe)) throw new Error(`平台包里没有 codex.exe：${exe}`);
  return exe;
}

/** 一个独占的 scratch：`CODEX_HOME` 与 cwd 都在里面（宿主 `~/.codex` 会覆盖注入的 base URL）。 */
function makeScratch(label) {
  const dir = mkdtempSync(join(tmpdir(), `aieval-codex-so-${label}-`));
  const home = join(dir, 'home');
  const cwd = join(dir, 'cwd');
  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  spawnSync('git', ['init'], { cwd, stdio: 'ignore' });
  // 读权限探针要有一个**确实存在**的文件可读（评分场景里它就是候选的产出）
  const probeFile = join(cwd, 'secret.txt');
  writeFileSync(probeFile, 'HELLO-42-CODEX-READ\n', 'utf8');
  spawnSync('git', ['add', '.'], { cwd, stdio: 'ignore' });
  spawnSync('git', ['-c', 'user.email=p@e.com', '-c', 'user.name=p', 'commit', '-m', 'baseline'], { cwd, stdio: 'ignore' });
  return { dir, home, cwd, probeFile };
}

function buildEnv(home, apiKey) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  env.CODEX_HOME = home;
  env.HOME = home;
  env.USERPROFILE = home;
  env.OPENAI_API_KEY = apiKey;
  return env;
}

/** 极简 JSON-RPC 客户端：行分隔帧、请求/响应配对、通知全收（与 `appserver/client.ts` 同口径）。 */
function startAppServer(binary, env, cwd) {
  const child = spawn(binary, ['app-server'], { env, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  const notifications = [];
  const listeners = new Set();
  const pending = new Map();
  let nextId = 1;
  let buffer = '';
  let stderr = '';
  let exitReason = null;

  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line !== '') {
        let message = null;
        try {
          message = JSON.parse(line);
        } catch {
          notifications.push({ raw: line, unparsed: true });
        }
        if (message !== null) {
          if (typeof message.id === 'number' && pending.has(message.id)) {
            const entry = pending.get(message.id);
            pending.delete(message.id);
            if (message.error !== undefined) entry.reject(new Error(`app-server 错误（${message.error.code}）：${message.error.message}`));
            else entry.resolve(message.result);
          } else if (typeof message.method === 'string') {
            notifications.push(message);
            for (const listener of listeners) listener(message);
          }
        }
      }
      index = buffer.indexOf('\n');
    }
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  child.on('exit', (code) => {
    exitReason = `进程退出（code=${String(code)}）`;
    for (const [, entry] of pending) entry.reject(new Error(exitReason));
    pending.clear();
  });

  return {
    notifications,
    stderrText: () => stderr,
    exitReason: () => exitReason,
    subscribe: (listener) => listeners.add(listener),
    request: (method, params) =>
      new Promise((resolve, reject) => {
        const id = nextId;
        nextId += 1;
        pending.set(id, { resolve, reject });
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} })}\n`);
      }),
    close: () => {
      try {
        child.kill();
      } catch {
        /* 已经死了 */
      }
    },
  };
}

/** 一次会话：握手 → 建线程 → 起轮次 → 收集到本轮终结（或硬超时）。 */
async function runOnce(input) {
  const scratch = makeScratch(input.label);
  const client = startAppServer(input.binary, buildEnv(scratch.home, input.route.apiKey), scratch.cwd);
  const config = {
    model_provider: 'aieval',
    model_providers: {
      aieval: {
        name: 'aieval gateway',
        base_url: input.baseUrl,
        wire_api: 'responses',
        env_key: 'OPENAI_API_KEY',
        request_max_retries: 1,
      },
    },
    tools: { web_search: false, update_plan: { enabled: true } },
    features: { multi_agent: false },
  };

  const startedAt = Date.now();
  const record = { label: input.label, withSchema: input.schema !== undefined, promptKind: input.promptKind, sandbox: input.sandbox, scratch: scratch.dir, requestErrors: [] };
  try {
    await client.request('initialize', { clientInfo: { name: 'aieval-probe', title: 'aieval probe', version: '0.0.1' }, capabilities: { experimentalApi: true, requestAttestation: false } });
    const thread = await client.request('thread/start', {
      model: input.route.modelId,
      cwd: scratch.cwd,
      sandbox: input.sandbox,
      approvalPolicy: 'never',
      config,
    });
    record.threadId = thread?.thread?.id ?? null;
    const turn = await client.request('turn/start', {
      threadId: record.threadId,
      input: [{ type: 'text', text: input.prompt, text_elements: [] }],
      ...(input.schema === undefined ? {} : { outputSchema: input.schema }),
    });
    record.turnId = turn?.turn?.id ?? null;
    record.turnStartAccepted = true;
  } catch (error) {
    record.requestErrors.push(String(error?.message ?? error));
    record.turnStartAccepted = false;
  }

  if (record.turnStartAccepted) {
    record.settle = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve('timeout'), TIMEOUT_MS);
      client.subscribe((message) => {
        if (message.method === 'turn/completed' && message.params?.threadId === record.threadId) {
          clearTimeout(timer);
          record.turnCompletedRaw = message.params?.turn ?? null;
          resolve('completed');
        }
      });
    });
  }
  record.ms = Date.now() - startedAt;

  const byMethod = {};
  for (const message of client.notifications) {
    const method = message.method ?? 'unparsed';
    byMethod[method] = (byMethod[method] ?? 0) + 1;
  }
  record.notificationCounts = byMethod;
  record.lastNotifications = client.notifications.slice(-4).map((message) => ({
    method: message.method ?? 'unparsed',
    itemType: message.params?.item?.type ?? null,
    itemStatus: message.params?.item?.status ?? null,
    deltaTail: typeof message.params?.delta === 'string' ? message.params.delta.slice(-200) : null,
  }));

  record.itemKinds = [];
  record.agentMessages = [];
  for (const message of client.notifications) {
    const item = message.params?.item;
    if (item === undefined || message.method !== 'item/completed') continue;
    record.itemKinds.push(item.type ?? 'unknown');
    if (item.type === 'agentMessage' && typeof item.text === 'string') {
      record.agentMessages.push({ threadId: message.params?.threadId ?? null, itemId: item.id ?? null, phase: item.phase ?? null, text: item.text });
    }
  }
  const last = record.agentMessages.at(-1)?.text ?? null;
  record.finalAgentText = last;
  record.finalIsBareJson = (() => {
    if (last === null) return false;
    try {
      JSON.parse(last);
      return true;
    } catch {
      return false;
    }
  })();
  record.stderrTail = client.stderrText().slice(-1200);
  record.exitReason = client.exitReason();
  // 落盘事实：写字那一步到底成没成，不能只听模型自述（它可能说写了而其实没写）
  const outFile = join(scratch.cwd, 'out.txt');
  record.workspaceAfter = {
    secretTxt: readFileSync(scratch.probeFile, 'utf8').trim(),
    outTxtExists: existsSync(outFile),
    outTxtContent: existsSync(outFile) ? readFileSync(outFile, 'utf8').trim().slice(0, 200) : null,
  };
  client.close();
  return record;
}

const route = loadRoute();
const binary = resolveCodexBin();
const relay = startWireRelay({ upstreamBase: route.baseUrl });
const relayUrl = await relay.listen();
note('codex 二进制：', binary);
note('路由：', route.providerName, route.modelId, route.baseUrl, '→ relay', relayUrl);

const SPECS = {
  control: { label: 'control-no-schema', promptKind: 'contract', schema: undefined, sandbox: 'read-only' },
  schema: { label: 'with-schema', promptKind: 'contract', schema: JUDGE_SCHEMA, sandbox: 'read-only' },
  adversarial: { label: 'with-schema-adversarial', promptKind: 'adversarial', schema: JUDGE_SCHEMA, sandbox: 'read-only' },
  // 对抗题面的**对照**：同一份「用散文回答、不要 JSON」的题面，只是不带 schema。
  // 没有它，「带 schema 时仍回 JSON」就分不清是 schema 生效还是模型没听题面。
  'adversarial-control': { label: 'no-schema-adversarial', promptKind: 'adversarial', schema: undefined, sandbox: 'read-only' },
  /**
   * 读权限的两档对照（评分通路的**前提**）：评分阶段用的是 `read-only`（`CODEX_PERMISSION_OPTIONS`），
   * 而「只读」在 Windows 上到底还读不读得到文件，只能由真机分辨——题面要求原样报告 `secret.txt` 的内容。
   */
  'readonly-read': { label: 'readonly-read', promptKind: 'read-file', schema: undefined, sandbox: 'read-only' },
  'full-read': { label: 'full-read', promptKind: 'read-file', schema: undefined, sandbox: 'danger-full-access' },
  'ww-read': { label: 'workspace-write-read', promptKind: 'read-file', schema: undefined, sandbox: 'workspace-write' },
  'ww-read-write': { label: 'workspace-write-read-write', promptKind: 'read-write', schema: undefined, sandbox: 'workspace-write' },
};

const runs = [];
for (const key of ONLY) {
  const spec = SPECS[key];
  if (spec === undefined) throw new Error(`未知组：${key}`);
  note(`── ${spec.label} 开跑（withSchema=${spec.schema !== undefined}，题面=${spec.promptKind}，sandbox=${spec.sandbox}）`);
  const relayStart = relay.records.length;
  const record = await runOnce({
    label: spec.label,
    promptKind: spec.promptKind,
    binary,
    route,
    // relay 只做透传，`/v1` 仍由我们补（与仓内 `ensureV1Suffix` 同口径）
    baseUrl: `${relayUrl}/v1`,
    prompt: PROMPTS[spec.promptKind],
    schema: spec.schema,
    sandbox: spec.sandbox,
  });
  record.wire = relay.records.slice(relayStart);
  runs.push(record);
  note(`   turn/start 接受=${record.turnStartAccepted}`, `结算=${record.settle ?? '（未起轮次）'}`, `耗时=${(record.ms / 1000).toFixed(1)}s`);
  note(`   通知计数：${JSON.stringify(record.notificationCounts)}`);
  note(`   条目类型：${record.itemKinds.join(', ') || '（无）'}`);
  note(`   最终答复是裸 JSON=${record.finalIsBareJson}`);
  note(`   最终答复原文：${JSON.stringify((record.finalAgentText ?? '').slice(0, 400))}`);
  note(`   落盘事实：out.txt 存在=${record.workspaceAfter.outTxtExists} 内容=${JSON.stringify(record.workspaceAfter.outTxtContent)}`);
  for (const [index, wire] of record.wire.entries()) {
    note(`   wire#${index} ${wire.request?.url ?? ''} status=${wire.status ?? wire.transportError} model=${wire.request?.model ?? '?'}`);
    note(`     text.format=${JSON.stringify(wire.request?.text ?? null)} response_format=${JSON.stringify(wire.request?.responseFormat ?? null)} include=${JSON.stringify(wire.request?.include ?? null)}`);
    note(`     SSE 事件：${JSON.stringify(wire.stream?.counts ?? null)}`);
    if (wire.stream?.completed !== null && wire.stream?.completed !== undefined) {
      note(`     response.completed: status=${wire.stream.completed.status} outputTypes=${JSON.stringify(wire.stream.completed.outputTypes)} incomplete=${JSON.stringify(wire.stream.completed.incomplete)}`);
      note(`     output 文本：${JSON.stringify((wire.stream.completed.outputTexts ?? []).map((one) => one.contentText ?? one.text))}`);
    }
    if (wire.stream?.failed !== null && wire.stream?.failed !== undefined) note(`     失败事件：${JSON.stringify(wire.stream.failed).slice(0, 500)}`);
  }
  if (record.requestErrors.length > 0) note('   请求错误：', record.requestErrors.join(' | '));
  if (record.stderrTail.trim() !== '') note('   stderr 尾：', record.stderrTail.trim().split(/\r?\n/).slice(-2).join(' | '));
}

relay.close();
const jsonl = appendJsonl('v4/codex-structured-output', runs.flatMap((one) => (one.agentMessages ?? []).map((message) => JSON.stringify({ run: one.label, ...message }))));
const file = writeDump('v4/codex-structured-output', {
  at: new Date().toISOString(),
  binary,
  route: { ...route, apiKey: '***' },
  prompts: PROMPTS,
  schema: JUDGE_SCHEMA,
  runs,
});
note('JSONL：', jsonl);
note('落盘：', file);
