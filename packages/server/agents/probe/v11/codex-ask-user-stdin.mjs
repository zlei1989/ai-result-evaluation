#!/usr/bin/env node
/**
 * v11 探针（票 07）：**codex 在管道 stdin（非 TTY）下会不会下发提问请求？**
 *
 * 厂商二进制里有一句 `request_user_input requires an interactive stdin terminal`。本仓拉起
 * codex 服务端时 fd 0 一律是管道（JSON-RPC 要双向读写）⇒ 要回答的是：**这句话拦不拦？**
 *
 * 探针只记录、不做产品判断；结论与原文由人回填票的 `## Comments`。
 *
 * ── 判据（逐条对应票里的四条，全部落在产物里，不靠眼睛）─────────────────────────
 *
 *   ① 请求到不到：`serverRequests` 里 `method === 'item/tool/requestUserInput'` 的**条数**。
 *      到了 ⇒ 「管道 stdin 不拦」，这是本票的主判据。
 *   ② 到了：该请求的 `params` **逐字**落盘（`askRequests[].paramsRaw`）——`isBlocking` /
 *      `autoResolutionMs` 与问题项、选项的确切字段名都在里面，09 号票照抄它写映射。
 *   ③ 没到：分成两种，**必须分开**（处置不同）：
 *        · 「工具没被提供给模型」⇒ relay 抓到的模型请求体里 `tools[]` 没有 `request_user_input`；
 *        · 「提供了但调用被拒」⇒ `tools[]` 里有它，而条目流里出现带 error 的调用条目。
 *   ④ 回了空答案之后：三个读数一起看——本行的 `turnStatus`、探针工作区里的 `result.txt`
 *      在不在、最终 `agentMessage` 原文。
 *      「继续按最佳判断干活」= `completed` ∧ `result.txt` 在；「判成被阻塞」= `failed` ∧ 文件不在。
 *
 * ── 臂（自变量只有三个：工具开关 / fd0 是不是 TTY / 回不回帧）──────────────────
 *
 *   | 臂             | fd 0      | 提问工具开关                  | 应答                       |
 *   |----------------|-----------|-------------------------------|----------------------------|
 *   | `off`          | 管道      | 关（**与适配器逐字一致**）    | 不适用                     |
 *   | `tools-only`   | 管道      | 只开 `tools.…`                | 按 `--answer`              |
 *   | `on`           | 管道      | 开 `tools.…` + `features.…`   | 按 `--answer`（缺省 empty）|
 *   | `pty`          | **真 TTY**| 开 `tools.…` + `features.…`   | 按 `--answer`              |
 *   | `noreply`      | 管道      | 开（同 `on`）                 | **不回帧**（今天的现状）   |
 *   | `refuse`       | 管道      | 开（同 `on`）                 | 回一帧 JSON-RPC 错误        |
 *   | `subagent`     | 管道      | 开（同 `on`）                 | 按 `--answer`              |
 *
 *   `tools-only` 与 `on` 的差 = `features.default_mode_request_user_input` 这一格到底管什么；
 *   `pty` 与 `on` 的差 = **app-server 自己的 fd 0 是不是终端**。两支读数一致 ⇒ 这一格不是自变量，
 *   厂商那句「需要交互式 stdin 终端」作用在**客户端**（回帧那一侧），不在服务端发不发。
 *   `noreply` 是 09 号票要对的现状读数（「只归类不回帧」会怎样）；`refuse` 复刻客户端说
 *   「我这里没有交互式终端」那条路；`subagent` 验「只有根线程能用」那条门禁。
 *
 *   ⚠️ **别拿臂的配置当结论**：0.156.1 即使一格开关都不开，也已经把 `request_user_input` 列进
 *   发给模型的 `tools[]`（零模型调用即可复现，读数见同目录 `REPORT.md` 的 AU-07 静态证据 ⑥）。
 *   ⇒ 「请求没到」的两种成因（工具没提供 / 提供了但调用被拒）只能靠 `toolTable` 与
 *   `itemSummary[].error` 读出来。
 *
 * ⚠️ 审批类服务端请求**一律不回帧**（本仓既有口径，本票不动）：只有
 *    `item/tool/requestUserInput` 会按 `--answer` 回。
 *
 * ── 用法 ──────────────────────────────────────────────────────────────────────
 *
 *   AIEVAL_PROBE_GATEWAY_API_KEY=… AIEVAL_PROBE_BASE_URL=https://…/v1 \
 *   （网关地址也认 AIEVAL_PROBE_GATEWAY_BASE_URL，两个名字同义）
 *     node packages/server/agents/probe/v11/codex-ask-user-stdin.mjs
 *
 *   --arms=off,on,tools-only,pty   缺省这四臂；可选再拼 noreply / refuse / subagent
 *   --answer=empty|blank|filled   缺省 empty（`noreply` / `refuse` 两臂各自钉死）
 *   --turn-timeout-ms=150000      单臂墙钟上限
 *   --noanswer-grace-ms=60000     `noreply` 臂：请求到达后再等多久收手
 *   --model=…                     缺省取 `AIEVAL_PROBE_MODEL`，再缺省 `GLM-5.3`
 *   --relay=false                 直连网关（不抓请求体 ⇒ 判据 ③ 退化成「读条目流」）
 *   --prompt=… / --subagent-prompt=…
 *
 * 产物落 `packages/server/agents/probe/dumps/v11/`（整个 `dumps/` 已 gitignore）：
 *   `arm-<臂>.jsonl`        该臂的**原始帧**（逐行原文，不 parse 后重排）
 *   `arm-<臂>.result.txt`   该臂工作区里 `result.txt` 的原样快照（判据 ④ 的物证）
 *   `codex-ask-user-stdin.json`  汇总与逐臂判定
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startAppServer } from './lib/appserver.mjs';
import { resolveCodexBinary } from '../v10/codex-binary.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DUMP = join(HERE, '..', 'dumps', 'v11');
const SCRATCH = join(DUMP, 'tmp');
/** pty 桥：给 app-server 一个真 TTY 的 fd 0（见同目录脚本的头注） */
const PTY_BRIDGE = join(HERE, 'lib', 'pty-stdin-bridge.py');

const ARGS = Object.fromEntries(
  process.argv.slice(2).map((raw) => {
    const [key, ...rest] = raw.replace(/^--/, '').split('=');
    return [key, rest.length === 0 ? 'true' : rest.join('=')];
  }),
);

const BINARY = ARGS['binary'] ?? resolveCodexBinary();
const MODEL = ARGS['model'] ?? process.env.AIEVAL_PROBE_MODEL ?? 'GLM-5.3';
const API_KEY = process.env.AIEVAL_PROBE_GATEWAY_API_KEY ?? '';
/** 网关地址：本批探针里两种命名都在用，故两个都认（网关 key 只认 `AIEVAL_PROBE_GATEWAY_API_KEY`） */
const BASE_URL = (process.env.AIEVAL_PROBE_BASE_URL ?? process.env.AIEVAL_PROBE_GATEWAY_BASE_URL ?? '').replace(
  /\/+$/,
  '',
);
const USE_RELAY = ARGS['relay'] !== 'false';
const TURN_TIMEOUT_MS = Number(ARGS['turn-timeout-ms'] ?? 150_000);
const NOANSWER_GRACE_MS = Number(ARGS['noanswer-grace-ms'] ?? 60_000);
/** 默认应答策略；`noreply` / `refuse` 两臂各自钉死自己的那一档 */
const ANSWER = ARGS['answer'] ?? 'empty';
/** 回帧前的人为延迟：让「不回帧」与「回帧」两个状态在时间线上分得开（0 = 立刻回） */
const REPLY_DELAY_MS = Number(ARGS['reply-delay-ms'] ?? 0);

/** 提问提示词：**先澄清再动手**，并留一个可机器判定的动作（写 `result.txt`）作为「继续干活」的物证 */
const ASK_PROMPT =
  ARGS['prompt'] ??
  [
    '开始动手之前先澄清一件事，不要自己假设：',
    '用你的提问工具向用户确认「目标平台」是什么——选项给 iOS / Android 两个，并允许用户自己输入。',
    '拿到答复、或者确认拿不到答复之后，继续把活干完：',
    '在当前目录创建 result.txt，内容写一行 done。',
    '最后用一句话汇报：你有没有发起提问、有没有拿到答复、有没有创建 result.txt。',
  ].join('\n');

/** 子智能体臂：让**子线程**去提问，验厂商那条「只有根线程能用」（09 号票的边界） */
const SUBAGENT_PROMPT =
  ARGS['subagent-prompt'] ??
  [
    '严格按顺序执行：',
    '1. 派一个**前台**子智能体（spawn_agent / subagent 之类的工具）。',
    '   给它的任务原文：「用提问工具向用户确认目标平台（选项 iOS / Android），拿到答复后回一句话。」',
    '2. 等它返回，把它的最终答复原样贴出来，不要改写。',
  ].join('\n');

/** 密钥只从环境变量读；落盘前按**精确串**替换，不做宽松正则 */
const redact = API_KEY.length >= 8 ? (text) => String(text).split(API_KEY).join('***') : (text) => String(text);

/** 与适配器 `buildCodexConfig` 同一形状的线程级 config（这里只加提问工具那两格） */
function threadConfig(baseUrl, switches) {
  return {
    model_provider: 'aieval',
    model_providers: {
      aieval: {
        name: 'aieval gateway',
        base_url: baseUrl,
        wire_api: 'responses',
        env_key: 'OPENAI_API_KEY',
        request_max_retries: 1,
      },
    },
    // 与 `buildCodexConfig` 逐字一致的两格；`experimental_request_user_input` 是本票的自变量
    tools: {
      web_search: false,
      update_plan: { enabled: true },
      ...(switches.tools ? { experimental_request_user_input: { enabled: true } } : {}),
    },
    features: {
      multi_agent: true,
      ...(switches.feature ? { default_mode_request_user_input: true } : {}),
    },
  };
}

const ARMS = {
  off: { tty: false, switches: { tools: false, feature: false }, answer: 'n/a', note: '对照：与适配器逐字一致（不开任何提问开关；工具仍在表里，见头注）' },
  'tools-only': { tty: false, switches: { tools: true, feature: false }, answer: ANSWER, note: '只开 tools.experimental_request_user_input' },
  on: { tty: false, switches: { tools: true, feature: true }, answer: ANSWER, note: '两格都开（本票主臂）' },
  pty: { tty: true, switches: { tools: true, feature: true }, answer: ANSWER, note: '两格都开 + app-server 的 fd 0 是真 TTY' },
  noreply: { tty: false, switches: { tools: true, feature: true }, answer: 'none', note: '两格都开但**不回帧**（= 今天的现状）' },
  refuse: { tty: false, switches: { tools: true, feature: true }, answer: 'refuse', note: '两格都开 + 回一帧「我这里没有交互式终端」的 JSON-RPC 错误' },
  subagent: { tty: false, switches: { tools: true, feature: true }, answer: ANSWER, note: '两格都开 + 让子线程去提问' },
};
const DEFAULT_ARMS = ['off', 'tools-only', 'on', 'pty'];
const wanted = (ARGS['arms'] ?? DEFAULT_ARMS.join(','))
  .split(',')
  .map((one) => one.trim())
  .filter((one) => one !== '');
for (const name of wanted) {
  if (ARMS[name] === undefined) throw new Error(`未知的臂：${name}（可选：${Object.keys(ARMS).join(' / ')}）`);
}

if (API_KEY === '' || BASE_URL === '') {
  throw new Error(
    '缺网关凭据：必须设 AIEVAL_PROBE_GATEWAY_API_KEY 与 AIEVAL_PROBE_BASE_URL（或同义的 AIEVAL_PROBE_GATEWAY_BASE_URL）；**只从环境变量读，不要写进源码**',
  );
}

/** pty 桥要 python3；缺了就把 `pty` 臂如实标成跳过，而不是静默降级成管道臂 */
const pythonOk = spawnSync('python3', ['-c', 'import pty, tty'], { encoding: 'utf8' }).status === 0;

/**
 * pty 桥的**自检**：拿一个只打印 `os.isatty(0)` 的哑子进程走一遍桥。
 *
 * 为什么必须自检而不是「能用就用」：pty 的分配会被宿主策略拒（容器、受限沙箱下
 * `openpty` 直接 `EPERM: Operation not permitted`）。自检不过就把 `pty` 臂**如实跳过**，
 * 否则读数会静默退化成「又是一条管道臂」，而两条管道臂读数一致会被误读成
 * 「fd0 是不是 TTY 不是自变量」——那是把环境故障当成结论。
 */
function ptyBridgeReady() {
  const probe = 'import os,sys; sys.stdout.write("ISATTY=%d\\n" % (1 if os.isatty(0) else 0)); sys.stdout.flush()';
  const run = spawnSync('python3', [PTY_BRIDGE, 'python3', '-c', probe], { input: '', encoding: 'utf8', timeout: 20_000 });
  const out = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  if (out.includes('ISATTY=1')) return { ok: true };
  return { ok: false, reason: `pty 桥自检未通过（原样输出：${JSON.stringify(out.slice(0, 200))}）` };
}

const ptyCheck = ptyBridgeReady();
const ttyChild = ptyCheck.ok ? { command: 'python3', args: [PTY_BRIDGE, BINARY, 'app-server'] } : null;

mkdirSync(SCRATCH, { recursive: true });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 一个臂的 scratch（`$CODEX_HOME` 与 cwd 都落在仓库内，跨平台都不越界） */
function prepareCase(label) {
  const dir = join(SCRATCH, label);
  const home = join(dir, 'home');
  const cwd = join(dir, 'cwd');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  return { home, cwd };
}

/**
 * 记录型中转：把**模型请求体**的摘要留下，再逐块转发给真网关。
 *
 * 为什么必须有它：判据 ③ 要区分「工具没被提供给模型」与「提供了但调用被拒」——
 * 前者只能从**请求体** `tools[]` 里看出来。少了这一层，「请求没到」的两种成因就分不开
 * （厂商注入的 `request_user_input availability` 那段说明写着：模型只在工具**列在本轮工具表**
 * 时才用它 ⇒ 不开开关时模型改用纯文本，表象与「被门禁拦下」一模一样）。
 */
function startRelay() {
  const captured = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const raw = Buffer.concat(chunks);
      let summary = { at: Date.now(), path: request.url ?? '', note: '非 JSON 体' };
      if (raw.length > 0) {
        try {
          const body = JSON.parse(raw.toString('utf8'));
          const tools = Array.isArray(body.tools) ? body.tools : [];
          /** 拍平后的工具名表：命名空间形态也展开一层，判据只看名字在不在 */
          const toolNames = tools.flatMap((tool) => [
            ...(typeof tool.name === 'string' ? [tool.name] : []),
            ...(Array.isArray(tool.tools) ? tool.tools.map((one) => one.name).filter((one) => typeof one === 'string') : []),
          ]);
          summary = {
            at: Date.now(),
            path: request.url ?? '',
            model: body.model ?? null,
            toolCount: tools.length,
            toolNames,
            hasRequestUserInput: toolNames.some((name) => name.includes('request_user_input')),
            /**
             * 厂商注进 `instructions` 的那份系统提示：**模型看到的那一份**才是「工具到底能不能用」
             * 的真源。只记长度与「里面提没提 request_user_input」两格——这两格足以判定
             * 「开关之间到底改没改模型看到的东西」，又不至于把上万字的提示词搬进产物。
             */
            instructionsChars: typeof body.instructions === 'string' ? body.instructions.length : null,
            instructionsHasAskUser:
              typeof body.instructions === 'string' && body.instructions.includes('request_user_input'),
          };
          captured.push(summary);
        } catch {
          captured.push(summary);
        }
      }
      const headers = { ...request.headers };
      delete headers.host;
      delete headers['content-length'];
      delete headers['transfer-encoding'];
      // `identity`：中转不做解压，避免把 SSE 的压缩流拆坏（v2 relay 的教训）
      headers['accept-encoding'] = 'identity';
      void (async () => {
        try {
          const upstream = await fetch(`${BASE_URL}${request.url ?? ''}`, {
            method: request.method,
            headers,
            body: request.method === 'GET' ? undefined : raw,
          });
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
          const reader = upstream.body.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            response.write(value);
          }
          response.end();
        } catch (error) {
          console.log('[relay] 失败', redact(String(error?.message ?? error)).slice(0, 200));
          response.writeHead(502, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ error: { message: 'v11 探针 relay 转发失败' } }));
        }
      })();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      resolve({ baseUrl: `http://127.0.0.1:${port}/v1`, captured, close: () => server.close() });
    });
  });
}

/** 按策略造一帧应答；返回 `{kind, frame}`，`frame` 逐字落盘（09 号票要照抄） */
function buildReply(policy, params) {
  const questions = Array.isArray(params?.questions) ? params.questions : [];
  if (policy === 'refuse') {
    /**
     * 复刻客户端那条「我这里没有交互式终端」的路：厂商原文只给了**文案**
     * （`request_user_input requires an interactive stdin terminal`），错误码是本探针选的
     * ⇒ 读数以「这句文案有没有被回灌给模型」为准，不以码为准。
     */
    return { kind: 'error', frame: { code: -32601, message: 'request_user_input requires an interactive stdin terminal' } };
  }
  if (policy === 'empty') {
    // 「没有答案」的最简形态：一整张空表
    return { kind: 'result', frame: { answers: {} } };
  }
  if (policy === 'blank') {
    // 另一种「空」：每个问题各回一个空数组（与 `empty` 的差正是 09 号票要裁的那一格）
    const answers = {};
    for (const question of questions) answers[String(question?.id ?? '')] = { answers: [] };
    return { kind: 'result', frame: { answers } };
  }
  if (policy === 'filled') {
    const answers = {};
    for (const question of questions) {
      const first = Array.isArray(question?.options) ? question.options[0]?.label : null;
      answers[String(question?.id ?? '')] = { answers: [typeof first === 'string' && first !== '' ? first : 'PROBE-ANSWER'] };
    }
    return { kind: 'result', frame: { answers } };
  }
  return null;
}

/** 跑一个臂：起进程 → 建线程 → 起轮次 → 收帧 → 收尾 → 由**同一批证据**算判定 */
async function runArm(name) {
  const arm = ARMS[name];
  if (arm.tty && ttyChild === null) {
    return {
      arm: name,
      note: arm.note,
      skipped: `无法给 app-server 一个真 TTY 的 fd 0 ⇒ 这一臂没有自变量：${pythonOk ? ptyCheck.reason : '缺 python3（pty 桥需要它）'}`,
    };
  }

  const { home, cwd } = prepareCase(name);
  const jsonlFile = join(DUMP, `arm-${name}.jsonl`);
  writeFileSync(jsonlFile, '', 'utf8');

  const relay = USE_RELAY ? await startRelay() : null;
  const baseUrl = relay === null ? BASE_URL : relay.baseUrl;
  const t0 = Date.now();
  const at = () => Date.now() - t0;

  const notifications = [];
  const askRequests = [];
  const replies = [];
  const otherServerRequests = [];
  const threadIdRef = { value: null };
  let turnSettled = null;
  let onTurnSettled = () => undefined;
  const turnDone = new Promise((resolve) => {
    onTurnSettled = resolve;
  });
  let exitCode = null;
  let error = null;
  let timedOut = false;
  let turnStartError = null;
  let turnId = null;

  const launcher = arm.tty ? ttyChild : { command: BINARY, args: ['app-server'] };
  const server = startAppServer({
    command: launcher.command,
    args: launcher.args,
    env: { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: home, OPENAI_API_KEY: API_KEY },
    cwd,
    timeoutMs: 60_000,
    onExit: (info) => {
      exitCode = info.code;
    },
    onLine: (line) => {
      appendFileSync(jsonlFile, `${redact(line)}\n`, 'utf8');
    },
    onNotification: (method, params) => {
      notifications.push({ atMs: at(), method, params });
    },
    onTurnCompleted: (params) => {
      // 子线程自己的 `turn/completed` 不结算本次运行（闸门只认主线程，见生产 session.ts 的口径）
      if (params?.threadId !== threadIdRef.value) return;
      turnSettled = params?.turn ?? null;
      onTurnSettled(params?.turn ?? null);
    },
    onServerRequest: (record) => {
      if (record.method !== 'item/tool/requestUserInput') {
        /**
         * 审批类（`item/…/requestApproval` 等）**继续不回帧**——本仓评测是非交互的，
         * 回帧等于替用户批准。`approvalPolicy: 'never'` 下本来也不该出现，出现即记录。
         */
        otherServerRequests.push({ id: record.id, method: record.method, atMs: at() });
        return;
      }
      askRequests.push({ id: record.id, atMs: at(), paramsRaw: record.params });
      const reply = buildReply(arm.answer, record.params);
      if (reply === null) return;
      const send = () => {
        if (reply.kind === 'error') server.respondError(record.id, reply.frame.code, reply.frame.message);
        else server.respond(record.id, reply.frame);
        replies.push({ id: record.id, kind: reply.kind, frame: reply.frame, atMs: at() });
      };
      if (REPLY_DELAY_MS > 0) setTimeout(send, REPLY_DELAY_MS);
      else send();
    },
  });

  let guard = null;
  try {
    await server.request('initialize', {
      clientInfo: { name: 'aieval-v11-ask-user-probe', title: 'aieval v11 ask-user probe', version: '0.0.1' },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    const threadStart = await server.request('thread/start', {
      model: MODEL,
      cwd,
      // 与适配器执行阶段同一档（`codexPermissionOptions('full')`），批准策略仍是 never
      sandbox: 'danger-full-access',
      approvalPolicy: 'never',
      config: threadConfig(baseUrl, arm.switches),
    });
    const threadId = threadStart?.thread?.id;
    if (typeof threadId !== 'string') throw new Error('thread/start 未返回 thread.id');
    threadIdRef.value = threadId;

    const turnStart = await server.request('turn/start', {
      threadId,
      input: [{ type: 'text', text: name === 'subagent' ? SUBAGENT_PROMPT : ASK_PROMPT, text_elements: [] }],
    }).catch((failure) => {
      turnStartError = String(failure?.message ?? failure);
      return null;
    });
    turnId = turnStart?.turn?.id ?? null;

    /** 收尾闸门：**主线程自己的** `turn/completed`（子线程那条会先到，拿它当闸门会提前收手） */
    const budget = arm.answer === 'none' ? Math.max(NOANSWER_GRACE_MS, 30_000) : TURN_TIMEOUT_MS;
    let onGuard = () => undefined;
    const guardSignal = new Promise((resolve) => {
      onGuard = resolve;
    });
    guard = setTimeout(() => {
      timedOut = true;
      onGuard('timeout');
      server.close();
    }, budget);

    await Promise.race([turnDone, server.done, guardSignal]);
    // 子线程的通知与 `serverRequest/resolved` 可能晚于主线程终态：留一个短窗口再收尾
    await sleep(1_500);
  } catch (failure) {
    error = String(failure?.message ?? failure);
  } finally {
    if (guard !== null) clearTimeout(guard);
    server.finish();
    await sleep(1_200);
    server.close();
    relay?.close();
  }

  // ── 判定：所有通道的证据这时都已齐（收尾之后再算，避免读到半程读数）────────────
  const resultPath = join(cwd, 'result.txt');
  const resultFile = existsSync(resultPath) ? readFileSync(resultPath, 'utf8').slice(0, 500) : null;
  if (resultFile !== null) writeFileSync(join(DUMP, `arm-${name}.result.txt`), resultFile, 'utf8');

  /** 条目流：厂商侧的「工具调没调、被拒没有」都在这里（判据 ③ 的第二条独立通道） */
  const items = notifications
    .filter((one) => one.method === 'item/completed' && one.params?.item !== undefined)
    .map((one) => ({ threadId: one.params.threadId ?? null, item: one.params.item }));
  const finalText =
    items
      .filter((one) => one.item?.type === 'agentMessage')
      .map((one) => String(one.item.text ?? ''))
      .at(-1) ?? null;

  return {
    arm: name,
    note: arm.note,
    transport: arm.tty ? 'pty（fd 0 = 真 TTY，stdout/stderr 仍是管道）' : 'stdio 管道',
    configSwitch: arm.switches,
    answerPolicy: arm.answer,
    threadId: threadIdRef.value,
    turnId,
    turnStartError,
    durationMs: at(),
    timedOut,
    exitCode,
    error,
    /** 判据 ①：服务端主动请求里那条提问请求到了几条 */
    askRequestCount: askRequests.length,
    /** 判据 ②：params **逐字**（09 号票照抄这一格） */
    askRequests: askRequests.map((one) => ({
      id: one.id,
      atMs: one.atMs,
      paramsRaw: one.paramsRaw,
      questionFieldNames: (one.paramsRaw?.questions ?? []).map((question) => Object.keys(question ?? {})),
      optionFieldNames: (one.paramsRaw?.questions ?? []).map((question) =>
        (question?.options ?? []).map((option) => Object.keys(option ?? {})),
      ),
      isBlocking: one.paramsRaw?.isBlocking ?? null,
      autoResolutionMs: one.paramsRaw?.autoResolutionMs ?? null,
    })),
    /** 我们回了什么（逐字）；`noreply` 臂这一格恒为空 = 今天的现状 */
    replies,
    /** 厂商自己收场那条通知（`autoResolutionMs` / `isBlocking` 到点后应当来这一条） */
    serverRequestResolved: notifications.filter((one) => one.method === 'serverRequest/resolved').map((one) => one.params),
    /** 非提问类的服务端主动请求（审批等）：只记录，**一律不回帧** */
    otherServerRequests,
    /** 判据 ③：模型请求体里的工具表 */
    toolTable:
      relay === null
        ? { captured: false, note: '--relay=false：没抓请求体，判据 ③ 只能读条目流' }
        : {
            captured: true,
            requestCount: relay.captured.length,
            firstRequestToolNames: relay.captured[0]?.toolNames ?? null,
            everHasRequestUserInput: relay.captured.some((one) => one.hasRequestUserInput),
            everHasUpdatePlan: relay.captured.some((one) => one.toolNames.includes('update_plan')),
            /** 模型看到的系统提示：长度 + 提没提 `request_user_input`（各臂之间应当逐格对比） */
            instructionsChars: relay.captured[0]?.instructionsChars ?? null,
            instructionsHasAskUser: relay.captured[0]?.instructionsHasAskUser ?? null,
          },
    itemSummary: items.map((one) => ({
      threadId: one.threadId,
      type: one.item?.type ?? null,
      name: one.item?.name ?? one.item?.tool ?? null,
      status: one.item?.status ?? null,
      error: one.item?.error?.message ?? one.item?.error ?? null,
    })),
    turnStatus: turnSettled?.status ?? null,
    turnError: turnSettled?.error ?? null,
    /** 判据 ④：回空答案之后到底有没有继续干活 */
    continued: {
      turnStatus: turnSettled?.status ?? null,
      resultFileExists: resultFile !== null,
      resultFileHead: resultFile,
      finalText,
    },
    /** 时间线：只留判定要看的四类（全文在 `<臂>.jsonl`） */
    timeline: notifications
      .filter((one) => /serverRequest|turn\/completed|item\/completed|error/.test(one.method))
      .map((one) => ({ atMs: one.atMs, method: one.method, threadId: one.params?.threadId ?? null })),
    jsonlFile,
  };
}

// ── 主流程 ────────────────────────────────────────────────────────────────────
const summary = {
  at: new Date().toISOString(),
  probe: 'codex-ask-user-stdin',
  codexBinary: BINARY,
  model: MODEL,
  baseUrl: BASE_URL,
  relay: USE_RELAY,
  answerPolicy: ANSWER,
  python3: pythonOk,
  ptyBridge: ptyCheck,
  arms: [],
};

console.log(`[v11] codex=${BINARY}`);
console.log(`[v11] model=${MODEL} 网关=${BASE_URL} relay=${USE_RELAY ? '开（抓请求体）' : '关'} python3=${pythonOk ? '有' : '无'}`);
if (!ptyCheck.ok) console.log(`[v11] pty 臂不可用：${ptyCheck.reason}`);

for (const name of wanted) {
  console.log(`\n[v11] ── 臂 ${name}：${ARMS[name].note}`);
  const row = await runArm(name);
  summary.arms.push(row);
  if (row.skipped !== undefined) {
    console.log(`[v11]    ⏭ 跳过：${row.skipped}`);
    continue;
  }
  const table = row.toolTable;
  console.log(
    `[v11]    工具表：${
      table.captured === false
        ? '未抓（--relay=false）'
        : `请求 ${table.requestCount} 次，request_user_input ${table.everHasRequestUserInput ? '**在**表里' : '不在表里'}`
    }`,
  );
  console.log(`[v11]    提问请求：${row.askRequestCount} 条；回帧：${row.replies.length} 条（策略 ${row.answerPolicy}）`);
  if (row.askRequestCount > 0) {
    const first = row.askRequests[0];
    console.log(`[v11]    params 原文：${JSON.stringify(first.paramsRaw).slice(0, 600)}`);
    console.log(`[v11]    问题项字段名=${JSON.stringify(first.questionFieldNames)} 选项字段名=${JSON.stringify(first.optionFieldNames)}`);
  }
  console.log(`[v11]    turn=${row.turnStatus ?? (row.timedOut ? '未收场（超时）' : '未结算')} result.txt=${row.continued.resultFileExists ? '在' : '不在'}`);
  console.log(`[v11]    最终答复：${String(row.continued.finalText ?? '(无)').slice(0, 200)}`);
  if (typeof row.error === 'string') console.log(`[v11]    ⚠ 起手失败：${row.error}`);
}

const file = join(DUMP, 'codex-ask-user-stdin.json');
writeFileSync(file, `${redact(JSON.stringify(summary, null, 2))}\n`, 'utf8');
console.log('\n[v11] 汇总：', file);
console.log('[v11] 结论请由人回填票的 ## Comments：判据见本脚本头注与同目录 README.md');
